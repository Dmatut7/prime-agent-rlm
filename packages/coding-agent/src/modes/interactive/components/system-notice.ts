import {
	type ClickRegion,
	type Component,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type CustomMessage,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
} from "../../../core/messages.js";
import { theme } from "../theme/theme.js";
import { hoverRow, joinRow, type SubagentLane, type TimelineReturn } from "./agent-message.js";
import { formatTimelineTime, TIMELINE_CONTENT_COL, timelineRow } from "./timeline-gutter.js";
import { timelineShowAll } from "./timeline-lane.js";
import { boxRecordFromMessage, type TimelineNotice } from "./turn-timeline.js";

/**
 * v3 chat layers: a routine system notice (memory updated, the Python kernel
 * restored, an automatic continue) as one centered, very faint line -
 * `·  ✦ memory updated  <summary>  ·  Ctrl+O diff  ·` - the way a chat app
 * says "someone joined", so it never competes with the user or the AI.
 */
export class SystemNoticeLine implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	/** `error`: something went wrong (a memory write that failed) - it must not read as routine. */
	constructor(
		private readonly label: string,
		private readonly detail = "",
		private readonly hint = "",
		private readonly tone: "notice" | "error" = "notice",
	) {}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const safeWidth = Math.max(1, width);
		const frame = "·  ";
		const tail = this.hint ? `  ·  ${this.hint}  ·` : "  ·";
		const fixed = visibleWidth(frame) + visibleWidth(this.label) + visibleWidth(tail);
		const room = safeWidth - fixed - 2;
		const detail = this.detail && room >= 8 ? `  ${truncateToWidth(this.detail, room, "…")}` : "";
		const plain = truncateToWidth(`${frame}${this.label}${detail}${tail}`, safeWidth, "…");
		const left = Math.max(0, Math.floor((safeWidth - visibleWidth(plain)) / 2));
		const lines = [" ".repeat(left) + theme.fg(this.tone === "error" ? "error" : "systemNotice", plain)];
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * A small thing that happened to a subagent (it finished without a word, was
 * cancelled, went quiet), as a row of the timeline. It stays out of sight until
 * the closing line's "完整过程 ▸" is on; a failure is shown, because the owner
 * needs it. When it is the last subagent out, the row that closes the lane
 * shows either way.
 */
export class TimelineNoticeRow implements Component {
	private expanded = false;
	private hovered = false;
	private regions: ClickRegion[] = [];

	constructor(
		private readonly notice: TimelineNotice,
		private readonly at: number,
		private readonly options: { shown: boolean; back: TimelineReturn; hoverKey: string },
	) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const { back } = this.options;
		const close = back.joined !== undefined ? [joinRow(back.joined, safeWidth)] : [];
		this.regions = [];
		if (!this.options.shown && !timelineShowAll.value) return close;
		const failed = this.notice.tone === "error";
		const time = formatTimelineTime(this.at);
		const hasDetail = this.notice.detail !== undefined;
		const open = this.expanded && hasDetail;
		const mark = !hasDetail
			? ""
			: failed
				? theme.bold(theme.fg(open ? "timelineSub" : "timelineFaint", open ? "▴" : "›"))
				: theme.fg("timelineFaint", open ? "▴" : "▸");
		const text = failed
			? theme.fg("timelineMust", this.notice.text)
			: theme.fg(this.notice.tone === "warn" ? "timelineFix" : "timelineTime", this.notice.text);
		const head = failed
			? timelineRow({ time, main: "rail", lane: "sub" }, text, mark, safeWidth)
			: timelineRow({ time, main: "note", lane: back.after }, text, mark, safeWidth);
		const rows = [this.hovered && hasDetail ? hoverRow(head, safeWidth) : head];
		if (open) {
			const room = Math.max(1, safeWidth - TIMELINE_CONTENT_COL - 4);
			const lines = (this.notice.detail ?? "").split("\n").flatMap((line) => {
				const wrapped = wrapTextWithAnsi(line.trimEnd(), room);
				return wrapped.length > 0 ? wrapped : [""];
			});
			for (const line of lines) {
				const content = line ? `  ${theme.fg("timelineSoft", line)}` : "";
				rows.push(timelineRow({ main: "rail", lane: back.after }, content, "", safeWidth));
			}
		}
		if (hasDetail) {
			this.regions = [
				{
					line: 0,
					col: 0,
					width: safeWidth,
					height: 1,
					onClick: () => {
						this.expanded = !this.expanded;
					},
					hoverKey: this.options.hoverKey,
					onHover: (hovered) => {
						this.hovered = hovered;
					},
				},
			];
		}
		return [...rows, ...close];
	}

	/** The row is out of sight now: nothing of it is drawn, not even the line that closes the lane. */
	get drawsNothing(): boolean {
		return !this.options.shown && !timelineShowAll.value && this.options.back.joined === undefined;
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}

	invalidate(): void {}
}

/** Whether a message is one of the notices that tell the AI a subagent it waits on ended, failed or went quiet. */
export function isSubagentNoticeMessage(message: { role: string; customType?: string }): boolean {
	return (
		message.role === "custom" &&
		(message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE)
	);
}

/**
 * The timeline row for a subagent notice (its terminal, failure and stall
 * notices), releasing the subagent from the lane when the notice says it is no
 * longer out. Undefined for any other message.
 */
export function subagentNoticeRow(message: CustomMessage, lane: SubagentLane): TimelineNoticeRow | undefined {
	if (!isSubagentNoticeMessage(message)) return undefined;
	const type = message.customType;
	const record = boxRecordFromMessage(message);
	if (record?.kind !== "notice") return undefined;
	const name = (message.details as { sessionName?: unknown } | undefined)?.sessionName;
	const stillOut = type === RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE || typeof name !== "string";
	const back: TimelineReturn = stillOut
		? { before: lane.tracker.lane, after: lane.tracker.lane }
		: lane.comeBack(name.trim());
	const id = (message.details as { childId?: unknown } | undefined)?.childId;
	return new TimelineNoticeRow(record.notice, Number(message.timestamp) || Date.now(), {
		shown: record.notice.tone === "error",
		back,
		hoverKey: `subagent-notice:${typeof id === "string" ? id : message.timestamp}`,
	});
}
