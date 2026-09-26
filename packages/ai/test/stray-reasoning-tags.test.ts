import { describe, expect, it } from "vitest";
import { scrubStrayReasoningTags, stripStrayReasoningTags } from "../src/providers/stray-reasoning-tags.js";

describe("stripStrayReasoningTags", () => {
	it("empties a text that is only a leaked closing tag", () => {
		expect(stripStrayReasoningTags("\n</think>\n\n")).toBe("");
		expect(stripStrayReasoningTags("</think>")).toBe("");
	});

	it("drops a lone closing-tag line and keeps the prose around it", () => {
		expect(stripStrayReasoningTags("answer one\n</think>\nanswer two")).toBe("answer one\nanswer two");
	});

	it("keeps the answer in front of a trailing leaked tag", () => {
		expect(stripStrayReasoningTags("两路都在跑，你不用动。\n</think>\n\n")).toBe("两路都在跑，你不用动。\n\n");
	});

	it("drops an empty open/close pair", () => {
		expect(stripStrayReasoningTags("<think>\n</think>\nreal")).toBe("real");
	});

	it("keeps the delimiters of reasoning streamed inline", () => {
		const inline = "<think>\nplan the fix first\n</think>\n\nThe fix is to retry.";
		expect(stripStrayReasoningTags(inline)).toBe(inline);
		const unterminated = "<think>\nstill working it out";
		expect(stripStrayReasoningTags(unterminated)).toBe(unterminated);
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

describe("scrubStrayReasoningTags", () => {
	it("blanks a tag-only block in place so later blocks keep their index", () => {
		const blocks: Array<{ type: string; text?: string }> = [
			{ type: "thinking" },
			{ type: "toolCall" },
			{ type: "text", text: "\n</think>\n\n" },
			{ type: "toolCall" },
		];
		scrubStrayReasoningTags(blocks);
		expect(blocks.map((block) => block.type)).toEqual(["thinking", "toolCall", "text", "toolCall"]);
		expect(blocks[2].text).toBe("");
	});

	it("cleans a tag line inside a block that has other text", () => {
		const blocks = [{ type: "text", text: "head\n</think>\ntail" }];
		scrubStrayReasoningTags(blocks);
		expect(blocks[0].text).toBe("head\ntail");
	});
});
