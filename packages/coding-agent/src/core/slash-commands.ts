import { APP_NAME } from "../config.js";
import type { SourceInfo } from "./source-info.js";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export const SESSION_SLASH_COMMAND_NAMES = ["compact", "refine", "goal", "autonomous"] as const;

export type SessionSlashCommandName = (typeof SESSION_SLASH_COMMAND_NAMES)[number];

const SESSION_SLASH_COMMAND_NAME_SET: ReadonlySet<string> = new Set(SESSION_SLASH_COMMAND_NAMES);

export function isSessionSlashCommandName(value: unknown): value is SessionSlashCommandName {
	return typeof value === "string" && SESSION_SLASH_COMMAND_NAME_SET.has(value);
}

export interface SessionSlashCommand {
	name: SessionSlashCommandName;
	args: string;
	text: string;
}

export interface RefineCommandOptions {
	instructions?: string;
	rollbackId?: string;
	global?: boolean;
}

export function parseRefineCommandOptions(args: string): RefineCommandOptions {
	let rest = args.trim();
	let global = false;
	if (/^--global(?=\s|$)/.test(rest)) {
		global = true;
		rest = rest.replace(/^--global(?=\s|$)/, "").trim();
	}
	if (rest === "rollback") throw new Error("Usage: /refine rollback <refinement-id>");
	// Slash-command args keep their original separators (tabs, Unicode spaces);
	// match the subcommand with the same class parseSlashCommand splits on.
	const rollbackMatch = /^rollback[\t\p{Zs}]/u.exec(rest);
	if (rollbackMatch) {
		let rollbackId = rest.slice(rollbackMatch[0].length).trim();
		if (rollbackId === "--global") {
			throw new Error("Usage: /refine rollback <refinement-id>");
		}
		if (/\s--global$/.test(rollbackId)) {
			global = true;
			rollbackId = rollbackId.replace(/\s--global$/, "").trim();
		}
		if (!rollbackId) throw new Error("Usage: /refine rollback <refinement-id>");
		return { rollbackId, global };
	}
	return { instructions: rest || undefined, global };
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	execution?: "client" | "session";
	/** Shown in autocomplete before the description, e.g. "[instructions]" */
	argumentHint?: string;
	/** Hidden names that resolve to this command without being shown as commands. */
	aliases?: readonly string[];
	takesArgument?: boolean;
}

export interface ParsedSlashCommand {
	name: string;
	args: string;
}

export interface ResolvedSlashCommand extends ParsedSlashCommand {
	originalName: string;
	isAlias: boolean;
}

interface BuiltinSlashCommandAlias {
	name: string;
	aliasFor: string;
}

const CANONICAL_BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "打开设置菜单" },
	{ name: "model", description: "选择模型", argumentHint: "[search]", takesArgument: true },
	{ name: "effort", description: "选择 Thinking 强度", argumentHint: "[level]" },
	{ name: "fast", description: "开关 OpenAI Fast 模式" },
	{ name: "scoped-models", description: "设置 Alt+M 轮换的模型" },
	{
		name: "export",
		description: "导出会话（默认 HTML，也可指定 .html/.jsonl 路径）",
		argumentHint: "[path]",
		takesArgument: true,
	},
	{
		name: "import",
		description: "从 JSONL 文件导入并继续会话",
		argumentHint: "<path.jsonl>",
		takesArgument: true,
	},
	{ name: "share", description: "把整个会话上传为私密 GitHub gist" },
	{ name: "copy", description: "复制 AI 的上一条回答" },
	{
		name: "btw",
		description: "问个旁支问题，不写进会话；可接着追问，Esc 返回",
		argumentHint: "<question>",
		takesArgument: true,
	},
	{
		name: "name",
		description: "设置或查看会话名称",
		argumentHint: "[name]",
		takesArgument: true,
	},
	{ name: "session", description: "查看会话信息" },
	{ name: "system-prompt", description: "查看发给模型的完整系统提示" },
	{ name: "logs", description: "查看日志保存位置" },
	{
		name: "traces",
		description: "预览、上传或设置 Prime Agent traces",
		argumentHint: "[status|on|off|preview|upload|upload-current|upload-all|login]",
	},
	{ name: "context", description: "查看 token、费用和上下文用量（含子代理）" },
	{ name: "changelog", description: "查看更新日志" },
	{
		name: "update",
		description: `更新 ${APP_NAME} 和已装的扩展包`,
		argumentHint: "[source|--self|--extensions]",
		takesArgument: true,
	},
	{ name: "hotkeys", description: "查看全部快捷键" },
	{ name: "fork", description: "从之前的某条消息分叉出新会话" },
	{ name: "clone", description: "在当前位置复制一份会话" },
	{ name: "tree", description: "浏览会话历史树（切换分支）" },
	{ name: "login", description: "登录模型服务" },
	{ name: "logout", description: "退出模型服务登录" },
	{
		name: "mcp",
		description: "打开或管理 MCP 连接",
		argumentHint: "[add|list|get|remove|login|logout]",
		takesArgument: true,
	},
	{
		name: "new",
		description: "开新会话，可带名称或第一条消息",
		argumentHint: '[--name "session name" --] [prompt]',
		takesArgument: true,
	},
	{
		name: "compact",
		description: "压缩会话上下文；可附说明指定摘要重点",
		argumentHint: "[instructions]",
	},
	{
		name: "refine",
		description: "整理沉淀提示、技能、子代理与记忆",
	},
	{
		name: "goal",
		description: "设置或查看长期目标；可暂停、继续、清除",
		argumentHint: "[objective]",
		takesArgument: true,
	},
	{
		name: "autonomous",
		description: "设置或查看自主模式",
		argumentHint: "[status|on|off]",
		takesArgument: true,
	},
	{
		name: "rlm-max-depth",
		description: "设置或查看本会话的子代理最大层数（立即生效，不打断当前任务）",
		argumentHint: "[<int> [--global]]",
		takesArgument: true,
	},
	{
		name: "heartbeat",
		description: "设置或查看定时任务；默认插话投递，--follow-up 改为排队；可暂停、继续、停止、清除",
		argumentHint: "[status|pause|resume|stop|[every <duration>] [--steer|--follow-up] <instruction>]",
		takesArgument: true,
	},
	{ name: "heartbeats", description: "查看和管理所有定时任务" },
	{
		name: "resume",
		description: "打开会话列表，或按 id/路径继续某个会话",
		argumentHint: "[id|path]",
		takesArgument: true,
	},
	{
		name: "reload",
		description: "重新加载快捷键、扩展、技能、提示词和主题",
	},
	{
		name: "fullscreen",
		description: "开关全屏模式（可滚动查看全部对话）",
		argumentHint: "[on|off]",
		takesArgument: true,
	},
	{
		name: "speed",
		description: "开关底栏的输出速度显示（tok/s）",
		argumentHint: "[on|off]",
		takesArgument: true,
	},
	{ name: "quit", description: `退出 ${APP_NAME}` },
];

const BUILTIN_SLASH_COMMAND_ALIASES: ReadonlyArray<BuiltinSlashCommandAlias> = [
	{ name: "clear", aliasFor: "new" },
	{ name: "usage", aliasFor: "context" },
	{ name: "thinking", aliasFor: "effort" },
	{ name: "rename", aliasFor: "name" },
	{ name: "side", aliasFor: "btw" },
];

function buildBuiltinSlashCommands(): ReadonlyArray<BuiltinSlashCommand> {
	const canonicalByName = new Map(CANONICAL_BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));
	const aliasesByTarget = new Map<string, string[]>();
	for (const alias of BUILTIN_SLASH_COMMAND_ALIASES) {
		const target = canonicalByName.get(alias.aliasFor);
		if (!target) {
			throw new Error(`Slash command alias '/${alias.name}' targets unknown command '/${alias.aliasFor}'`);
		}
		const targetAliases = aliasesByTarget.get(alias.aliasFor);
		if (targetAliases) {
			targetAliases.push(alias.name);
		} else {
			aliasesByTarget.set(alias.aliasFor, [alias.name]);
		}
	}
	return CANONICAL_BUILTIN_SLASH_COMMANDS.map((command) => ({
		...command,
		...(isSessionSlashCommandName(command.name) ? { execution: "session" as const } : {}),
		...(aliasesByTarget.has(command.name) ? { aliases: aliasesByTarget.get(command.name) } : {}),
	}));
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = buildBuiltinSlashCommands();

const BUILTIN_SLASH_COMMAND_BY_NAME = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));
const BUILTIN_SLASH_COMMAND_ALIAS_TO_NAME = new Map(
	BUILTIN_SLASH_COMMANDS.flatMap((command) => command.aliases?.map((alias) => [alias, command.name] as const) ?? []),
);

export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
	if (!text.startsWith("/")) return undefined;
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
	if (!match) return undefined;
	return { name: match[1], args: (match[2] ?? "").trim() };
}

export function resolveBuiltinSlashCommandName(name: string): string {
	return BUILTIN_SLASH_COMMAND_ALIAS_TO_NAME.get(name) ?? name;
}

export function isBuiltinSlashCommandName(name: string): boolean {
	return BUILTIN_SLASH_COMMAND_BY_NAME.has(name) || BUILTIN_SLASH_COMMAND_ALIAS_TO_NAME.has(name);
}

export function builtinSlashCommandTakesArgument(name: string): boolean {
	// /clear remains the no-argument compatibility alias even though /new accepts arguments.
	if (name === "clear") return false;
	return BUILTIN_SLASH_COMMAND_BY_NAME.get(resolveBuiltinSlashCommandName(name))?.takesArgument === true;
}

export function resolveSlashCommand(command: ParsedSlashCommand): ResolvedSlashCommand {
	const name = resolveBuiltinSlashCommandName(command.name);
	return {
		...command,
		name,
		originalName: command.name,
		isAlias: name !== command.name,
	};
}

export function parseSessionSlashCommand(text: string): SessionSlashCommand | undefined {
	if (/[\r\n\u2028\u2029]/u.test(text)) return undefined;
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	const name = resolveBuiltinSlashCommandName(parsed.name);
	const command = BUILTIN_SLASH_COMMAND_BY_NAME.get(name);
	if (command?.execution !== "session" || !isSessionSlashCommandName(name)) return undefined;
	return { name, args: parsed.args, text };
}

/**
 * Closest command-name suggestion for an unrecognized slash command, or
 * undefined when nothing is near enough. Shared by the CLI's unknown-command
 * notice and the session's slash-command typo guard.
 */
export function findSlashCommandSuggestion(input: string, candidates: readonly string[]): string | undefined {
	let closest: { candidate: string; distance: number } | undefined;
	for (const candidate of candidates) {
		const distance = slashCommandEditDistance(input, candidate);
		if (!closest || distance < closest.distance) {
			closest = { candidate, distance };
		}
	}
	// Very short tokens match only on a single-character typo: a two-character
	// tolerance on a three-character token lets unrelated path-like words
	// (tmp vs mcp) masquerade as command typos.
	const threshold = input.length <= 3 ? 1 : Math.max(2, Math.floor(input.length / 3));
	if (!closest || closest.distance > threshold) {
		return undefined;
	}
	return closest.candidate;
}

function slashCommandEditDistance(left: string, right: string): number {
	const previous = new Array<number>(right.length + 1);
	const current = new Array<number>(right.length + 1);
	for (let j = 0; j <= right.length; j++) previous[j] = j;
	for (let i = 1; i <= left.length; i++) {
		current[0] = i;
		for (let j = 1; j <= right.length; j++) {
			current[j] = Math.min(
				previous[j]! + 1,
				current[j - 1]! + 1,
				previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
			);
		}
		for (let j = 0; j <= right.length; j++) previous[j] = current[j]!;
	}
	return previous[right.length]!;
}
