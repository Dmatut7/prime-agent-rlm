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
 *
 * Rewritten for issue #19 without weakening that guard. The first case used to build
 * its "the session moves on (branch navigation)" window out of plain forward appends
 * (user1 → assistant → user2 → assistant, with no branch() call anywhere), so the
 * pinned leaf was an ancestor of the current leaf. That is not navigation — it is the
 * exact shape in which appendCompaction() mistook a same-branch append for a
 * navigation and parked a live summary on a side branch, leaving the current context
 * uncompacted forever. The case therefore pinned the bug. It is now a real navigation
 * (branch() away from the summarized branch), which keeps every original
 * options-signature assertion, and the forward-append shape moved to its own case
 * below, asserting the fixed semantics.
 */
describe("appendCompaction options object (sync-upstream-r3 trap 4)", () => {
	it("parents the entry at options.leafId, records options.usage, and leaves the current leaf alone after a real navigation", () => {
		const manager = SessionManager.inMemory();
		const user1 = manager.appendMessage({ role: "user", content: "work to summarize", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("reply on the summarized branch"));
		const pinned = manager.getLeafId();
		expect(pinned).not.toBe(user1);

		// The session really navigates away while the summary is in flight: branch back
		// to an ancestor of the pin and build a different continuation there, so the
		// pinned leaf is not on the new leaf's parent chain.
		manager.branch(user1);
		const user2 = manager.appendMessage({ role: "user", content: "new question", timestamp: Date.now() });
		manager.appendMessage(createAssistantMessage("new reply"));
		const leafBefore = manager.getLeafId();
		expect(leafBefore).not.toBe(pinned);

		const usage = createMockUsage(700, 300);
		const compactionId = manager.appendCompaction("pinned summary", user2, 4200, undefined, undefined, undefined, {
			leafId: pinned ?? undefined,
			usage,
		});

		const entry = manager.getEntry(compactionId) as CompactionEntry;
		// options.leafId reached the entry: it belongs to the branch it summarized.
		expect(entry.parentId).toBe(pinned);
		// options.usage reached the entry, which is what the session scan folds into own spend.
		expect(entry.usage).toEqual(usage);
		expect(entry.summary).toBe("pinned summary");
		expect(entry.firstKeptEntryId).toBe(user2);
		expect(entry.tokensBefore).toBe(4200);
		// A real navigation must not drag the current position back to the summarized branch.
		expect(manager.getLeafId()).toBe(leafBefore);
		// The summary sits on the summarized branch, not on the one the session moved to...
		const summarizedBranch = manager.getBranch(compactionId).map((e) => e.id);
		expect(summarizedBranch).toContain(pinned);
		expect(summarizedBranch).not.toContain(user2);
		// ...and the branch the session moved to keeps its own appends, with no summary on it.
		const liveIds = manager.getBranch().map((e) => e.id);
		expect(liveIds).toContain(user2);
		expect(liveIds).not.toContain(compactionId);
	});

	it("lands the summary on the live chain when the session only appended forward (issue #19)", () => {
		const manager = SessionManager.inMemory();
		const user1 = manager.appendMessage({ role: "user", content: "work to summarize", timestamp: Date.now() });
		const assistant1 = manager.appendMessage(createAssistantMessage("reply on the summarized branch"));
		const pinned = manager.getLeafId();
		expect(pinned).toBe(assistant1);

		// A child usage attribution lands while the summary is in flight: same branch,
		// strictly forward. This is the window shape that used to lose the summary.
		const usage = createMockUsage(700, 300);
		manager.appendChildUsageAttribution(assistant1, usage, usage);
		const windowEntry = manager.getLeafId();
		expect(windowEntry).not.toBe(pinned);

		const compactionId = manager.appendCompaction("forward summary", user1, 4200, undefined, undefined, undefined, {
			leafId: pinned ?? undefined,
			usage,
		});

		const entry = manager.getEntry(compactionId) as CompactionEntry;
		// Retargeted at the current leaf: the summary describes the live history instead
		// of forking the chain at the pin and orphaning everything appended meanwhile.
		expect(entry.parentId).toBe(windowEntry);
		expect(entry.usage).toEqual(usage);
		expect(manager.getLeafId()).toBe(compactionId);

		const liveIds = manager.getBranch().map((e) => e.id);
		expect(liveIds).toContain(windowEntry);
		expect(liveIds).toContain(compactionId);
		expect(manager.buildSessionContext().messages.some((message) => message.role === "compactionSummary")).toBe(true);
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
