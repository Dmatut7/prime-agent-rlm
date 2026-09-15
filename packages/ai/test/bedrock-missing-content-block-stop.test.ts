import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	frames: [] as unknown[],
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<unknown> {
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
import type { AssistantMessage, Context, Model } from "../src/types.js";

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

function fakeModel(): Model<"bedrock-converse-stream"> {
	return getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
}

async function runStream(frames: unknown[]): Promise<{ message: AssistantMessage; events: unknown[] }> {
	bedrockMock.frames = frames;
	const events: unknown[] = [];
	const stream = streamBedrock(fakeModel(), context, {
		apiKey: "",
		region: "us-east-1",
		maxRetries: 0,
		reasoning: "high",
	});
	let final: AssistantMessage | undefined;
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done" || event.type === "error") {
			final = (event as { message: AssistantMessage }).message;
		}
	}
	if (!final) throw new Error("stream ended without a terminal message");
	return { message: final, events };
}

describe("bedrock stream without a matching contentBlockStop", () => {
	// BR6 shape: messageStart -> text delta -> messageStop -> metadata, no
	// contentBlockStop. The internal index scratch field must not leak into the
	// persisted content and the block still needs its text_end.
	it("does not leak the scratch index and still emits text_end (BR6)", async () => {
		const { message, events } = await runStream([
			{ messageStart: { role: "assistant" } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi" } } },
			{ messageStop: { stopReason: "end_turn" } },
			{ metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
		]);

		const text = message.content.find((block) => block.type === "text") as
			| { type: "text"; text: string; index?: number }
			| undefined;
		expect(text?.text).toBe("Hi");
		expect(text && "index" in text).toBe(false);
		expect(events.some((event: any) => event.type === "text_end")).toBe(true);
	});

	// BR4 shape: contentBlockStop arrives with a mismatched index; the open
	// block must still be closed and de-scratched.
	it("closes the block when contentBlockStop carries a mismatched index (BR4)", async () => {
		const { message, events } = await runStream([
			{ messageStart: { role: "assistant" } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "answer" } } },
			{ contentBlockStop: { contentBlockIndex: 5 } },
			{ messageStop: { stopReason: "end_turn" } },
			{ metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
		]);

		const text = message.content.find((block) => block.type === "text") as
			| { type: "text"; text: string; index?: number }
			| undefined;
		expect(text?.text).toBe("answer");
		expect(text && "index" in text).toBe(false);
		expect(events.some((event: any) => event.type === "text_end")).toBe(true);
	});

	// Positive control: a well-formed stream with contentBlockStop keeps its
	// normal event sequence and no diagnostics.
	it("emits no recovery diagnostic for a well-formed stream", async () => {
		const { message, events } = await runStream([
			{ messageStart: { role: "assistant" } },
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi" } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
			{ metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
		]);

		expect(message.content.some((block) => "index" in (block as object))).toBe(false);
		expect(message.diagnostics ?? []).toHaveLength(0);
		const textEnds = events.filter((event: any) => event.type === "text_end");
		expect(textEnds).toHaveLength(1);
	});
});
