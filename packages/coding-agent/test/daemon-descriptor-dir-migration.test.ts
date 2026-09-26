import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDaemonSocketPath } from "../src/modes/daemon/daemon-socket.js";
import { migrateLegacyWorkerDescriptorDirOnDisk } from "../src/modes/daemon/daemon-supervisor.js";

const cleanup: string[] = [];
afterEach(() => {
	while (cleanup.length > 0) {
		const dir = cleanup.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("migrateLegacyWorkerDescriptorDirOnDisk", () => {
	it("renames the legacy-keyed descriptor dir onto the stable key (real fs), idempotently", () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "w2-migrate-"));
		cleanup.push(root);
		const agentDir = join(root, "agent");
		// First call reports the legacy dir path even when it does not exist.
		const probe = migrateLegacyWorkerDescriptorDirOnDisk({
			agentDir,
			socketPath: defaultDaemonSocketPath(),
		});
		expect(probe?.reason).toBe("no-legacy-dir");
		expect(probe?.legacyDir).not.toBe("");
		expect(probe?.descriptorDir).not.toBe("");

		// Create the legacy dir with a worker descriptor inside it.
		const legacyDir = probe!.legacyDir;
		const descriptorDir = probe!.descriptorDir;
		expect(legacyDir).not.toBe(descriptorDir);
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "worker-1.json"), "{}");

		const migrated = migrateLegacyWorkerDescriptorDirOnDisk({
			agentDir,
			socketPath: defaultDaemonSocketPath(),
		});
		expect(migrated?.migrated).toBe(true);
		expect(migrated?.reason).toBe("renamed");
		expect(existsSync(legacyDir)).toBe(false);
		expect(readdirSync(descriptorDir)).toEqual(["worker-1.json"]);

		// Idempotent: the legacy dir is gone now.
		const again = migrateLegacyWorkerDescriptorDirOnDisk({
			agentDir,
			socketPath: defaultDaemonSocketPath(),
		});
		expect(again?.reason).toBe("no-legacy-dir");
	});

	it("no-ops when the supervisor does not bind the default socket", () => {
		if (process.platform === "win32") return;
		const result = migrateLegacyWorkerDescriptorDirOnDisk({
			agentDir: "/tmp/w2-not-used",
			socketPath: "/tmp/w2-explicit.sock",
		});
		expect(result?.migrated).toBe(false);
		expect(result?.reason).toBe("not-default-socket");
	});

	it("refuses to migrate onto a non-empty descriptor dir", () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "w2-migrate-busy-"));
		cleanup.push(root);
		const agentDir = join(root, "agent");
		const probe = migrateLegacyWorkerDescriptorDirOnDisk({
			agentDir,
			socketPath: defaultDaemonSocketPath(),
		});
		const legacyDir = probe!.legacyDir;
		const descriptorDir = probe!.descriptorDir;
		mkdirSync(legacyDir, { recursive: true });
		mkdirSync(descriptorDir, { recursive: true });
		writeFileSync(join(legacyDir, "worker-1.json"), "{}");
		writeFileSync(join(descriptorDir, "existing.json"), "{}");

		const result = migrateLegacyWorkerDescriptorDirOnDisk({
			agentDir,
			socketPath: defaultDaemonSocketPath(),
			rename: () => {
				throw new Error("must not rename");
			},
		});

		expect(result?.migrated).toBe(false);
		expect(result?.reason).toBe("target-not-empty");
		expect(existsSync(legacyDir)).toBe(true);
	});

	it("skips the migration when the caller pinned a custom descriptor dir (N6)", () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "w2-migrate-custom-"));
		cleanup.push(root);
		const agentDir = join(root, "agent");
		const probe = migrateLegacyWorkerDescriptorDirOnDisk({ agentDir, socketPath: defaultDaemonSocketPath() });
		const customDir = join(root, "pinned-descriptors");
		const result = migrateLegacyWorkerDescriptorDirOnDisk({
			agentDir,
			socketPath: defaultDaemonSocketPath(),
			descriptorDir: customDir,
		});
		// The rename would land the legacy tree in the computed default dir the
		// caller never reads; refusing is the sound move.
		expect(result?.migrated).toBe(false);
		expect(result?.reason).toBe("custom-descriptor-dir");
		expect(result?.descriptorDir).toBe(probe?.descriptorDir);
		// The default descriptorDir still passes through unchanged.
		expect(
			migrateLegacyWorkerDescriptorDirOnDisk({
				agentDir,
				socketPath: defaultDaemonSocketPath(),
				descriptorDir: probe?.descriptorDir,
			})?.reason,
		).not.toBe("custom-descriptor-dir");
	});

	it("reports a failed rename as rename-failed with the errno, not no-legacy-dir (N7)", () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "w2-migrate-rename-"));
		cleanup.push(root);
		const agentDir = join(root, "agent");
		const probe = migrateLegacyWorkerDescriptorDirOnDisk({ agentDir, socketPath: defaultDaemonSocketPath() });
		const legacyDir = probe!.legacyDir;
		mkdirSync(legacyDir, { recursive: true });
		writeFileSync(join(legacyDir, "worker-1.json"), "{}");

		const failure = Object.assign(new Error("rename failed"), { code: "EXDEV" });
		const result = migrateLegacyWorkerDescriptorDirOnDisk({
			agentDir,
			socketPath: defaultDaemonSocketPath(),
			rename: () => {
				throw failure;
			},
		});

		expect(result?.migrated).toBe(false);
		expect(result?.reason).toBe("rename-failed");
		expect(result?.renameErrorCode).toBe("EXDEV");
		expect(existsSync(legacyDir)).toBe(true);
	});
});
