/**
 * #2426 (upstream e2fb7bfa1, "send queued messages after interrupt") - the session half.
 *
 * The merge took this commit's protocol, connection and session halves but resolved the
 * interactive Esc hunk back to `abort()`, which left `abort_and_send_queued` with no producer in
 * the shipping path (final-review seat B, B3-01). Wiring the Esc path back is only honest if the
 * command's own semantics are pinned, and on this branch they were not: upstream's test for it
 * (ENG-5991, in `test/suite/agent-session-queue.test.ts`) was not taken either, so
 * `AgentSession.abortAndSendQueued()` had zero coverage here.
 *
 * Pinned, in this fork's own harness:
 *   - an interrupt with human steering queued delivers every queued steering message in ONE new
 *     turn (the one-shot forced "all" batch) instead of leaving them for the next submit;
 *   - machine traffic queued after the interrupt is not swept into that batch;
 *   - `steeringMode` is never changed by the interrupt;
 *   - both abort-only edges: an empty visible steering queue (a follow-up waiting in its own lane
 *     does not make it non-empty - the lane still outranks priority, r39 QP-4), and an
 *     update-restart suspension, which must stay suspended because resuming there would let work
 *     start during teardown.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getAssistantTexts, getUserTexts, type Harness } from "../harness.js";
import { createWaitingHarness } from "../scheduling.js";

describe("#2426 abort_and_send_queued carries the queued steering out with the interrupt", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("delivers every queued steering message in one new turn", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("queued handled"),
			fauxAssistantMessage("later handled"),
		]);
		await waitForToolStart;
		await harness.session.steer("first");
		await harness.session.steer("second");
		expect(harness.session.getSteeringMessages()).toEqual(["first", "second"]);
		expect(harness.session.steeringMode).toBe("one-at-a-time");

		// This is the call the Esc path makes: it arms a one-shot "all" batch over exactly the
		// queued user steering rows and aborts the run, so the pump delivers them together.
		expect(harness.session.abortAndSendQueued()).toBe(true);
		// The batch is one-shot: the session's own mode is never changed by the interrupt.
		expect(harness.session.steeringMode).toBe("one-at-a-time");

		// Machine traffic queued after the interrupt is not part of that batch.
		await harness.session.steer("later", undefined, { priority: "background" });

		releaseToolExecution();
		await promptPromise.catch(() => {});
		await harness.session.agent.waitForIdle();
		await harness.session.waitForSessionInputIdle();

		// Both queued messages reached the model in one turn (one assistant reply covers the two
		// of them), and the background arrival got a turn of its own afterwards.
		expect(getUserTexts(harness)).toEqual(["start", "first", "second", "later"]);
		// Three replies for four user messages: the aborted "start" turn (""), ONE reply over
		// "first" + "second" (the forced batch), and one over "later". A one-at-a-time drain
		// would need a fourth reply, so this array is what pins "in one new turn".
		expect(getAssistantTexts(harness)).toEqual(["", "queued handled", "later handled"]);
	});

	it("stays abort-only when nothing visible is queued, and leaves a follow-up in its own lane", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("reply"),
		]);
		await waitForToolStart;

		// Empty queue: the interrupt is a plain abort and reports that it sent nothing.
		expect(harness.session.abortAndSendQueued()).toBe(false);

		// A queued follow-up does not make the steering lane non-empty: the lane outranks
		// priority (r39 QP-4), so the interrupt must not drag it into a steering turn.
		await harness.session.followUp("follow-up boundary");
		expect(harness.session.abortAndSendQueued()).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual(["follow-up boundary"]);

		releaseToolExecution();
		await promptPromise.catch(() => {});
		await harness.session.agent.waitForIdle();
		await harness.session.waitForSessionInputIdle();
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("leaves an update-restart suspension alone", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("reply"),
		]);
		await waitForToolStart;

		harness.session.clearQueue();
		harness.session.resumeQueuedWork();
		await harness.session.steer("queued for restart");
		harness.session.abortForUpdateRestart();

		// The restart window suspended admission on purpose; an interrupt must not resume it.
		expect(harness.session.abortAndSendQueued()).toBe(false);
		expect(harness.session.getSteeringMessages()).toEqual(["queued for restart"]);
		// This fork's fence is an admission pause lease (r39 QP-2), not upstream's suspended
		// flag, so the refusal names the lease and its update-restart holder.
		await expect(
			harness.session.sendCustomMessage({ customType: "g", content: "t", display: false }, { triggerTurn: true }),
		).rejects.toThrow("session input admission is paused");

		releaseToolExecution();
		await promptPromise.catch(() => {});
		await harness.session.agent.waitForIdle();
		await harness.session.waitForSessionInputIdle();
		expect(harness.session.getSteeringMessages()).toEqual(["queued for restart"]);
	});
});
