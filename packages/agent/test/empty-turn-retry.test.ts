import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	EMPTY_TURN_RETRY_DEFAULTS,
	EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE,
	EMPTY_TURN_RETRY_EXHAUSTED_STOP_REASON_RAW,
	isEmptyTurnRetryExhausted,
	runAgentLoop,
} from "../src/agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../src/types.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function emptyTurn(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "..." }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

/** A stream function that answers every call with an empty turn and records call times. */
function emptyStreamFn() {
	const startedAtMs: number[] = [];
	const streamFn = vi.fn(() => {
		startedAtMs.push(Date.now());
		const stream = new MockAssistantStream();
		const message = emptyTurn();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	});
	const gapsMs = () => startedAtMs.slice(1).map((t, i) => t - startedAtMs[i]);
	return { streamFn, calls: () => startedAtMs.length, gapsMs };
}

async function run(config: Partial<AgentLoopConfig>, streamFn: unknown) {
	const context: AgentContext = { systemPrompt: "sys", messages: [], tools: [] };
	const messages = await runAgentLoop(
		[createUserMessage("hello")],
		context,
		{ model: createModel(), convertToLlm: identityConverter, ...config } as AgentLoopConfig,
		async () => {},
		undefined,
		streamFn as never,
	);
	const assistant = messages.filter((m) => m.role === "assistant").at(-1) as AssistantMessage;
	return { assistant, messages };
}

describe("empty-turn retry policy", () => {
	it("spaces the in-place retries out instead of firing them back-to-back", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();

		const { assistant } = await run({}, streamFn);

		expect(calls()).toBe(EMPTY_TURN_RETRY_DEFAULTS.maxAttempts);
		const gaps = gapsMs();
		// The defect this guards: three requests inside the same millisecond.
		expect(gaps).toHaveLength(EMPTY_TURN_RETRY_DEFAULTS.maxAttempts - 1);
		for (const gap of gaps) {
			expect(gap).toBeGreaterThanOrEqual(EMPTY_TURN_RETRY_DEFAULTS.baseDelayMs - 50);
		}
		// The waits double: the second gap is at least the first.
		expect(gaps[1]).toBeGreaterThanOrEqual(gaps[0]);

		expect(assistant.stopReason).toBe("error");
		expect(assistant.stopReasonRaw).toBe(EMPTY_TURN_RETRY_EXHAUSTED_STOP_REASON_RAW);
		expect(isEmptyTurnRetryExhausted(assistant)).toBe(true);
		// Exhaustion is reported as an actionable diagnosis, with the observed waits.
		expect(assistant.errorMessage).toMatch(/empty response/i);
		expect(assistant.errorMessage).toMatch(/waited \d+ms between attempts/);
		expect(assistant.errorMessage).toContain("retry.emptyTurn");
		const diagnostic = assistant.diagnostics?.find((d) => d.type === EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE);
		expect(diagnostic?.details).toMatchObject({
			attempts: EMPTY_TURN_RETRY_DEFAULTS.maxAttempts,
			waitedMs: EMPTY_TURN_RETRY_DEFAULTS.baseDelayMs + EMPTY_TURN_RETRY_DEFAULTS.baseDelayMs * 2,
		});
		expect((diagnostic?.details as { waitedMs: number }).waitedMs).toBeGreaterThan(0);
	});

	it("respects a configured attempt count and backoff", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();

		const { assistant } = await run(
			{ emptyTurnRetry: { maxAttempts: 2, baseDelayMs: 20, maxDelayMs: 40 } },
			streamFn,
		);

		expect(calls()).toBe(2);
		expect(gapsMs()[0]).toBeGreaterThanOrEqual(15);
		expect(assistant.errorMessage).toContain("empty response");
	});

	it("ends the retries at the total wait budget and names the budget as the reason", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();

		const { assistant } = await run(
			{ emptyTurnRetry: { maxAttempts: 6, baseDelayMs: 20, maxDelayMs: 20, maxTotalDelayMs: 30 } },
			streamFn,
		);

		// One 20ms wait fits the 30ms budget; the second would not, so two attempts run.
		expect(calls()).toBe(2);
		expect(gapsMs()).toHaveLength(1);
		expect(assistant.stopReason).toBe("error");
		expect(assistant.errorMessage).toMatch(/budget/i);
	});

	it("does not wait when a single attempt is configured", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();
		const startedAt = Date.now();

		const { assistant } = await run({ emptyTurnRetry: { maxAttempts: 1, baseDelayMs: 500 } }, streamFn);

		expect(calls()).toBe(1);
		expect(gapsMs()).toHaveLength(0);
		expect(Date.now() - startedAt).toBeLessThan(400);
		expect(isEmptyTurnRetryExhausted(assistant)).toBe(true);
	});
});
