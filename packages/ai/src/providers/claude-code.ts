import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, ContentBlockParam, RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages.js";
import { findClaudeCodeExecutable } from "../env-api-keys.js";
import { calculateCost, clampThinkingLevel } from "../models.js";
import type {
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { parseStreamingJson } from "../utils/json-parse.js";
import {
	classifyStreamFailure,
	formatStreamFailureMessage,
	recordStreamFailure,
	StreamFailureError,
	type StreamFailureKind,
	streamFailureFromStopReason,
} from "../utils/stream-failure.js";
import { finalizeThrottledStreamingJson, updateThrottledStreamingJson } from "../utils/streaming-json-throttle.js";
import { type ClaudeCodeToolResult, ClaudeCodeToolServer } from "./claude-code-tool-server.js";
import {
	buildClaudeCodeTranscript,
	CLAUDE_CODE_TOOL_SERVER_NAME,
	fromClaudeCodeToolName,
	planClaudeCodeTurn,
	toClaudeCodeMessages,
	toClaudeCodeToolName,
} from "./claude-code-transcript.js";
import { buildBaseOptions } from "./simple-options.js";

/**
 * Claude models through the locally installed Claude Code CLI, billed to the user's
 * Claude subscription.
 *
 * Claude Code runs as the model backend only: its own tools are disabled and the
 * session's tools are served to it over a loopback MCP server, so every tool call is
 * executed by the session exactly as with any other provider.
 *
 * A CLI process follows one session for as long as the session only appends to what
 * the process has seen. A tool call ends the current assistant message; the process
 * then waits, holding the MCP request open, until the next request carries the tool
 * results. After a finished turn it waits for the next user message, so the CLI's own
 * view of the conversation, and with it the prompt cache, carries over. Any other
 * request (a compaction, a branch switch, a message injected mid-turn, a restart)
 * starts a new process from a transcript written from the session's messages, which
 * stay the single source of truth for the conversation.
 *
 * The streamed events are a live preview. What a turn records is what the CLI itself
 * committed (its `assistant` frames, one per finished content block): the CLI retries
 * dropped streams and falls back to non-streaming requests on its own, and only its
 * committed blocks survive those.
 */

export type ClaudeCodeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeCodeOptions extends StreamOptions {
	effort?: ClaudeCodeEffort;
}

/** Tool calls can run for as long as the session lets them; the CLI must not time them out. */
const TOOL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
/** A process still waiting for tool results after this long belongs to a turn nobody will finish. */
const AWAITING_TOOLS_TTL_MS = 3 * 60 * 60 * 1000;
/**
 * How long a process stays up after a finished turn for the session's next message. Its
 * value is the warm prompt cache, which the CLI keeps for an hour; each idle process
 * costs about 250 MB of memory.
 */
const FINISHED_TURN_TTL_MS = 20 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const MAX_LIVE_SESSIONS = 16;
const STDERR_TAIL_CHARS = 4000;
/**
 * A tool call that arrives for a message the stream never showed (the CLI's
 * non-streaming fallback) ends the step once the CLI has been quiet this long, so the
 * rest of that message's committed blocks are in.
 */
const UNSTREAMED_TOOL_CALL_SETTLE_MS = 300;
/**
 * Asks for thinking summaries. Print mode otherwise omits thinking text entirely, and
 * the session would show nothing of what the model considered. The flag is not in the
 * CLI's `--help`, so a CLI that rejects it runs without it from then on.
 */
const THINKING_DISPLAY_ARGS = ["--thinking-display", "summarized"];
let thinkingDisplaySupported = true;
const MAX_PROJECT_DIR_NAME_LENGTH = 200;

/**
 * Environment the CLI runs with. Inherited Anthropic/Claude Code variables are dropped
 * so an API key or gateway configured for something else cannot silently move billing
 * off the subscription; the subscription's own long-lived token is kept.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key === "CLAUDE_CODE_OAUTH_TOKEN") {
			env[key] = value;
			continue;
		}
		if (key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_CODE_") || key === "CLAUDECODE") continue;
		env[key] = value;
	}
	const loopback = "127.0.0.1,localhost";
	for (const key of ["NO_PROXY", "no_proxy"]) {
		env[key] = env[key] ? `${env[key]},${loopback}` : loopback;
	}
	return {
		...env,
		// The session owns memory, project instructions and compaction.
		CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
		CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
		DISABLE_AUTO_COMPACT: "1",
		// Tools are the session's: connect them before the first request, never time them
		// out, background them, cut their output, or hide them behind tool search.
		MCP_CONNECTION_NONBLOCKING: "0",
		MCP_TOOL_TIMEOUT: String(TOOL_TIMEOUT_MS),
		CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0",
		CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND: "1",
		MAX_MCP_OUTPUT_TOKENS: "1000000",
		CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "100000",
		ENABLE_TOOL_SEARCH: "false",
		DISABLE_AUTOUPDATER: "1",
	};
}

function resolveCwd(cwd: string | undefined): string {
	const requested = cwd ?? process.cwd();
	try {
		return realpathSync(requested);
	} catch {
		return requested;
	}
}

/** Where Claude Code keeps the transcripts of sessions started in `cwd`. */
function claudeCodeProjectDir(cwd: string): string {
	const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	return join(configDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mapStopReason(reason: string | null | undefined): StopReason {
	switch (reason) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "refusal":
		case "sensitive":
			return "error";
		default:
			return "stop";
	}
}

function toolResultForCli(message: ToolResultMessage): ClaudeCodeToolResult {
	const content = message.content.map((block) =>
		block.type === "text"
			? { type: "text" as const, text: block.text }
			: { type: "image" as const, data: block.data, mimeType: block.mimeType },
	);
	return { content: content.length > 0 ? content : [{ type: "text", text: "" }], isError: message.isError };
}

/**
 * Failure named by the CLI in plain text: a result error ("API Error: 529 ...",
 * "You've hit your limit · resets 6pm", "Not logged in · Please run /login") or a
 * process that died.
 */
function claudeCodeFailure(text: string, retryAfterMs?: number): StreamFailureError {
	const statusMatch = /API Error:\s*(\d{3})/i.exec(text);
	const status = statusMatch ? Number(statusMatch[1]) : undefined;
	let kind: StreamFailureKind = classifyStreamFailure(text, status);
	if (/extra usage/i.test(text)) {
		kind = "quota";
	} else if (/hit your (?:\w+ )?limit|usage limit|limit reached/i.test(text)) {
		kind = "rate_limit";
	} else if (/please run \/login|not logged in|invalid api key|oauth token has expired/i.test(text)) {
		kind = "auth";
	}
	return new StreamFailureError(`Claude Code: ${text}`, {
		kind,
		providerErrorType: "claude_code",
		...(status !== undefined ? { status } : {}),
		...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
	});
}

/** A block the CLI committed, in the session's content shape. */
function fromCommittedBlock(block: ContentBlock): TextContent | ThinkingContent | ToolCall | undefined {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "thinking":
			return { type: "thinking", thinking: block.thinking, thinkingSignature: block.signature };
		case "redacted_thinking":
			return { type: "thinking", thinking: "[Reasoning redacted]", thinkingSignature: block.data, redacted: true };
		case "tool_use":
			return {
				type: "toolCall",
				id: block.id,
				name: fromClaudeCodeToolName(block.name),
				arguments: (block.input as Record<string, unknown>) ?? {},
			};
		default:
			return undefined;
	}
}

interface RateLimitInfo {
	status?: string;
	resetsAt?: number;
	isUsingOverage?: boolean;
	overageInUse?: boolean;
}

type StreamBlock = TextContent | ThinkingContent | (ToolCall & { partialJson?: string });

interface CommittedFrame {
	uuid?: string;
	block: TextContent | ThinkingContent | ToolCall;
}

/** One API message of the current stream, as previewed and as committed. */
interface ApiMessage {
	id: string;
	streamed: StreamBlock[];
	frames: CommittedFrame[];
	usage: Usage;
	stopReason?: string | null;
	stopped: boolean;
	/** Superseded by a retry or a fallback: none of it is part of the turn. */
	orphaned: boolean;
}

interface ClaudeCodeCliEvent {
	type?: string;
	subtype?: string;
	uuid?: string;
	event?: RawMessageStreamEvent;
	message?: {
		id?: string;
		uuid?: string;
		content?: ContentBlock[];
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_input_tokens?: number;
			cache_creation_input_tokens?: number;
		};
	};
	supersedes?: unknown;
	parent_tool_use_id?: string | null;
	rate_limit_info?: RateLimitInfo;
	is_error?: boolean;
	result?: unknown;
	errors?: unknown;
	mcp_servers?: Array<{ name?: string; status?: string }>;
	request_id?: string;
}

const sessions = new Map<string, ClaudeCodeSession>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;

// Transcripts and prompt files are only needed while their CLI runs; a host that exits
// without ending its sessions must not leave them behind. Everything here is synchronous.
process.once("exit", () => {
	for (const session of sessions.values()) session.dispose();
});

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Requests of one session share a key only when they could belong to the same turn:
 * same model, effort, system prompt and tools. Side requests of a session (compaction,
 * summaries) differ in at least one and never disturb a turn in progress.
 */
function sessionKey(model: Model<"claude-code">, context: Context, options?: ClaudeCodeOptions): string {
	const tools = (context.tools ?? []).map((tool) => `${tool.name}:${JSON.stringify(tool.parameters)}`).join("\n");
	return [
		options?.sessionId ?? "",
		model.id,
		options?.effort ?? "",
		hashText(context.systemPrompt ?? ""),
		hashText(tools),
	].join("\0");
}

function evictSessions(now: number): void {
	for (const session of sessions.values()) {
		if (session.isExpired(now)) session.dispose();
	}
	if (sessions.size < MAX_LIVE_SESSIONS) return;
	// Finished turns go first: dropping one only costs a cold cache, dropping a turn
	// waiting for tools costs its tool round trip. A streaming turn is never dropped.
	const byEvictionOrder = [...sessions.values()]
		.filter((session) => !session.isStreaming())
		.sort((a, b) => Number(b.isIdle()) - Number(a.isIdle()) || a.lastActivity - b.lastActivity);
	for (const session of byEvictionOrder.slice(0, sessions.size - MAX_LIVE_SESSIONS + 1)) session.dispose();
}

function ensureSweep(): void {
	if (sweepTimer) return;
	// Sessions a finished agent loop never comes back to are otherwise only reaped by a
	// later request.
	sweepTimer = setInterval(() => evictSessions(Date.now()), SWEEP_INTERVAL_MS);
	sweepTimer.unref();
}

class ClaudeCodeSession {
	lastActivity = Date.now();
	private state: "streaming" | "awaitingTools" | "idle" | "closed" = "streaming";
	private process?: ChildProcessWithoutNullStreams;
	private toolServer?: ClaudeCodeToolServer;
	private tempDir?: string;
	private transcriptPath?: string;
	private launch?: { executable: string; args: string[]; cwd: string; prompt: ContentBlockParam[] };
	private stdoutBuffer = "";
	private stderrTail = "";
	private receivedCliOutput = false;
	private hasTools = false;

	private stream?: AssistantMessageEventStream;
	private output?: AssistantMessage;
	/** Message count of the request being answered: the index its assistant message takes next. */
	private requestLength = 0;
	private signal?: AbortSignal;
	private readonly onAbort = () => this.fail(new Error("Request was aborted"));
	private apiMessages: ApiMessage[] = [];
	private openMessage?: ApiMessage;
	/** Preview blocks of the open message, keyed by the API's block index. */
	private blockIndexes = new Map<number, StreamBlock>();
	private unstreamedToolCallTimer?: ReturnType<typeof setTimeout>;
	private rateLimitResetMs?: number;

	/**
	 * Set between requests: where the last assistant message sits in the next request,
	 * its API message id, and the tool calls it made (empty after a finished turn).
	 */
	private awaiting?: { assistantIndex: number; responseId: string; messageId: string; calls: ToolCall[] };

	constructor(
		private readonly key: string,
		private readonly model: Model<"claude-code">,
	) {}

	isIdle(): boolean {
		return this.state === "idle";
	}

	/** A method rather than a field check: handlers called in between can close the session. */
	isClosed(): boolean {
		return this.state === "closed";
	}

	isStreaming(): boolean {
		return this.state === "streaming";
	}

	isExpired(now: number): boolean {
		if (this.state === "awaitingTools") return this.lastActivity < now - AWAITING_TOOLS_TTL_MS;
		if (this.state === "idle") return this.lastActivity < now - FINISHED_TURN_TTL_MS;
		return false;
	}

	/**
	 * Whether the request only appends what this process is waiting for: the results of
	 * exactly the calls it made, or, after a finished turn, the next user message(s). The
	 * assistant message it produced must sit where it left it, which is what shows the
	 * session did not rewrite the history in between.
	 */
	canContinue(context: Context): boolean {
		const awaiting = this.awaiting;
		const child = this.process;
		if (!awaiting || !child || child.exitCode !== null || child.signalCode !== null) return false;
		const messages = context.messages;
		const assistant = messages[awaiting.assistantIndex];
		if (assistant?.role !== "assistant" || assistant.responseId !== awaiting.responseId) return false;
		const appended = messages.slice(awaiting.assistantIndex + 1);
		if (this.state === "idle") {
			return appended.length > 0 && appended.every((message) => message.role === "user");
		}
		if (this.state !== "awaitingTools" || appended.length !== awaiting.calls.length) return false;
		const pending = new Set(awaiting.calls.map((call) => call.id));
		for (const message of appended) {
			if (message.role !== "toolResult" || !pending.delete(message.toolCallId)) return false;
		}
		return pending.size === 0;
	}

	continueTurn(context: Context, stream: AssistantMessageEventStream, options?: ClaudeCodeOptions): void {
		const awaiting = this.awaiting;
		if (!awaiting) return;
		const appended = context.messages.slice(awaiting.assistantIndex + 1);
		const resumingTools = this.state === "awaitingTools";
		this.awaiting = undefined;
		this.state = "streaming";
		this.setKeepAlive(true);
		this.beginStream(stream, context, options);
		if (this.state !== "streaming") return;
		if (resumingTools) {
			for (const message of appended) {
				if (message.role === "toolResult") this.toolServer?.deliver(message.toolCallId, toolResultForCli(message));
			}
			return;
		}
		const content = toClaudeCodeMessages(appended, this.model).flatMap((message) =>
			typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content,
		);
		this.writePrompt(content.length > 0 ? content : [{ type: "text", text: "(empty message)" }]);
	}

	async start(context: Context, stream: AssistantMessageEventStream, options?: ClaudeCodeOptions): Promise<void> {
		this.beginStream(stream, context, options);
		if (this.state !== "streaming") return;
		try {
			const executable = findClaudeCodeExecutable();
			if (!executable) {
				throw new StreamFailureError(
					"Claude Code CLI not found. Install Claude Code and run `claude` once to sign in with your Claude subscription.",
					{ kind: "auth", providerErrorType: "claude_code_not_installed" },
				);
			}

			const turn = planClaudeCodeTurn(toClaudeCodeMessages(context.messages, this.model));
			const tools = context.tools ?? [];
			this.hasTools = tools.length > 0;
			if (this.hasTools) {
				const toolServer = await ClaudeCodeToolServer.start(tools);
				if (this.state !== "streaming") {
					toolServer.close();
					return;
				}
				toolServer.onCall = (toolUseId) => this.onToolCall(toolUseId);
				this.toolServer = toolServer;
			}

			this.tempDir = mkdtempSync(join(tmpdir(), "prime-claude-code-"));
			let cwd = resolveCwd(options?.cwd);
			if (cwd.replace(/[^a-zA-Z0-9]/g, "-").length > MAX_PROJECT_DIR_NAME_LENGTH) {
				// Claude Code shortens long project directory names with a hash; a short
				// working directory keeps the transcript where it will look for it.
				cwd = resolveCwd(this.tempDir);
			}

			const cliSessionId = randomUUID();
			if (turn.history.length > 0) {
				const projectDir = claudeCodeProjectDir(cwd);
				mkdirSync(projectDir, { recursive: true });
				this.transcriptPath = join(projectDir, `${cliSessionId}.jsonl`);
				writeFileSync(
					this.transcriptPath,
					buildClaudeCodeTranscript(turn.history, {
						sessionId: cliSessionId,
						cwd,
						model: this.model.id,
						newId: randomUUID,
					}),
				);
			}

			const systemPromptPath = join(this.tempDir, "system-prompt.md");
			writeFileSync(systemPromptPath, context.systemPrompt ?? "");

			const args = [
				"-p",
				"--input-format",
				"stream-json",
				"--output-format",
				"stream-json",
				"--verbose",
				"--include-partial-messages",
				"--model",
				this.model.id,
				"--system-prompt-file",
				systemPromptPath,
				"--tools",
				"",
				"--strict-mcp-config",
				"--setting-sources",
				"",
				"--disable-slash-commands",
				"--no-session-persistence",
				...(thinkingDisplaySupported ? THINKING_DISPLAY_ARGS : []),
			];
			if (options?.effort) args.push("--effort", options.effort);
			if (turn.history.length > 0) args.push("--resume", cliSessionId);
			if (this.toolServer) {
				args.push(
					"--mcp-config",
					JSON.stringify({
						mcpServers: {
							[CLAUDE_CODE_TOOL_SERVER_NAME]: {
								type: "http",
								url: this.toolServer.url,
								timeout: TOOL_TIMEOUT_MS,
							},
						},
					}),
					"--allowedTools",
					tools.map((tool) => toClaudeCodeToolName(tool.name)).join(","),
				);
			}

			this.launch = { executable, args, cwd, prompt: turn.prompt };
			this.spawnCli();
		} catch (error) {
			this.fail(error);
		}
	}

	/**
	 * The CLI has read the transcript and the system prompt once it reports `init`.
	 * Removing them right away means a host that is killed leaves nothing behind in the
	 * user's own Claude Code history.
	 */
	private removeLaunchFiles(): void {
		for (const path of [this.transcriptPath, this.tempDir]) {
			if (path) rmSync(path, { recursive: true, force: true });
		}
		this.transcriptPath = undefined;
		this.tempDir = undefined;
	}

	/** Ends the session. A turn still streaming ends with an error rather than hanging. */
	dispose(): void {
		if (this.state === "closed") return;
		if (this.stream) this.pushFailure(new Error("The Claude Code process was stopped before this turn finished."));
		this.state = "closed";
		this.awaiting = undefined;
		this.clearUnstreamedToolCallTimer();
		this.detachSignal();
		this.toolServer?.close();
		const child = this.process;
		if (child && child.exitCode === null && child.signalCode === null) {
			child.stdin.end();
			child.kill("SIGTERM");
		}
		this.removeLaunchFiles();
		if (sessions.get(this.key) === this) sessions.delete(this.key);
	}

	private spawnCli(): void {
		const launch = this.launch;
		if (!launch) return;
		this.receivedCliOutput = false;
		this.stdoutBuffer = "";
		this.stderrTail = "";
		const child = spawn(launch.executable, launch.args, {
			cwd: launch.cwd,
			env: buildChildEnv(),
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (child === this.process) this.onStdout(chunk);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			if (child === this.process) this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (child !== this.process) return;
			this.fail(
				error.code === "ENOENT"
					? new StreamFailureError(`Claude Code CLI not found at ${launch.executable}.`, {
							kind: "auth",
							providerErrorType: "claude_code_not_installed",
						})
					: error,
			);
		});
		// `close`, not `exit`: only then has everything the CLI wrote been read.
		child.on("close", (code, signal) => {
			if (child === this.process) this.onExit(code, signal);
		});
		child.stdin.on("error", () => {
			// A CLI that exits early closes stdin; the close handler reports it.
		});
		this.writePrompt(launch.prompt);
	}

	/** A CLI that refuses the thinking-display flag before doing anything gets one more try without it. */
	private retryWithoutThinkingDisplay(): boolean {
		const launch = this.launch;
		if (!launch || this.receivedCliOutput || !/unknown option[^\n]*--thinking-display/i.test(this.stderrTail)) {
			return false;
		}
		const index = launch.args.indexOf(THINKING_DISPLAY_ARGS[0]);
		if (index === -1) return false;
		thinkingDisplaySupported = false;
		launch.args.splice(index, THINKING_DISPLAY_ARGS.length);
		try {
			this.spawnCli();
		} catch (error) {
			this.fail(error);
		}
		return true;
	}

	/**
	 * A process waiting for the session (tool results, the next message) must not keep a
	 * run from exiting: the loop may have stopped for good. While a turn streams it has
	 * to, since nothing else may be holding the event loop open.
	 */
	private setKeepAlive(keepAlive: boolean): void {
		const child = this.process;
		if (child) {
			for (const pipe of [child.stdin, child.stdout, child.stderr]) {
				const socket = pipe as unknown as Socket;
				if (keepAlive) socket.ref();
				else socket.unref();
			}
			if (keepAlive) child.ref();
			else child.unref();
		}
		this.toolServer?.setKeepAlive(keepAlive);
	}

	private writePrompt(content: ContentBlockParam[]): void {
		this.process?.stdin.write(
			`${JSON.stringify({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" })}\n`,
		);
	}

	private beginStream(stream: AssistantMessageEventStream, context: Context, options?: ClaudeCodeOptions): void {
		this.stream = stream;
		this.requestLength = context.messages.length;
		this.lastActivity = Date.now();
		this.output = {
			role: "assistant",
			content: [],
			api: this.model.api,
			provider: this.model.provider,
			model: this.model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.apiMessages = [];
		this.openMessage = undefined;
		this.blockIndexes.clear();
		stream.push({ type: "start", partial: this.output });
		this.signal = options?.signal;
		if (this.signal?.aborted) {
			this.onAbort();
			return;
		}
		this.signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	private detachSignal(): void {
		this.signal?.removeEventListener("abort", this.onAbort);
		this.signal = undefined;
	}

	private onStdout(chunk: string): void {
		if (this.state === "closed") return;
		this.lastActivity = Date.now();
		this.receivedCliOutput = true;
		this.stdoutBuffer += chunk;
		let newline = this.stdoutBuffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line.length > 0) {
				let event: ClaudeCodeCliEvent | undefined;
				try {
					event = JSON.parse(line) as ClaudeCodeCliEvent;
				} catch {
					event = undefined;
				}
				if (event) this.onCliEvent(event);
			}
			if (this.isClosed()) return;
			newline = this.stdoutBuffer.indexOf("\n");
		}
	}

	private onCliEvent(event: ClaudeCodeCliEvent): void {
		if (event.parent_tool_use_id) return;
		switch (event.type) {
			case "stream_event":
				if (event.event) this.onApiEvent(event.event);
				return;
			case "assistant":
				this.onCommittedFrame(event);
				return;
			case "tombstone":
				this.retractFrames([event.message?.uuid ?? event.uuid]);
				return;
			case "rate_limit_event":
				this.onRateLimit(event.rate_limit_info ?? {});
				return;
			case "result":
				this.onResult(event);
				return;
			case "system":
				if (event.subtype === "init") {
					this.checkToolServerConnected(event);
					this.removeLaunchFiles();
				}
				return;
			case "control_request":
				// Every tool the session serves is pre-approved; nothing else may ask the host.
				this.process?.stdin.write(
					`${JSON.stringify({
						type: "control_response",
						response: { subtype: "error", request_id: event.request_id, error: "Not supported by this host" },
					})}\n`,
				);
				return;
			default:
				return;
		}
	}

	private checkToolServerConnected(event: ClaudeCodeCliEvent): void {
		if (!this.toolServer) return;
		const server = event.mcp_servers?.find((entry) => entry.name === CLAUDE_CODE_TOOL_SERVER_NAME);
		if (server && (server.status === "failed" || server.status === "needs-auth")) {
			this.fail(new Error(`Claude Code could not connect to the session's tools (MCP status: ${server.status}).`));
		}
	}

	private onRateLimit(info: RateLimitInfo): void {
		if (typeof info.resetsAt === "number") {
			this.rateLimitResetMs = Math.max(0, info.resetsAt * 1000 - Date.now());
		}
		if (info.isUsingOverage === true || info.overageInUse === true) {
			this.fail(
				new StreamFailureError(
					"Claude Code reported that this request is billed to extra usage instead of the Claude plan, so it was stopped. Keep extra usage turned off at claude.ai/settings/usage; the plan limits reset on their own.",
					{
						kind: "quota",
						providerErrorType: "claude_code_extra_usage",
						...(this.rateLimitResetMs !== undefined ? { retryAfterMs: this.rateLimitResetMs } : {}),
					},
				),
			);
		}
	}

	/**
	 * Model output while the session is not streaming means the CLI went on without it
	 * (a tool call it answered itself, a timeout): its view of the conversation no longer
	 * matches the session's, so the process is dropped and the next request rebuilds it.
	 */
	private outputWhileNotStreaming(messageId: string | undefined): boolean {
		if (this.state === "streaming") return false;
		if (messageId !== undefined && messageId === this.awaiting?.messageId) return true;
		this.dispose();
		return true;
	}

	private apiMessage(id: string): ApiMessage {
		let message = this.apiMessages.find((candidate) => candidate.id === id);
		if (!message) {
			message = { id, streamed: [], frames: [], usage: emptyUsage(), stopped: false, orphaned: false };
			this.apiMessages.push(message);
		}
		return message;
	}

	/** A new message while another is still open replaces it: the CLI retried or fell back. */
	private orphanOpenMessage(except: string): void {
		const open = this.openMessage;
		if (!open || open.stopped || open.id === except) return;
		open.orphaned = true;
		this.openMessage = undefined;
		const output = this.output;
		if (output) output.content = output.content.filter((block) => !open.streamed.includes(block));
	}

	private onApiEvent(event: RawMessageStreamEvent): void {
		if (event.type === "message_start" && this.outputWhileNotStreaming(event.message.id)) return;
		if (event.type !== "message_start" && this.outputWhileNotStreaming(this.openMessage?.id)) return;
		const output = this.output;
		const stream = this.stream;
		if (!output || !stream) return;

		switch (event.type) {
			case "message_start": {
				this.orphanOpenMessage(event.message.id);
				const message = this.apiMessage(event.message.id);
				// A retry under the same id starts the message over.
				output.content = output.content.filter((block) => !message.streamed.includes(block));
				message.streamed = [];
				message.frames = [];
				message.stopped = false;
				message.orphaned = false;
				const usage = event.message.usage;
				message.usage = {
					...emptyUsage(),
					input: usage.input_tokens || 0,
					output: usage.output_tokens || 0,
					cacheRead: usage.cache_read_input_tokens || 0,
					cacheWrite: usage.cache_creation_input_tokens || 0,
				};
				output.responseId ??= message.id;
				this.openMessage = message;
				this.blockIndexes.clear();
				return;
			}
			case "content_block_start": {
				const message = this.openMessage;
				if (!message) return;
				const block = event.content_block;
				let created: StreamBlock | undefined;
				if (block.type === "text") {
					created = { type: "text", text: "" };
				} else if (block.type === "thinking") {
					created = { type: "thinking", thinking: "", thinkingSignature: "" };
				} else if (block.type === "redacted_thinking") {
					created = {
						type: "thinking",
						thinking: "[Reasoning redacted]",
						thinkingSignature: block.data,
						redacted: true,
					};
				} else if (block.type === "tool_use") {
					created = {
						type: "toolCall",
						id: block.id,
						name: fromClaudeCodeToolName(block.name),
						arguments: (block.input as Record<string, unknown>) ?? {},
						partialJson: "",
					};
				}
				if (!created) return;
				message.streamed.push(created);
				output.content.push(created);
				this.blockIndexes.set(event.index, created);
				const type =
					created.type === "text"
						? "text_start"
						: created.type === "thinking"
							? "thinking_start"
							: "toolcall_start";
				stream.push({ type, contentIndex: output.content.length - 1, partial: output });
				return;
			}
			case "content_block_delta": {
				const block = this.blockIndexes.get(event.index);
				if (!block) return;
				const contentIndex = output.content.indexOf(block);
				const delta = event.delta;
				if (delta.type === "text_delta" && block.type === "text") {
					block.text += delta.text;
					stream.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
				} else if (delta.type === "thinking_delta" && block.type === "thinking") {
					block.thinking += delta.thinking;
					stream.push({ type: "thinking_delta", contentIndex, delta: delta.thinking, partial: output });
				} else if (delta.type === "signature_delta" && block.type === "thinking") {
					block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
				} else if (delta.type === "input_json_delta" && block.type === "toolCall") {
					block.partialJson = (block.partialJson ?? "") + delta.partial_json;
					const parsed = updateThrottledStreamingJson(block, block.partialJson);
					if (parsed) block.arguments = parsed;
					stream.push({ type: "toolcall_delta", contentIndex, delta: delta.partial_json, partial: output });
				}
				return;
			}
			case "content_block_stop": {
				const block = this.blockIndexes.get(event.index);
				if (!block) return;
				const contentIndex = output.content.indexOf(block);
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
				} else if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
				} else {
					if (block.partialJson) block.arguments = parseStreamingJson(block.partialJson);
					delete block.partialJson;
					stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
				}
				return;
			}
			case "message_delta": {
				const message = this.openMessage;
				if (!message) return;
				if (event.delta.stop_reason) message.stopReason = event.delta.stop_reason;
				const usage = event.usage;
				if (usage.input_tokens != null && usage.input_tokens > 0) message.usage.input = usage.input_tokens;
				if (usage.output_tokens != null && usage.output_tokens > 0) message.usage.output = usage.output_tokens;
				if (usage.cache_read_input_tokens != null && usage.cache_read_input_tokens > 0) {
					message.usage.cacheRead = usage.cache_read_input_tokens;
				}
				if (usage.cache_creation_input_tokens != null && usage.cache_creation_input_tokens > 0) {
					message.usage.cacheWrite = usage.cache_creation_input_tokens;
				}
				return;
			}
			case "message_stop": {
				const message = this.openMessage;
				if (!message) return;
				message.stopped = true;
				this.openMessage = undefined;
				if (message.stopReason === "tool_use") this.finishWithToolCalls();
				return;
			}
		}
	}

	private onCommittedFrame(event: ClaudeCodeCliEvent): void {
		const id = event.message?.id;
		if (!id || this.outputWhileNotStreaming(id)) return;
		const output = this.output;
		const stream = this.stream;
		if (!output || !stream) return;
		if (Array.isArray(event.supersedes)) this.retractFrames(event.supersedes);
		const known = this.apiMessages.some((candidate) => candidate.id === id);
		if (!known) this.orphanOpenMessage(id);
		const message = this.apiMessage(id);
		const usage = event.message?.usage;
		if (usage && message.streamed.length === 0) {
			message.usage = {
				...emptyUsage(),
				input: usage.input_tokens ?? 0,
				output: usage.output_tokens ?? 0,
				cacheRead: usage.cache_read_input_tokens ?? 0,
				cacheWrite: usage.cache_creation_input_tokens ?? 0,
			};
		}
		for (const raw of event.message?.content ?? []) {
			const block = fromCommittedBlock(raw);
			if (!block) continue;
			message.frames.push({ uuid: event.uuid, block });
			if (message.streamed.length > 0 || message === this.openMessage) continue;
			// Never streamed (a non-streaming fallback): show it as it is committed.
			output.content.push(block);
			const contentIndex = output.content.length - 1;
			if (block.type === "text") {
				stream.push({ type: "text_start", contentIndex, partial: output });
				stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
				stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
			} else if (block.type === "thinking") {
				stream.push({ type: "thinking_start", contentIndex, partial: output });
				stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: output });
				stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
			} else {
				stream.push({ type: "toolcall_start", contentIndex, partial: output });
				stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
			}
		}
		if (this.unstreamedToolCallTimer) this.scheduleUnstreamedToolCallFinish();
	}

	private retractFrames(uuids: unknown[]): void {
		const retracted = new Set(uuids.filter((uuid): uuid is string => typeof uuid === "string"));
		if (retracted.size === 0) return;
		for (const message of this.apiMessages) {
			message.frames = message.frames.filter((frame) => !frame.uuid || !retracted.has(frame.uuid));
		}
	}

	/** Called by the tool server for every call it receives, before the call waits for its result. */
	private onToolCall(toolUseId: string): void {
		if (this.state === "closed") return;
		if (this.state === "idle") {
			this.dispose();
			return;
		}
		if (this.state === "awaitingTools") {
			if (!this.awaiting?.calls.some((call) => call.id === toolUseId)) this.dispose();
			return;
		}
		// Streaming: a call for a block the stream is showing is ended by its message_stop.
		const open = this.openMessage;
		if (open?.streamed.some((block) => block.type === "toolCall" && block.id === toolUseId)) return;
		this.scheduleUnstreamedToolCallFinish();
	}

	private scheduleUnstreamedToolCallFinish(): void {
		this.clearUnstreamedToolCallTimer();
		this.unstreamedToolCallTimer = setTimeout(() => {
			this.unstreamedToolCallTimer = undefined;
			if (this.state !== "streaming") return;
			// The CLI runs tool calls while the message is still streaming; a message that is
			// still open is ended by its own message_stop.
			if (this.openMessage && !this.openMessage.stopped) {
				this.scheduleUnstreamedToolCallFinish();
				return;
			}
			this.finishWithToolCalls();
		}, UNSTREAMED_TOOL_CALL_SETTLE_MS);
	}

	private clearUnstreamedToolCallTimer(): void {
		if (this.unstreamedToolCallTimer) clearTimeout(this.unstreamedToolCallTimer);
		this.unstreamedToolCallTimer = undefined;
	}

	/**
	 * Settle the turn's content on what the CLI committed: each surviving API message
	 * contributes its committed blocks, or its streamed ones when the stream finished it
	 * and nothing was committed. Input and cache counts come from the last message (each
	 * message's prompt contains the previous ones); output adds up.
	 */
	private reconcile(): ApiMessage | undefined {
		const output = this.output;
		if (!output) return undefined;
		const kept = this.apiMessages.filter(
			(message) => !message.orphaned && (message.frames.length > 0 || message.stopped),
		);
		const content: AssistantMessage["content"] = [];
		for (const message of kept) {
			if (message.frames.length > 0 && message.frames.length >= message.streamed.length) {
				content.push(...message.frames.map((frame) => frame.block));
			} else {
				for (const block of message.streamed) {
					if (block.type === "toolCall") delete block.partialJson;
					content.push(block);
				}
			}
		}
		output.content = content;
		const usage = emptyUsage();
		for (const message of kept) usage.output += message.usage.output;
		const last = kept[kept.length - 1];
		if (last) {
			usage.input = last.usage.input;
			usage.cacheRead = last.usage.cacheRead;
			usage.cacheWrite = last.usage.cacheWrite;
		}
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		output.usage = usage;
		calculateCost(this.model, usage);
		return last;
	}

	private messageToolCalls(message: ApiMessage | undefined): ToolCall[] {
		if (!message) return [];
		const blocks =
			message.frames.length > 0 && message.frames.length >= message.streamed.length
				? message.frames.map((frame) => frame.block)
				: message.streamed;
		return blocks.filter((block): block is ToolCall => block.type === "toolCall");
	}

	private finishWithToolCalls(): void {
		this.clearUnstreamedToolCallTimer();
		const output = this.output;
		const stream = this.stream;
		if (!output || !stream) return;
		const last = this.reconcile();
		const calls = this.messageToolCalls(last);
		if (!last || calls.length === 0 || !this.toolServer) {
			this.fail(new Error("Claude Code called a tool that does not appear in the conversation it reported."));
			return;
		}
		output.stopReason = "toolUse";
		const responseId = output.responseId ?? last.id;
		output.responseId = responseId;
		this.toolServer.expect(calls);
		this.awaiting = { assistantIndex: this.requestLength, responseId, messageId: last.id, calls };
		this.state = "awaitingTools";
		this.setKeepAlive(false);
		this.endStream();
		stream.push({ type: "done", reason: "toolUse", message: output });
		stream.end();
		// A session another request took over will not be asked for these results.
		if (sessions.get(this.key) !== this) this.dispose();
	}

	private onResult(event: ClaudeCodeCliEvent): void {
		const output = this.output;
		const stream = this.stream;
		if (!output || !stream) {
			this.dispose();
			return;
		}
		if (event.is_error || event.subtype !== "success") {
			const detail =
				typeof event.result === "string" && event.result.length > 0
					? event.result
					: Array.isArray(event.errors) && event.errors.length > 0
						? event.errors.map(String).join("; ")
						: `turn ended with ${event.subtype ?? "an error"}`;
			this.fail(claudeCodeFailure(detail, this.rateLimitResetMs));
			return;
		}
		this.clearUnstreamedToolCallTimer();
		const last = this.reconcile();
		const stopReason = mapStopReason(last?.stopReason);
		if (stopReason === "error") {
			this.fail(streamFailureFromStopReason(last?.stopReason ?? undefined));
			return;
		}
		output.stopReason = stopReason === "toolUse" ? "stop" : stopReason;
		const responseId = output.responseId ?? last?.id;
		output.responseId = responseId;
		const keep = this.hasTools && responseId !== undefined && last !== undefined && sessions.get(this.key) === this;
		if (keep) {
			this.awaiting = { assistantIndex: this.requestLength, responseId, messageId: last.id, calls: [] };
			this.state = "idle";
			this.setKeepAlive(false);
		}
		this.endStream();
		stream.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output });
		stream.end();
		// Side requests (no tools) and superseded sessions have no next message to wait for.
		if (!keep) this.dispose();
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.state === "closed") return;
		if (this.stream && this.retryWithoutThinkingDisplay()) return;
		if (this.stream) {
			const stderr = this.stderrTail.trim();
			const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
			this.fail(claudeCodeFailure(`the CLI ${how} before the turn finished${stderr ? `: ${stderr}` : ""}`));
			return;
		}
		this.dispose();
	}

	private endStream(): void {
		this.detachSignal();
		this.stream = undefined;
	}

	/** Ends the live stream with an error; the session itself is left to the caller. */
	private pushFailure(error: unknown): void {
		const output = this.output;
		const stream = this.stream;
		if (!output || !stream) return;
		this.clearUnstreamedToolCallTimer();
		finalizeThrottledStreamingJson(output.content);
		for (const block of output.content) delete (block as { partialJson?: string }).partialJson;
		output.stopReason = this.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatStreamFailureMessage(error);
		recordStreamFailure(this.model, output, error);
		this.endStream();
		stream.push({ type: "error", reason: output.stopReason, error: output });
		stream.end();
	}

	private fail(error: unknown): void {
		this.pushFailure(error);
		this.dispose();
	}
}

export const streamClaudeCode: StreamFunction<"claude-code", ClaudeCodeOptions> = (
	model: Model<"claude-code">,
	context: Context,
	options?: ClaudeCodeOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	ensureSweep();
	evictSessions(Date.now());
	const key = sessionKey(model, context, options);
	const existing = sessions.get(key);
	if (existing?.canContinue(context)) {
		existing.continueTurn(context, stream, options);
		return stream;
	}
	// A turn still streaming under the same key (two concurrent side requests) keeps
	// running; it leaves the registry to the new session and ends itself when done.
	if (existing && !existing.isStreaming()) existing.dispose();
	const session = new ClaudeCodeSession(key, model);
	sessions.set(key, session);
	void session.start(context, stream, options);
	return stream;
};

function mapThinkingLevelToEffort(
	model: Model<"claude-code">,
	level: SimpleStreamOptions["reasoning"],
): ClaudeCodeEffort | undefined {
	if (!level) return undefined;
	const effective = clampThinkingLevel(model, level);
	const mapped = model.thinkingLevelMap?.[effective];
	if (typeof mapped === "string") return mapped as ClaudeCodeEffort;
	switch (effective) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "xhigh":
			return "xhigh";
		case "max":
			return "max";
		default:
			return "high";
	}
}

export const streamSimpleClaudeCode: StreamFunction<"claude-code", SimpleStreamOptions> = (
	model: Model<"claude-code">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = buildBaseOptions(model, options);
	return streamClaudeCode(model, context, { ...base, effort: mapThinkingLevelToEffort(model, options?.reasoning) });
};
