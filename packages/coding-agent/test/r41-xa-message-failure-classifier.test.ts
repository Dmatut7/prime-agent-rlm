import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyRosterResult,
	type AgentSessionMessageController,
	classifyAgentMessageSendFailureByMessage,
	createAgentMessageHostHandlers,
	formatAgentMessageRetryExhaustedError,
} from "../src/core/agent-messages.js";
import {
	CRON_DEFER_BACKOFF_CAP_MS,
	CRON_DEFER_ESCALATED_RECHECK_MS,
	CRON_DEFER_FAST_ATTEMPTS,
	CRON_DEFER_MAX_ATTEMPTS,
	CRON_FENCE_RETRY_MS,
} from "../src/core/cron-jobs.js";
import {
	SessionInputAdmissionPausedError,
	SessionInputCoalescingError,
	SessionInputSuspendedError,
} from "../src/core/prompt-admission.js";
import { createHarness, type Harness } from "./suite/harness.js";

/** Mirrors the private M6b ceiling in agent-session.ts (three strikes). */
const AGENT_MESSAGE_RETRYABLE_FAILURE_LIMIT = 3;

/**
 * r41 XA-7: the string fallback for cross-process send failures decodes the
 * typed contract's serialized form instead of collapsing "provably delivered
 * nothing" (a) and "retrying now can succeed" (b) into one boolean. The old
 * single-boolean predicate answered (b)=true for the update-restart fence,
 * which is exactly the answer the M6b terminal guidance must not give.
 */

const fenced = new SessionInputSuspendedError({ queuedActionCount: 2, suspendedForUpdateRestart: true });
const parked = new SessionInputSuspendedError({ queuedActionCount: 0, suspendedForUpdateRestart: false });
const paused = new SessionInputAdmissionPausedError({ pausedCount: 1 });
const pausedForTeardown = new SessionInputAdmissionPausedError({ pausedCount: 1, forUpdateRestart: true });
const coalescing = new SessionInputCoalescingError({ queueKey: "heartbeat:job-1", ownerActionId: "action-1" });

const ROSTER: AgentFamilyRosterResult = {
	current: { name: "parent", id: "parent-1", depth: 0 },
	entries: [{ relationship: "child", name: "worker", id: "worker-1", depth: 1, status: "running" }],
};

describe("r41 XA: classifyAgentMessageSendFailureByMessage decodes the serialized typed contract", () => {
	it("answers (a)=true, (b)=false for the update-restart fence", () => {
		const verdict = classifyAgentMessageSendFailureByMessage(fenced.message);
		expect(verdict.deliveredNothing).toBe(true);
		expect(verdict.retryNowSucceeds).toBe(false);
	});

	it("answers (a)=true, (b)=true for a parked suspension, a pause lease, and the committing window", () => {
		for (const message of [parked.message, paused.message, coalescing.message]) {
			const verdict = classifyAgentMessageSendFailureByMessage(message);
			expect(verdict.deliveredNothing, message).toBe(true);
			expect(verdict.retryNowSucceeds, message).toBe(true);
		}
	});

	it("answers (b)=false for a bare suspended prefix carrying retryable=false", () => {
		// The historical bare shape (older serialization, no fence sentence).
		const message =
			"Cannot admit a session action while queued session input is suspended. 0 action(s) already queued; retryable=false.";
		const verdict = classifyAgentMessageSendFailureByMessage(message);
		expect(verdict.deliveredNothing).toBe(true);
		expect(verdict.retryNowSucceeds).toBe(false);
	});

	it("answers (b)=undefined when the serialized form cannot answer (queue full, rate limit, waits)", () => {
		const unanswered = [
			"Target session has too many pending messages: 20 unfinished, limit is 20",
			"Agent messaging rate limit exceeded; retry after 900ms",
			"Agent message was not accepted",
			"the bounded wait timed out after 120000ms",
		];
		expect(unanswered.length).toBeGreaterThan(0);
		for (const message of unanswered) {
			const verdict = classifyAgentMessageSendFailureByMessage(message);
			expect(verdict.deliveredNothing, message).toBe(true);
			expect(verdict.retryNowSucceeds, message).toBeUndefined();
		}
	});

	it("answers (a)=false for terminal shapes instead of guessing", () => {
		for (const message of [
			"Unknown active session: nope",
			"Agent messaging cannot target the sending session",
			'No child matches "worker"',
		]) {
			const verdict = classifyAgentMessageSendFailureByMessage(message);
			expect(verdict.deliveredNothing, message).toBe(false);
			expect(verdict.retryNowSucceeds, message).toBeUndefined();
		}
	});

	it("keeps the r39 QP-2 pause guidance retryable and decodes the teardown lease as restart-only", () => {
		expect(classifyAgentMessageSendFailureByMessage(paused.message).retryNowSucceeds).toBe(true);
		const teardown = classifyAgentMessageSendFailureByMessage(pausedForTeardown.message);
		expect(teardown.deliveredNothing).toBe(true);
		expect(teardown.retryNowSucceeds).toBe(false);
		expect(pausedForTeardown.message).toContain("update-restart teardown");
		expect(pausedForTeardown.message).toContain("resend after the restart");
	});
});

describe("r41 XA: the retry-exhausted guidance splits on (b)", () => {
	it("keeps the generic exhausted text for failures whose retry-now answer is unknown", () => {
		const error = formatAgentMessageRetryExhaustedError({
			target: "worker-1",
			attempts: 3,
			lastError: "rate limit exceeded",
		});
		expect(error).toContain("3 times in a row");
		expect(error).toContain("terminal, not retryable");
		expect(error).toContain("Nothing was delivered");
	});

	it("guides a fenced target to persist and resend after the restart instead of retrying", () => {
		const error = formatAgentMessageRetryExhaustedError({
			target: "worker-1",
			attempts: 3,
			lastError: fenced.message,
			fenced: true,
		});
		expect(error).toContain("fenced for an update-restart");
		expect(error).toContain("resend it after the restart");
		expect(error).toContain("Nothing was delivered");
	});
});

describe("r41 XA: M6b three-strike terminal guidance for a fenced target", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("counts every refusal and terminally guides the third toward the restart", async () => {
		const send = vi.fn(async () => {
			throw new SessionInputSuspendedError({ queuedActionCount: 0, suspendedForUpdateRestart: true });
		});
		const controller: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "current", sessionId: "session-current" },
				agents: [],
			}),
			sendAgentMessage: send,
		};
		const harness = await createHarness({ agentMessageController: controller });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unused")]);

		const errors: string[] = [];
		for (let i = 0; i < AGENT_MESSAGE_RETRYABLE_FAILURE_LIMIT; i += 1) {
			const error = await (
				harness.session.handleAgentMessageHostRequest("agent_message.send", {
					target: "worker-1",
					message: "ping",
				}) as Promise<unknown>
			).then(
				() => undefined,
				(thrown: unknown) => (thrown instanceof Error ? thrown.message : String(thrown)),
			);
			errors.push(error ?? "<fulfilled>");
		}
		// The strike count itself is unchanged: the first two refusals surface as
		// the raw refusal, only the third is terminalized.
		expect(errors[0]).toContain("queued session input is suspended");
		expect(errors[1]).toContain("queued session input is suspended");
		expect(errors.length).toBe(AGENT_MESSAGE_RETRYABLE_FAILURE_LIMIT);
		const terminal = errors[AGENT_MESSAGE_RETRYABLE_FAILURE_LIMIT - 1] ?? "";
		expect(terminal).toContain("times in a row");
		expect(terminal).toContain("fenced for an update-restart");
		expect(terminal).toContain("resend it after the restart");
		// The delivery leg was attempted every time (the refusal is pre-delivery).
		expect(send).toHaveBeenCalledTimes(AGENT_MESSAGE_RETRYABLE_FAILURE_LIMIT);
	});
});

describe("r41 XA: a pre-delivery refusal keeps the message id unspent for all refusal kinds", () => {
	it("reaches the delivery leg on resend after fence, parked, pause, and coalescing refusals", async () => {
		for (const refusal of [fenced, parked, paused, coalescing]) {
			let deliveries = 0;
			const handlers = createAgentMessageHostHandlers({
				roster: async () => ROSTER,
				sendAgentMessage: async () => {
					deliveries += 1;
					if (deliveries === 1) {
						throw refusal;
					}
					return {
						id: `receipt-${deliveries}`,
						source: AGENT_MESSAGE_SOURCE,
						target: { activeSessionId: "worker-1", sessionId: "session-worker" },
						message: "the report",
						deliveryStatus: "delivered" as const,
					};
				},
			});
			const payload = { receiver_role: "child", receiver_name: "worker", message: "the report" };
			await handlers["agent_message.send"]!({ ...payload, message_id: `id-${refusal.name}` }).then(
				() => undefined,
				() => undefined,
			);
			const second = await handlers["agent_message.send"]!({ ...payload, message_id: `id-${refusal.name}` }).then(
				() => "fulfilled",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			expect(deliveries, refusal.name).toBe(2);
			expect(String(second), refusal.name).not.toContain("Refusing to resend");
		}
	});
});

describe("r41 XA: cron defer constants expose the bounded cadence", () => {
	it("documents the tiers the scheduler reads", () => {
		// Fence tier is restart-aware; transient tier is fast then capped.
		expect(CRON_FENCE_RETRY_MS).toBe(30_000);
		expect(CRON_DEFER_FAST_ATTEMPTS).toBe(3);
		expect(CRON_DEFER_BACKOFF_CAP_MS).toBe(300_000);
		expect(CRON_DEFER_MAX_ATTEMPTS).toBe(20);
		expect(CRON_DEFER_ESCALATED_RECHECK_MS).toBe(3_600_000);
	});
});
