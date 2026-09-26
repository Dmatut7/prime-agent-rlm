import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

/**
 * W2 single-instance wiring (R1 N1/N2/N4): the supervisor-mode entry path
 * `runDaemonSupervisorMode` — occupancy probe, occupant identity ladder,
 * ELOCKED classification, and the standby downgrade — exercised with real
 * processes on one socket path.
 *
 * - fast path: a live, hello-speaking daemon on the socket => the second
 *   supervisor downgrades to standby before ever entering the 15s lease wait;
 * - pre-bind lease (N1): a live process holds the socket-path lease but has
 *   not bound => ELOCKED is classified as a single-instance conflict and the
 *   newcomer stands by instead of crashing into a launchd relaunch loop;
 * - foreign listener (N2): a listener that accepts but never speaks a daemon
 *   hello => loud refusal, never a permanent silent standby.
 */

const CLI_PATH = resolve(__dirname, "../src/cli.ts");
const TSX_PATH = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const TSCONFIG_PATH = resolve(__dirname, "../../../tsconfig.json");
const SUPERVISOR_REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

interface SpawnedCli {
	child: ChildProcess;
	stdout: () => string;
	stderr: () => string;
	exited: (timeoutMs: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined>;
}

const children = new Set<ChildProcess>();
const roots = new Map<string, string>();

afterEach(async () => {
	const daemonPids = new Set<number>();
	for (const registryDir of roots.values()) {
		for (const pid of registryOwnerPids(registryDir)) {
			daemonPids.add(pid);
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}
	for (const child of children) {
		if (child.pid !== undefined) {
			try {
				process.kill(child.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && [...daemonPids].some(isPidAlive)) {
		await delay(25);
	}
	children.clear();
	for (const root of roots.keys()) {
		rmSync(root, { recursive: true, force: true });
	}
	roots.clear();
});

function registryOwnerPids(registryDir: string): number[] {
	let entries: string[];
	try {
		entries = readdirSync(registryDir);
	} catch {
		return [];
	}
	const pids: number[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".owner")) {
			continue;
		}
		try {
			const record = JSON.parse(readFileSync(join(registryDir, entry, "owner.json"), "utf8")) as { pid?: unknown };
			if (typeof record.pid === "number" && record.pid > 1) {
				pids.push(record.pid);
			}
		} catch {
			// A record that is already gone or unreadable names no live daemon.
		}
	}
	return pids;
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("RLM_") || key.startsWith("PRIME_AGENT_") || key.startsWith("PI_")) {
			continue;
		}
		env[key] = value;
	}
	return { ...env, PI_OFFLINE: "1", TSX_TSCONFIG_PATH: TSCONFIG_PATH, ...extra };
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv): SpawnedCli {
	const child = spawn(process.execPath, [TSX_PATH, CLI_PATH, ...args], {
		env: childEnv(env),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	children.add(child);
	return {
		child,
		stdout: () => stdout,
		stderr: () => stderr,
		exited: async (timeoutMs: number) => {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (child.exitCode !== null || child.signalCode !== null) {
					return { code: child.exitCode, signal: child.signalCode };
				}
				await delay(50);
			}
			return undefined;
		},
	};
}

function canConnect(socketPath: string, timeoutMs = 1000): Promise<boolean> {
	return new Promise((resolveConnect) => {
		const socket = createConnection(socketPath);
		let settled = false;
		const finish = (result: boolean) => {
			if (settled) return;
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolveConnect(result);
		};
		const timeout = setTimeout(() => finish(false), timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timeout);
			finish(true);
		});
		socket.once("error", () => {
			clearTimeout(timeout);
			finish(false);
		});
	});
}

async function waitForLoggedLine(handle: SpawnedCli, needle: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (handle.stdout().includes(needle) || handle.stderr().includes(needle)) {
			return;
		}
		await delay(50);
	}
	throw new Error(
		`Timed out waiting for ${JSON.stringify(needle)} in daemon output:\n${handle.stdout()}\n${handle.stderr()}`,
	);
}

async function waitForDaemon(socketPath: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await canConnect(socketPath, 250)) {
			return;
		}
		await delay(50);
	}
	throw new Error(`Timed out waiting for a daemon to listen on ${socketPath}`);
}

/**
 * A real supervisor process for `--daemon-socket <path>`: the lease is taken on
 * that exact path, so a second supervisor on the same path exercises the W2
 * single-instance wiring rather than the per-agent-dir guard.
 */
function spawnSupervisor(socketPath: string, agentDir: string, registryDir: string): SpawnedCli {
	return spawnCli(["--mode", "daemon", "--daemon-socket", socketPath, "--offline"], {
		[ENV_AGENT_DIR]: agentDir,
		[SUPERVISOR_REGISTRY_DIR_ENV]: registryDir,
	});
}

describe("runDaemonSupervisorMode single-instance wiring (real processes)", () => {
	it("stands by when a live daemon already listens on the same socket (fast path, N4)", async () => {
		const root = mkdtempSync(join(tmpdir(), "w2-fp-"));
		roots.set(root, join(root, "registry"));
		mkdirSync(join(root, "registry"), { recursive: true });
		const socketPath = join(root, "daemon.sock");
		const first = spawnSupervisor(socketPath, join(root, "agent-a"), join(root, "registry"));
		await waitForDaemon(socketPath, 90_000);

		const second = spawnSupervisor(socketPath, join(root, "agent-b"), join(root, "registry"));
		await waitForLoggedLine(second, "standing by", 45_000);
		// The standby process is alive (it is a watcher, not a crash) and never
		// claimed the socket: the first daemon still answers there.
		expect(second.child.exitCode).toBeNull();
		const stillListening = await canConnect(socketPath, 500);
		expect(stillListening).toBe(true);
		expect(first.child.exitCode).toBeNull();
	}, 180_000);

	it("stands by when a live lease holder has not bound yet (ELOCKED, N1)", async () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "w2-elk-"));
		roots.set(root, join(root, "registry"));
		mkdirSync(join(root, "registry"), { recursive: true });
		const socketPath = join(root, "daemon.sock");

		// A holder that takes the exact lease parameters of
		// acquireDaemonSocketPathLease and never listens: the pre-bind window a
		// booting daemon occupies before its socket file exists.
		const holderScript = `
const lockfile = require(${JSON.stringify(resolve(__dirname, "../../../node_modules/proper-lockfile"))});
lockfile.lock(process.argv[1], {
	realpath: false,
	stale: 5000,
	update: 1000,
	retries: { retries: 600, factor: 1, minTimeout: 25, maxTimeout: 25 },
}).then(() => {
	process.stdout.write("HELD");
	setInterval(() => {}, 1000);
}, (error) => {
	process.stderr.write(String(error));
	process.exit(1);
});
`;
		const holder = spawn(process.execPath, ["-e", holderScript, socketPath], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		children.add(holder);
		await new Promise<void>((resolve, reject) => {
			holder.stdout?.once("data", () => resolve());
			holder.once("error", reject);
			setTimeout(() => reject(new Error("lease holder never started")), 10_000).unref?.();
		});
		expect(existsSync(socketPath)).toBe(false);

		const supervisor = spawnSupervisor(socketPath, join(root, "agent"), join(root, "registry"));
		// The lease retries run ~15s before ELOCKED; the conflict must then
		// downgrade to standby rather than crash (the pre-W2 uncaught ELOCKED).
		await waitForLoggedLine(supervisor, "standing by", 60_000);
		expect(supervisor.child.exitCode).toBeNull();
	}, 120_000);

	it("refuses loudly when the listener is not a recognizable daemon (N2)", async () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "w2-foreign-"));
		roots.set(root, join(root, "registry"));
		mkdirSync(join(root, "registry"), { recursive: true });
		const socketPath = join(root, "daemon.sock");

		// A foreign listener: accepts connections, never speaks a daemon hello.
		const server = createServer(() => {
			// hold connections open, say nothing
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			const supervisor = spawnSupervisor(socketPath, join(root, "agent"), join(root, "registry"));
			// The identity ladder (3 rungs x ~2s hello budget) must end in the loud
			// refusal, not an unbounded standby.
			const outcome = await supervisor.exited(45_000);
			expect(
				outcome,
				`supervisor never exited; output:\n${supervisor.stdout()}\n${supervisor.stderr()}`,
			).toBeDefined();
			expect(outcome?.code).toBe(1);
			expect(`${supervisor.stdout()}${supervisor.stderr()}`).toContain(
				"occupied by a listener that is not a recognizable Prime Agent daemon",
			);
			// And it never entered standby for the foreign listener.
			expect(`${supervisor.stdout()}${supervisor.stderr()}`).not.toContain("standing by");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 90_000);
});
