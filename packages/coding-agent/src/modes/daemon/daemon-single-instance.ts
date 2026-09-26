import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { DaemonSocketInUseError, isDaemonSocketListening, normalizeSocketPath } from "./daemon-socket.js";
import {
	DaemonAgentDirAlreadyRunningError,
	DaemonSupervisorAlreadyRunningError,
	readRecordedDaemonSocketOwners,
} from "./daemon-supervisor-ownership.js";

/**
 * W2 single-instance policy: how a supervisor-mode process should treat a
 * socket path before (and after) trying to bind it.
 *
 * Prior art: PM2's client ping-pongs between `pingDaemon` and daemon start
 * instead of failing; ollama's CLI reuses a live server via heartbeat. The old
 * behavior here — throw, exit 1, let the service manager relaunch into the
 * same collision every ThrottleInterval — was the launchd idle-retry spin.
 */
export type DaemonSocketOccupancy = "absent" | "listening" | "unresponsive";

export interface DaemonSocketOccupancyProbe {
	kind: DaemonSocketOccupancy;
	/** True when connect succeeded at least once: a daemon is bound right now. */
	connects: boolean;
}

export interface OccupancyProbeOptions {
	/**
	 * Consecutive failed connect attempts (with a file present) before a socket
	 * is called unresponsive. 3 matches supervisor-availability's probe ladder.
	 */
	attempts?: number;
	probeTimeoutMs?: number;
	intervalMs?: number;
	connect?: (socketPath: string, timeoutMs: number) => Promise<boolean>;
	sleep?: (ms: number) => Promise<void>;
	exists?: (socketPath: string) => boolean;
}

function defaultConnect(socketPath: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (connected: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(connected);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Classify who owns `socketPath`:
 * - "absent": no socket file — free to bind.
 * - "listening": a connection succeeds. A booting daemon counts as present
 *   (same semantics as `isDaemonSocketListening`): we never race a live daemon.
 * - "unresponsive": the file exists but nothing accepts, across `attempts`
 *   consecutive probes — a stale socket a lease holder may unlink and take
 *   over (see prepareDaemonSocketPath).
 */
export async function judgeDaemonSocketOccupancy(
	socketPath: string,
	options: OccupancyProbeOptions = {},
): Promise<DaemonSocketOccupancyProbe> {
	if (process.platform === "win32") {
		// Named pipes have no filesystem presence to classify; the lease and the
		// registry remain the single-instance source of truth.
		return { kind: "absent", connects: false };
	}
	const attempts = options.attempts ?? 3;
	const connect = options.connect ?? defaultConnect;
	const sleep = options.sleep ?? defaultSleep;
	const exists = options.exists ?? ((p: string) => existsSync(p));
	const timeoutMs = options.probeTimeoutMs ?? 250;
	const intervalMs = options.intervalMs ?? 250;

	if (!exists(socketPath)) {
		return { kind: "absent", connects: false };
	}
	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (await connect(socketPath, timeoutMs)) {
			return { kind: "listening", connects: true };
		}
		if (attempt < attempts) {
			await sleep(intervalMs);
		}
	}
	return { kind: "unresponsive", connects: false };
}

/**
 * Which startup failures mean "someone else legitimately owns the single
 * instance" (a supervisor-mode process should downgrade to standby) versus
 * everything else (real failures: propagate).
 */
export function isDaemonSingleInstanceConflict(error: unknown, socketPath?: string): boolean {
	if (
		error instanceof DaemonSocketInUseError ||
		error instanceof DaemonSupervisorAlreadyRunningError ||
		error instanceof DaemonAgentDirAlreadyRunningError
	) {
		return true;
	}
	// N1 (R1): a live lease holder that has not bound yet. proper-lockfile's
	// ELOCKED ("Lock file is already being held") means another process holds
	// the socket-path lease right now — the pre-bind half of the same
	// single-instance collision the listening branch already handles. Left
	// unclassified it propagated as an uncaught exception and the service
	// manager (launchd KeepAlive + ThrottleInterval) relaunch into the same
	// collision every interval: exactly the idle-retry spin this PR removes.
	// The `file` check keeps an ELOCKED from an unrelated lock from being
	// misread as this socket's conflict.
	return isSocketPathLeaseHeld(error, socketPath);
}

function isSocketPathLeaseHeld(error: unknown, socketPath?: string): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	const candidate = error as { code?: unknown; file?: unknown };
	if (candidate.code !== "ELOCKED" || typeof candidate.file !== "string") {
		return false;
	}
	if (socketPath === undefined) {
		return true;
	}
	return normalizeSocketPath(candidate.file) === normalizeSocketPath(socketPath);
}

export interface DaemonStandbyOwner {
	/** The owning supervisor's socket, when known (registry or error payload). */
	socketPath?: string;
	/** The owning supervisor's pid, when known. */
	pid?: number;
	generation?: string;
}

export interface DaemonStandbyOptions {
	/** The socket this process wanted to bind. */
	socketPath: string;
	/** Owner summary, when the conflict error or a probe carried one. */
	owner?: DaemonStandbyOwner;
	/** Poll interval for owner liveness. Default 5s. */
	pollMs?: number;
	/** Test harness bound on poll iterations; default unlimited. */
	maxPolls?: number;
	/** Injectable liveness probes for tests. */
	isSocketListening?: (socketPath: string) => Promise<boolean>;
	readOwners?: () => DaemonStandbyOwner[];
	isProcessAlive?: (pid: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
	log?: (message: string) => void;
	/**
	 * Called once the owner is gone; the default exits with 1 so a service
	 * manager (launchd KeepAlive in both flavors, systemd restart) relaunches
	 * this process, which then binds the now-free socket.
	 */
	onOwnerGone?: () => void;
}

const isProcessAliveDefault = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is not ours; that is still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/**
 * Standby (client downgrade): stay alive watching the owning daemon, never
 * holding the socket lease, the registry or the roster snapshot. Exits (via
 * `onOwnerGone`, default `process.exit(1)`) once the owner is gone: a
 * listening socket with a dead pid is waited out, a live pid is waited out, and
 * a socket with no record at all is watched until it goes silent.
 *
 * Injected probes (`readOwners`, `isSocketListening`, `isProcessAlive`,
 * `sleep`) make the loop unit-testable without real processes.
 */
export async function runDaemonStandby(options: DaemonStandbyOptions): Promise<void> {
	const pollMs = options.pollMs ?? 5_000;
	const sleep = options.sleep ?? defaultSleep;
	const isSocketListening = options.isSocketListening ?? isDaemonSocketListening;
	const isProcessAlive = options.isProcessAlive ?? isProcessAliveDefault;
	const log = options.log ?? ((message: string) => console.log(message));
	const readOwners = options.readOwners ?? (() => readRecordedDaemonSocketOwners());

	const target = normalizeSocketPath(options.socketPath);
	const describeOwner = (): string => {
		const owner = options.owner;
		if (owner?.pid !== undefined) {
			return `pid ${owner.pid}${owner.generation ? ` (${owner.generation})` : ""}`;
		}
		return "another daemon";
	};
	log(
		`Daemon socket ${target} is owned by ${describeOwner()}; this process is standing by as a client and will exit for relaunch when the owner is gone.`,
	);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		await sleep(pollMs);

		const records = safeReadOwners(readOwners);
		if (options.maxPolls !== undefined) {
			options.maxPolls--;
			if (options.maxPolls < 0) {
				return;
			}
		}
		const ownerRecord = records.find(
			(record) =>
				(record.socketPath !== undefined && normalizeSocketPath(record.socketPath) === target) ||
				(options.owner?.pid !== undefined && record.pid === options.owner.pid),
		);
		const watchedPid = ownerRecord?.pid ?? options.owner?.pid;
		if (watchedPid !== undefined && isProcessAlive(watchedPid)) {
			continue;
		}
		// Pid gone (or never known): only leave when the socket is silent too —
		// a bound-but-recordless daemon is still the single instance.
		if (await isSocketListening(target)) {
			continue;
		}
		log(
			`Daemon owner for ${target} is gone; exiting so the service manager relaunches this process to bind the socket.`,
		);
		(options.onOwnerGone ?? (() => process.exit(1)))();
		return;
	}
}

function safeReadOwners(readOwners: () => DaemonStandbyOwner[]): DaemonStandbyOwner[] {
	try {
		return readOwners();
	} catch {
		return [];
	}
}
