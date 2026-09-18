import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ContextTreeDiskScanCache,
	type ContextTreeNode,
	loadContextTreeChildrenFromDisk,
	scanContextTreeChildrenFromDisk,
} from "../src/core/context-tree.js";

/**
 * Residency and reuse policy of the on-disk scan cache.
 *
 * The companion file (context-tree-disk-cache.test.ts) pins what a reuse may serve; these
 * pin what it may *hold* and what it costs to ask. Both came from measurements on a real
 * shape: a 600-child family that appends between refreshes retained 79 MB of dead rosters
 * (one per tick, each under a fingerprint that would never be looked up again), and the
 * probe that could only report a miss made a cached tick slower than no cache at all
 * (+52% at 200 children, +116% at 600).
 *
 * Every pin here names the mutation that turns it red in its own comment, and each was
 * mutated once and restored byte-for-byte (see EVIDENCE/mutations).
 */

const resolveContextWindow = () => 200_000;

function usage(cost: number): Usage {
	return {
		input: 1000,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

/** One assistant turn, as a persisted child transcript holds it. */
function turn(id: string, parentId: string | null, cost: number): string {
	const stamp = new Date().toISOString();
	const lines = [
		JSON.stringify({
			type: "message",
			id,
			parentId,
			timestamp: stamp,
			message: { role: "user", content: "child task", timestamp: Date.now() },
		}),
		JSON.stringify({
			type: "message",
			id: `a-${id}`,
			parentId: id,
			timestamp: stamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: usage(cost),
				stopReason: "stop",
				timestamp: Date.now(),
			},
		}),
	];
	return `${lines.join("\n")}\n`;
}

function sessionHeader(id: string): string {
	return `${JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: new Date().toISOString(),
		cwd: process.cwd(),
	})}\n`;
}

let tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "context-tree-bounds-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
	vi.useRealTimers();
});

/** A persisted child dir holding one transcript that folds to `cost`. */
function writeChildDir(parentDir: string, name: string, cost: number): string {
	const dir = join(parentDir, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "session.jsonl"), `${sessionHeader(name)}${turn("u1", null, cost)}`);
	return dir;
}

/** A child dir with no readable transcript: it costs a walk no budget and yields no node. */
function writeEmptyChildDir(parentDir: string, name: string): string {
	const dir = join(parentDir, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Append a turn so the transcript's size (and mtime) move. Size is what the pins rely on:
 * under fake timers the filesystem clock is still the real one, so an append has to be
 * visible in something other than a timestamp.
 */
function appendTurn(dir: string, cost: number): void {
	const path = join(dir, "session.jsonl");
	const existing = readdirSync(dir).length;
	writeFileSync(path, turn(`u-extra-${existing}-${cost}`, null, cost), { flag: "a" });
}

/** Pin a dir's mtime, so a newest-first listing is deterministic instead of same-millisecond. */
function pinMtime(dir: string, msSinceEpoch: number): void {
	const stamp = new Date(msSinceEpoch);
	utimesSync(dir, stamp, stamp);
}

function scan(
	root: string,
	cache: ContextTreeDiskScanCache | undefined,
	budget?: { maxChildren?: number; maxBytes?: number; maxDepth?: number },
): ContextTreeNode[] {
	return loadContextTreeChildrenFromDisk(root, resolveContextWindow, undefined, budget, cache);
}

function totalCost(nodes: ContextTreeNode[]): number {
	return nodes.reduce((sum, node) => sum + node.ownUsage.cost.total, 0);
}

describe("ContextTreeDiskScanCache residency", () => {
	it("holds the estimated byte ceiling, and the estimate counts real payload", () => {
		const rootA = makeTempDir();
		const rootB = makeTempDir();
		for (const root of [rootA, rootB]) {
			for (let index = 0; index < 5; index++) {
				writeChildDir(root, `sub-aaaa000${index}`, 0.1 + index);
			}
		}
		const maxBytes = 8192;

		const bounded = new ContextTreeDiskScanCache({ maxBytes, busyCooldownMs: 0 });
		for (const root of [rootA, rootB]) {
			scan(root, bounded);
			scan(root, bounded);
		}
		// Two rosters of five children do not fit: the ceiling is a hard account, so what is
		// retained stays under it and the entries that did not fit are simply not there.
		expect(bounded.subtreeEstimatedBytes).toBeLessThanOrEqual(maxBytes);
		expect(bounded.subtreeEntries).toBeGreaterThan(0);
		expect(bounded.subtreeEntries).toBeLessThan(12);

		// Positive control: the same two trees under the default ceiling retain more than the
		// test ceiling, i.e. the estimator is counting the node copies and not returning zero.
		const unlimited = new ContextTreeDiskScanCache({ busyCooldownMs: 0 });
		for (const root of [rootA, rootB]) {
			scan(root, unlimited);
		}
		expect(unlimited.subtreeEstimatedBytes).toBeGreaterThan(maxBytes);
		expect(unlimited.subtreeEntries).toBeGreaterThan(bounded.subtreeEntries);
		// Mutation: wiring maxBytes as Infinity at the constructor leaves the first assertion
		// green only if nothing is ever estimated; the positive control above is what goes red.
	});

	it("does not cache one subtree that is bigger than the ceiling, and keeps caching the rest", () => {
		const huge = makeTempDir();
		const small = makeTempDir();
		for (let index = 0; index < 40; index++) {
			writeChildDir(huge, `sub-huge${String(index).padStart(4, "0")}`, 0.1);
		}
		writeChildDir(small, "sub-small0001", 0.2);
		const maxBytes = 8192;
		const cache = new ContextTreeDiskScanCache({ maxBytes, busyCooldownMs: 0 });

		// One roster of 40 children is a single entry above the ceiling: it is not cached at
		// all, rather than evicting everything else to make room for it.
		const first = scan(huge, cache);
		expect(first).toHaveLength(40);
		expect(cache.subtreeEstimatedBytes).toBeLessThanOrEqual(maxBytes);
		const missesAfterHuge = cache.stats.subtreeMisses;
		scan(huge, cache);
		expect(cache.stats.subtreeHits).toBe(0);
		expect(cache.stats.subtreeMisses).toBeGreaterThan(missesAfterHuge);

		// The ceiling did not wedge the cache: a subtree that fits is still remembered.
		scan(small, cache);
		const hitsBefore = cache.stats.subtreeHits;
		expect(scan(small, cache)).toHaveLength(1);
		expect(cache.stats.subtreeHits).toBeGreaterThan(hitsBefore);
		expect(cache.subtreeEstimatedBytes).toBeLessThanOrEqual(maxBytes);
	});

	it("evicts the least recently used subtree, not the oldest inserted", () => {
		const roots = [makeTempDir(), makeTempDir(), makeTempDir(), makeTempDir()];
		const cache = new ContextTreeDiskScanCache({ maxEntries: 3, busyCooldownMs: 0 });
		const [r1, r2, r3, r4] = roots as [string, string, string, string];

		for (const root of [r1, r2, r3]) {
			scan(root, cache);
		}
		expect(cache.subtreeEntries).toBe(3);

		// Touch r1: a hit is a use, so r2 becomes the least recently used entry.
		scan(r1, cache);
		expect(cache.stats.subtreeEmptyHits).toBe(1);
		scan(r4, cache);
		expect(cache.subtreeEntries).toBe(3);

		const missesBefore = cache.stats.subtreeMisses;
		const emptyHitsBefore = cache.stats.subtreeEmptyHits;
		scan(r1, cache);
		scan(r3, cache);
		expect(cache.stats.subtreeEmptyHits).toBe(emptyHitsBefore + 2);
		scan(r2, cache);
		// r2 was evicted, so it walks again: insertion order would have evicted r1 instead.
		expect(cache.stats.subtreeMisses).toBe(missesBefore + 1);
		// Mutation: dropping the delete+re-insert in BoundedCache.get (recency refresh) makes
		// r1 the oldest and evicts it, so the two hits above become one hit and one miss.
	});

	it("expires idle subtrees at the next insert and schedules no timer", () => {
		const roots = [makeTempDir(), makeTempDir(), makeTempDir()];
		const cache = new ContextTreeDiskScanCache({
			idleTtlMs: 1000,
			sweepIntervalMs: 0,
			busyCooldownMs: 0,
		});
		const [r1, r2, r3] = roots as [string, string, string];
		scan(r1, cache);
		expect(cache.subtreeEntries).toBe(1);

		vi.useFakeTimers();
		try {
			vi.advanceTimersByTime(500);
			scan(r2, cache);
			// Positive control: inside the TTL nothing is swept, so this is not a cache that
			// simply refuses to hold two entries.
			expect(cache.subtreeEntries).toBe(2);

			vi.advanceTimersByTime(1500);
			scan(r3, cache);
			// Both r1 (idle 2000ms) and r2 (idle 1500ms) are past the TTL; only r3 remains.
			expect(cache.subtreeEntries).toBe(1);
			expect(scan(r3, cache)).toEqual([]);
			expect(cache.subtreeEntries).toBe(1);
			// No timer, no handle: expiry is insert-triggered, so nothing is scheduled that
			// could keep an event loop alive or fire between refreshes.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
		// Mutation: wiring idleTtlMs as 0 leaves entries at 3 above.
	});

	it("reclaims the entry a moved fingerprint orphans, so residency follows the roster", () => {
		const root = makeTempDir();
		const moving = writeChildDir(root, "sub-aaaa1111", 0.1);
		writeChildDir(root, "sub-bbbb2222", 0.2);
		// The bypass must be off here: this pin is about what a *storing* family retains.
		const cache = new ContextTreeDiskScanCache({ busyCooldownMs: 0 });

		scan(root, cache);
		const entriesAfterFirst = cache.subtreeEntries;
		// One entry per dir the scan read: the root plus its two leaf frames.
		expect(entriesAfterFirst).toBe(3);

		for (let tick = 0; tick < 10; tick++) {
			appendTurn(moving, 0.3 + tick);
			scan(root, cache);
		}
		// Eleven different root fingerprints were stored, and ten of them are unreachable: a
		// dir and shape has exactly one current fingerprint, so the previous key is reclaimed
		// at the store instead of waiting for a ceiling. Without it this reads 13.
		expect(cache.subtreeEntries).toBe(entriesAfterFirst);
		// The root really did miss every tick (its fingerprint moved) and both leaves really
		// did hit every tick (their fingerprint is the empty listing below them), so the flat
		// entry count is reclamation and not a cache that stopped storing.
		expect(cache.stats.subtreeMisses).toBe(13);
		expect(cache.stats.subtreeEmptyHits).toBe(20);
		expect(cache.stats.subtreeHits).toBe(0);
		expect(cache.stats.subtreeStores).toBe(13);
		// Mutation: removing the delete of the previous live key leaves 13 entries.
	});
});

describe("ContextTreeDiskScanCache busy families", () => {
	it("walks a dir that keeps appending without paying the fingerprint, and stays fresh", () => {
		const ticks = 8;
		/** One family of a single appending child, so both arms below start from the same disk. */
		const family = (): { root: string; child: string } => {
			const root = makeTempDir();
			return { root, child: writeChildDir(root, "sub-aaaa1111", 0.1) };
		};
		const appendAndScan = (cache: ContextTreeDiskScanCache): number[] => {
			const { root, child } = family();
			const costs: number[] = [];
			for (let tick = 0; tick < ticks; tick++) {
				appendTurn(child, 1 + tick);
				costs.push(totalCost(scan(root, cache)));
			}
			return costs;
		};

		const bypassed = new ContextTreeDiskScanCache();
		const costs = appendAndScan(bypassed);
		// The bypass walks the disk, so freshness is not what it trades away: every tick sees
		// the turn appended before it.
		expect(costs).toHaveLength(ticks);
		for (let tick = 0; tick < ticks; tick++) {
			// The spend is cumulative over every appended turn: 1 + 2 + ... + (tick + 1).
			expect(costs[tick]).toBeCloseTo(0.1 + ((tick + 1) * (tick + 2)) / 2, 5);
		}
		// Two probes found the tree moved, so the remaining six ticks were walked without a
		// fingerprint at all - and stored nothing, because a walk with no probe has no
		// fingerprint to be keyed by.
		expect(bypassed.stats.subtreeBypasses).toBe(ticks - 2);
		expect(bypassed.stats.subtreeProbes).toBe(10);
		expect(bypassed.stats.subtreeStores).toBe(3);

		// Same family, same ticks, bypass disabled: every tick probes, and the root pays a
		// fingerprint it can only miss with.
		const probing = new ContextTreeDiskScanCache({ busyCooldownMs: 0 });
		expect(appendAndScan(probing)).toEqual(costs);
		expect(probing.stats.subtreeBypasses).toBe(0);
		expect(probing.stats.subtreeProbes).toBe(2 * ticks);
		expect(probing.stats.subtreeStores).toBe(ticks + 1);
		// Mutation: ignoring busyCooldownMs in takeSubtree drops the bypass count to 0 and
		// raises the probe count to 2 * ticks.
	});

	it("gets its hits back once a bypassed family settles", () => {
		const root = makeTempDir();
		const child = writeChildDir(root, "sub-aaaa1111", 0.1);
		const cache = new ContextTreeDiskScanCache();

		for (let tick = 0; tick < 4; tick++) {
			appendTurn(child, 1 + tick);
			scan(root, cache);
		}
		expect(cache.stats.subtreeBypasses).toBe(2);
		expect(cache.stats.subtreeHits).toBe(0);

		// The cooldown ends, the family is quiet: the probe misses once (the tree moved since
		// the last store) and stores, and the tick after that is a hit again. A bypass that
		// could not store would leave this family walking forever.
		vi.useFakeTimers();
		try {
			vi.advanceTimersByTime(61_000);
			scan(root, cache);
			// Two stores from the first tick (root and its leaf frame), one per probe that
			// missed since, and this probe missed: the tree moved while the cooldown ran.
			expect(cache.stats.subtreeStores).toBe(4);
			vi.advanceTimersByTime(61_000);
			scan(root, cache);
			expect(cache.stats.subtreeBypasses).toBe(2);
			expect(cache.stats.subtreeHits).toBeGreaterThan(0);
		} finally {
			vi.useRealTimers();
		}
		// Mutation: skipping the store whenever the last probe missed (instead of only on a
		// bypassed tick) leaves subtreeHits at 0 here - the family is bypassed forever.
	});

	it("splits an empty reuse out of the hit figure, and keys it by dir", () => {
		const root = makeTempDir();
		const aaaa = writeChildDir(root, "sub-aaaa1111", 0.1);
		writeChildDir(root, "sub-bbbb2222", 0.2);
		const cccc = writeChildDir(root, "sub-cccc3333", 0.3);
		writeChildDir(cccc, "sub-dddd4444", 0.4);
		const cache = new ContextTreeDiskScanCache({ busyCooldownMs: 0 });

		scan(root, cache);
		// Five dirs were read, so five entries: the root, three leaf frames (aaaa, bbbb, dddd)
		// and cccc's frame, which is the only one with children. Three of those leaves
		// fingerprint to the same empty string; the dir in the key is what keeps them apart.
		expect(cache.subtreeEntries).toBe(5);

		appendTurn(aaaa, 0.9);
		const second = scan(root, cache);
		expect(totalCost(second)).toBeCloseTo(1.5, 5);
		// The root moved (aaaa's transcript is part of its fingerprint), so it missed; cccc's
		// subtree did not move and handed back a child, and the two leaf frames handed back
		// nothing at all. A single hit counter read 3 here and hid which of them bought anything.
		expect(cache.stats.subtreeHits).toBe(1);
		expect(cache.stats.subtreeEmptyHits).toBe(2);
		expect(cache.stats.subtreeMisses).toBe(6);
		// Mutation A: dropping the dir from the full key collapses the three leaf frames into
		// one entry, so subtreeEntries reads 3. Mutation B: counting an empty reuse as a hit
		// reads subtreeHits 3.
	});

	it("pays the cache nothing when the caller passes no cache", () => {
		const root = makeTempDir();
		writeChildDir(root, "sub-aaaa1111", 0.1);
		const take = vi.spyOn(ContextTreeDiskScanCache.prototype, "takeSubtree");
		const store = vi.spyOn(ContextTreeDiskScanCache.prototype, "storeSubtree");
		const node = vi.spyOn(ContextTreeDiskScanCache.prototype, "nodeOf");
		try {
			expect(scan(root, undefined)).toHaveLength(1);
			expect(take).not.toHaveBeenCalled();
			expect(store).not.toHaveBeenCalled();
			expect(node).not.toHaveBeenCalled();

			// Positive control: with a cache the same scan goes through all three, so the zeros
			// above are the uncached path and not a spy that never fires.
			scan(root, new ContextTreeDiskScanCache());
			expect(take).toHaveBeenCalled();
			expect(store).toHaveBeenCalled();
			expect(node).toHaveBeenCalled();
		} finally {
			take.mockRestore();
			store.mockRestore();
			node.mockRestore();
		}
		// Mutation: constructing a throwaway cache in scanChildrenInto makes the first three
		// assertions red.
	});
});

describe("ContextTreeDiskScanCache budget window", () => {
	it("keeps a subtree when only a candidate the budget refused has moved", () => {
		const root = makeTempDir();
		const aaaa = writeChildDir(root, "sub-aaaa1111", 0.1);
		const bbbb = writeChildDir(root, "sub-bbbb2222", 0.2);
		const cccc = writeChildDir(root, "sub-cccc3333", 0.3);
		// Pin the listing order (newest first): aaaa, bbbb, cccc. Without this the three dirs
		// land in the same millisecond and the tie falls to the path, which is not the order
		// this pin is about.
		pinMtime(cccc, 1_000);
		pinMtime(bbbb, 2_000);
		pinMtime(aaaa, 3_000);
		const budget = { maxChildren: 1 };
		const cache = new ContextTreeDiskScanCache({ busyCooldownMs: 0 });

		const first = scan(root, cache, budget);
		expect(first.map((n) => n.id)).toEqual(["sub-aaaa1111"]);
		const walked = scanContextTreeChildrenFromDisk(root, resolveContextWindow, { budget });
		expect(walked.diagnostics.skippedByBudget).toBe(2);

		// cccc is outside the read prefix: its transcript cannot reach the answer, so an append
		// down there must not throw the remembered roster away.
		appendTurn(cccc, 0.9);
		const hitsBefore = cache.stats.subtreeHits;
		const second = scan(root, cache, budget);
		expect(cache.stats.subtreeHits).toBe(hitsBefore + 1);
		expect(second.map((n) => n.id)).toEqual(["sub-aaaa1111"]);
		// A reused answer still reports the omission the walk reported.
		expect(totalCost(second)).toBeCloseTo(0.1, 5);

		// Control: the candidate the budget *does* read still invalidates, so the pin above is
		// a window and not a cache that stopped looking at the disk.
		appendTurn(aaaa, 0.95);
		const missesBefore = cache.stats.subtreeMisses;
		const third = scan(root, cache, budget);
		expect(cache.stats.subtreeMisses).toBe(missesBefore + 1);
		expect(totalCost(third)).toBeCloseTo(1.05, 5);
		expect(totalCost(third)).toBeCloseTo(totalCost(scan(root, undefined, budget)), 5);

		// Control: a refused candidate that gains its first transcript *does* invalidate,
		// because that is what skippedByBudget counts and a user reads the count.
		const empty = writeEmptyChildDir(root, "sub-eeee5555");
		pinMtime(empty, 500);
		const missesBeforeNew = cache.stats.subtreeMisses;
		scan(root, cache, budget);
		expect(cache.stats.subtreeMisses).toBeGreaterThan(missesBeforeNew);
		writeFileSync(join(empty, "session.jsonl"), `${sessionHeader("sub-eeee5555")}${turn("u1", null, 0.5)}`);
		pinMtime(empty, 500);
		const missesBeforeAppear = cache.stats.subtreeMisses;
		scan(root, cache, budget);
		expect(cache.stats.subtreeMisses).toBeGreaterThan(missesBeforeAppear);
		expect(bbbb).toBeDefined();
		// Mutation: fingerprinting every candidate's transcript (ignoring maxVisible) turns
		// the cccc append into a miss and the first hit assertion red.
	});

	it("covers a read that sits behind dirs with no transcript, which cost the walk no budget", () => {
		const root = makeTempDir();
		// Two dirs the walk lists and skips without spending a read, then the one child the
		// budget of 1 actually buys. A window that counted listing positions would stop at
		// sub-empty0000 and leave the readable child's identity uncovered - i.e. it would
		// serve a roster that predates an append to the only child it shows.
		writeEmptyChildDir(root, "sub-empty0000");
		writeEmptyChildDir(root, "sub-empty0001");
		const readable = writeChildDir(root, "sub-read0002", 0.1);
		pinMtime(readable, 1_000);
		pinMtime(join(root, "sub-empty0001"), 2_000);
		pinMtime(join(root, "sub-empty0000"), 3_000);
		const budget = { maxChildren: 1 };
		const cache = new ContextTreeDiskScanCache({ busyCooldownMs: 0 });

		const first = scan(root, cache, budget);
		expect(first.map((n) => n.id)).toEqual(["sub-read0002"]);
		expect(totalCost(first)).toBeCloseTo(0.1, 5);

		appendTurn(readable, 0.4);
		const second = scan(root, cache, budget);
		// The child the scan reads is inside the window however many empty dirs precede it, so
		// its append invalidates and the second scan reports the disk.
		expect(cache.stats.subtreeMisses).toBeGreaterThan(1);
		expect(totalCost(second)).toBeCloseTo(0.5, 5);
		expect(totalCost(second)).toBeCloseTo(totalCost(scan(root, undefined, budget)), 5);
		// Mutation: counting positions instead of transcript-bearing candidates
		// (`index >= visible`) leaves sub-read0002 uncovered, this scan hits, and the cost
		// above reads the stale 0.1.
	});
});

/** A child whose branch declares a model, so a catalog move is visible in its subtree key. */
function writeChildWithModel(parentDir: string, name: string, cost: number): string {
	const dir = join(parentDir, name);
	mkdirSync(dir, { recursive: true });
	const modelChange = JSON.stringify({
		type: "model_change",
		id: "m1",
		parentId: null,
		timestamp: new Date().toISOString(),
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
	});
	writeFileSync(join(dir, "session.jsonl"), `${sessionHeader(name)}${modelChange}\n${turn("u1", "m1", cost)}`);
	return dir;
}

describe("ContextTreeDiskScanCache store gate", () => {
	it("stores nothing for a bypassed dir whose busy record was evicted before the store", () => {
		const root = makeTempDir();
		const child = writeChildDir(root, "sub-aaaa1111", 0.1);
		// One entry per level is the whole point: the busy record a take leaves behind is
		// exactly what the next `recordSubtreeMiss` of the same scan evicts, so a gate that
		// reads that record cannot survive from the take to the store. The scan's fingerprint
		// memo can: it is a plain Map owned by the walk, so it is not bounded at all.
		const cache = new ContextTreeDiskScanCache({ maxEntries: 1, busyMissThreshold: 1, busyCooldownMs: 60_000 });

		scan(root, cache);
		// The root and its one leaf frame both probed and both stored.
		expect(cache.stats.subtreeStores).toBe(2);

		// The leaf's entry is the survivor of the ceiling above, so this scan hits on it and
		// misses on the root (whose entry the store just evicted): one miss, which arms the
		// root's cooldown, and one store. Nothing else touches the busy level, so the root's
		// record is what is alive when the next scan asks.
		scan(root, cache);
		expect(cache.stats.subtreeBypasses).toBe(0);
		expect(cache.stats.subtreeStores).toBe(3);
		// The gate is not a blanket refusal to store: two of the three stores above are the
		// same leaf and root frames a bypass-less scan stores.

		// The child appends. The root's take is inside its cooldown, so it is bypassed: no
		// fingerprint taken, and therefore no key to store under. The leaf frame then misses
		// (its entry was evicted by the store above) and its own `recordSubtreeMiss` evicts the
		// root's busy record - by the store phase nothing is left that says the root was
		// bypassed, except the memo.
		appendTurn(child, 0.4);
		const afterAppend = totalCost(scan(root, cache));
		expect(cache.stats.subtreeBypasses).toBe(1);
		// Only the leaf frame stored. The bypassed root stored nothing, so it cannot be served
		// later under a fingerprint taken after the disk was read.
		expect(cache.stats.subtreeStores).toBe(4);
		// A bypass walks the disk, so the gate costs no freshness: the appended turn is there.
		expect(afterAppend).toBeCloseTo(0.5, 5);
		// Mutation: gating on the busy record's `bypassed` flag finds the record evicted and
		// stores the bypassed root anyway, under a fingerprint taken *after* the walk - so
		// subtreeStores reads 5 here and the next scan can hit nodes that predate their key.
	});
});

describe("ContextTreeDiskScanCache catalog moves", () => {
	it("counts a moved model window as a miss without calling the dir busy", () => {
		const root = makeTempDir();
		const child = writeChildWithModel(root, "sub-aaaa1111", 0.1);
		let window = 200_000;
		const resolver = (): number => window;
		const cache = new ContextTreeDiskScanCache();
		const scanWith = (): ContextTreeNode[] =>
			loadContextTreeChildrenFromDisk(root, resolver, undefined, undefined, cache);

		const first = scanWith();
		expect(first[0].contextUsage?.contextWindow).toBe(200_000);
		const missesAfterFirst = cache.stats.subtreeMisses;

		// The catalog moves under a family that is perfectly still. The fingerprint matches, so
		// the entry is found, and its model window is not what the resolver now says: the
		// percentages have to be re-derived rather than served with the old denominator.
		window = 400_000;
		const second = scanWith();
		expect(second[0].contextUsage?.contextWindow).toBe(400_000);
		expect(second[0].ownUsage.cost.total).toBeCloseTo(0.1, 5);
		// One miss for the one frame whose window moved; the leaf frame below it holds no model
		// and hits. And no bypass: a catalog that moved says nothing about this dir appending.
		expect(cache.stats.subtreeMisses).toBe(missesAfterFirst + 1);
		expect(cache.stats.subtreeBypasses).toBe(0);

		// Nothing moved on disk, so the family is served again: a catalog move must not switch a
		// still family off the cache, which is what arming the cooldown would have done.
		const hitsBefore = cache.stats.subtreeHits;
		const third = scanWith();
		expect(third[0].contextUsage?.contextWindow).toBe(400_000);
		expect(cache.stats.subtreeHits).toBeGreaterThan(hitsBefore);
		expect(cache.stats.subtreeBypasses).toBe(0);
		// Mutation: feeding the window mismatch to `recordSubtreeMiss` as well reaches the
		// threshold of 2 with the first scan's ordinary miss, so this third scan is bypassed
		// instead of a hit and subtreeBypasses reads 1. Deleting the shared `recordSubtreeMiss`
		// call outright is not the fix either: it also feeds the "no entry at all" miss, and
		// the two busy-family pins above then read subtreeBypasses 0 instead of 6 and 2.

		// Positive control, so the zeros above are not a bypass that can never arm: the same
		// cache bypasses a family that really does keep moving.
		for (let tick = 0; tick < 3; tick++) {
			appendTurn(child, 1 + tick);
			scanWith();
		}
		expect(cache.stats.subtreeBypasses).toBeGreaterThan(0);
	});
});
