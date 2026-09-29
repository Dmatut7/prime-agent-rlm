import {
	type Component,
	Container,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentSessionMessage } from "../../../core/agent-messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { formatTimelineTime, TIMELINE_CONTENT_COL, type TimelineLane, timelineRow } from "./timeline-gutter.js";
import { type LaneSnapshot, TimelineLaneTracker } from "./timeline-lane.js";

function collapseText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** `◆ <label> · <participant>[ · <preview>]` summary line shared by received and sent agent-message UI. */
export function agentMessageSummaryLine(label: string, participant: string, preview?: string): string {
	const parts = [`${theme.fg("accent", "◆")} ${theme.fg("muted", label)}`, theme.fg("muted", participant)];
	if (preview) {
		parts.push(theme.fg("muted", preview));
	}
	return parts.join(theme.fg("dim", " · "));
}

/**
 * The row of a message received from another agent: `◇ <name> 交回：<preview>`
 * from a subagent the receiver started, `◇ <name> 发来：<preview>` from anyone
 * else (`◆` is prime's own mark). Without a preview the row is just the head.
 */
export function receivedAgentMessageLine(name: string, verb: "交回" | "发来", preview?: string): string {
	const head = `${theme.fg("kindSubagent", "◇")} ${theme.fg("kindSubagent", name)} ${theme.fg("muted", verb)}`;
	return preview ? `${head}${theme.fg("muted", `：${preview}`)}` : head;
}

/** Who sent a message, as its row names them; the same fallbacks the participant label uses. */
export function agentMessageSenderName(from: AgentSessionMessage["details"]["from"]): string {
	return (
		from?.sessionName?.trim() ||
		from?.activeSessionId?.trim() ||
		from?.clientId?.trim() ||
		from?.sessionId?.trim() ||
		"unknown"
	);
}

/** Single-line message preview sized to fit after the summary-line prefix. */
export function agentMessagePreview(prefixWidth: number, message: string): string {
	return truncateToWidth(collapseText(message), Math.max(20, 100 - prefixWidth));
}

/** `╰─`-guttered message body lines shared by received and sent agent-message UI. */
export function agentMessageBodyLines(message: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const textWidth = Math.max(1, safeWidth - 4);
	const bodyLines = message.split("\n").flatMap((line) => {
		const wrapped = wrapTextWithAnsi(line, textWidth);
		return wrapped.length > 0 ? wrapped : [""];
	});
	return bodyLines.map((line, index) => {
		const prefix = index === 0 ? theme.fg("dim", "╰─ ") : "   ";
		return truncateToWidth(` ${prefix}${theme.fg("customMessageText", line)}`, safeWidth, "");
	});
}

/**
 * A subagent named like `review-grow-B-box` reads as `B` on the timeline, the
 * way a dispatch row names it; any other name stays whole.
 */
export function shortAgentName(name: string): string {
	const letters = name.split(/[-_ .]+/).filter((part) => /^[A-Za-z]$/.test(part));
	const only = letters.length === 1 ? letters[0] : undefined;
	return only ? only.toUpperCase() : name;
}

const NEGATED_LEVEL =
	/(?:无|没有|没|不存在|no|zero|0\s*[条个])\s*(?:(?:P[01]|必修|要修|must|should)(?:\s*(?:[/、,，和及&]|and|or)\s*(?:无|没有|no)?\s*)?)+/gi;
const MUST_LEVEL = /(?<![A-Za-z0-9])P0(?![0-9])|必修|\bmust\b/i;
const FIX_LEVEL = /(?<![A-Za-z0-9])P1(?![0-9])|要修|\bshould\b/i;

/** How bad a verdict reads: a P0 or 必修 must be fixed, a P1 or 要修 should be; "无 P0" says neither. */
export function verdictLevel(text: string): "must" | "fix" | "ok" {
	const claimed = text.replace(NEGATED_LEVEL, " ");
	if (MUST_LEVEL.test(claimed)) return "must";
	if (FIX_LEVEL.test(claimed)) return "fix";
	return "ok";
}

const CONCLUSION_LINE = /^[#>\-\s*]*(?:一句话结论|结论|结果|Conclusion|Verdict|Result)\s*[:：]\s*(.*)$/i;
const LABEL_IN_FIRST_LINE = /^[^（(：:]{0,24}[（(]([^）)]{2,40})[）)]/;

function firstSentence(text: string): string {
	const cut = text.search(/[。！？!?；;]|\.(?:\s|$)/);
	return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * What a report says on its one row: the task it is about (the bracketed words
 * after the lane name, `车道B（盒子生长）审查完成`) and its conclusion (the first
 * sentence after `结论：`, else the first sentence). Display only.
 */
export function reportParts(message: string): { label?: string; conclusion: string } {
	const lines = message
		.replace(/\*\*|`/g, "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const first = lines[0] ?? "";
	const labelMatch = LABEL_IN_FIRST_LINE.exec(first);
	const label = labelMatch?.[1]?.trim() || undefined;
	let conclusion: string | undefined;
	for (const [index, line] of lines.entries()) {
		const marked = CONCLUSION_LINE.exec(line);
		if (!marked) continue;
		conclusion = firstSentence(marked[1]?.trim() || lines[index + 1] || "");
		break;
	}
	if (!conclusion) {
		const rest = labelMatch ? first.slice(labelMatch[0].length).trim() : first;
		conclusion = firstSentence(rest) || firstSentence(first);
	}
	return { ...(label ? { label } : {}), conclusion: collapseText(conclusion) };
}

/**
 * The key a subagent is on the lane by: its session name, else `fallback` (its
 * active session id, which the dispatch side and the message side both know).
 * The dispatch registers it with `tracker.spawned([laneKey(child.sessionName,
 * child.activeSessionId)])` and a return releases it through `comeBack` with the
 * same two values; empty when there is neither, which never matches anyone.
 */
export function laneKey(sessionName?: string, fallback?: string): string {
	return sessionName?.trim() || fallback?.trim() || "";
}

/** How a subagent left the lane: it handed a report back, failed, finished without a word, or was cancelled. */
export type ReturnKind = "report" | "failed" | "silent" | "cancelled";

/** Of the subagents that came back in a round, how many did so without handing a report back. */
export interface ReturnTally {
	failed: number;
	silent: number;
	cancelled: number;
}

const NO_TALLY: ReturnTally = { failed: 0, silent: 0, cancelled: 0 };

function hasTally(tally: ReturnTally): boolean {
	return tally.failed > 0 || tally.silent > 0 || tally.cancelled > 0;
}

/** What a lane knew at some moment: who was out, and how far the round that closes it had counted. */
export interface SubagentLaneSnapshot {
	lane: LaneSnapshot;
	back: number;
	tally: ReturnTally;
}

/**
 * Which subagents of a question are still out, and how many came back in this
 * round: the tracker draws the lane, the count words the row that closes it.
 */
export class SubagentLane {
	readonly tracker = new TimelineLaneTracker();
	private back = 0;
	private tally: ReturnTally = { ...NO_TALLY };

	/**
	 * A subagent handed back a report, failed or finished without a word (`kind`), named the way
	 * {@link laneKey} reads. A name that was not out has its return kept and joins nothing.
	 */
	comeBack(
		sessionName: string | undefined,
		fallback?: string,
		at?: number,
		kind: ReturnKind = "report",
	): TimelineReturn {
		const name = laneKey(sessionName, fallback);
		const wasOut = name !== "" && this.tracker.pending.includes(name);
		const before = this.tracker.lane;
		if (name !== "" && !wasOut) this.tracker.noteReturned(name, at);
		const result = wasOut ? this.tracker.reported(name, at) : this.tracker.lane;
		if (wasOut) {
			this.back += 1;
			if (kind !== "report") this.tally[kind] += 1;
		}
		const joined = wasOut && result === "join" ? this.back : undefined;
		const tally = joined !== undefined && hasTally(this.tally) ? { ...this.tally } : undefined;
		if (joined !== undefined) {
			this.back = 0;
			this.tally = { ...NO_TALLY };
		}
		return {
			before,
			after: this.tracker.lane,
			...(joined !== undefined ? { joined } : {}),
			...(tally ? { tally } : {}),
		};
	}

	/** A new question starts: nobody is out. */
	reset(): void {
		this.tracker.reset();
		this.back = 0;
		this.tally = { ...NO_TALLY };
	}

	snapshot(): SubagentLaneSnapshot {
		return { lane: this.tracker.snapshot(), back: this.back, tally: { ...this.tally } };
	}

	/** Take back what a rebuild's replay could not see of the question's lane (`since`: when that question began). */
	restore(previous: SubagentLaneSnapshot, since?: number): void {
		this.tracker.restore(previous.lane, since);
		this.back = Math.max(this.back, previous.back);
		this.tally = {
			failed: Math.max(this.tally.failed, previous.tally.failed),
			silent: Math.max(this.tally.silent, previous.tally.silent),
			cancelled: Math.max(this.tally.cancelled, previous.tally.cancelled),
		};
	}
}

/** How one return sits on the timeline. */
export interface TimelineReturn {
	/** The lane of the blank row above the return: dotted while others were still out. */
	before: TimelineLane;
	/** The lane of the rows below it (an opened report): dotted while others are still out. */
	after: TimelineLane;
	/** It was the last one out: how many came back, for the row that closes the lane. */
	joined?: number;
	/** With `joined`: how many of them did not hand a report back (absent when all did). */
	tally?: ReturnTally;
}

const NUMERALS = ["", "一", "两", "三", "四", "五", "六", "七", "八", "九", "十"];

/**
 * `四个都交回了`, `交回了` for a lone subagent. When some did not hand a report back the row says so:
 * `四个都回来了（1 个失败，1 个没发回消息）`, and a lone one says what it did (`失败了`).
 */
export function joinText(count: number, tally?: ReturnTally): string {
	const parts: string[] = [];
	if (tally && tally.failed > 0) parts.push(`${tally.failed} 个失败`);
	if (tally && tally.silent > 0) parts.push(`${tally.silent} 个没发回消息`);
	if (tally && tally.cancelled > 0) parts.push(`${tally.cancelled} 个已取消`);
	if (count <= 1) {
		if (tally && tally.failed > 0) return "失败了";
		if (tally && tally.silent > 0) return "做完了，没发回消息";
		if (tally && tally.cancelled > 0) return "已取消";
		return "交回了";
	}
	const number = NUMERALS[count] ?? String(count);
	return parts.length > 0 ? `${number}个都回来了（${parts.join("，")}）` : `${number}个都交回了`;
}

/** The row that closes the lane once the last subagent is back. */
export function joinRow(count: number, width: number, tally?: ReturnTally): string {
	return timelineRow({ main: "join", lane: "join" }, theme.fg("timelineFaint", joinText(count, tally)), "", width);
}

/** Paint a whole row on the pointer's background. */
export function hoverRow(row: string, width: number): string {
	return theme.bg("timelineHoverBg", truncateToWidth(row, Math.max(1, width), "", true));
}

class AgentMessageBodyComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly message: string) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines = agentMessageBodyLines(this.message, width);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export interface AgentMessageOptions {
	suppressLeadingSpace?: boolean;
	/** Draw the message as a row of the conversation's timeline (the quiet mode) instead of the legacy row. */
	timeline?: TimelineReturn;
}

export class AgentMessageComponent extends Container {
	private readonly content = new Container();
	private readonly header = new Text("", 1, 0);
	private suppressLeadingSpace: boolean;
	private readonly timeline: TimelineReturn | undefined;
	private expanded = false;
	private hovered = false;
	/** What the row says and the whole report under it, kept until the width, the lane or the theme changes. */
	private contentCache: string | undefined;
	private bodyCache: { width: number; lane: TimelineLane; rows: string[] } | undefined;

	constructor(
		private readonly message: AgentSessionMessage,
		_markdownTheme: MarkdownTheme = getMarkdownTheme(),
		options: AgentMessageOptions = {},
	) {
		super();
		this.suppressLeadingSpace = options.suppressLeadingSpace ?? false;
		this.timeline = options.timeline;
		if (!this.suppressLeadingSpace && !this.timeline) this.addChild(new Spacer(1));
		this.addChild(this.content);
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.timeline) return this.renderTimeline(width, this.timeline);
		const lines = super.render(width);
		const leadingSpace = !this.suppressLeadingSpace;
		this.clickRegions =
			lines.length > 0
				? [
						{
							line: leadingSpace ? 1 : 0,
							col: 0,
							width,
							height: this.header.render(width).length,
							onClick: () => this.setExpanded(!this.expanded),
						},
					]
				: [];
		return lines;
	}

	private renderTimeline(width: number, timeline: TimelineReturn): string[] {
		const safeWidth = Math.max(1, width);
		const rows: string[] = [];
		if (!this.suppressLeadingSpace)
			rows.push(timelineRow({ main: "rail", lane: timeline.before }, "", "", safeWidth));
		const headLine = rows.length;
		const head = timelineRow(
			{ time: formatTimelineTime(this.message.timestamp), main: "rail", lane: "sub" },
			this.timelineContent(),
			this.expanded ? theme.bold(theme.fg("timelineSub", "▴")) : theme.bold(theme.fg("timelineFaint", "›")),
			safeWidth,
		);
		rows.push(this.hovered ? hoverRow(head, safeWidth) : head);
		const body = this.timelineBody(safeWidth, timeline.after);
		if (this.expanded) rows.push(...body);
		if (timeline.joined !== undefined) rows.push(joinRow(timeline.joined, safeWidth, timeline.tally));
		const opens = body.length;
		this.clickRegions = [
			{
				line: headLine,
				col: 0,
				width: safeWidth,
				height: 1,
				revealBelow: this.expanded ? 0 : opens,
				onClick: () => this.setExpanded(!this.expanded),
				hoverKey: `agent-message:${this.message.details.id}`,
				onHover: (hovered) => {
					this.hovered = hovered;
				},
			},
		];
		return rows;
	}

	private timelineContent(): string {
		this.contentCache ??= this.buildTimelineContent();
		return this.contentCache;
	}

	private buildTimelineContent(): string {
		const name = shortAgentName(agentMessageSenderName(this.message.details.from));
		const fromChild = this.message.details.fromRelationship === "child";
		const who = theme.bold(theme.fg("timelineSub", `${name} ${fromChild ? "交回" : "发来"}`));
		const { label, conclusion } = reportParts(this.message.details.message);
		if (!conclusion && !label) return who;
		const level = fromChild ? verdictLevel(conclusion) : "ok";
		const color = level === "must" ? "timelineMust" : level === "fix" ? "timelineFix" : "timelineSoft";
		const task = label ? theme.fg("timelineTime", `   ${label}${conclusion ? "：" : ""}`) : "   ";
		return `${who}${task}${conclusion ? theme.fg(color, conclusion) : ""}`;
	}

	/** The whole report under its row, in the lane the rest of the timeline is in. */
	private timelineBody(width: number, lane: TimelineLane): string[] {
		const cached = this.bodyCache;
		if (cached && cached.width === width && cached.lane === lane) return cached.rows;
		const rows = this.buildTimelineBody(width, lane);
		this.bodyCache = { width, lane, rows };
		return rows;
	}

	private buildTimelineBody(width: number, lane: TimelineLane): string[] {
		const indent = 2;
		const room = Math.max(1, width - TIMELINE_CONTENT_COL - indent - 2);
		return this.message.details.message
			.replace(/\s+$/, "")
			.split("\n")
			.flatMap((line) => {
				const wrapped = wrapTextWithAnsi(line.trimEnd(), room);
				return wrapped.length > 0 ? wrapped : [""];
			})
			.map((line) =>
				timelineRow(
					{ main: "rail", lane },
					line ? `${" ".repeat(indent)}${theme.fg("timelineSoft", line)}` : "",
					"",
					width,
				),
			);
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.updateDisplay();
	}

	/** The row drawn straight above this one is another report: the two share one blank row. */
	joinPreviousRow(): void {
		this.suppressLeadingSpace = true;
	}

	override invalidate(): void {
		super.invalidate();
		this.contentCache = undefined;
		this.bodyCache = undefined;
		this.updateDisplay();
	}

	private updateDisplay(): void {
		// A timeline row draws itself; the legacy header is not built for it.
		if (this.timeline) return;
		this.content.clear();
		this.header.setText(this.headerText());
		this.content.addChild(this.header);
		if (this.expanded) {
			this.content.addChild(new AgentMessageBodyComponent(this.message.details.message));
		}
	}

	private headerText(): string {
		const name = agentMessageSenderName(this.message.details.from);
		const verb = this.message.details.fromRelationship === "child" ? "交回" : "发来";
		// U6: no per-line expand hint — the global tail line owns the Ctrl+O
		// affordance (the header row stays clickable).
		if (this.expanded) {
			return receivedAgentMessageLine(name, verb);
		}

		const prefixWidth = visibleWidth(`◇ ${name} ${verb}：`);
		const preview = agentMessagePreview(prefixWidth, this.message.details.message);
		return receivedAgentMessageLine(name, verb, preview);
	}
}
