import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete, stream } from "../src/stream.js";
// biome-ignore lint/correctness/noUnusedImports: Model is used in fakeModel's return type; biome misses type-position uses here.
import type { AssistantMessage, Model, TextContent, ThinkingContent } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) {
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

function fakeModel(): Model<"openai-completions"> {
	return {
		id: "fake-model",
		name: "Fake",
		api: "openai-completions",
		provider: "faux-oai",
		baseUrl: "https://example.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

function chunk(delta: unknown, finishReason?: string) {
	return {
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "fake-model",
		choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
	};
}

async function run(deltas: unknown[]): Promise<AssistantMessage> {
	mockState.chunks = [...deltas.map((d) => chunk(d as any)), chunk({}, "stop")];
	return complete(
		fakeModel(),
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test" },
	);
}

describe("openai-completions interleaved reasoning and text blocks", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	// B5 shape: the provider interleaves reasoning_content and content deltas
	// (R1, T1, R2, T2). The completions wire has one reasoning channel and one
	// text channel, so each channel owns a single block; the propositions are
	// that block order follows first appearance (thinking first here) and that
	// no block swaps position relative to the stream's first deltas.
	it("orders channel blocks by first appearance (B5)", async () => {
		const message = await run([
			{ reasoning_content: "R1" },
			{ content: "T1" },
			{ reasoning_content: "R2" },
			{ content: "T2" },
		]);

		expect(message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(message.content[0]).toMatchObject({ type: "thinking", thinking: "R1R2" });
		expect(message.content[1]).toMatchObject({ type: "text", text: "T1T2" });
	});

	// The same interleaving with text first must yield the opposite block
	// order: the single-slot reordering E4-7 flagged put thinking first
	// regardless of which channel actually opened the stream.
	it("orders channel blocks by first appearance when text leads", async () => {
		const message = await run([
			{ content: "T1" },
			{ reasoning_content: "R1" },
			{ content: "T2" },
			{ reasoning_content: "R2" },
		]);

		expect(message.content.map((block) => block.type)).toEqual(["text", "thinking"]);
		expect(message.content[0]).toMatchObject({ type: "text", text: "T1T2" });
		expect(message.content[1]).toMatchObject({ type: "thinking", thinking: "R1R2" });
	});

	// Positive control: consecutive same-type deltas still merge into one block.
	it("merges consecutive same-type deltas into single blocks", async () => {
		const message = await run([
			{ reasoning_content: "R1" },
			{ reasoning_content: "R2" },
			{ content: "T1" },
			{ content: "T2" },
		]);

		expect(message.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(message.content[0]).toMatchObject({ type: "thinking", thinking: "R1R2" });
		expect(message.content[1]).toMatchObject({ type: "text", text: "T1T2" });
	});
});

describe("openai-completions reasoning_details plaintext", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	// B7 shape: the provider only streams reasoning_details carrying plaintext
	// text. The plaintext belongs in the thinking block (repo contract: redacted
	// is for genuinely encrypted payloads), with thinking_delta events.
	it("surfaces reasoning_details plaintext as thinking text and deltas (B7)", async () => {
		mockState.chunks = [
			chunk({ reasoning_details: [{ type: "reasoning.text", index: 0, text: "PLAN " }] }),
			chunk({ reasoning_details: [{ type: "reasoning.text", index: 0, text: "STEP" }] }),
			chunk({ content: "out" }),
			chunk({}, "stop"),
		];
		const events: Array<{ type: string; delta?: string }> = [];
		const message = await (async () => {
			let final: AssistantMessage | undefined;
			for await (const event of stream(
				fakeModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ apiKey: "test" },
			)) {
				events.push(event as { type: string; delta?: string });
				if (event.type === "done" || event.type === "error") {
					final = (event as { message?: AssistantMessage }).message;
				}
			}
			return final as AssistantMessage;
		})();

		const thinking = message.content.find((block) => block.type === "thinking") as ThinkingContent | undefined;
		expect(thinking?.thinking).toBe("PLAN STEP");
		expect(thinking?.redacted).toBeFalsy();
		expect(thinking?.thinkingSignature).toContain("openai-completions.reasoning_details.v1");
		expect(JSON.parse(thinking?.thinkingSignature as string).details.map((detail: any) => detail.text)).toEqual([
			"PLAN STEP",
		]);
		const thinkingDeltas = events.filter((event) => event.type === "thinking_delta");
		expect(thinkingDeltas.map((event) => event.delta)).toEqual(["PLAN ", "STEP"]);
	});

	// Positive control: genuinely encrypted details still get a redacted block.
	it("marks the details block redacted for encrypted reasoning only", async () => {
		const message = await run([
			{ reasoning_details: [{ type: "reasoning.encrypted", index: 0, data: "ENC", id: "tool_x" }] },
			{ content: "out" },
		]);

		const thinking = message.content.find((block) => block.type === "thinking") as ThinkingContent | undefined;
		expect(thinking?.thinking).toBe("");
		expect(thinking?.redacted).toBe(true);
	});
});
