import { describe, expect, it } from "vitest";
import { pruneStrayReasoningTags, stripStrayReasoningTags } from "../src/providers/stray-reasoning-tags.js";

describe("stripStrayReasoningTags", () => {
	it("removes a block that is only a leaked closing tag", () => {
		expect(stripStrayReasoningTags("\n</think>\n\n").trim()).toBe("");
	});

	it("removes the think variant too", () => {
		expect(stripStrayReasoningTags("\n</think>\n").trim()).toBe("");
	});

	it("drops a lone tag line but keeps the prose around it", () => {
		expect(stripStrayReasoningTags("answer one\n</think>\nanswer two")).toBe("answer one\nanswer two");
	});

	it("removes a leaked open/close pair spanning lines", () => {
		expect(stripStrayReasoningTags("<think>\n</think>\nreal").trim()).toBe("real");
	});

	it("keeps a tag embedded in prose", () => {
		const text = "the model printed </think> inside a sentence";
		expect(stripStrayReasoningTags(text)).toBe(text);
	});

	it("keeps ordinary text untouched", () => {
		const text = "thinking about think tags is not a tag";
		expect(stripStrayReasoningTags(text)).toBe(text);
	});
});

describe("pruneStrayReasoningTags", () => {
	it("drops vacated text blocks and keeps the rest in order", () => {
		const blocks: Array<{ type: string; text?: string }> = [
			{ type: "thinking", thinking: "kept" } as unknown as { type: string; text?: string },
			{ type: "text", text: "\n</think>\n\n" },
			{ type: "toolCall" },
			{ type: "text", text: "real answer" },
		];
		pruneStrayReasoningTags(blocks);
		expect(blocks.map((b) => b.type)).toEqual(["thinking", "toolCall", "text"]);
		expect(blocks[2].text).toBe("real answer");
	});

	it("cleans a tag line inside a surviving block", () => {
		const blocks = [{ type: "text", text: "head\n</think>\ntail" }];
		pruneStrayReasoningTags(blocks);
		expect(blocks[0].text).toBe("head\ntail");
	});
});
