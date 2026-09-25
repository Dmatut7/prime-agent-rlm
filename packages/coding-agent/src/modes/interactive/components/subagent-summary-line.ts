import {
	type ClickRegion,
	type Component,
	type Focusable,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ContextTreeNode } from "../../../core/context-tree.js";
import { nodeSpendMoney, type SpendPricing, spendRelevantTokens } from "../../../core/spend-pricing.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import { collectSubagentDescendantSummaries } from "../../agents-view/agents-view-state.js";
import { type AgentRosterStatus, classifyAgentStatus } from "../../daemon/agent-roster.js";
import { classifySessionRosterStatus, type SessionSummary } from "../../daemon/daemon-session-list.js";
import { formatTokenCount } from "../agent-activity.js";
import { formatSpendCost } from "../spend-format.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

/** Bound on stall marker lines so a wedged family cannot push the editor off screen. */
const MAX_RENDERED_STALL_MARKERS = 3;

/**
 * U6 group gap (DS2 F7): the same four-space rhythm as the watermark line
 * above - the two status lines read as one block. The full second line -
 * counts, spend cell with annotations, and the hint - still fits 78 columns
 * with the wider gaps, under the 80-column floor.
 */
/** Blank space always kept between the spend cell and the open hint. */
const SPEND_MIN_GAP = 1;

/** Leading indent of the panel header. */
const LINE_INDENT = " ";

/** Widest name column before names truncate. */
const ROW_NAME_MAX_WIDTH = 16;

/** Narrowest activity column worth showing; below it the column drops. */
const ROW_ACTIVITY_MIN_WIDTH = 8;

export const ROW_STATE_WORDS: Record<SubagentPanelRowState, string> = {
	running: "运行",
	idle: "空闲",
	done: "完成",
	failed: "出错",
	stalled: "卡住",
};

/**
 * Running/idle/inactive counts for the subagents tray cell.
 *
 * 口径: the whole subagent subtree - direct children AND their descendants - so the
 * counts describe the same agent set as the spend cell sharing this line.
 */
export interface SubagentSummaryCounts {
	total: number;
	running: number;
	idle: number;
	inactive: number;
}

/**
 * Spend figures for the subagents tray cell: one total for all sub-agents of
 * this session, in money and tokens.
 *
 * 口径: `cost`/`tokens` sum the OWN usage of every agent in the session's
 * context tree except the root - direct children AND their descendants, live
 * and persisted (the tree walk covers both) - so it is a whole-tree figure,
 * bounded by the tree's scan budget (`partial` marks a truncated scan). Each
 * sub-agent's spend is counted once, at its own node: the mother transcript's
 * `child_usage_attributed` lines are already subtracted out of the root's
 * ownUsage, so `parentCost + cost` never double-counts a child through both
 * paths, and matches the "Total" line of /usage exactly.
 */
export interface SubagentSpendSummary {
	/** Σ own cost of every sub-agent, in the models.json cost unit. */
	cost: number;
	/** Σ spend-relevant tokens (input+output+cacheRead+cacheWrite) of every sub-agent. */
	tokens: number;
	/** The root's own cost; the secondary "总" figure is parentCost + cost. */
	parentCost: number;
	/** Models with no per-token rates: their tokens carry no money and are flagged instead. */
	unpriced: ReadonlyArray<{ model: string; tokens: number }>;
	/**
	 * Models whose money was re-priced by `ui.subagentSpendCell.priceOverrides`
	 * instead of by the rate recorded on their messages. Absent while no override
	 * applies, so a session without overrides reads exactly as it did before.
	 */
	overridePriced?: ReadonlyArray<{ model: string; tokens: number }>;
	/** A scan budget truncated the tree, so every figure is a lower bound. */
	partial: boolean;
}

/**
 * Fold a session's context tree into the tray's spend summary (see
 * {@link SubagentSpendSummary} for the double-counting rules).
 *
 * Money comes from `pricing` for the models it has an override for (the
 * override wins field by field over the models.json rate) and from the money
 * recorded on the message otherwise: a session with no overrides therefore
 * totals exactly what it totalled before, while a corrected rate moves the
 * figure for work already on screen.
 *
 * A node whose own usage already carries cost is treated as priced whatever
 * its recorded model says: the money was computed at generation time with real
 * rates, so flagging it would be a false warning. A node is "unpriced" only
 * when it spent tokens, earned no money, and its model is missing or has no
 * per-token rates (models.json entries without `cost` load as all-zero rates).
 */
export function summarizeSubagentSpend(
	root: ContextTreeNode,
	isModelPriced: (model: { provider: string; id: string }) => boolean,
	pricing?: SpendPricing,
): SubagentSpendSummary {
	let cost = 0;
	let tokens = 0;
	let partial = false;
	const unpriced = new Map<string, number>();
	const overridePriced = new Map<string, number>();
	const walk = (node: ContextTreeNode, isRoot: boolean): void => {
		if (node.scan?.truncated) partial = true;
		if (!isRoot) {
			const nodeTokens = spendRelevantTokens(node.ownUsage);
			const attributed = pricing?.attribute(node.model, node.ownUsage);
			const nodeCost = nodeSpendMoney(node, pricing);
			cost += nodeCost;
			tokens += nodeTokens;
			if (nodeCost === 0 && nodeTokens > 0 && (!node.model || !isModelPriced(node.model))) {
				const key = node.model?.id ?? "?";
				unpriced.set(key, (unpriced.get(key) ?? 0) + nodeTokens);
			}
			if (attributed && node.model) {
				overridePriced.set(node.model.id, (overridePriced.get(node.model.id) ?? 0) + nodeTokens);
			}
		}
		for (const child of node.children) {
			walk(child, false);
		}
	};
	walk(root, true);
	return {
		cost,
		tokens,
		parentCost: nodeSpendMoney(root, pricing),
		unpriced: [...unpriced.entries()]
			.map(([model, unpricedTokens]) => ({ model, tokens: unpricedTokens }))
			.sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1)),
		// Only present when an override actually priced something: the marker is
		// about this family, and a field that is always there would read as "no
		// overrides" in every consumer that includes it.
		...(overridePriced.size > 0
			? {
					overridePriced: [...overridePriced.entries()]
						.map(([model, pricedTokens]) => ({ model, tokens: pricedTokens }))
						.sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1)),
				}
			: {}),
		partial,
	};
}

export function classifySubagentSnapshotStatus(child: AgentConnectionRlmChildAgentSnapshot): AgentRosterStatus {
	// Activity implies a live session; the in-process connection never stamps activeSessionId.
	// A `stalled` activity counts as both resident and busy on purpose: the child
	// still holds an in-flight turn, so reporting it idle would advertise a wedged
	// child as free capacity. The stall itself is surfaced by the row's own stall
	// marker (child.stall), not by demoting the count.
	const resident = child.activeSessionId !== undefined || child.activity !== undefined;
	const busy = child.status === "running" || child.status === "queued" || child.activity !== undefined;
	return classifyAgentStatus({
		resident,
		queuedChild: !resident && busy,
		busy,
	});
}

/** Whether a snapshot row carries a live stall marker (watchdog fired, not yet recovered). */
export function isStalledSubagentSnapshot(child: AgentConnectionRlmChildAgentSnapshot): boolean {
	// B9: an excused stall is a long task the kernel or a host phase is vouching for, so it is not
	// a stalled child. The row keeps its real activity label and is still counted as busy.
	if (child.stall?.excused === true && child.activity?.kind !== "stalled") return false;
	return child.activity?.kind === "stalled" || child.stall !== undefined;
}

/** One-line stall marker for a subagent row: silence duration plus the tools still in flight. */
export function formatSubagentStallMarker(child: AgentConnectionRlmChildAgentSnapshot): string | undefined {
	const stall = child.stall;
	if (!stall && child.activity?.kind !== "stalled") return undefined;
	// The marker renders as a red warning line, which is the wrong thing to shout about a healthy
	// long command; the agents-view row still states the neutral fact ("long-running 12m").
	if (stall?.excused === true && child.activity?.kind !== "stalled") return undefined;
	const silentSeconds = Math.max(1, Math.round((stall?.silentMs ?? 0) / 1000));
	const tools = stall?.inFlightTools ?? [];
	const toolText = tools.length > 0 ? `, in-flight: ${tools.join(", ")}` : "";
	const unsettled = stall?.unsettled ? ", abort did not settle" : "";
	return `stalled ${silentSeconds}s${toolText}${unsettled}`;
}

/** One child row of the subagent panel. */
export type SubagentPanelRowState = "running" | "idle" | "done" | "failed" | "stalled";

export interface SubagentPanelRow {
	id: string;
	/**
	 * The child's own source status was terminal (`done`/`error`/`cancelled`), even
	 * when the row still renders as `idle` because its session stays resident for a
	 * while after finishing. Folding keys off this, not off `state`: PM's rule is
	 * that finished work leaves the panel (2026-09-25 已经结束的工作流要及时删除), and
	 * a finished child that hosts a resident session is still finished work.
	 */
	finished?: boolean;
	/** The child's daemon session, when it has one: Enter opens it directly. */
	activeSessionId?: string;
	/** Display name (session name, else label). */
	name: string;
	state: SubagentPanelRowState;
	/** Run time so far, when the snapshot reports it. */
	elapsedMs?: number;
	/** What the child is doing or how it ended, in plain words. */
	activity?: string;
	/** The child's session directory: how a closed child is found again to reopen it. */
	sessionDir?: string;
	/**
	 * A failed row whose failure notice already reached the parent: it has been
	 * seen, so it no longer holds the panel open the way a fresh failure does.
	 */
	acknowledged?: boolean;
	/**
	 * Epoch ms of the child's last tracked activity (the snapshot's own
	 * `lastActivityAt`). The row order is recency within a status group, so the
	 * newest work sits at the top; absent timestamps keep their source order.
	 */
	lastActivityAt?: number;
}

/** Rows shown at once; the rest scroll into view as the selection moves. */
export const SUBAGENT_PANEL_MAX_ROWS = 4;

/**
 * The panel's row order (PM 2026-09-25: 最新工作流要提前 — the newest work first).
 *
 * Three groups, in this order: busy children (running, and a stalled one still
 * holds an in-flight turn), then idle, then the settled ones (done and failed
 * alike). A finished child therefore never sits above a live one any more - it
 * used to outrank a running row - and inside a group the most recent activity
 * wins. `stalled` keeps the top of the busy group: a wedged child is the one
 * fact a reader must not have to scroll for.
 */
const ROW_STATE_GROUP: Record<SubagentPanelRowState, number> = {
	stalled: 0,
	running: 0,
	idle: 1,
	done: 2,
	failed: 2,
};

/**
 * Total order over panel rows: status group, then last activity newest first.
 * Ties inside a group fall back to the state's own rank (a stalled child above a
 * running one, a failure above a plain completion) so two rows sharing a
 * timestamp - or carrying none, as a client predating `lastActivityAt` - still
 * order deterministically instead of by whichever arrived first.
 */
export function compareSubagentPanelRows(a: SubagentPanelRow, b: SubagentPanelRow): number {
	const groupDiff = ROW_STATE_GROUP[a.state] - ROW_STATE_GROUP[b.state];
	if (groupDiff !== 0) return groupDiff;
	const activityDiff = (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
	if (activityDiff !== 0) return activityDiff;
	if (a.state !== b.state) {
		if (a.state === "stalled") return -1;
		if (b.state === "stalled") return 1;
		if (a.state === "failed") return -1;
		if (b.state === "failed") return 1;
	}
	return 0;
}

function firstLine(text: string | undefined): string | undefined {
	const line = text
		?.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	return line || undefined;
}

function rowActivity(child: AgentConnectionRlmChildAgentSnapshot, state: SubagentPanelRowState): string | undefined {
	if (state === "stalled") {
		const silent = Math.max(1, Math.round((child.stall?.silentMs ?? 0) / 1000));
		const tools = child.stall?.inFlightTools ?? [];
		return `${silent}s 没有动静${tools.length > 0 ? ` · 在跑 ${tools.join(", ")}` : ""}`;
	}
	if (state === "failed") return firstLine(child.error) ?? "出错";
	if (state === "done") return firstLine(child.answerPreview) ?? firstLine(child.recap);
	switch (child.activity?.kind) {
		case "executing":
			return child.activity.toolName ? `执行 ${child.activity.toolName}` : "执行中";
		case "writing":
			return "回答中";
		case "waiting":
			return "等待模型";
		default:
			return firstLine(child.recap);
	}
}

/**
 * How long a settled row keeps its place in the panel (PM 2026-09-25: 已经结束的
 * 工作流要及时删除). Past this the row is hidden from the list - the snapshot
 * itself is kept, and the header's 收口 count still carries it.
 */
export const SUBAGENT_PANEL_SETTLED_RETENTION_MS = 30 * 60_000;

/** How the panel decides which of its rows to show right now. */
export interface SubagentPanelVisibility {
	/**
	 * Rows that must not fold even when settled: children whose reply landed after
	 * their task ended and has not been read yet (`repliedSinceTask`). The parent
	 * would otherwise lose the only marker that an answer is waiting.
	 */
	pinnedRowIds?: ReadonlySet<string>;
	/** Now, epoch ms. */
	now: number;
	/** A settled row folds away once it has been quiet this long. */
	retentionMs?: number;
	/**
	 * Epoch ms at which the parent's earlier turn ended. A child that settled
	 * during that turn belongs to work the parent has already moved past, so its
	 * row folds as soon as the turn is over (PM: 父会话该轮结束).
	 */
	parentTurnEndedAt?: number;
	/** The panel's own toggle: show every folded row again until it is switched back. */
	showSettled?: boolean;
}

/** The rows the panel shows, and the settled ones it folded out of the list. */
export interface SubagentPanelSelection {
	rows: SubagentPanelRow[];
	folded: SubagentPanelRow[];
}

/** A row no longer doing anything: done or failed. Busy and idle rows are never folded. */
export function isSettledSubagentPanelRow(row: SubagentPanelRow): boolean {
	return row.finished === true || row.state === "done" || row.state === "failed";
}

/**
 * Whether a settled row has left the panel's recency window.
 *
 * Two independent clocks, either one enough: the retention window since the row's
 * last activity, and the parent's turn boundary. Fail-open on a missing timestamp
 * (a client that predates `lastActivityAt`): a row whose age cannot be judged is
 * kept rather than hidden, because hiding work the reader never saw is worse than
 * one stale line.
 */
export function isSubagentPanelRowFolded(row: SubagentPanelRow, visibility: SubagentPanelVisibility): boolean {
	if (!isSettledSubagentPanelRow(row)) return false;
	if (visibility.showSettled === true) return false;
	// A failed child stays on the list: the panel orders it to the top precisely so a
	// wedged or broken child is the one fact the reader never has to scroll for, and
	// folding it would hide that fact behind the toggle. Same for a settled child whose
	// reply arrived after its task ended and the parent has not read it yet.
	if (row.state === "failed") return false;
	if (visibility.pinnedRowIds?.has(row.id) === true) return false;
	const retentionMs = visibility.retentionMs ?? SUBAGENT_PANEL_SETTLED_RETENTION_MS;
	const lastActivityAt = row.lastActivityAt;
	if (lastActivityAt === undefined) return false;
	if (visibility.now - lastActivityAt >= retentionMs) return true;
	if (visibility.parentTurnEndedAt !== undefined && lastActivityAt <= visibility.parentTurnEndedAt) return true;
	return false;
}

/**
 * The panel's visible rows: fold the settled rows that fell out of the window,
 * keep the rest in panel order (see {@link compareSubagentPanelRows}).
 *
 * Pure on purpose - roster plus clock in, visible row order out - so the rule is
 * unit-testable without a live session, and so the header's counts (which read the
 * roster, not this list) stay the whole story while rows fold away.
 */
export function selectSubagentPanelRows(
	rows: readonly SubagentPanelRow[],
	visibility: SubagentPanelVisibility,
): SubagentPanelSelection {
	const visible: SubagentPanelRow[] = [];
	const folded: SubagentPanelRow[] = [];
	for (const row of rows) {
		if (isSubagentPanelRowFolded(row, visibility)) folded.push(row);
		else visible.push(row);
	}
	return { rows: visible, folded };
}

/**
 * The panel rows for this session's subtree (see collectSubtreeSubagentSnapshots),
 * most relevant first: stalled, failed, running, idle, finished. A failure the
 * parent was already told about (`seenFailureChildIds`) ranks with the finished
 * rows: it is history, and it must not pin the panel open forever.
 */
export function buildSubagentPanelRows(
	children: Iterable<AgentConnectionRlmChildAgentSnapshot>,
	parentId: string | undefined,
	seenFailureChildIds: ReadonlySet<string> = new Set(),
): SubagentPanelRow[] {
	const rows = collectSubtreeSubagentSnapshots(children, parentId).map((child) => {
		const roster = classifySubagentSnapshotStatus(child);
		const state: SubagentPanelRowState = isStalledSubagentSnapshot(child)
			? "stalled"
			: child.status === "error"
				? "failed"
				: roster === "running"
					? "running"
					: roster === "idle"
						? "idle"
						: "done";
		const row: SubagentPanelRow = { id: child.id, name: child.sessionName ?? child.label, state };
		// Terminal source status, independent of the roster projection: `done` with a
		// resident session projects to `idle` above, yet nothing will ever run in it again.
		if (child.status === "done" || child.status === "error" || child.status === "cancelled") row.finished = true;
		if (child.activeSessionId) row.activeSessionId = child.activeSessionId;
		if (child.sessionDir) row.sessionDir = child.sessionDir;
		if (child.durationMs !== undefined) row.elapsedMs = child.durationMs;
		if (state === "failed" && seenFailureChildIds.has(child.id)) row.acknowledged = true;
		if (child.lastActivityAt !== undefined) row.lastActivityAt = child.lastActivityAt;
		const activity = rowActivity(child, state);
		if (activity) row.activity = activity;
		return row;
	});
	return rows.sort(compareSubagentPanelRows);
}

/** A row with nothing left to watch: finished, idle, or a failure the parent has seen. */
function isSettledPanelRow(row: SubagentPanelRow): boolean {
	return row.state === "idle" || row.state === "done" || (row.state === "failed" && row.acknowledged === true);
}

/** The session a stall marker names: the text before its first `: `. */
function stallMarkerName(marker: string): string {
	const at = marker.indexOf(": ");
	return at === -1 ? marker : marker.slice(0, at);
}

/** `2:14`, `1:02:03`. */
export function formatSubagentElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const seconds = String(total % 60).padStart(2, "0");
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}:${seconds}`;
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
}

/**
 * Every snapshot descending from `parentId` at any depth, breadth-first over `parentId`.
 * A cancelled row still links its own children, so a live grandchild stays reachable when
 * its parent's row was already dropped; it is left out of the result itself.
 */
export function collectSubtreeSubagentSnapshots(
	children: Iterable<AgentConnectionRlmChildAgentSnapshot>,
	parentId: string | undefined,
): AgentConnectionRlmChildAgentSnapshot[] {
	const byParent = new Map<string | undefined, AgentConnectionRlmChildAgentSnapshot[]>();
	for (const child of children) {
		const siblings = byParent.get(child.parentId);
		if (siblings) siblings.push(child);
		else byParent.set(child.parentId, [child]);
	}
	const descendants: AgentConnectionRlmChildAgentSnapshot[] = [];
	const seen = new Set<string>();
	const queue: Array<string | undefined> = [parentId];
	for (let index = 0; index < queue.length; index++) {
		for (const child of byParent.get(queue[index]) ?? []) {
			// A snapshot set cannot link a node to itself, but a cycle would spin the walk forever.
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			queue.push(child.id);
			if (child.status !== "cancelled") descendants.push(child);
		}
	}
	return descendants;
}

/** Counts over every snapshot in this session's subtree, at any depth; the recursive roster carries the whole subtree. */
export function countSubtreeSubagentStatuses(
	children: Iterable<AgentConnectionRlmChildAgentSnapshot>,
	parentId: string | undefined,
): SubagentSummaryCounts {
	const counts: SubagentSummaryCounts = { total: 0, running: 0, idle: 0, inactive: 0 };
	for (const child of collectSubtreeSubagentSnapshots(children, parentId)) {
		counts.total += 1;
		counts[classifySubagentSnapshotStatus(child)] += 1;
	}
	return counts;
}

export function countRosterSubagentStatuses(
	summaries: Iterable<SessionSummary>,
	parent: { activeSessionId?: string | undefined; sessionId?: string | undefined; sessionFile?: string | undefined },
): SubagentSummaryCounts {
	const counts: SubagentSummaryCounts = { total: 0, running: 0, idle: 0, inactive: 0 };
	// The daemon roster spans every tree: count live rows in this session's subtree, at any depth.
	for (const child of collectSubagentDescendantSummaries(summaries, parent)) {
		if (child.lifecycle !== "live") continue;
		counts.total += 1;
		counts[child.rosterStatus ?? classifySessionRosterStatus(child)] += 1;
	}
	return counts;
}

/**
 * The hint line above the prompt: status on the left (the Ctrl+C exit
 * warning, the queue hint, goal, heartbeats, agent depth) and, on the right,
 * only the keys that work right now (`Esc 中断 · Ctrl+O 过程` while a turn
 * runs). Hints drop whole from the end when the line is too narrow; the
 * left side never truncates a key hint into noise.
 */
export class TrayInfoLine implements Component {
	constructor(
		private readonly getStatusLabel: () => string | undefined = () => undefined,
		private readonly getHints: () => readonly string[] = () => [],
		private readonly getOverrideLabel: () => string | undefined = () => undefined,
	) {}

	invalidate(): void {
		// Render output is derived from live getters.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const override = this.getOverrideLabel()?.trim();
		const left = override || this.getStatusLabel()?.trim() || "";
		const leftText = left ? ` ${left}` : "";
		const leftStyled = override ? theme.fg("warning", leftText) : theme.fg("muted", leftText);
		const hints = [...this.getHints()].filter((hint) => hint.trim().length > 0);
		for (let count = hints.length; count >= 0; count--) {
			const right = count > 0 ? `${hints.slice(0, count).join(" · ")} ` : "";
			const gap = leftText && right ? 2 : 0;
			if (visibleWidth(leftText) + gap + visibleWidth(right) > safeWidth) {
				continue;
			}
			if (!leftText && !right) {
				return [];
			}
			const padding = " ".repeat(Math.max(0, safeWidth - visibleWidth(leftText) - visibleWidth(right)));
			return [`${leftStyled}${padding}${theme.fg("dim", right)}`];
		}
		return [truncateToWidth(leftStyled, safeWidth, "…")];
	}
}

export class SubagentSummaryLine implements Component, Focusable {
	focused = false;
	private counts: SubagentSummaryCounts = { total: 0, running: 0, idle: 0, inactive: 0 };
	private spend: SubagentSpendSummary | undefined;
	private stallMarkers: readonly string[] = [];
	private rows: readonly SubagentPanelRow[] = [];
	/** Settled rows the fold-out rule kept off the list (see selectSubagentPanelRows). */
	private foldedSettledCount = 0;
	/** The history toggle: while on, folded rows are listed again until it is switched back. */
	private historyExpanded = false;
	private selectedRow = 0;
	private windowStart = 0;
	private openable = false;
	private cachedWidth?: number;
	private cachedKey?: string;
	private cachedLines?: string[];
	/** Click regions from the last render(): the header when openable, one per shown row. */
	private clickRegions: ClickRegion[] = [];

	/** Enter/open: the selected row, when the panel lists rows. */
	onOpen?: (row: SubagentPanelRow | undefined) => void;
	/** The configurable stop-all-subagents key, pressed while the panel has focus. */
	onStopAll?: () => void;
	onCancel?: () => void;
	onChatAction?: (data: string) => void;
	/** Fired by the history key: the panel's host flips the展开 of folded settled rows. */
	onToggleSettled?: () => void;
	/** Fired when a row is clicked: opens that subagent's detail card (see SubagentDetailOverlay). */
	onRowActivate?: (row: SubagentPanelRow) => void;

	setSubagentCounts(counts: SubagentSummaryCounts): void {
		this.counts = counts;
	}

	/**
	 * Spend figure for the blank area between the counts and the open hint.
	 * `undefined` (or an all-zero summary) keeps the cell blank: no sub-agents,
	 * no data yet, or nothing spent - a ¥0.00 tile would be noise, not a figure.
	 */
	setSubagentSpend(spend: SubagentSpendSummary | undefined): void {
		this.spend = spend;
	}

	/**
	 * Per-child stall markers (see formatSubagentStallMarker). Rendered in the
	 * error color below the counts box: a stalled child still counts as running,
	 * so without this line a wedged subagent is indistinguishable from progress.
	 */
	setStallMarkers(markers: readonly string[]): void {
		this.stallMarkers = markers;
	}

	/**
	 * How many settled rows the fold-out rule is keeping off the list. The header's
	 * 收口 count still carries them, so this is only what the hint line reports.
	 */
	setSubagentFoldedCount(count: number): void {
		if (this.foldedSettledCount === count) return;
		this.foldedSettledCount = count;
		this.invalidate();
	}

	/** Whether the history toggle is holding the folded rows open. */
	setSubagentHistoryExpanded(expanded: boolean): void {
		if (this.historyExpanded === expanded) return;
		this.historyExpanded = expanded;
		this.invalidate();
	}

	/**
	 * Per-child rows (see buildSubagentPanelRows), already folded down to the ones
	 * this panel shows (see selectSubagentPanelRows). With rows the panel lists each
	 * child and a stall shows as the row's state; without them (a roster-only
	 * family) the header stands alone and stall markers keep their own lines.
	 */
	setSubagentRows(rows: readonly SubagentPanelRow[]): void {
		// Keep the selection on the same child when the rows reorder (a child
		// finishing moves down the list), else clamp it into range.
		const selectedId = this.rows[this.selectedRow]?.id;
		this.rows = rows;
		const kept = selectedId === undefined ? -1 : rows.findIndex((row) => row.id === selectedId);
		this.selectedRow = kept !== -1 ? kept : Math.min(this.selectedRow, Math.max(0, rows.length - 1));
	}

	setOpenable(openable: boolean): void {
		this.openable = openable;
	}

	isSelectable(): boolean {
		return this.counts.total > 0 && this.openable;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.subagents.history")) {
			this.onToggleSettled?.();
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "app.agents.open")) {
			if (this.isSelectable()) this.onOpen?.(this.rows[this.selectedRow]);
			return;
		}
		if (keybindings.matches(data, "app.subagents.stopAll")) {
			this.onStopAll?.();
			return;
		}
		if (keybindings.matches(data, "tui.select.up") && this.selectedRow > 0) {
			this.selectedRow -= 1;
			this.invalidate();
			return;
		}
		if (keybindings.matches(data, "tui.select.down") && this.selectedRow < this.rows.length - 1) {
			this.selectedRow += 1;
			this.invalidate();
			return;
		}
		if (
			keybindings.matches(data, "tui.select.up") ||
			keybindings.matches(data, "tui.select.cancel") ||
			keybindings.matches(data, "app.agents.back")
		) {
			this.selectedRow = 0;
			this.windowStart = 0;
			this.onCancel?.();
			return;
		}
		this.onChatAction?.(data);
	}

	render(width: number): string[] {
		const key = this.cacheKey();
		if (this.cachedLines && this.cachedWidth === width && this.cachedKey === key) {
			return this.cachedLines;
		}
		const lines = this.renderLines(width);
		this.cachedWidth = width;
		this.cachedKey = key;
		this.cachedLines = lines;
		return lines;
	}

	/**
	 * Click regions from the last render(), in this component's own coordinates
	 * (containers offset them). One per shown row - clicking opens that
	 * subagent's detail card - plus the header when openable, matching the
	 * `打开` hint. Render cache hits reuse them: a cached frame has the same
	 * row layout the regions were built for.
	 */
	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.clickRegions;
	}

	private cacheKey(): string {
		return [
			this.counts.total,
			this.counts.running,
			this.counts.idle,
			this.counts.inactive,
			this.spendKey(),
			this.foldedSettledCount,
			this.historyExpanded ? 1 : 0,
			this.openable ? 1 : 0,
			this.focused ? 1 : 0,
			this.stallMarkers.join("\u0000"),
			this.selectedRow,
			this.rows
				.map((row) =>
					[row.id, row.name, row.state, row.elapsedMs ?? "", row.activity ?? "", row.acknowledged ? 1 : ""].join(
						"\u0003",
					),
				)
				.join("\u0000"),
		].join("\u0001");
	}

	/** Cache identity of the spend cell; the rendered figure changes with every field. */
	private spendKey(): string {
		const spend = this.spend;
		if (!spend) return "";
		return [
			spend.cost,
			spend.tokens,
			spend.parentCost,
			spend.unpriced.map((entry) => `${entry.model}:${entry.tokens}`).join(","),
			(spend.overridePriced ?? []).map((entry) => `${entry.model}:${entry.tokens}`).join(","),
			spend.partial ? 1 : 0,
		].join("\u0002");
	}

	/**
	 * The rows on screen: a window of SUBAGENT_PANEL_MAX_ROWS that follows the
	 * selection while the panel has focus, so every child is reachable with the
	 * arrow keys; unfocused it shows the most relevant rows from the top.
	 */
	private visibleWindow(): { start: number; rows: readonly SubagentPanelRow[] } {
		const size = Math.min(this.rows.length, SUBAGENT_PANEL_MAX_ROWS);
		if (!this.focused) return { start: 0, rows: this.rows.slice(0, size) };
		// The window moves only when the selection would leave it, like any list.
		let start = Math.min(this.windowStart, this.rows.length - size);
		if (this.selectedRow < start) start = this.selectedRow;
		if (this.selectedRow >= start + size) start = this.selectedRow - size + 1;
		this.windowStart = Math.max(0, start);
		return { start: this.windowStart, rows: this.rows.slice(this.windowStart, this.windowStart + size) };
	}

	/**
	 * The subagent panel: a dim rule header with the family counts on the left
	 * and the spend plus the open hint on the right -
	 * ` 子代理 3  运行 2 · 收口 1 ────── 子代理 ¥12.40 · 592M tok ｜ 全部 ¥18.95  ↓ 选择 ─` -
	 * then one row per child, most relevant first:
	 * `   ● review   运行 2:14   读取 footer.ts`. Focus moves a ` › ` selector
	 * over the rows. No children hides the panel.
	 */
	private renderLines(width: number): string[] {
		this.clickRegions = [];
		if (this.counts.total === 0) return [];
		const safeWidth = Math.max(1, width);
		const lines = [this.renderHeader(safeWidth)];
		if (this.openable) {
			this.clickRegions.push({
				line: 0,
				col: 0,
				width: safeWidth,
				height: 1,
				onClick: () => this.onOpen?.(undefined),
			});
		}
		if (
			!this.focused &&
			!this.historyExpanded &&
			this.rows.length > 0 &&
			this.rows.every(isSettledPanelRow)
		) {
			// Nothing in flight: finished children would otherwise sit there as a
			// block of rows until they close. One line says so; the header's ↓ still lists them.
			// (Upstream 48a61f7b9's isSettledPanelRow keeps an acknowledged failure in
			// the fold; our history toggle can still hold every settled row on the list.)
			const idleText =
				this.foldedSettledCount > 0
					? `   都做完了，已收起 ${this.foldedSettledCount} 个已结束的子代理（记录保留）`
					: `   ${this.settledFoldText()}`;
			lines.push(theme.fg("dim", truncateToWidth(idleText, safeWidth, "…")));
			return lines;
		}
		if (this.rows.length === 0 && this.foldedSettledCount > 0) {
			// Everything the list had is settled and folded: say so, and name the key
			// that brings the history back - an empty panel would read as "no children".
			lines.push(theme.fg("dim", truncateToWidth(this.foldedHintText(), safeWidth, "…")));
			return lines;
		}
		const { start, rows: shown } = this.visibleWindow();
		if (start > 0) {
			lines.push(theme.fg("dim", truncateToWidth(`   ↑ 上面还有 ${start} 个`, safeWidth, "")));
		}
		shown.forEach((row, index) => {
			lines.push(this.renderRow(row, safeWidth, this.focused && start + index === this.selectedRow));
			this.clickRegions.push({
				line: lines.length - 1,
				col: 0,
				width: safeWidth,
				height: 1,
				onClick: () => {
					// A click selects the row it lands on, so the keyboard selector
					// and the pointer agree on which child is active.
					this.selectedRow = start + index;
					this.invalidate();
					this.onRowActivate?.(row);
				},
			});
		});
		const below = this.rows.length - start - shown.length;
		if (below > 0) {
			// Unfocused, the header's `↓ 选择` is the way in; focused, the arrow scrolls on.
			const fold = this.focused ? `   ↓ 下面还有 ${below} 个` : `   … 还有 ${below} 个`;
			lines.push(theme.fg("dim", truncateToWidth(fold, safeWidth, "")));
		}
		if (this.foldedSettledCount > 0 || (this.historyExpanded && this.rows.some(isSettledSubagentPanelRow))) {
			lines.push(theme.fg("dim", truncateToWidth(this.foldedHintText(), safeWidth, "…")));
		}
		// A stalled session with a row already reads 卡住 there; one without a row
		// (roster-only, or folded past the row cap) keeps its marker line, so a
		// wedged descendant is never invisible.
		const shownNames = new Set(shown.map((row) => row.name));
		const orphanMarkers = this.stallMarkers.filter((marker) => !shownNames.has(stallMarkerName(marker)));
		for (const marker of orphanMarkers.slice(0, MAX_RENDERED_STALL_MARKERS)) {
			lines.push(theme.fg("error", truncateToWidth(`  ⚠ ${marker}`, safeWidth, "…")));
		}
		return lines;
	}

	/**
/**
	 * The fold line. "闲置一阵后会自动关闭" is only promised while some child is still
	 * resident (idle); once they are all closed the line says so instead.
	 */
	private settledFoldText(): string {
		const seenFailures = this.rows.filter((row) => row.state === "failed").length;
		const head = seenFailures > 0 ? `都结束了（${seenFailures} 个出错，父代理已收到）` : "都做完了";
		return this.rows.some((row) => row.state === "idle")
			? `${head}，闲置一阵后会自动关闭（记录保留）`
			: `${head}，已自动关闭（记录保留）`;
	}

	/**
	 * `   已收起 2 个已结束的子代理 · Alt+H 展开` - settled rows the list is keeping
	 * out of the way, and the way back to them. While the toggle holds them open the
	 * same line reports what is on screen and how to fold it again, so the state is
	 * never only in the reader's head.
	 */
	private foldedHintText(): string {
		const key = keyText("app.subagents.history");
		const shownSettled = this.rows.filter((row) => isSettledSubagentPanelRow(row)).length;
		if (this.historyExpanded && shownSettled > 0) {
			return `   已展开 ${shownSettled} 个已结束的子代理${key ? ` · ${key} 收起` : ""}`;
		}
		const failed = this.rows.filter((row) => row.state === "failed").length;
		const failedSuffix = failed > 0 ? `（含 ${failed} 个失败，仍在上方）` : "";
		return `   已收起 ${this.foldedSettledCount} 个已结束的子代理${failedSuffix}${key ? ` · ${key} 展开` : ""}`;
	}

	private renderHeader(safeWidth: number): string {
		const counts = this.renderCounts();
		const left = `${LINE_INDENT}${theme.fg("muted", `子代理 ${this.counts.total}`)}${counts ? `  ${counts}` : ""}`;
		const rowsSelectable = this.rows.length > 0;
		const anyWorking = this.rows.some((row) => row.state === "running" || row.state === "stalled");
		const stopHint = this.focused && anyWorking ? `${keyText("app.subagents.stopAll")} 全部停止` : "";
		const openHint = this.openable
			? this.focused
				? rowsSelectable
					? stopHint
					: `${keyText("tui.select.confirm")}/${keyText("app.agents.open")} 打开`
				: `${keyText("tui.editor.cursorDown", { primaryOnly: true })} 选择`
			: stopHint;
		// F5 (DS2 review): the open hint never participates in truncation; the
		// spend cell degrades (whole rungs) inside what the hint leaves, and a
		// truncated money figure is never shown.
		const tail = ` ${theme.fg("dim", "─")}`;
		const hint = openHint ? `  ${theme.fg("dim", openHint)}` : "";
		const minRule = 2;
		const spendBudget =
			safeWidth - visibleWidth(left) - visibleWidth(hint) - visibleWidth(tail) - minRule - 2 - SPEND_MIN_GAP;
		const spend = this.renderSpend(Math.max(0, spendBudget));
		const right = `${spend}${spend ? hint : hint.trimStart()}${tail}`;
		const ruleWidth = safeWidth - visibleWidth(left) - visibleWidth(right) - 2;
		const header =
			ruleWidth >= minRule
				? `${left} ${theme.fg("dim", "─".repeat(ruleWidth))} ${right}`
				: `${truncateToWidth(left, Math.max(1, safeWidth - visibleWidth(hint)), "…")}${hint}`;
		const fitted = truncateToWidth(header, safeWidth, "");
		const padded = fitted + " ".repeat(Math.max(0, safeWidth - visibleWidth(fitted)));
		// Without rows the header itself is the focus target.
		if (this.focused && !rowsSelectable) {
			return padded
				.split("\x1b[0m")
				.map((segment) => theme.bg("selectedBg", segment))
				.join("\x1b[0m");
		}
		return padded;
	}

	private renderRow(row: SubagentPanelRow, safeWidth: number, selected: boolean): string {
		const glyph =
			row.state === "running"
				? theme.fg("accent", "●")
				: row.state === "idle"
					? theme.fg("dim", "○")
					: row.state === "done"
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");
		const prefix = selected ? ` ${theme.fg("accent", "›")} ` : "   ";
		const nameWidth = Math.min(
			ROW_NAME_MAX_WIDTH,
			Math.max(...this.rows.map((entry) => visibleWidth(entry.name)), 4),
		);
		const name = truncateToWidth(row.name, nameWidth, "…");
		const namePadded = name + " ".repeat(Math.max(0, nameWidth - visibleWidth(name)));
		const stateText = `${ROW_STATE_WORDS[row.state]}${row.elapsedMs !== undefined ? ` ${formatSubagentElapsed(row.elapsedMs)}` : ""}`;
		const stateColor = row.state === "failed" || row.state === "stalled" ? "error" : "muted";
		const statePadded = stateText + " ".repeat(Math.max(0, 10 - visibleWidth(stateText)));
		const head = `${prefix}${glyph} ${theme.fg("text", namePadded)}   ${theme.fg(stateColor, statePadded)}`;
		const actions = selected && this.openable ? `${keyText("tui.select.confirm")} 打开 ` : "";
		const available = safeWidth - visibleWidth(head) - 3 - (actions ? visibleWidth(actions) + 2 : 0);
		const activity =
			row.activity && available >= ROW_ACTIVITY_MIN_WIDTH
				? `   ${theme.fg(row.state === "stalled" ? "error" : "dim", truncateToWidth(row.activity, available, "…"))}`
				: "";
		let line = truncateToWidth(`${head}${activity}`, safeWidth, "");
		if (actions && visibleWidth(line) + visibleWidth(actions) + 1 <= safeWidth) {
			line += " ".repeat(safeWidth - visibleWidth(line) - visibleWidth(actions)) + theme.fg("dim", actions);
		}
		if (!selected) return line;
		const padded = line + " ".repeat(Math.max(0, safeWidth - visibleWidth(line)));
		return padded
			.split("\x1b[0m")
			.map((segment) => theme.bg("selectedBg", segment))
			.join("\x1b[0m");
	}

	/** `运行 1 · 空闲 0 · 收口 2` — zero-count classes are skipped entirely. */
	private renderCounts(): string {
		const parts: string[] = [];
		if (this.counts.running > 0) {
			parts.push(theme.fg("success", `运行 ${this.counts.running}`));
		}
		if (this.counts.idle > 0) {
			parts.push(theme.fg("warning", `空闲 ${this.counts.idle}`));
		}
		if (this.counts.inactive > 0) {
			parts.push(theme.fg("dim", `收口 ${this.counts.inactive}`));
		}
		return parts.join(theme.fg("dim", " · "));
	}

	/**
	 * The spend cell, degraded to the widest form that fits `budget` columns.
	 *
	 * Degradation order (each step loses exactly one thing): the "全部" figure
	 * first (the least valuable by design), then the annotations' token counts
	 * (unpriced and override markers alike), then the annotations themselves,
	 * then the whole cell - a truncated
	 * money figure would read as a wrong number, so the cell is dropped, never
	 * ellipsized. All-zero figures render nothing (no ¥0.00 noise), and an
	 * all-unpriced family shows tokens plus the warning instead of ¥0.00.
	 */
	private renderSpend(budget: number): string {
		const spend = this.spend;
		if (!spend || (spend.cost === 0 && spend.tokens === 0)) return "";
		const dot = theme.fg("dim", " · ");
		// The header already names the family (`子代理 3`); the cell carries figures only.
		const money =
			spend.cost > 0
				? `${spend.partial ? theme.fg("dim", "≈") : ""}${theme.fg("accent", formatSpendCost(spend.cost))}`
				: "";
		const tokens = theme.fg("dim", `${spend.partial ? "≈" : ""}${formatTokenCount(spend.tokens)} tok`);
		const primary = money ? `${money}${dot}${tokens}` : tokens;
		const total = spend.parentCost + spend.cost;
		// `｜` separates the two spend groups (sub-agents vs the whole family);
		// `·` stays inside a group.
		const secondary =
			total > 0
				? `${theme.fg("dim", " ｜ ")}${theme.fg("dim", `全部 ${spend.partial ? "≈" : ""}${formatSpendCost(total)}`)}`
				: "";
		const annotate = (withTokens: boolean): string => {
			const annotations = [
				this.renderUnpricedAnnotation(spend, withTokens),
				this.renderOverrideAnnotation(spend, withTokens),
			];
			const text = annotations.filter((annotation) => annotation.length > 0).join(" ");
			return text ? ` ${text}` : "";
		};
		const rungs = [
			primary + secondary + annotate(true),
			primary + annotate(true),
			primary + annotate(false),
			primary,
		];
		for (const rung of rungs) {
			if (visibleWidth(rung) <= budget) return rung;
		}
		return "";
	}

	/** `(kimi-k3 8.1M tok 未定价)`; `withTokens: false` drops the per-model token counts. */
	private renderUnpricedAnnotation(spend: SubagentSpendSummary, withTokens: boolean): string {
		if (spend.unpriced.length === 0) return "";
		const models = spend.unpriced
			.map((entry) => (withTokens ? `${entry.model} ${formatTokenCount(entry.tokens)}` : entry.model))
			.join(" · ");
		return theme.fg("warning", `(${models}${withTokens ? " tok" : ""} 未定价)`);
	}

	/**
	 * `(qwen3.8-flash 8.1M tok 已改价)` for models the settings re-priced. The
	 * marker is what makes a corrected price legible where the money is read: the
	 * figure is right, and `/usage` names the override behind it.
	 */
	private renderOverrideAnnotation(spend: SubagentSpendSummary, withTokens: boolean): string {
		const priced = spend.overridePriced ?? [];
		if (priced.length === 0) return "";
		const models = priced
			.map((entry) => (withTokens ? `${entry.model} ${formatTokenCount(entry.tokens)}` : entry.model))
			.join(" · ");
		return theme.fg("accent", `(${models}${withTokens ? " tok" : ""} 已改价)`);
	}

	invalidate(): void {
		// Render output is derived from counts, spend, focus state, and theme/keybindings.
		this.cachedWidth = undefined;
		this.cachedKey = undefined;
		this.cachedLines = undefined;
	}
}
