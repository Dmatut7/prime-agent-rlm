import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import chalk from "chalk";
import { APP_NAME, getAgentDir, VERSION } from "../config.js";
import {
	isOrphanProcessIdentityCurrent,
	killOrphanProcess,
	readActiveOrphanProcesses,
	shouldReapOrphanProcess,
} from "../core/orphan-process-journal.js";
import { getProcessStartId } from "../core/session-lease.js";
import { DaemonClient } from "../modes/daemon/daemon-client.js";
import {
	DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES,
	DAEMON_PROTOCOL_VERSION,
	DAEMON_SCHEMA_ID,
	type DaemonRuntimeIdentity,
} from "../modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import { acquireDaemonShutdownAdmission } from "../modes/daemon/daemon-supervisor-ownership.js";
import type { DaemonWorkerDescriptor } from "../modes/daemon/daemon-worker-protocol.js";
import { signalProcessGroupOrProcess } from "../utils/child-process.js";
import { formatDaemonListTable } from "./daemon-ps-format.js";
import { promptYesNo } from "./daemon-stop-confirm.js";
import {
	currentShutdownScope,
	describeShutdownScope,
	MACHINE_SCOPE,
	MACHINE_STOP_SELECTION,
	matchesShutdownScope,
	resolveShutdownScope,
	type ShutdownScope,
	type StopSelection,
} from "./daemon-stop-scope.js";

/**
 * `daemon ps` discovers every prime-agent daemon on the machine, not just the
 * one on a single socket. Discovery has two sources merged by socket path:
 *
 *  1. The OS list of listening unix sockets owned by a prime-agent process
 *     (`ss -lxp` on Linux, `lsof` on macOS). Daemons set process.title to
 *     APP_NAME and carry nothing useful in argv, so the socket→pid mapping the
 *     kernel keeps is the only reliable way to find daemons on arbitrary
 *     `--daemon-socket` paths. This is the same data as `ss -lxp | grep
 *     prime-agent`, just parsed.
 *  2. A sweep of the default socket dir, which catches orphaned socket *files*
 *     left behind by daemons that are no longer running.
 *
 * Each discovered socket is then probed with the existing daemon_hello + list
 * primitives, so introspection works even against stale daemons running an
 * older build (a new protocol command would not).
 */

/**
 * `outdated` and `stale` both mean "the build answering on that socket is not
 * this build". They differ only on liveness: `outdated` still carries live
 * evidence (sessions, worker processes, cpu), so neither a human nor a plan may
 * read it as scrap. `stale` is the no-live-evidence case.
 */
export type DaemonStatus = "current" | "outdated" | "stale" | "unreachable" | "orphan-file";

export type { ShutdownScope, StopSelection };
export {
	currentShutdownScope,
	describeShutdownScope,
	MACHINE_SCOPE,
	MACHINE_STOP_SELECTION,
	matchesShutdownScope,
	resolveShutdownScope,
};

export type DaemonLiveness = "live" | "idle" | "unknown";

export interface DiscoveredDaemonProcess {
	pid: number;
	socketPath: string;
	uptimeSeconds?: number;
	cpuPercent?: number;
}

export interface DaemonInfo {
	socketPath: string;
	pid?: number;
	uptimeSeconds?: number;
	version?: string;
	protocolVersion?: number;
	schemaId?: string;
	buildId?: string;
	executablePath?: string;
	pidSource?: "listener" | "hello";
	sessionCount?: number;
	status: DaemonStatus;
	isDefault: boolean;
	hasTrackedWorkers?: boolean;
	/** Sampled process cpu percentage for `pid`, when a listener pid was found. */
	cpuPercent?: number;
	/** Tracked worker processes on this socket whose identity is verified alive. */
	liveWorkerCount?: number;
	/** Liveness verdict derived from sessions, worker processes and cpu activity. */
	liveness?: DaemonLiveness;
	/** What `liveness` is based on, in the words shown to the user. */
	livenessEvidence?: string[];
}

const STATUS_ORDER: Record<DaemonStatus, number> = {
	current: 0,
	outdated: 1,
	stale: 2,
	unreachable: 3,
	"orphan-file": 4,
};
const SHUTDOWN_QUIET_PERIOD_MS = 1000;
const SHUTDOWN_CONVERGENCE_TIMEOUT_MS = 10_000;

export function evaluateShutdownQuietPeriod(now: number, quietSince: number | undefined): "complete" | "waiting" {
	if (quietSince !== undefined && now - quietSince >= SHUTDOWN_QUIET_PERIOD_MS) {
		return "complete";
	}
	return "waiting";
}

// Linux comm names (and thus the process name ss reports) are capped at 15 chars.
const MAX_COMM_LENGTH = 15;

function processNameMatches(name: string, appName: string): boolean {
	return name === appName || appName.slice(0, MAX_COMM_LENGTH) === name;
}

/** Parse `ss -lxp` output into the prime-agent daemons listening on unix sockets. */
export function parseSsListeners(stdout: string, appName: string): DiscoveredDaemonProcess[] {
	const daemons: DiscoveredDaemonProcess[] = [];
	for (const line of stdout.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[1] !== "LISTEN") {
			continue;
		}
		const socketPath = fields[4];
		if (!socketPath?.startsWith("/")) {
			continue;
		}
		const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
		if (!owner || !processNameMatches(owner[1]!, appName)) {
			continue;
		}
		daemons.push({ pid: Number.parseInt(owner[2]!, 10), socketPath: normalizeSocketPath(socketPath) });
	}
	return daemons;
}

/** Parse `lsof -nP -F pn -U -a -c <app>` output into listening unix socket owners (macOS fallback). */
export function parseLsofListeners(stdout: string): DiscoveredDaemonProcess[] {
	const daemons: DiscoveredDaemonProcess[] = [];
	const seen = new Set<string>();
	let pid: number | undefined;
	for (const line of stdout.split("\n")) {
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			pid = Number.parseInt(value, 10);
		} else if (field === "n" && pid !== undefined && value.startsWith("/")) {
			const socketPath = normalizeSocketPath(value);
			const key = `${pid}:${socketPath}`;
			if (!seen.has(key)) {
				seen.add(key);
				daemons.push({ pid, socketPath });
			}
		}
	}
	return daemons;
}

export function parsePrimeAgentProcessIds(stdout: string, appName: string): number[] {
	const pids: number[] = [];
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\S+)(?:\s+(.*))?$/);
		if (!match) {
			continue;
		}
		const command = basename(match[2]!);
		const argv0 = basename(match[3]?.trim().split(/\s+/, 1)[0] ?? "");
		if (processNameMatches(command, appName) || processNameMatches(argv0, appName)) {
			pids.push(Number.parseInt(match[1]!, 10));
		}
	}
	return pids;
}

export function mergeDiscoveredDaemonProcesses(
	...groups: readonly DiscoveredDaemonProcess[][]
): DiscoveredDaemonProcess[] {
	const byIdentity = new Map<string, DiscoveredDaemonProcess>();
	for (const group of groups) {
		for (const daemon of group) {
			byIdentity.set(`${daemon.pid}:${daemon.socketPath}`, daemon);
		}
	}
	return [...byIdentity.values()];
}

/**
 * Parse `ps -o pid=,etime=,pcpu=` into a pid → { uptimeSeconds, cpuPercent }
 * map. A line with only the two first columns still yields an uptime with no
 * cpu sample, so a platform that refuses `pcpu` degrades to "no cpu evidence"
 * instead of losing the process row.
 */
export function parsePsProcessStats(stdout: string): Map<number, { uptimeSeconds: number; cpuPercent?: number }> {
	const stats = new Map<number, { uptimeSeconds: number; cpuPercent?: number }>();
	for (const line of stdout.split("\n")) {
		const match = line.trim().match(/^(\d+)\s+(\S+)(?:\s+([0-9.]+))?$/);
		if (!match) {
			continue;
		}
		const uptimeSeconds = parsePsElapsedTime(match[2]!);
		if (uptimeSeconds === undefined) {
			continue;
		}
		const cpuPercent = match[3] === undefined ? undefined : Number.parseFloat(match[3]);
		stats.set(Number.parseInt(match[1]!, 10), {
			uptimeSeconds,
			...(Number.isFinite(cpuPercent) ? { cpuPercent } : {}),
		});
	}
	return stats;
}

/**
 * The elapsed-clock format both `ps` families print: `12-22:53:25`
 * (days-hours-minutes-seconds), `07:37:18`, `04:21`, and the bare
 * seconds form a BSD `ps` uses for a process younger than a minute.
 */
export function parsePsElapsedTime(value: string): number | undefined {
	const [daysPart, clockPart] = value.includes("-") ? value.split("-", 2) : [undefined, value];
	const components = (clockPart ?? "").split(":").map((part) => Number.parseInt(part, 10));
	if (components.some((component) => !Number.isFinite(component)) || components.length === 0) {
		return undefined;
	}
	let seconds = 0;
	for (const component of components) {
		seconds = seconds * 60 + component;
	}
	if (daysPart !== undefined) {
		const days = Number.parseInt(daysPart, 10);
		if (!Number.isFinite(days)) {
			return undefined;
		}
		seconds += days * 86400;
	}
	return seconds;
}

function scanListeningDaemons(): DiscoveredDaemonProcess[] {
	if (process.platform === "win32") {
		return [];
	}
	const ss = spawnSync("ss", ["-lxp"], { encoding: "utf8" });
	if (!ss.error && ss.status === 0 && typeof ss.stdout === "string") {
		return enrichUptimes(parseSsListeners(ss.stdout, APP_NAME));
	}
	const lsof = spawnSync("lsof", ["-nP", "-F", "pn", "-U", "-a", "-c", APP_NAME], { encoding: "utf8" });
	const byName = !lsof.error && typeof lsof.stdout === "string" ? parseLsofListeners(lsof.stdout) : [];
	let byPid: DiscoveredDaemonProcess[] = [];
	const ps = spawnSync("ps", ["-axo", "pid=,comm=,args="], { encoding: "utf8" });
	if (!ps.error && ps.status === 0 && typeof ps.stdout === "string") {
		const pids = parsePrimeAgentProcessIds(ps.stdout, APP_NAME);
		if (pids.length > 0) {
			const lsofByPid = spawnSync("lsof", ["-nP", "-F", "pn", "-U", "-a", "-p", pids.join(",")], {
				encoding: "utf8",
			});
			if (!lsofByPid.error && typeof lsofByPid.stdout === "string") {
				byPid = parseLsofListeners(lsofByPid.stdout);
			}
		}
	}
	return enrichUptimes(mergeDiscoveredDaemonProcesses(byName, byPid));
}

/**
 * The raw listener scan is machine-wide by construction, so every stop path
 * that signals a listener has to route through the requested scope first.
 * Without this a scoped `--force` would still reap services it never named.
 */
function scopingListeningDaemons(selection: StopSelection): DiscoveredDaemonProcess[] {
	return scanListeningDaemons().filter(
		(listener) =>
			!isWorkerSocketPath(listener.socketPath) && matchesShutdownScope(listener.socketPath, selection.scope),
	);
}

function isDaemonProcessListening(pid: number, socketPath: string): boolean {
	const target = normalizeSocketPath(socketPath);
	return scanListeningDaemons().some((daemon) => daemon.pid === pid && daemon.socketPath === target);
}

function enrichUptimes(daemons: DiscoveredDaemonProcess[]): DiscoveredDaemonProcess[] {
	const stats = sampleProcessStats(daemons.map((daemon) => daemon.pid));
	return daemons.map((daemon) => {
		const entry = stats.get(daemon.pid);
		if (!entry) {
			return daemon;
		}
		return {
			...daemon,
			uptimeSeconds: entry.uptimeSeconds,
			...(entry.cpuPercent !== undefined ? { cpuPercent: entry.cpuPercent } : {}),
		};
	});
}

/**
 * One `ps` for the whole set, then one per pid that the batch refused to
 * answer. The batch call exits non-zero and prints nothing as soon as any one
 * pid has vanished between the socket scan and here, which used to silently
 * drop the uptime *and* the cpu sample of every other service — and cpu is now
 * liveness evidence, so "no sample" must not be a listing artifact.
 */
function sampleProcessStats(pids: readonly number[]): Map<number, { uptimeSeconds: number; cpuPercent?: number }> {
	const unique = [...new Set(pids)];
	if (unique.length === 0) {
		return new Map();
	}
	const stats = parsePsProcessStats(runProcessList(["-o", "pid=,etime=,pcpu=", "-p", unique.join(",")]));
	for (const pid of unique) {
		if (stats.has(pid) || !isProcessAlive(pid)) {
			continue;
		}
		const single = parsePsProcessStats(runProcessList(["-o", "pid=,etime=,pcpu=", "-p", String(pid)]));
		const entry = single.get(pid);
		if (entry) {
			stats.set(pid, entry);
		}
	}
	return stats;
}

function runProcessList(args: string[]): string {
	const result = spawnSync("ps", args, { encoding: "utf8" });
	return typeof result.stdout === "string" && !result.error ? result.stdout : "";
}

/** Socket files in the default socket dir (may be live daemons or orphaned files). */
function scanSocketDir(): string[] {
	if (process.platform === "win32") {
		return [];
	}
	const dir = defaultDaemonSocketDir();
	if (!existsSync(dir)) {
		return [];
	}
	const sockets: string[] = [];
	for (const entry of readdirSync(dir)) {
		const socketPath = join(dir, entry);
		try {
			if (lstatSync(socketPath).isSocket()) {
				sockets.push(normalizeSocketPath(socketPath));
			}
		} catch {
			// Entry vanished between readdir and lstat; ignore.
		}
	}
	return sockets;
}

interface ProbeResult {
	version?: string;
	protocolVersion?: number;
	schemaId?: string;
	runtime?: DaemonRuntimeIdentity;
	sessionCount?: number;
	supervisorPid?: number;
	supervisorProcessStartId?: string;
	reachable: boolean;
	/** The daemon answered hello or the list request; a bare connect is not an answer. */
	answeredProbe: boolean;
}

async function probeDaemon(socketPath: string): Promise<ProbeResult> {
	const client = new DaemonClient(socketPath, { declaredCapabilities: DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES });
	try {
		await client.connect(300);
	} catch {
		client.close();
		return { reachable: false, answeredProbe: false };
	}
	try {
		let version: string | undefined;
		let protocolVersion: number | undefined;
		let schemaId: string | undefined;
		let runtime: DaemonRuntimeIdentity | undefined;
		let supervisorPid: number | undefined;
		let supervisorProcessStartId: string | undefined;
		let greeted = false;
		try {
			const hello = await client.waitForHello(1500);
			version = hello.appVersion;
			protocolVersion = hello.protocol.version;
			schemaId = hello.schemaId;
			runtime = hello.runtime;
			supervisorPid = hello.supervisorPid;
			supervisorProcessStartId = hello.supervisorProcessStartId;
			greeted = true;
		} catch {
			// Connected but no recognizable greeting: an old/foreign daemon.
		}
		let sessionCount: number | undefined;
		try {
			const response = await client.request({ type: "list" }, greeted ? 30000 : 1500);
			if (response.success) {
				const sessions = (response.data as { sessions?: unknown })?.sessions;
				if (Array.isArray(sessions)) {
					sessionCount = sessions.length;
				}
			}
		} catch {
			// Leave sessionCount undefined when the daemon will not answer list.
		}
		return {
			version,
			protocolVersion,
			schemaId,
			runtime,
			sessionCount,
			supervisorPid,
			supervisorProcessStartId,
			reachable: true,
			answeredProbe: greeted || sessionCount !== undefined,
		};
	} finally {
		client.close();
	}
}

/**
 * Decide the status of a socket that accepted a connection.
 *
 * `stale` used to mean "answers, but not with this build", which read as
 * "scrap" even for a supervisor running 119 live sessions at 7.6% cpu. The two
 * axes are now separate: `liveness` says whether anything is running there,
 * `status` says whether the answering build is this build. A daemon that
 * answers the standardized primitives on a different build is `outdated`;
 * `stale` is reserved for a socket that is not answering as any known build.
 */
export function classifyReachable(probe: ReachableProbeEvidence, liveness: DaemonLiveness): DaemonStatus {
	if (
		probe.protocolVersion === DAEMON_PROTOCOL_VERSION &&
		probe.schemaId === DAEMON_SCHEMA_ID &&
		probe.version === VERSION
	) {
		return "current";
	}
	return liveness === "unknown" ? "stale" : "outdated";
}

interface ReachableProbeEvidence {
	protocolVersion?: number;
	schemaId?: string;
	version?: string;
}

/**
 * Liveness criteria, in the order the evidence is collected:
 *
 *  - `live`   the daemon reported sessions, or owns worker processes whose pid
 *             identity verifies, or its listener pid shows sampled cpu time.
 *  - `idle`   the socket answered the standardized probe but nothing is running
 *             on it: no sessions, no live workers, no cpu.
 *  - `unknown` the connection was accepted and nothing was answered. Only this
 *             case may be called `stale`.
 */
export function evaluateDaemonLiveness(evidence: {
	sessionCount?: number;
	liveWorkerCount?: number;
	cpuPercent?: number;
	answeredProbe: boolean;
}): { liveness: DaemonLiveness; evidence: string[] } {
	const reasons: string[] = [];
	if ((evidence.sessionCount ?? 0) > 0) {
		reasons.push(`${evidence.sessionCount} session(s)`);
	}
	if ((evidence.liveWorkerCount ?? 0) > 0) {
		reasons.push(`${evidence.liveWorkerCount} worker process(es)`);
	}
	if ((evidence.cpuPercent ?? 0) > 0) {
		reasons.push(`cpu ${evidence.cpuPercent}%`);
	}
	if (reasons.length > 0) {
		return { liveness: "live", evidence: reasons };
	}
	if (!evidence.answeredProbe) {
		return { liveness: "unknown", evidence: [] };
	}
	return { liveness: "idle", evidence: ["answered probe with no work"] };
}

export function verifyHelloSupervisorPid(
	pid: number | undefined,
	expectedProcessStartId: string | undefined,
): number | undefined {
	if (!Number.isInteger(pid) || pid === undefined || pid <= 0) {
		return undefined;
	}
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") {
			return undefined;
		}
	}
	if (expectedProcessStartId) {
		const observedStartId = getProcessStartId(pid);
		if (observedStartId !== expectedProcessStartId) {
			return undefined;
		}
	}
	return pid;
}

/** Discover every daemon on the machine and probe each for version + session count. */
export async function discoverDaemons(): Promise<DaemonInfo[]> {
	const processBySocket = new Map<string, DiscoveredDaemonProcess>();
	for (const daemon of scanListeningDaemons()) {
		if (isWorkerSocketPath(daemon.socketPath)) {
			continue;
		}
		processBySocket.set(daemon.socketPath, daemon);
	}

	const trackedWorkers = findAllTrackedWorkers();
	const workerSockets = new Set(
		trackedWorkers.map((worker) => normalizeSocketPath(worker.descriptor.supervisorSocketPath)),
	);
	// A descriptor names the worker socket it owns, whatever directory that
	// socket ended up in, so it is authoritative over any name heuristic.
	const workerOwnedSockets = new Set(
		trackedWorkers.map((worker) => normalizeSocketPath(worker.descriptor.socketPath)),
	);
	const liveWorkersBySupervisor = countLiveTrackedWorkers(trackedWorkers.map((worker) => worker.descriptor));
	const isDaemonSocket = (socketPath: string): boolean =>
		!isWorkerSocketPath(socketPath) && !workerOwnedSockets.has(normalizeSocketPath(socketPath));
	const sockets = new Set<string>([
		...[...processBySocket.keys()].filter(isDaemonSocket),
		...scanSocketDir().filter(isDaemonSocket),
		...workerSockets,
	]);
	const defaultSocket = normalizeSocketPath(defaultDaemonSocketPath());

	const infos = await Promise.all(
		[...sockets].map(async (socketPath): Promise<DaemonInfo> => {
			const proc = processBySocket.get(socketPath);
			const probe = await probeDaemon(socketPath);
			const pid = proc?.pid ?? verifyHelloSupervisorPid(probe.supervisorPid, probe.supervisorProcessStartId);
			const hasTrackedWorkers = workerSockets.has(socketPath);
			const liveWorkerCount = liveWorkersBySupervisor.get(socketPath) ?? 0;
			const liveness = evaluateDaemonLiveness({
				sessionCount: probe.sessionCount,
				liveWorkerCount,
				cpuPercent: proc?.cpuPercent,
				answeredProbe: probe.answeredProbe || liveWorkerCount > 0,
			});
			const status: DaemonStatus = probe.reachable
				? classifyReachable(probe, liveness.liveness)
				: proc || hasTrackedWorkers
					? "unreachable"
					: "orphan-file";
			return {
				socketPath,
				pid,
				uptimeSeconds: proc?.uptimeSeconds,
				version: probe.version,
				protocolVersion: probe.protocolVersion,
				schemaId: probe.schemaId,
				buildId: probe.runtime?.buildId,
				executablePath:
					probe.runtime?.launcherPath ?? probe.runtime?.entrypointPath ?? probe.runtime?.executablePath,
				...(pid !== undefined ? { pidSource: proc ? ("listener" as const) : ("hello" as const) } : {}),
				sessionCount: probe.sessionCount,
				status,
				isDefault: socketPath === defaultSocket,
				...(hasTrackedWorkers ? { hasTrackedWorkers: true } : {}),
				...(proc?.cpuPercent !== undefined ? { cpuPercent: proc.cpuPercent } : {}),
				...(hasTrackedWorkers ? { liveWorkerCount } : {}),
				liveness: liveness.liveness,
				...(liveness.evidence.length > 0 ? { livenessEvidence: liveness.evidence } : {}),
			};
		}),
	);

	return sortDaemons(infos);
}

export function sortDaemons(infos: DaemonInfo[]): DaemonInfo[] {
	return [...infos].sort((left, right) => {
		if (left.isDefault !== right.isDefault) {
			return left.isDefault ? -1 : 1;
		}
		const statusDelta = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
		return statusDelta || left.socketPath.localeCompare(right.socketPath);
	});
}

export async function runPs(json: boolean, selection?: StopSelection): Promise<void> {
	const daemons = await discoverDaemons();
	if (json) {
		console.log(JSON.stringify(daemons, null, 2));
		return;
	}
	if (daemons.length === 0) {
		console.log("No background services found.");
		return;
	}
	console.log(formatDaemonListTable(daemons));
	// `status` is machine-wide, but the stop commands are not. Say which rows a
	// plain `prime-agent shutdown` would actually touch, so the two views of the
	// machine cannot disagree about what is next on the destroy list.
	const effective = selection ?? { scope: currentShutdownScope(), orphansOnly: false };
	const { selected } = selectStoppableDaemons(daemons, effective);
	console.log(
		chalk.dim(
			`\nstop scope: ${describeShutdownScope(effective.scope)} — ${selected.length} of ${daemons.length} service(s); use --all for whole-machine`,
		),
	);
	const live = daemons.filter((daemon) => daemon.liveness === "live");
	if (live.length > 0) {
		console.log(chalk.dim(`live services: ${live.map((daemon) => daemon.socketPath).join(", ")}`));
	}
}

export type ReapAction =
	| { kind: "remove-file"; daemon: DaemonInfo }
	| { kind: "kill"; daemon: DaemonInfo }
	| { kind: "shutdown"; daemon: DaemonInfo }
	| { kind: "skip"; daemon: DaemonInfo; reason: string };

/** Live evidence in the sense used by the liveness criteria above. */
export function hasLiveWork(daemon: DaemonInfo): boolean {
	return (
		daemon.liveness === "live" ||
		(daemon.sessionCount ?? 0) > 0 ||
		(daemon.liveWorkerCount ?? 0) > 0 ||
		(daemon.cpuPercent ?? 0) > 0
	);
}

/** Why a discovered daemon must be left alone by this selection, or undefined. */
export function selectionExclusionReason(daemon: DaemonInfo, selection: StopSelection): string | undefined {
	if (!matchesShutdownScope(daemon.socketPath, selection.scope)) {
		const listenedIn = dirname(resolve(normalizeSocketPath(daemon.socketPath)));
		return `outside the shutdown scope (${describeShutdownScope(selection.scope)}; this service listens in ${listenedIn})`;
	}
	if (selection.orphansOnly && hasLiveWork(daemon)) {
		return `has live work (${daemon.livenessEvidence?.join(", ") ?? `${daemon.sessionCount ?? "unknown"} session(s)`})`;
	}
	return undefined;
}

/** Name one discovered service for a confirmation prompt: path, pid, live sessions. */
export function describeShutdownTarget(daemon: DaemonInfo): string {
	const sessions =
		daemon.sessionCount === undefined
			? "sessions unknown"
			: `${daemon.sessionCount} live session(s)${daemon.sessionCount > 0 ? " [ACTIVE WORK]" : ""}`;
	const pid = daemon.pid === undefined ? "pid unknown" : `pid ${daemon.pid}`;
	const flags = [
		daemon.isDefault ? "default service" : undefined,
		daemon.status === "outdated" ? `built ${daemon.version ?? "unknown"} (not this build)` : undefined,
		daemon.status === "stale" ? "not answering as any known build" : undefined,
		daemon.status === "unreachable" ? "not answering" : undefined,
		(daemon.liveWorkerCount ?? 0) > 0 ? `${daemon.liveWorkerCount} worker process(es)` : undefined,
	].filter((flag): flag is string => flag !== undefined);
	return [daemon.socketPath, pid, sessions, ...flags].join("  ");
}

/**
 * Decide what to do with each discovered daemon (pure, no side effects). Reap
 * targets only clearly-safe daemons: orphaned socket files (including a stale
 * default daemon.sock with no live process), and reachable idle daemons on
 * non-default sockets. A reachable default daemon, and any reachable daemon with
 * live sessions, are never touched.
 *
 * Unreachable (hung) daemons can't report a session count, so they are only
 * ever killed with `force`, and even then never via a pid that backs more than
 * one discovered daemon (e.g. macOS lsof reports every unix socket a process
 * holds, so killing a shared pid could take down a reachable daemon with live
 * sessions). runReap additionally re-probes a kill candidate immediately before
 * the SIGTERM and backs off to the session-aware paths if it has since become
 * reachable, so a daemon that recovered with live sessions is never killed.
 */
export function planReap(
	daemons: readonly DaemonInfo[],
	force: boolean,
	selection: StopSelection = MACHINE_STOP_SELECTION,
): ReapAction[] {
	const pidCounts = new Map<number, number>();
	for (const daemon of daemons) {
		if (daemon.pid !== undefined) {
			pidCounts.set(daemon.pid, (pidCounts.get(daemon.pid) ?? 0) + 1);
		}
	}

	return daemons.map((daemon): ReapAction => {
		const excluded = selectionExclusionReason(daemon, selection);
		if (excluded) {
			return { kind: "skip", daemon, reason: excluded };
		}
		// An orphan socket file has no owning process, so removing it is safe even
		// on the default path (a stale daemon.sock left by a crash). Decide this
		// before the default guard so a dead default socket still gets cleaned up.
		if (daemon.status === "orphan-file") {
			return { kind: "remove-file", daemon };
		}
		if (daemon.isDefault) {
			return { kind: "skip", daemon, reason: "default background service" };
		}
		if (daemon.status === "unreachable") {
			if (!force || daemon.pid === undefined) {
				return { kind: "skip", daemon, reason: 'unreachable; use "prime-agent shutdown --force" to stop it' };
			}
			if ((daemon.liveWorkerCount ?? 0) > 0) {
				return {
					kind: "skip",
					daemon,
					reason: `unreachable; ${daemon.liveWorkerCount} worker process(es) still live, not killing`,
				};
			}
			if ((pidCounts.get(daemon.pid) ?? 0) > 1) {
				return {
					kind: "skip",
					daemon,
					reason: `unreachable; pid ${daemon.pid} also backs another daemon, not killing`,
				};
			}
			return { kind: "kill", daemon };
		}
		if (daemon.sessionCount !== 0) {
			return { kind: "skip", daemon, reason: `has ${daemon.sessionCount ?? "unknown"} session(s)` };
		}
		if ((daemon.liveWorkerCount ?? 0) > 0) {
			return { kind: "skip", daemon, reason: `has ${daemon.liveWorkerCount} live worker process(es)` };
		}
		return { kind: "shutdown", daemon };
	});
}

export function planShutdownAll(
	daemons: readonly DaemonInfo[],
	force: boolean,
	selection: StopSelection = MACHINE_STOP_SELECTION,
): ReapAction[] {
	return daemons.map((daemon): ReapAction => {
		const excluded = selectionExclusionReason(daemon, selection);
		if (excluded) {
			return { kind: "skip", daemon, reason: excluded };
		}
		if (daemon.status === "orphan-file") {
			return { kind: "remove-file", daemon };
		}
		if (daemon.status === "unreachable") {
			if (daemon.pid === undefined) {
				return force || !daemon.hasTrackedWorkers
					? { kind: "remove-file", daemon }
					: { kind: "skip", daemon, reason: "has unreachable workers; use --force to kill" };
			}
			return force ? { kind: "kill", daemon } : { kind: "skip", daemon, reason: "unreachable; use --force to kill" };
		}
		return { kind: "shutdown", daemon };
	});
}

const SHUTDOWN_ALL_ACTION_ORDER: Record<ReapAction["kind"], number> = {
	shutdown: 0,
	"remove-file": 1,
	kill: 2,
	skip: 3,
};

export type ShutdownConfirmationPlan = "none" | "prompt" | "json-error" | "tty-error";

export function planShutdownConfirmation(
	daemonCount: number,
	json: boolean,
	force: boolean,
	stdinIsTTY: boolean | undefined,
): ShutdownConfirmationPlan {
	if (daemonCount === 0 || force) return "none";
	if (json) return "json-error";
	return stdinIsTTY ? "prompt" : "tty-error";
}

/** Partition a discovery result by what one stop selection may touch. */
export function selectStoppableDaemons(
	daemons: readonly DaemonInfo[],
	selection: StopSelection,
): { selected: DaemonInfo[]; excluded: DaemonInfo[] } {
	const selected: DaemonInfo[] = [];
	const excluded: DaemonInfo[] = [];
	for (const daemon of daemons) {
		if (selectionExclusionReason(daemon, selection) === undefined) {
			selected.push(daemon);
		} else {
			excluded.push(daemon);
		}
	}
	return { selected, excluded };
}

function totalLiveSessions(daemons: readonly DaemonInfo[]): number {
	return daemons.reduce((total, daemon) => total + (daemon.sessionCount ?? 0), 0);
}

/**
 * The named pre-stop report: every service this command intends to destroy,
 * one line each, plus the ones it deliberately leaves alone. Both `shutdown`
 * and `shutdown --force` print it, because a confirmation that does not name
 * what it is about to kill is not a confirmation.
 */
export function formatShutdownReport(
	selection: StopSelection,
	selected: readonly DaemonInfo[],
	excluded: readonly DaemonInfo[],
): string {
	const lines = [
		`${selection.scope.kind === "machine" ? "WHOLE-MACHINE scope" : "Scoped"}: ${describeShutdownScope(selection.scope)}`,
		`${selected.length} of ${selected.length + excluded.length} discovered service(s) will be stopped (${totalLiveSessions(selected)} live session(s) on them).`,
	];
	for (const daemon of selected) {
		lines.push(`  stop  ${describeShutdownTarget(daemon)}`);
	}
	for (const daemon of excluded) {
		lines.push(`  keep  ${describeShutdownTarget(daemon)}  (${selectionExclusionReason(daemon, selection)})`);
	}
	return lines.join("\n");
}

export function formatShutdownQuestion(selection: StopSelection, selected: readonly DaemonInfo[]): string {
	const sessions = totalLiveSessions(selected);
	const work = sessions > 0 ? ` ${sessions} live session(s) will be interrupted.` : " No live sessions are attached.";
	if (selection.scope.kind === "machine") {
		return `Stop every agent and background service on this machine (${selected.length} service(s))?${work}`;
	}
	return `Stop ${describeShutdownScope(selection.scope)} (${selected.length} service(s))?${work}`;
}

/** Services a selection must never signal, by pid, so the force sweeps cannot reach them. */
export function protectedShutdownPids(daemons: readonly DaemonInfo[], selection: StopSelection): Set<number> {
	const pids = new Set<number>();
	for (const daemon of daemons) {
		if (daemon.pid !== undefined && selectionExclusionReason(daemon, selection) !== undefined) {
			pids.add(daemon.pid);
		}
	}
	return pids;
}

export async function runShutdownSelection(
	json: boolean,
	force: boolean,
	selection: StopSelection = { scope: currentShutdownScope(), orphansOnly: false },
	dryRun = false,
): Promise<void> {
	const discovered = (await discoverDaemons()).filter((daemon) => !isWorkerSocketPath(daemon.socketPath));
	const { selected, excluded } = selectStoppableDaemons(discovered, selection);
	const report = formatShutdownReport(selection, selected, excluded);
	if (dryRun) {
		if (json) {
			console.log(
				JSON.stringify({ dryRun: true, scope: selection.scope, targets: selected, leftRunning: excluded }, null, 2),
			);
		} else {
			console.log(`${report}\nDry run: nothing was stopped.`);
		}
		return;
	}
	switch (planShutdownConfirmation(selected.length, json, force, process.stdin.isTTY)) {
		case "json-error":
			process.exitCode = 1;
			console.log(
				JSON.stringify(
					{
						scope: selection.scope,
						stopped: [],
						failed: selected.map(({ socketPath }) => ({
							socketPath,
							reason: 'confirmation required; use "prime-agent shutdown --force --json"',
						})),
						leftRunning: excluded.map(({ socketPath }) => ({
							socketPath,
							reason: `outside the requested scope; use --all to include it`,
						})),
					},
					null,
					2,
				),
			);
			return;
		case "tty-error":
			throw new Error(
				`Shutdown requires confirmation in an interactive terminal. Use "prime-agent shutdown --force". Requested scope: ${describeShutdownScope(selection.scope)}.`,
			);
		case "prompt": {
			const confirmed = await promptYesNo(`${report}\n${formatShutdownQuestion(selection, selected)}`);
			if (!confirmed) {
				console.log(chalk.dim("Shutdown cancelled."));
				return;
			}
			break;
		}
		case "none":
			// --force skips the question, not the names: whoever forced it must
			// still be able to see which instances are about to go.
			if (!json && selected.length > 0) {
				console.log(report);
			}
			break;
	}
	if (selected.length === 0) {
		// planShutdownConfirmation() skips the question for an empty scope, so this
		// is the only place that tells the user why nothing was stopped.
		if (json) {
			console.log(
				JSON.stringify({ scope: selection.scope, stopped: [], failed: [], leftRunning: excluded }, null, 2),
			);
			return;
		}
		console.log(report);
		console.log(chalk.dim("Nothing to stop in this scope."));
		return;
	}
	const admission = await acquireDaemonShutdownAdmission();
	try {
		await runShutdownConverging(json, force, () => admission.assertOrRenew(), selection);
	} finally {
		await admission.release();
	}
}

async function runShutdownConverging(
	json: boolean,
	force: boolean,
	assertAdmission: () => Promise<void>,
	selection: StopSelection,
): Promise<void> {
	const stopped: Array<{ socketPath: string; action: string }> = [];
	const failed: Array<{ socketPath: string; reason: string }> = [];
	const handledPids = new Set<number>();
	const reportedFailures = new Set<string>();

	const daemons = (await discoverDaemons()).filter((daemon) => !isWorkerSocketPath(daemon.socketPath));
	const { selected, excluded } = selectStoppableDaemons(daemons, selection);
	const protectedPids = protectedShutdownPids(daemons, selection);

	if (force) {
		await stopHiddenSupervisors(
			stopped,
			failed,
			handledPids,
			reportedFailures,
			assertAdmission,
			selection,
			protectedPids,
		);
	}

	const actions = [...planShutdownAll(selected, force, selection)].sort(
		(left, right) => SHUTDOWN_ALL_ACTION_ORDER[left.kind] - SHUTDOWN_ALL_ACTION_ORDER[right.kind],
	);

	for (const action of actions) {
		const { socketPath, pid } = action.daemon;
		if (pid !== undefined && handledPids.has(pid)) {
			await assertAdmission();
			removeSocketFile(socketPath);
			stopped.push({ socketPath, action: `background service already stopped (pid ${pid})` });
			if (force) {
				failed.push(
					...(await forceStopTrackedWorkers(socketPath, assertAdmission)).map((reason) => ({
						socketPath,
						reason,
					})),
				);
			}
			continue;
		}
		switch (action.kind) {
			case "remove-file": {
				if ((await probeDaemon(socketPath)).reachable) {
					apply(
						await stopBackgroundService(socketPath, pid, handledPids, force, assertAdmission),
						socketPath,
						stopped,
						failed,
					);
				} else {
					await assertAdmission();
					if (removeSocketFile(socketPath)) {
						stopped.push({ socketPath, action: "removed stale socket file" });
					} else {
						failed.push({ socketPath, reason: "could not remove socket file" });
					}
				}
				break;
			}
			case "kill": {
				if ((await probeDaemon(socketPath)).reachable) {
					apply(
						await stopBackgroundService(socketPath, pid, handledPids, force, assertAdmission),
						socketPath,
						stopped,
						failed,
					);
				} else if (isDaemonProcessListening(pid!, socketPath)) {
					await assertAdmission();
					await forceKillDaemon(pid!);
					handledPids.add(pid!);
					await assertAdmission();
					removeSocketFile(socketPath);
					stopped.push({ socketPath, action: `killed unreachable background service (pid ${pid})` });
				} else {
					await assertAdmission();
					removeSocketFile(socketPath);
					stopped.push({ socketPath, action: "background service already stopped" });
				}
				break;
			}
			case "shutdown":
				apply(
					await stopBackgroundService(socketPath, pid, handledPids, force, assertAdmission),
					socketPath,
					stopped,
					failed,
				);
				break;
			case "skip":
				failed.push({ socketPath, reason: action.reason });
				break;
		}
		if (force && action.kind !== "skip") {
			failed.push(
				...(await forceStopTrackedWorkers(socketPath, assertAdmission)).map((reason) => ({ socketPath, reason })),
			);
		}
	}

	if (force) {
		await terminateVerifiedResiduals(
			stopped,
			failed,
			handledPids,
			reportedFailures,
			assertAdmission,
			selection,
			protectedPids,
		);
	}

	if (json) {
		if (failed.length > 0) {
			process.exitCode = 1;
		}
		console.log(
			JSON.stringify(
				{
					scope: selection.scope,
					stopped,
					failed,
					leftRunning: excluded.map((daemon) => ({
						socketPath: daemon.socketPath,
						reason: selectionExclusionReason(daemon, selection) ?? "outside the requested scope",
					})),
				},
				null,
				2,
			),
		);
		return;
	}
	for (const entry of stopped) {
		console.log(chalk.green(`stopped ${entry.socketPath}: ${entry.action}`));
	}
	for (const entry of failed) {
		console.log(chalk.red(`failed  ${entry.socketPath}: ${entry.reason}`));
	}
	for (const daemon of excluded) {
		console.log(
			chalk.dim(
				`left    ${daemon.socketPath}: ${selectionExclusionReason(daemon, selection) ?? "outside the requested scope"}`,
			),
		);
	}
	if (stopped.length === 0 && failed.length === 0 && excluded.length === 0) {
		console.log("No background services found.");
	}
	if (failed.length > 0) {
		process.exitCode = 1;
	}
}

async function stopHiddenSupervisors(
	stopped: Array<{ socketPath: string; action: string }>,
	failed: Array<{ socketPath: string; reason: string }>,
	handledPids: Set<number>,
	reportedFailures: Set<string>,
	assertAdmission: () => Promise<void>,
	selection: StopSelection,
	protectedPids: ReadonlySet<number>,
): Promise<void> {
	while (true) {
		const listeners = scopingListeningDaemons(selection).filter((listener) => !protectedPids.has(listener.pid));
		const bySocket = new Map<string, DiscoveredDaemonProcess[]>();
		for (const listener of listeners) {
			const group = bySocket.get(listener.socketPath) ?? [];
			group.push(listener);
			bySocket.set(listener.socketPath, group);
		}
		const hidden: DiscoveredDaemonProcess[] = [];
		for (const [socketPath, group] of bySocket) {
			if (new Set(group.map((listener) => listener.pid)).size < 2) {
				continue;
			}
			const currentPid = (await probeDaemon(socketPath)).supervisorPid;
			if (currentPid === undefined || !group.some((listener) => listener.pid === currentPid)) {
				recordShutdownFailure(
					failed,
					reportedFailures,
					socketPath,
					"could not identify the current same-path daemon",
				);
				continue;
			}
			hidden.push(...group.filter((listener) => listener.pid !== currentPid));
		}
		if (hidden.length === 0) {
			return;
		}
		const before = daemonListenerSignature(hidden);
		for (const listener of hidden) {
			if (await terminateVerifiedListener(listener, failed, reportedFailures, assertAdmission)) {
				handledPids.add(listener.pid);
				stopped.push({ socketPath: listener.socketPath, action: `stopped hidden daemon (pid ${listener.pid})` });
			}
		}
		const afterHidden = scopingListeningDaemons(selection).filter((listener) =>
			hidden.some((candidate) => candidate.pid === listener.pid && candidate.socketPath === listener.socketPath),
		);
		if (afterHidden.length === 0 || daemonListenerSignature(afterHidden) === before) {
			return;
		}
	}
}

async function terminateVerifiedResiduals(
	stopped: Array<{ socketPath: string; action: string }>,
	failed: Array<{ socketPath: string; reason: string }>,
	handledPids: Set<number>,
	reportedFailures: Set<string>,
	assertAdmission: () => Promise<void>,
	selection: StopSelection,
	protectedPids: ReadonlySet<number>,
): Promise<void> {
	let previousSignature: string | undefined;
	let quietSince: number | undefined;
	const deadline = Date.now() + SHUTDOWN_CONVERGENCE_TIMEOUT_MS;
	while (true) {
		await assertAdmission();
		const listeners = scopingListeningDaemons(selection).filter((listener) => !protectedPids.has(listener.pid));
		const now = Date.now();
		if (listeners.length === 0) {
			previousSignature = undefined;
			quietSince ??= now;
			const quietPeriod = evaluateShutdownQuietPeriod(now, quietSince);
			if (quietPeriod === "complete") {
				return;
			}
			await delay(100);
			continue;
		}
		quietSince = undefined;
		const signature = daemonListenerSignature(listeners);
		if (now >= deadline) {
			recordResidualListenerFailures(listeners, failed, reportedFailures, "kept respawning during shutdown");
			return;
		}
		if (signature === previousSignature) {
			recordResidualListenerFailures(listeners, failed, reportedFailures, "remained after shutdown");
			return;
		}
		previousSignature = signature;
		const seenPids = new Set<number>();
		for (const listener of listeners) {
			if (seenPids.has(listener.pid)) {
				continue;
			}
			seenPids.add(listener.pid);
			const alreadyReported = handledPids.has(listener.pid);
			if (await terminateVerifiedListener(listener, failed, reportedFailures, assertAdmission)) {
				handledPids.add(listener.pid);
				if (!alreadyReported) {
					stopped.push({
						socketPath: listener.socketPath,
						action: `stopped residual daemon process (pid ${listener.pid})`,
					});
				}
			}
		}
	}
}

function recordResidualListenerFailures(
	listeners: readonly DiscoveredDaemonProcess[],
	failed: Array<{ socketPath: string; reason: string }>,
	reportedFailures: Set<string>,
	reason: string,
): void {
	for (const listener of listeners) {
		const processStartId = getProcessStartId(listener.pid);
		const identity = processStartId
			? `pid ${listener.pid}, start ${processStartId}`
			: `pid ${listener.pid}, process identity unavailable`;
		recordShutdownFailure(
			failed,
			reportedFailures,
			listener.socketPath,
			`daemon ${reason} (${identity})${describeDaemonParent(listener.pid)}`,
		);
	}
}
function describeDaemonParent(pid: number): string {
	const result = spawnSync("ps", ["-o", "ppid=,tty=,command=", "-p", String(pid)], { encoding: "utf8" });
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
		return "";
	}
	const match = result.stdout.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
	if (!match) {
		return "";
	}
	return `; close parent PID ${match[1]} on ${match[2]} (${match[3]}) and retry shutdown`;
}

async function terminateVerifiedListener(
	listener: DiscoveredDaemonProcess,
	failed: Array<{ socketPath: string; reason: string }>,
	reportedFailures: Set<string>,
	assertAdmission: () => Promise<void>,
): Promise<boolean> {
	const processStartId = getProcessStartId(listener.pid);
	if (!processStartId) {
		recordShutdownFailure(
			failed,
			reportedFailures,
			listener.socketPath,
			`could not verify daemon process identity (pid ${listener.pid})`,
		);
		return false;
	}
	if (getProcessStartId(listener.pid) !== processStartId) {
		return false;
	}
	await assertAdmission();
	if (getProcessStartId(listener.pid) !== processStartId) {
		return false;
	}
	killDaemon(listener.pid);
	const deadline = Date.now() + 1000;
	while (getProcessStartId(listener.pid) === processStartId && Date.now() < deadline) {
		await delay(50);
	}
	if (getProcessStartId(listener.pid) === processStartId) {
		await assertAdmission();
		if (getProcessStartId(listener.pid) !== processStartId) {
			return false;
		}
		try {
			process.kill(listener.pid, "SIGKILL");
		} catch {
			// The verified process exited between the identity check and signal.
		}
	}
	return getProcessStartId(listener.pid) !== processStartId;
}

function daemonListenerSignature(listeners: readonly DiscoveredDaemonProcess[]): string {
	return listeners
		.map((listener) => `${listener.pid}:${getProcessStartId(listener.pid) ?? "unknown"}:${listener.socketPath}`)
		.sort()
		.join("\n");
}

function recordShutdownFailure(
	failed: Array<{ socketPath: string; reason: string }>,
	reportedFailures: Set<string>,
	socketPath: string,
	reason: string,
): void {
	const key = `${socketPath}\0${reason}`;
	if (reportedFailures.has(key)) {
		return;
	}
	reportedFailures.add(key);
	failed.push({ socketPath, reason });
}

/**
 * A worker socket belongs to a supervisor, never to the daemon list.
 *
 * The name shape is `worker-<12 hex of the supervisor socket>-<12 hex of the
 * worker id>.sock` and the supervisor always creates it in *its* default socket
 * dir, which is `$TMPDIR/prime-agent-<uid>`. Matching only this process's own
 * dir made every other TMPDIR's live worker show up as a daemon, where the
 * probe answered with a worker's identity and the build check called it
 * `stale`. Any `prime-agent-<uid>` dir is therefore a worker dir, whichever
 * TMPDIR it sits under.
 */
export function isWorkerSocketPath(socketPath: string): boolean {
	if (process.platform === "win32") {
		return false;
	}
	const name = basename(socketPath);
	if (!name.startsWith("worker-") || !name.endsWith(".sock")) {
		return false;
	}
	const parent = basename(resolve(socketPath, ".."));
	return parent === basename(resolve(defaultDaemonSocketDir(), "..")) || PRIME_AGENT_SOCKET_DIR_NAME.test(parent);
}

const PRIME_AGENT_SOCKET_DIR_NAME = /^prime-agent-(?:\d+|user)$/;

async function stopBackgroundService(
	socketPath: string,
	pid: number | undefined,
	handledPids: Set<number>,
	force: boolean,
	assertAdmission: () => Promise<void>,
): Promise<ReapOutcome> {
	await assertAdmission();
	if (await shutdownDaemon(socketPath, force)) {
		if (pid !== undefined) {
			handledPids.add(pid);
		}
		return { reaped: `stopped background service${pid ? ` (pid ${pid})` : ""}` };
	}
	if (!(await canConnectToSocket(socketPath, 250))) {
		await assertAdmission();
		removeSocketFile(socketPath);
		return { reaped: "background service already stopped" };
	}
	if (pid === undefined) {
		return { skipped: "still listening but no pid to kill" };
	}
	if (!force) {
		return { skipped: "did not stop gracefully; retry with --force" };
	}
	await assertAdmission();
	await forceKillDaemon(pid);
	handledPids.add(pid);
	await assertAdmission();
	removeSocketFile(socketPath);
	return { reaped: `force-killed unresponsive background service (pid ${pid})` };
}

interface TrackedWorker {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
}

/**
 * Workers whose supervisor socket is no longer served by anything.
 *
 * Worker sockets are deliberately kept out of the daemon list, so without this
 * face a leaked worker (its supervisor crashed, or a suite daemon exited and
 * left it behind) would be invisible *and* uncleanable. Identity is checked
 * against the descriptor the supervisor wrote, so a recycled pid is never
 * signalled.
 */
export type OrphanWorkerAction =
	| { kind: "stop"; descriptor: DaemonWorkerDescriptor }
	| { kind: "remove-records"; descriptor: DaemonWorkerDescriptor }
	| { kind: "skip"; descriptor: DaemonWorkerDescriptor; reason: string };

export function planOrphanWorkerReap(
	workers: readonly DaemonWorkerDescriptor[],
	servedSupervisorSockets: ReadonlySet<string>,
	options: {
		selection: StopSelection;
		processAlive: (pid: number) => boolean;
		identityMatches: (descriptor: DaemonWorkerDescriptor) => boolean;
	},
): OrphanWorkerAction[] {
	return workers.map((descriptor): OrphanWorkerAction => {
		const supervisor = normalizeSocketPath(descriptor.supervisorSocketPath);
		if (!matchesShutdownScope(supervisor, options.selection.scope)) {
			return { kind: "skip", descriptor, reason: "supervisor socket is outside the cleanup scope" };
		}
		if (servedSupervisorSockets.has(supervisor)) {
			return { kind: "skip", descriptor, reason: "supervisor is still serving its workers" };
		}
		if (!options.processAlive(descriptor.pid)) {
			return { kind: "remove-records", descriptor };
		}
		if (descriptor.processStartId === undefined) {
			return {
				kind: "skip",
				descriptor,
				reason: `process ${descriptor.pid} is alive but the descriptor recorded no process identity, not signalling it`,
			};
		}
		if (!options.identityMatches(descriptor)) {
			return {
				kind: "skip",
				descriptor,
				reason: `process ${descriptor.pid} is alive but its identity does not match the descriptor`,
			};
		}
		return { kind: "stop", descriptor };
	});
}

async function forceStopTrackedWorkers(
	supervisorSocketPath: string,
	assertAdmission: () => Promise<void>,
): Promise<string[]> {
	const failures: string[] = [];
	for (const worker of findTrackedWorkers(supervisorSocketPath)) {
		const { descriptor } = worker;
		let cleanupWorkerRecords = await stopTrackedProcess(descriptor.pid, descriptor.processStartId, assertAdmission);
		if (!cleanupWorkerRecords) {
			failures.push(`could not safely stop worker ${descriptor.workerId} (pid ${descriptor.pid})`);
		}
		if (descriptor.orphanProcessJournalPath) {
			let orphans: ReturnType<typeof readActiveOrphanProcesses> = [];
			try {
				orphans = readActiveOrphanProcesses(descriptor.orphanProcessJournalPath, descriptor.pid);
			} catch (error) {
				failures.push(`could not read child process records for worker ${descriptor.workerId}: ${String(error)}`);
			}
			for (const orphan of orphans) {
				// Pid-only records go through the platform predicate (stopTrackedProcess needs a startId).
				if (orphan.processStartId === undefined) {
					if (shouldReapOrphanProcess(orphan)) {
						killOrphanProcess(orphan.pid);
					}
					continue;
				}
				if (!isOrphanProcessIdentityCurrent(orphan)) {
					continue;
				}
				if (process.platform === "win32") {
					// taskkill /T, like the sibling reapers: signalling only the shell pid leaves its descendants alive.
					await assertAdmission();
					if (isOrphanProcessIdentityCurrent(orphan)) {
						killOrphanProcess(orphan.pid);
						if (isProcessAlive(orphan.pid)) {
							cleanupWorkerRecords = false;
							failures.push(`could not stop child process ${orphan.pid} for worker ${descriptor.workerId}`);
						}
					}
					continue;
				}
				if (!(await stopTrackedProcess(orphan.pid, orphan.processStartId, assertAdmission))) {
					cleanupWorkerRecords = false;
					failures.push(`could not stop child process ${orphan.pid} for worker ${descriptor.workerId}`);
				}
			}
		}
		if (cleanupWorkerRecords) {
			const cleanup = removeTrackedWorkerRecords(worker);
			if (cleanup) {
				failures.push(`could not clean up worker ${descriptor.workerId}: ${cleanup}`);
			}
		}
	}
	return failures;
}

/** Remove a worker's socket and journals. Returns an error string when it failed. */
function removeTrackedWorkerRecords(worker: TrackedWorker): string | undefined {
	const { descriptor } = worker;
	try {
		removeSocketFile(descriptor.socketPath);
		rmSync(worker.descriptorPath, { force: true });
		rmSync(descriptor.recoveryJournalPath, { force: true });
		if (descriptor.orphanProcessJournalPath) {
			rmSync(descriptor.orphanProcessJournalPath, { force: true });
		}
		return undefined;
	} catch (error) {
		return String(error);
	}
}

/**
 * Worker processes whose identity still matches the descriptor their supervisor
 * wrote. A live worker is the strongest evidence there is that the socket above
 * it is not scrap: the process is running work right now.
 */
export function countLiveTrackedWorkers(
	descriptors: readonly DaemonWorkerDescriptor[],
	identityMatches: (descriptor: DaemonWorkerDescriptor) => boolean = defaultIdentityMatches,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const descriptor of descriptors) {
		const supervisor = normalizeSocketPath(descriptor.supervisorSocketPath);
		if (!counts.has(supervisor)) {
			counts.set(supervisor, 0);
		}
		if (identityMatches(descriptor)) {
			counts.set(supervisor, (counts.get(supervisor) ?? 0) + 1);
		}
	}
	return counts;
}

function defaultIdentityMatches(descriptor: DaemonWorkerDescriptor): boolean {
	if (descriptor.processStartId === undefined) {
		return isProcessAlive(descriptor.pid);
	}
	return getProcessStartId(descriptor.pid) === descriptor.processStartId;
}

function findTrackedWorkers(supervisorSocketPath: string): TrackedWorker[] {
	return findAllTrackedWorkers().filter(
		(worker) =>
			normalizeSocketPath(worker.descriptor.supervisorSocketPath) === normalizeSocketPath(supervisorSocketPath),
	);
}

function findAllTrackedWorkers(): TrackedWorker[] {
	const root = join(getAgentDir(), "daemon-workers");
	if (!existsSync(root)) {
		return [];
	}
	const workers: TrackedWorker[] = [];
	let directoryNames: string[];
	try {
		directoryNames = readdirSync(root);
	} catch {
		return [];
	}
	for (const directoryName of directoryNames) {
		const directory = join(root, directoryName);
		try {
			if (!lstatSync(directory).isDirectory()) {
				continue;
			}
		} catch {
			continue;
		}
		let fileNames: string[];
		try {
			fileNames = readdirSync(directory);
		} catch {
			continue;
		}
		for (const fileName of fileNames) {
			if (!fileName.endsWith(".json")) {
				continue;
			}
			const descriptorPath = join(directory, fileName);
			try {
				const value: unknown = JSON.parse(readFileSync(descriptorPath, "utf8"));
				if (isTrackedWorkerDescriptor(value)) {
					workers.push({ descriptor: value, descriptorPath });
				}
			} catch {
				// Invalid or concurrently removed descriptors are not safe shutdown targets.
			}
		}
	}
	return workers;
}

function isTrackedWorkerDescriptor(value: unknown): value is DaemonWorkerDescriptor {
	if (!value || typeof value !== "object") {
		return false;
	}
	const descriptor = value as Partial<DaemonWorkerDescriptor>;
	return (
		(descriptor.version === 1 || descriptor.version === 2) &&
		typeof descriptor.supervisorSocketPath === "string" &&
		typeof descriptor.workerId === "string" &&
		Number.isInteger(descriptor.pid) &&
		(descriptor.pid ?? 0) > 0 &&
		(descriptor.processStartId === undefined || typeof descriptor.processStartId === "string") &&
		typeof descriptor.socketPath === "string" &&
		typeof descriptor.recoveryJournalPath === "string"
	);
}

async function stopTrackedProcess(
	pid: number,
	expectedStartId: string | undefined,
	assertAdmission: () => Promise<void>,
): Promise<boolean> {
	if (!isProcessAlive(pid)) {
		return true;
	}
	if (!expectedStartId || getProcessStartId(pid) !== expectedStartId) {
		return false;
	}
	await assertAdmission();
	if (getProcessStartId(pid) !== expectedStartId) {
		return false;
	}
	signalProcessGroupOrProcess(pid, "SIGTERM");
	let deadline = Date.now() + 500;
	while (isProcessAlive(pid) && Date.now() < deadline) {
		await delay(25);
	}
	if (!isProcessAlive(pid)) {
		return true;
	}
	await assertAdmission();
	if (getProcessStartId(pid) !== expectedStartId) {
		return false;
	}
	signalProcessGroupOrProcess(pid, "SIGKILL");
	deadline = Date.now() + 1000;
	while (isProcessAlive(pid) && Date.now() < deadline) {
		await delay(25);
	}
	return !isProcessAlive(pid);
}

/**
 * `doctor --fix` cleanup. Scoped by default (the caller's own socket dir), with
 * `--dry-run` to list each target first and `--orphans` to refuse every service
 * that still carries live evidence.
 */
export async function runReap(
	json: boolean,
	force: boolean,
	selection: StopSelection = { scope: currentShutdownScope(), orphansOnly: false },
	dryRun = false,
): Promise<void> {
	const daemons = await discoverDaemons();
	const reaped: Array<{ socketPath: string; action: string }> = [];
	const skipped: Array<{ socketPath: string; reason: string }> = [];
	const actions = planReap(daemons, force, selection);
	const workers = findAllTrackedWorkers();
	const servedSockets = new Set(
		daemons
			.filter((daemon) => daemon.pid !== undefined || daemon.liveness !== "unknown")
			.map((daemon) => daemon.socketPath),
	);
	const orphanWorkers = planOrphanWorkerReap(
		workers.map((worker) => worker.descriptor),
		servedSockets,
		{ selection, processAlive: isProcessAlive, identityMatches: defaultIdentityMatches },
	);

	if (dryRun) {
		const plan = [
			...actions.map((action) => ({
				kind: action.kind,
				socketPath: action.daemon.socketPath,
				detail: "reason" in action ? action.reason : "would be cleaned",
			})),
			...orphanWorkers.map((action) => ({
				kind: action.kind === "skip" ? ("skip" as const) : action.kind,
				socketPath: action.descriptor.socketPath,
				detail:
					action.kind === "skip"
						? action.reason
						: `worker ${action.descriptor.workerId} (pid ${action.descriptor.pid}) of the unserved supervisor ${action.descriptor.supervisorSocketPath}`,
			})),
		];
		if (json) {
			console.log(JSON.stringify({ dryRun: true, scope: selection.scope, plan }, null, 2));
			return;
		}
		console.log(`Cleanup plan for ${describeShutdownScope(selection.scope)}; nothing was touched.`);
		for (const entry of plan) {
			console.log(`  ${entry.kind.padEnd(14)} ${entry.socketPath}: ${entry.detail}`);
		}
		return;
	}

	for (const action of actions) {
		const { socketPath, pid } = action.daemon;
		switch (action.kind) {
			case "skip":
				skipped.push({ socketPath, reason: action.reason });
				break;
			case "remove-file": {
				// Re-probe before unlinking: a path marked orphan-file at discovery
				// may have since become a live listener. Only remove it if it is
				// still unreachable, so we never delete a socket a daemon is using.
				if ((await probeDaemon(socketPath)).reachable) {
					skipped.push({ socketPath, reason: "now reachable; not removing socket file" });
				} else if (removeSocketFile(socketPath)) {
					reaped.push({ socketPath, action: "removed stale socket file" });
				} else {
					skipped.push({ socketPath, reason: "could not remove socket file" });
				}
				break;
			}
			case "kill": {
				// Re-probe right before killing: discovery and this kill happen at
				// different moments, so a daemon classified "unreachable" may have
				// since started answering. Never SIGTERM one that now responds;
				// defer to the session-aware shutdown path instead.
				const recheck = await probeDaemon(socketPath);
				if (!recheck.reachable) {
					killDaemon(pid!);
					removeSocketFile(socketPath);
					reaped.push({ socketPath, action: `killed unreachable daemon (pid ${pid})` });
				} else {
					apply(await reapReachableDaemon(socketPath, pid), socketPath, reaped, skipped);
				}
				break;
			}
			case "shutdown":
				apply(await reapReachableDaemon(socketPath, pid), socketPath, reaped, skipped);
				break;
		}
	}

	for (const action of orphanWorkers) {
		const { descriptor } = action;
		const label = `worker ${descriptor.workerId} (pid ${descriptor.pid})`;
		if (action.kind === "skip") {
			skipped.push({ socketPath: descriptor.socketPath, reason: `${label}: ${action.reason}` });
			continue;
		}
		const worker = workers.find((candidate) => candidate.descriptorPath && candidate.descriptor === descriptor);
		if (!worker) {
			skipped.push({ socketPath: descriptor.socketPath, reason: `${label}: descriptor disappeared` });
			continue;
		}
		if (action.kind === "stop") {
			const admission = async () => {};
			if (!(await stopTrackedProcess(descriptor.pid, descriptor.processStartId, admission))) {
				skipped.push({ socketPath: descriptor.socketPath, reason: `${label}: could not be stopped safely` });
				continue;
			}
		}
		const cleanup = removeTrackedWorkerRecords(worker);
		if (cleanup) {
			skipped.push({ socketPath: descriptor.socketPath, reason: `${label}: could not remove records (${cleanup})` });
		} else {
			reaped.push({
				socketPath: descriptor.socketPath,
				action: action.kind === "stop" ? `stopped orphaned ${label}` : `removed records of dead ${label}`,
			});
		}
	}

	if (json) {
		console.log(JSON.stringify({ scope: selection.scope, reaped, skipped }, null, 2));
		return;
	}
	if (reaped.length === 0 && skipped.length === 0) {
		console.log(`No background services found in scope: ${describeShutdownScope(selection.scope)}`);
		return;
	}
	for (const entry of reaped) {
		console.log(chalk.green(`reaped ${entry.socketPath}: ${entry.action}`));
	}
	for (const entry of skipped) {
		console.log(chalk.dim(`kept   ${entry.socketPath}: ${entry.reason}`));
	}
}

type ReapOutcome = { reaped: string } | { skipped: string };

function apply(
	outcome: ReapOutcome,
	socketPath: string,
	reaped: Array<{ socketPath: string; action: string }>,
	skipped: Array<{ socketPath: string; reason: string }>,
): void {
	if ("reaped" in outcome) {
		reaped.push({ socketPath, action: outcome.reaped });
	} else {
		skipped.push({ socketPath, reason: outcome.skipped });
	}
}

/**
 * Gracefully stop a daemon, but only after a fresh probe confirms it is idle.
 * Discovery and reap happen at different moments, so the session count is
 * re-checked here to avoid stopping a daemon that gained a session in between.
 */
async function reapReachableDaemon(socketPath: string, pid: number | undefined): Promise<ReapOutcome> {
	const probe = await probeDaemon(socketPath);
	if (!probe.reachable) {
		return { skipped: "no longer reachable" };
	}
	if (probe.sessionCount !== 0) {
		return { skipped: `now has ${probe.sessionCount ?? "unknown"} session(s)` };
	}
	return (await shutdownDaemon(socketPath, false))
		? { reaped: `stopped idle background service${pid ? ` (pid ${pid})` : ""}` }
		: { skipped: "shutdown request failed" };
}

function removeSocketFile(socketPath: string): boolean {
	try {
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
		return true;
	} catch {
		return false;
	}
}

function killDaemon(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Process already gone or not permitted; the socket file cleanup still runs.
	}
}

async function forceKillDaemon(pid: number): Promise<void> {
	killDaemon(pid);
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return;
		}
		await delay(50);
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Process already exited between the liveness check and the kill.
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canConnectToSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
	const client = new DaemonClient(socketPath, { declaredCapabilities: DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES });
	try {
		await client.connect(timeoutMs);
		return true;
	} catch {
		return false;
	} finally {
		client.close();
	}
}

/**
 * Ask a daemon to shut down and confirm it actually stopped listening. The
 * shutdown ack alone is not proof, so success is reported only once the socket
 * stops accepting connections.
 */
async function shutdownDaemon(socketPath: string, force: boolean): Promise<boolean> {
	const client = new DaemonClient(socketPath, { declaredCapabilities: DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES });
	try {
		await client.connect(1000);
	} catch {
		client.close();
		return false;
	}
	try {
		await client.request({ type: "shutdown", force }, 1500);
	} catch {
		// The daemon may still stop; the connectivity check below is the source of truth.
	} finally {
		client.close();
	}

	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (!(await canConnectToSocket(socketPath, 250))) {
			return true;
		}
		await delay(50);
	}
	return false;
}
