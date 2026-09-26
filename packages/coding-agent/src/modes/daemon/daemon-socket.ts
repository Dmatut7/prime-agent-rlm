import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { queryWindowsUserSid, restrictWindowsNamedPipeAccess, windowsDaemonPipePath } from "./windows-named-pipe.js";

export { normalizeSocketPath } from "../../utils/daemon-socket-path.js";
export { daemonIpcListenOptions } from "./windows-named-pipe.js";

/**
 * Test/operator override for the default daemon socket directory. Internal, and
 * the same shape as `PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR`: the
 * stable default now lives under `$HOME`, so a test that spawns real daemons
 * must be able to pin the directory instead of writing into the developer's
 * `~/.prime/daemon`. Read on every call (never cached) so a test can set it
 * after import.
 */
export const DAEMON_SOCKET_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR";

const DAEMON_SOCKET_MODE = 0o600;
const DAEMON_SOCKET_DIR_MODE = 0o700;
const DAEMON_SOCKET_RELEASE_GRACE_MS = 1000;
const DAEMON_SOCKET_RELEASE_POLL_MS = 25;
const DAEMON_SOCKET_LOCK_STALE_MS = 5000;
const DAEMON_SOCKET_LOCK_UPDATE_MS = 1000;

type DaemonSocketCompromiseListener = (error: Error) => void;

export class DaemonSocketPathLease {
	private released = false;
	private compromisedError?: Error;
	private readonly compromiseListeners = new Set<DaemonSocketCompromiseListener>();

	constructor(
		readonly socketPath: string,
		private readonly releaseLock: () => Promise<void>,
	) {}

	get compromise(): Error | undefined {
		return this.compromisedError;
	}

	onCompromised(listener: DaemonSocketCompromiseListener): () => void {
		if (this.compromisedError) {
			this.notifyCompromiseListener(listener, this.compromisedError);
			return () => {};
		}
		this.compromiseListeners.add(listener);
		return () => this.compromiseListeners.delete(listener);
	}

	recordCompromise(error: Error): void {
		if (this.compromisedError) return;
		this.compromisedError = error;
		const listeners = [...this.compromiseListeners];
		this.compromiseListeners.clear();
		for (const listener of listeners) this.notifyCompromiseListener(listener, error);
	}

	async release(): Promise<void> {
		if (this.released) return;
		this.released = true;
		this.compromiseListeners.clear();
		await this.releaseLock();
	}

	private notifyCompromiseListener(listener: DaemonSocketCompromiseListener, error: Error): void {
		try {
			listener(error);
		} catch {
			// A lease callback must not rethrow from proper-lockfile's refresh callback.
		}
	}
}

export interface DaemonSocketIdentity {
	dev: number;
	ino: number;
}

export function defaultDaemonSocketPath(): string {
	if (process.platform === "win32") {
		return windowsDaemonPipePath(queryWindowsUserSid());
	}
	return join(defaultDaemonSocketDir(), "daemon.sock");
}

export async function acquireDaemonSocketPathLease(socketPath: string): Promise<DaemonSocketPathLease | undefined> {
	ensureDefaultDaemonSocketDir(socketPath);
	if (process.platform === "win32") {
		return undefined;
	}
	let lease: DaemonSocketPathLease | undefined;
	let pendingCompromise: Error | undefined;
	const releaseLock = await lockfile.lock(socketPath, {
		realpath: false,
		stale: DAEMON_SOCKET_LOCK_STALE_MS,
		update: DAEMON_SOCKET_LOCK_UPDATE_MS,
		onCompromised: (error) => {
			if (lease) lease.recordCompromise(error);
			else pendingCompromise = error;
		},
		retries: {
			retries: 600,
			factor: 1,
			minTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
			maxTimeout: DAEMON_SOCKET_RELEASE_POLL_MS,
		},
	});
	lease = new DaemonSocketPathLease(socketPath, releaseLock);
	if (pendingCompromise) lease.recordCompromise(pendingCompromise);
	return lease;
}

/**
 * Typed "another daemon owns this socket" failure from socket preparation.
 * Same message as before (log greppers keep working); carries the path so a
 * supervisor-mode launcher can downgrade to standby without parsing text.
 */
export class DaemonSocketInUseError extends Error {
	readonly socketPath: string;

	constructor(socketPath: string) {
		super(`Daemon socket already in use: ${socketPath}`);
		this.name = "DaemonSocketInUseError";
		this.socketPath = socketPath;
	}
}

export async function prepareDaemonSocketPath(socketPath: string, lease?: DaemonSocketPathLease): Promise<void> {
	ensureDefaultDaemonSocketDir(socketPath);

	if (process.platform === "win32") {
		return;
	}
	if (lease) {
		assertSocketLease(socketPath, lease);
		assertSocketLeaseHeld(socketPath, lease);
		await prepareUnixDaemonSocketPath(socketPath, lease);
		return;
	}
	if (!existsSync(socketPath)) {
		return;
	}
	if (await canConnectToUnixSocket(socketPath)) {
		throw new DaemonSocketInUseError(socketPath);
	}
	const ownedLease = await acquireDaemonSocketPathLease(socketPath);
	try {
		await prepareUnixDaemonSocketPath(socketPath, ownedLease);
	} finally {
		await ownedLease?.release();
	}
}

async function prepareUnixDaemonSocketPath(socketPath: string, lease?: DaemonSocketPathLease): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}

	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		throw error;
	}
	if (!stat.isSocket()) {
		throw new Error(`Daemon socket path exists and is not a socket: ${socketPath}`);
	}

	const staleIdentity: DaemonSocketIdentity = { dev: stat.dev, ino: stat.ino };
	if (await canConnectToUnixSocket(socketPath)) {
		throw new DaemonSocketInUseError(socketPath);
	}
	const deadline = Date.now() + DAEMON_SOCKET_RELEASE_GRACE_MS;
	while (Date.now() < deadline) {
		await delay(DAEMON_SOCKET_RELEASE_POLL_MS);
		if (!existsSync(socketPath)) {
			return;
		}
		let currentIdentity: DaemonSocketIdentity | undefined;
		try {
			currentIdentity = getDaemonSocketIdentity(socketPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		if (!currentIdentity || currentIdentity.dev !== staleIdentity.dev || currentIdentity.ino !== staleIdentity.ino) {
			throw new Error(`Daemon socket changed ownership while waiting for cleanup: ${socketPath}`);
		}
		if (await canConnectToUnixSocket(socketPath)) {
			throw new DaemonSocketInUseError(socketPath);
		}
	}

	if (lease) assertSocketLeaseHeld(socketPath, lease);
	unlinkSync(socketPath);
}

export function restrictDaemonSocketPath(socketPath: string): void {
	if (process.platform === "win32") {
		restrictWindowsNamedPipeAccess(socketPath);
		return;
	}
	chmodSync(socketPath, DAEMON_SOCKET_MODE);
}

export function getDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | undefined {
	if (process.platform === "win32") {
		return undefined;
	}
	const stat = lstatSync(socketPath);
	return { dev: stat.dev, ino: stat.ino };
}

export function cleanupDaemonSocketPath(
	socketPath: string,
	expectedIdentity?: DaemonSocketIdentity,
	lease?: DaemonSocketPathLease,
): void {
	if (process.platform === "win32") {
		return;
	}
	if (lease) {
		assertSocketLease(socketPath, lease);
		if (lease.compromise) {
			return;
		}
		try {
			cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
		} catch {
			// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
		}
		return;
	}
	let releaseLock: (() => void) | undefined;
	let lockCompromised = false;
	try {
		releaseLock = lockfile.lockSync(socketPath, {
			realpath: false,
			stale: DAEMON_SOCKET_LOCK_STALE_MS,
			update: DAEMON_SOCKET_LOCK_UPDATE_MS,
			onCompromised: () => {
				lockCompromised = true;
			},
			retries: 0,
		});
	} catch {
		return;
	}
	if (lockCompromised) {
		try {
			releaseLock();
		} catch {
			// Best effort release.
		}
		return;
	}
	try {
		cleanupUnixDaemonSocketPath(socketPath, expectedIdentity);
	} catch {
		// Best effort cleanup; shutdown should not be blocked by socket unlink failures.
	} finally {
		try {
			releaseLock();
		} catch {
			// Best effort cleanup; a failed release is recoverable as a stale lock.
		}
	}
}

function cleanupUnixDaemonSocketPath(socketPath: string, expectedIdentity?: DaemonSocketIdentity): void {
	if (!existsSync(socketPath)) {
		return;
	}
	if (expectedIdentity) {
		const currentIdentity = getDaemonSocketIdentity(socketPath);
		if (
			!currentIdentity ||
			currentIdentity.dev !== expectedIdentity.dev ||
			currentIdentity.ino !== expectedIdentity.ino
		) {
			return;
		}
	}
	unlinkSync(socketPath);
}

function assertSocketLease(socketPath: string, lease: DaemonSocketPathLease): void {
	if (lease.socketPath !== socketPath) {
		throw new Error(`Daemon socket lease does not match ${socketPath}`);
	}
}

function assertSocketLeaseHeld(socketPath: string, lease: DaemonSocketPathLease): void {
	if (lease.compromise) {
		throw new Error(`Daemon socket lease for ${socketPath} was compromised: ${lease.compromise.message}`);
	}
}

/**
 * The stable, per-user daemon socket directory.
 *
 * PM2 keeps its daemon sockets in `$PM2_HOME`; ollama keeps its pid file in
 * `~/Library/Application Support/Ollama`. Both deliberately avoid the system
 * temp directory, and this now does the same: `$TMPDIR` names a *shell*, not a
 * machine — launchd sessions, manual shells and tools that inject `TMPDIR` each
 * resolve a different path, so consecutive supervisor generations bound
 * different sockets, keyed their worker descriptor dirs off those paths, and
 * each generation adopted none of its predecessor's workers (the roster
 * fragmentation). macOS dirhelper also deletes `$TMPDIR` files after three
 * days. A home-owned directory is stable across all of those, and matches the
 * supervisor registry, which already lives outside `$TMPDIR` for the same
 * reasons (`~/.prime/supervisor-owners`).
 */
export function defaultDaemonSocketDir(): string {
	const override = process.env[DAEMON_SOCKET_DIR_ENV];
	if (override) {
		return resolve(override);
	}
	if (process.platform === "win32") {
		// Windows named pipes never touch the filesystem; keep a stable answer anyway.
		return join(homedir(), ".prime", "daemon");
	}
	return join(stableHomeDaemonRoot(), "daemon");
}

/**
 * The pre-stable default directory, `$TMPDIR/prime-agent-<uid>`, kept readable
 * (never created) so legacy state can be found: the read-only legacy supervisor
 * registry, worker descriptor dirs keyed on the legacy socket path, and tests.
 * New daemons never bind sockets here.
 */
export function legacyDaemonSocketDir(): string {
	const suffix = typeof process.getuid === "function" ? String(process.getuid()) : "user";
	return join(tmpdir(), `prime-agent-${suffix}`);
}

/**
 * The legacy default socket path (`$TMPDIR/prime-agent-<uid>/daemon.sock`):
 * where daemons from before the stable-path change are listening today.
 * Read-only reference for migration and discovery tests.
 */
export function legacyDefaultDaemonSocketPath(): string {
	if (process.platform === "win32") {
		return windowsDaemonPipePath(queryWindowsUserSid());
	}
	return join(legacyDaemonSocketDir(), "daemon.sock");
}

function stableHomeDaemonRoot(): string {
	try {
		const home = homedir();
		if (home && home !== "/") {
			return join(home, ".prime");
		}
	} catch {
		// homedir() itself is only expected to throw in exotic embedders; fall through.
	}
	// No usable home (sandboxed runner): the legacy per-user temp dir is the
	// only stable directory we can still compute.
	return legacyDaemonSocketDir();
}

function ensureDefaultDaemonSocketDir(socketPath: string): void {
	if (process.platform === "win32") {
		return;
	}
	const dir = dirname(socketPath);
	if (dir !== defaultDaemonSocketDir() && dir !== legacyDaemonSocketDir()) {
		return;
	}

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: DAEMON_SOCKET_DIR_MODE });
	}

	const stat = lstatSync(dir);
	if (!stat.isDirectory()) {
		throw new Error(`Daemon socket directory exists and is not a directory: ${dir}`);
	}

	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error(`Daemon socket directory is not owned by the current user: ${dir}`);
	}

	chmodSync(dir, DAEMON_SOCKET_DIR_MODE);
}

/**
 * True when something accepts a connection on `socketPath`.
 *
 * Deliberately weaker than a handshake: this answers "is a daemon process bound
 * here", which is what an agent-dir-scoped client needs before deciding whether
 * to reuse an endpoint or to start one of its own. A daemon that is still
 * booting counts as present, so no client ever races a live daemon into a
 * duplicate.
 */
export function isDaemonSocketListening(socketPath: string): Promise<boolean> {
	return canConnectToUnixSocket(socketPath);
}

function canConnectToUnixSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		const finish = (canConnect: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(canConnect);
		};

		timeoutId = setTimeout(() => finish(false), 250);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
