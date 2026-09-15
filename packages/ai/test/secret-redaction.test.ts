import { afterEach, describe, expect, test } from "vitest";
import { getLogger, setLogSink } from "../src/log.js";
import type { AssistantMessage } from "../src/types.js";
import { REDACTED, redactSecrets } from "../src/utils/redact.js";
import { recordStreamFailure, StreamFailureError } from "../src/utils/stream-failure.js";

afterEach(() => setLogSink(undefined));

const API_KEY = "sk-ant-api03-AbCdEf1234567890ZzQw";
const OAUTH_TOKEN =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

function makeOutput(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: 0,
		...overrides,
	};
}

describe("redactSecrets", () => {
	test("removes header values, bare key shapes, userinfo and JWTs", () => {
		const text = [
			"401 Unauthorized",
			`Authorization: Bearer ${API_KEY}`,
			`x-api-key: ${API_KEY}`,
			`url=https://user:hunter2@api.example.com/v1/models?api_key=${API_KEY}`,
			`token ${OAUTH_TOKEN}`,
			"status: authentication_error request_id: req_1",
		].join("\n");

		const redacted = redactSecrets(text);

		expect(redacted).not.toContain(API_KEY);
		expect(redacted).not.toContain("hunter2");
		expect(redacted).not.toContain(OAUTH_TOKEN);
		// The failure stays actionable: status, provider code and the host survive.
		expect(redacted).toContain("401 Unauthorized");
		expect(redacted).toContain("authentication_error");
		expect(redacted).toContain("req_1");
		expect(redacted).toContain("api.example.com");
		expect(redacted).toContain(REDACTED);
	});

	test("removes an exact secret the caller knows about", () => {
		const redacted = redactSecrets(`provider said: nope (${OAUTH_TOKEN})`, [OAUTH_TOKEN]);
		expect(redacted).not.toContain(OAUTH_TOKEN);
		expect(redacted).toContain("provider said: nope");
	});

	test("leaves text without credential material alone", () => {
		expect(redactSecrets("Provider overloaded (overloaded_error, 529)")).toBe(
			"Provider overloaded (overloaded_error, 529)",
		);
		expect(redactSecrets("invalid x-api-key")).toBe("invalid x-api-key");
	});

	// --- GL-4: shapes that used to reach the log untouched, plus the userinfo fallback.

	const BARE_SESSION = "abc123def456ghi789jkl";
	const COOKIE_TOKEN = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4";
	const CUSTOM_AUTH_VALUE = "40b7f8e2c1d9a6b3e5f7081923abcd";

	test("redacts a bare `session=<opaque>` assignment", () => {
		expect(redactSecrets(`Cookie: session=${BARE_SESSION}`)).toBe(`Cookie: session=${REDACTED}`);
		// A short session value still goes when it sits in a cookie.
		expect(redactSecrets("Set-Cookie: session=AbC9xYz; Path=/; HttpOnly")).toBe(
			`Set-Cookie: session=${REDACTED}; Path=/; HttpOnly`,
		);
		// Compound session names reach the same fallback.
		expect(redactSecrets(`proxy_session_id=${BARE_SESSION}`)).toBe(`proxy_session_id=${REDACTED}`);
	});

	test("redacts credential cookies but keeps names, attributes and harmless cookies", () => {
		const header = `{"cookie":"theme=dark; lang=en-US; __Secure-session=${COOKIE_TOKEN}; _ga=GA1.1.1234567890.1699999999"}`;
		const redacted = redactSecrets(header);

		expect(redacted).not.toContain(COOKIE_TOKEN);
		expect(redacted).toContain(`__Secure-session=${REDACTED}`);
		// The actionable part of a cookie header is which cookies were sent, so the
		// harmless ones and every name survive verbatim.
		expect(redacted).toContain("theme=dark");
		expect(redacted).toContain("lang=en-US");
		// `_ga` carries a 20-char opaque value but is not a credential name; it is
		// washed by the opaque rule and keeps its name.
		expect(redacted).toContain(`_ga=${REDACTED}`);

		// Set-Cookie attributes stay readable, including the long ones.
		expect(
			redactSecrets(
				`Set-Cookie: sid=zz4qk9x7t2p1m0abc; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Domain=.analytics.shopify-suite.com; Path=/; HttpOnly`,
			),
		).toBe(
			`Set-Cookie: sid=${REDACTED}; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Domain=.analytics.shopify-suite.com; Path=/; HttpOnly`,
		);
	});

	test("redacts auth schemes other than bearer in custom headers", () => {
		const line = `sending "X-Custom-Auth": "Token ${CUSTOM_AUTH_VALUE}" to upstream`;
		const redacted = redactSecrets(line);

		expect(redacted).not.toContain(CUSTOM_AUTH_VALUE);
		expect(redacted).toContain(`Token ${REDACTED}`);
		expect(redacted).toContain("X-Custom-Auth");
		expect(redacted).toContain("to upstream");

		// A pure-alphabetic value of credential length is still a credential.
		expect(redactSecrets("Token abcdefghijklmnopqrstuvwxyz")).toBe(`Token ${REDACTED}`);
		// Basic survives as a scheme; the base64 user:pass pair does not.
		expect(redactSecrets("Proxy-Auth: Basic dXNlcjpwYXNzd29yZA==")).toBe(`Proxy-Auth: Basic ${REDACTED}`);
	});

	test("keeps diagnostic prose that only looks like an auth scheme", () => {
		expect(redactSecrets("The token expires in 3600 seconds")).toBe("The token expires in 3600 seconds");
		expect(redactSecrets("basic information about the overload (529)")).toBe(
			"basic information about the overload (529)",
		);
		expect(redactSecrets("Cookie: theme=dark; lang=en-US")).toBe("Cookie: theme=dark; lang=en-US");
	});

	test("URL userinfo washes only the password and keeps the username", () => {
		expect(redactSecrets("retrying https://alice:hunter2@proxy.corp.example:8080/v1/models")).toBe(
			`retrying https://alice:${REDACTED}@proxy.corp.example:8080/v1/models`,
		);
		// A colon inside the password must not end the redaction early.
		expect(redactSecrets("retrying https://alice:pa:ssword@host/v1")).toBe(
			`retrying https://alice:${REDACTED}@host/v1`,
		);
		// No password at all: nothing to wash, so the userinfo stays as it is.
		expect(redactSecrets("retrying https://alice@proxy.corp.example:8080/v1/models")).toBe(
			"retrying https://alice@proxy.corp.example:8080/v1/models",
		);
		expect(redactSecrets("https://alice:@host")).toBe("https://alice:@host");
		// A password with no username is still a password.
		expect(redactSecrets("https://:hunter2@host/v1")).toBe(`https://:${REDACTED}@host/v1`);
	});

	test("redaction is stable when applied twice", () => {
		for (const text of [
			`Authorization: Bearer ${API_KEY}`,
			`Cookie: session=${BARE_SESSION}; theme=dark`,
			`"X-Custom-Auth": "Token ${CUSTOM_AUTH_VALUE}"`,
			"https://alice:hunter2@proxy.corp.example:8080/v1/models",
			`url=https://user:hunter2@api.example.com/v1/models?api_key=${API_KEY}`,
		]) {
			const once = redactSecrets(text);
			expect(once).toBe(redactSecrets(once));
		}
	});

	test("pathological credential-shaped input stays linear", () => {
		const cookie = `Cookie: ${Array.from({ length: 500 }, (_, i) => `sid${i}=aaaaaaaaaaaaaaaaaaaaaaaa`).join("; ")}`;
		const tokenish = `Token ${"A".repeat(100)}!`.repeat(500);
		const started = performance.now();
		const redacted = redactSecrets(`${cookie}
${tokenish}
https://u:${"p".repeat(200)}@host/`);
		const elapsedMs = performance.now() - started;

		expect(elapsedMs).toBeLessThan(2000);
		expect(redacted).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaa");
		expect(redacted).not.toContain("A".repeat(100));
	});
});

describe("provider stream failure diagnostics", () => {
	const model = { provider: "openai", id: "gpt-faux", api: "openai-completions" };

	test("a 401 whose body echoes the request credential persists no credential", () => {
		const logged: Record<string, unknown>[] = [];
		setLogSink((entry) => logged.push(entry));

		const bodyMessage = `Incorrect API key provided: ${API_KEY}. Send the header Authorization: Bearer ${API_KEY}`;
		const error = Object.assign(new Error(`401 {"error":{"message":"${bodyMessage}"}}`), {
			status: 401,
			error: { type: "error", error: { type: "authentication_error", message: bodyMessage } },
			requestID: "req_sec",
		});
		// openai-completions persists the raw thrown message as the user-facing text.
		const output = makeOutput({ provider: "openai", api: "openai-completions", errorMessage: error.message });

		recordStreamFailure(model, output, error);

		const diagnostic = output.diagnostics?.[0];
		expect(diagnostic).toBeDefined();
		expect(JSON.stringify(diagnostic)).not.toContain(API_KEY);
		expect(JSON.stringify(output)).not.toContain(API_KEY);
		expect(JSON.stringify(logged)).not.toContain(API_KEY);
		// Still actionable: the failure, the provider's own message and ids survive.
		expect(diagnostic?.details).toMatchObject({ kind: "auth", status: 401, requestId: "req_sec" });
		expect(diagnostic?.error?.message).toContain("Incorrect API key provided");
		expect(logged[0]).toMatchObject({ level: "error", kind: "auth", status: 401, requestId: "req_sec" });
	});

	test("a provider-supplied raw payload is redacted before it is persisted", () => {
		const logged: Record<string, unknown>[] = [];
		setLogSink((entry) => logged.push(entry));
		const output = makeOutput({ errorMessage: "Provider authentication failed" });
		recordStreamFailure(
			model,
			output,
			new StreamFailureError("Provider authentication failed (authentication_error, 401)", {
				kind: "auth",
				status: 401,
				raw: `{"error":"bad key","key":"${API_KEY}"}`,
			}),
		);

		const diagnostic = output.diagnostics?.[0];
		expect(JSON.stringify(diagnostic?.details)).not.toContain(API_KEY);
		expect(JSON.stringify(logged)).not.toContain(API_KEY);
	});
});

describe("structured log entries", () => {
	test("never carry credential material from any field", () => {
		const entries: Record<string, unknown>[] = [];
		setLogSink((entry) => entries.push(entry));

		getLogger("test.component").error(`refresh failed for ${API_KEY}`, {
			detail: `Authorization: Bearer ${API_KEY}`,
			url: `https://user:hunter2@api.example.com/v1/token`,
			nested: { headers: { "x-api-key": API_KEY } },
			list: [`${API_KEY}`],
		});

		expect(entries).toHaveLength(1);
		const serialized = JSON.stringify(entries[0]);
		expect(serialized).not.toContain(API_KEY);
		expect(serialized).not.toContain("hunter2");
		expect(entries[0]?.url).toContain("api.example.com");
		expect(entries[0]?.msg).toContain("refresh failed");
		expect(entries[0]?.component).toBe("test.component");
	});

	test("carries the new credential shapes out of the log sink but keeps the username", () => {
		const entries: Record<string, unknown>[] = [];
		setLogSink((entry) => entries.push(entry));

		getLogger("test.proxy").error("upstream rejected", {
			headers: {
				cookie: "theme=dark; __Secure-session=a1b2c3d4e5f6g7h8i9j0k1l2m3n4",
				"x-custom-auth": "Token 40b7f8e2c1d9a6b3e5f7081923abcd",
			},
			baseUrl: "https://proxy-account:hunter2@upstream.example/v1",
		});

		const serialized = JSON.stringify(entries[0]);
		expect(serialized).not.toContain("a1b2c3d4e5f6g7h8i9j0k1l2m3n4");
		expect(serialized).not.toContain("40b7f8e2c1d9a6b3e5f7081923abcd");
		expect(serialized).not.toContain("hunter2");
		// What the reader needs to act on: which cookie, which header, which account.
		expect(serialized).toContain("theme=dark");
		expect(serialized).toContain("__Secure-session=[REDACTED]");
		expect(serialized).toContain("Token [REDACTED]");
		expect(serialized).toContain("https://proxy-account:[REDACTED]@upstream.example");
	});
});
