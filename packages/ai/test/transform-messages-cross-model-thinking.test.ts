import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, StopReason, TextContent, ToolResultMessage } from "../src/types.js";

/**
 * 智能-4: cross-model replay flattens thinking blocks into assistant text. Under a
 * provider fallback chain that re-sent every older turn's full reasoning on every
 * request. Only the most recent replayed turn keeps the flattened text; earlier
 * turns get one "[prior reasoning omitted]" placeholder per turn. Same-model
 * replay is untouched.
 */

const PLACEHOLDER = "[prior reasoning omitted]";

const model: Model<"anthropic-messages"> = {
	id: "fixture",
	name: "Fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://localhost",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function foreignAssistant(
	content: AssistantMessage["content"],
	stopReason: StopReason = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		usage: ZERO_USAGE,
		stopReason,
		errorMessage,
		timestamp: 0,
	};
}

function sameModelAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

function thinking(text: string, extra?: { thinkingSignature?: string; redacted?: boolean }) {
	return { type: "thinking" as const, thinking: text, ...extra };
}

const user: Message = { role: "user", content: "Run fixture", timestamp: 0 };

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture_tool",
		content: [{ type: "text", text }],
		isError: true,
		timestamp: 0,
	};
}

function assistantAt(messages: Message[], index: number): AssistantMessage {
	const msg = messages[index];
	expect(msg.role).toBe("assistant");
	return msg as AssistantMessage;
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function countPlaceholder(message: AssistantMessage): number {
	return message.content.filter((block) => block.type === "text" && block.text === PLACEHOLDER).length;
}

describe("cross-model thinking replay bounding", () => {
	it("flattens only the most recent turn's thinking; older turns get a placeholder", () => {
		const messages: Message[] = [
			user,
			foreignAssistant([thinking("first reasoning"), { type: "text", text: "first answer" }]),
			user,
			foreignAssistant([thinking("second reasoning"), { type: "text", text: "second answer" }]),
		];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(4);
		const older = assistantAt(out, 1);
		expect(textOf(older)).toContain(PLACEHOLDER);
		expect(textOf(older)).toContain("first answer");
		expect(textOf(older)).not.toContain("first reasoning");
		const recent = assistantAt(out, 3);
		expect(textOf(recent)).toContain("second reasoning");
		expect(textOf(recent)).toContain("second answer");
		expect(textOf(recent)).not.toContain(PLACEHOLDER);
		expect(
			out.every((msg) => msg.role !== "assistant" || msg.content.every((block) => block.type !== "thinking")),
		).toBe(true);
	});

	it("emits one placeholder per older turn even with several thinking blocks", () => {
		const messages: Message[] = [
			user,
			foreignAssistant(
				[
					thinking("reasoning one"),
					{ type: "toolCall", id: "call|1", name: "fixture_tool", arguments: {} },
					thinking("reasoning two"),
					{ type: "text", text: "older answer" },
				],
				"toolUse",
			),
			toolResult("call|1", "completed"),
			user,
			foreignAssistant([thinking("recent reasoning"), { type: "text", text: "recent answer" }]),
		];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(5);
		const older = assistantAt(out, 1);
		expect(countPlaceholder(older)).toBe(1);
		expect(textOf(older)).not.toContain("reasoning one");
		expect(textOf(older)).not.toContain("reasoning two");
		expect(older.content.some((block) => block.type === "toolCall")).toBe(true);
		expect(textOf(assistantAt(out, 4))).toContain("recent reasoning");
	});

	it("keeps every turn's thinking blocks on the same-model replay path", () => {
		const messages: Message[] = [
			user,
			sameModelAssistant([thinking("first reasoning", { thinkingSignature: "sig-1" }), { type: "text", text: "a" }]),
			user,
			sameModelAssistant([
				thinking("second reasoning", { thinkingSignature: "sig-2" }),
				{ type: "text", text: "b" },
			]),
		];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(4);
		expect(out).toEqual(messages);
	});

	it("ignores a trailing errored turn when picking the most recent turn", () => {
		const messages: Message[] = [
			user,
			foreignAssistant([thinking("old reasoning"), { type: "text", text: "old answer" }]),
			foreignAssistant([thinking("recent reasoning"), { type: "text", text: "recent answer" }]),
			foreignAssistant([thinking("errored reasoning")], "error", "upstream 503"),
		];

		const out = transformMessages(messages, model);

		// The errored turn is dropped, and the turn before it keeps its full thinking.
		expect(out).toHaveLength(3);
		expect(textOf(assistantAt(out, 1))).toContain(PLACEHOLDER);
		expect(textOf(assistantAt(out, 1))).not.toContain("old reasoning");
		expect(textOf(assistantAt(out, 2))).toContain("recent reasoning");
		expect(out.some((msg) => msg.role === "assistant" && textOf(msg as AssistantMessage).includes("errored"))).toBe(
			false,
		);
	});

	it("still drops redacted and empty thinking cross-model without emitting placeholders", () => {
		const messages: Message[] = [
			user,
			foreignAssistant([
				thinking("", { thinkingSignature: "opaque", redacted: true }),
				thinking("   "),
				{ type: "text", text: "older answer" },
			]),
			user,
			foreignAssistant([thinking("recent reasoning"), { type: "text", text: "recent answer" }]),
		];

		const out = transformMessages(messages, model);

		const older = assistantAt(out, 1);
		expect(countPlaceholder(older)).toBe(0);
		expect(older.content).toEqual([{ type: "text", text: "older answer" }]);
	});

	it("placeholders older turns even when the most recent turn is same-model", () => {
		const messages: Message[] = [
			user,
			foreignAssistant([thinking("foreign reasoning"), { type: "text", text: "foreign answer" }]),
			user,
			sameModelAssistant([thinking("own reasoning", { thinkingSignature: "sig-1" }), { type: "text", text: "b" }]),
		];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(4);
		const older = assistantAt(out, 1);
		expect(textOf(older)).toContain(PLACEHOLDER);
		expect(textOf(older)).not.toContain("foreign reasoning");
		expect(assistantAt(out, 3).content.some((block) => block.type === "thinking")).toBe(true);
	});

	it("bounds an older aborted turn's partial thinking while keeping the folded harvest", () => {
		const cause = "Request was aborted (Abort cause: stall_watchdog)";
		const messages: Message[] = [
			user,
			foreignAssistant(
				[
					thinking("old partial reasoning"),
					{ type: "toolCall", id: "call|1", name: "fixture_tool", arguments: {} },
				],
				"aborted",
				cause,
			),
			toolResult("call|1", "partial output"),
			user,
			foreignAssistant([thinking("recent reasoning"), { type: "text", text: "recent answer" }]),
		];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(4);
		const trace = assistantAt(out, 1);
		expect(textOf(trace)).toContain(PLACEHOLDER);
		expect(textOf(trace)).not.toContain("old partial reasoning");
		expect(textOf(trace)).toContain("stall_watchdog");
		expect(textOf(trace)).toContain("partial output");
		expect(textOf(assistantAt(out, 3))).toContain("recent reasoning");
	});
});
