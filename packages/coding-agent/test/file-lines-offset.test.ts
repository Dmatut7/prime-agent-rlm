import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FileLine, isLineBoundarySync, isUsableResumePoint, readFileLines } from "../src/utils/file-lines.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-file-lines-offset-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function collect(path: string): Promise<FileLine[]> {
	const entries: FileLine[] = [];
	for await (const entry of readFileLines(path)) entries.push(entry);
	return entries;
}

/** Byte offset just past each line's newline, computed independently of the reader. */
function expectedOffsets(lines: string[]): number[] {
	let total = 0;
	return lines.map((line) => {
		total += Buffer.byteLength(line, "utf8") + 1;
		return total;
	});
}

describe("readFileLines endOffset accounting", () => {
	/**
	 * A line longer than the 64 KiB read chunk is delivered as several stream
	 * chunks. Every offset after it is only correct if the bytes buffered in the
	 * chunks before the terminating newline are counted; counting just the final
	 * fragment makes the offset fall permanently behind the real file position.
	 */
	it("counts bytes buffered across chunks so endOffset equals the file size", async () => {
		const path = join(dir, "long-line.jsonl");
		const longLine = "L".repeat(200 * 1024);
		const lines = ['{"type":"a"}', longLine, '{"type":"b"}', '{"type":"c"}'];
		writeFileSync(path, `${lines.map((line) => `${line}\n`).join("")}`, "utf8");
		const size = statSync(path).size;

		const entries = await collect(path);

		expect(entries.map((entry) => entry.endOffset)).toEqual(expectedOffsets(lines));
		expect(entries.at(-1)?.endOffset).toBe(size);
		expect(entries.at(-1)?.line.toString("utf8")).toBe('{"type":"c"}');
	});

	/** The same accounting when the chunk-spanning line is the last one, terminated. */
	it("reaches the file size when the chunk-spanning line ends the file", async () => {
		const path = join(dir, "tail-line.jsonl");
		const longLine = "T".repeat(150 * 1024);
		const lines = ['{"type":"a"}', longLine];
		writeFileSync(path, `${lines.map((line) => `${line}\n`).join("")}`, "utf8");
		const size = statSync(path).size;

		const entries = await collect(path);

		expect(entries.map((entry) => entry.endOffset)).toEqual(expectedOffsets(lines));
		expect(entries.at(-1)?.endOffset).toBe(size);
	});

	/**
	 * A trailing line with no newline is a write still in progress. Its offset is
	 * not a resume point, but it must still be reported as the position the read
	 * actually reached, or a caller deriving the file size from it drifts.
	 */
	it("reports the read position for an unterminated tail spanning chunks", async () => {
		const path = join(dir, "torn-line.jsonl");
		const longLine = "U".repeat(150 * 1024);
		writeFileSync(path, `{"type":"a"}\n${longLine}`, "utf8");
		const size = statSync(path).size;

		const entries = await collect(path);

		expect(entries).toHaveLength(2);
		expect(entries[0]?.endOffset).toBe(13);
		expect(entries[1]?.terminated).toBe(false);
		expect(entries[1]?.endOffset).toBe(size);
	});
});

describe("isLineBoundarySync", () => {
	it("accepts the file start and offsets just past a newline, and rejects offsets inside a line", async () => {
		const path = join(dir, "boundaries.jsonl");
		const longLine = "L".repeat(150 * 1024);
		writeFileSync(path, `{"type":"a"}\n${longLine}\n{"type":"b"}\n`, "utf8");

		expect(isLineBoundarySync(path, 0)).toBe(true);
		expect(isLineBoundarySync(path, 13)).toBe(true);
		// Inside the chunk-spanning line: not a position a read may resume from.
		expect(isLineBoundarySync(path, 1000)).toBe(false);
		expect(isLineBoundarySync(path, 150 * 1024)).toBe(false);
		expect(isLineBoundarySync(path, statSync(path).size)).toBe(true);
		expect(isLineBoundarySync(path, statSync(path).size + 1)).toBe(false);
	});
});

describe("isUsableResumePoint", () => {
	it("rejects the resume point a chunk-losing reader leaves behind", () => {
		// Measured on a real live transcript of 13,132,498 bytes: a reader that
		// counted only the closing fragment of each chunk-spanning line stopped at
		// 9,015,348 and recorded that as how far it had read. Keeping 4.1 MB
		// unaccounted for is what let the next append re-count 2,079 entries.
		expect(isUsableResumePoint({ offset: 9015348, reachedBytes: 9015348 }, 13132498)).toBe(false);
	});

	it("accepts a point that accounts for the bytes the read reached", () => {
		expect(isUsableResumePoint({ offset: 2003, reachedBytes: 2003 }, 2003)).toBe(true);
		// A read that ends on a torn trailing line reaches further than its offset:
		// the offset stays before the tail, the reach covers it.
		expect(isUsableResumePoint({ offset: 2003, reachedBytes: 4096 }, 4096)).toBe(true);
		// A file that grew while it was being read reaches past the recorded size.
		expect(isUsableResumePoint({ offset: 2003, reachedBytes: 5000 }, 4096)).toBe(true);
	});

	it("rejects a point that reaches past the bytes it was derived from or is not a position at all", () => {
		expect(isUsableResumePoint({ offset: 3000, reachedBytes: 2003 }, 2003)).toBe(false);
		expect(isUsableResumePoint({ offset: -1, reachedBytes: 2003 }, 2003)).toBe(false);
		// A state recorded before the reach was tracked carries no usable answer.
		expect(isUsableResumePoint({ offset: 2003, reachedBytes: Number.NaN }, 2003)).toBe(false);
	});
});
