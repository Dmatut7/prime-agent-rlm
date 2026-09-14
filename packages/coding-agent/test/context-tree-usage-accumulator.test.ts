import { describe, expect, it } from "vitest";
import { computeOwnAndTotalUsage, OwnUsageAccumulator } from "../src/core/context-tree.js";
import type { SessionEntry } from "../src/core/session-manager.js";
import { emptyUsage } from "../src/core/usage.js";

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
		timestamp: "2026-09-14T00:00:00.000Z",
		message: { role: "assistant", usage: usage(input, output) },
	}) as unknown as SessionEntry;
const attributed = (id: string, targetId: string, input: number, output: number) =>
	({
		type: "child_usage_attributed",
		id,
		parentId: null,
		timestamp: "2026-09-14T00:00:00.000Z",
		targetId,
		childUsage: usage(input, output),
	}) as unknown as SessionEntry;

/**
 * The accumulator owns the totals a live session publishes while a turn appends. It has to
 * agree with the whole-file computation for every shape the transcript can take, because the
 * roster rows and /usage both read it and a drift would move someone's spend.
 */
describe("incremental own-usage totals", () => {
	const shapes: Array<[string, SessionEntry[]]> = [
		["assistants only", [assistant("a1", 10, 1), assistant("a2", 20, 2)] as SessionEntry[]],
		[
			"attribution after its target",
			[assistant("a1", 10, 1), attributed("u1", "a1", 4, 1), assistant("a2", 20, 2)] as SessionEntry[],
		],
		[
			"attribution before its target",
			[attributed("u1", "a2", 4, 1), assistant("a1", 10, 1), assistant("a2", 20, 2)] as SessionEntry[],
		],
		[
			"attribution whose target never appears",
			[assistant("a1", 10, 1), attributed("u1", "ghost", 4, 1)] as SessionEntry[],
		],
		[
			"compaction usage counts as spend",
			[
				assistant("a1", 10, 1),
				{
					type: "compaction",
					id: "c1",
					parentId: "a1",
					timestamp: "t",
					usage: usage(7, 3),
				} as unknown as SessionEntry,
			] as SessionEntry[],
		],
	];

	it("matches the whole-file computation for every append boundary", () => {
		expect(shapes.length).toBeGreaterThan(0);
		for (const [label, entries] of shapes) {
			const expected = computeOwnAndTotalUsage(entries, entries);
			// Fed one entry at a time: this is how a live session appends, and it is where an
			// accumulator that only works on a single batch would break.
			const accumulator = new OwnUsageAccumulator();
			let actual = { ownUsage: emptyUsage(), totalUsage: emptyUsage() };
			for (let index = 1; index <= entries.length; index++) {
				actual = accumulator.add(entries.slice(0, index));
				const soFar = computeOwnAndTotalUsage(entries.slice(0, index), entries.slice(0, index));
				expect(actual.ownUsage, `${label}: own usage at ${index} entries`).toEqual(soFar.ownUsage);
				expect(actual.totalUsage, `${label}: total usage at ${index} entries`).toEqual(soFar.totalUsage);
			}
			expect(actual.ownUsage, `${label}: own usage`).toEqual(expected.ownUsage);
			expect(actual.totalUsage, `${label}: total usage`).toEqual(expected.totalUsage);
		}
	});

	it("does not reprocess entries it already folded", () => {
		const entries = [assistant("a1", 10, 1), assistant("a2", 20, 2)] as SessionEntry[];
		const accumulator = new OwnUsageAccumulator();
		accumulator.add(entries);
		const before = accumulator.processedCount;
		const again = accumulator.add(entries);
		expect(accumulator.processedCount).toBe(before);
		// Positive control for the fold itself: the totals are the real ones, not zero.
		expect(again.ownUsage.totalTokens).toBe(33);
		expect(again.totalUsage.totalTokens).toBe(33);
	});
});
