import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

/**
 * mapCodexEvents folded every terminal event (done/completed/incomplete) into
 * "response.completed", so a codex response truncated by the content filter reached
 * the shared layer as a normal completion and read as stopReason "length" — the
 * truncated-turn continuation then re-prompted a refusal in a loop. The terminal
 * event's own type now passes through, so incomplete reaches the shared layer's
 * incomplete branch (content_filter -> error, with the raw reason on record).
 */

const originalFetch = global.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	global.fetch = originalFetch;
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
	vi.restoreAllMocks();
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function createModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function sseBody(events: Array<Record<string, unknown>>): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
}

const prefixEvents: Array<Record<string, unknown>> = [
	{
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "partial answer" },
];

const usage = { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } };

async function runCodexSse(events: Array<Record<string, unknown>>): Promise<AssistantMessage> {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-incomplete-"));
	global.fetch = vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url.includes("/codex/responses")) {
			return new Response(sseBody(events), { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;

	return streamOpenAICodexResponses(createModel(), createContext(), {
		apiKey: mockToken(),
		transport: "sse",
	}).result();
}

describe("openai-codex response.incomplete passthrough", () => {
	it("maps content_filter-truncated responses to an error with the raw reason, not length", async () => {
		const message = await runCodexSse([
			...prefixEvents,
			{
				type: "response.incomplete",
				response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "content_filter" }, usage },
			},
		]);

		expect(message.stopReason).toBe("error");
		expect(message.stopReasonRaw).toBe("content_filter");
		expect(message.errorMessage).toContain("content_filter");
		expect(message.usage.totalTokens).toBe(8);
		const diagnostic = message.diagnostics?.find((entry) => entry.type === "responses_incomplete");
		expect(diagnostic?.details?.reason).toBe("content_filter");
	});

	it("keeps max_output_tokens truncation as length with the reason on record", async () => {
		const message = await runCodexSse([
			...prefixEvents,
			{
				type: "response.incomplete",
				response: {
					id: "resp_1",
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					usage,
				},
			},
		]);

		expect(message.stopReason).toBe("length");
		expect(message.errorMessage).toBeUndefined();
		expect(message.usage.totalTokens).toBe(8);
		const diagnostic = message.diagnostics?.find((entry) => entry.type === "responses_incomplete");
		expect(diagnostic?.details?.reason).toBe("max_output_tokens");
	});
});
