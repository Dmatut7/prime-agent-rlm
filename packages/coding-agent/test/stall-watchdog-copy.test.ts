import { describe, expect, it } from "vitest";
import { DEFAULT_STALL_ABORT_AFTER_SECONDS, DEFAULT_STALL_WARN_AFTER_SECONDS } from "../src/core/settings-manager.js";
import type { StallDiagnosticsPointer } from "../src/core/stall-evidence.js";
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

/** Fixed pointer so the copy contract is a literal string, not this machine's home dir. */
const testPointer: StallDiagnosticsPointer = {
	evidencePath: "/agent/logs/stall-evidence.jsonl",
	agentLogPath: "/agent/logs/agent.jsonl",
	daemonWorker: false,
};

const WHERE =
	'/agent/logs/stall-evidence.jsonl (stall-only, size-bounded) and /agent/logs/agent.jsonl (all sessions; filter with: grep "stall watchdog" /agent/logs/agent.jsonl)';
const NO_DAEMON = "This session runs without a daemon, so there is no daemon log.";

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
		const expected = `Possible stall: no session activity for ${silentSeconds}s while a turn is running. If nothing recovers, the turn will be aborted automatically after ${DEFAULT_STALL_ABORT_AFTER_SECONDS}s of silence. If a tool appears stuck, interrupt the turn manually to recover faster. This session runs without a daemon, so there is no daemon log to check. Stall diagnostics: ${WHERE}.`;
		expect(
			buildStallWarnMessage({
				silentMs: 300_000,
				abortAfterSeconds: DEFAULT_STALL_ABORT_AFTER_SECONDS,
				diagnosticsPointer: testPointer,
			}),
		).toBe(expected);
	});

	// H-1: abortAfterSeconds 0 is the documented "warn-only" value; abortAfterMs() then hands the
	// session no abort channel, so the warn copy must not promise an automatic abort at all -
	// least of all one "after 0s", which is what the `${value ?? 0}` interpolation produced.
	it("does not promise an automatic abort for a warn-only watchdog (abortAfterSeconds 0)", () => {
		const warnOnly = buildStallWarnMessage({ silentMs: 600_000, abortAfterSeconds: 0 });
		expect(warnOnly).toContain("no session activity for 600s");
		expect(warnOnly).not.toContain("aborted automatically");
		expect(warnOnly).not.toMatch(/will be aborted/);
		expect(warnOnly).not.toContain("after 0s");
		// The honest alternative: say no abort is coming and how to recover instead.
		expect(warnOnly).toContain("No automatic abort is configured for this session");
		expect(warnOnly).toContain("interrupt the turn manually");

		// No configured deadline is not a deadline of zero either.
		const unset = buildStallWarnMessage({ silentMs: 600_000 });
		expect(unset).not.toContain("aborted automatically");
		expect(unset).toContain("No automatic abort is configured for this session");
	});

	it("keeps naming the real deadline while an abort is configured (positive control)", () => {
		const message = buildStallWarnMessage({ silentMs: 600_000, abortAfterSeconds: 900 });
		expect(message).toContain("will be aborted automatically after 900s of silence");
		// A warn-only session with a vouch still gets the plain warn-only text: deferring an
		// abort that does not exist would be the same lie in the other branch.
		const vouched = buildStallWarnMessage({
			silentMs: 600_000,
			abortAfterSeconds: 0,
			exemption: exemptionSnapshot(),
		});
		expect(vouched).not.toContain("aborted automatically");
		expect(vouched).not.toContain("deferred");
		expect(vouched).toContain("No automatic abort is configured for this session");
	});

	it("never escalates a warn-only watchdog past the warning", async () => {
		// Pins the whole 0 semantics chain the copy rests on: what the settings resolve to, what
		// the session derives from it, and what the watchdog then actually does.
		expect(resolveStallWatchdogConfig({ warnAfterSeconds: 600, abortAfterSeconds: 0 }).abortAfterSeconds).toBe(0);
		const clock = new StallFakeClock();
		const stages: StallWatchdogStageInfo[] = [];
		new StallWatchdog({
			enabled: true,
			warnAfterMs: 600_000,
			// What AgentSession._createStallWatchdog derives from abortAfterSeconds === 0.
			abortAfterMs: undefined,
			timers: clock.timersImpl,
			onStage: (info) => stages.push(info),
		}).arm();
		clock.advance(10 * MINUTE_MS);
		clock.advance(60 * MINUTE_MS);
		expect(stages.map((stage) => stage.stage)).toEqual(["warn"]);
		expect(buildStallStageMessage("warn", { silentMs: 600_000, abortAfterSeconds: 0 })).toContain(
			"No automatic abort is configured",
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

	it("pins the abort copy: it names the real diagnostics files instead of vouching for a write", () => {
		expect(buildStallAbortMessage({ silentMs: 900_000, diagnosticsPointer: testPointer })).toBe(
			`Suspected stall: no session activity for 900s. The current turn is being aborted automatically. Diagnostics are written best-effort to ${WHERE}. ${NO_DAEMON}`,
		);
	});

	it("appends kernel facts to the abort_unsettled copy and keeps it unchanged without them", () => {
		const base = `Suspected stall: auto-abort fired 900s into silence but the run did not settle; the session may need a restart. Diagnostics are written best-effort to ${WHERE}. ${NO_DAEMON}`;
		expect(buildStallAbortUnsettledMessage({ silentMs: 900_000, diagnosticsPointer: testPointer })).toBe(base);
		expect(
			buildStallAbortUnsettledMessage({ silentMs: 900_000, kernel: kernelFacts, diagnosticsPointer: testPointer }),
		).toBe(
			`${base} Kernel facts: protocol=4 livenessAgeMs=1200 liveBashHandles=1 hostRequestCount=0 kernelPid=4242 reasons=loop_stalled.`,
		);
		// The exemption snapshot is the fallback source when no explicit segment is passed.
		expect(
			buildStallAbortUnsettledMessage({
				silentMs: 900_000,
				exemption: exemptionSnapshot({ kernel: kernelFacts }),
				diagnosticsPointer: testPointer,
			}),
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
