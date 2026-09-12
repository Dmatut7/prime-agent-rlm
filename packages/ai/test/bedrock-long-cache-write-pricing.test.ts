import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	usage: {
		inputTokens: 100,
		outputTokens: 10,
		cacheReadInputTokens: 0,
		cacheWriteInputTokens: 1000,
		totalTokens: 1110,
	},
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<unknown> {
			const stream = (async function* () {
				yield { messageStart: { role: "assistant" } };
				yield { messageStop: { stopReason: "end_turn" } };
				yield { metadata: { usage: bedrockMock.usage } };
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

import { hasStandardAnthropicCachePricing } from "../src/cache-pricing.js";
import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import type { Context } from "../src/types.js";

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

describe("bedrock long cache retention pricing", () => {
	it("bills cache writes at the 1h rate (2x input) when cacheRetention is long", async () => {
		const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		// The override is gated on the registry carrying the standard 5m cacheWrite
		// figure (1.25x input); assert the gate is actually satisfied for this entry.
		expect(model.cost.cacheWrite).toBeCloseTo(model.cost.input * 1.25, 10);
		expect(hasStandardAnthropicCachePricing(model)).toBe(true);

		const longMessage = await streamBedrock(model, context, { cacheRetention: "long" }).result();
		expect(longMessage.stopReason, longMessage.errorMessage).toBe("stop");
		expect(longMessage.usage.cacheWrite).toBe(bedrockMock.usage.cacheWriteInputTokens);
		expect(longMessage.usage.cost.cacheWrite).toBeCloseTo(
			((model.cost.input * 2) / 1_000_000) * bedrockMock.usage.cacheWriteInputTokens,
			12,
		);
		expect(longMessage.usage.cost.cacheWrite).not.toBeCloseTo(
			(model.cost.cacheWrite / 1_000_000) * bedrockMock.usage.cacheWriteInputTokens,
			12,
		);

		const shortMessage = await streamBedrock(model, context, { cacheRetention: "short" }).result();
		expect(shortMessage.stopReason, shortMessage.errorMessage).toBe("stop");
		expect(shortMessage.usage.cost.cacheWrite).toBeCloseTo(
			(model.cost.cacheWrite / 1_000_000) * bedrockMock.usage.cacheWriteInputTokens,
			12,
		);
	});
});
