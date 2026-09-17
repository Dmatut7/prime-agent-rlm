import {
	closeSync,
	constants,
	createReadStream,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	lstatSync,
	openSync,
	readSync,
	statSync,
} from "node:fs";

/**
 * Hard ceiling on the first line a caller will materialize. A session header is
 * one short line of metadata, so a first line this long is not a header; the
 * read must not turn it into one by handing back a prefix.
 */
export const MAX_FIRST_LINE_BYTES = 1024 * 1024;

/**
 * Raised instead of returning the first `maxBytes` of a line that has no
 * newline in them. A truncated prefix is not "the first line": a caller that
 * parses it fails on a record that is intact on disk, and a caller that only
 * checks the prefix reports "no session" for a file that has one.
 */
export class FirstLineTooLongError extends Error {
	readonly filePath: string;
	readonly maxBytes: number;

	constructor(filePath: string, maxBytes: number) {
		super(`first line of ${filePath} has no newline within ${maxBytes} bytes`);
		this.name = "FirstLineTooLongError";
		this.filePath = filePath;
		this.maxBytes = maxBytes;
	}
}

/**
 * Read one complete physical line from the head of `filePath`.
 *
 * Returns the line without its terminator and without a trailing `\r`; an
 * unterminated first line is returned as-is (the whole file is that line).
 * Undefined means the file is empty. A first line longer than `maxBytes`
 * throws {@link FirstLineTooLongError} rather than yielding a prefix of it.
 */
export function readFirstLineSync(filePath: string, maxBytes = MAX_FIRST_LINE_BYTES): string | undefined {
	if (!(maxBytes > 0)) {
		throw new RangeError("maxBytes must be positive");
	}
	const fd = openSync(filePath, "r");
	const chunks: Buffer[] = [];
	let position = 0;

	try {
		const buffer = Buffer.alloc(64 * 1024);
		for (;;) {
			// Read one byte past the ceiling so a line exactly `maxBytes` long, whose
			// terminator is the next byte, is still returned instead of rejected.
			const bytesToRead = Math.min(buffer.length, maxBytes + 1 - position);
			const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
			if (bytesRead === 0) {
				break;
			}

			const chunk = buffer.subarray(0, bytesRead);
			const newlineIndex = chunk.indexOf(0x0a);
			if (newlineIndex !== -1) {
				chunks.push(Buffer.from(chunk.subarray(0, newlineIndex)));
				return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
			}

			chunks.push(Buffer.from(chunk));
			position += bytesRead;
			if (position > maxBytes) {
				throw new FirstLineTooLongError(filePath, maxBytes);
			}
		}
	} finally {
		closeSync(fd);
	}

	if (chunks.length === 0) {
		return undefined;
	}
	return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
}

/** Read the bytes in [start, endExclusive), stopping early at EOF. */
export function readBytesSync(filePath: string, start: number, endExclusive: number): Buffer {
	const length = Math.max(0, endExclusive - start);
	const buffer = Buffer.alloc(length);
	const fd = openSync(filePath, "r");
	try {
		let offset = 0;
		while (offset < length) {
			const bytesRead = readSync(fd, buffer, offset, length - offset, start + offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return buffer.subarray(0, offset);
	} finally {
		closeSync(fd);
	}
}

export interface ReadLinesRange {
	start?: number;
	/** Inclusive, as in createReadStream: bounds the read to a stat() snapshot so a growing file cannot extend the scan. */
	end?: number;
}

export async function* readLinesAsBuffers(filePath: string, range?: ReadLinesRange): AsyncGenerator<Buffer> {
	const pendingParts: Buffer[] = [];
	let pendingBytes = 0;
	for await (const chunk of createReadStream(filePath, range)) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let start = 0;
		while (start < buffer.length) {
			const end = buffer.indexOf(0x0a, start);
			if (end === -1) {
				const part = buffer.subarray(start);
				pendingParts.push(part);
				pendingBytes += part.length;
				break;
			}
			if (pendingParts.length > 0) {
				const part = buffer.subarray(start, end);
				pendingParts.push(part);
				const line = Buffer.concat(pendingParts, pendingBytes + part.length);
				pendingParts.length = 0;
				pendingBytes = 0;
				yield line;
			} else {
				yield buffer.subarray(start, end);
			}
			start = end + 1;
		}
	}
	if (pendingParts.length > 0) {
		const line = Buffer.concat(pendingParts, pendingBytes);
		pendingParts.length = 0;
		pendingBytes = 0;
		yield line;
	}
}

export interface FileLine {
	line: Buffer;
	/**
	 * Byte offset just past this line's terminating newline. Only meaningful
	 * when `terminated` is true; a caller resuming a later read must not start
	 * past the last terminated line, because an unterminated tail is a write
	 * still in progress.
	 */
	endOffset: number;
	/** False for a trailing line with no newline, which a later append may extend. */
	terminated: boolean;
}

/**
 * Yield each newline-separated line together with where it ends, starting at
 * `startOffset`. A caller that only wants the text should use
 * `readLinesAsBuffers`.
 *
 * `endOffset` is derived from the stream position, not from the bytes yielded:
 * a chunk starts at `startOffset` plus the length of every chunk before it, so a
 * line whose terminating newline sits at index `end` of the current chunk ends
 * at `chunkStartOffset + end + 1`. The bytes of that line that arrived in
 * earlier chunks are already inside `chunkStartOffset`; adding only the closing
 * fragment is what makes an offset fall behind the file for any line longer than
 * a chunk, and the offset is a resume point for the next read.
 */
export async function* readFileLines(filePath: string, startOffset = 0): AsyncGenerator<FileLine> {
	const pendingParts: Buffer[] = [];
	let pendingBytes = 0;
	let chunkStartOffset = startOffset;
	for await (const chunk of createReadStream(filePath, { start: startOffset })) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let start = 0;
		while (start < buffer.length) {
			const end = buffer.indexOf(0x0a, start);
			if (end === -1) {
				const part = buffer.subarray(start);
				pendingParts.push(part);
				pendingBytes += part.length;
				break;
			}
			let line: Buffer;
			if (pendingParts.length > 0) {
				const part = buffer.subarray(start, end);
				pendingParts.push(part);
				line = Buffer.concat(pendingParts, pendingBytes + part.length);
				pendingParts.length = 0;
				pendingBytes = 0;
			} else {
				line = buffer.subarray(start, end);
			}
			yield { line, endOffset: chunkStartOffset + end + 1, terminated: true };
			start = end + 1;
		}
		chunkStartOffset += buffer.length;
	}
	if (pendingParts.length > 0) {
		const line = Buffer.concat(pendingParts, pendingBytes);
		pendingParts.length = 0;
		pendingBytes = 0;
		// Unterminated tail: its end is where the read stopped, which is the last
		// chunk's own end. Callers must not resume from it (a later append may
		// still extend the line), but it does say how far this read got.
		yield { line, endOffset: chunkStartOffset, terminated: false };
	}
}

/**
 * Whether the file's last byte is a newline, i.e. whether every line in it is
 * terminated. An empty or unreadable file counts as terminated: it has no line to
 * leave hanging.
 */
export function endsWithNewlineSync(filePath: string): boolean {
	let size: number;
	try {
		size = statSync(filePath).size;
	} catch {
		return true;
	}
	if (size === 0) return true;
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return true;
	}
	try {
		const lastByte = Buffer.allocUnsafe(1);
		return readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] === 0x0a;
	} catch {
		return true;
	} finally {
		closeSync(fd);
	}
}

export interface ResumePoint {
	/** Byte offset just past the last newline-terminated line the read consumed. */
	offset: number;
	/** Byte position the read actually reached, `offset` included. */
	reachedBytes: number;
}

/**
 * Whether a recorded resume point may be used again.
 *
 * A read that stops at EOF reaches the size the file had when it was read, or
 * more if the file grew while being read — never less. A point that claims
 * fewer reached bytes than the size recorded beside it cannot account for the
 * bytes it was supposed to have consumed, so resuming from it would re-read and
 * re-count entries the previous read already counted. Callers that keep a
 * resume point across appends must reject such a point and start over.
 */
export function isUsableResumePoint(point: ResumePoint, recordedSize: number): boolean {
	if (!Number.isInteger(point.offset) || !Number.isInteger(point.reachedBytes)) return false;
	if (point.offset < 0 || point.offset > point.reachedBytes) return false;
	return point.reachedBytes >= recordedSize;
}

/**
 * Whether `offset` is a byte position a read may resume from: the start of the
 * file, or just past a newline. An offset that is not on a line boundary points
 * into the middle of a record — a rewritten file, or a resume point recorded
 * before the terminator was seen — and resuming there would misparse the rest of
 * that line instead of failing loudly.
 */
export function isLineBoundarySync(filePath: string, offset: number): boolean {
	if (offset === 0) return true;
	if (offset < 0) return false;
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return false;
	}
	try {
		const lastByte = Buffer.allocUnsafe(1);
		return readSync(fd, lastByte, 0, 1, offset - 1) === 1 && lastByte[0] === 0x0a;
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

/**
 * Drop a trailing unterminated line (a crash-torn append) from an append-only
 * line file so the next append does not glue onto the torn bytes. No-op when
 * the file is missing, empty, or already ends with a newline. Readers already
 * skip such a tail; this makes the on-disk state agree with them before the
 * next write.
 */
export function repairTruncatedTrailingLine(filePath: string): void {
	// Never repair through a symlink: a swapped-in link would otherwise have its
	// target truncated before any O_NOFOLLOW check sees it. Callers that reject
	// symlinked files still perform their own validation; this keeps the helper
	// itself harmless regardless of call order.
	let lexical: ReturnType<typeof lstatSync>;
	try {
		lexical = lstatSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (lexical.isSymbolicLink() || !lexical.isFile()) return;
	let fd: number;
	try {
		fd = openSync(filePath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	try {
		const { size } = fstatSync(fd);
		if (size === 0) return;
		const lastByte = Buffer.allocUnsafe(1);
		readSync(fd, lastByte, 0, 1, size - 1);
		if (lastByte[0] === 0x0a) return;
		// Scan backwards for the last newline; a torn tail is one partial line,
		// so the first 64 KiB chunk almost always answers.
		const chunkSize = 64 * 1024;
		let keepBytes = 0;
		let offset = Math.max(0, size - chunkSize);
		for (;;) {
			const length = Math.min(chunkSize, size - offset);
			const chunk = Buffer.allocUnsafe(length);
			readSync(fd, chunk, 0, length, offset);
			const index = chunk.lastIndexOf(0x0a);
			if (index !== -1) {
				keepBytes = offset + index + 1;
				break;
			}
			if (offset === 0) break;
			offset = Math.max(0, offset - chunkSize);
		}
		if (keepBytes < size) {
			ftruncateSync(fd, keepBytes);
			fsyncSync(fd);
		}
	} finally {
		closeSync(fd);
	}
}
