import type * as GoogleGenAi from "@google/genai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof GoogleGenAi>();
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				for (const chunk of mockState.chunks) {
					yield chunk;
				}
			},
		};
	}

	return {
		...actual,
		GoogleGenAI,
	};
});

import { streamGoogle } from "../src/providers/google.js";
import { streamGoogleVertex } from "../src/providers/google-vertex.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

/**
 * A prompt-level safety block arrives as `promptFeedback.blockReason` with no
 * candidates and no finish reason. Both google providers only read
 * `candidates[0]`, so the block fell through to the "stream ended before a finish
 * reason" malformed-response throw — the blockReason was lost and the session
 * retried the same deterministic block as a transient fault. The blockReason now
 * surfaces as a safety-classified error carrying the provider's reason.
 */

function makeModel(api: "google-generative-ai", provider: "google"): Model<"google-generative-ai">;
function makeModel(api: "google-vertex", provider: "google-vertex"): Model<"google-vertex">;
function makeModel(api: string, provider: string): Model<never> {
	return {
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	} as Model<never>;
}

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
};

type ProviderCase = {
	name: string;
	run: () => Promise<AssistantMessage>;
};

const providers: ProviderCase[] = [
	{
		name: "google",
		run: () => streamGoogle(makeModel("google-generative-ai", "google"), context, { apiKey: "fake-key" }).result(),
	},
	{
		name: "google-vertex",
		run: () =>
			streamGoogleVertex(makeModel("google-vertex", "google-vertex"), context, { apiKey: "fake-key" }).result(),
	},
];

beforeEach(() => {
	mockState.chunks = [];
});

describe("google promptFeedback blockReason", () => {
	for (const p of providers) {
		describe(p.name, () => {
			it("reports a prompt-level safety block as a safety error carrying the blockReason", async () => {
				mockState.chunks = [
					{
						promptFeedback: {
							blockReason: "PROHIBITED_CONTENT",
							blockReasonMessage: "The prompt was blocked by content filters.",
						},
						usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0, totalTokenCount: 5 },
					},
				];

				const message = await p.run();

				expect(message.stopReason).toBe("error");
				expect(message.errorMessage).toContain("safety filters");
				expect(message.errorMessage).toContain("PROHIBITED_CONTENT");
				expect(message.errorMessage).not.toContain("finish reason");
				const failure = message.diagnostics?.find((entry) => entry.type === "provider_stream_failure");
				expect(failure?.details?.kind).toBe("safety");
				expect(failure?.details?.providerErrorType).toBe("PROHIBITED_CONTENT");
			});

			it("keeps a normal stream working (positive control)", async () => {
				mockState.chunks = [
					{
						candidates: [
							{ content: { role: "model", parts: [{ text: "partial answer" }] }, finishReason: "STOP" },
						],
						usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
					},
				];

				const message = await p.run();

				expect(message.stopReason).toBe("stop");
				expect(message.content).toEqual([{ type: "text", text: "partial answer" }]);
			});
		});
	}
});
