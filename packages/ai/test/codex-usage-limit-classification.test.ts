import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

/**
 * R3-M26: a Codex usage-limit 429 carries a friendly message (plan + reset
 * time) and a `resets_at` timestamp, but the classification layer dropped the
 * friendly message (showing the raw upstream text instead) and never turned
 * `resets_at` into `retryAfterMs`, so the retry ladder's consumer
 * (provider-retry.ts) never learned how long to wait.
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
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-codex-usage-limit-"));
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

describe("openai-codex usage-limit classification", () => {
	it("keeps the friendly plan/reset message and turns resets_at into retryAfterMs", async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 1800; // 30 minutes from now
		const message = await runCodexResponse(
			() =>
				new Response(
					JSON.stringify({
						error: {
							code: "usage_limit_reached",
							message: "RAW-UPSTREAM-MARKER usage limit reached",
							plan_type: "Pro",
							resets_at: resetsAt,
						},
					}),
					{ status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json" } },
				),
		);

		expect(message.stopReason).toBe("error");
		// The friendly message names the plan and the reset wait; the raw upstream
		// message must not replace it as the classified detail.
		expect(message.errorMessage).toContain("usage limit");
		expect(message.errorMessage).toContain("(pro plan)");
		expect(message.errorMessage).toContain("Try again in");
		expect(message.errorMessage).not.toContain("RAW-UPSTREAM-MARKER");

		const details = failureDetails(message);
		expect(details?.kind).toBe("rate_limit");
		expect(details?.status).toBe(429);
		// resets_at (~30 min out) must reach the retry ladder as retryAfterMs.
		expect(typeof details?.retryAfterMs).toBe("number");
		expect(details?.retryAfterMs as number).toBeGreaterThan(0);
		expect(details?.retryAfterMs as number).toBeLessThanOrEqual(1800 * 1000);
	});

	it("omits retryAfterMs when the body carries no resets_at", async () => {
		const message = await runCodexResponse(
			() =>
				new Response(
					JSON.stringify({
						error: { code: "usage_limit_reached", message: "usage limit reached", plan_type: "free" },
					}),
					{ status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json" } },
				),
		);

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("(free plan)");
		const details = failureDetails(message);
		expect(details?.kind).toBe("rate_limit");
		expect(details?.retryAfterMs).toBeUndefined();
	});
});
