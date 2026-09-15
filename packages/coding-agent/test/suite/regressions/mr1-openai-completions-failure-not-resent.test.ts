import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../../../../ai/src/providers/openai-completions.js";
import { createHarness, type Harness } from "../harness.js";

/**
 * MR-1, session side: the "a permanent provider failure is never resent with the whole
 * context" gate reads one thing — a `provider_stream_failure` diagnostic and its `kind`
 * (auth / invalid_request / refusal). openai-completions recorded no such diagnostic, so
 * a permanent 400 from any OpenAI-compatible endpoint took the retry path meant for a
 * transient outage.
 *
 * The diagnostic fed to the session here is not hand-written: it is the one the real
 * openai-completions provider produced against a local 400 endpoint, re-stamped as the
 * harness model so only the diagnostic can change the outcome. The third test drops that
 * diagnostic from the very same message and shows the session resends it, which is what
 * pins the effect on the diagnostic rather than on the harness.
 */

async function startFake400Server() {
	const server = http.createServer((_req, res) => {
		res.writeHead(400, { "content-type": "application/json", "x-request-id": "req_probe_400" });
		res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "bad tool schema" } }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

function probeModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "probe-model",
		name: "probe-model",
		api: "openai-completions",
		provider: "probe-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
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

describe("a permanent openai-completions failure is not resent", () => {
	const harnesses: Harness[] = [];
	const servers: Array<{ close: () => Promise<void> }> = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (servers.length > 0) {
			await servers.pop()?.close();
		}
	});

	async function realPermanentFailure(): Promise<AssistantMessage> {
		const server = await startFake400Server();
		servers.push(server);
		const message = await terminalMessage(
			streamOpenAICompletions(
				probeModel(server.url),
				{
					messages: [{ role: "user", content: "hello", timestamp: 1 }],
				} satisfies Context,
				{ apiKey: "test-key", maxRetries: 0 },
			),
		);
		expect(message.stopReason).toBe("error");
		return message;
	}

	function asHarnessModel(message: AssistantMessage, harness: Harness): AssistantMessage {
		const model = harness.getModel();
		return { ...message, api: model.api, provider: model.provider, model: model.id };
	}

	it("calls the provider once for a 400 the endpoint already rejected", async () => {
		const failure = await realPermanentFailure();
		expect(failure.diagnostics?.[0]?.details?.kind).toBe("invalid_request");

		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([asHarnessModel(failure, harness), fauxAssistantMessage("must not be requested")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.isRetrying).toBe(false);
	});

	it("resends the same message once the diagnostic is dropped (control for the diagnostic)", async () => {
		const failure = await realPermanentFailure();
		const undiagnosed = { ...failure };
		delete undiagnosed.diagnostics;

		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([asHarnessModel(undiagnosed, harness), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
	});
});
