/**
 * A child reply that the parent's queue held, and then actually delivered, is a
 * reply: the parent must not report "completed without sending a reply".
 *
 * Red at HEAD (420ee84ed): the sender only counted a reply when the send receipt
 * said `delivered` (B1, correctly refusing to count an undelivered queue entry),
 * but nothing credited the queued reply when it landed. A child that replied to a
 * busy parent - the common shape, since a parent orchestrating work is usually
 * mid-turn - therefore settled with repliedDuringRun=false and the parent got a
 * false no-reply alarm for a reply it had already read.
 *
 * The delivery leg here is the daemon's, minus the daemon: the reply is handed to
 * the receiving session through `acceptAgentMessagePrompt` with the options
 * `acceptAgentSessionMessage` uses, so `queued` / `delivered` are the real ones.
 */
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
	createAgentSessionMessageId,
	isAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { type CustomMessage, RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

function terminalNotices(messages: readonly AgentMessage[]): CustomMessage[] {
	return messages.filter(
		(message): message is CustomMessage =>
			message.role === "custom" && message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	);
}

function deliveredReplyIds(messages: readonly AgentMessage[]): string[] {
	return messages
		.filter((message): message is AgentSessionMessage => isAgentSessionMessage(message))
		.map((message) => message.details.id);
}

/**
 * The daemon's delivery leg: hand a child's reply to the receiving session and
 * report the delivery status its sender saw on the receipt.
 */
async function deliverChildReply(receiver: AgentSession, reply: AgentSessionMessage): Promise<"delivered" | "queued"> {
	let accepted = true;
	let queued = false;
	await receiver.acceptAgentMessagePrompt(reply.content as string, {
		expandPromptTemplates: false,
		streamingBehavior: "steer",
		queueIfBusy: true,
		customMessage: reply,
		preflightResult: (success, didQueue) => {
			accepted = success;
			queued = success && didQueue === true;
		},
	});
	if (!accepted) throw new Error("the receiving session refused the child reply");
	return queued ? "queued" : "delivered";
}

function childReply(child: AgentSession, parent: AgentSession, message: string): AgentSessionMessage {
	return createAgentSessionMessage({
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
	});
}

async function waitForCondition(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * The child's side of the exchange: send one reply through the daemon's delivery
 * leg, record the receipt status, and - when the case needs it - hold the turn
 * until the reply has actually landed in the parent's transcript.
 */
function makeReplyTool(
	state: { family: { parent?: Harness; child?: Harness }; deliveryStatuses: string[]; replyIds: string[] },
	waitForDelivery: boolean,
	options: { waitBeforeSend?: () => boolean } = {},
): AgentTool {
	return {
		name: "reply_to_parent",
		label: "Reply to parent",
		description: "Sends this child's reply to its parent",
		parameters: Type.Object({}),
		execute: async () => {
			const parent = state.family.parent?.session;
			const child = state.family.child?.session;
			if (!parent || !child) throw new Error("the family is not wired yet");
			if (options.waitBeforeSend) await waitForCondition(options.waitBeforeSend);
			const reply = childReply(child, parent, "the audit is finished: three findings");
			state.replyIds.push(reply.details.id);
			state.deliveryStatuses.push(await deliverChildReply(parent, reply));
			if (waitForDelivery) {
				await waitForCondition(() => deliveredReplyIds(parent.messages).includes(reply.details.id));
			}
			return { content: [{ type: "text", text: "reply sent" }], details: {} };
		},
	};
}

describe("queued child reply delivered later", () => {
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
		/** Delivery status the child's reply got, recorded by the child's own tool. */
		deliveryStatuses: string[];
		replyIds: string[];
		parentTurn: Promise<void>;
	}

	/**
	 * A parent stuck in a tool call (so it is busy and queues), and a child whose
	 * turn sends one reply through the daemon's delivery leg.
	 *
	 * `waitForDelivery` is the only difference between the two cases below: the
	 * fixed defect needs the reply to land before the child settles, and the B1
	 * guarantee needs it to still be in the queue when the child settles.
	 */
	async function makeFamily(options: { waitForDelivery: boolean }): Promise<Family> {
		const family: { parent?: Harness; child?: Harness } = {};
		const deliveryStatuses: string[] = [];
		const replyIds: string[] = [];
		let releaseParent: () => void = () => {};
		const parentGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});

		const holdTheTurn: AgentTool = {
			name: "hold_the_turn",
			label: "Hold the turn",
			description: "Keeps this session busy until the test releases it",
			parameters: Type.Object({}),
			execute: async () => {
				await parentGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const replyToParent = makeReplyTool({ family, deliveryStatuses, replyIds }, options.waitForDelivery);

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
				tools: [holdTheTurn],
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
			fauxAssistantMessage("the parent read the queued reply"),
			fauxAssistantMessage("the parent is idle again"),
		]);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("reply_to_parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the child finished after replying"),
		]);

		// The parent is mid-turn for the whole child run, which is what makes the
		// reply queue instead of delivering.
		const parentTurn = parent.session.promptAndWait("do the long work");
		await waitForCondition(() => parent.session.isStreaming);
		return { parent, child, releaseParent, deliveryStatuses, replyIds, parentTurn };
	}

	it("does not report a no-reply alarm for a queued reply the parent read before the child settled", async () => {
		const family = await makeFamily({ waitForDelivery: true });
		const handle = await family.parent.session.runRlmChild("audit and reply", { name: "queued-reply-worker" });

		// The reply queues behind the parent's turn; only then may the parent drain,
		// which is the moment the credit has to happen.
		await vi.waitFor(() => expect(family.deliveryStatuses).toEqual(["queued"]), { timeout: 15_000, interval: 20 });
		family.releaseParent();
		await family.parentTurn;

		const replyId = family.replyIds[0]!;
		await vi.waitFor(() => expect(deliveredReplyIds(family.parent.session.messages)).toContain(replyId), {
			timeout: 15_000,
			interval: 20,
		});

		const collected = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(collected.results).toHaveLength(1);
		// HEAD answered completed_without_reply here: the reply had landed in the
		// parent's own transcript and still did not count.
		expect(collected.results[0]?.terminal_kind).toBe("none");
		expect(collected.results[0]?.replied_since_task).toBe(true);

		await vi.waitFor(() => {
			expect(family.parent.session.isStreaming).toBe(false);
			expect(family.parent.session.unfinishedActionCount).toBe(0);
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(terminalNotices(family.parent.session.messages)).toEqual([]);
	});

	it("keeps the no-reply verdict while a queued reply has not been delivered (B1)", async () => {
		const family = await makeFamily({ waitForDelivery: false });
		const handle = await family.parent.session.runRlmChild("audit and reply", { name: "queued-reply-worker" });

		await vi.waitFor(() => expect(family.deliveryStatuses).toEqual(["queued"]), { timeout: 15_000, interval: 20 });
		// The parent stays busy, so the child settles with its reply still in the
		// queue: an undelivered reply must not count as one. The verdict layer is B1's
		// and does not move - `collectRlmChildren` reports what was decided at settle.
		const collected = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(collected.results[0]?.terminal_kind).toBe("completed_without_reply");
		expect(collected.results[0]?.replied_since_task).not.toBe(true);

		family.releaseParent();
		await family.parentTurn;
		// The publication layer is not the verdict: this drain delivers the reply
		// first (a steer outranks the notice's follow-up), so the notice would arrive
		// below the very reply it calls missing. That is the false alarm the
		// publication gate drops - asserted with its two pins in
		// ma-stale-no-reply-notice-publication.test.ts (suppressed when the reply
		// lands, still published when the reply is cleared instead).
		await vi.waitFor(() => expect(deliveredReplyIds(family.parent.session.messages)).toContain(family.replyIds[0]!), {
			timeout: 15_000,
			interval: 20,
		});
		await vi.waitFor(() => {
			expect(family.parent.session.isStreaming).toBe(false);
			expect(family.parent.session.unfinishedActionCount).toBe(0);
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(terminalNotices(family.parent.session.messages)).toEqual([]);
	});

	it("drops the no-reply notice when the child run is gone before the queued reply lands", async () => {
		// The live shape: the parent waits in a busy tool while the child replies (so the
		// reply queues and the verdict is completed_without_reply), then deletes the child
		// in the same turn. The notice publishes after the child's run is gone, and used
		// to publish unverified and wake the parent for a reply it had already read.
		const family = await makeFamily({ waitForDelivery: false });
		const handle = await family.parent.session.runRlmChild("audit and reply", { name: "deleted-reply-worker" });

		await vi.waitFor(() => expect(family.deliveryStatuses).toEqual(["queued"]), { timeout: 15_000, interval: 20 });
		const collected = await family.parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(collected.results[0]?.terminal_kind).toBe("completed_without_reply");
		// The daemon host drops a finished child's run when the child is deleted or
		// released; this is the release leg, the same removal the delete leg does.
		const release = family.parent.session.releaseRlmChildSession(handle.rlm_child_id, family.child.session);
		expect(release).toBeTypeOf("function");
		if (release) release();

		family.releaseParent();
		await family.parentTurn;
		await vi.waitFor(() => expect(deliveredReplyIds(family.parent.session.messages)).toContain(family.replyIds[0]!), {
			timeout: 15_000,
			interval: 20,
		});
		await vi.waitFor(() => {
			expect(family.parent.session.isStreaming).toBe(false);
			expect(family.parent.session.unfinishedActionCount).toBe(0);
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(terminalNotices(family.parent.session.messages)).toEqual([]);
	});

	it("credits a reply queued into a suspended parent once the queue resumes", async () => {
		// The Esc shape (P0-3a): a suspended pump queues the reply through
		// queueAgentMessagePrompt with reason target_suspended, so this is the second
		// registration wire, and it owes the same credit when the queue drains.
		const family: { parent?: Harness; child?: Harness } = {};
		const deliveryStatuses: string[] = [];
		const replyIds: string[] = [];

		const child = track(
			await createHarness({
				tools: [
					makeReplyTool({ family, deliveryStatuses, replyIds }, true, {
						waitBeforeSend: () => family.parent?.session.isQueuedWorkSuspended === true,
					}),
				],
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
			fauxAssistantMessage("the parent read the reply after the Esc"),
			fauxAssistantMessage("the parent is idle again"),
		]);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("reply_to_parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the child finished after replying"),
		]);

		const handle = await parent.session.runRlmChild("audit and reply", { name: "suspended-reply-worker" });
		// The Esc: nothing may start a turn, so the reply has to queue.
		parent.session.requestAbort();
		await vi.waitFor(() => expect(deliveryStatuses).toEqual(["queued"]), { timeout: 15_000, interval: 20 });
		expect(parent.session.isQueuedWorkSuspended).toBe(true);

		expect(parent.session.resumeQueuedWork()).toBe(true);
		await vi.waitFor(() => expect(deliveredReplyIds(parent.session.messages)).toContain(replyIds[0]!), {
			timeout: 15_000,
			interval: 20,
		});

		const collected = await parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(collected.results[0]?.terminal_kind).toBe("none");
		expect(collected.results[0]?.replied_since_task).toBe(true);
		expect(terminalNotices(parent.session.messages)).toEqual([]);
	});

	it("does not let a previous run's queued reply credit the next run", async () => {
		// The credit is run-scoped on purpose: a reply the first run left in the
		// parent's queue already got its verdict (the notice below), so if it landed
		// during the second run it would report a silent child as one that replied.
		const family: { parent?: Harness; child?: Harness } = {};
		const deliveryStatuses: string[] = [];
		const replyIds: string[] = [];

		const child = track(
			await createHarness({
				tools: [
					makeReplyTool({ family, deliveryStatuses, replyIds }, false, {
						waitBeforeSend: () => family.parent?.session.isQueuedWorkSuspended === true,
					}),
				],
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
			fauxAssistantMessage("the parent read the first reply late"),
			fauxAssistantMessage("the parent is idle again"),
			fauxAssistantMessage("the parent keeps working"),
		]);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("reply_to_parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the first run finished after replying"),
			// The second run never replies: that is the fact the verdict must keep.
			fauxAssistantMessage("the second run finished quietly"),
		]);

		parent.session.requestAbort();
		const firstRun = await parent.session.runRlmChild("first task", { name: "stale-credit-worker" });
		await vi.waitFor(() => expect(deliveryStatuses).toEqual(["queued"]), { timeout: 15_000, interval: 20 });

		const firstVerdict = await parent.session.collectRlmChildren([firstRun.rlm_child_id], 20_000);
		expect(firstVerdict.results[0]?.terminal_kind).toBe("completed_without_reply");

		// The second run starts while the first run's reply is still in the queue.
		const secondRun = await parent.session.runRlmChild("second task", { name: "stale-credit-worker-2" });
		expect(parent.session.resumeQueuedWork()).toBe(true);
		await vi.waitFor(() => expect(deliveredReplyIds(parent.session.messages)).toContain(replyIds[0]!), {
			timeout: 15_000,
			interval: 20,
		});

		const secondVerdict = await parent.session.collectRlmChildren([secondRun.rlm_child_id], 20_000);
		expect(secondVerdict.results[0]?.terminal_kind).toBe("completed_without_reply");
		expect(secondVerdict.results[0]?.rlm_child_id).toBe(secondRun.rlm_child_id);
		expect(secondVerdict.results[0]?.rlm_child_id).not.toBe(firstRun.rlm_child_id);
	});
});
