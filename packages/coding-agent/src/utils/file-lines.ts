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
} from "node:fs";

export function readFirstLineSync(filePath: string, maxBytes = 64 * 1024): string | undefined {
	const fd = openSync(filePath, "r");
	const chunks: Buffer[] = [];
	let position = 0;

	try {
		const buffer = Buffer.alloc(1024);
		while (position < maxBytes) {
			const bytesToRead = Math.min(buffer.length, maxBytes - position);
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
		}
	} finally {
		closeSync(fd);
	}

	if (chunks.length === 0) {
		return undefined;
	}
	return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
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
 */
export async function* readFileLines(filePath: string, startOffset = 0): AsyncGenerator<FileLine> {
	const pendingParts: Buffer[] = [];
	let pendingBytes = 0;
	let consumed = startOffset;
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
			consumed += end - start + 1;
			yield { line, endOffset: consumed, terminated: true };
			start = end + 1;
		}
	}
	if (pendingParts.length > 0) {
		const line = Buffer.concat(pendingParts, pendingBytes);
		pendingParts.length = 0;
		pendingBytes = 0;
		yield { line, endOffset: consumed + line.length, terminated: false };
	}
}

export async function* readLinesAsBuffers(filePath: string): AsyncGenerator<Buffer> {
	for await (const entry of readFileLines(filePath)) {
		yield entry.line;
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
