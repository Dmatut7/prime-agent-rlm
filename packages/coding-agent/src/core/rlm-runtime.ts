import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSession, RlmChildAgentActivity, RlmChildAgentStatus } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/index.js";
import type { HostRequestHandler } from "./kernel/index.js";
import type { RlmChildStallAbortFacts, RlmChildTerminalOutcomeKind } from "./rlm-child-terminal.js";
import { THINKING_LEVELS } from "./thinking-levels.js";

/** Request emitted by `rlm.run`; cellSourceCode preserves the spawning cell for display. */
export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
	cellSourceCode?: string;
}

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
}

export type RlmSubagentRegistryStatus = "running" | "completed" | "error";

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmSubagentRegistryStatus;
}

export interface RlmListSubagentsResult {
	subagents: RlmSubagentRegistryEntry[];
}

export interface RlmDeleteSubagentResult {
	subagent: RlmSubagentRegistryEntry;
	outcome?: "deleted" | "skipped_running";
}

export interface RlmModelMatch {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export interface RlmFindModelsResult {
	models: RlmModelMatch[];
}

/** Stall-watchdog kill facts as `rlm.collect` publishes them. */
export interface RlmCollectStallAbort {
	silent_ms: number;
	threshold_ms: number;
	in_flight_tools: string[];
	kernel_reasons?: string[];
	/**
	 * False while the watchdog aborted but the run never produced `agent_end`:
	 * "killed" is then not yet a fact, and the run may still recover.
	 */
	settled: boolean;
}

export interface RlmCollectResultEntry {
	rlm_child_id: string;
	session_name: string | undefined;
	session_dir: string;
	/** Raw run status: queued | running | done | error | cancelled. */
	status: RlmChildAgentStatus;
	/** True once the run reached a terminal state (its settlement resolved or rejected). */
	settled: boolean;
	answer_preview: string | undefined;
	error: string | undefined;
	duration_ms: number | undefined;
	tool_use_count: number | undefined;
	replied_since_task: boolean | undefined;
	/**
	 * Live activity at snapshot time (waiting | writing | executing | stalled),
	 * undefined when idle. For a child retained without a run - the daemon-recovery
	 * shape - this is the only signal that it is working on a follow-up, because its
	 * `status` stays "done" for the recorded task.
	 */
	activity_kind: RlmChildAgentActivity["kind"] | undefined;
	/**
	 * The terminal classification the run's own terminal path recorded (P0-2a
	 * four-state table). Undefined while the run is in flight, and undefined for
	 * a child whose notice path never ran - a suppressed or explicitly deleted
	 * child, or one rehydrated without a run. `status` cannot substitute for it:
	 * a watchdog kill finishes the turn, so its raw status reads "done".
	 */
	terminal_kind: RlmChildTerminalOutcomeKind | undefined;
	/** Model-facing reason recorded alongside {@link terminal_kind}. */
	terminal_reason: string | undefined;
	/**
	 * Set when a `completed_without_reply` verdict's notice was withheld at
	 * publication because the reply it called missing had been delivered in between.
	 * The verdict itself is unchanged - {@link terminal_kind} still reports what was
	 * decided when the run settled - so this is the reconciliation flag for a reader
	 * that sees a no-reply verdict and no notice in the parent's transcript. Optional
	 * and additive: an older reader ignores it.
	 */
	no_reply_notice_superseded?: boolean;
	/** Watchdog facts, present even when no failure notice was delivered. */
	stall_abort: RlmCollectStallAbort | undefined;
}

export interface RlmCollectResult {
	results: RlmCollectResultEntry[];
}

export type RlmCollectHandler = (
	targets: string[],
	timeoutMs: number,
	signal?: AbortSignal,
) => Promise<RlmCollectResult>;

export type RlmRunHandler = (request: RlmRunRequest, signal?: AbortSignal) => Promise<Record<string, unknown>>;
export type RlmListSubagentsHandler = () => RlmListSubagentsResult | Promise<RlmListSubagentsResult>;
export type RlmDeleteSubagentHandler = (target: string) => Promise<RlmDeleteSubagentResult>;
export type RlmFindModelsHandler = (query: string, limit: number) => RlmFindModelsResult | Promise<RlmFindModelsResult>;

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;
const RLM_MODEL_ERROR_SUGGESTION_LIMIT = 3;

export function normalizeRequestedRlmSubagentSessionName(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run name must be a string");
	}
	const name = value.trim();
	if (!name) {
		throw new Error("rlm.run name must not be empty");
	}
	if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`rlm.run name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

export function normalizeRequestedRlmSubagentThinkingLevel(value: unknown): ThinkingLevel | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run thinking must be a string");
	}
	const level = value.trim().toLowerCase();
	if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
		throw new Error(`rlm.run thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
	}
	return level as ThinkingLevel;
}

export function normalizeRequestedRlmSubagentModel(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error("rlm.run model must be a string");
	}
	const model = value.trim();
	if (!model) {
		throw new Error("rlm.run model must not be empty");
	}
	return model;
}

/** Create a readable, collision-resistant default name usable as an agent-message selector. */
export function createDefaultRlmSubagentSessionName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix =
		childId
			.replace(/^sub-/, "")
			.replace(/[^A-Za-z0-9]+/g, "")
			.slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findRlmModelMatches(query: string, models: Model<Api>[], limit: number): RlmModelMatch[] {
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models
		.map((model) => {
			const selector = `${model.provider}/${model.id}`;
			const fields = [selector, model.id, model.name || model.id];
			const normalizedFields = fields.map(normalizeModelSearchText);
			let score = normalizedQuery ? Number.POSITIVE_INFINITY : 0;
			if (normalizedQuery) {
				const exactIndex = normalizedFields.indexOf(normalizedQuery);
				const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
				const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
				if (exactIndex >= 0) score = exactIndex;
				else if (prefixIndex >= 0) score = 3 + prefixIndex;
				else if (partialIndex >= 0) score = 6 + partialIndex;
			}
			return { model, selector, score };
		})
		.filter((candidate) => Number.isFinite(candidate.score))
		.sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
		.slice(0, limit)
		.map(({ model, selector }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			selector,
		}));
}

/**
 * Models whose full selector ends with the reference, so a bare model id like
 * "z-ai/glm-5.3" also matches "prime-inference/z-ai/glm-5.3".
 */
function findRlmShortFormModelMatches(reference: string, models: Model<Api>[]): Model<Api>[] {
	const normalized = reference.trim().toLowerCase();
	if (!normalized) return [];
	return models.filter((model) => `${model.provider}/${model.id}`.toLowerCase().endsWith(`/${normalized}`));
}

/**
 * The single model a short-form reference resolves to: its unique match among
 * models, or the fallback model when no model matches. Stays undefined when
 * several models match, so an ambiguous reference is never auto-resolved.
 */
export function findUniqueRlmShortFormModelMatch(
	reference: string,
	models: Model<Api>[],
	fallback?: Model<Api>,
): Model<Api> | undefined {
	const matches = findRlmShortFormModelMatches(reference, models);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0 && fallback && findRlmShortFormModelMatches(reference, [fallback]).length === 1) {
		return fallback;
	}
	return undefined;
}

/**
 * Rejection message for an unresolved model reference: states that the model is
 * unavailable, unauthenticated, or expired, then the expected selector form and
 * close matches so the caller can retry with a full selector.
 */
export function formatRlmModelUnavailableError(reference: string, target: string, models: Model<Api>[]): string {
	const base = `Requested ${target} model "${reference}" is unavailable, unauthenticated, or expired`;
	const hint = `selectors use the form "provider/model-id" (e.g. "prime-inference/z-ai/glm-5.3")`;
	const normalizedReference = normalizeModelSearchText(reference);
	const closeMatches = normalizedReference
		? findRlmModelMatches(reference, models, RLM_MODEL_ERROR_SUGGESTION_LIMIT).map((match) => match.selector)
		: [];
	if (closeMatches.length === 0) {
		return `${base}; ${hint}`;
	}
	return `${base}; ${hint}; close matches: ${closeMatches.map((selector) => `"${selector}"`).join(", ")}`;
}

/** Adapt an RlmRunHandler into the typed `rlm.run` kernel host handler. */
export function createRlmRunHostHandler(handler: RlmRunHandler): HostRequestHandler {
	return async (payload, signal) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.run prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
		const result = await handler(
			{
				prompt: payload.prompt,
				kwargs,
				cellSourceCode,
			},
			signal,
		);
		return result as unknown as Record<string, unknown>;
	};
}

/** Search a bounded authenticated model catalog without adding it to the system prompt. */
export function createRlmFindModelsHostHandler(handler: RlmFindModelsHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.query !== "string") {
			throw new Error("rlm.find_models query must be a string");
		}
		const limit = payload.limit === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : payload.limit;
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RLM_MODEL_SEARCH_LIMIT) {
			throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`);
		}
		return { models: (await handler(payload.query, limit as number)).models };
	};
}

/** Expose the current parent session's direct RLM child registry to its kernel. */
export function createRlmListSubagentsHostHandler(handler: RlmListSubagentsHandler): HostRequestHandler {
	return async () => {
		const { subagents } = await handler();
		return { subagents };
	};
}

/** Delete one direct child selected from the current parent session's registry. */
export function createRlmDeleteSubagentHostHandler(handler: RlmDeleteSubagentHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.target !== "string" || !payload.target.trim()) {
			throw new Error("rlm.delete_subagent target must be a non-empty string");
		}
		const { subagent, outcome } = await handler(payload.target.trim());
		return outcome === undefined ? { subagent } : { subagent, outcome };
	};
}

/**
 * Largest `timeout_ms` a collect may ask for. Node clamps a `setTimeout` delay
 * above 2^31-1 to 1ms, so an oversized value would silently turn a long wait
 * into an immediate snapshot; rejecting it keeps the request honest.
 */
export const RLM_COLLECT_MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Head-room kept below the kernel's read-only host-request bound. The kernel
 * bounds every cancellable (read-only) host request at
 * `readOnlyHostRequestTimeoutMs`; a collect that waited right up to that value
 * would race the kernel's own bound and lose, turning "here are the current
 * snapshots" into "the host request failed". Staying inside the bound keeps the
 * collect contract - it never rejects on timeout - true in the real runtime.
 */
export const RLM_COLLECT_WAIT_MARGIN_MS = 2_000;

/**
 * The wait one collect call may actually take: the requested bound, kept inside
 * the host's read-only request budget. A budget smaller than the margin keeps
 * half of itself instead of collapsing to a non-blocking read.
 */
export function clampRlmCollectWaitMs(requestedMs: number, boundMs: number | undefined): number {
	if (!Number.isFinite(requestedMs) || requestedMs <= 0) return 0;
	if (boundMs === undefined || !Number.isFinite(boundMs) || boundMs <= 0) return requestedMs;
	const headroom =
		boundMs > RLM_COLLECT_WAIT_MARGIN_MS ? boundMs - RLM_COLLECT_WAIT_MARGIN_MS : Math.floor(boundMs / 2);
	return Math.min(requestedMs, headroom);
}

/** Project recorded watchdog facts onto the collect wire shape. */
export function rlmCollectStallAbort(facts: RlmChildStallAbortFacts | undefined): RlmCollectStallAbort | undefined {
	if (!facts) return undefined;
	const kernelReasons = facts.kernelReasons ?? [];
	return {
		silent_ms: facts.silentMs,
		threshold_ms: facts.thresholdMs,
		in_flight_tools: [...facts.inFlightTools],
		...(kernelReasons.length > 0 ? { kernel_reasons: [...kernelReasons] } : {}),
		settled: facts.settled,
	};
}

export interface CreateRlmCollectHostHandlerOptions {
	/**
	 * The kernel's read-only host-request bound, read live so an operator tuning
	 * the wait setting does not have to restart the session. Undefined or
	 * non-finite means "no bound" (the documented rollback lever).
	 */
	maxWaitMs?: () => number | undefined;
	/** Reported when a requested wait was cut down to that bound. */
	onClamped?: (facts: { requestedMs: number; effectiveMs: number }) => void;
}

/**
 * Typed fan-in for subagent results: `rlm.collect` waits (bounded) for the
 * selected direct children's runs to settle and returns result envelopes.
 *
 * Never steers the parent and never rejects on timeout: a timeout - or a cell
 * abort - returns the current snapshots so the caller can end its turn, poll, or
 * retry, and nothing behind the wait is cancelled.
 */
export function createRlmCollectHostHandler(
	handler: RlmCollectHandler,
	options?: CreateRlmCollectHostHandlerOptions,
): HostRequestHandler {
	return async (payload, signal) => {
		const rawTargets = payload.targets;
		if (rawTargets !== undefined && rawTargets !== null && !Array.isArray(rawTargets)) {
			throw new Error("rlm.collect targets must be an array of child ids or names");
		}
		const targets = (rawTargets ?? []).map((target) => {
			if (typeof target !== "string" || !target.trim()) {
				throw new Error("rlm.collect targets must be non-empty strings");
			}
			return target.trim();
		});
		const rawTimeout = payload.timeout_ms;
		if (rawTimeout !== undefined && rawTimeout !== null) {
			if (
				typeof rawTimeout !== "number" ||
				!Number.isSafeInteger(rawTimeout) ||
				rawTimeout < 0 ||
				rawTimeout > RLM_COLLECT_MAX_TIMEOUT_MS
			) {
				throw new Error(
					`rlm.collect timeout_ms must be a non-negative integer up to ${RLM_COLLECT_MAX_TIMEOUT_MS}`,
				);
			}
		}
		const requestedMs = typeof rawTimeout === "number" ? rawTimeout : 0;
		const timeoutMs = clampRlmCollectWaitMs(requestedMs, options?.maxWaitMs?.());
		if (timeoutMs !== requestedMs) {
			options?.onClamped?.({ requestedMs, effectiveMs: timeoutMs });
		}
		const { results } = await handler(targets, timeoutMs, signal);
		return { results, timeout_ms: timeoutMs };
	};
}

export interface RlmSubagentRuntime {
	session: AgentSession;
}

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoals: boolean;
	includeCompactSkill: boolean;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
	/** Request ID of the parent model call whose tool call caused this spawn. */
	spawnedByRequestId?: string;
	/** Source of the Python cell that spawned this subagent, for display. */
	spawnCode?: string;
	/** Publish the session to the parent before a host makes the runtime addressable. */
	onSessionPublished?: (session: AgentSession) => void;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	/** Persist host-owned completion before the child becomes passivation-eligible. */
	completeRlmSubagentRuntime?(childId: string, session: AgentSession): boolean;
	/** Release a host-owned child after its detached initial task settles. */
	releaseRlmSubagentRuntime?: (
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	/** Close or remove the host-owned child; session is absent when a persisted child is still passive. */
	deleteRlmSubagentRuntime(childId: string, session?: AgentSession): Promise<void>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}
