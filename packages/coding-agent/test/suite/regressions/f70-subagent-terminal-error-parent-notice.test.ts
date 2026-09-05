import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentFamilyRosterResult, AgentSessionMessageReceipt } from "../../../src/core/agent-messages.js";
import { SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX } from "../../../src/core/agent-messages.js";
import { createHarness, type Harness } from "../harness.js";

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
		id: "agentmsg_terminal_test",
		source: "agent_message",
		target: { activeSessionId: "parent-active", sessionId: "parent-session-id" },
		message,
		deliveryStatus: "delivered",
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

interface TerminalNoticeExpectation {
	sendAgentMessage: ReturnType<typeof vi.fn>;
}

function lastTerminalNotice(spy: TerminalNoticeExpectation["sendAgentMessage"]): string {
	expect(spy).toHaveBeenCalledTimes(1);
	const input = spy.mock.calls[0][0] as { target: string; message: string; receiverRole?: string };
	return input.message;
}

describe("F70 subagent terminal error notifies the parent", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("notifies the parent with an error summary and terminal marker when a non-retryable error ends the turn", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		const harness = await createHarness({
			rlmDepth: 1,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);

		const errorMessage =
			'Failed to resolve API key for provider "grok-cli" from shell command: jq -r \'to_entries[0].value.key\' "$HOME/.grok/auth.json"';
		harness.setResponses([lifecycleFailureMessage(errorMessage)]);

		await harness.session.promptAndWait("do the task");

		const input = sendAgentMessage.mock.calls[0][0] as { target: string; message: string; receiverRole?: string };
		expect(input.target).toBe("parent-session");
		expect(input.receiverRole).toBe("parent");
		expect(input.message).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		expect(input.message).toContain("Failed to resolve API key");
		expect(input.message).toContain("error classified as non-retryable; no retries attempted");
		// The exec-ext class failure is never retried, so the faux provider saw exactly one call.
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("notifies the parent after retries are exhausted and reports the attempt count", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		const harness = await createHarness({
			rlmDepth: 1,
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await harness.session.promptAndWait("do the task");

		const notice = lastTerminalNotice(sendAgentMessage);
		expect(notice).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		expect(notice).toContain("overloaded_error");
		expect(notice).toContain("auto-retry exhausted after 2 attempt(s)");
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("keeps retryable errors on the existing retry path without notifying the parent", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		const harness = await createHarness({
			rlmDepth: 1,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.promptAndWait("do the task");

		expect(sendAgentMessage).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.eventsOfType("auto_retry_end")[0]).toMatchObject({ success: true });
	});

	it("notifies immediately when auto-retry is disabled for an otherwise retryable error", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		const harness = await createHarness({
			rlmDepth: 1,
			settings: { retry: { enabled: false, maxRetries: 3, baseDelayMs: 1 } },
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		await harness.session.promptAndWait("do the task");

		const notice = lastTerminalNotice(sendAgentMessage);
		expect(notice).toContain("auto-retry disabled; no retries attempted");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("does not notify for root sessions without a parent", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		const harness = await createHarness({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => ({ current: { name: "root", id: "root-id", depth: 0 }, entries: [] }),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);

		harness.setResponses([lifecycleFailureMessage("permanent failure")]);

		await harness.session.promptAndWait("do the task");

		expect(sendAgentMessage).not.toHaveBeenCalled();
	});

	it("suppresses the synthesized completed_without_reply notice when the terminal error notice was delivered", async () => {
		const sendAgentMessage = vi.fn(async (input: { message: string }) => receiptFor(input.message));
		const child = await createHarness({
			rlmDepth: 1,
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(child);
		const parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		harnesses.push(parent);

		child.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		await parent.session.runRlmChild("do the task", { name: "failing-child" });

		await expect.poll(() => parent.session.hasRunningRlmChildren(), { timeout: 10_000 }).toBe(false);

		// The child told the parent about the terminal error itself...
		const notice = lastTerminalNotice(sendAgentMessage);
		expect(notice).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		// ...so the misleading "completed without sending a reply" notice must not follow.
		const terminalNotices = parent.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
		);
		expect(terminalNotices).toHaveLength(0);
	});
});
