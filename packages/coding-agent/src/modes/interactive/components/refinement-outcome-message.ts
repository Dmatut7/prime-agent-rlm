import {
	type ClickRegion,
	type Component,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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
import { shortMemoryTitle } from "./feed-data.js";
import { memoryBodyLines, memoryHeadLabel } from "./memory-detail.js";
import { formatTimelineTime, TIMELINE_CONTENT_COL, type TimelineGutter, timelineRow } from "./timeline-gutter.js";
import { timelineShowAll } from "./timeline-lane.js";

/**
 * What the background refiner kept after a turn. The timeline hides it by
 * default; with the closing row's `完整过程 ▸` on it is one dim note,
 * `19:07 · 回合后整理记忆：新记 1 条（本会话）   展开 ▸`, that opens to the
 * memories in full. A refiner that failed, or refused an edit, says so in amber
 * and is never hidden, like a failed subagent or compaction.
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
	at = 0,
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
		at,
	};
}

function scopeWord(scope: HarnessScope): string {
	return scope === "global" ? "全局" : "本会话";
}

let hoverIds = 0;

/** Durable refinement outcome: one note row, opened by its own click or Enter (never the process key). */
export class RefinementOutcomeMessageComponent implements Component, FocusableBlock, ExpandableBlock {
	private expanded = false;
	private hovered = false;
	private blockFocus?: BlockFocusState;
	private regions: ClickRegion[] = [];
	private cachedWidth?: number;
	private cachedShown?: boolean;
	private cachedLines?: string[];
	private readonly hoverKey = `refinement${++hoverIds}`;

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
		return renderedCopyText(this.renderLines(100, true));
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.regions;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedShown = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const shown = timelineShowAll.value;
		if (!this.cachedLines || this.cachedWidth !== width || this.cachedShown !== shown) {
			this.cachedLines = this.renderLines(width, false);
			this.cachedWidth = width;
			this.cachedShown = shown;
		}
		const lines = this.cachedLines;
		return this.blockFocus && lines.length > 0 ? decorateFocusedBlock(lines, width, this.blockFocus) : lines;
	}

	private renderLines(width: number, forceShown: boolean): string[] {
		this.regions = [];
		const { edits, scope, failed, error } = this.message.details;
		// Only a tidy that kept everything hides; one that failed or refused an edit is never out of sight.
		const wentWrong = failed === true || edits.some((edit) => !edit.applied);
		if (!forceShown && !timelineShowAll.value && !wentWrong) return [];
		const safeWidth = Math.max(1, width);
		const dim = (text: string) => theme.fg("timelineTime", text);
		const row = (gutter: TimelineGutter, content: string, right = "") =>
			timelineRow(gutter, content, right, safeWidth);
		const time = Number.isFinite(this.message.timestamp) ? formatTimelineTime(this.message.timestamp) : undefined;
		const noteGutter: TimelineGutter = time ? { main: "note", time } : { main: "note" };
		const lines: string[] = [row({ main: "rail" }, "")];
		if (failed || edits.length === 0) {
			const reason = error ? sanitizeDisplayText(error).split("\n")[0] : undefined;
			const why = reason ? `整理器这次没给出结果（${reason}），下一轮会再试` : "整理器这次没给出结果，下一轮会再试";
			lines.push(row(noteGutter, `${theme.fg("timelineFix", "回合后整理记忆：没写进去")}${dim(` · ${why}`)}`));
			return lines;
		}
		const applied = edits.filter((edit) => edit.applied);
		const failedEdits = edits.filter((edit) => !edit.applied);
		const said = [
			["新记", applied.filter((edit) => edit.action === "create").length],
			["改了", applied.filter((edit) => edit.action === "update").length],
			["删了", applied.filter((edit) => edit.action === "delete").length],
		]
			.filter(([, count]) => count !== 0)
			.map(([word, count]) => `${word} ${count} 条`);
		if (failedEdits.length > 0) said.push(`${failedEdits.length} 条没写进去`);
		const text = `回合后整理记忆：${said.join("，")}（${scopeWord(scope)}）`;
		const right = dim(this.expanded ? "收起 ▴" : "展开 ▸");
		const head = row(noteGutter, failedEdits.length > 0 ? theme.fg("timelineFix", text) : dim(text), right);
		lines.push(
			this.hovered
				? theme.bg("timelineHoverBg", head + " ".repeat(Math.max(0, safeWidth - visibleWidth(head))))
				: head,
		);
		this.regions.push({
			line: lines.length - 1,
			col: 0,
			width: safeWidth,
			height: 1,
			revealBelow: this.expanded ? 0 : 8,
			onClick: () => this.setExpanded(!this.expanded),
			hoverKey: this.hoverKey,
			onHover: (hovered: boolean) => {
				if (this.hovered === hovered) return;
				this.hovered = hovered;
				this.invalidate();
			},
		});
		if (!this.expanded) return lines;

		const room = Math.max(8, safeWidth - TIMELINE_CONTENT_COL);
		// The refiner's own note on why, once, above the entries.
		const why = sanitizeDisplayText(this.message.details.summary ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (why) {
			for (const part of wrapTextWithAnsi(dim(why), room)) lines.push(row({ main: "rail" }, part));
		}
		edits.forEach((edit, index) => {
			const change = refinementEditAsMemoryChange(edit, scope, this.message.timestamp);
			if (index > 0 || why) lines.push(row({ main: "rail" }, ""));
			if (!edit.applied) {
				const reason = edit.error ? `：${sanitizeDisplayText(edit.error)}` : "";
				const title = theme.fg("text", shortMemoryTitle(change.title, Math.max(4, room - 20)));
				lines.push(
					row(
						{ main: "rail" },
						`${theme.fg("timelineMust", "✗")} ${title}${theme.fg("timelineMust", `  没写进去${reason}`)}`,
					),
				);
				return;
			}
			const label = memoryHeadLabel(change);
			const title = theme.fg("text", shortMemoryTitle(change.title, Math.max(4, room - visibleWidth(label) - 3)));
			lines.push(row({ main: "memory" }, `${theme.bold(theme.fg("timelineMemory", label))}   ${title}`));
			for (const detail of memoryBodyLines(change, room)) lines.push(row({ main: "memoryBar" }, detail));
		});
		return lines.map((line) => (visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line));
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
