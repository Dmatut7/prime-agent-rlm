import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context } from "../src/types.js";

/**
 * R3-M25: an unparseable SSE frame used to be pasted into the error message
 * twice, unbounded (`data=<full frame>; raw=<full frame>`), so a 50KB frame
 * became a ~100KB errorMessage pinned above the input box. The message now
 * carries only the truncated data frame; the full frame stays on the
 * structured diagnostic's `raw` for post-mortems.
 */

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
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

function createContext(): Context {
	return { messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }] };
}

describe("Anthropic SSE parse failure reporting", () => {
	it("bounds the user-facing message and keeps the raw frame on the diagnostic", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		// 50KB of payload that no JSON repair can salvage.
		const payload = `garbage-${"x".repeat(50_000)}-TAILMARKER`;
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_trunc_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{ event: "content_block_delta", data: payload },
		]);

		const result = await streamAnthropic(model, createContext(), {
			client: createFakeAnthropicClient(response),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBeDefined();
		// The whole 50KB frame (let alone two copies of it) must not reach the
		// user-facing message.
		expect(result.errorMessage!.length).toBeLessThan(3_000);
		expect(result.errorMessage).not.toContain("TAILMARKER");
		expect(result.errorMessage).not.toContain("raw=");

		// The raw frame survives on the structured diagnostic for post-mortems,
		// bounded by the shared raw-payload cap.
		const failure = result.diagnostics?.find((entry) => entry.type === "provider_stream_failure");
		expect(failure, "a malformed SSE frame must record a provider_stream_failure diagnostic").toBeDefined();
		expect(failure?.details?.kind).toBe("malformed_response");
		const raw = failure?.details?.raw;
		expect(typeof raw).toBe("string");
		expect((raw as string).length).toBeLessThanOrEqual(2_001);
		expect(raw as string).toContain("garbage-");
	});
});
