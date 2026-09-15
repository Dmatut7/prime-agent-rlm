import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
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
	};
}

async function driveResponsesStream(events: ResponseStreamEvent[]): Promise<{
	output: AssistantMessage;
	events: AssistantMessageEvent[];
}> {
	const model = createModel();
	const output = createOutput(model);
	const stream = new AssistantMessageEventStream();
	const pushSpy = vi.spyOn(stream, "push");
	await processResponsesStream(
		(async function* () {
			yield* events;
		})(),
		output,
		stream,
		model,
	);
	return { output, events: pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent) };
}

function functionCallAdded(id: string, name: string, outputIndex: number): ResponseStreamEvent {
	return {
		type: "response.output_item.added",
		sequence_number: outputIndex * 10,
		output_index: outputIndex,
		item: { type: "function_call", id, call_id: `call_${id}`, name, arguments: "", status: "in_progress" },
	} as ResponseStreamEvent;
}

function functionCallDone(id: string, name: string, argumentsJson: string, outputIndex: number): ResponseStreamEvent {
	return {
		type: "response.output_item.done",
		sequence_number: outputIndex * 10 + 5,
		output_index: outputIndex,
		item: { type: "function_call", id, call_id: `call_${id}`, name, arguments: argumentsJson, status: "completed" },
	} as ResponseStreamEvent;
}

function argumentDelta(itemId: string, outputIndex: number, delta: string): ResponseStreamEvent {
	return {
		type: "response.function_call_arguments.delta",
		item_id: itemId,
		output_index: outputIndex,
		delta,
	} as ResponseStreamEvent;
}

function reasoningAdded(outputIndex: number): ResponseStreamEvent {
	return {
		type: "response.output_item.added",
		sequence_number: outputIndex * 10,
		output_index: outputIndex,
		item: { type: "reasoning", id: "rs_1", summary: [] },
	} as ResponseStreamEvent;
}

function reasoningDone(outputIndex: number, summaryText: string): ResponseStreamEvent {
	return {
		type: "response.output_item.done",
		sequence_number: outputIndex * 10 + 5,
		output_index: outputIndex,
		item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: summaryText }] },
	} as ResponseStreamEvent;
}

function completedEvent(): ResponseStreamEvent {
	return {
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	} as ResponseStreamEvent;
}

function toolCallsOf(message: AssistantMessage): Array<{ id: string; name: string; arguments: unknown }> {
	return message.content
		.filter((block) => block.type === "toolCall")
		.map((block) => {
			const toolCall = block as { type: "toolCall"; id: string; name: string; arguments: unknown };
			return { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments };
		});
}

describe("openai responses stream item dispatch", () => {
	it("routes interleaved function_call argument deltas by item_id", async () => {
		const { output, events } = await driveResponsesStream([
			functionCallAdded("fc_A", "tool_a", 0),
			argumentDelta("fc_A", 0, '{"x'),
			functionCallAdded("fc_B", "tool_b", 1),
			argumentDelta("fc_B", 1, '{"y'),
			argumentDelta("fc_A", 0, '":1}'),
			argumentDelta("fc_B", 1, '":2}'),
			functionCallDone("fc_A", "tool_a", "", 0),
			functionCallDone("fc_B", "tool_b", "", 1),
			completedEvent(),
		]);

		const calls = toolCallsOf(output);
		expect(calls).toHaveLength(2);
		expect(calls.find((call) => call.name === "tool_a")?.arguments).toEqual({ x: 1 });
		expect(calls.find((call) => call.name === "tool_b")?.arguments).toEqual({ y: 2 });
		expect(output.content.some((block) => "partialJson" in block)).toBe(false);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
	});

	it("keeps tool call arguments when a reasoning item is interleaved", async () => {
		const { output, events } = await driveResponsesStream([
			functionCallAdded("fc_A", "tool_a", 0),
			argumentDelta("fc_A", 0, '{"x":'),
			reasoningAdded(1),
			argumentDelta("fc_A", 0, "1}"),
			reasoningDone(1, "thinking"),
			functionCallDone("fc_A", "tool_a", "", 0),
			completedEvent(),
		]);

		const calls = toolCallsOf(output);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.arguments).toEqual({ x: 1 });
		const thinking = output.content.find((block) => block.type === "thinking") as
			| { type: "thinking"; thinking: string }
			| undefined;
		expect(thinking?.thinking).toBe("thinking");
		const toolCallDeltas = events.filter((event) => event.type === "toolcall_delta") as Array<{ delta: string }>;
		expect(toolCallDeltas.map((event) => event.delta)).toEqual(['{"x":', "1}"]);
	});

	it("routes sequential function calls correctly (positive control)", async () => {
		const { output } = await driveResponsesStream([
			functionCallAdded("fc_A", "tool_a", 0),
			argumentDelta("fc_A", 0, '{"x":1}'),
			functionCallDone("fc_A", "tool_a", "", 0),
			functionCallAdded("fc_B", "tool_b", 1),
			argumentDelta("fc_B", 1, '{"y":2}'),
			functionCallDone("fc_B", "tool_b", "", 1),
			completedEvent(),
		]);

		const calls = toolCallsOf(output);
		expect(calls.find((call) => call.name === "tool_a")?.arguments).toEqual({ x: 1 });
		expect(calls.find((call) => call.name === "tool_b")?.arguments).toEqual({ y: 2 });
		expect(output.diagnostics ?? []).toHaveLength(0);
	});

	it("records a diagnostic when a delta without item_id can no longer be routed", async () => {
		const { output } = await driveResponsesStream([
			functionCallAdded("fc_A", "tool_a", 0),
			reasoningAdded(1),
			{
				type: "response.function_call_arguments.delta",
				delta: '{"z":9}',
			} as ResponseStreamEvent,
			completedEvent(),
		]);

		const diagnostics = output.diagnostics ?? [];
		expect(diagnostics.some((diagnostic) => diagnostic.type === "responses_delta_unrouted")).toBe(true);
	});

	it("recovers output_text deltas that arrive without content_part.added", async () => {
		const { output, events } = await driveResponsesStream([
			{
				type: "response.output_item.added",
				sequence_number: 1,
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
			} as ResponseStreamEvent,
			{
				type: "response.output_text.delta",
				item_id: "msg_1",
				output_index: 0,
				delta: "Hi",
			} as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				sequence_number: 2,
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] },
			} as ResponseStreamEvent,
			completedEvent(),
		]);

		const textDeltas = events.filter((event) => event.type === "text_delta") as Array<{ delta: string }>;
		expect(textDeltas.map((event) => event.delta)).toEqual(["Hi"]);
		const text = output.content.find((block) => block.type === "text") as { type: "text"; text: string } | undefined;
		expect(text?.text).toBe("Hi");
	});

	it("recovers reasoning summary deltas that arrive without summary_part.added", async () => {
		const { output, events } = await driveResponsesStream([
			reasoningAdded(0),
			{
				type: "response.reasoning_summary_text.delta",
				item_id: "rs_1",
				output_index: 0,
				summary_index: 0,
				delta: "think1",
			} as ResponseStreamEvent,
			{
				type: "response.output_item.done",
				sequence_number: 2,
				output_index: 0,
				item: { type: "reasoning", id: "rs_1", summary: [] },
			} as ResponseStreamEvent,
			completedEvent(),
		]);

		const thinkingDeltas = events.filter((event) => event.type === "thinking_delta") as Array<{ delta: string }>;
		expect(thinkingDeltas.map((event) => event.delta)).toEqual(["think1"]);
		const thinking = output.content.find((block) => block.type === "thinking") as
			| { type: "thinking"; thinking: string }
			| undefined;
		expect(thinking?.thinking).toBe("think1");
	});
});

it("does not route a duplicate reasoning done onto another item's live block (K3R-12)", async () => {
	const reasoningAddedFor = (id: string, outputIndex: number): ResponseStreamEvent =>
		({
			type: "response.output_item.added",
			sequence_number: outputIndex * 10,
			output_index: outputIndex,
			item: { type: "reasoning", id, summary: [] },
		}) as ResponseStreamEvent;
	const reasoningDoneFor = (id: string, outputIndex: number, text: string): ResponseStreamEvent =>
		({
			type: "response.output_item.done",
			sequence_number: outputIndex * 10 + 5,
			output_index: outputIndex,
			item: { type: "reasoning", id, summary: [{ type: "summary_text", text }] },
		}) as ResponseStreamEvent;
	const summaryDelta = (itemId: string, outputIndex: number, delta: string): ResponseStreamEvent =>
		({
			type: "response.reasoning_summary_text.delta",
			item_id: itemId,
			output_index: outputIndex,
			delta,
		}) as ResponseStreamEvent;

	const { output, events } = await driveResponsesStream([
		reasoningAddedFor("rs_A", 0),
		reasoningAddedFor("rs_B", 1),
		summaryDelta("rs_A", 0, "AAA"),
		summaryDelta("rs_B", 1, "BBB"),
		reasoningDoneFor("rs_A", 0, "AAA"),
		// Gateway duplicates the rs_A done after its slot was released; rs_B's
		// own done never arrives. The duplicate must not touch rs_B's block.
		reasoningDoneFor("rs_A", 0, "AAA"),
		completedEvent(),
	]);

	const blocks = output.content.filter((block) => block.type === "thinking") as Array<{
		type: "thinking";
		thinking: string;
		thinkingSignature?: string;
	}>;
	expect(blocks).toHaveLength(2);
	const blockB = blocks[1];
	expect(blockB.thinking).toBe("BBB");
	// The signature is the replay payload: carrying rs_A's item JSON on rs_B's
	// block would attribute B's thinking to A's reasoning item on replay.
	expect(blockB.thinkingSignature ?? "").not.toContain("rs_A");
	const thinkingEnds = events.filter((event) => event.type === "thinking_end");
	const contentIndex1Ends = thinkingEnds.filter((event) => (event as { contentIndex?: number }).contentIndex === 1);
	expect(contentIndex1Ends).toHaveLength(0);
	expect(output.diagnostics?.some((diagnostic) => diagnostic.type === "responses_done_unrouted")).toBe(true);
});
