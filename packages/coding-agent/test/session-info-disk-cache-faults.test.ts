import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

/**
 * Fault injection for the durable-summary layer's own I/O. The point of these
 * cases is the difference between a filesystem that is broken and a filesystem
 * that is momentarily busy: the first should stop the layer from trying, the
 * second should not, and neither should ever delete or lose a summary that is
 * still valid.
 */
const fsFault = vi.hoisted(() => ({
	writeFileCode: undefined as string | undefined,
	readFileCode: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const faultError = (code: string): NodeJS.ErrnoException => {
		const error = new Error(`${code}: simulated fault`) as NodeJS.ErrnoException;
		error.code = code;
		return error;
	};
	const passthrough = actual as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
	return {
		...actual,
		writeFile: async (...args: unknown[]) => {
			if (fsFault.writeFileCode) throw faultError(fsFault.writeFileCode);
			return passthrough.writeFile(...args);
		},
		readFile: async (...args: unknown[]) => {
			if (fsFault.readFileCode) throw faultError(fsFault.readFileCode);
			return passthrough.readFile(...args);
		},
	};
});

import {
	pruneStaleSessionInfoCacheEntries,
	resetSessionInfoDiskCacheState,
	sessionInfoDiskCacheDir,
	sessionInfoDiskCacheStats,
	whenSessionInfoCachePruneSettled,
} from "../src/core/session-info-disk-cache.js";
import type { SessionHeader } from "../src/core/session-manager.js";
import * as sessionManagerModule from "../src/core/session-manager.js";

let agentDir = "";
let sessionsDir = "";
let savedAgentDirEnv: string | undefined;
let counter = 0;

function transcript(id: string): string {
	const header: SessionHeader = { type: "session", id, version: 3, timestamp: new Date(0).toISOString(), cwd: "/tmp" };
	const message = {
		type: "message",
		id: `entry-${++counter}`,
		parentId: null,
		message: { role: "user", content: [{ type: "text", text: `question ${id}` }], timestamp: 1000 },
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`;
}

function writeSession(id: string): string {
	const path = join(sessionsDir, `${id}.jsonl`);
	writeFileSync(path, transcript(id), "utf8");
	return path;
}

function cacheFiles(): string[] {
	const dir = sessionInfoDiskCacheDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => join(dir, name));
}

function tempFiles(): string[] {
	const dir = sessionInfoDiskCacheDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

beforeEach(async () => {
	savedAgentDirEnv = process.env[ENV_AGENT_DIR];
	agentDir = mkdtempSync(join(tmpdir(), "prime-summary-faults-"));
	sessionsDir = join(agentDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
	process.env[ENV_AGENT_DIR] = agentDir;
	fsFault.writeFileCode = undefined;
	fsFault.readFileCode = undefined;
	vi.useFakeTimers();
	sessionManagerModule.clearSessionInfoCaches();
	resetSessionInfoDiskCacheState();
	await whenSessionInfoCachePruneSettled();
});

afterEach(async () => {
	fsFault.writeFileCode = undefined;
	fsFault.readFileCode = undefined;
	await whenSessionInfoCachePruneSettled();
	vi.useRealTimers();
	if (savedAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = savedAgentDirEnv;
	sessionManagerModule.clearSessionInfoCaches();
	resetSessionInfoDiskCacheState();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("durable summary write faults", () => {
	it("stops trying after repeated permanent write failures and stays stopped", async () => {
		fsFault.writeFileCode = "EROFS";
		for (const id of ["a", "b", "c", "d", "e"]) {
			await sessionManagerModule.readSessionInfo(writeSession(id));
		}
		const latched = sessionInfoDiskCacheStats();
		expect(latched.writes).toBe(0);
		// Three attempts, then the breaker: reads 4 and 5 must not keep paying for a
		// filesystem that said it is read-only.
		expect(latched.writeErrors).toBe(3);

		// A permanent fault gets no half-open retry inside the same process.
		fsFault.writeFileCode = undefined;
		vi.advanceTimersByTime(60 * 60 * 1000);
		await sessionManagerModule.readSessionInfo(writeSession("after-latch"));
		expect(sessionInfoDiskCacheStats().writes).toBe(0);
		expect(sessionInfoDiskCacheStats().writeErrors).toBe(3);
	});

	it("backs off a transient descriptor exhaustion and comes back instead of latching", async () => {
		fsFault.writeFileCode = "EMFILE";
		await sessionManagerModule.readSessionInfo(writeSession("first"));
		expect(sessionInfoDiskCacheStats().writeErrors).toBe(1);

		// Inside the backoff window the layer does not keep hammering the descriptor
		// table: the summary is skipped, not attempted.
		await sessionManagerModule.readSessionInfo(writeSession("second"));
		expect(sessionInfoDiskCacheStats().writeErrors).toBe(1);
		expect(sessionInfoDiskCacheStats().skipped).toBeGreaterThan(0);

		// The transient condition clears, the backoff expires, and the durable layer
		// is available again in the same long-lived process.
		fsFault.writeFileCode = undefined;
		vi.advanceTimersByTime(60 * 60 * 1000);
		await sessionManagerModule.readSessionInfo(writeSession("third"));
		expect(sessionInfoDiskCacheStats().writes).toBe(1);
		expect(sessionInfoDiskCacheStats().writeErrors).toBe(1);
	});

	it("keeps reading correctly no matter what the write side does", async () => {
		fsFault.writeFileCode = "ENOSPC";
		for (const id of ["x", "y", "z", "w"]) {
			const info = await sessionManagerModule.readSessionInfo(writeSession(id));
			expect(info?.messageCount).toBe(1);
			expect(info?.id).toBe(id);
		}
		expect(sessionInfoDiskCacheStats().writes).toBe(0);
	});
});

describe("durable summary prune faults", () => {
	it("keeps an entry it could not read instead of collecting it as garbage", async () => {
		const path = writeSession("kept");
		await sessionManagerModule.readSessionInfo(path);
		await whenSessionInfoCachePruneSettled();
		expect(cacheFiles()).toHaveLength(1);

		fsFault.readFileCode = "EMFILE";
		const prunedWhileUnreadable = await pruneStaleSessionInfoCacheEntries();
		fsFault.readFileCode = undefined;

		// An unreadable entry is not a proven-stale entry: the next walk gets to decide.
		expect(prunedWhileUnreadable).toBe(0);
		expect(cacheFiles()).toHaveLength(1);

		// The summary is still servable, so nothing was lost by keeping it.
		sessionManagerModule.clearSessionInfoCaches();
		expect((await sessionManagerModule.readSessionInfo(path))?.id).toBe("kept");
		expect(sessionManagerModule.getSessionInfoReadStats().diskHits).toBe(1);
	});

	it("still collects an entry whose contents are genuinely corrupt", async () => {
		await sessionManagerModule.readSessionInfo(writeSession("corrupt"));
		await whenSessionInfoCachePruneSettled();
		const entry = cacheFiles()[0]!;
		writeFileSync(entry, "{ this is not json");

		expect(await pruneStaleSessionInfoCacheEntries()).toBe(1);
		expect(cacheFiles()).toHaveLength(0);
	});

	it("collects the temp files of a crash between write and rename, but not a live one", async () => {
		await sessionManagerModule.readSessionInfo(writeSession("with-temp"));
		await whenSessionInfoCachePruneSettled();
		const dir = sessionInfoDiskCacheDir();
		const stale = join(dir, ".stale.json.1234.abcdef.tmp");
		const live = join(dir, ".live.json.1234.abcdef.tmp");
		writeFileSync(stale, "partial");
		writeFileSync(live, "partial");
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(stale, old, old);

		await pruneStaleSessionInfoCacheEntries();
		expect(tempFiles()).toEqual([".live.json.1234.abcdef.tmp"]);
		expect(cacheFiles()).toHaveLength(1);
	});
});
