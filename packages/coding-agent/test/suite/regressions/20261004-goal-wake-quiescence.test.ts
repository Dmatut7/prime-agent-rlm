/**
 * The throttled persistent-goal wake (`_queueThrottledGoalContinuation`) fired with
 * none of the guards its sibling paths carry (review 2026-10-04, domain 1 should-2):
 * the poll path defers while descendant RLM work is unsettled and the resume path
 * dedups an already-queued goal continuation, but the wake went straight to
 * admission. A wake landing while a delegated child was still running pulled the
 * waiting parent out of its wait for one extra turn and burned a continuation.
 *
 * Red at HEAD: a third goal turn ran while the child was still unsettled.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function track(harness: Harness): Harness {
	harnesses.push(harness);
	return harness;
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 600; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("persistent goal throttle wake vs unsettled subagent work", () => {
	it("holds the throttled wake while a child is unsettled and delivers it after settlement", async () => {
		let releaseChild!: () => void;
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		const child = track(
			await createHarness({
				tools: [
					{
						name: "wait_gate",
						label: "Wait Gate",
						description: "holds the child turn open until released",
						parameters: Type.Object({}),
						execute: async () => {
							await childGate;
							return { content: [{ type: "text" as const, text: "gate passed" }], details: {} };
						},
					},
				],
			}),
		);
		child.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_gate", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("child finished"),
		]);
		const parent = track(
			await createHarness({
				rlmDepth: 0,
				rlmMaxDepth: 1,
				persistentGoalMinContinuationIntervalMs: 800,
				subagentRuntimeHost: {
					createRlmSubagentRuntime: async () => ({ session: child.session }),
					deleteRlmSubagentRuntime: async () => {},
				},
			}),
		);
		parent.setResponses([
			fauxAssistantMessage("work 1"),
			fauxAssistantMessage("work 2"),
			fauxAssistantMessage("work 3 - must wait for the child"),
			fauxAssistantMessage("work 4"),
			fauxAssistantMessage("work 5"),
			fauxAssistantMessage("work 6"),
		]);

		// The goal turn plus its first (never throttled) continuation run; the next
		// continuation is throttled, so the wake is armed for the interval.
		await parent.session.prompt("/goal --persistent keep going");
		await waitForCondition(() => getAssistantTexts(parent).length >= 2, "the first two goal turns");
		await waitForCondition(() => !parent.session.isStreaming, "the run to pause on the throttle");
		expect(getAssistantTexts(parent)).toEqual(["work 1", "work 2"]);

		// Well inside the throttle window the owner delegates: the child turn hangs
		// on its gate, so the parent has unsettled work when the wake fires.
		await parent.session.runRlmChild("hold the gate", { name: "hanger" });
		await waitForCondition(() => parent.session.hasRunningRlmChildren(), "the child to start");

		// Past the interval the wake fires; with the child still unsettled it must
		// defer, not pull the parent out of its wait for one extra turn.
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		expect(getAssistantTexts(parent)).toEqual(["work 1", "work 2"]);

		// The deferral is not a drop: once the child settles, the owed continuation
		// is delivered and the goal heartbeat resumes.
		releaseChild();
		await waitForCondition(() => !parent.session.hasRunningRlmChildren(), "the child to settle");
		await vi.waitFor(
			() => {
				expect(getAssistantTexts(parent).length).toBeGreaterThan(2);
			},
			{ timeout: 10_000, interval: 20 },
		);
	});
});
