import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import {
	artifactDirectoryWriteMs,
	clearSessionArtifactTombstone,
	readSessionArtifactTombstones,
	recordSessionArtifactTombstone,
	resetSessionArtifactTombstoneCache,
	sessionArtifactTombstonePath,
	tombstoneInForce,
} from "../src/core/session-artifact-tombstones.js";
import { deleteSessionArtifacts, deleteSessionFile } from "../src/core/session-file-actions.js";
import { SessionManager } from "../src/core/session-manager.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	resetSessionArtifactTombstoneCache();
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "retention-root-fix-"));
	roots.push(root);
	return root;
}

function createSession(
	root: string,
	name: string,
): { manager: SessionManager; sessionFile: string; artifactDir: string } {
	const projectDir = join(root, name);
	mkdirSync(projectDir, { recursive: true });
	const manager = SessionManager.create(projectDir, join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("fixture session did not persist");
	const artifactDir = manager.ensureSessionArtifactDir();
	if (!artifactDir) throw new Error("fixture session has no artifact dir");
	return { manager, sessionFile, artifactDir };
}

describe("session artifact tombstones", () => {
	it("records, reads back, and clears a tombstone", () => {
		const root = tempRoot();
		const artifactRoot = join(root, "session-artifacts");
		mkdirSync(artifactRoot, { recursive: true });
		expect(recordSessionArtifactTombstone(artifactRoot, "abc12345", { now: new Date(0) })).toBe(true);
		resetSessionArtifactTombstoneCache();
		const tombstone = readSessionArtifactTombstones(artifactRoot).get("abc12345");
		expect(tombstone?.deletedAt).toBe(new Date(0).toISOString());
		expect(tombstoneInForce(tombstone, Date.parse(new Date(0).toISOString()))).toBe(true);
		clearSessionArtifactTombstone(artifactRoot, "abc12345");
		resetSessionArtifactTombstoneCache();
		expect(readSessionArtifactTombstones(artifactRoot).size).toBe(0);
	});

	it("refuses an id that is not a session id, so a tombstone cannot name a structural file", () => {
		const root = tempRoot();
		mkdirSync(join(root, "session-artifacts"), { recursive: true });
		expect(recordSessionArtifactTombstone(join(root, "session-artifacts"), ".session-tombstones")).toBe(false);
		expect(existsSync(sessionArtifactTombstonePath(join(root, "session-artifacts")))).toBe(false);
	});

	it("ignores a malformed log instead of failing a read", () => {
		const root = tempRoot();
		const artifactRoot = join(root, "session-artifacts");
		mkdirSync(artifactRoot, { recursive: true });
		writeFileSync(sessionArtifactTombstonePath(artifactRoot), '{ not json\n{"version":1}\n');
		resetSessionArtifactTombstoneCache();
		expect(readSessionArtifactTombstones(artifactRoot).size).toBe(0);
	});
});

describe("deleting a session stays deleted (round-08 S1 red test R-1/R-6)", () => {
	it("does not recreate the artifact directory from a read path", async () => {
		const root = tempRoot();
		const { manager, sessionFile, artifactDir } = createSession(root, "project");
		writeFileSync(join(artifactDir, "kernel-state.dill"), "payload");

		expect((await deleteSessionFile(sessionFile)).ok).toBe(true);
		expect(existsSync(artifactDir)).toBe(false);

		// The paths the daemon uses on registration and dashboard reads. A read path
		// returns the lexical path (the directory is gone, so nothing is canonicalised).
		const lexicalPath = join(root, "session-artifacts", manager.getSessionId());
		expect(manager.getSessionArtifactDir()).toBe(lexicalPath);
		expect(existsSync(artifactDir)).toBe(false);
		expect(manager.getSessionArtifactDir({ create: true })).toBe(lexicalPath);
		expect(existsSync(artifactDir)).toBe(false);
	});

	it("lets a session that reuses the id write again (tombstone is not a permanent ban)", async () => {
		const root = tempRoot();
		const { manager, sessionFile, artifactDir } = createSession(root, "project");
		expect((await deleteSessionFile(sessionFile)).ok).toBe(true);

		const recreated = manager.ensureSessionArtifactDir();
		expect(recreated).toBe(artifactDir);
		expect(existsSync(artifactDir)).toBe(true);
		resetSessionArtifactTombstoneCache();
		expect(readSessionArtifactTombstones(join(root, "session-artifacts")).size).toBe(0);
		expect(manager.getSessionArtifactDir({ create: true })).toBe(artifactDir);
	});

	it("suppresses creation while the tombstone is still in force", async () => {
		const root = tempRoot();
		const manager = SessionManager.create(join(root, "project"), join(root, "sessions"));
		const sessionId = manager.getSessionId();
		const artifactRoot = join(root, "session-artifacts");
		mkdirSync(artifactRoot, { recursive: true });
		recordSessionArtifactTombstone(artifactRoot, sessionId, { now: new Date(Date.now() + 1000) });
		expect(manager.getSessionArtifactDir({ create: true })).toBe(join(artifactRoot, sessionId));
		expect(existsSync(join(artifactRoot, sessionId))).toBe(false);
	});

	it("writes the tombstone before the remove, so a crash still suppresses the directory", async () => {
		const root = tempRoot();
		const { sessionFile, artifactDir } = createSession(root, "project");
		await deleteSessionFile(sessionFile);
		expect(readSessionArtifactTombstones(join(root, "session-artifacts")).size).toBe(1);
		expect(existsSync(artifactDir)).toBe(false);
		expect(artifactDirectoryWriteMs(artifactDir)).toBeUndefined();
	});
});

describe("cron store drops a deleted session's registration", () => {
	it("stops recreating the store directory and forgets the session", async () => {
		const root = tempRoot();
		const { manager, sessionFile, artifactDir } = createSession(root, "project");
		const sessionId = manager.getSessionId();
		writeFileSync(join(artifactDir, "scheduled-jobs.json"), '{"jobs":[],"dispatches":[]}\n');
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(sessionId, artifactDir);
		expect(store.list()).toEqual([]);

		expect((await deleteSessionFile(sessionFile)).ok).toBe(true);
		// Both registration read paths must leave the directory gone.
		store.recoverSessionArtifact(sessionId);
		store.list();
		expect(existsSync(artifactDir)).toBe(false);
	});

	it("keeps the registration when the directory was written after the delete", async () => {
		const root = tempRoot();
		const { manager, sessionFile, artifactDir } = createSession(root, "project");
		const sessionId = manager.getSessionId();
		writeFileSync(join(artifactDir, "scheduled-jobs.json"), '{"jobs":[],"dispatches":[]}\n');
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(sessionId, artifactDir);
		// Reading a store file is what makes the registration "observed".
		expect(store.list()).toEqual([]);
		expect((await deleteSessionFile(sessionFile)).ok).toBe(true);

		// A new session reusing the id recreates the directory after the deletion, so
		// the tombstone no longer describes what is on disk (red test R-6).
		mkdirSync(artifactDir, { recursive: true });
		const future = new Date(Date.now() + 2000);
		utimesSync(artifactDir, future, future);
		expect(statSync(artifactDir).mtimeMs).toBeGreaterThan(Date.now() - 1000);

		store.list();
		// Still registered: re-registering is a no-op only while the entry survives.
		expect(store.registerSessionArtifact(sessionId, artifactDir)).toBe(false);
	});

	it("drops the registration once the tombstone is in force again", async () => {
		const root = tempRoot();
		const { manager, sessionFile, artifactDir } = createSession(root, "project");
		const sessionId = manager.getSessionId();
		writeFileSync(join(artifactDir, "scheduled-jobs.json"), '{"jobs":[],"dispatches":[]}\n');
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(sessionId, artifactDir);
		expect(store.list()).toEqual([]);
		expect((await deleteSessionFile(sessionFile)).ok).toBe(true);

		// A leftover directory whose contents predate the deletion: the tombstone is
		// still in force, so the dead registration goes.
		mkdirSync(artifactDir, { recursive: true });
		const past = new Date(Date.now() - 86_400_000);
		utimesSync(artifactDir, past, past);
		store.list();
		expect(store.registerSessionArtifact(sessionId, artifactDir)).toBe(true);
	});

	it("removes the artifact directory even when a legacy root is not private", async () => {
		const root = tempRoot();
		const { sessionFile, artifactDir } = createSession(root, "project");
		const artifactRoot = join(root, "session-artifacts");
		// A leftover directory from an older build: the delete path must still remove it.
		rmSync(artifactDir, { recursive: true, force: true });
		mkdirSync(artifactDir, { recursive: true });
		await deleteSessionArtifacts(sessionFile);
		expect(existsSync(artifactDir)).toBe(false);
		expect(existsSync(artifactRoot)).toBe(true);
	});
});
