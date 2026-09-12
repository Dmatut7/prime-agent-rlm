/**
 * Pins the impersonated Claude Code client version on Anthropic's OAuth path.
 *
 * Anthropic rejects OAuth traffic from client builds that fall too far behind,
 * and the version lives only as a literal in providers/anthropic.ts - there is
 * no runtime oracle for "current". Upstream 2.1.257 was stale here while
 * upstream moved to 2.1.261 (a062ed221 / #2069).
 */
import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import type { Context } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	constructorOpts: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
		].join("\n");
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		constructor(opts: Record<string, unknown>) {
			mockState.constructorOpts = opts;
		}
		messages = {
			create: () => ({ asResponse: async () => createSseResponse() }),
		};
	}

	return { default: FakeAnthropic };
});

/** Floor from upstream a062ed221; anything older is a regression, not a choice. */
const MINIMUM_CLAUDE_CODE_VERSION = "2.1.261";

function compareDottedVersions(left: string, right: string): number {
	const a = left.split(".").map((part) => Number.parseInt(part, 10));
	const b = right.split(".").map((part) => Number.parseInt(part, 10));
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

// Read through a function so the reset assignment below cannot narrow the
// captured options to `undefined` (and then to `never`) at the use site.
function capturedClientOptions(): Record<string, unknown> | undefined {
	return mockState.constructorOpts;
}

async function captureHeaders(apiKey: string): Promise<Record<string, string>> {
	mockState.constructorOpts = undefined;
	const model = getModel("anthropic", "claude-sonnet-4-5");
	const { streamAnthropic } = await import("../src/providers/anthropic.js");
	const stream = streamAnthropic(model, context, { apiKey });
	for await (const event of stream) {
		if (event.type === "error") break;
	}
	const opts = capturedClientOptions();
	expect(opts, "anthropic client was constructed").toBeTruthy();
	return (opts?.defaultHeaders ?? {}) as Record<string, string>;
}

describe("impersonated Claude Code client version", () => {
	it("identifies as a current Claude Code build on the OAuth path", async () => {
		const headers = await captureHeaders("sk-ant-oat01-fork-test-token");
		const userAgent = headers["user-agent"] ?? "";
		const match = /^claude-cli\/(\d+\.\d+\.\d+)$/.exec(userAgent);

		expect(match, `user-agent ${JSON.stringify(userAgent)}`).toBeTruthy();
		expect(compareDottedVersions(match![1], MINIMUM_CLAUDE_CODE_VERSION)).toBeGreaterThanOrEqual(0);
		expect(headers["x-app"]).toBe("cli");
		expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
	});

	it("does not claim the Claude Code identity on the plain API-key path", async () => {
		const headers = await captureHeaders("sk-ant-api03-fork-test-key");

		expect(headers["user-agent"] ?? "").not.toContain("claude-cli/");
		expect(headers["anthropic-beta"] ?? "").not.toContain("oauth-2025-04-20");
	});
});
