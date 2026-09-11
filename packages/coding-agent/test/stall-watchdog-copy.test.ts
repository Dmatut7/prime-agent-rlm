import { describe, expect, it } from "vitest";
import { DEFAULT_STALL_ABORT_AFTER_SECONDS, DEFAULT_STALL_WARN_AFTER_SECONDS } from "../src/core/settings-manager.js";
import {
	buildStallAbortMessage,
	buildStallAbortUnsettledMessage,
	buildStallStageMessage,
	buildStallWarnMessage,
	DEFAULT_STALL_WATCHDOG_CONFIG,
	formatStallKernelFacts,
	humanizeStallReasons,
	normalizeStallKernelFacts,
	resolveStallWatchdogConfig,
	STALL_KERNEL_REASONS,
	STALL_VOUCH_REASONS,
	type StallExemptionSnapshot,
	type StallKernelDiagnostics,
	StallWatchdog,
	type StallWatchdogStageInfo,
} from "../src/core/stall-watchdog.js";
import { MINUTE_MS, StallFakeClock } from "./fixtures/stall-fake-clock.js";

function exemptionSnapshot(overrides?: Partial<StallExemptionSnapshot>): StallExemptionSnapshot {
	return {
		reason: "vouched",
		reasons: [STALL_VOUCH_REASONS.liveBashHandles],
		since: 0,
		usedMs: 60_000,
		budgetMs: 30 * MINUTE_MS,
		remainingMs: 29 * MINUTE_MS,
		exhausted: false,
		tier: "progress",
		...overrides,
	};
}

const kernelFacts: StallKernelDiagnostics = {
	protocol: 4,
	livenessAgeMs: 1200,
	liveBashHandles: 1,
	hostRequestCount: 0,
	kernelPid: 4242,
	reasons: [STALL_KERNEL_REASONS.loopStalled],
};

describe("stall watchdog settings config (T1-4)", () => {
	it("defaults match the settings-manager thresholds and gate the new keys", () => {
		expect(DEFAULT_STALL_WATCHDOG_CONFIG.warnAfterSeconds).toBe(DEFAULT_STALL_WARN_AFTER_SECONDS);
		expect(DEFAULT_STALL_WATCHDOG_CONFIG.abortAfterSeconds).toBe(DEFAULT_STALL_ABORT_AFTER_SECONDS);
		expect(resolveStallWatchdogConfig(undefined)).toEqual({
			enabled: true,
			warnAfterSeconds: 300,
			abortAfterSeconds: 900,
			toolLivenessExemption: true,
			// Reserved: registered so it round-trips, never read by the watchdog.
			treatKernelCpuProgressAsActivity: false,
		});
	});

	it("keeps the escalation gap and the warn-only escape hatch", () => {
		expect(resolveStallWatchdogConfig({ warnAfterSeconds: 600, abortAfterSeconds: 300 }).abortAfterSeconds).toBe(
			1200,
		);
		expect(resolveStallWatchdogConfig({ warnAfterSeconds: 600, abortAfterSeconds: 600 }).abortAfterSeconds).toBe(
			1200,
		);
		expect(resolveStallWatchdogConfig({ abortAfterSeconds: 0 }).abortAfterSeconds).toBe(0);
		expect(resolveStallWatchdogConfig({ enabled: false, toolLivenessExemption: false })).toEqual({
			enabled: false,
			warnAfterSeconds: 300,
			abortAfterSeconds: 900,
			toolLivenessExemption: false,
			treatKernelCpuProgressAsActivity: false,
		});
	});
});

describe("stall watchdog copy (T1-4)", () => {
	it("leaves the unexempted warn copy byte-identical to the production string", () => {
		const silentSeconds = 300;
		const expected = `Possible stall: no session activity for ${silentSeconds}s while a turn is running. If nothing recovers, the turn will be aborted automatically after ${DEFAULT_STALL_ABORT_AFTER_SECONDS}s of silence. If a tool appears stuck, interrupt the turn manually to recover faster; check the daemon log for stall diagnostics.`;
		expect(buildStallWarnMessage({ silentMs: 300_000, abortAfterSeconds: DEFAULT_STALL_ABORT_AFTER_SECONDS })).toBe(
			expected,
		);
	});

	it("rewrites the vouched warn copy: deferred, budget left, no unkeepable abort promise", () => {
		const message = buildStallWarnMessage({
			silentMs: 300_000,
			abortAfterSeconds: 900,
			exemption: exemptionSnapshot({ remainingMs: 29 * MINUTE_MS }),
		});
		expect(message).toContain("no session activity for 300s");
		expect(message).toContain("In-flight kernel work detected (live bash handles)");
		expect(message).toContain("automatic abort is deferred");
		expect(message).toContain("29min of exemption budget is left");
		expect(message).toContain("interrupt the turn manually");
		// B2: never promise a deadline the exemption will not keep.
		expect(message).not.toContain("will be aborted");
		expect(message.toLowerCase()).not.toContain("aborted automatically");
	});

	it("falls back to the standard copy once the budget is spent or the phase is paused", () => {
		const exhausted = buildStallWarnMessage({
			silentMs: 3_000_000,
			abortAfterSeconds: 900,
			exemption: exemptionSnapshot({ exhausted: true, remainingMs: 0 }),
		});
		expect(exhausted).toContain("will be aborted automatically after 900s");
		expect(exhausted).not.toContain("deferred");

		const paused = buildStallWarnMessage({
			silentMs: 300_000,
			abortAfterSeconds: 900,
			exemption: exemptionSnapshot({ reason: "paused", reasons: [] }),
		});
		expect(paused).toContain("will be aborted automatically after 900s");
		expect(paused).not.toContain("deferred");
	});

	it("leaves the abort copy byte-identical", () => {
		expect(buildStallAbortMessage({ silentMs: 900_000 })).toBe(
			"Suspected stall: no session activity for 900s. The current turn is being aborted automatically; diagnostics were logged.",
		);
	});

	it("appends kernel facts to the abort_unsettled copy and keeps it unchanged without them", () => {
		const base =
			"Suspected stall: auto-abort fired 900s into silence but the run did not settle; the session may need a restart. Diagnostics were logged.";
		expect(buildStallAbortUnsettledMessage({ silentMs: 900_000 })).toBe(base);
		expect(buildStallAbortUnsettledMessage({ silentMs: 900_000, kernel: kernelFacts })).toBe(
			`${base} Kernel facts: protocol=4 livenessAgeMs=1200 liveBashHandles=1 hostRequestCount=0 kernelPid=4242 reasons=loop_stalled.`,
		);
		// The exemption snapshot is the fallback source when no explicit segment is passed.
		expect(
			buildStallAbortUnsettledMessage({ silentMs: 900_000, exemption: exemptionSnapshot({ kernel: kernelFacts }) }),
		).toContain("reasons=loop_stalled");
	});

	it("rounds silence up to at least one second and dispatches per stage", () => {
		expect(buildStallWarnMessage({ silentMs: 200, abortAfterSeconds: 900 })).toContain("for 1s");
		expect(buildStallStageMessage("warn", { silentMs: 200, abortAfterSeconds: 900 })).toBe(
			buildStallWarnMessage({ silentMs: 200, abortAfterSeconds: 900 }),
		);
		expect(buildStallStageMessage("abort", { silentMs: 200 })).toBe(buildStallAbortMessage({ silentMs: 200 }));
		expect(buildStallStageMessage("abort_unsettled", { silentMs: 200 })).toBe(
			buildStallAbortUnsettledMessage({ silentMs: 200 }),
		);
	});

	it("humanizes known reasons and degrades unknown ones readably", () => {
		expect(humanizeStallReasons([STALL_VOUCH_REASONS.liveBashHandles])).toBe("live bash handles");
		expect(
			humanizeStallReasons([STALL_VOUCH_REASONS.hostRequestInFlight, STALL_VOUCH_REASONS.kernelLoopAwaitingCell]),
		).toBe("an in-flight host request, a live kernel loop awaiting this cell");
		expect(humanizeStallReasons(["some_new_reason"])).toBe("some new reason");
		expect(humanizeStallReasons([])).toBe("in-flight work");
	});

	it("normalizes kernel facts for the diagnostics segment", () => {
		expect(normalizeStallKernelFacts({})).toEqual({ reasons: [] });
		expect(normalizeStallKernelFacts({ protocol: 4, reasons: ["loop_stalled"] })).toEqual({
			protocol: 4,
			reasons: ["loop_stalled"],
		});
		expect(normalizeStallKernelFacts(kernelFacts)).toEqual(kernelFacts);
		expect(formatStallKernelFacts(undefined)).toBeUndefined();
		expect(formatStallKernelFacts({ reasons: [] })).toBeUndefined();
		expect(formatStallKernelFacts({ liveBashHandles: 2, reasons: [] })).toBe("liveBashHandles=2");
		expect(normalizeStallKernelFacts({ kernelPid: 4242 })).toEqual({ kernelPid: 4242, reasons: [] });
		expect(formatStallKernelFacts({ kernelPid: 4242, reasons: [] })).toBe("kernelPid=4242");
	});

	it("drives the copy from a live watchdog's vouched warn stage", () => {
		// Module-level stand-in for the session-level long-cell case: the exemption
		// snapshot the watchdog hands to onStage is what the copy builder consumes.
		const clock = new StallFakeClock();
		const stages: StallWatchdogStageInfo[] = [];
		const watchdog = new StallWatchdog({
			enabled: true,
			warnAfterMs: 5 * MINUTE_MS,
			abortAfterMs: 15 * MINUTE_MS,
			timers: clock.timersImpl,
			vouch: () => ({
				active: true,
				tier: "progress",
				reasons: [STALL_VOUCH_REASONS.liveBashHandles],
				kernel: { protocol: 4, liveBashHandles: 1, livenessAgeMs: 900, reasons: [] },
			}),
			onStage: (info) => stages.push(info),
		});
		watchdog.arm();
		clock.advance(5 * MINUTE_MS);
		expect(stages).toHaveLength(1);

		const message = buildStallStageMessage(stages[0]!.stage, {
			silentMs: stages[0]!.silentMs,
			abortAfterSeconds: 900,
			exemption: stages[0]!.exemption,
		});
		expect(message).toContain("automatic abort is deferred");
		expect(message).not.toContain("will be aborted");
		expect(watchdog.collectExemptionDiagnostics().kernel?.liveBashHandles).toBe(1);

		// The deferred escalation eventually kills a genuinely wedged cell.
		clock.advance(60 * MINUTE_MS);
		expect(stages.some((stage) => stage.stage === "abort")).toBe(true);
	});
});
