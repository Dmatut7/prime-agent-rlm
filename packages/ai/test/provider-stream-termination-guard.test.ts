import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ERR-1: a stream that ends cleanly (HTTP 200, chunked terminator) without ever
 * delivering a termination event was reported as a successful stop. anthropic.ts
 * already guards this ("stream ended before message_stop"); these are the same
 * guard for the remaining providers.
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

function failureKind(message: AssistantMessage): unknown {
	return message.diagnostics?.find((entry) => entry.type === "provider_stream_failure")?.details?.kind;
}

describe("provider stream termination guard", () => {
	it("openai-completions: errors when the stream ends without a finish_reason", async () => {
		openaiState.chunks = [
			{ id: "c1", choices: [{ index: 0, delta: { content: "partial" } }] },
			{ id: "c1", choices: [{ index: 0, delta: { content: " more" } }] },
		];
		const message = await streamOpenAICompletions(completionsModel(), context, {
			apiKey: "test-key",
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("finish_reason");
		expect(failureKind(message)).toBe("malformed_response");
	});

	it("openai-completions: completes normally when finish_reason arrives (positive control)", async () => {
		openaiState.chunks = [
			{ id: "c1", choices: [{ index: 0, delta: { content: "partial" } }] },
			{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
		const message = await streamOpenAICompletions(completionsModel(), context, {
			apiKey: "test-key",
		}).result();

		expect(message.stopReason).toBe("stop");
	});

	it.each(["google-generative-ai", "google-vertex"] as const)("%s: errors without a finishReason", async (api) => {
		googleState.chunks = [
			{ candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }] },
			{ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } },
		];
		const model = googleModel(api);
		const stream =
			api === "google-generative-ai"
				? streamGoogle(model as Model<"google-generative-ai">, context, { apiKey: "fake-key" })
				: streamGoogleVertex(model as Model<"google-vertex">, context, { apiKey: "fake-key" });
		const message = await stream.result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("finish");
		expect(failureKind(message)).toBe("malformed_response");
	});

	it.each(["google-generative-ai", "google-vertex"] as const)(
		"%s: completes with a finishReason (positive control)",
		async (api) => {
			googleState.chunks = [
				{ candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }] },
			];
			const model = googleModel(api);
			const stream =
				api === "google-generative-ai"
					? streamGoogle(model as Model<"google-generative-ai">, context, { apiKey: "fake-key" })
					: streamGoogleVertex(model as Model<"google-vertex">, context, { apiKey: "fake-key" });
			const message = await stream.result();

			expect(message.stopReason).toBe("stop");
		},
	);

	it("mistral: errors when the stream ends without a finishReason", async () => {
		mistralState.events = [{ data: { id: "m1", choices: [{ delta: { content: "partial" } }] } }];
		const message = await streamMistral(mistralModel(), context, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("finish");
		expect(failureKind(message)).toBe("malformed_response");
	});

	it("mistral: completes with a finishReason (positive control)", async () => {
		mistralState.events = [{ data: { id: "m1", choices: [{ delta: { content: "answer" }, finishReason: "stop" }] } }];
		const message = await streamMistral(mistralModel(), context, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("stop");
	});

	it("amazon-bedrock: errors when the stream ends without messageStop", async () => {
		bedrockState.events = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: { contentBlockIndex: 0, start: { text: "" } },
			},
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
		];
		const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const message = await streamBedrock(model, context).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("messageStop");
		expect(failureKind(message)).toBe("malformed_response");
	});

	it("amazon-bedrock: completes with messageStop (positive control)", async () => {
		bedrockState.events = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockStart: { contentBlockIndex: 0, start: { text: "" } },
			},
			{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "answer" } } },
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
		];
		const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");
		const message = await streamBedrock(model, context).result();

		expect(message.stopReason).toBe("stop");
	});
});
