import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessageEvent, Context, Model } from "../src/types.js";

/**
 * Some OpenAI-compatible endpoints (z.ai among them) send the SSE terminal
 * `data: [DONE]` frame and then hold the connection open instead of closing the
 * body. The OpenAI SDK's stream iterator swallows the frame and keeps reading
 * until body EOF, so the chunk loop stalls mid-stream with the completion
 * already parsed on the wire (upstream #3361: "the turn stalled mid-stream with
 * the tool call parsed"). The provider must treat the terminal frame as the end
 * of the stream regardless of what the server does with the socket afterwards.
 */

const TERMINAL_WAIT_MS = 2000;

async function startHeldOpenDoneServer() {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
		res.write(
			frame({
				id: "chunk_1",
				object: "chat.completion.chunk",
				created: 0,
				model: "probe-model",
				choices: [{ index: 0, delta: { content: "done marker test" }, finish_reason: null }],
			}),
		);
		res.write(
			frame({
				id: "chunk_2",
				object: "chat.completion.chunk",
				created: 0,
				model: "probe-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
			}),
		);
		res.write("data: [DONE]\n\n");
		// No res.end(): the body never reaches EOF, exactly like a server that
		// parks the connection after the terminal frame.
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		close: async () => {
			server.closeAllConnections();
			server.close();
			await once(server, "close");
		},
	};
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

/**
 * Terminal event with a bounded wait: on the unfixed source the loop parks on
 * the held-open body and the guard rejects with the stall message instead of
 * the test timing out silently.
 */
async function terminalEvent(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent> {
	const loop = (async () => {
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") return event;
		}
		throw new Error("provider stream ended without a terminal event");
	})();
	const guard = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new Error(`stream stalled for ${TERMINAL_WAIT_MS}ms after the [DONE] frame`)),
			TERMINAL_WAIT_MS,
		);
	});
	return await Promise.race([loop, guard]);
}

describe("openai-completions SSE [DONE] termination", () => {
	const servers: Array<{ close: () => Promise<void> }> = [];

	afterEach(async () => {
		while (servers.length > 0) {
			await servers.pop()?.close();
		}
	});

	it("terminates the stream when the terminal [DONE] frame arrives on a held-open body", async () => {
		const server = await startHeldOpenDoneServer();
		servers.push(server);

		const stream = streamOpenAICompletions(completionsModel(server.url), createContext(), {
			apiKey: "probe-key",
		});
		const terminal = await terminalEvent(stream);

		expect(terminal.type).toBe("done");
		if (terminal.type !== "done") throw new Error("unreachable");
		expect(terminal.message.stopReason).toBe("stop");
		expect(terminal.message.content.some((block) => block.type === "text" && block.text === "done marker test")).toBe(
			true,
		);
	});
});
