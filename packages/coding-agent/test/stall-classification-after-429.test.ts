import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_DIRECTED_RETRY_STALL_STOP_REASON_RAW } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	registerApiProvider,
	type SimpleStreamOptions,
	type StreamFunction,
	type StreamOptions,
	unregisterApiProviders,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * Round-15 K5: a stall that happens after the attempt already streamed output must not
 * inherit the "provider is throttling" classification from an earlier 429 in the same
 * attempt. These cases drive the production path (settings -> createAgentSession ->
 * agent loop -> session auto-retry) through a provider stub, so the assertion is about
 * the observable outcome: whether the whole context is resent.
 */

const API = "r15-stall-api";
const PROVIDER = "r15-stall-provider";
const MODEL_ID = "r15-stall-model";
const SOURCE_ID = "r15-stall-classification-test";

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

function createUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: API,
		provider: PROVIDER,
		model: MODEL_ID,
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Events arrive, then the connection dies: nothing is ever pushed again. */
function streamThatDiesAfterOutput(): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: createMessage("") });
	stream.push({
		type: "text_delta",
		contentIndex: 0,
		delta: "half an answer",
		partial: createMessage("half an answer"),
	});
	return stream;
}

/** The provider answered, asked for a wait, and the client is still in it. */
function streamThatStaysSilent(): AssistantMessageEventStream {
	return createAssistantMessageEventStream();
}

function streamThatCompletes(text: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: createMessage("") });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: createMessage(text) });
	stream.push({ type: "done", reason: "stop", message: createMessage(text) });
	return stream;
}

let providerCalls = 0;

type FirstAttempt = "partial-output-then-stall" | "stay-in-the-retry-wait";

function installProvider(firstAttempt: FirstAttempt): void {
	providerCalls = 0;
	const stream: StreamFunction<string, StreamOptions> = (_model, _context, streamOptions) => {
		providerCalls += 1;
		if (providerCalls > 1) {
			return streamThatCompletes("recovered");
		}
		// The provider answered 429 and asked to wait, earlier in this same attempt.
		streamOptions?.onProviderRetry?.({ status: 429, delayMs: 5000, retryAfter: "5", capped: false });
		return firstAttempt === "partial-output-then-stall" ? streamThatDiesAfterOutput() : streamThatStaysSilent();
	};
	const streamSimple: StreamFunction<string, SimpleStreamOptions> = (requestModel, context, options) =>
		stream(requestModel, context, options);
	registerApiProvider({ api: API, stream, streamSimple }, SOURCE_ID);
}

describe("stall classification after a server-directed retry wait", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		unregisterApiProviders(SOURCE_ID);
	});

	async function createSession(): Promise<{
		session: Awaited<ReturnType<typeof createAgentSession>>["session"];
		events: AgentSessionEvent[];
	}> {
		const tempDir = join(tmpdir(), `pi-r15-stall-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, provider: { streamStallTimeoutMs: 80 } },
			}),
		);

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
			model,
			authStorage,
			settingsManager,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			resourceLoader,
		});
		await session.bindExtensions({});

		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			events.push(event);
		});

		cleanups.push(async () => {
			await session.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		});

		return { session, events };
	}

	function assistantMessages(events: AgentSessionEvent[]): AssistantMessage[] {
		return events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "assistant" ? [event.message as AssistantMessage] : [],
		);
	}

	function autoRetryStarts(events: AgentSessionEvent[]): AgentSessionEvent[] {
		return events.filter((event) => event.type === "auto_retry_start");
	}

	it("resends the whole context when output already streamed before the stall", async () => {
		installProvider("partial-output-then-stall");
		const { session, events } = await createSession();

		await session.prompt("hello");

		// The whole context goes out again, because a turn that produced output and then
		// went silent is the shape a resend recovers.
		expect(autoRetryStarts(events)).toHaveLength(1);
		expect(providerCalls).toBe(2);

		const stalled = assistantMessages(events)[0];
		expect(stalled).toBeDefined();
		expect(stalled.stopReason).toBe("error");
		expect(stalled.errorMessage).toContain("Stream stalled");
		// The earlier 429 does not get to call this throttling.
		expect(stalled.errorMessage).not.toContain("throttling");
		expect(stalled.stopReasonRaw).not.toBe(SERVER_DIRECTED_RETRY_STALL_STOP_REASON_RAW);
		expect(stalled.content).toEqual([{ type: "text", text: "half an answer" }]);
	});

	it("does not resend while the attempt is still inside the provider's retry wait", async () => {
		installProvider("stay-in-the-retry-wait");
		const { session, events } = await createSession();

		await session.prompt("hello");

		expect(autoRetryStarts(events)).toHaveLength(0);
		expect(providerCalls).toBe(1);

		const stalled = assistantMessages(events)[0];
		expect(stalled?.stopReason).toBe("error");
		expect(stalled?.errorMessage).toContain("throttling");
		expect(stalled?.stopReasonRaw).toBe(SERVER_DIRECTED_RETRY_STALL_STOP_REASON_RAW);
	});
});
