/**
 * RLM child roster cluster extracted from agent-session.ts: the registry views
 * behind `rlm.list_subagents` (the merge of in-memory runs, retained sessions, the
 * daemon listing and the closed-child records) and `rlm.prune_subagents` (registry
 * bookkeeping that retires terminal children from the roster views without deleting
 * them). The moved methods keep exactly the same bodies; they read the session
 * through {@link RlmChildRosterHost}, which `AgentSession` satisfies structurally,
 * so the move changes no runtime behavior.
 */
import type { AgentSessionMessageAgentSummary, AgentSessionMessageListResult } from "./agent-messages.js";
import {
	type ClosedRlmChildCollectEntry,
	type RlmChildCollectHost,
	rlmCollectEntryForRun,
} from "./rlm-child-collect.js";
import { rlmSubagentMatchesTarget } from "./rlm-child-delete.js";
import type { RlmChildRun } from "./rlm-child-run.js";
import {
	createDefaultRlmSubagentSessionName,
	type RlmDeleteSubagentResult,
	type RlmListSubagentsResult,
	type RlmSubagentRegistryEntry,
} from "./rlm-runtime.js";

/** Options for {@link AgentSession.listRlmSubagents}. */
export interface RlmListSubagentsOptions {
	/**
	 * Also list children whose run reached a terminal state (completed or error).
	 * Default false: the roster is the parent's active-work list. Terminal children
	 * stay addressable through `rlm.collect` and `rlm.delete_subagent`, and remain on
	 * the audit surfaces (the retired-run records, the closed-child collect entries,
	 * the on-disk display files and the spawn ledger).
	 */
	includeTerminal?: boolean;
}

/** Internal roster view: `includePruned` re-admits children forgotten by `pruneRlmSubagents`. */
export interface RlmSubagentRosterView extends RlmListSubagentsOptions {
	includePruned?: boolean;
}

/** The rows `pruneRlmSubagents` retired from the roster views. */
export interface RlmPruneSubagentsResult {
	pruned: RlmSubagentRegistryEntry[];
}

/**
 * The seam of `AgentSession` the extracted roster paths read and mutate. Member
 * names mirror the class's own members so the extraction stays a textual
 * `this.` -> `host.` rename; `AgentSession.listRlmSubagents`, `_buildRlmSubagentList`
 * and `pruneRlmSubagents` delegate with `this`.
 */
export interface RlmChildRosterHost extends RlmChildCollectHost {
	readonly _deletedRlmChildIds: Set<string>;
	readonly _rlmChildCleanupFailures: Map<string, RlmSubagentRegistryEntry>;
	readonly _deletingRlmChildren: Map<
		string,
		{
			subagent: RlmSubagentRegistryEntry;
			promise: Promise<RlmDeleteSubagentResult>;
		}
	>;
	readonly _prunedRlmChildIds: Set<string>;
	_removeRlmSubagentTracking(childId: string, run?: RlmChildRun): void;
}

export async function listRlmSubagents(
	host: RlmChildRosterHost,
	options?: RlmListSubagentsOptions,
): Promise<RlmListSubagentsResult> {
	return buildRlmSubagentList(host, await host._agentMessageController?.listAgents(), options);
}

export function buildRlmSubagentList(
	host: RlmChildRosterHost,
	listedAgents?: AgentSessionMessageListResult,
	view?: RlmSubagentRosterView,
): RlmListSubagentsResult {
	const includeTerminal = view?.includeTerminal === true;
	const includePruned = view?.includePruned === true;
	const daemonChildren = new Map<string, AgentSessionMessageAgentSummary>();
	const parentActiveSessionId = listedAgents?.current?.activeSessionId;
	if (parentActiveSessionId) {
		for (const agent of listedAgents.agents) {
			if (
				agent.runtimeKind === "subagent" &&
				agent.parentActiveSessionId === parentActiveSessionId &&
				agent.rlmChildId
			) {
				daemonChildren.set(agent.rlmChildId, agent);
			}
		}
	}

	const subagents: RlmListSubagentsResult["subagents"] = [];
	const recorded = new Set<string>();
	for (const run of host._activeRlmChildRuns.values()) {
		if (host._deletingRlmChildren.has(run.id) || run.detachedDeletion || run.status === "cancelled") {
			continue;
		}
		// A terminal run retired from the active list; the audit surfaces keep it.
		if (!includeTerminal && run.status !== "queued" && run.status !== "running") continue;
		if (!includePruned && host._prunedRlmChildIds.has(run.id)) continue;
		const daemonChild = daemonChildren.get(run.id);
		subagents.push({
			rlm_child_id: run.id,
			active_session_id: daemonChild?.activeSessionId ?? null,
			session_id: daemonChild?.sessionId ?? run.session?.sessionId ?? null,
			session_name: daemonChild?.sessionName ?? run.session?.sessionName ?? run.sessionName,
			session_dir: run.sessionDir,
			status: run.status === "done" ? "completed" : run.status === "error" ? "error" : "running",
			// #2282 roster exception (parent ruling): the kernel roster is the
			// parent's polling surface for a child's latest progress note. Only
			// this one extra rides along - the collect envelope stays the fork's
			// six-field shape.
			...(run.progressNotes?.length ? { progress_note: run.progressNotes.at(-1) } : {}),
		});
		recorded.add(run.id);
	}
	for (const [childId, { session: childSession, run: retainedRun }] of host._rlmChildSessions) {
		if (
			host._deletingRlmChildren.has(childId) ||
			recorded.has(childId) ||
			host._rlmChildCleanupFailures.has(childId)
		) {
			continue;
		}
		// A retained child is a finished one ("completed"); it left the active list
		// even while it works a follow-up (the roster has no activity field - that
		// signal lives on the snapshot stream and in rlm.collect's activity_kind).
		if (!includeTerminal) continue;
		if (!includePruned && host._prunedRlmChildIds.has(childId)) continue;
		const daemonChild = daemonChildren.get(childId);
		const sessionDir = childSession._rlmSessionDir;
		if (!sessionDir) {
			continue;
		}
		subagents.push({
			rlm_child_id: childId,
			active_session_id: daemonChild?.activeSessionId ?? null,
			session_id: daemonChild?.sessionId ?? childSession.sessionId,
			session_name:
				daemonChild?.sessionName ?? childSession.sessionName ?? createDefaultRlmSubagentSessionName("", childId),
			session_dir: sessionDir,
			status: "completed",
			...(retainedRun?.progressNotes?.length ? { progress_note: retainedRun.progressNotes.at(-1) } : {}),
		});
		recorded.add(childId);
	}
	for (const [childId, daemonChild] of daemonChildren) {
		if (
			recorded.has(childId) ||
			host._deletingRlmChildren.has(childId) ||
			host._deletedRlmChildIds.has(childId) ||
			host._rlmChildCleanupFailures.has(childId) ||
			!daemonChild.sessionDir
		) {
			continue;
		}
		// A daemon-listed row this session no longer tracks in memory only ever
		// reports a terminal status (completed, or errored by construction below).
		if (!includeTerminal) continue;
		if (!includePruned && host._prunedRlmChildIds.has(childId)) continue;
		subagents.push({
			rlm_child_id: childId,
			active_session_id: daemonChild.activeSessionId,
			session_id: daemonChild.sessionId,
			session_name: daemonChild.sessionName ?? createDefaultRlmSubagentSessionName("", childId),
			session_dir: daemonChild.sessionDir,
			status: daemonChild.rlmChildRegistryStatus === "completed" ? "completed" : "error",
		});
		recorded.add(childId);
	}
	// Closed after idling and not (or no longer) in a daemon listing: still a child
	// the parent can collect, so it stays addressable for delete too.
	for (const [childId, { entry, sessionId }] of host._closedRlmChildCollectEntries) {
		if (recorded.has(childId) || host._isRlmChildHiddenFromCollect(childId)) continue;
		if (!includeTerminal) continue;
		if (!includePruned && host._prunedRlmChildIds.has(childId)) continue;
		subagents.push({
			rlm_child_id: childId,
			active_session_id: null,
			session_id: sessionId ?? null,
			session_name: entry.session_name ?? createDefaultRlmSubagentSessionName("", childId),
			session_dir: entry.session_dir,
			status: entry.status === "error" ? "error" : "completed",
		});
	}
	return { subagents };
}

/**
 * Retire terminal direct children from the roster views (`rlm.prune_subagents`).
 *
 * Pruning is registry bookkeeping, not deletion: the child keeps its transcript,
 * its on-disk display row and its collect result, and `rlm.delete_subagent` still
 * resolves it through the internal full-registry view. A retained child session
 * stays resident - closing it is the daemon's idle passivation - and a child the
 * parent re-engages (a follow-up turn re-registers it) leaves the pruned set on
 * its own. Running children are refused: pruning is not cancellation.
 */
export async function pruneRlmSubagents(
	host: RlmChildRosterHost,
	targets: string[] = [],
): Promise<RlmPruneSubagentsResult> {
	const roster = buildRlmSubagentList(host, await host._agentMessageController?.listAgents(), {
		includeTerminal: true,
	}).subagents;
	let selected: RlmSubagentRegistryEntry[];
	if (targets.length === 0) {
		selected = roster.filter((entry) => entry.status !== "running");
	} else {
		selected = [];
		const selectedIds = new Set<string>();
		for (const rawTarget of targets) {
			const target = rawTarget.trim();
			if (!target) {
				throw new Error("rlm.prune_subagents targets must be non-empty strings");
			}
			const matches = roster.filter((entry) => rlmSubagentMatchesTarget(entry, target));
			if (matches.length === 0) {
				throw new Error(`No direct RLM subagent matches "${target}" in the current parent session`);
			}
			if (matches.length > 1) {
				throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
			}
			const match = matches[0]!;
			if (match.status === "running") {
				throw new Error(
					`RLM subagent "${target}" is still running; prune only retires completed or errored children`,
				);
			}
			if (!selectedIds.has(match.rlm_child_id)) {
				selectedIds.add(match.rlm_child_id);
				selected.push(match);
			}
		}
	}
	const pruned: RlmSubagentRegistryEntry[] = [];
	for (const entry of selected) {
		const childId = entry.rlm_child_id;
		// The delete path owns children it is tearing down, including failed cleanups.
		if (host._deletingRlmChildren.has(childId) || host._rlmChildCleanupFailures.has(childId)) continue;
		const run = host._activeRlmChildRuns.get(childId);
		if (run && !host._rlmChildSessions.has(childId)) {
			// An errored run never moves to the retained map: dropping it here would
			// orphan its collect result, so keep a closed record for it. Tracking
			// removal deletes closed records, so the record is re-added after.
			const record: ClosedRlmChildCollectEntry = {
				sessionId: run.session?.sessionId,
				entry: { ...rlmCollectEntryForRun(host, run), settled: run.settled, activity_kind: undefined },
			};
			host._removeRlmSubagentTracking(childId, run);
			host._rememberClosedRlmChild(childId, record);
		}
		host._prunedRlmChildIds.add(childId);
		pruned.push(entry);
	}
	return { pruned };
}
