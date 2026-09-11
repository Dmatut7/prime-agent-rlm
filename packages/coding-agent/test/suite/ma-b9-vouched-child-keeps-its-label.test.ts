/**
 * B9 / I-13 on the wire between a parent and its child: a child whose silence the watchdog is
 * excusing must not be reported to its parent as "stalled".
 *
 * The label decision used to read only `child.stallExempted`, i.e. the host-owned phases
 * (compaction, branch summaries, refinement, a UI dialog). The kernel-liveness vouch is a second
 * kind of exemption and it deliberately does not join that getter - a vouch defers the abort while
 * the warning still fires (B2), and `stallExempted` snoozes warnings. So the fact travels with the
 * stall event instead: the exemption segment the watchdog measured at the moment it fired.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
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
		// Live clock: the aggregate judges staleness against Date.now().
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

/** A kernel running a command that produces output: the vouch is active and unspent. */
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

/** A kernel whose loop is blocked with nothing running externally: no vouch, `loop_stalled`. */
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

describe("B9 a vouched child keeps its real label on the parent side", () => {
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

	async function spawnHangingChild(facts: () => TurnLivenessKernelFacts): Promise<{
		parent: Harness;
		child: Harness;
	}> {
		const child = track(
			await createHarness({
				tools: [hangTool],
				settings: {
					// Warn fast, abort never inside the test window: this is about the label, not the kill.
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 60 },
					retry: { enabled: false },
				},
				stallKernelLivenessFacts: facts,
				agentMessageController: {
					listAgents: () => ({ agents: [] }),
					sendAgentMessage: vi.fn(async () => {
						throw new Error("synthesized terminal notices must not use agent_message");
					}),
				},
			}),
		);
		child.setResponses([fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" })]);
		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		void parent.session.runRlmChild("hang inside a tool", { name: "label-worker" });
		await vi.waitFor(
			() => {
				const snapshot = parent.session.getRlmChildSnapshots()[0];
				expect(snapshot?.stall, "the parent never saw the child's stall stage").toBeDefined();
			},
			{ timeout: 15_000, interval: 10 },
		);
		return { parent, child };
	}

	it("reports the excuse with the facts and keeps the child's real activity", async () => {
		const { parent, child } = await spawnHangingChild(workingKernelFacts);

		const snapshot = parent.session.getRlmChildSnapshots()[0];
		expect(snapshot?.stall?.excused).toBe(true);
		expect(snapshot?.stall?.excusedReasons).toContain("live_bash_handles");
		// The forensic record still travels: duration and in-flight tools are the operator's evidence.
		expect(snapshot?.stall?.silentMs).toBeGreaterThan(0);
		expect(snapshot?.stall?.inFlightTools).toContain("hang_forever");
		// ... but the alarm label does not: the child keeps whatever it was really doing.
		expect(snapshot?.activity?.kind).not.toBe("stalled");
		// The child's own published marker agrees, so an attached client and the parent match.
		expect(child.session.stallState?.excused).toBe(true);
	});

	it("still labels a wedged child as stalled", async () => {
		const { parent, child } = await spawnHangingChild(wedgedKernelFacts);

		const snapshot = parent.session.getRlmChildSnapshots()[0];
		expect(snapshot?.activity?.kind).toBe("stalled");
		expect(snapshot?.stall?.excused).toBeUndefined();
		expect(snapshot?.stall?.silentMs).toBeGreaterThan(0);
		expect(child.session.stallState?.excused).toBeUndefined();
	});
});
