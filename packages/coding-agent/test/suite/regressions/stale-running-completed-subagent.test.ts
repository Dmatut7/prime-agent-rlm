/**
 * Regression: a subagent that has finished its turn must leave the Running section even while its
 * Python kernel still hosts a live `bash()` handle.
 *
 * Incident shape (docs/fork/stale-running-subagent-status.md §1): a depth-1 subagent replied, its
 * `rlm-subagent.json` went `completed`, and a background rig host it had started with `bash()` stayed
 * alive. Seven hours later its row was still in Running with a blinking icon, because the roster's
 * busy term reads the *residency* axis:
 *
 *   agent-roster.ts classifySessionRosterStatus
 *     busy = summary.activity === "working" || summary.isSessionActive === true
 *   daemon-session-list.ts summaryForActiveSession
 *     isSessionActive = session.isSessionActive || session.isKernelWorkInFlight === true   (r44)
 *
 * That fold is load-bearing for eviction and stays (r44 carrier 2, locked by
 * test/suite/live-kernel-work-residency.test.ts). The fix narrows what the *section* reads to the
 * display axis, so this pin walks the whole classification chain, asserts the row lands in Idle, and
 * asserts the eviction gate stays shut on the residency axis in the same breath.
 *
 * Chain walked here - every hop is the production code, no summary literals and no reimplemented
 * classifier:
 *
 *   AgentSession (faux-provider turn; kernel facts through the harness `kernelResidencyFacts` seam)
 *     -> buildSessionList              worker    modes/daemon/daemon-session-list.ts
 *     -> workerRosterEntryFromSummary  worker    modes/daemon/agent-roster.ts
 *     -> AgentRoster.write             supervisor (classifies once)
 *     -> sessionSummaryFromRosterEntry client    modes/daemon/agent-roster.ts
 *     -> reconcileUnifiedSessions      client    modes/agents-view/agents-view-state.ts
 *     -> buildAgentsViewRows           client    row.section, runningSubagentCount, subagent-summary
 *
 * The tree is three sessions deep (root -> mid -> leaf) because two of the pins are about the sides
 * of the stuck row that are not the stuck row: `runningSubagentCount` tallies a child's section
 * (agents-view-state.ts:1076) and the `subagent-summary` row inherits `parent.section`
 * (agents-view-state.ts:1154). So the stuck session has to be somebody's child (for the count) and
 * somebody's parent (for the summary row). A depth-2 subtree is the ordinary shape in this project,
 * not a contrived one.
 *
 * The kernel handle is injected through the harness's `kernelResidencyFacts` seam, exactly like
 * live-kernel-work-residency.test.ts does; no real background process is started.
 *
 * About the `rlm-subagent.json` assertion. The writer is
 * `AgentDaemon.createSubagentRuntimeHost().completeRlmSubagentRuntime` (daemon-mode.ts:2719), and the
 * only in-repo way to drive a real `AgentDaemon` is test/daemon-mode.test.ts's
 * `daemon as unknown as { sessions; createRlmSubagentRuntime(...) }` - frozen private-internals stock
 * that AGENTS.md forbids in a new file. So the host injected here mirrors that hook instead: the
 * *call* is production-driven (`AgentSession.registerRlmChildSession`, agent-session.ts:16198, fires
 * it once the child's turn and its RLM quiescence are done - the exact moment the daemon persists
 * `status: "completed"`), and the sink is the real exported writer handed the real
 * (childId, session, sessionDir). The pins read the file back through the real reader after dropping
 * the module cache, so "the terminal state is on disk" is a disk fact rather than a shaped literal,
 * and "this subagent really finished" rests on that call plus the two session-level input facts
 * asserted below (`isSessionActive === false`, `isKernelWorkInFlight === true`).
 */

import { dirname } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import type { AgentSessionRuntime, AgentSessionRuntimeMetadata } from "../../../src/core/agent-session-runtime.js";
import type { SubagentRuntimeHost } from "../../../src/core/rlm-runtime.js";
import { canEvictWorker, type WorkerEvictionSnapshot } from "../../../src/core/session-action-store.js";
import { canonicalSessionPath } from "../../../src/core/session-lease.js";
import type { AgentStatus } from "../../../src/core/session-manager.js";
import {
	type AgentsViewRow,
	buildAgentsViewRows,
	reconcileUnifiedSessions,
} from "../../../src/modes/agents-view/agents-view-state.js";
import type { ActiveSessionState } from "../../../src/modes/daemon/active-session-state.js";
import {
	AgentRoster,
	type AgentRosterEntry,
	isSessionSummaryBusy,
	sessionSummaryFromRosterEntry,
	workerRosterEntryFromSummary,
} from "../../../src/modes/daemon/agent-roster.js";
import { buildSessionList, type SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import {
	readRlmSubagentDisplayEntry,
	resetRlmSubagentDisplayCache,
	writeRlmSubagentDisplayEntry,
} from "../../../src/modes/daemon/rlm-subagent-display.js";
import { createHarness, type Harness } from "../harness.js";

const MID_TASK = "reproduce the refund run and report back";
const LEAF_TASK = "collect the transcript for the refund run";
const MID_REPLY = "mid: reproduced, evidence is on disk";
const LEAF_REPLY = "leaf: transcript collected";
const ROOT_ACTIVE_SESSION_ID = "active-root";
const MID_ACTIVE_SESSION_ID = "active-mid";
const LEAF_ACTIVE_SESSION_ID = "active-leaf";
const WORKER_ID = "worker-under-test";
/** The idle sweep's threshold, and a "now" past it, as daemon-supervisor.ts's sweep evaluates. */
const SWEEP_IDLE_MINUTES = 90;
const SWEEP_MARGIN_MS = 95 * 60_000;
const WAIT_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 60_000;

/** Turn over, kernel still owns a live bash() handle: the r44 residency fact, display-idle. */
const HOSTING_KERNEL_HANDLE = { hasActiveExecution: false, isKernelBashRunning: true };
/** No kernel at all: the negative control on the residency fact. */
const NO_KERNEL = () => undefined;

const tracked: Harness[] = [];

function track(harness: Harness): Harness {
	tracked.push(harness);
	return harness;
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out after ${WAIT_TIMEOUT_MS}ms waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * Quiet-transcript settle. `run.status` flips to "done" *before* the terminal notice is delivered and
 * before `registerRlmChildSession` fires, so "no running children" alone does not mean the parent's
 * transcript stopped growing - and the parent's display axis (`activeActivityForSession`) reads a
 * summarizer verdict keyed on message count. Wait for the count to stop moving instead of sampling it
 * at an arbitrary moment.
 */
async function waitForStableMessageCount(session: AgentSession, what: string): Promise<void> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	let previous = -1;
	let quietReads = 0;
	while (quietReads < 6) {
		const count = session.messages.length;
		quietReads = count === previous ? quietReads + 1 : 0;
		previous = count;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} to stop growing`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

interface CompletionRecord {
	childId: string;
	session: AgentSession;
}

interface SubagentTree {
	root: Harness;
	mid: Harness;
	leaf: Harness;
	midChildId: string;
	leafChildId: string;
	/** Completion hooks the production spawn path fired, in the order it fired them. */
	completions: CompletionRecord[];
	/** Only set for the in-flight tree: lets the held turn end before disposal. */
	releaseMidTurn?: () => void;
	states(): ActiveSessionState[];
}

/**
 * root (top-level) -> mid (the subagent under test) -> leaf (mid's own finished subagent).
 *
 * `midTurn: "in-flight"` holds mid's provider response on a deferred promise so the same shape can be
 * classified while the turn is genuinely running - the positive control that keeps the case honest.
 */
async function spawnTree(options: { midTurn: "finished" | "in-flight"; kernelHandle: boolean }): Promise<SubagentTree> {
	const completions: CompletionRecord[] = [];
	/**
	 * Mirrors AgentDaemon.createSubagentRuntimeHost (daemon-mode.ts:2716-2747): record the call the
	 * session layer makes and persist the terminal entry through the real writer, into the child's own
	 * session dir (`metadata.sessionDir ?? dirname(sessionFile)` in the daemon; the harness child has no
	 * artifact dir of its own, so the fallback is the faithful branch here).
	 */
	function runtimeHostFor(child: () => AgentSession): SubagentRuntimeHost {
		return {
			createRlmSubagentRuntime: async () => ({ session: child() }),
			completeRlmSubagentRuntime: (childId, session) => {
				completions.push({ childId, session });
				const sessionFile = session.sessionFile;
				if (!sessionFile) return false;
				const sessionDir = dirname(sessionFile);
				writeRlmSubagentDisplayEntry({
					type: "rlm_subagent",
					childId,
					sessionName: session.sessionName ?? childId,
					sessionDir,
					sessionFile,
					rlmMaxDepth: session.rlmMaxDepth,
					status: "completed",
					createdAt: Date.now(),
					updatedAt: new Date().toISOString(),
				});
				return true;
			},
			deleteRlmSubagentRuntime: async () => {},
		};
	}

	const leaf = track(await createHarness({ rlmDepth: 2, rlmMaxDepth: 3, persistSession: true }));
	let releaseMidTurn: (() => void) | undefined;
	const mid = track(
		await createHarness({
			rlmDepth: 1,
			rlmMaxDepth: 3,
			persistSession: true,
			kernelResidencyFacts: options.kernelHandle ? () => ({ ...HOSTING_KERNEL_HANDLE }) : NO_KERNEL,
			subagentRuntimeHost: runtimeHostFor(() => leaf.session),
		}),
	);
	const root = track(
		await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 3,
			persistSession: true,
			kernelResidencyFacts: NO_KERNEL,
			subagentRuntimeHost: runtimeHostFor(() => mid.session),
		}),
	);

	// mid's own finished subagent first, so mid is a parent as well as a child.
	leaf.setResponses([fauxAssistantMessage(LEAF_REPLY)]);
	const leafSpawn = await mid.session.runRlmChild(LEAF_TASK, { name: "leaf-worker" });
	await waitFor(
		() => completions.some((completion) => completion.childId === leafSpawn.rlm_child_id),
		"leaf's completion hook",
	);

	if (options.midTurn === "finished") {
		mid.setResponses([fauxAssistantMessage(MID_REPLY)]);
	} else {
		mid.setResponses([
			() =>
				new Promise<AssistantMessage>((resolve) => {
					releaseMidTurn = () => resolve(fauxAssistantMessage(MID_REPLY));
				}),
		]);
	}
	const midSpawn = await root.session.runRlmChild(MID_TASK, { name: "mid-worker" });
	if (options.midTurn === "finished") {
		await waitFor(
			() => completions.some((completion) => completion.childId === midSpawn.rlm_child_id),
			"mid's completion hook",
		);
		await waitFor(() => !mid.session.isSessionActive, "mid's turn to end");
	} else {
		await waitFor(() => mid.session.isSessionActive, "mid's turn to be in flight");
	}
	await waitForStableMessageCount(root.session, "root's transcript");
	await waitForStableMessageCount(mid.session, "mid's transcript");

	return {
		root,
		mid,
		leaf,
		midChildId: midSpawn.rlm_child_id,
		leafChildId: leafSpawn.rlm_child_id,
		completions,
		...(releaseMidTurn ? { releaseMidTurn } : {}),
		states() {
			return [
				// The parent chat is done with its turn and already judged: a current verdict is what
				// makes the root row idle on the display axis, so the only Running claim left in the tree
				// is the one under test. `summaryState` is a public field of ActiveSessionState; the
				// daemon fills it from the summarizer.
				activeState(
					root.session,
					ROOT_ACTIVE_SESSION_ID,
					{ kind: "top-level", createdAt: Date.now() },
					currentVerdictFor(root.session),
				),
				activeState(mid.session, MID_ACTIVE_SESSION_ID, {
					kind: "subagent",
					createdAt: Date.now(),
					parentActiveSessionId: ROOT_ACTIVE_SESSION_ID,
					parentSessionId: root.session.sessionId,
					parentSessionFile: root.session.sessionFile,
					rlmChildId: midSpawn.rlm_child_id,
					prompt: MID_TASK,
					// Deliberately no summaryState: a finished subagent never gets a summarizer verdict
					// (daemon-session-list.ts:458-462), and that early return is part of what this pin
					// covers - deleting it must turn the display axis back to "working".
				}),
				activeState(leaf.session, LEAF_ACTIVE_SESSION_ID, {
					kind: "subagent",
					createdAt: Date.now(),
					parentActiveSessionId: MID_ACTIVE_SESSION_ID,
					parentSessionId: mid.session.sessionId,
					parentSessionFile: mid.session.sessionFile,
					rlmChildId: leafSpawn.rlm_child_id,
					prompt: LEAF_TASK,
				}),
			];
		},
	};
}

function currentVerdictFor(session: AgentSession): AgentStatus {
	return {
		summary: "handed the work off and is waiting",
		taskState: "completed",
		basedOnMessageCount: session.messages.length,
	};
}

/**
 * The daemon-only wrapper around a real session, in the shape flushRoster snapshots. Only `runtime` is
 * cast: `AgentSessionRuntime` is a class the daemon builds through its runtime factory, and the four
 * members `summaryForActiveSession` reads off it are supplied literally. No private member is reached
 * into - this is the same structural seam live-kernel-work-residency.test.ts uses.
 */
function activeState(
	session: AgentSession,
	activeSessionId: string,
	metadata: AgentSessionRuntimeMetadata,
	summaryState?: AgentStatus,
): ActiveSessionState {
	const runtime = {
		metadata,
		modelFallbackMessage: undefined,
		diagnostics: [],
		session,
	} as unknown as AgentSessionRuntime;
	return {
		activeSessionId,
		runtime,
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: "test-generation",
		lastEventSequence: 0,
		...(summaryState ? { summaryState } : {}),
	};
}

interface ClassificationPipeline {
	/** Worker side: what flushRoster would put on the wire. */
	workerSummaries: SessionSummary[];
	/** Supervisor side: AgentRoster.write classified each entry once. */
	rosterEntries: AgentRosterEntry[];
	/** Client side: rosterStatus is now the section's data source. */
	clientSummaries: SessionSummary[];
	rows: AgentsViewRow[];
}

function classifyThroughTheChain(states: readonly ActiveSessionState[]): ClassificationPipeline {
	const workerSummaries = buildSessionList(states, [], []);
	const roster = new AgentRoster(canonicalSessionPath);
	const rosterEntries = workerSummaries.map((summary) =>
		roster.write(workerRosterEntryFromSummary(summary), WORKER_ID),
	);
	const clientSummaries = rosterEntries.map((entry) => sessionSummaryFromRosterEntry(entry));
	const records = reconcileUnifiedSessions(clientSummaries, []);
	// Expand every parent: buildAgentsViewRows only emits a child row (and its subagent-summary row)
	// under an expanded parent, and the pins are about the child side of the tree.
	const rows = buildAgentsViewRows(records, new Set(records.map((record) => record.identity)));
	return { workerSummaries, rosterEntries, clientSummaries, rows };
}

function workerSummaryFor(pipeline: ClassificationPipeline, sessionId: string): SessionSummary {
	const summary = pipeline.workerSummaries.find((candidate) => candidate.sessionId === sessionId);
	if (!summary) throw new Error(`no worker summary for session ${sessionId}`);
	return summary;
}

function rosterEntryFor(pipeline: ClassificationPipeline, sessionId: string): AgentRosterEntry {
	const entry = pipeline.rosterEntries.find((candidate) => candidate.summary.sessionId === sessionId);
	if (!entry) throw new Error(`no roster entry for session ${sessionId}`);
	return entry;
}

function sessionRow(rows: readonly AgentsViewRow[], sessionId: string): AgentsViewRow {
	const row = rows.find(
		(candidate) => candidate.kind !== "subagent-summary" && candidate.summary.sessionId === sessionId,
	);
	if (!row) throw new Error(`no agents-view row for session ${sessionId}`);
	return row;
}

function subagentSummaryRows(rows: readonly AgentsViewRow[]): AgentsViewRow[] {
	return rows.filter((row) => row.kind === "subagent-summary");
}

/** The "N subagents" row a parent emits for its own children; it inherits that parent's section. */
function subagentSummaryRowUnder(rows: readonly AgentsViewRow[], parent: AgentsViewRow): AgentsViewRow {
	const row = rows.find(
		(candidate) => candidate.kind === "subagent-summary" && candidate.parentIdentity === parent.identity,
	);
	if (!row) throw new Error(`no subagent-summary row under parent ${parent.identity}`);
	return row;
}

/**
 * daemon-supervisor.ts workerEvictionSnapshot, rebuilt from the same inputs: roster entries through
 * sessionSummaryFromRosterEntry, then isSessionSummaryBusy into the eviction row. The kernel term has
 * no field of its own here - it rides inside isSessionActive, which is r44 carrier 2.
 */
function workerEvictionSnapshot(rosterEntries: readonly AgentRosterEntry[]): WorkerEvictionSnapshot {
	return {
		lifecycle: "ready",
		isConnected: true,
		isStopping: false,
		hasOwnerClient: false,
		isPreparingUpdateRestart: false,
		hasWakeBlindSchedule: false,
		sessions: rosterEntries.map(sessionSummaryFromRosterEntry).map((summary) => ({
			isSessionActive: isSessionSummaryBusy(summary),
			attachedClients: summary.attachedClients,
			hasRegisteredCronJob: summary.hasRegisteredCronJob === true,
			lastActivityAt: Date.parse(summary.lastActivityAt ?? ""),
		})),
	};
}

/**
 * 95 minutes past the tree's newest activity: the shape the 90-minute sweep evaluates. Computed from
 * the real summaries so the eviction pin cannot pass on a NaN or a fresh timestamp - either would make
 * `canEvictWorker` false for a reason that has nothing to do with the kernel term.
 */
function sweepNowAfter(summaries: readonly SessionSummary[]): number {
	expect(summaries.length).toBeGreaterThan(0);
	const stamps = summaries.map((summary) => Date.parse(summary.lastActivityAt ?? ""));
	expect(stamps.filter((stamp) => Number.isFinite(stamp))).toHaveLength(summaries.length);
	return Math.max(...stamps) + SWEEP_MARGIN_MS;
}

describe("stale Running row: a completed subagent whose kernel still hosts a live bash handle", () => {
	let tree: SubagentTree;
	let pipeline: ClassificationPipeline;
	let midWorkerSummary: SessionSummary;

	beforeAll(async () => {
		tree = await spawnTree({ midTurn: "finished", kernelHandle: true });
		pipeline = classifyThroughTheChain(tree.states());
		midWorkerSummary = workerSummaryFor(pipeline, tree.mid.session.sessionId);
	}, HOOK_TIMEOUT_MS);

	it("input facts: the turn is over while the kernel still owns a live bash handle", () => {
		// Inputs, not conclusions. These two are the facts the incident was made of, and separating
		// them is the whole fix: the turn-level display axis says idle, the residency axis says the
		// kernel is still holding work.
		expect(tree.mid.session.isSessionActive).toBe(false);
		expect(tree.mid.session.isKernelWorkInFlight).toBe(true);
		// The residency fold crosses into the summary untouched (r44 carrier 2): this is the field the
		// roster's busy term used to read as "working".
		expect(midWorkerSummary.isSessionActive).toBe(true);
		expect(isSessionSummaryBusy(midWorkerSummary)).toBe(true);
		// The display axis a finished subagent already reports (daemon-session-list.ts:460-462).
		expect(midWorkerSummary.activity).toBe("idle");
		// The blind spot the kernel term exists for: the host-side bash controllers see nothing.
		expect(midWorkerSummary.isBashRunning).toBe(false);
		// Nothing is delegated and in flight anywhere in the tree, so no run is hiding behind the row.
		expect(tree.root.session.hasRunningRlmChildren()).toBe(false);
		expect(tree.mid.session.hasRunningRlmChildren()).toBe(false);
	});

	it("input facts: the terminal state reached disk before the handle outlived the turn", async () => {
		// Both children completed, and mid's completion hook got mid's own session: this is the
		// production call site that persists `completed` (agent-session.ts registerRlmChildSession).
		expect(tree.completions.map((completion) => completion.childId)).toEqual([tree.leafChildId, tree.midChildId]);
		expect(tree.completions.find((completion) => completion.childId === tree.midChildId)?.session).toBe(
			tree.mid.session,
		);
		const sessionFile = tree.mid.session.sessionFile;
		if (!sessionFile) throw new Error("mid's session never persisted a transcript");
		// Drop the module cache so this is a disk read, not the object the writer handed back.
		resetRlmSubagentDisplayCache();
		const display = await readRlmSubagentDisplayEntry(dirname(sessionFile));
		expect(display?.childId).toBe(tree.midChildId);
		expect(display?.status).toBe("completed");
	});

	it("roster: the finished subagent's row is idle, not running", () => {
		// AgentRoster.write classified this entry through classifySessionRosterStatus: the row the
		// supervisor stores, and the status every agent surface reads.
		expect(rosterEntryFor(pipeline, tree.mid.session.sessionId).status).toBe("idle");
	});

	it("agents view: the finished subagent's row leaves the Running section", () => {
		// reconcileUnifiedSessions -> record.section -> buildAgentsViewRows -> row.section. This is the
		// section that picks the row's bucket, its icon and whether the animation timer keeps redrawing.
		expect(sessionRow(pipeline.rows, tree.mid.session.sessionId).section).toBe("idle");
	});

	it("agents view: the parent counts no running subagent", () => {
		// agents-view-state.ts:1076 tallies a child's section into its parent's badge.
		expect(sessionRow(pipeline.rows, tree.root.session.sessionId).runningSubagentCount).toBe(0);
	});

	it("agents view: no subagent-summary row sits in the Running section", () => {
		const summaryRows = subagentSummaryRows(pipeline.rows);
		// Data-driven guard: an empty list would pass without asserting anything.
		expect(summaryRows.length).toBeGreaterThan(0);
		// Two parents in this tree (root and mid), so two summary rows, and each one inherits its
		// parent's section (agents-view-state.ts:1154). The one that matters is the stuck row's own:
		// it is the collapsed "1 subagent" line a user expands from, and it reads Running off a parent
		// whose turn ended hours ago.
		expect(summaryRows).toHaveLength(2);
		const midRow = sessionRow(pipeline.rows, tree.mid.session.sessionId);
		expect(subagentSummaryRowUnder(pipeline.rows, midRow).section).toBe("idle");
		for (const row of summaryRows) {
			expect(row.section).toBe("idle");
		}
	});

	it("r44: whole-worker eviction stays blocked on the residency axis", () => {
		const snapshot = workerEvictionSnapshot(pipeline.rosterEntries);
		const sweepNow = sweepNowAfter(pipeline.workerSummaries);
		// Non-vacuity: at this "now" every session in the tree is past the 90-minute threshold and has
		// a finite timestamp, so the only term that can hold the worker resident is the busy one. The
		// quiet-kernel control below evicts this exact shape.
		expect(snapshot.sessions).toHaveLength(3);
		expect(snapshot.sessions.filter((session) => session.isSessionActive)).toHaveLength(1);
		expect(canEvictWorker(snapshot, SWEEP_IDLE_MINUTES, sweepNow)).toBe(false);
	});
});

describe("controls: the same chain still says running for live work, and idle without a kernel handle", () => {
	it(
		"a subagent whose turn is still in flight stays running and stays counted",
		async () => {
			const tree = await spawnTree({ midTurn: "in-flight", kernelHandle: true });
			try {
				const pipeline = classifyThroughTheChain(tree.states());
				// The display axis itself says working, so this row must survive the fix unchanged: the pin
				// above is not a blanket downgrade of every subagent.
				expect(tree.mid.session.isSessionActive).toBe(true);
				expect(workerSummaryFor(pipeline, tree.mid.session.sessionId).activity).toBe("working");
				expect(rosterEntryFor(pipeline, tree.mid.session.sessionId).status).toBe("running");
				expect(sessionRow(pipeline.rows, tree.mid.session.sessionId).section).toBe("running");
				expect(sessionRow(pipeline.rows, tree.root.session.sessionId).runningSubagentCount).toBe(1);
			} finally {
				tree.releaseMidTurn?.();
			}
			await waitFor(() => !tree.root.session.hasRunningRlmChildren(), "the released mid turn to settle");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"the same finished subagent with a quiet kernel is idle, and its worker evicts",
		async () => {
			const tree = await spawnTree({ midTurn: "finished", kernelHandle: false });
			const pipeline = classifyThroughTheChain(tree.states());
			const midWorkerSummary = workerSummaryFor(pipeline, tree.mid.session.sessionId);
			expect(tree.mid.session.isKernelWorkInFlight).toBe(false);
			expect(midWorkerSummary.isSessionActive).toBe(false);
			expect(rosterEntryFor(pipeline, tree.mid.session.sessionId).status).toBe("idle");
			expect(sessionRow(pipeline.rows, tree.root.session.sessionId).runningSubagentCount).toBe(0);
			// Every row idle: the chain can say idle for a whole tree, so the case above is red because of
			// the kernel term and not because nothing ever classifies as idle.
			const sessionRows = pipeline.rows.filter((row) => row.kind !== "subagent-summary");
			expect(sessionRows.length).toBeGreaterThan(0);
			for (const row of sessionRows) {
				expect(row.section).toBe("idle");
			}
			// Negative control on the eviction pin: the identical shape with a quiet kernel evicts at the
			// same offset, so the case tree's `false` is the kernel term's doing.
			expect(
				canEvictWorker(
					workerEvictionSnapshot(pipeline.rosterEntries),
					SWEEP_IDLE_MINUTES,
					sweepNowAfter(pipeline.workerSummaries),
				),
			).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);
});

afterAll(() => {
	while (tracked.length > 0) {
		tracked.pop()?.cleanup();
	}
});
