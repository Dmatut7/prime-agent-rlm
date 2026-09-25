import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { getProcessStartIdAsync, isProcessIdentityConfirmedDead } from "../src/modes/daemon/daemon-supervisor.js";
import { processIdExists } from "../src/utils/child-process.js";
import { disposeSupervisorHarnesses, startSupervisorHarness } from "./fixtures/supervisor-harness.js";

/**
 * T3-6 / P1-5-L5: a failed worker registration used to survive forever, so every
 * restart replayed the same corpses and the agents view carried rows nobody could
 * act on. The reaper archives one to the daemon log and removes it once it has been
 * failed past the threshold, its process is provably gone, and nothing is scheduled
 * or attached behind it. Deleting a registration is irreversible, so it also stands
 * down entirely while the supervisor is degraded (its inputs are bookkeeping).
 */

const reapableOverrides = (hoursAgo: number) => {
	const when = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
	return { lastFailureAt: when, updatedAt: when };
};

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

async function waitForLogLine(
	harness: { logText: () => string; settle: (ms: number) => Promise<void> },
	needle: string,
	timeoutMs = 15_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const log = harness.logText();
		if (log.includes(needle)) {
			return log;
		}
		await harness.settle(50);
	}
	throw new Error(`Timed out waiting for a log line containing ${JSON.stringify(needle)}. Log:\n${harness.logText()}`);
}

/** chmod cannot deny the superuser, so a read-only fixture is a statement about not being root. */
const runningAsRoot = (): boolean => typeof process.geteuid === "function" && process.geteuid() === 0;

describe("T3-6 failed worker reaper", () => {
	it("archives and removes a failed worker whose process is gone", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-6-reap-",
			deadWorkerPid: true,
			descriptorOverrides: reapableOverrides(25),
			supervisorOptions: { failedWorkerReapIntervalMs: 200 },
		});
		expect(harness.descriptorNames().length).toBeGreaterThan(0);
		await harness.waitForDescriptorLifecycle("failed", 15_000);

		// RED on HEAD: nothing ever removed the registration.
		const log = await waitForLogLine(harness, "Reaped failed worker worker-fixture");
		// C17: the descriptor is the only on-disk evidence of an OOM-class accident,
		// so the archive line carries it before the file goes.
		expect(log).toContain(`pid ${harness.pid}`);
		expect(log).toContain("failedForMinutes 15");
		expect(log).toContain("lastError Waiting for a client with fresh runtime context");
		expect(log).toContain(harness.descriptorPath);
		await harness.waitForDescriptorLifecycle(undefined, 15_000);
		expect(harness.descriptorNames()).not.toContain("worker-fixture.json");
	}, 40_000);

	it("keeps a failed worker that is younger than the threshold", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-6-young-",
			deadWorkerPid: true,
			descriptorOverrides: reapableOverrides(1),
			supervisorOptions: { failedWorkerReapIntervalMs: 200 },
		});
		await harness.waitForDescriptorLifecycle("failed", 15_000);
		await harness.settle(900);
		// Positive control ①: the age threshold is what authorises the delete.
		expect(harness.descriptorNames()).toContain("worker-fixture.json");
		expect(harness.logText()).not.toContain("Reaped failed worker");
	}, 40_000);

	it("keeps a failed worker whose sessions still have a schedule", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-6-scheduled-",
			deadWorkerPid: true,
			scheduledJobsArtifact: true,
			descriptorOverrides: reapableOverrides(25),
			supervisorOptions: { failedWorkerReapIntervalMs: 200, adoptionRetryDelaysMs: [60_000] },
		});
		await harness.waitForDescriptorLifecycle("failed", 15_000);
		await harness.settle(900);
		// Positive control ③: an unattended schedule still needs the tree.
		expect(harness.descriptorNames()).toContain("worker-fixture.json");
		expect(harness.logText()).not.toContain("Reaped failed worker");
	}, 40_000);

	it("warns about a descriptor it cannot use instead of skipping it silently", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-6-junk-",
			descriptorFiles: { "not-a-worker.json": `${JSON.stringify({ version: 2, workerId: "x" })}\n` },
		});
		const log = await waitForLogLine(harness, "Ignoring worker descriptor");
		expect(log).toContain(join(harness.descriptorDir, "not-a-worker.json"));
	}, 40_000);

	it("proves a process is dead twice before authorising a delete", async () => {
		// Positive control ②: a live pid under its own identity is never "dead".
		const live = await startSupervisorHarness({ prefix: "ma-t3-6-identity-" });
		expect(processIdExists(live.pid)).toBe(true);
		const liveStartId = getProcessStartId(live.pid);
		expect(liveStartId).toBeDefined();
		expect(await isProcessIdentityConfirmedDead(live.pid, liveStartId)).toBe(false);
		// A recycled pid (identity belongs to somebody else) counts as dead.
		expect(await isProcessIdentityConfirmedDead(live.pid, "ps:Mon Jan 1 00:00:00 2001")).toBe(true);
		// An unobservable identity counts as alive: never delete on a failed lookup.
		expect(await isProcessIdentityConfirmedDead(live.pid, undefined)).toBe(false);
		// A pid nobody owns is dead.
		expect(await isProcessIdentityConfirmedDead(live.pid + 1_000_000, liveStartId)).toBe(true);
	}, 40_000);

	it("resolves process identity without blocking the event loop", async () => {
		// I-7: the reaper runs periodically, so its identity check must never be an
		// execFileSync on the supervisor's single thread. Judged against the
		// synchronous control in the same process rather than a wall-clock budget:
		// blocking starves the ticker, yielding does not, and a loaded CI worker
		// inflates both sides equally instead of flipping the verdict.
		const live = await startSupervisorHarness({ prefix: "ma-t3-6-async-" });
		const expected = getProcessStartId(live.pid);
		// Positive control for the comparison below: identity really is observable here.
		expect(expected).toBeDefined();

		let ticks = 0;
		const ticker = setInterval(() => {
			ticks += 1;
		}, 1);
		const identities = await Promise.all(Array.from({ length: 12 }, () => getProcessStartIdAsync(live.pid)));
		const ticksWhileAsync = ticks;
		ticks = 0;
		// The same work through the synchronous helper: a tight loop that never yields.
		const syncIdentities = Array.from({ length: 12 }, () => getProcessStartId(live.pid));
		const ticksWhileSync = ticks;
		clearInterval(ticker);

		expect(identities.length).toBeGreaterThan(0);
		for (const identity of identities) {
			expect(identity).toBe(expected);
		}
		// Both implementations must agree, or the async one is not a drop-in identity.
		for (const identity of syncIdentities) {
			expect(identity).toBe(expected);
		}
		expect(ticksWhileSync).toBe(0);
		expect(ticksWhileAsync).toBeGreaterThan(ticksWhileSync);
	}, 40_000);

	it.skipIf(runningAsRoot())(
		"stands down while the supervisor is degraded",
		async () => {
			const harness = await startSupervisorHarness({
				prefix: "ma-t3-6-degraded-",
				deadWorkerPid: true,
				scheduledJobsArtifact: true,
				descriptorOverrides: reapableOverrides(25),
				// A long first backoff so the read-only window is in place before the
				// re-adoption writes its bookkeeping.
				supervisorOptions: { failedWorkerReapIntervalMs: 200, adoptionRetryDelaysMs: [2_000] },
			});
			await waitForLogLine(harness, "Re-adopting worker worker-fixture");
			try {
				// Drop the schedule exemption, then make bookkeeping writes fail: the
				// supervisor keeps running and marks itself degraded, and the reaper must
				// not delete a registration whose inputs it cannot trust (M16).
				rmSync(harness.scheduledJobsArtifactPath(), { force: true });
				chmodSync(harness.descriptorDir, 0o500);
				const degradedLog = await waitForLogLine(harness, "Supervisor degraded: could not persist worker");
				expect(degradedLog).toContain("degraded count: 1");
				const deferred = await waitForLogLine(harness, "Failed-worker reaper deferred while degraded");
				expect(deferred).toContain("worker-fixture");
				expect(harness.descriptorNames()).toContain("worker-fixture.json");
			} finally {
				chmodSync(harness.descriptorDir, 0o700);
			}
		},
		40_000,
	);
	it("marks the crashed root session when it reaps an abnormally dead worker", async () => {
		const markCrashed = vi.spyOn(DaemonCatalogClient.prototype, "markCrashed").mockResolvedValue(true);
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-6-crash-",
			deadWorkerPid: true,
			descriptorOverrides: reapableOverrides(25),
			supervisorOptions: { failedWorkerReapIntervalMs: 200 },
		});
		await harness.waitForDescriptorLifecycle("failed", 15_000);

		const log = await waitForLogLine(harness, "Reaped failed worker worker-fixture");
		expect(log).toContain(`rootSessionId ${harness.session.sessionId}`);
		// The session died with the worker, so the root session file is marked
		// crashed and the agents view parks the row in Idle instead of History.
		await waitForLogLine(harness, "Marked crashed root session");
		expect(markCrashed).toHaveBeenCalledWith(harness.session.sessionFile, harness.session.sessionId);
	}, 40_000);

	it("never marks a crash while a stop was requested, even past the threshold", async () => {
		const markCrashed = vi.spyOn(DaemonCatalogClient.prototype, "markCrashed").mockResolvedValue(true);
		const harness = await startSupervisorHarness({
			prefix: "ma-t3-6-stopreq-",
			deadWorkerPid: true,
			descriptorOverrides: { ...reapableOverrides(25), stopRequestedAt: new Date().toISOString() },
			supervisorOptions: { failedWorkerReapIntervalMs: 200 },
		});
		// A stop request routes the dead worker through the stop finalizer, not the
		// failed-worker reaper, so the descriptor never parks in lifecycle "failed".
		await harness.settle(3_000);
		// An intentional stop owns the registration: neither the reap nor a crash
		// marker may run, so the session keeps its clean History placement.
		expect(harness.logText()).not.toContain("Reaped failed worker");
		expect(harness.logText()).not.toContain("Marked crashed root session");
		expect(markCrashed).not.toHaveBeenCalled();
	}, 40_000);
});
