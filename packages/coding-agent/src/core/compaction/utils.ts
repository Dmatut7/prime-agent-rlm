/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getLogger } from "@earendil-works/pi-ai";
import {
	findMachineBlock,
	type MachineBlockTag,
	parseBlockLines,
	readsAsBlockDelimiter,
	renderMachineBlock,
} from "./machine-blocks.js";

const compactionLog = getLogger("coding-agent.compaction");
export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/** Argument keys that carry a target file path in write-style tools. */
const PATH_ARG_KEYS = ["path", "file_path", "filePath"] as const;

/** Tool names whose calls modify a file at a known path. */
const WRITING_TOOL_PATTERN = /^(?:edit|write|apply_patch|patch|str_replace)$/;

function getToolCallPath(args: Record<string, unknown>): string | undefined {
	for (const key of PATH_ARG_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * Extract file operations from tool calls in an assistant message.
 *
 * Only statically recognizable writes are recorded: tools whose name indicates a
 * file modification and that expose a path-like argument (including write-style
 * extension tools). File changes made inside bash or ipython cells (redirections,
 * open(..., "w"), notebook edits) cannot be attributed statically and are
 * deliberately not tracked; <modified-files> is best-effort for those tools.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = getToolCallPath(args);
		if (!path) continue;

		if (WRITING_TOOL_PATTERN.test(block.name)) {
			if (block.name === "write") {
				fileOps.written.add(path);
			} else {
				fileOps.edited.add(path);
			}
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 *
 * Both lists go through renderMachineBlock like the other two blocks, so all four
 * share one delimiter shape and one guard.
 *
 * The file lists are the one channel that is not JSON, so a payload here cannot be
 * escaped the way the JSON lines are: `<` -> `\u003c` is unambiguous only when a JSON
 * layer has already doubled every backslash, and inventing the same escape for plain
 * lines would make an existing path that contains the literal `\u003c` ambiguous
 * (turning "escape it" into "sometimes restore it"). A revertible line codec that also
 * escapes the backslash as well would round-trip, but at the cost of the one property
 * an older build reading a newer block. So the guard is at render time instead of on
 * the parse side: a line that would read back as a block delimiter is left out of the
 * rendered list and reported, and the parse side never has to guess what a line meant.
 *
 * The cost is bounded on purpose. `details.readFiles`/`details.modifiedFiles` carry the
 * same paths structurally and are the primary carry-forward for the next generation, so
 * what this drops is only the rendered copy - and only for entries that are either a
 * forged delimiter or a path that is not really a path (a newline inside one).
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	for (const [tag, entries] of [
		["read-files", readFiles],
		["modified-files", modifiedFiles],
	] as const) {
		const body = renderListBody(entries, tag);
		if (body.length > 0) sections.push(renderMachineBlock(tag, {}, body));
	}
	return sections.join("");
}

/** The lines of one list block, minus the entries the block cannot carry verbatim. */
function renderListBody(entries: readonly string[], tag: MachineBlockTag): string {
	const kept = entries.filter((entry) => {
		// A newline smuggles extra lines; `</` anywhere and a delimiter shape are the two
		// spellings of "this line is not a path, it is markup". Either way the rendered block
		// would claim a list the next parse cannot recover.
		if (!/[\r\n]/.test(entry) && !entry.includes("</") && !readsAsBlockDelimiter(entry)) return true;
		compactionLog.warn(
			"a tracked path reads as a machine-block delimiter; it is left out of the rendered file list (entry details still carry it)",
			{ entry, tag },
		);
		return false;
	});
	return kept.join("\n");
}

/**
 * Recover the file lists a previous summary carries in its rendered blocks.
 *
 * formatFileOperations output is machine-generated and re-emitted every generation,
 * so the blocks are stripped before a summary goes back to the summarizer. Entries
 * recorded before details carried the lists would lose them at that point; reading
 * them back out of the rendered blocks keeps the union of what either source knows.
 */
export function extractFileOpsFromSummary(summary: string, fileOps: FileOperations): void {
	const read = findMachineBlock(summary, "read-files");
	if (read) {
		for (const line of parseBlockLines(read.body)) fileOps.read.add(line);
	}
	const modified = findMachineBlock(summary, "modified-files");
	if (modified) {
		for (const line of parseBlockLines(modified.body)) fileOps.edited.add(line);
	}
}
/** Characters kept from the start of a tool result in serialized summaries. */
export const TOOL_RESULT_HEAD_CHARS = 2000;

/**
 * Characters kept from the end of a tool result.
 *
 * The tail is where the verdict of a tool run lives: a test runner prints its
 * failure list last, a build prints the error that stopped it last, a stack trace
 * puts the innermost frame last. Head-only truncation discarded all of it - on one
 * measured session 183 facts existed only past the 2000-character cut, across 62
 * results whose dropped tails totalled 80k characters.
 */
export const TOOL_RESULT_TAIL_CHARS = 500;

/**
 * Truncate text for summarization by dropping its middle.
 *
 * Keeps the head (what the call was and how it started) and the tail (how it ended),
 * and says how much went so a reader can tell an excerpt from a complete result.
 */
function truncateForSummary(text: string, headChars: number, tailChars: number): string {
	if (text.length <= headChars + tailChars) return text;
	const truncatedChars = text.length - headChars - tailChars;
	const head = text.slice(0, headChars);
	const tail = text.slice(text.length - tailChars);
	return `${head}\n\n[... ${truncatedChars} characters truncated ...]\n\n${tail}`;
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
