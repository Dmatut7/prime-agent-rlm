/**
 * RLM child quiescence cluster extracted from agent-session.ts: the quiescence
 * barrier a headless completion waits on (has-work predicate, the bounded wait
 * itself), the subtree walk both of those share, and the abort cascade that
 * tears a subtree down. The moved methods keep exactly the same bodies; they
 * read the session through {@link RlmChildQuiescenceHost}, which `AgentSession`
 * satisfies structurally, so the move changes no runtime behavior.
 * `RlmQuiescenceOutcome` deliberately stays in agent-session.ts: the daemon
 * schema digest hashes its source text there.
 */
import { getLogger } from "@earendil-works/pi-ai";
import type { AgentSession, RlmQuiescenceOutcome } from "./agent-session.js";
import { noopRlmChildAbort, type RlmChildRun } from "./rlm-child-run.js";
import type { RlmChildTurnAbortReason } from "./rlm-child-terminal.js";

// Same logger name as agent-session.ts: the quiescence wait and the abort
// cascade moved here verbatim and their log lines keep the namespace they have
// always emitted under.
const sessionLog = getLogger("coding-agent.agent-session");

/**
 * FR-4: how long one quiescence barrier waits before giving up. A descendant
 * that never settles must not park the barrier (and every headless completion
 * behind it) forever; past the deadline the wait warns and reports
 * `{ settled: false }`.
 */
const RLM_QUIESCENCE_GIVE_UP_MS = 5 * 60_000;

/**
 * The seam of `AgentSession` the extracted quiescence paths read and mutate.
 * Member names mirror the class's own members so the extraction stays a textual
 * `this.` -> `host.` rename; `AgentSession._hasUnsettledRlmQuiescenceWork`,
 * `waitForRlmQuiescence`, `_rlmSubtreeSessions` and `_abortRlmSubtree` delegate
 * with `this`.
 */
export interface RlmChildQuiescenceHost {
	readonly sessionId: string;
	readonly _rlmDepth: number;
	readonly isSessionActive: boolean;
	readonly _unsettledRlmChildRuns: Set<RlmChildRun>;
	readonly _rlmQuiescenceWaitAborts: Set<AbortController>;
	_hasActionableDeferredRlmTerminalNotices(): boolean;
	_rlmChildSessionSnapshot(): AgentSession[];
	_hasUnsettledRlmQuiescenceWork(): boolean;
	_rlmSubtreeSessions(): Generator<AgentSession>;
	_cancelRlmChildRun(run: RlmChildRun, reason: string): boolean;
	waitForHeadlessIdle(): Promise<void>;
	_waitForSessionActivityChange(signal: AbortSignal): Promise<void>;
}

export function hasUnsettledRlmQuiescenceWork(host: RlmChildQuiescenceHost): boolean {
	if (host._hasActionableDeferredRlmTerminalNotices()) return true;
	if ([...host._unsettledRlmChildRuns].some((run) => !run.settled)) return true;
	return host
		._rlmChildSessionSnapshot()
		.some((child) => child.isSessionActive || child._hasUnsettledRlmQuiescenceWork());
}

/**
 * Wait for every admitted descendant run to publish its terminal parent
 * message and for the resulting parent turns to drain. Re-snapshotting after
 * each drain includes descendants spawned while earlier results were consumed.
 *
 * FR-4: the wait is bounded by a give-up deadline (5 minutes). A descendant
 * that never settles used to park this barrier forever - and with it every
 * headless completion that asked for quiescence. On the deadline the wait
 * warns and returns `{ settled: false }` instead of hanging: the caller can
 * proceed with the current state, and the log says descendants may still be
 * running.
 */
export async function waitForRlmQuiescence(
	host: RlmChildQuiescenceHost,
	externalSignal?: AbortSignal,
): Promise<RlmQuiescenceOutcome> {
	const startedAt = Date.now();
	const cancellation = new AbortController();
	const cancelFromParent = () => cancellation.abort();
	if (externalSignal?.aborted) cancellation.abort();
	else externalSignal?.addEventListener("abort", cancelFromParent, { once: true });
	host._rlmQuiescenceWaitAborts.add(cancellation);
	let rejectCancelled = (_error: Error) => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		rejectCancelled = reject;
	});
	const onCancelled = () => rejectCancelled(new Error("RLM quiescence wait cancelled"));
	cancellation.signal.addEventListener("abort", onCancelled, { once: true });
	if (cancellation.signal.aborted) onCancelled();
	const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled]);
	// The give-up timer reuses the cancellation path so the recursive sibling
	// waits unwind exactly like an external abort; the flag separates "gave
	// up on the deadline" from a caller-driven cancellation, which still
	// rejects.
	let gaveUpAt: number | undefined;
	const giveUp = () => {
		gaveUpAt = Date.now();
		cancellation.abort();
	};
	const giveUpTimer = setTimeout(giveUp, RLM_QUIESCENCE_GIVE_UP_MS);
	if (typeof giveUpTimer === "object" && "unref" in giveUpTimer) giveUpTimer.unref();
	try {
		while (true) {
			await wait(host.waitForHeadlessIdle());
			// Strong RLM quiescence also owns session-level work (bash, refine,
			// branch mutation, and manual compaction) that interactive waitForIdle
			// intentionally ignores. Wake on activity changes (upstream #1859), raced
			// with a 1s tick so this loop re-checks a deferred terminal notice whose
			// delivery window closes while idle. The tick only observes: abandonment
			// itself is driven by its own timer (see
			// _armRlmTerminalNoticeAbandonTimer), because both predicates below are
			// pure reads and must not flush or discard anything.
			if (host.isSessionActive || host._hasActionableDeferredRlmTerminalNotices()) {
				// The 1s tick can win this race every iteration while bash/refine keep
				// the session active. Aborting the tick scope on settle removes the
				// losing activity-change waiter and its signal listener instead of
				// leaking one per second into MaxListenersExceededWarning spam.
				const tickAbort = new AbortController();
				let tickTimer: ReturnType<typeof setTimeout> | undefined;
				try {
					await wait(
						Promise.race([
							host._waitForSessionActivityChange(tickAbort.signal),
							new Promise<void>((resolve) => {
								tickTimer = setTimeout(resolve, 1000);
							}),
						]),
					);
				} finally {
					clearTimeout(tickTimer);
					tickAbort.abort();
				}
				continue;
			}
			const unsettledRuns = [...host._unsettledRlmChildRuns].filter((run) => !run.settled);
			const childSessions = host._rlmChildSessionSnapshot();
			if (unsettledRuns.length === 0 && !host._hasUnsettledRlmQuiescenceWork()) return { settled: true };
			await wait(
				Promise.all([
					...unsettledRuns.map((run) => run.settlement.promise),
					...childSessions.map((child) => child.waitForRlmQuiescence(cancellation.signal)),
				]),
			);
			// Always loop through the self-active/deferred checks again. Work may
			// start at the child-settlement boundary.
		}
	} catch (error) {
		// FR-4: the deadline fired and unwound the wait through the cancellation
		// path. Report the give-up instead of surfacing it as an error: the
		// caller asked "is everything settled" and the honest answer is "not
		// yet, and I stopped waiting".
		if (gaveUpAt !== undefined) {
			sessionLog.warn("rlm quiescence wait gave up after its deadline; descendants may still be unsettled", {
				sessionId: host.sessionId,
				waitedMs: gaveUpAt - startedAt,
				unsettledChildren: host._rlmChildSessionSnapshot().length,
			});
			return { settled: false, timedOut: true };
		}
		throw error;
	} finally {
		clearTimeout(giveUpTimer);
		// A local descendant error must cancel sibling recursive waits owned by
		// this barrier before their propagation listeners are removed.
		cancellation.abort();
		externalSignal?.removeEventListener("abort", cancelFromParent);
		cancellation.signal.removeEventListener("abort", onCancelled);
		host._rlmQuiescenceWaitAborts.delete(cancellation);
	}
}

// A done child sits in BOTH maps until passivation; the visited set keeps that dual membership from doubling the walk.
export function* rlmSubtreeSessions(root: AgentSession): Generator<AgentSession> {
	const visited = new Set<AgentSession>([root]);
	const stack: AgentSession[] = [root];
	while (stack.length > 0) {
		const session = stack.pop()!;
		yield session;
		for (const run of session._activeRlmChildRuns.values()) {
			if (run.session && !visited.has(run.session)) {
				visited.add(run.session);
				stack.push(run.session);
			}
		}
		for (const { session: retained } of session._rlmChildSessions.values()) {
			if (!visited.has(retained)) {
				visited.add(retained);
				stack.push(retained);
			}
		}
	}
}

/**
 * Cancel every running or queued RLM run in this session's subtree *and* stop
 * the in-flight turn of every retained descendant session.
 *
 * `_cancelActiveRlmChildRuns` alone only sees this session's own map, so a child
 * that had already settled - then been followed up, then spawned a child of its
 * own - kept running after the parent was killed, while `hasRunningRlmChildren()`
 * (which walks the subtree) reported the family as busy. Walking the same subtree
 * here aligns the kill with the judgement.
 *
 * `requestAbort` deliberately has no cascade semantics, so stopping each
 * descendant's own turn costs O(nodes) rather than O(depth^2); the visited set in
 * `_rlmSubtreeSessions` keeps a child that sits in both maps from being walked
 * twice. This session is excluded from step 2 because the caller already aborted
 * it. Cross-worker descendants are out of reach of an in-process walk and are
 * covered by the supervisor's kill path instead.
 *
 * `turnAbortReason` is the reason stamped on each aborted descendant turn. It
 * defaults to "user" (abort() is user semantics); a machine cascade passes its
 * own (abortForUpdateRestart passes "update_restart") so consumers that key on
 * a user abort - the quota park's user-cancel branch above all - do not eat a
 * restart.
 */
export function abortRlmSubtree(
	host: RlmChildQuiescenceHost,
	reason: string,
	options?: { turnAbortReason?: RlmChildTurnAbortReason },
): { cancelled: number; failures: number; depth: number } {
	const turnAbortReason = options?.turnAbortReason ?? "user";
	let cancelled = 0;
	let failures = 0;
	let depth = host._rlmDepth;
	for (const session of host._rlmSubtreeSessions()) {
		depth = Math.max(depth, session._rlmDepth);
		for (const run of [...session._activeRlmChildRuns.values()]) {
			try {
				if (!session._cancelRlmChildRun(run, reason)) continue;
				cancelled += 1;
				// The cancel already fired run.abort(); drop the handle so a second
				// trigger (a late publication, a repeated cascade) cannot abort the
				// same child session again.
				run.abort = noopRlmChildAbort;
			} catch (error) {
				failures += 1;
				sessionLog.warn("rlm abort cascade: cancelling a descendant run failed", {
					reason,
					childId: run.id,
					sessionId: session.sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (session === host) continue;
		try {
			// A retained descendant can be mid-turn with no run of ours tracking it:
			// it settled, was followed up, and is now streaming that follow-up.
			if (session.isStreaming) session.requestAbort({ reason: turnAbortReason });
		} catch (error) {
			failures += 1;
			sessionLog.warn("rlm abort cascade: stopping a descendant turn failed", {
				reason,
				sessionId: session.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (cancelled > 0 || failures > 0) {
		// Countable answer to "how much work did one Esc actually stop".
		sessionLog.info("rlm abort cascade", {
			reason,
			cancelled,
			failures,
			depth,
			sessionId: host.sessionId,
		});
	}
	return { cancelled, failures, depth };
}
