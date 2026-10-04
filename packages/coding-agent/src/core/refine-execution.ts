/**
 * Refine-execution cluster extracted from agent-session.ts: the public refine()
 * entry point and its planning/application phases, the refinement-model
 * resolution, the auto-refine review call, the refinement history load, and the
 * receipt family (outcome message, failure receipt, failure event). The moved
 * methods keep exactly the same bodies; they read the session through
 * {@link RefineExecutionHost}, which `AgentSession` satisfies structurally, so
 * the move changes no runtime behavior. The `RefineSkippedError` /
 * `RefinePersistScopeError` classes and the `AutoRefineReviewRequest` /
 * `AutoRefineReviewer` types moved here with the cluster: agent-session.ts
 * re-exports them so existing import paths (including the test harness) keep
 * working, and this module never imports an agent-session value, so the
 * layering stays acyclic. The serialized-refine scheduling cluster
 * (checkpoint family, auto-refine scheduling, host-request entry) stays on
 * AgentSession through the twelfth cut and calls these functions through the
 * shells. The plan/apply guard helpers ({@link runRefinePlanPhase},
 * {@link withRefineApplyGuard}) are shared with ./refine-scheduler.js (the
 * serialized cluster) via the existing scheduler->execution import edge.
 */

import { dirname, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import { formatNoModelSelectedMessage } from "./auth-guidance.js";
import { serializeConversation } from "./compaction/index.js";
import type { SessionBeforeRefineResult } from "./extensions/index.js";
import {
	type CustomMessage,
	convertToLlm,
	createRefinementFailureMessage,
	createRefinementOutcomeMessage,
} from "./messages.js";
import { providerRetryPolicy } from "./provider-retry.js";
import {
	type AutoRefineReason,
	type AutoRefineReview,
	applyRefinementProposal,
	assertHarnessStateWritable,
	generateRefinementId,
	getGlobalHarnessStateDir,
	getHarnessStatePath,
	getRefinementHistory,
	type HarnessScope,
	inferRefinementResultScope,
	isPersistentHarnessStorageSupported,
	loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	mergeRefinementHistory,
	normalizeRefinementProposal,
	persistAppliedRefinement,
	planRefinement,
	type RefinementPlan,
	type RefinementResult,
	readHarnessStateStamp,
	reviewAutoRefine,
	WINDOWS_HARNESS_PERSISTENCE_UNSUPPORTED_ERROR,
} from "./refinement/index.js";

/** Thrown when a session_before_refine extension skips the refinement round. */
export class RefineSkippedError extends Error {}

/**
 * A refinement persist failure annotated with the effective target scope (the
 * requested scope can differ: a local request rolling back a global record
 * writes the global store). The message is the underlying persist error's;
 * failure receipts read the scope off this wrapper instead of the request.
 */
export class RefinePersistScopeError extends Error {
	constructor(
		message: string,
		readonly scope: HarnessScope,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "RefinePersistScopeError";
	}
}

export interface AutoRefineReviewRequest {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

export type AutoRefineReviewer = (request: AutoRefineReviewRequest, signal?: AbortSignal) => Promise<AutoRefineReview>;

/**
 * The seam of `AgentSession` the extracted refine-execution cluster reads and
 * mutates. Member names mirror the class's own members so the extraction stays
 * a textual `this.` -> `host.` rename; members whose signatures are wide are
 * indexed access types so they stay single-sourced on the class.
 * `AgentSession.refine`, `_planRefine`, `_applyRefine`, `_waitForRefineIdle`,
 * `_reviewAutoRefine` and `_emitRefineFailed` keep one-line shells that
 * delegate with `this` (the serialized checkpoint family, the auto-refine
 * scheduler, the pending-request consumer, the queued /refine command path and
 * the post-compaction continuation all call them there). The cluster-internal
 * helpers (`_resolveRefinementModel`, `_loadRefinementHistory`,
 * `_recordRefinementOutcome`, `_appendDurableRefineMessage`,
 * `_recordRefinementFailureReceipt`) have no shells.
 */
export interface RefineExecutionHost {
	readonly sessionId: AgentSession["sessionId"];
	readonly agent: AgentSession["agent"];
	readonly sessionManager: AgentSession["sessionManager"];
	readonly settingsManager: AgentSession["settingsManager"];
	readonly model: AgentSession["model"];
	readonly thinkingLevel: AgentSession["thinkingLevel"];
	readonly isStreaming: AgentSession["isStreaming"];
	readonly _disposed: AgentSession["_disposed"];
	readonly _extensionRunner: AgentSession["_extensionRunner"];
	readonly _agentEventQueue: AgentSession["_agentEventQueue"];
	readonly _compactionOperation: AgentSession["_compactionOperation"];
	readonly _branchSummaryOperation: AgentSession["_branchSummaryOperation"];
	readonly _autoRefineReviewer?: AgentSession["_autoRefineReviewer"];
	readonly _refineFailureReceipts: AgentSession["_refineFailureReceipts"];
	// Shared mutable state: written by recordRefinementOutcome here, read by the
	// harness-digest material-change gate (HarnessDigestHost declares it too).
	readonly _refinementReportedEntryVersions: AgentSession["_refinementReportedEntryVersions"];
	readonly _unpersistedOutcomes: AgentSession["_unpersistedOutcomes"];
	_refineAbortController?: AgentSession["_refineAbortController"];
	_refineInFlight?: AgentSession["_refineInFlight"];
	_refinePlanInFlight?: AgentSession["_refinePlanInFlight"];
	// Cross-cluster ownership: both fields belong to the serialized-refine
	// scheduling cluster (moved out in the twelfth cut, wave-46).
	// refine() reads them to wait out a background plan started during an active
	// turn, and clears them when the aborted turn that owned the plan will never
	// consume it.
	_serializedPlanInFlight?: AgentSession["_serializedPlanInFlight"];
	_serializedExplicitRefineOptions?: AgentSession["_serializedExplicitRefineOptions"];
	_emit: AgentSession["_emit"];
	_asError: AgentSession["_asError"];
	// refine() dispatches planning and application through these shells (rather
	// than calling the module functions directly) so instance-level spies on
	// `_planRefine` / `_applyRefine` keep intercepting, exactly as they did when
	// the bodies lived on the class.
	_planRefine: AgentSession["_planRefine"];
	_applyRefine: AgentSession["_applyRefine"];
	_disconnectFromAgent: AgentSession["_disconnectFromAgent"];
	_reconnectToAgent: AgentSession["_reconnectToAgent"];
	_localHarnessStateDir: AgentSession["_localHarnessStateDir"];
	_loadMergedHarnessState: AgentSession["_loadMergedHarnessState"];
	_getRequiredRequestAuth: AgentSession["_getRequiredRequestAuth"];
	_authenticatedRlmModels: AgentSession["_authenticatedRlmModels"];
	_scheduleSessionInputPump: AgentSession["_scheduleSessionInputPump"];
	_notifySessionInputCheckpointChange: AgentSession["_notifySessionInputCheckpointChange"];
}

/**
 * Narrow seam for {@link runRefinePlanPhase}: both RefineExecutionHost and
 * RefineSchedulerHost (./refine-scheduler.js) satisfy it structurally.
 */
export interface RefinePlanGuardHost {
	_refineAbortController?: AgentSession["_refineAbortController"];
	_refinePlanInFlight?: AgentSession["_refinePlanInFlight"];
	_planRefine: AgentSession["_planRefine"];
	_scheduleSessionInputPump: AgentSession["_scheduleSessionInputPump"];
}

/**
 * Planning-phase guard shared by refine() and the serialized scheduler:
 * create the abort controller, run one planning pass under
 * `_refinePlanInFlight`, and on failure clear the controller and kick the
 * input pump before rethrowing. The trigger is resolved by the caller.
 * Planning dispatches through `host._planRefine` so instance-level spies keep
 * intercepting.
 */
export async function runRefinePlanPhase(
	host: RefinePlanGuardHost,
	options: { instructions?: string; rollbackId?: string; global?: boolean },
	trigger: "manual" | "auto",
): Promise<{ plan: RefinementPlan; refineAbort: AbortController }> {
	const refineAbort = new AbortController();
	host._refineAbortController = refineAbort;

	const planRun = host._planRefine(options, refineAbort.signal, trigger);
	const planSettled = planRun.then(
		() => undefined,
		() => undefined,
	);
	host._refinePlanInFlight = planSettled;
	let plan: RefinementPlan;
	try {
		plan = await planRun;
	} catch (error) {
		if (host._refineAbortController === refineAbort) {
			host._refineAbortController = undefined;
		}
		host._scheduleSessionInputPump();
		throw error;
	} finally {
		if (host._refinePlanInFlight === planSettled) {
			host._refinePlanInFlight = undefined;
		}
	}
	return { plan, refineAbort };
}

/**
 * Narrow seam for {@link withRefineApplyGuard}: both RefineExecutionHost and
 * RefineSchedulerHost (./refine-scheduler.js) satisfy it structurally.
 */
export interface RefineApplyGuardHost {
	_refineInFlight?: AgentSession["_refineInFlight"];
	_notifySessionInputCheckpointChange: AgentSession["_notifySessionInputCheckpointChange"];
	_scheduleSessionInputPump: AgentSession["_scheduleSessionInputPump"];
}

/**
 * Apply-phase guard shared by refine() and the serialized scheduler: block new
 * turns on one shared settled promise covering the body's critical section.
 * The finally order is part of the contract: resolve the promise first
 * (waiters wake with `_refineInFlight` still set and re-check it), then clear
 * the field by identity, then notify and pump. The body dispatches through
 * `host._applyRefine` at the call site so instance-level spies keep
 * intercepting.
 */
export async function withRefineApplyGuard<T>(host: RefineApplyGuardHost, body: () => Promise<T>): Promise<T> {
	let resolveApplySettled: () => void = () => {};
	const applySettled = new Promise<void>((resolve) => {
		resolveApplySettled = resolve;
	});
	host._refineInFlight = applySettled;
	try {
		return await body();
	} finally {
		resolveApplySettled();
		if (host._refineInFlight === applySettled) {
			host._refineInFlight = undefined;
		}
		host._notifySessionInputCheckpointChange();
		host._scheduleSessionInputPump();
	}
}

export function emitRefineFailed(host: RefineExecutionHost, error: unknown, scope: HarnessScope = "local"): void {
	// Idempotent per error object: refine() failures are reported by the direct
	// path AND by queued/auto callers that catch the same rethrown error; the
	// first receipt wins and later calls on the same error are no-ops.
	if (error instanceof Object && host._refineFailureReceipts.has(error)) return;
	const reason = error instanceof Error ? error.message : String(error);
	// MV-5: the requested scope is the caller's guess; a persist failure
	// knows the effective target scope (a local request can roll back a
	// global record) and the receipt must carry that one.
	const effectiveScope = error instanceof RefinePersistScopeError ? error.scope : scope;
	host._emit({
		type: "refine_failed",
		error: reason,
	});
	// MV-5: every refinement failure - plan parse, length guard, provider
	// error, or the persist rejection above - leaves a model-visible receipt,
	// the same surface successes use (e6c1af56). Without it the failure was
	// UI/event-only and the model never learned its refine.run produced
	// nothing. A skip is a deliberate decline, not a failure: it stays
	// event-only. K3R-8/F9: the skip early-return comes BEFORE the receipt-set
	// add - a reused skip sentinel must not be permanently silenced, and only
	// a value that actually produced a receipt guards later calls.
	if (error instanceof RefineSkippedError) return;
	if (error instanceof Object) host._refineFailureReceipts.add(error);
	recordRefinementFailureReceipt(host, reason, effectiveScope);
}

export function recordRefinementFailureReceipt(host: RefineExecutionHost, reason: string, scope: HarnessScope): void {
	const message = createRefinementFailureMessage({
		refinementId: generateRefinementId(),
		scope,
		reason,
	});
	try {
		host.sessionManager.appendCustomMessageEntryWithRollback(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
	} catch (error) {
		const persistenceError = error instanceof Error ? error.message : String(error);
		// Same disclosure rule as compaction outcomes: the receipt stays
		// model-visible for this process and says it could not be saved.
		const unpersisted = createRefinementFailureMessage(
			{ refinementId: message.details.refinementId, scope, reason },
			true,
			message.timestamp,
		);
		unpersisted.content = `${message.content}\n\nThis refinement failure receipt could not be saved to session history: ${persistenceError}`;
		host._unpersistedOutcomes.push(unpersisted);
		host.agent.state.messages.push(unpersisted);
		host._emit({ type: "message_start", message: unpersisted });
		host._emit({ type: "message_end", message: unpersisted });
		return;
	}
	host.agent.state.messages.push(message);
	host._emit({ type: "message_start", message });
	host._emit({ type: "message_end", message });
}

/**
 * Refinement passes (review and planning) run with their own prompts, so
 * issuing them on the session model evicts the provider's prefix-cache entry
 * for the session and forces a full context re-read on the next session
 * request. Route them to the configured auxiliary model when it is set and
 * usable; fall back to the session model otherwise.
 */
export async function resolveRefinementModel(
	host: RefineExecutionHost,
): Promise<{ model: Model<Api>; apiKey: string; headers?: Record<string, string> } | undefined> {
	const sessionModel = host.model;
	if (!sessionModel) {
		return undefined;
	}
	const selector = host.settingsManager.getAuxiliaryModel()?.trim().toLowerCase();
	if (!selector || `${sessionModel.provider}/${sessionModel.id}`.toLowerCase() === selector) {
		const { apiKey, headers, requestModel } = await host._getRequiredRequestAuth(sessionModel);
		return { model: requestModel, apiKey, headers };
	}
	try {
		const model = (await host._authenticatedRlmModels()).find(
			(candidate) => `${candidate.provider}/${candidate.id}`.toLowerCase() === selector,
		);
		if (!model) {
			throw new Error(`model "${selector}" is unavailable, unauthenticated, or expired`);
		}
		const { apiKey, headers, requestModel } = await host._getRequiredRequestAuth(model);
		return { model: requestModel, apiKey, headers };
	} catch {
		// Error details from the auth stack can embed credential material, so only
		// the selector is logged (CodeQL js/clear-text-logging).
		console.warn(`Warning: auxiliaryModel "${selector}" unusable for refinement; using the session model.`);
		const { apiKey, headers, requestModel } = await host._getRequiredRequestAuth(sessionModel);
		return { model: requestModel, apiKey, headers };
	}
}

export async function runAutoRefineReview(
	host: RefineExecutionHost,
	context: AutoRefineReviewRequest,
	signal?: AbortSignal,
): Promise<AutoRefineReview> {
	if (host._autoRefineReviewer) {
		return host._autoRefineReviewer(context, signal);
	}
	const refinementModel = await resolveRefinementModel(host);
	if (!refinementModel) {
		return { shouldRefine: false, rationale: "No model selected." };
	}
	return reviewAutoRefine(
		host.agent.state.messages,
		host._loadMergedHarnessState(),
		loadRefinementHistory(host),
		refinementModel.model,
		refinementModel.apiKey,
		context,
		refinementModel.headers,
		signal,
		host.thinkingLevel,
		providerRetryPolicy(host.settingsManager),
		host.sessionId,
	);
}

export function loadRefinementHistory(host: RefineExecutionHost): RefinementResult[] {
	return mergeRefinementHistory(
		loadGlobalRefinementHistory(getGlobalHarnessStateDir()),
		getRefinementHistory(host.sessionManager.getEntries().filter((entry) => entry.type === "custom")),
	);
}

/**
 * Refine editable continual harness state: prompt notes, memory, skills, and subagent specs.
 * The base system prompt is intentionally not editable through this path.
 *
 * Planning runs in the background and does NOT block turn entry points
 * (`_waitForRefineIdle` only waits for `_refineInFlight`). Only the fast
 * application phase (disk I/O + in-memory mutation) blocks turn entry points.
 */
export async function refine(
	host: RefineExecutionHost,
	options: {
		instructions?: string;
		rollbackId?: string;
		global?: boolean;
	} = {},
	internal: { skipAbort?: boolean; trigger?: "manual" | "auto" } = {},
): Promise<RefinementResult> {
	if (!isPersistentHarnessStorageSupported()) {
		throw new Error(WINDOWS_HARNESS_PERSISTENCE_UNSUPPORTED_ERROR);
	}
	const preflightDir = options.global ? getGlobalHarnessStateDir() : host._localHarnessStateDir();
	if (preflightDir) assertHarnessStateWritable(loadHarnessState(preflightDir, options.global ? "global" : "local"));
	// Queued /refine executes from the session-input pump between turns;
	// refine never aborts the agent (planning is backgrounded and the apply
	// phase waits for quiescence), so skipAbort only asserts the pump's
	// idle invariant instead of changing abort behavior.
	if (internal.skipAbort && host.isStreaming) {
		throw new Error("Cannot refine without aborting while the agent is running.");
	}
	// Wait for any existing refine (both planning and application) before
	// starting a new run. This serializes concurrent /refine calls so two
	// planning phases cannot race into concurrent _applyRefine calls that
	// overwrite harness state.
	while (host._refineInFlight || host._refinePlanInFlight || host._serializedPlanInFlight) {
		if (host._refineInFlight) {
			await host._refineInFlight;
		} else if (host._refinePlanInFlight) {
			await host._refinePlanInFlight;
		} else {
			// A serialized background plan is in flight (started during an
			// active turn at message_end). Wait for planning and for the active
			// turn to settle so its normal checkpoint can consume the plan.
			const serializedPlanInFlight = host._serializedPlanInFlight;
			await serializedPlanInFlight;
			if (host._refineInFlight || host._refinePlanInFlight) {
				continue;
			}
			await host.agent.waitForIdle();
			// Aborted turns skip shouldStopAfterTurn. Drop their settled plan
			// after idle so a later public refine cannot spin on it forever.
			if (host._serializedPlanInFlight === serializedPlanInFlight) {
				host._serializedPlanInFlight = undefined;
				host._serializedExplicitRefineOptions = undefined;
			}
		}
	}

	const { plan, refineAbort } = await runRefinePlanPhase(host, options, internal.trigger ?? "manual");

	// Block new turns before waiting for the current turn to finish. One shared
	// settled promise covers the full transition and apply critical section.
	return withRefineApplyGuard(host, async () => {
		// Wait for the session to become quiescent before applying. Planning is
		// allowed to overlap active user work, but application must not disconnect
		// event handling until that work and its queued events have completed.
		await host.agent.waitForIdle();
		while (true) {
			const eventQueue = host._agentEventQueue;
			const compactionOp = host._compactionOperation;
			const branchSummaryOp = host._branchSummaryOperation;
			await Promise.allSettled([
				eventQueue,
				...(compactionOp ? [compactionOp] : []),
				...(branchSummaryOp ? [branchSummaryOp] : []),
			]);
			if (
				eventQueue === host._agentEventQueue &&
				compactionOp === host._compactionOperation &&
				branchSummaryOp === host._branchSummaryOperation
			) {
				break;
			}
		}
		if (host._disposed || refineAbort.signal.aborted) {
			throw new Error("Refinement cancelled because the session was disposed.");
		}
		try {
			return await host._applyRefine(plan, options, refineAbort, internal.trigger ?? "manual");
		} catch (error) {
			// MV-5 parity for the direct refine() path (kernel skill, auto runs):
			// a persist/apply failure leaves a model-visible failure receipt the
			// same way the queued /refine command path does. K3R-8: normalize the
			// thrown value into one Error object here and rethrow THAT object, so
			// every downstream catch (queued /refine, pending refine.run) shares a
			// single idempotency key with _emitRefineFailed's receipt guard - a raw
			// non-Error value used to defeat the WeakSet dedup and double-report.
			const normalized = host._asError(error);
			emitRefineFailed(host, normalized, options?.global ? "global" : "local");
			throw normalized;
		}
	});
}

/**
 * Block a new agent turn until any in-flight refine application phase has
 * reattached event handling; otherwise the turn's messages are never
 * persisted or rendered.
 *
 * The idle-wait and application phase (`_refineInFlight`) block here. The
 * background planning phase (`_refinePlanInFlight`) does NOT block turns.
 * Refine failures surface to the refine caller, not here.
 */
export async function waitForRefineIdle(host: RefineExecutionHost): Promise<void> {
	while (host._refineInFlight) {
		await host._refineInFlight;
	}
}

/**
 * Background planning phase: runs the LLM planning call via `planRefinement`.
 * Does not disconnect from or abort the agent. Returns the plan without
 * applying anything.
 */
export async function planRefine(
	host: RefineExecutionHost,
	options: { instructions?: string; rollbackId?: string; global?: boolean },
	signal: AbortSignal,
	trigger: "manual" | "auto" = "manual",
): Promise<RefinementPlan> {
	if (host._disposed) {
		throw new Error("Cannot refine a disposed session.");
	}

	if (!host.model) {
		throw new Error(formatNoModelSelectedMessage());
	}

	const refinementModel = await resolveRefinementModel(host);
	if (!refinementModel) {
		throw new Error(formatNoModelSelectedMessage());
	}
	const globalHarnessStateDir = getGlobalHarnessStateDir();
	const localHarnessStateDir = host._localHarnessStateDir();
	const requestedScope = options.global ? "global" : "local";
	if (!options.rollbackId && requestedScope === "local" && !localHarnessStateDir) {
		throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
	}
	const globalPlanningState = loadHarnessState(globalHarnessStateDir, "global");
	const localPlanningState = localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined;
	const planningState =
		requestedScope === "global" ? globalPlanningState : mergeHarnessStates(globalPlanningState, localPlanningState);
	const history = loadRefinementHistory(host);
	const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
	let baselineScope = rollbackTarget ? (inferRefinementResultScope(rollbackTarget) ?? requestedScope) : requestedScope;
	let baselineHarnessStateDir = baselineScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
	if (rollbackTarget?.harnessStatePath) {
		baselineHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
		baselineScope = resolve(baselineHarnessStateDir) === resolve(globalHarnessStateDir) ? "global" : "local";
	}
	if (!baselineHarnessStateDir) {
		throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
	}
	const baselineState = rollbackTarget
		? loadHarnessState(baselineHarnessStateDir, baselineScope)
		: baselineScope === "global"
			? globalPlanningState
			: localPlanningState!;
	if (!options.rollbackId && host._extensionRunner.hasHandlers("session_before_refine")) {
		const result = (await host._extensionRunner.emit({
			type: "session_before_refine",
			preparation: {
				trigger,
				instructions: options.instructions,
				scope: requestedScope,
				planningState,
				history,
				conversationText: serializeConversation(convertToLlm(host.agent.state.messages)).slice(-80_000),
			},
			signal,
		})) as SessionBeforeRefineResult | undefined;
		if (host._disposed || signal.aborted) {
			throw new Error("Refinement cancelled because the session was disposed.");
		}
		if (result?.skip) {
			throw new RefineSkippedError("Refinement skipped by extension");
		}
		if (result?.proposal !== undefined) {
			return {
				proposal: normalizeRefinementProposal(result.proposal),
				id: generateRefinementId(),
				baselineState,
			};
		}
	}
	const plan = await planRefinement(
		host.agent.state.messages,
		planningState,
		history,
		refinementModel.model,
		refinementModel.apiKey,
		{ ...options, retry: providerRetryPolicy(host.settingsManager) },
		refinementModel.headers,
		signal,
		host.thinkingLevel,
		host.sessionId,
	);
	if (host._disposed || signal.aborted) {
		throw new Error("Refinement cancelled because the session was disposed.");
	}
	return { ...plan, baselineState };
}

export function recordRefinementOutcome(
	host: RefineExecutionHost,
	result: RefinementResult,
	trigger: "manual" | "auto" = "manual",
): void {
	// The receipt itemizes every edit it carries, applied and refused alike, so the
	// material-change gate can tell "the model already heard about this entry" from
	// "another seat moved the store" (merge doc 14.2: no double delivery).
	const scope = result.scope ?? "local";
	for (const edit of result.appliedEdits) {
		const entry = edit.after ?? edit.before;
		// Version-aware on purpose: the receipt itemized THIS version, so a later bump
		// by another writer is fresh news and must still re-inject (merge doc 12.2).
		if (entry) {
			host._refinementReportedEntryVersions.set(`${edit.kind}:${entry.scope ?? scope}:${edit.id}`, entry.version);
		}
	}
	// wave-47 A: the TUI hides a clean background tidy but must always answer an
	// explicit /refine, so the receipt carries how the refinement was initiated.
	// refine.run lands on "manual" here: an explicit request, shown like /refine.
	appendDurableRefineMessage(
		host,
		createRefinementOutcomeMessage(result, true, Date.now(), trigger === "auto" ? "auto" : "user"),
	);
}

export function appendDurableRefineMessage(host: RefineExecutionHost, message: CustomMessage): void {
	try {
		host.sessionManager.appendCustomMessageEntryWithRollback(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
	} catch {
		// Not in the session file, so context rebuilds would drop the outcome.
		host._unpersistedOutcomes.push(message);
	}
	host.agent.state.messages.push(message);
	host._emit({ type: "message_start", message });
	host._emit({ type: "message_end", message });
}

/**
 * Synchronous application phase: disconnects from the agent, aborts any
 * in-flight agent run, applies the refinement plan to disk and memory, then
 * reconnects. This is the only phase that blocks turn entry points.
 */
export async function applyRefine(
	host: RefineExecutionHost,
	plan: RefinementPlan,
	options: { instructions?: string; rollbackId?: string; global?: boolean },
	refineAbort: AbortController,
	trigger: "manual" | "auto" = "manual",
): Promise<RefinementResult> {
	if (host._disposed) {
		throw new Error("Cannot refine a disposed session.");
	}
	// The caller has already set _refineInFlight and waited for agent idle.
	// Disconnect only for the brief apply + save + reconnect critical section.
	host._disconnectFromAgent();

	try {
		const globalHarnessStateDir = getGlobalHarnessStateDir();
		const localHarnessStateDir = host._localHarnessStateDir();
		const requestedScope = options.global ? "global" : "local";
		const history = loadRefinementHistory(host);
		const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
		let targetScope = plan.rollbackScope ?? requestedScope;
		let targetHarnessStateDir = targetScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
		if (targetScope === "local" && rollbackTarget?.harnessStatePath) {
			targetHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
			// Legacy records predate scope fields and default to "local" but may point
			// at the global store; honor the recorded path so its entries stay global.
			if (resolve(targetHarnessStateDir) === resolve(globalHarnessStateDir)) {
				targetScope = "global";
			}
		}
		if (!targetHarnessStateDir) {
			throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
		}
		// Re-read the target state immediately before applying so concurrent kernel
		// (`rlm.harness`) writes during the LLM pass are not clobbered. Capture
		// stamp so save refuses to overwrite a write that lands after this load.
		const expectedStamp = readHarnessStateStamp(targetHarnessStateDir);
		const state = loadHarnessState(targetHarnessStateDir, targetScope);
		const proposal = {
			...plan.proposal,
			edits: plan.proposal.edits.map((edit) => {
				const localPrefix = "local:";
				const globalPrefix = "global:";
				return {
					...edit,
					id: edit.id?.startsWith(localPrefix)
						? edit.id.slice(localPrefix.length)
						: edit.id?.startsWith(globalPrefix)
							? edit.id.slice(globalPrefix.length)
							: edit.id,
				};
			}),
		};
		if (host._disposed || refineAbort.signal.aborted) {
			throw new Error("Refinement cancelled because the session was disposed.");
		}
		const result = applyRefinementProposal(state, proposal, {
			id: plan.id,
			rollbackOf: plan.rollbackOf,
			scope: targetScope,
			baselineState: plan.baselineState,
			indexMaxBytes: host.settingsManager.getHarnessDigestIndexMaxBytes(),
			pathVocabulary: host.settingsManager.getHarnessPathVocabulary(),
			enforceIndexCap: host.settingsManager.getHarnessEnforceIndexCap(),
		});
		result.harnessStatePath = getHarnessStatePath(targetHarnessStateDir);
		let refinementPersistError: { error: unknown } | undefined;
		try {
			persistAppliedRefinement({
				harnessStateDir: targetHarnessStateDir,
				state,
				result,
				expectedStamp,
				appendSessionAudit: (entry) => {
					host.sessionManager.appendCustomEntry("prime-agent.refinement", entry);
				},
				globalHarnessStateDir: targetScope === "global" ? globalHarnessStateDir : undefined,
			});
		} catch (error) {
			refinementPersistError = { error };
		}
		// MV-6: the completion receipt only lands on the success path. The
		// pre-fix order recorded it before the persist error was thrown, so a
		// concurrent-write rejection left a "Refinement complete" receipt in the
		// message flow while nothing landed on disk; the failure path now
		// reports through `_emitRefineFailed` at the caller's catch instead.
		// The wrapper carries the *effective* target scope (MV-5): a local
		// request rolling back a global record must not be reported with the
		// requested scope.
		if (refinementPersistError) {
			const cause = refinementPersistError.error;
			throw cause instanceof Error
				? new RefinePersistScopeError(cause.message, targetScope, { cause })
				: new RefinePersistScopeError(String(cause), targetScope, { cause });
		}
		recordRefinementOutcome(host, result, trigger);
		// No rebuild and no swap here (#2098): the prompt stays byte-identical so the
		// provider's cached prefix survives the apply. The applied and refused edits
		// reach the model through the outcome receipt above; a harness menu that moved
		// reaches it through the next committed turn's material-change digest delta.
		try {
			host._emit({ type: "refine_complete", result });
		} catch {
			// Listener failures must not flip a successful refinement into
			// a reported failure — the refinement is already persisted.
		}
		try {
			await host._extensionRunner.emit({
				type: "refine_complete",
				id: result.id,
				summary: result.summary,
				appliedEdits: result.appliedEdits.filter((edit) => edit.applied).length,
				scope: result.scope ?? "local",
			});
		} catch {
			// Extension emit failures must not flip a successful refinement
			// into a reported failure — the refinement is already persisted.
		}
		return result;
	} finally {
		if (host._refineAbortController === refineAbort) {
			host._refineAbortController = undefined;
		}
		if (!host._disposed) {
			host._reconnectToAgent();
		}
	}
}
