import { ESCALATED_EMPTY_TURN_RETRY_DEFAULTS } from "@earendil-works/pi-agent-core";
import type { ServiceTier, Transport } from "@earendil-works/pi-ai";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { sleepSync } from "../utils/sleep.js";
import { clampCompactionTriggerRatio } from "./compaction/compaction.js";
import { DEFAULT_EXTENSION_HANDLER_TIMEOUT_MS } from "./extensions/timeout.js";
import { RETIRED_VENV_RETENTION } from "./kernel/venv-in-use.js";
import {
	PROVIDER_LONG_WAIT_BASE_MS,
	PROVIDER_LONG_WAIT_MAX_MS,
	PROVIDER_LONG_WAIT_MAX_ROUNDS,
} from "./provider-fallback.js";
import { MAX_PROVIDER_PAUSE_MS, type ProviderWaitPolicy } from "./provider-retry.js";
import type { ResolvedRetentionSettings } from "./retention/types.js";
import {
	readSpendPriceOverrides,
	SPEND_PRICE_OVERRIDES_PATH,
	type SpendPriceOverrideProblem,
	type SpendPriceOverrides,
	type SpendPriceRateOverride,
} from "./spend-pricing.js";

const RECENT_MODELS_LIMIT = 20;
export const DEFAULT_IDLE_EVICTION_MINUTES = 90;
export const DEFAULT_CHILD_IDLE_EVICTION_MINUTES = 20;

/**
 * Poll interval for noticing a direct edit of `settings.json` (CD-5). One second
 * is fast enough that a hand edit lands while the user is still looking at the
 * terminal, and cheap enough that two `stat` calls per second are invisible.
 */
export const DEFAULT_SETTINGS_WATCH_INTERVAL_MS = 1000;

/** Abort a provider stream after this long without any events (0 = disabled). */
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 300_000;

/**
 * Default per-tool-call wall-clock deadline (0 = disabled). Configurable within
 * [TOOL_TIMEOUT_MIN_AFTER_MS, TOOL_TIMEOUT_MAX_AFTER_MS]; a tool can refine its own
 * budget via `AgentTool.executionTimeoutMs`, but the `tools.timeout` handles here
 * stay the master switches.
 */
export const DEFAULT_TOOL_TIMEOUT_AFTER_MS = 180_000;
/** Soft floor for `tools.timeout.afterMs` (one minute): below this, deadlines fire mid-handshake. */
export const TOOL_TIMEOUT_MIN_AFTER_MS = 60_000;
/** Soft ceiling for `tools.timeout.afterMs` (ten minutes): beyond this, the stall watchdog owns the call. */
export const TOOL_TIMEOUT_MAX_AFTER_MS = 600_000;
/** Default silence after which a call with no output and no progress is stuck (five minutes). */
export const DEFAULT_SILENT_STUCK_SECONDS = 300;
/** Floor for `silentStuckSeconds`; in practice the per-call deadline (at least a minute) is asked first. */
export const SILENT_STUCK_MIN_SECONDS = 1;
export const SILENT_STUCK_MAX_SECONDS = 3600;

/** Session stall watchdog: warn after this long without any session activity. */
export const DEFAULT_STALL_WARN_AFTER_SECONDS = 300;

/**
 * Session stall watchdog: abort the turn after this long without any session
 * activity. `0` - the default - is warn-only: report the silent turn, never abort it.
 * A positive value must exceed the warn threshold.
 *
 * This fork's default used to be 900 (15 min). It changed because the abort held
 * authority it cannot justify: silence is the normal state of legitimate long work (a
 * quiet build, a cell awaiting a long job, a subprocess that only reports at the end),
 * and the exemption allowlist that tried to tell silence apart from a wedge can never
 * be complete, so real work was killed. Upstream has no session watchdog at all.
 *
 * The warn stage is what carries the signal now: it reaches the roster and, for a
 * subagent, its parent's transcript, so the agent that owns the child can look at it
 * and cancel it with `rlm.delete_subagent` when it really is wedged. A decision made by
 * something that can see the work beats a timer that cannot. Set a positive value to
 * opt back into the automatic abort.
 */
export const DEFAULT_STALL_ABORT_AFTER_SECONDS = 0;

/** r4 recovery-shell: how long the sweep waits after first observing a child's stall before acting. */
export const DEFAULT_SUBAGENT_STALL_RECOVERY_GRACE_SECONDS = 300;

/** r4 recovery-shell: human window for a depth-0 session with an attached client; 0 in effect means "no human wait". */
export const DEFAULT_ROOT_STALL_RECOVERY_HUMAN_WINDOW_SECONDS = 120;

/** r4 recovery-shell: consecutive auto actions per session before the stop line (children and roots alike); 0 arms the line immediately (notify only). */
export const DEFAULT_STALL_RECOVERY_MAX_PER_SESSION = 3;

function nonNegativeFinite(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Bound on waiting for the shared kernel-venv bootstrap lock before the boot
 * fails with an actionable error. Without it a wedged lock holder hangs the
 * kernel start until the session stall watchdog aborts the turn.
 */
export const DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS = 300_000;

/**
 * Kernel revival budget (C8): how many unexpected exits one session may revive inside the sliding
 * window before it fails closed with `KernelUnavailableError`. Unbounded revival is the failure
 * mode this bounds - each attempt costs a venv check, a snapshot restore and a bootstrap.
 */
export const DEFAULT_KERNEL_MAX_RESTARTS = 3;
/** Sliding window the revival budget is counted over, in minutes. */
export const DEFAULT_KERNEL_RESTART_WINDOW_MINUTES = 60;
/**
 * Age bound on the revival vouch (B7): a revival excuses a silent turn only while it is plausibly
 * still working (spawn, restore, bootstrap). Ten minutes covers a cold `uv` bootstrap plus a large
 * snapshot read; past that the watchdog warns and aborts again.
 */
export const DEFAULT_KERNEL_REVIVAL_VOUCH_MAX_AGE_SECONDS = 600;

/**
 * Hours a failed session-worker registration is kept before the supervisor's
 * reaper archives it to the daemon log and removes the descriptor (C17).
 */
export const DEFAULT_FAILED_WORKER_REAP_HOURS = 24;

/** Disk-retention sweep defaults (see RetentionSettings and core/retention/). */
export const DEFAULT_RETENTION_SWEEP_INTERVAL_MINUTES = 60;
export const DEFAULT_RETENTION_MAX_DELETE_BYTES_PER_SWEEP = 512 * 1024 * 1024;
export const DEFAULT_RETENTION_MAX_DELETE_ENTRIES_PER_SWEEP = 20_000;
export const DEFAULT_RETENTION_COOLDOWN_MINUTES = 10;
export const DEFAULT_RETENTION_EMPTY_ARTIFACT_DIR_DAYS = 7;
export const DEFAULT_RETENTION_DELETED_SESSION_RESIDUE_DAYS = 7;
/**
 * Deleted (tombstoned) children's transcripts are reclaimed like any other
 * deleted-session residue: the durable record is the display tombstone plus the
 * ledger delete record, not the transcript bytes (r38 LIFE-2).
 */
export const DEFAULT_RETENTION_CHILD_TRANSCRIPT_DAYS = 30;
export const DEFAULT_RETENTION_LOG_FILE_DAYS = 14;
export const DEFAULT_RETENTION_TMP_RLM_DIR_HOURS = 24;
export const DEFAULT_RETENTION_BASH_TEMP_FILE_HOURS = 24;
export const DEFAULT_RETENTION_BASH_TEMP_FILE_MAX_BYTES = 256 * 1024 * 1024;
export const DEFAULT_RETENTION_STALE_LEASE_HOURS = 24;
export const DEFAULT_RETENTION_KERNEL_SNAPSHOT_GENERATIONS = 1;

/**
 * Bounds on waiting for an agent-message target that is mid-transition (P1-1 / C14).
 *
 * One knob drives all four waits: `targetWaitSeconds` is the longest tier (waiting for a session
 * to finish passivating) and the three shorter ones are half of it, so an operator tuning the
 * wait cannot leave a tier unbounded by forgetting it. `0` removes every bound, which is the
 * rollback lever back to today's "wait as long as the parent turn lives".
 *
 * Switch dossier (F17 - ship, observe one round, then retune):
 * owner: the agent-messaging reviewer of this batch; review: two weeks after this ships;
 * criterion: the p95 of the `waitedMs` field on the `agent message target wait timed out`
 * signature - if p95 sits far below a tier, that tier is too long; if a tier times out on waits
 * that later succeeded, it is too short; rollback: raise `agentMessage.targetWaitSeconds`
 * (or set it to 0 for unbounded).
 */
export interface AgentMessageSettings {
	targetWaitSeconds?: number; // default: 120; 0 = unbounded waits
}

/** The four bounded waits, resolved to ms. `Infinity` means the bound is disabled. */
export interface ResolvedAgentMessageWaitSettings {
	/** Waiting for a target session to finish passivating. */
	passivationMs: number;
	/** Waiting for an active session to finish binding. */
	bindMs: number;
	/** Waiting for a passive subagent chain to hydrate. */
	hydrateMs: number;
	/** Waiting for an in-flight rlm child to publish its session. */
	publicationMs: number;
}

/** Longest agent-message wait tier (C14 乙长值): a cold hydration must not be forced to retry. */
export const DEFAULT_AGENT_MESSAGE_TARGET_WAIT_SECONDS = 120;

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
	agentCallable?: boolean; // default: true - expose the compact skill so the model can request compaction
	/**
	 * Share of the provider's real input limit at which threshold compaction fires.
	 * default: 0.8; clamped to [0.5, 0.95] (see clampCompactionTriggerRatio).
	 */
	triggerRatio?: number;
	/**
	 * default: true - an incoming agent message (a child's reply, a peer, a notice)
	 * queues behind compaction instead of starting a turn on an over-threshold
	 * context. false restores the old behavior, where the message wins and the
	 * compaction waits for the next turn boundary.
	 */
	priorityOverAgentMessages?: boolean;
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface AutoRefineSettings {
	enabled?: boolean; // default: true
	turnInterval?: number; // default: 25 assistant turns
	compact?: boolean; // default: true
	cooldownMs?: number; // default: 20 minutes
}

export interface ProviderWaitSettings {
	enabled?: boolean; // default: true - bounded wait for quota/unavailability recovery
	baseDelayMs?: number; // default: 1000 (first ping delay)
	maxDelayMs?: number; // default: 300000 (per-ping ceiling, 5m)
	maxAttempts?: number; // default: 30 (abort bound: max pings)
	maxWaitMs?: number; // default: 900000 (abort bound: max total wait, 15m)
	pauseUntilReset?: boolean; // default: true - park quota-blocked sessions until the provider-reported reset
	maxPauseMs?: number; // default: 86400000 (abort bound: max single park, 24h; clamped to 7d)
	maxParks?: number; // default: 8 (abort bound: max parks per quota episode)
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // provider-failure retries; the provider-retry module's count (0 disables them), default: retry.maxRetries
	maxRetryDelayMs?: number; // default: 60000 (max server-requested retry delay before failing; 0 disables the cap)
	streamStallTimeoutMs?: number; // default: 300000 (5 min with zero stream events => abort + retryable error); 0 disables
	/** Bounded wait-for-recovery loop for quota exhaustion and provider unavailability. */
	waitForUsage?: ProviderWaitSettings;
	/**
	 * Long waits once every fallback-chain model failed and the bounded wait ran
	 * out: the delay doubles per round from `baseDelayMs` (default 5 min) up to
	 * `maxDelayMs` (default 20 min), for at most `maxRounds` rounds (default 72,
	 * about a day) before the turn ends.
	 */
	fallbackLongWait?: { baseDelayMs?: number; maxDelayMs?: number; maxRounds?: number };
}

export interface EmptyTurnRetrySettings {
	maxAttempts?: number; // default: 3 total provider attempts for one turn
	baseDelayMs?: number; // default: 500, doubled per attempt
	maxDelayMs?: number; // default: 4000 cap for a single wait
	maxTotalDelayMs?: number; // default: bounded by the remaining attempts
	/**
	 * Escalated slow tier (r4 recovery): additional provider attempts after the fast
	 * ones are spent, with much longer waits. `0` disables the tier; default 3
	 * attempts at 30s/60s/120s. The session clamps the single-wait cap below
	 * `stallWatchdog.warnAfterSeconds` so a planned recovery wait is never reported
	 * as a stall.
	 */
	escalatedAttempts?: number; // default: 3
	escalatedBaseDelayMs?: number; // default: 30000, doubled per slow attempt
	escalatedMaxDelayMs?: number; // default: 120000, clamped below the stall warn threshold
	/** Resolved single-wait ceiling the loop clamps base and cap to (see EmptyTurnRetryConfig). */
	escalatedMaxDelayClampMs?: number;
	escalatedMaxTotalDelayMs?: number; // default: 300000 summed slow-tier waits
	/**
	 * Recovery continuation (r4 recovery): when the whole ladder is exhausted, the
	 * session queues one custom message so the model gets a turn to recover the task
	 * itself instead of the run ending silently.
	 */
	recovery?: EmptyTurnRecoverySettings;
}

export interface EmptyTurnRecoverySettings {
	/** Default true. Off means an exhausted ladder ends the run with the terminal error only. */
	enabled?: boolean;
	/**
	 * Recovery continuations allowed per failure episode (default 1). The second
	 * exhaustion in the same episode is the hard stop - a recovery turn that also
	 * comes back empty must not spawn another one.
	 */
	maxContinuations?: number;
	/**
	 * Reserved, no effect (r4 v1): the backup-model gear of the ladder - running the
	 * recovery continuation on `providerBackupModel` instead of the primary - is off
	 * by default and not wired in this build. Registered so the key round-trips
	 * through settings without a schema change when the gear lands.
	 */
	useBackupModel?: boolean;
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	emptyTurn?: EmptyTurnRetrySettings;
	provider?: ProviderRetrySettings;
}

/**
 * Last-resort protection against sessions that go quiet mid-turn (dead provider
 * stream, wedged tool, loop that never settles). While a turn is running, the
 * watchdog warns after `warnAfterSeconds` without any session event, and aborts the
 * turn after `abortAfterSeconds` when that is a positive value; the default `0` keeps
 * it warn-only. Both thresholds count from the last observed activity; timer
 * escalations are deferred while compaction, branch summaries, or serialized
 * refinement own the turn boundary.
 *
 * A dead provider stream is handled separately and is unaffected by this setting:
 * `retry.provider.streamStallTimeoutMs` aborts the stream itself and settles the turn
 * with a retryable error.
 */
export interface StallWatchdogSettings {
	enabled?: boolean; // default: true
	warnAfterSeconds?: number; // default: 300 (5 min silent => warning + diagnostics)
	abortAfterSeconds?: number; // default: 0 (warn-only: report the silence, never abort); a positive value must exceed warnAfterSeconds
	/**
	 * Defer the auto-abort escalation while kernel/host facts vouch that externally
	 * owned work is in flight (a live bash handle, an in-flight host request, a live
	 * kernel loop awaiting the cell). Default true. The warning is never suppressed,
	 * and the deferral is bounded by the watchdog's exemption budget.
	 */
	toolLivenessExemption?: boolean;
	/**
	 * Reserved, no effect: treating kernel CPU progress as session activity is a
	 * pending product decision. Registered so the key round-trips through settings
	 * without a schema change later. Default false.
	 */
	treatKernelCpuProgressAsActivity?: boolean;
	/** Automatic recovery of depth-0 sessions (r4 recovery-shell, mechanism ④-B). */
	rootRecovery?: RootStallRecoverySettings;
}

/** Parent block for the subagent-facing recovery settings (r4 recovery-shell). */
export interface SubagentsSettings {
	stallRecovery?: SubagentStallRecoverySettings;
}

/**
 * Resolved stall-watchdog settings. The two exemption keys are optional so a caller
 * (or a test double) that only knows the three original thresholds still type-checks;
 * readers apply the documented defaults (exemption on, CPU-as-activity off).
 */
export interface ResolvedStallWatchdogSettings {
	enabled: boolean;
	warnAfterSeconds: number;
	abortAfterSeconds: number;
	toolLivenessExemption?: boolean;
	treatKernelCpuProgressAsActivity?: boolean;
}

/**
 * Automatic stall recovery for RLM subagents (r4 recovery-shell, mechanism ③).
 * After the watchdog warns and the session stays dead for `graceSeconds`, the
 * daemon sweep interrupts the turn and queues a system instruction asking the
 * child to change approach - once per (session, turn), never an automatic
 * re-dispatch. `subagents.stallRecovery.enabled: false` is the rollback handle
 * that returns to "notify only".
 */
export interface SubagentStallRecoverySettings {
	/**
	 * Unset: on only when `stallWatchdog.abortAfterSeconds` > 0 (the owner opted into
	 * silence kills). Silence is the normal state of long work, and an unattended owner
	 * loses real work to an interrupt, so the automatic action is opt-in. Off means the
	 * daemon never acts on a silent child - notice only.
	 */
	enabled?: boolean;
	/**
	 * How long the sweep waits after first observing the stall before acting, in seconds.
	 * Default 300. Like every numeric key in this block, 0 is honored rather than folded
	 * back to the default: the sweep acts as soon as the evidence confirms.
	 */
	graceSeconds?: number;
	/**
	 * Consecutive auto actions per session before the stop line: only notifications
	 * after that. Default 3. 0 = notify only: the stop line arms before any action,
	 * so the sweep never acts on this session - the notify-only variant of the
	 * `enabled` rollback handle.
	 */
	maxPerSession?: number;
}

/** Resolved {@link SubagentStallRecoverySettings} with the documented defaults filled in. */
export interface ResolvedSubagentStallRecoverySettings {
	enabled: boolean;
	graceSeconds: number;
	maxPerSession: number;
}

/**
 * Automatic stall recovery for depth-0 sessions (r4 recovery-shell, mechanism
 * ④-B): the same sweep, the same bounded action (interrupt + system
 * instruction), a different wait policy. No attached client means nobody is
 * watching, so the wait collapses; an attached client gets a human window in
 * which any input cancels the auto action for that episode. `stallWatchdog.
 * rootRecovery.enabled: false` is the rollback handle that returns a main
 * session to warn-only.
 */
export interface RootStallRecoverySettings {
	/**
	 * Unset: on only when `stallWatchdog.abortAfterSeconds` > 0, for the same reason as
	 * `subagents.stallRecovery.enabled`. Off means the daemon never acts on a silent main
	 * session - warn only.
	 */
	enabled?: boolean;
	/** Human window while a client is attached, in seconds; 0 means act as soon as the evidence confirms. Default 120. */
	humanWindowSeconds?: number;
	/**
	 * Consecutive auto actions per session before the stop line: only notifications
	 * after that. Default 3. 0 = notify only: the stop line arms before any action,
	 * so the sweep never acts on this session - the notify-only variant of the
	 * `enabled` rollback handle. Key semantics stay aligned with humanWindowSeconds:
	 * every numeric key in this block honors an explicit 0.
	 */
	maxPerSession?: number;
}

/** Resolved {@link RootStallRecoverySettings} with the documented defaults filled in. */
export interface RootStallRecoverySettingsResolved {
	enabled: boolean;
	humanWindowSeconds: number;
	maxPerSession: number;
}

/**
 * Whether a queued subagent message may wake a session whose input pump was
 * suspended (a user Esc or a stall-watchdog kill).
 * - "never": nothing wakes the pump; queued work waits for user input, an attach
 *   or an explicit resume, and undeliverable terminal notices are persisted.
 * - "failure_aggregated" (default): only failure-class terminal notices wake it,
 *   as one aggregated turn per quiet window, so Esc keeps meaning "stop".
 * - "always": every queued agent message wakes the pump (the pre-P0-3 behaviour).
 */
export type SubagentWakePolicy = "never" | "failure_aggregated" | "always";

export interface SubagentWakeSettings {
	policy?: SubagentWakePolicy; // default: "failure_aggregated"
}

/**
 * Kernel venv bootstrap knobs. `lockTimeoutMs` bounds how long a boot waits for
 * the machine-wide bootstrap lock; 0 disables the bound (waits forever),
 * matching the `extensionHandlerTimeoutMs` convention in this file.
 */
export interface KernelBootstrapSettings {
	lockTimeoutMs?: number; // default: 300000 (5 min); 0 waits forever
}

/**
 * Kernel revival knobs (C8/B7). A kernel that dies on its own is revived by the next cell, and
 * the budget bounds how often that may happen before the session fails closed instead of looping
 * a venv rebuild, a restore and a bootstrap per cell. Every value is read live, so an edit
 * applies to the next kernel death without a restart; `0` is the documented rollback lever for
 * each bound (`maxUnexpectedRestarts: 0` revives without limit, `revivalVouchMaxAgeSeconds: 0`
 * lets a revival vouch for silence indefinitely).
 */
export interface KernelRestartSettings {
	maxUnexpectedRestarts?: number; // default: 3 per window; 0 = unlimited (rollback lever)
	windowMinutes?: number; // default: 60 (sliding)
	revivalVouchMaxAgeSeconds?: number; // default: 600 (10 min); 0 = unbounded
}

/** Resolved kernel revival policy, in the units the kernel and watchdog code uses. */
export interface ResolvedKernelRestartSettings {
	maxUnexpectedRestarts: number;
	windowMs: number;
	revivalVouchMaxAgeMs: number;
}

/**
 * Daemon supervisor policy knobs. Every default is the shipped behaviour, so an
 * absent `daemon` section changes nothing.
 */
export interface DaemonSettings {
	/**
	 * What a client does when it detects a gap inside one daemon event generation.
	 * "log" records the gap only; "recover" also re-pulls the session snapshot.
	 * Default: "log" — flipping to "recover" is gated on a zero-false-positive
	 * observation window.
	 */
	eventGapRecovery?: "log" | "recover"; // default: "log"
	/**
	 * Exit(1) once this many unhandled rejections land inside one hour. Unset or 0
	 * keeps the shipped log-and-isolate behaviour (C18 default: off).
	 */
	supervisorRejectionExitThreshold?: number; // default: off
	/**
	 * Hours a failed worker registration is kept before the reaper archives and
	 * removes it. Default: 24; 0 or negative keeps failed workers forever.
	 */
	failedWorkerReapHours?: number; // default: 24
	/** Set false to disable the failed-worker reaper entirely. Default: true. */
	failedWorkerReapEnabled?: boolean; // default: true
}

/**
 * Disk-retention policy knobs for the periodic sweep (round-08 design,
 * /tmp/audit_r/round-08/disk-retention.md; implemented in core/retention/).
 *
 * Conventions, identical to `daemon.failedWorkerReapHours`: a day/hour knob of
 * `0` or negative switches that class off, and `retention.enabled: false` is the
 * master rollback lever (the sweep then only reports). The two circuit-breaker
 * caps are the exception: a non-positive value falls back to the shipped default
 * rather than removing the breaker, because "delete without a limit" is exactly
 * the failure mode the breaker exists for.
 */
export interface RetentionSettings {
	/** Master switch. Default: true. false = scan and report, never delete. */
	enabled?: boolean;
	/** Report what a sweep would reclaim without deleting anything. Default: false. */
	dryRun?: boolean;
	/** Periodic sweep interval in minutes; 0 or negative = no periodic sweep. Default: 60. */
	sweepIntervalMinutes?: number;
	/** Bytes one sweep may reclaim before it stops; non-positive = default. Default: 512 MiB. */
	maxDeleteBytesPerSweep?: number;
	/** Entries one sweep may reclaim before it stops; non-positive = default. Default: 20000. */
	maxDeleteEntriesPerSweep?: number;
	/** Any candidate touched more recently than this is kept. Default: 10. */
	cooldownMinutes?: number;
	/**
	 * The cross-process sweep guard. Default: true. With it, a second trigger of the
	 * sweep - another daemon, or `retention sweep` while a tick is running - reports
	 * the last sweep instead of walking the tree a second time. Set false to go back
	 * to concurrent sweeps.
	 */
	sweepLockEnabled?: boolean;
	/** Empty artifact directories of a provably gone session. Default: 7; 0 = off. */
	emptyArtifactDirDays?: number;
	/** Non-empty artifact directories left by a provably deleted session. Default: 7; 0 = off. */
	deletedSessionResidueDays?: number;
	/**
	 * Child transcripts (`sub-xxxxxxxx/<uuid>.jsonl`) older than this. Default: 30.
	 * A live child is kept by its ledger edge; a deleted child's transcript is
	 * residue of a provably deleted session whose durable record is elsewhere.
	 * 0 = off.
	 */
	childTranscriptDays?: number;
	/** Log files whose socket is gone. Default: 14; 0 = off. */
	logFileDays?: number;
	/** Empty `prime-agent-rlm-*` temp directories. Default: 24; 0 = off. */
	tmpRlmDirHours?: number;
	/** Any other `prime-agent-*` temp directory. Default: 0 (off, report-only). */
	tmpOtherDirDays?: number;
	/** `pi-bash-*.log` temp files. Default: 24; 0 = off. */
	bashTempFileHours?: number;
	/** Write-side cap for one `pi-bash-*.log` file; non-positive = default. Default: 256 MiB. */
	bashTempFileMaxBytes?: number;
	/** Lease directories whose owner is provably gone. Default: 24; 0 = off. */
	staleLeaseHours?: number;
	/** Retired kernel snapshot generations kept. Default: 1; negative = 0. */
	kernelSnapshotGenerations?: number;
	/** Kernel snapshot generation reclaim. Default: false (round-08 D-1). */
	kernelSnapshotReclaimEnabled?: boolean;
	/**
	 * Equivalence-compaction of over-bound RLM spawn ledgers. Default: true;
	 * false restores the fail-closed behavior (an over-bound ledger refuses both
	 * reads and appends until an operator intervenes).
	 */
	ledgerCompactionEnabled?: boolean;
	/** Retired kernel venv generations kept. Default: 1 (RETIRED_VENV_RETENTION). */
	venvRetention?: number;
	/**
	 * Let the sweep reclaim retired kernel venv generations. Default: false.
	 * The boot path already prunes with the generation it is about to spawn from
	 * excluded, and a sweep cannot name that generation (adversarial review F-2:
	 * without it, an unreferenced *active* generation can be removed). Turning this
	 * on keeps the newest generation of every build identity plus the newest retired
	 * one, and only reclaims generations no live kernel references.
	 */
	venvReclaim?: boolean;
}

export interface TerminalSettings {
	showImages?: boolean; // default: true (show image type and dimensions)
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
	fullscreen?: boolean; // default: true (alternate-screen rendering with scrollable transcript)
	fullscreenMouse?: boolean; // default: true
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

/** One autonomous-run budget limit: a positive number, or "unlimited" for no cap. */
export type AutonomousLimitSetting = number | "unlimited";

/**
 * Persisted defaults for autonomous-run budget limits. They apply when a run
 * starts without explicit `--autonomous-*` CLI or `/autonomous on` budget
 * flags; explicit flags keep winning per run.
 */
export interface AutonomousSettings {
	maxContinuations?: AutonomousLimitSetting;
	maxTurns?: AutonomousLimitSetting;
	maxTokens?: AutonomousLimitSetting;
	timeoutMs?: AutonomousLimitSetting;
}

/** Autonomous limit settings resolved to finite positive numbers; invalid entries are dropped. */
export interface ResolvedAutonomousLimits {
	maxContinuations?: number;
	maxTurns?: number;
	maxTokens?: number;
	timeoutMs?: number;
}

function resolveAutonomousLimit(value: AutonomousLimitSetting | undefined): number | undefined {
	if (value === "unlimited") {
		// Matches the runtime's UNLIMITED_AUTONOMOUS_LIMIT sentinel.
		return Number.MAX_SAFE_INTEGER;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return undefined;
	}
	// Truncate before validating so a positive fraction (e.g. 0.5) drops to
	// undefined instead of becoming a zero limit that stops the run immediately.
	const truncated = Math.trunc(value);
	return truncated > 0 ? truncated : undefined;
}

export type MermaidRenderingMode = "off" | "final" | "streaming";

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
	mermaid?: MermaidRenderingMode; // default: "streaming"
}

export interface BundledSkillsSettings {
	websearch?: boolean; // default: true
}

export interface ToolsSettings {
	/**
	 * Per-tool-call wall-clock deadline (r4 recovery): a tool call that settles
	 * nothing before this budget is cancelled on its own - through the same abort
	 * harvest the run abort uses - and the model receives the cancellation as an
	 * error tool result so it can change approach inside the same turn. The turn
	 * itself is never aborted by this deadline.
	 */
	timeout?: ToolTimeoutSettings;
}

export interface ToolTimeoutSettings {
	/** Default true. The master rollback handle: false disables deadlines everywhere, including per-tool budgets. */
	enabled?: boolean;
	/**
	 * Default 180000 (3 minutes), configurable within 60s-600s. `0` disables the
	 * deadline (the second rollback handle). Extensions on a live deadline are
	 * granted only by the stall watchdog's exemption evidence, never by a second budget.
	 */
	afterMs?: number;
	/**
	 * Operator-side per-tool budgets keyed by tool name, in ms. An entry outranks the
	 * tool's own `executionTimeoutMs`; `0` exempts that one tool from the deadline.
	 * Still gated by the master handles: with the deadline disabled, these do nothing.
	 */
	perTool?: Record<string, number>;
	/**
	 * Default 300 (5 minutes), configurable within 1s-3600s. A call that has produced
	 * no output and shows no progress (only a live process) for this long is stuck and
	 * is stopped; a call whose output keeps flowing is never stopped by this.
	 */
	silentStuckSeconds?: number;
	/**
	 * Default 1000. CPU time (ms) the step's process tree must burn between two checks
	 * to count as busy: a command that prints nothing but keeps computing is never stuck.
	 */
	silentStuckCpuMs?: number;
}

/** Self-recovery for unattended runs. */
export interface SelfRecoverySettings {
	/**
	 * Default true. When a main-session turn ends right after tool work with a reply that
	 * only announces the next step, send one automatic "continue" (at most two per prompt).
	 */
	autoContinue?: boolean;
	/**
	 * Default false. A subagent that finishes its task without replying is asked once to send
	 * its result. Off by default: the reply lands after the parent has already been told the
	 * child completed (with its answer preview), so it arrives as a duplicate and costs the
	 * parent an extra turn.
	 */
	childReplyNudge?: boolean;
}

export interface WarningSettings {
	anthropicExtraUsage?: boolean; // default: true
}

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
export type PackageSource =
	| string
	| {
			source: string;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

/**
 * Remote/local MCP server an integration connects to. Catalog services are
 * defined in the ai/mcp service catalog; this is for user-declared servers.
 * The kernel's generic mcp runtime reads creds from auth.json (`mcp:<name>`);
 * login/refresh/verification run host-side.
 */
export type McpServerConfig =
	| {
			type: "http";
			url: string;
			headers?: Record<string, string>;
			/** Env var holding a static bearer token (skips OAuth). */
			bearerTokenEnvVar?: string;
			/** Use the generic OAuth login flow for this server. */
			oauth?: boolean;
			/** Pre-registered OAuth client id for this server (optional). */
			oauthClientId?: string;
			/**
			 * Env var holding the OAuth client secret. When set, a missing or
			 * empty env value fails the login/refresh — never a stale stored
			 * secret fallback.
			 */
			oauthClientSecretEnvVar?: string;
			/** Client identity metadata document URL (CIMD) for this server. */
			oauthClientMetadataUrl?: string;
			/** Requested OAuth scopes for this server (config > PRM > omit). */
			oauthScopes?: string[];
			/** Force-disable even when credentials exist. */
			enabled?: boolean;
			enabledTools?: string[];
			disabledTools?: string[];
			startupTimeoutMs?: number;
			callTimeoutMs?: number;
	  }
	| {
			type: "stdio";
			command: string;
			args?: string[];
			cwd?: string;
			/** Environment variables resolved from the kernel environment. */
			env?: Record<string, { env: string }>;
			enabled?: boolean;
			enabledTools?: string[];
			disabledTools?: string[];
			startupTimeoutMs?: number;
			callTimeoutMs?: number;
	  };

export interface Settings {
	onboardingShown?: boolean;
	onboardingCompleted?: boolean;
	defaultProvider?: string;
	defaultModel?: string;
	subagentDefaultModel?: string; // "provider/id" for rlm.spawn without a pinned model; unset inherits the parent model
	updateChannel?: "stable" | "nightly"; // release channel for self-updates; unset follows the running version
	recentModels?: string[]; // "provider/id" keys, most-recently-used first
	// "provider/id" for background LLM passes (refinement review and planning);
	// unset falls back to the session model. Routing these to a different model
	// keeps their different prompt prefixes from evicting the session's provider
	// prefix-cache entry.
	auxiliaryModel?: string;
	// Auto-naming of session threads: "llm" derives a name from the first inbound
	// message and refines it once with a background title call; "first-message"
	// keeps only the deterministic name; "off" leaves sessions unnamed unless a
	// human names them. Default: "first-message" (the one-shot LLM title pass is
	// opt-in until it moves into the daemon idle sweep).
	autoSessionName?: "off" | "first-message" | "llm";
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	defaultServiceTier?: ServiceTier;
	rlmMaxDepth?: number; // default for new sessions; unset falls through to RLM_MAX_DEPTH, then 2
	idleEvictionMinutes?: number | "off"; // global daemon policy; default: 90
	childIdleEvictionMinutes?: number | "off"; // idle subagents close sooner; default: 20, capped by idleEvictionMinutes
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	stallWatchdog?: StallWatchdogSettings;
	/** RLM subagent stall-recovery policy (r4 recovery-shell, mechanism ③). */
	subagents?: SubagentsSettings;
	subagentWake?: SubagentWakeSettings;
	kernelBootstrap?: KernelBootstrapSettings;
	kernelRestart?: KernelRestartSettings;
	agentMessage?: AgentMessageSettings;
	daemon?: DaemonSettings;
	autoRefine?: AutoRefineSettings;
	agentTraces?: AgentTracesSettings;
	telemetry?: TelemetrySettings;
	footer?: FooterSettings;
	branchSummary?: BranchSummarySettings;
	retention?: RetentionSettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	/**
	 * User-defined backup model ("provider/model-id" or a bare model id) used
	 * while the primary model is quota-blocked or its provider is unavailable.
	 * Default: none - requests never silently switch models.
	 */
	providerBackupModel?: string;
	/**
	 * Models ("provider/model-id") the session moves to, in order, when the
	 * serving model keeps failing: quick retries exhausted on an unavailable
	 * provider, quota exhaustion, or a storm of invalid tool calls. The session
	 * stays on the fallback, probes the primary again after 30 minutes, and when
	 * every model fails waits in long rounds instead of ending the task.
	 * Entries without configured auth are skipped. Unset or `[]`: off.
	 */
	providerFallbackModels?: string[];
	/**
	 * Model ("provider/model-id" or a bare model id) that serves turns
	 * attaching images when the session model does not accept image input.
	 * Default: none - image turns on a text-only model fail with a
	 * configuration hint instead of silently dropping the images.
	 */
	imageModel?: string;
	autonomous?: AutonomousSettings;
	selfRecovery?: SelfRecoverySettings;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	mcpServers?: Record<string, McpServerConfig>; // User-declared MCP servers (name → config); built-ins are in the ai/mcp catalog
	mcpCatalogSources?: string[]; // Extra local MCP service catalog files (~-relative ok); merged after the built-in catalog, first source wins per id
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	/** Per-handler / factory timeout in ms. Default 30000; 0 disables the wall-clock timeout. */
	extensionHandlerTimeoutMs?: number;
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	bundledSkills?: BundledSkillsSettings; // Configure built-in skills shipped with Prime Agent
	tools?: ToolsSettings;
	enableBuiltinSkills?: boolean; // default: true - load built-in skills shipped with prime-agent
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default: "user-only"
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	ui?: UiSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	/** Log per-request provider timing phases to the diagnostic log. Default: false */
	requestTiming?: boolean;
}

export interface AgentTracesSettings {
	enabled?: boolean;
}

/**
 * Tuning for the sub-agent spend cell, for a user who wants a custom refresh
 * cadence instead of the built-in one.
 */
export interface SubagentSpendCellSettings {
	/**
	 * How often the cell's figure may go stale while a family works, in ms.
	 * Default {@link DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS}; clamped to
	 * [{@link MIN_SUBAGENT_SPEND_CELL_INTERVAL_MS}, {@link MAX_SUBAGENT_SPEND_CELL_INTERVAL_MS}],
	 * and a non-number falls back to the default rather than erroring (same
	 * discipline as `compaction.triggerRatio`).
	 */
	intervalMs?: number;
	/**
	 * Per-model price corrections, keyed `"<provider>/<model-id>"`, in the unit
	 * `models.json` writes `cost` in (per million tokens). Use it when a rate in
	 * `models.json` is wrong: the cell prices that model's recorded tokens with
	 * the corrected rates instead of the rate on the message, so the figure on
	 * screen changes too. A field left out, or a value that is not a finite
	 * number >= 0, falls back to the `models.json` rate (the unusable value is
	 * reported as a warning, never silently ignored). See `core/spend-pricing.ts`.
	 */
	priceOverrides?: Record<string, SpendPriceRateOverride>;
}

/** TUI v4 quiet-conversation switch (assistant-message.ts renders by it). */
export type ProcessModeSetting = "quiet" | "legacy";

/**
 * Behaviour of the interactive UI's own cells.
 */
export interface UiSettings {
	/**
	 * Show the sub-agent spend cell in the subagents tray line, and refresh it:
	 * `true`/absent keeps it on with the default cadence, `false` is the emergency
	 * switch (the cell renders nothing and the tray stops asking for the
	 * disk-scanning context tree at all - the counts and stall markers keep
	 * updating from the roster stream), and an object keeps it on with a custom
	 * cadence (see {@link SubagentSpendCellSettings}).
	 */
	subagentSpendCell?: boolean | SubagentSpendCellSettings;
	/**
	 * How the conversation renders an agent turn's process information
	 * (TUI v4): `quiet` (default) folds intermediate narration behind the
	 * turn footnote; `legacy` keeps the old full transcript. The switch
	 * protects the U6 lane users, who can flip back one key.
	 */
	processMode?: ProcessModeSetting;
	/**
	 * Minutes the owner must have been away (since their last own message) before
	 * opening a session shows the duty log above the prompt. `0` turns the
	 * automatic block off; `/dutylog` still shows it on demand.
	 */
	dutyLogAfterMinutes?: number;
}

/** Default away time before the duty log appears on its own. */
export const DEFAULT_DUTY_LOG_AFTER_MINUTES = 120;

/** Default cadence of the spend cell's idle tick and its stale-figure catch-up. */
export const DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS = 15_000;
/** Fastest cadence a user may configure: below this the scan cost stops being negligible. */
export const MIN_SUBAGENT_SPEND_CELL_INTERVAL_MS = 5_000;
/** Slowest cadence a user may configure; past this the figure is stale by design anyway. */
export const MAX_SUBAGENT_SPEND_CELL_INTERVAL_MS = 120_000;

export interface TelemetrySettings {
	enabled?: boolean;
	noticeShown?: boolean;
}

/** U6 footer telemetry switch (footer.ts renders the watermark line). */
export type FooterTelemetrySetting = "off" | "on";

export interface FooterSettings {
	/** Default: "on" — one line: model · thinking level · watermark bar · context figures. */
	telemetry?: FooterTelemetrySetting;
}

/** A JSON object that merges key-by-key; arrays and nulls replace wholesale. */
function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merge one setting value: objects recurse, everything else replaces.
 *
 * CD-4: this used to stop at the first level, so a project file that set
 * `retry.provider.maxRetries` silently dropped the global `retry.provider`
 * keys it did not mention (`timeoutMs`, `maxRetryDelayMs`,
 * `streamStallTimeoutMs`). Recursion is what makes the "nested objects merge"
 * contract below true at any depth a settings block nests to.
 */
function mergeSettingValue(base: unknown, override: unknown): unknown {
	if (!isMergeableObject(override)) {
		return override;
	}
	if (!isMergeableObject(base)) {
		return { ...override };
	}
	const merged: Record<string, unknown> = { ...base };
	for (const key of Object.keys(override)) {
		const value = override[key];
		if (value === undefined) {
			continue;
		}
		merged[key] = mergeSettingValue(merged[key], value);
	}
	return merged;
}

/**
 * Deep merge settings: project/overrides take precedence, nested objects merge
 * recursively, arrays and `null` replace wholesale.
 *
 * A name-keyed block (`mcpServers`: user-chosen names whose values are
 * discriminated unions) is merged by name here like any other object, so a
 * project entry that changes a server's `type` keeps the other shape's keys.
 * That view is not read anywhere today - only `getGlobalMcpServers()` feeds the
 * MCP manager (CD-follow-up: project-scope servers are ignored entirely) - so
 * this is a documented property of the merge, not a live behaviour.
 */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const merged: Record<string, unknown> = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue;
		}
		merged[key] = mergeSettingValue(merged[key], overrideValue);
	}

	return merged as Settings;
}

/**
 * Consent blocks whose `enabled: false` is a veto inside the collected project
 * scope (SEC-8): the project layer can only withhold consent, never supply it,
 * so no subdirectory may re-enable what an ancestor file withdrew.
 */
const PROJECT_CONSENT_VETO_KEYS: ReadonlyArray<readonly [string, string]> = [
	["agentTraces", "enabled"],
	["telemetry", "enabled"],
];

/**
 * Enforce the project consent veto over the closest-wins merge: if any
 * collected project file (ancestor or the session directory's own) explicitly
 * disables one of the consent blocks, the merged project scope says disabled.
 */
function applyProjectConsentVeto(merged: Record<string, unknown>, files: Settings[]): void {
	for (const [blockName, key] of PROJECT_CONSENT_VETO_KEYS) {
		const vetoed = files.some((file) => {
			const block = (file as Record<string, unknown>)[blockName];
			return typeof block === "object" && block !== null && (block as Record<string, unknown>)[key] === false;
		});
		if (!vetoed) {
			continue;
		}
		const block = merged[blockName];
		if (typeof block === "object" && block !== null && !Array.isArray(block)) {
			(block as Record<string, unknown>)[key] = false;
		} else {
			merged[blockName] = { [key]: false };
		}
	}
}

/**
 * Every key `Settings` understands (CD-3): the top level is the `Settings`
 * interface verbatim, and a nested entry lists the keys of that block's
 * interface when the block has a closed shape. `null` marks a free-form block
 * (user-defined names), which is never scanned; array-valued keys are skipped
 * by the scanner because their contents are data, not key names. Keep this in
 * sync with the interfaces above - a key missing here makes a real setting
 * report as unknown, an extra key silences a genuine typo.
 */
const KNOWN_SETTINGS_KEYS: Record<string, readonly string[] | null> = {
	onboardingShown: null,
	onboardingCompleted: null,
	defaultProvider: null,
	defaultModel: null,
	imageModel: null,
	subagentDefaultModel: null,
	updateChannel: null,
	recentModels: null,
	auxiliaryModel: null,
	autoSessionName: null,
	defaultThinkingLevel: null,
	defaultServiceTier: null,
	rlmMaxDepth: null,
	idleEvictionMinutes: null,
	childIdleEvictionMinutes: null,
	transport: null,
	steeringMode: null,
	followUpMode: null,
	theme: null,
	compaction: [
		"enabled",
		"reserveTokens",
		"keepRecentTokens",
		"agentCallable",
		"triggerRatio",
		"priorityOverAgentMessages",
	],
	stallWatchdog: [
		"enabled",
		"warnAfterSeconds",
		"abortAfterSeconds",
		"toolLivenessExemption",
		"treatKernelCpuProgressAsActivity",
		"rootRecovery",
	],
	subagents: ["stallRecovery"],
	subagentWake: ["policy"],
	kernelBootstrap: ["lockTimeoutMs"],
	kernelRestart: ["maxUnexpectedRestarts", "windowMinutes", "revivalVouchMaxAgeSeconds"],
	agentMessage: ["targetWaitSeconds"],
	daemon: ["eventGapRecovery", "supervisorRejectionExitThreshold", "failedWorkerReapHours", "failedWorkerReapEnabled"],
	autoRefine: ["enabled", "turnInterval", "compact", "cooldownMs"],
	agentTraces: ["enabled"],
	telemetry: ["enabled", "noticeShown"],
	footer: ["telemetry"],
	branchSummary: ["reserveTokens", "skipPrompt"],
	retention: [
		"enabled",
		"dryRun",
		"sweepIntervalMinutes",
		"maxDeleteBytesPerSweep",
		"maxDeleteEntriesPerSweep",
		"cooldownMinutes",
		"sweepLockEnabled",
		"emptyArtifactDirDays",
		"deletedSessionResidueDays",
		"childTranscriptDays",
		"logFileDays",
		"tmpRlmDirHours",
		"tmpOtherDirDays",
		"bashTempFileHours",
		"bashTempFileMaxBytes",
		"staleLeaseHours",
		"kernelSnapshotGenerations",
		"kernelSnapshotReclaimEnabled",
		"ledgerCompactionEnabled",
		"venvRetention",
		"venvReclaim",
	],
	retry: ["enabled", "maxRetries", "baseDelayMs", "emptyTurn", "provider"],
	hideThinkingBlock: null,
	providerBackupModel: null,
	providerFallbackModels: null,
	autonomous: null,
	selfRecovery: ["autoContinue", "childReplyNudge"],
	shellPath: null,
	quietStartup: null,
	shellCommandPrefix: null,
	npmCommand: null,
	mcpServers: null,
	mcpCatalogSources: null,
	packages: null,
	extensions: null,
	extensionHandlerTimeoutMs: null,
	skills: null,
	prompts: null,
	themes: null,
	enableSkillCommands: null,
	bundledSkills: ["websearch"],
	tools: ["timeout"],
	enableBuiltinSkills: null,
	terminal: ["showImages", "clearOnShrink", "showTerminalProgress", "fullscreen", "fullscreenMouse"],
	images: ["autoResize", "blockImages"],
	enabledModels: null,
	treeFilterMode: null,
	thinkingBudgets: ["minimal", "low", "medium", "high"],
	editorPaddingX: null,
	autocompleteMaxVisible: null,
	showHardwareCursor: null,
	markdown: ["codeBlockIndent", "mermaid"],
	warnings: ["anthropicExtraUsage"],
	ui: ["subagentSpendCell", "processMode", "dutyLogAfterMinutes"],
	sessionDir: null,
};

/** Deeper-than-one-level blocks, keyed by their full dotted path. */
const KNOWN_NESTED_SETTINGS_KEYS: Record<string, readonly string[] | null> = {
	"retry.provider": [
		"timeoutMs",
		"maxRetries",
		"maxRetryDelayMs",
		"streamStallTimeoutMs",
		"waitForUsage",
		"fallbackLongWait",
	],
	// The cell's cadence block: `ui.subagentSpendCell` is either a boolean or this object.
	"ui.subagentSpendCell": ["intervalMs", "priceOverrides"],
	// The correction map is free-form in its own keys (`"<provider>/<model-id>"`), so only
	// the model keys themselves are left unvalidated here; `reportSpendPriceOverrideProblems`
	// reports the fields inside them.
	"ui.subagentSpendCell.priceOverrides": null,
	"retry.emptyTurn": [
		"maxAttempts",
		"baseDelayMs",
		"maxDelayMs",
		"maxTotalDelayMs",
		"escalatedAttempts",
		"escalatedBaseDelayMs",
		"escalatedMaxDelayMs",
		"escalatedMaxDelayClampMs",
		"escalatedMaxTotalDelayMs",
		"recovery",
	],
	"retry.emptyTurn.recovery": ["enabled", "maxContinuations", "useBackupModel"],
	"tools.timeout": ["enabled", "afterMs", "perTool", "silentStuckSeconds", "silentStuckCpuMs"],
	"subagents.stallRecovery": ["enabled", "graceSeconds", "maxPerSession"],
	"stallWatchdog.rootRecovery": ["enabled", "humanWindowSeconds", "maxPerSession"],
};

/**
 * What to do about one unusable price override, in the user's terms. Each kind
 * ends with what happens instead, because "ignored" is the fact that matters:
 * an unusable field falls back to the models.json rate, an unusable entry
 * corrects nothing.
 */
function spendPriceOverrideProblemAdvice(problem: SpendPriceOverrideProblem): string {
	switch (problem.kind) {
		case "value":
			return `the field is ignored and the models.json rate stands. A rate is a finite number >= 0 in the models.json cost unit (per million tokens)`;
		case "unknown-field":
			return `that is not a rate field this version knows (input, output, cacheRead, cacheWrite), so it never takes effect`;
		case "entry":
			return `a correction is an object of rate fields, so this entry is ignored`;
		case "key":
			return `a correction key is "<provider>/<model-id>", so this entry can never match a model`;
		default: {
			const _exhaustive: never = problem.kind;
			return _exhaustive;
		}
	}
}

/**
 * Full dotted paths of every key the current schema does not recognize, so a
 * misspelled key is visible instead of silently doing nothing.
 */
export function collectUnknownSettingsKeys(settings: Record<string, unknown>): string[] {
	const unknown: string[] = [];
	for (const [key, value] of Object.entries(settings)) {
		if (!Object.hasOwn(KNOWN_SETTINGS_KEYS, key)) {
			unknown.push(key);
			continue;
		}
		scanUnknownNestedKeys(key, value, KNOWN_SETTINGS_KEYS[key], unknown);
	}
	return unknown;
}

function scanUnknownNestedKeys(
	path: string,
	value: unknown,
	knownChildKeys: readonly string[] | null,
	unknown: string[],
): void {
	// Free-form block, or a value with no keys of its own to name.
	if (knownChildKeys === null || typeof value !== "object" || value === null || Array.isArray(value)) {
		return;
	}
	for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
		const childPath = `${path}.${childKey}`;
		if (!knownChildKeys.includes(childKey)) {
			unknown.push(childPath);
			continue;
		}
		if (Object.hasOwn(KNOWN_NESTED_SETTINGS_KEYS, childPath)) {
			scanUnknownNestedKeys(childPath, childValue, KNOWN_NESTED_SETTINGS_KEYS[childPath], unknown);
		}
	}
}

/** The environment switch that turns the terminal's hardware cursor on or off. */
export const HARDWARE_CURSOR_ENV_VAR = "PI_HARDWARE_CURSOR";

/**
 * An explicit boolean environment switch. Returns undefined when the variable is
 * unset or holds a value we do not recognize, so an unrecognized value falls
 * back to the settings file instead of silently switching a feature off.
 */
function parseBooleanEnvSwitch(value: string | undefined): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
			return true;
		case "0":
		case "false":
		case "no":
			return false;
		default:
			return undefined;
	}
}

export type SettingsScope = "global" | "project";

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
	/**
	 * On-disk path of a scope's settings file, when the backend has one. Only a
	 * file-backed store can be watched for external edits (CD-5); an in-memory
	 * store answers `undefined` and `watchExternalSettings` reports that it cannot
	 * watch rather than pretending it does.
	 */
	settingsFilePath?(scope: SettingsScope): string | undefined;
	/**
	 * Project-scope settings files above the session directory, ordered
	 * root-most first (SEC-8). A project settings file used to apply only at the
	 * exact cwd, so a repository-level veto was silently skipped for sessions
	 * started in a subdirectory; the project scope now also reads these files.
	 * Only the settings file at the session cwd is written or watched.
	 */
	projectAncestorSettingsFilePaths?(): string[];
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

/**
 * A non-fatal settings problem the user should see (an unknown key, a conflict
 * between the environment and the file). Kept apart from `SettingsError` because
 * nothing failed to load: the file is intact, part of it just has no effect.
 */
export interface SettingsWarning {
	scope: SettingsScope;
	message: string;
}

/**
 * Find the root of the git repository containing `startDir`, or null outside
 * any repository. Mirrors the skills loader's bound (`collectAncestorAgentsSkillDirs`
 * in package-manager.ts); kept local here because settings-manager must not
 * import package-manager (which imports this module).
 */
function findSettingsGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

/**
 * Project settings files in the directories above the session cwd, ordered
 * root-most first (SEC-8). The walk stops at the git repository root, so a
 * settings file above the repository does not project into it, and matches the
 * skills-loader precedent of walking to the filesystem root outside any
 * repository. The global settings path is excluded: the user-level file is the
 * global scope, never a second project veto. The session directory itself is
 * not included - its file is the primary project scope.
 */
function collectProjectAncestorSettingsPaths(cwd: string, globalSettingsPath: string): string[] {
	const resolved = resolve(cwd);
	const gitRepoRoot = findSettingsGitRepoRoot(resolved);
	if (gitRepoRoot === resolved) {
		// The session sits at the repository root: its own file is the primary
		// project scope and nothing above the repository may project into it.
		return [];
	}
	const paths: string[] = [];
	let dir = dirname(resolved);
	while (true) {
		const path = join(dir, CONFIG_DIR_NAME, "settings.json");
		if (resolve(path) !== resolve(globalSettingsPath)) {
			paths.push(path);
		}
		if (gitRepoRoot !== null && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return paths.reverse();
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;
	private projectAncestorSettingsPaths: string[];

	constructor(cwd: string, agentDir: string) {
		this.globalSettingsPath = join(agentDir, "settings.json");
		this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
		this.projectAncestorSettingsPaths = collectProjectAncestorSettingsPaths(cwd, this.globalSettingsPath);
	}

	settingsFilePath(scope: SettingsScope): string {
		return scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
	}

	projectAncestorSettingsFilePaths(): string[] {
		return [...this.projectAncestorSettingsPaths];
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;
		let compromisedError: Error | undefined;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				const release = lockfile.lockSync(path, {
					realpath: false,
					onCompromised: (error) => {
						compromisedError ??= error;
					},
				});
				if (compromisedError) {
					release();
					throw compromisedError;
				}
				return release;
			} catch (error) {
				if (compromisedError) throw compromisedError;
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				// Sleep synchronously to avoid changing callers to async.
				sleepSync(delayMs);
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			let next = fn(current);
			if (next !== undefined) {
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
					// The first-write read ran unlocked; a racing first writer may have landed since.
					if (existsSync(path)) {
						next = fn(readFileSync(path, "utf-8"));
					}
				}
				if (next === undefined) return;
				const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
				try {
					// fsync before the rename (writePrivateFileAtomic precedent): a
					// power loss right after renameSync must not resurrect the old
					// settings bytes from an unflushed page cache.
					const descriptor = openSync(temporaryPath, "w", 0o600);
					try {
						writeFileSync(descriptor, next, "utf-8");
						fsyncSync(descriptor);
					} finally {
						closeSync(descriptor);
					}
					renameSync(temporaryPath, path);
				} finally {
					if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
				}
			}
		} finally {
			if (release) {
				release();
			}
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings = {};
	private runtimeOverrides: Settings = {};
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	/** One-shot guard for the empty-turn slow-tier clamp warning (see _clampEscalatedEmptyTurnWaits). */
	private emptyTurnClampWarned = false;
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];
	private warnings: SettingsWarning[] = [];
	/** Warning identities already reported, so a repeated read/load reports once. */
	private reportedWarnings = new Set<string>();
	/**
	 * Last-seen on-disk identity of each settings file, so a watcher wake-up only
	 * counts as an external edit when the file really changed (CD-5).
	 */
	private loadedStamps = new Map<SettingsScope, string>();
	/**
	 * Last-seen on-disk identity of each ancestor settings file, so a watcher
	 * wake-up on an ancestor only counts as an external edit when that file
	 * really changed (K3P-2). `undefined` means the file does not exist.
	 */
	private ancestorStamps = new Map<string, string | undefined>();
	private externalWatchers: Array<{ path: string; listener: () => void }> = [];
	private externalWatchSettleTimer: ReturnType<typeof setTimeout> | undefined;
	private externalEditReload: Promise<void> | undefined;

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.recomputeMergedSettings();
	}

	/** Create a SettingsManager that loads from files */
	static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage): SettingsManager {
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project");
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		const manager = new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
		);
		for (const { path, error } of projectLoad.ancestorParseErrors) {
			manager.recordAncestorParseError(path, error);
		}
		manager.reportUnknownSettingsKeys("global", manager.globalSettings);
		manager.reportUnknownSettingsKeys("project", manager.projectSettings);
		manager.reportSpendPriceOverrideProblems("global", manager.globalSettings);
		manager.reportSpendPriceOverrideProblems("project", manager.projectSettings);
		manager.captureSettingsStamps();
		return manager;
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage);
	}

	private static loadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
	): { settings: Settings; ancestorParseErrors: Array<{ path: string; error: Error }> } {
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		const primary: Settings = content ? SettingsManager.migrateSettings(JSON.parse(content)) : {};
		if (scope !== "project") {
			return { settings: primary, ancestorParseErrors: [] };
		}

		// SEC-8: the project scope also reads the settings files above the session
		// directory (up to the repository root). Root-most first, then the session
		// directory itself last: the closest file wins. The primary file at the
		// session cwd still fails the whole scope when it does not parse (SEC-7:
		// the reload keeps the previous snapshot, the load error fails the consent
		// gates closed), but an ancestor that does not parse is dropped on its own
		// (K3P-1): one broken file in the repository root must not discard the
		// session's own intact project settings along with it.
		const ancestorPaths = storage.projectAncestorSettingsFilePaths?.() ?? [];
		if (ancestorPaths.length === 0) {
			return { settings: primary, ancestorParseErrors: [] };
		}
		const ancestors: Settings[] = [];
		const ancestorParseErrors: Array<{ path: string; error: Error }> = [];
		for (const path of ancestorPaths) {
			let raw: string;
			try {
				raw = readFileSync(path, "utf-8");
			} catch (error) {
				// An ancestor without a settings file simply does not speak; any
				// other read failure (a file that exists but cannot be read, a
				// directory in the way) leaves the project scope unverifiable and
				// propagates so the load fails closed.
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code === "ENOENT") {
					continue;
				}
				throw error;
			}
			try {
				ancestors.push(SettingsManager.migrateSettings(JSON.parse(raw)));
			} catch (error) {
				// K3P-1: the broken ancestor is excluded from the merge and the
				// failure is reported per file, instead of failing the entire
				// project scope (which also discarded the primary file).
				ancestorParseErrors.push({
					path,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			}
		}
		let merged: Settings = {};
		for (const ancestor of ancestors) {
			merged = deepMergeSettings(merged, ancestor);
		}
		merged = deepMergeSettings(merged, primary);
		const consentSources: Settings[] = [...ancestors, primary];
		if (ancestorParseErrors.length > 0) {
			// An unparseable ancestor may have held a consent veto, so its consent
			// cannot be verified: fail that layer closed rather than silently
			// treating an unknown file as permission (SEC-7 direction, K3P-1 scope).
			consentSources.push({ telemetry: { enabled: false }, agentTraces: { enabled: false } } as Settings);
		}
		applyProjectConsentVeto(merged as Record<string, unknown>, consentSources);
		return { settings: merged, ancestorParseErrors };
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
	): { settings: Settings; error: Error | null; ancestorParseErrors: Array<{ path: string; error: Error }> } {
		try {
			const { settings, ancestorParseErrors } = SettingsManager.loadFromStorage(storage, scope);
			return { settings, error: null, ancestorParseErrors };
		} catch (error) {
			return { settings: {}, error: error as Error, ancestorParseErrors: [] };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		if (typeof settings.telemetry === "boolean") {
			settings.telemetry = { enabled: settings.telemetry };
		} else if (
			settings.telemetry !== undefined &&
			(typeof settings.telemetry !== "object" || settings.telemetry === null || Array.isArray(settings.telemetry))
		) {
			delete settings.telemetry;
		}

		if (
			settings.markdown !== undefined &&
			(typeof settings.markdown !== "object" || settings.markdown === null || Array.isArray(settings.markdown))
		) {
			delete settings.markdown;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project");
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}
		for (const { path, error } of projectLoad.ancestorParseErrors) {
			this.recordAncestorParseError(path, error);
		}

		this.recomputeMergedSettings();
		this.reportUnknownSettingsKeys("global", this.globalSettings);
		this.reportUnknownSettingsKeys("project", this.projectSettings);
		this.reportSpendPriceOverrideProblems("global", this.globalSettings);
		this.reportSpendPriceOverrideProblems("project", this.projectSettings);
		this.captureSettingsStamps();
	}

	/**
	 * On-disk identity of one settings file, or undefined when it does not exist.
	 * `ino` is part of it because the writer replaces the file by rename: a new
	 * inode with the same size and millisecond mtime is still a different file.
	 */
	private settingsStamp(scope: SettingsScope): string | undefined {
		const path = this.storage.settingsFilePath?.(scope);
		if (path === undefined) return undefined;
		return this.settingsStampForPath(path);
	}

	/** On-disk identity of any settings-shaped file, or undefined when absent. */
	private settingsStampForPath(path: string): string | undefined {
		try {
			const info = statSync(path);
			return `${info.ino}:${info.mtimeMs}:${info.size}`;
		} catch {
			return undefined;
		}
	}

	/** Remember what the settings files look like right now (after a load or our own write). */
	private captureSettingsStamps(): void {
		for (const scope of ["global", "project"] as SettingsScope[]) {
			const stamp = this.settingsStamp(scope);
			if (stamp === undefined) {
				this.loadedStamps.delete(scope);
			} else {
				this.loadedStamps.set(scope, stamp);
			}
		}
		// The ancestor files take part in the project scope (SEC-8), so their
		// identity is remembered too: an ancestor watcher wake-up only counts as
		// an external edit when that file changed since the last load (K3P-2).
		for (const path of this.storage.projectAncestorSettingsFilePaths?.() ?? []) {
			this.ancestorStamps.set(path, this.settingsStampForPath(path));
		}
	}

	/**
	 * Watch both settings files for direct edits and reload them into the running
	 * session (CD-5). Without this, editing `settings.json` by hand had no effect
	 * on a live session and said nothing about it: the manager loaded the file once
	 * and kept that snapshot forever.
	 *
	 * Polling (`watchFile`) rather than `watch` because the settings file is
	 * replaced by rename, and a polling watcher keeps working across the inode
	 * change. The watcher is unref'ed, so it never holds the process open.
	 *
	 * Returns false when the storage backend has no settings file to watch, which
	 * is the honest answer for an in-memory store.
	 */
	watchExternalSettings(options: { intervalMs?: number } = {}): boolean {
		if (this.externalWatchers.length > 0) return true;
		const globalPath = this.storage.settingsFilePath?.("global");
		const projectPath = this.storage.settingsFilePath?.("project");
		if (globalPath === undefined || projectPath === undefined) return false;
		this.captureSettingsStamps();
		const intervalMs = options.intervalMs ?? DEFAULT_SETTINGS_WATCH_INTERVAL_MS;
		for (const [scope, path] of [
			["global", globalPath],
			["project", projectPath],
		] as Array<[SettingsScope, string]>) {
			const listener = (): void => {
				const stamp = this.settingsStamp(scope);
				if (stamp === this.loadedStamps.get(scope)) {
					// Our own write, a missing file that is still missing, or a touch that
					// did not change what we loaded: nothing to reload and nothing to say.
					return;
				}
				this.reloadExternalEdit(scope, stamp);
			};
			const watcher = watchFile(path, { interval: intervalMs }, listener);
			watcher.unref();
			this.externalWatchers.push({ path, listener });
		}
		// K3P-2: the project scope is built from the ancestor files too (SEC-8),
		// so they are watched as well - a repository-level veto written while the
		// session is running must take effect, not wait for the next unrelated
		// reload or a restart. Polling watchers fire for a file that appears where
		// none was, so a veto that lands mid-session is picked up the same way.
		const watchedPaths = new Set([globalPath, projectPath]);
		for (const path of this.storage.projectAncestorSettingsFilePaths?.() ?? []) {
			if (watchedPaths.has(path)) continue;
			const listener = (): void => {
				const stamp = this.settingsStampForPath(path);
				if (stamp === this.ancestorStamps.get(path)) {
					return;
				}
				this.reloadExternalEdit("project", stamp);
			};
			const watcher = watchFile(path, { interval: intervalMs }, listener);
			watcher.unref();
			this.externalWatchers.push({ path, listener });
		}
		// A polling watcher takes its baseline with an asynchronous first stat. A file
		// written between the stamps captured above and that stat is already in the
		// watcher's baseline, so it never reports the change. One explicit check after
		// the first polls closes that window; the listeners compare against the
		// captured stamps, so a check that finds nothing new does nothing.
		this.externalWatchSettleTimer = setTimeout(() => {
			this.externalWatchSettleTimer = undefined;
			for (const { listener } of this.externalWatchers) listener();
		}, intervalMs * 2);
		this.externalWatchSettleTimer.unref();
		return true;
	}

	/** Whether external-settings edits are currently being watched. */
	isWatchingExternalSettings(): boolean {
		return this.externalWatchers.length > 0;
	}

	/** Stop watching for external settings edits. Safe to call when not watching. */
	stopWatchingExternalSettings(): void {
		if (this.externalWatchSettleTimer !== undefined) {
			clearTimeout(this.externalWatchSettleTimer);
			this.externalWatchSettleTimer = undefined;
		}
		for (const { path, listener } of this.externalWatchers) {
			unwatchFile(path, listener);
		}
		this.externalWatchers = [];
	}

	/**
	 * Reload after a direct edit and record a user-visible warning. The reload is
	 * serialized so two quick edits cannot interleave their loads, and the warning
	 * identity carries the new stamp, so a second edit is reported again instead of
	 * being swallowed by the once-per-identity dedup.
	 */
	private reloadExternalEdit(scope: SettingsScope, stamp: string | undefined): void {
		const previous = this.externalEditReload ?? Promise.resolve();
		this.externalEditReload = previous
			.then(async () => {
				await this.reload();
				const loadError = scope === "global" ? this.globalSettingsLoadError : this.projectSettingsLoadError;
				if (loadError) {
					// SEC-7: the edited file failed to parse, so the edit did NOT take
					// effect - the previous content is still loaded, and the consent
					// gates treat the unparseable scope as withdrawn. Reporting this
					// as "reloaded into this session" would tell the user a broken
					// hand edit had landed when it had not.
					this.recordWarning(
						scope,
						`external-edit-parse-error:${scope}:${stamp ?? "removed"}`,
						"settings.json changed on disk while the session was running, but it failed to parse: " +
							"the change was not applied and the previously loaded settings are still in effect. " +
							"Consent gates (agent traces, telemetry) treat the unparseable scope as withdrawn " +
							`until the file parses again. Parse error: ${loadError.message}`,
					);
					return;
				}
				this.recordWarning(
					scope,
					`external-edit:${scope}:${stamp ?? "removed"}`,
					"settings.json changed on disk while the session was running: it was reloaded into this session. " +
						"Settings already read earlier in the session (theme, tool or resource lists, model defaults) still " +
						"need /reload or a restart to change.",
				);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.runtimeOverrides = deepMergeSettings(this.runtimeOverrides, overrides);
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/**
	 * The merged view is files-with-overrides. Recomputing it from the two
	 * scopes alone silently rolled back every runtime override a CLI flag or
	 * SDK caller had applied (SEC-9 for reload, K3P-3 for the save paths: one
	 * unrelated save had the same effect as one external edit).
	 */
	private recomputeMergedSettings(): void {
		this.settings = deepMergeSettings(
			deepMergeSettings(this.globalSettings, this.projectSettings),
			this.runtimeOverrides,
		);
	}

	/**
	 * Report one ancestor settings file that failed to parse (K3P-1): it was
	 * excluded from the project-scope merge and its consent is treated as
	 * withheld. A warning, not an error: the errors list is the save-failure
	 * contract, and a foreign ancestor file is not this session's save liability.
	 */
	private recordAncestorParseError(path: string, error: Error): void {
		// K3R2-3 (r31 F4b): the identity carries the file's on-disk stamp, like the
		// external-edit warnings. A path-only identity kept suppressing the warning
		// after the first corruption, so an ancestor that broke again after being
		// fixed was silently dropped a second time.
		const stamp = this.settingsStampForPath(path);
		this.recordWarning(
			"project",
			`ancestor-parse-error:${path}:${stamp ?? "unreadable"}`,
			`settings.json at ${path} failed to parse, so it was ignored while building the project settings: ` +
				`the rest of the project scope is still in effect, and consent (agent traces, telemetry) is ` +
				`treated as withheld for that file until it parses again. Parse error: ${error.message}`,
		);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	/**
	 * Report a non-fatal settings problem once per scope+identity. Unknown keys
	 * are re-scanned on every load, so the identity has to outlive a drain.
	 */
	private recordWarning(scope: SettingsScope, identity: string, message: string): void {
		const key = `${scope}\u0000${identity}`;
		if (this.reportedWarnings.has(key)) {
			return;
		}
		this.reportedWarnings.add(key);
		this.warnings.push({ scope, message });
	}

	/**
	 * Report every unusable price override, with its full key path.
	 *
	 * This setting exists because a spend figure that quietly prices from the
	 * wrong rate is worse than no figure: so a correction that cannot be used is
	 * loud. The identity carries the rejected value, so fixing a bad entry for a
	 * new bad value reports again instead of being swallowed as a repeat.
	 */
	private reportSpendPriceOverrideProblems(scope: SettingsScope, settings: Settings): void {
		const raw =
			typeof settings.ui?.subagentSpendCell === "object" && settings.ui.subagentSpendCell !== null
				? settings.ui.subagentSpendCell.priceOverrides
				: undefined;
		if (raw === undefined) {
			return;
		}
		for (const problem of readSpendPriceOverrides(raw, SPEND_PRICE_OVERRIDES_PATH).problems) {
			this.recordWarning(
				scope,
				`spend-price-override:${problem.path}=${problem.found}`,
				`${problem.path} is not a usable price override (${problem.found}): ${spendPriceOverrideProblemAdvice(problem)}`,
			);
		}
	}

	/** Report every key this version does not recognize (CD-3). */
	private reportUnknownSettingsKeys(scope: SettingsScope, settings: Settings): void {
		for (const key of collectUnknownSettingsKeys(settings as Record<string, unknown>)) {
			this.recordWarning(
				scope,
				`unknown-key:${key}`,
				`unknown settings key "${key}" (${scope} settings): this key is not recognized by this version of Prime Agent, so its value never takes effect. The value is kept in the file.`,
			);
		}
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			// A write that carries unknown keys back to disk keeps them visible.
			this.reportUnknownSettingsKeys(scope, mergedSettings);
			this.reportSpendPriceOverrideProblems(scope, mergedSettings);

			return JSON.stringify(mergedSettings, null, 2);
		});
		// The write just replaced the file by rename; remember the new identity so
		// the watcher does not misread our own write as an external edit.
		this.captureSettingsStamps();
	}

	private save(): void {
		this.recomputeMergedSettings();

		if (this.globalSettingsLoadError) {
			this.recordError(
				"global",
				new Error(
					`Global settings not saved: settings file failed to parse: ${this.globalSettingsLoadError.message}`,
				),
			);
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.projectSettings = structuredClone(settings);
		this.recomputeMergedSettings();

		if (this.projectSettingsLoadError) {
			this.recordError(
				"project",
				new Error(
					`Project settings not saved: settings file failed to parse: ${this.projectSettingsLoadError.message}`,
				),
			);
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/**
	 * Await the queued writes and return a user-readable reason when settings did not reach disk:
	 * a failed write, or every write this session skipped because the settings file cannot be
	 * parsed. Returns undefined when nothing failed. Consumes the recorded errors, so a failure is
	 * reported once. Call sites must show the failure instead of claiming a save (H-2).
	 */
	async persistenceFailure(scope?: SettingsScope): Promise<string | undefined> {
		await this.flush();
		const errors = this.drainErrors(scope);
		if (errors.length === 0) {
			return undefined;
		}
		return errors.map(({ error }) => error.message).join("; ");
	}

	drainErrors(scope?: SettingsScope): SettingsError[] {
		if (!scope) {
			const drained = [...this.errors];
			this.errors = [];
			return drained;
		}
		const drained = this.errors.filter((entry) => entry.scope === scope);
		this.errors = this.errors.filter((entry) => entry.scope !== scope);
		return drained;
	}

	/**
	 * Consume the warnings recorded so far. Kept apart from `drainErrors`, whose
	 * count is the save-failure contract callers rely on.
	 */
	drainWarnings(scope?: SettingsScope): SettingsWarning[] {
		if (!scope) {
			const drained = [...this.warnings];
			this.warnings = [];
			return drained;
		}
		const drained = this.warnings.filter((entry) => entry.scope === scope);
		this.warnings = this.warnings.filter((entry) => entry.scope !== scope);
		return drained;
	}

	getOnboardingShown(): boolean {
		return this.settings.onboardingShown ?? this.settings.onboardingCompleted ?? false;
	}

	setOnboardingShown(shown: boolean): void {
		this.globalSettings.onboardingShown = shown;
		this.markModified("onboardingShown");
		this.save();
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		if (!sessionDir) {
			return sessionDir;
		}
		if (sessionDir === "~") {
			return homedir();
		}
		if (sessionDir.startsWith("~/")) {
			return join(homedir(), sessionDir.slice(2));
		}
		return sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	/** Model selector applied when `rlm.spawn` does not pin a model; unset inherits the parent model. */
	getSubagentDefaultModel(): string | undefined {
		// Parsed settings are only cast to Settings; a non-string JSON value
		// (e.g. 42) must behave as unset, never throw into the spawn path.
		const reference = this.settings.subagentDefaultModel;
		if (typeof reference !== "string") return undefined;
		return reference.trim() ? reference.trim() : undefined;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.recordModelUseInternal(provider, modelId);
		this.markModified("recentModels");
		this.save();
	}

	getAuxiliaryModel(): string | undefined {
		// Hand-edited or corrupt settings files can persist non-string values; treat
		// anything malformed as unset so refinement falls back to the session model.
		const value = this.settings.auxiliaryModel;
		return typeof value === "string" ? value : undefined;
	}

	getAutoSessionName(): "off" | "first-message" | "llm" {
		// Hand-edited settings can persist anything; only the three known modes
		// count, everything else falls back to the default.
		const value = this.settings.autoSessionName;
		return value === "off" || value === "first-message" || value === "llm" ? value : "first-message";
	}

	getRecentModels(): string[] {
		return this.settings.recentModels ?? [];
	}

	private recordModelUseInternal(provider: string, modelId: string): void {
		const key = `${provider}/${modelId}`;
		const next = [key, ...this.getRecentModels().filter((k) => k !== key)];
		this.globalSettings.recentModels = next.slice(0, RECENT_MODELS_LIMIT);
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getTheme(): string | undefined {
		return this.settings.theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	/** A per-user preference: read from global settings only, and ignore anything but the two known values. */
	getUpdateChannel(): "stable" | "nightly" | undefined {
		const channel = this.globalSettings.updateChannel;
		return channel === "stable" || channel === "nightly" ? channel : undefined;
	}

	setUpdateChannel(channel: "stable" | "nightly"): void {
		this.globalSettings.updateChannel = channel;
		this.markModified("updateChannel");
		this.save();
	}

	getDefaultThinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getDefaultServiceTier(): ServiceTier {
		return this.settings.defaultServiceTier ?? "default";
	}

	setDefaultServiceTier(serviceTier: ServiceTier): void {
		this.globalSettings.defaultServiceTier = serviceTier;
		this.markModified("defaultServiceTier");
		this.save();
	}

	getRlmMaxDepth(): number | undefined {
		return this.globalSettings.rlmMaxDepth;
	}

	setRlmMaxDepth(maxDepth: number): void {
		this.globalSettings.rlmMaxDepth = maxDepth;
		this.markModified("rlmMaxDepth");
		this.save();
	}

	getIdleEvictionMinutes(): number | "off" {
		const value: unknown = this.globalSettings.idleEvictionMinutes;
		if (value === "off" || value === "none") return "off";
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_IDLE_EVICTION_MINUTES;
	}

	/**
	 * How long an idle subagent stays resident before it is closed (its transcript is
	 * kept and a message wakes it). A finished subagent sitting in the panel for an
	 * hour and a half was clutter and a held worker slot for nothing, so children use
	 * their own shorter clock. Never longer than the global policy; `off` there
	 * turns this off too, and `off` here falls back to the global value.
	 */
	getChildIdleEvictionMinutes(): number | "off" {
		const global = this.getIdleEvictionMinutes();
		if (global === "off") return "off";
		const value: unknown = this.globalSettings.childIdleEvictionMinutes;
		if (value === "off" || value === "none") return global;
		const child =
			typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_CHILD_IDLE_EVICTION_MINUTES;
		return Math.min(child, global);
	}

	setIdleEvictionMinutes(value: number | "off"): void {
		if (value !== "off" && (!Number.isFinite(value) || value <= 0)) {
			throw new Error("Idle eviction minutes must be a positive number or off");
		}
		this.globalSettings.idleEvictionMinutes = value;
		this.markModified("idleEvictionMinutes");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	getProcessMode(): ProcessModeSetting {
		// TUI v4: quiet is the new default face; `legacy` is the one-key escape
		// hatch for the U6 lane users. Unknown values land on the default,
		// never throw.
		const value = this.settings.ui?.processMode;
		return value === "legacy" ? "legacy" : "quiet";
	}

	setProcessMode(mode: ProcessModeSetting): void {
		this.globalSettings.ui = { ...this.globalSettings.ui, processMode: mode };
		this.markModified("ui", "processMode");
		this.save();
	}

	/** Away minutes before the duty log shows itself; 0 = never automatically. Bad values land on the default. */
	getDutyLogAfterMinutes(): number {
		const value = this.settings.ui?.dutyLogAfterMinutes;
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_DUTY_LOG_AFTER_MINUTES;
	}

	getFooterTelemetry(): FooterTelemetrySetting {
		// U6 collapsed compact/full into "on" (one watermark line, no density
		// split); unknown values land on the visible default, never throw.
		const value = this.settings.footer?.telemetry;
		return value === "off" ? "off" : "on";
	}

	setFooterTelemetry(telemetry: FooterTelemetrySetting): void {
		this.globalSettings.footer = { ...this.globalSettings.footer, telemetry };
		this.markModified("footer", "telemetry");
		this.save();
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	/**
	 * Consent to upload full session transcripts is opt-in, and the project scope
	 * travels with a cloned repository rather than with the user: it may withhold
	 * consent but never supply it, mirroring the telemetry gate. The user opts in
	 * through the global scope only.
	 *
	 * Consent fails closed (SEC-7): a scope whose file cannot be parsed is a scope
	 * whose consent cannot be verified, so a broken file after the user revoked
	 * consent leaves the gate off instead of keeping the last successful value.
	 */
	getAgentTracesEnabled(): boolean {
		const globalEnabled =
			this.globalSettingsLoadError === null && (this.globalSettings.agentTraces?.enabled ?? false);
		const projectEnabled =
			this.projectSettingsLoadError === null && (this.projectSettings.agentTraces?.enabled ?? true);
		const runtimeEnabled = this.runtimeOverrides.agentTraces?.enabled ?? true;
		return globalEnabled && projectEnabled && runtimeEnabled;
	}

	setAgentTracesEnabled(enabled: boolean): void {
		if (!this.globalSettings.agentTraces) {
			this.globalSettings.agentTraces = {};
		}
		this.globalSettings.agentTraces.enabled = enabled;
		this.markModified("agentTraces", "enabled");
		this.save();
	}

	/**
	 * Telemetry is opt-out rather than opt-in, but the privacy direction is the
	 * same as the traces gate: when a scope's file cannot be parsed, its opt-out
	 * status cannot be verified and telemetry stays off (SEC-7 fail-closed).
	 */
	getTelemetryEnabled(): boolean {
		const globalEnabled = this.globalSettingsLoadError === null && (this.globalSettings.telemetry?.enabled ?? true);
		const projectEnabled =
			this.projectSettingsLoadError === null && (this.projectSettings.telemetry?.enabled ?? true);
		const runtimeEnabled = this.runtimeOverrides.telemetry?.enabled ?? true;
		return globalEnabled && projectEnabled && runtimeEnabled;
	}

	private getOrCreateGlobalTelemetrySettings(): TelemetrySettings {
		const telemetry = this.globalSettings.telemetry;
		if (typeof telemetry !== "object" || telemetry === null || Array.isArray(telemetry)) {
			this.globalSettings.telemetry = {};
		}
		return this.globalSettings.telemetry!;
	}

	setTelemetryEnabled(enabled: boolean): void {
		this.getOrCreateGlobalTelemetrySettings().enabled = enabled;
		this.markModified("telemetry", "enabled");
		this.save();
	}

	getTelemetryNoticeShown(): boolean {
		return this.runtimeOverrides.telemetry?.noticeShown ?? this.globalSettings.telemetry?.noticeShown ?? false;
	}

	setTelemetryNoticeShown(shown: boolean): void {
		this.getOrCreateGlobalTelemetrySettings().noticeShown = shown;
		this.markModified("telemetry", "noticeShown");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionAgentCallable(): boolean {
		return this.settings.compaction?.agentCallable ?? true;
	}

	/**
	 * Trigger ratio, validated: a non-finite or out-of-range value in settings.jsonl
	 * clamps to [MIN_COMPACTION_TRIGGER_RATIO, MAX_COMPACTION_TRIGGER_RATIO] instead
	 * of disabling the trigger (<= 0) or firing it every turn (>= 1).
	 */
	getCompactionTriggerRatio(): number {
		return clampCompactionTriggerRatio(this.settings.compaction?.triggerRatio);
	}

	/** Whether an incoming agent message queues behind a pending/in-flight compaction. */
	getCompactionPriorityOverAgentMessages(): boolean {
		return this.settings.compaction?.priorityOverAgentMessages ?? true;
	}

	getCompactionSettings(): {
		enabled: boolean;
		reserveTokens: number;
		keepRecentTokens: number;
		triggerRatio: number;
	} {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
			triggerRatio: this.getCompactionTriggerRatio(),
		};
	}

	getAutoRefineSettings(): { enabled: boolean; turnInterval: number; compact: boolean; cooldownMs: number } {
		const turnInterval = this.settings.autoRefine?.turnInterval;
		const cooldownMs = this.settings.autoRefine?.cooldownMs;
		return {
			enabled: this.settings.autoRefine?.enabled ?? true,
			turnInterval: Math.max(
				1,
				typeof turnInterval === "number" && Number.isFinite(turnInterval) ? turnInterval : 25,
			),
			compact: this.settings.autoRefine?.compact ?? true,
			cooldownMs: Math.max(
				0,
				typeof cooldownMs === "number" && Number.isFinite(cooldownMs) ? cooldownMs : 20 * 60_000,
			),
		};
	}

	/**
	 * Persisted autonomous-run limit defaults, ready for the runtime. Invalid
	 * entries are dropped so the built-in per-field defaults still apply.
	 */
	getAutonomousLimits(): ResolvedAutonomousLimits {
		const settings = this.settings.autonomous;
		if (!settings) {
			return {};
		}
		return {
			maxContinuations: resolveAutonomousLimit(settings.maxContinuations),
			maxTurns: resolveAutonomousLimit(settings.maxTurns),
			maxTokens: resolveAutonomousLimit(settings.maxTokens),
			timeoutMs: resolveAutonomousLimit(settings.timeoutMs),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getStallWatchdogSettings(): ResolvedStallWatchdogSettings {
		const enabled = this.settings.stallWatchdog?.enabled ?? true;
		const warnAfterSeconds = this.settings.stallWatchdog?.warnAfterSeconds ?? DEFAULT_STALL_WARN_AFTER_SECONDS;
		let abortAfterSeconds = this.settings.stallWatchdog?.abortAfterSeconds ?? DEFAULT_STALL_ABORT_AFTER_SECONDS;
		// 0 means "warn-only" (no auto-abort). Any other value at or below the warn
		// threshold would fire both stages at once; keep an escalation gap instead.
		if (abortAfterSeconds !== 0 && abortAfterSeconds <= warnAfterSeconds) {
			abortAfterSeconds = warnAfterSeconds * 2;
		}
		// Defaults must match DEFAULT_STALL_WATCHDOG_CONFIG / resolveStallWatchdogConfig in
		// stall-watchdog.ts. They are filled in here rather than delegated because that module
		// imports these very constants: a reverse import would be a load-time cycle.
		return {
			enabled,
			warnAfterSeconds,
			abortAfterSeconds,
			toolLivenessExemption: this.settings.stallWatchdog?.toolLivenessExemption ?? true,
			treatKernelCpuProgressAsActivity: this.settings.stallWatchdog?.treatKernelCpuProgressAsActivity ?? false,
		};
	}

	/** Subagent stall-recovery policy (r4 recovery-shell ③), with defaults. */
	getSubagentStallRecoverySettings(): ResolvedSubagentStallRecoverySettings {
		const settings = this.settings.subagents?.stallRecovery ?? {};
		return {
			enabled: settings.enabled ?? this.stallAutoAbortOptedIn(),
			graceSeconds: nonNegativeFinite(settings.graceSeconds, DEFAULT_SUBAGENT_STALL_RECOVERY_GRACE_SECONDS),
			maxPerSession: nonNegativeFinite(settings.maxPerSession, DEFAULT_STALL_RECOVERY_MAX_PER_SESSION),
		};
	}

	/**
	 * Whether the owner opted into killing silent turns (a positive watchdog abort stage).
	 * The daemon's automatic stall actions default to this: warn-only watchdogs (the
	 * default, 9ada6d83b) must not get their silence kill back through the sweep.
	 */
	private stallAutoAbortOptedIn(): boolean {
		return this.getStallWatchdogSettings().abortAfterSeconds > 0;
	}

	/** Depth-0 stall-recovery policy (r4 recovery-shell ④-B), with defaults. */
	getRootStallRecoverySettings(): RootStallRecoverySettingsResolved {
		const settings = this.settings.stallWatchdog?.rootRecovery ?? {};
		return {
			enabled: settings.enabled ?? this.stallAutoAbortOptedIn(),
			humanWindowSeconds: nonNegativeFinite(
				settings.humanWindowSeconds,
				DEFAULT_ROOT_STALL_RECOVERY_HUMAN_WINDOW_SECONDS,
			),
			maxPerSession: nonNegativeFinite(settings.maxPerSession, DEFAULT_STALL_RECOVERY_MAX_PER_SESSION),
		};
	}

	/**
	 * Kernel revival budget and vouch bound. `Infinity` is the resolved form of the `0` rollback
	 * lever: a comparison against it is simply never true, so no call site needs its own
	 * "disabled" branch.
	 */
	getKernelRestartSettings(): ResolvedKernelRestartSettings {
		const settings = this.settings.kernelRestart;
		return {
			maxUnexpectedRestarts: normalizeRestartBound(settings?.maxUnexpectedRestarts, DEFAULT_KERNEL_MAX_RESTARTS),
			windowMs: normalizeRestartBound(settings?.windowMinutes, DEFAULT_KERNEL_RESTART_WINDOW_MINUTES) * 60_000,
			revivalVouchMaxAgeMs:
				normalizeRestartBound(settings?.revivalVouchMaxAgeSeconds, DEFAULT_KERNEL_REVIVAL_VOUCH_MAX_AGE_SECONDS) *
				1000,
		};
	}

	/** The four agent-message wait tiers, derived from the one long tier (see AgentMessageSettings). */
	getAgentMessageWaitSettings(): ResolvedAgentMessageWaitSettings {
		return resolveAgentMessageWaitSeconds(this.settings.agentMessage?.targetWaitSeconds);
	}

	getKernelBootstrapSettings(): { lockTimeoutMs: number } {
		return {
			lockTimeoutMs: normalizeKernelBootstrapLockTimeoutMs(this.settings.kernelBootstrap?.lockTimeoutMs),
		};
	}

	/**
	 * Daemon supervisor policy (event-gap recovery mode, crash-handler threshold,
	 * failed-worker reaper). `failedWorkerReapHours` is undefined when reaping is
	 * disabled, so callers have a single value to test.
	 */
	getDaemonSupervisorSettings(): {
		eventGapRecovery: "log" | "recover";
		rejectionExitThreshold: number | undefined;
		failedWorkerReapHours: number | undefined;
	} {
		const daemon = this.settings.daemon;
		const threshold = daemon?.supervisorRejectionExitThreshold;
		const reapHours = daemon?.failedWorkerReapHours;
		const reapingDisabled =
			daemon?.failedWorkerReapEnabled === false ||
			(typeof reapHours === "number" && Number.isFinite(reapHours) && reapHours <= 0);
		return {
			eventGapRecovery: daemon?.eventGapRecovery === "recover" ? "recover" : "log",
			rejectionExitThreshold:
				typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0
					? Math.floor(threshold)
					: undefined,
			failedWorkerReapHours: reapingDisabled
				? undefined
				: typeof reapHours === "number" && Number.isFinite(reapHours)
					? reapHours
					: DEFAULT_FAILED_WORKER_REAP_HOURS,
		};
	}

	/**
	 * Disk-retention policy (round-08 design). Every day/hour knob resolves to 0
	 * when it is switched off, so a class only has to test one value.
	 */
	getRetentionSettings(): ResolvedRetentionSettings {
		return resolveRetentionSettings(this.settings.retention);
	}

	/** Wake policy for agent messages queued into a session whose pump is suspended. */
	/** Silence (ms) after which a call with no output and no progress is stuck; clamped, NaN-safe. */
	getSilentStuckMs(): number {
		const raw = Number(this.settings.tools?.timeout?.silentStuckSeconds ?? DEFAULT_SILENT_STUCK_SECONDS);
		const seconds = Number.isFinite(raw) ? raw : DEFAULT_SILENT_STUCK_SECONDS;
		return Math.min(SILENT_STUCK_MAX_SECONDS, Math.max(SILENT_STUCK_MIN_SECONDS, seconds)) * 1000;
	}

	/** CPU (ms) a step's process tree must burn between checks to count as busy; NaN-safe, at least 1. */
	getSilentStuckCpuMs(): number {
		const raw = Number(this.settings.tools?.timeout?.silentStuckCpuMs ?? 1000);
		return Number.isFinite(raw) && raw >= 1 ? raw : 1000;
	}

	getSelfRecoverySettings(): { autoContinue: boolean; childReplyNudge: boolean } {
		const settings = this.settings.selfRecovery;
		return {
			autoContinue: settings?.autoContinue !== false,
			childReplyNudge: settings?.childReplyNudge === true,
		};
	}

	getSubagentWakePolicy(): SubagentWakePolicy {
		const policy = this.settings.subagentWake?.policy;
		return policy === "never" || policy === "always" ? policy : "failure_aggregated";
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	/**
	 * In-place retry policy for clean-but-empty assistant turns. Honors `retry.enabled`
	 * (switching retries off leaves a single attempt) so the empty-reply path is gated by
	 * the same setting as every other retry class instead of being a hidden exception.
	 */
	getEmptyTurnRetrySettings(): EmptyTurnRetrySettings {
		const emptyTurn = this.settings.retry?.emptyTurn ?? {};
		// `retry.enabled: false` must mean "no automatic resends anywhere", including the
		// loop's in-place empty-turn retries and the escalated slow tier, so it collapses
		// to a single attempt with no slow tier here. Omitted numbers are left undefined:
		// the agent loop owns the defaults.
		if (!this.getRetryEnabled()) {
			return { ...emptyTurn, maxAttempts: 1, escalatedAttempts: 0 };
		}
		return this._clampEscalatedEmptyTurnWaits({ ...emptyTurn });
	}

	/**
	 * Keep every slow-tier wait strictly below the stall watchdog's warn threshold:
	 * the watchdog measures silence since the last session event, and each retry
	 * attempt emits one, so a gap of wait + time-to-first-event at or above the warn
	 * threshold would misreport a planned recovery wait as a stall. The resolved cap
	 * (not the raw stored key) is what the loop consumes, so the clamp holds even for
	 * the defaults whenever the warn threshold is lowered below them.
	 */
	private _clampEscalatedEmptyTurnWaits(settings: EmptyTurnRetrySettings): EmptyTurnRetrySettings {
		const watchdog = this.getStallWatchdogSettings();
		if (!watchdog.enabled || watchdog.warnAfterSeconds <= 0) return settings;
		// One second of headroom for the next attempt's time-to-first-event.
		const clampMs = Math.max(1_000, watchdog.warnAfterSeconds * 1000 - 1_000);
		const resolvedCap = Math.max(
			settings.escalatedBaseDelayMs ?? ESCALATED_EMPTY_TURN_RETRY_DEFAULTS.escalatedBaseDelayMs,
			settings.escalatedMaxDelayMs ?? ESCALATED_EMPTY_TURN_RETRY_DEFAULTS.escalatedMaxDelayMs,
		);
		if (resolvedCap <= clampMs) return { ...settings, escalatedMaxDelayClampMs: clampMs };
		if (!this.emptyTurnClampWarned) {
			this.emptyTurnClampWarned = true;
			// A warn, once per settings manager: the clamp is a correctness guard, but a
			// silently rewritten number is indistinguishable from an ignored one.
			console.warn(
				`retry.emptyTurn.escalatedMaxDelayMs clamped to ${clampMs}ms to stay under stallWatchdog.warnAfterSeconds (${watchdog.warnAfterSeconds}s).`,
			);
		}
		// The clamp field is what the loop enforces (on base AND cap); rewriting the
		// stored cap on top is double insurance for consumers that only read the cap.
		return { ...settings, escalatedMaxDelayMs: clampMs, escalatedMaxDelayClampMs: clampMs };
	}

	/**
	 * Recovery continuation policy for an exhausted empty-response ladder. Honors
	 * `retry.enabled` the same way the in-place tiers do: switching retries off is
	 * switching the whole automatic-recovery ladder off.
	 */
	getEmptyTurnRecoverySettings(): { enabled: boolean; maxContinuations: number } {
		const recovery = this.settings.retry?.emptyTurn?.recovery;
		const enabled = this.getRetryEnabled() && (recovery?.enabled ?? true);
		const maxContinuations = Math.max(0, Math.floor(recovery?.maxContinuations ?? 1));
		return { enabled, maxContinuations };
	}

	/**
	 * Resolved per-tool-call deadline policy. `afterMs` is clamped into the
	 * documented 60s-600s window when positive; `enabled: false` and `afterMs: 0`
	 * both resolve to a disabled deadline (the two rollback handles).
	 */
	getToolTimeoutSettings(): { enabled: boolean; afterMs: number; perTool?: Record<string, number> } {
		const timeout = this.settings.tools?.timeout;
		const enabled = timeout?.enabled ?? true;
		// Blind-1, medium: a non-numeric `afterMs` (e.g. "not-a-number" in
		// settings.json) survives every `<= 0` gate (NaN comparisons are false) and
		// lands in setTimeout(NaN) ~ 1ms - every tool call killed instantly, with
		// "per-call budget NaNms" and no warning. Coerce, then require a finite
		// positive number; anything else falls back to the documented default.
		const raw = Number(timeout?.afterMs ?? DEFAULT_TOOL_TIMEOUT_AFTER_MS);
		if (!Number.isFinite(raw))
			return {
				enabled,
				afterMs: DEFAULT_TOOL_TIMEOUT_AFTER_MS,
				...(timeout?.perTool === undefined ? {} : { perTool: timeout.perTool }),
			};
		if (raw <= 0)
			return { enabled, afterMs: 0, ...(timeout?.perTool === undefined ? {} : { perTool: timeout.perTool }) };
		const afterMs = Math.min(TOOL_TIMEOUT_MAX_AFTER_MS, Math.max(TOOL_TIMEOUT_MIN_AFTER_MS, raw));
		// Per-tool entries pass through unclamped: an operator budgeting a specific
		// long-running tool past the shared window is the documented exemption use.
		return { enabled, afterMs, ...(timeout?.perTool === undefined ? {} : { perTool: timeout.perTool }) };
	}

	getProviderRetrySettings(): {
		timeoutMs?: number;
		maxRetries?: number;
		maxRetryDelayMs: number;
		streamStallTimeoutMs: number;
	} {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			// The merge kept the declared shape but dropped this key from the returned
			// object, so `retry.provider.maxRetries` was silently a no-op at runtime while
			// the type still advertised it. It is the number the provider-retry module
			// uses as its retry count (see providerRetryPolicy).
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
			streamStallTimeoutMs: this.settings.retry?.provider?.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS,
		};
	}

	getProviderWaitSettings(): ProviderWaitPolicy {
		const wait = this.settings.retry?.provider?.waitForUsage;
		const bound = (value: number | undefined, fallback: number): number =>
			typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
		return {
			enabled: wait?.enabled ?? true,
			baseDelayMs: bound(wait?.baseDelayMs, 1000),
			maxDelayMs: bound(wait?.maxDelayMs, 300_000),
			maxAttempts: bound(wait?.maxAttempts, 30),
			maxWaitMs: bound(wait?.maxWaitMs, 900_000),
			pauseUntilReset: wait?.pauseUntilReset ?? true,
			// Very large parks are clamped to MAX_PROVIDER_PAUSE_MS instead of
			// silently waiting weeks for a stale reset.
			maxPauseMs: Math.min(bound(wait?.maxPauseMs, 86_400_000), MAX_PROVIDER_PAUSE_MS),
			maxParks: bound(wait?.maxParks, 8),
		};
	}

	getProviderBackupModel(): string | undefined {
		// Parsed settings are only cast to Settings; a non-string JSON value
		// (e.g. 123) must behave as unset, never throw into the retry path.
		const reference = this.settings.providerBackupModel;
		if (typeof reference !== "string") return undefined;
		return reference.trim() ? reference.trim() : undefined;
	}

	getProviderFallbackLongWait(): { baseDelayMs: number; maxDelayMs: number; maxRounds: number } {
		const wait = this.settings.retry?.provider?.fallbackLongWait;
		const bound = (value: number | undefined, fallback: number): number =>
			typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : fallback;
		const baseDelayMs = bound(wait?.baseDelayMs, PROVIDER_LONG_WAIT_BASE_MS);
		return {
			baseDelayMs,
			maxDelayMs: Math.max(baseDelayMs, bound(wait?.maxDelayMs, PROVIDER_LONG_WAIT_MAX_MS)),
			maxRounds: bound(wait?.maxRounds, PROVIDER_LONG_WAIT_MAX_ROUNDS),
		};
	}

	/** The fallback chain references, in order; `[]` when switched off. */
	getProviderFallbackModels(): string[] {
		const references = this.settings.providerFallbackModels;
		// Unset means no chain: which models a machine may fall back to is the owner's
		// choice, kept in their settings, not a fleet baked into the source.
		if (references === undefined || references === null) return [];
		// A malformed value behaves as off rather than as the default chain: the
		// owner wrote something, and an unexpected switch is the worse surprise.
		if (!Array.isArray(references)) return [];
		return references
			.filter((reference): reference is string => typeof reference === "string" && reference.trim().length > 0)
			.map((reference) => reference.trim());
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	getImageModel(): string | undefined {
		// Same shape as providerBackupModel: malformed values behave as unset
		// and the image-turn refusal names the setting instead.
		const reference = this.settings.imageModel;
		if (typeof reference !== "string") return undefined;
		return reference.trim() ? reference.trim() : undefined;
	}

	getShellPath(): string | undefined {
		return this.settings.shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.packages = packages;
		this.markProjectModified("packages");
		this.saveProjectSettings(projectSettings);
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	getExtensionHandlerTimeoutMs(): number {
		const value = this.settings.extensionHandlerTimeoutMs;
		if (value === 0) return 0;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return Math.floor(value);
		}
		return DEFAULT_EXTENSION_HANDLER_TIMEOUT_MS;
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.extensions = paths;
		this.markProjectModified("extensions");
		this.saveProjectSettings(projectSettings);
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.skills = paths;
		this.markProjectModified("skills");
		this.saveProjectSettings(projectSettings);
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.prompts = paths;
		this.markProjectModified("prompts");
		this.saveProjectSettings(projectSettings);
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		const projectSettings = structuredClone(this.projectSettings);
		projectSettings.themes = paths;
		this.markProjectModified("themes");
		this.saveProjectSettings(projectSettings);
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getBundledSkills(): { websearch: boolean } {
		return {
			websearch: this.settings.bundledSkills?.websearch ?? true,
		};
	}

	getBundledWebsearchEnabled(): boolean {
		return this.getBundledSkills().websearch;
	}

	getEnableBuiltinSkills(): boolean {
		return this.settings.enableBuiltinSkills ?? true;
	}

	setEnableBuiltinSkills(enabled: boolean): void {
		this.globalSettings.enableBuiltinSkills = enabled;
		this.markModified("enableBuiltinSkills");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	getClearOnShrink(): boolean {
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getFullscreen(): boolean {
		if (process.env.PI_FULLSCREEN !== undefined) {
			return process.env.PI_FULLSCREEN === "1";
		}
		return this.settings.terminal?.fullscreen ?? true;
	}

	setFullscreen(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.fullscreen = enabled;
		this.markModified("terminal", "fullscreen");
		this.save();
	}

	getFullscreenMouse(): boolean {
		return this.settings.terminal?.fullscreenMouse ?? true;
	}

	setFullscreenMouse(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.fullscreenMouse = enabled;
		this.markModified("terminal", "fullscreenMouse");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	getRequestTiming(): boolean {
		return this.settings.requestTiming ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	/** MCP execution is intentionally restricted to user/global settings. */
	getGlobalMcpServers(): Record<string, McpServerConfig> | undefined {
		return structuredClone(this.globalSettings.mcpServers);
	}

	/** Declared local service-catalog source paths (unexpanded ~ allowed). */
	getMcpCatalogSources(): string[] {
		return structuredClone(this.globalSettings.mcpCatalogSources ?? []);
	}

	setGlobalMcpServer(name: string, config: McpServerConfig, force = false): void {
		if (this.globalSettings.mcpServers?.[name] && !force) {
			throw new Error(`MCP server "${name}" already exists. Use --force to replace it.`);
		}
		this.globalSettings.mcpServers = { ...(this.globalSettings.mcpServers ?? {}), [name]: structuredClone(config) };
		this.markModified("mcpServers", name);
		this.save();
	}

	removeGlobalMcpServer(name: string): boolean {
		if (!this.globalSettings.mcpServers?.[name]) return false;
		const servers = { ...this.globalSettings.mcpServers };
		delete servers[name];
		this.globalSettings.mcpServers = servers;
		this.markModified("mcpServers", name);
		this.save();
		return true;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "user-only";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	/**
	 * CD-6: docs/terminal-setup.md documents `PI_HARDWARE_CURSOR=1` as the way to
	 * switch the hardware cursor on, so an explicitly set environment variable wins
	 * over the file. A settings file that once wrote `false` must not be able to
	 * silence the documented switch - and when the two disagree, say so.
	 */
	getShowHardwareCursor(): boolean {
		const rawEnvValue = process.env[HARDWARE_CURSOR_ENV_VAR];
		const envValue = parseBooleanEnvSwitch(rawEnvValue);
		const fileValue = this.settings.showHardwareCursor;
		if (envValue === undefined) {
			return fileValue ?? false;
		}
		if (fileValue !== undefined && fileValue !== envValue) {
			const scope: SettingsScope = this.projectSettings.showHardwareCursor !== undefined ? "project" : "global";
			this.recordWarning(
				scope,
				`env-conflict:${HARDWARE_CURSOR_ENV_VAR}:${rawEnvValue}:${fileValue}`,
				`${HARDWARE_CURSOR_ENV_VAR}=${rawEnvValue} (${envValue}) conflicts with showHardwareCursor=${fileValue} (${scope} settings): the environment variable wins`,
			);
		}
		return envValue;
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	/**
	 * Whether the sub-agents tray renders its spend cell (and refreshes it).
	 *
	 * The cell is the tray's only consumer of the session context tree, which is a
	 * disk-scanning RPC; `false` is the emergency switch for a session whose tray
	 * figure is not worth that scan. Default true - the cell is on unless the user
	 * turned it off.
	 */
	getSubagentSpendCellEnabled(): boolean {
		return this.settings.ui?.subagentSpendCell !== false;
	}

	/**
	 * How stale the spend cell's figure may get, in ms. An object form sets it; a
	 * non-number clamps to the default instead of failing, and out-of-range values
	 * clamp to the bound (a NaN-free, never-throwing read, like `triggerRatio`).
	 */
	getSubagentSpendCellIntervalMs(): number {
		const raw = this.settings.ui?.subagentSpendCell;
		const configured = typeof raw === "object" && raw !== null ? raw.intervalMs : undefined;
		if (typeof configured !== "number" || !Number.isFinite(configured)) {
			return DEFAULT_SUBAGENT_SPEND_CELL_INTERVAL_MS;
		}
		return Math.max(
			MIN_SUBAGENT_SPEND_CELL_INTERVAL_MS,
			Math.min(MAX_SUBAGENT_SPEND_CELL_INTERVAL_MS, Math.floor(configured)),
		);
	}

	/**
	 * The spend cell's price corrections, sanitized: only usable fields survive
	 * here, so a caller never has to guard against a string, a NaN or a negative
	 * rate. An unusable field was reported as a warning when the settings were
	 * loaded, and falls back to the `models.json` rate, which is what makes this
	 * getter safe to call on every refresh of the cell.
	 */
	getSubagentSpendCellPriceOverrides(): SpendPriceOverrides {
		return readSpendPriceOverrides(this.rawSubagentSpendCellPriceOverrides(), SPEND_PRICE_OVERRIDES_PATH).overrides;
	}

	/**
	 * The raw `ui.subagentSpendCell.priceOverrides` block of the merged settings.
	 * `ui.subagentSpendCell` is either a boolean or the tuning object, so the
	 * boolean form has nothing to read.
	 */
	private rawSubagentSpendCellPriceOverrides(): unknown {
		const raw = this.settings.ui?.subagentSpendCell;
		return typeof raw === "object" && raw !== null ? raw.priceOverrides : undefined;
	}

	setSubagentSpendCellIntervalMs(intervalMs: number): void {
		const current = this.globalSettings.ui?.subagentSpendCell;
		const settings = typeof current === "object" && current !== null ? { ...current } : {};
		settings.intervalMs = intervalMs;
		this.globalSettings.ui ??= {};
		this.globalSettings.ui.subagentSpendCell = settings;
		this.markModified("ui", "subagentSpendCell");
		this.save();
	}

	setSubagentSpendCellEnabled(enabled: boolean): void {
		this.globalSettings.ui ??= {};
		this.globalSettings.ui.subagentSpendCell = enabled;
		this.markModified("ui", "subagentSpendCell");
		this.save();
	}

	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.globalSettings.markdown ??= {};
		this.globalSettings.markdown.mermaid = mode;
		this.markModified("markdown", "mermaid");
		this.save();
	}

	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}

/**
 * Resolve the agent-message wait tiers from the one setting. Half the long tier for the short
 * ones, floored at a second so a tiny configured value cannot produce a zero wait that fails
 * every healthy target.
 */
export function resolveAgentMessageWaitSeconds(targetWaitSeconds: unknown): ResolvedAgentMessageWaitSettings {
	if (typeof targetWaitSeconds !== "number" || !Number.isFinite(targetWaitSeconds)) {
		return resolveAgentMessageWaitSeconds(DEFAULT_AGENT_MESSAGE_TARGET_WAIT_SECONDS);
	}
	if (targetWaitSeconds <= 0) {
		const unbounded = Number.POSITIVE_INFINITY;
		return { passivationMs: unbounded, bindMs: unbounded, hydrateMs: unbounded, publicationMs: unbounded };
	}
	const passivationMs = Math.floor(targetWaitSeconds) * 1000;
	const shortMs = Math.max(1000, Math.round(passivationMs / 2));
	return { passivationMs, bindMs: shortMs, hydrateMs: shortMs, publicationMs: shortMs };
}

/**
 * A restart bound: `0` (or any non-positive value) is the documented rollback lever and resolves
 * to `Infinity`, i.e. the bound never trips; a non-number falls back to the shipped default.
 */
function normalizeRestartBound(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value <= 0) return Number.POSITIVE_INFINITY;
	return Math.floor(value);
}

/** 0 disables the bound; any other non-positive/non-finite value falls back to the default. */
function normalizeKernelBootstrapLockTimeoutMs(value: unknown): number {
	if (value === 0) return 0;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	return DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS;
}

/**
 * Kernel-bootstrap settings for callers with no session (kernel bootstrap, postinstall,
 * bootstrap-cli). Reads both scopes from disk on every call, so an operator editing
 * settings.json is honoured by the next boot without a restart. Unreadable or absent
 * scopes yield the defaults rather than failing the boot.
 */
/**
 * Agent-message wait tiers for callers with no session (the daemon's passivation, bind and
 * hydration waits). Reads both scopes from disk on every call, so an operator editing
 * settings.json is honoured by the next wait.
 */
export function readAgentMessageWaitSettings(
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): ResolvedAgentMessageWaitSettings {
	return SettingsManager.fromStorage(new FileSettingsStorage(cwd, agentDir)).getAgentMessageWaitSettings();
}

export function readKernelBootstrapSettings(
	cwd: string = process.cwd(),
	agentDir: string = getAgentDir(),
): { lockTimeoutMs: number } {
	return SettingsManager.fromStorage(new FileSettingsStorage(cwd, agentDir)).getKernelBootstrapSettings();
}

/**
 * A day/hour knob: `0` or negative switches the class off (the documented
 * rollback lever), a non-number falls back to the shipped default.
 */
function normalizeRetentionWindowDays(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	if (value <= 0) return 0;
	return value;
}

/** A circuit-breaker cap: non-positive keeps the default, so the breaker cannot be removed. */
function normalizeRetentionCap(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return Math.floor(value);
}

function normalizeRetentionCount(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

/**
 * Resolve the `retention` section. Exported because the sweep, the CLI runner and
 * the tests all need the same numbers without constructing a SettingsManager, and
 * because every "0 = off" decision has to be made in exactly one place.
 */
export function resolveRetentionSettings(settings?: RetentionSettings): ResolvedRetentionSettings {
	return {
		enabled: settings?.enabled !== false,
		dryRun: settings?.dryRun === true || process.env.PRIME_AGENT_RETENTION_DRYRUN === "1",
		sweepIntervalMinutes: normalizeRetentionWindowDays(
			settings?.sweepIntervalMinutes,
			DEFAULT_RETENTION_SWEEP_INTERVAL_MINUTES,
		),
		maxDeleteBytesPerSweep: normalizeRetentionCap(
			settings?.maxDeleteBytesPerSweep,
			DEFAULT_RETENTION_MAX_DELETE_BYTES_PER_SWEEP,
		),
		maxDeleteEntriesPerSweep: normalizeRetentionCap(
			settings?.maxDeleteEntriesPerSweep,
			DEFAULT_RETENTION_MAX_DELETE_ENTRIES_PER_SWEEP,
		),
		// Unlike a class window, the cooldown cannot be switched off: a non-positive
		// value keeps the shipped window, so "no cooldown" is not reachable by config.
		cooldownMinutes: normalizeRetentionCap(settings?.cooldownMinutes, DEFAULT_RETENTION_COOLDOWN_MINUTES),
		// On by default: the guard is the account-integrity fix, and it degrades to an
		// unlocked sweep by itself whenever it cannot be taken (see retention/runner.ts).
		sweepLockEnabled: settings?.sweepLockEnabled !== false,
		emptyArtifactDirDays: normalizeRetentionWindowDays(
			settings?.emptyArtifactDirDays,
			DEFAULT_RETENTION_EMPTY_ARTIFACT_DIR_DAYS,
		),
		deletedSessionResidueDays: normalizeRetentionWindowDays(
			settings?.deletedSessionResidueDays,
			DEFAULT_RETENTION_DELETED_SESSION_RESIDUE_DAYS,
		),
		// Live children are kept by their ledger edge, not by an off-by-default
		// switch: the 30-day window reclaims deleted children's transcripts while
		// round-09 ruling 1's live-reference concern is enforced by the class.
		childTranscriptDays: normalizeRetentionWindowDays(
			settings?.childTranscriptDays,
			DEFAULT_RETENTION_CHILD_TRANSCRIPT_DAYS,
		),
		logFileDays: normalizeRetentionWindowDays(settings?.logFileDays, DEFAULT_RETENTION_LOG_FILE_DAYS),
		tmpRlmDirHours: normalizeRetentionWindowDays(settings?.tmpRlmDirHours, DEFAULT_RETENTION_TMP_RLM_DIR_HOURS),
		tmpOtherDirDays: normalizeRetentionWindowDays(settings?.tmpOtherDirDays, 0),
		bashTempFileHours: normalizeRetentionWindowDays(
			settings?.bashTempFileHours,
			DEFAULT_RETENTION_BASH_TEMP_FILE_HOURS,
		),
		bashTempFileMaxBytes: normalizeRetentionCap(
			settings?.bashTempFileMaxBytes,
			DEFAULT_RETENTION_BASH_TEMP_FILE_MAX_BYTES,
		),
		staleLeaseHours: normalizeRetentionWindowDays(settings?.staleLeaseHours, DEFAULT_RETENTION_STALE_LEASE_HOURS),
		kernelSnapshotGenerations: normalizeRetentionCount(
			settings?.kernelSnapshotGenerations,
			DEFAULT_RETENTION_KERNEL_SNAPSHOT_GENERATIONS,
		),
		kernelSnapshotReclaimEnabled: settings?.kernelSnapshotReclaimEnabled === true,
		// Default on: the compaction rung is what keeps spawning and deletion
		// alive on a ledger that outgrew its bounds (r41 ADC-2).
		ledgerCompactionEnabled: settings?.ledgerCompactionEnabled !== false,
		venvRetention: normalizeRetentionCount(settings?.venvRetention, RETIRED_VENV_RETENTION),
		venvReclaim: settings?.venvReclaim === true,
	};
}
