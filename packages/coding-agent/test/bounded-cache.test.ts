import { describe, expect, it, vi } from "vitest";
import { BoundedCache } from "../src/utils/bounded-cache.js";

function makeCache(maxEntries: number, maxBytes: number, idleTtlMs = 0) {
	return new BoundedCache<number>({
		maxEntries,
		maxBytes,
		// One byte per character of the (numeric) value, plus the key, which the cache adds.
		estimateBytes: (value) => String(value).length,
		idleTtlMs,
	});
}

describe("BoundedCache", () => {
	it("evicts least recently used keys beyond the entry ceiling", () => {
		const cache = makeCache(3, 1000);
		for (const key of ["a", "b", "c"]) cache.set(key, 1);
		expect(cache.get("a")).toBe(1); // hit makes "a" most recent
		cache.set("d", 1);
		expect(cache.has("b")).toBe(false);
		expect(cache.has("a")).toBe(true);
		expect(cache.size).toBe(3);
	});

	it("stops caching when the byte ceiling binds and never exceeds it", () => {
		const cache = makeCache(1000, 12);
		for (let i = 0; i < 50; i++) cache.set(`key${i}`, i);
		expect(cache.size).toBeGreaterThan(0);
		expect(cache.estimatedBytes).toBeLessThanOrEqual(12);
		// A single value above the ceiling is not cached at all: the ceiling is hard,
		// and dropping one payload beats evicting the whole working set for it.
		const oversized = new BoundedCache<string>({ maxEntries: 10, maxBytes: 8, estimateBytes: (v) => v.length });
		oversized.set("k", "0123456789");
		expect(oversized.has("k")).toBe(false);
		expect(oversized.size).toBe(0);
		expect(oversized.estimatedBytes).toBe(0);
		oversized.set("s", "ab");
		expect(oversized.get("s")).toBe("ab");
	});

	it("keeps the byte account equal to what is stored when a key is written again", () => {
		const cache = new BoundedCache<string>({ maxEntries: 100, maxBytes: 1000, estimateBytes: (v) => v.length });
		cache.set("hot", "0123456789");
		expect(cache.estimatedBytes).toBe(13);
		// The refresh path of both consumers: the same key is written again while the value is
		// unchanged. What is stored is still one record, so the account must not grow.
		cache.set("hot", "0123456789");
		expect(cache.estimatedBytes).toBe(13);
		cache.set("hot", "0123456789ABCDEFGHIJ");
		expect(cache.estimatedBytes).toBe(23);
	});

	it("still accepts a new key after one key has been overwritten many times", () => {
		// A watched child-agent display file is rewritten on every heartbeat, so overwriting one
		// key is the ordinary path. Eviction can only reclaim records that exist, so ghost bytes
		// left by overwrites eventually evict the whole cache and the cache then never fills again.
		const cache = new BoundedCache<string>({ maxEntries: 100, maxBytes: 1000, estimateBytes: () => 90 });
		for (let i = 0; i < 12; i++) cache.set("hot", "x");
		expect(cache.size).toBe(1);
		expect(cache.estimatedBytes).toBe(93);
		cache.set("fresh", "x");
		expect(cache.get("fresh")).toBe("x");
		expect(cache.has("hot")).toBe(true);
	});

	it("drops the old record's bytes when an overwrite is too big to cache", () => {
		const cache = new BoundedCache<string>({ maxEntries: 10, maxBytes: 20, estimateBytes: (v) => v.length });
		cache.set("k", "0123456789");
		expect(cache.estimatedBytes).toBe(11);
		// 21 bytes + the key is above the ceiling, so the value is not cached - and the record it
		// replaced is gone, so its bytes must be gone too.
		cache.set("k", "0123456789ABCDEFGHIJ");
		expect(cache.size).toBe(0);
		expect(cache.estimatedBytes).toBe(0);
		cache.set("small", "ab");
		expect(cache.get("small")).toBe("ab");
	});

	it("tracks bytes through delete and clear", () => {
		const cache = makeCache(10, 1000);
		cache.set("a", 1);
		const afterSet = cache.estimatedBytes;
		expect(cache.delete("a")).toBe(true);
		expect(cache.delete("a")).toBe(false);
		expect(cache.estimatedBytes).toBe(0);
		cache.set("b", 2);
		cache.clear();
		expect(cache.size).toBe(0);
		expect(cache.estimatedBytes).toBe(0);
		expect(afterSet).toBeGreaterThan(0);
	});

	it("expires idle entries at the next insert and keeps touched ones", () => {
		const cache = makeCache(10, 1000, 60_000);
		cache.set("stale", 1);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			vi.advanceTimersByTime(61_000);
			cache.set("fresh", 2);
		} finally {
			vi.useRealTimers();
		}
		expect(cache.has("stale")).toBe(false);
		expect(cache.get("fresh")).toBe(2);
	});

	it("does not expire an entry that is being read within the TTL", () => {
		const cache = makeCache(10, 1000, 60_000);
		cache.set("hot", 1);
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			for (let minute = 0; minute < 10; minute++) {
				vi.advanceTimersByTime(30_000);
				expect(cache.get("hot")).toBe(1);
				vi.advanceTimersByTime(30_000);
				cache.set(`tick${minute}`, 0);
			}
		} finally {
			vi.useRealTimers();
		}
		expect(cache.has("hot")).toBe(true);
	});
});
