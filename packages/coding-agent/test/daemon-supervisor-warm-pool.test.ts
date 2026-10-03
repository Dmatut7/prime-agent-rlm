import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { DaemonCatalogClient } from "../src/modes/daemon/daemon-catalog-process.js";
import { DaemonClient } from "../src/modes/daemon/daemon-client.js";
import { DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES, type DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_WARM_SPARE_ENV,
} from "../src/modes/daemon/daemon-worker-protocol.js";
import {
	isolatedSupervisorRegistryEnv,
	SUPERVISOR_REGISTRY_DIR_ENV,
} from "./fixtures/supervisor-registry-isolation.js";

/**
 * Warm-pool supervisor tests. Everything is observed through public seams: the
 * client wire protocol, the descriptor directory, and the node:child_process
 * spawn boundary (the same module mock the launch tests use). A spawned
 * "worker" is a real stand-in process (so pid/liveness/signals are honest) plus
 * an in-process socket server speaking the worker framing.
 *
 * The mock factory is deliberately self-contained: importing a repo fixture
 * from inside it deadlocks the module graph, because the fixture transitively
 * imports the mocked module. The server builder therefore lives at module level
 * and is late-bound through the hoisted state (the factory only runs it when a
 * spawn happens, long after the module body evaluated).
 */

const ACTIVE_SESSION_ENV_LITERAL = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID";
const WORKER_ROSTER_CAPABILITY_LITERAL = "agent_roster";

interface FakeWorkerServer {
	socketPath: string;
	commands: string[];
	connectionCount(): number;
	failWorkerAuth(message: string): void;
	close(): Promise<void>;
}

interface SpawnedFakeWorker {
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string | undefined;
	socketPath: string;
	child: ChildProcess;
	server: Promise<FakeWorkerServer>;
}

const hoisted = vi.hoisted(() => ({
	spawned: [] as SpawnedFakeWorker[],
	startServer: undefined as
		| undefined
		| ((
				socketPath: string,
				activeSessionId: string,
				cwd: string,
				onShutdownRequest: () => void,
		  ) => Promise<FakeWorkerServer>),
}));

function encodeFrame(header: object, payload: Buffer): Buffer {
	const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
	const frame = Buffer.alloc(8 + headerBuf.length + payload.length);
	frame.writeUInt32BE(headerBuf.length, 0);
	frame.writeUInt32BE(payload.length, 4);
	headerBuf.copy(frame, 8);
	payload.copy(frame, 8 + headerBuf.length);
	return frame;
}

async function startFakeWorkerServer(
	socketPath: string,
	activeSessionId: string,
	cwd: string,
	onShutdownRequest: () => void,
): Promise<FakeWorkerServer> {
	mkdirSync(dirname(socketPath), { recursive: true });
	const summary = {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: `session-${activeSessionId}`,
		sessionFile: join(cwd, `fake-${activeSessionId}.jsonl`),
		cwd,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
	const commands: string[] = [];
	const sockets = new Set<Socket>();
	let authFailure: string | undefined;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => sockets.delete(socket));
		const respond = (requestId: string, command: string, body: Record<string, unknown>): void => {
			if (socket.destroyed) {
				return;
			}
			socket.write(
				encodeFrame(
					{ kind: "outbound", outboundType: "response", requestId },
					Buffer.from(`${JSON.stringify({ id: requestId, type: "response", command, ...body })}\n`),
				),
			);
		};
		socket.write(
			encodeFrame({ kind: "outbound", outboundType: "daemon_hello" }, Buffer.from('{"type":"daemon_hello"}\n')),
		);
		let pending: Buffer = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => {
			pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			while (pending.length >= 8) {
				const headerLength = pending.readUInt32BE(0);
				const payloadLength = pending.readUInt32BE(4);
				if (pending.length < 8 + headerLength + payloadLength) {
					break;
				}
				let header: { kind?: string; requestId?: string; commandType?: string };
				let command: { type?: string };
				try {
					header = JSON.parse(pending.subarray(8, 8 + headerLength).toString("utf8")) as typeof header;
					command = JSON.parse(
						pending.subarray(8 + headerLength, 8 + headerLength + payloadLength).toString("utf8"),
					) as typeof command;
				} catch {
					break;
				}
				pending = pending.subarray(8 + headerLength + payloadLength);
				if (header.kind !== "command" || typeof header.requestId !== "string") {
					continue;
				}
				const type = command.type ?? header.commandType ?? "unknown";
				commands.push(type);
				// A shutdown is answered even by a wedged worker: the stand-in process
				// has to leave when the supervisor stops it, or a stop waits forever.
				if (type === "shutdown" || type === "worker_archive_and_shutdown") {
					respond(header.requestId, type, { success: true });
					onShutdownRequest();
					continue;
				}
				if (type === "worker_auth") {
					if (authFailure !== undefined) {
						respond(header.requestId, type, { success: false, error: authFailure });
					} else {
						respond(header.requestId, type, {
							success: true,
							data: { capabilities: [WORKER_ROSTER_CAPABILITY_LITERAL] },
						});
					}
					continue;
				}
				if (type === "create") {
					respond(header.requestId, type, { success: true, data: summary });
					continue;
				}
				if (type === "list") {
					respond(header.requestId, type, { success: true, data: { sessions: [summary] } });
					continue;
				}
				respond(header.requestId, type, { success: true });
			}
		});
	});
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(socketPath, () => resolveListen());
	});
	return {
		socketPath,
		commands,
		connectionCount: () => sockets.size,
		failWorkerAuth(message: string): void {
			authFailure = message;
		},
		close: async () => {
			for (const socket of [...sockets]) {
				socket.destroy();
			}
			sockets.clear();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

hoisted.startServer = startFakeWorkerServer;

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
		const socketFlag = Array.isArray(args) ? args.indexOf("--daemon-socket") : -1;
		const socketPath = socketFlag >= 0 ? String(args[socketFlag + 1]) : "";
		// Only worker spawns are faked (their socket is worker-*); a supervisor
		// relaunch or any helper process falls through to the real spawn.
		if (socketFlag >= 0 && basename(socketPath).startsWith("worker-")) {
			const env = (options.env ?? {}) as NodeJS.ProcessEnv;
			const activeSessionId = env[ACTIVE_SESSION_ENV_LITERAL] ?? "active-unknown";
			const cwd = options.cwd ? String(options.cwd) : undefined;
			// A real process backs the fake child so pid liveness and signals are real.
			const child = actual.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			const stderr = new PassThrough();
			const gate = new PassThrough();
			Object.assign(child, { stdio: [null, null, stderr, gate], stderr });
			const server = hoisted.startServer!(socketPath, activeSessionId, cwd ?? tmpdir(), () => {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGTERM");
				}
			});
			hoisted.spawned.push({ args: [...args], env, cwd, socketPath, child, server });
			return child;
		}
		return actual.spawn(command, args as string[], options);
	};
	return { ...actual, spawn: spawn as typeof actual.spawn };
});

const tempDirs: string[] = [];
const supervisors: DaemonSupervisor[] = [];
const clients: DaemonClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) {
		client.close();
	}
	for (const supervisor of supervisors.splice(0)) {
		await supervisor.dispose().catch(() => undefined);
	}
	for (const spawned of hoisted.spawned.splice(0)) {
		const handle = await spawned.server.catch(() => undefined);
		await handle?.close().catch(() => undefined);
		if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
			spawned.child.kill("SIGKILL");
		}
	}
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

interface PoolFixture {
	root: string;
	agentDir: string;
	projectDir: string;
	otherProjectDir: string;
	descriptorDir: string;
	supervisor: DaemonSupervisor;
	client: DaemonClient;
}

async function startPoolSupervisor(warmPool?: {
	ttlMs?: number;
	claimConnectTimeoutMs?: number;
	spawnCooldownMs?: number;
}): Promise<PoolFixture> {
	const root = mkdtempSync(join(tmpdir(), "prime-warm-pool-test-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const otherProjectDir = join(root, "other-project");
	const descriptorDir = join(agentDir, "daemon-workers");
	mkdirSync(projectDir, { recursive: true });
	mkdirSync(otherProjectDir, { recursive: true });
	mkdirSync(descriptorDir, { recursive: true });
	process.env[ENV_AGENT_DIR] = agentDir;
	process.env[SUPERVISOR_REGISTRY_DIR_ENV] = isolatedSupervisorRegistryEnv(root)[SUPERVISOR_REGISTRY_DIR_ENV];
	// The catalog subprocess is out of scope here, same as the shared harness.
	vi.spyOn(DaemonCatalogClient.prototype, "start").mockResolvedValue(undefined);
	vi.spyOn(DaemonCatalogClient.prototype, "archive").mockResolvedValue(true);
	const supervisor = new DaemonSupervisor(join(root, "daemon.sock"), {
		defaultSessionConfig: { cwd: projectDir, agentDir },
		descriptorDir,
		...(warmPool
			? // Tests opt into spares deterministically: the memory-pressure floor
				// would otherwise skip the prebuild on a loaded parallel shard.
				{ warmPool: { minFreeMemoryBytes: 0, ...warmPool } }
			: {}),
	});
	supervisors.push(supervisor);
	await supervisor.start();
	const client = new DaemonClient(join(root, "daemon.sock"), {
		declaredCapabilities: DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES,
	});
	clients.push(client);
	await client.connect(5_000);
	await client.waitForHello(5_000);
	return { root, agentDir, projectDir, otherProjectDir, descriptorDir, supervisor, client };
}

function descriptorNames(descriptorDir: string): string[] {
	return readdirSync(descriptorDir).filter((name) => name.endsWith(".json") && name !== "supervisor-config");
}

/** Narrow a daemon response to its success payload or fail the test with the error. */
function responseData(response: DaemonResponse): unknown {
	if (!response.success) {
		throw new Error(`daemon request failed: ${response.error}`);
	}
	return response.data;
}

async function waitForCondition(probe: () => boolean, description: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (probe()) {
			return;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 25));
	}
	throw new Error(`Timed out waiting for: ${description}`);
}

async function waitForProcessExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
	await waitForCondition(() => child.exitCode !== null || child.signalCode !== null, "worker process exit", timeoutMs);
}

describe("daemon supervisor warm spare pool", () => {
	it("keeps the mock's env literal in sync with the worker protocol", () => {
		// The mock factory cannot import src modules (module-graph reentrancy); it
		// keys on this literal, so a protocol rename must fail loudly here.
		expect(DAEMON_WORKER_ACTIVE_SESSION_ID_ENV).toBe(ACTIVE_SESSION_ENV_LITERAL);
	});

	it("prebuilds one spare at startup, invisible to list and the descriptor registry", async () => {
		const { projectDir, descriptorDir, client } = await startPoolSupervisor({ ttlMs: 30_000 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");

		const spare = hoisted.spawned[0]!;
		expect(spare.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBe("1");
		expect(spare.cwd).toBe(projectDir);
		const server = await spare.server;
		// Booted and listening, but never contacted: no claim has happened.
		expect(server.connectionCount()).toBe(0);

		const response = await client.request({ type: "list" }, 5_000);
		expect(response.success).toBe(true);
		const data = responseData(response) as { sessions?: unknown[] };
		expect(data.sessions ?? []).toHaveLength(0);
		// No descriptor, no roster row: recovery and enumeration cannot see a spare.
		expect(descriptorNames(descriptorDir)).toHaveLength(0);
	});

	it("claims the spare on a matching create without a new spawn, then replenishes", async () => {
		const { projectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, spawnCooldownMs: 0 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		const spare = hoisted.spawned[0]!;
		const spareActiveSessionId = spare.env[ACTIVE_SESSION_ENV_LITERAL]!;

		const response = await client.request({ type: "create", config: { cwd: projectDir } }, 10_000);
		expect(response.success).toBe(true);
		const summary = responseData(response) as { activeSessionId?: string; id: string };
		// The claimed spare's pre-allocated root id is what the session gets.
		expect(summary.activeSessionId ?? summary.id).toBe(spareActiveSessionId);
		// The claim itself spawned nothing: the only extra spawn is the marked
		// replenishment spare, recorded before the response returned.
		expect(hoisted.spawned).toHaveLength(2);
		expect(hoisted.spawned[1]!.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBe("1");
		const server = await spare.server;
		expect(server.commands).toContain("worker_auth");
		expect(server.commands).toContain("create");

		const list = await client.request({ type: "list" }, 5_000);
		const sessions = (responseData(list) as { sessions?: unknown[] }).sessions ?? [];
		expect(sessions).toHaveLength(1);

		// The replenished spare stays invisible.
		const replenished = await client.request({ type: "list" }, 5_000);
		expect((responseData(replenished) as { sessions?: unknown[] }).sessions ?? []).toHaveLength(1);
	});

	it("misses on a different cwd and cold-launches without the spare marker", async () => {
		const { otherProjectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, spawnCooldownMs: 0 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");

		const response = await client.request({ type: "create", config: { cwd: otherProjectDir } }, 10_000);
		expect(response.success).toBe(true);
		// One cold launch for the missed create plus its replenishment spare.
		expect(hoisted.spawned).toHaveLength(3);
		const cold = hoisted.spawned[1]!;
		expect(cold.cwd).toBe(otherProjectDir);
		expect(cold.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBeUndefined();
		// The original spare survived the miss and keeps waiting for its cwd.
		const sparedChild = hoisted.spawned[0]!.child;
		expect(sparedChild.exitCode === null && sparedChild.signalCode === null).toBe(true);
		// The replenish spare targets the create's own cwd.
		expect(hoisted.spawned[2]!.cwd).toBe(otherProjectDir);
		expect(hoisted.spawned[2]!.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBe("1");
	});

	it("misses when the client launch env differs from the spare's spawn environment", async () => {
		const { projectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, spawnCooldownMs: 0 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");

		const response = await client.request(
			{ type: "create", config: { cwd: projectDir }, launchEnv: { PRIME_AGENT_WARM_POOL_PROBE: "mismatch" } },
			10_000,
		);
		expect(response.success).toBe(true);
		expect(hoisted.spawned).toHaveLength(2);
		// The mismatch fell back to a cold launch, which carries no spare marker.
		expect(hoisted.spawned[1]!.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBeUndefined();
		expect(hoisted.spawned[1]!.env.PRIME_AGENT_WARM_POOL_PROBE).toBe("mismatch");
	});

	it("falls back to a cold launch when the spare fails the claim health check", async () => {
		const { projectDir, client } = await startPoolSupervisor({
			ttlMs: 30_000,
			spawnCooldownMs: 0,
			claimConnectTimeoutMs: 500,
		});
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		const spare = hoisted.spawned[0]!;
		const spareServer = await spare.server;
		spareServer.failWorkerAuth("warm spare auth broken");

		const response = await client.request({ type: "create", config: { cwd: projectDir } }, 10_000);
		expect(response.success).toBe(true);
		// The unhealthy spare was discarded; a cold worker served the create, and
		// the cold worker's replenish is the third spawn.
		expect(hoisted.spawned).toHaveLength(3);
		expect(hoisted.spawned[1]!.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBeUndefined();
		await waitForProcessExit(spare.child);
		const summary = responseData(response) as { activeSessionId?: string; id: string };
		const coldActiveSessionId = hoisted.spawned[1]!.env[ACTIVE_SESSION_ENV_LITERAL]!;
		expect(summary.activeSessionId ?? summary.id).toBe(coldActiveSessionId);
	});

	it("disposes a spare whose idle TTL expires", async () => {
		await startPoolSupervisor({ ttlMs: 400 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		const spare = hoisted.spawned[0]!;
		await waitForProcessExit(spare.child);
		// Nothing restocks an expired spare: no create happened.
		await new Promise((resolveWait) => setTimeout(resolveWait, 200));
		expect(hoisted.spawned).toHaveLength(1);
	});

	it("drains the pool when the supervisor shuts down", async () => {
		const { supervisor } = await startPoolSupervisor({ ttlMs: 30_000 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		const spare = hoisted.spawned[0]!;
		// dispose() is the in-process shutdown (the shutdown command would call
		// process.exit and take the test runner with it); it runs the same drain.
		await supervisor.dispose();
		await waitForProcessExit(spare.child);
		// The spare's socket file is gone too.
		await waitForCondition(() => !existsSync(spare.socketPath), "the spare socket cleanup");
	});

	it("drains the pool when an update restart starts preparing", async () => {
		const { client } = await startPoolSupervisor({ ttlMs: 30_000 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		const spare = hoisted.spawned[0]!;

		const response = await client.request({ type: "prepare_update_restart" }, 15_000);
		expect(response.success).toBe(true);
		await waitForProcessExit(spare.child);
		// The update fence keeps the pool empty: no replenish while prepared.
		await new Promise((resolveWait) => setTimeout(resolveWait, 200));
		expect(hoisted.spawned).toHaveLength(1);
	});
});
