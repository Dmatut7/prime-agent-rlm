import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { convertMessages } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat } from "../src/types.js";

/**
 * openai-completions joined an assistant turn's text blocks with "" while every other
 * provider keeps them apart. An aborted turn replays as [text, "[assistant turn
 * aborted: ...]"] (transform-messages), so the abort trace glued straight onto the
 * reply text in the next request. Blocks now join with a blank line.
 */

const compat: Required<Omit<OpenAICompletionsCompat, "toolStream" | "reasoningCountsTowardMaxTokens">> & {
	toolStream?: boolean;
	reasoningCountsTowardMaxTokens?: boolean;
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
	preserveThinking: false,
	enableSearch: false,
	searchStrategy: "turbo",
	forcedSearch: false,
};

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	model: Model<"openai-completions">,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function model(): Model<"openai-completions"> {
	const { compat: _compat, ...base } = getModel("openai", "gpt-4o-mini");
	return { ...base, api: "openai-completions" };
}

describe("openai-completions assistant text block join", () => {
	it("separates multiple text blocks with a blank line", () => {
		const m = model();
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				assistantMessage(
					m,
					[
						{ type: "text", text: "First block." },
						{ type: "text", text: "Second block." },
					],
					"stop",
				),
			],
		};

		const messages = convertMessages(m, context, compat);
		const assistant = messages.find((message) => message.role === "assistant");
		expect(assistant?.content).toBe("First block.\n\nSecond block.");
	});

	it("keeps the abort trace of an aborted turn from gluing onto the reply text", () => {
		const m = model();
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				assistantMessage(m, [{ type: "text", text: "partial answer" }], "aborted", "Request was aborted"),
				{ role: "user", content: "continue", timestamp: Date.now() },
			],
		};

		const messages = convertMessages(m, context, compat);
		const assistant = messages.find((message) => message.role === "assistant");
		expect(assistant?.content).toBe("partial answer\n\n[assistant turn aborted: Request was aborted]");
	});

	it("leaves a single text block byte-identical (positive control)", () => {
		const m = model();
		const context: Context = {
			messages: [
				{ role: "user", content: "hi", timestamp: Date.now() },
				assistantMessage(m, [{ type: "text", text: "Only block." }], "stop"),
			],
		};

		const messages = convertMessages(m, context, compat);
		const assistant = messages.find((message) => message.role === "assistant");
		expect(assistant?.content).toBe("Only block.");
	});
});
