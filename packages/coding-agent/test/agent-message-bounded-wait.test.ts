import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFamilyRosterResult } from "../src/core/agent-messages.js";
import {
	type AgentSessionMessageReceipt,
	createAgentMessageHostHandlers,
	isRetryableAgentMessageSendError,
} from "../src/core/agent-messages.js";
import { DEFAULT_HOST_REQUEST_MAX_AGE_MS } from "../src/core/turn-liveness.js";
import {
	AttemptBudgetExceededError,
	consumeAttempt,
	createAttemptBudget,
	DEFAULT_ATTEMPT_BUDGET_MAX,
	DEFAULT_SHORT_TARGET_WAIT_MS,
	DEFAULT_TARGET_WAIT_MS,
	formatWaitTimeoutMessage,
} from "../src/utils/bounded-wait.js";

const ROSTER: AgentFamilyRosterResult = {
	current: { name: "parent", id: "parent-1", depth: 0 },
	entries: [
		{ relationship: "child", name: "worker", id: "child-1", depth: 1, status: "running" },
		{ relationship: "parent", name: "parent", id: "parent-1", depth: 0, status: "running" },
	],
};

function receipt(target: string): AgentSessionMessageReceipt {
	return {
		id: "agentmsg_test",
		source: "agent_message",
		target: { activeSessionId: target, sessionId: target },
		message: "hello",
		deliveryStatus: "delivered",
		deliveredAt: new Date().toISOString(),
	};
}

interface ControllerOptions {
	publication?: Promise<string | undefined>;
	send?: (input: { target: string; message: string }) => Promise<AgentSessionMessageReceipt>;
}

function controller(options: ControllerOptions = {}) {
	const sentTo: string[] = [];
	return {
		sentTo,
		roster: async () => ROSTER,
		awaitPendingChildPublication: options.publication ? async () => options.publication : undefined,
		sendAgentMessage: async (input: { target: string; message: string }) => {
			sentTo.push(input.target);
			if (options.send) return options.send(input);
			return receipt(input.target);
		},
	};
}

function sendPayload(message = "hello") {
	return { type: "agent_message.send", message, receiver_role: "child", receiver_name: "worker" };
}

/** The publication bounds below are driven by a fake clock, never by the wall clock. */
afterEach(() => {
	vi.useRealTimers();
});

describe("agent_message.send bounded target wait (P1-1)", () => {
	it("returns a readable outcome instead of hanging on a publication that never settles", async () => {
		// One injected clock drives both the budget and the measurement. With real timers the two
		// are independent (the timer wheel rounds to whole ms, Date.now() is the wall clock), so the
		// same 40ms bound was observed reporting 39ms waited under CI load - a coin flip at the
		// boundary rather than a verdict about the wait.
		vi.useFakeTimers();
		const timeouts: unknown[] = [];
		const target = controller({ publication: new Promise<string | undefined>(() => {}) });
		const handlers = createAgentMessageHostHandlers(target as never, {
			publicationWaitMs: 40,
			onWaitTimeout: (facts) => timeouts.push(facts),
		});

		const send = handlers["agent_message.send"]!(sendPayload());
		// Up to its budget the wait gives up on neither side: no timeout fact, and no delivery
		// either, because the publication is still what the caller is waiting on.
		await vi.advanceTimersByTimeAsync(39);
		expect(timeouts).toEqual([]);
		expect(target.sentTo).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		const result = await send;
		// The wait timed out, the publication was left running, and the send still went through on
		// the roster match: the model gets its message delivered, not an error to retry.
		expect(result).toMatchObject({ deliveryStatus: "delivered", target: { activeSessionId: "child-1" } });
		expect(timeouts).toHaveLength(1);
		expect(timeouts[0]).toMatchObject({ phase: "publication", target: "worker" });
		// The bound is what bounded it: the wait reports exactly the budget it was given.
		expect((timeouts[0] as { waitedMs: number }).waitedMs).toBe(40);
		// And it left nothing behind: the un-settled publication does not keep a timer armed.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports a roster miss after a timed-out wait as an actionable error", async () => {
		vi.useFakeTimers();
		const handlers = createAgentMessageHostHandlers(
			controller({ publication: new Promise<string | undefined>(() => {}) }) as never,
			{ publicationWaitMs: 20 },
		);
		// Attached before the clock runs so the rejection is never unhandled.
		const rejected = expect(
			handlers["agent_message.send"]!({
				type: "agent_message.send",
				message: "hello",
				receiver_role: "child",
				receiver_name: "nobody",
			}),
		).rejects.toThrow(/No child matches/);
		await vi.advanceTimersByTimeAsync(20);
		await rejected;
	});

	it("delivers to a healthy target end to end (positive control)", async () => {
		const target = controller({ publication: Promise.resolve("child-1") });
		const handlers = createAgentMessageHostHandlers(target as never, { publicationWaitMs: 5_000 });
		const result = await handlers["agent_message.send"]!(sendPayload());
		expect(result).toMatchObject({ deliveryStatus: "delivered" });
		expect(target.sentTo).toEqual(["child-1"]);
	});

	it("hands the cell signal to the publication wait so an abort ends it with an error", async () => {
		let seen: AbortSignal | undefined;
		const publication = new Promise<string | undefined>(() => {});
		const handlers = createAgentMessageHostHandlers({
			roster: async () => ROSTER,
			awaitPendingChildPublication: async (_selector: string, signal?: AbortSignal) => {
				seen = signal;
				return publication;
			},
			sendAgentMessage: async (input: { target: string }) => receipt(input.target),
		} as never);
		const controller = new AbortController();
		const pending = handlers["agent_message.send"]!(sendPayload(), controller.signal);
		await vi.waitFor(() => expect(seen).toBeDefined());
		controller.abort();
		// An abort ends the wait loudly rather than silently delivering: the only signal that
		// reaches a non-whitelisted request in production is the teardown one, and a send that was
		// cancelled mid-flight must not report itself as delivered.
		await expect(pending).rejects.toThrow();
		expect(seen?.aborted).toBe(true);
	});
});

describe("retryable classification of the new bounded waits (M6b)", () => {
	it("counts a timed-out wait toward the three-strike terminal gate", () => {
		const message = formatWaitTimeoutMessage({ phase: "passivation", target: "/tmp/s.jsonl", waitedMs: 120_000 });
		expect(isRetryableAgentMessageSendError(message)).toBe(true);
	});

	it("counts an exhausted re-entry budget, and not an unrelated failure", () => {
		const exhausted = new AttemptBudgetExceededError({
			attempts: 33,
			elapsedMs: 61_000,
			phase: "hydrate",
			target: "child-1",
			maxAttempts: DEFAULT_ATTEMPT_BUDGET_MAX,
		});
		expect(isRetryableAgentMessageSendError(exhausted.message)).toBe(true);
		expect(exhausted.retryable).toBe(true);
		// Negative control: a plain delivery failure stays non-retryable.
		expect(isRetryableAgentMessageSendError('No child matches "worker"')).toBe(false);
	});
});

describe("attempt budget (M19)", () => {
	it("allows far more legitimate re-entries than an agent depth limit would", () => {
		const budget = createAttemptBudget(DEFAULT_ATTEMPT_BUDGET_MAX, 60_000, 1_000);
		// Eight clients attaching to one session each publish and re-enter: the whole ceiling of
		// 32 attempts is legal, and only the 33rd is refused.
		for (let attempt = 0; attempt < DEFAULT_ATTEMPT_BUDGET_MAX; attempt++) {
			consumeAttempt(budget, { phase: "hydrate", target: "child-1" }, 1_000 + attempt);
		}
		expect(budget.attempts).toBe(DEFAULT_ATTEMPT_BUDGET_MAX);
		expect(() => consumeAttempt(budget, { phase: "hydrate", target: "child-1" }, 1_100)).toThrow(
			AttemptBudgetExceededError,
		);
	});

	it("ends the loop on the total deadline even below the attempt ceiling", () => {
		const budget = createAttemptBudget(32, 60_000, 0);
		consumeAttempt(budget, { phase: "hydrate", target: "child-1" }, 10);
		expect(() => consumeAttempt(budget, { phase: "hydrate", target: "child-1" }, 60_001)).toThrow(/wait timed out/);
	});

	it("is decoupled from the agent depth setting", () => {
		// RLM_MAX_DEPTH defaults to 2; borrowing it here would cap a hydration at four re-entries.
		expect(DEFAULT_ATTEMPT_BUDGET_MAX).toBeGreaterThan(2 + 2);
		expect(DEFAULT_ATTEMPT_BUDGET_MAX).toBe(32);
	});
});

describe("wait tier invariants", () => {
	it("keeps the request age bound far above the longest wait (I-5)", () => {
		// A vouched request must have been collected by a bounded wait long before its age stops
		// vouching, or the two clocks would contradict each other.
		expect(DEFAULT_HOST_REQUEST_MAX_AGE_MS).toBeGreaterThan(DEFAULT_TARGET_WAIT_MS * 5);
		expect(DEFAULT_TARGET_WAIT_MS).toBe(120_000);
		expect(DEFAULT_SHORT_TARGET_WAIT_MS).toBe(60_000);
	});
});
