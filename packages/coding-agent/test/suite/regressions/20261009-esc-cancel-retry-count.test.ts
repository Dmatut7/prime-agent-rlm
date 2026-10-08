/**
 * A retry chain cancelled by Esc in the countdown is not a failure, and it must
 * leave no terminal-failure attempt count behind (2026-10-09 review, section 9
 * item 1). The sleep-catch path in `_retryAfterDelay` wrote
 * `_terminalFailureAttemptCount = attempt` for the cancelled chain, while
 * abortRetry's controller path returns before its own clear - so a later
 * non-retryable terminal error read the stale count and told the parent
 * "auto-retry stopped after N attempt(s)" for a failure that was never retried.
 * 074f9a9f0 ruled the same shape for the compaction handoff: clear, don't carry.
 *
 * Red at HEAD: the parent notice read "auto-retry stopped after 1 attempt(s)".
 */
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFamilyRosterResult, AgentSessionMessageReceipt } from "../../../src/core/agent-messages.js";
import { SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX } from "../../../src/core/agent-messages.js";
import { createHarness, type Harness } from "../harness.js";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

const retryableError = (): AssistantMessage =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

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

function parentRoster(): AgentFamilyRosterResult {
	return {
		current: { name: "esc-cancel-child", id: "child-session-id", depth: 1 },
		entries: [
			{ relationship: "parent", name: "parent-session", id: "parent-session-id", depth: 0, status: "running" },
		],
	};
}

function receiptFor(message: string): AgentSessionMessageReceipt {
	return {
		id: "agentmsg_esc_cancel",
		source: "agent_message",
		target: { activeSessionId: "parent-active", sessionId: "parent-session-id" },
		message,
		deliveryStatus: "delivered",
	};
}

describe("terminal retry count after an Esc-cancelled retry countdown", () => {
	it("reports no retries for a non-retryable terminal error that follows a cancelled retry chain", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		// The backoff is long enough that abortRetry lands inside the sleep window,
		// which is the window whose catch path carried the cancelled chain's count.
		const harness = await createHarness({
			rlmDepth: 1,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 60_000 } },
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);

		harness.setResponses([retryableError(), lifecycleFailureMessage("permanent lifecycle failure")]);

		const sawRetryStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start a retry chain");
		await sawRetryStart;
		expect(harness.session.isRetrying).toBe(true);
		harness.session.abortRetry();
		await promptPromise;
		expect(harness.faux.state.callCount).toBe(1);

		await harness.session.promptAndWait("now fail without a retryable cause");

		// The aborted turn itself reports the cancelled chain's error to the parent;
		// the second call is the later non-retryable failure whose retry status must
		// not inherit the cancelled chain's attempt count.
		expect(sendAgentMessage).toHaveBeenCalledTimes(2);
		const notice = (sendAgentMessage.mock.calls[1]![0] as { message: string }).message;
		expect(notice).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		expect(notice).toContain("permanent lifecycle failure");
		expect(notice).toContain("error classified as non-retryable; no retries attempted");
		expect(notice).not.toContain("auto-retry stopped after");
	});
});
