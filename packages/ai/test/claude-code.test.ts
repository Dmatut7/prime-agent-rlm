import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findClaudeCodeExecutable } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";
import {
	buildClaudeCodeTranscript,
	CLAUDE_CODE_RESUME_NOTE,
	planClaudeCodeTurn,
	toClaudeCodeMessages,
} from "../src/providers/claude-code-transcript.js";
import { streamSimple } from "../src/stream.js";
import type { AssistantMessage, Context, Message, Model, Tool, ToolResultMessage, Usage } from "../src/types.js";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function claudeCodeModel(id: string): Model<"claude-code"> {
	const model = getModel("claude-code" as never, id as never) as Model<"claude-code"> | undefined;
	if (!model) throw new Error(`claude-code model ${id} is not registered`);
	return model;
}

const ipythonTool: Tool = {
	name: "ipython",
	description: "Execute Python code",
	parameters: Type.Object({ code: Type.String() }),
};

function assistantWithToolCall(model: Model<"claude-code">, id: string, code: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Running it." },
			{ type: "toolCall", id, name: "ipython", arguments: { code } },
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

describe("claude-code transcript conversion", () => {
	const model = claudeCodeModel("claude-opus-5-5");

	it("sends the last user message as the prompt and writes everything before it as history", () => {
		const messages: Message[] = [
			{ role: "user", content: "compute 2**10", timestamp: 0 },
			assistantWithToolCall(model, "toolu_1", "print(2**10)"),
			toolResult("toolu_1", "1024"),
			{
				role: "assistant",
				content: [{ type: "text", text: "It is 1024." }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 3,
			},
			{ role: "user", content: [{ type: "text", text: "and 2**11?" }], timestamp: 4 },
		];

		const turn = planClaudeCodeTurn(toClaudeCodeMessages(messages, model));

		expect(turn.prompt).toEqual([{ type: "text", text: "and 2**11?" }]);
		expect(turn.history.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(turn.history[1].content).toContainEqual({
			type: "tool_use",
			id: "toolu_1",
			name: "mcp__prime__ipython",
			input: { code: "print(2**10)" },
		});
		expect(turn.history[2].content).toEqual([
			{ type: "tool_result", tool_use_id: "toolu_1", content: "1024", is_error: false },
		]);
	});

	it("resumes with a note when the history ends in tool results", () => {
		const messages: Message[] = [
			{ role: "user", content: "compute 2**10", timestamp: 0 },
			assistantWithToolCall(model, "toolu_1", "print(2**10)"),
			toolResult("toolu_1", "1024"),
		];

		const turn = planClaudeCodeTurn(toClaudeCodeMessages(messages, model));

		expect(turn.history).toHaveLength(3);
		expect(turn.prompt).toEqual([{ type: "text", text: CLAUDE_CODE_RESUME_NOTE }]);
	});

	it("keeps a signed thinking block and turns an unsigned one into text", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "", thinkingSignature: "sig-omitted" },
					{ type: "thinking", thinking: "plain reasoning" },
					{ type: "text", text: "hello" },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 1,
			},
			{ role: "user", content: "again", timestamp: 2 },
		];

		const turn = planClaudeCodeTurn(toClaudeCodeMessages(messages, model));

		expect(turn.history[1].content).toEqual([
			{ type: "thinking", thinking: "", signature: "sig-omitted" },
			{ type: "text", text: "plain reasoning" },
			{ type: "text", text: "hello" },
		]);
	});

	it("links transcript entries into one parent chain", () => {
		const turn = planClaudeCodeTurn(
			toClaudeCodeMessages(
				[
					{ role: "user", content: "compute", timestamp: 0 },
					assistantWithToolCall(model, "toolu_1", "print(1)"),
					toolResult("toolu_1", "1"),
					{ role: "user", content: "next", timestamp: 3 },
				],
				model,
			),
		);
		let counter = 0;
		const jsonl = buildClaudeCodeTranscript(turn.history, {
			sessionId: "session-1",
			cwd: "/work",
			model: "opus",
			newId: () => `id-${++counter}`,
		});
		const entries = jsonl
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		expect(entries.map((entry) => [entry.type, entry.uuid, entry.parentUuid])).toEqual([
			["user", "id-1", null],
			["assistant", "id-2", "id-1"],
			["user", "id-3", "id-2"],
		]);
		expect((entries[1].message as { stop_reason: string }).stop_reason).toBe("tool_use");
		expect(entries.every((entry) => entry.sessionId === "session-1" && entry.cwd === "/work")).toBe(true);
	});
});

/**
 * Stands in for the Claude Code CLI: speaks its stream-json protocol, reads the resumed
 * transcript, and calls the session's tools over the MCP server it was given.
 */
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const argValue = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const log = (entry) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry) + "\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const api = (event) => emit({ type: "stream_event", event });
const scenario = process.env.FAKE_CLAUDE_SCENARIO;
if (process.env.FAKE_CLAUDE_REJECT_THINKING_DISPLAY === "1" && args.includes("--thinking-display")) {
	process.stderr.write("error: unknown option '--thinking-display'\n");
	process.exit(1);
}

let transcriptEntries = 0;
const resume = argValue("--resume");
if (resume) {
	const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "projects", fs.realpathSync(process.cwd()).replace(/[^a-zA-Z0-9]/g, "-"));
	transcriptEntries = fs.readFileSync(path.join(dir, resume + ".jsonl"), "utf8").trim().split("\n").length;
}
const systemPrompt = fs.readFileSync(argValue("--system-prompt-file"), "utf8");
const env = {};
for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_ENTRYPOINT", "DISABLE_AUTO_COMPACT", "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "MAX_MCP_OUTPUT_TOKENS"]) env[key] = process.env[key];

let buffer = "";
let turns = 0;
let queue = Promise.resolve();
let running = false;
const steers = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.trim().length === 0) continue;
		const prompt = JSON.parse(line);
		if (running) {
			// A message written while a turn runs is a mid-turn message, as in Claude Code.
			steers.push(prompt.message.content.map((block) => block.text).join(""));
			log({ steer: steers[steers.length - 1] });
			continue;
		}
		running = true;
		const turn = ++turns;
		log({ pid: process.pid, turn, args, env, transcriptEntries, prompt: prompt.message.content, systemPrompt });
		queue = queue.then(() => run(turn)).then(() => { running = false; }).catch((error) => { log({ error: String(error) }); process.exit(1); });
	}
});
process.stdin.on("end", () => process.exit(0));

let frames = 0;
function frame(id, block) {
	const committed = block.type === "text" ? { type: "text", text: block.text } : { type: "tool_use", id: block.id, name: block.name, input: block.input };
	emit({ type: "assistant", uuid: "frame-" + (++frames), message: { id, type: "message", role: "assistant", content: [committed], stop_reason: null } });
}

async function callTool(serverUrl, id, code) {
	const response = await fetch(serverUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ipython", arguments: { code }, _meta: { "claudecode/toolUseId": id } } }),
	});
	const reply = await response.json();
	return reply.result.content.map((block) => block.text).join("");
}

function message(id, blocks, stopReason) {
	api({ type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 } } });
	blocks.forEach((block, index) => {
		if (block.type === "text") {
			api({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
			api({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
		} else {
			api({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
			api({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		}
		api({ type: "content_block_stop", index });
		frame(id, block);
	});
	api({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 7 } });
	api({ type: "message_stop" });
}

async function run(turn) {
	const mcpConfig = argValue("--mcp-config");
	const serverUrl = mcpConfig ? JSON.parse(mcpConfig).mcpServers.prime.url : undefined;
	if (turn === 1) emit({ type: "system", subtype: "init", mcp_servers: serverUrl ? [{ name: "prime", status: "connected" }] : [] });
	if (scenario === "overage") {
		emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } });
		return;
	}
	if (scenario === "limit") {
		emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600, isUsingOverage: false } });
		emit({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit · resets 6pm" });
		return;
	}
	emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false } });
	if (scenario === "hang") {
		api({ type: "message_start", message: { id: "msg_hang_" + turn, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
		api({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		api({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
		await new Promise(() => {});
	}
	if (scenario === "retry") {
		api({ type: "message_start", message: { id: "msg_dropped", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
		api({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		api({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut off mid" } });
		message("msg_retried", [{ type: "text", text: "the full answer" }], "end_turn");
		emit({ type: "result", subtype: "success", is_error: false, result: "the full answer" });
		return;
	}
	if (scenario === "fallback-tool") {
		api({ type: "message_start", message: { id: "msg_dropped", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
		api({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		api({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut off mid" } });
		// The non-streaming retry only reports committed blocks.
		frame("msg_fallback", { type: "text", text: "Running it." });
		frame("msg_fallback", { type: "tool_use", id: "toolu_fallback", name: "mcp__prime__ipython", input: { code: "print(6*7)" } });
		const text = await callTool(serverUrl, "toolu_fallback", "print(6*7)");
		message("msg_after_fallback", [{ type: "text", text: "done: " + text }], "end_turn");
		emit({ type: "result", subtype: "success", is_error: false, result: "done: " + text });
		return;
	}
	if (scenario === "two-tools") {
		message("msg_two_" + turn, [{ type: "tool_use", id: "toolu_a", name: "mcp__prime__ipython", input: { code: "a" } }, { type: "tool_use", id: "toolu_b", name: "mcp__prime__ipython", input: { code: "b" } }], "tool_use");
		// Claude Code claims one result at a time: the second call only after the first answered.
		const a = await callTool(serverUrl, "toolu_a", "a");
		const b = await callTool(serverUrl, "toolu_b", "b");
		// The model takes a while before the next message starts.
		await new Promise((resolve) => setTimeout(resolve, 800));
		message("msg_two_done_" + turn, [{ type: "text", text: "done: " + a + " " + b }], "end_turn");
		emit({ type: "result", subtype: "success", is_error: false, result: "done" });
		return;
	}
	if (scenario === "steer") {
		message("msg_steer_" + turn, [{ type: "tool_use", id: "toolu_s", name: "mcp__prime__ipython", input: { code: "s" } }], "tool_use");
		const result = await callTool(serverUrl, "toolu_s", "s");
		message("msg_steer_done_" + turn, [{ type: "text", text: "done: " + result + " | heard: " + steers.join(",") }], "end_turn");
		emit({ type: "result", subtype: "success", is_error: false, result: "done" });
		return;
	}
	if (scenario === "wander") {
		// Asks for a tool, then goes on without waiting for the session's result.
		message("msg_tool_" + turn, [{ type: "tool_use", id: "toolu_wander", name: "mcp__prime__ipython", input: { code: "print(1)" } }], "tool_use");
		await new Promise((resolve) => setTimeout(resolve, 50));
		message("msg_wandered_" + turn, [{ type: "text", text: "I went on alone" }], "end_turn");
		await new Promise(() => {});
	}
	if (scenario === "unknown-stop") {
		message("msg_unknown_" + turn, [{ type: "text", text: "odd" }], "some_future_reason");
		emit({ type: "result", subtype: "success", is_error: false, result: "odd" });
		return;
	}
	if (scenario === "stderr-escape") {
		process.stderr.write("progress \x1b[2J\x07 clearing\r\n");
		process.exit(1);
	}
	if (scenario === "text") {
		if (process.env.FAKE_CLAUDE_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_CLAUDE_DELAY_MS)));
		message("msg_text_" + turn, [{ type: "text", text: "plain answer " + turn }], "end_turn");
		emit({ type: "result", subtype: "success", is_error: false, result: "plain answer " + turn });
		return;
	}
	message("msg_tool_" + turn, [{ type: "text", text: "Running it." }, { type: "tool_use", id: "toolu_fake", name: "mcp__prime__ipython", input: { code: "print(6*7)" } }], "tool_use");
	const text = await callTool(serverUrl, "toolu_fake", "print(6*7)");
	log({ toolResult: text });
	message("msg_final_" + turn, [{ type: "text", text: "done: " + text }], "end_turn");
	emit({ type: "result", subtype: "success", is_error: false, result: "done: " + text });
}
`;

interface FakeRun {
	pid: number;
	turn: number;
	args: string[];
	env: Record<string, string | undefined>;
	transcriptEntries: number;
	prompt: unknown;
	systemPrompt: string;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("claude-code provider against a fake CLI", () => {
	const model = claudeCodeModel("claude-opus-5-5");
	let root: string;
	let cwd: string;
	let logPath: string;
	const savedEnv: Record<string, string | undefined> = {};

	function setEnv(key: string, value: string): void {
		if (!(key in savedEnv)) savedEnv[key] = process.env[key];
		process.env[key] = value;
	}

	function readLog(): Array<Record<string, unknown>> {
		if (!existsSync(logPath)) return [];
		return readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	beforeAll(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "claude-code-test-")));
		const binDir = join(root, "bin");
		cwd = join(root, "work");
		mkdirSync(binDir);
		mkdirSync(cwd);
		const fake = join(binDir, "claude");
		writeFileSync(fake, FAKE_CLAUDE);
		chmodSync(fake, 0o755);
		logPath = join(root, "calls.jsonl");
		setEnv("PATH", `${binDir}:${process.env.PATH ?? ""}`);
		setEnv("CLAUDE_CONFIG_DIR", join(root, "claude-config"));
		setEnv("FAKE_CLAUDE_LOG", logPath);
		setEnv("ANTHROPIC_API_KEY", "sk-should-not-reach-the-cli");
		// env-api-keys loads node:fs asynchronously; wait until the CLI can be located.
		for (let attempt = 0; attempt < 50 && findClaudeCodeExecutable() !== fake; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(findClaudeCodeExecutable()).toBe(fake);
	});

	afterAll(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("runs a tool call through the session and continues the same CLI process with its result", async () => {
		rmSync(logPath, { force: true });
		setEnv("FAKE_CLAUDE_SCENARIO", "tool");
		const context: Context = {
			systemPrompt: "You are the session's agent.",
			messages: [{ role: "user", content: "what is 6*7?", timestamp: 0 }],
			tools: [ipythonTool],
		};

		const first = await streamSimple(model, context, { sessionId: "session-tool", cwd, reasoning: "high" }).result();

		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toContainEqual({
			type: "toolCall",
			id: "toolu_fake",
			name: "ipython",
			arguments: { code: "print(6*7)" },
		});

		context.messages.push(first, toolResult("toolu_fake", "42"));
		const second = await streamSimple(model, context, { sessionId: "session-tool", cwd, reasoning: "high" }).result();

		expect(second.stopReason).toBe("stop");
		expect(second.content).toEqual([{ type: "text", text: "done: 42" }]);
		expect(second.usage.input).toBe(10);

		const runs = readLog().filter((entry) => "args" in entry) as unknown as FakeRun[];
		expect(runs).toHaveLength(1);
		const [run] = runs;
		expect(run.transcriptEntries).toBe(0);
		expect(run.systemPrompt).toBe("You are the session's agent.");
		expect(run.prompt).toEqual([{ type: "text", text: "what is 6*7?" }]);
		expect(run.args).toEqual(
			expect.arrayContaining([
				"--tools",
				"",
				"--no-session-persistence",
				"--effort",
				"high",
				"--thinking-display",
				"summarized",
			]),
		);
		expect(run.args[run.args.indexOf("--allowedTools") + 1]).toBe("mcp__prime__ipython");
		expect(run.env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(run.env.DISABLE_AUTO_COMPACT).toBe("1");
		expect(run.env.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT).toBe("0");
		expect(readLog()).toContainEqual({ toolResult: "42" });
	});

	it("starts the next turn from a transcript of the session's messages and removes it once read", async () => {
		rmSync(logPath, { force: true });
		setEnv("FAKE_CLAUDE_SCENARIO", "text");
		const context: Context = {
			systemPrompt: "You are the session's agent.",
			messages: [
				{ role: "user", content: "what is 6*7?", timestamp: 0 },
				assistantWithToolCall(model, "toolu_old", "print(6*7)"),
				toolResult("toolu_old", "42"),
				{
					role: "assistant",
					content: [{ type: "text", text: "42" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 3,
				},
				{ role: "user", content: "thanks", timestamp: 4 },
			],
			tools: [ipythonTool],
		};

		const reply = await streamSimple(model, context, { sessionId: "session-history", cwd }).result();

		expect(reply.stopReason).toBe("stop");
		expect(reply.content).toEqual([{ type: "text", text: "plain answer 1" }]);
		const [run] = readLog() as unknown as FakeRun[];
		expect(run.transcriptEntries).toBe(4);
		expect(run.prompt).toEqual([{ type: "text", text: "thanks" }]);
		// Read once the CLI reports init: gone before the turn even ends.
		const projectDir = join(root, "claude-config", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
		const resumeId = run.args[run.args.indexOf("--resume") + 1];
		expect(existsSync(join(projectDir, `${resumeId}.jsonl`))).toBe(false);
		expect(existsSync(run.args[run.args.indexOf("--system-prompt-file") + 1])).toBe(false);
	});

	it("keeps the CLI for the session's next message and replaces it once the history is rewritten", async () => {
		rmSync(logPath, { force: true });
		setEnv("FAKE_CLAUDE_SCENARIO", "text");
		const context: Context = {
			systemPrompt: "You are the session's agent.",
			messages: [{ role: "user", content: "first", timestamp: 0 }],
			tools: [ipythonTool],
		};

		const first = await streamSimple(model, context, { sessionId: "session-reuse", cwd }).result();
		context.messages.push(first, { role: "user", content: "second", timestamp: 1 });
		const second = await streamSimple(model, context, { sessionId: "session-reuse", cwd }).result();

		expect(second.content).toEqual([{ type: "text", text: "plain answer 2" }]);
		let runs = readLog() as unknown as FakeRun[];
		expect(runs.map((run) => [run.turn, run.prompt])).toEqual([
			[1, [{ type: "text", text: "first" }]],
			[2, [{ type: "text", text: "second" }]],
		]);
		expect(new Set(runs.map((run) => run.pid)).size).toBe(1);

		// A compaction rewrites the history: the old process cannot know the new messages.
		context.messages = [{ role: "user", content: "summary of before", timestamp: 2 }, second];
		context.messages.push({ role: "user", content: "third", timestamp: 3 });
		await streamSimple(model, context, { sessionId: "session-reuse", cwd }).result();
		runs = readLog() as unknown as FakeRun[];
		expect(runs).toHaveLength(3);
		expect(runs[2].pid).not.toBe(runs[0].pid);
		expect(runs[2].transcriptEntries).toBe(2);
	});

	it("finds the CLI in the first tick, when startup decides which models are available", () => {
		const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
		const script = `
			const { getEnvApiKey } = await import(${JSON.stringify(new URL("../src/env-api-keys.ts", import.meta.url).href)});
			console.log(JSON.stringify(getEnvApiKey("claude-code") ?? null));
		`;
		const result = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "--eval", script], {
			cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
			encoding: "utf8",
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(JSON.stringify("<authenticated>"));
	});

	it("lets a one-shot run exit while the finished turn's CLI waits for a next message", () => {
		const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
		const script = `
			const { getModel } = await import(${JSON.stringify(new URL("../src/models.ts", import.meta.url).href)});
			const { streamSimple } = await import(${JSON.stringify(new URL("../src/stream.ts", import.meta.url).href)});
			await new Promise((resolve) => setTimeout(resolve, 100));
			const reply = await streamSimple(getModel("claude-code", "claude-opus-5-5"), {
				systemPrompt: "s",
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
			}, { sessionId: "one-shot", cwd: ${JSON.stringify(cwd)} }).result();
			console.log(JSON.stringify(reply.content));
			const { readdirSync } = await import("node:fs");
			const { tmpdir } = await import("node:os");
			process.on("exit", () => {
				const left = readdirSync(tmpdir()).filter((name) => name.startsWith("prime-claude-code-")).length;
				console.log("temp dirs left: " + left);
			});
		`;
		const childTmp = join(root, "one-shot-tmp");
		mkdirSync(childTmp);
		const started = Date.now();
		const result = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "--eval", script], {
			cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
			env: { ...process.env, FAKE_CLAUDE_SCENARIO: "text", TMPDIR: childTmp },
			encoding: "utf8",
			timeout: 20_000,
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("plain answer 1");
		expect(result.stdout).toContain("temp dirs left: 0");
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("aborts a running turn, stops its CLI, and starts the next request fresh", async () => {
		rmSync(logPath, { force: true });
		setEnv("FAKE_CLAUDE_SCENARIO", "hang");
		const controller = new AbortController();
		const context: Context = { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const stream = streamSimple(model, context, { sessionId: "session-abort", cwd, signal: controller.signal });
		for await (const event of stream) {
			if (event.type === "text_delta") controller.abort();
		}
		const aborted = await stream.result();

		expect(aborted.stopReason).toBe("aborted");
		expect(aborted.content).toEqual([{ type: "text", text: "partial" }]);
		const [hung] = readLog() as unknown as FakeRun[];
		await expect.poll(() => processIsAlive(hung.pid)).toBe(false);

		setEnv("FAKE_CLAUDE_SCENARIO", "text");
		context.messages.push(aborted, { role: "user", content: "again", timestamp: 1 });
		const next = await streamSimple(model, context, { sessionId: "session-abort", cwd }).result();
		expect(next.content).toEqual([{ type: "text", text: "plain answer 1" }]);
	});

	it("keeps the step going when the CLI claims the results of a multi-call message one at a time", async () => {
		rmSync(logPath, { force: true });
		setEnv("FAKE_CLAUDE_SCENARIO", "two-tools");
		const context: Context = {
			systemPrompt: "s",
			messages: [{ role: "user", content: "two", timestamp: 0 }],
			tools: [ipythonTool],
		};

		const first = await streamSimple(model, context, { sessionId: "session-two", cwd }).result();
		expect(first.content.filter((block) => block.type === "toolCall").map((block) => block.id)).toEqual([
			"toolu_a",
			"toolu_b",
		]);
		context.messages.push(first, toolResult("toolu_a", "A"), toolResult("toolu_b", "B"));
		const second = await streamSimple(model, context, { sessionId: "session-two", cwd }).result();

		expect(second.stopReason).toBe("stop");
		expect(second.content).toEqual([{ type: "text", text: "done: A B" }]);
		expect(
			new Set((readLog() as unknown as FakeRun[]).filter((run) => "pid" in run).map((run) => run.pid)).size,
		).toBe(1);
	});

	it("hands a message that arrived while tools ran to the running CLI instead of rebuilding it", async () => {
		rmSync(logPath, { force: true });
		setEnv("FAKE_CLAUDE_SCENARIO", "steer");
		const context: Context = {
			systemPrompt: "s",
			messages: [{ role: "user", content: "go", timestamp: 0 }],
			tools: [ipythonTool],
		};

		const first = await streamSimple(model, context, { sessionId: "session-steer", cwd }).result();
		context.messages.push(first, toolResult("toolu_s", "S"), {
			role: "user",
			content: [{ type: "text", text: "child says hi" }],
			timestamp: 2,
		});
		const second = await streamSimple(model, context, { sessionId: "session-steer", cwd }).result();

		expect(second.content).toEqual([{ type: "text", text: "done: S | heard: child says hi" }]);
		const runs = (readLog() as unknown as FakeRun[]).filter((run) => "pid" in run);
		expect(runs).toHaveLength(1);
	});

	it("records the answer the CLI settled on when it retried a dropped stream", async () => {
		setEnv("FAKE_CLAUDE_SCENARIO", "retry");
		const reply = await streamSimple(
			model,
			{ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [ipythonTool] },
			{ sessionId: "session-retry", cwd },
		).result();

		expect(reply.stopReason).toBe("stop");
		expect(reply.content).toEqual([{ type: "text", text: "the full answer" }]);
	});

	it("ends the step on a tool call the CLI made from a non-streaming fallback", async () => {
		setEnv("FAKE_CLAUDE_SCENARIO", "fallback-tool");
		const context: Context = {
			systemPrompt: "s",
			messages: [{ role: "user", content: "what is 6*7?", timestamp: 0 }],
			tools: [ipythonTool],
		};

		const first = await streamSimple(model, context, { sessionId: "session-fallback", cwd }).result();

		expect(first.stopReason).toBe("toolUse");
		expect(first.content).toEqual([
			{ type: "text", text: "Running it." },
			{ type: "toolCall", id: "toolu_fallback", name: "ipython", arguments: { code: "print(6*7)" } },
		]);
		context.messages.push(first, toolResult("toolu_fallback", "42"));
		const second = await streamSimple(model, context, { sessionId: "session-fallback", cwd }).result();
		expect(second.content).toEqual([{ type: "text", text: "done: 42" }]);
	});

	it("drops a CLI that went on without the session's tool results and rebuilds from the transcript", async () => {
		rmSync(logPath, { force: true });
		setEnv("FAKE_CLAUDE_SCENARIO", "wander");
		const context: Context = {
			systemPrompt: "s",
			messages: [{ role: "user", content: "go", timestamp: 0 }],
			tools: [ipythonTool],
		};
		const first = await streamSimple(model, context, { sessionId: "session-wander", cwd }).result();
		expect(first.stopReason).toBe("toolUse");
		const [wandering] = readLog() as unknown as FakeRun[];
		await expect.poll(() => processIsAlive(wandering.pid)).toBe(false);

		setEnv("FAKE_CLAUDE_SCENARIO", "text");
		context.messages.push(first, toolResult("toolu_wander", "1"));
		const second = await streamSimple(model, context, { sessionId: "session-wander", cwd }).result();

		expect(second.content).toEqual([{ type: "text", text: "plain answer 1" }]);
		const rebuilt = (readLog() as unknown as FakeRun[])[1];
		expect(rebuilt.pid).not.toBe(wandering.pid);
		expect(rebuilt.transcriptEntries).toBe(3);
	});

	it("finishes both of two concurrent requests that share a session key", async () => {
		setEnv("FAKE_CLAUDE_SCENARIO", "text");
		setEnv("FAKE_CLAUDE_DELAY_MS", "300");
		const context: Context = { systemPrompt: "side", messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		try {
			const replies = await Promise.all([
				streamSimple(model, context, { sessionId: "session-side", cwd }).result(),
				streamSimple(model, context, { sessionId: "session-side", cwd }).result(),
			]);
			expect(replies.map((reply) => reply.stopReason)).toEqual(["stop", "stop"]);
		} finally {
			setEnv("FAKE_CLAUDE_DELAY_MS", "0");
		}
	});

	it("leaves no transcript or temp dir behind for a request aborted before it started", async () => {
		const projectDir = join(root, "claude-config", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
		const transcripts = () => (existsSync(projectDir) ? readdirSync(projectDir).length : 0);
		const tempDirs = () => readdirSync(tmpdir()).filter((name) => name.startsWith("prime-claude-code-")).length;
		const before = { transcripts: transcripts(), tempDirs: tempDirs() };
		const controller = new AbortController();
		controller.abort();

		const reply = await streamSimple(
			model,
			{
				systemPrompt: "s",
				messages: [
					{ role: "user", content: "earlier", timestamp: 0 },
					assistantWithToolCall(model, "toolu_x", "print(1)"),
					toolResult("toolu_x", "1"),
					{ role: "user", content: "now", timestamp: 3 },
				],
				tools: [ipythonTool],
			},
			{ sessionId: "session-pre-aborted", cwd, signal: controller.signal },
		).result();

		expect(reply.stopReason).toBe("aborted");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect({ transcripts: transcripts(), tempDirs: tempDirs() }).toEqual(before);
	});

	it("stops a request the CLI reports as billed to extra usage, as a quota failure", async () => {
		setEnv("FAKE_CLAUDE_SCENARIO", "overage");
		const reply = await streamSimple(
			model,
			{ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [ipythonTool] },
			{ sessionId: "session-overage", cwd },
		).result();

		expect(reply.stopReason).toBe("error");
		expect(reply.errorMessage).toContain("extra usage");
		const failure = reply.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure");
		expect((failure?.details as { kind?: string } | undefined)?.kind).toBe("quota");
	});

	it("reports a used-up plan as a rate limit with the reset the CLI announced", async () => {
		setEnv("FAKE_CLAUDE_SCENARIO", "limit");
		const reply = await streamSimple(
			model,
			{ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{ sessionId: "session-limit", cwd },
		).result();

		expect(reply.stopReason).toBe("error");
		expect(reply.errorMessage).toContain("hit your limit");
		const details = reply.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure")?.details as
			| { kind?: string; retryAfterMs?: number }
			| undefined;
		expect(details?.kind).toBe("rate_limit");
		expect(details?.retryAfterMs).toBeGreaterThan(3_500_000);
	});

	it("fails the turn on a stop reason the CLI made up, instead of reporting success", async () => {
		setEnv("FAKE_CLAUDE_SCENARIO", "unknown-stop");
		const reply = await streamSimple(
			model,
			{ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [ipythonTool] },
			{ sessionId: "session-unknown-stop", cwd },
		).result();

		expect(reply.stopReason).toBe("error");
		expect(reply.errorMessage).toContain("some_future_reason");
	});

	it("washes control characters out of the stderr tail quoted in the failure message", async () => {
		setEnv("FAKE_CLAUDE_SCENARIO", "stderr-escape");
		const reply = await streamSimple(
			model,
			{ systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [ipythonTool] },
			{ sessionId: "session-stderr-escape", cwd },
		).result();

		expect(reply.stopReason).toBe("error");
		const text = reply.errorMessage ?? "";
		expect(text).toContain("exited with code 1");
		expect(text).toContain("clearing");
		// The tail is persisted and rendered: an ESC in it would reach the terminal.
		expect(text).not.toContain("\x1b");
		expect(text).not.toContain("\x07");
		expect(text).not.toContain("\r");
	});
	// Last in this block: it switches the flag off for the rest of the module.
	it("drops the thinking-display flag once a CLI rejects it, and retries the same request", async () => {
		rmSync(logPath, { force: true });
		setEnv("FAKE_CLAUDE_SCENARIO", "text");
		setEnv("FAKE_CLAUDE_REJECT_THINKING_DISPLAY", "1");
		const context: Context = { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }] };

		const reply = await streamSimple(model, context, { sessionId: "session-old-cli", cwd }).result();
		const later = await streamSimple(model, context, { sessionId: "session-old-cli-2", cwd }).result();

		expect(reply.content).toEqual([{ type: "text", text: "plain answer 1" }]);
		expect(later.content).toEqual([{ type: "text", text: "plain answer 1" }]);
		const runs = readLog() as unknown as FakeRun[];
		expect(runs).toHaveLength(2);
		expect(runs.every((run) => !run.args.includes("--thinking-display"))).toBe(true);
	});
});
