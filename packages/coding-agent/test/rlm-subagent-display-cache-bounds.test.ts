import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type RlmSubagentDisplayEntry,
	readRlmSubagentDisplayEntry,
	resetRlmSubagentDisplayCache,
	rlmSubagentDisplayCacheHas,
	rlmSubagentDisplayCacheStats,
	rlmSubagentDisplayPath,
	writeRlmSubagentDisplayEntry,
} from "../src/modes/daemon/rlm-subagent-display.js";

// The ceilings this line set for the daemon's display cache (round-14 leaks L1). They are
// written here rather than imported on purpose: the test states the invariant "bounded", so
// widening the production constant cannot silently widen the guarantee.
const CACHE_MAX_ENTRIES = 4096;
const CACHE_MAX_BYTES = 16 * 1024 * 1024;
// Longer than DISPLAY_CACHE_IDLE_TTL_MS in the implementation.
const IDLE_PAST_TTL_MS = 60 * 60 * 1000;
// A whole-second timestamp survives the utimes/stat round trip exactly.
const PINNED_SECONDS = 1_700_000_000;

function makeEntry(sessionDir: string, prompt: string, sessionName = "worker"): RlmSubagentDisplayEntry {
	return {
		type: "rlm_subagent",
		childId: `sub-${sessionName}`,
		sessionName,
		sessionDir,
		sessionFile: join(sessionDir, "01a0-child.jsonl"),
		prompt,
		spawnCode: "await rlm('do the work')",
		status: "running",
		createdAt: 1,
		updatedAt: "2026-01-01T00:00:00.000Z",
	};
}

function seedDisplayFile(sessionDir: string, entry: RlmSubagentDisplayEntry): string {
	mkdirSync(sessionDir, { recursive: true });
	const path = rlmSubagentDisplayPath(sessionDir);
	writeFileSync(path, `${JSON.stringify(entry)}\n`);
	return path;
}

/** Write `count` distinct child dirs and read each exactly once, as a session-list walk does. */
async function readDistinctDirs(tempDir: string, count: number, promptSize: number): Promise<string[]> {
	const dirs: string[] = [];
	for (let index = 0; index < count; index++) {
		const sessionDir = join(tempDir, `sub-${index}`);
		seedDisplayFile(sessionDir, makeEntry(sessionDir, "p".repeat(promptSize), `worker${index}`));
		dirs.push(sessionDir);
	}
	for (const sessionDir of dirs) await readRlmSubagentDisplayEntry(sessionDir);
	return dirs;
}

describe("rlm subagent display cache bounds (round-14 leaks L1)", () => {
	afterEach(() => {
		resetRlmSubagentDisplayCache();
		vi.useRealTimers();
	});

	it("keeps cached entries and estimated bytes under a ceiling across many distinct dirs", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-display-bound-"));
		try {
			// 5000 children x ~4.3KB each: an unbounded cache crosses the entry ceiling and
			// the byte ceiling here, so this is red before the bound exists.
			const dirs = await readDistinctDirs(tempDir, 5000, 4200);
			const stats = rlmSubagentDisplayCacheStats();
			expect(stats.entries).toBeGreaterThan(0);
			expect(stats.entries).toBeLessThanOrEqual(CACHE_MAX_ENTRIES);
			expect(stats.bytes).toBeLessThanOrEqual(CACHE_MAX_BYTES);

			// Bounded must not mean wrong: sampled children still read back exactly, whether
			// their entry was kept or re-read from disk.
			for (const index of [0, 1234, 2999, 4999]) {
				await expect(readRlmSubagentDisplayEntry(dirs[index])).resolves.toMatchObject({
					sessionName: `worker${index}`,
				});
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("still serves a repeat read of the same dir from cache (hit-rate control)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-display-hit-"));
		try {
			const sessionDir = join(tempDir, "sub-1");
			const prompt = "x".repeat(2048);
			const path = seedDisplayFile(sessionDir, makeEntry(sessionDir, prompt, "workerA"));
			utimesSync(path, PINNED_SECONDS, PINNED_SECONDS);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({ sessionName: "workerA" });
			expect(rlmSubagentDisplayCacheHas(sessionDir)).toBe(true);

			// Equal byte length and equal pinned mtime: only a cache hit can still report
			// workerA, because the stat cannot tell this file apart from the cached one.
			const before = statSync(path);
			seedDisplayFile(sessionDir, makeEntry(sessionDir, prompt, "workerB"));
			utimesSync(path, PINNED_SECONDS, PINNED_SECONDS);
			const after = statSync(path);
			expect(after.size).toBe(before.size);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({ sessionName: "workerA" });

			// A distinguishable rewrite is still picked up: stat revalidation stays honest.
			seedDisplayFile(sessionDir, makeEntry(sessionDir, "y".repeat(2048), "workerC"));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({ sessionName: "workerC" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("evicts the least recently used entry, not the first written one", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-display-lru-"));
		try {
			// Small payloads keep the byte budget slack, so the entry ceiling is what binds.
			const dirs = await readDistinctDirs(tempDir, CACHE_MAX_ENTRIES, 64);
			expect(rlmSubagentDisplayCacheStats().entries).toBe(CACHE_MAX_ENTRIES);
			expect(rlmSubagentDisplayCacheHas(dirs[0])).toBe(true);

			// Reading dirs[0] again is a hit; the next insert must therefore cost dirs[1].
			await readRlmSubagentDisplayEntry(dirs[0]);
			const extra = await readDistinctDirs(join(tempDir, "more"), 1, 64);
			expect(rlmSubagentDisplayCacheHas(dirs[0])).toBe(true);
			expect(rlmSubagentDisplayCacheHas(dirs[1])).toBe(false);
			expect(rlmSubagentDisplayCacheHas(extra[0])).toBe(true);
			expect(rlmSubagentDisplayCacheStats().entries).toBe(CACHE_MAX_ENTRIES);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reclaims entries whose directories were deleted out from under the cache", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-display-reclaim-"));
		const otherDir = mkdtempSync(join(tmpdir(), "prime-display-reclaim2-"));
		try {
			const dirs = await readDistinctDirs(tempDir, 200, 64);
			expect(rlmSubagentDisplayCacheStats().entries).toBe(200);
			for (const sessionDir of dirs) rmSync(sessionDir, { recursive: true, force: true });

			// Nothing ever reads a vanished child again, so eviction must not depend on that
			// path being touched again: an idle entry goes on its own at the next insert.
			const fresh = join(otherDir, "sub-new");
			seedDisplayFile(fresh, makeEntry(fresh, "z".repeat(64), "workerNew"));
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				vi.advanceTimersByTime(IDLE_PAST_TTL_MS);
				await expect(readRlmSubagentDisplayEntry(fresh)).resolves.toMatchObject({ sessionName: "workerNew" });
			} finally {
				vi.useRealTimers();
			}
			expect(rlmSubagentDisplayCacheHas(dirs[0])).toBe(false);
			expect(rlmSubagentDisplayCacheHas(fresh)).toBe(true);
			expect(rlmSubagentDisplayCacheStats().entries).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	it("the writer path still invalidates and a removed dir stops being reported", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-display-writer-"));
		try {
			const sessionDir = join(tempDir, "sub-1");
			const entry = makeEntry(sessionDir, "w".repeat(64));
			writeRlmSubagentDisplayEntry(entry);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(entry);
			rmSync(sessionDir, { recursive: true, force: true });
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();
			expect(rlmSubagentDisplayCacheHas(sessionDir)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
