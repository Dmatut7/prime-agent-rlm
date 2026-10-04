/**
 * Warm-pool cluster extracted from daemon-supervisor.ts (wave-48, the first
 * Host-seam cut on the supervisor): the warm spare pool (wave-32) of pre-booted,
 * never-claimed workers keyed by cwd. A claim replaces the cold spawn+module-graph
 * segment of a create with a health check; every miss or unhealthy spare falls
 * back to the cold launch path. The moved methods keep exactly the same bodies;
 * they read the supervisor through {@link DaemonSupervisorWarmPoolHost}, so the
 * move changes no runtime behavior. The eight entry points keep one-line shells
 * on the class (takeWarmSpare / ensureWarmSpare / drainWarmPool /
 * handleGetWarmPoolStats / startWarmPoolSweep / logWarmPoolTelemetry /
 * recordWarmPoolClaimMiss / recordWarmSpareReclaim), and moved code keeps calling
 * those three telemetry/attribution methods through the host so the dispatch
 * still lands on the instance exactly as it did before the move. Cluster-internal
 * helpers (spawnWarmSpare / probeWarmSpareListening / cleanWarmSpareFiles /
 * disposeWarmSpare / sweepWarmPool) are module-private and called directly — no
 * test or caller ever named them on the class.
 *
 * Two adaptations from the agent-session Host-seam precedent: DaemonSupervisor
 * members are `private`-keyworded (AgentSession uses the underscore-public
 * convention), so `this` cannot satisfy the host interface structurally — the
 * class instead exposes `warmPoolHost`, a facade of live getters and arrows
 * built inside the class (no casts, no visibility changes). And the pool state
 * (options, the three lazy maps, telemetry totals, sweep timer, pressure-log
 * stamp) moved with the cluster as {@link WarmPoolState}; the class holds one
 * lazily-created instance, preserving the prototype-harness semantics the lazy
 * getters existed for.
 *
 * This module imports ./daemon-supervisor.js for types only; the value-level
 * import graph stays acyclic. The wire face (get_warm_pool_stats, rev 45,
 * capability warm_pool_stats) is unchanged — DaemonWarmPoolStats and
 * DaemonWarmPoolReclaimReason live in ./daemon-protocol.js and their spelling is
 * protocol-frozen.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { getLogger } from "@earendil-works/pi-ai";
import { createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import { isProcessAlive } from "../../utils/child-process.js";
import { sleep } from "../../utils/sleep.js";
import { createActiveSessionId } from "./active-session-state.js";
import {
	type DaemonCommand,
	type DaemonResponse,
	type DaemonWarmPoolReclaimReason,
	type DaemonWarmPoolStats,
	success,
} from "./daemon-protocol.js";
import type { DaemonSupervisor, SpawnedWorkerProcess } from "./daemon-supervisor.js";
import { DAEMON_WORKER_WARM_SPARE_ENV, type DaemonCreateCommand } from "./daemon-worker-protocol.js";
import { availableMemoryBytes } from "./warm-pool-memory.js";

// Same component name as the supervisor's own logger: the warm-pool telemetry
// stream (and its tests) read `component === "coding-agent.daemon-supervisor"`.
const structuredLog = getLogger("coding-agent.daemon-supervisor");

const DEFAULT_WARM_SPARE_TTL_MS = 10 * 60_000;
const DEFAULT_WARM_POOL_MAX_SPARES = 4;
const DEFAULT_WARM_SPARE_SPAWN_COOLDOWN_MS = 60_000;
const DEFAULT_WARM_POOL_SWEEP_INTERVAL_MS = 60_000;
// A spare holds a full worker RSS while idle; under memory pressure the pool is
// the first thing to release. macOS overcommits freely, so the floor is absolute.
const DEFAULT_WARM_POOL_MIN_FREE_MEMORY_BYTES = 768 * 1024 * 1024;
// A spare is supposed to be already listening: a claim that cannot connect and
// authenticate within this budget treats the spare as unhealthy and goes cold.
export const DEFAULT_WARM_SPARE_CLAIM_CONNECT_TIMEOUT_MS = 2_000;
// A claim that arrives while its spare is still warming waits this long for the
// warm handoff before going cold: the spare's remaining boot beats a parallel
// cold spawn, and the wait is bounded so a wedged warm-up never stalls a create.
const DEFAULT_WARM_SPARE_CLAIM_WARMING_WAIT_MS = 750;
/** PRIME_AGENT_WARM_POOL=0|false|no|off disables the pool on daemon startup. */
export const WARM_POOL_DISABLE_ENV = "PRIME_AGENT_WARM_POOL";

export interface DaemonWarmPoolOptions {
	/** Idle TTL per spare before disposal; default 10min. */
	ttlMs?: number;
	/** Pool-wide spare cap; default 4. */
	maxSpares?: number;
	/** Per-cwd cooldown after a spare spawn failure; default 60s. */
	spawnCooldownMs?: number;
	/** Pool sweep cadence (dead/expired spares, memory pressure); default 60s. */
	sweepIntervalMs?: number;
	/** Available-memory floor (reclaimable pages included; see warm-pool-memory.ts): below it the pool releases spares and spawns none; default 768MiB. */
	minFreeMemoryBytes?: number;
	/** Claim health-check budget before falling back to a cold launch; default 2s. */
	claimConnectTimeoutMs?: number;
	/**
	 * How long a create waits for a still-warming spare before launching cold;
	 * default 750ms. 0 disables the warm handoff (claim during warming = miss).
	 */
	claimWarmingWaitMs?: number;
}

export interface ResolvedDaemonWarmPoolOptions {
	ttlMs: number;
	maxSpares: number;
	spawnCooldownMs: number;
	sweepIntervalMs: number;
	minFreeMemoryBytes: number;
	claimConnectTimeoutMs: number;
	claimWarmingWaitMs: number;
}

/**
 * Production default: the pool is on unless the environment opts out. Tests
 * construct DaemonSupervisor directly (pool absent => off) and opt in through
 * DaemonSupervisorOptions.warmPool.
 */
export function resolveWarmPoolOptionsFromEnv(
	environment: NodeJS.ProcessEnv = process.env,
): DaemonWarmPoolOptions | undefined {
	const raw = environment[WARM_POOL_DISABLE_ENV];
	if (raw !== undefined && /^(?:0|false|no|off)$/i.test(raw.trim())) {
		return undefined;
	}
	return {};
}

/** Apply the pool defaults to the user-supplied options; undefined disables the pool. */
export function resolveDaemonWarmPoolOptions(
	options: DaemonWarmPoolOptions | undefined,
): ResolvedDaemonWarmPoolOptions | undefined {
	return options === undefined
		? undefined
		: {
				ttlMs: options.ttlMs ?? DEFAULT_WARM_SPARE_TTL_MS,
				maxSpares: options.maxSpares ?? DEFAULT_WARM_POOL_MAX_SPARES,
				spawnCooldownMs: options.spawnCooldownMs ?? DEFAULT_WARM_SPARE_SPAWN_COOLDOWN_MS,
				sweepIntervalMs: options.sweepIntervalMs ?? DEFAULT_WARM_POOL_SWEEP_INTERVAL_MS,
				minFreeMemoryBytes: options.minFreeMemoryBytes ?? DEFAULT_WARM_POOL_MIN_FREE_MEMORY_BYTES,
				claimConnectTimeoutMs: options.claimConnectTimeoutMs ?? DEFAULT_WARM_SPARE_CLAIM_CONNECT_TIMEOUT_MS,
				claimWarmingWaitMs: options.claimWarmingWaitMs ?? DEFAULT_WARM_SPARE_CLAIM_WARMING_WAIT_MS,
			};
}

/**
 * The spawn-time identity of a worker process. The claim check builds the
 * candidate environment with the spare's own per-incarnation ids (token,
 * instance, session, journal paths), so those cancel and only the remaining
 * variables decide; the spare marker is excluded because a claimed spare keeps
 * it in its (immutable) process environment while the cold build would not set
 * it. A create whose fingerprint differs from the spare's misses the pool — a
 * claim must be byte-identical to the cold spawn it replaces, or it does not
 * happen.
 */
function warmWorkerEnvFingerprint(environment: NodeJS.ProcessEnv): string {
	const hash = createHash("sha256");
	const keys = Object.keys(environment)
		.filter((key) => key !== DAEMON_WORKER_WARM_SPARE_ENV)
		.sort();
	for (const key of keys) {
		hash.update(key);
		hash.update("\0");
		hash.update(environment[key] ?? "");
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** Miss diagnostics: the differing env KEYS only — values may carry secrets. */
function warmWorkerEnvMismatch(candidate: NodeJS.ProcessEnv, pooled: NodeJS.ProcessEnv): string {
	const differing: string[] = [];
	const keys = [...new Set([...Object.keys(candidate), ...Object.keys(pooled)])].sort();
	for (const key of keys) {
		if (key === DAEMON_WORKER_WARM_SPARE_ENV) {
			continue;
		}
		if ((candidate[key] ?? "") !== (pooled[key] ?? "")) {
			differing.push(key);
			if (differing.length >= 3) {
				break;
			}
		}
	}
	if (differing.length === 0) {
		return "environment fingerprint drift with no single differing key";
	}
	return `environment differs in ${differing.join(", ")}${keys.length > 0 && differing.length >= 3 ? ", …" : ""}`;
}

/**
 * Pool key for a cwd. realpath collapses symlink forms (/tmp vs /private/tmp
 * on macOS): a daemon spawned with a symlinked cwd and a client that resolves
 * it must still hit the same spare. Only the key canonicalizes; the spawned
 * worker keeps the caller's literal cwd, byte-identical to the cold path.
 */
function warmPoolKey(cwd: string): string {
	const resolved = resolve(cwd);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/**
 * Reclaim attribution buckets (Go DBStats style): every spare that leaves the
 * pool unclaimed is counted exactly once, by cause. The wire spelling is
 * DaemonWarmPoolReclaimReason (rev 45); this alias keeps the pool internals on
 * the same union so a telemetry bucket and a wire field can never drift apart.
 */
export type WarmPoolReclaimReason = DaemonWarmPoolReclaimReason;

/** Supervisor-lifetime warm-pool counters, emitted as a snapshot with every pool event. */
interface WarmPoolTelemetryTotals {
	spawns: { ready: number; failed: number };
	claims: { hit: number; miss: number; expired: number };
	reclaims: Record<WarmPoolReclaimReason, number>;
}

function createWarmPoolTelemetryTotals(): WarmPoolTelemetryTotals {
	return {
		spawns: { ready: 0, failed: 0 },
		claims: { hit: 0, miss: 0, expired: 0 },
		reclaims: { ttl_expired: 0, exited: 0, memory_pressure: 0, pool_closed: 0, claim_failed: 0, drain: 0 },
	};
}

interface WarmSpareInflight {
	promise: Promise<void>;
	/** Stops the boot early: the spawn terminates its process and returns quietly. */
	cancel: () => void;
}

/**
 * A fully booted, never-claimed worker held by the warm pool. Invisible by
 * construction: no descriptor on disk, no entry in `workers`, no roster row —
 * the only reference is this record, and the worker process itself idles on its
 * socket refusing every command until a supervisor claim (worker auth gate).
 */
export interface WarmSpareWorker {
	/** Pool key: the resolved spawn cwd. */
	key: string;
	cwd: string;
	workerId: string;
	rootActiveSessionId: string;
	socketPath: string;
	token: string;
	workerInstanceId: string;
	descriptorPath: string;
	recoveryJournalPath: string;
	orphanProcessJournalPath: string;
	/** Fingerprint of the spawn environment; a claim must reproduce it exactly. */
	envFingerprint: string;
	/**
	 * The environment the spare was spawned with, kept for miss diagnostics only
	 * (mismatch logging names the differing KEYS, never values — env carries
	 * secrets). Also the source of truth if a claim needs to re-verify.
	 */
	environment: NodeJS.ProcessEnv;
	spawned: SpawnedWorkerProcess;
	spawnedAt: number;
	expiresAt: number;
	ttlTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The pool's state, moved out of the supervisor with the cluster. The maps and
 * totals stay lazy exactly as they were on the class: prototype-harness
 * supervisors in tests bypass the constructor, and the drain paths must read an
 * empty pool there instead of throwing. `options === undefined` disables the
 * pool (and is re-set to undefined once drained for good).
 */
export class WarmPoolState {
	options?: ResolvedDaemonWarmPoolOptions;
	sparesMap?: Map<string, WarmSpareWorker>;
	/**
	 * One in-flight warm-up per pool key. The cancel handle lets a drain stop the
	 * boot probe early: a spare still warming when the pool drains would publish
	 * into a dead pool and be disposed at publish, so waiting out its 8s listen
	 * budget on the shutdown path only ever delays the exit.
	 */
	inflightMap?: Map<string, WarmSpareInflight>;
	/**
	 * The failed terminal state, one record per pool key: when the last warm-up
	 * failed and why. A key in cooldown skips re-spawning until spawnCooldownMs
	 * has elapsed; a successful publish clears the record. Failure records are
	 * the pool's only memory of a broken cwd, so the reason is always populated.
	 */
	failuresMap?: Map<string, { failedAt: number; reason: string }>;
	totalsValue?: WarmPoolTelemetryTotals;
	sweepTimer?: ReturnType<typeof setInterval>;
	pressureLogAt = 0;

	get spares(): Map<string, WarmSpareWorker> {
		if (this.sparesMap === undefined) {
			this.sparesMap = new Map();
		}
		return this.sparesMap;
	}

	get inflight(): Map<string, WarmSpareInflight> {
		if (this.inflightMap === undefined) {
			this.inflightMap = new Map();
		}
		return this.inflightMap;
	}

	get failures(): Map<string, { failedAt: number; reason: string }> {
		if (this.failuresMap === undefined) {
			this.failuresMap = new Map();
		}
		return this.failuresMap;
	}

	get totals(): WarmPoolTelemetryTotals {
		if (this.totalsValue === undefined) {
			this.totalsValue = createWarmPoolTelemetryTotals();
		}
		return this.totalsValue;
	}
}

/**
 * The seam of DaemonSupervisor the extracted warm-pool cluster reads and
 * mutates. Member types mirror the class's own members via indexed access so a
 * rename on the class fails here at compile time. The class satisfies this with
 * the `warmPoolHost` facade (its members are `private`-keyworded, so the
 * instance itself cannot be the host structurally); every member is read live
 * through a getter or arrow, never snapshotted. The three shelled cluster
 * methods appear so moved bodies keep dispatching through the instance. The
 * last two are module-level worker-boot primitives from daemon-supervisor.ts —
 * not class members — carried here so this module needs no value-level import
 * back into the supervisor.
 */
export interface DaemonSupervisorWarmPoolHost {
	readonly warmPoolState: WarmPoolState;
	readonly shuttingDown: DaemonSupervisor["shuttingDown"];
	readonly updateRestartPhase: DaemonSupervisor["updateRestartPhase"];
	readonly socketPath: DaemonSupervisor["socketPath"];
	readonly descriptorDir: DaemonSupervisor["descriptorDir"];
	buildWorkerEnvironment: DaemonSupervisor["buildWorkerEnvironment"];
	spawnWorkerProcess: DaemonSupervisor["spawnWorkerProcess"];
	terminateSpawnedWorkerProcess: DaemonSupervisor["terminateSpawnedWorkerProcess"];
	background: DaemonSupervisor["background"];
	log: DaemonSupervisor["log"];
	logInfo: DaemonSupervisor["logInfo"];
	reportCleanupFailure: DaemonSupervisor["reportCleanupFailure"];
	logWarmPoolTelemetry: DaemonSupervisor["logWarmPoolTelemetry"];
	recordWarmPoolClaimMiss: DaemonSupervisor["recordWarmPoolClaimMiss"];
	recordWarmSpareReclaim: DaemonSupervisor["recordWarmSpareReclaim"];
	workerSocketPath: (supervisorSocketPath: string, workerId: string) => string;
	commitWorkerStartupGate: (gate: Writable) => Promise<void>;
}

/**
 * One structured metric line per pool lifecycle event ("warm pool
 * spawn|claim|reclaim" on the coding-agent.daemon-supervisor component, so
 * agent.jsonl stays greppable). Field convention: `outcome` is the result
 * discriminator wherever the event has more than one terminal result —
 * spawn reports ready|failed and claim reports hit|miss|expired under the
 * same key, so jq reads `(.outcome)` across both. A reclaim's outcome is
 * implied by the event itself (the spare left the pool), so it carries
 * `reason` + `detail` for attribution instead. `depth` is the pool gauge
 * sampled at event time: ready spares plus still-warming spawns (a spare
 * emitting its own spawn-ready event still counts as warming; its inflight
 * entry clears after publish). `totals` carries the supervisor-lifetime
 * counters so a rotated log still reconstructs the tally. The operational
 * log lines are unchanged; this stream is structured log only — never the
 * daemon wire. The wire face of the same facts is get_warm_pool_stats
 * (rev 45, capability warm_pool_stats) below.
 */
export function logWarmPoolTelemetry(
	host: DaemonSupervisorWarmPoolHost,
	event: "spawn" | "claim" | "reclaim",
	fields: Record<string, unknown>,
): void {
	const state = host.warmPoolState;
	const totals = state.totals;
	structuredLog.info(`warm pool ${event}`, {
		...fields,
		depth: { ready: state.sparesMap?.size ?? 0, warming: state.inflightMap?.size ?? 0 },
		totals: {
			spawns: { ...totals.spawns },
			claims: { ...totals.claims },
			reclaims: { ...totals.reclaims },
		},
	});
}

/**
 * get_warm_pool_stats (rev 45, capability warm_pool_stats): the wire face of
 * the warm-pool telemetry above. Reads only the lazy pool maps, so a
 * prototype-harness supervisor that never ran the constructor answers with an
 * empty, disabled pool instead of throwing. A cooldown entry joins the
 * response only while it still suppresses a respawn; a stale record whose
 * cooldown already elapsed has no effect and is left out.
 */
export async function handleGetWarmPoolStats(
	host: DaemonSupervisorWarmPoolHost,
	command: Extract<DaemonCommand, { type: "get_warm_pool_stats" }>,
): Promise<DaemonResponse> {
	const state = host.warmPoolState;
	const nowMs = Date.now();
	const pool = state.options;
	const totals = state.totals;
	const spares: DaemonWarmPoolStats["spares"] = [...(state.sparesMap?.values() ?? [])].map((spare) => ({
		cwd: spare.cwd,
		workerId: spare.workerId,
		ageMs: Math.max(0, nowMs - spare.spawnedAt),
		expiresInMs: Math.max(0, spare.expiresAt - nowMs),
	}));
	const cooldowns: DaemonWarmPoolStats["cooldowns"] =
		pool === undefined
			? []
			: [...(state.failuresMap?.entries() ?? [])]
					.map(([key, failed]) => ({
						cwd: key,
						reason: failed.reason,
						retryInMs: Math.max(0, pool.spawnCooldownMs - (nowMs - failed.failedAt)),
					}))
					.filter((entry) => entry.retryInMs > 0);
	const stats: DaemonWarmPoolStats = {
		enabled: pool !== undefined,
		depth: { ready: state.sparesMap?.size ?? 0, warming: state.inflightMap?.size ?? 0 },
		spares,
		cooldowns,
		totals: {
			spawns: { ...totals.spawns },
			claims: { ...totals.claims },
			reclaims: { ...totals.reclaims },
		},
		...(pool === undefined ? {} : { config: { ttlMs: pool.ttlMs, maxSpares: pool.maxSpares } }),
	};
	return success(command.id, command.type, stats);
}

/** A create that left without a spare: no ready spare, the warming wait expired, the env fingerprint differed, or the claim health check failed. */
export function recordWarmPoolClaimMiss(
	host: DaemonSupervisorWarmPoolHost,
	cwd: string,
	missReason: string,
	spare?: WarmSpareWorker,
): void {
	host.warmPoolState.totals.claims.miss++;
	host.logWarmPoolTelemetry("claim", {
		outcome: "miss",
		missReason,
		cwd,
		...(spare === undefined ? {} : { workerId: spare.workerId, ageMs: Math.max(0, Date.now() - spare.spawnedAt) }),
	});
}

/** Count one unclaimed spare leaving the pool, by cause; see WarmPoolReclaimReason. */
export function recordWarmSpareReclaim(
	host: DaemonSupervisorWarmPoolHost,
	spare: WarmSpareWorker,
	reason: WarmPoolReclaimReason,
	detail: string,
): void {
	host.warmPoolState.totals.reclaims[reason]++;
	host.logWarmPoolTelemetry("reclaim", {
		reason,
		detail,
		cwd: spare.cwd,
		workerId: spare.workerId,
		ageMs: Math.max(0, Date.now() - spare.spawnedAt),
	});
}

/**
 * Take the pooled spare for this create, or miss. A claim requires the same
 * spawn cwd and a byte-identical environment fingerprint (the rebind rule:
 * auth-, project- and client-level variables all live in the fingerprint, so
 * a stale or foreign environment can never leak into a claimed session).
 * Misses leave the spare pooled for a create that does match; an expired or
 * dead spare is dropped and disposed instead.
 *
 * Warming is a first-class state, not a miss: when the key's spare is still
 * being built, the claim waits up to claimWarmingWaitMs for the handoff
 * (its remaining boot beats a parallel cold spawn). A warm-up that fails or
 * outlives the wait leaves the create to the cold path — never dropped.
 */
export async function takeWarmSpare(
	host: DaemonSupervisorWarmPoolHost,
	createCommand: DaemonCreateCommand,
	launchEnv: Record<string, string> | undefined,
): Promise<WarmSpareWorker | undefined> {
	const state = host.warmPoolState;
	const pool = state.options;
	if (pool === undefined || host.shuttingDown || host.updateRestartPhase !== undefined) {
		return undefined;
	}
	const cwd = createCommand.config?.cwd ?? process.cwd();
	const key = warmPoolKey(cwd);
	let spare = state.spares.get(key);
	if (spare === undefined) {
		const warming = state.inflight.get(key);
		if (warming === undefined || pool.claimWarmingWaitMs <= 0) {
			host.recordWarmPoolClaimMiss(cwd, "no_ready_spare");
			return undefined;
		}
		await Promise.race([warming.promise, sleep(pool.claimWarmingWaitMs, { unref: true })]);
		// The wait may have crossed a drain or shutdown; re-read every gate. A
		// create that loses the pool mid-wait is not a miss — the pool stopped
		// participating, and the drain emits its own reclaim events.
		if (state.options === undefined || host.shuttingDown || host.updateRestartPhase !== undefined) {
			return undefined;
		}
		spare = state.spares.get(key);
		if (spare === undefined) {
			// Still warming past the wait, or the warm-up failed: cold launch.
			host.recordWarmPoolClaimMiss(cwd, "warming_timeout");
			return undefined;
		}
	}
	const nowMs = Date.now();
	const spareExpired = spare.expiresAt <= nowMs;
	const spareExited = spare.spawned.child.exitCode !== null || spare.spawned.child.signalCode !== null;
	if (spareExpired || spareExited) {
		state.spares.delete(key);
		state.totals.claims.expired++;
		host.logWarmPoolTelemetry("claim", {
			outcome: "expired",
			reclaimReason: spareExpired ? "ttl_expired" : "exited",
			cwd,
			workerId: spare.workerId,
			ageMs: Math.max(0, nowMs - spare.spawnedAt),
		});
		host.background(
			disposeWarmSpare(host, spare, "expired or exited before claim", spareExpired ? "ttl_expired" : "exited"),
			`warm spare disposal ${key}`,
		);
		return undefined;
	}
	const candidateEnvironment = host.buildWorkerEnvironment(
		launchEnv,
		{
			token: spare.token,
			workerInstanceId: spare.workerInstanceId,
			rootActiveSessionId: spare.rootActiveSessionId,
			recoveryJournalPath: spare.recoveryJournalPath,
			orphanProcessJournalPath: spare.orphanProcessJournalPath,
		},
		false,
	);
	if (warmWorkerEnvFingerprint(candidateEnvironment) !== spare.envFingerprint) {
		// The spare stays pooled for a create that does match.
		host.recordWarmPoolClaimMiss(cwd, "env_mismatch", spare);
		host.logInfo(
			`Warm spare ${spare.workerId} for ${key} missed: ${warmWorkerEnvMismatch(candidateEnvironment, spare.environment)}`,
		);
		return undefined;
	}
	state.spares.delete(key);
	if (spare.ttlTimer) {
		clearTimeout(spare.ttlTimer);
		spare.ttlTimer = undefined;
	}
	// The handoff itself is not the hit: the claim health check in launchWorker
	// decides the outcome, so a spare that fails it is a miss, not a hit.
	return spare;
}

/**
 * Stock the pool for a cwd if it is empty and within bounds. All failures are
 * pool-local: a cooldown per cwd keeps a broken spawn from looping, and the
 * only create-side wait on a spare is the bounded warm handoff in
 * takeWarmSpare.
 */
export function ensureWarmSpare(
	host: DaemonSupervisorWarmPoolHost,
	cwd: string,
	launchEnv: Record<string, string> | undefined,
): void {
	const state = host.warmPoolState;
	const pool = state.options;
	if (pool === undefined || host.shuttingDown || host.updateRestartPhase !== undefined) {
		return;
	}
	const key = warmPoolKey(cwd);
	if (state.spares.has(key) || state.inflight.has(key)) {
		return;
	}
	// Warming spawns hold a pool slot too: counting only published spares let N
	// racing creates each start a warm-up and publish past the cap.
	if (state.spares.size + state.inflight.size >= pool.maxSpares) {
		return;
	}
	const failed = state.failures.get(key);
	if (failed !== undefined && Date.now() - failed.failedAt < pool.spawnCooldownMs) {
		return;
	}
	if (availableMemoryBytes() < pool.minFreeMemoryBytes) {
		const nowMs = Date.now();
		if (nowMs - state.pressureLogAt >= 10 * 60_000) {
			state.pressureLogAt = nowMs;
			host.logInfo("Warm pool: available memory below the floor; not spawning a spare");
		}
		return;
	}
	const controller = new AbortController();
	const entry: WarmSpareInflight = {
		// Assigned one statement below, before the entry is visible to the map.
		promise: Promise.resolve(),
		cancel: () => controller.abort(),
	};
	entry.promise = spawnWarmSpare(host, key, cwd, launchEnv, controller.signal)
		.catch((error) => {
			// The failed state is terminal and visible: until the cooldown
			// elapses this key neither spawns nor waits, and the reason is on
			// record. The create path itself never notices — it went cold.
			host.logInfo(
				`Warm spare for ${cwd} failed: ${error instanceof Error ? error.message : String(error)} (cooldown ${pool.spawnCooldownMs}ms)`,
			);
		})
		.finally(() => {
			if (state.inflight.get(key) === entry) {
				state.inflight.delete(key);
			}
		});
	state.inflight.set(key, entry);
}

/**
 * Spawn one spare and boot it all the way to listen (the startup gate commits
 * at prebuild, not at claim). The gate's protected invariant — no session work
 * before a persisted descriptor — still holds: the spare serves nothing until
 * a claim persists one, and the worker auth gate refuses every other command.
 *
 * `signal` is the pool drain's cancel: a spare still warming when the pool
 * drains would be disposed at publish anyway, so the boot stops at the next
 * stage boundary instead of holding the shutdown path for its full listen
 * budget. A cancelled warm-up is not a failure — no cooldown, no spawn-failed
 * telemetry.
 */
async function spawnWarmSpare(
	host: DaemonSupervisorWarmPoolHost,
	key: string,
	cwd: string,
	launchEnv: Record<string, string> | undefined,
	signal: AbortSignal,
): Promise<void> {
	const state = host.warmPoolState;
	const pool = state.options;
	if (pool === undefined) {
		return;
	}
	const workerId = createActiveSessionId();
	const rootActiveSessionId = createActiveSessionId();
	const spawnStartedAt = Date.now();
	const socketPath = host.workerSocketPath(host.socketPath, workerId);
	const ids = {
		token: randomBytes(32).toString("base64url"),
		workerInstanceId: randomUUID(),
		rootActiveSessionId,
		recoveryJournalPath: join(host.descriptorDir, `${workerId}.recovery.jsonl`),
		orphanProcessJournalPath: join(host.descriptorDir, `${workerId}.orphans.jsonl`),
	};
	const descriptorPath = join(host.descriptorDir, `${workerId}.json`);
	const environment = host.buildWorkerEnvironment(launchEnv, ids, true);
	const launch = createCliSubprocessLaunchSpec(["--mode", "daemon", "--daemon-socket", socketPath]);
	const fail = (reason: string): Error => {
		state.failures.set(key, { failedAt: Date.now(), reason });
		state.totals.spawns.failed++;
		host.logWarmPoolTelemetry("spawn", {
			outcome: "failed",
			cwd,
			workerId,
			durationMs: Date.now() - spawnStartedAt,
			reason,
		});
		return new Error(reason);
	};
	let spawned: SpawnedWorkerProcess;
	try {
		spawned = await host.spawnWorkerProcess(launch.command, launch.args, environment, cwd, workerId);
	} catch (error) {
		throw fail(error instanceof Error ? error.message : String(error));
	}
	if (signal.aborted) {
		await host.terminateSpawnedWorkerProcess(spawned);
		cleanWarmSpareFiles(host, {
			workerId,
			recoveryJournalPath: ids.recoveryJournalPath,
			orphanProcessJournalPath: ids.orphanProcessJournalPath,
			descriptorPath,
			socketPath,
			spawned,
		});
		return;
	}
	try {
		await host.commitWorkerStartupGate(spawned.startupGate);
	} catch (error) {
		await host.terminateSpawnedWorkerProcess(spawned);
		throw fail(error instanceof Error ? error.message : String(error));
	}
	// "Ready" must mean the worker actually listens: a claim against a still-
	// booting spare would pay the boot remainder inside the create window. The
	// probe is a bare connect (no auth); the worker answers its hello and the
	// probe hangs up, exactly like a failed connectWorker attempt.
	const listened = await probeWarmSpareListening(spawned, socketPath, signal);
	if (signal.aborted) {
		await host.terminateSpawnedWorkerProcess(spawned);
		cleanWarmSpareFiles(host, {
			workerId,
			recoveryJournalPath: ids.recoveryJournalPath,
			orphanProcessJournalPath: ids.orphanProcessJournalPath,
			descriptorPath,
			socketPath,
			spawned,
		});
		return;
	}
	if (!listened) {
		await host.terminateSpawnedWorkerProcess(spawned);
		throw fail(`Warm spare ${workerId} did not start listening within its boot budget`);
	}
	// The spawn itself succeeded here; whether the spare is then published,
	// claimed, or reclaimed shows up in the claim/reclaim events.
	state.totals.spawns.ready++;
	host.logWarmPoolTelemetry("spawn", {
		outcome: "ready",
		cwd,
		workerId,
		durationMs: Date.now() - spawnStartedAt,
	});
	spawned.child.unref();
	spawned.childClosed.then(() => {
		// A pooled spare that exited on its own: drop the record so the next
		// create misses cleanly instead of claiming a corpse.
		const pooled = state.spares.get(key);
		if (pooled?.spawned === spawned) {
			state.spares.delete(key);
			if (pooled.ttlTimer) {
				clearTimeout(pooled.ttlTimer);
				pooled.ttlTimer = undefined;
			}
			host.log(`Warm spare ${workerId} for ${cwd} exited before claim`);
			cleanWarmSpareFiles(host, pooled);
			host.recordWarmSpareReclaim(pooled, "exited", "exited before claim");
		}
	});
	const nowMs = Date.now();
	const spare: WarmSpareWorker = {
		key,
		cwd,
		workerId,
		rootActiveSessionId,
		socketPath,
		token: ids.token,
		workerInstanceId: ids.workerInstanceId,
		descriptorPath,
		recoveryJournalPath: ids.recoveryJournalPath,
		orphanProcessJournalPath: ids.orphanProcessJournalPath,
		envFingerprint: warmWorkerEnvFingerprint(environment),
		environment: { ...environment },
		spawned,
		spawnedAt: nowMs,
		expiresAt: nowMs + pool.ttlMs,
	};
	if (
		host.shuttingDown ||
		host.updateRestartPhase !== undefined ||
		state.options === undefined ||
		state.spares.has(key) ||
		// The cap is re-checked at publish, not only when the spawn was admitted:
		// the admission count includes in-flight warm-ups, but a claim that frees
		// and refills a slot mid-boot can still fill the pool under this one.
		state.spares.size >= pool.maxSpares
	) {
		// The pool closed, refilled, or filled up while this spawn was in flight.
		await disposeWarmSpare(host, spare, "pool closed, refilled, or full during spawn", "pool_closed");
		return;
	}
	spare.ttlTimer = setTimeout(() => {
		spare.ttlTimer = undefined;
		if (state.spares.get(key) === spare) {
			state.spares.delete(key);
			host.background(
				disposeWarmSpare(host, spare, "idle TTL expired", "ttl_expired"),
				`warm spare TTL disposal ${key}`,
			);
		}
	}, pool.ttlMs);
	spare.ttlTimer.unref();
	state.spares.set(key, spare);
	// A successful publish ends the key's failed state.
	state.failures.delete(key);
	host.logInfo(`Warm spare worker ${workerId} ready for ${cwd}`);
}

/**
 * Wait until the spare's socket accepts a connection. One probe = a bare
 * connect and immediate hang-up; the worker sends its hello to a peer that
 * never authenticates, which is the same shape as a failed connectWorker
 * attempt. A spare that never listens is a spawn failure (cooldown applies).
 * The drain's cancel signal ends the wait within one poll instead of running
 * the budget out: the spare is about to be terminated either way.
 */
async function probeWarmSpareListening(
	spawned: SpawnedWorkerProcess,
	socketPath: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const budgetMs = process.platform === "win32" ? 30_000 : 8_000;
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) {
			return false;
		}
		if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
			return false;
		}
		const accepted = await new Promise<boolean>((resolveProbe) => {
			const probe = connect(socketPath);
			const finish = (ok: boolean) => {
				probe.removeAllListeners();
				probe.destroy();
				resolveProbe(ok);
			};
			probe.once("connect", () => finish(true));
			probe.once("error", () => finish(false));
		});
		if (signal?.aborted) {
			return false;
		}
		if (accepted) {
			return true;
		}
		await sleep(25, { unref: true });
	}
	return false;
}

/**
 * A spare never wrote a descriptor; its journals exist only if the worker
 * created them, and its socket file only outlives a worker that could not run
 * its own exit cleanup (SIGKILL). Everything here is best-effort.
 *
 * Takes the path carrier rather than the published spare so a cancelled
 * warm-up (terminated before its spare record exists) cleans up identically.
 */
function cleanWarmSpareFiles(
	host: DaemonSupervisorWarmPoolHost,
	spare: Pick<
		WarmSpareWorker,
		"recoveryJournalPath" | "orphanProcessJournalPath" | "descriptorPath" | "socketPath" | "spawned" | "workerId"
	>,
): void {
	try {
		rmSync(spare.recoveryJournalPath, { force: true });
	} catch (error) {
		host.reportCleanupFailure(`warm spare recovery journal ${spare.workerId}`, error);
	}
	try {
		rmSync(spare.orphanProcessJournalPath, { force: true });
	} catch (error) {
		host.reportCleanupFailure(`warm spare orphan journal ${spare.workerId}`, error);
	}
	try {
		rmSync(`${spare.descriptorPath}.${process.pid}.tmp`, { force: true });
	} catch (error) {
		host.reportCleanupFailure(`warm spare descriptor temp ${spare.workerId}`, error);
	}
	if (process.platform !== "win32" && !isProcessAlive(spare.spawned.pid)) {
		try {
			rmSync(spare.socketPath, { force: true });
		} catch (error) {
			host.reportCleanupFailure(`warm spare socket ${spare.workerId}`, error);
		}
	}
}

async function disposeWarmSpare(
	host: DaemonSupervisorWarmPoolHost,
	spare: WarmSpareWorker,
	reason: string,
	reclaim: WarmPoolReclaimReason,
): Promise<void> {
	const state = host.warmPoolState;
	if (state.spares.get(spare.key) === spare) {
		state.spares.delete(spare.key);
	}
	if (spare.ttlTimer) {
		clearTimeout(spare.ttlTimer);
		spare.ttlTimer = undefined;
	}
	// Counted before the termination so a kill failure never loses the attribution.
	host.recordWarmSpareReclaim(spare, reclaim, reason);
	await host.terminateSpawnedWorkerProcess(spare.spawned);
	cleanWarmSpareFiles(host, spare);
	host.logInfo(`Disposed warm spare ${spare.workerId} for ${spare.cwd}: ${reason}`);
}

/**
 * Empty the pool: daemon shutdown, supervisor dispose, and update-restart
 * preparation all drain (a spare spawned now would run this build while its
 * successor runs the next). `disable` is for exits: the pool stays off for
 * the rest of this process's life.
 */
export async function drainWarmPool(
	host: DaemonSupervisorWarmPoolHost,
	reason: string,
	disable: boolean,
): Promise<void> {
	const state = host.warmPoolState;
	if (disable) {
		state.options = undefined;
		state.failures.clear();
	}
	if (state.sweepTimer) {
		clearInterval(state.sweepTimer);
		state.sweepTimer = undefined;
	}
	const spares = [...state.spares.values()];
	const inflight = [...state.inflight.values()];
	if (spares.length === 0 && inflight.length === 0) {
		return;
	}
	// A still-warming spawn would publish into the drained pool and be disposed
	// at publish; cancelling its boot here keeps the drain off its listen probe
	// budget (up to 8s per spare) — the shutdown path and the update handoff's
	// admission window cannot pay that.
	for (const entry of inflight) {
		entry.cancel();
	}
	// Cancelled spawns terminate their process and return; awaiting them here
	// keeps the drain complete before exit.
	await Promise.all([
		...inflight.map((entry) => entry.promise.catch(() => undefined)),
		...spares.map((spare) =>
			disposeWarmSpare(host, spare, reason, "drain").catch((error) =>
				host.reportCleanupFailure(`warm spare ${spare.workerId}`, error),
			),
		),
	]);
}

export function startWarmPoolSweep(host: DaemonSupervisorWarmPoolHost): void {
	const state = host.warmPoolState;
	const pool = state.options;
	if (pool === undefined || state.sweepTimer) {
		return;
	}
	state.sweepTimer = setInterval(() => sweepWarmPool(host), pool.sweepIntervalMs);
	state.sweepTimer.unref();
}

/** Reap dead/expired spares and release the whole pool under memory pressure. */
function sweepWarmPool(host: DaemonSupervisorWarmPoolHost): void {
	const state = host.warmPoolState;
	const pool = state.options;
	if (pool === undefined) {
		return;
	}
	const nowMs = Date.now();
	const lowMemory = availableMemoryBytes() < pool.minFreeMemoryBytes;
	for (const spare of [...state.spares.values()]) {
		const dead = spare.spawned.child.exitCode !== null || spare.spawned.child.signalCode !== null;
		const expired = spare.expiresAt <= nowMs;
		if (!dead && !expired && !lowMemory) {
			continue;
		}
		// The snapshot may name a spare the childClosed handler already
		// reclaimed; only the delete that actually removes it earns the disposal
		// (and the reclaim attribution).
		if (!state.spares.delete(spare.key)) {
			continue;
		}
		const reason = dead ? "process exited" : expired ? "idle TTL expired" : "available memory below the floor";
		const reclaim: WarmPoolReclaimReason = dead ? "exited" : expired ? "ttl_expired" : "memory_pressure";
		host.background(disposeWarmSpare(host, spare, reason, reclaim), `warm spare sweep disposal ${spare.key}`);
	}
}
