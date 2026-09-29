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
import { type ThemeBg, type ThemeColor, theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

/** Leading indent of the strip. */
const STRIP_INDENT = 1;

/** Blank columns between two blocks. */
const CHIP_GAP = 1;

/** Widest name inside a block before it is cut. */
const CHIP_NAME_MAX_WIDTH = 16;

/** Widest task tag after a block's name before it is cut. */
const CHIP_TAG_MAX_WIDTH = 14;

/** Blank columns the hint keeps clear of the row's right edge. */
const HINT_MARGIN = 2;

const CHIP_STATE_WORDS: Record<SubagentPanelRowState, string> = {
	running: "回答中",
	idle: "空闲",
	done: "✓ 已交回",
	failed: "✗ 出错",
	stalled: "⚠ 卡住",
};

const CHIP_STATE_COLORS: Record<SubagentPanelRowState, ThemeColor> = {
	running: "timelineAi",
	idle: "dim",
	done: "timelineOk",
	failed: "error",
	stalled: "error",
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
	/** The child's daemon session, when it has one: Enter opens it directly. */
	activeSessionId?: string;
	/** Display name (session name, else label). */
	name: string;
	/** A few words on the child's task, shown after its name when there is room. */
	tag?: string;
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
}

const ROW_STATE_ORDER: Record<SubagentPanelRowState, number> = {
	stalled: 0,
	failed: 1,
	running: 2,
	idle: 3,
	done: 4,
};

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
		// Without a session name the label is the name already; a tag would say it twice.
		const tag = child.sessionName ? subagentTaskTag(child.label, child.sessionName) : undefined;
		if (tag) row.tag = tag;
		if (child.activeSessionId) row.activeSessionId = child.activeSessionId;
		if (child.sessionDir) row.sessionDir = child.sessionDir;
		if (child.durationMs !== undefined) row.elapsedMs = child.durationMs;
		if (state === "failed" && seenFailureChildIds.has(child.id)) row.acknowledged = true;
		const activity = rowActivity(child, state);
		if (activity) row.activity = activity;
		return row;
	});
	return rows.sort((a, b) => rowOrder(a) - rowOrder(b));
}

/**
 * A few words on what a child was asked to do: the first clause of its task
 * brief (`钉住框头：检查……` gives `钉住框头`), without repeating the child's name.
 */
export function subagentTaskTag(label: string, name: string): string | undefined {
	let brief = label.replace(/\s+/g, " ").trim();
	const own = name.trim().toLowerCase();
	if (own && brief.toLowerCase().startsWith(own) && !/[\p{L}\p{N}]/u.test(brief.charAt(own.length))) {
		brief = brief.slice(own.length).replace(/^[\s:：,，\-—]+/, "");
	}
	const clause = brief.split(/[。！？!?；;：:，,]|\.\s|\s[—-]{1,2}\s/)[0]?.trim();
	return clause ? truncateToWidth(clause, CHIP_TAG_MAX_WIDTH, "…") : undefined;
}

function rowOrder(row: SubagentPanelRow): number {
	return row.acknowledged ? ROW_STATE_ORDER.done : ROW_STATE_ORDER[row.state];
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

/** One block of the strip: a child, a stalled descendant without a row of its own, or the family counts. */
interface StripItem {
	key: string;
	kind: "row" | "orphan" | "counts";
	/** What Enter or a click opens; absent for the blocks that open the family view. */
	row?: SubagentPanelRow;
	name: string;
	tag?: string;
	state?: SubagentPanelRowState;
}

interface StripLayout {
	width: number;
	start: number;
	count: number;
	maxStart: number;
}

function leftMarkerText(hidden: number): string {
	return `‹ 还有 ${hidden} 个`;
}

function rightMarkerText(hidden: number): string {
	return `还有 ${hidden} 个 ›`;
}

/** The narrowest cut of `text` that still shows its first character (with the cut mark when more follows). */
function minCutWidth(text: string): number {
	const full = visibleWidth(text);
	for (let width = 1; width < full; width++) {
		const cut = truncateToWidth(text, width, "…");
		if (cut !== "" && cut !== "…") return width;
	}
	return full;
}

/**
 * The subagent strip under the prompt: one row of small blocks, one per child,
 * ` ◇ review 运行中 `, in most-relevant-first order. When they do not all fit the
 * row pages sideways (`‹ 还有 2 个` / `还有 3 个 ›`, the wheel over the row, or
 * the arrow keys once it has focus). A click on a block, or Enter on the
 * selected one, opens that child. The row never takes more than one line.
 */
export class SubagentSummaryLine implements Component, Focusable {
	focused = false;
	private counts: SubagentSummaryCounts = { total: 0, running: 0, idle: 0, inactive: 0 };
	private spend: SubagentSpendSummary | undefined;
	private stallMarkers: readonly string[] = [];
	private rows: readonly SubagentPanelRow[] = [];
	private items: readonly StripItem[] = [];
	private itemsDirty = true;
	private widthPrefix: number[] = [0];
	private taggedWidthPrefix: number[] = [0];
	/** Whether the blocks carry their task tags at the current width: only when every block has room for one. */
	private tagged = false;
	private selectedKey: string | undefined;
	private selectedIndex = 0;
	private windowStart = 0;
	private hoveredKey: string | undefined;
	private openable = false;
	private focusedAtLastRender = false;
	private layout: StripLayout | undefined;
	private regions: ClickRegion[] = [];
	private cachedWidth?: number;
	private cachedKey?: string;
	private cachedLines?: string[];

	/** Enter, or a click on a block: the child it stands for; `undefined` opens the family view. */
	onOpen?: (row: SubagentPanelRow | undefined) => void;
	/** The configurable stop-all-subagents key, pressed while the strip has focus. */
	onStopAll?: () => void;
	onCancel?: () => void;
	onChatAction?: (data: string) => void;

	setSubagentCounts(counts: SubagentSummaryCounts): void {
		this.counts = counts;
		this.itemsDirty = true;
	}

	/**
	 * The family's spend figure. The strip does not draw it: the status line under
	 * it reads it back with getSubagentSpend and shows it on its right side.
	 */
	setSubagentSpend(spend: SubagentSpendSummary | undefined): void {
		this.spend = spend;
	}

	getSubagentSpend(): SubagentSpendSummary | undefined {
		return this.spend;
	}

	/**
	 * Per-child stall markers (see formatSubagentStallMarker). A marker whose
	 * child has a block of its own is already said there (`⚠ 卡住`); one without
	 * (a roster-only descendant) becomes a red block in the same row.
	 */
	setStallMarkers(markers: readonly string[]): void {
		this.stallMarkers = markers;
		this.itemsDirty = true;
	}

	/** Per-child rows (see buildSubagentPanelRows), most relevant first: one block each. */
	setSubagentRows(rows: readonly SubagentPanelRow[]): void {
		this.rows = rows;
		this.itemsDirty = true;
	}

	setOpenable(openable: boolean): void {
		this.openable = openable;
	}

	isSelectable(): boolean {
		return this.openable && this.getItems().length > 0;
	}

	/**
	 * Whether the strip shows a block per child. The status line drops its own
	 * `◇ N 个子代理在跑` chip only while it does; a family the roster counts but no
	 * snapshot describes has just the one counts block.
	 */
	hasChipRow(): boolean {
		return this.counts.total > 0 && this.rows.length > 0;
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "app.subagents.prev")) {
			this.moveSelection(-1);
			return;
		}
		if (keybindings.matches(data, "app.subagents.next")) {
			this.moveSelection(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "app.agents.open")) {
			if (this.isSelectable()) this.open(this.getItems()[this.selectedIndex]);
			return;
		}
		if (keybindings.matches(data, "app.subagents.stopAll")) {
			this.onStopAll?.();
			return;
		}
		if (
			keybindings.matches(data, "tui.select.up") ||
			keybindings.matches(data, "tui.select.cancel") ||
			keybindings.matches(data, "app.agents.back")
		) {
			this.selectedIndex = 0;
			this.selectedKey = this.getItems()[0]?.key;
			this.invalidate();
			this.onCancel?.();
			return;
		}
		// One row has no line below it: Down stays here instead of typing into the prompt.
		if (keybindings.matches(data, "tui.select.down")) return;
		this.onChatAction?.(data);
	}

	render(width: number): string[] {
		const key = this.cacheKey();
		if (this.cachedLines && this.cachedWidth === width && this.cachedKey === key) {
			return this.cachedLines;
		}
		const lines = this.renderLines(width);
		this.cachedWidth = width;
		// Rendering may settle the window (a clamp, a follow): key on the settled state.
		this.cachedKey = this.cacheKey();
		this.cachedLines = lines;
		return lines;
	}

	private cacheKey(): string {
		return [
			this.counts.total,
			this.counts.running,
			this.counts.idle,
			this.counts.inactive,
			this.openable ? 1 : 0,
			this.focused ? 1 : 0,
			this.selectedKey ?? "",
			this.windowStart,
			this.hoveredKey ?? "",
			this.getItems()
				.map((item) => [item.key, item.name, item.state ?? ""].join("\u0003"))
				.join("\u0000"),
		].join("\u0001");
	}

	/** The blocks in row order: red stall blocks first, then the children, or the counts block when no child is known. */
	private getItems(): readonly StripItem[] {
		if (!this.itemsDirty) return this.items;
		this.itemsDirty = false;
		const items: StripItem[] = [];
		if (this.counts.total > 0) {
			const named = new Set(this.rows.map((row) => row.name));
			const seen = new Set<string>();
			for (const marker of this.stallMarkers) {
				const name = stallMarkerName(marker);
				if (named.has(name) || seen.has(name)) continue;
				seen.add(name);
				items.push({ key: `orphan:${name}`, kind: "orphan", name });
			}
			if (this.rows.length > 0) {
				for (const row of this.rows) {
					items.push({
						key: `row:${row.id}`,
						kind: "row",
						row,
						name: row.name,
						...(row.tag ? { tag: row.tag } : {}),
						state: row.state,
					});
				}
			} else {
				items.push({ key: "counts", kind: "counts", name: "" });
			}
		}
		this.items = items;
		this.widthPrefix = [0];
		this.taggedWidthPrefix = [0];
		for (const item of items) {
			this.widthPrefix.push((this.widthPrefix.at(-1) ?? 0) + this.chipWidth(item, false));
			this.taggedWidthPrefix.push((this.taggedWidthPrefix.at(-1) ?? 0) + this.chipWidth(item, true));
		}
		// Keep the selection on the same child when the blocks reorder (a child finishing moves down).
		const kept = this.selectedKey === undefined ? -1 : items.findIndex((item) => item.key === this.selectedKey);
		this.selectedIndex = kept !== -1 ? kept : Math.min(this.selectedIndex, Math.max(0, items.length - 1));
		this.selectedKey = items[this.selectedIndex]?.key;
		return items;
	}

	private open(item: StripItem | undefined): void {
		if (!item || !this.openable) return;
		this.onOpen?.(item.row);
	}

	private moveSelection(delta: -1 | 1): void {
		const items = this.getItems();
		const next = Math.max(0, Math.min(items.length - 1, this.selectedIndex + delta));
		if (next === this.selectedIndex) return;
		this.selectedIndex = next;
		this.selectedKey = items[next]?.key;
		if (this.layout) this.followSelection(this.layout.width);
		this.invalidate();
	}

	/** Whether every block fits in the row with its task tag: then all of them carry one, else none does. */
	private tagsFit(width: number): boolean {
		const total = this.items.length;
		if (!this.items.some((item) => item.tag)) return false;
		return STRIP_INDENT + (this.taggedWidthPrefix[total] ?? 0) + (total - 1) * CHIP_GAP <= width;
	}

	/** How many blocks fit from `start` in `width` columns, counting the markers the row then needs. */
	private fitCount(start: number, width: number): number {
		const total = this.items.length;
		const prefix = this.tagged ? this.taggedWidthPrefix : this.widthPrefix;
		const leftWidth = start > 0 ? visibleWidth(leftMarkerText(start)) + CHIP_GAP : 0;
		const fits = (count: number): boolean => {
			const end = start + count;
			const blocks = (prefix[end] ?? 0) - (prefix[start] ?? 0) + (count - 1) * CHIP_GAP;
			const rightWidth = end < total ? CHIP_GAP + visibleWidth(rightMarkerText(total - end)) : 0;
			return STRIP_INDENT + leftWidth + blocks + rightWidth <= width;
		};
		// The needed width only grows with the count, so the largest count that fits is found by bisection.
		let low = 1;
		let high = Math.max(1, total - start);
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (fits(middle)) low = middle;
			else high = middle - 1;
		}
		return low;
	}

	/** The furthest the row scrolls: the first start from which every remaining block is on screen. */
	private lastStart(width: number): number {
		const total = this.items.length;
		for (let start = 0; start < total; start++) {
			if (start + this.fitCount(start, width) >= total) return start;
		}
		return Math.max(0, total - 1);
	}

	/** Scroll just far enough to bring the selected block into view. */
	private followSelection(width: number): void {
		let start = this.windowStart;
		if (this.selectedIndex < start) {
			start = this.selectedIndex;
		} else {
			while (start < this.selectedIndex && this.selectedIndex >= start + this.fitCount(start, width)) start += 1;
		}
		this.windowStart = start;
	}

	/** Where the previous screenful starts: the first start whose blocks reach the current one. */
	private previousPageStart(start: number, width: number): number {
		for (let candidate = 0; candidate < start; candidate++) {
			if (candidate + this.fitCount(candidate, width) >= start) return candidate;
		}
		return Math.max(0, start - 1);
	}

	private scrollTo(start: number): void {
		const layout = this.layout;
		if (!layout) return;
		this.windowStart = Math.max(0, Math.min(layout.maxStart, start));
		this.invalidate();
	}

	/** Wheel over the row: one block sideways; false at either end, so the page scrolls instead. */
	private wheel(direction: -1 | 1): boolean {
		const layout = this.layout;
		if (!layout) return false;
		const next = Math.max(0, Math.min(layout.maxStart, layout.start + direction));
		if (next === layout.start) return false;
		this.scrollTo(next);
		return true;
	}

	private renderLines(width: number): string[] {
		const items = this.getItems();
		this.regions = [];
		this.layout = undefined;
		if (items.length === 0) return [];
		const safeWidth = Math.max(1, width);
		this.tagged = this.tagsFit(safeWidth);
		if (this.focused && !this.focusedAtLastRender) this.followSelection(safeWidth);
		this.focusedAtLastRender = this.focused;
		const maxStart = this.lastStart(safeWidth);
		this.windowStart = Math.max(0, Math.min(maxStart, this.windowStart));
		const start = this.windowStart;
		const count = this.fitCount(start, safeWidth);
		this.layout = { width: safeWidth, start, count, maxStart };
		const onWheel = (direction: -1 | 1): boolean => this.wheel(direction);
		const regions: ClickRegion[] = [];
		const room = (used: number): number => Math.max(1, safeWidth - used);

		// A block always says at least the first character of its name: on a screen too narrow for that
		// beside the `‹` marker the marker steps aside, and on one too narrow for it at all the block is left to the `›` marker.
		const firstItem = items[start];
		const minFirst = firstItem ? this.minChipWidth(firstItem) : 0;
		let line = " ".repeat(Math.min(STRIP_INDENT, safeWidth));
		let col = visibleWidth(line);
		const leftSpan = start > 0 ? visibleWidth(leftMarkerText(start)) + CHIP_GAP : 0;
		const showLeft = start > 0 && safeWidth - col - leftSpan >= minFirst;
		const end = safeWidth - col - (showLeft ? leftSpan : 0) >= minFirst ? start + count : start;
		if (showLeft) {
			const marker = leftMarkerText(start);
			const markerWidth = visibleWidth(marker);
			regions.push({
				line: 0,
				col,
				width: markerWidth,
				height: 1,
				onClick: () => this.scrollTo(this.previousPageStart(start, safeWidth)),
				onWheel,
			});
			line += `${theme.fg("dim", marker)} `;
			col += markerWidth + CHIP_GAP;
		}
		for (let index = start; index < end; index++) {
			const item = items[index];
			if (!item) continue;
			const selected = this.focused && index === this.selectedIndex;
			const hovered = this.hoveredKey === item.key;
			const chip = this.buildChip(item, selected, hovered, CHIP_NAME_MAX_WIDTH, room(col), this.tagged);
			regions.push({
				line: 0,
				col,
				width: chip.width,
				height: 1,
				// The frame may be cached from before the row changed: open what the block is now.
				onClick: () => this.open(this.getItems().find((current) => current.key === item.key)),
				onWheel,
				// A block that cannot be opened has nothing to light up for.
				...(this.openable
					? {
							hoverKey: `subagent-chip:${item.key}`,
							onHover: (isHovered: boolean) => {
								if (isHovered) this.hoveredKey = item.key;
								else if (this.hoveredKey === item.key) this.hoveredKey = undefined;
								this.invalidate();
							},
						}
					: {}),
			});
			line += chip.text;
			col += chip.width;
			if (index < end - 1) {
				line += " ".repeat(CHIP_GAP);
				col += CHIP_GAP;
			}
		}
		if (end < items.length) {
			const marker = rightMarkerText(items.length - end);
			const markerWidth = visibleWidth(marker);
			line += " ".repeat(CHIP_GAP);
			col += CHIP_GAP;
			if (col + markerWidth <= safeWidth) {
				regions.push({
					line: 0,
					col,
					width: markerWidth,
					height: 1,
					onClick: () => this.scrollTo(start + count),
					onWheel,
				});
				line += theme.fg("dim", marker);
				col += markerWidth;
			}
		}
		const hint = this.pickHint(safeWidth - col);
		if (hint) {
			line +=
				" ".repeat(safeWidth - col - visibleWidth(hint) - HINT_MARGIN) +
				theme.fg("timelineFaint", hint) +
				" ".repeat(HINT_MARGIN);
		}
		regions.push({ line: 0, col: 0, width: safeWidth, height: 1, passive: true, onClick: () => {}, onWheel });
		this.regions = regions;
		return [truncateToWidth(line, safeWidth, "")];
	}

	/** The widest hint that fits in `space` free columns, or nothing. */
	private pickHint(space: number): string | undefined {
		for (const hint of this.hintCandidates()) {
			if (visibleWidth(hint) + 2 + HINT_MARGIN <= space) return hint;
		}
		return undefined;
	}

	private hintCandidates(): string[] {
		if (!this.openable) return [];
		const key = (binding: Parameters<typeof keyText>[0]): string => keyText(binding, { primaryOnly: true });
		const say = (keys: string, words: string): string => (keys ? `${keys} ${words}` : "");
		if (this.focused) {
			const move = say([key("app.subagents.prev"), key("app.subagents.next")].filter(Boolean).join("/"), "选");
			const enter = say(key("tui.select.confirm"), "进去");
			const back = say(key("tui.select.cancel"), "返回");
			const stop = this.rows.some((row) => row.state === "running" || row.state === "stalled")
				? say(keyText("app.subagents.stopAll"), "全部停止")
				: "";
			return [[move, enter, back, stop], [move, enter, back], [enter, back], [back]]
				.map((parts) => parts.filter(Boolean).join(" · "))
				.filter(Boolean);
		}
		const enterHint = say(key("tui.editor.cursorDown"), "选一个进去看");
		if (!enterHint) return [];
		if (this.rows.length > 0 && this.rows.every(isSettledPanelRow)) {
			return [`${this.settledFoldText()} · ${enterHint}`, this.settledFoldText(), enterHint];
		}
		return [enterHint];
	}

	/**
	 * What became of a family whose children are all done. "闲置一阵后会自动关闭" is
	 * only promised while some child is still resident (idle); once they are all
	 * closed the text says so instead.
	 */
	private settledFoldText(): string {
		const seenFailures = this.rows.filter((row) => row.state === "failed").length;
		const head = seenFailures > 0 ? `都结束了（${seenFailures} 个出错，父代理已收到）` : "都做完了";
		return this.rows.some((row) => row.state === "idle")
			? `${head}，闲置一阵后会自动关闭（记录保留）`
			: `${head}，已自动关闭（记录保留）`;
	}

	/**
	 * One block: ` ◇ name 运行中 ` on the subagent gold, or ` ⚠ name 卡住 ` on red for a
	 * stall without a row of its own. The pointed or selected block is brighter;
	 * the selected one also underlines its name. Widths are the same either way.
	 * A block that would overflow `maxWidth` gives up name width first, then its state.
	 */
	private buildChip(
		item: StripItem,
		selected: boolean,
		hovered: boolean,
		nameMax: number,
		maxWidth = Number.POSITIVE_INFINITY,
		withTag = false,
	): { text: string; width: number } {
		const lit = selected || hovered;
		const orphan = item.kind === "orphan";
		const bg: ThemeBg = orphan
			? lit
				? "kindErrorHoverBg"
				: "kindErrorBg"
			: lit
				? "kindSubagentHoverBg"
				: "kindSubagentBg";
		const glyph = orphan ? theme.fg("kindError", "⚠") : theme.bold(theme.fg("timelineSub", "◇"));
		const paint = (body: string): { text: string; width: number } => {
			// A truncation inside the body ends with a full reset, which also clears the background: put it back.
			const open = theme.bg(bg, "").replace(/\x1b\[49m$/, "");
			const text = theme.bg(bg, ` ${glyph} ${body} `.replaceAll("\x1b[0m", `\x1b[0m${open}`));
			return { text, width: visibleWidth(text) };
		};
		if (item.kind === "counts") {
			const counts = this.countParts()
				.map((part) => theme.fg(part.color, part.text))
				.join(theme.fg("dim", " · "));
			const body = `${theme.fg("text", `子代理 ${this.counts.total}`)}${counts ? `  ${counts}` : ""}`;
			// " ◇ " and the closing space are 4 columns around the body.
			return paint(truncateToWidth(body, Math.max(1, maxWidth - 4), "…"));
		}
		const stateWord = orphan ? "卡住" : CHIP_STATE_WORDS[item.state ?? "running"];
		const stateColor: ThemeColor = orphan ? "kindError" : CHIP_STATE_COLORS[item.state ?? "running"];
		const style = (name: string): string => {
			const shown = selected ? theme.underline(theme.bold(name)) : name;
			return theme.fg("text", shown);
		};
		const build = (nameWidth: number, withState: boolean, tag?: string): { text: string; width: number } =>
			paint(
				`${style(`${truncateToWidth(item.name, nameWidth, "…")}${tag ? ` ${tag}` : ""}`)}${withState ? ` ${theme.fg(stateColor, stateWord)}` : ""}`,
			);
		let chip = build(nameMax, true, withTag ? item.tag : undefined);
		if (chip.width > maxWidth) {
			// Name width first, down to its first character; the state word goes only when that is not enough.
			const floor = minCutWidth(item.name);
			const frame = visibleWidth(` ${orphan ? "⚠" : "◇"}  `);
			const withState = maxWidth - frame - visibleWidth(` ${stateWord}`);
			const bare = maxWidth - frame;
			if (withState >= floor) chip = build(Math.min(nameMax, withState), true);
			else if (bare >= floor) chip = build(Math.min(nameMax, bare), false);
			else return { text: "", width: 0 };
		}
		return chip;
	}

	/** `运行 1 · 空闲 0 · 收口 2` - zero-count classes are skipped entirely. */
	private countParts(): Array<{ text: string; color: ThemeColor }> {
		const parts: Array<{ text: string; color: ThemeColor }> = [];
		if (this.counts.running > 0) parts.push({ text: `运行 ${this.counts.running}`, color: "success" });
		if (this.counts.idle > 0) parts.push({ text: `空闲 ${this.counts.idle}`, color: "warning" });
		if (this.counts.inactive > 0) parts.push({ text: `收口 ${this.counts.inactive}`, color: "dim" });
		return parts;
	}

	/** The least a block can be cut to and still name its child. */
	private minChipWidth(item: StripItem): number {
		const glyph = item.kind === "orphan" ? "⚠" : "◇";
		const label = item.kind === "counts" ? `子代理 ${this.counts.total}` : item.name;
		return visibleWidth(` ${glyph}  `) + minCutWidth(label);
	}

	/** A block's width, from its plain text: the layout needs it without touching the theme. */
	private chipWidth(item: StripItem, withTag: boolean): number {
		if (item.kind === "counts") {
			const counts = this.countParts()
				.map((part) => part.text)
				.join(" · ");
			return visibleWidth(` ◇ 子代理 ${this.counts.total}${counts ? `  ${counts}` : ""} `);
		}
		const glyph = item.kind === "orphan" ? "⚠" : "◇";
		const word = item.kind === "orphan" ? "卡住" : CHIP_STATE_WORDS[item.state ?? "running"];
		const tag = withTag && item.tag ? ` ${item.tag}` : "";
		return visibleWidth(` ${glyph} ${truncateToWidth(item.name, CHIP_NAME_MAX_WIDTH, "…")}${tag} ${word} `);
	}

	invalidate(): void {
		// Render output is derived from counts, rows, focus, hover, scroll, and theme/keybindings.
		this.cachedWidth = undefined;
		this.cachedKey = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * The spend cell for the status line, in the widest form first and each next
 * form losing exactly one thing: the `全部` figure (the least valuable by
 * design), the annotations' token counts, the annotations, then the
 * annotation down to a bare `?` - a truncated money figure would read as a
 * wrong number, so the caller drops the whole cell instead of ellipsizing it.
 * All-zero figures give no forms (no ¥0.00 noise), and an all-unpriced family
 * shows tokens plus the warning instead of ¥0.00.
 */
export function renderSubagentSpendCell(spend: SubagentSpendSummary | undefined): string[] {
	if (!spend || (spend.cost === 0 && spend.tokens === 0)) return [];
	const lower = spend.partial ? "≈" : "";
	const money =
		spend.cost > 0
			? `${spend.partial ? theme.fg("dim", "≈") : ""}${theme.fg("accent", formatSpendCost(spend.cost))}`
			: "";
	const figure = money || theme.fg("dim", `${lower}${formatTokenCount(spend.tokens)} tok`);
	const primary = `${theme.fg("muted", "子代理")} ${figure}`;
	const total = spend.parentCost + spend.cost;
	const secondary =
		total > 0 ? `${theme.fg("dim", " · ")}${theme.fg("dim", `全部 ${lower}${formatSpendCost(total)}`)}` : "";
	const annotate = (withTokens: boolean): string => {
		const models = (entries: ReadonlyArray<{ model: string; tokens: number }>): string =>
			entries
				.map((entry) => (withTokens ? `${entry.model} ${formatTokenCount(entry.tokens)}` : entry.model))
				.join(" · ");
		const parts: string[] = [];
		if (spend.unpriced.length > 0) {
			parts.push(theme.fg("warning", `(${models(spend.unpriced)}${withTokens ? " tok" : ""} 未定价)`));
		}
		if ((spend.overridePriced ?? []).length > 0) {
			parts.push(theme.fg("accent", `(${models(spend.overridePriced ?? [])}${withTokens ? " tok" : ""} 已改价)`));
		}
		return parts.length > 0 ? ` ${parts.join(" ")}` : "";
	};
	const mark = spend.unpriced.length > 0 ? theme.fg("warning", "?") : "";
	const forms = [
		primary + secondary + annotate(true),
		primary + annotate(true),
		primary + annotate(false),
		primary + mark,
	];
	return forms.filter((form, index) => index === 0 || form !== forms[index - 1]);
}
