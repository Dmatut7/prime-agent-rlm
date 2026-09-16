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
import { DEFAULT_EXTENSION_HANDLER_TIMEOUT_MS } from "./extensions/timeout.js";
import { RETIRED_VENV_RETENTION } from "./kernel/venv-in-use.js";
import type { ResolvedRetentionSettings } from "./retention/types.js";

const RECENT_MODELS_LIMIT = 20;
export const DEFAULT_IDLE_EVICTION_MINUTES = 90;

/**
 * Poll interval for noticing a direct edit of `settings.json` (CD-5). One second
 * is fast enough that a hand edit lands while the user is still looking at the
 * terminal, and cheap enough that two `stat` calls per second are invisible.
 */
export const DEFAULT_SETTINGS_WATCH_INTERVAL_MS = 1000;

/** Abort a provider stream after this long without any events (0 = disabled). */
export const DEFAULT_STREAM_STALL_TIMEOUT_MS = 300_000;

/** Session stall watchdog: warn after this long without any session activity. */
export const DEFAULT_STALL_WARN_AFTER_SECONDS = 300;

/**
 * Session stall watchdog: abort the turn after this long without any session
 * activity. Must be greater than the warn threshold when both are enabled.
 */
export const DEFAULT_STALL_ABORT_AFTER_SECONDS = 900;

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

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
	streamStallTimeoutMs?: number; // default: 300000 (5 min with zero stream events => abort + retryable error); 0 disables
}

export interface EmptyTurnRetrySettings {
	maxAttempts?: number; // default: 3 total provider attempts for one turn
	baseDelayMs?: number; // default: 500, doubled per attempt
	maxDelayMs?: number; // default: 4000 cap for a single wait
	maxTotalDelayMs?: number; // default: bounded by the remaining attempts
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
 * watchdog warns after `warnAfterSeconds` without any session event and aborts
 * the turn after `abortAfterSeconds`. Both thresholds count from the last
 * observed activity; timer escalations are deferred while compaction, branch
 * summaries, or serialized refinement own the turn boundary.
 */
export interface StallWatchdogSettings {
	enabled?: boolean; // default: true
	warnAfterSeconds?: number; // default: 300 (5 min silent => warning + diagnostics)
	abortAfterSeconds?: number; // default: 900 (15 min silent => auto-abort); must exceed warnAfterSeconds
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

export type MermaidRenderingMode = "off" | "final" | "streaming";

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
	mermaid?: MermaidRenderingMode; // default: "streaming"
}

export interface BundledSkillsSettings {
	websearch?: boolean; // default: true
}

export interface ToolsSettings {
	// Reserved for future tool-level settings. The classic bash tool is not part of
	// the RLM model surface, so there is currently nothing configurable here.
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
 * Remote/local MCP server an integration connects to. Built-in integrations
 * (Linear/Notion) are defined in the ai/mcp catalog; this is for user-declared
 * servers. The kernel-side integration package reads creds from auth.json
 * (`mcp:<name>`); login/refresh run host-side.
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
	recentModels?: string[]; // "provider/id" keys, most-recently-used first
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	defaultServiceTier?: ServiceTier;
	rlmMaxDepth?: number; // default for new sessions; unset falls through to RLM_MAX_DEPTH, then 2
	idleEvictionMinutes?: number | "off"; // global daemon policy; default: 90
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	stallWatchdog?: StallWatchdogSettings;
	subagentWake?: SubagentWakeSettings;
	kernelBootstrap?: KernelBootstrapSettings;
	kernelRestart?: KernelRestartSettings;
	agentMessage?: AgentMessageSettings;
	daemon?: DaemonSettings;
	autoRefine?: AutoRefineSettings;
	agentTraces?: AgentTracesSettings;
	telemetry?: TelemetrySettings;
	branchSummary?: BranchSummarySettings;
	retention?: RetentionSettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
	quietStartup?: boolean;
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	mcpServers?: Record<string, McpServerConfig>; // User-declared MCP servers (name → config); built-ins are in the ai/mcp catalog
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
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
}

export interface AgentTracesSettings {
	enabled?: boolean;
}

export interface TelemetrySettings {
	enabled?: boolean;
	noticeShown?: boolean;
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
	recentModels: null,
	defaultThinkingLevel: null,
	defaultServiceTier: null,
	rlmMaxDepth: null,
	idleEvictionMinutes: null,
	transport: null,
	steeringMode: null,
	followUpMode: null,
	theme: null,
	compaction: ["enabled", "reserveTokens", "keepRecentTokens", "agentCallable"],
	stallWatchdog: [
		"enabled",
		"warnAfterSeconds",
		"abortAfterSeconds",
		"toolLivenessExemption",
		"treatKernelCpuProgressAsActivity",
	],
	subagentWake: ["policy"],
	kernelBootstrap: ["lockTimeoutMs"],
	kernelRestart: ["maxUnexpectedRestarts", "windowMinutes", "revivalVouchMaxAgeSeconds"],
	agentMessage: ["targetWaitSeconds"],
	daemon: ["eventGapRecovery", "supervisorRejectionExitThreshold", "failedWorkerReapHours", "failedWorkerReapEnabled"],
	autoRefine: ["enabled", "turnInterval", "compact", "cooldownMs"],
	agentTraces: ["enabled"],
	telemetry: ["enabled", "noticeShown"],
	branchSummary: ["reserveTokens", "skipPrompt"],
	retention: [
		"enabled",
		"dryRun",
		"sweepIntervalMinutes",
		"maxDeleteBytesPerSweep",
		"maxDeleteEntriesPerSweep",
		"cooldownMinutes",
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
	shellPath: null,
	quietStartup: null,
	shellCommandPrefix: null,
	npmCommand: null,
	mcpServers: null,
	packages: null,
	extensions: null,
	extensionHandlerTimeoutMs: null,
	skills: null,
	prompts: null,
	themes: null,
	enableSkillCommands: null,
	bundledSkills: ["websearch"],
	tools: [],
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
	sessionDir: null,
};

/** Deeper-than-one-level blocks, keyed by their full dotted path. */
const KNOWN_NESTED_SETTINGS_KEYS: Record<string, readonly string[] | null> = {
	"retry.provider": ["timeoutMs", "maxRetries", "maxRetryDelayMs", "streamStallTimeoutMs"],
	"retry.emptyTurn": ["maxAttempts", "baseDelayMs", "maxDelayMs", "maxTotalDelayMs"],
};

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
			const next = fn(current);
			if (next !== undefined) {
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
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
		return true;
	}

	/** Whether external-settings edits are currently being watched. */
	isWatchingExternalSettings(): boolean {
		return this.externalWatchers.length > 0;
	}

	/** Stop watching for external settings edits. Safe to call when not watching. */
	stopWatchingExternalSettings(): void {
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

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
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
		// loop's in-place empty-turn retries, so it collapses to a single attempt here.
		// Omitted numbers are left undefined: the agent loop owns the defaults.
		return this.getRetryEnabled() ? { ...emptyTurn } : { ...emptyTurn, maxAttempts: 1 };
	}

	getProviderRetrySettings(): {
		timeoutMs?: number;
		maxRetries?: number;
		maxRetryDelayMs: number;
		streamStallTimeoutMs: number;
	} {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
			streamStallTimeoutMs: this.settings.retry?.provider?.streamStallTimeoutMs ?? DEFAULT_STREAM_STALL_TIMEOUT_MS,
		};
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
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
