import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model } from "../src/types.js";

/**
 * azure-openai-responses never set `store`, so Azure retained the full conversation
 * server-side by default while openai-responses and codex both pin store:false. And
 * for always-on reasoning models (`thinkingLevelMap.off === null`, e.g. azure gpt-5.1)
 * neither provider requested `reasoning.encrypted_content` unless the caller passed an
 * explicit effort, so the replayed thinkingSignature lacked the material to resume.
 */

const openaiMock = vi.hoisted(() => ({
	capturedParams: [] as Record<string, unknown>[],
}));

vi.mock("openai", () => {
	class FakeOpenAIClient {
		responses = {
			create: (params: Record<string, unknown>) => {
				openaiMock.capturedParams.push(params);
				const stream = (async function* () {
					yield {
						type: "response.completed",
						response: {
							id: "resp_1",
							status: "completed",
							usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
						},
					};
				})();
				return {
					withResponse: async () => ({ data: stream, response: { status: 200, headers: new Headers() } }),
				};
			},
		};
	}

	return { default: FakeOpenAIClient, AzureOpenAI: FakeOpenAIClient };
});

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

beforeEach(() => {
	openaiMock.capturedParams.length = 0;
});

async function captureAzureParams(
	model: Model<"azure-openai-responses">,
	options?: { reasoningEffort?: "high" },
): Promise<Record<string, unknown>> {
	const result = await streamAzureOpenAIResponses(model, context, {
		apiKey: "test-api-key",
		azureBaseUrl: "https://example.openai.azure.com",
		...options,
	}).result();
	expect(result.stopReason).toBe("stop");
	expect(openaiMock.capturedParams).toHaveLength(1);
	return openaiMock.capturedParams[0];
}

async function captureOpenAIParams(model: Model<"openai-responses">): Promise<Record<string, unknown>> {
	const result = await streamOpenAIResponses(model, context, { apiKey: "test-api-key" }).result();
	expect(result.stopReason).toBe("stop");
	expect(openaiMock.capturedParams).toHaveLength(1);
	return openaiMock.capturedParams[0];
}

describe("responses buildParams", () => {
	it("azure pins store:false like openai-responses and codex", async () => {
		const params = await captureAzureParams(getModel("azure-openai-responses", "gpt-4o-mini"));
		expect(params.store).toBe(false);
		expect(params.include).toBeUndefined();
	});

	it("azure requests encrypted reasoning content for an always-on reasoning model (off: null)", async () => {
		const params = await captureAzureParams(getModel("azure-openai-responses", "gpt-5.1"));
		expect(params.store).toBe(false);
		expect(params.include).toEqual(["reasoning.encrypted_content"]);
		// No explicit effort: the model decides; only replay material is requested.
		expect(params.reasoning).toBeUndefined();
	});

	it("azure keeps explicit-effort requests unchanged (positive control)", async () => {
		const params = await captureAzureParams(getModel("azure-openai-responses", "gpt-5.1"), {
			reasoningEffort: "high",
		});
		expect(params.include).toEqual(["reasoning.encrypted_content"]);
		expect(params.reasoning).toMatchObject({ effort: "high" });
	});

	it("openai-responses requests encrypted reasoning content for an always-on reasoning model (off: null)", async () => {
		const params = await captureOpenAIParams(getModel("openai", "gpt-5-mini"));
		expect(params.store).toBe(false);
		expect(params.include).toEqual(["reasoning.encrypted_content"]);
		expect(params.reasoning).toBeUndefined();
	});

	it("openai-responses still disables thinking via the mapped off effort when thinking is optional", async () => {
		const params = await captureOpenAIParams(getModel("openai", "gpt-5.1"));
		expect(params.reasoning).toMatchObject({ effort: "none" });
		expect(params.include).toBeUndefined();
	});
});
