import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

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

function compatModel(compat: Record<string, unknown> | undefined, maxTokens: number) {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
	return {
		...baseModel,
		api: "openai-completions",
		maxTokens,
		compat,
	} as const;
}

async function captureMaxTokens(
	model: Parameters<typeof streamSimple>[0],
	options?: Parameters<typeof streamSimple>[2],
) {
	let payload: unknown;
	await streamSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] }, {
		...(options as object),
		apiKey: "test",
		onPayload: (params: unknown) => {
			payload = params;
		},
	} as unknown as Parameters<typeof streamSimple>[2]).result();
	return (payload ?? mockState.lastParams) as { max_tokens?: number };
}

describe("openai-completions reasoning counts toward max_tokens", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("honors model.maxTokens instead of the 32k clamp when the compat flag is set", async () => {
		const model = compatModel({ reasoningCountsTowardMaxTokens: true, maxTokensField: "max_tokens" }, 131072);
		const params = await captureMaxTokens(model);
		expect(params.max_tokens).toBe(131072);
	});

	it("keeps the 32k clamp without the compat flag", async () => {
		const model = compatModel({ maxTokensField: "max_tokens" }, 131072);
		const params = await captureMaxTokens(model);
		expect(params.max_tokens).toBe(32000);
	});

	it("never overrides an explicit options.maxTokens", async () => {
		const model = compatModel({ reasoningCountsTowardMaxTokens: true, maxTokensField: "max_tokens" }, 131072);
		const params = await captureMaxTokens(model, { maxTokens: 5000 });
		expect(params.max_tokens).toBe(5000);
	});
});
