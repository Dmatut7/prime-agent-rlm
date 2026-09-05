/**
 * R6 regression: the prepared update-restart checkpoint used to live only in the
 * supervisor's memory. If the supervisor died after a successful prepare but
 * before the handoff completed, the replacement process started with no phase and
 * no checkpoint: the intentionally stopped workers had no persisted stop tombstone,
 * so recovery resurrected them, and the next prepare re-prepared from the
 * resurrected state instead of re-issuing the checkpoint.
 *
 * The fix (a) removes the stopped workers' descriptors at commit, persisting stop
 * tombstones so they are not resurrected, and (b) re-enters the prepared phase on
 * startup when an ABANDONED checkpoint is on disk (old enough that the driving
 * coordinator is gone) and no worker descriptors survived, so a retried prepare
 * re-issues the checkpoint.
 *
 * A FRESH checkpoint (one the coordinator is still driving) must NOT re-enter the
 * prepared phase: the coordinator stops the predecessor, starts the successor, and
 * restores into it, so fencing the successor would reject the restore creates.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDaemonUpdateRestartManifestPath } from "../../../src/config.js";
import { DaemonCatalogClient } from "../../../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";

function writeAbandonedManifest(root: string, socketPath: string, ageMs: number): void {
	const manifestPath = getDaemonUpdateRestartManifestPath(socketPath, root);
	mkdirSync(join(root, "daemon-update-restarts"), { recursive: true });
	writeFileSync(
		manifestPath,
		`${JSON.stringify({
			formatVersion: 1,
			createdAt: new Date(Date.now() - ageMs).toISOString(),
			sessions: [
				{
					activeSessionId: "active-1",
					sessionId: "session-1",
					sessionFile: join(root, "session-1.jsonl"),
					cwd: root,
					config: {},
					queue: { actions: { formatVersion: 1, actions: [] }, nextTurn: [] },
					shouldResume: false,
					wasStreaming: false,
					wasCompacting: false,
					wasBashRunning: false,
					hadRunningRlmChildren: false,
					wasRetrying: false,
					hadAcceptedPromptInFlight: false,
				},
			],
		})}\n`,
	);
	// Backdate the file mtime so the checkpoint reads as abandoned.
	const past = (Date.now() - ageMs) / 1000;
	utimesSync(manifestPath, past, past);
}

describe("R6 prepared update restart survives a supervisor restart", () => {
	const cleanups: Array<() => Promise<void>> = [];
	const roots: string[] = [];
	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	async function startSupervisor(
		root: string,
		socketPath: string,
	): Promise<{
		supervisor: DaemonSupervisor;
		client: DaemonClient;
	}> {
		const supervisor = new DaemonSupervisor(socketPath, {
			defaultSessionConfig: { cwd: root, agentDir: root },
			descriptorDir: join(root, "workers"),
		});
		vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue();
		await supervisor.start();
		const client = new DaemonClient(socketPath);
		await client.connect();
		cleanups.push(async () => {
			client.close();
			await Reflect.apply(Reflect.get(supervisor, "cleanupSupervisorResources"), supervisor, []);
		});
		return { supervisor, client };
	}

	it("re-enters the prepared phase from an abandoned checkpoint on startup", async () => {
		const root = mkdtempSync(`/tmp/prime-r6-update-restart-${process.pid}-`);
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");
		// Older than the 5-minute min-age: the driving coordinator is gone.
		writeAbandonedManifest(root, socketPath, 10 * 60_000);

		const { client } = await startSupervisor(root, socketPath);
		const prepare = await client.request({ type: "prepare_update_restart" });
		expect(prepare).toMatchObject({
			success: true,
			data: { formatVersion: 1, sessions: [{ activeSessionId: "active-1" }] },
		});
	});

	it("does not fence a successor started against a fresh checkpoint", async () => {
		const root = mkdtempSync(`/tmp/prime-r6-fresh-${process.pid}-`);
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");
		// Fresh (seconds old): the coordinator is still driving the handoff and
		// will restore into this successor, so it must stay unfenced (a fenced
		// successor would reject the coordinator's restore creates).
		writeAbandonedManifest(root, socketPath, 0);

		const { supervisor, client } = await startSupervisor(root, socketPath);
		// Not re-entered into the prepared phase: mutations stay admitted.
		expect((supervisor as unknown as { updateRestartPhase?: string }).updateRestartPhase).toBeUndefined();
		// A mutation that would be fenced in the prepared phase is admitted here.
		// (create would spawn a worker; use a cheap fenced-in-prepared mutation.)
		const rename = await client.request({
			type: "rename",
			activeSessionId: "missing-session",
			name: "x",
		});
		// Fenced mutations fail with the update-restart error; an admitted one
		// fails with an unknown-session error instead.
		expect(rename).toMatchObject({ success: false });
		if (!rename.success) {
			expect(rename.error).not.toBe("Daemon is preparing an update restart");
		}
	});
});
