import { describe, expect, it } from "vitest";
import { getStreamWidth, wrapCliText } from "../src/cli/stdout-wrap.js";

describe("getStreamWidth", () => {
	it("returns the column count of a TTY-like stream", () => {
		expect(getStreamWidth({ columns: 80 })).toBe(80);
	});

	it("returns undefined for piped or degenerate streams", () => {
		expect(getStreamWidth({})).toBeUndefined();
		expect(getStreamWidth({ columns: undefined })).toBeUndefined();
		expect(getStreamWidth({ columns: 0 })).toBeUndefined();
		expect(getStreamWidth({ columns: -5 })).toBeUndefined();
		expect(getStreamWidth({ columns: 80.5 })).toBeUndefined();
	});
});

describe("wrapCliText", () => {
	it("returns the input unchanged when the width is unknown (pipe/redirect)", () => {
		const text = "a".repeat(200);
		expect(wrapCliText(text, undefined)).toBe(text);
		expect(wrapCliText("line one\n\nline three", undefined)).toBe("line one\n\nline three");
	});

	it("wraps at word boundaries instead of splitting words", () => {
		const wrapped = wrapCliText("Continue until gates pass or a limit is reached", 20);
		const lines = wrapped.split("\n");
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(20);
		}
		expect(wrapped).toContain("reached");
		expect(lines.some((line) => line === "ached" || line === "re")).toBe(false);
		// Word order and content survive the wrap.
		expect(lines.join(" ").replace(/\s+/g, " ").trim()).toBe("Continue until gates pass or a limit is reached");
	});

	it("indents continuation lines by the requested hanging indent", () => {
		const wrapped = wrapCliText("alpha beta gamma delta epsilon zeta eta theta", 20, { continuationIndent: 4 });
		const lines = wrapped.split("\n");
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toBe("alpha beta gamma");
		for (const line of lines.slice(1)) {
			expect(line.startsWith("    ")).toBe(true);
			expect(line.length).toBeLessThanOrEqual(20);
		}
	});

	it("reserves columns for a suffix appended after wrapping", () => {
		const text = "word ".repeat(30).trim();
		const wrapped = wrapCliText(text, 40, { reserveColumns: 7 });
		for (const line of wrapped.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(33);
		}
	});

	it("keeps blank lines and wraps each input line independently", () => {
		const wrapped = wrapCliText(`short\n\n${"long ".repeat(30).trim()}`, 24);
		const lines = wrapped.split("\n");
		expect(lines[0]).toBe("short");
		expect(lines[1]).toBe("");
		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(24);
		}
	});

	it("measures CJK text by terminal columns, not UTF-16 length", () => {
		// 12 full-width characters = 24 columns; must wrap well before length 24.
		const wrapped = wrapCliText("你好世界你好世界你好世界", 10);
		const lines = wrapped.split("\n");
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			expect([...line].length * 2).toBeLessThanOrEqual(10);
		}
		expect(lines.join("")).toBe("你好世界你好世界你好世界");
	});

	it("ignores ANSI escape sequences when measuring line width", () => {
		const red = (text: string) => `\x1b[31m${text}\x1b[39m`;
		const wrapped = wrapCliText(red("alpha beta gamma delta epsilon zeta"), 16);
		const lines = wrapped.split("\n");
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) {
			// Strip escape codes before measuring.
			expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(16);
		}
	});

	it("still breaks a single token longer than the whole width", () => {
		const wrapped = wrapCliText("x".repeat(30), 10);
		for (const line of wrapped.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(10);
		}
		expect(wrapped.replace(/\n/g, "")).toBe("x".repeat(30));
	});
});
