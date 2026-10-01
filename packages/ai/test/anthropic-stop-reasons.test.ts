import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";

/**
 * mapStopReason threw on any stop reason outside its switch, so a long turn that hit
 * `model_context_window_exceeded` (or any future value the API adds) lost the whole
 * nearly-complete answer to an "Unhandled stop reason" error classified as unknown.
 * The exceeded-window reason now maps to "length" (bedrock/claude-code agree), and an
 * unrecognized reason surfaces as a classified error carrying the raw value.
 */

interface SseFrame {
	event: string;
	data: string;
}

function createSseResponse(events: SseFrame[]): Response {
	const body = `${events.map(({ event, data }) => `event: ${event}\ndata: ${data}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

function streamWithStopReason(stopReason: string) {
	const response = createSseResponse([
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_stop_reason_test",
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "partial" },
			}),
		},
		{
			event: "content_block_stop",
			data: JSON.stringify({ type: "content_block_stop", index: 0 }),
		},
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: stopReason },
				usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	]);

	const model = getModel("anthropic", "claude-haiku-4-5");
	return streamAnthropic(
		model,
		{ messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }] },
		{ client: createFakeAnthropicClient(response) },
	).result();
}

describe("Anthropic stop reason mapping", () => {
	it("maps model_context_window_exceeded to length and keeps the streamed text", async () => {
		const result = await streamWithStopReason("model_context_window_exceeded");

		expect(result.stopReason).toBe("length");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
	});

	it("surfaces an unrecognized stop reason as a classified error instead of throwing away the turn", async () => {
		const result = await streamWithStopReason("new_turn_reason");

		expect(result.stopReason).toBe("error");
		expect(result.stopReasonRaw).toBe("new_turn_reason");
		expect(result.errorMessage).toContain("new_turn_reason");
		expect(result.errorMessage).not.toContain("Unhandled stop reason");
		// The nearly complete answer is not discarded with the failure.
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		const failure = result.diagnostics?.find((entry) => entry.type === "provider_stream_failure");
		expect(failure?.details?.providerErrorType).toBe("new_turn_reason");
	});
});
