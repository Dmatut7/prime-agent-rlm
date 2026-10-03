import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_WARM_SPARE_ENV,
} from "../src/modes/daemon/daemon-worker-protocol.js";
import {
	checkSupervisorAvailability,
	SUPERVISOR_RELAUNCH_GRACE_MS,
	type SupervisorAvailabilityState,
} from "../src/modes/daemon/supervisor-availability.js";
import {
	isolatedSupervisorRegistryEnv,
	SUPERVISOR_REGISTRY_DIR_ENV,
} from "./fixtures/supervisor-registry-isolation.js";

/**
 * The worker half of the warm pool: a spare (DAEMON_WORKER_WARM_SPARE_ENV) owns
 * no sessions, so it must never resurrect a dead supervisor, exits its orphan
 * window quickly, and self-exits when never claimed. The availability-round
 * policy is tested pure; the AgentDaemon wiring is observed through public
 * seams only (the filesystem launch lock, the worker socket, process.exit).
 */

const ORPHAN_EXIT_ENV = "PRIME_AGENT_INTERNAL_WARM_SPARE_ORPHAN_EXIT_MS";
const UNCLAIMED_EXIT_ENV = "PRIME_AGENT_INTERNAL_WARM_SPARE_UNCLAIMED_EXIT_MS";

const roots: string[] = [];
const savedEnv: Array<[string, string | undefined]> = [];

function setEnv(key: string, value: string | undefined): void {
	savedEnv.push([key, process.env[key]]);
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

afterEach(() => {
	while (savedEnv.length > 0) {
		const [key, value] = savedEnv.pop()!;
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	while (roots.length > 0) {
		rmSync(roots.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
	vi.restoreAllMocks();
});

function deadRoundDeps(overrides: { mayLaunchReplacement?: () => boolean; orphanedLongEnough?: boolean }) {
	const calls = { launch: 0, connectAfterLaunch: 0, orphaned: 0 };
	const state: SupervisorAvailabilityState = {
		consecutiveFailures: 1,
		supervisorAbsentSince: Date.now() - SUPERVISOR_RELAUNCH_GRACE_MS - 1_000,
	};
	const deps = {
		probe: async () => ({ available: false, attempts: 3 }),
		launchReplacement: async () => {
			calls.launch++;
		},
		isConnected: () => false,
		isShuttingDown: () => false,
		isShutdownAdmissionActive: async () => false,
		connectAfterLaunch: async () => {
			calls.connectAfterLaunch++;
			return false;
		},
		isOrphanedLongEnough: () => overrides.orphanedLongEnough ?? true,
		onOrphaned: async () => {
			calls.orphaned++;
		},
		...(overrides.mayLaunchReplacement ? { mayLaunchReplacement: overrides.mayLaunchReplacement } : {}),
	};
	return { deps, state, calls };
}

describe("warm spare availability policy", () => {
	it("never launches a replacement when the worker may not, and still orphans out", async () => {
		const { deps, state, calls } = deadRoundDeps({ mayLaunchReplacement: () => false });
		const outcome = await checkSupervisorAvailability("/tmp/supervisor.sock", state, deps);

		expect(calls.launch).toBe(0);
		expect(calls.connectAfterLaunch).toBe(0);
		expect(calls.orphaned).toBe(1);
		expect(outcome.launchedReplacement).toBe(false);
	});

	it("keeps the resurrection default when the gate is absent (legacy peers)", async () => {
		const { deps, state, calls } = deadRoundDeps({});
		const outcome = await checkSupervisorAvailability("/tmp/supervisor.sock", state, deps);

		expect(calls.launch).toBe(1);
		expect(outcome.launchedReplacement).toBe(true);
	});

	it("launches again once the gate opens (a claimed spare is a normal worker)", async () => {
		let mayLaunch = false;
		const { deps, state, calls } = deadRoundDeps({ mayLaunchReplacement: () => mayLaunch });
		await checkSupervisorAvailability("/tmp/supervisor.sock", state, deps);
		expect(calls.launch).toBe(0);

		mayLaunch = true;
		state.supervisorAbsentSince = Date.now() - SUPERVISOR_RELAUNCH_GRACE_MS - 1_000;
		const outcome = await checkSupervisorAvailability("/tmp/supervisor.sock", state, deps);
		expect(calls.launch).toBe(1);
		expect(outcome.launchedReplacement).toBe(true);
	});
});

describe("warm spare worker wiring", () => {
	async function startSpareWorker(root: string): Promise<{ daemon: AgentDaemon; socketPath: string }> {
		const agentDir = join(root, "agent");
		const socketPath = join(root, "worker.sock");
		const deadSupervisorSocket = join(root, "dead-supervisor.sock");
		setEnv(SUPERVISOR_REGISTRY_DIR_ENV, isolatedSupervisorRegistryEnv(root)[SUPERVISOR_REGISTRY_DIR_ENV]);
		setEnv(DAEMON_WORKER_SUPERVISOR_SOCKET_ENV, deadSupervisorSocket);
		setEnv(DAEMON_WORKER_WARM_SPARE_ENV, "1");
		const daemon = new AgentDaemon(socketPath, {
			defaultSessionConfig: { agentDir, cwd: root },
			createRuntime: vi.fn(),
			worker: { authenticationToken: "spare-token" },
		});
		await daemon.start();
		return { daemon, socketPath };
	}

	function supervisorLaunchLockPath(deadSupervisorSocket: string): string {
		const key = createHash("sha256").update(deadSupervisorSocket).digest("hex").slice(0, 12);
		return join(dirname(deadSupervisorSocket), `.supervisor-launch-${key}.lock`);
	}

	async function socketAccepts(socketPath: string): Promise<boolean> {
		return new Promise((resolveConnect) => {
			const socket = createConnection(socketPath);
			socket.once("connect", () => {
				socket.destroy();
				resolveConnect(true);
			});
			socket.once("error", () => resolveConnect(false));
		});
	}

	it("exits a never-claimed spare on its unclaimed lifetime", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-warm-spare-unclaimed-"));
		roots.push(root);
		setEnv(UNCLAIMED_EXIT_ENV, "150");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const { socketPath } = await startSpareWorker(root);
		expect(await socketAccepts(socketPath)).toBe(true);

		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 10_000, interval: 25 });
		expect(await socketAccepts(socketPath)).toBe(false);
	});

	it("never resurrects a dead supervisor and exits inside the short orphan window", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-warm-spare-orphan-"));
		roots.push(root);
		setEnv(ORPHAN_EXIT_ENV, "100");
		// The unclaimed lifetime must not beat the orphan path to the exit.
		setEnv(UNCLAIMED_EXIT_ENV, "60000");
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const deadSupervisorSocket = join(root, "dead-supervisor.sock");
		const { socketPath } = await startSpareWorker(root);

		// The monitor's first round is armed at 1.5s, the succession grace adds 5s;
		// the exit must land well inside the test budget and without a launch lock.
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 30_000, interval: 50 });
		expect(existsSync(supervisorLaunchLockPath(deadSupervisorSocket))).toBe(false);
		expect(await socketAccepts(socketPath)).toBe(false);
	}, 40_000);

	it("a worker without the spare marker keeps the stock monitor behavior", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-warm-spare-control-"));
		roots.push(root);
		setEnv(SUPERVISOR_REGISTRY_DIR_ENV, isolatedSupervisorRegistryEnv(root)[SUPERVISOR_REGISTRY_DIR_ENV]);
		setEnv(UNCLAIMED_EXIT_ENV, "150");
		setEnv(ORPHAN_EXIT_ENV, "100");
		// A live (but never authenticating) supervisor: the monitor probes it, never
		// launches a replacement, and stays on the slow tier. No spare marker means
		// the unclaimed self-exit never arms either.
		const liveSupervisor = createServer((socket) => socket.destroy());
		const liveSupervisorSocket = join(root, "live-supervisor.sock");
		await new Promise<void>((resolveListen) => liveSupervisor.listen(liveSupervisorSocket, resolveListen));
		setEnv(DAEMON_WORKER_SUPERVISOR_SOCKET_ENV, liveSupervisorSocket);
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
		const socketPath = join(root, "worker.sock");
		const daemon = new AgentDaemon(socketPath, {
			defaultSessionConfig: { agentDir: join(root, "agent"), cwd: root },
			createRuntime: vi.fn(),
			worker: { authenticationToken: "plain-token" },
		});
		await daemon.start();
		try {
			await new Promise((resolveWait) => setTimeout(resolveWait, 500));
			expect(exit).not.toHaveBeenCalled();
			expect(await socketAccepts(socketPath)).toBe(true);
		} finally {
			liveSupervisor.close();
		}
	});
});
