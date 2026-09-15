import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forceKillDaemon, killDaemon, ShutdownReport, signalAndRecordStop } from "../src/cli/daemon-ps.js";

/**
 * Round-23 K3X-6 / X-1: the kill primitive used to swallow ESRCH and EPERM and
 * return nothing, and every signalling leg wrote its `recordSignal` ledger
 * entry *before* the signal went out. A daemon that died for its own reasons in
 * that window therefore entered the causal ledger on the strength of a signal
 * that landed on nothing, and the convergence pass reported a stop this run
 * never performed.
 *
 * The contract under test: the primitive reports whether the kernel really
 * delivered the signal, and the ledger records it only after that report.
 */

const children = new Set<ChildProcess>();
const directories: string[] = [];

function makeTempDir(): string {
	const directory = mkdtempSync(join("/tmp", "r23-delivery-"));
	directories.push(directory);
	return directory;
}

/** A process that holds a listening unix socket and dies on its own, leaving the file behind. */
function spawnSelfDyingListener(socketPath: string): ChildProcess {
	const directory = makeTempDir();
	const script = join(directory, "self-die.cjs");
	writeFileSync(
		script,
		[
			'const net = require("node:net");',
			"const server = net.createServer((connection) => connection.destroy());",
			"server.listen(process.argv[2]);",
			'process.kill(process.pid, "SIGKILL");',
			"",
		].join("\n"),
	);
	const child = spawn(process.execPath, [script, socketPath], { stdio: ["ignore", "ignore", "ignore"] });
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

/** A pid this process spawned, whose exit this process has already reaped. */
async function spawnReapedPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "ignore", "ignore"] });
	const pid = child.pid!;
	await new Promise<void>((resolve) => child.on("exit", resolve));
	// Node reaps on the exit event; a beat later the pid is free and ESRCH is a fact.
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(alive(pid), `premise: pid ${pid} must be reaped`).toBe(false);
	return pid;
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

describe("kill primitive delivery (K3X-6)", () => {
	it("reports a signal to an already-dead pid as not delivered", async () => {
		const pid = await spawnReapedPid();
		expect(killDaemon(pid)).toBe(false);
		expect(await forceKillDaemon(pid)).toBe(false);
	});

	it("reports a delivered signal as delivered", async () => {
		const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		children.add(sleeper);
		expect(alive(sleeper.pid)).toBe(true);
		expect(killDaemon(sleeper.pid!)).toBe(true);
		await waitFor(() => !alive(sleeper.pid), "the signalled sleeper to exit");
	});
});

describe("the causal ledger records only delivered signals (X-1)", () => {
	it("does not enter the ledger when the signal never landed", async () => {
		const directory = makeTempDir();
		const socketPath = join(directory, "daemon.sock");
		const child = spawnSelfDyingListener(socketPath);
		const pid = child.pid;
		expect(pid).toBeDefined();
		await waitFor(() => existsSync(socketPath), "the daemon to listen");

		const report = new ShutdownReport();
		report.observe([{ socketPath, pid, kind: "service" }]);

		// It dies for its own reasons inside the convergence window, and because it
		// was killed outright its socket file stays behind. Nothing here signalled it.
		await waitFor(() => !alive(pid), "the daemon to die on its own");
		expect(existsSync(socketPath)).toBe(true);

		// The production leg, in the fixed order: signal first, ledger after, and
		// only for a delivery the primitive reported. This one lands on ESRCH.
		expect(await signalAndRecordStop(report, pid ?? 0)).toBe(false);

		const stillPresent = report.converge();

		// The honest verdict: this run stopped nothing, and the residue is named.
		expect(report.stopped).toEqual([]);
		expect(report.leftRunning).toEqual([
			{
				socketPath,
				pid,
				kind: "service",
				reason: expect.stringContaining("still present after shutdown"),
			},
		]);
		expect(report.discovered).toBe(1);
		expect(stillPresent).toEqual([socketPath]);
	}, 30_000);

	it("enters the ledger when the signal was really delivered", async () => {
		const directory = makeTempDir();
		const socketPath = join(directory, "daemon.sock");
		const child = spawnListener(socketPath);
		const pid = child.pid;
		expect(pid).toBeDefined();
		await waitFor(() => existsSync(socketPath), "the daemon to listen");

		const report = new ShutdownReport();
		report.observe([{ socketPath, pid, kind: "service" }]);

		expect(await signalAndRecordStop(report, pid ?? 0)).toBe(true);
		await waitFor(() => !alive(pid), "the signalled daemon to exit");
		expect(existsSync(socketPath)).toBe(true);

		const stillPresent = report.converge();

		expect(report.stopped).toEqual([
			{
				socketPath,
				pid,
				kind: "service",
				action: expect.stringContaining("converged during shutdown"),
			},
		]);
		expect(report.leftRunning).toEqual([]);
		expect(stillPresent).toEqual([socketPath]);
	}, 30_000);
});
