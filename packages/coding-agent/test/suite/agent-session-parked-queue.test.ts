import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./harness.js";
import { createWaitingHarness } from "./scheduling.js";

// Discussion #1476: a steering message queued mid-turn survives an abort, but the
// abort suspends the input pump, so the queue stays parked while the session sits
// idle. resumeQueuedWork() is the primitive the TUI offers on empty-editor Enter.
describe("aborted turn parks the steering queue", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("preserves the queued steering message and drains it on resumeQueuedWork", { timeout: 20000 }, async () => {
		const { harness, releaseToolExecution, promptPromise, waitForToolStart } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn done"),
			fauxAssistantMessage("steered answer"),
		]);
		await waitForToolStart;
		await harness.session.steer("actually do this instead");
		expect(harness.session.queuedActionCount).toBe(1);

		const abort = harness.session.abort();
		releaseToolExecution();
		await abort;
		await promptPromise.catch(() => {});

		// The abort keeps the message but suspends draining: parked, not delivered.
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(harness.session.queuedActionCount).toBe(1);

		expect(harness.session.resumeQueuedWork()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await harness.session.waitForIdle();
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.isQueuedWorkSuspended).toBe(false);
	});

	it("the connection resume path never lifts the update-restart fence (scan3-queue A8×Q1)", {
		timeout: 20000,
	}, async () => {
		const { harness, releaseToolExecution, promptPromise, waitForToolStart } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn done"),
			fauxAssistantMessage("steered answer"),
		]);
		await waitForToolStart;
		await harness.session.steer("queued before teardown");
		expect(harness.session.queuedActionCount).toBe(1);

		// Teardown for an update restart: the queue must survive into the manifest.
		harness.session.abortForUpdateRestart();
		releaseToolExecution();
		await promptPromise.catch(() => {});
		await harness.session.agent.waitForIdle();
		await harness.session.waitForSessionInputIdle();

		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		// TUI Enter and the daemon resume_queue command both land on the
		// connection-facing primitive; neither may clear the fence or start
		// draining during teardown.
		expect(harness.session.resumeQueuedWorkFromConnection()).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		await harness.session.waitForSessionInputIdle();

		// Once the fence is down again (plain abort clears the update-restart
		// marker), the same connection path drains the parked queue normally.
		harness.session.requestAbort();
		expect(harness.session.resumeQueuedWorkFromConnection()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await harness.session.waitForIdle();
		expect(harness.session.queuedActionCount).toBe(0);
	});
});
