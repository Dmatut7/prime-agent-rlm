import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// generateId keeps the first 8 hex chars of a randomUUID draw, so hand out the
// same 8-char prefix on every pair of draws: the migration must notice the
// repeat and draw again instead of assigning the id twice. The rest of each
// UUID stays unique so other randomUUID callers (atomic temp file names) are
// unaffected.
const cryptoDraws = vi.hoisted(() => {
	let count = 0;
	const hex = (value: number, length: number) => value.toString(16).padStart(length, "0").slice(-length);
	return {
		randomUUID: (): string => {
			const draw = count++;
			const sharedPrefix = Math.floor(draw / 2);
			return `${hex(sharedPrefix, 8)}-${hex(draw, 4)}-4${hex(draw, 3)}-${hex(draw, 4)}-${hex(draw, 12)}`;
		},
	};
});

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, randomUUID: cryptoDraws.randomUUID };
});

import {
	type FileEntry,
	migrateSessionEntries,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.js";

const SESSION_ID = "v1-collision-session";
const MESSAGE_COUNT = 8;

function v1Entries(): FileEntry[] {
	const messages = [];
	for (let index = 0; index < MESSAGE_COUNT; index++) {
		const message =
			index % 2 === 0
				? { role: "user", content: `question ${index}`, timestamp: index }
				: {
						role: "assistant",
						content: [{ type: "text", text: `answer ${index}` }],
						api: "test",
						provider: "test",
						model: "test",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						stopReason: "stop",
						timestamp: index,
					};
		messages.push({ type: "message", timestamp: `2025-01-01T00:00:0${index}Z`, message });
	}
	// v1 entries carry no id/parentId: the migration assigns both.
	return [
		{ type: "session", id: SESSION_ID, timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" },
		...messages,
	] as FileEntry[];
}

function bodyEntries(entries: FileEntry[]): SessionEntry[] {
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

/** Parent walk bounded by a visited set, so a cycle fails the test instead of hanging it. */
function cycleFromLeaf(entries: SessionEntry[]): string[] | undefined {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) {
		byId.set(entry.id, entry);
	}
	const walk: string[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current) {
		if (seen.has(current.id)) return [...walk, current.id];
		seen.add(current.id);
		walk.push(current.id);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return undefined;
}

describe("migrateV1ToV2 id collisions", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createTempRoot(prefix: string): string {
		const root = mkdtempSync(join(tmpdir(), prefix));
		roots.push(root);
		return root;
	}

	it("remaps colliding generated ids so the migrated tree has no cycle", () => {
		const entries = v1Entries();

		migrateSessionEntries(entries);

		const migrated = bodyEntries(entries);
		expect(migrated).toHaveLength(MESSAGE_COUNT);
		const ids = migrated.map((entry) => entry.id);
		// Fails before the parent walk below can hang on a reintroduced collision.
		expect(new Set(ids).size).toBe(MESSAGE_COUNT);
		expect(cycleFromLeaf(migrated)).toBeUndefined();
		expect(migrated[0].parentId).toBeNull();
		for (let index = 1; index < migrated.length; index++) {
			expect(migrated[index].parentId).toBe(migrated[index - 1].id);
		}
	});

	it("loads a migrated v1 transcript whose id draws collided", () => {
		const root = createTempRoot("prime-v1-collision-");
		const sessionDir = join(root, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, `${SESSION_ID}.jsonl`);
		// v1 on disk: no version on the header, no id/parentId on the entries.
		const lines = v1Entries().map((entry) => JSON.stringify(entry));
		writeFileSync(sessionFile, `${lines.join("\n")}\n`);

		const manager = SessionManager.open(sessionFile, sessionDir);

		// The persisted migration result is cycle-free before anything walks it.
		const persisted = readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as FileEntry);
		expect(persisted[0]).toMatchObject({ type: "session", id: SESSION_ID, version: 3 });
		const persistedBody = bodyEntries(persisted);
		expect(persistedBody).toHaveLength(MESSAGE_COUNT);
		expect(new Set(persistedBody.map((entry) => entry.id)).size).toBe(MESSAGE_COUNT);
		expect(cycleFromLeaf(persistedBody)).toBeUndefined();

		expect(manager.getSessionId()).toBe(SESSION_ID);
		expect(manager.getEntries()).toHaveLength(MESSAGE_COUNT);
		// Both walk leaf-to-root through parentId; a cycle would never return.
		expect(manager.getBranch()).toHaveLength(MESSAGE_COUNT);
		expect(manager.buildSessionContext().messages).toHaveLength(MESSAGE_COUNT);
	});
});
