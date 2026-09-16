import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	adjustMaxTokensForThinking,
	completeSimple,
	getLogger,
	modelCannotDisableThinking,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../core/model-registry.js";
import type { AgentStatus, AgentTaskState } from "../../core/session-manager.js";
import { mapConcurrent } from "../../utils/map-concurrent.js";
import type { ActiveSessionState } from "./active-session-state.js";

const structuredLog = getLogger("coding-agent.daemon.session-summarizer");

const SWEEP_INTERVAL_MS = 25_000;
// Collapse a tool-use loop's rapid turn_end bursts into one summarization.
const SETTLE_DEBOUNCE_MS = 2_000;

/**
 * Bounds on a summary generation that keeps failing. Without them one broken
 * summary model meant a real API call per affected session per sweep, forever, all
 * of them launched in the same tick, with nothing in the log to show for it: an
 * idle session with a blank recap owed a summary on every pass by construction.
 * The ladder is per session and a new turn re-arms it, so a model that recovers is
 * picked up on the next activity instead of never.
 */
const SUMMARY_RETRY_BASE_MS = 60_000;
const SUMMARY_RETRY_MAX_MS = 30 * 60_000;
/** Failures after which the sweep stops trying until the session's next turn. */
export const SUMMARY_RETRY_LIMIT = 6;
/** At most one warn per session per window, so a broken model cannot flood the log. */
const SUMMARY_FAILURE_LOG_MIN_GAP_MS = 5 * 60_000;
/** Sweep fan-out: bounded, so N affected sessions are not N simultaneous API calls. */
export const SWEEP_CONCURRENCY = 4;

const SUMMARY_MODEL_PROVIDER = "prime-inference";
const SUMMARY_MODEL_ID = "qwen/qwen3-30b-a3b-instruct-2507";

const SUMMARY_CONTEXT_MESSAGES = 8;
const SUMMARY_MAX_CHARS_PER_MESSAGE = 600;
// Generous so a chatty model still closes the tags before truncation.
const SUMMARY_MAX_TOKENS = 400;
/**
 * Ceiling for the thinking reserve on this path: a model that cannot disable thinking
 * (thinkingLevelMap.off === null) spends part of maxTokens on reasoning it cannot be told
 * to skip, and 400 is not enough - measured on glm-5.3 with this exact prompt shape, 400
 * and 512 both end in finish=length with the closing tag cut off, which makes
 * parseAgentStatusResponse return undefined: the status line silently dies with no error
 * left in the log. 768 was the first cap that closed the tags, and 1024..2048 all parse
 * while the model actually spends only ~214..264 tokens, so a larger cap buys worst-case
 * latency on a 25s sweep and nothing else. Do not lower this to 512; it truncates too.
 */
const SUMMARY_MAX_TOKENS_WITH_THINKING_CAP = 2_048;
/** Sizing level only: never sent to the wire, never changes whether the model thinks. */
const THINKING_RESERVE_LEVEL = "medium" as const;
const warnedThinkingReserveTruncations = new Set<string>();

/**
 * Output budget for one status call. Models that can disable thinking keep the base budget
 * unchanged; model.maxTokens stays the hard ceiling, and a ceiling that eats the reserve is
 * warned about once because it degrades this path into a silent truncation.
 */
export function agentStatusMaxTokens(model: Model<Api>): number {
	if (!modelCannotDisableThinking(model)) return SUMMARY_MAX_TOKENS;
	const adjusted = adjustMaxTokensForThinking(SUMMARY_MAX_TOKENS, model.maxTokens, THINKING_RESERVE_LEVEL);
	// Uncapped twin of the same call: a larger result means model.maxTokens ate the reserve.
	const wanted = adjustMaxTokensForThinking(
		SUMMARY_MAX_TOKENS,
		Number.MAX_SAFE_INTEGER,
		THINKING_RESERVE_LEVEL,
	).maxTokens;
	if (adjusted.maxTokens < wanted) {
		const key = `agent-status:${model.provider}/${model.id}`;
		if (!warnedThinkingReserveTruncations.has(key)) {
			warnedThinkingReserveTruncations.add(key);
			structuredLog.warn("thinking reserve truncated by model maxTokens", {
				model: key,
				baseMaxTokens: SUMMARY_MAX_TOKENS,
				maxTokens: adjusted.maxTokens,
				wantedMaxTokens: wanted,
			});
		}
	}
	return Math.min(adjusted.maxTokens, SUMMARY_MAX_TOKENS_WITH_THINKING_CAP);
}

export const AGENT_STATUS_SYSTEM_PROMPT = `You generate a status line for an AI coding agent dashboard. You are given the recent conversation between a user and the agent, plus whether the agent is currently working or idle.

Output ONLY these two tags, nothing before, between, or after. Do not think out loud, explain, or count words.
<recap>a present-tense clause, at most 12 words, saying what the agent is doing or just did, no trailing period</recap>
<status>one of NEEDS_INPUT, COMPLETED</status>

STATUS meaning:
- COMPLETED: the agent finished its turn AND the user's request is fully done with nothing left.
- NEEDS_INPUT: the agent finished its turn but the task is not fully done — it asked a question, hit a blocker, or needs more prompting.
When you are unsure between COMPLETED and NEEDS_INPUT, choose NEEDS_INPUT.

Example:
<recap>Refactoring the auth middleware and updating its tests</recap>
<status>NEEDS_INPUT</status>`;

export interface AgentStatusResult {
	summary: string;
	taskState?: AgentTaskState;
}

/** Resolve the cheap summary model, or undefined when it has no configured auth. */
export function resolveSummaryModel(registry: ModelRegistry): Model<Api> | undefined {
	const model = registry.find(SUMMARY_MODEL_PROVIDER, SUMMARY_MODEL_ID);
	if (model && registry.hasConfiguredAuth(model)) {
		return model;
	}
	return undefined;
}

function messageText(content: unknown): { text: string; tools: string[] } {
	if (typeof content === "string") {
		return { text: content, tools: [] };
	}
	if (!Array.isArray(content)) {
		return { text: "", tools: [] };
	}
	const parts: string[] = [];
	const tools: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) {
			continue;
		}
		const type = (block as { type?: unknown }).type;
		if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		} else if (type === "tool_use" || type === "toolUse") {
			const name = (block as { name?: unknown }).name;
			if (typeof name === "string") {
				tools.push(name);
			}
		}
	}
	return { text: parts.join("\n"), tools };
}

function clamp(text: string, max: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/** Serialize the trailing messages into a compact prompt body (tool calls by name only). */
export function buildStatusContext(messages: readonly AgentMessage[], isWorking: boolean): string {
	const recent = messages.slice(-SUMMARY_CONTEXT_MESSAGES);
	const lines: string[] = [];
	for (const message of recent) {
		const role = message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") {
			continue;
		}
		const { text, tools } = messageText(message.content);
		const body = clamp(text, SUMMARY_MAX_CHARS_PER_MESSAGE);
		const toolNote = tools.length > 0 ? `[tools: ${[...new Set(tools)].join(", ")}]` : "";
		const rendered = [body, toolNote].filter((part) => part.length > 0).join(" ");
		if (rendered) {
			lines.push(`${role}: ${rendered}`);
		}
	}
	const state = isWorking ? "working" : "idle (finished its turn)";
	return `<agent-state>${state}</agent-state>\n<conversation>\n${lines.join("\n")}\n</conversation>`;
}

// Cuts a word-counting trailer the model sometimes appends, e.g.
// `Sending X. That's 5 words? Count: X(1)... = 6 words.`. Kept to structural
// counting markers so plain words ("Waiting for CI") survive.
const REASONING_TRAILER = /\s*(?:["”]\s*)?(?:\bthat['’]?s\s+\d+\s*words?\b|\bcount\s*:|\(\d+\)|=\s*\d+\s*words?\b).*/i;
const COUNTING_ARTIFACT = /\(\d+\)|=\s*\d+\s*words?\b/i;
const MAX_RECAP_WORDS = 16;

function cleanRecap(raw: string): string | undefined {
	const value = raw
		.trim()
		.replace(REASONING_TRAILER, "")
		.replace(/^["“']+|["”']+$/g, "")
		.replace(/[.\s]+$/, "")
		.trim();
	if (!value || value.startsWith("<") || /present-tense|12 words/i.test(value)) {
		return undefined;
	}
	if (COUNTING_ARTIFACT.test(value) || value.split(/\s+/).length > MAX_RECAP_WORDS) {
		return undefined;
	}
	return value;
}

/** Take the content of the last `<recap>` and `<status>` tags; idle verdicts default to needs_input. */
export function parseAgentStatusResponse(text: string, isWorking: boolean): AgentStatusResult | undefined {
	// Normalize unicode angle-bracket lookalikes (‹ › ＜ ＞) so a tag written with them still parses.
	const cleaned = text.replace(/[‹＜]/g, "<").replace(/[›＞]/g, ">");

	const recapMatch = [...cleaned.matchAll(/<recap>([\s\S]*?)<\/recap>/gi)].at(-1);
	const summary = recapMatch ? cleanRecap(recapMatch[1]!) : undefined;
	if (!summary) {
		return undefined;
	}
	if (isWorking) {
		return { summary };
	}
	const statusMatch = [...cleaned.matchAll(/<status>\s*([a-z_]+)\s*<\/status>/gi)].at(-1);
	const status = statusMatch ? statusMatch[1]!.toUpperCase() : undefined;
	const taskState: AgentTaskState = status === "COMPLETED" ? "completed" : "needs_input";
	return { summary, taskState };
}

export interface GenerateAgentStatusParams {
	registry: ModelRegistry;
	messages: readonly AgentMessage[];
	isWorking: boolean;
	signal?: AbortSignal;
}

/** One cheap model call for a fresh status, or undefined if unavailable/empty/failed. */
export async function generateAgentStatus(params: GenerateAgentStatusParams): Promise<AgentStatusResult | undefined> {
	const { registry, messages, isWorking, signal } = params;
	if (messages.length === 0) {
		return undefined;
	}
	const model = resolveSummaryModel(registry);
	if (!model) {
		return undefined;
	}
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return undefined;
	}
	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: AGENT_STATUS_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: buildStatusContext(messages, isWorking) }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: agentStatusMaxTokens(model), apiKey: auth.apiKey, headers: auth.headers, signal },
		);
		if (response.stopReason === "error") {
			return undefined;
		}
		const textContent = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return parseAgentStatusResponse(textContent, isWorking);
	} catch {
		return undefined;
	}
}

function isSessionWorking(state: ActiveSessionState): boolean {
	const session = state.runtime.session;
	return session.isSessionActive;
}

/**
 * Background status summarization for daemon-hosted sessions, top-level and
 * subagents alike. A periodic sweep refreshes working sessions; debounced
 * turn-end activity drives the idle verdict. Status lives in memory; settled
 * idle verdicts are persisted.
 */
export class DaemonSessionSummarizer {
	private interval: ReturnType<typeof setInterval> | undefined;
	private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Controller per in-flight summary so a closing session can abort its write.
	private readonly inFlight = new Map<string, AbortController>();
	// Sessions requested while one was running; get one more pass on completion.
	private readonly rerunRequested = new Set<string>();
	/** Per-session retry ladder for a generation that keeps failing; cleared by a real turn. */
	private readonly retryBackoff = new Map<string, { failures: number; notBefore: number; lastLoggedAt: number }>();

	constructor(
		private readonly listSessions: () => readonly ActiveSessionState[],
		private readonly onStatusChanged?: (state: ActiveSessionState) => void,
		// Injectable for tests.
		private readonly generate: (
			params: GenerateAgentStatusParams,
		) => Promise<AgentStatusResult | undefined> = generateAgentStatus,
	) {}

	start(): void {
		if (this.interval) {
			return;
		}
		this.interval = setInterval(() => {
			void this.sweep();
		}, SWEEP_INTERVAL_MS);
		this.interval.unref?.();
	}

	/**
	 * One sweep pass. Bounded fan-out instead of firing every session at once: an
	 * upstream that is rate-limiting recovers from four concurrent calls, not from
	 * one burst shaped exactly like the thing that made it rate-limit.
	 */
	private async sweep(): Promise<void> {
		const states = this.listSessions();
		if (states.length === 0) {
			return;
		}
		await mapConcurrent(states, SWEEP_CONCURRENCY, (state) => this.summarize(state));
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const controller of this.inFlight.values()) {
			controller.abort();
		}
		this.rerunRequested.clear();
	}

	/** Drop any pending work for a session that is closing. */
	forget(activeSessionId: string): void {
		const timer = this.debounceTimers.get(activeSessionId);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(activeSessionId);
		}
		this.inFlight.get(activeSessionId)?.abort();
		this.rerunRequested.delete(activeSessionId);
		this.retryBackoff.delete(activeSessionId);
	}

	/** Seed in-memory status from the persisted entry when a session is added. */
	seed(state: ActiveSessionState): void {
		if (state.summaryState) {
			return;
		}
		const persisted = state.runtime.session.sessionManager.getLatestAgentStatus();
		if (persisted) {
			state.summaryState = persisted;
		}
	}

	/** Called when a session finishes a turn; debounce until the agent settles. */
	notifyActivity(state: ActiveSessionState): void {
		const id = state.activeSessionId;
		// A finished turn is new information, so it re-arms a session whose summary
		// generation had backed off or given up: the ladder throttles retries of the
		// *same* content, not the session's lifetime.
		this.retryBackoff.delete(id);
		const existing = this.debounceTimers.get(id);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.debounceTimers.delete(id);
			void this.summarize(state);
		}, SETTLE_DEBOUNCE_MS);
		timer.unref?.();
		this.debounceTimers.set(id, timer);
	}

	private async summarize(state: ActiveSessionState): Promise<void> {
		const id = state.activeSessionId;
		if (this.inFlight.has(id)) {
			this.rerunRequested.add(id); // run once more after the current pass
			return;
		}
		const session = state.runtime.session;
		const messages = session.messages;
		if (messages.length === 0) {
			return;
		}
		const messageCount = messages.length;
		const isWorking = isSessionWorking(state);
		const previous = state.summaryState;
		// Idle sessions with a current verdict need no refresh; working sessions
		// always refresh so the recap keeps up with the in-progress turn.
		const contentUnchanged = previous?.basedOnMessageCount === messageCount;
		const owesIdleVerdict = !isWorking && previous?.taskState === undefined;
		// A blank recap means the model call hasn't succeeded yet (e.g. the
		// needs_input fallback fired on a transient failure); keep retrying until a
		// real summary lands so the recap isn't left permanently empty.
		const owesSummary = !isWorking && !previous?.summary;
		if (contentUnchanged && !isWorking && !owesIdleVerdict && !owesSummary) {
			return;
		}
		// Waiting out a failing summary model: an owed summary is owed on every pass
		// by construction, so without this the sweep re-called the model for the same
		// unchanged content every 25s until the process died. `notifyActivity` clears
		// the ladder, so a real turn is always summarised promptly.
		const backoff = this.retryBackoff.get(id);
		if (backoff && Date.now() < backoff.notBefore) {
			return;
		}
		// Include the in-progress message so a long streaming turn gets a live recap.
		const streaming = isWorking ? session.state.streamingMessage : undefined;
		const contextMessages = streaming ? [...messages, streaming] : messages;

		const controller = new AbortController();
		this.inFlight.set(id, controller);
		try {
			const generated = await this.generate({
				registry: session.modelRegistry,
				messages: contextMessages,
				isWorking,
				signal: controller.signal,
			});
			// A failed classification on an idle session would spin at "working"
			// forever (the activity axis holds unjudged idle sessions there), so
			// settle it to needs_input.
			const settledWithoutModel = generated === undefined;
			if (settledWithoutModel) {
				this.noteSummaryFailure(state, isWorking);
			} else {
				this.retryBackoff.delete(id);
			}
			const result =
				generated ??
				(!isWorking && (owesIdleVerdict || owesSummary)
					? { summary: previous?.summary ?? "", taskState: "needs_input" as const }
					: undefined);
			if (!result) {
				return;
			}
			// Discard if the session closed, was swapped, or moved to a new turn
			// during the async call — never write a verdict for stale state.
			if (
				controller.signal.aborted ||
				state.runtime.session !== session ||
				isSessionWorking(state) !== isWorking ||
				session.messages.length !== messageCount
			) {
				return;
			}
			// A working refresh carries no verdict; keep the prior one at the same
			// message count so a still-valid needs_input isn't dropped.
			const taskState =
				result.taskState ?? (previous?.basedOnMessageCount === messageCount ? previous?.taskState : undefined);
			const status: AgentStatus = {
				summary: result.summary,
				taskState,
				basedOnMessageCount: messageCount,
			};
			// An idle settle refreshes the verdict's currency, which drives the roster's
			// activity axis: it must publish even when the verdict text is unchanged.
			const changed =
				previous?.summary !== status.summary ||
				previous?.taskState !== status.taskState ||
				(!isWorking && previous?.basedOnMessageCount !== status.basedOnMessageCount);
			state.summaryState = status;
			// Persist only settled idle verdicts, never mid-stream — and never a
			// verdict this pass invented because the model did not answer. That
			// fallback is a statement about the summary service, not about the
			// session; persisted, `seed()` reads it back after a restart and the user
			// is told a session "needs input" that nobody ever asked anything of. The
			// in-memory settle still happens, so the roster's activity axis does not
			// spin at "working" for an unjudged idle session.
			if (!isWorking && !settledWithoutModel) {
				try {
					session.sessionManager.appendAgentStatus(status);
				} catch {
					// best-effort; in-memory status still shows
				}
			}
			if (changed) {
				this.onStatusChanged?.(state);
			}
		} finally {
			this.inFlight.delete(id);
			// Re-debounce a request that arrived mid-pass instead of dropping it.
			if (this.rerunRequested.delete(id)) {
				this.notifyActivity(state);
			}
		}
	}

	/**
	 * Count a generation that produced nothing and push the next attempt out. A
	 * session with no summary model configured is not a failure — that path is cheap
	 * and expected, and reporting it would bury the real ones.
	 */
	private noteSummaryFailure(state: ActiveSessionState, isWorking: boolean): void {
		if (!summaryModelConfigured(state)) {
			return;
		}
		const id = state.activeSessionId;
		const previous = this.retryBackoff.get(id);
		const failures = (previous?.failures ?? 0) + 1;
		const gaveUp = failures >= SUMMARY_RETRY_LIMIT;
		const backoffMs = Math.min(SUMMARY_RETRY_MAX_MS, SUMMARY_RETRY_BASE_MS * 2 ** (failures - 1));
		const now = Date.now();
		this.retryBackoff.set(id, {
			failures,
			notBefore: gaveUp ? Number.POSITIVE_INFINITY : now + backoffMs,
			lastLoggedAt: previous?.lastLoggedAt ?? 0,
		});
		const entry = this.retryBackoff.get(id)!;
		const firstOrLast = failures === 1 || gaveUp;
		if (!firstOrLast && now - entry.lastLoggedAt < SUMMARY_FAILURE_LOG_MIN_GAP_MS) {
			return;
		}
		entry.lastLoggedAt = now;
		structuredLog.warn(gaveUp ? "session status summary gave up" : "session status summary failed", {
			activeSessionId: id,
			isWorking,
			failures,
			...(gaveUp ? {} : { retryInMs: backoffMs }),
			...(gaveUp ? { rearmedBy: "the session's next turn" } : {}),
		});
	}
}

/** Cheap, throw-safe check: "no summary model" is not a failure worth counting. */
function summaryModelConfigured(state: ActiveSessionState): boolean {
	try {
		return resolveSummaryModel(state.runtime.session.modelRegistry) !== undefined;
	} catch {
		// A registry that cannot answer is not "not configured"; count the failure.
		return true;
	}
}
