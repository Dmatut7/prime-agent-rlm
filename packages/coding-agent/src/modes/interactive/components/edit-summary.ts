import { isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { KernelFileChange } from "../../../core/kernel/shared.js";
import type { EditToolDetails } from "../../../core/tools/edit.js";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import type { IpythonToolDetails } from "../../../core/tools/ipython.js";
import { resolveToCwd } from "../../../core/tools/path-utils.js";
import { canonicalizePath, formatPathRelativeToCwdOrAbsolute } from "../../../utils/paths.js";
import { theme } from "../theme/theme.js";

export interface FileChangeSummary {
	path: string;
	added: number;
	removed: number;
	/** True when the change is to the link itself: no line counts apply. */
	symlink?: boolean;
	/** True when an edit of the file was withheld because its text looks secret: only the path is known. */
	omitted?: true;
	/** `ambient`: another window or process changed the file while the turn ran, not this session. */
	origin?: KernelFileChange["origin"];
}

export function countChangedLines(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function mergeFileChange(target: Map<string, FileChangeSummary>, change: FileChangeSummary, cwd: string): void {
	if (change.added === 0 && change.removed === 0 && !change.symlink && !change.omitted) return;
	const key = canonicalizePath(resolveToCwd(change.path, cwd));
	const existing = target.get(key);
	if (existing) {
		existing.added += change.added;
		existing.removed += change.removed;
		if (change.symlink) existing.symlink = true;
		if (change.omitted) existing.omitted = true;
		// Once this session itself touched the file the summary is own, whatever an earlier record said.
		if (change.origin === "own") existing.origin = "own";
		else if (change.origin !== undefined) existing.origin ??= change.origin;
	} else {
		target.set(key, { ...change });
	}
}

export function getToolFileChanges(
	toolName: string,
	args: unknown,
	result: { details?: unknown; isError: boolean },
	cwd: string,
): FileChangeSummary[] {
	const changes = new Map<string, FileChangeSummary>();
	if (toolName === "ipython") {
		const records = (result.details as { fileChanges?: unknown } | undefined)?.fileChanges;
		if (Array.isArray(records)) {
			// The kernel's own list of what the cell changed replaces the edit skill's diffs.
			for (const record of records as Array<Partial<KernelFileChange>>) {
				if (typeof record.path !== "string" || record.scope === "scratch") continue;
				mergeFileChange(
					changes,
					{
						path: record.relPath ?? record.path,
						added: Math.max(0, Number(record.added) || 0),
						removed: Math.max(0, Number(record.removed) || 0),
						...(record.symlink === true ? { symlink: true } : {}),
						...(record.origin === "ambient" || record.origin === "own" ? { origin: record.origin } : {}),
					},
					cwd,
				);
			}
			return [...changes.values()];
		}
		for (const display of (result.details as IpythonToolDetails | undefined)?.diffs ?? []) {
			// A withheld edit has neither texts nor counts to add up: the file is listed, marked.
			if (display.omitted) {
				mergeFileChange(changes, { path: display.path, added: 0, removed: 0, omitted: true }, cwd);
				continue;
			}
			const { diff } = generateDiffString(display.oldStr, display.newStr, 4, display.startLine ?? 1);
			mergeFileChange(changes, { path: display.path, ...countChangedLines(diff) }, cwd);
		}
	} else if (toolName === "edit" && !result.isError) {
		const editArgs = args as { path?: unknown; file_path?: unknown } | undefined;
		const path = typeof editArgs?.path === "string" ? editArgs.path : editArgs?.file_path;
		const diff = (result.details as EditToolDetails | undefined)?.diff;
		if (typeof path === "string" && diff) {
			mergeFileChange(changes, { path, ...countChangedLines(diff) }, cwd);
		}
	}
	return [...changes.values()];
}

export function mergeTurnFileChanges(
	target: Map<string, FileChangeSummary>,
	message: AgentMessage,
	toolResults: readonly ToolResultMessage[],
	cwd: string,
): void {
	if (message.role !== "assistant") return;
	const calls = new Map(
		message.content.filter((content) => content.type === "toolCall").map((content) => [content.id, content] as const),
	);
	for (const result of toolResults) {
		const call = calls.get(result.toolCallId);
		if (!call) continue;
		for (const change of getToolFileChanges(call.name, call.arguments, result, cwd)) {
			mergeFileChange(target, change, cwd);
		}
	}
}

/** Dim gutter that anchors every per-file change summary line. */
const FILE_CHANGE_SUMMARY_PREFIX = "    ╰─ ";
/** Indent that aligns diff rows with the summary line's text column. */
export const FILE_CHANGE_DIFF_INDENT = " ".repeat(visibleWidth(FILE_CHANGE_SUMMARY_PREFIX));

function formatChangeCounts(change: Pick<FileChangeSummary, "added" | "removed">): string {
	return `${theme.fg("toolDiffAdded", `+${change.added}`)} ${theme.fg("toolDiffRemoved", `−${change.removed}`)}`;
}

export function formatFileChangePath(path: string, cwd: string): string {
	const resolvedPath = resolveToCwd(path, cwd);
	const lexicalPath = formatPathRelativeToCwdOrAbsolute(resolvedPath, cwd);
	if (!isAbsolute(lexicalPath)) return lexicalPath;
	return formatPathRelativeToCwdOrAbsolute(canonicalizePath(resolvedPath), canonicalizePath(cwd));
}

/**
 * One `    ╰─ <path> +N -M` row, truncated to width; the path renders relative
 * to cwd where possible. U6 removed the per-row expand hint (the global tail
 * line owns the keys). A link change has no line counts: the row reads as a
 * link instead of `+0 -0`. `omitted` is the reason text of an edit whose diff
 * was not kept: it stands in for counts nobody knows, or follows those known.
 */
export function formatFileChangeSummaryLine(
	rawPath: string,
	cwd: string | undefined,
	change: Pick<FileChangeSummary, "added" | "removed" | "symlink"> & { omitted?: string },
	width: number,
): string {
	const prefix = theme.fg("dim", FILE_CHANGE_SUMMARY_PREFIX);
	const parts: string[] = [];
	if (!change.symlink && !(change.omitted && change.added === 0 && change.removed === 0)) {
		parts.push(formatChangeCounts(change));
	}
	if (change.omitted) parts.push(theme.fg("dim", change.omitted));
	const suffix = parts.length > 0 ? `${theme.fg("dim", " ")}${parts.join(theme.fg("dim", " · "))}` : "";
	const safeWidth = Math.max(1, width);
	const available = Math.max(1, safeWidth - visibleWidth(prefix) - visibleWidth(suffix));
	const displayPath = cwd === undefined ? rawPath : formatFileChangePath(rawPath, cwd);
	const pathText = change.symlink ? `链接 ${displayPath}` : displayPath;
	const path = truncateToWidth(pathText, available, "…");
	return truncateToWidth(`${prefix}${theme.fg("muted", path)}${suffix}`, safeWidth, "");
}

/** True when this session made the change; an `ambient` one is another window or process's work. */
export function isSessionOwnedChange(change: Pick<FileChangeSummary, "origin">): boolean {
	return change.origin !== "ambient";
}

export function formatTotalChangeSummary(changes: readonly FileChangeSummary[]): string {
	// The recap answers "what did this session change": ambient file movements are
	// another window's work and would inflate the counts (R2-M20).
	const own = changes.filter(isSessionOwnedChange);
	const totals = own.reduce(
		(sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }),
		{ added: 0, removed: 0 },
	);
	const files = `改动 ${own.length} 个文件`;
	const onlyWithheld = own.length > 0 && own.every((change) => change.omitted && !change.added && !change.removed);
	if (onlyWithheld) return theme.fg("muted", files);
	return `${theme.fg("muted", files)}${theme.fg("dim", " · ")}${formatChangeCounts(totals)}`;
}
