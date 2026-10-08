import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	frames: [] as unknown[],
	sentInputs: [] as unknown[],
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(input: unknown): Promise<unknown> {
			bedrockMock.sentInputs.push((input as { input?: unknown }).input);
			const stream = (async function* () {
				yield* bedrockMock.frames;
			})();
			return Promise.resolve({ $metadata: {}, stream });
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { AssistantMessage, Message, Model } from "../src/types.js";

function fakeModel(): Model<"bedrock-converse-stream"> {
	return getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
}

function runStream(frames: unknown[], messages?: Message[]): Promise<AssistantMessage> {
	bedrockMock.frames = frames;
	return streamBedrock(
		fakeModel(),
		{ messages: messages ?? [{ role: "user", content: "Hello", timestamp: Date.now() }] },
		{ apiKey: "", region: "us-east-1", maxRetries: 0, reasoning: "high" },
	).result();
}

const REDACTED_BLOB = new Uint8Array([1, 2, 3, 4, 250, 251]);

describe("bedrock redacted reasoning content", () => {
	// The encrypted reasoning blob used to be dropped wholesale: the reasoning
	// silently vanished and the follow-up request had nothing to hand back.
	it("surfaces a redactedContent delta as a marked thinking block with the payload kept for replay", async () => {
		const message = await runStream([
			{ messageStart: { role: "assistant" } },
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { reasoningContent: { redactedContent: REDACTED_BLOB } },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ contentBlockDelta: { contentBlockIndex: 1, delta: { text: "the answer" } } },
			{ contentBlockStop: { contentBlockIndex: 1 } },
			{ messageStop: { stopReason: "end_turn" } },
			{ metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
		]);

		const thinking = message.content.find((block) => block.type === "thinking");
		expect(thinking).toBeDefined();
		if (thinking?.type !== "thinking") throw new Error("unreachable");
		expect(thinking.redacted).toBe(true);
		expect(thinking.thinking.length).toBeGreaterThan(0);
		expect(thinking.thinkingSignature).toBe(Buffer.from(REDACTED_BLOB).toString("base64"));
		const text = message.content.find((block) => block.type === "text");
		expect(text?.type === "text" && text.text).toBe("the answer");
	});

	it("hands a persisted redacted thinking block back as redactedContent on the next request", async () => {
		const redactedAssistant: Message = {
			role: "assistant",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			model: fakeModel().id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [
				{
					type: "thinking",
					thinking: "[Reasoning redacted]",
					thinkingSignature: Buffer.from(REDACTED_BLOB).toString("base64"),
					redacted: true,
				},
				{ type: "text", text: "the answer" },
			],
		};
		bedrockMock.sentInputs = [];
		await runStream(
			[
				{ messageStart: { role: "assistant" } },
				{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "next" } } },
				{ messageStop: { stopReason: "end_turn" } },
				{ metadata: { usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } } },
			],
			[
				{ role: "user", content: "Hello", timestamp: 1 },
				redactedAssistant,
				{ role: "user", content: "and now?", timestamp: 2 },
			],
		);

		const input = bedrockMock.sentInputs[0] as {
			messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
		};
		const assistant = input.messages.find((message) => message.role === "assistant");
		expect(assistant).toBeDefined();
		const reasoning = assistant?.content.find((block) => block.reasoningContent !== undefined) as
			| { reasoningContent: { redactedContent?: unknown; reasoningText?: unknown } }
			| undefined;
		expect(reasoning?.reasoningContent.reasoningText).toBeUndefined();
		expect(reasoning?.reasoningContent.redactedContent).toBeDefined();
		const roundTripped = reasoning?.reasoningContent.redactedContent;
		expect(Buffer.from(roundTripped as Uint8Array)).toEqual(Buffer.from(REDACTED_BLOB));
	});
});
