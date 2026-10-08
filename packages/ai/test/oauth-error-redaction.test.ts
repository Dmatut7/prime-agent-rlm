import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshAnthropicToken } from "../src/utils/oauth/anthropic.js";
import { refreshGitHubCopilotToken } from "../src/utils/oauth/github-copilot.js";
import { refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.js";

/**
 * R3-M27: OAuth error paths pasted the full stack trace and the unbounded,
 * unredacted response body onto the login overlay's error line - and token
 * endpoints can echo the authorization code / verifier / tokens back in the
 * body. Errors now drop the stack and carry a redacted, capped body excerpt.
 */

function textResponse(body: string, status: number): Response {
	return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

const SECRET = "sk-ant-oat01-SUPERSECRETTOKEN123456"; // secret-scan: allow (obvious fake, asserts redaction)
const HUGE_PADDING = "p".repeat(10_000);
const TAILMARKER = "TAILMARKER-NEVER-DISPLAYED";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("OAuth error redaction and bounding", () => {
	it("anthropic refresh failure redacts and truncates the response body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				textResponse(
					JSON.stringify({ error: "invalid_grant", access_token: SECRET }) + HUGE_PADDING + TAILMARKER,
					500,
				),
			),
		);

		const error = await refreshAnthropicToken("refresh-token").then(
			() => {
				throw new Error("expected refreshAnthropicToken to throw");
			},
			(e: unknown) => e as Error,
		);

		expect(error.message).toContain("status=500");
		expect(error.message).not.toContain("SUPERSECRETTOKEN");
		expect(error.message).not.toContain(SECRET);
		expect(error.message).not.toContain(TAILMARKER);
		expect(error.message.length).toBeLessThan(3_000);
		expect(error.message).not.toContain("stack=");
	});

	it("anthropic transport failure drops the stack trace but keeps the cause", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("socket hangup", {
					cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
				});
			}),
		);

		const error = await refreshAnthropicToken("refresh-token").then(
			() => {
				throw new Error("expected refreshAnthropicToken to throw");
			},
			(e: unknown) => e as Error,
		);

		expect(error.message).toContain("socket hangup");
		expect(error.message).toContain("ECONNRESET");
		expect(error.message).not.toContain("stack=");
		// Stack frame lines would mean the trace still leaks into the overlay.
		expect(error.message).not.toMatch(/\n\s+at\s/);
	});

	it("anthropic invalid-JSON failure redacts and truncates the body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => textResponse(`not-json token=${SECRET} ${HUGE_PADDING}${TAILMARKER}`, 200)),
		);

		const error = await refreshAnthropicToken("refresh-token").then(
			() => {
				throw new Error("expected refreshAnthropicToken to throw");
			},
			(e: unknown) => e as Error,
		);

		expect(error.message).toContain("invalid JSON");
		expect(error.message).not.toContain("SUPERSECRETTOKEN");
		expect(error.message).not.toContain(TAILMARKER);
		expect(error.message.length).toBeLessThan(3_000);
	});

	it("github-copilot refresh failure redacts and truncates the response body", async () => {
		const githubSecret = "ghp_" + "ABCDEFGH12345678".repeat(3);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => textResponse(`bad credentials ${githubSecret} ${HUGE_PADDING}${TAILMARKER}`, 401)),
		);

		const error = await refreshGitHubCopilotToken("refresh-token").then(
			() => {
				throw new Error("expected refreshGitHubCopilotToken to throw");
			},
			(e: unknown) => e as Error,
		);

		expect(error.message).toContain("401");
		expect(error.message).not.toContain(githubSecret);
		expect(error.message).not.toContain("ghp_");
		expect(error.message).not.toContain(TAILMARKER);
		expect(error.message.length).toBeLessThan(3_000);
	});

	it("openai-codex refresh failure redacts and truncates the response body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				textResponse(JSON.stringify({ error_description: `code=${SECRET}` }) + HUGE_PADDING + TAILMARKER, 400),
			),
		);

		const error = await refreshOpenAICodexToken("refresh-token").then(
			() => {
				throw new Error("expected refreshOpenAICodexToken to throw");
			},
			(e: unknown) => e as Error,
		);

		expect(error.message).toContain("400");
		expect(error.message).not.toContain("SUPERSECRETTOKEN");
		expect(error.message).not.toContain(TAILMARKER);
		expect(error.message.length).toBeLessThan(3_000);
	});
});
