import {
	chmodSync,
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getLogger } from "@earendil-works/pi-ai";
import { repairTruncatedTrailingLine } from "../../utils/file-lines.js";

export interface WorkerRecoveryRecord {
	version: 1;
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	busy: boolean;
	operation: string;
	recordedAt: string;
}

/**
 * Compaction bounds. A worker writes one checkpoint per session event, so the
 * previous "every session is idle" gate never opened on a busy worker and the
 * journal grew without limit. The record bound matches the command journal's
 * COMPACT_AFTER_RECORDS precedent; the byte bound keeps a pathologically long
 * record from growing the file past it either.
 */
export const COMPACT_AFTER_RECORDS = 4096;
export const COMPACT_AFTER_BYTES = 4 * 1024 * 1024;

const structuredLog = getLogger("coding-agent.daemon.worker-recovery-journal");

interface ParsedJournal {
	latest: Map<string, WorkerRecoveryRecord>;
	/** Physical lines on disk, parsable or not: compaction is what removes them. */
	lineCount: number;
	byteLength: number;
}

function parseJournal(path: string): ParsedJournal {
	const latest = new Map<string, WorkerRecoveryRecord>();
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { latest, lineCount: 0, byteLength: 0 };
		}
		throw error;
	}
	let lineCount = 0;
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		lineCount++;
		let record: WorkerRecoveryRecord;
		try {
			record = JSON.parse(line) as WorkerRecoveryRecord;
		} catch {
			// A crash may leave only the final append truncated.
			continue;
		}
		if (
			record.version === 1 &&
			typeof record.activeSessionId === "string" &&
			typeof record.sessionId === "string" &&
			typeof record.busy === "boolean" &&
			typeof record.operation === "string"
		) {
			latest.set(record.activeSessionId, record);
		}
	}
	return { latest, lineCount, byteLength: Buffer.byteLength(contents) };
}

export class WorkerRecoveryJournal {
	private readonly latest: Map<string, WorkerRecoveryRecord>;
	private lineCount = 0;
	private byteLength = 0;
	private busyCount = 0;
	private compactionSequence = 0;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.cleanStaleCompactionTemps();
		// A crash can leave a torn final line; load skips it, so drop it from disk
		// too — the next append must not glue onto the torn bytes.
		repairTruncatedTrailingLine(path);
		const parsed = parseJournal(path);
		this.latest = parsed.latest;
		this.lineCount = parsed.lineCount;
		this.byteLength = parsed.byteLength;
		for (const record of this.latest.values()) {
			if (record.busy) {
				this.busyCount++;
			}
		}
		this.tightenPermissions();
	}

	/**
	 * openSync(path, "a", 0o600) applies the mode only when it creates the file,
	 * so a journal that already exists with looser permissions is tightened here.
	 * Appending never changes a file's mode, which is why this runs once instead
	 * of after every record.
	 */
	private tightenPermissions(): void {
		try {
			chmodSync(this.path, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				// Nothing on disk yet; the first append creates it with mode 0600.
				return;
			}
			structuredLog.warn("could not tighten worker recovery journal permissions", {
				path: this.path,
				error: String(error),
			});
		}
	}

	private cleanStaleCompactionTemps(): void {
		const prefix = `${basename(this.path)}.`;
		try {
			for (const name of readdirSync(dirname(this.path))) {
				if (name.startsWith(prefix) && name.endsWith(".tmp")) {
					rmSync(join(dirname(this.path), name), { force: true });
				}
			}
		} catch {
			// Stale temps only waste space; their cleanup must not break startup.
		}
	}

	record(input: Omit<WorkerRecoveryRecord, "version" | "recordedAt">): void {
		const previous = this.latest.get(input.activeSessionId);
		if (
			previous?.busy === input.busy &&
			previous.operation === input.operation &&
			previous.sessionFile === input.sessionFile
		) {
			return;
		}
		const record: WorkerRecoveryRecord = {
			version: 1,
			...input,
			recordedAt: new Date().toISOString(),
		};
		const line = `${JSON.stringify(record)}\n`;
		this.append(line);
		if (previous === undefined) {
			if (record.busy) {
				this.busyCount++;
			}
		} else if (previous.busy !== record.busy) {
			this.busyCount += record.busy ? 1 : -1;
		}
		this.latest.set(record.activeSessionId, record);
		this.lineCount++;
		this.byteLength += Buffer.byteLength(line);
		if (this.shouldCompact()) {
			this.compact();
		}
	}

	/** Counters keep this off the per-record path: no walk over every session. */
	private shouldCompact(): boolean {
		return this.busyCount === 0 || this.lineCount >= COMPACT_AFTER_RECORDS || this.byteLength >= COMPACT_AFTER_BYTES;
	}

	getLatest(): WorkerRecoveryRecord[] {
		return [...this.latest.values()];
	}

	static readLatest(path: string): WorkerRecoveryRecord[] {
		return [...parseJournal(path).latest.values()];
	}

	/**
	 * Append without fsync. The record lands in the page cache, which outlives
	 * the processes that read this journal, so a crashed worker or supervisor
	 * still recovers every record written here. Only a machine-wide power loss
	 * can drop the unflushed tail, and that tail is already outside the recovery
	 * contract: the loader skips unparsable lines and the constructor repairs a
	 * torn final line. compact() still fsyncs before its rename, so the complete
	 * latest set becomes durable at least once per COMPACT_AFTER_RECORDS records.
	 */
	private append(line: string): void {
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			writeSync(descriptor, line);
		} finally {
			closeSync(descriptor);
		}
	}

	private compact(): void {
		const content = `${[...this.latest.values()].map((record) => JSON.stringify(record)).join("\n")}\n`;
		this.writeCompacted(content);
		this.lineCount = this.latest.size;
		this.byteLength = Buffer.byteLength(content);
	}

	private writeCompacted(content: string): void {
		let firstError: unknown;
		try {
			this.writeCompactionTemp(content, this.nextCompactionTempPath());
			return;
		} catch (error) {
			// O_EXCL refuses a temp name that is still occupied, and clearing it can
			// fail too, so one retry with a fresh name is the only way out.
			firstError = error;
		}
		try {
			this.writeCompactionTemp(content, this.nextCompactionTempPath());
		} catch (error) {
			this.failCompaction(error, firstError);
		}
	}

	private writeCompactionTemp(content: string, tempPath: string): void {
		let descriptor: number | undefined;
		try {
			descriptor = openSync(
				tempPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
				0o600,
			);
			writeSync(descriptor, content);
			// This fsync is what makes the rename below safe: the canonical path must
			// never expose a partially written compaction result.
			fsyncSync(descriptor);
			closeSync(descriptor);
			descriptor = undefined;
			renameSync(tempPath, this.path);
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
			// After a successful rename the temp no longer exists; on failure this
			// removes the partial file instead of leaving it for the next startup.
			rmSync(tempPath, { force: true });
		}
	}

	/** Unique per attempt, so one leftover temp cannot block every later compaction. */
	private nextCompactionTempPath(): string {
		return `${this.path}.${process.pid}.${this.compactionSequence++}.tmp`;
	}

	private failCompaction(error: unknown, firstError?: unknown): never {
		// A journal that cannot compact grows without bound, and callers are allowed
		// to catch and continue, so the failure has to be visible on its own.
		structuredLog.warn("could not compact the worker recovery journal", {
			path: this.path,
			error: String(error),
			...(firstError === undefined ? {} : { firstAttemptError: String(firstError) }),
		});
		throw error;
	}
}
