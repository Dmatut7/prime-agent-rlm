/**
 * A terminal verdict is a snapshot; the notice carrying it is published later.
 *
 * Red at HEAD (b41c93eb2): the no-reply verdict is decided the moment a child run
 * settles, but the notice that carries it is a follow-up action, so a busy parent
 * publishes it when its queue finally drains - a median of 19 minutes later in
 * production, and after the very reply the notice calls missing has been read.
 * The delivery credit added by f567654a8 lands in that gap and changes nothing,
 * because the verdict was already recorded: 18 of the 21 `completed_without_reply`
 * notices in one production day were false, and the parent read each of them below
 * the reply it contradicted.
 *
 * The fix re-validates at publication, not at classification:
 * `run.terminalKind` and `collectRlmChildren` keep reporting the verdict as it was
 * taken (B1: a queued reply is still not a delivered one), and a notice is dropped
 * only when the fact it asserts has been disproved by something the parent has
 * already been handed. A reply that is cleared instead of delivered still reports.
 *
 * The delivery leg here is the daemon's, minus the daemon: replies go through
 * `acceptAgentMessagePrompt` with the options `acceptAgentSessionMessage` uses, so
 * `queued` / `delivered` are the real ones.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyRosterResult,
	type AgentSessionMessage,
	type AgentSessionMessagePayload,
	type AgentSessionMessageReceipt,
	createAgentSessionMessage,
	createAgentSessionMessageId,
	isAgentSessionMessage,
	SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX,
} from "../../../src/core/agent-messages.js";
import type { AgentSession } from "../../../src/core/agent-session.js";
import {
	type CustomMessage,
	createRlmChildTerminalNoticeMessage,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
} from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

function customMessages(session: AgentSession, customType: string): CustomMessage[] {
	return session.messages.filter(
		(message): message is CustomMessage => message.role === "custom" && message.customType === customType,
	);
}

function terminalNotices(session: AgentSession): CustomMessage[] {
	return customMessages(session, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE);
}

function failureNotices(session: AgentSession): CustomMessage[] {
	return customMessages(session, RLM_CHILD_FAILURE_CUSTOM_TYPE);
}

function deliveredReplyIds(messages: readonly AgentMessage[]): string[] {
	return messages
		.filter((message): message is AgentSessionMessage => isAgentSessionMessage(message))
		.map((message) => message.details.id);
}

/**
 * The daemon's delivery leg: hand a child's message to the receiving session and
 * report the delivery status its sender saw on the receipt.
 */
async function deliverChildMessage(
	receiver: AgentSession,
	message: AgentSessionMessage,
): Promise<"delivered" | "queued"> {
	let accepted = true;
	let queued = false;
	await receiver.acceptAgentMessagePrompt(message.content as string, {
		expandPromptTemplates: false,
		streamingBehavior: "steer",
		queueIfBusy: true,
		customMessage: message,
		preflightResult: (success, didQueue) => {
			accepted = success;
			queued = success && didQueue === true;
		},
	});
	if (!accepted) throw new Error("the receiving session refused the child message");
	return queued ? "queued" : "delivered";
}

function childMessage(child: AgentSession, parent: AgentSession, message: string): AgentSessionMessage {
	const payload: AgentSessionMessagePayload = {
		id: createAgentSessionMessageId(),
		source: AGENT_MESSAGE_SOURCE,
		message,
		from: {
			activeSessionId: "child-active",
			sessionId: child.sessionId,
			sessionName: child.sessionName ?? "worker",
		},
		fromRelationship: "child",
		target: {
			activeSessionId: "parent-active",
			sessionId: parent.sessionId,
			sessionName: "parent",
		},
	};
	return createAgentSessionMessage(payload);
}

async function waitForCondition(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function hangTool(gate: Promise<void>): AgentTool {
	return {
		name: "hold_the_turn",
		label: "Hold the turn",
		description: "Keeps this session busy until the test releases it",
		parameters: Type.Object({}),
		execute: async () => {
			await gate;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
}

describe("a terminal notice published after its verdict went stale", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function track(harness: Harness): Harness {
		harnesses.push(harness);
		return harness;
	}

	interface Family {
		parent: Harness;
		child: Harness;
		releaseParent: () => void;
		/** Delivery status the child's message got, recorded by the child's own tool. */
		deliveryStatuses: string[];
		messageIds: string[];
		parentTurn: Promise<void>;
	}

	/**
	 * A parent stuck in a tool call (so it queues instead of delivering) and a child
	 * whose turn sends one message through the daemon's delivery leg.
	 *
	 * `route` is how the message reaches the parent's queue: `accept` is the live
	 * daemon leg, `restore` is the recovery leg a restart uses (a persisted queue
	 * entry re-admitted without a sender on the other end), which is the wire that
	 * used to lose the owed credit silently.
	 */
	async function makeFamily(options: { route?: "accept" | "restore" | "pending" } = {}): Promise<Family> {
		const route = options.route ?? "accept";
		const family: { parent?: Harness; child?: Harness } = {};
		const deliveryStatuses: string[] = [];
		const messageIds: string[] = [];
		let releaseParent: () => void = () => {};
		const parentGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});

		const replyToParent: AgentTool = {
			name: "reply_to_parent",
			label: "Reply to parent",
			description: "Sends this child's reply to its parent",
			parameters: Type.Object({}),
			execute: async () => {
				const parent = family.parent?.session;
				const child = family.child?.session;
				if (!parent || !child) throw new Error("the family is not wired yet");
				const reply = childMessage(child, parent, "the audit is finished: three findings");
				messageIds.push(reply.details.id);
				if (route === "restore") {
					// The recovery leg: a queued reply re-admitted from a persisted queue.
					await parent.restoreSteeringMessage(reply.content as string, undefined, {
						agentMessageId: reply.details.id,
						customMessage: reply,
					});
					deliveryStatuses.push("queued");
				} else if (route === "pending") {
					// The daemon's restore_next_turn leg: not an action, so the reply rides
					// into whichever turn starts next as next-turn context.
					parent.restorePendingNextTurnMessages([reply]);
					deliveryStatuses.push("queued");
				} else {
					deliveryStatuses.push(await deliverChildMessage(parent, reply));
				}
				return { content: [{ type: "text", text: "reply sent" }], details: {} };
			},
		};

		const child = track(
			await createHarness({
				tools: [replyToParent],
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				agentMessageController: {
					listAgents: () => ({ agents: [] }),
					sendAgentMessage: vi.fn(async () => {
						throw new Error("synthesized terminal notices must not use agent_message");
					}),
				},
			}),
		);
		const parent = track(
			await createHarness({
				tools: [hangTool(parentGate)],
				rlmDepth: 0,
				rlmMaxDepth: 1,
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		family.parent = parent;
		family.child = child;

		parent.setResponses([
			fauxAssistantMessage(fauxToolCall("hold_the_turn", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the long parent turn finished"),
			fauxAssistantMessage("the parent read what was queued"),
			fauxAssistantMessage("the parent is idle again"),
			fauxAssistantMessage("the parent stays idle"),
		]);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("reply_to_parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the child finished after replying"),
			fauxAssistantMessage("the child finished a second, silent task"),
		]);

		// The parent is mid-turn for the whole child run, which is what makes the
		// reply queue instead of delivering.
		const parentTurn = parent.session.promptAndWait("do the long work");
		await waitForCondition(() => parent.session.isStreaming);
		return { parent, child, releaseParent, deliveryStatuses, messageIds, parentTurn };
	}

	/** Let the parent drain everything it holds and come to rest. */
	async function drainParent(family: Family): Promise<void> {
		family.releaseParent();
		await family.parentTurn;
		await vi.waitFor(
			() => {
				expect(family.parent.session.isStreaming).toBe(false);
				expect(family.parent.session.unfinishedActionCount).toBe(0);
			},
			{ timeout: 20_000, interval: 20 },
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	it("does not publish a no-reply notice for a reply the parent read first", async () => {
		const family = await makeFamily();
		const handle = await family.parent.session.runRlmChild("audit and reply", { name: "stale-verdict-worker" });
		await vi.waitFor(() => expect(family.deliveryStatuses).toEqual(["queued"]), { timeout: 15_000, interval: 20 });

		// The child settles with its reply still queued. The verdict is taken now, and
		// it stays taken: `collectRlmChildren` keeps reporting what was decided.
		const atSettle = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(atSettle.results[0]?.terminal_kind).toBe("completed_without_reply");
		expect(atSettle.results[0]?.replied_since_task).not.toBe(true);

		await drainParent(family);

		// The reply the notice calls missing is in the parent's own transcript, once.
		const landed = deliveredReplyIds(family.parent.session.messages).filter((id) => id === family.messageIds[0]);
		expect(landed).toHaveLength(1);
		// HEAD published the notice here, minutes after the parent read the reply.
		expect(terminalNotices(family.parent.session)).toEqual([]);
		// The credit still lands exactly once, and the recorded verdict is untouched.
		const afterDrain = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(afterDrain.results[0]?.replied_since_task).toBe(true);
		expect(afterDrain.results[0]?.terminal_kind).toBe("completed_without_reply");
		// Reconciliation without touching the verdict: a reader that sees a no-reply
		// verdict and no notice in the transcript can tell why.
		expect(afterDrain.results[0]?.no_reply_notice_superseded).toBe(true);
	});

	it("still reports a child whose queued reply was cleared instead of delivered", async () => {
		const family = await makeFamily();
		const handle = await family.parent.session.runRlmChild("audit and reply", { name: "cleared-reply-worker" });
		await vi.waitFor(() => expect(family.deliveryStatuses).toEqual(["queued"]), { timeout: 15_000, interval: 20 });
		await vi.waitFor(() => expect(family.parent.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 20_000,
			interval: 20,
		});

		// B1's real invariant: a reply that never reaches the parent is not a reply,
		// so the notice is the only record the child finished and must still publish.
		const cleared = family.parent.session.clearQueuedAgentMessages();
		expect([...cleared.steering, ...cleared.followUp].length).toBeGreaterThan(0);

		await drainParent(family);

		expect(deliveredReplyIds(family.parent.session.messages)).not.toContain(family.messageIds[0]!);
		await vi.waitFor(() => expect(terminalNotices(family.parent.session)).toHaveLength(1), {
			timeout: 15_000,
			interval: 20,
		});
		expect(terminalNotices(family.parent.session)[0]?.details).toMatchObject({
			kind: "completed_without_reply",
			childId: handle.rlm_child_id,
			sessionName: "cleared-reply-worker",
		});
		const collected = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(collected.results[0]?.terminal_kind).toBe("completed_without_reply");
		expect(collected.results[0]?.replied_since_task).not.toBe(true);
	});

	it("does not publish a second failure report when the child's own notice lands first", async () => {
		const family: { parent?: Harness; child?: Harness } = {};
		const deliveryStatuses: string[] = [];
		const roster = (): AgentFamilyRosterResult => ({
			current: { name: "failing-child", id: "child-session-id", depth: 1 },
			entries: [{ relationship: "parent", name: "parent", id: "parent-session-id", depth: 0, status: "running" }],
		});
		// The child's own terminal-error report goes through the daemon leg, so a busy
		// parent queues it: the classifier is right to report the failure (queued is
		// not delivered), and the publication gate is what keeps it from reporting it
		// twice once the child's own copy lands.
		const sendAgentMessage = vi.fn(async (input: { message: string }) => {
			const parent = family.parent?.session;
			const child = family.child?.session;
			if (!parent || !child) throw new Error("the family is not wired yet");
			const notice = childMessage(child, parent, input.message);
			const status = await deliverChildMessage(parent, notice);
			deliveryStatuses.push(status);
			const receipt: AgentSessionMessageReceipt = {
				id: notice.details.id,
				source: AGENT_MESSAGE_SOURCE,
				target: { activeSessionId: "parent-active", sessionId: parent.sessionId },
				message: input.message,
				deliveryStatus: status,
			};
			return receipt;
		});

		let releaseParent: () => void = () => {};
		const parentGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		const child = track(
			await createHarness({
				rlmDepth: 1,
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				agentMessageController: { listAgents: () => ({ agents: [] }), roster, sendAgentMessage },
			}),
		);
		const parent = track(
			await createHarness({
				tools: [hangTool(parentGate)],
				rlmDepth: 0,
				rlmMaxDepth: 1,
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		family.parent = parent;
		family.child = child;
		parent.setResponses([
			fauxAssistantMessage(fauxToolCall("hold_the_turn", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the long parent turn finished"),
			fauxAssistantMessage("the parent read the child's own error report"),
			fauxAssistantMessage("the parent is idle again"),
		]);
		child.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const parentTurn = parent.session.promptAndWait("do the long work");
		await waitForCondition(() => parent.session.isStreaming);
		const handle = await parent.session.runRlmChild("do the task", { name: "failing-child" });
		await vi.waitFor(() => expect(deliveryStatuses).toEqual(["queued"]), { timeout: 20_000, interval: 20 });
		await vi.waitFor(() => expect(parent.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 20_000,
			interval: 20,
		});
		// The failure verdict is recorded, unchanged: a queued report is not a
		// delivered one, so the parent still owes itself a failure classification.
		const atSettle = await parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(atSettle.results[0]?.terminal_kind).toBe("error");

		releaseParent();
		await parentTurn;
		await vi.waitFor(
			() => {
				expect(parent.session.isStreaming).toBe(false);
				expect(parent.session.unfinishedActionCount).toBe(0);
			},
			{ timeout: 20_000, interval: 20 },
		);
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Exactly one report of one death: the child's own, which the parent read.
		const inbound = parent.session.messages.filter((message): message is AgentSessionMessage =>
			isAgentSessionMessage(message),
		);
		expect(inbound).toHaveLength(1);
		expect(inbound[0]?.content).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		// HEAD published its synthesized failure notice on top of it.
		expect(failureNotices(parent.session)).toEqual([]);
	});

	it("re-arms the owed credit for a queued reply restored after a restart", async () => {
		const family = await makeFamily({ route: "restore" });
		const handle = await family.parent.session.runRlmChild("audit and reply", { name: "restored-reply-worker" });
		await vi.waitFor(() => expect(family.deliveryStatuses).toEqual(["queued"]), { timeout: 15_000, interval: 20 });

		const atSettle = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(atSettle.results[0]?.terminal_kind).toBe("completed_without_reply");

		await drainParent(family);

		// The restored reply is delivered and credited (HEAD delivered it into an
		// empty ledger: no credit, no warning, nothing to re-validate against).
		expect(deliveredReplyIds(family.parent.session.messages)).toContain(family.messageIds[0]!);
		const afterDrain = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(afterDrain.results[0]?.replied_since_task).toBe(true);
		expect(terminalNotices(family.parent.session)).toEqual([]);
	});

	it("reflows a restored reply ahead of the restored notice it disproves", async () => {
		// The dispose-time writer emits deferred notices before queued replies, so a
		// reflow that kept that order would hand the parent a no-reply report above
		// the reply itself whenever both ride into a turn as next-turn context.
		const writer = track(await createHarness({ persistSession: true }));
		writer.setResponses([fauxAssistantMessage("not consumed")]);
		writer.session.requestAbort();
		const notice = createRlmChildTerminalNoticeMessage({
			kind: "completed_without_reply",
			childId: "child-reflow",
			sessionName: "worker-reflow",
		});
		writer.session.restorePendingNextTurnMessages([notice]);
		const replyPayload: AgentSessionMessagePayload = {
			id: createAgentSessionMessageId(),
			source: AGENT_MESSAGE_SOURCE,
			message: "the reply that outlived the restart",
			from: { activeSessionId: "child-active", sessionId: "child-session", sessionName: "worker-reflow" },
			fromRelationship: "child",
			target: { activeSessionId: "parent-active", sessionId: "parent-session" },
		};
		const reply = createAgentSessionMessage(replyPayload);
		await writer.session.acceptAgentMessagePrompt(reply.content as string, {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			queueIfBusy: true,
			customMessage: reply,
		});
		const sidecarPath = writer.session.undeliveredRlmNoticeSidecarPath;
		expect(sidecarPath).toBeTypeOf("string");
		writer.session.dispose();

		interface SidecarRow {
			key: string;
			message: CustomMessage;
			writtenAt: number;
		}
		const rows = readFileSync(sidecarPath!, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as SidecarRow);
		expect(rows.length).toBe(2);
		// The writer's own order is the hazard: notice first, reply second.
		expect(rows[0]?.message.customType).toBe(RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE);
		expect(rows[1]?.message.content).toContain("the reply that outlived the restart");

		const restored = track(await createHarness({ persistSession: true }));
		restored.setResponses([fauxAssistantMessage("read the reflowed queue")]);
		// Held so the reflow lands in the pending queue without the flush draining it,
		// which is where the order is decided.
		const pause = restored.session.acquireSessionInputPause();
		try {
			restored.session.requestAbort();
			const restoredPath = restored.session.undeliveredRlmNoticeSidecarPath;
			expect(restoredPath).toBeTypeOf("string");
			expect(restoredPath).not.toBe(sidecarPath);
			expect(existsSync(restoredPath!)).toBe(false);
			writeFileSync(restoredPath!, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });

			restored.session.resumeQueuedWork();

			const pending = restored.session.getPendingNextTurnMessageSnapshots();
			expect(pending.map((message) => message.customType)).toEqual([
				"agent_message",
				RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
			]);
		} finally {
			pause.release();
			restored.session.requestAbort();
		}
	});

	it("re-arms the owed credit for a reply restored into the next-turn queue", async () => {
		const family = await makeFamily({ route: "pending" });
		const handle = await family.parent.session.runRlmChild("audit and reply", { name: "next-turn-worker" });
		await vi.waitFor(() => expect(family.deliveryStatuses).toEqual(["queued"]), { timeout: 15_000, interval: 20 });
		const atSettle = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(atSettle.results[0]?.terminal_kind).toBe("completed_without_reply");

		await drainParent(family);

		// The reply rode in as next-turn context of the notice's own turn: it has to be
		// in the transcript, credited (a prefix delivery is a delivery), and ahead of
		// the notice. The notice itself still publishes - the gate only ever acts on a
		// delivery that has already happened, and cancelling this turn would strand the
		// very reply it is about to carry - so this leg is fail-open by construction.
		const transcript = family.parent.session.messages;
		const replyIndex = deliveredReplyIds(transcript).indexOf(family.messageIds[0]!);
		expect(replyIndex).toBeGreaterThanOrEqual(0);
		const noticeIndex = transcript.findIndex(
			(message) => message.role === "custom" && message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
		);
		expect(noticeIndex).toBeGreaterThanOrEqual(0);
		expect(replyIndex).toBeLessThan(noticeIndex);
		const afterDrain = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(afterDrain.results[0]?.replied_since_task).toBe(true);
	});

	// The two cases below are the review lane's probes (finish-queued-fix, PROBE E and
	// PROBE B), ported verbatim in shape so the holes they found stay pinned.

	it("still reports a later run's failure when an earlier run reported itself", async () => {
		// The suppression fact has to be per run: a child session outlives the run that
		// failed, and a session-wide flag set by run 1 silently swallows run 2's death
		// report - the one case where the synthesized notice is the only record.
		const family: { parent?: Harness; child?: Harness } = {};
		const deliveryStatuses: string[] = [];
		let sentOwnNotices = 0;
		const roster = (): AgentFamilyRosterResult => ({
			current: { name: "failing-child", id: "child-session-id", depth: 1 },
			entries: [{ relationship: "parent", name: "parent", id: "parent-session-id", depth: 0, status: "running" }],
		});
		// Run 1 reports by hand (queued, then delivered). Run 2 cannot: the send fails,
		// which is exactly when the parent's own synthesized report is the only record.
		const sendAgentMessage = vi.fn(async (input: { message: string }) => {
			const parent = family.parent?.session;
			const child = family.child?.session;
			if (!parent || !child) throw new Error("the family is not wired yet");
			sentOwnNotices += 1;
			if (sentOwnNotices > 1) throw new Error("the child could not report by hand");
			const notice = childMessage(child, parent, input.message);
			const status = await deliverChildMessage(parent, notice);
			deliveryStatuses.push(status);
			const receipt: AgentSessionMessageReceipt = {
				id: notice.details.id,
				source: AGENT_MESSAGE_SOURCE,
				target: { activeSessionId: "parent-active", sessionId: parent.sessionId },
				message: input.message,
				deliveryStatus: status,
			};
			return receipt;
		});
		let releaseParent: () => void = () => {};
		const parentGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		const child = track(
			await createHarness({
				rlmDepth: 1,
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				agentMessageController: { listAgents: () => ({ agents: [] }), roster, sendAgentMessage },
			}),
		);
		const parent = track(
			await createHarness({
				tools: [hangTool(parentGate)],
				rlmDepth: 0,
				rlmMaxDepth: 1,
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		family.parent = parent;
		family.child = child;
		parent.setResponses([
			fauxAssistantMessage(fauxToolCall("hold_the_turn", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the long parent turn finished"),
			fauxAssistantMessage("the parent read the child's own error report"),
			fauxAssistantMessage("the parent keeps working"),
			fauxAssistantMessage("the parent is idle again"),
			fauxAssistantMessage("the parent stays idle"),
		]);
		child.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);

		const parentTurn = parent.session.promptAndWait("do the long work");
		await waitForCondition(() => parent.session.isStreaming);
		const run1 = await parent.session.runRlmChild("first task", { name: "failing-child" });
		await vi.waitFor(() => expect(deliveryStatuses).toEqual(["queued"]), { timeout: 20_000, interval: 20 });
		await vi.waitFor(() => expect(parent.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 20_000,
			interval: 20,
		});
		releaseParent();
		await parentTurn.catch(() => {});
		await vi.waitFor(
			() => {
				expect(parent.session.isStreaming).toBe(false);
				expect(parent.session.unfinishedActionCount).toBe(0);
			},
			{ timeout: 20_000, interval: 50 },
		);
		// Run 1: exactly one report (the child's own); the gate held back the duplicate.
		expect(failureNotices(parent.session)).toEqual([]);

		// Run 2 on the SAME child session. It fails and cannot report by hand, so the
		// parent's synthesized failure notice is the only record that it died.
		child.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		const run2 = await parent.session.runRlmChild("second task", { name: "failing-child-2" });
		await vi.waitFor(() => expect(parent.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 20_000,
			interval: 20,
		});
		const verdict2 = await parent.session.collectRlmChildren([run2.rlm_child_id], 20_000);
		expect(verdict2.results[0]?.terminal_kind).toBe("error");
		expect(run2.rlm_child_id).not.toBe(run1.rlm_child_id);
		// Give the notice every chance to publish: a parent turn drains the queue.
		await parent.session.promptAndWait("keep working").catch(() => {});
		await vi.waitFor(
			() => {
				expect(parent.session.isStreaming).toBe(false);
				expect(parent.session.unfinishedActionCount).toBe(0);
			},
			{ timeout: 20_000, interval: 50 },
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const run2Reports = failureNotices(parent.session).filter(
			(notice) => (notice.details as { childId?: string }).childId === run2.rlm_child_id,
		);
		expect(run2Reports).toHaveLength(1);
	}, 90_000);

	it("does not publish a folded failure report the child already delivered (aggregated wake)", async () => {
		// An Esc suspends the pump, so the failure notice is buffered and later folded
		// into ONE aggregated wake turn as prefix records behind a synthetic summary.
		// A gate that only reads the action's primary message never sees it.
		const family: { parent?: Harness; child?: Harness } = {};
		const deliveryStatuses: string[] = [];
		const roster = (): AgentFamilyRosterResult => ({
			current: { name: "failing-child", id: "child-session-id", depth: 1 },
			entries: [{ relationship: "parent", name: "parent", id: "parent-session-id", depth: 0, status: "running" }],
		});
		const sendAgentMessage = vi.fn(async (input: { message: string }) => {
			const parent = family.parent?.session;
			const child = family.child?.session;
			if (!parent || !child) throw new Error("the family is not wired yet");
			const notice = childMessage(child, parent, input.message);
			const status = await deliverChildMessage(parent, notice);
			deliveryStatuses.push(status);
			const receipt: AgentSessionMessageReceipt = {
				id: notice.details.id,
				source: AGENT_MESSAGE_SOURCE,
				target: { activeSessionId: "parent-active", sessionId: parent.sessionId },
				message: input.message,
				deliveryStatus: status,
			};
			return receipt;
		});
		let releaseParent: () => void = () => {};
		const parentGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		let releaseChild: () => void = () => {};
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const child = track(
			await createHarness({
				tools: [hangTool(childGate)],
				rlmDepth: 1,
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				agentMessageController: { listAgents: () => ({ agents: [] }), roster, sendAgentMessage },
			}),
		);
		const parent = track(
			await createHarness({
				tools: [hangTool(parentGate)],
				rlmDepth: 0,
				rlmMaxDepth: 1,
				failureWakeQuietWindowMs: 60_000,
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		family.parent = parent;
		family.child = child;
		parent.setResponses([
			fauxAssistantMessage(fauxToolCall("hold_the_turn", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the parent came back after the Esc"),
			fauxAssistantMessage("the parent is idle again"),
			fauxAssistantMessage("the parent stays idle"),
			fauxAssistantMessage("the parent stays idle 2"),
		]);
		// The child is still mid-turn when the Esc lands, so its own terminal-error
		// report and the parent's synthesized one both arrive at a suspended pump.
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("hold_the_turn", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		]);

		const parentTurn = parent.session.promptAndWait("do the long work");
		await waitForCondition(() => parent.session.isStreaming);
		const handle = await parent.session.runRlmChild("do the task", { name: "failing-child" });
		await waitForCondition(() => child.session.isStreaming);
		parent.session.requestAbort();
		releaseParent();
		await parentTurn.catch(() => {});
		await vi.waitFor(() => expect(parent.session.isQueuedWorkSuspended).toBe(true), {
			timeout: 20_000,
			interval: 20,
		});
		releaseChild();
		await vi.waitFor(() => expect(deliveryStatuses).toEqual(["queued"]), { timeout: 20_000, interval: 20 });
		await vi.waitFor(() => expect(parent.session.hasRunningRlmChildren()).toBe(false), {
			timeout: 20_000,
			interval: 20,
		});
		const atSettle = await parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(atSettle.results[0]?.terminal_kind).toBe("error");

		// The aggregated wake drains the queue: the child's own report is a steer and
		// lands first, then the wake turn publishes whatever it folded in.
		await vi.waitFor(
			() => {
				expect(
					parent.session.messages.filter((message): message is AgentSessionMessage =>
						isAgentSessionMessage(message),
					).length,
				).toBe(1);
			},
			{ timeout: 30_000, interval: 50 },
		);
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		const inbound = parent.session.messages.filter((message): message is AgentSessionMessage =>
			isAgentSessionMessage(message),
		);
		expect(inbound).toHaveLength(1);
		expect(inbound[0]?.content).toContain(SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX);
		// One death, one report.
		expect(failureNotices(parent.session)).toEqual([]);
	}, 90_000);
});
