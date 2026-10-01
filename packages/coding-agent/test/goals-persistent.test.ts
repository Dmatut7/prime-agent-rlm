import { describe, expect, it } from "vitest";
import {
	createGoalContextMessage,
	emptyGoalState,
	type GoalState,
	goalContinuationLimit,
	goalHostResponse,
	isPersistedGoalState,
	MAX_GOAL_CONTINUATIONS,
	normalizeGoalState,
	parseGoalPersistentFlag,
	persistentGoalCompletionRejection,
} from "../src/core/goals.js";

function activeGoal(overrides: Partial<GoalState> = {}): GoalState {
	return {
		...emptyGoalState(),
		active: true,
		status: "active",
		goalId: "goal-1",
		objective: "keep the deployment healthy",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("parseGoalPersistentFlag", () => {
	it("strips a leading --persistent token", () => {
		expect(parseGoalPersistentFlag("--persistent keep the site fresh")).toEqual({
			persistent: true,
			rest: "keep the site fresh",
		});
	});

	it("leaves objective text without the flag untouched", () => {
		expect(parseGoalPersistentFlag("keep the site fresh")).toEqual({
			persistent: false,
			rest: "keep the site fresh",
		});
	});

	it("does not mistake a --persistent prefix inside another token for the flag", () => {
		expect(parseGoalPersistentFlag("--persistentfoo")).toEqual({ persistent: false, rest: "--persistentfoo" });
	});

	it("composes with the budget flag that follows it", () => {
		expect(parseGoalPersistentFlag("--persistent --budget 100 foo")).toEqual({
			persistent: true,
			rest: "--budget 100 foo",
		});
	});
});

describe("goalContinuationLimit", () => {
	it("caps a finite goal at MAX_GOAL_CONTINUATIONS", () => {
		expect(goalContinuationLimit(activeGoal())).toBe(MAX_GOAL_CONTINUATIONS);
		expect(goalContinuationLimit(emptyGoalState())).toBe(MAX_GOAL_CONTINUATIONS);
	});

	it("lifts the continuation cap for a persistent goal", () => {
		expect(goalContinuationLimit(activeGoal({ persistent: true }))).toBeGreaterThan(MAX_GOAL_CONTINUATIONS);
	});
});

describe("persistent goal state bookkeeping", () => {
	it("preserves the persistent flag through normalization", () => {
		expect(normalizeGoalState(activeGoal({ persistent: true })).persistent).toBe(true);
		expect(normalizeGoalState(activeGoal()).persistent).toBeUndefined();
	});

	it("round-trips the persistent flag through the persistence guard", () => {
		expect(isPersistedGoalState(activeGoal({ persistent: true }))).toBe(true);
		expect(isPersistedGoalState(activeGoal())).toBe(true);
		expect(isPersistedGoalState({ ...activeGoal(), persistent: "yes" })).toBe(false);
	});

	it("serializes the flag for the kernel only when the goal is persistent", () => {
		const persistent = goalHostResponse(activeGoal({ persistent: true }), false);
		expect(persistent.goal).toMatchObject({ persistent: true });
		const finite = goalHostResponse(activeGoal(), false);
		expect(finite.goal && "persistent" in finite.goal).toBe(false);
	});
});

describe("persistentGoalCompletionRejection", () => {
	it("tells the model the goal stays active and only the user ends it", () => {
		const message = persistentGoalCompletionRejection(activeGoal({ persistent: true }));
		expect(message).toContain("persistent");
		expect(message).toContain("/goal clear");
		expect(message).toMatch(/keep working|continue/i);
	});
});

describe("persistent goal continuation prompt", () => {
	it("tells the model the goal cannot be completed by declaring it done", () => {
		const message = createGoalContextMessage(activeGoal({ persistent: true }), "continuation");
		expect(typeof message.content).toBe("string");
		const text = message.content as string;
		expect(text.toLowerCase()).toContain("persistent");
		expect(text).toContain("/goal clear");
		expect(text).not.toContain("run `await goal.complete()`");
	});

	it("keeps the goal.complete() instruction for a finite goal", () => {
		const message = createGoalContextMessage(activeGoal(), "continuation");
		expect(message.content as string).toContain("run `await goal.complete()`");
	});
});
