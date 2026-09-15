import type Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * E4-1: every non-anthropic provider replaced (or zero-assigned) usage on each
 * frame, so a partial late usage frame wiped fields already recorded. E4-2:
 * google/vertex/responses had no component-sum fallback for totalTokens. E4-4:
 * anthropic guarded usage with `!= null`, so an explicit 0 (proxy normalization)
 * still zeroed the message_start counts.
 */

const openaiState = vi.hoisted(() => ({ chunks: [] as unknown[] }));
vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of openaiState.chunks) {
								yield chunk;
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

const googleState = vi.hoisted(() => ({ chunks: [] as unknown[] }));
vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@google/genai")>();
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				for (const chunk of googleState.chunks) {
					yield chunk;
				}
			},
		};
	}

	return { ...actual, GoogleGenAI };
});

const mistralState = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@mistralai/mistralai", () => {
	class Mistral {
		chat = {
			// The real SDK applies a zod inbound schema that defaults missing usage
			// fields to 0, so the mock delivers SDK-shaped (already remapped) chunks.
			stream: async () => {
				return (async function* () {
					for (const event of mistralState.events) {
						yield event;
					}
				})();
			},
		};
	}

	return { Mistral };
});

const bedrockState = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<unknown> {
			const stream = (async function* () {
				for (const event of bedrockState.events) {
					yield event;
				}
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
import { streamAnthropic } from "../src/providers/anthropic.js";
import { streamGoogle } from "../src/providers/google.js";
import { streamGoogleVertex } from "../src/providers/google-vertex.js";
import { streamMistral } from "../src/providers/mistral.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

beforeEach(() => {
	openaiState.chunks = [];
	googleState.chunks = [];
	mistralState.events = [];
	bedrockState.events = [];
});

function completionsModel(): Model<"openai-completions"> {
	return {
		id: "probe-model",
		name: "probe-model",
		api: "openai-completions",
		provider: "probe-provider",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function googleModel(api: "google-generative-ai" | "google-vertex"): Model<never> {
	return {
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api,
		provider: api,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<never>;
}

function mistralModel(): Model<"mistral-conversations"> {
	return {
		id: "mistral-large-latest",
		name: "Mistral Large",
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

async function runCompletions(chunks: unknown[]): Promise<AssistantMessage> {
	openaiState.chunks = chunks;
	return streamOpenAICompletions(completionsModel(), context, { apiKey: "test-key" }).result();
}

async function runGoogle(chunks: unknown[], api: "google-generative-ai" | "google-vertex"): Promise<AssistantMessage> {
	googleState.chunks = chunks;
	const model = googleModel(api);
	const stream =
		api === "google-generative-ai"
			? streamGoogle(model as Model<"google-generative-ai">, context, { apiKey: "fake-key" })
			: streamGoogleVertex(model as Model<"google-vertex">, context, { apiKey: "fake-key" });
	return stream.result();
}

async function runMistral(events: unknown[]): Promise<AssistantMessage> {
	mistralState.events = events;
	return streamMistral(mistralModel(), context, { apiKey: "test-key" }).result();
}

async function runBedrock(events: unknown[]): Promise<AssistantMessage> {
	bedrockState.events = events;
	const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
	return streamBedrock(model, context).result();
}

function googleTextChunk(extra: Record<string, unknown> = {}): unknown {
	return {
		candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }],
		...extra,
	};
}

describe("provider usage merge and totalTokens fallback", () => {
	describe("openai-completions", () => {
		it("keeps input/cacheRead when a later usage frame only reports completion tokens", async () => {
			const message = await runCompletions([
				{
					id: "c1",
					choices: [],
					usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 200 } },
				},
				{ id: "c1", choices: [], usage: { completion_tokens: 15 } },
				{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			]);

			expect(message.usage).toMatchObject({ input: 800, output: 15, cacheRead: 200, cacheWrite: 0 });
			expect(message.usage.totalTokens).toBe(1015);
		});
	});

	describe.each(["google-generative-ai", "google-vertex"] as const)("%s", (api) => {
		it("keeps input/cacheRead/total when a later usageMetadata frame only reports candidates", async () => {
			const message = await runGoogle(
				[
					{ usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 200, totalTokenCount: 1200 } },
					{ usageMetadata: { candidatesTokenCount: 7 } },
					googleTextChunk(),
				],
				api,
			);

			expect(message.usage).toMatchObject({ input: 800, output: 7, cacheRead: 200, cacheWrite: 0 });
			expect(message.usage.totalTokens).toBe(1200);
		});

		it("falls back to the component sum when totalTokenCount is missing", async () => {
			const message = await runGoogle(
				[googleTextChunk({ usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20 } })],
				api,
			);

			expect(message.usage.totalTokens).toBe(1020);
		});

		it("adds thoughtsTokenCount to output tokens (positive control)", async () => {
			const message = await runGoogle(
				[
					googleTextChunk({
						usageMetadata: {
							promptTokenCount: 100,
							candidatesTokenCount: 20,
							thoughtsTokenCount: 10,
							totalTokenCount: 130,
						},
					}),
				],
				api,
			);

			expect(message.usage).toMatchObject({ input: 100, output: 30 });
			expect(message.usage.totalTokens).toBe(130);
		});
	});

	describe("mistral", () => {
		it("keeps input when a later usage frame only reports completion tokens", async () => {
			const message = await runMistral([
				{ data: { id: "m1", usage: { promptTokens: 1000, completionTokens: 5, totalTokens: 1005 }, choices: [] } },
				{ data: { id: "m1", usage: { completionTokens: 50 }, choices: [] } },
				{ data: { id: "m1", choices: [{ delta: { content: "hi" }, finishReason: "stop" }] } },
			]);

			expect(message.usage).toMatchObject({ input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 });
			expect(message.usage.totalTokens).toBe(1050);
		});

		it("keeps usage when a late frame carries an SDK-defaulted empty usage object", async () => {
			const message = await runMistral([
				{ data: { id: "m1", usage: { promptTokens: 1000, completionTokens: 5, totalTokens: 1005 }, choices: [] } },
				{ data: { id: "m1", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, choices: [] } },
				{ data: { id: "m1", choices: [{ delta: { content: "hi" }, finishReason: "stop" }] } },
			]);

			expect(message.usage).toMatchObject({ input: 1000, output: 5 });
			expect(message.usage.totalTokens).toBe(1005);
		});
	});

	describe("amazon-bedrock", () => {
		it("keeps input/cacheRead/cacheWrite when a later metadata frame only reports outputTokens", async () => {
			const message = await runBedrock([
				{ messageStart: { role: "assistant" } },
				{
					metadata: {
						usage: {
							inputTokens: 10,
							outputTokens: 5,
							cacheReadInputTokens: 9000,
							cacheWriteInputTokens: 500,
							totalTokens: 9515,
						},
					},
				},
				{ metadata: { usage: { outputTokens: 50 } } },
				{ messageStop: { stopReason: "end_turn" } },
			]);

			expect(message.usage).toMatchObject({ input: 10, output: 50, cacheRead: 9000, cacheWrite: 500 });
			expect(message.usage.totalTokens).toBe(9515);
		});
	});

	describe("anthropic zero-value guard", () => {
		async function runAnthropicFrames(messageDeltaUsage: Record<string, number | null>): Promise<AssistantMessage> {
			const body = [
				`event: message_start
data: ${JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_1",
						usage: {
							input_tokens: 1000,
							output_tokens: 0,
							cache_read_input_tokens: 9000,
							cache_creation_input_tokens: 500,
						},
					},
				})}`,
				`event: content_block_start
data: ${JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				})}`,
				`event: content_block_delta
data: ${JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "Hello" },
				})}`,
				`event: content_block_stop
data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
				`event: message_delta
data: ${JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: messageDeltaUsage,
				})}`,
				`event: message_stop
data: ${JSON.stringify({ type: "message_stop" })}`,
			].join("\n\n");
			const response = new Response(`${body}\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
			const client = {
				messages: {
					create: () => ({
						asResponse: async () => response,
					}),
				},
			} as unknown as Anthropic;
			const model = getModel("anthropic", "claude-haiku-4-5");
			return streamAnthropic(model, context, { client }).result();
		}

		it("keeps message_start usage when message_delta normalizes fields to explicit 0", async () => {
			const message = await runAnthropicFrames({
				input_tokens: 0,
				output_tokens: 25,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			});

			expect(message.usage).toMatchObject({ input: 1000, output: 25, cacheRead: 9000, cacheWrite: 500 });
			expect(message.usage.totalTokens).toBe(10525);
		});

		it("keeps message_start usage when message_delta omits fields (positive control)", async () => {
			const message = await runAnthropicFrames({ input_tokens: null, output_tokens: 25 });

			expect(message.usage).toMatchObject({ input: 1000, output: 25, cacheRead: 9000, cacheWrite: 500 });
			expect(message.usage.totalTokens).toBe(10525);
		});

		it("applies real cumulative counts from message_delta (positive control)", async () => {
			const message = await runAnthropicFrames({
				input_tokens: 1200,
				output_tokens: 25,
				cache_read_input_tokens: 9000,
				cache_creation_input_tokens: 500,
			});

			expect(message.usage).toMatchObject({ input: 1200, output: 25, cacheRead: 9000, cacheWrite: 500 });
		});
	});
});
