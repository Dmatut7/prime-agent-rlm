import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_CUSTOM_TYPE } from "../src/core/agent-messages.js";
import {
	budgetSummarizationInput,
	buildCompactionAppendix,
	collectUserRequests,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "../src/core/compaction/index.js";
import {
	convertToLlm,
	createCompactionSummaryMessage,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
} from "../src/core/messages.js";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return { ...actual, completeSimple: completeSimpleMock };
});

/** The task brief an RLM subagent receives: verbatim, the orchestrator's own words. */
const TASK_BRIEF = `仓库 /tmp/audit-target，冻结 SHA 438d33383605。任务：核对压缩保真，产出 /tmp/report.md，45 分钟收口，禁止 force push。`;
const TASK_BRIEF_ANCHOR = "冻结 SHA 438d33383605。任务：核对压缩保真";

function usage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(contextWindow = 30000): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 8192,
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AssistantMessage as AgentMessage;
}

function toolResultMessage(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

/** A custom agent_message: how a parent's task brief reaches an RLM subagent. */
function agentMessageBrief(brief: string): AgentMessage {
	return {
		role: "custom",
		customType: AGENT_MESSAGE_CUSTOM_TYPE,
		content: `[from parent]\nAgent-to-agent message received.\nSource: agent_message\n\n${brief}`,
		display: true,
		details: {
			id: "msg-1",
			message: brief,
			fromRelationship: "parent",
			target: { activeSessionId: "child", sessionId: "child" },
		},
		timestamp: Date.now(),
	} as AgentMessage;
}

let entryCounter = 0;
let lastId: string | null = null;

beforeEach(() => {
	entryCounter = 0;
	lastId = null;
	completeSimpleMock.mockReset();
	completeSimpleMock.mockImplementation(async () => ({
		role: "assistant",
		content: [{ type: "text", text: "## Goal\nan honest narrative" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	}));
});

function messageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `entry-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function customMessageEntry(customType: string, content: string, details: unknown): CustomMessageEntry {
	const id = `entry-${entryCounter++}`;
	const entry: CustomMessageEntry = {
		type: "custom_message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		customType,
		content,
		display: true,
		details,
	};
	lastId = id;
	return entry;
}

/** A single-turn RLM subagent session: brief at the head, then one long turn. */
function rlmSessionEntries(brief: string, fillerTurns = 6): SessionEntry[] {
	const entries: SessionEntry[] = [
		// Real agent_message entries carry the full wrapped prompt as content, with
		// the sender's own words verbatim inside it and in details.message.
		customMessageEntry(
			AGENT_MESSAGE_CUSTOM_TYPE,
			`[from parent]\nAgent-to-agent message received.\nSource: agent_message\n\n${brief}`,
			{
				id: "msg-1",
				message: brief,
				fromRelationship: "parent",
			},
		),
	];
	for (let i = 0; i < fillerTurns; i++) {
		entries.push(messageEntry(assistantMessage(`work block ${i}: ${"x".repeat(12000)}`)));
		entries.push(messageEntry(toolResultMessage(`result ${i}: ${"y".repeat(9000)}`)));
	}
	return entries;
}

/** Flatten LLM messages to their text, typed for the mixed content shapes. */
function renderedText(messages: ReturnType<typeof convertToLlm>): string {
	return messages
		.map((message) => {
			const content = message.content as string | Array<{ type: string; text?: string }>;
			if (typeof content === "string") return content;
			return content
				.filter(
					(block): block is { type: "text"; text: string } =>
						block.type === "text" && typeof block.text === "string",
				)
				.map((block) => block.text)
				.join("\n");
		})
		.join("\n");
}

function sentPrompts(): string[] {
	return completeSimpleMock.mock.calls.map((call: unknown[]) => {
		const request = call[1] as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
		return request.messages
			.flatMap((message) => message.content)
			.filter((block): block is { type: string; text: string } => typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
	});
}

/** Small retained window so the cut separates the brief's turn from a big retained tail. */
const settings = (): typeof DEFAULT_COMPACTION_SETTINGS => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 2000 });

describe("CF-1: the task brief survives compaction in every channel", () => {
	it("collects an agent_message task brief into the verbatim user-request ledger", () => {
		const records = collectUserRequests([agentMessageBrief(TASK_BRIEF), assistantMessage("work")], 1);
		expect(records.some((record) => record.text.includes(TASK_BRIEF_ANCHOR))).toBe(true);
	});

	it("collects a heartbeat prompt as user words, and skips pure machine receipts", () => {
		const heartbeat = {
			role: "custom",
			customType: HEARTBEAT_PROMPT_CUSTOM_TYPE,
			content: "check the build every morning and report failures",
			display: true,
			timestamp: Date.now(),
		} as AgentMessage;
		const childFailure = {
			role: "custom",
			customType: RLM_CHILD_FAILURE_CUSTOM_TYPE,
			content: "RLM child api-reviewer failed: stall",
			display: true,
			timestamp: Date.now(),
		} as AgentMessage;
		const records = collectUserRequests([heartbeat, childFailure], 1);
		expect(records.some((record) => record.text.includes("check the build every morning"))).toBe(true);
		expect(records.some((record) => record.text.includes("api-reviewer failed"))).toBe(false);
	});

	it("pins the first user-intent message when head elision would drop it", () => {
		const messages = [
			agentMessageBrief(TASK_BRIEF),
			assistantMessage(`filler ${"x".repeat(12000)}`),
			toolResultMessage(`out ${"y".repeat(9000)}`),
			userMessage("recent question"),
		];
		// Budget that fits only the newest two messages.
		const { messages: kept, elided } = budgetSummarizationInput(messages, 4000);
		expect(elided).toBeGreaterThan(0);
		expect(
			kept.some((message) => message.role === "custom" && message.customType === AGENT_MESSAGE_CUSTOM_TYPE),
		).toBe(true);
		expect(kept[kept.length - 1]).toBe(messages[messages.length - 1]);
	});

	it("keeps the first user-intent message in front of the newest message order", () => {
		const brief = agentMessageBrief(TASK_BRIEF);
		const messages = [brief, assistantMessage("z".repeat(30000)), userMessage("recent question")];
		const { messages: kept } = budgetSummarizationInput(messages, 6000);
		expect(kept[0]).toBe(brief);
		expect(kept[kept.length - 1]).toBe(messages[messages.length - 1]);
	});

	it("harvests the brief into the appendix ledger even for a single-turn session", () => {
		const entries = [
			...rlmSessionEntries(TASK_BRIEF),
			messageEntry(userMessage("next turn after the brief's turn")),
			messageEntry(assistantMessage("t".repeat(12000))),
		];
		const preparation = prepareCompaction(entries, settings(), 30000);
		expect(preparation).toBeDefined();
		const appendix = buildCompactionAppendix(preparation!);
		expect(appendix.userRequests.records.some((record) => record.text.includes(TASK_BRIEF_ANCHOR))).toBe(true);
	});

	it("still summarizes the brief verbatim when the window pressure elides the head", async () => {
		const entries = [
			...rlmSessionEntries(TASK_BRIEF),
			messageEntry(userMessage("next turn after the brief's turn")),
			messageEntry(assistantMessage("t".repeat(12000))),
		];
		const preparation = prepareCompaction(entries, settings(), 30000);
		expect(preparation).toBeDefined();
		await compact(preparation!, createModel(30000), "test-key");
		const prompts = sentPrompts().join("\n");
		expect(prompts).toContain(TASK_BRIEF_ANCHOR);
	});
});

describe("CF-2: the post-compaction context discloses its own elision", () => {
	it("carries an elision disclosure with a machine-readable count after a pressured compaction", async () => {
		const entries = [
			...rlmSessionEntries(TASK_BRIEF, 8),
			messageEntry(userMessage("next turn after the brief's turn")),
			messageEntry(assistantMessage("t".repeat(12000))),
		];
		const preparation = prepareCompaction(entries, settings(), 30000);
		expect(preparation).toBeDefined();
		const result = await compact(preparation!, createModel(30000), "test-key");
		const rendered = convertToLlm([
			createCompactionSummaryMessage(result.summary, result.tokensBefore, new Date().toISOString()),
		]);
		const text = renderedText(rendered);
		expect(text).toMatch(/elis/i);
		expect(text).toMatch(/messages="[1-9]\d*"/);
	});

	it("tells the continuation that the summary may be incomplete and defers to persistent records", () => {
		const rendered = convertToLlm([
			createCompactionSummaryMessage("## Goal\nnarrative", 100000, new Date().toISOString()),
		]);
		const text = renderedText(rendered);
		expect(text).toMatch(/may be incomplete/i);
		expect(text.toLowerCase()).toContain("persistent record");
	});

	it("renders no elision count when the summarizer saw the whole slice", () => {
		const rendered = convertToLlm([
			createCompactionSummaryMessage("## Goal\nnarrative", 100000, new Date().toISOString()),
		]);
		const text = renderedText(rendered);
		expect(text).not.toMatch(/messages="[1-9]\d*"/);
	});
});
