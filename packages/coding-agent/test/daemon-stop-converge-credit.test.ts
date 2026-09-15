import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ShutdownReport, type ShutdownTargetEntry } from "../src/cli/daemon-ps.js";

/**
 * GL-1: `converge()` used to credit *any* in-scope target that was gone by the
 * end of the window with `stopped`, on the strength of "it was present when we
 * looked". A protected service (`--orphans`, or a non-force stop that keeps a
 * daemon with live sessions) that exits on its own inside that window therefore
 * came back as a kill this run never performed: `stillPresent` was honestly
 * empty, the four buckets honestly added up, the exit code was honestly 0, and
 * the report still said we stopped something we deliberately did not touch.
 *
 * The credit now requires the run to have dispatched a signal (or a stop
 * request) to that exact target. These tests drive the real report with real
 * processes: the natural exit is the child's own timer, never a signal from us.
 */

const children = new Set<ChildProcess>();
const directories: string[] = [];

function makeTempDir(): string {
	const directory = mkdtempSync(join("/tmp", "p0-converge-"));
	directories.push(directory);
	return directory;
}

/** A process that holds a listening unix socket and exits by itself, unlinking it. */
function spawnSelfExitingListener(socketPath: string, exitAfterMs: number): ChildProcess {
	const directory = makeTempDir();
	const script = join(directory, "self-exit.cjs");
	writeFileSync(
		script,
		[
			'const net = require("node:net");',
			'const fs = require("node:fs");',
			"const socketPath = process.argv[2];",
			"const exitAfterMs = Number(process.argv[3]);",
			"const server = net.createServer((connection) => connection.destroy());",
			"server.listen(socketPath, () => {",
			"\tsetTimeout(() => {",
			"\t\tserver.close(() => {",
			"\t\t\ttry { fs.unlinkSync(socketPath); } catch {}",
			"\t\t\tprocess.exit(0);",
			"\t\t});",
			"\t}, exitAfterMs);",
			"});",
			"",
		].join("\n"),
	);
	const child = spawn(process.execPath, [script, socketPath, String(exitAfterMs)], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	children.add(child);
	return child;
}

/** A process that holds a listening unix socket until something stops it. */
function spawnListener(socketPath: string): ChildProcess {
	const directory = makeTempDir();
	const script = join(directory, "listener.cjs");
	writeFileSync(
		script,
		[
			'const net = require("node:net");',
			"const server = net.createServer((connection) => connection.destroy());",
			"server.listen(process.argv[2]);",
			"",
		].join("\n"),
	);
	const child = spawn(process.execPath, [script, socketPath], { stdio: ["ignore", "ignore", "ignore"] });
	children.add(child);
	return child;
}

function alive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The identity the report is judged by: every named target holds exactly one bucket. */
function bucketTotal(report: ShutdownReport): number {
	return report.stopped.length + report.failed.length + report.skipped.length + report.leftRunning.length;
}

function bucketsOf(report: ShutdownReport): Record<string, ShutdownTargetEntry[]> {
	return {
		stopped: report.stopped,
		failed: report.failed,
		skipped: report.skipped,
		leftRunning: report.leftRunning,
	};
}

afterEach(() => {
	for (const child of children) {
		child.kill("SIGKILL");
	}
	children.clear();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("converge() only credits stops this run performed", () => {
	it("does not report a protected service that exited on its own as stopped", async () => {
		const directory = makeTempDir();
		const socketPath = join(directory, "daemon.sock");
		const child = spawnSelfExitingListener(socketPath, 150);
		const pid = child.pid;
		expect(pid).toBeDefined();
		await waitFor(() => existsSync(socketPath), "the protected service to listen");

		const report = new ShutdownReport();
		report.observe([{ socketPath, pid, kind: "service" }]);
		// The selection kept it: a non-force stop, or `--orphans` facing live evidence.
		const reason = "protected: 2 live session(s)";
		report.keep({ socketPath, pid, kind: "service", reason });

		// It dies by itself inside the convergence window. Nothing here signalled it.
		await waitFor(() => !alive(pid), "the protected service to exit on its own");
		await waitFor(() => !existsSync(socketPath), "the socket file to go with it");

		const stillPresent = report.converge();

		expect(stillPresent).toEqual([]);
		// The regression: this used to come back as `stopped`/"converged during shutdown".
		expect(report.stopped).toEqual([]);
		// Exit semantics: only `failed` turns the command red, so a natural exit stays 0.
		expect(report.failed).toEqual([]);
		// What this run decided about it stands, with the reason it was left alone.
		expect(report.leftRunning).toEqual([{ socketPath, pid, kind: "service", reason }]);
		expect(report.skipped).toEqual([]);
		expect(report.discovered).toBe(1);
		expect(report.discovered).toBe(bucketTotal(report));
		expect(bucketsOf(report).stopped).toEqual([]);
	}, 30_000);

	it("names a target this run never touched and that vanished as skipped, not stopped", async () => {
		const directory = makeTempDir();
		const socketPath = join(directory, "listener.sock");
		const child = spawnSelfExitingListener(socketPath, 100);
		const pid = child.pid;
		expect(pid).toBeDefined();
		await waitFor(() => existsSync(socketPath), "the listener to listen");

		const report = new ShutdownReport();
		report.observe([{ socketPath, pid, kind: "listener" }]);
		await waitFor(() => !alive(pid), "the listener to exit on its own");
		await waitFor(() => !existsSync(socketPath), "the socket file to go with it");

		expect(report.converge()).toEqual([]);
		expect(report.stopped).toEqual([]);
		expect(report.leftRunning).toEqual([]);
		expect(report.skipped).toHaveLength(1);
		expect(report.skipped[0]?.reason).toMatch(/never signalled it/);
		expect(report.skipped[0]?.reason).toMatch(new RegExp(`pid ${pid}`));
		expect(report.discovered).toBe(1);
		expect(report.discovered).toBe(bucketTotal(report));
	}, 30_000);

	it("still credits a service this run signalled and that converged", async () => {
		const directory = makeTempDir();
		const socketPath = join(directory, "daemon.sock");
		const child = spawnListener(socketPath);
		const pid = child.pid;
		expect(pid).toBeDefined();
		await waitFor(() => existsSync(socketPath), "the daemon to listen");

		const report = new ShutdownReport();
		report.observe([{ socketPath, pid, kind: "service" }]);
		// The positive control: this is what a signalling leg records before it kills.
		report.markSignalled(socketPath, pid);
		expect(report.wasSignalled(socketPath, pid)).toBe(true);
		// A different pid on the same path is a different target and was not touched.
		expect(report.wasSignalled(socketPath, (pid ?? 0) + 1)).toBe(false);
		child.kill("SIGTERM");
		await waitFor(() => !alive(pid), "the signalled daemon to exit");
		rmSync(socketPath, { force: true });

		expect(report.converge()).toEqual([]);
		expect(report.stopped).toEqual([{ socketPath, pid, kind: "service", action: "converged during shutdown" }]);
		expect(report.discovered).toBe(1);
		expect(report.discovered).toBe(bucketTotal(report));
	}, 30_000);

	it("still reports a target that was already gone before the stop as skipped", async () => {
		const directory = makeTempDir();
		const socketPath = join(directory, "gone.sock");
		const deadPid = 99_999_999;
		expect(alive(deadPid)).toBe(false);
		expect(existsSync(socketPath)).toBe(false);

		const report = new ShutdownReport();
		report.observe([{ socketPath, pid: deadPid, kind: "service" }]);

		expect(report.converge()).toEqual([]);
		expect(report.stopped).toEqual([]);
		expect(report.skipped).toEqual([
			{ socketPath, pid: deadPid, kind: "service", reason: "already gone before the stop; nothing to stop" },
		]);
		expect(report.discovered).toBe(1);
		expect(report.discovered).toBe(bucketTotal(report));
	}, 30_000);
});
