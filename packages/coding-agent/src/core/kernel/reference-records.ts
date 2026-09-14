// One reference-record law for every "generation" directory in this repo.
//
// A generation directory (a kernel venv, a kernel snapshot) is pinned by a small
// record file written by the process that uses it, and a sweep reads those records
// to decide what may be deleted. That decision is a deletion decision, so the law
// below is the strict one: "cannot be disproved" must never read as "gone".
//
// It lives in exactly one place because two copies drifted (round-11): the venv
// copy was hardened so a truncated record reads as "in use", and the snapshot copy
// kept sweeping it - a live kernel's truncated reference was unlinked and the
// generation it named was reclaimed while that kernel was still reading it.
//
// What one entry proves about its holder:
//   live          the holder runs and its recorded start identity still matches.
//   stale         the holder is provably gone (dead pid, or a pid whose start
//                 identity moved on). The only state that may be unlinked.
//   unverifiable  the entry exists but proves nothing either way: an unparseable
//                 record is a truncated write (a short write, or a reader that
//                 looked mid-write), and a file that does not name the pid inside
//                 it while that pid runs says nothing about the holder. Both are
//                 kept, and both make the caller's state unknown.
//   foreign       not a record this bookkeeping writes (a symlink, a directory).
//                 It neither protects a generation nor gets deleted, so a planted
//                 entry cannot pin anything.
import {
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import { requireNoFollow } from "../../utils/private-files.js";
import { getProcessStartId, isProcessAlive } from "../session-lease.js";

export const REFERENCE_RECORD_VERSION = 1;
/** A reference file is named for the pid that holds it. */
export const REFERENCE_PID_FILE_NAME = /^[1-9][0-9]*$/;

export interface ReferenceRecord {
	pid: number;
	/** Start identity of the recorded pid, when the writer could query one. */
	processStartId?: string;
	sessionId?: string;
	recordedAt?: string;
	/**
	 * The parsed object, so a caller can read the fields of its own layout (the
	 * snapshot layout records the generation a reference was taken for).
	 */
	raw: Record<string, unknown>;
}

/** The record one reference file holds, or undefined when it holds none. */
export function parseReferenceRecord(filePath: string): ReferenceRecord | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Record<string, unknown>;
		if (record.version !== REFERENCE_RECORD_VERSION) return undefined;
		if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) return undefined;
		return {
			pid: record.pid as number,
			...(typeof record.processStartId === "string" ? { processStartId: record.processStartId } : {}),
			...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
			...(typeof record.recordedAt === "string" ? { recordedAt: record.recordedAt } : {}),
			raw: record,
		};
	} catch {
		return undefined;
	}
}

/**
 * A live pid is only the recorded holder when its start identity still matches;
 * pids get reused. When the start identity cannot be queried the reference is
 * kept: this decides whether a directory may be deleted, so "cannot disprove"
 * must not read as "gone". (The orphan reaper judges the same evidence the other
 * way round because it decides whether to kill.)
 */
export function referenceIsLive(record: ReferenceRecord): boolean {
	if (!isProcessAlive(record.pid)) return false;
	if (record.processStartId === undefined) return true;
	const current = getProcessStartId(record.pid);
	return current === undefined || current === record.processStartId;
}

export type ReferenceVerdict = "live" | "stale" | "unverifiable" | "foreign";

/**
 * What one entry in a reference directory proves about its holder. `pidName` is
 * the pid the file name claims, without the layout's own prefix or suffix.
 */
export function judgeReferenceEntry(referencePath: string, pidName: string): ReferenceVerdict {
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(referencePath);
	} catch {
		// Gone between the directory listing and this read: nothing left to protect or sweep.
		return "stale";
	}
	if (stats.isSymbolicLink() || !stats.isFile()) return "foreign";
	const record = parseReferenceRecord(referencePath);
	// An unparseable record is a truncated write (disk full, or a reader that looked mid-write),
	// not a dead holder: the bytes prove nothing about who wrote them.
	if (record === undefined) return "unverifiable";
	if (Number(pidName) !== record.pid) return referenceIsLive(record) ? "unverifiable" : "stale";
	return referenceIsLive(record) ? "live" : "stale";
}

/**
 * Judge one entry a first read called stale, a second time. The writer is another
 * process and neither the record write nor the sweep is atomic, so the file can
 * become a live reference (or an unreadable one) between the read and the unlink.
 * This confirmation is the only thing that authorises a removal.
 */
export function confirmReferenceIsStale(referencePath: string, pidName: string): boolean {
	return judgeReferenceEntry(referencePath, pidName) === "stale";
}

/** Why a reference write failed, and whether it left bytes behind that are not a record. */
export interface ReferenceWriteFailure {
	reason: string;
	/** Bytes of a truncated record are on disk: the file is unusable and must not be mistaken for one. */
	partialDelete: boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Write every byte of `contents` through `descriptor`, then put it on disk. Returns the failure,
 * or undefined when the whole record landed.
 *
 * A short write is not an error the filesystem reports: POSIX `write` stores what fits and
 * returns the count, and that is exactly what a full disk does to a reference record. Ignoring
 * the returned count is how a writer publishes a *truncated* record while believing it recorded
 * a reference - the reader then sees a file it cannot parse, which is why the reader keeps it and
 * why the writer must fail here. So the count is checked and the remainder retried, and the record
 * is fsynced before it is considered written: a reader has to see a complete record even if this
 * process dies right after the write returns.
 */
function writeCompleteFile(descriptor: number, contents: Buffer, filePath: string): ReferenceWriteFailure | undefined {
	let written = 0;
	while (written < contents.length) {
		let count: number;
		try {
			count = writeSync(descriptor, contents, written, contents.length - written);
		} catch (error) {
			return { reason: `${errorMessage(error)} (${filePath})`, partialDelete: written > 0 };
		}
		if (count <= 0) {
			return {
				reason: `short write: ${written} of ${contents.length} bytes (${filePath})`,
				partialDelete: written > 0,
			};
		}
		written += count;
	}
	try {
		fsyncSync(descriptor);
	} catch (error) {
		return { reason: `${errorMessage(error)} (${filePath})`, partialDelete: false };
	}
	return undefined;
}

/**
 * Create the reference directory and write one record; returns the failure, if any.
 *
 * The single writer both layouts use, so a short write cannot be silent in either:
 * the returned count is checked, the record is fsynced, and a caller that gets a
 * failure must publish a stronger signal (the venv layout writes a tombstone)
 * instead of leaving a truncated record to be read as "no reference".
 */
export function writeReferenceFileSync(
	filePath: string,
	dir: string,
	record: Record<string, unknown>,
): ReferenceWriteFailure | undefined {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// O_NOFOLLOW: a planted symlink at the reference path must not be written through. The
		// mode is re-asserted on the descriptor because the create mode only applies to a new
		// file (as in orphan-process-journal.ts).
		const descriptor = openSync(
			filePath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | requireNoFollow(constants.O_NOFOLLOW),
			0o600,
		);
		try {
			const failure = writeCompleteFile(descriptor, Buffer.from(`${JSON.stringify(record)}\n`), filePath);
			if (failure === undefined && process.platform !== "win32") fchmodSync(descriptor, 0o600);
			return failure;
		} finally {
			closeSync(descriptor);
		}
	} catch (error) {
		return { reason: errorMessage(error), partialDelete: false };
	}
}

/**
 * Drop one reference (or a pending-boot claim, or a tombstone): all are files in
 * the same directory and all are reclaimed by the same stale sweep. Synchronous
 * because teardown also runs from `process.on("exit")`; a missed release is
 * reclaimed by the next sweep (dead pid, or a live pid whose start identity no
 * longer matches).
 */
export function releaseReferenceFileSync(referencePath: string | undefined): void {
	if (!referencePath) return;
	try {
		rmSync(referencePath, { force: true });
	} catch {
		// Best effort: the stale sweep reclaims it.
	}
}
