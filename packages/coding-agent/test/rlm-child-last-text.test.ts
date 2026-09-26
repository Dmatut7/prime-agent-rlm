import { describe, expect, it } from "vitest";
import { boundRlmChildLastText, RLM_CHILD_LAST_TEXT_MAX_CHARS } from "../src/core/messages.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("boundRlmChildLastText", () => {
	it("returns an answer that fits unchanged apart from surrounding whitespace", () => {
		expect(boundRlmChildLastText("  line one\n\nline two  \n")).toBe("line one\n\nline two");
	});

	it("keeps an answer exactly at the cap whole", () => {
		const answer = "字".repeat(RLM_CHILD_LAST_TEXT_MAX_CHARS);
		expect(boundRlmChildLastText(answer)).toBe(answer);
	});

	it("keeps three quarters from the head and the rest from the tail", () => {
		const answer = `${"a".repeat(5000)}${"b".repeat(5000)}`;
		const bounded = boundRlmChildLastText(answer, 400);
		expect(bounded.startsWith("a".repeat(300))).toBe(true);
		expect(bounded.endsWith("b".repeat(100))).toBe(true);
		expect(bounded).toContain("[... 9600 characters omitted; the full text is in the child's transcript ...]");
	});

	it("never splits a character that takes two UTF-16 units", () => {
		const bounded = boundRlmChildLastText("😀".repeat(5000), 401);
		expect(LONE_SURROGATE.test(bounded)).toBe(false);
		expect(bounded.startsWith("😀".repeat(300))).toBe(true);
	});
});
