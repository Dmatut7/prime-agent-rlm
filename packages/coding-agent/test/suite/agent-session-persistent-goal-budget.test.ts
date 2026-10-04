import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PERSISTENT_GOAL_TOKEN_BUDGET, normalizeGoalState } from "../../src/core/goals.js";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

/**
 * wave-40 secondary: a persistent goal started without a token budget used to run
 * with no ceiling at all - the continuation cap is lifted for persistent goals by
 * design, and with tokenBudget unset the budget accounting never engaged either,
 * so a forgotten keep-going goal burned provider spend unbounded and unthrottled.
 * A persistent goal now carries a visible default budget (stamped at creation and
 * on load), and its continuations are spaced by a minimum interval: a too-early
 * continuation is not dropped, it is scheduled for when the interval elapses.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("persistent goal without an explicit budget", () => {
	it("stamps the visible default budget at creation", async () => {
		const harness = await createHarness({ persistentGoalMinContinuationIntervalMs: 60_000 });
		harnesses.push(harness);
		// The start continuation and one follow-up turn; the throttle holds the next.
		harness.setResponses([fauxAssistantMessage("working"), fauxAssistantMessage("still working")]);

		await harness.session.prompt("/goal --persistent keep the lights on");
		await waitForCondition(() => !harness.session.isStreaming, "the goal turns to settle");

		expect(harness.session.goalState).toMatchObject({
			status: "active",
			persistent: true,
			tokenBudget: DEFAULT_PERSISTENT_GOAL_TOKEN_BUDGET,
		});
	});

	it("stamps the default budget when a legacy budget-less persistent goal loads", () => {
		const loaded = normalizeGoalState({
			active: true,
			status: "active",
			objective: "legacy",
			tokensUsed: 10,
			timeUsedSeconds: 5,
			continuationsUsed: 2,
			persistent: true,
		});
		expect(loaded.tokenBudget).toBe(DEFAULT_PERSISTENT_GOAL_TOKEN_BUDGET);

		// An explicit budget is never rewritten, and a plain goal stays uncapped by it.
		const explicit = normalizeGoalState({
			active: true,
			status: "active",
			objective: "budgeted",
			tokenBudget: 1234,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			persistent: true,
		});
		expect(explicit.tokenBudget).toBe(1234);
		const plain = normalizeGoalState({
			active: true,
			status: "active",
			objective: "plain",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		});
		expect(plain.tokenBudget).toBeUndefined();
	});

	it("spaces continuations by the minimum interval instead of spinning", async () => {
		const harness = await createHarness({ persistentGoalMinContinuationIntervalMs: 400 });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("work 1"),
			fauxAssistantMessage("work 2"),
			fauxAssistantMessage("work 3"),
			fauxAssistantMessage("work 4"),
		]);

		await harness.session.prompt("/goal --persistent keep going");
		// The goal-context turn plus one immediate continuation run; the next
		// continuation is throttled, so the run stops at two answers.
		await waitForCondition(() => getAssistantTexts(harness).length >= 2, "the first two goal turns");
		await waitForCondition(() => !harness.session.isStreaming, "the run to pause on the throttle");
		expect(getAssistantTexts(harness)).toHaveLength(2);

		// Well inside the interval nothing new fires; once it elapses, the held
		// continuation wakes the session by itself.
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(getAssistantTexts(harness)).toHaveLength(2);
		await waitForCondition(
			() => getAssistantTexts(harness).length >= 3,
			"the throttled continuation to fire after the interval",
		);

		await harness.session.prompt("/goal clear");
		expect(harness.session.goalState.status).toBe("idle");
	});
});

describe("persistent goal throttle lifecycle", () => {
	it("starts a new goal without the previous goal's throttle clock", async () => {
		// Review 2026-10-04 new issue 3: _startGoal never reset
		// _goalContinuationLastAt, so a goal started right after another inherited
		// the old clock and its first continuation was throttled by up to the full
		// interval.
		const harness = await createHarness({ persistentGoalMinContinuationIntervalMs: 60_000 });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

		await harness.session.prompt("/goal --persistent first goal");
		await waitForCondition(() => getAssistantTexts(harness).length >= 2, "the first goal's two turns");
		await waitForCondition(() => !harness.session.isStreaming, "the first goal to pause on the throttle");
		expect(getAssistantTexts(harness)).toEqual(["one", "two"]);

		await harness.session.prompt("/goal clear");
		harness.setResponses([fauxAssistantMessage("three"), fauxAssistantMessage("four")]);
		await harness.session.prompt("/goal --persistent second goal");

		// The second goal's first continuation fires immediately: with the stale
		// clock it would sit out the whole 60s interval.
		await waitForCondition(() => getAssistantTexts(harness).length >= 4, "the second goal's first continuation");
		expect(getAssistantTexts(harness)).toEqual(["one", "two", "three", "four"]);
	});

	it("Esc disarms the armed throttle wake instead of letting it continue the goal", async () => {
		// Review 2026-10-04 new issue 3: the throttled continuation's wake timer was
		// only cleared in dispose(), so after Esc the wake still fired and the
		// parked goal continuation ran behind the owner's back.
		const harness = await createHarness({ persistentGoalMinContinuationIntervalMs: 400 });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("work 1"),
			fauxAssistantMessage("work 2"),
			fauxAssistantMessage("work 3 - must not run after Esc"),
		]);

		await harness.session.prompt("/goal --persistent keep going");
		await waitForCondition(() => getAssistantTexts(harness).length >= 2, "the first two goal turns");
		await waitForCondition(() => !harness.session.isStreaming, "the run to pause on the throttle");
		expect(getAssistantTexts(harness)).toHaveLength(2);

		// Esc while the wake is armed.
		harness.session.requestAbort({ reason: "user" });

		// Well past the interval: the armed wake must not fire the held continuation.
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(getAssistantTexts(harness)).toHaveLength(2);
	});
});
