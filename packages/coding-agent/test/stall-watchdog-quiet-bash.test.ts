/**
 * LIVE-1 (r44), the 20-minute form: a single cell awaiting a quiet bash() command. The kernel
 * heartbeat attests the handle - fresh frames, a live loop, a cell awaiting, no output movement -
 * and before r44 that vouch was existence-only, so the liveness budget expired at twenty minutes
 * and the stall watchdog aborted a turn that was waiting on live work.
 *
 * This file composes the real turn-liveness aggregate with the real watchdog on a fake clock,
 * performing the same mapping the session performs in `_sampleStallVouch`, so the tier decision
 * and the budget it buys are pinned together:
 *  - the quiet awaited handle survives past the liveness budget,
 *  - it still dies at the combined cap (a quietly-wedged handle must not hold the turn forever),
 *  - a handle under a frozen loop (the genuine wedge) keeps the short budget and dies on time.
 */

import { describe, expect, it } from "vitest";
import type { KernelLivenessSample } from "../src/core/kernel/shared.js";
import {
	STALL_VOUCH_LIVENESS_BUDGET_MS,
	type StallVouchFacts,
	StallWatchdog,
	type StallWatchdogStageInfo,
} from "../src/core/stall-watchdog.js";
import { createTurnLiveness, type TurnLiveness, type TurnLivenessKernelFacts } from "../src/core/turn-liveness.js";
import { MINUTE_MS, StallFakeClock } from "./fixtures/stall-fake-clock.js";

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
		bashHandles: 1,
		bashCellHandles: 1,
		bashBufferedBytes: 0,
		bashPipePending: 0,
		...overrides,
	};
}

type KernelShape = "quiet-awaited-bash" | "frozen-loop-handle";

/**
 * Two retained frames judged by the watchdog's own clock. The quiet shape is `await bash(job)`:
 * the loop ticks (the cell yields), a cell is awaiting, and the awaited handle is the cell's own.
 * The frozen shape is the genuine wedge: frames keep arriving but a synchronous cell monopolizes
 * the loop, so the tick does not move.
 */
function kernelFactsFor(clock: StallFakeClock, shape: () => KernelShape, tick: { value: number }) {
	return (): TurnLivenessKernelFacts => {
		const now = clock.nowMs;
		const previousTick = tick.value;
		if (shape() === "quiet-awaited-bash") tick.value += 5;
		const common = shape() === "quiet-awaited-bash" ? {} : { cellId: "cell-1" };
		return {
			protocol: 4,
			previous: sample({ receivedAt: now - 10_000, tick: previousTick, ...common }),
			latest: sample({ receivedAt: now - 5_000, tick: tick.value, ...common }),
			rejectedFrames: 0,
			consecutiveRejectedFrames: 0,
			hostRequestCount: 0,
			kernelPid: 4242,
			hasActiveExecution: true,
		};
	};
}

/** The session's own mapping of liveness facts onto the watchdog's vouch shape. */
function vouchFrom(liveness: TurnLiveness): () => StallVouchFacts | undefined {
	return () => {
		const facts = liveness.sample();
		if (!facts.vouched) return undefined;
		return {
			active: true,
			reasons: facts.reasons,
			tier: facts.progress ? "progress" : "liveness",
			...(facts.movementToken === undefined ? {} : { movementToken: facts.movementToken }),
			kernel: {
				...(facts.protocol === undefined ? {} : { protocol: facts.protocol }),
				...(facts.liveBashHandles === undefined ? {} : { liveBashHandles: facts.liveBashHandles }),
				hostRequestCount: facts.hostRequestCount ?? 0,
				...(facts.kernelPid === undefined ? {} : { kernelPid: facts.kernelPid }),
				reasons: facts.kernelReasons,
			},
		};
	};
}

function createHarness(shape: () => KernelShape) {
	const clock = new StallFakeClock();
	const tick = { value: 10 };
	const liveness = createTurnLiveness({
		kernel: kernelFactsFor(clock, shape, tick),
		now: () => clock.nowMs,
	});
	const stages: StallWatchdogStageInfo[] = [];
	const watchdog = new StallWatchdog({
		enabled: true,
		warnAfterMs: MINUTE_MS,
		abortAfterMs: 3 * MINUTE_MS,
		vouch: vouchFrom(liveness),
		timers: clock.timersImpl,
		onStage: (info) => stages.push(info),
	});
	return { clock, liveness, watchdog, stages, stageNames: () => stages.map((stage) => stage.stage) };
}

describe("LIVE-1 a quiet awaited bash() handle survives the liveness budget", () => {
	it("survives past the twenty-minute liveness budget, then dies at the combined cap", () => {
		const h = createHarness(() => "quiet-awaited-bash");
		h.watchdog.arm();

		// The turn is vouched (a live handle, an awaiting cell), the exemption is claimed...
		h.clock.advance(MINUTE_MS);
		expect(h.stageNames()).toEqual(["warn"]);
		expect(h.watchdog.exemption).toMatchObject({ reason: "vouched", tier: "progress" });
		expect(h.watchdog.exemption?.reasons).toContain("live_bash_handles");

		// ...and the existence budget no longer kills it: five minutes past the old deadline.
		h.clock.advance(STALL_VOUCH_LIVENESS_BUDGET_MS + 5 * MINUTE_MS);
		expect(h.stageNames()).not.toContain("abort");

		// The combined cap (30 minutes with a 1-minute warn window) still bounds a handle that
		// quietly never produces: a wedge must die within the cap, not never.
		h.clock.advance(10 * MINUTE_MS);
		expect(h.stageNames()).toContain("abort");
		const abortStages = h.stages.filter((stage) => stage.stage === "abort");
		expect(abortStages).toHaveLength(1);
	});

	it("keeps the short budget for a handle under a frozen loop (the genuine wedge)", () => {
		const h = createHarness(() => "frozen-loop-handle");
		h.watchdog.arm();

		// Frames arrive with a frozen tick and a live handle: existence only, the old behavior.
		h.clock.advance(MINUTE_MS);
		expect(h.watchdog.exemption).toMatchObject({ reason: "vouched", tier: "liveness" });
		expect(h.watchdog.exemption?.kernel?.reasons).toContain("loop_stalled");

		// Positive control: the short budget still expires on time and the wedge is killed.
		h.clock.advance(STALL_VOUCH_LIVENESS_BUDGET_MS + 5 * MINUTE_MS);
		expect(h.stageNames()).toContain("abort");
	});
});
