import type { ResponseOutputMessage } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Context, Message, Usage } from "../src/types.js";

/**
 * F24: unsigned text blocks (cross-provider handoff, aborted-turn traces) fall
 * back to a synthesized item id `msg_${msgIndex}`. msgIndex counts messages, not
 * blocks, so every unsigned text block of one assistant message — and of one
 * attempt — shared a single id. The Responses API treats input items with
 * duplicate ids as the same item, so history text was silently dropped. The ids
 * must be unique per block and deterministic across conversions of the same
 * context (the codex cached-context delta relies on byte-identical prefixes).
 */

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function handoffAssistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function messageItems(input: ReturnType<typeof convertResponsesMessages>): ResponseOutputMessage[] {
	return input.filter((item): item is ResponseOutputMessage => item.type === "message");
}

function convertOnce(): ReturnType<typeof convertResponsesMessages> {
	const model = getModel("openai", "gpt-5-mini");
	const messages: Message[] = [
		{ role: "user", content: "Summarize the migration.", timestamp: Date.now() - 3000 },
		handoffAssistant(
			[
				// Foreign thinking converts to a plain text block, so a handoff
				// message routinely carries several unsigned text blocks.
				{ type: "thinking", thinking: "first thought" },
				{ type: "text", text: "answer part one" },
				{ type: "text", text: "answer part two" },
			],
			Date.now() - 2000,
		),
	];
	const context: Context = {
		systemPrompt: "You are concise.",
		messages,
	};
	return convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]));
}

describe("OpenAI Responses unsigned message item ids", () => {
	it("gives every unsigned text block of one handoff message a distinct id", () => {
		const input = convertOnce();
		const items = messageItems(input);
		// The thinking block converts to text: three unsigned message items.
		expect(items.length).toBe(3);

		const ids = items.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toBeDefined();
			expect(id?.length).toBeLessThanOrEqual(64);
		}
	});

	it("keeps synthesized ids deterministic across conversions of the same context", () => {
		const first = messageItems(convertOnce()).map((item) => item.id);
		const second = messageItems(convertOnce()).map((item) => item.id);
		expect(second).toEqual(first);
	});

	it("does not collide ids between two separate handoff attempts", () => {
		const model = getModel("openai", "gpt-5-mini");
		const messages: Message[] = [
			{ role: "user", content: "First try.", timestamp: Date.now() - 5000 },
			handoffAssistant([{ type: "text", text: "attempt one" }], Date.now() - 4000),
			{ role: "user", content: "Second try.", timestamp: Date.now() - 3000 },
			handoffAssistant([{ type: "text", text: "attempt two" }], Date.now() - 2000),
		];
		const input = convertResponsesMessages(model, { messages }, new Set(["openai", "openai-codex", "opencode"]));
		const ids = messageItems(input).map((item) => item.id);
		expect(ids.length).toBe(2);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
