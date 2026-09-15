import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadEntriesFromFile,
	readSessionInfo,
	repairOwnedSessionFile,
	SessionManager,
} from "../../src/core/session-manager.js";

/**
 * A session file whose entire content is a valid header that lost its terminating
 * newline is not an empty file. Readers skip unterminated tails because a tail can
 * still be a write in flight, and the open path used to read "no indexable entry"
 * as "no session": it started a fresh session and rewrote the file in place under a
 * brand new id, which dropped parentSession/rlmDepth and left the file name pointing
 * at an id the transcript no longer contained.
 */

const SESSION_ID = "01unterminated-head-session";
const PARENT_SESSION = "/tmp/prime-parent/01unterminated-head-parent.jsonl";

function headerLine(): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id: SESSION_ID,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/tmp/prime-under-test",
		parentSession: PARENT_SESSION,
		rlmDepth: 3,
	});
}

const roots: string[] = [];

function sessionFile(content: string): { file: string; dir: string } {
	const root = mkdtempSync(join(tmpdir(), "prime-unterminated-head-"));
	roots.push(root);
	const dir = join(root, "sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${SESSION_ID}.jsonl`);
	writeFileSync(file, content);
	return { file, dir };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function parsedLines(file: string): Record<string, unknown>[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("opening a session header that lost its terminating newline", () => {
	it("loads the header instead of reading the file as empty", () => {
		const { file } = sessionFile(headerLine());
		const entries = loadEntriesFromFile(file);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: "session", id: SESSION_ID });
	});

	it("keeps the id and the lineage instead of rewriting the file with a new session", () => {
		const original = headerLine();
		const { file, dir } = sessionFile(original);
		const manager = SessionManager.open(file, dir);

		expect(manager.getSessionId()).toBe(SESSION_ID);
		expect(manager.getHeader()).toMatchObject({
			type: "session",
			id: SESSION_ID,
			version: 3,
			parentSession: PARENT_SESSION,
			rlmDepth: 3,
		});

		// The bytes that were already there survive verbatim; the only change the
		// repair may make is the terminator that every reader needs.
		const persisted = readFileSync(file, "utf8");
		expect(persisted.startsWith(original)).toBe(true);
		const lines = parsedLines(file);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ id: SESSION_ID, parentSession: PARENT_SESSION, rlmDepth: 3 });
	});

	it("appends on its own line instead of gluing onto the header", () => {
		const { file, dir } = sessionFile(headerLine());
		const manager = SessionManager.open(file, dir);
		manager.appendMessage({ role: "user", content: "after recovery", timestamp: 4 });
		manager.flushNow();

		const persisted = parsedLines(file);
		expect(persisted).toHaveLength(2);
		expect(persisted[0]).toMatchObject({ type: "session", id: SESSION_ID });
		expect(persisted[1]).toMatchObject({ type: "message" });
	});

	it("stays visible to the session list without the reader writing a byte", async () => {
		const original = headerLine();
		const { file } = sessionFile(original);
		const info = await readSessionInfo(file);
		expect(info).not.toBeNull();
		expect(info?.id).toBe(SESSION_ID);
		expect(info?.messageCount).toBe(0);
		// A read is a read: the listing path may not normalize anyone's file.
		expect(readFileSync(file, "utf8")).toBe(original);
	});

	it("keeps the header through the write owner's torn-tail repair", () => {
		const original = headerLine();
		const { file } = sessionFile(original);
		repairOwnedSessionFile(file);
		const lines = parsedLines(file);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ id: SESSION_ID, parentSession: PARENT_SESSION, rlmDepth: 3 });
	});

	it("positive control: a terminated header keeps id, lineage and every byte", () => {
		const original = `${headerLine()}\n`;
		const { file, dir } = sessionFile(original);
		const before = statSync(file);
		const manager = SessionManager.open(file, dir);

		expect(manager.getSessionId()).toBe(SESSION_ID);
		expect(manager.getHeader()).toMatchObject({ id: SESSION_ID, parentSession: PARENT_SESSION, rlmDepth: 3 });
		expect(readFileSync(file, "utf8")).toBe(original);
		const after = statSync(file);
		expect(after.size).toBe(before.size);
		expect(after.ino).toBe(before.ino);
	});

	it("positive control: a file with no valid header still starts a fresh session", () => {
		const { file, dir } = sessionFile(`{"not":"a header"`);
		const manager = SessionManager.open(file, dir);
		expect(manager.getSessionId()).not.toBe(SESSION_ID);
		expect(loadEntriesFromFile(file)[0]).toMatchObject({ id: manager.getSessionId() });
	});
});
