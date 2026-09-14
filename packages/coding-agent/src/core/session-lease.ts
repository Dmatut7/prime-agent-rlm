import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";

export const SESSION_LEASES_ENABLED_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASES";
export const SESSION_LEASE_OWNER_ID_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID";

interface SessionLeaseOwner {
	version: 1;
	token: string;
	pid: number;
	processStartId?: string;
	activeSessionId?: string;
	sessionPath: string;
	createdAt: string;
}

export class SessionAlreadyActiveError extends Error {
	readonly code = "session_already_active" as const;

	constructor(
		readonly sessionPath: string,
		readonly activeSessionId?: string,
	) {
		super(
			activeSessionId
				? `Session is already active in ${activeSessionId}: ${sessionPath}`
				: `Session is already active in another process: ${sessionPath}`,
		);
		this.name = "SessionAlreadyActiveError";
	}
}

/** Lease directories held by live SessionLease objects in this process. */
const activeLeaseDirectories = new Set<string>();

export class SessionLease {
	private released = false;

	constructor(
		readonly sessionPath: string,
		private readonly directory: string,
		private readonly token: string,
	) {
		activeLeaseDirectories.add(directory);
	}

	release(): void {
		if (this.released) {
			return;
		}
		this.released = true;
		activeLeaseDirectories.delete(this.directory);
		try {
			withLeaseGuard(this.directory, () => {
				const owner = readLeaseOwner(this.directory);
				if (typeof owner === "object" && owner.token === this.token) {
					rmSync(this.directory, { recursive: true, force: true });
				}
			});
		} catch {
			// Lease cleanup is best-effort. A stale owner is reclaimed by the next process.
		}
	}
}

function leasesEnabled(environment: NodeJS.ProcessEnv): boolean {
	const value = environment[SESSION_LEASES_ENABLED_ENV]?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function leaseDirectory(agentDir: string, sessionPath: string): string {
	const key = createHash("sha256").update(sessionPath).digest("hex");
	return join(agentDir, "session-leases", `${key}.lock`);
}

export function canonicalSessionPath(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	try {
		return realpathSync(resolvedPath);
	} catch {
		try {
			return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
		} catch {
			return resolvedPath;
		}
	}
}

function isSessionLeaseOwner(value: unknown): value is SessionLeaseOwner {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Partial<SessionLeaseOwner>;
	return (
		record.version === 1 &&
		typeof record.token === "string" &&
		typeof record.pid === "number" &&
		typeof record.sessionPath === "string" &&
		typeof record.createdAt === "string"
	);
}

/**
 * An unreadable owner may hold a live lease, so only a missing owner is safely
 * absent. A record that decodes to nothing valid is "corrupt": a torn write or
 * tampering that names no process, hence no evidence of a live owner to respect.
 */
function readLeaseOwner(directory: string): SessionLeaseOwner | "absent" | "unreadable" | "corrupt" {
	const ownerPath = join(directory, "owner.json");
	let raw: string;
	try {
		raw = readFileSync(ownerPath, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isSessionLeaseOwner(parsed) ? parsed : "corrupt";
	} catch (error) {
		if (error instanceof SyntaxError) {
			return "corrupt";
		}
		throw error;
	}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

interface ProcessQueryOptions {
	env?: NodeJS.ProcessEnv;
}

type ProcessQuery = (command: string, args: string[], options?: ProcessQueryOptions) => string;

type ProcessQueryAsync = (command: string, args: string[], options?: ProcessQueryOptions) => Promise<string>;

/** A wedged helper process must not keep an asynchronous identity capture pending forever. */
const PROCESS_QUERY_TIMEOUT_MS = 5_000;

function runProcessQuery(command: string, args: string[], options?: ProcessQueryOptions): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: options?.env,
	});
}

function runProcessQueryAsync(command: string, args: string[], options?: ProcessQueryOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ encoding: "utf8", timeout: PROCESS_QUERY_TIMEOUT_MS, windowsHide: true, env: options?.env },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

function windowsStartIdQuery(pid: number): { command: string; args: string[] } {
	return {
		command: "powershell.exe",
		args: [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
		],
	};
}

// `lstart` is rendered in the subprocess timezone and locale, so pin both for a durable identity.
function psStartIdQuery(pid: number): { command: string; args: string[]; options: ProcessQueryOptions } {
	return {
		command: "ps",
		args: ["-p", String(pid), "-o", "lstart="],
		options: { env: { ...process.env, LC_ALL: "C", LC_TIME: "C", LANG: "C", TZ: "UTC" } },
	};
}

function parseWindowsStartId(stdout: string): string | undefined {
	const startTicks = stdout.trim();
	return /^\d+$/.test(startTicks) ? `win:${startTicks}` : undefined;
}

function parsePsStartId(stdout: string): string | undefined {
	const startTime = stdout.trim();
	return startTime ? `ps:${startTime}` : undefined;
}

function parseProcStatStartId(stat: string): string | undefined {
	const commandEnd = stat.lastIndexOf(")");
	const fields = stat.slice(commandEnd + 2).split(" ");
	const startTime = fields[19];
	return startTime ? `proc:${startTime}` : undefined;
}

export function getWindowsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		const { command, args } = windowsStartIdQuery(pid);
		return parseWindowsStartId(query(command, args));
	} catch {
		return undefined;
	}
}

export function getPsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		const { command, args, options } = psStartIdQuery(pid);
		return parsePsStartId(query(command, args, options));
	} catch {
		return undefined;
	}
}

/** The /proc start identity: the only source that needs no helper process, so it is the only cheap one. */
export function getProcProcessStartId(pid: number): string | undefined {
	try {
		return parseProcStatStartId(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		// No procfs (macOS/BSD), or the pid is already gone.
		return undefined;
	}
}

export function getProcessStartId(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	if (process.platform === "win32") {
		return getWindowsProcessStartId(pid);
	}
	// Fall through to the portable process listing used on macOS and BSD.
	return getProcProcessStartId(pid) ?? getPsProcessStartId(pid);
}

/**
 * Non-blocking twin of `getProcessStartId`, same identity formats, so an identity
 * captured by either compares equal. A spawn hot path must not fork the helper
 * process synchronously: that stalls the event loop for the whole round trip.
 */
export async function getProcessStartIdAsync(
	pid: number,
	query: ProcessQueryAsync = runProcessQueryAsync,
): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	if (process.platform === "win32") {
		try {
			const { command, args } = windowsStartIdQuery(pid);
			return parseWindowsStartId(await query(command, args));
		} catch {
			return undefined;
		}
	}
	try {
		const fromProc = parseProcStatStartId(await readFile(`/proc/${pid}/stat`, "utf8"));
		if (fromProc) {
			return fromProc;
		}
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	try {
		const { command, args, options } = psStartIdQuery(pid);
		return parsePsStartId(await query(command, args, options));
	} catch {
		return undefined;
	}
}

let currentProcessStartId: string | undefined;
let currentProcessStartIdRead = false;

function getCurrentProcessStartId(): string | undefined {
	if (!currentProcessStartIdRead) {
		currentProcessStartId = getProcessStartId(process.pid);
		currentProcessStartIdRead = true;
	}
	return currentProcessStartId;
}

function isLeaseOwnerAlive(owner: SessionLeaseOwner): boolean {
	if (!isProcessAlive(owner.pid)) {
		return false;
	}
	if (!owner.processStartId) {
		return true;
	}
	const currentStartId = getProcessStartId(owner.pid);
	return currentStartId === undefined || currentStartId === owner.processStartId;
}

/**
 * The owner record names this very process under the same owner identity but
 * no live SessionLease in this process holds it: a leaked lease (release
 * failed, start-id detection unavailable, …). Reclaim instead of deadlocking
 * against ourselves. A lease actively held in-process (an in-process RLM child
 * runtime, a replaced session still disposing) stays in activeLeaseDirectories
 * and therefore still conflicts — only truly orphaned records are reclaimed.
 * A different process reusing the pid would have a different process start id
 * (caught by isLeaseOwnerAlive when present).
 */
function isReclaimableOwnLease(owner: SessionLeaseOwner, directory: string, environment: NodeJS.ProcessEnv): boolean {
	return (
		owner.pid === process.pid &&
		owner.activeSessionId === environment[SESSION_LEASE_OWNER_ID_ENV] &&
		!activeLeaseDirectories.has(directory)
	);
}

function withLeaseGuard<T>(directory: string, action: () => T): T {
	let release: (() => void) | undefined;
	let guardCompromised = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			release = lockSync(directory, {
				realpath: false,
				lockfilePath: `${directory}.guard`,
				stale: 5000,
				onCompromised: () => {
					guardCompromised = true;
				},
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
				throw error;
			}
			if (attempt === 99) {
				throw new Error(`Could not coordinate session lease: ${directory}`);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (!release) {
		throw new Error(`Could not coordinate session lease: ${directory}`);
	}
	const assertGuardHeld = () => {
		if (guardCompromised) throw new Error(`Session lease guard was compromised: ${directory}`);
	};
	try {
		assertGuardHeld();
		const result = action();
		assertGuardHeld();
		return result;
	} finally {
		if (guardCompromised) {
			try {
				release();
			} catch {
				// The compromised guard no longer owns a lock that can be safely released.
			}
		} else {
			release();
		}
	}
}

function reclaimStaleLease(directory: string): boolean {
	const stalePath = `${directory}.stale-${process.pid}-${randomUUID()}`;
	try {
		renameSync(directory, stalePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return true;
		}
		return false;
	}
	rmSync(stalePath, { recursive: true, force: true });
	return true;
}

/**
 * Durable owner-record write: temp file beside the destination, fsync, then an
 * atomic rename, so a published owner.json is never torn mid-record and the
 * bytes are on disk before the candidate directory rename publishes them.
 */
function writeOwnerRecordAtomic(path: string, content: string): void {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const descriptor = openSync(tempPath, "wx", 0o600);
		try {
			// writeSync may return a short count without throwing; a partial temp must never be renamed in.
			const bytes = Buffer.from(content, "utf8");
			let offset = 0;
			while (offset < bytes.length) {
				const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
				if (written <= 0) throw new Error(`Short write persisting ${path}`);
				offset += written;
			}
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		// openSync's mode is masked by the umask; enforce the private bits exactly.
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
	try {
		const directoryDescriptor = openSync(dirname(path), "r");
		try {
			fsyncSync(directoryDescriptor);
		} finally {
			closeSync(directoryDescriptor);
		}
	} catch {
		// Unavailable on some platforms; the atomic rename still protects readers.
	}
}

export function acquireSessionLease(
	sessionPath: string | undefined,
	agentDir: string,
	environment: NodeJS.ProcessEnv = process.env,
): SessionLease | undefined {
	if (!sessionPath || !leasesEnabled(environment)) {
		return undefined;
	}
	const canonicalPath = canonicalSessionPath(sessionPath);
	const root = join(agentDir, "session-leases");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const directory = leaseDirectory(agentDir, canonicalPath);

	return withLeaseGuard(directory, () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const token = randomUUID();
			const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
			const owner: SessionLeaseOwner = {
				version: 1,
				token,
				pid: process.pid,
				processStartId: getCurrentProcessStartId(),
				activeSessionId: environment[SESSION_LEASE_OWNER_ID_ENV],
				sessionPath: canonicalPath,
				createdAt: new Date().toISOString(),
			};
			mkdirSync(candidateDirectory, { mode: 0o700 });
			// Durable before the directory rename publishes the record: a power loss
			// must not leave a torn owner.json for the next acquire to read back as an
			// unknown owner.
			writeOwnerRecordAtomic(join(candidateDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
			try {
				renameSync(candidateDirectory, directory);
				return new SessionLease(canonicalPath, directory, token);
			} catch (error) {
				rmSync(candidateDirectory, { recursive: true, force: true });
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "EEXIST" && code !== "ENOTEMPTY") {
					throw error;
				}
				const existingOwner = readLeaseOwner(directory);
				if (existingOwner === "unreadable") {
					// Fail closed: an unreadable record may still name a live owner, and
					// reclaiming one only needs write access to the parent directory, so a
					// takeover here could hand the same session to two holders. Retry, and
					// let the post-loop check refuse the lease while it stays unreadable.
					continue;
				}
				// "corrupt" names no process, so there is no live owner to fail closed
				// against: reclaim it under the guard (long-standing behavior, now spelled
				// out) rather than refuse a session over a record nothing can ever repair.
				if (
					typeof existingOwner === "object" &&
					isLeaseOwnerAlive(existingOwner) &&
					!isReclaimableOwnLease(existingOwner, directory, environment)
				) {
					throw new SessionAlreadyActiveError(canonicalPath, existingOwner.activeSessionId);
				}
				reclaimStaleLease(directory);
			}
		}

		const owner = existsSync(directory) ? readLeaseOwner(directory) : undefined;
		if (
			typeof owner === "object" &&
			isLeaseOwnerAlive(owner) &&
			!isReclaimableOwnLease(owner, directory, environment)
		) {
			throw new SessionAlreadyActiveError(canonicalPath, owner.activeSessionId);
		}
		throw new Error(`Could not acquire session lease: ${canonicalPath}`);
	});
}

/**
 * Lease directories this process holds right now. Read-only view for cleanup
 * callers: a sweep must never reclaim a lease its own process is holding, even
 * when the owner record on disk has not been written yet (adversarial review N-8).
 */
export function activeSessionLeaseDirectories(): ReadonlySet<string> {
	return activeLeaseDirectories;
}

/** Evidence class of one lease directory, for the retention sweep (L1/L2 layer). */
export type LeaseDirectoryVerdict = "live" | "held-in-process" | "reclaimable" | "unverifiable";

export interface LeaseDirectoryClassification {
	verdict: LeaseDirectoryVerdict;
	ownerPid?: number;
	sessionPath?: string;
	/** Human-readable reason for the report; the verdict is what the caller acts on. */
	detail?: string;
}

/**
 * Classify one lease directory with exactly the evidence `acquireSessionLease`
 * uses: pid plus process start identity (pids get reused), the in-process set
 * (a lease this process still holds is not stale, however its owner record
 * reads), and "a record that cannot be read is not an absent owner". A sweep
 * that deleted a lease the acquirer would have refused to reclaim would let two
 * processes hold one session, so this is the single place that decides.
 */
export function classifyLeaseDirectory(
	directory: string,
	options: { activeLeaseDirectories?: ReadonlySet<string>; environment?: NodeJS.ProcessEnv } = {},
): LeaseDirectoryClassification {
	const environment = options.environment ?? process.env;
	if (options.activeLeaseDirectories?.has(directory)) {
		return { verdict: "held-in-process", detail: "held by this process" };
	}
	const owner = readLeaseOwner(directory);
	if (owner === "absent") {
		return { verdict: "reclaimable", detail: "no owner record" };
	}
	if (owner === "unreadable" || owner === "corrupt") {
		return { verdict: "unverifiable", detail: `owner record ${owner}` };
	}
	const classification: LeaseDirectoryClassification = {
		verdict: "live",
		ownerPid: owner.pid,
		sessionPath: owner.sessionPath,
	};
	if (isReclaimableOwnLease(owner, directory, environment)) {
		return { ...classification, verdict: "reclaimable", detail: "leaked lease of this process" };
	}
	if (isLeaseOwnerAlive(owner)) {
		return { ...classification, detail: "owner alive" };
	}
	return { ...classification, verdict: "reclaimable", detail: "owner process is gone" };
}
