import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { ProviderRequestBudget } from "../src/providers/request-budget.js";
import type { Context, Model } from "../src/types.js";

/**
 * openai-codex-responses runs its own retry loops (WebSocket chain reset, SSE
 * backoff, WS->SSE fallback) with a bare fetch/WebSocket, so it bypassed the shared
 * cross-layer request budget entirely: the session's exhausted-budget gate never saw
 * codex attempts, and a persistent 429 could spend ~4x the chain ceiling. Every
 * codex fetch/ws attempt now records into the shared budget and is forwarded to
 * onProviderRequestAttempt; the attempt that spends the last request is not retried.
 */

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
	global.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
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

interface AttemptNotice {
	attempt: number;
	used: number;
	maxRequests?: number;
	status?: number;
	networkError?: boolean;
	retrySuppressedBy?: string;
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

function sseSuccessResponse(): Response {
	const body = `${[
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
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		})}`,
	].join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("openai-codex shared request budget", () => {
	it("stops the SSE retry loop when the shared budget is spent, and reports every attempt", async () => {
		const fetchMock = installFetchMock(async (input) => {
			if (!isCodexResponsesUrl(input)) {
				return new Response("not found", { status: 404 });
			}
			return new Response("rate limited", {
				status: 429,
				statusText: "Too Many Requests",
				headers: { "Retry-After": "0" },
			});
		});

		const budget = new ProviderRequestBudget(2);
		const notices: AttemptNotice[] = [];
		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 5,
			requestBudget: budget,
			onProviderRequestAttempt: (notice) => notices.push(notice),
		}).result();

		expect(result.stopReason).toBe("error");
		// The budget cut the retry, but the failure keeps its provider classification.
		expect(result.errorMessage).toMatch(/rate limit/i);
		expect(codexFetchCount(fetchMock)).toBe(2);
		expect(budget.used).toBe(2);
		expect(budget.exhausted).toBe(true);
		expect(notices.map((notice) => notice.attempt)).toEqual([1, 2]);
		expect(notices[0]).toMatchObject({ status: 429, used: 1 });
		expect(notices[1]).toMatchObject({ status: 429, used: 2, retrySuppressedBy: "request_budget" });
	});

	it("stops retrying a network failure when the attempt spent the chain's last request", async () => {
		const fetchMock = installFetchMock(async (input) => {
			if (!isCodexResponsesUrl(input)) {
				return new Response("not found", { status: 404 });
			}
			throw new Error("socket hang up");
		});

		const budget = new ProviderRequestBudget(1);
		const notices: AttemptNotice[] = [];
		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 5,
			requestBudget: budget,
			onProviderRequestAttempt: (notice) => notices.push(notice),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/socket hang up/);
		expect(codexFetchCount(fetchMock)).toBe(1);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ attempt: 1, networkError: true, retrySuppressedBy: "request_budget" });
	});

	it("reports successful attempts without suppressing retries (positive control)", async () => {
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

		const budget = new ProviderRequestBudget(12);
		const notices: AttemptNotice[] = [];
		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			transport: "sse",
			maxRetries: 3,
			requestBudget: budget,
			onProviderRequestAttempt: (notice) => notices.push(notice),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(codexFetchCount(fetchMock)).toBe(2);
		expect(notices.map((notice) => notice.status)).toEqual([429, 200]);
		expect(notices.every((notice) => notice.retrySuppressedBy === undefined)).toBe(true);
	});

	it("skips the WebSocket->SSE fallback once the budget is spent on the ws attempt", async () => {
		class FailingWebSocket {
			readyState = 3;
			private listeners = new Map<string, Set<(event: unknown) => void>>();

			constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
				queueMicrotask(() => this.dispatch("error", { message: "ws unavailable" }));
			}

			addEventListener(type: string, listener: (event: unknown) => void): void {
				let listeners = this.listeners.get(type);
				if (!listeners) {
					listeners = new Set();
					this.listeners.set(type, listeners);
				}
				listeners.add(listener);
			}

			removeEventListener(type: string, listener: (event: unknown) => void): void {
				this.listeners.get(type)?.delete(listener);
			}

			send(): void {}

			close(): void {}

			private dispatch(type: string, event: unknown): void {
				for (const listener of this.listeners.get(type) ?? []) {
					listener(event);
				}
			}
		}
		globalThis.WebSocket = FailingWebSocket as unknown as typeof WebSocket;
		const fetchMock = installFetchMock(async () => sseSuccessResponse());

		const budget = new ProviderRequestBudget(1);
		const notices: AttemptNotice[] = [];
		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			transport: "auto",
			requestBudget: budget,
			onProviderRequestAttempt: (notice) => notices.push(notice),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/server error/i);
		// No SSE fallback request once the chain's last request was spent.
		expect(codexFetchCount(fetchMock)).toBe(0);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ attempt: 1, networkError: true, retrySuppressedBy: "request_budget" });
	});
});
