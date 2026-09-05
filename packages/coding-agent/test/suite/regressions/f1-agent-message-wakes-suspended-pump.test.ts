/**
 * F1 regression: an agent message queued into a session whose input pump was
 * suspended by requestAbort must wake the pump. Before the fix,
 * queueAgentMessagePrompt went through _queuePreparedPrompt without
 * resumeIfIdle, so the action only woke on a turn boundary or external resume
 * and nothing ever resumed the pump: the queued message sat unprocessed and
 * the child session silently stalled. The TUI steer/follow-up/heartbeat paths
 * already passed resumeIfIdle: true; only the agent-message path lacked it.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	isAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

function createPayload(id: string, message: string): AgentSessionMessagePayload {
	return {
		id,
		source: AGENT_MESSAGE_SOURCE,
		message,
		from: {
			activeSessionId: "parent-active",
			sessionId: "parent-session",
			sessionName: "Parent",
		},
		target: {
			activeSessionId: "child-active",
			sessionId: "child-session",
		},
	};
}

describe("F1 agent message wakes a suspended session input pump", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("resumes the suspended pump and consumes the queued agent message after abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued done"), fauxAssistantMessage("agent message done")]);

		// Visible queued work that survives requestAbort; its external_resume wake
		// never schedules the pump on its own.
		await harness.session.followUp("queued before abort");
		expect(harness.session.getFollowUpMessages()).toEqual(["queued before abort"]);

		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		// Deliver the agent message the same way daemon-mode does:
		// queueIfBusy + streamingBehavior takes the queue branch while the pump is
		// suspended and the session still owns unfinished work.
		const message = createAgentSessionMessage(createPayload("agentmsg_f1_wake", "wake the pump"));
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
		});

		// The queue admission must lift the suspension synchronously.
		expect(harness.session.isQueuedWorkSuspended).toBe(false);
		const idle = await Promise.race([
			harness.session.waitForIdle().then(() => ({ ok: true as const })),
			new Promise<{ ok: false; error: Error }>((resolve) =>
				setTimeout(
					() => resolve({ ok: false, error: new Error("pump stayed suspended; agent message stranded") }),
					2000,
				),
			),
		]);
		expect(idle).toEqual({ ok: true });
		expect(harness.session.queuedActionCount).toBe(0);
		expect(getUserTexts(harness)).toContain("queued before abort");
		expect(harness.session.messages.some((item) => isAgentSessionMessage(item) && item === message)).toBe(true);
		expect(getAssistantTexts(harness)).toEqual(["queued done", "agent message done"]);
	});

	it("does not break the update-restart fence when an agent message is queued", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run"), fauxAssistantMessage("also must not run")]);

		await harness.session.followUp("queued before restart");
		harness.session.abortForUpdateRestart();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		// Queued work must survive into the restart manifest; an agent message may
		// join the queue but must not lift the update-restart suspension.
		const message = createAgentSessionMessage(createPayload("agentmsg_f1_update_restart", "behind the fence"));
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			queueIfBusy: true,
			customMessage: message,
		});

		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual(["queued before restart", message.content]);
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(getAssistantTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(2);
	});

	it("still rejects a direct agent message when suspended with an empty queue", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		// No unfinished work: acceptAgentMessagePrompt falls through to _prompt with
		// resumeIfIdle: false, which must keep failing loudly instead of silently
		// restarting the aborted session.
		const message = createAgentSessionMessage(createPayload("agentmsg_f1_idle", "direct delivery"));
		await expect(
			harness.session.acceptAgentMessagePrompt(message.content, {
				expandPromptTemplates: false,
				streamingBehavior: "steer",
				queueIfBusy: true,
				customMessage: message,
			}),
		).rejects.toThrow("queued session input is suspended");
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
	});
});
