import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { launchDaemonUpdateRestartCoordinator } from "../src/cli/daemon-update-restart.js";
import { DAEMON_SUPERVISOR_RELAUNCH_ENV, DAEMON_WORKER_ROLE_ENV } from "../src/modes/daemon/daemon-worker-protocol.js";

/**
 * The update-restart coordinator restarts the daemon as a deliberate start. A
 * caller inside a relaunched supervisor's subtree carries the worker-relaunch
 * marker in its environment; letting it leak into the coordinator child (and from
 * there into anything the coordinator spawns) would make a deliberate start read
 * as a worker-driven relaunch — refused by a tombstoned socket, and never lifting
 * the tombstone. The spawn boundary scrubs it like the worker and restart spawns.
 */

const spawnState = vi.hoisted(() => ({
	captured: [] as Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
			spawnState.captured.push({ command, args, env: { ...(options.env ?? {}) } });
			// A child that exits at once: the launcher reports the exit instead of
			// waiting out its progress timeout, and the captured env is the assertion.
			const child = Object.assign(new EventEmitter(), { unref: () => {} }) as unknown as ChildProcess;
			process.nextTick(() => {
				child.emit("exit", 1, null);
			});
			return child;
		},
	};
});

describe("daemon update restart coordinator environment", () => {
	const roots: string[] = [];

	afterEach(() => {
		while (roots.length > 0) {
			rmSync(roots.pop()!, { recursive: true, force: true });
		}
		delete process.env[DAEMON_SUPERVISOR_RELAUNCH_ENV];
		delete process.env[DAEMON_WORKER_ROLE_ENV];
		delete process.env.W19B3_SENTINEL;
		spawnState.captured.length = 0;
	});

	it("scrubs the worker-relaunch marker from the coordinator spawn", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "update-restart-env-"));
		roots.push(agentDir);
		process.env[DAEMON_SUPERVISOR_RELAUNCH_ENV] = "1";
		process.env[DAEMON_WORKER_ROLE_ENV] = "worker";
		process.env.W19B3_SENTINEL = "kept";

		await expect(
			launchDaemonUpdateRestartCoordinator({
				socketPath: join(agentDir, "daemon.sock"),
				agentDir,
				timeoutMs: 5_000,
			}),
		).rejects.toThrow(/coordinator exited/);

		expect(spawnState.captured.length).toBeGreaterThan(0);
		const env = spawnState.captured[0]!.env;
		expect(env[DAEMON_SUPERVISOR_RELAUNCH_ENV]).toBeUndefined();
		expect(env[DAEMON_WORKER_ROLE_ENV]).toBeUndefined();
		// Positive control: the environment is otherwise inherited as-is.
		expect(env.W19B3_SENTINEL).toBe("kept");
	});
});
