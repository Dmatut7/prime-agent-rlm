/**
 * F1 regression, revised by P0-3a/P0-3b.
 *
 * Original contract: an agent message queued into a session whose input pump was
 * suspended by requestAbort had to wake the pump, because nothing else ever
 * resumed it and the child silently stalled.
 *
 * Revised contract (C2 甲变体 + B3): queueing no longer starts a turn by itself -
 * an Esc has to keep meaning "stop" - but the message is still admitted, still
 * visible in the queue, still durable, and still delivered by the next wake
 * (user input, attach, resumeQueuedWork, or the aggregated failure wake). The
 * pre-fix bug (stranded forever, nothing resumes the pump) stays fixed: this file
 * pins both halves - "not refused" and "not stranded" - plus the settings lever
 * that restores the old wake-on-queue behaviour.
 *
 * The update-restart fence is unchanged: queued work must survive into the
 * restart manifest instead of starting a turn during teardown.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	isAgentSessionMessage,
} from "../../../src/core/agent-messages.js";
import { SessionInputSuspendedError } from "../../../src/core/prompt-admission.js";
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

describe("F1 agent message into a suspended session input pump", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("queues instead of refusing when suspended with an empty queue, and drains on the next wake", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("agent message done")]);
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		// Red at HEAD: this threw "Cannot admit a session action while queued session
		// input is suspended.", which read to the sending model as "cannot be sent".
		const message = createAgentSessionMessage(createPayload("agentmsg_f1_idle", "direct delivery"));
		let queued: boolean | undefined;
		let queuedReason: string | undefined;
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
			preflightResult: (success, didQueue, reason) => {
				expect(success).toBe(true);
				queued = didQueue === true;
				queuedReason = reason;
			},
		});

		expect(queued).toBe(true);
		expect(queuedReason).toBe("target_suspended");
		// Esc still means stop: no turn was started by the queueing itself.
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		expect(getAssistantTexts(harness)).toEqual([]);
		// ...and the message is not stranded: it is visible in the queue.
		expect(harness.session.getSteeringMessages()).toEqual([message.content]);

		// The next wake delivers it, which is the half F1 was originally about.
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toEqual(["agent message done"]), {
			timeout: 5_000,
			interval: 20,
		});
		expect(harness.session.messages.some((item) => isAgentSessionMessage(item) && item === message)).toBe(true);
	});

	it("still wakes the pump on queue when the wake policy is 'always'", async () => {
		const harness = await createHarness({ settings: { subagentWake: { policy: "always" } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued done"), fauxAssistantMessage("agent message done")]);

		await harness.session.followUp("queued before abort");
		expect(harness.session.getFollowUpMessages()).toEqual(["queued before abort"]);
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		const message = createAgentSessionMessage(createPayload("agentmsg_f1_wake", "wake the pump"));
		await harness.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
		});

		// The rollback lever: one settings key restores the pre-P0-3b behaviour.
		expect(harness.session.isQueuedWorkSuspended).toBe(false);
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toEqual(["queued done", "agent message done"]), {
			timeout: 5_000,
			interval: 20,
		});
		expect(harness.session.queuedActionCount).toBe(0);
		expect(getUserTexts(harness)).toContain("queued before abort");
	});

	it("does not break the update-restart fence when an agent message is queued", async () => {
		const harness = await createHarness({ settings: { subagentWake: { policy: "always" } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run"), fauxAssistantMessage("also must not run")]);

		await harness.session.followUp("queued before restart");
		harness.session.abortForUpdateRestart();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		// Queued work must survive into the restart manifest; an agent message may
		// join the queue but must not lift the update-restart suspension - not even
		// under the "always" policy, which is the mutation this case pins.
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

	it("reports suspension as a typed, non-retryable-behind-the-fence error for non-queueing callers", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.abortForUpdateRestart();

		// A caller that cannot queue (no streamingBehavior) still gets a hard error,
		// but a typed one that says whether retrying could ever help.
		const error = await harness.session
			.acceptAgentMessagePrompt("direct delivery", { expandPromptTemplates: false })
			.then(
				() => undefined,
				(thrown: unknown) => thrown,
			);
		expect(error).toBeInstanceOf(SessionInputSuspendedError);
		if (!(error instanceof SessionInputSuspendedError)) throw new Error("unreachable");
		expect(error.message).toContain("queued session input is suspended");
		expect(error.suspendedForUpdateRestart).toBe(true);
		expect(error.retryable).toBe(false);
		expect(error.queuedActionCount).toBe(0);
	});
});
