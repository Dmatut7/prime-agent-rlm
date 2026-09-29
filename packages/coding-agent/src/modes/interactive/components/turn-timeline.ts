import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CompactionOutcomeDetails,
	type CustomMessage,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	type RlmChildFailureDetails,
	type RlmChildStallNoticeDetails,
	type RlmChildTerminalNoticeDetails,
} from "../../../core/messages.js";
import { sanitizeDisplayText } from "./diff-rows.js";
import {
	emptyStepFeedData,
	estimateTokens,
	estimateTokenUnits,
	mergeStepResult,
	type StepFeedData,
} from "./feed-data.js";
import type { TimelineLane } from "./timeline-gutter.js";
import type { TimelineLaneTracker } from "./timeline-lane.js";

/**
 * Everything one assistant turn's box shows, in the order it happened: the
 * model's messages (thinking, narration, tool calls), the user cutting in,
 * automatic retries, context compaction and subagents. The records are
 * display-only: nothing here is ever sent to the model.
 *
 * A turn runs from one user prompt to the next, whether the work happened in
 * one agent run or in several (a retry or a compaction continues the same
 * turn), so the live view and a replay group the same messages the same way.
 */

export interface TimelineRetry {
	startedAt: number;
	delayMs: number;
	attempt: number;
	/** Why, in plain words (`模型接口超时`). */
	reason: string;
	outcome?: "ok" | "failed" | "stopped";
	finalError?: string;
}

export interface TimelineCompaction {
	startedAt: number;
	endedAt?: number;
	/** Context tokens before and after, when known. */
	before?: number;
	after?: number;
	/** Why it did not happen (with `skipped`, why it waits for later). */
	failed?: string;
	/** Not a failure: the session chose to wait (the conversation is too short). */
	skipped?: boolean;
	/** Rebuilt from the transcript; a live row of the same turn is the richer record. */
	fromReplay?: boolean;
}

/** A notice about the turn's work, said in plain words (a subagent that finished without replying). */
export interface TimelineNotice {
	tone: "muted" | "warn" | "error";
	/** One line in plain words. */
	text: string;
	/** What opening the row shows (the child's own last words, the error). */
	detail?: string;
}

export interface TimelineSubagent {
	childId: string;
	name: string;
	/** The task it was given, in a few words (its short tag comes from this). */
	label?: string;
	status: "running" | "done" | "failed";
	/** What it is doing now, in plain words. */
	line?: string;
	/** One-line outcome once it finished. */
	result?: string;
	/** Its full report, for the expanded row. */
	report?: string;
	startedAt: number;
	endedAt?: number;
}

export type TimelineEntry =
	| { seq: number; kind: "message"; key: string; message: AssistantMessage; ended: boolean }
	| { seq: number; kind: "steer"; key: string; text: string; at: number }
	| { seq: number; kind: "retry"; key: string; retry: TimelineRetry }
	| { seq: number; kind: "compact"; key: string; compaction: TimelineCompaction }
	| { seq: number; kind: "subagent"; key: string; sub: TimelineSubagent }
	| { seq: number; kind: "notice"; key: string; notice: TimelineNotice; at: number };

/** Live timing of one thinking block; absent for a replayed turn. */
export interface ThinkingTiming {
	startedAt: number;
	endedAt?: number;
	usageAtStart: number;
	usageAtEnd?: number;
}

/** A text shown in steps that only change at sentence boundaries or after a pause. */
interface SteadyText {
	shown: number;
	shownAt: number;
}

/** Where a sentence or clause ends. */
const CLAUSE_END = /[。！？!?；;：:，,…]|\.(?=\s|$)|\n/g;
const SENTENCE_END = /[。！？!?；;…]|\.(?=\s|$)|\n/g;

/** The last complete sentence of a trace; "" while the first one is still being written. */
export function lastCompletedSentence(text: string): string {
	const flat = text.replace(/\r/g, "");
	const ends = [...flat.matchAll(SENTENCE_END)].map((match) => (match.index ?? 0) + match[0].length);
	for (let index = ends.length - 1; index >= 0; index--) {
		const start = index > 0 ? (ends[index - 1] ?? 0) : 0;
		const sentence = flat
			.slice(start, ends[index])
			.replace(/\s+/g, " ")
			.replace(/[。！？!?；;….\s]+$/, "")
			.trim();
		if (sentence.length >= 2) return sanitizeDisplayText(sentence);
	}
	return "";
}

/** The first sentence of a trace (the summary a finished thinking row shows). */
export function firstSentence(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const match = /^(.+?)[。！？!?；;]|^(.+?)\.(?=\s|$)/.exec(flat);
	return sanitizeDisplayText((match?.[1] ?? match?.[2] ?? flat).trim());
}

let boxIdCounter = 0;

/**
 * The per-row UI state of a box: what is open, where its body is scrolled,
 * which rows are new (the enter highlight) or just finished (the flash). It
 * lives on the timeline, so it survives re-renders, resizes and chat rebuilds.
 */
export class TimelineUiState {
	/** Names this box among all boxes on screen (part of its blocks' hover keys). */
	readonly id = `box${++boxIdCounter}`;
	/** The row whose block the pointer is on, when one is. */
	hoverKey: string | undefined;
	/** The pointer is on the box header (or its pinned copy). */
	headHover = false;
	/** The user opened or closed the box themselves: the automatic open/fold rules no longer apply. */
	userOpen: boolean | undefined;
	/**
	 * The user chose while the turn was still running. An opening made then lapses
	 * when the turn ends (the box folds); one made after it ended stays.
	 */
	userOpenWhileLive = false;
	/** First body line shown when not following. */
	scrollTop = 0;
	/** The body keeps its newest line in view. */
	follow = true;
	/** New lines arrived below while the user was scrolled up. */
	unseen = false;
	/** Body line count at the last render (scrolling limits). */
	lastBodyLines = 0;
	/** Rows at the last render, to notice new ones. */
	lastRowCount = 0;
	/** First body line and body height the last render showed (clicks and the wheel act on these). */
	lastTop = 0;
	lastVisible = 0;
	/** Bring this row into the body's view on the next render (its opened lines too, when `revealDetail`). */
	revealKey: string | undefined;
	revealDetail = false;
	/** Open rows and events (`ev:` keys), and events listing every step (`all:` keys). */
	readonly expanded = new Set<string>();
	readonly expandedAt = new Map<string, number>();
	/** The subagent lane each line was drawn with when it first appeared: a later frame keeps it. */
	readonly lanes = new Map<string, TimelineLane>();
	readonly enteredAt = new Map<string, number>();
	readonly settledAt = new Map<string, number>();
	readonly rowStatus = new Map<string, string>();
	/** Rows are only highlighted as new once the box has rendered once. */
	primed = false;
	label: string | undefined;
	labelChangedAt = 0;
	/** The turn-end fold: when it started and how many body rows it folds from. */
	foldStartedAt: number | undefined;
	foldFromRows = 0;
	/** Box open animation. */
	openedAt: number | undefined;
	/** Keyboard focus inside the box or its strip (a row key, `header`, or a strip target). */
	focusKey: string | undefined;
	focused = false;
	/** The change strip under the answer: which list is open and which of its items. */
	stripOpen: "edits" | "memories" | undefined;
	readonly stripExpanded = new Set<string>();
	readonly stripExpandedAt = new Map<string, number>();
	/** Bumped on every change a cached render must notice. */
	version = 0;

	bump(): void {
		this.version++;
	}

	/**
	 * Open or close one row. The body stops following the newest line and keeps
	 * the row where it is: what opens slides in below it, and the view scrolls
	 * only as far as needed to show it, never past the row itself.
	 */
	toggleRow(key: string, now = Date.now()): boolean {
		const open = !this.expanded.has(key);
		if (open) {
			this.expanded.add(key);
			this.expandedAt.set(key, now);
		} else {
			this.expanded.delete(key);
			this.expandedAt.delete(key);
		}
		this.holdView();
		this.revealKey = key;
		this.revealDetail = open;
		this.bump();
		return open;
	}

	/** Freeze the body at what the last render showed (the next render stops following). */
	holdView(): void {
		if (this.follow) {
			this.scrollTop = this.lastTop;
			this.follow = false;
		}
	}

	/** Scroll the body by `delta` lines; false when it is already at that end. */
	scrollBody(delta: number): boolean {
		const maxTop = Math.max(0, this.lastBodyLines - this.lastVisible);
		const top = this.follow ? maxTop : Math.min(this.scrollTop, maxTop);
		const next = Math.max(0, Math.min(maxTop, top + delta));
		if (next === top) return false;
		this.scrollTop = next;
		this.follow = next >= maxTop;
		if (this.follow) this.unseen = false;
		this.bump();
		return true;
	}

	/** The pointer entered or left a row's block; false when that changed nothing. */
	setHover(key: string, hovered: boolean): boolean {
		if (hovered) {
			if (this.hoverKey === key) return false;
			this.hoverKey = key;
		} else {
			if (this.hoverKey !== key) return false;
			this.hoverKey = undefined;
		}
		this.bump();
		return true;
	}

	/** The pointer entered or left the box header; false when that changed nothing. */
	setHeadHover(hovered: boolean): boolean {
		if (this.headHover === hovered) return false;
		this.headHover = hovered;
		this.bump();
		return true;
	}

	/** Fold every event's step list (the turn ended); what the user opened inside a step stays with its step. */
	collapseEvents(): void {
		for (const key of [...this.expanded]) {
			if (key.startsWith("ev:") || key.startsWith("all:")) this.expanded.delete(key);
		}
		this.bump();
	}

	/** Back to following the newest line. */
	followNewest(): void {
		this.follow = true;
		this.unseen = false;
		this.bump();
	}
}

export class TurnTimeline {
	readonly ui = new TimelineUiState();
	readonly entries: TimelineEntry[] = [];
	readonly stepData = new Map<string, StepFeedData>();
	readonly thinkingTiming = new Map<string, ThinkingTiming>();
	/** The turn was watched live in this client (its box then folds on its own at the end). */
	observedLive = false;
	/** The run ended on the user's interrupt. */
	stopped = false;
	/** The run ended on an error the model did not recover from. */
	errorEnded = false;
	/** When the finished presentation (fold, summary) was applied. */
	finishedAt: number | undefined;
	/** Steps of this turn the reopen window left out (its box says how many). */
	earlierSteps = 0;
	/** Told of every subagent this turn dispatches, as it is noted (not when it is drawn). */
	laneTracker: TimelineLaneTracker | undefined;
	/** Commands the step's code waits on through a handle, resolved from earlier cells. */
	readonly stepHandleContext = new Map<string, ReadonlyMap<string, string>>();
	private seq = 0;
	private tokenPeak = 0;
	private readonly steady = new Map<string, SteadyText>();
	private readonly steadyLines = new Map<string, { text: string; at: number }>();

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	/** Upsert one assistant message (streaming updates replace the stored reference). */
	noteMessage(message: AssistantMessage, ended: boolean): void {
		const key = `m:${message.timestamp}`;
		const existing = this.entries.find((entry) => entry.kind === "message" && entry.key === key);
		if (existing && existing.kind === "message") {
			existing.message = message;
			existing.ended = existing.ended || ended;
		} else {
			this.entries.push({ seq: this.nextSeq(), kind: "message", key, message, ended });
		}
		if (ended) this.closeThinking(message, Date.now());
	}

	/**
	 * Remove one entry: an attempt the session dropped before it ended (an
	 * empty-turn retry starts over) was never kept, so its row and its tokens go.
	 */
	dropEntry(key: string): void {
		const index = this.entries.findIndex((entry) => entry.key === key);
		if (index < 0) return;
		const [removed] = this.entries.splice(index, 1);
		if (removed?.kind === "message") {
			for (const timingKey of [...this.thinkingTiming.keys()]) {
				if (timingKey.startsWith(`${key}:`)) this.thinkingTiming.delete(timingKey);
			}
			this.tokenPeak = 0;
		}
		this.ui.bump();
	}

	/** Live stream events time the thinking blocks and measure their tokens from usage. */
	noteStreamEvent(message: AssistantMessage, event: AssistantMessageEvent, now = Date.now()): void {
		const messageKey = `m:${message.timestamp}`;
		if (event.type === "thinking_start" || event.type === "thinking_delta") {
			const key = `${messageKey}:${event.contentIndex}`;
			if (!this.thinkingTiming.has(key)) {
				this.thinkingTiming.set(key, { startedAt: now, usageAtStart: message.usage?.output ?? 0 });
			}
		} else if (event.type === "thinking_end") {
			const timing = this.thinkingTiming.get(`${messageKey}:${event.contentIndex}`);
			if (timing && timing.endedAt === undefined) {
				timing.endedAt = now;
				timing.usageAtEnd = message.usage?.output ?? 0;
			}
		} else if (
			event.type === "text_start" ||
			event.type === "toolcall_start" ||
			event.type === "done" ||
			event.type === "error"
		) {
			this.closeThinking(message, now);
		}
	}

	private closeThinking(message: AssistantMessage, now: number): void {
		const prefix = `m:${message.timestamp}:`;
		for (const [key, timing] of this.thinkingTiming) {
			if (key.startsWith(prefix) && timing.endedAt === undefined) {
				timing.endedAt = now;
				timing.usageAtEnd = message.usage?.output ?? 0;
			}
		}
	}

	/** Tokens of one thinking block: measured from usage when the provider streamed it, else estimated. */
	thinkingTokens(key: string, text: string): number {
		const timing = this.thinkingTiming.get(key);
		if (timing?.usageAtEnd !== undefined) {
			const measured = timing.usageAtEnd - timing.usageAtStart;
			if (measured > 0) return measured;
		}
		return estimateTokens(text);
	}

	mergeStep(
		toolCallId: string,
		toolName: string,
		args: unknown,
		result: { details?: unknown; content?: unknown; isError?: boolean },
		partial: boolean,
	): void {
		const previous = this.stepData.get(toolCallId) ?? emptyStepFeedData();
		this.stepData.set(toolCallId, mergeStepResult(previous, toolName, args, result, partial));
		this.ui.bump();
	}

	addSteer(text: string, at: number): void {
		const clean = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
		if (!clean) return;
		if (this.entries.some((entry) => entry.kind === "steer" && entry.at === at && entry.text === clean)) return;
		let key = `steer:${at}`;
		for (let n = 2; this.entries.some((entry) => entry.key === key); n++) key = `steer:${at}:${n}`;
		this.entries.push({ seq: this.nextSeq(), kind: "steer", key, text: clean, at });
		this.ui.bump();
	}

	startRetry(retry: Omit<TimelineRetry, "outcome">): void {
		this.entries.push({ seq: this.nextSeq(), kind: "retry", key: `retry:${retry.startedAt}`, retry: { ...retry } });
		this.ui.bump();
	}

	/** The newest retry that has not settled yet. */
	activeRetry(): TimelineRetry | undefined {
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const entry = this.entries[index];
			if (entry?.kind === "retry") return entry.retry.outcome === undefined ? entry.retry : undefined;
		}
		return undefined;
	}

	endRetry(outcome: TimelineRetry["outcome"], finalError?: string): void {
		const retry = this.activeRetry();
		if (!retry) return;
		retry.outcome = outcome;
		if (finalError) retry.finalError = finalError;
		this.ui.bump();
	}

	startCompaction(startedAt: number, before?: number): void {
		this.entries.push({
			seq: this.nextSeq(),
			kind: "compact",
			key: `compact:${startedAt}`,
			compaction: { startedAt, ...(before !== undefined ? { before } : {}) },
		});
		this.ui.bump();
	}

	activeCompaction(): TimelineCompaction | undefined {
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const entry = this.entries[index];
			if (entry?.kind === "compact") return entry.compaction.endedAt === undefined ? entry.compaction : undefined;
		}
		return undefined;
	}

	/** The newest compaction, settled or not. */
	latestCompaction(): TimelineCompaction | undefined {
		for (let index = this.entries.length - 1; index >= 0; index--) {
			const entry = this.entries[index];
			if (entry?.kind === "compact") return entry.compaction;
		}
		return undefined;
	}

	endCompaction(endedAt: number, facts: { before?: number; failed?: string; skipped?: boolean }): void {
		const compaction = this.activeCompaction();
		if (!compaction) return;
		compaction.endedAt = endedAt;
		if (facts.before !== undefined) compaction.before = facts.before;
		if (facts.failed) compaction.failed = facts.failed;
		if (facts.skipped) compaction.skipped = true;
		this.ui.bump();
	}

	/** A compaction the transcript records (its summary, or why it did not happen), settled. */
	addReplayCompaction(at: number, facts: { before?: number; failed?: string; skipped?: boolean }): void {
		const key = `compact:replay:${at}`;
		if (this.entries.some((entry) => entry.key === key)) return;
		this.entries.push({
			seq: this.nextSeq(),
			kind: "compact",
			key,
			compaction: {
				startedAt: at,
				endedAt: at,
				fromReplay: true,
				...(facts.before !== undefined ? { before: facts.before } : {}),
				...(facts.failed ? { failed: facts.failed } : {}),
				...(facts.skipped ? { skipped: true } : {}),
			},
		});
		this.ui.bump();
	}

	/** A notice about the turn's work, once per message it came from; returns its key. */
	addNotice(notice: TimelineNotice, at: number): string {
		const key = `notice:${at}`;
		if (this.entries.some((entry) => entry.key === key)) return key;
		this.entries.push({ seq: this.nextSeq(), kind: "notice", key, notice, at });
		this.ui.bump();
		return key;
	}

	/** Insert or update the row of one subagent this turn started. */
	upsertSubagent(update: Omit<TimelineSubagent, "startedAt"> & { startedAt?: number }, now = Date.now()): void {
		const key = `sub:${update.childId}`;
		const existing = this.entries.find((entry) => entry.kind === "subagent" && entry.key === key);
		if (existing && existing.kind === "subagent") {
			const wasRunning = existing.sub.status === "running";
			existing.sub = {
				...existing.sub,
				...update,
				startedAt: existing.sub.startedAt,
				...(wasRunning && update.status !== "running" ? { endedAt: now } : {}),
			};
		} else {
			this.entries.push({
				seq: this.nextSeq(),
				kind: "subagent",
				key,
				sub: { ...update, startedAt: update.startedAt ?? now },
			});
			if (update.status === "running") this.laneTracker?.spawned([update.name]);
		}
		this.ui.bump();
	}

	hasSubagent(childId: string): boolean {
		return this.entries.some((entry) => entry.kind === "subagent" && entry.key === `sub:${childId}`);
	}

	messages(): AssistantMessage[] {
		return this.entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
	}

	/**
	 * Output tokens this turn generated: reported usage for finished messages,
	 * the larger of reported and estimated for the one still streaming. Never
	 * decreases, so the counter only ever ticks up.
	 */
	outputTokens(): number {
		let total = 0;
		for (const entry of this.entries) {
			if (entry.kind !== "message") continue;
			const reported = entry.message.usage?.output ?? 0;
			const estimate =
				entry.ended && reported > 0
					? 0
					: entry.ended
						? endedMessageTokens(entry.message)
						: estimateMessageTokens(entry.message);
			total += entry.ended ? (reported > 0 ? reported : estimate) : Math.max(reported, estimate);
		}
		this.tokenPeak = Math.max(this.tokenPeak, total);
		return this.tokenPeak;
	}

	/**
	 * A text that grows while it streams, shown in calm steps: it moves forward
	 * at clause boundaries, and otherwise at most once a second.
	 */
	steadyPrefix(key: string, text: string, now = Date.now(), intervalMs = 1000): string {
		const state = this.steady.get(key) ?? { shown: 0, shownAt: 0 };
		if (text.length < state.shown) state.shown = 0;
		const ends = [...text.matchAll(CLAUSE_END)].map((match) => (match.index ?? 0) + match[0].length);
		const cut = ends.at(-1) ?? 0;
		if (cut > state.shown) {
			state.shown = cut;
			state.shownAt = now;
		} else if (text.length > state.shown && now - state.shownAt >= intervalMs) {
			state.shown = text.length;
			state.shownAt = now;
		}
		this.steady.set(key, state);
		return text.slice(0, state.shown);
	}

	/** A replaced line (a command's latest output) that changes at most every `intervalMs`. */
	steadyLine(key: string, text: string, now = Date.now(), intervalMs = 500): string {
		const state = this.steadyLines.get(key);
		if (!state || (state.text !== text && now - state.at >= intervalMs)) {
			this.steadyLines.set(key, { text, at: now });
			return text;
		}
		return state.text;
	}

	/**
	 * Carry live-only facts over to the timeline that replaces this one after a
	 * chat rebuild. `keepHistory` (a rebuild after a compaction) also keeps the
	 * entries the compaction summarized away, so the box still shows the whole turn.
	 */
	transferTo(next: TurnTimeline, options: { keepHistory?: boolean } = {}): void {
		// Walk the old order: replayed entries (messages, steers) take their fresh
		// copy, live-only ones (retries, compactions, subagents) carry over as they
		// were, and anything only the replay knows goes after them.
		const fresh = new Map(next.entries.map((entry) => [entry.key, entry] as const));
		// The live compaction row is the richer record of the same event as its replayed copy.
		if (this.entries.some((entry) => entry.kind === "compact" && !entry.compaction.fromReplay)) {
			for (const [key, entry] of fresh) {
				if (entry.kind === "compact" && entry.compaction.fromReplay) fresh.delete(key);
			}
		}
		const merged: TimelineEntry[] = [];
		for (const entry of this.entries) {
			const replayed = fresh.get(entry.key);
			if (replayed) {
				merged.push(replayed);
				fresh.delete(entry.key);
			} else if (options.keepHistory || (entry.kind !== "message" && entry.kind !== "steer")) {
				merged.push(entry);
			}
		}
		merged.push(...fresh.values());
		next.entries.length = 0;
		merged.forEach((entry, index) => {
			next.entries.push({ ...entry, seq: index + 1 });
		});
		next.seq = next.entries.length;
		for (const [key, timing] of this.thinkingTiming) next.thinkingTiming.set(key, timing);
		for (const [key, data] of this.stepData) if (!next.stepData.has(key)) next.stepData.set(key, data);
		for (const [key, context] of this.stepHandleContext) next.stepHandleContext.set(key, context);
		next.observedLive = this.observedLive;
		next.stopped ||= this.stopped;
		next.finishedAt = this.finishedAt;
		next.tokenPeak = Math.max(next.tokenPeak, this.tokenPeak);
		const ui = this.ui;
		next.ui.userOpen = ui.userOpen;
		next.ui.userOpenWhileLive = ui.userOpenWhileLive;
		next.ui.scrollTop = ui.scrollTop;
		next.ui.follow = ui.follow;
		next.ui.primed = ui.primed;
		next.ui.stripOpen = ui.stripOpen;
		for (const key of ui.expanded) next.ui.expanded.add(key);
		for (const [key, lane] of ui.lanes) next.ui.lanes.set(key, lane);
		for (const key of ui.stripExpanded) next.ui.stripExpanded.add(key);
		for (const [key, status] of ui.rowStatus) next.ui.rowStatus.set(key, status);
		next.ui.bump();
	}
}

/** Token units of one tool call's arguments, read once per arguments object. */
const argumentUnits = new WeakMap<object, number>();

function toolArgumentUnits(args: unknown): number {
	if (typeof args !== "object" || args === null) return 0;
	let units = argumentUnits.get(args);
	if (units === undefined) {
		try {
			units = estimateTokenUnits(JSON.stringify(args));
		} catch {
			// Unserializable streaming arguments count as nothing yet.
			units = 0;
		}
		argumentUnits.set(args, units);
	}
	return units;
}

/** A finished message's estimate never changes: read once. */
const endedEstimates = new WeakMap<AssistantMessage, number>();

/** Estimate of what one message generated so far: thinking, text and tool-call arguments. */
export function estimateMessageTokens(message: AssistantMessage): number {
	let units = 0;
	for (const block of message.content ?? []) {
		if (block.type === "thinking") units += estimateTokenUnits(block.thinking ?? "");
		else if (block.type === "text") units += estimateTokenUnits(block.text ?? "");
		else if (block.type === "toolCall") units += toolArgumentUnits(block.arguments);
	}
	return Math.round(units);
}

function endedMessageTokens(message: AssistantMessage): number {
	let estimate = endedEstimates.get(message);
	if (estimate === undefined) {
		estimate = estimateMessageTokens(message);
		endedEstimates.set(message, estimate);
	}
	return estimate;
}

/** `16秒`, `1分26秒`, `1小时02分`: the box's clock. */
export function formatBoxDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}秒`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}分${String(seconds % 60).padStart(2, "0")}秒`;
	return `${Math.floor(minutes / 60)}小时${String(minutes % 60).padStart(2, "0")}分`;
}

/** `812`, `7.1k`, `184k`, `1.2M`: output tokens. */
export function formatBoxTokens(tokens: number): string {
	const value = Math.max(0, Math.round(tokens));
	if (value < 1000) return String(value);
	if (value < 100_000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** A retry reason in plain words, from the session's retry event. */
export function describeRetryReason(event: {
	errorMessage: string;
	reason?: "usage" | "unavailable" | "backup";
	backupModel?: string;
}): string {
	if (event.reason === "backup" && event.backupModel) {
		return `换到备用模型 ${event.backupModel.split("/").pop()}`;
	}
	if (event.reason === "usage") return "额度用完或被限流";
	if (event.reason === "unavailable") return "模型暂时都不可用";
	const text = event.errorMessage.toLowerCase();
	if (/timed? ?out|timeout|etimedout|deadline/.test(text)) return "模型接口超时";
	if (/429|rate.?limit|too many requests/.test(text)) return "被限流";
	if (/overload|529|503|unavailable/.test(text)) return "模型服务繁忙";
	if (/5\d\d|internal server|bad gateway/.test(text)) return "模型服务出错";
	if (/econnreset|socket|network|fetch failed|connection/.test(text)) return "网络断了一下";
	return "模型接口出错";
}

/** Why a compaction did not happen, in plain words for its row (a skip is not a failure). */
export function compactionMissText(event: { errorMessage?: string; errorSeverity?: "warning" | "error" }): string {
	const message = event.errorMessage ?? "";
	if (/too short/i.test(message)) return "对话还太短，等它长一些再整理";
	if (/already compacted/i.test(message)) return "刚整理过，不用再整理";
	if (event.errorSeverity === "warning") return "这次先跳过，稍后再试";
	return (
		sanitizeDisplayText(message.replace(/^[A-Za-z -]*compaction[A-Za-z ]*:\s*/i, "")).split("\n")[0] || "没有结果"
	);
}

function childFailureWhy(details: RlmChildFailureDetails | undefined): string {
	const kind = details?.kind;
	if (kind === "stall_killed") return "长时间没动静，被自动终止";
	if (kind === "aborted") return "已中止";
	return "出错";
}

/**
 * What a session notice about the turn's work says as a box record: a subagent
 * notice becomes a row in plain words, a compaction outcome a settled
 * compaction row. Undefined for anything the box does not show.
 */
export function boxRecordFromMessage(
	message: CustomMessage,
):
	| { kind: "notice"; notice: TimelineNotice }
	| { kind: "compaction"; facts: { failed?: string; skipped?: boolean } }
	| undefined {
	if (message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE) {
		const details = message.details as RlmChildTerminalNoticeDetails | undefined;
		const name = sanitizeDisplayText(details?.sessionName ?? "").trim() || "子代理";
		if (details?.kind === "cancelled") {
			const reason = details.reason ? `：${sanitizeDisplayText(details.reason).split("\n")[0]}` : "";
			return { kind: "notice", notice: { tone: "muted", text: `子代理 ${name} 已取消${reason}` } };
		}
		const lastText = details?.kind === "completed_without_reply" ? details.lastAssistantText?.trim() : undefined;
		const what = details?.followUp ? "做完了你追加的那步" : "做完了";
		return {
			kind: "notice",
			notice: {
				tone: "muted",
				text: `子代理 ${name} ${what}，没发回消息`,
				...(lastText ? { detail: `它最后写的：\n${lastText}` } : {}),
			},
		};
	}
	if (message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE) {
		const details = message.details as RlmChildFailureDetails | undefined;
		const name = sanitizeDisplayText(details?.sessionName ?? "").trim() || "子代理";
		const error = details?.error?.trim();
		return {
			kind: "notice",
			notice: {
				tone: "error",
				text: `子代理 ${name} 失败（${childFailureWhy(details)}）`,
				...(error ? { detail: error } : {}),
			},
		};
	}
	if (message.customType === RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE) {
		const details = message.details as RlmChildStallNoticeDetails | undefined;
		const name = sanitizeDisplayText(details?.sessionName ?? "").trim() || "子代理";
		const quiet = details?.silentMs ? `，已经 ${formatBoxDuration(details.silentMs)}没动静` : "，一阵没动静了";
		return { kind: "notice", notice: { tone: "warn", text: `子代理 ${name} 还在跑${quiet}` } };
	}
	if (message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE) {
		const details = message.details as CompactionOutcomeDetails | undefined;
		const content = typeof message.content === "string" ? message.content : "";
		if (details?.outcome === "cancelled") return { kind: "compaction", facts: { failed: "已取消" } };
		const skipped = details?.outcome === "skipped";
		return {
			kind: "compaction",
			facts: {
				failed: compactionMissText({ errorMessage: content, errorSeverity: skipped ? "warning" : "error" }),
				...(skipped ? { skipped: true } : {}),
			},
		};
	}
	return undefined;
}

/** Notices the box shows as its own rows instead of cards in the chat. */
export function isBoxNoticeMessage(message: CustomMessage): boolean {
	return (
		message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE ||
		message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE ||
		message.customType === RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE ||
		message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE
	);
}

/** Whether a reply is an answer (text and no steps) that a later reply of its turn can take over. */
export function isPlainAnswer(message: AssistantMessage | undefined): boolean {
	const content = message?.content ?? [];
	return (
		!content.some((block) => block.type === "toolCall") &&
		content.some((block) => block.type === "text" && block.text.trim().length > 0)
	);
}

/** Whether a reply did anything a reader sees (text or steps). */
export function replyHasWork(message: AssistantMessage | undefined): boolean {
	return (message?.content ?? []).some(
		(block) => block.type === "toolCall" || (block.type === "text" && block.text.trim().length > 0),
	);
}
