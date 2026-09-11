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
		h.clock.advance(600);
		h.watchdog.touch();
		expect(h.watchdog.exemption?.reason).toBe("vouched");

		// One full warn window of continuous pause commits the switch ...
		h.clock.advance(500);
		h.watchdog.touch();
		expect(h.watchdog.exemption?.reason).toBe("paused");
		const usedAfterSwitch = h.watchdog.exemption?.usedMs ?? 0;
		// ... without buying any budget: the segment still started at the first warn.
		expect(usedAfterSwitch).toBeGreaterThanOrEqual(1600);

		// Switching away from the snoozing reason commits immediately.
		paused.value = false;
		h.clock.advance(100);
		h.watchdog.touch();
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
