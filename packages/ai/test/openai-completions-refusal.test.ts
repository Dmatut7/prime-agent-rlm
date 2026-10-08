import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.js";

/**
 * R3-M28: openai-completions never read `delta.refusal`, so a refusal arrived
 * with empty content and finish_reason "stop" and was misdiagnosed as an empty
 * response - the retry ladder then re-sent the whole context until the policy
 * ran out. The refusal channel is now surfaced as a classified, permanent
 * refusal error carrying the refusal text.
 */

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

function startFakeRefusalServer(refusalChunks: string[]) {
	return startFakeServer((res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		const frames = refusalChunks.map(
			(refusal) =>
				`data: ${JSON.stringify({
					id: "chunk_refusal",
					object: "chat.completion.chunk",
					created: 0,
					model: "probe-model",
					choices: [{ index: 0, delta: { refusal }, finish_reason: null }],
				})}\n\n`,
		);
		frames.push(
			`data: ${JSON.stringify({
				id: "chunk_refusal",
				object: "chat.completion.chunk",
				created: 0,
				model: "probe-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
			"data: [DONE]\n\n",
		);
		res.end(frames.join(""));
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

describe("openai-completions refusal channel", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("surfaces a streamed refusal as a classified permanent refusal error", async () => {
		const server = await startFakeRefusalServer(["I'm sorry, but I can't help with that."]);
		try {
			const message = await terminalMessage(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					maxRetries: 0,
				}),
			);

			expect(message.stopReason).toBe("error");
			expect(message.stopReasonRaw).toBe("refusal");
			expect(message.errorMessage).toContain("Model refused to respond");
			expect(message.errorMessage).toContain("I'm sorry, but I can't help with that.");
			// The refusal must not be mistaken for an empty-but-clean completion.
			expect(message.content).toEqual([]);

			const failure = message.diagnostics?.find((entry) => entry.type === "provider_stream_failure");
			expect(failure, "a refusal must record a provider_stream_failure diagnostic").toBeDefined();
			expect(failure?.details?.kind).toBe("refusal");
			expect(failure?.details?.providerErrorType).toBe("refusal");
		} finally {
			await server.close();
		}
	});

	it("joins refusal text split across multiple chunks", async () => {
		const server = await startFakeRefusalServer(["I'm sorry, ", "I can't ", "help with that."]);
		try {
			const message = await terminalMessage(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					maxRetries: 0,
				}),
			);

			expect(message.stopReason).toBe("error");
			expect(message.stopReasonRaw).toBe("refusal");
			expect(message.errorMessage).toContain("I'm sorry, I can't help with that.");
		} finally {
			await server.close();
		}
	});
});
