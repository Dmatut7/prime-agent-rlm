import type { UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type ActionLifecycle,
	ActionStore,
	canEvictWorker,
	canPassivateSession,
	canSelectSessionAction,
	type DeliveryPolicy,
	type RuntimeActivity,
	type SessionAction,
	type SessionActionPriority,
	transitionSessionAction,
} from "../src/core/session-action-store.js";

let nextId = 0;

function turn(
	text: string,
	delivery: DeliveryPolicy = "when_run_idle",
	priority: SessionActionPriority = "background",
): SessionAction {
	const id = `action-${nextId++}`;
	const message: UserMessage = { role: "user", content: text, timestamp: nextId };
	return {
		id,
		source: "internal",
		delivery,
		priority,
		wake: "external_resume",
		payload: {
			kind: "turn",
			text,
			records: [{ id: `record-${id}`, role: "primary", message, started: false, durable: false, ownerActionId: id }],
		},
		lifecycle: { state: "queued" },
	};
}

function command(
	text: string,
	delivery: DeliveryPolicy = "when_run_idle",
	priority: SessionActionPriority = "background",
): SessionAction {
	return {
		id: `action-${nextId++}`,
		source: "internal",
		delivery,
		priority,
		wake: "immediate",
		payload: {
			kind: "session_command",
			text,
			command: { name: "compact", args: "", text },
		},
		lifecycle: { state: "queued" },
	};
}

function queuedTexts(store: ActionStore, delivery: DeliveryPolicy): string[] {
	return store.queuedActions(delivery).map((action) => action.payload.text);
}

function selectBatch(store: ActionStore, mode: "one-at-a-time" | "all"): SessionAction[] {
	const first = store.selectFirst();
	if (!first) return [];
	if (first.payload.kind === "session_command" || mode === "one-at-a-time") return [first];
	const batch = [first];
	while (store.queuedActions(first.delivery)[0]?.payload.kind === "turn") {
		const next = store.selectFirst();
		if (!next) break;
		batch.push(next);
	}
	return batch;
}

function activity(overrides: Partial<RuntimeActivity> = {}): RuntimeActivity {
	return {
		lowerAgentRun: false,
		compaction: false,
		retry: false,
		bash: false,
		refinementApply: false,
		branchMutation: false,
		schedulerPauseCount: 0,
		disposing: false,
		...overrides,
	};
}

describe("ActionStore selection", () => {
	it("uses structural policy priority and FIFO order within each policy", () => {
		const store = new ActionStore();
		const followUpOne = turn("f1");
		const steerOne = turn("s1", "next_turn_boundary");
		const followUpTwo = turn("f2");
		const steerTwo = turn("s2", "next_turn_boundary");
		for (const action of [followUpOne, steerOne, followUpTwo, steerTwo]) store.enqueue(action);

		expect(store.selectFirst()).toBe(steerOne);
		expect(store.selectFirst()).toBe(steerTwo);
		expect(store.selectFirst()).toBe(followUpOne);
		expect(store.selectFirst()).toBe(followUpTwo);
	});

	it("reads one/all mode at selection time and never batches across a command barrier or policy", () => {
		const store = new ActionStore();
		const first = turn("p1", "next_turn_boundary");
		const second = turn("p2", "next_turn_boundary");
		const barrier = command("/compact", "next_turn_boundary");
		const afterBarrier = turn("p3", "next_turn_boundary");
		const followUp = turn("f1");
		for (const action of [first, second, barrier, afterBarrier, followUp]) store.enqueue(action);

		const mode: "one-at-a-time" | "all" = "all";
		expect(selectBatch(store, mode)).toEqual([first, second]);
		expect(selectBatch(store, mode)).toEqual([barrier]);
		expect(selectBatch(store, "one-at-a-time")).toEqual([afterBarrier]);
		expect(selectBatch(store, mode)).toEqual([followUp]);
	});

	it("does not let an executing /compact see itself as a queued successor", () => {
		const store = new ActionStore();
		const compact = command("/compact");
		store.enqueue(compact);
		expect(store.selectFirst()).toBe(compact);
		transitionSessionAction(compact, { state: "running", execution: "session_command" });

		expect(store.queuedActions()).toEqual([]);
		expect(store.activeActions()).toEqual([compact]);
	});

	it("queues human input ahead of background work and behind earlier human input", () => {
		const store = new ActionStore();
		const agentOne = turn("a1", "next_turn_boundary");
		const agentTwo = turn("a2", "next_turn_boundary");
		const humanOne = turn("h1", "next_turn_boundary", "user");
		const agentThree = turn("a3", "next_turn_boundary");
		const humanTwo = turn("h2", "next_turn_boundary", "user");
		for (const action of [agentOne, agentTwo, humanOne, agentThree, humanTwo]) store.enqueue(action);

		// Human input overtakes queued machine traffic; machine-to-machine order is untouched.
		expect(store.queuedActions("next_turn_boundary")).toEqual([humanOne, humanTwo, agentOne, agentTwo, agentThree]);
	});

	it("never inserts ahead of an action that already left the queue", () => {
		const store = new ActionStore();
		const running = turn("running", "next_turn_boundary");
		const agent = turn("a1", "next_turn_boundary");
		store.enqueue(running);
		store.enqueue(agent);
		expect(store.selectFirst()).toBe(running);
		const human = turn("h1", "next_turn_boundary", "user");
		store.enqueue(human);

		expect(store.ownedActions()).toEqual([running, human, agent]);
	});

	it("keeps pinned actions ahead of later human input", () => {
		const store = new ActionStore();
		const agent = turn("a1");
		store.enqueue(agent);
		const pinned = turn("goal context", "when_run_idle", "pinned");
		store.enqueue(pinned, "front");
		const human = turn("h1", "when_run_idle", "user");
		store.enqueue(human);

		expect(store.queuedActions()).toEqual([pinned, human, agent]);
	});

	it("appends restored actions verbatim", () => {
		const store = new ActionStore();
		const agent = turn("a1");
		const human = turn("h1", "when_run_idle", "user");
		store.enqueue(agent, "tail");
		store.enqueue(human, "tail");

		expect(store.queuedActions()).toEqual([agent, human]);
	});

	it("keeps the lane ahead of priority: a human follow-up never overtakes a queued steering reply", () => {
		// r39 QP-4 x #2334: the lane is the first axis, priority the second one. A human
		// follow-up outranks machine traffic inside its own lane and nothing more.
		const store = new ActionStore();
		const agentReply = turn("child reply", "next_turn_boundary");
		store.enqueue(agentReply);
		const humanFollowUp = turn("human follow-up", "when_run_idle", "user");
		store.enqueue(humanFollowUp);

		expect(store.selectFirst()).toBe(agentReply);
		expect(store.queuedActions("when_run_idle")).toEqual([humanFollowUp]);
	});

	it("never re-sorts a queue the user reordered by hand", () => {
		// Ctrl+Alt+Up/Down is an explicit instruction about these items; a later arrival
		// picks an insertion point and leaves the existing relative order alone. The hand
		// move crosses priority ranks on purpose: three equal ranks survive any stable
		// re-sort unchanged, so a same-rank reorder cannot tell "left alone" from
		// "re-sorted by rank behind the user's back" (#2334 review, mutation M6).
		const store = new ActionStore();
		const receipt = turn("b1", "when_run_idle");
		const first = turn("h1", "when_run_idle", "user");
		store.enqueue(receipt);
		store.enqueue(first);
		// Arrival order alone would leave [b1, h1]; the priority axis puts the human first.
		expect(store.queuedActions("when_run_idle")).toEqual([first, receipt]);

		// The user moves the machine receipt ahead of their own prompt.
		store.moveQueued(receipt, "when_run_idle", 0);
		expect(store.queuedActions("when_run_idle")).toEqual([receipt, first]);

		// A later human arrival takes an insertion point behind the hand-placed pair:
		// equal rank stays FIFO, and the backward scan stops at the first queued entry
		// whose rank is already >= the arrival's, so it never crosses the moved receipt.
		const second = turn("h2", "when_run_idle", "user");
		store.enqueue(second);
		expect(store.queuedActions("when_run_idle")).toEqual([receipt, first, second]);

		// A machine arrival does not climb over the hand-set order either.
		const background = turn("b2", "when_run_idle");
		store.enqueue(background);
		expect(store.queuedActions("when_run_idle")).toEqual([receipt, first, second, background]);

		// The property itself, stated independently of the exact insertion points: the pair
		// the user ordered by hand keeps its relative order through every later arrival.
		const order = store.queuedActions("when_run_idle");
		expect(order.indexOf(receipt)).toBeLessThan(order.indexOf(first));
	});

	it("never lets a rank re-sort undo a hand swap across ranks", () => {
		// `swapQueued` is the primitive Ctrl+Alt+Up/Down actually drives
		// (`mutateQueuedMessage(..., { type: "move" })` -> `swapQueued`), so it is where a
		// "keep the lane ranked" change would land. Swapping a background receipt past a
		// user prompt is the only shape that can distinguish such a re-sort from leaving
		// the queue alone (#2334 review, mutation M6: a lane-wide `PRIORITY_RANK` sort
		// appended to `swapQueued` must turn this red).
		const store = new ActionStore();
		const receipt = turn("b1", "next_turn_boundary");
		const human = turn("h1", "next_turn_boundary", "user");
		store.enqueue(receipt);
		store.enqueue(human);
		expect(store.queuedActions("next_turn_boundary")).toEqual([human, receipt]);

		store.swapQueued(receipt, human);
		expect(store.queuedActions("next_turn_boundary")).toEqual([receipt, human]);

		// Later arrivals of both ranks pick insertion points; neither re-sorts the lane.
		store.enqueue(turn("h2", "next_turn_boundary", "user"));
		store.enqueue(turn("b2", "next_turn_boundary"));
		expect(queuedTexts(store, "next_turn_boundary")).toEqual(["b1", "h1", "h2", "b2"]);

		// The lane stays the first axis (r39 QP-4): a hand reorder in one lane is untouched
		// by arrivals in the other, and reordering is never a way to jump a lane.
		store.enqueue(turn("f-h1", "when_run_idle", "user"));
		store.enqueue(turn("f-b1", "when_run_idle"));
		expect(queuedTexts(store, "next_turn_boundary")).toEqual(["b1", "h1", "h2", "b2"]);
		expect(queuedTexts(store, "when_run_idle")).toEqual(["f-h1", "f-b1"]);
		expect(store.selectFirst()?.payload.text).toBe("b1");
	});

	it("supports front insertion without changing rollback-at-original-position", () => {
		const store = new ActionStore();
		const selected = turn("selected");
		const tail = turn("tail");
		store.enqueue(selected);
		store.enqueue(tail);
		expect(store.selectFirst()).toBe(selected);
		const front = turn("goal context");
		store.enqueue(front, "front");

		store.rollback(selected);
		expect(store.queuedActions()).toEqual([selected, front, tail]);
	});
});

describe("session action lifecycle", () => {
	it("guards legal transitions and rejects post-dispatch rollback without non-delivery proof", () => {
		const action = turn("hello");
		transitionSessionAction(action, { state: "selected" });
		transitionSessionAction(action, { state: "preparing" });
		transitionSessionAction(action, { state: "committing" });

		expect(() => transitionSessionAction(action, { state: "queued" })).toThrow(/transcript proof/);
		const primary = action.payload.kind === "turn" ? action.payload.records[0] : undefined;
		if (!primary) throw new Error("missing primary record");
		expect(() =>
			transitionSessionAction(
				action,
				{ state: "queued" },
				{ rollbackProof: { dispatchSettled: true, transcript: [primary.message] } },
			),
		).toThrow(/durable/);
		transitionSessionAction(
			action,
			{ state: "queued" },
			{ rollbackProof: { dispatchSettled: true, transcript: [] } },
		);
		expect(action.lifecycle.state).toBe("queued");
	});

	it("enforces the complete legal-transition table", () => {
		const states: ActionLifecycle["state"][] = [
			"queued",
			"selected",
			"preparing",
			"committing",
			"running",
			"completed",
			"failed",
			"cancelled",
		];
		const legal: Record<ActionLifecycle["state"], readonly ActionLifecycle["state"][]> = {
			queued: ["selected", "failed", "cancelled"],
			selected: ["queued", "preparing", "running", "failed", "cancelled"],
			preparing: ["queued", "committing", "failed", "cancelled"],
			committing: ["queued", "running", "failed", "cancelled"],
			running: ["completed", "failed", "cancelled"],
			completed: [],
			failed: [],
			cancelled: [],
		};
		const lifecycle = (state: ActionLifecycle["state"]): ActionLifecycle => {
			if (state === "running") return { state, execution: "agent_turn" };
			if (state === "failed") return { state, error: new Error("failed") };
			return { state };
		};

		for (const from of states) {
			for (const to of states) {
				const action = turn(`${from}-${to}`);
				action.lifecycle = lifecycle(from);
				const transition = () =>
					transitionSessionAction(action, lifecycle(to), {
						rollbackProof:
							from === "committing" && to === "queued" ? { dispatchSettled: true, transcript: [] } : undefined,
					});
				if (legal[from].includes(to)) expect(transition).not.toThrow();
				else expect(transition).toThrow(/Illegal/);
			}
		}
	});

	it("settles each ticket leg at most once", async () => {
		const store = new ActionStore();
		const action = turn("hello");
		store.enqueue(action);
		const controller = store.ticketFor(action);
		expect(controller.settleAccepted({ status: "accepted", actionId: action.id, disposition: "queued" })).toBe(true);
		expect(controller.settleAccepted({ status: "coalesced", existingActionId: action.id })).toBe(false);
		expect(controller.settleDelivered({ status: "delivered" })).toBe(true);
		expect(controller.settleDelivered({ status: "not_applicable" })).toBe(false);
		expect(controller.settleCompleted()).toBe(true);
		expect(controller.settleCompleted(new Error("late"))).toBe(false);

		await expect(controller.ticket.accepted).resolves.toMatchObject({ status: "accepted" });
		await expect(controller.ticket.delivered).resolves.toEqual({ status: "delivered" });
		await expect(controller.ticket.completed).resolves.toBeUndefined();
	});
});

describe("scheduler capabilities", () => {
	it("blocks selection for each overlapping runtime owner", () => {
		expect(canSelectSessionAction(activity())).toBe(true);
		for (const blocked of [
			{ lowerAgentRun: true },
			{ compaction: true },
			{ retry: true },
			{ bash: true },
			{ refinementApply: true },
			{ branchMutation: true },
			{ schedulerPauseCount: 1 },
			{ disposing: true },
		]) {
			expect(canSelectSessionAction(activity(blocked))).toBe(false);
		}
	});
});

describe("whole-tree eviction capability", () => {
	const now = Date.parse("2026-08-01T12:00:00.000Z");
	const idleSession = {
		isSessionActive: false,
		attachedClients: 0,
		hasRegisteredCronJob: false,
		lastActivityAt: now - 90 * 60_000,
	};
	const idleWorker = {
		lifecycle: "ready" as const,
		isConnected: true,
		isStopping: false,
		hasOwnerClient: false,
		isPreparingUpdateRestart: false,
		hasWakeBlindSchedule: false,
		sessions: [idleSession],
	};

	it("evicts only when every session has reached the inclusive idle threshold", () => {
		expect(canEvictWorker(idleWorker, 90, now)).toBe(true);
		expect(
			canEvictWorker(
				{ ...idleWorker, sessions: [idleSession, { ...idleSession, lastActivityAt: now - 89 * 60_000 }] },
				90,
				now,
			),
		).toBe(false);
	});

	it.each([
		["active session", { sessions: [{ ...idleSession, isSessionActive: true }] }],
		[
			"parent session with a running child and stale timestamps",
			// The supervisor's canonical busy projection sets isSessionActive for this snapshot.
			{ sessions: [{ ...idleSession, isSessionActive: true }] },
		],
		["attached client", { sessions: [{ ...idleSession, attachedClients: 1 }] }],
		["cron job", { sessions: [{ ...idleSession, hasRegisteredCronJob: true }] }],
		["session hosting a live kernel bash handle", { sessions: [{ ...idleSession, hasLiveKernelWork: true }] }],
		[
			"worker with one kernel-busy session among idle ones",
			{ sessions: [idleSession, { ...idleSession, hasLiveKernelWork: true }] },
		],
		["missing activity timestamp", { sessions: [{ ...idleSession, lastActivityAt: Number.NaN }] }],
		["owner client", { hasOwnerClient: true }],
		["wake-blind schedule", { hasWakeBlindSchedule: true }],
		["update preparation", { isPreparingUpdateRestart: true }],
		["disconnected worker", { isConnected: false }],
		["stopping worker", { isStopping: true }],
		["starting worker", { lifecycle: "starting" as const }],
		["recovering worker", { lifecycle: "recovering" as const }],
		["empty worker", { sessions: [] }],
	])("rejects a pinned or unavailable %s", (_name, overrides) => {
		expect(canEvictWorker({ ...idleWorker, ...overrides }, 90, now)).toBe(false);
	});

	it("treats off and invalid thresholds as disabled", () => {
		expect(canEvictWorker(idleWorker, "off", now)).toBe(false);
		expect(canEvictWorker(idleWorker, 0, now)).toBe(false);
		expect(canEvictWorker(idleWorker, Number.NaN, now)).toBe(false);
	});
});

describe("child passivation capability", () => {
	const now = Date.parse("2026-08-01T12:00:00.000Z");
	const idleChild = {
		isSessionActive: false,
		attachedClients: 0,
		hasRegisteredCronJob: false,
		lastActivityAt: now - 90 * 60_000,
		hasParent: true,
		hasNonPassiveDescendants: false,
		isHydrating: false,
	};

	it("accepts an idle leaf child at the shared inclusive threshold", () => {
		expect(canPassivateSession(idleChild, 90, now)).toBe(true);
	});

	it.each([
		["root", { hasParent: false }],
		["child with a resident descendant", { hasNonPassiveDescendants: true }],
		["hydrating child", { isHydrating: true }],
		["busy child", { isSessionActive: true }],
		["child hosting live kernel bash work", { hasLiveKernelWork: true }],
		["attached child", { attachedClients: 1 }],
		["cron child", { hasRegisteredCronJob: true }],
		["recent child", { lastActivityAt: now - 89 * 60_000 }],
		["child without activity time", { lastActivityAt: Number.NaN }],
	])("rejects a %s", (_name, override) => {
		expect(canPassivateSession({ ...idleChild, ...override }, 90, now)).toBe(false);
	});

	it("holds a child whose kernel hosts live work while everything at the turn level reads idle", () => {
		// The r44 form A shape: the turn ended, no host-side bash controller is live, and the
		// kernel still owns a background script's process group. Closing the session closes the
		// kernel, which SIGTERMs that group, so the kernel fact alone must block the passivation.
		const kernelBusy = { ...idleChild, isSessionActive: false, hasLiveKernelWork: true };
		expect(canPassivateSession(kernelBusy, 90, now)).toBe(false);

		// Positive control: with the kernel term reporting no work - false, or absent because the
		// snapshot's author cannot observe a kernel - the very same child passivates as before.
		expect(canPassivateSession({ ...kernelBusy, hasLiveKernelWork: false }, 90, now)).toBe(true);
		expect(canPassivateSession({ ...kernelBusy, hasLiveKernelWork: undefined }, 90, now)).toBe(true);
	});

	it("shares the whole-tree off and invalid threshold behavior", () => {
		expect(canPassivateSession(idleChild, "off", now)).toBe(false);
		expect(canPassivateSession(idleChild, 0, now)).toBe(false);
		expect(canPassivateSession(idleChild, Number.NaN, now)).toBe(false);
	});
});
