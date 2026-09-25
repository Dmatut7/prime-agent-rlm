import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

/**
 * The daemon's identity is the agent dir it owns, not the socket path the
 * client happens to resolve. Two things follow, and both are checked here with
 * real processes:
 *
 * 1. `prime-agent list` whose own default socket is somewhere else still reaches
 *    the daemon that owns this agent dir (registry discovery);
 * 2. a second daemon on the same agent dir never becomes a second writer: it
 *    does not bind, does not write the agent dir, and steps down to standby
 *    instead of exiting non-zero (W2 single-instance protocol), so two
 *    processes never co-write one agent dir's sessions, harness state and
 *    leases.
 *
 * The default daemon socket is stable (`$HOME/.prime/daemon`) rather than
 * `$TMPDIR`-derived, so these fixtures pin the directory with
 * `PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR` instead of relying on `$TMPDIR`.
 */

const CLI_PATH = resolve(__dirname, "../src/cli.ts");
const TSX_PATH = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const TSCONFIG_PATH = resolve(__dirname, "../../../tsconfig.json");
const SUPERVISOR_REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const DAEMON_SOCKET_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR";

interface SpawnedCli {
	child: ChildProcess;
	stdout: () => string;
	stderr: () => string;
	/** Resolves with the exit outcome, or undefined when the process is still running after the budget. */
	exited: (timeoutMs: number) => Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined>;
}

interface Paths {
	root: string;
	agentDir: string;
	registryDir: string;
	tmpA: string;
	tmpB: string;
}

const children = new Set<ChildProcess>();
/** Fixture root -> its supervisor registry, so cleanup can reach the daemons by identity. */
const roots = new Map<string, string>();

afterEach(async () => {
	// The CLI runs under tsx, which re-execs the script in a child process, so killing the
	// process this test spawned leaves the daemon itself alive and still writing its agent
	// dir. The registry records that daemon (pid, generation, agent dir), which is the only
	// place its real pid is observable.
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
	// Wait for every kill to land before removing the fixture directories: a daemon that is
	// still running recreates its agent dir and registry on its way out, which would leave
	// debris under the real $TMPDIR after the tree was already gone.
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

function createPaths(): Paths {
	const root = mkdtempSync(join(tmpdir(), "r15-daemon-id-"));
	const paths: Paths = {
		root,
		agentDir: join(root, "agent"),
		registryDir: join(root, "registry"),
		tmpA: join(root, "tmp-a"),
		tmpB: join(root, "tmp-b"),
	};
	for (const directory of [paths.agentDir, paths.registryDir, paths.tmpA, paths.tmpB]) {
		mkdirSync(directory, { recursive: true });
	}
	roots.set(root, paths.registryDir);
	return paths;
}

/**
 * Child environment with this session's leaking `RLM_*` / `PRIME_AGENT_*` / `PI_*`
 * variables removed: a spawned CLI that inherits `PRIME_AGENT_INTERNAL_DAEMON_WORKER`
 * would boot as a daemon worker, and an inherited agent dir or registry dir would
 * point the test at real state instead of the fixture.
 */
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

/**
 * The socket a process resolves as its default: the daemon socket dir override
 * when pinned (`PRIME_AGENT_INTERNAL_DAEMON_SOCKET_DIR`), else the stable
 * per-user directory. Fixtures pin it so a test daemon can never bind the
 * developer's real `~/.prime/daemon/daemon.sock`.
 */
function socketDirIn(tmpDir: string): string {
	return join(tmpDir, "daemon-sockets");
}

function socketPathIn(tmpDir: string): string {
	return join(socketDirIn(tmpDir), "daemon.sock");
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

/** Waits for a line the daemon logged (stdout/stderr arrive on their own schedule). */
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

function spawnDaemon(paths: Paths, tmpDir: string): SpawnedCli {
	return spawnCli(["--mode", "daemon", "--offline"], {
		TMPDIR: tmpDir,
		[DAEMON_SOCKET_DIR_ENV]: socketDirIn(tmpDir),
		[ENV_AGENT_DIR]: paths.agentDir,
		[SUPERVISOR_REGISTRY_DIR_ENV]: paths.registryDir,
	});
}

describe("daemon identity is the agent dir", () => {
	it("reaches the agent dir's daemon from a client with a different default socket", async () => {
		const paths = createPaths();
		const daemon = spawnDaemon(paths, paths.tmpA);
		await waitForDaemon(socketPathIn(paths.tmpA));

		const listing = spawnCli(["list", "--json"], {
			TMPDIR: paths.tmpB,
			[DAEMON_SOCKET_DIR_ENV]: socketDirIn(paths.tmpB),
			[ENV_AGENT_DIR]: paths.agentDir,
			[SUPERVISOR_REGISTRY_DIR_ENV]: paths.registryDir,
		});
		const outcome = await listing.exited(45_000);
		expect(outcome, `list with a foreign default socket never exited; stderr: ${listing.stderr()}`).toBeDefined();
		expect(outcome?.code, `stderr: ${listing.stderr()}`).toBe(0);
		expect(JSON.parse(listing.stdout())).toMatchObject({ sessions: [] });
		// The listing came from the running daemon: nothing was started on this
		// client's own socket path.
		expect(existsSync(socketPathIn(paths.tmpB))).toBe(false);
		expect(daemon.child.exitCode).toBeNull();
	}, 120_000);

	it("never lets a second daemon on the same agent dir become a writer (it stands by)", async () => {
		const paths = createPaths();
		const first = spawnDaemon(paths, paths.tmpA);
		await waitForDaemon(socketPathIn(paths.tmpA));

		const second = spawnDaemon(paths, paths.tmpB);
		// W2: the second daemon steps down to standby instead of exiting non-zero
		// (a service manager's KeepAlive would otherwise relaunch it into the same
		// collision forever). It must still never bind or write.
		await waitForLoggedLine(second, "standing by", 45_000);
		const secondIsListening = await canConnect(socketPathIn(paths.tmpB), 500);
		expect(
			{ exited: second.child.exitCode !== null, secondIsListening },
			`second daemon exit=${second.child.exitCode ?? "still running"}; ` +
				`socket ${socketPathIn(paths.tmpB)} listening=${secondIsListening}; stderr: ${second.stderr()}`,
		).toEqual({ exited: false, secondIsListening: false });
		expect(second.child.exitCode).toBeNull();
		expect(`${second.stdout()}${second.stderr()}`).toContain("already owns agent dir");

		// The first daemon still owns the agent dir and still answers.
		const listing = spawnCli(["list", "--json"], {
			TMPDIR: paths.tmpA,
			[DAEMON_SOCKET_DIR_ENV]: socketDirIn(paths.tmpA),
			[ENV_AGENT_DIR]: paths.agentDir,
			[SUPERVISOR_REGISTRY_DIR_ENV]: paths.registryDir,
		});
		const listingOutcome = await listing.exited(45_000);
		expect(listingOutcome?.code, `stderr: ${listing.stderr()}`).toBe(0);
		expect(first.child.exitCode).toBeNull();
	}, 180_000);
});
