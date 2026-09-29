import { CONTENT_START_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.js";

/**
 * The timeline's left columns, shared by every component drawn on it so they
 * line up exactly: ` HH:MM   ` (9 columns), the AI's line (1 column), the
 * subagent lane (3 columns), three spaces, then the content at column 16.
 *
 * ```
 *  18:48   ◆      范围定了：16 个提交、96 个文件。派四个代理并行审查。
 *          ├──╮   ◇  A 钉住框头   B 框的折叠   C 子代理小块   D 测试和发版
 *          │  ┆
 *  18:54   │  ◇   B 交回   框的长高和折叠：没问题（7 条小建议）            ›
 * ```
 */
export const TIMELINE_TIME_WIDTH = 9;
export const TIMELINE_CONTENT_COL = 16;

/** What sits on the AI's line at this row. */
export type TimelineMain =
	| "rail"
	| "user"
	| "ai"
	| "spin"
	| "answer"
	| "memory"
	| "memoryBar"
	| "note"
	| "end"
	| "split"
	| "join"
	| "tip"
	| "blank";

/** What sits in the subagent lane at this row. */
export type TimelineLane = "off" | "on" | "sub" | "split" | "join";

export interface TimelineGutter {
	/** `HH:MM`, shown only on rows that start something. */
	time?: string;
	main: TimelineMain;
	lane?: TimelineLane;
	/** The spinner frame for `main: "spin"`. */
	spinner?: string;
}

const MAIN: Record<Exclude<TimelineMain, "spin">, { glyph: string; color: ThemeColor; bold?: boolean }> = {
	rail: { glyph: "│", color: "timelineRail" },
	user: { glyph: "●", color: "timelineUser", bold: true },
	ai: { glyph: "◆", color: "timelineAi", bold: true },
	answer: { glyph: "┃", color: "timelineAi" },
	memory: { glyph: "✦", color: "timelineMemory", bold: true },
	memoryBar: { glyph: "┃", color: "timelineMemory" },
	note: { glyph: "·", color: "timelineFaint" },
	end: { glyph: "╵", color: "timelineRail" },
	split: { glyph: "├", color: "timelineRail" },
	join: { glyph: "├", color: "timelineRail" },
	tip: { glyph: "╎", color: "timelineFaint" },
	blank: { glyph: " ", color: "timelineRail" },
};

const LANE: Record<TimelineLane, { text: string; color: ThemeColor; bold?: boolean }> = {
	off: { text: "   ", color: "timelineRail" },
	on: { text: "  ┆", color: "timelineLane" },
	sub: { text: "  ◇", color: "timelineSub", bold: true },
	split: { text: "──╮", color: "timelineRail" },
	join: { text: "──╯", color: "timelineRail" },
};

/** `HH:MM` in local time, the timeline's time stamp. */
export function formatTimelineTime(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The 16 styled columns in front of a timeline row's content, then a zero-width mark where the content starts so a drag-copy leaves the gutter out. */
export function timelineGutter(gutter: TimelineGutter): string {
	const time = gutter.time
		? theme.fg("timelineTime", ` ${gutter.time.padEnd(5)}   `)
		: " ".repeat(TIMELINE_TIME_WIDTH);
	let main: string;
	if (gutter.main === "spin") {
		main = theme.bold(theme.fg("timelineLive", gutter.spinner ?? "⠹"));
	} else {
		const spec = MAIN[gutter.main];
		main = spec.bold ? theme.bold(theme.fg(spec.color, spec.glyph)) : theme.fg(spec.color, spec.glyph);
	}
	const laneSpec = LANE[gutter.lane ?? "off"];
	const lane = laneSpec.bold
		? theme.bold(theme.fg(laneSpec.color, laneSpec.text))
		: theme.fg(laneSpec.color, laneSpec.text);
	return `${time}${main}${lane}   ${CONTENT_START_MARKER}`;
}

export interface TimelineRowOptions {
	/** Columns the content keeps at least (all of it when it is shorter) before its right side is shortened; default 0, the content gives way first. */
	minContent?: number;
	/** What stays of the right side when the whole does not fit: its last word unless said (`""`: nothing). */
	short?: string;
}

/**
 * One timeline row fitted to `width`: the gutter, the content, and `right`
 * pushed to the right edge with two trailing spaces. The content gives way
 * first, down to `minContent` columns; then the right side gives way to its
 * short form (its last word unless said) and last to nothing (the content
 * takes the whole row).
 */
export function timelineRow(
	gutter: TimelineGutter,
	content: string,
	right = "",
	width = 80,
	options: TimelineRowOptions = {},
): string {
	const head = timelineGutter(gutter);
	const room = Math.max(0, width - TIMELINE_CONTENT_COL);
	const trimmed = right.replace(/\s+$/, "");
	// A right side with nothing visible in it (blanks, an empty colored run) takes no columns.
	const forms =
		visibleWidth(trimmed) > 0 ? [right, options.short ?? trimmed.slice(trimmed.lastIndexOf(" ") + 1)] : [""];
	const keep = Math.min(options.minContent ?? 0, visibleWidth(content));
	for (const form of forms) {
		const tail = form ? `${form}  ` : "";
		const tailWidth = visibleWidth(tail);
		if (tailWidth + 2 > room) continue;
		if (tail && room - tailWidth - 2 < keep) continue;
		const fitted = truncateToWidth(content, room - tailWidth - (tail ? 2 : 0), "…");
		const pad = Math.max(tail ? 2 : 0, room - visibleWidth(fitted) - tailWidth);
		return `${head}${fitted}${tail ? " ".repeat(pad) + tail : ""}`;
	}
	return truncateToWidth(`${head}${content}`, Math.max(1, width), "…");
}
