import type { ServiceTier, Transport } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { sleepSync } from "../utils/sleep.js";
import { DEFAULT_EXTENSION_HANDLER_TIMEOUT_MS } from "./extensions/timeout.js";
import { RETIRED_VENV_RETENTION } from "./kernel/venv-in-use.js";
import type { ResolvedRetentionSettings } from "./retention/types.js";

const RECENT_MODELS_LIMIT = 20;
export const DEFAULT_IDLE_EVICTION_MINUTES = 90;

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

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
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
	 * Child transcripts (`sub-xxxxxxxx/<uuid>.jsonl`) older than this. Default: 0 (off).
	 * Deleted by age only when the owner asks: the bytes ride live sub-agent
	 * references (round-08 D-1), so the shipped answer is "age is not the judge".
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

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

export type SettingsScope = "global" | "project";

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		this.globalSettingsPath = join(agentDir, "settings.json");
		this.projectSettingsPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
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
					writeFileSync(temporaryPath, next, { encoding: "utf-8", mode: 0o600 });
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
	private settings: Settings;
	private runtimeOverrides: Settings = {};
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

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
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
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

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope): Settings {
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {};
		}
		const settings = JSON.parse(content);
		return SettingsManager.migrateSettings(settings);
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
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

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.runtimeOverrides = deepMergeSettings(this.runtimeOverrides, overrides);
		this.settings = deepMergeSettings(this.settings, overrides);
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

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

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
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

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

	getAgentTracesEnabled(): boolean {
		return this.settings.agentTraces?.enabled ?? false;
	}

	setAgentTracesEnabled(enabled: boolean): void {
		if (!this.globalSettings.agentTraces) {
			this.globalSettings.agentTraces = {};
		}
		this.globalSettings.agentTraces.enabled = enabled;
		this.markModified("agentTraces", "enabled");
		this.save();
	}

	getTelemetryEnabled(): boolean {
		const globalEnabled = this.globalSettings.telemetry?.enabled ?? true;
		const projectEnabled = this.projectSettings.telemetry?.enabled ?? true;
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

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
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
		// No shipped default above zero: the owner decided child transcripts are not
		// reclaimed by age (round-08 D-1, round-09 ruling 1).
		childTranscriptDays: normalizeRetentionWindowDays(settings?.childTranscriptDays, 0),
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
		venvRetention: normalizeRetentionCount(settings?.venvRetention, RETIRED_VENV_RETENTION),
		venvReclaim: settings?.venvReclaim === true,
	};
}
