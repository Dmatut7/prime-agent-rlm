import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	type CompactionSettings,
	capKeepRecentTokens,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/index.js";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

const PRIOR_SUMMARY = "## Goal\nShip the release checklist\n\n## Critical Context\nvault path /srv/releases";
const TURN_PREFIX_PROMPT_MARKER = "PREFIX of a turn";

function createModel(contextWindow: number): Model<"anthropic-messages"> {
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

function createUsage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createResponse(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface SummarizationRequest {
	messages: Array<{ content: Array<{ type: string; text?: string }> }>;
}

function requestPrompt(request: unknown): string {
	const typed = request as SummarizationRequest;
	return typed.messages
		.flatMap((message) => message.content)
		.filter((block): block is { type: string; text: string } => typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function sentPrompts(): string[] {
	return completeSimpleMock.mock.calls.map((call: unknown[]) => requestPrompt(call[1]));
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage: Usage = createUsage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
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

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `entry-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

/** One long turn: `padding` chars per assistant message, ~padding/4 tokens. */
function filler(padding: number, marker: string): string {
	return `${marker} ${"x".repeat(padding)}`;
}

beforeEach(() => {
	entryCounter = 0;
	lastId = null;
	completeSimpleMock.mockReset();
	completeSimpleMock.mockImplementation(async (_model: unknown, request: unknown) => {
		const prompt = requestPrompt(request);
		return createResponse(prompt.includes(TURN_PREFIX_PROMPT_MARKER) ? "TURN PREFIX SUMMARY" : "HISTORY SUMMARY");
	});
});

describe("split-turn compaction with a previous summary", () => {
	/**
	 * A single turn that outgrows the keep-recent window: the cut lands mid-turn
	 * and the turn start is the previous compaction's first kept entry, so there is
	 * no separate history slice to summarize.
	 */
	function longSingleTurnAfterCompaction(): { entries: SessionEntry[]; turnStart: SessionEntry } {
		const u1 = createMessageEntry(createUserMessage("earlier request"));
		const a1 = createMessageEntry(createAssistantMessage("earlier answer"));
		const u2 = createMessageEntry(createUserMessage("run the whole migration"));
		const compaction = createCompactionEntry(PRIOR_SUMMARY, u2.id);
		const a2 = createMessageEntry(createAssistantMessage(filler(4000, "step one")));
		const a3 = createMessageEntry(createAssistantMessage(filler(4000, "step two")));
		const a4 = createMessageEntry(createAssistantMessage(filler(4000, "step three")));
		return { entries: [u1, a1, u2, compaction, a2, a3, a4], turnStart: u2 };
	}

	it("carries the previous summary into the new compaction summary", async () => {
		const { entries, turnStart } = longSingleTurnAfterCompaction();
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1500 };

		const preparation = prepareCompaction(entries, settings, 200000);
		expect(preparation).toBeDefined();
		expect(preparation!.isSplitTurn).toBe(true);
		expect(preparation!.messagesToSummarize).toHaveLength(0);
		expect(preparation!.previousSummary).toBe(PRIOR_SUMMARY);
		expect(preparation!.firstKeptEntryId).not.toBe(turnStart.id);

		const result = await compact(preparation!, createModel(200000), "test-key");

		expect(result.summary).toContain("Ship the release checklist");
		expect(result.summary).toContain("vault path /srv/releases");
		expect(result.summary).toContain("TURN PREFIX SUMMARY");
		expect(result.summary).not.toContain("No prior history.");
		// Only the turn prefix needs a wire call; the history slice is carried forward.
		expect(sentPrompts()).toHaveLength(1);
		expect(sentPrompts()[0]).toContain(TURN_PREFIX_PROMPT_MARKER);
	});

	it("keeps the placeholder when there is no previous summary", async () => {
		const u1 = createMessageEntry(createUserMessage("run the whole migration"));
		const a1 = createMessageEntry(createAssistantMessage(filler(4000, "step one")));
		const a2 = createMessageEntry(createAssistantMessage(filler(4000, "step two")));
		const a3 = createMessageEntry(createAssistantMessage(filler(4000, "step three")));
		const entries = [u1, a1, a2, a3];
		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1500 };

		const preparation = prepareCompaction(entries, settings, 200000);
		expect(preparation).toBeDefined();
		expect(preparation!.isSplitTurn).toBe(true);
		expect(preparation!.messagesToSummarize).toHaveLength(0);
		expect(preparation!.previousSummary).toBeUndefined();

		const result = await compact(preparation!, createModel(200000), "test-key");

		expect(result.summary).toContain("No prior history.");
		expect(result.summary).toContain("TURN PREFIX SUMMARY");
	});
});

describe("turn prefix summarization input budget", () => {
	function splitTurnPreparation(turnPrefixMessages: AgentMessage[], reserveTokens: number): CompactionPreparation {
		return {
			firstKeptEntryId: "kept-entry",
			messagesToSummarize: [],
			turnPrefixMessages,
			isSplitTurn: true,
			tokensBefore: 1000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens },
		};
	}

	it("elides the oldest prefix messages when they exceed the model window", async () => {
		const prefix = [
			createUserMessage(filler(4000, "PREFIX-OLDEST")),
			createUserMessage(filler(2000, "PREFIX-MIDDLE")),
			createUserMessage("PREFIX-NEWEST"),
		];
		// contextWindow 1000 - reserveTokens 200 leaves an 800 token input budget.
		const preparation = splitTurnPreparation(prefix, 200);

		const result = await compact(preparation, createModel(1000), "test-key");

		expect(result.summary).toContain("TURN PREFIX SUMMARY");
		const prompts = sentPrompts();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("PREFIX-NEWEST");
		expect(prompts[0]).toContain("PREFIX-MIDDLE");
		expect(prompts[0]).not.toContain("PREFIX-OLDEST");
		expect(prompts[0]).toContain("1 older message(s) were elided");
	});

	it("keeps the whole prefix when it fits the model window", async () => {
		const prefix = [
			createUserMessage(filler(4000, "PREFIX-OLDEST")),
			createUserMessage(filler(2000, "PREFIX-MIDDLE")),
			createUserMessage("PREFIX-NEWEST"),
		];
		const preparation = splitTurnPreparation(prefix, DEFAULT_COMPACTION_SETTINGS.reserveTokens);

		await compact(preparation, createModel(200000), "test-key");

		const prompts = sentPrompts();
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("PREFIX-OLDEST");
		expect(prompts[0]).not.toContain("were elided");
	});
});

describe("zero-reduction compaction", () => {
	it("skips when the capped keep-recent window leaves nothing to summarize", () => {
		const u1 = createMessageEntry(createUserMessage("earlier request"));
		const a1 = createMessageEntry(createAssistantMessage("earlier answer"));
		const u2 = createMessageEntry(createUserMessage("kept by compaction1"));
		const compaction = createCompactionEntry(PRIOR_SUMMARY, u2.id);
		const a2 = createMessageEntry(createAssistantMessage("small answer"));
		const entries = [u1, a1, u2, compaction, a2];

		// keepRecentTokens above the window is capped to exactly the threshold, so
		// every retained message stays inside it and the cut cannot move.
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 1000,
			keepRecentTokens: 50000,
		};
		const contextWindow = 6000;
		expect(capKeepRecentTokens(settings, contextWindow)).toBe(contextWindow - settings.reserveTokens);
		// The session is over the threshold, so threshold compaction keeps firing.
		expect(shouldCompact(contextWindow - settings.reserveTokens + 1, contextWindow, settings)).toBe(true);

		// Re-summarizing nothing cannot shrink the context: skip so the caller keeps
		// its cooldown instead of burning a summarization call every turn.
		expect(prepareCompaction(entries, settings, contextWindow)).toBeUndefined();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});
});
