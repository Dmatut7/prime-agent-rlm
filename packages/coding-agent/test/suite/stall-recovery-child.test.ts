/**
 * The session-side contract of the child stall-recovery action (r4
 * recovery-shell, mechanism ③): the daemon sweep's exact call sequence, driven
 * against a real wedged session - queue the system instruction, abort and send,
 * resume - plus the parent-facing receipt and the re-dispatch facts it carries.
 *
 * The daemon's policy (windows, claims, stop line) is pinned in
 * test/daemon-stall-recovery.test.ts; this file pins what that policy depends
 * on: the sequence is "abort and send" (the instruction becomes the next turn's
 * input, not parked queue state), the message text tells the model it was not
 * the user, and the receipt's pasteable line carries the real run facts.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CustomMessage,
	convertToLlm,
	createRlmChildRecoveryActionMessage,
	createSystemInterruptionMessage,
	RLM_CHILD_RECOVERY_ACTION_CUSTOM_TYPE,
	SYSTEM_INTERRUPTION_CUSTOM_TYPE,
} from "../../src/core/messages.js";
import { StallFakeClock } from "../fixtures/stall-fake-clock.js";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

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

function messagesOfType(messages: readonly unknown[], customType: string): CustomMessage[] {
	return messages.filter(
		(message): message is CustomMessage =>
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "custom" &&
			(message as { customType?: unknown }).customType === customType,
	);
}

describe("the child stall-recovery action, driven as the daemon drives it", () => {
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

	async function wedgedChild() {
		const clock = new StallFakeClock();
		const child = track(
			await createHarness({
				tools: [hangTool()],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0 },
					retry: { enabled: false },
				},
				stallWatchdogTimers: clock.timersImpl,
			}),
		);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("hang_forever", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("recovered with a changed approach"),
		]);
		void child.session.prompt("hang inside a tool");
		await vi.waitFor(
			() => {
				expect(child.eventsOfType("tool_execution_start")).toHaveLength(1);
			},
			{ timeout: 10_000, interval: 10 },
		);
		// Drive the watchdog to its warn stage: the stall marker the sweep keys on.
		clock.advance(WARN_AFTER_MS);
		await vi.waitFor(
			() => {
				expect(child.eventsOfType("stall_warning")).toHaveLength(1);
			},
			{ timeout: 10_000, interval: 10 },
		);
		return { child, clock };
	}

	it("aborts the wedged turn and delivers the system instruction as the next turn's input", async () => {
		const { child } = await wedgedChild();
		const stall = child.session.stallState;
		expect(stall).toBeDefined();

		const notice = createSystemInterruptionMessage({
			trigger: "stall_recovery",
			isChild: true,
			silentMs: stall?.silentMs ?? 0,
			thresholdMs: stall?.thresholdMs ?? 0,
			inFlightTools: stall?.inFlightTools ?? [],
			excused: stall?.excused === true,
			executor: "daemon",
		});
		// The daemon's sequence, verbatim: queue first, abort second.
		await child.session.sendCustomMessage(notice, { deliverAs: "followUp" });
		// The abort reason is visible synchronously: the terminal classifier reads
		// it before the recovery turn's agent_start clears it.
		child.session.abortAndSendQueued({ reason: "stall_recovery" });
		expect(child.session.lastTurnAbortReason).toBe("stall_recovery");
		child.session.resumeQueuedWork();

		await vi.waitFor(
			() => {
				// The recovery turn ran: the model answered through the instruction.
				expect(getAssistantTexts(child).some((text) => text.includes("recovered with a changed approach"))).toBe(
					true,
				);
			},
			{ timeout: 10_000, interval: 10 },
		);
		// "abort and send": the instruction is in the transcript and reaches the
		// provider as user-role input - not parked queue state.
		const interruption = messagesOfType(child.session.messages, SYSTEM_INTERRUPTION_CUSTOM_TYPE);
		expect(interruption).toHaveLength(1);
		expect(interruption[0]?.content).toContain("NOT a user Esc");
		expect(interruption[0]?.content).toContain("subagent");
		const llmMessages = convertToLlm(child.session.messages);
		expect(
			llmMessages.some(
				(message) => message.role === "user" && JSON.stringify(message.content).includes("NOT a user Esc"),
			),
		).toBe(true);
		// The turn ended cleanly after the recovery: not stuck, not streaming.
		await vi.waitFor(
			() => {
				expect(child.session.isStreaming).toBe(false);
			},
			{ timeout: 10_000, interval: 10 },
		);
	});

	it("degrades to a plain abort when the queue cannot deliver (idempotent sequence)", async () => {
		const { child } = await wedgedChild();
		// No notice queued this time: abortAndSendQueued has no steering to send,
		// so it degrades to the abort and the session stops - exactly the "no
		// queue" arm of the sweep's action.
		child.session.abortAndSendQueued({ reason: "stall_recovery" });
		await vi.waitFor(
			() => {
				expect(child.session.isStreaming).toBe(false);
			},
			{ timeout: 10_000, interval: 10 },
		);
		expect(messagesOfType(child.session.messages, SYSTEM_INTERRUPTION_CUSTOM_TYPE)).toHaveLength(0);
	});

	it("the receipt carries the run's real re-dispatch facts as a pasteable line", async () => {
		// A plain child (no pre-prompted turn): the run's own task is what wedges
		// it, so the child holds exactly the run's queue state at cleanup.
		const child = track(
			await createHarness({
				tools: [hangTool()],
				settings: {
					stallWatchdog: { enabled: true, warnAfterSeconds: 0.05, abortAfterSeconds: 0 },
					retry: { enabled: false },
				},
				stallWatchdogTimers: new StallFakeClock().timersImpl,
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
		const handle = await parent.session.runRlmChild("restate the original task", { name: "long-worker" });
		const childId = handle.rlm_child_id ?? parent.session.getRlmChildSnapshots()[0]?.id;
		expect(childId).toBeDefined();

		const candidate = parent.session.getRlmChildRerouteCandidate(childId!);
		expect(candidate).toMatchObject({
			prompt: "restate the original task",
			model: expect.stringContaining("/"),
			sessionName: "long-worker",
		});

		const receipt = createRlmChildRecoveryActionMessage({
			childId: childId!,
			sessionName: candidate?.sessionName ?? "long-worker",
			executor: "daemon",
			action: "abort_and_send",
			at: Date.now(),
			silentMs: 312_000,
			thresholdMs: 300_000,
			inFlightTools: ["hang_forever"],
			escalateAfterMs: 15 * 60_000,
			...(candidate ? { reDispatch: candidate } : {}),
		});
		expect(receipt.customType).toBe(RLM_CHILD_RECOVERY_ACTION_CUSTOM_TYPE);
		expect(receipt.content).toContain("No automatic re-dispatch");
		expect(receipt.content).toContain('await rlm("""restate the original task""", name="long-worker-retry"');
		expect(receipt.content).toContain(candidate?.model ?? "");
	});

	it("the receipt without a live run asks the parent to restate the task (retained child)", () => {
		const receipt = createRlmChildRecoveryActionMessage({
			childId: "child-9",
			sessionName: "retained-worker",
			executor: "daemon",
			action: "abort_and_send",
			at: Date.now(),
			silentMs: 312_000,
			thresholdMs: 300_000,
			inFlightTools: [],
			escalateAfterMs: 15 * 60_000,
		});
		expect(receipt.content).toContain("restate the original task");
		expect(receipt.content).not.toContain('await rlm("""');
	});

	it("a prompt with embedded triple quotes cannot break the pasteable line out of its literal", () => {
		const receipt = createRlmChildRecoveryActionMessage({
			childId: "child-9",
			sessionName: "quote-worker",
			executor: "daemon",
			action: "abort_and_send",
			at: Date.now(),
			silentMs: 312_000,
			thresholdMs: 300_000,
			inFlightTools: [],
			escalateAfterMs: 15 * 60_000,
			reDispatch: { prompt: 'do """things""" now', model: "faux/mini", sessionName: "quote-worker" },
		});
		// Every triple-quote run is neutralized, so the line stays one string
		// literal when pasted into a Python REPL.
		expect(receipt.content).not.toContain('"""things"""');
	});
});
