/**
 * JIT-1 (round-44, K3 plan A): the vouch predicate's tool-in-flight conjunction flips on every
 * tool start/end boundary, so a short-cell polling loop (10s period in production) emitted one
 * exemption started/cleared pair per cell - ~17k stall-evidence lines a day burying the records
 * that matter. Touch-sampled transitions are folded into one merged summary per minute; what a
 * timer fire samples (the blink that banks a budget, the birth that inherits it), exhaustion and
 * abort deferrals stay per-event, and the budget semantics themselves are untouched.
 */

import { describe, expect, it } from "vitest";
import {
	STALL_VOUCH_LIVENESS_BUDGET_MS,
	type StallExemptionEvent,
	type StallVouchFacts,
	StallWatchdog,
	type StallWatchdogStageInfo,
} from "../src/core/stall-watchdog.js";
import { MINUTE_MS, StallFakeClock } from "./fixtures/stall-fake-clock.js";

interface Harness {
	clock: StallFakeClock;
	stages: StallWatchdogStageInfo[];
	exemptionEvents: StallExemptionEvent[];
	watchdog: StallWatchdog;
	stageNames(): string[];
}

function createHarness(options?: {
	warnAfterMs?: number;
	abortAfterMs?: number;
	vouch?: () => StallVouchFacts | undefined;
}): Harness {
	const clock = new StallFakeClock();
	const stages: StallWatchdogStageInfo[] = [];
	const exemptionEvents: StallExemptionEvent[] = [];
	const watchdog = new StallWatchdog({
		enabled: true,
		warnAfterMs: options?.warnAfterMs ?? 5 * MINUTE_MS,
		abortAfterMs: options?.abortAfterMs ?? 15 * MINUTE_MS,
		timers: clock.timersImpl,
		vouch: options?.vouch,
		onExemptionEvent: (event) => exemptionEvents.push(event),
		onStage: (info) => stages.push(info),
	});
	return {
		clock,
		stages,
		exemptionEvents,
		watchdog,
		stageNames: () => stages.map((stage) => stage.stage),
	};
}

/** The vouch shape the degraded journal path reports: existence only, short tier. */
const LIVE_REASONS = ["live_bash_handles", "degraded_journal"];

describe("StallWatchdog vouch flutter logging (JIT-1A)", () => {
	it("folds tool-boundary flutter into merged summaries instead of per-event lines", () => {
		const vouchOn = { value: false };
		const h = createHarness({
			vouch: () => (vouchOn.value ? { active: true, tier: "liveness", reasons: LIVE_REASONS } : undefined),
		});
		h.watchdog.arm();

		// The production shape: a ~10s polling loop of 30ms cells. Every cell start turns the
		// vouch on (a tool is in flight), every cell end turns it off - two transitions per
		// cell, each of which HEAD logged as its own exemption line.
		const CELLS = 12;
		for (let i = 0; i < CELLS; i++) {
			vouchOn.value = true;
			h.watchdog.touch();
			h.clock.advance(30);
			vouchOn.value = false;
			h.watchdog.touch();
			h.clock.advance(10_000);
		}
		h.watchdog.disarm();

		const perEvent = h.exemptionEvents.filter((event) =>
			["started", "resumed", "cleared", "reason_switch"].includes(event.kind),
		);
		expect(perEvent, "touch-sampled transitions must not reach the log one pair at a time").toHaveLength(0);

		const summaries = h.exemptionEvents.filter((event) => event.kind === "micro_segments");
		expect(summaries.length).toBeGreaterThan(0);
		// One line per flush interval plus at most the disarm tail.
		expect(summaries.length).toBeLessThanOrEqual(3);
		const folded = summaries.reduce((total, summary) => total + (summary.count ?? 0), 0);
		expect(folded).toBe(2 * CELLS);
		for (const summary of summaries) {
			expect(summary.reason).toBe("vouched");
			expect(summary.reasons).toContain("live_bash_handles");
			expect(summary.count ?? 0).toBeGreaterThan(0);
		}
	});

	it("keeps timer-fire transitions per-event and flushes the pending folds ahead of them", () => {
		const vouchOn = { value: false };
		const h = createHarness({
			vouch: () => (vouchOn.value ? { active: true, tier: "liveness", reasons: LIVE_REASONS } : undefined),
		});
		h.watchdog.arm();

		for (let i = 0; i < 3; i++) {
			vouchOn.value = true;
			h.watchdog.touch();
			h.clock.advance(30);
			vouchOn.value = false;
			h.watchdog.touch();
			h.clock.advance(10_000);
		}
		// A long cell starts and no further event arrives: the next sample belongs to the
		// timer, and what it observes is the forensic half - it must stay per-event.
		vouchOn.value = true;
		h.clock.advance(5 * MINUTE_MS);

		const started = h.exemptionEvents.filter((event) => event.kind === "started");
		expect(started).toHaveLength(1);

		const summaryIndex = h.exemptionEvents.findIndex((event) => event.kind === "micro_segments");
		const startedIndex = h.exemptionEvents.findIndex((event) => event.kind === "started");
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		expect(summaryIndex).toBeLessThan(startedIndex);
		// The folded window holds the three start/end pairs, not the fire-sampled birth.
		expect(h.exemptionEvents[summaryIndex]?.count).toBe(6);
	});

	it("still kills genuine vouched silence at the liveness budget after a flutter phase (positive control)", () => {
		const vouchOn = { value: false };
		const h = createHarness({
			vouch: () => (vouchOn.value ? { active: true, tier: "liveness", reasons: LIVE_REASONS } : undefined),
		});
		h.watchdog.arm();

		for (let i = 0; i < 6; i++) {
			vouchOn.value = true;
			h.watchdog.touch();
			h.clock.advance(30);
			vouchOn.value = false;
			h.watchdog.touch();
			h.clock.advance(10_000);
		}
		// The flutter stops and the vouch stays claimed with nothing arriving: this is the
		// silence the budget exists for, and folding log lines must not soften it.
		vouchOn.value = true;
		h.clock.advance(30 * MINUTE_MS);

		expect(h.stageNames()).toContain("abort");
		// The kill is budget-driven, not an accident of the thresholds: the abort stage
		// carries an exemption that had already reached its cap.
		const abort = h.stages.find((stage) => stage.stage === "abort");
		expect(abort?.exemption?.exhausted).toBe(true);
		// The single most load-bearing line keeps its own entry.
		const exhausted = h.exemptionEvents.filter((event) => event.kind === "exhausted");
		expect(exhausted).toHaveLength(1);
		expect(exhausted[0]?.budgetMs).toBe(STALL_VOUCH_LIVENESS_BUDGET_MS);
	});
});
