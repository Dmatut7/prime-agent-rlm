import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
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

function buildCompletedSse(): string {
	return `${[
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		})}`,
		`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}`,
		`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hello" })}`,
		`data: ${JSON.stringify({
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		})}`,
		`data: ${JSON.stringify({
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		})}`,
	].join("\n\n")}\n\n`;
}

function sseSuccessResponse(): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(buildCompletedSse()));
			controller.close();
		},
	});
	return new Response(stream, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function isCodexResponsesUrl(input: string | URL | Request): boolean {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	return url.includes("/codex/responses");
}

function installFetchMock(
	handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(input, init));
	global.fetch = fetchMock as typeof fetch;
	return fetchMock;
}

function codexFetchCount(fetchMock: ReturnType<typeof vi.fn>): number {
	return fetchMock.mock.calls.filter(([input]) => isCodexResponsesUrl(input as string | URL | Request)).length;
}

describe("openai-codex SSE retry behavior", () => {
	it("does not retry HTTP 401", async () => {
		const fetchMock = installFetchMock(async (input) => {
			if (!isCodexResponsesUrl(input)) {
				return new Response("not found", { status: 404 });
			}
			return new Response("unauthorized", { status: 401, statusText: "Unauthorized" });
		});

		const started = Date.now();
		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			transport: "sse",
		}).result();
		const elapsedMs = Date.now() - started;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/unauthorized/i);
		expect(codexFetchCount(fetchMock)).toBe(1);
		expect(elapsedMs).toBeLessThan(500);
	});

	it("retries HTTP 429 using Retry-After instead of the 1s exponential backoff", async () => {
		let responsesCalls = 0;
		const fetchMock = installFetchMock(async (input) => {
			if (!isCodexResponsesUrl(input)) {
				return new Response("not found", { status: 404 });
			}
			responsesCalls += 1;
			if (responsesCalls === 1) {
				return new Response("rate limited", {
					status: 429,
					statusText: "Too Many Requests",
					headers: { "Retry-After": "0" },
				});
			}
			return sseSuccessResponse();
		});

		const started = Date.now();
		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 1,
		}).result();
		const elapsedMs = Date.now() - started;

		expect(result.stopReason).toBe("stop");
		expect(result.content.find((block) => block.type === "text")?.text).toBe("Hello");
		expect(codexFetchCount(fetchMock)).toBe(2);
		expect(elapsedMs).toBeLessThan(500);
	});

	it("fails on the first attempt when maxRetries is 0", async () => {
		const fetchMock = installFetchMock(async (input) => {
			if (!isCodexResponsesUrl(input)) {
				return new Response("not found", { status: 404 });
			}
			return new Response("upstream down", { status: 503, statusText: "Service Unavailable" });
		});

		const started = Date.now();
		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 0,
		}).result();
		const elapsedMs = Date.now() - started;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/upstream down|service unavailable/i);
		expect(codexFetchCount(fetchMock)).toBe(1);
		expect(elapsedMs).toBeLessThan(500);
	});

	it("fails immediately when Retry-After exceeds maxRetryDelayMs", async () => {
		const fetchMock = installFetchMock(async (input) => {
			if (!isCodexResponsesUrl(input)) {
				return new Response("not found", { status: 404 });
			}
			return new Response("rate limited", {
				status: 429,
				statusText: "Too Many Requests",
				headers: { "Retry-After": "10" },
			});
		});

		const started = Date.now();
		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 3,
			maxRetryDelayMs: 50,
		}).result();
		const elapsedMs = Date.now() - started;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/10000ms exceeds maxRetryDelayMs 50ms/);
		expect(codexFetchCount(fetchMock)).toBe(1);
		expect(elapsedMs).toBeLessThan(500);
	});

	it("caps exponential backoff when fetch throws", async () => {
		vi.useFakeTimers();
		try {
			const fetchMock = installFetchMock(async (input) => {
				if (!isCodexResponsesUrl(input)) {
					return new Response("not found", { status: 404 });
				}
				throw new Error("socket hang up");
			});

			const resultPromise = streamOpenAICodexResponses(createModel(), createContext(), {
				apiKey: mockToken(),
				transport: "sse",
				maxRetries: 5,
				maxRetryDelayMs: 1000,
			}).result();

			await vi.runAllTimersAsync();
			const result = await resultPromise;

			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toMatch(/exceeds maxRetryDelayMs 1000ms/);
			expect(codexFetchCount(fetchMock)).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
