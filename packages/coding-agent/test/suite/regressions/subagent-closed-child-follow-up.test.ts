/**
 * Subagent lifecycle holes an unattended parent fell into (lane B review):
 *
 * - a finished child the daemon closed after it sat idle vanished from
 *   `rlm.collect()` (collect only read the two live maps, and the idle close empties
 *   both), so `collect([name])` threw and the child's answer was gone;
 * - the close sent no roster update, so the parent's panel kept a dead session id;
 * - a follow-up the parent sent to a finished child that ended without a reply
 *   produced no notice at all, so a parent waiting on it waited forever;
 * - stopping a finished child that was working on a follow-up did nothing: it had no
 *   run to cancel, and its own turn kept spending.
 *
 * Every case drives the public session surface with the faux provider.
 */
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessageController,
	createAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import {
	type CustomMessage,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	type RlmChildTerminalNoticeDetails,
} from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

const hangTool: AgentTool = {
	name: "hang_forever",
	label: "Hang Forever",
	description: "A tool that never returns",
	parameters: Type.Object({}),
	execute: () => new Promise<never>(() => {}),
};

function terminalNotices(messages: readonly unknown[]): CustomMessage<RlmChildTerminalNoticeDetails>[] {
	return messages.filter(
		(message): message is CustomMessage<RlmChildTerminalNoticeDetails> =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	);
}

function followUpNotices(messages: readonly unknown[]): CustomMessage<RlmChildTerminalNoticeDetails>[] {
	return terminalNotices(messages).filter((notice) => notice.details?.followUp === true);
}

/** A message from the parent, delivered the way the daemon's agent_message.send delivers it. */
async function sendFollowUpFromParent(child: Harness, id: string, text: string): Promise<void> {
	const message = createAgentSessionMessage({
		id,
		source: AGENT_MESSAGE_SOURCE,
		message: text,
		from: { activeSessionId: "parent-active", sessionId: "parent-session", sessionName: "parent" },
		fromRelationship: "parent",
		target: { activeSessionId: "child-active", sessionId: child.session.sessionId },
	});
	await child.session.acceptAgentMessagePrompt(message.content, {
		expandPromptTemplates: false,
		customMessage: message,
	});
}

const silentController: AgentSessionMessageController = {
	listAgents: () => ({ agents: [] }),
	sendAgentMessage: vi.fn(async () => {
		throw new Error("synthesized notices must not use agent_message");
	}),
};

describe("subagent closed-child collect, follow-up notices and stop", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function track(harness: Harness): Harness {
		harnesses.push(harness);
		return harness;
	}

	async function family(options: { childTools?: AgentTool[]; parentController?: AgentSessionMessageController }) {
		const child = track(
			await createHarness({
				tools: options.childTools,
				settings: { retry: { enabled: false } },
				agentMessageController: silentController,
			}),
		);
		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				...(options.parentController ? { agentMessageController: options.parentController } : {}),
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		return { parent, child };
	}

	/** Spawn, then wait until the run settled and moved to the retained map. */
	async function spawnSettled(parent: Harness, name: string): Promise<string> {
		const handle = await parent.session.runRlmChild("do the assigned work", { name });
		await expect.poll(() => terminalNotices(parent.session.messages).length, { timeout: 10_000 }).toBe(1);
		await vi.waitFor(() => expect(parent.session.getRlmChildRunStatus(handle.rlm_child_id)).toBeUndefined(), {
			timeout: 10_000,
			interval: 20,
		});
		return handle.rlm_child_id;
	}

	it("keeps a finished child's result in collect after the daemon closes it for idling", async () => {
		const { parent, child } = await family({});
		child.setResponses([fauxAssistantMessage("child answer: 42")]);
		const childId = await spawnSettled(parent, "worker-a");

		// The idle close: release the tracking, then (after the runtime closed) run the closure.
		const release = parent.session.releaseRlmChildSession(childId, child.session);
		expect(release).toBeTypeOf("function");
		if (typeof release !== "function") return;
		release();

		// Red before the fix: `No direct RLM child matches "<id>"`.
		const byId = await parent.session.collectRlmChildren([childId], 0);
		expect(byId.results).toHaveLength(1);
		expect(byId.results[0]).toMatchObject({
			rlm_child_id: childId,
			session_name: "worker-a",
			status: "done",
			settled: true,
			terminal_kind: "completed_without_reply",
			activity_kind: undefined,
		});
		expect(byId.results[0]?.answer_preview).toContain("child answer: 42");
		expect((await parent.session.collectRlmChildren(["worker-a"], 0)).results[0]?.rlm_child_id).toBe(childId);
		expect((await parent.session.collectRlmChildren([child.session.sessionId], 0)).results).toHaveLength(1);
		expect((await parent.session.collectRlmChildren([], 0)).results.map((entry) => entry.rlm_child_id)).toEqual([
			childId,
		]);

		// The close is announced: a terminal row with no session id reads as "not resident".
		const updates = parent.eventsOfType("rlm_child_update").filter((event) => event.child.id === childId);
		const last = updates.at(-1)?.child;
		expect(last).toMatchObject({ id: childId, status: "done" });
		expect(last?.activeSessionId).toBeUndefined();
		expect(last?.activity).toBeUndefined();

		// A deleted child's saved result goes with it.
		await parent.session.deleteRlmSubagent(childId).catch(() => undefined);
		await expect(parent.session.collectRlmChildren([childId], 0)).rejects.toThrow("No direct RLM child matches");
	});

	it("reads a child the daemon closed before this parent session existed from its transcript", async () => {
		const closedChild = track(await createHarness({ persistSession: true, settings: { retry: { enabled: false } } }));
		closedChild.setResponses([fauxAssistantMessage("persisted answer from an earlier life")]);
		await closedChild.session.promptAndWait("earlier task");
		const sessionFile = closedChild.session.sessionFile;
		expect(sessionFile).toBeDefined();
		if (!sessionFile) return;

		const listAgents = vi.fn(async () => ({
			current: { activeSessionId: "parent-active", sessionId: "parent-session" },
			agents: [
				{
					activeSessionId: closedChild.session.sessionId,
					sessionId: closedChild.session.sessionId,
					sessionName: "old-worker",
					runtimeKind: "subagent" as const,
					cwd: closedChild.tempDir,
					isStreaming: false,
					unfinishedActionCount: 0,
					parentActiveSessionId: "parent-active",
					rlmChildId: "child-old",
					sessionDir: dirname(sessionFile),
					sessionPath: sessionFile,
					status: "inactive" as const,
					rlmChildRegistryStatus: "completed" as const,
				},
			],
		}));
		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				agentMessageController: { listAgents, sendAgentMessage: vi.fn() },
			}),
		);

		const all = await parent.session.collectRlmChildren([], 0);
		expect(all.results).toHaveLength(1);
		expect(all.results[0]).toMatchObject({ rlm_child_id: "child-old", status: "done", settled: true });
		expect(all.results[0]?.answer_preview).toContain("persisted answer from an earlier life");
		const byName = await parent.session.collectRlmChildren(["old-worker"], 0);
		expect(byName.results[0]?.rlm_child_id).toBe("child-old");
		// One daemon scan for the full collect; the named one was already known locally.
		expect(listAgents).toHaveBeenCalledTimes(1);
	});

	it("tells the parent once when a follow-up turn ends without a reply", async () => {
		const { parent, child } = await family({});
		child.setResponses([fauxAssistantMessage("first task done"), fauxAssistantMessage("the follow-up answer")]);
		const childId = await spawnSettled(parent, "worker-b");
		expect(followUpNotices(parent.session.messages)).toHaveLength(0);

		await sendFollowUpFromParent(child, "agentmsg_follow_up_1", "one more thing please");

		// Red before the fix: nothing ever reached the parent.
		await expect.poll(() => followUpNotices(parent.session.messages).length, { timeout: 10_000 }).toBe(1);
		const notice = followUpNotices(parent.session.messages)[0]!;
		expect(notice.details).toMatchObject({ kind: "completed_without_reply", childId, sessionName: "worker-b" });
		expect(notice.content).toContain("your follow-up message");
		expect(notice.content).toContain("the follow-up answer");

		// An unrelated later turn of the child (no new parent message) is not a second report.
		child.appendResponses([fauxAssistantMessage("talking to itself")]);
		await child.session.promptAndWait("a user typed into the child directly");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(followUpNotices(parent.session.messages)).toHaveLength(1);
	});

	it("stops a finished child's follow-up turn when the parent's stop reaches it", async () => {
		const { parent, child } = await family({ childTools: [hangTool] });
		child.setResponses([
			fauxAssistantMessage("first task done"),
			fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" }),
		]);
		const childId = await spawnSettled(parent, "worker-c");

		void sendFollowUpFromParent(child, "agentmsg_follow_up_2", "start the long job");
		await vi.waitFor(() => expect(child.session.isStreaming).toBe(true), { timeout: 10_000, interval: 20 });

		// Red before the fix: false, and the child kept running.
		expect(parent.session.cancelRlmChildRun(childId)).toBe(true);
		await vi.waitFor(() => expect(child.session.isSessionActive).toBe(false), { timeout: 10_000, interval: 20 });

		// The parent learns the follow-up will not be answered instead of waiting on it.
		await expect.poll(() => followUpNotices(parent.session.messages).length, { timeout: 10_000 }).toBe(1);
		expect(followUpNotices(parent.session.messages)[0]?.details).toMatchObject({ kind: "cancelled", childId });
	});
});
