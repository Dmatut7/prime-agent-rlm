/**
 * RLM child delete cluster extracted from agent-session.ts: selector resolution
 * against the full registry, in-flight deletion coalescing, and the detached
 * cleanup/retry lifecycle behind explicit `rlm.delete_subagent` and daemon-driven
 * inactive deletion. The moved methods keep exactly the same bodies; they read
 * the session through {@link RlmChildDeleteHost}, which `AgentSession` satisfies
 * structurally, so the move changes no runtime behavior.
 */
import type { AgentSessionMessageController, AgentSessionMessageListResult } from "./agent-messages.js";
import type { AgentSession, AgentSessionEvent, RetainedRlmChild } from "./agent-session.js";
import type { RlmSubagentRosterView } from "./rlm-child-roster.js";
import { createAgentMessageDeferred, type RlmChildRun } from "./rlm-child-run.js";
import type {
	RlmDeleteSubagentResult,
	RlmListSubagentsResult,
	RlmSubagentRegistryEntry,
	SubagentRuntimeHost,
} from "./rlm-runtime.js";

/** The deletion paths resolve against every tracked child, including pruned ones. */
const RLM_FULL_ROSTER_VIEW: RlmSubagentRosterView = { includeTerminal: true, includePruned: true };

/**
 * The seam of `AgentSession` the extracted delete paths read and mutate. Member
 * names mirror the class's own members so the extraction stays a textual
 * `this.` -> `host.` rename; `AgentSession.deleteRlmSubagent` and
 * `deleteInactiveRlmSubagent` delegate with `this`.
 */
export interface RlmChildDeleteHost {
	readonly _activeRlmChildRuns: Map<string, RlmChildRun>;
	readonly _rlmChildSessions: Map<string, RetainedRlmChild>;
	readonly _unsettledRlmChildRuns: Set<RlmChildRun>;
	readonly _deletedRlmChildIds: Set<string>;
	readonly _rlmChildCleanupFailures: Map<string, RlmSubagentRegistryEntry>;
	readonly _deletingRlmChildren: Map<
		string,
		{
			subagent: RlmSubagentRegistryEntry;
			promise: Promise<RlmDeleteSubagentResult>;
		}
	>;
	readonly _agentMessageController?: AgentSessionMessageController;
	readonly _rlmParentNodeId?: string;
	readonly _disposed: boolean;
	readonly _disposing: boolean;
	readonly _subagentRuntimeHost?: SubagentRuntimeHost;
	_buildRlmSubagentList(
		listedAgents?: AgentSessionMessageListResult,
		view?: RlmSubagentRosterView,
	): RlmListSubagentsResult;
	_rlmSubtreeSessions(): Generator<AgentSession>;
	_cancelRlmChildRun(run: RlmChildRun, reason: string): boolean;
	_removeRlmSubagentTracking(childId: string, run?: RlmChildRun): void;
	_rlmHistoricalChildNamesNow(): Set<string>;
	_emit(event: AgentSessionEvent): void;
	_maybeResumeGoalContinuationAfterRlmWork(): void;
	_maybeResumeAutonomousContinuationAfterRlmWork(): void;
}

export function rlmSubagentMatchesTarget(entry: RlmSubagentRegistryEntry, target: string): boolean {
	return (
		entry.rlm_child_id === target ||
		entry.active_session_id === target ||
		entry.session_id === target ||
		entry.session_name === target
	);
}

/**
 * The full registry the deletion paths resolve against: terminal and pruned
 * children included, so a selector keeps working after either retirement. The
 * async hop is load-bearing - two deletes racing a gated daemon listing must
 * both finish building their candidate list before either registers its
 * reservation, or the second build already sees the first's in-flight deletion
 * and reports the child as unknown (the coalescing regression test pins this).
 */
async function listAllRlmSubagentsForDeletion(host: RlmChildDeleteHost): Promise<RlmListSubagentsResult> {
	return host._buildRlmSubagentList(await host._agentMessageController?.listAgents(), RLM_FULL_ROSTER_VIEW);
}

async function resolveDirectRlmSubagent(host: RlmChildDeleteHost, target: string): Promise<RlmSubagentRegistryEntry> {
	const candidates = [
		...(await listAllRlmSubagentsForDeletion(host)).subagents,
		...host._rlmChildCleanupFailures.values(),
	];
	const matches = candidates.filter((entry) => rlmSubagentMatchesTarget(entry, target));
	if (matches.length === 0) {
		throw new Error(`No direct RLM subagent matches "${target}" in the current parent session`);
	}
	if (matches.length > 1) {
		throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
	}
	return matches[0]!;
}

export async function deleteInactiveRlmSubagent(
	host: RlmChildDeleteHost,
	childId: string,
	isExternallyRunning: () => boolean = () => false,
): Promise<"deleted" | "not_found" | "running"> {
	for (const owner of host._rlmSubtreeSessions()) {
		const isRunning = (): boolean => {
			const status = owner._activeRlmChildRuns.get(childId)?.status;
			return status === "queued" || status === "running" || isExternallyRunning();
		};
		if (isRunning()) {
			return "running";
		}
		const subagent = [
			...(await listAllRlmSubagentsForDeletion(owner)).subagents,
			...owner._rlmChildCleanupFailures.values(),
		].find((entry) => entry.rlm_child_id === childId);
		if (!subagent) continue;
		if (isRunning()) {
			return "running";
		}
		const result = await trackRlmSubagentDeletion(owner, subagent, () => {
			if (isRunning()) {
				return Promise.resolve({ subagent, outcome: "skipped_running" });
			}
			return deleteResolvedRlmSubagent(owner, subagent);
		});
		return result.outcome === "skipped_running" ? "running" : "deleted";
	}
	return "not_found";
}

export async function deleteRlmSubagent(host: RlmChildDeleteHost, target: string): Promise<RlmDeleteSubagentResult> {
	const inFlight = [...host._deletingRlmChildren.values()].filter(({ subagent }) =>
		rlmSubagentMatchesTarget(subagent, target),
	);
	if (inFlight.length > 1) {
		throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
	}

	// Running and retained children can be reserved synchronously. This keeps
	// them hidden immediately while the async daemon listing checks for a
	// conflicting passive selector.
	const localMatches = [
		...host._buildRlmSubagentList(undefined, RLM_FULL_ROSTER_VIEW).subagents,
		...host._rlmChildCleanupFailures.values(),
	].filter((entry) => rlmSubagentMatchesTarget(entry, target));
	const matchingChildIds = new Set([
		...inFlight.map(({ subagent }) => subagent.rlm_child_id),
		...localMatches.map((subagent) => subagent.rlm_child_id),
	]);
	if (matchingChildIds.size > 1 || localMatches.length > 1) {
		throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
	}
	if (inFlight[0]) {
		return inFlight[0].promise;
	}
	if (localMatches[0]) {
		const subagent = localMatches[0];
		return trackRlmSubagentDeletion(host, subagent, async () => {
			const listedAgents = await host._agentMessageController?.listAgents();
			const listedSubagents = host._buildRlmSubagentList(listedAgents, RLM_FULL_ROSTER_VIEW).subagents;
			const passiveMatches = listedSubagents.filter(
				(entry) => entry.rlm_child_id !== subagent.rlm_child_id && rlmSubagentMatchesTarget(entry, target),
			);
			if (passiveMatches.length > 0) {
				throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
			}
			const parentActiveSessionId = listedAgents?.current?.activeSessionId;
			const daemonChild = listedAgents?.agents.find(
				(agent) =>
					agent.rlmChildId === subagent.rlm_child_id && agent.parentActiveSessionId === parentActiveSessionId,
			);
			const resolvedSubagent = daemonChild
				? {
						...subagent,
						active_session_id: daemonChild.activeSessionId,
						session_id: daemonChild.sessionId,
						session_name: daemonChild.sessionName ?? subagent.session_name,
					}
				: subagent;
			return deleteResolvedRlmSubagent(host, resolvedSubagent);
		});
	}

	const directMatches = [
		...(await listAllRlmSubagentsForDeletion(host)).subagents,
		...host._rlmChildCleanupFailures.values(),
	].filter((entry) => rlmSubagentMatchesTarget(entry, target));
	const directChildIds = new Set(directMatches.map((subagent) => subagent.rlm_child_id));
	if (directChildIds.size > 1) {
		throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
	}
	const subagent = directMatches[0] ?? (await resolveDirectRlmSubagent(host, target));
	return trackRlmSubagentDeletion(host, subagent, () => deleteResolvedRlmSubagent(host, subagent));
}

async function trackRlmSubagentDeletion(
	host: RlmChildDeleteHost,
	subagent: RlmSubagentRegistryEntry,
	startDeletion: () => Promise<RlmDeleteSubagentResult>,
): Promise<RlmDeleteSubagentResult> {
	const existing = host._deletingRlmChildren.get(subagent.rlm_child_id);
	if (existing) return existing.promise;
	const deletion = Promise.resolve().then(startDeletion);
	host._deletingRlmChildren.set(subagent.rlm_child_id, {
		subagent,
		promise: deletion,
	});
	try {
		return await deletion;
	} finally {
		const clearReservation = () => {
			if (host._deletingRlmChildren.get(subagent.rlm_child_id)?.promise === deletion) {
				host._deletingRlmChildren.delete(subagent.rlm_child_id);
			}
		};
		const run = host._activeRlmChildRuns.get(subagent.rlm_child_id);
		if (run?.detachedDeletion) {
			// Keep every selector reserved until the run settles, or until a failed
			// cleanup is exposed for an explicit retry. Repeated deletes before that
			// boundary return the same accepted result.
			void run.deletionReservation.promise.then(clearReservation, clearReservation);
		} else {
			clearReservation();
		}
	}
}

function deleteRlmSubagentSession(host: RlmChildDeleteHost, childId: string, session?: AgentSession): Promise<void> {
	if (host._subagentRuntimeHost) {
		return host._subagentRuntimeHost.deleteRlmSubagentRuntime(childId, session);
	}
	return session?.disposeAsync() ?? Promise.resolve();
}

export function ensureRlmRunDeletionCleanup(
	host: RlmChildDeleteHost,
	run: RlmChildRun,
	session: AgentSession,
): Promise<void> {
	if (run.deletionCleanup) return run.deletionCleanup;
	const cleanup = Promise.resolve().then(() => deleteRlmSubagentSession(host, run.id, session));
	run.deletionCleanup = cleanup;
	// Deletion admission is intentionally nonblocking. The detached run owner
	// joins this exact promise before settlement and records any failure.
	void cleanup.catch(() => undefined);
	return cleanup;
}

async function recordRlmRunDeletionCleanupFailure(
	host: RlmChildDeleteHost,
	run: RlmChildRun,
	subagent: RlmSubagentRegistryEntry,
	session: AgentSession,
	error: unknown,
): Promise<void> {
	if (host._disposed || host._disposing) {
		run.suppressTerminalNotice = true;
		await session.disposeAsync().catch(() => undefined);
		if (!run.settled) await finishRlmRunDeletion(host, run);
		return;
	}
	run.deletionCleanup = undefined;
	run.deletionCleanupObserver = undefined;
	run.deletionCleanupFailed = true;
	run.session = session;
	host._rlmChildCleanupFailures.set(run.id, subagent);
	// Make retry admission available before waking the parent model with the
	// retry-required notice.
	run.deletionReservation.resolve();
	await Promise.resolve();
	await run.reportDeletionCleanupFailure?.(error);
}

export async function finishRlmRunDeletion(host: RlmChildDeleteHost, run: RlmChildRun): Promise<void> {
	await run.completeDeletion?.();
	if (host._activeRlmChildRuns.get(run.id) === run) {
		host._removeRlmSubagentTracking(run.id, run);
	}
	run.settled = true;
	run.settlement.resolve();
	run.deletionReservation.resolve();
	host._unsettledRlmChildRuns.delete(run);
	host._maybeResumeGoalContinuationAfterRlmWork();
	host._maybeResumeAutonomousContinuationAfterRlmWork();
}

export function observeRlmRunDeletionCleanup(
	host: RlmChildDeleteHost,
	run: RlmChildRun,
	subagent: RlmSubagentRegistryEntry,
	session: AgentSession,
	cleanup: Promise<void>,
): Promise<boolean> {
	if (run.deletionCleanupObserver) return run.deletionCleanupObserver;
	const observer = cleanup.then(
		() => true,
		async (error) => {
			await recordRlmRunDeletionCleanupFailure(host, run, subagent, session, error);
			return false;
		},
	);
	run.deletionCleanupObserver = observer;
	void observer.catch(() => undefined);
	return observer;
}

function continueFinishedRlmRunDeletion(
	host: RlmChildDeleteHost,
	run: RlmChildRun,
	subagent: RlmSubagentRegistryEntry,
	session: AgentSession,
): void {
	const cleanup = ensureRlmRunDeletionCleanup(host, run, session);
	const observer = observeRlmRunDeletionCleanup(host, run, subagent, session, cleanup);
	if (!run.deletionRunFinished) return;
	void observer
		.then(async (cleanupSucceeded) => {
			if (cleanupSucceeded) await finishRlmRunDeletion(host, run);
		})
		.catch(() => undefined);
}

function emitRlmSubagentRemoval(host: RlmChildDeleteHost, subagent: RlmSubagentRegistryEntry): void {
	host._emit({
		type: "rlm_child_update",
		child: {
			id: subagent.rlm_child_id,
			parentId: host._rlmParentNodeId,
			activeSessionId: subagent.active_session_id ?? undefined,
			sessionName: subagent.session_name,
			label: subagent.session_name,
			status: "cancelled",
			sessionDir: subagent.session_dir,
			error: "Deleted by parent orchestrator",
		},
	});
}

async function deleteResolvedRlmSubagent(
	host: RlmChildDeleteHost,
	subagent: RlmSubagentRegistryEntry,
): Promise<RlmDeleteSubagentResult> {
	const childId = subagent.rlm_child_id;
	// The freed name stays in the name history: a later re-spawn of it is
	// numbered instead of merging into the deleted child's display rows.
	if (subagent.session_name) host._rlmHistoricalChildNamesNow().add(subagent.session_name);
	const run = host._activeRlmChildRuns.get(childId);
	if (run) {
		if (run.deletionCleanupFailed) {
			// Reset retry coordination only after selector preflight reaches the
			// resolved child. A failed preflight must leave the prior retry boundary
			// intact so a later call can acquire it.
			run.deletionCleanupFailed = false;
			run.deletionFailureNotice = undefined;
			run.deletionReservation = createAgentMessageDeferred();
		}
		// The detached task remains the sole lifecycle owner. Mark deletion before
		// cancellation so its catch/finally path cannot race a normal release or
		// terminal notice against the physical delete.
		run.detachedDeletion = subagent;
		if (host._cancelRlmChildRun(run, "Deleted by parent orchestrator")) {
			run.deletionNeedsCompletionNotice = true;
		} else {
			emitRlmSubagentRemoval(host, subagent);
		}
		const liveSession = run.session;
		if (run.status === "error" && !liveSession && run.settled) {
			host._deletedRlmChildIds.add(childId);
			host._removeRlmSubagentTracking(childId, run);
			return { subagent };
		}
		if (liveSession && run.settled) {
			run.deletionRunFinished = true;
			run.settlement = createAgentMessageDeferred();
			run.settled = false;
			host._unsettledRlmChildRuns.add(run);
		}
		if (liveSession) continueFinishedRlmRunDeletion(host, run, subagent, liveSession);

		// Return once deletion is accepted. The run stays hidden but unsettled until
		// abort-insensitive model/tool work unwinds and the shared cleanup finishes.
		host._deletedRlmChildIds.add(childId);
		return { subagent };
	}

	emitRlmSubagentRemoval(host, subagent);
	const retained = host._rlmChildSessions.get(childId)?.session;
	try {
		await deleteRlmSubagentSession(host, childId, retained);
	} catch (error) {
		if (host._disposed || host._disposing) {
			host._removeRlmSubagentTracking(childId);
			void retained?.disposeAsync().catch(() => undefined);
		} else {
			host._rlmChildCleanupFailures.set(childId, subagent);
		}
		throw error;
	}
	host._deletedRlmChildIds.add(childId);
	host._removeRlmSubagentTracking(childId);
	return { subagent };
}
