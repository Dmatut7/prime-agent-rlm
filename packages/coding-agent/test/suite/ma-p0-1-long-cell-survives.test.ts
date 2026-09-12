/**
 * P0-1c wiring (T1-3): a long cell the kernel can vouch for survives the stall watchdog, and
 * everything that must still be killed is still killed.
 *
 * The session-level half of the vouch. `turn-liveness.test.ts` pins the verdict arithmetic and
 * `stall-watchdog-tool-liveness.test.ts` pins the budget it buys; this file pins the four things
 * only the wiring can get wrong: the predicate is installed at all, it needs a tool in flight
 * (a stuck model stream must not be excused by a healthy kernel), a throwing fact source degrades
 * to "no exemption" instead of killing the watchdog (F2), and a warn-only watchdog never claims
 * an abort was deferred when there is no abort channel to defer (F3).
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type LogEntry, setLogSink } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.js";
import type { KernelLivenessSample } from "../../src/core/kernel/shared.js";
import type { TurnLivenessKernelFacts } from "../../src/core/turn-liveness.js";
import { createHarness, type Harness } from "./harness.js";

const hangTool: AgentTool = {
	name: "hang_forever",
	label: "Hang Forever",
	description: "A tool that never returns",
	parameters: Type.Object({}),
	execute: () => new Promise<never>(() => {}),
};

function sample(overrides: Partial<KernelLivenessSample> = {}): KernelLivenessSample {
	return {
		// Live clock: the aggregate judges staleness against Date.now(), so a fixed epoch here
		// would make every fixture look like a heartbeat that stopped long ago.
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

/** A kernel running a command that is producing output: the strongest vouch there is. */
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

/** A kernel whose loop is blocked by a synchronous cell: frames arrive, the tick does not move. */
function wedgedKernelFacts(): TurnLivenessKernelFacts {
	return {
		protocol: 4,
		previous: sample({ receivedAt: Date.now() - 5_000, tick: 10 }),
		latest: sample({ tick: 10 }),
		rejectedFrames: 0,
		consecutiveRejectedFrames: 0,
		hostRequestCount: 0,
		kernelPid: 4242,
		hasActiveExecution: true,
	};
}

describe("P0-1c a vouched long cell survives the stall watchdog", () => {
	const harnesses: Harness[] = [];
	let entries: LogEntry[] = [];

	beforeEach(() => {
		entries = [];
		setLogSink((entry) => {
			entries.push(entry);
		});
	});

	afterEach(() => {
		setLogSink(undefined);
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	function track(harness: Harness): Harness {
		harnesses.push(harness);
		return harness;
	}

	function waitForEvent(
		harness: Harness,
		predicate: (event: AgentSessionEvent) => boolean,
		timeoutMs = 10_000,
	): Promise<AgentSessionEvent> {
		return vi.waitFor(
			() => {
				const found = harness.events.find(predicate);
				expect(found, "session never emitted the expected event").toBeDefined();
				if (!found) throw new Error("unreachable");
				return found;
			},
			{ timeout: timeoutMs, interval: 10 },
		);
	}

	async function startHungTurn(harness: Harness): Promise<void> {
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("recovered"),
		]);
		void harness.session.prompt("call the hanging tool");
		await waitForEvent(harness, (event) => event.type === "tool_execution_start");
	}

	it("defers the abort, still warns, and reports the exemption in diagnostics", async () => {
		const harness = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0.1 },
					retry: { enabled: false },
				},
				stallKernelLivenessFacts: () => workingKernelFacts(),
			}),
		);
		await startHungTurn(harness);

		const warning = await waitForEvent(harness, (event) => event.type === "stall_warning");
		if (warning.type !== "stall_warning") throw new Error("unreachable");
		// The copy tells the truth: no abort deadline that the exemption will not keep.
		expect(warning.message).toContain("deferred");
		expect(warning.message).not.toContain("will be aborted automatically");
		expect(warning.message).toContain("no session activity");
		// The diagnostics carry both new segments, so a post-mortem can see what vouched.
		expect(warning.diagnostics.exemption).toMatchObject({ reason: "vouched", tier: "progress" });
		expect(warning.diagnostics.exemption?.reasons).toContain("live_bash_handles");
		expect(warning.diagnostics.kernel).toMatchObject({ protocol: 4, kernelPid: 4242, liveBashHandles: 1 });

		// The budget is max(10 x warn, 30min) for the progress tier, so nothing aborts here: the
		// window that used to kill this turn at 100ms of silence no longer does.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(harness.eventsOfType("stall_abort")).toEqual([]);
		expect(harness.eventsOfType("stall_warning").length).toBeGreaterThan(0);
	});

	it("hands the kernel's movement to the watchdog, so a producing cell is never charged for it", async () => {
		// The wiring half of P1: the session's own predicate must forward the movement identity the
		// fact aggregate reports, because that - not the tier - is what tells the watchdog the exempt
		// silence it is charging was explained. A cell that keeps producing new streamed output on
		// every sample therefore stays uncharged for as long as it produces.
		let frames = 0;
		const harness = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0.1 },
					retry: { enabled: false },
				},
				stallKernelLivenessFacts: () => {
					frames += 1;
					return {
						protocol: 4,
						previous: sample({ receivedAt: Date.now() - 5_000, tick: frames, streamBytes: frames * 100 }),
						latest: sample({
							receivedAt: Date.now(),
							tick: frames + 1,
							streamBytes: (frames + 1) * 100,
							bashHandles: 1,
							bashCellHandles: 1,
						}),
						rejectedFrames: 0,
						consecutiveRejectedFrames: 0,
						hostRequestCount: 0,
						kernelPid: 4242,
						hasActiveExecution: true,
					};
				},
			}),
		);
		await startHungTurn(harness);

		const warning = await waitForEvent(harness, (event) => event.type === "stall_warning");
		if (warning.type !== "stall_warning") throw new Error("unreachable");
		expect(warning.message).toContain("deferred");
		expect(warning.diagnostics.exemption).toMatchObject({ reason: "vouched", tier: "progress" });
		// The segment was born at the tool's start event, so by the time the warning fires the
		// watchdog has sampled the moving counters again and settled what the silence had accrued.
		// This is the assertion that pins the session's own predicate forwarding the token: without
		// it the movement is invisible here and nothing is ever settled.
		expect(warning.diagnostics.exemption?.settledByMovementMs).toBeGreaterThan(0);

		// Twenty warn windows of a cell that never stops producing: the exemption is still claimed and
		// still unspent, so nothing escalates. (The cap itself has a 30min floor, which is why the
		// settled-vs-spent arithmetic is pinned by the fake-clock tests rather than here.)
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(harness.eventsOfType("stall_abort")).toEqual([]);
		expect(harness.eventsOfType("stall_unsettled")).toEqual([]);
		expect(frames).toBeGreaterThan(1);
	});

	it("still aborts a wedged kernel at the ordinary threshold", async () => {
		const harness = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0.1 },
					retry: { enabled: false },
				},
				stallKernelLivenessFacts: () => wedgedKernelFacts(),
				stallAbortSettleGraceMs: 0,
			}),
		);
		await startHungTurn(harness);

		// Positive control for the case above: the same thresholds, a kernel that is provably not
		// making progress, and the pre-exemption behaviour is unchanged down to the copy.
		const warning = await waitForEvent(harness, (event) => event.type === "stall_warning");
		if (warning.type !== "stall_warning") throw new Error("unreachable");
		expect(warning.message).toContain("will be aborted automatically");
		expect(warning.message).not.toContain("deferred");
		expect(warning.diagnostics.kernel?.reasons).toEqual(["loop_stalled"]);
		expect(warning.diagnostics.exemption).toBeUndefined();

		const abort = await waitForEvent(harness, (event) => event.type === "stall_abort");
		if (abort.type !== "stall_abort") throw new Error("unreachable");
		expect(abort.message).toContain("aborted automatically");
		expect(abort.diagnostics.kernel?.reasons).toEqual(["loop_stalled"]);
	});

	it("does not excuse a stuck model stream just because the kernel is healthy", async () => {
		const harness = track(
			await createHarness({
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0.1 },
					// The provider stream stall detector owns its own copy of this failure; keep it
					// out of the way so the session watchdog is what fires.
					retry: { enabled: false, provider: { streamStallTimeoutMs: 60_000 } },
				},
				stallKernelLivenessFacts: () => workingKernelFacts(),
				stallAbortSettleGraceMs: 0,
			}),
		);
		// A provider step that accepts the request and never streams: no tool is in flight, so the
		// silence belongs to the model stream and the necessary conjunction must refuse the vouch.
		harness.setResponses([() => new Promise<never>(() => {})]);
		void harness.session.prompt("hang the stream");

		const abort = await waitForEvent(harness, (event) => event.type === "stall_abort");
		if (abort.type !== "stall_abort") throw new Error("unreachable");
		expect(abort.message).toContain("aborted automatically");
		expect(abort.diagnostics.exemption).toBeUndefined();
	});

	it("keeps the watchdog alive when the fact source throws (F2)", async () => {
		const harness = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0.1 },
					retry: { enabled: false },
				},
				stallKernelLivenessFacts: () => {
					throw new Error("kernel client exploded");
				},
				stallAbortSettleGraceMs: 0,
			}),
		);
		await startHungTurn(harness);

		// An exception inside the predicate used to escape into the watchdog's timer callback and
		// end escalation silently. It must degrade to "no exemption" and say so once.
		const warning = await waitForEvent(harness, (event) => event.type === "stall_warning");
		if (warning.type !== "stall_warning") throw new Error("unreachable");
		expect(warning.message).toContain("will be aborted automatically");
		await waitForEvent(harness, (event) => event.type === "stall_abort");
		const failures = entries.filter(
			(entry) => entry.msg === "stall watchdog predicate failed; treating it as no exemption",
		);
		// Loud, and throttled: one line per consumer that degraded (the vouch, the degraded-fact
		// refresh, the diagnostics collector), not one per sample. The predicate is sampled on
		// every agent event, so an unthrottled version would bury the stall diagnostics.
		expect(failures.length).toBeGreaterThan(0);
		expect(failures.length).toBeLessThanOrEqual(3);
		const predicates = failures.map((entry) => entry.predicate);
		expect(new Set(predicates).size).toBe(predicates.length);
		expect(predicates).toContain("vouch");
		for (const failure of failures) {
			expect(failure.level).toBe("warn");
			expect(failure.error).toBe("kernel client exploded");
		}
	});

	it("never claims a deferred abort in warn-only mode (F3)", async () => {
		const harness = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					// abortAfterSeconds 0 is warn-only: there is no abort channel to defer.
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0 },
					retry: { enabled: false },
				},
				stallKernelLivenessFacts: () => workingKernelFacts(),
			}),
		);
		await startHungTurn(harness);

		const warning = await waitForEvent(harness, (event) => event.type === "stall_warning");
		if (warning.type !== "stall_warning") throw new Error("unreachable");
		expect(warning.message).not.toContain("deferred");
		// The exemption is still recorded for the log, just not promised to the user.
		expect(warning.diagnostics.exemption).toMatchObject({ reason: "vouched" });
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(harness.eventsOfType("stall_abort")).toEqual([]);
	});

	it("falls back to the journaled bash handles when the kernel reports no heartbeat", async () => {
		const reads: (number | undefined)[] = [];
		const harness = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0.1 },
					retry: { enabled: false },
				},
				// A protocol-3 kernel: no frames at all, so the only bash fact left is the journal
				// (B4's degraded path, which must engage and must not be silent).
				stallKernelLivenessFacts: () => ({
					protocol: 3,
					rejectedFrames: 0,
					consecutiveRejectedFrames: 0,
					hostRequestCount: 0,
					kernelPid: 4242,
					hasActiveExecution: true,
				}),
				stallJournaledBashHandles: (kernelPid) => {
					reads.push(kernelPid);
					return { liveBashHandles: 2 };
				},
			}),
		);
		await startHungTurn(harness);

		const warning = await waitForEvent(harness, (event) => event.type === "stall_warning");
		if (warning.type !== "stall_warning") throw new Error("unreachable");
		// The read happened when the tool started, so the first warning can already vouch instead
		// of promising an abort that the next sampling would defer.
		expect(reads).toContain(4242);
		expect(warning.message).toContain("deferred");
		expect(warning.diagnostics.exemption).toMatchObject({ reason: "vouched", tier: "liveness" });
		expect(warning.diagnostics.exemption?.reasons).toContain("degraded_journal");
		expect(warning.diagnostics.kernel).toMatchObject({ protocol: 3, liveBashHandles: 2 });
		// An older kernel sending no frames is the expected state, not a finding: the segment
		// reports the facts (protocol, handles) and leaves the reasons empty.
		expect(warning.diagnostics.kernel?.reasons).toEqual([]);

		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(harness.eventsOfType("stall_abort")).toEqual([]);
		// A journal record proves existence only: the short tier, and the fallback is logged.
		expect(
			entries.some((entry) => entry.msg.includes("fell back to journaled bash handles")),
			"the degraded path engaged without saying so",
		).toBe(true);
	});

	it("reads the journal at the stall stage when the heartbeat goes stale mid-turn", async () => {
		const reads: (number | undefined)[] = [];
		let heartbeatAlive = true;
		const harness = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.2, abortAfterSeconds: 0.4 },
					retry: { enabled: false },
				},
				stallKernelLivenessFacts: () => ({
					protocol: 4,
					// Alive: fresh frames, frozen tick, no handles - nothing to vouch with.
					// Stale: the newest frame is a minute old, i.e. twelve of its own intervals.
					latest: sample(
						heartbeatAlive ? { tick: 10 } : { receivedAt: Date.now() - 60_000, tick: 10, intervalMs: 5_000 },
					),
					previous: sample({ receivedAt: Date.now() - 5_000, tick: 10 }),
					rejectedFrames: 0,
					consecutiveRejectedFrames: 0,
					hostRequestCount: 0,
					kernelPid: 4242,
					hasActiveExecution: true,
				}),
				stallJournaledBashHandles: (kernelPid) => {
					reads.push(kernelPid);
					return { liveBashHandles: 1 };
				},
			}),
		);
		await startHungTurn(harness);
		// The kernel stops reporting part-way through the turn: from here the journal is the only
		// source of bash facts, and the stage handler is the only thing left that reads it.
		heartbeatAlive = false;
		expect(reads).toEqual([]);

		await waitForEvent(harness, (event) => event.type === "stall_warning");
		await new Promise((resolve) => setTimeout(resolve, 1_000));

		expect(reads).toContain(4242);
		// The read landed in time for the abort check that follows the warning, so the turn lives.
		expect(harness.eventsOfType("stall_abort")).toEqual([]);
	});

	it("honours the settings kill switch", async () => {
		const harness = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					stallWatchdog: {
						enabled: true,
						warnAfterSeconds: 0.05,
						abortAfterSeconds: 0.1,
						toolLivenessExemption: false,
					},
					retry: { enabled: false },
				},
				stallKernelLivenessFacts: () => workingKernelFacts(),
				stallAbortSettleGraceMs: 0,
			}),
		);
		await startHungTurn(harness);

		// One line of settings is the documented rollback: facts vouch, the watchdog ignores them.
		const abort = await waitForEvent(harness, (event) => event.type === "stall_abort");
		if (abort.type !== "stall_abort") throw new Error("unreachable");
		expect(abort.diagnostics.exemption).toBeUndefined();
	});
});
