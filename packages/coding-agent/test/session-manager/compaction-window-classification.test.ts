import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CompactionCommitInfo, type CompactionEntry, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

/**
 * Issue #19: a same-branch append during the compaction window.
 *
 * `appendCompaction()` used to read "the pinned leaf is not the current leaf" as
 * "the session navigated to another branch". It can also mean the session merely
 * appended forward while the summary was in flight - a child usage attribution is
 * the common case - and the summary was then parked on a side branch: the file
 * gained a compaction record, the live chain kept the uncompacted history, and every
 * later request carried it again until the model's context limit broke.
 *
 * These are the SessionManager-level cases. The caller contract (the pin itself) is
 * guarded separately at the agent-session level, because deleting the pin leaves
 * every assertion here green.
 */
function mockUsage(totalTokens = 2): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function contextText(manager: SessionManager): string[] {
	return manager.buildSessionContext().messages.map((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("");
	});
}

function hasSummary(manager: SessionManager): boolean {
	return manager.buildSessionContext().messages.some((message) => message.role === "compactionSummary");
}

function commit(manager: SessionManager, summary: string, cut: string, pinned?: string | null) {
	let info: CompactionCommitInfo | undefined;
	const id = manager.appendCompaction(summary, cut, 4200, undefined, false, undefined, {
		...(pinned === undefined ? {} : { leafId: pinned ?? undefined }),
		onCommit: (committed) => {
			info = committed;
		},
	});
	return { id, info: info as CompactionCommitInfo };
}

describe("issue #19: compaction commit classification and window appends", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "compaction-window-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function seeded() {
		const manager = SessionManager.inMemory();
		const u1 = manager.appendMessage(userMsg("ONE"));
		const a1 = manager.appendMessage(assistantMsg("answer one"));
		return { manager, u1, a1 };
	}

	it("keeps the summary on the live chain when an attribution lands in the window (the reporter's repro)", () => {
		const { manager, u1, a1 } = seeded();
		const pinned = manager.getLeafId();
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage());
		const windowEntry = manager.getLeafId();
		expect(windowEntry).not.toBe(pinned);

		const { id, info } = commit(manager, "SUMMARY", u1, pinned);

		expect(hasSummary(manager)).toBe(true);
		expect(info.classification).toBe("same_branch_forward");
		expect(info.pinnedLeafId).toBe(pinned);
		expect(info.currentLeafId).toBe(id);
		expect(info.windowEntriesOnSummarizedBranch).toBe(1);
		expect(info.windowEntryTypesOnSummarizedBranch).toEqual(["child_usage_attributed"]);
		expect(info.firstKeptRewritten).toBe(false);
		expect(info.firstKeptUnresolvable).toBe(false);
		// Retargeted at the current leaf: the window append is not orphaned on a fork.
		expect(manager.getEntry(id)?.parentId).toBe(windowEntry);
		expect(manager.getLeafId()).toBe(id);
	});

	it("reports no window append when the session did not move", () => {
		const { manager, u1 } = seeded();
		const pinned = manager.getLeafId();
		const { id, info } = commit(manager, "SUMMARY", u1, pinned);
		expect(info.classification).toBe("same_branch_no_window_append");
		expect(info.windowEntriesOnSummarizedBranch).toBe(0);
		expect(hasSummary(manager)).toBe(true);
		expect(manager.getLeafId()).toBe(id);
	});

	it("classifies an omitted pin as no_pin_supplied and still commits on the live chain", () => {
		const { manager, u1 } = seeded();
		const { id, info } = commit(manager, "SUMMARY", u1);
		expect(info.classification).toBe("no_pin_supplied");
		expect(info.pinnedLeafId).toBeNull();
		expect(manager.getLeafId()).toBe(id);
		expect(hasSummary(manager)).toBe(true);
	});

	it("keeps a real navigation off the live chain and does not drag the position back", () => {
		const { manager, u1 } = seeded();
		const pinned = manager.getLeafId();
		// Real navigation: leave the summarized branch, then build a different continuation.
		manager.branch(u1);
		const u2 = manager.appendMessage(userMsg("TWO"));
		manager.appendMessage(assistantMsg("answer two"));
		const leafBefore = manager.getLeafId();
		expect(leafBefore).not.toBe(pinned);

		const { id, info } = commit(manager, "NAVSUM", u2, pinned);

		expect(info.classification).toBe("branch_navigation");
		// Structurally empty: the entry's parent is the pin, so nothing can sit between.
		expect(info.windowEntriesOnSummarizedBranch).toBe(0);
		expect(manager.getLeafId()).toBe(leafBefore);
		const liveIds = manager.getBranch().map((entry) => entry.id);
		expect(liveIds).not.toContain(id);
		expect(liveIds).toContain(u2);
		expect(manager.getBranch(id).map((entry) => entry.id)).toContain(pinned);
		expect(hasSummary(manager)).toBe(false);
	});

	it("does not orphan a real conversation message appended during the window", () => {
		const { manager, u1 } = seeded();
		const pinned = manager.getLeafId();
		manager.appendMessage(userMsg("THREE"));
		const { id, info } = commit(manager, "SUMMARY", u1, pinned);
		expect(info.classification).toBe("same_branch_forward");
		expect(info.windowEntryTypesOnSummarizedBranch).toEqual(["message"]);
		// The message is a descendant of the cut, so it stays in the kept tail.
		expect(contextText(manager)).toContain("THREE");
		expect(hasSummary(manager)).toBe(true);
		expect(manager.getLeafId()).toBe(id);
	});

	it("treats every non-attribution window writer the same way", () => {
		const writers: Array<[string, (manager: SessionManager, anchor: string) => void]> = [
			["custom entry", (m) => void m.appendCustomEntry("test.marker", { ok: true })],
			["thinking level", (m) => void m.appendThinkingLevelChange("high")],
			["service tier", (m) => void m.appendServiceTierChange("default")],
			["model change", (m) => void m.appendModelChange("test", "test-model")],
			["session info", (m) => void m.appendSessionInfo("renamed")],
			[
				"session state",
				(m) => void m.appendSessionState({ status: "active", timestamp: new Date().toISOString() } as never),
			],
		];
		expect(writers.length).toBeGreaterThan(0);
		for (const [name, write] of writers) {
			const { manager, u1, a1 } = seeded();
			const pinned = manager.getLeafId();
			write(manager, a1);
			const { id, info } = commit(manager, "SUMMARY", u1, pinned);
			expect(info.classification, name).toBe("same_branch_forward");
			expect(info.windowEntriesOnSummarizedBranch, name).toBe(1);
			expect(hasSummary(manager), name).toBe(true);
			expect(manager.getLeafId(), name).toBe(id);
		}
	});

	it("survives a reopen: the summary is in context, the leaf is the compaction, the attribution is still on the chain", () => {
		const manager = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
		const u1 = manager.appendMessage(userMsg("ONE"));
		const a1 = manager.appendMessage(assistantMsg("answer one"));
		const pinned = manager.getLeafId();
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage(4));
		const { id } = commit(manager, "SUMMARY", u1, pinned);
		const file = manager.getSessionFile()!;

		const resumed = SessionManager.open(file);
		expect(resumed.getLeafId()).toBe(id);
		expect(hasSummary(resumed)).toBe(true);
		const chainTypes = resumed.getBranch().map((entry) => entry.type);
		expect(chainTypes).toContain("child_usage_attributed");
		expect(chainTypes).toContain("compaction");
		// The retargeted parent resolves on disk: nothing dangles.
		expect(resumed.getEntry(id)?.parentId).toBe(
			resumed.getBranch(resumed.getEntry(id)?.parentId as string)?.at(-1)?.id,
		);
	});

	it("walks a deferred-merge cut back to a persisted ancestor so the kept tail survives a reopen", () => {
		const manager = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
		manager.appendMessage(userMsg("ONE"));
		const a1 = manager.appendMessage(assistantMsg("answer one"));
		// First attribution persists immediately (the anchor); the next two are deferred
		// merges and only the last of them ever reaches disk, so the middle id is a cut
		// point that a reopen could never match.
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage(3));
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage(4));
		const supersededCut = manager.getLeafId()!;
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage(5));
		manager.appendMessage(userMsg("TWO"));
		const a2 = manager.appendMessage(assistantMsg("answer two"));
		// The pin is the tip when summarization starts, and the cut is an ancestor of it:
		// that is the only shape prepareCompaction() can produce, and the one whose kept
		// tail [cut .. pin] a reopen has to be able to find.
		const pinned = manager.getLeafId();
		expect(pinned).toBe(a2);
		// A window append after the pin (a new child's first attribution).
		manager.appendChildUsageAttribution(a2, mockUsage(), mockUsage(6));
		expect(manager.getLeafId()).not.toBe(pinned);

		const { info } = commit(manager, "SUMMARY", supersededCut, pinned);
		expect(info.firstKeptRewritten).toBe(true);
		expect(info.firstKeptUnresolvable).toBe(false);
		expect(hasSummary(manager)).toBe(true);
		expect(contextText(manager)).toContain("TWO");

		const resumed = SessionManager.open(manager.getSessionFile()!);
		expect(hasSummary(resumed)).toBe(true);
		// Without the walk-back the reopened context is the summary alone: the kept tail
		// silently disappears because the cut id never landed on disk.
		expect(contextText(resumed)).toContain("TWO");
		const entry = resumed.getEntry(resumed.getLeafId()!) as CompactionEntry | undefined;
		expect(entry?.firstKeptEntryId).not.toBe(supersededCut);
	});

	it("keeps ten rounds of compaction with an attribution in every window on the live chain", () => {
		const manager = SessionManager.inMemory();
		const rounds = 10;
		let previous = manager.appendMessage(userMsg("seed"));
		for (let round = 1; round <= rounds; round++) {
			previous = manager.appendMessage(userMsg(`question ${round}`));
			const answer = manager.appendMessage(assistantMsg(`answer ${round}`));
			const pinned = manager.getLeafId();
			manager.appendChildUsageAttribution(answer, mockUsage(), mockUsage(round + 2));
			const { info } = commit(manager, `SUMMARY ${round}`, previous, pinned);
			expect(info.classification, `round ${round}`).toBe("same_branch_forward");
			// The live chain carries every summary committed so far, and the on-chain
			// count matches what is on disk: no round was parked on a side branch.
			const onChain = manager.getBranch().filter((entry) => entry.type === "compaction").length;
			const onDisk = manager.getEntries().filter((entry) => entry.type === "compaction").length;
			expect(onChain, `round ${round}`).toBe(round);
			expect(onDisk, `round ${round}`).toBe(round);
			expect(hasSummary(manager), `round ${round}`).toBe(true);
		}
		// The context does not grow without bound: the kept tail is bounded by the cut.
		expect(contextText(manager).length).toBeLessThanOrEqual(4);
	});

	it("does not throw when the pinned leaf is unknown, and says so in the classification", () => {
		const { manager, u1 } = seeded();
		const { id, info } = commit(manager, "SUMMARY", u1, "entry-that-never-existed");
		expect(info.classification).toBe("unknown_target_leaf");
		expect(manager.getEntry(id)?.parentId).toBe("entry-that-never-existed");
		// The live position is untouched: an unknown pin must not move the session.
		expect(manager.getLeafId()).not.toBe(id);
	});

	it("keeps the position cleared when the session was rewound to empty during the window", () => {
		const { manager, u1 } = seeded();
		const pinned = manager.getLeafId();
		manager.resetLeaf();
		expect(manager.getLeafId()).toBeNull();
		const { id, info } = commit(manager, "SUMMARY", u1, pinned);
		expect(info.classification).toBe("branch_navigation");
		expect(manager.getLeafId()).toBeNull();
		expect(manager.getBranch().map((entry) => entry.id)).not.toContain(id);
	});

	it("keeps the kept tail readable when navigating back to a summarized branch whose cut was a deferred merge", () => {
		// The load-bearing case for sharing the firstKeptEntryId walk-back across BOTH
		// branches. A summary parked on a side branch is not dead storage: branch() back
		// to it is a first-class feature, and a cut that names a deferred attribution
		// merge (an id that never reaches disk) would make the reopened kept tail vanish.
		// Positive control: move the walk-back inside the same-branch arm only and this
		// test goes red while every other case stays green.
		const manager = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
		const u1 = manager.appendMessage(userMsg("ONE"));
		const a1 = manager.appendMessage(assistantMsg("answer one"));
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage(3));
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage(4));
		const supersededCut = manager.getLeafId()!;
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage(5));
		manager.appendMessage(userMsg("TWO"));
		manager.appendMessage(assistantMsg("answer two"));
		// Pin at the tip; the cut is a deferred merge somewhere below it, so the kept tail
		// [cut .. pin] is exactly what a later visit to this branch has to reconstruct.
		const pinned = manager.getLeafId();

		// Real navigation away from the branch being summarized.
		manager.branch(u1);
		const other = manager.appendMessage(userMsg("a different question"));
		expect(manager.getLeafId()).toBe(other);

		const { id, info } = commit(manager, "NAVSUM", supersededCut, pinned);
		expect(info.classification).toBe("branch_navigation");
		expect(info.firstKeptRewritten).toBe(true);
		expect(info.firstKeptUnresolvable).toBe(false);

		// Reopen, then visit the summarized branch the way a user rewinding would.
		const resumed = SessionManager.open(manager.getSessionFile()!);
		resumed.branch(id);
		expect(hasSummary(resumed)).toBe(true);
		// Without the shared walk-back this is the summary alone: the cut names an id no
		// disk line carries, so buildSessionContext() never starts collecting the tail.
		expect(contextText(resumed)).toContain("TWO");
	});

	it("lands the summary on the branch the session rewound to when that branch is below the pin", () => {
		// Declared behaviour expansion (differs from HEAD on purpose): rewinding to a
		// DESCENDANT of the pin leaves the pin on the current chain, so this is a forward
		// same-branch commit and the summary belongs to the live chain - HEAD parked it on
		// a side branch because it only compared leaf identity.
		const manager = SessionManager.inMemory();
		const u1 = manager.appendMessage(userMsg("ONE"));
		const a1 = manager.appendMessage(assistantMsg("answer one"));
		manager.appendMessage(userMsg("TWO"));
		manager.appendMessage(assistantMsg("answer two"));
		const pinned = u1;

		manager.branch(a1);
		expect(manager.getLeafId()).toBe(a1);

		const { id, info } = commit(manager, "SUMMARY", u1, pinned);
		expect(info.classification).toBe("same_branch_forward");
		expect(manager.getLeafId()).toBe(id);
		expect(hasSummary(manager)).toBe(true);
		expect(manager.getBranch().map((entry) => entry.id)).toContain(id);
	});

	it("treats a label write in the window like any other same-branch append", () => {
		const { manager, u1, a1 } = seeded();
		const pinned = manager.getLeafId();
		// set_session_entry_label reaches appendLabelChange directly, with no gate that a
		// compaction window would close, so it is the realistic ungated window writer.
		manager.appendLabelChange(a1, "reviewed");
		const { id, info } = commit(manager, "SUMMARY", u1, pinned);
		expect(info.classification).toBe("same_branch_forward");
		expect(info.windowEntryTypesOnSummarizedBranch).toEqual(["label"]);
		expect(hasSummary(manager)).toBe(true);
		expect(manager.getLeafId()).toBe(id);
	});

	it("commits cleanly when the leaf is itself an unflushed deferred merge at commit time", () => {
		// LAT-4 x retarget intersection: the redirected parentId points at an id that only
		// exists in memory until the commit's own flush materialises it, so the reopen has
		// to resolve it. Verified correct by two review seats by probe; this pins it.
		const manager = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
		const u1 = manager.appendMessage(userMsg("ONE"));
		const a1 = manager.appendMessage(assistantMsg("answer one"));
		const pinned = manager.getLeafId();
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage(3));
		manager.appendChildUsageAttribution(a1, mockUsage(), mockUsage(4));
		const deferredLeaf = manager.getLeafId()!;
		expect(deferredLeaf).not.toBe(pinned);

		const { id, info } = commit(manager, "SUMMARY", u1, pinned);
		expect(info.classification).toBe("same_branch_forward");
		expect(manager.getEntry(id)?.parentId).toBe(deferredLeaf);

		const resumed = SessionManager.open(manager.getSessionFile()!);
		expect(resumed.getLeafId()).toBe(id);
		expect(hasSummary(resumed)).toBe(true);
		// The parent resolves on disk: the flush inside the commit wrote the merge row.
		const parentId = resumed.getEntry(id)?.parentId as string;
		expect(resumed.getEntry(parentId)).toBeDefined();
		expect(resumed.getBranch().map((entry) => entry.id)).toContain(parentId);
	});

	it("returns instead of spinning when the pinned chain is corrupt into a cycle", () => {
		// The cycle guard in _isOnCurrentBranch is the only thing between a corrupt
		// transcript and a hung commit. Built through the public load path: a hand-written
		// file whose parent pointers form a two-entry cycle, so walking up from the leaf
		// never terminates without the guard.
		const sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionId = "01cycle-test";
		const file = join(sessionDir, `${sessionId}.jsonl`);
		const stamp = new Date().toISOString();
		const lines = [
			{ type: "session", version: 3, id: sessionId, timestamp: stamp, cwd: tempDir },
			{ type: "session_info", id: "root-1", parentId: null, timestamp: stamp, name: "root" },
			{ type: "session_info", id: "b", parentId: "c", timestamp: stamp, name: "b" },
			{ type: "session_info", id: "c", parentId: "b", timestamp: stamp, name: "c" },
		];
		writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

		const manager = SessionManager.open(file, sessionDir);
		expect(manager.getLeafId()).toBe("c");

		const started = Date.now();
		const { info } = commit(manager, "SUMMARY", "root-1", "root-1");
		expect(Date.now() - started).toBeLessThan(1000);
		// root-1 is not reachable from the cyclic leaf, so this reads as a navigation: the
		// position is left alone instead of being dragged into the corrupt chain.
		expect(info.classification).toBe("branch_navigation");
		expect(manager.getLeafId()).toBe("c");
	});

	it("renders only the newest summary when one chain is compacted twice", () => {
		const { manager } = seeded();
		const u2 = manager.appendMessage(userMsg("TWO"));
		const first = commit(manager, "OLD SUMMARY", u2, manager.getLeafId());
		const a2 = manager.appendMessage(assistantMsg("answer two"));
		const second = commit(manager, "NEW SUMMARY", a2, manager.getLeafId());
		expect(first.info.classification).toBe("same_branch_no_window_append");
		expect(second.info.classification).toBe("same_branch_no_window_append");
		const summaries = manager.buildSessionContext().messages.filter((m) => m.role === "compactionSummary");
		expect(summaries.length).toBe(1);
	});
});
