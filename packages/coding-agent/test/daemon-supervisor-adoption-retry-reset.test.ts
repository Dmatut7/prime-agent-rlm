import { afterEach, describe, expect, it } from "vitest";
import { type FakeWorkerHandle, startFakeWorker } from "./fixtures/supervisor-fake-worker.js";
import {
	disposeSupervisorHarnesses,
	type SupervisorHarness,
	startSupervisorHarness,
} from "./fixtures/supervisor-harness.js";

/**
 * FIX-8b. `adoptionRetryAttempt` only ever grew: a worker whose adoption failed
 * spent backoff slots, and a later successful adoption left the counter where it
 * was. On a supervisor that runs for weeks the next failure episode started with a
 * partly or fully spent budget, so a session with scheduled jobs behind it went
 * dark without the retries it was promised — the episode opened with "stayed failed
 * after N re-adoption attempts" instead of re-adopting.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

const RE_ADOPT_NEEDLE = "Re-adopting worker worker-fixture";

async function waitForReAdoptions(harness: SupervisorHarness, count: number, timeoutMs = 30_000): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const lines = harness
			.logText()
			.split("\n")
			.filter((line) => line.includes(RE_ADOPT_NEEDLE));
		if (lines.length >= count) {
			return lines;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`Timed out waiting for ${count} "${RE_ADOPT_NEEDLE}" lines, saw ${lines.length}. Log:\n${harness.logText()}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("FIX-8b adoption retry budget", () => {
	it("resets the re-adoption backoff once an adoption succeeded", async () => {
		const harness = await startSupervisorHarness({
			prefix: "fix-8-adoption-retry-reset-",
			// The worker answers hello and auth only, so adoption wedges on its next
			// request and fails on the short adoption timeout instead of a 30s connect.
			hangAfterAuth: true,
			scheduledJobsArtifact: true,
			// The recorded start id no longer matches the live stand-in, so the identity
			// reads as replaced: recovery parks the worker failed at once instead of
			// probing a live-but-silent one for minutes, and the scheduled-jobs artifact
			// makes that park arm a backoff re-adoption.
			descriptorOverrides: { processStartId: "fix-8-replaced-start-id" },
			// The first slot is long enough to bring the worker back before it fires and
			// short enough to keep the test quick; the second one must never be needed.
			supervisorOptions: { adoptionRetryDelaysMs: [3_000, 60_000], adoptionRequestTimeoutMs: 400 },
		});
		let healthy: FakeWorkerHandle | undefined;
		try {
			const firstEpisode = await waitForReAdoptions(harness, 1);
			expect(firstEpisode[0]).toContain("(attempt 1/2)");

			// The worker comes back healthy before the armed retry fires, so that retry
			// adopts it — the success the spent budget has to be reset on.
			const socketPath = harness.readDescriptor()?.socketPath;
			if (!socketPath) throw new Error("Descriptor lost its worker socket path");
			await harness.worker?.close();
			healthy = await startFakeWorker({ socketPath, session: harness.session });
			await harness.waitForDescriptorLifecycle("ready", 30_000);

			// Episode two: the process dies and its socket closes, so the supervisor parks
			// the same worker failed again and has to decide whether a slot is left.
			harness.standIn?.child.kill("SIGKILL");
			await healthy.close();
			healthy = undefined;

			const attempts = await waitForReAdoptions(harness, 2);
			// RED on HEAD: the successful adoption left the counter at 1, so this episode
			// opened on the last slot ("(attempt 2/2)") and the next failure gave up.
			expect(attempts[1]).toContain("(attempt 1/2)");
			expect(harness.logText()).not.toContain("stayed failed after");
		} finally {
			await healthy?.close().catch(() => undefined);
		}
	}, 90_000);
});
