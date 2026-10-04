/**
 * wave-40 lane H: the turn-level vouch must recognize the two kinds of silent
 * work the per-step deadline already recognizes, or the daemon sweep (which
 * gates on `session.excusedNow`) interrupts healthy long steps:
 *
 * - a cell blocked in `rlm.collect` on a child that is verifiably alive (its
 *   own recent events, or its own watchdog excusing its silence) — the parent
 *   used to lose its excuse when the host-request age bound (15min) lapsed,
 *   and the sweep killed it ~20 minutes into a healthy child's job;
 * - a synchronous cell whose process tree keeps burning CPU (a quiet compile,
 *   numpy compute) — the kernel loop is frozen so no heartbeat fact can vouch,
 *   and the turn died at the abort threshold (~5.5min) while busy.
 *
 * The per-step deadline (`toolTimeoutVouch`) already treats both as busy; this
 * pins the same judgment for the turn-level watchdog's `excusedNow`, sampled
 * live the way the sweep samples it.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import { StallFakeClock } from "../fixtures/stall-fake-clock.js";
import { createHarness, type Harness, type HarnessOptions } from "./harness.js";

const harnesses: Harness[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

function track(harness: Harness): Harness {
	harnesses.push(harness);
	return harness;
}

/** A child tool that keeps reporting progress for `runMs`, or never returns and never speaks. */
function childTool(runMs: number | "forever"): AgentTool {
	return {
		name: "child_job",
		label: "Child Job",
		description: "A child's long job",
		parameters: Type.Object({}),
		execute: async (_id, _args, _signal, onUpdate) => {
			if (runMs === "forever") return new Promise<never>(() => {});
			const endAt = Date.now() + runMs;
			while (Date.now() < endAt) {
				onUpdate?.({ content: [{ type: "text", text: "progress" }], details: {} });
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return { content: [{ type: "text", text: "child job done" }], details: {} };
		},
	};
}

async function parentWaitingOn(childRunMs: number | "forever"): Promise<{ parent: Harness; child: Harness }> {
	const child = track(
		await createHarness({
			tools: [childTool(childRunMs)],
			settings: { retry: { enabled: false } },
		}),
	);
	child.setResponses([
		fauxAssistantMessage(fauxToolCall("child_job", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("child finished"),
	]);
	let parentSession: AgentSession | undefined;
	// The cell that blocks on rlm.collect: silent by design while the child works.
	const waitTool: AgentTool = {
		name: "wait_child",
		label: "Wait Child",
		description: "Blocks on rlm.collect",
		parameters: Type.Object({}),
		execute: async (_id, _args, signal) => {
			const collected = await parentSession?.collectRlmChildren([], 30_000, signal);
			return {
				content: [{ type: "text", text: `collected ${collected?.results.length ?? 0}` }],
				details: {},
			};
		},
	};
	const parent = track(
		await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			tools: [waitTool],
			settings: { tools: { timeout: { silentStuckSeconds: 1 } } },
			// No kernel facts and no CPU evidence for the parent: nothing but the
			// collect wait itself may vouch for it.
			stallKernelLivenessFacts: () => undefined,
			stepCpuProbe: () => undefined,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		}),
	);
	parentSession = parent.session;
	await parent.session.runRlmChild("do the long job", { name: "worker" });
	parent.setResponses([
		fauxAssistantMessage(fauxToolCall("wait_child", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("parent done"),
	]);
	return { parent, child };
}

describe("turn-level vouch: a collect wait on a live child excuses the parent's silence", () => {
	it("excusedNow holds while the awaited child keeps producing events", async () => {
		const { parent } = await parentWaitingOn(4_000);
		void parent.session.prompt("wait for the worker");
		await vi.waitFor(() => expect(parent.eventsOfType("tool_execution_start")).toHaveLength(1), {
			timeout: 10_000,
			interval: 10,
		});
		// Let the collect wait settle in while the child is mid-job (its events are
		// well inside the 1s quiet window).
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(parent.session.excusedNow).toBe(true);
		// Still excused past the point where the bare silent-step window has passed:
		// the child's activity keeps the wait alive.
		await new Promise((resolve) => setTimeout(resolve, 1_200));
		expect(parent.session.excusedNow).toBe(true);
		await parent.session.waitForIdle();
	});

	it("stops excusing once the awaited child went quiet with no excuse of its own", async () => {
		const { parent } = await parentWaitingOn("forever");
		void parent.session.prompt("wait for the worker");
		await vi.waitFor(() => expect(parent.eventsOfType("tool_execution_start")).toHaveLength(1), {
			timeout: 10_000,
			interval: 10,
		});
		// The child's startup events age out of the 1s quiet window, and its own
		// watchdog has no facts to excuse it: nothing may vouch for the wait now.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(parent.session.excusedNow).toBe(false);
		await parent.session.abort();
		await parent.session.waitForIdle();
	});
});

describe("turn-level vouch: a silent step whose process tree keeps burning CPU is busy", () => {
	function hangTool(): AgentTool {
		return {
			name: "hang_forever",
			label: "Hang Forever",
			description: "A tool that never returns and never prints",
			parameters: Type.Object({}),
			execute: () => new Promise<never>(() => {}),
		};
	}

	async function silentToolSession(
		cpu: () => number | undefined,
		settings?: HarnessOptions["settings"],
	): Promise<Harness> {
		const harness = track(
			await createHarness({
				tools: [hangTool()],
				settings: { retry: { enabled: false }, ...settings },
				// The synchronous-cell shape: no usable kernel heartbeat at all.
				stallKernelLivenessFacts: () => undefined,
				stepCpuProbe: cpu,
			}),
		);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })]);
		void harness.session.prompt("run the quiet compute");
		await vi.waitFor(() => expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1), {
			timeout: 10_000,
			interval: 10,
		});
		return harness;
	}

	it("excusedNow holds while the CPU counter keeps advancing", async () => {
		let cpuMs = 0;
		const harness = await silentToolSession(() => (cpuMs += 5_000));
		// The turn's own events already sampled the vouch a few times, each with a
		// moved counter: the turn reads as busy, not stalled.
		expect(harness.session.excusedNow).toBe(true);
		expect(harness.session.excusedNow).toBe(true);
		await harness.session.abort();
		await harness.session.waitForIdle();
	});

	it("a frozen CPU counter vouches for nothing", async () => {
		const harness = await silentToolSession(() => 1_000);
		expect(harness.session.excusedNow).toBe(false);
		await harness.session.abort();
		await harness.session.waitForIdle();
	});

	it("no CPU evidence at all vouches for nothing either", async () => {
		const harness = await silentToolSession(() => undefined);
		expect(harness.session.excusedNow).toBe(false);
		await harness.session.abort();
		await harness.session.waitForIdle();
	});

	/**
	 * The wall clock, jumped forward on demand: the CPU vouch measures the no-output
	 * span it excuses in wall time, and a test cannot wait out its cap.
	 */
	function jumpableWallClock(): { jump(ms: number): void } {
		const realNow = Date.now;
		let offset = 0;
		vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
		return {
			jump: (ms: number) => {
				offset += ms;
			},
		};
	}

	it("a step advancing less than one quantum per sample keeps a steady vouch instead of flickering", async () => {
		let cpuMs = 0;
		// 500ms of CPU per sample is half the 1000ms quantum: the quantized counter
		// crosses only every other sample, which used to blink the vouch off and on.
		const harness = await silentToolSession(() => (cpuMs += 500));
		for (let i = 0; i < 12; i++) {
			expect(harness.session.excusedNow).toBe(true);
		}
		await harness.session.abort();
		await harness.session.waitForIdle();
	});

	it("stops excusing once CPU evidence alone has stood in for output past its cap", async () => {
		const wall = jumpableWallClock();
		let cpuMs = 0;
		// warnAfter 400s widens the exemption budget past the evidence cap, so the
		// cap — not the budget — is what ends the excuse.
		const harness = await silentToolSession(() => (cpuMs += 5_000), { stallWatchdog: { warnAfterSeconds: 400 } });
		expect(harness.session.excusedNow).toBe(true);
		// The counter keeps advancing the whole time; a busy-loop wedge looks exactly
		// like this, so the evidence may not renew the exemption forever.
		wall.jump(30 * 60_000);
		expect(harness.session.excusedNow).toBe(true);
		wall.jump(31 * 60_000);
		expect(harness.session.excusedNow).toBe(false);
		await harness.session.abort();
		await harness.session.waitForIdle();
	});

	it("observed output restarts the no-output span the CPU cap measures", async () => {
		const wall = jumpableWallClock();
		let cpuMs = 0;
		let emitUpdate: (() => void) | undefined;
		const speakableHangTool: AgentTool = {
			name: "hang_forever",
			label: "Hang Forever",
			description: "A tool that never returns, but can print on demand",
			parameters: Type.Object({}),
			execute: (_id, _args, _signal, onUpdate) => {
				emitUpdate = () => onUpdate?.({ content: [{ type: "text", text: "still computing" }], details: {} });
				return new Promise<never>(() => {});
			},
		};
		const harness = track(
			await createHarness({
				tools: [speakableHangTool],
				settings: { retry: { enabled: false }, stallWatchdog: { warnAfterSeconds: 400 } },
				stallKernelLivenessFacts: () => undefined,
				stepCpuProbe: () => (cpuMs += 5_000),
			}),
		);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })]);
		void harness.session.prompt("run the quiet compute");
		await vi.waitFor(() => expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1), {
			timeout: 10_000,
			interval: 10,
		});

		wall.jump(50 * 60_000);
		expect(harness.session.excusedNow).toBe(true);
		// The step produced output: the no-output span starts over from here.
		emitUpdate?.();
		wall.jump(50 * 60_000);
		expect(harness.session.excusedNow).toBe(true);
		wall.jump(11 * 60_000);
		expect(harness.session.excusedNow).toBe(false);
		await harness.session.abort();
		await harness.session.waitForIdle();
	});

	it("a step whose tree keeps burning CPU is aborted once the CPU evidence cap is spent", async () => {
		const clock = new StallFakeClock();
		const wall = jumpableWallClock();
		let cpuMs = 0;
		const harness = track(
			await createHarness({
				tools: [hangTool()],
				settings: {
					retry: { enabled: false },
					stallWatchdog: { enabled: true, warnAfterSeconds: 60, abortAfterSeconds: 120 },
				},
				stallWatchdogTimers: clock.timersImpl,
				stallKernelLivenessFacts: () => undefined,
				stepCpuProbe: () => (cpuMs += 5_000),
			}),
		);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })]);
		void harness.session.prompt("run the quiet compute");
		await vi.waitFor(() => expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1), {
			timeout: 10_000,
			interval: 10,
		});

		// The warning fires on schedule even while the CPU vouch defers the abort.
		clock.advance(60_000);
		expect(harness.eventsOfType("stall_warning")).toHaveLength(1);
		expect(harness.eventsOfType("stall_abort")).toHaveLength(0);

		// Past the cap the vouch withdraws, and the next escalation fire aborts the turn.
		wall.jump(62 * 60_000);
		clock.advance(61_000);
		expect(harness.eventsOfType("stall_abort")).toHaveLength(1);
		await harness.session.waitForIdle();
	});
});
