import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	alignCutToTurnStart,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	findTurnStartIndex,
	isTurnStartEntry,
	prepareCompaction,
	TURN_ALIGNMENT_EXTRA_SHARE,
} from "../src/core/compaction/index.js";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

const { completeSimpleMock } = vi.hoisted(() => ({ completeSimpleMock: vi.fn() }));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return { ...actual, completeSimple: completeSimpleMock };
});

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

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

/** An assistant message of roughly `chars / 4` estimated tokens. */
function assistantMessage(chars: number, marker = "work"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `${marker} ${"x".repeat(Math.max(0, chars - marker.length - 1))}` }],
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AssistantMessage as AgentMessage;
}

function toolResultMessage(chars: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "bash",
		content: [{ type: "text", text: "r".repeat(chars) }],
		isError: false,
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
		content: [{ type: "text", text: "## Goal\nnarrative" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: createUsage(),
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

function labelEntry(targetId: string): SessionEntry {
	const id = `entry-${entryCounter++}`;
	const entry: SessionEntry = {
		type: "label",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		targetId,
		label: "tag",
	};
	lastId = id;
	return entry;
}

describe("isTurnStartEntry", () => {
	it("counts the entries a retained region can start on without splitting a turn", () => {
		const user = messageEntry(userMessage("hi"));
		const assistant = messageEntry(assistantMessage(100));
		const bash = messageEntry({
			role: "bashExecution",
			command: "ls",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: Date.now(),
		} as AgentMessage);
		const toolResult = messageEntry(toolResultMessage(10));

		expect(isTurnStartEntry(user)).toBe(true);
		expect(isTurnStartEntry(bash)).toBe(true);
		expect(isTurnStartEntry(assistant)).toBe(false);
		expect(isTurnStartEntry(toolResult)).toBe(false);
	});
});

describe("findCutPoint turn alignment", () => {
	/**
	 * Turn 1 (entries 0-1), turn 2 (entries 2-5), turn 3 (entries 6-7). The budget is
	 * crossed inside turn 3, so the unaligned cut would land on the assistant at 7 and
	 * summarize the user message at 6 that says what the turn is for.
	 */
	function affordableMidTurnCut(): SessionEntry[] {
		return [
			messageEntry(userMessage("task one")),
			messageEntry(assistantMessage(400)),
			messageEntry(userMessage("task two")),
			messageEntry(assistantMessage(400)),
			messageEntry(toolResultMessage(400)),
			messageEntry(assistantMessage(400)),
			messageEntry(userMessage("task three: keep the retained region honest")),
			messageEntry(assistantMessage(4000)),
		];
	}

	it("moves the cut back to the turn start when the turn fits in the slack", () => {
		const entries = affordableMidTurnCut();
		const result = findCutPoint(entries, 0, entries.length, 1000);

		expect(result.firstKeptEntryIndex).toBe(6);
		expect(result.isSplitTurn).toBe(false);
		expect(result.turnStartIndex).toBe(-1);
		// The request that started the retained turn is inside the retained region.
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
	});

	it("keeps the mid-turn cut when retaining the whole turn would cost more than the budget again", () => {
		const entries = [
			messageEntry(userMessage("task one")),
			messageEntry(assistantMessage(400)),
			messageEntry(userMessage("task two")),
			// One turn so large that keeping it whole would defeat the compaction.
			messageEntry(assistantMessage(40000, "huge step")),
			messageEntry(assistantMessage(4000, "later step")),
			messageEntry(assistantMessage(400, "latest step")),
		];
		const result = findCutPoint(entries, 0, entries.length, 1000);

		expect(result.firstKeptEntryIndex).toBe(4);
		expect(result.isSplitTurn).toBe(true);
		expect(result.turnStartIndex).toBe(2);
	});

	it("leaves a cut that already starts a turn alone", () => {
		const entries = [
			messageEntry(userMessage("task one")),
			messageEntry(assistantMessage(400)),
			// The budget is crossed at a user message, which is already a turn start.
			messageEntry(userMessage(`task two ${"q".repeat(4000)}`)),
			messageEntry(assistantMessage(400)),
		];
		const result = findCutPoint(entries, 0, entries.length, 1000);

		expect(result.firstKeptEntryIndex).toBe(2);
		expect(result.isSplitTurn).toBe(false);
		expect(result.turnStartIndex).toBe(-1);
	});

	it("does not align onto the range start, which would summarize nothing", () => {
		const entries = [
			messageEntry(userMessage("the only turn")),
			messageEntry(assistantMessage(4000)),
			messageEntry(assistantMessage(4000)),
			messageEntry(assistantMessage(400)),
		];
		const result = findCutPoint(entries, 0, entries.length, 1000);

		expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
		expect(result.isSplitTurn).toBe(true);
		expect(result.turnStartIndex).toBe(0);
	});

	it("aligns onto a user-initiated bash execution without calling it a split turn", () => {
		const entries = [
			messageEntry(userMessage("task one")),
			messageEntry(assistantMessage(4000)),
			messageEntry({
				role: "bashExecution",
				command: "npm run check",
				output: "ok",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
			} as AgentMessage),
			messageEntry(assistantMessage(400)),
		];
		const result = findCutPoint(entries, 0, entries.length, 100);

		expect(result.firstKeptEntryIndex).toBe(2);
		expect(result.isSplitTurn).toBe(false);
		expect(result.turnStartIndex).toBe(-1);
	});

	it("still cuts before a trailing oversized tool result, then aligns if it can", () => {
		const entries = [
			messageEntry(userMessage("task one")),
			messageEntry(assistantMessage(200)),
			messageEntry(userMessage("task two")),
			messageEntry(assistantMessage(200)),
			messageEntry(toolResultMessage(400_000)),
		];
		const result = findCutPoint(entries, 0, entries.length, 1000);

		// The budget is crossed at the huge tool result, which is not a cut point; the
		// fallback keeps its issuing assistant, and alignment then walks back to the turn.
		expect(result.firstKeptEntryIndex).toBe(2);
		expect(result.isSplitTurn).toBe(false);
	});

	it("keeps the mid-turn cut when the retained budget is zero", () => {
		const entries = [
			messageEntry(userMessage("task one")),
			messageEntry(assistantMessage(4000)),
			messageEntry(userMessage("task two")),
			messageEntry(assistantMessage(400)),
		];
		const result = findCutPoint(entries, 0, entries.length, 0);

		expect(result.firstKeptEntryIndex).toBe(3);
		expect(result.isSplitTurn).toBe(true);
		expect(result.turnStartIndex).toBe(2);
	});
});

describe("alignCutToTurnStart", () => {
	/** An older turn (0-1), then the turn of interest starting at 2 with a label in between. */
	function entries(): SessionEntry[] {
		return [
			messageEntry(userMessage("task one")),
			messageEntry(assistantMessage(400)),
			messageEntry(userMessage("task two")),
			labelEntry("entry-2"),
			messageEntry(assistantMessage(4000)),
			messageEntry(assistantMessage(400)),
		];
	}

	it("walks back over non-message entries to the turn start", () => {
		const list = entries();
		expect(findTurnStartIndex(list, 5, 0)).toBe(2);
		expect(alignCutToTurnStart(list, 5, 0, 2000)).toBe(2);
	});

	it("refuses when the prefix costs more than the allowed share of the budget", () => {
		const list = entries();
		expect(alignCutToTurnStart(list, 5, 0, 100)).toBe(5);
		// The share is a knob, not a constant baked into the walk.
		expect(alignCutToTurnStart(list, 5, 0, 100, 40)).toBe(2);
		expect(TURN_ALIGNMENT_EXTRA_SHARE).toBe(1);
	});

	it("refuses when there is no turn start inside the range, or the cut is the range start", () => {
		const list = entries();
		expect(alignCutToTurnStart(list, 0, 0, 2000)).toBe(0);
		// A range that starts at the turn itself cannot be aligned: it would summarize nothing.
		expect(alignCutToTurnStart(list, 5, 2, 2000)).toBe(5);
		const orphan = [messageEntry(assistantMessage(400)), messageEntry(assistantMessage(4000))];
		expect(alignCutToTurnStart(orphan, 1, 0, 2000)).toBe(1);
	});

	it("does nothing when the cut already starts a turn, even with no slack at all", () => {
		const list = entries();
		expect(alignCutToTurnStart(list, 2, 0, 0)).toBe(2);
		// Zero slack refuses every move that would retain one token more.
		expect(alignCutToTurnStart(list, 5, 0, 0)).toBe(5);
	});
});

describe("prepareCompaction with an aligned cut", () => {
	it("retains the turn whole and needs no prefix summary call", async () => {
		const entries = [
			messageEntry(userMessage("earlier task")),
			messageEntry(assistantMessage(4000)),
			messageEntry(userMessage("the task being retained")),
			messageEntry(assistantMessage(400)),
		];
		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 }, 200000);

		expect(preparation).toBeDefined();
		expect(preparation?.isSplitTurn).toBe(false);
		expect(preparation?.turnPrefixMessages).toEqual([]);
		expect(preparation?.firstKeptEntryId).toBe(entries[2].id);
		expect(preparation?.messagesToSummarize).toHaveLength(2);

		const result = await compact(preparation!, createModel(), "test-key");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(result.firstKeptEntryId).toBe(entries[2].id);
	});

	it("still makes the prefix call for a turn too large to retain", async () => {
		const entries = [
			messageEntry(userMessage("earlier task")),
			messageEntry(userMessage("the oversized turn")),
			messageEntry(assistantMessage(40000, "step one")),
			messageEntry(assistantMessage(40000, "step two")),
			messageEntry(assistantMessage(400, "latest")),
		];
		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 }, 200000);

		expect(preparation?.isSplitTurn).toBe(true);
		expect(preparation?.turnPrefixMessages.length).toBeGreaterThan(0);
		await compact(preparation!, createModel(), "test-key");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
	});
});
