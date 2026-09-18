import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { getLogger } from "@earendil-works/pi-ai";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import {
	appendRotatingLog,
	getCronJobsPath,
	getDaemonLogPath,
	getDaemonUpdateRestartManifestPath,
	getSessionsDir,
	VERSION,
} from "../../config.js";
import {
	type AgentFamilyCatalogEntry,
	type AgentSessionMessageAgentSummary,
	agentFamilyRelationship,
	assertAgentFamilyReach,
	assertAgentSessionNameAvailable,
	assertDirectAgentMessageTarget,
	formatAgentSessionNameUnavailable,
	sessionNameReservationKey,
} from "../../core/agent-messages.js";
import {
	type AgentSessionRuntimeConfig,
	type DurableAgentSessionRuntimeConfig,
	durableAgentSessionRuntimeConfig,
	mergeAgentSessionRuntimeConfig,
} from "../../core/agent-session-config.js";
import {
	type AgentCronJob,
	AgentCronJobStore,
	isHeartbeatCronJob,
	migrateLegacyCronJobsToSessionArtifacts,
	SESSION_SCHEDULED_JOBS_FILENAME,
} from "../../core/cron-jobs.js";
import {
	clearOrphanProcessJournal,
	killOrphanProcess,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	reapForeignOrphanProcessRecords,
	shouldReapOrphanProcess,
} from "../../core/orphan-process-journal.js";
import { PromptAdmissionCancelledError, waitForPromptAdmission } from "../../core/prompt-admission.js";
import { runRetentionSweepOnce } from "../../core/retention/runner.js";
import {
	canEvictWorker,
	type IdleEvictionMinutes,
	type WorkerEvictionSnapshot,
} from "../../core/session-action-store.js";
import {
	canonicalSessionPath,
	getProcessStartId,
	getProcessStartIdAsync,
	SessionAlreadyActiveError,
} from "../../core/session-lease.js";
import { getSessionArtifactPathForFile, readSessionInfo, type SessionInfo } from "../../core/session-manager.js";
import { looksLikeSessionPath } from "../../core/session-resolver.js";
import { SettingsManager } from "../../core/settings-manager.js";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";
import {
	isProcessAlive,
	processIdExists,
	signalProcessGroupOrProcess,
	spawnHidden,
} from "../../utils/child-process.js";
import type { AgentConnectionHeartbeat } from "../agent-connection/types.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import type { PrivateFrame } from "../session-worker/private-framing.js";
import { createActiveSessionId, type DaemonSocketClient } from "./active-session-state.js";
import {
	AgentRoster,
	type AgentRosterEntry,
	type AgentRosterMutation,
	passivatedWorkerRosterEntry,
	rosterAgentIdForSummary,
	sessionSummaryFromRosterEntry,
	type WorkerRosterEntry,
	workerRosterEntryFromSummary,
} from "./agent-roster.js";
import { CommandRecoveryJournal, createCommandIdempotencyKey } from "./command-recovery-journal.js";
import {
	CompactAssistantStreamReconstructor,
	isCompactAssistantDelta,
	isFragmentOnlyToolCallDelta,
} from "./compact-session-stream.js";
import { DAEMON_CATALOG_ROLE_ENV, DaemonCatalogClient } from "./daemon-catalog-process.js";
import { DaemonSessionRecoveringError, deserializeDaemonError, serializeDaemonError } from "./daemon-errors.js";
import {
	collectDaemonClientEnv,
	createDaemonEventMeta,
	DAEMON_COMMAND_COMPATIBILITY,
	DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION,
	DAEMON_COMMAND_MAX_LINE_BYTES,
	DAEMON_DEFAULT_CLIENT_CAPABILITIES,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES,
	DAEMON_SUPPORTED_CLIENT_CAPABILITIES,
	DAEMON_UPDATE_RESTART_FORMAT_VERSION,
	type DaemonAttachResult,
	type DaemonClientCapability,
	type DaemonClosingReason,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonPeerTransportTicket,
	type DaemonResponse,
	type DaemonServerCapability,
	type DaemonUpdateRestartManifest,
	failure,
	isDaemonCommandEnvelope,
	isDaemonMutatingCommand,
	missingDeclaredCommandCapability,
	normalizeDeclaredCapabilities,
	salvageDaemonCommandId,
	success,
	UPDATE_RESTART_DRAIN_COMMANDS,
} from "./daemon-protocol.js";
import { getDaemonRuntimeIdentity } from "./daemon-runtime-identity.js";
import { matchesSessionIdSuffix } from "./daemon-session-id.js";
import {
	classifySessionRosterStatus,
	isEvictableEmptySessionSummary,
	isSessionSummaryBusy,
	type SessionSummary,
	summaryForInactiveSession,
	summaryWithoutStreamingMessage,
} from "./daemon-session-list.js";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	type DaemonSocketIdentity,
	type DaemonSocketPathLease,
	daemonIpcListenOptions,
	defaultDaemonSocketDir,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	normalizeSocketPath,
	prepareDaemonSocketPath,
	restrictDaemonSocketPath,
} from "./daemon-socket.js";
import {
	acquireDaemonSupervisorOwnership,
	isDaemonShutdownAdmissionActive,
	waitForDaemonStartupFence,
	writeJsonAtomically,
} from "./daemon-supervisor-ownership.js";
import {
	DAEMON_ADOPTION_REQUEST_TIMEOUT_MS,
	WORKER_REQUEST_TIMEOUT_TIERS,
	type WorkerRequestTimeoutTier,
	workerRequestTimeoutMs,
	workerRequestTimeoutTier,
} from "./daemon-timeouts.js";
import {
	DaemonWorkerAuthenticationError,
	DaemonWorkerClient,
	DaemonWorkerNotConnectedError,
	DaemonWorkerProbeTimeoutError,
	type DaemonWorkerRequestHooks,
} from "./daemon-worker-client.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_INSTANCE_ID_ENV,
	DAEMON_WORKER_PEER_TRANSPORT_CAPABILITY,
	DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_ROSTER_CAPABILITY,
	DAEMON_WORKER_STARTUP_GATE_COMMIT,
	DAEMON_WORKER_STARTUP_GATE_FD_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
	type DaemonCreateCommand,
	type DaemonWorkerCommandBody,
	type DaemonWorkerDescriptor,
	type DaemonWorkerFrameHeader,
	type DaemonWorkerLifecycle,
	type DaemonWorkerRosterOutbound,
	durableDaemonCreateCommand,
	durableDaemonWorkerDescriptor,
	ROSTER_HEARTBEAT_INTERVAL_MS,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "./daemon-worker-protocol.js";
import { MutationDrainLatch } from "./mutation-drain-latch.js";
import {
	PENDING_DELIVERY_CAPACITY_RETRY_AFTER_MS,
	PendingDeliveryAbortedError,
	type PendingDeliveryAbortReason,
	PendingDeliveryCapacityError,
	type PendingDeliveryEntry,
	PendingDeliveryQueue,
} from "./pending-delivery-queue.js";
import {
	createRlmLedgerRegistrySeedSource,
	type RlmLedgerEdge,
	RlmSpawnLedger,
	tombstoneSavedSessionDelete,
	withPassiveRlmDescendantInfos,
} from "./rlm-ledger.js";
import { serializeSavedSessionInfo } from "./saved-session-info.js";
import { SNAPSHOT_TARGET_CHUNK_BYTES, SnapshotTranscriptCache } from "./snapshot-transcript-cache.js";
import { WorkerRecoveryJournal } from "./worker-recovery-journal.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;

const structuredLog = getLogger("coding-agent.daemon-supervisor");
// Windows antivirus scanning can delay worker startup beyond 30 seconds.
const WORKER_CONNECT_TIMEOUT_MS = process.platform === "win32" ? 90_000 : 30_000;
const WORKER_CONNECT_PROBE_MS = process.platform === "win32" ? 2_000 : 500;
const WORKER_PROBE_BACKOFF_MIN_MS = 25;
const WORKER_PROBE_BACKOFF_MAX_MS = process.platform === "win32" ? 2_000 : 25;

/** Per-attempt handshake waits consume the remaining outer connect budget; a smaller fixed clock makes a consistently slow (win32) handshake fail every retry. */
export function handshakeBudgetMs(deadline: number, now = Date.now()): number {
	const remaining = deadline - now;
	if (remaining <= 0) throw new DaemonWorkerProbeTimeoutError("Worker connection deadline elapsed");
	return remaining;
}
const ROSTER_WATCHDOG_INTERVAL_MS = 15_000;
const ROSTER_STALE_AFTER_MS = 3 * ROSTER_HEARTBEAT_INTERVAL_MS;
const SUPERVISOR_SERVER_CAPABILITIES: readonly DaemonServerCapability[] = [
	...DAEMON_DEFAULT_SERVER_CAPABILITIES,
	...DAEMON_SUPERVISOR_ONLY_SERVER_CAPABILITIES,
];
const PEER_TRANSPORT_GRANT_TTL_MS = 10_000;
// P1-7b: the long tier of the split budget table. A fresh create and a
// user-explicit long command keep it; reads, the delivery leg and adoption have
// their own tier (see daemon-timeouts.ts). Numerically identical to the 24h
// literal upstream inlines, so `forwardToWorker`'s default budget is unchanged.
const WORKER_REQUEST_TIMEOUT_MS = WORKER_REQUEST_TIMEOUT_TIERS.long;
// Startup adoption waits on a bounded window instead: a worker that never answers
// must park failed rather than keep the supervisor from opening its socket (F14).
// Must stay equal to the update-restart adoption budget (appendix A of the fix plan).
export const ADOPTION_WORKER_REQUEST_TIMEOUT_MS = DAEMON_ADOPTION_REQUEST_TIMEOUT_MS;
/**
 * Connect budget for a worker that is already alive and listening: startup
 * adoption, and recovery probes of the deferred ladder. Upstream raised every
 * connect site to `WORKER_CONNECT_TIMEOUT_MS` because Windows antivirus can stall
 * a named-pipe connect past 30s (#2036); the fork keeps its tight POSIX value
 * because the whole adoption lane is bounded (F14) and a wedged worker must park
 * failed instead of holding the socket open. Exported so a test can pin both
 * platforms without spying on call sites.
 */
export const ADOPTION_WORKER_CONNECT_TIMEOUT_MS = process.platform === "win32" ? WORKER_CONNECT_TIMEOUT_MS : 2_000;
/**
 * One recovery probe of the deferred ladder: three probes per round
 * (`WORKER_RETRY_DELAYS_MS`), `MAX_DEFERRED_RECOVERY_ROUNDS` rounds. The win32
 * side gets room for antivirus but stays an order of magnitude below the 90s
 * connect budget, or the "~2.5 minutes of probing" that budget documents turns
 * into tens of minutes on a worker that will never answer.
 */
export const RECOVERY_PROBE_CONNECT_TIMEOUT_MS = process.platform === "win32" ? 10_000 : 1_500;
// Failed-worker reaper cadence (L5). The threshold itself is settings-driven.
const FAILED_WORKER_REAP_INTERVAL_MS = 5 * 60_000;
/**
 * How often the supervisor checks the retention cadence. The cadence itself comes
 * from `retention.sweepIntervalMinutes`; this tick only decides when to look, so a
 * settings change is honoured without a restart.
 */
const RETENTION_SWEEP_CHECK_INTERVAL_MS = 5 * 60_000;
// L3: how many workers are adopted concurrently once the socket is already open.
const ADOPTION_CONCURRENCY = 4;
// L3/amend: a session with scheduled jobs is re-adopted on a backoff instead of being
// parked failed, so an unattended heartbeat does not silently stop at startup.
const ADOPTION_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];
// The daemon client's default request budget is 30s and each ready-worker heartbeat
// forward gets 5s, so waiting longer than this on in-flight launches would only
// surface as a client transport timeout instead of a bounded per-worker state error.
export const HEARTBEAT_LIST_LAUNCH_WAIT_MS = 15_000;
// Session-scoped listing must fail inside the client's request budget too; the
// worker request default (24h) would turn a stuck worker into a client transport
// timeout instead of a daemon-side failure.
export const HEARTBEAT_LIST_FORWARD_TIMEOUT_MS = 25_000;
const INPUT_PAUSE_CLEANUP_TIMEOUT_MS = 5_000;
const UPDATE_RESTART_MUTATION_DRAIN_TIMEOUT_MS = 80_000;
// P1-7c: how often a delivery to a target that is not reachable yet is retried.
// Same cadence as DEFERRED_RECOVERY_RECHECK_MS below, so a retry lands about when
// the recovery recheck can have changed the state.
const PENDING_DELIVERY_RETRY_INTERVAL_MS = 5_000;
// F3: how long a delivery keeps bouncing off a target whose registration is gone
// before the loss is terminal. Longer than a recovery relaunch's stop-and-register
// window (a forced stop escalates within ~1.5s), shorter than any sender's patience.
const DELIVERY_TARGET_GONE_GRACE_MS = 15_000;
const UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS = 90_000;
// The whole pre-commit prepare (drain + worker fencing) must finish inside the
// caller's 120s prepare_update_restart request timeout, or roll back; otherwise
// an abandoned prepare leaves the daemon permanently fenced with workers stopped.
const UPDATE_RESTART_PREPARE_DEADLINE_MS = 100_000;
// A prepared checkpoint older than this is treated as an abandoned handoff: the
// supervisor does not re-enter the prepared phase for it, so ordinary recovery
// wins the sessions back instead of serving a stale fence.
const UPDATE_RESTART_PREPARED_RESTORE_WINDOW_MS = 30 * 60_000;
// A checkpoint NEWER than this belongs to a handoff the coordinator is still
// driving: it stops the predecessor, starts the successor, and restores into it,
// clearing the manifest at the end. Re-entering the prepared phase for such a
// fresh checkpoint would fence the successor and reject the coordinator's
// restore creates. Only re-enter the prepared phase once the checkpoint is old
// enough that the driving coordinator is gone (abandoned handoff).
const UPDATE_RESTART_PREPARED_RESTORE_MIN_AGE_MS = 5 * 60_000;
const WORKER_RETRY_DELAYS_MS = [250, 1000, 5000] as const;
/**
 * Upper bound on relay payloads deferred per client and session while a
 * snapshot stream is active. Deferral spans one stream (seconds), so overflow
 * means a pathologically slow client; the supervisor then falls back to a
 * catch-up snapshot instead of buffering without limit.
 */
const MAX_DEFERRED_SESSION_PAYLOADS = 256;
const MAX_DEFERRED_SESSION_BYTES = 8 * 1024 * 1024;
const DEFERRED_RECOVERY_RECHECK_MS = 5000;
// POSIX: ~2.5 minutes of probing — each round is one 5s defer recheck plus a
// ~11s three-delay probe pass (3 x (delay + a 1.5s connect probe)). Windows gives
// each connect probe 10s instead, so the same ten rounds span ~6 minutes there.
const MAX_DEFERRED_RECOVERY_ROUNDS = 10;
/**
 * How long a stream-ending snapshot frame waits for a suspended client's socket to
 * drain before the stream gives up and releases what it holds. Mirrors the worker
 * side's WORKER_SNAPSHOT_TERMINAL_DRAIN_TIMEOUT_MS; data chunks are never bounded.
 * A timeout leaves `client.backpressured` set: the socket genuinely still holds
 * undrained bytes, and the queued resync runs from the `"drain"` handler the
 * moment the client resumes. Do not clear it here — that would let the next
 * write pile onto a stalled socket past the deferred-payload caps.
 */
const SNAPSHOT_TERMINAL_DRAIN_TIMEOUT_MS = 1_000;
const STOP_FINALIZATION_RECHECK_MS = 250;
const STOP_FINALIZATION_SIGKILL_GRACE_MS = 5000;
const STOP_FINALIZATION_RETRY_MS = 5000;
/**
 * Wall-clock terminal for the background wait on a worker that survived SIGKILL.
 * A process in uninterruptible sleep (wedged storage), a zombie nobody reaps, or
 * an identity query that keeps coming back unobservable would otherwise keep this
 * loop polling every 250ms for the rest of the supervisor's life. Giving up keeps
 * the registration and the stop tombstone — nothing irreversible happens — and
 * says so in the log instead of spinning silently.
 */
export const STOP_FINALIZATION_MAX_MS = 10 * 60_000;
const STALE_RECLAIM_WAIT_MS = 10_000;
// Polling loops probe existence cheaply via kill(0); the ps-backed zombie and
// identity checks are throttled so a wedged worker cannot saturate the
// supervisor event loop with synchronous subprocess spawns.
// Windows identity lookups launch PowerShell, so recheck less often there.
const LIVENESS_IDENTITY_RECHECK_MS = process.platform === "win32" ? 3_000 : 500;
const OWNED_WORKER_DISCONNECT_GRACE_MS = 30_000;
const IDLE_EVICTION_MAX_SWEEP_INTERVAL_MS = 5 * 60_000;
const IDLE_EVICTION_MIN_SWEEP_INTERVAL_MS = 60_000;
const IDLE_EVICTION_DRAIN_TIMEOUT_MS = 5_000;
const CHILD_PASSIVATION_PER_WORKER_CAP = 2;
const SCHEDULED_WAKE_RETRY_MS = 60_000;
const SCHEDULED_WAKE_MAX_TIMEOUT_MS = 2_147_483_647;
const SCHEDULED_WAKE_CLIENT_ID = "scheduled-wake";
const SUPERVISOR_CONFIG_FILE_NAME = "supervisor-config";
const WORKER_STARTUP_GATE_FD = 3;

/**
 * Bounded retry budget for a client catch-up that failed transiently (C10).
 * Both bounds are hard: the attempt cap stops a permanently failing session and
 * the deadline caps the wall-clock window, so jitter can spread concurrent
 * clients without stretching how long one lagging client is retried for.
 */
export interface ClientCatchupRetryPolicy {
	/** Exponential backoff schedule; the last entry is also the cap for later attempts. */
	backoffMs: readonly number[];
	/** Per-attempt backoff ceiling, before jitter. */
	capMs: number;
	/** Consecutive transient failures after which the client is told to re-pull. */
	maxAttempts: number;
	/** Upper bound of the random spread added to each delay so clients do not retry in lockstep. */
	jitterMs: number;
	/** Wall-clock budget for one (client, session) failure streak. */
	deadlineMs: number;
	/** Repeated failures for one (client, session) log at most one warn per window. */
	logThrottleMs: number;
}

export const DEFAULT_CLIENT_CATCHUP_RETRY_POLICY: ClientCatchupRetryPolicy = {
	backoffMs: [250, 500, 1_000, 2_000, 4_000, 8_000],
	capMs: 8_000,
	maxAttempts: 40,
	jitterMs: 60_000,
	deadlineMs: 5 * 60_000,
	logThrottleMs: 60_000,
};

/**
 * Delay before the next catch-up retry, or `undefined` once the budget is spent.
 * `attempt` is the 1-based count of consecutive failures, `remainingMs` the time
 * left on the streak deadline.
 */
export function clientCatchupRetryDelayMs(
	policy: ClientCatchupRetryPolicy,
	attempt: number,
	jitterMs: number,
	remainingMs: number,
): number | undefined {
	if (attempt < 1 || attempt >= policy.maxAttempts || remainingMs <= 0) {
		return undefined;
	}
	const backoff = policy.backoffMs[Math.min(attempt, policy.backoffMs.length) - 1] ?? policy.capMs;
	const jitter = Math.max(0, Math.min(jitterMs, policy.jitterMs));
	return Math.max(1, Math.min(Math.min(backoff, policy.capMs) + jitter, remainingMs));
}

/**
 * Transient catch-up failures are retried; everything else is handed straight to
 * the client for a full re-pull. The transient set is deliberately narrow: an
 * unknown or ambiguous session never becomes resolvable by waiting, and retrying
 * it would only delay the loud failure the client needs in order to self-heal.
 */
const TRANSIENT_CATCHUP_FAILURES: readonly RegExp[] = [
	/Session worker is recovering/i,
	/was superseded/i,
	/\btimed out\b/i,
];

const SUPERVISOR_REJECTION_WINDOW_MS = 60 * 60 * 1000;
const SUPERVISOR_REJECTION_LOG_THROTTLE_MS = 60 * 1000;
const SUPERVISOR_DEGRADED_LOG_THROTTLE_MS = 10 * 1000;

export interface SupervisorCrashHandlerOptions {
	/** Sink for the human-readable line; defaults to stderr. */
	log?: (message: string) => void;
	/** Called for every isolated rejection, so the supervisor can mark itself degraded. */
	recordRejection?: (detail: string) => void;
	/**
	 * C18: exit(1) once the windowed rejection count reaches this. Disabled unless
	 * positive — the shipped default is log-and-isolate, and the threshold is a
	 * deliberate deviation from the worker-side handler, which exits on the first one.
	 */
	rejectionExitThreshold?: number;
	rejectionWindowMs?: number;
	rejectionLogThrottleMs?: number;
	/** Exit hook, injectable so a test can assert the verdict without killing its runner. */
	exit?: (code: number) => void;
}

/**
 * Process-level last line of defence for the supervisor (L6). An uncaught
 * exception means the process state cannot be trusted, so it is logged with its
 * stack and the process exits. An unhandled rejection is isolated instead: the
 * supervisor is a global single point, and one leaked promise must not take every
 * session down with it. Rejections are counted over a sliding window and logged at
 * a bounded rate so a storm stays visible without drowning the log.
 *
 * Returns the uninstaller; the supervisor removes the handlers when it stops.
 */
export function installSupervisorCrashHandlers(options: SupervisorCrashHandlerOptions = {}): () => void {
	const log = options.log ?? ((message: string) => console.error(message));
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const windowMs = options.rejectionWindowMs ?? SUPERVISOR_REJECTION_WINDOW_MS;
	const throttleMs = options.rejectionLogThrottleMs ?? SUPERVISOR_REJECTION_LOG_THROTTLE_MS;
	const rejectionTimestamps: number[] = [];
	let suppressedRejections = 0;
	let lastRejectionLogAt = 0;

	const onUncaughtException = (error: Error) => {
		log(`supervisor uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
		exit(1);
	};
	const onUnhandledRejection = (reason: unknown) => {
		const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
		const now = Date.now();
		while (rejectionTimestamps.length > 0 && now - (rejectionTimestamps[0] ?? 0) > windowMs) {
			rejectionTimestamps.shift();
		}
		rejectionTimestamps.push(now);
		const count = rejectionTimestamps.length;
		options.recordRejection?.(detail);
		if (now - lastRejectionLogAt >= throttleMs) {
			lastRejectionLogAt = now;
			const suppressed = suppressedRejections > 0 ? `, ${suppressedRejections} suppressed since the last line` : "";
			suppressedRejections = 0;
			log(`supervisor unhandled rejection (count in the last ${windowMs}ms: ${count}${suppressed}): ${detail}`);
		} else {
			suppressedRejections++;
		}
		const threshold = options.rejectionExitThreshold;
		if (threshold !== undefined && threshold > 0 && count >= threshold) {
			log(`supervisor exiting after ${count} unhandled rejections within ${windowMs}ms (threshold ${threshold})`);
			exit(1);
		}
	};
	process.on("uncaughtException", onUncaughtException);
	process.on("unhandledRejection", onUnhandledRejection);
	return () => {
		process.off("uncaughtException", onUncaughtException);
		process.off("unhandledRejection", onUnhandledRejection);
	};
}

/**
 * Asynchronous process start identity (I-7) is the canonical `session-lease`
 * helper, re-exported because the reaper and the tests reach it through this
 * module. `getProcessStartId` shells out with execFileSync on macOS/BSD/Windows,
 * and a periodic sweep must not block the supervisor's single thread with it —
 * that is exactly the stall a worker liveness probe would then misread. The
 * canonical version is also the one that bounds the query (a wedged `ps` or
 * `powershell` rejects after 5s and reads as unobservable) — a local copy without
 * that timeout turned one wedged helper process into a reaper whose single-flight
 * promise never settled, silently for the rest of the supervisor's life.
 */
export { getProcessStartIdAsync };

/**
 * The reaper's death proof (L5): the pid is gone, or it is alive under a start
 * identity that is demonstrably somebody else's. Anything unobservable counts as
 * alive, because a failed-worker registration is deleted irreversibly.
 */
export async function isProcessIdentityConfirmedDead(
	pid: number,
	recordedStartId: string | undefined,
): Promise<boolean> {
	if (!processIdExists(pid)) {
		return true;
	}
	if (recordedStartId === undefined) {
		return false;
	}
	const observedStartId = await getProcessStartIdAsync(pid);
	if (observedStartId === undefined) {
		return false;
	}
	return observedStartId !== recordedStartId;
}

/** Worker-availability errors that are ordinary transient states rather than faults. */
const EXPECTED_WORKER_AVAILABILITY_ERRORS: readonly RegExp[] = [
	/^Session worker is (recovering|stopping|starting)\b/,
	/^Session worker is not connected\b/,
];

export function isExpectedWorkerAvailabilityError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return EXPECTED_WORKER_AVAILABILITY_ERRORS.some((pattern) => pattern.test(message));
}

/**
 * The timeout tier for one agent-message dispatch, keyed on the dispatches
 * actually written to a worker — never on pre-dispatch bounces. The first
 * dispatch keeps the long budget (C20: the sender is waiting on it and a slow
 * target hydration is legitimate work — and recovering-from-a-bounce is exactly
 * when that hydration happens); only a *retried* dispatch runs on the deliver
 * tier (daemon-timeouts.ts T4-3).
 */
export function deliveryDispatchTimeoutTier(dispatches: number): WorkerRequestTimeoutTier {
	return dispatches === 0 ? "long" : "deliver";
}

/**
 * What one delivery actually got as far as the wire. Counting the supervisor's own
 * attempts is not enough: an attempt can fail before a byte is written (the worker
 * client was already closed), and reporting that as "may already have been
 * delivered" tells the sender not to re-send a message that provably never left.
 * The client reports the two stages instead, so the verdict below is keyed on the
 * transport and the pre-write failures stay countable as bounces.
 */
export class DeliveryDispatchCounter {
	private queued = 0;
	private confirmed = 0;

	/** Handed to `DaemonWorkerClient.requestWorker` for the delivery's dispatch. */
	readonly hooks: DaemonWorkerRequestHooks = {
		onDispatch: (stage) => {
			if (stage === "queued") {
				this.queued++;
			} else {
				this.confirmed++;
			}
		},
	};

	/**
	 * Frames handed to the socket, in flight or written. From the first one on,
	 * non-delivery is not provable: a write that fails halfway can still have
	 * reached the target, and only its answer was lost.
	 */
	get dispatches(): number {
		return this.queued;
	}

	/** Frames the socket accepted in full; `dispatches - written` were in flight when the failure hit. */
	get written(): number {
		return this.confirmed;
	}

	get mayHaveBeenDelivered(): boolean {
		return this.queued > 0;
	}
}

export function isTransientCatchupFailure(error: unknown): boolean {
	if (error instanceof DaemonSessionRecoveringError) return true;
	const message = error instanceof Error ? error.message : String(error);
	return TRANSIENT_CATCHUP_FAILURES.some((pattern) => pattern.test(message));
}

/**
 * P1-7a: how long a rejected command should wait before it is worth re-issuing,
 * reported on the failure response as `retryAfterMs`. The hint is the
 * supervisor's own recheck interval for that state, so a client waits exactly as
 * long as the state is expected to last instead of guessing.
 *
 * Only pre-dispatch rejections qualify: both patterns are thrown before the
 * command reaches a worker, so nothing was executed and re-issuing is safe.
 * `failed` deliberately has no hint — it is terminal and the caller's action is
 * `retry_worker`, not waiting. The patterns are anchored because a worker's own
 * failure text ("Cannot list heartbeats while session worker is recovering") is
 * forwarded verbatim and carries no such guarantee.
 */
const TRANSIENT_RETRY_AFTER_MS: readonly { pattern: RegExp; retryAfterMs: number }[] = [
	{ pattern: /^Session worker is recovering\b/, retryAfterMs: DEFERRED_RECOVERY_RECHECK_MS },
	{ pattern: /^Session worker is stopping\b/, retryAfterMs: STOP_FINALIZATION_RECHECK_MS },
];

export function transientRetryAfterMs(error: unknown): number | undefined {
	// A capacity rejection is retryable by construction: nothing was queued.
	if (error instanceof PendingDeliveryCapacityError) {
		return error.retryAfterMs;
	}
	// The typed recovering error carries the same hint as the string contract.
	if (error instanceof DaemonSessionRecoveringError) {
		return DEFERRED_RECOVERY_RECHECK_MS;
	}
	const message = error instanceof Error ? error.message : String(error);
	return TRANSIENT_RETRY_AFTER_MS.find((entry) => entry.pattern.test(message))?.retryAfterMs;
}

/**
 * Mutating commands whose in-flight duration must not gate the update-restart
 * drain (P1-7c). They are tracked and drained by name instead, so the drain is
 * not disabled — it just no longer waits on a delivery that may legitimately
 * take as long as the 24h budget.
 */
const LONG_DELIVERY_DRAIN_EXEMPT_COMMANDS: ReadonlySet<string> = new Set(["send_message"]);

/** Terminal commands converge on a target that is already gone instead of failing (C19/L4). */
const TERMINAL_DAEMON_COMMANDS: ReadonlySet<string> = new Set(["kill", "abort", "cancel_rlm_child"]);

const DAEMON_COMMAND_TYPES: ReadonlySet<string> = new Set([
	"ack_result",
	"declare_client_capabilities",
	"list",
	"list_agent_peers",
	"get_direct_worker_transport",
	"roster_subscribe",
	"roster_unsubscribe",
	"list_saved_sessions",
	"create",
	"attach",
	"reattach",
	"detach",
	"complete_owned_session",
	"promote_owned_session",
	"kill",
	"rename",
	"prompt",
	"cancel_prompt_admission",
	"prompt_and_wait",
	"steer",
	"follow_up",
	"restore_next_turn",
	"restore_actions",
	"append_custom_message",
	"resume_queue",
	"send_message",
	"agent_messages_status",
	"agent_messages_pause",
	"agent_messages_resume",
	"agent_messages_clear",
	"abort",
	"abort_and_send_queued",
	"start_side_question",
	"abort_side_question",
	"execute_bash",
	"execute_bash_and_wait",
	"abort_bash",
	"cancel_rlm_child",
	"delete_rlm_subagent",
	"wait_for_idle",
	"wait_for_headless_completion",
	"get_session_header",
	"get_state",
	"get_connection_state",
	"get_messages",
	"get_rlm_children",
	"get_session_stats",
	"get_context_tree",
	"get_commands",
	"get_resource_snapshot",
	"replace_acp_mcp_servers",
	"get_model_catalog",
	"get_available_models",
	"get_queue",
	"mutate_queued_message",
	"clear_queue",
	"abort_and_clear_queue",
	"acquire_session_input_pause",
	"release_session_input_pause",
	"cron_list",
	"heartbeats_list",
	"heartbeat_manage",
	"cron_add",
	"cron_cancel",
	"heartbeat_get",
	"heartbeat_set",
	"heartbeat_update",
	"set_model",
	"cycle_model",
	"set_scoped_models",
	"set_thinking_level",
	"cycle_thinking_level",
	"set_service_tier",
	"set_transport",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_auto_compaction",
	"set_auto_retry",
	"compact",
	"refine",
	"abort_compaction",
	"abort_branch_summary",
	"abort_retry",
	"reload",
	"new_session",
	"switch_session",
	"fork",
	"navigate_tree",
	"import_jsonl",
	"export_html",
	"export_jsonl",
	"set_session_name",
	"get_rlm_max_depth_status",
	"set_rlm_max_depth",
	"rename_saved_session",
	"delete_saved_session",
	"get_session_context",
	"get_session_tree",
	"get_user_messages_for_forking",
	"get_last_assistant_text",
	"get_system_prompt",
	"get_tool_definition",
	"set_session_entry_label",
	"extension_ui_response",
	"prepare_update_restart",
	"retry_worker",
	"restart",
	"shutdown",
]);

interface ResidentWorker {
	descriptor: DaemonWorkerDescriptor;
	descriptorPath: string;
	client?: DaemonWorkerClient;
	heartbeatSnapshot?: AgentConnectionHeartbeat[];
	heartbeatSnapshotStale?: boolean;
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, DaemonAttachResult>;
	transcriptCaches: Map<string, SnapshotTranscriptCache>;
	snapshotGenerations: Map<string, Map<string, SnapshotTranscriptGeneration>>;
	snapshotLoads: Map<string, Promise<DaemonAttachResult>>;
	recovery?: Promise<void>;
	deferredRecovery?: Promise<void>;
	intentionalStop: boolean;
	stopRevision: number;
	launchEnv?: Record<string, string>;
	transientCreateCommand?: DaemonCreateCommand;
	stopFinalization?: Promise<void>;
	ownerCleanupTimer?: ReturnType<typeof setTimeout>;
	promotedOwnerClientId?: string;
	updateRestartPrepareClient?: DaemonWorkerClient;
	lastFrameAt?: number;
	rosterStale?: boolean;
	/** worker_auth advertised peer-transport support; absent on workers from older builds. */
	peerTransportCapable?: boolean;
	/** In-flight replacement connection during authentication; an allowed frame source alongside client. */
	pendingClient?: DaemonWorkerClient;
	/** Consecutive defer->probe rounds against a live-but-silent worker; bounded by MAX_DEFERRED_RECOVERY_ROUNDS. */
	deferredRecoveryRounds?: number;
	/** Backoff re-adoption attempts spent on a worker whose sessions have scheduled jobs (L3). */
	adoptionRetryAttempt?: number;
	/** Bumped per applied roster frame; a summaries pull that straddles a frame must not gap-fill. */
	rosterEpoch?: number;
	rosterApplyChain?: Promise<void>;
	rosterRepairPull?: Promise<void>;
}

/**
 * The peer list a worker has already accepted, tied to the connection that
 * accepted it. A reconnect installs a fresh client whose worker process knows
 * no peers, so identity comparison retires the memo without extra bookkeeping.
 */

interface SnapshotDuplicateValidation {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

interface SnapshotTranscriptGeneration {
	transcript: SnapshotTranscriptCache;
	result: DaemonAttachResult;
	begin?: Buffer;
	end?: Buffer;
	incoming: boolean;
	retired: boolean;
	duplicateChunkIndex?: number;
	duplicateResult?: DaemonAttachResult;
	validation?: SnapshotDuplicateValidation;
}

export interface DaemonSupervisorOptions {
	socketPath?: string;
	defaultSessionConfig: AgentSessionRuntimeConfig;
	descriptorDir?: string;
	/** Overrides the bounded client catch-up retry policy (C10); defaults to the production schedule. */
	catchupRetryPolicy?: ClientCatchupRetryPolicy;
	/** Overrides how long a startup adoption may wait on one worker request (F14). */
	adoptionRequestTimeoutMs?: number;
	/** Overrides the failed-worker reaper cadence; defaults to FAILED_WORKER_REAP_INTERVAL_MS. */
	failedWorkerReapIntervalMs?: number;
	/** Overrides the retention sweep cadence check; defaults to RETENTION_SWEEP_CHECK_INTERVAL_MS. */
	retentionSweepCheckIntervalMs?: number;
	/** Overrides the backoff used to re-adopt a worker whose sessions have scheduled jobs. */
	adoptionRetryDelaysMs?: readonly number[];
	/** Overrides the pending agent-message delivery queue bound per target session (P1-7c). */
	pendingDeliveryCapacity?: number;
	/** Overrides the interval between two delivery attempts for a target that is not reachable yet. */
	pendingDeliveryRetryIntervalMs?: number;
	/** Overrides how long a delivery bounces off a target whose worker registration is gone before failing (F3). */
	pendingDeliveryTargetGoneGraceMs?: number;
	/** Overrides the requeue log throttle window (one line per target session per window). */
	pendingDeliveryLogThrottleMs?: number;
	/** Overrides how long update-restart preparation waits for in-flight mutations to drain. */
	updateRestartDrainTimeoutMs?: number;
}

interface PersistedSupervisorConfig {
	version: 1;
	socketPath: string;
	defaultSessionConfig: DurableAgentSessionRuntimeConfig;
}

interface WorkerMatch {
	worker: ResidentWorker;
	summary: SessionSummary;
}

interface WorkerAttachData {
	result: DaemonAttachResult;
	worker: ResidentWorker;
	transcript?: SnapshotTranscriptCache;
	releaseTranscript?: () => void;
}

interface SupervisorPromptAdmission {
	client: DaemonSocketClient;
	activeSessionId: string;
	publicAdmissionId: string;
	workerAdmissionId: string;
	status: "waiting" | "owned" | "cancelled";
	controller: AbortController;
	worker?: ResidentWorker;
	workerActiveSessionId?: string;
}

interface SupervisorSessionInputPause {
	owner: DaemonSocketClient;
	worker: ResidentWorker;
	activeSessionId: string;
	requestedActiveSessionId: string;
	leaseKey: string;
	pauseId: string;
	releaseTask?: Promise<DaemonResponse>;
}

function throwIfAdmissionCancelled(admission: SupervisorPromptAdmission | undefined): void {
	if (admission?.status === "cancelled") throw new PromptAdmissionCancelledError();
}

class SupervisorRecoveryCancelledError extends Error {
	readonly code = "supervisor_recovery_cancelled" as const;
}

class SnapshotLoadInvalidatedError extends Error {}

class WorkerStopTimeoutError extends Error {}

function isSupervisorGenerationStale(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "supervisor_generation_stale"
	);
}

function isSupervisorRecoveryCancelled(error: unknown): boolean {
	return isSupervisorShutdownAdmissionCancelled(error) || isSupervisorGenerationStale(error);
}

// Workers can be registered mid-tree (a resumed subagent transcript), so descent is membership at
// any step of the parent walk, never a comparison against the ultimate root alone.
function rosterFamilyDescendsFrom(
	edges: readonly RlmLedgerEdge[],
): (path: string, roots: ReadonlySet<string>) => boolean {
	const parentByChild = new Map(
		edges.map((edge) => [canonicalSessionPath(edge.child), canonicalSessionPath(edge.parent)]),
	);
	return (path, roots) => {
		const visited = new Set<string>();
		let current = path;
		while (!visited.has(current)) {
			if (roots.has(current)) return true;
			visited.add(current);
			const parent = parentByChild.get(current);
			if (parent === undefined) return false;
			current = parent;
		}
		return false;
	};
}

function isDaemonWorkerProbeTimeout(error: unknown): boolean {
	return error instanceof DaemonWorkerProbeTimeoutError;
}

function isSupervisorShutdownAdmissionCancelled(error: unknown): boolean {
	return (
		error instanceof SupervisorRecoveryCancelledError ||
		(typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: unknown }).code === "supervisor_recovery_cancelled")
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function unrefDelay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms).unref());
}

function commitWorkerStartupGate(gate: Writable): Promise<void> {
	return new Promise((resolveCommit, rejectCommit) => {
		let settled = false;
		const finish = (error?: Error | null) => {
			if (settled) {
				return;
			}
			settled = true;
			if (error) {
				rejectCommit(error);
			} else {
				resolveCommit();
			}
		};
		const onError = (error: Error) => finish(error);
		gate.on("error", onError);
		gate.once("close", () => gate.off("error", onError));
		gate.end(DAEMON_WORKER_STARTUP_GATE_COMMIT, (error?: Error | null) => finish(error));
	});
}

function withoutCommandId(command: DaemonCommand): DaemonCommandBody {
	const { id: _id, ...body } = command;
	return body as DaemonCommandBody;
}

function withoutSupervisorCreateFields(command: DaemonCreateCommand): DaemonCreateCommand {
	const { launchEnv: _launchEnv, lifecycle: _lifecycle, ...workerCommand } = command;
	return workerCommand;
}

function responseWithId(response: DaemonResponse, id: string | undefined): DaemonResponse {
	return { ...response, id };
}

/** The minimum a roster frame entry must carry to be classified and written. */
function isWorkerRosterEntry(value: unknown): value is WorkerRosterEntry {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const entry = value as { agentId?: unknown; summary?: unknown };
	return typeof entry.agentId === "string" && isSessionSummary(entry.summary);
}

function isSessionSummary(value: unknown): value is SessionSummary {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { id?: unknown; sessionId?: unknown; cwd?: unknown };
	return (
		typeof candidate.id === "string" && typeof candidate.sessionId === "string" && typeof candidate.cwd === "string"
	);
}

/**
 * A JSON object carrying a numeric `version` is somebody's descriptor — possibly
 * one a newer build wrote in a format this one does not know. Only that shape is
 * left alone when it cannot be used; anything else is garbage (a torn write, a
 * truncated file, a stray `.json`) and is quarantined instead of being re-parsed
 * and re-logged on every startup forever.
 */
function claimsDescriptorVersion(value: unknown): boolean {
	return typeof value === "object" && value !== null && typeof (value as { version?: unknown }).version === "number";
}

function isDaemonWorkerDescriptorShape(value: unknown): value is DaemonWorkerDescriptor {
	if (!value || typeof value !== "object") {
		return false;
	}
	const descriptor = value as Partial<DaemonWorkerDescriptor>;
	return (
		(descriptor.version === 1 || descriptor.version === 2) &&
		typeof descriptor.supervisorSocketPath === "string" &&
		typeof descriptor.workerId === "string" &&
		Number.isInteger(descriptor.pid) &&
		(descriptor.pid ?? 0) > 0 &&
		(descriptor.processStartId === undefined || typeof descriptor.processStartId === "string") &&
		(descriptor.ownerClientId === undefined || typeof descriptor.ownerClientId === "string") &&
		typeof descriptor.socketPath === "string" &&
		typeof descriptor.authenticationToken === "string" &&
		(descriptor.workerInstanceId === undefined || typeof descriptor.workerInstanceId === "string") &&
		typeof descriptor.rootActiveSessionId === "string" &&
		typeof descriptor.createdAt === "string" &&
		typeof descriptor.updatedAt === "string" &&
		Number.isInteger(descriptor.consecutiveFailures) &&
		descriptor.createCommand !== undefined &&
		typeof descriptor.createCommand === "object" &&
		descriptor.createCommand.type === "create"
	);
}

function isDaemonWorkerDescriptor(value: unknown, socketPath: string): value is DaemonWorkerDescriptor {
	return isDaemonWorkerDescriptorShape(value) && normalizeSocketPath(value.supervisorSocketPath) === socketPath;
}

class PreRosterWorkerError extends Error {}

function workerAuthAdvertisesRoster(data: unknown): boolean {
	if (typeof data !== "object" || data === null) return false;
	const capabilities = (data as { capabilities?: unknown }).capabilities;
	return Array.isArray(capabilities) && capabilities.includes(DAEMON_WORKER_ROSTER_CAPABILITY);
}

function workerAuthAdvertisesPeerTransport(data: unknown): boolean {
	if (typeof data !== "object" || data === null) return false;
	const capabilities = (data as { capabilities?: unknown }).capabilities;
	return Array.isArray(capabilities) && capabilities.includes(DAEMON_WORKER_PEER_TRANSPORT_CAPABILITY);
}

function sessionSummariesFromResponse(response: DaemonResponse): SessionSummary[] {
	if (!response.success || !response.data || typeof response.data !== "object" || !("sessions" in response.data)) {
		throw new Error("Session worker returned an invalid list response");
	}
	const sessions = (response.data as { sessions: unknown }).sessions;
	if (!Array.isArray(sessions) || !sessions.every(isSessionSummary)) {
		throw new Error("Session worker returned an invalid list response");
	}
	return sessions;
}

function attachResultFromResponse(response: DaemonResponse): DaemonAttachResult {
	if (!response.success || !response.data || typeof response.data !== "object") {
		throw new Error(response.success ? "Session worker returned an invalid attach response" : response.error);
	}
	const candidate = response.data as Partial<DaemonAttachResult>;
	if (typeof candidate.activeSessionId !== "string" || !candidate.snapshot || !candidate.client) {
		throw new Error("Session worker returned an invalid attach response");
	}
	return candidate as DaemonAttachResult;
}

function cronJobsFromResponse(response: DaemonResponse): AgentCronJob[] {
	if (!response.success || !response.data || typeof response.data !== "object") {
		return [];
	}
	const jobs = (response.data as { jobs?: unknown }).jobs;
	return Array.isArray(jobs) ? (jobs as AgentCronJob[]) : [];
}

function heartbeatsFromResponse(response: DaemonResponse): AgentConnectionHeartbeat[] {
	if (!response.success || !response.data || typeof response.data !== "object") {
		return [];
	}
	const heartbeats = (response.data as { heartbeats?: unknown }).heartbeats;
	return Array.isArray(heartbeats) ? (heartbeats as AgentConnectionHeartbeat[]) : [];
}

function sortCronJobs(jobs: AgentCronJob[]): AgentCronJob[] {
	return jobs.sort((left, right) => {
		if (left.nextRunAt === right.nextRunAt) {
			return 0;
		}
		if (left.nextRunAt === undefined) {
			return 1;
		}
		if (right.nextRunAt === undefined) {
			return -1;
		}
		return Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt);
	});
}

function descriptorKey(socketPath: string): string {
	return createHash("sha256").update(normalizeSocketPath(socketPath)).digest("hex").slice(0, 12);
}

function defaultWorkerDescriptorDir(agentDir: string, socketPath: string): string {
	return join(agentDir, "daemon-workers", descriptorKey(socketPath));
}

export function idleEvictionSweepIntervalMs(idleEvictionMinutes: IdleEvictionMinutes): number {
	if (idleEvictionMinutes === "off") return IDLE_EVICTION_MAX_SWEEP_INTERVAL_MS;
	return Math.max(
		IDLE_EVICTION_MIN_SWEEP_INTERVAL_MS,
		Math.min(IDLE_EVICTION_MAX_SWEEP_INTERVAL_MS, (idleEvictionMinutes * 60_000) / 3),
	);
}

function workerSocketPath(supervisorSocketPath: string, workerId: string): string {
	const key = descriptorKey(supervisorSocketPath);
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-worker-${key}-${workerId.slice(0, 12)}`;
	}
	return join(defaultDaemonSocketDir(), `worker-${key}-${workerId.slice(0, 12)}.sock`);
}

/**
 * How old a worker socket with no descriptor behind it must be before the
 * sweep dares to remove it (R31-5): the DAT-3 precedent (stale compaction
 * temps, orphan-process-journal.ts) — a young orphaned socket may belong to a
 * worker whose descriptor write is still in flight, so only the provably dead
 * (pid gone) or the provably old (past the gate) are removed.
 */
export const STALE_WORKER_SOCKET_MAX_AGE_MS = 60_000;

export interface WorkerSocketSweepResult {
	removed: string[];
	/** Kept entries with the reason, so the supervisor log shows the verdicts. */
	kept: Array<{ path: string; reason: string }>;
}

/**
 * Sweep stale `worker-*.sock` files this supervisor's socket dir (R31-5):
 * a SIGKILLed worker cannot run its own exit cleanup, so its socket file
 * accumulates forever otherwise (59 measured on one machine).
 *
 * Removal rules, in order:
 * 1. A descriptor names the socket and that pid is dead -> remove (the worker
 *    is gone; a relaunch re-binds the path after prepareDaemonSocketPath
 *    unlinks the stale file).
 * 2. A descriptor names the socket and that pid is alive -> keep (a live
 *    worker owns the bound socket file; unlinking it would break the worker).
 * 3. No descriptor names the socket: keep while younger than
 *    {@link STALE_WORKER_SOCKET_MAX_AGE_MS} (spawn-in-flight window), remove
 *    once past the age gate.
 *
 * Unknown-alive never deletes: `isProcessAlive` fail-closes to "alive" on
 * EPERM, and a pid reused by another process reads as alive, which keeps the
 * (harmless) file rather than risking a live worker's socket.
 */
export function sweepStaleWorkerSockets(options: {
	supervisorSocketPath: string;
	descriptorDir: string;
	socketDir?: string;
	isProcessAlive?: (pid: number) => boolean;
	now?: number;
}): WorkerSocketSweepResult {
	if (process.platform === "win32") {
		return { removed: [], kept: [] };
	}
	const key = descriptorKey(options.supervisorSocketPath);
	const socketDir = options.socketDir ?? defaultDaemonSocketDir();
	const pidAlive = options.isProcessAlive ?? isProcessAlive;
	const now = options.now ?? Date.now();
	const prefix = `worker-${key}-`;

	const pidBySocketPath = new Map<string, number>();
	try {
		for (const name of readdirSync(options.descriptorDir)) {
			if (name === SUPERVISOR_CONFIG_FILE_NAME || !name.endsWith(".json")) continue;
			let descriptor: unknown;
			try {
				descriptor = JSON.parse(readFileSync(join(options.descriptorDir, name), "utf8"));
			} catch {
				continue;
			}
			if (!isDaemonWorkerDescriptorShape(descriptor)) continue;
			pidBySocketPath.set(descriptor.socketPath, descriptor.pid);
		}
	} catch {
		// An unreadable descriptor dir cannot prove anything dead; sweep nothing.
		return { removed: [], kept: [] };
	}

	const result: WorkerSocketSweepResult = { removed: [], kept: [] };
	let names: string[];
	try {
		names = readdirSync(socketDir);
	} catch {
		return result;
	}
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".sock")) continue;
		const path = join(socketDir, name);
		const pid = pidBySocketPath.get(path);
		if (pid !== undefined) {
			if (pidAlive(pid)) {
				result.kept.push({ path, reason: `live worker pid ${pid}` });
				continue;
			}
			try {
				rmSync(path, { force: true });
				result.removed.push(path);
			} catch {
				result.kept.push({ path, reason: "removal failed" });
			}
			continue;
		}
		try {
			const ageMs = now - statSync(path).mtimeMs;
			if (ageMs < STALE_WORKER_SOCKET_MAX_AGE_MS) {
				result.kept.push({ path, reason: `orphaned but young (${Math.round(ageMs / 1000)}s)` });
				continue;
			}
			rmSync(path, { force: true });
			result.removed.push(path);
		} catch {
			// A socket that vanished mid-sweep is already gone.
		}
	}
	return result;
}

function isFinalizedTranscriptEvent(eventType: string | undefined): boolean {
	return (
		eventType === "message_end" ||
		eventType === "turn_end" ||
		eventType === "compaction_end" ||
		eventType === "bash_end"
	);
}

const SUPPORTED_CLIENT_CAPABILITIES: ReadonlySet<string> = new Set(DAEMON_SUPPORTED_CLIENT_CAPABILITIES);

/**
 * Same filtering the worker side applies (`normalizeClientCapabilities`): an
 * attach carries an arbitrary string array that the supervisor echoes back and
 * keeps per attached session, so unknown names are dropped instead of resident.
 * A client loses nothing by it — what it declares is either supported here or was
 * never going to be honoured.
 */
function normalizeCapabilities(
	capabilities: readonly DaemonClientCapability[] | undefined,
	supportsExtensionUi: boolean | undefined,
): Set<DaemonClientCapability> {
	const normalized = new Set<DaemonClientCapability>();
	for (const capability of capabilities ?? DAEMON_DEFAULT_CLIENT_CAPABILITIES) {
		if (SUPPORTED_CLIENT_CAPABILITIES.has(capability)) {
			normalized.add(capability);
		}
	}
	if (supportsExtensionUi) {
		normalized.add("extension_ui");
	}
	return normalized;
}

export async function runDaemonSupervisorMode(options: DaemonSupervisorOptions): Promise<never> {
	const socketPath = normalizeSocketPath(options.socketPath ?? defaultDaemonSocketPath());
	const supervisor = new DaemonSupervisor(socketPath, options);
	await supervisor.start();
	return new Promise(() => {});
}

export class DaemonSupervisor {
	private server?: Server;
	private readonly ready: Promise<void>;
	private markReady: () => void = () => {};
	private rejectReady: (error: Error) => void = () => {};
	private ownsSocketPath = false;
	private socketIdentity?: DaemonSocketIdentity;
	private socketLease?: DaemonSocketPathLease;
	private socketLeaseCompromise?: Error;
	private ownership?: Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>>;
	private cleanupPromise?: Promise<void>;
	private shuttingDown = false;
	private startupComplete = false;
	private updateRestartPhase?: "draining" | "fencing" | "prepared";
	/** Checkpoint held while the phase is `prepared`, so a re-issued prepare can replay it. */
	private preparedUpdateRestartManifest?: DaemonUpdateRestartManifest;
	private readonly mutationDrain = new MutationDrainLatch();
	/**
	 * P1-7c: agent-message deliveries this supervisor owns. An entry exists from
	 * admission until a terminal outcome, so a restart can drain it with an
	 * explicit receipt instead of losing it (B10).
	 */
	private pendingDeliveries?: PendingDeliveryQueue;
	private pendingDeliveryCapacity?: number;
	private pendingDeliveryRetryIntervalMs?: number;
	private pendingDeliveryTargetGoneGraceMs?: number;
	private pendingDeliveryLogThrottleMs?: number;
	private updateRestartDrainTimeoutMs?: number;
	private readonly clients = new Set<DaemonSocketClient>();
	private readonly connectionIds = new WeakMap<DaemonSocketClient, string>();
	private readonly sessionInputPauseEpochs = new WeakMap<DaemonSocketClient, number>();
	private readonly detachingInputPauseSessions = new WeakMap<DaemonSocketClient, Set<string>>();
	private readonly protocolClientIds = new WeakMap<DaemonSocketClient, string>();
	private readonly workers = new Map<string, ResidentWorker>();
	private workerStopCounts?: Map<ResidentWorker, number>;
	private readonly openingWorkers = new Map<string, Promise<ResidentWorker>>();
	/**
	 * Openings that can register catalog-visible workers (`ownerClientId === undefined`).
	 * Client-owned launches stay in `openingWorkers` for create dedupe but can never
	 * join the public heartbeat catalog (`isVisibleWorker`), so catalog listing
	 * never waits on them.
	 */
	private readonly catalogOpeningWorkers = new Map<string, Promise<ResidentWorker>>();
	/** Public admission ids are scoped to the socket that registered them. */
	private readonly promptAdmissions = new Map<DaemonSocketClient, Map<string, SupervisorPromptAdmission>>();
	private readonly sessionInputPauses = new Map<string, SupervisorSessionInputPause>();
	private readonly signalCleanupHandlers: Array<() => void> = [];
	private readonly descriptorDir: string;
	private readonly generation = randomUUID();
	private readonly supervisorConfigPath: string;
	private readonly defaultSessionConfig: AgentSessionRuntimeConfig;
	private readonly snapshotCacheRoot: string;
	private commandJournal!: CommandRecoveryJournal;
	private readonly streamReconstructor = new CompactAssistantStreamReconstructor();
	private readonly compactCatchupInProgress = new Set<string>();
	private readonly pendingSessionNames = new Set<string>();
	private readonly catalog: DaemonCatalogClient;
	private readonly settingsManager: SettingsManager;
	private rosterStore?: AgentRoster;
	private readonly pendingRosterChanged = new Set<string>();
	private readonly pendingRosterRemoved = new Set<string>();
	/** Ids declared to subscribers: gates removals to once and keeps owned-only row ids private. */
	private readonly publishedRosterIds = new Set<string>();
	private rosterPushScheduled = false;
	private rosterWatchdogTimer?: ReturnType<typeof setInterval>;
	private rlmSpawnLedgerInstance?: RlmSpawnLedger;
	private idleEvictionTimer?: ReturnType<typeof setTimeout>;
	private idleEvictionSweep?: Promise<void>;
	private idleEvictionFence?: Promise<void>;
	private scheduledWakeTimer?: ReturnType<typeof setTimeout>;
	private scheduledWakeRecompute?: Promise<void>;
	private scheduledWakeRecomputeQueued = false;
	private readonly scheduledWakeFailures = new Map<string, number>();
	private readonly catchupRetryPolicy: ClientCatchupRetryPolicy;
	private readonly adoptionRequestTimeoutMs: number;
	private readonly failedWorkerReapIntervalMs: number;
	private readonly adoptionRetryDelaysMs: readonly number[];
	/** Workers still being adopted; published as daemon_hello.adopting so a partial startup is visible. */
	private adoptionPendingCount = 0;
	/** The workers the startup count was opened for, so a runtime re-adoption cannot skew it. */
	private readonly adoptionCountedWorkers = new Set<ResidentWorker>();
	private readonly adoptionRetryTimers = new Map<ResidentWorker, NodeJS.Timeout>();
	private readonly adoptionFailures: Array<{ workerId: string; session: string; reason: string }> = [];
	private adoptionReported = false;
	/** Set once the supervisor keeps running on state it could not persist or on an isolated rejection (L6/F16). */
	private degraded = false;
	private readonly degradedCounts = new Map<string, number>();
	private readonly degradedLogState = new Map<string, { at: number; suppressed: number }>();
	private uninstallCrashHandlers?: () => void;
	private failedWorkerReaperTimer?: NodeJS.Timeout;
	private failedWorkerReapSweep?: Promise<void>;
	private readonly retentionSweepCheckIntervalMs: number;
	private retentionSweepTimer?: NodeJS.Timeout;
	private lastRetentionSweepAtMs = 0;

	constructor(
		private readonly socketPath: string,
		options: DaemonSupervisorOptions,
	) {
		this.ready = new Promise<void>((resolveReady, rejectReady) => {
			this.markReady = resolveReady;
			this.rejectReady = rejectReady;
		});
		void this.ready.catch(() => undefined);
		const agentDir = options.defaultSessionConfig.agentDir;
		if (!agentDir) {
			throw new Error("Daemon supervisor config is missing agentDir");
		}
		this.descriptorDir = options.descriptorDir ?? defaultWorkerDescriptorDir(agentDir, socketPath);
		this.supervisorConfigPath = join(this.descriptorDir, SUPERVISOR_CONFIG_FILE_NAME);
		this.defaultSessionConfig = mergeAgentSessionRuntimeConfig(
			options.defaultSessionConfig,
			this.loadPersistedSupervisorConfig(),
		);
		this.snapshotCacheRoot = join(this.descriptorDir, "snapshot-cache", this.generation);
		this.catalog = new DaemonCatalogClient((message) => this.log(message));
		this.settingsManager = SettingsManager.create(process.cwd(), this.defaultSessionConfig.agentDir ?? agentDir);
		this.catchupRetryPolicy = options.catchupRetryPolicy ?? DEFAULT_CLIENT_CATCHUP_RETRY_POLICY;
		this.adoptionRequestTimeoutMs = options.adoptionRequestTimeoutMs ?? ADOPTION_WORKER_REQUEST_TIMEOUT_MS;
		this.failedWorkerReapIntervalMs = options.failedWorkerReapIntervalMs ?? FAILED_WORKER_REAP_INTERVAL_MS;
		this.retentionSweepCheckIntervalMs = options.retentionSweepCheckIntervalMs ?? RETENTION_SWEEP_CHECK_INTERVAL_MS;
		this.adoptionRetryDelaysMs = options.adoptionRetryDelaysMs ?? ADOPTION_RETRY_DELAYS_MS;
		this.pendingDeliveryCapacity = options.pendingDeliveryCapacity;
		this.pendingDeliveryRetryIntervalMs = options.pendingDeliveryRetryIntervalMs;
		this.pendingDeliveryTargetGoneGraceMs = options.pendingDeliveryTargetGoneGraceMs;
		this.pendingDeliveryLogThrottleMs = options.pendingDeliveryLogThrottleMs;
		this.updateRestartDrainTimeoutMs = options.updateRestartDrainTimeoutMs;
	}

	async start(): Promise<void> {
		try {
			const agentDir = this.defaultSessionConfig.agentDir;
			if (!agentDir) {
				throw new Error("Daemon supervisor config is missing agentDir");
			}
			this.socketLease = await acquireDaemonSocketPathLease(this.socketPath);
			this.socketLease?.onCompromised((error) => this.handleSocketLeaseCompromised(error));
			this.assertSocketLeaseHeld();
			await waitForDaemonStartupFence(this.socketPath);
			this.assertSocketLeaseHeld();
			this.ownership = await acquireDaemonSupervisorOwnership({
				socketPath: this.socketPath,
				descriptorDir: this.descriptorDir,
				agentDir,
				generation: this.generation,
				appVersion: VERSION,
			});
			this.assertSocketLeaseHeld();
			await prepareDaemonSocketPath(this.socketPath, this.socketLease);

			mkdirSync(this.descriptorDir, { recursive: true, mode: 0o700 });
			chmodSync(this.descriptorDir, 0o700);
			this.persistSupervisorConfig();
			this.reclaimStaleSnapshotCacheGenerations();
			mkdirSync(this.snapshotCacheRoot, { recursive: true, mode: 0o700 });
			this.commandJournal = new CommandRecoveryJournal(join(this.descriptorDir, "command-journal.jsonl"));
			this.loadWorkerDescriptors();
			// R31-5: workers SIGKILLed under a previous supervisor never cleaned their
			// socket files; adoption of their descriptors is the moment their pids can
			// be judged dead, so sweep the leftovers now.
			this.sweepStaleWorkerSockets("supervisor startup");
			this.restorePreparedUpdateRestartState();
			const workersToAdopt = [...this.workers.values()];

			this.server = createServer((socket) => this.handleConnection(socket));
			await this.listen();
			this.assertSocketLeaseHeld();
			this.socketIdentity = getDaemonSocketIdentity(this.socketPath);
			if (process.platform !== "win32" && !this.socketIdentity) {
				throw new Error(`Could not capture daemon socket identity: ${this.socketPath}`);
			}
			this.ownsSocketPath = true;
			restrictDaemonSocketPath(this.socketPath);

			this.registerSignalHandlers();
			this.installCrashHandlers();
			const ownedSessionFiles = new Set(
				[...this.workers.values()]
					.flatMap((worker) => [worker.descriptor.sessionFile, worker.descriptor.createCommand.sessionPath])
					.filter((path): path is string => typeof path === "string")
					.map((path) => resolve(path)),
			);
			try {
				const migratedJobs = migrateLegacyCronJobsToSessionArtifacts(getCronJobsPath(agentDir), {
					isSessionOwned: (job) => ownedSessionFiles.has(resolve(job.sessionFile)),
				});
				if (migratedJobs > 0) {
					this.log(`Migrated ${migratedJobs} scheduled jobs into session artifacts`);
				}
			} catch (error) {
				// Cron migration is best-effort: a legacy store (or a pre-hardening
				// artifact layout) must never keep the supervisor from starting.
				this.log(`Could not migrate legacy cron jobs: ${error instanceof Error ? error.message : String(error)}`);
			}
			await this.catalog.start().catch((error) => this.log(`Could not start daemon catalog: ${String(error)}`));
			this.assertSocketLeaseHeld();
			await this.seedRosterLedger();
			this.seedAdoptingWorkerRosterRows();
			for (const worker of this.workers.values()) {
				this.scheduleOwnedWorkerCleanup(worker);
			}
			this.scheduleIdleEvictionSweep();
			this.scheduleScheduledSessionWakeRecompute();
			this.rosterWatchdogTimer = setInterval(() => this.sweepRosterStaleness(), ROSTER_WATCHDOG_INTERVAL_MS);
			this.rosterWatchdogTimer.unref();
			this.startFailedWorkerReaper();
			this.startRetentionSweepTimer();
			this.assertSocketLeaseHeld();
			await this.ownership.updatePhase("owner");
			this.assertSocketLeaseHeld();
			this.startupComplete = true;
			this.log(`Prime Agent daemon supervisor ${this.generation} listening on ${this.socketPath}`);
			this.markReady();
			// L3: adoption runs after the socket is open and the supervisor is ready.
			// One wedged worker no longer keeps every session unreachable; a session
			// whose worker is still being adopted answers as recovering (which clients
			// retry), and daemon_hello.adopting says how many are in flight.
			this.beginWorkerAdoption(workersToAdopt);
		} catch (error) {
			const startupError = error instanceof Error ? error : new Error(String(error));
			this.log(`Daemon supervisor startup failed: ${startupError.stack ?? startupError.message}`);
			await this.cleanupSupervisorResources();
			this.rejectReady(startupError);
			throw startupError;
		}
	}

	/**
	 * Releases the socket, timers, worker connections and catalog without exiting
	 * the process. `shutdown` runs this and then exits; embedders and tests stop a
	 * supervisor in-process through it. Worker processes keep their own supervision.
	 */
	async dispose(): Promise<void> {
		await this.cleanupSupervisorResources();
	}

	private listen(): Promise<void> {
		return new Promise<void>((resolveListen, rejectListen) => {
			const onError = (error: Error) => {
				this.server?.off("listening", onListening);
				rejectListen(error);
			};
			const onListening = () => {
				this.server?.off("error", onError);
				resolveListen();
			};
			this.server?.once("error", onError);
			this.server?.once("listening", onListening);
			this.server?.listen(daemonIpcListenOptions(this.socketPath));
		});
	}

	private log(message: string): void {
		console.error(message);
		structuredLog.warn(message, { socketPath: this.socketPath });
		appendRotatingLog(getDaemonLogPath(this.socketPath), `[${new Date().toISOString()}] supervisor: ${message}`);
	}

	/** Same destinations as log(), at info level: expected transient states must not read as faults. */
	private logInfo(message: string): void {
		console.error(message);
		structuredLog.info(message, { socketPath: this.socketPath });
		appendRotatingLog(getDaemonLogPath(this.socketPath), `[${new Date().toISOString()}] supervisor: ${message}`);
	}

	/**
	 * Fire-and-forget guard (L6): every detached promise gets a catch, so a failure
	 * in a background path becomes one log line instead of an unhandled rejection
	 * that would otherwise be the process's problem.
	 */
	private background<T>(operation: Promise<T>, context: string): void {
		operation.catch((error: unknown) => {
			this.log(`Background ${context} failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	/** Degraded lines are throttled per cause so a stuck disk cannot drown the log. */
	private logDegraded(cause: string, message: string): void {
		const now = Date.now();
		const state = this.degradedLogState.get(cause);
		if (state && now - state.at < SUPERVISOR_DEGRADED_LOG_THROTTLE_MS) {
			state.suppressed++;
			return;
		}
		const suppressed = state?.suppressed ?? 0;
		this.degradedLogState.set(cause, { at: now, suppressed: 0 });
		this.log(suppressed > 0 ? `${message} (${suppressed} similar lines suppressed)` : message);
	}

	/**
	 * Marks the supervisor degraded and counts the cause. Degraded is published in
	 * daemon_hello, so an operator can tell a healthy daemon from one that is running
	 * on state it could not persist (L6/F16).
	 */
	private recordDegraded(cause: string): number {
		this.degraded = true;
		const count = (this.degradedCounts.get(cause) ?? 0) + 1;
		this.degradedCounts.set(cause, count);
		return count;
	}

	/** Whether the supervisor is running on bookkeeping it could not persist (L6). */
	get isDegraded(): boolean {
		return this.degraded;
	}

	/** Per-cause degraded counters, for tests and diagnostics that must not probe privates. */
	degradedCountsSnapshot(): ReadonlyMap<string, number> {
		return new Map(this.degradedCounts);
	}

	private installCrashHandlers(): void {
		if (this.uninstallCrashHandlers) {
			return;
		}
		this.uninstallCrashHandlers = installSupervisorCrashHandlers({
			log: (message) => this.log(message),
			recordRejection: () => {
				const count = this.recordDegraded("unhandled rejection");
				void count;
			},
			rejectionExitThreshold: this.supervisorRejectionExitThreshold(),
		});
	}

	/**
	 * C18 default: isolate and count, never exit. The threshold is a settings switch
	 * that stays off until the final ruling (T4-5); a non-positive value disables it.
	 */
	private supervisorRejectionExitThreshold(): number | undefined {
		return this.settingsManager.getDaemonSupervisorSettings().rejectionExitThreshold;
	}

	/**
	 * Bookkeeping writes must not abort a recovery: a full or read-only descriptor
	 * directory used to escape as an unhandled rejection and take the whole supervisor
	 * down. The failure is logged, counted and published as degraded instead (F16).
	 */
	private tryPersistWorker(worker: ResidentWorker, context: string): boolean {
		try {
			this.persistWorker(worker);
			return true;
		} catch (error) {
			const count = this.recordDegraded("worker bookkeeping write failed");
			this.logDegraded(
				"worker bookkeeping write failed",
				`Supervisor degraded: could not persist worker ${worker.descriptor.workerId} bookkeeping during ${context} ` +
					`(degraded count: ${count}): ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private clearIdleEvictionTimer(): void {
		if (!this.idleEvictionTimer) return;
		clearTimeout(this.idleEvictionTimer);
		this.idleEvictionTimer = undefined;
	}

	private clearRosterWatchdogTimer(): void {
		if (!this.rosterWatchdogTimer) return;
		clearInterval(this.rosterWatchdogTimer);
		this.rosterWatchdogTimer = undefined;
	}

	private clearAdoptionRetryTimers(): void {
		for (const timer of this.adoptionRetryTimers.values()) {
			clearTimeout(timer);
		}
		this.adoptionRetryTimers.clear();
	}

	private clearScheduledWakeTimer(): void {
		if (!this.scheduledWakeTimer) return;
		clearTimeout(this.scheduledWakeTimer);
		this.scheduledWakeTimer = undefined;
	}

	// The supervisor only wakes non-resident trees; firing and delivery stay worker-owned.
	private scheduleScheduledSessionWakeRecompute(): void {
		if (this.shuttingDown) return;
		if (this.scheduledWakeRecompute) {
			this.scheduledWakeRecomputeQueued = true;
			return;
		}
		this.scheduledWakeRecompute = this.recomputeScheduledSessionWake()
			.catch((error) => this.log(`Scheduled-session wake recompute failed: ${String(error)}`))
			.finally(() => {
				this.scheduledWakeRecompute = undefined;
				if (this.scheduledWakeRecomputeQueued) {
					this.scheduledWakeRecomputeQueued = false;
					this.scheduleScheduledSessionWakeRecompute();
				}
			});
	}

	/** Durable truth: the ledger family (fork headers stripped) plus each session's scheduled-jobs artifact. */
	private async collectPassiveScheduledJobs(
		includeInactive = false,
	): Promise<Array<{ rootSessionFile: string; job: AgentCronJob; info: SessionInfo }>> {
		const pendingCancelRoots = new Set<string>();
		for (const intent of this.collectEphemeralCancelIntents()) {
			const context = this.workerSessionArtifactContext(intent);
			if (!context || !intent.descriptor.rootSessionId) continue;
			try {
				await this.cancelScheduledJobsForSessionTree(intent.descriptor.rootSessionId, context.sessionFile);
				this.deleteWorkerDescriptor(intent);
			} catch {
				// Still owned until the cancel lands; the tree stays excluded below.
				pendingCancelRoots.add(canonicalSessionPath(context.sessionFile));
			}
		}
		const infos = await this.rlmSpawnLedger().family();
		const infoByPath = new Map(infos.map((info) => [canonicalSessionPath(info.path), info] as const));
		const storeBySessionId = new Map<string, AgentCronJobStore>();
		const infoBySessionId = new Map<string, SessionInfo>();
		for (const info of infos) {
			if (info.state !== undefined && info.state.status !== "active") continue;
			const artifactDir = getSessionArtifactPathForFile(resolve(info.path), info.id);
			if (!existsSync(join(artifactDir, SESSION_SCHEDULED_JOBS_FILENAME))) continue;
			const store = AgentCronJobStore.forSessionArtifacts();
			store.registerSessionArtifact(info.id, artifactDir);
			storeBySessionId.set(info.id, store);
			infoBySessionId.set(info.id, info);
		}
		if (infoBySessionId.size === 0) return [];
		const uncoveredRootFor = (info: SessionInfo): string | undefined => {
			let current = info;
			const visited = new Set([canonicalSessionPath(current.path)]);
			while (true) {
				try {
					if (this.findWorkerBySessionFile(current.path)) return undefined;
				} catch {
					return undefined;
				}
				if (!current.parentSessionPath) break;
				const parent = infoByPath.get(canonicalSessionPath(current.parentSessionPath));
				if (!parent || visited.has(canonicalSessionPath(parent.path))) break;
				visited.add(canonicalSessionPath(parent.path));
				current = parent;
			}
			return current.path;
		};
		const results: Array<{ rootSessionFile: string; job: AgentCronJob; info: SessionInfo }> = [];
		for (const [artifactSessionId, store] of storeBySessionId) {
			let jobs: AgentCronJob[];
			try {
				jobs = store.list();
			} catch (error) {
				this.log(`Skipping unreadable scheduled jobs for session ${artifactSessionId}: ${String(error)}`);
				continue;
			}
			for (const job of jobs) {
				if (!includeInactive && job.status !== "active" && job.status !== "paused") continue;
				const info = infoBySessionId.get(job.sessionId);
				if (!info) continue;
				const rootSessionFile = uncoveredRootFor(info);
				if (rootSessionFile === undefined) continue;
				if (pendingCancelRoots.has(canonicalSessionPath(rootSessionFile))) continue;
				results.push({ rootSessionFile, job, info });
			}
		}
		return results;
	}

	private async recomputeScheduledSessionWake(): Promise<void> {
		if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
		const candidates = await this.collectPassiveScheduledJobs();
		this.clearScheduledWakeTimer();
		if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
		const now = Date.now();
		const wakeTimes: number[] = [];
		const candidateRoots = new Set(candidates.map(({ rootSessionFile }) => canonicalSessionPath(rootSessionFile)));
		for (const root of [...this.scheduledWakeFailures.keys()]) {
			if (!candidateRoots.has(root)) this.scheduledWakeFailures.delete(root);
		}
		for (const { rootSessionFile, job } of candidates) {
			if (job.status !== "active" || job.nextRunAt === undefined) continue;
			const runAt = Date.parse(job.nextRunAt);
			if (!Number.isFinite(runAt)) continue;
			// The failure floor keeps an overdue job off a hot retry loop.
			const failedAt = this.scheduledWakeFailures.get(canonicalSessionPath(rootSessionFile));
			wakeTimes.push(failedAt !== undefined ? Math.max(runAt, failedAt + SCHEDULED_WAKE_RETRY_MS) : runAt);
		}
		if (wakeTimes.length === 0) return;
		const delay = Math.min(Math.max(0, Math.min(...wakeTimes) - now), SCHEDULED_WAKE_MAX_TIMEOUT_MS);
		this.scheduledWakeTimer = setTimeout(() => {
			this.scheduledWakeTimer = undefined;
			void this.wakeDueScheduledSessions().catch((error) =>
				this.log(`Scheduled-session wake failed: ${String(error)}`),
			);
		}, delay);
		this.scheduledWakeTimer.unref();
	}

	private async wakeDueScheduledSessions(now = Date.now()): Promise<void> {
		// Disarmed during update-restart preparation; the phase transition or next boot re-arms once.
		if (this.shuttingDown || this.updateRestartPhase !== undefined) {
			this.clearScheduledWakeTimer();
			return;
		}
		try {
			const due = new Map<string, string>();
			for (const { rootSessionFile, job } of await this.collectPassiveScheduledJobs()) {
				if (job.status !== "active" || job.nextRunAt === undefined) continue;
				const runAt = Date.parse(job.nextRunAt);
				if (!Number.isFinite(runAt) || runAt > now) continue;
				due.set(canonicalSessionPath(rootSessionFile), rootSessionFile);
			}
			for (const [rootKey, sessionPath] of due) {
				if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
				try {
					await this.createOrReuseWorker(SCHEDULED_WAKE_CLIENT_ID, { type: "create", sessionPath });
					this.scheduledWakeFailures.delete(rootKey);
					this.log(`Woke session worker for a due scheduled job: ${sessionPath}`);
				} catch (error) {
					this.scheduledWakeFailures.set(rootKey, Date.now());
					this.log(`Scheduled wake failed for ${sessionPath}: ${String(error)}`);
				}
			}
		} finally {
			this.scheduleScheduledSessionWakeRecompute();
		}
	}

	private scheduleIdleEvictionSweep(): void {
		if (this.shuttingDown || this.idleEvictionTimer || this.idleEvictionSweep) return;
		const delayMs = idleEvictionSweepIntervalMs(this.settingsManager.getIdleEvictionMinutes());
		this.idleEvictionTimer = setTimeout(() => {
			this.idleEvictionTimer = undefined;
			const sweep = this.runIdleEvictionSweep()
				.catch((error) => this.log(`Idle eviction sweep failed: ${String(error)}`))
				.finally(() => {
					if (this.idleEvictionSweep === sweep) this.idleEvictionSweep = undefined;
					this.scheduleIdleEvictionSweep();
				});
			this.idleEvictionSweep = sweep;
		}, delayMs);
		this.idleEvictionTimer.unref();
	}

	private workerEvictionSnapshot(worker: ResidentWorker): WorkerEvictionSnapshot {
		return {
			lifecycle: worker.descriptor.lifecycle,
			isConnected: worker.client !== undefined,
			isStopping: this.isWorkerStopping(worker),
			hasOwnerClient: worker.descriptor.ownerClientId !== undefined,
			isPreparingUpdateRestart:
				this.updateRestartPhase !== undefined || worker.updateRestartPrepareClient !== undefined,
			hasWakeBlindSchedule: this.isWakeBlindScheduledWorker(worker),
			sessions: this.workerRosterEntries(worker)
				.filter((entry) => !entry.queuedChild)
				.map(sessionSummaryFromRosterEntry)
				.map((summary) => {
					const activeSessionId = summary.activeSessionId ?? summary.id;
					return {
						// `hasLiveKernelWork` is deliberately not set here: the supervisor hosts no
						// kernel and cannot observe one. The kernel term reaches this snapshot inside
						// the existing `isSessionActive` field instead - the worker folds
						// `session.isKernelWorkInFlight` into the summary it reports
						// (daemon-session-list.ts summaryForActiveSession), `isSessionSummaryBusy`
						// maps that summary into this row - so one session hosting a live kernel
						// bash() handle fails canEvictWorker's `every(...)` and the whole nest stays
						// resident (r44 form A). This is the second of the two carriers; the first is
						// the worker-local passivation snapshot's own `hasLiveKernelWork` term
						// (daemon-mode.ts sessionPassivationSnapshot). They are independent: either
						// one removed silently reopens r44 form A on its own layer, so each has a
						// lock test.
						//
						// Protocol ruling (T1): nothing crosses the wire here. No new field, no
						// capability gate, no DAEMON_SCHEMA_REVISION (37) bump, no
						// DAEMON_PROTOCOL_VERSION (7) bump. Degradation is therefore automatic and
						// needs no code: an older worker that does not fold reports plain turn-level
						// activity, this row reads exactly as it did before, and whole-worker eviction
						// behaves as it does today - the pre-fix behaviour, which is the accepted cost
						// of a mixed-version window, not a new failure.
						isSessionActive: isSessionSummaryBusy(summary),
						attachedClients: this.attachedClientCount(summary, activeSessionId),
						hasRegisteredCronJob: summary.hasRegisteredCronJob === true,
						lastActivityAt: Date.parse(summary.lastActivityAt ?? ""),
					};
				}),
		};
	}

	/** A schedule whose root file sits outside the enumerable sessions root is invisible to the wake scan; keep it resident. */
	private isWakeBlindScheduledWorker(worker: ResidentWorker): boolean {
		const sessionFile = worker.descriptor.sessionFile ?? worker.descriptor.createCommand.sessionPath;
		const agentDir = this.defaultSessionConfig.agentDir;
		if (!sessionFile || !agentDir) return false;
		const sessionsRoot = canonicalSessionPath(this.defaultSessionConfig.sessionDir ?? getSessionsDir(agentDir));
		if (dirname(canonicalSessionPath(sessionFile)) === sessionsRoot) return false;
		return this.workerRosterEntries(worker).some(
			(entry) => entry.summary.hasRegisteredHeartbeat === true || entry.summary.hasRegisteredCronJob === true,
		);
	}

	private async runIdleEvictionSweep(now = Date.now()): Promise<void> {
		if (this.shuttingDown || this.updateRestartPhase !== undefined || this.idleEvictionFence) return;
		await this.settingsManager.reload();
		if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
		const idleEvictionMinutes = this.settingsManager.getIdleEvictionMinutes();
		if (idleEvictionMinutes === "off") return;

		const refreshed = new Set<ResidentWorker>();
		await Promise.all(
			[...this.workers.values()].map(async (worker) => {
				try {
					await this.refreshWorkerSummaries(worker);
					refreshed.add(worker);
				} catch {
					// A disconnected or transitioning worker is never an eviction candidate.
				}
			}),
		);
		const candidates = [...refreshed].filter((worker) =>
			canEvictWorker(this.workerEvictionSnapshot(worker), idleEvictionMinutes, now),
		);
		if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
		// Whole-tree candidates skip child work because stopWorker releases everything.
		await Promise.all(
			[...refreshed]
				.filter((worker) => !candidates.includes(worker))
				.map(async (worker) => {
					try {
						const response = await worker.client?.requestWorker(
							{
								type: "worker_passivate_idle_children",
								idleEvictionMinutes,
								now,
								limit: CHILD_PASSIVATION_PER_WORKER_CAP,
							},
							30_000,
						);
						if (response && !response.success) throw new Error(response.error);
						await this.refreshWorkerSummaries(worker);
					} catch (error) {
						refreshed.delete(worker);
						this.log(`Child passivation sweep failed for worker ${worker.descriptor.workerId}: ${String(error)}`);
					}
				}),
		);
		if (this.shuttingDown || this.updateRestartPhase !== undefined) return;

		await this.withEvictionFence("Timed out draining daemon mutations for idle eviction", async () => {
			if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
			await Promise.all(
				candidates.map((worker) => this.refreshWorkerSummaries(worker).catch(() => refreshed.delete(worker))),
			);
			if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
			const evictable = candidates.filter(
				(worker) =>
					refreshed.has(worker) &&
					this.workers.get(worker.descriptor.workerId) === worker &&
					canEvictWorker(this.workerEvictionSnapshot(worker), idleEvictionMinutes, now) &&
					// F2: an in-flight agent-message delivery is not idleness. It is
					// invisible to the roster until it lands and no longer holds the
					// mutation drain latch, so this fenced recheck is what keeps a stop
					// from cutting a delivery off; the next sweep evicts once it settles.
					!this.workerHasPendingDeliveries(worker),
			);
			// Promise.all may reject and release the fence while sibling stops are still
			// finishing. That is safe: a racing mutation either reaches a live worker or
			// gets a clean disconnected/unknown-session error.
			await Promise.all(
				evictable.map(async (worker) => {
					if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
					const snapshot = this.workerEvictionSnapshot(worker);
					const idleMinutes = Math.floor(
						Math.min(...snapshot.sessions.map((session) => now - session.lastActivityAt)) / 60_000,
					);
					const root = worker.summaries.get(worker.descriptor.rootActiveSessionId);
					await this.stopWorker(worker, true);
					this.log(
						`Evicted idle worker ${worker.descriptor.workerId} root=${root?.sessionId ?? worker.descriptor.rootSessionId ?? worker.descriptor.rootActiveSessionId} idleMinutes=${idleMinutes} sessions=${snapshot.sessions.length}`,
					);
				}),
			);
		});
	}

	/** Waits for any held eviction fence, then takes the slot; release clears it only if still ours. */
	private async acquireIdleEvictionFence(): Promise<() => void> {
		while (this.idleEvictionFence) await this.idleEvictionFence;
		let releaseFence: () => void = () => {};
		const fence = new Promise<void>((resolveFence) => {
			releaseFence = resolveFence;
		});
		this.idleEvictionFence = fence;
		return () => {
			if (this.idleEvictionFence === fence) this.idleEvictionFence = undefined;
			releaseFence();
		};
	}

	/** Runs a passivation decision under the eviction fence after draining admitted mutations. */
	private async withEvictionFence(drainMessage: string, action: () => Promise<void>): Promise<void> {
		const releaseFence = await this.acquireIdleEvictionFence();
		try {
			await this.mutationDrain.waitForDrain(0, AbortSignal.timeout(IDLE_EVICTION_DRAIN_TIMEOUT_MS), drainMessage);
			await action();
		} finally {
			releaseFence();
		}
	}

	private async passivateWorkerIfStillEligible(
		worker: ResidentWorker,
		isStillEligible: () => boolean,
		describeEvicted: () => string,
	): Promise<void> {
		await this.refreshWorkerSummaries(worker, false, true);
		if (!isStillEligible()) return;
		await this.stopWorker(worker, true);
		this.log(describeEvicted());
	}

	private async evictEmptySessionOnLastDetach(activeSessionId: string): Promise<void> {
		if (this.shuttingDown || this.updateRestartPhase !== undefined) return;
		const worker = this.matchWorkers(activeSessionId)[0]?.worker;
		if (
			!worker ||
			worker.descriptor.lifecycle !== "ready" ||
			!worker.client ||
			worker.descriptor.ownerClientId !== undefined || // owned workers have their own cleanup path
			this.isWorkerStopping(worker)
		) {
			return;
		}
		try {
			await this.refreshWorkerSummaries(worker, false, true);
		} catch {
			return;
		}
		if (!this.isEmptyDetachEvictionCandidate(worker)) return;
		try {
			// Idle-sweep coordination: fence new mutations, drain admitted ones, re-read before deciding.
			await this.withEvictionFence("Timed out draining daemon mutations for empty-session eviction", () =>
				this.passivateWorkerIfStillEligible(
					worker,
					() => this.isEmptyDetachEvictionCandidate(worker),
					() =>
						`Evicted empty session worker ${worker.descriptor.workerId} root=${worker.descriptor.rootSessionId ?? worker.descriptor.rootActiveSessionId} on last client detach`,
				),
			);
		} catch (error) {
			this.log(`Empty-session eviction failed for worker ${worker.descriptor.workerId}: ${String(error)}`);
		}
	}

	private isEmptyDetachEvictionCandidate(worker: ResidentWorker): boolean {
		if (
			this.shuttingDown ||
			this.updateRestartPhase !== undefined ||
			this.workers.get(worker.descriptor.workerId) !== worker ||
			this.isWorkerStopping(worker) ||
			// F2: a delivery still in flight means the tree is about to stop being
			// empty, and stopping it would take the message with it.
			this.workerHasPendingDeliveries(worker) ||
			this.isWakeBlindScheduledWorker(worker)
		) {
			return false;
		}
		const summaries = this.workerRosterEntries(worker)
			.filter((entry) => !entry.queuedChild)
			.map(sessionSummaryFromRosterEntry);
		const hasAttachedClient = summaries.some(
			(summary) => this.attachedClientCount(summary, summary.activeSessionId ?? summary.id) > 0,
		);
		return summaries.length > 0 && !hasAttachedClient && summaries.every(isEvictableEmptySessionSummary);
	}

	private async assertCurrentOwnership(): Promise<void> {
		const ownership = this.ownership;
		if (!ownership) {
			const error = new Error(
				`Daemon supervisor generation ${this.generation} holds no registry ownership (never acquired or already released); ` +
					`socket: ${this.socketPath}; restart the daemon to recover — sessions are preserved`,
			);
			Object.assign(error, { code: "supervisor_generation_stale" as const });
			throw error;
		}
		await ownership.assertCurrent();
	}

	private async assertServingCurrentOwnership(): Promise<void> {
		this.assertSupervisorServing();
		await this.assertCurrentOwnership();
		this.assertSupervisorServing();
	}

	private async assertRecoveryAllowed(): Promise<void> {
		await this.assertServingCurrentOwnership();
		if (await isDaemonShutdownAdmissionActive()) {
			throw new SupervisorRecoveryCancelledError("Daemon shutdown admission cancelled worker recovery");
		}
	}

	private supervisorAuthenticationClaim(): {
		supervisorGeneration: string;
		supervisorPid: number;
		supervisorProcessStartId?: string;
		supervisorSocketPath: string;
	} {
		const record = this.ownership?.record;
		if (!record) {
			throw new SupervisorRecoveryCancelledError("Daemon supervisor ownership is unavailable");
		}
		return {
			supervisorGeneration: this.generation,
			supervisorPid: record.pid,
			...(record.processStartId ? { supervisorProcessStartId: record.processStartId } : {}),
			supervisorSocketPath: record.socketPath,
		};
	}

	private loadWorkerDescriptors(): void {
		for (const name of readdirSync(this.descriptorDir)) {
			if (name === SUPERVISOR_CONFIG_FILE_NAME || !name.endsWith(".json")) {
				continue;
			}
			const path = join(this.descriptorDir, name);
			try {
				let descriptor: unknown;
				try {
					descriptor = JSON.parse(readFileSync(path, "utf8"));
				} catch (error) {
					// Quarantine rather than skip: an unreadable file is re-read, re-parsed
					// and re-logged on every startup forever, and `hasPersistedWorkerDescriptors`
					// keeps counting it as a registered worker. The rename keeps the bytes as
					// evidence and takes them out of every later scan.
					this.log(`Ignoring invalid worker descriptor ${path}: ${String(error)}`);
					this.quarantineWorkerDescriptor(path, "unreadable");
					this.recordDegraded("worker descriptor unreadable");
					continue;
				}
				if (!isDaemonWorkerDescriptor(descriptor, this.socketPath)) {
					// A silently skipped descriptor is unrecoverable evidence loss: the
					// worker it named stays invisible to this and every later restart.
					this.log(`Ignoring worker descriptor ${path}: not a worker descriptor for socket ${this.socketPath}`);
					if (!claimsDescriptorVersion(descriptor)) {
						this.quarantineWorkerDescriptor(path, "malformed");
						this.recordDegraded("worker descriptor malformed");
					}
					continue;
				}
				descriptor.supervisorSocketPath = normalizeSocketPath(descriptor.supervisorSocketPath);
				descriptor.lifecycle = "recovering";
				descriptor.recoveryJournalPath ??= join(this.descriptorDir, `${descriptor.workerId}.recovery.jsonl`);
				descriptor.orphanProcessJournalPath ??= join(this.descriptorDir, `${descriptor.workerId}.orphans.jsonl`);
				const durableDescriptor = durableDaemonWorkerDescriptor(descriptor);
				const worker: ResidentWorker = {
					descriptor: durableDescriptor,
					descriptorPath: path,
					summaries: new Map(),
					snapshotCache: new Map(),
					transcriptCaches: new Map(),
					snapshotGenerations: new Map(),
					snapshotLoads: new Map(),
					intentionalStop: durableDescriptor.stopRequestedAt !== undefined,
					stopRevision: 0,
				};
				this.persistWorker(worker);
				this.workers.set(durableDescriptor.workerId, worker);
			} catch (error) {
				this.log(`Ignoring invalid worker descriptor ${path}: ${String(error)}`);
			}
		}
	}

	/** Trees whose ephemeral-stop cancel failed stay owned until a retry lands: tombstoned client-owned descriptors with no resident worker. */
	private collectEphemeralCancelIntents(): Array<{ descriptor: DaemonWorkerDescriptor; descriptorPath: string }> {
		const intents: Array<{ descriptor: DaemonWorkerDescriptor; descriptorPath: string }> = [];
		let names: string[];
		try {
			names = readdirSync(this.descriptorDir);
		} catch {
			return intents;
		}
		for (const name of names) {
			if (name === SUPERVISOR_CONFIG_FILE_NAME || !name.endsWith(".json")) continue;
			const descriptorPath = join(this.descriptorDir, name);
			let descriptor: unknown;
			try {
				descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
			} catch {
				continue;
			}
			if (!isDaemonWorkerDescriptor(descriptor, this.socketPath)) continue;
			if (descriptor.stopRequestedAt === undefined || descriptor.ownerClientId === undefined) continue;
			if (this.workers.has(descriptor.workerId)) continue;
			intents.push({ descriptor, descriptorPath });
		}
		return intents;
	}

	private loadPersistedSupervisorConfig(): AgentSessionRuntimeConfig | undefined {
		try {
			const parsed = JSON.parse(
				readFileSync(this.supervisorConfigPath, "utf8"),
			) as Partial<PersistedSupervisorConfig>;
			if (
				parsed.version !== 1 ||
				typeof parsed.socketPath !== "string" ||
				normalizeSocketPath(parsed.socketPath) !== this.socketPath ||
				!parsed.defaultSessionConfig ||
				typeof parsed.defaultSessionConfig !== "object" ||
				typeof parsed.defaultSessionConfig.agentDir !== "string"
			) {
				return undefined;
			}
			return durableAgentSessionRuntimeConfig(parsed.defaultSessionConfig);
		} catch {
			return undefined;
		}
	}

	private persistSupervisorConfig(): void {
		const persisted: PersistedSupervisorConfig = {
			version: 1,
			socketPath: this.socketPath,
			defaultSessionConfig: durableAgentSessionRuntimeConfig(this.defaultSessionConfig),
		};
		writeJsonAtomically(this.supervisorConfigPath, persisted);
	}

	/**
	 * Reclaim the snapshot transcript directories of previous generations.
	 * `snapshotCacheRoot` ends in this process's own UUID, so removing *it* before
	 * creating it (what this used to do) could never match anything: a supervisor
	 * that was killed, OOMed or lost power instead of shutting down left its
	 * overflow chunks on disk for good, and every restart added another directory
	 * next to them. Ownership was acquired above and is exclusive for this
	 * descriptor directory, so every sibling here belongs to a dead generation.
	 */
	private reclaimStaleSnapshotCacheGenerations(): void {
		const cacheParent = dirname(this.snapshotCacheRoot);
		let names: string[];
		try {
			names = readdirSync(cacheParent);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			this.log(`Could not scan the snapshot cache directory ${cacheParent}: ${String(error)}`);
			return;
		}
		let reclaimed = 0;
		for (const name of names) {
			if (name === this.generation) {
				continue;
			}
			const stale = join(cacheParent, name);
			try {
				// lstat, and directories only: a planted symlink must never be followed
				// out of the cache directory, and a stray file is somebody else's business.
				if (!lstatSync(stale).isDirectory()) {
					continue;
				}
				rmSync(stale, { recursive: true, force: true });
				reclaimed++;
			} catch (error) {
				this.log(`Could not reclaim the stale snapshot cache generation ${stale}: ${String(error)}`);
			}
		}
		if (reclaimed > 0) {
			this.log(`Reclaimed ${reclaimed} stale snapshot cache generation(s) under ${cacheParent}`);
		}
	}

	private hasPersistedWorkerDescriptors(): boolean {
		return readdirSync(this.descriptorDir).some(
			(name) => name !== SUPERVISOR_CONFIG_FILE_NAME && name.endsWith(".json"),
		);
	}

	private persistWorker(worker: ResidentWorker): void {
		worker.descriptor.updatedAt = new Date().toISOString();
		// Durable write: the descriptor is what a later supervisor adopts from, so a
		// torn one costs the whole tree its registration (see writeJsonAtomically).
		writeJsonAtomically(worker.descriptorPath, durableDaemonWorkerDescriptor(worker.descriptor));
	}

	/**
	 * Move an unusable descriptor out of the scan set without deleting it. The
	 * `.corrupt-` suffix keeps the file (evidence for whoever investigates) while
	 * taking it off the `*.json` path every loader, the ephemeral-cancel sweep and
	 * `hasPersistedWorkerDescriptors` walk.
	 */
	private quarantineWorkerDescriptor(path: string, reason: string): void {
		const quarantined = `${path}.corrupt-${randomUUID()}`;
		try {
			renameSync(path, quarantined);
			this.log(`Quarantined ${reason} worker descriptor ${path} as ${quarantined}`);
		} catch (error) {
			// Leaving it in place is the previous behavior: skipped and logged again.
			this.log(`Could not quarantine ${reason} worker descriptor ${path}: ${String(error)}`);
		}
	}

	private deleteWorkerDescriptor(worker: { descriptorPath: string; descriptor: DaemonWorkerDescriptor }): void {
		try {
			rmSync(worker.descriptorPath, { force: true });
			rmSync(worker.descriptor.recoveryJournalPath, { force: true });
			if (worker.descriptor.orphanProcessJournalPath) {
				rmSync(worker.descriptor.orphanProcessJournalPath, { force: true });
			}
		} catch (error) {
			this.log(`Failed to remove worker descriptor ${worker.descriptorPath}: ${String(error)}`);
		}
		// R31-5: a descriptor removal finalizes a worker death, and a SIGKILLed
		// worker never ran its own exit cleanup. The descriptor was the only
		// registry entry naming this socket, so remove the file now that the pid
		// behind it is provably dead; a live pid keeps the file (another worker
		// may own it, and unlinking a bound socket breaks it).
		this.removeDeadWorkerSocket(worker.descriptor);
	}

	private removeDeadWorkerSocket(descriptor: DaemonWorkerDescriptor): void {
		if (process.platform === "win32") return;
		if (isProcessAlive(descriptor.pid)) return;
		try {
			if (existsSync(descriptor.socketPath)) {
				rmSync(descriptor.socketPath, { force: true });
				this.log(`Removed stale worker socket ${descriptor.socketPath} (pid ${descriptor.pid} is gone)`);
			}
		} catch (error) {
			this.log(`Could not remove stale worker socket ${descriptor.socketPath}: ${String(error)}`);
		}
	}

	/** Sweep every stale `worker-*.sock` of this supervisor (R31-5); see {@link sweepStaleWorkerSockets}. */
	private sweepStaleWorkerSockets(reason: string): void {
		const result = sweepStaleWorkerSockets({
			supervisorSocketPath: this.socketPath,
			descriptorDir: this.descriptorDir,
		});
		for (const removal of result.removed) {
			this.log(`Swept stale worker socket ${removal} (${reason})`);
		}
	}

	private handleConnection(socket: Socket): void {
		const client: DaemonSocketClient = {
			id: createActiveSessionId(),
			socket,
			attachedActiveSessionIds: new Set(),
			catchupActiveSessionIds: new Set(),
			backpressured: false,
			authenticated: true,
			snapshotActiveSessionIds: new Set(),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(DAEMON_DEFAULT_CLIENT_CAPABILITIES),
		};
		this.connectionIds.set(client, client.id);
		this.sessionInputPauseEpochs.set(client, 0);
		this.detachingInputPauseSessions.set(client, new Set());
		this.clients.add(client);
		void this.ready.then(
			() => {
				if (!client.socket.destroyed && this.clients.has(client)) {
					this.write(client, {
						type: "daemon_hello",
						socketPath: this.socketPath,
						protocol: DAEMON_PROTOCOL_INFO,
						schemaId: DAEMON_SCHEMA_ID,
						schemaRevision: DAEMON_SCHEMA_REVISION,
						appVersion: VERSION,
						runtime: getDaemonRuntimeIdentity(),
						supervisorGeneration: this.generation,
						supervisorOwnerToken: this.ownership?.record.token,
						supervisorPid: process.pid,
						supervisorProcessStartId: this.ownership?.record.processStartId,
						supervisorSocketPath: this.ownership?.record.socketPath,
						clientId: client.id,
						serverCapabilities: SUPERVISOR_SERVER_CAPABILITIES,
						// Both fields are optional and absent in the healthy case, so a
						// client that never learned them simply sees today's hello.
						...(this.adoptionPendingCount > 0 ? { adopting: this.adoptionPendingCount } : {}),
						...(this.degraded ? { degraded: true } : {}),
					});
				}
			},
			() => client.socket.destroy(),
		);

		client.detachInput = attachJsonlLineReader(
			socket,
			(line) => this.background(this.handleLine(client, line), `client command handling for ${client.id}`),
			{
				maxLineLength: DAEMON_COMMAND_MAX_LINE_BYTES,
				onLineOverflow: () => {
					// Nothing was parsed and nothing was dispatched, so there is no
					// response to duplicate: drop the connection and make the attempt
					// visible. logDegraded, not recordDegraded — one peer sending an
					// over-long line must not flip the supervisor's global degraded flag,
					// which defers the reaper's irreversible deletes for everybody.
					this.logDegraded(
						"client command line overflow",
						`Destroyed client connection ${client.id}: a command line exceeded ${DAEMON_COMMAND_MAX_LINE_BYTES} bytes`,
					);
					socket.destroy(new Error("Daemon command line too long"));
				},
			},
		);
		let cleaned = false;
		const cleanup = () => {
			if (cleaned) {
				return;
			}
			cleaned = true;
			clearTimeout(client.catchupRetryTimer);
			client.catchupRetryTimer = undefined;
			client.detachInput();
			this.clearClientCatchupRetry(client);
			this.sessionInputPauseEpochs.set(client, (this.sessionInputPauseEpochs.get(client) ?? 0) + 1);
			const ownerClientId = this.protocolClientId(client);
			void this.releaseClientSessionInputPauses(client, undefined, true).catch((error: unknown) =>
				this.log(`Failed to release input pauses for disconnected client ${ownerClientId}: ${String(error)}`),
			);
			this.clients.delete(client);
			this.cancelWaitingPromptAdmissionsForClient(client);
			// Drop the admissions nothing is waiting on. An entry that was registered
			// but never reached a worker — a gate that refused the command, a cancel
			// with nowhere to go — has no handler left to delete it, and the map key is
			// the client object itself, so one leftover pins the DaemonSocketClient
			// (socket, buffers, attached session ids) for the life of the supervisor.
			// Entries whose worker cancel is in flight stay mapped until their own
			// handler's finally removes them: the prompt path relies on still finding
			// its admission while the cancellation is being answered.
			const leftoverAdmissions = this.promptAdmissions.get(client);
			if (leftoverAdmissions) {
				for (const [key, admission] of leftoverAdmissions) {
					if (admission.worker === undefined) {
						leftoverAdmissions.delete(key);
					}
				}
				if (leftoverAdmissions.size === 0) {
					this.promptAdmissions.delete(client);
				}
			}
			this.abortPendingDeliveriesForSender(client);
			for (const activeSessionId of [...client.attachedActiveSessionIds]) {
				client.attachedActiveSessionIds.delete(activeSessionId);
				this.background(this.syncWorkerExtensionUi(activeSessionId), "extension UI sync");
				this.background(this.evictEmptySessionOnLastDetach(activeSessionId), "empty session eviction on detach");
			}
			this.scheduleOwnedWorkerCleanupForClient(this.protocolClientId(client));
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
		socket.on("drain", () => {
			client.backpressured = false;
			if (client.rosterResyncPending && client.rosterSubscribed === true) {
				// socket.write queues even when it reports backpressure: one resync per loss gap.
				client.rosterResyncPending = false;
				this.write(client, { type: "roster_update", changed: this.rosterEntriesForClient(), resync: true });
			}
			if (!client.snapshotStreaming) {
				void this.catchUpClient(client).catch((error) =>
					this.log(`Failed to catch up client ${client.id}: ${String(error)}`),
				);
			}
		});
	}

	private cancelOwnedWorkerCleanup(clientId: string): void {
		for (const worker of this.workers.values()) {
			if (worker.descriptor.ownerClientId !== clientId || !worker.ownerCleanupTimer) {
				continue;
			}
			clearTimeout(worker.ownerCleanupTimer);
			worker.ownerCleanupTimer = undefined;
		}
	}

	private protocolClientId(client: DaemonSocketClient): string {
		return this.protocolClientIds.get(client) ?? client.id;
	}

	private async releaseClientSessionInputPauses(
		owner: DaemonSocketClient,
		activeSessionId?: string,
		forceCleanupOnFailure = false,
	): Promise<void> {
		const entries = [...this.sessionInputPauses.values()].filter(
			(entry) =>
				entry.owner === owner &&
				(activeSessionId === undefined ||
					entry.activeSessionId === activeSessionId ||
					entry.requestedActiveSessionId === activeSessionId),
		);
		await Promise.all(
			entries.map(async (entry) => {
				if (this.workers.get(entry.worker.descriptor.workerId) !== entry.worker || !entry.worker.client) {
					if (this.sessionInputPauses.get(entry.pauseId) === entry) this.sessionInputPauses.delete(entry.pauseId);
					return;
				}
				try {
					const response = await this.forwardToWorker(
						entry.worker,
						{
							id: randomUUID(),
							type: "release_session_input_pause",
							activeSessionId: entry.activeSessionId,
							pauseId: entry.pauseId,
						},
						INPUT_PAUSE_CLEANUP_TIMEOUT_MS,
					);
					if (!response.success) throw new Error(response.error);
					if (this.sessionInputPauses.get(entry.pauseId) === entry) this.sessionInputPauses.delete(entry.pauseId);
				} catch (error) {
					if (forceCleanupOnFailure) {
						const workerClient = entry.worker.client;
						if (workerClient) {
							workerClient.close();
							await this.handleWorkerClose(
								entry.worker,
								workerClient,
								error instanceof Error ? error : new Error(String(error)),
							);
						} else {
							this.invalidateWorkerSessionInputPauses(
								entry.worker,
								"Session worker became unavailable while releasing an input pause",
							);
						}
					}
					throw error;
				}
			}),
		);
	}

	private invalidateWorkerSessionInputPauses(worker: ResidentWorker, reason: string): void {
		const owners = new Set<DaemonSocketClient>();
		for (const [pauseId, entry] of this.sessionInputPauses) {
			if (entry.worker !== worker) continue;
			this.sessionInputPauses.delete(pauseId);
			owners.add(entry.owner);
		}
		for (const owner of owners) {
			owner.socket.destroy(new Error(reason));
		}
	}

	private scheduleOwnedWorkerCleanupForClient(clientId: string): void {
		if ([...this.clients].some((client) => this.protocolClientId(client) === clientId)) {
			return;
		}
		for (const worker of this.workers.values()) {
			if (worker.descriptor.ownerClientId === clientId) {
				this.scheduleOwnedWorkerCleanup(worker);
			}
		}
	}

	private scheduleOwnedWorkerCleanup(worker: ResidentWorker): void {
		const ownerClientId = worker.descriptor.ownerClientId;
		if (
			!ownerClientId ||
			worker.ownerCleanupTimer ||
			[...this.clients].some((client) => this.protocolClientId(client) === ownerClientId)
		) {
			return;
		}
		worker.ownerCleanupTimer = setTimeout(() => {
			worker.ownerCleanupTimer = undefined;
			if (
				worker.descriptor.ownerClientId !== ownerClientId ||
				[...this.clients].some((client) => this.protocolClientId(client) === ownerClientId) ||
				this.workers.get(worker.descriptor.workerId) !== worker
			) {
				return;
			}
			// Attribution (B2-C09): this cleanup has no idle/activity gate by design -
			// an owned tree follows its owner - so a stop that takes live work down
			// with it must at least say so. Read the same folded roster summaries the
			// eviction gates read (live kernel bash and running children fold into
			// isSessionActive / hasRunningRlmChildren worker-side).
			const busySessions = this.workerRosterEntries(worker)
				.filter((entry) => !entry.queuedChild)
				.map(sessionSummaryFromRosterEntry)
				.filter((summary) => isSessionSummaryBusy(summary)).length;
			if (busySessions > 0) {
				this.log(
					`Stopping client-owned worker ${worker.descriptor.workerId} ${Math.round(OWNED_WORKER_DISCONNECT_GRACE_MS / 1000)}s after owner disconnect with ${busySessions} busy session(s) still on it`,
				);
			}
			void this.stopWorker(worker, true).catch((error) =>
				this.log(`Could not clean up client-owned worker ${worker.descriptor.workerId}: ${String(error)}`),
			);
		}, OWNED_WORKER_DISCONNECT_GRACE_MS);
		worker.ownerCleanupTimer.unref();
	}

	private promptAdmissionKey(activeSessionId: string, publicAdmissionId: string): string {
		return `${activeSessionId}\0${publicAdmissionId}`;
	}

	private promptAdmissionsFor(client: DaemonSocketClient): Map<string, SupervisorPromptAdmission> {
		let admissions = this.promptAdmissions.get(client);
		if (!admissions) {
			admissions = new Map();
			this.promptAdmissions.set(client, admissions);
		}
		return admissions;
	}

	private getPromptAdmission(
		client: DaemonSocketClient,
		activeSessionId: string,
		publicAdmissionId: string,
	): SupervisorPromptAdmission | undefined {
		return this.promptAdmissions.get(client)?.get(this.promptAdmissionKey(activeSessionId, publicAdmissionId));
	}

	private deletePromptAdmission(admission: SupervisorPromptAdmission): void {
		const admissions = this.promptAdmissions.get(admission.client);
		const key = this.promptAdmissionKey(admission.activeSessionId, admission.publicAdmissionId);
		if (admissions?.get(key) !== admission) return;
		admissions.delete(key);
		if (admissions.size === 0) this.promptAdmissions.delete(admission.client);
	}

	private cancelWaitingPromptAdmissionsForClient(client: DaemonSocketClient): void {
		for (const admission of this.promptAdmissions.get(client)?.values() ?? []) {
			if (admission.status !== "waiting") continue;
			if (!admission.worker || !admission.workerActiveSessionId) {
				admission.status = "cancelled";
				admission.controller.abort();
				continue;
			}
			const worker = admission.worker;
			const workerActiveSessionId = admission.workerActiveSessionId;
			void this.forwardToWorker(worker, {
				type: "cancel_prompt_admission",
				activeSessionId: workerActiveSessionId,
				admissionId: admission.workerAdmissionId,
			})
				.then((response) => {
					if (admission.status !== "waiting") return;
					const status =
						response.success && response.data && typeof response.data === "object" && "status" in response.data
							? (response.data as { status?: unknown }).status
							: undefined;
					if (status === "owned") admission.status = "owned";
					else if (status === "cancelled") admission.status = "cancelled";
				})
				.catch((error: unknown) => {
					this.log(
						`Could not cancel prompt admission ${admission.workerAdmissionId} on disconnected client: ${String(error)}`,
					);
				});
		}
	}

	/** Non-async by design: prompt registration completes before handleLine's first await. */
	private parseCommandAndRegisterPromptAdmission(
		client: DaemonSocketClient,
		line: string,
	): {
		command: DaemonCommand;
		envelopeClientId?: string;
		protocolVersion: number;
		admission?: SupervisorPromptAdmission;
	} {
		const parsed = JSON.parse(line) as unknown;
		const envelope = isDaemonCommandEnvelope(parsed) ? parsed : undefined;
		if (!envelope) {
			throw new Error(`Daemon commands require protocol ${DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION} or newer`);
		}
		const command = { ...envelope.command, id: envelope.id } as DaemonCommand;
		let admission: SupervisorPromptAdmission | undefined;
		if ((command.type === "prompt" || command.type === "prompt_and_wait") && command.admissionId !== undefined) {
			if (typeof command.activeSessionId !== "string" || typeof command.admissionId !== "string") {
				throw new Error("Prompt admission requires string activeSessionId and admissionId");
			}
			if (command.admissionId === "") throw new Error("admissionId must not be empty");
			const admissions = this.promptAdmissionsFor(client);
			const key = this.promptAdmissionKey(command.activeSessionId, command.admissionId);
			if (admissions.has(key)) {
				throw new Error(`Prompt admission id is already in use: ${command.admissionId}`);
			}
			admission = {
				client,
				activeSessionId: command.activeSessionId,
				publicAdmissionId: command.admissionId,
				workerAdmissionId: `supervisor-admission:${randomUUID()}`,
				status: "waiting",
				controller: new AbortController(),
			};
			admissions.set(key, admission);
		}
		return {
			command,
			envelopeClientId: envelope.clientId ?? client.id,
			protocolVersion: envelope.protocol.version,
			admission,
		};
	}

	private async handleLine(client: DaemonSocketClient, line: string): Promise<void> {
		try {
			this.assertSupervisorServing();
		} catch (error) {
			this.write(client, failure(salvageDaemonCommandId(line), "dispatch", error, serializeDaemonError(error)));
			return;
		}
		let preParsed: ReturnType<DaemonSupervisor["parseCommandAndRegisterPromptAdmission"]>;
		try {
			preParsed = this.parseCommandAndRegisterPromptAdmission(client, line);
		} catch (error) {
			this.write(client, failure(salvageDaemonCommandId(line), "parse", error));
			return;
		}
		const command = preParsed.command;
		const parsedAdmission = preParsed.admission;
		if (command.type === "cancel_prompt_admission" && this.updateRestartPhase !== undefined) {
			this.write(client, failure(command.id, command.type, "Daemon is preparing an update restart"));
			return;
		}
		const cancellationAdmission =
			command.type === "cancel_prompt_admission"
				? this.getPromptAdmission(client, command.activeSessionId, command.admissionId)
				: undefined;
		if (cancellationAdmission?.status === "waiting" && !cancellationAdmission.worker) {
			cancellationAdmission.status = "cancelled";
			cancellationAdmission.controller.abort();
		}
		try {
			await waitForPromptAdmission(this.ready, parsedAdmission?.controller.signal);
		} catch (error) {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(client, failure(command.id, command.type, error));
			return;
		}
		const envelopeClientId = preParsed.envelopeClientId;
		if (envelopeClientId) {
			this.protocolClientIds.set(client, envelopeClientId);
			client.id = envelopeClientId;
		}
		this.cancelOwnedWorkerCleanup(client.id);
		if (!DAEMON_COMMAND_TYPES.has(command.type)) {
			this.write(client, failure(command.id, command.type, `Unknown daemon command: ${command.type}`));
			return;
		}
		if (
			command.type === "get_session_tree" &&
			preParsed.protocolVersion < DAEMON_COMMAND_COMPATIBILITY.get_session_tree.minProtocol
		) {
			this.write(
				client,
				failure(
					command.id,
					command.type,
					`get_session_tree requires client protocol ${DAEMON_COMMAND_COMPATIBILITY.get_session_tree.minProtocol} or newer`,
				),
			);
			return;
		}
		// Capability-gated and control-plane commands require the connection to
		// have declared the capability. Connections that never declared keep the
		// legacy compatibility path (pre-gating clients and tests).
		const missingCapability = missingDeclaredCommandCapability(
			client.declaredCapabilities,
			client.declaredCommandCapabilities,
			command,
		);
		if (missingCapability !== undefined) {
			// Same invariant as every other early exit after registration: the
			// admission this line just created has to go with it, or it stays keyed on
			// the client until the connection dies. A prompt carrying an admissionId
			// reaches this gate whenever the connection did not declare
			// prompt_admission_cancellation — which is exactly what a narrow or newer
			// client's declared set looks like to an older supervisor.
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(
				client,
				failure(
					command.id,
					command.type,
					`Daemon command ${command.type} requires the connection to declare the "${missingCapability}" capability`,
				),
			);
			return;
		}

		try {
			await waitForPromptAdmission(this.assertServingCurrentOwnership(), parsedAdmission?.controller.signal);
		} catch (error) {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(client, failure(command.id, command.type, error));
			return;
		}

		const mutation = isDaemonMutatingCommand(command);
		const journalIdentity =
			envelopeClientId && command.id && mutation ? { clientId: envelopeClientId, commandId: command.id } : undefined;
		const existing = journalIdentity
			? this.commandJournal.lookup(journalIdentity.clientId, journalIdentity.commandId)
			: undefined;
		if (existing?.status === "complete") {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(client, existing.response);
			return;
		}
		if (existing?.status === "pending" && journalIdentity) {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(
				client,
				failure(command.id, command.type, "The previous command result is uncertain and was not replayed", {
					code: "command_result_uncertain",
					...journalIdentity,
				}),
			);
			return;
		}

		const phase = this.updateRestartPhase;
		// A prepared checkpoint only admits shutdown and a re-issued prepare: the
		// latter lets a coordinator whose handoff stalled (e.g. a failed shutdown)
		// replay the persisted checkpoint instead of being rejected forever.
		const restartRejected =
			phase === "draining"
				? !UPDATE_RESTART_DRAIN_COMMANDS.has(command.type)
				: phase !== undefined &&
					!(phase === "prepared" && (command.type === "shutdown" || command.type === "prepare_update_restart"));
		if (restartRejected && mutation) {
			if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
			this.write(client, failure(command.id, command.type, "Daemon is preparing an update restart"));
			return;
		}
		if (mutation && !UPDATE_RESTART_DRAIN_COMMANDS.has(command.type)) {
			const idleEvictionFence = this.idleEvictionFence;
			if (idleEvictionFence) {
				await idleEvictionFence;
				try {
					await this.assertServingCurrentOwnership();
				} catch (error) {
					if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
					this.write(client, failure(command.id, command.type, error, serializeDaemonError(error)));
					return;
				}
			}
		}
		if (journalIdentity) {
			const admitted = this.commandJournal.begin(journalIdentity.clientId, journalIdentity.commandId, command.type);
			if (admitted.status === "complete") {
				if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
				this.write(client, admitted.response);
				return;
			}
			if (admitted.status === "pending") {
				if (parsedAdmission) this.deletePromptAdmission(parsedAdmission);
				this.write(
					client,
					failure(command.id, command.type, "The previous command result is uncertain and was not replayed", {
						code: "command_result_uncertain",
						...journalIdentity,
					}),
				);
				return;
			}
		}

		// Attach is intentionally read-only and is not fence-gated. If eviction wins
		// the race, attach fails cleanly with "Session worker is not connected" and
		// the client retries through the saved-session path instead of mutating state.
		// P1-7c: a long agent-message delivery is tracked by the pending-delivery
		// queue and drained explicitly, so it must not hold the update-restart
		// latch — one wedged send used to be able to fail an 80s drain for
		// everybody. Its journal entry stays pending, which is what makes a replay
		// of the same command id answer "uncertain" instead of claiming it never
		// happened.
		const holdsDrainLatch = mutation && !LONG_DELIVERY_DRAIN_EXEMPT_COMMANDS.has(command.type);
		if (holdsDrainLatch) this.mutationDrain.begin();
		try {
			const response = await this.handleCommand(client, command, cancellationAdmission);
			if (response) {
				if (journalIdentity) {
					await this.assertCurrentOwnership();
					this.commandJournal.recordResult(journalIdentity.clientId, journalIdentity.commandId, response);
				}
				this.write(client, response);
			}
		} catch (error) {
			if (isExpectedWorkerAvailabilityError(error)) {
				// A worker mid-recovery is a normal transient state, not a fault: keep it
				// out of the warn-level stack traces so real failures stay readable.
				this.logInfo(
					`Supervisor command ${command.type} deferred: ${error instanceof Error ? error.message : String(error)}`,
				);
			} else {
				this.log(
					`Supervisor command ${command.type} failed: ${error instanceof Error ? error.stack : String(error)}`,
				);
			}
			// P1-7a: a transient worker state is reported with the supervisor's own
			// recheck interval, so a client that understands the hint waits and
			// re-issues inside its budget instead of surfacing a red error.
			let response = failure(
				command.id,
				command.type,
				error,
				serializeDaemonError(error),
				transientRetryAfterMs(error),
			);
			if (journalIdentity && !isSupervisorGenerationStale(error)) {
				try {
					await this.assertCurrentOwnership();
					this.commandJournal.recordResult(journalIdentity.clientId, journalIdentity.commandId, response);
				} catch (ownershipError) {
					response = failure(command.id, command.type, ownershipError, serializeDaemonError(ownershipError));
				}
			}
			this.write(client, response);
		} finally {
			if (holdsDrainLatch) this.mutationDrain.end();
		}
	}

	private async handleCommand(
		client: DaemonSocketClient,
		command: DaemonCommand,
		cancellationAdmission?: SupervisorPromptAdmission,
	): Promise<DaemonResponse | undefined> {
		switch (command.type) {
			case "cancel_prompt_admission": {
				const admission =
					cancellationAdmission ?? this.getPromptAdmission(client, command.activeSessionId, command.admissionId);
				if (!admission) return success(command.id, command.type, { status: "unknown" as const });
				if (admission.status === "owned") return success(command.id, command.type, { status: "owned" as const });
				// A definitive cancellation never downgrades to unknown/waiting.
				if (admission.status === "cancelled") {
					return success(command.id, command.type, { status: "cancelled" as const });
				}
				if (!admission.worker || !admission.workerActiveSessionId) {
					admission.status = "cancelled";
					admission.controller.abort();
					return success(command.id, command.type, { status: "cancelled" as const });
				}
				const response = await this.forwardToWorker(admission.worker, {
					...command,
					activeSessionId: admission.workerActiveSessionId,
					admissionId: admission.workerAdmissionId,
				});
				const status =
					response.success && response.data && typeof response.data === "object" && "status" in response.data
						? (response.data as { status: "cancelled" | "owned" | "unknown" }).status
						: "unknown";
				// Re-read: a socket close may have cancelled during the round-trip (cast widens TS's pre-await narrowing).
				const current = (admission as SupervisorPromptAdmission).status;
				if (status === "owned") admission.status = "owned";
				else if (status === "cancelled") admission.status = "cancelled";
				else if (current !== "cancelled") admission.status = "waiting";
				return { ...response, id: command.id };
			}
			case "ack_result":
				this.commandJournal.acknowledge(client.id, command.commandId);
				return undefined;
			case "declare_client_capabilities": {
				// Connection-level command-gating set. Distinct from attach event
				// capabilities. Re-declarations replace the previous set.
				client.declaredCommandCapabilities = new Set(normalizeDeclaredCapabilities(command.capabilities));
				client.declaredCapabilities = true;
				return success(command.id, command.type, { declared: [...client.declaredCommandCapabilities] });
			}
			case "list":
				return this.handleList(client, command);
			case "roster_subscribe":
				client.rosterSubscribed = true;
				return success(command.id, command.type, { roster: this.rosterEntriesForClient() });
			case "roster_unsubscribe":
				client.rosterSubscribed = false;
				client.rosterResyncPending = false;
				return success(command.id, command.type);
			case "list_agent_peers": {
				const requester = [...this.workers.values()].find(
					(worker) => worker.descriptor.authenticationToken === command.workerToken,
				);
				if (!requester) throw new Error("Worker authentication failed");
				const peers = [...this.workers.values()]
					.filter(
						(worker) =>
							worker !== requester &&
							this.isLiveWorker(worker) &&
							worker.descriptor.lifecycle === "ready" &&
							worker.client !== undefined,
					)
					.flatMap((worker) => {
						const root = this.roster().byActiveSessionId(worker.descriptor.rootActiveSessionId);
						return root ? [this.agentPeerSummary(sessionSummaryFromRosterEntry(root))] : [];
					});
				return success(command.id, command.type, { peers });
			}
			case "get_direct_worker_transport": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				if (match.worker.descriptor.ownerClientId !== undefined) {
					throw new Error("Direct transport is unavailable for client-owned workers");
				}
				const ticket = await this.issuePeerTransport(match.worker, match.summary);
				return success(command.id, command.type, ticket);
			}
			case "list_saved_sessions":
				return this.handleSavedSessionList(client, command);
			case "create": {
				const worker = await this.createOrReuseWorker(this.protocolClientId(client), command);
				const requestedSummary = command.sessionPath
					? this.findSummaryInWorker(worker, command.sessionPath)
					: undefined;
				if (
					requestedSummary &&
					(requestedSummary.activeSessionId ?? requestedSummary.id) !== worker.descriptor.rootActiveSessionId
				) {
					// A create forwarded to a recovering worker still surfaces an opaque lifecycle error.
					const response = await this.forwardToWorker(worker, withoutSupervisorCreateFields(command));
					if (response.success && isSessionSummary(response.data)) {
						this.writeRosterEntry(workerRosterEntryFromSummary(response.data), worker);
						return { ...response, id: command.id, data: this.publicSummary(worker, response.data) };
					}
					return responseWithId(response, command.id);
				}
				const root = this.roster().byActiveSessionId(worker.descriptor.rootActiveSessionId);
				if (!root) {
					throw new Error("Session worker started without a root session");
				}
				return success(command.id, "create", this.publicSummary(worker, sessionSummaryFromRosterEntry(root)));
			}
			case "attach": {
				const attached = await this.attachClient(client, command);
				// A client-driven attach reseeds the whole view, so any catch-up
				// failure streak for that session is over (I-8).
				this.noteClientViewReseeded(
					client,
					attached.result.activeSessionId,
					attached.result.lastEventCursor?.generation,
				);
				if (client.capabilities.has("chunked_snapshot")) {
					const transcript = attached.transcript;
					if (!transcript) {
						throw new Error("Session worker did not provide a snapshot transcript");
					}
					const streamedResult = this.createStreamedAttachResult(attached.result, transcript);
					try {
						this.write(client, success(command.id, "attach", streamedResult));
						void this.streamSnapshot(
							client,
							attached.worker,
							streamedResult,
							transcript,
							"attach",
							attached.releaseTranscript,
						).catch((error) =>
							this.log(
								`Failed to stream attach snapshot for ${streamedResult.activeSessionId}: ${String(error)}`,
							),
						);
					} catch (error) {
						attached.releaseTranscript?.();
						throw error;
					}
					return undefined;
				}
				return success(command.id, "attach", attached.result);
			}
			case "reattach": {
				const target = await this.findWorkerForClient(client, command.targetActiveSessionId);
				const targetActiveSessionId = target.summary.activeSessionId ?? target.summary.id;
				if (targetActiveSessionId === command.activeSessionId) {
					const detachingSessions = this.detachingInputPauseSessions?.get(client);
					detachingSessions?.delete(command.activeSessionId);
					detachingSessions?.delete(command.targetActiveSessionId);
					detachingSessions?.delete(targetActiveSessionId);
					return success(command.id, command.type, { cancelled: false });
				}
				const targetWasAttached = client.attachedActiveSessionIds.has(targetActiveSessionId);
				const releaseSnapshotReservation = this.reserveSnapshotStream(client, targetActiveSessionId);
				let releaseTranscript: (() => void) | undefined;
				client.attachedActiveSessionIds.add(targetActiveSessionId);
				try {
					const attached = await this.attachClient(client, {
						...command,
						type: "attach",
						activeSessionId: targetActiveSessionId,
					});
					const detachingSessions = this.detachingInputPauseSessions?.get(client);
					detachingSessions?.delete(command.activeSessionId);
					detachingSessions?.delete(command.targetActiveSessionId);
					detachingSessions?.delete(targetActiveSessionId);
					if (client.capabilities.has("chunked_snapshot")) {
						const transcript =
							attached.transcript ?? this.getOrCreateTranscriptCache(attached.worker, attached.result);
						releaseTranscript = attached.releaseTranscript;
						const streamedResult = this.createStreamedAttachResult(attached.result, transcript);
						this.write(client, success(command.id, command.type, streamedResult));
						this.detachClient(client, command.activeSessionId);
						const streaming = this.streamSnapshot(
							client,
							attached.worker,
							streamedResult,
							transcript,
							"replacement",
							releaseTranscript,
							releaseSnapshotReservation,
						);
						releaseTranscript = undefined;
						void streaming.catch((error) =>
							this.log(`Failed to stream reattach snapshot for ${targetActiveSessionId}: ${String(error)}`),
						);
						return undefined;
					}
					this.write(client, success(command.id, command.type, attached.result));
					this.detachClient(client, command.activeSessionId);
					releaseSnapshotReservation();
					this.releaseDeferredSessionPayloads(client, targetActiveSessionId, true);
					return undefined;
				} catch (error) {
					releaseTranscript?.();
					if (!targetWasAttached) {
						this.detachClient(client, targetActiveSessionId);
					}
					releaseSnapshotReservation();
					this.releaseDeferredSessionPayloads(client, targetActiveSessionId, targetWasAttached);
					throw error;
				}
			}
			case "acquire_session_input_pause": {
				const detachingSessions = this.detachingInputPauseSessions.get(client);
				if (detachingSessions?.has(command.activeSessionId)) {
					throw new Error(`Session is detaching: ${command.activeSessionId}`);
				}
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				const activeSessionId = match.summary.activeSessionId ?? match.summary.id;
				if (detachingSessions?.has(command.activeSessionId) || detachingSessions?.has(activeSessionId)) {
					throw new Error(`Session is detaching: ${command.activeSessionId}`);
				}
				const ownerClientId = this.protocolClientId(client);
				const connectionId = this.connectionIds.get(client);
				if (!connectionId) throw new Error("Daemon client connection identity is unavailable");
				const acquisitionEpoch = this.sessionInputPauseEpochs.get(client) ?? 0;
				const existing = [...this.sessionInputPauses.values()].find(
					(entry) =>
						entry.owner === client &&
						entry.worker === match.worker &&
						entry.activeSessionId === activeSessionId &&
						entry.leaseKey === command.leaseKey &&
						!entry.releaseTask,
				);
				if (existing) {
					return success(command.id, command.type, { pauseId: existing.pauseId });
				}
				const response = await this.forwardToWorker(match.worker, {
					...command,
					activeSessionId,
					leaseKey: JSON.stringify([connectionId, ownerClientId, command.leaseKey]),
				});
				if (!response.success) return response;
				const pauseId = (response.data as { pauseId?: unknown } | undefined)?.pauseId;
				if (typeof pauseId !== "string") throw new Error("Worker returned an invalid session input pause id");
				if (!this.clients.has(client) || (this.sessionInputPauseEpochs.get(client) ?? 0) !== acquisitionEpoch) {
					try {
						const release = await this.forwardToWorker(match.worker, {
							id: randomUUID(),
							type: "release_session_input_pause",
							activeSessionId,
							pauseId,
						});
						if (!release.success) throw new Error(release.error);
					} catch (error) {
						const invalidated = match.worker.client;
						if (invalidated) {
							// Close and deregister as a pair, in the order the other disconnect
							// paths use: `handleWorkerClose` only acts while `worker.client`
							// still names this client, so it has to run first. Leaving the
							// registration pointing at a closed client keeps it claiming a ready
							// transport until the 'close' event lands, and a delivery dispatched
							// in that window fails without a byte being written.
							const failure = error instanceof Error ? error : new Error(String(error));
							this.background(
								this.handleWorkerClose(match.worker, invalidated, failure),
								`worker close handling for ${match.worker.descriptor.workerId}`,
							);
							invalidated.close();
						}
						throw error;
					}
					throw new Error("Session input pause acquisition was invalidated before completion");
				}
				this.sessionInputPauses.set(pauseId, {
					owner: client,
					worker: match.worker,
					activeSessionId,
					requestedActiveSessionId: command.activeSessionId,
					leaseKey: command.leaseKey,
					pauseId,
				});
				return response;
			}
			case "release_session_input_pause": {
				const entry = this.sessionInputPauses.get(command.pauseId);
				if (!entry) return success(command.id, command.type);
				if (entry.owner !== client) {
					throw new Error(`Session input pause is owned by another client: ${command.pauseId}`);
				}
				if (
					command.activeSessionId !== entry.activeSessionId &&
					command.activeSessionId !== entry.requestedActiveSessionId
				) {
					throw new Error(`Session input pause belongs to another session: ${command.pauseId}`);
				}
				const releaseTask =
					entry.releaseTask ??
					this.forwardToWorker(entry.worker, {
						...command,
						activeSessionId: entry.activeSessionId,
					});
				entry.releaseTask = releaseTask;
				try {
					const response = await releaseTask;
					if (response.success && this.sessionInputPauses.get(command.pauseId) === entry) {
						this.sessionInputPauses.delete(command.pauseId);
					}
					return response;
				} finally {
					if (this.sessionInputPauses.get(command.pauseId) === entry && entry.releaseTask === releaseTask) {
						entry.releaseTask = undefined;
					}
				}
			}
			case "detach": {
				const detachingSessions = this.detachingInputPauseSessions.get(client) ?? new Set<string>();
				this.detachingInputPauseSessions.set(client, detachingSessions);
				if (command.activeSessionId) detachingSessions.add(command.activeSessionId);
				else for (const activeSessionId of client.attachedActiveSessionIds) detachingSessions.add(activeSessionId);
				this.sessionInputPauseEpochs.set(client, (this.sessionInputPauseEpochs.get(client) ?? 0) + 1);
				this.detachClient(client, command.activeSessionId);
				await this.releaseClientSessionInputPauses(client, command.activeSessionId, true);
				return success(command.id, "detach");
			}
			case "complete_owned_session": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				if (match.worker.descriptor.ownerClientId !== this.protocolClientId(client)) {
					throw new Error("Session is not owned by this client");
				}
				if (match.worker.ownerCleanupTimer) {
					clearTimeout(match.worker.ownerCleanupTimer);
					match.worker.ownerCleanupTimer = undefined;
				}
				await this.stopWorker(match.worker, true);
				return success(command.id, command.type);
			}
			case "promote_owned_session": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				await this.promoteOwnedWorker(client, match.worker);
				return success(command.id, command.type, this.publicSummary(match.worker, match.summary));
			}
			case "retry_worker": {
				const direct = [...this.workers.values()].find(
					(worker) =>
						worker.descriptor.rootActiveSessionId === command.activeSessionId ||
						worker.descriptor.rootSessionId === command.activeSessionId,
				);
				const worker = direct ?? (await this.findWorkerForClient(client, command.activeSessionId)).worker;
				this.assertWorkerAccessibleToClient(client, worker, command.activeSessionId);
				if ((this.workerStopCounts?.get(worker) ?? 0) > 0) {
					throw new Error("Session worker is stopping; retry after it finishes");
				}
				await this.retryWorkerRecovery(worker);
				if (this.workers.get(worker.descriptor.workerId)?.descriptor.lifecycle !== "ready") {
					throw new Error(worker.descriptor.lastError ?? "Session worker recovery failed");
				}
				const summary = worker.summaries.get(worker.descriptor.rootActiveSessionId);
				return success(command.id, command.type, summary ? this.publicSummary(worker, summary) : undefined);
			}
			case "restart":
				setImmediate(() => this.background(this.shutdown(0, false, true, false, "update"), "restart shutdown"));
				return success(command.id, command.type);
			case "shutdown":
				setImmediate(() =>
					this.background(this.shutdown(0, true, false, command.force === true, "shutdown"), "daemon shutdown"),
				);
				return success(command.id, "shutdown");
			case "prepare_update_restart": {
				const manifest = await this.prepareUpdateRestart();
				return success(command.id, "prepare_update_restart", manifest);
			}
			case "agent_messages_status": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const first = [...this.workers.values()].find((worker) => this.isLiveWorker(worker) && worker.client);
				if (!first) {
					return success(command.id, command.type, { paused: false, limits: {} });
				}
				return this.forwardToWorker(first, command);
			}
			case "agent_messages_pause":
			case "agent_messages_resume": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const responses = await Promise.all(
					[...this.workers.values()]
						.filter((worker) => this.isLiveWorker(worker) && worker.client)
						.map((worker) => this.forwardToWorker(worker, command)),
				);
				const failed = responses.find((response) => !response.success);
				return failed ?? success(command.id, command.type, responses.find((response) => response.success)?.data);
			}
			case "cron_list": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const jobs = new Map<string, AgentCronJob>();
				const responses = await Promise.all(
					[...this.workers.values()]
						.filter(
							(worker) => this.isLiveWorker(worker) && worker.client && worker.descriptor.lifecycle === "ready",
						)
						.map((worker) =>
							this.forwardToWorker(worker, command, 5000).catch((error: unknown) =>
								failure(command.id, command.type, error, serializeDaemonError(error)),
							),
						),
				);
				for (const response of responses) {
					if (!response.success) {
						this.log(`Could not list scheduled jobs from a worker: ${response.error}`);
						continue;
					}
					for (const job of cronJobsFromResponse(response)) {
						jobs.set(job.id, job);
					}
				}
				for (const { job } of await this.collectPassiveScheduledJobs(command.includeInactive === true)) {
					if (!jobs.has(job.id)) jobs.set(job.id, job);
				}
				return success(command.id, "cron_list", { jobs: sortCronJobs([...jobs.values()]) });
			}
			case "heartbeats_list": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					// The forward may first join an in-flight recovery whose budget far exceeds
					// the client's request timeout, so bound the whole operation: a stuck or
					// still-recovering worker fails daemon-side inside the caller's budget
					// instead of surfacing as a client transport timeout.
					const forward = this.forwardToWorker(match.worker, command, HEARTBEAT_LIST_FORWARD_TIMEOUT_MS);
					const forwardDeadline = unrefDelay(HEARTBEAT_LIST_FORWARD_TIMEOUT_MS).then(() => {
						throw new Error(
							`Timed out waiting for session worker to list heartbeats within ${HEARTBEAT_LIST_FORWARD_TIMEOUT_MS}ms`,
						);
					});
					return Promise.race([forward, forwardDeadline]).catch((error: unknown) =>
						failure(command.id, command.type, error, serializeDaemonError(error)),
					);
				}
				const openings = [...this.catalogOpeningWorkers.values()];
				const selectedWorkers = new Set(this.workers.values());
				for (const opening of openings) {
					opening.then(
						(worker) => selectedWorkers.add(worker),
						() => undefined,
					);
				}
				// Slow launches must not outrun the caller's request budget: after
				// HEARTBEAT_LIST_LAUNCH_WAIT_MS the catalog proceeds with whatever
				// registered, and workers that are still starting surface through the
				// per-worker state error below instead of being omitted.
				await Promise.race([Promise.allSettled(openings), unrefDelay(HEARTBEAT_LIST_LAUNCH_WAIT_MS)]);
				for (const worker of this.workers.values()) {
					selectedWorkers.add(worker);
				}
				const workers = [...this.workers.values()].filter(
					(worker) =>
						selectedWorkers.has(worker) && this.isLiveWorker(worker) && worker.descriptor.lifecycle !== "failed",
				);
				const heartbeats = new Map<string, AgentConnectionHeartbeat>();
				const snapshots: Array<{ heartbeats?: AgentConnectionHeartbeat[]; response?: DaemonResponse }> =
					await Promise.all(
						workers.map(async (worker) => {
							if (worker.client && worker.descriptor.lifecycle === "ready") {
								const response = await this.forwardToWorker(worker, command, 5000).catch((error: unknown) =>
									failure(command.id, command.type, error, serializeDaemonError(error)),
								);
								if (response.success) {
									const snapshot = heartbeatsFromResponse(response);
									worker.heartbeatSnapshot = snapshot;
									worker.heartbeatSnapshotStale = false;
									return { heartbeats: snapshot };
								}
								this.log(`Could not list heartbeats from a worker: ${response.error}`);
								if (worker.heartbeatSnapshot === undefined || worker.heartbeatSnapshotStale === true) {
									return { response };
								}
							}
							if (worker.heartbeatSnapshot !== undefined && worker.heartbeatSnapshotStale !== true) {
								return { heartbeats: worker.heartbeatSnapshot };
							}
							const state =
								worker.descriptor.lifecycle === "ready" ? "disconnected" : worker.descriptor.lifecycle;
							const error = new Error(`Cannot list heartbeats while session worker is ${state}`);
							return { response: failure(command.id, command.type, error, serializeDaemonError(error)) };
						}),
					);
				const failed = snapshots.find((snapshot) => snapshot.response)?.response;
				if (failed) {
					return failed;
				}
				for (const snapshot of snapshots) {
					for (const heartbeat of snapshot.heartbeats ?? []) {
						heartbeats.set(heartbeat.job.id, heartbeat);
					}
				}
				// Passivated sessions keep their armed heartbeats; no worker can list them.
				for (const { job, info } of await this.collectPassiveScheduledJobs()) {
					if (!isHeartbeatCronJob(job) || heartbeats.has(job.id)) continue;
					heartbeats.set(job.id, {
						job,
						...(info.name !== undefined ? { sessionName: info.name } : {}),
						...(info.firstMessage !== undefined ? { firstMessage: info.firstMessage } : {}),
					});
				}
				return success(command.id, "heartbeats_list", { heartbeats: [...heartbeats.values()] });
			}
			case "heartbeat_manage": {
				const cachedWorker = [...this.workers.values()].find((worker) =>
					worker.heartbeatSnapshot?.some(
						(heartbeat) =>
							heartbeat.job.id === command.jobId && heartbeat.job.activeSessionId === command.activeSessionId,
					),
				);
				if (!cachedWorker) {
					// Passive jobs are managed against their durable store; no wake just to flip a status.
					const passive = (await this.collectPassiveScheduledJobs()).find(
						({ job }) => job.id === command.jobId && job.activeSessionId === command.activeSessionId,
					);
					if (passive) {
						const store = AgentCronJobStore.forSessionArtifacts();
						store.registerSessionArtifact(
							passive.info.id,
							getSessionArtifactPathForFile(resolve(passive.info.path), passive.info.id),
						);
						const heartbeat = store.manageHeartbeat(command.activeSessionId, command.jobId, command.action);
						if (heartbeat) {
							this.broadcastHeartbeatsChanged();
							return success(command.id, "heartbeat_manage", { heartbeat });
						}
					}
				}
				const worker = cachedWorker ?? (await this.findWorkerForClient(client, command.activeSessionId)).worker;
				this.assertWorkerAccessibleToClient(client, worker, command.activeSessionId);
				const response = await this.forwardToWorker(worker, command);
				if (
					response.success &&
					response.data &&
					typeof response.data === "object" &&
					"heartbeat" in response.data
				) {
					const job = (response.data as { heartbeat?: AgentCronJob }).heartbeat;
					if (job && worker.heartbeatSnapshot) {
						const existing = worker.heartbeatSnapshot.find((heartbeat) => heartbeat.job.id === job.id);
						const remaining = worker.heartbeatSnapshot.filter((heartbeat) => heartbeat.job.id !== job.id);
						worker.heartbeatSnapshot =
							job.status === "active" || job.status === "paused"
								? [...remaining, existing ? { ...existing, job } : { job }]
								: remaining;
					}
				}
				return response;
			}
			case "cron_add": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				const response = await this.forwardToWorker(match.worker, command);
				if (response.success && command.promoteOwnedSession) {
					await this.promoteOwnedWorker(client, match.worker);
				}
				return response;
			}
			case "cron_cancel": {
				if (command.activeSessionId) {
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return this.forwardToWorker(match.worker, command);
				}
				const listed = await Promise.all(
					[...this.workers.values()]
						.filter(
							(worker) => this.isLiveWorker(worker) && worker.client && worker.descriptor.lifecycle === "ready",
						)
						.map(async (worker) => ({
							worker,
							response: await this.forwardToWorker(
								worker,
								{ type: "cron_list", includeInactive: true },
								5000,
							).catch(() => undefined),
						})),
				);
				for (const candidate of listed) {
					if (
						candidate.response?.success &&
						cronJobsFromResponse(candidate.response).some((job) => job.id === command.jobId)
					) {
						return this.forwardToWorker(candidate.worker, command);
					}
				}
				const passive = (await this.collectPassiveScheduledJobs()).find(({ job }) => job.id === command.jobId);
				if (passive) {
					const store = AgentCronJobStore.forSessionArtifacts();
					store.registerSessionArtifact(
						passive.info.id,
						getSessionArtifactPathForFile(resolve(passive.info.path), passive.info.id),
					);
					const job = store.cancel(command.jobId);
					if (job) {
						this.broadcastHeartbeatsChanged();
						return success(command.id, "cron_cancel", { job });
					}
				}
				throw new Error(`No cron job found: ${command.jobId}`);
			}
			case "heartbeat_get": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				return this.forwardToWorker(match.worker, command);
			}
			case "heartbeat_set": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				const response = await this.forwardToWorker(match.worker, command);
				if (response.success && command.promoteOwnedSession) {
					await this.promoteOwnedWorker(client, match.worker);
				}
				return response;
			}
			case "heartbeat_update": {
				const match = await this.findWorkerForClient(client, command.activeSessionId);
				return this.forwardToWorker(match.worker, command);
			}
			case "rename_saved_session": {
				const target = await this.savedSessionNameReservationInput(command.sessionPath, command.name.trim());
				return await this.withSessionNameReservation(target, async () => {
					await this.assertSupervisorSavedSessionNameAvailable(command.sessionPath, target.name);
					if (!command.activeSessionId) {
						await this.catalog.rename(command.sessionPath, command.name);
						// Third rename write point: an offline saved-session rename
						// changes the name the ledger carries for that child.
						await this.rlmSpawnLedger()
							.appendRenameByChildPath(command.sessionPath, target.name)
							.catch((error) => {
								this.log(
									`failed to append RLM ledger rename: ${error instanceof Error ? error.message : String(error)}`,
								);
							});
						const entry = this.roster().bySessionFile(canonicalSessionPath(command.sessionPath));
						if (entry) {
							this.writeRosterEntry({ ...entry, summary: { ...entry.summary, sessionName: target.name } });
						}
						return success(command.id, command.type);
					}
					const match = await this.findWorkerForClient(client, command.activeSessionId);
					return await this.forwardToWorker(match.worker, {
						...command,
						activeSessionId: match.summary.activeSessionId ?? match.summary.id,
					});
				});
			}
			case "delete_saved_session":
				if (!command.activeSessionId) {
					const deletedPath = canonicalSessionPath(command.sessionPath);
					const entry = this.roster().bySessionFile(deletedPath);
					if (entry?.summary.activeSessionId !== undefined) {
						throw new Error("Cannot delete the currently active session");
					}
					const owner = this.findWorkerBySessionFile(command.sessionPath);
					if (owner) {
						// A client-owned worker's files are invisible to other clients: a foreign delete is an unknown target.
						this.assertWorkerAccessibleToClient(client, owner, command.sessionPath);
						if (owner.client && !this.isWorkerStopping(owner)) {
							return this.forwardToWorker(owner, command);
						}
						if (!(await this.reclaimStaleWorkerRegistration(owner))) {
							throw new Error(
								`Session worker is ${this.effectiveWorkerState(owner)}; retry the delete once it is reachable`,
							);
						}
					}
					await tombstoneSavedSessionDelete(this.rlmSpawnLedger(), command.sessionPath, entry?.summary);
					const result = await this.catalog.delete(command.sessionPath);
					if (result.ok && entry && this.roster().get(entry.agentId) === entry) {
						this.roster().delete(entry.agentId);
					}
					return success(command.id, command.type, result);
				}
				break;
		}

		if (command.type === "send_message") {
			// Same gate the worker side applies (daemon-mode.ts): an empty target used to
			// fall through to the catalog, where `"".startsWith` matches every saved
			// session, so a single-session cwd silently retargeted the message while a
			// multi-session one reported it as ambiguous.
			assertDirectAgentMessageTarget(command.targetActiveSessionId);
			// agentOrigin without fromActiveSessionId is trusted only at the direct socket-client boundary.
			const source = command.fromActiveSessionId
				? await this.findWorkerForClient(client, command.fromActiveSessionId)
				: undefined;
			let target: WorkerMatch;
			try {
				target = await this.findWorkerForClient(client, command.targetActiveSessionId);
			} catch (error) {
				if (!(error instanceof Error) || !error.message.startsWith("Unknown active session:")) throw error;
				const cwd = source?.summary.cwd ?? this.defaultSessionConfig.cwd ?? process.cwd();
				let sessionPath: string;
				try {
					sessionPath = await this.catalog.resolve(
						command.targetActiveSessionId,
						cwd,
						source?.worker.descriptor.sessionDir ?? this.defaultSessionConfig.sessionDir,
					);
				} catch (catalogError) {
					// Preserve selector ambiguity so a2a senders can distinguish it from
					// the original unknown-active-session lookup failure.
					if (catalogError instanceof Error && catalogError.message.startsWith("Ambiguous session selector")) {
						throw catalogError;
					}
					throw error;
				}
				if (source && command.agentOrigin === true) {
					const targetInfo = await readSessionInfo(sessionPath);
					if (!targetInfo) throw new Error(`Unknown active session: ${command.targetActiveSessionId}`);
					assertAgentFamilyReach(
						this.familyCatalogEntry(source.summary),
						this.familyCatalogEntry(summaryForInactiveSession(targetInfo)),
					);
				}
				const worker = await this.createOrReuseWorker(this.protocolClientId(client), {
					type: "create",
					sessionPath,
					continueRecent: false,
				});
				const root = this.roster().byActiveSessionId(worker.descriptor.rootActiveSessionId);
				const summary =
					this.findSummaryInWorker(worker, sessionPath) ??
					(root ? sessionSummaryFromRosterEntry(root) : undefined);
				if (!summary) throw new Error("Woken session worker has no target session");
				target = { worker, summary };
			}
			const targetActiveSessionId = target.summary.activeSessionId ?? target.summary.id;
			if (source && command.agentOrigin === true) {
				assertAgentFamilyReach(this.familyCatalogEntry(source.summary), this.familyCatalogEntry(target.summary));
			}
			if (source) {
				if ((source.summary.activeSessionId ?? source.summary.id) === targetActiveSessionId) {
					throw new Error("Agent messaging cannot target the sending session");
				}
				return await this.deliverAgentMessage(client, command, source, target, targetActiveSessionId);
			}
			return this.forwardToWorker(target.worker, { ...command, targetActiveSessionId });
		}

		if (!("activeSessionId" in command) || typeof command.activeSessionId !== "string") {
			throw new Error(`Supervisor cannot route daemon command: ${command.type}`);
		}
		const admission =
			(command.type === "prompt" || command.type === "prompt_and_wait") && command.admissionId
				? this.getPromptAdmission(client, command.activeSessionId, command.admissionId)
				: undefined;
		try {
			throwIfAdmissionCancelled(admission);
			let match: WorkerMatch;
			try {
				match = await waitForPromptAdmission(
					command.type === "set_session_name" && command.workerToken !== undefined
						? this.findWorker(
								command.activeSessionId,
								(worker) => worker.descriptor.authenticationToken === command.workerToken,
							)
						: this.findWorkerForClient(client, command.activeSessionId),
					admission?.controller.signal,
				);
			} catch (error) {
				const terminal = this.terminalCommandResponseForGoneTarget(command, error);
				if (terminal) {
					return terminal;
				}
				throw error;
			}
			throwIfAdmissionCancelled(admission);
			const resolvedCommand = {
				...command,
				activeSessionId: match.summary.activeSessionId ?? match.summary.id,
				...(admission ? { admissionId: admission.workerAdmissionId } : {}),
			} as DaemonCommand;
			if (admission) {
				admission.worker = match.worker;
				admission.workerActiveSessionId = match.summary.activeSessionId ?? match.summary.id;
			}
			if (command.type === "kill" && !this.isWorkerKillForwardable(match.worker)) {
				return await this.killUnreachableWorker(match.worker, match.summary, command);
			}
			const isRootKill =
				command.type === "kill" &&
				(match.summary.activeSessionId ?? match.summary.id) === match.worker.descriptor.rootActiveSessionId;
			if (!isRootKill) {
				const forward = async () => {
					const response = await this.forwardToWorker(match.worker, resolvedCommand);
					if (admission && response.success) admission.status = "owned";
					return response;
				};
				if (command.type === "rename" || command.type === "set_session_name") {
					const reservation = this.summaryNameReservationInput(match.summary, command.name.trim());
					return await this.withSessionNameReservation(reservation, async () => {
						await this.assertSupervisorSessionNameAvailable(match.summary, reservation.name);
						return forward();
					});
				}
				return await forward();
			}
			this.persistWorkerStopTombstone(match.worker, true);
			const releaseStopOwnership = this.acquireWorkerStopOwnership(match.worker);
			let response: DaemonResponse;
			try {
				response = await this.forwardToWorker(match.worker, resolvedCommand);
			} finally {
				try {
					await this.stopWorker(match.worker, true, false, true);
				} finally {
					releaseStopOwnership();
				}
			}
			return response;
		} finally {
			if (admission) this.deletePromptAdmission(admission);
		}
	}

	private async handleList(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "list" }>,
	): Promise<DaemonResponse> {
		// A caller that does not read in-flight assistant messages gets rows without them.
		// Roster summaries drop the field by type already; this keeps the guarantee if a
		// row ever carries one again.
		const omitStreamingMessages = command.omitStreamingMessages === true;
		const active: SessionSummary[] = [];
		const activeByFile = new Map<string, SessionSummary>();
		let busyClientOwnedSessionCount = 0;
		for (const entry of this.roster().values()) {
			if (entry.queuedChild) continue;
			const worker = entry.workerId !== undefined ? this.workers.get(entry.workerId) : undefined;
			if (worker === undefined) continue;
			const row = this.publicSummary(worker, sessionSummaryFromRosterEntry(entry));
			const summary = omitStreamingMessages ? summaryWithoutStreamingMessage(row) : row;
			if (this.isVisibleWorker(worker)) {
				active.push(summary);
				if (summary.sessionFile) activeByFile.set(canonicalSessionPath(summary.sessionFile), summary);
				continue;
			}
			if (summary.sessionFile) activeByFile.set(canonicalSessionPath(summary.sessionFile), summary);
			if (isSessionSummaryBusy(summary)) busyClientOwnedSessionCount += 1;
			if (command.includeClientOwned === true && this.isWorkerAccessibleToClient(client, worker)) {
				active.push(summary);
			}
		}
		const data = {
			sessions: active,
			...(command.includeClientOwned ? { busyClientOwnedSessionCount } : {}),
		};
		if (!command.all) {
			return success(command.id, "list", data);
		}
		const sessionDir = command.sessionDir ?? this.defaultSessionConfig.sessionDir;
		const scanned = await this.catalog.list(command.cwd ? resolve(command.cwd) : undefined, sessionDir);
		const cwd = command.cwd ? resolve(command.cwd) : undefined;
		const merged: SessionSummary[] = [];
		const servedRows = new Set(active);
		const mergedActiveFiles = new Set<string>();
		const scannedFiles = new Set<string>();
		for (const info of scanned) {
			const file = canonicalSessionPath(info.path);
			scannedFiles.add(file);
			const workerRow = activeByFile.get(file);
			if (workerRow && servedRows.has(workerRow)) {
				merged.push(workerRow);
				mergedActiveFiles.add(file);
				continue;
			}
			// The on-disk scan is public: an unserved (client-owned) worker row hides its live metadata only.
			merged.push(summaryForInactiveSession(info));
		}
		// The boot seed covers registered workers' families only, so dead families (pure on-disk
		// history, no registered worker anywhere in the tree) are not roster-resident. Their
		// subagent rows are read from the spawn ledger on demand instead.
		let spawnEdges: RlmLedgerEdge[] = [];
		try {
			spawnEdges = await this.rlmSpawnLedger().liveEdges();
		} catch (error) {
			this.log(`Could not list spawn-ledger sessions: ${String(error)}`);
		}
		const spawnParents = new Map(spawnEdges.map((edge) => [canonicalSessionPath(edge.child), edge.parent]));
		const offlineRows: AgentRosterEntry[] = [];
		for (const entry of this.roster().values()) {
			if (entry.queuedChild || entry.summary.activeSessionId !== undefined) continue;
			if (entry.workerId !== undefined && this.workers.has(entry.workerId)) continue;
			const file = entry.summary.sessionFile ? canonicalSessionPath(entry.summary.sessionFile) : undefined;
			if (file === undefined || scannedFiles.has(file) || activeByFile.has(file)) continue;
			offlineRows.push(entry);
		}
		for (const hydrated of await Promise.all(offlineRows.map((entry) => this.hydrateSeededEntry(entry)))) {
			const summary = sessionSummaryFromRosterEntry(hydrated);
			if (cwd !== undefined && resolve(summary.cwd) !== cwd) continue;
			if (!this.matchesListSessionDir(summary, sessionDir, spawnParents)) continue;
			merged.push(summary);
		}
		const unseededFiles = new Set<string>();
		for (const edge of spawnEdges) {
			const childPath = canonicalSessionPath(edge.child);
			if (scannedFiles.has(childPath) || activeByFile.has(childPath) || unseededFiles.has(childPath)) continue;
			if (this.roster().hasSessionFile(childPath)) continue;
			const entry = this.rosterEntryForSpawnLedgerEdge(edge);
			if (this.roster().has(entry.agentId)) continue;
			unseededFiles.add(childPath);
			// Hydrated one at a time, like the boot seed: a large dead-family ledger must not fan
			// out into one concurrent transcript read per child.
			const hydrated = await this.hydratedSeedEntry(entry);
			// The same classification a roster write would have applied: these rows read "inactive".
			const summary = sessionSummaryFromRosterEntry({
				...hydrated,
				status: classifySessionRosterStatus(hydrated.summary),
			});
			if (cwd !== undefined && resolve(summary.cwd) !== cwd) continue;
			if (!this.matchesListSessionDir(summary, sessionDir, spawnParents)) continue;
			merged.push(summary);
		}
		for (const summary of active) {
			const file = summary.sessionFile ? canonicalSessionPath(summary.sessionFile) : undefined;
			if (file !== undefined && mergedActiveFiles.has(file)) continue;
			merged.push(summary);
		}
		return success(command.id, "list", { ...data, sessions: merged });
	}

	private async hydratedSeedEntry<T extends WorkerRosterEntry>(entry: T): Promise<T> {
		const info = entry.summary.sessionFile
			? await readSessionInfo(entry.summary.sessionFile).catch(() => undefined)
			: undefined;
		if (!info) return { ...entry, seededCwd: true as const };
		const { seededCwd, ...rest } = entry;
		return { ...rest, summary: { ...entry.summary, cwd: info.cwd } } as T;
	}

	private async hydrateSeededEntry(entry: AgentRosterEntry): Promise<AgentRosterEntry> {
		if (entry.seededCwd !== true || !entry.summary.sessionFile) return entry;
		const hydrated = await this.hydratedSeedEntry(entry);
		if (hydrated.seededCwd === true) return entry;
		const current = this.roster().get(entry.agentId);
		if (current !== entry) return current ?? entry;
		return this.roster().write(hydrated, entry.workerId, entry.statusLabel);
	}

	private matchesListSessionDir(
		summary: SessionSummary,
		sessionDir: string | undefined,
		spawnParents?: ReadonlyMap<string, string>,
	): boolean {
		if (sessionDir === undefined) return true;
		if (!summary.sessionFile) return false;
		let file = resolve(summary.sessionFile);
		let parentSessionPath = summary.parentSessionPath;
		const visited = new Set<string>();
		while (parentSessionPath !== undefined) {
			const canonical = canonicalSessionPath(parentSessionPath);
			if (visited.has(canonical)) break;
			visited.add(canonical);
			file = resolve(parentSessionPath);
			// Dead-family ancestors are not roster-resident; the spawn ledger continues the walk.
			parentSessionPath =
				this.roster().bySessionFile(canonical)?.summary.parentSessionPath ?? spawnParents?.get(canonical);
		}
		return dirname(file) === resolve(sessionDir);
	}

	private async handleSavedSessionList(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "list_saved_sessions" }>,
	): Promise<DaemonResponse> {
		let cwd: string;
		let sessionDir: string | undefined;
		let activeSessionId: string | undefined;
		if ("activeSessionId" in command) {
			const match = await this.findWorkerForClient(client, command.activeSessionId);
			cwd = match.summary.cwd;
			sessionDir = this.defaultSessionConfig.sessionDir;
			activeSessionId = match.summary.activeSessionId ?? match.summary.id;
		} else {
			cwd = resolve(command.cwd);
			sessionDir = command.sessionDir;
		}
		const callbacks = command.id
			? {
					onProgress: (loaded: number, total: number) =>
						this.write(client, {
							id: command.id,
							type: "session_list_progress",
							command: "list_saved_sessions",
							...(activeSessionId ? { activeSessionId } : {}),
							loaded,
							total,
						}),
					onSession: (session: SessionInfo) =>
						this.write(client, {
							id: command.id,
							type: "session_list_item",
							command: "list_saved_sessions",
							...(activeSessionId ? { activeSessionId } : {}),
							session: serializeSavedSessionInfo(session),
						}),
				}
			: undefined;
		const saved = await this.catalog.list(command.scope === "current" ? cwd : undefined, sessionDir, callbacks);
		const sessions = await withPassiveRlmDescendantInfos(saved, this.rlmSpawnLedgerFor(sessionDir), {
			...(command.scope === "current" ? { cwd } : {}),
			...(callbacks ? { onSession: callbacks.onSession } : {}),
			log: (message) => this.log(message),
		});
		return success(command.id, "list_saved_sessions", { sessions: sessions.map(serializeSavedSessionInfo) });
	}

	private async createOrReuseWorker(clientId: string, command: DaemonCreateCommand): Promise<ResidentWorker> {
		let createCommand = command;
		if (command.name !== undefined) {
			const normalizedName = command.name.trim();
			if (!normalizedName) {
				throw new Error("Session name cannot be empty");
			}
			createCommand = { ...command, name: normalizedName };
		}
		const ownerClientId = command.lifecycle === "client_owned" ? clientId : undefined;
		if (command.sessionPath) {
			const activeMatches = this.matchWorkers(command.sessionPath);
			if (
				activeMatches.length === 1 &&
				!(await this.reclaimStaleWorkerRegistration(activeMatches[0]!.worker, command.launchEnv !== undefined))
			) {
				return this.reuseWorkerForCreate(activeMatches[0]!.worker, ownerClientId, command.sessionPath);
			}
			if (activeMatches.length > 1) {
				throw new Error(`Ambiguous active session "${command.sessionPath}"`);
			}
			const config = mergeAgentSessionRuntimeConfig(this.defaultSessionConfig, command.config);
			const sessionPath = looksLikeSessionPath(command.sessionPath)
				? resolve(command.sessionPath)
				: await this.catalog.resolve(command.sessionPath, config.cwd ?? process.cwd(), config.sessionDir);
			createCommand = { ...createCommand, sessionPath };
		}
		const key = createCommand.sessionPath
			? canonicalSessionPath(createCommand.sessionPath)
			: `new:${command.id ? createCommandIdempotencyKey(clientId, command.id) : createActiveSessionId()}`;
		const pending = this.openingWorkers.get(key);
		if (pending) {
			return this.joinOpeningWorker(pending, ownerClientId, createCommand.sessionPath ?? key);
		}
		if (createCommand.sessionPath) {
			const existing = this.findWorkerBySessionFile(createCommand.sessionPath);
			if (existing && !(await this.reclaimStaleWorkerRegistration(existing, command.launchEnv !== undefined))) {
				return this.reuseWorkerForCreate(existing, ownerClientId, createCommand.sessionPath);
			}
			// The reclaim await may have let a concurrent opener register; join it instead of double-launching.
			const opened = this.openingWorkers.get(key);
			if (opened) {
				return this.joinOpeningWorker(opened, ownerClientId, createCommand.sessionPath);
			}
		}
		if (createCommand.sessionPath) {
			const existing = this.findWorkerBySessionFile(createCommand.sessionPath);
			if (existing && !(await this.reclaimStaleWorkerRegistration(existing, command.launchEnv !== undefined))) {
				return this.reuseWorkerForCreate(existing, ownerClientId, createCommand.sessionPath);
			}
		}
		const opening = (async () => {
			if (!createCommand.name) return this.launchWorker(createCommand, undefined, ownerClientId);
			const savedSiblings = createCommand.sessionPath ? await this.rlmLedgerSiblings(createCommand.sessionPath) : [];
			const target = savedSiblings.find(
				(session) => canonicalSessionPath(session.path) === canonicalSessionPath(createCommand.sessionPath!),
			);
			const targetSummary = target ? summaryForInactiveSession(target) : { sessionId: "new-root", rlmDepth: 0 };
			const reservation = this.summaryNameReservationInput(targetSummary, createCommand.name);
			return this.withSessionNameReservation(reservation, async () => {
				if (target?.parentSessionPath && (target.rlmDepth ?? 0) > 0) {
					this.assertSavedSiblingNameAvailable(savedSiblings, target, createCommand.name!);
				} else {
					await this.assertSupervisorSessionNameAvailable(targetSummary, createCommand.name!);
				}
				return this.launchWorker(createCommand, undefined, ownerClientId);
			});
		})();
		this.openingWorkers.set(key, opening);
		if (ownerClientId === undefined) {
			this.catalogOpeningWorkers.set(key, opening);
		}
		try {
			return await opening;
		} finally {
			if (this.openingWorkers.get(key) === opening) {
				this.openingWorkers.delete(key);
			}
			if (this.catalogOpeningWorkers.get(key) === opening) {
				this.catalogOpeningWorkers.delete(key);
			}
		}
	}

	private async reuseWorkerForCreate(
		worker: ResidentWorker,
		ownerClientId: string | undefined,
		sessionPath: string,
	): Promise<ResidentWorker> {
		if (worker.descriptor.lifecycle === "failed" && !this.canRetryFailedWorker(worker)) {
			throw new Error(
				`Session "${sessionPath}" is registered to a failed worker that could not be safely reclaimed`,
			);
		}
		this.assertWorkerCreateOwner(worker, ownerClientId, sessionPath);
		if (this.canRetryFailedWorker(worker)) {
			await this.retryWorkerRecovery(worker);
		} else if (!this.isWorkerReadyForCreate(worker)) {
			if (worker.recovery) {
				await worker.recovery;
			} else if (this.isWorkerRecoveryEligible(worker)) {
				await this.recoverWorker(worker);
			}
		}
		const current = this.workers.get(worker.descriptor.workerId);
		if (!current) {
			throw new Error(`Session "${sessionPath}" worker recovery was interrupted; retry opening the session`);
		}
		this.assertWorkerCreateOwner(current, ownerClientId, sessionPath);
		if (!this.isWorkerReadyForCreate(current)) {
			if (!this.workerHasRosterRoot(current)) {
				throw new Error(
					`Session "${sessionPath}" worker is unavailable for reuse: assigned root session is missing`,
				);
			}
			const detail = current.descriptor.lastError ? `: ${current.descriptor.lastError}` : "";
			throw new Error(`Session "${sessionPath}" worker is ${this.effectiveWorkerState(current)}${detail}`);
		}
		return current;
	}

	private async joinOpeningWorker(
		pending: Promise<ResidentWorker>,
		ownerClientId: string | undefined,
		sessionPath: string,
	): Promise<ResidentWorker> {
		const worker = await pending;
		this.assertWorkerCreateOwner(worker, ownerClientId, sessionPath);
		return worker;
	}

	private assertWorkerCreateOwner(
		worker: ResidentWorker,
		ownerClientId: string | undefined,
		sessionPath: string,
	): void {
		if (worker.descriptor.ownerClientId !== ownerClientId) {
			throw new SessionAlreadyActiveError(sessionPath, worker.descriptor.rootActiveSessionId);
		}
	}

	private isWorkerReadyForCreate(worker: ResidentWorker): boolean {
		return (
			worker.descriptor.lifecycle === "ready" &&
			worker.client !== undefined &&
			this.workerHasRosterRoot(worker) &&
			!this.isWorkerStopping(worker)
		);
	}

	private workerHasRosterRoot(worker: ResidentWorker): boolean {
		return (
			this.roster().byActiveSessionId(worker.descriptor.rootActiveSessionId)?.workerId === worker.descriptor.workerId
		);
	}

	/**
	 * A stopping worker whose process already died can strand its registration
	 * (for example when the stop timed out and its finalization was interrupted
	 * by a supervisor restart). Such a registration would block reopening the
	 * saved transcript forever, so complete the interrupted stop and let the
	 * caller launch a fresh worker for the saved session.
	 */
	private async reclaimStaleWorkerRegistration(worker: ResidentWorker, freshCreate = false): Promise<boolean> {
		if (worker.client !== undefined || worker.recovery !== undefined) {
			return false;
		}
		if (worker.descriptor.stopRequestedAt === undefined) {
			if (worker.descriptor.lifecycle !== "failed" || worker.descriptor.ownerClientId) {
				return false;
			}
			const identity = this.processIdentity(worker.descriptor.pid, worker.descriptor.processStartId);
			if (identity === "current") {
				if (!freshCreate || !worker.descriptor.processStartId) return false;
				await this.stopWorker(worker, true, true);
				return true;
			}
			if (identity !== "gone" && identity !== "replaced") {
				return false;
			}
			worker.intentionalStop = true;
			await this.recoverUncertainWorkerOperations(worker);
			this.invalidateWorkerSessionInputPauses(worker, "Session worker stopped while input was paused");
			this.workers.delete(worker.descriptor.workerId);
			this.flipWorkerRosterEntriesInactive(worker);
			this.deleteWorkerDescriptor(worker);
			return true;
		}
		// Fail fast before waiting on anything: only a confirmed-dead process is
		// reclaimable. A live, unknown, or still-stopping worker is left alone
		// and the caller reports the session as already active.
		const identity = this.processIdentity(worker.descriptor.pid, worker.descriptor.processStartId);
		if (identity !== "gone" && identity !== "replaced") {
			return false;
		}
		// Single cleanup path: the background stop finalizer is identity-aware,
		// retrying, and single-flighted, so concurrent resumes share one stop.
		// The wait is bounded so a resume request always returns promptly.
		this.scheduleWorkerStopFinalization(worker);
		const finalization = worker.stopFinalization;
		if (finalization) {
			await Promise.race([finalization.catch(() => undefined), unrefDelay(STALE_RECLAIM_WAIT_MS)]);
		}
		if (this.workers.get(worker.descriptor.workerId) === worker) {
			// The process is confirmed dead, so the registration must never be
			// reused; slow cleanup fails the resume honestly instead.
			throw new Error(
				`Stopped session worker ${worker.descriptor.workerId} is still being cleaned up; retry shortly`,
			);
		}
		this.log(`Reclaimed stale registration for stopped worker ${worker.descriptor.workerId}`);
		return true;
	}

	private async promoteOwnedWorker(client: DaemonSocketClient, worker: ResidentWorker): Promise<void> {
		const clientId = this.protocolClientId(client);
		if (worker.descriptor.ownerClientId === undefined && worker.promotedOwnerClientId === clientId) {
			return;
		}
		if (worker.descriptor.ownerClientId !== clientId) {
			throw new Error("Session is not owned by this client");
		}
		const previousDescriptor = worker.descriptor;
		worker.descriptor = { ...previousDescriptor, ownerClientId: undefined };
		try {
			this.persistWorker(worker);
		} catch (error) {
			worker.descriptor = previousDescriptor;
			throw error;
		}
		worker.promotedOwnerClientId = clientId;
		for (const entry of this.workerRosterEntries(worker)) {
			this.roster().amend(entry.agentId, {});
		}
		if (worker.ownerCleanupTimer) {
			clearTimeout(worker.ownerCleanupTimer);
			worker.ownerCleanupTimer = undefined;
		}
		worker.launchEnv = undefined;
		worker.transientCreateCommand = undefined;
	}

	private describeWorkerSpawnFailure(error: Error): Error {
		const errno = (error as NodeJS.ErrnoException).code;
		const hint =
			errno === "EMFILE" || errno === "ENFILE"
				? ` (${this.workers.size} resident session workers are holding file descriptors; stop unused sessions or raise the open-file limit (ulimit -n))`
				: "";
		return new Error(`Failed to spawn session worker: ${error.message}${hint}`);
	}

	private async launchWorker(
		command: DaemonCreateCommand,
		existing?: ResidentWorker,
		ownerClientId?: string,
		// Adoption and recovery bound their create; a fresh create keeps the long
		// budget because hydrating a large transcript is legitimate work (F14).
		requestTimeoutMs = WORKER_REQUEST_TIMEOUT_MS,
	): Promise<ResidentWorker> {
		await this.assertRecoveryAllowed();
		if (existing && this.isWorkerRecoveryCancelled(existing)) {
			throw new Error(`Session worker ${existing.descriptor.workerId} recovery was cancelled`);
		}
		const recoveryStopRevision = existing?.stopRevision;
		const launchEnv = command.launchEnv ?? existing?.launchEnv;
		const createCommand: DaemonCreateCommand = {
			...withoutSupervisorCreateFields(command),
			config: mergeAgentSessionRuntimeConfig(this.defaultSessionConfig, command.config),
		};
		const workerId = existing?.descriptor.workerId ?? createActiveSessionId();
		const rootActiveSessionId = existing?.descriptor.rootActiveSessionId ?? createActiveSessionId();
		const socketPath = existing?.descriptor.socketPath ?? workerSocketPath(this.socketPath, workerId);
		const token = existing?.descriptor.authenticationToken ?? randomBytes(32).toString("base64url");
		// Fresh per incarnation: peer transport grants must never survive a worker restart.
		const workerInstanceId = randomUUID();
		const now = new Date().toISOString();
		const descriptorPath = existing?.descriptorPath ?? join(this.descriptorDir, `${workerId}.json`);
		const recoveryJournalPath =
			existing?.descriptor.recoveryJournalPath ?? join(this.descriptorDir, `${workerId}.recovery.jsonl`);
		const orphanProcessJournalPath =
			existing?.descriptor.orphanProcessJournalPath ?? join(this.descriptorDir, `${workerId}.orphans.jsonl`);
		const launch = createCliSubprocessLaunchSpec(["--mode", "daemon", "--daemon-socket", socketPath]);
		const workerEnvironment = createCliSubprocessEnv({
			...process.env,
			...launchEnv,
			[DAEMON_WORKER_ROLE_ENV]: "1",
			[DAEMON_WORKER_TOKEN_ENV]: token,
			[DAEMON_WORKER_INSTANCE_ID_ENV]: workerInstanceId,
			[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]: rootActiveSessionId,
			[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV]: this.socketPath,
			[DAEMON_WORKER_RECOVERY_JOURNAL_ENV]: recoveryJournalPath,
			[DAEMON_WORKER_STARTUP_GATE_FD_ENV]: String(WORKER_STARTUP_GATE_FD),
			[ORPHAN_PROCESS_JOURNAL_ENV]: orphanProcessJournalPath,
			[SESSION_LEASES_ENABLED_ENV]: "1",
			[SESSION_LEASE_OWNER_ID_ENV]: rootActiveSessionId,
		});
		delete workerEnvironment.RLM_DEPTH;
		await this.assertRecoveryAllowed();
		const child: ChildProcess = spawnHidden(launch.command, launch.args, {
			cwd: createCommand.config?.cwd ?? process.cwd(),
			detached: true,
			env: workerEnvironment,
			stdio: ["ignore", "ignore", "pipe", "pipe"],
		});
		const detachWorkerStderr = child.stderr
			? attachJsonlLineReader(child.stderr, (line) => this.log(`Session worker ${workerId} stderr: ${line}`), {
					maxLineLength: 64 * 1024,
					onLineOverflow: (prefix) => this.log(`Session worker ${workerId} stderr: ${prefix} [truncated]`),
				})
			: () => {};
		child.once("close", detachWorkerStderr);
		const childClosed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
		let spawnFailure: Error | undefined;
		const spawnSettled = new Promise<void>((resolveSpawn) => {
			child.once("spawn", () => resolveSpawn());
			child.once("error", (error) => {
				spawnFailure = error instanceof Error ? error : new Error(String(error));
				resolveSpawn();
			});
		});
		child.on("error", (error) => {
			this.log(
				`Session worker ${workerId} process error: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		// A failed spawn (e.g. EMFILE) leaves child.stdio undefined.
		const startupGate = child.stdio?.[WORKER_STARTUP_GATE_FD];
		const previousDescriptor = existing?.descriptor;
		const previousIntentionalStop = existing?.intentionalStop;
		let descriptorAssigned = false;
		let childPid: number;
		let childProcessStartId: string | undefined;
		let worker: ResidentWorker;
		try {
			await spawnSettled;
			if (spawnFailure) {
				throw this.describeWorkerSpawnFailure(spawnFailure);
			}
			if (!child.pid) {
				throw new Error("Failed to obtain daemon session worker pid");
			}
			if (!(startupGate instanceof Writable)) {
				throw new Error("Failed to create daemon session worker startup gate");
			}
			childPid = child.pid;
			// R31-14: the identity capture must not fork `ps` synchronously - the supervisor
			// is single-threaded, so N concurrent launches would queue every client command
			// behind N helper round trips. The async twin resolves the same identity.
			childProcessStartId = await getProcessStartIdAsync(childPid);
			await this.assertRecoveryAllowed();

			const descriptor: DaemonWorkerDescriptor = {
				version: 2,
				workerId,
				pid: childPid,
				...(childProcessStartId ? { processStartId: childProcessStartId } : {}),
				socketPath,
				recoveryJournalPath,
				orphanProcessJournalPath,
				supervisorSocketPath: this.socketPath,
				authenticationToken: token,
				workerInstanceId,
				rootActiveSessionId,
				ownerClientId: existing?.descriptor.ownerClientId ?? ownerClientId,
				sessionDir: createCommand.config?.sessionDir,
				telemetryDisabled: createCommand.config?.telemetryDisabled,
				createdAt: existing?.descriptor.createdAt ?? now,
				updatedAt: now,
				lifecycle: "starting",
				createCommand: durableDaemonCreateCommand(createCommand),
				consecutiveFailures: existing?.descriptor.consecutiveFailures ?? 0,
			};
			worker = existing ?? {
				descriptor,
				descriptorPath,
				summaries: new Map(),
				snapshotCache: new Map(),
				transcriptCaches: new Map(),
				snapshotGenerations: new Map(),
				snapshotLoads: new Map(),
				intentionalStop: false,
				stopRevision: 0,
				launchEnv,
				transientCreateCommand: ownerClientId ? createCommand : undefined,
			};
			await this.assertRecoveryAllowed();
			worker.descriptor = descriptor;
			worker.launchEnv = launchEnv;
			worker.transientCreateCommand = descriptor.ownerClientId ? createCommand : undefined;
			descriptorAssigned = true;
			this.persistWorker(worker);
			worker.intentionalStop = false;
			this.workers.set(workerId, worker);
		} catch (error) {
			if (startupGate instanceof Writable) {
				startupGate.destroy();
			}
			await childClosed;
			child.unref();
			try {
				rmSync(`${descriptorPath}.${process.pid}.tmp`, { force: true });
			} catch (cleanupError) {
				this.reportCleanupFailure(`worker launch temp ${workerId}`, cleanupError);
			}
			if (existing && descriptorAssigned && previousDescriptor) {
				try {
					existing.descriptor = previousDescriptor;
				} catch (cleanupError) {
					this.reportCleanupFailure(`worker launch descriptor ${workerId}`, cleanupError);
				}
			}
			throw error;
		}

		try {
			try {
				await commitWorkerStartupGate(startupGate);
			} catch (error) {
				startupGate.destroy();
				await childClosed;
				throw error;
			} finally {
				child.unref();
			}
			const client = await this.connectWorker(worker, WORKER_CONNECT_TIMEOUT_MS);
			const response = await client.request(withoutCommandId(createCommand), requestTimeoutMs);
			if (!response.success) {
				throw deserializeDaemonError(response);
			}
			if (!isSessionSummary(response.data)) {
				throw new Error("Session worker returned an invalid create response");
			}
			const summary = response.data;
			if ((summary.activeSessionId ?? summary.id) !== rootActiveSessionId) {
				throw new Error("Session worker did not preserve its assigned active session id");
			}
			this.writeRosterEntry(workerRosterEntryFromSummary(summary), worker);
			worker.descriptor.rootSessionId = summary.sessionId;
			worker.descriptor.sessionFile = summary.sessionFile;
			await this.subscribeWorker(worker, rootActiveSessionId, requestTimeoutMs);
			await this.refreshWorkerSummaries(worker, true);
			if (existing && (this.isWorkerRecoveryCancelled(worker) || worker.stopRevision !== recoveryStopRevision)) {
				throw new Error(`Session worker ${workerId} recovery was cancelled`);
			}
			await this.assertRecoveryAllowed();
			worker.descriptor.lifecycle = "ready";
			worker.descriptor.consecutiveFailures = 0;
			worker.deferredRecoveryRounds = 0;
			worker.descriptor.lastError = undefined;
			this.persistWorker(worker);
			if (!worker.descriptor.ownerClientId) {
				worker.launchEnv = undefined;
				worker.transientCreateCommand = undefined;
			}
			this.broadcastHeartbeatsChanged();
			return worker;
		} catch (error) {
			if (isSupervisorGenerationStale(error)) {
				throw error;
			}
			if (isSupervisorShutdownAdmissionCancelled(error)) {
				let rolledBack = false;
				try {
					await this.stopWorker(worker, existing === undefined, true, false, existing !== undefined, {
						child,
						closed: childClosed,
					});
					rolledBack = true;
				} catch (cleanupError) {
					this.reportCleanupFailure(`cancelled worker launch ${workerId}`, cleanupError);
				}
				const mappedWorker = this.workers.get(workerId);
				if (
					rolledBack &&
					existing &&
					previousDescriptor &&
					!this.shuttingDown &&
					existing.stopRevision === recoveryStopRevision &&
					existing.descriptor.stopRequestedAt === undefined &&
					(mappedWorker === undefined || mappedWorker === existing)
				) {
					existing.descriptor = previousDescriptor;
					existing.intentionalStop = previousIntentionalStop ?? false;
					this.workers.set(workerId, existing);
					try {
						this.persistWorker(existing);
					} catch (cleanupError) {
						this.reportCleanupFailure(`cancelled worker recovery ${workerId}`, cleanupError);
					}
					this.deferWorkerRecovery(existing, error instanceof Error ? error : new Error(String(error)));
				}
				throw error;
			}
			await this.assertRecoveryAllowed();
			const shouldResumeRecovery =
				existing !== undefined &&
				!this.shuttingDown &&
				worker.descriptor.stopRequestedAt === undefined &&
				worker.stopRevision === recoveryStopRevision;
			await this.stopWorker(worker, existing === undefined, true, false, existing !== undefined).catch((stopError) =>
				this.log(`Could not stop failed worker ${workerId}: ${String(stopError)}`),
			);
			if (
				shouldResumeRecovery &&
				!this.shuttingDown &&
				worker.descriptor.stopRequestedAt === undefined &&
				worker.stopRevision === recoveryStopRevision
			) {
				await this.assertRecoveryAllowed();
				worker.intentionalStop = false;
				worker.descriptor.lifecycle = "recovering";
				this.workers.set(workerId, worker);
				this.persistWorker(worker);
			}
			throw error;
		}
	}

	private async connectWorker(worker: ResidentWorker, timeoutMs: number): Promise<DaemonWorkerClient> {
		const deadline = Date.now() + timeoutMs;
		let lastError: unknown;
		let backoffMs = WORKER_PROBE_BACKOFF_MIN_MS;
		while (Date.now() < deadline) {
			await this.assertRecoveryAllowed();
			const client = new DaemonWorkerClient(worker.descriptor.socketPath);
			try {
				await client.connect(Math.min(WORKER_CONNECT_PROBE_MS, handshakeBudgetMs(deadline)));
				await client.waitForHello(handshakeBudgetMs(deadline));
				// Listen before authenticating: the worker flushes its roster snapshot right after auth succeeds.
				client.onFrame((frame) => this.handleWorkerFrame(worker, frame, client));
				client.onClose((error) =>
					this.background(
						this.handleWorkerClose(worker, client, error),
						`worker close handling for ${worker.descriptor.workerId}`,
					),
				);
				worker.pendingClient = client;
				try {
					const authResponse = await client.authenticateWorker(
						worker.descriptor.authenticationToken,
						{
							...this.supervisorAuthenticationClaim(),
							...(worker.descriptor.workerInstanceId !== undefined
								? { workerInstanceId: worker.descriptor.workerInstanceId }
								: {}),
						},
						handshakeBudgetMs(deadline),
					);
					await this.assertRecoveryAllowed();
					if (!workerAuthAdvertisesRoster(authResponse.data)) {
						throw new PreRosterWorkerError("Session worker predates the roster protocol and must be restarted");
					}
					worker.peerTransportCapable = workerAuthAdvertisesPeerTransport(authResponse.data);
					worker.lastFrameAt = Date.now();
					worker.client?.close();
					worker.client = client;
					return client;
				} finally {
					if (worker.pendingClient === client) worker.pendingClient = undefined;
				}
			} catch (error) {
				lastError = error;
				client.close();
				if (
					isSupervisorRecoveryCancelled(error) ||
					error instanceof PreRosterWorkerError ||
					error instanceof DaemonWorkerAuthenticationError
				) {
					throw error;
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0) break;
				await delay(Math.min(backoffMs, remaining));
				backoffMs = Math.min(backoffMs * 2, WORKER_PROBE_BACKOFF_MAX_MS);
			}
		}
		throw new DaemonWorkerProbeTimeoutError(`Timed out connecting to daemon session worker: ${String(lastError)}`);
	}

	private async subscribeWorker(worker: ResidentWorker, activeSessionId: string, timeoutMs = 30_000): Promise<void> {
		if (!worker.client) {
			throw new Error("Session worker is not connected");
		}
		const supportsExtensionUi = [...this.clients].some(
			(client) => client.attachedActiveSessionIds.has(activeSessionId) && client.supportsExtensionUi,
		);
		const response = await worker.client.requestWorker(
			{
				type: "worker_subscribe",
				activeSessionId,
				capabilities: supportsExtensionUi
					? [
							"attach_snapshot",
							"event_sequence",
							"extension_ui",
							"slim_attach",
							"chunked_snapshot",
							"streaming_delta_fragments",
						]
					: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot", "streaming_delta_fragments"],
				supportsExtensionUi,
			},
			timeoutMs,
		);
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	/**
	 * L3: adoption runs off the ready critical path. The socket is already open and
	 * `markReady()` has run, so a worker that never answers cannot keep the whole
	 * daemon from serving; its sessions answer as recovering until it lands.
	 */
	private beginWorkerAdoption(workers: readonly ResidentWorker[]): void {
		if (workers.length === 0) {
			return;
		}
		this.adoptionPendingCount = workers.length;
		for (const worker of workers) {
			this.adoptionCountedWorkers.add(worker);
		}
		this.background(this.runWorkerAdoption(workers), "worker adoption");
	}

	private async runWorkerAdoption(workers: readonly ResidentWorker[]): Promise<void> {
		const queue = [...workers];
		const lanes: Array<Promise<void>> = [];
		const concurrency = Math.max(1, Math.min(ADOPTION_CONCURRENCY, queue.length));
		for (let lane = 0; lane < concurrency; lane++) {
			lanes.push(
				(async () => {
					while (queue.length > 0 && !this.shuttingDown) {
						const worker = queue.shift();
						if (!worker) {
							return;
						}
						const retryArmed = await this.adoptWorkerContained(worker);
						if (!retryArmed) {
							this.finishAdoptionAttempt(worker);
						}
					}
				})(),
			);
		}
		await Promise.all(lanes);
		this.reportAdoptionOutcome();
	}

	/**
	 * Adopts one worker and contains every outcome: startup must not fail because a
	 * single worker cannot be adopted (L3). Returns true when a backoff re-adoption
	 * was armed for a session that has scheduled jobs behind it.
	 */
	private async adoptWorkerContained(worker: ResidentWorker): Promise<boolean> {
		let reason: string | undefined;
		try {
			await this.adoptOrRecoverWorker(worker);
			// "recovering" is not a failure: the recovery machinery owns the worker from
			// here and re-parks or retries it itself. An intentional stop is a completed
			// adoption of a tombstone.
			if (
				worker.descriptor.lifecycle !== "ready" &&
				worker.descriptor.lifecycle !== "recovering" &&
				worker.descriptor.stopRequestedAt === undefined
			) {
				reason = worker.descriptor.lastError ?? `Worker stayed ${worker.descriptor.lifecycle}`;
			}
		} catch (error) {
			if (this.shuttingDown || isSupervisorRecoveryCancelled(error)) {
				return false;
			}
			reason = error instanceof Error ? error.message : String(error);
		}
		if (reason === undefined) {
			return false;
		}
		return this.containAdoptionFailure(worker, reason);
	}

	/**
	 * One unadoptable worker parks failed on its own instead of taking the daemon
	 * down with it. A worker whose sessions have a heartbeat or cron registration is
	 * re-adopted on a backoff first: parking it would silently stop an unattended
	 * schedule, which nobody would notice because the daemon itself looks healthy.
	 */
	private containAdoptionFailure(worker: ResidentWorker, reason: string): boolean {
		this.recordAdoptionFailure(worker, reason);
		if (/\bTimed out\b/.test(reason)) {
			// Production signature for a bounded adoption that hit its ceiling (F14).
			this.log(
				`Worker adoption timed out for ${worker.descriptor.workerId} after ${this.adoptionRequestTimeoutMs}ms: ${reason}`,
			);
		}
		if (worker.descriptor.lifecycle !== "failed") {
			worker.descriptor.lifecycle = "failed";
			worker.descriptor.lastError = reason;
			// Preserve the first failure time: the reaper ages a corpse from it, and a
			// restart that re-parks the same dead worker must not reset that clock.
			worker.descriptor.lastFailureAt ??= new Date().toISOString();
			this.tryPersistWorker(worker, "adoption failure");
			this.markWorkerRosterEntries(worker, "failed");
		}
		return this.armScheduledJobReadoption(worker, reason);
	}

	private recordAdoptionFailure(worker: ResidentWorker, reason: string): void {
		const workerId = worker.descriptor.workerId;
		if (this.adoptionFailures.some((failure) => failure.workerId === workerId)) {
			return;
		}
		this.adoptionFailures.push({
			workerId,
			session: worker.descriptor.rootSessionId ?? worker.descriptor.rootActiveSessionId,
			reason,
		});
	}

	private armScheduledJobReadoption(worker: ResidentWorker, reason: string): boolean {
		if (this.shuttingDown || this.adoptionRetryTimers.has(worker)) {
			return false;
		}
		// An intentional stop must stay stopped; only unexpected failures are retried.
		if (worker.descriptor.stopRequestedAt !== undefined || worker.intentionalStop) {
			return false;
		}
		// A client-owned worker is re-driven by its owner's next attach; re-adopting it
		// here would only re-park it until that client shows up.
		if (worker.descriptor.ownerClientId !== undefined) {
			return false;
		}
		if (!this.workerHasScheduledJobs(worker)) {
			return false;
		}
		const attempt = worker.adoptionRetryAttempt ?? 0;
		const delayMs = this.adoptionRetryDelaysMs[attempt];
		if (delayMs === undefined) {
			this.recordDegraded("scheduled session not re-adopted");
			this.log(
				`Worker ${worker.descriptor.workerId} stayed failed after ${this.adoptionRetryDelaysMs.length} re-adoption attempts (${reason}); ` +
					`its scheduled sessions stay dark until a client attaches or retry_worker runs`,
			);
			return false;
		}
		worker.adoptionRetryAttempt = attempt + 1;
		this.log(
			`Re-adopting worker ${worker.descriptor.workerId} in ${Math.round(delayMs / 1000)}s because its sessions have scheduled jobs ` +
				`(attempt ${attempt + 1}/${this.adoptionRetryDelaysMs.length}): ${reason}`,
		);
		const timer = setTimeout(() => {
			this.adoptionRetryTimers.delete(worker);
			this.background(this.retryWorkerAdoption(worker), `worker re-adoption for ${worker.descriptor.workerId}`);
		}, delayMs);
		timer.unref();
		this.adoptionRetryTimers.set(worker, timer);
		return true;
	}

	private async retryWorkerAdoption(worker: ResidentWorker): Promise<void> {
		if (this.shuttingDown || this.workers.get(worker.descriptor.workerId) !== worker) {
			this.finishAdoptionAttempt(worker);
			return;
		}
		// A re-adoption starts from the parked state, so recovery is allowed to run again.
		worker.deferredRecoveryRounds = 0;
		const retryArmed = await this.adoptWorkerContained(worker);
		if (!retryArmed) {
			this.finishAdoptionAttempt(worker);
		}
	}

	private finishAdoptionAttempt(worker: ResidentWorker): void {
		if (this.adoptionCountedWorkers.delete(worker)) {
			this.adoptionPendingCount = Math.max(0, this.adoptionPendingCount - 1);
		}
	}

	/** How many registered workers are still being adopted; published in daemon_hello. */
	get adoptingSessionWorkers(): number {
		return this.adoptionPendingCount;
	}

	/**
	 * M12①: a startup that no longer fails loudly has to report what it could not
	 * restore, with the reason and the action that brings a session back.
	 */
	private reportAdoptionOutcome(): void {
		if (this.adoptionReported) {
			return;
		}
		this.adoptionReported = true;
		const failures = this.adoptionFailures;
		if (failures.length === 0) {
			return;
		}
		const detail = failures.map((failure) => `${failure.session} (worker ${failure.workerId}): ${failure.reason}`);
		this.log(
			`Daemon started with ${failures.length} session${failures.length === 1 ? "" : "s"} unrestored: ${detail.join("; ")}. ` +
				`Each stays registered as failed; attach the session or run retry_worker to bring it back, ` +
				`and the failed-worker reaper archives it once it is old enough.`,
		);
	}

	/** Whether a heartbeat or cron registration behind this worker's sessions still needs it. */
	private workerHasScheduledJobs(worker: ResidentWorker): boolean {
		for (const entry of this.workerRosterEntries(worker)) {
			if (entry.summary.hasRegisteredHeartbeat === true || entry.summary.hasRegisteredCronJob === true) {
				return true;
			}
		}
		const sessionFile = worker.descriptor.sessionFile;
		const sessionId = worker.descriptor.rootSessionId;
		if (!sessionFile || !sessionId) {
			return false;
		}
		try {
			const artifactDir = getSessionArtifactPathForFile(resolve(sessionFile), sessionId);
			return existsSync(join(artifactDir, SESSION_SCHEDULED_JOBS_FILENAME));
		} catch {
			// An unreadable artifact directory must not decide the policy either way.
			return false;
		}
	}

	private workerHasAttachedClient(worker: ResidentWorker): boolean {
		const activeSessionIds = new Set(
			this.workerRosterEntries(worker).map((entry) => entry.summary.activeSessionId ?? entry.summary.id),
		);
		if (activeSessionIds.size === 0) {
			return false;
		}
		for (const client of this.clients) {
			for (const activeSessionId of client.attachedActiveSessionIds) {
				if (activeSessionIds.has(activeSessionId)) {
					return true;
				}
			}
		}
		return false;
	}

	private startFailedWorkerReaper(): void {
		if (this.failedWorkerReaperTimer) {
			return;
		}
		this.failedWorkerReaperTimer = setInterval(() => {
			this.background(this.reapFailedWorkers(), "failed worker reaper");
		}, this.failedWorkerReapIntervalMs);
		this.failedWorkerReaperTimer.unref();
	}

	private clearFailedWorkerReaperTimer(): void {
		if (!this.failedWorkerReaperTimer) {
			return;
		}
		clearInterval(this.failedWorkerReaperTimer);
		this.failedWorkerReaperTimer = undefined;
	}

	private startRetentionSweepTimer(): void {
		if (this.retentionSweepTimer) {
			return;
		}
		this.retentionSweepTimer = setInterval(() => {
			this.background(this.runRetentionSweepIfDue(), "retention sweep");
		}, this.retentionSweepCheckIntervalMs);
		this.retentionSweepTimer.unref();
	}

	private clearRetentionSweepTimer(): void {
		if (!this.retentionSweepTimer) {
			return;
		}
		clearInterval(this.retentionSweepTimer);
		this.retentionSweepTimer = undefined;
	}

	/**
	 * The disk-retention sweep, on the cadence `retention.sweepIntervalMinutes`
	 * asks for. Only the daemon runs it on a timer: a short-lived CLI process must
	 * not perform a large delete while it is exiting. `retention.enabled: false`
	 * and the per-class zero knobs keep the sweep report-only, the runner has its
	 * own in-flight guard so a slow sweep cannot stack, and the runner's sweep guard
	 * keeps a second process on the same agent dir out of the same accounts.
	 *
	 * The cadence clock moves only after a sweep that actually ran. A trigger that
	 * found the guard held by another process did no work, so it is not a sweep at
	 * this timestamp: the next check tick tries again instead of waiting out a full
	 * interval for nothing.
	 */
	private async runRetentionSweepIfDue(now = Date.now()): Promise<void> {
		if (this.shuttingDown) {
			return;
		}
		const settings = this.settingsManager.getRetentionSettings();
		const intervalMs = settings.sweepIntervalMinutes * 60_000;
		if (intervalMs <= 0) {
			return;
		}
		if (this.lastRetentionSweepAtMs !== 0 && now - this.lastRetentionSweepAtMs < intervalMs) {
			return;
		}
		const outcome = await runRetentionSweepOnce({
			settings,
			...(this.defaultSessionConfig.agentDir ? { agentDir: this.defaultSessionConfig.agentDir } : {}),
			residentSessionIds: this.residentSessionIds(),
		});
		if (outcome.lockHeld) {
			this.log(
				`retention sweep skipped: another sweep holds the guard${outcome.holder ? ` (${outcome.holder})` : ""}`,
			);
			return;
		}
		this.lastRetentionSweepAtMs = now;
		const report = outcome.report;
		if (!report) {
			return;
		}
		this.log(
			`retention sweep: reclaimed ${report.totals.reclaimed} entries / ${report.totals.bytes} bytes` +
				`${report.capped ? " (per-sweep cap reached)" : ""}${report.dryRun ? " (dry run)" : ""}` +
				`${outcome.lockUnavailable ? " (no sweep guard)" : ""}`,
		);
	}

	/** Session ids this supervisor has resident, so a sweep never touches them. */
	private residentSessionIds(): ReadonlySet<string> {
		const ids = new Set<string>();
		for (const worker of this.workers.values()) {
			for (const summary of worker.summaries.values()) {
				ids.add(summary.id);
				if (summary.activeSessionId) {
					ids.add(summary.activeSessionId);
				}
			}
		}
		return ids;
	}

	/**
	 * L5: a failed worker whose process is verifiably gone is archived into the log
	 * and removed, so restarts stop replaying the same corpses and the agents view
	 * stops carrying rows nobody can act on. Low frequency by design: this is
	 * cleanup, not liveness detection.
	 */
	private async reapFailedWorkers(now = Date.now()): Promise<void> {
		if (this.failedWorkerReapSweep || this.shuttingDown) {
			return this.failedWorkerReapSweep;
		}
		this.failedWorkerReapSweep = this.reapFailedWorkersOnce(now).finally(() => {
			this.failedWorkerReapSweep = undefined;
		});
		return this.failedWorkerReapSweep;
	}

	private async reapFailedWorkersOnce(now: number): Promise<void> {
		const thresholdHours = this.settingsManager.getDaemonSupervisorSettings().failedWorkerReapHours;
		if (thresholdHours === undefined) {
			return;
		}
		const thresholdMs = thresholdHours * 60 * 60 * 1000;
		const candidates = [...this.workers.values()].filter((worker) =>
			this.isFailedWorkerReapCandidate(worker, now, thresholdMs),
		);
		if (candidates.length === 0) {
			return;
		}
		for (const worker of candidates) {
			if (this.shuttingDown) {
				return;
			}
			// I-7: the identity check may spawn `ps`, so it is awaited (never
			// execFileSync) and the loop yields between candidates.
			if (!(await this.isWorkerProcessConfirmedDead(worker))) {
				continue;
			}
			if (this.hasUnconsumedRecoveryJournal(worker)) {
				this.log(
					`Keeping failed worker ${worker.descriptor.workerId}: its recovery journal still has unconsumed busy operations`,
				);
				continue;
			}
			if (this.degraded) {
				// M16: the reaper's inputs are bookkeeping. While the supervisor runs on
				// state it could not persist, only the reversible half runs — the roster
				// row goes inactive, the descriptor (an irreversible delete) is kept.
				this.logDegraded(
					"failed worker reaper deferred",
					`Failed-worker reaper deferred while degraded: kept ${worker.descriptor.workerId} on disk and only flipped its roster rows inactive`,
				);
				this.flipWorkerRosterEntriesInactive(worker);
				continue;
			}
			this.archiveAndReapFailedWorker(worker, now);
			await new Promise<void>((resolveYield) => setImmediate(resolveYield));
		}
	}

	private isFailedWorkerReapCandidate(worker: ResidentWorker, now: number, thresholdMs: number): boolean {
		if (worker.descriptor.lifecycle !== "failed") {
			return false;
		}
		// An intentional or in-flight stop owns the registration until it finishes.
		if (worker.descriptor.stopRequestedAt !== undefined || this.isWorkerStopping(worker)) {
			return false;
		}
		if (worker.recovery || worker.deferredRecovery || worker.stopFinalization) {
			return false;
		}
		if (this.adoptionRetryTimers.has(worker)) {
			return false;
		}
		// Exemptions: a schedule that still needs the tree, and anybody watching it.
		if (this.workerHasScheduledJobs(worker) || this.workerHasAttachedClient(worker)) {
			return false;
		}
		const failedAt = Date.parse(worker.descriptor.lastFailureAt ?? worker.descriptor.updatedAt);
		if (!Number.isFinite(failedAt)) {
			return false;
		}
		return now - failedAt >= thresholdMs;
	}

	/**
	 * Death has to be proven twice before an irreversible delete: the pid must be
	 * gone, and a pid that is alive must demonstrably belong to somebody else. An
	 * unobservable identity counts as alive, so a transient `ps` failure can never
	 * authorise deleting a registration.
	 */
	private async isWorkerProcessConfirmedDead(worker: ResidentWorker): Promise<boolean> {
		return isProcessIdentityConfirmedDead(worker.descriptor.pid, worker.descriptor.processStartId);
	}

	private hasUnconsumedRecoveryJournal(worker: ResidentWorker): boolean {
		try {
			const journal = new WorkerRecoveryJournal(worker.descriptor.recoveryJournalPath);
			return journal.getLatest().some((record) => record.busy);
		} catch {
			// An unreadable journal is treated as unconsumed: deleting the descriptor
			// would drop the only record of operations that may need interruption.
			return true;
		}
	}

	/** C17: the failed descriptor is the only on-disk evidence of an OOM-class accident, so it is archived before deletion. */
	private archiveAndReapFailedWorker(worker: ResidentWorker, now: number): void {
		const descriptor = worker.descriptor;
		const failedAt = Date.parse(descriptor.lastFailureAt ?? descriptor.updatedAt);
		const failedForMinutes = Number.isFinite(failedAt) ? Math.round((now - failedAt) / 60_000) : undefined;
		this.log(
			`Reaped failed worker ${descriptor.workerId} (reaped failed worker: pid ${descriptor.pid}, ` +
				`processStartId ${descriptor.processStartId ?? "unknown"}, ` +
				`failedForMinutes ${failedForMinutes ?? "unknown"}, ` +
				`lastFailureAt ${descriptor.lastFailureAt ?? "unknown"}, ` +
				`lastError ${descriptor.lastError ?? "unknown"}, ` +
				`rootActiveSessionId ${descriptor.rootActiveSessionId}, ` +
				`rootSessionId ${descriptor.rootSessionId ?? "unknown"}, ` +
				`sessionFile ${descriptor.sessionFile ?? "unknown"}, ` +
				`descriptorPath ${worker.descriptorPath}, ` +
				`consecutiveFailures ${descriptor.consecutiveFailures})`,
		);
		this.workers.delete(descriptor.workerId);
		this.flipWorkerRosterEntriesInactive(worker);
		// L9F-1 / audit F2: this path used to delete the orphan journal without
		// reaping it (reclaimStaleWorkerRegistration reaps first), leaking the dead
		// worker's still-running bash children and leaving foreign dead records
		// active until the file went. Reap both halves before the delete.
		this.reapFailedWorkerOrphanJournal(worker);
		this.deleteWorkerDescriptor(worker);
		if (!this.shuttingDown) {
			this.broadcastHeartbeatsChanged();
		}
	}

	/**
	 * L9F-1: the failed-worker reap path's journal cleanup. The owner half mirrors
	 * `recoverUncertainWorkerOperations` (kill the dead worker's still-active bash
	 * children, guarded by the same identity checks); the foreign half only retires
	 * records whose pid is already gone, never killing anything a foreign writer
	 * still owns. The journal itself still goes with the descriptor right after.
	 */
	private reapFailedWorkerOrphanJournal(worker: ResidentWorker): void {
		const path = worker.descriptor.orphanProcessJournalPath;
		if (!path) {
			return;
		}
		try {
			for (const orphan of readActiveOrphanProcesses(path, worker.descriptor.pid)) {
				if (!shouldReapOrphanProcess(orphan)) {
					continue;
				}
				killOrphanProcess(orphan.pid);
			}
			reapForeignOrphanProcessRecords(path, worker.descriptor.pid);
		} catch (error) {
			this.log(`Could not reap orphan journal of failed worker ${worker.descriptor.workerId}: ${String(error)}`);
		}
	}

	private async adoptOrRecoverWorker(worker: ResidentWorker): Promise<void> {
		await this.assertRecoveryAllowed();
		if (worker.descriptor.stopRequestedAt) {
			try {
				// A descriptor persisted before identity tracking has no
				// processStartId, so stopWorker could neither signal the live
				// process nor let the finalizer escalate. Authenticating on the
				// worker's socket proves the pid still belongs to our worker, so
				// the start id observed while it was alive can be persisted (and
				// the connected client gives stopWorker its graceful IPC path).
				if (worker.descriptor.processStartId === undefined && isProcessAlive(worker.descriptor.pid)) {
					const observedProcessStartId = getProcessStartId(worker.descriptor.pid);
					try {
						await this.connectWorker(worker, WORKER_CONNECT_TIMEOUT_MS);
						if (observedProcessStartId) {
							worker.descriptor.processStartId = observedProcessStartId;
							this.tryPersistWorker(worker, "adoption identity persist");
						}
					} catch {
						// Unverifiable identity stays untrusted; the stop below
						// still runs its graceful path and the finalizer keeps
						// waiting rather than signalling a possibly-recycled pid.
					}
				}
				await this.stopWorker(worker, true, true, worker.descriptor.archiveOnStop === true);
				this.log(`Completed intentional stop for worker ${worker.descriptor.workerId} during supervisor adoption`);
			} catch (error) {
				worker.descriptor.lifecycle = "failed";
				// Preserve the first failure time: the reaper ages a corpse from it, and a
				// restart that re-parks the same dead worker must not reset that clock.
				worker.descriptor.lastFailureAt ??= new Date().toISOString();
				worker.descriptor.lastError = error instanceof Error ? error.message : String(error);
				this.tryPersistWorker(worker, "adoption intentional-stop failure");
				this.log(`Could not complete intentional stop for worker ${worker.descriptor.workerId}: ${String(error)}`);
			}
			return;
		}
		let observedProcessStartId: string | undefined;
		try {
			if (!isProcessAlive(worker.descriptor.pid)) {
				throw new Error("Session worker process is no longer running");
			}
			observedProcessStartId = getProcessStartId(worker.descriptor.pid);
			await this.connectWorker(worker, ADOPTION_WORKER_CONNECT_TIMEOUT_MS);
			await this.subscribeWorker(worker, worker.descriptor.rootActiveSessionId, this.adoptionRequestTimeoutMs);
			await this.refreshWorkerSummaries(worker, true);
			if (worker.descriptor.processStartId === undefined && observedProcessStartId) {
				worker.descriptor.processStartId = observedProcessStartId;
			}
			await this.assertRecoveryAllowed();
			worker.descriptor.lifecycle = "ready";
			worker.descriptor.consecutiveFailures = 0;
			worker.deferredRecoveryRounds = 0;
			// A spent backoff budget must not outlive the failure it was spent on: a
			// later episode on a long-lived supervisor gets its own re-adoption retries.
			worker.adoptionRetryAttempt = 0;
			this.tryPersistWorker(worker, "adoption");
			this.broadcastHeartbeatsChanged();
		} catch (error) {
			if (isSupervisorRecoveryCancelled(error)) {
				return;
			}
			this.log(`Could not adopt worker ${worker.descriptor.workerId}: ${String(error)}`);
			// A client-owned worker's launch env lives only with its owner; recoverWorker parks it instead.
			if (error instanceof PreRosterWorkerError && worker.descriptor.ownerClientId === undefined) {
				try {
					await this.restartPreRosterWorker(worker, observedProcessStartId);
					return;
				} catch (restartError) {
					if (isSupervisorRecoveryCancelled(restartError)) {
						return;
					}
					this.log(`Could not restart pre-roster worker ${worker.descriptor.workerId}: ${String(restartError)}`);
				}
			}
			const identityNow = this.processIdentity(worker.descriptor.pid, worker.descriptor.processStartId);
			if (isDaemonWorkerProbeTimeout(error) && (identityNow === "current" || identityNow === "unknown")) {
				worker.descriptor.lifecycle = "recovering";
				worker.descriptor.lastError = error instanceof Error ? error.message : String(error);
				this.tryPersistWorker(worker, "adoption probe timeout");
				void this.recoverWorker(worker).catch((recoveryError) =>
					this.log(`Could not recover worker ${worker.descriptor.workerId}: ${String(recoveryError)}`),
				);
				return;
			}
			await this.recoverWorker(worker);
		}
	}

	private async restartPreRosterWorker(
		worker: ResidentWorker,
		observedProcessStartId: string | undefined,
	): Promise<void> {
		await this.assertRecoveryAllowed();
		if (worker.descriptor.processStartId === undefined && observedProcessStartId !== undefined) {
			worker.descriptor.processStartId = observedProcessStartId;
		}
		const identity = () => this.processIdentity(worker.descriptor.pid, worker.descriptor.processStartId);
		// The one deliberate kill of a live worker: it authenticated as ours and predates the roster
		// protocol, so this identity-verified upgrade replaces it. No await between recheck and signal.
		if (identity() === "current") {
			signalProcessGroupOrProcess(worker.descriptor.pid, "SIGKILL");
			// SIGKILL is uninterceptable; this wait only covers kernel teardown of the old process and socket.
			const killDeadline = Date.now() + 1000;
			while (identity() === "current" && Date.now() < killDeadline) {
				await delay(25);
			}
		}
		const finalIdentity = identity();
		if (finalIdentity !== "gone" && finalIdentity !== "replaced") {
			// A live or unverifiable survivor parks failed with no destructive cleanup: interruption
			// marking and orphan reaping must never run against a possibly-active worker.
			worker.descriptor.lifecycle = "failed";
			// Preserve the first failure time: the reaper ages a corpse from it, and a
			// restart that re-parks the same dead worker must not reset that clock.
			worker.descriptor.lastFailureAt ??= new Date().toISOString();
			worker.descriptor.lastError = `Pre-roster worker process ${worker.descriptor.pid} is still running and cannot be replaced safely`;
			this.tryPersistWorker(worker, "pre-roster worker park");
			this.markWorkerRosterEntries(worker, "failed");
			this.log(`Kept pre-roster worker ${worker.descriptor.workerId} failed: ${worker.descriptor.lastError}`);
			return;
		}
		await this.recoverUncertainWorkerOperations(worker);
		if (this.isWorkerRecoveryCancelled(worker)) {
			return;
		}
		await this.launchWorker(
			worker.descriptor.createCommand,
			worker,
			worker.descriptor.ownerClientId,
			this.adoptionRequestTimeoutMs,
		);
	}

	private async handleWorkerClose(worker: ResidentWorker, client: DaemonWorkerClient, error: Error): Promise<void> {
		if (worker.client !== client) {
			return;
		}
		worker.client = undefined;
		this.invalidateWorkerSessionInputPauses(worker, "Session worker disconnected while input was paused");
		const interrupted = new Map<string, Set<string>>();
		for (const [activeSessionId, generations] of worker.snapshotGenerations ?? []) {
			for (const generation of generations.values()) {
				if (generation.incoming || !generation.transcript.complete) {
					const snapshotIds = interrupted.get(activeSessionId) ?? new Set<string>();
					snapshotIds.add(generation.transcript.snapshotId);
					interrupted.set(activeSessionId, snapshotIds);
				}
			}
		}
		for (const [activeSessionId, transcript] of worker.transcriptCaches) {
			if (!transcript.complete) {
				const snapshotIds = interrupted.get(activeSessionId) ?? new Set<string>();
				snapshotIds.add(transcript.snapshotId);
				interrupted.set(activeSessionId, snapshotIds);
			}
		}
		for (const [activeSessionId, snapshotIds] of interrupted) {
			for (const snapshotId of snapshotIds) {
				this.failWorkerSnapshotCache(
					worker,
					activeSessionId,
					new Error("Session worker disconnected during snapshot transfer"),
					false,
					snapshotId,
				);
			}
		}
		if (this.shuttingDown || worker.intentionalStop) {
			return;
		}
		this.markWorkerRosterEntries(worker, "recovering");
		try {
			await this.assertRecoveryAllowed();
		} catch (recoveryError) {
			if (!isSupervisorGenerationStale(recoveryError)) {
				this.deferWorkerRecovery(worker, error);
			}
			return;
		}
		if (!this.isWorkerRecoveryEligible(worker)) {
			return;
		}
		worker.descriptor.lifecycle = "recovering";
		worker.descriptor.lastError = error.message;
		this.tryPersistWorker(worker, "worker disconnect");
		this.background(this.recoverWorker(worker), `worker recovery for ${worker.descriptor.workerId}`);
	}

	private isWorkerRecoveryEligible(worker: ResidentWorker): boolean {
		return this.isWorkerRecoveryCandidate(worker) && worker.recovery === undefined;
	}

	/** Failed is not terminal for an identity-verified live worker: any touch retries recovery, like manual retry_worker. */
	private canRetryFailedWorker(worker: ResidentWorker): boolean {
		return (
			worker.descriptor.lifecycle === "failed" &&
			(this.workerStopCounts?.get(worker) ?? 0) === 0 &&
			// A user-stopped worker stays stopped; only an explicit retry_worker clears the persisted stop markers.
			!this.isWorkerStopping(worker) &&
			this.processIdentity(worker.descriptor.pid, worker.descriptor.processStartId) === "current"
		);
	}

	private async retryWorkerRecovery(worker: ResidentWorker): Promise<void> {
		worker.intentionalStop = false;
		worker.descriptor.stopRequestedAt = undefined;
		worker.descriptor.archiveOnStop = undefined;
		worker.descriptor.lifecycle = "recovering";
		worker.descriptor.consecutiveFailures = 0;
		worker.deferredRecoveryRounds = 0;
		this.persistWorker(worker);
		await this.recoverWorker(worker);
	}

	private isWorkerRecoveryCandidate(worker: ResidentWorker): boolean {
		return (
			!this.shuttingDown &&
			!worker.intentionalStop &&
			worker.descriptor.stopRequestedAt === undefined &&
			this.workers.get(worker.descriptor.workerId) === worker &&
			worker.client === undefined
		);
	}

	private deferWorkerRecovery(worker: ResidentWorker, disconnectError: Error): void {
		if (worker.deferredRecovery) {
			return;
		}
		// A live-but-silent worker must not probe forever: park it failed (user-visible through the
		// roster's failed status) and keep its process alive. The park is not terminal: retry_worker,
		// attach, and create all retry recovery while the process identity stays current.
		worker.deferredRecoveryRounds = (worker.deferredRecoveryRounds ?? 0) + 1;
		if (worker.deferredRecoveryRounds > MAX_DEFERRED_RECOVERY_ROUNDS) {
			worker.descriptor.lifecycle = "failed";
			// Preserve the first failure time: the reaper ages a corpse from it, and a
			// restart that re-parks the same dead worker must not reset that clock.
			worker.descriptor.lastFailureAt ??= new Date().toISOString();
			worker.descriptor.lastError = `Live session worker did not answer recovery probes for ${MAX_DEFERRED_RECOVERY_ROUNDS} rounds: ${disconnectError.message}`;
			this.tryPersistWorker(worker, "deferred recovery park");
			this.markWorkerRosterEntries(worker, "failed");
			this.log(
				`Worker ${worker.descriptor.workerId} is unresponsive; parked failed after ${MAX_DEFERRED_RECOVERY_ROUNDS} probe rounds`,
			);
			this.armScheduledJobReadoption(worker, worker.descriptor.lastError ?? "Worker stopped answering probes");
			return;
		}
		worker.deferredRecovery = this.resumeDeferredWorkerRecovery(worker, disconnectError).finally(() => {
			worker.deferredRecovery = undefined;
		});
	}

	private async resumeDeferredWorkerRecovery(worker: ResidentWorker, disconnectError: Error): Promise<void> {
		while (true) {
			await unrefDelay(DEFERRED_RECOVERY_RECHECK_MS);
			if (!this.isWorkerRecoveryCandidate(worker)) {
				return;
			}
			if (!this.isWorkerRecoveryEligible(worker)) {
				continue;
			}
			try {
				await this.assertRecoveryAllowed();
			} catch (error) {
				if (isSupervisorGenerationStale(error)) {
					return;
				}
				continue;
			}
			if (!this.isWorkerRecoveryCandidate(worker)) {
				return;
			}
			if (!this.isWorkerRecoveryEligible(worker)) {
				continue;
			}
			worker.descriptor.lifecycle = "recovering";
			worker.descriptor.lastError = disconnectError.message;
			this.tryPersistWorker(worker, "deferred recovery resume");
			this.background(this.recoverWorker(worker), `deferred worker recovery for ${worker.descriptor.workerId}`);
			return;
		}
	}

	private failWorkerSnapshotCache(
		worker: ResidentWorker,
		activeSessionId: string,
		error: Error,
		closeWorkerChannel = false,
		expectedSnapshotId?: string,
	): void {
		const generations = worker.snapshotGenerations?.get(activeSessionId);
		if (expectedSnapshotId) {
			const generation = generations?.get(expectedSnapshotId);
			if (generation) {
				this.failSnapshotGeneration(worker, activeSessionId, generation, error);
			} else {
				const transcript = worker.transcriptCaches.get(activeSessionId);
				if (transcript?.snapshotId !== expectedSnapshotId) {
					return;
				}
				transcript.markFailed(error);
				transcript.dispose();
				worker.transcriptCaches.delete(activeSessionId);
				if (worker.snapshotCache.get(activeSessionId)?.snapshotStream?.id === expectedSnapshotId) {
					worker.snapshotCache.delete(activeSessionId);
				}
			}
		} else {
			const failedTranscripts = new Set<SnapshotTranscriptCache>();
			for (const generation of [...(generations?.values() ?? [])]) {
				failedTranscripts.add(generation.transcript);
				this.failSnapshotGeneration(worker, activeSessionId, generation, error);
			}
			const transcript = worker.transcriptCaches.get(activeSessionId);
			if (transcript && !failedTranscripts.has(transcript)) {
				transcript.markFailed(error);
				transcript.dispose();
			}
			worker.transcriptCaches.delete(activeSessionId);
			worker.snapshotCache.delete(activeSessionId);
		}
		if (closeWorkerChannel) {
			const client = worker.client;
			if (client) {
				this.handleWorkerClose(worker, client, error);
				client.close();
			}
		}
	}

	/** Settle a transfer anomaly with the transfer as the blast radius: the worker channel stays up and clients resync fresh. */
	private failSnapshotTransfer(
		worker: ResidentWorker,
		activeSessionId: string,
		snapshotId: string,
		error: Error,
		snapshotPurpose: Extract<DaemonWorkerFrameHeader, { kind: "outbound" }>["snapshotPurpose"],
	): void {
		const published = worker.transcriptCaches.get(activeSessionId)?.snapshotId === snapshotId;
		this.failWorkerSnapshotCache(worker, activeSessionId, error, false, snapshotId);
		// The published-cache drop drives the resync, not the frame's purpose: a published transfer
		// can be serving any client's catch-up wait, whose queue entry drainClientCatchups already cleared.
		if (published) {
			this.queueSnapshotResync(activeSessionId, snapshotPurpose === "replacement" ? "replacement" : "catchup");
		}
	}

	private queueSnapshotResync(activeSessionId: string, snapshotPurpose: "replacement" | "catchup"): void {
		for (const client of this.clients) {
			if (!client.attachedActiveSessionIds.has(activeSessionId)) continue;
			this.queueCatchup(client, activeSessionId, snapshotPurpose === "replacement" ? "replacement" : "resync");
			void this.catchUpClient(client).catch((error) =>
				this.log(`Failed to catch up client ${client.id}: ${String(error)}`),
			);
		}
	}

	private retireWorkerSnapshotCache(
		worker: ResidentWorker,
		activeSessionId: string,
		expectedTranscript: SnapshotTranscriptCache,
	): void {
		if (worker.transcriptCaches.get(activeSessionId) === expectedTranscript) {
			worker.transcriptCaches.delete(activeSessionId);
		}
		if (worker.snapshotCache.get(activeSessionId)?.snapshotStream?.id === expectedTranscript.snapshotId) {
			worker.snapshotCache.delete(activeSessionId);
		}
		const generation = this.snapshotGeneration(worker, activeSessionId, expectedTranscript.snapshotId);
		if (!generation) {
			expectedTranscript.dispose();
			return;
		}
		generation.retired = true;
		this.settleSnapshotDuplicateValidation(generation);
		if (generation.incoming) {
			return;
		}
		this.deleteSnapshotGeneration(worker, activeSessionId, generation);
		expectedTranscript.dispose();
	}

	private snapshotGenerationsFor(
		worker: ResidentWorker,
		activeSessionId: string,
	): Map<string, SnapshotTranscriptGeneration> {
		worker.snapshotGenerations ??= new Map();
		let generations = worker.snapshotGenerations.get(activeSessionId);
		if (!generations) {
			generations = new Map();
			worker.snapshotGenerations.set(activeSessionId, generations);
		}
		return generations;
	}

	private snapshotGeneration(
		worker: ResidentWorker,
		activeSessionId: string,
		snapshotId: string,
	): SnapshotTranscriptGeneration | undefined {
		return worker.snapshotGenerations?.get(activeSessionId)?.get(snapshotId);
	}

	private currentSnapshotGeneration(
		worker: ResidentWorker,
		activeSessionId: string,
	): SnapshotTranscriptGeneration | undefined {
		worker.transcriptCaches ??= new Map();
		worker.snapshotCache ??= new Map();
		const transcript = worker.transcriptCaches.get(activeSessionId);
		if (!transcript) {
			return undefined;
		}
		const generations = this.snapshotGenerationsFor(worker, activeSessionId);
		let generation = generations.get(transcript.snapshotId);
		if (generation) {
			return generation;
		}
		const result = worker.snapshotCache.get(activeSessionId);
		if (!result) {
			return undefined;
		}
		generation = {
			transcript,
			result,
			incoming: false,
			retired: false,
		};
		generations.set(transcript.snapshotId, generation);
		return generation;
	}

	private deleteSnapshotGeneration(
		worker: ResidentWorker,
		activeSessionId: string,
		generation: SnapshotTranscriptGeneration,
	): void {
		const generations = worker.snapshotGenerations?.get(activeSessionId);
		if (!generations) {
			return;
		}
		if (generations.get(generation.transcript.snapshotId) === generation) {
			generations.delete(generation.transcript.snapshotId);
		}
		if (generations.size === 0) {
			worker.snapshotGenerations.delete(activeSessionId);
		}
	}

	private failSnapshotGeneration(
		worker: ResidentWorker,
		activeSessionId: string,
		generation: SnapshotTranscriptGeneration,
		error: Error,
	): void {
		this.settleSnapshotDuplicateValidation(generation, error);
		generation.transcript.markFailed(error);
		generation.transcript.dispose();
		this.deleteSnapshotGeneration(worker, activeSessionId, generation);
		if (worker.transcriptCaches.get(activeSessionId) === generation.transcript) {
			worker.transcriptCaches.delete(activeSessionId);
		}
		if (worker.snapshotCache.get(activeSessionId)?.snapshotStream?.id === generation.transcript.snapshotId) {
			worker.snapshotCache.delete(activeSessionId);
		}
	}

	private createSnapshotDuplicateValidation(): SnapshotDuplicateValidation {
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<void>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		void promise.catch(() => undefined);
		return { promise, resolve, reject };
	}

	private settleSnapshotDuplicateValidation(generation: SnapshotTranscriptGeneration, error?: Error): void {
		const validation = generation.validation;
		if (!validation) {
			return;
		}
		generation.validation = undefined;
		if (error) {
			validation.reject(error);
		} else {
			validation.resolve();
		}
	}

	private async recoverWorker(worker: ResidentWorker): Promise<void> {
		if (this.isWorkerRecoveryCancelled(worker)) {
			return;
		}
		if (worker.descriptor.ownerClientId && !worker.launchEnv && !isProcessAlive(worker.descriptor.pid)) {
			worker.descriptor.lifecycle = "failed";
			// Preserve the first failure time: the reaper ages a corpse from it, and a
			// restart that re-parks the same dead worker must not reset that clock.
			worker.descriptor.lastFailureAt ??= new Date().toISOString();
			worker.descriptor.lastError = "Waiting for the owning client to reconnect";
			this.tryPersistWorker(worker, "recovery waiting for owner");
			return;
		}
		if (worker.recovery) {
			return worker.recovery;
		}
		worker.recovery = (async () => {
			let keepProbingLiveWorker = false;
			for (const retryDelay of WORKER_RETRY_DELAYS_MS) {
				await delay(retryDelay);
				keepProbingLiveWorker = false;
				if (this.isWorkerRecoveryCancelled(worker)) {
					return;
				}
				try {
					await this.assertRecoveryAllowed();
					const identityNow = this.processIdentity(worker.descriptor.pid, worker.descriptor.processStartId);
					const identityCompatible =
						identityNow === "current" ||
						(identityNow === "unknown" && worker.descriptor.processStartId === undefined);
					if (identityCompatible) {
						try {
							await this.connectWorker(worker, RECOVERY_PROBE_CONNECT_TIMEOUT_MS);
							await this.subscribeWorker(
								worker,
								worker.descriptor.rootActiveSessionId,
								this.adoptionRequestTimeoutMs,
							);
							await this.refreshWorkerSummaries(worker, true);
							if (this.isWorkerRecoveryCancelled(worker)) {
								return;
							}
							if (worker.descriptor.processStartId === undefined) {
								const observedProcessStartId = getProcessStartId(worker.descriptor.pid);
								if (observedProcessStartId) {
									worker.descriptor.processStartId = observedProcessStartId;
								}
							}
							await this.assertRecoveryAllowed();
							worker.descriptor.lifecycle = "ready";
							worker.descriptor.consecutiveFailures = 0;
							worker.deferredRecoveryRounds = 0;
							this.tryPersistWorker(worker, "worker recovery");
							this.broadcastHeartbeatsChanged();
							return;
						} catch (error) {
							if (isSupervisorRecoveryCancelled(error)) {
								throw error;
							}
							await this.assertRecoveryAllowed();
							worker.client?.close();
							worker.client = undefined;
							// A worker with the same durable process identity may be load-slow.
							// Keep probing it instead of replacing live work after a timeout.
							keepProbingLiveWorker = isDaemonWorkerProbeTimeout(error) || identityNow !== "current";
							throw error;
						}
					}
					if (identityNow === "unknown") {
						keepProbingLiveWorker = true;
						throw new Error(
							`Cannot safely replace live session worker ${worker.descriptor.workerId} without a verified process identity`,
						);
					}
					const recoveryCommand = worker.descriptor.ownerClientId ? worker.transientCreateCommand : undefined;
					if (!recoveryCommand || !worker.launchEnv) {
						await this.recoverUncertainWorkerOperations(worker);
						worker.descriptor.lifecycle = "failed";
						// Preserve the first failure time: the reaper ages a corpse from it, and a
						// restart that re-parks the same dead worker must not reset that clock.
						worker.descriptor.lastFailureAt ??= new Date().toISOString();
						worker.descriptor.lastError = "Waiting for a client with fresh runtime context";
						this.tryPersistWorker(worker, "recovery park");
						this.markWorkerRosterEntries(worker, "failed");
						this.armScheduledJobReadoption(worker, worker.descriptor.lastError);
						return;
					}
					await this.recoverUncertainWorkerOperations(worker);
					if (this.isWorkerRecoveryCancelled(worker)) {
						return;
					}
					await this.launchWorker(
						recoveryCommand,
						worker,
						worker.descriptor.ownerClientId,
						this.adoptionRequestTimeoutMs,
					);
					return;
				} catch (error) {
					if (isSupervisorRecoveryCancelled(error) || this.isWorkerRecoveryCancelled(worker)) {
						return;
					}
					try {
						await this.assertRecoveryAllowed();
					} catch {
						return;
					}
					worker.client?.close();
					worker.client = undefined;
					worker.descriptor.consecutiveFailures++;
					worker.descriptor.lastFailureAt = new Date().toISOString();
					worker.descriptor.lastError = error instanceof Error ? error.message : String(error);
					this.tryPersistWorker(worker, "recovery failure bookkeeping");
				}
			}
			if (keepProbingLiveWorker) {
				try {
					await this.assertRecoveryAllowed();
				} catch {
					return;
				}
				worker.descriptor.lifecycle = "recovering";
				this.tryPersistWorker(worker, "recovery deferral");
				this.deferWorkerRecovery(
					worker,
					new Error(worker.descriptor.lastError ?? "Live session worker did not answer recovery probes"),
				);
				return;
			}
			try {
				await this.assertRecoveryAllowed();
			} catch {
				return;
			}
			// Leak-over-kill: a live worker that keeps failing for non-timeout reasons parks failed with
			// its process intact. A verified-identity survivor is reclaimed by the next fresh create;
			// an unverifiable one waits for exit — killing a pid we cannot verify as ours is worse.
			worker.descriptor.lifecycle = "failed";
			// Preserve the first failure time: the reaper ages a corpse from it, and a
			// restart that re-parks the same dead worker must not reset that clock.
			worker.descriptor.lastFailureAt ??= new Date().toISOString();
			this.tryPersistWorker(worker, "recovery park");
			this.markWorkerRosterEntries(worker, "failed");
			this.log(`Worker ${worker.descriptor.workerId} failed after three recovery attempts`);
			this.armScheduledJobReadoption(
				worker,
				worker.descriptor.lastError ?? "Worker failed after three recovery attempts",
			);
		})().finally(() => {
			worker.recovery = undefined;
		});
		return worker.recovery;
	}

	private isWorkerRecoveryCancelled(worker: ResidentWorker): boolean {
		return (
			this.shuttingDown ||
			worker.intentionalStop ||
			worker.descriptor.stopRequestedAt !== undefined ||
			this.workers.get(worker.descriptor.workerId) !== worker
		);
	}

	private isWorkerCleanupCancelled(worker: ResidentWorker): boolean {
		return (
			this.shuttingDown ||
			worker.descriptor.stopRequestedAt !== undefined ||
			this.workers.get(worker.descriptor.workerId) !== worker
		);
	}

	private async recoverUncertainWorkerOperations(worker: ResidentWorker): Promise<void> {
		await this.assertRecoveryAllowed();
		const journal = new WorkerRecoveryJournal(worker.descriptor.recoveryJournalPath);
		const latest = journal.getLatest();
		const uncertain = latest.filter((record) => record.busy);
		if (uncertain.length > 0) await this.catalog.start();
		await this.assertRecoveryAllowed();
		if (this.isWorkerCleanupCancelled(worker)) {
			throw new SupervisorRecoveryCancelledError("Worker recovery was cancelled before destructive cleanup");
		}

		const interruptedSessions = new Map<
			string,
			{ activeSessionId: string; sessionFile: string; operations: Set<string> }
		>();
		for (const record of uncertain) {
			const sessionFile =
				record.sessionFile ??
				(record.activeSessionId === worker.descriptor.rootActiveSessionId
					? worker.descriptor.sessionFile
					: undefined);
			if (!sessionFile) {
				continue;
			}
			const key = `${record.activeSessionId}\0${sessionFile}`;
			let interrupted = interruptedSessions.get(key);
			if (!interrupted) {
				interrupted = { activeSessionId: record.activeSessionId, sessionFile, operations: new Set() };
				interruptedSessions.set(key, interrupted);
			}
			interrupted.operations.add(record.operation);
		}

		await this.assertRecoveryAllowed();
		if (this.isWorkerCleanupCancelled(worker)) {
			throw new SupervisorRecoveryCancelledError("Worker recovery was cancelled before interruption was recorded");
		}
		await Promise.all(
			[...interruptedSessions.values()].map((interrupted) =>
				this.catalog.markInterrupted(interrupted.sessionFile, interrupted.activeSessionId, [
					...interrupted.operations,
				]),
			),
		);
		await this.assertRecoveryAllowed();
		if (this.isWorkerCleanupCancelled(worker)) {
			throw new SupervisorRecoveryCancelledError("Worker recovery was cancelled before process cleanup");
		}
		const orphanProcessJournalPath = worker.descriptor.orphanProcessJournalPath;
		if (orphanProcessJournalPath) {
			try {
				const orphans = readActiveOrphanProcesses(orphanProcessJournalPath, worker.descriptor.pid);
				let reapFailed = false;
				let retryIsSafe = true;
				for (const orphan of orphans) {
					if (orphan.processStartId === undefined) retryIsSafe = false;
					if (!shouldReapOrphanProcess(orphan)) {
						continue;
					}
					if (!killOrphanProcess(orphan.pid)) reapFailed = true;
				}
				// L9F-1: records a foreign writer (an inherited env host) left behind
				// are invisible to the owner-filtered read above; retire the ones whose
				// pid is already dead so a journal that survives this recovery (the
				// retry case) stops carrying them as active forever.
				reapForeignOrphanProcessRecords(orphanProcessJournalPath, worker.descriptor.pid);
				if (!reapFailed || !retryIsSafe) clearOrphanProcessJournal(orphanProcessJournalPath);
			} catch (error) {
				this.log(`Could not reap orphaned worker resources: ${String(error)}`);
			}
		}
		if (uncertain.length === 0) {
			return;
		}
		for (const record of latest) {
			journal.record({
				activeSessionId: record.activeSessionId,
				sessionId: record.sessionId,
				...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
				busy: false,
				operation: "recovery_hold",
			});
		}
		this.log(
			`Recovered worker ${worker.descriptor.workerId} without replaying uncertain operations: ${uncertain
				.map((record) => record.operation)
				.join(", ")}`,
		);
	}

	/**
	 * Reload a worker's session rows.
	 *
	 * A row's in-flight assistant message carries the whole turn so far, so a
	 * caller that only reads counters and previews can ask the worker to leave
	 * those rows out; `omitStreamingMessages` does that when the worker build
	 * advertises the capability. Rows already held keep the message they had, so
	 * no reader sees the field vanish, and re-seeding the stream reconstructor is
	 * left to the pulls that carry authoritative content.
	 */
	private async refreshWorkerSummaries(
		worker: ResidentWorker,
		recovery = false,
		fillGaps = recovery,
		retried = false,
		omitStreamingMessages = false,
	): Promise<void> {
		if (this.isWorkerStopping(worker)) {
			throw new Error("Session worker is stopping");
		}
		if (!worker.client) {
			throw new Error("Session worker is not connected");
		}
		const omit = omitStreamingMessages && worker.client.supports("list_without_streaming_messages");
		const pullSource = worker.client;
		const epochAtStart = worker.rosterEpoch ?? 0;
		const response = await pullSource.request(
			omit ? { type: "list", omitStreamingMessages: true } : { type: "list" },
			5000,
		);
		// A frame received mid-pull can remove rows this stale pull would resurrect; re-pull once, then skip the fill.
		if (fillGaps && (worker.rosterEpoch ?? 0) !== epochAtStart && !retried) {
			return this.refreshWorkerSummaries(worker, recovery, fillGaps, true, omitStreamingMessages);
		}
		const summaries = sessionSummariesFromResponse(response);
		const previous = worker.summaries;
		const nextSummaries = new Map(
			summaries.map((summary) => {
				const activeSessionId = summary.activeSessionId ?? summary.id;
				if (!omit || summary.streamingMessage !== undefined) {
					return [activeSessionId, summary];
				}
				const streamingMessage = previous.get(activeSessionId)?.streamingMessage;
				return [activeSessionId, streamingMessage ? { ...summary, streamingMessage } : summary];
			}),
		);
		const root = nextSummaries.get(worker.descriptor.rootActiveSessionId);
		if (recovery && !root) {
			throw new Error(`Session worker omitted its root session during recovery`);
		}
		worker.summaries = nextSummaries;
		if (fillGaps) {
			await this.chainWorkerRosterApply(worker, pullSource, () => {
				if ((worker.rosterEpoch ?? 0) === epochAtStart) this.syncRosterFromWorkerSummaries(worker);
			});
		}
		for (const summary of summaries) {
			const activeSessionId = summary.activeSessionId ?? summary.id;
			if (summary.streamingMessage?.role === "assistant") {
				// A refreshed summary lags the deltas already applied to a tracked
				// partial; reseeding would rewind the reconstruction. Seed only
				// untracked streams.
				if (!this.streamReconstructor.hasPartial(activeSessionId)) {
					this.streamReconstructor.seed(activeSessionId, summary.streamingMessage);
				}
			} else if (!summary.isStreaming) {
				this.streamReconstructor.clear(activeSessionId);
			}
		}
		if (root) {
			if (recovery) {
				await this.assertRecoveryAllowed();
			}
			await this.chainWorkerRosterApply(worker, pullSource, () => {
				if ((worker.rosterEpoch ?? 0) !== epochAtStart) return;
				worker.descriptor.rootSessionId = root.sessionId;
				worker.descriptor.sessionFile = root.sessionFile;
				worker.descriptor.createCommand = durableDaemonCreateCommand({
					type: "create",
					sessionPath: root.sessionFile,
					noSession: worker.descriptor.createCommand.noSession,
				});
				this.persistWorker(worker);
			});
		}
	}

	private async familyCatalogEntries(): Promise<AgentFamilyCatalogEntry[]> {
		const rosterRows = [...this.roster().values()];
		const entries = rosterRows.map((entry) => this.familyCatalogEntry(sessionSummaryFromRosterEntry(entry)));
		const knownFiles = new Set(
			rosterRows.flatMap((entry) =>
				entry.summary.sessionFile ? [canonicalSessionPath(entry.summary.sessionFile)] : [],
			),
		);
		const scanned = await this.catalog.list(undefined, this.defaultSessionConfig.sessionDir);
		for (const info of scanned) {
			if (knownFiles.has(canonicalSessionPath(info.path))) continue;
			if ((info.rlmDepth ?? (info.parentSessionPath ? -1 : 0)) !== 0) continue;
			entries.push(this.familyCatalogEntry(summaryForInactiveSession(info)));
		}
		return entries;
	}

	private async withSessionNameReservation<T>(
		input: { name: string; depth: number; parentSessionId?: string; parentSessionPath?: string },
		action: () => Promise<T>,
	): Promise<T> {
		const key = sessionNameReservationKey(input);
		if (this.pendingSessionNames.has(key)) {
			throw new Error(formatAgentSessionNameUnavailable(input.name, input.depth));
		}
		this.pendingSessionNames.add(key);
		try {
			return await action();
		} finally {
			this.pendingSessionNames.delete(key);
		}
	}

	private async assertSupervisorSessionNameAvailable(
		target: Pick<SessionSummary, "sessionId" | "rlmDepth" | "parentSessionId" | "parentSessionPath">,
		name: string,
	): Promise<void> {
		assertAgentSessionNameAvailable(await this.familyCatalogEntries(), {
			name,
			depth: target.rlmDepth ?? 0,
			parentSessionId: target.parentSessionId,
			parentSessionPath: target.parentSessionPath ? canonicalSessionPath(target.parentSessionPath) : undefined,
			ignoreSessionId: target.sessionId,
		});
	}

	private roster(): AgentRoster {
		this.rosterStore ??= new AgentRoster(canonicalSessionPath, (mutation) => this.onRosterMutation(mutation));
		return this.rosterStore;
	}

	private onRosterMutation(mutation: AgentRosterMutation): void {
		if (mutation.type === "delete") {
			this.pendingRosterChanged.delete(mutation.agentId);
			this.pendingRosterRemoved.add(mutation.agentId);
		} else {
			this.pendingRosterRemoved.delete(mutation.agentId);
			this.pendingRosterChanged.add(mutation.agentId);
		}
		this.scheduleRosterPush();
	}

	private scheduleRosterPush(): void {
		if (this.rosterPushScheduled || this.shuttingDown) return;
		this.rosterPushScheduled = true;
		setImmediate(() => {
			this.rosterPushScheduled = false;
			this.flushRosterUpdates();
		});
	}

	private flushRosterUpdates(): void {
		const changed: AgentRosterEntry[] = [];
		const removed: string[] = [];
		for (const agentId of this.pendingRosterRemoved) {
			if (this.publishedRosterIds.delete(agentId)) removed.push(agentId);
		}
		for (const agentId of this.pendingRosterChanged) {
			const entry = this.roster().get(agentId);
			if (!entry) continue;
			if (this.isRosterEntryVisibleToClients(entry)) {
				changed.push(entry);
				this.publishedRosterIds.add(agentId);
			} else if (this.publishedRosterIds.delete(agentId)) {
				removed.push(agentId);
			}
		}
		this.pendingRosterChanged.clear();
		this.pendingRosterRemoved.clear();
		if (changed.length === 0 && removed.length === 0) return;
		for (const client of this.clients) {
			if (client.rosterSubscribed !== true) continue;
			if (client.backpressured === true) {
				client.rosterResyncPending = true;
				continue;
			}
			this.write(client, {
				type: "roster_update",
				changed,
				...(removed.length > 0 ? { removed } : {}),
			});
		}
	}

	private rosterEntriesForClient(): AgentRosterEntry[] {
		const entries = [...this.roster().values()].filter((entry) => this.isRosterEntryVisibleToClients(entry));
		for (const entry of entries) this.publishedRosterIds.add(entry.agentId);
		return entries;
	}

	private isRosterEntryVisibleToClients(entry: AgentRosterEntry): boolean {
		const worker = entry.workerId !== undefined ? this.workers.get(entry.workerId) : undefined;
		return worker === undefined || this.isVisibleWorker(worker);
	}

	private writeRosterEntry(
		entry: WorkerRosterEntry,
		worker?: ResidentWorker,
		statusLabel?: AgentRosterEntry["statusLabel"],
	): AgentRosterEntry {
		const previousDirect = this.roster().get(entry.agentId)?.summary.directAttachedClients ?? 0;
		const stored = this.roster().write(entry, worker?.descriptor.workerId, statusLabel);
		// Direct peers attach and detach on the worker socket, so their last detach arrives
		// here as roster truth instead of through a supervisor-socket close.
		if (worker !== undefined && previousDirect > 0 && (entry.summary.directAttachedClients ?? 0) === 0) {
			this.background(
				this.evictEmptySessionOnLastDetach(entry.summary.activeSessionId ?? entry.summary.id),
				"empty session eviction on roster change",
			);
		}
		return stored;
	}

	private workerOwnedRosterSummaryForPath(canonicalPath: string): SessionSummary | undefined {
		const entry = this.roster().bySessionFile(canonicalPath);
		if (!entry || entry.workerId === undefined || !this.workers.has(entry.workerId)) return undefined;
		return sessionSummaryFromRosterEntry(entry);
	}

	private workerRosterEntries(worker: ResidentWorker): AgentRosterEntry[] {
		return this.roster().entriesForWorker(worker.descriptor.workerId);
	}

	private async seedRosterLedger(): Promise<void> {
		try {
			const roots = new Set<string>();
			for (const worker of this.workers.values()) {
				const root = worker.descriptor.sessionFile ?? worker.descriptor.createCommand.sessionPath;
				if (root !== undefined) roots.add(canonicalSessionPath(root));
			}
			if (roots.size === 0) return;
			const edges = await this.rlmSpawnLedger().liveEdges();
			const descendsFrom = rosterFamilyDescendsFrom(edges);
			for (const edge of edges) {
				if (!descendsFrom(canonicalSessionPath(edge.parent), roots)) continue;
				const entry = this.rosterEntryForSpawnLedgerEdge(edge);
				if (this.roster().has(entry.agentId)) continue;
				if (this.roster().hasSessionFile(canonicalSessionPath(edge.child))) continue;
				this.roster().write(await this.hydratedSeedEntry(entry));
			}
		} catch (error) {
			this.log(`Could not seed the agent roster from the spawn ledger: ${String(error)}`);
		}
	}

	/**
	 * L3 follow-up: adoption runs after `markReady()`, so without this a client that
	 * lists right after a restart sees zero sessions until adoption settles, which
	 * reads as losing every session. Seed one honest row per registered root from its
	 * durable descriptor and let adoption upgrade it in place: the roster keys on
	 * sessionId and de-duplicates on sessionFile, so no second row can appear, and a
	 * worker that never comes back still has a row for the park path to flip.
	 */
	private seedAdoptingWorkerRosterRows(): void {
		for (const worker of this.workers.values()) {
			const descriptor = worker.descriptor;
			const sessionId = descriptor.rootSessionId;
			// Client-owned workers are ephemeral and private; their rows are born with
			// the adoption their owner drives.
			if (sessionId === undefined || descriptor.ownerClientId !== undefined) {
				continue;
			}
			// A durable stop intent means a kill was in flight: listing it as recovering
			// would resurrect a root the user deliberately stopped. The stop and reaper
			// paths own that registration, not the session list.
			if (this.isWorkerStopping(worker)) {
				continue;
			}
			if (this.workerRosterEntries(worker).length > 0) {
				continue;
			}
			const summary: SessionSummary = {
				id: descriptor.rootActiveSessionId ?? sessionId,
				lifecycle: "live",
				activity: "idle",
				isSessionActive: false,
				sessionId,
				...(descriptor.rootActiveSessionId !== undefined
					? { activeSessionId: descriptor.rootActiveSessionId }
					: {}),
				...(descriptor.sessionFile !== undefined ? { sessionFile: descriptor.sessionFile } : {}),
				cwd: this.defaultSessionConfig.cwd ?? "",
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount: 0,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			};
			this.writeRosterEntry(workerRosterEntryFromSummary(summary), worker, "recovering");
		}
	}

	private rosterEntryForSpawnLedgerEdge(edge: RlmLedgerEdge): WorkerRosterEntry {
		const persistedSessionId = basename(edge.child, ".jsonl");
		const summary: WorkerRosterEntry["summary"] = {
			id: persistedSessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			runtimeKind: "subagent",
			rlmDepth: edge.depth,
			sessionId: persistedSessionId,
			sessionFile: edge.child,
			sessionName: edge.name,
			cwd: dirname(edge.child),
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			parentSessionPath: edge.parent,
			rlmChildId: edge.childId,
		};
		return { agentId: rosterAgentIdForSummary(summary), summary };
	}

	private consumeWorkerRosterDelta(worker: ResidentWorker, payload: Buffer, source?: DaemonWorkerClient): void {
		let delta: Extract<DaemonWorkerRosterOutbound, { type: "roster_delta" }>;
		try {
			delta = JSON.parse(payload.toString("utf8")) as Extract<DaemonWorkerRosterOutbound, { type: "roster_delta" }>;
		} catch {
			return;
		}
		if (delta.type !== "roster_delta" || !Array.isArray(delta.entries)) return;
		worker.rosterEpoch = (worker.rosterEpoch ?? 0) + 1;
		const applySource = source ?? worker.client ?? worker.pendingClient;
		if (!this.isWorkerRosterApplyCurrent(worker, applySource)) return;
		if (delta.snapshot !== true && worker.rosterApplyChain === undefined) {
			// Same handling as the chained path below: a frame this build cannot apply
			// costs one log line and a repair pull, never the supervisor<->worker
			// connection (a throw here reaches the frame decoder's catch, which
			// destroys the stream).
			try {
				this.applyWorkerRosterDelta(worker, delta);
			} catch (error) {
				this.log(`could not apply a roster frame: ${String(error)}`);
				this.scheduleRosterRepairPull(worker);
			}
			return;
		}
		this.chainWorkerRosterApply(worker, applySource, () =>
			delta.snapshot === true
				? this.applyWorkerRosterSnapshot(worker, delta, applySource)
				: this.applyWorkerRosterDelta(worker, delta),
		);
	}

	private chainWorkerRosterApply(
		worker: ResidentWorker,
		source: DaemonWorkerClient | undefined,
		apply: () => void | Promise<void>,
	): Promise<void> {
		const chained = (worker.rosterApplyChain ?? Promise.resolve())
			.then(() => {
				if (!this.isWorkerRosterApplyCurrent(worker, source)) return;
				return apply();
			})
			.catch((error: unknown) => {
				this.log(`could not apply a roster frame: ${String(error)}`);
				this.scheduleRosterRepairPull(worker);
			});
		worker.rosterApplyChain = chained;
		void chained.finally(() => {
			if (worker.rosterApplyChain === chained) worker.rosterApplyChain = undefined;
		});
		return chained;
	}

	// An apply is valid only while its own source connection is current: dead connections' parked applies abort.
	private isWorkerRosterApplyCurrent(worker: ResidentWorker, source: DaemonWorkerClient | undefined): boolean {
		return (
			this.workers.get(worker.descriptor.workerId) === worker &&
			source !== undefined &&
			(source === worker.client || source === worker.pendingClient)
		);
	}

	private scheduleRosterRepairPull(worker: ResidentWorker): void {
		if (worker.rosterRepairPull || !this.isWorkerRosterApplyCurrent(worker, worker.client)) return;
		// The marker stays set while the repair's own fill applies, so a failing repair never respawns itself.
		worker.rosterRepairPull = this.refreshWorkerSummaries(worker, false, true)
			.catch((error: unknown) =>
				this.log(`Roster repair pull failed for worker ${worker.descriptor.workerId}: ${String(error)}`),
			)
			.finally(() => {
				worker.rosterRepairPull = undefined;
			});
	}

	private applyWorkerRosterDelta(
		worker: ResidentWorker,
		delta: Extract<DaemonWorkerRosterOutbound, { type: "roster_delta" }>,
	): void {
		let skipped = 0;
		for (const entry of delta.entries) {
			// A mixed-version worker can send an entry this build cannot classify, and
			// classification reads `summary.activity`: a missing summary is a
			// synchronous TypeError. Skip and repair instead of throwing into the frame
			// dispatcher, the same way `sessionSummariesFromResponse` validates a `list`
			// response before using it.
			if (!isWorkerRosterEntry(entry)) {
				skipped++;
				continue;
			}
			this.writeRosterEntry(entry, worker);
			this.syncRootDescriptorFromRosterEntry(worker, entry);
		}
		if (skipped > 0) {
			this.log(
				`Skipped ${skipped} malformed roster ${skipped === 1 ? "entry" : "entries"} from worker ${worker.descriptor.workerId}; pulling a repair snapshot`,
			);
			this.scheduleRosterRepairPull(worker);
		}
		for (const agentId of delta.removedAgentIds ?? []) {
			this.roster().delete(agentId);
		}
	}

	private async applyWorkerRosterSnapshot(
		worker: ResidentWorker,
		delta: Extract<DaemonWorkerRosterOutbound, { type: "roster_delta" }>,
		source?: DaemonWorkerClient,
	): Promise<void> {
		let edgesFailed = false;
		const edges = await this.rlmSpawnLedger()
			.liveEdges()
			.catch((error: unknown) => {
				this.log(`Could not read the spawn ledger during a snapshot apply: ${String(error)}`);
				edgesFailed = true;
				return [] as RlmLedgerEdge[];
			});
		const applySource = source ?? worker.client ?? worker.pendingClient;
		if (!this.isWorkerRosterApplyCurrent(worker, applySource)) return;
		const sent = new Set(delta.entries.map((entry) => entry.agentId));
		const removed = new Set(delta.removedAgentIds ?? []);
		const unclaimed = new Map<string, AgentRosterEntry>();
		if (!edgesFailed) {
			for (const entry of this.workerRosterEntries(worker)) {
				if (sent.has(entry.agentId)) continue;
				unclaimed.set(entry.agentId, entry);
			}
		}
		// Only this worker's family reseeds: anything wider can resurrect a client-owned worker's dropped children.
		const workerRoot = worker.descriptor.sessionFile ?? worker.descriptor.createCommand.sessionPath;
		const rootPaths = new Set(workerRoot !== undefined ? [canonicalSessionPath(workerRoot)] : []);
		const descendsFrom = rosterFamilyDescendsFrom(edges);
		const familyEdges = edges.filter((edge) => descendsFrom(canonicalSessionPath(edge.parent), rootPaths));
		// "Unclaimed" rows survive: the sweep deletes them but the restore branch rewrites them.
		const rowSurvivesWithoutReseed = (entry: WorkerRosterEntry, childPath: string): boolean => {
			if (unclaimed.has(entry.agentId)) return true;
			if (sent.has(entry.agentId) && !removed.has(entry.agentId)) return true;
			const survives = (row: AgentRosterEntry | undefined): boolean =>
				row !== undefined && !unclaimed.has(row.agentId) && !removed.has(row.agentId);
			return survives(this.roster().get(entry.agentId)) || survives(this.roster().bySessionFile(childPath));
		};
		const seededEntries = new Map<string, WorkerRosterEntry>();
		for (const edge of familyEdges) {
			const entry = this.rosterEntryForSpawnLedgerEdge(edge);
			if (rowSurvivesWithoutReseed(entry, canonicalSessionPath(edge.child))) continue;
			seededEntries.set(entry.agentId, await this.hydratedSeedEntry(entry));
			if (!this.isWorkerRosterApplyCurrent(worker, applySource)) return;
		}

		// Unreadable edges skip the absentee sweep: it cannot tell registry children from stale rows.
		for (const entry of unclaimed.values()) this.roster().delete(entry.agentId);
		for (const entry of delta.entries) {
			this.writeRosterEntry(entry, worker);
			this.syncRootDescriptorFromRosterEntry(worker, entry);
		}
		for (const agentId of removed) this.roster().delete(agentId);
		if (edgesFailed) {
			this.scheduleRosterRepairPull(worker);
			return;
		}
		for (const edge of familyEdges) {
			const entry = this.rosterEntryForSpawnLedgerEdge(edge);
			if (this.roster().has(entry.agentId)) continue;
			if (this.roster().hasSessionFile(canonicalSessionPath(edge.child))) continue;
			const previous = unclaimed.get(entry.agentId);
			if (previous) {
				const { status, statusLabel, lastHeardFromAt, workerId, ...rest } = previous;
				this.writeRosterEntry(rest, worker);
				continue;
			}
			this.roster().write(seededEntries.get(entry.agentId) ?? { ...entry, seededCwd: true });
		}
	}

	private syncRootDescriptorFromRosterEntry(worker: ResidentWorker, entry: WorkerRosterEntry): void {
		const summary = entry.summary;
		if (summary.activeSessionId !== worker.descriptor.rootActiveSessionId) return;
		if (
			worker.descriptor.rootSessionId === summary.sessionId &&
			worker.descriptor.sessionFile === summary.sessionFile
		) {
			return;
		}
		worker.descriptor.rootSessionId = summary.sessionId;
		worker.descriptor.sessionFile = summary.sessionFile;
		worker.descriptor.createCommand = durableDaemonCreateCommand({
			type: "create",
			sessionPath: summary.sessionFile,
			noSession: worker.descriptor.createCommand.noSession,
		});
		this.persistWorker(worker);
	}

	// Behind the pull-epoch guard the pull is never staler than the row it replaces; never steal another worker's claim.
	private syncRosterFromWorkerSummaries(worker: ResidentWorker): void {
		for (const summary of worker.summaries.values()) {
			const entry = workerRosterEntryFromSummary(summary);
			const existing = this.roster().get(entry.agentId);
			if (existing?.workerId !== undefined && existing.workerId !== worker.descriptor.workerId) continue;
			this.writeRosterEntry(entry, worker);
		}
	}

	private markWorkerRosterEntries(worker: ResidentWorker, statusLabel: "recovering" | "failed" | undefined): void {
		for (const entry of this.workerRosterEntries(worker)) {
			if (!entry.queuedChild && entry.summary.activeSessionId === undefined) continue;
			this.roster().amend(entry.agentId, { statusLabel });
		}
	}

	private flipWorkerRosterEntriesInactive(worker: ResidentWorker): void {
		// Client-owned workers are ephemeral and private: their rows die with the registration.
		const ephemeral = worker.descriptor.ownerClientId !== undefined;
		for (const entry of this.workerRosterEntries(worker)) {
			if (ephemeral || entry.queuedChild) {
				this.roster().delete(entry.agentId);
				continue;
			}
			// Registration marks survive eviction: passive rows still have schedules behind them.
			this.writeRosterEntry(
				passivatedWorkerRosterEntry(entry, {
					hasRegisteredHeartbeat: entry.summary.hasRegisteredHeartbeat === true,
					hasRegisteredCronJob: entry.summary.hasRegisteredCronJob === true,
				}),
			);
		}
	}

	private sweepRosterStaleness(now = Date.now()): void {
		for (const worker of this.workers.values()) {
			if (worker.client === undefined || worker.lastFrameAt === undefined) {
				continue;
			}
			if (now - worker.lastFrameAt > ROSTER_STALE_AFTER_MS) {
				const lastHeardFromAt = new Date(worker.lastFrameAt).toISOString();
				for (const entry of this.workerRosterEntries(worker)) {
					// write() rebuilds rows without the mark; the sweep owns it and restamps only those.
					if (entry.lastHeardFromAt !== lastHeardFromAt) this.roster().amend(entry.agentId, { lastHeardFromAt });
				}
				worker.rosterStale = true;
			} else if (worker.rosterStale) {
				this.clearRosterStaleness(worker);
			}
		}
	}

	private clearRosterStaleness(worker: ResidentWorker): void {
		if (!worker.rosterStale) return;
		worker.rosterStale = false;
		for (const entry of this.workerRosterEntries(worker)) {
			this.roster().amend(entry.agentId, { lastHeardFromAt: undefined });
		}
	}

	/**
	 * Supervisor-side view of the spawn ledger for this supervisor's sessions
	 * dir. Workers hold their own instances over the same file; every read
	 * re-reads the file, so cross-process freshness is per-operation.
	 */
	private rlmSpawnLedger(): RlmSpawnLedger {
		const agentDir = this.defaultSessionConfig.agentDir;
		if (!agentDir) {
			throw new Error("Daemon supervisor config is missing agentDir");
		}
		this.rlmSpawnLedgerInstance ??= new RlmSpawnLedger(
			agentDir,
			this.defaultSessionConfig.sessionDir ?? getSessionsDir(agentDir),
			createRlmLedgerRegistrySeedSource(),
			(message) => this.log(message),
			this.rlmLedgerBoundsOptions(),
		);
		return this.rlmSpawnLedgerInstance;
	}

	// Ledgers are per sessions-dir family: a catalog request for another dir must read that dir's ledger.
	private rlmSpawnLedgerFor(sessionDir: string | undefined): RlmSpawnLedger {
		const agentDir = this.defaultSessionConfig.agentDir;
		const defaultDir = this.defaultSessionConfig.sessionDir ?? (agentDir ? getSessionsDir(agentDir) : undefined);
		if (sessionDir === undefined || (defaultDir !== undefined && resolve(sessionDir) === resolve(defaultDir))) {
			return this.rlmSpawnLedger();
		}
		if (!agentDir) {
			throw new Error("Daemon supervisor config is missing agentDir");
		}
		return new RlmSpawnLedger(
			agentDir,
			sessionDir,
			createRlmLedgerRegistrySeedSource(),
			(message) => this.log(message),
			this.rlmLedgerBoundsOptions(),
		);
	}

	/** Bounds ladder switch for the ledger writer; defaults to on when unreadable. */
	private rlmLedgerBoundsOptions(): { compactionEnabled: boolean } {
		try {
			return { compactionEnabled: this.settingsManager.getRetentionSettings().ledgerCompactionEnabled };
		} catch {
			return { compactionEnabled: true };
		}
	}

	/**
	 * Ledger-backed same-parent rows for name reservation and admission. Rows
	 * carry ledger topology plus best-effort display fields; consumers here
	 * only need id/path/name/depth/parent.
	 */
	private rlmLedgerSiblings(sessionPath: string): Promise<SessionInfo[]> {
		return this.rlmSpawnLedger().siblings(sessionPath);
	}

	private async savedSessionNameReservationInput(
		sessionPath: string,
		name: string,
	): Promise<{ name: string; depth: number; parentSessionId?: string; parentSessionPath?: string }> {
		const targetPath = canonicalSessionPath(sessionPath);
		const active = this.workerOwnedRosterSummaryForPath(targetPath);
		if (active) return this.summaryNameReservationInput(active, name);
		const siblings = await this.rlmLedgerSiblings(sessionPath);
		const saved = siblings.find((info) => canonicalSessionPath(info.path) === targetPath);
		if (!saved) throw new Error(`Session not found: ${sessionPath}`);
		return {
			name,
			depth: saved.rlmDepth ?? siblings.find((sibling) => sibling.rlmDepth !== undefined)?.rlmDepth ?? 0,
			parentSessionPath: saved.parentSessionPath,
		};
	}

	private summaryNameReservationInput(
		target: Pick<SessionSummary, "rlmDepth" | "parentSessionId" | "parentSessionPath">,
		name: string,
	): { name: string; depth: number; parentSessionId?: string; parentSessionPath?: string } {
		const depth = target.rlmDepth ?? (target.parentSessionPath ? 1 : 0);
		return {
			name,
			depth,
			...(depth > 0 && target.parentSessionId ? { parentSessionId: target.parentSessionId } : {}),
			...(depth > 0 && target.parentSessionPath ? { parentSessionPath: target.parentSessionPath } : {}),
		};
	}

	private async assertSupervisorSavedSessionNameAvailable(sessionPath: string, name: string): Promise<void> {
		const targetPath = canonicalSessionPath(sessionPath);
		const active = this.workerOwnedRosterSummaryForPath(targetPath);
		if (active) return this.assertSupervisorSessionNameAvailable(active, name);
		const siblings = await this.rlmLedgerSiblings(sessionPath);
		const saved = siblings.find((info) => canonicalSessionPath(info.path) === targetPath);
		if (!saved) throw new Error(`Session not found: ${sessionPath}`);
		if (saved.parentSessionPath && (saved.rlmDepth ?? 0) > 0) {
			this.assertSavedSiblingNameAvailable(siblings, saved, name);
		} else {
			await this.assertSupervisorSessionNameAvailable(summaryForInactiveSession(saved), name);
		}
	}

	private assertSavedSiblingNameAvailable(siblings: SessionInfo[], target: SessionInfo, name: string): void {
		const setDepth = target.rlmDepth ?? siblings.find((sibling) => sibling.rlmDepth !== undefined)?.rlmDepth ?? 0;
		assertAgentSessionNameAvailable(
			siblings.map((info) => {
				const summary = summaryForInactiveSession(info);
				const ledgerRow = this.roster().bySessionFile(canonicalSessionPath(info.path));
				return {
					id: summary.sessionId,
					...(summary.sessionName ? { name: summary.sessionName } : {}),
					depth: setDepth,
					status: ledgerRow?.status ?? classifySessionRosterStatus(summary),
					...(summary.parentSessionPath
						? { parentSessionPath: canonicalSessionPath(summary.parentSessionPath) }
						: {}),
				};
			}),
			{
				name,
				depth: setDepth,
				parentSessionPath: target.parentSessionPath ? canonicalSessionPath(target.parentSessionPath) : undefined,
				ignoreSessionId: target.id,
			},
		);
	}

	private isVisibleWorker(worker: ResidentWorker): boolean {
		return worker.descriptor.ownerClientId === undefined;
	}

	/** A worker with a durable or in-memory stop intent is stopping, never live. */
	private isWorkerStopping(worker: ResidentWorker): boolean {
		return worker.intentionalStop || worker.descriptor.stopRequestedAt !== undefined;
	}

	/** Live workers are visible to all clients and not stopping. */
	private isLiveWorker(worker: ResidentWorker): boolean {
		return this.isVisibleWorker(worker) && !this.isWorkerStopping(worker);
	}

	/**
	 * The lifecycle reported to clients. A stop intent always wins, and a worker
	 * whose process connection is gone is never reported as "ready".
	 */
	private effectiveWorkerState(worker: ResidentWorker): DaemonWorkerLifecycle {
		if (this.isWorkerStopping(worker)) {
			return "stopping";
		}
		if (worker.descriptor.lifecycle === "ready" && worker.client === undefined) {
			return "recovering";
		}
		return worker.descriptor.lifecycle;
	}

	/**
	 * Terminal commands are idempotent for a target that existed and is gone, so a
	 * caller's retry loop converges instead of spinning on "Unknown active session".
	 * A selector that never matched anything still fails (killing a wrong name must
	 * not read as a success), and read commands keep failing loudly: a read must not
	 * claim success for a target it cannot see (C19).
	 */
	private terminalCommandResponseForGoneTarget(command: DaemonCommand, error: unknown): DaemonResponse | undefined {
		if (!TERMINAL_DAEMON_COMMANDS.has(command.type)) {
			return undefined;
		}
		if (!(error instanceof Error) || !error.message.startsWith("Unknown active session:")) {
			return undefined;
		}
		if (!("activeSessionId" in command) || typeof command.activeSessionId !== "string") {
			return undefined;
		}
		if (!this.isKnownGoneSessionSelector(command.activeSessionId)) {
			return undefined;
		}
		return success(command.id, command.type, { alreadyTerminal: true });
	}

	/** A passivated roster row proves the selector once resolved and its worker is gone. */
	private isKnownGoneSessionSelector(selector: string): boolean {
		// A resident registration that still claims the selector means the target is
		// not gone (it may only be missing a roster row), so the honest lookup error
		// stands instead of an idempotent success that skips the kill.
		if (this.residentWorkerClaimsSelector(selector)) {
			return false;
		}
		const pathSelector = looksLikeSessionPath(selector) ? canonicalSessionPath(selector) : undefined;
		for (const entry of this.roster().values()) {
			const summary = entry.summary;
			const activeSessionId = summary.activeSessionId ?? summary.id;
			const sessionId = summary.sessionId;
			if (activeSessionId === selector || sessionId === selector || summary.sessionName === selector) {
				return true;
			}
			if (matchesSessionIdSuffix(activeSessionId, selector) || matchesSessionIdSuffix(sessionId, selector)) {
				return true;
			}
			if (pathSelector && summary.sessionFile && canonicalSessionPath(summary.sessionFile) === pathSelector) {
				return true;
			}
		}
		return false;
	}

	/** Whether any resident worker registration or its summaries still claim this selector. */
	private residentWorkerClaimsSelector(selector: string): boolean {
		const pathSelector = looksLikeSessionPath(selector) ? canonicalSessionPath(selector) : undefined;
		for (const worker of this.workers.values()) {
			const descriptor = worker.descriptor;
			if (descriptor.rootActiveSessionId === selector || descriptor.rootSessionId === selector) {
				return true;
			}
			if (pathSelector && descriptor.sessionFile && canonicalSessionPath(descriptor.sessionFile) === pathSelector) {
				return true;
			}
			if (this.findSummaryInWorker(worker, selector)) {
				return true;
			}
		}
		return false;
	}

	/** Whether a kill can be forwarded; a stopping worker still answers kill (allowStopping). */
	private isWorkerKillForwardable(worker: ResidentWorker): boolean {
		return worker.client !== undefined && worker.descriptor.lifecycle === "ready";
	}

	/**
	 * F1: whether the whole session tree is provably gone, i.e. no process is left
	 * that could still be hosting its sessions. Only this makes a non-root kill
	 * idempotent: while the process lives the child may still be running, and the
	 * only way to kill it through an unreachable worker is to stop the whole tree,
	 * which takes the root and every sibling with it. A `failed` lifecycle is not
	 * enough — a live worker that stopped answering recovery probes parks failed
	 * with its process intact (deferWorkerRecovery). An unverifiable identity
	 * counts as alive, so a failed lookup can never authorise "already terminal"
	 * (the same conservative direction the reaper and stopWorker use).
	 */
	private isWorkerTreeGone(worker: ResidentWorker): boolean {
		if (worker.client !== undefined) {
			return false;
		}
		const identity = this.processIdentity(worker.descriptor.pid, worker.descriptor.processStartId);
		return identity === "gone" || identity === "replaced";
	}

	/**
	 * L4: kill reaches a worker in every lifecycle. A recovering, starting or failed
	 * worker cannot be asked to kill its own session, so the supervisor performs the
	 * semantic kill: the stop tombstone cancels in-flight recovery
	 * (isWorkerRecoveryCancelled reads stopRequestedAt) and stopWorker reaps the
	 * process, so the kill leaves no orphan behind.
	 *
	 * That semantic kill stops the WHOLE tree, so a non-root target only gets it
	 * once the tree is provably gone (F1) — the stop then clears a registration
	 * whose sessions are already dead, and `alreadyTerminal` is the truth. While the
	 * process lives, a child kill is refused with its real state instead: taking
	 * the root and every sibling down and answering "this target was already
	 * terminal" tells the caller nothing happened when the whole tree just did.
	 */
	private async killUnreachableWorker(
		worker: ResidentWorker,
		summary: SessionSummary,
		command: Extract<DaemonCommand, { type: "kill" }>,
	): Promise<DaemonResponse> {
		const targetActiveSessionId = summary.activeSessionId ?? summary.id;
		const isRootKill = targetActiveSessionId === worker.descriptor.rootActiveSessionId;
		const state = this.effectiveWorkerState(worker);
		if (!isRootKill && !this.isWorkerTreeGone(worker)) {
			// Stopping the worker would take the root and every sibling session with
			// it, and a child kill needs the worker to name the child: report the
			// state honestly instead.
			throw new Error(
				`Session worker is ${state}; cannot kill ${targetActiveSessionId} until it is reachable` +
					(state === "failed"
						? ` (killing it through a failed worker would stop the whole tree: ${worker.descriptor.rootActiveSessionId} and its other sessions. Kill that root session to stop the tree, or retry_worker to make the child reachable again)`
						: ""),
			);
		}
		this.log(
			isRootKill
				? `Killing ${targetActiveSessionId} through an unreachable worker (${state}): stop tombstone written, recovery cancelled`
				: `Killing ${targetActiveSessionId} through an unreachable worker (${state}): its tree is already gone, so the stop clears the registration it shared with ${this.workerActiveSessionIds(worker).join(", ")}`,
		);
		this.persistWorkerStopTombstone(worker, true);
		const releaseStopOwnership = this.acquireWorkerStopOwnership(worker);
		try {
			await this.stopWorker(worker, true, false, true);
		} finally {
			releaseStopOwnership();
		}
		return isRootKill
			? success(command.id, command.type)
			: success(command.id, command.type, { alreadyTerminal: true });
	}

	private requireAvailableWorkerClient(worker: ResidentWorker, allowStopping = false): DaemonWorkerClient {
		const client = worker.client;
		if (!client || worker.descriptor.lifecycle !== "ready" || (!allowStopping && this.isWorkerStopping(worker))) {
			throw new Error(`Session worker is ${this.effectiveWorkerState(worker)}`);
		}
		if (!client.isConnected) {
			// Registration and transport disagree: `close()`/`destroy()` and the
			// `'close'` event that clears `worker.client` are separated by an async
			// gap, and a bookkeeping-only check would hand back a client that cannot
			// write. Saying "not connected" keeps the caller on the paths that treat
			// it as a transient state (a delivery requeues) instead of letting the
			// transport error surface as "the request may already have been
			// delivered" for bytes that were never written.
			throw new Error("Session worker is not connected");
		}
		return client;
	}

	private async issuePeerTransport(
		worker: ResidentWorker,
		summary: SessionSummary,
	): Promise<DaemonPeerTransportTicket> {
		await this.assertCurrentOwnership();
		if (!worker.peerTransportCapable) {
			throw new Error("Session worker does not support direct peer transport");
		}
		await this.refreshWorkerSummaries(worker);
		const workerClient = this.requireAvailableWorkerClient(worker);
		const activeSessionId = summary.activeSessionId ?? summary.id;
		const currentSummary = this.findSummaryInWorker(worker, activeSessionId);
		if (!currentSummary) {
			throw new Error("Direct transport target changed during admission");
		}
		const workerInstanceId = worker.descriptor.workerInstanceId;
		const workerProcessStartId = worker.descriptor.processStartId;
		if (!workerInstanceId || !workerProcessStartId) {
			throw new Error("Direct transport requires an exact worker process identity");
		}
		if (this.processIdentity(worker.descriptor.pid, workerProcessStartId) !== "current") {
			throw new Error("Direct transport worker process identity is not current");
		}
		let socketIdentity: DaemonSocketIdentity | undefined;
		try {
			socketIdentity = getDaemonSocketIdentity(worker.descriptor.socketPath);
		} catch {
			socketIdentity = undefined;
		}
		if (!socketIdentity) {
			throw new Error("Direct transport requires an exact worker socket identity");
		}
		const grantId = randomUUID();
		const token = randomBytes(32).toString("base64url");
		const expiresAt = new Date(Date.now() + PEER_TRANSPORT_GRANT_TTL_MS).toISOString();
		const resolvedActiveSessionId = currentSummary.activeSessionId ?? currentSummary.id;
		const registration = await workerClient.requestWorker(
			{
				type: "worker_register_peer_transport",
				grant: {
					grantId,
					token,
					expiresAt,
					purpose: "session_client",
					workerInstanceId,
					activeSessionId: resolvedActiveSessionId,
					issuerGeneration: this.generation,
				},
			},
			3000,
		);
		if (!registration.success) {
			throw deserializeDaemonError(registration);
		}
		return {
			purpose: "session_client",
			socketPath: worker.descriptor.socketPath,
			socketIdentity,
			workerInstanceId,
			activeSessionId: resolvedActiveSessionId,
			grantId,
			token,
			expiresAt,
		};
	}

	private familyCatalogEntry(summary: SessionSummary): AgentFamilyCatalogEntry {
		const depth = summary.rlmDepth ?? (summary.parentSessionPath ? 1 : 0);
		return {
			id: summary.sessionId,
			...(summary.sessionName ? { name: summary.sessionName } : {}),
			depth,
			status: summary.rosterStatus ?? classifySessionRosterStatus(summary),
			...(depth > 0 && summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
			...(depth > 0 && summary.parentSessionPath
				? { parentSessionPath: canonicalSessionPath(summary.parentSessionPath) }
				: {}),
			...(summary.sessionFile ? { sessionPath: canonicalSessionPath(summary.sessionFile) } : {}),
		};
	}

	private agentPeerSummary(summary: SessionSummary): AgentSessionMessageAgentSummary {
		return {
			activeSessionId: summary.activeSessionId ?? summary.id,
			sessionId: summary.sessionId,
			...(summary.sessionName ? { sessionName: summary.sessionName } : {}),
			runtimeKind: summary.runtimeKind ?? "top-level",
			cwd: summary.cwd,
			isStreaming: summary.isStreaming,
			unfinishedActionCount:
				summary.unfinishedActionCount ??
				(summary.sessionActions.active
					? 1 + summary.sessionActions.queuedCount
					: summary.sessionActions.queuedCount),
			...(summary.parentActiveSessionId ? { parentActiveSessionId: summary.parentActiveSessionId } : {}),
			...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
			...(summary.parentSessionPath ? { parentSessionPath: summary.parentSessionPath } : {}),
			...(summary.sessionFile ? { sessionPath: summary.sessionFile } : {}),
			...(summary.rlmDepth !== undefined ? { rlmDepth: summary.rlmDepth } : {}),
			status: summary.rosterStatus ?? classifySessionRosterStatus(summary),
			...(summary.rlmChildId ? { rlmChildId: summary.rlmChildId } : {}),
		};
	}

	private attachedClientCount(summary: SessionSummary, activeSessionId: string): number {
		return (
			(summary.directAttachedClients ?? 0) +
			[...this.clients].filter((client) => client.attachedActiveSessionIds.has(activeSessionId)).length
		);
	}

	private publicSummary(worker: ResidentWorker, summary: SessionSummary): SessionSummary {
		const activeSessionId = summary.activeSessionId ?? summary.id;
		return {
			...summary,
			attachedClients: this.attachedClientCount(summary, activeSessionId),
			workerState: this.effectiveWorkerState(worker),
			workerPid: worker.descriptor.pid,
		};
	}

	private async findWorker(
		selector: string,
		includeWorker?: (worker: ResidentWorker) => boolean,
	): Promise<WorkerMatch> {
		let matches = this.matchWorkers(selector, includeWorker);
		if (matches.length === 0) {
			await Promise.all(
				[...this.workers.values()].map((worker) =>
					this.refreshWorkerSummaries(worker, false, true).catch(() => undefined),
				),
			);
			matches = this.matchWorkers(selector, includeWorker);
		}
		if (matches.length === 1) {
			return matches[0]!;
		}
		if (matches.length > 1) {
			throw new Error(`Ambiguous active session "${selector}"`);
		}
		// Descriptors are the durable half of addressability: an unhydrated root is recovering, not unknown;
		// failed workers stay unknown so clients take the create fallback, which reclaims or retries them.
		const recoveringRoots = (matchesSelector: (worker: ResidentWorker) => boolean) =>
			[...this.workers.values()].filter(
				(worker) =>
					matchesSelector(worker) &&
					(!includeWorker || includeWorker(worker)) &&
					worker.descriptor.lifecycle !== "failed" &&
					this.isWorkerRecoveryCandidate(worker),
			);
		// matchWorkers' addressing rule: exact ids first, unambiguous hex suffixes second.
		const exactRecovering = recoveringRoots(
			(worker) => worker.descriptor.rootActiveSessionId === selector || worker.descriptor.rootSessionId === selector,
		);
		const recoveringMatches =
			exactRecovering.length > 0
				? exactRecovering
				: recoveringRoots(
						(worker) =>
							matchesSessionIdSuffix(worker.descriptor.rootActiveSessionId, selector) ||
							matchesSessionIdSuffix(worker.descriptor.rootSessionId ?? "", selector),
					);
		if (recoveringMatches.length === 1) {
			throw new DaemonSessionRecoveringError(recoveringMatches[0]!.descriptor.rootActiveSessionId);
		}
		// L3: adoption now runs after the socket opens, so a registered worker's
		// sessions can be missing their roster rows for a moment. Report the real,
		// retryable state instead of claiming the session never existed — callers
		// retry a recovering worker, and a "never existed" answer is terminal.
		if (this.adoptionPendingCount > 0 && this.residentWorkerClaimsSelector(selector)) {
			throw new Error("Session worker is recovering");
		}
		throw new Error(`Unknown active session: ${selector}`);
	}

	private findWorkerForClient(client: DaemonSocketClient, selector: string): Promise<WorkerMatch> {
		return this.findWorker(selector, (worker) => this.isWorkerAccessibleToClient(client, worker));
	}

	private isWorkerAccessibleToClient(client: DaemonSocketClient, worker: ResidentWorker): boolean {
		return (
			worker.descriptor.ownerClientId === undefined ||
			worker.descriptor.ownerClientId === this.protocolClientId(client)
		);
	}

	private assertWorkerAccessibleToClient(client: DaemonSocketClient, worker: ResidentWorker, selector: string): void {
		if (!this.isWorkerAccessibleToClient(client, worker)) {
			throw new Error(`Unknown active session: ${selector}`);
		}
	}

	private matchWorkers(selector: string, includeWorker?: (worker: ResidentWorker) => boolean): WorkerMatch[] {
		const exact: WorkerMatch[] = [];
		const suffix: WorkerMatch[] = [];
		for (const entry of this.roster().values()) {
			if (entry.queuedChild) continue;
			const worker = entry.workerId !== undefined ? this.workers.get(entry.workerId) : undefined;
			if (!worker || (includeWorker && !includeWorker(worker))) {
				continue;
			}
			const summary = sessionSummaryFromRosterEntry(entry);
			const activeSessionId = summary.activeSessionId ?? summary.id;
			const match = { worker, summary };
			if (activeSessionId === selector || summary.sessionId === selector || summary.sessionName === selector) {
				exact.push(match);
			} else if (
				matchesSessionIdSuffix(activeSessionId, selector) ||
				matchesSessionIdSuffix(summary.sessionId, selector)
			) {
				suffix.push(match);
			}
		}
		return exact.length > 0 ? exact : suffix;
	}

	private findSummaryInWorker(worker: ResidentWorker, selector: string): SessionSummary | undefined {
		const pathSelector = looksLikeSessionPath(selector) ? canonicalSessionPath(selector) : undefined;
		const summaries = this.workerRosterEntries(worker)
			.filter((entry) => !entry.queuedChild)
			.map(sessionSummaryFromRosterEntry);
		const exact = summaries.find((summary) => {
			const activeSessionId = summary.activeSessionId ?? summary.id;
			return (
				activeSessionId === selector ||
				summary.sessionId === selector ||
				summary.sessionName === selector ||
				(pathSelector !== undefined &&
					summary.sessionFile !== undefined &&
					canonicalSessionPath(summary.sessionFile) === pathSelector)
			);
		});
		if (exact) return exact;
		return summaries.find((summary) => {
			const activeSessionId = summary.activeSessionId ?? summary.id;
			return (
				matchesSessionIdSuffix(activeSessionId, selector) || matchesSessionIdSuffix(summary.sessionId, selector)
			);
		});
	}

	private findWorkerBySessionFile(sessionFile: string, exclude?: ResidentWorker): ResidentWorker | undefined {
		const target = canonicalSessionPath(sessionFile);
		const targetEntry = this.roster().bySessionFile(target);
		const matches = new Set<ResidentWorker>();
		for (const worker of this.workers.values()) {
			if (worker === exclude) continue;
			// The roster is the one live ownership source; the stale pull cache must not resurrect a match.
			const summaryMatches = targetEntry?.workerId === worker.descriptor.workerId;
			const descriptorPath = worker.descriptor.sessionFile
				? canonicalSessionPath(worker.descriptor.sessionFile)
				: undefined;
			const configuredPath = worker.descriptor.createCommand.sessionPath
				? canonicalSessionPath(worker.descriptor.createCommand.sessionPath)
				: undefined;
			if (!summaryMatches && descriptorPath !== target && configuredPath !== target) continue;
			if (descriptorPath && configuredPath && descriptorPath !== configuredPath) {
				throw new Error(`Conflicting resident session paths for worker ${worker.descriptor.workerId}`);
			}
			matches.add(worker);
		}
		if (matches.size > 1) {
			throw new Error(`Ambiguous resident session path "${sessionFile}"`);
		}
		return matches.values().next().value;
	}

	/**
	 * P1-7c: one agent-message delivery, tracked from admission to a terminal
	 * outcome.
	 *
	 * The first dispatch keeps the long budget, because the sender is waiting on
	 * it and hydrating a large transcript is legitimate work (C20 kept the 24h
	 * delivery semantics on purpose); pre-dispatch bounces do not consume that
	 * tier (B5). What changed is the bookkeeping: the
	 * delivery is an entry in the pending-delivery queue instead of an anonymous
	 * mutation holding the update-restart drain latch, so a target that is not
	 * reachable yet requeues and retries until the delivery budget runs out or the
	 * sender disconnects, a target with a full pending set is rejected with an
	 * actionable hint instead of being silently piled onto, and a restart drains
	 * every entry with an explicit receipt to the sender that is still waiting
	 * (B10/F10: nothing evaporates).
	 *
	 * A retry only ever follows a failure that `requireAvailableWorkerClient`
	 * threw before anything was written to a worker, so this loop cannot deliver
	 * the same message twice.
	 *
	 * KNOWN WINDOW, owned by batch 2 (P1-2 idempotency key): the sender's own
	 * budget is ~30s (daemon-mode.ts `sendRemoteAgentSessionMessage`) while this
	 * loop may keep going for the whole delivery budget. A sender that times out
	 * gets an error, not a receipt, and closes its connection, which abandons the
	 * entry — but a dispatch already written to a worker can still land later, so a
	 * model that re-sends on that error can produce a duplicate. Nothing in this
	 * file can close that: it needs a sender-supplied delivery key the target
	 * dedupes on. Until P1-2 lands, this is an open duplicate-delivery window and
	 * is registered as an acceptance dependency on batch 2 (see build_T4 §7):
	 * after P1-2 ships, re-send-on-timeout must be proven not to duplicate.
	 */
	private async deliverAgentMessage(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "send_message" }>,
		source: WorkerMatch,
		target: WorkerMatch,
		targetActiveSessionId: string,
	): Promise<DaemonResponse> {
		const senderKey = source.summary.activeSessionId ?? source.summary.id;
		// K3L-1: the target worker cannot resolve the sender's session state (it
		// lives in this worker), so the relationship is computed here and forwarded;
		// without it the worker-side send reported no relationship and model-sourced
		// directions (child, sibling) slipped past every direction gate downstream.
		const fromRelationship = agentFamilyRelationship(
			this.familyCatalogEntry(target.summary),
			this.familyCatalogEntry(source.summary),
		);
		const payload: DaemonWorkerCommandBody = {
			type: "worker_deliver_message",
			targetActiveSessionId,
			message: command.message,
			...(fromRelationship ? { fromRelationship } : {}),
			sender: {
				activeSessionId: senderKey,
				sessionId: source.summary.sessionId,
				...(source.summary.sessionName ? { sessionName: source.summary.sessionName } : {}),
				runtimeKind: source.summary.runtimeKind ?? "top-level",
				clientId: client.id,
			},
		};
		const queue = this.pendingDeliveryQueue();
		// Keyed on the connection id, not client.id, which the command envelope reassigns.
		const senderConnectionId = this.connectionIds.get(client) ?? client.id;
		const admitted = queue.admit(targetActiveSessionId, senderKey, senderConnectionId);
		if (!admitted.ok) {
			// L6: a full pending set is a retryable rejection, never a fake "queued".
			this.logInfo(
				`deliver queue overflow for ${targetActiveSessionId}: ${admitted.queueDepth}/${admitted.capacity} pending, rejected a delivery from ${senderKey}`,
			);
			throw new PendingDeliveryCapacityError(
				targetActiveSessionId,
				admitted.queueDepth,
				admitted.capacity,
				PENDING_DELIVERY_CAPACITY_RETRY_AFTER_MS,
			);
		}
		const entry = admitted.entry;
		/**
		 * Delivery requests whose bytes reached a worker's socket. From the first
		 * one, non-delivery is not provable: the target may have accepted the
		 * message and only the answer was lost. Every receipt and log line below
		 * has to keep those two states apart, or the sender re-sends a message that
		 * already landed — and, just as badly, or the sender is told not to re-send
		 * one that provably never left. This count — not `entry.attempts`, which
		 * also ticks on every pre-dispatch bounce, and not the supervisor's own
		 * attempt loop, which also ticks when the transport was already gone —
		 * picks the dispatch timeout tier, so an unreachable target that bounces
		 * for an hour still gets the long budget on the first request that
		 * actually reaches a worker (B5).
		 */
		const dispatched = new DeliveryDispatchCounter();
		/**
		 * F3: when this delivery first found no registered worker for its target.
		 * A recovery relaunch deletes the registration for the seconds its stop
		 * takes and then re-registers the same worker object, so one observation is
		 * not a verdict; a stop that really took the tree down (eviction, kill,
		 * reaper, owner cleanup) never brings this active session id back.
		 */
		let targetGoneSince: number | undefined;
		const targetGoneGraceMs = this.pendingDeliveryTargetGoneGraceMs ?? DELIVERY_TARGET_GONE_GRACE_MS;
		try {
			for (;;) {
				const remainingMs = entry.deadlineAt - Date.now();
				if (remainingMs <= 0) {
					throw new Error(
						`Agent message delivery to ${targetActiveSessionId} was abandoned after ${entry.attempts} attempt(s): the delivery budget ran out`,
					);
				}
				entry.attempts++;
				const targetWorker = this.deliveryTargetWorker(target, targetActiveSessionId);
				if (targetWorker === undefined) {
					targetGoneSince ??= Date.now();
					if (Date.now() - targetGoneSince >= targetGoneGraceMs) {
						throw new Error(
							`Agent message to ${targetActiveSessionId} was not delivered: its session worker is gone (stopped, evicted or reaped), so no retry can reach it. Send it again to a live session.`,
						);
					}
					await this.requeuePendingDelivery(
						queue,
						entry,
						targetActiveSessionId,
						new Error("Session worker registration is gone"),
					);
					continue;
				}
				targetGoneSince = undefined;
				let workerClient: DaemonWorkerClient;
				try {
					workerClient = this.requireAvailableWorkerClient(targetWorker);
				} catch (error) {
					if (!isExpectedWorkerAvailabilityError(error)) throw error;
					await this.requeuePendingDelivery(queue, entry, targetActiveSessionId, error);
					continue;
				}
				const tierMs = WORKER_REQUEST_TIMEOUT_TIERS[deliveryDispatchTimeoutTier(dispatched.dispatches)];
				const timeoutMs = Math.max(1, Math.min(tierMs, remainingMs));
				let response: DaemonResponse;
				try {
					response = await this.raceDeliveryAbort(
						entry,
						workerClient.requestWorker(payload, timeoutMs, dispatched.hooks),
					);
				} catch (error) {
					if (!(error instanceof DaemonWorkerNotConnectedError)) throw error;
					// The transport was gone before the frame was encoded, so nothing was
					// written: another pre-dispatch bounce, which requeues and keeps the
					// honest "was not delivered" verdict available to the sender.
					await this.requeuePendingDelivery(queue, entry, targetActiveSessionId, error);
					continue;
				}
				queue.complete(entry);
				return { ...response, id: command.id, command: command.type };
			}
		} catch (error) {
			queue.drop(entry);
			if (error instanceof PendingDeliveryAbortedError) {
				const reason = error.reason.replaceAll("_", " ");
				const state = dispatched.mayHaveBeenDelivered ? "uncertain" : "undelivered";
				this.log(
					`deliver message dropped for ${targetActiveSessionId} (delivery ${entry.deliveryId}, attempts ${entry.attempts}, state ${state}): ${error.message}`,
				);
				throw new Error(
					dispatched.mayHaveBeenDelivered
						? `Agent message to ${targetActiveSessionId} may already have been delivered: the daemon stopped waiting for the target's answer (${reason}). Do not re-send it blindly; ask the target session whether it arrived, or re-send only if a duplicate would be harmless.`
						: `Agent message to ${targetActiveSessionId} was not delivered: the daemon stopped the pending delivery before it reached the target (${reason}). Send it again once the daemon is back.`,
				);
			}
			if (dispatched.mayHaveBeenDelivered) {
				// F2: from the first dispatch on, non-delivery is not provable — the
				// target may have taken the message and only the answer was lost when
				// its worker stopped, crashed or ran out of its tier. Report the same
				// uncertain state the drain reports instead of handing the sender a
				// transport error it will read as "never arrived" and re-send.
				const detail = error instanceof Error ? error.message : String(error);
				this.log(
					`deliver message uncertain for ${targetActiveSessionId} (delivery ${entry.deliveryId}, attempts ${entry.attempts}, state uncertain, written ${dispatched.written}/${dispatched.dispatches}): ${detail}`,
				);
				throw new Error(
					`Agent message to ${targetActiveSessionId} may already have been delivered: the target's answer was lost (${detail}). Do not re-send it blindly; ask the target session whether it arrived, or re-send only if a duplicate would be harmless.`,
				);
			}
			throw error;
		}
	}

	/**
	 * Counts one pre-dispatch bounce and waits out the retry interval. The wait is
	 * raced against the entry's abort, so a drain never has to wait on a sleeping
	 * retry, and the log stays throttled to one line per target per window: a full
	 * queue retrying every 5s would otherwise write 20 lines a second. The swallowed
	 * count rides on the next line, and counters.requeued stays exact.
	 */
	private async requeuePendingDelivery(
		queue: PendingDeliveryQueue,
		entry: PendingDeliveryEntry,
		targetActiveSessionId: string,
		error: unknown,
	): Promise<void> {
		queue.requeue(entry);
		const requeueLog = queue.noteRequeueForLog(targetActiveSessionId);
		if (requeueLog.emit) {
			const retryIntervalMs = this.pendingDeliveryRetryIntervalMs ?? PENDING_DELIVERY_RETRY_INTERVAL_MS;
			this.logInfo(
				`deliver message requeued for ${targetActiveSessionId} (delivery ${entry.deliveryId}, attempt ${entry.attempts}, depth ${queue.depth(targetActiveSessionId)}, retry in ${retryIntervalMs}ms): ${
					error instanceof Error ? error.message : String(error)
				}${
					requeueLog.suppressed > 0
						? ` (+${requeueLog.suppressed} suppressed in the last ${queue.requeueLogWindowMs}ms)`
						: ""
				}`,
			);
		}
		await this.raceDeliveryAbort(
			entry,
			unrefDelay(this.pendingDeliveryRetryIntervalMs ?? PENDING_DELIVERY_RETRY_INTERVAL_MS),
		);
	}

	/**
	 * A retried delivery re-resolves the target: the roster may have moved it to a
	 * replacement worker. `undefined` means no registered worker owns it any more
	 * (F3) — the loop must not keep bouncing on the stale object it was admitted
	 * with, whose recorded stop intent reports "stopping" forever.
	 */
	private deliveryTargetWorker(fallback: WorkerMatch, targetActiveSessionId: string): ResidentWorker | undefined {
		const rosterEntry = this.roster().byActiveSessionId(targetActiveSessionId);
		const current = rosterEntry?.workerId !== undefined ? this.workers.get(rosterEntry.workerId) : undefined;
		const resolved = current ?? fallback.worker;
		return this.workers.get(resolved.descriptor.workerId) === resolved ? resolved : undefined;
	}

	/** Races the work against the queue's drain abort, so a restart answers every waiting sender. */
	private async raceDeliveryAbort<T>(entry: PendingDeliveryEntry, work: Promise<T>): Promise<T> {
		// Subscribe/unsubscribe, not `entry.aborted.then(...)`: this runs once per
		// bounce iteration and the abort promise stays pending for the whole
		// delivery budget, so chained reactions would accumulate without bound
		// while a target is down.
		return await new Promise<T>((resolve, reject) => {
			let settled = false;
			const unsubscribe = entry.onAbort((reason) => {
				if (settled) return;
				settled = true;
				reject(new PendingDeliveryAbortedError(entry.deliveryId, reason));
			});
			// Both outcomes are handled here, so the loser of the race has no reader
			// left and an abandoned worker request cannot become an unhandled
			// rejection.
			void work.then(
				(value) => {
					if (settled) return;
					settled = true;
					unsubscribe();
					resolve(value);
				},
				(error: unknown) => {
					if (settled) return;
					settled = true;
					unsubscribe();
					reject(error);
				},
			);
		});
	}

	/**
	 * B10: a restart never leaves a delivery sitting in memory. Every entry is
	 * aborted, which hands each sender still waiting an explicit terminal receipt;
	 * the ones nobody waits for any more are logged as dropped and counted.
	 */
	/** Created on first use: a supervisor that never relays an agent message never allocates one. */
	private pendingDeliveryQueue(): PendingDeliveryQueue {
		if (!this.pendingDeliveries) {
			this.pendingDeliveries = new PendingDeliveryQueue({
				...(this.pendingDeliveryCapacity === undefined ? {} : { capacity: this.pendingDeliveryCapacity }),
				...(this.pendingDeliveryLogThrottleMs === undefined
					? {}
					: { requeueLogThrottleMs: this.pendingDeliveryLogThrottleMs }),
			});
		}
		return this.pendingDeliveries;
	}

	private drainPendingDeliveries(reason: PendingDeliveryAbortReason): void {
		const drained = this.pendingDeliveryQueue().drain(reason);
		if (drained.length === 0) {
			return;
		}
		this.log(
			`drained ${drained.length} pending agent-message ${drained.length === 1 ? "delivery" : "deliveries"} (${reason.replaceAll("_", " ")}): ${drained
				.map((entry) => `${entry.deliveryId}->${entry.targetActiveSessionId}`)
				.join(", ")}`,
		);
	}

	/**
	 * A disconnected sender cannot read a receipt any more, and its entries would
	 * hold the target's capacity for the rest of their delivery budget: a sender
	 * waits seconds (an agent-to-agent send gives up after 30s) while the budget is
	 * 24h, so one unreachable target orphans a slot per abandoned send until it
	 * rejects the senders that are still there.
	 */
	private abortPendingDeliveriesForSender(client: DaemonSocketClient): void {
		// The field, not pendingDeliveryQueue(): a supervisor that never relayed an
		// agent message must not allocate a queue for a client that leaves.
		const queue = this.pendingDeliveries;
		if (!queue) {
			return;
		}
		const senderConnectionId = this.connectionIds.get(client) ?? client.id;
		const abandoned = queue.abortSender(senderConnectionId, "sender_disconnected");
		if (abandoned.length === 0) {
			return;
		}
		this.log(
			`abandoned ${abandoned.length} pending agent-message ${abandoned.length === 1 ? "delivery" : "deliveries"} of disconnected sender ${senderConnectionId}: ${abandoned
				.map((entry) => `${entry.deliveryId}->${entry.targetActiveSessionId}`)
				.join(", ")}`,
		);
	}

	/** The active session ids this worker's registration currently claims, root included. */
	private workerActiveSessionIds(worker: ResidentWorker): string[] {
		const ids = new Set<string>([worker.descriptor.rootActiveSessionId]);
		for (const entry of this.workerRosterEntries(worker)) {
			if (entry.queuedChild) continue;
			ids.add(entry.summary.activeSessionId ?? entry.summary.id);
		}
		return [...ids];
	}

	/**
	 * F2: whether the supervisor owns a delivery aimed at one of this worker's
	 * sessions. An in-flight delivery is work the worker has not reported yet — the
	 * message updates activity and messageCount only once it lands — so the roster a
	 * residency decision reads still calls the tree idle. `send_message` no longer
	 * holds the mutation drain latch (P1-7c), so the eviction fence's drain does not
	 * cover it either: without this check a stop can overtake a delivery.
	 */
	private workerHasPendingDeliveries(worker: ResidentWorker): boolean {
		// The field, not pendingDeliveryQueue(): a residency decision must not allocate one.
		return this.pendingDeliveries?.hasEntriesForTargets(this.workerActiveSessionIds(worker)) === true;
	}

	/**
	 * F2/B10: a stop must not turn an in-flight delivery into a bare transport
	 * error. Every entry aimed at this worker is aborted before its socket closes,
	 * so each sender still waiting gets the explicit receipt the queue promises —
	 * "not delivered" while nothing was written to a worker, "may already have been
	 * delivered" once a dispatch is out — and the ones nobody waits for any more are
	 * logged here instead of vanishing with the connection.
	 */
	private drainPendingDeliveriesForWorker(worker: ResidentWorker, reason: PendingDeliveryAbortReason): void {
		// The field, not pendingDeliveryQueue(): a stop must not allocate a queue.
		const queue = this.pendingDeliveries;
		if (!queue) {
			return;
		}
		const drained = queue.drainTargets(this.workerActiveSessionIds(worker), reason);
		if (drained.length === 0) {
			return;
		}
		this.log(
			`drained ${drained.length} pending agent-message ${
				drained.length === 1 ? "delivery" : "deliveries"
			} of stopping worker ${worker.descriptor.workerId} (${reason.replaceAll("_", " ")}): ${drained
				.map((entry) => `${entry.deliveryId}->${entry.targetActiveSessionId}`)
				.join(", ")}`,
		);
	}

	private async forwardToWorker(
		worker: ResidentWorker,
		command: DaemonCommand,
		timeoutMs = workerRequestTimeoutMs(command.type),
	): Promise<DaemonResponse> {
		// Every forwarded command is a touch: a cached failed roster row must not outrank
		// the descriptor truth that the worker is recoverable (--attach-agent's get_state preflight lands here).
		if (this.canRetryFailedWorker(worker)) {
			await this.retryWorkerRecovery(worker);
		} else if (worker.recovery) {
			// Join a concurrent touch's in-flight recovery instead of throwing mid-ladder.
			await worker.recovery;
		}
		const client = this.requireAvailableWorkerClient(worker, command.type === "kill");
		let response: DaemonResponse;
		try {
			response = await client.request(withoutCommandId(command), timeoutMs);
		} catch (error) {
			if (error instanceof DaemonWorkerProbeTimeoutError) {
				// Countable signature (appendix B): which command ran out of which tier.
				this.logInfo(
					`worker request timed out after ${timeoutMs}ms (tier ${workerRequestTimeoutTier(command.type)}) for ${command.type} on ${worker.descriptor.workerId}`,
				);
			}
			throw error;
		}
		if (command.type === "get_state" && response.success && isSessionSummary(response.data)) {
			return { ...response, id: command.id, data: this.publicSummary(worker, response.data) };
		}
		if (command.type === "rename" && response.success && isSessionSummary(response.data)) {
			this.writeRosterEntry(workerRosterEntryFromSummary(response.data), worker);
			return { ...response, id: command.id, data: this.publicSummary(worker, response.data) };
		}
		return responseWithId(response, command.id);
	}

	private async attachClient(
		client: DaemonSocketClient,
		command: Extract<DaemonCommand, { type: "attach" }>,
	): Promise<WorkerAttachData> {
		const descriptorWorker = [...this.workers.values()].find(
			(worker) =>
				worker.descriptor.rootActiveSessionId === command.activeSessionId ||
				worker.descriptor.rootSessionId === command.activeSessionId,
		);
		if (descriptorWorker) {
			// The descriptor lookup is universal; owner-only attach payload stays in the owned branch.
			if (descriptorWorker.descriptor.ownerClientId !== undefined) {
				if (descriptorWorker.descriptor.ownerClientId !== this.protocolClientId(client)) {
					throw new Error(`Unknown active session: ${command.activeSessionId}`);
				}
				this.assertTelemetryAttachAllowed(descriptorWorker, command.telemetryDisabled);
				descriptorWorker.launchEnv = command.launchEnv ?? descriptorWorker.launchEnv;
				if (!descriptorWorker.client || descriptorWorker.descriptor.lifecycle !== "ready") {
					if (command.recoveryConfig) {
						descriptorWorker.transientCreateCommand = {
							...descriptorWorker.descriptor.createCommand,
							config: {
								...command.recoveryConfig,
								...(descriptorWorker.descriptor.telemetryDisabled === true ? { telemetryDisabled: true } : {}),
							},
							env: command.env,
							launchEnv: command.launchEnv,
							lifecycle: "client_owned",
						};
					}
					if (!descriptorWorker.launchEnv) {
						throw new Error("Client-owned session recovery requires the owning client environment");
					}
					await this.retryWorkerRecovery(descriptorWorker);
				}
			} else if (this.canRetryFailedWorker(descriptorWorker)) {
				await this.retryWorkerRecovery(descriptorWorker);
			}
		}
		const match = await this.findWorkerForClient(client, command.activeSessionId);
		this.assertTelemetryAttachAllowed(match.worker, command.telemetryDisabled);
		if (match.worker !== descriptorWorker && this.canRetryFailedWorker(match.worker)) {
			// Child-session attaches land here without a descriptor match; one touch runs at most one ladder.
			await this.retryWorkerRecovery(match.worker);
		}
		this.requireAvailableWorkerClient(match.worker);
		const activeSessionId = match.summary.activeSessionId ?? match.summary.id;
		const duplicateValidation = this.currentSnapshotGeneration(match.worker, activeSessionId)?.validation;
		if (duplicateValidation) {
			await duplicateValidation.promise;
		}
		if (command.clientId) {
			client.id = command.clientId;
		}
		client.capabilities = normalizeCapabilities(command.capabilities, command.supportsExtensionUi);
		client.supportsExtensionUi = client.capabilities.has("extension_ui");

		// The worker's chunk transfer is the one encoding of a transcript: every load asks
		// for it, and a client that cannot consume the chunks is served by decoding the
		// cached bytes. That replaced a second full serialization of the same messages in
		// the supervisor, and a second full snapshot load from the worker for every legacy
		// attach that followed a chunked one.
		const wantsChunkedSnapshot = client.capabilities.has("chunked_snapshot");
		let result = match.worker.snapshotCache.get(activeSessionId);
		if (result && !wantsChunkedSnapshot) {
			result = await this.snapshotWithDecodedTranscript(match.worker, activeSessionId, result);
		}
		if (!result) {
			result = await this.loadWorkerSnapshot(match.worker, activeSessionId, command.env, true);
			if (!wantsChunkedSnapshot) {
				const decoded = await this.snapshotWithDecodedTranscript(match.worker, activeSessionId, result);
				if (decoded) {
					result = decoded;
				} else if (
					result.snapshotStream &&
					result.snapshot.messages.length < result.snapshot.summary.messageCount
				) {
					// The worker promised a chunk transfer this client cannot read and there is
					// nothing decodable behind it (failed, disposed, or superseded). Ask for the
					// full snapshot shape instead of handing over an empty transcript. A worker
					// that never promised a transfer is trusted as-is, exactly as before.
					result = await this.loadWorkerSnapshot(match.worker, activeSessionId, command.env, false);
				}
			}
		}
		this.requireAvailableWorkerClient(match.worker);
		const wasAttached = client.attachedActiveSessionIds.has(activeSessionId);
		let transcript: SnapshotTranscriptCache | undefined;
		if (wantsChunkedSnapshot) {
			while (true) {
				const validation = this.currentSnapshotGeneration(match.worker, activeSessionId)?.validation;
				if (validation) {
					await validation.promise;
					continue;
				}
				result = match.worker.snapshotCache.get(activeSessionId) ?? result;
				transcript = this.getOrCreateTranscriptCache(match.worker, result);
				break;
			}
		}
		const releaseTranscript = transcript?.retain();
		client.attachedActiveSessionIds.add(activeSessionId);
		try {
			const publicSummary = this.publicSummary(match.worker, result.snapshot.summary);
			if (publicSummary.streamingMessage?.role === "assistant") {
				// Seed only when a stream is actually in progress and the shared
				// reconstructor is not already tracking a live partial: a mid-stream
				// attach must not rewind the reconstruction other clients rely on.
				if (!this.streamReconstructor.hasPartial(activeSessionId)) {
					this.streamReconstructor.seed(activeSessionId, publicSummary.streamingMessage);
				}
			} else if (!publicSummary.isStreaming) {
				// Idle: there is no stream to reconstruct. Drop any stale partial so a
				// later delta cannot be applied onto a historical message.
				this.streamReconstructor.clear(activeSessionId);
			}
			const publicResult: DaemonAttachResult = {
				...result,
				state: result.state ? publicSummary : undefined,
				snapshot: { ...result.snapshot, summary: publicSummary },
				client: { id: client.id, capabilities: [...client.capabilities] },
			};
			if (publicResult.state && publicResult.messages) {
				this.write(client, {
					type: "session_attached",
					activeSessionId,
					state: publicResult.state,
					messages: publicResult.messages,
					snapshot: publicResult.snapshot,
					replay: publicResult.replay,
					lastEventSequence: publicResult.lastEventSequence,
				});
			}
			this.background(this.syncWorkerExtensionUi(activeSessionId), "extension UI sync on attach");
			const detachingSessions = this.detachingInputPauseSessions?.get(client);
			detachingSessions?.delete(command.activeSessionId);
			detachingSessions?.delete(activeSessionId);
			return { result: publicResult, worker: match.worker, transcript, releaseTranscript };
		} catch (error) {
			releaseTranscript?.();
			if (!wasAttached) {
				client.attachedActiveSessionIds.delete(activeSessionId);
			}
			throw error;
		}
	}

	private assertTelemetryAttachAllowed(worker: ResidentWorker, telemetryDisabled: true | undefined): void {
		if (telemetryDisabled && worker.descriptor.telemetryDisabled !== true) {
			throw new Error(
				"Cannot attach to this active agent while telemetry is disabled for the current invocation. Stop the agent and retry so it can restart without telemetry.",
			);
		}
	}

	/**
	 * One snapshot load from the worker, deduplicated per worker, session and shape.
	 *
	 * The chunked shape is what every client asks for now: the worker encodes the
	 * transcript once and the supervisor caches those bytes, so a later chunked attach
	 * forwards them and a legacy attach decodes them. The full shape survives only as
	 * the fallback for a worker that answered without a chunk transfer.
	 */
	private async loadWorkerSnapshot(
		worker: ResidentWorker,
		activeSessionId: string,
		env: Record<string, string> | undefined,
		chunked: boolean,
	): Promise<DaemonAttachResult> {
		const snapshotLoadKey = `${activeSessionId}:${chunked ? "chunked" : "full"}`;
		let result: DaemonAttachResult | undefined;
		let retryInvalidatedLoad = true;
		while (!result) {
			let loading = worker.snapshotLoads.get(snapshotLoadKey);
			if (!loading) {
				const observedSnapshotId =
					worker.transcriptCaches.get(activeSessionId)?.snapshotId ??
					worker.snapshotCache.get(activeSessionId)?.snapshotStream?.id;
				loading = (async () => {
					const workerClient = this.requireAvailableWorkerClient(worker);
					const response = await workerClient.request({
						type: "attach",
						activeSessionId,
						capabilities: chunked
							? ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"]
							: ["attach_snapshot", "event_sequence", "slim_attach"],
						supportsExtensionUi: false,
						env: env ?? collectDaemonClientEnv(),
					});
					const loaded = attachResultFromResponse(response);
					if (worker.snapshotLoads.get(snapshotLoadKey) !== loading) {
						throw new SnapshotLoadInvalidatedError("Session snapshot changed during attach");
					}
					return this.cacheLoadedSnapshot(worker, activeSessionId, loaded, observedSnapshotId);
				})();
				worker.snapshotLoads.set(snapshotLoadKey, loading);
				void loading.then(
					async (loaded) => {
						try {
							const snapshotId = loaded.snapshotStream?.id;
							const transcript = snapshotId
								? this.snapshotGeneration(worker, loaded.activeSessionId, snapshotId)?.transcript
								: undefined;
							if (transcript && !(await this.waitForSnapshotTransfer(transcript))) {
								this.log(`Snapshot transfer ${snapshotId} did not complete; a later attach reloads it`);
							}
						} catch {
							// Failed transfers must allow a fresh snapshot request.
						} finally {
							if (worker.snapshotLoads.get(snapshotLoadKey) === loading) {
								worker.snapshotLoads.delete(snapshotLoadKey);
							}
						}
					},
					() => {
						if (worker.snapshotLoads.get(snapshotLoadKey) === loading) {
							worker.snapshotLoads.delete(snapshotLoadKey);
						}
					},
				);
			}
			try {
				result = await loading;
			} catch (error) {
				if (!(error instanceof SnapshotLoadInvalidatedError)) {
					throw error;
				}
				if (!retryInvalidatedLoad) {
					throw error;
				}
				retryInvalidatedLoad = false;
			}
		}
		return result;
	}

	/**
	 * Full-message view of a cached snapshot, for a client that cannot consume the chunk
	 * transfer itself. The worker's encoded chunks are the only serialization of this
	 * transcript generation, so decoding them is what keeps a legacy attach from paying
	 * for a second one. `undefined` means there is nothing complete to decode, and the
	 * caller falls back to the full snapshot shape.
	 *
	 * The returned result carries no `snapshotStream`: the supervisor never streams chunks
	 * to a client that did not declare `chunked_snapshot`, and an id with no transfer
	 * behind it would leave such a client waiting for frames that are not coming.
	 */
	private async snapshotWithDecodedTranscript(
		worker: ResidentWorker,
		activeSessionId: string,
		result: DaemonAttachResult,
	): Promise<DaemonAttachResult | undefined> {
		const { snapshotStream: _snapshotStream, ...rest } = result;
		const messageCount = result.snapshot.summary.messageCount;
		if (result.snapshot.messages.length >= messageCount) {
			return rest;
		}
		const snapshotId = result.snapshotStream?.id;
		if (!snapshotId) {
			return undefined;
		}
		const cached = worker.transcriptCaches.get(activeSessionId);
		const transcript =
			this.snapshotGeneration(worker, activeSessionId, snapshotId)?.transcript ??
			(cached?.snapshotId === snapshotId ? cached : undefined);
		if (!transcript) {
			return undefined;
		}
		let releaseTranscript: () => void;
		try {
			releaseTranscript = transcript.retain();
		} catch {
			// Disposed between the cache read and here: reload instead of decoding a corpse.
			return undefined;
		}
		try {
			if (!(await this.waitForSnapshotTransfer(transcript))) {
				return undefined;
			}
			const messages = transcript.decodeMessages(messageCount);
			if (!messages) {
				return undefined;
			}
			return { ...rest, snapshot: { ...result.snapshot, messages } };
		} finally {
			releaseTranscript();
		}
	}

	/**
	 * Waits for a worker chunk transfer to finish so its bytes can be read.
	 *
	 * The budget is the one the equivalent full snapshot load already has: `attach` keeps
	 * the long worker-request tier precisely because it carries the transcript. A transfer
	 * that neither completes nor fails within it leaves the caller on the full-load
	 * fallback instead of parking a client command on a silent worker.
	 */
	private async waitForSnapshotTransfer(
		transcript: SnapshotTranscriptCache,
		timeoutMs: number = workerRequestTimeoutMs("attach"),
	): Promise<boolean> {
		if (transcript.complete) {
			return true;
		}
		let timer: NodeJS.Timeout | undefined;
		const drained = (async () => {
			let chunkIndex = 0;
			while (await transcript.waitForChunk(chunkIndex)) {
				chunkIndex++;
			}
			return true;
		})().catch(() => false);
		const timedOut = new Promise<boolean>((resolveTimeout) => {
			timer = setTimeout(() => resolveTimeout(false), timeoutMs);
			timer.unref?.();
		});
		try {
			return await Promise.race([drained, timedOut]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}

	private cacheLoadedSnapshot(
		worker: ResidentWorker,
		activeSessionId: string,
		loaded: DaemonAttachResult,
		observedSnapshotId: string | undefined,
	): DaemonAttachResult {
		const currentTranscript = worker.transcriptCaches.get(activeSessionId);
		const currentGeneration = this.currentSnapshotGeneration(worker, activeSessionId);
		const currentResult = currentGeneration?.result ?? worker.snapshotCache.get(activeSessionId);
		const currentSnapshotId = currentTranscript?.snapshotId ?? currentResult?.snapshotStream?.id;
		const loadedSnapshotId = loaded.snapshotStream?.id;
		if (!loaded.snapshotStream) {
			if (currentSnapshotId && currentSnapshotId !== observedSnapshotId) {
				return loaded;
			}
			worker.snapshotCache.set(activeSessionId, loaded);
			return loaded;
		}
		if (
			currentSnapshotId &&
			currentSnapshotId !== loadedSnapshotId &&
			(currentSnapshotId !== observedSnapshotId ||
				(currentResult?.lastEventSequence ?? -1) > loaded.lastEventSequence)
		) {
			return currentResult ?? loaded;
		}
		let transcript = currentTranscript;
		if (transcript && transcript.snapshotId !== loaded.snapshotStream.id) {
			this.retireWorkerSnapshotCache(worker, activeSessionId, transcript);
			transcript = undefined;
		}
		const generations = this.snapshotGenerationsFor(worker, activeSessionId);
		let generation = generations.get(loaded.snapshotStream.id);
		if (!transcript) {
			transcript = generation?.transcript;
		}
		if (!transcript) {
			transcript = new SnapshotTranscriptCache({
				activeSessionId,
				snapshotId: loaded.snapshotStream.id,
				cacheRoot: this.snapshotCacheRoot,
				targetChunkBytes: loaded.snapshotStream.targetChunkBytes,
			});
		}
		if (!generation) {
			generation = {
				transcript,
				result: loaded,
				incoming: false,
				retired: false,
			};
			generations.set(loaded.snapshotStream.id, generation);
		} else {
			generation.result = loaded;
			generation.retired = false;
		}
		worker.transcriptCaches.set(activeSessionId, transcript);
		worker.snapshotCache.set(activeSessionId, loaded);
		return loaded;
	}

	private getOrCreateTranscriptCache(worker: ResidentWorker, result: DaemonAttachResult): SnapshotTranscriptCache {
		const activeSessionId = result.activeSessionId;
		const existing = worker.transcriptCaches.get(activeSessionId);
		if (existing && (!result.snapshotStream || existing.snapshotId === result.snapshotStream.id)) {
			return existing;
		}
		if (result.snapshot.messages.length < result.snapshot.summary.messageCount) {
			throw new Error("Session snapshot generation changed before its transcript could be selected");
		}
		if (existing) {
			this.retireWorkerSnapshotCache(worker, activeSessionId, existing);
		}
		const revision = createHash("sha256")
			.update(
				`${activeSessionId}:${result.snapshot.summary.sessionId}:${result.lastEventSequence}:${result.snapshot.messages.length}`,
			)
			.digest("hex")
			.slice(0, 16);
		const transcript = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId: `${activeSessionId}-${revision}`,
			messages: result.snapshot.messages,
			cacheRoot: this.snapshotCacheRoot,
			targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
		});
		worker.transcriptCaches.set(activeSessionId, transcript);
		const cachedResult = {
			...result,
			messages: result.messages ? [] : undefined,
			snapshot: { ...result.snapshot, messages: [] },
		};
		worker.snapshotCache.set(activeSessionId, cachedResult);
		this.snapshotGenerationsFor(worker, activeSessionId).set(transcript.snapshotId, {
			transcript,
			result: cachedResult,
			incoming: false,
			retired: false,
		});
		return transcript;
	}

	private createStreamedAttachResult(
		result: DaemonAttachResult,
		transcript: SnapshotTranscriptCache,
	): DaemonAttachResult {
		return {
			...result,
			messages: result.messages ? [] : undefined,
			snapshot: { ...result.snapshot, messages: [] },
			snapshotStream: {
				id: transcript.snapshotId,
				messageCount: result.snapshot.summary.messageCount,
				targetChunkBytes: transcript.targetChunkBytes,
			},
		};
	}

	private async streamSnapshot(
		client: DaemonSocketClient,
		worker: ResidentWorker,
		result: DaemonAttachResult,
		transcript: SnapshotTranscriptCache,
		purpose: "attach" | "replacement" | "resync" = "attach",
		retainedTranscriptRelease?: () => void,
		releaseSnapshotReservation = this.reserveSnapshotStream(client, result.activeSessionId),
	): Promise<void> {
		const stream = result.snapshotStream;
		const signal = client.snapshotTransferAbortControllers?.get(result.activeSessionId)?.signal;
		if (!stream || client.socket.destroyed || signal?.aborted) {
			releaseSnapshotReservation();
			retainedTranscriptRelease?.();
			this.releaseDeferredSessionPayloads(client, result.activeSessionId, false);
			return;
		}
		const releaseTranscript = retainedTranscriptRelease ?? transcript.retain();
		const { messages: _messages, ...snapshotHeader } = result.snapshot;
		let snapshotDelivered = false;
		try {
			if (
				!(await this.writeSnapshotRecord(
					client,
					{
						type: "session_snapshot_begin",
						activeSessionId: result.activeSessionId,
						snapshotId: stream.id,
						snapshot: snapshotHeader,
						messageCount: stream.messageCount,
						targetChunkBytes: stream.targetChunkBytes,
						purpose,
					},
					signal,
				))
			) {
				return;
			}
			let chunkCount = 0;
			while (true) {
				let chunk: Buffer | undefined;
				try {
					chunk = await transcript.waitForChunk(chunkCount, signal);
				} catch (error) {
					if (signal?.aborted) return;
					const streamError = error instanceof Error ? error : new Error(String(error));
					this.failWorkerSnapshotCache(worker, result.activeSessionId, streamError, false, stream.id);
					throw streamError;
				}
				if (!chunk) {
					break;
				}
				if (!(await this.writeSnapshotBuffer(client, chunk, signal))) {
					return;
				}
				chunkCount++;
			}
			snapshotDelivered = await this.writeSnapshotRecord(
				client,
				{
					type: "session_snapshot_end",
					activeSessionId: result.activeSessionId,
					snapshotId: stream.id,
					chunkCount,
					lastEventSequence: result.lastEventSequence,
					lastEventCursor: result.lastEventCursor,
				},
				signal,
				SNAPSHOT_TERMINAL_DRAIN_TIMEOUT_MS,
			);
		} catch (error) {
			if (signal?.aborted) return;
			const streamError = error instanceof Error ? error : new Error(String(error));
			if (!client.socket.destroyed) {
				try {
					const delivered = await this.writeSnapshotRecord(
						client,
						{
							type: "session_snapshot_failed",
							activeSessionId: result.activeSessionId,
							snapshotId: stream.id,
							error: streamError.message,
						},
						signal,
						SNAPSHOT_TERMINAL_DRAIN_TIMEOUT_MS,
					);
					// #2260: an aborted transfer was replaced by a newer stream that owns
					// this socket; destroying it would tear the replacement mid-flight.
					if (signal?.aborted) return;
					if (!delivered && !client.socket.destroyed) {
						client.socket.destroy(streamError);
					}
				} catch (deliveryError) {
					client.socket.destroy(deliveryError instanceof Error ? deliveryError : new Error(String(deliveryError)));
				}
			}
			throw streamError;
		} finally {
			if (
				!snapshotDelivered &&
				client.attachedActiveSessionIds.has(result.activeSessionId) &&
				client.deferredSessionPayloads?.get(result.activeSessionId)?.payloads.length
			) {
				this.queueCatchup(client, result.activeSessionId, "resync");
			}
			releaseSnapshotReservation();
			releaseTranscript();
			this.releaseDeferredSessionPayloads(client, result.activeSessionId, snapshotDelivered);
		}
	}

	private reserveSnapshotStream(client: DaemonSocketClient, activeSessionId: string): () => void {
		if (!client.snapshotActiveSessionIds?.has(activeSessionId)) {
			client.deferredSessionPayloadsDropped?.delete(activeSessionId);
			client.snapshotTransferAbortControllers ??= new Map();
			client.snapshotTransferAbortControllers.set(activeSessionId, new AbortController());
		}
		client.snapshotStreaming = true;
		client.snapshotActiveSessionIds ??= new Set();
		client.snapshotActiveSessionIds.add(activeSessionId);
		client.snapshotActiveSessionCounts ??= new Map();
		client.snapshotActiveSessionCounts.set(
			activeSessionId,
			(client.snapshotActiveSessionCounts.get(activeSessionId) ?? 0) + 1,
		);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const streamCount = client.snapshotActiveSessionCounts?.get(activeSessionId) ?? 1;
			if (streamCount > 1) {
				client.snapshotActiveSessionCounts?.set(activeSessionId, streamCount - 1);
			} else {
				client.snapshotActiveSessionCounts?.delete(activeSessionId);
				client.snapshotActiveSessionIds?.delete(activeSessionId);
				client.snapshotTransferAbortControllers?.delete(activeSessionId);
			}
			client.snapshotStreaming = (client.snapshotActiveSessionIds?.size ?? 0) > 0;
			if (!client.snapshotStreaming && client.catchupActiveSessionIds?.size) {
				void this.catchUpClient(client).catch((error) =>
					this.log(`Failed to catch up client ${client.id}: ${String(error)}`),
				);
			}
		};
	}

	private writeSnapshotRecord(
		client: DaemonSocketClient,
		message: DaemonOutbound,
		signal?: AbortSignal,
		drainTimeoutMs?: number,
	): Promise<boolean> {
		return this.writeSnapshotBuffer(client, Buffer.from(serializeJsonLine(message)), signal, drainTimeoutMs);
	}

	/**
	 * `signal` (#2260) and `drainTimeoutMs` (fork) are two independent reasons to stop
	 * waiting on a write the socket did not accept, and either may fire first: both
	 * resolve `false`, and `finish` detaches the other's listener and clears its
	 * timer, so a stream never waits twice and never leaks a handler. Callers tell the
	 * two apart afterwards via `signal?.aborted`, never from the return value.
	 *
	 * `drainTimeoutMs` bounds how long a write waits for backpressure to clear. It is
	 * set only for the frames that end a stream: AF_UNIX has no keepalive, so a
	 * client that was suspended (Ctrl-Z, a debugger, a frozen machine) neither
	 * drains nor closes, and an unbounded wait here keeps `streamSnapshot`'s finally
	 * from ever running — the transcript retain and the snapshot reservation leak,
	 * and that client's catch-up queue stays parked behind `snapshotStreaming` for
	 * good. Data chunks deliberately keep waiting: that is backpressure, and cutting
	 * it would drop snapshot bytes. The worker-side twin
	 * (`writeWorkerSnapshotBuffer`, daemon-mode.ts) has taken both parameters, in this
	 * order, since before this merge.
	 */
	private async writeSnapshotBuffer(
		client: DaemonSocketClient,
		buffer: Uint8Array,
		signal?: AbortSignal,
		drainTimeoutMs?: number,
	): Promise<boolean> {
		if (client.socket.destroyed || signal?.aborted) {
			return false;
		}
		if (this.writeSerialized(client, buffer)) {
			return true;
		}
		if (signal?.aborted) return false;
		return new Promise<boolean>((resolveDrain) => {
			let settled = false;
			let drainTimeout: NodeJS.Timeout | undefined;
			const finish = (value: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				client.socket.off("drain", onDrain);
				client.socket.off("close", onClose);
				client.socket.off("error", onClose);
				signal?.removeEventListener("abort", onAbort);
				if (drainTimeout) {
					clearTimeout(drainTimeout);
				}
				resolveDrain(value);
			};
			const onDrain = () => finish(true);
			const onClose = () => finish(false);
			client.socket.once("drain", onDrain);
			client.socket.once("close", onClose);
			client.socket.once("error", onClose);
			const onAbort = () => finish(false);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (drainTimeoutMs !== undefined) {
				drainTimeout = setTimeout(() => finish(false), drainTimeoutMs);
				drainTimeout.unref();
			}
			if (signal?.aborted || client.socket.destroyed) {
				finish(false);
			}
		});
	}

	private detachClient(client: DaemonSocketClient, activeSessionId?: string): void {
		const targets = activeSessionId ? [activeSessionId] : [...client.attachedActiveSessionIds];
		for (const selector of targets) {
			const match = this.matchWorkers(selector)[0];
			const resolvedId = match ? (match.summary.activeSessionId ?? match.summary.id) : selector;
			if (!client.attachedActiveSessionIds.delete(resolvedId)) {
				continue;
			}
			client.catchupActiveSessionIds?.delete(resolvedId);
			client.catchupPurposes?.delete(resolvedId);
			client.deferredSessionPayloadsDropped?.delete(resolvedId);
			this.write(client, { type: "session_detached", activeSessionId: resolvedId });
			this.background(this.syncWorkerExtensionUi(resolvedId), "extension UI sync on detach");
			this.background(this.evictEmptySessionOnLastDetach(resolvedId), "empty session eviction on detach");
		}
	}

	private async syncWorkerExtensionUi(activeSessionId: string): Promise<void> {
		const match = this.matchWorkers(activeSessionId)[0];
		if (!match?.worker.client) {
			return;
		}
		await this.subscribeWorker(match.worker, match.summary.activeSessionId ?? match.summary.id).catch(
			() => undefined,
		);
	}

	private handleWorkerFrame(
		worker: ResidentWorker,
		frame: PrivateFrame<DaemonWorkerFrameHeader>,
		source?: DaemonWorkerClient,
	): void {
		if (frame.header.kind !== "outbound") {
			return;
		}
		if (source !== undefined && source !== worker.client && source !== worker.pendingClient) {
			return;
		}
		worker.lastFrameAt = Date.now();
		this.clearRosterStaleness(worker);
		const {
			outboundType,
			activeSessionId,
			snapshotId: frameSnapshotId,
			sessionEventType,
			payloadEncoding,
			snapshotPurpose,
		} = frame.header;
		if (outboundType === "roster_delta") {
			this.consumeWorkerRosterDelta(worker, frame.payload, source);
			return;
		}
		if (outboundType === "roster_heartbeat") {
			return;
		}
		if (outboundType === "heartbeats_changed") {
			worker.heartbeatSnapshotStale = true;
			this.broadcastHeartbeatsChanged();
			return;
		}
		if (outboundType === "session_snapshot_begin" && activeSessionId) {
			try {
				const begin = JSON.parse(frame.payload.toString("utf8")) as Extract<
					DaemonOutbound,
					{ type: "session_snapshot_begin" }
				>;
				if (
					begin.type !== "session_snapshot_begin" ||
					begin.activeSessionId !== activeSessionId ||
					typeof begin.snapshotId !== "string" ||
					(frameSnapshotId !== undefined && frameSnapshotId !== begin.snapshotId) ||
					typeof begin.targetChunkBytes !== "number" ||
					!begin.snapshot ||
					!isSessionSummary(begin.snapshot.summary)
				) {
					throw new Error("Worker returned an invalid snapshot begin frame");
				}
				const publicSummary = this.publicSummary(worker, begin.snapshot.summary);
				const snapshot = {
					...begin.snapshot,
					summary: publicSummary,
					messages: [],
				};
				const result: DaemonAttachResult = {
					protocol: DAEMON_PROTOCOL_INFO,
					activeSessionId,
					snapshot,
					replay: {
						status: "complete",
						toSequence: snapshot.lastEventSequence,
						...(snapshot.lastEventCursor ? { toCursor: snapshot.lastEventCursor } : {}),
					},
					lastEventSequence: snapshot.lastEventSequence,
					...(snapshot.lastEventCursor ? { lastEventCursor: snapshot.lastEventCursor } : {}),
					snapshotStream: {
						id: begin.snapshotId,
						messageCount: begin.messageCount,
						targetChunkBytes: begin.targetChunkBytes,
					},
					client: { id: "supervisor", capabilities: ["chunked_snapshot"] },
				};
				const generations = this.snapshotGenerationsFor(worker, activeSessionId);
				let generation = generations.get(begin.snapshotId);
				if (generation?.incoming) {
					this.failWorkerSnapshotCache(
						worker,
						activeSessionId,
						new Error(`Snapshot ${begin.snapshotId} restarted before completion`),
						true,
						begin.snapshotId,
					);
					return;
				}
				// Snapshot summaries/state include live fields (for example activity and attached client
				// counts) that can change without advancing the transcript sequence. Treat the stable
				// transfer envelope as identity; duplicate chunks and end metadata are still byte-checked.
				const duplicate =
					generation?.transcript.complete === true &&
					generation.end !== undefined &&
					generation.result.snapshotStream?.messageCount === begin.messageCount &&
					generation.result.snapshotStream?.targetChunkBytes === begin.targetChunkBytes &&
					generation.result.lastEventSequence === result.lastEventSequence &&
					generation.result.snapshot.lastEventSequence === result.snapshot.lastEventSequence &&
					generation.result.snapshot.lastEventCursor?.generation === result.snapshot.lastEventCursor?.generation &&
					generation.result.snapshot.lastEventCursor?.sequence === result.snapshot.lastEventCursor?.sequence;
				if (generation?.transcript.complete && !duplicate) {
					this.failWorkerSnapshotCache(
						worker,
						activeSessionId,
						new Error(`Snapshot ${begin.snapshotId} did not match the cached transfer`),
						true,
						begin.snapshotId,
					);
					return;
				}
				const currentGeneration = this.currentSnapshotGeneration(worker, activeSessionId);
				const currentResult = currentGeneration?.result ?? worker.snapshotCache.get(activeSessionId);
				const isOlderThanCurrent =
					currentGeneration !== undefined &&
					currentGeneration.transcript.snapshotId !== begin.snapshotId &&
					currentResult !== undefined &&
					result.lastEventSequence < currentResult.lastEventSequence;
				if (isOlderThanCurrent && !generation) {
					return;
				}
				if (duplicate && generation) {
					generation.incoming = true;
					generation.duplicateChunkIndex = 0;
					generation.duplicateResult = result;
					generation.validation = this.createSnapshotDuplicateValidation();
					if (currentGeneration === generation) {
						worker.snapshotCache.delete(activeSessionId);
					}
					return;
				}
				if (
					currentGeneration &&
					currentGeneration.transcript.snapshotId !== begin.snapshotId &&
					!isOlderThanCurrent
				) {
					if (!currentGeneration.transcript.complete && !currentGeneration.incoming) {
						this.failWorkerSnapshotCache(
							worker,
							activeSessionId,
							new Error(`Snapshot ${currentGeneration.transcript.snapshotId} was superseded`),
							false,
							currentGeneration.transcript.snapshotId,
						);
					} else {
						this.retireWorkerSnapshotCache(worker, activeSessionId, currentGeneration.transcript);
					}
				}
				if (!generation) {
					const transcript = new SnapshotTranscriptCache({
						activeSessionId,
						snapshotId: begin.snapshotId,
						cacheRoot: this.snapshotCacheRoot,
						targetChunkBytes: begin.targetChunkBytes,
					});
					generation = {
						transcript,
						result,
						incoming: false,
						retired: isOlderThanCurrent,
					};
					this.snapshotGenerationsFor(worker, activeSessionId).set(begin.snapshotId, generation);
				}
				generation.result = result;
				generation.begin = Buffer.from(frame.payload);
				generation.end = undefined;
				generation.incoming = true;
				generation.duplicateChunkIndex = undefined;
				generation.duplicateResult = undefined;
				generation.validation = undefined;
				if (!isOlderThanCurrent) {
					generation.retired = false;
					worker.transcriptCaches.set(activeSessionId, generation.transcript);
					worker.snapshotCache.set(activeSessionId, result);
				}
			} catch (error) {
				this.log(`Invalid worker snapshot begin frame: ${String(error)}`);
				this.failWorkerSnapshotCache(
					worker,
					activeSessionId,
					error instanceof Error ? error : new Error(String(error)),
					true,
				);
			}
			return;
		}
		if (outboundType === "session_snapshot_chunk" && activeSessionId) {
			const snapshotId = frameSnapshotId ?? worker.transcriptCaches.get(activeSessionId)?.snapshotId;
			if (!snapshotId) {
				return;
			}
			const generation = this.snapshotGeneration(worker, activeSessionId, snapshotId);
			if (generation?.incoming) {
				try {
					const duplicateIndex = generation.duplicateChunkIndex;
					if (duplicateIndex === undefined) {
						generation.transcript.appendEncodedChunk(Buffer.from(frame.payload));
					} else {
						const chunk = JSON.parse(frame.payload.toString("utf8")) as Extract<
							DaemonOutbound,
							{ type: "session_snapshot_chunk" }
						>;
						if (
							chunk.type !== "session_snapshot_chunk" ||
							chunk.activeSessionId !== activeSessionId ||
							chunk.snapshotId !== generation.transcript.snapshotId ||
							chunk.index !== duplicateIndex ||
							!generation.transcript.readChunk(duplicateIndex).equals(Buffer.from(frame.payload))
						) {
							throw new Error(
								`Duplicate snapshot ${generation.transcript.snapshotId} did not match cached bytes`,
							);
						}
						generation.duplicateChunkIndex = duplicateIndex + 1;
					}
				} catch (error) {
					this.failWorkerSnapshotCache(
						worker,
						activeSessionId,
						error instanceof Error ? error : new Error(String(error)),
						true,
						generation.transcript.snapshotId,
					);
				}
			}
			return;
		}
		if (outboundType === "session_snapshot_end" && activeSessionId) {
			const snapshotId = frameSnapshotId ?? worker.transcriptCaches.get(activeSessionId)?.snapshotId;
			if (!snapshotId) {
				return;
			}
			const generation = this.snapshotGeneration(worker, activeSessionId, snapshotId);
			if (!generation?.incoming) {
				return;
			}
			const transcript = generation.transcript;
			try {
				const duplicateChunkCount = generation.duplicateChunkIndex;
				if (duplicateChunkCount === undefined) {
					transcript.markComplete();
					if (!generation.begin) {
						throw new Error(`Snapshot ${transcript.snapshotId} has no begin frame`);
					}
					generation.end = Buffer.from(frame.payload);
				} else {
					const end = JSON.parse(frame.payload.toString("utf8")) as Extract<
						DaemonOutbound,
						{ type: "session_snapshot_end" }
					>;
					if (
						end.type !== "session_snapshot_end" ||
						end.activeSessionId !== activeSessionId ||
						end.snapshotId !== transcript.snapshotId ||
						end.chunkCount !== duplicateChunkCount ||
						end.chunkCount !== transcript.chunkCount ||
						!generation.end?.equals(frame.payload)
					) {
						throw new Error(`Duplicate snapshot ${transcript.snapshotId} ended with different metadata`);
					}
					if (!generation.duplicateResult) {
						throw new Error(`Duplicate snapshot ${transcript.snapshotId} has no result`);
					}
					generation.result = generation.duplicateResult;
					if (worker.transcriptCaches.get(activeSessionId) === transcript) {
						worker.snapshotCache.set(activeSessionId, generation.duplicateResult);
					}
					this.settleSnapshotDuplicateValidation(generation);
				}
				generation.incoming = false;
				generation.duplicateChunkIndex = undefined;
				generation.duplicateResult = undefined;
			} catch (error) {
				this.failWorkerSnapshotCache(
					worker,
					activeSessionId,
					error instanceof Error ? error : new Error(String(error)),
					true,
					transcript.snapshotId,
				);
				return;
			}
			const published = worker.transcriptCaches.get(activeSessionId) === transcript;
			if (generation.retired) {
				this.deleteSnapshotGeneration(worker, activeSessionId, generation);
				transcript.dispose();
			}
			if (published && (snapshotPurpose === "replacement" || snapshotPurpose === "catchup")) {
				this.queueSnapshotResync(activeSessionId, snapshotPurpose);
			}
			return;
		}
		if (outboundType === "session_snapshot_failed" && activeSessionId) {
			try {
				const failed = JSON.parse(frame.payload.toString("utf8")) as Extract<
					DaemonOutbound,
					{ type: "session_snapshot_failed" }
				>;
				if (
					failed.type !== "session_snapshot_failed" ||
					failed.activeSessionId !== activeSessionId ||
					typeof failed.snapshotId !== "string" ||
					typeof failed.error !== "string" ||
					(frameSnapshotId !== undefined && frameSnapshotId !== failed.snapshotId)
				) {
					throw new Error("Worker returned an invalid snapshot failure frame");
				}
				const currentGeneration = this.currentSnapshotGeneration(worker, activeSessionId);
				const generation =
					this.snapshotGeneration(worker, activeSessionId, failed.snapshotId) ??
					(currentGeneration?.transcript.snapshotId === failed.snapshotId ? currentGeneration : undefined);
				if (!generation) {
					return;
				}
				this.failSnapshotTransfer(
					worker,
					activeSessionId,
					failed.snapshotId,
					new Error(failed.error),
					snapshotPurpose,
				);
			} catch (error) {
				this.failWorkerSnapshotCache(
					worker,
					activeSessionId,
					error instanceof Error ? error : new Error(String(error)),
					true,
				);
			}
			return;
		}
		if (
			outboundType === "daemon_hello" ||
			outboundType === "response" ||
			outboundType === "session_list_progress" ||
			outboundType === "session_list_item" ||
			outboundType === "session_attached" ||
			outboundType === "session_detached" ||
			!activeSessionId
		) {
			return;
		}
		let publicPayload = frame.payload;
		let streamingDeltaPayload: Uint8Array | undefined;
		let decodedOutbound: DaemonOutbound | undefined;
		let fragmentOnlyDelta = false;
		if (payloadEncoding === "assistant-delta") {
			let compactValue: unknown;
			try {
				compactValue = JSON.parse(frame.payload.toString("utf8"));
			} catch {
				this.scheduleCompactCatchup(worker, activeSessionId);
				return;
			}
			if (!isCompactAssistantDelta(compactValue)) {
				this.scheduleCompactCatchup(worker, activeSessionId);
				return;
			}
			// Always reconstruct: it validates the delta and drives desync
			// catch-up even when only streaming_deltas clients are attached.
			const reconstructed = this.streamReconstructor.reconstruct(compactValue);
			if (!reconstructed) {
				this.scheduleCompactCatchup(worker, activeSessionId);
				return;
			}
			// Capable clients consume the worker's original compact bytes
			// verbatim; the full message_update serialization happens only when
			// a legacy client still needs it. Fragment-only tool-call deltas
			// additionally require streaming_delta_fragments on the verbatim leg.
			fragmentOnlyDelta = isFragmentOnlyToolCallDelta(compactValue);
			streamingDeltaPayload = frame.payload;
			if (this.sessionNeedsRebuiltStreamPayload(activeSessionId, fragmentOnlyDelta)) {
				publicPayload = Buffer.from(serializeJsonLine(reconstructed));
			}
		} else if (
			sessionEventType === "message_start" ||
			sessionEventType === "message_end" ||
			outboundType === "session_replaced" ||
			outboundType === "session_resynced" ||
			outboundType === "session_closed"
		) {
			try {
				decodedOutbound = JSON.parse(frame.payload.toString("utf8")) as DaemonOutbound;
				this.streamReconstructor.observe(decodedOutbound);
			} catch {
				// A malformed worker event is still isolated to this worker connection.
			}
		}
		if (decodedOutbound?.type === "session_replaced" || decodedOutbound?.type === "session_resynced") {
			// The attached clients are about to be reseeded, so any catch-up retry
			// budget from the previous event generation is stale (I-8): a healed
			// client must never be told it fell behind.
			const reseedGeneration = decodedOutbound.meta?.cursor?.generation;
			for (const client of this.clients) {
				if (!client.attachedActiveSessionIds.has(activeSessionId)) {
					continue;
				}
				this.noteClientViewReseeded(client, activeSessionId, reseedGeneration);
			}
		}
		const replacementSnapshotFollows =
			decodedOutbound?.type === "session_replaced" && decodedOutbound.snapshotFollows === true;
		this.invalidateWorkerSnapshot(
			worker,
			activeSessionId,
			outboundType === "session_replaced" ||
				outboundType === "session_closed" ||
				isFinalizedTranscriptEvent(sessionEventType),
		);
		for (const client of this.clients) {
			if (!client.attachedActiveSessionIds.has(activeSessionId)) {
				continue;
			}
			if (replacementSnapshotFollows && !client.capabilities.has("chunked_snapshot")) {
				continue;
			}
			if (outboundType === "extension_ui_request" && !client.supportsExtensionUi) {
				continue;
			}
			// Snapshots cannot recover extension requests, so never defer or drop them.
			if (outboundType === "extension_ui_request") {
				this.writeSerialized(client, publicPayload);
				continue;
			}
			if (outboundType === "session_closed") {
				client.snapshotTransferAbortControllers?.get(activeSessionId)?.abort();
				this.discardDeferredSessionPayloads(client, activeSessionId);
				client.catchupActiveSessionIds?.delete(activeSessionId);
				client.catchupPurposes?.delete(activeSessionId);
				this.writeSerialized(client, publicPayload);
				continue;
			}
			if (client.snapshotActiveSessionIds?.has(activeSessionId)) {
				// A replacement swaps the session wholesale; buffered payloads from
				// the old session must never replay, so fall back to a replacement
				// catch-up snapshot.
				if (outboundType === "session_replaced") {
					this.discardDeferredSessionPayloads(client, activeSessionId);
					client.deferredSessionPayloadsDropped ??= new Set();
					client.deferredSessionPayloadsDropped.add(activeSessionId);
					this.queueCatchup(client, activeSessionId, "replacement");
					continue;
				}
				if (this.deferSessionPayload(client, activeSessionId, publicPayload)) {
					continue;
				}
				// The deferral buffer overflowed: fall back to a full resync.
				this.queueCatchup(client, activeSessionId, "resync");
				continue;
			}
			if (client.deferredSessionPayloadsDropped?.has(activeSessionId)) continue;
			if (client.backpressured === true) {
				this.queueCatchup(client, activeSessionId, outboundType === "session_replaced" ? "replacement" : "resync");
				continue;
			}
			const payload =
				streamingDeltaPayload !== undefined &&
				client.capabilities.has("streaming_deltas") &&
				(!fragmentOnlyDelta || client.capabilities.has("streaming_delta_fragments"))
					? streamingDeltaPayload
					: publicPayload;
			this.writeSerialized(client, payload);
		}
		if (
			decodedOutbound?.type === "session_closed" &&
			decodedOutbound.reason === "shutdown" &&
			activeSessionId === worker.descriptor.rootActiveSessionId &&
			!this.shuttingDown
		) {
			worker.intentionalStop = true;
			// An exact stop owns its registration and descriptor cleanup until its
			// tuple assertions complete. A synchronous root shutdown event can arrive
			// before its request resolves, so leave both intact while it is active.
			if ((this.workerStopCounts?.get(worker) ?? 0) === 0) {
				this.invalidateWorkerSessionInputPauses(worker, "Session worker stopped while input was paused");
				this.workers.delete(worker.descriptor.workerId);
				this.flipWorkerRosterEntriesInactive(worker);
				this.deleteWorkerDescriptor(worker);
			}
		}
	}

	private invalidateWorkerSnapshot(worker: ResidentWorker, activeSessionId: string, transcriptChanged = true): void {
		worker.snapshotCache.delete(activeSessionId);
		if (!transcriptChanged) {
			return;
		}
		worker.snapshotLoads.delete(`${activeSessionId}:chunked`);
		worker.snapshotLoads.delete(`${activeSessionId}:full`);
		const transcript = worker.transcriptCaches.get(activeSessionId);
		if (transcript) {
			this.retireWorkerSnapshotCache(worker, activeSessionId, transcript);
		}
	}

	/**
	 * Whether any attached client needs the rebuilt full message_update for this
	 * delta: legacy clients always do; fragment-only tool-call deltas also force
	 * a rebuild when a streaming_deltas client lacks streaming_delta_fragments.
	 */
	private sessionNeedsRebuiltStreamPayload(activeSessionId: string, fragmentOnlyDelta: boolean): boolean {
		for (const client of this.clients) {
			if (!client.attachedActiveSessionIds.has(activeSessionId)) {
				continue;
			}
			if (!client.capabilities.has("streaming_deltas")) {
				return true;
			}
			if (fragmentOnlyDelta && !client.capabilities.has("streaming_delta_fragments")) {
				return true;
			}
		}
		return false;
	}

	private scheduleCompactCatchup(worker: ResidentWorker, activeSessionId: string): void {
		if (this.compactCatchupInProgress.has(activeSessionId)) {
			return;
		}
		this.compactCatchupInProgress.add(activeSessionId);
		this.invalidateWorkerSnapshot(worker, activeSessionId);
		const clients = [...this.clients].filter((client) => client.attachedActiveSessionIds.has(activeSessionId));
		for (const client of clients) {
			this.queueCatchup(client, activeSessionId);
		}
		void Promise.all(clients.map((client) => this.catchUpClient(client)))
			.catch((error) => this.log(`Failed compact catch-up for ${activeSessionId}: ${String(error)}`))
			.finally(() => {
				this.compactCatchupInProgress.delete(activeSessionId);
			});
	}

	private queueCatchup(
		client: DaemonSocketClient,
		activeSessionId: string,
		purpose: "replacement" | "resync" = "resync",
	): void {
		if (!client.catchupActiveSessionIds) {
			client.catchupActiveSessionIds = new Set();
		}
		client.catchupActiveSessionIds.add(activeSessionId);
		client.catchupPurposes ??= new Map();
		if (purpose === "replacement" || !client.catchupPurposes.has(activeSessionId)) {
			client.catchupPurposes.set(activeSessionId, purpose);
		}
	}

	/** Hold relayed payloads until the snapshot finishes; false requests a catch-up. */
	private deferSessionPayload(client: DaemonSocketClient, activeSessionId: string, payload: Buffer): boolean {
		if (client.deferredSessionPayloadsDropped?.has(activeSessionId)) {
			return false;
		}
		const deferred = client.deferredSessionPayloads?.get(activeSessionId) ?? { payloads: [], bytes: 0 };
		if (
			deferred.payloads.length >= MAX_DEFERRED_SESSION_PAYLOADS ||
			deferred.bytes + payload.byteLength > MAX_DEFERRED_SESSION_BYTES
		) {
			// A catch-up snapshot supersedes the buffered payloads.
			client.deferredSessionPayloadsDropped ??= new Set();
			client.deferredSessionPayloadsDropped.add(activeSessionId);
			this.discardDeferredSessionPayloads(client, activeSessionId);
			return false;
		}
		deferred.payloads.push(payload);
		deferred.bytes += payload.byteLength;
		client.deferredSessionPayloads ??= new Map();
		client.deferredSessionPayloads.set(activeSessionId, deferred);
		return true;
	}

	/** Replay payloads deferred during a completed snapshot stream, in order. */
	private flushDeferredSessionPayloads(client: DaemonSocketClient, activeSessionId: string): void {
		const payloads = client.deferredSessionPayloads?.get(activeSessionId)?.payloads;
		if (!payloads || payloads.length === 0) {
			return;
		}
		client.deferredSessionPayloads?.delete(activeSessionId);
		if (!client.attachedActiveSessionIds.has(activeSessionId)) return;
		for (const payload of payloads) {
			if (client.socket.destroyed) {
				return;
			}
			if (client.backpressured || !this.writeSerialized(client, payload)) {
				this.queueCatchup(client, activeSessionId, "resync");
				return;
			}
		}
	}

	private discardDeferredSessionPayloads(client: DaemonSocketClient, activeSessionId: string): void {
		client.deferredSessionPayloads?.delete(activeSessionId);
	}

	/**
	 * Flush or discard the payloads withheld during a snapshot stream. Only the
	 * last active stream for the session owns them; an overlapping stream
	 * replays them after it completes.
	 */
	private releaseDeferredSessionPayloads(
		client: DaemonSocketClient,
		activeSessionId: string,
		delivered: boolean,
	): void {
		if (client.snapshotActiveSessionIds?.has(activeSessionId)) {
			return;
		}
		if (delivered) {
			this.flushDeferredSessionPayloads(client, activeSessionId);
		} else {
			this.discardDeferredSessionPayloads(client, activeSessionId);
		}
	}

	private catchUpClient(client: DaemonSocketClient): Promise<void> {
		if (client.catchupPromise) {
			return client.catchupPromise;
		}
		// Upstream's gate plus the fork's retry timer: `scheduleClientCatchupRetry` is the
		// only writer of `catchupRetryTimer`, so a trigger that lands mid-backoff must not
		// reopen a budget the policy is still counting down. The timer callback clears the
		// field before calling back in, so this never blocks our own retry.
		if (client.snapshotStreaming || client.backpressured || client.catchupRetryTimer) {
			return Promise.resolve();
		}
		const catchup = this.drainClientCatchupQueue(client).finally(() => {
			if (client.catchupPromise === catchup) {
				client.catchupPromise = undefined;
			}
		});
		client.catchupPromise = catchup;
		return catchup;
	}

	private async drainClientCatchupQueue(client: DaemonSocketClient): Promise<void> {
		while (
			!client.socket.destroyed &&
			!client.snapshotStreaming &&
			!client.backpressured &&
			client.catchupActiveSessionIds?.size
		) {
			if ((await this.drainClientCatchups(client)) === "retry-later") {
				return;
			}
		}
	}

	private async drainClientCatchups(client: DaemonSocketClient): Promise<"drained" | "retry-later"> {
		if (client.socket.destroyed) {
			return "drained";
		}
		const pending = [...(client.catchupActiveSessionIds ?? [])].map((activeSessionId) => ({
			activeSessionId,
			purpose: client.catchupPurposes?.get(activeSessionId) ?? ("resync" as const),
		}));
		client.catchupActiveSessionIds?.clear();
		client.catchupPurposes?.clear();
		let retryError: Error | undefined;
		for (let index = 0; index < pending.length; index++) {
			const { activeSessionId, purpose } = pending[index]!;
			let releaseTranscript: (() => void) | undefined;
			// Reserve before loading the snapshot: any live frame forwarded while
			// the replacement snapshot loads would be newer than the snapshot seed,
			// then dropped by the client's clear-and-reseed, tearing the rebuilt
			// stream until text_end. Queue those frames for catch-up instead.
			const releaseSnapshotReservation = this.reserveSnapshotStream(client, activeSessionId);
			// #2260: read the signal AFTER reserving — reserveSnapshotStream is what
			// creates the controller for this session, so reading it first yields
			// undefined and the whole abort gate silently goes inert.
			const snapshotSignal = client.snapshotTransferAbortControllers?.get(activeSessionId)?.signal;
			try {
				const attached = await this.attachClient(client, {
					type: "attach",
					activeSessionId,
					capabilities: [...client.capabilities],
					supportsExtensionUi: client.supportsExtensionUi,
				});
				releaseTranscript = attached.releaseTranscript;
				if (client.capabilities.has("chunked_snapshot")) {
					const transcript = attached.transcript;
					if (!transcript) {
						throw new Error("Session worker did not provide a snapshot transcript");
					}
					if (purpose === "replacement") {
						this.write(client, {
							type: "session_replaced",
							activeSessionId,
							state: attached.result.snapshot.state,
							messages: [],
							snapshotFollows: true,
							meta: createDaemonEventMeta(
								activeSessionId,
								attached.result.lastEventSequence,
								undefined,
								attached.result.lastEventCursor?.generation,
							),
						});
					}
					// streamSnapshot releases the reservation in its own finally; the
					// release below is an idempotent safety net for callers that stub
					// or replace streamSnapshot.
					await this.streamSnapshot(
						client,
						attached.worker,
						this.createStreamedAttachResult(attached.result, transcript),
						transcript,
						purpose,
						releaseTranscript,
						releaseSnapshotReservation,
					);
					releaseTranscript = undefined;
					this.noteClientViewReseeded(client, activeSessionId, attached.result.lastEventCursor?.generation);
					continue;
				}
				const meta = createDaemonEventMeta(
					activeSessionId,
					attached.result.lastEventSequence,
					undefined,
					attached.result.lastEventCursor?.generation,
				);
				const catchup: DaemonOutbound =
					purpose === "replacement"
						? {
								type: "session_replaced",
								activeSessionId,
								state: attached.result.snapshot.state,
								messages: attached.result.snapshot.messages,
								meta,
							}
						: {
								type: "session_resynced",
								activeSessionId,
								snapshot: attached.result.snapshot,
								meta,
							};
				const accepted = this.write(client, catchup);
				releaseSnapshotReservation();
				this.releaseDeferredSessionPayloads(client, activeSessionId, true);
				if (!accepted) {
					for (const remaining of pending.slice(index + 1)) {
						this.queueCatchup(client, remaining.activeSessionId, remaining.purpose);
					}
					return "retry-later";
				}
				this.noteClientViewReseeded(client, activeSessionId, attached.result.lastEventCursor?.generation);
			} catch (error) {
				releaseTranscript?.();
				// #2260: only requeue a session the client is still attached to, and not one
				// whose transfer a newer stream aborted — that stream owns the view now, and
				// a detached client has no view to repair. (The fork used to requeue
				// `pending.slice(index)` unconditionally; the rest of the batch is now handled
				// by the loop below instead of by an early return.)
				if (client.attachedActiveSessionIds.has(activeSessionId) && !snapshotSignal?.aborted) {
					this.queueCatchup(client, activeSessionId, purpose);
				}
				// #2260: frames withheld behind this stream are stale once the stream failed;
				// drop them so the resync reseeds instead of replaying bytes from a view the
				// client never finished rendering. Marked before the budget check so a give-up
				// frame is written, not withheld.
				client.deferredSessionPayloadsDropped ??= new Set();
				client.deferredSessionPayloadsDropped.add(activeSessionId);
				this.discardDeferredSessionPayloads(client, activeSessionId);
				// C10/F4/F8/I-8: bounded per-session retry. A give-up is the end of this
				// streak, so the session must not stay queued: leaving it there made every
				// later trigger — a compact-stream sync, an invalidated snapshot, a
				// backpressure drain — reopen a full retry budget for a failure that does not
				// heal by waiting, and notify the client to re-pull all over again. The
				// client's own re-attach is what puts the session back in the queue.
				if (this.handleCatchupFailure(client, activeSessionId, purpose, error) === "give-up") {
					client.catchupActiveSessionIds?.delete(activeSessionId);
					client.catchupPurposes?.delete(activeSessionId);
				}
				// Keep the batch running (upstream) but remember that it failed, so the queue
				// drain below stops instead of immediately re-picking the requeued session.
				retryError ??= error instanceof Error ? error : new Error(String(error));
			} finally {
				releaseSnapshotReservation();
				this.releaseDeferredSessionPayloads(client, activeSessionId, false);
			}
		}
		// Retry failed sessions only after the rest of the batch has had a chance to recover.
		return retryError ? "retry-later" : "drained";
	}

	/**
	 * Bounded retry for a failed catch-up (C10). Transient failures requeue and
	 * retry on an exponential backoff; a spent budget or a permanent failure tells
	 * the client to re-pull the whole snapshot instead of leaving a silently
	 * incomplete view behind (F8). The supervisor never turns a catch-up failure
	 * into a terminal `closed` frame.
	 *
	 * Returns whether the streak is over ("give-up"), so the caller can drop the
	 * session from the client's catch-up queue instead of leaving a permanently
	 * failing entry behind for the next trigger to reopen (F4).
	 *
	 * Upstream's #2260 keeps the rest of the batch running after a failure, so a
	 * give-up that left the session queued would be re-entered by every sibling
	 * failure in the same batch, not just by a later trigger.
	 */
	private handleCatchupFailure(
		client: DaemonSocketClient,
		activeSessionId: string,
		purpose: "replacement" | "resync",
		error: unknown,
	): "retry" | "give-up" {
		const now = Date.now();
		client.catchupRetryState ??= new Map();
		const states = client.catchupRetryState;
		const failure = error instanceof Error ? error.message : String(error);
		if (!isTransientCatchupFailure(error)) {
			states.delete(activeSessionId);
			this.clearClientCatchupRetryTimerIfIdle(client);
			this.log(
				`Failed to catch up client ${client.id} for ${activeSessionId} (catchup failed, not retryable): ${failure}`,
			);
			this.notifyCatchupGiveUp(client, activeSessionId, purpose, "catchup_failed", failure);
			return "give-up";
		}
		const state = states.get(activeSessionId) ?? {
			attempts: 0,
			openedAt: now,
			generation: client.observedEventGenerations?.get(activeSessionId),
		};
		state.attempts += 1;
		states.set(activeSessionId, state);
		const observedGeneration = client.observedEventGenerations?.get(activeSessionId);
		if (
			state.generation !== undefined &&
			observedGeneration !== undefined &&
			state.generation !== observedGeneration
		) {
			// The client already reseeded onto a newer event generation; a budget from
			// the previous one must not tell a healed client that it fell behind (I-8).
			states.delete(activeSessionId);
			this.clearClientCatchupRetryTimerIfIdle(client);
			this.log(
				`Dropped stale catch-up budget for client ${client.id} for ${activeSessionId}: event generation changed`,
			);
			return "retry";
		}
		const remainingMs = state.openedAt + this.catchupRetryPolicy.deadlineMs - now;
		const delayMs = clientCatchupRetryDelayMs(
			this.catchupRetryPolicy,
			state.attempts,
			this.catchupRetryJitterMs(),
			remainingMs,
		);
		if (delayMs === undefined) {
			states.delete(activeSessionId);
			this.clearClientCatchupRetryTimerIfIdle(client);
			this.log(
				`Failed to catch up client ${client.id} for ${activeSessionId} after ${state.attempts} attempts (catchup exhausted): ${failure}`,
			);
			this.notifyCatchupGiveUp(client, activeSessionId, purpose, "catchup_exhausted", failure);
			return "give-up";
		}
		if (state.lastWarnAt === undefined || now - state.lastWarnAt >= this.catchupRetryPolicy.logThrottleMs) {
			state.lastWarnAt = now;
			this.log(
				`Failed to catch up client ${client.id} for ${activeSessionId}: ${failure} (catchup retry scheduled, attempt ${state.attempts}/${this.catchupRetryPolicy.maxAttempts}, next in ${delayMs}ms)`,
			);
		}
		this.scheduleClientCatchupRetry(client, delayMs);
		return "retry";
	}

	private catchupRetryJitterMs(): number {
		return Math.random() * this.catchupRetryPolicy.jitterMs;
	}

	private scheduleClientCatchupRetry(client: DaemonSocketClient, delayMs: number): void {
		if (client.socket.destroyed || client.catchupRetryTimer) {
			return;
		}
		const timer = setTimeout(() => {
			client.catchupRetryTimer = undefined;
			if (client.socket.destroyed || !client.catchupActiveSessionIds?.size) {
				return;
			}
			if (client.snapshotStreaming || client.backpressured) {
				this.scheduleClientCatchupRetry(client, delayMs);
				return;
			}
			void this.catchUpClient(client).catch((error) =>
				this.log(`Failed to catch up client ${client.id}: ${String(error)}`),
			);
		}, delayMs);
		timer.unref();
		client.catchupRetryTimer = timer;
	}

	/**
	 * Gives up loudly: the client re-pulls the full snapshot and heals itself.
	 * The `purpose` and `reason` fields let a client recover from a failure that
	 * has no preceding `session_snapshot_begin` frame; a client that does not
	 * understand them keeps today's behaviour and ignores the frame.
	 */
	private notifyCatchupGiveUp(
		client: DaemonSocketClient,
		activeSessionId: string,
		purpose: "replacement" | "resync",
		reason: "catchup_exhausted" | "catchup_failed",
		failure: string,
	): void {
		if (client.socket.destroyed) {
			return;
		}
		this.write(client, {
			type: "session_snapshot_failed",
			activeSessionId,
			snapshotId: `catchup-${reason}-${randomUUID()}`,
			error: failure,
			reason,
			purpose,
		});
	}

	private noteClientViewReseeded(
		client: DaemonSocketClient,
		activeSessionId: string,
		generation: string | undefined,
	): void {
		this.clearClientCatchupRetry(client, activeSessionId);
		if (generation === undefined) {
			return;
		}
		client.observedEventGenerations ??= new Map();
		client.observedEventGenerations.set(activeSessionId, generation);
	}

	private clearClientCatchupRetry(client: DaemonSocketClient, activeSessionId?: string): void {
		if (activeSessionId !== undefined) {
			client.catchupRetryState?.delete(activeSessionId);
			this.clearClientCatchupRetryTimerIfIdle(client);
			return;
		}
		client.catchupRetryState?.clear();
		client.observedEventGenerations?.clear();
		if (client.catchupRetryTimer) {
			clearTimeout(client.catchupRetryTimer);
			client.catchupRetryTimer = undefined;
		}
	}

	/** One timer serves the whole client queue, so it is only dropped once no session budget is left. */
	private clearClientCatchupRetryTimerIfIdle(client: DaemonSocketClient): void {
		if (!client.catchupRetryTimer || (client.catchupRetryState?.size ?? 0) > 0) {
			return;
		}
		clearTimeout(client.catchupRetryTimer);
		client.catchupRetryTimer = undefined;
	}

	private async prepareUpdateRestart(): Promise<DaemonUpdateRestartManifest> {
		if (this.updateRestartPhase === "prepared") {
			// An earlier prepare finished (checkpoint persisted, workers stopped) but
			// the handoff never completed, e.g. the coordinator failed to stop this
			// daemon. Re-issue the checkpoint instead of failing every later attempt
			// with "already preparing": that would wedge self-updates until someone
			// manually shuts this prepared daemon down.
			const prepared = this.preparedUpdateRestartManifest ?? this.readPreparedUpdateRestartManifest();
			if (prepared) {
				this.validateAndPersistUpdateManifest(prepared);
				return prepared;
			}
			// Prepared phase with no checkpoint left to replay (both the in-memory
			// copy and the persisted manifest are gone) is unrecoverable; drop the
			// stale phase so a fresh prepare can proceed instead of throwing
			// "already preparing" forever.
			this.updateRestartPhase = undefined;
		}
		if (this.updateRestartPhase !== undefined) throw new Error("Daemon is already preparing an update restart");
		this.updateRestartPhase = "draining";
		// P1-7c/B10: pending deliveries are answered before the fence, not carried
		// across it. Each sender still waiting gets an explicit terminal receipt.
		this.drainPendingDeliveries("update_restart");
		try {
			const deadline = Date.now() + UPDATE_RESTART_PREPARE_DEADLINE_MS;
			const abort = AbortSignal.timeout(
				Math.min(
					this.updateRestartDrainTimeoutMs ?? UPDATE_RESTART_MUTATION_DRAIN_TIMEOUT_MS,
					deadline - Date.now(),
				),
			);
			await this.mutationDrain.waitForDrain(1, abort, "Timed out draining daemon mutations for update restart");
			this.updateRestartPhase = "fencing";
			await this.mutationDrain.waitForDrain(1, abort, "Timed out draining daemon mutations for update restart");
			const manifest = await this.prepareUpdateRestartFenced(deadline);
			this.updateRestartPhase = "prepared";
			return manifest;
		} catch (error) {
			this.updateRestartPhase = undefined;
			this.preparedUpdateRestartManifest = undefined;
			this.scheduleScheduledSessionWakeRecompute();
			throw error;
		}
	}

	/**
	 * Re-enter the prepared phase after a supervisor restart that interrupted a
	 * handoff. The checkpoint is durable on disk; if it is fresh and no worker
	 * descriptors survived (the commit removed them after stopping), restore the
	 * phase so a retried prepare re-issues the checkpoint instead of re-preparing
	 * from resident workers and overwriting it. An old checkpoint is treated as an
	 * abandoned handoff and left to ordinary recovery.
	 */
	private restorePreparedUpdateRestartState(): void {
		if (this.updateRestartPhase !== undefined) return;
		if (this.workers.size > 0) return;
		const agentDir = this.defaultSessionConfig.agentDir;
		if (!agentDir) return;
		const manifestPath = getDaemonUpdateRestartManifestPath(this.socketPath, agentDir);
		let modifiedAtMs: number;
		try {
			modifiedAtMs = statSync(manifestPath).mtimeMs;
		} catch {
			return;
		}
		const ageMs = Date.now() - modifiedAtMs;
		if (ageMs > UPDATE_RESTART_PREPARED_RESTORE_WINDOW_MS) return;
		if (ageMs < UPDATE_RESTART_PREPARED_RESTORE_MIN_AGE_MS) return;
		const manifest = this.readPreparedUpdateRestartManifest();
		if (!manifest || manifest.sessions.length === 0) return;
		this.updateRestartPhase = "prepared";
		this.preparedUpdateRestartManifest = manifest;
		this.log(
			`Restored prepared update restart checkpoint (${manifest.sessions.length} session(s)) after supervisor restart`,
		);
	}

	/** Read the persisted prepared checkpoint, if one exists and parses cleanly. */
	private readPreparedUpdateRestartManifest(): DaemonUpdateRestartManifest | undefined {
		const agentDir = this.defaultSessionConfig.agentDir;
		if (!agentDir) return undefined;
		try {
			const parsed = JSON.parse(
				readFileSync(getDaemonUpdateRestartManifestPath(this.socketPath, agentDir), "utf8"),
			) as DaemonUpdateRestartManifest;
			if (parsed.formatVersion !== DAEMON_UPDATE_RESTART_FORMAT_VERSION || !Array.isArray(parsed.sessions)) {
				return undefined;
			}
			return parsed;
		} catch {
			return undefined;
		}
	}

	private async prepareUpdateRestartFenced(deadline: number): Promise<DaemonUpdateRestartManifest> {
		const residents = [...this.workers.values()];
		const unavailable = residents.find(
			(worker) =>
				this.isWorkerStopping(worker) || worker.descriptor.lifecycle !== "ready" || worker.client === undefined,
		);
		if (unavailable) {
			throw new Error(
				`Cannot prepare update restart while resident worker ${unavailable.descriptor.workerId} is ${this.effectiveWorkerState(unavailable)}${unavailable.client ? "" : " and disconnected"}`,
			);
		}
		const workers = residents as Array<ResidentWorker & { client: DaemonWorkerClient }>;
		const acknowledged: ResidentWorker[] = [];
		const preparationResults = await Promise.allSettled(
			workers.map(async (worker) => {
				const client = worker.client;
				const response = await client.requestWorker(
					{ type: "worker_prepare_update" },
					Math.max(1, Math.min(UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS, deadline - Date.now())),
				);
				if (!response.success) throw new Error(response.error);
				worker.updateRestartPrepareClient = client;
				acknowledged.push(worker);
				if (!response.data || typeof response.data !== "object") {
					throw new Error("Worker returned an invalid update manifest");
				}
				if (worker.client !== client || worker.descriptor.lifecycle !== "ready") {
					throw new Error(`Worker ${worker.descriptor.workerId} disconnected during update preparation`);
				}
				const manifest = response.data as DaemonUpdateRestartManifest;
				if (manifest.formatVersion !== DAEMON_UPDATE_RESTART_FORMAT_VERSION) {
					throw new Error(`Worker returned unsupported update manifest version ${manifest.formatVersion}`);
				}
				if (
					!manifest.sessions.some(
						(session) => session.activeSessionId === worker.descriptor.rootActiveSessionId,
					) &&
					!manifest.discardedActiveSessionIds?.includes(worker.descriptor.rootActiveSessionId)
				) {
					throw new Error(
						`Worker ${worker.descriptor.workerId} omitted its root disposition from the update manifest`,
					);
				}
				return { worker, manifest };
			}),
		);
		const cancelAcknowledged = async () => {
			await Promise.all(
				acknowledged.map(async (worker) => {
					const prepareClient = worker.updateRestartPrepareClient;
					worker.updateRestartPrepareClient = undefined;
					if (!prepareClient) return;
					try {
						const response = await prepareClient.requestWorker({ type: "worker_cancel_update" }, 5000);
						if (!response.success) throw new Error(response.error);
					} catch (error) {
						this.log(
							`Could not cancel prepared worker ${worker.descriptor.workerId}; reconnecting it: ${String(error)}`,
						);
						prepareClient.close();
						if (worker.client && worker.client !== prepareClient) worker.client.close();
					}
				}),
			);
		};
		const preparationFailure = preparationResults.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (preparationFailure) {
			await cancelAcknowledged();
			throw preparationFailure.reason;
		}
		const prepared = preparationResults.flatMap((result) =>
			result.status === "fulfilled" ? [result.value.worker] : [],
		);
		const responses = preparationResults.flatMap((result) =>
			result.status === "fulfilled" ? [result.value.manifest] : [],
		);
		const discardedActiveSessionIds = responses.flatMap((manifest) => manifest.discardedActiveSessionIds ?? []);
		const manifest: DaemonUpdateRestartManifest = {
			formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
			createdAt: new Date().toISOString(),
			sessions: responses.flatMap((manifest) => manifest.sessions),
			...(discardedActiveSessionIds.length > 0 ? { discardedActiveSessionIds } : {}),
		};
		// A worker that disconnected after preparing cancelled its checkpoint with
		// the old client; a recovered replacement may have admitted inputs past the
		// captured manifest. Abort before the manifest is persisted so the caller's
		// fallback cannot restore from the stale checkpoint.
		const staleWorker = prepared.find((worker) => worker.client !== worker.updateRestartPrepareClient);
		if (staleWorker) {
			await cancelAcknowledged();
			throw new Error(
				`Worker ${staleWorker.descriptor.workerId} reconnected during update preparation; its checkpoint is stale`,
			);
		}
		try {
			this.validateAndPersistUpdateManifest(manifest);
			this.preparedUpdateRestartManifest = manifest;
		} catch (error) {
			this.preparedUpdateRestartManifest = undefined;
			await cancelAcknowledged();
			throw error;
		}
		// Commit through the connection that owns the prepared transaction; a client
		// swapped in after the check above must fail the commit rather than reach a
		// worker that no longer holds the checkpoint.
		const commitClients = new Map(prepared.map((worker) => [worker, worker.updateRestartPrepareClient]));
		for (const worker of prepared) worker.updateRestartPrepareClient = undefined;
		const commitResults = await Promise.allSettled(
			prepared.map(async (worker) => {
				const client = commitClients.get(worker);
				if (!client) throw new Error(`Worker ${worker.descriptor.workerId} disconnected before update commit`);
				const response = await client.requestWorker(
					{ type: "worker_commit_update" },
					UPDATE_RESTART_WORKER_REQUEST_TIMEOUT_MS,
				);
				if (!response.success) throw new Error(response.error);
			}),
		);
		const commitFailure = commitResults.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (commitFailure) {
			this.log(`Update restart commit response failed; forcing restart completion: ${String(commitFailure.reason)}`);
			await Promise.allSettled(prepared.map((worker) => this.stopWorker(worker, true, true)));
			return manifest;
		}
		// Remove the descriptors (persisting stop tombstones) so a supervisor that
		// dies before the handoff completes cannot mistake the intentionally
		// stopped workers for crashed ones and resurrect them. The manifest, not
		// the descriptors, drives restoration on the other side of the restart.
		const stopResults = await Promise.allSettled(prepared.map((worker) => this.stopWorker(worker, true)));
		if (stopResults.some((result) => result.status === "rejected")) {
			this.log("A committed update worker did not stop gracefully; forcing restart completion");
			await Promise.allSettled(prepared.map((worker) => this.stopWorker(worker, true, true)));
		}
		return manifest;
	}

	private validateAndPersistUpdateManifest(manifest: DaemonUpdateRestartManifest): void {
		if (manifest.formatVersion !== DAEMON_UPDATE_RESTART_FORMAT_VERSION) {
			throw new Error(`Unsupported update manifest version ${manifest.formatVersion}`);
		}
		const activeSessionIds = new Set<string>();
		const sessionFiles = new Set<string>();
		for (const discardedActiveSessionId of manifest.discardedActiveSessionIds ?? []) {
			if (!discardedActiveSessionId || activeSessionIds.has(discardedActiveSessionId)) {
				throw new Error("Update manifest contains an invalid discarded session disposition");
			}
			activeSessionIds.add(discardedActiveSessionId);
		}
		for (const session of manifest.sessions) {
			if (!session.activeSessionId || !session.sessionFile) {
				throw new Error("Update manifest contains an incomplete session checkpoint");
			}
			if (activeSessionIds.has(session.activeSessionId)) {
				throw new Error(`Update manifest contains duplicate active session ${session.activeSessionId}`);
			}
			const sessionFile = canonicalSessionPath(session.sessionFile);
			if (sessionFiles.has(sessionFile)) {
				throw new Error(`Update manifest contains duplicate session file ${sessionFile}`);
			}
			activeSessionIds.add(session.activeSessionId);
			sessionFiles.add(sessionFile);
		}
		const agentDir = this.defaultSessionConfig.agentDir;
		if (!agentDir) {
			throw new Error("Daemon supervisor config is missing agentDir");
		}
		const path = getDaemonUpdateRestartManifestPath(this.socketPath, agentDir);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileAtomicSync(path, `${JSON.stringify(manifest)}\n`, {
			mode: 0o600,
			// Authority state: durability must match every other writeJsonAtomically site (C4).
			fsync: true,
			fsyncDir: true,
			beforeRename: (tempPath) => {
				const validated = JSON.parse(readFileSync(tempPath, "utf8")) as DaemonUpdateRestartManifest;
				if (!Array.isArray(validated.sessions) || validated.sessions.length !== manifest.sessions.length) {
					throw new Error("Could not validate aggregate update manifest");
				}
			},
		});
	}

	/**
	 * Verdict on whether a pid is still the process we launched. Callers must
	 * be conservative in both directions: signal a pid only on "current"
	 * (never SIGKILL a recycled pid), and clean up a registration only on
	 * "gone"/"replaced" (never orphan a live worker because a transient
	 * identity lookup failed).
	 */
	private processIdentity(
		pid: number,
		processStartId: string | undefined,
	): "current" | "replaced" | "gone" | "unknown" {
		if (!isProcessAlive(pid)) {
			return "gone";
		}
		if (processStartId === undefined) {
			return "unknown";
		}
		const observed = getProcessStartId(pid);
		if (observed === undefined) {
			return "unknown";
		}
		return observed === processStartId ? "current" : "replaced";
	}

	/**
	 * Keep an exact stop's registration and descriptor authoritative while any
	 * part of its cleanup is in flight. Root kills acquire this before forwarding
	 * because a synchronous shutdown event may arrive before the worker replies.
	 */
	private acquireWorkerStopOwnership(worker: ResidentWorker): () => void {
		if (!this.workerStopCounts) this.workerStopCounts = new Map();
		const stopCounts = this.workerStopCounts;
		stopCounts.set(worker, (stopCounts.get(worker) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const remaining = (stopCounts.get(worker) ?? 1) - 1;
			if (remaining === 0) stopCounts.delete(worker);
			else stopCounts.set(worker, remaining);
		};
	}

	private async stopWorker(
		worker: ResidentWorker,
		removeDescriptor: boolean,
		force = false,
		archiveSession = false,
		recoveryCleanup = false,
		directChild?: { child: ChildProcess; closed: Promise<void> },
	): Promise<void> {
		const releaseStopOwnership = this.acquireWorkerStopOwnership(worker);
		try {
			await this.stopWorkerUntracked(worker, removeDescriptor, force, archiveSession, recoveryCleanup, directChild);
		} finally {
			releaseStopOwnership();
		}
	}

	private async stopWorkerUntracked(
		worker: ResidentWorker,
		removeDescriptor: boolean,
		force = false,
		archiveSession = false,
		recoveryCleanup = false,
		directChild?: { child: ChildProcess; closed: Promise<void> },
	): Promise<void> {
		if (worker.ownerCleanupTimer) {
			clearTimeout(worker.ownerCleanupTimer);
			worker.ownerCleanupTimer = undefined;
		}
		if (!recoveryCleanup) {
			worker.stopRevision++;
		}
		// A retry can rescind this stop and relaunch the worker while we await
		// below. Bind every liveness check and signal to the process this stop
		// entered with, and abort cleanup once the stop no longer applies: the
		// pid changed (relaunched) or a removeDescriptor stop lost its tombstone
		// (rescinded, even before the successor pid lands).
		const entryPid = worker.descriptor.pid;
		const entryStartId = worker.descriptor.processStartId;
		const assertStopStillApplies = () => {
			if (directChild) {
				return;
			}
			if (
				worker.descriptor.pid !== entryPid ||
				(removeDescriptor && worker.descriptor.stopRequestedAt === undefined)
			) {
				throw new Error(`Session worker ${worker.descriptor.workerId} was relaunched during stop`);
			}
		};
		try {
			if (removeDescriptor) {
				this.persistWorkerStopTombstone(worker, archiveSession);
			} else {
				worker.intentionalStop = true;
				worker.descriptor.lifecycle = "recovering";
				this.persistWorker(worker);
			}
		} catch (error) {
			if (!directChild) {
				throw error;
			}
			this.reportCleanupFailure(`worker rollback state ${worker.descriptor.workerId}`, error);
		}
		const transferError = new Error("Session worker stopped during snapshot transfer");
		const generationTranscripts = new Set<SnapshotTranscriptCache>();
		for (const [activeSessionId, generations] of [...(worker.snapshotGenerations ?? new Map())]) {
			for (const generation of [...generations.values()]) {
				generationTranscripts.add(generation.transcript);
				if (generation.incoming || !generation.transcript.complete || generation.validation) {
					this.failSnapshotGeneration(worker, activeSessionId, generation, transferError);
				} else {
					generation.transcript.dispose();
					this.deleteSnapshotGeneration(worker, activeSessionId, generation);
				}
			}
		}
		for (const transcript of worker.transcriptCaches.values()) {
			if (!generationTranscripts.has(transcript) && !transcript.complete) {
				transcript.markFailed(transferError);
			}
			transcript.dispose();
		}
		worker.transcriptCaches.clear();
		worker.snapshotCache.clear();
		worker.snapshotGenerations?.clear();
		// F2/B10: receipt every delivery aimed at this tree before its socket goes,
		// so a stop (eviction, kill, reaper, relaunch) never turns an in-flight
		// message into a bare transport error the sender has to guess about.
		this.drainPendingDeliveriesForWorker(worker, "worker_stopped");
		// Hold the client in a local: the worker can disconnect during the request
		// below, and handleWorkerClose then clears worker.client mid-flight.
		const stoppingClient = worker.client;
		if (stoppingClient) {
			if (archiveSession) {
				await stoppingClient
					.requestWorker({ type: "worker_archive_and_shutdown" }, force ? 1000 : 5000)
					.catch(() => undefined);
			} else {
				await stoppingClient.request({ type: "shutdown" }, force ? 1000 : 5000).catch(() => undefined);
			}
			stoppingClient.close();
			if (worker.client === stoppingClient) {
				worker.client = undefined;
			}
		} else if (directChild) {
			directChild.child.kill("SIGTERM");
		} else if (this.processIdentity(entryPid, entryStartId) === "current") {
			signalProcessGroupOrProcess(entryPid, "SIGTERM");
		}
		// Identity-aware in both directions: a replaced pid counts as gone (never
		// signal a recycled pid) while an unknown identity counts as alive (never
		// clean up a possibly-live worker on a transient lookup failure). kill(0)
		// runs on every poll; the expensive identity check is throttled.
		let identityVerdict: "current" | "replaced" | "gone" | "unknown" = "current";
		let identityCheckedAt = 0;
		const isWorkerProcessAlive = () => {
			if (directChild) {
				return directChild.child.exitCode === null && directChild.child.signalCode === null;
			}
			if (!processIdExists(entryPid)) {
				return false;
			}
			const now = Date.now();
			if (now - identityCheckedAt >= LIVENESS_IDENTITY_RECHECK_MS) {
				identityCheckedAt = now;
				identityVerdict = this.processIdentity(entryPid, entryStartId);
			}
			return identityVerdict !== "replaced" && identityVerdict !== "gone";
		};
		const gracefulDeadline = Date.now() + (force ? 500 : 2000);
		while (isWorkerProcessAlive() && Date.now() < gracefulDeadline) {
			await delay(25);
		}
		let sigkillSent = false;
		if (force && isWorkerProcessAlive()) {
			if (directChild) {
				sigkillSent = directChild.child.kill("SIGKILL");
			} else if (this.processIdentity(entryPid, entryStartId) === "current") {
				// Recheck without the cache: the pid may have been recycled.
				signalProcessGroupOrProcess(entryPid, "SIGKILL");
				sigkillSent = true;
			}
			const forceDeadline = Date.now() + 1000;
			while (isWorkerProcessAlive() && Date.now() < forceDeadline) {
				await delay(25);
			}
		}
		if (isWorkerProcessAlive()) {
			worker.intentionalStop = worker.descriptor.stopRequestedAt !== undefined;
			if (removeDescriptor) {
				this.scheduleWorkerStopFinalization(worker);
			}
			throw new WorkerStopTimeoutError(
				`Session worker ${worker.descriptor.workerId} did not stop${sigkillSent ? " after SIGKILL" : ""}`,
			);
		}
		if (directChild) {
			await directChild.closed;
		}
		assertStopStillApplies();
		if (removeDescriptor && worker.descriptor.archiveOnStop) {
			if (force) {
				this.reclaimStoppedWorkerCronLock(worker);
			}
			await this.finalizeArchivedWorkerStop(worker);
			assertStopStillApplies();
		}
		this.invalidateWorkerSessionInputPauses(worker, "Session worker stopped while input was paused");
		// Client-owned schedules die with the registration, like their roster rows. Cancel
		// before the worker leaves the map, so no recompute sees the tree uncovered mid-stop.
		let ephemeralCancelSettled = true;
		if (removeDescriptor && worker.descriptor.ownerClientId !== undefined) {
			ephemeralCancelSettled = await this.cancelEphemeralWorkerScheduledJobs(worker);
		}
		this.workers.delete(worker.descriptor.workerId);
		this.flipWorkerRosterEntriesInactive(worker);
		// A failed cancel keeps the stop tombstone as the durable intent; the enumeration retry or the next boot finishes it.
		if (removeDescriptor && ephemeralCancelSettled) {
			this.deleteWorkerDescriptor(worker);
		}
		if (!this.shuttingDown) {
			this.broadcastHeartbeatsChanged();
		}
	}

	/**
	 * A stop that timed out leaves a tombstoned registration behind. Keep
	 * escalating in the background until the process is gone, then finish the
	 * interrupted cleanup instead of leaving a dead worker registered forever.
	 */
	private scheduleWorkerStopFinalization(worker: ResidentWorker): void {
		if (worker.stopFinalization) {
			return;
		}
		worker.stopFinalization = this.finalizeTimedOutWorkerStop(worker).finally(() => {
			worker.stopFinalization = undefined;
		});
	}

	private async finalizeTimedOutWorkerStop(worker: ResidentWorker): Promise<void> {
		// Bind to the exact process generation being stopped: a retry can rescind
		// the stop and relaunch with a new pid, and the OS can recycle the old
		// pid. The finalizer must never follow either successor.
		const pid = worker.descriptor.pid;
		const processStartId = worker.descriptor.processStartId;
		const stopRevision = worker.stopRevision;
		const isStopGenerationCurrent = () =>
			this.workers.get(worker.descriptor.workerId) === worker &&
			worker.stopRevision === stopRevision &&
			worker.descriptor.stopRequestedAt !== undefined &&
			worker.descriptor.pid === pid;
		// A replaced pid counts as gone (never SIGKILL a recycled pid); an
		// unobservable identity counts as alive (never clean up a possibly-live
		// worker). kill(0) probes every poll; ps-backed checks are throttled.
		let stoppedVerdict = true;
		let stoppedCanSignal = processStartId !== undefined;
		let stoppedCheckedAt = 0;
		/** How many identity queries came back unobservable in a row (a wedged `ps`). */
		let unobservableIdentityChecks = 0;
		const isStoppedProcessAlive = async (): Promise<boolean> => {
			if (!processIdExists(pid)) {
				return false;
			}
			const now = Date.now();
			if (now - stoppedCheckedAt < LIVENESS_IDENTITY_RECHECK_MS) {
				return stoppedVerdict;
			}
			stoppedCheckedAt = now;
			if (!isProcessAlive(pid)) {
				stoppedVerdict = false;
			} else if (processStartId === undefined) {
				stoppedVerdict = true;
				// Without an identity captured while the original worker was known
				// alive, this pid may now belong to an unrelated process. Keep
				// waiting for it to disappear, but never escalate by pid alone.
				stoppedCanSignal = false;
			} else {
				// I-7: the identity query shells out to ps/powershell, and this loop
				// runs every 250ms for as long as the process survives. A synchronous
				// fork here stalls the supervisor's single thread — every client
				// command and every worker frame waits for it — which is the shape the
				// async twin exists to avoid; it also bounds a wedged helper to 5s
				// instead of hanging this finalizer forever.
				const observed = await getProcessStartIdAsync(pid);
				if (observed === undefined) {
					unobservableIdentityChecks++;
				} else {
					unobservableIdentityChecks = 0;
				}
				stoppedVerdict = observed !== processStartId ? observed === undefined : true;
				stoppedCanSignal = observed === processStartId;
			}
			return stoppedVerdict;
		};
		const startedAt = Date.now();
		const sigkillDeadline = startedAt + STOP_FINALIZATION_SIGKILL_GRACE_MS;
		const giveUpAt = startedAt + STOP_FINALIZATION_MAX_MS;
		let killed = false;
		while (!this.shuttingDown) {
			if (!isStopGenerationCurrent()) {
				return;
			}
			if (!(await isStoppedProcessAlive())) {
				break;
			}
			if (Date.now() >= giveUpAt) {
				// Deliberately not `recordDegraded`: the global degraded flag is the
				// supervisor's "my own bookkeeping is untrustworthy" signal, and it makes
				// the failed-worker reaper defer every irreversible delete. One worker
				// that will not die must not stop the reaper from cleaning up the others,
				// so this stays a log line with the facts an operator needs.
				this.log(
					`Gave up finalizing the timed-out stop of worker ${worker.descriptor.workerId} after ` +
						`${Math.round((Date.now() - startedAt) / 1000)}s: pid ${pid} is still there ` +
						`(start identity ${processStartId ?? "none recorded"}, sigkill ${killed ? "sent" : "not sent"}, ` +
						`${unobservableIdentityChecks} consecutive unobservable identity checks). ` +
						`Its registration and stop tombstone are kept, so a later retry_worker, kill or restart can finish it.`,
				);
				return;
			}
			if (!killed && stoppedCanSignal && Date.now() >= sigkillDeadline) {
				// Recheck without the cache before signalling a possibly recycled pid.
				// An unobservable identity skips this attempt but keeps escalation
				// armed so a wedged worker is still killed on a later pass.
				const observedNow = processStartId === undefined ? undefined : await getProcessStartIdAsync(pid);
				if (processStartId === undefined || observedNow === processStartId) {
					signalProcessGroupOrProcess(pid, "SIGKILL");
					killed = true;
				}
			}
			await unrefDelay(STOP_FINALIZATION_RECHECK_MS);
		}
		// Retry transient cleanup failures (for example catalog archival) so a
		// dead worker's registration is never stranded permanently. Each attempt
		// bumps the worker's stopRevision, so rescission is detected through the
		// registration and tombstone instead of the waiting-phase snapshot.
		const isCleanupStillWanted = () =>
			this.workers.get(worker.descriptor.workerId) === worker &&
			worker.descriptor.stopRequestedAt !== undefined &&
			worker.descriptor.pid === pid;
		while (!this.shuttingDown && isCleanupStillWanted()) {
			try {
				await this.stopWorker(worker, true, true, worker.descriptor.archiveOnStop === true);
				this.log(`Finalized timed-out stop for worker ${worker.descriptor.workerId}`);
				return;
			} catch (error) {
				this.reportCleanupFailure(`timed-out worker stop ${worker.descriptor.workerId}`, error);
				await unrefDelay(STOP_FINALIZATION_RETRY_MS);
			}
		}
	}

	private async finalizeArchivedWorkerStop(worker: ResidentWorker): Promise<void> {
		const context = this.workerSessionArtifactContext(worker);
		if (!context) {
			return;
		}
		if (worker.descriptor.rootSessionId) {
			const cronStore = AgentCronJobStore.forSessionArtifacts();
			cronStore.registerSessionArtifact(worker.descriptor.rootSessionId, context.artifactDir);
			cronStore.cancelJobsForSession({
				sessionId: worker.descriptor.rootSessionId,
				sessionFile: context.sessionFile,
			});
			await this.catalog.archive(context.sessionFile, worker.descriptor.rootSessionId);
		}
	}

	private async cancelScheduledJobsForSessionTree(
		rootSessionId: string,
		rootSessionFile: string,
		stillWanted?: () => boolean,
		exclude?: ResidentWorker,
	): Promise<void> {
		const store = AgentCronJobStore.forSessionArtifacts();
		const sessions = [{ sessionId: rootSessionId, sessionFile: rootSessionFile }];
		const childrenByParent = new Map<string, SessionInfo[]>();
		for (const info of await this.rlmSpawnLedger().family()) {
			if (!info.parentSessionPath) continue;
			const key = canonicalSessionPath(info.parentSessionPath);
			childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), info]);
		}
		const queue = [canonicalSessionPath(rootSessionFile)];
		const visited = new Set(queue);
		while (queue.length > 0) {
			for (const info of childrenByParent.get(queue.shift()!) ?? []) {
				const child = canonicalSessionPath(info.path);
				if (visited.has(child)) continue;
				visited.add(child);
				sessions.push({ sessionId: info.id, sessionFile: info.path });
				queue.push(child);
			}
		}
		// A worker covering any tree member owns its stores again; a stale intent must not kill new schedules.
		for (const { sessionFile } of sessions) {
			try {
				if (this.findWorkerBySessionFile(sessionFile, exclude)) return;
			} catch {
				return;
			}
		}
		let registered = false;
		for (const { sessionId, sessionFile } of sessions) {
			const artifactDir = getSessionArtifactPathForFile(sessionFile, sessionId);
			if (!existsSync(join(artifactDir, SESSION_SCHEDULED_JOBS_FILENAME))) continue;
			store.registerSessionArtifact(sessionId, artifactDir);
			registered = true;
		}
		if (!registered) return;
		// Re-checked in the same synchronous turn as the walk: a promotion committed during the family read keeps its schedules.
		if (stillWanted && !stillWanted()) return;
		for (const { sessionFile } of sessions) {
			store.cancelJobsForSession({ sessionFile });
		}
	}

	private async cancelEphemeralWorkerScheduledJobs(worker: ResidentWorker): Promise<boolean> {
		const context = this.workerSessionArtifactContext(worker);
		if (!context || !worker.descriptor.rootSessionId) {
			return true;
		}
		try {
			await this.cancelScheduledJobsForSessionTree(
				worker.descriptor.rootSessionId,
				context.sessionFile,
				() => worker.descriptor.ownerClientId !== undefined,
				worker,
			);
			return true;
		} catch (error) {
			// A promotion that landed during the failed read means the cancel is no longer wanted.
			if (worker.descriptor.ownerClientId === undefined) {
				return true;
			}
			this.log(
				`Could not cancel scheduled jobs for client-owned worker ${worker.descriptor.workerId}: ${String(error)}`,
			);
			return false;
		}
	}

	private reclaimStoppedWorkerCronLock(worker: ResidentWorker): void {
		const context = this.workerSessionArtifactContext(worker);
		if (!context) {
			return;
		}
		rmSync(join(context.artifactDir, `${SESSION_SCHEDULED_JOBS_FILENAME}.lock`), { recursive: true, force: true });
	}

	private workerSessionArtifactContext(worker: {
		descriptor: DaemonWorkerDescriptor;
	}): { sessionFile: string; artifactDir: string } | undefined {
		const sessionFile = worker.descriptor.sessionFile ?? worker.descriptor.createCommand.sessionPath;
		if (!sessionFile || !worker.descriptor.rootSessionId) {
			return undefined;
		}
		return {
			sessionFile,
			artifactDir: getSessionArtifactPathForFile(sessionFile, worker.descriptor.rootSessionId),
		};
	}

	private persistWorkerStopTombstone(worker: ResidentWorker, archiveSession = false): void {
		worker.intentionalStop = true;
		worker.descriptor.stopRequestedAt ??= new Date().toISOString();
		worker.descriptor.archiveOnStop ||= archiveSession;
		this.persistWorker(worker);
	}

	private write(client: DaemonSocketClient, message: DaemonOutbound): boolean {
		return this.writeSerialized(client, serializeJsonLine(message));
	}

	private broadcastHeartbeatsChanged(): void {
		this.scheduleScheduledSessionWakeRecompute();
		for (const client of this.clients) {
			this.write(client, { type: "heartbeats_changed" });
		}
	}

	private writeSerialized(client: DaemonSocketClient, line: string | Uint8Array): boolean {
		if (client.socket.destroyed) {
			return false;
		}
		const accepted = client.socket.write(line);
		if (!accepted) {
			client.backpressured = true;
		}
		return accepted;
	}

	private registerSignalHandlers(): void {
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}
		for (const signal of signals) {
			const handler = () =>
				this.background(
					this.shutdown(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143, false),
					`${signal} shutdown`,
				);
			process.on(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
		const exitHandler = () => this.cleanupSocket();
		process.on("exit", exitHandler);
		this.signalCleanupHandlers.push(() => process.off("exit", exitHandler));
	}

	private assertSocketLeaseHeld(): void {
		const compromise = this.socketLeaseCompromise ?? this.socketLease?.compromise;
		if (compromise) throw new Error(`Daemon socket lease was compromised: ${compromise.message}`);
	}

	private assertSupervisorServing(): void {
		this.assertSocketLeaseHeld();
		if (this.shuttingDown) {
			const error = new Error(`Daemon supervisor generation ${this.generation} is shutting down; retry the command`);
			Object.assign(error, { code: "supervisor_generation_stale" as const });
			throw error;
		}
	}

	private fenceSupervisorSocket(): void {
		try {
			this.server?.close();
		} catch {
			// The server may already be closed by a concurrent shutdown.
		}
		for (const client of this.clients) {
			client.detachInput();
			client.socket.destroy();
		}
	}

	private handleSocketLeaseCompromised(error: Error): void {
		if (this.socketLeaseCompromise) return;
		this.socketLeaseCompromise = error;
		this.shuttingDown = true;
		this.fenceSupervisorSocket();
		const message = `Daemon socket lease was compromised; relinquishing supervisor ownership: ${error.message}`;
		try {
			this.log(message);
		} catch {
			console.error(message);
		}
		if (!this.startupComplete) return;
		void this.cleanupSupervisorResources().catch((cleanupError) =>
			this.reportCleanupFailure("compromised daemon socket lease", cleanupError),
		);
	}

	private cleanupSocket(): void {
		if (!this.ownsSocketPath) {
			return;
		}
		this.ownsSocketPath = false;
		const identity = this.socketIdentity;
		this.socketIdentity = undefined;
		cleanupDaemonSocketPath(this.socketPath, identity, this.socketLease);
	}

	private async cleanupSupervisorResources(): Promise<void> {
		if (this.cleanupPromise) {
			return this.cleanupPromise;
		}
		this.cleanupPromise = this.cleanupSupervisorResourcesOnce();
		return this.cleanupPromise;
	}

	private async cleanupSupervisorResourcesOnce(): Promise<void> {
		this.shuttingDown = true;
		this.clearIdleEvictionTimer();
		this.clearScheduledWakeTimer();
		this.clearRosterWatchdogTimer();
		this.clearFailedWorkerReaperTimer();
		this.clearRetentionSweepTimer();
		this.clearAdoptionRetryTimers();
		await this.idleEvictionSweep?.catch(() => undefined);
		for (const cleanup of this.signalCleanupHandlers.splice(0)) {
			await this.runCleanupStep("signal handler", cleanup);
		}
		const uninstallCrashHandlers = this.uninstallCrashHandlers;
		this.uninstallCrashHandlers = undefined;
		if (uninstallCrashHandlers) {
			await this.runCleanupStep("crash handler", uninstallCrashHandlers);
		}
		const server = this.server;
		this.server = undefined;
		const serverClosed = new Promise<void>((resolveClose) => {
			if (!server?.listening) {
				resolveClose();
				return;
			}
			try {
				server.close(() => resolveClose());
			} catch (error) {
				this.reportCleanupFailure("daemon server", error);
				resolveClose();
			}
		});
		for (const client of this.clients) {
			client.attachedActiveSessionIds.clear();
			await this.runCleanupStep(`daemon client input ${client.id}`, () => client.detachInput());
			await this.runCleanupStep(`daemon client socket ${client.id}`, () => {
				client.socket.destroy();
			});
		}
		this.clients.clear();
		for (const worker of this.workers.values()) {
			if (worker.ownerCleanupTimer) {
				clearTimeout(worker.ownerCleanupTimer);
				worker.ownerCleanupTimer = undefined;
			}
			await this.runCleanupStep(`worker client ${worker.descriptor.workerId}`, () => worker.client?.close());
			worker.client = undefined;
			const transcripts = new Set(worker.transcriptCaches.values());
			for (const generations of worker.snapshotGenerations?.values() ?? []) {
				for (const generation of generations.values()) {
					transcripts.add(generation.transcript);
					this.settleSnapshotDuplicateValidation(
						generation,
						new Error("Daemon supervisor stopped during snapshot transfer"),
					);
					if (!generation.transcript.complete) {
						generation.transcript.markFailed(new Error("Daemon supervisor stopped during snapshot transfer"));
					}
				}
			}
			for (const transcript of transcripts) {
				await this.runCleanupStep(`worker transcript ${worker.descriptor.workerId}`, () => transcript.dispose());
			}
			worker.transcriptCaches.clear();
			worker.snapshotGenerations?.clear();
			worker.snapshotCache.clear();
			worker.snapshotLoads.clear();
		}
		this.workers.clear();
		this.openingWorkers.clear();
		this.catalogOpeningWorkers.clear();
		await this.runCleanupStep("daemon catalog", () => this.catalog.stop());
		await this.runCleanupStep("daemon server", () => serverClosed);
		await this.runCleanupStep("daemon socket", () => this.cleanupSocket());
		await this.runCleanupStep("supervisor cache", () => {
			rmSync(this.snapshotCacheRoot, { recursive: true, force: true });
		});
		const lease = this.socketLease;
		this.socketLease = undefined;
		await this.runCleanupStep("daemon socket lock", async () => lease?.release());
		const ownership = this.ownership;
		this.ownership = undefined;
		await this.runCleanupStep("daemon ownership", async () => ownership?.release());
	}

	private async runCleanupStep(label: string, action: () => void | Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			this.reportCleanupFailure(label, error);
		}
	}

	private reportCleanupFailure(label: string, error: unknown): void {
		const message = `Failed to clean up ${label}: ${String(error)}`;
		try {
			this.log(message);
		} catch {
			console.error(message);
		}
	}

	private async shutdown(
		exitCode: number,
		stopWorkers: boolean,
		relaunch = false,
		forceWorkers = false,
		closingReason?: DaemonClosingReason,
	): Promise<never> {
		if (this.shuttingDown) {
			process.exit(exitCode);
		}
		this.shuttingDown = true;
		// P1-7c/B10: answer every pending delivery before the workers go, so a
		// sender still waiting learns the message was not delivered instead of
		// watching the daemon leave with it.
		this.drainPendingDeliveries("shutdown");
		this.clearIdleEvictionTimer();
		this.clearScheduledWakeTimer();
		this.clearRosterWatchdogTimer();
		this.clearFailedWorkerReaperTimer();
		this.clearAdoptionRetryTimers();
		await this.idleEvictionSweep?.catch(() => undefined);
		if (closingReason) {
			for (const client of this.clients) {
				this.write(client, { type: "daemon_closing", reason: closingReason });
			}
		}
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		if (stopWorkers) {
			await Promise.all(
				[...this.workers.values()].map(async (worker) => {
					try {
						await this.stopWorker(worker, true, forceWorkers, true);
					} catch (error) {
						if (!(error instanceof WorkerStopTimeoutError)) {
							throw error;
						}
						this.log(
							`Worker ${worker.descriptor.workerId} remains tombstoned for recovery after shutdown: ${error.message}`,
						);
					}
				}),
			);
			if (!this.hasPersistedWorkerDescriptors()) {
				rmSync(this.supervisorConfigPath, { force: true });
			}
		} else {
			for (const worker of this.workers.values()) {
				worker.intentionalStop = true;
				worker.client?.close();
				worker.client = undefined;
			}
		}
		await this.catalog.stop();
		for (const client of this.clients) {
			client.detachInput();
			client.socket.end();
		}
		await new Promise<void>((resolveClose) => this.server?.close(() => resolveClose()) ?? resolveClose());
		await this.runCleanupStep("daemon socket", () => this.cleanupSocket());
		await this.runCleanupStep("supervisor cache", () => {
			rmSync(this.snapshotCacheRoot, { recursive: true, force: true });
		});
		const lease = this.socketLease;
		this.socketLease = undefined;
		await this.runCleanupStep("daemon socket lock", async () => lease?.release());
		const ownership = this.ownership;
		this.ownership = undefined;
		await this.runCleanupStep("daemon ownership", async () => ownership?.release());
		if (relaunch) {
			const launch = createCliSubprocessLaunchSpec(["--mode", "daemon", "--daemon-socket", this.socketPath]);
			const environment = createCliSubprocessEnv();
			delete environment[DAEMON_CATALOG_ROLE_ENV];
			delete environment[DAEMON_WORKER_ROLE_ENV];
			delete environment[DAEMON_WORKER_TOKEN_ENV];
			delete environment[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
			delete environment[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			delete environment[DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
			delete environment[ORPHAN_PROCESS_JOURNAL_ENV];
			delete environment[SESSION_LEASES_ENABLED_ENV];
			delete environment[SESSION_LEASE_OWNER_ID_ENV];
			const replacement = spawnHidden(launch.command, launch.args, {
				cwd: this.defaultSessionConfig.cwd ?? process.cwd(),
				detached: true,
				env: environment,
				stdio: "ignore",
			});
			replacement.unref();
		}
		process.exit(exitCode);
	}
}
