/**
 * A retry chain closed by an overflow-compaction handoff is not a failure, and it
 * must leave no terminal-failure attempt count behind (review 2026-10-04, domain 1
 * should-1). The handoff wrote `_terminalFailureAttemptCount = _retryAttempt` while
 * the only clear required `_retryAttempt > 0` - which the handoff itself had just
 * zeroed - so a later non-retryable terminal error read the stale count and told
 * the parent "auto-retry stopped after N attempt(s)" for a failure that was never
 * retried.
 *
 * Red at HEAD: the parent notice read "auto-retry stopped after 1 attempt(s)".
 */
import type { Context } from "@earendil-works/pi-ai";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFamilyRosterResult, AgentSessionMessageReceipt } from "../../../src/core/agent-messages.js";
import { SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX } from "../../../src/core/agent-messages.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

/** 250k chars measure ~62.5k estimated tokens: over a 0.5 trigger on a 100k window. */
const FILL_OUTPUT = `FILL-MARKER-handoff-count${"x".repeat(250_000)}`;

function fillTool() {
	return {
		name: "fill",
		label: "fill",
		description: "returns a large body",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: FILL_OUTPUT }], details: {} }),
	};
}

const retryableError = (): AssistantMessage =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

const overflowError = (): AssistantMessage =>
	fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "prompt is too long: 200000 tokens > 100000 maximum",
	});

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
		current: { name: "handoff-child", id: "child-session-id", depth: 1 },
		entries: [
			{ relationship: "parent", name: "parent-session", id: "parent-session-id", depth: 0, status: "running" },
		],
	};
}

function receiptFor(message: string): AgentSessionMessageReceipt {
	return {
		id: "agentmsg_handoff_count",
		source: "agent_message",
		target: { activeSessionId: "parent-active", sessionId: "parent-session-id" },
		message,
		deliveryStatus: "delivered",
	};
}

describe("terminal retry count after a compaction handoff", () => {
	it("reports no retries for a non-retryable terminal error that follows a compaction handoff", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		const harness = await createHarness({
			rlmDepth: 1,
			tools: [fillTool()],
			settings: {
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
				compaction: { enabled: false, reserveTokens: 500, keepRecentTokens: 1, triggerRatio: 0.5 },
			},
			models: [{ id: "faux-1", contextWindow: 100_000 }],
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);

		const summarizationMarker = "context summarization assistant";
		const mainScript: AssistantMessage[] = [
			fauxAssistantMessage(fauxToolCall("fill", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("fill noted"),
			retryableError(),
			overflowError(),
			fauxAssistantMessage("finally done"),
			lifecycleFailureMessage("permanent lifecycle failure"),
		];
		// One factory per expected call; summarization calls never consume the script.
		// Responses are stamped at serve time: a prebuilt message carries its
		// construction time, which would read as "before the compaction" and skip
		// the overflow check.
		const step = (context: Context) => {
			if (context.systemPrompt?.includes(summarizationMarker)) {
				return fauxAssistantMessage("## Goal\nEarlier work summarized.");
			}
			const next = mainScript.shift();
			if (!next) throw new Error("no scripted answer left");
			return { ...next, timestamp: Date.now() };
		};
		harness.setResponses([step, step, step, step, step, step, step, step, step]);

		await harness.session.prompt("fill the context");
		harness.session.setAutoCompactionEnabled(true);
		await harness.session.prompt("keep going");
		await vi.waitFor(
			() => {
				expect(getAssistantTexts(harness)).toContain("finally done");
			},
			{ timeout: 5_000, interval: 20 },
		);
		await harness.session.waitForIdle();
		// The chain mid-retry was handed to the overflow compaction: a non-failure
		// close, after which no retry chain is live.
		expect(harness.eventsOfType("auto_retry_end").some((event) => event.supersededByCompaction === true)).toBe(true);

		await harness.session.promptAndWait("now fail without a retryable cause");

		expect(sendAgentMessage).toHaveBeenCalledTimes(1);
		const notice = (sendAgentMessage.mock.calls[0]![0] as { message: string }).message;
		expect(notice).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		expect(notice).toContain("permanent lifecycle failure");
		expect(notice).toContain("error classified as non-retryable; no retries attempted");
		expect(notice).not.toContain("auto-retry stopped after");
	});
});
