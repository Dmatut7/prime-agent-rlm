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

const usageMetadata = { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 };

function toolCallChunks(finishReason: string): unknown[] {
	return [
		{
			candidates: [
				{
					content: {
						role: "model",
						parts: [{ functionCall: { id: "call_1", name: "bash", args: { command: "ls" } } }],
					},
					finishReason,
				},
			],
			usageMetadata,
		},
	];
}

function textChunks(finishReason: string): unknown[] {
	return [
		{
			candidates: [
				{
					content: { role: "model", parts: [{ text: "partial answer" }] },
					finishReason,
				},
			],
			usageMetadata,
		},
	];
}

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

describe("google stopReason guard", () => {
	for (const p of providers) {
		describe(p.name, () => {
			it("does not overwrite length (MAX_TOKENS) with toolUse when a tool call is present", async () => {
				mockState.chunks = toolCallChunks("MAX_TOKENS");
				const message = await p.run();
				expect(message.stopReason).toBe("length");
				// The tool call content must survive — the guard only changes the reason.
				expect(message.content.some((b) => b.type === "toolCall")).toBe(true);
			});

			it("does not overwrite error (MALFORMED_FUNCTION_CALL) with toolUse and records the raw reason", async () => {
				mockState.chunks = toolCallChunks("MALFORMED_FUNCTION_CALL");
				const message = await p.run();
				expect(message.stopReason).toBe("error");
				expect(message.stopReasonRaw).toBe("MALFORMED_FUNCTION_CALL");
				// classifyStreamFailure("MALFORMED_FUNCTION_CALL") -> "malformed_response",
				// not the generic "unknown" bucket, so the failure stays diagnosable and retryable.
				expect(message.errorMessage).toContain("Provider returned a malformed response");
				expect(message.errorMessage).toContain("MALFORMED_FUNCTION_CALL");
			});

			it("keeps toolUse for STOP with a tool call (normal path unchanged)", async () => {
				mockState.chunks = toolCallChunks("STOP");
				const message = await p.run();
				expect(message.stopReason).toBe("toolUse");
				expect(message.stopReasonRaw).toBeUndefined();
				expect(message.content.some((b) => b.type === "toolCall")).toBe(true);
			});

			it("keeps stop for STOP with text only", async () => {
				mockState.chunks = textChunks("STOP");
				const message = await p.run();
				expect(message.stopReason).toBe("stop");
				expect(message.content).toEqual([{ type: "text", text: "partial answer" }]);
			});

			it("keeps length for MAX_TOKENS with text only", async () => {
				mockState.chunks = textChunks("MAX_TOKENS");
				const message = await p.run();
				expect(message.stopReason).toBe("length");
			});
		});
	}
});
