import { type ClickRegion, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { TurnFootNote } from "./turn-footnote.js";

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
 * TUI v4 T6: while the process block is open, turns with MORE than this many
 * steps render the key-steps view - first 3 + a fold row + last 3 - instead of
 * every row. Failed and running steps never fold (✗ 永保留).
 */
export const PROCESS_FOLD_THRESHOLD = 8;
/** TUI v4 T6: how many steps each edge of the key-steps window keeps. */
export const PROCESS_FOLD_EDGE = 3;

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
	/** U6 K3 ②: the turn's own Ctrl+T lane (the traces inside this turn's span). */
	thinkingExpanded = false;
	/** U6 K3 ②: the turn's own Ctrl+P lane (agent message rows inside this turn's span). */
	agentMessagesExpanded = false;

	/**
	 * TUI v4 T5: the 💭⚙✉ process blocks as first-class independent state.
	 * Ctrl+T/O/P each flip exactly one of these; they stack freely and no
	 * block's expansion ever closes another (三块独立,不互斥).
	 */
	get thinkingBlockExpanded(): boolean {
		return this.thinkingExpanded;
	}
	get processBlockExpanded(): boolean {
		return !this.collapsed;
	}
	get commsBlockExpanded(): boolean {
		return this.agentMessagesExpanded;
	}

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

	/**
	 * TUI v4 T6: the turn's agent-to-agent comm count (received agent-message
	 * rows plus sent agent messages), the one counter both the live and the
	 * replay paths feed - the footnote reads it off the state, so the two
	 * paths cannot drift apart (R5-P2②).
	 */
	private commMessages = 0;
	get commMessageCount(): number {
		return this.commMessages;
	}
	addCommMessage(): void {
		this.commMessages += 1;
	}

	/**
	 * TUI v4 T6: the key-steps view of the process block. Armed only while the
	 * block is open and the turn has more steps than
	 * {@link PROCESS_FOLD_THRESHOLD}; Ctrl+O's second press lifts it.
	 */
	private processKeySteps = false;
	get processKeyStepsView(): boolean {
		// The key-steps view only exists while the process block is OPEN; a
		// closed block hides every settled step the pre-v4 way.
		return this.processKeySteps && !this.collapsed && this.dedupedStepCount() > PROCESS_FOLD_THRESHOLD;
	}
	/** Lift or re-arm the key-steps fold (the wiring owns the key cycle). */
	setProcessKeySteps(keySteps: boolean): void {
		this.processKeySteps = keySteps;
	}
	private dedupedStepCount(): number {
		return new Set(this.steps.map((step) => step.toolCallId)).size;
	}
	private stepIndexOf(toolCallId: string): number {
		return this.steps.findIndex((step) => step.toolCallId === toolCallId);
	}
	/**
	 * Whether the step folds away in the key-steps view: middle range, settled
	 * successfully, and past the threshold. Errors and running steps never
	 * fold; the first/last {@link PROCESS_FOLD_EDGE} steps stay.
	 */
	isStepFolded(toolCallId: string): boolean {
		if (!this.processKeyStepsView) {
			return false;
		}
		const index = this.stepIndexOf(toolCallId);
		if (index < PROCESS_FOLD_EDGE || index >= this.steps.length - PROCESS_FOLD_EDGE) {
			return false;
		}
		return this.steps[index]?.status === "done";
	}
	/** The first folded step carries the `⋯ 中间 N 步` fold row. */
	isProcessFoldRowCarrier(toolCallId: string): boolean {
		if (!this.processKeyStepsView) {
			return false;
		}
		for (let index = 0; index < this.steps.length; index++) {
			if (this.isStepFoldedAtIndex(index)) {
				return this.steps[index]?.toolCallId === toolCallId;
			}
		}
		return false;
	}
	private isStepFoldedAtIndex(index: number): boolean {
		if (index < PROCESS_FOLD_EDGE || index >= this.steps.length - PROCESS_FOLD_EDGE) {
			return false;
		}
		return this.steps[index]?.status === "done";
	}
	/** How many steps the key-steps view folds away. */
	processFoldHiddenCount(): number {
		if (!this.processKeyStepsView) {
			return 0;
		}
		let count = 0;
		for (let index = 0; index < this.steps.length; index++) {
			if (this.isStepFoldedAtIndex(index)) {
				count += 1;
			}
		}
		return count;
	}

	/**
	 * TUI v4: the turn's wall-clock span in milliseconds, for the quiet-mode
	 * footnote. Same freeze rules as the legacy duration text: a tool turn
	 * freezes on its last settled step, a thinking-only turn on the
	 * turn-end stamp.
	 */
	turnDurationMs(): number {
		const end = this.steps.length > 0 ? (this.lastSettledAt ?? Date.now()) : (this.turnEndedAt ?? Date.now());
		return Math.max(0, end - this.startedAt);
	}

	/** TUI v4: whether the turn's end stamp landed (agent_end / replay boundary). */
	get isTurnEnded(): boolean {
		return this.turnEndedAt !== undefined;
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

	/**
	 * Whether the given call's step SUCCEEDED. The hiding predicate behind the
	 * aggregate line reads this (第五批: errors never fold) - a failed tool's
	 * collapsed ✗ row stays visible with its readable error, exactly as
	 * pre-U4; only successful work folds into the ⚙ line.
	 */
	isStepDone(toolCallId: string): boolean {
		const step = this.steps.find((candidate) => candidate.toolCallId === toolCallId);
		return step !== undefined && step.status === "done";
	}

	/** Failed steps in this turn; the aggregate line reports the count. */
	get errorStepCount(): number {
		return this.steps.filter((step) => step.status === "error").length;
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
		return `${(this.turnDurationMs() / 1000).toFixed(1)}s`;
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

	/** U6 ②: the process line — steps, duration, verb summary, error count. */
	summaryText(): string {
		const count = this.steps.length;
		if (count === 0) {
			return "";
		}
		const parts = [`⚙ ${count} 步 · ${this.durationSeconds()}`];
		// 第五批: the aggregate line reports its own failures - a collapsed turn
		// with a broken step shows ✗N beside the counts, so the error surface is
		// self-alarming even while the successful rows fold.
		if (this.errorStepCount > 0) {
			parts.push(theme.fg("error", `✗${this.errorStepCount}`));
		}
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
	/** TUI v4: render the one-line footnote instead of the legacy two-line surface. */
	private quiet = false;
	private footnote?: TurnFootNote;

	constructor(private readonly turnState: TurnActivityState) {}

	/** The turn's state - the per-turn lanes (K3 ②) live on it. */
	get state(): TurnActivityState {
		return this.turnState;
	}

	/** TUI v4 T12: forward the footnote's segment/caret click regions - the
	 * quiet face renders the footnote lines at offset zero, so the regions
	 * pass through unchanged. */
	getClickRegions(): ReadonlyArray<ClickRegion> {
		if (!this.quiet || !this.footnote) {
			return [];
		}
		return this.footnote.getClickRegions();
	}

	/** TUI v4: switch this turn head between the footnote and the legacy two lines. */
	setQuiet(quiet: boolean): void {
		if (this.quiet === quiet) {
			return;
		}
		this.quiet = quiet;
		this.invalidate();
	}

	/**
	 * TUI v4 T6: one more agent-to-agent comm inside the turn; the counter now
	 * lives on the turn state (both the live and replay paths feed it there).
	 */
	addCommMessage(): void {
		this.turnState.addCommMessage();
		this.invalidate();
	}

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
		// TUI v4: freeze only a fully settled turn - every step done AND the
		// end stamp landed. Comms and thinking can still grow between the last
		// settled step and the turn end, so `isSettled` alone would freeze the
		// quiet footnote too early.
		const settled = this.state.isSettled && this.state.isTurnEnded;
		if (this.cachedLines && this.cachedWidth === width && settled) {
			return this.cachedLines;
		}
		const safeWidth = Math.max(1, width);
		const lines = this.quiet ? this.renderFootNote(safeWidth) : this.renderLegacy(safeWidth);
		if (settled) {
			this.cachedWidth = width;
			this.cachedLines = lines;
		} else {
			// A live run keeps mutating; only the settled lines are cacheable.
			this.cachedWidth = undefined;
			this.cachedLines = undefined;
		}
		return lines;
	}

	/**
	 * TUI v4 quiet face: the two legacy lines collapse into the one-line
	 * footnote - `干了 1 分 05 秒 · 14 步 [O] · 想 7 段 [T] · → 通讯 2 条 [P]` -
	 * with the stats read live off the turn state (steps deduped by
	 * toolCallId, thinking segments, the comm counter, the frozen duration).
	 */
	private renderFootNote(safeWidth: number): string[] {
		this.footnote ??= new TurnFootNote({
			steps: 0,
			thinkSegments: 0,
			commMessages: 0,
			durationMs: 0,
			cols: safeWidth,
			// TUI v4 T12: clicking a segment opens exactly that block (the
			// three blocks stay independent); the caret flips all of them.
			onSegmentClick: (segment) => {
				if (segment === "think") {
					this.turnState.thinkingExpanded = !this.turnState.thinkingExpanded;
				} else if (segment === "steps") {
					this.turnState.setCollapsed(this.turnState.processBlockExpanded);
				} else {
					this.turnState.agentMessagesExpanded = !this.turnState.agentMessagesExpanded;
				}
				this.invalidate();
			},
			onCaretClick: () => {
				const anyOpen =
					this.turnState.thinkingBlockExpanded ||
					this.turnState.processBlockExpanded ||
					this.turnState.commsBlockExpanded;
				this.turnState.thinkingExpanded = false;
				this.turnState.agentMessagesExpanded = false;
				this.turnState.setCollapsed(anyOpen); // any open -> all closed; all closed -> all open
				this.invalidate();
			},
		});
		const steps = new Set(this.turnState.steps.map((step) => step.toolCallId)).size;
		const thinkSegments = this.turnState.totalThinkingSegments;
		const commMessages = this.turnState.commMessageCount;
		// R5-P2③: an all-zero turn still renders 想了想 - the model is always
		// reasoning, so a turn with no explicit thinking block counts as one
		// thought. The footnote component stays a pure props renderer; this
		// policy belongs to the wiring.
		const effectiveThinkSegments = steps === 0 && commMessages === 0 && thinkSegments === 0 ? 1 : thinkSegments;
		this.footnote.update({
			steps,
			thinkSegments: effectiveThinkSegments,
			commMessages,
			durationMs: this.turnState.turnDurationMs(),
			cols: safeWidth,
			// P3-2: the caret glyph — ▸ while every detail block is collapsed,
			// ▾ once any of the three blocks is open (the wiring owns the state).
			caret:
				this.turnState.thinkingBlockExpanded ||
				this.turnState.processBlockExpanded ||
				this.turnState.commsBlockExpanded
					? "▾"
					: "▸",
		});
		return this.footnote.render(safeWidth);
	}

	/**
	 * U6 two-line mechanical surface, both pinned at the turn head: the
	 * thinking block header (①, always visible while the turn has thinking)
	 * above the process line (②). No per-line expand hints — the single
	 * global hint line at the chat tail carries the key division.
	 */
	private renderLegacy(safeWidth: number): string[] {
		const textLines = [this.state.thinkingHeaderText(), this.state.summaryText()].filter((text) => text.length > 0);
		// F2 (DS2 review): one blank line between the two text lines, none
		// trailing each - the turn head is 3 lines for a full turn, 1 for a
		// thinking-only one, and the following content carries its own spacing.
		return textLines.flatMap((text, index) => {
			const rendered = [theme.fg("muted", truncateToWidth(` ${text}`, safeWidth, ""))];
			return index < textLines.length - 1 ? [...rendered, " ".repeat(safeWidth)] : rendered;
		});
	}
}

/** Rendered width of a summary line, for tests. */
export function turnSummaryVisibleWidth(state: TurnActivityState, width: number): number {
	return visibleWidth(new TurnSummaryComponent(state).render(width)[0] ?? "");
}
