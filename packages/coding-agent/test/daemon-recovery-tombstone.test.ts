import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverDaemonUnlessShutdownTombstoned } from "../src/main.js";
import { recordDaemonShutdownTombstone } from "../src/modes/daemon/daemon-supervisor-ownership.js";

describe("recoverDaemonUnlessShutdownTombstoned", () => {
	let registryDir: string;

	beforeEach(() => {
		registryDir = mkdtempSync(join(tmpdir(), "w40-tombstone-"));
		vi.stubEnv("PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR", registryDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(registryDir, { recursive: true, force: true });
	});

	it("refuses to respawn a daemon whose socket was shut down deliberately", async () => {
		const socketPath = join(registryDir, "daemon.sock");
		recordDaemonShutdownTombstone(socketPath);
		const ensure = vi.fn<(socketPath: string) => Promise<void>>().mockResolvedValue(undefined);

		await expect(recoverDaemonUnlessShutdownTombstoned(socketPath, ensure)).rejects.toThrow(/shut down deliberately/);
		expect(ensure).not.toHaveBeenCalled();
	});

	it("recovers normally when no tombstone is recorded", async () => {
		const socketPath = join(registryDir, "daemon.sock");
		const ensure = vi.fn<(socketPath: string) => Promise<void>>().mockResolvedValue(undefined);

		await recoverDaemonUnlessShutdownTombstoned(socketPath, ensure);

		expect(ensure).toHaveBeenCalledWith(socketPath);
	});
});
