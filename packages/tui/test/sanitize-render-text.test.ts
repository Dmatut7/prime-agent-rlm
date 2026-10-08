import assert from "node:assert";
import { describe, it } from "node:test";
import { sanitizeRenderText } from "../src/utils.js";

/**
 * The central render gate: everything a component did not paint itself goes
 * through here before the terminal sees it. The kept kinds are exactly two -
 * plain SGR codes and a terminated OSC 8 - and every other sequence leaves
 * nothing behind, not even its parameter bytes.
 */
describe("sanitizeRenderText", () => {
	it("keeps a plain SGR code, including colon subparameters", () => {
		assert.strictEqual(sanitizeRenderText("a\x1b[31mb\x1b[4:3mc"), "a\x1b[31mb\x1b[4:3mc");
	});

	it("keeps an OSC 8 hyperlink only when its terminator is present", () => {
		assert.strictEqual(
			sanitizeRenderText("\x1b]8;;http://x\u0007link\x1b]8;;\u0007"),
			"\x1b]8;;http://x\u0007link\x1b]8;;\u0007",
		);
		assert.strictEqual(
			sanitizeRenderText("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"),
			"\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\",
		);
		// An unterminated OSC 8 would stay open in the terminal and eat the rows
		// after it: everything from the introducer goes.
		assert.strictEqual(sanitizeRenderText("done\x1b]8;;abc"), "done");
	});

	it("drops a keyboard-mode CSI that ends in m instead of passing it as an SGR", () => {
		// `CSI > Ps ; Ps m` is XTMODKEYS, not a color.
		assert.strictEqual(sanitizeRenderText("a\x1b[>4;1mb"), "ab");
	});

	it("drops a CSI with intermediate bytes whole, leaving no parameter debris", () => {
		assert.strictEqual(sanitizeRenderText("a\x1b[1 qb"), "ab");
	});

	it("drops DCS, APC, SOS and PM sequences whole", () => {
		assert.strictEqual(sanitizeRenderText("a\x1bP1$r\x1b\\b"), "ab");
		assert.strictEqual(sanitizeRenderText("a\x1b_pi:c\u0007b"), "ab");
		assert.strictEqual(sanitizeRenderText("a\x1b^pm\x1b\\b"), "ab");
		assert.strictEqual(sanitizeRenderText("a\x1bXsos\x1b\\b"), "ab");
	});

	it("drops an OSC 52 clipboard write and a screen clear", () => {
		assert.strictEqual(sanitizeRenderText("a\x1b]52;c;cGFzdGU=\u0007b\x1b[2Jc"), "abc");
	});

	it("drops two-byte escapes and unterminated sequences without residue", () => {
		assert.strictEqual(sanitizeRenderText("a\x1bMb\x1b7c"), "abc");
		assert.strictEqual(sanitizeRenderText("tail\x1b[2J"), "tail");
	});

	it("drops every bare control character but newline and tab", () => {
		assert.strictEqual(sanitizeRenderText("a\u0007b\rc\u007fd\u009be"), "abcde");
		assert.strictEqual(sanitizeRenderText("a\nb\tc"), "a\nb\tc");
	});
});
