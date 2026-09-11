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
	DEFAULT_HOST_REQUEST_MAX_AGE_MS,
	type JournaledBashFacts,
	type TurnLiveness,
	type TurnLivenessKernelFacts,
} from "../src/core/turn-liveness.js";
import { MINUTE_MS, StallFakeClock } from "./fixtures/stall-fake-clock.js";

/**
 * T1-3 composition: the fact aggregate and the watchdog budget, driven by one fake clock.
 *
 * `turn-liveness.test.ts` pins the verdict arithmetic on its own and
 * `suite/ma-p0-1-long-cell-survives.test.ts` pins the installed predicate end to end; this file
 * pins what the two halves do together over the timescales that matter in production - a real
 * job buying the full budget, a hung handle buying only the short one, a wedged host handler
 * losing its vouch at the age bound, and a genuine deadlock still dying at 900s to the second.
 *
 * The vouch closure below mirrors the session's `_sampleStallVouch`, including the necessary
 * conjunction on a tool being in flight and the two-tier mapping.
 */
const WARN_AFTER_MS = 5 * MINUTE_MS;
const ABORT_AFTER_MS = 15 * MINUTE_MS;

function sample(overrides: Partial<KernelLivenessSample> = {}): KernelLivenessSample {
	return {
		receivedAt: 0,
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
		...overrides,
	};
}

interface LivenessHarness {
	clock: StallFakeClock;
	watchdog: StallWatchdog;
	liveness: TurnLiveness;
	stages: StallWatchdogStageInfo[];
	stageNames(): string[];
	/** Kernel facts, rebuilt per sample so ages can move with the clock. */
	kernelFacts: () => TurnLivenessKernelFacts | undefined;
	setKernelFacts(next: () => TurnLivenessKernelFacts | undefined): void;
	inFlightTools: { size: number };
	exemptionEnabled: { value: boolean };
	journalReads: number[];
	setJournal(next: (kernelPid: number | undefined) => JournaledBashFacts | undefined): void;
}

function createHarness(options?: { degradedFactsMaxAgeMs?: number }): LivenessHarness {
	const clock = new StallFakeClock();
	const stages: StallWatchdogStageInfo[] = [];
	const journalReads: number[] = [];
	const state = {
		kernelFacts: () => undefined as TurnLivenessKernelFacts | undefined,
		journal: undefined as ((kernelPid: number | undefined) => JournaledBashFacts | undefined) | undefined,
	};
	const liveness = createTurnLiveness({
		kernel: () => state.kernelFacts(),
		now: () => clock.nowMs,
		...(options?.degradedFactsMaxAgeMs === undefined ? {} : { degradedFactsMaxAgeMs: options.degradedFactsMaxAgeMs }),
		readJournaledBashHandles: (kernelPid) => {
			journalReads.push(clock.nowMs);
			return state.journal ? state.journal(kernelPid) : undefined;
		},
		onEvent: () => {},
	});
	const inFlightTools = { size: 1 };
	const exemptionEnabled = { value: true };
	const vouch = (): StallVouchFacts | undefined => {
		if (!exemptionEnabled.value) return undefined;
		// Necessary conjunction: with no tool in flight the silence belongs to the model stream.
		if (inFlightTools.size === 0) return undefined;
		const facts = liveness.sample();
		if (!facts.vouched) return undefined;
		return {
			active: true,
			reasons: facts.reasons,
			tier: facts.progress ? "progress" : "liveness",
			kernel: {
				...(facts.protocol === undefined ? {} : { protocol: facts.protocol }),
				...(facts.livenessAgeMs === undefined ? {} : { livenessAgeMs: facts.livenessAgeMs }),
				...(facts.liveBashHandles === undefined ? {} : { liveBashHandles: facts.liveBashHandles }),
				hostRequestCount: facts.hostRequestCount,
				...(facts.kernelPid === undefined ? {} : { kernelPid: facts.kernelPid }),
				reasons: facts.kernelReasons,
			},
		};
	};
	const watchdog = new StallWatchdog({
		enabled: true,
		warnAfterMs: WARN_AFTER_MS,
		abortAfterMs: ABORT_AFTER_MS,
		timers: clock.timersImpl,
		vouch,
		// Keep the settle stage out of these windows: it is T1-1's business, not the vouch's.
		abortSettleGraceMs: 60 * MINUTE_MS,
		onStage: (info) => {
			stages.push(info);
			// What the session does once per stage when the heartbeat cannot vouch (B4).
			if (liveness.sample().state !== "fresh") liveness.refreshDegradedFacts();
		},
	});
	return {
		clock,
		watchdog,
		liveness,
		stages,
		stageNames: () => stages.map((stage) => stage.stage),
		get kernelFacts() {
			return state.kernelFacts;
		},
		setKernelFacts(next) {
			state.kernelFacts = next;
		},
		inFlightTools,
		exemptionEnabled,
		journalReads,
		setJournal(next) {
			state.journal = next;
		},
	};
}

describe("stall watchdog tool liveness vouch (T1-3)", () => {
	it("lets a working job run past the abort threshold and kills it when the budget is spent", () => {
		const h = createHarness();
		// A command producing output: tick advancing and stream bytes growing between frames.
		h.setKernelFacts(() => ({
			protocol: 4,
			previous: sample({ receivedAt: h.clock.nowMs - 5_000, tick: 10, streamBytes: 100 }),
			latest: sample({
				receivedAt: h.clock.nowMs,
				tick: 40,
				streamBytes: 4_000,
				bashHandles: 1,
				bashCellHandles: 1,
			}),
			hostRequestCount: 0,
			kernelPid: 4242,
			hasActiveExecution: true,
		}));
		h.watchdog.arm();
		h.watchdog.touch();

		// Production thresholds: warn at 5min, abort at 15min. The budget cap is
		// max(10 x warn, 30min) = 50min, and the segment started at the touch.
		h.clock.advance(ABORT_AFTER_MS - 1);
		expect(h.stageNames()).toEqual(["warn"]);
		h.clock.advance(MINUTE_MS);
		expect(h.stageNames()).toEqual(["warn"]);

		h.clock.advance(50 * MINUTE_MS - ABORT_AFTER_MS);
		expect(h.stageNames()).toEqual(["warn", "abort"]);
		// B2: the warning was never swallowed by the exemption, and it said the abort was deferred.
		expect(h.stages[0]?.exemption).toMatchObject({ reason: "vouched", tier: "progress" });
		expect(h.stages[1]?.exemption?.exhausted).toBe(true);
	});

	it("gives a live handle with no movement the short budget only (M3)", () => {
		const h = createHarness();
		// A command wedged on stdin: the handle exists, the loop ticks, nothing is produced.
		h.setKernelFacts(() => ({
			protocol: 4,
			previous: sample({ receivedAt: h.clock.nowMs - 5_000, tick: 10 }),
			latest: sample({ receivedAt: h.clock.nowMs, tick: 40, bashHandles: 1, bashCellHandles: 1 }),
			hostRequestCount: 0,
			kernelPid: 4242,
			hasActiveExecution: true,
		}));
		h.watchdog.arm();
		h.watchdog.touch();

		h.clock.advance(STALL_VOUCH_LIVENESS_BUDGET_MS - MINUTE_MS);
		expect(h.stageNames()).toEqual(["warn"]);
		h.clock.advance(2 * MINUTE_MS);
		expect(h.stageNames()).toEqual(["warn", "abort"]);
		expect(h.stages[0]?.exemption).toMatchObject({ tier: "liveness" });
		expect(h.stages[0]?.exemption?.budgetMs).toBe(STALL_VOUCH_LIVENESS_BUDGET_MS);
	});

	it("stops vouching once a host request is older than the age bound (B7 / I-5)", () => {
		const h = createHarness();
		const startedAt = 0;
		h.setKernelFacts(() => ({
			protocol: 4,
			previous: sample({ receivedAt: h.clock.nowMs - 5_000, tick: 10 }),
			latest: sample({ receivedAt: h.clock.nowMs, tick: 40 }),
			hostRequestCount: 1,
			hostRequestOldestAgeMs: Math.max(0, h.clock.nowMs - startedAt),
			kernelPid: 4242,
			hasActiveExecution: true,
		}));
		h.watchdog.arm();
		h.watchdog.touch();

		// Inside the bound the request vouches, so the ordinary 15min abort does not fire.
		h.clock.advance(DEFAULT_HOST_REQUEST_MAX_AGE_MS - MINUTE_MS);
		expect(h.stageNames()).toEqual(["warn"]);
		// Past it, the vouch is withdrawn and the next re-check (at most one warn window later)
		// kills the turn: a wedged host handler cannot hold the full 50min budget.
		h.clock.advance(WARN_AFTER_MS + MINUTE_MS);
		expect(h.stageNames()).toEqual(["warn", "abort"]);
		const abortedAt = h.stages[1]?.silentMs ?? 0;
		expect(abortedAt).toBeGreaterThanOrEqual(DEFAULT_HOST_REQUEST_MAX_AGE_MS);
		expect(abortedAt).toBeLessThanOrEqual(DEFAULT_HOST_REQUEST_MAX_AGE_MS + WARN_AFTER_MS);
		expect(h.liveness.sample().kernelReasons).toContain("host_request_aged_out");
	});

	it("kills a stalled loop with nothing external running at the ordinary threshold", () => {
		const h = createHarness();
		// Frames arrive, the tick is frozen, no handle, no host request: the genuine deadlock.
		h.setKernelFacts(() => ({
			protocol: 4,
			previous: sample({ receivedAt: h.clock.nowMs - 5_000, tick: 10 }),
			latest: sample({ receivedAt: h.clock.nowMs, tick: 10 }),
			hostRequestCount: 0,
			kernelPid: 4242,
			hasActiveExecution: true,
		}));
		h.watchdog.arm();

		h.clock.advance(WARN_AFTER_MS);
		expect(h.stageNames()).toEqual(["warn"]);
		h.clock.advance(ABORT_AFTER_MS - WARN_AFTER_MS - 1);
		expect(h.stageNames()).toEqual(["warn"]);
		// Not one second later than today: no exemption was ever claimed.
		h.clock.advance(1);
		expect(h.stageNames()).toEqual(["warn", "abort"]);
		expect(h.stages[1]?.exemption).toBeUndefined();
		expect(h.stages[1]?.silentMs).toBeGreaterThanOrEqual(ABORT_AFTER_MS);
	});

	it("does not vouch when no tool is in flight, however healthy the kernel looks", () => {
		const h = createHarness();
		h.setKernelFacts(() => ({
			protocol: 4,
			previous: sample({ receivedAt: h.clock.nowMs - 5_000, tick: 10, streamBytes: 100 }),
			latest: sample({ receivedAt: h.clock.nowMs, tick: 40, streamBytes: 4_000, bashHandles: 1 }),
			hostRequestCount: 0,
			kernelPid: 4242,
			hasActiveExecution: false,
		}));
		h.inFlightTools.size = 0;
		h.watchdog.arm();

		h.clock.advance(ABORT_AFTER_MS);
		// A stuck model stream is streamStallTimeoutMs's business; a live kernel handle must not
		// excuse it. This is the case the necessary conjunction exists for.
		expect(h.stageNames()).toEqual(["warn", "abort"]);
		expect(h.stages[1]?.exemption).toBeUndefined();
	});

	it("falls back to journaled handles when the heartbeat goes stale, and buys only the short tier", () => {
		// A long lifetime for the degraded read, so this case measures the tier the fallback buys
		// rather than the read's own expiry (pinned by the next case).
		const h = createHarness({ degradedFactsMaxAgeMs: 60 * MINUTE_MS });
		const lastFrameAt = 0;
		h.setKernelFacts(() => ({
			protocol: 4,
			// The heartbeat stopped: the newest frame ages past three of its own intervals.
			latest: sample({ receivedAt: lastFrameAt, intervalMs: 15_000, bashHandles: 1 }),
			hostRequestCount: 0,
			kernelPid: 4242,
			hasActiveExecution: true,
		}));
		h.setJournal((kernelPid) => {
			expect(kernelPid).toBe(4242);
			return { liveBashHandles: 2 };
		});
		h.watchdog.arm();
		h.watchdog.touch();

		// At the warn stage the heartbeat is already stale (5min > 3 x 15s), so the stage handler
		// reads the journal: acceptance (5)'s degraded path, with the read itself asserted. The warn
		// itself was evaluated before that read, so it carries no exemption yet - the deferral starts
		// at the abort check, which is the next sampling after the facts landed.
		h.clock.advance(WARN_AFTER_MS);
		expect(h.stageNames()).toEqual(["warn"]);
		expect(h.journalReads.length).toBeGreaterThan(0);
		expect(h.liveness.sample().kernelReasons).toContain("heartbeat_stale");
		expect(h.liveness.sample().vouched).toBe(true);

		// A journal record proves existence, never movement: the short budget from the moment the
		// vouch started (the abort check at 15min), then the kill.
		h.clock.advance(ABORT_AFTER_MS - WARN_AFTER_MS);
		expect(h.stageNames()).toEqual(["warn"]);
		expect(h.liveness.sample().progress).toBe(false);
		h.clock.advance(STALL_VOUCH_LIVENESS_BUDGET_MS);
		expect(h.stageNames()).toEqual(["warn", "abort"]);
		expect(h.stages[1]?.exemption).toMatchObject({ reason: "vouched", tier: "liveness", exhausted: true });
	});

	it("bounds the degraded fallback by the read's own lifetime", () => {
		// Default lifetime (15min). The read at the warn stage (5min) is what defers the ordinary
		// 15min abort; once it expires the vouch collapses and the next re-check kills the turn,
		// budget or no budget. A file read from long ago must not keep excusing silence.
		const h = createHarness();
		h.setKernelFacts(() => ({
			protocol: 4,
			latest: sample({ receivedAt: 0, intervalMs: 15_000, bashHandles: 1 }),
			hostRequestCount: 0,
			kernelPid: 4242,
			hasActiveExecution: true,
		}));
		h.setJournal(() => ({ liveBashHandles: 1 }));
		h.watchdog.arm();
		h.watchdog.touch();

		h.clock.advance(WARN_AFTER_MS);
		expect(h.stageNames()).toEqual(["warn"]);
		// The ordinary abort threshold passes with the degraded vouch in effect...
		h.clock.advance(ABORT_AFTER_MS - WARN_AFTER_MS - 1);
		expect(h.stageNames()).toEqual(["warn"]);
		// ... and the kill lands once the read has expired, at the next re-check after that: the
		// lifetime (15min from the warn stage) plus at most one warn window of granularity.
		h.clock.advance(2 * WARN_AFTER_MS);
		expect(h.stageNames()).toEqual(["warn"]);
		h.clock.advance(WARN_AFTER_MS);
		expect(h.stageNames()).toEqual(["warn", "abort"]);
		expect(h.stages[1]?.silentMs).toBeLessThanOrEqual(
			WARN_AFTER_MS + DEFAULT_DEGRADED_FACTS_MAX_AGE_MS + WARN_AFTER_MS,
		);
		// Not by what the liveness tier would have allowed from the moment the vouch started
		// (15min + 20min): a file read from long ago stops excusing silence.
		expect(h.stages[1]?.silentMs).toBeLessThan(ABORT_AFTER_MS + STALL_VOUCH_LIVENESS_BUDGET_MS);
		// The vouch collapsed rather than running out of budget: no exemption at the abort.
		expect(h.stages[1]?.exemption).toBeUndefined();
	});

	it("vouches nothing when the session has no kernel at all, and kills at the threshold", () => {
		const h = createHarness();
		h.setKernelFacts(() => undefined);
		h.watchdog.arm();

		h.clock.advance(ABORT_AFTER_MS);
		expect(h.stageNames()).toEqual(["warn", "abort"]);
		expect(h.stages[1]?.exemption).toBeUndefined();
		// The degraded path was attempted (the heartbeat is absent) and found nothing to read: no
		// kernel pid means no journaled children to claim, which is a no-op and not an error.
		expect(h.journalReads.length).toBeGreaterThan(0);
		expect(h.liveness.sample().vouched).toBe(false);
	});

	it("honours the settings kill switch", () => {
		const h = createHarness();
		h.setKernelFacts(() => ({
			protocol: 4,
			previous: sample({ receivedAt: h.clock.nowMs - 5_000, tick: 10, streamBytes: 100 }),
			latest: sample({ receivedAt: h.clock.nowMs, tick: 40, streamBytes: 4_000, bashHandles: 1 }),
			hostRequestCount: 0,
			kernelPid: 4242,
			hasActiveExecution: true,
		}));
		h.exemptionEnabled.value = false;
		h.watchdog.arm();

		h.clock.advance(ABORT_AFTER_MS);
		expect(h.stageNames()).toEqual(["warn", "abort"]);
	});
});
