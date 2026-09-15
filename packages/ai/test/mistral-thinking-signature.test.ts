import { describe, expect, it, vi } from "vitest";
import { streamMistral } from "../src/providers/mistral.js";
import type { AssistantMessage, Message, Model } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	events: [] as unknown[],
}));

vi.mock("@mistralai/mistralai", () => {
	class Mistral {
		chat = {
			stream: () => {
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

function event(delta: unknown, finishReason?: string) {
	return {
		data: {
			id: "cmpl1",
			choices: [{ index: 0, delta, finishReason: finishReason ?? null }],
		},
	};
}

async function runStream(events: unknown[], messages: Message[]) {
	mockState.events = events;
	let capturedPayload: unknown;
	const stream = streamMistral(
		fakeModel(),
		{ messages },
		{
			apiKey: "test",
			onPayload: (payload) => {
				capturedPayload = payload;
				return payload;
			},
		},
	);
	let final: AssistantMessage | undefined;
	for await (const item of stream) {
		if (item.type === "done" || item.type === "error") {
			final = (item as { message: AssistantMessage }).message;
		}
	}
	if (!final) throw new Error("stream ended without a terminal message");
	return Object.assign(final, { __payload: capturedPayload });
}

describe("mistral thinking signature", () => {
	// M4 shape: the thinking chunk carries signature/closed on the wire. The
	// signature is the replay contract ("Signature to replay some reasoning
	// blocks across turns") and must survive into the persisted block.
	it("captures the thinking signature into the persisted block (M4)", async () => {
		const message = await runStream(
			[
				event({
					content: [
						{ type: "thinking", thinking: [{ type: "text", text: "PLAN" }], signature: "SIG-XYZ", closed: true },
					],
				}),
				event({ content: [{ type: "text", text: "answer" }] }),
				event({}, "stop"),
			],
			[{ role: "user", content: "hi", timestamp: Date.now() }],
		);

		const thinking = message.content.find((block) => block.type === "thinking") as
			| { type: "thinking"; thinking: string; thinkingSignature?: string }
			| undefined;
		expect(thinking?.thinking).toBe("PLAN");
		expect(thinking?.thinkingSignature).toBe("SIG-XYZ");
		// The closed flag is not round-tripped; the drop is persisted as a
		// diagnostic instead of staying silent.
		expect(message.diagnostics?.some((d) => d.type === "mistral_thinking_closed_dropped")).toBe(true);
	});

	// Replay side: an assistant thinking block with a stored signature must send
	// it back on the wire so multi-turn reasoning replay keeps working.
	it("replays the stored signature on the thinking chunk", async () => {
		const message = await runStream(
			[event({ content: [{ type: "text", text: "answer" }] }), event({}, "stop")],
			[
				{ role: "user", content: "hi", timestamp: Date.now() },
				{
					role: "assistant",
					api: "mistral-conversations",
					provider: "mistral",
					model: "mistral-large-latest",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
					content: [
						{ type: "thinking", thinking: "PLAN", thinkingSignature: "SIG-XYZ" },
						{ type: "text", text: "answer" },
					],
				},
				{ role: "user", content: "again", timestamp: Date.now() },
			],
		);

		const payload = (message as AssistantMessage & { __payload?: any }).__payload;
		const assistantEntry = payload.messages.find((m: any) => m.role === "assistant");
		const thinkingChunk = assistantEntry.content.find((part: any) => part.type === "thinking");
		expect(thinkingChunk.thinking).toEqual([{ type: "text", text: "PLAN" }]);
		expect(thinkingChunk.signature).toBe("SIG-XYZ");
	});

	// Positive control: streams without signature stay clean (no diagnostic).
	it("records no diagnostic when no signature or closed flag is present", async () => {
		const message = await runStream(
			[
				event({ content: [{ type: "thinking", thinking: [{ type: "text", text: "PLAN" }] }] }),
				event({ content: [{ type: "text", text: "answer" }] }),
				event({}, "stop"),
			],
			[{ role: "user", content: "hi", timestamp: Date.now() }],
		);

		expect(message.diagnostics ?? []).toHaveLength(0);
	});
});
