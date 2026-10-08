/**
 * W8 ledger items 1.7 + 1.10: the tool-not-found breaker's terminal failure must
 * not kill an active goal as an unrecoverable error.
 *
 * The breaker ends a run with a classified terminal error (stopReason "error",
 * stopReasonRaw "tool_not_found_breaker_tripped") once the per-run recovery
 * budget is spent. agent_end then hands the message to
 * _finishGoalForTerminalAssistantMessage, which used to route it to
 * _finishGoalWithError: the goal landed in status "error", which /goal resume
 * silently refuses (it accepts only paused/budget_limited), so the terminal
 * message's own guidance ("switch the session to another model ... before
 * resuming") was unexecutable - an unattended persistent goal needed a full
 * rebuild. The fix parks the goal instead (status "paused", the same
 * recoverable state other failures use), so a model switch followed by
 * /goal resume continues the same goal with its accounting intact.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("W8 1.7/1.10 breaker terminal keeps the goal recoverable", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("parks the goal when the breaker budget is spent, and /goal resume revives it", async () => {
		// Retry enabled keeps the session's queue driving the goal continuation
		// turns (the same shape the quota-park goal tests rely on).
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		// Nine scripted garbage turns: per w11c C1 the trip lands on the eighth
		// model call with the ninth never consumed.
		harness.setResponses(
			Array.from({ length: 9 }, () => fauxAssistantMessage([fauxToolCall("rlm", {})], { stopReason: "toolUse" })),
		);

		await harness.session.prompt("/goal finish the task");
		await harness.session.waitForIdle();

		// The breaker's terminal error must read as a recoverable pause, not the
		// goal's death: the run ended because the model kept hallucinating tool
		// names, which a model switch repairs.
		const last = harness.session.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("expected the terminal assistant message");
		expect(last.stopReasonRaw).toBe("tool_not_found_breaker_tripped");
		expect(harness.session.goalState.status).toBe("paused");
		expect(harness.session.goalState.active).toBe(false);
		expect(harness.session.goalState.objective).toBe("finish the task");
		expect(harness.session.goalState.lastReason).toContain("tool-not-found breaker");

		// A paused goal is resumable: /goal resume revives it and the next
		// continuation completes it.
		const completeGoal = (): AssistantMessage => {
			harness.session.handleGoalHostRequest("goal.complete", {});
			return fauxAssistantMessage("Goal complete.");
		};
		harness.setResponses([completeGoal]);
		await harness.session.prompt("/goal resume");
		await harness.session.waitForIdle();
		expect(harness.session.goalState.status).toBe("complete");
	});
});
