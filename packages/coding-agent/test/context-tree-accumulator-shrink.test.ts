import { describe, expect, it } from "vitest";
import { computeOwnAndTotalUsage, OwnUsageAccumulator } from "../src/core/context-tree.js";
import type { SessionEntry } from "../src/core/session-manager.js";

const usage = (input: number, output: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const assistant = (id: string, input: number, output: number) =>
	({
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-15T00:00:00.000Z",
		message: { role: "assistant", usage: usage(input, output) },
	}) as unknown as SessionEntry;
const attributed = (id: string, targetId: string, input: number, output: number) =>
	({
		type: "child_usage_attributed",
		id,
		parentId: null,
		timestamp: "2026-09-15T00:00:00.000Z",
		targetId,
		childUsage: usage(input, output),
	}) as unknown as SessionEntry;

/**
 * `OwnUsageAccumulator` documents itself as "same entries in, same totals out", but the cursor
 * that makes the fold incremental only ever moves forward. A session manager hands the same
 * accumulator an array that can get shorter (a failed append rolls its entry back) or whose tail
 * is replaced at the same length, and the totals then describe a transcript that no longer exists.
 * The row a user sees as "already spent" must never carry entries that were rolled back.
 */
describe("OwnUsageAccumulator across a shrinking entry array", () => {
	it("rebuilds after a shorter batch instead of keeping the old totals (IT-4)", () => {
		const batchA = [assistant("a1", 10, 1), attributed("u1", "a1", 4, 1), assistant("a2", 20, 2)];
		const batchB = [assistant("b1", 5, 5)];

		const accumulator = new OwnUsageAccumulator();
		accumulator.add(batchA);
		const afterShrink = accumulator.add(batchB);

		// Independent fold of batchB is the only defensible answer for batchB.
		const truth = computeOwnAndTotalUsage(batchB, batchB);
		expect(afterShrink.ownUsage, "own usage after the array shrank").toEqual(truth.ownUsage);
		expect(afterShrink.totalUsage, "total usage after the array shrank").toEqual(truth.totalUsage);

		// And the rebuild must not be a one-shot: growing again from the shorter array folds on.
		const grown = [...batchB, assistant("b2", 7, 7)];
		const grownTruth = computeOwnAndTotalUsage(grown, grown);
		const afterGrowth = accumulator.add(grown);
		expect(afterGrowth.ownUsage).toEqual(grownTruth.ownUsage);
		expect(afterGrowth.totalUsage).toEqual(grownTruth.totalUsage);
	});

	it("rebuilds when the entry it stopped at is replaced at the same length (IT-4)", () => {
		// The rollback shape: pop the failed entry, push a different one. Same length, so a
		// length-only guard would miss it and the replaced entry would stay folded at its old cost.
		const batchA = [assistant("a1", 10, 1), assistant("a2", 20, 2)];
		const replaced = [assistant("a1", 10, 1), assistant("z2", 99, 9)];

		const accumulator = new OwnUsageAccumulator();
		accumulator.add(batchA);
		const afterReplace = accumulator.add(replaced);

		const truth = computeOwnAndTotalUsage(replaced, replaced);
		expect(afterReplace.ownUsage).toEqual(truth.ownUsage);
		expect(afterReplace.totalUsage).toEqual(truth.totalUsage);
	});

	it("control: an append-only session still folds each entry exactly once", () => {
		const entries = [assistant("a1", 10, 1), attributed("u1", "a1", 4, 1), assistant("a2", 20, 2)];
		const accumulator = new OwnUsageAccumulator();
		expect(accumulator.add(entries.slice(0, 1)).ownUsage).toEqual(
			computeOwnAndTotalUsage(entries.slice(0, 1), entries.slice(0, 1)).ownUsage,
		);
		const first = accumulator.add(entries);
		expect(first.ownUsage).toEqual(computeOwnAndTotalUsage(entries, entries).ownUsage);
		// Re-offering the same array folds nothing: the guard must not mistake a republish for a
		// rewritten transcript, or the incremental fold would pay O(n) on every republication.
		const republished = accumulator.add(entries);
		expect(accumulator.processedCount).toBe(entries.length);
		expect(republished.ownUsage).toEqual(first.ownUsage);
	});
});
