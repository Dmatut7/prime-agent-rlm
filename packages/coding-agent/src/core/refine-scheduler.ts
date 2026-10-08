/**
 * Refine-scheduler cluster extracted from agent-session.ts (twelfth cut): the
 * serialized-mode checkpoint family (background plan kickoff at message_end,
 * claim/consume, direct plan+apply at the shouldStopAfterTurn boundary), the
 * kernel host-request entry (handleRefineHostRequest), the disposal drain, and
 * the interactive auto-refine scheduling family (writable probe, pending-review
 * retention, cooldown stamping, timer scheduling). The moved methods keep
 * exactly the same bodies; they read the session through
 * {@link RefineSchedulerHost}, which `AgentSession` satisfies structurally, so
 * the move changes no runtime behavior. All 21 methods keep one-line shells on
 * the class (the spy/override hook points are too numerous to relocate), and
 * every intra-cluster call routes through the host so instance-level spies keep
 * intercepting exactly as they did when the bodies lived on the class. This
 * module imports ./refine-execution.js (a leaf) for RefineSkippedError and
 * the shared plan/apply guard helpers (runRefinePlanPhase,
 * withRefineApplyGuard); the execution cluster never imports this module, so
 * the layering stays acyclic.
 */

import type { AgentSession } from "./agent-session.js";
import { RefineSkippedError, runRefinePlanPhase, withRefineApplyGuard } from "./refine-execution.js";
import {
	type AutoRefineReason,
	type AutoRefineReview,
	assertHarnessStateWritable,
	isPersistentHarnessStorageSupported,
	loadHarnessState,
	type RefinementPlan,
} from "./refinement/index.js";

/**
 * How long a writability probe stays valid. Writability rarely flips mid-session,
 * and refine() re-checks it before writing, so a stale "allowed" cannot turn into
 * a silent write failure - it only avoids re-reading the whole harness state on
 * every turn boundary.
 */
const AUTO_REFINE_WRITABLE_PROBE_TTL_MS = 60_000;

function autoRefineInstructions(reason: AutoRefineReason, review: AutoRefineReview): string {
	const detail = review.instructions
		? `
Reviewer instructions: ${review.instructions}`
		: "";
	return `Automatic refine review triggered by ${reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: ${review.rationale}${detail}`;
}

/**
 * Stamp the auto-refine cooldown and (by default) reset the turn counter.
 * Reads/writes the same `_lastAutoRefineReviewAt` /
 * `_assistantTurnsSinceAutoRefine` fields the tests drive directly, stamp
 * always before reset. `at` pins the stamp to a previously captured timestamp
 * (the review-start `nowMs`: the cooldown window opens when the review began,
 * not when it settled); `resetTurns: false` is for failure paths that must not
 * clear the interval counter.
 */
function stampAutoRefineCooldown(host: RefineSchedulerHost, opts: { resetTurns?: boolean; at?: number } = {}): void {
	host._lastAutoRefineReviewAt = opts.at ?? Date.now();
	if (opts.resetTurns ?? true) {
		host._assistantTurnsSinceAutoRefine = 0;
	}
}

function resetAutoRefineTurns(host: RefineSchedulerHost): void {
	host._assistantTurnsSinceAutoRefine = 0;
}

function isAutoRefineUnderCooldown(host: RefineSchedulerHost, cooldownMs: number, nowMs = Date.now()): boolean {
	return host._lastAutoRefineReviewAt > 0 && nowMs - host._lastAutoRefineReviewAt < cooldownMs;
}

/**
 * Discriminated result from a serialized-mode background planning pass.
 * - "plan": review approved and planning succeeded; carry the exact plan,
 *   options, and abort controller so the boundary can apply directly
 *   without a second planning request.
 * - "skip": reviewer declined; no refine needed.
 * - "failure": review or planning threw; boundary should not retry.
 */
export type SerializedBackgroundPlanResult =
	| {
			status: "plan";
			plan: RefinementPlan;
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			abort: AbortController;
			branchVersion: number;
			/** How the planned round was initiated; the outcome receipt carries it (wave-47 A). */
			trigger: "manual" | "auto";
	  }
	| { status: "skip"; explicit?: boolean }
	| { status: "invalidated"; branchVersion: number }
	| {
			status: "failure";
			explicit: boolean;
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			branchVersion: number;
	  };

/**
 * The seam of `AgentSession` the extracted refine-scheduler cluster reads and
 * mutates. Member names mirror the class's own members so the extraction stays
 * a textual `this.` -> `host.` rename; members whose signatures are wide are
 * indexed access types so they stay single-sourced on the class. Every
 * scheduler method appears here so moved bodies dispatch intra-cluster calls
 * through the shells and instance-level spies keep intercepting. Cross-cluster
 * reads: refine() (execution cluster, ./refine-execution.js) waits on and
 * clears `_serializedPlanInFlight`/`_serializedExplicitRefineOptions`, and
 * `_discardPendingAutoRefine` cancels the post-compaction continuation owned
 * by the compaction cluster; both directions go through the class, never
 * module-to-module.
 */
export interface RefineSchedulerHost {
	readonly settingsManager: AgentSession["settingsManager"];
	readonly model: AgentSession["model"];
	readonly isStreaming: AgentSession["isStreaming"];
	readonly isCompacting: AgentSession["isCompacting"];
	readonly _disposed: AgentSession["_disposed"];
	readonly _disposing: AgentSession["_disposing"];
	readonly _rlmDepth: AgentSession["_rlmDepth"];
	readonly _serializedRefine: AgentSession["_serializedRefine"];
	readonly _autoRefineOperations: AgentSession["_autoRefineOperations"];
	readonly _scheduledAutoRefineTimers: AgentSession["_scheduledAutoRefineTimers"];
	_pendingRequestedRefine: AgentSession["_pendingRequestedRefine"];
	_assistantTurnsSinceAutoRefine: AgentSession["_assistantTurnsSinceAutoRefine"];
	_lastAutoRefineReviewAt: AgentSession["_lastAutoRefineReviewAt"];
	_autoRefineInProgress: AgentSession["_autoRefineInProgress"];
	_compactAutoRefinePending: AgentSession["_compactAutoRefinePending"];
	_turnIntervalAutoRefinePending: AgentSession["_turnIntervalAutoRefinePending"];
	_pendingAutoRefineReview: AgentSession["_pendingAutoRefineReview"];
	_autoRefineBranchVersion: AgentSession["_autoRefineBranchVersion"];
	_autoRefineReviewAbort?: AgentSession["_autoRefineReviewAbort"];
	_autoRefineWritableProbe?: AgentSession["_autoRefineWritableProbe"];
	_refineAbortController?: AgentSession["_refineAbortController"];
	_refineInFlight?: AgentSession["_refineInFlight"];
	_refinePlanInFlight?: AgentSession["_refinePlanInFlight"];
	_serializedPlanInFlight?: AgentSession["_serializedPlanInFlight"];
	_serializedPlanClaim?: AgentSession["_serializedPlanClaim"];
	_serializedExplicitRefineOptions?: AgentSession["_serializedExplicitRefineOptions"];
	// Cross-cluster read (compaction cluster owns the field and its writes):
	// the scheduler only checks whether a continuation is already scheduled
	// before arming the compact-triggered auto-refine timer.
	readonly _postCompactionContinuationScheduled: AgentSession["_postCompactionContinuationScheduled"];
	// Execution-cluster shells (./refine-execution.js): dispatched through the
	// host so instance-level spies on refine/_planRefine/_applyRefine keep
	// intercepting, exactly as they did when the bodies lived on the class.
	refine: AgentSession["refine"];
	_emitRefineFailed: AgentSession["_emitRefineFailed"];
	_reviewAutoRefine: AgentSession["_reviewAutoRefine"];
	_planRefine: AgentSession["_planRefine"];
	_applyRefine: AgentSession["_applyRefine"];
	_waitForRefineIdle: AgentSession["_waitForRefineIdle"];
	_scheduleSessionInputPump: AgentSession["_scheduleSessionInputPump"];
	_notifySessionInputCheckpointChange: AgentSession["_notifySessionInputCheckpointChange"];
	_localHarnessStateDir: AgentSession["_localHarnessStateDir"];
	// Compaction-cluster shell: _discardPendingAutoRefine's
	// cancelPostCompactionContinue option reaches the continuation owner here.
	_cancelPostCompactionContinue: AgentSession["_cancelPostCompactionContinue"];
	// The scheduler's own shells: intra-cluster calls go through these so the
	// class remains the single dispatch surface.
	handleRefineHostRequest: AgentSession["handleRefineHostRequest"];
	_runSerializedRefineCheckpoint: AgentSession["_runSerializedRefineCheckpoint"];
	_runSerializedRefineCheckpointAfterBackground: AgentSession["_runSerializedRefineCheckpointAfterBackground"];
	_runSerializedAutoRefineReview: AgentSession["_runSerializedAutoRefineReview"];
	_consumeSerializedBackgroundPlan: AgentSession["_consumeSerializedBackgroundPlan"];
	_applySerializedPlan: AgentSession["_applySerializedPlan"];
	_maybeStartSerializedBackgroundPlan: AgentSession["_maybeStartSerializedBackgroundPlan"];
	_runBackgroundPlan: AgentSession["_runBackgroundPlan"];
	_runSerializedRefine: AgentSession["_runSerializedRefine"];
	_drainPendingRefinementForDisposal: AgentSession["_drainPendingRefinementForDisposal"];
	_autoRefineAllowedForSession: AgentSession["_autoRefineAllowedForSession"];
	_discardPendingAutoRefine: AgentSession["_discardPendingAutoRefine"];
	_invalidatePendingAutoRefineForBranchChange: AgentSession["_invalidatePendingAutoRefineForBranchChange"];
	_consumePendingRequestedRefine: AgentSession["_consumePendingRequestedRefine"];
	_scheduleAutoRefineAfterAgentEnd: AgentSession["_scheduleAutoRefineAfterAgentEnd"];
	_scheduleAutoRefineAfterCompaction: AgentSession["_scheduleAutoRefineAfterCompaction"];
	_shouldSkipAutoRefineForActiveAgent: AgentSession["_shouldSkipAutoRefineForActiveAgent"];
	_scheduleDeferredAutoRefineIfIdle: AgentSession["_scheduleDeferredAutoRefineIfIdle"];
	_scheduleAutoRefine: AgentSession["_scheduleAutoRefine"];
	_maybeAutoRefine: AgentSession["_maybeAutoRefine"];
	_runApprovedRefine: AgentSession["_runApprovedRefine"];
}

/**
 * Serialized-mode auto-refine checkpoint called from _shouldStopAfterTurn.
 * Runs the review, planning, and application phases inline between turns
 * at the quiescent shouldStopAfterTurn boundary. This path NEVER calls
 * _maybeAutoRefine, _runApprovedRefine, public refine(), agent.abort(),
 * or agent.waitForIdle — all of which would deadlock or defer because
 * the agent loop still owns activeRun at this point. Instead it calls
 * _reviewAutoRefine, _planRefine, and _applyRefine directly with proper
 * in-flight guards and counter resets.
 */
export async function runSerializedRefineCheckpoint(host: RefineSchedulerHost): Promise<void> {
	if (host._disposed || host._disposing) {
		return;
	}

	// 1. Await any background plan that was started at message_end
	//    (either for a pending refine.run or for interval-triggered
	//    auto-refine). This must be checked BEFORE the pending and
	//    interval checks because background planning may have consumed
	//    the pending request at message_end.
	const branchVersion = host._autoRefineBranchVersion;
	const bgConsumption = await host._consumeSerializedBackgroundPlan(async (bgResult) => {
		if (host._disposed || host._disposing) {
			return true;
		}

		if (bgResult?.status === "plan") {
			if (bgResult.branchVersion !== host._autoRefineBranchVersion) {
				if (!host._pendingRequestedRefine) {
					stampAutoRefineCooldown(host);
					return true;
				}
			} else {
				// Apply the EXACT background plan directly via _applyRefine
				// (no second _planRefine call).
				try {
					await host._applySerializedPlan(bgResult);
				} catch (error) {
					host._emitRefineFailed(
						error,
						bgResult.options.global ? "global" : "local",
						bgResult.trigger === "auto" ? "auto" : "user",
					);
				}
				stampAutoRefineCooldown(host);
				if (!host._pendingRequestedRefine) {
					return true;
				}
			}
		}

		if (bgResult?.status === "skip") {
			// Reviewer declined or an extension skipped during background planning.
			// Reset exactly once. Never retry the interval review; only fall through for a separate pending refine.run.
			if (bgResult.explicit) {
				host._emitRefineFailed(new RefineSkippedError("Refinement skipped by extension"));
			}
			stampAutoRefineCooldown(host);
			if (!host._pendingRequestedRefine) {
				return true;
			}
		}

		if (bgResult?.status === "failure") {
			// Background review or planning failure stamps cooldown without a synchronous retry.
			// A separately queued refine.run may still be serviced below.
			if (branchVersion === host._autoRefineBranchVersion) {
				stampAutoRefineCooldown(host, { resetTurns: false });
			}
			// Re-queue an explicit refine.run whose background plan failed,
			// but only when branchVersion is still current and no newer
			// pending request has arrived since the background plan consumed
			// the original one. A newer request retains priority; interval
			// failures keep existing no-retry cooldown semantics.
			if (
				bgResult.explicit &&
				bgResult.branchVersion === host._autoRefineBranchVersion &&
				!host._pendingRequestedRefine
			) {
				host._pendingRequestedRefine = bgResult.options;
			}
			if (!host._pendingRequestedRefine) {
				return true;
			}
		}

		if (bgResult?.status === "invalidated" && !host._pendingRequestedRefine) {
			stampAutoRefineCooldown(host);
			return true;
		}

		await host._runSerializedRefineCheckpointAfterBackground(branchVersion);
		return true;
	});
	if (host._disposed || host._disposing || bgConsumption !== "none") {
		return;
	}
	await host._runSerializedRefineCheckpointAfterBackground(branchVersion);
}

export async function runSerializedRefineCheckpointAfterBackground(
	host: RefineSchedulerHost,
	branchVersion: number,
): Promise<void> {
	// No background result, or a refine.run arrived while the background result was
	// in flight. Fall through so an explicit pending request is serviced at this boundary.

	// 2. Agent-callable refine.run requests that were NOT consumed by
	//    background planning (e.g. interval not reached at message_end,
	//    or cooldown was active). Service them synchronously.
	const pending = host._pendingRequestedRefine;
	if (pending) {
		host._pendingRequestedRefine = undefined;
		try {
			await host._runSerializedRefine(pending);
		} catch (error) {
			host._emitRefineFailed(error, pending.global ? "global" : "local", "user");
		}
		stampAutoRefineCooldown(host);
		return;
	}

	// 3. Post-compaction auto-refine. Serialized sessions defer the
	// compaction trigger to this boundary instead of entering the interactive
	// path, which waits for agent idle and can never run inside a tool loop.
	if (!host._autoRefineAllowedForSession()) {
		host._compactAutoRefinePending = false;
		return;
	}
	const settings = host.settingsManager.getAutoRefineSettings();
	if (!settings.enabled) {
		host._compactAutoRefinePending = false;
		return;
	}
	if (host._compactAutoRefinePending) {
		if (!settings.compact) {
			host._compactAutoRefinePending = false;
		} else {
			const underCooldown = isAutoRefineUnderCooldown(host, settings.cooldownMs);
			if (underCooldown) {
				// Preserve the compact trigger for a later boundary, matching the
				// interactive path's pending behavior while the cooldown is active.
				return;
			}
			host._compactAutoRefinePending = false;
			await host._runSerializedAutoRefineReview("compact", branchVersion);
			return;
		}
	}

	// 4. Interval-triggered auto-refine (no background plan was started).
	if (host._assistantTurnsSinceAutoRefine < settings.turnInterval) {
		return;
	}
	const underCooldown = isAutoRefineUnderCooldown(host, settings.cooldownMs);
	if (underCooldown) {
		return;
	}
	await host._runSerializedAutoRefineReview("turn_interval", branchVersion);
}

export async function runSerializedAutoRefineReview(
	host: RefineSchedulerHost,
	reason: "compact" | "turn_interval",
	branchVersion: number,
): Promise<void> {
	const reviewAbort = new AbortController();
	host._autoRefineReviewAbort = reviewAbort;
	host._autoRefineInProgress = true;
	try {
		const review = await host._reviewAutoRefine(
			{ reason, turnsSinceLastReview: host._assistantTurnsSinceAutoRefine },
			reviewAbort.signal,
		);
		if (host._disposed || host._disposing || branchVersion !== host._autoRefineBranchVersion) {
			return;
		}
		if (!review.shouldRefine) {
			stampAutoRefineCooldown(host);
			return;
		}
		await host._runSerializedRefine({ instructions: autoRefineInstructions(reason, review) }, "auto");
		if (host._disposed || host._disposing || branchVersion !== host._autoRefineBranchVersion) {
			return;
		}
		stampAutoRefineCooldown(host);
	} catch (error) {
		if (branchVersion === host._autoRefineBranchVersion) {
			stampAutoRefineCooldown(host, { resetTurns: false });
			// An extension skip is an intentional non-round, not a failure.
			if (error instanceof RefineSkippedError) {
				resetAutoRefineTurns(host);
			} else {
				host._emitRefineFailed(error);
			}
		}
	} finally {
		if (host._autoRefineReviewAbort === reviewAbort) {
			host._autoRefineReviewAbort = undefined;
		}
		host._autoRefineInProgress = false;
	}
}

/**
 * Claim and process the serialized background plan if one is in flight.
 * A concurrent caller waits for the claim holder's full processing callback
 * instead of resuming as soon as planning settles.
 */
export async function consumeSerializedBackgroundPlan(
	host: RefineSchedulerHost,
	consume: (result: SerializedBackgroundPlanResult | undefined) => Promise<boolean>,
): Promise<"none" | "waited" | "continue" | "stop"> {
	if (host._serializedPlanClaim) {
		await host._serializedPlanClaim.catch(() => undefined);
		return "waited";
	}
	const planInFlight = host._serializedPlanInFlight;
	if (!planInFlight) {
		return "none";
	}

	let releaseClaim: () => void = () => {};
	const claim = new Promise<void>((resolve) => {
		releaseClaim = resolve;
	});
	host._serializedPlanClaim = claim;
	try {
		const result = await planInFlight.catch(() => undefined);
		if (host._serializedPlanInFlight === planInFlight) {
			host._serializedPlanInFlight = undefined;
			host._serializedExplicitRefineOptions = undefined;
		}
		return (await consume(result)) ? "stop" : "continue";
	} finally {
		releaseClaim();
		if (host._serializedPlanClaim === claim) {
			host._serializedPlanClaim = undefined;
		}
	}
}

/**
 * Apply an exact background plan directly via _applyRefine without
 * calling _planRefine again. Sets _refineInFlight for safety.
 */
export async function applySerializedPlan(
	host: RefineSchedulerHost,
	bgResult: Extract<SerializedBackgroundPlanResult, { status: "plan" }>,
): Promise<void> {
	await withRefineApplyGuard(host, () =>
		host._applyRefine(bgResult.plan, bgResult.options, bgResult.abort, bgResult.trigger),
	);
}

/**
 * Start background refinement planning at assistant message_end, while
 * tools are still executing. The plan (if any) is awaited at the
 * shouldStopAfterTurn boundary before applying. Planning overlaps tool
 * execution only — never another model request.
 */
export function maybeStartSerializedBackgroundPlan(host: RefineSchedulerHost): void {
	if (!host._serializedRefine || host._disposed || host._disposing) {
		return;
	}
	// Don't start if a plan is already in flight.
	if (host._serializedPlanInFlight || host._refineInFlight || host._refinePlanInFlight) {
		return;
	}

	// Start background planning for a pending agent-callable
	// refine.run request, so its plan is ready at the shouldStopAfterTurn
	// boundary. The pending request is consumed (cleared) here so the
	// boundary doesn't re-plan it. Explicit refine.run skips the review gate.
	const pending = host._pendingRequestedRefine;
	if (pending) {
		host._pendingRequestedRefine = undefined;
		host._serializedExplicitRefineOptions = pending;
		const refineAbort = new AbortController();
		host._refineAbortController = refineAbort;
		const branchVersion = host._autoRefineBranchVersion;
		host._serializedPlanInFlight = host._runBackgroundPlan(pending, refineAbort, branchVersion, true);
		return;
	}

	// Interval-triggered auto-refine background planning.
	if (!host._autoRefineAllowedForSession()) {
		return;
	}
	const settings = host.settingsManager.getAutoRefineSettings();
	if (!settings.enabled) {
		return;
	}
	if (host._assistantTurnsSinceAutoRefine < settings.turnInterval) {
		return;
	}
	const underCooldown = isAutoRefineUnderCooldown(host, settings.cooldownMs);
	if (underCooldown) {
		return;
	}

	const refineAbort = new AbortController();
	host._refineAbortController = refineAbort;
	const branchVersion = host._autoRefineBranchVersion;
	// Pass empty options — _runBackgroundPlan derives instructions from
	// the review result for interval-triggered auto-refine.
	host._serializedPlanInFlight = host._runBackgroundPlan({}, refineAbort, branchVersion);
}

/**
 * Shared background planning coroutine. Runs review + planRefine and
 * returns a discriminated result so the boundary can distinguish
 * reviewer-declined ("skip") from failure ("failure") from a ready
 * plan ("plan") and apply that exact plan without re-planning.
 */
export async function runBackgroundPlan(
	host: RefineSchedulerHost,
	options: { instructions?: string; rollbackId?: string; global?: boolean },
	refineAbort: AbortController,
	branchVersion: number,
	skipReview = false,
): Promise<SerializedBackgroundPlanResult | undefined> {
	try {
		let planOptions = options;
		if (!skipReview) {
			// Interval-triggered: run the review gate first, then derive
			// instructions from the review result (not prepopulated).
			const review = await host._reviewAutoRefine(
				{
					reason: "turn_interval",
					turnsSinceLastReview: host._assistantTurnsSinceAutoRefine,
				},
				refineAbort.signal,
			);
			if (host._disposed || host._disposing || branchVersion !== host._autoRefineBranchVersion) {
				return { status: "invalidated", branchVersion };
			}
			if (!review.shouldRefine) {
				return { status: "skip" };
			}
			planOptions = {
				instructions: autoRefineInstructions("turn_interval", review),
			};
		}
		// For explicit refine.run (skipReview=true), plan directly with
		// the user-provided options — no auto-review gate.
		const trigger = skipReview ? "manual" : "auto";
		const plan = await host._planRefine(planOptions, refineAbort.signal, trigger);
		if (host._disposed || host._disposing || branchVersion !== host._autoRefineBranchVersion) {
			return { status: "invalidated", branchVersion };
		}
		return {
			status: "plan",
			plan,
			options: planOptions,
			abort: refineAbort,
			branchVersion,
			trigger,
		};
	} catch (error) {
		if (host._disposed || host._disposing || branchVersion !== host._autoRefineBranchVersion) {
			return { status: "invalidated", branchVersion };
		}
		if (error instanceof RefineSkippedError) {
			return { status: "skip", explicit: skipReview };
		}
		return {
			status: "failure",
			explicit: skipReview,
			options,
			branchVersion,
		};
	} finally {
		if (host._refineAbortController === refineAbort) {
			host._refineAbortController = undefined;
		}
	}
}

/**
 * Direct serialized plan+apply. Calls _planRefine and _applyRefine with
 * proper in-flight guards but NEVER agent.waitForIdle or agent.abort.
 * The caller (shouldStopAfterTurn) is already at the quiescent boundary,
 * so the agent is between turns and _applyRefine's disconnect/reconnect
 * is safe.
 */
export async function runSerializedRefine(
	host: RefineSchedulerHost,
	options: {
		instructions?: string;
		rollbackId?: string;
		global?: boolean;
	},
	trigger: "manual" | "auto" = "manual",
): Promise<void> {
	if (host._disposed || host._disposing) {
		return;
	}
	// Guard: serialize against concurrent _runSerializedRefine calls.
	// _serializedPlanInFlight covers background planning; _refineInFlight
	// covers the apply phase. Both must be settled before starting a new
	// plan+apply cycle.
	while (host._serializedPlanInFlight || host._refineInFlight || host._refinePlanInFlight) {
		if (host._serializedPlanInFlight) {
			await host._consumeSerializedBackgroundPlan(async () => false);
		} else if (host._refineInFlight) {
			await host._refineInFlight;
		} else {
			await host._refinePlanInFlight;
		}
	}
	if (host._disposed || host._disposing) {
		return;
	}

	const { plan, refineAbort } = await runRefinePlanPhase(host, options, trigger);

	if (host._disposed || refineAbort.signal.aborted) {
		if (host._refineAbortController === refineAbort) {
			host._refineAbortController = undefined;
		}
		host._scheduleSessionInputPump();
		return;
	}

	// Do NOT call agent.waitForIdle() — we are at the quiescent boundary
	// already (shouldStopAfterTurn). _applyRefine handles disconnect/reconnect internally.
	await withRefineApplyGuard(host, () => host._applyRefine(plan, options, refineAbort, trigger));
}

/**
 * Handle a refine.* request from the kernel host bridge. Like compact,
 * refinement waits for the current turn to become idle before applying
 * changes, so refine.run only schedules it; _consumePendingRequestedRefine
 * fires it at the turn boundary. This prevents a deadlock that would occur
 * if refine() awaited agent idle from within the active tool call.
 */
export function handleRefineHostRequest(
	host: RefineSchedulerHost,
	type: string,
	payload: Record<string, unknown> = {},
): Record<string, unknown> {
	switch (type) {
		case "refine.status": {
			return {
				pending: host._pendingRequestedRefine !== undefined,
				in_flight:
					host._refineInFlight !== undefined ||
					host._refinePlanInFlight !== undefined ||
					host._serializedPlanInFlight !== undefined,
			};
		}
		case "refine.run": {
			const instructions = payload.instructions;
			if (instructions !== undefined && typeof instructions !== "string") {
				throw new Error("refine.run instructions must be a string when provided");
			}
			const globalFlag = payload.global;
			if (globalFlag !== undefined && typeof globalFlag !== "boolean") {
				throw new Error("refine.run global must be a boolean when provided");
			}
			if (!host.isStreaming) {
				return {
					scheduled: false,
					reason: "no active turn; refine can only be requested while a turn is running",
				};
			}
			const previous = host._pendingRequestedRefine ?? host._serializedExplicitRefineOptions;
			host._pendingRequestedRefine = {
				instructions: instructions ?? previous?.instructions,
				global: globalFlag ?? previous?.global,
			};
			// In serialized mode, kick off background planning immediately
			// (the primary response ended at message_end, tools are active).
			// This lets planning overlap tool execution rather than waiting
			// for the shouldStopAfterTurn boundary.
			if (host._serializedRefine) {
				if (host._serializedPlanInFlight) {
					host._autoRefineBranchVersion++;
					if (host._refineAbortController) {
						host._refineAbortController.abort();
					} else {
						host._serializedPlanInFlight = Promise.resolve({
							status: "invalidated",
							branchVersion: host._autoRefineBranchVersion,
						});
					}
				} else {
					host._maybeStartSerializedBackgroundPlan();
				}
			}
			return {
				scheduled: true,
				note: "Refinement runs when the current turn ends; applied edits are appended to your context as a refinement notice and you resume automatically. Continue working normally.",
			};
		}
		default:
			throw new Error(`unknown refine request type "${type}"`);
	}
}

/**
 * Await any in-flight refinement (planning or application) and run a
 * pending auto-refine that was scheduled but not yet started. Called
 * from disposeAsync before _disposing is set so refinement completes
 * before disposal.
 */
export async function drainPendingRefinementForDisposal(host: RefineSchedulerHost): Promise<void> {
	for (const timer of host._scheduledAutoRefineTimers) {
		clearTimeout(timer);
	}
	host._scheduledAutoRefineTimers.clear();
	await Promise.allSettled([...host._autoRefineOperations]);
	for (const timer of host._scheduledAutoRefineTimers) {
		clearTimeout(timer);
	}
	host._scheduledAutoRefineTimers.clear();
	// Wait for in-flight refinement (including serialized background plan) to settle.
	while (host._refineInFlight || host._refinePlanInFlight || host._serializedPlanInFlight) {
		if (host._refineInFlight) {
			await host._refineInFlight;
		} else if (host._refinePlanInFlight) {
			await host._refinePlanInFlight;
		} else if (host._serializedPlanInFlight) {
			// Await the background plan and apply a ready "plan" result before teardown.
			await host._consumeSerializedBackgroundPlan(async (bgResult) => {
				if (bgResult?.status === "plan" && bgResult.branchVersion === host._autoRefineBranchVersion) {
					try {
						await host._applySerializedPlan(bgResult);
					} catch (error) {
						host._emitRefineFailed(
							error,
							bgResult.options.global ? "global" : "local",
							bgResult.trigger === "auto" ? "auto" : "user",
						);
					}
					// Stamp cooldown and reset counter so the interval
					// check below does not trigger a duplicate refine.
					stampAutoRefineCooldown(host);
				}
				// Preserve a consumed explicit request when its background plan failed,
				// matching the turn-boundary recovery path. The pending drain below
				// retries it once before disposal.
				if (
					bgResult?.status === "failure" &&
					bgResult.explicit &&
					bgResult.branchVersion === host._autoRefineBranchVersion &&
					!host._pendingRequestedRefine
				) {
					host._pendingRequestedRefine = bgResult.options;
				}
				if (bgResult?.status === "skip" && bgResult.explicit) {
					host._emitRefineFailed(new RefineSkippedError("Refinement skipped by extension"));
				}
				// For "skip" or "failure", stamp cooldown and reset counter
				// so the interval check below does not trigger a duplicate
				// terminal retry.
				if (bgResult?.status === "skip" || bgResult?.status === "failure" || bgResult?.status === "invalidated") {
					stampAutoRefineCooldown(host);
				}
				return false;
			});
		} else {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	}
	// Drain an agent-callable refine.run request that was scheduled but
	// not yet consumed. Use the direct serialized path (no waitForIdle)
	// since the agent may still own activeRun at the final agent_end.
	if (host._pendingRequestedRefine) {
		const pending = host._pendingRequestedRefine;
		host._pendingRequestedRefine = undefined;
		try {
			await host._runSerializedRefine(pending);
		} catch {
			// Best-effort drain; refinement errors must not block disposal.
		}
		// Stamp cooldown and reset counter so the interval check below
		// does not trigger a duplicate refine after the explicit drain.
		stampAutoRefineCooldown(host);
	}
	// A serialized compaction can finish without another model turn. Drain its
	// pending review here so disposal does not silently lose the trigger.
	if (host._serializedRefine && host._compactAutoRefinePending && host._autoRefineAllowedForSession()) {
		const compactSettings = host.settingsManager.getAutoRefineSettings();
		if (!compactSettings.enabled || !compactSettings.compact) {
			host._compactAutoRefinePending = false;
		} else {
			const underCooldown = isAutoRefineUnderCooldown(host, compactSettings.cooldownMs);
			host._compactAutoRefinePending = false;
			if (!underCooldown) {
				try {
					await host._runSerializedAutoRefineReview("compact", host._autoRefineBranchVersion);
				} catch {
					// Best-effort drain; refinement errors must not block disposal.
				}
				return;
			}
		}
	}

	// If auto-refine is due but has not started yet, run it now so the
	// refinement is persisted before disposal. Use the direct serialized
	// path in serialized mode, or _maybeAutoRefine in interactive mode
	// (where the agent is idle at this point).
	if (host._disposed || !host._autoRefineAllowedForSession()) {
		return;
	}
	const settings = host.settingsManager.getAutoRefineSettings();
	if (!settings.enabled) {
		return;
	}
	if (host._assistantTurnsSinceAutoRefine < settings.turnInterval) {
		return;
	}
	const underCooldown = isAutoRefineUnderCooldown(host, settings.cooldownMs);
	if (underCooldown) {
		return;
	}
	if (host._serializedRefine) {
		await host._runSerializedRefineCheckpoint();
	} else {
		await host._maybeAutoRefine("turn_interval");
	}
}

export function autoRefineAllowedForSession(host: RefineSchedulerHost): boolean {
	if (!isPersistentHarnessStorageSupported() || host._rlmDepth !== 0) return false;
	// The cache is consulted before anything is resolved, so a hit costs no I/O at
	// all: _localHarnessStateDir() can mkdir the session artifact directory, and
	// loading the harness state walks every path segment and parses the whole local
	// store. This runs on the event queue, several times per turn.
	const probe = host._autoRefineWritableProbe;
	if (probe !== undefined && Date.now() - probe.at < AUTO_REFINE_WRITABLE_PROBE_TTL_MS) return probe.allowed;
	// One call, one local: this used to call _localHarnessStateDir() twice, the
	// second time behind a non-null assertion. A missing directory is deliberately
	// not cached, because it can appear later.
	//
	// A false verdict is cached too. Re-probing at every turn boundary is what this
	// cache exists to avoid, and the cost of a stale false is at most one TTL of
	// skipped auto-refine; the hard preflight before an actual refine still catches a
	// genuinely unwritable store.
	const dir = host._localHarnessStateDir();
	if (dir === undefined) return false;
	let allowed = false;
	try {
		assertHarnessStateWritable(loadHarnessState(dir, "local"));
		allowed = true;
	} catch {
		allowed = false;
	}
	host._autoRefineWritableProbe = { at: Date.now(), allowed };
	return allowed;
}

export function discardPendingAutoRefine(
	host: RefineSchedulerHost,
	options: { cancelPostCompactionContinue?: boolean } = {},
): void {
	host._compactAutoRefinePending = false;
	host._turnIntervalAutoRefinePending = false;
	host._pendingAutoRefineReview = undefined;
	if (options.cancelPostCompactionContinue) {
		host._cancelPostCompactionContinue();
	}
}

export async function invalidatePendingAutoRefineForBranchChange(host: RefineSchedulerHost): Promise<void> {
	host._autoRefineReviewAbort?.abort();
	host._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
	resetAutoRefineTurns(host);
	// Drop the cached verdict so the next refine re-probes. The branch change does
	// not move the session directory, so this is not about a new target: the probe
	// is only advisory. What actually stops a write to an unwritable harness state
	// is saveHarnessState re-asserting against the real target directory and
	// letting the syscall error propagate.
	host._autoRefineWritableProbe = undefined;
	// Increment branch version BEFORE aborting/awaiting the serialized plan.
	// This invalidates the plan's branchVersion check at the boundary
	// so even if the plan completes, the boundary will reject it
	// (bgResult.branchVersion !== host._autoRefineBranchVersion).
	host._autoRefineBranchVersion++;
	// Abort the in-flight refine/bplan controller so any pending
	// _planRefine or _reviewAutoRefine call settles via signal abort
	// rather than hanging forever.
	host._refineAbortController?.abort();
	if (host._serializedPlanInFlight) {
		await host._consumeSerializedBackgroundPlan(async () => false);
	}
	while (host._refinePlanInFlight) {
		await host._refinePlanInFlight;
	}
	await host._waitForRefineIdle();
}

/**
 * Consume a refine request that was scheduled by the agent-callable refine
 * skill (refine.run). Fire-and-forget: the refine() method handles its own
 * background planning, idle wait, application, and error recovery. Called
 * at the turn boundary after compaction checks and before auto-refine
 * scheduling so the manual request takes priority.
 */
export function consumePendingRequestedRefine(host: RefineSchedulerHost): boolean {
	const pending = host._pendingRequestedRefine;
	if (!pending) return false;
	host._pendingRequestedRefine = undefined;
	void host
		.refine(pending)
		.catch((error) => host._emitRefineFailed(error, pending.global ? "global" : "local", "user"));
	return true;
}

export function scheduleAutoRefineAfterAgentEnd(host: RefineSchedulerHost): void {
	if (!host._autoRefineAllowedForSession()) {
		return;
	}
	if (host._pendingAutoRefineReview) {
		host._scheduleAutoRefine(host._pendingAutoRefineReview.reason);
		return;
	}
	if (host._compactAutoRefinePending) {
		if (host._postCompactionContinuationScheduled) {
			return;
		}
		host._scheduleAutoRefine("compact");
		return;
	}

	host._scheduleAutoRefine("turn_interval");
}

export function scheduleAutoRefineAfterCompaction(
	host: RefineSchedulerHost,
	willContinueAfterCompaction: boolean,
): void {
	if (!host._autoRefineAllowedForSession()) {
		return;
	}
	if (host._serializedRefine) {
		// Serialized sessions must service compaction-triggered refinement at
		// shouldStopAfterTurn (or disposal), never through the interactive path.
		host._compactAutoRefinePending = true;
		return;
	}
	if (willContinueAfterCompaction) {
		host._compactAutoRefinePending = true;
		return;
	}

	host._scheduleAutoRefine("compact");
}

export function shouldSkipAutoRefineForActiveAgent(host: RefineSchedulerHost): boolean {
	return host.isStreaming || host.isCompacting;
}

export function scheduleDeferredAutoRefineIfIdle(host: RefineSchedulerHost): void {
	if (host._autoRefineInProgress || host._shouldSkipAutoRefineForActiveAgent() || host._pendingAutoRefineReview) {
		return;
	}
	if (host._turnIntervalAutoRefinePending) {
		host._turnIntervalAutoRefinePending = false;
		host._scheduleAutoRefine("turn_interval");
	}
}

export function scheduleAutoRefine(
	host: RefineSchedulerHost,
	reason: AutoRefineReason,
	branchVersion = host._autoRefineBranchVersion,
): void {
	const timer = setTimeout(() => {
		host._scheduledAutoRefineTimers.delete(timer);
		if (branchVersion !== host._autoRefineBranchVersion) {
			return;
		}
		const operation = host._maybeAutoRefine(reason);
		host._autoRefineOperations.add(operation);
		void operation.finally(() => host._autoRefineOperations.delete(operation)).catch(() => undefined);
	}, 0);
	host._scheduledAutoRefineTimers.add(timer);
}

export async function maybeAutoRefine(host: RefineSchedulerHost, reason: AutoRefineReason): Promise<void> {
	if (host._disposed || host._disposing) {
		host._discardPendingAutoRefine();
		return;
	}
	if (!host._autoRefineAllowedForSession()) {
		host._discardPendingAutoRefine();
		return;
	}

	const settings = host.settingsManager.getAutoRefineSettings();
	if (!settings.enabled) {
		host._discardPendingAutoRefine();
		return;
	}
	if (host._autoRefineInProgress || host._shouldSkipAutoRefineForActiveAgent()) {
		if (reason === "compact") {
			host._compactAutoRefinePending = true;
		} else {
			host._turnIntervalAutoRefinePending = true;
		}
		return;
	}

	const nowMs = Date.now();
	const underCooldown = isAutoRefineUnderCooldown(host, settings.cooldownMs, nowMs);

	const pendingReview = host._pendingAutoRefineReview;
	if (pendingReview) {
		// A failed refine stamps the cooldown; keep the pending review for later.
		if (underCooldown) {
			return;
		}
		await host._runApprovedRefine(pendingReview.reason, pendingReview.review);
		return;
	}

	if (reason === "compact" && !settings.compact) {
		host._compactAutoRefinePending = false;
		reason = "turn_interval";
	}
	if (reason === "turn_interval" && host._assistantTurnsSinceAutoRefine < settings.turnInterval) {
		return;
	}
	if (underCooldown) {
		if (reason === "compact") {
			host._compactAutoRefinePending = true;
		} else {
			host._turnIntervalAutoRefinePending = true;
		}
		return;
	}
	if (reason === "turn_interval") {
		host._turnIntervalAutoRefinePending = false;
	}
	if (!host.model) {
		if (reason === "compact") {
			host._compactAutoRefinePending = true;
		}
		return;
	}
	host._autoRefineInProgress = true;
	const turnsSinceLastReview = host._assistantTurnsSinceAutoRefine;
	const branchVersion = host._autoRefineBranchVersion;
	const reviewAbort = new AbortController();
	host._autoRefineReviewAbort = reviewAbort;
	let approvedReview: AutoRefineReview | undefined;
	try {
		const review = await host._reviewAutoRefine({ reason, turnsSinceLastReview }, reviewAbort.signal);
		if (host._disposed || host._disposing || branchVersion !== host._autoRefineBranchVersion) {
			return;
		}
		if (!review.shouldRefine) {
			const preserveTurnIntervalReview =
				reason === "compact" && host._assistantTurnsSinceAutoRefine >= settings.turnInterval;
			if (preserveTurnIntervalReview) {
				host._turnIntervalAutoRefinePending = true;
			} else {
				stampAutoRefineCooldown(host, { at: nowMs });
			}
			if (reason === "compact") {
				host._compactAutoRefinePending = false;
			}
			return;
		}
		if (host._shouldSkipAutoRefineForActiveAgent()) {
			host._pendingAutoRefineReview = { reason, review };
			return;
		}
		approvedReview = review;
	} catch {
		// Failed review: stamp the cooldown so a persistent failure (bad auth,
		// unparseable output) doesn't retry a full review on every agent end.
		if (branchVersion === host._autoRefineBranchVersion) {
			stampAutoRefineCooldown(host, { resetTurns: false });
		}
	} finally {
		if (host._autoRefineReviewAbort === reviewAbort) {
			host._autoRefineReviewAbort = undefined;
		}
		host._autoRefineInProgress = false;
		// When a refine follows, _runApprovedRefine schedules the deferred pass.
		if (!approvedReview) {
			host._scheduleDeferredAutoRefineIfIdle();
		}
	}
	if (approvedReview) {
		await host._runApprovedRefine(reason, approvedReview);
	}
}

export async function runApprovedRefine(
	host: RefineSchedulerHost,
	reason: AutoRefineReason,
	review: AutoRefineReview,
): Promise<void> {
	host._autoRefineInProgress = true;
	try {
		await host.refine({ instructions: autoRefineInstructions(reason, review) }, { trigger: "auto" });
		host._pendingAutoRefineReview = undefined;
		host._turnIntervalAutoRefinePending = false;
		stampAutoRefineCooldown(host);
		if (reason === "compact") {
			host._compactAutoRefinePending = false;
		}
	} catch (error) {
		// Auto-refine is opportunistic; manual /refine remains available.
		// Stamp the cooldown so a persistently failing refine doesn't retry
		// (via a retained pending review) on every agent end.
		stampAutoRefineCooldown(host, { resetTurns: false });
		if (error instanceof RefineSkippedError) {
			// A skipped round is consumed like a reviewer decline, not retained for retry.
			host._pendingAutoRefineReview = undefined;
			host._turnIntervalAutoRefinePending = false;
			resetAutoRefineTurns(host);
			if (reason === "compact") host._compactAutoRefinePending = false;
		}
	} finally {
		host._autoRefineInProgress = false;
		host._scheduleDeferredAutoRefineIfIdle();
	}
}
