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

function reasoningAdded(outputIndex: number): ResponseStreamEvent {
	return {
		type: "response.output_item.added",
		sequence_number: outputIndex * 10,
		output_index: outputIndex,
		item: { type: "reasoning", id: "rs_1", summary: [] },
	} as ResponseStreamEvent;
}

function summaryPartAdded(outputIndex: number): ResponseStreamEvent {
	return {
		type: "response.reasoning_summary_part.added",
		sequence_number: outputIndex * 10 + 1,
		output_index: outputIndex,
		item_id: "rs_1",
		summary_index: 0,
		part: { type: "summary_text", text: "" },
	} as ResponseStreamEvent;
}

function summaryDelta(outputIndex: number, delta: string): ResponseStreamEvent {
	return {
		type: "response.reasoning_summary_text.delta",
		sequence_number: outputIndex * 10 + 2,
		output_index: outputIndex,
		item_id: "rs_1",
		summary_index: 0,
		delta,
	} as ResponseStreamEvent;
}

function reasoningDone(outputIndex: number, summaryText: string): ResponseStreamEvent {
	return {
		type: "response.output_item.done",
		sequence_number: outputIndex * 10 + 5,
		output_index: outputIndex,
		item: {
			type: "reasoning",
			id: "rs_1",
			encrypted_content: "ENC",
			summary: [{ type: "summary_text", text: summaryText }],
		},
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

function thinkingBlockOf(output: AssistantMessage) {
	return output.content.find((block) => block.type === "thinking") as
		| { type: "thinking"; thinking: string; thinkingSignature?: string }
		| undefined;
}

describe("openai responses thinking done payload vs streamed deltas", () => {
	// R6 shape: the gateway streams AAA+BBB as deltas, then hands a shortened
	// summary ("SHORT") in output_item.done. The persisted block must keep the
	// full streamed text (what the user watched), not the truncated payload.
	it("keeps the streamed thinking text when the done summary conflicts (R6)", async () => {
		const { output, events } = await driveResponsesStream([
			reasoningAdded(0),
			summaryPartAdded(0),
			summaryDelta(0, "AAA"),
			summaryDelta(0, "BBB"),
			reasoningDone(0, "SHORT"),
			completedEvent(),
		]);

		const thinking = thinkingBlockOf(output);
		expect(thinking?.thinking).toBe("AAABBB");
		const thinkingEnd = events.find((event) => event.type === "thinking_end") as { content: string } | undefined;
		expect(thinkingEnd?.content).toBe("AAABBB");
		expect(output.diagnostics?.some((diagnostic) => diagnostic.type === "responses_thinking_conflict")).toBe(true);
	});

	// Positive control: a well-formed stream (deltas agree with the done item)
	// must not produce a conflict diagnostic.
	it("accepts a well-formed stream without diagnostics", async () => {
		const { output } = await driveResponsesStream([
			reasoningAdded(0),
			summaryPartAdded(0),
			summaryDelta(0, "step1 "),
			summaryDelta(0, "step2"),
			reasoningDone(0, "step1 step2"),
			completedEvent(),
		]);

		expect(thinkingBlockOf(output)?.thinking).toBe("step1 step2");
		expect(output.diagnostics ?? []).toHaveLength(0);
	});

	// A reasoning item whose text never streamed as deltas still needs the done
	// payload as its only source.
	it("fills the thinking text from the done item when no deltas streamed", async () => {
		const { output } = await driveResponsesStream([
			reasoningAdded(0),
			reasoningDone(0, "step1 step2"),
			completedEvent(),
		]);

		expect(thinkingBlockOf(output)?.thinking).toBe("step1 step2");
		expect(output.diagnostics ?? []).toHaveLength(0);
	});

	// The done item stays authoritative for replay: encrypted_content and the
	// full item payload travel in thinkingSignature even on a conflict.
	it("keeps the done item replay payload in thinkingSignature on conflict", async () => {
		const { output } = await driveResponsesStream([
			reasoningAdded(0),
			summaryPartAdded(0),
			summaryDelta(0, "AAA"),
			summaryDelta(0, "BBB"),
			reasoningDone(0, "SHORT"),
			completedEvent(),
		]);

		const signature = thinkingBlockOf(output)?.thinkingSignature;
		expect(typeof signature).toBe("string");
		expect(JSON.parse(signature as string).encrypted_content).toBe("ENC");
	});

	// A done payload that extends the streamed text is authoritative for the
	// tail: append it and emit it as a delta so the stream matches the block.
	it("appends the missing tail when the done summary extends the streamed text", async () => {
		const { output, events } = await driveResponsesStream([
			reasoningAdded(0),
			summaryPartAdded(0),
			summaryDelta(0, "AAA"),
			reasoningDone(0, "AAABBB"),
			completedEvent(),
		]);

		expect(thinkingBlockOf(output)?.thinking).toBe("AAABBB");
		const deltas = events.filter((event) => event.type === "thinking_delta") as Array<{ delta: string }>;
		expect(deltas.map((event) => event.delta)).toEqual(["AAA", "BBB"]);
	});
});
