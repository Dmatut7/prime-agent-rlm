import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireDaemonSupervisorOwnership,
	DaemonShutdownTombstonedError,
	readDaemonShutdownTombstone,
	recordDaemonShutdownTombstone,
} from "../src/modes/daemon/daemon-supervisor-ownership.js";

/**
 * The shutdown tombstone is the durable half of the shutdown admission: the
 * admission speaks while a shutdown runs, the tombstone speaks after it, so a
 * worker-driven relaunch can never resurrect a deliberately stopped daemon.
 * These tests pin the record's lifecycle directly; the end-to-end resurrection
 * race is pinned by test/suite/regressions/4603-worker-recovery.test.ts.
 */

const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop()!, { recursive: true, force: true });
	}
});

function makeRoot(): { root: string; registryDir: string; socketPath: string } {
	const root = mkdtempSync(join(tmpdir(), "shutdown-tombstone-"));
	roots.push(root);
	return { root, registryDir: join(root, "registry"), socketPath: join(root, "daemon.sock") };
}

function acquireOptions(root: string, socketPath: string, registryDir: string) {
	return {
		agentDir: root,
		appVersion: "test",
		descriptorDir: join(root, "workers"),
		generation: "test-generation",
		registryDir,
		socketPath,
	};
}

describe("daemon shutdown tombstone", () => {
	it("round-trips a record keyed by the normalized socket path", () => {
		const { registryDir, socketPath } = makeRoot();
		recordDaemonShutdownTombstone(socketPath, registryDir);

		const tombstone = readDaemonShutdownTombstone(socketPath, registryDir);
		expect(tombstone?.socketPath).toBe(socketPath);
		expect(tombstone?.pid).toBe(process.pid);
		expect(Number.isNaN(Date.parse(tombstone?.stoppedAt ?? ""))).toBe(false);
	});

	it("reads as absent when there is no record, the record names another socket, or the file is garbage", () => {
		const { root, registryDir, socketPath } = makeRoot();
		expect(readDaemonShutdownTombstone(socketPath, registryDir)).toBeUndefined();

		recordDaemonShutdownTombstone(socketPath, registryDir);
		expect(readDaemonShutdownTombstone(join(root, "other.sock"), registryDir)).toBeUndefined();

		const dir = join(registryDir, "shutdown-tombstones");
		for (const name of readdirSync(dir)) {
			writeFileSync(join(dir, name), "not json");
		}
		expect(readDaemonShutdownTombstone(socketPath, registryDir)).toBeUndefined();
	});

	it("refuses a worker-driven relaunch over a tombstoned socket and keeps the tombstone", async () => {
		const { root, registryDir, socketPath } = makeRoot();
		recordDaemonShutdownTombstone(socketPath, registryDir);

		await expect(
			acquireDaemonSupervisorOwnership({ ...acquireOptions(root, socketPath, registryDir), relaunch: true }),
		).rejects.toThrowError(DaemonShutdownTombstonedError);
		expect(readDaemonShutdownTombstone(socketPath, registryDir)).toBeDefined();
		expect(existsSync(join(registryDir, "test-generation.owner"))).toBe(false);
	});

	it("lets a relaunch through when the socket was never tombstoned", async () => {
		const { root, registryDir, socketPath } = makeRoot();
		const ownership = await acquireDaemonSupervisorOwnership({
			...acquireOptions(root, socketPath, registryDir),
			relaunch: true,
		});
		await ownership.release();
	});

	it("lifts the tombstone when a deliberate start acquires ownership", async () => {
		const { root, registryDir, socketPath } = makeRoot();
		recordDaemonShutdownTombstone(socketPath, registryDir);

		const ownership = await acquireDaemonSupervisorOwnership(acquireOptions(root, socketPath, registryDir));
		expect(readDaemonShutdownTombstone(socketPath, registryDir)).toBeUndefined();
		await ownership.release();

		// Crash recovery is restored with the marker: a relaunch may take over again.
		const relaunched = await acquireDaemonSupervisorOwnership({
			...acquireOptions(root, socketPath, registryDir),
			generation: "test-generation-2",
			relaunch: true,
		});
		await relaunched.release();
	});
});
