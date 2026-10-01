import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { AssistantMessage } from "../src/types.js";

/**
 * Anthropic-compatible proxies (e.g. z.ai) can reorder or interleave content_block
 * indexes. A delta or stop matching no open block was silently dropped, losing text
 * or tool-call arguments with stopReason "stop" and no trace. Each miss now persists
 * an `anthropic_content_block_event_unrouted` diagnostic (and a log line).
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

function textFrames(): SseFrame[] {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_unrouted_test",
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
			data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
		},
	];
}

function tailFrames(): SseFrame[] {
	return [
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

async function runStream(frames: SseFrame[]): Promise<AssistantMessage> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	return streamAnthropic(
		model,
		{ messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }] },
		{ client: createFakeAnthropicClient(createSseResponse(frames)) },
	).result();
}

function unroutedDiagnostics(message: AssistantMessage) {
	return (message.diagnostics ?? []).filter((entry) => entry.type === "anthropic_content_block_event_unrouted");
}

describe("Anthropic content_block index mismatch diagnostics", () => {
	it("records a diagnostic for a delta whose index matches no open block", async () => {
		const message = await runStream([
			...textFrames(),
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 2,
					delta: { type: "text_delta", text: "lost" },
				}),
			},
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			...tailFrames(),
		]);

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
		const diagnostics = unroutedDiagnostics(message);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].details).toMatchObject({
			eventType: "content_block_delta",
			index: 2,
			deltaType: "text_delta",
		});
	});

	it("records a diagnostic for a content_block_stop whose index matches no open block", async () => {
		const message = await runStream([
			...textFrames(),
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 7 }),
			},
			...tailFrames(),
		]);

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
		const diagnostics = unroutedDiagnostics(message);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].details).toMatchObject({ eventType: "content_block_stop", index: 7 });
	});

	it("records a diagnostic when a delta lands on a block of the wrong type", async () => {
		const message = await runStream([
			...textFrames(),
			{
				event: "content_block_delta",
				data: JSON.stringify({
					type: "content_block_delta",
					index: 0,
					delta: { type: "thinking_delta", thinking: "stray" },
				}),
			},
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			...tailFrames(),
		]);

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
		const diagnostics = unroutedDiagnostics(message);
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0].details).toMatchObject({
			eventType: "content_block_delta",
			index: 0,
			deltaType: "thinking_delta",
		});
	});

	it("emits no diagnostic for a well-formed stream (positive control)", async () => {
		const message = await runStream([
			...textFrames(),
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			...tailFrames(),
		]);

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(unroutedDiagnostics(message)).toHaveLength(0);
	});
});
