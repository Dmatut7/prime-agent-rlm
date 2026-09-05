/**
 * R7: wait_for_headless_completion is classified read-only, but its autonomous
 * gate-continuation loop prompts the session (a mutation). During an
 * update-restart handoff the daemon passes shouldStopGateContinuations so the
 * mutating continuation stops and the wait finishes with the current status
 * instead of racing the checkpoint.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { AgentAutonomousStatus } from "../src/core/autonomous.js";
import { waitForHeadlessCompletion } from "../src/modes/headless-completion.js";

function failingGateStatus(): AgentAutonomousStatus {
	return {
		enabled: true,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		limits: { maxContinuations: 10, maxTurns: 10, maxTokens: 100000, timeoutMs: 60000 },
		gates: { commands: ["npm test"], maxRetries: 5, timeoutMs: 1000 },
		gateAttempts: {},
		lastGateFailure: { command: "npm test", attempt: 1, exitText: "exit 1", output: "failed" },
	};
}

function createFakeSession(): { session: AgentSession; prompt: ReturnType<typeof vi.fn> } {
	const prompt = vi.fn(async () => {});
	const session = {
		waitForHeadlessIdle: vi.fn(async () => {}),
		waitForRlmQuiescence: vi.fn(async () => {}),
		getAutonomousStatus: vi.fn(() => failingGateStatus()),
		recordHostAutonomousContinuation: vi.fn(),
		prompt,
		waitForIdle: vi.fn(async () => {}),
		refreshAutonomousGates: vi.fn(async () => {}),
		state: { messages: [] },
	} as unknown as AgentSession;
	return { session, prompt };
}

describe("R7 headless completion gate continuations stop during handoff", () => {
	it("does not prompt and returns the current status when told to stop", async () => {
		const { session, prompt } = createFakeSession();
		const status = await waitForHeadlessCompletion(session, {
			shouldStopGateContinuations: () => true,
		});
		expect(prompt).not.toHaveBeenCalled();
		expect(status.lastGateFailure).toBeDefined();
	});

	it("still prompts when no stop is requested", async () => {
		const { session, prompt } = createFakeSession();
		// Let the first continuation run, then make the gate pass so the loop exits.
		let calls = 0;
		(session.getAutonomousStatus as ReturnType<typeof vi.fn>).mockImplementation(() => {
			calls += 1;
			if (calls === 1) return failingGateStatus();
			return { ...failingGateStatus(), lastGateFailure: undefined };
		});
		await waitForHeadlessCompletion(session, { shouldStopGateContinuations: () => false });
		expect(prompt).toHaveBeenCalledTimes(1);
	});
});
