import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Model, Usage } from "../src/types.js";

/**
 * OpenAI-completions is the only API whose usage schema carries
 * `prompt_tokens_details.image_tokens`. Consumers read `usage.imageTokens` as a
 * "did the provider count the images" signal, so the parse must distinguish an
 * absent field (undefined) from a reported zero, and a late partial usage frame
 * must neither zero nor erase a count an earlier frame already reported.
 */
interface UsageFrame {
	prompt_tokens?: number;
	completion_tokens?: number;
	prompt_tokens_details?: { cached_tokens?: number; image_tokens?: number };
}

const mockState = vi.hoisted(() => ({
	usageFrames: [] as UsageFrame[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const frames = mockState.usageFrames;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const usage of frames) {
								yield {
									choices: [{ delta: {}, finish_reason: "stop" }],
									usage,
								};
							}
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function createModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return {
		...(baseModel as Omit<Model<"openai-completions">, "api">),
		api: "openai-completions",
	};
}

async function streamWithUsage(frames: UsageFrame[]): Promise<AssistantMessage> {
	mockState.usageFrames = frames;
	return await streamOpenAICompletions(
		createModel(),
		{
			systemPrompt: "sys",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test-key" },
	).result();
}

describe("openai-completions image token usage", () => {
	it("reports the provider's image token count in usage.imageTokens", async () => {
		const message = await streamWithUsage([
			{
				prompt_tokens: 10,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 0, image_tokens: 184 },
			},
		]);

		expect(message.usage.imageTokens).toBe(184);
		expect(message.usage.input).toBe(10);
	});

	it("keeps imageTokens absent when the provider reports details without image tokens", async () => {
		const message = await streamWithUsage([
			{
				prompt_tokens: 10,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 0 },
			},
		]);

		expect("imageTokens" in message.usage).toBe(false);
		expect(message.usage.imageTokens).toBeUndefined();
	});

	it("keeps imageTokens absent when no usage details arrive at all", async () => {
		const message = await streamWithUsage([{ prompt_tokens: 10, completion_tokens: 1 }]);

		expect(message.usage.imageTokens).toBeUndefined();
		expect((message.usage as Usage).input).toBe(10);
	});

	it("preserves a reported zero instead of treating it as absent", async () => {
		const message = await streamWithUsage([
			{
				prompt_tokens: 10,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 0, image_tokens: 0 },
			},
		]);

		expect(message.usage.imageTokens).toBe(0);
	});

	it("merges a late frame that reports the count after an earlier one did not", async () => {
		const message = await streamWithUsage([
			{
				prompt_tokens: 10,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 0 },
			},
			{
				prompt_tokens: 10,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 0, image_tokens: 1446 },
			},
		]);

		expect(message.usage.imageTokens).toBe(1446);
	});

	it("does not let a later details-only frame erase an earlier image count", async () => {
		const message = await streamWithUsage([
			{
				prompt_tokens: 10,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 0, image_tokens: 872 },
			},
			{
				prompt_tokens: 10,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 4 },
			},
		]);

		expect(message.usage.imageTokens).toBe(872);
	});
});
