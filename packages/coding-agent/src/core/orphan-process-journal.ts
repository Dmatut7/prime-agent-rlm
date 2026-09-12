import { spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import { win32 } from "node:path";
import { lockSync } from "proper-lockfile";
import { repairTruncatedTrailingLine } from "../utils/file-lines.js";
import { getProcessStartId, getProcessStartIdAsync, getProcProcessStartId } from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	/** Set on records written by a kernel (e.g. bash() children) so the host can reap per kernel. */
	kernelPid?: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	kernelPid?: number;
	/** Missing on identity-free records: old journals, a host write whose start-id capture is still in flight or failed (kernels no longer write pid-only records). */
	processStartId?: string;
	/** When the record was written; bounds pid-reuse checks for identity-free records. */
	recordedAt?: string;
}

interface StartIdCapture {
	readonly path: string;
}

/** In-flight start-id captures by pid; a later record for the same pid invalidates them. */
const startIdCaptures = new Map<number, StartIdCapture>();
const pendingStartIdWrites = new Set<Promise<void>>();

export function recordOrphanProcessState(pid: number, active: boolean): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(pid) || pid <= 0) {
		return;
	}
	if (!active) {
		// The deactivation supersedes any start-id capture still in flight for this pid;
		// landing it afterwards would resurrect the record as active.
		startIdCaptures.delete(pid);
	}
	// Only the /proc identity is cheap enough to hold a spawn for. Where reading it
	// needs a helper process (macOS/BSD `ps`, win32 powershell) the record goes out
	// pid-only and is enriched once the query answers, so the fork never blocks the
	// spawner. Readers treat a pid-only active record as identity-free, which is the
	// state a failed start-id query already produced.
	const processStartId = active ? getProcProcessStartId(pid) : undefined;
	const record: OrphanProcessRecord = {
		version: 1,
		pid,
		ownerPid: process.pid,
		...(processStartId ? { processStartId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	appendRecord(path, record, { fsync: true, create: true });
	if (active && processStartId === undefined) {
		scheduleStartIdCapture(path, pid);
	}
}

/** Resolves once every scheduled start-id capture has landed or been superseded. */
export async function flushOrphanProcessJournal(): Promise<void> {
	await Promise.allSettled([...pendingStartIdWrites]);
}

function scheduleStartIdCapture(path: string, pid: number): void {
	const capture: StartIdCapture = { path };
	startIdCaptures.set(pid, capture);
	const write = captureStartId(capture, pid);
	pendingStartIdWrites.add(write);
	// captureStartId swallows its own failures; the rejection arm only keeps a
	// surprise from surfacing as an unhandled rejection, which the host treats as fatal.
	void write.then(
		() => pendingStartIdWrites.delete(write),
		() => pendingStartIdWrites.delete(write),
	);
}

async function captureStartId(capture: StartIdCapture, pid: number): Promise<void> {
	try {
		const processStartId = await getProcessStartIdAsync(pid);
		if (!processStartId || startIdCaptures.get(pid) !== capture) {
			return;
		}
		// No fsync: the pid record this enriches is already durable, and the identity
		// only sharpens reaping. A power loss drops the enrichment, not the child.
		// No create: a journal cleared in the meantime must not be resurrected.
		appendRecord(
			capture.path,
			{
				version: 1,
				pid,
				ownerPid: process.pid,
				processStartId,
				active: true,
				recordedAt: new Date().toISOString(),
			},
			{ fsync: false, create: false },
		);
	} catch {
		// Identity stays best-effort; the pid-only record already journaled the child.
	} finally {
		if (startIdCaptures.get(pid) === capture) {
			startIdCaptures.delete(pid);
		}
	}
}

interface AppendRecordOptions {
	/** False for the start-id enrichment, which is not part of the recovery contract. */
	fsync: boolean;
	/** False to append only to a journal that still exists. */
	create: boolean;
}

function appendRecord(path: string, record: OrphanProcessRecord, options: AppendRecordOptions): void {
	const flags = constants.O_WRONLY | (options.create ? constants.O_CREAT : 0) | (constants.O_NOFOLLOW ?? 0);
	try {
		// Host and kernels append to the same journal; hold the guard across
		// repair+append so a crash-torn tail from one writer cannot glue onto
		// another writer's record. Lock failures stay best-effort (outer catch).
		// proper-lockfile requires the lock target to exist; create it first (a
		// symlinked journal is refused by O_NOFOLLOW and skipped).
		const touch = openSync(path, flags, 0o600);
		closeSync(touch);
		let release: (() => void) | undefined;
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				release = lockSync(path, {
					realpath: false,
					lockfilePath: `${path}.guard`,
					stale: 5000,
				});
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
				if (attempt === 19) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
		if (!release) throw new Error(`Could not lock orphan process journal: ${path}`);
		const releaseLock = release;
		try {
			// A crash can leave a torn final line; readers skip it, so drop it before
			// the append glues onto it.
			repairTruncatedTrailingLine(path);
			const descriptor = openSync(path, flags | constants.O_APPEND, 0o600);
			try {
				// Repair legacy 0644 journals: the create mode only applies to new files.
				// Gated on the current mode, so a record does not dirty the inode for a
				// mode that is already right.
				if (process.platform !== "win32" && (fstatSync(descriptor).mode & 0o777) !== 0o600) {
					fchmodSync(descriptor, 0o600);
				}
				writeSync(descriptor, `${JSON.stringify(record)}\n`);
				if (options.fsync) fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
		} finally {
			releaseLock();
		}
	} catch {
		// Process tracking must not make a successfully spawned command fail.
	}
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
	const latest = new Map<number, OrphanProcessRecord>();
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		try {
			const record = JSON.parse(line) as Partial<OrphanProcessRecord>;
			if (
				record.version === 1 &&
				Number.isInteger(record.pid) &&
				(record.pid ?? 0) > 0 &&
				record.ownerPid === ownerPid &&
				typeof record.active === "boolean" &&
				typeof record.recordedAt === "string"
			) {
				latest.set(record.pid!, record as OrphanProcessRecord);
			}
		} catch {
			// A crash can truncate only the final append.
		}
	}
	// Pid-only actives (no processStartId) still surface from old journals or host
	// writes whose start-id capture has not landed yet (or failed); reapers decide per-platform.
	return [...latest.values()]
		.filter(
			(record) =>
				record.active && (record.processStartId === undefined || typeof record.processStartId === "string"),
		)
		.map((record) => ({
			pid: record.pid,
			...(Number.isInteger(record.kernelPid) ? { kernelPid: record.kernelPid } : {}),
			...(typeof record.processStartId === "string" ? { processStartId: record.processStartId } : {}),
			...(typeof record.recordedAt === "string" ? { recordedAt: record.recordedAt } : {}),
		}));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	// Pid-only records can never claim identity (undefined === undefined must not match).
	return orphan.processStartId !== undefined && getProcessStartId(orphan.pid) === orphan.processStartId;
}

/**
 * A reused pid must not be killed for an identity-free record. When the start
 * id is a ps lstart stamp (macOS/BSD), a process that only started after the
 * record was written cannot be the journaled one. Unparseable sources keep the
 * historical best-effort behavior.
 */
export function isOrphanPidReused(
	orphan: ActiveOrphanProcess,
	query: (pid: number) => string | undefined = getProcessStartId,
): boolean {
	if (!orphan.recordedAt) return false;
	const recorded = Date.parse(orphan.recordedAt);
	if (Number.isNaN(recorded)) return false;
	const startId = query(orphan.pid);
	if (typeof startId !== "string" || !startId.startsWith("ps:")) return false;
	// getPsProcessStartId pins TZ=UTC for the lstart render, so the stamp must be
	// parsed as UTC; Date.parse would otherwise read it as local time and skew the
	// comparison by the UTC offset on non-UTC hosts.
	const started = Date.parse(`${startId.slice("ps:".length)} UTC`);
	if (Number.isNaN(started)) return false;
	return started > recorded;
}

/**
 * Identity-free records cannot prove the pid still names the journaled process.
 * On win32 the kernel's kill-on-close job already reaped its tree when it died,
 * so a bare-pid taskkill only risks killing a reused pid. POSIX keeps the
 * best-effort kill (group-scoped, and the spawn gate makes pid-only actives
 * host-written rarities there), except when the pid demonstrably belongs to a
 * process younger than the record.
 */
export function shouldReapOrphanProcess(
	orphan: ActiveOrphanProcess,
	query: (pid: number) => string | undefined = getProcessStartId,
): boolean {
	if (orphan.processStartId === undefined) {
		if (process.platform === "win32") return false;
		return !isOrphanPidReused(orphan, query);
	}
	return isOrphanProcessIdentityCurrent(orphan);
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
}

// Kills still-active bash() children journaled by the given kernel pid; sibling kernels' records are untouched.
export function reapKernelOrphanProcesses(kernelPid: number): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(kernelPid) || kernelPid <= 0) {
		return;
	}
	let orphans: ActiveOrphanProcess[];
	try {
		orphans = readActiveOrphanProcesses(path, process.pid);
	} catch {
		return;
	}
	for (const orphan of orphans) {
		if (orphan.kernelPid !== kernelPid || orphan.pid === kernelPid) {
			continue;
		}
		if (!shouldReapOrphanProcess(orphan)) {
			continue;
		}
		// Inactive only after a delivered signal; a stale record is neutralized by the startId check.
		if (killOrphanProcess(orphan.pid)) {
			recordOrphanProcessState(orphan.pid, false);
		}
	}
}

// Hardened cross-platform tree kill for journaled orphans: absolute System32
// taskkill /T on win32 (a bare name could resolve a planted CWD taskkill.exe),
// process-group then pid SIGKILL elsewhere.
export function killOrphanProcess(pid: number): boolean {
	if (process.platform === "win32") {
		// In-kernel bash() kill paths use taskkill /T; the reaper must kill the same tree, not just the shell pid.
		const result = spawnSync(
			win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
			["/F", "/T", "/PID", String(pid)],
			{
				stdio: "ignore",
				timeout: 10_000,
				env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" },
			},
		);
		return result.status === 0;
	}
	try {
		process.kill(-pid, "SIGKILL");
		return true;
	} catch {
		try {
			process.kill(pid, "SIGKILL");
			return true;
		} catch {
			// The orphan may already have exited.
		}
	}
	return false;
}
