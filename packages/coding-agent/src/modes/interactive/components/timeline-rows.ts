import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { KernelActivity, KernelMemoryChange } from "../../../core/kernel/shared.js";
import { type ThemeColor, theme } from "../theme/theme.js";
import { type DiffRow, diffRowsFromEdit, renderDiffRows, sanitizeDisplayText } from "./diff-rows.js";
import {
	aggregateChanges,
	type ChangeEntry,
	cleanMemoryTitle,
	commitIdFromStep,
	localizeResultDetail,
	recordAgentName,
	type StepFeedData,
} from "./feed-data.js";
import { stepAction, turnStepLabel } from "./step-label.js";
import {
	firstSentence,
	formatBoxDuration,
	formatBoxTokens,
	type TimelineEntry,
	type TurnTimeline,
} from "./turn-timeline.js";

/**
 * The rows of a turn's box, in the order things happened: one row per
 * thought, command, run of file reads, edited file, memory, subagent, retry,
 * compaction, error and interjection. A row carries what it says; the box
 * renderer decides how it looks (glyph colors, spinner, highlight, clipping).
 */

export type BoxRowKind =
	| "think"
	| "say"
	| "cmd"
	| "read"
	| "edit"
	| "memory"
	| "subagent"
	| "step"
	| "retry"
	| "compact"
	| "error"
	| "steer";

export type BoxRowStatus = "running" | "done" | "failed" | "stopped" | "plain";

export interface MetaPart {
	text: string;
	color: ThemeColor;
}

export interface BoxRow {
	key: string;
	kind: BoxRowKind;
	status: BoxRowStatus;
	/** The glyph once the row is not running (a running row shows the spinner). */
	glyph: string;
	glyphColor: ThemeColor;
	/** A prefix in its own color (`思考了 4秒`, `思考中`). */
	keyword?: string;
	keywordColor?: ThemeColor;
	text: string;
	textColor: ThemeColor;
	/** Right-aligned facts. */
	meta: MetaPart[];
	/** When the running row started: its own clock. */
	startedAt?: number;
	/** One live line under the row (`└ …`): a command's latest output, a subagent's current step. */
	sub?: string;
	/** Live thinking text for the fixed three-line window under the row. */
	window?: string;
	/** Lines the row shows once opened; absent when it has nothing more to show. */
	detail?: (width: number) => string[];
	/** Stays visible when the box folds (failures). */
	persistent?: boolean;
	/** Files a merged read row covers. */
	files?: string[];
}

export interface RowStep {
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: "queued" | "running" | "done" | "error";
	startedAt?: number;
}

export interface RowBuildContext {
	now: number;
	cwd: string;
	steps: ReadonlyMap<string, RowStep>;
	/** The turn is still running. */
	live: boolean;
	stopped: boolean;
	/** `hideThinkingBlock`: thinking rows keep their time and size, never their text. */
	hideThinking?: boolean;
}

/** Most lines an opened row shows; the rest is summarized in one line. */
export const DETAIL_MAX_LINES = 200;

const EDIT_VERBS = new Set(["写入", "编辑", "删除", "新建", "新建目录", "重命名", "移动"]);
const COMMAND_VERBS = new Set(["运行", "等待"]);

function clip(lines: string[], width: number): string[] {
	if (lines.length <= DETAIL_MAX_LINES) return lines;
	const rest = lines.length - DETAIL_MAX_LINES;
	return [...lines.slice(0, DETAIL_MAX_LINES), theme.fg("dim", truncateToWidth(`… 还有 ${rest} 行`, width, ""))];
}

function wrapped(text: string, width: number, color: ThemeColor): string[] {
	const lines: string[] = [];
	for (const paragraph of sanitizeDisplayText(text).split("\n")) {
		const parts = wrapTextWithAnsi(paragraph, Math.max(8, width));
		for (const part of parts.length > 0 ? parts : [""]) lines.push(theme.fg(color, part));
	}
	while (
		lines.length > 0 &&
		lines
			.at(-1)
			?.replace(/\x1b\[[0-9;]*m/g, "")
			.trim() === ""
	)
		lines.pop();
	return clip(lines, width);
}

function preformatted(text: string, width: number): string[] {
	const lines = sanitizeDisplayText(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
		.split("\n")
		.map((line) => theme.fg("muted", truncateToWidth(line, Math.max(4, width), "…")));
	while (
		lines.length > 0 &&
		lines
			.at(-1)
			?.replace(/\x1b\[[0-9;]*m/g, "")
			.trim() === ""
	)
		lines.pop();
	return clip(lines, width);
}

function durationText(ms: number | undefined): string | undefined {
	if (ms === undefined || ms < 1000) return undefined;
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}秒` : formatBoxDuration(ms);
}

function okMeta(result: string | undefined, duration?: number): MetaPart[] {
	const tail = result ?? durationText(duration);
	return [{ text: tail ? `✓ ${tail}` : "✓", color: "diffAddedText" }];
}

function failMeta(result: string | undefined): MetaPart[] {
	return [{ text: `✗ ${result ?? "失败"}`, color: "diffRemovedText" }];
}

function countsMeta(added: number, removed: number): MetaPart[] {
	const parts: MetaPart[] = [];
	if (added > 0 || removed === 0) parts.push({ text: `+${added}`, color: "diffAddedText" });
	if (added > 0 && removed > 0) parts.push({ text: " ", color: "dim" });
	if (removed > 0) parts.push({ text: `−${removed}`, color: "diffRemovedText" });
	return parts;
}

function lastOutputLine(text: string | undefined): string | undefined {
	return sanitizeDisplayText((text ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
}

function isInterrupt(error: string | undefined): boolean {
	return error !== undefined && /^(KeyboardInterrupt|已中断|Request was aborted|Operation aborted)/.test(error);
}

function stoppedRow(row: BoxRow): BoxRow {
	return {
		...row,
		status: "stopped",
		glyph: "■",
		glyphColor: "dim",
		meta: [{ text: "已停止", color: "dim" }],
		sub: undefined,
		window: undefined,
	};
}

/** Change entries as the diff lines an opened edit row shows. */
export function changeDetail(change: ChangeEntry): (width: number) => string[] {
	return (width) => {
		if (change.binary) return [theme.fg("dim", "二进制文件，没有文字改动可看")];
		if (change.rows.length === 0) {
			return [theme.fg("dim", change.kind === "deleted" ? "文件已删除" : "没有记录到改动内容")];
		}
		const lines = clip(renderDiffRows(change.rows, { width, indent: 0 }), width);
		if (change.truncated) lines.push(theme.fg("dim", "改动太长，只记录了前面一部分"));
		return lines;
	};
}

function changeRow(key: string, change: ChangeEntry, status: BoxRowStatus): BoxRow {
	const scratch = change.scope === "scratch";
	const renamed = change.kind === "renamed" && change.oldPath;
	const meta: MetaPart[] = [];
	if (scratch) meta.push({ text: "临时 ", color: "dim" });
	if (change.scope === "memory") meta.push({ text: "规则文件 ", color: "dim" });
	if (change.agent) meta.push({ text: `${change.agent} `, color: "chipText" });
	meta.push(...countsMeta(change.added, change.removed));
	return {
		key,
		kind: "edit",
		status,
		glyph: change.kind === "deleted" ? "✗" : "✎",
		glyphColor: change.kind === "deleted" ? "diffRemovedText" : "runCardWarn",
		text: renamed ? `${change.oldPath} → ${change.path}` : change.path,
		textColor: scratch ? "muted" : "activityText",
		meta,
		detail: changeDetail(change),
	};
}

const MEMORY_VERB: Record<KernelMemoryChange["op"], string> = { created: "记住", updated: "改了", deleted: "删掉" };

function memoryNoun(change: KernelMemoryChange): string {
	if (change.kind === "rules_file") return change.scope === "project" ? "项目规则" : "全局规则";
	if (change.kind === "skill") return "技能";
	if (change.kind === "subagent") return "子代理设定";
	if (change.kind === "prompt_note") return "提示";
	return "";
}

/** Before/after of a memory change: only the lines that changed, and a rename said in words. */
export function memoryDetail(change: KernelMemoryChange): (width: number) => string[] {
	return (width) => {
		const lines: string[] = [];
		const label = (text: string) => theme.fg("dim", text);
		if (change.previousTitle && change.previousTitle !== change.title) {
			lines.push(
				`${label("改名  ")}${theme.fg("muted", cleanMemoryTitle(change.previousTitle))}${label(" → ")}${theme.fg("activityText", cleanMemoryTitle(change.title))}`,
			);
		}
		const before = change.before?.trimEnd() ?? "";
		const after = change.after?.trimEnd() ?? "";
		const paint = (rows: DiffRow[]) => renderDiffRows(rows, { width, indent: 0 }).map((line) => line);
		if (change.op === "created" || (!before && after)) {
			lines.push(label("新记的"));
			lines.push(...paint(after.split("\n").map((text) => ({ kind: "add" as const, text }))));
		} else if (change.op === "deleted" || (before && !after)) {
			lines.push(label("删掉的"));
			lines.push(...paint(before.split("\n").map((text) => ({ kind: "del" as const, text }))));
		} else if (before || after) {
			const rows = diffRowsFromEdit(before, after).filter((row) => row.kind !== "ctx");
			const removed = rows.filter((row) => row.kind === "del");
			const added = rows.filter((row) => row.kind === "add");
			if (removed.length > 0) {
				lines.push(label("原来"));
				lines.push(...paint(removed));
			}
			if (added.length > 0) {
				lines.push(label("现在"));
				lines.push(...paint(added));
			}
			if (removed.length === 0 && added.length === 0) lines.push(label("内容没变"));
		} else {
			lines.push(label("没有记录到内容"));
		}
		return clip(
			lines.map((line) => truncateToWidth(line, width, "…")),
			width,
		);
	};
}

function memoryRow(key: string, change: KernelMemoryChange): BoxRow {
	const noun = memoryNoun(change);
	const title = cleanMemoryTitle(change.title);
	const renamed = change.previousTitle && change.previousTitle !== change.title;
	const meta: MetaPart[] = [];
	const agent = recordAgentName(change);
	if (agent) meta.push({ text: `${agent} `, color: "chipText" });
	if (change.scope === "global") meta.push({ text: "全局 · ", color: "memoryAccent" });
	meta.push({
		text: change.op === "created" ? "新记" : change.op === "deleted" ? "删了" : renamed ? "改名" : "改了",
		color: "dim",
	});
	return {
		key,
		kind: "memory",
		status: "done",
		glyph: "✦",
		glyphColor: "memoryAccent",
		text: `${MEMORY_VERB[change.op]}${noun}：${title}`,
		textColor: "memoryAccent",
		meta,
		detail: memoryDetail(change),
	};
}

function activityRow(stepId: string, activity: KernelActivity, timeline: TurnTimeline, ctx: RowBuildContext): BoxRow {
	const key = `act:${stepId}:${activity.id}`;
	const label = sanitizeDisplayText(activity.label).replace(/\s+/g, " ").trim();
	const result = activity.detail ? localizeResultDetail(activity.detail) : undefined;
	const duration =
		activity.endedAt !== undefined && activity.startedAt ? activity.endedAt - activity.startedAt : undefined;
	const running = activity.status === "running";
	const base = { key, startedAt: activity.startedAt || undefined };
	switch (activity.kind) {
		case "command": {
			const tail = running && activity.detail ? sanitizeDisplayText(activity.detail).trim() : undefined;
			return {
				...base,
				kind: "cmd",
				status: running ? "running" : activity.status === "error" ? "failed" : "done",
				glyph: "$",
				glyphColor: "activityAccent",
				text: label,
				textColor: "activityText",
				meta: running ? [] : activity.status === "error" ? failMeta(result) : okMeta(result, duration),
				...(tail ? { sub: timeline.steadyLine(`${key}:tail`, tail, ctx.now) } : {}),
			};
		}
		case "read":
			return {
				...base,
				kind: "read",
				status: running ? "running" : activity.status === "error" ? "failed" : "done",
				glyph: "✓",
				glyphColor: "diffAddedText",
				text: label,
				textColor: "muted",
				meta: activity.status === "error" ? failMeta(result) : [],
				files: [label],
			};
		default: {
			const verb =
				activity.kind === "search"
					? "搜索"
					: activity.kind === "fetch"
						? "读网页"
						: activity.kind === "subagent"
							? "子代理"
							: "";
			return {
				...base,
				kind: activity.kind === "subagent" ? "subagent" : "step",
				status: running ? "running" : activity.status === "error" ? "failed" : "done",
				glyph: activity.kind === "subagent" ? "◇" : "✓",
				glyphColor: activity.kind === "subagent" ? "activityAccent" : "diffAddedText",
				text: `${verb} ${label}`.trim(),
				textColor: "activityText",
				meta: running ? [] : activity.status === "error" ? failMeta(result) : okMeta(result, duration),
				...(running && activity.detail
					? { sub: timeline.steadyLine(`${key}:tail`, sanitizeDisplayText(activity.detail).trim(), ctx.now) }
					: {}),
			};
		}
	}
}

/** What a step's label says when the kernel reported no records for it. */
function fallbackRows(
	step: RowStep,
	data: StepFeedData,
	timeline: TurnTimeline,
	ctx: RowBuildContext,
	withPrimaryOutput: boolean,
): BoxRow[] {
	const context = { handleCommands: timeline.stepHandleContext.get(step.toolCallId) };
	const action = stepAction({ toolName: step.toolName, args: step.args }, context);
	const running = step.status === "running" || step.status === "queued";
	const key = `step:${step.toolCallId}`;
	const startedAt = step.startedAt;
	// A cell that only read files becomes one read row per file, so neighbouring reads merge.
	if (!running && step.status !== "error" && action.recognized) {
		const effects = turnStepLabel({ toolName: step.toolName, args: step.args }, context).split("，");
		if (effects.length > 0 && effects.every((effect) => effect.startsWith("读取 "))) {
			return effects.map((effect, index) => ({
				key: `${key}:r${index}`,
				kind: "read" as const,
				status: "done" as const,
				glyph: "✓",
				glyphColor: "diffAddedText" as const,
				text: effect.slice(3),
				textColor: "muted" as const,
				meta: [],
				files: [effect.slice(3)],
			}));
		}
	}
	const target = action.target;
	const output = data.outputText;
	const outputDetail =
		withPrimaryOutput && output?.trim() ? (width: number) => preformatted(output, width) : undefined;
	if (COMMAND_VERBS.has(action.verb) && action.recognized) {
		const tail =
			running && data.outputTail ? timeline.steadyLine(`${key}:tail`, data.outputTail, ctx.now) : undefined;
		const last = lastOutputLine(output);
		return [
			{
				key,
				kind: "cmd",
				status: running ? "running" : "done",
				glyph: "$",
				glyphColor: "activityAccent",
				text: action.verb === "等待" ? `等待 ${target}` : target,
				textColor: "activityText",
				meta: running ? [] : okMeta(last ? truncateToWidth(last, 32, "…") : undefined, data.durationMs),
				...(startedAt !== undefined ? { startedAt } : {}),
				...(tail ? { sub: tail } : {}),
				...(outputDetail ? { detail: outputDetail } : {}),
			},
		];
	}
	if (action.verb === "读取" && action.recognized) {
		return [
			{
				key: `${key}:r0`,
				kind: "read",
				status: running ? "running" : "done",
				glyph: "✓",
				glyphColor: "diffAddedText",
				text: target,
				textColor: "muted",
				meta: [],
				files: [target],
				...(startedAt !== undefined ? { startedAt } : {}),
			},
		];
	}
	if (EDIT_VERBS.has(action.verb) && action.recognized) {
		return [
			{
				key,
				kind: "edit",
				status: running ? "running" : "done",
				glyph: action.verb === "删除" ? "✗" : "✎",
				glyphColor: action.verb === "删除" ? "diffRemovedText" : "runCardWarn",
				text: action.verb === "写入" || action.verb === "编辑" ? target : `${action.verb} ${target}`,
				textColor: "activityText",
				meta: [],
				...(startedAt !== undefined ? { startedAt } : {}),
			},
		];
	}
	if (action.verb === "记笔记") {
		return [
			{
				key,
				kind: "memory",
				status: running ? "running" : "done",
				glyph: "✦",
				glyphColor: "memoryAccent",
				text: "记笔记",
				textColor: "memoryAccent",
				meta: [],
				...(startedAt !== undefined ? { startedAt } : {}),
			},
		];
	}
	const text = action.recognized ? `${action.verb} ${target}`.trim() : target || "Python";
	return [
		{
			key,
			kind: "step",
			status: running ? "running" : "done",
			glyph: "✓",
			glyphColor: "diffAddedText",
			text: action.more ? `${text}，${action.more}` : text,
			textColor: action.recognized ? "activityText" : "muted",
			meta: running ? [] : okMeta(undefined, data.durationMs),
			...(startedAt !== undefined ? { startedAt } : {}),
			...(outputDetail ? { detail: outputDetail } : {}),
		},
	];
}

function errorRow(step: RowStep, data: StepFeedData, timeline: TurnTimeline): BoxRow {
	const context = { handleCommands: timeline.stepHandleContext.get(step.toolCallId) };
	const action = stepAction({ toolName: step.toolName, args: step.args }, context);
	const what = action.recognized ? `${action.verb} ${action.target}`.trim() : action.target || "Python";
	const error = sanitizeDisplayText(data.error ?? "出错了");
	const detail = data.errorDetail ?? [];
	return {
		key: `err:${step.toolCallId}`,
		kind: "error",
		status: "failed",
		glyph: "✗",
		glyphColor: "error",
		text: `${what} 出错：${error}`,
		textColor: "error",
		meta: [],
		persistent: true,
		...(detail.length > 0 ? { detail: (width: number) => preformatted(detail.join("\n"), width) } : {}),
	};
}

interface TimedRows {
	time: number;
	order: number;
	rows: BoxRow[];
}

function stepRows(step: RowStep, timeline: TurnTimeline, ctx: RowBuildContext, order: number): BoxRow[] {
	const data = timeline.stepData.get(step.toolCallId) ?? { activities: [], memoryChanges: [], legacyDiffs: [] };
	const items: TimedRows[] = [];
	let index = 0;
	for (const activity of [...data.activities].sort((a, b) => a.startedAt - b.startedAt)) {
		items.push({
			time: activity.startedAt,
			order: index++,
			rows: [activityRow(step.toolCallId, activity, timeline, ctx)],
		});
	}
	for (const change of aggregateChanges([{ data, toolName: step.toolName, order }], ctx.cwd)) {
		items.push({
			time: change.firstAt,
			order: index++,
			rows: [changeRow(`file:${step.toolCallId}:${change.key}`, change, "done")],
		});
	}
	data.memoryChanges.forEach((change, memoryIndex) => {
		items.push({
			time: change.at,
			order: index++,
			rows: [memoryRow(`mem:${step.toolCallId}:${change.id ?? memoryIndex}`, change)],
		});
	});
	const running = step.status === "running" || step.status === "queued";
	if (items.length === 0) {
		if (step.status === "error") {
			return isInterrupt(data.error)
				? fallbackRows({ ...step, status: "done" }, data, timeline, ctx, true).map(stoppedRow)
				: [errorRow(step, data, timeline)];
		}
		return fallbackRows(step, data, timeline, ctx, true);
	}
	items.sort((a, b) => a.time - b.time || a.order - b.order);
	const rows = items.flatMap((item) => item.rows);
	// The last command of a cell carries the cell's output when opened.
	const lastCommand = [...rows].reverse().find((row) => row.kind === "cmd");
	if (lastCommand && !running && data.outputText?.trim()) {
		const output = data.outputText;
		lastCommand.detail = (width) => preformatted(output, width);
	}
	if (running && !data.activities.some((activity) => activity.status === "running")) {
		// The steps it reported are done, the cell is not: say so instead of repeating them.
		rows.push({
			key: `step:${step.toolCallId}:rest`,
			kind: "step",
			status: "running",
			glyph: "✓",
			glyphColor: "diffAddedText",
			text: "这段代码还在运行",
			textColor: "muted",
			meta: [],
			...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
			...(data.outputTail
				? { sub: timeline.steadyLine(`step:${step.toolCallId}:tail`, data.outputTail, ctx.now) }
				: {}),
		});
	} else if (step.status === "error") {
		rows.push(isInterrupt(data.error) ? stoppedRow(errorRow(step, data, timeline)) : errorRow(step, data, timeline));
	}
	return rows;
}

function thinkRows(
	timeline: TurnTimeline,
	entry: Extract<TimelineEntry, { kind: "message" }>,
	ctx: RowBuildContext,
): BoxRow[] {
	const rows: BoxRow[] = [];
	const content = entry.message.content ?? [];
	const firstToolCall = content.findIndex((block) => block.type === "toolCall");
	content.forEach((block, index) => {
		if (block.type === "thinking") {
			const raw = (block.thinking ?? "").trim();
			const text = ctx.hideThinking ? "" : raw;
			const key = `${entry.key}:${index}`;
			const timing = timeline.thinkingTiming.get(key);
			const open =
				ctx.live && !entry.ended && (timing ? timing.endedAt === undefined : index === content.length - 1);
			if (!raw && !open) return;
			const rowKey = `think:${key}`;
			if (open) {
				rows.push({
					key: rowKey,
					kind: "think",
					status: "running",
					glyph: "∴",
					glyphColor: "dim",
					keyword: "思考中",
					keywordColor: "activityAccent",
					text: "",
					textColor: "thinkingText",
					meta: [],
					startedAt: timing?.startedAt ?? ctx.now,
					...(ctx.hideThinking ? {} : { window: timeline.steadyPrefix(rowKey, text, ctx.now) }),
					...(text ? { detail: (width: number) => wrapped(text, width, "thinkingText") } : {}),
				});
				return;
			}
			const duration =
				timing?.endedAt !== undefined
					? formatBoxDuration(Math.max(1000, timing.endedAt - timing.startedAt))
					: undefined;
			const tokens = formatBoxTokens(timeline.thinkingTokens(key, raw));
			const summary = text ? firstSentence(text) : "";
			rows.push({
				key: rowKey,
				kind: "think",
				status: "done",
				glyph: "∴",
				glyphColor: "dim",
				keyword: duration ? `思考了 ${duration}` : "思考了",
				keywordColor: "dim",
				text: summary,
				textColor: "muted",
				meta: [{ text: duration ? `${duration} · ${tokens}` : tokens, color: "dim" }],
				...(text && summary !== text.replace(/\s+/g, " ").trim()
					? { detail: (width: number) => wrapped(text, width, "thinkingText") }
					: {}),
			});
		} else if (block.type === "text" && firstToolCall !== -1 && index < firstToolCall) {
			const text = (block.text ?? "").trim();
			if (!text) return;
			const summary = firstSentence(text);
			rows.push({
				key: `say:${entry.key}:${index}`,
				kind: "say",
				status: "plain",
				glyph: "·",
				glyphColor: "dim",
				text: summary,
				textColor: "muted",
				meta: [],
				...(summary !== text.replace(/\s+/g, " ").trim()
					? { detail: (width: number) => wrapped(text, width, "muted") }
					: {}),
			});
		}
	});
	return rows;
}

/** A settled context size as a round figure (`41k`, not `41.0k`); it never changes, so its width may vary. */
function contextSize(tokens: number): string {
	return formatBoxTokens(tokens).replace(/\.0(?=[kM]$)/, "");
}

function eventRow(entry: TimelineEntry, ctx: RowBuildContext): BoxRow | undefined {
	switch (entry.kind) {
		case "steer": {
			const long = visibleWidth(entry.text) > 48;
			return {
				key: entry.key,
				kind: "steer",
				status: "plain",
				glyph: "›",
				glyphColor: "memoryAccent",
				keyword: "你插话：",
				keywordColor: "muted",
				text: entry.text,
				textColor: "activityText",
				meta: [],
				...(long ? { detail: (width: number) => wrapped(entry.text, width, "activityText") } : {}),
			};
		}
		case "retry": {
			const retry = entry.retry;
			const remaining = Math.max(0, Math.ceil((retry.startedAt + retry.delayMs - ctx.now) / 1000));
			const text =
				retry.outcome === "ok"
					? `${retry.reason}，已自动重试`
					: retry.outcome === "failed"
						? `${retry.reason}，重试没成功${retry.finalError ? `：${sanitizeDisplayText(retry.finalError)}` : ""}`
						: retry.outcome === "stopped" || ctx.stopped
							? `${retry.reason}，已停止`
							: remaining > 0
								? `${retry.reason}，${remaining} 秒后重试`
								: `${retry.reason}，正在重试`;
			return {
				key: entry.key,
				kind: "retry",
				status:
					retry.outcome === undefined && !ctx.stopped ? "running" : retry.outcome === "failed" ? "failed" : "done",
				glyph: "↻",
				glyphColor: retry.outcome === "failed" ? "error" : retry.outcome === "ok" ? "dim" : "runCardWarn",
				text,
				textColor: retry.outcome === "failed" ? "error" : retry.outcome === "ok" ? "dim" : "runCardWarn",
				meta: [],
				...(retry.outcome === "failed" ? { persistent: true } : {}),
			};
		}
		case "compact": {
			const compaction = entry.compaction;
			const running = compaction.endedAt === undefined && !ctx.stopped;
			const text = running
				? "上下文快满了，正在整理前面的内容…"
				: compaction.failed
					? `这次没整理成：${sanitizeDisplayText(compaction.failed)}`
					: compaction.before !== undefined && compaction.after !== undefined
						? `整理完成：${contextSize(compaction.before)} → ${contextSize(compaction.after)} tokens，重要的结论都留着`
						: compaction.before !== undefined
							? `整理完成（原来 ${contextSize(compaction.before)} tokens），重要的结论都留着`
							: "整理完成，重要的结论都留着";
			return {
				key: entry.key,
				kind: "compact",
				status: running ? "running" : "done",
				glyph: "⇣",
				glyphColor: compaction.failed ? "runCardWarn" : "dim",
				text,
				textColor: compaction.failed ? "runCardWarn" : "muted",
				meta: [],
				startedAt: compaction.startedAt,
			};
		}
		case "subagent": {
			const sub = entry.sub;
			const running = sub.status === "running" && !ctx.stopped;
			const report = sub.report;
			return {
				key: entry.key,
				kind: "subagent",
				status: running ? "running" : sub.status === "failed" ? "failed" : "done",
				glyph: "◇",
				glyphColor: "activityAccent",
				keyword: "子代理",
				keywordColor: "muted",
				text: sub.name,
				textColor: "activityText",
				meta: running
					? []
					: sub.status === "failed"
						? failMeta(sub.result)
						: okMeta(sub.result ? truncateToWidth(sub.result, 36, "…") : undefined),
				startedAt: sub.startedAt,
				...(running && sub.line ? { sub: sub.line } : {}),
				...(report?.trim() ? { detail: (width: number) => wrapped(report, width, "muted") } : {}),
			};
		}
		default:
			return undefined;
	}
}

/** Consecutive read rows read as one: `正在读取 x（第 2 个）` → `读取了 3 个文件`. */
function mergeReads(rows: BoxRow[]): BoxRow[] {
	const out: BoxRow[] = [];
	for (const row of rows) {
		const last = out.at(-1);
		if (row.kind === "read" && row.status !== "failed" && last?.kind === "read" && last.status !== "failed") {
			const files = [...(last.files ?? [last.text]), ...(row.files ?? [row.text])];
			const running = row.status === "running" || last.status === "running";
			const current = row.status === "running" ? (row.files?.[0] ?? row.text) : undefined;
			out[out.length - 1] = {
				...last,
				status: running ? "running" : row.status === "stopped" ? "stopped" : "done",
				text: current ? `${current}（第 ${files.length} 个）` : last.text,
				files,
				...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
			};
			continue;
		}
		out.push(row);
	}
	return out.map((row) => {
		if (row.kind !== "read") return row;
		const files = row.files ?? [row.text];
		if (row.status === "running") {
			return {
				...row,
				text: files.length > 1 ? row.text : (files[0] ?? row.text),
				keyword: "正在读取",
				keywordColor: "activityAccent",
			};
		}
		if (files.length > 1) {
			return {
				...row,
				keyword: undefined,
				text: `读取了 ${files.length} 个文件`,
				detail: (width: number) =>
					clip(
						files.map(
							(file) =>
								`${theme.fg("diffAddedText", "✓")} ${theme.fg("muted", truncateToWidth(file, width - 2, "…"))}`,
						),
						width,
					),
			};
		}
		return { ...row, text: `读取 ${files[0] ?? row.text}` };
	});
}

/** Every row of a turn, in order. */
export function buildTimelineRows(timeline: TurnTimeline, ctx: RowBuildContext): BoxRow[] {
	const rows: BoxRow[] = [];
	const snapshotNames = new Set(
		timeline.entries.flatMap((entry) => (entry.kind === "subagent" ? [entry.sub.name] : [])),
	);
	let order = 0;
	// A failed model call that a retry followed is said by the retry row.
	let lastRetryIndex = -1;
	timeline.entries.forEach((entry, index) => {
		if (entry.kind === "retry") lastRetryIndex = index;
	});
	const seenSteps = new Set<string>();
	timeline.entries.forEach((entry, entryIndex) => {
		if (entry.kind !== "message") {
			const row = eventRow(entry, ctx);
			if (row) rows.push(row);
			return;
		}
		const content = entry.message.content ?? [];
		const thinking = thinkRows(timeline, entry, ctx);
		let thinkingIndex = 0;
		content.forEach((block, index) => {
			if (block.type === "thinking" || block.type === "text") {
				const rowKeyPrefix = block.type === "thinking" ? "think:" : "say:";
				const row = thinking[thinkingIndex];
				if (row && row.key === `${rowKeyPrefix}${entry.key}:${index}`) {
					rows.push(row);
					thinkingIndex++;
				}
				return;
			}
			if (block.type !== "toolCall") return;
			seenSteps.add(block.id);
			const step = ctx.steps.get(block.id) ?? {
				toolCallId: block.id,
				toolName: block.name,
				args: block.arguments,
				status: entry.ended ? ("done" as const) : ("queued" as const),
			};
			for (const row of stepRows(step, timeline, ctx, order++)) {
				// A subagent the session reported live already has its own row.
				if (row.kind === "subagent" && snapshotNames.has(row.text.replace(/^子代理 /, ""))) continue;
				rows.push(row);
			}
		});
		const message = entry.message;
		if (entry.ended && message.stopReason === "error" && message.errorMessage && lastRetryIndex < entryIndex) {
			rows.push({
				key: `err:${entry.key}`,
				kind: "error",
				status: "failed",
				glyph: "✗",
				glyphColor: "error",
				text: `模型出错：${sanitizeDisplayText(message.errorMessage).split("\n")[0] ?? ""}`,
				textColor: "error",
				meta: [],
				persistent: true,
				detail: (width) => preformatted(message.errorMessage ?? "", width),
			});
		}
	});
	// A step whose message the timeline never saw still gets its rows, after the rest.
	for (const step of ctx.steps.values()) {
		if (!seenSteps.has(step.toolCallId)) rows.push(...stepRows(step, timeline, ctx, order++));
	}
	const merged = mergeReads(rows);
	return ctx.stopped ? merged.map((row) => (row.status === "running" ? stoppedRow(row) : row)) : merged;
}

/** The facts a finished box's header and the change strip say. */
export interface TimelineFacts {
	thinkCount: number;
	commandCount: number;
	readCount: number;
	stepCount: number;
	subagentCount: number;
	errorCount: number;
	/** Files changed inside the project, one per path. */
	projectChanges: ChangeEntry[];
	/** Files changed outside the project (temp files). */
	scratchChanges: ChangeEntry[];
	memories: Array<{ key: string; change: KernelMemoryChange }>;
	commitId?: string;
}

export function timelineFacts(timeline: TurnTimeline, rows: readonly BoxRow[], ctx: RowBuildContext): TimelineFacts {
	const steps = [...ctx.steps.values()];
	const changes = aggregateChanges(
		steps.map((step, order) => ({
			data: timeline.stepData.get(step.toolCallId) ?? { activities: [], memoryChanges: [], legacyDiffs: [] },
			toolName: step.toolName,
			order,
		})),
		ctx.cwd,
	);
	let commitId: string | undefined;
	const memories: TimelineFacts["memories"] = [];
	for (const step of steps) {
		const data = timeline.stepData.get(step.toolCallId);
		if (!data) continue;
		const args = step.args as { code?: unknown; command?: unknown } | undefined;
		const code = typeof args?.code === "string" ? args.code : typeof args?.command === "string" ? args.command : "";
		commitId = commitIdFromStep(data, code) ?? commitId;
		data.memoryChanges.forEach((change, index) => {
			memories.push({ key: `mem:${step.toolCallId}:${change.id ?? index}`, change });
		});
	}
	return {
		thinkCount: rows.filter((row) => row.kind === "think").length,
		commandCount: rows.filter((row) => row.kind === "cmd").length,
		readCount: rows.reduce((sum, row) => sum + (row.kind === "read" ? (row.files?.length ?? 1) : 0), 0),
		stepCount: new Set(steps.map((step) => step.toolCallId)).size,
		subagentCount: rows.filter((row) => row.kind === "subagent").length,
		errorCount: rows.filter((row) => row.kind === "error").length,
		projectChanges: changes.filter((change) => change.scope !== "scratch"),
		scratchChanges: changes.filter((change) => change.scope === "scratch"),
		memories,
		...(commitId ? { commitId } : {}),
	};
}

/** `想了 3 次 · 跑了 4 条命令 · 改了 1 个文件 +6 −2`, styled. */
export function summaryParts(facts: TimelineFacts): Array<{ text: string; color: ThemeColor }[]> {
	const parts: Array<{ text: string; color: ThemeColor }[]> = [];
	if (facts.thinkCount > 0) parts.push([{ text: `想了 ${facts.thinkCount} 次`, color: "activityText" }]);
	if (facts.commandCount > 0) parts.push([{ text: `跑了 ${facts.commandCount} 条命令`, color: "activityText" }]);
	if (facts.readCount > 0 && facts.commandCount === 0) {
		parts.push([{ text: `读了 ${facts.readCount} 个文件`, color: "activityText" }]);
	}
	if (facts.projectChanges.length > 0) {
		const added = facts.projectChanges.reduce((sum, change) => sum + change.added, 0);
		const removed = facts.projectChanges.reduce((sum, change) => sum + change.removed, 0);
		parts.push([
			{ text: `改了 ${facts.projectChanges.length} 个文件 `, color: "activityText" },
			...countsMeta(added, removed),
		]);
	}
	if (facts.memories.length > 0) parts.push([{ text: `记住 ${facts.memories.length} 条`, color: "memoryAccent" }]);
	if (facts.subagentCount > 0) parts.push([{ text: `派了 ${facts.subagentCount} 个子代理`, color: "activityText" }]);
	if (parts.length === 0 && facts.stepCount > 0)
		parts.push([{ text: `做了 ${facts.stepCount} 步`, color: "activityText" }]);
	if (facts.errorCount > 0) parts.push([{ text: `${facts.errorCount} 处出错`, color: "error" }]);
	if (parts.length === 0) parts.push([{ text: "直接回答了", color: "muted" }]);
	return parts;
}
