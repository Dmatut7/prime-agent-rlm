import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "../../../src/core/tools/truncate.js";

/**
 * A command whose output ends with a newline and whose last line is larger than
 * the byte budget must still show the tail of that line. The trailing newline is
 * a terminator, not an empty final line: counted as one, it takes the only slot
 * the byte-budget branch checks before it keeps the tail, and the caller is
 * handed an empty string - the model reads "(no output)" while the full log sits
 * in a temp file, and the `!` bash panel shows a path instead of the output.
 */
describe("bash output tail truncation", () => {
	it("keeps the tail of an oversized last line that ends with a newline", () => {
		const line = "x".repeat(DEFAULT_MAX_BYTES + 60_000);
		const result = truncateTail(`${line}\n`);
		// Red before the fix: "" with truncated=true, so the output vanished.
		expect(result.truncated).toBe(true);
		expect(result.truncatedBy).toBe("bytes");
		expect(result.lastLinePartial).toBe(true);
		expect(result.content.length).toBeGreaterThan(0);
		expect(result.content.endsWith("\n")).toBe(true);
		// The kept tail is a suffix of the line, at the full byte budget: the trailing newline
		// terminates it, it does not eat into it.
		expect(line.endsWith(result.content.trimEnd())).toBe(true);
		expect(Buffer.byteLength(result.content.trimEnd(), "utf-8")).toBe(DEFAULT_MAX_BYTES);
	});

	it("keeps the same tail whether or not the last line ends with a newline", () => {
		const line = "y".repeat(DEFAULT_MAX_BYTES + 60_000);
		const withNewline = truncateTail(`${line}\n`);
		const withoutNewline = truncateTail(line);
		// Positive control: the newline-free shape always worked, so the two must agree
		// on the payload rather than one of them being empty.
		expect(withoutNewline.content.length).toBeGreaterThan(0);
		expect(withNewline.content.trimEnd()).toBe(withoutNewline.content);
	});

	it("still returns short output untouched, newline or not", () => {
		const short = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
		expect(truncateTail(`${short}\n`).content).toBe(`${short}\n`);
		expect(truncateTail(`${short}\n`).truncated).toBe(false);
		expect(truncateTail(short).content).toBe(short);
	});

	it("still reports how much output there was", () => {
		const line = "z".repeat(DEFAULT_MAX_BYTES + 60_000);
		const result = truncateTail(`${line}\n`);
		expect(result.totalBytes).toBe(Buffer.byteLength(`${line}\n`, "utf-8"));
		expect(result.maxLines).toBe(DEFAULT_MAX_LINES);
		expect(result.maxBytes).toBe(DEFAULT_MAX_BYTES);
	});
});
