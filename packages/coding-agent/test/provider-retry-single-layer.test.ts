import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type ProviderRetryNotice,
	registerApiProvider,
	type SimpleStreamOptions,
	type StreamFunction,
	type StreamOptions,
	streamOpenAICodexResponses,
	streamOpenAICompletions,
	unregisterApiProviders,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	directProviderRetryStreamOptions,
	type ProviderRetryPolicy,
	providerRetryStreamOptions,
} from "../src/core/provider-retry.js";
import { planRefinement } from "../src/core/refinement/index.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { type SideQuestionEvent, startSideQuestion } from "../src/core/side-question.js";
import { createHarness } from "./suite/harness.js";

/**
 * One retry per path, at that path's outermost layer.
 *
 * `sdk.ts` used to hand the configured retry count to the provider client while the session
 * retry loop applied `retry.maxRetries` on top, and the provider clients retry by
 * themselves (the OpenAI/Anthropic SDKs default to 2, the fork's Codex SSE loop to 3), so
 * one failed turn spent (1 + client retries) requests per retry the session counted. The
 * split that replaced it:
 *
 *  - module-wrapped paths (the session's own turns, compaction) ask the provider client for
 *    a single attempt (`providerRetryStreamOptions`) and the module retries;
 *  - paths with no module layer (a `/refine` request, a `/btw` side question) ask the client
 *    for the policy's count (`directProviderRetryStreamOptions`), because the client's own
 *    loop is their outermost layer.
 *
 * Cases: the session path's count, the wiring the provider layer actually receives, the
 * count/parameters per path shape, and the cap - which stays where it can be enforced.
 */

const API = "retry-layer-api";
const PROVIDER = "retry-layer-provider";
const MODEL_ID = "retry-layer-model";
const SOURCE_ID = "retry-layer-provider-test";

const POLICY: ProviderRetryPolicy = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxRetryDelayMs: 1234 };

const model: Model<string> = {
	id: MODEL_ID,
	name: MODEL_ID,
	api: API,
	provider: PROVIDER,
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

function completionsModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "retry-layer-model",
		name: "retry-layer-model",
		api: "openai-completions",
		provider: PROVIDER,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};
}

function createContext(): Context {
	return { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
}

async function terminalEvent(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent | undefined> {
	let last: AssistantMessageEvent | undefined;
	for await (const event of stream) {
		last = event;
		if (event.type === "done" || event.type === "error") break;
	}
	return last;
}

interface LocalServer {
	url: string;
	requests(): number;
	close(): Promise<void>;
}

/** Every request answers `status`, optionally asking for a retry wait first. */
async function startProviderServer(
	status: number,
	retryAfterSeconds?: number,
	extraHeaders: Record<string, string> = {},
): Promise<LocalServer> {
	let count = 0;
	const server = http.createServer((_request, response) => {
		count++;
		response.writeHead(status, {
			"content-type": "application/json",
			...(retryAfterSeconds === undefined ? {} : { "retry-after": String(retryAfterSeconds) }),
			...extraHeaders,
		});
		response.end(JSON.stringify({ error: { type: "server_error", message: "upstream boom" }, type: "error" }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		requests: () => count,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

function providerFailure(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: API,
		provider: PROVIDER,
		model: MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "upstream boom",
		timestamp: Date.now(),
		diagnostics: [
			{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind: "server_error", status: 500 } },
		],
	};
}

/** Records the options the production streamFn hands to the provider layer. */
function installStubProvider(seen: StreamOptions[]): void {
	const stream: StreamFunction<string, StreamOptions> = (_requestModel, _context, options) => {
		if (options) {
			seen.push(options);
		}
		const events = createAssistantMessageEventStream();
		const message = providerFailure();
		events.push({ type: "error", reason: "error", error: message });
		events.end(message);
		return events;
	};
	const streamSimple: StreamFunction<string, SimpleStreamOptions> = (requestModel, context, options) =>
		stream(requestModel, context, options);
	registerApiProvider({ api: API, stream, streamSimple }, SOURCE_ID);
}

const cleanups: Array<() => Promise<void> | void> = [];

async function createSession(options: {
	model: Model<any>;
	settings: Record<string, unknown>;
}): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; events: AgentSessionEvent[] }> {
	const tempDir = join(tmpdir(), `pi-retry-layer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(PROVIDER, "test-key");
	const settingsManager = SettingsManager.create(tempDir, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir,
		model: options.model,
		authStorage,
		settingsManager,
		sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		resourceLoader,
		noTools: "all",
	});
	await session.bindExtensions({});
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	cleanups.push(async () => {
		await session.dispose();
		rmSync(tempDir, { recursive: true, force: true });
	});
	return { session, events };
}

function autoRetryStarts(events: AgentSessionEvent[]): Array<Extract<AgentSessionEvent, { type: "auto_retry_start" }>> {
	return events.filter(
		(event): event is Extract<AgentSessionEvent, { type: "auto_retry_start" }> => event.type === "auto_retry_start",
	);
}

/** The wait-for-usage ping loop is a separate mechanism; these cases drive the quick retry path. */
function retrySettings(provider: Record<string, unknown>): Record<string, unknown> {
	return {
		retry: {
			enabled: true,
			maxRetries: 2,
			baseDelayMs: 1,
			provider: { waitForUsage: { enabled: false }, ...provider },
		},
	};
}

function codexModel(): Model<"openai-codex-responses"> {
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

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

describe("one retry per path, at the outermost layer", () => {
	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		unregisterApiProviders(SOURCE_ID);
	});

	it("puts the retry count on whichever layer is outermost for the path", () => {
		expect(providerRetryStreamOptions(POLICY)).toEqual({ maxRetries: 0, maxRetryDelayMs: 1234 });
		expect(directProviderRetryStreamOptions(POLICY)).toEqual({ maxRetries: 2, maxRetryDelayMs: 1234 });
		// `retry.enabled: false` still means a single attempt on a module-free path.
		expect(directProviderRetryStreamOptions({ ...POLICY, enabled: false }).maxRetries).toBe(0);
	});

	it("spends one provider request per module retry on the session path", async () => {
		const server = await startProviderServer(500);
		try {
			const { session, events } = await createSession({
				model: completionsModel(server.url),
				settings: retrySettings({}),
			});

			await session.prompt("hello");

			// One attempt + two module retries. While the provider client also retried, the
			// same settings spent (1 + client retries) requests per attempt - the SDKs default
			// to 2, so nine requests for this one turn, counted as two retries.
			expect(server.requests()).toBe(3);
			expect(autoRetryStarts(events).map((event) => event.attempt)).toEqual([1, 2]);
			expect(autoRetryStarts(events).every((event) => event.maxAttempts === 2)).toBe(true);
		} finally {
			await server.close();
		}
	}, 30000);

	it("asks the module-wrapped provider layer for a single attempt and keeps the cap", async () => {
		const seen: StreamOptions[] = [];
		installStubProvider(seen);
		const { session } = await createSession({
			model,
			settings: retrySettings({ maxRetryDelayMs: 1234 }),
		});

		await session.prompt("hello");

		const options = seen.at(-1);
		// The retry count is a parameter of the module, not of the client: a client that also
		// retried would spend requests the module never counts.
		expect(options?.maxRetries).toBe(0);
		// The cap still travels, because the provider fetch wrapper is the only place a
		// server-requested wait can be refused before the SDK sleeps through it.
		expect(options?.maxRetryDelayMs).toBe(1234);
	}, 30000);

	it("lets retry.provider.maxRetries drive the module's retry count", async () => {
		const server = await startProviderServer(500);
		try {
			const { session, events } = await createSession({
				// retry.maxRetries stays 2; the provider-scoped count is the one that runs.
				settings: retrySettings({ maxRetries: 1 }),
				model: completionsModel(server.url),
			});

			await session.prompt("hello");

			expect(autoRetryStarts(events).map((event) => event.attempt)).toEqual([1]);
			expect(autoRetryStarts(events)[0]?.maxAttempts).toBe(1);
			expect(server.requests()).toBe(2);
		} finally {
			await server.close();
		}
	}, 30000);

	it("lets a module-free path retry with the policy's count instead", async () => {
		// `retry-after-ms: 1` keeps the client's own backoff out of the measurement.
		const server = await startProviderServer(500, undefined, { "retry-after-ms": "1" });
		try {
			const event = await terminalEvent(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					...directProviderRetryStreamOptions(POLICY),
				}),
			);

			expect(event?.type).toBe("error");
			// No module layer above this call, so the client's loop is the outermost one and
			// spends the policy's 2 retries: 3 requests.
			expect(server.requests()).toBe(3);
		} finally {
			await server.close();
		}
	}, 30000);

	it("gives a side question (no module layer) the policy's retry count", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		try {
			let observed: StreamOptions | undefined;
			harness.setResponses([
				(_context, options) => {
					observed = options;
					return fauxAssistantMessage("answered");
				},
			]);

			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(
				harness.session.agent,
				"question-1",
				"Why?",
				(event) => {
					events.push(event);
				},
				[],
				POLICY,
			);
			await run.done;

			expect(events.at(-1)?.status).toBe("complete");
			// The side agent runs its own loop and nothing wraps it: the provider client gets
			// the policy's count, not the session's single attempt.
			expect(observed?.maxRetries).toBe(2);
			expect(observed?.maxRetryDelayMs).toBe(1234);
		} finally {
			harness.cleanup();
		}
	}, 30000);

	it("gives a /refine request (no module layer) the policy's retry count", async () => {
		const seen: StreamOptions[] = [];
		installStubProvider(seen);

		await expect(
			planRefinement(
				[],
				{ schema: 1, entries: { prompt: {}, memory: {}, skill: {}, subagent: {} }, refinements: [] },
				[],
				model,
				"test-key",
				{ retry: POLICY },
			),
		).rejects.toThrow(/upstream boom/);

		// The refinement request has no module layer above it: the provider client retries it
		// with the caller's policy.
		const options = seen.at(-1);
		expect(options?.maxRetries).toBe(2);
		expect(options?.maxRetryDelayMs).toBe(1234);
	}, 30000);

	it("reads the cap from settings and refuses a Retry-After above it instead of sleeping", async () => {
		const server = await startProviderServer(429, 5);
		try {
			const { session, events } = await createSession({
				model: completionsModel(server.url),
				settings: retrySettings({ maxRetryDelayMs: 100 }),
			});

			const startedAt = Date.now();
			await session.prompt("hello");
			const elapsedMs = Date.now() - startedAt;

			// The provider answered 429 asking for 5s, the cap is 100ms: the wait must not
			// happen, and this module must not retry into it either.
			expect(server.requests()).toBe(1);
			expect(elapsedMs).toBeLessThan(2000);
			expect(autoRetryStarts(events)).toEqual([]);
			const end = events.find((event) => event.type === "auto_retry_end");
			expect(end?.type === "auto_retry_end" ? end.finalError : "").toContain("retry.provider.maxRetryDelayMs=100ms");
		} finally {
			await server.close();
		}
	}, 30000);

	it("keeps the cap effective on a direct provider call the module never wraps", async () => {
		const server = await startProviderServer(429, 5);
		try {
			const notices: ProviderRetryNotice[] = [];
			const startedAt = Date.now();
			const event = await terminalEvent(
				streamOpenAICompletions(completionsModel(server.url), createContext(), {
					apiKey: "test-key",
					...directProviderRetryStreamOptions({ ...POLICY, maxRetryDelayMs: 100 }),
					onProviderRetry: (notice) => notices.push(notice),
				}),
			);

			expect(event?.type).toBe("error");
			expect(Date.now() - startedAt).toBeLessThan(2000);
			expect(server.requests()).toBe(1);
			expect(notices[0]).toMatchObject({ status: 429, delayMs: 5000, capped: true });
		} finally {
			await server.close();
		}
	}, 30000);

	it("fails a Codex Retry-After above the cap instead of sleeping it", async () => {
		const originalFetch = global.fetch;
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (!url.includes("/codex/responses")) {
				return new Response("not found", { status: 404 });
			}
			return new Response("rate limited", {
				status: 429,
				statusText: "Too Many Requests",
				headers: { "Retry-After": "10" },
			});
		});
		global.fetch = fetchMock as typeof fetch;
		try {
			const startedAt = Date.now();
			const event = await terminalEvent(
				streamOpenAICodexResponses(codexModel(), createContext(), {
					apiKey: codexToken(),
					transport: "sse",
					maxRetries: 3,
					maxRetryDelayMs: 50,
				}) as AsyncIterable<AssistantMessageEvent>,
			);
			const elapsedMs = Date.now() - startedAt;

			expect(event?.type).toBe("error");
			expect(elapsedMs).toBeLessThan(2000);
			// Codex reads Retry-After natively and throws its cap error rather than sleeping
			// the 10s the provider asked for.
			const message = event?.type === "error" ? event.error : undefined;
			expect(message?.errorMessage ?? "").toMatch(/10000ms exceeds maxRetryDelayMs 50ms/);
		} finally {
			global.fetch = originalFetch;
		}
	}, 30000);

	it("exposes retry.provider.maxRetries through the settings getter the module reads", async () => {
		const tempDir = join(tmpdir(), `pi-retry-layer-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { provider: { maxRetries: 5 } } }));
		try {
			expect(SettingsManager.create(tempDir, agentDir).getProviderRetrySettings().maxRetries).toBe(5);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
