import { type ClickRegion, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.js";
import { spinnerFrame } from "../theme/working-icon.js";
import { shortAgentName } from "./agent-message.js";
import { sanitizeDisplayText } from "./diff-rows.js";
import { styleInlineMarkdown } from "./inline-markdown.js";
import {
	formatTimelineTime,
	TIMELINE_CONTENT_COL,
	type TimelineGutter,
	type TimelineLane,
	type TimelineRowOptions,
	timelineRow,
} from "./timeline-gutter.js";
import type { TimelineLaneTracker } from "./timeline-lane.js";
import {
	type BoxRow,
	type BoxRowKind,
	eventSaysMore,
	type MetaPart,
	summaryParts,
	type TimelineEvent,
	type TimelineFacts,
} from "./timeline-rows.js";
import {
	formatBoxDuration,
	lastCompletedSentence,
	type TimelineUiState,
	type TurnTimeline,
	thoughtSentence,
} from "./turn-timeline.js";

/**
 * A turn drawn on the timeline: one line per thing the AI said it does or found
 * (`HH:MM ◆ words`), with the commands, thoughts and edits behind it folded into
 * `N 步 ▸`. An opened event lists its first three steps and `⋯ 另外 N 步   全部 ›`
 * (which lists them all and ends on `⋯ 共 N 步   ▴ 收起`); an opened step lists
 * what it printed. Subagents the turn dispatched get one `├──╮` line; a turn still running ends on `⠹ 正在…` and the command running now.
 * Rows are whole lines: a pointer or the keyboard paints the line, nothing moves.
 *
 * ```
 *  18:50   ◆  趁它们干活，我自己跑检查和测试。                    24 步 ▴
 *          │  ┆     $  npx tsgo --noEmit                          ✓ 21秒
 *          │  ┆     ⋯  另外 23 步                                全部 ›
 * ```
 */

/** Zero-width marker on the focused line, so the fullscreen viewport can scroll it into view. */
export const BOX_FOCUS_MARKER = "\x1b_pi:box-focus\x07";

/** Steps an opened event lists before `⋯ 另外 N 步`. */
export const EVENT_STEPS_SHOWN = 3;
/** In a run of consecutive events the first, the last two, up to three that carry news and any the user opened or is on stay; the rest fold. */
const EVENT_TAIL_SHOWN = 2;
const EVENT_NEWS_SHOWN = 3;
const EVENT_NEWS = /\*\*[^*\n]+\*\*|发现|实锤|出错|失败|问题|结论/;

const NO_KEYS: ReadonlySet<string> = new Set();

/** The key of the fold row that opens the run whose first event is `event`. */
function foldKeyOf(event: TimelineEvent | undefined): string {
	return `hid:${event?.key}`;
}

/**
 * The runs of events a long stretch folds into `⋯ 中间还有 N 件事`: a run is consecutive events
 * between two boundaries (the question, a dispatch, a return, an error line, a steer, the end),
 * and only a stretch of more than three is folded. A folded run is two events or more.
 * An event in `pinned` (one the user opened, or the one the keyboard is on) is never folded: it
 * splits the run around it, unless the run is unfolded already and every event of it shows.
 */
export function foldedEventRuns(
	events: readonly TimelineEvent[],
	returnsAt: readonly number[],
	pinned: ReadonlySet<string> = NO_KEYS,
	unfolded: ReadonlySet<string> = NO_KEYS,
): number[][] {
	const clusters: number[][] = [];
	let current: number[] = [];
	const close = (): void => {
		if (current.length > 0) clusters.push(current);
		current = [];
	};
	let landed = 0;
	events.forEach((event, index) => {
		let split = false;
		while (landed < returnsAt.length && (returnsAt[landed] ?? 0) < event.at) {
			landed += 1;
			split = true;
		}
		if (split) close();
		if (event.kind !== "say") {
			close();
			return;
		}
		current.push(index);
		if (event.spawned.length > 0) close();
	});
	close();
	const runs: number[][] = [];
	const settleRun = (run: number[]): void => {
		if (run.length < 2) return;
		if (unfolded.has(foldKeyOf(events[run[0] ?? 0]))) {
			runs.push(run);
			return;
		}
		let piece: number[] = [];
		const flush = (): void => {
			if (piece.length >= 2) runs.push(piece);
			piece = [];
		};
		for (const index of run) {
			if (pinned.has(events[index]?.key ?? "")) flush();
			else piece.push(index);
		}
		flush();
	};
	for (const cluster of clusters) {
		if (cluster.length <= 1 + EVENT_TAIL_SHOWN) continue;
		const news = new Set<number>();
		const middle = cluster.slice(1, -EVENT_TAIL_SHOWN);
		for (const index of middle) {
			if (news.size < EVENT_NEWS_SHOWN && EVENT_NEWS.test(events[index]?.text ?? "")) news.add(index);
		}
		let run: number[] = [];
		const settle = (): void => {
			settleRun(run);
			run = [];
		};
		for (const index of middle) {
			if (news.has(index)) settle();
			else run.push(index);
		}
		settle();
	}
	return runs;
}

/** The events the fold leaves alone: the ones the user opened and the one the keyboard is on. */
function pinnedEventKeys(events: readonly TimelineEvent[], ui: TimelineUiState): Set<string> {
	const pinned = new Set<string>();
	for (const event of events) if (ui.expanded.has(event.key)) pinned.add(event.key);
	const focus = ui.focused ? ui.focusKey : undefined;
	if (focus !== undefined) {
		const owner = events.find(
			(event) =>
				focus === event.key || focus === `all:${event.key}` || event.steps.some((step) => step.key === focus),
		);
		if (owner) pinned.add(owner.key);
	}
	return pinned;
}

/** Columns of a step's content in front of its glyph. */
const STEP_INDENT = 5;
/** Columns a step's glyph and its gap take in front of the words. */
const STEP_GLYPH_COLS = 3;
/** Columns of its words a step keeps before its right side is shortened. */
const STEP_WORDS_MIN = 12;
/** What the tail's running line says before the command. */
const TIP_LABEL = "在跑  ";

/** A row that is only the main line and its lane: what a return keeps above itself. */
const RAIL_GAP_ROW = /^(?:\x1b\[[0-9;]*m| )*│(?:\x1b\[[0-9;]*m| |┆)*$/;

function startsWithRailGap(line: string | undefined): boolean {
	return line !== undefined && RAIL_GAP_ROW.test(line);
}

/** The lines cut to `width` columns: a line wider than the terminal breaks the screen. */
export function fitBoxLines(lines: string[], width: number): string[] {
	const room = Math.max(1, Math.floor(width));
	return lines.map((line) => (visibleWidth(line) > room ? truncateToWidth(line, room, "") : line));
}

/** How the turn stands. */
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

/** What the turn is doing now (the live tail's fallback words), or what it did once done. */
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

/** The lines a running turn ends on: what the AI is at, and the command running now. */
export interface LiveTail {
	/** When the newest thing began (ms); 0 when unknown. */
	at: number;
	/** The AI's newest sentence, or what it is doing. */
	text: string;
	/** Steps the turn has listed so far. */
	stepCount: number;
	/** The command (or other step) running now. */
	running?: { text: string; startedAt?: number };
	/** Shown under the sentence when no step is running (`思考中…`, `在等子代理…`). */
	waiting?: string;
}

export interface LiveTailInput {
	rows: readonly BoxRow[];
	events: readonly TimelineEvent[];
	header: BoxHeader;
	timeline: TurnTimeline;
	hideThinking: boolean;
	now: number;
}

/** What a running step of this kind says about itself when there is no thought to quote. */
function runningVerb(row: BoxRow): string | undefined {
	if (row.kind === "cmd") return "正在运行命令";
	if (row.kind === "read") return "正在读取文件";
	if (row.kind === "edit") return "正在修改文件";
	return undefined;
}

/** The newest thought when it is newer than anything the AI said out loud. */
function newestThought(timeline: TurnTimeline, hideThinking: boolean): string | undefined {
	if (hideThinking) return undefined;
	for (let index = timeline.entries.length - 1; index >= 0; index--) {
		const entry = timeline.entries[index];
		if (entry?.kind !== "message") continue;
		const content = entry.message.content ?? [];
		for (let block = content.length - 1; block >= 0; block--) {
			const item = content[block];
			if (item?.type === "text" && (item.text ?? "").trim()) return undefined;
			if (item?.type === "thinking" && (item.thinking ?? "").trim()) return thoughtSentence(item.thinking ?? "");
		}
	}
	return undefined;
}

/** The tail of a turn that is still running. */
export function computeLiveTail(input: LiveTailInput): LiveTail {
	const running = [...input.rows]
		.reverse()
		.find(
			(row) =>
				row.status === "running" &&
				row.kind !== "think" &&
				row.kind !== "subagent" &&
				row.kind !== "retry" &&
				row.kind !== "compact",
		);
	const thought = newestThought(input.timeline, input.hideThinking);
	const text = thought || (running ? runningVerb(running) : undefined) || input.header.plain;
	const lastMessage = [...input.timeline.entries].reverse().find((entry) => entry.kind === "message");
	const at = lastMessage?.kind === "message" ? lastMessage.message.timestamp : 0;
	const stepCount = input.events.reduce((sum, event) => sum + event.steps.length, 0);
	return {
		at: at > 0 ? at : input.now,
		text,
		stepCount,
		...(running
			? {
					running: {
						text: stepWords(running),
						...(running.startedAt !== undefined ? { startedAt: running.startedAt } : {}),
					},
				}
			: text !== input.header.plain
				? { waiting: input.header.plain }
				: {}),
	};
}

/** A row another part draws (a subagent's report) that sits among the turn's lines by its time. */
export interface InlineRow {
	/** When it landed (ms). */
	at: number;
	lines: string[];
	regions: ReadonlyArray<ClickRegion>;
}

export interface BoxRenderInput {
	timeline: TurnTimeline;
	rows: readonly BoxRow[];
	events: readonly TimelineEvent[];
	tail?: LiveTail;
	width: number;
	now: number;
	tick: number;
	/** Most rows a click on a line may ask the window to show below it: one screen. */
	revealRows: number;
	/** Which subagents are out; absent: no lane is drawn. */
	lanes?: TimelineLaneTracker;
	/** Rows that landed inside the turn, each drawn before the first event that started after it. */
	inline?: readonly InlineRow[];
	/** Empty main-line rows first: two under the question, one for a turn a message woke; none when what is above ends in a blank line. */
	leadingRows?: number;
	/** The first line leaves its right side out: block navigation puts its key hint there. */
	dropFirstRight?: boolean;
	/** An event was opened or closed (the host records what the user opened). */
	onToggleEvent?: () => void;
	/** Anything changed its UI state and wants a frame. */
	onChange: () => void;
}

export interface BoxRenderResult {
	lines: string[];
	regions: ClickRegion[];
	/** Focusable targets, top to bottom: event keys, step keys, `all:` keys. */
	focusOrder: string[];
}

/** One line before it is fitted, painted and given its click region. */
interface LineSpec {
	gutter: TimelineGutter;
	content: string;
	right?: string;
	/** How the row gives way on a narrow screen. */
	fit?: TimelineRowOptions;
	/** Lines another part drew, taken as they are. */
	raw?: InlineRow;
	/** A line that can be pointed at, focused and clicked. */
	key?: string;
	onClick?: () => void;
	reveal?: number;
}

const STEP_GLYPH_COLORS: Record<BoxRowKind, ThemeColor> = {
	think: "kindThink",
	say: "timelineFaint",
	cmd: "kindCommand",
	read: "kindRead",
	edit: "kindEdit",
	memory: "kindMemory",
	subagent: "kindSubagent",
	step: "kindRead",
	retry: "kindRecovered",
	compact: "timelineFaint",
	error: "timelineFix",
	steer: "timelineUser",
	notice: "timelineFaint",
};

/** A step's words on one line. */
function stepWords(row: BoxRow): string {
	const gap = row.text && row.keyword && !row.keyword.endsWith("：") ? " " : "";
	return sanitizeDisplayText(`${row.keyword ?? ""}${gap}${row.text}`)
		.replace(/\s+/g, " ")
		.trim();
}

/** A row's own meta color as the timeline's color for its status. */
function statusColor(meta: MetaPart): ThemeColor {
	if (meta.text.startsWith("✓")) return "timelineFaint";
	if (meta.color === "diffAddedText") return "timelineOk";
	if (meta.color === "diffRemovedText" || meta.color === "error") return "timelineMust";
	if (meta.color === "runCardWarn") return "timelineFix";
	if (meta.color === "memoryAccent") return "timelineMemory";
	return "timelineFaint";
}

/** The right side of a step: its result, and how long it took. */
function stepStatus(row: BoxRow, now: number): string {
	if (row.kind === "error") {
		return row.persistent ? theme.fg("timelineMust", "出错了") : theme.fg("timelineFix", "下一格改好了");
	}
	if (row.status === "running") {
		return row.startedAt !== undefined
			? theme.fg("timelineFaint", formatBoxDuration(Math.max(0, now - row.startedAt)))
			: "";
	}
	const took =
		row.startedAt !== undefined && row.endedAt !== undefined && row.endedAt - row.startedAt >= 1000
			? formatBoxDuration(row.endedAt - row.startedAt)
			: undefined;
	if (row.status === "failed") {
		// `4 个失败  38秒`: the result and the time in one red, no mark.
		const words = row.meta
			.map((entry) => entry.text)
			.join("")
			.replace(/^✗\s*/, "");
		return theme.fg("timelineMust", [words, took].filter((part) => part).join("  "));
	}
	const onlyDone = row.meta.length === 1 && row.meta[0]?.text === "✓ 完成";
	const parts = onlyDone && took ? [{ text: "✓", color: row.meta[0]?.color ?? "diffAddedText" }] : row.meta;
	const meta = parts.map((entry) => theme.fg(statusColor(entry), entry.text)).join("");
	if (!took) return meta;
	return `${meta}${meta ? " " : ""}${theme.fg("timelineFaint", took)}`;
}

/** What stays of a step's right side on a narrow line: its ✓ or ✗ when it has one, nothing otherwise. */
function stepMark(row: BoxRow): string {
	if (row.kind === "error" || row.status === "running") return "";
	if (row.status === "failed") return `${theme.fg("timelineMust", "✗")}  `;
	return row.meta[0]?.text.startsWith("✓") ? `${theme.fg("timelineFaint", "✓")}  ` : "";
}

/** A color that resets the background (or everything) inside a painted line. */
const BG_RESET = /\x1b\[(?:0|49)?m/g;

/** The whole line on the hover color, out to the last column. */
function paintHover(content: string, width: number): string {
	const fitted = truncateToWidth(content, width, "…", true);
	const open = theme.getBgAnsi("timelineHoverBg");
	return `${open}${fitted.replace(BG_RESET, (reset) => `${reset}${open}`)}\x1b[49m`;
}

/** The right side of an event's line: its step count and the arrow. */
function eventRight(steps: number, open: boolean): string {
	const count = steps > 0 ? theme.fg("timelineFaint", `${steps} 步 `) : "";
	return `${count}${theme.bold(theme.fg(open ? "timelineAi" : "timelineFaint", open ? "▴" : "▸"))}`;
}

/** Rows a click on a closed line asks the window to show below it. */
const EVENT_REVEAL = EVENT_STEPS_SHOWN + 1;
const STEP_REVEAL = 8;

/**
 * Render the timeline. What is open, what the pointer is on and the lane each
 * line was first drawn with all live on the timeline's UI state.
 */
export function renderTurnBox(input: BoxRenderInput): BoxRenderResult {
	const { timeline, width, now } = input;
	const ui = timeline.ui;
	const specs: LineSpec[] = [];
	const tracker = input.lanes;
	// A line is on the lane when a subagent went out before its time and was not back by then, so a
	// line reads the same whenever it is drawn, and in a replay as in the live view.
	const spans = timeline.laneSpans ?? tracker?.spans;
	const laneAt = (at: number, atDispatch = false): TimelineLane =>
		tracker && spans?.outAt(at > 0 ? at : Number.POSITIVE_INFINITY, atDispatch) ? "on" : "off";
	const laneOfEvent = (index: number): TimelineLane => laneAt(input.events[index]?.at ?? 0);
	const toggle = (key: string) => () => {
		if (ui.expanded.has(key)) {
			ui.expanded.delete(key);
			if (key.startsWith("ev:")) ui.expanded.delete(`all:${key}`);
		} else {
			ui.expanded.add(key);
		}
		ui.bump();
		if (key.startsWith("ev:")) input.onToggleEvent?.();
		input.onChange();
	};
	const gap = (lane: TimelineLane): void => {
		specs.push({ gutter: { main: "rail", lane }, content: "" });
	};
	const inline = [...(input.inline ?? [])].sort((a, b) => a.at - b.at);
	let nextInline = 0;
	/** The rows that landed before `before` (all of them for `Infinity`). */
	const flushInline = (before: number): void => {
		for (let row = inline[nextInline]; row && row.at < before; row = inline[nextInline]) {
			nextInline += 1;
			// A row keeps a blank row above itself; two empty rows already there are enough.
			const shared = trailingGaps() >= 2 && startsWithRailGap(row.lines[0]);
			specs.push({
				gutter: { main: "rail" },
				content: "",
				raw: shared
					? {
							...row,
							lines: row.lines.slice(1),
							regions: row.regions
								.map((region) => ({ ...region, line: region.line - 1 }))
								.filter((region) => region.line >= 0),
						}
					: row,
			});
		}
	};
	/** How many empty main-line rows end the lines so far. */
	const trailingGaps = (): number => {
		let count = 0;
		for (let index = specs.length - 1; index >= 0; index--) {
			const spec = specs[index];
			if (!spec || spec.raw || spec.gutter.main !== "rail" || spec.content !== "") break;
			count += 1;
		}
		return count;
	};
	const bodyWidth = Math.max(8, width - TIMELINE_CONTENT_COL - 2);
	const detailWidth = Math.max(8, bodyWidth - STEP_INDENT - STEP_GLYPH_COLS);

	if (input.events.length > 0 || input.tail || inline.length > 0) {
		const firstAt = input.events[0]?.at ?? input.tail?.at ?? 0;
		for (let row = 0; row < (input.leadingRows ?? 0); row++) gap(laneAt(firstAt));
	}

	const folds = foldedEventRuns(
		input.events,
		inline.map((row) => row.at),
		pinnedEventKeys(input.events, ui),
		ui.expanded,
	);
	const runStart = new Map<number, number>();
	for (const run of folds) for (const index of run) runStart.set(index, run[0] ?? index);
	input.events.forEach((event, index) => {
		flushInline(event.at);
		const lane = laneOfEvent(index);
		const start = runStart.get(index);
		if (start !== undefined) {
			const foldKey = foldKeyOf(input.events[start]);
			const unfolded = ui.expanded.has(foldKey);
			if (index === start) {
				const count = folds.find((run) => run[0] === start)?.length ?? 0;
				specs.push({
					gutter: { main: "rail", lane },
					content: theme.fg("timelineFaint", `⋯  中间还有 ${count} 件事`),
					right: unfolded
						? `${theme.bold(theme.fg("timelineAi", "▴"))} ${theme.fg("timelineFaint", "收起")}`
						: `${theme.fg("timelineFaint", `${count} 件事 `)}${theme.bold(theme.fg("timelineFaint", "▸"))}`,
					key: foldKey,
					onClick: toggle(foldKey),
					reveal: unfolded ? 0 : EVENT_REVEAL,
				});
			}
			if (!unfolded) return;
		}
		const time = event.at > 0 ? formatTimelineTime(event.at) : undefined;
		const detailRow = event.row;
		// Words the line cuts (or paragraphs it leaves out) open to the whole text.
		const textRoom =
			event.steps.length > 0
				? width - TIMELINE_CONTENT_COL - visibleWidth(eventRight(event.steps.length, false)) - 4
				: width - TIMELINE_CONTENT_COL;
		// The AI's own words keep their bold and drop their backticks; an error line is plain text.
		const color: ThemeColor = event.kind === "fail" ? "timelineMust" : "text";
		const words = truncateToWidth(
			event.kind === "fail" ? theme.fg(color, event.text) : styleInlineMarkdown(event.text, color),
			Math.max(1, width),
			"",
		);
		const more = event.full !== undefined && (eventSaysMore(event) || visibleWidth(words) > textRoom);
		const failDetail = event.kind === "fail" && detailRow?.detail !== undefined;
		const openable = event.steps.length > 0 || more || failDetail;
		const open = openable && ui.expanded.has(event.key);
		const fullLines =
			open && more && event.full
				? wrapTextWithAnsi(styleInlineMarkdown(sanitizeDisplayText(event.full), "timelineSoft"), bodyWidth)
				: [];
		if (event.kind === "steer") {
			specs.push({
				gutter: { ...(time ? { time } : {}), main: "user", lane },
				content: `${theme.bold(theme.fg("timelineUser", "你插话"))}   ${theme.fg("text", event.text)}`,
			});
			return;
		}
		specs.push({
			gutter: { ...(time ? { time } : {}), main: "ai", lane },
			content: words,
			...(openable
				? {
						right: eventRight(event.steps.length, open),
						key: event.key,
						onClick: toggle(event.key),
						reveal: open ? 0 : EVENT_REVEAL,
					}
				: {}),
		});
		if (open) {
			for (const line of fullLines) specs.push({ gutter: { main: "rail", lane }, content: line });
			if (failDetail && detailRow?.detail) {
				for (const line of detailRow.detail(bodyWidth))
					specs.push({ gutter: { main: "rail", lane }, content: line });
			}
			const allOpen = ui.expanded.has(`all:${event.key}`);
			const listed = allOpen ? event.steps : event.steps.slice(0, EVENT_STEPS_SHOWN);
			for (const step of listed) {
				const stepOpen = ui.expanded.has(step.key);
				const running = step.status === "running";
				const glyphColor: ThemeColor = running
					? "timelineLive"
					: step.kind === "error"
						? step.persistent
							? "timelineMust"
							: "timelineFix"
						: step.status === "stopped"
							? "timelineFaint"
							: STEP_GLYPH_COLORS[step.kind];
				const glyph = running ? spinnerFrame(input.tick) : step.glyph;
				specs.push({
					gutter: { main: "rail", lane },
					content: `${" ".repeat(STEP_INDENT)}${theme.bold(theme.fg(glyphColor, glyph))}  ${theme.fg("timelineTime", stepWords(step))}`,
					right: `${stepStatus(step, now)}  `,
					fit: { minContent: STEP_INDENT + STEP_GLYPH_COLS + STEP_WORDS_MIN, short: stepMark(step) },
					key: step.key,
					onClick: toggle(step.key),
					reveal: stepOpen ? 0 : STEP_REVEAL,
				});
				if (stepOpen && step.detail) {
					for (const line of step.detail(detailWidth)) {
						specs.push({
							gutter: { main: "rail", lane },
							content: `${" ".repeat(STEP_INDENT + STEP_GLYPH_COLS)}${line}`,
						});
					}
				}
			}
			const hidden = event.steps.length - listed.length;
			// Once every step is listed the same line stays, saying how many there are, and folds the list back.
			if (hidden > 0 || (allOpen && event.steps.length > EVENT_STEPS_SHOWN)) {
				specs.push({
					gutter: { main: "rail", lane },
					content: `${" ".repeat(STEP_INDENT)}${theme.bold(theme.fg("timelineFaint", "⋯"))}  ${theme.fg("timelineTime", hidden > 0 ? `另外 ${hidden} 步` : `共 ${event.steps.length} 步`)}`,
					right: `${theme.fg("timelineFaint", hidden > 0 ? "全部 ›" : "▴ 收起")}  `,
					key: `all:${event.key}`,
					onClick: toggle(`all:${event.key}`),
					reveal: Math.min(hidden, STEP_REVEAL),
				});
			}
		}
		if (event.spawned.length > 0) {
			specs.push({
				gutter: { main: "split", lane: tracker ? "split" : "off" },
				content: `${theme.bold(theme.fg("timelineSub", "◇"))}  ${theme.fg("timelineSoft", event.spawned.map((sub) => (sub.tag ? `${shortAgentName(sub.name)} ${sub.tag}` : shortAgentName(sub.name))).join("   "))}`,
			});
			gap(event.spawned.some((sub) => laneAt(sub.startedAt, true) === "on") ? "on" : "off");
		}
	});

	flushInline(Number.POSITIVE_INFINITY);
	const tail = input.tail;
	if (tail) {
		const last = specs.at(-1);
		if (last && !(last.gutter.main === "rail" && last.content === "" && !last.raw)) gap(tracker?.lane ?? "off");
		const lane = tracker?.lane ?? "off";
		const stepNote = tail.stepCount > 0 ? theme.fg("timelineFaint", `第 ${tail.stepCount} 步`) : "";
		specs.push({
			gutter: {
				...(tail.at > 0 ? { time: formatTimelineTime(tail.at) } : {}),
				main: "spin",
				lane,
				spinner: spinnerFrame(input.tick),
			},
			content: theme.bold(theme.fg("timelineLive", tail.text)),
			...(stepNote ? { right: stepNote } : {}),
		});
		const elapsed =
			tail.running?.startedAt !== undefined
				? formatBoxDuration(Math.max(0, now - tail.running.startedAt))
				: undefined;
		if (tail.running || tail.waiting) {
			specs.push({
				gutter: { main: "tip", lane },
				content: theme.fg(
					"timelineTime",
					`${" ".repeat(STEP_INDENT)}${tail.running ? `${TIP_LABEL}${tail.running.text}` : (tail.waiting ?? "")}`,
				),
				...(elapsed ? { right: `${theme.fg("timelineFaint", elapsed)}  ` } : {}),
				// Its clock goes before the command is cut below what a step line keeps.
				fit: { minContent: STEP_INDENT + visibleWidth(TIP_LABEL) + STEP_WORDS_MIN, short: "" },
			});
		}
		const pending = tracker?.pending ?? [];
		if (pending.length > 0) {
			const shown = new Map(
				input.events.flatMap((event) => event.spawned.map((sub) => [sub.laneName, sub.name] as const)),
			);
			specs.push({ gutter: { main: "tip", lane }, content: "" });
			specs.push({
				gutter: { main: "blank", lane },
				content: theme.fg(
					"timelineLane",
					`${pending.map((key) => shortAgentName(shown.get(key) ?? key)).join("、")} 还在干活`,
				),
			});
		}
	}

	const focusOrder = specs.flatMap((spec) => (spec.key !== undefined ? [spec.key] : []));
	const focusKey = ui.focused
		? ui.focusKey === "header" || ui.focusKey === undefined
			? focusOrder[0]
			: ui.focusKey
		: undefined;
	const lines: string[] = [];
	const regions: ClickRegion[] = [];
	const firstVisible = specs.findIndex((spec) => spec.content !== "" || spec.raw !== undefined);
	specs.forEach((spec, index) => {
		const line = lines.length;
		if (spec.raw) {
			lines.push(...spec.raw.lines);
			for (const region of spec.raw.regions) regions.push({ ...region, line: line + region.line });
			return;
		}
		const right = input.dropFirstRight && index === firstVisible ? "" : (spec.right ?? "");
		const text = timelineRow(spec.gutter, spec.content, right, width, spec.fit);
		const key = spec.key;
		const focused = key !== undefined && key === focusKey;
		const lit = key !== undefined && (focused || ui.hoverKey === key);
		lines.push(`${focused ? BOX_FOCUS_MARKER : ""}${lit ? paintHover(text, width) : text}`);
		if (key === undefined || !spec.onClick) return;
		regions.push({
			line,
			col: 0,
			width: Math.max(1, Math.floor(width)),
			height: 1,
			revealBelow: Math.min(input.revealRows, spec.reveal ?? 0),
			onClick: spec.onClick,
			hoverKey: `${ui.id}:${key}`,
			onHover: (hovered: boolean) => {
				if (ui.setHover(key, hovered)) input.onChange();
			},
		});
	});
	return { lines: fitBoxLines(lines, width), regions, focusOrder };
}
