import { afterEach, describe, expect, it, vi } from "vitest";
import { loginOpenAICodex, refreshOpenAICodexToken } from "../src/utils/oauth/openai-codex.js";

/**
 * The token response is the credential itself, so an error about a malformed one
 * may name fields and types but must never carry values. This is the detector the
 * assertions below use; `detectorFlagsEchoedSecret` is its positive control.
 */
function detectorFlagsEchoedSecret(message: string, secret: string): boolean {
	return message.includes(secret);
}

function stubJsonResponse(body: unknown): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async (): Promise<Response> =>
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		),
	);
}

describe("OpenAI Codex OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("does not write token refresh failures to stderr", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (): Promise<Response> => {
				return new Response(
					JSON.stringify({
						error: {
							message: "Could not validate your token. Please try signing in again.",
							type: "invalid_request_error",
						},
					}),
					{ status: 401, statusText: "Unauthorized", headers: { "Content-Type": "application/json" } },
				);
			}),
		);

		await expect(refreshOpenAICodexToken("invalid-refresh-token")).rejects.toThrow(
			/OpenAI Codex token refresh failed \(401\).*Could not validate your token/,
		);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("positive control: the detector flags a message that echoes a token", () => {
		const echoed = `OpenAI Codex token refresh response missing fields: {"access_token":"ACCESS-TOKEN-SECRET-abc123"}`;

		expect(detectorFlagsEchoedSecret(echoed, "ACCESS-TOKEN-SECRET-abc123")).toBe(true);
	});

	it("describes malformed refresh responses without echoing the tokens that arrived with them", async () => {
		const accessToken = "ACCESS-TOKEN-SECRET-abc123def456";
		stubJsonResponse({ access_token: accessToken, expires_in: 3600, token_type: "Bearer" });

		const error = await refreshOpenAICodexToken("REFRESH-TOKEN-SECRET-xyz789uvw012").catch(
			(thrown: unknown) => thrown,
		);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toMatch(/missing fields/);
		// The field-level diagnosis is what makes the error actionable.
		expect(message).toContain("access_token");
		expect(message).toContain("refresh_token");
		expect(message).toContain("expires_in");
		expect(detectorFlagsEchoedSecret(message, accessToken)).toBe(false);
	});

	it("describes malformed token exchange responses without echoing the tokens", async () => {
		const accessToken = "EXCHANGE-ACCESS-SECRET-abc123def456";
		const refreshToken = "EXCHANGE-REFRESH-SECRET-xyz789uvw012";
		stubJsonResponse({ access_token: accessToken, refresh_token: refreshToken, expires_in: "3600" });

		const error = await loginOpenAICodex({
			onAuth: () => {},
			onPrompt: async () => "",
			onManualCodeInput: async () => "auth-code",
		}).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toMatch(/missing fields/);
		expect(detectorFlagsEchoedSecret(message, accessToken)).toBe(false);
		expect(detectorFlagsEchoedSecret(message, refreshToken)).toBe(false);
	});

	it("arms the refresh request with an abort timeout signal", async () => {
		// A refresh that never times out holds the auth.json lock for as long as
		// the token endpoint cares to stay silent (the anthropic provider already
		// sends signal: AbortSignal.timeout(30_000); codex must match).
		const inits: (RequestInit | undefined)[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				inits.push(init);
				return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}),
		);

		// The account-id parse of this stub token fails; the proposition under test
		// is the request wiring, not the response.
		await refreshOpenAICodexToken("REFRESH-TOKEN-SECRET-xyz789").catch(() => {});

		expect(inits.length).toBe(1);
		expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("aborts a hung token endpoint instead of waiting forever", async () => {
		// Shrink AbortSignal.timeout so the hang is observable inside the test timeout.
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(15));
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: unknown, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("token endpoint hung")));
					}),
			),
		);

		await expect(refreshOpenAICodexToken("REFRESH-TOKEN-SECRET-xyz789")).rejects.toThrow(/token endpoint hung/);
	});
});
