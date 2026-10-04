import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.js";
import type { Context, Model } from "../src/types.js";

/**
 * Transport classification on the WebSocket path. The WS->SSE fallback exists for
 * connections that never delivered a usable response; a provider outcome that the
 * connection delivered fine (an `error` frame, a model stop reason) must neither
 * resend the conversation over SSE nor poison the session's fallback bookkeeping.
 * CodexProtocolError (a frame that did not parse, a stream that closed before its
 * terminal event) is transport-class: it never carried a provider outcome, so it
 * falls back like a dropped connection. The attempt notice's `networkError` flag
 * documents "failed without any response" (request-budget.ts) and must not be
 * stamped on a failure the provider actually answered.
 */

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
	global.fetch = originalFetch;
	globalThis.WebSocket = originalWebSocket;
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
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

interface ScriptedSocketHandle {
	/** Deliver server frames; each entry is JSON-serialized onto one message event. */
	emit: (events: unknown[]) => void;
	/** Deliver one raw, unparseable message frame. */
	emitRaw: (data: string) => void;
	/** Simulate the server dropping the connection. */
	closeFromServer: (event: { code: number; reason: string }) => void;
}

function installScriptedCodexWebSocket(
	scripts: Array<(socket: ScriptedSocketHandle) => void>,
): Record<string, unknown>[] {
	const sentBodies: Record<string, unknown>[] = [];

	class MockWebSocket {
		static OPEN = 1;
		readyState = MockWebSocket.OPEN;
		private listeners = new Map<string, Set<(event: unknown) => void>>();

		constructor(_url: string, _protocols?: string | string[] | { headers?: Record<string, string> }) {
			queueMicrotask(() => this.dispatch("open", {}));
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

		send(data: string): void {
			sentBodies.push(JSON.parse(data) as Record<string, unknown>);
			const script = scripts.shift();
			if (!script) throw new Error("unexpected websocket request");
			queueMicrotask(() =>
				script({
					emit: (events: unknown[]) => {
						for (const event of events) {
							this.dispatch("message", { data: JSON.stringify(event) });
						}
					},
					emitRaw: (data: string) => this.dispatch("message", { data }),
					closeFromServer: (event: { code: number; reason: string }) => {
						this.readyState = 3;
						this.dispatch("close", event);
					},
				}),
			);
		}

		close(): void {
			this.readyState = 3;
		}

		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) {
				listener(event);
			}
		}
	}

	globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
	return sentBodies;
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

function installSseFetchMock(): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url.includes("/codex/responses")) {
			return sseSuccessResponse();
		}
		return new Response("not found", { status: 404 });
	});
	global.fetch = fetchMock as typeof fetch;
	return fetchMock;
}

describe("openai-codex WebSocket transport classification", () => {
	it("falls back to SSE when the WebSocket closes before the terminal frame", async () => {
		installScriptedCodexWebSocket([
			(socket) => {
				socket.emit([{ type: "response.created", response: { id: "resp_1" } }]);
				socket.closeFromServer({ code: 1006, reason: "abnormal" });
			},
		]);
		const fetchMock = installSseFetchMock();
		const notices: AttemptNotice[] = [];
		const sessionId = "session-ws-close-fallback";

		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			sessionId,
			transport: "auto",
			onProviderRequestAttempt: (notice) => notices.push(notice),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "Hello" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		// A dropped connection never delivered a response: the notice is a network error.
		expect(notices[0]).toMatchObject({ networkError: true });
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
			websocketFailures: 1,
			sseFallbacks: 1,
			websocketFallbackActive: true,
		});
	});

	it("falls back to SSE when a WebSocket frame does not parse (protocol failure is transport-class)", async () => {
		installScriptedCodexWebSocket([
			(socket) => {
				socket.emit([{ type: "response.created", response: { id: "resp_1" } }]);
				socket.emitRaw("this is not json{");
			},
		]);
		const fetchMock = installSseFetchMock();
		const notices: AttemptNotice[] = [];
		const sessionId = "session-ws-protocol-fallback";

		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			sessionId,
			transport: "auto",
			onProviderRequestAttempt: (notice) => notices.push(notice),
		}).result();

		// The unparseable frame never carried a provider outcome, so the request
		// falls back instead of failing, and the session remembers the WS is bad.
		expect(result.stopReason).toBe("stop");
		expect(result.content[0]).toMatchObject({ type: "text", text: "Hello" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(notices[0]).toMatchObject({ networkError: true });
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
			websocketFailures: 1,
			sseFallbacks: 1,
			websocketFallbackActive: true,
		});
	});

	it("does not fall back or report a network error for a provider error frame delivered fine", async () => {
		installScriptedCodexWebSocket([
			(socket) => socket.emit([{ type: "error", code: "server_error", message: "backend exploded" }]),
		]);
		const fetchMock = installSseFetchMock();
		const notices: AttemptNotice[] = [];
		const sessionId = "session-ws-server-error";

		const result = await streamOpenAICodexResponses(createModel(), createContext(), {
			apiKey: mockToken(),
			sessionId,
			transport: "auto",
			onProviderRequestAttempt: (notice) => notices.push(notice),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("backend exploded");
		// The provider answered over a healthy connection: no SSE resend, no
		// networkError mislabel, and the session's WebSocket stays trusted.
		expect(fetchMock).not.toHaveBeenCalled();
		expect(notices).toHaveLength(1);
		expect(notices[0].networkError).toBeUndefined();
		expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
			websocketFailures: 0,
			sseFallbacks: 0,
		});
		expect(getOpenAICodexWebSocketDebugStats(sessionId)?.websocketFallbackActive).toBeFalsy();
	});
});
