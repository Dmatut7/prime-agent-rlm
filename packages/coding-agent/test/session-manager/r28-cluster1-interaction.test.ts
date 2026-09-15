import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildSessionContext,
	loadEntriesFromFile,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

type Ctx = ReturnType<typeof buildSessionContext>;
function branchTexts(context: Ctx): string[] {
	return context.messages.map((m) => {
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
				.join("");
		}
		return "";
	});
}

describe("r28 cluster1: LAT-3 write-path merge x leaf moves", () => {
	it("C1-A: a rewind re-publishing the identical verdict must land on the active branch", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "r28-c1a-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const m1 = session.appendMessage(userMsg("first"));
			session.appendMessage(assistantMsg("reply"));

			const status = { summary: "Added login endpoint", taskState: "completed" as const, basedOnMessageCount: 2 };
			session.appendAgentStatus(status);
			expect(session.getLatestAgentStatus()?.summary).toBe(status.summary);

			// User rewinds to the first message; the status entry is now off-branch.
			session.branch(m1);
			expect(session.getLatestAgentStatus()).toBeUndefined();

			// Re-publish the very same verdict the summarizer already holds for the
			// now-shorter active branch. Before LAT-3 this appended a new entry
			// reachable from the new leaf; with the no-op dedupe it is dropped
			// because the dedupe key (lastAgentStatusWrite) is not branch-aware.
			session.appendAgentStatus(status);
			expect(session.getLatestAgentStatus()?.summary).toBe(status.summary);

			const reloaded = SessionManager.open(session.getSessionFile()!, join(tempDir, "s"));
			expect(reloaded.getLatestAgentStatus()?.summary).toBe(status.summary);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("C1-A-control: a DIFFERENT verdict after a rewind does land (branch() itself is healthy)", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "r28-c1a-ctrl-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const m1 = session.appendMessage(userMsg("first"));
			session.appendMessage(assistantMsg("reply"));
			session.appendAgentStatus({ summary: "Added login endpoint", taskState: "completed", basedOnMessageCount: 2 });
			session.branch(m1);
			expect(session.getLatestAgentStatus()).toBeUndefined();
			session.appendAgentStatus({ summary: "control", taskState: undefined, basedOnMessageCount: 1 });
			expect(session.getLatestAgentStatus()?.summary).toBe("control");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("C1-B: a deferred attribution flush after a leaf move must not splice the disk chain back into the abandoned branch", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "r28-c1b-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const target = session.appendMessage(assistantMsg("parent turn"));
			// First attribution lands immediately (unchanged behavior).
			session.appendChildUsageAttribution(target, usage(1, 0), usage(101, 0), "spawn_task");
			// Second one is deferred; pending.firstParentId is captured here.
			session.appendChildUsageAttribution(target, usage(1, 0), usage(102, 0), "spawn_task");

			// The session moves its leaf (a rewind, or branchWithSummary from a
			// compaction) while the child keeps streaming usage.
			const u2 = session.appendMessage(userMsg("after rewind"));
			session.branch(u2);

			// Third merge hangs off the NEW leaf in memory.
			session.appendChildUsageAttribution(target, usage(1, 0), usage(103, 0), "spawn_task");
			const liveLeaf = session.getLeafId();
			const liveTexts = branchTexts(buildSessionContext(session.getEntries(), liveLeaf));

			const flush = (session as SessionManager & { flushChildUsageAttributions?: () => void })
				.flushChildUsageAttributions;
			if (flush) flush.call(session);

			const file = session.getSessionFile()!;
			const reloadedEntries = loadEntriesFromFile(file);
			const coalesced = reloadedEntries.filter((e) => e.type === "child_usage_attributed");
			expect(coalesced.length).toBeGreaterThanOrEqual(2);

			const reloaded = SessionManager.open(file, join(tempDir, "s"));
			const reloadedTexts = branchTexts(buildSessionContext(reloaded.getEntries(), reloaded.getLeafId()));
			// The active branch must not flip across a restart.
			expect(reloadedTexts).toEqual(liveTexts);
			expect(liveTexts).toContain("after rewind");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("C1-C: a deferred attribution flush across a compaction must not bypass the compaction entry on reload", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "r28-c1c-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const target = session.appendMessage(assistantMsg("parent turn"));
			session.appendChildUsageAttribution(target, usage(1, 0), usage(101, 0), "spawn_task");
			// Second merge is deferred; pending.firstParentId is captured here
			// (pre-compaction).
			session.appendChildUsageAttribution(target, usage(1, 0), usage(102, 0), "spawn_task");

			// A routine compaction lands mid-window and advances the leaf.
			const compactionId = session.appendCompaction("summary of everything above", target, 5000);

			// The child keeps streaming: third merge hangs off the compaction entry.
			session.appendChildUsageAttribution(target, usage(1, 0), usage(103, 0), "spawn_task");
			expect(session.getLeafId()).not.toBe(compactionId);

			const flush = (session as SessionManager & { flushChildUsageAttributions?: () => void })
				.flushChildUsageAttributions;
			if (flush) flush.call(session);

			const file = session.getSessionFile()!;
			const reloaded = SessionManager.open(file, join(tempDir, "s"));
			const reloadedBranch = reloaded.getBranch(reloaded.getLeafId()!);
			const branchTypes = reloadedBranch.map((e) => e.type);
			// The reloaded active branch must still carry the compaction entry,
			// otherwise buildSessionContext re-includes the compacted-away history.
			expect(branchTypes).toContain("compaction");
			const liveBranch = session.getBranch(session.getLeafId()!).map((e) => e.type);
			expect(branchTypes).toEqual(liveBranch);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("C1-D: two concurrently streaming children must not leave dangling parentIds or collapse the reloaded context", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "r28-c1d-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const targetA = session.appendMessage(assistantMsg("turn A"));
			const targetB = session.appendMessage(assistantMsg("turn B"));
			// Two children streaming usage concurrently: their merges interleave,
			// so each target's window captures a firstParentId that belongs to the
			// OTHER target's merged-away (never persisted) in-memory entry.
			for (let i = 1; i <= 40; i++) {
				session.appendChildUsageAttribution(targetA, usage(2, 0), usage(50 + 2 * i, 0), "spawn_task");
				session.appendChildUsageAttribution(targetB, usage(3, 0), usage(60 + 3 * i, 0), "agent_message");
			}
			const flush = (session as SessionManager & { flushChildUsageAttributions?: () => void })
				.flushChildUsageAttributions;
			if (flush) flush.call(session);

			const file = session.getSessionFile()!;
			const diskEntries = loadEntriesFromFile(file).filter((e): e is SessionEntry => e.type !== "session");
			const ids = new Set(diskEntries.map((e) => e.id));
			const dangling = diskEntries.filter((e) => e.parentId != null && !ids.has(e.parentId as string));
			expect(dangling.map((e) => e.type)).toEqual([]);

			const liveCtx = buildSessionContext(session.getEntries(), session.getLeafId());
			const reloaded = SessionManager.open(file, join(tempDir, "s"));
			const reloadedCtx = buildSessionContext(reloaded.getEntries(), reloaded.getLeafId());
			expect(reloadedCtx.messages.length).toBe(liveCtx.messages.length);
			expect(liveCtx.messages.length).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
