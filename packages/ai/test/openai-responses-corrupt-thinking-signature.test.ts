import type { ResponseOutputMessage, ResponseReasoningItem } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Message, Usage } from "../src/types.js";

/**
 * Replaying a thinking block parses its thinkingSignature as a stored Responses
 * reasoning item. A corrupt signature (truncated transcript line, hand-edited
 * history) used to throw out of request building and fail the whole turn; it
 * must degrade to a plain text item carrying the thinking text instead.
 */

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sameModelAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5-mini",
		usage,
		stopReason: "stop",
		timestamp: 2,
	};
}

function convert(content: AssistantMessage["content"]) {
	const model = getModel("openai", "gpt-5-mini");
	const messages: Message[] = [
		{ role: "user", content: "Summarize the migration.", timestamp: 1 },
		sameModelAssistant(content),
	];
	return convertResponsesMessages(model, { messages }, new Set(["openai", "openai-codex", "opencode"]));
}

describe("OpenAI Responses corrupt thinking signature replay", () => {
	it("degrades an unparseable thinking signature to a text item instead of throwing", () => {
		const input = convert([
			{ type: "thinking", thinking: "recovered reasoning", thinkingSignature: "{not-json" },
			{ type: "text", text: "visible answer" },
		]);

		expect(input.some((item) => item.type === "reasoning")).toBe(false);
		const messages = input.filter((item): item is ResponseOutputMessage => item.type === "message");
		expect(messages).toHaveLength(2);
		expect(messages[0]?.content).toEqual([{ type: "output_text", text: "recovered reasoning", annotations: [] }]);
		expect(messages[1]?.content).toEqual([{ type: "output_text", text: "visible answer", annotations: [] }]);
		// Degraded items get the same synthesized id treatment as unsigned text blocks.
		const ids = messages.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("drops a corrupt signature whose thinking text is empty", () => {
		const input = convert([
			{ type: "thinking", thinking: "   ", thinkingSignature: "{not-json" },
			{ type: "text", text: "visible answer" },
		]);

		const messages = input.filter((item): item is ResponseOutputMessage => item.type === "message");
		expect(messages).toHaveLength(1);
		expect(messages[0]?.content).toEqual([{ type: "output_text", text: "visible answer", annotations: [] }]);
	});

	it("still replays a well-formed signature as a reasoning item", () => {
		const reasoning: ResponseReasoningItem = { type: "reasoning", id: "rs_123", summary: [] };
		const input = convert([
			{ type: "thinking", thinking: "kept reasoning", thinkingSignature: JSON.stringify(reasoning) },
		]);

		const items = input.filter((item): item is ResponseReasoningItem => item.type === "reasoning");
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("rs_123");
	});
});
