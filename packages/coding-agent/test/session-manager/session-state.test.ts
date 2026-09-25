import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager, type SessionStateEntry } from "../../src/core/session-manager.js";
import { inactiveLifecycleForSession } from "../../src/modes/daemon/daemon-session-list.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager session state", () => {
	it("persists lifecycle state and exposes it through list", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			session.appendSessionState({ status: "crash" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const stateEntries = loadEntriesFromFile(sessionFile!).filter(
				(entry): entry is SessionStateEntry => entry.type === "session_state",
			);
			expect(stateEntries).toHaveLength(1);
			expect(stateEntries[0]!.state).toEqual({ status: "crash" });
			expect(session.getSessionState()).toEqual({ status: "crash" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "crash" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("flushes lifecycle state for sessions without assistant messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-empty-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendSessionInfo("empty");
			session.appendSessionState({ status: "archived" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				name: "empty",
				messageCount: 0,
				state: { status: "archived" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists renamed sessions without assistant messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-rename-empty-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			SessionManager.open(sessionFile!, sessionDir).appendSessionInfo("Renamed draft");

			await expect(SessionManager.list(cwd, sessionDir)).resolves.toEqual([
				expect.objectContaining({ id: session.getSessionId(), name: "Renamed draft" }),
			]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("folds the newest state entry: resume clears crash, archive overrides it", async () => {
		// Death-cause markers are ordered facts: a crash written by the reaper is
		// cleared by the resume path's {status:"active"} append (daemon-mode), and
		// a later manual archive still wins over both.
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-crash-clear-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			session.appendSessionState({ status: "crash" });
			const sessionFile = session.getSessionFile()!;

			// The crashed row is recoverable, not archived.
			let sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions[0]!.state).toEqual({ status: "crash" });
			expect(inactiveLifecycleForSession(sessions[0]!)).toBe("live");

			// Resume: the daemon appends {status:"active"} while binding the runtime.
			SessionManager.open(sessionFile, sessionDir).appendSessionState({ status: "active" });
			sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions[0]!.state).toEqual({ status: "active" });
			expect(inactiveLifecycleForSession(sessions[0]!)).toBe("live");

			// A manual archive after the crash still has the final word.
			SessionManager.open(sessionFile, sessionDir).appendSessionState({ status: "archived" });
			sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions[0]!.state).toEqual({ status: "archived" });
			expect(inactiveLifecycleForSession(sessions[0]!)).toBe("archived");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("archives a deactivated session that has no prior state entry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-deactivate-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile()!;

			const reopened = SessionManager.open(sessionFile, sessionDir);
			expect(reopened.getSessionState()).toBeUndefined();
			if (reopened.getSessionState()?.status !== "archived") {
				reopened.appendSessionState({ status: "archived" });
			}

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]!.state).toEqual({ status: "archived" });
			expect(inactiveLifecycleForSession(sessions[0]!)).toBe("archived");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// Guards the agents-view deactivate path: opening a deleted file and appending
	// would recreate a stub session at the old path, so the caller must skip it.
	it("recreates a stub when archiving a deleted file, which the existsSync guard prevents", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-deleted-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi")); // forces a flush to disk
			const sessionFile = session.getSessionFile()!;
			rmSync(sessionFile);
			expect(existsSync(sessionFile)).toBe(false);

			// Without the guard, the open+append recreates a fresh stub on disk.
			SessionManager.open(sessionFile, sessionDir).appendSessionState({ status: "archived" });
			expect(existsSync(sessionFile)).toBe(true);

			// The guard the caller uses skips a missing file, leaving nothing behind.
			rmSync(sessionFile);
			if (existsSync(sessionFile)) {
				SessionManager.open(sessionFile, sessionDir).appendSessionState({ status: "archived" });
			}
			expect(existsSync(sessionFile)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("coerces legacy sleep and hidden lifecycle state to archived on read", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-hidden-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hide me"));
			// Flush a header + state entry, then append the legacy raw "sleep"/"hidden"
			// entries older daemons wrote; both must normalize to "archived" on read.
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "sleep" } })}\n`);
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "hidden" } })}\n`);

			expect(SessionManager.open(sessionFile!, sessionDir).getSessionState()).toEqual({ status: "archived" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "archived" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the last valid status when the newest entry is unrecognized", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-bad-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hi"));
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "bogus" } })}\n`);

			expect(SessionManager.open(sessionFile!, sessionDir).getSessionState()).toEqual({ status: "active" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions[0]).toMatchObject({ id: session.getSessionId(), state: { status: "active" } });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not duplicate entries when lifecycle state is followed by a normal turn", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-turn-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendSessionState({ status: "archived" });
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("recreates the session directory when lifecycle state is the first persisted entry", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-dir-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			rmSync(sessionDir, { recursive: true, force: true });
			session.appendSessionState({ status: "archived" });

			expect(existsSync(sessionFile!)).toBe(true);
			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries[0]).toMatchObject({ type: "session", id: session.getSessionId() });
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("repairs a tail torn after open, then appends through the same descriptor's check", () => {
		// perfB③: the K3P-45 tail check rides the append descriptor now. A crash
		// since open can leave a torn tail behind the flushed state; the persist
		// path must catch the refusal, repair, and land the entry - never glue the
		// new record onto the torn one.
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-torn-append-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			// A crash between records leaves a torn final line (no terminator).
			appendFileSync(sessionFile!, '{"type":"message","id":"torn"');

			session.appendSessionState({ status: "archived" });

			// The torn tail was repaired away and the new entry landed after the two
			// intact messages; nothing glued onto the torn line.
			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rewrites the full session if the session file disappears after flushing", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-file-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			rmSync(sessionFile!, { force: true });
			session.appendSessionState({ status: "archived" });

			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries[0]).toMatchObject({ type: "session", id: session.getSessionId() });
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
