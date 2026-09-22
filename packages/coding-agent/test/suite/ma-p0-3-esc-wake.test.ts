/**
 * P0-3b: after an Esc, a family of failing subagents must wake the parent once,
 * not once per failure - and ordinary replies must not wake it at all.
 *
 * Red at HEAD: `queueAgentMessagePrompt` resumed the suspended pump for every
 * queued message, and each deferred terminal notice was admitted as its own turn,
 * so one Esc could be answered by N subagent failures each re-igniting the parent
 * (N-3). Queued messages also counted as unfinished work, which pinned the
 * session - and therefore the whole worker - resident after an Esc (I-2).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
} from "../../src/core/agent-messages.js";
import {
	type CustomMessage,
	createRlmChildTerminalNoticeMessage,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
} from "../../src/core/messages.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.js";

function gateTool(released: Promise<void>): AgentTool {
	return {
		name: "gate",
		label: "Gate",
		description: "Returns once the test releases it",
		parameters: Type.Object({}),
		execute: async () => {
			await released;
			return { content: [{ type: "text" as const, text: "released" }], details: {} };
		},
	};
}

function payload(id: string, message: string): AgentSessionMessagePayload {
	return {
		id,
		source: AGENT_MESSAGE_SOURCE,
		message,
		from: { activeSessionId: "child-active", sessionId: "child-session", sessionName: "Child" },
		target: { activeSessionId: "parent-active", sessionId: "parent-session" },
	};
}

function failureNotices(session: { messages: readonly unknown[] }): CustomMessage[] {
	return session.messages.filter(
		(message): message is CustomMessage =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === RLM_CHILD_FAILURE_CUSTOM_TYPE,
	);
}

interface FailingFamily {
	parent: Harness;
	release(): void;
	names: string[];
}

describe("P0-3b Esc, failure wakes and queue pinning", () => {
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

	/** A parent with N children parked inside a tool, ready to fail on release. */
	async function createFailingFamily(
		count: number,
		parentOptions: { failureWakeQuietWindowMs?: number } = {},
	): Promise<FailingFamily> {
		let releaseGate = () => {};
		const released = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const names = Array.from({ length: count }, (_, index) => `worker-${index + 1}`);
		const children = new Map<string, Harness>();
		for (const name of names) {
			const child = track(
				await createHarness({
					rlmDepth: 1,
					tools: [gateTool(released)],
					settings: { retry: { enabled: false } },
					agentMessageController: {
						listAgents: () => ({ agents: [] }),
						// No roster, so the child cannot deliver its own terminal-error
						// notice: the synthesized failure notice is the only report and
						// the aggregation path is what has to handle it.
						sendAgentMessage: vi.fn(async () => {
							throw new Error("synthesized terminal notices must not use agent_message");
						}),
					},
				}),
			);
			child.setResponses([
				fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: `${name} exploded` }),
			]);
			children.set(name, child);
		}
		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				failureWakeQuietWindowMs: parentOptions.failureWakeQuietWindowMs,
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async (options) => ({
						session: children.get(options.sessionName)!.session,
					}),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		parent.setResponses([fauxAssistantMessage("parent handled the failures")]);
		for (const name of names) {
			void parent.session.runRlmChild(`task for ${name}`, { name });
		}
		await vi.waitFor(() => expect(parent.session.getRlmChildSnapshots().length).toBe(count), {
			timeout: 15_000,
			interval: 20,
		});
		return { parent, release: releaseGate, names };
	}

	it("wakes once with an aggregated notice when a family fails after an Esc", async () => {
		const family = await createFailingFamily(3);
		const { parent } = family;

		// The Esc: the pump is suspended, so nothing may start a turn.
		parent.session.requestAbort();
		expect(parent.session.isQueuedWorkSuspended).toBe(true);

		family.release();

		// Precondition (accmath ②): prove the three failures actually reached the
		// parent before asserting how many turns they produced - otherwise "0 wakes"
		// would pass for the wrong reason.
		await vi.waitFor(
			() => {
				const deferred = parent.session.getPendingNextTurnMessageSnapshots();
				expect(deferred.filter((message) => message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE)).toHaveLength(3);
			},
			{ timeout: 15_000, interval: 20 },
		);
		expect(getAssistantTexts(parent)).toEqual([]);

		// One aggregated turn for the whole family.
		await vi.waitFor(
			() => {
				expect(getAssistantTexts(parent)).toEqual(["parent handled the failures"]);
			},
			{ timeout: 15_000, interval: 20 },
		);
		const wakeTexts = getUserTexts(parent).filter((text) => text.includes("subagents failed"));
		expect(wakeTexts).toHaveLength(1);
		expect(wakeTexts[0]).toContain("3 subagents failed");
		for (const name of family.names) expect(wakeTexts[0]).toContain(name);
		// Every per-child notice still lands, so the failure stays bucket-countable.
		expect(failureNotices(parent.session)).toHaveLength(3);
		expect(parent.session.isQueuedWorkSuspended).toBe(false);
	});

	it("releases the whole queued backlog with that single wake", async () => {
		const family = await createFailingFamily(1);
		const { parent } = family;
		parent.appendResponses([fauxAssistantMessage("drained the backlog"), fauxAssistantMessage("drained again")]);
		parent.session.requestAbort();

		// F11: the wake is pump-level, so it also releases ordinary queued messages.
		// That is the pump's existing semantics and is asserted here as a contract.
		for (const [index, text] of ["first reply", "second reply"].entries()) {
			const message = createAgentSessionMessage(payload(`agentmsg_backlog_${index}`, text));
			await parent.session.acceptAgentMessagePrompt(message.content, {
				expandPromptTemplates: false,
				streamingBehavior: "followUp",
				queueIfBusy: true,
				customMessage: message,
			});
		}
		expect(parent.session.isQueuedWorkSuspended).toBe(true);
		expect(getAssistantTexts(parent)).toEqual([]);

		family.release();

		await vi.waitFor(() => expect(parent.session.queuedActionCount).toBe(0), { timeout: 15_000, interval: 20 });
		await vi.waitFor(() => expect(getAssistantTexts(parent).length).toBeGreaterThanOrEqual(2), {
			timeout: 15_000,
			interval: 20,
		});
		expect(getUserTexts(parent).some((text) => text.includes("subagent failed"))).toBe(true);
	});

	it("does not wake the parent for an ordinary child reply", async () => {
		const harness = track(await createHarness());
		harness.setResponses([fauxAssistantMessage("should not run yet")]);
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		const message = createAgentSessionMessage(payload("agentmsg_ordinary", "ordinary reply"));
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			queueIfBusy: true,
			customMessage: message,
		});

		// Wait past the aggregation window: nothing may wake for an ordinary reply.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		expect(getAssistantTexts(harness)).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([message.content]);

		// I-2: a queue full of undelivered messages must not pin the session (and
		// therefore the worker) resident after an Esc. Red at HEAD: true.
		expect(harness.session.unfinishedActionCount).toBeGreaterThan(0);
		expect(harness.session.isSessionActive).toBe(false);

		// Positive control: a user-driven wake drains the whole queue.
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toEqual(["should not run yet"]), {
			timeout: 5_000,
			interval: 20,
		});
		expect(harness.session.isSessionActive).toBe(false);
	});

	it("stops waking once the quiet window has passed", async () => {
		const family = await createFailingFamily(1, { failureWakeQuietWindowMs: 40 });
		const { parent } = family;
		parent.session.requestAbort();

		// Let the quiet window lapse before the failure arrives.
		await new Promise((resolve) => setTimeout(resolve, 120));
		family.release();

		await vi.waitFor(
			() => {
				expect(parent.session.getPendingNextTurnMessageSnapshots().length).toBeGreaterThan(0);
			},
			{ timeout: 15_000, interval: 20 },
		);
		// Past the total gate the session is not re-ignited; the notice stays
		// deferred for the persistence path (asserted in the T1-10 file).
		await new Promise((resolve) => setTimeout(resolve, 2_600));
		expect(parent.session.isQueuedWorkSuspended).toBe(true);
		expect(getAssistantTexts(parent)).toEqual([]);
		expect(failureNotices(parent.session)).toEqual([]);
	});

	it("keeps the abandonment driver alive for a routine notice left behind by the wake", async () => {
		const family = await createFailingFamily(1);
		const { parent } = family;
		parent.session.requestAbort();
		// A routine notice sharing the queue with the failure that is about to arrive.
		parent.session.restorePendingNextTurnMessages([
			createRlmChildTerminalNoticeMessage({
				kind: "completed_without_reply",
				childId: "child-routine",
				sessionName: "worker-routine",
			}),
		]);
		expect(parent.session.deferredRlmTerminalNoticeSince).toBeTypeOf("number");

		family.release();
		// Wait for the failure to be deferred, then hold a queued-work pause inside the
		// aggregation window: the wake folds the failure into its turn, but the pause
		// stops the wake's flush from delivering the routine notice.
		await vi.waitFor(
			() => {
				expect(parent.session.getPendingNextTurnMessageSnapshots()).toHaveLength(2);
			},
			{ timeout: 15_000, interval: 10 },
		);
		const pause = parent.session.acquireQueuedWorkPause();
		try {
			await vi.waitFor(() => expect(parent.session.isQueuedWorkSuspended).toBe(false), {
				timeout: 15_000,
				interval: 20,
			});
			// The invariant: a notice still in the queue keeps its deferral stamp, so its
			// abandonment driver stays armed. Clearing the stamp on the wake path would
			// strand it forever - pinned residency (FIX-Q2) that can never be dropped
			// (FIX-Q4).
			expect(parent.session.getPendingNextTurnMessageSnapshots()).toHaveLength(1);
			expect(parent.session.deferredRlmTerminalNoticeSince).toBeTypeOf("number");
		} finally {
			pause.release();
		}

		parent.session.requestAbort();
		parent.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + 6 * 60_000);
		// #2386/#33 (57bdfed04): a cancelled turn now hands its undelivered prefix
		// records back, so the Esc above returns the wake's folded failure notice
		// to the deferred queue before the wake turn ever dispatched (its text
		// never reached the transcript). The abandonment driver then settles both
		// classes: the routine notice is abandoned and must not reach the
		// transcript, while the failure notice - the only record the child died -
		// is persisted instead of dropped (the pre-#33 silent drop was the bug).
		expect(parent.session.rlmTerminalNoticeAbandonment).toMatchObject({ count: 2 });
		expect(failureNotices(parent.session)).toHaveLength(1);
		expect(
			parent.session.messages.filter(
				(message) =>
					typeof message === "object" &&
					message !== null &&
					(message as { customType?: unknown }).customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
			),
		).toHaveLength(0);
		expect(parent.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
		expect(parent.session.isSessionActive).toBe(false);
	});

	it("keeps queued messages across an evict/rehydrate round trip", async () => {
		const source = track(await createHarness());
		source.setResponses([fauxAssistantMessage("not consumed yet")]);
		source.session.requestAbort();
		for (const [index, text] of ["queued one", "queued two"].entries()) {
			const message = createAgentSessionMessage(payload(`agentmsg_roundtrip_${index}`, text));
			await source.session.acceptAgentMessagePrompt(message.content, {
				expandPromptTemplates: false,
				streamingBehavior: "followUp",
				queueIfBusy: true,
				customMessage: message,
			});
		}
		expect(source.session.isSessionActive).toBe(false);
		const queuedBefore = source.session.getFollowUpMessages();
		expect(queuedBefore).toHaveLength(2);
		expect(queuedBefore[0]).toContain("queued one");
		expect(queuedBefore[1]).toContain("queued two");

		// The un-pinning above is only safe because queued actions are recoverable:
		// this is the passivate/evict -> rehydrate round trip they travel through.
		const snapshot = source.session.getSessionActionRecoverySnapshot();
		expect(snapshot.actions.length).toBe(2);

		const restored = track(await createHarness());
		restored.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const count = await restored.session.restoreSessionActions(snapshot);
		expect(count).toBe(2);
		const queuedAfter = restored.session.getFollowUpMessages();
		expect(queuedAfter).toHaveLength(2);
		expect(queuedAfter[0]).toContain("queued one");
		expect(queuedAfter[1]).toContain("queued two");
	});
});
