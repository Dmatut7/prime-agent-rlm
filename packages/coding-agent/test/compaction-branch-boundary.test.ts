import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { collectEntriesForBranchSummary } from "../src/core/compaction/index.js";
import { type CompactionEntry, SessionManager } from "../src/core/session-manager.js";

function createMockUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

describe("collectEntriesForBranchSummary stops at compaction (scan2 C6)", () => {
	it("includes the compaction entry but nothing older", () => {
		const manager = SessionManager.inMemory();
		const user1 = manager.appendMessage({ role: "user", content: "old exploration", timestamp: Date.now() });
		const asst1 = manager.appendMessage(createAssistantMessage("old reply"));
		manager.appendCompaction("old summary", user1, 5000);
		const user2 = manager.appendMessage({ role: "user", content: "recent question", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("recent reply"));
		const leaf = manager.getLeafId();

		const { entries } = collectEntriesForBranchSummary(manager, leaf, user1);

		const ids = entries.map((entry) => entry.id);
		expect(ids).toContain(user2);
		expect(ids).not.toContain(user1);
		expect(ids).not.toContain(asst1);
		expect(entries.some((entry) => entry.type === "compaction")).toBe(true);
		// The compaction boundary is the oldest collected entry.
		expect(entries[0].type).toBe("compaction");
	});
});

/**
 * The seventh parameter is an options object, not two positional parameters: the
 * upstream compaction call site passes usage and the local one passes a pinned
 * leaf, and both have to survive the merge. Every assertion below breaks if the
 * signature goes back to positional leafId/usage, or if either field is dropped
 * from the options object — neither of which esbuild, biome, or
 * compaction-branch-boundary's existing test can see.
 */
describe("appendCompaction options object (sync-upstream-r3 trap 4)", () => {
	it("parents the entry at options.leafId, records options.usage, and leaves the current leaf alone", () => {
		const manager = SessionManager.inMemory();
		const user1 = manager.appendMessage({ role: "user", content: "work to summarize", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("reply on the summarized branch"));
		// The session moves on (branch navigation) while the summary is being generated.
		const user2 = manager.appendMessage({ role: "user", content: "new question", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("new reply"));
		const leafBefore = manager.getLeafId();
		expect(leafBefore).not.toBe(user1);

		const usage = createMockUsage(700, 300);
		const compactionId = manager.appendCompaction("pinned summary", user2, 4200, undefined, undefined, undefined, {
			leafId: user1,
			usage,
		});

		const entry = manager.getEntry(compactionId) as CompactionEntry;
		// options.leafId reached the entry: it belongs to the branch it summarized.
		expect(entry.parentId).toBe(user1);
		// options.usage reached the entry, which is what the session scan folds into own spend.
		expect(entry.usage).toEqual(usage);
		expect(entry.summary).toBe("pinned summary");
		expect(entry.firstKeptEntryId).toBe(user2);
		expect(entry.tokensBefore).toBe(4200);
		// A pinned leaf means the session moved: the entry must not drag the current position back to it.
		expect(manager.getLeafId()).toBe(leafBefore);
		// And it sits on the summarized branch, not on the one the session moved to.
		const branchIds = manager.getBranch(compactionId).map((e) => e.id);
		expect(branchIds).toContain(user1);
		expect(branchIds).not.toContain(user2);
	});

	it("advances the leaf and records no usage when options is omitted", () => {
		const manager = SessionManager.inMemory();
		const user1 = manager.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
		const leafBefore = manager.getLeafId();

		const compactionId = manager.appendCompaction("plain summary", user1, 1000);

		const entry = manager.getEntry(compactionId) as CompactionEntry;
		expect(entry.parentId).toBe(leafBefore);
		expect(entry.usage).toBeUndefined();
		expect(manager.getLeafId()).toBe(compactionId);
	});
});
