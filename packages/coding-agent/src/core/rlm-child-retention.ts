/**
 * RLM child retention/release cluster extracted from agent-session.ts: retaining a
 * finished child session for the parent lifetime, releasing one to the daemon's idle
 * passivation (publishing the closed record and roster row it leaves behind), removing
 * a child's tracking outright, the retired-run delivery records that late terminal
 * notices are re-validated against, and the live family-state reads built over the
 * retained sessions and active runs (the recursive snapshot list, the direct-child
 * session snapshot, and the running-or-queued judgement). The moved methods keep
 * exactly the same bodies; they read the session through {@link RlmChildRetentionHost},
 * which `AgentSession` satisfies structurally, so the move changes no runtime behavior.
 */
import type { AgentSession, AgentSessionEvent, RlmChildAgentSnapshot } from "./agent-session.js";
import {
	type ClosedRlmChildCollectEntry,
	type RlmChildCollectHost,
	rlmCollectEntryForRun,
	rlmCollectEntryForSession,
} from "./rlm-child-collect.js";
import {
	noopRlmChildAbort,
	noopRlmChildEventUnsubscribe,
	type RlmChildRun,
	rlmChildSnapshotForRun,
	rlmChildSnapshotForSession,
} from "./rlm-child-run.js";
import type { RlmDeleteSubagentResult, RlmSubagentRegistryEntry, SubagentRuntimeHost } from "./rlm-runtime.js";

/** Deleted or released child runs kept for re-validating their late terminal notices. */
const RETIRED_RLM_CHILD_RUNS_MAX = 1024;

/** The verdict fields of a child run that its late terminal notices are re-validated against. */
export type RetiredRlmChildRun = Pick<
	RlmChildRun,
	| "id"
	| "provisionalNoReplyReplyIds"
	| "noReplyVerdictSupersededBy"
	| "noReplyNoticeSuperseded"
	| "provisionalFailureNoticeReplyId"
	| "failureVerdictSupersededBy"
>;

interface ClosedRlmChildRelease {
	record: ClosedRlmChildCollectEntry;
	snapshot: RlmChildAgentSnapshot;
}

/**
 * The seam of `AgentSession` the extracted retention paths read and mutate. Member
 * names mirror the class's own members so the extraction stays a textual
 * `this.` -> `host.` rename; `AgentSession.registerRlmChildSession`,
 * `releaseRlmChildSession`, `_removeRlmSubagentTracking`, `getRlmChildSnapshots`,
 * `hasRunningRlmChildren` and `_rlmChildSessionSnapshot` delegate with `this`.
 */
export interface RlmChildRetentionHost extends RlmChildCollectHost {
	readonly _retiredRlmChildRuns: Map<string, RetiredRlmChildRun>;
	readonly _rlmChildUnsubscribes: Map<string, () => void>;
	readonly _deletedRlmChildIds: Set<string>;
	readonly _deletingRlmChildren: Map<
		string,
		{
			subagent: RlmSubagentRegistryEntry;
			promise: Promise<RlmDeleteSubagentResult>;
		}
	>;
	readonly _rlmChildCleanupFailures: Map<string, RlmSubagentRegistryEntry>;
	readonly _abandonedRlmQuiescenceChildIds: Set<string>;
	readonly _prunedRlmChildIds: Set<string>;
	readonly _disposed: boolean;
	readonly _disposing: boolean;
	readonly _subagentRuntimeHost?: SubagentRuntimeHost;
	_rlmSubtreeSessions(): Generator<AgentSession>;
	_rlmHistoricalChildNamesNow(): Set<string>;
	_stopRlmChildFollowUpWatch(childId: string): void;
	_watchRlmChildFollowUps(childId: string, child: AgentSession): void;
	_emit(event: AgentSessionEvent): void;
}

/**
 * Keep a removed child's delivery record for notice re-validation. Only the
 * verdict fields are copied: holding the run itself would pin its child session
 * and transcript in memory. Bounded, oldest dropped first.
 */
function retireRlmChildRun(host: RlmChildRetentionHost, childId: string, run: RlmChildRun | undefined): void {
	if (!run) return;
	host._retiredRlmChildRuns.delete(childId);
	host._retiredRlmChildRuns.set(childId, {
		id: run.id,
		provisionalNoReplyReplyIds: run.provisionalNoReplyReplyIds,
		noReplyVerdictSupersededBy: run.noReplyVerdictSupersededBy,
		noReplyNoticeSuperseded: run.noReplyNoticeSuperseded,
		provisionalFailureNoticeReplyId: run.provisionalFailureNoticeReplyId,
		failureVerdictSupersededBy: run.failureVerdictSupersededBy,
	});
	while (host._retiredRlmChildRuns.size > RETIRED_RLM_CHILD_RUNS_MAX) {
		const oldest = host._retiredRlmChildRuns.keys().next().value;
		if (oldest === undefined) break;
		host._retiredRlmChildRuns.delete(oldest);
	}
}

/** A child's run, or the delivery record of one whose child was already deleted or released. */
export function rlmChildRunForNotice(host: RlmChildRetentionHost, childId: string): RetiredRlmChildRun | undefined {
	return (
		host._activeRlmChildRuns.get(childId) ??
		host._rlmChildSessions.get(childId)?.run ??
		host._retiredRlmChildRuns.get(childId)
	);
}

export function removeRlmSubagentTracking(host: RlmChildRetentionHost, childId: string, run?: RlmChildRun): void {
	retireRlmChildRun(
		host,
		childId,
		run ?? host._activeRlmChildRuns.get(childId) ?? host._rlmChildSessions.get(childId)?.run,
	);
	run?.unsubscribe?.();
	host._rlmChildUnsubscribes.get(childId)?.();
	host._rlmChildUnsubscribes.delete(childId);
	host._stopRlmChildFollowUpWatch(childId);
	host._closedRlmChildCollectEntries.delete(childId);
	host._rlmChildSessions.delete(childId);
	host._rlmChildCleanupFailures.delete(childId);
	host._abandonedRlmQuiescenceChildIds.delete(childId);
	host._prunedRlmChildIds.delete(childId);
	if (!run || host._activeRlmChildRuns.get(childId) === run) {
		host._activeRlmChildRuns.delete(childId);
	}
	if (run) {
		run.abort = noopRlmChildAbort;
		run.unsubscribe = undefined;
		run.session = undefined;
	}
}

/**
 * Retain a finished child session for the parent lifetime so inspectors and
 * daemon-hosted agent messaging can keep addressing it. Returns false (and disposes
 * the child) when the parent is already tearing down, so the caller can drop the
 * matching event forwarder too.
 */
export function registerRlmChildSession(
	host: RlmChildRetentionHost,
	childId: string,
	session: AgentSession,
	unsubscribe?: () => void,
): boolean {
	// A child can finish concurrently while the parent is (or has) torn down; don't
	// resurrect the map (it would never be disposed), just drop the child now.
	if (host._deletingRlmChildren.has(childId) || host._deletedRlmChildIds.has(childId)) {
		return false;
	}
	if (host._subagentRuntimeHost?.completeRlmSubagentRuntime?.(childId, session) === false) {
		return false;
	}
	if (host._disposed || host._disposing) {
		void session.disposeAsync().catch(() => undefined);
		return false;
	}
	host._rlmChildSessions.set(childId, { session, run: host._activeRlmChildRuns.get(childId) });
	if (session.sessionName) host._rlmHistoricalChildNamesNow().add(session.sessionName);
	if (unsubscribe) {
		host._rlmChildUnsubscribes.set(childId, unsubscribe);
	}
	// Live again (a closed child rehydrated): its session is the source now.
	host._closedRlmChildCollectEntries.delete(childId);
	// A re-registered child is re-engaged work, not a forgotten one.
	host._prunedRlmChildIds.delete(childId);
	host._watchRlmChildFollowUps(childId, session);
	return true;
}

export function releaseRlmChildSession(
	host: RlmChildRetentionHost,
	childId: string,
	session: AgentSession,
): (() => void) | false {
	const run = host._activeRlmChildRuns.get(childId);
	// An errored run never leaves the active map (unlike a done one, which moves
	// to the retained sessions), so without its arm here a still-resident errored
	// child could never be handed to idle passivation and leaked for the worker's
	// lifetime. The settled gate keeps the release from racing the run's own
	// terminal bookkeeping: the classification lands before settle, so the closed
	// record this publishes carries it. The closer keeps the audit surfaces - the
	// retired-run record, the closed collect entry, and the roster row all keep
	// the error.
	if (run?.session === session && (run.status === "done" || (run.status === "error" && run.settled))) {
		const unsubscribe = run.unsubscribe ?? noopRlmChildEventUnsubscribe;
		const closed = closedRlmChildRecord(host, childId, session, run);
		return () => {
			run.unsubscribe = undefined;
			retireRlmChildRun(host, childId, run);
			host._activeRlmChildRuns.delete(childId);
			unsubscribe();
			publishClosedRlmChild(host, childId, closed);
		};
	}
	if (host._rlmChildSessions.get(childId)?.session !== session) return false;
	const unsubscribe = host._rlmChildUnsubscribes.get(childId) ?? noopRlmChildEventUnsubscribe;
	const closed = closedRlmChildRecord(host, childId, session, host._rlmChildSessions.get(childId)?.run);
	return () => {
		retireRlmChildRun(host, childId, host._rlmChildSessions.get(childId)?.run);
		host._rlmChildUnsubscribes.delete(childId);
		host._rlmChildSessions.delete(childId);
		unsubscribe();
		publishClosedRlmChild(host, childId, closed);
	};
}

/**
 * What a child being closed leaves behind: its collect result and the roster row
 * that replaces its live one. Taken before the close, while the session is whole.
 */
function closedRlmChildRecord(
	host: RlmChildRetentionHost,
	childId: string,
	session: AgentSession,
	run: RlmChildRun | undefined,
): ClosedRlmChildRelease {
	const entry = run ? rlmCollectEntryForRun(host, run) : rlmCollectEntryForSession(host, childId, session);
	const snapshot = run
		? rlmChildSnapshotForRun(host, run, session)
		: rlmChildSnapshotForSession(host, childId, session);
	return {
		record: { sessionId: session.sessionId, entry: { ...entry, settled: true, activity_kind: undefined } },
		// No activeSessionId: a terminal row without one is how a client learns the
		// child is no longer resident (it stops offering "idle" and a dead attach).
		snapshot: { ...snapshot, activeSessionId: undefined, activity: undefined, stall: undefined },
	};
}

function publishClosedRlmChild(host: RlmChildRetentionHost, childId: string, closed: ClosedRlmChildRelease): void {
	host._stopRlmChildFollowUpWatch(childId);
	// The closed child's name is free from here on; the history keeps it so a
	// re-spawn is numbered instead of merging into this child's display rows.
	if (closed.snapshot.sessionName) host._rlmHistoricalChildNamesNow().add(closed.snapshot.sessionName);
	if (host._disposed || host._disposing || host._isRlmChildHiddenFromCollect(childId)) return;
	host._rememberClosedRlmChild(childId, closed.record);
	host._emit({ type: "rlm_child_update", child: closed.snapshot });
}

function isUnboundTerminalRlmChildRun(host: RlmChildRetentionHost, run: RlmChildRun): boolean {
	if (run.session !== undefined || host._rlmChildSessions.has(run.id)) return false;
	return run.status === "done" || run.status === "error" || run.status === "cancelled";
}

/** Live recursive child roster from lifecycle state, including nested work under retained parents. */
export function getRlmChildSnapshots(host: RlmChildRetentionHost): RlmChildAgentSnapshot[] {
	const snapshots: RlmChildAgentSnapshot[] = [];
	const recorded = new Set<string>();
	const traversed = new Set<string>();
	for (const run of host._activeRlmChildRuns.values()) {
		const hidden =
			run.detachedDeletion ||
			host._deletingRlmChildren.has(run.id) ||
			host._deletedRlmChildIds.has(run.id) ||
			isUnboundTerminalRlmChildRun(host, run);
		const child = run.session;
		if (!hidden) {
			snapshots.push(rlmChildSnapshotForRun(host, run));
			recorded.add(run.id);
		}
		if (child) {
			traversed.add(run.id);
			snapshots.push(...child.getRlmChildSnapshots());
		}
	}
	for (const [childId, { session: child, run }] of host._rlmChildSessions) {
		if (recorded.has(childId) || traversed.has(childId)) continue;
		const hidden = host._deletingRlmChildren.has(childId) || host._deletedRlmChildIds.has(childId);
		if (!hidden) {
			const snapshot = run
				? rlmChildSnapshotForRun(host, run, child)
				: rlmChildSnapshotForSession(host, childId, child);
			snapshots.push({
				...snapshot,
				status: host._rlmChildCleanupFailures.has(childId) ? "cancelled" : snapshot.status,
			});
		}
		snapshots.push(...child.getRlmChildSnapshots());
	}
	return snapshots;
}

/** True when any direct or nested subagent is still running or queued. */
export function hasRunningRlmChildren(host: RlmChildRetentionHost): boolean {
	for (const session of host._rlmSubtreeSessions()) {
		for (const run of session._activeRlmChildRuns.values()) {
			if (run.status === "running" || run.status === "queued") {
				return true;
			}
		}
	}
	return false;
}

/**
 * The direct-child sessions quiescence waits on: retained sessions plus live runs'
 * sessions, minus the children abandoned for quiescence (a run whose terminal wait
 * the parent gave up on must not hold the barrier).
 */
export function rlmChildSessionSnapshot(host: RlmChildRetentionHost): AgentSession[] {
	const sessions = new Set<AgentSession>();
	for (const [childId, { session }] of host._rlmChildSessions) {
		if (!host._abandonedRlmQuiescenceChildIds.has(childId)) sessions.add(session);
	}
	for (const run of host._activeRlmChildRuns.values()) {
		if (run.session && !run.abandonedForQuiescence) sessions.add(run.session);
	}
	return [...sessions];
}
