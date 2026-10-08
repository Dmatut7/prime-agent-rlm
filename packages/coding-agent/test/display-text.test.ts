import { describe, expect, it } from "vitest";
import { sanitizeBlockText, sanitizeRowText, sliceGraphemes } from "../src/utils/display-text.js";

/**
 * The vectors a model (or a page it read) puts into a subagent name, a report, a
 * command or a file path: a clipboard write, a screen clear, a bell, a carriage
 * return that rewinds the row, a newline that turns one row into two, and the
 * color codes that would let the text paint over the face rendering it.
 */
const OSC52 = "\u001b]52;c;cGFzdGU=\u0007";
const CLEAR = "\u001b[2J\u001b[H";
const SGR = "\u001b[31m";
const RESET = "\u001b[0m";
const HYPERLINK = "\u001b]8;;http://evil.example\u0007";

describe("sanitizeRowText", () => {
	it("drops an OSC 52 clipboard write and a screen clear", () => {
		expect(sanitizeRowText(`worker${OSC52}${CLEAR}`)).toBe("worker");
	});

	it("drops a bare BEL, a CR and the color codes the row paints itself", () => {
		// The central `Text` gate drops a control character outright rather than
		// widening it to a space; this wash reads the same.
		expect(sanitizeRowText(`a\u0007b\rc${SGR}red${RESET}`)).toBe("abcred");
	});

	it("keeps one physical row when a name carries a newline", () => {
		const washed = sanitizeRowText("lane\nsecond row");
		expect(washed).toBe("lane second row");
		expect(washed).not.toContain("\n");
	});

	it("drops an OSC 8 hyperlink, so the text cannot invent a click target", () => {
		expect(sanitizeRowText(`${HYPERLINK}click me\u001b]8;;\u0007`)).toBe("click me");
	});

	it("drops an unterminated escape sequence instead of leaving its residue", () => {
		expect(sanitizeRowText("done\u001b[2J")).toBe("done");
		expect(sanitizeRowText("tail\u001b]52;c;cGFzdGU=")).toBe("tail");
	});

	it("leaves ordinary text, CJK and emoji alone", () => {
		expect(sanitizeRowText("车道 C 交回：没问题 🎉")).toBe("车道 C 交回：没问题 🎉");
	});
});

describe("sanitizeBlockText", () => {
	it("keeps the line breaks a report is shaped by", () => {
		expect(sanitizeBlockText("one\ntwo")).toBe("one\ntwo");
	});

	it("drops an OSC 52 and a screen clear from a multi-line body", () => {
		expect(sanitizeBlockText(`line one${OSC52}\n${CLEAR}line two`)).toBe("line one\nline two");
	});

	it("widens a tab to the four spaces the diff rows use", () => {
		expect(sanitizeBlockText("a\tb")).toBe("a    b");
	});

	it("drops a CR that would rewind the row", () => {
		expect(sanitizeBlockText("a\rb")).toBe("ab");
	});

	it("drops a DEL and a C1 control the older display washer kept", () => {
		expect(sanitizeBlockText("a\u007fb\u009bc")).toBe("abc");
	});
});

describe("sliceGraphemes", () => {
	it("never leaves half a surrogate pair at the cut", () => {
		// "ab🎉🎉" is 6 code units; a plain slice(0, 5) ends inside the second emoji.
		const text = "ab🎉🎉";
		expect(text.slice(0, 5)).not.toBe("ab🎉🎉");
		expect(sliceGraphemes(text, 5)).toBe("ab🎉");
		expect(sliceGraphemes(text, 6)).toBe("ab🎉🎉");
	});

	it("keeps a combining mark with its base and a ZWJ sequence whole", () => {
		// e + a combining acute is one grapheme of two code units: it fits a
		// budget of 2, and a budget of 1 leaves nothing rather than half of it.
		const decomposed = "é";
		expect(decomposed.length).toBe(2);
		expect(sliceGraphemes(`${decomposed}x`, 2)).toBe(decomposed);
		expect(sliceGraphemes(`${decomposed}x`, 1)).toBe("");
		// The family emoji is one grapheme of 11 code units (4 emoji + 3 ZWJ).
		expect(sliceGraphemes("👨‍👩‍👧‍👦!", 11)).toBe("👨‍👩‍👧‍👦");
		expect(sliceGraphemes("👨‍👩‍👧‍👦!", 12)).toBe("👨‍👩‍👧‍👦!");
		expect(sliceGraphemes("👨‍👩‍👧‍👦!", 10)).toBe("");
	});

	it("returns the text whole when it fits, and nothing for a zero budget", () => {
		expect(sliceGraphemes("abc", 3)).toBe("abc");
		expect(sliceGraphemes("abc", 0)).toBe("");
	});
});
