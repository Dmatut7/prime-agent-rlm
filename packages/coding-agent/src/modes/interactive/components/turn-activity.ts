import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export type TurnStepStatus = "queued" | "running" | "done" | "error";

export interface TurnStep {
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: TurnStepStatus;
}

/** Compact display verb for a tool step; ipython cells render as python. */
export function turnStepVerb(toolName: string): string {
	return toolName === "ipython" ? "python" : toolName;
}

/**
 * U4/U6 turn aggregation: one agent turn (every tool call between two user
 * prompts) renders a two-line mechanical surface at the turn head — ① the
 * thinking block header `思考 12.3s` / `思考 5 段 · 96.3s` (one header for the
 * whole turn, always visible while it has thinking; Ctrl+T expands the
 * traces) and ② the process line `⚙ 10 步 · 1.0s · python×10` (Ctrl+O expands
 * the tool calls, outputs, and edit diffs). The collapsed view renders no
 * per-block thinking rows; the full traces only appear expanded. Settled
 * tools hide themselves while the group is collapsed; the summary component
 * owns the visible lines. While the turn is still running, a live tool keeps
 * its own body (the running preview stays watchable) and merges into the
 * line once it settles.
 */
export class TurnActivityState {
	readonly steps: TurnStep[] = [];
	readonly startedAt: number;
	private lastSettledAt: number | undefined;
	private turnEndedAt: number | undefined;
	private thinkingSegments = 0;
	private liveThinkingSegments = 0;
	private collapsed = true;

	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt;
	}

	get isCollapsed(): boolean {
		return this.collapsed;
	}

	setCollapsed(collapsed: boolean): void {
		if (this.collapsed === collapsed) {
			return;
		}
		this.collapsed = collapsed;
	}

	addStep(step: TurnStep): void {
		this.steps.push(step);
	}

	/** Thinking blocks of a settled assistant message land here (U6). */
	addThinkingSegments(count: number): void {
		if (count > 0) {
			this.thinkingSegments += count;
		}
	}

	/**
	 * The run ended (agent_end / replay turn boundary). A tool turn already
	 * freezes its duration on the last settled step; a thinking-only turn has
	 * no steps, so this stamp is what stops its `思考 Xs` clock.
	 */
	markTurnEnded(timestamp = Date.now()): void {
		this.turnEndedAt = timestamp;
	}

	/** Thinking blocks of the message still streaming (U6); the live count is replaced, not accumulated. */
	setLiveThinkingSegments(count: number): void {
		this.liveThinkingSegments = Math.max(0, count);
	}

	/** Thinking segments counted so far: settled messages plus the streaming one. */
	get totalThinkingSegments(): number {
		return this.thinkingSegments + this.liveThinkingSegments;
	}

	markRunning(toolCallId: string, timestamp = Date.now()): void {
		this.setStepStatus(toolCallId, "running", timestamp);
	}

	setStepStatus(toolCallId: string, status: TurnStepStatus, timestamp = Date.now()): void {
		let settledNow = false;
		for (let i = 0; i < this.steps.length; i++) {
			const step = this.steps[i];
			if (step?.toolCallId !== toolCallId || step.status === status) {
				continue;
			}
			this.steps[i] = { ...step, status };
			if (status === "done" || status === "error") {
				settledNow = true;
			}
		}
		if (settledNow) {
			this.lastSettledAt = Math.max(this.lastSettledAt ?? 0, timestamp);
		}
	}

	/** True once every step has settled: the aggregate line is then final. */
	get isSettled(): boolean {
		return this.steps.length > 0 && this.steps.every((step) => step.status === "done" || step.status === "error");
	}

	/**
	 * Whether the given call's step has settled. Tool components hide behind the
	 * aggregate line based on this, not their own result: a live-attached pending
	 * tool can hold a partial result while the turn is still running.
	 */
	isStepSettled(toolCallId: string): boolean {
		const step = this.steps.find((candidate) => candidate.toolCallId === toolCallId);
		return step !== undefined && (step.status === "done" || step.status === "error");
	}

	private verbSummary(): string {
		const counts = new Map<string, number>();
		for (const step of this.steps) {
			const verb = turnStepVerb(step.toolName);
			counts.set(verb, (counts.get(verb) ?? 0) + 1);
		}
		return [...counts.entries()].map(([verb, count]) => (count > 1 ? `${verb}×${count}` : verb)).join(" · ");
	}

	private durationSeconds(): string {
		// A tool turn freezes on its last settled step; a thinking-only turn
		// freezes on markTurnEnded (agent_end / replay turn boundary).
		const end = this.steps.length > 0 ? (this.lastSettledAt ?? Date.now()) : (this.turnEndedAt ?? Date.now());
		return `${(Math.max(0, end - this.startedAt) / 1000).toFixed(1)}s`;
	}

	/**
	 * U6 ①: the turn's thinking block header — one line, always visible while
	 * the turn has thinking. 评审短账: with steps the duration belongs to the ⚙
	 * line (the header carries the segment count alone); a thinking-only turn
	 * has no ⚙ line, so the header keeps the duration - `思考 36.3s` for one
	 * segment, `思考 5 段 · 96.3s` for several.
	 */
	thinkingHeaderText(): string {
		const segments = this.totalThinkingSegments;
		if (segments <= 0) {
			return "";
		}
		if (this.steps.length > 0) {
			return `思考 ${segments} 段`;
		}
		return segments > 1 ? `思考 ${segments} 段 · ${this.durationSeconds()}` : `思考 ${this.durationSeconds()}`;
	}

	/** U6 ②: the process line — steps, duration, verb summary. */
	summaryText(): string {
		const count = this.steps.length;
		if (count === 0) {
			return "";
		}
		const parts = [`⚙ ${count} 步 · ${this.durationSeconds()}`];
		const verbs = this.verbSummary();
		if (verbs) {
			parts.push(verbs);
		}
		return parts.join(" · ");
	}
}

export class TurnSummaryComponent implements Component {
	private expanded = false;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly state: TurnActivityState) {}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.state.setCollapsed(!expanded);
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width && this.state.isSettled) {
			return this.cachedLines;
		}
		const safeWidth = Math.max(1, width);
		// U6 two-line mechanical surface, both pinned at the turn head: the
		// thinking block header (①, always visible while the turn has thinking)
		// above the process line (②). No per-line expand hints — the single
		// global hint line at the chat tail carries the key division.
		const textLines = [this.state.thinkingHeaderText(), this.state.summaryText()].filter((text) => text.length > 0);
		const lines = textLines.flatMap((text) => [
			theme.fg("muted", truncateToWidth(` ${text}`, safeWidth, "")),
			" ".repeat(safeWidth),
		]);
		if (this.state.isSettled) {
			this.cachedWidth = width;
			this.cachedLines = lines;
		} else {
			// A live run keeps mutating; only the settled lines are cacheable.
			this.cachedWidth = undefined;
			this.cachedLines = undefined;
		}
		return lines;
	}
}

/** Rendered width of a summary line, for tests. */
export function turnSummaryVisibleWidth(state: TurnActivityState, width: number): number {
	return visibleWidth(new TurnSummaryComponent(state).render(width)[0] ?? "");
}
