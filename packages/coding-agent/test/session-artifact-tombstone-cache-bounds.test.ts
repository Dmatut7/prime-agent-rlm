import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	readSessionArtifactTombstones,
	resetSessionArtifactTombstoneCache,
	sessionArtifactTombstoneCacheHas,
	sessionArtifactTombstoneCacheStats,
	sessionArtifactTombstonePath,
} from "../src/core/session-artifact-tombstones.js";

// The ceilings this line set for the tombstone cache (round-14 leaks L2, same shape as L1).
// Stated here, not imported, so widening the production constant cannot widen the guarantee.
const CACHE_MAX_ENTRIES = 1024;
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const IDLE_PAST_TTL_MS = 60 * 60 * 1000;
const PINNED_SECONDS = 1_700_000_000;
const RECORDS_PER_ROOT = 20;

function recordLine(sessionId: string, deletedAtMs: number): string {
	return `${JSON.stringify({ version: 1, sessionId, deletedAt: new Date(deletedAtMs).toISOString() })}\n`;
}

/** One tombstone log per root, each root holding its own distinct set of ids. */
function seedRoot(root: string, index: number, records = RECORDS_PER_ROOT): void {
	mkdirSync(root, { recursive: true });
	let contents = "";
	for (let r = 0; r < records; r++) contents += recordLine(`root${index}-session${r}`, 1_700_000_000_000 + r);
	writeFileSync(sessionArtifactTombstonePath(root), contents);
}

function readDistinctRoots(tempDir: string, count: number, records = RECORDS_PER_ROOT): string[] {
	const roots: string[] = [];
	for (let index = 0; index < count; index++) {
		const root = join(tempDir, `session-artifacts-${index}`);
		seedRoot(root, index, records);
		roots.push(root);
	}
	for (const root of roots) readSessionArtifactTombstones(root);
	return roots;
}

describe("session artifact tombstone cache bounds (round-14 leaks L2)", () => {
	afterEach(() => {
		resetSessionArtifactTombstoneCache();
		vi.useRealTimers();
	});

	it("keeps cached roots and estimated bytes under a ceiling across many distinct roots", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-tombstone-bound-"));
		try {
			// 3000 roots x 20 records: an unbounded cache crosses both ceilings here.
			const roots = readDistinctRoots(tempDir, 3000);
			const stats = sessionArtifactTombstoneCacheStats();
			expect(stats.entries).toBeGreaterThan(0);
			expect(stats.entries).toBeLessThanOrEqual(CACHE_MAX_ENTRIES);
			expect(stats.bytes).toBeLessThanOrEqual(CACHE_MAX_BYTES);

			// Bounded must not mean wrong: every root still reports its own records.
			for (const index of [0, 1499, 2999]) {
				const records = readSessionArtifactTombstones(roots[index]);
				expect(records.size).toBe(RECORDS_PER_ROOT);
				expect(records.has(`root${index}-session0`)).toBe(true);
				expect(records.has(`root${index + 1}-session0`)).toBe(false);
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("still serves a repeat read of the same root from cache (hit-rate control)", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-tombstone-hit-"));
		try {
			const root = join(tempDir, "session-artifacts");
			seedRoot(root, 7);
			const path = sessionArtifactTombstonePath(root);
			utimesSync(path, PINNED_SECONDS, PINNED_SECONDS);
			expect(readSessionArtifactTombstones(root).has("root7-session0")).toBe(true);
			expect(sessionArtifactTombstoneCacheHas(root)).toBe(true);

			// Same byte length, same pinned mtime, different ids: a hit keeps reporting the
			// cached set, which is what the revalidation-on-stat is for.
			const before = statSync(path);
			mkdirSync(root, { recursive: true });
			let contents = "";
			for (let r = 0; r < RECORDS_PER_ROOT; r++) contents += recordLine(`swap7-session${r}`, 1_700_000_000_000 + r);
			writeFileSync(path, contents);
			utimesSync(path, PINNED_SECONDS, PINNED_SECONDS);
			const after = statSync(path);
			expect(after.size).toBe(before.size);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(readSessionArtifactTombstones(root).has("root7-session0")).toBe(true);

			// A distinguishable rewrite is picked up.
			writeFileSync(path, `${readFileSync(path, "utf8")}\n${recordLine("added-later-session", 1_800_000_000_000)}`);
			expect(readSessionArtifactTombstones(root).has("added-later-session")).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("evicts the least recently used root, not the first written one", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-tombstone-lru-"));
		try {
			// 3 records per root keeps the byte budget slack, so the entry ceiling is what binds.
			const roots = readDistinctRoots(tempDir, CACHE_MAX_ENTRIES, 3);
			expect(sessionArtifactTombstoneCacheStats().entries).toBe(CACHE_MAX_ENTRIES);
			readSessionArtifactTombstones(roots[0]);
			const extra = join(tempDir, "session-artifacts-extra");
			seedRoot(extra, 99999, 3);
			readSessionArtifactTombstones(extra);
			expect(sessionArtifactTombstoneCacheHas(roots[0])).toBe(true);
			expect(sessionArtifactTombstoneCacheHas(roots[1])).toBe(false);
			expect(sessionArtifactTombstoneCacheHas(extra)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reclaims entries whose tombstone log was deleted out from under the cache", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-tombstone-reclaim-"));
		const otherDir = mkdtempSync(join(tmpdir(), "prime-tombstone-reclaim2-"));
		try {
			const roots = readDistinctRoots(tempDir, 200, 3);
			expect(sessionArtifactTombstoneCacheStats().entries).toBe(200);
			for (const root of roots) rmSync(root, { recursive: true, force: true });

			const fresh = join(otherDir, "session-artifacts");
			seedRoot(fresh, 555, 3);
			vi.useFakeTimers({ toFake: ["Date"] });
			try {
				vi.advanceTimersByTime(IDLE_PAST_TTL_MS);
				expect(readSessionArtifactTombstones(fresh).has("root555-session0")).toBe(true);
			} finally {
				vi.useRealTimers();
			}
			expect(sessionArtifactTombstoneCacheHas(roots[0])).toBe(false);
			expect(sessionArtifactTombstoneCacheHas(fresh)).toBe(true);
			expect(sessionArtifactTombstoneCacheStats().entries).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
			rmSync(otherDir, { recursive: true, force: true });
		}
	});
});
