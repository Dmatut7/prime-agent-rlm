import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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

async function runShutdown(selection: StopSelection): Promise<Record<string, unknown>> {
	const logs: string[] = [];
	const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map((value) => String(value)).join(" "));
	});
	const previousExitCode = process.exitCode;
	try {
		await runShutdownSelection(true, true, selection);
	} finally {
		log.mockRestore();
		process.exitCode = previousExitCode;
	}
	const last = logs.at(-1);
	if (!last) throw new Error("shutdown printed nothing");
	return JSON.parse(last) as Record<string, unknown>;
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
		expect(basename(defaultDaemonSocketDir())).toMatch(/^prime-agent-(?:\d+|user)$/);

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
});
