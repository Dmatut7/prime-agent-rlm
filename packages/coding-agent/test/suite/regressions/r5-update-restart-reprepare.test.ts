/**
 * R5 regression: an update-restart handoff that prepares successfully but fails
 * to stop the predecessor used to wedge forever. The coordinator's fallback
 * restore runs `create` against the still-`prepared` daemon, which rejects it
 * (mutations are fenced once a checkpoint is prepared), swallows the per-session
 * failures, and still clears the prepared manifest. The next attempt then found
 * the supervisor stuck in phase `prepared` and `prepare_update_restart` threw
 * "already preparing" indefinitely, blocking every later self-update.
 *
 * The fix makes `prepare_update_restart` idempotent while prepared: it re-issues
 * the held checkpoint (re-persisting it) instead of throwing, so a retried
 * handoff can finish. Shutdown stays admitted; ordinary mutations stay fenced.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonCatalogClient } from "../../../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../../../src/modes/daemon/daemon-client.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";

describe("R5 prepared update restart is re-issuable, not wedged", () => {
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

	async function startPreparedSupervisor(): Promise<{
		supervisor: DaemonSupervisor;
		client: DaemonClient;
	}> {
		const root = mkdtempSync(`/tmp/prime-r5-update-restart-${process.pid}-`);
		roots.push(root);
		const socketPath = join(root, "supervisor.sock");
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

	it("re-issues the prepared checkpoint instead of throwing on a retried prepare", async () => {
		const { client } = await startPreparedSupervisor();

		const first = await client.request({ type: "prepare_update_restart" });
		expect(first.success).toBe(true);

		// The handoff stalled: the predecessor is still up in phase `prepared`.
		// Ordinary mutations remain fenced...
		await expect(client.request({ type: "abort", activeSessionId: "missing" })).resolves.toMatchObject({
			error: "Daemon is preparing an update restart",
		});
		// ...but a retried prepare must replay the checkpoint, not wedge.
		const retry = await client.request({ type: "prepare_update_restart" });
		expect(retry).toMatchObject({
			success: true,
			data: { formatVersion: 1, sessions: [] },
		});

		// A re-issued prepare restores the on-disk checkpoint a fallback clear
		// removed, so the next handoff's pending-manifest read sees it again.
		const retryAgain = await client.request({ type: "prepare_update_restart" });
		expect(retryAgain.success).toBe(true);
	});
});
