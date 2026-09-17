import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.js";

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "hello proxy", timestamp: Date.now() }],
	};
}

const PROXY_USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function proxyStreamResponse(): Response {
	const events = [
		{ type: "start" },
		{ type: "text_start", contentIndex: 0 },
		{ type: "text_delta", contentIndex: 0, delta: "ok" },
		{ type: "text_end", contentIndex: 0 },
		{ type: "done", reason: "stop", usage: PROXY_USAGE },
	];
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n`).join("")}\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** Drives the public streamProxy entry point and returns the options object it put on the wire. */
async function captureRequestOptions(overrides: Partial<SimpleStreamOptions> = {}): Promise<Record<string, unknown>> {
	const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => proxyStreamResponse());
	vi.stubGlobal("fetch", fetchMock);

	const stream = streamProxy(createModel(), createContext(), {
		authToken: "proxy-token",
		proxyUrl: "https://proxy.invalid",
		...overrides,
	});
	await stream.result();

	const call = fetchMock.mock.calls[0];
	if (!call) {
		throw new Error("expected streamProxy to issue a proxy request");
	}
	const payload = JSON.parse(String(call[1]?.body)) as { options: Record<string, unknown> };
	return payload.options;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("streamProxy request options", () => {
	// Fork delta: upstream's SimpleStreamOptions has no maxRetryDelayMs, but this fork's retry
	// cap chain pushes settings retry.provider.maxRetryDelayMs through the agent options into
	// the stream options. The proxy is the forward point of that chain, so dropping the field
	// here silently disables the cap for every proxied stream.
	it("forwards maxRetryDelayMs alongside the rest of the serializable subset", async () => {
		const options = await captureRequestOptions({
			temperature: 0.25,
			maxTokens: 123,
			reasoning: "high",
			cacheRetention: "short",
			sessionId: "session-1",
			headers: { "x-test": "1" },
			metadata: { tag: "proxy-pin" },
			transport: "sse",
			thinkingBudgets: { high: 4096 },
			maxRetryDelayMs: 45000,
		});

		expect(options.maxRetryDelayMs).toBe(45000);
		expect(options).toEqual({
			temperature: 0.25,
			maxTokens: 123,
			reasoning: "high",
			cacheRetention: "short",
			sessionId: "session-1",
			headers: { "x-test": "1" },
			metadata: { tag: "proxy-pin" },
			transport: "sse",
			thinkingBudgets: { high: 4096 },
			maxRetryDelayMs: 45000,
		});
	});

	// Control for the pin above: the wire options are a deliberate allow-list, so the
	// assertions there are about the serializable subset crossing the wire and not about
	// every stream option being forwarded.
	it("keeps host-only stream options off the wire", async () => {
		const options = await captureRequestOptions({
			signal: new AbortController().signal,
			timeoutMs: 5000,
			maxRetries: 3,
			onPayload: () => undefined,
		});

		for (const hostOnly of ["signal", "apiKey", "timeoutMs", "maxRetries", "onPayload", "onResponse"]) {
			expect(options).not.toHaveProperty(hostOnly);
		}
	});
});
