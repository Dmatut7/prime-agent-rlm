import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShutdownSelection, type ShutdownTargetEntry, type StopSelection } from "../src/cli/daemon-ps.js";
import { ENV_AGENT_DIR } from "../src/config.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { defaultDaemonSocketDir, normalizeSocketPath } from "../src/modes/daemon/daemon-socket.js";

/**
 * Round-17 DS-1/DS-2 regressions, both driven through the real command.
 *
 * DS-1: `lsof` reports every unix socket a prime-agent-named process holds, and
 * node's own IPC sockets (`$TMPDIR/tsx-<uid>/<pid>.pipe`) are unix socket files
 * that look exactly like daemon sockets to that scan. A whole-machine `--force`
 * must not SIGTERM a listener that nothing proves is a daemon.
 *
 * DS-2: a worker's socket is filtered out of the daemon list by design, and it
 * used to be stopped silently. It has to be nameable in `stopped`, and the run
 * has to report what is still on disk (`stillPresent === []` is the only clean
 * verdict).
 */

const SUPERVISOR_REGISTRY_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

const children = new Set<ChildProcess>();
let root: string;
let previousEnvironment: Record<string, string | undefined>;

/** A process that holds a listening unix socket and is not a daemon of any kind. */
function spawnListener(socketPath: string): ChildProcess {
	const script = [
		'const net = require("node:net");',
		// A listener that holds a unix socket and never answers the daemon handshake,
		// like the launcher IPC socket the audit found in `leftRunning`.
		"const server = net.createServer((connection) => connection.destroy());",
		"server.listen(process.env.P0_TEST_LISTEN_SOCKET);",
	].join("");
	const child = spawn(process.execPath, ["-e", script], {
		env: { ...process.env, P0_TEST_LISTEN_SOCKET: socketPath },
		stdio: ["ignore", "ignore", "ignore"],
	});
	children.add(child);
	return child;
}

/**
 * A listener that takes its own socket file with it when it is told to die, the
 * way a real daemon does. Both faces of the target disappear at once, which is
 * the shape the convergence window has to judge honestly.
 */
function spawnSelfCleaningListener(socketPath: string): ChildProcess {
	const script = [
		'const net = require("node:net");',
		'const fs = require("node:fs");',
		"const socketPath = process.env.P0_TEST_LISTEN_SOCKET;",
		"const server = net.createServer((connection) => connection.destroy());",
		"server.listen(socketPath);",
		"const leave = () => {",
		"	try { server.close(); } catch {}",
		"	try { fs.unlinkSync(socketPath); } catch {}",
		"	process.exit(0);",
		"};",
		'process.on("SIGTERM", leave);',
		'process.on("SIGINT", leave);',
	].join("\n");
	const child = spawn(process.execPath, ["-e", script], {
		env: { ...process.env, P0_TEST_LISTEN_SOCKET: socketPath },
		stdio: ["ignore", "ignore", "ignore"],
	});
	children.add(child);
	return child;
}

/** A listener killed outright, so its socket file survives it: one orphan file, no process. */
function spawnAbandonedListener(socketPath: string): ChildProcess {
	const script = [
		'const net = require("node:net");',
		"const server = net.createServer((connection) => connection.destroy());",
		"server.listen(process.env.P0_TEST_LISTEN_SOCKET, () => {",
		'	process.kill(process.pid, "SIGKILL");',
		"});",
	].join("");
	const child = spawn(process.execPath, ["-e", script], {
		env: { ...process.env, P0_TEST_LISTEN_SOCKET: socketPath },
		stdio: ["ignore", "ignore", "ignore"],
	});
	children.add(child);
	return child;
}

/** A tracked worker descriptor: the supervisor's own record of one worker it owns. */
function writeWorkerDescriptor(
	agentDir: string,
	workerId: string,
	pid: number,
	socketPath: string,
	supervisorSocketPath: string,
): void {
	const descriptorDirectory = join(agentDir, "daemon-workers", workerId);
	mkdirSync(descriptorDirectory, { recursive: true });
	writeFileSync(
		join(descriptorDirectory, "worker.json"),
		JSON.stringify({
			version: 2,
			workerId,
			pid,
			processStartId: getProcessStartId(pid),
			socketPath,
			recoveryJournalPath: join(descriptorDirectory, "recovery.jsonl"),
			orphanProcessJournalPath: join(descriptorDirectory, "orphans.jsonl"),
			supervisorSocketPath: normalizeSocketPath(supervisorSocketPath),
			authenticationToken: "token",
			rootActiveSessionId: "session",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			lifecycle: "ready",
			createCommand: { type: "create", noSession: true },
			consecutiveFailures: 0,
		}),
	);
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

async function waitForSocketFile(socketPath: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(socketPath)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`listener never created ${socketPath}`);
}

async function waitForFileGone(path: string, timeoutMs = 20000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!existsSync(path)) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`${path} was never removed`);
}

async function waitForExitOf(pid: number, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!alive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** `ss` is short-circuited so the lsof branch is taken on every platform. */
function writeFakeTools(directory: string, listeners: Array<{ pid: number; socketPath: string }>): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "ss"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
	writeFileSync(
		join(directory, "lsof"),
		[
			"#!/bin/sh",
			// Report only the sockets whose owner is still running, so the sweep can converge.
			'while IFS=" " read -r pid path; do',
			'\tif kill -0 "$pid" 2>/dev/null; then printf "p%s\\nn%s\\n" "$pid" "$path"; fi',
			'done < "$P0_TEST_LSOF_ENTRIES"',
			"",
		].join("\n"),
		{ mode: 0o700 },
	);
	const entries = join(directory, "lsof-entries.txt");
	writeFileSync(entries, `${listeners.map(({ pid, socketPath }) => `${pid} ${socketPath}`).join("\n")}\n`);
	process.env.P0_TEST_LSOF_ENTRIES = entries;
}

/** A supervisor owner record: the machine's own proof that a socket is a daemon. */
function writeOwnerRecord(
	registryDir: string,
	socketPath: string,
	pid: number,
	agentDir: string,
	generation: string,
): void {
	const directory = join(registryDir, `${generation}.owner`);
	mkdirSync(directory, { recursive: true });
	const now = new Date().toISOString();
	writeFileSync(
		join(directory, "owner.json"),
		JSON.stringify({
			version: 1,
			role: "supervisor",
			token: `token-${generation}`,
			generation,
			pid,
			processStartId: getProcessStartId(pid),
			socketPath: normalizeSocketPath(socketPath),
			descriptorDir: join(agentDir, "daemon-workers"),
			agentDir,
			appVersion: "0.0.0-test",
			phase: "owner",
			createdAt: now,
			updatedAt: now,
		}),
	);
}

async function runShutdownWithExitCode(
	selection: StopSelection,
): Promise<{ report: Record<string, unknown>; exitCode: number | string | undefined }> {
	const logs: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map((value) => String(value)).join(" "));
	});
	const previousExitCode = process.exitCode;
	let exitCode: number | string | undefined;
	try {
		await runShutdownSelection(true, true, selection);
		exitCode = process.exitCode ?? undefined;
	} finally {
		log.mockRestore();
		process.exitCode = previousExitCode;
	}
	const last = logs.at(-1);
	if (!last) throw new Error("shutdown printed nothing");
	return { report: JSON.parse(last) as Record<string, unknown>, exitCode };
}

async function runShutdown(selection: StopSelection): Promise<Record<string, unknown>> {
	return (await runShutdownWithExitCode(selection)).report;
}

function entriesOf(result: Record<string, unknown>, key: string): ShutdownTargetEntry[] {
	return (result[key] ?? []) as ShutdownTargetEntry[];
}

describe("stop target identity and convergence", () => {
	beforeEach(() => {
		// Short paths on purpose: a unix socket path is capped near 104 bytes.
		root = mkdtempSync(join("/tmp", "p0-stop-"));
		previousEnvironment = {
			PATH: process.env.PATH,
			TMPDIR: process.env.TMPDIR,
			[ENV_AGENT_DIR]: process.env[ENV_AGENT_DIR],
			[SUPERVISOR_REGISTRY_ENV]: process.env[SUPERVISOR_REGISTRY_ENV],
			P0_TEST_LSOF_ENTRIES: process.env.P0_TEST_LSOF_ENTRIES,
		};
		const socketTmpDir = join(root, "tmp");
		mkdirSync(socketTmpDir, { recursive: true });
		process.env.TMPDIR = socketTmpDir;
		process.env[ENV_AGENT_DIR] = join(root, "agent");
		process.env[SUPERVISOR_REGISTRY_ENV] = join(root, "registry");
	});

	afterEach(() => {
		for (const child of children) {
			child.kill("SIGKILL");
		}
		children.clear();
		for (const [name, value] of Object.entries(previousEnvironment)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("dry-run reports its kept targets as keptInScope, never as the full report's leftRunning", async () => {
		const socketDirectory = join(root, "sockets");
		mkdirSync(socketDirectory, { recursive: true });
		const strangerSocket = join(socketDirectory, `${process.pid}.pipe`);
		const daemonSocket = join(socketDirectory, "daemon.sock");
		const stranger = spawnListener(strangerSocket);
		const daemon = spawnListener(daemonSocket);
		await waitForSocketFile(strangerSocket);
		await waitForSocketFile(daemonSocket);
		writeOwnerRecord(
			process.env[SUPERVISOR_REGISTRY_ENV]!,
			daemonSocket,
			daemon.pid!,
			join(root, "agent"),
			"r20-dry-run",
		);
		writeFakeTools(join(root, "bin"), [
			{ pid: stranger.pid!, socketPath: strangerSocket },
			{ pid: daemon.pid!, socketPath: daemonSocket },
		]);
		process.env.PATH = `${join(root, "bin")}:${process.env.PATH ?? ""}`;

		const dryLogs: string[] = [];
		const dryLog = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			dryLogs.push(args.map((value) => String(value)).join(" "));
		});
		try {
			await runShutdownSelection(
				true,
				true,
				{ scope: { kind: "socket", socketPath: daemonSocket }, orphansOnly: false },
				true,
			);
		} finally {
			dryLog.mockRestore();
		}
		const dry = JSON.parse(dryLogs.at(-1) ?? "") as Record<string, unknown>;

		// A dry run plans and stops nothing.
		expect(alive(stranger.pid)).toBe(true);
		expect(alive(daemon.pid)).toBe(true);
		expect(dry.dryRun).toBe(true);
		// `leftRunning` in a real run means "still running after we tried to stop it";
		// the plan's "this stays out of scope" list is a different proposition and must
		// not reuse the word.
		expect(Object.keys(dry)).not.toContain("leftRunning");
		const kept = (dry.keptInScope ?? []) as ShutdownTargetEntry[];
		expect(kept.map((entry) => entry.socketPath)).toContain(strangerSocket);
		const targets = (dry.targets ?? []) as ShutdownTargetEntry[];
		expect(targets.map((entry) => entry.socketPath)).toContain(daemonSocket);

		// The full report keeps the four-bucket vocabulary the dry-run shape avoids,
		// so a consumer diffing plan against result reads two disjoint key sets.
		const full = await runShutdown({ scope: { kind: "machine" }, orphansOnly: false });
		await waitForExitOf(daemon.pid!);
		expect(alive(stranger.pid)).toBe(true);
		expect(Object.keys(full)).toContain("leftRunning");
		expect(Object.keys(full)).not.toContain("keptInScope");
	}, 60_000);

	it("never signals a listening socket that is not a verified daemon, and names it in leftRunning", async () => {
		const socketDirectory = join(root, "sockets");
		mkdirSync(socketDirectory, { recursive: true });
		const strangerSocket = join(socketDirectory, `${process.pid}.pipe`);
		const daemonSocket = join(socketDirectory, "daemon.sock");
		const stranger = spawnListener(strangerSocket);
		const daemon = spawnListener(daemonSocket);
		await waitForSocketFile(strangerSocket);
		await waitForSocketFile(daemonSocket);
		// Only the second one is a daemon: the machine's own owner registry says so.
		writeOwnerRecord(
			process.env[SUPERVISOR_REGISTRY_ENV]!,
			daemonSocket,
			daemon.pid!,
			join(root, "agent"),
			"r17-daemon",
		);
		writeFakeTools(join(root, "bin"), [
			{ pid: stranger.pid!, socketPath: strangerSocket },
			{ pid: daemon.pid!, socketPath: daemonSocket },
		]);
		process.env.PATH = `${join(root, "bin")}:${process.env.PATH ?? ""}`;

		const result = await runShutdown({ scope: { kind: "machine" }, orphansOnly: false });

		// The positive control: a recorded daemon on the same sweep really was stopped.
		await waitForExitOf(daemon.pid!);
		expect(alive(daemon.pid)).toBe(false);
		// The regression: a stranger's listening socket was never signalled.
		expect(alive(stranger.pid)).toBe(true);
		expect(entriesOf(result, "stopped").map((entry) => entry.socketPath)).toContain(daemonSocket);
		const left = entriesOf(result, "leftRunning").find((entry) => entry.socketPath === strangerSocket);
		expect(left).toBeDefined();
		expect(left?.reason).toMatch(/not a verified daemon/);
		expect(left?.pid).toBe(stranger.pid);
		expect(result.stillPresent).toEqual([strangerSocket]);
		const buckets =
			entriesOf(result, "stopped").length +
			entriesOf(result, "failed").length +
			entriesOf(result, "skipped").length +
			entriesOf(result, "leftRunning").length;
		expect(result.discovered).toBe(buckets);
		expect(entriesOf(result, "failed")).toEqual([]);
		expect(entriesOf(result, "skipped")).toEqual([]);
	}, 60_000);

	it("names a worker that converged in stopped, and reports nothing left on disk", async () => {
		const supervisorDirectory = join(root, "deployment");
		mkdirSync(supervisorDirectory, { recursive: true });
		const supervisorSocket = join(supervisorDirectory, "daemon.sock");
		const supervisor = spawnListener(supervisorSocket);
		await waitForSocketFile(supervisorSocket);
		// A supervisor is a daemon the machine's owner registry knows about.
		writeOwnerRecord(
			process.env[SUPERVISOR_REGISTRY_ENV]!,
			supervisorSocket,
			supervisor.pid!,
			join(root, "agent"),
			"r17-supervisor",
		);

		// A worker socket lives in the default service directory, under a worker name.
		mkdirSync(defaultDaemonSocketDir(), { recursive: true });
		const workerSocket = join(defaultDaemonSocketDir(), "worker-12f042ee5718-46490fc846bf.sock");
		const worker = spawnListener(workerSocket);
		await waitForSocketFile(workerSocket);
		// The load-bearing part is that the worker lives in the directory the
		// stop scan reads (whatever the shipped default or a test override is).
		expect(resolve(workerSocket, "..")).toBe(resolve(defaultDaemonSocketDir()));

		const agentDir = process.env[ENV_AGENT_DIR]!;
		const descriptorDirectory = join(agentDir, "daemon-workers", "r17-worker");
		mkdirSync(descriptorDirectory, { recursive: true });
		writeFileSync(
			join(descriptorDirectory, "worker.json"),
			JSON.stringify({
				version: 2,
				workerId: "46490fc846bf",
				pid: worker.pid,
				processStartId: getProcessStartId(worker.pid!),
				socketPath: workerSocket,
				recoveryJournalPath: join(descriptorDirectory, "recovery.jsonl"),
				orphanProcessJournalPath: join(descriptorDirectory, "orphans.jsonl"),
				supervisorSocketPath: normalizeSocketPath(supervisorSocket),
				authenticationToken: "token",
				rootActiveSessionId: "session",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				lifecycle: "ready",
				createCommand: { type: "create", noSession: true },
				consecutiveFailures: 0,
			}),
		);

		writeFakeTools(join(root, "bin"), [
			{ pid: supervisor.pid!, socketPath: supervisorSocket },
			{ pid: worker.pid!, socketPath: workerSocket },
		]);
		process.env.PATH = `${join(root, "bin")}:${process.env.PATH ?? ""}`;

		const result = await runShutdown({ scope: { kind: "socket", socketPath: supervisorSocket }, orphansOnly: false });

		await waitForExitOf(worker.pid!);
		expect(alive(supervisor.pid)).toBe(false);
		expect(alive(worker.pid)).toBe(false);
		const stoppedWorker = entriesOf(result, "stopped").find((entry) => entry.socketPath === workerSocket);
		expect(stoppedWorker).toBeDefined();
		expect(stoppedWorker?.kind).toBe("worker");
		expect(stoppedWorker?.pid).toBe(worker.pid);
		expect(entriesOf(result, "stopped").some((entry) => entry.socketPath === supervisorSocket)).toBe(true);
		expect(result.stillPresent).toEqual([]);
		const buckets =
			entriesOf(result, "stopped").length +
			entriesOf(result, "failed").length +
			entriesOf(result, "skipped").length +
			entriesOf(result, "leftRunning").length;
		expect(result.discovered).toBe(buckets);
		expect(entriesOf(result, "failed")).toEqual([]);
	}, 60_000);

	it("does not credit a target that vanished on its own inside the convergence window", async () => {
		const socketDirectory = join(root, "sockets");
		mkdirSync(socketDirectory, { recursive: true });
		mkdirSync(defaultDaemonSocketDir(), { recursive: true });

		// A service `--orphans` keeps: it owns a live worker, so it has live work and
		// no signal in this run may reach it.
		const keptSocket = join(socketDirectory, "kept.sock");
		const kept = spawnSelfCleaningListener(keptSocket);
		await waitForSocketFile(keptSocket);
		// Its worker. A worker socket is inside the scope and is observed as a target
		// of the run, and nothing in a run that may not touch its supervisor signals it.
		const workerSocket = join(defaultDaemonSocketDir(), "worker-12f042ee5718-aaaabbbbcccc.sock");
		const worker = spawnSelfCleaningListener(workerSocket);
		await waitForSocketFile(workerSocket);
		writeWorkerDescriptor(process.env[ENV_AGENT_DIR]!, "r18-worker", worker.pid!, workerSocket, keptSocket);
		// The positive control: an orphan socket file with no process behind it, which
		// this run really removes and really reports as a stop of its own.
		const orphanSocket = join(defaultDaemonSocketDir(), "stale.sock");
		spawnAbandonedListener(orphanSocket);
		await waitForSocketFile(orphanSocket);

		writeFakeTools(join(root, "bin"), [
			{ pid: kept.pid!, socketPath: keptSocket },
			{ pid: worker.pid!, socketPath: workerSocket },
		]);
		process.env.PATH = `${join(root, "bin")}:${process.env.PATH ?? ""}`;

		const running = runShutdownWithExitCode({ scope: { kind: "machine" }, orphansOnly: true });
		// Removing the orphan file is the stop plan's own first act, so its disappearance
		// is the proof that the plan is already running: both live targets above were
		// observed before any signal, and the kept service is already protected. Killing
		// them here is an outside actor inside the convergence window, and the report has
		// to say that is what happened instead of claiming the stops for itself.
		await waitForFileGone(orphanSocket);
		kept.kill("SIGTERM");
		worker.kill("SIGTERM");
		const { report, exitCode } = await running;

		await waitForExitOf(kept.pid!);
		await waitForExitOf(worker.pid!);
		expect(alive(kept.pid), "the kept service was killed from outside").toBe(false);
		expect(alive(worker.pid), "the worker was killed from outside").toBe(false);
		expect(existsSync(keptSocket)).toBe(false);
		expect(existsSync(workerSocket)).toBe(false);

		// The proposition: neither vanished target was signalled by this run, and this
		// run never removed either socket file, so neither is a stop it performed. The
		// one entry `stopped` may hold is the orphan file the plan really removed.
		expect(entriesOf(report, "stopped")).toEqual([
			{ socketPath: orphanSocket, kind: "service", action: "removed stale socket file" },
		]);

		const keptEntry = [...entriesOf(report, "leftRunning"), ...entriesOf(report, "skipped")].find(
			(entry) => entry.socketPath === keptSocket,
		);
		expect(keptEntry, JSON.stringify(report)).toBeDefined();
		expect(keptEntry?.reason).toMatch(/live work/);
		const workerEntry = [...entriesOf(report, "leftRunning"), ...entriesOf(report, "skipped")].find(
			(entry) => entry.socketPath === workerSocket,
		);
		expect(workerEntry, JSON.stringify(report)).toBeDefined();
		expect(workerEntry?.pid).toBe(worker.pid);
		expect(workerEntry?.reason).toMatch(/vanished without this run touching it/);

		// The observation face stays clean and the buckets still add up, so the honest
		// verdict cannot be had by dropping the target from the report.
		expect(report.stillPresent).toEqual([]);
		expect(entriesOf(report, "failed")).toEqual([]);
		expect(exitCode ?? 0).toBe(0);
		const buckets =
			entriesOf(report, "stopped").length +
			entriesOf(report, "failed").length +
			entriesOf(report, "skipped").length +
			entriesOf(report, "leftRunning").length;
		expect(report.discovered).toBe(buckets);
	}, 60_000);

	it("sees an adopted worker whose socket still lives in the legacy $TMPDIR directory (R1 follow-up 2)", async () => {
		// R1 review follow-up: after the stable-socket-dir move, a worker adopted from
		// the old generation keeps its socket where it was born (a `prime-agent-<uid>`
		// dir under $TMPDIR), while `scanSocketDir()` only reads the new stable dir.
		// The stop plan must still see that worker, or an adopted worker becomes
		// unstoppable. daemon-ps.ts builds worker targets from the descriptor's own
		// socketPath ("whatever directory that socket ended up in"), so pin that with a
		// live listener in a legacy-named directory and an orphans-only machine sweep
		// (which never signals live targets): the worker has to be discovered, not
		// invisible.
		const socketDirectory = join(root, "sockets");
		mkdirSync(socketDirectory, { recursive: true });
		mkdirSync(defaultDaemonSocketDir(), { recursive: true });
		const legacyDirectory = join(root, "prime-agent-501");
		mkdirSync(legacyDirectory, { recursive: true });

		const keptSocket = join(socketDirectory, "kept.sock");
		const _kept = spawnSelfCleaningListener(keptSocket);
		await waitForSocketFile(keptSocket);
		const legacyWorkerSocket = join(legacyDirectory, "worker-12f042ee5718-aaaabbbbcccc.sock");
		const legacyWorker = spawnSelfCleaningListener(legacyWorkerSocket);
		await waitForSocketFile(legacyWorkerSocket);
		writeWorkerDescriptor(
			process.env[ENV_AGENT_DIR]!,
			"r19-legacy-worker",
			legacyWorker.pid!,
			legacyWorkerSocket,
			keptSocket,
		);

		const report = await runShutdown({ scope: { kind: "machine" }, orphansOnly: true });

		const seen = [
			...entriesOf(report, "stopped"),
			...entriesOf(report, "skipped"),
			...entriesOf(report, "leftRunning"),
			...entriesOf(report, "failed"),
		].find((entry) => entry.socketPath === normalizeSocketPath(legacyWorkerSocket));
		expect(seen, JSON.stringify(report)).toBeDefined();
		expect(seen?.pid).toBe(legacyWorker.pid);
		// An orphans-only sweep must not have signalled the live worker.
		expect(alive(legacyWorker.pid)).toBe(true);
	}, 60_000);
});
