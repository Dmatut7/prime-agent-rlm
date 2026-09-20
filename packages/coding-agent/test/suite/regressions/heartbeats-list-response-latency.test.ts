import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCronJobStore } from "../../../src/core/cron-jobs.js";
import * as sessionManager from "../../../src/core/session-manager.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import { createHarness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

const harnesses: Array<{ cleanup: () => void }> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function createSupervisorHarness() {
	const harness = await createHarness();
	harnesses.push(harness);
	const directory = harness.tempDir;
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as {
		defaultSessionConfig: { agentDir: string };
		rlmSpawnLedger: DaemonSupervisor["rlmSpawnLedger"];
		handleCommand: DaemonSupervisor["handleCommand"];
		broadcastHeartbeatsChanged: DaemonSupervisor["broadcastHeartbeatsChanged"];
		invalidatePassiveScheduledJobs: DaemonSupervisor["invalidatePassiveScheduledJobs"];
		passiveScheduledJobs?: { rows: unknown[]; scannedAt: number };
	};
}

type Supervisor = Awaited<ReturnType<typeof createSupervisorHarness>>;

function listHeartbeats(supervisor: Supervisor, id: string) {
	return supervisor.handleCommand({} as never, { id, type: "heartbeats_list" });
}

function heartbeatIds(response: Awaited<ReturnType<Supervisor["handleCommand"]>>): string[] {
	const rows = (response as { data?: { heartbeats?: Array<{ job: { id: string } }> } })?.data?.heartbeats;
	return (rows ?? []).map((heartbeat) => heartbeat.job.id);
}

describe("heartbeats_list response latency", () => {
	it("serves heartbeats_list from one shared snapshot scan and rescans only on invalidation", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = sessionManager.SessionManager.create(directory, join(directory, "sessions"));
		manager.newSession();
		manager.flushNow();
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
		const job = store.createHeartbeat({
			activeSessionId: manager.getSessionId(),
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			cwd: directory,
			scheduleText: "every 1h",
			prompt: "continue",
		}).id;
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");

		// Concurrent cold lists share ONE scan: this is the amplification that used to
		// push the last of N catalog requests past the client's 30s transport deadline,
		// because each request enqueued its own full saved-session scan.
		const responses = await Promise.all(["1", "2", "3", "4", "5"].map((id) => listHeartbeats(supervisor, id)));
		expect(responses.map(heartbeatIds)).toEqual([[job], [job], [job], [job], [job]]);
		expect(family).toHaveBeenCalledTimes(1);

		// The snapshot serves the next list without touching the disk again.
		expect(heartbeatIds(await listHeartbeats(supervisor, "6"))).toEqual([job]);
		expect(family).toHaveBeenCalledTimes(1);

		// A daemon-owned mutation drops the snapshot, so the next list sees the change
		// immediately instead of after the refresh TTL. A paused heartbeat is still
		// armed, so it stays in the catalog; a stopped one leaves it. (The scan count is
		// not asserted here: broadcastHeartbeatsChanged also arms the scheduled-session
		// wake recompute, which takes its own fresh scan and publishes it.)
		store.manageHeartbeat(manager.getSessionId(), job, "pause");
		supervisor.broadcastHeartbeatsChanged();
		expect(heartbeatIds(await listHeartbeats(supervisor, "7"))).toEqual([job]);

		store.manageHeartbeat(manager.getSessionId(), job, "stop");
		supervisor.broadcastHeartbeatsChanged();
		expect(heartbeatIds(await listHeartbeats(supervisor, "8"))).toEqual([]);

		// Fork pin: invalidation must not restore the per-request scan. This fork has one
		// more broadcastHeartbeatsChanged caller than upstream (the worker -> supervisor
		// heartbeats_changed relay), so heartbeat churn invalidates more often here; five
		// concurrent lists after an invalidation still cost at most one shared list scan
		// plus the wake recompute's own. Before this change the same batch cost five.
		supervisor.broadcastHeartbeatsChanged();
		const beforeBurst = family.mock.calls.length;
		const afterChurn = await Promise.all(["a", "b", "c", "d", "e"].map((id) => listHeartbeats(supervisor, id)));
		expect(afterChurn.map(heartbeatIds)).toEqual([[], [], [], [], []]);
		expect(family.mock.calls.length - beforeBurst).toBeLessThanOrEqual(2);
	});

	it("keeps serving bounded-stale rows while an aged snapshot refreshes in the background", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = sessionManager.SessionManager.create(directory, join(directory, "sessions"));
		manager.newSession();
		manager.flushNow();
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
		const job = store.createHeartbeat({
			activeSessionId: manager.getSessionId(),
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			cwd: directory,
			scheduleText: "every 1h",
			prompt: "continue",
		}).id;
		const family = vi.spyOn(supervisor.rlmSpawnLedger(), "family");
		expect(heartbeatIds(await listHeartbeats(supervisor, "warm"))).toEqual([job]);
		expect(family).toHaveBeenCalledTimes(1);

		// An external artifact write (another process) is what the refresh TTL exists for.
		// Age the snapshot past it: the response must stay immediate - served from the
		// snapshot rather than queueing behind a rescan - while the refresh converges in
		// the background. Dropping the aged snapshot instead would put every list that
		// arrives during the refresh back on the serialized scan.
		store.manageHeartbeat(manager.getSessionId(), job, "stop");
		supervisor.passiveScheduledJobs = { rows: supervisor.passiveScheduledJobs?.rows ?? [], scannedAt: 0 };
		expect(heartbeatIds(await listHeartbeats(supervisor, "stale"))).toEqual([job]);
		expect(family).toHaveBeenCalledTimes(2);

		await vi.waitFor(async () => {
			expect(heartbeatIds(await listHeartbeats(supervisor, "converged"))).toEqual([]);
		});
	});

	it("refuses to publish a scan that lost the epoch race", async () => {
		const supervisor = await createSupervisorHarness();
		const directory = realpathSync(supervisor.defaultSessionConfig.agentDir);
		const manager = sessionManager.SessionManager.create(directory, join(directory, "sessions"));
		manager.newSession();
		manager.flushNow();
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact(manager.getSessionId(), manager.getSessionArtifactDir()!);
		const job = store.createHeartbeat({
			activeSessionId: manager.getSessionId(),
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			cwd: directory,
			scheduleText: "every 1h",
			prompt: "continue",
		}).id;
		const ledger = supervisor.rlmSpawnLedger();
		const scanStarted = createDeferred();
		const releaseScan = createDeferred<void>();
		// Scan A stalls on the ledger family read and comes back with an empty topology,
		// i.e. rows that predate what the daemon now knows. Scan B, started after an
		// invalidation, sees the real family.
		vi.spyOn(ledger, "family").mockImplementationOnce(async () => {
			scanStarted.resolve();
			await releaseScan.promise;
			return [];
		});

		const racedList = listHeartbeats(supervisor, "raced");
		await scanStarted.promise;
		supervisor.invalidatePassiveScheduledJobs();

		// The invalidation detached the shared scan, so this list rescans (scan B) instead
		// of adopting A's in-flight promise, and B publishes the real row.
		expect(heartbeatIds(await listHeartbeats(supervisor, "fresh"))).toEqual([job]);

		// A settles last and must not overwrite B's snapshot: without the publish epoch,
		// every later catalog response would drop the armed heartbeat until the next
		// invalidation or refresh TTL.
		releaseScan.resolve();
		expect(heartbeatIds(await racedList)).toEqual([]);
		expect(heartbeatIds(await listHeartbeats(supervisor, "after"))).toEqual([job]);
	});
});
