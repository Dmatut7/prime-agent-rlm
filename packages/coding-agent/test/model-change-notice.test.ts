import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	convertToLlm,
	createCustomMessage,
	createModelChangeMessage,
	isModelChangeMessage,
	MODEL_CHANGE_CUSTOM_TYPE,
} from "../src/core/messages.js";

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistantMessage(provider: string, model: string, text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider,
		model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	} as AssistantMessage as AgentMessage;
}

function messageText(message: unknown): string {
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("model change notice", () => {
	test("the turn after a switch carries the framed notice in the model's context", () => {
		const notice = createModelChangeMessage({ provider: "openai", modelId: "gpt-5" }, 3000);
		const context = convertToLlm([
			userMessage("refactor the parser", 1000),
			assistantMessage("anthropic", "claude-opus-4-8", "working on it", 2000),
			notice,
			userMessage("continue", 4000),
		]);

		expect(context).toHaveLength(4);
		const rendered = context[2];
		expect(rendered?.role).toBe("user");
		expect(rendered?.timestamp).toBe(3000);
		const text = messageText(rendered);
		expect(text).toContain("not a message from the user");
		expect(text).toContain("not a new instruction");
		expect(text).toContain("openai/gpt-5");
		expect(text).toContain("previous model");
	});

	test("an unswitched context is converted unchanged", () => {
		const messages: AgentMessage[] = [
			userMessage("a", 1000),
			assistantMessage("anthropic", "claude-opus-4-8", "on it", 2000),
			userMessage("b", 3000),
		];
		const rendered = convertToLlm(messages);
		expect(rendered).toEqual(messages);
		expect(rendered.map(messageText).join("\n")).not.toContain("model change");
	});

	test("the replay assembly path converts an identical notice", () => {
		const live = createModelChangeMessage({ provider: "openai", modelId: "gpt-5" }, 3000);
		// session-manager rebuilds persisted custom messages through createCustomMessage;
		// pin that the rebuilt record converts to the same model-facing text.
		const replayed = createCustomMessage(
			MODEL_CHANGE_CUSTOM_TYPE,
			live.content,
			live.display,
			live.details,
			new Date(3000).toISOString(),
		);
		expect(replayed).toEqual(live);
		expect(convertToLlm([replayed])).toEqual(convertToLlm([live]));
	});

	test("the notice is model-only: never displayed, and recognized by its guard", () => {
		const notice = createModelChangeMessage({ provider: "openai", modelId: "gpt-5" }, 3000);
		expect(notice.display).toBe(false);
		expect(isModelChangeMessage(notice)).toBe(true);
		expect(isModelChangeMessage({ ...notice, customType: "other" })).toBe(false);
		expect(isModelChangeMessage({ ...notice, details: undefined })).toBe(false);
	});

	test("malformed notices stay out of the model context; other custom types pass through", () => {
		const good = createModelChangeMessage({ provider: "openai", modelId: "gpt-5" }, 3000);
		expect(convertToLlm([{ ...good, details: { provider: "openai" } }])).toEqual([]);
		expect(convertToLlm([{ ...good, details: undefined }])).toEqual([]);

		const other = createCustomMessage("other_type", "hello", true, undefined, new Date(3000).toISOString());
		expect(convertToLlm([other]).map(messageText)).toEqual(["hello"]);
	});
});
