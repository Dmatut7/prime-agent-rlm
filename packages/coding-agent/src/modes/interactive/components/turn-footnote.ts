import {
	type ClickRegion,
	type Component,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import type { FileChangeSummary } from "./edit-summary.js";
import { keyText } from "./keybinding-hints.js";

/**
 * The per-turn process line: one line at the turn head that says what the
 * turn did, in plain words -
 * `▸ Thinking 6.2s · 5 步 · 14.8s   运行 npm check · 写入 footer.ts` - followed, while
 * the process block is closed, by one row per changed file
 * (`   改动 src/footer.ts  +3 −5`), so edits stay visible without expanding.
 * Stats render muted, the plain-words summary dim; the summary drops first
 * when the line overflows. A thinking-only turn reads `▸ Thinking 3.2s`; an
 * all-zero turn renders nothing.
 */

/** The caret glyphs: ▸ while every detail block is collapsed, ▾ once any block is open. */
export const TURN_FOOT_NOTE_CARETS = { collapsed: "▸", expanded: "▾" } as const;

/** Changed-file rows shown under a closed process line before the rest fold into one count row. */
export const TURN_FOOT_NOTE_MAX_FILE_ROWS = 5;

/** Rows the open process block gives the latest thinking trace. */
const THINKING_PREVIEW_ROWS = 2;

/** Narrowest room left for the plain-words summary before it drops entirely. */
const SUMMARY_MIN_WIDTH = 12;

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
	/** Plain-words summary of the steps (`运行 npm check · 读取 footer.ts`). */
	summary?: string;
	/** Files the turn changed, with display paths; rendered as rows under the line. */
	fileChanges?: readonly FileChangeSummary[];
	/** Measured thinking time; undefined when unknown (the `Thinking` segment then drops). */
	thinkingMs?: number;
	/** The latest thinking trace, shown as a two-row preview under the line while the block is open. */
	thinkingPreview?: string;
	/** The turn is still running: the line reads `运行中 · 第 N 步 · 16s` with an accent caret. */
	running?: boolean;
	/** Optional caret glyph (▸/▾) rendered in the line's indent column; the wiring owns the state. Default: none. */
	caret?: string;
	/** Fired with the lane id when a stats segment is clicked. Zero-value segments never render and so never fire. */
	onSegmentClick?: (segment: TurnFootNoteSegment) => void;
	/** Optional caret-click handler - the caret glyph's own click lane. */
	onCaretClick?: () => void;
}

/** The footnote's clickable stats segments. */
export type TurnFootNoteSegment = "steps" | "think" | "comm";

interface FootNoteSegment {
	text: string;
	clickTarget?: TurnFootNoteSegment;
}

/** Compact turn duration: `14.8s`, `1m05s`, `1h07m`. */
export function turnFootNoteDurationText(durationMs: number): string {
	const ms = Math.max(0, durationMs);
	if (ms < 59_950) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const totalSeconds = Math.round(ms / 1000);
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
	}
	return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

/** Keep a path's tail readable: `…/scratchpad/shop.md` beats a head cut mid-segment. */
function shortenPath(path: string, width: number): string {
	if (visibleWidth(path) <= width) {
		return path;
	}
	const parts = path.split("/").filter((part) => part.length > 0);
	// An absolute path outside the project reads best as its last two segments.
	const maxKeep = path.startsWith("/") ? Math.min(2, parts.length - 1) : parts.length - 1;
	for (let keep = maxKeep; keep >= 1; keep--) {
		const candidate = `…/${parts.slice(-keep).join("/")}`;
		if (visibleWidth(candidate) <= width) {
			return candidate;
		}
	}
	return truncateToWidth(parts.at(-1) ?? path, width, "…");
}

/** A running turn's clock in whole seconds: `16s`, `1m 05s` (matches the status line). */
export function turnRunningClockText(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
	}
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

interface FootNoteSpan {
	segment: TurnFootNoteSegment;
	col: number;
	width: number;
}

const JOINER = " · ";
const SUMMARY_GAP = "   ";

export class TurnFootNote implements Component {
	private props: TurnFootNoteProps;
	private cachedCols: number | undefined;
	private cachedLines: string[] | undefined;
	private clickRegions: ClickRegion[] = [];

	constructor(props: TurnFootNoteProps) {
		this.props = props;
	}

	/** Click regions from the last render(): one per rendered stats segment, plus the caret. */
	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.clickRegions;
	}

	update(props: TurnFootNoteProps): void {
		this.props = props;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedCols = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const cols = this.props.cols > 0 ? Math.floor(this.props.cols) : Math.max(1, Math.floor(width));
		if (this.cachedLines && this.cachedCols === cols) {
			return this.cachedLines;
		}
		const lines = this.renderLines(cols);
		this.cachedCols = cols;
		this.cachedLines = lines;
		return lines;
	}

	private renderLines(cols: number): string[] {
		const { steps, thinkSegments, commMessages } = this.props;
		if (steps <= 0 && thinkSegments <= 0 && commMessages <= 0) {
			this.clickRegions = [];
			return [];
		}
		const caret = this.props.caret ?? "";
		const indent = caret !== "" ? ` ${caret} ` : " ";
		const indentWidth = visibleWidth(indent);
		if (indentWidth >= cols) {
			this.clickRegions = [];
			return [theme.fg("dim", truncateToWidth(indent, cols, ""))];
		}
		const styledIndent = caret !== "" ? ` ${theme.fg(this.props.running ? "accent" : "dim", caret)} ` : " ";
		const segments = this.buildSegments();
		const statsPlain = segments.map((segment) => segment.text).join(JOINER);
		const budget = cols - indentWidth;
		let line: string;
		if (visibleWidth(statsPlain) > budget) {
			line = theme.fg("muted", truncateToWidth(statsPlain, budget, "…"));
		} else {
			line = theme.fg("muted", statsPlain);
			const summary = this.props.summary?.trim();
			const summaryBudget = budget - visibleWidth(statsPlain) - SUMMARY_GAP.length;
			if (summary && summaryBudget >= SUMMARY_MIN_WIDTH) {
				line += `${SUMMARY_GAP}${theme.fg("dim", truncateToWidth(summary, summaryBudget, "…"))}`;
			}
		}
		this.clickRegions = [
			...this.caretRegions(caret),
			...this.segmentRegions(this.segmentSpans(segments, budget), indentWidth),
		];
		return [styledIndent + line, ...this.thinkingPreviewRows(cols), ...this.fileChangeRows(cols)];
	}

	private buildSegments(): FootNoteSegment[] {
		const { steps, thinkSegments, commMessages, durationMs } = this.props;
		const segments: FootNoteSegment[] = [];
		if (this.props.running) {
			segments.push({ text: "运行中" });
			if (steps > 0) {
				segments.push({ text: `第 ${steps} 步`, clickTarget: "steps" });
			}
			// Whole seconds, the same clock the status line shows.
			segments.push({ text: turnRunningClockText(durationMs) });
			return segments;
		}
		const thinkingMs = this.props.thinkingMs;
		if (steps <= 0 && commMessages <= 0) {
			// An answer-only turn: its whole span is the model thinking and writing.
			segments.push({
				text: `Thinking ${turnFootNoteDurationText(thinkingMs ?? durationMs)}`,
				clickTarget: "think",
			});
			return segments;
		}
		if (thinkSegments > 0 && thinkingMs !== undefined && thinkingMs >= 50) {
			segments.push({ text: `Thinking ${turnFootNoteDurationText(thinkingMs)}`, clickTarget: "think" });
		}
		if (steps > 0) {
			segments.push({ text: `${steps} 步`, clickTarget: "steps" });
		}
		// The last figure is the turn's total, not more thinking time.
		segments.push({
			text: steps > 0 ? `共 ${turnFootNoteDurationText(durationMs)}` : turnFootNoteDurationText(durationMs),
		});
		if (commMessages > 0) {
			segments.push({ text: `通讯 ${commMessages} 条`, clickTarget: "comm" });
		}
		return segments;
	}

	private thinkingPreviewRows(cols: number): string[] {
		const preview = this.props.thinkingPreview?.replace(/\s+/g, " ").trim();
		if (!preview) {
			return [];
		}
		const label = `   ${theme.fg("dim", "Thinking")}  `;
		const indent = " ".repeat(visibleWidth(label));
		const hint = keyText("app.thinking.toggle", { primaryOnly: true });
		const hintText = hint ? `  ${hint} 全文` : "";
		const width = Math.max(8, cols - visibleWidth(label) - visibleWidth(hintText));
		const wrapped = wrapTextWithAnsi(preview, width);
		const shown = wrapped.slice(0, THINKING_PREVIEW_ROWS);
		if (wrapped.length > shown.length && shown.length > 0) {
			shown[shown.length - 1] = truncateToWidth(`${shown.at(-1)}…`, width, "…");
		}
		return shown.map((row, index) => {
			const body = theme.italic(theme.fg("dim", row));
			const tail = index === shown.length - 1 ? theme.fg("dim", hintText) : "";
			return truncateToWidth(`${index === 0 ? label : indent}${body}${tail}`, cols, "");
		});
	}

	private fileChangeRows(cols: number): string[] {
		const changes = this.props.fileChanges ?? [];
		if (changes.length === 0) {
			return [];
		}
		const rows: string[] = [];
		const shown = changes.length > TURN_FOOT_NOTE_MAX_FILE_ROWS ? TURN_FOOT_NOTE_MAX_FILE_ROWS - 1 : changes.length;
		for (const change of changes.slice(0, shown)) {
			const prefix = `   ${theme.fg("dim", "改动")}  `;
			const counts = `  ${theme.fg("toolDiffAdded", `+${change.added}`)} ${theme.fg("toolDiffRemoved", `−${change.removed}`)}`;
			const available = Math.max(1, cols - visibleWidth(prefix) - visibleWidth(counts));
			const path = theme.fg("muted", shortenPath(change.path, available));
			rows.push(truncateToWidth(`${prefix}${path}${counts}`, cols, ""));
		}
		if (shown < changes.length) {
			rows.push(theme.fg("dim", truncateToWidth(`   … 还有 ${changes.length - shown} 个文件`, cols, "")));
		}
		return rows;
	}

	private caretRegions(caret: string): ClickRegion[] {
		const onCaretClick = this.props.onCaretClick;
		if (!onCaretClick || caret === "") {
			return [];
		}
		return [{ line: 0, col: 0, width: visibleWidth(caret) + 1, height: 1, onClick: () => onCaretClick() }];
	}

	private segmentRegions(spans: FootNoteSpan[], indentWidth: number): ClickRegion[] {
		const onSegmentClick = this.props.onSegmentClick;
		if (!onSegmentClick) {
			return [];
		}
		return spans.map((span) => ({
			line: 0,
			col: indentWidth + span.col,
			width: span.width,
			height: 1,
			onClick: () => onSegmentClick(span.segment),
		}));
	}

	/** Clickable stats spans in body coordinates, clipped to the budget. */
	private segmentSpans(segments: FootNoteSegment[], budget: number): FootNoteSpan[] {
		const spans: FootNoteSpan[] = [];
		let cursor = 0;
		for (let index = 0; index < segments.length; index++) {
			if (index > 0) {
				cursor += JOINER.length;
			}
			const segment = segments[index];
			const width = visibleWidth(segment?.text ?? "");
			if (segment?.clickTarget && width > 0) {
				const start = Math.min(cursor, budget);
				const end = Math.min(cursor + width, budget);
				if (end > start) {
					spans.push({ segment: segment.clickTarget, col: start, width: end - start });
				}
			}
			cursor += width;
		}
		return spans;
	}
}
