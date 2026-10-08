import { describe, expect, it } from "vitest";
import { stripControlCharacters } from "../src/utils/sanitize-control.js";

/**
 * Cross-side consistency with the Python washer (prime-agent-runtime
 * src/rlm/effects.py `_ANSI_ESCAPE`, commit 046682ba9): both sides must stop an
 * OSC at its ST terminator instead of swallowing it and everything after it. A
 * CLI that prints an OSC 8 hyperlink followed by the real error line is the
 * production shape (claude-code stderr tails, proxy error bodies).
 */
describe("stripControlCharacters", () => {
	it("keeps the text after an ST-terminated OSC (does not swallow the terminator)", () => {
		const input = "prefix \x1b]8;;file:///x\x1b\\real error: auth failed";
		expect(stripControlCharacters(input)).toBe("prefix real error: auth failed");
	});

	it("keeps the text after a BEL-terminated OSC", () => {
		const input = "\x1b]8;;https://x\x07real error: auth failed";
		expect(stripControlCharacters(input)).toBe("real error: auth failed");
	});

	it("strips two consecutive OSC 8 hyperlinks and keeps the text between and after them", () => {
		const input = "\x1b]8;;file:///a\x1b\\link\x1b]8;;\x1b\\text after";
		expect(stripControlCharacters(input)).toBe("linktext after");
	});

	it("still strips CSI sequences and bare control characters", () => {
		expect(stripControlCharacters("a\x1b[2J\x07b\x0bc")).toBe("abc");
	});

	it("keeps payload newlines and tabs", () => {
		expect(stripControlCharacters("a\n\tb")).toBe("a\n\tb");
	});
});
