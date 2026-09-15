import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streamAnthropic } from "../src/providers/anthropic.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessageEvent, Context, Model, ProviderRetryNotice } from "../src/types.js";

function createContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
}

async function terminalEvent(stream: AsyncIterable<AssistantMessageEvent>) {
	let last: AssistantMessageEvent | undefined;
	for await (const event of stream) {
		last = event;
		if (event.type === "done" || event.type === "error") break;
	}
	return last;
}

/** Server that answers every request with 429 + a `retry-after` the client must obey. */
interface FakeRateLimiter {
	url: string;
	requests(): number;
	close(): Promise<void>;
}

async function startRateLimitedServer(retryAfterSeconds: number): Promise<FakeRateLimiter> {
	let count = 0;
	const server = http.createServer((_req, res) => {
		count++;
		res.writeHead(429, {
			"content-type": "application/json",
			"retry-after": String(retryAfterSeconds),
		});
		res.end(JSON.stringify({ error: { type: "rate_limit_exceeded", message: "slow down" }, type: "error" }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		requests: () => count,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

function completionsModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "cap-model",
		name: "cap-model",
		api: "openai-completions",
		provider: "cap-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};
}

function anthropicModel(baseUrl: string): Model<"anthropic-messages"> {
	return {
		id: "cap-model",
		name: "cap-model",
		api: "anthropic-messages",
		provider: "cap-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 1024,
	};
}

describe("retry.provider.maxRetryDelayMs across providers", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
	});

	it("fails instead of sleeping past the cap on openai-completions", async () => {
		const server = await startRateLimitedServer(5);
		try {
			const notices: ProviderRetryNotice[] = [];
			const startedAt = Date.now();
			const event = await terminalEvent(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					maxRetries: 2,
					maxRetryDelayMs: 100,
					onProviderRetry: (notice) => notices.push(notice),
				}),
			);
			const elapsedMs = Date.now() - startedAt;

			expect(event?.type).toBe("error");
			// The server asked for 5s and the cap is 100ms: the wait must not happen.
			expect(elapsedMs).toBeLessThan(2000);
			expect(server.requests()).toBe(1);
			expect(notices[0]).toMatchObject({ status: 429, delayMs: 5000, capped: true });
		} finally {
			await server.close();
		}
	}, 20000);

	it("fails instead of sleeping past the cap on anthropic", async () => {
		const server = await startRateLimitedServer(5);
		try {
			const notices: ProviderRetryNotice[] = [];
			const startedAt = Date.now();
			const event = await terminalEvent(
				streamAnthropic(anthropicModel(server.url), createContext(), {
					apiKey: "test-key",
					maxRetries: 2,
					maxRetryDelayMs: 100,
					onProviderRetry: (notice) => notices.push(notice),
				}),
			);
			const elapsedMs = Date.now() - startedAt;

			expect(event?.type).toBe("error");
			expect(elapsedMs).toBeLessThan(2000);
			expect(server.requests()).toBe(1);
			expect(notices[0]).toMatchObject({ status: 429, delayMs: 5000, capped: true });
		} finally {
			await server.close();
		}
	}, 20000);

	it("still obeys a server-requested wait that is inside the cap (positive control)", async () => {
		const server = await startRateLimitedServer(1);
		try {
			const notices: Array<{ status: number; delayMs: number; capped: boolean }> = [];
			const startedAt = Date.now();
			const event = await terminalEvent(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					maxRetries: 1,
					maxRetryDelayMs: 3000,
					onProviderRetry: (notice) => notices.push(notice),
				}),
			);
			const elapsedMs = Date.now() - startedAt;

			expect(event?.type).toBe("error");
			expect(elapsedMs).toBeGreaterThanOrEqual(900);
			expect(server.requests()).toBe(2);
			// Both attempts answer 429 with the same instruction; neither is capped.
			expect(notices).toHaveLength(2);
			for (const notice of notices) {
				expect(notice).toMatchObject({ status: 429, delayMs: 1000, capped: false });
			}
		} finally {
			await server.close();
		}
	}, 20000);

	it("treats maxRetryDelayMs: 0 as no cap at all", async () => {
		const server = await startRateLimitedServer(2);
		try {
			const startedAt = Date.now();
			await terminalEvent(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					maxRetries: 1,
					maxRetryDelayMs: 0,
				}),
			);
			const elapsedMs = Date.now() - startedAt;

			expect(elapsedMs).toBeGreaterThanOrEqual(1800);
			expect(server.requests()).toBe(2);
		} finally {
			await server.close();
		}
	}, 20000);
});
