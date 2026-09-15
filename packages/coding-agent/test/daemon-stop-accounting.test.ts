import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
	it("names a worker that converged, when this run is what touched it", () => {
		const directory = makeTempDir();
		const supervisorSocket = join(directory, "daemon.sock");
		const workerSocket = join(directory, "worker-12f042ee5718-46490fc846bf.sock");
		writeFileSync(supervisorSocket, "");
		writeFileSync(workerSocket, "");

		// Pids that no runner has: on a Linux CI machine the low pids this test used
		// to hardcode (11, 22) are live kernel threads, `converge()` then read them
		// as "still running" and reported both socket paths as still present (the
		// exact CI red). The premise is checked like every other dead-pid premise in
		// this file: a pid that is alive makes the convergence half meaningless.
		const supervisorPid = 99_999_995;
		const workerPid = 99_999_994;
		expect(getProcessStartId(supervisorPid), `premise: pid ${supervisorPid} must be free`).toBeUndefined();
		expect(getProcessStartId(workerPid), `premise: pid ${workerPid} must be free`).toBeUndefined();

		const report = new ShutdownReport();
		report.observe([
			{ socketPath: supervisorSocket, pid: supervisorPid, kind: "service" },
			{ socketPath: workerSocket, pid: workerPid, kind: "worker", supervisorSocketPath: supervisorSocket },
		]);
		// What the sweep really did on the way: it signalled the supervisor, removed its
		// socket file, and signalled the worker through the descriptor its supervisor wrote.
		report.recordSignal(supervisorPid);
		report.recordStoppedService(supervisorSocket);
		report.recordSocketRemoval(supervisorSocket);
		report.recordSignal(workerPid);
		rmSync(supervisorSocket);
		rmSync(workerSocket);
		const stillPresent = report.converge();

		expect(stillPresent).toEqual([]);
		expect(report.stopped.map((entry) => [entry.socketPath, entry.kind, entry.pid])).toEqual([
			[supervisorSocket, "service", supervisorPid],
			[workerSocket, "worker", workerPid],
		]);
		expect(report.discovered).toBe(2);
	});

	it("reports what is still on disk instead of declaring a clean sweep", () => {
		const directory = makeTempDir();
		const leftBehind = join(directory, "a.pipe");
		writeFileSync(leftBehind, "");
		// The same CI fact: pid 7 is alive on a Linux runner (CI showed
		// "still running after shutdown: pid 7 is alive"), which swapped the
		// reason under test. A pid no machine has keeps the proposition about the
		// file being the thing that is still here.
		const pid = 99_999_993;
		expect(getProcessStartId(pid), `premise: pid ${pid} must be free`).toBeUndefined();
		const report = new ShutdownReport();
		report.observe([{ socketPath: leftBehind, pid, kind: "listener" }]);
		expect(report.converge()).toEqual([leftBehind]);
		expect(report.stopped).toEqual([]);
		expect(report.leftRunning).toEqual([
			{ socketPath: leftBehind, pid, kind: "listener", reason: expect.stringContaining("still present") },
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

/**
 * Round-18 GL-1: `converge()` may only call a disappearance a stop when this run
 * caused it. A target that dies inside the observation window for its own reasons
 * — a natural exit, somebody else's `kill`, an orphan reaper — used to be promoted
 * to `stopped ... converged during shutdown` over whatever weaker, truer verdict the
 * run had already recorded, and the exit code stayed green.
 */
describe("ShutdownReport convergence credit", () => {
	/** Pids that are gone, so "the process is not there" is a fact and not a fixture accident. */
	const deadPids = [99_999_999, 99_999_998, 99_999_997, 99_999_996];

	beforeEach(() => {
		for (const pid of deadPids) {
			expect(getProcessStartId(pid), `premise: pid ${pid} must be free on this machine`).toBeUndefined();
		}
	});

	/** One target that was on disk when the run started, with a file to disappear. */
	function observedFile(directory: string, name: string): string {
		const socketPath = join(directory, name);
		writeFileSync(socketPath, "");
		return socketPath;
	}

	it("never credits a target that vanished without this run touching it", () => {
		const directory = makeTempDir();
		const socketPath = observedFile(directory, "daemon.sock");
		const report = new ShutdownReport();
		report.observe([{ socketPath, pid: deadPids[0], kind: "service" }]);

		// An outside actor: the process exits and takes its socket file with it.
		rmSync(socketPath);

		expect(report.converge()).toEqual([]);
		expect(report.stopped).toEqual([]);
		expect(report.skipped).toEqual([
			{ socketPath, pid: deadPids[0], kind: "service", reason: "vanished without this run touching it" },
		]);
		expect(report.discovered).toBe(bucketTotal(report));
	});

	it("credits a vanished target whose pid this run signalled", () => {
		const directory = makeTempDir();
		const socketPath = observedFile(directory, "daemon.sock");
		const report = new ShutdownReport();
		report.observe([{ socketPath, pid: deadPids[1], kind: "service" }]);
		report.recordSignal(deadPids[1]!);
		rmSync(socketPath);

		expect(report.converge()).toEqual([]);
		expect(report.stopped).toEqual([
			{ socketPath, pid: deadPids[1], kind: "service", action: "converged during shutdown" },
		]);
		expect(report.skipped).toEqual([]);
	});

	it("credits a vanished target whose socket file this run removed", () => {
		const directory = makeTempDir();
		const socketPath = observedFile(directory, "daemon.sock");
		const report = new ShutdownReport();
		// No pid at all: an orphan file target this run unlinked.
		report.observe([{ socketPath, kind: "listener" }]);
		report.recordSocketRemoval(socketPath);
		rmSync(socketPath);

		expect(report.converge()).toEqual([]);
		expect(report.stopped).toEqual([{ socketPath, kind: "listener", action: "converged during shutdown" }]);
	});

	it("credits a worker that converged with the service this run stopped", () => {
		const directory = makeTempDir();
		const supervisorSocket = join(directory, "daemon.sock");
		const workerSocket = observedFile(directory, "worker-12f042ee5718-46490fc846bf.sock");
		const report = new ShutdownReport();
		report.observe([
			{ socketPath: workerSocket, pid: deadPids[2], kind: "worker", supervisorSocketPath: supervisorSocket },
		]);
		// The service was stopped gracefully: no signal reached the worker pid, and the
		// worker went with the service that owned it.
		report.recordStoppedService(supervisorSocket);
		rmSync(workerSocket);

		expect(report.converge()).toEqual([]);
		expect(report.stopped).toEqual([
			{
				socketPath: workerSocket,
				pid: deadPids[2],
				kind: "worker",
				action: "converged with the service this run stopped",
			},
		]);
	});

	it("does not credit a worker of a service this run left alone", () => {
		const directory = makeTempDir();
		const supervisorSocket = join(directory, "kept.sock");
		const workerSocket = observedFile(directory, "worker-12f042ee5718-aaaabbbbcccc.sock");
		const report = new ShutdownReport();
		report.observe([
			{ socketPath: workerSocket, pid: deadPids[3], kind: "worker", supervisorSocketPath: supervisorSocket },
		]);
		// The service was protected, so nothing this run did can explain the worker's death.
		report.recordSignal(deadPids[0]!);
		report.recordSocketRemoval(join(directory, "something-else.sock"));
		rmSync(workerSocket);

		expect(report.converge()).toEqual([]);
		expect(report.stopped).toEqual([]);
		expect(report.skipped).toEqual([
			{
				socketPath: workerSocket,
				pid: deadPids[3],
				kind: "worker",
				reason: "vanished without this run touching it",
			},
		]);
	});

	it("keeps the run's own earlier verdict when an untouched target vanishes", () => {
		const directory = makeTempDir();
		const keptSocket = observedFile(directory, "kept.sock");
		const refusedSocket = observedFile(directory, "stranger.pipe");
		const unforcedSocket = observedFile(directory, "unresponsive.sock");
		const report = new ShutdownReport();
		report.observe([
			{ socketPath: keptSocket, pid: deadPids[0], kind: "service" },
			{ socketPath: refusedSocket, pid: deadPids[1], kind: "listener" },
			{ socketPath: unforcedSocket, pid: deadPids[2], kind: "service" },
		]);
		report.keep({
			socketPath: keptSocket,
			pid: deadPids[0],
			kind: "service",
			reason: "has live work (1 worker process(es))",
		});
		report.refuse({
			socketPath: refusedSocket,
			pid: deadPids[1],
			kind: "listener",
			reason: `refusing to signal pid ${deadPids[1]}: it is not a verified daemon`,
		});
		report.claim("skipped", {
			socketPath: unforcedSocket,
			pid: deadPids[2],
			kind: "service",
			reason: "did not stop gracefully; retry with --force",
		});

		rmSync(keptSocket);
		rmSync(refusedSocket);
		rmSync(unforcedSocket);

		// All three are gone and none of them was touched, so no verdict may be promoted;
		// what the run decided is what the report still says.
		expect(report.converge()).toEqual([]);
		expect(report.stopped).toEqual([]);
		expect(report.leftRunning).toEqual([
			{ socketPath: keptSocket, pid: deadPids[0], kind: "service", reason: "has live work (1 worker process(es))" },
			{
				socketPath: refusedSocket,
				pid: deadPids[1],
				kind: "listener",
				reason: `refusing to signal pid ${deadPids[1]}: it is not a verified daemon`,
			},
		]);
		expect(report.skipped).toEqual([
			{
				socketPath: unforcedSocket,
				pid: deadPids[2],
				kind: "service",
				reason: "did not stop gracefully; retry with --force",
			},
		]);
		expect(report.discovered).toBe(3);
		expect(report.discovered).toBe(bucketTotal(report));
	});

	it("still separates a target that was never there from one that vanished", () => {
		const directory = makeTempDir();
		const staleSocket = join(directory, "gone-before.sock");
		const vanishedSocket = observedFile(directory, "gone-during.sock");
		const report = new ShutdownReport();
		report.observe([
			{ socketPath: staleSocket, pid: deadPids[0], kind: "service" },
			{ socketPath: vanishedSocket, pid: deadPids[1], kind: "service" },
		]);
		rmSync(vanishedSocket);

		expect(report.converge()).toEqual([]);
		expect(report.skipped).toEqual([
			{
				socketPath: staleSocket,
				pid: deadPids[0],
				kind: "service",
				reason: "already gone before the stop; nothing to stop",
			},
			{
				socketPath: vanishedSocket,
				pid: deadPids[1],
				kind: "service",
				reason: "vanished without this run touching it",
			},
		]);
		expect(report.stopped).toEqual([]);
	});
});
