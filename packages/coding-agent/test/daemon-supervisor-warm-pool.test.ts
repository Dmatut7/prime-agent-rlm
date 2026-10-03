import type { ChildProcess, SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { type LogEntry, setLogSink } from "@earendil-works/pi-ai";
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
	// Test hooks for the warming/failed states: a listen delay keeps a spare in
	// "warming", and failNextSpawn makes the next spawn a child that exits at
	// once with no server behind it.
	listenDelayMs: 0,
	failNextSpawn: false,
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
		const listen = () => server.listen(socketPath, () => resolveListen());
		// A listen delay keeps the spare in its warming state for the tests that
		// exercise a claim racing the warm-up.
		if (hoisted.listenDelayMs > 0) {
			setTimeout(listen, hoisted.listenDelayMs);
		} else {
			listen();
		}
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
			if (hoisted.failNextSpawn) {
				hoisted.failNextSpawn = false;
				// A spare whose process dies right after spawn: no server behind the
				// socket, so the listen probe observes the exit and fails the warm-up.
				const child = actual.spawn(process.execPath, ["-e", "process.exit(42)"], { stdio: "ignore" });
				const stderr = new PassThrough();
				const gate = new PassThrough();
				Object.assign(child, { stdio: [null, null, stderr, gate], stderr });
				const stub: FakeWorkerServer = {
					socketPath,
					commands: [],
					connectionCount: () => 0,
					failWorkerAuth: () => undefined,
					close: async () => undefined,
				};
				hoisted.spawned.push({ args: [...args], env, cwd, socketPath, child, server: Promise.resolve(stub) });
				return child;
			}
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
/** Structured-log capture for the warm-pool telemetry stream (the public seam). */
const logEntries: LogEntry[] = [];

interface WarmPoolTotals {
	spawns: { ready: number; failed: number };
	claims: { hit: number; miss: number; expired: number };
	reclaims: Record<string, number>;
}

function warmPoolEvents(event: "spawn" | "claim" | "reclaim"): LogEntry[] {
	return logEntries.filter(
		(entry) => entry.component === "coding-agent.daemon-supervisor" && entry.msg === `warm pool ${event}`,
	);
}

function eventTotals(entry: LogEntry): WarmPoolTotals {
	return entry.totals as WarmPoolTotals;
}

function eventDepth(entry: LogEntry): { ready: number; warming: number } {
	return entry.depth as { ready: number; warming: number };
}

afterEach(async () => {
	hoisted.listenDelayMs = 0;
	hoisted.failNextSpawn = false;
	setLogSink(undefined);
	logEntries.length = 0;
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
	claimWarmingWaitMs?: number;
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

	it("resumes a cwd-stripped sessionPath create in the session's stored cwd, claiming that cwd's spare", async () => {
		setLogSink((entry) => {
			logEntries.push(entry);
		});
		const { agentDir, projectDir, otherProjectDir, client } = await startPoolSupervisor({
			ttlMs: 30_000,
			spawnCooldownMs: 0,
		});
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		expect(hoisted.spawned[0]!.cwd).toBe(projectDir);

		// A live session in the other project leaves a stocked spare behind for it.
		const first = await client.request({ type: "create", config: { cwd: otherProjectDir } }, 10_000);
		expect(first.success).toBe(true);
		await waitForCondition(
			() =>
				hoisted.spawned.some(
					(spawn) => spawn.cwd === otherProjectDir && spawn.env[DAEMON_WORKER_WARM_SPARE_ENV] === "1",
				),
			"the other-project spare",
		);
		const otherSpare = hoisted.spawned.find(
			(spawn) => spawn.cwd === otherProjectDir && spawn.env[DAEMON_WORKER_WARM_SPARE_ENV] === "1",
		)!;
		const otherSpareServer = await otherSpare.server;

		// The agents-view resume shape after an empty-session eviction: sessionPath
		// set with config.cwd stripped, so the session's own stored directory must
		// drive both the spawn cwd and the warm-pool claim key.
		const sessionDir = join(agentDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		const sessionFile = join(sessionDir, "stored-cwd.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "stored-cwd",
				timestamp: new Date().toISOString(),
				cwd: otherProjectDir,
			})}\n`,
			{ mode: 0o600 },
		);

		const resumed = await client.request({ type: "create", sessionPath: sessionFile, config: {} }, 10_000);
		expect(resumed.success).toBe(true);
		// The fake worker's summary reports its spawn cwd: the stored cwd's spare
		// serves the resume, not the daemon-default spare.
		const summary = responseData(resumed) as { cwd?: string };
		expect(summary.cwd).toBe(otherProjectDir);
		expect(otherSpareServer.commands).toContain("create");

		// The claim telemetry pins the key, and the pooled projectDir spare was
		// never touched by this create.
		const claims = warmPoolEvents("claim");
		expect(claims.length).toBeGreaterThan(0);
		expect(claims.some((entry) => entry.outcome === "hit" && entry.cwd === otherProjectDir)).toBe(true);
		const projectSpareServer = await hoisted.spawned[0]!.server;
		expect(projectSpareServer.commands).not.toContain("create");
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

	it("claims a still-warming spare after a bounded wait instead of launching cold", async () => {
		hoisted.listenDelayMs = 400;
		const { projectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, claimWarmingWaitMs: 5_000 });
		// Fire the create while the spare is still warming (its server has not
		// listened yet). The claim waits for the warm handoff.
		const response = await client.request({ type: "create", config: { cwd: projectDir } }, 15_000);
		expect(response.success).toBe(true);
		const summary = responseData(response) as { activeSessionId?: string; id: string };
		// The warming spare itself served the create: the session carries the
		// spare's pre-seeded id, and the only other spawn is the marked replenish.
		expect(hoisted.spawned).toHaveLength(2);
		expect(summary.activeSessionId ?? summary.id).toBe(hoisted.spawned[0]!.env[ACTIVE_SESSION_ENV_LITERAL]!);
		expect(hoisted.spawned[1]!.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBe("1");
	});

	it("falls back to a cold launch when the warming spare outlives the wait, without losing the spare", async () => {
		hoisted.listenDelayMs = 1_500;
		const { projectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, claimWarmingWaitMs: 100 });
		const response = await client.request({ type: "create", config: { cwd: projectDir } }, 15_000);
		expect(response.success).toBe(true);
		const summary = responseData(response) as { activeSessionId?: string; id: string };
		// The cold launch served the create; the warming spare was not discarded.
		expect(hoisted.spawned).toHaveLength(2);
		expect(summary.activeSessionId ?? summary.id).toBe(hoisted.spawned[1]!.env[ACTIVE_SESSION_ENV_LITERAL]!);
		expect(hoisted.spawned[1]!.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBeUndefined();
		const warmingChild = hoisted.spawned[0]!.child;
		expect(warmingChild.exitCode === null && warmingChild.signalCode === null).toBe(true);
		// Once the warm-up finishes, the spare publishes and serves the next create.
		// Wait for its server to listen first so the claim cannot race the publish.
		await waitForCondition(() => existsSync(hoisted.spawned[0]!.socketPath), "the warming spare listen");
		await new Promise((resolveWait) => setTimeout(resolveWait, 150));
		const second = await client.request({ type: "create", config: { cwd: projectDir } }, 15_000);
		expect(second.success).toBe(true);
		const secondSummary = responseData(second) as { activeSessionId?: string; id: string };
		expect(secondSummary.activeSessionId ?? secondSummary.id).toBe(
			hoisted.spawned[0]!.env[ACTIVE_SESSION_ENV_LITERAL]!,
		);
	});

	it("records a terminal warm-up failure and stops spawning for the cooldown window", async () => {
		hoisted.failNextSpawn = true;
		const { projectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, spawnCooldownMs: 60_000 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		await waitForProcessExit(hoisted.spawned[0]!.child);
		// Let the failed warm-up settle: the failure record is written when the
		// listen probe observes the exit.
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));

		const response = await client.request({ type: "create", config: { cwd: projectDir } }, 15_000);
		expect(response.success).toBe(true);
		// The failed spare is gone; the create went cold. The cooldown then blocks
		// the replenish, so no spare spawn storms a broken setup.
		expect(hoisted.spawned).toHaveLength(2);
		expect(hoisted.spawned[1]!.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBeUndefined();
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));
		expect(hoisted.spawned).toHaveLength(2);
	});

	it("clears the failed state once a later warm-up succeeds", async () => {
		hoisted.failNextSpawn = true;
		const { projectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, spawnCooldownMs: 200 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		await waitForProcessExit(hoisted.spawned[0]!.child);
		await new Promise((resolveWait) => setTimeout(resolveWait, 300));

		// Past the cooldown, the create's replenish spawns a healthy spare again.
		const response = await client.request({ type: "create", config: { cwd: projectDir } }, 15_000);
		expect(response.success).toBe(true);
		await waitForCondition(() => hoisted.spawned.length === 3, "the post-cooldown replenish spare");
		expect(hoisted.spawned[2]!.env[DAEMON_WORKER_WARM_SPARE_ENV]).toBe("1");
		const replenishedChild = hoisted.spawned[2]!.child;
		expect(replenishedChild.exitCode === null && replenishedChild.signalCode === null).toBe(true);
	});

	it("keeps the pooled spare alive across unrelated session lifecycle traffic", async () => {
		const { projectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, spawnCooldownMs: 0 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");

		// Claim the spare, then drive session-scoped lifecycle traffic through the
		// supervisor: a settings-shaped mutation (set_model), a plugin reload, and
		// finally a kill. None of it touches the pool.
		const first = await client.request({ type: "create", config: { cwd: projectDir } }, 10_000);
		expect(first.success).toBe(true);
		const firstSummary = responseData(first) as { activeSessionId?: string; id: string };
		const activeSessionId = firstSummary.activeSessionId ?? firstSummary.id;
		await waitForCondition(() => hoisted.spawned.length === 2, "the replenish spare");
		const replenished = hoisted.spawned[1]!;

		const setModel = await client.request(
			{ type: "set_model", activeSessionId, provider: "test", modelId: "model" },
			5_000,
		);
		expect(setModel.success).toBe(true);
		const reload = await client.request({ type: "reload", activeSessionId }, 5_000);
		expect(reload.success).toBe(true);
		const kill = await client.request({ type: "kill", activeSessionId }, 5_000);
		expect(kill.success).toBe(true);

		// The replenished spare survived all of it and still claims on id parity.
		expect(replenished.child.exitCode === null && replenished.child.signalCode === null).toBe(true);
		const second = await client.request({ type: "create", config: { cwd: projectDir } }, 10_000);
		expect(second.success).toBe(true);
		const secondSummary = responseData(second) as { activeSessionId?: string; id: string };
		expect(secondSummary.activeSessionId ?? secondSummary.id).toBe(replenished.env[ACTIVE_SESSION_ENV_LITERAL]!);
	});

	it("emits spawn telemetry with outcome, duration, depth sample, and totals", async () => {
		setLogSink((entry) => {
			logEntries.push(entry);
		});
		await startPoolSupervisor({ ttlMs: 30_000 });
		await waitForCondition(() => warmPoolEvents("spawn").length === 1, "the spare spawn telemetry");

		const spawn = warmPoolEvents("spawn")[0]!;
		// Spawn and claim share the `outcome` result key; reclaim attributes by `reason`.
		expect(spawn.outcome).toBe("ready");
		expect(spawn.durationMs).toBeGreaterThanOrEqual(0);
		// The spare is still mid-publish at its own spawn event: counted as warming.
		expect(eventDepth(spawn)).toEqual({ ready: 0, warming: 1 });
		expect(eventTotals(spawn).spawns).toEqual({ ready: 1, failed: 0 });
	});

	it("emits claim hit telemetry with the spare's age", async () => {
		setLogSink((entry) => {
			logEntries.push(entry);
		});
		const { projectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, spawnCooldownMs: 0 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");

		const response = await client.request({ type: "create", config: { cwd: projectDir } }, 10_000);
		expect(response.success).toBe(true);

		const claims = warmPoolEvents("claim");
		expect(claims).toHaveLength(1);
		expect(claims[0]!.outcome).toBe("hit");
		expect(claims[0]!.cwd).toBe(projectDir);
		expect(claims[0]!.ageMs).toBeGreaterThanOrEqual(0);
		expect(eventTotals(claims[0]!).claims).toEqual({ hit: 1, miss: 0, expired: 0 });
	});

	it("emits claim miss telemetry with the mismatch reason and the pooled spare's age", async () => {
		setLogSink((entry) => {
			logEntries.push(entry);
		});
		const { projectDir, client } = await startPoolSupervisor({ ttlMs: 30_000, spawnCooldownMs: 0 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");

		const response = await client.request(
			{ type: "create", config: { cwd: projectDir }, launchEnv: { PRIME_AGENT_WARM_POOL_PROBE: "mismatch" } },
			10_000,
		);
		expect(response.success).toBe(true);

		const claims = warmPoolEvents("claim");
		expect(claims).toHaveLength(1);
		expect(claims[0]!.outcome).toBe("miss");
		expect(claims[0]!.missReason).toBe("env_mismatch");
		// The spare stayed pooled, so its age at the miss is part of the event.
		expect(claims[0]!.ageMs).toBeGreaterThanOrEqual(0);
		expect(eventTotals(claims[0]!).claims).toEqual({ hit: 0, miss: 1, expired: 0 });
	});

	it("emits reclaim telemetry bucketed by reason when the idle TTL expires", async () => {
		setLogSink((entry) => {
			logEntries.push(entry);
		});
		await startPoolSupervisor({ ttlMs: 400 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		await waitForCondition(() => warmPoolEvents("reclaim").length === 1, "the TTL reclaim telemetry");

		const reclaim = warmPoolEvents("reclaim")[0]!;
		expect(reclaim.reason).toBe("ttl_expired");
		expect(reclaim.ageMs).toBeGreaterThanOrEqual(0);
		// The disposal removes the spare before the event: the pool reads empty.
		expect(eventDepth(reclaim)).toEqual({ ready: 0, warming: 0 });
		expect(eventTotals(reclaim).reclaims.ttl_expired).toBe(1);
	});

	it("attributes a failed claim health check as a miss and a claim_failed reclaim", async () => {
		setLogSink((entry) => {
			logEntries.push(entry);
		});
		const { projectDir, client } = await startPoolSupervisor({
			ttlMs: 30_000,
			spawnCooldownMs: 0,
			claimConnectTimeoutMs: 500,
		});
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		const spareServer = await hoisted.spawned[0]!.server;
		spareServer.failWorkerAuth("warm spare auth broken");

		const response = await client.request({ type: "create", config: { cwd: projectDir } }, 10_000);
		expect(response.success).toBe(true);

		const claims = warmPoolEvents("claim");
		const healthCheckMisses = claims.filter((entry) => entry.missReason === "claim_check_failed");
		expect(healthCheckMisses).toHaveLength(1);
		expect(healthCheckMisses[0]!.outcome).toBe("miss");
		expect(healthCheckMisses[0]!.ageMs).toBeGreaterThanOrEqual(0);
		// The cold retry inside the create claims nothing: the pool is empty, so a
		// no_ready_spare miss is the only other claim event.
		expect(claims.filter((entry) => entry.missReason === "no_ready_spare")).toHaveLength(1);
		expect(claims.some((entry) => entry.outcome === "hit")).toBe(false);

		const reclaims = warmPoolEvents("reclaim");
		expect(reclaims.map((entry) => entry.reason)).toEqual(["claim_failed"]);
		expect(eventTotals(reclaims[0]!).reclaims.claim_failed).toBe(1);
	});

	it("attributes pooled spares to the drain bucket when the supervisor shuts down", async () => {
		setLogSink((entry) => {
			logEntries.push(entry);
		});
		const { supervisor } = await startPoolSupervisor({ ttlMs: 30_000 });
		await waitForCondition(() => hoisted.spawned.length === 1, "the startup spare spawn");
		// The spare must be fully published first, or the drain races the publish
		// and the spare is attributed to pool_closed instead of drain. The
		// operational "ready" line goes through the same structured sink.
		await waitForCondition(
			() => logEntries.some((entry) => entry.msg.startsWith("Warm spare worker") && entry.msg.includes("ready for")),
			"the spare publish",
		);

		await supervisor.dispose();

		const reclaims = warmPoolEvents("reclaim");
		expect(reclaims).toHaveLength(1);
		expect(reclaims[0]!.reason).toBe("drain");
		expect(reclaims[0]!.detail).toBe("supervisor dispose");
		expect(eventTotals(reclaims[0]!).reclaims.drain).toBe(1);
	});
});
