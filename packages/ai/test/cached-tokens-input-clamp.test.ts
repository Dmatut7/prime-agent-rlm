import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { googleUsageCounts } from "../src/providers/google-shared.js";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

/**
 * F25: buggy upstream proxies occasionally report cached_tokens greater than
 * input_tokens. The non-cached input is derived by subtraction, so without a
 * clamp it goes negative and pollutes the usage totals and cost calculation
 * (a negative cost.input discounts the bill and corrupts overflow decisions).
 * completions already clamps (openai-completions.ts parseChunkUsage); responses
 * and google did not.
 */

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
	};
}

async function driveResponsesStream(events: Array<Record<string, unknown>>): Promise<AssistantMessage> {
	const model = createModel();
	const output = createOutput(model);
	const stream = new AssistantMessageEventStream();
	await processResponsesStream(
		(async function* () {
			for (const event of events) {
				yield event as unknown as ResponseStreamEvent;
			}
		})(),
		output,
		stream,
		model,
	);
	return output;
}

function completedEvent(usage: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "response.completed",
		sequence_number: 1,
		response: { id: "resp_1", status: "completed", usage },
	};
}

describe("usage input clamp when cached tokens exceed input tokens", () => {
	it("responses: clamps input at 0 and keeps totals non-negative", async () => {
		const output = await driveResponsesStream([
			completedEvent({
				input_tokens: 100,
				output_tokens: 50,
				input_tokens_details: { cached_tokens: 150 },
			}),
		]);

		expect(output.usage.input).toBe(0);
		expect(output.usage.cacheRead).toBe(150);
		expect(output.usage.output).toBe(50);
		expect(output.usage.totalTokens).toBe(150);
		expect(output.usage.input).toBeGreaterThanOrEqual(0);
		expect(output.usage.totalTokens).toBeGreaterThanOrEqual(0);
	});

	it("google: clamps input at 0 when cachedContentTokenCount exceeds promptTokenCount", () => {
		const counts = googleUsageCounts({
			promptTokenCount: 100,
			candidatesTokenCount: 50,
			cachedContentTokenCount: 150,
		});

		expect(counts.input).toBe(0);
		expect(counts.cacheRead).toBe(150);
		expect(counts.output).toBe(50);
		expect(counts.totalTokens).toBe(150);
		expect(counts.input).toBeGreaterThanOrEqual(0);
	});

	it("google: normal arithmetic is unchanged when cache fits inside the prompt", () => {
		const counts = googleUsageCounts({
			promptTokenCount: 1000,
			candidatesTokenCount: 50,
			thoughtsTokenCount: 25,
			cachedContentTokenCount: 200,
		});

		expect(counts.input).toBe(800);
		expect(counts.cacheRead).toBe(200);
		expect(counts.output).toBe(75);
	});
});
