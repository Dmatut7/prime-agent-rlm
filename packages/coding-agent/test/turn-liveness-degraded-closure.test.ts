import { describe, expect, it } from "vitest";
import type { KernelLivenessSample } from "../src/core/kernel/shared.js";
import {
	STALL_VOUCH_LIVENESS_BUDGET_MS,
	type StallVouchFacts,
	StallWatchdog,
	type StallWatchdogStageInfo,
} from "../src/core/stall-watchdog.js";
import {
	createTurnLiveness,
	DEFAULT_DEGRADED_FACTS_MAX_AGE_MS,
	type TurnLivenessKernelFacts,
} from "../src/core/turn-liveness.js";
import { MINUTE_MS, StallFakeClock } from "./fixtures/stall-fake-clock.js";

/**
 * A1 (final review): the exemption budget must close even when the degraded fact source is
 * re-read for as long as the turn runs.
 *
 * The shape is a dead kernel that still has a live orphan `bash()` child in the journal, plus an
 * intermittent stream of session events. The heartbeat is stale, so the only vouch comes from the
 * degraded journal read; that read has a lifetime, and every stall stage re-reads. When the
 * lifetime is shorter than the budget the vouch buys, the sequence is: facts expire -> the sample
 * stops vouching -> the watchdog drops the accumulated budget -> the stage handler reads again ->
 * the vouch resumes with a fresh budget. Nothing is ever spent, so nothing is ever killed: a
 * 10-hour simulation of the production thresholds (warn 5min, abort 15min) with touches every
 * 6-21 minutes produced zero aborts.
 *
 * These cases drive that exact loop and assert the invariant the watchdog's own header promises -
 * "a genuine wedge is killed once the budget is spent" - holds for every touch cadence, and that
 * the kill is budget-driven rather than an accident of when the facts happened to expire.
 */
const WARN_AFTER_MS = 5 * MINUTE_MS;
const ABORT_AFTER_MS = 15 * MINUTE_MS;
const SIMULATED_SPAN_MS = 10 * 60 * MINUTE_MS;

function staleKernelFacts(nowMs: number): TurnLivenessKernelFacts {
	const latest: KernelLivenessSample = {
		// One frame, ten minutes old: three of its own 5s intervals, so the heartbeat is stale and
		// the journal is the only fact source left. No previous sample, so no tick delta either.
		receivedAt: Math.max(0, nowMs - 10 * MINUTE_MS),
		tick: 10,
		intervalMs: 5_000,
		cellId: "cell-1",
		cpuMs: 1_000,
		streamBytes: 0,
		cellsDone: 0,
		hostRequests: 0,
		bashHandles: 0,
		bashCellHandles: 0,
		bashBufferedBytes: 0,
		bashPipePending: 0,
	};
	return {
		protocol: 4,
		latest,
		rejectedFrames: 0,
		consecutiveRejectedFrames: 0,
		hostRequestCount: 0,
		kernelPid: 4242,
		hasActiveExecution: true,
	};
}

interface Simulation {
	abortAtMs?: number;
	warnCount: number;
	readCount: number;
	abortInfo?: StallWatchdogStageInfo;
	/** Every stage, for the "no unbounded warn spam after the budget is spent" assertions. */
	stages: StallWatchdogStageInfo[];
}

/**
 * Mirrors the production wiring: the session's vouch closure (settings on, a tool in flight, tier
 * from the aggregate) and its two degraded-refresh points (a tool start, then every stall stage).
 */
function simulate(touchIntervalMs: number | undefined): Simulation {
	const clock = new StallFakeClock();
	const reads: number[] = [];
	const liveness = createTurnLiveness({
		kernel: () => staleKernelFacts(clock.nowMs),
		now: () => clock.nowMs,
		readJournaledBashHandles: () => {
			reads.push(clock.nowMs);
			// The orphan never dies: this is the "still registered active" half of the shape.
			return { liveBashHandles: 1 };
		},
		onEvent: () => {},
	});
	const vouch = (): StallVouchFacts | undefined => {
		const facts = liveness.sample();
		if (!facts.vouched) return undefined;
		return {
			active: true,
			reasons: facts.reasons,
			tier: facts.progress ? "progress" : "liveness",
			kernel: {
				...(facts.protocol === undefined ? {} : { protocol: facts.protocol }),
				hostRequestCount: facts.hostRequestCount,
				reasons: facts.kernelReasons,
			},
		};
	};
	const stages: StallWatchdogStageInfo[] = [];
	let abortAtMs: number | undefined;
	const watchdog = new StallWatchdog({
		enabled: true,
		warnAfterMs: WARN_AFTER_MS,
		abortAfterMs: ABORT_AFTER_MS,
		timers: clock.timersImpl,
		vouch,
		onStage: (info) => {
			stages.push(info);
			if (info.stage === "abort" && abortAtMs === undefined) abortAtMs = clock.nowMs;
			// `_handleStallWatchdogStage`: refresh once per stage when the heartbeat cannot vouch.
			if (liveness.sample().state !== "fresh") liveness.refreshDegradedFacts();
		},
	});

	// `_recordStallWatchdogActivity`: a tool starting both registers the in-flight tool and reads
	// the degraded facts, before the watchdog is armed for the turn.
	liveness.refreshDegradedFacts();
	watchdog.arm();
	watchdog.touch();

	if (touchIntervalMs === undefined) {
		clock.advance(SIMULATED_SPAN_MS);
	} else {
		for (let elapsed = 0; elapsed < SIMULATED_SPAN_MS; elapsed += touchIntervalMs) {
			clock.advance(touchIntervalMs);
			watchdog.touch();
		}
	}

	const abort = stages.find((stage) => stage.stage === "abort");
	return {
		...(abort && abortAtMs !== undefined ? { abortAtMs, abortInfo: abort } : {}),
		warnCount: stages.filter((stage) => stage.stage === "warn").length,
		readCount: reads.length,
		stages,
	};
}

/** Touch cadences the final review measured as immortal (warn < interval < ~25min). */
const IMMORTAL_BAND_INTERVALS = [6, 8, 12, 16, 21].map((minutes) => minutes * MINUTE_MS);
/**
 * Bound for a kill in the band. The degraded vouch is bounded by its own lifetime, which is not
 * allowed to be shorter than the budget it buys, so the accrued exempt time reaches the liveness
 * budget and the escalation proceeds: lifetime + budget + one abort threshold + one touch interval
 * is a generous ceiling over that, and 10 hours is what it replaced.
 */
const CLOSURE_BOUND_MS =
	DEFAULT_DEGRADED_FACTS_MAX_AGE_MS + STALL_VOUCH_LIVENESS_BUDGET_MS + ABORT_AFTER_MS + 21 * MINUTE_MS;

describe("degraded vouch cannot renew the exemption budget forever (A1)", () => {
	it("kills the wedge for every touch cadence in the measured immortal band", () => {
		expect(IMMORTAL_BAND_INTERVALS.length).toBeGreaterThan(0);
		for (const interval of IMMORTAL_BAND_INTERVALS) {
			const run = simulate(interval);
			// The positive control inside the loop: the shape really was driven (the journal was
			// read repeatedly and warnings really fired), so "no abort" means "not killed", not
			// "nothing happened".
			expect(run.readCount, `interval ${interval / MINUTE_MS}min never read the journal`).toBeGreaterThan(1);
			expect(run.warnCount, `interval ${interval / MINUTE_MS}min never warned`).toBeGreaterThan(0);
			expect(run.abortAtMs, `interval ${interval / MINUTE_MS}min ran 10h without an abort`).toBeDefined();
			expect(run.abortAtMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(CLOSURE_BOUND_MS);
		}
	});

	it("kills it with no touch stream at all, and says the budget was spent", () => {
		const run = simulate(undefined);
		expect(run.abortAtMs).toBeDefined();
		// No touches: the ordinary escalation path. Bounded by the degraded lifetime plus the abort
		// threshold, which is the pre-existing behaviour this batch must not loosen.
		expect(run.abortAtMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
			DEFAULT_DEGRADED_FACTS_MAX_AGE_MS + ABORT_AFTER_MS + WARN_AFTER_MS,
		);
	});

	it("does not keep warning forever once the turn is being killed", () => {
		// The secondary half of A1: while the ring renewed itself, a warn fired every touch cadence
		// for as long as the session lived (each one a sessionLog.warn, a UI error and a
		// stall_warning event to the parent). Closure bounds the count too.
		const run = simulate(6 * MINUTE_MS);
		expect(run.abortAtMs).toBeDefined();
		expect(run.warnCount).toBeLessThanOrEqual(Math.ceil(CLOSURE_BOUND_MS / WARN_AFTER_MS) + 1);
	});
});

/**
 * The watchdog-side lock on its own, with no fact aggregate involved: a vouch whose evidence
 * expires every 4 minutes and is renewed by every warn stage. That is A1 stripped to its mechanism
 * - the source is renewable, so the only thing that can still bound it is the watchdog keeping the
 * accrued exempt time across a lapse it observed itself. Without the carry each resumed segment
 * starts a fresh budget and the wedge is immortal; with it the combined budget is spent and the
 * escalation proceeds.
 */
describe("the exemption cap survives a self-renewing vouch (watchdog-side lock)", () => {
	it("spends the combined budget across blinks and kills the wedge", () => {
		const clock = new StallFakeClock();
		const budgetMs = 12 * MINUTE_MS;
		const evidenceLifetimeMs = 4 * MINUTE_MS;
		let evidenceUntilMs = evidenceLifetimeMs;
		const stages: StallWatchdogStageInfo[] = [];
		const events: string[] = [];
		let abortAtMs: number | undefined;
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: WARN_AFTER_MS,
			abortAfterMs: ABORT_AFTER_MS,
			vouchLivenessBudgetMs: budgetMs,
			timers: clock.timersImpl,
			vouch: () =>
				clock.nowMs <= evidenceUntilMs
					? { active: true, tier: "liveness", reasons: ["live_bash_handles"] }
					: undefined,
			onExemptionEvent: (event) => {
				events.push(event.kind);
			},
			onStage: (info) => {
				stages.push(info);
				if (info.stage === "abort" && abortAtMs === undefined) abortAtMs = clock.nowMs;
				// The renewable source: every stall stage re-reads and re-anchors the evidence.
				if (info.stage === "warn") evidenceUntilMs = clock.nowMs + evidenceLifetimeMs;
			},
		});
		watchdog.arm();
		watchdog.touch();

		for (let elapsed = 0; elapsed < SIMULATED_SPAN_MS; elapsed += 6 * MINUTE_MS) {
			clock.advance(6 * MINUTE_MS);
			watchdog.touch();
		}

		const abort = stages.find((stage) => stage.stage === "abort");
		expect(abort, "a self-renewing vouch outlived a 10-hour simulation").toBeDefined();
		// The evidence really did blink and get renewed, so this is the carry doing the work.
		expect(events).toContain("cleared");
		expect(events).toContain("resumed");
		expect(stages.filter((stage) => stage.stage === "warn").length).toBeGreaterThan(1);
		// Bounded by the combined budget plus the escalation it takes to land, not by 10 hours.
		expect(abort?.silentMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(budgetMs + ABORT_AFTER_MS);
		// Measured from the arm, not from the end of the 10-hour simulation: the kill lands once the
		// accrued exempt time reaches the budget, plus the escalation window it takes to fire.
		expect(abortAtMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(budgetMs + ABORT_AFTER_MS + WARN_AFTER_MS);
	});

	it("releases the budget when genuine activity resumes, so a healthy turn does not pay for a blink", () => {
		// The other half of the same rule (T1-1's pin, kept intact by the carry): a lapse observed
		// together with real activity clears the accrued time. A compaction, or any phase that ends
		// with the turn producing events again, must not be charged against the next exemption.
		const clock = new StallFakeClock();
		const budgetMs = 12 * MINUTE_MS;
		let vouched = true;
		const stages: StallWatchdogStageInfo[] = [];
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: WARN_AFTER_MS,
			abortAfterMs: ABORT_AFTER_MS,
			vouchLivenessBudgetMs: budgetMs,
			timers: clock.timersImpl,
			vouch: () => (vouched ? { active: true, tier: "liveness", reasons: ["live_bash_handles"] } : undefined),
			onStage: (info) => stages.push(info),
		});
		watchdog.arm();
		watchdog.touch();

		// Accrue most of a budget, then the evidence disappears *and the turn produces events*.
		clock.advance(10 * MINUTE_MS);
		vouched = false;
		clock.advance(MINUTE_MS);
		watchdog.touch();
		// A later exemption starts from zero, so this turn still gets its full budget.
		vouched = true;
		clock.advance(MINUTE_MS);
		watchdog.touch();
		expect(watchdog.exemption?.usedMs).toBeLessThanOrEqual(2 * MINUTE_MS);
		expect(watchdog.exemption?.carriedExemptMs).toBeUndefined();
		clock.advance(budgetMs - 5 * MINUTE_MS);
		expect(stages.filter((stage) => stage.stage === "abort")).toEqual([]);
	});
});
