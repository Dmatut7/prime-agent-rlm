import { type ClickRegion, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KernelMemoryChange } from "../../../core/kernel/shared.js";
import type { RefinementOutcomeMessage } from "../../../core/messages.js";
import type { AppliedRefinementEdit, HarnessScope } from "../../../core/refinement/refinement.js";
import { theme } from "../theme/theme.js";
import {
	type BlockFocusState,
	decorateFocusedBlock,
	type ExpandableBlock,
	type FocusableBlock,
	renderedCopyText,
} from "./block-focus.js";
import { sanitizeDisplayText } from "./diff-rows.js";
import { cleanMemoryTitle } from "./feed-data.js";
import { memoryDetail } from "./timeline-rows.js";
import { BOX_MAX_WIDTH } from "./turn-box.js";

/**
 * What the refiner kept after a turn, as one violet line in plain words:
 * `✦ 记住了 2 条 · 老板裁定 · 教道理循环状态 · 本会话 ▸`. Opening it lists
 * each entry with only the lines that changed (a rename said as `改名 A → B`).
 * A refiner that produced nothing says so in amber instead of claiming a
 * memory was kept.
 */

const KIND_MAP: Record<AppliedRefinementEdit["kind"], KernelMemoryChange["kind"]> = {
	memory: "memory",
	skill: "skill",
	subagent: "subagent",
	prompt: "prompt_note",
};

const OP_MAP: Record<AppliedRefinementEdit["action"], KernelMemoryChange["op"]> = {
	create: "created",
	update: "updated",
	delete: "deleted",
};

/** One applied refinement edit as the memory change the timeline renders. */
export function refinementEditAsMemoryChange(
	edit: AppliedRefinementEdit,
	fallbackScope: HarnessScope,
): KernelMemoryChange {
	const scope = edit.after?.scope ?? edit.before?.scope ?? fallbackScope;
	const title = edit.after?.title ?? edit.title ?? edit.before?.title ?? edit.id;
	const previousTitle = edit.before?.title;
	const after = edit.after?.content ?? edit.content;
	return {
		op: OP_MAP[edit.action],
		kind: KIND_MAP[edit.kind],
		scope: scope === "global" ? "global" : "session",
		id: edit.id,
		title,
		...(previousTitle && previousTitle !== title ? { previousTitle } : {}),
		...(edit.before?.content !== undefined ? { before: edit.before.content } : {}),
		...(after !== undefined && edit.action !== "delete" ? { after } : {}),
		at: 0,
	};
}

function scopeWord(scope: HarnessScope): string {
	return scope === "global" ? "全局" : "本会话";
}

/** Durable refinement outcome: one line, opened by its own click or Enter (never the process key). */
export class RefinementOutcomeMessageComponent implements Component, FocusableBlock, ExpandableBlock {
	private expanded = false;
	private blockFocus?: BlockFocusState;
	private regions: ClickRegion[] = [];
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private readonly message: RefinementOutcomeMessage) {}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.invalidate();
	}

	isBlockExpanded(): boolean {
		return this.expanded;
	}

	setBlockFocus(state: BlockFocusState | undefined): void {
		this.blockFocus = state;
	}

	getBlockCopyText(): string {
		return renderedCopyText(this.renderLines(100));
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (!this.cachedLines || this.cachedWidth !== width) {
			this.cachedLines = this.renderLines(width);
			this.cachedWidth = width;
		}
		const lines = this.cachedLines;
		return this.blockFocus && lines.length > 0 ? decorateFocusedBlock(lines, width, this.blockFocus) : lines;
	}

	private renderLines(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const { edits, scope, failed, error } = this.message.details;
		const lines: string[] = [""];
		this.regions = [];
		if (failed || edits.length === 0) {
			const reason = error ? sanitizeDisplayText(error).split("\n")[0] : undefined;
			const why = reason ? `整理器这次没给出结果（${reason}），下一轮会再试` : "整理器这次没给出结果，下一轮会再试";
			lines.push(
				truncateToWidth(
					` ${theme.fg("runCardWarn", "✦ 记忆没写进去")}${theme.fg("dim", ` · ${why}`)}`,
					safeWidth,
					"…",
				),
			);
			return lines;
		}
		const applied = edits.filter((edit) => edit.applied);
		const failedEdits = edits.filter((edit) => !edit.applied);
		const titles = [
			...new Set(applied.map((edit) => cleanMemoryTitle(refinementEditAsMemoryChange(edit, scope).title))),
		];
		const caret = theme.fg("dim", this.expanded ? "▾" : "▸");
		const head =
			failedEdits.length > 0
				? `${theme.fg("runCardWarn", `✦ 记住了 ${applied.length} 条，${failedEdits.length} 条没写进去`)}`
				: `${theme.fg("memoryAccent", `✦ 记住了 ${applied.length} 条`)}`;
		const tail = ` ${theme.fg("dim", `· ${scopeWord(scope)}`)} ${caret}`;
		const room = Math.max(4, safeWidth - visibleWidth(` ${head}`) - visibleWidth(tail) - 3);
		const titleText =
			titles.length > 0 ? theme.fg("muted", ` · ${truncateToWidth(titles.join(" · "), room, "…")}`) : "";
		lines.push(truncateToWidth(` ${head}${titleText}${tail}`, safeWidth, "…"));
		this.regions.push({
			line: 1,
			col: 0,
			width: safeWidth,
			height: 1,
			revealBelow: this.expanded ? 0 : 8,
			onClick: () => this.setExpanded(!this.expanded),
		});
		if (!this.expanded) return lines;

		const outer = Math.max(24, Math.min(safeWidth - 1, BOX_MAX_WIDTH));
		const inner = outer - 4;
		const border = (text: string) => theme.fg("boxBorder", text);
		const boxLine = (content: string): string => {
			const fitted = truncateToWidth(content, inner, "…", true);
			return ` ${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
		};
		lines.push(` ${border(`╭${"─".repeat(outer - 2)}╮`)}`);
		// The refiner's own note on why, once, above the entries.
		const why = sanitizeDisplayText(this.message.details.summary ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (why) lines.push(boxLine(theme.fg("dim", why)));
		for (const edit of edits) {
			const change = refinementEditAsMemoryChange(edit, scope);
			const what =
				change.op === "created"
					? "新记"
					: change.op === "deleted"
						? "删了"
						: change.previousTitle
							? "改名"
							: "改了";
			const left = edit.applied
				? `${theme.fg("memoryAccent", "✦")} ${theme.fg("activityText", cleanMemoryTitle(change.title))}`
				: `${theme.fg("error", "✗")} ${theme.fg("activityText", cleanMemoryTitle(change.title))}`;
			const right = edit.applied
				? theme.fg("dim", what)
				: theme.fg("error", `没写进去${edit.error ? `：${sanitizeDisplayText(edit.error)}` : ""}`);
			const rightWidth = Math.min(visibleWidth(right), Math.floor(inner / 2));
			const fittedRight = truncateToWidth(right, rightWidth, "…");
			const fittedLeft = truncateToWidth(left, Math.max(4, inner - rightWidth - 2), "…");
			lines.push(
				boxLine(
					`${fittedLeft}${" ".repeat(Math.max(2, inner - visibleWidth(fittedLeft) - visibleWidth(fittedRight)))}${fittedRight}`,
				),
			);
			if (edit.applied) {
				for (const detail of memoryDetail(change)(Math.max(8, inner - 4))) {
					lines.push(boxLine(`  ${theme.fg("boxBorder", "│")} ${detail}`));
				}
			}
		}
		lines.push(` ${border(`╰${"─".repeat(outer - 2)}╯`)}`);
		return lines;
	}
}

export class MalformedRefinementOutcomeMessageComponent implements Component {
	render(width: number): string[] {
		return [
			"",
			truncateToWidth(` ${theme.fg("error", "[记忆整理的记录格式不对，没法显示]")}`, Math.max(1, width), "…"),
		];
	}

	invalidate(): void {
		// Static text.
	}
}
