import { type ClickRegion, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatSpendCost } from "../spend-format.js";
import { theme } from "../theme/theme.js";
import { shortMemoryTitle, symlinkVerb } from "./feed-data.js";
import { memoryBodyLines, memoryHeadLabel } from "./memory-detail.js";
import { slideCount } from "./motion.js";
import { formatTimelineTime, TIMELINE_CONTENT_COL, type TimelineGutter, timelineRow } from "./timeline-gutter.js";
import { timelineShowAll } from "./timeline-lane.js";
import { changeDetail, changeTotals, omittedDiffText, type TimelineFacts } from "./timeline-rows.js";
import { BOX_FOCUS_MARKER } from "./turn-box.js";
import type { TurnTimeline } from "./turn-timeline.js";

/**
 * What a finished turn leaves at the end of the timeline, in the order the
 * design draws it:
 *
 * ```
 *  19:05   ·      ✎ 改了 2 个文件 +20 −7 · 已提交 abc1234           ▸
 *          │
 *  19:06   ✦      记住了   grow 批次审查结论                        ▴
 *          ┃      范围：merge/repl-kernel 的 16 个提交、96 个文件。
 *          │
 *          ╵      ✓ 用了 20 分钟 · 子代理 ¥4.20 · 全部 ¥9.80        完整过程 ▸
 * ```
 *
 * A memory opens with one click straight to its words; a file list opens to
 * the diffs. The last row closes the request and toggles the rows the timeline
 * hides by default.
 */

/** What the host knows about the session's spend, as the status line shows it. */
export interface StripSpend {
	/** Every subagent's own cost. */
	cost: number;
	/** The root's own cost; the total is `parentCost + cost`. */
	parentCost: number;
	/** A scan budget cut the count short: the figures are lower bounds. */
	partial?: boolean;
}

export interface StripSource {
	timeline: TurnTimeline;
	/** Facts of the finished turn; undefined while it still runs. */
	facts(): TimelineFacts | undefined;
	requestRender(): void;
	/** How long the request took, when the host knows it exactly; else it is read off the timeline. */
	elapsedMs?(): number | undefined;
	/** The session's spend; without it the closing row names no money. */
	spend?(): StripSpend | undefined;
	/** False while a later turn of the same request will close it (this turn then draws no closing row). */
	endsRequest?(): boolean;
}

export const STRIP_EDITS = "strip:edits";
export const STRIP_ALL = "strip:all";
const ITEM_PREFIX = "strip:item:";

/**
 * A path cut from the left to `width` columns at a directory boundary
 * (`…/components/turn-strip.ts`, then `…/turn-strip.ts`); a file name that
 * alone is too wide is cut at its end.
 */
export function shortenPath(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	const parts = path.split("/");
	for (let start = 1; start < parts.length; start++) {
		const candidate = `…/${parts.slice(start).join("/")}`;
		if (visibleWidth(candidate) <= width) return candidate;
	}
	return truncateToWidth(parts.at(-1) ?? path, width, "…");
}

/** Columns a path needs to keep its file name whole. */
function pathFloor(path: string): number {
	const parts = path.split("/");
	const name = parts.at(-1) ?? path;
	return Math.min(visibleWidth(path), parts.length > 1 ? visibleWidth(name) + 2 : visibleWidth(name));
}

/** `20 分钟`, `1 分 30 秒`, `45 秒`, `2 小时 5 分钟`. */
export function formatSpan(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 10 && seconds % 60 > 0) return `${minutes} 分 ${seconds % 60} 秒`;
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes % 60} 分钟`;
}

/** A stamp the kernel or the session wrote (epoch ms), as opposed to a counter standing in for one. */
function isStamp(at: number | undefined): at is number {
	return at !== undefined && at > 1e11;
}

/** The turn's span read off its own records: its first message to its finish (or last message). */
function timelineElapsedMs(timeline: TurnTimeline): number | undefined {
	const stamps: number[] = [];
	for (const entry of timeline.entries) {
		if (entry.kind === "message" && isStamp(entry.message.timestamp)) stamps.push(entry.message.timestamp);
		if ((entry.kind === "steer" || entry.kind === "notice") && isStamp(entry.at)) stamps.push(entry.at);
	}
	const first = stamps.length > 0 ? Math.min(...stamps) : undefined;
	const last = timeline.finishedAt ?? (stamps.length > 0 ? Math.max(...stamps) : undefined);
	if (first === undefined || last === undefined || last <= first) return undefined;
	return last - first;
}

/** The last message's stamp: the moment a fact without a stamp of its own is dated. */
function lastStamp(timeline: TurnTimeline): number | undefined {
	let last: number | undefined;
	for (const entry of timeline.entries) {
		if (entry.kind === "message" && isStamp(entry.message.timestamp)) {
			last = Math.max(last ?? 0, entry.message.timestamp);
		}
	}
	return last ?? (isStamp(timeline.finishedAt) ? timeline.finishedAt : undefined);
}

/** Columns the content may take when `right` sits at the row's end (what `timelineRow` leaves it). */
function contentLimit(width: number, right: string): number {
	const room = Math.max(0, width - TIMELINE_CONTENT_COL);
	if (!right) return room;
	const tail = visibleWidth(right) + 2;
	return tail + 2 > room ? room : room - tail - 2;
}

/** The first of `forms` (fullest first) that fits `room`; the barest when none does. */
function fitting(forms: readonly string[], room: number): string {
	return forms.find((form) => visibleWidth(form) <= room) ?? forms.at(-1) ?? "";
}

function counts(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0 || removed === 0) parts.push(theme.fg("diffAddedText", `+${added}`));
	if (removed > 0) parts.push(theme.fg("diffRemovedText", `−${removed}`));
	return parts.join(" ");
}

interface RowSpec {
	gutter: TimelineGutter;
	content: string;
	right?: string;
	/** Focus and hover identity; a row without one is not a target. */
	key?: string;
	onClick?: () => void;
	revealBelow?: number;
}

type Push = (spec: RowSpec) => void;

function gutterAt(main: TimelineGutter["main"], time?: string): TimelineGutter {
	return time ? { main, time } : { main };
}

export class TurnStripComponent implements Component {
	private regions: ClickRegion[] = [];
	private order: string[] = [];

	constructor(private readonly source: StripSource) {}

	invalidate(): void {
		// Rendered from live state every frame; nothing cached.
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}

	/** Focus targets, top to bottom. */
	getFocusOrder(): readonly string[] {
		return this.order;
	}

	/** What Enter does on a focused strip target (`展开`, `收起`). */
	enterLabel(key: string): string | undefined {
		const ui = this.source.timeline.ui;
		if (key === STRIP_EDITS) return ui.stripOpen === "edits" ? "收起" : "展开";
		if (key === STRIP_ALL) return timelineShowAll.value ? "收起" : "展开";
		if (key.startsWith(ITEM_PREFIX)) return ui.stripExpanded.has(key.slice(ITEM_PREFIX.length)) ? "收起" : "展开";
		return undefined;
	}

	/** Enter on a focused strip target. Returns false when the key is not one of this strip's. */
	activate(key: string): boolean {
		const ui = this.source.timeline.ui;
		if (key === STRIP_EDITS) {
			ui.stripOpen = ui.stripOpen === "edits" ? undefined : "edits";
			ui.bump();
			return true;
		}
		if (key === STRIP_ALL) {
			timelineShowAll.set(!timelineShowAll.value);
			ui.bump();
			return true;
		}
		if (key.startsWith(ITEM_PREFIX)) {
			const item = key.slice(ITEM_PREFIX.length);
			if (ui.stripExpanded.has(item)) {
				ui.stripExpanded.delete(item);
				ui.stripExpandedAt.delete(item);
			} else {
				ui.stripExpanded.add(item);
				ui.stripExpandedAt.set(item, Date.now());
			}
			ui.bump();
			return true;
		}
		return false;
	}

	render(width: number): string[] {
		const facts = this.source.facts();
		this.regions = [];
		this.order = [];
		if (!facts) return [];
		const safeWidth = Math.max(1, Math.floor(width));
		const timeline = this.source.timeline;
		const ui = timeline.ui;
		const lines: string[] = [];
		const focusedKey = ui.focused ? ui.focusKey : undefined;
		const stampFallback = lastStamp(timeline);
		const stampOf = (at: number | undefined): string | undefined => {
			const stamp = isStamp(at) ? at : stampFallback;
			return stamp === undefined ? undefined : formatTimelineTime(stamp);
		};

		const push = (spec: RowSpec): void => {
			const row = timelineRow(spec.gutter, spec.content, spec.right ?? "", safeWidth);
			const key = spec.key;
			if (key === undefined) {
				lines.push(row);
				return;
			}
			this.order.push(key);
			const focused = focusedKey === key;
			const lit = focused || ui.hoverKey === key;
			const line = lit
				? theme.bg("timelineHoverBg", row + " ".repeat(Math.max(0, safeWidth - visibleWidth(row))))
				: row;
			lines.push(`${focused ? BOX_FOCUS_MARKER : ""}${line}`);
			const onClick = spec.onClick;
			if (!onClick) return;
			this.regions.push({
				line: lines.length - 1,
				col: 0,
				width: safeWidth,
				height: 1,
				revealBelow: spec.revealBelow ?? 0,
				onClick: () => {
					onClick();
					this.source.requestRender();
				},
				hoverKey: `${ui.id}:${key}`,
				onHover: (hovered: boolean) => {
					if (ui.setHover(key, hovered)) this.source.requestRender();
				},
			});
		};
		const gap = (): void => push({ gutter: { main: "rail" }, content: "" });
		const caretFor = (open: boolean, openColor: "kindEdit" | "timelineMemory"): string =>
			theme.bold(theme.fg(open ? openColor : "timelineFaint", open ? "▴" : "▸"));

		const hasEditsRow = facts.projectChanges.length > 0 || facts.commitId !== undefined || facts.trackingIncomplete;
		const hasSections = hasEditsRow || facts.memories.length > 0;
		// The answer above ends with one blank row of its own; a section sits two rows below it.
		if (hasSections) gap();
		if (hasEditsRow) this.editsSection(facts, safeWidth, push, stampOf, caretFor);

		facts.memories.forEach(({ key, change }, index) => {
			if (index === 0 && hasEditsRow) gap();
			const open = ui.stripExpanded.has(key);
			const right = caretFor(open, "timelineMemory");
			const head = memoryHeadLabel(change);
			const titleRoom = Math.max(4, contentLimit(safeWidth, right) - visibleWidth(head) - 3);
			const title = theme.fg("text", shortMemoryTitle(change.title || change.id || "", titleRoom));
			push({
				gutter: gutterAt("memory", stampOf(change.at)),
				content: `${theme.bold(theme.fg("timelineMemory", head))}   ${title}`,
				right,
				key: `${ITEM_PREFIX}${key}`,
				onClick: () => this.activate(`${ITEM_PREFIX}${key}`),
				revealBelow: open ? 0 : 10,
			});
			if (open) {
				const body = memoryBodyLines(change, Math.max(8, safeWidth - TIMELINE_CONTENT_COL));
				const shown = slideCount(ui.stripExpandedAt.get(key), body.length);
				for (const bodyLine of body.slice(0, shown)) {
					push({ gutter: { main: "memoryBar" }, content: bodyLine });
				}
				if (index < facts.memories.length - 1) gap();
			}
		});

		if (hasSections) gap();
		const closes = this.source.endsRequest?.() !== false;
		if (closes) this.closingRow(safeWidth, push);
		return lines;
	}

	private editsSection(
		facts: TimelineFacts,
		width: number,
		push: Push,
		stampOf: (at: number | undefined) => string | undefined,
		caretFor: (open: boolean, openColor: "kindEdit" | "timelineMemory") => string,
	): void {
		const ui = this.source.timeline.ui;
		const files = facts.projectChanges.length;
		const open = ui.stripOpen === "edits" && files > 0;
		const glyph = theme.fg("kindEdit", "✎");
		const soft = (text: string) => theme.fg("timelineSoft", text);
		const dim = (text: string) => theme.fg("timelineTime", text);
		const commit = facts.commitId ? dim(` · 已提交 ${facts.commitId}`) : "";
		const incomplete = facts.trackingIncomplete ? dim(" （有些改动没记全）") : "";
		const firstAt = facts.projectChanges.map((change) => change.firstAt).filter(isStamp);
		const time = stampOf(firstAt.length > 0 ? Math.min(...firstAt) : undefined);
		if (files === 0) {
			const head = facts.commitId ? `已提交 ${facts.commitId}` : "";
			const note = facts.trackingIncomplete ? `${head ? " " : ""}（有些改动没记全）` : "";
			push({ gutter: gutterAt("note", time), content: dim(`${head}${note}`) });
			return;
		}
		const right = caretFor(open, "kindEdit");
		const totals = changeTotals(facts.projectChanges);
		const figures = totals ? ` ${counts(totals.added, totals.removed)}` : "";
		const room = contentLimit(width, right);
		const content = fitting(
			[
				`${glyph} ${soft(`改了 ${files} 个文件`)}${figures}${commit}${incomplete}`,
				`${glyph} ${soft(`改了 ${files} 个文件`)}${figures}${commit}`,
				`${glyph} ${soft(`改了 ${files} 个文件`)}${figures}`,
				`${glyph} ${soft(`改了 ${files} 个文件`)}`,
				`${glyph} ${soft(`${files} 个文件`)}`,
			],
			room,
		);
		push({
			gutter: gutterAt("note", time),
			content,
			right,
			key: STRIP_EDITS,
			onClick: () => this.activate(STRIP_EDITS),
			revealBelow: open ? 0 : 10,
		});
		if (!open) return;
		for (const change of facts.projectChanges) {
			const key = `file:${change.key}`;
			const opened = ui.stripExpanded.has(key);
			const renamed = change.kind === "renamed" && change.oldPath;
			const path = renamed ? `${change.oldPath} → ${change.path}` : change.path;
			const verbs: Record<typeof change.kind, string> = {
				created: "新增 ",
				modified: "",
				deleted: "删除 ",
				renamed: "改名 ",
			};
			const verb = change.symlink && !renamed ? `${symlinkVerb(change.kind)} ` : verbs[change.kind];
			const omitted = omittedDiffText(change.omitted);
			const figure = change.symlink
				? ""
				: omitted && change.added === 0 && change.removed === 0
					? dim(omitted)
					: counts(change.added, change.removed);
			const lead = `  ${theme.fg(change.kind === "deleted" ? "diffRemovedText" : "kindEdit", change.kind === "deleted" ? "✗" : "✎")} ${dim(verb)}`;
			const caret = caretFor(opened, "kindEdit");
			const withFigure = figure ? `${figure}  ${caret}` : caret;
			const floor = pathFloor(path);
			const leadWidth = visibleWidth(lead);
			const fits = (tail: string) => contentLimit(width, tail) - leadWidth >= floor;
			const tail = fits(withFigure) ? withFigure : caret;
			const pathRoom = Math.max(1, contentLimit(width, tail) - leadWidth);
			push({
				gutter: { main: "rail" },
				content: `${lead}${theme.fg("text", shortenPath(path, pathRoom))}`,
				right: tail,
				key: `${ITEM_PREFIX}${key}`,
				onClick: () => this.activate(`${ITEM_PREFIX}${key}`),
				revealBelow: opened ? 0 : 10,
			});
			if (opened) {
				const detail = changeDetail(change)(Math.max(8, width - TIMELINE_CONTENT_COL - 4));
				const shown = slideCount(ui.stripExpandedAt.get(key), detail.length);
				for (const detailLine of detail.slice(0, shown)) {
					push({ gutter: { main: "rail" }, content: `    ${detailLine}` });
				}
			}
		}
		if (facts.scratchChanges.length > 0) {
			push({
				gutter: { main: "rail" },
				content: dim(`  另有 ${facts.scratchChanges.length} 个临时文件，不算项目改动`),
			});
		}
	}

	private closingRow(width: number, push: Push): void {
		const timeline = this.source.timeline;
		const elapsed = this.source.elapsedMs?.() ?? timelineElapsedMs(timeline);
		const spent = elapsed === undefined ? "" : `用了 ${formatSpan(elapsed)}`;
		const stopped = timeline.stopped;
		const failed = timeline.errorEnded && !stopped;
		const mark = stopped ? "■" : failed ? "✗" : "✓";
		const label = stopped ? "已停止" : failed ? "出错" : spent ? "" : "完成";
		const lead = [label, spent].filter((part) => part.length > 0).join(" · ");
		const spend = this.source.spend?.();
		const total = spend ? spend.parentCost + spend.cost : 0;
		const lower = spend?.partial ? "≈" : "";
		const sub = spend && spend.cost > 0 ? ` · 子代理 ${lower}${formatSpendCost(spend.cost)}` : "";
		const all = total > 0 ? ` · 全部 ${lower}${formatSpendCost(total)}` : "";
		const right = theme.fg("timelineFaint", `完整过程 ${timelineShowAll.value ? "▴" : "▸"}`);
		const rest = fitting([`${lead}${sub}${all}`, `${lead}${sub}`, lead], contentLimit(width, right) - 2);
		push({
			gutter: { main: "end" },
			content: `${theme.fg(failed ? "timelineMust" : "timelineFaint", mark)} ${theme.fg("timelineFaint", rest)}`,
			right,
			key: STRIP_ALL,
			onClick: () => this.activate(STRIP_ALL),
		});
	}
}
