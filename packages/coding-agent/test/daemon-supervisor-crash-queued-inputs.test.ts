import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { disposeSupervisorHarnesses, startSupervisorHarness } from "./fixtures/supervisor-harness.js";

/**
 * 崩溃时丢排队消息（review-fixup 2026-10-04）: the supervisor's crash recovery
 * used to read only the dead worker's *busy* journal records, so a session that
 * was idle, Esc-paused or quota-parked at the crash lost its queued user inputs
 * even though the journal on disk carried them. This drives the real path: a
 * descriptor whose process was really killed, a real journal file on disk, the
 * supervisor's own adoption and recovery, and the catalog boundary the
 * interruption marker crosses.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

describe("daemon supervisor crash recovery of parked queued inputs", () => {
	it("marks a non-busy session's queued inputs interrupted after the worker process is killed", async () => {
		const markInterrupted = vi.spyOn(DaemonCatalogClient.prototype, "markInterrupted").mockResolvedValue(undefined);
		const queuedInputs = ["把剩下的测试修完", "顺手看下 lint"];
		const crashedAt = new Date().toISOString();
		const harness = await startSupervisorHarness({
			prefix: "prime-crash-queued-inputs-",
			deadWorkerPid: true,
			recoveryJournalRecords: (session) => [
				// The worker's last checkpoint for the session: a finished turn (idle,
				// Esc-paused or quota-parked) with user inputs still parked in the
				// queue. The crash handler's flush is the last write; the process is
				// dead by the time the supervisor reads this.
				{
					version: 1,
					activeSessionId: session.activeSessionId,
					sessionId: session.sessionId,
					sessionFile: session.sessionFile,
					busy: false,
					operation: "turn_end",
					queuedInputs,
					recordedAt: crashedAt,
				},
			],
		});

		// The park path runs the journal resolution before stamping the descriptor,
		// so reaching failed means the marker decision has already been made.
		await harness.waitForDescriptorLifecycle("failed", 15_000);

		expect(markInterrupted).toHaveBeenCalledOnce();
		expect(markInterrupted).toHaveBeenCalledWith(
			harness.session.sessionFile,
			harness.session.activeSessionId,
			["turn_end"],
			queuedInputs,
			// The last checkpoint time rides along as the crash-time lower bound.
			crashedAt,
		);
	}, 40_000);

	it("marks nothing for a killed worker whose journal shows neither in-flight work nor a parked queue", async () => {
		const markInterrupted = vi.spyOn(DaemonCatalogClient.prototype, "markInterrupted").mockResolvedValue(undefined);
		const harness = await startSupervisorHarness({
			prefix: "prime-crash-idle-journal-",
			deadWorkerPid: true,
			recoveryJournalRecords: (session) => [
				{
					version: 1,
					activeSessionId: session.activeSessionId,
					sessionId: session.sessionId,
					sessionFile: session.sessionFile,
					busy: false,
					operation: "turn_end",
					recordedAt: new Date().toISOString(),
				},
			],
		});

		await harness.waitForDescriptorLifecycle("failed", 15_000);

		// Negative control: an idle session with an empty queue earns no marker.
		expect(markInterrupted).not.toHaveBeenCalled();
	}, 40_000);
});
