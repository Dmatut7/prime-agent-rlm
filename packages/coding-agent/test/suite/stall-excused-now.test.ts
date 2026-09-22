import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KernelLivenessSample } from "../../src/core/kernel/shared.js";
import { StallWatchdog } from "../../src/core/stall-watchdog.js";
import type { TurnLivenessKernelFacts } from "../../src/core/turn-liveness.js";
import { StallFakeClock } from "../fixtures/stall-fake-clock.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * r4 phase-2 blind fix A, the session half: `AgentSession.excusedNow` is the
 * watchdog's own exemption verdict, sampled live - the single arbiter the
 * daemon sweep trusts for "is this silence owned work". Its read contract is
 * load-bearing twice over, so it is pinned against a real session with a live
 * vouch (a double would replay whatever the test scripted):
 * - it sees the live segment against the clock, so the budget running out ends
 *   the excuse (P8: no permanent excuse from a warn-time snapshot);
 * - it never perturbs the watchdog: no predicate re-sampling, no touch, no
 *   exemption transition. A diagnostic read that mutated the segment could
 *   fold transitions, release the exemption, or settle accrued silence, and
 *   the sweep would quietly change what the watchdog itself decides.
 */

const WARN_AFTER_MS = 50;

function hangTool(): AgentTool {
	return {
		name: "hang_forever",
		label: "Hang Forever",
		description: "A tool that never returns",
		parameters: Type.Object({}),
		execute: () => new Promise<never>(() => {}),
	};
}

function sample(overrides: Partial<KernelLivenessSample> = {}): KernelLivenessSample {
	return {
		receivedAt: Date.now(),
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

/** A kernel whose externally owned work is demonstrably moving: the vouch tier. */
function workingKernelFacts(): TurnLivenessKernelFacts {
	return {
		protocol: 4,
		previous: sample({ receivedAt: Date.now() - 5_000, tick: 10, streamBytes: 100 }),
		latest: sample({ tick: 40, streamBytes: 4_000, bashHandles: 1, bashCellHandles: 1 }),
		rejectedFrames: 0,
		consecutiveRejectedFrames: 0,
		hostRequestCount: 0,
		kernelPid: 4242,
		hasActiveExecution: true,
	};
}

describe("excusedNow: the live exemption sample the sweep trusts", () => {
	const harnesses: Harness[] = [];
	const entries: LogEntry[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		setLogSink(undefined);
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function track(harness: Harness): Harness {
		harnesses.push(harness);
		return harness;
	}

	async function vouchedWedgedSession() {
		const clock = new StallFakeClock();
		const harness = track(
			await createHarness({
				tools: [hangTool()],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: WARN_AFTER_MS / 1000, abortAfterSeconds: 0 },
					retry: { enabled: false },
				},
				stallWatchdogTimers: clock.timersImpl,
				stallKernelLivenessFacts: () => workingKernelFacts(),
			}),
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("recovered with a changed approach"),
		]);
		void harness.session.prompt("hang inside a tool");
		await vi.waitFor(
			() => {
				expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1);
			},
			{ timeout: 10_000, interval: 10 },
		);
		// Drive the watchdog to its warn stage with the vouch live: a vouch never
		// swallows the warning, it only defers the abort, so the marker lands with
		// an exemption in effect.
		clock.advance(WARN_AFTER_MS);
		await vi.waitFor(
			() => {
				expect(harness.eventsOfType("stall_warning")).toHaveLength(1);
			},
			{ timeout: 10_000, interval: 10 },
		);
		return { harness, clock };
	}

	it("sees the live verdict: excused while the budget holds, not excused once it is spent", async () => {
		const { harness, clock } = await vouchedWedgedSession();
		const warn = harness.eventsOfType("stall_warning")[0]!;
		// Positive control: the exemption really is in effect at the warn, or the
		// excusedNow assertions below would be pinning an empty read.
		expect(warn.diagnostics.exemption).toBeDefined();
		expect(harness.session.stallState?.excused).toBe(true);
		// The live sample agrees while the segment is unexhausted.
		expect(harness.session.excusedNow).toBe(true);
		// ... across the exemption budget's whole life (progress tier buys the
		// 30-minute cap; liveness 20; both fall inside this window).
		clock.advance(12 * 60_000);
		expect(harness.session.excusedNow).toBe(true);
		// The budget runs out: the watchdog is the single arbiter, and the excuse
		// ends with its own clock, not with the warn-time marker.
		clock.advance(20 * 60_000);
		expect(harness.session.excusedNow).toBe(false);
		// The marker still says what the warn said; the sweep reads the live one.
		expect(harness.session.stallState?.excused).toBe(true);
	});

	it("never perturbs the watchdog: no touch, no defer, no exemption transition", async () => {
		const { harness, clock } = await vouchedWedgedSession();
		expect(harness.session.stallState?.excused).toBe(true);

		// The watchdog's own record of its state transitions, captured around the
		// reads: a perturbing read would emit started/cleared/exhausted lines or
		// fold micro-segments of its own.
		setLogSink((entry) => {
			entries.push(entry);
		});
		const exemptionLinesBefore = entries.filter((entry) => entry.msg.startsWith("stall watchdog: exemption")).length;
		// And the public mutating entry points: the read must not drive the
		// watchdog through touch (a re-arm) or deferToolTimeout (a re-sample).
		const touch = vi.spyOn(StallWatchdog.prototype, "touch");
		const deferToolTimeout = vi.spyOn(StallWatchdog.prototype, "deferToolTimeout");

		for (let i = 0; i < 5; i++) {
			expect(harness.session.excusedNow).toBe(true);
			clock.advance(30_000);
		}
		expect(touch).not.toHaveBeenCalled();
		expect(deferToolTimeout).not.toHaveBeenCalled();
		const exemptionLinesAfter = entries.filter((entry) => entry.msg.startsWith("stall watchdog: exemption")).length;
		expect(exemptionLinesAfter).toBe(exemptionLinesBefore);
		// The read stayed honest across the clock movement: still excused, and
		// still no watchdog method driven while it flipped to spent (2.5 minutes
		// of reads plus this window crosses both tiers' budgets).
		clock.advance(28 * 60_000);
		expect(harness.session.excusedNow).toBe(false);
		expect(touch).not.toHaveBeenCalled();
		expect(deferToolTimeout).not.toHaveBeenCalled();
	});
});
