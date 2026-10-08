/**
 * Fullscreen (alternate-screen) viewport: a scrollable window over the
 * transcript with a dock (editor/footer) pinned to the bottom rows. Frames
 * are a fixed grid painted with absolute addressing and diffed row-by-row;
 * scroll position is application state, not terminal scrollback.
 */

import type { ClickRegion, StickyHeader } from "./click-regions.js";
import { contentStartColumn, type TableCellSelectionRegion } from "./selection-metadata.js";
import {
	extractKittyPlaceholderImageId,
	isImageLine,
	isImageSequenceLine,
	KITTY_PLACEHOLDER_CHAR,
	KITTY_PLACEHOLDER_COPY_MARKER,
} from "./terminal-image.js";
import {
	clampOverwideLine,
	normalizeTerminalOutput,
	sliceByColumn,
	stripAnsi,
	urlAtColumn,
	visibleWidth,
} from "./utils.js";

export const FULLSCREEN_MIN_TRANSCRIPT_ROWS = 3;

/** Most rows a sticky header may keep painted over the top of the transcript window. */
export const FULLSCREEN_MAX_STICKY_ROWS = 3;

export function clippedFullscreenDockHeight(dockLength: number, height: number): number {
	const maxDock = Math.max(0, height - FULLSCREEN_MIN_TRANSCRIPT_ROWS);
	return Math.min(dockLength, maxDock);
}

// Inline graphics sequences span multiple physical rows and cannot be clipped
// to a window. Kitty Unicode placeholder rows are plain text cells and pass
// through: the terminal clips them like any other text.
const IMAGE_PLACEHOLDER = "\x1b[2m[image — view in inline mode]\x1b[0m";

export interface ScrollInfo {
	following: boolean;
	linesBelow: number;
	linesAbove: number;
	/** Transcript rows appended while the window was paused and still below it. */
	unseenBelow: number;
	/** Transcript rows the window shows. */
	windowHeight: number;
}

export type SelectionScrollDirection = -1 | 1;

// Transcript-anchored selection endpoint (line index + visible column), so
// streaming appends and scrolling never shift what is selected.
interface SelectionPoint {
	line: number;
	col: number;
}

interface FrameSelectionRegion {
	line: number;
	col: number;
	width: number;
}

/**
 * A click region projected onto visible frame rows. The hit rect may be
 * narrower than `region` when overlay pixels cover it or the region is
 * clipped at a viewport edge; click positions stay relative to `anchor`,
 * the frame row of the region's top line even when that row is clipped away.
 */
export interface FrameClickTarget {
	/** Frame row this target occupies. */
	row: number;
	col: number;
	width: number;
	anchor: number;
	region: ClickRegion;
}

/** Visible frame rows of a projected region: hit rows plus the position anchor. */
export interface ProjectedRegionRows {
	anchor: number;
	from: number;
	count: number;
}

/** The rows of a sticky header painted over the top of the transcript window in the last frame. */
export interface PinnedRows {
	/** Frame row of the first pinned row. */
	firstRow: number;
	count: number;
	regions: ReadonlyArray<ClickRegion>;
}

interface PinnedHeader {
	header: StickyHeader;
	rows: string[];
}

/** A region projected onto the frame: the region plus its visible hit rows. */
export interface FrameClickEntry extends ProjectedRegionRows {
	region: ClickRegion;
}

interface ColumnSpan {
	from: number;
	to: number;
}

interface FrameSelectionSnapshot {
	frame: string[];
	regions: FrameSelectionRegion[];
	visibleStart: number;
	visibleHeight: number;
}

interface TableCellPosition {
	row: number;
	column: number;
}

interface ActiveTableSelection {
	table: object;
	anchor: TableCellPosition;
}

interface TableSelectionRange {
	fromRow: number;
	toRow: number;
	fromColumn: number;
	toColumn: number;
}

type SelectionMode = "transcript" | "table" | "frame";

export class FullscreenViewport {
	private scrollTop = 0;
	private following = true;
	/** Transcript rows appended since the window paused; reset when following resumes. */
	private unseenLines = 0;
	/** A zero-width marker every frame strips; its row is scrolled into view once per request. */
	private revealMarker: string | undefined;
	/** Set by {@link setRevealMarker}; cleared once a frame has placed the marked row. */
	private revealPending = false;
	/**
	 * A click just changed the rows below the clicked transcript line; the next frame keeps that line put.
	 * `boxEndLine` is set for a click on a pinned header: the line is then brought back into view
	 * only when the box no longer reaches that far.
	 */
	private clickHold: { line: number; revealBelow: number; boxEndLine?: number } | undefined;
	/**
	 * Frame row the "back to bottom" hint painted over in the last render, or
	 * null. That row's transcript line is hidden by the hint, so it is excluded
	 * from the selectable bounds - a selection must not copy text the user
	 * cannot see.
	 */
	private followHintRow: number | null = null;
	private prevFrame: string[] = [];
	private prevWidth = 0;
	private prevHeight = 0;
	private lastMaxScroll = 0;
	private lastWindowHeight = 0;
	private lastHeaderHeight = 0;
	private lastHeaderLines = 0;
	private lastDockLines = 0;
	private lastDockHeight = 0;
	private stickyHeaders: ReadonlyArray<StickyHeader> = [];
	private stickyWidth = 0;
	private lastPinned: PinnedHeader | null = null;
	private frameClickTargets: FrameClickTarget[] = [];
	private lastTranscript: string[] = [];
	/**
	 * The last frame before selection highlights and line resets were applied.
	 * Drag snapshots must compare raw rows: lastFrame is mutated in place by
	 * applyFrameSelection's own highlights and by the paint path's per-line
	 * reset suffix, so a fresh composed frame never string-equals it.
	 */
	private lastRawFrame: string[] = [];
	/**
	 * Rows prepended above the window since the last composed frame (a backfilled
	 * history page), announced through {@link noteTranscriptPrepend}. Consumed by
	 * the next frame: the paused window shifts down with the page and the page
	 * never counts as new content below.
	 */
	private prependedLines = 0;
	private lastFrame: string[] = [];
	private lastFrameVisibleStart = 0;
	private lastFrameVisibleHeight = 0;
	private frameSelectionRegions: ReadonlyArray<FrameSelectionRegion> = [];
	private tableCellSelectionRegions: ReadonlyArray<TableCellSelectionRegion> = [];
	private activeFrameSelection: FrameSelectionSnapshot | null = null;
	private activeTableSelection: ActiveTableSelection | null = null;
	private selectionAnchor: SelectionPoint | null = null;
	private selectionHead: SelectionPoint | null = null;
	private selectionMode: SelectionMode | null = null;

	/**
	 * Compose a frame of exactly `height` lines: an optional pinned header on
	 * top, the scrolled transcript window in the middle, and the dock pinned
	 * to the bottom. Following pins the window to the transcript end;
	 * otherwise it stays frozen while content appends.
	 */
	composeFrame(
		transcript: string[],
		dock: string[],
		height: number,
		tableCellSelectionRegions: ReadonlyArray<TableCellSelectionRegion> = [],
		header?: string[],
	): string[] {
		let dockLines = dock;
		const dockHeight = clippedFullscreenDockHeight(dockLines.length, height);
		if (dockLines.length > dockHeight) {
			dockLines = dockLines.slice(dockLines.length - dockHeight);
		}
		let headerLines = header ?? [];
		// Header rows are taken away from the transcript window, never from the
		// dock; a too-tall header is clipped from the top like the dock clips
		// from its bottom, so the bar keeps its bottom rows.
		const maxHeader = Math.max(0, height - dockLines.length - FULLSCREEN_MIN_TRANSCRIPT_ROWS);
		const headerHeight = Math.min(headerLines.length, maxHeader);
		if (headerLines.length > headerHeight) {
			headerLines = headerLines.slice(headerLines.length - headerHeight);
		}
		const windowHeight = height - dockLines.length - headerLines.length;
		const maxScroll = Math.max(0, transcript.length - windowHeight);

		// A page prepended above the window (announced since the last frame) shifts
		// every row down: the paused window follows its rows. Applied here, where
		// maxScroll already carries the page - scrollBy() before this frame clamps
		// against the stale maxScroll and snaps a near-bottom paused window back to
		// following. A following window stays glued to the end, nothing to do.
		const prepended = this.prependedLines;
		this.prependedLines = 0;
		if (this.following) {
			this.scrollTop = maxScroll;
		} else {
			this.scrollTop = Math.max(0, Math.min(this.scrollTop + prepended, maxScroll));
		}
		const hold = this.clickHold;
		if (hold && prepended > 0) {
			// The hold's line indexes are pre-prepend coordinates: every
			// screen-to-line mapping between the prepend and this frame used the
			// stale transcript, so shift the hold with the page it belongs to.
			hold.line += prepended;
			if (hold.boxEndLine !== undefined) hold.boxEndLine += prepended;
		}
		if (hold) {
			// The clicked row and everything above it are unchanged, so the same
			// scroll offset keeps it on the same screen row. Only the rows the click
			// opened below it may pull the window down, and never past the clicked row.
			this.clickHold = undefined;
			const boxEndLine = hold.boxEndLine;
			const boxKept =
				boxEndLine !== undefined &&
				this.stickyHeaders.some((header) => header.line === hold.line && header.endLine >= boxEndLine);
			if (!boxKept) {
				this.scrollTop = this.revealBelow(
					this.scrollTop,
					hold.line,
					hold.line + hold.revealBelow,
					windowHeight,
					maxScroll,
				);
			}
			this.following = this.scrollTop >= maxScroll;
		}
		const marker = this.revealMarker;
		if (marker) {
			const row = transcript.findIndex((line) => line.includes(marker));
			// One scroll per request: afterwards wheel and page keys move the window
			// freely instead of being pulled back to the marked row every frame.
			if (row !== -1 && this.revealPending) {
				this.revealPending = false;
				const covered = this.pinnedRowCount(this.scrollTop, windowHeight);
				if (row < this.scrollTop + covered || row >= this.scrollTop + windowHeight) {
					// Leave a little context above the revealed row, below any pinned header.
					this.scrollTop = Math.max(0, Math.min(this.topClearingPins(row, 2, windowHeight), maxScroll));
					this.following = this.scrollTop >= maxScroll;
				}
			}
			transcript = transcript.map((line) => (line.includes(marker) ? line.split(marker).join("") : line));
		}
		if (this.following) {
			this.unseenLines = 0;
		} else {
			// Rows appended while the window was paused are new to whoever scrolled up.
			// Count transcript growth, not maxScroll growth: a taller dock or header
			// shrinks the window and pushes already-seen rows below it, and those rows
			// are not new. Rows prepended above the window (a backfilled history page)
			// are not new either: they sit above what the reader already saw. Clamp to
			// what is actually below the window: a rebuilt or compacted transcript
			// re-anchors every row, and a count larger than linesBelow would claim
			// content that is not there.
			this.unseenLines = Math.min(
				this.unseenLines + Math.max(0, transcript.length - this.lastTranscript.length - prepended),
				Math.max(0, maxScroll - this.scrollTop),
			);
		}
		this.lastMaxScroll = maxScroll;
		this.lastWindowHeight = windowHeight;
		this.lastHeaderHeight = headerLines.length;
		this.lastHeaderLines = (header ?? []).length;
		this.lastDockLines = dock.length;
		this.lastDockHeight = dockLines.length;
		// A rebuild or compaction replaces transcript rows, shifting every line
		// index; a selection anchored to the old rows would copy whatever now sits
		// at those indexes. Streaming appends keep the anchored lines identical,
		// so they never disturb an in-flight selection.
		if (this.selectionMode === "transcript" || this.selectionMode === "table") {
			const stale = [this.selectionAnchor, this.selectionHead].some(
				(point) =>
					point !== null &&
					(point.line >= transcript.length || transcript[point.line] !== this.lastTranscript[point.line]),
			);
			if (stale) this.clearSelection();
		}
		this.lastTranscript = transcript;
		this.tableCellSelectionRegions = tableCellSelectionRegions;

		const window = transcript.slice(this.scrollTop, this.scrollTop + windowHeight);
		for (let i = 0; i < window.length; i++) {
			if (isImageSequenceLine(window[i])) window[i] = IMAGE_PLACEHOLDER;
		}
		this.highlightSelection(window);
		while (window.length < windowHeight) {
			window.push("");
		}
		// Painted after the selection highlight: pinned rows are not selectable text.
		this.lastPinned = this.pinAt(this.scrollTop, windowHeight);
		if (this.lastPinned) {
			const { rows } = this.lastPinned;
			for (let i = 0; i < rows.length; i++) {
				window[i] = marker && rows[i].includes(marker) ? rows[i].split(marker).join("") : rows[i];
			}
		}
		return [...headerLines, ...window, ...dockLines];
	}

	/** Sticky headers of the transcript about to be composed, and the width their rows are cut to. */
	setStickyHeaders(headers: ReadonlyArray<StickyHeader>, width: number): void {
		this.stickyHeaders = headers;
		this.stickyWidth = width;
	}

	/**
	 * The header to keep painted when the window starts at transcript row `top`:
	 * of the boxes that started above the window and go on below its top edge, the
	 * innermost one whose pinned rows still fit before the box's last line.
	 */
	private pinAt(top: number, windowHeight: number): PinnedHeader | null {
		const headers = this.stickyHeaders;
		const maxRows = Math.min(FULLSCREEN_MAX_STICKY_ROWS, windowHeight - 1);
		if (headers.length === 0 || top <= 0 || maxRows <= 0) return null;
		const spanning: StickyHeader[] = [];
		for (const header of headers) {
			if (header.line < top && header.endLine > top) spanning.push(header);
		}
		if (spanning.length === 0) return null;
		spanning.sort((a, b) => b.line - a.line);
		const width = this.stickyWidth;
		for (const header of spanning) {
			const rows = header
				.render(top - header.line)
				.slice(0, maxRows)
				.map((row) => {
					return isImageSequenceLine(row) ? IMAGE_PLACEHOLDER : clampOverwideLine(row, width);
				});
			if (rows.length > 0 && top + rows.length <= header.endLine) return { header, rows };
		}
		return null;
	}

	private pinnedRowCount(top: number, windowHeight: number): number {
		return this.pinAt(top, windowHeight)?.rows.length ?? 0;
	}

	/**
	 * The highest window top that shows `line` at least `context` rows below the
	 * pinned rows. Pinned rows depend on the top they are pinned at, so this tries
	 * each extra row of room in turn instead of assuming the pin of the current top.
	 */
	private topClearingPins(line: number, context: number, windowHeight: number): number {
		for (let extra = 0; extra < FULLSCREEN_MAX_STICKY_ROWS; extra++) {
			const top = Math.max(0, line - context - extra);
			if (top === 0 || this.pinnedRowCount(top, windowHeight) <= extra) return top;
		}
		return Math.max(0, line - context - FULLSCREEN_MAX_STICKY_ROWS);
	}

	/** The pinned rows painted in the last frame, or null when none were. */
	pinnedRows(): PinnedRows | null {
		const pinned = this.lastPinned;
		if (!pinned) return null;
		return { firstRow: this.lastHeaderHeight, count: pinned.rows.length, regions: pinned.header.regions ?? [] };
	}

	/** Frame row the follow hint painted over in the last render, or null. */
	setFollowHintRow(row: number | null): void {
		this.followHintRow = row;
	}

	/** Whether frame row `screenRow` shows a pinned row of the last frame. */
	isPinnedRow(screenRow: number): boolean {
		const pinned = this.lastPinned;
		return (
			pinned !== null && screenRow >= this.lastHeaderHeight && screenRow < this.lastHeaderHeight + pinned.rows.length
		);
	}

	/**
	 * A click on the pinned header is about to change the box under it (collapse
	 * it): keep the window where it is, and let the next frame bring the header's
	 * own row back into view if the box shrank. A click that leaves the box alone
	 * moves nothing, and a window that follows the newest line keeps following.
	 */
	holdForPinnedHeader(): void {
		const pinned = this.lastPinned;
		if (!pinned || this.following) return;
		this.clickHold = { line: pinned.header.line, revealBelow: 0, boxEndLine: pinned.header.endLine };
	}

	/**
	 * The scroll offset that shows `endLine` without moving `anchorLine` above the
	 * window's top row: the anchor wins when the block is taller than the window.
	 */
	private revealBelow(
		scrollTop: number,
		anchorLine: number,
		endLine: number,
		windowHeight: number,
		maxScroll: number,
	): number {
		// The anchor never goes above the window or under a pinned header.
		const anchorTop = this.topClearingPins(anchorLine, 0, windowHeight);
		let top = scrollTop;
		if (endLine >= top + windowHeight) {
			top = Math.min(endLine - windowHeight + 1, anchorTop);
		}
		if (anchorTop < top || anchorLine < top + this.pinnedRowCount(top, windowHeight)) top = anchorTop;
		return Math.max(0, Math.min(top, maxScroll));
	}

	/**
	 * A click on screen row `screenRow` is about to change what renders below
	 * it: freeze the window where it is (following pauses) so the clicked row
	 * stays under the pointer, and let the next frame scroll just far enough to
	 * show `revealBelow` new rows. Clicks outside the transcript window change
	 * nothing here.
	 */
	holdForClick(screenRow: number, revealBelow = 0): void {
		const line = this.transcriptLineForScreenRow(screenRow, false);
		if (line === null) return;
		this.scrollTop = this.following ? this.lastMaxScroll : this.scrollTop;
		this.following = false;
		this.clickHold = { line, revealBelow: Math.max(0, revealBelow) };
	}

	/**
	 * Intersect [line, line+height) with the visible frame rows [firstFrameRow,
	 * firstFrameRow+frameRowCount). `anchor` keeps the frame row of the
	 * region's top line even when it is clipped away, so click positions stay
	 * relative to the region, not to the visible slice.
	 */
	private projectRows(
		line: number,
		height: number,
		firstFrameRow: number,
		frameRowCount: number,
		frameRowOfLine: (line: number) => number,
	): ProjectedRegionRows | null {
		const anchor = frameRowOfLine(line);
		const from = Math.max(anchor, firstFrameRow);
		const end = Math.min(anchor + Math.max(1, height), firstFrameRow + frameRowCount);
		return end > from ? { anchor, from, count: end - from } : null;
	}

	/** Project a header region; the header keeps its bottom rows when clipped. */
	projectHeaderRegion(line: number, height: number): ProjectedRegionRows | null {
		const start = Math.max(0, this.lastHeaderLines - this.lastHeaderHeight);
		return this.projectRows(line, height, 0, this.lastHeaderHeight, (row) => row - start);
	}

	/** Project a transcript region onto the visible window rows. */
	projectTranscriptRegion(line: number, height: number): ProjectedRegionRows | null {
		const base = this.lastHeaderHeight - this.scrollTop;
		return this.projectRows(line, height, this.lastHeaderHeight, this.lastWindowHeight, (row) => base + row);
	}

	/** Project a region of the pinned rows (coordinates of the header's `render` output). */
	projectPinnedRegion(line: number, height: number): ProjectedRegionRows | null {
		const pinned = this.lastPinned;
		if (!pinned) return null;
		const first = this.lastHeaderHeight;
		return this.projectRows(line, height, first, pinned.rows.length, (row) => first + row);
	}

	/** Project a dock region; the dock keeps its bottom rows when clipped. */
	projectDockRegion(line: number, height: number): ProjectedRegionRows | null {
		const start = Math.max(0, this.lastDockLines - this.lastDockHeight);
		const base = this.lastHeaderHeight + this.lastWindowHeight;
		return this.projectRows(line, height, base, this.lastDockHeight, (row) => base + row - start);
	}

	/** Replace the click targets with regions projected onto visible frame rows. */
	setFrameClickRegions(entries: ReadonlyArray<FrameClickEntry>): void {
		const targets: FrameClickTarget[] = [];
		for (const { region, anchor, from, count } of entries) {
			for (let row = from; row < from + count; row++) {
				targets.push({ row, col: region.col, width: region.width, anchor, region });
			}
		}
		this.frameClickTargets = targets;
	}

	/** Register an overlay region at its composited frame position, clipped to visible rows. */
	addFrameClickEntry(entry: FrameClickEntry): void {
		for (let row = entry.from; row < entry.from + entry.count; row++) {
			this.frameClickTargets.push({
				row,
				col: entry.region.col,
				width: entry.region.width,
				anchor: entry.anchor,
				region: entry.region,
			});
		}
	}

	/** Drop click coverage under pixels painted over the frame (overlays, follow hint). */
	subtractFrameClickCoverage(line: number, startCol: number, endCol: number): void {
		for (let i = this.frameClickTargets.length - 1; i >= 0; i--) {
			const target = this.frameClickTargets[i]!;
			if (target.row !== line) continue;
			const targetEnd = target.col + target.width;
			if (endCol <= target.col || startCol >= targetEnd) continue;
			const fragments: FrameClickTarget[] = [];
			if (target.col < startCol) {
				fragments.push({ ...target, col: target.col, width: startCol - target.col });
			}
			if (endCol < targetEnd) {
				fragments.push({ ...target, col: endCol, width: targetEnd - endCol });
			}
			this.frameClickTargets.splice(i, 1, ...fragments);
		}
	}

	/** Click target covering a screen position in the last composed frame, or null. */
	clickTargetAt(screenRow: number, screenCol: number): FrameClickTarget | null {
		if (screenRow < 0 || screenCol < 0) return null;
		for (const target of this.frameClickTargets) {
			if (target.region.passive) continue;
			if (target.row === screenRow && screenCol >= target.col && screenCol < target.col + target.width) {
				return target;
			}
		}
		return null;
	}

	/** The region under a screen position that scrolls its own content with the wheel, or null. */
	wheelTargetAt(screenRow: number, screenCol: number): FrameClickTarget | null {
		if (screenRow < 0 || screenCol < 0) return null;
		for (const target of this.frameClickTargets) {
			if (!target.region.onWheel) continue;
			if (target.row === screenRow && screenCol >= target.col && screenCol < target.col + target.width) {
				return target;
			}
		}
		return null;
	}

	private orderedSelection(): { start: SelectionPoint; end: SelectionPoint } | null {
		const a = this.selectionAnchor;
		const b = this.selectionHead;
		if (!a || !b || (a.line === b.line && a.col === b.col)) return null;
		const flipped = a.line > b.line || (a.line === b.line && a.col > b.col);
		return flipped ? { start: b, end: a } : { start: a, end: b };
	}

	private selectionSpan(lineIndex: number, sel: { start: SelectionPoint; end: SelectionPoint }): ColumnSpan | null {
		if (lineIndex < sel.start.line || lineIndex > sel.end.line) return null;
		return {
			from: lineIndex === sel.start.line ? sel.start.col : 0,
			to: lineIndex === sel.end.line ? sel.end.col : Number.MAX_SAFE_INTEGER,
		};
	}

	private highlightSelection(window: string[]): void {
		if (this.selectionMode !== "transcript" && this.selectionMode !== "table") return;
		const sel = this.orderedSelection();
		if (!sel) return;
		for (let i = 0; i < window.length; i++) {
			const lineIndex = this.scrollTop + i;
			const spans =
				this.selectionMode === "table"
					? this.selectedTableSpans(lineIndex, sel)
					: [this.selectionSpan(lineIndex, sel)].filter((span): span is ColumnSpan => span !== null);
			for (let spanIndex = spans.length - 1; spanIndex >= 0; spanIndex--) {
				window[i] = this.highlightLine(window[i], spans[spanIndex]);
			}
		}
	}

	/** Begin a selection at a screen position; false when outside the transcript window. */
	beginSelection(screenRow: number, screenCol: number): boolean {
		const line = this.transcriptLineForScreenRow(screenRow, false);
		if (line === null) {
			this.clearSelection();
			return false;
		}
		const point = { line, col: Math.max(0, screenCol) };
		this.selectionAnchor = point;
		this.selectionHead = { ...point };
		const table = this.tableAtPoint(point);
		const tableCell = table ? this.closestTableCell(table, point) : null;
		if (table && tableCell) {
			this.activeTableSelection = { table, anchor: tableCell };
			this.selectionMode = "table";
		} else {
			this.activeTableSelection = null;
			this.selectionMode = "transcript";
		}
		return true;
	}

	extendSelection(screenRow: number, screenCol: number): void {
		if (!this.selectionAnchor || (this.selectionMode !== "transcript" && this.selectionMode !== "table")) return;
		const line = this.transcriptLineForScreenRow(screenRow, true);
		if (line === null) return;
		this.selectionHead = { line, col: Math.max(0, screenCol) };
	}

	selectionAutoScrollDirection(screenRow: number): SelectionScrollDirection | null {
		if (
			!this.selectionAnchor ||
			!this.selectionHead ||
			(this.selectionMode !== "transcript" && this.selectionMode !== "table")
		)
			return null;
		const bounds = this.transcriptScreenBounds();
		if (!bounds) return null;
		// The head clamped to the window's first line equals an anchor placed on
		// that same line, so the head/anchor comparison alone never starts an
		// upward scroll from there. The pointer row above the selectable zone
		// (header, pinned rows) is unambiguous upward intent instead.
		const pushingUp = screenRow < bounds.firstRow;
		if (
			(this.selectionHead.line < this.selectionAnchor.line || pushingUp) &&
			screenRow <= bounds.firstRow &&
			this.scrollTop > 0
		) {
			return -1;
		}
		if (
			this.selectionHead.line > this.selectionAnchor.line &&
			screenRow >= bounds.lastRow &&
			this.scrollTop < this.lastMaxScroll
		) {
			return 1;
		}
		return null;
	}

	scrollSelection(direction: SelectionScrollDirection, screenCol: number): boolean {
		if (!this.selectionAnchor || (this.selectionMode !== "transcript" && this.selectionMode !== "table"))
			return false;
		const previousScrollTop = this.scrollTop;
		this.scrollBy(direction);
		if (this.scrollTop === previousScrollTop) return false;
		const bounds = this.transcriptScreenBounds();
		if (!bounds) return false;
		this.extendSelection(direction === -1 ? bounds.firstRow : bounds.lastRow, screenCol);
		return true;
	}

	/** Finish the selection and return its plain text (null when empty). */
	endSelection(): string | null {
		if (this.selectionMode !== "transcript" && this.selectionMode !== "table") {
			this.clearSelection();
			return null;
		}
		const sel = this.orderedSelection();
		const text = sel
			? this.selectionMode === "table"
				? this.extractTableSelectionText(this.lastTranscript, sel)
				: this.extractSelectionText(this.lastTranscript, sel)
			: null;
		this.clearSelection();
		return text;
	}

	extendActiveSelection(screenRow: number, screenCol: number): void {
		if (this.selectionMode === "frame") {
			this.extendFrameSelection(screenRow, screenCol);
		} else if (this.selectionMode === "transcript" || this.selectionMode === "table") {
			this.extendSelection(screenRow, screenCol);
		}
	}

	endActiveSelection(): string | null {
		if (this.selectionMode === "frame") {
			return this.endFrameSelection();
		}
		if (this.selectionMode === "transcript" || this.selectionMode === "table") {
			return this.endSelection();
		}
		this.clearSelection();
		return null;
	}

	/** Snapshot and highlight the final screen frame for overlay/dock selection. */
	applyFrameSelection(frame: string[], height: number, selectableRegions: ReadonlyArray<FrameSelectionRegion>): void {
		this.lastFrame = frame;
		this.lastRawFrame = [...frame];
		this.lastFrameVisibleHeight = Math.min(Math.max(0, height), frame.length);
		this.lastFrameVisibleStart = Math.max(0, frame.length - this.lastFrameVisibleHeight);
		this.frameSelectionRegions = selectableRegions;
		if (this.selectionMode !== "frame") return;
		const sel = this.orderedSelection();
		if (!sel) return;
		const snapshot = this.activeFrameSelection;
		for (let lineIndex = sel.start.line; lineIndex <= sel.end.line; lineIndex++) {
			let line = frame[lineIndex];
			if (line === undefined) continue;
			// The selection coordinates belong to the frame the drag started on.
			// A row that changed since (a ticking dock) must not inherit the
			// highlight at the stale coordinates.
			if (snapshot && snapshot.frame[lineIndex] !== line) continue;
			const spans = this.selectedFrameSpans(lineIndex, sel);
			for (let i = spans.length - 1; i >= 0; i--) {
				line = this.highlightLine(line, spans[i]);
			}
			frame[lineIndex] = line;
		}
	}

	beginFrameSelection(screenRow: number, screenCol: number): boolean {
		const point = this.framePoint(screenRow, screenCol);
		if (!point || !this.isFrameSelectable(point)) {
			this.clearSelection();
			return false;
		}
		this.activeFrameSelection = {
			frame: [...this.lastRawFrame],
			regions: this.frameSelectionRegions.map((region) => ({ ...region })),
			visibleStart: this.lastFrameVisibleStart,
			visibleHeight: this.lastFrameVisibleHeight,
		};
		this.selectionAnchor = point;
		this.selectionHead = { ...point };
		this.selectionMode = "frame";
		return true;
	}

	extendFrameSelection(screenRow: number, screenCol: number): void {
		if (!this.selectionAnchor || this.selectionMode !== "frame") return;
		const point = this.framePoint(screenRow, screenCol, this.activeFrameSelection);
		if (!point) return;
		const clamped = this.clampFrameSelectionPoint(point);
		if (!clamped) return;
		this.selectionHead = clamped;
	}

	endFrameSelection(): string | null {
		if (this.selectionMode !== "frame") {
			this.clearSelection();
			return null;
		}
		const sel = this.orderedSelection();
		const active = this.activeFrameSelection;
		const sourceLines = active?.frame ?? this.lastFrame;
		const regions = active?.regions ?? this.frameSelectionRegions;
		this.clearSelection();
		if (!sel) return null;
		return this.extractFrameSelectionText(sourceLines, regions, sel);
	}

	private highlightLine(line: string, span: ColumnSpan): string {
		// Kitty placeholder cells encode the image id in their foreground color;
		// the highlight's strip/reset would blank the image. Skip those rows.
		if (line.includes(KITTY_PLACEHOLDER_CHAR)) return line;
		// Selection columns are painted columns: apply the same tab/AM
		// normalization the paint pass applies before slicing, or a literal tab
		// (0 columns here, 3 on screen) shifts every span after it.
		line = normalizeTerminalOutput(line);
		const width = visibleWidth(line);
		const from = Math.min(span.from, width);
		const to = Math.min(span.to, width);
		if (to <= from) return line;
		const before = sliceByColumn(line, 0, from);
		const selected = stripAnsi(sliceByColumn(line, from, to - from));
		const after = sliceByColumn(line, to, Math.max(0, width - to));
		return `${before}\x1b[0m\x1b[7m${selected}\x1b[27m${after}`;
	}

	private framePoint(
		screenRow: number,
		screenCol: number,
		snapshot: FrameSelectionSnapshot | null = null,
	): SelectionPoint | null {
		const visibleHeight = snapshot?.visibleHeight ?? this.lastFrameVisibleHeight;
		if (visibleHeight === 0) return null;
		const visibleStart = snapshot?.visibleStart ?? this.lastFrameVisibleStart;
		const frameLength = snapshot?.frame.length ?? this.lastFrame.length;
		const row = Math.max(0, Math.min(screenRow, visibleHeight - 1));
		const line = visibleStart + row;
		if (line < 0 || line >= frameLength) return null;
		return { line, col: Math.max(0, screenCol) };
	}

	private transcriptScreenBounds(): {
		firstRow: number;
		lastRow: number;
		visibleStart: number;
		visibleHeight: number;
		transcriptStart: number;
		transcriptEnd: number;
		windowEnd: number;
	} | null {
		if (this.lastWindowHeight <= 0) return null;
		const visibleHeight = this.lastFrameVisibleHeight > 0 ? this.lastFrameVisibleHeight : this.lastWindowHeight;
		if (visibleHeight <= 0) return null;
		const visibleStart = this.lastFrameVisibleHeight > 0 ? this.lastFrameVisibleStart : 0;
		const visibleEnd = visibleStart + visibleHeight - 1;
		// The transcript window occupies frame rows [headerHeight, headerHeight +
		// windowHeight); the pinned header sits above it and the dock below.
		// Sticky rows painted over the top of the window are not selectable: selection starts below them.
		const windowStart = this.lastHeaderHeight + (this.lastPinned?.rows.length ?? 0);
		const windowEnd = this.lastHeaderHeight + this.lastWindowHeight - 1;
		// A transcript shorter than the window leaves blank fill rows below the
		// content: those rows map to line indexes past the transcript end, which the
		// stale-selection check then discards. Clamp the selectable range to the
		// last content row instead. The follow hint's row is excluded the same way:
		// the hint hides that transcript line, so selecting must not copy it.
		const contentEnd = this.lastHeaderHeight + Math.max(0, this.lastTranscript.length - this.scrollTop) - 1;
		const hintEnd = this.followHintRow !== null ? this.followHintRow - 1 : Number.MAX_SAFE_INTEGER;
		const transcriptStart = Math.max(windowStart, visibleStart);
		const transcriptEnd = Math.min(windowEnd, visibleEnd, contentEnd, hintEnd);
		if (transcriptStart > transcriptEnd) return null;
		return {
			firstRow: transcriptStart - visibleStart,
			lastRow: transcriptEnd - visibleStart,
			visibleStart,
			visibleHeight,
			transcriptStart,
			transcriptEnd,
			windowEnd,
		};
	}

	private transcriptLineForScreenRow(screenRow: number, clamp: boolean): number | null {
		const bounds = this.transcriptScreenBounds();
		if (!bounds) return null;
		if (!clamp && (screenRow < 0 || screenRow >= bounds.visibleHeight)) return null;
		const row = clamp ? Math.max(0, Math.min(screenRow, bounds.visibleHeight - 1)) : screenRow;
		const frameLine = bounds.visibleStart + row;
		// Outside the transcript window (header above, dock below) is not
		// selectable. Blank fill rows inside the window map to the nearest content
		// row, so a drag sweeping the fill extends the selection to the content end.
		if (!clamp && (frameLine < bounds.transcriptStart || frameLine > bounds.windowEnd)) return null;
		const clampedFrameLine = Math.max(bounds.transcriptStart, Math.min(frameLine, bounds.transcriptEnd));
		return this.scrollTop + clampedFrameLine - this.lastHeaderHeight;
	}

	private isFrameSelectable(point: SelectionPoint): boolean {
		return this.frameSelectionRegions.some(
			(region) => region.line === point.line && point.col >= region.col && point.col < region.col + region.width,
		);
	}

	private tableRegions(table: object): TableCellSelectionRegion[] {
		return this.tableCellSelectionRegions.filter((region) => region.table === table);
	}

	private tableAtPoint(point: SelectionPoint): object | null {
		const tables = new Set(this.tableCellSelectionRegions.map((region) => region.table));
		for (const table of tables) {
			const region = this.tableRegions(table)[0];
			if (
				region &&
				point.line >= region.tableTop &&
				point.line <= region.tableBottom &&
				point.col >= Math.max(0, region.tableLeft - 1) &&
				point.col <= region.tableRight
			) {
				return table;
			}
		}
		return null;
	}

	private closestTableCell(table: object, point: SelectionPoint): TableCellPosition | null {
		let closest: TableCellPosition | null = null;
		let closestLineDistance = Number.POSITIVE_INFINITY;
		let closestColumnDistance = Number.POSITIVE_INFINITY;
		for (const region of this.tableRegions(table)) {
			const lineDistance = Math.abs(point.line - region.line);
			const end = region.col + region.width;
			const columnDistance = point.col < region.col ? region.col - point.col : point.col > end ? point.col - end : 0;
			if (
				lineDistance < closestLineDistance ||
				(lineDistance === closestLineDistance && columnDistance < closestColumnDistance)
			) {
				closest = { row: region.row, column: region.column };
				closestLineDistance = lineDistance;
				closestColumnDistance = columnDistance;
			}
		}
		return closest;
	}

	private activeTableRange(): TableSelectionRange | null {
		const active = this.activeTableSelection;
		const head = this.selectionHead;
		if (!active || !head) return null;
		const headCell = this.closestTableCell(active.table, head);
		if (!headCell) return null;
		return {
			fromRow: Math.min(active.anchor.row, headCell.row),
			toRow: Math.max(active.anchor.row, headCell.row),
			fromColumn: Math.min(active.anchor.column, headCell.column),
			toColumn: Math.max(active.anchor.column, headCell.column),
		};
	}

	private selectedTableSpans(lineIndex: number, sel: { start: SelectionPoint; end: SelectionPoint }): ColumnSpan[] {
		const active = this.activeTableSelection;
		const range = this.activeTableRange();
		if (!active || !range) return [];
		const singleCell = range.fromRow === range.toRow && range.fromColumn === range.toColumn;
		const selectionSpan = singleCell ? this.selectionSpan(lineIndex, sel) : null;
		if (singleCell && !selectionSpan) return [];

		const spans: ColumnSpan[] = [];
		for (const region of this.tableCellSelectionRegions) {
			if (
				region.line !== lineIndex ||
				region.table !== active.table ||
				region.row < range.fromRow ||
				region.row > range.toRow ||
				region.column < range.fromColumn ||
				region.column > range.toColumn
			)
				continue;
			const from = selectionSpan ? Math.max(selectionSpan.from, region.col) : region.col;
			const to = selectionSpan ? Math.min(selectionSpan.to, region.col + region.width) : region.col + region.width;
			if (to > from) spans.push({ from, to });
		}
		return spans.sort((a, b) => a.from - b.from);
	}

	private frameRegionsForLine(
		line: number,
		regions = this.activeFrameSelection?.regions ?? this.frameSelectionRegions,
	): FrameSelectionRegion[] {
		return regions.filter((region) => region.line === line && region.width > 0).sort((a, b) => a.col - b.col);
	}

	private clampFrameSelectionPoint(point: SelectionPoint): SelectionPoint | null {
		const regions = this.frameRegionsForLine(point.line);
		if (regions.length === 0) return null;
		let closest = regions[0].col;
		let distance = Number.POSITIVE_INFINITY;
		for (const region of regions) {
			const start = region.col;
			const end = region.col + region.width;
			if (point.col >= start && point.col <= end) {
				return { line: point.line, col: Math.max(start, Math.min(point.col, end)) };
			}
			for (const col of [start, end]) {
				const nextDistance = Math.abs(point.col - col);
				if (nextDistance < distance) {
					closest = col;
					distance = nextDistance;
				}
			}
		}
		return { line: point.line, col: closest };
	}

	private selectedFrameSpans(
		lineIndex: number,
		sel: { start: SelectionPoint; end: SelectionPoint },
		regions = this.activeFrameSelection?.regions ?? this.frameSelectionRegions,
	): ColumnSpan[] {
		const span = this.selectionSpan(lineIndex, sel);
		if (!span) return [];
		const spans: ColumnSpan[] = [];
		for (const region of this.frameRegionsForLine(lineIndex, regions)) {
			const from = Math.max(span.from, region.col);
			const to = Math.min(span.to, region.col + region.width);
			if (to > from) spans.push({ from, to });
		}
		return spans;
	}

	private extractFrameSelectionText(
		sourceLines: string[],
		regions: ReadonlyArray<FrameSelectionRegion>,
		sel: { start: SelectionPoint; end: SelectionPoint },
	): string | null {
		const lines: string[] = [];
		let lastImageMarker: number | null = null;
		for (let lineIndex = sel.start.line; lineIndex <= sel.end.line; lineIndex++) {
			const line = normalizeTerminalOutput(sourceLines[lineIndex] ?? "");
			const spans = this.selectedFrameSpans(lineIndex, sel, regions);
			if (spans.length === 0) continue;
			const parts: string[] = [];
			for (const span of spans) {
				parts.push(stripAnsi(sliceByColumn(line, span.from, Math.max(0, span.to - span.from))));
			}
			const text = parts.join("").trimEnd();
			const marker = this.placeholderCopyMarker(line, text);
			if (marker) {
				if (marker.imageId !== null && marker.imageId === lastImageMarker) continue;
				lastImageMarker = marker.imageId;
				lines.push(KITTY_PLACEHOLDER_COPY_MARKER);
				continue;
			}
			lastImageMarker = null;
			lines.push(text);
		}
		const text = lines.join("\n");
		return text.trim().length > 0 ? text : null;
	}

	/**
	 * Clipboard text for one selected line: kitty placeholder rows copy as one
	 * [image] marker per image instead of leaking the U+10EEEE cells. The rows
	 * of an image share its id (encoded in the row's SGR foreground color), so
	 * callers collapse consecutive rows reporting the same id; a null id never
	 * collapses.
	 */
	private placeholderCopyMarker(line: string, text: string): { imageId: number | null } | null {
		if (!text.includes(KITTY_PLACEHOLDER_CHAR)) return null;
		return { imageId: extractKittyPlaceholderImageId(line) };
	}

	private extractSelectionText(
		sourceLines: string[],
		sel: { start: SelectionPoint; end: SelectionPoint },
	): string | null {
		const lines: string[] = [];
		// Rows that are only a gutter: kept between paragraphs, dropped at the ends of the selection.
		const gutterOnly = new Set<number>();
		let lastImageMarker: number | null = null;
		for (let lineIndex = sel.start.line; lineIndex <= sel.end.line; lineIndex++) {
			// Normalize to the painted representation (tabs expand to three
			// spaces) so selection columns match what was on screen.
			const line = normalizeTerminalOutput(sourceLines[lineIndex] ?? "");
			const span = this.selectionSpan(lineIndex, sel);
			if (!span) continue;
			if (isImageSequenceLine(line)) {
				// An inline graphics payload strips to an empty line; copy one
				// [image] marker per image instead. (One sequence line per image:
				// multi-row images pad with empty rows, so no dedupe needed.)
				lines.push(KITTY_PLACEHOLDER_COPY_MARKER);
				lastImageMarker = null;
				continue;
			}
			const width = visibleWidth(line);
			const contentStart = contentStartColumn(line);
			// A row that marks where its content starts copies only from there: the gutter is not text.
			if (contentStart !== undefined && span.to <= contentStart) continue;
			const from = Math.min(Math.max(span.from, contentStart ?? 0), width);
			const to = Math.min(span.to, width);
			const text = stripAnsi(sliceByColumn(line, from, Math.max(0, to - from))).trimEnd();
			const marker = this.placeholderCopyMarker(line, text);
			if (marker) {
				if (marker.imageId !== null && marker.imageId === lastImageMarker) continue;
				lastImageMarker = marker.imageId;
				lines.push(KITTY_PLACEHOLDER_COPY_MARKER);
				continue;
			}
			lastImageMarker = null;
			if (contentStart !== undefined && text === "") gutterOnly.add(lines.length);
			lines.push(text);
		}
		let first = 0;
		while (first < lines.length && gutterOnly.has(first)) first++;
		let last = lines.length;
		while (last > first && gutterOnly.has(last - 1)) last--;
		const text = lines.slice(first, last).join("\n");
		return text.trim().length > 0 ? text : null;
	}

	private compareSelectionPoints(a: SelectionPoint, b: SelectionPoint): number {
		return a.line === b.line ? a.col - b.col : a.line - b.line;
	}

	private extractTableSelectionText(
		sourceLines: string[],
		sel: { start: SelectionPoint; end: SelectionPoint },
	): string | null {
		const active = this.activeTableSelection;
		const range = this.activeTableRange();
		if (!active || !range) return null;

		if (range.fromRow !== range.toRow || range.fromColumn !== range.toColumn) {
			const contents = new Map<string, string>();
			for (const region of this.tableRegions(active.table)) {
				contents.set(`${region.row}:${region.column}`, region.content);
			}
			const rows: string[] = [];
			for (let row = range.fromRow; row <= range.toRow; row++) {
				const cells: string[] = [];
				for (let column = range.fromColumn; column <= range.toColumn; column++) {
					cells.push(contents.get(`${row}:${column}`) ?? "");
				}
				rows.push(cells.join("\t"));
			}
			const text = rows.join("\n");
			return text.trim().length > 0 ? text : null;
		}

		const cellRegions = this.tableRegions(active.table)
			.filter((region) => region.row === range.fromRow && region.column === range.fromColumn)
			.sort((a, b) => a.line - b.line || a.segment - b.segment);
		const first = cellRegions[0];
		const last = cellRegions.at(-1);
		if (first && last) {
			const cellStart = { line: first.line, col: first.col };
			const cellEnd = { line: last.line, col: last.col + last.width };
			if (
				this.compareSelectionPoints(sel.start, cellStart) <= 0 &&
				this.compareSelectionPoints(sel.end, cellEnd) >= 0
			) {
				return first.content.trim().length > 0 ? first.content : null;
			}
		}

		const lines: string[] = [];
		for (let lineIndex = sel.start.line; lineIndex <= sel.end.line; lineIndex++) {
			const line = normalizeTerminalOutput(sourceLines[lineIndex] ?? "");
			const spans = this.selectedTableSpans(lineIndex, sel);
			if (spans.length === 0) continue;
			const parts = spans.map((span) => stripAnsi(sliceByColumn(line, span.from, Math.max(0, span.to - span.from))));
			lines.push(parts.join("").trimEnd());
		}
		const text = lines.join("\n");
		return text.trim().length > 0 ? text : null;
	}

	clearSelection(): void {
		this.selectionAnchor = null;
		this.selectionHead = null;
		this.selectionMode = null;
		this.activeFrameSelection = null;
		this.activeTableSelection = null;
	}

	hasSelection(): boolean {
		return this.orderedSelection() !== null;
	}

	/**
	 * OSC 8 hyperlink URL at a screen position in the last painted frame, or
	 * null when the position is not over a hyperlink. Covers the transcript
	 * window, the dock, and composited overlays.
	 */
	hyperlinkAt(screenRow: number, screenCol: number): string | null {
		if (screenRow < 0 || screenCol < 0 || this.lastFrameVisibleHeight === 0) return null;
		if (screenRow >= this.lastFrameVisibleHeight) return null;
		const line = this.lastFrame[this.lastFrameVisibleStart + screenRow];
		if (line === undefined || isImageLine(line)) return null;
		return urlAtColumn(line, screenCol);
	}

	/** Row-diff a composed frame against the previous one with absolute addressing. */
	paint(
		write: (data: string) => void,
		frame: string[],
		width: number,
		height: number,
		cursorPos: { row: number; col: number } | null,
		// Wrap the frame in mode 2026 synchronized-output markers. The caller
		// decides from the probe-bus verdict (sync2026FrameWrapping).
		sync2026 = true,
	): void {
		if (frame.length > height) {
			frame = frame.slice(frame.length - height);
		}

		let buffer = sync2026 ? "\x1b[?2026h" : "";
		if (width !== this.prevWidth || height !== this.prevHeight || this.prevFrame.length === 0) {
			buffer += "\x1b[2J\x1b[H";
			this.prevFrame = [];
		}
		for (let row = 0; row < height; row++) {
			const line = frame[row] ?? "";
			if (this.prevFrame[row] === line) continue;
			buffer += `\x1b[${row + 1};1H\x1b[2K`;
			// an overwide line would wrap and shear the grid; clamp instead of crash
			buffer += clampOverwideLine(line, width);
		}
		if (cursorPos) {
			const cursorRow = Math.max(0, Math.min(cursorPos.row, height - 1));
			const cursorCol = Math.max(0, Math.min(cursorPos.col, width - 1));
			buffer += `\x1b[${cursorRow + 1};${cursorCol + 1}H`;
		}
		if (sync2026) {
			buffer += "\x1b[?2026l";
		}
		write(buffer);

		this.prevFrame = frame;
		this.prevWidth = width;
		this.prevHeight = height;
	}

	/** Force the next paint to clear and repaint the whole screen. */
	reset(): void {
		this.prevFrame = [];
	}

	/**
	 * Scroll the transcript row carrying `marker` into view on the next frame
	 * that has it; the marker stays stripped from every frame until cleared
	 * with undefined. Call again to reveal the row once more.
	 */
	setRevealMarker(marker: string | undefined): void {
		this.revealMarker = marker;
		this.revealPending = marker !== undefined;
	}

	/** Scrolling up pauses following; reaching the bottom resumes it. */
	scrollBy(delta: number): void {
		const base = this.following ? this.lastMaxScroll : this.scrollTop;
		this.scrollTop = Math.max(0, Math.min(base + delta, this.lastMaxScroll));
		this.following = this.scrollTop >= this.lastMaxScroll;
		if (this.following) {
			this.unseenLines = 0;
		} else {
			// Reading part of the backlog does not mark it seen; the count only ever claims
			// rows that are still below the window.
			this.unseenLines = Math.min(this.unseenLines, Math.max(0, this.lastMaxScroll - this.scrollTop));
		}
	}

	/**
	 * Announce rows inserted at the TOP of the transcript (a backfilled history
	 * page). The next composed frame shifts a paused window down with them so the
	 * rows it shows stay put, and never counts them as new content below; a
	 * following window stays glued to the end. Deferring to the frame matters:
	 * scrollBy() runs against the pre-insert maxScroll and would clamp a
	 * near-bottom paused window into following.
	 */
	noteTranscriptPrepend(lines: number): void {
		if (lines > 0) this.prependedLines += lines;
	}

	scrollToTop(): void {
		this.scrollTop = 0;
		this.following = this.lastMaxScroll === 0;
		// An explicit jump is newer than the click that armed the hold; the next
		// frame must not re-anchor the window to that clicked row.
		this.clickHold = undefined;
	}

	scrollToBottom(): void {
		this.scrollTop = this.lastMaxScroll;
		this.following = true;
		this.unseenLines = 0;
		// Same as scrollToTop: the submit path and the follow key rely on this
		// being absolute, even right after a click armed a one-frame hold.
		this.clickHold = undefined;
	}

	/**
	 * Rows one page key scrolls: a window less one row of overlap, less the rows a
	 * sticky header covers at the top of the window it lands on, so no row is
	 * skipped under the pinned rows.
	 */
	pageSize(direction: SelectionScrollDirection = 1): number {
		const room = Math.max(1, this.lastWindowHeight - 1);
		if (this.stickyHeaders.length === 0) return room;
		// Going up, the rows to keep in view sit below the pinned rows of the window we leave.
		if (direction < 0) return Math.max(1, room - (this.lastPinned?.rows.length ?? 0));
		for (let covered = 0; covered < FULLSCREEN_MAX_STICKY_ROWS; covered++) {
			const step = Math.max(1, room - covered);
			const top = Math.min(this.scrollTop + step, this.lastMaxScroll);
			if (this.pinnedRowCount(top, this.lastWindowHeight) <= covered) return step;
		}
		return Math.max(1, room - FULLSCREEN_MAX_STICKY_ROWS);
	}

	windowHeight(): number {
		return this.lastWindowHeight;
	}

	/** Rows the pinned header currently occupies at the top of the frame. */
	headerHeight(): number {
		return this.lastHeaderHeight;
	}

	isFollowing(): boolean {
		return this.following;
	}

	scrollInfo(): ScrollInfo {
		return {
			following: this.following,
			linesBelow: Math.max(0, this.lastMaxScroll - this.scrollTop),
			linesAbove: this.scrollTop,
			unseenBelow: this.unseenLines,
			windowHeight: this.lastWindowHeight,
		};
	}
}
