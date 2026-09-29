import { type ClickRegion, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.js";
import { spinnerFrame } from "../theme/working-icon.js";
import { sanitizeDisplayText } from "./diff-rows.js";
import {
	formatTimelineTime,
	TIMELINE_CONTENT_COL,
	type TimelineGutter,
	type TimelineLane,
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
	firstSentence,
	formatBoxDuration,
	lastCompletedSentence,
	type TimelineUiState,
	type TurnTimeline,
} from "./turn-timeline.js";

/**
 * A turn drawn on the timeline: one line per thing the AI said it does or found
 * (`HH:MM ◆ words`), with the commands, thoughts and edits behind it folded into
 * `N 步 ▸`. An opened event lists its first three steps and `⋯ 另外 N 步   全部 ›`;
 * an opened step lists what it printed. Subagents the turn dispatched get one
 * `├──╮` line; a turn still running ends on `⠹ 正在…` and the command running now.
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
/** Columns of a step's content in front of its glyph. */
const STEP_INDENT = 5;
/** Columns a step's glyph and its gap take in front of the words. */
const STEP_GLYPH_COLS = 3;

/** Narrowest width the timeline is drawn at. */
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
			if (item?.type === "thinking" && (item.thinking ?? "").trim()) return firstSentence(item.thinking ?? "");
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
	/** A blank line first: a turn a message woke, nothing else separates it from what is above. */
	leadingGap?: boolean;
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

/**
 * A subagent named like `review-grow-B-box` reads as `B` on the timeline, the way a
 * hand-back row names it; a name without exactly one single-letter part stays whole.
 */
export function shortAgentName(name: string): string {
	const letters = name.split(/[-_ .]+/).filter((part) => /^[A-Za-z]$/.test(part));
	const only = letters.length === 1 ? letters[0] : undefined;
	return only ? only.toUpperCase() : name;
}

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
	const onlyDone = row.meta.length === 1 && row.meta[0]?.text === "✓ 完成";
	const parts = onlyDone && took ? [{ text: "✓", color: row.meta[0]?.color ?? "diffAddedText" }] : row.meta;
	const meta = parts.map((entry) => theme.fg(statusColor(entry), entry.text)).join("");
	if (!took) return meta;
	return `${meta}${meta ? " " : ""}${theme.fg("timelineFaint", took)}`;
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

export function eventOpen(ui: TimelineUiState, key: string): boolean {
	return ui.expanded.has(key);
}

/**
 * Render the timeline. What is open, what the pointer is on and the lane each
 * line was first drawn with all live on the timeline's UI state.
 */
export function renderTurnBox(input: BoxRenderInput): BoxRenderResult {
	const { timeline, width, now } = input;
	const ui = timeline.ui;
	const specs: LineSpec[] = [];
	const tracker = input.lanes;
	const laneFor = (memoKey: string): TimelineLane => {
		if (!tracker) return "off";
		const known = ui.lanes.get(memoKey);
		if (known) return known;
		const lane = tracker.lane;
		ui.lanes.set(memoKey, lane);
		return lane;
	};
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
	const gap = (memoKey: string, lane: TimelineLane = laneFor(memoKey)): void => {
		specs.push({ gutter: { main: "rail", lane }, content: "" });
	};
	const bodyWidth = Math.max(8, width - TIMELINE_CONTENT_COL - 2);
	const detailWidth = Math.max(8, bodyWidth - STEP_INDENT - STEP_GLYPH_COLS);

	if (input.leadingGap && (input.events.length > 0 || input.tail)) gap("lead");

	input.events.forEach((event) => {
		const lane = laneFor(event.key);
		const time = event.at > 0 ? formatTimelineTime(event.at) : undefined;
		const detailRow = event.row;
		// Words the line cuts (or paragraphs it leaves out) open to the whole text.
		const textRoom =
			event.steps.length > 0
				? width - TIMELINE_CONTENT_COL - visibleWidth(eventRight(event.steps.length, false)) - 4
				: width - TIMELINE_CONTENT_COL;
		const words = event.text.length > width ? event.text.slice(0, Math.max(1, width)) : event.text;
		const more = event.full !== undefined && (eventSaysMore(event) || visibleWidth(words) > textRoom);
		const failDetail = event.kind === "fail" && detailRow?.detail !== undefined;
		const openable = event.steps.length > 0 || more || failDetail;
		const open = openable && ui.expanded.has(event.key);
		const fullLines = open && more && event.full ? wrapTextWithAnsi(sanitizeDisplayText(event.full), bodyWidth) : [];
		if (event.kind === "steer") {
			specs.push({
				gutter: { ...(time ? { time } : {}), main: "user", lane },
				content: `${theme.bold(theme.fg("timelineUser", "你插话"))}   ${theme.fg("text", event.text)}`,
			});
			return;
		}
		const color: ThemeColor = event.kind === "fail" ? "timelineMust" : "text";
		specs.push({
			gutter: { ...(time ? { time } : {}), main: "ai", lane },
			content: theme.fg(color, words),
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
			for (const line of fullLines)
				specs.push({ gutter: { main: "rail", lane }, content: theme.fg("timelineSoft", line) });
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
					content: `${" ".repeat(STEP_INDENT)}${theme.bold(theme.fg(glyphColor, glyph))}  ${theme.fg("timelineSoft", stepWords(step))}`,
					right: `${stepStatus(step, now)}  `,
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
			if (hidden > 0) {
				specs.push({
					gutter: { main: "rail", lane },
					content: `${" ".repeat(STEP_INDENT)}${theme.bold(theme.fg("timelineFaint", "⋯"))}  ${theme.fg("timelineSoft", `另外 ${hidden} 步`)}`,
					right: `${theme.fg("timelineFaint", "全部 ›")}  `,
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
			gap(`gap:${event.key}`);
		}
	});

	const tail = input.tail;
	if (tail) {
		const last = specs.at(-1);
		if (last && !(last.gutter.main === "rail" && last.content === "")) gap("tail");
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
					`${" ".repeat(STEP_INDENT)}${tail.running ? `在跑  ${tail.running.text}` : (tail.waiting ?? "")}`,
				),
				...(elapsed ? { right: `${theme.fg("timelineFaint", elapsed)}  ` } : {}),
			});
		}
		const pending = tracker?.pending ?? [];
		if (pending.length > 0) {
			specs.push({ gutter: { main: "tip", lane }, content: "" });
			specs.push({
				gutter: { main: "blank", lane },
				content: theme.fg("timelineLane", `${pending.map(shortAgentName).join("、")} 还在干活`),
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
	const firstVisible = specs.findIndex((spec) => spec.content !== "");
	specs.forEach((spec, line) => {
		const right = input.dropFirstRight && line === firstVisible ? "" : (spec.right ?? "");
		const text = timelineRow(spec.gutter, spec.content, right, width);
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
