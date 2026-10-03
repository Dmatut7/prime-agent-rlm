/**
 * W27-C: a skipped compaction must say WHY there is nothing to do.
 *
 * Wave-26 finding A: "Auto-compaction skipped: Session is too short to compact"
 * covered two different situations with one wording - a benign "nothing to
 * summarize" (the kept tail already holds the whole session, e.g. one oversized
 * message fills it) and a real failure (a session entry without an id, i.e. a
 * session that predates id-stamping). The reason is typed at the one place that
 * knows it (prepareCompactionOutcome), with one canonical wording per reason.
 *
 * Second half of the finding: audit that the W18-D <session-handoff> block is
 * not produced on this idle path. It cannot be - every skip returns before the
 * handoff is assembled - and the pins below keep it that way.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import {
	buildCompactionAppendix,
	compactionSkipMessage,
	DEFAULT_COMPACTION_SETTINGS,
	emptyHandoffLedger,
	prepareCompaction,
	prepareCompactionOutcome,
	renderSessionHandoff,
} from "../src/core/compaction/index.js";
import { DUTY_EVENT_CUSTOM_TYPE } from "../src/core/duty-log.js";
import type { CompactionEntry, CustomEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

let entryCounter = 0;
let lastId: string | null = null;

beforeEach(() => {
	entryCounter = 0;
	lastId = null;
});

function link<T extends { id: string; parentId: string | null }>(entry: T): T {
	entry.parentId = lastId;
	lastId = entry.id;
	return entry;
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

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AssistantMessage as AgentMessage;
}

/** An assistant message whose provider-reported usage keeps the session over the threshold. */
function assistantMessageWithTokens(text: string, totalTokens: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: { ...createUsage(), totalTokens },
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AssistantMessage as AgentMessage;
}

function messageEntry(message: AgentMessage): SessionMessageEntry {
	return link({
		type: "message",
		id: `entry-${entryCounter++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	});
}

function compactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	return link({
		type: "compaction",
		id: `entry-${entryCounter++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 100000,
	});
}

function dutyEntry(question: string): CustomEntry {
	return link({
		type: "custom",
		id: `entry-${entryCounter++}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		customType: DUTY_EVENT_CUSTOM_TYPE,
		data: { kind: "decision_needed", question },
	});
}

/** An ipython tool result carrying the kernel activity records the handoff scans. */
function ipythonResult(details: Record<string, unknown>): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		details,
		isError: false,
		timestamp: Date.now(),
	} as ToolResultMessage as AgentMessage;
}

function subagentActivity(id: string, label: string): Record<string, unknown> {
	return { id, kind: "subagent", label, status: "ok", startedAt: 1_000 };
}

/** One message larger than the keep-recent budget on its own. */
const GIANT = "x".repeat(12000);
/** Enough tail weight that prepareCompaction cuts before the slice. */
const TAIL_FILLER = "y".repeat(12000);
const settings = (): typeof DEFAULT_COMPACTION_SETTINGS => ({ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 2000 });

describe("prepareCompactionOutcome skip reasons (W27-C)", () => {
	it("classifies a session that fits in the keep-recent window as nothing-to-summarize", () => {
		const entries: SessionEntry[] = [
			messageEntry(userMessage("hello")),
			messageEntry(assistantMessage("hi there")),
			messageEntry(userMessage("how are you")),
			messageEntry(assistantMessage("great")),
		];
		expect(prepareCompactionOutcome(entries, DEFAULT_COMPACTION_SETTINGS)).toEqual({
			kind: "skip",
			reason: "nothing-to-summarize",
		});
		// The legacy wrapper keeps its contract: every skip is still undefined.
		expect(prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
	});

	it("classifies an empty branch as nothing-to-summarize, not missing-entry-ids", () => {
		expect(prepareCompactionOutcome([], DEFAULT_COMPACTION_SETTINGS)).toEqual({
			kind: "skip",
			reason: "nothing-to-summarize",
		});
	});

	it("classifies one oversized message filling the whole kept tail as nothing-to-summarize", () => {
		// The wave-26 case: the session is not "too short" - a single giant message
		// IS the retained tail, so there is nothing older to summarize.
		const entries: SessionEntry[] = [messageEntry(userMessage(GIANT))];
		expect(prepareCompactionOutcome(entries, settings())).toEqual({
			kind: "skip",
			reason: "nothing-to-summarize",
		});
	});

	it("classifies a trailing compaction entry as already-compacted", () => {
		const kept = messageEntry(userMessage("kept"));
		const entries: SessionEntry[] = [
			messageEntry(userMessage("summarized")),
			kept,
			compactionEntry("First summary", kept.id),
		];
		expect(prepareCompactionOutcome(entries, DEFAULT_COMPACTION_SETTINGS)).toEqual({
			kind: "skip",
			reason: "already-compacted",
		});
	});

	it("classifies an id-less kept entry as missing-entry-ids: a failure, not a benign skip", () => {
		// The cut lands on the giant assistant message (split turn); without an id on
		// it the compaction entry could not name its firstKeptEntryId. That is a
		// session that predates id-stamping, not a session with nothing to summarize.
		const giantAssistant = messageEntry(assistantMessage(GIANT));
		giantAssistant.id = "";
		const entries: SessionEntry[] = [messageEntry(userMessage("do the work")), giantAssistant];
		expect(prepareCompactionOutcome(entries, settings())).toEqual({
			kind: "skip",
			reason: "missing-entry-ids",
		});
	});

	it("returns the preparation on the ready path", () => {
		const entries: SessionEntry[] = [
			messageEntry(userMessage("第一批工作")),
			messageEntry(assistantMessage("done")),
			messageEntry(userMessage(TAIL_FILLER)),
		];
		const outcome = prepareCompactionOutcome(entries, settings());
		expect(outcome.kind).toBe("ready");
		if (outcome.kind !== "ready") return;
		// The wrapper runs the same pipeline and hands the preparation through.
		expect(prepareCompaction(entries, settings())).toEqual(outcome.preparation);
	});
});

describe("compactionSkipMessage wording (W27-C)", () => {
	it("gives each reason its own wording", () => {
		const messages = (["already-compacted", "nothing-to-summarize", "missing-entry-ids"] as const).map(
			compactionSkipMessage,
		);
		expect(new Set(messages).size).toBe(3);
	});

	it("nothing-to-summarize no longer claims the session is too short or tells the user to wait for growth", () => {
		const message = compactionSkipMessage("nothing-to-summarize");
		expect(message).not.toMatch(/too short/i);
		expect(message).not.toMatch(/once it grows/i);
		expect(message).toContain("Nothing to summarize");
	});

	it("missing-entry-ids reads as a failure and names the migration, not as a benign skip", () => {
		const message = compactionSkipMessage("missing-entry-ids");
		expect(message).toMatch(/cannot run/i);
		expect(message).toMatch(/migrat/i);
		expect(message).not.toMatch(/too short/i);
	});

	it("already-compacted keeps the established wording", () => {
		expect(compactionSkipMessage("already-compacted")).toBe("Already compacted");
	});
});

describe("over-threshold nothing-to-summarize carries the shrink evaluation (W29-B10)", () => {
	// A 100k window makes the trigger threshold 80_000 at the default 0.8 ratio
	// (the 16384 reserve leaves an 83_616 ceiling, so the ratio binds).
	const WINDOW = 100_000;
	/** One message larger than the trigger threshold on its own (~100k content-priced tokens). */
	const WALL = "x".repeat(400_000);

	it("an over-threshold skip carries the shrink plan for the divisible context outside the kept tail", () => {
		// The wave-29 spin: the kept tail starts at the oversized head, so the
		// summarization path finds nothing to do - but the oldest entry is a cut
		// point of its own, so the emergency shrink can drop it and keep the tail.
		const wall = messageEntry(userMessage(WALL));
		const followUp = messageEntry(userMessage("继续"));
		const reply = messageEntry(assistantMessageWithTokens("done", 100_005));
		const entries: SessionEntry[] = [wall, followUp, reply];
		const outcome = prepareCompactionOutcome(entries, settings(), WINDOW);
		expect(outcome.kind).toBe("skip");
		if (outcome.kind !== "skip") return;
		expect(outcome.reason).toBe("nothing-to-summarize");
		const plan = outcome.emergencyShrink;
		expect(plan).toBeDefined();
		expect(plan?.firstKeptEntryId).toBe(followUp.id);
		expect(plan?.reachedTarget).toBe(true);
		expect(plan?.span.droppedEntries).toBe(1);
		expect(plan?.span.droppedRoles).toEqual({ user: 1 });
		expect(plan?.tokensAfter).toBeLessThanOrEqual(plan?.targetTokens ?? -1);
		// The legacy wrapper still collapses every skip to undefined.
		expect(prepareCompaction(entries, settings(), WINDOW)).toBeUndefined();
	});

	it("an over-threshold skip on one wall-sized message carries null: the shrink has nothing to cut", () => {
		// The oversized entry IS the whole context - no cut point exists past it, so
		// the evaluation says so explicitly instead of leaving the caller guessing.
		const entries: SessionEntry[] = [messageEntry(userMessage(WALL))];
		const outcome = prepareCompactionOutcome(entries, settings(), WINDOW);
		expect(outcome.kind).toBe("skip");
		if (outcome.kind !== "skip") return;
		expect(outcome.reason).toBe("nothing-to-summarize");
		expect(outcome.emergencyShrink).toBeNull();
	});

	it("an under-threshold nothing-to-summarize skip stays benign: no evaluation is attached", () => {
		const entries: SessionEntry[] = [
			messageEntry(userMessage("hello")),
			messageEntry(assistantMessage("hi there")),
			messageEntry(userMessage("how are you")),
			messageEntry(assistantMessage("great")),
		];
		const outcome = prepareCompactionOutcome(entries, DEFAULT_COMPACTION_SETTINGS, WINDOW);
		expect(outcome.kind).toBe("skip");
		if (outcome.kind !== "skip") return;
		expect(outcome.reason).toBe("nothing-to-summarize");
		expect("emergencyShrink" in outcome).toBe(false);
	});

	it("no known window means no evaluation: the skip cannot be classified as over-threshold", () => {
		const entries: SessionEntry[] = [messageEntry(userMessage(WALL))];
		const outcome = prepareCompactionOutcome(entries, settings());
		expect(outcome.kind).toBe("skip");
		if (outcome.kind !== "skip") return;
		expect("emergencyShrink" in outcome).toBe(false);
	});

	it("already-compacted never carries the evaluation, even over the threshold", () => {
		const kept = messageEntry(userMessage(WALL));
		const entries: SessionEntry[] = [
			messageEntry(userMessage("summarized")),
			kept,
			compactionEntry("First summary", kept.id),
		];
		const outcome = prepareCompactionOutcome(entries, settings(), WINDOW);
		expect(outcome.kind).toBe("skip");
		if (outcome.kind !== "skip") return;
		expect(outcome.reason).toBe("already-compacted");
		expect("emergencyShrink" in outcome).toBe(false);
	});

	it("missing-entry-ids never carries the evaluation: it already takes the failure path", () => {
		const giantAssistant = messageEntry(assistantMessageWithTokens(WALL, 100_005));
		giantAssistant.id = "";
		const entries: SessionEntry[] = [messageEntry(userMessage("do the work")), giantAssistant];
		const outcome = prepareCompactionOutcome(entries, settings(), WINDOW);
		expect(outcome.kind).toBe("skip");
		if (outcome.kind !== "skip") return;
		expect(outcome.reason).toBe("missing-entry-ids");
		expect("emergencyShrink" in outcome).toBe(false);
	});
});

describe("session-handoff on the idle path (W27-C audit)", () => {
	it("a skip yields no preparation, so no handoff ledger is assembled and no block can be rendered", () => {
		// In-flight evidence sits in the branch (an owed owner decision); if the idle
		// path ever started producing a handoff, this fixture is the one that would
		// show it. The skip carries no preparation, so compact() - the only writer of
		// the block - is unreachable from here.
		const entries: SessionEntry[] = [dutyEntry("交接块要不要进 branch summary？"), messageEntry(userMessage(GIANT))];
		const outcome = prepareCompactionOutcome(entries, settings());
		expect(outcome).toEqual({ kind: "skip", reason: "nothing-to-summarize" });
	});

	it("an empty handoff ledger renders no block at all", () => {
		expect(renderSessionHandoff(emptyHandoffLedger(1))).toBe("");
	});

	it("positive control: the ready path still assembles the handoff from the whole branch", () => {
		const entries: SessionEntry[] = [
			messageEntry(userMessage("把会话交接做进压缩摘要")),
			messageEntry(ipythonResult({ activities: [subagentActivity("s1", "worker-a")] })),
			messageEntry(assistantMessage(TAIL_FILLER)),
		];
		const outcome = prepareCompactionOutcome(entries, settings());
		expect(outcome.kind).toBe("ready");
		if (outcome.kind !== "ready") return;
		expect(outcome.preparation.handoff?.subagents.map((s) => s.name)).toEqual(["worker-a"]);
		expect(buildCompactionAppendix(outcome.preparation).text).toContain("<session-handoff");
	});
});
