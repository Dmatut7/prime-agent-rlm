/**
 * A child whose run ended by replying must leave a settle record in the parent's
 * transcript - and the compaction handoff must delist it.
 *
 * The terminal classifier reports a replied run as "none" by design: the parent
 * already has the answer, so no notice is published. But the handoff scanner
 * resolves a listed child only on a terminal record later in the branch, so a
 * replied child was named as in flight by every compaction forever. The settle
 * record (`rlm_child_settled`, a custom entry - never a message, never in the
 * model's context) is the transcript fact the scanner needed.
 *
 * The family shape mirrors ma-queued-reply-delivery-credit.test.ts: the parent is
 * mid-turn so the reply queues, and the child's reply credit lands when the queue
 * drains - the reply counting path a real daemon delivery takes.
 */
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
	createAgentSessionMessageId,
	isAgentSessionMessage,
} from "../../src/core/agent-messages.js";
import type { AgentSession } from "../../src/core/agent-session.js";
import { buildSessionHandoff } from "../../src/core/compaction/index.js";
import { RLM_CHILD_SETTLED_CUSTOM_TYPE } from "../../src/core/rlm-child-terminal.js";
import type { CustomEntry, SessionMessageEntry } from "../../src/core/session-manager.js";
import { createHarness, type Harness } from "./harness.js";

function settleRecords(session: AgentSession): CustomEntry[] {
	return session.sessionManager
		.getBranch()
		.filter(
			(entry): entry is CustomEntry => entry.type === "custom" && entry.customType === RLM_CHILD_SETTLED_CUSTOM_TYPE,
		);
}

function deliveredReplyIds(messages: readonly AgentMessage[]): string[] {
	return messages
		.filter((message): message is AgentSessionMessage => isAgentSessionMessage(message))
		.map((message) => message.details.id);
}

async function waitForCondition(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("a child whose run ended by replying", () => {
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

	it("leaves a settle record the compaction handoff resolves", async () => {
		const family: { parent?: Harness; child?: Harness } = {};
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
		const replyToParent: AgentTool = {
			name: "reply_to_parent",
			label: "Reply to parent",
			description: "Sends this child's reply to its parent",
			parameters: Type.Object({}),
			execute: async () => {
				const parent = family.parent?.session;
				const child = family.child?.session;
				if (!parent || !child) throw new Error("the family is not wired yet");
				const reply = createAgentSessionMessage({
					id: createAgentSessionMessageId(),
					source: AGENT_MESSAGE_SOURCE,
					message: "the audit is finished: three findings",
					from: {
						activeSessionId: "child-active",
						sessionId: child.sessionId,
						sessionName: child.sessionName ?? "settled-worker",
					},
					fromRelationship: "child",
					target: {
						activeSessionId: "parent-active",
						sessionId: parent.sessionId,
						sessionName: "parent",
					},
				});
				replyIds.push(reply.details.id);
				// The daemon's delivery leg: hand the reply to the receiving session the
				// way acceptAgentSessionMessage does.
				await parent.acceptAgentMessagePrompt(reply.content as string, {
					expandPromptTemplates: false,
					streamingBehavior: "steer",
					queueIfBusy: true,
					customMessage: reply,
				});
				// The reply is queued behind the parent's in-flight turn; the child's own
				// turn may not end before the credit lands, or the run settles as
				// completed_without_reply (the race ma-queued-reply-delivery-credit pins).
				await waitForCondition(() => deliveredReplyIds(parent.messages).includes(reply.details.id));
				return { content: [{ type: "text", text: "reply sent" }], details: {} };
			},
		};

		const child = track(
			await createHarness({
				tools: [replyToParent],
				settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
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
			fauxAssistantMessage("the long parent turn ended"),
			fauxAssistantMessage("the parent read the queued reply"),
			fauxAssistantMessage("the parent is idle again"),
		]);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("reply_to_parent", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("the child wrapped up after replying"),
		]);

		// The parent is mid-turn for the whole child run, so the reply queues and the
		// child's reply credit lands when the queue drains.
		const parentTurn = parent.session.promptAndWait("do the long work");
		await waitForCondition(() => parent.session.isStreaming);

		const handle = await parent.session.runRlmChild("audit and reply", { name: "settled-worker" });
		await waitForCondition(() => replyIds.length === 1);
		releaseParent();
		await parentTurn;
		await waitForCondition(() => deliveredReplyIds(parent.session.messages).includes(replyIds[0]!));

		const collected = await parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(collected.results).toHaveLength(1);
		// The replied run classifies as "none": no notice, no failure - the parent
		// already has the answer. That is exactly the case the transcript had no
		// record of.
		expect(collected.results[0]?.terminal_kind).toBe("none");
		expect(collected.results[0]?.replied_since_task).toBe(true);

		// The transcript carries the settle record...
		const records = settleRecords(parent.session);
		expect(records).toHaveLength(1);
		expect(records[0]?.data).toMatchObject({
			childId: handle.rlm_child_id,
			sessionName: "settled-worker",
		});

		// ...and the handoff resolves the child: a real admission record lists it
		// (control), and only the settle record in the real branch removes it.
		const admissionEntry: SessionMessageEntry = {
			type: "message",
			id: "synthetic-admission",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "tc-admission",
				toolName: "ipython",
				content: [{ type: "text", text: "ok" }],
				details: {
					activities: [{ id: "s1", kind: "subagent", label: "settled-worker", status: "ok", startedAt: 1000 }],
				},
				isError: false,
				timestamp: Date.now(),
			} as SessionMessageEntry["message"],
		};
		const listed = buildSessionHandoff([admissionEntry], { generation: 1 });
		expect(listed.subagents.map((subagent) => subagent.name)).toEqual(["settled-worker"]);
		const handoff = buildSessionHandoff([admissionEntry, ...parent.session.sessionManager.getBranch()], {
			generation: 1,
		});
		expect(handoff.subagents).toEqual([]);
	});

	it("leaves no settle record for a run that ends without replying", async () => {
		const child = track(
			await createHarness({ settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } } }),
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
		child.setResponses([fauxAssistantMessage("an answer written but never sent")]);

		const handle = await parent.session.runRlmChild("quiet work", { name: "silent-worker" });
		const collected = await parent.session.collectRlmChildren([handle.rlm_child_id], 20_000);
		expect(collected.results[0]?.terminal_kind).toBe("completed_without_reply");
		// The no-reply notice is that run's terminal record; a settle record on top
		// would double-count it.
		expect(settleRecords(parent.session)).toEqual([]);
	});
});
