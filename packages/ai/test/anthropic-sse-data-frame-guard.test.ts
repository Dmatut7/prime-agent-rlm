import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { AssistantMessage } from "../src/types.js";

interface SseFrame {
	event: string;
	data: string;
}

const fullEventStream: SseFrame[] = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_1",
				usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
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
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
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

function buildSseBody(frames: SseFrame[], options: { withEventLines: boolean }): string {
	const parts = frames.map((frame) =>
		options.withEventLines ? `event: ${frame.event}\ndata: ${frame.data}` : `data: ${frame.data}`,
	);
	return `${parts.join("\n\n")}\n\n`;
}

function createResponse(body: string): Response {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
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

async function runAnthropicStream(body: string): Promise<AssistantMessage> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	return streamAnthropic(
		model,
		{ messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }] },
		{ client: createFakeAnthropicClient(createResponse(body)) },
	).result();
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("|");
}

describe("Anthropic SSE data-frame guard", () => {
	it("parses a complete stream with event lines (positive control)", async () => {
		const message = await runAnthropicStream(buildSseBody(fullEventStream, { withEventLines: true }));

		expect(message.stopReason).toBe("stop");
		expect(textOf(message)).toBe("Hello");
		expect(message.usage.totalTokens).toBe(17);
	});

	it("errors when the body carries data frames but no event lines and never reaches message_stop", async () => {
		const message = await runAnthropicStream(buildSseBody(fullEventStream, { withEventLines: false }));

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("message_stop");
	});

	it("records a diagnostic for frames delivered without an event line", async () => {
		const parts = fullEventStream.map((frame, index) =>
			index === 2 ? `data: ${frame.data}` : `event: ${frame.event}\ndata: ${frame.data}`,
		);
		const body = `${parts.join("\n\n")}\n\n`;

		const message = await runAnthropicStream(body);

		expect(message.stopReason).toBe("stop");
		const diagnostics = message.diagnostics ?? [];
		expect(diagnostics.some((diagnostic) => diagnostic.type === "anthropic_sse_frame_without_event")).toBe(true);
	});
});
