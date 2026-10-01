/**
 * W9-A (agent-223): quota park / wait terminal paths and the parent terminal notice.
 *
 * 1. A subagent parked for a provider quota reset used to emit the terminal-error
 *    parent notice from the parked turn's agent_end: the parent read "the child
 *    died", re-dispatched the task, and the parked wake later ran it a second time.
 *    The goal layer already exempts a live park ("the parked turn is the park's
 *    pause, not the goal's death"); the parent notice now holds the same line.
 * 2. The wait-abort terminal path (bounded pings exhausted) neither recorded the
 *    attempt count nor queued the wave-1 provider-failure recovery turn - the
 *    longest-running failure shape was the only one that ended in a silent stop.
 *    It now sets _providerFailureRecoveryPending like the ladder-exhausted path,
 *    and the notice reports the real ping count instead of "no retries attempted".
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFamilyRosterResult, AgentSessionMessageReceipt } from "../../../src/core/agent-messages.js";
import { PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE } from "../../../src/core/self-recovery.js";
import type { Settings } from "../../../src/core/settings-manager.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

function parentRoster(): AgentFamilyRosterResult {
	return {
		current: { name: "parked-child", id: "child-session-id", depth: 1 },
		entries: [
			{ relationship: "parent", name: "parent-session", id: "parent-session-id", depth: 0, status: "running" },
		],
	};
}

function receiptFor(message: string): AgentSessionMessageReceipt {
	return {
		id: "agentmsg_w9a_test",
		source: "agent_message",
		target: { activeSessionId: "parent-active", sessionId: "parent-session-id" },
		message,
		deliveryStatus: "delivered",
	};
}

function quotaFailure(options?: { retryAfterMs?: number }): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "429 You have hit your ChatGPT usage limit",
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: {
					kind: "rate_limit",
					status: 429,
					...(options?.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
				},
			},
		],
	};
}

function lifecycleFailureMessage(errorMessage: string): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		diagnostics: [
			{
				type: "agent_lifecycle_failure",
				timestamp: Date.now(),
				details: { source: "run_with_lifecycle" },
			},
		],
	};
}

function providerFailureRecoveries(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE,
	);
}

const waitSettings = (wait: {
	enabled?: boolean;
	baseDelayMs?: number;
	maxDelayMs?: number;
	maxAttempts?: number;
	maxWaitMs?: number;
	pauseUntilReset?: boolean;
	maxPauseMs?: number;
	maxParks?: number;
}): Partial<Settings> => ({
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 1,
		provider: { waitForUsage: wait },
	},
});

describe("W9-A quota park and the parent terminal notice", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not notify the parent of a terminal error while the session is quota-parked", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		const harness = await createHarness({
			rlmDepth: 1,
			settings: waitSettings({
				baseDelayMs: 1,
				maxDelayMs: 2,
				maxAttempts: 5,
				maxWaitMs: 1_000,
				maxPauseMs: 60_000,
			}),
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);
		// A provider-reported reset beyond the wait bound parks the session: the turn
		// ends with stopReason error, and the wake owns the resume.
		harness.setResponses([quotaFailure({ retryAfterMs: 3_600_000 })]);

		await harness.session.prompt("do the task");
		await harness.session.waitForIdle();

		expect(harness.session.isQuotaParked).toBe(true);
		// The parked turn is a pause, not the child's death: no terminal notice.
		expect(sendAgentMessage).not.toHaveBeenCalled();
	});

	it("queues a recovery turn after a bounded-wait abort and reports the real ping count", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		const harness = await createHarness({
			rlmDepth: 1,
			settings: waitSettings({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 2, maxWaitMs: 10_000 }),
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			quotaFailure(),
			quotaFailure(),
			// The third ping exceeds maxAttempts: the wait aborts.
			quotaFailure(),
			// The recovery turn the wait-abort queued gets a non-retryable failure,
			// so the episode reaches its terminal notice.
			lifecycleFailureMessage("lifecycle failed"),
		]);

		await harness.session.prompt("do the task");
		await harness.session.waitForIdle();

		// 3 pings + the recovery turn.
		expect(harness.faux.state.callCount).toBe(4);
		expect(providerFailureRecoveries(harness)).toHaveLength(1);
		expect(sendAgentMessage).toHaveBeenCalledTimes(1);
		const notice = sendAgentMessage.mock.calls[0][0] as { message: string };
		// Two recovery pings ran before the wait gave up; the notice must not claim
		// "no retries attempted".
		expect(notice.message).toContain("auto-retry stopped after 2 attempt(s)");
		expect(harness.session.isQuotaParked).toBe(false);
	});

	it("queues a recovery turn when the quota wait aborts and the recovery succeeds", async () => {
		const harness = await createHarness({
			settings: waitSettings({ baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 2, maxWaitMs: 10_000 }),
		});
		harnesses.push(harness);
		harness.setResponses([
			quotaFailure(),
			quotaFailure(),
			quotaFailure(),
			fauxAssistantMessage("picked the work back up"),
		]);

		await harness.session.prompt("do the task");
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(4);
		expect(providerFailureRecoveries(harness)).toHaveLength(1);
		expect(getAssistantTexts(harness).at(-1)).toBe("picked the work back up");
		expect(harness.session.isRetrying).toBe(false);
	});
});
