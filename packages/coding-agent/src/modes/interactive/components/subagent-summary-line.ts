import type { Usage } from "@earendil-works/pi-ai";
import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextTreeNode } from "../../../core/context-tree.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import { isDirectAgentChild } from "../../agents-view/agents-view-state.js";
import { type AgentRosterStatus, classifyAgentStatus } from "../../daemon/agent-roster.js";
import { classifySessionRosterStatus, type SessionSummary } from "../../daemon/daemon-session-list.js";
import { formatTokenCount } from "../agent-activity.js";
import { formatSpendCost } from "../spend-format.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

/** Bound on stall marker lines so a wedged family cannot push the editor off screen. */
const MAX_RENDERED_STALL_MARKERS = 3;

/** Space between the counts and the spend cell; matches the counts' own rhythm. */
const SPEND_SEPARATOR = "   ";

/** Blank space always kept between the spend cell and the open hint. */
const SPEND_MIN_GAP = 1;

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
	/** A scan budget truncated the tree, so every figure is a lower bound. */
	partial: boolean;
}

/** Spend-relevant token count, matching the "Total" line of /usage. */
function spentTokens(usage: Usage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Fold a session's context tree into the tray's spend summary (see
 * {@link SubagentSpendSummary} for the double-counting rules).
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
): SubagentSpendSummary {
	let cost = 0;
	let tokens = 0;
	let partial = false;
	const unpriced = new Map<string, number>();
	const walk = (node: ContextTreeNode, isRoot: boolean): void => {
		if (node.scan?.truncated) partial = true;
		if (!isRoot) {
			const nodeTokens = spentTokens(node.ownUsage);
			cost += node.ownUsage.cost.total;
			tokens += nodeTokens;
			if (node.ownUsage.cost.total === 0 && nodeTokens > 0 && (!node.model || !isModelPriced(node.model))) {
				const key = node.model?.id ?? "?";
				unpriced.set(key, (unpriced.get(key) ?? 0) + nodeTokens);
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
		parentCost: root.ownUsage.cost.total,
		unpriced: [...unpriced.entries()]
			.map(([model, unpricedTokens]) => ({ model, tokens: unpricedTokens }))
			.sort((a, b) => b.tokens - a.tokens || (a.model < b.model ? -1 : 1)),
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

export function countDirectSubagentStatuses(
	children: Iterable<AgentConnectionRlmChildAgentSnapshot>,
	parentId: string | undefined,
): SubagentSummaryCounts {
	const counts: SubagentSummaryCounts = { total: 0, running: 0, idle: 0, inactive: 0 };
	for (const child of children) {
		if (child.parentId !== parentId || child.status === "cancelled") continue;
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
	for (const child of summaries) {
		if (child.runtimeKind !== "subagent" || child.lifecycle !== "live") continue;
		if (!isDirectAgentChild(child, parent)) continue;
		counts.total += 1;
		counts[child.rosterStatus ?? classifySessionRosterStatus(child)] += 1;
	}
	return counts;
}

/** One-line entry into the current session's scoped agents view. */
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

	constructor(
		private readonly getLocationLabel: () => string | undefined = () => undefined,
		private readonly getContextLabel: () => string | undefined = () => undefined,
		private readonly getOverrideLabel: () => string | undefined = () => undefined,
	) {}

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
			this.getOverrideLabel() ?? "",
			this.getLocationLabel() ?? "",
			this.getContextLabel() ?? "",
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
			spend.partial ? 1 : 0,
		].join("\u0002");
	}

	private renderLines(width: number): string[] {
		const lines = this.renderInfoLine(width);
		if (this.counts.total === 0) return lines;
		if (width < 2) return lines;
		const safeWidth = width;
		const inner = safeWidth - 2;
		const label = theme.fg("accent", "[1msubagents[22m");
		const top = truncateToWidth(
			`${theme.fg("border", "╭─ ")}${label}${theme.fg("border", ` ${"─".repeat(Math.max(0, inner - 3 - visibleWidth(label)))}╮`)}`,
			safeWidth,
			"…",
		);
		const counts =
			theme.fg("success", `● ${this.counts.running} running`) +
			"   " +
			theme.fg("warning", `◐ ${this.counts.idle} idle`) +
			"   " +
			theme.fg("dim", `○ ${this.counts.inactive} inactive`);
		const openHint = this.openable
			? this.focused
				? `${keyText("tui.select.confirm")}/${keyText("app.agents.open")} open`
				: `${keyText("tui.editor.cursorDown", { primaryOnly: true })} select`
			: "";
		// The blank area between the counts and the open hint carries the family
		// spend (Σ sub-agent money + tokens; mother included as a secondary figure
		// when width allows). The hint stays right-anchored and the body is padded
		// to the full inner width, so figure changes only ever eat whitespace -
		// the money is fixed two-decimal and the tokens use the bounded k/M
		// abbreviation, neither of which can move the hint or the line length.
		const spendBudget =
			inner - 2 - visibleWidth(counts) - SPEND_SEPARATOR.length - SPEND_MIN_GAP - visibleWidth(openHint);
		const spend = this.renderSpend(spendBudget);
		const separator = spend ? SPEND_SEPARATOR : "";
		const gap = Math.max(
			SPEND_MIN_GAP,
			inner - 2 - visibleWidth(counts) - separator.length - visibleWidth(spend) - visibleWidth(openHint),
		);
		const body = truncateToWidth(
			` ${counts}${separator}${spend}${" ".repeat(gap)}${theme.fg("dim", openHint)} `,
			inner,
			"…",
		);
		const pad = " ".repeat(Math.max(0, inner - visibleWidth(body)));
		// Truncation may inject full ANSI resets; wrap each segment so the
		// selection background survives past them (custom-editor precedent).
		const content = this.focused
			? `${body}${pad}`
					.split("\x1b[0m")
					.map((segment) => theme.bg("selectedBg", segment))
					.join("\x1b[0m")
			: `${body}${pad}`;
		lines.push(
			top,
			`${theme.fg("border", "│")}${content}${theme.fg("border", "│")}`,
			theme.fg("border", `╰${"─".repeat(inner)}╯`),
		);
		for (const marker of this.stallMarkers.slice(0, MAX_RENDERED_STALL_MARKERS)) {
			lines.push(theme.fg("error", truncateToWidth(`  ⚠ ${marker}`, safeWidth, "…")));
		}
		return lines;
	}

	/**
	 * The spend cell, degraded to the widest form that fits `budget` columns.
	 *
	 * Degradation order (each step loses exactly one thing): "总" first (the
	 * least valuable figure by design), then the unpriced annotation's token
	 * counts, then the annotation itself, then the whole cell - a truncated
	 * money figure would read as a wrong number, so the cell is dropped, never
	 * ellipsized. All-zero figures render nothing (no ¥0.00 noise), and an
	 * all-unpriced family shows tokens plus the warning instead of ¥0.00.
	 */
	private renderSpend(budget: number): string {
		const spend = this.spend;
		if (!spend || (spend.cost === 0 && spend.tokens === 0)) return "";
		const dot = theme.fg("dim", " · ");
		const label = theme.fg("dim", "Σ 子代理");
		const money =
			spend.cost > 0
				? `${spend.partial ? theme.fg("dim", "≈") : ""}${theme.fg("accent", formatSpendCost(spend.cost))}`
				: "";
		const tokens = theme.fg("dim", `${spend.partial ? "≈" : ""}${formatTokenCount(spend.tokens)} tok`);
		const primary = money ? `${label} ${money}${dot}${tokens}` : `${label} ${tokens}`;
		const total = spend.parentCost + spend.cost;
		const secondary =
			total > 0 ? `${dot}${theme.fg("dim", `总 ${spend.partial ? "≈" : ""}${formatSpendCost(total)}`)}` : "";
		const annotate = (withTokens: boolean): string => {
			const annotation = this.renderUnpricedAnnotation(spend, withTokens);
			return annotation ? ` ${annotation}` : "";
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

	private renderInfoLine(width: number): string[] {
		const overrideLabel = this.getOverrideLabel()?.trim();
		const locationLabel = this.getLocationLabel()?.trim();
		const contextLabel = this.getContextLabel()?.trim();
		const left = overrideLabel || locationLabel || "";
		if (!left && !contextLabel) return [];
		const safeWidth = Math.max(1, width);
		const right = contextLabel ?? "";
		const gap = left && right ? 2 : 0;
		const rightWidth = Math.min(visibleWidth(right), Math.max(0, safeWidth - gap));
		const leftWidth = Math.max(0, safeWidth - rightWidth - gap);
		const renderedLeft = truncateToWidth(left, leftWidth, "…");
		const renderedRight = truncateToWidth(right, rightWidth, "…");
		const padding = Math.max(0, safeWidth - visibleWidth(renderedLeft) - visibleWidth(renderedRight));
		return [theme.fg("muted", `${renderedLeft}${" ".repeat(padding)}${renderedRight}`)];
	}

	invalidate(): void {
		// Render output is derived from counts, spend, focus state, and theme/keybindings.
		this.cachedWidth = undefined;
		this.cachedKey = undefined;
		this.cachedLines = undefined;
	}
}
