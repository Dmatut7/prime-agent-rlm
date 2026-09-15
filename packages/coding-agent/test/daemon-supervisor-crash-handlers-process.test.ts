import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getDaemonLogPath } from "../src/config.js";
import { getProcessStartId } from "../src/core/session-lease.js";
import { SessionManager } from "../src/core/session-manager.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { normalizeSocketPath } from "../src/modes/daemon/daemon-socket.js";
import type { DaemonWorkerDescriptor } from "../src/modes/daemon/daemon-worker-protocol.js";
import { type FakeWorkerHandle, startFakeWorker } from "./fixtures/supervisor-fake-worker.js";
import { isolatedSupervisorRegistryEnv } from "./fixtures/supervisor-registry-isolation.js";

/**
 * T3-4 / P1-5-L6 process half: the assertions that need a real process. An uncaught
 * exception must still take the supervisor down (its state is untrustworthy), an
 * unhandled rejection must not, and a bookkeeping write that fails during recovery
 * must leave the daemon serving with a degraded line in its log instead of a corpse.
 */

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const fixturePath = resolve(__dirname, "fixtures/supervisor-crash-handlers-fixture.ts");

const children = new Set<ChildProcess>();
const tempDirs: string[] = [];
const workers: FakeWorkerHandle[] = [];
const daemonSockets = new Set<string>();

/**
 * A leaked worker/supervisor env would change what the spawned process believes about
 * itself. The supervisor registry root is scrubbed with the rest, so an isolated one is
 * put back: a daemon started from here must never write the developer's real
 * `~/.prime/supervisor-owners`.
 */
function scrubbedEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
	for (const key of Object.keys(env)) {
		if (key.startsWith("RLM_") || key.startsWith("PRIME_AGENT_INTERNAL_")) {
			delete env[key];
		}
	}
	return { ...env, ...isolatedSupervisorRegistryEnv(root) };
}

afterEach(async () => {
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.request({ type: "shutdown" }, 3_000);
		} catch {
			// Already gone.
		} finally {
			client.close();
		}
	}
	daemonSockets.clear();
	for (const worker of workers.splice(0)) {
		await worker.close().catch(() => undefined);
	}
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGTERM");
		}
	}
	await Promise.all([...children].map((child) => waitForExit(child).catch(() => undefined)));
	children.clear();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Waits for `close`, not `exit`: the last stderr chunk can land after the process is gone. */
function waitForExit(child: ChildProcess): Promise<void> {
	return new Promise((resolveExit) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveExit();
			return;
		}
		child.once("close", () => resolveExit());
		child.once("exit", () => {
			// A detached stdio pipe would otherwise hold the promise open.
			setTimeout(resolveExit, 500).unref();
		});
	});
}

async function runFixture(
	mode: string,
	rejections = "1",
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const fixtureDir = tempDir("ma-t3-4-fixture-");
	const child = spawn(process.execPath, [tsxPath, fixturePath, mode, rejections], {
		cwd: fixtureDir,
		env: scrubbedEnv(fixtureDir, { PI_OFFLINE: "1" }),
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	await waitForExit(child);
	return { exitCode: child.exitCode, stdout, stderr };
}

async function connectEventually(socketPath: string, timeoutMs = 60_000): Promise<DaemonClient> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(1_000);
			await client.waitForHello(5_000);
			return client;
		} catch (error) {
			lastError = error;
			client.close();
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(`Daemon supervisor never accepted a client: ${String(lastError)}`);
}

/** chmod cannot deny the superuser, so a read-only fixture is a statement about not being root. */
const runningAsRoot = (): boolean => typeof process.geteuid === "function" && process.geteuid() === 0;

describe("T3-4 supervisor crash handlers in a real process", () => {
	it("exits(1) on an uncaught exception", { tags: ["process-stress"], timeout: 60_000 }, async () => {
		const result = await runFixture("uncaught");
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("supervisor uncaught exception");
		expect(`${result.stdout}\n${result.stderr}`).toContain("fixture uncaught exception");
	});

	it("survives unhandled rejections and logs them at a bounded rate", {
		tags: ["process-stress"],
		timeout: 60_000,
	}, async () => {
		const result = await runFixture("rejection", "5");
		// RED on HEAD: Node's default is to crash the process on the first one.
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("SURVIVED");
		const rejectionLines = `${result.stdout}\n${result.stderr}`
			.split("\n")
			.filter((line) => line.includes("supervisor unhandled rejection"));
		expect(rejectionLines).toHaveLength(1);
		expect(rejectionLines[0]).toContain("count in the last");
	});

	it("exits(1) once the configured rejection threshold is reached", {
		tags: ["process-stress"],
		timeout: 60_000,
	}, async () => {
		const result = await runFixture("threshold", "3");
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}\n${result.stderr}`).toContain("threshold 2");
	});

	it.skipIf(runningAsRoot())(
		"keeps serving when a recovery bookkeeping write fails",
		{ tags: ["process-stress"], timeout: 120_000 },
		async () => {
			const root = tempDir("ma-t3-4-supervisor-");
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			const sessionDir = join(agentDir, "sessions");
			const socketPath = join(root, "daemon.sock");
			const workerSocketPath = join(root, "worker.sock");
			// The supervisor derives its descriptor directory from the socket path.
			const descriptorDir = join(
				agentDir,
				"daemon-workers",
				createHash("sha256").update(normalizeSocketPath(socketPath)).digest("hex").slice(0, 12),
			);
			mkdirSync(projectDir, { recursive: true });
			mkdirSync(sessionDir, { recursive: true });
			mkdirSync(descriptorDir, { recursive: true });
			daemonSockets.add(socketPath);

			const manager = SessionManager.create(projectDir, sessionDir);
			manager.appendMessage({ role: "user", content: "crash handler fixture", timestamp: 1 });
			manager.flushNow();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Fixture session did not persist");
			const sessionId = manager.getSessionId();

			const standIn = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
			children.add(standIn);
			const pid = standIn.pid;
			if (pid === undefined) throw new Error("Stand-in process did not report a pid");
			const worker = await startFakeWorker({
				socketPath: workerSocketPath,
				session: { activeSessionId: "active-t3-4", sessionId, sessionFile, cwd: projectDir, messageCount: 1 },
				onShutdownRequest: () => standIn.kill("SIGTERM"),
			});
			workers.push(worker);

			const now = new Date().toISOString();
			const descriptor: DaemonWorkerDescriptor = {
				version: 2,
				workerId: "worker-t3-4",
				pid,
				...(getProcessStartId(pid) ? { processStartId: getProcessStartId(pid) } : {}),
				socketPath: workerSocketPath,
				recoveryJournalPath: join(descriptorDir, "worker-t3-4.recovery.jsonl"),
				orphanProcessJournalPath: join(descriptorDir, "worker-t3-4.orphans.jsonl"),
				supervisorSocketPath: socketPath,
				authenticationToken: "token-t3-4",
				rootActiveSessionId: "active-t3-4",
				rootSessionId: sessionId,
				sessionFile,
				sessionDir,
				createdAt: now,
				updatedAt: now,
				lifecycle: "ready",
				createCommand: { type: "create", sessionPath: sessionFile },
				consecutiveFailures: 0,
			};
			writeFileSync(join(descriptorDir, "worker-t3-4.json"), `${JSON.stringify(descriptor, null, 2)}\n`, {
				mode: 0o600,
			});

			const supervisor = spawn(
				process.execPath,
				[tsxPath, cliPath, "--mode", "daemon", "--daemon-socket", socketPath, "--offline"],
				{
					cwd: projectDir,
					env: scrubbedEnv(root, { [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1" }),
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			children.add(supervisor);
			let stderr = "";
			supervisor.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			supervisor.stdout?.on("data", () => undefined);

			// The descriptor starts out saying "ready", so wait for the supervisor
			// itself: its socket must accept a client and its own adoption must have
			// brought the worker back to ready before the fixture breaks persistence.
			const client = await connectEventually(socketPath);
			const deadline = Date.now() + 60_000;
			let adopted = false;
			while (Date.now() < deadline) {
				const list = await client.request({ type: "list" }, 10_000).catch(() => undefined);
				const sessions =
					list?.success && list.data && typeof list.data === "object"
						? ((list.data as { sessions?: Array<{ sessionId?: string; workerState?: string }> }).sessions ?? [])
						: [];
				adopted = sessions.some((row) => row.sessionId === sessionId && row.workerState === "ready");
				if (adopted) break;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			expect(adopted).toBe(true);

			// Make every bookkeeping write fail, then drop the worker connection: the
			// close handler has to write a lifecycle change it cannot persist.
			chmodSync(descriptorDir, 0o500);
			try {
				await worker.close();
				const survived = Date.now() + 5_000;
				while (Date.now() < survived) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
				// RED on HEAD: the failed write escaped as an unhandled rejection and
				// took the whole supervisor down with it.
				if (supervisor.exitCode !== null) {
					throw new Error(`Supervisor exited with ${supervisor.exitCode}. stderr:\n${stderr}`);
				}
				expect(supervisor.signalCode).toBe(null);
				const list = await client.request({ type: "list" }, 10_000);
				expect(list.success).toBe(true);
				const log = existsSync(getDaemonLogPath(socketPath))
					? readFileSync(getDaemonLogPath(socketPath), "utf8")
					: stderr;
				expect(log).toContain("Supervisor degraded: could not persist worker");
				expect(log).toContain("degraded count: 1");
			} finally {
				chmodSync(descriptorDir, 0o700);
				client.close();
			}
		},
	);
});
