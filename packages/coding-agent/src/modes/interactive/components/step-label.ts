import { previewIpythonCode } from "../../../core/tools/code-preview.js";
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

/** The label of a cell whose only effect is printing or slicing a value it already has. */
const VIEW_OUTPUT_LABEL = "查看输出";

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
	[/\battach_image(?:\.run)?\(/g, "看图"],
	[/\b(?:bailian_search|websearch|exa_websearch)\.\w+\(/g, "联网搜索"],
	[/\brlm\.harness\.(?:create|update)_memory\(/g, "记笔记"],
];

/** Calls whose label names their target: `查看子代理 X`, `发消息给 X`. */
const PYTHON_TARGETED_CALLS: ReadonlyArray<[RegExp, (target: string | undefined) => string]> = [
	[
		/\bagent_observe\.\w+\(\s*(?:[A-Za-z_]+\s*=\s*)?(?:[rRfF]?["']([^"']+)["'])?/g,
		(target) => (target ? `查看子代理 ${target}` : "查看子代理"),
	],
	[
		/\bagent_message\.send\((?:[^()]|\([^()]*\))*?receiver_name\s*=\s*[rRfF]?["']([^"']+)["']/g,
		(target) => (target ? `发消息给 ${target}` : "发消息"),
	],
];
const PYTHON_MESSAGE_SEND_PATTERN = /\bagent_message\.send\(/g;
const PYTHON_HANDLE_WAIT_PATTERN =
	/(?:^|\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?await\s+[A-Za-z_][A-Za-z0-9_]*\s*(?:$|\n)|\b[A-Za-z_][A-Za-z0-9_]*\.(?:poll|tail|output)\(/g;
const PYTHON_SLICE_PRINT_PATTERN = /\bprint\(\s*[A-Za-z_][A-Za-z0-9_.]*\s*\[[^\]]*:[^\]]*\]\s*\)/g;

function looksLikePath(value: string): boolean {
	return /[/\\]/.test(value) || /\.[A-Za-z0-9]{1,6}$/.test(value);
}

const PYTHON_SUBPROCESS_LIST_PATTERN = /\bsubprocess\.(?:run|check_output|check_call|call|Popen)\(\s*\[([^\]]*)\]/g;
const PYTHON_SUBPROCESS_STRING_PATTERN =
	/\b(?:subprocess\.(?:run|check_output|check_call|call|Popen)|os\.system)\(\s*[rRfF]?("""|'''|"|')([\s\S]*?)\1/g;

function shellWords(command: string): string[] {
	return [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/** A search pattern as a reader sees it: regex escapes and anchors dropped (`\bText\b` → `Text`). */
function searchPatternText(pattern: string): string {
	return pattern
		.replace(/\\[bB<>]/g, "")
		.replace(/\\(.)/g, "$1")
		.replace(/^\^|\$$/g, "")
		.trim();
}

/** Width budget for a command shown inside a label. */
const COMMAND_LABEL_MAX = 44;

/** Commands that only report or wait; a chain names them with the step before. */
const QUIET_COMMANDS = new Set(["echo", "printf", "true", ":", "sleep", "wait"]);

/**
 * Shorten a command to the budget at a word boundary, never inside quotes:
 * `git log --format=… --date=iso` rather than `git log --format="%H`.
 */
export function shortenCommand(command: string, max = COMMAND_LABEL_MAX): string {
	const text = command.replace(/\s+/g, " ").trim();
	if (text.length <= max) {
		return text;
	}
	const cuts: number[] = [];
	let quote: string | undefined;
	for (let index = 0; index < text.length && index <= max; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === " ") {
			cuts.push(index);
		}
	}
	const cut = cuts.at(-1);
	return cut !== undefined && cut > 0 ? `${text.slice(0, cut)} …` : `${(text.split(" ")[0] ?? text).slice(0, max)} …`;
}

function commandToolName(segment: string): string {
	const words = shellWords(segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""));
	return pathTail(words[0] ?? "");
}

/**
 * A shell command in plain words: searches, listings and file reads say what
 * they look at (`搜索 wrapTextWithAnsi`, `列目录 packages`, `读取 text.ts`);
 * anything else reads `运行 <command>`, shortened at a word boundary. A chain
 * skips its setup (`cd`, `export`); a quiet tail keeps its lead
 * (`sleep 8 → echo ok`).
 */
export function describeShellCommand(command: string): string {
	const firstLine = command
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith("#") && !/^set\s+[-+]/.test(line));
	const source = firstLine ?? command.trim();
	const segments = source
		.split(/&&|;|\|\|/)
		.map((segment) => segment.trim())
		.filter((segment) => segment && !/^(?:cd|export|source)\b/.test(segment));
	if (segments.length === 0) {
		return `运行 ${shortenCommand(source)}`;
	}
	const informative = segments.filter((segment) => !QUIET_COMMANDS.has(commandToolName(segment)));
	const main = informative[0] ?? segments.at(-1) ?? source;
	const words = shellWords(main.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""));
	const tool = pathTail(words[0] ?? "");
	const args = words.slice(1).filter((word) => !word.startsWith("-") && word !== "|");
	switch (tool) {
		case "grep":
		case "rg":
		case "ag":
		case "ack": {
			const pattern = searchPatternText(args[0] ?? "");
			return pattern ? `搜索 ${pattern}` : "搜索";
		}
		case "ls":
		case "tree":
			return `列目录 ${pathTail(args.at(-1) ?? ".")}`;
		case "find":
		case "fd":
			return `查找 ${pathTail(args[0] ?? ".")}`;
		case "cat":
		case "head":
		case "tail":
		case "less":
			if (args.length > 0) return `读取 ${pathTail(args.at(-1) ?? "")}`;
			break;
		default:
			break;
	}
	if (informative.length === 0 && segments.length > 1) {
		return `运行 ${shortenCommand(segments.map((segment) => shortenCommand(segment, 20)).join(" → "))}`;
	}
	return `运行 ${shortenCommand(main)}`;
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
		const command = substituteVars(match[2] ?? "").trim();
		if (command) push(match.index, describeShellCommand(command));
	}
	for (const match of code.matchAll(PYTHON_SUBPROCESS_LIST_PATTERN)) {
		const words = [...(match[1] ?? "").matchAll(/["']([^"']*)["']/g)].map((word) => word[1] ?? "");
		if (words.length > 0) push(match.index, describeShellCommand(words.join(" ")));
	}
	for (const match of code.matchAll(PYTHON_SUBPROCESS_STRING_PATTERN)) {
		if (match[2]) push(match.index, describeShellCommand(substituteVars(match[2])));
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
	const targetedAt = new Set<number>();
	for (const [pattern, label] of PYTHON_TARGETED_CALLS) {
		for (const match of code.matchAll(pattern)) {
			targetedAt.add(match.index ?? 0);
			push(match.index, label(match[1]));
		}
	}
	for (const match of code.matchAll(PYTHON_MESSAGE_SEND_PATTERN)) {
		if (!targetedAt.has(match.index ?? -1)) push(match.index, "发消息");
	}
	const runsCommand = PYTHON_BASH_CALL_PATTERN.test(code);
	PYTHON_BASH_CALL_PATTERN.lastIndex = 0;
	if (!runsCommand) {
		for (const match of code.matchAll(PYTHON_HANDLE_WAIT_PATTERN)) {
			push(match.index, "等待命令结果");
			break;
		}
	}
	for (const match of code.matchAll(PYTHON_SLICE_PRINT_PATTERN)) {
		push(match.index, VIEW_OUTPUT_LABEL);
		break;
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
	// A named read or write makes the generic one for the same verb redundant;
	// 查看输出 only names a cell that does nothing else.
	return labels.filter(
		(label) =>
			(!(label === "读取文件" || label === "写入文件") ||
				!labels.some((other) => other !== label && other.startsWith(label.slice(0, 2)))) &&
			(label !== VIEW_OUTPUT_LABEL || labels.length === 1),
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
/** Unresolved f-string holes read as an ellipsis, never as raw `{expr}` code. */
function withoutTemplateHoles(label: string): string {
	return label.replace(/\{[^{}]*\}/g, "…");
}

export function turnStepLabel(step: StepLabelInput): string {
	return withoutTemplateHoles(rawStepLabel(step));
}

function rawStepLabel(step: StepLabelInput): string {
	if (step.toolName === "ipython") {
		const code = argString(step.args, "code");
		if (!code) {
			return "python";
		}
		const bashCell = parseIpythonBashCell(code);
		if (bashCell) {
			return bashCell.body.trim() ? describeShellCommand(bashCell.body) : "运行命令";
		}
		const preview = previewIpythonCode(code);
		const effects = pythonEffects(code);
		if (effects.length > 0) {
			return effects.slice(0, MAX_CELL_EFFECTS).join("，");
		}
		if (preview.language === "bash") {
			return preview.text ? describeShellCommand(preview.text) : "运行命令";
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
			return command ? describeShellCommand(command.split("\n")[0] ?? command) : "运行命令";
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

/** How a verb counts several distinct objects: `读取 3 个文件`, `运行 5 条命令`. */
const GROUP_COUNT_NOUN: Record<string, string> = {
	读取: "个文件",
	写入: "个文件",
	编辑: "个文件",
	删除: "个文件",
	搜索: "处",
	查找: "处",
	列目录: "个目录",
	运行: "条命令",
};

/** A command in a summary keeps its program and subcommand: `git status`, `npm run check`. */
function shortCommand(command: string): string {
	const words = command.split("|")[0]?.trim().split(/\s+/) ?? [];
	const head = words
		.slice(0, words[0] === "npm" && words[1] === "run" ? 3 : 2)
		.filter((word) => !word.startsWith("-"));
	return head.join(" ") || command;
}

/**
 * The process line's plain-words summary, grouped by verb in first-seen
 * order: `读取 footer.ts`, `读取 footer.ts、top-bar.ts`, `读取 3 个文件`,
 * `运行 npm run check`, `运行 5 条命令`. Steps without an effect count as `python ×N`.
 */
export function turnStepsSummary(steps: readonly (StepLabelInput & { toolCallId: string })[]): string {
	const seen = new Set<string>();
	// Per verb: distinct objects (commands deduped by program + subcommand), each with its full text.
	const groups = new Map<string, { key: string; full: string }[]>();
	const bare = new Map<string, number>();
	for (const step of steps) {
		if (seen.has(step.toolCallId)) {
			continue;
		}
		seen.add(step.toolCallId);
		for (const effect of turnStepLabel(step).split("，")) {
			const space = effect.indexOf(" ");
			const verb = space === -1 ? effect : effect.slice(0, space);
			if (space === -1 || !(verb in GROUP_COUNT_NOUN)) {
				bare.set(effect, (bare.get(effect) ?? 0) + 1);
				if (!groups.has(effect)) groups.set(effect, []);
				continue;
			}
			const object = effect.slice(space + 1);
			const objects = groups.get(verb) ?? [];
			const key = verb === "运行" ? shortCommand(object) : object;
			if (!objects.some((entry) => entry.key === key)) objects.push({ key, full: object });
			groups.set(verb, objects);
		}
	}
	const parts: string[] = [];
	const hasOtherVerbs = [...groups.keys()].some((verb) => verb !== VIEW_OUTPUT_LABEL);
	for (const [verb, objects] of groups) {
		if (bare.has(verb)) {
			if (verb === VIEW_OUTPUT_LABEL && hasOtherVerbs) continue;
			const count = bare.get(verb) ?? 1;
			parts.push(count > 1 ? `${verb} ×${count}` : verb);
		} else if (objects.length === 1) {
			// A single object keeps its whole text; the line's width truncation cuts only at the end.
			parts.push(`${verb} ${objects[0]?.full}`);
		} else if (objects.length === 2 && verb !== "运行") {
			parts.push(`${verb} ${objects.map((entry) => entry.full).join("、")}`);
		} else {
			parts.push(`${verb} ${objects.length} ${GROUP_COUNT_NOUN[verb]}`);
		}
	}
	return parts.join(" · ");
}
