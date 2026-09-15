import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type buildSessionContext,
	loadEntriesFromFile,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

/**
 * LAT-4/LAT-5: LAT-3's coalesced child-usage ledger and agent_status no-op
 * dedupe were not branch- or disk-aware. A leaf move (rewind via branch(),
 * compaction via appendCompaction/branchWithSummary) or any persisted entry
 * (message, git_state, agent_status) landing while attribution merges were
 * deferred made the disk chain diverge from the in-memory chain: flush rows
 * referenced ids no disk line carried, rewound-past turns resurrected,
 * post-rewind messages disappeared from the model context, compactions were
 * bypassed, and two interleaved child targets collapsed the reloaded context
 * to zero messages. The same leaf move left lastAgentStatusWrite pointing at
 * an off-branch verdict, so a byte-identical re-publish was dropped.
 */

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

function danglingParentCount(file: string): { count: number; types: string[] } {
	const entries = loadEntriesFromFile(file).filter((e): e is SessionEntry => e.type !== "session");
	const ids = new Set(entries.map((e) => e.id));
	const dangling = entries.filter((e) => e.parentId != null && !ids.has(e.parentId as string));
	return { count: dangling.length, types: dangling.map((e) => e.type) };
}

describe("LAT-4/LAT-5: attribution windows across leaf moves, persisted entries and interleaved targets", () => {
	it("LAT-4 rewind: a post-rewind message survives a restart while the child keeps streaming", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "lat4-rewind-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const target = session.appendMessage(assistantMsg("parent turn"));
			// First attribution lands immediately; the second opens the window.
			session.appendChildUsageAttribution(target, usage(1, 0), usage(101, 0), "spawn_task");
			session.appendChildUsageAttribution(target, usage(1, 0), usage(102, 0), "spawn_task");

			// The user rewinds to the parent turn while the child is still streaming.
			session.branch(target);
			session.appendMessage(userMsg("after rewind"));
			// The child keeps streaming: the third merge hangs off the new turn.
			session.appendChildUsageAttribution(target, usage(1, 0), usage(103, 0), "spawn_task");

			const liveTexts = branchTexts(session.buildSessionContext());
			expect(liveTexts).toEqual(["parent turn", "after rewind"]);

			session.flushChildUsageAttributions();
			const file = session.getSessionFile()!;
			const reloaded = SessionManager.open(file, join(tempDir, "s"));
			expect(branchTexts(reloaded.buildSessionContext())).toEqual(liveTexts);
			expect(reloaded.getLeafId()).toBe(session.getLeafId());
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("LAT-4 rewind: the rewound-past turn must not come back after the deferred flush", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "lat4-resurrect-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const target = session.appendMessage(assistantMsg("parent turn"));
			session.appendMessage(userMsg("dropped turn"));
			session.appendChildUsageAttribution(target, usage(1, 0), usage(101, 0), "spawn_task");
			session.appendChildUsageAttribution(target, usage(1, 0), usage(102, 0), "spawn_task");

			// The user rewinds past the last turn; nothing else is appended.
			session.branch(target);
			const liveTexts = branchTexts(session.buildSessionContext());
			expect(liveTexts).toEqual(["parent turn"]);

			// The child run settles: the deferred window flushes behind the marker.
			session.flushChildUsageAttributions();
			const reloaded = SessionManager.open(session.getSessionFile()!, join(tempDir, "s"));
			expect(branchTexts(reloaded.buildSessionContext())).toEqual(liveTexts);
			expect(reloaded.getLeafId()).toBe(session.getLeafId());
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("LAT-4 interleave: persisted messages between interleaved child windows stay reachable and nothing dangles", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "lat4-interleave-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const targetA = session.appendMessage(assistantMsg("turn A"));
			const targetB = session.appendMessage(assistantMsg("turn B"));
			session.appendChildUsageAttribution(targetA, usage(2, 0), usage(52, 0), "spawn_task");
			session.appendChildUsageAttribution(targetB, usage(3, 0), usage(63, 0), "agent_message");
			// Two children stream concurrently while the conversation moves on.
			for (let round = 0; round < 8; round++) {
				session.appendChildUsageAttribution(targetA, usage(2, 0), usage(52 + 2 * round, 0), "spawn_task");
				session.appendChildUsageAttribution(targetB, usage(3, 0), usage(63 + 3 * round, 0), "agent_message");
				if (round === 2) session.appendMessage(userMsg("mid-window user turn"));
				if (round === 5) session.appendMessage(userMsg("second mid-window turn"));
			}
			const liveTexts = branchTexts(session.buildSessionContext());
			expect(liveTexts).toEqual(["turn A", "turn B", "mid-window user turn", "second mid-window turn"]);

			session.flushChildUsageAttributions();
			const file = session.getSessionFile()!;
			const dangling = danglingParentCount(file);
			expect(dangling.count).toBe(0);

			const reloaded = SessionManager.open(file, join(tempDir, "s"));
			expect(branchTexts(reloaded.buildSessionContext())).toEqual(liveTexts);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("LAT-4 interleave: a first attribution for a new target must not dangle off a deferred merge", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "lat4-firstattr-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const targetA = session.appendMessage(assistantMsg("turn A"));
			session.appendChildUsageAttribution(targetA, usage(2, 0), usage(52, 0), "spawn_task");
			// A deferred merge for A is the current leaf when child B starts.
			session.appendChildUsageAttribution(targetA, usage(2, 0), usage(54, 0), "spawn_task");
			const targetB = session.appendMessage(assistantMsg("turn B"));
			session.appendChildUsageAttribution(targetB, usage(3, 0), usage(63, 0), "agent_message");

			session.flushChildUsageAttributions();
			const dangling = danglingParentCount(session.getSessionFile()!);
			expect(dangling.count).toBe(0);
			expect(dangling.types).toEqual([]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("LAT-4 projection: a real-shaped interleaved replay leaves no dangling ids and an equal context", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "lat4-projection-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			// Four child targets streaming concurrently, bookkeeping and user
			// messages landing between their merges, windows rolling over the
			// 32-merge auto-flush bound - the shape the real 101,481-line
			// transcript replays found 1,386 dangling ids in.
			const targets: string[] = [];
			const expectedTexts: string[] = [];
			for (let t = 0; t < 4; t++) {
				targets.push(session.appendMessage(assistantMsg(`turn ${t}`)));
				expectedTexts.push(`turn ${t}`);
			}
			let round = 0;
			for (let i = 0; i < 200; i++) {
				for (let t = 0; t < 4; t++) {
					if ((i + t) % 7 === 3) continue; // arrival order varies per target
					session.appendChildUsageAttribution(
						targets[t],
						usage(1, 0),
						usage(100 + i, 0),
						t % 2 === 0 ? "spawn_task" : "agent_message",
					);
				}
				if (i % 37 === 5) {
					session.appendAgentStatus({
						summary: `verdict ${round}`,
						taskState: "needs_input",
						basedOnMessageCount: i,
					});
				}
				if (i % 53 === 11) {
					const text = `user turn ${round}`;
					session.appendMessage(userMsg(text));
					expectedTexts.push(text);
				}
				round += 1;
			}
			session.flushChildUsageAttributions();

			const file = session.getSessionFile()!;
			const dangling = danglingParentCount(file);
			expect(dangling.count).toBe(0);
			expect(dangling.types).toEqual([]);

			const liveTexts = branchTexts(session.buildSessionContext());
			expect(liveTexts).toEqual(expectedTexts);
			const reloaded = SessionManager.open(file, join(tempDir, "s"));
			expect(branchTexts(reloaded.buildSessionContext())).toEqual(liveTexts);
			// The deferred deltas survive the reload: the disk ledger folds the
			// same childUsage total as the live in-memory ledger.
			const liveChildSum = session
				.getEntries()
				.reduce((sum, entry) => sum + (entry.type === "child_usage_attributed" ? entry.childUsage.input : 0), 0);
			const childSum = loadEntriesFromFile(file).reduce(
				(sum, entry) => sum + (entry.type === "child_usage_attributed" ? entry.childUsage.input : 0),
				0,
			);
			expect(childSum).toBe(liveChildSum);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("LAT-4 control: a contiguous window still coalesces and reloads identically", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "lat4-control-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			const target = session.appendMessage(assistantMsg("parent turn"));
			const merges = 40;
			for (let i = 1; i <= merges; i++) {
				session.appendChildUsageAttribution(target, usage(1, 0), usage(100 + i, 0), "spawn_task");
			}
			session.flushChildUsageAttributions();
			const file = session.getSessionFile()!;
			// One line for the first attribution plus ceil((merges - 1) / 32) rows.
			const lines = loadEntriesFromFile(file).filter((e) => e.type === "child_usage_attributed").length;
			expect(lines).toBeLessThanOrEqual(1 + Math.ceil((merges - 1) / 32));
			const childSum = loadEntriesFromFile(file).reduce(
				(sum, entry) => sum + (entry.type === "child_usage_attributed" ? entry.childUsage.input : 0),
				0,
			);
			expect(childSum).toBe(merges);
			const reloaded = SessionManager.open(file, join(tempDir, "s"));
			expect(branchTexts(reloaded.buildSessionContext())).toEqual(["parent turn"]);
			const byId = new Map(reloaded.getEntries().map((e) => [e.id, e]));
			for (const entry of reloaded.getEntries()) {
				if (entry.parentId === null || entry.parentId === undefined) continue;
				expect(byId.has(entry.parentId)).toBe(true);
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("LAT-5 control: consecutive identical verdicts on the same branch still dedupe", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "lat5-control-"));
		try {
			const session = SessionManager.create(join(tempDir, "p"), join(tempDir, "s"));
			session.appendMessage(assistantMsg("status turn"));
			const sameStatus = { summary: "same verdict", taskState: "completed" as const, basedOnMessageCount: 2 };
			const first = session.appendAgentStatus(sameStatus);
			session.appendAgentStatus(sameStatus);
			session.appendAgentStatus(sameStatus);
			expect(session.appendAgentStatus(sameStatus)).toBe(first);

			const reloaded = SessionManager.open(session.getSessionFile()!, join(tempDir, "s"));
			const statuses = reloaded.getEntries().filter((e) => e.type === "agent_status");
			expect(statuses).toHaveLength(1);
			expect(reloaded.getLatestAgentStatus()?.summary).toBe("same verdict");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
