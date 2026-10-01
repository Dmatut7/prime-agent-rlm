import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";
import { StreamFailureError } from "../src/utils/stream-failure.js";

/**
 * The responses/codex `response.failed` branch threw immediately, discarding the
 * usage a failed frame can carry — every failed attempt in a retry chain billed zero
 * tokens while the provider charged for them. The failed frame's usage now goes
 * through the same merge + cost calculation as a completed frame.
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

async function driveFailedStream(events: Array<Record<string, unknown>>): Promise<{
	output: AssistantMessage;
	thrown: unknown;
}> {
	const model = createModel();
	const output = createOutput(model);
	const stream = new AssistantMessageEventStream();
	let thrown: unknown;
	try {
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
	} catch (error) {
		thrown = error;
	}
	return { output, thrown };
}

describe("responses response.failed usage preservation", () => {
	it("keeps the usage carried by a failed frame before throwing", async () => {
		const { output, thrown } = await driveFailedStream([
			{
				type: "response.failed",
				response: {
					id: "resp_fail",
					status: "failed",
					error: { code: "server_error", message: "boom" },
					usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
				},
			},
		]);

		expect(thrown).toBeInstanceOf(StreamFailureError);
		expect(output.usage.input).toBe(12);
		expect(output.usage.output).toBe(3);
		expect(output.usage.totalTokens).toBe(15);
	});

	it("merges a partial failed-frame usage over an earlier terminal frame", async () => {
		const { output, thrown } = await driveFailedStream([
			{
				// No total_tokens: the component-sum fallback covers the merged frame.
				type: "response.completed",
				response: { id: "resp_1", status: "completed", usage: { input_tokens: 1000 } },
			},
			{
				type: "response.failed",
				response: {
					id: "resp_1",
					status: "failed",
					error: { code: "server_error", message: "boom" },
					usage: { output_tokens: 50 },
				},
			},
		]);

		expect(thrown).toBeInstanceOf(StreamFailureError);
		expect(output.usage.input).toBe(1000);
		expect(output.usage.output).toBe(50);
		expect(output.usage.totalTokens).toBe(1050);
	});
});

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function createCodexModel(): Model<"openai-codex-responses"> {
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

function createCodexContext(): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

describe("codex response.failed usage preservation", () => {
	it("bills the usage carried by a codex response.failed frame", async () => {
		process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-failed-usage-"));
		const body = `${[
			`data: ${JSON.stringify({
				type: "response.failed",
				response: {
					id: "resp_1",
					status: "failed",
					error: { code: "server_error", message: "boom" },
					usage: { input_tokens: 21, output_tokens: 7, total_tokens: 28 },
				},
			})}`,
		].join("\n\n")}\n\n`;
		global.fetch = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("/codex/responses")) {
				return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
			}
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const message = await streamOpenAICodexResponses(createCodexModel(), createCodexContext(), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 0,
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("boom");
		expect(message.usage.input).toBe(21);
		expect(message.usage.output).toBe(7);
		expect(message.usage.totalTokens).toBe(28);
	});
});
