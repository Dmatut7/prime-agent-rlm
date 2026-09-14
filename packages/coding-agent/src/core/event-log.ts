import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { sleepSync } from "../utils/sleep.js";

/**
 * Append-only JSONL event log: the shared crash-safety substrate under the
 * RLM spawn ledger and the ACP semantic-edge ledger.
 *
 * Appends are single O_APPEND writes (PIPE_BUF-scale sizes, whose atomicity
 * multi-writer consumers rely on for interleaving), fsynced only when the
 * caller needs durability. Replay tolerates exactly one torn FINAL line
 * (rejected by the consumer's parser AND unterminated: a crashed writer's
 * in-progress append) and fails closed on any malformed interior line.
 * Repair happens only on append, never on read — a viewer may replay a live
 * writer's log. EVERY unterminated tail a dead writer left is blanked in
 * place, even one that parses as JSON: completing it with a newline would turn
 * a line a strict consumer parser rejects into permanent fail-closed interior
 * poison, and deleting it would cut out a concurrent writer's complete record.
 * A tail a LIVE writer is still appending is never blanked: the repair watches
 * the tail for quiescence first, and refuses the append when it cannot tell a
 * crashed writer from a slow one. Unifying consumers keeps the union of their
 * safety behaviors.
 */

/**
 * Idle window by which a torn final line is judged to belong to a crashed
 * writer rather than to one still writing it (`tailQuiescenceMs`).
 *
 * The window has to outlast the gaps between the syscalls of one append, which
 * are sub-millisecond for a single writer, and stay short enough that the first
 * append after a crash is not delayed noticeably. Note the assumption this
 * class already documents: a compliant append is ONE write, so a tail that is
 * still growing is a writer this substrate cannot reason about - a foreign
 * appender, or an append split by a short write.
 */
export const TAIL_QUIESCENCE_MS = 25;

/** How often the tail is probed while it is being watched, so progress is seen inside one window. */
const TAIL_PROBE_SLICE_MS = 5;

/**
 * How many quiescence windows a tail may keep progressing for before the repair
 * gives up on it: a writer that is still appending after this long is live, and
 * blanking its bytes would destroy a record it is still writing.
 */
const TAIL_OBSERVATION_WINDOWS = 4;

export interface EventLogOptions {
	/** Fail closed beyond these bounds on every full read, including the repair path. */
	maxBytes?: number;
	maxRecords?: number;
	log?: (message: string) => void;
	/**
	 * Idle window a torn final line must stay unchanged for before the repair
	 * blanks it (default: {@link TAIL_QUIESCENCE_MS}).
	 */
	tailQuiescenceMs?: number;
}

/** Bounded read through the descriptor: the size check and the allocation see the same fd, so a concurrent grow cannot bypass the bound. */
function readAllSync(fd: number, maxBytes: number | undefined, path: string): Buffer {
	const size = fstatSync(fd).size;
	if (maxBytes !== undefined && size > maxBytes) {
		throw new Error(`event log ${path} exceeds ${maxBytes} bytes (${size}); refusing to read`);
	}
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return buffer.subarray(0, offset);
}

/**
 * Positional write of a whole buffer at an explicit offset. A single writeSync
 * may return a short count without throwing (a file-size limit or ENOSPC does
 * exactly that), which would leave part of a blanked fragment behind.
 */
function writeAllSync(fd: number, contents: Buffer, position: number): void {
	let offset = 0;
	while (offset < contents.length) {
		const written = writeSync(fd, contents, offset, contents.length - offset, position + offset);
		if (written <= 0) {
			throw new Error(`event log write stalled at byte ${position + offset}`);
		}
		offset += written;
	}
}

/** The blanked range: `keep` is its first byte and `end` the offset just past its last. */
type TailRepair = { keep: number; end: number };

/** Whether the file ends on an unterminated tail: nothing after its last newline. */
function hasTornTail(fd: number, size: number): boolean {
	if (size === 0) {
		return false;
	}
	const lastByte = Buffer.alloc(1);
	return readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 0x0a;
}

/** Whether [position, position + length) reads back as the blanks the repair wrote. */
function rangeIsBlank(fd: number, position: number, length: number): boolean {
	const buffer = Buffer.alloc(length);
	let read = 0;
	while (read < length) {
		const bytesRead = readSync(fd, buffer, read, length - read, position + read);
		if (bytesRead <= 0) {
			return false;
		}
		read += bytesRead;
	}
	return buffer.every((byte) => byte === 0x20);
}

function serializeLine(event: unknown): string {
	const serialized = JSON.stringify(event);
	if (typeof serialized !== "string") {
		throw new TypeError("event is not JSON-serializable");
	}
	return `${serialized}\n`;
}

export class EventLog {
	constructor(
		readonly path: string,
		private readonly options: EventLogOptions = {},
	) {}

	/**
	 * Replay every line through `parse`. `parse` throws for a line it rejects
	 * (fail-closed for interior lines, tolerated for a torn final line) and
	 * returns undefined for a line it deliberately skips.
	 */
	replaySync<T>(parse: (line: string, index: number) => T | undefined): T[] {
		const { maxBytes, maxRecords } = this.options;
		let fd: number;
		try {
			fd = openSync(this.path, "r");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		let contents: string;
		try {
			contents = readAllSync(fd, maxBytes, this.path).toString("utf8");
		} finally {
			closeSync(fd);
		}
		const endsWithNewline = contents.endsWith("\n");
		const rawLines = contents.split("\n");
		const events: T[] = [];
		let recordCount = 0;
		for (let index = 0; index < rawLines.length; index++) {
			const line = rawLines[index].trim();
			if (!line) continue;
			if (maxRecords !== undefined && ++recordCount > maxRecords) {
				throw new Error(`event log ${this.path} exceeds ${maxRecords} records; refusing to read`);
			}
			let event: T | undefined;
			try {
				event = parse(line, index);
			} catch (error) {
				if (index === rawLines.length - 1 && !endsWithNewline) {
					this.options.log?.(`ignored torn final line: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
				throw error;
			}
			if (event !== undefined) events.push(event);
		}
		return events;
	}

	/**
	 * Append events as one write; `durable` fsyncs before returning. When the
	 * file is created by this append, `onCreate`'s records lead the payload.
	 * An unserializable event throws before any byte (including repair) is
	 * written.
	 */
	appendSync(events: unknown[], options?: { durable?: boolean; onCreate?: () => unknown[] }): void {
		const lines = events.map(serializeLine);
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		let leadLines: string[] = [];
		if (existsSync(this.path)) {
			this.repairTailSync();
		} else {
			leadLines = (options?.onCreate?.() ?? []).map(serializeLine);
		}
		const payload = [...leadLines, ...lines].join("");
		const handle = openSync(this.path, "a", 0o600);
		try {
			writeSync(handle, payload);
			if (options?.durable) fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
	}

	/**
	 * Neutralize a torn final line from a crashed writer before appending:
	 * otherwise the append would glue the fragment onto the following record and
	 * turn a tolerable torn tail into a fail-closed interior line. The fragment's
	 * bytes were never readable data.
	 *
	 * The fragment is BLANKED IN PLACE (the same byte count, all spaces) rather
	 * than truncated to the last newline. Truncation is only correct against the
	 * snapshot it was computed from: a concurrent writer that appends a complete
	 * record after that snapshot is cut out of the log, because `ftruncate(keep)`
	 * removes every byte at or above an offset that was already EOF when the
	 * snapshot was read. Both writers still report success, so a lost
	 * spawn/rename/delete record is silent.
	 *
	 * A blanking write cannot do that. It only overwrites bytes BELOW the size it
	 * just read, and this class never removes bytes, so every append — ours, a
	 * foreign process's, and a repair's own trailing append — starts at or above
	 * the EOF, which is at or above that size. A complete concurrent record is
	 * therefore never inside the target range. Two repairs racing on the same
	 * fragment write the same spaces to the same offsets (the fragment holds no
	 * newline by construction, so `keep` is invariant under blanking), which
	 * makes the repair idempotent and commutative.
	 *
	 * Readers need no change: `replaySync` trims each line, so blanked bytes are
	 * skipped as whitespace, and the record appended after the fragment reads back
	 * as its own line.
	 *
	 * What blanking must NOT do is destroy a record that is still being written.
	 * The single-write append this class documents makes that unreachable for a
	 * compliant writer, but a foreign appender (or an append split by a short
	 * write) can leave a tail that is mid-record rather than dead. So the bytes
	 * are blanked only after the tail has been observed UNCHANGED for a
	 * quiescence window (`tailQuiescenceMs`), and the observed EOF — not a later
	 * one — bounds the blanked range. A tail that is still growing is a live
	 * writer's record: its bytes are left alone, a tail that has meanwhile ended
	 * on a newline needs no repair at all, and a tail that keeps growing past the
	 * observation budget refuses the append instead of gambling on it.
	 */
	private repairTailSync(): void {
		const { maxBytes } = this.options;
		let size: number;
		try {
			size = statSync(this.path).size;
		} catch {
			return;
		}
		if (size === 0) return;
		// Fail closed loudly at the read bound BEFORE the swallowing repair
		// try-block: an oversized log must never trigger a file-sized
		// allocation, and the error must not be silenced as a repair failure.
		if (maxBytes !== undefined && size > maxBytes) {
			throw new Error(`event log ${this.path} exceeds ${maxBytes} bytes (${size}); refusing to read`);
		}
		// All offsets are BYTE offsets on raw buffers: string indices diverge
		// from byte offsets as soon as any record carries multi-byte UTF-8,
		// and a positional write takes bytes.
		let outcome: TailRepair | "contended" | undefined;
		try {
			const fd = openSync(this.path, "r+");
			try {
				outcome = this.repairObservedTail(fd, maxBytes);
			} finally {
				closeSync(fd);
			}
		} catch {
			// Leave the tail for the reader's torn-line tolerance.
			return;
		}
		if (outcome === "contended") {
			// Appending would glue our record onto a tail a live writer still owns,
			// and blanking it would destroy that writer's bytes. Refusing loses this
			// append instead of the log: the caller can retry once the tail settles.
			throw new Error(
				`event log ${this.path}: the unterminated final line is still being appended; refusing to append`,
			);
		}
		if (outcome !== undefined) {
			this.options.log?.(`blanked torn final line (${outcome.end - outcome.keep} bytes)`);
		}
	}

	/**
	 * Watch the unterminated tail until it is either whole, quiescent, or clearly
	 * live, and blank it only in the quiescent case.
	 *
	 * `undefined` means there was nothing to neutralize: the file ends on a
	 * newline (a live writer completed its record, or another repair closed it).
	 */
	private repairObservedTail(fd: number, maxBytes: number | undefined): TailRepair | "contended" | undefined {
		// A window of zero would blank a tail on sight, which is the behavior this
		// observation exists to avoid.
		const quiescenceMs = Math.max(1, this.options.tailQuiescenceMs ?? TAIL_QUIESCENCE_MS);
		let observedSize = fstatSync(fd).size;
		if (!hasTornTail(fd, observedSize)) return undefined;
		const observationStart = performance.now();
		let stableSince = observationStart;
		const observationEnd = observationStart + quiescenceMs * TAIL_OBSERVATION_WINDOWS;
		for (;;) {
			const quiescentAt = stableSince + quiescenceMs;
			const untilQuiescent = quiescentAt - performance.now();
			if (untilQuiescent <= 0) break;
			sleepSync(Math.min(untilQuiescent, TAIL_PROBE_SLICE_MS));
			const currentSize = fstatSync(fd).size;
			// A tail that now ends on a newline is not a fragment any more: a writer
			// that was mid-record finished it, so its bytes are a readable record.
			if (!hasTornTail(fd, currentSize)) return undefined;
			if (currentSize !== observedSize) {
				// The tail is still growing, so a live writer owns it. Restart the
				// window; only bytes that stopped changing are a crashed writer's.
				observedSize = currentSize;
				stableSince = performance.now();
				if (stableSince >= observationEnd) return "contended";
			}
		}
		// The observed EOF, not a later one, bounds the range: bytes a writer
		// appended after it are not ours to blank.
		const contents = readAllSync(fd, maxBytes, this.path);
		// A foreign truncation is the one way the file can be shorter than the tail
		// this repair observed; blank at most what it actually holds.
		const end = Math.min(observedSize, contents.length);
		const keep = contents.lastIndexOf(0x0a, end - 1) + 1;
		const torn = end - keep;
		if (torn <= 0) return undefined;
		writeAllSync(fd, Buffer.alloc(torn, 0x20), keep);
		if (!rangeIsBlank(fd, keep, torn)) {
			this.options.log?.(`torn final line (${torn} bytes) changed while it was being blanked`);
			return undefined;
		}
		return { keep, end };
	}
}
