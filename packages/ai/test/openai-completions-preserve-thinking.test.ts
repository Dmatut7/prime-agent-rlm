import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
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

/** Mirrors the Bailian (DashScope OpenAI-compatible) Qwen3.8-Max-0902 shape from models.json. */
function bailianQwen(compat: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
	return {
		id: "qwen3.8-max-0902",
		name: "Qwen3.8 Max 0902",
		api: "openai-completions",
		provider: "bailian",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.65, output: 4.951, cacheRead: 0.137, cacheWrite: 2.063 },
		contextWindow: 1000000,
		maxTokens: 131072,
		thinkingLevelMap: { off: "none", low: "low", medium: "medium", xhigh: "xhigh" },
		compat,
	};
}

const baseCompat = {
	thinkingFormat: "openai",
	supportsReasoningEffort: true,
	supportsDeveloperRole: false,
} as const;

async function send(model: Model<"openai-completions">, reasoning?: "off" | "low" | "medium" | "xhigh") {
	await streamSimple(
		model,
		{
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		},
		{ apiKey: "test", reasoning },
	).result();
	return mockState.lastParams as Record<string, any>;
}

describe("openai-completions Bailian/Qwen thinking compatibility", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends preserve_thinking when compat.preserveThinking is set", async () => {
		const params = await send(bailianQwen({ ...baseCompat, preserveThinking: true }), "xhigh");
		expect(params.reasoning_effort).toBe("xhigh");
		expect(params.preserve_thinking).toBe(true);
	});

	it("omits preserve_thinking unless the model opts in", async () => {
		const params = await send(bailianQwen({ ...baseCompat }), "xhigh");
		expect(params.reasoning_effort).toBe("xhigh");
		expect(params.preserve_thinking).toBeUndefined();
	});

	it("omits preserve_thinking when thinking is turned off", async () => {
		const params = await send(bailianQwen({ ...baseCompat, preserveThinking: true }), "off");
		expect(params.reasoning_effort).toBe("none");
		expect(params.preserve_thinking).toBeUndefined();
	});

	it("marks the stable prefix for Bailian explicit cache without an Anthropic-only ttl", async () => {
		const params = await send(
			bailianQwen({ ...baseCompat, cacheControlFormat: "anthropic", supportsLongCacheRetention: false }),
			"xhigh",
		);
		const system = params.messages.find((m: any) => m.role === "system");
		expect(Array.isArray(system.content)).toBe(true);
		expect(system.content[0].cache_control).toEqual({ type: "ephemeral" });
		expect(system.content[0].cache_control.ttl).toBeUndefined();
	});

	it("keeps max_tokens so the answer budget does not cap the chain of thought", async () => {
		// Bailian semantics: max_tokens bounds the visible answer only, while
		// max_completion_tokens bounds answer + reasoning together. With the 32k
		// default clamp, max_completion_tokens would let xhigh reasoning eat the
		// whole budget and truncate the answer, so the Bailian provider pins
		// maxTokensField to max_tokens.
		const params = await send(bailianQwen({ ...baseCompat, maxTokensField: "max_tokens" }), "xhigh");
		expect(params.max_tokens).toBe(32000);
		expect(params.max_completion_tokens).toBeUndefined();
	});

	it("sends enable_search with search_options when compat.enableSearch is set", async () => {
		const params = await send(
			bailianQwen({ ...baseCompat, enableSearch: true, searchStrategy: "max", forcedSearch: true }),
			"xhigh",
		);
		expect(params.enable_search).toBe(true);
		expect(params.search_options).toEqual({ search_strategy: "max", forced_search: true });
	});

	it("sends bare enable_search when no search options are configured", async () => {
		const params = await send(bailianQwen({ ...baseCompat, enableSearch: true }), "xhigh");
		expect(params.enable_search).toBe(true);
		expect(params.search_options).toBeUndefined();
	});

	it("omits enable_search unless the model opts in", async () => {
		const params = await send(bailianQwen({ ...baseCompat }), "xhigh");
		expect(params.enable_search).toBeUndefined();
		expect(params.search_options).toBeUndefined();
	});

	it("matches the resolved request shape configured for qwen3.8-max-0902", async () => {
		// models.json: provider compat (supportsDeveloperRole:false, maxTokensField:"max_tokens")
		// merged with model compat (thinkingFormat:"openai", supportsReasoningEffort:true,
		// cacheControlFormat:"anthropic", supportsLongCacheRetention:false, preserveThinking:true).
		const params = await send(
			bailianQwen({
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				thinkingFormat: "openai",
				cacheControlFormat: "anthropic",
				supportsLongCacheRetention: false,
				preserveThinking: true,
			}),
			"xhigh",
		);
		expect(params.model).toBe("qwen3.8-max-0902");
		expect(params.messages[0].role).toBe("system");
		expect(params.reasoning_effort).toBe("xhigh");
		expect(params.preserve_thinking).toBe(true);
		expect(params.enable_thinking).toBeUndefined();
		expect(params.thinking_budget).toBeUndefined();
		expect(params.max_tokens).toBe(32000);
		expect(params.temperature).toBeUndefined();
		expect(params.top_p).toBeUndefined();
		expect(params.presence_penalty).toBeUndefined();
		expect(params.stream).toBe(true);
		expect(params.stream_options).toEqual({ include_usage: true });
		expect(params.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
	});
});
