import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
const GROUP_GAP = "    ";

/** Blank space always kept between the spend cell and the open hint. */
const SPEND_MIN_GAP = 1;

/** Leading indent of the borderless subagents line. */
const LINE_INDENT = "  ";

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
	private openable = false;
	private cachedWidth?: number;
	private cachedKey?: string;
	private cachedLines?: string[];

	onOpen?: () => void;
	onCancel?: () => void;
	onChatAction?: (data: string) => void;

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

	setOpenable(openable: boolean): void {
		this.openable = openable;
	}

	isSelectable(): boolean {
		return this.counts.total > 0 && this.openable;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "app.agents.open")) {
			if (this.isSelectable()) this.onOpen?.();
			return;
		}
		if (
			keybindings.matches(data, "tui.select.up") ||
			keybindings.matches(data, "tui.select.cancel") ||
			keybindings.matches(data, "app.agents.back")
		) {
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

	private cacheKey(): string {
		return [
			this.counts.total,
			this.counts.running,
			this.counts.idle,
			this.counts.inactive,
			this.spendKey(),
			this.openable ? 1 : 0,
			this.focused ? 1 : 0,
			this.stallMarkers.join("\u0000"),
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
	 * U6 ③: one borderless line under the watermark line —
	 * `  运行 1 · 空闲 0 · 收口 2    子代理 ¥961.72 · 592M tok ｜ 全部 ¥1235.16    ↓ 选择`.
	 * Zero-count classes render nothing; no subagents at all hides the whole
	 * line. The words match the agents view (收口 = settled rows).
	 */
	private renderLines(width: number): string[] {
		if (this.counts.total === 0) return [];
		const safeWidth = Math.max(1, width);
		const counts = this.renderCounts();
		const openHint = this.openable
			? this.focused
				? `${keyText("tui.select.confirm")}/${keyText("app.agents.open")} 打开`
				: `${keyText("tui.editor.cursorDown", { primaryOnly: true })} 选择`
			: "";
		// The blank area between the counts and the open hint carries the family
		// spend (sub-agent money + tokens; the whole family as a secondary figure
		// when width allows). The hint stays right-anchored and the body is padded
		// to the full width, so figure changes only ever eat whitespace - the
		// money is fixed two-decimal and the tokens use the bounded k/M
		// abbreviation, neither of which can move the hint or the line length.
		// F5 (DS2 review): the open hint never participates in truncation. The
		// counts and the spend cell get the width the hint leaves; a wide family
		// truncates its figures (whole segments, money drops rungs) instead of
		// squeezing the agents-view entry off the line.
		const hintReserve = visibleWidth(openHint) > 0 ? visibleWidth(openHint) + SPEND_MIN_GAP : 0;
		const contentBudget = Math.max(1, safeWidth - visibleWidth(LINE_INDENT) - hintReserve);
		const spendBudget = contentBudget - visibleWidth(counts) - GROUP_GAP.length - SPEND_MIN_GAP;
		const spend = this.renderSpend(Math.max(0, spendBudget));
		const separator = spend ? GROUP_GAP : "";
		const gap = Math.max(
			SPEND_MIN_GAP,
			safeWidth -
				visibleWidth(LINE_INDENT) -
				visibleWidth(counts) -
				separator.length -
				visibleWidth(spend) -
				visibleWidth(openHint),
		);
		const body = truncateToWidth(
			`${LINE_INDENT}${truncateToWidth(`${counts}${separator}${spend}`, contentBudget, "…")}${" ".repeat(
				gap,
			)}${theme.fg("dim", openHint)}`,
			safeWidth,
			"",
		);
		const pad = " ".repeat(Math.max(0, safeWidth - visibleWidth(body)));
		// Truncation may inject full ANSI resets; wrap each segment so the
		// selection background survives past them (custom-editor precedent).
		const content = this.focused
			? `${body}${pad}`
					.split("\x1b[0m")
					.map((segment) => theme.bg("selectedBg", segment))
					.join("\x1b[0m")
			: `${body}${pad}`;
		const lines = [content];
		for (const marker of this.stallMarkers.slice(0, MAX_RENDERED_STALL_MARKERS)) {
			lines.push(theme.fg("error", truncateToWidth(`  ⚠ ${marker}`, safeWidth, "…")));
		}
		return lines;
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
		const label = theme.fg("dim", "子代理");
		const money =
			spend.cost > 0
				? `${spend.partial ? theme.fg("dim", "≈") : ""}${theme.fg("accent", formatSpendCost(spend.cost))}`
				: "";
		const tokens = theme.fg("dim", `${spend.partial ? "≈" : ""}${formatTokenCount(spend.tokens)} tok`);
		const primary = money ? `${label} ${money}${dot}${tokens}` : `${label} ${tokens}`;
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
