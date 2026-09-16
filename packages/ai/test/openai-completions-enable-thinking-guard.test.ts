import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { completeSimple, streamSimple } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as Record<string, any> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: Record<string, any>) => {
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

type ThinkingFormat = "zai" | "qwen" | "qwen-chat-template" | "deepseek" | "openai";

const TOGGLE_FORMATS: ThinkingFormat[] = ["zai", "qwen", "qwen-chat-template", "deepseek"];

/**
 * Capability shapes mirror ~/.prime/agent/models.json: glm-5.3 is `zai` with `off: null`
 * (the only model on this machine that actually hit the 400), deepseek-v4.1-flash is
 * `deepseek` with `off: "none"`, kimi-k3 is `openai` with `off: null`.
 */
function thinkingModel(format: ThinkingFormat, off: string | null | undefined): Model<"openai-completions"> {
	const thinkingLevelMap: Model<"openai-completions">["thinkingLevelMap"] = {
		minimal: "low",
		low: "low",
		medium: "high",
		high: "high",
	};
	if (off !== undefined) thinkingLevelMap.off = off;
	return {
		id: `test-${format}`,
		name: `Test ${format}`,
		api: "openai-completions",
		provider: "bailian",
		baseUrl: "https://example.invalid/compatible-mode/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 131_072,
		thinkingLevelMap,
		compat: {
			thinkingFormat: format,
			supportsReasoningEffort: true,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		},
	};
}

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

/** Raw provider call: the only way to express "explicit enable, no level". */
async function sendRaw(
	model: Model<"openai-completions">,
	options: { reasoningEffort?: "low" | "medium"; reasoningEnabled?: boolean } = {},
): Promise<Record<string, any>> {
	mockState.lastParams = undefined;
	await streamOpenAICompletions(model, context, { apiKey: "test", ...options }).result();
	if (!mockState.lastParams) throw new Error("expected a captured payload");
	return mockState.lastParams;
}

/** Simple call with no reasoning key at all: the shape refinement/status/branch use. */
async function sendEmpty(model: Model<"openai-completions">): Promise<Record<string, any>> {
	mockState.lastParams = undefined;
	await streamSimple(model, context, { apiKey: "test" }).result();
	if (!mockState.lastParams) throw new Error("expected a captured payload");
	return mockState.lastParams;
}

/** Read the captured payload without TS narrowing it to `undefined` from the reset above. */
function captured(): Record<string, any> {
	const params = mockState.lastParams as Record<string, any> | undefined;
	if (!params) throw new Error("expected a captured payload");
	return params;
}

function expectNoEnableThinking(params: Record<string, any>): void {
	expect("enable_thinking" in params).toBe(false);
}

describe("openai-completions enable_thinking guard", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	// #1 - a model that cannot disable thinking must not be sent the disable signal.
	it.each(["zai", "qwen"] as const)(
		"#1 %s with off:null omits enable_thinking when nothing is requested",
		async (format) => {
			expectNoEnableThinking(await sendEmpty(thinkingModel(format, null)));
		},
	);

	// #2 - an explicit level still turns thinking on.
	it.each(["zai", "qwen"] as const)(
		"#2 %s with off:null sends enable_thinking true for effort low",
		async (format) => {
			const params = await sendRaw(thinkingModel(format, null), { reasoningEffort: "low" });
			expect(params.enable_thinking).toBe(true);
		},
	);

	// #3 - a model that can disable thinking keeps today's behaviour.
	it.each(["zai", "qwen"] as const)('#3 %s with off:"none" still sends enable_thinking false', async (format) => {
		const params = await sendEmpty(thinkingModel(format, "none"));
		expect(params.enable_thinking).toBe(false);
	});

	// #4 - qwen-chat-template keeps the replay flag and drops only the toggle key.
	it("#4 qwen-chat-template with off:null sends chat_template_kwargs without an enable_thinking key", async () => {
		const params = await sendEmpty(thinkingModel("qwen-chat-template", null));
		expect(params.chat_template_kwargs).toEqual({ preserve_thinking: true });
		expect("enable_thinking" in (params.chat_template_kwargs as object)).toBe(false);
		expectNoEnableThinking(params);
	});

	it("#4 qwen-chat-template with off:null still carries the toggle when a level is given", async () => {
		const params = await sendRaw(thinkingModel("qwen-chat-template", null), { reasoningEffort: "low" });
		expect(params.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
	});

	// #5 / #6 - deepseek omits the whole `thinking` parameter instead of disabling it.
	it("#5 deepseek with off:null sends no thinking parameter", async () => {
		const params = await sendEmpty(thinkingModel("deepseek", null));
		expect("thinking" in params).toBe(false);
	});

	it('#6 deepseek with off:"none" still sends thinking.type disabled', async () => {
		const params = await sendEmpty(thinkingModel("deepseek", "none"));
		expect(params.thinking).toEqual({ type: "disabled" });
	});

	// #7 - an undeclared capability table is treated as "can disable", so nothing changes.
	it("#7 a model without thinkingLevelMap keeps sending the disable signal", async () => {
		const params = await sendEmpty(thinkingModel("zai", undefined));
		expect(params.enable_thinking).toBe(false);
	});

	// #8 - the full four-state matrix over every toggle format and both capability shapes.
	it("#8 four branches x {effort, explicit enable, empty} x {off:null, off:none}", async () => {
		const requests = [
			{ name: "effort", options: { reasoningEffort: "low" as const } },
			{ name: "explicit-enable", options: { reasoningEnabled: true } },
			{ name: "empty", options: {} },
		];
		const cells: string[] = [];
		for (const format of TOGGLE_FORMATS) {
			for (const off of [null, "none"] as const) {
				for (const request of requests) {
					const model = thinkingModel(format, off);
					const params = await sendRaw(model, request.options);
					const canDisable = off !== null;
					const want = request.name !== "empty";
					// States 1 and 2 turn thinking on, state 3 sends the off signal,
					// state 4 (cannot disable + nothing requested) omits the parameter.
					const sendsToggle = want || canDisable;
					cells.push(`${format}/${off}/${request.name}`);
					if (format === "deepseek") {
						if (sendsToggle)
							expect(params.thinking, `${format} ${off} ${request.name}`).toEqual({
								type: want ? "enabled" : "disabled",
							});
						else expect("thinking" in params, `${format} ${off} ${request.name}`).toBe(false);
						// The effort mapping must survive the rewrite (state 1 is both halves).
						if (request.name === "effort") expect(params.reasoning_effort).toBe("low");
						else expect("reasoning_effort" in params).toBe(false);
					} else if (format === "qwen-chat-template") {
						expect(params.chat_template_kwargs, `${format} ${off} ${request.name}`).toEqual(
							sendsToggle ? { enable_thinking: want, preserve_thinking: true } : { preserve_thinking: true },
						);
					} else if (sendsToggle) {
						expect(params.enable_thinking, `${format} ${off} ${request.name}`).toBe(want);
					} else {
						expectNoEnableThinking(params);
					}
				}
			}
		}
		expect(cells).toHaveLength(TOGGLE_FORMATS.length * 2 * requests.length);
		expect(cells.length).toBeGreaterThan(0);
	});

	// #9 - kimi-k3 shape goes through the generic branch, which is already guarded.
	it("#9 kimi-k3 shape (openai + off:null) sends no reasoning parameter at all", async () => {
		const params = await sendEmpty(thinkingModel("openai", null));
		expect("reasoning_effort" in params).toBe(false);
		expect("reasoning" in params).toBe(false);
		expectNoEnableThinking(params);
		expect("thinking" in params).toBe(false);
	});

	// #10 - end to end through completeSimple: "off" clamps to the lowest enabled tier.
	it('#10 reasoning:"off" through completeSimple clamps to an enabled tier and turns thinking on', async () => {
		mockState.lastParams = undefined;
		await completeSimple(thinkingModel("zai", null), context, { apiKey: "test", reasoning: "off" });
		const params = captured();
		expect(params.enable_thinking).toBe(true);
		// Known limitation, not part of this fix: zai never sends reasoning_effort.
		expect("reasoning_effort" in params).toBe(false);
	});

	// #11 - the exact call shape refinement/auto-refine/branch/status use.
	it("#11 the refinement call shape sends no enable_thinking on a zai off:null model", async () => {
		mockState.lastParams = undefined;
		const model = thinkingModel("zai", null);
		await completeSimple(
			model,
			{
				systemPrompt: "You are a harness refiner. Return only JSON.",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "<conversation>...</conversation>" }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: 32_000, apiKey: "test" },
		);
		const params = captured();
		expectNoEnableThinking(params);
		expect(params.max_tokens).toBe(32_000);
		expect(params.model).toBe(model.id);
	});
});
