import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { deleteSessionFile } from "../src/core/session-file-actions.js";
import {
	isSessionInfoDiskCacheable,
	pruneStaleSessionInfoCacheEntries,
	resetSessionInfoDiskCacheState,
	SESSION_INFO_DISK_CACHE_DIR_NAME,
	scheduleSessionInfoCachePrune,
	sessionInfoDiskCacheDir,
	sessionInfoDiskCacheStats,
	whenSessionInfoCachePruneSettled,
} from "../src/core/session-info-disk-cache.js";
import type { SessionHeader } from "../src/core/session-manager.js";
import * as sessionManagerModule from "../src/core/session-manager.js";

let agentDir = "";
let sessionsDir = "";
let outsideDir = "";
let savedAgentDirEnv: string | undefined;
let counter = 0;

function headerLine(id: string, cwd: string): string {
	const header: SessionHeader = { type: "session", id, version: 3, timestamp: new Date(0).toISOString(), cwd };
	return `${JSON.stringify(header)}\n`;
}

function messageLine(role: "user" | "assistant", text: string, timestamp: number): string {
	return `${JSON.stringify({
		type: "message",
		id: `entry-${++counter}`,
		parentId: null,
		message: { role, content: [{ type: "text", text }], timestamp },
	})}\n`;
}

function namedLine(name: string): string {
	return `${JSON.stringify({ type: "session_info", id: `entry-${++counter}`, parentId: null, name })}\n`;
}

function writeSession(dir: string, id: string, body: string): string {
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, body, "utf8");
	return path;
}

/** The state a freshly spawned worker starts in: nothing in memory, disk untouched. */
function simulateFreshProcess(): void {
	sessionManagerModule.clearSessionInfoCaches();
	resetSessionInfoDiskCacheState();
}

function cacheFiles(): string[] {
	const dir = sessionInfoDiskCacheDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(dir, name));
}

beforeEach(async () => {
	savedAgentDirEnv = process.env[ENV_AGENT_DIR];
	agentDir = mkdtempSync(join(tmpdir(), "prime-session-info-cache-"));
	outsideDir = mkdtempSync(join(tmpdir(), "prime-session-info-outside-"));
	sessionsDir = join(agentDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	process.env[ENV_AGENT_DIR] = agentDir;
	simulateFreshProcess();
	await whenSessionInfoCachePruneSettled();
});

afterEach(async () => {
	await whenSessionInfoCachePruneSettled();
	if (savedAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDirEnv;
	simulateFreshProcess();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(outsideDir, { recursive: true, force: true });
});

describe("durable session-info summary", () => {
	it("leaves a durable summary behind so the next process does not rescan the transcript", async () => {
		const path = writeSession(
			sessionsDir,
			"session-a",
			headerLine("session-a", "/tmp/project") + messageLine("user", "hello there", 1000),
		);

		const first = await sessionManagerModule.readSessionInfo(path);
		expect(first?.messageCount).toBe(1);
		expect(sessionInfoDiskCacheDir()).toBe(join(agentDir, SESSION_INFO_DISK_CACHE_DIR_NAME));
		// Before the durable layer existed nothing survived the process, so this is
		// the assertion that fails on the unfixed tree.
		expect(existsSync(sessionInfoDiskCacheDir())).toBe(true);
		expect(cacheFiles()).toHaveLength(1);

		const afterFirst = sessionManagerModule.getSessionInfoReadStats();
		expect(afterFirst.fullScans).toBe(1);
		expect(afterFirst.diskHits).toBe(0);

		simulateFreshProcess();
		const second = await sessionManagerModule.readSessionInfo(path);
		const afterSecond = sessionManagerModule.getSessionInfoReadStats();
		expect(afterSecond.fullScans).toBe(0);
		expect(afterSecond.diskHits).toBe(1);
		expect(second).toEqual(first);
	});

	it("records which transcript version the durable summary describes", async () => {
		const path = writeSession(
			sessionsDir,
			"session-b",
			headerLine("session-b", "/tmp/project") + messageLine("user", "one", 1000),
		);
		await sessionManagerModule.readSessionInfo(path);
		const entry = JSON.parse(readFileSync(cacheFiles()[0]!, "utf8")) as {
			fingerprint: { dev: number; ino: number; size: number; mtimeMs: number };
			info: { path: string };
		};
		const stats = statSync(path);
		expect(entry.fingerprint).toEqual({
			dev: stats.dev,
			ino: stats.ino,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
		});
		expect(entry.info.path).toBe(path);
	});

	it("rescans an appended transcript instead of serving the stale summary", async () => {
		const path = writeSession(
			sessionsDir,
			"session-c",
			headerLine("session-c", "/tmp/project") + messageLine("user", "one", 1000),
		);
		expect((await sessionManagerModule.readSessionInfo(path))?.messageCount).toBe(1);

		simulateFreshProcess();
		writeFileSync(path, messageLine("assistant", "two", 2000), { flag: "a" });
		const grown = await sessionManagerModule.readSessionInfo(path);
		expect(grown?.messageCount).toBe(2);
		expect(grown?.allMessagesText).toContain("two");
		expect(sessionManagerModule.getSessionInfoReadStats().fullScans).toBe(1);
		expect(sessionManagerModule.getSessionInfoReadStats().diskHits).toBe(0);
	});

	it("rescans a rewritten transcript of identical length", async () => {
		const original = headerLine("session-d", "/tmp/project") + namedLine("before");
		const replacement = headerLine("session-d", "/tmp/project") + namedLine("after!");
		expect(replacement.length).toBe(original.length);
		const path = writeSession(sessionsDir, "session-d", original);
		expect((await sessionManagerModule.readSessionInfo(path))?.name).toBe("before");

		simulateFreshProcess();
		writeFileSync(path, replacement);
		// Same byte count, same inode: only mtime can tell the versions apart, so
		// force a distinct one rather than racing the filesystem clock.
		const stats = statSync(path);
		utimesSync(path, stats.atime, new Date(stats.mtimeMs + 5000));
		const rewritten = await sessionManagerModule.readSessionInfo(path);
		expect(rewritten?.name).toBe("after!");
		expect(sessionManagerModule.getSessionInfoReadStats().fullScans).toBe(1);
		expect(sessionManagerModule.getSessionInfoReadStats().diskHits).toBe(0);
	});

	it("ignores a durable entry whose fingerprint no longer matches", async () => {
		const path = writeSession(
			sessionsDir,
			"session-e",
			headerLine("session-e", "/tmp/project") + messageLine("user", "one", 1000),
		);
		await sessionManagerModule.readSessionInfo(path);
		await whenSessionInfoCachePruneSettled();
		const file = cacheFiles()[0]!;
		const entry = JSON.parse(readFileSync(file, "utf8")) as { fingerprint: { size: number } };
		entry.fingerprint.size += 1;
		writeFileSync(file, JSON.stringify(entry));

		simulateFreshProcess();
		const info = await sessionManagerModule.readSessionInfo(path);
		expect(info?.messageCount).toBe(1);
		const stats = sessionManagerModule.getSessionInfoReadStats();
		expect(stats.diskHits).toBe(0);
		expect(stats.fullScans).toBe(1);
	});

	it("leaves transcripts outside the agent's session roots untouched", async () => {
		const path = writeSession(
			outsideDir,
			"session-f",
			headerLine("session-f", "/tmp/project") + messageLine("user", "one", 1000),
		);
		expect(isSessionInfoDiskCacheable(path)).toBe(false);
		const info = await sessionManagerModule.readSessionInfo(path);
		expect(info?.messageCount).toBe(1);
		expect(existsSync(sessionInfoDiskCacheDir())).toBe(false);
		expect(sessionInfoDiskCacheStats().writes).toBe(0);

		simulateFreshProcess();
		await sessionManagerModule.readSessionInfo(path);
		expect(sessionManagerModule.getSessionInfoReadStats().diskHits).toBe(0);
	});

	it("caches a passivated descendant under the artifacts root", async () => {
		const artifactDir = join(agentDir, "session-artifacts", "session-g", "sub-12345678");
		mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
		expect(isSessionInfoDiskCacheable(join(artifactDir, "child.jsonl"))).toBe(true);
		const path = writeSession(
			artifactDir,
			"child",
			headerLine("child-session", "/tmp/project") + messageLine("user", "one", 1000),
		);
		await sessionManagerModule.readSessionInfo(path);
		expect(cacheFiles()).toHaveLength(1);

		simulateFreshProcess();
		const info = await sessionManagerModule.readSessionInfo(path);
		expect(info?.id).toBe("child-session");
		expect(sessionManagerModule.getSessionInfoReadStats().diskHits).toBe(1);
	});

	it("prunes summaries whose transcript is gone and keeps the current ones", async () => {
		const gone = writeSession(
			sessionsDir,
			"session-h",
			headerLine("session-h", "/tmp/project") + messageLine("user", "one", 1000),
		);
		const kept = writeSession(
			sessionsDir,
			"session-i",
			headerLine("session-i", "/tmp/project") + messageLine("user", "two", 1000),
		);
		await sessionManagerModule.readSessionInfo(gone);
		await sessionManagerModule.readSessionInfo(kept);
		await whenSessionInfoCachePruneSettled();
		expect(cacheFiles()).toHaveLength(2);

		rmSync(gone, { force: true });
		const pruned = await pruneStaleSessionInfoCacheEntries();
		expect(pruned).toBe(1);
		expect(cacheFiles()).toHaveLength(1);

		simulateFreshProcess();
		expect((await sessionManagerModule.readSessionInfo(kept))?.messageCount).toBe(1);
		expect(sessionManagerModule.getSessionInfoReadStats().diskHits).toBe(1);
	});

	it("stores summaries privately, like the transcripts they describe", async () => {
		const path = writeSession(
			sessionsDir,
			"session-j",
			headerLine("session-j", "/tmp/project") + messageLine("user", "one", 1000),
		);
		await sessionManagerModule.readSessionInfo(path);
		await whenSessionInfoCachePruneSettled();
		const dir = sessionInfoDiskCacheDir();
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
		if (process.platform === "win32") return;
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(cacheFiles()[0]!).mode & 0o777).toBe(0o600);
	});

	it("drops the durable summary when the session is deleted", async () => {
		const path = writeSession(
			sessionsDir,
			"session-l",
			headerLine("session-l", "/tmp/project") + messageLine("user", "one", 1000),
		);
		await sessionManagerModule.readSessionInfo(path);
		await whenSessionInfoCachePruneSettled();
		expect(cacheFiles()).toHaveLength(1);

		const result = await deleteSessionFile(path);
		expect(result.ok).toBe(true);
		expect(existsSync(path)).toBe(false);
		// Without this the entry would sit in the cache directory until the weekly
		// prune noticed its transcript was gone.
		expect(cacheFiles()).toHaveLength(0);
		expect(sessionInfoDiskCacheStats().removed).toBeGreaterThan(0);
	});

	it("finds the summary written under the other path spelling of the same file", async () => {
		const path = writeSession(
			sessionsDir,
			"session-m",
			headerLine("session-m", "/tmp/project") + messageLine("user", "one", 1000),
		);
		// The ledger records realpath-canonical paths while a directory scan yields
		// the configured spelling; on a host with a symlinked temp or home directory
		// those are two keys for one transcript, and a delete can arrive under either.
		const canonical = realpathSync(path);
		await sessionManagerModule.readSessionInfo(canonical);
		await whenSessionInfoCachePruneSettled();
		expect(cacheFiles()).toHaveLength(1);

		const result = await deleteSessionFile(path);
		expect(result.ok).toBe(true);
		expect(cacheFiles()).toHaveLength(0);
	});

	it("drops descendant summaries when a deleted root takes its artifact tree with it", async () => {
		const rootPath = writeSession(
			sessionsDir,
			"session-n",
			headerLine("session-n", "/tmp/project") + messageLine("user", "root", 1000),
		);
		const childDir = join(agentDir, "session-artifacts", "session-n", "sub-aaaaaaaa");
		mkdirSync(childDir, { recursive: true, mode: 0o700 });
		const childPath = writeSession(
			childDir,
			"child",
			headerLine("session-n-child", "/tmp/project") + messageLine("user", "child", 1000),
		);
		await sessionManagerModule.readSessionInfo(rootPath);
		// Passive descendants are read under their canonical path, as the ledger
		// records it, which is also how the artifact walk spells them.
		await sessionManagerModule.readSessionInfo(realpathSync(childPath));
		await whenSessionInfoCachePruneSettled();
		expect(cacheFiles()).toHaveLength(2);

		const result = await deleteSessionFile(rootPath);
		expect(result.ok).toBe(true);
		expect(existsSync(childDir)).toBe(false);
		expect(cacheFiles()).toHaveLength(0);
	});

	it("does not let one unserializable timestamp poison the whole directory listing", async () => {
		const good = (id: string) =>
			writeSession(sessionsDir, id, headerLine(id, "/tmp/project") + messageLine("user", `question ${id}`, 1000));
		const brokenPath = join(sessionsDir, "bbb-broken.jsonl");
		// A hand-edited, truncated or third-party-imported transcript: the loader
		// tolerates this header, so the list path must tolerate it too.
		const brokenHeader = JSON.stringify({
			type: "session",
			version: 3,
			id: "bbb-broken",
			timestamp: "definitely-not-a-date",
			cwd: "/tmp/project",
		});
		writeFileSync(brokenPath, `${brokenHeader}\n${messageLine("user", "question bbb-broken", 1000)}`, "utf8");
		good("aaa-good");
		good("ccc-good");

		simulateFreshProcess();
		// The summary of the broken transcript cannot be serialized, so it is not
		// persisted - but that is a cache decision, and it must never escape as a
		// throw that takes the other 500 rows down with it.
		const broken = await sessionManagerModule.readSessionInfo(brokenPath);
		expect(broken?.id).toBe("bbb-broken");
		expect(Number.isNaN(broken?.created.getTime() ?? Number.NaN)).toBe(true);

		simulateFreshProcess();
		const listed = await sessionManagerModule.SessionManager.listAll(undefined, sessionsDir);
		expect(listed.map((info) => info.id).sort()).toEqual(["aaa-good", "bbb-broken", "ccc-good"]);
		expect(cacheFiles()).toHaveLength(2);
		expect(sessionInfoDiskCacheStats().skipped).toBe(1);
	});

	it("skips a summary too large to be worth its own file", async () => {
		// The search text is capped at 64 KiB but the first message is not, so one
		// huge opening message is enough to push the payload over the entry limit.
		const path = writeSession(
			sessionsDir,
			"session-huge",
			headerLine("session-huge", "/tmp/project") + messageLine("user", "x".repeat(600_000), 1000),
		);
		const info = await sessionManagerModule.readSessionInfo(path);
		expect(info?.firstMessage.length).toBeGreaterThan(512 * 1024);
		expect(cacheFiles()).toHaveLength(0);
		expect(sessionInfoDiskCacheStats().skipped).toBe(1);

		// Skipping is a decision, not a failure: the read still returned the summary.
		expect(info?.messageCount).toBe(1);
		expect(sessionInfoDiskCacheStats().writeErrors).toBe(0);
	});

	it("walks the directory at most once per prune interval", async () => {
		const kept = writeSession(
			sessionsDir,
			"session-p",
			headerLine("session-p", "/tmp/project") + messageLine("user", "one", 1000),
		);
		const gone = writeSession(
			sessionsDir,
			"session-q",
			headerLine("session-q", "/tmp/project") + messageLine("user", "two", 1000),
		);
		await sessionManagerModule.readSessionInfo(kept);
		await sessionManagerModule.readSessionInfo(gone);
		await whenSessionInfoCachePruneSettled();
		const marker = join(sessionInfoDiskCacheDir(), "prune-marker");
		expect(existsSync(marker)).toBe(true);
		expect(cacheFiles()).toHaveLength(2);

		rmSync(gone, { force: true });
		// The marker is fresh, so a newly started process must not walk the
		// directory again: the orphan waits for the interval, not for the next boot.
		simulateFreshProcess();
		scheduleSessionInfoCachePrune();
		await whenSessionInfoCachePruneSettled();
		expect(cacheFiles()).toHaveLength(2);

		rmSync(marker, { force: true });
		simulateFreshProcess();
		scheduleSessionInfoCachePrune();
		await whenSessionInfoCachePruneSettled();
		expect(cacheFiles()).toHaveLength(1);
		expect(sessionInfoDiskCacheStats().pruned).toBe(1);
	});

	it("survives an unwritable cache location without failing the read", async () => {
		const path = writeSession(
			sessionsDir,
			"session-k",
			headerLine("session-k", "/tmp/project") + messageLine("user", "one", 1000),
		);
		// A regular file where the cache directory belongs: every write must fail.
		writeFileSync(sessionInfoDiskCacheDir(), "not a directory");
		const info = await sessionManagerModule.readSessionInfo(path);
		expect(info?.messageCount).toBe(1);
		expect(sessionInfoDiskCacheStats().writeErrors).toBeGreaterThan(0);
	});
});
