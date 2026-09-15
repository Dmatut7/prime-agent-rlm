import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";
import { StreamFailureError } from "../src/utils/stream-failure.js";

/**
 * ERR-2: `response.incomplete` was ignored entirely (only `response.completed` had
 * a branch), so a response truncated by max_output_tokens / content_filter was
 * reported as a normal stop with no usage and no reason on record.
 * E4-1: usage frames replaced each other wholesale, so a partial late frame zeroed
 * earlier fields. E4-2: totalTokens had no component-sum fallback.
 * ERR-1: a stream that ends without any terminal response event was reported as
 * a normal stop instead of a malformed response.
 */

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

async function driveResponsesStream(events: StreamedEvent[]): Promise<AssistantMessage> {
	const model = createModel();
	const output = createOutput(model);
	const stream = new AssistantMessageEventStream();
	const pushSpy = vi.spyOn(stream, "push");
	await processResponsesStream(
		(async function* () {
			for (const event of events) {
				yield event as unknown as ResponseStreamEvent;
			}
		})(),
		output,
		stream,
		model,
	);
	void pushSpy;
	return output;
}

interface StreamedEvent {
	type: string;
	[key: string]: unknown;
}

function completedEvent(usage: Record<string, number>): StreamedEvent {
	return {
		type: "response.completed",
		sequence_number: 1,
		response: { id: "resp_1", status: "completed", usage },
	};
}

function incompleteEvent(usage: Record<string, number> | undefined, reason: string): StreamedEvent {
	return {
		type: "response.incomplete",
		sequence_number: 2,
		response: {
			id: "resp_2",
			status: "incomplete",
			incomplete_details: { reason },
			...(usage ? { usage } : {}),
		},
	};
}

describe("openai responses incomplete handling and stream termination", () => {
	it("maps response.incomplete (max_output_tokens) to a non-stop reason with usage and reason on record", async () => {
		const output = await driveResponsesStream([
			incompleteEvent({ input_tokens: 1000, output_tokens: 50 }, "max_output_tokens"),
		]);

		expect(output.stopReason).toBe("length");
		expect(output.usage.input).toBe(1000);
		expect(output.usage.output).toBe(50);
		expect(output.usage.totalTokens).toBe(1050);
		const diagnostic = output.diagnostics?.find((entry) => entry.type === "responses_incomplete");
		expect(diagnostic?.details?.reason).toBe("max_output_tokens");
	});

	it("maps response.incomplete (content_filter) to an error stop with the raw reason", async () => {
		const output = await driveResponsesStream([
			incompleteEvent({ input_tokens: 10, output_tokens: 5 }, "content_filter"),
		]);

		expect(output.stopReason).toBe("error");
		expect(output.stopReasonRaw).toBe("content_filter");
	});

	it("keeps usage from an earlier frame when the incomplete frame only reports output tokens", async () => {
		const output = await driveResponsesStream([
			completedEvent({ input_tokens: 1000 }),
			incompleteEvent({ output_tokens: 50 }, "max_output_tokens"),
		]);

		expect(output.usage.input).toBe(1000);
		expect(output.usage.output).toBe(50);
		expect(output.usage.totalTokens).toBe(1050);
	});

	it("keeps usage when the incomplete event carries no usage at all", async () => {
		const output = await driveResponsesStream([
			completedEvent({ input_tokens: 1000, output_tokens: 50, total_tokens: 1050 }),
			incompleteEvent(undefined, "max_output_tokens"),
		]);

		expect(output.usage.input).toBe(1000);
		expect(output.usage.output).toBe(50);
		expect(output.usage.totalTokens).toBe(1050);
	});

	it("falls back to the component sum when total_tokens is missing (completed path)", async () => {
		const output = await driveResponsesStream([completedEvent({ input_tokens: 1000, output_tokens: 50 })]);

		expect(output.usage.totalTokens).toBe(1050);
	});

	it("uses the provider total when present (positive control)", async () => {
		const output = await driveResponsesStream([
			completedEvent({ input_tokens: 1000, output_tokens: 50, total_tokens: 1050 }),
		]);

		expect(output.stopReason).toBe("stop");
		expect(output.usage.totalTokens).toBe(1050);
	});

	it("errors when the stream ends without a terminal response event", async () => {
		let thrown: unknown;
		try {
			await driveResponsesStream([
				{
					type: "response.output_item.added",
					sequence_number: 0,
					output_index: 0,
					item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
				},
				{
					type: "response.output_text.delta",
					sequence_number: 1,
					item_id: "msg_1",
					output_index: 0,
					content_index: 0,
					delta: "partial",
				},
			]);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(StreamFailureError);
		expect((thrown as StreamFailureError).info.kind).toBe("malformed_response");
	});
});
