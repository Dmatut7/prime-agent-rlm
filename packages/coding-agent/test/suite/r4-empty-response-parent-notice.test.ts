import { EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFamilyRosterResult, AgentSessionMessageReceipt } from "../../src/core/agent-messages.js";
import { SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX } from "../../src/core/agent-messages.js";
import { EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE } from "../../src/core/messages.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * r4 recovery, K3 ①-C: the subagent terminal-error notice must report the empty-response
 * ladder's real attempt counts. The old text said "error classified as non-retryable; no
 * retries attempted" for a class the loop had just retried six times - a parent reading
 * "no retries" acts on the wrong lever.
 */

function parentRoster(): AgentFamilyRosterResult {
	return {
		current: { name: "failing-child", id: "child-session-id", depth: 1 },
		entries: [
			{ relationship: "parent", name: "parent-session", id: "parent-session-id", depth: 0, status: "running" },
		],
	};
}

function receiptFor(message: string): AgentSessionMessageReceipt {
	return {
		id: "agentmsg_empty_response_test",
		source: "agent_message",
		target: { activeSessionId: "parent-active", sessionId: "parent-session-id" },
		message,
		deliveryStatus: "delivered",
	};
}

function exhaustedEmptyTurn(
	details: {
		attempts?: number;
		waitedMs?: number;
		escalatedAttempts?: number;
		escalatedWaitedMs?: number;
		terminatedBy?: string;
	} = {},
): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage:
				"Model returned an empty response 6 times in a row: the provider answered 6 times with no output content or tool calls.",
		}),
		stopReasonRaw: "empty_response_retry_exhausted",
		diagnostics: [
			{
				type: EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE,
				timestamp: Date.now(),
				details: {
					attempts: 6,
					waitedMs: 211_500,
					escalatedAttempts: 3,
					escalatedWaitedMs: 210_000,
					fastWaitedMs: 1_500,
					terminatedBy: "attempts",
					...details,
				},
			},
		],
	};
}

function terminalNoticeSpy() {
	return vi.fn(async (input: { message: string }) => receiptFor(input.message));
}

describe("empty-response terminal notice reports the real ladder facts", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("replaces the no-retries misreport with the ladder's own counts", async () => {
		const sendAgentMessage = terminalNoticeSpy();
		const harness = await createHarness({
			rlmDepth: 1,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					emptyTurn: { escalatedAttempts: 0, recovery: { enabled: false } },
				},
			},
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);

		harness.setResponses([exhaustedEmptyTurn()]);
		await harness.session.promptAndWait("do the task");

		expect(sendAgentMessage).toHaveBeenCalledTimes(1);
		const input = sendAgentMessage.mock.calls[0][0] as { target: string; message: string };
		expect(input.message).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		expect(input.message).toContain("empty-response ladder exhausted after 6 in-place provider attempt(s)");
		expect(input.message).toContain("3 in the slow tier");
		expect(input.message).toContain("waited 212s");
		expect(input.message).toContain("stopped by attempts");
		// The misreport this replaces.
		expect(input.message).not.toContain("no retries attempted");
	});

	it("dispatches the recovery turn when the empty ladder exhausted inside a retry run (no isRetrying deadlock)", async () => {
		// K3 deep review, must-1: a retryable error arms the session retry chain, the
		// retry run then ends with the empty ladder exhausted, and the recovery turn is
		// admitted. The retry promise must resolve BEFORE the early return, or
		// isRetrying stays true, the pump gate blocks the admitted recovery turn, and
		// the session deadlocks (no third provider call, promptAndWait never settles,
		// and a child has no Esc escape). This sequence - 5xx and empty responses
		// interleaved - is exactly the incident window the feature targets.
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1, emptyTurn: { escalatedAttempts: 0 } } },
		});
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			exhaustedEmptyTurn(),
			fauxAssistantMessage("recovered after the recovery turn"),
		]);

		await harness.session.promptAndWait("do the task");

		// The retry chain armed and finished, and the recovery turn actually ran:
		// three provider calls - the failing run, the retry run, the recovery turn.
		// The recovery dispatch is a scheduled pump hop after the retry chain settles.
		// Blind-2, high: the FAILED retry chain must close its ledger here - a
		// success:false end event, no false success:true credited to it later, and
		// nothing left on the books for the next chain to inherit.
		expect(retryEvents).toContain("start:1");
		expect(retryEvents).toContain("end:false");
		expect(retryEvents.filter((e) => e === "end:true")).toHaveLength(0);
		expect(harness.session.isRetrying).toBe(false);
		await vi.waitFor(
			() => {
				expect(harness.faux.state.callCount).toBe(3);
			},
			{ timeout: 5_000, interval: 20 },
		);
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "custom" &&
					(message as { customType?: string }).customType === EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE,
			),
		).toBe(true);
		const last = [...harness.session.messages].reverse().find((m) => m.role === "assistant");
		const lastText = ((last as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [])
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("");
		expect(lastText).toContain("recovered after the recovery turn");
	});

	it("counts the recovery continuations that already failed when it reports the terminal", async () => {
		const sendAgentMessage = terminalNoticeSpy();
		const harness = await createHarness({
			rlmDepth: 1,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					emptyTurn: { escalatedAttempts: 0 },
				},
			},
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);

		// Episode: exhausted, one recovery continuation, exhausted again -> terminal.
		harness.setResponses([
			exhaustedEmptyTurn(),
			exhaustedEmptyTurn({ attempts: 12, waitedMs: 423_000, terminatedBy: "request_budget" }),
		]);
		await harness.session.promptAndWait("do the task");
		await harness.session.waitForIdle();

		expect(sendAgentMessage).toHaveBeenCalledTimes(1);
		const notice = (sendAgentMessage.mock.calls[0][0] as { message: string }).message;
		expect(notice).toContain("empty-response ladder exhausted after 12 in-place provider attempt(s)");
		expect(notice).toContain("stopped by request_budget");
		expect(notice).toContain("plus 1 recovery continuation(s) that also came back empty");
	});
});
