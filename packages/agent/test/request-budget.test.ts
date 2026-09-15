import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE,
	EMPTY_TURN_RETRY_EXHAUSTED_STOP_REASON_RAW,
	runAgentLoop,
} from "../src/agent-loop.js";
import type { AgentContext, AgentLoopConfig, AgentMessage } from "../src/types.js";

/**
 * RC-3, second half: the SDK's retries and the loop's in-place resends used separate
 * counters, so the layers multiplied (3 SDK requests x 3 in-place resends = 9 identical
 * full-context requests for one empty upstream). The loop must spend from the same chain
 * counter as the provider layer and stop resending when it runs out.
 *
 * The budget is duck-typed here on purpose: the same file runs against the frozen
 * revision, where the loop did not know about any shared counter, to show the red.
 */
interface BudgetShape {
	used: number;
	maxRequests: number;
	readonly exhausted: boolean;
	record(): { attempt: number; allowRetry: boolean; used: number; maxRequests?: number };
}

function createBudgetShape(maxRequests: number): BudgetShape {
	let used = 0;
	return {
		get used() {
			return used;
		},
		maxRequests,
		get exhausted() {
			return used >= maxRequests;
		},
		record() {
			used += 1;
			return { attempt: used, allowRetry: used < maxRequests, used, maxRequests };
		},
	};
}

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

interface BudgetedStream {
	streamFn: unknown;
	requests: () => number;
	providerAttempts: number[];
}

/**
 * A stream function that models an SDK-backed provider: one loop attempt issues up to
 * three provider requests (the standard 2-retry client), all counted through the shared
 * budget the loop hands down. It answers with an empty turn, which is the shape the loop
 * resends in place.
 */
function budgetedEmptyStreamFn(budget: BudgetShape): BudgetedStream {
	let requests = 0;
	const providerAttempts: number[] = [];
	const streamFn = ((
		_model: Model<never>,
		_context: unknown,
		options?: {
			requestBudget?: BudgetShape;
			onProviderRequestAttempt?: (notice: { attempt: number; used: number; maxRequests?: number }) => void;
		},
	) => {
		const shared = options?.requestBudget ?? budget;
		let answered = false;
		for (let sdkAttempt = 0; sdkAttempt < 3; sdkAttempt++) {
			const recorded = shared.record();
			requests += 1;
			providerAttempts.push(recorded.attempt);
			options?.onProviderRequestAttempt?.({
				attempt: recorded.attempt,
				used: recorded.used,
				maxRequests: recorded.maxRequests,
			});
			// The SDK stops as soon as the chain (or its own retry count) says no more.
			if (!recorded.allowRetry || shared.exhausted) {
				answered = true;
				break;
			}
		}
		if (!answered) requests += 0;
		const stream = new MockAssistantStream();
		const message = emptyTurn();
		stream.push({ type: "start", partial: message });
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	}) as never;
	return { streamFn, requests: () => requests, providerAttempts };
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

describe("agent loop spends from the shared provider request budget", () => {
	it("stops the in-place resends at the shared ceiling instead of multiplying the layers", async () => {
		const budget = createBudgetShape(3);
		const { streamFn, requests } = budgetedEmptyStreamFn(budget);

		const { assistant } = await run(
			{
				emptyTurnRetry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1, maxTotalDelayMs: 10 },
				requestBudget: budget,
			} as Partial<AgentLoopConfig>,
			streamFn,
		);

		// One loop attempt spends the chain's three requests; a fourth would exceed the
		// ceiling the layers share, so the loop must not start another attempt.
		expect(requests()).toBe(3);
		expect(budget.exhausted).toBe(true);
		expect(assistant.stopReason).toBe("error");
		expect(assistant.stopReasonRaw).toBe(EMPTY_TURN_RETRY_EXHAUSTED_STOP_REASON_RAW);
		expect(assistant.errorMessage).toMatch(/shared provider request budget/i);
		const diagnostic = assistant.diagnostics?.find((d) => d.type === EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE);
		expect(diagnostic?.details).toMatchObject({
			terminatedBy: "request_budget",
			requestBudget: { used: 3, maxRequests: 3 },
		});
	});

	it("leaves the resend policy untouched when the chain still has requests (positive control)", async () => {
		const budget = createBudgetShape(30);
		const { streamFn, requests } = budgetedEmptyStreamFn(budget);

		const { assistant } = await run(
			{
				emptyTurnRetry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, maxTotalDelayMs: 10 },
				requestBudget: budget,
			} as Partial<AgentLoopConfig>,
			streamFn,
		);

		expect(requests()).toBe(6);
		expect(assistant.errorMessage).toMatch(/empty response/i);
		const diagnostic = assistant.diagnostics?.find((d) => d.type === EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE);
		expect((diagnostic?.details as { terminatedBy?: string }).terminatedBy).toBe("attempts");
	});

	it("records the attempt list on the message without any transcript-visible retry count before", async () => {
		const budget = createBudgetShape(3);
		const { streamFn } = budgetedEmptyStreamFn(budget);

		const { assistant } = await run(
			{
				emptyTurnRetry: { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1, maxTotalDelayMs: 10 },
				requestBudget: budget,
			} as Partial<AgentLoopConfig>,
			streamFn,
		);

		const attempts = assistant.diagnostics?.find((d) => d.type === "provider_request_budget");
		expect(attempts).toBeDefined();
		expect(attempts?.details).toMatchObject({ used: 3, maxRequests: 3 });
		expect((attempts?.details as { attempts: unknown[] }).attempts.length).toBeGreaterThan(1);
	});
});
