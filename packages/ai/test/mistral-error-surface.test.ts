import { describe, expect, it, vi } from "vitest";
import { streamMistral } from "../src/providers/mistral.js";
import type { AssistantMessage, Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	events: [] as unknown[],
	throwOnStream: undefined as unknown,
}));

vi.mock("@mistralai/mistralai", () => {
	class Mistral {
		chat = {
			stream: () => {
				if (mockState.throwOnStream !== undefined) return Promise.reject(mockState.throwOnStream);
				const events = mockState.events;
				const stream = (async function* () {
					yield* events as never[];
				})();
				return Promise.resolve(stream);
			},
		};
	}
	return { Mistral };
});

function fakeModel(): Model<"mistral-conversations"> {
	return {
		id: "mistral-large-latest",
		name: "Mistral Large",
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	};
}

async function runStream(events: unknown[], options?: { throwOnStream?: unknown }): Promise<AssistantMessage> {
	mockState.events = events;
	mockState.throwOnStream = options?.throwOnStream;
	return streamMistral(
		fakeModel(),
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{
			apiKey: "test",
		},
	).result();
}

function event(delta: unknown, finishReason?: string) {
	return {
		data: {
			id: "cmpl1",
			choices: [{ index: 0, delta, finishReason: finishReason ?? null }],
		},
	};
}

describe("mistral error surface", () => {
	// An unknown finishReason used to fall into the default "stop" branch: the
	// turn read as a clean completion and the retry ladder never saw the failure.
	it("maps an unknown finish reason to an error stop with the raw reason on record", async () => {
		const message = await runStream([event({ content: "partial" }), event({}, "some_new_mistral_reason")]);

		expect(message.stopReason).toBe("error");
		expect(message.stopReasonRaw).toBe("some_new_mistral_reason");
		expect(message.errorMessage).toContain("some_new_mistral_reason");
	});

	it("keeps the documented finish reasons mapped as before", async () => {
		const message = await runStream([event({ content: "answer" }), event({}, "stop")]);
		expect(message.stopReason).toBe("stop");
		expect(message.stopReasonRaw).toBeUndefined();
	});

	// The error body was cut by UTF-16 code unit, so a limit-straddling astral
	// character left a lone surrogate that renders as U+FFFD in the transcript.
	it("truncates an oversized error body on a grapheme boundary", async () => {
		const marker = "💥"; // one grapheme, two UTF-16 code units
		const body = `${"x".repeat(3999)}${marker}TAIL`;
		const failure = Object.assign(new Error("Request failed"), { statusCode: 500, body });
		const message = await runStream([], { throwOnStream: failure });

		expect(message.stopReason).toBe("error");
		const text = message.errorMessage ?? "";
		expect(text).toContain("Mistral API error (500)");
		expect(text).toContain("[truncated");
		expect(text).not.toContain("TAIL");
		// A code-unit cut leaves a lone surrogate behind (which any later encoding
		// pass then turns into U+FFFD); a grapheme-boundary cut never does.
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
		// The whole grapheme is either present or absent, never halved.
		if (text.includes(marker)) {
			expect(text.indexOf(marker)).toBe(text.lastIndexOf(marker));
		}
	});
});
