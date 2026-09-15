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
});
