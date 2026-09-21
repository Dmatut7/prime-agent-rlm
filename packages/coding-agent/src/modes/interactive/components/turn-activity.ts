import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { expandCollapseHint } from "./keybinding-hints.js";

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
 * U4 turn aggregation: the tool activity of one agent turn (every tool call
 * between two user prompts) collapses to a single line — step count, total
 * wall time, and a verb summary — with Ctrl+O expanding the individual tool
 * blocks. Settled tools hide themselves while the group is collapsed; the
 * summary component owns the visible line. While the turn is still running,
 * a live tool keeps its own body (the running preview stays watchable) and
 * merges into the line once it settles.
 */
export class TurnActivityState {
	readonly steps: TurnStep[] = [];
	readonly startedAt: number;
	private lastSettledAt: number | undefined;
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

	summaryText(): string {
		const count = this.steps.length;
		const running = this.steps.some((step) => step.status === "running" || step.status === "queued");
		const duration =
			this.lastSettledAt !== undefined
				? Math.max(0, this.lastSettledAt - this.startedAt)
				: Date.now() - this.startedAt;
		const middle = running
			? `运行中 —— ${this.verbSummary()}`
			: `${(duration / 1000).toFixed(1)}s —— ${this.verbSummary()}`;
		return `⚙ 本轮 ${count} 步 · ${middle}`;
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
		const hint = expandCollapseHint("app.tools.expand", this.expanded);
		const line = ` ${this.state.summaryText()} ${hint}`;
		const safeWidth = Math.max(1, width);
		const lines = [theme.fg("muted", truncateToWidth(line, safeWidth, "")), " ".repeat(safeWidth)];
		if (this.state.isSettled) {
			this.cachedWidth = width;
			this.cachedLines = lines;
		} else {
			// A live run keeps mutating; only the settled line is cacheable.
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
