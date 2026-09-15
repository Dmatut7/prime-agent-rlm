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
import { getDaemonRuntimeIdentity } from "../modes/daemon/daemon-runtime-identity.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath, normalizeSocketPath } from "../modes/daemon/daemon-socket.js";
import {
	acquireDaemonShutdownAdmission,
	findLiveDaemonOwnersForAgentDir,
	readRecordedDaemonSocketOwners,
} from "../modes/daemon/daemon-supervisor-ownership.js";
import type { DaemonWorkerDescriptor } from "../modes/daemon/daemon-worker-protocol.js";
import { signalProcessGroupOrProcess } from "../utils/child-process.js";
import {
	type ClientBuildIdentity,
	describeBuildMismatch,
	formatDaemonListTable,
	formatShutdownNextSteps,
	isVersionOnlyBuildId,
} from "./daemon-ps-format.js";
import { promptYesNo } from "./daemon-stop-confirm.js";
import {
	bindStopSelection,
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
	bindStopSelection,
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

/** What a stop report entry names. A worker is its own target: it dies on its own pid. */
export type DaemonStopKind = "service" | "worker" | "listener";

/**
 * One line of a stop report. `stopped` entries carry `action`, every other bucket
 * carries `reason`, and one discovered socket path lands in exactly one bucket so
 * `discovered === stopped + failed + skipped + leftRunning` holds by construction.
 */
export interface ShutdownTargetEntry {
	socketPath: string;
	pid?: number;
	kind: DaemonStopKind;
	action?: string;
	reason?: string;
}

/** What a signalling path has to know about a target before it may touch it. */
export interface DaemonTargetEvidence {
	/** The OS scan sees this pid holding this path as a listening unix socket right now. */
	listeningSocket: boolean;
	/** The path is a socket file on disk right now. */
	socketFilePresent: boolean;
	/** A supervisor owner record names this socket path and this pid, and that record's identity is alive. */
	recordedOwner: boolean;
	/** That owner record pins a process start id, so a recycled pid cannot match it. */
	recordedOwnerIdIsPinned: boolean;
	/** The socket answered the daemon handshake (hello, or a standardized command). */
	answeredDaemonHandshake: boolean;
}

/**
 * The one gate every signalling path goes through.
 *
 * `parseLsofListeners` accepts any unix socket path a prime-agent-named process
 * holds, and node's own IPC sockets (`$TMPDIR/tsx-<uid>/<pid>.pipe`) are unix
 * socket files that look exactly like daemon sockets to that scan. Process
 * identity (`getProcessStartId`) only proves "still the same process", never
 * "this is a daemon", so without this gate a whole-machine `--force` can SIGTERM
 * an unrelated launcher. A target is signalled only when it is a listening unix
 * socket *and* something proves it is a daemon: a supervisor owner record naming
 * it, or the daemon handshake. Everything else is left running, with the reason.
 */
export function daemonTargetRefusal(
	target: { pid: number; socketPath: string },
	evidence: DaemonTargetEvidence,
): string | undefined {
	if (evidence.recordedOwner && evidence.recordedOwnerIdIsPinned) {
		// The registry names this pid *and* pins the process identity, so a recycled
		// pid cannot match it. That is the machine's own proof this is a daemon, and it
		// does not expire when the socket file is unlinked underneath a live owner:
		// refusing here is what made such a daemon impossible to stop ever again, since
		// every other sweep reasons from a path that no longer exists.
		return undefined;
	}
	if (!evidence.listeningSocket || !evidence.socketFilePresent) {
		return `refusing to signal pid ${target.pid}: ${target.socketPath} is not a listening unix socket`;
	}
	if (evidence.recordedOwner || evidence.answeredDaemonHandshake) {
		return undefined;
	}
	return (
		`refusing to signal pid ${target.pid} on ${target.socketPath}: it is not a verified daemon ` +
		"(no supervisor owner record names it and it does not answer the daemon handshake)"
	);
}

export interface DaemonTargetVerifier {
	verify(target: { pid: number; socketPath: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

function isSocketFile(socketPath: string): boolean {
	try {
		return lstatSync(socketPath).isSocket();
	} catch {
		return false;
	}
}

function recordedOwnerIsAlive(owner: { pid: number; processStartId?: string }): boolean {
	if (!isProcessAlive(owner.pid)) {
		return false;
	}
	return owner.processStartId === undefined || getProcessStartId(owner.pid) === owner.processStartId;
}

/**
 * The machine's daemon-identity source, cached for one command: the owner
 * registry is read once and each socket is handshake-probed at most once, so a
 * converging sweep does not re-fork `ps`/`lsof` per attempt.
 */
export function createDaemonTargetVerifier(): DaemonTargetVerifier {
	let recordedOwners: ReturnType<typeof readRecordedDaemonSocketOwners> | undefined;
	const handshakes = new Map<string, Promise<boolean>>();
	return {
		async verify(target) {
			const socketFilePresent = process.platform === "win32" || isSocketFile(target.socketPath);
			const listeningSocket = isDaemonProcessListening(target.pid, target.socketPath) && socketFilePresent;
			recordedOwners ??= readRecordedDaemonSocketOwners();
			const normalized = normalizeSocketPath(target.socketPath);
			const owner = recordedOwners.find(
				(candidate) => candidate.socketPath === normalized && candidate.pid === target.pid,
			);
			const recordedOwner = owner !== undefined && recordedOwnerIsAlive(owner);
			const recordedOwnerIdIsPinned =
				recordedOwner &&
				owner?.processStartId !== undefined &&
				getProcessStartId(target.pid) === owner.processStartId;
			let answeredDaemonHandshake = false;
			if (listeningSocket && !recordedOwner) {
				let pending = handshakes.get(normalized);
				if (!pending) {
					pending = probeDaemon(normalized).then((probe) => probe.answeredProbe);
					handshakes.set(normalized, pending);
				}
				answeredDaemonHandshake = await pending;
			}
			const reason = daemonTargetRefusal(target, {
				listeningSocket,
				socketFilePresent,
				recordedOwner,
				recordedOwnerIdIsPinned,
				answeredDaemonHandshake,
			});
			return reason === undefined ? { ok: true as const } : { ok: false as const, reason };
		},
	};
}

type ShutdownBucket = "stopped" | "failed" | "skipped" | "leftRunning";

/**
 * A target's identity in the report. One socket path can be held by two
 * processes at once — that is the hidden-supervisor case — and each of them is
 * its own target: keying by path alone let the pid that was stopped swallow the
 * verdict for the pid that survived, so a live daemon was absent from every face
 * of the report while `discovered` still added up.
 */
function shutdownTargetKey(socketPath: string, pid: number | undefined): string {
	return `${socketPath}\u0000${pid === undefined ? "" : pid}`;
}

/** How strongly a bucket states what happened. The stronger word survives a later, weaker claim. */
const BUCKET_RANK: Record<ShutdownBucket, number> = {
	skipped: 0,
	leftRunning: 1,
	stopped: 2,
	failed: 3,
};

/**
 * A target as the observation pass takes it: the report entry, plus the service
 * that owns it when another service's stop can explain its death (a worker goes
 * with the supervisor this run stopped).
 */
export type ObservedShutdownTarget = ShutdownTargetEntry & { supervisorSocketPath?: string };

/** One target the scope covers, as it looked when the run started. */
interface ObservedScopeTarget extends ObservedShutdownTarget {
	/** Identity of `pid` at observation time, when that process was alive. */
	processStartId?: string;
	/** The socket file was on disk, or that exact process was alive, when the run began. */
	presentAtObservation: boolean;
}

/**
 * One stop command's accounting, keyed by socket path *and* pid.
 *
 * Keying by target is what makes the totals add up: a service that both failed
 * and disappeared cannot be reported as stopped, a refusal cannot be laundered
 * into a success, a second process on an already-reported path cannot hide behind
 * the first one's verdict, and the observation pass at the end (`converge`) gives
 * every target the scope covered a bucket, so nothing is silently dropped.
 *
 * A bucket is a claim about *this run*, so the report also keeps the ledger of
 * what the run really did — `recordSignal`, `recordSocketRemoval`,
 * `recordStoppedService` — and `converge` is only allowed to call a disappeared
 * target a stop when the ledger backs it.
 */
export class ShutdownReport {
	private readonly bucketByKey = new Map<string, ShutdownBucket>();
	private readonly entriesByBucket: Record<ShutdownBucket, ShutdownTargetEntry[]> = {
		stopped: [],
		failed: [],
		skipped: [],
		leftRunning: [],
	};
	private readonly refusalByKey = new Map<string, string>();
	private readonly keptKeys = new Set<string>();
	/** Pids this run sent a signal to. */
	private readonly signalledPids = new Set<number>();
	/** Socket paths whose file this run unlinked. */
	private readonly removedSocketPaths = new Set<string>();
	/** Socket paths whose service this run stopped, which is what a worker of it can be explained by. */
	private readonly stoppedServicePaths = new Set<string>();
	/** Every target this report names, by observation, by keeping, or by a claim. */
	private readonly namedKeys = new Set<string>();
	/** Targets this run's scope covers, observed before anything was signalled. */
	readonly scopeTargets = new Map<string, ObservedScopeTarget>();

	/** A discovered service the selection leaves alone: it stays running, and it was still discovered. */
	keep(entry: ShutdownTargetEntry & { reason: string }): void {
		const key = shutdownTargetKey(entry.socketPath, entry.pid);
		if (this.keptKeys.has(key)) {
			return;
		}
		this.keptKeys.add(key);
		this.claim("leftRunning", entry);
	}

	/** The target set this run is accountable for, observed before anything is signalled. */
	observe(targets: Iterable<ObservedShutdownTarget>): void {
		for (const target of targets) {
			const key = shutdownTargetKey(target.socketPath, target.pid);
			this.namedKeys.add(key);
			if (this.scopeTargets.has(key)) {
				continue;
			}
			const processStartId = target.pid === undefined ? undefined : getProcessStartId(target.pid);
			this.scopeTargets.set(key, {
				...target,
				...(processStartId === undefined ? {} : { processStartId }),
				presentAtObservation: existsSync(target.socketPath) || processStartId !== undefined,
			});
		}
	}

	/** Why one target was refused a signal, so the sweep does not keep re-deciding it. */
	refusalReason(socketPath: string, pid?: number): string | undefined {
		return this.refusalByKey.get(shutdownTargetKey(socketPath, pid));
	}

	/** A target no signal may touch, with the proof that was missing. */
	refuse(entry: ShutdownTargetEntry & { reason: string }): void {
		this.refusalByKey.set(shutdownTargetKey(entry.socketPath, entry.pid), entry.reason);
		this.claim("leftRunning", entry);
	}

	/**
	 * The ledger of what this run really did, and the only thing that entitles a
	 * target to a `stopped` verdict it did not earn by an explicit claim. A target
	 * that disappears inside the convergence window without an entry here was stopped
	 * by something else — a natural exit, another process's `kill`, an orphan reaper —
	 * and crediting this command with it is a lie the bucket totals happily hide.
	 */
	recordSignal(pid: number): void {
		this.signalledPids.add(pid);
	}

	/** This run unlinked that socket file. Only call it once the unlink really happened. */
	recordSocketRemoval(socketPath: string): void {
		this.removedSocketPaths.add(normalizeSocketPath(socketPath));
	}

	/** This run stopped the service on that socket, so its own workers went with it. */
	recordStoppedService(socketPath: string): void {
		this.stoppedServicePaths.add(normalizeSocketPath(socketPath));
	}

	/** Whether this run signalled that pid or removed that socket file itself. */
	private wasTouched(target: { socketPath: string; pid?: number }): boolean {
		return (
			(target.pid !== undefined && this.signalledPids.has(target.pid)) ||
			this.removedSocketPaths.has(normalizeSocketPath(target.socketPath))
		);
	}

	/** Whether this run stopped the service that owns that target, which is a worker's own explanation. */
	private ownedByStoppedService(target: ObservedScopeTarget): boolean {
		return (
			target.supervisorSocketPath !== undefined &&
			this.stoppedServicePaths.has(normalizeSocketPath(target.supervisorSocketPath))
		);
	}

	claim(bucket: ShutdownBucket, entry: ShutdownTargetEntry): void {
		const key = shutdownTargetKey(entry.socketPath, entry.pid);
		this.namedKeys.add(key);
		const existing = this.bucketByKey.get(key);
		if (existing !== undefined && BUCKET_RANK[bucket] <= BUCKET_RANK[existing]) {
			return;
		}
		this.record(bucket, key, entry);
	}

	bucketOf(socketPath: string, pid?: number): ShutdownBucket | undefined {
		return this.bucketByKey.get(shutdownTargetKey(socketPath, pid));
	}

	get stopped(): ShutdownTargetEntry[] {
		return this.entriesByBucket.stopped;
	}

	get failed(): ShutdownTargetEntry[] {
		return this.entriesByBucket.failed;
	}

	get skipped(): ShutdownTargetEntry[] {
		return this.entriesByBucket.skipped;
	}

	get leftRunning(): ShutdownTargetEntry[] {
		return this.entriesByBucket.leftRunning;
	}

	get discovered(): number {
		return this.namedKeys.size;
	}

	/**
	 * The observation diff the report is judged by: every target the scope covered
	 * is checked once more, whatever its bucket said, and what is still here is
	 * named. "Still here" is both faces of a daemon — its socket file on disk *and*
	 * its process identity alive — because a daemon whose file was unlinked
	 * underneath it is still running, and a disk-only check called that clean.
	 * `stillPresent === []` is the only clean verdict.
	 *
	 * Gone is the other half of the observation, and it is judged as strictly: a
	 * disappearance only becomes a `stopped` when the ledger says this run caused
	 * it. A target that dies inside the window for its own reasons keeps whatever
	 * this run really decided about it, so a protected service or a refused
	 * stranger cannot be reported as a stop this command never performed.
	 */
	converge(): string[] {
		const stillPresent: string[] = [];
		for (const target of this.scopeTargets.values()) {
			const { socketPath, pid, kind, processStartId, presentAtObservation } = target;
			const filePresent = existsSync(socketPath);
			// A recycled pid is a convergence, not a survivor: only the identity that
			// was observed at the start counts as still running.
			const processPresent =
				pid !== undefined && processStartId !== undefined && getProcessStartId(pid) === processStartId;
			if (filePresent || processPresent) {
				if (!stillPresent.includes(socketPath)) {
					stillPresent.push(socketPath);
				}
				const key = shutdownTargetKey(socketPath, pid);
				const existing = this.bucketByKey.get(key);
				// A failure, a refusal and a deliberate keep already say why this target
				// is still here; only a success claim is contradicted by the observation.
				if (existing === undefined || existing === "stopped") {
					const reason =
						this.refusalByKey.get(key) ??
						(processPresent
							? `still running after shutdown: pid ${pid} is alive${
									filePresent ? "" : " and its socket file is gone"
								}, and nothing in this scope stopped it`
							: "still present after shutdown: nothing in this scope removed this socket");
					this.record("leftRunning", key, {
						socketPath,
						...(pid === undefined ? {} : { pid }),
						kind,
						reason,
					});
				}
				continue;
			}
			// Only a target that was really here can have converged here: a stale
			// descriptor whose socket was already gone is not a stop we performed.
			const entry = { socketPath, ...(pid === undefined ? {} : { pid }), kind };
			if (!presentAtObservation) {
				this.claim("skipped", { ...entry, reason: "already gone before the stop; nothing to stop" });
				continue;
			}
			if (this.wasTouched(entry)) {
				this.claim("stopped", { ...entry, action: "converged during shutdown" });
				continue;
			}
			if (this.ownedByStoppedService(target)) {
				this.claim("stopped", { ...entry, action: "converged with the service this run stopped" });
				continue;
			}
			// Gone, and nothing this run did explains it. `skipped` is the weakest word
			// available, so a keep, a refusal or a failed graceful stop that already
			// named this target keeps its own, more specific reason.
			this.claim("skipped", { ...entry, reason: "vanished without this run touching it" });
		}
		return stillPresent.sort();
	}

	toJson(): Record<string, unknown> {
		return {
			discovered: this.discovered,
			stopped: this.stopped,
			failed: this.failed,
			skipped: this.skipped,
			leftRunning: this.leftRunning,
		};
	}

	/** One target holds exactly one entry, so a replaced verdict cannot be counted twice. */
	private record(bucket: ShutdownBucket, key: string, entry: ShutdownTargetEntry): void {
		const existing = this.bucketByKey.get(key);
		if (existing !== undefined) {
			const entries = this.entriesByBucket[existing];
			const index = entries.findIndex((candidate) => shutdownTargetKey(candidate.socketPath, candidate.pid) === key);
			if (index >= 0) {
				entries.splice(index, 1);
			}
		}
		this.namedKeys.add(key);
		this.bucketByKey.set(key, bucket);
		this.entriesByBucket[bucket].push(entry);
	}
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
	// A missing cpu reading is not a zero reading: "not sampled" is its own fact,
	// reported as such so an idle verdict never cites evidence that was never gathered.
	const cpuEvidence = evidence.cpuPercent === undefined ? ["cpu not sampled (no reading)"] : [];
	return { liveness: "idle", evidence: ["answered probe with no work", ...cpuEvidence] };
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
	// The daemons that own this agent dir are services this process talks to,
	// whether or not this shell's temp dir is where they chose to listen: the
	// listener scan sees them only when the OS scan reaches their pid, and the
	// socket-dir sweep only when the socket sits in this shell's directory. The
	// registry is the same authority `list`/`attach` use, so a daemon reachable
	// from here is never invisible to `ps` or to a stop plan built on it.
	const agentDirOwnerSockets = (await findLiveDaemonOwnersForAgentDir(getAgentDir())).map((owner) =>
		normalizeSocketPath(owner.socketPath),
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
		...agentDirOwnerSockets.filter(isDaemonSocket),
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
	console.log(formatDaemonListTable(daemons, currentClientBuildIdentity()));
	// `status` is machine-wide, but the stop commands are not. Say which rows a
	// plain `prime-agent shutdown` would actually touch, so the two views of the
	// machine cannot disagree about what is next on the destroy list.
	const effective = await bindStopSelection(selection ?? { scope: { kind: "current" }, orphansOnly: false });
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

/**
 * What this CLI can say about its own build, from the same identity the daemon
 * handshake carries and the launch-side staleness check compares. A process
 * that reports only `release-<version>` has no commit-level build id, and the
 * user-facing copy says so instead of pretending a comparison.
 */
export function currentClientBuildIdentity(): ClientBuildIdentity {
	const runtime = getDaemonRuntimeIdentity();
	const executablePath = runtime.launcherPath ?? runtime.entrypointPath ?? runtime.executablePath;
	const versionOnly = isVersionOnlyBuildId(runtime.buildId, VERSION);
	return {
		version: VERSION,
		protocolVersion: DAEMON_PROTOCOL_VERSION,
		schemaId: DAEMON_SCHEMA_ID,
		...(versionOnly
			? { buildIdUnavailableReason: `it reports only ${runtime.buildId}` }
			: { buildId: runtime.buildId }),
		...(executablePath === undefined ? {} : { executablePath }),
	};
}

/** Name one discovered service for a confirmation prompt: path, pid, live sessions. */
export function describeShutdownTarget(
	daemon: DaemonInfo,
	client: ClientBuildIdentity = currentClientBuildIdentity(),
): string {
	const sessions =
		daemon.sessionCount === undefined
			? "sessions unknown"
			: `${daemon.sessionCount} live session(s)${daemon.sessionCount > 0 ? " [ACTIVE WORK]" : ""}`;
	const pid = daemon.pid === undefined ? "pid unknown" : `pid ${daemon.pid}`;
	const flags = [
		daemon.isDefault ? "default service" : undefined,
		daemon.status === "outdated" ? describeBuildMismatch(daemon, client) : undefined,
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
/** How long a discovered service is protected from sweep plans after it started (DS-4). */
export const DAEMON_STARTUP_GRACE_SECONDS = 15;

export function planReap(daemons: readonly DaemonInfo[], force: boolean, selection: StopSelection): ReapAction[] {
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
		// A service that started seconds ago has not had time to accumulate live
		// evidence, so a sweep must not read its quietness as abandonment (DS-4).
		if (daemon.uptimeSeconds !== undefined && daemon.uptimeSeconds < DAEMON_STARTUP_GRACE_SECONDS) {
			return {
				kind: "skip",
				daemon,
				reason: `started ${Math.floor(daemon.uptimeSeconds)}s ago; within the ${DAEMON_STARTUP_GRACE_SECONDS}s startup grace`,
			};
		}
		if (daemon.status === "unreachable") {
			if (!force || daemon.pid === undefined) {
				return { kind: "skip", daemon, reason: 'unreachable; use "prime-agent shutdown --force" to stop it' };
			}
			// The live workers of an unreachable supervisor are stopped by the same
			// run before the kill (see runReap), so the plan may kill: this keeps
			// `reap --force`, `doctor --fix` advice and `shutdown --force` from
			// disagreeing about a hung supervisor that still owns workers (DS-4).
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
	selection: StopSelection,
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
	client: ClientBuildIdentity = currentClientBuildIdentity(),
): string {
	const listed = [...selected, ...excluded];
	const lines = [
		`${selection.scope.kind === "machine" ? "WHOLE-MACHINE scope" : "Scoped"}: ${describeShutdownScope(selection.scope)}`,
		`${selected.length} of ${selected.length + excluded.length} discovered service(s) will be stopped (${totalLiveSessions(selected)} live session(s) on them).`,
	];
	for (const daemon of selected) {
		lines.push(`  stop  ${describeShutdownTarget(daemon, client)}`);
	}
	for (const daemon of excluded) {
		lines.push(`  keep  ${describeShutdownTarget(daemon, client)}  (${selectionExclusionReason(daemon, selection)})`);
	}
	if (listed.some((daemon) => daemon.status === "outdated" || daemon.status === "stale")) {
		lines.push(formatShutdownNextSteps(client));
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

/**
 * A stop command's shared state: the accounting it writes into, the gate that
 * decides what may be signalled, and the admission check that has to be re-run
 * before every signal.
 */
interface ShutdownSweep {
	report: ShutdownReport;
	verifier: DaemonTargetVerifier;
	handledPids: Set<number>;
	assertAdmission: () => Promise<void>;
	force: boolean;
}

function targetEntry(
	socketPath: string,
	pid: number | undefined,
	kind: DaemonStopKind,
): { socketPath: string; pid?: number; kind: DaemonStopKind } {
	return { socketPath, ...(pid !== undefined ? { pid } : {}), kind };
}

/** A worker socket is a worker wherever it was discovered; anything else is a service. */
function kindForPath(socketPath: string): DaemonStopKind {
	return isWorkerSocketPath(socketPath) ? "worker" : "listener";
}

function describeShutdownEntry(entry: ShutdownTargetEntry): string {
	const pid = entry.pid === undefined ? "" : ` (pid ${entry.pid})`;
	const kind = entry.kind === "service" ? "" : ` [${entry.kind}]`;
	return `${entry.socketPath}${pid}${kind}`;
}

/**
 * The socket paths one stop selection covers, observed *before* any signal.
 *
 * Three sources, because no single one is complete: discovered services in
 * scope; every listening unix socket in scope, worker sockets included (the
 * daemon list filters those out on purpose, but a worker socket is a socket in
 * the scope and a real process is holding it); and every tracked worker whose
 * supervisor is in scope, so a worker stays a target even before its socket has
 * been scanned. This is the set the report diffs at the end, which is how a
 * worker that really converged gets named even though nothing ever intended to
 * name it.
 */
async function observeScopeTargets(
	selection: StopSelection,
	selectedDaemons: readonly DaemonInfo[],
): Promise<ObservedShutdownTarget[]> {
	const targetsByKey = new Map<string, ObservedShutdownTarget>();
	const add = (
		socketPath: string,
		pid: number | undefined,
		kind: DaemonStopKind,
		supervisorSocketPath?: string,
	): void => {
		const key = shutdownTargetKey(socketPath, pid);
		const known = targetsByKey.get(key);
		if (known) {
			// A worker socket is seen by the listener scan before the descriptor that
			// names its owner, and the owner is what can explain its death later.
			if (supervisorSocketPath !== undefined && known.supervisorSocketPath === undefined) {
				known.supervisorSocketPath = supervisorSocketPath;
			}
			return;
		}
		targetsByKey.set(key, {
			...targetEntry(socketPath, pid, kind),
			...(supervisorSocketPath === undefined ? {} : { supervisorSocketPath }),
		});
	};
	for (const daemon of selectedDaemons) {
		add(daemon.socketPath, daemon.pid, "service");
	}
	// Every pid holding a socket in scope, not one per path: `discoverDaemons` keeps a
	// single pid per socket on purpose, and a report built on that alone cannot name
	// the second process on the same path.
	for (const listener of scanListeningDaemons()) {
		if (!matchesShutdownScope(listener.socketPath, selection.scope)) {
			continue;
		}
		add(listener.socketPath, listener.pid, kindForPath(listener.socketPath));
	}
	for (const worker of findAllTrackedWorkers()) {
		const { descriptor } = worker;
		const inScope =
			matchesShutdownScope(descriptor.supervisorSocketPath, selection.scope) ||
			matchesShutdownScope(descriptor.socketPath, selection.scope);
		if (inScope) {
			add(descriptor.socketPath, descriptor.pid, "worker", descriptor.supervisorSocketPath);
		}
	}
	// The owner registry names pids, and a pid outlives the removal of its socket
	// file. Both scans above reason from paths, so a daemon whose file is already
	// gone would be invisible here — and an invisible target is an unaccounted one.
	for (const owner of recordedOwnersInScope(selection)) {
		add(owner.socketPath, owner.pid, kindForPath(owner.socketPath));
	}
	return [...targetsByKey.values()];
}

/** The supervisor owner records this selection covers. Liveness is the caller's call. */
function recordedOwnersInScope(selection: StopSelection): ReturnType<typeof readRecordedDaemonSocketOwners> {
	return readRecordedDaemonSocketOwners().filter(
		(owner) => !isWorkerSocketPath(owner.socketPath) && matchesShutdownScope(owner.socketPath, selection.scope),
	);
}

/** Discovery, scope partition and the socket set this run is accountable for. */
async function openShutdownReport(selection: StopSelection): Promise<{
	report: ShutdownReport;
	selected: DaemonInfo[];
	excluded: DaemonInfo[];
	humanReport: string;
}> {
	const daemons = (await discoverDaemons()).filter((daemon) => !isWorkerSocketPath(daemon.socketPath));
	const { selected, excluded } = selectStoppableDaemons(daemons, selection);
	const report = new ShutdownReport();
	report.observe(await observeScopeTargets(selection, selected));
	for (const daemon of excluded) {
		report.keep({
			...targetEntry(daemon.socketPath, daemon.pid, "service"),
			reason: selectionExclusionReason(daemon, selection) ?? "outside the requested scope",
		});
	}
	return { report, selected, excluded, humanReport: formatShutdownReport(selection, selected, excluded) };
}

export async function runShutdownSelection(
	json: boolean,
	force: boolean,
	selection: StopSelection = { scope: { kind: "current" }, orphansOnly: false },
	dryRun = false,
): Promise<void> {
	// A stop command has to know what this process owns before it plans anything:
	// the registry leg of the default scope is async, so it is bound once here and
	// every pure plan below sees the same concrete set.
	const scoped = await bindStopSelection(selection);
	const { report, selected, humanReport } = await openShutdownReport(scoped);
	if (dryRun) {
		if (json) {
			// The four-bucket identity (discovered === stopped + failed + skipped +
			// leftRunning) is a property of a real run's report: a dry run observes and
			// plans but never signals, so its buckets carry no verdicts. The plan's "left
			// alone" list is therefore `keptInScope`, not `leftRunning` - the full report's
			// word means "still running after this run tried to stop it", a different
			// proposition a scripted consumer must not have to disambiguate by shape.
			console.log(
				JSON.stringify(
					{ dryRun: true, scope: scoped.scope, targets: selected, keptInScope: report.leftRunning },
					null,
					2,
				),
			);
		} else {
			console.log(`${humanReport}\nDry run: nothing was stopped.`);
		}
		return;
	}
	switch (planShutdownConfirmation(selected.length, json, force, process.stdin.isTTY)) {
		case "json-error": {
			process.exitCode = 1;
			for (const daemon of selected) {
				report.claim("failed", {
					...targetEntry(daemon.socketPath, daemon.pid, "service"),
					reason: 'confirmation required; use "prime-agent shutdown --force --json"',
				});
			}
			const stillPresent = report.converge();
			console.log(JSON.stringify({ scope: scoped.scope, ...report.toJson(), stillPresent }, null, 2));
			return;
		}
		case "tty-error":
			throw new Error(
				`Shutdown requires confirmation in an interactive terminal. Use "prime-agent shutdown --force". Requested scope: ${describeShutdownScope(scoped.scope)}.`,
			);
		case "prompt": {
			const confirmed = await promptYesNo(`${humanReport}\n${formatShutdownQuestion(scoped, selected)}`);
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
				console.log(humanReport);
			}
			break;
	}
	if (selected.length === 0) {
		// planShutdownConfirmation() skips the question for an empty scope, so this
		// is the only place that tells the user why nothing was stopped.
		const stillPresent = report.converge();
		if (json) {
			console.log(JSON.stringify({ scope: scoped.scope, ...report.toJson(), stillPresent }, null, 2));
			return;
		}
		if (report.discovered === 0) {
			// Nothing was discovered anywhere, so there is no scope to report on:
			// a clean machine gets the one answer that has always meant that. The
			// scoped wording below is for services that exist somewhere else.
			console.log("No background services found.");
			return;
		}
		console.log(humanReport);
		console.log(chalk.dim("Nothing to stop in this scope."));
		return;
	}
	const admission = await acquireDaemonShutdownAdmission();
	try {
		await runShutdownConverging(json, force, () => admission.assertOrRenew(), scoped, report);
	} finally {
		await admission.release();
	}
}

async function runShutdownConverging(
	json: boolean,
	force: boolean,
	assertAdmission: () => Promise<void>,
	selection: StopSelection,
	report: ShutdownReport,
): Promise<void> {
	const sweep: ShutdownSweep = {
		report,
		verifier: createDaemonTargetVerifier(),
		handledPids: new Set<number>(),
		assertAdmission,
		force,
	};

	const daemons = (await discoverDaemons()).filter((daemon) => !isWorkerSocketPath(daemon.socketPath));
	const { selected, excluded } = selectStoppableDaemons(daemons, selection);
	report.observe(await observeScopeTargets(selection, selected));
	for (const daemon of excluded) {
		report.keep({
			...targetEntry(daemon.socketPath, daemon.pid, "service"),
			reason: selectionExclusionReason(daemon, selection) ?? "outside the requested scope",
		});
	}
	const protectedPids = protectedShutdownPids(daemons, selection);

	if (force) {
		await stopHiddenSupervisors(sweep, selection, protectedPids);
	}

	const actions = [...planShutdownAll(selected, force, selection)].sort(
		(left, right) => SHUTDOWN_ALL_ACTION_ORDER[left.kind] - SHUTDOWN_ALL_ACTION_ORDER[right.kind],
	);

	for (const action of actions) {
		const { socketPath, pid } = action.daemon;
		// A refused service keeps its workers: half-stopping a deployment whose
		// supervisor we would not touch only invites a recovery respawn.
		let refusedServiceTarget = false;
		if (pid !== undefined && sweep.handledPids.has(pid)) {
			await assertAdmission();
			if (removeSocketFileUnlessServed(socketPath)) {
				report.recordSocketRemoval(socketPath);
			}
			report.claim("stopped", {
				...targetEntry(socketPath, pid, "service"),
				action: `background service already stopped (pid ${pid})`,
			});
			if (force) {
				await stopTrackedWorkersOf(sweep, socketPath);
			}
			continue;
		}
		switch (action.kind) {
			case "remove-file": {
				if ((await probeDaemon(socketPath)).reachable) {
					const outcome = await stopBackgroundService(sweep, socketPath, pid);
					refusedServiceTarget = "left" in outcome;
					applyOutcome(outcome, socketPath, pid, report);
				} else {
					await assertAdmission();
					if (removeSocketFileUnlessServed(socketPath)) {
						report.recordSocketRemoval(socketPath);
						report.claim("stopped", {
							...targetEntry(socketPath, pid, "service"),
							action: "removed stale socket file",
						});
					} else {
						report.claim("failed", {
							...targetEntry(socketPath, pid, "service"),
							reason: "could not remove socket file: a live process still serves that path",
						});
					}
				}
				break;
			}
			case "kill": {
				if ((await probeDaemon(socketPath)).reachable) {
					const outcome = await stopBackgroundService(sweep, socketPath, pid);
					refusedServiceTarget = "left" in outcome;
					applyOutcome(outcome, socketPath, pid, report);
				} else if (pid !== undefined && isDaemonProcessListening(pid, socketPath)) {
					if (!(await verifyBeforeSignalling(sweep, { pid, socketPath }))) {
						refusedServiceTarget = true;
						break;
					}
					await assertAdmission();
					report.recordSignal(pid);
					await forceKillDaemon(pid);
					sweep.handledPids.add(pid);
					await assertAdmission();
					if (removeSocketFileUnlessServed(socketPath)) {
						report.recordSocketRemoval(socketPath);
					}
					report.recordStoppedService(socketPath);
					report.claim("stopped", {
						...targetEntry(socketPath, pid, "service"),
						action: `killed unreachable background service (pid ${pid})`,
					});
				} else {
					await assertAdmission();
					if (removeSocketFileUnlessServed(socketPath)) {
						report.recordSocketRemoval(socketPath);
					}
					report.claim("stopped", {
						...targetEntry(socketPath, pid, "service"),
						action: "background service already stopped",
					});
				}
				break;
			}
			case "shutdown": {
				const outcome = await stopBackgroundService(sweep, socketPath, pid);
				refusedServiceTarget = "left" in outcome;
				applyOutcome(outcome, socketPath, pid, report);
				break;
			}
			case "skip":
				// Deliberately left alone is not the same thing as failed, so it gets
				// its own bucket and stops turning an exit code red.
				report.claim("skipped", { ...targetEntry(socketPath, pid, "service"), reason: action.reason });
				break;
		}
		if (force && action.kind !== "skip" && !refusedServiceTarget) {
			await stopTrackedWorkersOf(sweep, socketPath);
		}
	}

	if (force) {
		await terminateVerifiedResiduals(sweep, selection, protectedPids);
		await terminateRecordedOwners(sweep, selection, protectedPids);
	}

	// The verdict is an observation, not an intention: whatever the buckets above
	// claim, the scope's socket set is checked once more on disk.
	const stillPresent = report.converge();

	if (json) {
		if (report.failed.length > 0) {
			process.exitCode = 1;
		}
		console.log(JSON.stringify({ scope: selection.scope, ...report.toJson(), stillPresent }, null, 2));
		return;
	}
	for (const entry of report.stopped) {
		console.log(chalk.green(`stopped ${describeShutdownEntry(entry)}: ${entry.action}`));
	}
	for (const entry of report.failed) {
		console.log(chalk.red(`failed  ${describeShutdownEntry(entry)}: ${entry.reason}`));
	}
	for (const entry of report.skipped) {
		console.log(chalk.dim(`kept    ${describeShutdownEntry(entry)}: ${entry.reason}`));
	}
	for (const entry of report.leftRunning) {
		console.log(chalk.dim(`left    ${describeShutdownEntry(entry)}: ${entry.reason}`));
	}
	if (report.discovered === 0) {
		console.log("No background services found.");
	}
	if (report.failed.length > 0) {
		process.exitCode = 1;
	}
}

/** Refuse before a signal, and record the refusal where the report shows it. */
async function verifyBeforeSignalling(
	sweep: ShutdownSweep,
	target: { pid: number; socketPath: string },
): Promise<boolean> {
	const verdict = await sweep.verifier.verify(target);
	if (verdict.ok) {
		return true;
	}
	sweep.report.refuse({
		...targetEntry(target.socketPath, target.pid, kindForPath(target.socketPath)),
		reason: verdict.reason,
	});
	return false;
}

/**
 * Workers of one supervisor, signalled only through their descriptor identity.
 * Their convergence is reported by the socket observation at the end, so a worker
 * that really stopped is named even though "stopping it" is not what called it.
 */
async function stopTrackedWorkersOf(sweep: ShutdownSweep, supervisorSocketPath: string): Promise<void> {
	const failures = await forceStopTrackedWorkers(supervisorSocketPath, sweep.assertAdmission, sweep.report);
	for (const failure of failures) {
		sweep.report.claim("failed", {
			...targetEntry(failure.descriptor.socketPath, failure.descriptor.pid, "worker"),
			reason: failure.reason,
		});
	}
}

async function stopHiddenSupervisors(
	sweep: ShutdownSweep,
	selection: StopSelection,
	protectedPids: ReadonlySet<number>,
): Promise<void> {
	while (true) {
		const listeners = eligibleResidualListeners(sweep, selection, protectedPids);
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
				sweep.report.claim("failed", {
					...targetEntry(socketPath, undefined, "listener"),
					reason: `could not identify the current same-path daemon among pids ${group
						.map((listener) => listener.pid)
						.sort((left, right) => left - right)
						.join(", ")}`,
				});
				continue;
			}
			hidden.push(...group.filter((listener) => listener.pid !== currentPid));
		}
		if (hidden.length === 0) {
			return;
		}
		const before = daemonListenerSignature(hidden);
		for (const listener of hidden) {
			if (await terminateVerifiedListener(sweep, listener)) {
				sweep.handledPids.add(listener.pid);
				sweep.report.claim("stopped", {
					...targetEntry(listener.socketPath, listener.pid, kindForPath(listener.socketPath)),
					action: `stopped hidden daemon (pid ${listener.pid})`,
				});
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

/**
 * The listeners this sweep may still act on: everything in scope that is not
 * protected, minus the ones already refused. A refused target is not a daemon,
 * so waiting for it to disappear would never converge — it is left running, with
 * its reason, instead of being reported as a respawning daemon.
 */
function eligibleResidualListeners(
	sweep: ShutdownSweep,
	selection: StopSelection,
	protectedPids: ReadonlySet<number>,
): DiscoveredDaemonProcess[] {
	return scopingListeningDaemons(selection).filter(
		(listener) =>
			!protectedPids.has(listener.pid) &&
			sweep.report.refusalReason(listener.socketPath, listener.pid) === undefined,
	);
}

async function terminateVerifiedResiduals(
	sweep: ShutdownSweep,
	selection: StopSelection,
	protectedPids: ReadonlySet<number>,
): Promise<void> {
	let previousSignature: string | undefined;
	let quietSince: number | undefined;
	const deadline = Date.now() + SHUTDOWN_CONVERGENCE_TIMEOUT_MS;
	while (true) {
		await sweep.assertAdmission();
		const listeners = eligibleResidualListeners(sweep, selection, protectedPids);
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
			recordResidualListenerFailures(sweep.report, listeners, "kept respawning during shutdown");
			return;
		}
		if (signature === previousSignature) {
			recordResidualListenerFailures(sweep.report, listeners, "remained after shutdown");
			return;
		}
		previousSignature = signature;
		const seenPids = new Set<number>();
		for (const listener of listeners) {
			if (seenPids.has(listener.pid)) {
				continue;
			}
			seenPids.add(listener.pid);
			const alreadyReported = sweep.handledPids.has(listener.pid);
			if (await terminateVerifiedListener(sweep, listener)) {
				sweep.handledPids.add(listener.pid);
				if (!alreadyReported) {
					sweep.report.claim("stopped", {
						...targetEntry(listener.socketPath, listener.pid, kindForPath(listener.socketPath)),
						action: `stopped residual daemon process (pid ${listener.pid})`,
					});
				}
			}
		}
	}
}

/**
 * The owner registry is the one list of daemons that survives the removal of a
 * socket file: it names a pid and that pid's process identity, not a path on
 * disk. Every other leg of a force stop enumerates listeners, so a daemon whose
 * file was unlinked underneath it — by its own predecessor's exit, or by a
 * cleanup that ran while it was still serving — used to be both unstoppable and
 * unreportable. This leg stops it by the identity the machine recorded.
 */
async function terminateRecordedOwners(
	sweep: ShutdownSweep,
	selection: StopSelection,
	protectedPids: ReadonlySet<number>,
): Promise<void> {
	for (const owner of recordedOwnersInScope(selection)) {
		if (protectedPids.has(owner.pid) || !recordedOwnerIsAlive(owner)) {
			continue;
		}
		if (sweep.report.refusalReason(owner.socketPath, owner.pid) !== undefined) {
			continue;
		}
		await sweep.assertAdmission();
		const alreadyReported = sweep.handledPids.has(owner.pid);
		if (await terminateVerifiedListener(sweep, { pid: owner.pid, socketPath: owner.socketPath })) {
			sweep.handledPids.add(owner.pid);
			if (!alreadyReported) {
				sweep.report.claim("stopped", {
					...targetEntry(owner.socketPath, owner.pid, kindForPath(owner.socketPath)),
					action: `stopped recorded daemon owner (pid ${owner.pid})`,
				});
			}
		}
	}
}

function recordResidualListenerFailures(
	report: ShutdownReport,
	listeners: readonly DiscoveredDaemonProcess[],
	reason: string,
): void {
	for (const listener of listeners) {
		const processStartId = getProcessStartId(listener.pid);
		const identity = processStartId
			? `pid ${listener.pid}, start ${processStartId}`
			: `pid ${listener.pid}, process identity unavailable`;
		report.claim("failed", {
			...targetEntry(listener.socketPath, listener.pid, kindForPath(listener.socketPath)),
			reason: `daemon ${reason} (${identity})${describeDaemonParent(listener.pid)}`,
		});
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

async function terminateVerifiedListener(sweep: ShutdownSweep, listener: DiscoveredDaemonProcess): Promise<boolean> {
	// Identity first: a process that is already gone is a convergence, not a
	// refusal, and must not be reported as a target we declined to touch.
	const processStartId = getProcessStartId(listener.pid);
	if (!processStartId) {
		if (isProcessAlive(listener.pid)) {
			sweep.report.claim("failed", {
				...targetEntry(listener.socketPath, listener.pid, kindForPath(listener.socketPath)),
				reason: `could not verify daemon process identity (pid ${listener.pid})`,
			});
		}
		return false;
	}
	if (!(await verifyBeforeSignalling(sweep, { pid: listener.pid, socketPath: listener.socketPath }))) {
		return false;
	}
	if (getProcessStartId(listener.pid) !== processStartId) {
		return false;
	}
	await sweep.assertAdmission();
	if (getProcessStartId(listener.pid) !== processStartId) {
		return false;
	}
	sweep.report.recordSignal(listener.pid);
	killDaemon(listener.pid);
	const deadline = Date.now() + 1000;
	while (getProcessStartId(listener.pid) === processStartId && Date.now() < deadline) {
		await delay(50);
	}
	if (getProcessStartId(listener.pid) === processStartId) {
		await sweep.assertAdmission();
		if (getProcessStartId(listener.pid) !== processStartId) {
			return false;
		}
		try {
			process.kill(listener.pid, "SIGKILL");
		} catch {
			// The verified process exited between the identity check and signal.
		}
	}
	const stopped = getProcessStartId(listener.pid) !== processStartId;
	if (stopped) {
		// This run is what took that service down, which is also the only thing that
		// may explain a worker of it disappearing inside the same window.
		sweep.report.recordStoppedService(listener.socketPath);
	}
	return stopped;
}

function daemonListenerSignature(listeners: readonly DiscoveredDaemonProcess[]): string {
	return listeners
		.map((listener) => `${listener.pid}:${getProcessStartId(listener.pid) ?? "unknown"}:${listener.socketPath}`)
		.sort()
		.join("\n");
}

/**
 * A worker socket is `worker-*.sock` inside a service directory: either this
 * process's own default socket dir, or a directory named `prime-agent-<uid>`.
 *
 * Only the directory a socket sits in counts as that evidence. Comparing the
 * directory *name* against the name of this process's temp dir (the parent of
 * the service dir) does not: on every machine whose `$TMPDIR` is `/tmp` — Linux,
 * CI included — it called each `/tmp/worker-*.sock` a worker socket, which hid
 * such a daemon from `ps`, from the stop plan and from the force sweeps, so
 * nothing could stop it any more.
 */
export function isWorkerSocketPath(socketPath: string): boolean {
	if (process.platform === "win32") {
		return false;
	}
	const name = basename(socketPath);
	if (!name.startsWith("worker-") || !name.endsWith(".sock")) {
		return false;
	}
	const directory = resolve(socketPath, "..");
	return directory === resolve(defaultDaemonSocketDir()) || PRIME_AGENT_SOCKET_DIR_NAME.test(basename(directory));
}

const PRIME_AGENT_SOCKET_DIR_NAME = /^prime-agent-(?:\d+|user)$/;

async function stopBackgroundService(
	sweep: ShutdownSweep,
	socketPath: string,
	pid: number | undefined,
): Promise<ReapOutcome> {
	await sweep.assertAdmission();
	if (await shutdownDaemon(socketPath, sweep.force)) {
		// The service answered a shutdown request from this run and stopped serving:
		// that is this run taking it down, and its workers go with it.
		sweep.report.recordStoppedService(socketPath);
		if (pid !== undefined) {
			sweep.handledPids.add(pid);
		}
		return { reaped: `stopped background service${pid ? ` (pid ${pid})` : ""}` };
	}
	if (!(await canConnectToSocket(socketPath, 250))) {
		await sweep.assertAdmission();
		if (removeSocketFileUnlessServed(socketPath)) {
			sweep.report.recordSocketRemoval(socketPath);
			return { reaped: "background service already stopped" };
		}
		// Nothing answers on that path, but a live process still holds the socket: the
		// file is gone and the daemon is not. "Already stopped" would be a lie, and no
		// path-based sweep can reach it any more, so the recorded pid is the target.
		if (pid === undefined) {
			return { skipped: "socket file is gone but a process still holds it, and no pid is known" };
		}
		if (!sweep.force) {
			return { skipped: "socket file is gone but a process still holds it; retry with --force" };
		}
		if (!(await verifyBeforeSignalling(sweep, { pid, socketPath }))) {
			return { left: sweep.report.refusalReason(socketPath, pid) ?? "not a verified daemon" };
		}
		await sweep.assertAdmission();
		sweep.report.recordSignal(pid);
		await forceKillDaemon(pid);
		sweep.handledPids.add(pid);
		sweep.report.recordStoppedService(socketPath);
		return { reaped: `force-killed the process holding a removed socket (pid ${pid})` };
	}
	if (pid === undefined) {
		return { skipped: "still listening but no pid to kill" };
	}
	if (!sweep.force) {
		return { skipped: "did not stop gracefully; retry with --force" };
	}
	// The graceful request reached *something* on that socket, but only a verified
	// daemon may be signalled: a stale socket a stranger listens on is not ours.
	if (!(await verifyBeforeSignalling(sweep, { pid, socketPath }))) {
		return { left: sweep.report.refusalReason(socketPath, pid) ?? "not a verified daemon" };
	}
	await sweep.assertAdmission();
	sweep.report.recordSignal(pid);
	await forceKillDaemon(pid);
	sweep.handledPids.add(pid);
	await sweep.assertAdmission();
	if (removeSocketFileUnlessServed(socketPath)) {
		sweep.report.recordSocketRemoval(socketPath);
	}
	sweep.report.recordStoppedService(socketPath);
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

/** A worker this sweep could not stop, named by the worker it is about. */
export interface TrackedWorkerFailure {
	descriptor: DaemonWorkerDescriptor;
	reason: string;
}

/** The stop path needs only these two ledger facts from a stop report (DS-4). */
export interface TrackedWorkerStopLedger {
	recordSignal(pid: number): void;
	recordSocketRemoval(socketPath: string): void;
}

async function forceStopTrackedWorkers(
	supervisorSocketPath: string,
	assertAdmission: () => Promise<void>,
	ledger: TrackedWorkerStopLedger,
): Promise<TrackedWorkerFailure[]> {
	const failures: TrackedWorkerFailure[] = [];
	const fail = (descriptor: DaemonWorkerDescriptor, reason: string): void => {
		failures.push({ descriptor, reason });
	};
	// Every signal this sweep really sends is written into the report ledger, so the
	// convergence pass at the end may call a vanished worker a stop this run performed.
	const stopWithLedger = (pid: number, startId: string | undefined): Promise<boolean> =>
		stopTrackedProcess(pid, startId, assertAdmission, () => ledger.recordSignal(pid));
	for (const worker of findTrackedWorkers(supervisorSocketPath)) {
		const { descriptor } = worker;
		let cleanupWorkerRecords = await stopWithLedger(descriptor.pid, descriptor.processStartId);
		if (!cleanupWorkerRecords) {
			fail(descriptor, `could not safely stop worker ${descriptor.workerId} (pid ${descriptor.pid})`);
		}
		if (descriptor.orphanProcessJournalPath) {
			let orphans: ReturnType<typeof readActiveOrphanProcesses> = [];
			try {
				orphans = readActiveOrphanProcesses(descriptor.orphanProcessJournalPath, descriptor.pid);
			} catch (error) {
				fail(
					descriptor,
					`could not read child process records for worker ${descriptor.workerId}: ${String(error)}`,
				);
			}
			for (const orphan of orphans) {
				// Pid-only records go through the platform predicate (stopTrackedProcess needs a startId).
				if (orphan.processStartId === undefined) {
					if (shouldReapOrphanProcess(orphan)) {
						ledger.recordSignal(orphan.pid);
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
						ledger.recordSignal(orphan.pid);
						killOrphanProcess(orphan.pid);
						if (isProcessAlive(orphan.pid)) {
							cleanupWorkerRecords = false;
							fail(descriptor, `could not stop child process ${orphan.pid} for worker ${descriptor.workerId}`);
						}
					}
					continue;
				}
				if (!(await stopWithLedger(orphan.pid, orphan.processStartId))) {
					cleanupWorkerRecords = false;
					fail(descriptor, `could not stop child process ${orphan.pid} for worker ${descriptor.workerId}`);
				}
			}
		}
		if (cleanupWorkerRecords) {
			const cleanup = removeTrackedWorkerRecords(worker);
			if (cleanup) {
				fail(descriptor, `could not clean up worker ${descriptor.workerId}: ${cleanup}`);
			} else {
				// Its records are gone and with them the socket file this worker held.
				ledger.recordSocketRemoval(descriptor.socketPath);
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
	onSignal?: () => void,
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
	onSignal?.();
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
	onSignal?.();
	signalProcessGroupOrProcess(pid, "SIGKILL");
	deadline = Date.now() + 1000;
	while (isProcessAlive(pid) && Date.now() < deadline) {
		await delay(25);
	}
	return !isProcessAlive(pid);
}

/**
 * `doctor --fix` cleanup. Scoped by default to the services this process owns,
 * with `--dry-run` to list each target first and `--orphans` to refuse every
 * service that still carries live evidence.
 */
export async function runReap(
	json: boolean,
	force: boolean,
	selection: StopSelection = { scope: { kind: "current" }, orphansOnly: false },
	dryRun = false,
): Promise<void> {
	// A stop command has to know what this process owns before it plans anything:
	// the registry leg of the default scope is async, so it is bound once here and
	// every pure plan below sees the same concrete set.
	const scoped = await bindStopSelection(selection);
	const daemons = await discoverDaemons();
	const reaped: Array<{ socketPath: string; action: string }> = [];
	const skipped: Array<{ socketPath: string; reason: string }> = [];
	const verifier = createDaemonTargetVerifier();
	const actions = planReap(daemons, force, scoped);
	const workers = findAllTrackedWorkers();
	const servedSockets = new Set(
		daemons
			.filter((daemon) => daemon.pid !== undefined || daemon.liveness !== "unknown")
			.map((daemon) => daemon.socketPath),
	);
	const orphanWorkers = planOrphanWorkerReap(
		workers.map((worker) => worker.descriptor),
		servedSockets,
		{ selection: scoped, processAlive: isProcessAlive, identityMatches: defaultIdentityMatches },
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
			console.log(JSON.stringify({ dryRun: true, scope: scoped.scope, plan }, null, 2));
			return;
		}
		console.log(`Cleanup plan for ${describeShutdownScope(scoped.scope)}; nothing was touched.`);
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
					// `doctor --fix` is a sweep path too: the same "prove it is a daemon
					// before signalling" gate applies, and a refusal is not scrap.
					const verdict = await verifier.verify({ pid: pid!, socketPath });
					if (!verdict.ok) {
						skipped.push({ socketPath, reason: verdict.reason });
						break;
					}
					// Stop the tracked workers before the kill, the way `shutdown --force`
					// does after its own: killing an unreachable supervisor first would
					// leave its workers orphaned, which is what made `reap --force`
					// refuse where `shutdown --force` killed (DS-4).
					const workerFailures = await forceStopTrackedWorkers(socketPath, async () => {}, {
						recordSignal: () => undefined,
						recordSocketRemoval: () => undefined,
					});
					if (workerFailures.length > 0) {
						skipped.push({
							socketPath,
							reason: `unreachable; could not stop its worker process(es) safely: ${workerFailures
								.map((failure) => failure.reason)
								.join("; ")}`,
						});
						break;
					}
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
		console.log(JSON.stringify({ scope: scoped.scope, reaped, skipped }, null, 2));
		return;
	}
	if (reaped.length === 0 && skipped.length === 0) {
		if (daemons.length === 0 && workers.length === 0) {
			// Nothing was discovered anywhere, so there is no scope to report on:
			// a clean machine gets the one answer that has always meant that. The
			// scoped wording below is for services that exist somewhere else.
			console.log("No background services found.");
		} else {
			console.log(`No background services found in scope: ${describeShutdownScope(scoped.scope)}`);
		}
		return;
	}
	for (const entry of reaped) {
		console.log(chalk.green(`reaped ${entry.socketPath}: ${entry.action}`));
	}
	for (const entry of skipped) {
		console.log(chalk.dim(`kept   ${entry.socketPath}: ${entry.reason}`));
	}
}

type ReapOutcome = { reaped: string } | { skipped: string } | { left: string };

function apply(
	outcome: ReapOutcome,
	socketPath: string,
	reaped: Array<{ socketPath: string; action: string }>,
	skipped: Array<{ socketPath: string; reason: string }>,
): void {
	if ("reaped" in outcome) {
		reaped.push({ socketPath, action: outcome.reaped });
	} else if ("skipped" in outcome) {
		skipped.push({ socketPath, reason: outcome.skipped });
	} else {
		// A refused signal is not a failure and not a cleanup: it stays running.
		skipped.push({ socketPath, reason: outcome.left });
	}
}

/** Route one service outcome into the four-bucket stop report. */
function applyOutcome(outcome: ReapOutcome, socketPath: string, pid: number | undefined, report: ShutdownReport): void {
	const target = targetEntry(socketPath, pid, "service");
	if ("reaped" in outcome) {
		report.claim("stopped", { ...target, action: outcome.reaped });
	} else if ("skipped" in outcome) {
		report.claim("skipped", { ...target, reason: outcome.skipped });
	} else {
		report.claim("leftRunning", { ...target, reason: outcome.left });
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

/**
 * A socket file may only be unlinked when nothing live is serving that path any
 * more. Removing it under a live owner is what made that owner impossible to
 * stop: every later sweep reasons from the path, and the path no longer exists.
 * Returns false when a live listener kept the file, so no caller may report the
 * removal as a stop.
 */
function removeSocketFileUnlessServed(socketPath: string): boolean {
	const normalized = normalizeSocketPath(socketPath);
	const served = scanListeningDaemons().some(
		(listener) => listener.socketPath === normalized && isProcessAlive(listener.pid),
	);
	if (served) {
		return false;
	}
	return removeSocketFile(socketPath);
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
