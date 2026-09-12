import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import lockfile from "proper-lockfile";
import { getProcessStartId } from "../../core/session-lease.js";
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
		try {
			await withDaemonSupervisorRegistryGuard(this.registryDir, () => {
				// stop() may have completed while this call waited on the guard;
				// a stopped record must never be rewritten to disk.
				if (this.stopped || this.lost) {
					throw this.createLostError();
				}
				this.renewUnderGuard();
			});
		} catch (error) {
			this.lost = true;
			clearInterval(this.refreshTimer);
			throw error;
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
			() => this.renewUnderGuard(),
			() => new DaemonShutdownAdmissionError("Daemon shutdown admission was lost"),
		);
	}

	async assertOrRenew(): Promise<void> {
		if (this.released) {
			throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
		}
		await this.renewal.assertOrRenew();
	}

	private renewUnderGuard(): void {
		const path = shutdownAdmissionPath(this.registryDir);
		const current = readShutdownAdmission(path);
		if (
			!current ||
			current.token !== this.record.token ||
			current.pid !== this.record.pid ||
			current.processStartId !== this.record.processStartId ||
			Date.parse(current.expiresAt) <= Date.now() ||
			!matchesExactProcessIdentity(this.record)
		) {
			throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
		}
		const now = Date.now();
		this.record.updatedAt = new Date(now).toISOString();
		this.record.expiresAt = new Date(now + SHUTDOWN_ADMISSION_LEASE_MS).toISOString();
		writeJsonAtomically(path, this.record);
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
				} else if (isProcessAlive(owner.pid)) {
					// Somebody else's live daemon on this box: none of our business.
					// Only the cheap kill(0) is spent here, deliberately: this loop runs
					// over every owner directory on the machine inside the registry
					// guard, on the daemon startup path, and the identity check forks
					// `ps`/`powershell`. Treating a live pid as alive even when it may be
					// a recycled one only postpones reclaiming that directory to whoever
					// eventually conflicts with it, which is exactly today's behavior.
					continue;
				}
				// Dead owners are reclaimed whether or not they conflict. Recovery used
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

export async function acquireDaemonShutdownAdmission(): Promise<DaemonShutdownAdmission> {
	const registryDir = defaultDaemonSupervisorRegistryDir();
	const processStartId = getProcessStartId(process.pid);
	while (true) {
		let acquired: DaemonShutdownAdmissionRecord | undefined;
		await withDaemonSupervisorRegistryGuard(registryDir, () => {
			if (readActiveShutdownAdmission(registryDir)) {
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
		await delay(SHUTDOWN_ADMISSION_WAIT_MS);
	}
}

export async function isDaemonShutdownAdmissionActive(): Promise<boolean> {
	const registryDir = defaultDaemonSupervisorRegistryDir();
	return withDaemonSupervisorRegistryGuard(registryDir, () => readActiveShutdownAdmission(registryDir) !== undefined);
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

function matchesExactProcessIdentity(identity: ProcessIdentity): boolean {
	if (!isProcessAlive(identity.pid)) {
		return false;
	}
	return identity.processStartId === undefined || getProcessStartId(identity.pid) === identity.processStartId;
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

function readActiveShutdownAdmission(registryDir: string): DaemonShutdownAdmissionRecord | undefined {
	const path = shutdownAdmissionPath(registryDir);
	const admission = readShutdownAdmission(path);
	if (!admission) {
		return undefined;
	}
	if (Date.parse(admission.expiresAt) > Date.now() && isProcessIdentityAlive(admission)) {
		return admission;
	}
	rmSync(path, { force: true });
	return undefined;
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
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(
			tempPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
		// open's mode is umask-masked; pin the private bits before the file is durable.
		fchmodSync(descriptor, 0o600);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(tempPath, path);
	} catch (error) {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// The write failure is the one worth reporting.
			}
		}
		rmSync(tempPath, { force: true });
		throw error;
	}
	try {
		const directoryDescriptor = openSync(dirname(path), "r");
		try {
			fsyncSync(directoryDescriptor);
		} finally {
			closeSync(directoryDescriptor);
		}
	} catch {
		// See above: weaker durability, not a failed write.
	}
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
