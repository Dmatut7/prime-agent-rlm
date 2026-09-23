import { previewBashCommand, previewIpythonCode } from "../../../core/tools/code-preview.js";
import { parseIpythonBashCell } from "../../../core/tools/ipython-cell-code.js";

/** What a step label needs: the tool and its (possibly still streaming) arguments. */
export interface StepLabelInput {
	toolName: string;
	args: unknown;
}

const PYTHON_FILE_VERBS: Record<string, string> = {
	read: "读取",
	write: "写入",
	delete: "删除",
	mkdir: "新建目录",
	rename: "重命名",
	replace: "移动",
	touch: "新建",
};

function argString(args: unknown, ...keys: string[]): string | undefined {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	for (const key of keys) {
		const value = (args as Record<string, unknown>)[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

const PYTHON_OPEN_PATTERN = /\bopen\(\s*[rRbBfF]?["']([^"']+)["'](?:\s*,\s*(?:mode\s*=\s*)?["']([^"']*)["'])?/g;
const PYTHON_PATH_IO_PATTERN =
	/\bPath\(\s*[rRfF]?["']([^"']+)["']\s*\)\.(read_text|read_bytes|write_text|write_bytes)\s*\(/g;
const PYTHON_VAR_IO_PATTERN =
	/(?:\b([A-Za-z_][A-Za-z0-9_]*))?\.(read_text|read_bytes|readlines|write_text|write_bytes)\s*\(/g;
const PYTHON_PATH_ASSIGN_PATTERN =
	/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:pathlib\.)?Path\(\s*[rRfF]?["']([^"']+)["']\s*\)/g;
const PYTHON_LIST_DIR_PATTERN = /\b(?:os\.listdir|os\.scandir|os\.walk|glob\.glob)\(\s*[rRfF]?["']([^"']*)["']/g;
const PYTHON_PATH_LIST_PATTERN = /\bPath\(\s*[rRfF]?["']([^"']*)["']\s*\)\.(?:iterdir|glob|rglob)\(/g;
const PYTHON_BASH_CALL_PATTERN = /\bbash\(\s*[rRfF]?("""|'''|"|')([\s\S]*?)\1/g;
const PYTHON_STRING_ASSIGN_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[rRfF]?["']([^"'\n]+)["']\s*$/gm;
const PYTHON_OPEN_VAR_PATTERN = /\bopen\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,\s*(?:mode\s*=\s*)?["']([^"']*)["'])?/g;
const PYTHON_EDIT_CALL_PATTERN =
	/\bedit(?:\.run)?\(\s*(?:path\s*=\s*)?(?:[rRfF]?["']([^"']+)["']|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Harness calls a cell makes, in plain words. */
const PYTHON_CALL_LABELS: ReadonlyArray<[RegExp, string]> = [
	[/\bawait\s+rlm\(/g, "派子代理"],
	[/\brlm\.(?:collect|list_subagents)\(/g, "查看子代理"],
	[/\bagent_message\.send\(/g, "发消息"],
	[/\battach_image(?:\.run)?\(/g, "看图"],
	[/\b(?:bailian_search|websearch|exa_websearch)\.\w+\(/g, "联网搜索"],
	[/\brlm\.harness\.(?:create|update)_memory\(/g, "记笔记"],
];

function looksLikePath(value: string): boolean {
	return /[/\\]/.test(value) || /\.[A-Za-z0-9]{1,6}$/.test(value);
}

/** Effects a single step label joins at most. */
const MAX_CELL_EFFECTS = 3;

interface PythonEffect {
	index: number;
	label: string;
}

/**
 * What a python cell does, read off common idioms, in source order: shell
 * commands run through `bash()`, file reads and writes, directory listings.
 */
function pythonEffects(code: string): string[] {
	const effects: PythonEffect[] = [];
	const push = (index: number | undefined, label: string) => effects.push({ index: index ?? 0, label });
	const stringVars = new Map<string, string>();
	for (const match of code.matchAll(PYTHON_STRING_ASSIGN_PATTERN)) {
		if (match[1] && match[2] && looksLikePath(match[2])) stringVars.set(match[1], match[2]);
	}
	const substituteVars = (text: string) =>
		text.replace(/\{([^{}]+)\}/g, (_whole, expression: string) => {
			for (const name of expression.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
				const value = stringVars.get(name);
				if (value) return pathTail(value);
			}
			return "…";
		});
	for (const match of code.matchAll(PYTHON_BASH_CALL_PATTERN)) {
		const command = previewBashCommand(substituteVars(match[2] ?? "")).text;
		if (command) push(match.index, `运行 ${command}`);
	}
	for (const match of code.matchAll(PYTHON_OPEN_VAR_PATTERN)) {
		const path = match[1] ? stringVars.get(match[1]) : undefined;
		if (!path) continue;
		push(match.index, `${/[wax+]/.test(match[2] ?? "") ? "写入" : "读取"} ${pathTail(path)}`);
	}
	for (const match of code.matchAll(PYTHON_EDIT_CALL_PATTERN)) {
		const path = match[1] ?? (match[2] ? stringVars.get(match[2]) : undefined);
		push(match.index, path ? `编辑 ${pathTail(path)}` : "编辑文件");
	}
	for (const [pattern, label] of PYTHON_CALL_LABELS) {
		for (const match of code.matchAll(pattern)) {
			push(match.index, label);
		}
	}
	for (const match of code.matchAll(PYTHON_OPEN_PATTERN)) {
		if (!match[1]) continue;
		push(match.index, `${/[wax+]/.test(match[2] ?? "") ? "写入" : "读取"} ${pathTail(match[1])}`);
	}
	const pathIoAt = new Set<number>();
	for (const match of code.matchAll(PYTHON_PATH_IO_PATTERN)) {
		if (!match[1]) continue;
		pathIoAt.add((match.index ?? 0) + match[0].lastIndexOf("."));
		push(match.index, `${match[2]?.startsWith("write") ? "写入" : "读取"} ${pathTail(match[1])}`);
	}
	const pathVars = new Map<string, string>(stringVars);
	for (const match of code.matchAll(PYTHON_PATH_ASSIGN_PATTERN)) {
		if (match[1] && match[2]) pathVars.set(match[1], match[2]);
	}
	for (const match of code.matchAll(PYTHON_VAR_IO_PATTERN)) {
		const dotAt = (match.index ?? 0) + match[0].lastIndexOf(".");
		if (pathIoAt.has(dotAt)) continue;
		const verb = match[2]?.startsWith("write") ? "写入" : "读取";
		const path = match[1] ? pathVars.get(match[1]) : undefined;
		push(match.index, path ? `${verb} ${pathTail(path)}` : `${verb}文件`);
	}
	for (const pattern of [PYTHON_LIST_DIR_PATTERN, PYTHON_PATH_LIST_PATTERN]) {
		for (const match of code.matchAll(pattern)) {
			push(match.index, `列目录 ${pathTail(match[1] || ".")}`);
		}
	}
	const labels: string[] = [];
	for (const effect of effects.sort((a, b) => a.index - b.index)) {
		if (!labels.includes(effect.label)) labels.push(effect.label);
	}
	// A named read or write makes the generic one for the same verb redundant.
	return labels.filter(
		(label) =>
			!(label === "读取文件" || label === "写入文件") ||
			!labels.some((other) => other !== label && other.startsWith(label.slice(0, 2))),
	);
}

function pathTail(path: string): string {
	const parts = path.split("/").filter((part) => part.length > 0);
	return parts[parts.length - 1] ?? path;
}

/**
 * One step in plain words for the process line: `运行 npm check`,
 * `读取 footer.ts`, `写入 footer.ts`. Python cells without a recognizable
 * effect read as `python`.
 */
export function turnStepLabel(step: StepLabelInput): string {
	if (step.toolName === "ipython") {
		const code = argString(step.args, "code");
		if (!code) {
			return "python";
		}
		const preview = previewIpythonCode(code);
		const effects = parseIpythonBashCell(code) ? [] : pythonEffects(code);
		if (effects.length > 0) {
			return effects.slice(0, MAX_CELL_EFFECTS).join("，");
		}
		if (preview.language === "bash") {
			return preview.text ? `运行 ${preview.text}` : "运行命令";
		}
		const fileOp = /^(read|write|delete|mkdir|rename|replace|touch) (\S+)$/.exec(preview.text);
		if (fileOp?.[1] && fileOp[2]) {
			return `${PYTHON_FILE_VERBS[fileOp[1]] ?? fileOp[1]} ${pathTail(fileOp[2])}`;
		}
		return "python";
	}
	const path = argString(step.args, "path", "file_path");
	switch (step.toolName) {
		case "bash": {
			const command = argString(step.args, "command");
			return command ? `运行 ${command.split("\n")[0]}` : "运行命令";
		}
		case "read":
			return path ? `读取 ${pathTail(path)}` : "读取";
		case "write":
			return path ? `写入 ${pathTail(path)}` : "写入";
		case "edit":
			return path ? `编辑 ${pathTail(path)}` : "编辑";
		case "grep":
		case "find": {
			const pattern = argString(step.args, "pattern", "query");
			return pattern ? `搜索 ${pattern}` : "搜索";
		}
		case "ls":
			return path ? `列目录 ${pathTail(path)}` : "列目录";
		default:
			return step.toolName;
	}
}

/**
 * The process line's plain-words summary: each distinct step label once, in
 * order, with a repeat count - `运行 npm check · 读取 footer.ts ×2`.
 */
export function turnStepsSummary(steps: readonly (StepLabelInput & { toolCallId: string })[]): string {
	const seen = new Set<string>();
	const counts = new Map<string, number>();
	for (const step of steps) {
		if (seen.has(step.toolCallId)) {
			continue;
		}
		seen.add(step.toolCallId);
		const label = turnStepLabel(step);
		counts.set(label, (counts.get(label) ?? 0) + 1);
	}
	return [...counts.entries()].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(" · ");
}
