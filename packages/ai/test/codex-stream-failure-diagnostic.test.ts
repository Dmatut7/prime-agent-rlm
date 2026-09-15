import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

/**
 * ERR-3: openai-codex-responses was the only provider that neither recorded a
 * provider_stream_failure diagnostic nor redacted its errorMessage, so an
 * upstream 401 body echoing the API key was persisted verbatim, and the
 * session's permanent-failure gate (which reads the diagnostic kind) never saw
 * an auth failure.
 */

const originalFetch = global.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	global.fetch = originalFetch;
	if (originalAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	}
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

async function runCodexResponse(responseFactory: () => Response): Promise<AssistantMessage> {
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-failure-diagnostic-"));
	// A fresh Response per call: a retried request must not hand back an
	// already-consumed body.
	global.fetch = vi.fn(async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		if (url.includes("/codex/responses")) {
			return responseFactory();
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;

	return streamOpenAICodexResponses(createModel(), createContext(), {
		apiKey: mockToken(),
		transport: "sse",
		maxRetries: 0,
	}).result();
}

function failureDetails(message: AssistantMessage): Record<string, unknown> | undefined {
	return message.diagnostics?.find((entry) => entry.type === "provider_stream_failure")?.details;
}

describe("openai-codex stream failure diagnostic and redaction", () => {
	it("redacts the API key and records an auth-kind diagnostic on a 401", async () => {
		const message = await runCodexResponse(
			() =>
				new Response(
					JSON.stringify({
						error: {
							message:
								"Incorrect API key provided: sk-live-SUPERSECRET123. You can find your API key at https://platform.openai.com/account/api-keys.",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "content-type": "application/json" } },
				),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).not.toContain("SUPERSECRET");
		expect(message.errorMessage).not.toContain("sk-live");
		const details = failureDetails(message);
		expect(details?.kind).toBe("auth");
		expect(details?.status).toBe(401);
	});

	it("keeps the request-scoped message out of the diagnostic payload (no plaintext key persisted)", async () => {
		const message = await runCodexResponse(
			() =>
				new Response(
					JSON.stringify({ error: { message: "Incorrect API key provided: sk-live-SUPERSECRET123." } }),
					{ status: 401, statusText: "Unauthorized", headers: { "content-type": "application/json" } },
				),
		);

		const serialized = JSON.stringify(message.diagnostics ?? []);
		expect(serialized).not.toContain("SUPERSECRET");
		expect(serialized).not.toContain("sk-live");
	});

	it("records a rate_limit diagnostic on a 429 with a usage-limit body", async () => {
		const message = await runCodexResponse(
			() =>
				new Response(
					JSON.stringify({
						error: {
							code: "usage_limit_reached",
							message: "You have hit your ChatGPT usage limit.",
							plan_type: "pro",
						},
					}),
					{ status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json" } },
				),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("usage limit");
		const details = failureDetails(message);
		expect(details?.kind).toBe("rate_limit");
		expect(details?.status).toBe(429);
	});
});
