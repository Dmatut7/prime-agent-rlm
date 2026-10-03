import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { probeDaemon } from "../src/cli/daemon-ps.js";
import {
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_COMMAND_PLANE,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES,
	DAEMON_FIRST_PARTY_SESSION_CAPABILITIES,
	DAEMON_SCHEMA_REVISION,
	DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES,
	type DaemonCommand,
	type DaemonWarmPoolStats,
	getDaemonCommandCompatibilities,
	isDaemonMutatingCommand,
	isSessionPlaneDaemonCommand,
	meetsDaemonCommandCompatibility,
	missingDeclaredCommandCapability,
	normalizeDeclaredCapabilities,
} from "../src/modes/daemon/daemon-protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * wave-39 POOL-CONSUME (rev 45): the get_warm_pool_stats command and the
 * warm_pool_stats capability. The supervisor answers with a DaemonWarmPoolStats
 * snapshot of the warm spare pool; the capability is supervisor-only because a
 * worker or standalone daemon owns no pool. Both compatibility directions are
 * pinned here: a new client must never send the command to a pre-45 daemon
 * (client-side preflight), and an old client's wire against a new daemon is
 * unchanged (the capability string it never heard of sits inert in the hello's
 * serverCapabilities).
 */

const GET_WARM_POOL_STATS: DaemonCommand = { type: "get_warm_pool_stats" };

describe("warm_pool_stats wire registration (rev 45)", () => {
	it("is a supervisor-only capability, advertised only where a pool exists", () => {
		// The supervisor's hello carries defaults + supervisor-only; a worker's or
		// standalone daemon's hello carries exactly DAEMON_DEFAULT_SERVER_CAPABILITIES
		// (daemon-mode.ts), which must NOT contain the capability: advertising it
		// there would promise a get_warm_pool_stats the standalone daemon answers
		// with "Unknown daemon command".
		expect(DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES).toEqual([
			"agent_roster",
			"direct_peer_transport",
			"warm_pool_stats",
		]);
		expect(DAEMON_DEFAULT_SERVER_CAPABILITIES).not.toContain("warm_pool_stats");
		const daemonModeSource = readFileSync(resolve(__dirname, "../src/modes/daemon/daemon-mode.ts"), "utf8");
		expect(daemonModeSource).toContain("serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES");
		// First-party clients may still declare it, or the server-side declared-set
		// gate would refuse their get_warm_pool_stats.
		expect(DAEMON_FIRST_PARTY_SESSION_CAPABILITIES).toContain("warm_pool_stats");
		expect(DAEMON_FIRST_PARTY_CONTROL_CAPABILITIES).toContain("warm_pool_stats");
		expect(normalizeDeclaredCapabilities(["warm_pool_stats"])).toEqual(["warm_pool_stats"]);
		expect(DAEMON_SCHEMA_REVISION).toBeGreaterThanOrEqual(45);
	});

	it("gates get_warm_pool_stats on the capability and its introducing revision", () => {
		expect(DAEMON_COMMAND_COMPATIBILITY.get_warm_pool_stats).toEqual({
			minProtocol: 7,
			minSchemaRevision: 45,
			capability: "warm_pool_stats",
		});
		// No conditional compatibilities: the bare command carries the whole gate.
		expect(getDaemonCommandCompatibilities(GET_WARM_POOL_STATS)).toEqual([
			DAEMON_COMMAND_COMPATIBILITY.get_warm_pool_stats,
		]);
		// Pool state is daemon-global: the command routes to the supervisor, never
		// to a direct worker link, and is a pure read (no mutation journal entry).
		expect(DAEMON_COMMAND_PLANE.get_warm_pool_stats).toBe("control");
		expect(isSessionPlaneDaemonCommand("get_warm_pool_stats")).toBe(false);
		expect(isDaemonMutatingCommand(GET_WARM_POOL_STATS)).toBe(false);
	});

	it("server-side gate refuses declared connections lacking the capability, and keeps the legacy path", () => {
		// A connection that declared a command-capability set must include
		// warm_pool_stats to send the command...
		expect(missingDeclaredCommandCapability(true, new Set(["event_sequence"]), GET_WARM_POOL_STATS)).toBe(
			"warm_pool_stats",
		);
		expect(missingDeclaredCommandCapability(true, new Set(["warm_pool_stats"]), GET_WARM_POOL_STATS)).toBeUndefined();
		// ...while an undeclared (legacy) connection keeps the old path, exactly like
		// every other capability-gated command.
		expect(missingDeclaredCommandCapability(undefined, undefined, GET_WARM_POOL_STATS)).toBeUndefined();
	});

	it("stops a new client from sending get_warm_pool_stats to a pre-45 daemon", () => {
		// Old-daemon direction: the hello advertises neither the revision nor the
		// capability, so the client-side preflight (daemon-client.ts request())
		// refuses to send the command instead of letting the old daemon answer
		// "Unknown daemon command".
		const gate = getDaemonCommandCompatibilities(GET_WARM_POOL_STATS)[0]!;
		const oldSupervisorHello = {
			protocol: { name: "prime-agent.daemon" as const, version: 7 },
			schemaRevision: 44,
			serverCapabilities: ["attach_snapshot", "event_sequence", "agent_roster", "direct_peer_transport"] as const,
		};
		expect(meetsDaemonCommandCompatibility(oldSupervisorHello, gate)).toBe(false);
		// A rev-45 standalone daemon (no supervisor, no pool) advertises the revision
		// but not the capability; the gate still refuses.
		const standaloneHello = {
			protocol: { name: "prime-agent.daemon" as const, version: 7 },
			schemaRevision: DAEMON_SCHEMA_REVISION,
			serverCapabilities: [...DAEMON_DEFAULT_SERVER_CAPABILITIES],
		};
		expect(meetsDaemonCommandCompatibility(standaloneHello, gate)).toBe(false);
		const newSupervisorHello = {
			protocol: { name: "prime-agent.daemon" as const, version: 7 },
			schemaRevision: DAEMON_SCHEMA_REVISION,
			serverCapabilities: [...DAEMON_DEFAULT_SERVER_CAPABILITIES, ...DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES],
		};
		expect(meetsDaemonCommandCompatibility(newSupervisorHello, gate)).toBe(true);
	});

	it("keeps the old client's wire against a new daemon unchanged", () => {
		// Old-client direction: a pre-45 client never sends get_warm_pool_stats; what
		// it does send must keep its pre-45 gates. Pin the legacy rows an old CLI
		// relies on, and note that the unknown capability string in the new hello's
		// serverCapabilities is inert for it (old clients read the array only for
		// the strings they know).
		expect(DAEMON_COMMAND_COMPATIBILITY.list).toEqual({ minProtocol: 7 });
		expect(DAEMON_COMMAND_COMPATIBILITY.attach).toEqual({ minProtocol: 7 });
		expect(DAEMON_COMMAND_COMPATIBILITY.get_state).toEqual({ minProtocol: 7 });
		expect(DAEMON_COMMAND_COMPATIBILITY.abort).toEqual({ minProtocol: 7 });
	});

	it("pins the reclaim attribution buckets the wire shares with the telemetry stream", () => {
		// The reclaims record's key set is the wire contract the warm-pool-stats
		// analyzer (scripts/warm-pool-stats.mjs) and the status line both read; a
		// bucket rename must fail loudly here.
		const stats: DaemonWarmPoolStats = {
			enabled: true,
			depth: { ready: 1, warming: 0 },
			spares: [{ cwd: "/repo", workerId: "worker-1", ageMs: 50, expiresInMs: 299_950 }],
			cooldowns: [],
			totals: {
				spawns: { ready: 1, failed: 0 },
				claims: { hit: 1, miss: 0, expired: 0 },
				reclaims: {
					ttl_expired: 0,
					exited: 0,
					memory_pressure: 0,
					pool_closed: 0,
					claim_failed: 0,
					drain: 0,
				},
			},
			config: { ttlMs: 300_000, maxSpares: 1 },
		};
		expect(Object.keys(stats.totals.reclaims).sort()).toEqual(
			["claim_failed", "drain", "exited", "memory_pressure", "pool_closed", "ttl_expired"].sort(),
		);
		expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
	});
});

// ---------------------------------------------------------------------------
// probeDaemon (the status/ps client) against fake daemons of both eras
// ---------------------------------------------------------------------------

interface FakeDaemonOptions {
	schemaRevision: number;
	serverCapabilities: string[];
	warmPoolStats?: DaemonWarmPoolStats;
}

interface FakeDaemon {
	socketPath: string;
	/** Command types the fake daemon received, in order. */
	received: string[];
	close(): Promise<void>;
}

interface FakeIncomingLine {
	id?: string;
	type?: string;
	command?: { id?: string; type?: string };
}

const tempDirs: string[] = [];
const servers: Server[] = [];

/**
 * A minimal daemon speaking the public JSONL protocol: hello on connect, then a
 * success response per command (unwrapping the protocol-7 command envelope).
 * declare_client_capabilities must be answered or the declaring client parks on
 * its 3s wait; list answers with zero sessions; get_warm_pool_stats answers with
 * the fixture payload.
 */
async function startFakeDaemon(options: FakeDaemonOptions): Promise<FakeDaemon> {
	const directory = mkdtempSync(join(tmpdir(), "prime-warm-pool-fake-daemon-"));
	tempDirs.push(directory);
	const socketPath = join(directory, "daemon.sock");
	const received: string[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => sockets.delete(socket));
		socket.write(
			`${JSON.stringify({
				type: "daemon_hello",
				socketPath,
				protocol: { name: "prime-agent.daemon", version: 7 },
				schemaId: `protocol-7-schema-${options.schemaRevision}-fakefakefake`,
				schemaRevision: options.schemaRevision,
				appVersion: "0.0.0-fake",
				clientId: "fake-daemon-client",
				serverCapabilities: options.serverCapabilities,
			})}\n`,
		);
		let pending = "";
		socket.on("data", (chunk) => {
			pending += chunk.toString("utf8");
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline < 0) break;
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				let parsed: FakeIncomingLine;
				try {
					parsed = JSON.parse(line) as FakeIncomingLine;
				} catch {
					continue;
				}
				const command = parsed.type === "command" ? parsed.command : parsed;
				const type = command?.type;
				const id = command?.id ?? parsed.id;
				if (typeof type !== "string" || typeof id !== "string") continue;
				received.push(type);
				const data =
					type === "list" ? { sessions: [] } : type === "get_warm_pool_stats" ? options.warmPoolStats : undefined;
				socket.write(
					`${JSON.stringify({ id, type: "response", command: type, success: true, ...(data === undefined ? {} : { data }) })}\n`,
				);
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(socketPath, () => resolveListen());
	});
	return {
		socketPath,
		received,
		close: async () => {
			for (const socket of [...sockets]) socket.destroy();
			sockets.clear();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

const FAKE_POOL_STATS: DaemonWarmPoolStats = {
	enabled: true,
	depth: { ready: 1, warming: 0 },
	spares: [{ cwd: "/repo", workerId: "worker-warm-1", ageMs: 12_000, expiresInMs: 288_000 }],
	cooldowns: [],
	totals: {
		spawns: { ready: 2, failed: 0 },
		claims: { hit: 1, miss: 1, expired: 0 },
		reclaims: { ttl_expired: 1, exited: 0, memory_pressure: 0, pool_closed: 0, claim_failed: 0, drain: 0 },
	},
	config: { ttlMs: 300_000, maxSpares: 1 },
};

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	}
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

describe("probeDaemon warm pool capability gating", () => {
	it("never sends get_warm_pool_stats to a pre-45 daemon and reports no pool", async () => {
		// New client + old daemon: the hello lacks the capability, so the probe must
		// leave the command unsent and the field absent - the old daemon's wire is
		// byte-identical to before rev 45.
		const daemon = await startFakeDaemon({
			schemaRevision: 44,
			serverCapabilities: ["attach_snapshot", "event_sequence", "agent_roster", "direct_peer_transport"],
		});
		const probe = await probeDaemon(daemon.socketPath);
		expect(probe.reachable).toBe(true);
		expect(probe.answeredProbe).toBe(true);
		expect(probe.warmPool).toBeUndefined();
		expect(daemon.received).toContain("list");
		expect(daemon.received).not.toContain("get_warm_pool_stats");
	});

	it("never sends get_warm_pool_stats to a rev-45 standalone daemon that cannot serve it", async () => {
		// The standalone daemon advertises the revision but not the (supervisor-only)
		// capability; the probe keys on the capability, not the number.
		const daemon = await startFakeDaemon({
			schemaRevision: DAEMON_SCHEMA_REVISION,
			serverCapabilities: [...DAEMON_DEFAULT_SERVER_CAPABILITIES],
		});
		const probe = await probeDaemon(daemon.socketPath);
		expect(probe.warmPool).toBeUndefined();
		expect(daemon.received).not.toContain("get_warm_pool_stats");
	});

	it("reads the pool snapshot from a daemon that advertises warm_pool_stats", async () => {
		// New client + new daemon: capability advertised, the command is sent and its
		// payload lands on the probe result for the status/ps views.
		const daemon = await startFakeDaemon({
			schemaRevision: DAEMON_SCHEMA_REVISION,
			serverCapabilities: [...DAEMON_DEFAULT_SERVER_CAPABILITIES, ...DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES],
			warmPoolStats: FAKE_POOL_STATS,
		});
		const probe = await probeDaemon(daemon.socketPath);
		expect(probe.warmPool).toEqual(FAKE_POOL_STATS);
		expect(daemon.received).toContain("get_warm_pool_stats");
	});
});
