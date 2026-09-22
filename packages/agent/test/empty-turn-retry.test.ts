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
	ESCALATED_EMPTY_TURN_RETRY_DEFAULTS,
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

async function run(config: Partial<AgentLoopConfig>, streamFn: unknown, signal?: AbortSignal) {
	const context: AgentContext = { systemPrompt: "sys", messages: [], tools: [] };
	const messages = await runAgentLoop(
		[createUserMessage("hello")],
		context,
		{ model: createModel(), convertToLlm: identityConverter, ...config } as AgentLoopConfig,
		async () => {},
		signal,
		streamFn as never,
	);
	const assistant = messages.filter((m) => m.role === "assistant").at(-1) as AssistantMessage;
	return { assistant, messages };
}

/** A stream that answers empty N times, then a real answer: pins how deep the ladder runs. */
function recoveringStreamFn(emptyTimes: number) {
	let calls = 0;
	const streamFn = vi.fn(() => {
		calls += 1;
		const stream = new MockAssistantStream();
		const message =
			calls <= emptyTimes
				? emptyTurn()
				: { ...emptyTurn(), content: [{ type: "text" as const, text: "recovered" }] };
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	});
	return { streamFn, calls: () => calls };
}

function emptyExhaustionDiagnostic(assistant: AssistantMessage) {
	const diagnostic = assistant.diagnostics?.find((d) => d.type === EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE);
	return (diagnostic?.details ?? {}) as {
		attempts?: number;
		waitedMs?: number;
		escalatedAttempts?: number;
		escalatedWaitedMs?: number;
		fastWaitedMs?: number;
		terminatedBy?: string;
	};
}

describe("empty-turn retry policy", () => {
	it("spaces the in-place retries out instead of firing them back-to-back", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();

		const { assistant } = await run({ emptyTurnRetry: { escalatedAttempts: 0 } }, streamFn);

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
			{ emptyTurnRetry: { maxAttempts: 2, baseDelayMs: 20, maxDelayMs: 40, escalatedAttempts: 0 } },
			streamFn,
		);

		expect(calls()).toBe(2);
		expect(gapsMs()[0]).toBeGreaterThanOrEqual(15);
		expect(assistant.errorMessage).toContain("empty response");
	});

	it("ends the retries at the total wait budget and names the budget as the reason", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();

		const { assistant } = await run(
			{
				emptyTurnRetry: {
					maxAttempts: 6,
					baseDelayMs: 20,
					maxDelayMs: 20,
					maxTotalDelayMs: 30,
					escalatedAttempts: 0,
				},
			},
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

		const { assistant } = await run(
			{ emptyTurnRetry: { maxAttempts: 1, baseDelayMs: 500, escalatedAttempts: 0 } },
			streamFn,
		);

		expect(calls()).toBe(1);
		expect(gapsMs()).toHaveLength(0);
		expect(Date.now() - startedAt).toBeLessThan(400);
		expect(isEmptyTurnRetryExhausted(assistant)).toBe(true);
	});
});

describe("empty-turn retry escalated slow tier", () => {
	it("keeps resending with longer waits after the fast attempts are spent", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();

		const { assistant } = await run(
			{
				emptyTurnRetry: {
					maxAttempts: 2,
					baseDelayMs: 5,
					maxDelayMs: 10,
					escalatedAttempts: 3,
					escalatedBaseDelayMs: 20,
					escalatedMaxDelayMs: 80,
					escalatedMaxTotalDelayMs: 500,
				},
			},
			streamFn,
		);

		// 2 fast attempts, then 3 slow ones: the ladder is an extension of the count.
		expect(calls()).toBe(5);
		const gaps = gapsMs();
		expect(gaps).toHaveLength(4);
		// The first gap is fast-tier; every gap after the fast attempts is slow-tier,
		// strictly longer than the whole fast budget.
		expect(gaps[0]).toBeLessThan(20);
		for (const gap of gaps.slice(1)) {
			expect(gap).toBeGreaterThanOrEqual(15);
		}
		// The slow waits double, capped by escalatedMaxDelayMs.
		expect(gaps[3]).toBeGreaterThanOrEqual(gaps[2]);
		expect(gaps[3]).toBeLessThanOrEqual(90);

		expect(isEmptyTurnRetryExhausted(assistant)).toBe(true);
		const details = emptyExhaustionDiagnostic(assistant);
		expect(details.attempts).toBe(5);
		expect(details.escalatedAttempts).toBe(3);
		expect(details.terminatedBy).toBe("attempts");
		expect(details.escalatedWaitedMs ?? 0).toBeGreaterThanOrEqual(15 * 3);
		expect(details.escalatedWaitedMs ?? 0).toBeLessThanOrEqual(300);
		expect(details.fastWaitedMs ?? 0).toBeLessThan(20);
		expect(details.waitedMs ?? 0).toBe((details.fastWaitedMs ?? 0) + (details.escalatedWaitedMs ?? 0));
		// The terminal message reports the tier split so the post-mortem can tell a
		// fast-only exhaustion from one that already escalated.
		expect(assistant.errorMessage).toMatch(/slow-tier gap\(s\) waited \d+ms/);
	});

	it("stops the slow tier at its own total wait budget and names the budget", async () => {
		const { streamFn, calls } = emptyStreamFn();

		const { assistant } = await run(
			{
				emptyTurnRetry: {
					maxAttempts: 2,
					baseDelayMs: 5,
					maxDelayMs: 10,
					escalatedAttempts: 3,
					escalatedBaseDelayMs: 20,
					escalatedMaxDelayMs: 80,
					// One 20ms slow wait fits; the second would not.
					escalatedMaxTotalDelayMs: 30,
				},
			},
			streamFn,
		);

		expect(calls()).toBe(3); // 2 fast + 1 slow
		const details = emptyExhaustionDiagnostic(assistant);
		expect(details.terminatedBy).toBe("budget");
		expect(details.escalatedAttempts).toBe(1);
		expect(assistant.errorMessage).toMatch(/budget/);
	});

	it("the default policy escalates after the fast attempts are spent", async () => {
		const { streamFn, calls } = recoveringStreamFn(EMPTY_TURN_RETRY_DEFAULTS.maxAttempts);

		const { assistant } = await run(
			{ emptyTurnRetry: { escalatedBaseDelayMs: 5, escalatedMaxDelayMs: 10 } },
			streamFn,
		);

		// The first non-empty answer arrives after the fast attempts, inside the slow
		// tier: the default ladder is deep enough to catch a minutes-long outage.
		expect(calls()).toBe(EMPTY_TURN_RETRY_DEFAULTS.maxAttempts + 1);
		expect(assistant.stopReason).toBe("stop");
		expect(isEmptyTurnRetryExhausted(assistant)).toBe(false);
		// Escalation defaults ship far below a typical stall-watchdog warn threshold.
		expect(ESCALATED_EMPTY_TURN_RETRY_DEFAULTS.escalatedMaxDelayMs).toBeLessThan(300_000);
	});

	it("escalatedAttempts 0 rolls the ladder back to fast-only", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();

		const { assistant } = await run(
			{ emptyTurnRetry: { escalatedAttempts: 0, maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10 } },
			streamFn,
		);

		expect(calls()).toBe(3);
		expect(gapsMs()).toHaveLength(2);
		for (const gap of gapsMs()) {
			expect(gap).toBeLessThan(20);
		}
		const details = emptyExhaustionDiagnostic(assistant);
		expect(details.escalatedAttempts).toBe(0);
		expect(details.terminatedBy).toBe("attempts");
	});

	it("the base never pierces the cap: a single slow wait stays under the configured max", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();

		const { assistant } = await run(
			{
				emptyTurnRetry: {
					maxAttempts: 1,
					escalatedAttempts: 2,
					// The reviewer's probe shape: base 400 above cap 50 must not
					// resolve to a 400ms wait.
					escalatedBaseDelayMs: 400,
					escalatedMaxDelayMs: 50,
				},
			},
			streamFn,
		);

		expect(calls()).toBe(3); // 1 fast + 2 slow
		const gaps = gapsMs();
		expect(gaps).toHaveLength(2);
		for (const gap of gaps) {
			expect(gap).toBeLessThanOrEqual(60); // 50ms cap plus scheduler slack
		}
		const details = emptyExhaustionDiagnostic(assistant);
		expect(details.terminatedBy).toBe("attempts");
	});

	it("the loop-side clamp bounds base and cap together below the host's silence threshold", async () => {
		const { streamFn, calls, gapsMs } = emptyStreamFn();

		const { assistant } = await run(
			{
				emptyTurnRetry: {
					maxAttempts: 1,
					escalatedAttempts: 2,
					escalatedBaseDelayMs: 400,
					escalatedMaxDelayMs: 50,
					// What a host derives from a 46ms warn threshold: 45ms with headroom.
					escalatedMaxDelayClampMs: 45,
				},
			},
			streamFn,
		);

		expect(calls()).toBe(3);
		for (const gap of gapsMs()) {
			expect(gap).toBeLessThanOrEqual(55); // the 45ms clamp plus scheduler slack
		}
		const details = emptyExhaustionDiagnostic(assistant);
		expect(details.terminatedBy).toBe("attempts");
	});

	it("the slow tier's own budget is distinguishable from the fast tier's total budget", async () => {
		const { streamFn, calls } = emptyStreamFn();

		const { assistant } = await run(
			{
				emptyTurnRetry: {
					maxAttempts: 2,
					baseDelayMs: 5,
					maxDelayMs: 5,
					// The fast tier's total wait budget is spent after one gap; if the
					// slow tier read the same pool, the chain would stop right there.
					maxTotalDelayMs: 5,
					escalatedAttempts: 2,
					escalatedBaseDelayMs: 20,
					escalatedMaxDelayMs: 80,
					escalatedMaxTotalDelayMs: 5000,
				},
			},
			streamFn,
		);

		// 2 fast attempts, then the slow tier spends its own (large) budget.
		expect(calls()).toBe(4);
		const details = emptyExhaustionDiagnostic(assistant);
		expect(details.terminatedBy).toBe("attempts");
		expect(details.escalatedAttempts).toBe(2);
		expect(details.fastWaitedMs).toBe(5);
		expect(details.escalatedWaitedMs).toBe(60);
	});

	it("a run abort during a slow-tier wait settles the run immediately", async () => {
		const { streamFn, calls } = emptyStreamFn();
		const controller = new AbortController();
		const startedAt = Date.now();
		setTimeout(() => controller.abort(), 15);

		const { assistant } = await run(
			{
				emptyTurnRetry: {
					maxAttempts: 1,
					escalatedAttempts: 2,
					// The next slow wait would be 60s: the abort must cut through it.
					escalatedBaseDelayMs: 60_000,
					escalatedMaxDelayMs: 60_000,
				},
			},
			streamFn,
			controller.signal,
		);

		expect(Date.now() - startedAt).toBeLessThan(5_000);
		expect(calls()).toBeLessThanOrEqual(2);
		expect(assistant.stopReason).toBe("aborted");
		expect(isEmptyTurnRetryExhausted(assistant)).toBe(false);
	});
});
