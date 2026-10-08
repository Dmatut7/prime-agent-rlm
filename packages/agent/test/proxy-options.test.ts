import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
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

describe("streamProxy error surface", () => {
	async function runFailingProxy(response: Response): Promise<AssistantMessage> {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);
		const stream = streamProxy(createModel(), createContext(), {
			authToken: "proxy-token",
			proxyUrl: "https://proxy.invalid",
		});
		return stream.result();
	}

	// The server's error text is attacker-influenced text that lands in the
	// persisted transcript: it must not carry credentials or terminal controls.
	it("redacts and washes the server's error body before it becomes the errorMessage", async () => {
		const message = await runFailingProxy(
			new Response(JSON.stringify({ error: "bad key sk-ant-" + "a1b2c3d4e5f6g7h8 \x1b[2J\x07 now" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			}),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Proxy error:");
		expect(message.errorMessage).not.toContain("sk-ant-a1b2c3d4e5f6g7h8"); // secret-scan: allow
		expect(message.errorMessage).not.toContain("\x1b");
		expect(message.errorMessage).not.toContain("\x07");
		expect(message.errorMessage).toContain("now");
	});

	it("bounds an unbounded server error body", async () => {
		const message = await runFailingProxy(
			new Response(JSON.stringify({ error: "x".repeat(100_000) }), {
				status: 500,
				headers: { "Content-Type": "application/json" },
			}),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage?.length ?? 0).toBeLessThan(10_000);
	});

	// A fetch-layer failure (connection refused, DNS) becomes the errorMessage
	// verbatim; the message can embed the request URL's credentials.
	it("redacts the transport failure's message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connect failed for https://user:sk-live-secret-abcdef@proxy.invalid"); // secret-scan: allow
			}),
		);
		const stream = streamProxy(createModel(), createContext(), {
			authToken: "proxy-token",
			proxyUrl: "https://proxy.invalid",
		});
		const message = await stream.result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).not.toContain("sk-live-secret-abcdef"); // secret-scan: allow
	});
});
