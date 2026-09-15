import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

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

interface StreamedEvent {
	type: string;
	[key: string]: unknown;
}

const itemAdded: StreamedEvent = {
	type: "response.output_item.added",
	output_index: 0,
	item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
};
const partAdded: StreamedEvent = { type: "response.content_part.added", part: { type: "output_text", text: "" } };
const delta: StreamedEvent = { type: "response.output_text.delta", delta: "Hello" };
const itemDone: StreamedEvent = {
	type: "response.output_item.done",
	output_index: 0,
	item: {
		type: "message",
		id: "msg_1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "Hello" }],
	},
};

function terminalEvent(kind: "completed" | "incomplete" | "failed"): StreamedEvent {
	if (kind === "completed") {
		return {
			type: "response.completed",
			response: {
				id: "resp_1",
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		};
	}
	if (kind === "incomplete") {
		return {
			type: "response.incomplete",
			response: {
				id: "resp_1",
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		};
	}
	return {
		type: "response.failed",
		response: { id: "resp_1", status: "failed", error: { code: "server_error", message: "boom" } },
	};
}

function sseBody(events: StreamedEvent[], options: { tail: string; separator?: string }): string {
	const separator = options.separator ?? "\n\n";
	const frames = events.map((event) => `data: ${JSON.stringify(event)}`);
	return frames.join(separator) + options.tail;
}

function sseResponse(body: string): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(body));
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function chunkedResponse(body: string, chunkSize: number): Response {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(body);
	const chunks: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += chunkSize) {
		chunks.push(bytes.slice(i, i + chunkSize));
	}
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(chunk);
			}
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function runCodexSse(response: Response): Promise<AssistantMessage> {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-sse-boundary-"));
	global.fetch = vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url.includes("/codex/responses")) {
			return response;
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;

	return streamOpenAICodexResponses(createModel(), createContext(), {
		apiKey: mockToken(),
		transport: "sse",
	}).result();
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("|");
}

describe("openai-codex SSE tail flush and terminal-event guard", () => {
	it("reports incomplete when the terminal event arrives without a trailing blank line", async () => {
		const message = await runCodexSse(
			sseResponse(sseBody([itemAdded, partAdded, delta, itemDone, terminalEvent("incomplete")], { tail: "" })),
		);

		expect(message.stopReason).toBe("length");
		expect(textOf(message)).toBe("Hello");
		expect(message.usage.totalTokens).toBe(8);
	});

	it("reports the provider failure when response.failed arrives without a trailing blank line", async () => {
		const message = await runCodexSse(
			sseResponse(sseBody([itemAdded, partAdded, delta, itemDone, terminalEvent("failed")], { tail: "" })),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("boom");
	});

	it("errors when the SSE stream closes without any terminal event", async () => {
		const message = await runCodexSse(
			sseResponse(sseBody([itemAdded, partAdded, delta, itemDone], { tail: "\n\n" })),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("response.completed");
	});

	it("keeps a completed response working with a trailing blank line (positive control)", async () => {
		const message = await runCodexSse(
			sseResponse(sseBody([itemAdded, partAdded, delta, itemDone, terminalEvent("completed")], { tail: "\n\n" })),
		);

		expect(message.stopReason).toBe("stop");
		expect(textOf(message)).toBe("Hello");
		expect(message.usage.totalTokens).toBe(8);
	});

	it("parses CRLF-framed SSE bodies (LF positive control)", async () => {
		const message = await runCodexSse(
			sseResponse(sseBody([itemAdded, partAdded, delta, itemDone, terminalEvent("completed")], { tail: "\n\n" })),
		);

		expect(textOf(message)).toBe("Hello");
		expect(message.usage.totalTokens).toBe(8);
	});

	it("parses CRLF-framed SSE bodies", async () => {
		const message = await runCodexSse(
			sseResponse(
				sseBody([itemAdded, partAdded, delta, itemDone, terminalEvent("completed")], {
					tail: "\r\n\r\n",
					separator: "\r\n\r\n",
				}),
			),
		);

		expect(message.stopReason).toBe("stop");
		expect(textOf(message)).toBe("Hello");
		expect(message.usage.totalTokens).toBe(8);
	});

	it("parses CRLF-framed SSE bodies delivered in small chunks", async () => {
		const body = sseBody([itemAdded, partAdded, delta, itemDone, terminalEvent("completed")], {
			tail: "\r\n\r\n",
			separator: "\r\n\r\n",
		});

		const message = await runCodexSse(chunkedResponse(body, 7));

		expect(message.stopReason).toBe("stop");
		expect(textOf(message)).toBe("Hello");
		expect(message.usage.totalTokens).toBe(8);
	});
});
