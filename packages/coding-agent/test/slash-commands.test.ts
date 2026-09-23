import { describe, expect, test } from "vitest";
import { parseNewSessionCommand } from "../src/core/new-session-command.js";
import {
	BUILTIN_SLASH_COMMANDS,
	builtinSlashCommandTakesArgument,
	isBuiltinSlashCommandName,
	isSessionSlashCommandName,
	parseRefineCommandOptions,
	parseSessionSlashCommand,
	parseSlashCommand,
	resolveBuiltinSlashCommandName,
	resolveSlashCommand,
	SESSION_SLASH_COMMAND_NAMES,
} from "../src/core/slash-commands.js";

describe("built-in slash commands", () => {
	test("exposes heartbeat without exposing a cron slash command", () => {
		const commandNames = BUILTIN_SLASH_COMMANDS.map((command) => command.name);

		expect(commandNames).toContain("heartbeat");
		expect(commandNames).not.toContain("cron");
	});

	test("describes the fine-grained /rlm-max-depth semantics", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "rlm-max-depth")).toMatchObject({
			description: "设置或查看本会话的子代理最大层数（立即生效，不打断当前任务）",
			argumentHint: "[<int> [--global]]",
			takesArgument: true,
		});
	});

	test("exposes heartbeat syntax guidance", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "heartbeat")).toMatchObject({
			description: "设置或查看定时任务；默认插话投递，--follow-up 改为排队；可暂停、继续、停止、清除",
			argumentHint: "[status|pause|resume|stop|[every <duration>] [--steer|--follow-up] <instruction>]",
			takesArgument: true,
		});
	});

	test("exposes /effort for selecting the thinking level", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "effort")).toMatchObject({
			description: "选择 Thinking 强度",
			argumentHint: "[level]",
			aliases: ["thinking"],
		});
	});

	test("exposes /btw as an argument command with /side as an alias", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "btw")).toMatchObject({
			argumentHint: "<question>",
			aliases: ["side"],
			takesArgument: true,
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "side")).toBeUndefined();
		expect(builtinSlashCommandTakesArgument("side")).toBe(true);
	});

	test("describes /mcp as the MCP Connections menu entry point", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "mcp")).toMatchObject({
			description: "打开或管理 MCP 连接",
			argumentHint: "[add|list|get|remove|login|logout]",
			takesArgument: true,
		});
	});

	test("exposes trace preview and backfill syntax", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "traces")).toMatchObject({
			description: "预览、上传或设置 Prime Agent traces",
			argumentHint: "[status|on|off|preview|upload|upload-current|upload-all|login]",
		});
	});

	test("marks argument commands as taking a free-form argument", () => {
		for (const [name, argumentHint] of [
			["model", "[search]"],
			["export", "[path]"],
			["import", "<path.jsonl>"],
			["name", "[name]"],
		] as const) {
			expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === name)).toMatchObject({
				argumentHint,
				takesArgument: true,
			});
		}
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "goal")).toMatchObject({
			takesArgument: true,
		});
		expect(builtinSlashCommandTakesArgument("goal")).toBe(true);
		expect(builtinSlashCommandTakesArgument("effort")).toBe(false);
		expect(builtinSlashCommandTakesArgument("thinking")).toBe(false);
		expect(builtinSlashCommandTakesArgument("heartbeat")).toBe(true);
		expect(builtinSlashCommandTakesArgument("mcp")).toBe(true);
		expect(builtinSlashCommandTakesArgument("new")).toBe(true);
		expect(builtinSlashCommandTakesArgument("clear")).toBe(false);
	});
});

describe("slash command aliases", () => {
	test("keeps aliases hidden on canonical command entries", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "clear")).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "usage")).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "rename")).toBeUndefined();
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "new")).toMatchObject({
			description: "开新会话，可带名称或第一条消息",
			argumentHint: '[--name "session name" --] [prompt]',
			aliases: ["clear"],
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "context")).toMatchObject({
			description: "查看 token、费用和上下文用量（含子代理）",
			aliases: ["usage"],
		});
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "name")).toMatchObject({
			description: "设置或查看会话名称",
			argumentHint: "[name]",
			takesArgument: true,
			aliases: ["rename"],
		});
	});

	test("resolves /rename to /name through the alias path", () => {
		const parsed = parseSlashCommand("/rename my session");

		expect(isBuiltinSlashCommandName("rename")).toBe(true);
		expect(resolveBuiltinSlashCommandName("rename")).toBe("name");
		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "name",
			args: "my session",
			originalName: "rename",
			isAlias: true,
		});
	});

	test("carries the alias argument requirement over to the canonical command", () => {
		expect(builtinSlashCommandTakesArgument("side")).toBe(builtinSlashCommandTakesArgument("btw"));
		expect(builtinSlashCommandTakesArgument("thinking")).toBe(builtinSlashCommandTakesArgument("effort"));
		expect(builtinSlashCommandTakesArgument("clear")).toBe(false);
		expect(builtinSlashCommandTakesArgument("new")).toBe(true);
		expect(BUILTIN_SLASH_COMMANDS.find((c) => c.name === "speed")?.argumentHint).toBe("[on|off]");
		expect(BUILTIN_SLASH_COMMANDS.find((c) => c.name === "speed")?.takesArgument).toBe(true);
	});

	test("resolves /clear to /new through the alias path", () => {
		const parsed = parseSlashCommand("/clear");

		expect(parsed).toEqual({ name: "clear", args: "" });
		expect(parseSlashCommand("/new\n  multiline prompt")).toEqual({ name: "new", args: "multiline prompt" });
		expect(isBuiltinSlashCommandName("clear")).toBe(true);
		expect(resolveBuiltinSlashCommandName("clear")).toBe("new");
		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "new",
			args: "",
			originalName: "clear",
			isAlias: true,
		});
		expect(parseNewSessionCommand(" write a\n  multiline prompt  ")).toEqual({
			prompt: "write a\n  multiline prompt  ",
		});
		expect(parseNewSessionCommand(" --name stable")).toEqual({ name: "stable" });
		expect(parseNewSessionCommand(' --name "stable name" --  \n  --keep\nformat  ')).toEqual({
			name: "stable name",
			prompt: "  --keep\nformat  ",
		});
		expect(() => parseNewSessionCommand(" --name")).toThrow("Missing value");
		expect(() => parseNewSessionCommand(' --name "one" --name "two"')).toThrow("Duplicate");
		expect(() => parseNewSessionCommand(" --other value")).toThrow("Unknown /new option");
		expect(() => parseNewSessionCommand(' --name "broken')).toThrow("Unterminated quote");
	});

	test("resolves /thinking to /effort through the alias path", () => {
		const parsed = parseSlashCommand("/thinking");

		expect(isBuiltinSlashCommandName("thinking")).toBe(true);
		expect(resolveBuiltinSlashCommandName("thinking")).toBe("effort");
		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "effort",
			args: "",
			originalName: "thinking",
			isAlias: true,
		});
	});

	test("preserves arguments when resolving aliases", () => {
		const parsed = parseSlashCommand("/usage latest turn");

		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "context",
			args: "latest turn",
			originalName: "usage",
			isAlias: true,
		});
	});

	test("resolves /side to /btw", () => {
		const parsed = parseSlashCommand("/side Is this cached?");

		expect(resolveSlashCommand(parsed!)).toEqual({
			name: "btw",
			args: "Is this cached?",
			originalName: "side",
			isAlias: true,
		});
	});
});

describe("session slash commands", () => {
	test("keeps the authoritative names and built-in execution metadata in sync", () => {
		expect(
			BUILTIN_SLASH_COMMANDS.filter((command) => command.execution === "session").map((command) => command.name),
		).toEqual([...SESSION_SLASH_COMMAND_NAMES]);
		for (const name of SESSION_SLASH_COMMAND_NAMES) expect(isSessionSlashCommandName(name)).toBe(true);
		expect(isSessionSlashCommandName("settings")).toBe(false);
	});

	test("splits at the first horizontal Unicode whitespace and preserves the raw text", () => {
		for (const text of ["/goal ship it", "/goal\tship it", "/goal\u00a0ship it", "/goal\u2003ship it"]) {
			expect(parseSlashCommand(text)).toEqual({ name: "goal", args: "ship it" });
			expect(parseSessionSlashCommand(text)).toEqual({ name: "goal", args: "ship it", text });
		}
		expect(parseSlashCommand("/goal\t  ship it  ")).toEqual({ name: "goal", args: "ship it" });
		for (const lineTerminator of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
			expect(parseSessionSlashCommand(`/goal${lineTerminator}ship it`)).toBeUndefined();
			expect(parseSessionSlashCommand(`/goal\t${lineTerminator}ship it`)).toBeUndefined();
			expect(parseSessionSlashCommand(`/autonomous\t${lineTerminator}on`)).toBeUndefined();
		}
	});

	test("parses refine rollback ids and --global placement without consuming instruction text", () => {
		expect(parseRefineCommandOptions("rollback refine_123")).toEqual({ rollbackId: "refine_123", global: false });
		expect(parseRefineCommandOptions("rollback refine_456 --global")).toEqual({
			rollbackId: "refine_456",
			global: true,
		});
		expect(parseRefineCommandOptions("--global rollback refine_789")).toEqual({
			rollbackId: "refine_789",
			global: true,
		});
		expect(parseRefineCommandOptions("--global focus on validation")).toEqual({
			instructions: "focus on validation",
			global: true,
		});
		expect(parseRefineCommandOptions("update docs to explain --global")).toEqual({
			instructions: "update docs to explain --global",
			global: false,
		});
		for (const args of ["rollback", "rollback --global"]) {
			expect(() => parseRefineCommandOptions(args)).toThrow("Usage: /refine rollback <refinement-id>");
		}
	});

	test("classifies only exact leading session-owned commands", () => {
		expect(parseSessionSlashCommand("/compact focus on tests")).toEqual({
			name: "compact",
			args: "focus on tests",
			text: "/compact focus on tests",
		});
		expect(parseSessionSlashCommand("/refine")).toEqual({ name: "refine", args: "", text: "/refine" });
		expect(parseSessionSlashCommand("/goal ship it")).toEqual({
			name: "goal",
			args: "ship it",
			text: "/goal ship it",
		});
		expect(parseSessionSlashCommand("/autonomous status")).toEqual({
			name: "autonomous",
			args: "status",
			text: "/autonomous status",
		});
		expect(parseSessionSlashCommand("/rlm-max-depth 3 --global")).toBeUndefined();
		expect(parseSessionSlashCommand("Explain /compact")).toBeUndefined();
		expect(parseSessionSlashCommand(" /compact")).toBeUndefined();
		expect(parseSessionSlashCommand("/compaction")).toBeUndefined();
		expect(parseSessionSlashCommand("/settings")).toBeUndefined();
	});
});
