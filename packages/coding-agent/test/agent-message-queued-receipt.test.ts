/**
 * P0-3a: a queued send is a fact the sender can act on, and only a delivered
 * reply counts as a reply.
 *
 * Red at HEAD: an agent message aimed at a suspended session threw
 * "Cannot admit a session action while queued session input is suspended." (the
 * sending model read that as "cannot be sent"), the receipt had no reason or
 * repeat information, and the subagent reply counter incremented on any receipt -
 * which, once queueing replaced the throw, would have marked an undelivered reply
 * as delivered (B1/N-1 double silence).
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyRosterResult,
	type AgentSessionMessagePayload,
	type AgentSessionMessageReceipt,
	assertAgentMessageQueueCapacity,
	countsAsDeliveredParentReply,
	createAgentSessionMessageReceipt,
	formatAgentMessageQueuedNotice,
	formatAgentMessageRetryExhaustedError,
	isChildReplyToThisSession,
	isRetryableAgentMessageSendError,
	QUEUED_PARENT_REPLY_BACKFILL_LIMIT,
	QueuedParentReplyBackfills,
	SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX,
} from "../src/core/agent-messages.js";
import { SessionInputSuspendedError } from "../src/core/prompt-admission.js";
import { createHarness, type Harness } from "./suite/harness.js";

function makePayload(id = "agentmsg_receipt"): AgentSessionMessagePayload {
	return {
		id,
		source: AGENT_MESSAGE_SOURCE,
		message: "the child's answer",
		from: { activeSessionId: "child-active", sessionId: "child-session", sessionName: "Child" },
		target: { activeSessionId: "parent-active", sessionId: "parent-session", sessionName: "Parent" },
	};
}

function parentRoster(): AgentFamilyRosterResult {
	return {
		current: { name: "child", id: "child-session", depth: 1 },
		entries: [{ relationship: "parent", name: "parent-session", id: "parent-session", depth: 0, status: "running" }],
	};
}

describe("P0-3a queued agent-message receipts", () => {
	it("carries the reason, position, repeat count and an actionable notice when queued", () => {
		const receipt = createAgentSessionMessageReceipt(makePayload(), "queued", "2026-09-11T00:00:00.000Z", {
			reason: "target_suspended",
			position: 3,
			repeatCount: 2,
			notice: "Queued, NOT delivered: the target session is suspended",
		});
		expect(receipt).toMatchObject({
			deliveryStatus: "queued",
			queuedAt: "2026-09-11T00:00:00.000Z",
			queuedReason: "target_suspended",
			queuedPosition: 3,
			queuedRepeatCount: 2,
		});
		expect(receipt.queuedNotice).toContain("Queued, NOT delivered");
		expect(receipt.deliveredAt).toBeUndefined();
	});

	it("keeps a delivered receipt free of queued-only fields", () => {
		const receipt = createAgentSessionMessageReceipt(makePayload(), "delivered", "2026-09-11T00:00:00.000Z", {
			reason: "target_suspended",
			position: 3,
			repeatCount: 2,
			notice: "must not leak onto a delivered receipt",
		});
		expect(receipt.deliveredAt).toBe("2026-09-11T00:00:00.000Z");
		expect(receipt.queuedAt).toBeUndefined();
		expect(receipt.queuedReason).toBeUndefined();
		expect(receipt.queuedNotice).toBeUndefined();
	});

	it("states the consequence and the retry ceiling on the first queued send", () => {
		const notice = formatAgentMessageQueuedNotice({
			reason: "target_suspended",
			position: 3,
			maxPending: 20,
			repeatCount: 1,
		});
		expect(notice).toContain("Queued, NOT delivered");
		expect(notice).toContain("suspended");
		expect(notice).toContain("Position 3/20");
		expect(notice).toContain("Do not retry immediately");
		expect(notice).toContain("not lost");
		expect(notice).toContain("write your result to a file");
		// A first queue is not yet a pattern: no false "still unread" claim.
		expect(notice).not.toContain("still unread");
	});

	it("tells the sender the previous queued message is still unread from the second time on", () => {
		const notice = formatAgentMessageQueuedNotice({
			reason: "target_suspended",
			position: 4,
			maxPending: 20,
			repeatCount: 2,
			previousQueuedSecondsAgo: 145,
		});
		expect(notice).toContain("2nd time in a row");
		expect(notice).toContain("still unread");
		expect(notice).toContain("145s ago");
	});

	it("classifies retryable send failures so the retry budget can be bounded", () => {
		const retryable = [
			"Target session has too many pending messages: 20 unfinished, limit is 20",
			"Agent messaging rate limit exceeded; retry after 900ms",
			"Cannot admit a session action while queued session input is suspended.",
			"Agent message was not accepted",
		];
		expect(retryable.length).toBeGreaterThan(0);
		for (const message of retryable) expect(isRetryableAgentMessageSendError(message), message).toBe(true);
		// Terminal shapes must stay terminal, or the budget would hide a real error.
		expect(isRetryableAgentMessageSendError("Unknown active session: nope")).toBe(false);
		expect(isRetryableAgentMessageSendError("Agent messaging cannot target the sending session")).toBe(false);
	});

	it("writes a terminal error that forbids another retry", () => {
		const error = formatAgentMessageRetryExhaustedError({
			target: "parent-session",
			attempts: 3,
			lastError: "rate limit exceeded",
		});
		expect(error).toContain("3 times in a row");
		expect(error).toContain("terminal, not retryable");
		expect(error).toContain("do not call agent_message.send again");
		expect(error).toContain("Nothing was delivered");
	});

	it("keeps the queue-full refusal actionable about loss", () => {
		let message = "";
		try {
			assertAgentMessageQueueCapacity(20, 20);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		// Legacy substring kept so existing callers and transcripts still match.
		expect(message).toContain("Target session has too many pending messages");
		expect(message).toContain("NOT queued and NOT delivered");
		expect(message).toContain("nothing was lost");
		expect(message).toContain("Do not retry immediately");
	});

	it("counts only a delivered receipt as a reply to the parent (B1)", () => {
		const cases = [
			{ input: { rlmDepth: 1, deliveryStatus: "queued" as const, addressedParent: true }, expected: false },
			{ input: { rlmDepth: 1, deliveryStatus: "delivered" as const, addressedParent: true }, expected: true },
			{ input: { rlmDepth: 1, deliveryStatus: "delivered" as const, addressedParent: false }, expected: false },
			{ input: { rlmDepth: 0, deliveryStatus: "delivered" as const, addressedParent: true }, expected: false },
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			expect(countsAsDeliveredParentReply(testCase.input), JSON.stringify(testCase.input)).toBe(testCase.expected);
		}
	});

	it("describes suspension as a typed error that says whether retrying can help", () => {
		const fenced = new SessionInputSuspendedError({ queuedActionCount: 2, suspendedForUpdateRestart: true });
		expect(fenced.message).toContain("Cannot admit a session action while queued session input is suspended.");
		expect(fenced.message).toContain("update-restart fence");
		expect(fenced.retryable).toBe(false);
		expect(fenced.queuedActionCount).toBe(2);

		const parked = new SessionInputSuspendedError({ queuedActionCount: 0, suspendedForUpdateRestart: false });
		expect(parked.message).toContain("Cannot admit a session action while queued session input is suspended.");
		expect(parked.retryable).toBe(true);
		expect(parked.name).toBe("SessionInputSuspendedError");
	});
});

describe("P0-3a subagent terminal-error notice delivery accounting", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function runChildWithReceipt(deliveryStatus: "delivered" | "queued"): Promise<Harness> {
		const receipt: AgentSessionMessageReceipt = {
			id: "agentmsg_terminal",
			source: AGENT_MESSAGE_SOURCE,
			target: { activeSessionId: "parent-active", sessionId: "parent-session" },
			message: "",
			deliveryStatus,
		};
		const sendAgentMessage = vi.fn(async (input: { message: string }) => ({ ...receipt, message: input.message }));
		const harness = await createHarness({
			rlmDepth: 1,
			settings: { retry: { enabled: false } },
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: async () => parentRoster(),
				sendAgentMessage,
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		await harness.session.promptAndWait("fail terminally");
		expect(sendAgentMessage).toHaveBeenCalledOnce();
		expect(sendAgentMessage.mock.calls[0]?.[0]?.message).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		return harness;
	}

	it("does not mark a queued terminal-error notice as replied", async () => {
		const harness = await runChildWithReceipt("queued");
		// Red once queueing replaces the throw: a queued receipt is not a delivery,
		// and counting it would suppress the parent's own synthesized notice.
		expect(harness.session.repliedToParentSinceTask).not.toBe(true);
	});

	it("marks a delivered terminal-error notice as replied", async () => {
		const harness = await runChildWithReceipt("delivered");
		expect(harness.session.repliedToParentSinceTask).toBe(true);
	});
});

describe("queued child reply delivery credit", () => {
	it("recognizes only a child's reply that names its sender session", () => {
		const cases = [
			{ input: { fromRelationship: "child" as const, senderSessionId: "child-session" }, expected: true },
			{ input: { fromRelationship: "parent" as const, senderSessionId: "parent-session" }, expected: false },
			{ input: { fromRelationship: "sibling" as const, senderSessionId: "sibling-session" }, expected: false },
			{ input: { fromRelationship: undefined, senderSessionId: "unknown-session" }, expected: false },
			{ input: { fromRelationship: "child" as const, senderSessionId: undefined }, expected: false },
			{ input: { fromRelationship: "child" as const, senderSessionId: "   " }, expected: false },
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			expect(isChildReplyToThisSession(testCase.input), JSON.stringify(testCase.input)).toBe(testCase.expected);
		}
	});

	it("hands a queued reply's sender out exactly once", () => {
		const backfills = new QueuedParentReplyBackfills();
		expect(backfills.size).toBe(0);
		backfills.register("agentmsg_reply", "child-session");
		expect(backfills.size).toBe(1);
		// The credit is one event: a second delivery report for the same id, or a
		// direct delivery that was never queued, must not count the reply again.
		expect(backfills.take("agentmsg_reply")).toBe("child-session");
		expect(backfills.size).toBe(0);
		expect(backfills.take("agentmsg_reply")).toBeUndefined();
		expect(backfills.take("agentmsg_never_queued")).toBeUndefined();
	});

	it("keeps two queued replies from two children apart", () => {
		const backfills = new QueuedParentReplyBackfills();
		backfills.register("agentmsg_first", "child-a");
		backfills.register("agentmsg_second", "child-b");
		expect(backfills.size).toBe(2);
		expect(backfills.take("agentmsg_second")).toBe("child-b");
		expect(backfills.take("agentmsg_first")).toBe("child-a");
		expect(backfills.size).toBe(0);
	});

	it("refreshes an id registered twice instead of duplicating it", () => {
		const backfills = new QueuedParentReplyBackfills();
		backfills.register("agentmsg_reply", "child-a");
		backfills.register("agentmsg_reply", "child-b");
		expect(backfills.size).toBe(1);
		expect(backfills.take("agentmsg_reply")).toBe("child-b");
	});

	it("evicts the oldest pending credit at the limit", () => {
		const backfills = new QueuedParentReplyBackfills(2);
		backfills.register("agentmsg_1", "child-1");
		backfills.register("agentmsg_2", "child-2");
		backfills.register("agentmsg_3", "child-3");
		expect(backfills.size).toBe(2);
		expect(backfills.take("agentmsg_1"), "the evicted id must not credit anyone").toBeUndefined();
		expect(backfills.take("agentmsg_2")).toBe("child-2");
		expect(backfills.take("agentmsg_3")).toBe("child-3");
		expect(QUEUED_PARENT_REPLY_BACKFILL_LIMIT).toBeGreaterThan(2);
	});

	it("drops only one sender's credits at a run boundary", () => {
		const backfills = new QueuedParentReplyBackfills();
		backfills.register("agentmsg_old_run", "child-a");
		backfills.register("agentmsg_second_old", "child-a");
		backfills.register("agentmsg_other_child", "child-b");
		// A stale credit is one the previous run's verdict already answered: it must
		// not be able to make the next run look replied.
		expect(backfills.discardForSender("child-a")).toBe(2);
		expect(backfills.size).toBe(1);
		expect(backfills.take("agentmsg_old_run")).toBeUndefined();
		expect(backfills.take("agentmsg_other_child")).toBe("child-b");
		expect(backfills.discardForSender("child-unknown")).toBe(0);
	});

	it("drops every pending credit on clear", () => {
		const backfills = new QueuedParentReplyBackfills();
		backfills.register("agentmsg_reply", "child-session");
		backfills.clear();
		expect(backfills.size).toBe(0);
		expect(backfills.take("agentmsg_reply")).toBeUndefined();
	});
});
