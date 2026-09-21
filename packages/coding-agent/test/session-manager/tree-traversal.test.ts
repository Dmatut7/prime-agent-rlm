import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { type SessionEntry, SessionManager, type SessionTreeNode } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

/** Child entry ids of a tree node that represent turns, i.e. excluding metadata. */
function turnIds(node: SessionTreeNode): string[] {
	return node.children
		.filter((child) => child.entry.type !== "leaf_position")
		.map((child) => child.entry.id)
		.sort();
}

/** Child entries of a tree node that record a rewind position (`leaf_position`). */
function positionMarkers(node: SessionTreeNode): string[] {
	return node.children.filter((child) => child.entry.type === "leaf_position").map((child) => child.entry.id);
}

describe("SessionManager append and tree traversal", () => {
	describe("append operations", () => {
		const cases: Array<{
			name: string;
			seed: (session: SessionManager) => string[];
			append: (session: SessionManager) => string;
			type: string;
			expectEntry?: (entry: SessionEntry, seedIds: string[]) => void;
		}> = [
			{
				name: "appendMessage creates entry with correct parentId chain",
				seed: (session) => [session.appendMessage(userMsg("first"))],
				append: (session) => session.appendMessage(assistantMsg("second")),
				type: "message",
			},
			{
				name: "appendThinkingLevelChange integrates into tree",
				seed: (session) => [session.appendMessage(userMsg("hello"))],
				append: (session) => session.appendThinkingLevelChange("high"),
				type: "thinking_level_change",
				expectEntry: (entry) => expect(entry).toMatchObject({ thinkingLevel: "high" }),
			},
			{
				name: "appendModelChange integrates into tree",
				seed: (session) => [session.appendMessage(userMsg("hello"))],
				append: (session) => session.appendModelChange("openai", "gpt-4"),
				type: "model_change",
				expectEntry: (entry) => expect(entry).toMatchObject({ provider: "openai", modelId: "gpt-4" }),
			},
			{
				name: "appendCompaction integrates into tree and persists customInstructions",
				seed: (session) => {
					const firstId = session.appendMessage(userMsg("1"));
					return [firstId, session.appendMessage(assistantMsg("2"))];
				},
				append: (session) =>
					session.appendCompaction(
						"summary",
						session.getEntries()[0]!.id,
						1000,
						undefined,
						undefined,
						"focus on xyz",
					),
				type: "compaction",
				expectEntry: (entry, seedIds) =>
					expect(entry).toMatchObject({
						summary: "summary",
						firstKeptEntryId: seedIds[0],
						tokensBefore: 1000,
						customInstructions: "focus on xyz",
					}),
			},
			{
				name: "appendCustomEntry integrates into tree",
				seed: (session) => [session.appendMessage(userMsg("hello"))],
				append: (session) => session.appendCustomEntry("my_data", { key: "value" }),
				type: "custom",
				expectEntry: (entry) => expect(entry).toMatchObject({ customType: "my_data", data: { key: "value" } }),
			},
		];
		it.each(cases)("$name", ({ seed, append, type, expectEntry }) => {
			const session = SessionManager.inMemory();
			const seedIds = seed(session);
			const appendedId = append(session);
			const followingId = session.appendMessage(userMsg("after"));

			const entries = session.getEntries();
			const appended = entries.find((e) => e.id === appendedId)!;
			expect(appended.type).toBe(type);
			expect(appended.parentId).toBe(seedIds.at(-1) ?? null);
			expectEntry?.(appended, seedIds);
			// The entry after the appended one parents to it, pinning the chain.
			expect(entries.find((e) => e.id === followingId)?.parentId).toBe(appendedId);
		});
	});

	describe("getPath", () => {
		it("returns full path from root to leaf", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendThinkingLevelChange("high");
			const id4 = session.appendMessage(userMsg("3"));

			const path = session.getBranch();
			expect(path).toHaveLength(4);
			expect(path.map((e) => e.id)).toEqual([id1, id2, id3, id4]);
		});
	});

	describe("getTree", () => {
		it("returns empty array for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getTree()).toEqual([]);
		});

		it("returns tree with branches after branch", () => {
			const session = SessionManager.inMemory();

			const id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendMessage(userMsg("3"));

			session.branch(id2);
			const id4 = session.appendMessage(userMsg("4-branch"));

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0];
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);

			const node2 = root.children[0];
			expect(node2.entry.id).toBe(id2);
			// id3 and id4 are siblings of each other; the rewind that produced id4
			// also records a leaf_position marker under id2, which is metadata, not a turn.
			expect(turnIds(node2)).toEqual([id3, id4].sort());
			expect(positionMarkers(node2)).toHaveLength(1);
		});

		it("handles deep branching", () => {
			const session = SessionManager.inMemory();

			// Main path: 1 -> 2 -> 3 -> 4
			const _id1 = session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));
			const id3 = session.appendMessage(userMsg("3"));
			const _id4 = session.appendMessage(assistantMsg("4"));

			session.branch(id2);
			const id5 = session.appendMessage(userMsg("5"));
			const id6 = session.appendMessage(assistantMsg("6"));

			// Branch from 5: 5 -> 7
			session.branch(id5);
			const id7 = session.appendMessage(userMsg("7"));

			const tree = session.getTree();

			const node2 = tree[0].children[0];
			expect(turnIds(node2)).toEqual([id3, id5].sort()); // both rewinds hang off node2
			expect(positionMarkers(node2)).toHaveLength(1);

			const node5 = node2.children.find((c) => c.entry.id === id5)!;
			expect(turnIds(node5)).toEqual([id6, id7].sort());
			expect(positionMarkers(node5)).toHaveLength(1);

			const node3 = node2.children.find((c) => c.entry.id === id3)!;
			expect(node3.children).toHaveLength(1); // id4, no rewind under it
		});
	});

	describe("branch", () => {
		it("throws for non-existent entry", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));

			expect(() => session.branch("nonexistent")).toThrow("Entry nonexistent not found");
		});
	});

	describe("branchWithSummary", () => {
		it("throws for non-existent entry", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));

			expect(() => session.branchWithSummary("nonexistent", "summary")).toThrow("Entry nonexistent not found");
		});
	});

	describe("getLeafEntry", () => {
		it("returns undefined for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getLeafEntry()).toBeUndefined();
		});

		it("returns current leaf entry", () => {
			const session = SessionManager.inMemory();

			session.appendMessage(userMsg("1"));
			const id2 = session.appendMessage(assistantMsg("2"));

			const leaf = session.getLeafEntry();
			expect(leaf).toBeDefined();
			expect(leaf!.id).toBe(id2);
		});
	});

	describe("getEntry", () => {
		it("returns undefined for non-existent id", () => {
			const session = SessionManager.inMemory();
			expect(session.getEntry("nonexistent")).toBeUndefined();
		});
	});

	describe("buildSessionContext with branches", () => {
		it("returns messages from current branch only", () => {
			const session = SessionManager.inMemory();

			// Main: 1 -> 2 -> 3
			session.appendMessage(userMsg("msg1"));
			const id2 = session.appendMessage(assistantMsg("msg2"));
			session.appendMessage(userMsg("msg3"));

			session.branch(id2);
			session.appendMessage(assistantMsg("msg4-branch"));

			const ctx = session.buildSessionContext();
			expect(ctx.messages).toHaveLength(3); // msg1, msg2, msg4-branch (not msg3)

			expect((ctx.messages[0] as any).content).toBe("msg1");
			expect((ctx.messages[1] as any).content[0].text).toBe("msg2");
			expect((ctx.messages[2] as any).content[0].text).toBe("msg4-branch");
		});
	});
});

describe("createBranchedSession", () => {
	it("throws for non-existent entry", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("hello"));

		expect(() => session.createBranchedSession("nonexistent")).toThrow("Entry nonexistent not found");
	});

	it("extracts correct path from branched tree", () => {
		const session = SessionManager.inMemory();

		const id1 = session.appendMessage(userMsg("1"));
		const id2 = session.appendMessage(assistantMsg("2"));
		session.appendMessage(userMsg("3"));

		session.branch(id2);
		const id4 = session.appendMessage(userMsg("4"));
		const id5 = session.appendMessage(assistantMsg("5"));

		// In-memory branching rebuilds this session (no new file): the entries become the path to id5.
		expect(session.createBranchedSession(id5)).toBeUndefined();

		const entries = session.getEntries();
		expect(entries).toHaveLength(4);
		expect(entries.map((e) => e.id)).toEqual([id1, id2, id4, id5]);
	});

	it("does not duplicate entries when forking from first user message", () => {
		const tempDir = join(tmpdir(), `session-fork-dedup-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		try {
			const session = SessionManager.create(tempDir, tempDir);
			const id1 = session.appendMessage(userMsg("first question"));
			session.appendMessage(assistantMsg("first answer"));
			session.appendMessage(userMsg("second question"));
			session.appendMessage(assistantMsg("second answer"));

			// Fork from the very first user message (no assistant in the branched path)
			const newFile = session.createBranchedSession(id1);
			expect(newFile).toBeDefined();

			// The branched path has no assistant, so the file should not exist yet
			// (deferred to _persist on first assistant, matching newSession() contract)
			expect(existsSync(newFile!)).toBe(false);

			// Simulate extension adding entry before assistant (like preset on turn_start)
			session.appendCustomEntry("preset-state", { name: "plan" });

			// Now the assistant responds
			session.appendMessage(assistantMsg("new answer"));

			expect(existsSync(newFile!)).toBe(true);
			const content = readFileSync(newFile!, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			const records = lines.map((line) => JSON.parse(line));

			expect(records.filter((r) => r.type === "session")).toHaveLength(1);

			const entryIds = records
				.filter((r) => r.type !== "session")
				.map((r) => r.id)
				.filter((id): id is string => typeof id === "string");
			expect(new Set(entryIds).size).toBe(entryIds.length);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("writes file immediately when forking from a point with assistant messages", () => {
		const tempDir = join(tmpdir(), `session-fork-with-assistant-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		try {
			const session = SessionManager.create(tempDir, tempDir);
			session.appendMessage(userMsg("first question"));
			const id2 = session.appendMessage(assistantMsg("first answer"));
			session.appendMessage(userMsg("second question"));
			session.appendMessage(assistantMsg("second answer"));

			// Fork including the assistant message
			const newFile = session.createBranchedSession(id2);
			expect(newFile).toBeDefined();

			expect(existsSync(newFile!)).toBe(true);
			const content = readFileSync(newFile!, "utf-8");
			const lines = content.trim().split("\n").filter(Boolean);
			const records = lines.map((line) => JSON.parse(line));
			expect(records.filter((r) => r.type === "session")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
