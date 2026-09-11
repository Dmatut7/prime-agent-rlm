/**
 * P1-6: "the abort fired but the run never settled" must be its own signal.
 *
 * Red at HEAD: `_handleStallWatchdogStage` emitted the abort_unsettled stage as a
 * second `stall_warning`, so the event面 could not distinguish "looks stuck" from
 * "killed and still running", and the parent side kept no trace at all (the
 * subscription had no branch for any stall event).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CustomMessage, RLM_CHILD_FAILURE_CUSTOM_TYPE } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

function hangTool(): AgentTool {
	return {
		name: "hang_forever",
		label: "Hang Forever",
		description: "A tool that never returns",
		parameters: Type.Object({}),
		execute: () => new Promise<never>(() => {}),
	};
}

function failures(messages: readonly unknown[]): CustomMessage[] {
	return messages.filter(
		(message): message is CustomMessage =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === RLM_CHILD_FAILURE_CUSTOM_TYPE,
	);
}

describe("P1-6 parent sees a child stall that never settled", () => {
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

	it("emits stall_unsettled once, leaves a parent-side trace, and classifies the run as killed", async () => {
		const child = track(
			await createHarness({
				tools: [hangTool()],
				// Grace 0 makes the watchdog report the unsettled abort as soon as the
				// abort stage's turn fails to settle, instead of after the default 10s.
				stallAbortSettleGraceMs: 0,
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0.1 },
					retry: { enabled: false },
				},
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

		await parent.session.runRlmChild("hang inside a tool", { name: "wedged-worker" });

		await vi.waitFor(
			() => {
				expect(child.eventsOfType("stall_unsettled")).toHaveLength(1);
			},
			{ timeout: 15_000, interval: 20 },
		);
		// "改发不是加发": the warn stage keeps its single warning, the unsettled
		// stage does not masquerade as a second one.
		expect(child.eventsOfType("stall_warning")).toHaveLength(1);
		expect(child.eventsOfType("stall_abort")).toHaveLength(1);
		expect(child.session.stallState?.unsettled).toBe(true);

		// Parent-side trace: the run carries the unsettled fact and an error, so the
		// roster row and the terminal classifier both see a kill rather than a
		// completed child.
		await vi.waitFor(
			() => {
				const snapshots = parent.session.getRlmChildSnapshots();
				expect(snapshots.length).toBeGreaterThan(0);
				expect(snapshots[0]?.stall?.unsettled).toBe(true);
				expect(snapshots[0]?.error).toContain("did not settle");
			},
			{ timeout: 15_000, interval: 20 },
		);

		await vi.waitFor(
			() => {
				expect(failures(parent.session.messages)).toHaveLength(1);
			},
			{ timeout: 15_000, interval: 20 },
		);
		const failure = failures(parent.session.messages)[0]!;
		expect(failure.details).toMatchObject({ kind: "stall_killed" });
		const stall = (failure.details as { stall?: { unsettled?: boolean } }).stall;
		expect(stall?.unsettled).toBe(true);
	});

	it("leaves no stall trace on a child that completes normally", async () => {
		const child = track(
			await createHarness({
				stallAbortSettleGraceMs: 0,
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 5, abortAfterSeconds: 10 },
					retry: { enabled: false },
				},
				agentMessageController: {
					listAgents: () => ({ agents: [] }),
					sendAgentMessage: vi.fn(async () => {
						throw new Error("synthesized terminal notices must not use agent_message");
					}),
				},
			}),
		);
		child.setResponses([fauxAssistantMessage("finished cleanly")]);
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

		await parent.session.runRlmChild("finish cleanly", { name: "clean-worker" });
		await vi.waitFor(
			() => {
				expect(parent.session.hasRunningRlmChildren()).toBe(false);
			},
			{ timeout: 15_000, interval: 20 },
		);

		expect(child.eventsOfType("stall_unsettled")).toEqual([]);
		expect(child.eventsOfType("stall_warning")).toEqual([]);
		const activities = parent.eventsOfType("rlm_child_update").map((event) => event.child.activity?.kind);
		expect(activities).not.toContain("stalled");
		const snapshots = parent.session.getRlmChildSnapshots();
		expect(snapshots.length).toBeGreaterThan(0);
		expect(snapshots.every((snapshot) => snapshot.stall === undefined)).toBe(true);
	});
});
