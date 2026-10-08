import { describe, expect, it } from "vitest";
import { ansiToHtml } from "../src/core/export-html/ansi-to-html.js";

describe("ansiToHtml SGR coverage", () => {
	it("maps inverse (7/27) to swapped foreground and background", () => {
		expect(ansiToHtml("\x1b[7mrev\x1b[27m plain")).toBe(
			'<span style="color:var(--body-bg);background-color:var(--text)">rev</span> plain',
		);
	});

	it("swaps explicit colors under inverse", () => {
		expect(ansiToHtml("\x1b[31;42m\x1b[7mrev\x1b[0m")).toContain(
			'<span style="color:#008000;background-color:#800000">rev</span>',
		);
	});

	it("maps strikethrough (9/29) to line-through", () => {
		expect(ansiToHtml("\x1b[9mdel\x1b[29m")).toBe('<span style="text-decoration:line-through">del</span>');
	});

	it("combines underline and strikethrough in one decoration", () => {
		expect(ansiToHtml("\x1b[4;9mboth\x1b[0m")).toBe(
			'<span style="text-decoration:underline line-through">both</span>',
		);
	});
});

describe("ansiToHtml strips non-SGR escape sequences", () => {
	it("strips OSC 8 hyperlinks instead of leaking them as text", () => {
		expect(ansiToHtml("\x1b]8;;https://x.y\x07link\x1b]8;;\x07!")).toBe("link!");
	});

	it("strips OSC sequences terminated by ST", () => {
		expect(ansiToHtml("\x1b]0;window title\x1b\\rest")).toBe("rest");
	});

	it("strips non-SGR CSI (erase display, erase line, cursor moves)", () => {
		expect(ansiToHtml("a\x1b[2Jb\x1b[Kc\x1b[1Ad")).toBe("abcd");
	});

	it("strips charset designators and two-byte escapes", () => {
		expect(ansiToHtml("\x1b(B\x1b7save\x1b8")).toBe("save");
	});

	it("keeps SGR styling while stripping the noise around it", () => {
		expect(ansiToHtml("\x1b]8;;https://x.y\x07\x1b[31mred\x1b[0m\x1b]8;;\x07")).toBe(
			'<span style="color:#800000">red</span>',
		);
	});
});
