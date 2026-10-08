import { ABORT_TRUNCATION_MARKER, TOOL_ABORT_FALLBACK_MESSAGE } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { KernelActivity, KernelMemoryChange } from "../../../core/kernel/shared.js";
import {
	DEFAULT_PROVIDER_RETRY_POLICY,
	DEFAULT_PROVIDER_WAIT_POLICY,
	providerRetryPolicy,
	providerStreamFailureKind,
	providerStreamFailureRetryAfterMs,
	providerStreamFailureStatus,
	providerWaitClass,
} from "../../../core/provider-retry.js";
import { SettingsManager } from "../../../core/settings-manager.js";
import { previewIpythonCode } from "../../../core/tools/code-preview.js";
import { sliceGraphemes } from "../../../utils/display-text.js";
import { type ThemeColor, theme } from "../theme/theme.js";
import { shortAgentName } from "./agent-message.js";
import { renderDiffRows, sanitizeDisplayText } from "./diff-rows.js";
import {
	aggregateChanges,
	type ChangeEntry,
	cleanMemoryTitle,
	commitIdFromStep,
	localizeResultDetail,
	type StepFeedData,
	symlinkVerb,
} from "./feed-data.js";
import { memoryBodyLines } from "./memory-detail.js";
import { stepAction, turnStepLabel } from "./step-label.js";
import { subagentTaskTag } from "./subagent-summary-line.js";
import {
	describeRetryReason,
	firstSentence,
	formatBoxDuration,
	formatBoxTokens,
	isPlainAnswer,
	replyHasWork,
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
	| "steer"
	| "notice";

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
	/** Lines the row shows once opened; absent when it has nothing more to show. */
	detail?: (width: number) => string[];
	/** A note's whole text: when it fits in a few lines the box shows it as plain text instead of a block. */
	fullText?: string;
	/** When the row's step ended, if known (with `startedAt`, the opened row says how long it took). */
	endedAt?: number;
	/** What the opened row says about the step's output (`没有输出`). */
	outputNote?: string;
	/** `detail` was made from the row's own facts, so it has nothing more to say than the row itself. */
	factsOnly?: true;
	/** The change came from another window or process: the row shows it, but counts like the title's 改了 N 个文件 must not claim it as this session's work. */
	ambient?: true;
	/** Stays visible when the box folds (failures). */
	persistent?: boolean;
	/** Files a merged read row covers. */
	files?: string[];
	/** The event this row belongs to (its step list); absent for rows no event lists. */
	groupKey?: string;
	/** Comes after the turn's last answer: no event lists it, and the closing part of the turn draws it. */
	trailing?: true;
}

export interface SpawnedSubagent {
	name: string;
	/** The key it is on the subagent lane by. */
	laneName: string;
	tag?: string;
	running: boolean;
	startedAt: number;
	endedAt?: number;
}

/** One line of the timeline: what the AI said it does or found, with its steps behind `N 步 ▸`. */
export interface TimelineEvent {
	key: string;
	/** `say`: the AI's words (or a summary of its steps when it said none); `steer`: you cut in; `fail`: the turn ended on this error. */
	kind: "say" | "steer" | "fail";
	/** When it happened (ms); 0 when unknown. */
	at: number;
	/** The first paragraph, on one line. */
	text: string;
	/** The whole text the AI wrote; it says more than `text` when it has more paragraphs or is cut to the line. */
	full?: string;
	/** `full` says more than `text`: more paragraphs, or a text cut to its cap. */
	more?: true;
	/** The commands, thoughts and edits behind the line. */
	steps: BoxRow[];
	/** Subagents dispatched at this point, in order, each with the short tag of its task and when it went out and (if known) came back. */
	spawned: SpawnedSubagent[];
	/** `fail`: the failed row (its opened lines say why). */
	row?: BoxRow;
}

export interface RowStep {
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: "queued" | "running" | "done" | "error";
	startedAt?: number;
	/** Its arguments are still streaming in: half-written code says nothing yet. */
	streaming?: boolean;
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
	/**
	 * The retry settings a replayed retry row's reason is derived with (see
	 * `replayRetryReason`). Absent: read from the current settings on disk.
	 */
	retryPolicy?: ReplayRetryPolicy;
	/** Activity id → the finished record of a background command and the step it arrived with. */
	settledActivities?: ReadonlyMap<string, { stepId: string; activity: KernelActivity }>;
	/** Activity id → the first step that listed it still running (where a background command started). */
	activityOrigins?: ReadonlyMap<string, string>;
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

function okMeta(result: string | undefined): MetaPart[] {
	return [{ text: result ? `✓ ${result}` : "✓", color: "diffAddedText" }];
}

function failMeta(result: string | undefined): MetaPart[] {
	return [{ text: `✗ ${result ?? "失败"}`, color: "diffRemovedText" }];
}

function countsMeta(added: number, removed: number): MetaPart[] {
	// A change with no known lines says nothing: never `+0`.
	const parts: MetaPart[] = [];
	if (added > 0) parts.push({ text: `+${added}`, color: "diffAddedText" });
	if (added > 0 && removed > 0) parts.push({ text: " ", color: "dim" });
	if (removed > 0) parts.push({ text: `−${removed}`, color: "diffRemovedText" });
	return parts;
}

/** Widest last output line the result column shows as it is. */
const STATUS_LINE_MAX_WIDTH = 24;

/**
 * Whether a command's last output line reads as its status (`done`, `step 8`,
 * `133 total`), not a line of data it printed: short, a few words, no markup.
 */
export function isStatusLine(line: string): boolean {
	const text = line.trim();
	if (!text || visibleWidth(text) > STATUS_LINE_MAX_WIDTH) return false;
	if (/^[[{<("'`|]/.test(text) || /[\t|]|,.*,/.test(text)) return false;
	return text.split(/\s+/).length <= 4;
}

/** A test runner's summary in plain words (`54 通过`, `2 通过 · 1 失败`), when the text is one. */
export function testSummaryText(text: string): string | undefined {
	const counts = new Map<string, number>();
	for (const match of text.matchAll(/(\d+) (passed|failed|errors?|skipped)\b/gi)) {
		const word = (match[2] ?? "").toLowerCase().replace(/s$/, "");
		counts.set(word, (counts.get(word) ?? 0) + Number(match[1]));
	}
	const words: Array<[string, string]> = [
		["passed", "通过"],
		["failed", "失败"],
		["error", "出错"],
		["skipped", "跳过"],
	];
	const parts = words.flatMap(([word, label]) => (counts.has(word) ? [`${counts.get(word)} ${label}`] : []));
	if (parts.length > 0) return parts.join(" · ");
	const unittest = /^(\d+) tests?(?:, (OK|FAILED)(?: \((.*)\))?)?/i.exec(text.trim());
	if (unittest) {
		const verdict = unittest[2]?.toUpperCase();
		if (verdict === "OK") return `${unittest[1]} 通过`;
		if (verdict === "FAILED") return `${unittest[1]} 个测试 · 有失败`;
		return `${unittest[1]} 个测试`;
	}
	return undefined;
}

/**
 * The result column of a finished command, from the kernel's summary line:
 * a test summary in plain words, else the last output line when it is short
 * and reads as a status, else `完成`; a failure says its exit code.
 */
export function commandResultText(detail: string | undefined, ok: boolean): string {
	const text = sanitizeDisplayText(detail ?? "").trim();
	const exit = /(?:^|\s·\s)exit(?: code)? (-?\d+)(?:\s·\s|$)/i.exec(text);
	const exitCode = exit ? Number(exit[1]) : undefined;
	const tests = testSummaryText(text);
	if (tests) return tests;
	if (!ok) return exitCode !== undefined ? `退出码 ${exitCode}` : "失败";
	if (exitCode === 0) return "完成";
	const localized = localizeResultDetail(text);
	if (localized !== text) return localized;
	return isStatusLine(text) ? text : "完成";
}

function lastOutputLine(text: string | undefined): string | undefined {
	return sanitizeDisplayText((text ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
}

/**
 * What a finished command cell says about its command, without a kernel
 * record: a printed `BashResult(exit_code=…, output='…')` gives the exit code
 * and the command's own last line, else the cell's last output line.
 */
export function commandOutcome(text: string | undefined): { ok: boolean; result: string } {
	const raw = text ?? "";
	const repr = /BashResult\(exit_code=(-?\d+)(?:,\s*output=(['"])((?:\\.|(?!\2)[^\\])*)\2)?/.exec(raw);
	if (!repr) return { ok: true, result: commandResultText(lastOutputLine(raw), true) };
	const exitCode = Number(repr[1]);
	const inner = (repr[3] ?? "").replace(/\\(n|t|'|"|\\)/g, (_match, escaped: string) =>
		escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped,
	);
	const last = lastOutputLine(inner);
	const tests = testSummaryText(inner.split("\n").slice(-40).join("\n"));
	if (exitCode === 0) return { ok: true, result: tests ?? commandResultText(last, true) };
	return { ok: false, result: tests ?? `退出码 ${exitCode}` };
}

function isInterrupt(error: string | undefined): boolean {
	return error !== undefined && /^(KeyboardInterrupt|已中断|Request was aborted|Operation aborted)/.test(error);
}

/** What the agent loop leaves for a tool the turn's abort caught in flight (not a per-call deadline). */
function isTurnAbortStub(error: string | undefined): boolean {
	if (error === undefined) return false;
	if (error.startsWith(ABORT_TRUNCATION_MARKER)) return true;
	return error.startsWith(TOOL_ABORT_FALLBACK_MESSAGE) && !error.startsWith(`${TOOL_ABORT_FALLBACK_MESSAGE} by `);
}

/** A row the owner's stop cut short: faint, never an error, never counted as one. */
function stoppedRow(row: BoxRow): BoxRow {
	return {
		...row,
		kind: row.kind === "error" ? "step" : row.kind,
		status: "stopped",
		glyph: "■",
		glyphColor: "dim",
		text: row.text ? `${row.text.replace(BACKGROUND_SUFFIX, "")} · 你停下了` : "你停下了",
		textColor: "muted",
		meta: [],
		persistent: false,
	};
}

/** How the kernel saw a file change, for the top of its opened diff. */
function sourceText(source: ChangeEntry["source"]): string | undefined {
	if (source === "edit") return "edit 技能改的";
	if (source === "shell") return "命令改的";
	if (source === "python") return "Python 代码改的";
	return undefined;
}

/** What stands in for a diff or a memory's texts the kernel did not keep because they looked secret. */
const SENSITIVE_TEXT = "内容没存：看起来是密钥";

/** Why a file's change has no diff to show, in plain words. */
export function omittedDiffText(reason: ChangeEntry["omitted"]): string | undefined {
	if (reason === "too_large") return "改动太大，没有显示";
	if (reason === "no_baseline") return "没法对比改前内容";
	if (reason === "budget") return "超出记录预算";
	if (reason === "sensitive") return SENSITIVE_TEXT;
	return undefined;
}

/**
 * Lines added and removed over the changes whose counts the kernel knew;
 * undefined when it knew none (every diff was left out, or every change was
 * to a link itself), so nothing says `+0`.
 */
export function changeTotals(changes: readonly ChangeEntry[]): { added: number; removed: number } | undefined {
	const known = changes.filter(
		(change) => !change.symlink && !(change.omitted && change.added === 0 && change.removed === 0),
	);
	if (known.length === 0) return undefined;
	return {
		added: known.reduce((sum, change) => sum + change.added, 0),
		removed: known.reduce((sum, change) => sum + change.removed, 0),
	};
}

/** Change entries as the diff lines an opened edit row shows. */
export function changeDetail(change: ChangeEntry): (width: number) => string[] {
	return (width) => {
		if (change.symlink) return [theme.fg("dim", "链接文件，没有文字改动可看")];
		if (change.binary) return [theme.fg("dim", "二进制文件，没有文字改动可看")];
		const omitted = omittedDiffText(change.omitted);
		if (omitted && change.rows.length === 0) return [theme.fg("dim", omitted)];
		const by = change.origin === "ambient" ? "别的窗口或进程动的，本会话只看到了前后差异" : sourceText(change.source);
		if (change.rows.length === 0) {
			return [theme.fg("dim", change.kind === "deleted" ? "文件已删除" : "没有记录到改动内容")];
		}
		const lines = clip(renderDiffRows(change.rows, { width, indent: 0 }), width);
		if (change.truncated) lines.push(theme.fg("dim", "改动太长，只记录了前面一部分"));
		return by ? [theme.fg("dim", by), ...lines] : lines;
	};
}

function changeRow(key: string, change: ChangeEntry, status: BoxRowStatus): BoxRow {
	const scratch = change.scope === "scratch";
	const renamed = change.kind === "renamed" && change.oldPath;
	const meta: MetaPart[] = [];
	if (scratch) meta.push({ text: "临时 ", color: "dim" });
	if (change.scope === "memory") meta.push({ text: "规则文件 ", color: "dim" });
	// Another window or process changed it: the row says so, as the change strip's split does.
	if (change.origin === "ambient") meta.push({ text: "工作区 ", color: "dim" });
	// The link itself changed, not its target's text: no diff, so no `+0 −0`.
	if (!change.symlink) {
		const omitted = omittedDiffText(change.omitted);
		// Counts the kernel could not know read as the reason, never as `+0 −0`.
		if (omitted && change.added === 0 && change.removed === 0) meta.push({ text: omitted, color: "dim" });
		else meta.push(...countsMeta(change.added, change.removed));
	}
	const text = renamed
		? `${change.oldPath} → ${change.path}`
		: change.symlink
			? `${symlinkVerb(change.kind)} ${change.path}`
			: change.path;
	return {
		key,
		kind: "edit",
		status,
		glyph: change.kind === "deleted" ? "✗" : "✎",
		glyphColor: change.kind === "deleted" ? "diffRemovedText" : "runCardWarn",
		text,
		textColor: scratch ? "muted" : "activityText",
		meta,
		detail: changeDetail(change),
		...(change.origin === "ambient" ? { ambient: true as const } : {}),
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

function memoryRow(key: string, change: KernelMemoryChange): BoxRow {
	const noun = memoryNoun(change);
	const title = cleanMemoryTitle(change.title);
	const renamed = change.previousTitle && change.previousTitle !== change.title;
	const meta: MetaPart[] = [];
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
		// A live record carries no texts yet (they come with the step's end): nothing to open.
		...(change.before !== undefined || change.after !== undefined || renamed || change.textOmitted
			? { detail: (width: number) => memoryBodyLines(change, width) }
			: {}),
	};
}

function activityRow(stepId: string, activity: KernelActivity): BoxRow {
	const key = `act:${stepId}:${activity.id}`;
	const label = sanitizeDisplayText(activity.label).replace(/\s+/g, " ").trim();
	const result = activity.detail ? localizeResultDetail(activity.detail) : undefined;
	const running = activity.status === "running";
	const base = {
		key,
		startedAt: activity.startedAt || undefined,
		...(activity.endedAt ? { endedAt: activity.endedAt } : {}),
	};
	switch (activity.kind) {
		case "command": {
			return {
				...base,
				kind: "cmd",
				status: running ? "running" : activity.status === "error" ? "failed" : "done",
				glyph: "$",
				glyphColor: "activityAccent",
				text: label,
				textColor: "activityText",
				meta: running
					? []
					: activity.status === "error"
						? failMeta(commandResultText(activity.detail, false))
						: okMeta(
								activity.commit
									? `提交 ${activity.commit.slice(0, 7)}`
									: commandResultText(activity.detail, true),
							),
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
				meta: running ? [] : activity.status === "error" ? failMeta(result) : okMeta(result),
			};
		}
	}
}

/** What a step's label says when the kernel reported no records for it. */
function fallbackRows(step: RowStep, data: StepFeedData, timeline: TurnTimeline, withPrimaryOutput: boolean): BoxRow[] {
	const key = `step:${step.toolCallId}`;
	// A cell still streaming in is being written, not run.
	if (step.streaming && step.status === "queued" && step.toolName === "ipython") {
		return [
			{
				key,
				kind: "step",
				status: "running",
				glyph: "✓",
				glyphColor: "diffAddedText",
				text: "写代码…",
				textColor: "muted",
				meta: [],
			},
		];
	}
	const context = { handleCommands: timeline.stepHandleContext.get(step.toolCallId) };
	const action = stepAction({ toolName: step.toolName, args: step.args }, context);
	const running = step.status === "running" || step.status === "queued";
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
		const hasLiveOutput = running && !!data.outputTail;
		const outcome = commandOutcome(output);
		const result = truncateToWidth(outcome.result, 32, "…");
		return [
			{
				key,
				kind: "cmd",
				status: running ? "running" : outcome.ok ? "done" : "failed",
				glyph: "$",
				glyphColor: "activityAccent",
				text: action.verb === "等待" ? `等待 ${target}` : target,
				textColor: "activityText",
				meta: running ? [] : outcome.ok ? okMeta(result) : failMeta(result),
				...(startedAt !== undefined ? { startedAt } : {}),
				...(outputDetail ? { detail: outputDetail } : {}),
				...(outputDetail || hasLiveOutput ? {} : { outputNote: running ? "还没有输出" : "没有输出" }),
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
			meta: running ? [] : okMeta(action.verb === "查看子代理" ? handedBack(timeline) : undefined),
			...(startedAt !== undefined ? { startedAt } : {}),
			...(outputDetail ? { detail: outputDetail } : {}),
		},
	];
}

/** What an opened command with no output of its own says: it printed nothing (yet). */
function withOutputNote(row: BoxRow): BoxRow {
	if (row.kind !== "cmd") return row;
	return { ...row, outputNote: row.status === "running" ? "还没有输出" : "没有输出" };
}

/** `2 个已交回`: the turn's subagents that finished, for a step that checked on them. */
function handedBack(timeline: TurnTimeline): string | undefined {
	const done = timeline.entries.filter((entry) => entry.kind === "subagent" && entry.sub.status === "done").length;
	return done > 0 ? `${done} 个已交回` : undefined;
}

/** The subagent a step row of the kernel's `subagent` record names. */
function subagentRowName(row: BoxRow): string {
	return row.text.replace(/^子代理 /, "");
}

/** The step a cell that only started subagents is: it names them and opens to the code line and what the cell printed. */
function dispatchStepRow(step: RowStep, dispatched: readonly BoxRow[], output: string | undefined): BoxRow {
	const names = dispatched.map((row) => shortAgentName(subagentRowName(row)));
	const running = step.status === "running" || step.status === "queued";
	const code = argumentCode(step.args);
	return {
		key: `step:${step.toolCallId}`,
		kind: "step",
		status: running ? "running" : "done",
		glyph: "✓",
		glyphColor: "diffAddedText",
		text: `派出子代理 ${names.join("、")}`,
		textColor: "activityText",
		meta: running ? [] : okMeta(undefined),
		...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
		...(code || output?.trim()
			? {
					detail: (width: number) => [
						...(code
							? [
									theme.fg(
										"dim",
										truncateToWidth(`代码  ${previewIpythonCode(code).text}`, Math.max(4, width), "…"),
									),
								]
							: []),
						...(output?.trim() ? preformatted(output, width) : []),
					],
				}
			: {}),
	};
}

/** The source of an ipython cell, when the step carries it. */
function argumentCode(args: unknown): string | undefined {
	const code = typeof args === "object" && args !== null ? (args as { code?: unknown }).code : undefined;
	return typeof code === "string" && code.trim() ? code : undefined;
}

function errorRow(step: RowStep, data: StepFeedData, timeline: TurnTimeline): BoxRow {
	const context = { handleCommands: timeline.stepHandleContext.get(step.toolCallId) };
	const action = stepAction({ toolName: step.toolName, args: step.args }, context);
	const what = action.recognized ? `${action.verb} ${action.target}`.trim() : action.target || "Python";
	const error = sanitizeDisplayText(data.error ?? "出错了");
	// A tail that is just the error's own line (the whole output was that one line)
	// says nothing the row itself does not; keeping it would draw the same sentence
	// twice once the row opens. The row then falls back to its facts, which say no
	// more. A longer tail keeps every line, the error's own line included.
	const tail = data.errorDetail ?? [];
	const detail = tail.length === 1 && tail[0]?.trim() === error ? [] : tail;
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

const BACKGROUND_SUFFIX = " · 转到后台继续跑";

/** A background command's outcome: it finished after its cell, said on its own row. */
function finishedInBackground(row: BoxRow, activity: KernelActivity): BoxRow {
	return { ...row, text: `${row.text} · ${activity.status === "ok" ? "后台跑完了" : "后台出错了"}` };
}

/** A step that went on after its cell (or its turn) ended: said once, no spinner, no clock. */
function backgroundRow(row: BoxRow): BoxRow {
	const { startedAt: _startedAt, ...rest } = row;
	return { ...rest, status: "plain", text: `${row.text}${BACKGROUND_SUFFIX}`, textColor: "muted", meta: [] };
}

function stepRows(step: RowStep, timeline: TurnTimeline, ctx: RowBuildContext, order: number): BoxRow[] {
	const data = timeline.stepData.get(step.toolCallId) ?? { activities: [], memoryChanges: [], legacyDiffs: [] };
	const items: TimedRows[] = [];
	let index = 0;
	const running = step.status === "running" || step.status === "queued";
	for (const activity of [...data.activities].sort((a, b) => a.startedAt - b.startedAt)) {
		const unfinished = activity.status === "running";
		const settled = ctx.settledActivities?.get(activity.id);
		if (unfinished && settled !== undefined && settled.stepId !== step.toolCallId) {
			// It finished in the background while a later step ran: its own row settles in place.
			const row = activityRow(step.toolCallId, settled.activity);
			items.push({ time: activity.startedAt, order: index++, rows: [finishedInBackground(row, settled.activity)] });
			continue;
		}
		if (!unfinished && activity.background === true) {
			// The step that started it already shows its outcome.
			const origin = ctx.activityOrigins?.get(activity.id);
			if (origin !== undefined && origin !== step.toolCallId) continue;
			const row = activityRow(step.toolCallId, activity);
			items.push({ time: activity.startedAt, order: index++, rows: [finishedInBackground(row, activity)] });
			continue;
		}
		const row = activityRow(step.toolCallId, activity);
		// Still running although the cell (or the turn) is over: it runs on in the background.
		const background = unfinished && (activity.background === true || !running || !ctx.live);
		const printedNothing = !data.outputText?.trim() && !activity.detail?.trim();
		items.push({
			time: activity.startedAt,
			order: index++,
			rows: [background ? backgroundRow(row) : printedNothing ? withOutputNote(row) : row],
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
	// A cell that raised is a failure even when the tool itself reported success.
	const failed = step.status === "error" || (step.status === "done" && data.error !== undefined);
	// The owner's stop cut the cell short: that is a stop, not an error.
	const interrupted =
		failed &&
		(data.stopped === true ||
			isInterrupt(data.error) ||
			(ctx.stopped && (data.error === undefined || isTurnAbortStub(data.error))));
	if (items.length === 0) {
		if (interrupted) return fallbackRows({ ...step, status: "done" }, data, timeline, true).map(stoppedRow);
		if (failed) return [errorRow(step, data, timeline)];
		return fallbackRows(step, data, timeline, true);
	}
	items.sort((a, b) => a.time - b.time || a.order - b.order);
	const rows = items.flatMap((item) => item.rows);
	if (data.activitiesDropped !== undefined && data.activitiesDropped > 0) {
		// The kernel keeps a cell's most recent steps; say how many earlier ones it no longer lists.
		rows.unshift({
			key: `step:${step.toolCallId}:dropped`,
			kind: "step",
			status: "plain",
			glyph: "…",
			glyphColor: "dim",
			text: `更早的 ${data.activitiesDropped} 步没列出`,
			textColor: "dim",
			meta: [],
		});
	}
	// The last command of a cell carries the cell's output when opened.
	const lastCommand = [...rows].reverse().find((row) => row.kind === "cmd");
	if (lastCommand && !running && data.outputText?.trim()) {
		const output = data.outputText;
		lastCommand.detail = (width) => preformatted(output, width);
	}
	if (running && !data.activities.some((activity) => activity.status === "running" && activity.background !== true)) {
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
		});
	} else if (interrupted) {
		// The steps it reported that did not finish were cut short with it.
		return rows.map((row) =>
			row.status === "running" || row.status === "failed" || row.text.endsWith(BACKGROUND_SUFFIX)
				? stoppedRow(row)
				: row,
		);
	} else if (failed) {
		rows.push(errorRow(step, data, timeline));
	}
	return rows;
}

/** Whether the full text says more than its one-line summary (a closing full stop does not count). */
function saysMoreThan(text: string, summary: string): boolean {
	const flat = sanitizeDisplayText(text.replace(/\s+/g, " ").trim()).replace(/[。！？!?；;.]+$/, "");
	return flat !== summary;
}

/** A row shows one line: the sentence it summarizes is looked for in the first characters only. */
const SUMMARY_INPUT_MAX_CHARS = 400;

function thinkRows(
	timeline: TurnTimeline,
	entry: Extract<TimelineEntry, { kind: "message" }>,
	ctx: RowBuildContext,
	superseded = false,
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
					...(text ? { detail: (width: number) => wrapped(text, width, "thinkingText") } : {}),
				});
				return;
			}
			const duration =
				timing?.endedAt !== undefined
					? formatBoxDuration(Math.max(1000, timing.endedAt - timing.startedAt))
					: undefined;
			const tokens = formatBoxTokens(timeline.thinkingTokens(key, raw));
			const summary = text ? firstSentence(sliceGraphemes(text, SUMMARY_INPUT_MAX_CHARS)) : "";
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
				...(text && saysMoreThan(text, summary)
					? { detail: (width: number) => wrapped(text, width, "thinkingText") }
					: {}),
			});
		} else if (block.type === "text" && (superseded || (firstToolCall !== -1 && index < firstToolCall))) {
			const text = (block.text ?? "").trim();
			if (!text) return;
			rows.push({
				key: `say:${entry.key}:${index}`,
				kind: "say",
				status: "plain",
				glyph: "·",
				glyphColor: "dim",
				text: firstSentence(sliceGraphemes(text, SUMMARY_INPUT_MAX_CHARS)),
				textColor: "muted",
				meta: [],
				fullText: text,
				detail: (width: number) => wrapped(text, width, "muted"),
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
		case "steer":
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
				fullText: `你插话：${entry.text}`,
				detail: (width: number) => wrapped(entry.text, width, "activityText"),
			};
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
				startedAt: retry.startedAt,
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
			const skipped = compaction.skipped === true;
			// What the owner cancelled is what they asked for: it reads as a step, never as a failure.
			const failedForReal = compaction.failed !== undefined && !skipped && compaction.cancelled !== true;
			const text = running
				? "上下文快满了，正在整理前面的内容…"
				: skipped
					? `暂不整理：${sanitizeDisplayText(compaction.failed ?? "稍后再试")}`
					: compaction.cancelled === true
						? "已取消，未整理"
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
				glyphColor: failedForReal ? "runCardWarn" : "dim",
				text,
				textColor: failedForReal ? "runCardWarn" : "muted",
				meta: [],
				startedAt: compaction.startedAt,
				...(compaction.endedAt ? { endedAt: compaction.endedAt } : {}),
				// A compaction that did not happen stays on the timeline as a line of its own, as a failed retry does.
				...(failedForReal && !running ? { persistent: true } : {}),
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
				...(sub.endedAt ? { endedAt: sub.endedAt } : {}),
				...(report?.trim() ? { detail: (width: number) => wrapped(report, width, "muted") } : {}),
			};
		}
		case "notice": {
			const notice = entry.notice;
			const color: ThemeColor = notice.tone === "error" ? "error" : notice.tone === "warn" ? "runCardWarn" : "muted";
			return {
				key: entry.key,
				kind: "notice",
				status: notice.tone === "error" ? "failed" : "plain",
				glyph: notice.tone === "error" ? "✗" : "◇",
				glyphColor: notice.tone === "muted" ? "dim" : color,
				text: notice.text,
				textColor: color,
				meta: [],
				...(entry.at > 0 ? { startedAt: entry.at } : {}),
				...(notice.tone === "error" ? { persistent: true } : {}),
				...(notice.detail ? { detail: (width: number) => wrapped(notice.detail ?? "", width, "muted") } : {}),
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
		if (
			row.kind === "read" &&
			row.status !== "failed" &&
			last?.kind === "read" &&
			last.status !== "failed" &&
			last.groupKey === row.groupKey
		) {
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

/** `14:13:22` in the reader's own time zone. */
function clockText(ms: number): string {
	return new Date(ms).toTimeString().slice(0, 8);
}

/**
 * What a block with no lines of its own opens to: the step's whole text (the row
 * cuts it), what its right side says, when it happened and how long it took, and
 * whether the command printed anything. Only what the row already knows.
 */
function factsDetail(row: BoxRow, now: number): (width: number) => string[] {
	const gap = row.text && row.keyword && !row.keyword.endsWith("：") ? " " : "";
	const whole = sanitizeDisplayText(`${row.keyword ?? ""}${gap}${row.text}`)
		.replace(/\s+/g, " ")
		.trim();
	const started = row.startedAt !== undefined && row.startedAt > 0 ? row.startedAt : undefined;
	const took =
		started === undefined
			? undefined
			: row.endedAt !== undefined && row.endedAt >= started
				? `用了 ${row.endedAt - started < 1000 ? "不到 1秒" : formatBoxDuration(row.endedAt - started)}`
				: row.status === "running"
					? `已跑 ${formatBoxDuration(Math.max(0, now - started))}`
					: undefined;
	return (width) => {
		const lines = whole ? wrapped(whole, width, "activityText") : [];
		if (row.meta.length > 0) {
			lines.push(`${theme.fg("dim", "结果  ")}${row.meta.map((part) => theme.fg(part.color, part.text)).join("")}`);
		}
		if (started !== undefined) {
			lines.push(theme.fg("dim", `时间  ${clockText(started)}${took ? ` · ${took}` : ""}`));
		}
		if (row.outputNote) lines.push(theme.fg("dim", row.outputNote));
		return lines.length > 0 ? lines : [theme.fg("dim", "没有更多内容")];
	};
}

/**
 * The turn is over and went fine: not running, not stopped by the owner, not
 * ended on an error, and the AI itself closed it with an answer (its last reply
 * ended normally). Whatever went wrong on the way it corrected itself. A turn
 * cut off after a step (an abort after a tool batch, a budget stop, a crash) or
 * ended on a truncated reply corrected nothing.
 */
function endedWell(timeline: TurnTimeline, ctx: RowBuildContext): boolean {
	if (ctx.live || ctx.stopped || timeline.stopped || timeline.errorEnded) return false;
	for (let index = timeline.entries.length - 1; index >= 0; index--) {
		const entry = timeline.entries[index];
		if (entry?.kind === "message") return entry.message.stopReason === "stop";
	}
	return false;
}

/** What the timeline lists, in order, before the rows are grouped under their events. */
type TimelineItem =
	| {
			type: "event";
			key: string;
			at: number;
			lead: string[];
			spawned: SpawnedSubagent[];
	  }
	| { type: "steer"; key: string; at: number; text: string }
	| { type: "fail"; key: string; at: number };

/** Whether an event's whole text says more than its line: more paragraphs, or a line cut short. */
export function eventSaysMore(event: TimelineEvent): boolean {
	return event.more === true;
}

/** A tag several siblings share tells none of them apart: it stays off all of them, as on the subagent blocks. */
function distinctTags(spawned: SpawnedSubagent[]): SpawnedSubagent[] {
	const counts = new Map<string, number>();
	for (const sub of spawned) if (sub.tag) counts.set(sub.tag, (counts.get(sub.tag) ?? 0) + 1);
	return spawned.map((sub) => {
		if (!sub.tag || (counts.get(sub.tag) ?? 0) < 2) return sub;
		const { tag: _shared, ...untagged } = sub;
		return untagged;
	});
}

/** Most characters an event's line keeps: past any terminal's width, and cheap to cut and paint. */
const EVENT_TEXT_MAX_CHARS = 400;

/** The first paragraph of a text on one line, and whether the text has more than that. */
function firstParagraph(text: string): { line: string; more: boolean } {
	const boundary = /\n\s*\n/.exec(text);
	const paragraph = boundary ? text.slice(0, boundary.index) : text;
	const rest = boundary ? text.slice(boundary.index + boundary[0].length) : "";
	const kept = sliceGraphemes(paragraph, EVENT_TEXT_MAX_CHARS * 2);
	// Collapse first, then cut: the `more` flag compares against the collapsed
	// paragraph, so a run of spaces alone never claims the line left words out.
	const normalized = sanitizeDisplayText(kept).replace(/\s+/g, " ").trim();
	const line = sliceGraphemes(normalized, EVENT_TEXT_MAX_CHARS);
	return { line, more: rest.trim().length > 0 || paragraph.length > kept.length || line.length < normalized.length };
}

/** What an event says when the AI said nothing: its steps in a few words. */
function stepsSummary(steps: readonly BoxRow[], spawned: number): string {
	const count = (kind: BoxRowKind) => steps.filter((row) => row.kind === kind).length;
	const reads = steps.reduce((sum, row) => sum + (row.kind === "read" ? (row.files?.length ?? 1) : 0), 0);
	const parts: string[] = [];
	if (count("think") > 0) parts.push(`想了 ${count("think")} 次`);
	if (count("cmd") > 0) parts.push(`跑了 ${count("cmd")} 条命令`);
	if (reads > 0) parts.push(`读了 ${reads} 个文件`);
	// Ambient rows (another window or process changed the file) render in the box
	// but are not this session's work - the title must not count them.
	const ownEdits = steps.filter((row) => row.kind === "edit" && !row.ambient).length;
	if (ownEdits > 0) parts.push(`改了 ${ownEdits} 个文件`);
	if (count("memory") > 0) parts.push(`记住 ${count("memory")} 条`);
	if (spawned > 0) parts.push(`派了 ${spawned} 个子代理`);
	if (parts.length === 0) parts.push(`做了 ${steps.length} 步`);
	return parts.join(" · ");
}

/** `provider/model` of the reply that retried a failed one, when another model served it; undefined when the same one did or a message names none. */
function servingModelSwitch(
	failed: { provider?: string; model?: string },
	retry: { provider?: string; model?: string },
): string | undefined {
	if (!failed.model || !retry.model) return undefined;
	if (failed.model === retry.model && failed.provider === retry.provider) return undefined;
	return retry.provider ? `${retry.provider}/${retry.model}` : retry.model;
}

/** The retry settings a replayed retry row's reason is derived with. */
export interface ReplayRetryPolicy {
	/** `retry.provider.maxRetries ?? retry.maxRetries`: the quick-retry ladder's length. */
	maxRetries: number;
	/** `retry.provider.maxRetryDelayMs`: a server-requested wait beyond it leaves the ladder (0 disables the cap). */
	maxRetryDelayMs: number;
	/** `retry.provider.waitForUsage.enabled`: the bounded wait-for-recovery channel's switch. */
	waitForRecovery: boolean;
}

const DEFAULT_REPLAY_RETRY_POLICY: ReplayRetryPolicy = {
	maxRetries: DEFAULT_PROVIDER_RETRY_POLICY.maxRetries,
	maxRetryDelayMs: DEFAULT_PROVIDER_RETRY_POLICY.maxRetryDelayMs,
	waitForRecovery: DEFAULT_PROVIDER_WAIT_POLICY.enabled,
};

/** The current settings' retry policy, or the defaults when they cannot be read. */
function readReplayRetryPolicy(cwd: string): ReplayRetryPolicy {
	try {
		const settings = SettingsManager.create(cwd);
		const retry = providerRetryPolicy(settings);
		return {
			maxRetries: retry.maxRetries,
			maxRetryDelayMs: retry.maxRetryDelayMs,
			waitForRecovery: settings.getProviderWaitSettings().enabled,
		};
	} catch {
		return DEFAULT_REPLAY_RETRY_POLICY;
	}
}

/**
 * The reason a replayed retry row shows, re-derived from the failed message the
 * transcript kept. A live row reads the session's `auto_retry_start` event, which
 * a transcript does not persist; the failed message's diagnostics do persist, so
 * the wait routing of `_handleRetryableError` is replayed here:
 *
 * - a retry another model served is the backup/fallback branch, which runs before
 *   any wait (the live row says the switch);
 * - a quota-class failure enters the usage wait on its first failure, so every
 *   retried quota failure reads `usage`;
 * - a transient-class failure joins the unavailability wait once the quick ladder
 *   is spent (`attempt` past `maxRetries`) or the server-requested wait outgrows
 *   `maxRetryDelayMs`; before that the live row is a quick retry that reads the
 *   error text, so the replay does the same.
 *
 * Accepted approximations: the policy read is the *current* settings, not the
 * settings at the time; the attempt count is the run of consecutive failures on
 * the serving model (a clean reply resets the live ladder, a fallback switch
 * restarts it, a user-configured backup switch keeps it counting - one step of
 * drift at the ladder's edge); a quota park ends the turn instead of showing a
 * retry. A failure without diagnostics classifies as permanent and keeps the
 * error-text reason, as it did live.
 */
export function replayRetryReason(
	failed: AssistantMessage,
	backupModel: string | undefined,
	attempt: number,
	policy: ReplayRetryPolicy,
): { errorMessage: string; reason?: "usage" | "unavailable" | "backup"; backupModel?: string } {
	const errorMessage = failed.errorMessage ?? "";
	if (backupModel !== undefined) {
		return { errorMessage, reason: "backup", backupModel };
	}
	const waitClass = providerWaitClass(
		providerStreamFailureKind(failed),
		providerStreamFailureStatus(failed),
		errorMessage,
	);
	if (policy.waitForRecovery && waitClass === "quota") {
		return { errorMessage, reason: "usage" };
	}
	if (policy.waitForRecovery && waitClass === "transient") {
		const retryAfterMs = providerStreamFailureRetryAfterMs(failed);
		const exceedsCap =
			retryAfterMs !== undefined && policy.maxRetryDelayMs > 0 && retryAfterMs > policy.maxRetryDelayMs;
		if (exceedsCap || attempt > policy.maxRetries) {
			return { errorMessage, reason: "unavailable" };
		}
	}
	return { errorMessage };
}

/** The entry comes after the reply that answered the turn, and no reply follows it. */
function afterFinalAnswer(timeline: TurnTimeline, index: number): boolean {
	for (let before = index - 1; before >= 0; before--) {
		const earlier = timeline.entries[before];
		if (earlier?.kind !== "message") continue;
		if (!earlier.ended || earlier.message.stopReason !== "stop") return false;
		return !timeline.entries.slice(index + 1).some((later) => later.kind === "message");
	}
	return false;
}

/** Every row of a turn, in order. */
export function buildTimelineRows(timeline: TurnTimeline, baseCtx: RowBuildContext): BoxRow[] {
	return buildTimelineView(timeline, baseCtx).rows;
}

/** Every row of a turn, and the events the timeline draws them under. */
export function buildTimelineView(
	timeline: TurnTimeline,
	baseCtx: RowBuildContext,
): { rows: BoxRow[]; events: TimelineEvent[] } {
	const settledActivities = new Map<string, { stepId: string; activity: KernelActivity }>();
	const activityOrigins = new Map<string, string>();
	for (const step of baseCtx.steps.values()) {
		for (const activity of timeline.stepData.get(step.toolCallId)?.activities ?? []) {
			if (activity.status === "running") {
				if (!activityOrigins.has(activity.id)) activityOrigins.set(activity.id, step.toolCallId);
			} else {
				settledActivities.set(activity.id, { stepId: step.toolCallId, activity });
			}
		}
	}
	const ctx: RowBuildContext = { ...baseCtx, settledActivities, activityOrigins };
	const rows: BoxRow[] = [];
	const items: TimelineItem[] = [];
	type EventItem = Extract<TimelineItem, { type: "event" }>;
	let current: EventItem | undefined;
	// A turn that went fine corrected its mistakes itself: only one that did not end well shows its failure as a line.
	const recovered = endedWell(timeline, ctx);
	const openEvent = (key: string, at: number, lead: string[] = []): EventItem => {
		const item: EventItem = { type: "event", key, at, lead, spawned: [] };
		items.push(item);
		current = item;
		return item;
	};
	const place = (row: BoxRow, entryKey: string, at: number): void => {
		// A failure is a line of its own unless the turn recovered from it; a compaction that failed never recovers.
		if (row.persistent && (row.kind === "compact" || (!recovered && !ctx.live))) {
			const key = `ev:${row.key}`;
			items.push({ type: "fail", key, at });
			current = undefined;
			rows.push({ ...row, groupKey: key });
			return;
		}
		const group = current ?? openEvent(`ev:${entryKey}:auto`, at);
		rows.push({ ...row, groupKey: group.key });
	};
	const dispatchedNames = new Set<string>();
	const snapshotNames = new Set(
		timeline.entries.flatMap((entry) => (entry.kind === "subagent" ? [entry.sub.name] : [])),
	);
	let order = 0;
	// A failed model call that a retry followed is said by the retry row.
	let lastRetryIndex = -1;
	timeline.entries.forEach((entry, index) => {
		if (entry.kind === "retry") lastRetryIndex = index;
	});
	// The run of consecutive failed model calls one retry ladder climbed, per
	// serving model: a clean reply resets the ladder live, and a switch to
	// another model starts a new one. The replayed retry reason reads it as the
	// attempt number (see replayRetryReason).
	let failureRun = 0;
	let failureRunServedBy = "";
	// Read once per build, and only when a replayed retry row needs it.
	let retryPolicy: ReplayRetryPolicy | undefined;
	const replayPolicy = (): ReplayRetryPolicy => {
		retryPolicy ??= ctx.retryPolicy ?? readReplayRetryPolicy(ctx.cwd);
		return retryPolicy;
	};
	const seenSteps = new Set<string>();
	const laterWork: boolean[] = [];
	let workAfter = false;
	for (let index = timeline.entries.length - 1; index >= 0; index--) {
		laterWork[index] = workAfter;
		const entry = timeline.entries[index];
		if (entry?.kind === "message" && replyHasWork(entry.message)) workAfter = true;
	}
	timeline.entries.forEach((entry, entryIndex) => {
		if (entry.kind !== "message") {
			const row = eventRow(entry, ctx);
			if (entry.kind === "subagent") {
				if (row) rows.push(row);
				const group = current ?? openEvent(`ev:${entry.key}:auto`, entry.sub.startedAt);
				const tag = subagentTaskTag(entry.sub.label ?? "", entry.sub.name);
				group.spawned.push({
					name: entry.sub.name,
					laneName: entry.sub.laneName ?? entry.sub.name,
					...(tag ? { tag } : {}),
					running: entry.sub.status === "running" && !ctx.stopped,
					startedAt: entry.sub.startedAt,
					...(entry.sub.endedAt !== undefined ? { endedAt: entry.sub.endedAt } : {}),
				});
			} else if (entry.kind === "steer") {
				const key = `ev:${entry.key}`;
				items.push({ type: "steer", key, at: entry.at, text: entry.text });
				current = undefined;
				if (row) rows.push({ ...row, groupKey: key });
			} else if (row) {
				const at =
					entry.kind === "retry"
						? entry.retry.startedAt
						: entry.kind === "compact"
							? entry.compaction.startedAt
							: entry.at;
				if (entry.kind === "compact" && afterFinalAnswer(timeline, entryIndex)) {
					// A compaction after the last answer belongs to no event, and the answer is drawn above the
					// closing part of the turn, not among the events: that part says it, in time order.
					current = undefined;
					rows.push({ ...row, trailing: true });
				} else {
					place(row, entry.key, at);
				}
			}
			return;
		}
		const content = entry.message.content ?? [];
		const at = entry.message.timestamp ?? 0;
		// An answer a later reply of the turn took over lives on as rows here.
		const superseded = entry.ended && isPlainAnswer(entry.message) && laterWork[entryIndex] === true;
		const thinking = thinkRows(timeline, entry, ctx, superseded);
		// Words the AI wrote before its calls (or an answer taken over) are the line its steps hang under.
		const said = thinking.filter((row) => row.kind === "say");
		if (said.length > 0)
			openEvent(
				`ev:${entry.key}`,
				at,
				said.map((row) => row.fullText ?? row.text),
			);
		let thinkingIndex = 0;
		content.forEach((block, index) => {
			if (block.type === "thinking" || block.type === "text") {
				const rowKeyPrefix = block.type === "thinking" ? "think:" : "say:";
				const row = thinking[thinkingIndex];
				if (row && row.key === `${rowKeyPrefix}${entry.key}:${index}`) {
					place(row, entry.key, at);
					thinkingIndex++;
				}
				return;
			}
			if (block.type !== "toolCall") return;
			seenSteps.add(block.id);
			const known = ctx.steps.get(block.id);
			const step: RowStep = known
				? { ...known, ...(entry.ended ? {} : { streaming: true }) }
				: {
						toolCallId: block.id,
						toolName: block.name,
						args: block.arguments,
						status: entry.ended ? "done" : "queued",
						...(entry.ended ? {} : { streaming: true }),
					};
			const cellRows = stepRows(step, timeline, ctx, order++);
			// A subagent the session reported live already has its own row.
			const dispatched = cellRows.filter(
				(row) => row.kind === "subagent" && snapshotNames.has(subagentRowName(row)),
			);
			for (const row of cellRows) if (!dispatched.includes(row)) place(row, entry.key, at);
			// A cell that only dispatched subagents is still a step of its event; one that only mentions
			// subagents an earlier cell dispatched has nothing of its own to list.
			const fresh = dispatched.filter((row) => !dispatchedNames.has(subagentRowName(row)));
			for (const row of dispatched) dispatchedNames.add(subagentRowName(row));
			if (fresh.length > 0 && dispatched.length === cellRows.length) {
				place(dispatchStepRow(step, fresh, timeline.stepData.get(step.toolCallId)?.outputText), entry.key, at);
			}
		});
		const message = entry.message;
		if (entry.ended) {
			if (message.stopReason === "error") {
				const servedBy = `${message.provider}/${message.model}`;
				if (servedBy === failureRunServedBy) failureRun += 1;
				else {
					failureRun = 1;
					failureRunServedBy = servedBy;
				}
			} else {
				failureRun = 0;
				failureRunServedBy = "";
			}
		}
		if (entry.ended && message.stopReason === "error" && message.errorMessage && lastRetryIndex < entryIndex) {
			// A later reply of the turn is the retry the session made: said as the retry row it is live, not as a model error.
			const retryReply = timeline.entries.slice(entryIndex + 1).find((later) => later.kind === "message");
			const retried = retryReply !== undefined;
			// The transcript keeps no retry event, but a retry served by another model says it switched.
			const backup = retryReply?.kind === "message" ? servingModelSwitch(message, retryReply.message) : undefined;
			const retryRow = retried
				? eventRow(
						{
							seq: 0,
							kind: "retry",
							key: `retry:${entry.key}`,
							retry: {
								startedAt: at,
								delayMs: 0,
								attempt: 1,
								reason: describeRetryReason(replayRetryReason(message, backup, failureRun, replayPolicy())),
								outcome: "ok",
							},
						},
						ctx,
					)
				: undefined;
			place(
				retryRow ?? {
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
				},
				entry.key,
				at,
			);
		}
	});
	// A step whose message the timeline never saw still gets its rows, after the rest.
	for (const step of ctx.steps.values()) {
		if (seenSteps.has(step.toolCallId)) continue;
		for (const row of stepRows(step, timeline, ctx, order++))
			place(row, `step:${step.toolCallId}`, step.startedAt ?? 0);
	}
	const merged = mergeReads(rows);
	const settled = ctx.stopped ? merged.map((row) => (row.status === "running" ? stoppedRow(row) : row)) : merged;
	// Every block opens: one with no lines of its own opens to the facts of its step. A note
	// (its whole text is on the row) is not a block and stays as it is.
	const finished = settled.map((row) => {
		const shown = recovered && row.kind === "error" && row.persistent ? { ...row, persistent: false } : row;
		return shown.detail === undefined && shown.fullText === undefined
			? { ...shown, detail: factsDetail(shown, ctx.now), factsOnly: true as const }
			: shown;
	});
	const stepsByGroup = new Map<string, BoxRow[]>();
	for (const row of finished) {
		if (row.groupKey === undefined || row.kind === "say") continue;
		const list = stepsByGroup.get(row.groupKey) ?? [];
		list.push(row);
		stepsByGroup.set(row.groupKey, list);
	}
	const events = items.flatMap((item): TimelineEvent[] => {
		if (item.type === "steer") {
			// The interjection's row carries its whole text (`fullText`/`detail`), so a long one the
			// row cut opens to all of it - the channel a failed event already uses.
			const row = stepsByGroup.get(item.key)?.[0];
			const first = firstParagraph(item.text);
			return [
				{
					key: item.key,
					kind: "steer",
					at: item.at,
					text: first.line,
					...(first.more ? { more: true as const } : {}),
					steps: [],
					spawned: [],
					...(row ? { row } : {}),
				},
			];
		}
		if (item.type === "fail") {
			const row = stepsByGroup.get(item.key)?.[0];
			if (!row) return [];
			const text = sanitizeDisplayText(`${row.keyword ?? ""}${row.text}`)
				.replace(/\s+/g, " ")
				.trim();
			return [{ key: item.key, kind: "fail", at: item.at, text, steps: [], spawned: [], row }];
		}
		const steps = stepsByGroup.get(item.key) ?? [];
		const lead = item.lead
			.map((part) => part.trim())
			.filter((part) => part.length > 0)
			.join("\n\n");
		if (!lead && steps.length === 0 && item.spawned.length === 0) return [];
		const first = lead ? firstParagraph(lead) : undefined;
		const text = first ? first.line : stepsSummary(steps, item.spawned.length);
		return [
			{
				key: item.key,
				kind: "say",
				at: item.at,
				text,
				...(lead ? { full: lead } : {}),
				...(first?.more ? { more: true as const } : {}),
				steps,
				spawned: distinctTags(item.spawned),
			},
		];
	});
	return { rows: finished, events };
}

/** The facts a finished box's header and the change strip say. */
export interface TimelineFacts {
	thinkCount: number;
	commandCount: number;
	readCount: number;
	stepCount: number;
	subagentCount: number;
	errorCount: number;
	/** Files changed inside the project by this session, one per path. */
	projectChanges: ChangeEntry[];
	/** Files changed inside the project by other windows or processes while the turn ran. */
	ambientChanges?: ChangeEntry[];
	/** Files changed outside the project (temp files). */
	scratchChanges: ChangeEntry[];
	memories: Array<{ key: string; change: KernelMemoryChange }>;
	commitId?: string;
	/** Some cell said its change lists are incomplete. */
	trackingIncomplete: boolean;
	/** No reply of the turn has text or a step: it produced nothing a reader sees. */
	noOutput?: true;
	/** The turn went fine, so its errors were mistakes it corrected itself. */
	errorsRecovered?: true;
	/** What happened after the turn's last answer (a compaction), for the closing part to say below it, in time order. */
	afterAnswer?: Array<{ key: string; at: number; text: string; failed?: true }>;
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
	let trackingIncomplete = false;
	const memories: TimelineFacts["memories"] = [];
	for (const step of steps) {
		const data = timeline.stepData.get(step.toolCallId);
		if (!data) continue;
		trackingIncomplete ||= data.trackingIncomplete === true;
		const args = step.args as { code?: unknown; command?: unknown } | undefined;
		const code = typeof args?.code === "string" ? args.code : typeof args?.command === "string" ? args.command : "";
		commitId = commitIdFromStep(data, code) ?? commitId;
		data.memoryChanges.forEach((change, index) => {
			memories.push({ key: `mem:${step.toolCallId}:${change.id ?? index}`, change });
		});
	}
	const hasOutput = timeline.entries.some((entry) => entry.kind === "message" && replyHasWork(entry.message));
	const errorCount = rows.filter((row) => row.kind === "error").length;
	const afterAnswer = rows.flatMap((row) =>
		row.trailing
			? [
					{
						key: row.key,
						at: row.startedAt ?? 0,
						text: row.text,
						...(row.persistent ? { failed: true as const } : {}),
					},
				]
			: [],
	);
	return {
		thinkCount: rows.filter((row) => row.kind === "think").length,
		commandCount: rows.filter((row) => row.kind === "cmd").length,
		readCount: rows.reduce((sum, row) => sum + (row.kind === "read" ? (row.files?.length ?? 1) : 0), 0),
		stepCount: new Set(steps.map((step) => step.toolCallId)).size + timeline.earlierSteps,
		subagentCount: rows.filter((row) => row.kind === "subagent").length,
		errorCount,
		projectChanges: changes.filter((change) => change.scope !== "scratch" && change.origin !== "ambient"),
		ambientChanges: changes.filter((change) => change.scope !== "scratch" && change.origin === "ambient"),
		scratchChanges: changes.filter((change) => change.scope === "scratch"),
		memories,
		...(commitId ? { commitId } : {}),
		trackingIncomplete,
		...(hasOutput ? {} : { noOutput: true as const }),
		...(errorCount > 0 && endedWell(timeline, ctx) ? { errorsRecovered: true as const } : {}),
		...(afterAnswer.length > 0 ? { afterAnswer } : {}),
	};
}

/** `想了 3 次 · 跑了 4 条命令 · 改了 1 个文件 +6 −2`, styled. */
export function summaryParts(facts: TimelineFacts): Array<{ text: string; color: ThemeColor }[]> {
	const parts: Array<{ text: string; color: ThemeColor }[]> = [];
	if (facts.thinkCount > 0) parts.push([{ text: `想了 ${facts.thinkCount} 次`, color: "kindThink" }]);
	if (facts.commandCount > 0) parts.push([{ text: `跑了 ${facts.commandCount} 条命令`, color: "kindCommand" }]);
	if (facts.readCount > 0 && facts.commandCount === 0) {
		parts.push([{ text: `读了 ${facts.readCount} 个文件`, color: "kindRead" }]);
	}
	if (facts.projectChanges.length > 0) {
		const totals = changeTotals(facts.projectChanges);
		parts.push([
			{ text: `改了 ${facts.projectChanges.length} 个文件${totals ? " " : ""}`, color: "kindEdit" },
			...(totals ? countsMeta(totals.added, totals.removed) : []),
		]);
	}
	if (facts.memories.length > 0) parts.push([{ text: `记住 ${facts.memories.length} 条`, color: "kindMemory" }]);
	if (facts.subagentCount > 0) parts.push([{ text: `派了 ${facts.subagentCount} 个子代理`, color: "kindSubagent" }]);
	if (parts.length === 0 && facts.stepCount > 0)
		parts.push([{ text: `做了 ${facts.stepCount} 步`, color: "kindRead" }]);
	if (facts.errorCount > 0) {
		parts.push(
			facts.errorsRecovered
				? [{ text: `出错 ${facts.errorCount} 次，已改正`, color: "kindRecovered" }]
				: [{ text: `${facts.errorCount} 处出错`, color: "kindError" }],
		);
	}
	if (parts.length === 0) parts.push([{ text: facts.noOutput ? "（这轮没有输出）" : "直接回答了", color: "muted" }]);
	if (facts.trackingIncomplete) parts.at(-1)?.push({ text: " （有些改动没记全）", color: "dim" });
	return parts;
}
