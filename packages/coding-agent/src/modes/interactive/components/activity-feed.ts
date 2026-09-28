import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KernelActivity, KernelMemoryChange } from "../../../core/kernel/shared.js";
import { theme } from "../theme/theme.js";
import { spinnerFrame } from "../theme/working-icon.js";
import { type DiffRow, previewDiffRows, sanitizeDisplayText } from "./diff-rows.js";
import {
	aggregateChanges,
	type ChangeEntry,
	cleanMemoryTitle,
	localizeResultDetail,
	recordAgentName,
	type StepFeedData,
} from "./feed-data.js";
import { rowEnterStage } from "./motion.js";
import { type StepLabelContext, stepAction } from "./step-label.js";
import { turnRunningClockText } from "./turn-footnote.js";

/**
 * The live action feed: every step of a turn as it happens, one row each -
 * `✓ 读取 README.md`, `$ pytest -q · 54 通过`, `✎ subbill/credits.py +12 −4`,
 * `✦ 新增记忆 …`, `✗ …`. Rows come from the kernel's activity and change
 * records when a step has them; a step without any falls back to its label.
 * Pure: the rows are a function of the steps, their records and the clock.
 */

/** Rows wider than this read as a stretched line on a wide terminal; the right column stops here. */
export const FEED_MAX_ROW_WIDTH = 100;
/** A live turn shows at most this many rows; older settled ones fold into one `⋯` row. */
export const LIVE_FEED_MAX_ROWS = 40;
/** How many edit rows in a turn carry the one or two line diff preview. */
export const FEED_PREVIEW_EDITS = 2;
/** A running step turns amber once it has run this long. */
export const FEED_SLOW_STEP_MS = 60_000;

export type FeedStepStatus = "queued" | "running" | "done" | "error";

export interface FeedStep {
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: FeedStepStatus;
	startedAt?: number;
	data: StepFeedData;
}

export interface FeedThinking {
	key: string;
	/** What the row shows: the latest completed sentence, already steadied by the caller. */
	text: string;
	/** Steps that existed when the segment began: the row sits before step `afterStep`. */
	afterStep: number;
}

export type FeedRowKind = "think" | "running" | "done" | "edit" | "memory" | "error" | "preview" | "tail" | "more";

export interface FeedRow {
	/** Stable identity: the enter highlight and the fold key off it. */
	key: string;
	kind: FeedRowKind;
	/** The step the row belongs to (none for thinking rows). */
	stepId?: string;
	glyph: string;
	glyphColor: "success" | "error" | "dim" | "activityAccent" | "activityText" | "memoryAccent" | "runCardWarn";
	verb?: string;
	target?: string;
	/** Render the target as a path: faint directory, bold file name. */
	targetIsPath?: boolean;
	result?: string;
	resultColor?: "dim" | "error" | "muted";
	counts?: { added: number; removed: number };
	right?: string;
	rightColor?: "dim" | "runCardWarn";
	/** Subagent that did it, when the record says so. */
	tag?: string;
	diff?: DiffRow;
	/** Stays on screen after the turn folds (errors). */
	persistent?: boolean;
	/** Enter/click opens more below it. */
	expandKey?: string;
	/** Lines the expanded row shows under itself. */
	detail?: string[];
}

export interface FeedBuildOptions {
	now: number;
	cwd: string;
	tick: number;
	labelContext?: StepLabelContext;
	/** Steadies a changing text (a running command's latest line): at most one change per second. */
	steady?: (key: string, text: string) => string;
}

function clockText(ms: number): string {
	return turnRunningClockText(ms);
}

function durationText(ms: number | undefined): string | undefined {
	if (ms === undefined || ms < 1000) return undefined;
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : clockText(ms);
}

function runningGlyph(tick: number, elapsedMs: number): Pick<FeedRow, "glyph" | "glyphColor" | "rightColor"> {
	const slow = elapsedMs >= FEED_SLOW_STEP_MS;
	return {
		glyph: spinnerFrame(tick, slow),
		glyphColor: slow ? "runCardWarn" : "activityAccent",
		rightColor: slow ? "runCardWarn" : "dim",
	};
}

const ACTIVITY_VERBS: Record<KernelActivity["kind"], { running: string; done: string }> = {
	command: { running: "运行", done: "运行" },
	read: { running: "读取", done: "读取" },
	search: { running: "搜索", done: "搜索" },
	fetch: { running: "读网页", done: "读网页" },
	subagent: { running: "等子代理", done: "子代理" },
};

function activityRows(step: FeedStep, activity: KernelActivity, options: FeedBuildOptions): FeedRow[] {
	const key = `act:${step.toolCallId}:${activity.id}`;
	const label = sanitizeDisplayText(activity.label).replace(/\s+/g, " ").trim();
	const verbs = ACTIVITY_VERBS[activity.kind];
	if (activity.status === "running") {
		const elapsed = Math.max(0, options.now - (activity.startedAt || options.now));
		const rows: FeedRow[] = [
			{
				key,
				kind: "running",
				stepId: step.toolCallId,
				...runningGlyph(options.tick, elapsed),
				verb: verbs.running,
				target: label,
				right: clockText(elapsed),
			},
		];
		const detail = activity.detail ? sanitizeDisplayText(activity.detail).trim() : "";
		if (detail && activity.kind === "command") {
			const shown = options.steady ? options.steady(`${key}:tail`, detail) : detail;
			rows.push({
				key: `${key}:tail`,
				kind: "tail",
				stepId: step.toolCallId,
				glyph: "↳",
				glyphColor: "dim",
				target: shown,
			});
		}
		return rows;
	}
	const duration =
		activity.endedAt !== undefined && activity.startedAt
			? durationText(activity.endedAt - activity.startedAt)
			: undefined;
	const result = activity.detail ? localizeResultDetail(activity.detail) : undefined;
	if (activity.status === "error") {
		return [
			{
				key,
				kind: "error",
				stepId: step.toolCallId,
				glyph: "✗",
				glyphColor: "error",
				verb: verbs.done,
				target: label,
				...(result ? { result, resultColor: "error" as const } : {}),
				...(duration ? { right: duration } : {}),
				persistent: true,
			},
		];
	}
	return [
		{
			key,
			kind: "done",
			stepId: step.toolCallId,
			glyph: activity.kind === "command" ? "$" : "✓",
			glyphColor: "success",
			verb: activity.kind === "command" ? undefined : verbs.done,
			target: label,
			...(result ? { result } : {}),
			...(duration ? { right: duration } : {}),
		},
	];
}

const CHANGE_VERBS: Record<ChangeEntry["kind"], string> = {
	created: "新增",
	modified: "修改",
	deleted: "删除",
	renamed: "改名",
};

function changeRows(step: FeedStep, change: ChangeEntry, withPreview: boolean): FeedRow[] {
	const key = `file:${step.toolCallId}:${change.key}`;
	const scratch = change.scope === "scratch";
	const row: FeedRow = {
		key,
		kind: "edit",
		stepId: step.toolCallId,
		glyph: "✎",
		glyphColor: "activityText",
		verb: CHANGE_VERBS[change.kind],
		target:
			change.kind === "renamed" && change.oldPath
				? `${change.oldPath} → ${change.path}`
				: scratch
					? change.path
					: change.path,
		targetIsPath: true,
		...(scratch ? { result: "临时文件", resultColor: "dim" as const } : {}),
		...(change.scope === "memory" ? { result: "规则文件", resultColor: "dim" as const } : {}),
		counts: { added: change.added, removed: change.removed },
		...(change.agent ? { tag: change.agent } : {}),
	};
	const rows = [row];
	if (withPreview) {
		for (const [index, diff] of previewDiffRows(change.rows).entries()) {
			rows.push({
				key: `${key}:p${index}`,
				kind: "preview",
				stepId: step.toolCallId,
				glyph: "",
				glyphColor: "dim",
				diff,
			});
		}
	}
	return rows;
}

const MEMORY_VERBS: Record<KernelMemoryChange["op"], string> = { created: "新增", updated: "更新", deleted: "删除" };

function memoryNoun(change: KernelMemoryChange): string {
	if (change.kind === "rules_file" || change.scope === "global")
		return change.scope === "project" ? "项目规则" : "全局规则";
	if (change.kind === "skill") return "技能";
	if (change.kind === "subagent") return "子代理设定";
	if (change.kind === "prompt_note") return "提示";
	return "记忆";
}

function firstContentLine(text: string | undefined): string | undefined {
	return sanitizeDisplayText(text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !/^#+\s*$/.test(line));
}

function memoryRows(step: FeedStep, change: KernelMemoryChange, index: number, withPreview: boolean): FeedRow[] {
	const key = `mem:${step.toolCallId}:${change.id ?? change.title}:${change.at || index}`;
	const renamed = change.previousTitle && change.previousTitle !== change.title;
	const agent = recordAgentName(change);
	const rows: FeedRow[] = [
		{
			key,
			kind: "memory",
			stepId: step.toolCallId,
			glyph: "✦",
			glyphColor: "memoryAccent",
			verb: `${MEMORY_VERBS[change.op]}${memoryNoun(change)}`,
			target: cleanMemoryTitle(change.title),
			...(renamed ? { result: "改了名", resultColor: "dim" as const } : {}),
			...(agent ? { tag: agent } : {}),
		},
	];
	if (withPreview && change.op !== "deleted") {
		const line = firstContentLine(change.after);
		if (line) {
			rows.push({
				key: `${key}:p`,
				kind: "preview",
				stepId: step.toolCallId,
				glyph: "",
				glyphColor: "dim",
				diff: { kind: "add", text: line },
			});
		}
	}
	return rows;
}

function isInterrupt(error: string | undefined): boolean {
	return error !== undefined && /^(KeyboardInterrupt|已中断)/.test(error);
}

function errorRow(step: FeedStep, verb: string | undefined, target: string): FeedRow {
	const error = step.data.error ?? "出错了";
	if (isInterrupt(error)) {
		return {
			key: `err:${step.toolCallId}`,
			kind: "error",
			stepId: step.toolCallId,
			glyph: "✗",
			glyphColor: "dim",
			...(verb ? { verb } : {}),
			target,
			result: "已中断",
			resultColor: "dim",
			persistent: true,
		};
	}
	const detail = step.data.errorDetail ?? [];
	return {
		key: `err:${step.toolCallId}`,
		kind: "error",
		stepId: step.toolCallId,
		glyph: "✗",
		glyphColor: "error",
		...(verb ? { verb } : {}),
		target,
		result: sanitizeDisplayText(error),
		resultColor: "error",
		persistent: true,
		...(detail.length > 1 ? { expandKey: `err:${step.toolCallId}`, detail } : {}),
	};
}

function outputLineCount(data: StepFeedData): number {
	const text = data.outputText?.trim();
	return text ? text.split("\n").length : 0;
}

function lastOutputLine(data: StepFeedData): string | undefined {
	const lines = (data.outputText ?? "")
		.split("\n")
		.map((line) => sanitizeDisplayText(line).trim())
		.filter((line) => line.length > 0);
	return lines.at(-1);
}

const COMMAND_VERBS = new Set(["运行", "等待"]);
const EDIT_VERBS = new Set(["写入", "编辑", "删除", "新建", "新建目录", "重命名", "移动"]);

/** The rows of one step that reported no kernel activity: one row from its label. */
function labelRows(step: FeedStep, options: FeedBuildOptions): FeedRow[] {
	const action = stepAction({ toolName: step.toolName, args: step.args }, options.labelContext);
	const key = `step:${step.toolCallId}`;
	const target = action.target;
	if (step.status === "running" || step.status === "queued") {
		const elapsed = step.startedAt !== undefined ? Math.max(0, options.now - step.startedAt) : 0;
		const rows: FeedRow[] = [
			{
				key,
				kind: "running",
				stepId: step.toolCallId,
				...runningGlyph(options.tick, elapsed),
				verb: action.verb,
				target,
				...(step.startedAt !== undefined ? { right: clockText(elapsed) } : {}),
			},
		];
		const tail = step.data.outputTail;
		if (tail) {
			const shown = options.steady ? options.steady(`${key}:tail`, tail) : tail;
			rows.push({
				key: `${key}:tail`,
				kind: "tail",
				stepId: step.toolCallId,
				glyph: "↳",
				glyphColor: "dim",
				target: shown,
			});
		}
		return rows;
	}
	if (step.status === "error") return [errorRow(step, action.verb, target)];
	const command = COMMAND_VERBS.has(action.verb) && action.recognized;
	const edit = EDIT_VERBS.has(action.verb) || action.verb === "记笔记";
	const lines = outputLineCount(step.data);
	const result = command
		? lastOutputLine(step.data)
		: !action.recognized && lines > 0
			? `${lines} 行输出`
			: action.more;
	return [
		{
			key,
			kind: "done",
			stepId: step.toolCallId,
			glyph: command ? "$" : action.verb === "记笔记" ? "✦" : edit ? "✎" : "✓",
			glyphColor: action.verb === "记笔记" ? "memoryAccent" : edit ? "activityText" : "success",
			verb: command && action.verb === "运行" ? undefined : action.verb,
			target,
			...(result ? { result, resultColor: "dim" as const } : {}),
			...(durationText(step.data.durationMs) ? { right: durationText(step.data.durationMs) } : {}),
		},
	];
}

interface TimedRows {
	time: number;
	order: number;
	rows: FeedRow[];
}

/** Every row of one step, in the order its effects happened. */
function stepRows(
	step: FeedStep,
	index: number,
	options: FeedBuildOptions,
	budget: { previews: number; memory: number },
): FeedRow[] {
	const data = step.data;
	const items: TimedRows[] = [];
	let order = 0;
	for (const activity of [...data.activities].sort((a, b) => a.startedAt - b.startedAt)) {
		items.push({ time: activity.startedAt, order: order++, rows: activityRows(step, activity, options) });
	}
	for (const change of aggregateChanges([{ data, toolName: step.toolName, order: index }], options.cwd)) {
		const withPreview = budget.previews > 0 && change.rows.length > 0 && change.scope === "project";
		if (withPreview) budget.previews--;
		items.push({ time: change.firstAt, order: order++, rows: changeRows(step, change, withPreview) });
	}
	data.memoryChanges.forEach((change, memoryIndex) => {
		const withPreview = budget.memory > 0;
		if (withPreview) budget.memory--;
		items.push({ time: change.at, order: order++, rows: memoryRows(step, change, memoryIndex, withPreview) });
	});
	if (items.length === 0) return labelRows(step, options);
	items.sort((a, b) => a.time - b.time || a.order - b.order);
	const rows = items.flatMap((item) => item.rows);
	const live = step.status === "running" || step.status === "queued";
	if (live && !data.activities.some((activity) => activity.status === "running")) {
		rows.push(...labelRows(step, options));
	} else if (step.status === "error") {
		const action = stepAction({ toolName: step.toolName, args: step.args }, options.labelContext);
		rows.push(errorRow(step, action.verb, action.target));
	}
	return rows;
}

/** The feed of a turn: thinking rows in between the steps they preceded. */
export function buildFeedRows(
	steps: readonly FeedStep[],
	thinking: readonly FeedThinking[],
	options: FeedBuildOptions,
): FeedRow[] {
	const rows: FeedRow[] = [];
	const budget = { previews: FEED_PREVIEW_EDITS, memory: 1 };
	const pushThinking = (predicate: (segment: FeedThinking) => boolean) => {
		for (const segment of thinking) {
			if (!predicate(segment)) continue;
			const text = segment.text.replace(/\s+/g, " ").trim();
			if (!text) continue;
			rows.push({ key: `think:${segment.key}`, kind: "think", glyph: "∴", glyphColor: "dim", target: text });
		}
	};
	steps.forEach((step, index) => {
		pushThinking((segment) => segment.afterStep === index);
		rows.push(...stepRows(step, index, options, budget));
	});
	pushThinking((segment) => segment.afterStep >= steps.length);
	return rows;
}

/**
 * A long live turn keeps its newest rows: older ones fold into one `⋯` row,
 * except failures, which never fold.
 */
export function capLiveFeed(rows: readonly FeedRow[], max = LIVE_FEED_MAX_ROWS): FeedRow[] {
	if (rows.length <= max) return [...rows];
	const keepFrom = rows.length - max;
	const kept: FeedRow[] = [];
	let hidden = 0;
	rows.forEach((row, index) => {
		if (index >= keepFrom || row.persistent) kept.push(row);
		else if (row.kind !== "preview" && row.kind !== "tail") hidden++;
	});
	if (hidden > 0) {
		kept.unshift({ key: "more:live", kind: "more", glyph: "⋯", glyphColor: "dim", target: `前面还有 ${hidden} 行` });
	}
	return kept;
}

/** Where a sentence or clause ends: the thinking line only moves at these. */
const CLAUSE_END = /[。！？!?；;…]|\.(?=\s|$)|\n/g;

/**
 * The latest completed sentence of a thinking trace, on one line. A trace
 * with no completed sentence yet shows what it has so far.
 */
export function latestThinkingSentence(text: string): string {
	const flat = text.replace(/\r/g, "");
	const ends = [...flat.matchAll(CLAUSE_END)].map((match) => (match.index ?? 0) + match[0].length);
	if (ends.length === 0) return flat.replace(/\s+/g, " ").trim();
	for (let index = ends.length - 1; index >= 0; index--) {
		const end = ends[index] ?? 0;
		const start = index > 0 ? (ends[index - 1] ?? 0) : 0;
		const sentence = flat.slice(start, end).replace(/\s+/g, " ").trim();
		if (sentence.replace(/[。！？!?；;….\s]/g, "").length >= 4) return sentence;
	}
	return flat.slice(0, ends.at(-1)).replace(/\s+/g, " ").trim();
}

export interface FeedRenderOptions {
	width: number;
	now: number;
	/** When the row first appeared (enter highlight); undefined never highlights. */
	since?: number;
	expanded?: boolean;
}

function styledPath(path: string): string {
	const slash = path.lastIndexOf("/");
	if (slash === -1 || slash === path.length - 1) return theme.bold(theme.fg("activityText", path));
	return `${theme.fg("muted", path.slice(0, slash + 1))}${theme.bold(theme.fg("activityText", path.slice(slash + 1)))}`;
}

/** `+12 −4`, with zero sides left out: a new file reads `+47`, a deleted one `−47`. */
export function formatCounts(counts: { added: number; removed: number }): string {
	const parts: string[] = [];
	if (counts.added > 0 || counts.removed === 0) parts.push(theme.fg("success", `+${counts.added}`));
	if (counts.removed > 0) parts.push(theme.fg("error", `−${counts.removed}`));
	return parts.join(" ");
}

/** A subagent's name as a small chip. */
export function agentChip(name: string): string {
	return theme.bg("chipBg", theme.fg("chipText", ` ${name} `));
}

/**
 * One line: `left` truncated to leave room for `right`, `right` flush at the
 * row's edge. The edge stops at {@link FEED_MAX_ROW_WIDTH} on wide terminals.
 */
export function composeLine(left: string, right: string, width: number): string {
	const rowWidth = Math.max(1, Math.min(width, FEED_MAX_ROW_WIDTH));
	const rightWidth = visibleWidth(right);
	if (!right || rightWidth + 4 > rowWidth) return truncateToWidth(left, Math.max(1, width), "…");
	const room = rowWidth - rightWidth - 2;
	const fitted = truncateToWidth(left, room, "…");
	return `${fitted}${" ".repeat(Math.max(2, rowWidth - visibleWidth(fitted) - rightWidth))}${right}`;
}

/** Paint a row with its enter highlight (strong, then faint, then none). */
export function paintEnter(line: string, width: number, since: number | undefined, now: number): string {
	const stage = rowEnterStage(since, now);
	if (stage === "none") return line;
	const rowWidth = Math.max(1, Math.min(width, FEED_MAX_ROW_WIDTH));
	const padded = line + " ".repeat(Math.max(0, rowWidth - visibleWidth(line)));
	return theme.bg(stage === "flash" ? "rowFlashBg" : "rowFlashFadeBg", padded);
}

/** A feed row as terminal lines (the row, then its expanded detail). */
export function renderFeedRow(row: FeedRow, options: FeedRenderOptions): string[] {
	const width = Math.max(1, options.width);
	if (row.kind === "preview" && row.diff) {
		const add = row.diff.kind === "add";
		const text = `${add ? "+" : "−"} ${row.diff.text}`;
		const colored = theme.fg(add ? "diffAddedText" : "diffRemovedText", text);
		const tinted =
			theme.colorMode === "truecolor"
				? theme.bg(add ? "diffAddedLineBg" : "diffRemovedLineBg", ` ${colored} `)
				: colored;
		return [truncateToWidth(`     ${tinted}`, Math.min(width, FEED_MAX_ROW_WIDTH), "…")];
	}
	if (row.kind === "tail") {
		return [
			truncateToWidth(`     ${theme.fg("dim", `↳ ${row.target ?? ""}`)}`, Math.min(width, FEED_MAX_ROW_WIDTH), "…"),
		];
	}
	if (row.kind === "think") {
		return [
			truncateToWidth(
				` ${theme.fg("dim", "∴")} ${theme.italic(theme.fg("thinkingText", row.target ?? ""))}`,
				Math.min(width, FEED_MAX_ROW_WIDTH),
				"…",
			),
		];
	}
	if (row.kind === "more") {
		return [truncateToWidth(` ${theme.fg("dim", `⋯ ${row.target ?? ""}`)}`, width, "…")];
	}
	const glyph =
		row.glyphColor === "activityText" ? theme.fg("activityText", row.glyph) : theme.fg(row.glyphColor, row.glyph);
	const parts: string[] = [` ${row.kind === "running" ? theme.bold(glyph) : glyph}`];
	if (row.verb) parts.push(theme.fg(row.kind === "running" ? "activityAccent" : "muted", row.verb));
	if (row.tag) parts.push(agentChip(row.tag));
	if (row.target) parts.push(row.targetIsPath ? styledPath(row.target) : theme.fg("activityText", row.target));
	let left = parts.join(" ");
	if (row.counts) left += ` ${formatCounts(row.counts)}`;
	if (row.result) left += theme.fg(row.resultColor ?? "dim", ` · ${row.result}`);
	const caret = row.expandKey ? theme.fg("dim", options.expanded ? "▾" : "▸") : "";
	const rightText = [row.right ? theme.fg(row.rightColor ?? "dim", row.right) : "", caret].filter(Boolean).join(" ");
	const line = paintEnter(composeLine(left, rightText, width), width, options.since, options.now);
	if (!options.expanded || !row.detail) return [line];
	return [
		line,
		...row.detail.map((detail) =>
			truncateToWidth(`     ${theme.fg("muted", detail)}`, Math.min(width, FEED_MAX_ROW_WIDTH), "…"),
		),
	];
}
