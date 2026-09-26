import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/stream.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.js";

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

const tools = [
	{ name: "bash", description: "b", parameters: Type.Object({ a: Type.Number() }) },
	{ name: "edit", description: "e", parameters: Type.Object({ b: Type.Number() }) },
];

function chunk(delta: unknown, finishReason?: string) {
	return {
		id: "chatcmpl-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "fake-model",
		choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
	};
}

async function collect(deltas: unknown[]): Promise<{ events: AssistantMessageEvent[]; message: AssistantMessage }> {
	mockState.chunks = [...deltas.map((delta) => chunk(delta)), chunk({}, "tool_calls")];
	const events: AssistantMessageEvent[] = [];
	let message: AssistantMessage | undefined;
	for await (const event of stream(
		fakeModel(),
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools },
		{ apiKey: "test" },
	)) {
		events.push(event);
		if (event.type === "done") message = event.message;
		if (event.type === "error") message = event.error;
	}
	if (!message) throw new Error("stream ended without a final message");
	return { events, message };
}

describe("openai-completions stray reasoning tags", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	// The shape seen on the bailian compatible endpoint: a bare closing tag streamed as
	// text between two tool calls.
	it("blanks a leaked closing tag between tool calls without shifting later blocks", async () => {
		const { events, message } = await collect([
			{ reasoning_content: "plan the two edits" },
			{
				tool_calls: [
					{ index: 0, id: "call_A", type: "function", function: { name: "bash", arguments: '{"a":1}' } },
				],
			},
			{ content: "\n</think>\n\n" },
			{
				tool_calls: [
					{ index: 1, id: "call_B", type: "function", function: { name: "edit", arguments: '{"b":2}' } },
				],
			},
		]);

		expect(message.content.map((block) => block.type)).toEqual(["thinking", "toolCall", "text", "toolCall"]);
		expect(message.content[2]).toMatchObject({ type: "text", text: "" });

		const textEnd = events.find((event) => event.type === "text_end");
		expect(textEnd).toMatchObject({ contentIndex: 2, content: "" });

		const starts = events.filter((event) => event.type === "toolcall_start");
		const ends = events.filter((event) => event.type === "toolcall_end");
		expect(starts.map((event) => event.contentIndex)).toEqual([1, 3]);
		expect(ends.map((event) => event.contentIndex)).toEqual([1, 3]);
		expect(ends.map((event) => (event.type === "toolcall_end" ? event.toolCall.id : undefined))).toEqual([
			"call_A",
			"call_B",
		]);
	});

	it("keeps the answer text around a leaked tag", async () => {
		const { message } = await collect([
			{ reasoning_content: "check" },
			{ content: "两路都在跑，你不用动。\n</think>\n\n" },
			{
				tool_calls: [
					{ index: 0, id: "call_A", type: "function", function: { name: "bash", arguments: '{"a":1}' } },
				],
			},
		]);

		expect(message.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(message.content[1]).toMatchObject({ type: "text", text: "两路都在跑，你不用动。\n\n" });
	});
});
