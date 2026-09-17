import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { getProcessStartId } from "../../core/session-lease.js";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";
import { defaultDaemonSocketDir, normalizeSocketPath } from "./daemon-socket.js";

const DAEMON_SUPERVISOR_REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

const structuredLog = getLogger("coding-agent.daemon.supervisor-ownership");

const OWNER_VERSION = 1;
const REGISTRY_LOCK_STALE_MS = 5000;
const REGISTRY_LOCK_UPDATE_MS = 1000;
const REGISTRY_LOCK_RETRIES = 500;
const REGISTRY_LOCK_RETRY_MS = 10;
const STARTUP_FENCE_POLL_MS = 250;
const SHUTDOWN_ADMISSION_FILE_NAME = "shutdown-admission.json";
const SHUTDOWN_ADMISSION_LEASE_MS = 5000;
const SHUTDOWN_ADMISSION_REFRESH_MS = 1000;
const SHUTDOWN_ADMISSION_WAIT_MS = 50;
/**
 * A waiter refuses instead of hanging forever once a live holder has been silent
 * for this long: two processes must never run shutdown work at once, so waiting is
 * the only safe move, but an unbounded wait turns a wedged holder into a wedged
 * shutdown command with nothing to read.
 */
const SHUTDOWN_ADMISSION_WAIT_TIMEOUT_MS = 60_000;
/** Retries for a renewal that failed on the registry guard or the filesystem, not on ownership. */
const RENEWAL_RETRY_ATTEMPTS = 3;
const RENEWAL_RETRY_MS = 50;

type DaemonSupervisorOwnerPhase = "starting" | "owner" | "stopping";

interface ProcessIdentity {
	pid: number;
	processStartId?: string;
}

interface DaemonSupervisorOwnerRecord extends ProcessIdentity {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
	appVersion: string;
	phase: DaemonSupervisorOwnerPhase;
	createdAt: string;
	updatedAt: string;
}

/**
 * Presence of the record is the ticket; `expiresAt` is the holder's renewal
 * obligation, not a licence to hand the ticket on. A record whose process is
 * alive keeps the ticket even while its lease has lapsed — a lapsed lease says
 * the holder could not run its timer, and the alternative (a second process
 * starting shutdown work while the first one is still inside it) is exactly the
 * overlap this ticket exists to prevent.
 */
interface DaemonShutdownAdmissionRecord extends ProcessIdentity {
	version: 1;
	token: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

interface DaemonSupervisorOwnerScope {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	socketPath: string;
	descriptorDir: string;
}

interface DaemonStartupFenceRecord extends ProcessIdentity {
	version: 1;
	token: string;
	ownerToken: string;
	socketPath: string;
	supervisorGeneration: string;
	createdAt: string;
}

interface DaemonSupervisorHelloIdentity {
	supervisorGeneration?: string;
	supervisorOwnerToken?: string;
	supervisorPid?: number;
	supervisorProcessStartId?: string;
	supervisorSocketPath?: string;
}

interface AcquireDaemonSupervisorOwnershipOptions {
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
	generation: string;
	appVersion: string;
	registryDir?: string;
}

class DaemonSupervisorAlreadyRunningError extends Error {
	readonly code = "daemon_supervisor_already_running" as const;

	constructor(readonly owner: DaemonSupervisorOwnerRecord) {
		super(`Daemon supervisor ${owner.generation} already owns ${owner.socketPath}`);
		this.name = "DaemonSupervisorAlreadyRunningError";
	}
}

class DaemonSupervisorOwnershipLostError extends Error {
	readonly code = "supervisor_generation_stale" as const;

	constructor(generation: string, details: { socketPath?: string; registryDir?: string } = {}) {
		const context = [
			details.socketPath ? `socket: ${details.socketPath}` : undefined,
			details.registryDir ? `registry: ${details.registryDir}` : undefined,
		].filter((part) => part !== undefined);
		super(
			`Daemon supervisor generation ${generation} no longer owns its registry entry ` +
				`(record on disk is missing or was replaced)${context.length > 0 ? `; ${context.join("; ")}` : ""}; ` +
				"restart the daemon to recover — sessions are preserved",
		);
		this.name = "DaemonSupervisorOwnershipLostError";
	}
}

class DaemonShutdownAdmissionError extends Error {
	readonly code = "daemon_shutdown_in_progress" as const;

	constructor(message = "Daemon shutdown is in progress") {
		super(message);
		this.name = "DaemonShutdownAdmissionError";
	}
}

/**
 * Owns a lease-renew loop safely: the unref()'d interval, single-flight
 * refresh dedup shared by timer-fired and direct calls, and lost-state fencing.
 *
 * Only an authoritative refusal is permanent. A failure of the registry guard or
 * of the filesystem is not: it says nothing about who owns the record on disk, and
 * burning the ticket over it is how a single stall — a machine sleep, a
 * synchronous `ps`/`lsof` fork, a guard that changed hands while the event loop
 * was frozen — used to cost the holder its admission for the rest of its life.
 */
class RenewableRegistryRecord {
	private stopped = false;
	private lost = false;
	private refreshPromise?: Promise<void>;
	private readonly refreshTimer: ReturnType<typeof setInterval>;

	constructor(
		private readonly registryDir: string,
		refreshMs: number,
		private readonly renewUnderGuard: () => void,
		private readonly createLostError: () => Error,
		private readonly isRefusal: (error: unknown) => boolean = () => false,
	) {
		this.refreshTimer = setInterval(() => {
			void this.assertOrRenew().catch(() => undefined);
		}, refreshMs);
		this.refreshTimer.unref();
	}

	async assertOrRenew(): Promise<void> {
		if (this.stopped || this.lost) {
			throw this.createLostError();
		}
		this.refreshPromise ??= this.performRenew().finally(() => {
			this.refreshPromise = undefined;
		});
		await this.refreshPromise;
	}

	private async performRenew(): Promise<void> {
		for (let attempt = 1; ; attempt++) {
			try {
				await withDaemonSupervisorRegistryGuard(this.registryDir, () => {
					// stop() may have completed while this call waited on the guard;
					// a stopped record must never be rewritten to disk.
					if (this.stopped || this.lost) {
						throw this.createLostError();
					}
					this.renewUnderGuard();
				});
				return;
			} catch (error) {
				if (this.isRefusal(error)) {
					this.lost = true;
					clearInterval(this.refreshTimer);
					throw error;
				}
				// Transient: retry, and leave the interval running even if every attempt
				// fails, so the next tick renews the ticket this process still owns.
				if (attempt >= RENEWAL_RETRY_ATTEMPTS) {
					throw error;
				}
				await delay(RENEWAL_RETRY_MS);
			}
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		clearInterval(this.refreshTimer);
		await this.refreshPromise?.catch(() => undefined);
	}
}

class DaemonSupervisorOwnership {
	private released = false;

	constructor(
		readonly record: DaemonSupervisorOwnerRecord,
		private readonly registryDir: string,
		private readonly ownerDirectory: string,
	) {}

	async assertCurrent(): Promise<void> {
		if (this.released) {
			throw this.ownershipLostError();
		}
		const current = readOwnerRecord(this.ownerDirectory);
		if (!current || !sameOwnerRecord(current, this.record)) {
			throw this.ownershipLostError();
		}
	}

	private ownershipLostError(): DaemonSupervisorOwnershipLostError {
		return new DaemonSupervisorOwnershipLostError(this.record.generation, {
			socketPath: this.record.socketPath,
			registryDir: this.registryDir,
		});
	}

	async updatePhase(phase: DaemonSupervisorOwnerPhase): Promise<void> {
		if (this.released) {
			return;
		}
		const updated = await mutateDaemonSupervisorOwner(
			this.record.generation,
			this.record.token,
			(owner) => {
				owner.phase = phase;
			},
			this.registryDir,
		);
		if (!updated) {
			throw new Error(`Daemon supervisor ownership was lost for ${this.record.socketPath}`);
		}
		this.record.phase = phase;
		this.record.updatedAt = updated.updatedAt;
	}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		let releasedDirectory: string | undefined;
		try {
			await withDaemonSupervisorRegistryGuard(this.registryDir, () => {
				const current = readOwnerRecord(this.ownerDirectory);
				if (!current || current.token !== this.record.token) {
					return;
				}
				releasedDirectory = `${this.ownerDirectory}.released-${randomUUID()}`;
				renameSync(this.ownerDirectory, releasedDirectory);
			});
			this.released = true;
		} finally {
			if (releasedDirectory) {
				rmSync(releasedDirectory, { recursive: true, force: true });
			}
		}
	}
}

class DaemonShutdownAdmission {
	private released = false;
	private readonly renewal: RenewableRegistryRecord;

	constructor(
		private readonly record: DaemonShutdownAdmissionRecord,
		private readonly registryDir: string,
	) {
		this.renewal = new RenewableRegistryRecord(
			registryDir,
			SHUTDOWN_ADMISSION_REFRESH_MS,
			() => this.acquireOrRenewUnderGuard(),
			() => new DaemonShutdownAdmissionError("Daemon shutdown admission was lost"),
			(error) => error instanceof DaemonShutdownAdmissionError,
		);
	}

	async assertOrRenew(): Promise<void> {
		if (this.released) {
			throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
		}
		await this.renewal.assertOrRenew();
	}

	/**
	 * Re-acquires or extends this holder's own ticket under the registry guard.
	 *
	 * The record is compared by identity, not by its lease clock: a lease that
	 * lapsed while this process was stalled still names this process, so the holder
	 * renews it and carries on. Only a *live* foreign holder is an authoritative
	 * refusal, and it is permanent — another process is inside the shutdown this one
	 * was admitted for, and continuing would be the overlap the ticket prevents. A
	 * foreign record whose process is gone is reclaimable, like any other stale
	 * registry entry.
	 *
	 * This deliberately does not re-derive this process's own start identity: the
	 * record is ours by token, and asking `ps` about our own pid every second both
	 * forked a synchronous helper on the renew path — one of the stalls that loses
	 * the ticket — and turned a transient `ps` failure into a permanent loss.
	 */
	private acquireOrRenewUnderGuard(): void {
		const path = shutdownAdmissionPath(this.registryDir);
		const current = readShutdownAdmission(path);
		if (current && !this.isCurrentTicket(current) && isProcessIdentityAlive(current)) {
			throw new DaemonShutdownAdmissionError(
				`Daemon shutdown admission is held by live process ${current.pid}; this shutdown cannot continue`,
			);
		}
		const now = Date.now();
		this.record.updatedAt = new Date(now).toISOString();
		this.record.expiresAt = new Date(now + SHUTDOWN_ADMISSION_LEASE_MS).toISOString();
		writeJsonAtomically(path, this.record);
	}

	private isCurrentTicket(current: DaemonShutdownAdmissionRecord): boolean {
		return (
			current.token === this.record.token &&
			current.pid === this.record.pid &&
			current.processStartId === this.record.processStartId
		);
	}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;
		await this.renewal.stop();
		await withDaemonSupervisorRegistryGuard(this.registryDir, () => {
			const path = shutdownAdmissionPath(this.registryDir);
			const current = readShutdownAdmission(path);
			if (current?.token === this.record.token) {
				rmSync(path, { force: true });
			}
		});
	}
}

/**
 * The registry is durable authority state and must be global per user so
 * ownerConflicts sees every daemon on the box; it deliberately lives outside
 * $TMPDIR (whose files macOS dirhelper deletes after 3 days) and outside the
 * per-invocation agent dir.
 */
function defaultDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string {
	return environment[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV] ?? join(homedir(), ".prime", "supervisor-owners");
}

/** Read-only legacy registry location, disabled when the registry is overridden. */
/**
 * Pre-move registry location under $TMPDIR, consulted READ-ONLY while daemons
 * from before the ~/.prime move may still be running; gated off whenever the
 * registry is overridden. Remove after one release.
 */
function legacyDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string | undefined {
	return environment[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV]
		? undefined
		: resolve(defaultDaemonSocketDir(), "supervisor-owners");
}

/**
 * Non-mutating legacy scan: never reclaims abandoned directories (old-build
 * daemons own that location's lifecycle) and runs without the legacy guard —
 * best-effort is acceptable because records are written rename-atomically.
 */
function readLegacyOwnersForSocket(
	legacyRegistryDir: string,
	normalizedSocketPath: string,
): DaemonSupervisorOwnerRecord[] {
	let entries: string[];
	try {
		entries = readdirSync(legacyRegistryDir);
	} catch {
		return [];
	}
	return entries
		.filter((name) => name.endsWith(".owner"))
		.flatMap((name) => {
			const owner = readOwnerRecord(resolve(legacyRegistryDir, name));
			return owner && owner.socketPath === normalizedSocketPath ? [owner] : [];
		});
}

async function withDaemonSupervisorRegistryGuard<T>(registryDir: string, action: () => T | Promise<T>): Promise<T> {
	mkdirSync(registryDir, { recursive: true, mode: 0o700 });
	const guardPath = resolve(registryDir, ".guard");
	let compromisedError: Error | undefined;
	const release = await lockfile.lock(registryDir, {
		realpath: false,
		lockfilePath: guardPath,
		stale: REGISTRY_LOCK_STALE_MS,
		update: REGISTRY_LOCK_UPDATE_MS,
		onCompromised: (error) => {
			compromisedError ??= error;
		},
		retries: {
			retries: REGISTRY_LOCK_RETRIES,
			factor: 1,
			minTimeout: REGISTRY_LOCK_RETRY_MS,
			maxTimeout: REGISTRY_LOCK_RETRY_MS,
		},
	});
	// Compromise detection is timer-driven and cannot preempt a synchronous stall: a stalled action's
	// writes may already be on disk when a successor reclaims the stale guard. The guard directory's
	// inode is the ownership identity (a steal is rmdir+mkdir), checked synchronously where the timer
	// cannot run; when the inode is unobservable, only timer-driven detection applies.
	const guardIno = (() => {
		try {
			return statSync(guardPath, { bigint: true }).ino;
		} catch {
			return undefined;
		}
	})();
	const guardStolen = () => {
		if (guardIno === undefined) return false;
		try {
			return statSync(guardPath, { bigint: true }).ino !== guardIno;
		} catch {
			return true;
		}
	};
	const assertGuardHeld = () => {
		if (compromisedError)
			throw new Error(`Daemon supervisor registry guard was compromised: ${compromisedError.message}`);
		if (guardStolen())
			throw new Error("Daemon supervisor registry guard was compromised: the guard lock changed hands");
	};
	try {
		assertGuardHeld();
		const result = await action();
		assertGuardHeld();
		return result;
	} finally {
		if (compromisedError) {
			await release().catch(() => undefined);
		} else if (!guardStolen()) {
			await release();
		}
		// A stolen-but-undetected guard is never released: that would delete the successor's lock.
		// The abandoned updater notices the foreign mtime on its next tick and cleans itself up.
	}
}

async function mutateDaemonSupervisorOwner(
	generation: string,
	expectedToken: string,
	mutation: (owner: DaemonSupervisorOwnerRecord) => void,
	registryDir: string = defaultDaemonSupervisorRegistryDir(),
): Promise<DaemonSupervisorOwnerRecord | undefined> {
	return withDaemonSupervisorRegistryGuard(registryDir, () => {
		const directory = ownerDirectoryPath(registryDir, generation);
		if (!existsSync(directory)) {
			return undefined;
		}
		const current = requireOwnerRecord(directory);
		if (current.token !== expectedToken) {
			return undefined;
		}
		mutation(current);
		current.updatedAt = new Date().toISOString();
		if (
			!isDaemonSupervisorOwnerRecord(current) ||
			current.generation !== generation ||
			current.token !== expectedToken
		) {
			throw new Error(`Invalid mutation for daemon supervisor owner ${generation}`);
		}
		writeOwnerRecord(directory, current);
		return current;
	});
}

/**
 * A daemon holds one agent dir for its whole life: it writes that dir's
 * sessions, harness state, leases, cron store and worker descriptors. Two
 * daemons on one agent dir are two writers on that state. The socket path alone
 * never expressed this — the default socket lives in `$TMPDIR`, so a shell with
 * a different `$TMPDIR` reaches a different socket, can start a second daemon,
 * and both of them then write the same agent dir.
 */
export class DaemonAgentDirAlreadyRunningError extends Error {
	readonly code = "daemon_agent_dir_already_running" as const;

	constructor(
		readonly owner: DaemonSupervisorOwnerSummary,
		readonly agentDir: string,
	) {
		super(
			`Another Prime Agent daemon already owns agent dir ${agentDir}: pid ${owner.pid}, ` +
				`generation ${owner.generation}, socket ${owner.socketPath}. ` +
				"Two daemons on one agent dir would co-write its sessions, harness state and leases, " +
				`so this daemon will not start. Talk to the running one with "--daemon-socket ${owner.socketPath}", ` +
				"or stop it before starting a new one.",
		);
		this.name = "DaemonAgentDirAlreadyRunningError";
	}
}

/** The part of an owner record clients and startup guards need, without the internal bookkeeping. */
export interface DaemonSupervisorOwnerSummary {
	generation: string;
	pid: number;
	socketPath: string;
	agentDir: string;
	phase: DaemonSupervisorOwnerPhase;
	createdAt: string;
}

/**
 * Live daemons bound to one agent dir, newest first.
 *
 * Read-only and lock-free on purpose: a record is written rename-atomically, so a
 * torn read is not possible, and a client that is only looking must never take the
 * registry guard (that is the writer's serialization) nor reclaim another daemon's
 * directory (only a starting daemon does that, under the guard).
 */
export async function findLiveDaemonOwnersForAgentDir(
	agentDir: string,
	registryDir?: string,
): Promise<DaemonSupervisorOwnerSummary[]> {
	const resolvedRegistryDir = registryDir ?? defaultDaemonSupervisorRegistryDir();
	const legacyRegistryDir = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined;
	const wanted = canonicalizeFilesystemPath(agentDir);
	const summaries: DaemonSupervisorOwnerSummary[] = [];
	for (const directory of [resolvedRegistryDir, ...(legacyRegistryDir ? [legacyRegistryDir] : [])]) {
		for (const owner of readOwnerRecordsIn(directory)) {
			if (owner.agentDir !== wanted) {
				continue;
			}
			// Only records for this agent dir pay for the identity check, which forks
			// `ps`/`powershell` when the pid alone is not decisive.
			if (!isProcessIdentityAlive(owner)) {
				continue;
			}
			summaries.push({
				generation: owner.generation,
				pid: owner.pid,
				socketPath: owner.socketPath,
				agentDir: owner.agentDir,
				phase: owner.phase,
				createdAt: owner.createdAt,
			});
		}
	}
	return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.pid - right.pid);
}

/** A supervisor owner record reduced to the identity a stop command must check before signalling. */
export interface RecordedDaemonSocketOwner {
	socketPath: string;
	pid: number;
	processStartId?: string;
}

/**
 * Every supervisor owner record on this machine: the daemon sockets some daemon
 * on this box is accountable for, in the current registry and in the read-only
 * legacy one.
 *
 * Read-only and lock-free for the same reason `findLiveDaemonOwnersForAgentDir`
 * is: a stop command is a reader here and must never take the writer's guard, and
 * a record is written rename-atomically so a torn read is impossible. No judge of
 * liveness is made here — the caller checks the identity against the process it
 * is about to signal.
 */
export function readRecordedDaemonSocketOwners(
	environment: NodeJS.ProcessEnv = process.env,
): RecordedDaemonSocketOwner[] {
	const registryDir = defaultDaemonSupervisorRegistryDir(environment);
	const legacyRegistryDir = legacyDaemonSupervisorRegistryDir(environment);
	const owners: RecordedDaemonSocketOwner[] = [];
	for (const directory of [registryDir, ...(legacyRegistryDir ? [legacyRegistryDir] : [])]) {
		for (const record of readOwnerRecordsIn(directory)) {
			owners.push({
				socketPath: normalizeSocketPath(record.socketPath),
				pid: record.pid,
				...(record.processStartId ? { processStartId: record.processStartId } : {}),
			});
		}
	}
	return owners;
}

function readOwnerRecordsIn(registryDir: string): DaemonSupervisorOwnerRecord[] {
	try {
		return listOwnerDirectories(registryDir).flatMap((ownerDirectory) => {
			const owner = readOwnerRecord(ownerDirectory);
			return owner ? [owner] : [];
		});
	} catch {
		// An absent or unreadable registry holds no live daemon.
		return [];
	}
}

export async function acquireDaemonSupervisorOwnership(
	options: AcquireDaemonSupervisorOwnershipOptions,
): Promise<DaemonSupervisorOwnership> {
	const registryDir = options.registryDir ?? defaultDaemonSupervisorRegistryDir();
	mkdirSync(registryDir, { recursive: true, mode: 0o700 });
	const token = randomUUID();
	const processStartId = getProcessStartId(process.pid);
	const now = new Date().toISOString();
	const record: DaemonSupervisorOwnerRecord = {
		version: OWNER_VERSION,
		role: "supervisor",
		token,
		generation: options.generation,
		pid: process.pid,
		...(processStartId ? { processStartId } : {}),
		socketPath: normalizeSocketPath(options.socketPath),
		descriptorDir: canonicalizeFilesystemPath(options.descriptorDir),
		agentDir: canonicalizeFilesystemPath(options.agentDir),
		appVersion: options.appVersion,
		phase: "starting",
		createdAt: now,
		updatedAt: now,
	};
	const candidateDirectory = resolve(registryDir, `.candidate-${process.pid}-${token}`);
	const ownerDirectory = ownerDirectoryPath(registryDir, options.generation);
	mkdirSync(candidateDirectory, { mode: 0o700 });
	const staleDirectories: string[] = [];
	try {
		writeOwnerScope(candidateDirectory, record);
		writeOwnerRecord(candidateDirectory, record);
		await withDaemonSupervisorRegistryGuard(registryDir, () => {
			if (readActiveShutdownAdmission(registryDir)) {
				throw new DaemonShutdownAdmissionError();
			}
			for (const directory of listOwnerDirectories(registryDir)) {
				const owner = readOwnerRecordForScope(directory, (scope) => ownerConflicts(scope, record));
				if (!owner) {
					continue;
				}
				if (ownerConflicts(owner, record)) {
					if (isProcessIdentityAlive(owner)) {
						throw new DaemonSupervisorAlreadyRunningError(owner);
					}
				} else if (owner.agentDir === record.agentDir) {
					// Same agent dir, different socket: the second half of the uniqueness
					// constraint. A daemon that owns an agent dir owns its sessions,
					// harness state and leases; a live one keeps that ownership whatever
					// `$TMPDIR` (and therefore whatever socket path) the newcomer resolved.
					if (isProcessIdentityAlive(owner)) {
						throw new DaemonAgentDirAlreadyRunningError(
							{
								generation: owner.generation,
								pid: owner.pid,
								socketPath: owner.socketPath,
								agentDir: owner.agentDir,
								phase: owner.phase,
								createdAt: owner.createdAt,
							},
							record.agentDir,
						);
					}
				} else if (isProcessAlive(owner.pid) && !isAbandonedOwnerFootprint(owner)) {
					// Somebody else's live daemon on this box: none of our business.
					// Only the cheap kill(0) is spent here, deliberately: this loop runs
					// over every owner directory on the machine inside the registry
					// guard, on the daemon startup path, and the identity check forks
					// `ps`/`powershell`. Treating a live pid as alive even when it may be
					// a recycled one only postpones reclaiming that directory to whoever
					// eventually conflicts with it, which is exactly today's behavior.
					continue;
				}
				// Dead owners, and owners whose whole footprint was deleted, are
				// reclaimed whether or not they conflict. Recovery used
				// to be keyed on a conflict only, so an owner recorded for a different
				// socket path (a test fixture, `--daemon-socket`, the two generations of
				// an update handoff) stayed in this global registry forever — 36 of 45
				// directories on one machine, two weeks old — and every later acquire and
				// startup fence paid a full-table readdir + readFileSync + JSON.parse for
				// each of them. Both liveness predicates above are conservative in the same
				// direction (an unobservable identity counts as alive), so this only ever
				// takes a directory whose process is provably gone.
				const staleDirectory = `${directory}.stale-${randomUUID()}`;
				renameSync(directory, staleDirectory);
				staleDirectories.push(staleDirectory);
			}
			renameSync(candidateDirectory, ownerDirectory);
		});
	} catch (error) {
		rmSync(candidateDirectory, { recursive: true, force: true });
		throw error;
	} finally {
		for (const directory of staleDirectories) {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	return new DaemonSupervisorOwnership(record, registryDir, ownerDirectory);
}

export async function assertDaemonSupervisorOwnerCurrent(
	owner: {
		generation: string;
		pid: number;
		processStartId?: string;
		socketPath: string;
	},
	validatedFingerprint?: string,
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined,
): Promise<string> {
	registryDir ??= defaultDaemonSupervisorRegistryDir();
	const current =
		readOwnerRecord(ownerDirectoryPath(registryDir, owner.generation)) ??
		(legacyRegistryDir ? readOwnerRecord(ownerDirectoryPath(legacyRegistryDir, owner.generation)) : undefined);
	if (
		!current ||
		current.pid !== owner.pid ||
		current.processStartId !== owner.processStartId ||
		current.socketPath !== normalizeSocketPath(owner.socketPath) ||
		!isProcessAlive(current.pid)
	) {
		throw new DaemonSupervisorOwnershipLostError(owner.generation, { socketPath: owner.socketPath, registryDir });
	}
	const fingerprint = ownerRecordFingerprint(current);
	if (fingerprint !== validatedFingerprint && !isProcessIdentityAlive(current)) {
		throw new DaemonSupervisorOwnershipLostError(owner.generation, { socketPath: owner.socketPath, registryDir });
	}
	return fingerprint;
}

export async function acquireDaemonShutdownAdmission(
	waitTimeoutMs: number = SHUTDOWN_ADMISSION_WAIT_TIMEOUT_MS,
): Promise<DaemonShutdownAdmission> {
	const registryDir = defaultDaemonSupervisorRegistryDir();
	const processStartId = getProcessStartId(process.pid);
	const deadline = Date.now() + waitTimeoutMs;
	// Kept for the failure message: a waiter that gives up must be able to name the
	// holder instead of only reporting that it could not have the ticket.
	let holder: DaemonShutdownAdmissionRecord | undefined;
	while (true) {
		let acquired: DaemonShutdownAdmissionRecord | undefined;
		await withDaemonSupervisorRegistryGuard(registryDir, () => {
			// A live holder keeps the ticket however stale its lease looks: it is the one
			// process admitted to run shutdown work, and it renews its own record as soon
			// as its event loop runs again. Only a record whose process is gone is
			// reclaimed here, so two processes never hold this admission at once.
			holder = readLiveShutdownAdmission(registryDir);
			if (holder) {
				return;
			}
			const now = Date.now();
			acquired = {
				version: OWNER_VERSION,
				token: randomUUID(),
				pid: process.pid,
				...(processStartId ? { processStartId } : {}),
				createdAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				expiresAt: new Date(now + SHUTDOWN_ADMISSION_LEASE_MS).toISOString(),
			};
			writeJsonAtomically(shutdownAdmissionPath(registryDir), acquired);
		});
		if (acquired) {
			return new DaemonShutdownAdmission(acquired, registryDir);
		}
		if (Date.now() >= deadline) {
			throw new DaemonShutdownAdmissionError(describeShutdownAdmissionHolder(holder, waitTimeoutMs));
		}
		await delay(SHUTDOWN_ADMISSION_WAIT_MS);
	}
}

/**
 * Read-only probe: reclaiming here would let a bystander delete the record of a holder whose
 * process identity merely failed to verify, so only acquireDaemonShutdownAdmission removes an
 * abandoned admission.
 */
export async function isDaemonShutdownAdmissionActive(): Promise<boolean> {
	const registryDir = defaultDaemonSupervisorRegistryDir();
	return withDaemonSupervisorRegistryGuard(registryDir, () =>
		shutdownAdmissionIsActive(readShutdownAdmission(shutdownAdmissionPath(registryDir))),
	);
}

export async function persistDaemonStartupFenceFromOwner(
	socketPath: string,
	hello: DaemonSupervisorHelloIdentity,
	registryDir?: string,
	legacyRegistryDir: string | undefined = registryDir === undefined ? legacyDaemonSupervisorRegistryDir() : undefined,
): Promise<void> {
	registryDir ??= defaultDaemonSupervisorRegistryDir();
	mkdirSync(registryDir, { recursive: true, mode: 0o700 });
	const fenceDirectory = resolve(registryDir, "startup-fences");
	mkdirSync(fenceDirectory, { recursive: true, mode: 0o700 });
	const path = startupFencePath(fenceDirectory, socketPath);
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	return withDaemonSupervisorRegistryGuard(registryDir, () => {
		const owners = listOwnerDirectories(registryDir).flatMap((directory) => {
			const owner = readOwnerRecordForScope(directory, (scope) => scope.socketPath === normalizedSocketPath);
			return owner ? [owner] : [];
		});
		let matchingOwners = owners.filter((owner) => owner.socketPath === normalizedSocketPath);
		if (matchingOwners.length === 0 && legacyRegistryDir) {
			// Stale legacy leftovers are expected; keep only records matching the
			// identity the caller already holds.
			matchingOwners = readLegacyOwnersForSocket(legacyRegistryDir, normalizedSocketPath).filter(
				(owner) => owner.token === hello.supervisorOwnerToken && owner.pid === hello.supervisorPid,
			);
		}
		if (matchingOwners.length === 0) {
			throw new Error(`Daemon supervisor owner does not match ${socketPath}`);
		}
		if (matchingOwners.length > 1) {
			throw new Error(`Multiple daemon supervisor owners match ${socketPath}`);
		}
		const owner = matchingOwners[0];
		if (!owner) {
			throw new Error(`Daemon supervisor owner disappeared for ${socketPath}`);
		}
		const helloSocketPath = hello.supervisorSocketPath;
		if (
			!Number.isInteger(hello.supervisorPid) ||
			hello.supervisorPid !== owner.pid ||
			hello.supervisorGeneration !== owner.generation ||
			hello.supervisorOwnerToken !== owner.token ||
			typeof helloSocketPath !== "string" ||
			normalizeSocketPath(helloSocketPath) !== owner.socketPath ||
			typeof owner.processStartId !== "string" ||
			hello.supervisorProcessStartId !== owner.processStartId
		) {
			throw new Error(`Daemon supervisor hello does not match its durable owner for ${socketPath}`);
		}
		const observedProcessStartId = getProcessStartId(owner.pid);
		if (observedProcessStartId !== owner.processStartId) {
			throw new Error(`Daemon supervisor process identity changed for ${socketPath}`);
		}
		const record: DaemonStartupFenceRecord = {
			version: OWNER_VERSION,
			token: randomUUID(),
			ownerToken: owner.token,
			pid: owner.pid,
			processStartId: owner.processStartId,
			socketPath: owner.socketPath,
			supervisorGeneration: owner.generation,
			createdAt: new Date().toISOString(),
		};
		writeJsonAtomically(path, record);
	});
}

export async function waitForDaemonStartupFence(
	socketPath: string,
	timeoutMs = 10_000,
	registryDir: string = defaultDaemonSupervisorRegistryDir(),
): Promise<void> {
	const path = startupFencePath(resolve(registryDir, "startup-fences"), socketPath);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const fence = await readStartupFenceOrQuarantine(path, registryDir);
		if (!fence) {
			return;
		}
		if (fence.socketPath !== normalizeSocketPath(socketPath)) {
			throw new Error(`Daemon startup fence does not match ${socketPath}`);
		}
		if (!isProcessIdentityAlive(fence)) {
			const cleared = await withDaemonSupervisorRegistryGuard(registryDir, () => {
				const current = readStartupFence(path);
				if (!current) {
					return true;
				}
				if (current?.token === fence.token) {
					rmSync(path, { force: true });
					return true;
				}
				return false;
			});
			if (cleared) {
				return;
			}
			continue;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for predecessor daemon process ${fence.pid} to exit`);
		}
		await delay(STARTUP_FENCE_POLL_MS);
	}
}

/**
 * A record whose whole footprint is gone is abandoned authority, whatever its pid says.
 *
 * The registry is user-wide authority state, so it also collects records from daemons
 * whose world was temporary: a leaked test daemon owns an agent dir, a socket and a
 * descriptor dir under one temp root, deleting that root leaves a record whose three
 * paths no longer exist, and the recorded pid may still be alive (or recycled by an
 * unrelated process). Liveness by pid alone kept such a record forever, and the
 * startup gate then had to reason about a supervisor that cannot exist.
 *
 * Deliberately narrow: all three paths must be gone and the record must not still be
 * `starting`. A starting daemon writes its record before it binds its socket and
 * creates its descriptor dir, and a running daemon has a live agent dir and descriptor
 * dir on a mounted filesystem plus a bound socket file, so no reachable daemon is
 * reclaimed here — only a footprint that was deleted under it.
 */
function isAbandonedOwnerFootprint(owner: DaemonSupervisorOwnerRecord): boolean {
	if (owner.phase === "starting") {
		return false;
	}
	return !existsSync(owner.agentDir) && !existsSync(owner.socketPath) && !existsSync(owner.descriptorDir);
}

function isProcessIdentityAlive(identity: ProcessIdentity): boolean {
	if (!isProcessAlive(identity.pid)) {
		return false;
	}
	if (!identity.processStartId) {
		return true;
	}
	const observed = getProcessStartId(identity.pid);
	return observed === undefined || observed === identity.processStartId;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
	return true;
}

function canonicalizeFilesystemPath(path: string): string {
	let existingAncestor = resolve(path);
	const missingSuffix: string[] = [];
	while (true) {
		try {
			const physicalAncestor = realpathSync.native(existingAncestor);
			const canonical = join(physicalAncestor, ...missingSuffix);
			return process.platform === "win32" ? canonical.toLowerCase() : canonical;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
			const parent = dirname(existingAncestor);
			if (parent === existingAncestor) {
				const unresolved = resolve(path);
				return process.platform === "win32" ? unresolved.toLowerCase() : unresolved;
			}
			missingSuffix.unshift(basename(existingAncestor));
			existingAncestor = parent;
		}
	}
}

function ownerConflicts(left: DaemonSupervisorOwnerScope, right: DaemonSupervisorOwnerScope): boolean {
	return left.socketPath === right.socketPath || left.descriptorDir === right.descriptorDir;
}

function sameOwnerRecord(left: DaemonSupervisorOwnerRecord, right: DaemonSupervisorOwnerRecord): boolean {
	return (
		left.token === right.token &&
		left.generation === right.generation &&
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		left.socketPath === right.socketPath
	);
}

function ownerRecordFingerprint(record: DaemonSupervisorOwnerRecord): string {
	return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function listOwnerDirectories(registryDir: string): string[] {
	return readdirSync(registryDir)
		.filter((name) => name.endsWith(".owner"))
		.map((name) => resolve(registryDir, name));
}

function ownerDirectoryPath(registryDir: string, generation: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(generation)) {
		throw new Error(`Invalid daemon supervisor generation: ${generation}`);
	}
	return resolve(registryDir, `${generation}.owner`);
}

function requireOwnerRecord(directory: string): DaemonSupervisorOwnerRecord {
	const owner = readOwnerRecord(directory);
	if (!owner) {
		throw new Error(`Invalid daemon supervisor owner record: ${directory}`);
	}
	return owner;
}

function readOwnerRecordForScope(
	directory: string,
	isRelevant: (scope: DaemonSupervisorOwnerScope) => boolean,
): DaemonSupervisorOwnerRecord | undefined {
	const owner = readOwnerRecord(directory);
	if (owner) {
		return owner;
	}
	const scope = readOwnerScope(directory);
	const entries = !scope ? readdirSync(directory) : [];
	if (!scope && !entries.includes("owner.json") && !entries.includes("scope.json")) {
		const abandonedDirectory = `${directory}.abandoned-${randomUUID()}`;
		renameSync(directory, abandonedDirectory);
		rmSync(abandonedDirectory, { recursive: true, force: true });
		return undefined;
	}
	if (!scope || isRelevant(scope)) {
		throw new Error(`Invalid daemon supervisor owner record: ${directory}`);
	}
	return undefined;
}

function readOwnerRecord(directory: string): DaemonSupervisorOwnerRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(resolve(directory, "owner.json"), "utf8")) as unknown;
		return isDaemonSupervisorOwnerRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isDaemonSupervisorOwnerRecord(value: unknown): value is DaemonSupervisorOwnerRecord {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Partial<DaemonSupervisorOwnerRecord>;
	return (
		record.version === OWNER_VERSION &&
		record.role === "supervisor" &&
		typeof record.token === "string" &&
		typeof record.generation === "string" &&
		Number.isInteger(record.pid) &&
		(record.pid ?? 0) > 0 &&
		(record.processStartId === undefined || typeof record.processStartId === "string") &&
		typeof record.socketPath === "string" &&
		typeof record.descriptorDir === "string" &&
		typeof record.agentDir === "string" &&
		typeof record.appVersion === "string" &&
		(record.phase === "starting" || record.phase === "owner" || record.phase === "stopping") &&
		typeof record.createdAt === "string" &&
		typeof record.updatedAt === "string"
	);
}

function readOwnerScope(directory: string): DaemonSupervisorOwnerScope | undefined {
	try {
		const value = JSON.parse(readFileSync(resolve(directory, "scope.json"), "utf8")) as unknown;
		if (!isDaemonSupervisorOwnerScope(value)) {
			return undefined;
		}
		return ownerDirectoryPath(dirname(directory), value.generation) === directory ? value : undefined;
	} catch {
		return undefined;
	}
}

function isDaemonSupervisorOwnerScope(value: unknown): value is DaemonSupervisorOwnerScope {
	if (!value || typeof value !== "object") {
		return false;
	}
	const scope = value as Partial<DaemonSupervisorOwnerScope>;
	return (
		scope.version === OWNER_VERSION &&
		scope.role === "supervisor" &&
		typeof scope.token === "string" &&
		typeof scope.generation === "string" &&
		typeof scope.socketPath === "string" &&
		typeof scope.descriptorDir === "string"
	);
}

function writeOwnerScope(directory: string, owner: DaemonSupervisorOwnerRecord): void {
	const scope: DaemonSupervisorOwnerScope = {
		version: owner.version,
		role: owner.role,
		token: owner.token,
		generation: owner.generation,
		socketPath: owner.socketPath,
		descriptorDir: owner.descriptorDir,
	};
	writeJsonAtomically(resolve(directory, "scope.json"), scope);
}

function writeOwnerRecord(directory: string, record: DaemonSupervisorOwnerRecord): void {
	writeJsonAtomically(resolve(directory, "owner.json"), record);
}

/**
 * A fence that exists but cannot be parsed is debris, not authority. Treating it as
 * authoritative made the daemon for that socket unstartable forever: the only path
 * that clears a fence needs a supervisor that can start, and the only path that
 * rewrites it runs after a successful start and hello. So the bytes are quarantined
 * under the registry guard and the wait carries on without them — losing a fence
 * costs one succession wait (a successor may start before its predecessor is fully
 * gone), which is what the socket lease and the ownership guard are there to
 * arbitrate anyway.
 */
async function readStartupFenceOrQuarantine(
	path: string,
	registryDir: string,
): Promise<DaemonStartupFenceRecord | undefined> {
	try {
		return readStartupFence(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		const quarantined = `${path}.corrupt-${randomUUID()}`;
		const renamed = await withDaemonSupervisorRegistryGuard(registryDir, () => {
			try {
				// Re-check under the guard: a successor may have replaced the file
				// between the read above and now, and a parsable fence must be honoured.
				readStartupFence(path);
				return false;
			} catch (guarded) {
				if ((guarded as NodeJS.ErrnoException).code === "ENOENT") {
					return false;
				}
				renameSync(path, quarantined);
				return true;
			}
		});
		if (!renamed) {
			return readStartupFence(path);
		}
		structuredLog.warn("quarantined an unreadable daemon startup fence", {
			path,
			quarantined,
			error: String(error),
		});
		return undefined;
	}
}

function readStartupFence(path: string): DaemonStartupFenceRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid daemon startup fence: ${path}`);
		}
		const fence = value as Partial<DaemonStartupFenceRecord>;
		if (
			fence.version !== OWNER_VERSION ||
			typeof fence.token !== "string" ||
			typeof fence.ownerToken !== "string" ||
			!Number.isInteger(fence.pid) ||
			(fence.pid ?? 0) <= 0 ||
			typeof fence.processStartId !== "string" ||
			typeof fence.socketPath !== "string" ||
			typeof fence.supervisorGeneration !== "string" ||
			typeof fence.createdAt !== "string"
		) {
			throw new Error(`Invalid daemon startup fence: ${path}`);
		}
		return fence as DaemonStartupFenceRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/**
 * The ticket's owner: any record naming a process that is still running, whatever
 * its lease clock says. Deleting a live holder's record is what let a second
 * process acquire the same admission while the first one was still inside it, so
 * reclaim is reserved for a record whose process is provably gone.
 */
function readLiveShutdownAdmission(registryDir: string): DaemonShutdownAdmissionRecord | undefined {
	const path = shutdownAdmissionPath(registryDir);
	const admission = readShutdownAdmission(path);
	if (!admission) {
		return undefined;
	}
	if (isProcessIdentityAlive(admission)) {
		return admission;
	}
	rmSync(path, { force: true });
	return undefined;
}

/** Advisory face ("is a shutdown running right now?"): a lapsed lease reads as no. */
function readActiveShutdownAdmission(registryDir: string): DaemonShutdownAdmissionRecord | undefined {
	const admission = readLiveShutdownAdmission(registryDir);
	return shutdownAdmissionIsActive(admission) ? admission : undefined;
}

function shutdownAdmissionIsActive(admission: DaemonShutdownAdmissionRecord | undefined): boolean {
	return admission !== undefined && Date.parse(admission.expiresAt) > Date.now() && isProcessIdentityAlive(admission);
}

/**
 * A waiter refuses instead of waiting forever: the holder may be wedged, and a
 * shutdown command that neither proceeds nor reports why is worse than one that
 * names the process standing in its way.
 */
function describeShutdownAdmissionHolder(
	holder: DaemonShutdownAdmissionRecord | undefined,
	waitTimeoutMs: number,
): string {
	if (!holder) {
		return `Daemon shutdown is in progress and did not finish within ${waitTimeoutMs}ms; this shutdown cannot continue`;
	}
	const lapsedMs = Date.now() - Date.parse(holder.expiresAt);
	const lease = lapsedMs > 0 ? `its lease lapsed ${lapsedMs}ms ago` : "its lease is live";
	return (
		`Daemon shutdown is held by live process ${holder.pid} (${lease}) and did not finish within ` +
		`${waitTimeoutMs}ms; this shutdown cannot continue — wait for that process or stop it`
	);
}

function readShutdownAdmission(path: string): DaemonShutdownAdmissionRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid daemon shutdown admission: ${path}`);
		}
		const admission = value as Partial<DaemonShutdownAdmissionRecord>;
		if (
			admission.version !== OWNER_VERSION ||
			typeof admission.token !== "string" ||
			!Number.isInteger(admission.pid) ||
			(admission.pid ?? 0) <= 0 ||
			(admission.processStartId !== undefined && typeof admission.processStartId !== "string") ||
			typeof admission.createdAt !== "string" ||
			typeof admission.updatedAt !== "string" ||
			typeof admission.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(admission.expiresAt))
		) {
			throw new Error(`Invalid daemon shutdown admission: ${path}`);
		}
		return admission as DaemonShutdownAdmissionRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/**
 * Durable write for authority state (owner record, startup fence, shutdown
 * admission, worker descriptor, supervisor config). A rename alone only makes the
 * name change atomic: without an fsync a machine crash can leave the canonical
 * path pointing at a zero-byte or half-written file, and the readers here treat
 * that as authoritative — a torn startup fence makes the daemon for that socket
 * unstartable (clearing it needs a daemon that can start), a torn worker
 * descriptor is skipped on every later startup and never cleaned up. Same shape
 * the three recovery journals already use: fsync the temp, rename, fsync the
 * directory. The directory fsync is best-effort because not every platform lets a
 * directory be opened for reading; the rename above is still atomic there, only
 * its durability across a power loss is weaker.
 */
export function writeJsonAtomically(path: string, value: unknown): void {
	// The util owns the short-write loop (a single writeSync can return a partial
	// count); the flags keep this site's unconditional fsync + directory fsync.
	writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
		fsync: true,
		fsyncDir: true,
	});
}

function startupFencePath(directory: string, socketPath: string): string {
	const key = createHash("sha256").update(normalizeSocketPath(socketPath)).digest("hex");
	return resolve(directory, `${key}.json`);
}

function shutdownAdmissionPath(registryDir: string): string {
	return resolve(registryDir, SHUTDOWN_ADMISSION_FILE_NAME);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
