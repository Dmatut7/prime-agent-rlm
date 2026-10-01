import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "../harness.js";

// W11-A (boss pain S1, 2026-09-30 x4): a goal the model declares complete used
// to end the run even when the user asked for keep-going work. `/goal
// --persistent` starts a goal that never auto-terminates: goal.complete() is
// rejected and the continuation budget does not apply.

function createFauxIpythonTool(sessionRef: { current?: AgentSession }): AgentTool {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId, params) => {
			const session = sessionRef.current;
			if (!session) throw new Error("test session is not initialized");
			const code = (params as { code: string }).code.trim();
			const spaceIndex = code.indexOf(" ");
			const type = spaceIndex < 0 ? code : code.slice(0, spaceIndex);
			const payload = spaceIndex < 0 ? {} : JSON.parse(code.slice(spaceIndex + 1));
			const text = JSON.stringify(session.handleGoalHostRequest(type, payload));
			return { content: [{ type: "text", text }], details: {} };
		},
	};
}

describe("W11-A persistent goal", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createGoalHarness(): Promise<Harness> {
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({ tools: [createFauxIpythonTool(sessionRef)] });
		sessionRef.current = harness.session;
		harnesses.push(harness);
		return harness;
	}

	it("runs past the continuation budget when the goal is persistent", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage("step one, not done"),
			fauxAssistantMessage("step two, not done"),
			fauxAssistantMessage("step three, not done"),
			fauxAssistantMessage("step four, not done"),
			fauxAssistantMessage("step five, not done"),
			fauxAssistantMessage("step six, not done"),
		]);

		await harness.session.prompt("/goal --persistent keep working until told to stop");

		// A non-persistent goal stops at one initial turn plus three continuations
		// (budget_limited); a persistent goal consumes every queued response. The
		// trailing empty text is the harness's queue-exhausted placeholder, and the
		// terminal "error" status is the same artifact - the point is the goal never
		// hit budget_limited despite five continuations.
		expect(getAssistantTexts(harness).slice(0, 6)).toEqual([
			"step one, not done",
			"step two, not done",
			"step three, not done",
			"step four, not done",
			"step five, not done",
			"step six, not done",
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.goalState.persistent).toBe(true);
		expect(harness.session.goalState.continuationsUsed).toBeGreaterThan(3);
		expect(harness.session.goalState.status).not.toBe("budget_limited");
	});

	it("parses --persistent together with a token budget", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([fauxAssistantMessage("working")]);

		await harness.session.prompt("/goal --persistent --budget 5000 keep the lights on");

		expect(harness.session.goalState).toMatchObject({
			persistent: true,
			tokenBudget: 5000,
			objective: "keep the lights on",
		});
	});

	it("rejects goal.complete on a persistent goal and the run continues", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "goal.complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("claim rejected, still working"),
		]);

		await harness.session.prompt("/goal --persistent never stop");

		// The rejection rides the tool result back to the model and the model
		// continued instead of ending the run; the goal was never completed.
		const toolResults = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => getMessageText(message));
		expect(toolResults.some((text) => text.includes("goal.complete() was rejected"))).toBe(true);
		expect(getAssistantTexts(harness)).toContain("claim rejected, still working");
		expect(harness.session.goalState.persistent).toBe(true);
		expect(harness.session.goalState.status).not.toBe("complete");
		expect(harness.session.goalState.lastReason).not.toBe("Goal achieved");
	});

	it("a non-persistent goal still completes normally (no regression)", async () => {
		const harness = await createGoalHarness();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "goal.complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Goal complete."),
		]);

		await harness.session.prompt("/goal finish the task");

		expect(harness.session.goalState).toMatchObject({ active: false, status: "complete" });
		expect(harness.session.goalState.persistent).toBeUndefined();
	});
});
