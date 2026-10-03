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
import { createHarness, type Harness } from "./harness.js";

const harnesses: Harness[] = [];

afterEach(() => {
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

	async function silentToolSession(cpu: () => number | undefined): Promise<Harness> {
		const harness = track(
			await createHarness({
				tools: [hangTool()],
				settings: { retry: { enabled: false } },
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
});
