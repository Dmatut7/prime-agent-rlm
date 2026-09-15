import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sweepStaleWorkerSockets } from "../src/modes/daemon/daemon-supervisor.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-r31-sock-sweep-"));
	tempDirs.push(directory);
	return directory;
}

interface DescriptorFixture {
	workerId: string;
	pid: number;
	socketPath: string;
}

function writeDescriptor(descriptorDir: string, fixture: DescriptorFixture): void {
	writeFileSync(
		join(descriptorDir, `${fixture.workerId}.json`),
		JSON.stringify({
			version: 1,
			workerId: fixture.workerId,
			pid: fixture.pid,
			socketPath: fixture.socketPath,
			supervisorSocketPath: "supervisor.sock",
			authenticationToken: "token",
			rootActiveSessionId: `active-${fixture.workerId}`,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			lifecycle: "failed",
			createCommand: { type: "create", sessionPath: "session.jsonl", config: {} },
			consecutiveFailures: 0,
		}),
	);
}

/** The same 12-hex-char key workerSocketPath() derives from the supervisor socket. */
function socketKey(supervisorSocketPath: string): string {
	return createHash("sha256").update(resolve(supervisorSocketPath)).digest("hex").slice(0, 12);
}

/** A pid that is provably dead (not merely unlikely to exist). */
async function spawnDeadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
	await new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	return child.pid!;
}

describe("r31 RC-3 stale worker socket sweep", () => {
	it("removes sockets of dead-pid workers and keeps live-pid ones", async () => {
		const root = createTempDir();
		const socketDir = join(root, "socket-dir");
		const descriptorDir = join(root, "descriptor-dir");
		mkdirSync(socketDir, { recursive: true });
		mkdirSync(descriptorDir, { recursive: true });
		const supervisorSocketPath = join(root, "supervisor.sock");

		const key = socketKey(supervisorSocketPath);
		const deadPid = await spawnDeadPid();
		const deadSocket = join(socketDir, `worker-${key}-deadbeef.sock`);
		const liveSocket = join(socketDir, `worker-${key}-livebee01.sock`);
		writeDescriptor(descriptorDir, {
			workerId: "dead-worker",
			pid: deadPid,
			socketPath: deadSocket,
		});
		writeDescriptor(descriptorDir, {
			workerId: "live-worker",
			pid: process.pid,
			socketPath: liveSocket,
		});
		writeFileSync(deadSocket, "");
		writeFileSync(liveSocket, "");

		const result = sweepStaleWorkerSockets({
			supervisorSocketPath,
			descriptorDir,
			socketDir,
		});

		expect(result.removed).toEqual([deadSocket]);
		expect(result.kept.map((entry) => entry.path)).toEqual([liveSocket]);
		expect(readdirSync(socketDir)).toEqual([`worker-${key}-livebee01.sock`]);
	});

	it("keeps young orphaned sockets and removes them past the 60s age gate", () => {
		const root = createTempDir();
		const socketDir = join(root, "socket-dir");
		const descriptorDir = join(root, "descriptor-dir");
		mkdirSync(socketDir, { recursive: true });
		mkdirSync(descriptorDir, { recursive: true });
		const supervisorSocketPath = join(root, "supervisor.sock");

		const key = socketKey(supervisorSocketPath);
		const youngOrphan = join(socketDir, `worker-${key}-orphan01.sock`);
		const oldOrphan = join(socketDir, `worker-${key}-orphan02.sock`);
		writeFileSync(youngOrphan, "");
		writeFileSync(oldOrphan, "");
		const now = Date.now();
		utimesSync(youngOrphan, new Date(now - 5_000), new Date(now - 5_000));
		utimesSync(oldOrphan, new Date(now - 61_000), new Date(now - 61_000));

		const result = sweepStaleWorkerSockets({
			supervisorSocketPath,
			descriptorDir,
			socketDir,
			now,
		});

		expect(result.removed).toEqual([oldOrphan]);
		expect(result.kept.map((entry) => entry.path)).toEqual([youngOrphan]);
		expect(statSync(youngOrphan).isFile()).toBe(true);
	});
});
