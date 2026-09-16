import { describe, expect, it } from "vitest";
import {
	STALL_EXEMPTION_BUDGET_FLOOR_MS,
	STALL_EXEMPTION_BUDGET_WARN_MULTIPLIER,
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
	stageNames: () => string[];
}

function createHarness(options?: {
	warnAfterMs?: number;
	abortAfterMs?: number;
	vouchLivenessBudgetMs?: number;
	isPaused?: () => boolean;
	vouch?: () => StallVouchFacts | undefined;
}): Harness {
	const clock = new StallFakeClock();
	const stages: StallWatchdogStageInfo[] = [];
	const exemptionEvents: StallExemptionEvent[] = [];
	const watchdog = new StallWatchdog({
		enabled: true,
		warnAfterMs: options?.warnAfterMs ?? 1000,
		abortAfterMs: options?.abortAfterMs === undefined ? 3000 : options.abortAfterMs,
		...(options?.vouchLivenessBudgetMs === undefined ? {} : { vouchLivenessBudgetMs: options.vouchLivenessBudgetMs }),
		timers: clock.timersImpl,
		isPaused: options?.isPaused,
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

function progressVouch(active: { value: boolean }, reasons?: string[]): () => StallVouchFacts | undefined {
	return () =>
		active.value ? { active: true, tier: "progress", reasons: reasons ?? ["live_bash_handles"] } : undefined;
}

describe("StallWatchdog exemption budget (T1-1)", () => {
	it("exports the combined budget formula constants", () => {
		expect(STALL_EXEMPTION_BUDGET_FLOOR_MS).toBe(30 * MINUTE_MS);
		expect(STALL_EXEMPTION_BUDGET_WARN_MULTIPLIER).toBe(10);
		// M3 two-tier budget: liveness-only evidence must stay near today's 15min rescue.
		expect(STALL_VOUCH_LIVENESS_BUDGET_MS).toBeLessThanOrEqual(20 * MINUTE_MS);
		expect(STALL_VOUCH_LIVENESS_BUDGET_MS).toBeGreaterThan(0);
	});

	it("clears a spent pause budget when activity resumes unexempted (pre-consumed budget defect)", () => {
		// warnAfterMs 5min => combined cap max(10 * 5min, 30min) = 50min.
		let paused = false;
		const h = createHarness({ warnAfterMs: 5 * MINUTE_MS, abortAfterMs: 0, isPaused: () => paused });
		h.watchdog.arm();

		paused = true;
		h.clock.advance(45 * MINUTE_MS);
		expect(h.stageNames()).toEqual([]);

		// Activity resumes with no exemption in effect: every touch re-evaluates the
		// predicate and, finding it false, drops the accumulated budget. No timer may
		// fire during this stream, which is exactly how HEAD kept the stale segment.
		paused = false;
		for (let i = 0; i < 5; i++) {
			h.clock.advance(MINUTE_MS);
			h.watchdog.touch();
		}
		expect(h.stageNames()).toEqual([]);

		// A second exempted phase must get a fresh budget, not the 5min HEAD left over.
		paused = true;
		h.clock.advance(10 * MINUTE_MS);
		expect(h.stageNames()).toEqual([]);
		// The budget is still a hard cap: 50min into the second phase it stops excusing.
		h.clock.advance(45 * MINUTE_MS);
		expect(h.stageNames()).toEqual(["warn"]);
	});

	it("gives a healthy vouched cell the full budget after a long compaction", () => {
		let paused = false;
		const vouchActive = { value: false };
		const h = createHarness({
			warnAfterMs: 5 * MINUTE_MS,
			abortAfterMs: 15 * MINUTE_MS,
			isPaused: () => paused,
			vouch: progressVouch(vouchActive),
		});
		h.watchdog.arm();

		paused = true;
		h.clock.advance(45 * MINUTE_MS);
		paused = false;
		for (let i = 0; i < 5; i++) {
			h.clock.advance(MINUTE_MS);
			h.watchdog.touch();
		}

		// A long, healthy bash cell: no session events at all, kernel facts vouch for it.
		vouchActive.value = true;
		h.clock.advance(45 * MINUTE_MS);
		expect(h.stageNames()).not.toContain("abort");
		expect(h.stageNames()).toContain("warn");
		h.clock.advance(15 * MINUTE_MS);
		expect(h.stageNames()).toContain("abort");
	});

	it("defers only the abort escalation while vouched: the warning still fires", () => {
		const vouchActive = { value: true };
		const h = createHarness({ warnAfterMs: 1000, abortAfterMs: 3000, vouch: progressVouch(vouchActive) });
		h.watchdog.arm();

		h.clock.advance(1000);
		expect(h.stageNames()).toEqual(["warn"]);
		const warned = h.stages[0];
		expect(warned?.exemption?.reason).toBe("vouched");
		expect(warned?.exemption?.remainingMs).toBeGreaterThan(0);
		expect(warned?.exemption?.reasons).toEqual(["live_bash_handles"]);

		// Ten warn windows of vouched silence: still no abort escalation.
		h.clock.advance(10_000);
		expect(h.stageNames()).toEqual(["warn"]);

		// Once the vouch lifts, the deferred escalation resumes.
		vouchActive.value = false;
		h.clock.advance(3000);
		expect(h.stageNames()).toEqual(["warn", "abort"]);
	});

	it("keeps the paused phase's warn snooze (channel contrast, positive control)", () => {
		const h = createHarness({ warnAfterMs: 1000, abortAfterMs: 3000, isPaused: () => true });
		h.watchdog.arm();
		h.clock.advance(10_000);
		expect(h.stageNames()).toEqual([]);
	});

	it("kills continuously vouched silence once the combined budget is spent", () => {
		const vouchActive = { value: true };
		const h = createHarness({ warnAfterMs: 1000, abortAfterMs: 3000, vouch: progressVouch(vouchActive) });
		h.watchdog.arm();

		h.clock.advance(29 * MINUTE_MS);
		expect(h.stageNames()).not.toContain("abort");
		h.clock.advance(3 * MINUTE_MS);
		expect(h.stageNames()).toContain("abort");
	});

	it("spends the shorter liveness-only budget when there is no progress evidence", () => {
		const h = createHarness({
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			vouch: () => ({ active: true, tier: "liveness", reasons: ["live_bash_handles"] }),
		});
		h.watchdog.arm();

		h.clock.advance(19 * MINUTE_MS);
		expect(h.stageNames()).not.toContain("abort");
		h.clock.advance(3 * MINUTE_MS);
		expect(h.stageNames()).toContain("abort");
	});

	it("extends the budget on a tier upgrade and spends it immediately on a downgrade", () => {
		const tier = { value: "liveness" as "liveness" | "progress" };
		const h = createHarness({
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			vouch: () => ({ active: true, tier: tier.value, reasons: ["live_bash_handles"] }),
		});
		h.watchdog.arm();

		h.clock.advance(10 * MINUTE_MS);
		tier.value = "progress";
		h.clock.advance(15 * MINUTE_MS);
		expect(h.stageNames()).not.toContain("abort");

		// Progress evidence stops (a hung interactive handle): the shorter budget applies
		// to the time already spent, so the escalation is not postponed any further.
		tier.value = "liveness";
		h.clock.advance(2 * MINUTE_MS);
		expect(h.stageNames()).toContain("abort");
	});

	it("never lets a slow-drip wedge refresh the budget through touch()", () => {
		const vouchActive = { value: true };
		const h = createHarness({ warnAfterMs: 1000, abortAfterMs: 3000, vouch: progressVouch(vouchActive) });
		h.watchdog.arm();

		// One event every 1.3s for 31min: an implementation that clears the accumulator
		// on every touch never aborts here.
		h.clock.advanceInSteps(31 * MINUTE_MS, 1300, () => h.watchdog.touch());
		expect(h.stageNames()).toContain("warn");
		expect(h.stageNames()).toContain("abort");
	});

	it("does not refresh the budget when the vouch sub-reason flaps", () => {
		const reasons = { value: ["live_bash_handles"] };
		const h = createHarness({
			warnAfterMs: MINUTE_MS,
			abortAfterMs: 3 * MINUTE_MS,
			vouch: () => ({ active: true, tier: "progress", reasons: reasons.value }),
		});
		h.watchdog.arm();

		h.clock.advanceInSteps(40 * MINUTE_MS, 30_000, () => {
			reasons.value = reasons.value[0] === "live_bash_handles" ? ["host_request_in_flight"] : ["live_bash_handles"];
		});
		expect(h.stageNames()).toContain("abort");
		// 40min of flapping must not have bought more than the 30min cap plus one
		// escalation gap: a per-reason reset would still be running here.
		expect(h.clock.nowMs).toBe(40 * MINUTE_MS);
		expect(h.stages.filter((stage) => stage.stage === "abort")).toHaveLength(1);
	});

	it("debounces a switch to the warn-snoozing reason and never resets the budget on a switch", () => {
		const paused = { value: false };
		const vouchActive = { value: true };
		const h = createHarness({
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			isPaused: () => paused.value,
			vouch: progressVouch(vouchActive),
		});
		h.watchdog.arm();
		h.clock.advance(1000);
		expect(h.watchdog.exemption?.reason).toBe("vouched");

		// A pause shorter than one warn window must not become the exemption reason:
		// "paused" is the only reason that snoozes warnings, so recognizing it late is
		// the safe direction.
		paused.value = true;
		h.clock.advance(500);
		h.watchdog.touch();
		expect(h.watchdog.exemption?.reason).toBe("vouched");

		// One full warn window of continuous pause commits the switch. The touch that armed
		// the pending switch is the last activity, so the committing sample is the timer's
		// own fire - which is what keeps the switch visible as a per-event line.
		h.clock.advance(1000);
		expect(h.watchdog.exemption?.reason).toBe("paused");
		const usedAfterSwitch = h.watchdog.exemption?.usedMs ?? 0;
		// ... without buying any budget: the segment still started at the first warn.
		expect(usedAfterSwitch).toBeGreaterThanOrEqual(1500);

		// Switching away from the snoozing reason commits immediately, on the next fire.
		paused.value = false;
		h.clock.advance(1000);
		expect(h.watchdog.exemption?.reason).toBe("vouched");
		expect(h.watchdog.exemption?.usedMs ?? 0).toBeGreaterThan(usedAfterSwitch);
		const switches = h.exemptionEvents.filter((event) => event.kind === "reason_switch");
		expect(switches.map((event) => event.reason)).toEqual(["paused", "vouched"]);
		expect(switches[0]?.previousReason).toBe("vouched");
	});

	it("does not refresh the budget when paused and vouched alternate in slow phases", () => {
		const paused = { value: false };
		const vouchActive = { value: true };
		const h = createHarness({
			warnAfterMs: MINUTE_MS,
			abortAfterMs: 3 * MINUTE_MS,
			isPaused: () => paused.value,
			vouch: progressVouch(vouchActive),
		});
		h.watchdog.arm();

		// Two-minute phases: long enough for the debounced reason switch to commit, so
		// an implementation that restarts the budget per reason would never abort here.
		let step = 0;
		let abortAt: number | undefined;
		h.clock.advanceInSteps(40 * MINUTE_MS, 30_000, () => {
			step += 1;
			if (step % 4 === 0) paused.value = !paused.value;
			if (abortAt === undefined && h.stageNames().includes("abort")) abortAt = h.clock.nowMs;
		});
		expect(h.stages.filter((stage) => stage.stage === "abort")).toHaveLength(1);
		expect(abortAt).toBeDefined();
		// 30min cap plus at most one escalation gap after the segment started.
		expect(abortAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(34 * MINUTE_MS);
	});

	it("does not refresh the budget when paused and vouched alternate", () => {
		const paused = { value: false };
		const vouchActive = { value: true };
		const h = createHarness({
			warnAfterMs: MINUTE_MS,
			abortAfterMs: 3 * MINUTE_MS,
			isPaused: () => paused.value,
			vouch: progressVouch(vouchActive),
		});
		h.watchdog.arm();

		h.clock.advanceInSteps(40 * MINUTE_MS, 30_000, () => {
			paused.value = !paused.value;
		});
		expect(h.stageNames()).toContain("abort");
		expect(h.stages.filter((stage) => stage.stage === "abort")).toHaveLength(1);
	});

	it("reports exemption forensics: started, one abort_deferred per arm cycle, cleared", () => {
		const vouchActive = { value: true };
		const h = createHarness({ warnAfterMs: 1000, abortAfterMs: 3000, vouch: progressVouch(vouchActive) });
		h.watchdog.arm();

		// Ten deferred re-checks must produce exactly one abort_deferred line.
		h.clock.advance(10_000);
		const kinds = () => h.exemptionEvents.map((event) => event.kind);
		expect(kinds()).toContain("started");
		expect(h.exemptionEvents.filter((event) => event.kind === "abort_deferred")).toHaveLength(1);

		vouchActive.value = false;
		h.clock.advance(3000);
		expect(kinds()).toContain("cleared");
		expect(h.stageNames()).toContain("abort");
	});

	it("logs the spent budget exactly once and drops the segment when it gives up", () => {
		const vouchActive = { value: true };
		const h = createHarness({ warnAfterMs: 1000, abortAfterMs: 3000, vouch: progressVouch(vouchActive) });
		h.watchdog.arm();

		h.clock.advance(31 * MINUTE_MS);
		const exhausted = h.exemptionEvents.filter((event) => event.kind === "exhausted");
		expect(exhausted).toHaveLength(1);
		expect(exhausted[0]?.usedMs).toBeGreaterThanOrEqual(exhausted[0]?.budgetMs ?? Number.NaN);
		expect(h.stageNames()).toContain("abort");

		// The unsettled stage carries the final exemption state, then the watchdog
		// gives up and no longer claims an exemption.
		h.clock.advance(30_000);
		expect(h.stageNames()).toContain("abort_unsettled");
		const unsettled = h.stages.find((stage) => stage.stage === "abort_unsettled");
		expect(unsettled?.exemption?.exhausted).toBe(true);
		expect(h.watchdog.exemption).toBeUndefined();
	});

	it("starts a fresh exemption budget on re-arm", () => {
		const vouchActive = { value: true };
		const h = createHarness({ warnAfterMs: 1000, abortAfterMs: 3000, vouch: progressVouch(vouchActive) });
		h.watchdog.arm();
		h.clock.advance(29 * MINUTE_MS);
		expect(h.stageNames()).not.toContain("abort");

		// A new turn re-arms the watchdog: the budget belongs to the arm cycle.
		h.watchdog.arm();
		h.clock.advance(20 * MINUTE_MS);
		expect(h.stageNames()).not.toContain("abort");
		h.clock.advance(15 * MINUTE_MS);
		expect(h.stageNames()).toContain("abort");
	});

	it("does not turn a spent budget plus activity into warning spam in warn-only mode", () => {
		const h = createHarness({
			warnAfterMs: 1000,
			abortAfterMs: 0,
			vouch: () => ({ active: true, tier: "progress", reasons: ["live_bash_handles"] }),
		});
		h.watchdog.arm();
		h.clock.advance(31 * MINUTE_MS);
		expect(h.stageNames()).toEqual(["warn"]);

		// Activity resumes while the exemption is still claimed and spent: there is no
		// abort to escalate to, so touches go back to rebasing and warnings stay at one
		// per warn window instead of one per event.
		h.clock.advanceInSteps(10_000, 100, () => h.watchdog.touch());
		expect(h.stageNames().filter((stage) => stage === "warn")).toHaveLength(1);
	});

	it("caps the combined budget at max(10 x warnAfterMs, 30min)", () => {
		const vouchActive = { value: true };
		// warnAfterMs 6min => 10 x 6min = 60min beats the 30min floor.
		const h = createHarness({
			warnAfterMs: 6 * MINUTE_MS,
			abortAfterMs: 12 * MINUTE_MS,
			vouch: progressVouch(vouchActive),
		});
		h.watchdog.arm();
		h.clock.advance(55 * MINUTE_MS);
		expect(h.stageNames()).not.toContain("abort");
		h.clock.advance(13 * MINUTE_MS);
		expect(h.stageNames()).toContain("abort");
	});

	it("exposes the exemption snapshot for diagnostics without re-evaluating", () => {
		const vouchActive = { value: true };
		const h = createHarness({
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			vouch: () =>
				vouchActive.value
					? {
							active: true,
							tier: "progress",
							reasons: ["live_bash_handles"],
							kernel: { protocol: 4, livenessAgeMs: 1200, liveBashHandles: 1, hostRequestCount: 0 },
						}
					: undefined,
		});
		expect(h.watchdog.exemption).toBeUndefined();
		expect(h.watchdog.collectExemptionDiagnostics().reason).toBeUndefined();

		h.watchdog.arm();
		h.clock.advance(1000);
		// Advance inside the exemption segment so the used budget is non-zero.
		h.clock.advance(500);
		const diagnostics = h.watchdog.collectExemptionDiagnostics();
		expect(diagnostics.reason).toBe("vouched");
		expect(diagnostics.reasons).toEqual(["live_bash_handles"]);
		expect(diagnostics.budgetUsedMs).toBeGreaterThan(0);
		expect(diagnostics.budgetRemainingMs).toBeGreaterThan(0);
		expect(diagnostics.kernel).toEqual({
			protocol: 4,
			livenessAgeMs: 1200,
			liveBashHandles: 1,
			hostRequestCount: 0,
			reasons: [],
		});

		vouchActive.value = false;
		h.clock.advance(3000);
		expect(h.watchdog.exemption).toBeUndefined();
		expect(h.watchdog.collectExemptionDiagnostics().reason).toBeUndefined();
	});
});

/**
 * The budget's dimension (P1): it charges *unexplained silence*, not wall clock under vouch. A fact
 * source whose movement token changes between two samples settles what the segment had accrued, so
 * a build that keeps producing for hours never reaches the cap - while every shape that made the
 * cap necessary (a frozen counter, existence-only evidence, a drip of session events, a blink) still
 * spends it and dies.
 */
describe("StallWatchdog exemption budget charges exempt silence (P1)", () => {
	function movingVouch(token: { value: string }): () => StallVouchFacts | undefined {
		return () => ({
			active: true,
			tier: "progress",
			reasons: ["live_bash_handles"],
			movementToken: token.value,
		});
	}

	it("settles the accrued silence whenever the movement token advances, for as long as it does", () => {
		const token = { value: "frame-0" };
		// warn 1min => combined cap max(10 x 1min, 30min) = 30min.
		const h = createHarness({ warnAfterMs: MINUTE_MS, abortAfterMs: 3 * MINUTE_MS, vouch: movingVouch(token) });
		h.watchdog.arm();

		// Two hours of a build whose counters move between every pair of samples, with no host event
		// at all: six times the cap in wall clock, and not one minute of it is unexplained silence.
		let frames = 0;
		h.clock.advanceInSteps(120 * MINUTE_MS, 30_000, () => {
			frames += 1;
			token.value = `frame-${frames}`;
		});
		expect(frames).toBeGreaterThan(0);

		expect(h.stageNames()).not.toContain("abort");
		expect(h.watchdog.exemptionBudgetSpent).toBe(false);
		// B2 is untouched: an exemption defers the abort, it never swallows the warning.
		expect(h.stageNames()).toEqual(["warn"]);
		const exemption = h.watchdog.exemption;
		expect(exemption?.tier).toBe("progress");
		expect(exemption?.usedMs ?? Number.NaN).toBeLessThan(exemption?.budgetMs ?? 0);
		// The post-mortem can tell a settled segment from one that was silent the whole way.
		expect(exemption?.settledByMovementMs).toBeGreaterThan(0);
		expect(h.watchdog.collectExemptionDiagnostics().settledByMovementMs).toBeGreaterThan(0);
	});

	it("charges the silence that follows the last movement, and kills inside the cap", () => {
		const token = { value: "frame-0" };
		const h = createHarness({ warnAfterMs: MINUTE_MS, abortAfterMs: 3 * MINUTE_MS, vouch: movingVouch(token) });
		h.watchdog.arm();

		// An hour of production: nothing owed, nothing spent.
		let frames = 0;
		h.clock.advanceInSteps(60 * MINUTE_MS, 30_000, () => {
			frames += 1;
			token.value = `frame-${frames}`;
		});
		expect(h.stageNames()).not.toContain("abort");
		expect(h.watchdog.exemptionBudgetSpent).toBe(false);

		// Then it wedges: the frames keep arriving and the handle stays live, but the counters stop.
		// The cap applies from the last movement, so the kill lands inside one cap of the freeze.
		const frozeAtMs = h.clock.nowMs;
		let abortAtMs: number | undefined;
		let spentAtAbort = false;
		h.clock.advanceInSteps(60 * MINUTE_MS, 30_000, () => {
			if (abortAtMs === undefined && h.stageNames().includes("abort")) {
				abortAtMs = h.clock.nowMs;
				// Read at the kill: the give-up path that follows resets the arm cycle.
				spentAtAbort = h.watchdog.exemptionBudgetSpent;
			}
		});
		expect(abortAtMs).toBeDefined();
		expect(spentAtAbort).toBe(true);
		expect(abortAtMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
			frozeAtMs + STALL_EXEMPTION_BUDGET_FLOOR_MS + 3 * MINUTE_MS,
		);
		expect(h.stages.find((stage) => stage.stage === "abort")?.exemption).toMatchObject({
			reason: "vouched",
			exhausted: true,
		});
		// The movement it did make is still on the record, so the post-mortem reads "it worked for an
		// hour and then stopped" instead of "it was silent for an hour".
		expect(h.stages.find((stage) => stage.stage === "abort")?.exemption?.settledByMovementMs).toBeGreaterThan(0);
	});

	it("does not settle on a token that never changes, however often it is reported", () => {
		// A frozen counter claims `progress` at every sample. Reporting movement is not moving, so
		// this is the slow-drip wedge with a token attached and it must still die inside the cap.
		const h = createHarness({
			warnAfterMs: 1000,
			abortAfterMs: 3000,
			vouch: () => ({
				active: true,
				tier: "progress",
				reasons: ["live_bash_handles"],
				movementToken: "frame-1",
			}),
		});
		h.watchdog.arm();

		h.clock.advanceInSteps(31 * MINUTE_MS, 1300, () => h.watchdog.touch());
		expect(h.stageNames()).toContain("warn");
		expect(h.stageNames()).toContain("abort");
		expect(h.watchdog.exemption?.settledByMovementMs).toBeUndefined();
	});

	it("never lets movement that arrives after the cap was spent un-spend it", () => {
		const token = { value: "frame-1" };
		// Warn-only, so the spent cap can be observed together with the touches that follow it: with
		// an abort channel the escalation lands on the same sample that sees the exhaustion.
		const h = createHarness({ warnAfterMs: 1000, abortAfterMs: 0, vouch: movingVouch(token) });
		h.watchdog.arm();

		h.clock.advance(31 * MINUTE_MS);
		// A warn-only watchdog stops sampling once it has warned, so the cap is observed spent by the
		// next touch - which is also the shape the registered warn-spam pin uses.
		h.watchdog.touch();
		expect(h.watchdog.exemptionBudgetSpent).toBe(true);
		expect(h.watchdog.exemption?.exhausted).toBe(true);

		// The job "starts producing" after the fact. A spent cap that a later sample could erase is
		// not a cap (A1), so the movement settles nothing and the kill stays attributable.
		let frames = 1;
		h.clock.advanceInSteps(10_000, 500, () => {
			frames += 1;
			token.value = `frame-${frames}`;
			h.watchdog.touch();
		});
		expect(h.watchdog.exemptionBudgetSpent).toBe(true);
		expect(h.watchdog.exemption?.exhausted).toBe(true);
		expect(h.watchdog.exemption?.settledByMovementMs).toBeUndefined();
	});

	it("does not let movement arriving with the exhaustion observation pay for silence already owed", () => {
		const token = { value: "frame-1" };
		// Warn-only, so nothing samples between the warning and the touch below: that touch is the
		// first observation to find the cap spent.
		const h = createHarness({ warnAfterMs: MINUTE_MS, abortAfterMs: 0, vouch: movingVouch(token) });
		h.watchdog.arm();

		h.clock.advance(31 * MINUTE_MS);
		expect(h.watchdog.exemptionBudgetSpent).toBe(false);

		// The counters moved at the very same instant the cap was crossed: too late. The sample that
		// first sees the cap spent decides, so the exhaustion cannot be raced away by movement that
		// arrives together with the observation of it.
		token.value = "frame-2";
		h.watchdog.touch();
		expect(h.watchdog.exemptionBudgetSpent).toBe(true);
		expect(h.watchdog.exemption?.exhausted).toBe(true);
		expect(h.watchdog.exemption?.settledByMovementMs).toBeUndefined();
	});

	it("tracks movement seen during a host-owned pause without letting it settle the accrued time", () => {
		const token = { value: "frame-1" };
		const paused = { value: false };
		const h = createHarness({
			warnAfterMs: MINUTE_MS,
			abortAfterMs: 3 * MINUTE_MS,
			isPaused: () => paused.value,
			vouch: movingVouch(token),
		});
		h.watchdog.arm();

		// Past the first warn window, so the segment exists and has accrued half a minute of it.
		h.clock.advance(MINUTE_MS + 30_000);
		const accruedBefore = h.watchdog.exemption?.usedMs ?? 0;
		expect(accruedBefore).toBe(30_000);

		// The host takes the turn boundary over (a compaction) while the kernel keeps producing. The
		// pause snoozes warnings, and its movement is tracked but settles nothing: it is not the
		// evidence that owns this silence.
		paused.value = true;
		let frames = 1;
		h.clock.advanceInSteps(2 * MINUTE_MS, 30_000, () => {
			frames += 1;
			token.value = `frame-${frames}`;
		});
		// The kernel stops producing while the host phase is still on, so a sample taken *during the
		// pause* records the newest token: what the pause saw is what the pause tracked.
		h.clock.advance(MINUTE_MS);

		// The pause lifts. The movement it saw must not read as fresh movement now: that would let a
		// paused phase hand the vouch a settled budget it never earned.
		paused.value = false;
		h.watchdog.touch();
		expect(h.watchdog.exemption?.reason).toBe("vouched");
		expect(h.watchdog.exemption?.settledByMovementMs).toBeUndefined();
		expect(h.watchdog.exemption?.usedMs ?? 0).toBeGreaterThan(accruedBefore);
	});

	it("keeps a spent cap spent when the tier upgrades and movement resumes afterwards", () => {
		const token = { value: "frame-1" };
		const tier = { value: "liveness" as "liveness" | "progress" };
		// A 12min liveness budget inside a 30min cap: spend the short one, then let the evidence
		// upgrade to the tier with the longer budget and start moving. The spent cap is a fact about
		// the arm cycle, so neither the upgrade nor the movement may un-spend it (A1).
		const h = createHarness({
			warnAfterMs: MINUTE_MS,
			abortAfterMs: 0,
			vouchLivenessBudgetMs: 12 * MINUTE_MS,
			vouch: () => ({
				active: true,
				tier: tier.value,
				reasons: ["live_bash_handles"],
				movementToken: token.value,
			}),
		});
		h.watchdog.arm();

		h.clock.advance(13 * MINUTE_MS);
		h.watchdog.touch();
		expect(h.watchdog.exemptionBudgetSpent).toBe(true);
		expect(h.watchdog.exemption?.exhausted).toBe(true);

		// The upgrade puts usedMs back under the (now larger) budget, so only the spent latch stands
		// between this movement and a renewed cap.
		tier.value = "progress";
		token.value = "frame-2";
		h.watchdog.touch();
		expect(h.watchdog.exemption?.budgetMs).toBe(STALL_EXEMPTION_BUDGET_FLOOR_MS);
		// The snapshot measures against the upgraded budget, so it no longer reads exhausted: this is
		// exactly why the arm-cycle latch, and not the snapshot, carries "the cap was spent".
		expect(h.watchdog.exemption?.exhausted).toBe(false);
		expect(h.watchdog.exemptionBudgetSpent).toBe(true);
		// And the movement that arrived with the upgrade settles nothing: the accrued 12 minutes stay
		// on the clock instead of being paid for by a token that changed after the cap was seen spent.
		expect(h.watchdog.exemption?.settledByMovementMs).toBeUndefined();
		expect(h.watchdog.exemption?.usedMs ?? 0).toBeGreaterThanOrEqual(12 * MINUTE_MS);
	});

	it("treats a first token that arrives after the segment was born as a baseline too", () => {
		// Born on existence-only evidence (a journaled handle, say), then a usable heartbeat arrives
		// carrying a token. With no predecessor to compare against it cannot claim anything moved, so
		// the silence accrued while existence was the only evidence stays charged.
		let token: string | undefined;
		const h = createHarness({
			warnAfterMs: MINUTE_MS,
			abortAfterMs: 3 * MINUTE_MS,
			vouch: () => ({
				active: true,
				tier: token === undefined ? "liveness" : "progress",
				reasons: ["live_bash_handles"],
				...(token === undefined ? {} : { movementToken: token }),
			}),
		});
		h.watchdog.arm();

		h.clock.advance(MINUTE_MS + 30_000);
		const accruedBefore = h.watchdog.exemption?.usedMs ?? 0;
		expect(accruedBefore).toBe(30_000);

		token = "frame-1";
		h.watchdog.touch();
		expect(h.watchdog.exemption?.tier).toBe("progress");
		expect(h.watchdog.exemption?.settledByMovementMs).toBeUndefined();
		expect(h.watchdog.exemption?.usedMs ?? 0).toBeGreaterThanOrEqual(accruedBefore);
	});

	it("keeps the first token a segment sees as a baseline, not as movement", () => {
		const token = { value: "frame-9" };
		const h = createHarness({ warnAfterMs: 1000, abortAfterMs: 3000, vouch: movingVouch(token) });
		h.watchdog.arm();

		// Nothing changes after the birth sample, so nothing may be settled: the birth token has no
		// predecessor to be compared against and proves only that a frame exists.
		h.clock.advance(31 * MINUTE_MS);
		expect(h.stageNames()).toContain("abort");
		expect(h.watchdog.exemption?.settledByMovementMs).toBeUndefined();
	});
});
