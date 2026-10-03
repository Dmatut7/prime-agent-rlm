/**
 * RLM child collect cluster extracted from agent-session.ts: the typed fan-in
 * (`rlm.collect`) over a parent's direct children - candidate assembly, selector
 * matching, the bounded settlement wait, and the result-envelope builders - plus
 * the daemon-recovery fold for children closed before this session object
 * existed. The moved methods keep exactly the same bodies; they read the session
 * through {@link RlmChildCollectHost}, which `AgentSession` satisfies
 * structurally, so the move changes no runtime behavior.
 */
import { withBound } from "../utils/bounded-wait.js";
import type { AgentSessionMessageController, AgentSessionMessageListResult } from "./agent-messages.js";
import type { AgentSession } from "./agent-session.js";
import {
	compactRlmText,
	type RlmChildRun,
	type RlmChildSnapshotHost,
	readAssistantText,
	rlmChildSnapshotForRun,
	rlmChildSnapshotForSession,
} from "./rlm-child-run.js";
import { type RlmCollectResult, type RlmCollectResultEntry, rlmCollectStallAbort } from "./rlm-runtime.js";
import { loadEntriesFromFileAsync } from "./session-manager.js";

/** Closed-after-idle children kept for `rlm.collect`; each entry is a few hundred bytes. */
export interface ClosedRlmChildCollectEntry {
	entry: RlmCollectResultEntry;
	/** The child's transcript id, so a collect by session id still resolves it. */
	sessionId?: string;
}

interface RlmCollectRunlessChild {
	childId: string;
	child: AgentSession;
}

interface RlmCollectClosedChild {
	childId: string;
	record: ClosedRlmChildCollectEntry;
}

interface RlmCollectCandidates {
	runs: Map<string, RlmChildRun>;
	runlessChildren: RlmCollectRunlessChild[];
	closed: RlmCollectClosedChild[];
}

function rlmRunlessChildMatches({ childId, child }: RlmCollectRunlessChild, target: string): boolean {
	return childId === target || child.sessionId === target || child.sessionName === target;
}

function rlmClosedChildMatches({ childId, record }: RlmCollectClosedChild, target: string): boolean {
	return childId === target || record.sessionId === target || record.entry.session_name === target;
}

/**
 * The seam of `AgentSession` the extracted collect path reads and mutates. Member
 * names mirror the class's own members so the extraction stays a textual
 * `this.` -> `host.` rename; `AgentSession.collectRlmChildren` delegates with
 * `this`.
 */
export interface RlmChildCollectHost extends RlmChildSnapshotHost {
	readonly _activeRlmChildRuns: Map<string, RlmChildRun>;
	readonly _closedRlmChildCollectEntries: Map<string, ClosedRlmChildCollectEntry>;
	readonly _rlmCollectWaits: Map<RlmChildRun, number>;
	_closedRlmChildrenDaemonScanned: boolean;
	readonly _agentMessageController?: AgentSessionMessageController;
	_isRlmChildHiddenFromCollect(childId: string, run?: RlmChildRun): boolean;
	_rememberClosedRlmChild(childId: string, record: ClosedRlmChildCollectEntry): void;
}

/**
 * Typed fan-in for direct RLM children: wait (bounded) for the selected runs to
 * settle and return result envelopes.
 *
 * Never steers the parent, and never rejects on a timeout or a cell abort -
 * both end the wait and return the snapshots as they are, and nothing behind
 * the wait is cancelled, so the caller can end its turn, poll, or retry.
 * `timeoutMs` of 0 is a guaranteed non-blocking read. `targets` are child ids,
 * child session names, or child session ids; an empty list means every direct
 * child that is not being deleted.
 */
export async function collectRlmChildren(
	host: RlmChildCollectHost,
	targets: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RlmCollectResult> {
	let candidates = rlmCollectCandidates(host);
	// A child the daemon closed before this session object existed (the parent was
	// itself closed or restarted) is known only to the daemon. Ask it once per
	// session for a full collect, and again only for a selector nothing local matches.
	const unmatched = targets.some((target) => rlmCollectTargetMatches(host, candidates, target) === 0);
	if (unmatched || (targets.length === 0 && !host._closedRlmChildrenDaemonScanned)) {
		if (targets.length === 0) host._closedRlmChildrenDaemonScanned = true;
		if (await recordClosedRlmChildrenFromDaemon(host, candidates)) candidates = rlmCollectCandidates(host);
	}
	const selected = selectRlmChildrenForCollect(host, targets, candidates);
	if (timeoutMs > 0) {
		const deadlineAt = Date.now() + timeoutMs;
		const awaited = selected.runs.filter((run) => !run.settled);
		// The cell blocked on this wait is silent by design while the child works; the
		// silent-step rule reads these to tell that from a hang (see _rlmCollectWaitsOnLiveChild).
		for (const run of awaited) host._rlmCollectWaits.set(run, (host._rlmCollectWaits.get(run) ?? 0) + 1);
		try {
			// allSettled on purpose: one run's timeout or abort must not strand the
			// other waits, and a settlement rejection is terminal state to report,
			// not a collect error.
			await Promise.allSettled(awaited.map((run) => awaitRlmChildSettlementForCollect(run, deadlineAt, signal)));
		} finally {
			for (const run of awaited) {
				const count = (host._rlmCollectWaits.get(run) ?? 1) - 1;
				if (count > 0) host._rlmCollectWaits.set(run, count);
				else host._rlmCollectWaits.delete(run);
			}
		}
	}
	return {
		results: [
			...selected.runs.map((run) => rlmCollectEntryForRun(host, run)),
			...selected.runlessChildren.map(({ childId, child }) => rlmCollectEntryForSession(host, childId, child)),
			...selected.closed.map(({ record }) => ({ ...record.entry })),
		],
	};
}

/**
 * The children one collect call may see.
 *
 * Four sources, because terminal cleanup, daemon recovery and idle close each
 * move a child out of one of them: a run in flight, a settled run retained next
 * to its session, a session retained without any run (rehydrated after a daemon
 * recovery), and a finished child the daemon closed after it sat idle. The full
 * roster view (includeTerminal) shows all of them, so a fan-in that saw less
 * would report a finished child as unknown. Children pending deletion - or whose
 * deletion cleanup failed - stay out: the delete path owns their selectors.
 */
function rlmCollectCandidates(host: RlmChildCollectHost): RlmCollectCandidates {
	const runs = new Map<string, RlmChildRun>();
	for (const run of host._activeRlmChildRuns.values()) {
		if (host._isRlmChildHiddenFromCollect(run.id, run)) continue;
		runs.set(run.id, run);
	}
	const runlessChildren: RlmCollectRunlessChild[] = [];
	for (const [childId, retained] of host._rlmChildSessions) {
		if (host._isRlmChildHiddenFromCollect(childId, retained.run)) continue;
		if (retained.run) {
			// The retained copy is the same run object the active map held, so this
			// only adds a run the terminal cleanup already dropped.
			if (!runs.has(childId)) runs.set(childId, retained.run);
			continue;
		}
		runlessChildren.push({ childId, child: retained.session });
	}
	const closed: RlmCollectClosedChild[] = [];
	for (const [childId, record] of host._closedRlmChildCollectEntries) {
		if (runs.has(childId) || host._rlmChildSessions.has(childId) || host._isRlmChildHiddenFromCollect(childId)) {
			continue;
		}
		closed.push({ childId, record });
	}
	return { runs, runlessChildren, closed };
}

function rlmCollectTargetMatches(host: RlmChildCollectHost, candidates: RlmCollectCandidates, target: string): number {
	let matches = 0;
	for (const run of candidates.runs.values()) {
		if (rlmChildRunMatchesCollectTarget(host, run, target)) matches += 1;
	}
	for (const entry of candidates.runlessChildren) {
		if (rlmRunlessChildMatches(entry, target)) matches += 1;
	}
	for (const entry of candidates.closed) {
		if (rlmClosedChildMatches(entry, target)) matches += 1;
	}
	return matches;
}

function selectRlmChildrenForCollect(
	host: RlmChildCollectHost,
	targets: string[],
	candidates: RlmCollectCandidates = rlmCollectCandidates(host),
): { runs: RlmChildRun[]; runlessChildren: RlmCollectRunlessChild[]; closed: RlmCollectClosedChild[] } {
	const { runs, runlessChildren, closed } = candidates;
	if (targets.length === 0) {
		return { runs: [...runs.values()], runlessChildren, closed };
	}
	const selectedRuns: RlmChildRun[] = [];
	const selectedRunless: RlmCollectRunlessChild[] = [];
	const selectedClosed: RlmCollectClosedChild[] = [];
	const selectedIds = new Set<string>();
	for (const target of targets) {
		const matches = rlmCollectTargetMatches(host, candidates, target);
		if (matches === 0) {
			throw new Error(`No direct RLM child matches "${target}" in the current parent session`);
		}
		if (matches > 1) {
			throw new Error(`RLM child selector "${target}" is ambiguous in the current parent session`);
		}
		// A repeated selector collects the child once, not twice.
		for (const run of runs.values()) {
			if (!rlmChildRunMatchesCollectTarget(host, run, target) || selectedIds.has(run.id)) continue;
			selectedIds.add(run.id);
			selectedRuns.push(run);
		}
		for (const entry of runlessChildren) {
			if (!rlmRunlessChildMatches(entry, target) || selectedIds.has(entry.childId)) continue;
			selectedIds.add(entry.childId);
			selectedRunless.push(entry);
		}
		for (const entry of closed) {
			if (!rlmClosedChildMatches(entry, target) || selectedIds.has(entry.childId)) continue;
			selectedIds.add(entry.childId);
			selectedClosed.push(entry);
		}
	}
	return { runs: selectedRuns, runlessChildren: selectedRunless, closed: selectedClosed };
}

/**
 * Record the daemon's closed direct children that this session has no live or
 * remembered copy of, reading each one's result from its own transcript. Returns
 * whether anything was added. Best effort: a listing or transcript failure leaves
 * the collect with what it already had.
 */
async function recordClosedRlmChildrenFromDaemon(
	host: RlmChildCollectHost,
	candidates: RlmCollectCandidates,
): Promise<boolean> {
	let listed: AgentSessionMessageListResult | undefined;
	try {
		listed = await host._agentMessageController?.listAgents();
	} catch {
		return false;
	}
	const parentActiveSessionId = listed?.current?.activeSessionId;
	if (!listed || !parentActiveSessionId) return false;
	let added = false;
	for (const agent of listed.agents) {
		const childId = agent.rlmChildId;
		if (
			!childId ||
			agent.runtimeKind !== "subagent" ||
			agent.parentActiveSessionId !== parentActiveSessionId ||
			agent.status !== "inactive" ||
			agent.rlmChildRegistryStatus === "deleted" ||
			!agent.sessionDir ||
			candidates.runs.has(childId) ||
			host._rlmChildSessions.has(childId) ||
			host._closedRlmChildCollectEntries.has(childId) ||
			host._isRlmChildHiddenFromCollect(childId)
		) {
			continue;
		}
		const transcript = agent.sessionPath ? await readClosedRlmChildTranscript(agent.sessionPath) : undefined;
		const completed = agent.rlmChildRegistryStatus === "completed";
		host._rememberClosedRlmChild(childId, {
			sessionId: agent.sessionId,
			entry: {
				rlm_child_id: childId,
				session_name: agent.sessionName,
				session_dir: agent.sessionDir,
				status: completed ? "done" : "error",
				settled: true,
				answer_preview: transcript?.answerPreview,
				error: completed ? undefined : "The child was closed before it recorded a finished task",
				duration_ms: undefined,
				tool_use_count: transcript?.toolUseCount,
				replied_since_task: undefined,
				activity_kind: undefined,
				terminal_kind: undefined,
				terminal_reason: undefined,
				stall_abort: undefined,
			},
		});
		added = true;
	}
	return added;
}

async function readClosedRlmChildTranscript(
	sessionPath: string,
): Promise<{ answerPreview?: string; toolUseCount?: number } | undefined> {
	try {
		let answerPreview: string | undefined;
		let toolUseCount = 0;
		for (const entry of await loadEntriesFromFileAsync(sessionPath)) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const text = compactRlmText(readAssistantText(entry.message));
			if (text) answerPreview = text;
			toolUseCount += entry.message.content.filter((block) => block.type === "toolCall").length;
		}
		return { answerPreview, toolUseCount: toolUseCount > 0 ? toolUseCount : undefined };
	} catch {
		return undefined;
	}
}

function rlmChildRunMatchesCollectTarget(host: RlmChildCollectHost, run: RlmChildRun, target: string): boolean {
	const session = run.session ?? host._rlmChildSessions.get(run.id)?.session;
	return (
		run.id === target ||
		run.sessionName === target ||
		session?.sessionId === target ||
		session?.sessionName === target
	);
}

/**
 * Wait for one run to settle, bounded by the collect deadline and by a cell
 * abort. Both a timeout and an abort end the wait quietly: collect reports the
 * facts it has, and the child keeps running either way.
 */
async function awaitRlmChildSettlementForCollect(
	run: RlmChildRun,
	deadlineAt: number,
	signal?: AbortSignal,
): Promise<void> {
	const remainingMs = deadlineAt - Date.now();
	if (run.settled || remainingMs <= 0) return;
	try {
		await withBound(
			// A settlement rejection is the run's terminal state, not a collect error.
			run.settlement.promise.then(
				() => undefined,
				() => undefined,
			),
			{
				timeoutMs: remainingMs,
				phase: "rlm_collect",
				target: run.id,
				label: "RLM child settlement",
				signal,
				targetState: () => run.status,
			},
		);
	} catch {
		// Timeout or abort: fall through to the snapshot the caller asked for.
	}
}

export function rlmCollectEntryForRun(host: RlmChildCollectHost, run: RlmChildRun): RlmCollectResultEntry {
	const child = run.session ?? host._rlmChildSessions.get(run.id)?.session;
	const snapshot = rlmChildSnapshotForRun(host, run, child);
	return {
		rlm_child_id: snapshot.id,
		session_name: snapshot.sessionName,
		session_dir: snapshot.sessionDir,
		status: snapshot.status,
		settled: run.settled,
		answer_preview: snapshot.answerPreview,
		error: snapshot.error,
		duration_ms: snapshot.durationMs,
		tool_use_count: snapshot.toolUseCount,
		replied_since_task: snapshot.repliedSinceTask,
		activity_kind: snapshot.activity?.kind,
		terminal_kind: run.terminalKind,
		terminal_reason: run.terminalReason,
		no_reply_notice_superseded: run.noReplyNoticeSuperseded,
		// Same two sources the terminal classifier reads: the run's own record
		// survives a disposed child session, the child's copy is the fallback for
		// a kill the parent's subscription never observed.
		stall_abort: rlmCollectStallAbort(run.stallAbort ?? child?._lastStallAbort),
	};
}

export function rlmCollectEntryForSession(
	host: RlmChildCollectHost,
	childId: string,
	child: AgentSession,
): RlmCollectResultEntry {
	const snapshot = rlmChildSnapshotForSession(host, childId, child);
	return {
		rlm_child_id: childId,
		session_name: snapshot.sessionName,
		session_dir: snapshot.sessionDir,
		status: snapshot.status,
		// No run exists (the daemon-recovery shape), so there is no settlement to
		// wait for; `activity_kind` is what says whether it is working again.
		settled: true,
		answer_preview: snapshot.answerPreview,
		error: snapshot.error,
		duration_ms: snapshot.durationMs,
		tool_use_count: snapshot.toolUseCount,
		replied_since_task: snapshot.repliedSinceTask,
		activity_kind: snapshot.activity?.kind,
		terminal_kind: undefined,
		terminal_reason: undefined,
		stall_abort: rlmCollectStallAbort(child._lastStallAbort),
	};
}
