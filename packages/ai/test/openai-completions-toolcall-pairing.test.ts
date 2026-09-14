import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/stream.js";
import type { AssistantMessage, Model, ToolCall } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
	// Index of the chunk after which the fake stream throws, or null for a clean stream.
	throwAt: null as number | null,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const [i, chunk] of chunks.entries()) {
								if (mockState.throwAt !== null && i >= mockState.throwAt) {
									throw new Error("connection reset mid tool call");
								}
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
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

const tools = [
	{
		name: "bash",
		description: "b",
		parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } as any,
	},
	{
		name: "edit",
		description: "e",
		parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } as any,
	},
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

async function run(deltas: unknown[]): Promise<AssistantMessage> {
	mockState.chunks = [...deltas.map((d) => chunk(d as any)), chunk({}, "tool_calls")];
	return complete(
		fakeModel(),
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools },
		{ apiKey: "test" },
	);
}

function toolCalls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((c): c is ToolCall => c.type === "toolCall");
}

describe("openai-completions streaming tool call pairing", () => {
	beforeEach(() => {
		mockState.chunks = [];
		mockState.throwAt = null;
	});

	// Positive control: the well-formed shape must keep working.
	it("keeps well-formed parallel calls with distinct index and id (S1)", async () => {
		const message = await run([
			{
				tool_calls: [
					{ index: 0, id: "call_A", type: "function", function: { name: "bash", arguments: '{"a":1}' } },
				],
			},
			{
				tool_calls: [
					{ index: 1, id: "call_B", type: "function", function: { name: "edit", arguments: '{"b":2}' } },
				],
			},
		]);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.id)).toEqual(["call_A", "call_B"]);
		expect(calls.map((c) => c.name)).toEqual(["bash", "edit"]);
		expect(calls.map((c) => c.arguments)).toEqual([{ a: 1 }, { b: 2 }]);
		expect(message.stopReason).toBe("toolUse");
	});

	// S2: the provider re-uses stream index 0 for a second, different call.
	it("keeps both calls when a stream index is reused for a different id (S2)", async () => {
		const message = await run([
			{
				tool_calls: [
					{ index: 0, id: "call_A", type: "function", function: { name: "bash", arguments: '{"a":1}' } },
				],
			},
			{
				tool_calls: [
					{ index: 0, id: "call_B", type: "function", function: { name: "edit", arguments: '{"b":2}' } },
				],
			},
		]);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.name)).toEqual(["bash", "edit"]);
		expect(calls.map((c) => c.arguments)).toEqual([{ a: 1 }, { b: 2 }]);
		expect(new Set(calls.map((c) => c.id)).size).toBe(2);
		expect(message.stopReason).toBe("toolUse");
		expect(message.diagnostics?.some((d) => d.type === "tool_call_index_reused")).toBe(true);
	});

	// S2b: same thing with fragmented arguments.
	it("keeps both calls when a reused index carries fragmented arguments (S2b)", async () => {
		const message = await run([
			{ tool_calls: [{ index: 0, id: "call_A", type: "function", function: { name: "bash", arguments: '{"a"' } }] },
			{ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] },
			{
				tool_calls: [
					{ index: 0, id: "call_B", type: "function", function: { name: "edit", arguments: '{"b":2}' } },
				],
			},
		]);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.name)).toEqual(["bash", "edit"]);
		expect(calls.map((c) => c.arguments)).toEqual([{ a: 1 }, { b: 2 }]);
	});

	// S5: two distinct indices carry the same id.
	it("keeps both calls and keeps ids unique when two indices share an id (S5)", async () => {
		const message = await run([
			{
				tool_calls: [
					{ index: 0, id: "call_X", type: "function", function: { name: "bash", arguments: '{"a":1}' } },
				],
			},
			{
				tool_calls: [
					{ index: 1, id: "call_X", type: "function", function: { name: "edit", arguments: '{"b":2}' } },
				],
			},
		]);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.name)).toEqual(["bash", "edit"]);
		expect(calls.map((c) => c.arguments)).toEqual([{ a: 1 }, { b: 2 }]);
		expect(new Set(calls.map((c) => c.id)).size).toBe(2);
		expect(calls.every((c) => c.id.length > 0)).toBe(true);
		expect(message.diagnostics?.some((d) => d.type.startsWith("tool_call_"))).toBe(true);
	});

	// S3: no index at all, id only on the first fragment.
	it("appends an id-less, index-less fragment to the open call instead of a ghost call (S3)", async () => {
		const message = await run([
			{ tool_calls: [{ id: "call_A", type: "function", function: { name: "bash", arguments: '{"a":' } }] },
			{ tool_calls: [{ function: { arguments: "1}" } }] },
		]);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe("call_A");
		expect(calls[0].name).toBe("bash");
		expect(calls[0].arguments).toEqual({ a: 1 });
		expect(calls.every((c) => c.name.length > 0)).toBe(true);
	});

	// S3 control: with no open call at all the fragment must not become a ghost call.
	it("drops an unassignable orphan fragment loudly instead of emitting a nameless call (S3-orphan)", async () => {
		const message = await run([{ tool_calls: [{ function: { arguments: '{"a":1}' } }] }]);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(0);
		expect(message.diagnostics?.some((d) => d.type === "tool_call_fragment_unassignable")).toBe(true);
	});

	// S4: id never sent.
	it("assigns a non-empty unique id when the provider never sends one (S4)", async () => {
		const message = await run([
			{ tool_calls: [{ index: 0, type: "function", function: { name: "bash", arguments: '{"a":1}' } }] },
		]);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(1);
		expect(calls[0].id.length).toBeGreaterThan(0);
		expect(calls[0].name).toBe("bash");
		expect(calls[0].arguments).toEqual({ a: 1 });
		expect(message.diagnostics?.some((d) => d.type === "tool_call_missing_id")).toBe(true);
	});

	// Never persist an empty id in the transcript for an id-less parallel pair.
	it("never leaves an empty id on any call (S4-parallel)", async () => {
		const message = await run([
			{ tool_calls: [{ index: 0, type: "function", function: { name: "bash", arguments: '{"a":1}' } }] },
			{ tool_calls: [{ index: 1, type: "function", function: { name: "edit", arguments: '{"b":2}' } }] },
		]);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(2);
		expect(calls.every((c) => c.id.length > 0)).toBe(true);
		expect(new Set(calls.map((c) => c.id)).size).toBe(2);
	});

	// A block that never received a name cannot be dispatched: drop it loudly.
	it("drops a call block that never received a name", async () => {
		const message = await run([
			{ tool_calls: [{ index: 0, id: "call_A", type: "function", function: { arguments: "{}" } }] },
		]);

		expect(toolCalls(message)).toHaveLength(0);
		expect(message.diagnostics?.some((d) => d.type === "tool_call_missing_name")).toBe(true);
	});
	// A repeated id on later fragments of the same call is normal, not a second call.
	it("keeps one call and stays quiet when a well-formed call repeats its id", async () => {
		const message = await run([
			{ tool_calls: [{ index: 0, id: "call_A", type: "function", function: { name: "bash", arguments: '{"a"' } }] },
			{ tool_calls: [{ index: 0, id: "call_A", type: "function", function: { arguments: ":1}" } }] },
		]);

		const calls = toolCalls(message);
		expect(calls).toHaveLength(1);
		expect(calls[0].id).toBe("call_A");
		expect(calls[0].arguments).toEqual({ a: 1 });
		expect(message.diagnostics ?? []).toHaveLength(0);
	});

	// An interrupted call is still persisted: it must not carry an empty id either.
	it("synthesizes an id for an interrupted call that never received one", async () => {
		mockState.chunks = [
			chunk({ tool_calls: [{ index: 0, type: "function", function: { name: "bash", arguments: '{"a":1}' } }] }),
			chunk({}, "tool_calls"),
		];
		mockState.throwAt = 1;

		const message = await complete(
			fakeModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }], tools },
			{ apiKey: "test" },
		);

		expect(message.stopReason).toBe("error");
		const calls = toolCalls(message);
		expect(calls).toHaveLength(1);
		expect(calls[0].id.length).toBeGreaterThan(0);
		expect(message.diagnostics?.some((d) => d.type === "tool_call_missing_id")).toBe(true);
	});
});
