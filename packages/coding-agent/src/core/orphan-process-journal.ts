import { spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { lockSync } from "proper-lockfile";
import { repairTruncatedTrailingLine } from "../utils/file-lines.js";
import { getProcessStartId, getProcessStartIdAsync, getProcProcessStartId } from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

/**
 * Compaction bounds, matching the two sibling recovery journals
 * (`command-recovery-journal`, `worker-recovery-journal`). This is the most
 * frequently written journal of the three — one bash() child costs three records
 * (pid-only active, start-id enrichment, deactivation) — and without a bound a
 * live worker grew it to 890 KB / 5,629 lines in 10.5 h, half of them records a
 * later line had already superseded, while every reader parsed the whole file
 * synchronously. Compaction keeps the newest record per (ownerPid, pid) that is
 * still active, which is exactly what `readActiveOrphanProcesses` reports, so a
 * rewrite is invisible to readers.
 */
export const COMPACT_AFTER_RECORDS = 4096;
export const COMPACT_AFTER_BYTES = 4 * 1024 * 1024;

/**
 * Parse bound for a reader that treats the answer as a lower bound (the degraded
 * stall-liveness check). It equals the compaction bound on purpose: a journal
 * compaction is keeping up with is read whole, and only a legacy journal or one
 * whose compaction is failing gets read as a bounded tail instead of parsed in
 * full on the caller's thread — that file grows without limit otherwise, and the
 * newest record of every pid inside the window is still in it.
 */
export const DEGRADED_READ_MAX_BYTES = COMPACT_AFTER_BYTES;

/** A failed compaction must not become a rewrite attempt on every append. */
const COMPACTION_RETRY_BACKOFF_MS = 60_000;
/** A compaction temp older than this belongs to a dead writer. */
const STALE_TEMP_MAX_AGE_MS = 60_000;

const structuredLog = getLogger("coding-agent.core.orphan-process-journal");

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
		withJournalGuard(path, () => {
			// A crash can leave a torn final line; readers skip it, so drop it before
			// the append glues onto it.
			repairTruncatedTrailingLine(path);
			const line = `${JSON.stringify(record)}\n`;
			const descriptor = openSync(path, flags | constants.O_APPEND, 0o600);
			try {
				const stats = fstatSync(descriptor);
				// Repair legacy 0644 journals: the create mode only applies to new files.
				// Gated on the current mode, so a record does not dirty the inode for a
				// mode that is already right.
				if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
					fchmodSync(descriptor, 0o600);
				}
				const state = syncJournalState(path, stats.size);
				writeSync(descriptor, line);
				if (options.fsync) fsyncSync(descriptor);
				state.lineCount += 1;
				state.byteLength += Buffer.byteLength(line);
			} finally {
				closeSync(descriptor);
			}
			// Inside the guard: a concurrent writer's append must not land in the file
			// this rewrite is about to replace.
			compactJournalIfOverBound(path);
		});
	} catch {
		// Process tracking must not make a successfully spawned command fail.
	}
}

/**
 * Host and kernels append to the same journal, so every mutation (repair, append,
 * compaction) holds one guard: a crash-torn tail from one writer cannot glue onto
 * another writer's record, and a compaction cannot replace a file another writer
 * just appended to. Lock failures propagate to the caller, which decides whether
 * they are fatal (an append is not, an explicit compaction is).
 *
 * The lock target does not have to exist: proper-lockfile with `realpath: false`
 * only ever mkdirs `<path>.lock` (the same shape `acquireDaemonSocketPathLease`
 * relies on for a socket path that is created after the lease), so the append
 * below is what creates the journal.
 */
function withJournalGuard<T>(path: string, work: () => T): T {
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
	try {
		return work();
	} finally {
		release();
	}
}

/** Rewrite the journal down to its live records now, whatever its size. */
export function compactOrphanProcessJournal(path: string): void {
	withJournalGuard(path, () => {
		repairTruncatedTrailingLine(path);
		let state = journalStates.get(path);
		if (!state) {
			state = { lineCount: 0, byteLength: 0, tempSequence: 0, compactNotBefore: 0 };
			journalStates.set(path, state);
		}
		rewriteCompactedJournal(path, state);
	});
}

/**
 * Cached observation of one journal's physical size. The file stays the authority
 * (other writers append to it and compaction replaces it); this only keeps the
 * per-append bound check from re-reading what the previous append already saw.
 */
interface JournalAppendState {
	/** Newline-terminated physical lines as of `byteLength`, parsable or not. */
	lineCount: number;
	byteLength: number;
	tempSequence: number;
	/** Zero, or the earliest time a failed compaction may be retried. */
	compactNotBefore: number;
}

const journalStates = new Map<string, JournalAppendState>();

/**
 * Reconcile the cached counts with the file under the guard lock. Growth since the
 * last observation is another writer's append and is counted by reading only those
 * bytes; a shrink means somebody compacted or cleared the journal, which is cheap
 * to re-count because both leave a small file. Past the byte bound the exact line
 * count cannot change the decision, so the read is skipped and compaction re-seeds
 * both counters from what it wrote.
 */
function syncJournalState(path: string, size: number): JournalAppendState {
	let state = journalStates.get(path);
	if (!state) {
		state = { lineCount: 0, byteLength: 0, tempSequence: 0, compactNotBefore: 0 };
		journalStates.set(path, state);
	}
	if (size >= COMPACT_AFTER_BYTES) {
		state.lineCount = Math.max(state.lineCount, COMPACT_AFTER_RECORDS);
		state.byteLength = size;
		return state;
	}
	if (size === state.byteLength) {
		return state;
	}
	if (size > state.byteLength) {
		state.lineCount += countNewlines(path, state.byteLength, size);
	} else {
		state.lineCount = countNewlines(path, 0, size);
	}
	state.byteLength = size;
	return state;
}

function countNewlines(path: string, start: number, end: number): number {
	const length = end - start;
	if (length <= 0) {
		return 0;
	}
	const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const buffer = Buffer.allocUnsafe(length);
		let offset = 0;
		while (offset < length) {
			const read = readSync(descriptor, buffer, offset, length - offset, start + offset);
			if (read <= 0) {
				break;
			}
			offset += read;
		}
		let count = 0;
		for (let index = 0; index < offset; index++) {
			if (buffer[index] === 0x0a) {
				count++;
			}
		}
		return count;
	} finally {
		closeSync(descriptor);
	}
}

function compactJournalIfOverBound(path: string): void {
	const state = journalStates.get(path);
	if (!state) {
		return;
	}
	if (state.lineCount < COMPACT_AFTER_RECORDS && state.byteLength < COMPACT_AFTER_BYTES) {
		return;
	}
	if (Date.now() < state.compactNotBefore) {
		return;
	}
	state.compactNotBefore = 0;
	try {
		rewriteCompactedJournal(path, state);
	} catch (error) {
		// The append that brought us here already succeeded, and the caller is a spawn
		// path, so this must not throw. A journal that cannot compact keeps growing,
		// which has to be visible on its own, and the backoff keeps a persistent
		// failure from turning every append into a rewrite attempt.
		state.compactNotBefore = Date.now() + COMPACTION_RETRY_BACKOFF_MS;
		structuredLog.warn("could not compact the orphan process journal", {
			path,
			error: String(error),
		});
	}
}

/** Caller holds the guard lock. Keeps the newest still-active record per (ownerPid, pid). */
function rewriteCompactedJournal(path: string, state: JournalAppendState): void {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// Cleared underneath us (clearOrphanProcessJournal, deleteWorkerDescriptor):
			// nothing to rewrite, and the counters must not claim records that are gone.
			state.lineCount = 0;
			state.byteLength = 0;
			return;
		}
		throw error;
	}
	const latest = new Map<string, OrphanProcessRecord>();
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		let record: OrphanProcessRecord;
		try {
			record = JSON.parse(line) as OrphanProcessRecord;
		} catch {
			// A crash can truncate only the final append; readers skip it too.
			continue;
		}
		if (!isJournalRecord(record)) {
			continue;
		}
		latest.set(`${record.ownerPid}:${record.pid}`, record);
	}
	// An inactive newest record is what `readActiveOrphanProcesses` filters out, so
	// dropping it here is the same answer with fewer bytes on disk.
	const kept = [...latest.values()].filter((record) => record.active);
	const content = kept.length > 0 ? `${kept.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
	cleanStaleCompactionTemps(path);
	writeCompactedJournal(path, content, `${path}.${process.pid}.${state.tempSequence++}.tmp`);
	state.lineCount = kept.length;
	state.byteLength = Buffer.byteLength(content);
}

/** The exact validity predicate `readActiveOrphanProcesses` applies, minus the owner filter. */
function isJournalRecord(record: Partial<OrphanProcessRecord>): record is OrphanProcessRecord {
	return (
		record.version === 1 &&
		Number.isInteger(record.pid) &&
		(record.pid ?? 0) > 0 &&
		Number.isInteger(record.ownerPid) &&
		typeof record.active === "boolean" &&
		typeof record.recordedAt === "string"
	);
}

/** One retry with a fresh name: O_EXCL refuses an occupied temp, and clearing it can fail too. */
function writeCompactedJournal(path: string, content: string, tempPath: string): void {
	try {
		writeCompactedJournalTemp(path, content, tempPath);
	} catch (error) {
		const second = `${tempPath}.retry.tmp`;
		try {
			writeCompactedJournalTemp(path, content, second);
		} catch {
			throw error;
		}
	}
}

function writeCompactedJournalTemp(path: string, content: string, tempPath: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(
			tempPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeSync(descriptor, content);
		// This fsync is what makes the rename below safe: the canonical path must
		// never expose a partially written compaction result (same contract as the
		// two sibling recovery journals).
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(tempPath, path);
	} finally {
		if (descriptor !== undefined) {
			closeSync(descriptor);
		}
		// After a successful rename the temp no longer exists; on failure this removes
		// the partial file instead of leaving it for the next writer.
		rmSync(tempPath, { force: true });
	}
	const directoryDescriptor = openSync(dirname(path), "r");
	try {
		fsyncSync(directoryDescriptor);
	} catch {
		// Not every filesystem lets a directory be opened for reading; the rename
		// above is still atomic, only its durability across a power loss is weaker.
	} finally {
		closeSync(directoryDescriptor);
	}
}

/** A crashed compaction leaves one temp behind; the next one sweeps what is old enough to be dead. */
function cleanStaleCompactionTemps(path: string): void {
	const prefix = `${basename(path)}.`;
	const directory = dirname(path);
	const cutoff = Date.now() - STALE_TEMP_MAX_AGE_MS;
	try {
		for (const name of readdirSync(directory)) {
			if (!name.startsWith(prefix) || !name.endsWith(".tmp")) {
				continue;
			}
			const tempPath = join(directory, name);
			try {
				if (statSync(tempPath).mtimeMs >= cutoff) {
					// Young enough to belong to a compaction in flight.
					continue;
				}
				rmSync(tempPath, { force: true });
			} catch {
				// A temp that vanished mid-sweep is already gone.
			}
		}
	} catch {
		// Stale temps only waste space; sweeping them must not break the rewrite.
	}
}

export interface ReadActiveOrphanProcessesOptions {
	/**
	 * Parse at most this many of the newest bytes. Records are appended in order,
	 * so the newest record of every pid inside the window is in it; a pid whose
	 * newest record is older than the window is missed, which makes the result a
	 * lower bound. Unbounded by default — a reaper has to see every record — so
	 * only a caller that treats the answer as a lower bound (the degraded stall
	 * check, which passes DEGRADED_READ_MAX_BYTES) should set it.
	 */
	maxBytes?: number;
}

const truncationWarnings = new Map<string, number>();

/**
 * At most `maxBytes` of the journal's newest bytes. Only an oversized file takes
 * the positional-read path; a journal compaction is keeping up with is read whole,
 * exactly as before.
 */
function readJournalContents(path: string, maxBytes: number): string {
	// ENOENT propagates to the caller, which is the contract readFileSync had here.
	const { size } = statSync(path);
	if (size <= maxBytes) {
		return readFileSync(path, "utf8");
	}
	warnTruncatedRead(path, size, maxBytes);
	const descriptor = openSync(path, constants.O_RDONLY);
	try {
		const buffer = Buffer.allocUnsafe(maxBytes);
		const start = size - maxBytes;
		let offset = 0;
		while (offset < maxBytes) {
			const read = readSync(descriptor, buffer, offset, maxBytes - offset, start + offset);
			if (read <= 0) {
				// The file shrank under us (a concurrent compaction); what was read is a tail.
				break;
			}
			offset += read;
		}
		// Drop the first, possibly partial line: its pid's authoritative record may sit
		// outside the window, and half a JSON line would not parse anyway.
		const firstNewline = buffer.subarray(0, offset).indexOf(0x0a);
		return buffer.toString("utf8", firstNewline === -1 ? offset : firstNewline + 1, offset);
	} finally {
		closeSync(descriptor);
	}
}

/** Throttled: an oversized journal is read on every degraded stall check. */
function warnTruncatedRead(path: string, size: number, maxBytes: number): void {
	const now = Date.now();
	const previous = truncationWarnings.get(path);
	if (previous !== undefined && now - previous < COMPACTION_RETRY_BACKOFF_MS) {
		return;
	}
	truncationWarnings.set(path, now);
	structuredLog.warn(
		"orphan process journal is larger than the bounded read window; reporting its newest records only",
		{
			path,
			size,
			maxBytes,
		},
	);
}

export function readActiveOrphanProcesses(
	path: string,
	ownerPid: number,
	options: ReadActiveOrphanProcessesOptions = {},
): ActiveOrphanProcess[] {
	const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
	let contents: string;
	try {
		contents = readJournalContents(path, maxBytes);
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
			if (isJournalRecord(record) && record.ownerPid === ownerPid) {
				latest.set(record.pid, record);
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
