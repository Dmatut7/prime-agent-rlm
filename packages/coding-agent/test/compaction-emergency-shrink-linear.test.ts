/**
 * The emergency-shrink valve: the same cut it chose before it was linearized, at a
 * cost that grows with the span instead of with the square of the span.
 *
 * Two claims, two needles.
 *
 * Equivalence. `planEmergencyShrink` replaced "walk the whole span once per
 * candidate cut" with two folded running totals plus one walk of the chosen cut.
 * The plan it returns has to be identical to the old walk's, field by field, over
 * randomized branches and over the thresholds and target ratios that decide which
 * branch of the search runs. The old walk is checked in verbatim as
 * `test/fixtures/emergency-shrink-reference.ts`; when the two disagree, the
 * reference is the semantics and the planner is the bug.
 *
 * Linearity. The valve runs synchronously on the largest context a session ever
 * reaches, with the event loop frozen for its duration, so the growth rate is the
 * point of the fix: before it, 2025 entries cost 27.5s and 3200 entries 54.8s
 * (power-law exponent 3.96, perfC EVIDENCE/compaction/shrink-idle.txt), which
 * extrapolates to hours on a 50MB branch. Three decades of branch size have to cost
 * three decades of time. The reference planner is timed on the same fixture shape
 * and put through the same judge, because a linearity assertion the old code also
 * passes would be decoration.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	EMERGENCY_SHRINK_TARGET_RATIO,
	estimateTokensByContent,
	planEmergencyShrink,
} from "../src/core/compaction/index.js";
import { buildSessionContext, type SessionEntry } from "../src/core/session-manager.js";
import { planEmergencyShrinkReference } from "./fixtures/emergency-shrink-reference.js";

function usage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Deterministic PRNG, so a failing differential can be replayed from its seed. */
function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function pick<T>(rnd: () => number, items: readonly T[]): T {
	return items[Math.min(items.length - 1, Math.floor(rnd() * items.length))];
}

/** Text shapes that price differently under the content-density caliber. */
const TEXT_SHAPES: ReadonlyArray<(size: number, rnd: () => number) => string> = [
	(size) => `task ${"word ".repeat(Math.max(1, Math.floor(size / 5)))}`.slice(0, size),
	(size) => "压缩阀门必须保持线性 ".repeat(Math.max(1, Math.floor(size / 12))).slice(0, size),
	(size) => "```ts\nconst value = 1;\n".padEnd(Math.max(22, size), "x").concat("\n```"),
	(size) => "x".repeat(size),
	(size) =>
		`${"0123456789abcdef".repeat(3)} exit code 2 reserveTokens: ${size} #12345 `.repeat(
			Math.max(1, Math.floor(size / 60)),
		),
	() => "",
];

function messageFor(rnd: () => number, size: number): AgentMessage {
	const text = pick(rnd, TEXT_SHAPES)(size, rnd);
	switch (Math.floor(rnd() * 7)) {
		case 0:
			return {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: text },
					{ type: "text", text },
					{ type: "toolCall", id: `tc-${Math.floor(rnd() * 1000)}`, name: "bash", arguments: { command: text } },
				],
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
				api: "faux",
				provider: "faux",
				model: "faux-1",
			} as unknown as AgentMessage;
		case 1:
			return {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "bash",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		case 2:
			return {
				role: "bashExecution",
				command: text || "ls",
				output: text,
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		case 3:
			// An image prices as a flat token count, not as characters.
			return {
				role: "user",
				content: [
					{ type: "text", text },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		case 4:
			return {
				role: "custom",
				customType: "refinement_outcome",
				content: text,
				display: true,
				timestamp: Date.now(),
			} as unknown as AgentMessage;
		case 5:
			return {
				role: "assistant",
				content: [],
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
				api: "faux",
				provider: "faux",
				model: "faux-1",
			} as unknown as AgentMessage;
		default:
			return { role: "user", content: text, timestamp: Date.now() } as unknown as AgentMessage;
	}
}

interface BranchOptions {
	/** Payload size each entry is built around. */
	size?: number;
	/** Plant a compaction boundary, so spanStart/cutStart move off the branch head. */
	compactionAt?: number;
	/** Point the boundary's firstKeptEntryId at an entry that does not exist. */
	danglingKeptId?: boolean;
	/** Plant branch summaries, including one with an empty summary text. */
	summaries?: boolean;
	/** Plant entries that produce no message at all (labels, model changes). */
	markers?: boolean;
}

/** A branch of `count` entries with stable ids, a parent chain and rising timestamps. */
function makeBranch(count: number, seed: number, options: BranchOptions = {}): SessionEntry[] {
	const rnd = lcg(seed);
	const size = options.size ?? 40 + Math.floor(rnd() * 200);
	const entries: SessionEntry[] = [];
	const base = Date.parse("2026-09-18T00:00:00.000Z");
	let lastId: string | null = null;
	const push = (entry: SessionEntry): void => {
		entries.push(entry);
		lastId = entry.id;
	};
	const stamp = (index: number): string => new Date(base + index * 1000).toISOString();

	for (let i = 0; i < count; i++) {
		const id = `entry-${seed}-${i}`;
		const parentId = lastId;
		const timestamp = stamp(i);
		if (options.compactionAt === i) {
			push({
				type: "compaction",
				id,
				parentId,
				timestamp,
				summary: `compaction summary ${"s".repeat(size)}`,
				firstKeptEntryId: options.danglingKeptId ? "entry-does-not-exist" : `entry-${seed}-${Math.max(0, i - 3)}`,
				tokensBefore: 1000,
			});
			continue;
		}
		if (options.summaries && i % 11 === 5) {
			push({
				type: "branch_summary",
				id,
				parentId,
				timestamp,
				fromId: parentId ?? id,
				// Every fourth summary is empty: an empty summary carries nothing forward
				// and must not add to the tokens a cut keeps.
				summary: i % 44 === 5 ? "" : `branch summary ${"b".repeat(size)}`,
			});
			continue;
		}
		if (options.markers && i % 13 === 7) {
			push({ type: "model_change", id, parentId, timestamp, provider: "faux", modelId: "faux-1" });
			continue;
		}
		if (options.markers && i % 17 === 9) {
			push({ type: "label", id, parentId, timestamp, targetId: parentId ?? id, label: "tag" });
			continue;
		}
		if (options.markers && i % 19 === 11) {
			push({
				type: "custom_message",
				id,
				parentId,
				timestamp,
				customType: "harness_digest",
				content: `digest ${"d".repeat(size)}`,
				display: false,
			});
			continue;
		}
		push({ type: "message", id, parentId, timestamp, message: messageFor(rnd, size) });
	}
	return entries;
}

/** The branch's own price in the planner's caliber, used to place thresholds. */
function branchTokens(entries: SessionEntry[]): number {
	return buildSessionContext(entries).messages.reduce((total, message) => total + estimateTokensByContent(message), 0);
}

interface Coverage {
	compared: number;
	planDefined: number;
	planUndefined: number;
	reachedTarget: number;
	deepestFallback: number;
	carriedSummaries: number;
	multiRoleSpan: number;
	droppedTimestamps: number;
}

function newCoverage(): Coverage {
	return {
		compared: 0,
		planDefined: 0,
		planUndefined: 0,
		reachedTarget: 0,
		deepestFallback: 0,
		carriedSummaries: 0,
		multiRoleSpan: 0,
		droppedTimestamps: 0,
	};
}

/**
 * One differential: the planner and the checked-in old walk must return the same
 * plan, whole-object, for the same branch and the same numbers.
 */
function expectSamePlan(
	entries: SessionEntry[],
	threshold: number,
	targetRatio: number | undefined,
	coverage: Coverage,
	label: string,
): void {
	const actual =
		targetRatio === undefined
			? planEmergencyShrink(entries, threshold)
			: planEmergencyShrink(entries, threshold, targetRatio);
	const expected =
		targetRatio === undefined
			? planEmergencyShrinkReference(entries, threshold)
			: planEmergencyShrinkReference(entries, threshold, targetRatio);
	coverage.compared += 1;
	// toEqual on the whole plan, not on selected fields: the notice the valve writes
	// is built from span.droppedRoles and the carried summaries, so a planner that
	// picked the right cut but counted the span differently would still be wrong.
	expect(actual, label).toEqual(expected);
	if (actual === undefined) {
		coverage.planUndefined += 1;
		return;
	}
	coverage.planDefined += 1;
	if (actual.reachedTarget) coverage.reachedTarget += 1;
	else coverage.deepestFallback += 1;
	if (actual.carriedSummaries.length > 0) coverage.carriedSummaries += 1;
	if (Object.keys(actual.span.droppedRoles).length > 1) coverage.multiRoleSpan += 1;
	if (actual.span.firstDroppedTimestamp !== undefined) coverage.droppedTimestamps += 1;
}

/** Every coverage counter a differential run has to hit, so the loop cannot pass by comparing nothing. */
function expectCoverage(coverage: Coverage): void {
	expect(coverage.compared).toBeGreaterThan(0);
	expect(coverage.planDefined, "a plan was produced").toBeGreaterThan(0);
	expect(coverage.planUndefined, "the nothing-to-do exits were reached").toBeGreaterThan(0);
	expect(coverage.reachedTarget, "a cut reached the target").toBeGreaterThan(0);
	expect(coverage.deepestFallback, "the deepest-cut fallback was reached").toBeGreaterThan(0);
	expect(coverage.carriedSummaries, "a summary was carried forward").toBeGreaterThan(0);
	expect(coverage.multiRoleSpan, "a span dropped more than one role").toBeGreaterThan(0);
	expect(coverage.droppedTimestamps, "a dropped span reported its timestamps").toBeGreaterThan(0);
}

/** Thresholds that place the target at different depths, plus the two degenerate ends. */
function thresholdsFor(total: number): number[] {
	return [
		0,
		-1,
		10,
		...[8, 3, 1.6, 1.1, 0.9, 0.5].map((divisor) => Math.max(1, Math.round(total / divisor))),
		1_000_000_000,
	];
}

describe("planEmergencyShrink equivalence with the pre-linearization walk", () => {
	it("returns the same plan as the old per-cut walk over randomized branches", () => {
		const coverage = newCoverage();
		const sizes = [3, 8, 17, 40, 97];
		const ratios: Array<number | undefined> = [undefined, 0.05, 0.5, 0.95, 1];
		let compared = 0;
		for (let seed = 1; seed <= 12; seed++) {
			for (const count of sizes) {
				const entries = makeBranch(count, seed, {
					compactionAt: count > 20 ? Math.floor(count / 3) : undefined,
					danglingKeptId: seed % 3 === 0,
					summaries: seed % 2 === 0,
					markers: seed % 4 !== 1,
				});
				const total = branchTokens(entries);
				for (const threshold of thresholdsFor(total)) {
					for (const ratio of ratios) {
						expectSamePlan(
							entries,
							threshold,
							ratio,
							coverage,
							`seed=${seed} count=${count} thr=${threshold} ratio=${ratio}`,
						);
						compared += 1;
					}
				}
			}
		}
		expect(compared).toBe(12 * sizes.length * thresholdsFor(1).length * ratios.length);
		expectCoverage(coverage);
	});

	it("returns the same plan on the deeper branches the valve is actually called on", () => {
		const coverage = newCoverage();
		let compared = 0;
		for (const count of [200, 400]) {
			for (let seed = 1; seed <= 3; seed++) {
				const entries = makeBranch(count, seed + 100, {
					size: 120,
					compactionAt: Math.floor(count / 4),
					summaries: true,
					markers: true,
				});
				const total = branchTokens(entries);
				for (const threshold of [10, Math.round(total / 1.2), Math.round(total / 0.9), 1_000_000_000]) {
					expectSamePlan(entries, threshold, undefined, coverage, `count=${count} seed=${seed} thr=${threshold}`);
					compared += 1;
				}
			}
		}
		expect(compared).toBe(2 * 3 * 4);
		expect(coverage.planDefined).toBeGreaterThan(0);
		expect(coverage.reachedTarget).toBeGreaterThan(0);
		expect(coverage.deepestFallback).toBeGreaterThan(0);
		expect(coverage.carriedSummaries).toBeGreaterThan(0);
	});

	it("agrees on the structural edges: no entries, no threshold, no cut point, dangling boundary", () => {
		const coverage = newCoverage();
		const cases: Array<{ label: string; entries: SessionEntry[]; threshold: number }> = [
			{ label: "empty branch", entries: [], threshold: 1000 },
			{ label: "zero threshold", entries: makeBranch(20, 7), threshold: 0 },
			{
				// Tool results are never a cut point, so a branch of only them has nowhere to move.
				label: "no valid cut point",
				entries: Array.from({ length: 12 }, (_, i) => ({
					type: "message" as const,
					id: `tr-${i}`,
					parentId: i === 0 ? null : `tr-${i - 1}`,
					timestamp: new Date(Date.parse("2026-09-18T00:00:00.000Z") + i * 1000).toISOString(),
					message: {
						role: "toolResult" as const,
						toolCallId: `tc-${i}`,
						toolName: "bash",
						content: [{ type: "text" as const, text: "r".repeat(200) }],
						isError: false,
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				})),
				threshold: 10,
			},
			{
				label: "dangling firstKeptEntryId",
				entries: makeBranch(60, 11, { compactionAt: 20, danglingKeptId: true, summaries: true }),
				threshold: 40,
			},
			{
				label: "boundary at the branch head",
				entries: makeBranch(60, 12, { compactionAt: 0, summaries: true }),
				threshold: 40,
			},
			{
				label: "empty summaries only",
				entries: makeBranch(60, 13, { summaries: true, size: 30 }).map((entry) =>
					entry.type === "branch_summary" ? { ...entry, summary: "" } : entry,
				),
				threshold: 40,
			},
		];
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			expectSamePlan(testCase.entries, testCase.threshold, undefined, coverage, testCase.label);
		}
		expectCoverage(coverage);
	});
});

/**
 * Smallest of the runs in CPU time (user+system), converted to ms: the least
 * contaminated by GC, and immune to preemption by whatever else is on the
 * machine. Wall-clock made the decade ratio load-sensitive - the small tiers
 * best-of'd a clean scheduler slice while the 100k tier could not, inflating
 * growthOverLinear past 2 on a fully loaded host (measured 0.91/2.21 under
 * 10-core saturation); the planner itself stayed linear. The judge's budget
 * (at most 2x per decade on top of linear) is unchanged - only the clock is.
 */
function timeBestOf(fn: () => unknown, iters: number): number {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < iters; i++) {
		const started = process.cpuUsage();
		fn();
		const spent = process.cpuUsage(started);
		best = Math.min(best, (spent.user + spent.system) / 1000);
	}
	return best;
}

/**
 * Measured growth against what a linear cost predicts: 1 means time grew exactly in
 * proportion to the work, 4 means the size grew tenfold and the time grew forty.
 */
function growthOverLinear(timeSmall: number, timeLarge: number, sizeFactor: number): number {
	return timeLarge / Math.max(timeSmall, 1e-9) / sizeFactor;
}

/** A branch whose target is reached partway in, so the cut search walks a long way. */
function shrinkFixture(count: number, seed: number, payload: number): { entries: SessionEntry[]; threshold: number } {
	const entries = makeBranch(count, seed, { size: payload, summaries: true, markers: true });
	const total = branchTokens(entries);
	// target = floor(threshold * 0.7); aiming it at 55% of the branch leaves the cut
	// somewhere in the first half, which is the deepest walk the valve ever does.
	const threshold = Math.max(1, Math.ceil((total * 0.55) / EMERGENCY_SHRINK_TARGET_RATIO));
	return { entries, threshold };
}

describe("planEmergencyShrink cost", () => {
	it("grows linearly over three decades of branch size", { timeout: 180_000 }, () => {
		const tiers = [1_000, 10_000, 100_000];
		const times: number[] = [];
		const plans: Array<ReturnType<typeof planEmergencyShrink>> = [];
		for (const count of tiers) {
			const { entries, threshold } = shrinkFixture(count, 5, 200);
			const warm = planEmergencyShrink(entries, threshold);
			// The walk this measures has to be a real one: a plan that came back
			// undefined (already under target) or cut at the first candidate would
			// make any timing look linear.
			expect(warm, `count=${count}`).toBeDefined();
			expect(warm?.reachedTarget, `count=${count}`).toBe(true);
			expect(warm?.span.droppedEntries ?? 0, `count=${count}`).toBeGreaterThan(count * 0.2);
			expect(warm?.firstKeptEntryIndex ?? 0, `count=${count}`).toBeGreaterThan(count * 0.2);
			plans.push(warm);
			times.push(timeBestOf(() => planEmergencyShrink(entries, threshold), count >= 100_000 ? 2 : 3));
		}
		expect(times.length).toBe(tiers.length);
		const growths = [
			growthOverLinear(times[0], times[1], tiers[1] / tiers[0]),
			growthOverLinear(times[1], times[2], tiers[2] / tiers[1]),
		];
		const detail = `tiers=${tiers.join("/")} cpuMs=${times.map((t) => t.toFixed(1)).join("/")} growthOverLinear=${growths
			.map((g) => g.toFixed(2))
			.join("/")}`;
		// The judge: per decade of entries, time may at most double on top of the
		// decade itself. The quadratic walk this replaced scored ~100 per decade.
		expect(growths[0], detail).toBeLessThanOrEqual(2);
		expect(growths[1], detail).toBeLessThanOrEqual(2);
		expect(plans[2]?.span.droppedEntries ?? 0).toBeGreaterThan(plans[0]?.span.droppedEntries ?? 0);
	});

	it("puts the old per-cut walk through the same judge, and it fails it", { timeout: 180_000 }, () => {
		// Positive control for the linearity judge above: the same fixture shape,
		// the same timing, the same threshold, run against the checked-in old
		// planner. If this does not come out superlinear, the judge is decoration.
		const tiers = [500, 1_000, 2_000];
		const reference: number[] = [];
		const linearized: number[] = [];
		for (const count of tiers) {
			const { entries, threshold } = shrinkFixture(count, 9, 60);
			const oldPlan = planEmergencyShrinkReference(entries, threshold);
			const newPlan = planEmergencyShrink(entries, threshold);
			expect(oldPlan?.reachedTarget, `count=${count}`).toBe(true);
			expect(newPlan).toEqual(oldPlan);
			reference.push(timeBestOf(() => planEmergencyShrinkReference(entries, threshold), 2));
			linearized.push(timeBestOf(() => planEmergencyShrink(entries, threshold), 2));
		}
		const refGrowth = growthOverLinear(reference[0], reference[2], tiers[2] / tiers[0]);
		const newGrowth = growthOverLinear(linearized[0], linearized[2], tiers[2] / tiers[0]);
		const detail = `reference cpuMs=${reference.map((t) => t.toFixed(1)).join("/")} linearized cpuMs=${linearized
			.map((t) => t.toFixed(1))
			.join("/")}`;
		// cuts x entries: quadrupling the branch multiplies the walk by ~16, so the
		// growth over linear is ~4. Anything above 3 says the judge can see it.
		expect(refGrowth, detail).toBeGreaterThan(3);
		// The same judge the three-decade test uses, applied where the old walk is
		// still affordable: the linearized planner has to pass it on this fixture
		// shape too, or the pass above could be a fixture that never walks far.
		expect(newGrowth, detail).toBeLessThanOrEqual(2);
	});
});
