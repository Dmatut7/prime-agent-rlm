import { afterEach, describe, expect, it } from "vitest";
import { disposeSupervisorHarnesses, startSupervisorHarness } from "./fixtures/supervisor-harness.js";

/**
 * T3-3 / P1-5-L3: adoption used to sit on the ready critical path and any single
 * worker that could not be adopted failed the whole daemon start. Adoption now runs
 * in the background after `markReady()`, one unadoptable worker parks failed on its
 * own, `daemon_hello.adopting` publishes what is still in flight, and a session with
 * scheduled jobs behind it is re-adopted on a backoff instead of going dark.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

async function waitForLogLine(
	logText: () => string,
	needle: string,
	timeoutMs = 15_000,
	settle: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const log = logText();
		if (log.includes(needle)) {
			return log;
		}
		await settle(50);
	}
	throw new Error(`Timed out waiting for a log line containing ${JSON.stringify(needle)}. Log:\n${logText()}`);
}

describe("T3-3 supervisor startup adoption", () => {
	it("serves clients while a wedged worker is still being adopted", async () => {
		const startedAt = Date.now();
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-3-wedged-",
			hangAfterAuth: true,
			supervisorOptions: { adoptionRequestTimeoutMs: 8_000 },
		});
		const elapsedMs = Date.now() - startedAt;

		// RED on HEAD: start() awaited adoption, so the socket only opened after the
		// wedged worker's request timed out, and hello carried no adopting count.
		expect(elapsedMs).toBeLessThan(3_000);
		expect(harness.hello?.adopting).toBe(1);
		// The supervisor answers commands while adoption is still in flight.
		const list = await harness.request({ type: "list" });
		expect(list.success).toBe(true);
		expect(harness.readDescriptor()?.lifecycle).not.toBe("ready");
	}, 30_000);

	it("lists a registered session as recovering while its worker is still being adopted", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-3-window-",
			hangAfterAuth: true,
			supervisorOptions: { adoptionRequestTimeoutMs: 8_000 },
		});
		// The adoption window is genuinely open: the worker is wedged, nothing settled.
		expect(harness.hello?.adopting).toBe(1);
		const descriptor = harness.readDescriptor();
		expect(descriptor?.lifecycle).not.toBe("ready");

		// RED before the startup roster seed: handleList builds rows only from roster
		// entries that adoption itself writes, so a client that listed right after a
		// restart saw zero sessions until adoption settled - a restart that actually
		// preserved every worker still looked like losing all of them.
		const sessions = await harness.listSessions();
		expect(sessions.length).toBeGreaterThan(0);
		const row = sessions.find((summary) => summary.workerPid === descriptor?.pid);
		expect(row?.workerPid).toBe(descriptor?.pid);
		expect(row?.workerState).toBe("recovering");
		// One row per registered session: the seed must not duplicate what adoption writes.
		expect(sessions.filter((summary) => summary.sessionId === row?.sessionId)).toHaveLength(1);
	}, 30_000);

	it("reports no pending adoption once every worker landed", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-t3-3-healthy-" });
		// Positive control: the healthy adoption path is unchanged.
		await harness.waitForDescriptorLifecycle("ready");
		const settled = await harness.connectClient();
		expect(settled.hello.adopting).toBeUndefined();
		expect(settled.hello.degraded).toBeUndefined();
		const sessions = await harness.listSessions();
		expect(sessions.length).toBeGreaterThan(0);
		expect(sessions.some((summary) => summary.workerState === "ready")).toBe(true);
		settled.client.close();
	}, 30_000);

	it("bounds an adoption request instead of waiting on the worker forever", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-3-bound-",
			hangAfterAuth: true,
			supervisorOptions: { adoptionRequestTimeoutMs: 400 },
		});
		// The bound fires in well under the 30s worker-request default, and the worker
		// is handed to recovery instead of wedging startup.
		const log = await waitForLogLine(
			() => harness.logText(),
			"Timed out waiting for daemon worker response to worker_subscribe",
			5_000,
			harness.settle,
		);
		expect(log).toContain("Could not adopt worker worker-fixture");
		await harness.waitForDescriptorLifecycle("recovering", 5_000);
		// Once the adoption lane finishes, a new client is not told anything is pending.
		await harness.settle(200);
		const settled = await harness.connectClient();
		expect(settled.hello.adopting).toBeUndefined();
		settled.client.close();
	}, 30_000);

	it("reports the sessions it could not restore at startup", async () => {
		const harness = await startSupervisorHarness({ prefix: "ma-t3-3-report-", deadWorkerPid: true });
		// M12①: a start that no longer fails loudly has to say what stayed down.
		const log = await waitForLogLine(() => harness.logText(), "Daemon started with 1 session unrestored", 15_000);
		expect(log).toContain(harness.session.sessionId);
		expect(log).toContain("retry_worker");
		await harness.waitForDescriptorLifecycle("failed", 15_000);
	}, 30_000);

	it("re-adopts a failed worker whose sessions have scheduled jobs", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-3-scheduled-",
			deadWorkerPid: true,
			scheduledJobsArtifact: true,
			supervisorOptions: { adoptionRetryDelaysMs: [150, 200] },
		});
		// M12②: parking an unattended session would silently stop its heartbeat, so it
		// is re-adopted on a backoff first, and says so when the backoff runs out.
		const reAdopting = await waitForLogLine(() => harness.logText(), "Re-adopting worker worker-fixture", 15_000);
		expect(reAdopting).toContain("scheduled jobs");
		const exhausted = await waitForLogLine(
			() => harness.logText(),
			"stayed failed after 2 re-adoption attempts",
			15_000,
		);
		expect(exhausted).toContain("scheduled sessions stay dark");
		expect(harness.supervisor.isDegraded).toBe(true);
		const settled = await harness.connectClient();
		expect(settled.hello.degraded).toBe(true);
		settled.client.close();
	}, 30_000);

	it("parks a failed worker without scheduled jobs and does not re-adopt it", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-3-unscheduled-",
			deadWorkerPid: true,
			supervisorOptions: { adoptionRetryDelaysMs: [150, 200] },
		});
		await waitForLogLine(() => harness.logText(), "Daemon started with 1 session unrestored", 15_000);
		await harness.waitForDescriptorLifecycle("failed", 15_000);
		// Positive control for the backoff: nothing scheduled behind it, nothing re-armed.
		await harness.settle(700);
		expect(harness.logText()).not.toContain("Re-adopting worker worker-fixture");
		expect(harness.supervisor.isDegraded).toBe(false);
	}, 30_000);
});
