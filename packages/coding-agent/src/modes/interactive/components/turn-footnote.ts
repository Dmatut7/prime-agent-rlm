import { type Component, type Keybinding, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

/**
 * TUI v4 quiet conversation (T2b): the per-turn footnote. One line under the
 * turn's final answer that carries all process stats the v4 conversation flow
 * removed - `干了 1 分 05 秒 · 14 步 [O] · 想 7 段 [T] · → 通讯 2 条 [P]` - with
 * the key hints in accent and the rest dim. Narrow screens (<100 columns,
 * R2.1: 100 exactly keeps the full form) switch to the compressed form
 * `干了 1分05秒 · 14步 · 7想 · 2讯`; a thinking-only turn shows `想了想`; an
 * all-zero turn renders nothing. When the line overflows, the key hints go
 * first, then the text truncates at the right edge by display columns
 * (CJK = 2 columns).
 */

/** Below this column count the footnote switches to the compressed narrow form (R2.1: the boundary itself stays wide). */
export const TURN_FOOT_NOTE_NARROW_COLS = 100;

/** Turn statistics the footnote summarizes; counts are non-negative, duration in ms. */
export interface TurnFootNoteProps {
	/** Tool-call steps in the turn. */
	steps: number;
	/** Thinking segments in the turn. */
	thinkSegments: number;
	/** Agent-to-agent comms in the turn (sent + received). */
	commMessages: number;
	/** Turn duration in milliseconds. */
	durationMs: number;
	/** Available terminal columns; the line truncates to this display width (CJK = 2 columns). */
	cols: number;
	/** Whether to render the [O]/[T]/[P] key hints (default true). Overwide lines drop them first. */
	showKeys?: boolean;
	/** Optional caret glyph (e.g. `▸`) prepended to the line; the wiring owns it. Default: none. */
	caret?: string;
}

/** One dot-separated piece of the footnote line. */
interface FootNoteSegment {
	/** Visible text of the segment, e.g. `14 步`. */
	text: string;
	/** Key hint suffix (wide form only), e.g. ` [O]`. */
	hint?: string;
}

/** Which app keybinding opens each footnote detail block (R2.2: no hardcoded key letters). */
const SEGMENT_KEYS = {
	steps: "app.tools.expand",
	think: "app.thinking.toggle",
	comm: "app.messages.expand",
} as const satisfies Record<string, Keybinding>;

/**
 * The bracket hint for one detail block: the final key part of the binding's
 * display name (`Ctrl+O` → ` [O]`), so a rebound key shows its real letter
 * instead of the shipped default. When keyText() resolves to nothing - the
 * keybindings manager is not installed yet (bare test environments) or the
 * key is unbound - the shipped default's literal letter is the fallback.
 */
function segmentHint(appKey: Keybinding, fallback: string): string {
	const display = keyText(appKey, { primaryOnly: true });
	const last = display.split("+").pop()?.trim() ?? "";
	return last ? ` [${last}]` : fallback;
}

/**
 * The duration segment in the three pinned tiers: `干了 45 秒` / `干了 1 分 05 秒`
 * / `干了 1 时 07 分` - minutes unpadded, seconds two digits; the narrow form
 * drops the inner spaces (`干了 45秒` / `干了 1分05秒` / `干了 1时07分`).
 */
export function turnFootNoteDurationText(durationMs: number, narrow: boolean): string {
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	if (totalSeconds < 60) {
		return narrow ? `干了 ${totalSeconds}秒` : `干了 ${totalSeconds} 秒`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		const seconds = String(totalSeconds % 60).padStart(2, "0");
		return narrow ? `干了 ${totalMinutes}分${seconds}秒` : `干了 ${totalMinutes} 分 ${seconds} 秒`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = String(totalMinutes % 60).padStart(2, "0");
	return narrow ? `干了 ${hours}时${minutes}分` : `干了 ${hours} 时 ${minutes} 分`;
}

export class TurnFootNote implements Component {
	private props: TurnFootNoteProps;
	private cachedCols: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(props: TurnFootNoteProps) {
		this.props = props;
	}

	/** Replace the stats (and columns/key flags); the next render recomputes the line. */
	update(props: TurnFootNoteProps): void {
		this.props = props;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedCols = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		// props.cols is the authoritative budget; a non-positive value falls
		// back to the viewport width the protocol passes in.
		const cols = this.props.cols > 0 ? Math.floor(this.props.cols) : Math.max(1, Math.floor(width));
		if (this.cachedLines && this.cachedCols === cols) {
			return this.cachedLines;
		}
		const lines = this.renderLine(cols);
		this.cachedCols = cols;
		this.cachedLines = lines;
		return lines;
	}

	private renderLine(cols: number): string[] {
		const { steps, thinkSegments, commMessages, durationMs } = this.props;
		if (steps <= 0 && thinkSegments <= 0 && commMessages <= 0) {
			return [];
		}
		const narrow = cols < TURN_FOOT_NOTE_NARROW_COLS;
		// 空态: thinking only - no counts, no keys, no duration, just 想了想.
		const segments: FootNoteSegment[] =
			steps <= 0 && commMessages <= 0
				? [{ text: "想了想" }]
				: this.buildSegments(steps, thinkSegments, commMessages, durationMs, narrow);
		const caret = this.props.caret ?? "";
		const budget = Math.max(1, cols - visibleWidth(caret));
		return [caret + this.fitSegments(segments, narrow, budget)];
	}

	/**
	 * The normal-form segments: duration first, then steps [O], thinking [T],
	 * comms [P] - zero-value segments are omitted entirely, mirroring the
	 * TurnActivity convention that empty means invisible.
	 */
	private buildSegments(
		steps: number,
		thinkSegments: number,
		commMessages: number,
		durationMs: number,
		narrow: boolean,
	): FootNoteSegment[] {
		const segments: FootNoteSegment[] = [{ text: turnFootNoteDurationText(durationMs, narrow) }];
		if (steps > 0) {
			segments.push({ text: narrow ? `${steps}步` : `${steps} 步`, hint: segmentHint(SEGMENT_KEYS.steps, " [O]") });
		}
		if (thinkSegments > 0) {
			segments.push({
				text: narrow ? `${thinkSegments}想` : `想 ${thinkSegments} 段`,
				hint: segmentHint(SEGMENT_KEYS.think, " [T]"),
			});
		}
		if (commMessages > 0) {
			segments.push({
				text: narrow ? `${commMessages}讯` : `→ 通讯 ${commMessages} 条`,
				hint: segmentHint(SEGMENT_KEYS.comm, " [P]"),
			});
		}
		return segments;
	}

	/**
	 * Fit the segments into the budget: keep the key hints if the full line
	 * fits, drop every hint if the bare line fits, otherwise truncate the bare
	 * line from the right with an ellipsis. The width math is display columns
	 * (CJK = 2), never character counts.
	 */
	private fitSegments(segments: FootNoteSegment[], narrow: boolean, budget: number): string {
		const joiner = " · ";
		const showKeys = this.props.showKeys !== false && !narrow;
		const plain = segments.map((s) => s.text + (showKeys && s.hint ? s.hint : "")).join(joiner);
		if (visibleWidth(plain) <= budget) {
			return segments
				.map((s) => theme.fg("dim", s.text) + (showKeys && s.hint ? theme.fg("accent", s.hint) : ""))
				.join(theme.fg("dim", joiner));
		}
		const bare = segments.map((s) => s.text).join(joiner);
		if (visibleWidth(bare) > budget) {
			return theme.fg("dim", truncateToWidth(bare, budget, "…"));
		}
		return theme.fg("dim", bare);
	}
}
