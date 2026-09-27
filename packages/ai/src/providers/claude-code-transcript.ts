import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { ImageContent, Message, Model, TextContent, ToolResultMessage } from "../types.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { transformMessages } from "./transform-messages.js";

/**
 * Conversion between a session's messages and the Claude Code CLI's view of them.
 *
 * Claude Code only takes a conversation's history from a transcript file it resumes,
 * and it only starts a model turn from a fresh user message on stdin. The session's
 * messages are therefore split into the history written as that transcript and the
 * prompt sent to start the turn.
 */

/** MCP server name the session's tools are served under; Claude Code prefixes tool names with it. */
export const CLAUDE_CODE_TOOL_SERVER_NAME = "prime";
const TOOL_NAME_PREFIX = `mcp__${CLAUDE_CODE_TOOL_SERVER_NAME}__`;

export function toClaudeCodeToolName(name: string): string {
	return `${TOOL_NAME_PREFIX}${name}`;
}

export function fromClaudeCodeToolName(name: string): string {
	return name.startsWith(TOOL_NAME_PREFIX) ? name.slice(TOOL_NAME_PREFIX.length) : name;
}

/**
 * Sent when the history ends in tool results instead of a user message (the CLI
 * stopped mid-turn: an interruption, a restart, a model switch). Claude Code needs a
 * user message to start a turn, and without a reason the model would treat it as a
 * new request rather than a cue to carry on with the results it already has.
 */
export const CLAUDE_CODE_RESUME_NOTE =
	"(The session was resumed after an interruption. The tool results above are the latest state of the work; continue the task from there.)";

export interface ClaudeCodeTurn {
	/** Messages written to the transcript Claude Code resumes. Empty for a first turn. */
	history: MessageParam[];
	/** Content of the user message that starts the turn. */
	prompt: ContentBlockParam[];
}

type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertUserContent(content: (TextContent | ImageContent)[]): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];
	for (const item of content) {
		if (item.type === "text") {
			if (item.text.trim().length > 0) blocks.push({ type: "text", text: sanitizeSurrogates(item.text) });
		} else {
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: item.mimeType as ImageMediaType, data: item.data },
			});
		}
	}
	return blocks;
}

function convertToolResult(message: ToolResultMessage): ContentBlockParam {
	const hasImages = message.content.some((item) => item.type === "image");
	const content = hasImages
		? convertUserContent(message.content).filter(
				(block): block is Extract<ContentBlockParam, { type: "text" | "image" }> =>
					block.type === "text" || block.type === "image",
			)
		: sanitizeSurrogates(message.content.map((item) => (item as TextContent).text).join("\n"));
	return { type: "tool_result", tool_use_id: message.toolCallId, content, is_error: message.isError };
}

/** Convert session messages to Anthropic messages with the tool names Claude Code uses. */
export function toClaudeCodeMessages(messages: Message[], model: Model<"claude-code">): MessageParam[] {
	const params: MessageParam[] = [];
	const transformed = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformed.length; i++) {
		const message = transformed[i];
		if (message.role === "user") {
			const blocks =
				typeof message.content === "string"
					? convertUserContent([{ type: "text", text: message.content }])
					: convertUserContent(message.content);
			if (blocks.length > 0) params.push({ role: "user", content: blocks });
		} else if (message.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			for (const block of message.content) {
				if (block.type === "text") {
					if (block.text.trim().length > 0) blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking") {
					if (block.redacted) {
						if (block.thinkingSignature)
							blocks.push({ type: "redacted_thinking", data: block.thinkingSignature });
						continue;
					}
					const thinking = sanitizeSurrogates(block.thinking);
					// A signature is bound to the exact text (possibly empty when the thinking was
					// omitted); without one, or after sanitizing, the block can only travel as text.
					if (block.thinkingSignature && thinking === block.thinking) {
						blocks.push({ type: "thinking", thinking, signature: block.thinkingSignature });
					} else if (thinking.trim().length > 0) {
						blocks.push({ type: "text", text: thinking });
					}
				} else {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: toClaudeCodeToolName(block.name),
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length > 0) params.push({ role: "assistant", content: blocks });
		} else {
			const results: ContentBlockParam[] = [convertToolResult(message)];
			while (i + 1 < transformed.length && transformed[i + 1].role === "toolResult") {
				i++;
				results.push(convertToolResult(transformed[i] as ToolResultMessage));
			}
			params.push({ role: "user", content: results });
		}
	}
	return params;
}

function isUserPrompt(message: MessageParam): boolean {
	return (
		message.role === "user" &&
		Array.isArray(message.content) &&
		message.content.every((block) => block.type === "text" || block.type === "image")
	);
}

/** Split converted messages into the resumed history and the prompt that starts the turn. */
export function planClaudeCodeTurn(params: MessageParam[]): ClaudeCodeTurn {
	const last = params[params.length - 1];
	if (last && isUserPrompt(last)) {
		return { history: params.slice(0, -1), prompt: last.content as ContentBlockParam[] };
	}
	return { history: params, prompt: [{ type: "text", text: CLAUDE_CODE_RESUME_NOTE }] };
}

export interface ClaudeCodeTranscriptOptions {
	sessionId: string;
	cwd: string;
	model: string;
	newId: () => string;
	now?: Date;
}

/**
 * Serialize history as a Claude Code transcript (JSONL, one entry per message, each
 * linked to its parent). These are the fields Claude Code reads on resume; the rest of
 * what it records for its own sessions (attachments, costs, UI state) is optional.
 */
export function buildClaudeCodeTranscript(history: MessageParam[], options: ClaudeCodeTranscriptOptions): string {
	const timestamp = (options.now ?? new Date()).toISOString();
	let parentUuid: string | null = null;
	const lines: string[] = [];
	for (const message of history) {
		const uuid = options.newId();
		const base = {
			parentUuid,
			isSidechain: false,
			type: message.role,
			uuid,
			timestamp,
			sessionId: options.sessionId,
			cwd: options.cwd,
			userType: "external",
		};
		if (message.role === "user") {
			lines.push(JSON.stringify({ ...base, message: { role: "user", content: message.content } }));
		} else {
			const content =
				typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
			const stopReason = content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
			lines.push(
				JSON.stringify({
					...base,
					message: {
						id: `msg_${uuid.replace(/-/g, "")}`,
						type: "message",
						role: "assistant",
						model: options.model,
						content,
						stop_reason: stopReason,
						stop_sequence: null,
						usage: { input_tokens: 0, output_tokens: 0 },
					},
				}),
			);
		}
		parentUuid = uuid;
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
