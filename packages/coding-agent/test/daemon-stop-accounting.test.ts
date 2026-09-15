import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonTargetRefusal, ShutdownReport } from "../src/cli/daemon-ps.js";

/**
 * Round-17 DS-1/DS-2 unit faces: the gate every signal path routes through, and
 * the four-bucket accounting that has to name a converged worker.
 */

const tempDirs: string[] = [];

function makeTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "r17-stop-accounting-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("daemonTargetRefusal", () => {
	const target = { pid: 4242, socketPath: "/tmp/tsx-501/4242.pipe" };

	it("refuses a listening unix socket that has no daemon proof at all", () => {
		const reason = daemonTargetRefusal(target, {
			listeningSocket: true,
			recordedOwner: false,
			answeredDaemonHandshake: false,
		});
		expect(reason).toContain("not a verified daemon");
		expect(reason).toContain("4242");
		expect(reason).toContain(target.socketPath);
	});

	it("accepts a target a supervisor owner record names, even a hung one", () => {
		// A hung daemon answers nothing by definition, so the record has to be enough.
		expect(
			daemonTargetRefusal(target, {
				listeningSocket: true,
				recordedOwner: true,
				answeredDaemonHandshake: false,
			}),
		).toBeUndefined();
	});

	it("accepts a target that answers the daemon handshake", () => {
		expect(
			daemonTargetRefusal(target, {
				listeningSocket: true,
				recordedOwner: false,
				answeredDaemonHandshake: true,
			}),
		).toBeUndefined();
	});

	it("refuses anything that is not a listening unix socket, proof or not", () => {
		const reason = daemonTargetRefusal(target, {
			listeningSocket: false,
			recordedOwner: true,
			answeredDaemonHandshake: true,
		});
		expect(reason).toContain("not a listening unix socket");
	});
});

describe("ShutdownReport accounting", () => {
	it("names a worker that converged, whether or not anything claimed to stop it", () => {
		const directory = makeTempDir();
		const supervisorSocket = join(directory, "daemon.sock");
		const workerSocket = join(directory, "worker-12f042ee5718-46490fc846bf.sock");
		writeFileSync(supervisorSocket, "");
		writeFileSync(workerSocket, "");

		const report = new ShutdownReport();
		report.observe(
			new Map([
				[supervisorSocket, { pid: 11, kind: "service" as const }],
				[workerSocket, { pid: 22, kind: "worker" as const }],
			]),
		);
		// The supervisor was stopped and its socket removed; the worker converged with it.
		rmSync(supervisorSocket);
		rmSync(workerSocket);
		const stillPresent = report.converge();

		expect(stillPresent).toEqual([]);
		expect(report.stopped.map((entry) => [entry.socketPath, entry.kind, entry.pid])).toEqual([
			[supervisorSocket, "service", 11],
			[workerSocket, "worker", 22],
		]);
		expect(report.discovered).toBe(2);
	});

	it("reports what is still on disk instead of declaring a clean sweep", () => {
		const directory = makeTempDir();
		const leftBehind = join(directory, "a.pipe");
		writeFileSync(leftBehind, "");
		const report = new ShutdownReport();
		report.observe(new Map([[leftBehind, { pid: 7, kind: "listener" as const }]]));
		expect(report.converge()).toEqual([leftBehind]);
		expect(report.stopped).toEqual([]);
		expect(report.leftRunning).toEqual([
			{ socketPath: leftBehind, pid: 7, kind: "listener", reason: expect.stringContaining("still present") },
		]);
	});

	it("keeps a refusal as the reason it was left running", () => {
		const directory = makeTempDir();
		const stranger = join(directory, "9.pipe");
		writeFileSync(stranger, "");
		const report = new ShutdownReport();
		report.observe(new Map([[stranger, { pid: 9, kind: "listener" as const }]]));
		report.refuse({ socketPath: stranger, pid: 9, kind: "listener", reason: "refusing to signal pid 9" });
		expect(report.refusalReason(stranger)).toBe("refusing to signal pid 9");
		expect(report.converge()).toEqual([stranger]);
		expect(report.leftRunning).toHaveLength(1);
		expect(report.leftRunning[0]?.reason).toBe("refusing to signal pid 9");
	});

	it("never launders a failed stop into stopped, and counts each path once", () => {
		const directory = makeTempDir();
		const socketPath = join(directory, "daemon.sock");
		const kept = join(directory, "elsewhere.sock");
		const report = new ShutdownReport();
		report.observe(new Map([[socketPath, { pid: 5, kind: "service" as const }]]));
		report.claim("stopped", { socketPath, pid: 5, kind: "service", action: "stopped" });
		report.claim("failed", { socketPath, pid: 5, kind: "service", reason: "it came back" });
		report.claim("stopped", { socketPath, pid: 5, kind: "service", action: "stopped again" });
		report.keep({ socketPath: kept, pid: 6, kind: "service", reason: "outside the shutdown scope" });

		expect(report.bucketOf(socketPath)).toBe("failed");
		expect(report.stopped).toEqual([]);
		expect(report.failed).toEqual([{ socketPath, pid: 5, kind: "service", reason: "it came back" }]);
		expect(report.discovered).toBe(
			report.stopped.length + report.failed.length + report.skipped.length + report.leftRunning.length,
		);
	});
});
