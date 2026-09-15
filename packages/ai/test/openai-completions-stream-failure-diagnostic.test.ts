import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.js";

/**
 * Every provider but openai-completions records a `provider_stream_failure` diagnostic
 * from its terminal catch, and the session's "never resend a permanent failure" gate
 * reads only that diagnostic. openai-completions recorded none, so a permanent 400 from
 * an OpenAI-compatible endpoint (all local bailian models) was retried with the whole
 * context. The fake endpoint below is driven through two providers: openai-responses was
 * already wired and is the positive control for the harness itself — if it stopped
 * reporting, a missing diagnostic in openai-completions would prove nothing.
 */

const REQUEST_ID = "req_probe_400";

async function startFakeServer(handler: (res: http.ServerResponse) => void) {
	const server = http.createServer((_req, res) => handler(res));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

function startFakeErrorServer(status: number, body: unknown) {
	return startFakeServer((res) => {
		res.writeHead(status, { "content-type": "application/json", "x-request-id": REQUEST_ID });
		res.end(JSON.stringify(body));
	});
}

/** Streams one chunk whose finish reason maps to an error, then closes the stream. */
function startFakeContentFilterServer() {
	return startFakeServer((res) => {
		res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": REQUEST_ID });
		res.end(
			`data: ${JSON.stringify({
				id: "chunk_1",
				object: "chat.completion.chunk",
				created: 0,
				model: "probe-model",
				choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
			})}\n\ndata: [DONE]\n\n`,
		);
	});
}

async function terminalMessage(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessage> {
	let last: AssistantMessageEvent | undefined;
	for await (const event of stream) {
		last = event;
		if (event.type === "done" || event.type === "error") break;
	}
	if (!last || (last.type !== "done" && last.type !== "error")) {
		throw new Error("provider stream ended without a terminal event");
	}
	return last.type === "done" ? last.message : last.error;
}

function failureDetails(message: AssistantMessage): Record<string, unknown> | undefined {
	return message.diagnostics?.find((entry) => entry.type === "provider_stream_failure")?.details;
}

function createContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

function completionsModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "probe-model",
		name: "probe-model",
		api: "openai-completions",
		provider: "probe-provider",
		baseUrl: `${baseUrl}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function responsesModel(baseUrl: string): Model<"openai-responses"> {
	return {
		id: "probe-model",
		name: "probe-model",
		api: "openai-responses",
		provider: "probe-provider",
		baseUrl: `${baseUrl}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

const invalidRequestBody = { error: { type: "invalid_request_error", message: "bad tool schema" } };

describe("openai-completions stream failure diagnostic", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("diagnoses a permanent 400 with the provider's own type, status, and request id", async () => {
		const server = await startFakeErrorServer(400, invalidRequestBody);
		try {
			const message = await terminalMessage(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					maxRetries: 0,
				}),
			);

			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("400");
			const details = failureDetails(message);
			// Not `?.kind` alone: an absent diagnostic must fail here, not pass vacuously.
			expect(details, "openai-completions must record a provider_stream_failure diagnostic").toBeDefined();
			expect(details?.kind).toBe("invalid_request");
			expect(details?.providerErrorType).toBe("invalid_request_error");
			expect(details?.status).toBe(400);
			expect(details?.requestId).toBe(REQUEST_ID);
		} finally {
			await server.close();
		}
	});

	it("positive control: openai-responses reports the same failure through the same fake endpoint", async () => {
		const server = await startFakeErrorServer(400, invalidRequestBody);
		try {
			const message = await terminalMessage(
				streamOpenAIResponses(responsesModel(server.url), createContext(), {
					apiKey: "test-key",
					maxRetries: 0,
				}),
			);
			const details = failureDetails(message);
			expect(details, "openai-responses must record a provider_stream_failure diagnostic").toBeDefined();
			expect(details?.kind).toBe("invalid_request");
			expect(details?.status).toBe(400);
		} finally {
			await server.close();
		}
	});

	it("diagnoses an in-stream finish reason that maps to an error", async () => {
		const server = await startFakeContentFilterServer();
		try {
			const message = await terminalMessage(
				streamOpenAICompletions(completionsModel(server.url), createContext(), { apiKey: "test-key" }),
			);

			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toBe("Provider finish_reason: content_filter");
			const details = failureDetails(message);
			expect(details, "an error finish reason must be diagnosed too").toBeDefined();
			expect(details?.kind).toBe("safety");
		} finally {
			await server.close();
		}
	});

	it("keeps a user abort undiagnosed", async () => {
		const controller = new AbortController();
		controller.abort();
		const message = await terminalMessage(
			streamOpenAICompletions(completionsModel("http://127.0.0.1:1"), createContext(), {
				apiKey: "test-key",
				signal: controller.signal,
			}),
		);

		expect(message.stopReason).toBe("aborted");
		expect(message.diagnostics).toBeUndefined();
	});
});
