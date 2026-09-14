import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

/** Model-visible text of every message in a session context, in order. */
function contextText(messages: readonly unknown[]): string[] {
	return messages.map((message) => {
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((block): block is { type: "text"; text: string } => {
				return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
			})
			.map((block) => block.text)
			.join("");
	});
}

/**
 * Rewind position durability.
 *
 * `--resume` resolves the active leaf from the last line of the session file, so a
 * rewind that only lives in process memory is silently undone by a restart: the
 * abandoned turn comes back into the model context. These are the entry-level
 * tests for that guarantee; `branch()`/`resetLeaf()` followed by a reopen of the
 * same file is exactly the `open -> _buildIndex` path resume takes.
 */
describe("SessionManager rewind position survives a restart", () => {
	let tempDir: string;
	let ids: { u1: string; a1: string; u2: string; a2: string };

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "rewind-position-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Builds u1 -> a1 -> u2 -> a2 in a persisted session and returns its file. */
	function createFourTurnSession(): { manager: SessionManager; file: string } {
		const manager = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
		const u1 = manager.appendMessage(userMsg("ONE"));
		const a1 = manager.appendMessage(assistantMsg("ok"));
		const u2 = manager.appendMessage(userMsg("TWO"));
		const a2 = manager.appendMessage(assistantMsg("ok"));
		ids = { u1, a1, u2, a2 };
		return { manager, file: manager.getSessionFile()! };
	}

	it("restores the rewound leaf when nothing is appended before the restart", () => {
		const { manager, file } = createFourTurnSession();
		manager.branch(ids.u1);
		const rewoundLeafId = manager.getLeafId();
		expect(rewoundLeafId).toBe(ids.u1);
		expect(contextText(manager.buildSessionContext().messages)).toEqual(["ONE"]);

		// Reopen the way --resume does, with no append in between.
		const resumed = SessionManager.open(file);
		expect(resumed.getLeafId()).toBe(rewoundLeafId);
		expect(contextText(resumed.buildSessionContext().messages)).toEqual(["ONE"]);
	});

	it("restores a cleared leaf when resetLeaf is followed by a restart", () => {
		const { manager, file } = createFourTurnSession();
		manager.resetLeaf();
		expect(manager.getLeafId()).toBeNull();
		expect(manager.buildSessionContext().messages).toEqual([]);

		const resumed = SessionManager.open(file);
		expect(resumed.getLeafId()).toBeNull();
		expect(resumed.buildSessionContext().messages).toEqual([]);
	});

	it("keeps appends after a restart on the rewound branch", () => {
		const { manager, file } = createFourTurnSession();
		manager.branch(ids.u1);

		const resumed = SessionManager.open(file);
		const continued = resumed.appendMessage(userMsg("THREE"));
		expect(resumed.getEntry(continued)?.parentId).toBe(ids.u1);
		expect(contextText(resumed.buildSessionContext().messages)).toEqual(["ONE", "THREE"]);

		// The append itself anchors the position, and the abandoned turn stays gone.
		const reopened = SessionManager.open(file);
		expect(reopened.getLeafId()).toBe(continued);
		expect(contextText(reopened.buildSessionContext().messages)).toEqual(["ONE", "THREE"]);
	});

	it("records the position as its own entry and keeps it out of the model context", () => {
		const { manager, file } = createFourTurnSession();
		manager.branch(ids.u1);

		const markers = loadEntriesFromFile(file).filter((entry) => entry.type === "leaf_position");
		expect(markers).toHaveLength(1);
		expect(markers[0]).toMatchObject({ type: "leaf_position", targetId: ids.u1, parentId: ids.u1 });

		// The marker describes the leaf; it is not the leaf and not a message.
		expect(manager.getLeafId()).toBe(ids.u1);
		expect(manager.getEntry(manager.getLeafId()!)?.type).toBe("message");
		expect(contextText(manager.buildSessionContext().messages)).toEqual(["ONE"]);
	});

	it("resolves a transcript without a position marker by its last line", () => {
		const { manager, file } = createFourTurnSession();
		manager.branch(ids.u1);

		// Same transcript written by a build that predates the marker: the old
		// "last line wins" rule must still decide the position.
		const legacyFile = join(tempDir, "legacy.jsonl");
		const lines = readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0 && !line.includes('"leaf_position"'));
		writeFileSync(legacyFile, `${lines.join("\n")}\n`, { mode: 0o600 });

		const legacy = SessionManager.open(legacyFile);
		expect(legacy.getLeafId()).toBe(ids.a2);
		expect(contextText(legacy.buildSessionContext().messages)).toEqual(["ONE", "ok", "TWO", "ok"]);
	});

	it("ignores a position marker whose target is not in the transcript", () => {
		const { file } = createFourTurnSession();

		// A damaged or hand-edited file can carry a marker pointing nowhere; the
		// last line rule decides then, because inventing a position is worse.
		const damagedFile = join(tempDir, "damaged-target.jsonl");
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		lines.push(
			JSON.stringify({
				type: "leaf_position",
				id: "missing-target",
				parentId: null,
				timestamp: new Date().toISOString(),
				targetId: "not-in-this-file",
			}),
		);
		writeFileSync(damagedFile, `${lines.join("\n")}\n`, { mode: 0o600 });

		const damaged = SessionManager.open(damagedFile);
		expect(damaged.getLeafId()).toBe(ids.a2);
		expect(contextText(damaged.buildSessionContext().messages)).toEqual(["ONE", "ok", "TWO", "ok"]);
	});

	it("keeps the position when a pinned compaction lands after a rewind", () => {
		const { manager, file } = createFourTurnSession();
		manager.branch(ids.u1);

		// A compaction prepared for the branch the session has left: it is appended
		// after the rewind and must not drag the position back on resume.
		manager.appendCompaction("summary of the abandoned branch", ids.a2, 4200, undefined, undefined, undefined, {
			leafId: ids.a2,
		});
		expect(manager.getLeafId()).toBe(ids.u1);

		const resumed = SessionManager.open(file);
		expect(resumed.getLeafId()).toBe(ids.u1);
		expect(contextText(resumed.buildSessionContext().messages)).toEqual(["ONE"]);
	});

	it("records a rewind that happens before the first assistant reply", () => {
		const manager = SessionManager.create(join(tempDir, "project"), join(tempDir, "sessions"));
		const u1 = manager.appendMessage(userMsg("ONE"));
		manager.appendMessage(userMsg("TWO"));
		const file = manager.getSessionFile()!;
		// Without an assistant message the session is not written yet.
		expect(existsSync(file)).toBe(false);

		manager.branch(u1);

		const resumed = SessionManager.open(file);
		expect(resumed.getLeafId()).toBe(u1);
		expect(contextText(resumed.buildSessionContext().messages)).toEqual(["ONE"]);
	});
});
