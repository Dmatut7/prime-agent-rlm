import { isAbsolute } from "node:path";
import type {
	KernelActivity,
	KernelDiffDisplay,
	KernelFileChange,
	KernelMemoryChange,
} from "../../../core/kernel/shared.js";
import {
	type DiffRow,
	diffRowsFromEdit,
	parseNumberedDiff,
	parseUnifiedDiff,
	sanitizeDisplayText,
} from "./diff-rows.js";
import { formatFileChangePath } from "./edit-summary.js";

/**
 * What the live feed and the turn's cards know about one step (tool call):
 * the display-only records its results carried. Partial results carry the
 * cumulative arrays so far; a field a result leaves out keeps what earlier
 * results said. Nothing here is ever sent to the model.
 */
export interface StepFeedData {
	activities: KernelActivity[];
	/** Present once any result carried the kernel's file-change list: it then replaces `legacyDiffs`. */
	fileChanges?: KernelFileChange[];
	memoryChanges: KernelMemoryChange[];
	/** Edit-skill diffs (`details.diffs`), the change record before the kernel reports `fileChanges`. */
	legacyDiffs: KernelDiffDisplay[];
	/** The edit tool's own numbered diff. */
	editDiff?: { path: string; diff: string };
	/** Latest non-empty output line while the step runs. */
	outputTail?: string;
	/** A slice of the final output, kept for facts like a commit id. */
	outputText?: string;
	/** One-line reason once the step failed. */
	error?: string;
	/** A few lines of the failure (traceback tail), for the expanded error row. */
	errorDetail?: string[];
	durationMs?: number;
}

export function emptyStepFeedData(): StepFeedData {
	return { activities: [], memoryChanges: [], legacyDiffs: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const ACTIVITY_KINDS = new Set<KernelActivity["kind"]>(["command", "read", "search", "fetch", "subagent"]);
const ACTIVITY_STATUSES = new Set<KernelActivity["status"]>(["running", "ok", "error"]);

function readActivity(value: unknown): KernelActivity | undefined {
	if (!isRecord(value)) return undefined;
	const id = stringField(value, "id");
	const kind = stringField(value, "kind") as KernelActivity["kind"] | undefined;
	const label = stringField(value, "label");
	const status = stringField(value, "status") as KernelActivity["status"] | undefined;
	const startedAt = numberField(value, "startedAt");
	if (!id || !kind || !ACTIVITY_KINDS.has(kind) || label === undefined || !status || !ACTIVITY_STATUSES.has(status)) {
		return undefined;
	}
	const detail = stringField(value, "detail");
	const endedAt = numberField(value, "endedAt");
	return {
		id,
		kind,
		label,
		status,
		startedAt: startedAt ?? 0,
		...(detail !== undefined ? { detail } : {}),
		...(endedAt !== undefined ? { endedAt } : {}),
	};
}

const FILE_KINDS = new Set<KernelFileChange["kind"]>(["created", "modified", "deleted", "renamed"]);
const FILE_SCOPES = new Set<KernelFileChange["scope"]>(["project", "scratch", "memory"]);
const FILE_SOURCES = new Set<KernelFileChange["source"]>(["python", "shell", "edit"]);

function readFileChange(value: unknown): KernelFileChange | undefined {
	if (!isRecord(value)) return undefined;
	const path = stringField(value, "path");
	const kind = stringField(value, "kind") as KernelFileChange["kind"] | undefined;
	const scope = stringField(value, "scope") as KernelFileChange["scope"] | undefined;
	if (!path || !kind || !FILE_KINDS.has(kind)) return undefined;
	const source = stringField(value, "source") as KernelFileChange["source"] | undefined;
	const change: KernelFileChange = {
		path,
		kind,
		scope: scope && FILE_SCOPES.has(scope) ? scope : "project",
		added: Math.max(0, numberField(value, "added") ?? 0),
		removed: Math.max(0, numberField(value, "removed") ?? 0),
		source: source && FILE_SOURCES.has(source) ? source : "python",
		at: numberField(value, "at") ?? 0,
	};
	const relPath = stringField(value, "relPath");
	const oldPath = stringField(value, "oldPath");
	const diff = stringField(value, "diff");
	if (relPath) change.relPath = relPath;
	if (oldPath) change.oldPath = oldPath;
	if (diff !== undefined) change.diff = diff;
	if (value.diffTruncated === true) change.diffTruncated = true;
	if (value.binary === true) change.binary = true;
	return change;
}

const MEMORY_OPS = new Set<KernelMemoryChange["op"]>(["created", "updated", "deleted"]);
const MEMORY_KINDS = new Set<KernelMemoryChange["kind"]>(["memory", "skill", "subagent", "prompt_note", "rules_file"]);
const MEMORY_SCOPES = new Set<KernelMemoryChange["scope"]>(["session", "global", "project"]);

function readMemoryChange(value: unknown): KernelMemoryChange | undefined {
	if (!isRecord(value)) return undefined;
	const op = stringField(value, "op") as KernelMemoryChange["op"] | undefined;
	const kind = stringField(value, "kind") as KernelMemoryChange["kind"] | undefined;
	const scope = stringField(value, "scope") as KernelMemoryChange["scope"] | undefined;
	const title = stringField(value, "title");
	if (!op || !MEMORY_OPS.has(op) || title === undefined) return undefined;
	const change: KernelMemoryChange = {
		op,
		kind: kind && MEMORY_KINDS.has(kind) ? kind : "memory",
		scope: scope && MEMORY_SCOPES.has(scope) ? scope : "session",
		title,
		at: numberField(value, "at") ?? 0,
	};
	const id = stringField(value, "id");
	const previousTitle = stringField(value, "previousTitle");
	const before = stringField(value, "before");
	const after = stringField(value, "after");
	if (id) change.id = id;
	if (previousTitle) change.previousTitle = previousTitle;
	if (before !== undefined) change.before = before;
	if (after !== undefined) change.after = after;
	return change;
}

function readDiffDisplay(value: unknown): KernelDiffDisplay | undefined {
	if (!isRecord(value)) return undefined;
	const path = stringField(value, "path");
	const oldStr = stringField(value, "oldStr");
	const newStr = stringField(value, "newStr");
	if (!path || oldStr === undefined || newStr === undefined) return undefined;
	const startLine = numberField(value, "startLine");
	return { path, oldStr, newStr, ...(startLine !== undefined ? { startLine } : {}) };
}

function readList<T>(value: unknown, read: (entry: unknown) => T | undefined): T[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((entry) => {
		const item = read(entry);
		return item === undefined ? [] : [item];
	});
}

/** The subagent a record came from, when the producer tagged it (display-only; optional in the contract). */
export function recordAgentName(record: object): string | undefined {
	const value = (record as Record<string, unknown>).agent ?? (record as Record<string, unknown>).agentName;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Merge activity records by id: first appearance keeps its place, the latest record wins. */
function mergeActivities(previous: readonly KernelActivity[], incoming: readonly KernelActivity[]): KernelActivity[] {
	const byId = new Map(previous.map((activity) => [activity.id, activity] as const));
	for (const activity of incoming) byId.set(activity.id, activity);
	return [...byId.values()];
}

function lastMeaningfulLine(text: string): string | undefined {
	const lines = sanitizeDisplayText(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
		.split(/\r?\n|\r/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return lines.at(-1);
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

const OUTPUT_KEEP_CHARS = 4000;

/**
 * Fold one tool result (partial or final) into what the feed knows about the
 * step. Pure: returns the new record, never mutates `previous`.
 */
export function mergeStepResult(
	previous: StepFeedData,
	toolName: string,
	args: unknown,
	result: { details?: unknown; content?: unknown; isError?: boolean },
	partial: boolean,
): StepFeedData {
	const next: StepFeedData = { ...previous };
	const details = isRecord(result.details) ? result.details : {};
	const activities = readList(details.activities, readActivity);
	if (activities) next.activities = mergeActivities(previous.activities, activities);
	const fileChanges = readList(details.fileChanges, readFileChange);
	if (fileChanges) next.fileChanges = fileChanges;
	const memoryChanges = readList(details.memoryChanges, readMemoryChange);
	if (memoryChanges) next.memoryChanges = memoryChanges;
	const diffs = readList(details.diffs, readDiffDisplay);
	if (diffs) next.legacyDiffs = diffs;
	if (toolName === "edit" && !result.isError) {
		const argRecord = isRecord(args) ? args : {};
		const path = stringField(argRecord, "path") ?? stringField(argRecord, "file_path");
		const diff = stringField(details, "diff");
		if (path && diff) next.editDiff = { path, diff };
	}
	const text = textOf(result.content);
	if (partial) {
		const tail = lastMeaningfulLine(text);
		if (tail && !/^(starting|正在启动)/i.test(tail) && details.status !== "starting") next.outputTail = tail;
		return next;
	}
	next.outputTail = undefined;
	const stdout = stringField(details, "stdout");
	const output = [stdout, stringField(details, "result"), text].find((value) => value && value.trim().length > 0);
	if (output) next.outputText = output.slice(-OUTPUT_KEEP_CHARS);
	const duration = numberField(details, "durationMs");
	if (duration !== undefined) next.durationMs = duration;
	if (result.isError || details.status === "error") {
		const failure = describeFailure(details, text);
		next.error = failure.summary;
		next.errorDetail = failure.detail;
	} else {
		next.error = undefined;
		next.errorDetail = undefined;
	}
	return next;
}

/** A readable one-line reason plus a short tail for the expanded error row. */
function describeFailure(details: Record<string, unknown>, text: string): { summary: string; detail: string[] } {
	const error = isRecord(details.error) ? details.error : undefined;
	const ename = error ? stringField(error, "ename") : stringField(details, "errorEname");
	const evalue = error ? (stringField(error, "evalue") ?? "") : "";
	const cleaned = sanitizeDisplayText(text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
	const lines = cleaned
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	const detail = lines.slice(-8);
	if (ename) {
		const value = sanitizeDisplayText(evalue).split("\n")[0]?.trim();
		return { summary: value ? `${ename}: ${value}` : ename, detail };
	}
	const last = lines.find((line) => /^[A-Za-z_][\w.]*(Error|Exception)\b/.test(line.trim())) ?? lines.at(-1);
	return { summary: (last ?? "出错了").trim(), detail };
}

const COMMIT_OUTPUT = /\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\]/;

/** The short id of a commit the step made, when its output says so. */
export function commitIdFromStep(data: StepFeedData, stepText: string): string | undefined {
	for (const activity of data.activities) {
		if (activity.kind !== "command" || !/\bgit\s+commit\b/.test(activity.label)) continue;
		const sha = /\b([0-9a-f]{7,40})\b/.exec(activity.detail ?? "")?.[1];
		if (sha) return sha.slice(0, 7);
	}
	if (!/\bgit\s+commit\b/.test(stepText)) return undefined;
	const sha = COMMIT_OUTPUT.exec(data.outputText ?? "")?.[1];
	return sha?.slice(0, 7);
}

/** One changed file of a turn, whatever reported it. */
export interface ChangeEntry {
	key: string;
	/** Display path: relative inside the project, absolute outside it. */
	path: string;
	kind: KernelFileChange["kind"];
	oldPath?: string;
	scope: KernelFileChange["scope"];
	added: number;
	removed: number;
	rows: DiffRow[];
	/** The kernel cut the diff at its cap. */
	truncated: boolean;
	binary: boolean;
	/** The subagent that made the change, when the record says so. */
	agent?: string;
	/** When the change was first seen (ordering). */
	firstAt: number;
}

function displayPath(change: { path: string; relPath?: string }, cwd: string): string {
	if (change.relPath) return change.relPath;
	try {
		return formatFileChangePath(change.path, cwd);
	} catch {
		return change.path;
	}
}

function mergeKind(first: KernelFileChange["kind"], next: KernelFileChange["kind"]): KernelFileChange["kind"] {
	if (next === "deleted") return first === "created" ? "deleted" : "deleted";
	if (first === "created") return "created";
	return next;
}

function addEntry(entries: Map<string, ChangeEntry>, entry: ChangeEntry): void {
	const existing = entries.get(entry.key);
	if (!existing) {
		entries.set(entry.key, entry);
		return;
	}
	existing.added += entry.added;
	existing.removed += entry.removed;
	existing.kind = mergeKind(existing.kind, entry.kind);
	if (entry.rows.length > 0) existing.rows = [...existing.rows, ...entry.rows];
	existing.truncated ||= entry.truncated;
	existing.binary ||= entry.binary;
	existing.agent ??= entry.agent;
	if (entry.oldPath) existing.oldPath ??= entry.oldPath;
}

/**
 * Every file the given steps changed, one entry per path: the kernel's
 * file-change records when a step has them, else the edit skill's diffs and
 * the edit tool's own diff.
 */
export function aggregateChanges(
	steps: Iterable<{ data: StepFeedData; toolName: string; order: number }>,
	cwd: string,
): ChangeEntry[] {
	const entries = new Map<string, ChangeEntry>();
	for (const { data, order } of steps) {
		if (data.fileChanges !== undefined) {
			for (const change of data.fileChanges) {
				const path = displayPath(change, cwd);
				const rows = change.diff ? parseUnifiedDiff(change.diff) : [];
				const agent = recordAgentName(change);
				addEntry(entries, {
					key: change.path,
					path,
					kind: change.kind,
					...(change.oldPath ? { oldPath: displayPath({ path: change.oldPath }, cwd) } : {}),
					scope: change.scope,
					added: change.added,
					removed: change.removed,
					rows,
					truncated: change.diffTruncated === true,
					binary: change.binary === true,
					...(agent ? { agent } : {}),
					firstAt: change.at || order,
				});
			}
			continue;
		}
		for (const diff of data.legacyDiffs) {
			const rows = diffRowsFromEdit(diff.oldStr, diff.newStr, diff.startLine ?? 1);
			const path = displayPath({ path: diff.path }, cwd);
			const counts = rows.reduce(
				(sum, row) => ({
					added: sum.added + (row.kind === "add" ? 1 : 0),
					removed: sum.removed + (row.kind === "del" ? 1 : 0),
				}),
				{ added: 0, removed: 0 },
			);
			if (counts.added === 0 && counts.removed === 0) continue;
			addEntry(entries, {
				key: path,
				path,
				kind: "modified",
				scope: isAbsolute(path) ? "scratch" : "project",
				...counts,
				rows,
				truncated: false,
				binary: false,
				firstAt: order,
			});
		}
		if (data.editDiff) {
			const rows = parseNumberedDiff(data.editDiff.diff);
			const path = displayPath({ path: data.editDiff.path }, cwd);
			const added = rows.filter((row) => row.kind === "add").length;
			const removed = rows.filter((row) => row.kind === "del").length;
			if (added > 0 || removed > 0) {
				addEntry(entries, {
					key: path,
					path,
					kind: "modified",
					scope: isAbsolute(path) ? "scratch" : "project",
					added,
					removed,
					rows,
					truncated: false,
					binary: false,
					firstAt: order,
				});
			}
		}
	}
	return [...entries.values()].sort((a, b) => a.firstAt - b.firstAt);
}

/** The file's family for the card's `源码 16 · 测试 13` breakdown. */
export function changeCategory(path: string): "测试" | "文档" | "脚本" | "配置" | "源码" {
	const lower = path.toLowerCase();
	const name = lower.split("/").at(-1) ?? lower;
	if (/(^|\/)(tests?|__tests__|spec|specs)\//.test(lower) || /^test_|[._-](test|spec)\.[a-z0-9]+$/.test(name)) {
		return "测试";
	}
	if (/\.(md|mdx|rst|txt|adoc)$/.test(name) || /(^|\/)docs?\//.test(lower)) return "文档";
	if (/(^|\/)(scripts?|bin)\//.test(lower) || /\.(sh|bash|zsh|ps1)$/.test(name)) return "脚本";
	if (/\.(json|ya?ml|toml|ini|cfg|conf|lock|env)$/.test(name) || name.startsWith(".")) return "配置";
	return "源码";
}

const TITLE_DATE_SUFFIX =
	/[\s_·-]*[([（]?(?:\d{4}[-_/.]?\d{2}[-_/.]?\d{2}(?:[T_ -]?\d{2}[:-]?\d{2}(?:[:-]?\d{2})?)?|\d{2}[-/.]\d{2})[)\]）]?$/;

/**
 * A memory title as a person reads it: no `snake_case` joints, no trailing
 * date stamp, no doubled separators. `a_b_c_2026-09-28` reads `a · b · c`.
 */
export function cleanMemoryTitle(title: string): string {
	let text = sanitizeDisplayText(title).trim();
	for (let pass = 0; pass < 2; pass++) text = text.replace(TITLE_DATE_SUFFIX, "").trim();
	const cjk = /[㐀-鿿]/.test(text);
	text = text.replace(/_+/g, cjk ? " · " : " ");
	text = text
		.replace(/\s*·\s*/g, " · ")
		.replace(/( · )+/g, " · ")
		.replace(/^ · | · $/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return text || sanitizeDisplayText(title).trim() || "（无标题）";
}

/** A short plain-words gloss for a result detail the kernel reports in English. */
export function localizeResultDetail(detail: string): string {
	const text = sanitizeDisplayText(detail).trim();
	const passed = /^(\d+) passed(?:,? (\d+) failed)?/i.exec(text);
	if (passed) return passed[2] ? `${passed[1]} 通过 · ${passed[2]} 失败` : `${passed[1]} 通过`;
	const failed = /^(\d+) failed/i.exec(text);
	if (failed) return `${failed[1]} 失败`;
	const exit = /^exit(?: code)? (\d+)$/i.exec(text);
	if (exit) return exit[1] === "0" ? "成功" : `退出码 ${exit[1]}`;
	const matches = /^(\d+) match(?:es)?$/i.exec(text);
	if (matches) return `${matches[1]} 处`;
	const lines = /^(\d+) lines?$/i.exec(text);
	if (lines) return `${lines[1]} 行`;
	if (/^no matches?$/i.test(text)) return "没找到";
	return text;
}
