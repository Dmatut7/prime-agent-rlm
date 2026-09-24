import { type ClickRegion, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { getSpinnerTick } from "../theme/working-icon.js";
import { type BlockFocusState, decorateFocusedBlock, type FocusableBlock } from "./block-focus.js";
import type { FileChangeSummary } from "./edit-summary.js";
import { ASSISTANT_GUTTER_WIDTH, assistantGutter, renderAssistantHeader, renderRunningCard } from "./running-card.js";
import { turnStepsSummary } from "./step-label.js";
import { TurnFootNote } from "./turn-footnote.js";

export type TurnStepStatus = "queued" | "running" | "done" | "error";

/** What the model is doing between tool steps. */
export type TurnPhase = "waiting" | "thinking" | "writing";

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
		this.phaseSince = startedAt;
		this.lastActivityAt = startedAt;
	}

	/** Set on the live run's turn: its clock ticks until agent_end stamps it. */
	live = false;

	/** The model answering this turn (`glm-5.3-prime`), for the `◆ prime` header. */
	modelId: string | undefined;

	private phase: TurnPhase = "waiting";
	private phaseSince: number;
	private lastActivityAt: number;
	private readonly stepStartedAt = new Map<string, number>();
	private currentThinkingText = "";

	/**
	 * What the model itself is doing between steps: waiting for the reply to
	 * start, thinking, or writing. A change restarts the phase clock; any call
	 * counts as fresh output for the quiet-step warning.
	 */
	notePhase(phase: TurnPhase, now = Date.now()): void {
		if (phase !== this.phase) {
			this.phase = phase;
			this.phaseSince = now;
		}
		this.lastActivityAt = now;
	}

	/** Something new came out (a tool update, a stream delta): the quiet clock restarts. */
	noteActivity(now = Date.now()): void {
		this.lastActivityAt = now;
	}

	get currentPhase(): TurnPhase {
		return this.phase;
	}

	get phaseStartedAt(): number {
		return this.phaseSince;
	}

	get lastActivity(): number {
		return this.lastActivityAt;
	}

	/** When the step started running (undefined until it does). */
	stepStartTime(toolCallId: string): number | undefined {
		return this.stepStartedAt.get(toolCallId);
	}

	/** The thinking trace streaming right now (the latest, unlike {@link latestThinking}). */
	get currentThinking(): string {
		return this.currentThinkingText;
	}
	set currentThinking(text: string) {
		if (text) this.currentThinkingText = text;
	}

	private previewThinking = "";
	/**
	 * The turn's first thinking trace (what the model planned), for the open
	 * process block's preview. Assignments keep the first trace: a value that
	 * extends it (the same trace still streaming) replaces it, anything else is
	 * a later trace and is ignored.
	 */
	get latestThinking(): string {
		return this.previewThinking;
	}
	set latestThinking(text: string) {
		if (!text) return;
		if (!this.previewThinking || text.startsWith(this.previewThinking)) {
			this.previewThinking = text;
		}
	}
	private thinkingMs = 0;
	private thinkingStartedAt: number | undefined;
	private thinkingMeasured = false;

	/** Live streams report whether the model is thinking right now; the time accumulates. */
	noteThinking(active: boolean, now = Date.now()): void {
		if (active) {
			this.thinkingMeasured = true;
			this.thinkingStartedAt ??= now;
			return;
		}
		if (this.thinkingStartedAt !== undefined) {
			this.thinkingMs += Math.max(0, now - this.thinkingStartedAt);
			this.thinkingStartedAt = undefined;
		}
	}

	/** Measured thinking time; undefined when the turn was not watched live (a replay). */
	thinkingDurationMs(now = Date.now()): number | undefined {
		if (!this.thinkingMeasured) {
			return undefined;
		}
		return this.thinkingMs + (this.thinkingStartedAt !== undefined ? Math.max(0, now - this.thinkingStartedAt) : 0);
	}

	/** Files the turn changed, keyed by path; the collapsed process line lists them. */
	private readonly changedFiles = new Map<string, FileChangeSummary>();

	addFileChanges(changes: readonly FileChangeSummary[]): void {
		for (const change of changes) {
			if (change.added === 0 && change.removed === 0) {
				continue;
			}
			const existing = this.changedFiles.get(change.path);
			if (existing) {
				existing.added += change.added;
				existing.removed += change.removed;
			} else {
				this.changedFiles.set(change.path, { ...change });
			}
		}
	}

	get fileChanges(): readonly FileChangeSummary[] {
		return [...this.changedFiles.values()];
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

	/** Streaming tool calls grow their arguments; the step labels read the latest ones. */
	updateStepArgs(toolCallId: string, args: unknown): void {
		for (let i = 0; i < this.steps.length; i++) {
			const step = this.steps[i];
			if (step?.toolCallId === toolCallId && step.args !== args) {
				this.steps[i] = { ...step, args };
			}
		}
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
	/** Whether the key-steps fold is armed (it only shows while the block is open and long). */
	get processKeyStepsArmed(): boolean {
		return this.processKeySteps;
	}
	/** Lift or re-arm the key-steps fold (the wiring owns the key cycle). */
	setProcessKeySteps(keySteps: boolean): void {
		this.processKeySteps = keySteps;
	}
	/** Distinct tool calls in the turn. */
	get stepCount(): number {
		return this.dedupedStepCount();
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
	turnDurationMs(now = Date.now()): number {
		// A running turn's clock keeps ticking; a settled tool turn freezes on its
		// last settled step, a thinking-only turn on the turn-end stamp.
		// A live turn keeps ticking between steps too (the model thinks there);
		// only the end stamp freezes it.
		const running = this.turnEndedAt === undefined && (this.steps.length === 0 || !this.isSettled || this.live);
		// A live turn ends on its real end stamp, so the clock never jumps back;
		// a replayed one freezes on its last settled step (its end stamp is the
		// next prompt's time, which includes idle).
		const end = running
			? now
			: this.live && this.turnEndedAt !== undefined
				? this.turnEndedAt
				: this.steps.length > 0
					? (this.lastSettledAt ?? this.turnEndedAt ?? now)
					: (this.turnEndedAt ?? now);
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
		if (status === "running" && !this.stepStartedAt.has(toolCallId)) {
			this.stepStartedAt.set(toolCallId, timestamp);
		}
		if (status !== "queued") {
			this.lastActivityAt = Math.max(this.lastActivityAt, timestamp);
		}
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
			// The wait for the model's reply starts when the step hands back, not
			// when the model asked for the step.
			if (this.phase === "waiting") this.phaseSince = Math.max(this.phaseSince, timestamp);
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
			return `Thinking ×${segments}`;
		}
		return segments > 1 ? `Thinking ×${segments} · ${this.durationSeconds()}` : `Thinking ${this.durationSeconds()}`;
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

export class TurnSummaryComponent implements Component, FocusableBlock {
	private blockFocus?: BlockFocusState;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private cachedLaneKey?: string;
	/** TUI v4: render the one-line footnote instead of the legacy two-line surface. */
	private quiet = false;
	private footnote?: TurnFootNote;
	/** Told after a click flipped a lane, so the host applies it to the turn's rows. */
	private onLanesChange?: () => void;

	constructor(private readonly turnState: TurnActivityState) {}

	setOnLanesChange(callback: (() => void) | undefined): void {
		this.onLanesChange = callback;
	}

	/** The turn's state - the per-turn lanes (K3 ②) live on it. */
	get state(): TurnActivityState {
		return this.turnState;
	}

	/** TUI v4 T12: forward the footnote's segment/caret click regions - the
	 * quiet face renders the footnote lines at offset zero, so the regions
	 * pass through unchanged. */
	getClickRegions(): ReadonlyArray<ClickRegion> {
		if (!this.quiet) {
			return [];
		}
		// v3: the `◆ prime` header opens or closes the turn's process; the
		// footnote's own regions sit one row down, after the gutter.
		const header: ClickRegion = {
			line: 0,
			col: 0,
			width: 9,
			height: 1,
			onClick: () => this.toggleAllBlocks(),
		};
		if (!this.turnState.isTurnEnded || !this.footnote) {
			return [header];
		}
		return [
			header,
			...this.footnote.getClickRegions().map((region) => ({
				...region,
				line: region.line + 1,
				col: region.col + ASSISTANT_GUTTER_WIDTH,
			})),
		];
	}

	/** Any block open -> all closed; all closed -> the process block open. */
	private toggleAllBlocks(): void {
		const anyOpen =
			this.turnState.thinkingBlockExpanded ||
			this.turnState.processBlockExpanded ||
			this.turnState.commsBlockExpanded;
		this.turnState.thinkingExpanded = false;
		this.turnState.agentMessagesExpanded = false;
		this.turnState.setCollapsed(anyOpen);
		this.invalidate();
		this.onLanesChange?.();
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

	/** The process block's open state lives on the turn state alone, so a click and Ctrl+O never disagree. */
	setExpanded(expanded: boolean): void {
		if (this.state.processBlockExpanded === expanded) {
			return;
		}
		this.state.setCollapsed(!expanded);
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const lines = this.renderTurnHead(width);
		return this.blockFocus && lines.length > 0 ? decorateFocusedBlock(lines, width, this.blockFocus) : lines;
	}

	setBlockFocus(state: BlockFocusState | undefined): void {
		this.blockFocus = state;
	}

	/** The process line and its rows as plain text. */
	getBlockCopyText(): string {
		return this.renderTurnHead(120)
			.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
			.filter((line) => line.trim().length > 0)
			.join("\n");
	}

	private renderTurnHead(width: number): string[] {
		// TUI v4: freeze only a fully settled turn - every step done AND the
		// end stamp landed. Comms and thinking can still grow between the last
		// settled step and the turn end, so `isSettled` alone would freeze the
		// quiet footnote too early.
		const settled = this.state.isSettled && this.state.isTurnEnded;
		// The caret, preview and file rows follow the lanes, so a lane flip
		// must rebuild even a frozen turn.
		const laneKey = [
			this.quiet,
			this.state.thinkingBlockExpanded,
			this.state.processBlockExpanded,
			this.state.commsBlockExpanded,
			this.state.processKeyStepsArmed,
			this.state.commMessageCount,
		].join(",");
		if (this.cachedLines && this.cachedWidth === width && settled && this.cachedLaneKey === laneKey) {
			return this.cachedLines;
		}
		const safeWidth = Math.max(1, width);
		const lines = this.quiet ? this.renderFootNote(safeWidth) : this.renderLegacy(safeWidth);
		if (settled) {
			this.cachedWidth = width;
			this.cachedLines = lines;
			this.cachedLaneKey = laneKey;
		} else {
			// A live run keeps mutating; only the settled lines are cacheable.
			this.cachedWidth = undefined;
			this.cachedLines = undefined;
		}
		return lines;
	}

	/**
	 * Quiet face: the process line - `▸ 思考 · 14 步 · 1m05s   运行 npm check`
	 * - with the stats read live off the turn state (steps deduped by
	 * toolCallId, thinking segments, the comm counter, the frozen duration),
	 * plus one row per changed file while the process block is closed.
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
				this.onLanesChange?.();
			},
			onCaretClick: () => this.toggleAllBlocks(),
		});
		const live = !this.turnState.isTurnEnded;
		const header = renderAssistantHeader({
			...(this.turnState.modelId ? { modelId: this.turnState.modelId } : {}),
			durationMs: this.turnState.turnDurationMs(),
			live,
			tick: getSpinnerTick(),
			width: safeWidth,
		});
		// v3: a live turn is the running card under the header - what the AI is
		// doing now; the step list stays one Ctrl+O away, exactly as before.
		if (live) {
			return [header, ...renderRunningCard(this.turnState, safeWidth, getSpinnerTick())];
		}
		const bodyWidth = Math.max(1, safeWidth - ASSISTANT_GUTTER_WIDTH);
		const steps = new Set(this.turnState.steps.map((step) => step.toolCallId)).size;
		const thinkSegments = this.turnState.totalThinkingSegments;
		const commMessages = this.turnState.commMessageCount;
		// R5-P2③: an all-zero turn still renders 思考 - the model is always
		// reasoning, so a turn with no explicit thinking block counts as one
		// thought. The footnote component stays a pure props renderer; this
		// policy belongs to the wiring.
		const effectiveThinkSegments = steps === 0 && commMessages === 0 && thinkSegments === 0 ? 1 : thinkSegments;
		this.footnote.update({
			steps,
			thinkSegments: effectiveThinkSegments,
			commMessages,
			durationMs: this.turnState.turnDurationMs(),
			cols: bodyWidth,
			summary: turnStepsSummary(this.turnState.steps),
			headerCarriesDuration: true,
			thinkingMs: this.turnState.thinkingDurationMs(),
			// The preview stands in for the trace; with the trace open (Ctrl+T) it would repeat it.
			thinkingPreview:
				this.turnState.processBlockExpanded && !this.turnState.thinkingBlockExpanded
					? this.turnState.latestThinking
					: undefined,
			// An open process block shows every diff itself; the rows are the closed view's stand-in.
			fileChanges: this.turnState.processBlockExpanded ? [] : this.turnState.fileChanges,
			// P3-2: the caret glyph — ▸ while every detail block is collapsed,
			// ▾ once any of the three blocks is open (the wiring owns the state).
			caret:
				this.turnState.thinkingBlockExpanded ||
				this.turnState.processBlockExpanded ||
				// The comms lane opens nothing in a turn without comms.
				(this.turnState.commsBlockExpanded && commMessages > 0)
					? "▾"
					: "▸",
		});
		const gutter = assistantGutter();
		return [header, ...this.footnote.render(bodyWidth).map((line) => `${gutter}${line}`)];
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
