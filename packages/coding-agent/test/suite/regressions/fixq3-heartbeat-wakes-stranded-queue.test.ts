/**
 * FIX-Q3 regression: a visible heartbeat queued while streaming survives
 * requestAbort, but the suspended pump then drains nothing and every later
 * heartbeat tick defers against the same stranded queue forever. The heartbeat
 * deferral point must wake the pump so the queue drains, while the
 * update-restart fence must never be lifted by a heartbeat.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCronJob } from "../../../src/core/cron-jobs.js";
import { shouldDeferHeartbeatCronJob } from "../../../src/core/cron-jobs.js";
import { createHarness, type Harness } from "../harness.js";
import { withStreaming } from "../scheduling.js";

function heartbeatJob(): AgentCronJob {
	return {
		id: "heartbeat-fix-q3",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-test",
		sessionId: "session-test",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "heartbeat check-in",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 0,
	};
}

describe("FIX-Q3 heartbeat wakes a stranded suspended queue", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("wakes the suspended pump on the next tick and drains the stranded heartbeat", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const job = heartbeatJob();
		harness.setResponses([fauxAssistantMessage("heartbeat consumed")]);

		// Queue the heartbeat visibly while streaming; abort keeps visible actions.
		withStreaming(harness, true);
		await harness.session.promptHeartbeat(job, { streamingBehavior: "steer" });
		withStreaming(harness, false);
		expect(harness.session.unfinishedActionCount).toBe(1);

		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		expect(harness.session.unfinishedActionCount).toBe(1);
		// The stranded queue is exactly the state every later tick defers against.
		expect(shouldDeferHeartbeatCronJob(job, harness.session)).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);

		// The heartbeat-tick wake lifts an ordinary abort suspension and drains.
		expect(harness.session.wakeSuspendedSessionInput()).toBe(true);
		expect(harness.session.isQueuedWorkSuspended).toBe(false);
		const idle = await Promise.race([
			harness.session.waitForIdle().then(() => ({ ok: true as const })),
			new Promise<{ ok: false; error: Error }>((resolve) =>
				setTimeout(() => resolve({ ok: false, error: new Error("stranded heartbeat never drained") }), 2000),
			),
		]);
		expect(idle).toEqual({ ok: true });
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("never wakes the pump for a heartbeat during the update-restart fence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const job = heartbeatJob();
		harness.setResponses([fauxAssistantMessage("must not run"), fauxAssistantMessage("fenced steer drained")]);

		harness.session.abortForUpdateRestart();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		// The wake itself refuses the fence.
		expect(harness.session.wakeSuspendedSessionInput()).toBe(false);

		// A heartbeat admission during the fence must not lift the suspension nor
		// start a turn; it stays queued for the restart manifest.
		const pending = harness.session
			.promptHeartbeat(job, { streamingBehavior: "steer" })
			.then(() => "completed")
			.catch(() => "rejected");
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(2);

		// The TUI steer/follow-up wake path (resumeIfIdle admission) must not lift
		// the fence either; the message queues behind it.
		await harness.session.steer("queued behind the fence", undefined, { resumeIfIdle: true });
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		// The heartbeat itself was rejected at the admission fence (suspended):
		// loud failure, retried on the next tick. Only the steer drains on resume.
		await harness.session.resumeQueuedWork();
		await harness.session.waitForIdle();
		await expect(pending).resolves.toBe("rejected");
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
