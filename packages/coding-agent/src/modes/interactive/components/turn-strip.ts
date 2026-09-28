import { type ClickRegion, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.js";
import { cleanMemoryTitle } from "./feed-data.js";
import { slideCount } from "./motion.js";
import { changeDetail, changeTotals, memoryDetail, omittedDiffText, type TimelineFacts } from "./timeline-rows.js";
import { BOX_FOCUS_MARKER, boxOuterWidth, fitBoxLines } from "./turn-box.js";
import type { TurnTimeline } from "./turn-timeline.js";

/**
 * The one line under a finished turn's answer that says what it changed:
 * `✎ 改了 2 个文件 +20 −7 ▸ · ✦ 记住了 1 条 ▸`. Each half opens a list whose
 * items open to the diff or the memory's before and after. Renders nothing
 * for a turn that changed no files and kept no memories.
 */

export interface StripSource {
	timeline: TurnTimeline;
	/** Facts of the finished turn; undefined while it still runs. */
	facts(): TimelineFacts | undefined;
	requestRender(): void;
}

interface StripItem {
	key: string;
	/** Styled lead before the path (`▸ ✎ 新增 `). */
	lead: string;
	/** The file path or memory title; a path gives way from the left, keeping its file name. */
	name: string;
	nameColor: ThemeColor;
	isPath: boolean;
	right: string;
	detail?: (width: number) => string[];
}

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

export const STRIP_EDITS = "strip:edits";
export const STRIP_MEMORIES = "strip:memories";

function counts(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0 || removed === 0) parts.push(theme.fg("diffAddedText", `+${added}`));
	if (removed > 0) parts.push(theme.fg("diffRemovedText", `−${removed}`));
	return parts.join(" ");
}

/** A strip segment from its fullest form to its barest: with counts, without, the number only, the glyph only. */
type SegmentForm = "full" | "plain" | "count" | "bare";

function editsSegment(facts: TimelineFacts, open: boolean, form: SegmentForm): string {
	const caret = theme.fg("dim", open ? "▾" : "▸");
	const glyph = theme.fg("runCardWarn", "✎");
	const files = facts.projectChanges.length;
	if (form === "bare") return `${glyph} ${caret}`;
	if (form === "count") return `${glyph} ${theme.fg("muted", `${files} 个文件`)} ${caret}`;
	const totals = form === "full" ? changeTotals(facts.projectChanges) : undefined;
	const figures = totals ? ` ${counts(totals.added, totals.removed)}` : "";
	return `${glyph} ${theme.fg("muted", `改了 ${files} 个文件`)}${figures} ${caret}`;
}

function memoriesSegment(facts: TimelineFacts, open: boolean, form: SegmentForm): string {
	const caret = theme.fg("dim", open ? "▾" : "▸");
	const glyph = theme.fg("memoryAccent", "✦");
	const count = facts.memories.length;
	if (form === "bare") return `${glyph} ${caret}`;
	if (form === "count") return `${glyph} ${theme.fg("muted", `${count} 条`)} ${caret}`;
	return `${glyph} ${theme.fg("muted", `记住了 ${count} 条`)} ${caret}`;
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
		if (key === STRIP_MEMORIES) return ui.stripOpen === "memories" ? "收起" : "展开";
		if (key.startsWith("strip:item:")) return ui.stripExpanded.has(key.slice("strip:item:".length)) ? "收起" : "展开";
		return undefined;
	}

	/** Enter on a focused strip target. Returns false when the key is not one of this strip's. */
	activate(key: string): boolean {
		const ui = this.source.timeline.ui;
		if (key === STRIP_EDITS || key === STRIP_MEMORIES) {
			const list = key === STRIP_EDITS ? "edits" : "memories";
			ui.stripOpen = ui.stripOpen === list ? undefined : list;
			ui.bump();
			return true;
		}
		if (key.startsWith("strip:item:")) {
			const item = key.slice("strip:item:".length);
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
		if (!facts || (facts.projectChanges.length === 0 && facts.memories.length === 0 && !facts.commitId)) return [];
		const ui = this.source.timeline.ui;
		const focusedKey = ui.focused ? ui.focusKey : undefined;
		const lines: string[] = [];
		const segments: Array<{ key: string; text: string }> = [];
		if (facts.projectChanges.length > 0) {
			segments.push({ key: STRIP_EDITS, text: editsSegment(facts, ui.stripOpen === "edits", "full") });
		}
		if (facts.memories.length > 0) {
			segments.push({ key: STRIP_MEMORIES, text: memoriesSegment(facts, ui.stripOpen === "memories", "full") });
		}
		const tail: string[] = [];
		if (facts.commitId) tail.push(theme.fg("dim", `  ·  已提交 ${facts.commitId}`));
		if (facts.trackingIncomplete) tail.push(theme.fg("dim", "  （有些改动没记全）"));
		// Whole segments drop from the right until the line fits: a cut never
		// leaves half a number, and a click area never points past the edge.
		const layout = (shown: ReadonlyArray<{ key: string; text: string }>, extra: readonly string[]) => {
			let text = " ";
			let focusLine = false;
			const regions: Array<{ key: string; col: number; width: number }> = [];
			shown.forEach((segment, index) => {
				if (index > 0) text += theme.fg("dim", "  ·  ");
				const focused = focusedKey === segment.key;
				if (focused) focusLine = true;
				regions.push({
					key: segment.key,
					col: visibleWidth(text),
					width: visibleWidth(segment.text) + (focused ? 2 : 0),
				});
				text += focused ? theme.bg("cardFocusBg", ` ${segment.text} `) : segment.text;
			});
			return { text: text + extra.join(""), focusLine, regions };
		};
		const shaped = (count: number, form: SegmentForm) =>
			segments.slice(0, count).map((segment) => ({
				key: segment.key,
				text:
					segment.key === STRIP_EDITS
						? editsSegment(facts, ui.stripOpen === "edits", form)
						: memoriesSegment(facts, ui.stripOpen === "memories", form),
			}));
		// Tighter wordings first, then segments from the right, then the first one's barest form.
		const attempts: Array<[Array<{ key: string; text: string }>, string[]]> = [];
		for (let extra = tail.length; extra >= 0; extra--) attempts.push([segments, tail.slice(0, extra)]);
		const forms: SegmentForm[] = ["full", "plain", "count"];
		for (let count = segments.length; count >= 1; count--) {
			for (const form of forms) attempts.push([shaped(count, form), []]);
		}
		attempts.push([shaped(1, "bare"), []]);
		let chosen = layout(segments, tail);
		for (const [shown, extra] of attempts) {
			chosen = layout(shown, extra);
			if (visibleWidth(chosen.text) <= width) break;
		}
		for (const region of chosen.regions) {
			if (region.col + region.width > width) continue;
			this.order.push(region.key);
			const key = region.key;
			this.regions.push({
				line: 0,
				col: region.col,
				width: region.width,
				height: 1,
				revealBelow: 6,
				onClick: () => {
					this.activate(key);
					this.source.requestRender();
				},
			});
		}
		lines.push(`${chosen.focusLine ? BOX_FOCUS_MARKER : ""}${truncateToWidth(chosen.text, width, "")}`);

		if (!ui.stripOpen) return lines;
		const items = ui.stripOpen === "edits" ? this.editItems(facts) : this.memoryItems(facts);
		const outer = boxOuterWidth(width);
		const inner = outer - 4;
		const border = (text: string) => theme.fg("boxBorder", text);
		const boxLine = (content: string, bg?: "cardFocusBg"): string => {
			const fitted = truncateToWidth(content, inner, "…", true);
			const padded = ` ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} `;
			return ` ${border("│")}${bg ? theme.bg(bg, padded) : padded}${border("│")}`;
		};
		lines.push(` ${border(`╭${"─".repeat(outer - 2)}╮`)}`);
		for (const item of items) {
			const opened = item.detail !== undefined && ui.stripExpanded.has(item.key);
			const focusKey = `strip:item:${item.key}`;
			const focused = focusedKey === focusKey;
			this.order.push(focusKey);
			const caret = item.detail ? theme.fg("dim", opened ? "▾" : "▸") : " ";
			const lead = `${caret} ${item.lead}`;
			const leadWidth = visibleWidth(lead);
			// The name keeps its file name before the counts get room; counts that
			// would squeeze it to `…` step aside.
			const floor = item.isPath ? pathFloor(item.name) : Math.min(visibleWidth(item.name), 4);
			const right = item.right && inner - leadWidth - visibleWidth(item.right) - 2 >= floor ? item.right : "";
			const room = Math.max(1, inner - leadWidth - (right ? visibleWidth(right) + 2 : 0));
			const name = item.isPath ? shortenPath(item.name, room) : truncateToWidth(item.name, room, "…");
			const fitted = `${lead}${theme.fg(item.nameColor, name)}`;
			const content = right
				? `${fitted}${" ".repeat(Math.max(2, inner - visibleWidth(fitted) - visibleWidth(right)))}${right}`
				: fitted;
			lines.push(`${focused ? BOX_FOCUS_MARKER : ""}${boxLine(content, focused ? "cardFocusBg" : undefined)}`);
			const itemKey = item.key;
			if (item.detail) {
				this.regions.push({
					line: lines.length - 1,
					col: 0,
					width: outer + 1,
					height: 1,
					revealBelow: opened ? 0 : 10,
					onClick: () => {
						this.activate(`strip:item:${itemKey}`);
						this.source.requestRender();
					},
				});
			}
			if (opened && item.detail) {
				const detail = item.detail(Math.max(8, inner - 6));
				const shown = slideCount(ui.stripExpandedAt.get(item.key), detail.length);
				for (const detailLine of detail.slice(0, shown)) {
					lines.push(boxLine(`    ${theme.fg("boxBorder", "│")} ${detailLine}`));
				}
			}
		}
		if (ui.stripOpen === "edits" && facts.scratchChanges.length > 0) {
			lines.push(boxLine(theme.fg("dim", `  另有 ${facts.scratchChanges.length} 个临时文件，不算项目改动`)));
		}
		lines.push(` ${border(`╰${"─".repeat(outer - 2)}╯`)}`);
		return fitBoxLines(lines, width);
	}

	private editItems(facts: TimelineFacts): StripItem[] {
		return facts.projectChanges.map((change) => {
			const verb: Record<typeof change.kind, string> = {
				created: "新增 ",
				modified: "",
				deleted: "删除 ",
				renamed: "改名 ",
			};
			const color: ThemeColor = change.kind === "deleted" ? "diffRemovedText" : "runCardWarn";
			const path = change.kind === "renamed" && change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
			const omitted = omittedDiffText(change.omitted);
			// Counts the kernel could not know read as the reason, never as `+0 −0`.
			const figures =
				omitted && change.added === 0 && change.removed === 0
					? theme.fg("dim", omitted)
					: counts(change.added, change.removed);
			return {
				key: `file:${change.key}`,
				lead: `${theme.fg(color, change.kind === "deleted" ? "✗" : "✎")} ${theme.fg("dim", verb[change.kind])}`,
				name: path,
				nameColor: "activityText",
				isPath: true,
				right: figures,
				detail: changeDetail(change),
			};
		});
	}

	private memoryItems(facts: TimelineFacts): StripItem[] {
		return facts.memories.map(({ key, change }) => {
			const renamed = change.previousTitle && change.previousTitle !== change.title;
			const what = change.op === "created" ? "新记" : change.op === "deleted" ? "删了" : renamed ? "改名" : "改了";
			const scope = change.scope === "global" ? "全局 · " : change.scope === "project" ? "项目 · " : "本会话 · ";
			return {
				key,
				lead: `${theme.fg("memoryAccent", "✦")} `,
				name: cleanMemoryTitle(change.title),
				nameColor: "activityText",
				isPath: false,
				right: theme.fg("dim", `${scope}${what}`),
				detail: memoryDetail(change),
			};
		});
	}
}
