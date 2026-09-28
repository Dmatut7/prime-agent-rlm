import { type ClickRegion, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.js";
import { cleanMemoryTitle } from "./feed-data.js";
import { slideCount } from "./motion.js";
import { changeDetail, changeTotals, memoryDetail, omittedDiffText, type TimelineFacts } from "./timeline-rows.js";
import { BOX_FOCUS_MARKER, BOX_MAX_WIDTH } from "./turn-box.js";
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
	head: string;
	right: string;
	detail?: (width: number) => string[];
}

export const STRIP_EDITS = "strip:edits";
export const STRIP_MEMORIES = "strip:memories";

function counts(added: number, removed: number): string {
	const parts: string[] = [];
	if (added > 0 || removed === 0) parts.push(theme.fg("diffAddedText", `+${added}`));
	if (removed > 0) parts.push(theme.fg("diffRemovedText", `−${removed}`));
	return parts.join(" ");
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
			const totals = changeTotals(facts.projectChanges);
			const figures = totals ? ` ${counts(totals.added, totals.removed)}` : "";
			segments.push({
				key: STRIP_EDITS,
				text: `${theme.fg("runCardWarn", "✎")} ${theme.fg("muted", `改了 ${facts.projectChanges.length} 个文件`)}${figures} ${theme.fg("dim", ui.stripOpen === "edits" ? "▾" : "▸")}`,
			});
		}
		if (facts.memories.length > 0) {
			segments.push({
				key: STRIP_MEMORIES,
				text: `${theme.fg("memoryAccent", "✦")} ${theme.fg("muted", `记住了 ${facts.memories.length} 条`)} ${theme.fg("dim", ui.stripOpen === "memories" ? "▾" : "▸")}`,
			});
		}
		let line = " ";
		let focusLine = false;
		segments.forEach((segment, index) => {
			if (index > 0) line += theme.fg("dim", "  ·  ");
			const col = visibleWidth(line);
			const focused = focusedKey === segment.key;
			if (focused) focusLine = true;
			line += focused ? theme.bg("cardFocusBg", ` ${segment.text} `) : segment.text;
			this.order.push(segment.key);
			const key = segment.key;
			this.regions.push({
				line: 0,
				col,
				width: visibleWidth(segment.text) + (focused ? 2 : 0),
				height: 1,
				revealBelow: 6,
				onClick: () => {
					this.activate(key);
					this.source.requestRender();
				},
			});
		});
		if (facts.commitId) line += theme.fg("dim", `  ·  已提交 ${facts.commitId}`);
		if (facts.trackingIncomplete) line += theme.fg("dim", "  （有些改动没记全）");
		lines.push(`${focusLine ? BOX_FOCUS_MARKER : ""}${truncateToWidth(line, width, "…")}`);

		if (!ui.stripOpen) return lines;
		const items = ui.stripOpen === "edits" ? this.editItems(facts) : this.memoryItems(facts);
		const outer = Math.max(24, Math.min(width - 1, BOX_MAX_WIDTH));
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
			const left = `${caret} ${item.head}`;
			const right = item.right;
			const room = Math.max(1, inner - visibleWidth(right) - 2);
			const fitted = truncateToWidth(left, room, "…");
			const content = `${fitted}${" ".repeat(Math.max(2, inner - visibleWidth(fitted) - visibleWidth(right)))}${right}`;
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
		return lines;
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
				head: `${theme.fg(color, change.kind === "deleted" ? "✗" : "✎")} ${theme.fg("dim", verb[change.kind])}${theme.fg("activityText", path)}`,
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
				head: `${theme.fg("memoryAccent", "✦")} ${theme.fg("activityText", cleanMemoryTitle(change.title))}`,
				right: theme.fg("dim", `${scope}${what}`),
				detail: memoryDetail(change),
			};
		});
	}
}
