import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DaemonTargetEvidence, daemonTargetRefusal, ShutdownReport } from "../src/cli/daemon-ps.js";
import { getProcessStartId } from "../src/core/session-lease.js";

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

/** The accounting identity the report promises: every target lands in exactly one bucket. */
function bucketTotal(report: ShutdownReport): number {
	return report.stopped.length + report.failed.length + report.skipped.length + report.leftRunning.length;
}

describe("daemonTargetRefusal", () => {
	const target = { pid: 4242, socketPath: "/tmp/tsx-501/4242.pipe" };
	/** Every face a signalling path can hold about one target, with the defaults of a live socket file. */
	function evidence(overrides: Partial<DaemonTargetEvidence>): DaemonTargetEvidence {
		return {
			listeningSocket: true,
			socketFilePresent: true,
			recordedOwner: false,
			recordedOwnerIdIsPinned: false,
			answeredDaemonHandshake: false,
			...overrides,
		};
	}

	it("refuses a listening unix socket that has no daemon proof at all", () => {
		const reason = daemonTargetRefusal(target, evidence({}));
		expect(reason).toContain("not a verified daemon");
		expect(reason).toContain("4242");
		expect(reason).toContain(target.socketPath);
	});

	it("accepts a target a supervisor owner record names, even a hung one", () => {
		// A hung daemon answers nothing by definition, so the record has to be enough.
		expect(daemonTargetRefusal(target, evidence({ recordedOwner: true }))).toBeUndefined();
	});

	it("accepts a target that answers the daemon handshake", () => {
		expect(daemonTargetRefusal(target, evidence({ answeredDaemonHandshake: true }))).toBeUndefined();
	});

	it("accepts an owner-recorded pid whose socket file was unlinked underneath it", () => {
		// The registry names the pid *and* pins its process identity, so a recycled pid
		// cannot match. Without this the daemon is unstoppable for good: every sweep
		// reasons from a path that no longer exists.
		expect(
			daemonTargetRefusal(
				target,
				evidence({
					listeningSocket: false,
					socketFilePresent: false,
					recordedOwner: true,
					recordedOwnerIdIsPinned: true,
					answeredDaemonHandshake: true,
				}),
			),
		).toBeUndefined();
	});

	it("refuses a path that is not a listening socket when no owner record pins that pid", () => {
		// A record without a process start id could match a recycled pid, so it is not
		// proof enough to signal something no scan sees listening.
		const unpinned = daemonTargetRefusal(
			target,
			evidence({ listeningSocket: false, socketFilePresent: false, recordedOwner: true }),
		);
		expect(unpinned).toContain("not a listening unix socket");
		const unrecorded = daemonTargetRefusal(
			target,
			evidence({ listeningSocket: false, socketFilePresent: false, answeredDaemonHandshake: true }),
		);
		expect(unrecorded).toContain("not a listening unix socket");
	});

	it("refuses a listening socket file the scan does not attribute to that pid", () => {
		// The handshake proves something on that path is a daemon; it does not prove
		// *this* pid is the one, which is the launcher the DS-1 gate exists for.
		const reason = daemonTargetRefusal(target, evidence({ listeningSocket: false, answeredDaemonHandshake: true }));
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
		report.observe([
			{ socketPath: supervisorSocket, pid: 11, kind: "service" },
			{ socketPath: workerSocket, pid: 22, kind: "worker" },
		]);
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
		report.observe([{ socketPath: leftBehind, pid: 7, kind: "listener" }]);
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
		report.observe([{ socketPath: stranger, pid: 9, kind: "listener" }]);
		report.refuse({ socketPath: stranger, pid: 9, kind: "listener", reason: "refusing to signal pid 9" });
		expect(report.refusalReason(stranger, 9)).toBe("refusing to signal pid 9");
		// A refusal names one process; another pid on the same path is still a target.
		expect(report.refusalReason(stranger, 10)).toBeUndefined();
		expect(report.converge()).toEqual([stranger]);
		expect(report.leftRunning).toHaveLength(1);
		expect(report.leftRunning[0]?.reason).toBe("refusing to signal pid 9");
	});

	it("never launders a failed stop into stopped, and counts each path once", () => {
		const directory = makeTempDir();
		const socketPath = join(directory, "daemon.sock");
		const kept = join(directory, "elsewhere.sock");
		const report = new ShutdownReport();
		report.observe([{ socketPath: socketPath, pid: 5, kind: "service" }]);
		report.claim("stopped", { socketPath, pid: 5, kind: "service", action: "stopped" });
		report.claim("failed", { socketPath, pid: 5, kind: "service", reason: "it came back" });
		report.claim("stopped", { socketPath, pid: 5, kind: "service", action: "stopped again" });
		report.keep({ socketPath: kept, pid: 6, kind: "service", reason: "outside the shutdown scope" });

		expect(report.bucketOf(socketPath, 5)).toBe("failed");
		expect(report.stopped).toEqual([]);
		expect(report.failed).toEqual([{ socketPath, pid: 5, kind: "service", reason: "it came back" }]);
		expect(report.discovered).toBe(bucketTotal(report));
	});

	it("keeps two processes on one socket path as two targets, so a survivor cannot hide", () => {
		const directory = makeTempDir();
		const socketPath = join(directory, "daemon.sock");
		const deadPredecessor = 99_999_999;
		// The proposition needs one pid that is gone and one that is not; if either
		// premise fails the test would pass without asserting anything.
		expect(getProcessStartId(deadPredecessor)).toBeUndefined();
		const survivorStartId = getProcessStartId(process.pid);
		expect(survivorStartId).toBeDefined();

		const report = new ShutdownReport();
		report.observe([
			{ socketPath, pid: deadPredecessor, kind: "listener" },
			{ socketPath, pid: process.pid, kind: "service" },
		]);
		// The hidden-supervisor leg stopped the first one and named the path.
		report.claim("stopped", {
			socketPath,
			pid: deadPredecessor,
			kind: "listener",
			action: `stopped hidden daemon (pid ${deadPredecessor})`,
		});

		expect(report.converge()).toEqual([socketPath]);
		expect(report.stopped).toEqual([
			{
				socketPath,
				pid: deadPredecessor,
				kind: "listener",
				action: `stopped hidden daemon (pid ${deadPredecessor})`,
			},
		]);
		// The survivor on the same path is named in its own right, with its own pid.
		expect(report.leftRunning).toEqual([
			{
				socketPath,
				pid: process.pid,
				kind: "service",
				reason: expect.stringContaining(`pid ${process.pid} is alive`),
			},
		]);
		expect(report.discovered).toBe(2);
		expect(report.discovered).toBe(bucketTotal(report));
	});

	it("reports a target whose socket file is gone but whose process is still running", () => {
		const directory = makeTempDir();
		const unlinkedSocket = join(directory, "removed.sock");
		expect(existsSync(unlinkedSocket)).toBe(false);
		const report = new ShutdownReport();
		report.observe([{ socketPath: unlinkedSocket, pid: process.pid, kind: "listener" }]);
		// The "already stopped" fast path claimed a stop it never proved.
		report.claim("stopped", {
			socketPath: unlinkedSocket,
			pid: process.pid,
			kind: "listener",
			action: "background service already stopped",
		});
		expect(report.stopped).toHaveLength(1);

		// The observation at the end outranks that claim: a disk-only check called this clean.
		expect(report.converge()).toEqual([unlinkedSocket]);
		expect(report.stopped).toEqual([]);
		expect(report.leftRunning).toEqual([
			{
				socketPath: unlinkedSocket,
				pid: process.pid,
				kind: "listener",
				reason: expect.stringContaining("still running after shutdown"),
			},
		]);
		expect(report.discovered).toBe(1);
		expect(report.discovered).toBe(bucketTotal(report));
	});
});
