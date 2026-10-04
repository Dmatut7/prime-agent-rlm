import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Model, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { transformMessages } from "../../../ai/src/providers/transform-messages.js";
import { convertToLlm, isModelChangeMessage } from "../../src/core/messages.js";
import { SessionManager } from "../../src/core/session-manager.js";

/**
 * Review fixup 2026-10-04 item 1: a model switch recorded mid-tool-batch lands
 * between the assistant's tool calls and their results in the session file (the
 * fallback episode switches at tool_execution_end, which precedes the toolResult
 * messages). On rebuild the synthesized model-change notice must move behind the
 * batch's tool results; left in place it becomes a user-role message that splits
 * the batch, and transformMessages then replaces the real results with synthetic
 * "No result provided" errors. The test walks the full rebuild path: session
 * file -> buildSessionContext -> convertToLlm -> transformMessages.
 */

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const servingModel: Model<"anthropic-messages"> = {
	id: "claude-new",
	name: "New",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function assistantWithToolCall(modelId: string, toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "reading the file" },
			{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "a.ts" } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: modelId,
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-model-change-batch-"));
	tempDirs.push(dir);
	return dir;
}

describe("model_change recorded mid-tool-batch", () => {
	it("rebuilds the switch notice behind the batch's tool results, keeping the real result", () => {
		const dir = tempDir();
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		manager.appendModelChange("anthropic", "claude-old");
		manager.appendMessage({ role: "user", content: "look at a.ts", timestamp: Date.now() });
		manager.appendMessage(assistantWithToolCall("claude-old", "call-1"));
		// The fallback episode records the switch at tool_execution_end - before the
		// batch's toolResult messages are appended.
		manager.appendModelChange("anthropic", "claude-new");
		manager.appendMessage(toolResult("call-1", "real file contents"));

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		// The rebuild path: reopen the file, rebuild the context, render for the provider.
		const reopened = SessionManager.open(sessionFile!, join(dir, "sessions"), dir);
		const rebuilt = reopened.buildSessionContext().messages;

		const noticeIndex = rebuilt.findIndex((message) => isModelChangeMessage(message));
		const resultIndex = rebuilt.findIndex((message) => message.role === "toolResult");
		expect(noticeIndex).toBeGreaterThanOrEqual(0);
		expect(resultIndex).toBeGreaterThanOrEqual(0);
		expect(noticeIndex).toBeGreaterThan(resultIndex);

		const llmMessages = transformMessages(convertToLlm(rebuilt), servingModel);
		const results = llmMessages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect((results[0] as ToolResultMessage).content).toEqual([{ type: "text", text: "real file contents" }]);
		const synthesized = llmMessages.filter(
			(message) =>
				message.role === "toolResult" &&
				message.content.some((block) => block.type === "text" && block.text === "No result provided"),
		);
		expect(synthesized).toHaveLength(0);
	});

	it("flushes the held notice ahead of the next content when the batch never closes", () => {
		const dir = tempDir();
		const manager = SessionManager.create(dir, join(dir, "sessions"));
		manager.appendModelChange("anthropic", "claude-old");
		manager.appendMessage({ role: "user", content: "look at a.ts", timestamp: Date.now() });
		manager.appendMessage(assistantWithToolCall("claude-old", "call-1"));
		manager.appendModelChange("anthropic", "claude-new");
		// The session crashed before the tool result landed; the next entry is a user prompt.
		manager.appendMessage({ role: "user", content: "what happened?", timestamp: Date.now() });

		const reopened = SessionManager.open(manager.getSessionFile()!, join(dir, "sessions"), dir);
		const rebuilt = reopened.buildSessionContext().messages;
		const noticeIndex = rebuilt.findIndex((message) => isModelChangeMessage(message));
		expect(noticeIndex).toBeGreaterThanOrEqual(0);
		// The notice is not lost; the pairing pass still synthesizes the missing result.
		const llmMessages = transformMessages(convertToLlm(rebuilt), servingModel);
		const results = llmMessages.filter((message) => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect((results[0] as ToolResultMessage).isError).toBe(true);
	});

	it("seeds the post-compaction switch comparison from before firstKeptEntryId, not the compaction point", () => {
		const manager = SessionManager.inMemory();
		manager.appendModelChange("anthropic", "claude-old");
		manager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
		manager.appendMessage(assistantWithToolCallText("claude-old", "old model answer"));
		// The switch lives INSIDE the retained window: the kept region starts at the
		// user message ahead of it, so the window holds model_change + the answer the
		// new model produced.
		const keptId = manager.appendMessage({ role: "user", content: "more", timestamp: Date.now() });
		manager.appendModelChange("anthropic", "claude-new");
		manager.appendMessage(assistantWithToolCallText("claude-new", "new model answer"));
		manager.appendCompaction("summary", keptId, 4200);
		manager.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });

		const rebuilt = manager.buildSessionContext().messages;
		const notices = rebuilt.filter((message) => isModelChangeMessage(message));
		expect(notices).toHaveLength(1);
		// The old model's answer is summarized away; the notice stands between the
		// summary and the answer the new model produced inside the retained window.
		const noticeIndex = rebuilt.indexOf(notices[0]!);
		const summaryIndex = rebuilt.findIndex((message) => message.role === "compactionSummary");
		const newAnswer = rebuilt.findIndex(
			(message) => message.role === "assistant" && (message as AssistantMessage).model === "claude-new",
		);
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		expect(newAnswer).toBeGreaterThanOrEqual(0);
		expect(noticeIndex).toBeGreaterThan(summaryIndex);
		expect(noticeIndex).toBeLessThan(newAnswer);
	});
});

function assistantWithToolCallText(modelId: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: modelId,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
