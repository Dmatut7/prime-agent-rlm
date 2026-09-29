import { type ClickRegion, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ThemeBg, type ThemeColor, theme } from "../theme/theme.js";
import { spinnerFrame } from "../theme/working-icon.js";
import { sanitizeDisplayText } from "./diff-rows.js";
import {
	ERROR_FLASH_MS,
	foldProgress,
	LABEL_FADE_MS,
	motionReduced,
	rowEnterStage,
	SETTLE_FLASH_MS,
	slideCount,
	withinMotion,
} from "./motion.js";
import { type BoxRow, type MetaPart, summaryParts, type TimelineFacts } from "./timeline-rows.js";
import {
	formatBoxDuration,
	formatBoxTokens,
	lastCompletedSentence,
	type TimelineUiState,
	type TurnTimeline,
} from "./turn-timeline.js";

/**
 * A turn's box: a card whose header row says what is happening now (or, once
 * done, what the turn did), and whose body is the turn's timeline. The header
 * is a painted row: a status pill (`⠹ 进行中`, `✓ 完成`), the words, the clock
 * and tokens, and an arrow on the right (`›` closed, `⌄` open). Closed with
 * nothing to keep on show, the box is just that one row. Open, it is framed and
 * its body grows with the turn: in the fullscreen window the page scrolls; an
 * inline screen keeps a fixed body height, scrolls inside the frame, follows
 * the newest line until the user scrolls up, then says `↓ 有新内容`.
 *
 * Every step is a block: a row painted in its kind's color, indented one
 * column inside the frame, with a row of `▀` under it that leaves a half-line
 * gap before the next block (the separator belongs to the block's click area).
 * What hangs under a block (an opened step, the live thought, a command's
 * latest output) sits on the panel color behind a bar in the kind's color. A
 * short note (what the AI said between steps) is plain text, not a block.
 *
 * ```
 *  ╭──────────────────────────────────────────────────────────╮
 *  │ ⠹ 进行中  思考中 · 这个测试上个月还是好的     16秒 · ↓ 2.4k ⌄ │
 *  ├──────────────────────────────────────────────────────────┤
 *  │  ▸ ∴ 思考了 4秒 用户要审查最近 100 次提交      4秒 · 1.1k  │
 *  │ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ │
 *  │  ▾ $ git log --stat -100              ✓ 100 次提交 · 312  │
 *  │ ▎    commit 522f16718  test(tui): widen the timing…      │
 *  │ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ │
 *  │      趁等待，查一下这个风险点。                           │
 *  ╰──────────────────────────────────────────────────────────╯
 * ```
 */

/** Body rows the box shows at most, and at least when the terminal is short. */
export const BOX_BODY_MAX_ROWS = 14;
export const BOX_BODY_MIN_ROWS = 4;
/**
 * A body or an opened block taller than this changes at once: sliding a page of rows in or folding
 * it away one by one makes the page jump under the reader, and the window has to see the finished
 * height to keep the clicked row in place.
 */
export const ROW_MOTION_MAX_ROWS = BOX_BODY_MAX_ROWS;
/** Lines of the live thinking window. */
export const THINK_WINDOW_LINES = 3;
/** A running step turns amber once it has run this long. */
export const SLOW_STEP_MS = 60_000;
/** Zero-width marker on the focused line, so the fullscreen viewport can scroll it into view. */
export const BOX_FOCUS_MARKER = "\x1b_pi:box-focus\x07";

/** Narrowest frame drawn whole: its borders, padding and no content. */
const BOX_MIN_OUTER = 4;

/** The frame's width for `width` columns (the line also has a one-column margin). */
export function boxOuterWidth(width: number): number {
	return Math.max(BOX_MIN_OUTER, Math.floor(width) - 1);
}

/** The click area of one framed line: the frame and its margin, never past the terminal's last column. */
export function boxRegionWidth(outer: number, width: number): number {
	return Math.min(outer + 1, Math.max(1, Math.floor(width)));
}

/**
 * The lines cut to `width` columns. A frame narrower than {@link BOX_MIN_OUTER}
 * cannot be drawn whole, and a line wider than the terminal breaks the screen.
 */
export function fitBoxLines(lines: string[], width: number): string[] {
	const room = Math.max(1, Math.floor(width));
	return lines.map((line) => (visibleWidth(line) > room ? truncateToWidth(line, room, "") : line));
}

/** How tall the body may get for a terminal of `rows` rows. */
export function boxBodyRows(terminalRows: number): number {
	return Math.max(BOX_BODY_MIN_ROWS, Math.min(BOX_BODY_MAX_ROWS, Math.floor(terminalRows) - 12));
}

/** How the turn stands: the status pill's words and colors follow it. */
export type BoxStatus = "live" | "done" | "stopped" | "error";

export interface BoxHeader {
	status: BoxStatus;
	glyph: string;
	glyphColor: ThemeColor;
	spinning: boolean;
	/** Styled label parts. */
	parts: MetaPart[];
	/** Plain label, for noticing a change. */
	plain: string;
	shimmer: boolean;
}

export interface BoxHeaderInput {
	rows: readonly BoxRow[];
	facts: TimelineFacts;
	timeline: TurnTimeline;
	live: boolean;
	phase: "waiting" | "thinking" | "writing";
	currentThinking: string;
	now: number;
}

function part(text: string, color: ThemeColor = "activityText"): MetaPart {
	return { text, color };
}

/** What the header says: the current action while live, the turn's summary once done. */
export function computeBoxHeader(input: BoxHeaderInput): BoxHeader {
	const { timeline, facts } = input;
	const done = (status: BoxStatus, glyph: string, glyphColor: ThemeColor, parts: MetaPart[]): BoxHeader => ({
		status,
		glyph,
		glyphColor,
		spinning: false,
		parts,
		plain: parts.map((entry) => entry.text).join(""),
		shimmer: false,
	});
	const live = (parts: MetaPart[], options: { shimmer?: boolean; amber?: boolean } = {}): BoxHeader => ({
		status: "live",
		glyph: "",
		glyphColor: options.amber ? "runCardWarn" : "activityAccent",
		spinning: true,
		parts,
		plain: parts.map((entry) => entry.text).join(""),
		shimmer: options.shimmer ?? false,
	});
	if (timeline.stopped) {
		return done("stopped", "■", "dim", [part(`做到第 ${facts.stepCount} 步，做好的都留着`)]);
	}
	if (!input.live) {
		const summary: MetaPart[] = [];
		summaryParts(facts).forEach((group, index) => {
			if (index > 0) summary.push(part(" · ", "muted"));
			summary.push(...group);
		});
		return timeline.errorEnded ? done("error", "✗", "error", summary) : done("done", "✓", "diffAddedText", summary);
	}
	const retryRow = [...input.rows].reverse().find((row) => row.kind === "retry" && row.status === "running");
	if (retryRow) return live([part(retryRow.text, "runCardWarn")], { amber: true });
	if (input.rows.some((row) => row.kind === "compact" && row.status === "running")) {
		return live([part("上下文快满了，正在整理前面的内容")]);
	}
	const subagents = input.rows.filter((row) => row.kind === "subagent" && row.status === "running");
	const subagentWait = (): BoxHeader =>
		subagents.length === 1
			? live([part(`在等子代理 ${subagents[0]?.text ?? ""} 交回结果`)])
			: live([part(`在等 ${subagents.length} 个子代理交回结果`)]);
	const running = [...input.rows]
		.reverse()
		.find((row) => row.status === "running" && row.kind !== "think" && row.kind !== "subagent");
	// A cell that only checks on its subagents is waiting for them: say who.
	if (running?.text.startsWith("查看子代理") && subagents.length > 0) return subagentWait();
	if (running) {
		switch (running.kind) {
			case "cmd":
				return live([part(running.text.startsWith("等待 ") ? `正在${running.text}` : `正在运行 ${running.text}`)]);
			case "read":
				return live([part(`正在读取 ${running.files?.at(-1) ?? running.text}`)]);
			case "edit":
				return live([part(`正在修改 ${running.text}`)]);
			case "memory":
				return live([part("正在记下一条经验")]);
			default: {
				if (running.text === "这段代码还在运行") return live([part("正在运行代码")]);
				// `搜索 x` reads `正在搜索 x`; a bare tool name reads `正在运行 name`.
				const verbFirst = /^[一-鿿]/.test(running.text);
				return live([part(verbFirst ? `正在${running.text}` : `正在运行 ${running.text}`)]);
			}
		}
	}
	const thinkingLive = input.rows.some((row) => row.kind === "think" && row.status === "running");
	if (input.phase === "thinking" || thinkingLive) {
		const sentence = lastCompletedSentence(input.currentThinking);
		return live(sentence ? [part("思考中 · "), part(sentence)] : [part("思考中…")]);
	}
	if (input.phase === "writing") return live([part("正在写回答")]);
	if (subagents.length > 0) return subagentWait();
	return live([part("等待模型回应…", "dim")], { shimmer: true });
}

export interface BoxRenderInput {
	timeline: TurnTimeline;
	rows: readonly BoxRow[];
	header: BoxHeader;
	width: number;
	now: number;
	tick: number;
	/** The turn has not finished (spinners turn, clocks tick). */
	live: boolean;
	/** The body is shown. */
	open: boolean;
	/** The body takes all the rows it needs (the fullscreen window scrolls the page); false: it stops at `maxBodyRows` and scrolls inside the frame. */
	grow: boolean;
	maxBodyRows: number;
	/** Most rows a click on a block may ask the window to show below it: one screen. */
	revealRows: number;
	durationMs: number;
	tokens: number;
	/** The whole box toggled (header click). */
	onToggleBox: () => void;
	/** Anything else changed its UI state and wants a frame. */
	onChange: () => void;
}

export interface BoxRenderResult {
	lines: string[];
	regions: ClickRegion[];
	/** Focusable targets, top to bottom: `header`, then row keys. */
	focusOrder: string[];
	/** The header row: its place in `lines` and the row itself (a pinned copy repeats it). */
	header: { line: number; text: string };
	/** Where each block shown starts in `lines`. */
	blockHeads: number[];
	/** The frame is drawn (open, or closed with something kept on show); false: the box is its header row alone. */
	framed: boolean;
}

/** Column a block's text starts at; notes and what hangs under a block line up with it. */
const TEXT_INDENT = 5;
/** A note of at most this many wrapped lines is plain text; a longer one is a block. */
export const NOTE_MAX_LINES = 3;

interface BlockStyle {
	/** The kind's foreground (glyph, bar, hint); a neutral block keeps its row's own glyph color. */
	fg?: ThemeColor;
	bg: ThemeBg;
	hoverBg: ThemeBg;
}

const KIND_STYLES = {
	think: { fg: "kindThink", bg: "kindThinkBg", hoverBg: "kindThinkHoverBg" },
	cmd: { fg: "kindCommand", bg: "kindCommandBg", hoverBg: "kindCommandHoverBg" },
	read: { fg: "kindRead", bg: "kindReadBg", hoverBg: "kindReadHoverBg" },
	subagent: { fg: "kindSubagent", bg: "kindSubagentBg", hoverBg: "kindSubagentHoverBg" },
	error: { fg: "kindError", bg: "kindErrorBg", hoverBg: "kindErrorHoverBg" },
	edit: { fg: "kindEdit", bg: "kindEditBg", hoverBg: "kindEditHoverBg" },
	memory: { fg: "kindMemory", bg: "kindMemoryBg", hoverBg: "kindMemoryHoverBg" },
} satisfies Record<string, BlockStyle>;
const NEUTRAL_STYLE: BlockStyle = { bg: "customMessageBg", hoverBg: "selectedBg" };
const RETRY_STYLE: BlockStyle = { fg: "kindRecovered", bg: "customMessageBg", hoverBg: "selectedBg" };

/** The color family of a row's block: by kind, red for a failure, neutral for what is not a step's work. */
function blockStyle(row: BoxRow): BlockStyle {
	if (row.status === "stopped") return NEUTRAL_STYLE;
	if (row.status === "failed" || row.kind === "error") return KIND_STYLES.error;
	switch (row.kind) {
		case "think":
			return KIND_STYLES.think;
		case "cmd":
			return KIND_STYLES.cmd;
		case "read":
			return KIND_STYLES.read;
		case "edit":
			return KIND_STYLES.edit;
		case "memory":
			return KIND_STYLES.memory;
		case "subagent":
			return KIND_STYLES.subagent;
		case "step":
			return row.status === "plain" ? NEUTRAL_STYLE : KIND_STYLES.read;
		case "retry":
			return RETRY_STYLE;
		default:
			return NEUTRAL_STYLE;
	}
}

/** Which part of a block or note a body line is. */
type LinePart = "head" | "gap" | "panel" | "note";

interface BodyLine {
	/** Styled content of exactly the inner width. */
	text: string;
	rowKey?: string;
	part?: LinePart;
	/** A line the user opened under a row: never counted as new content. */
	detail?: boolean;
}

function styled(parts: readonly MetaPart[]): string {
	return parts.map((entry) => theme.fg(entry.color, entry.text)).join("");
}

/** Columns the left side keeps at least when a right side is drawn beside it. */
const LEFT_MIN_ROOM = 6;

/** `left` and `right` on one line of exactly `width` columns; the left side gives way. */
function spread(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (!right || rightWidth + LEFT_MIN_ROOM > width) return truncateToWidth(left, width, "…", true);
	const fitted = truncateToWidth(left, Math.max(1, width - rightWidth - 2), "…");
	return `${fitted}${" ".repeat(Math.max(2, width - visibleWidth(fitted) - rightWidth))}${right}`;
}

/** A color that resets the background (or everything) inside a painted line. */
const BG_RESET = /\x1b\[(?:0|49)?m/g;

/**
 * `content` cut or padded to `width` columns and painted on `bg`. A color
 * inside it that resets the background (a diff line's tint) does not end the
 * paint: the background is put back right after it.
 */
function paintBg(bg: ThemeBg, content: string, width: number): string {
	const fitted = truncateToWidth(content, width, "…", true);
	const open = theme.getBgAnsi(bg);
	return `${open}${fitted.replace(BG_RESET, (reset) => `${reset}${open}`)}\x1b[49m`;
}

/** A row of `▀` in a background's own color: the half-line gap under a block. */
function gapLine(bg: ThemeBg, width: number): string {
	const ansi = theme.getBgAnsi(bg);
	const fill = "\x1b[48;";
	if (!ansi.startsWith(fill)) return " ".repeat(width);
	return `\x1b[38;${ansi.slice(fill.length)}${"▀".repeat(width)}\x1b[39m`;
}

/**
 * A block's right side: the hint and the result, or the hint alone when both would
 * leave the text too little room (the hint says what a click does, the result can
 * wait); `spread` leaves out whatever still does not fit.
 */
function blockSide(hint: string, result: string, width: number): string {
	if (!hint) return result;
	const both = result ? `${hint}  ${result}` : hint;
	return visibleWidth(both) + LEFT_MIN_ROOM > width ? hint : both;
}

function shimmerText(text: string, tick: number): string {
	if (motionReduced()) return theme.fg("dim", text);
	const chars = [...text];
	const band = (tick % (chars.length + 6)) - 3;
	return chars
		.map((char, index) => {
			const distance = Math.abs(index - band);
			return theme.fg(distance === 0 ? "activityText" : distance === 1 ? "muted" : "dim", char);
		})
		.join("");
}

function rowGlyph(row: BoxRow, style: BlockStyle, timeline: TurnTimeline, input: BoxRenderInput): string {
	// A live thought keeps its ∴ and a retry its ↻: the keyword, the window and
	// the countdown say they are going on.
	if (row.status === "running" && row.kind !== "think" && row.kind !== "retry") {
		const slow = row.startedAt !== undefined && input.now - row.startedAt >= SLOW_STEP_MS;
		return theme.bold(
			theme.fg(slow ? "runCardWarn" : (style.fg ?? "activityAccent"), spinnerFrame(input.tick, slow)),
		);
	}
	const settled = timeline.ui.settledAt.get(row.key);
	if (withinMotion(settled, SETTLE_FLASH_MS, input.now)) {
		const color = row.status === "failed" || row.kind === "error" ? "diffRemovedText" : "diffAddedText";
		return theme.bold(theme.fg(color, row.glyph));
	}
	return style.fg ? theme.bold(theme.fg(style.fg, row.glyph)) : theme.fg(row.glyphColor, row.glyph);
}

function rowRight(row: BoxRow, input: BoxRenderInput): string {
	if (row.status === "running" && row.startedAt !== undefined && row.kind !== "retry") {
		const elapsed = Math.max(0, input.now - row.startedAt);
		return theme.fg(elapsed >= SLOW_STEP_MS ? "runCardWarn" : "dim", formatBoxDuration(elapsed));
	}
	return styled(row.meta);
}

/** The words of a block: a keyword and the text, brightened where the block's own tint carries the kind. */
function rowWords(row: BoxRow, style: BlockStyle): string {
	// A keyword ending in a full-width colon (`你插话：`) runs straight into its text.
	const gap = row.text && !row.keyword?.endsWith("：") ? " " : "";
	const keywordColor: ThemeColor =
		row.keywordColor === "activityAccent" && style.fg
			? style.fg
			: row.kind === "think" && row.keywordColor === "dim"
				? "muted"
				: (row.keywordColor ?? "dim");
	const keyword = row.keyword ? `${theme.fg(keywordColor, row.keyword)}${gap}` : "";
	const brighten = (row.kind === "think" || row.kind === "read") && row.textColor === "muted";
	const text = row.text
		? theme.fg(brighten ? "activityText" : row.textColor, sanitizeDisplayText(row.text).replace(/\s+/g, " "))
		: "";
	return `${keyword}${text}`;
}

/** The fixed three-line thinking window: the newest text at the bottom, the top line faded. */
function thinkWindow(text: string, width: number): string[] {
	const flat = text.replace(/\s+/g, " ").trim();
	const wrappedLines = flat ? wrapTextWithAnsi(flat, Math.max(8, width)) : [];
	const shown = wrappedLines.slice(-THINK_WINDOW_LINES);
	while (shown.length < THINK_WINDOW_LINES) shown.unshift("");
	return shown.map((line, index) =>
		index === 0 && wrappedLines.length >= THINK_WINDOW_LINES ? theme.fg("dim", line) : theme.fg("thinkingText", line),
	);
}

/** A note's whole text wrapped to `width` columns, paragraph breaks kept. */
function noteLines(cleanText: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of cleanText.split("\n")) {
		const parts = wrapTextWithAnsi(paragraph, width);
		lines.push(...(parts.length > 0 ? parts : [""]));
	}
	while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
	return lines;
}

/** What is known of one note: its words and width when it was measured, and its lines when they fit. */
interface NoteMeasure {
	text: string;
	width: number;
	lines: string[] | undefined;
}

const noteMeasures = new WeakMap<TurnTimeline["ui"], Map<string, NoteMeasure>>();

function measureNote(fullText: string, width: number): string[] | undefined {
	const room = Math.max(8, width);
	const clean = sanitizeDisplayText(fullText);
	// A wrapped line holds at most `room` columns and wrapping only drops blanks, so text with
	// more visible columns than three lines hold needs more lines: no need to wrap it to know.
	if (visibleWidth(clean.replace(/\s+/g, "")) > NOTE_MAX_LINES * room) return undefined;
	const lines = noteLines(clean, room);
	return lines.length > 0 && lines.length <= NOTE_MAX_LINES ? lines : undefined;
}

/**
 * The lines of a note short enough to be plain text (at most {@link NOTE_MAX_LINES}),
 * or undefined when it needs a block. The box is drawn many times a second and the
 * words rarely change, so what was measured is kept for the row until its words or
 * the width change.
 */
function shortNoteLines(ui: TurnTimeline["ui"], key: string, fullText: string, width: number): string[] | undefined {
	let measures = noteMeasures.get(ui);
	if (!measures) {
		measures = new Map();
		noteMeasures.set(ui, measures);
	}
	const known = measures.get(key);
	if (known && known.width === width && known.text === fullText) return known.lines;
	const lines = measureNote(fullText, width);
	measures.set(key, { text: fullText, width, lines });
	return lines;
}

/** Rows a click on a block asks the window to show below it while its opened lines are not counted. */
const REVEAL_GUESS = 8;

/**
 * How many rows an opened block adds below itself, for the window to keep in view when it
 * grows. Counted from the block's own lines when it is pointed at or focused (the pointer
 * arrives before the click); every other block says a small guess, so the box does not build
 * every block's opened lines on each frame. At most one screen: the window never scrolls
 * past the clicked row anyway.
 */
function revealRowsFor(row: BoxRow | undefined, ui: TimelineUiState, width: number, cap: number): number {
	if (!row?.detail) return 0;
	const counted = ui.hoverKey === row.key || (ui.focused && ui.focusKey === row.key);
	return Math.min(cap, counted ? row.detail(width).length : REVEAL_GUESS);
}

const PILL_STYLES: Record<BoxStatus, { text: string; fg: ThemeColor; bg: ThemeBg }> = {
	live: { text: "进行中", fg: "boxPillLive", bg: "boxPillLiveBg" },
	done: { text: "完成", fg: "boxPillDone", bg: "boxPillDoneBg" },
	stopped: { text: "已停止", fg: "boxPillStopped", bg: "boxPillStoppedBg" },
	error: { text: "出错", fg: "boxPillError", bg: "boxPillErrorBg" },
};

/** Columns the title keeps at least before the clock and tokens are drawn beside it. */
const TITLE_MIN_ROOM = 6;

/**
 * The header row's words in exactly `width` columns (less when even the pill and the arrow do not fit):
 * the pill, the title, the clock and tokens, the arrow. The pill and the arrow stay; the clock and
 * tokens go first when the room is short, then the title is cut.
 */
function headerRow(pill: string, title: string, stats: string, arrow: string, width: number): string {
	const pillWidth = visibleWidth(pill);
	const arrowWidth = visibleWidth(arrow);
	if (width < pillWidth + 1 + arrowWidth) return truncateToWidth(`${pill} ${arrow}`, width, "", true);
	const withStats = stats !== "" && pillWidth + 1 + TITLE_MIN_ROOM + 2 + visibleWidth(stats) + 1 + arrowWidth <= width;
	const right = withStats ? `${stats} ${arrow}` : arrow;
	const rightWidth = visibleWidth(right);
	const room = Math.max(0, width - pillWidth - 1 - rightWidth - 1);
	const fittedTitle = room > 0 ? truncateToWidth(title, room, "…") : "";
	const used = pillWidth + 1 + visibleWidth(fittedTitle) + rightWidth;
	return `${pill} ${fittedTitle}${" ".repeat(Math.max(0, width - used))}${right}`;
}

function boxBorderColor(focused: boolean, live: boolean): ThemeColor {
	return focused ? "activityAccent" : live ? "boxBorderLive" : "boxBorder";
}

/**
 * The row a pinned header shows under itself, inside the frame: what is out of sight above, and that a
 * click on the header folds the box. `hiddenSteps` counts the blocks the pinned rows cover or the window
 * has scrolled past.
 */
export function renderStickyHint(input: {
	width: number;
	hiddenSteps: number;
	focused: boolean;
	live: boolean;
}): string {
	const outer = boxOuterWidth(input.width);
	const inner = outer - 4;
	const border = (text: string) => theme.fg(boxBorderColor(input.focused, input.live), text);
	const words =
		input.hiddenSteps > 0 ? `↑ 前面还有 ${input.hiddenSteps} 步，往上滚就能看到 · 点框头可收起` : "点框头可收起";
	const fitted = truncateToWidth(theme.fg("dim", words), Math.max(0, inner), "…", true);
	return fitBoxLines([` ${border("│")} ${fitted} ${border("│")}`], input.width)[0] ?? "";
}

/**
 * Render the box. The body's scroll position, what is open and what was just
 * highlighted all live on the timeline's UI state, which this updates (the
 * last shown window, new-line notices) as a side effect of laying it out.
 */
export function renderTurnBox(input: BoxRenderInput): BoxRenderResult {
	const { timeline, rows, now } = input;
	const ui = timeline.ui;
	const outer = boxOuterWidth(input.width);
	const inner = outer - 4;
	const regionWidth = boxRegionWidth(outer, input.width);
	const border = (text: string) => theme.fg(boxBorderColor(ui.focused, input.live), text);
	const regions: ClickRegion[] = [];
	const lines: string[] = [];
	const focusOrder: string[] = ["header"];

	// Rows that appear while the turn is watched live come in with a highlight;
	// a row that settles flashes once. A replayed box starts quiet.
	for (const row of rows) {
		const previous = ui.rowStatus.get(row.key);
		if (previous === undefined && ui.primed && input.live) ui.enteredAt.set(row.key, now);
		if (previous === "running" && row.status !== "running" && ui.primed) ui.settledAt.set(row.key, now);
		if (previous === undefined && row.kind === "error" && ui.primed && input.live) ui.settledAt.set(row.key, now);
		ui.rowStatus.set(row.key, row.status);
	}
	ui.primed = true;

	const boxLine = (content: string): string => {
		const fitted = truncateToWidth(content, inner, "…", true);
		return ` ${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
	};
	const rule = (left: string, right: string, label = "", labelColor: ThemeColor = "dim"): string => {
		// A label that does not fit the rule is left out; the rule itself always fits.
		const labelText = label && visibleWidth(label) + 4 <= outer - 2 ? ` ${label} ` : "";
		const fill = Math.max(0, outer - 2 - visibleWidth(labelText) - (labelText ? 2 : 0));
		return ` ${border(left)}${labelText ? `${border("──")}${theme.fg(labelColor, labelText)}` : ""}${border("─".repeat(fill))}${border(right)}`;
	};

	// Header: a status pill, what is happening (or what happened), clock and tokens, and the arrow.
	const header = input.header;
	if (header.plain !== ui.label) {
		if (ui.label !== undefined) ui.labelChangedAt = now;
		ui.label = header.plain;
	}
	const fading = !header.shimmer && withinMotion(ui.labelChangedAt, LABEL_FADE_MS, now);
	const label = header.shimmer
		? shimmerText(header.plain, input.tick)
		: fading
			? theme.fg("dim", header.plain)
			: styled(header.parts);
	const pillStyle = PILL_STYLES[header.status];
	const pillGlyph = header.spinning ? spinnerFrame(input.tick) : header.glyph;
	const pill = theme.bg(pillStyle.bg, theme.bold(theme.fg(pillStyle.fg, ` ${pillGlyph} ${pillStyle.text} `)));
	const headerFocused = ui.focused && ui.focusKey === "header";
	const lit = ui.headHover || headerFocused;
	const arrow = theme.bold(theme.fg(lit ? "activityAccent" : "activityText", input.open ? "⌄" : "›"));
	const stats = theme.fg("muted", `${formatBoxDuration(input.durationMs)} · ↓ ${formatBoxTokens(input.tokens)}`);
	const headerContent = headerRow(pill, theme.bold(label), stats, arrow, inner);
	const headBg: ThemeBg = lit ? "boxHeadHoverBg" : input.live ? "boxHeadLiveBg" : "boxHeadBg";
	const headerMark = headerFocused ? BOX_FOCUS_MARKER : "";

	// Body lines: every row, the lines that hang under it, and what it opened.
	const body: BodyLine[] = [];
	const rowStart = new Map<string, number>();
	const rowEnd = new Map<string, number>();
	const hangWidth = Math.max(8, inner - 6);
	const hang = (accent: ThemeColor, content: string, extra: Partial<BodyLine>): BodyLine => ({
		text: paintBg("kindPanelBg", `${theme.fg(accent, "▎")}${" ".repeat(TEXT_INDENT - 1)}${content}`, inner),
		part: "panel",
		...extra,
	});
	for (const row of rows) {
		rowStart.set(row.key, body.length);
		// A short note is plain text: not a block, so nothing to click or walk to.
		const note = row.fullText !== undefined ? shortNoteLines(ui, row.key, row.fullText, hangWidth) : undefined;
		if (note) {
			for (const noteLine of note) {
				body.push({
					text: `${" ".repeat(TEXT_INDENT)}${theme.fg("muted", noteLine)}`,
					rowKey: row.key,
					part: "note",
				});
			}
			rowEnd.set(row.key, body.length - 1);
			continue;
		}
		focusOrder.push(row.key);
		const style = blockStyle(row);
		const expandable = row.detail !== undefined;
		const opened = expandable && ui.expanded.has(row.key);
		const focused = ui.focused && ui.focusKey === row.key;
		const pointed = expandable && ui.hoverKey === row.key;
		const stage = rowEnterStage(ui.enteredAt.get(row.key), now);
		const errorFlash = row.kind === "error" && withinMotion(ui.settledAt.get(row.key), ERROR_FLASH_MS, now);
		const active = pointed || focused;
		const lit = opened || active || errorFlash || stage !== "none";
		const accent: ThemeColor = style.fg ?? "activityText";
		const rowCaret = expandable ? theme.fg(opened || active ? accent : "activityText", opened ? "▾" : "▸") : " ";
		// What a click would do, in the kind's color, ahead of the result.
		const hint = expandable && active ? theme.fg(accent, opened ? "收起 ▴" : "点开 ▸") : "";
		const room = Math.max(0, inner - 1);
		const rowSide = blockSide(hint, rowRight(row, input), room);
		const left = ` ${rowCaret} ${rowGlyph(row, style, timeline, input)} ${rowWords(row, style)}`;
		const blockBg = lit ? style.hoverBg : style.bg;
		body.push({
			text: `${focused ? BOX_FOCUS_MARKER : ""}${paintBg(blockBg, `${spread(left, rowSide, room)} `, inner)}`,
			rowKey: row.key,
			part: "head",
		});
		let hanging = false;
		if (row.sub) {
			hanging = true;
			body.push(hang(accent, theme.fg("dim", `└ ${row.sub}`), { rowKey: row.key }));
		}
		if (row.window !== undefined) {
			hanging = true;
			for (const windowLine of thinkWindow(row.window, hangWidth)) {
				body.push(hang(accent, windowLine, { rowKey: row.key }));
			}
		}
		if (opened && row.detail) {
			const detail = row.detail(hangWidth);
			const shown =
				input.grow && detail.length > ROW_MOTION_MAX_ROWS
					? detail.length
					: slideCount(ui.expandedAt.get(row.key), detail.length, now);
			for (const detailLine of detail.slice(0, shown)) {
				hanging = true;
				body.push(hang(accent, detailLine, { rowKey: row.key, detail: true }));
			}
		}
		body.push({ text: gapLine(hanging ? "kindPanelBg" : blockBg, inner), rowKey: row.key, part: "gap" });
		rowEnd.set(row.key, body.length - 1);
	}

	// Which body lines show: all of them while open (a growing box shows every line; an
	// inline one scrolls to fit), only the failures once closed, a shrinking window while
	// the turn-end fold runs.
	let visibleLines: BodyLine[] = [];
	let hiddenAbove = 0;
	let showUnseen = false;
	const folding = ui.foldStartedAt !== undefined;
	const foldP = folding ? foldProgress(ui.foldStartedAt, ui.foldFromRows, now) : 1;
	if (folding && foldP >= 1) ui.foldStartedAt = undefined;
	const foldRunning = folding && foldP < 1;
	if (input.open || foldRunning) {
		const total = body.length;
		const visible = input.grow ? total : Math.min(total, input.maxBodyRows);
		const maxTop = Math.max(0, total - visible);
		// Only rows the turn added count as unseen: not what the user opened, and not
		// the lines a row takes up, which a narrower terminal makes more of.
		const content = rows.length;
		// A growing box shows everything, so it is always at its newest line.
		if (input.grow) ui.follow = true;
		if (!ui.follow && content > ui.lastRowCount && ui.lastRowCount > 0) ui.unseen = true;
		ui.lastRowCount = content;
		let top = ui.follow ? maxTop : Math.min(ui.scrollTop, maxTop);
		const reveal = ui.revealKey;
		if (reveal !== undefined && rowStart.has(reveal)) {
			// A growing box has nothing to scroll inside: the window scrolls to the row's marker.
			if (!input.grow) {
				const start = rowStart.get(reveal) ?? 0;
				const end = ui.revealDetail ? (rowEnd.get(reveal) ?? start) : start;
				if (start < top) top = start;
				else if (end >= top + visible) top = Math.min(start, end - visible + 1);
				ui.scrollTop = top;
				ui.follow = top >= maxTop && ui.follow;
			}
			ui.revealKey = undefined;
		}
		if (ui.follow) ui.unseen = false;
		ui.lastBodyLines = total;
		ui.lastTop = top;
		ui.lastVisible = visible;
		let height = visible;
		if (foldRunning) height = Math.max(0, Math.round(ui.foldFromRows * (1 - foldP)));
		else if (ui.openedAt !== undefined && visible <= ROW_MOTION_MAX_ROWS)
			height = slideCount(ui.openedAt, visible, now);
		visibleLines = body.slice(top, top + height);
		hiddenAbove = top;
		showUnseen = ui.unseen && !ui.follow;
	} else {
		const persistent = new Set(rows.filter((row) => row.persistent).map((row) => row.key));
		visibleLines = body.filter((line) => line.rowKey !== undefined && persistent.has(line.rowKey));
		// A closed box keeps only its header and failures focusable.
		focusOrder.length = 1;
		focusOrder.push(...rows.filter((row) => row.persistent).map((row) => row.key));
	}

	// Closed with nothing to keep on show, the box is its header row alone: a card, no frame.
	const framed = input.open || foldRunning || visibleLines.length > 0;
	if (framed) {
		lines.push(rule("╭", "╮"));
		lines.push(`${headerMark} ${border("│")}${paintBg(headBg, ` ${headerContent} `, outer - 2)}${border("│")}`);
	} else {
		lines.push(`${headerMark} ${paintBg(headBg, `  ${headerContent}  `, outer)}`);
	}
	const headerLine = lines.length - 1;
	const bodyTop = lines.length + (visibleLines.length > 0 ? 1 : 0);
	// What a click on the closed header shows below it: the body, and the frame a card opens.
	const openedRows = (input.grow ? body.length : Math.min(body.length, input.maxBodyRows)) + (framed ? 1 : 3);
	regions.push({
		line: headerLine,
		col: 0,
		width: regionWidth,
		height: 1,
		revealBelow: input.open ? 0 : input.grow ? Math.min(input.revealRows, openedRows) : openedRows,
		onClick: () => input.onToggleBox(),
		hoverKey: `${ui.id}:header`,
		onHover: (hovered: boolean) => {
			if (ui.setHeadHover(hovered)) input.onChange();
		},
	});
	if (framed) {
		if (visibleLines.length > 0) {
			lines.push(
				hiddenAbove > 0 && (input.open || folding)
					? rule("├", "┤", `↑ 上面还有 ${hiddenAbove} 行`)
					: rule("├", "┤"),
			);
			if (hiddenAbove > 0 && input.open) {
				regions.push({
					line: lines.length - 1,
					col: 0,
					width: regionWidth,
					height: 1,
					onClick: () => {
						if (timeline.ui.scrollBody(-Math.max(1, timeline.ui.lastVisible - 1))) input.onChange();
					},
					onWheel: (direction) => {
						const moved = timeline.ui.scrollBody(direction);
						if (moved) input.onChange();
						return moved;
					},
				});
			}
			for (const line of visibleLines) lines.push(boxLine(line.text));
		}
		lines.push(showUnseen ? rule("╰", "╯", "↓ 有新内容", "activityAccent") : rule("╰", "╯"));
		if (showUnseen) {
			regions.push({
				line: lines.length - 1,
				col: 0,
				width: regionWidth,
				height: 1,
				onClick: () => {
					timeline.ui.followNewest();
					input.onChange();
				},
			});
		}
	}

	// Body regions: a click opens or closes the block under it (its separator row counts
	// as the block); in an inline box everything else only takes the wheel. A growing box
	// has no wheel of its own: the wheel scrolls the page.
	const onWheel = (direction: -1 | 1): boolean => {
		if (!input.open) return false;
		const moved = timeline.ui.scrollBody(direction);
		if (moved) input.onChange();
		return moved;
	};
	// Opening a row grows an inline box only while the body is below its height cap;
	// past it the body scrolls inside the frame and the page does not move.
	const growRoom = input.open ? Math.max(0, input.maxBodyRows - visibleLines.length) : 0;
	const rowByKey = new Map(rows.map((row) => [row.key, row] as const));
	const blockHeads: number[] = [];
	visibleLines.forEach((line, index) => {
		if (line.part === "head") blockHeads.push(bodyTop + index);
		const row = line.rowKey ? rowByKey.get(line.rowKey) : undefined;
		const key = row?.key;
		const clickable = row?.detail !== undefined && key !== undefined && (line.part === "head" || line.part === "gap");
		if (!clickable && input.grow) return;
		regions.push({
			line: bodyTop + index,
			col: 0,
			width: regionWidth,
			height: 1,
			...(clickable
				? {
						revealBelow: timeline.ui.expanded.has(key)
							? 0
							: input.grow
								? revealRowsFor(row, timeline.ui, hangWidth, input.revealRows)
								: Math.min(growRoom, 8),
						onClick: () => {
							timeline.ui.toggleRow(key, Date.now());
							input.onChange();
						},
						hoverKey: `${timeline.ui.id}:${key}`,
						onHover: (hovered: boolean) => {
							if (timeline.ui.setHover(key, hovered)) input.onChange();
						},
					}
				: { passive: true, onClick: () => {} }),
			...(input.grow ? {} : { onWheel }),
		});
	});
	const fitted = fitBoxLines(lines, input.width);
	return {
		lines: fitted,
		regions,
		focusOrder,
		// The marker is for the transcript's own row; a pinned copy must not carry it.
		header: { line: headerLine, text: (fitted[headerLine] ?? "").split(BOX_FOCUS_MARKER).join("") },
		blockHeads,
		framed,
	};
}
