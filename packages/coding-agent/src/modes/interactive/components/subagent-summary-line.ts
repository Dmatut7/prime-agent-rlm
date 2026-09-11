import { type Component, type Focusable, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConnectionRlmChildAgentSnapshot } from "../../agent-connection/index.js";
import { isDirectAgentChild } from "../../agents-view/agents-view-state.js";
import { type AgentRosterStatus, classifyAgentStatus } from "../../daemon/agent-roster.js";
import { classifySessionRosterStatus, type SessionSummary } from "../../daemon/daemon-session-list.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

/** Bound on stall marker lines so a wedged family cannot push the editor off screen. */
const MAX_RENDERED_STALL_MARKERS = 3;

export interface SubagentSummaryCounts {
	total: number;
	running: number;
	idle: number;
	inactive: number;
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
	private stallMarkers: readonly string[] = [];
	private openable = false;

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
		const gap = Math.max(1, inner - 2 - visibleWidth(counts) - visibleWidth(openHint));
		const body = truncateToWidth(` ${counts}${" ".repeat(gap)}${theme.fg("dim", openHint)} `, inner, "…");
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
		// Render output is derived from counts and focus state.
	}
}
