/**
 * Background daemon mode.
 *
 * The daemon owns live AgentSessionRuntime instances and exposes a small JSONL
 * protocol over a local socket. Clients can attach/detach from sessions without
 * disposing the underlying agent loop.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, getLogger, type Model } from "@earendil-works/pi-ai";
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
	AGENT_FAMILY_REACH_ERROR,
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyCatalogEntry,
	type AgentFamilyDirectory,
	type AgentFamilyRelationship,
	type AgentMessageQueuedReason,
	type AgentSessionMessageAgentSummary,
	type AgentSessionMessageController,
	type AgentSessionMessageDeliveryStatus,
	type AgentSessionMessageEndpoint,
	type AgentSessionMessageListResult,
	type AgentSessionMessagePayload,
	type AgentSessionMessageQueuedFacts,
	AgentSessionMessageRateLimiter,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSender,
	agentFamilyRelationship,
	assertAgentFamilyReach,
	assertAgentSessionNameAvailable,
	assertDirectAgentMessageTarget,
	buildAgentFamilyRosterFromDirectory,
	createAgentSessionMessage,
	createAgentSessionMessageId,
	createAgentSessionMessageReceipt,
	DEFAULT_AGENT_MESSAGE_MAX_CHARS,
	DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
	DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY,
	DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS,
	formatAgentMessageQueuedNotice,
	formatAgentSessionNameUnavailable,
	normalizeAgentSessionMessage,
	selectAgentFamilyDirectory,
	sessionNameReservationKey,
} from "../../core/agent-messages.js";
import {
	AGENT_OBSERVE_PREVIEW_MAX_CHARS,
	type AgentObserveAgentSnapshot,
	type AgentObserveAgentSummary,
	type AgentObserveController,
	type AgentObserveListResult,
	type AgentObserveRecentMessagesInput,
	type AgentObserveRecentMessagesResult,
	createAgentObserveFamilyList,
	createAgentObserveMessagePreview,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
} from "../../core/agent-observe.js";
import { type PromptOptions, rlmChildLabel } from "../../core/agent-session.js";
import { type AgentSessionRuntimeConfig, mergeAgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import {
	type AgentSessionRuntime,
	type AgentSessionRuntimeDisposeOptions,
	type AgentSessionRuntimeMetadata,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.js";
import {
	type AgentCronJob,
	type AgentCronJobRunResult,
	AgentCronJobStore,
	AgentCronScheduler,
	type AgentHeartbeatDeliveryMode,
	type AgentHeartbeatManagementAction,
	type AgentHeartbeatUpdateAction,
	DEFAULT_HEARTBEAT_SCHEDULE,
	isHeartbeatCronJob,
	normalizeHeartbeatDeliveryMode,
	normalizeHeartbeatSchedule,
	resolveHeartbeatStreamingBehavior,
	shouldDeferHeartbeatCronJob,
} from "../../core/cron-jobs.js";
import { flushOrphanProcessJournal, ORPHAN_PROCESS_JOURNAL_ENV } from "../../core/orphan-process-journal.js";
import { PromptAdmissionCancelledError, waitForPromptAdmission } from "../../core/prompt-admission.js";
import { providerRetryPolicy } from "../../core/provider-retry.js";
import type { CreateRlmSubagentRuntimeOptions, SubagentRuntimeHost } from "../../core/rlm-runtime.js";
import {
	canPassivateSession,
	clampForeignClockNow,
	type IdleEvictionMinutes,
	type SessionPassivationSnapshot,
} from "../../core/session-action-store.js";
import { deleteSessionArtifacts, deleteSessionFile } from "../../core/session-file-actions.js";
import { acquireSessionLeaseAsync, canonicalSessionPath, type SessionLease } from "../../core/session-lease.js";
import {
	appendOwnedSessionLineAsync,
	getSessionArtifactPathForFile,
	readSessionInfo,
	repairOwnedSessionFile,
	resolveSessionRlmDepth,
	type SessionInfo,
	SessionManager,
} from "../../core/session-manager.js";
import { resolveSessionPath } from "../../core/session-resolver.js";
import type { SessionStats } from "../../core/session-stats.js";
import {
	type ResolvedAgentMessageWaitSettings,
	readAgentMessageWaitSettings,
	SettingsManager,
} from "../../core/settings-manager.js";
import { type SideQuestionRun, startSideQuestion } from "../../core/side-question.js";
import {
	type AttemptBudget,
	consumeAttempt,
	createAttemptBudget,
	type WaitTimeoutFacts,
	withBound,
} from "../../utils/bounded-wait.js";
import { mapConcurrent } from "../../utils/map-concurrent.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import {
	createAgentConnectionCommands,
	createAgentConnectionResourceSnapshot,
	createAgentConnectionState,
} from "../agent-connection/snapshot.js";
import { createAgentConnectionToolDefinition } from "../agent-connection/tool-definition.js";
import type { AgentConnectionHeartbeat, AgentConnectionRlmChildAgentSnapshot } from "../agent-connection/types.js";
import { waitForHeadlessCompletion } from "../headless-completion.js";
import { initTheme } from "../interactive/theme/theme.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import { encodePrivateFrame, PrivateFrameDecoder } from "../session-worker/private-framing.js";
import {
	type ActiveSessionState,
	AmbiguousActiveSessionError,
	createActiveSessionId,
	type DaemonSocketClient,
	resolveActiveSessionState,
} from "./active-session-state.js";
import {
	passivatedWorkerRosterEntry,
	type RosterSessionSummary,
	rosterAgentIdForSummary,
	type WorkerRosterEntry,
	workerRosterEntryFromSummary,
} from "./agent-roster.js";
import { createCompactAssistantDelta, planCompactAssistantDelta } from "./compact-session-stream.js";
import { filterClientEnv, withClientEnv } from "./daemon-client-env.js";
import { deserializeDaemonError, serializeDaemonError } from "./daemon-errors.js";
import { bindActiveSessionState } from "./daemon-extension-binding.js";
import {
	createDaemonEventMeta,
	createDaemonReplayInfo,
	DAEMON_COMMAND_MAX_LINE_BYTES,
	DAEMON_DEFAULT_CLIENT_CAPABILITIES,
	DAEMON_DEFAULT_SERVER_CAPABILITIES,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	DAEMON_SUPPORTED_CLIENT_CAPABILITIES,
	DAEMON_UPDATE_RESTART_FORMAT_VERSION,
	type DaemonAttachResult,
	type DaemonClientCapability,
	type DaemonClosingReason,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
	type DaemonSessionClosedReason,
	type DaemonSessionSnapshot,
	type DaemonUpdateRestartManifest,
	type DaemonUpdateRestartSession,
	failure,
	isDaemonCommandEnvelope,
	isDaemonDialogExtensionUiRequest,
	isDaemonMutatingCommand,
	isSessionPlaneDaemonCommand,
	missingDeclaredCommandCapability,
	normalizeDeclaredCapabilities,
	salvageDaemonCommandId,
	success,
	UPDATE_RESTART_DRAIN_COMMANDS,
} from "./daemon-protocol.js";
import { getDaemonRuntimeIdentity } from "./daemon-runtime-identity.js";
import {
	buildRlmChildSnapshots,
	buildSessionList,
	classifySessionRosterStatus,
	hasLiveSessionWork,
	inactiveLifecycleForSession,
	type SessionSummary,
	scheduledJobRegistrations,
	summaryForActiveSession,
	summaryWithoutStreamingMessage,
} from "./daemon-session-list.js";
import { DaemonSessionSummarizer } from "./daemon-session-summarizer.js";
import {
	cleanupDaemonSocketPath,
	type DaemonSocketIdentity,
	daemonIpcListenOptions,
	defaultDaemonSocketPath,
	getDaemonSocketIdentity,
	normalizeSocketPath,
	prepareDaemonSocketPath,
	restrictDaemonSocketPath,
} from "./daemon-socket.js";
import { assertDaemonSupervisorOwnerCurrent, isDaemonShutdownAdmissionActive } from "./daemon-supervisor-ownership.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_PEER_TRANSPORT_CAPABILITY,
	DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_ROSTER_CAPABILITY,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
	type DaemonWorkerCommand,
	type DaemonWorkerFrameHeader,
	type DaemonWorkerPeerGrant,
	type DaemonWorkerRosterOutbound,
	isDaemonWorkerFrameHeader,
	ROSTER_HEARTBEAT_INTERVAL_MS,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "./daemon-worker-protocol.js";
import { MutationDrainLatch } from "./mutation-drain-latch.js";
import {
	createRlmLedgerRegistrySeedSource,
	type LegacyRlmSubagentRegistryEntry,
	type RlmLedgerBoundsOptions,
	type RlmLedgerDeleteReason,
	type RlmLedgerEdge,
	RlmLedgerOverBoundError,
	RlmSpawnLedger,
	readLegacyRlmSubagentRegistry as readLegacyRlmSubagentRegistryFile,
	tombstoneSavedSessionDelete,
	withPassiveRlmDescendantInfos,
} from "./rlm-ledger.js";
import {
	effectiveRlmSubagentDisplayStatus,
	readRlmSubagentDisplayEntry,
	rlmSubagentDisplayPath,
	writeRlmSubagentDisplayEntry,
} from "./rlm-subagent-display.js";
import { serializeSavedSessionInfo } from "./saved-session-info.js";
import {
	createSnapshotTranscriptChunks,
	SNAPSHOT_TARGET_CHUNK_BYTES,
	type SnapshotTranscriptChunkSource,
	TranscriptMessageSerializationCache,
} from "./snapshot-transcript-cache.js";
import {
	connectProbeSupervisor,
	probeSupervisorAvailability,
	checkSupervisorAvailability as runSupervisorAvailabilityCheck,
	SUPERVISOR_PROBE_TIMEOUT_MS,
	type SupervisorAvailabilityState,
} from "./supervisor-availability.js";
import { SupervisorLink } from "./supervisor-link.js";
import { writeUpdateRestartManifestFile } from "./update-restart-manifest.js";
import { WorkerRecoveryJournal } from "./worker-recovery-journal.js";

/**
 * Re-entry ceiling for one subagent hydration (M19). Unrelated to `RLM_MAX_DEPTH` on purpose:
 * that setting counts agent generations (default 2), so deriving a retry cap from it would fail
 * legitimate contention - several clients attaching to the same session each publish and re-enter
 * the hydration, and none of them is a recursion depth.
 */
const REHYDRATE_MAX_ATTEMPTS = 32;

export interface DaemonModeOptions {
	socketPath?: string;
	defaultSessionConfig: AgentSessionRuntimeConfig;
	createRuntime: CreateAgentSessionRuntimeFactory;
	worker?: {
		authenticationToken: string;
		workerInstanceId?: string;
		restoreActiveSessionId?: string;
	};
}

export type {
	DaemonCommand,
	DaemonOutbound,
	DaemonResponse,
} from "./daemon-protocol.js";
export type {
	SessionActivity,
	SessionLifecycle,
	SessionSummary,
} from "./daemon-session-list.js";
export { defaultDaemonSocketPath } from "./daemon-socket.js";

const structuredLog = getLogger("coding-agent.daemon");

/** Cap on tracked sender→target queued runs (M5 repeat notice); oldest entries are dropped. */
const AGENT_MESSAGE_QUEUED_RUN_TRACKING_LIMIT = 500;
const WORKER_SNAPSHOT_TERMINAL_DRAIN_TIMEOUT_MS = 1_000;
/** One line per window: a supervisor that is down is asked by every roster pass. */
const AGENT_DIRECTORY_FAILURE_LOG_MIN_GAP_MS = 60_000;
/** Minimum gap between two "held resident by live kernel work" lines for the same session. */
const KERNEL_RESIDENCY_LOG_GAP_MS = 6 * 60 * 60 * 1000;
/**
 * Minimum gap between two "orphan exit deferred" lines. The availability wheel
 * rechecks at most once a minute (backoff caps at 60s), so one line per minute
 * attributes the hold without spamming the log for a long-busy worker.
 */
const ORPHAN_EXIT_DEFERRED_LOG_GAP_MS = 60_000;
const UPDATE_RESTART_PREPARE_TIMEOUT_MS = 90_000;
const MAX_SESSION_SNAPSHOT_STABILIZATION_RETRIES = 3;
// Orphaned-worker garbage collection (upstream #2246): a session worker whose
// supervisor stays unreachable — no supervisor claim, no successful replacement
// launch — exits after this window instead of retrying the resurrection loop
// forever. Sessions persist on disk, and a later supervisor spawns fresh workers
// on demand, so an unreachable-supervisor worker serves nothing by lingering.
const WORKER_SUPERVISOR_LOST_EXIT_MS_ENV = "PRIME_AGENT_INTERNAL_WORKER_SUPERVISOR_LOST_EXIT_MS";
const DEFAULT_WORKER_SUPERVISOR_LOST_EXIT_MS = 5 * 60_000;

function workerSupervisorLostExitMs(): number {
	const raw = Number(process.env[WORKER_SUPERVISOR_LOST_EXIT_MS_ENV]);
	return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_WORKER_SUPERVISOR_LOST_EXIT_MS;
}

/**
 * Transcript summaries and per-child display metadata are independent reads, so a
 * subtree walk overlaps them instead of paying one round trip per child. Kept
 * well under the file-descriptor limits a worker shares with its kernel.
 */
const PASSIVE_SUBTREE_SCAN_CONCURRENCY = 8;

const DAEMON_COMMAND_TYPES: ReadonlySet<string> = new Set([
	"ack_result",
	"declare_client_capabilities",
	"list",
	"list_saved_sessions",
	"create",
	"attach",
	"detach",
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
	"set_service_tier",
	"cycle_thinking_level",
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

const DAEMON_CLIENT_CAPABILITY_SET: ReadonlySet<string> = new Set(DAEMON_SUPPORTED_CLIENT_CAPABILITIES);
const CLIENT_CATCHUP_RETRY_MS = 250;
const UPDATE_RESTART_ABORT_BASH_TIMEOUT_MS = 5000;
const SUPERVISOR_FENCE_POLL_MS = 250;
const UPDATE_RESTART_MARKER =
	"<prime_agent_update_interrupted>\n" +
	"Prime Agent was updated and intentionally interrupted this session. Continue from the saved transcript and restored tool/kernel state. Any running model, tool, bash, or child-agent work may have been partially completed.\n" +
	"</prime_agent_update_interrupted>";
const RECOVERY_CHECKPOINT_EVENTS: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"bash_start",
	"bash_end",
	"session_action_update",
	"rlm_child_update",
]);

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

type RuntimeOpenGuard = () => boolean | Promise<boolean>;
type SupervisorGenerationClaim = Omit<Extract<DaemonWorkerCommand, { type: "worker_auth" }>, "id" | "type" | "token">;

interface BoundSupervisorGenerationClaim {
	claim: SupervisorGenerationClaim;
	ownerFingerprint: string;
}

const PEER_GRANT_TTL_LIMIT_MS = 30_000;
// Only the supervisor registers grants, so the cap is a tripwire, never an eviction policy.
const PEER_GRANT_LIMIT = 1024;

const RLM_SUBAGENT_REGISTRY_FILE = "rlm-subagents.jsonl";

/**
 * One passive child as the daemon presents it: topology (sessionFile, parent,
 * depth, name) from the spawn ledger; hydration metadata (prompt, spawnCode,
 * model, rlmMaxDepth, status, createdAt) from the per-child display file, or
 * the legacy registry for pre-ledger children without one.
 */
interface PassiveRlmSubagentEntry {
	childId: string;
	sessionName: string;
	sessionDir: string;
	sessionFile: string;
	parentSessionId: string;
	parentSessionFile?: string;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	rlmParentNodeId?: string;
	prompt?: string;
	spawnCode?: string;
	model?: { provider: string; modelId: string };
	/**
	 * The read-side status: `stale` demotes a `running` display file whose transcript has
	 * been silent past {@link RLM_SUBAGENT_STALE_AFTER_MS} (the file itself is only written
	 * at spawn/completion/deletion, so a child that never reached its completion write would
	 * otherwise claim `running` forever - r38 L5).
	 */
	status: "running" | "completed" | "deleted" | "stale";
	createdAt: number;
}

/** Spread-ready optional metadata fields shared by display files and legacy registry entries. */
function rlmSubagentMetadataFields(source: {
	rlmMaxDepth?: number;
	rlmParentNodeId?: string;
	prompt?: string;
	spawnCode?: string;
	model?: { provider: string; modelId: string };
}): Pick<PassiveRlmSubagentEntry, "rlmMaxDepth" | "rlmParentNodeId" | "prompt" | "spawnCode" | "model"> {
	return {
		...(source.rlmMaxDepth !== undefined ? { rlmMaxDepth: source.rlmMaxDepth } : {}),
		...(source.rlmParentNodeId ? { rlmParentNodeId: source.rlmParentNodeId } : {}),
		...(source.prompt ? { prompt: source.prompt } : {}),
		...(source.spawnCode ? { spawnCode: source.spawnCode } : {}),
		...(source.model ? { model: source.model } : {}),
	};
}

type PassiveRlmRoot =
	| { rootParentState: ActiveSessionState; rootInfo?: never }
	| { rootParentState?: never; rootInfo: SessionInfo };

type PassiveRlmSubagent = PassiveRlmRoot & {
	entry: PassiveRlmSubagentEntry;
	info: SessionInfo;
	chain: PassiveRlmSubagentEntry[];
};

class RuntimeOpenCancelledError extends Error {}
class BoundSessionUnavailableError extends Error {}

export async function runDaemonMode(options: DaemonModeOptions): Promise<never> {
	const socketPath = normalizeSocketPath(options.socketPath ?? defaultDaemonSocketPath());
	const daemon = new AgentDaemon(socketPath, options);
	await daemon.start();
	return new Promise(() => {});
}

export class AgentDaemon {
	private server?: Server;
	private shuttingDown = false;
	private readonly updateRestartQueuePauses = new Map<string, { release(): void }>();
	private readonly sessionInputPauses = new Map<
		string,
		{ activeSessionId: string; owner: DaemonSocketClient; leaseKey: string; pause: { release(): void } }
	>();
	private readonly acpMcpOwners = new Map<
		string,
		{ client: DaemonSocketClient; ownerId: string; serverNames: string[]; release?: Promise<void> }
	>();
	private readonly mutationDrain = new MutationDrainLatch();
	private updateRestart?: {
		id: symbol;
		owner?: DaemonSocketClient;
		abort: AbortController;
		deadline?: ReturnType<typeof setTimeout>;
		phase: "preparing" | "fencing" | "prepared" | "publishing";
		manifest?: DaemonUpdateRestartManifest;
		memoryCheckpointFiles: Set<string>;
		deferredClientEnv: Array<{
			client: DaemonSocketClient;
			state: ActiveSessionState;
			env: Record<string, string>;
		}>;
	};
	private ownsSocketPath = false;
	private socketIdentity?: DaemonSocketIdentity;
	private readonly clients = new Set<DaemonSocketClient>();
	private readonly sessions = new Map<string, ActiveSessionState>();
	private readonly transcriptSerializationCaches = new Map<string, TranscriptMessageSerializationCache>();
	private readonly openingSessions = new Map<string, Promise<ActiveSessionState>>();
	/** Covers path resolution through publication in openingSessions, before the runtime promise exists. */
	private readonly reservingSessionOpens = new Map<string, Promise<void>>();
	private readonly bindingCompletions = new Map<string, Promise<void>>();
	/**
	 * Resolved-session-file keyed passivations let wake paths join after closeSessionOnce
	 * removes the live session. This intentionally complements closingSessions: that map
	 * coalesces every close by transient activeSessionId, while this one identifies the
	 * passivation-only close reason by the durable identity needed by hydration/opening.
	 */
	private readonly passivatingSessions = new Map<string, Promise<void>>();
	private readonly closingSessions = new Map<
		string,
		{
			promise: Promise<void>;
			reason: DaemonSessionClosedReason;
			descendants: Set<ActiveSessionState>;
			reasonUpgrade?: Promise<void>;
		}
	>();
	private readonly sideQuestionRuns = new Map<
		string,
		{
			run: SideQuestionRun;
			client: DaemonSocketClient;
			activeSessionId: string;
		}
	>();
	/** Live prompt admissions, keyed by session and caller-generated admission id. */
	private readonly promptAdmissions = new Map<
		string,
		{
			activeSessionId: string;
			admissionId: string;
			controller?: AbortController;
			status: "waiting" | "owned" | "cancelled";
		}
	>();
	private readonly signalCleanupHandlers: Array<() => void> = [];
	private readonly cronStore: AgentCronJobStore;
	private readonly agentDir: string;
	private readonly cronScheduler: AgentCronScheduler;
	private readonly agentMessageRateLimiter = new AgentSessionMessageRateLimiter();
	// Sessions inserted into `sessions` but still awaiting extension binding;
	// visible to host controllers during bind, excluded from targeting.
	private readonly bindingSessions = new Set<string>();
	/** Throttle for "the supervisor's peer directory could not be read" (see fetchSupervisorAgentPeers). */
	private agentDirectoryFailureLoggedAt = 0;
	private readonly pendingSessionNames = new Set<string>();
	private restoreActiveSessionId: string | undefined;
	private supervisorMonitorTimer?: ReturnType<typeof setTimeout>;
	/**
	 * Settles when the armed supervisor availability check has run to completion
	 * (including the reschedule it performs) or has been cancelled. The check is a
	 * real async chain started from a timer callback, so this is the only way an
	 * observer can tell that the monitor reached a steady state; the supervisor
	 * monitor tests await it instead of polling a timer loop.
	 */
	supervisorAvailabilityCheckSettled?: Promise<void>;
	private settleArmedSupervisorAvailabilityCheck?: () => void;
	private supervisorFenceTimer?: ReturnType<typeof setTimeout>;
	private supervisorLaunchInProgress = false;
	/** Rounds the supervisor probe failed in a row; drives the recheck backoff (P1-7b). */
	private readonly supervisorAvailabilityState: SupervisorAvailabilityState = { consecutiveFailures: 0 };
	private readonly supervisorClaims = new Map<DaemonSocketClient, BoundSupervisorGenerationClaim>();
	private readonly peerGrants = new Map<string, DaemonWorkerPeerGrant>();
	private readonly peerClaims = new Map<DaemonSocketClient, DaemonWorkerPeerGrant>();
	private peerAdmissionsFenced = false;
	private agentMessagesPaused = false;
	private readonly summarizer = new DaemonSessionSummarizer(
		() => [...this.sessions.values()],
		(state) => {
			// Subagents share their recap with the parent so it shows in the parent's
			// subagent tree; their own session channel usually has no attached client.
			if (state.runtime.metadata.kind === "subagent") {
				state.runtime.session.setCurrentRecap(state.summaryState?.summary);
			}
			this.broadcastToSession(state, {
				type: "session_status",
				activeSessionId: state.activeSessionId,
				recap: state.summaryState?.summary,
			});
		},
	);
	private readonly recoveryJournal?: WorkerRecoveryJournal;
	private readonly rosterReporter: WorkerRosterReporterState = {
		lastComposed: new Map(),
		lastComposedJson: new Map(),
		queuedChildren: new Map(),
		removedAgentIds: new Map(),
		snapshotPending: false,
		allDirty: true,
		dirtyActiveSessionIds: new Set(),
	};
	private rosterFlushScheduled = false;
	private rosterHeartbeatTimer?: ReturnType<typeof setInterval>;
	private rlmSpawnLedgerInstance?: RlmSpawnLedger;
	/** In-flight admission spawn appends, awaited (and consumed) by createRlmSubagentRuntime. */
	private readonly pendingRlmSpawnAppends = new Map<string, Promise<void>>();

	constructor(
		private readonly socketPath: string,
		private readonly options: DaemonModeOptions,
	) {
		if (!options.defaultSessionConfig.agentDir) {
			throw new Error("Daemon config is missing agentDir");
		}
		this.agentDir = options.defaultSessionConfig.agentDir;
		// Hosted extensions get ctx.ui.theme; init it headlessly (no TTY, watcher off) or their first access kills the worker.
		initTheme(
			SettingsManager.create(options.defaultSessionConfig.cwd ?? process.cwd(), this.agentDir).getTheme(),
			false,
		);
		this.cronStore = options.worker
			? AgentCronJobStore.forSessionArtifacts()
			: new AgentCronJobStore(getCronJobsPath(this.agentDir));
		this.restoreActiveSessionId = options.worker?.restoreActiveSessionId;
		const recoveryJournalPath = process.env[DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
		if (options.worker && recoveryJournalPath) {
			this.recoveryJournal = new WorkerRecoveryJournal(recoveryJournalPath);
		}
		this.cronScheduler = new AgentCronScheduler(this.cronStore, {
			runJob: (job) => this.runCronJob(job),
			beginDispatch: () => {
				this.mutationDrain.begin();
				return () => this.mutationDrain.end();
			},
			onError: (job, error) => {
				this.log(`Cron job ${job.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			},
		});
		this.cronStore.onHeartbeatChange(() => {
			this.broadcastGlobal({ type: "heartbeats_changed" });
			this.scheduleRosterFlush();
		});
	}

	// The daemon runs detached with no terminal, so route its diagnostics to its
	// rotating log file and the shared structured log (and stderr too, for when
	// it's run in the foreground).
	private log(message: string): void {
		console.error(message);
		structuredLog.warn(message, { socketPath: this.socketPath });
		appendRotatingLog(getDaemonLogPath(this.socketPath), `[${new Date().toISOString()}] ${message}`);
	}

	// A crash thrown outside a command handler would otherwise vanish with the
	// detached stdio; capture its stack before the process goes down.
	private installCrashHandlers(): void {
		process.on("uncaughtException", (error) => {
			this.log(`uncaught exception: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
			process.exit(1);
		});
		process.on("unhandledRejection", (reason) => {
			this.log(
				`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
			);
			process.exit(1);
		});
	}

	async start(): Promise<void> {
		if (this.options.worker) {
			process.stderr.on("error", () => {
				// A detached worker must survive the supervisor closing its diagnostic pipe.
			});
		}
		this.installCrashHandlers();
		await prepareDaemonSocketPath(this.socketPath);

		this.server = createServer((socket) => this.handleConnection(socket));

		try {
			await new Promise<void>((resolveListen, rejectListen) => {
				const onError = (error: Error) => {
					this.server?.off("listening", onListening);
					rejectListen(error);
				};
				const onListening = () => {
					this.server?.off("error", onError);
					try {
						this.socketIdentity = getDaemonSocketIdentity(this.socketPath);
						this.ownsSocketPath = true;
						restrictDaemonSocketPath(this.socketPath);
					} catch (error) {
						this.server?.close();
						rejectListen(error);
						return;
					}
					resolveListen();
				};
				this.server?.once("error", onError);
				this.server?.once("listening", onListening);
				this.server?.listen(daemonIpcListenOptions(this.socketPath));
			});
		} catch (error) {
			this.cleanupSocketPath();
			throw error;
		}

		this.registerSignalHandlers();
		this.summarizer.start();
		this.log(`Prime Agent daemon listening on ${this.socketPath}`);
		// No startup restore: on-disk sessions return only via --resume or the agents view.
		if (!this.shuttingDown) {
			this.cronScheduler.start();
		}
		if (this.options.worker) {
			this.rosterHeartbeatTimer = setInterval(
				() => this.broadcastRosterFrame({ type: "roster_heartbeat" }),
				ROSTER_HEARTBEAT_INTERVAL_MS,
			);
			this.rosterHeartbeatTimer.unref();
		}
		this.startSupervisorMonitor();
	}

	private supervisorSocketPathFromEnv(): string | undefined {
		const raw = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		return raw ? normalizeSocketPath(raw) : undefined;
	}

	/** Persistent supervisor connection for cross-worker requests; one link per daemon process. */
	private supervisorLinkInstance?: SupervisorLink;
	private supervisorLink(): SupervisorLink | undefined {
		const supervisorSocketPath = this.supervisorSocketPathFromEnv();
		if (!supervisorSocketPath) return undefined;
		this.supervisorLinkInstance ??= new SupervisorLink({ socketPath: supervisorSocketPath });
		return this.supervisorLinkInstance;
	}

	private startSupervisorMonitor(): void {
		const supervisorSocketPath = this.supervisorSocketPathFromEnv();
		if (!this.options.worker || !supervisorSocketPath) {
			return;
		}
		this.scheduleSupervisorAvailabilityCheck(supervisorSocketPath, 1500);
	}

	private scheduleSupervisorAvailabilityCheck(supervisorSocketPath: string, delayMs: number): void {
		if (this.shuttingDown || this.hasAuthenticatedSupervisorConnection()) {
			return;
		}
		this.cancelArmedSupervisorAvailabilityCheck();
		let settle: () => void = () => undefined;
		this.supervisorAvailabilityCheckSettled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		this.settleArmedSupervisorAvailabilityCheck = settle;
		this.supervisorMonitorTimer = setTimeout(() => {
			this.supervisorMonitorTimer = undefined;
			// The check owns its settle from here on, so a reschedule started
			// inside it installs a fresh one instead of resolving this one early.
			this.settleArmedSupervisorAvailabilityCheck = undefined;
			void this.checkSupervisorAvailability(supervisorSocketPath)
				.catch(() => {
					if (!this.shuttingDown && !this.hasAuthenticatedSupervisorConnection()) {
						this.scheduleSupervisorAvailabilityCheck(supervisorSocketPath, 5000);
					}
				})
				.finally(settle);
		}, delayMs);
	}

	/** Disarms a pending check and settles it, since it will never run. */
	private cancelArmedSupervisorAvailabilityCheck(): void {
		if (this.supervisorMonitorTimer) {
			clearTimeout(this.supervisorMonitorTimer);
			this.supervisorMonitorTimer = undefined;
		}
		const settle = this.settleArmedSupervisorAvailabilityCheck;
		this.settleArmedSupervisorAvailabilityCheck = undefined;
		settle?.();
	}

	/**
	 * One monitoring round (P1-7b, 250ms tier). Death takes a whole failed probe
	 * round, not one 250ms connect, and the next round is scheduled on a backoff
	 * that grows with the number of rounds that failed in a row.
	 */
	private async checkSupervisorAvailability(supervisorSocketPath: string): Promise<void> {
		const outcome = await runSupervisorAvailabilityCheck(supervisorSocketPath, this.supervisorAvailabilityState, {
			probe: (socketPath) =>
				probeSupervisorAvailability(socketPath, {
					// Through the method, not the raw socket helper: the monitor's
					// probe seam stays the one tests and subclasses can observe.
					connect: (path) => this.canConnectToSupervisor(path),
					isCancelled: () => this.shuttingDown || this.hasAuthenticatedSupervisorConnection(),
					onFailedAttempt: (attempt, attempts) =>
						this.log(`supervisor probe failed (attempt ${attempt}/${attempts}) on ${socketPath}`),
				}),
			launchReplacement: (socketPath) => this.launchReplacementSupervisor(socketPath),
			isConnected: () => this.hasAuthenticatedSupervisorConnection(),
			isShuttingDown: () => this.shuttingDown,
			isShutdownAdmissionActive: () => isDaemonShutdownAdmissionActive(),
			// Upstream #2246: a replacement that answers right after the launch
			// restarts the orphan window, and the window deadline drives the exit.
			connectAfterLaunch: (socketPath) => this.canConnectToSupervisor(socketPath),
			isOrphanedLongEnough: () => {
				const absentSince = this.supervisorAvailabilityState.supervisorAbsentSince;
				return absentSince !== undefined && Date.now() - absentSince >= workerSupervisorLostExitMs();
			},
			onOrphaned: () => this.exitOrphanedSupervisorWorker(supervisorSocketPath),
		});
		if (outcome.nextDelayMs !== undefined) {
			this.scheduleSupervisorAvailabilityCheck(supervisorSocketPath, outcome.nextDelayMs);
		}
	}

	/**
	 * Upstream #2246: garbage-collect an orphaned worker. The supervisor has been
	 * unreachable for the whole bounded window — no supervisor claim, no successful
	 * replacement launch — so retrying the resurrection loop forever only
	 * accumulates garbage. Sessions persist on disk, so the next supervisor to
	 * claim the socket spawns fresh workers on demand.
	 */
	private async exitOrphanedSupervisorWorker(supervisorSocketPath: string): Promise<void> {
		// A shutdown already in flight owns the exit: re-entering through the orphan
		// path would hit shutdown()'s re-entry branch (an immediate process.exit) and
		// cut the graceful close short, skipping closeSession and the orphan-journal
		// flush (B2-C06). The availability wheel re-checks shuttingDown per round, so
		// deferring here cannot resurrect the loop.
		if (this.shuttingDown) return;
		const absentSince = this.supervisorAvailabilityState.supervisorAbsentSince;
		if (absentSince === undefined) {
			// The window restarted (a replacement answered): not an orphan anymore.
			return;
		}
		if (this.hasAuthenticatedSupervisorConnection()) {
			// A claim landed between the window check and the exit: recovery won.
			this.supervisorAvailabilityState.supervisorAbsentSince = undefined;
			return;
		}
		if (this.hasOngoingSessionWork()) {
			// An active run owns the worker a little longer; its turn end lets the
			// next availability check reconsider while the window keeps running.
			this.logOrphanExitDeferred(absentSince);
			return;
		}
		this.log(
			`supervisor ${supervisorSocketPath} unreachable for ${Math.round((Date.now() - absentSince) / 1000)}s; exiting orphaned worker`,
		);
		await this.shutdown(0);
	}

	/**
	 * Attribution for the orphan-exit gate saying no (B2-C07): a worker kept alive
	 * by busy sessions used to be log-silent, indistinguishable from a stuck
	 * resurrection loop. One throttled line names the reason and the window age.
	 */
	private logOrphanExitDeferred(absentSince: number): void {
		const now = Date.now();
		if (
			this.orphanExitDeferredLogAt !== undefined &&
			now - this.orphanExitDeferredLogAt < ORPHAN_EXIT_DEFERRED_LOG_GAP_MS
		) {
			return;
		}
		this.orphanExitDeferredLogAt = now;
		let activeSessions = 0;
		let sessionsWithRunningChildren = 0;
		for (const state of this.sessions.values()) {
			const summary = summaryForActiveSession(state);
			if (summary.isSessionActive) activeSessions++;
			if (summary.hasRunningRlmChildren === true) sessionsWithRunningChildren++;
		}
		this.log(
			`orphan exit deferred: ${activeSessions} active session(s), ${sessionsWithRunningChildren} session(s) with running children; supervisor unreachable for ${Math.round((now - absentSince) / 1000)}s`,
		);
	}

	/**
	 * The orphan-exit gate: the same predicate the daemon reports as session
	 * activity — our fold is the session summary's isSessionActive (which folds
	 * live kernel bash work, LIVE-1/r44) or running RLM children. Retrying,
	 * refinement, compaction settlement and consumed queued actions all count
	 * through session.isSessionActive.
	 */
	private hasOngoingSessionWork(): boolean {
		for (const state of this.sessions.values()) {
			const summary = summaryForActiveSession(state);
			if (summary.isSessionActive || summary.hasRunningRlmChildren === true) {
				return true;
			}
		}
		return false;
	}

	private hasAuthenticatedSupervisorConnection(): boolean {
		return this.supervisorClaims.size > 0;
	}

	private revokeSupervisorClaim(client: DaemonSocketClient, expected?: BoundSupervisorGenerationClaim): boolean {
		if (expected && this.supervisorClaims.get(client) !== expected) return false;
		if (!this.supervisorClaims.delete(client)) return false;
		if (this.options.worker && this.updateRestart?.owner === client) {
			this.cancelPreparedUpdateRestart(this.updateRestart.id);
		}
		return true;
	}

	/** Burn every outstanding grant and end direct peers; admissions stay fenced until an update cancel. */
	private fencePeerTransports(closingReason?: DaemonClosingReason): void {
		this.peerAdmissionsFenced = true;
		this.peerGrants.clear();
		for (const client of [...this.peerClaims.keys()]) {
			this.peerClaims.delete(client);
			// The reason reaches the client before FIN so its close maps to shutdown/update, not a transport loss.
			if (closingReason) this.write(client, { type: "daemon_closing", reason: closingReason });
			client.socket.end();
		}
	}

	private clearSupervisorAvailabilityCheck(): void {
		this.cancelArmedSupervisorAvailabilityCheck();
		if (this.supervisorFenceTimer) {
			clearTimeout(this.supervisorFenceTimer);
			this.supervisorFenceTimer = undefined;
		}
	}

	private scheduleSupervisorFenceCheck(): void {
		if (this.shuttingDown || this.supervisorFenceTimer || this.supervisorClaims.size === 0) {
			return;
		}
		this.supervisorFenceTimer = setTimeout(() => {
			this.supervisorFenceTimer = undefined;
			void this.checkSupervisorFences();
		}, SUPERVISOR_FENCE_POLL_MS);
	}

	private async checkSupervisorFences(): Promise<void> {
		for (const [client, boundClaim] of this.supervisorClaims) {
			try {
				boundClaim.ownerFingerprint = await this.assertSupervisorClaimCurrent(
					boundClaim.claim,
					boundClaim.ownerFingerprint,
				);
			} catch {
				if (this.revokeSupervisorClaim(client, boundClaim)) client.socket.end();
			}
		}
		this.scheduleSupervisorFenceCheck();
	}

	private assertSupervisorClaimCurrent(
		claim: SupervisorGenerationClaim,
		validatedFingerprint?: string,
	): Promise<string> {
		return assertDaemonSupervisorOwnerCurrent(
			{
				generation: claim.supervisorGeneration,
				pid: claim.supervisorPid,
				...(claim.supervisorProcessStartId ? { processStartId: claim.supervisorProcessStartId } : {}),
				socketPath: claim.supervisorSocketPath,
			},
			validatedFingerprint,
		);
	}

	private canConnectToSupervisor(socketPath: string): Promise<boolean> {
		return connectProbeSupervisor(socketPath, SUPERVISOR_PROBE_TIMEOUT_MS);
	}

	private async launchReplacementSupervisor(supervisorSocketPath: string): Promise<void> {
		if (this.supervisorLaunchInProgress || this.shuttingDown) {
			return;
		}
		this.supervisorLaunchInProgress = true;
		const key = createHash("sha256").update(supervisorSocketPath).digest("hex").slice(0, 12);
		const lockDirectory = join(dirname(supervisorSocketPath), `.supervisor-launch-${key}.lock`);
		let ownsLock = false;
		try {
			for (let attempt = 0; attempt < 3 && !ownsLock; attempt++) {
				const token = randomUUID();
				const candidateDirectory = `${lockDirectory}.candidate-${process.pid}-${token}`;
				mkdirSync(candidateDirectory, { mode: 0o700 });
				writeFileSync(join(candidateDirectory, "pid"), `${process.pid}\n`, {
					mode: 0o600,
				});
				try {
					renameSync(candidateDirectory, lockDirectory);
					ownsLock = true;
					break;
				} catch (error) {
					rmSync(candidateDirectory, { recursive: true, force: true });
					const code = (error as NodeJS.ErrnoException).code;
					if (code !== "EEXIST" && code !== "ENOTEMPTY") {
						throw error;
					}
					let ownerPid: number | undefined;
					try {
						ownerPid = Number(readFileSync(join(lockDirectory, "pid"), "utf8").trim());
					} catch {
						// An invalid owner is reclaimed atomically below.
					}
					if (ownerPid && this.isProcessAlive(ownerPid)) {
						// Somebody else is already launching the replacement. Not an error:
						// this round stands down and the monitor rechecks on its backoff.
						this.log(`supervisor launch lock held by pid ${ownerPid}; backing off`);
						return;
					}
					const staleDirectory = `${lockDirectory}.stale-${process.pid}-${token}`;
					try {
						renameSync(lockDirectory, staleDirectory);
						rmSync(staleDirectory, { recursive: true, force: true });
					} catch (reclaimError) {
						if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") {
							throw reclaimError;
						}
					}
				}
			}
			if (!ownsLock) {
				this.log("supervisor launch lock still contended after 3 attempts; backing off");
				return;
			}
			if (await this.canConnectToSupervisor(supervisorSocketPath)) {
				return;
			}
			if (await isDaemonShutdownAdmissionActive()) {
				return;
			}
			const launch = createCliSubprocessLaunchSpec(["--mode", "daemon", "--daemon-socket", supervisorSocketPath]);
			const environment = createCliSubprocessEnv();
			delete environment[DAEMON_WORKER_ROLE_ENV];
			delete environment[DAEMON_WORKER_TOKEN_ENV];
			delete environment[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
			delete environment[DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
			delete environment[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			delete environment[ORPHAN_PROCESS_JOURNAL_ENV];
			delete environment[SESSION_LEASES_ENABLED_ENV];
			delete environment[SESSION_LEASE_OWNER_ID_ENV];
			const child = spawn(launch.command, launch.args, {
				cwd: this.options.defaultSessionConfig.cwd ?? process.cwd(),
				detached: true,
				env: environment,
				stdio: "ignore",
			});
			child.unref();
			const deadline = Date.now() + 10_000;
			while (!this.shuttingDown && Date.now() < deadline) {
				if (await this.canConnectToSupervisor(supervisorSocketPath)) {
					this.log(`launched replacement supervisor on ${supervisorSocketPath}`);
					return;
				}
				await delay(50);
			}
		} catch (error) {
			this.log(`failed to launch replacement supervisor: ${String(error)}`);
		} finally {
			if (ownsLock) {
				rmSync(lockDirectory, { recursive: true, force: true });
			}
			this.supervisorLaunchInProgress = false;
		}
	}

	private isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	private cleanupSocketPath(): void {
		if (!this.ownsSocketPath) {
			return;
		}
		this.ownsSocketPath = false;
		const socketIdentity = this.socketIdentity;
		this.socketIdentity = undefined;
		cleanupDaemonSocketPath(this.socketPath, socketIdentity);
	}

	/**
	 * Adopt env for a session that has none, propagating to subagents spawned
	 * before adoption (their exec-env providers read state.clientEnv live).
	 * Never overwrites an existing identity.
	 */
	private adoptClientEnv(state: ActiveSessionState, env?: Record<string, string>): void {
		if (!env || state.clientEnv) {
			return;
		}
		state.clientEnv = env;
		for (const child of this.sessions.values()) {
			const metadata = child.runtime.metadata;
			if (metadata.kind === "subagent" && metadata.parentActiveSessionId === state.activeSessionId) {
				this.adoptClientEnv(child, env);
			}
		}
	}

	/** Root sessions dir that keys this daemon's spawn ledger. */
	private rlmLedgerSessionsDir(): string {
		return this.options.defaultSessionConfig.sessionDir ?? getSessionsDir(this.agentDir);
	}

	/**
	 * Supervisor-owned spawn ledger for this daemon's sessions dir. Seeded
	 * lazily from the existing per-parent registries via the same tolerant
	 * reader the daemon already uses for passive hydration.
	 */
	private rlmSpawnLedger(): RlmSpawnLedger {
		this.rlmSpawnLedgerInstance ??= new RlmSpawnLedger(
			this.agentDir,
			this.rlmLedgerSessionsDir(),
			createRlmLedgerRegistrySeedSource(),
			(message) => this.log(message),
			this.rlmLedgerBoundsOptions(),
		);
		return this.rlmSpawnLedgerInstance;
	}

	/**
	 * Bounds ladder switch for the ledger writer (`retention.
	 * ledgerCompactionEnabled`). A settings read failure must not disable the
	 * rung that keeps spawning and deletion alive, so it defaults to on.
	 */
	private rlmLedgerBoundsOptions(): RlmLedgerBoundsOptions {
		try {
			const settings = SettingsManager.create(
				this.options.defaultSessionConfig.cwd ?? process.cwd(),
				this.agentDir,
			).getRetentionSettings();
			return { compactionEnabled: settings.ledgerCompactionEnabled };
		} catch {
			return { compactionEnabled: true };
		}
	}

	// Ledgers are per sessions-dir family: a catalog request for another dir must read that dir's ledger.
	private rlmSpawnLedgerFor(sessionDir: string | undefined): RlmSpawnLedger {
		if (sessionDir === undefined || resolve(sessionDir) === resolve(this.rlmLedgerSessionsDir())) {
			return this.rlmSpawnLedger();
		}
		return new RlmSpawnLedger(
			this.agentDir,
			sessionDir,
			createRlmLedgerRegistrySeedSource(),
			(message) => this.log(message),
			this.rlmLedgerBoundsOptions(),
		);
	}

	private async appendRlmLedgerRenameForState(state: ActiveSessionState, name: string): Promise<void> {
		const childId = state.runtime.metadata.rlmChildId;
		const child = state.runtime.session.sessionFile;
		if (!childId || !child) return;
		// Awaited: the supervisor answers sibling-name checks from the ledger,
		// so the rename must be durable before the reservation is released.
		await this.rlmSpawnLedger()
			.appendRename({ childId, child, name })
			.catch((error) => {
				this.log(`failed to append RLM ledger rename: ${error instanceof Error ? error.message : String(error)}`);
			});
	}

	/**
	 * Legacy per-parent registry path. Read-only: consumed solely as fallback
	 * hydration metadata for pre-ledger children without a display file (the
	 * ledger seed source has its own equivalent reader).
	 */
	private legacyRlmSubagentRegistryPath(parentSessionFile: string, parentSessionId: string): string {
		return join(getSessionArtifactPathForFile(parentSessionFile, parentSessionId), RLM_SUBAGENT_REGISTRY_FILE);
	}

	private readLegacyRlmSubagentRegistry(
		path: string,
		throwOnReadError = false,
	): Promise<LegacyRlmSubagentRegistryEntry[]> {
		return readLegacyRlmSubagentRegistryFile(path, {
			throwOnReadError,
			log: (message) => this.log(message),
		});
	}

	/**
	 * Record a spawned or completed child: topology (the spawn edge) goes to
	 * the daemon-owned ledger at admission; hydration/display metadata goes to
	 * the child's per-child display file at both moments.
	 */
	private recordRlmSubagentState(
		parentState: ActiveSessionState,
		input: {
			childId: string;
			sessionName: string;
			sessionDir: string;
			sessionFile: string;
			rlmDepth: number;
			rlmMaxDepth: number;
			rlmParentNodeId?: string;
			prompt?: string;
			spawnCode?: string;
			model?: { provider: string; modelId: string };
			status: "running" | "completed";
			createdAt?: number;
		},
	): boolean {
		const parentSession = parentState.runtime.session;
		// Spawn admission is the moment the daemon knows the edge firsthand.
		// The ledger is the only topology store, so the append's outcome is
		// load-bearing: the promise is stashed per childId for the admission
		// path to await — admission fails if the spawn record cannot be made
		// durable (a swallowed failure would admit a child that listing,
		// hydration, and a2a wake can never find after passivation).
		if (input.status === "running" && parentSession.sessionFile) {
			const spawnAppend = this.rlmSpawnLedger().appendSpawn({
				childId: input.childId,
				parent: parentSession.sessionFile,
				child: input.sessionFile,
				depth: input.rlmDepth,
				name: input.sessionName,
			});
			// Mark handled so an early rejection cannot surface as an
			// unhandled-rejection crash before the admission path awaits it.
			spawnAppend.catch(() => undefined);
			// Child ids are only unique per parent; the parent scopes the pending-append key.
			this.pendingRlmSpawnAppends.set(`${parentState.activeSessionId}#${input.childId}`, spawnAppend);
		}
		try {
			writeRlmSubagentDisplayEntry({
				type: "rlm_subagent",
				childId: input.childId,
				sessionName: input.sessionName,
				sessionDir: input.sessionDir,
				sessionFile: input.sessionFile,
				...rlmSubagentMetadataFields(input),
				status: input.status,
				createdAt: input.createdAt ?? Date.now(),
				updatedAt: new Date().toISOString(),
			});
			return true;
		} catch (error) {
			this.log(
				`failed to persist RLM subagent display entry: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private async recordRlmSubagentDeletion(
		parentState: ActiveSessionState,
		childId: string,
		reason: RlmLedgerDeleteReason = "user",
	): Promise<void> {
		const parentFile = parentState.runtime.session.sessionFile;
		if (!parentFile) {
			return;
		}
		const parentPath = canonicalSessionPath(parentFile);
		const edges = (await this.rlmSpawnLedger().edges(true)).filter(
			(candidate) => candidate.childId === childId && canonicalSessionPath(candidate.parent) === parentPath,
		);
		const edge = edges.find((candidate) => !candidate.deleted);
		let entry: PassiveRlmSubagentEntry | undefined;
		if (edge) {
			entry = await this.passiveRlmSubagentEntryForEdge(edge, {
				sessionId: parentState.runtime.session.sessionId,
				sessionFile: parentFile,
			});
		} else if (edges.length > 0) {
			// Only tombstoned edges: the tombstones are already durable, nothing
			// to re-append. A prior deletion may have crashed before its artifact
			// sweep, so retry it here.
			for (const tombstoned of edges) {
				await this.deleteRlmSubagentArtifacts(childId, tombstoned.child);
			}
			return;
		} else {
			// No edge at all. A pre-ledger child the seed missed may still exist
			// in the legacy registry; an unreadable registry means the durable
			// deletion boundary cannot be established, so the deletion fails.
			const legacy = (
				await this.readLegacyRlmSubagentRegistry(
					this.legacyRlmSubagentRegistryPath(parentFile, parentState.runtime.session.sessionId),
					true,
				)
			).find((candidate) => candidate.childId === childId);
			if (!legacy || legacy.status === "deleted") {
				// The child never existed under this parent, or its tombstone is
				// already durable.
				return;
			}
			entry = {
				childId: legacy.childId,
				sessionName: legacy.sessionName,
				sessionDir: legacy.sessionDir,
				sessionFile: legacy.sessionFile,
				parentSessionId: parentState.runtime.session.sessionId,
				parentSessionFile: parentFile,
				...(legacy.rlmDepth !== undefined ? { rlmDepth: legacy.rlmDepth } : {}),
				...rlmSubagentMetadataFields(legacy),
				status: legacy.status,
				createdAt: legacy.createdAt,
			};
		}
		// Display tombstone first ("deleted deliberately, transcript retained"):
		// a crash in between leaves a live ledger edge over a deleted display
		// entry, healed by retrying the deletion; the reverse order could
		// tombstone the ledger while the display file still claims the child
		// exists.
		try {
			writeRlmSubagentDisplayEntry({
				type: "rlm_subagent",
				childId: entry.childId,
				sessionName: entry.sessionName,
				sessionDir: entry.sessionDir,
				sessionFile: entry.sessionFile,
				...rlmSubagentMetadataFields(entry),
				status: "deleted",
				createdAt: entry.createdAt,
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			throw new Error(
				`Failed to persist deletion for RLM subagent ${childId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// The ledger delete record is the topology tombstone; unlike the
		// dual-write era it has no other writer to fall back on, so a failed
		// append is a failed deletion.
		try {
			await this.rlmSpawnLedger().appendDelete({ childId, child: entry.sessionFile, reason });
		} catch (error) {
			if (error instanceof RlmLedgerOverBoundError) {
				// Last rung of the ADC-2 ladder: tell the operator what to do
				// instead of handing them a stack from inside the ledger writer.
				throw new Error(`Could not delete RLM subagent ${childId}: ${error.message}`);
			}
			throw error;
		}
		if (this.options.worker) {
			this.rosterReporter.removedAgentIds.set(
				this.rosterAgentIdForRlmChild(childId, entry.parentSessionFile),
				basename(entry.sessionFile, ".jsonl"),
			);
			this.scheduleRosterFlush();
		}
		// Deletion boundary: transcript + display tombstone are the durable
		// record and stay; the nested artifact dir is a runtime cache and goes.
		await this.deleteRlmSubagentArtifacts(childId, entry.sessionFile);
	}

	/** Best-effort artifact-dir removal: cache cleanup must never fail a deletion. */
	private async deleteRlmSubagentArtifacts(childId: string, childSessionFile: string): Promise<void> {
		try {
			await deleteSessionArtifacts(childSessionFile);
		} catch (error) {
			this.log(
				`failed to remove artifact dir for deleted RLM subagent ${childId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Hydration/display metadata for one live ledger edge: per-child display
	 * file first, then the legacy registry for pre-ledger children, then
	 * edge-only defaults. Topology (childId, paths, depth, name) always comes
	 * from the ledger edge.
	 */
	private async passiveRlmSubagentEntryForEdge(
		edge: RlmLedgerEdge,
		parent: { sessionId: string; sessionFile: string },
		legacyRegistryCache?: Map<string, Promise<LegacyRlmSubagentRegistryEntry[]>>,
	): Promise<PassiveRlmSubagentEntry> {
		const edgeChild = canonicalSessionPath(edge.child);
		const base = {
			childId: edge.childId,
			sessionName: edge.name,
			sessionDir: dirname(edge.child),
			sessionFile: edge.child,
			parentSessionId: parent.sessionId,
			parentSessionFile: parent.sessionFile,
		};
		// The ledger stores realpath-canonical paths, the rest of the daemon
		// keys maps by resolve(): present the paths the writer recorded (the
		// metadata file is validated to describe this same child) so passive
		// rows keep matching residency, opens, and passivation bookkeeping.
		const metadataFields = (source: {
			sessionDir: string;
			sessionFile: string;
			rlmMaxDepth?: number;
			rlmParentNodeId?: string;
			prompt?: string;
			spawnCode?: string;
			model?: { provider: string; modelId: string };
			status: "running" | "completed" | "deleted";
			createdAt: number;
		}) => ({
			...base,
			...(canonicalSessionPath(source.sessionFile) === edgeChild
				? { sessionDir: source.sessionDir, sessionFile: source.sessionFile }
				: {}),
			...rlmSubagentMetadataFields(source),
			status: source.status,
			createdAt: source.createdAt,
		});
		const display = await readRlmSubagentDisplayEntry(dirname(edge.child));
		if (display && display.childId === edge.childId) {
			// A display-file child was ledger-spawned: the edge depth is real. A `running`
			// entry is reconciled against the transcript's last movement: the file is not
			// rewritten here (the writer owns it), the reader just stops presenting a
			// silent child as live work.
			const displayFields = metadataFields(display);
			if (displayFields.status !== "running") return { ...displayFields, rlmDepth: edge.depth };
			const lastActivityMs = await stat(displayFields.sessionFile)
				.then((stats) => stats.mtimeMs)
				.catch(() => undefined);
			return {
				...displayFields,
				status: effectiveRlmSubagentDisplayStatus(display, lastActivityMs),
				rlmDepth: edge.depth,
			};
		}
		const registryPath = this.legacyRlmSubagentRegistryPath(parent.sessionFile, parent.sessionId);
		let registryRead = legacyRegistryCache?.get(registryPath);
		if (!registryRead) {
			registryRead = this.readLegacyRlmSubagentRegistry(registryPath);
			legacyRegistryCache?.set(registryPath, registryRead);
		}
		const legacy = (await registryRead).find((entry) => entry.childId === edge.childId);
		if (legacy) {
			// A seeded edge's depth may be a parent+1 guess for legacy entries
			// without one: leave it absent so hydration falls back to the
			// persisted header depth, exactly as the registry reader did.
			return { ...metadataFields(legacy), ...(legacy.rlmDepth !== undefined ? { rlmDepth: legacy.rlmDepth } : {}) };
		}
		// Ledger-only child (metadata lost): hydratable with defaults.
		let createdAt = 0;
		try {
			createdAt = (await stat(edge.child)).birthtimeMs || 0;
		} catch {
			// The stat is display-grade; a failed read keeps the epoch default.
		}
		return { ...base, rlmDepth: edge.depth, status: "completed", createdAt };
	}

	/** List each root's passive (non-resident) descendants from the ledger, without creating runtimes. */
	private async listPassiveRlmSubagents(
		savedRoots: SessionInfo[] = [],
		includeResident = false,
	): Promise<PassiveRlmSubagent[]> {
		const residentRoots: Array<{ parentState: ActiveSessionState; sessionFile: string }> = [];
		for (const parentState of this.sessions.values()) {
			const parentFile = parentState.runtime.session.sessionFile;
			// An in-memory session cannot own persisted children.
			if (parentFile) residentRoots.push({ parentState, sessionFile: parentFile });
		}
		const savedRootInfos = savedRoots.filter((rootInfo) => inactiveLifecycleForSession(rootInfo) === "live");
		if (residentRoots.length === 0 && savedRootInfos.length === 0) return [];
		const edges = await this.rlmSpawnLedger().edges();
		const childrenByParent = new Map<string, RlmLedgerEdge[]>();
		for (const edge of edges) {
			const parentPath = canonicalSessionPath(edge.parent);
			const siblings = childrenByParent.get(parentPath) ?? [];
			siblings.push(edge);
			childrenByParent.set(parentPath, siblings);
		}
		const legacyRegistryCache = new Map<string, Promise<LegacyRlmSubagentRegistryEntry[]>>();
		const passive: PassiveRlmSubagent[] = [];
		// One node's children are read in three phases instead of one serial loop:
		// metadata for every edge, then the admission decisions, then the transcript
		// summaries. Phases 1 and 3 are pure I/O and overlap; phase 2 stays serial
		// and in edge order because `visited` accumulates as it goes, so admission
		// (and the row order that follows from it) is decided exactly as the serial
		// walk decided it. The subtree walk below is unchanged, so the emitted list
		// is still depth-first pre-order.
		const visit = async (
			root: PassiveRlmRoot,
			parent: { sessionId: string; sessionFile: string },
			parentChain: PassiveRlmSubagentEntry[],
			visited: Set<string>,
		): Promise<void> => {
			const edges = childrenByParent.get(canonicalSessionPath(parent.sessionFile)) ?? [];
			if (edges.length === 0) return;
			// The ledger stores realpath-canonical paths while the rest of the
			// daemon keys by resolve(): work with the writer-recorded path from
			// the metadata entry so passive rows keep matching residency,
			// opens, and passivation bookkeeping.
			const entries = await mapConcurrent(edges, PASSIVE_SUBTREE_SCAN_CONCURRENCY, (edge) =>
				this.passiveRlmSubagentEntryForEdge(edge, parent, legacyRegistryCache),
			);
			const admitted: PassiveRlmSubagentEntry[] = [];
			for (const entry of entries) {
				const sessionKey = resolve(entry.sessionFile);
				if (entry.status === "deleted" || visited.has(sessionKey)) continue;
				visited.add(sessionKey);
				// A resident child walks its own subtree as an outer root below. Avoid
				// both duplicate rows and attributing its descendants to an ancestor.
				// Skipping ahead of the scan also keeps streaming children out of it:
				// their transcript grows continuously, so readSessionInfo can never
				// serve them from cache and each walk would rescan the whole file only
				// to discard the result here.
				if (!includeResident && this.findSessionBySessionFile(entry.sessionFile)) continue;
				admitted.push(entry);
			}
			if (admitted.length === 0) return;
			const infos = await mapConcurrent(admitted, PASSIVE_SUBTREE_SCAN_CONCURRENCY, (entry) =>
				readSessionInfo(entry.sessionFile),
			);
			for (const [index, info] of infos.entries()) {
				if (!info) continue;
				const entry = admitted[index]!;
				const chain = [...parentChain, entry];
				passive.push({ ...root, entry, info, chain });
				await visit(root, { sessionId: info.id, sessionFile: entry.sessionFile }, chain, visited);
			}
		};
		const residentRootPaths = new Set<string>();
		for (const { parentState, sessionFile } of residentRoots) {
			const parentPath = resolve(sessionFile);
			residentRootPaths.add(parentPath);
			await visit(
				{ rootParentState: parentState },
				{ sessionId: parentState.runtime.session.sessionId, sessionFile },
				[],
				new Set([parentPath]),
			);
		}
		for (const rootInfo of savedRootInfos) {
			const rootPath = resolve(rootInfo.path);
			if (residentRootPaths.has(rootPath)) continue;
			await visit({ rootInfo }, { sessionId: rootInfo.id, sessionFile: rootInfo.path }, [], new Set([rootPath]));
		}
		return passive;
	}

	private async passiveRlmSubagentsByPath(
		savedRoots: SessionInfo[] = [],
		includeResident = false,
	): Promise<Map<string, PassiveRlmSubagent>> {
		return new Map(
			(await this.listPassiveRlmSubagents(savedRoots, includeResident)).map((passive) => [
				resolve(passive.entry.sessionFile),
				passive,
			]),
		);
	}

	/** Add saved-only descendants discovered by the shared passive-registry walk. */
	private async buildRlmChildSnapshotsWithPassiveRlmSubagents(
		rootState: ActiveSessionState,
	): Promise<AgentConnectionRlmChildAgentSnapshot[]> {
		const snapshots = buildRlmChildSnapshots(rootState.activeSessionId, [...this.sessions.values()]);
		const residentParentIds = new Set([
			rootState.activeSessionId,
			...snapshots.flatMap((snapshot) => (snapshot.activeSessionId ? [snapshot.activeSessionId] : [])),
		]);
		const seenChildIds = new Set(snapshots.map((snapshot) => snapshot.id));
		for (const passive of await this.listPassiveRlmSubagents()) {
			if (
				!passive.rootParentState ||
				!residentParentIds.has(passive.rootParentState.activeSessionId) ||
				seenChildIds.has(passive.entry.childId)
			) {
				continue;
			}
			const parentEntry = passive.chain.at(-2);
			const parentId = parentEntry?.childId ?? passive.rootParentState.runtime.metadata.rlmChildId;
			snapshots.push({
				id: passive.entry.childId,
				...(parentId ? { parentId } : {}),
				sessionName: passive.info.name ?? passive.entry.sessionName,
				model: passive.entry.model ? `${passive.entry.model.provider}/${passive.entry.model.modelId}` : undefined,
				label: rlmChildLabel(passive.entry.prompt ?? ""),
				status: passive.entry.status === "completed" ? "done" : "error",
				sessionDir: passive.entry.sessionDir,
			});
			seenChildIds.add(passive.entry.childId);
		}
		return snapshots;
	}

	/**
	 * Serialized transcript messages shared by every snapshot transfer of one
	 * session. Returns undefined while a stream is in flight: the live partial
	 * message mutates in place under the same array identity, so a cached
	 * encoding could go stale; such a transfer re-encodes instead (the
	 * pre-cache behavior).
	 */
	private serializedTranscriptFor(state: ActiveSessionState, messages: readonly AgentMessage[]): string[] | undefined {
		if (state.runtime.session?.isStreaming === true) {
			return undefined;
		}
		let cache = this.transcriptSerializationCaches.get(state.activeSessionId);
		if (!cache) {
			cache = new TranscriptMessageSerializationCache();
			this.transcriptSerializationCaches.set(state.activeSessionId, cache);
		}
		return cache.serialize(messages);
	}

	/**
	 * Name one snapshot transfer.
	 *
	 * The id has to identify the transfer, not the position it was taken at. Two
	 * snapshots can sit on the same event cursor and still hold different bytes,
	 * because live state moves on without advancing the sequence. The supervisor
	 * reads a repeated id whose bytes differ as corruption and tears down a
	 * healthy worker, which leaves it recovering and failing the state reads the
	 * UI needs. The cursor stays in the id so logs remain readable; the counter
	 * is what keeps two transfers apart.
	 */
	private nextSnapshotId(state: ActiveSessionState): string {
		state.snapshotTransferSeq = (state.snapshotTransferSeq ?? 0) + 1;
		return `${state.activeSessionId}-${state.eventGeneration}-${state.lastEventSequence}-${state.snapshotTransferSeq}`;
	}

	private async buildSessionListWithPassiveRlmSubagents(
		activeSessions: ActiveSessionState[],
		savedSessions: SessionInfo[],
		scheduledJobs: AgentCronJob[],
	): Promise<SessionSummary[]> {
		const passiveByPath = await this.passiveRlmSubagentsByPath(savedSessions);
		const savedByPath = new Map(savedSessions.map((session) => [resolve(session.path), session]));
		for (const [path, passive] of passiveByPath) {
			savedByPath.set(path, passive.info);
		}
		return buildSessionList(activeSessions, [...savedByPath.values()], scheduledJobs).map((summary) => {
			const passive = summary.sessionFile ? passiveByPath.get(resolve(summary.sessionFile)) : undefined;
			if (!passive || summary.activeSessionId) return summary;
			const parentEntry = passive.chain.at(-2);
			return {
				...summary,
				runtimeKind: "subagent",
				...(passive.chain.length === 1 && passive.rootParentState
					? { parentActiveSessionId: passive.rootParentState.activeSessionId }
					: {}),
				parentSessionId: passive.entry.parentSessionId,
				parentSessionPath:
					passive.entry.parentSessionFile ??
					parentEntry?.sessionFile ??
					passive.rootParentState?.runtime.session.sessionFile ??
					passive.rootInfo?.path,
				rlmDepth: passive.entry.rlmDepth ?? passive.info.rlmDepth,
				rlmChildId: passive.entry.childId,
				rlmParentNodeId: passive.entry.rlmParentNodeId ?? passive.entry.childId,
				spawnCode: passive.entry.spawnCode,
			};
		});
	}

	private async findPassiveRlmSubagent(
		target: string,
		includeResident = false,
	): Promise<PassiveRlmSubagent | undefined> {
		const matches = [...(await this.passiveRlmSubagentsByPath([], includeResident)).values()].filter(
			({ entry, info }) =>
				entry.childId === target ||
				resolve(entry.sessionFile) === resolve(target) ||
				info.id === target ||
				(info.name ?? entry.sessionName) === target,
		);
		if (matches.length > 1) {
			throw new Error(`Session selector "${target}" is ambiguous`);
		}
		return matches[0];
	}

	private async addRuntime(
		runtime: AgentSessionRuntime,
		name?: string,
		clientEnv?: Record<string, string>,
		onStateCreated?: (state: ActiveSessionState) => void,
		runtimeOpenGuard?: RuntimeOpenGuard,
		onStateBound?: (state: ActiveSessionState) => void,
		restoreActiveSessionId?: string,
	): Promise<ActiveSessionState> {
		const desiredActiveSessionId =
			runtime.metadata.kind === "top-level" ? this.restoreActiveSessionId : restoreActiveSessionId;
		if (runtime.metadata.kind === "top-level" && desiredActiveSessionId) {
			this.restoreActiveSessionId = undefined;
		}
		const state: ActiveSessionState = {
			activeSessionId:
				desiredActiveSessionId && !this.sessions.has(desiredActiveSessionId)
					? desiredActiveSessionId
					: createActiveSessionId(this.sessions),
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: createActiveSessionId(),
			lastEventSequence: 0,
			clientEnv,
		};
		this.sessions.set(state.activeSessionId, state);
		this.bindingSessions.add(state.activeSessionId);
		let completeBinding!: () => void;
		const bindingCompletion = new Promise<void>((resolveBinding) => {
			completeBinding = resolveBinding;
		});
		this.bindingCompletions.set(state.activeSessionId, bindingCompletion);
		onStateCreated?.(state);
		try {
			if (name) {
				await this.setStateSessionName(state, name);
			}
			await bindActiveSessionState(state, {
				broadcast: (targetSessionState, message) => this.broadcastToSession(targetSessionState, message),
				createConnectionState: (targetSessionState) => this.createConnectionState(targetSessionState),
				sessionReplaced: (targetSessionState) => this.refreshReplacedSessionState(targetSessionState),
				shutdown: () => {
					void this.shutdown(0);
				},
				subagentRuntimeHost: this.createSubagentRuntimeHost(state),
			});
			if (runtimeOpenGuard) {
				const guardResult = runtimeOpenGuard();
				if (!(typeof guardResult === "boolean" ? guardResult : await guardResult)) {
					throw new RuntimeOpenCancelledError();
				}
			}
			onStateBound?.(state);
			this.scheduleRosterFlush();
		} catch (error) {
			state.unsubscribe?.();
			this.sessions.delete(state.activeSessionId);
			await runtime.dispose().catch(() => undefined);
			throw error;
		} finally {
			this.bindingSessions.delete(state.activeSessionId);
			this.bindingCompletions.delete(state.activeSessionId);
			completeBinding();
		}
		this.registerCronStoreForState(state);
		this.rebindCronJobsToState(state);
		if (runtime.metadata.kind !== "subagent") {
			// Mark the session as daemon-resident so a restarted daemon can
			// restore it. Closes for kill/completed/replaced flip this back to
			// sleep; clean shutdowns leave it in place on purpose.
			try {
				runtime.session.sessionManager.appendSessionState({ status: "active" });
			} catch {
				// Marking is best-effort; the session still works unrestored.
			}
		}
		// Restore the last persisted status so it shows before the first sweep.
		this.summarizer.seed(state);
		this.recordWorkerRecoveryState(state, "ready");
		return state;
	}

	private refreshReplacedSessionState(state: ActiveSessionState): void {
		this.acpMcpOwners?.delete(state.activeSessionId);
		for (const client of state.clients) {
			this.abortSideQuestionsFor(client, state.activeSessionId);
		}
		this.summarizer.forget(state.activeSessionId);
		state.summaryState = undefined;
		state.runtime.session.setCurrentRecap(undefined);
		this.summarizer.seed(state);
		if (state.runtime.metadata.kind === "subagent") {
			const summaryState = state.summaryState as ActiveSessionState["summaryState"];
			state.runtime.session.setCurrentRecap(summaryState?.summary);
		}
		this.registerCronStoreForState(state);
		this.rebindCronJobsToState(state);
	}

	private registerCronStoreForState(state: ActiveSessionState): void {
		if (!this.options.worker) {
			return;
		}
		const session = state.runtime.session;
		const artifactDir = session.sessionManager.getSessionArtifactDir();
		if (!artifactDir) {
			return;
		}
		if (this.cronStore.registerSessionArtifact(session.sessionId, artifactDir)) {
			this.cronStore.recoverSessionArtifact(session.sessionId);
			this.cronScheduler.wake();
		}
		// A fresh worker only knows resident sessions' jobs; passive descendants' schedules must fire without hydration.
		if (state.runtime.metadata.kind !== "subagent") {
			void this.registerPassiveDescendantCronArtifacts().catch((error) => {
				this.log(`Could not register passive descendant scheduled jobs: ${String(error)}`);
			});
		}
	}

	private async registerPassiveDescendantCronArtifacts(): Promise<void> {
		let registered = false;
		for (const passive of await this.listPassiveRlmSubagents()) {
			try {
				const artifactDir = getSessionArtifactPathForFile(resolve(passive.entry.sessionFile), passive.info.id);
				if (this.cronStore.registerSessionArtifact(passive.info.id, artifactDir)) {
					registered = true;
					this.cronStore.recoverSessionArtifact(passive.info.id);
				}
			} catch (error) {
				this.log(
					`Could not register scheduled jobs for passive subagent ${passive.entry.childId}: ${String(error)}`,
				);
			}
		}
		if (registered) {
			this.cronScheduler.wake();
		}
	}

	private async createRuntime(
		command: Extract<DaemonCommand, { type: "create" }>,
		runtimeOpenGuard?: RuntimeOpenGuard,
	): Promise<ActiveSessionState> {
		const config = mergeAgentSessionRuntimeConfig(this.options.defaultSessionConfig, command.config);
		if (!config.cwd) {
			throw new Error("Active session config is missing cwd");
		}
		if (!config.agentDir) {
			throw new Error("Active session config is missing agentDir");
		}

		const cwd = resolve(config.cwd);
		const agentDir = config.agentDir;
		const clientEnv = filterClientEnv(command.env);
		const cwdOverride = command.config?.cwd ? resolve(command.config.cwd) : undefined;
		const sessionPath = command.sessionPath
			? await resolveDaemonSessionPath(command.sessionPath, cwd, config.sessionDir)
			: undefined;
		const sessionKey = sessionPath ? resolve(sessionPath) : undefined;
		if (sessionKey && this.findPassivationBySessionFile(sessionKey)) {
			await this.waitForPassivation(sessionKey);
			return this.createRuntime(command, runtimeOpenGuard);
		}
		const pending = sessionKey ? this.openingSessions.get(sessionKey) : undefined;
		if (pending && sessionKey) {
			// Join the in-process open before attempting the filesystem lease. The
			// creator owns that lease until its runtime is ready.
			let state: ActiveSessionState;
			try {
				state = await pending;
			} catch (error) {
				if (!runtimeOpenGuard && error instanceof RuntimeOpenCancelledError) {
					if (this.openingSessions.get(sessionKey) === pending) {
						this.openingSessions.delete(sessionKey);
					}
					return this.createRuntime(command);
				}
				throw error;
			}
			if (runtimeOpenGuard && !(await runtimeOpenGuard())) {
				throw new RuntimeOpenCancelledError();
			}
			if (command.name) {
				await this.setStateSessionName(state, command.name);
			}
			this.adoptClientEnv(state, clientEnv);
			this.rebindCronJobsToState(state);
			return state;
		}

		const passiveSubagent = sessionPath ? await this.findPassiveRlmSubagent(sessionPath) : undefined;
		if (passiveSubagent) {
			if (runtimeOpenGuard && !(await runtimeOpenGuard())) {
				throw new RuntimeOpenCancelledError();
			}
			if (command.name) {
				const normalizedName = command.name.trim();
				if (!normalizedName) {
					throw new Error("Session name cannot be empty");
				}
				await this.assertFamilySessionNameAvailable({
					name: normalizedName,
					depth: passiveSubagent.info.rlmDepth ?? passiveSubagent.entry.rlmDepth ?? 1,
					parentSessionId: passiveSubagent.entry.parentSessionId,
					parentSessionPath:
						passiveSubagent.entry.parentSessionFile ??
						passiveSubagent.chain.at(-2)?.sessionFile ??
						passiveSubagent.rootParentState?.runtime.session.sessionFile ??
						passiveSubagent.rootInfo?.path,
					ignoreSessionId: passiveSubagent.info.id,
				});
			}
			const state = await this.hydratePassiveRlmSubagent(passiveSubagent, clientEnv);
			if (runtimeOpenGuard && !(await runtimeOpenGuard())) {
				throw new RuntimeOpenCancelledError();
			}
			if (command.name) {
				await this.setStateSessionName(state, command.name);
			}
			if (passiveSubagent.rootParentState) this.adoptClientEnv(passiveSubagent.rootParentState, clientEnv);
			this.adoptClientEnv(state, clientEnv);
			return state;
		}

		// Hydration may have started while the async registry walk above was in
		// progress. Re-enter so the explicit opener joins its published promise.
		if (sessionKey && this.openingSessions.has(sessionKey)) {
			return this.createRuntime(command, runtimeOpenGuard);
		}

		let releaseOpenReservation = () => {};
		if (sessionKey) {
			const reservation = this.reservingSessionOpens.get(sessionKey);
			if (reservation) {
				await reservation;
				return this.createRuntime(command, runtimeOpenGuard);
			}
			let release!: () => void;
			const reserved = new Promise<void>((resolveReservation) => {
				release = resolveReservation;
			});
			this.reservingSessionOpens.set(sessionKey, reserved);
			let released = false;
			releaseOpenReservation = () => {
				if (released) return;
				released = true;
				if (this.reservingSessionOpens.get(sessionKey) === reserved) {
					this.reservingSessionOpens.delete(sessionKey);
				}
				release();
			};
		}

		const existing = sessionPath ? this.findSessionBySessionFile(sessionPath) : undefined;
		if (existing) {
			releaseOpenReservation();
			await this.waitForBoundSession(existing);
			if (runtimeOpenGuard && !(await runtimeOpenGuard())) {
				throw new RuntimeOpenCancelledError();
			}
			if (command.name) {
				await this.setStateSessionName(existing, command.name);
			}
			this.adoptClientEnv(existing, clientEnv);
			this.rebindCronJobsToState(existing);
			return existing;
		}

		let sessionLease: SessionLease | undefined;
		let sessionManager: SessionManager;
		try {
			sessionLease = await acquireSessionLeaseAsync(sessionPath, agentDir);
			// Repair only after lease acquisition and only on the write-owning
			// branch: the in-memory branch never writes this file back.
			if (sessionPath && !command.noSession) {
				repairOwnedSessionFile(sessionPath);
			}
			sessionManager = sessionPath
				? command.noSession
					? await SessionManager.openInMemoryAsync(sessionPath, config.sessionDir, cwdOverride)
					: await SessionManager.openAsync(sessionPath, config.sessionDir, cwdOverride)
				: command.noSession
					? SessionManager.inMemory(cwd)
					: command.continueRecent
						? SessionManager.continueRecent(cwd, config.sessionDir)
						: SessionManager.create(cwd, config.sessionDir);
		} catch (error) {
			sessionLease?.release();
			releaseOpenReservation();
			throw error;
		}
		const createState = async (): Promise<ActiveSessionState> => {
			if (runtimeOpenGuard && !(await runtimeOpenGuard())) {
				sessionLease?.release();
				throw new RuntimeOpenCancelledError();
			}
			const existing = this.findSessionBySessionFile(sessionManager.getSessionFile());
			if (existing) {
				sessionLease?.release();
				await this.waitForBoundSession(existing);
				// A live runtime already owns this session file; reuse it instead of
				// starting a second runtime that would interleave writes to one file.
				// clientEnv adopts the first offered identity (e.g. a pane opening a
				// cron-created session) but never overwrites one: extensions captured
				// the creator's identity at load, and swapping it would only make
				// pi.exec disagree with those captures.
				if (command.name) {
					await this.setStateSessionName(existing, command.name);
				}
				this.adoptClientEnv(existing, clientEnv);
				this.rebindCronJobsToState(existing);
				return existing;
			}
			let stateRef: ActiveSessionState | undefined;
			// Extensions capture client env (e.g. herdr pane identity) synchronously
			// while the runtime loads them, so it must be in process.env for the
			// duration; withClientEnv restores it after.
			const runtime = await withClientEnv(clientEnv, () =>
				createAgentSessionRuntime(this.options.createRuntime, {
					cwd: sessionManager.getCwd(),
					agentDir,
					sessionManager,
					sessionConfig: config,
					runtimeMetadata: command.runtimeMetadata,
					sessionLease,
					sessionOptions: {
						rlmHeartbeatController: {
							listRlmHeartbeats: (listOptions) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.cronStore.listRlmHeartbeats(stateRef.activeSessionId, listOptions);
							},
							createRlmHeartbeat: (input) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.createRlmHeartbeatForState(stateRef, input);
							},
							updateRlmHeartbeat: (input) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.updateRlmHeartbeatForState(stateRef, input);
							},
							deleteRlmHeartbeat: (id) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.deleteRlmHeartbeatForState(stateRef, id);
							},
						},
						agentMessageController: this.createAgentMessageController(() => stateRef),
						agentObserveController: this.createAgentObserveController(() => stateRef),
					},
				}),
			);
			if (runtimeOpenGuard && !(await runtimeOpenGuard())) {
				await runtime.dispose().catch(() => undefined);
				throw new RuntimeOpenCancelledError();
			}
			const state = await this.addRuntime(
				runtime,
				command.name,
				clientEnv,
				(state) => {
					stateRef = state;
				},
				runtimeOpenGuard,
			);
			return state;
		};

		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			releaseOpenReservation();
			return createState();
		}
		const openedSessionKey = resolve(sessionFile);
		if (this.openingSessions.has(openedSessionKey)) {
			sessionLease?.release();
			releaseOpenReservation();
			return this.createRuntime({ ...command, sessionPath: sessionFile }, runtimeOpenGuard);
		}
		const opening = Promise.resolve().then(createState);
		this.openingSessions.set(openedSessionKey, opening);
		releaseOpenReservation();
		try {
			return await opening;
		} finally {
			releaseOpenReservation();
			if (this.openingSessions.get(openedSessionKey) === opening) {
				this.openingSessions.delete(openedSessionKey);
			}
		}
	}

	private async runCronJob(job: AgentCronJob): Promise<AgentCronJobRunResult | undefined> {
		const requirePersistedJob = this.cronStore.list().some((candidate) => candidate.id === job.id);
		const dueJob = requirePersistedJob ? this.getRunnableCronJob(job.id) : job;
		if (!dueJob) {
			return "skipped";
		}
		const state = await this.getOrCreateCronJobSession(dueJob, requirePersistedJob);
		const runnableJob = requirePersistedJob ? this.getRunnableCronJob(job.id) : dueJob;
		if (!state || !runnableJob || !this.isCronJobRunnableForState(runnableJob, state, requirePersistedJob)) {
			return "skipped";
		}
		const session = state.runtime.session;
		if (shouldDeferHeartbeatCronJob(runnableJob, session)) {
			// Deferring against queued work that sits behind an ordinary abort
			// suspension would skip forever: the pump never drains on its own and
			// every later tick defers against the same stranded queue. A heartbeat
			// tick is a legitimate external wake; resume the pump so the queued
			// work drains (the update-restart fence is never lifted).
			if (session.hasPendingSessionWork) {
				session.wakeSuspendedSessionInput();
			}
			return "skipped";
		}
		const shouldQueueCronPrompt =
			session.isStreaming ||
			session.isCompacting ||
			session.isRetrying ||
			session.isBashRunning ||
			session.unfinishedActionCount > 0;
		if (!isHeartbeatCronJob(runnableJob) && shouldQueueCronPrompt) {
			if (!this.isCronJobRunnableForState(runnableJob, state, requirePersistedJob)) {
				return "skipped";
			}
			// Admission refusals deliberately propagate: the scheduler's dispatch
			// queue is the single classification point for pre-delivery refusals
			// (XA-1, r41), so it defers the tick instead of recording a burned run.
			await session.followUp(runnableJob.prompt, undefined, {
				resumeIfIdle: true,
				// A scheduled prompt is machine-triggered, so it must not outrank live human input.
				priority: "background",
			});
			return;
		}
		const getRunnableJob = (): AgentCronJob | undefined => {
			const current = requirePersistedJob ? this.getRunnableCronJob(job.id) : runnableJob;
			return current && this.isCronJobRunnableForState(current, state, requirePersistedJob) ? current : undefined;
		};
		const current = getRunnableJob();
		if (!current) {
			return "skipped";
		}
		// Re-check after the session admission fence wait: the job may have been cancelled, completed, or updated meanwhile.
		const unrunnableAtAdmission = new Error("Cron job became unrunnable before admission");
		const admissionCommitted = () => {
			const refreshed = getRunnableJob();
			if (!refreshed || refreshed.prompt !== current.prompt || refreshed.deliveryMode !== current.deliveryMode) {
				throw unrunnableAtAdmission;
			}
		};
		try {
			if (isHeartbeatCronJob(current)) {
				const promptResult = await session.promptHeartbeat(current, {
					streamingBehavior: resolveHeartbeatStreamingBehavior(current.deliveryMode),
					followUpQueueKey: `heartbeat:${current.id}`,
					source: "rpc",
					admissionCommitted,
				});
				// G5 (r37 hbgoal-ts): a coalesced or rejected follow-up delivered no new
				// action; a skipped dispatch keeps runCount and lastRunAt honest instead
				// of recording a run that never happened.
				if (promptResult && !promptResult.admitted) {
					return "skipped";
				}
				return;
			}
			await session.promptUntilAccepted(current.prompt, {
				streamingBehavior: "followUp",
				source: "rpc",
				// A scheduled prompt is machine-triggered, so it must not outrank live human input.
				priority: "background",
				admissionCommitted,
			});
		} catch (error) {
			if (error === unrunnableAtAdmission) {
				return "skipped";
			}
			// Admission refusals propagate for the scheduler's single
			// classification point (XA-1, r41): a pre-delivery refusal defers
			// the tick there instead of being classified per-hook.
			throw error;
		}
	}

	private getRunnableCronJob(jobId: string): AgentCronJob | undefined {
		return this.cronStore.getClaimedJob(jobId) ?? this.cronStore.getDueJob(jobId);
	}

	private createCronJobForState(state: ActiveSessionState, schedule: string, prompt: string): AgentCronJob {
		const session = state.runtime.session;
		const sessionFile = session.sessionFile;
		if (!sessionFile) {
			throw new Error("Cron jobs require a persisted session file");
		}
		const job = this.cronStore.create({
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			sessionFile,
			cwd: state.runtime.cwd,
			runtimeKind: state.runtime.metadata.kind,
			scheduleText: schedule,
			prompt,
		});
		this.cronScheduler.wake();
		return job;
	}

	private createHeartbeatForState(
		state: ActiveSessionState,
		schedule: string,
		instruction: string,
		deliveryMode?: AgentHeartbeatDeliveryMode,
	): AgentCronJob {
		const session = state.runtime.session;
		const sessionFile = session.sessionFile;
		if (!sessionFile) {
			throw new Error("Heartbeats require a persisted session file");
		}
		const previousHeartbeat = this.cronStore.getHeartbeat(state.activeSessionId);
		const job = this.cronStore.createHeartbeat({
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			sessionFile,
			cwd: state.runtime.cwd,
			runtimeKind: state.runtime.metadata.kind,
			scheduleText: normalizeHeartbeatSchedule(schedule),
			prompt: instruction,
			deliveryMode: deliveryMode ?? previousHeartbeat?.deliveryMode,
		});
		if (previousHeartbeat) {
			this.removeQueuedHeartbeatFollowUp(state, previousHeartbeat);
		}
		this.cronScheduler.wake();
		return job;
	}

	private updateHeartbeatForState(
		state: ActiveSessionState,
		action: AgentHeartbeatUpdateAction,
	): AgentCronJob | undefined {
		const job =
			action === "pause"
				? this.cronStore.pauseHeartbeat(state.activeSessionId)
				: action === "resume"
					? this.cronStore.resumeHeartbeat(state.activeSessionId)
					: this.cronStore.clearHeartbeat(state.activeSessionId);
		if (job && action !== "resume") {
			this.removeQueuedHeartbeatFollowUp(state, job);
		}
		this.cronScheduler.wake();
		return job;
	}

	private createRlmHeartbeatForState(
		state: ActiveSessionState,
		input: {
			instruction: string;
			interval?: string;
			label?: string;
			deliveryMode?: AgentHeartbeatDeliveryMode;
		},
	): AgentCronJob {
		const session = state.runtime.session;
		const sessionFile = session.sessionFile;
		if (!sessionFile) {
			throw new Error("RLM heartbeats require a persisted session file");
		}
		const job = this.cronStore.createRlmHeartbeat({
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			sessionFile,
			cwd: state.runtime.cwd,
			runtimeKind: state.runtime.metadata.kind,
			label: input.label,
			scheduleText: normalizeHeartbeatSchedule(input.interval ?? DEFAULT_HEARTBEAT_SCHEDULE),
			prompt: input.instruction,
			deliveryMode: input.deliveryMode,
		});
		this.cronScheduler.wake();
		return job;
	}

	private updateRlmHeartbeatForState(
		state: ActiveSessionState,
		input: {
			id: string;
			instruction?: string;
			interval?: string;
			label?: string;
			status?: "pause" | "resume";
			deliveryMode?: AgentHeartbeatDeliveryMode;
		},
	): AgentCronJob | undefined {
		const job = this.cronStore.updateRlmHeartbeat(state.activeSessionId, input.id, {
			label: input.label,
			prompt: input.instruction,
			scheduleText: input.interval ? normalizeHeartbeatSchedule(input.interval) : undefined,
			status: input.status,
			deliveryMode: input.deliveryMode,
		});
		if (job) {
			if (
				input.instruction !== undefined ||
				input.interval !== undefined ||
				input.status === "pause" ||
				input.deliveryMode !== undefined
			) {
				this.removeQueuedHeartbeatFollowUp(state, job);
			}
			this.cronScheduler.wake();
		}
		return job;
	}

	private deleteRlmHeartbeatForState(state: ActiveSessionState, id: string): AgentCronJob | undefined {
		const job = this.cronStore.deleteRlmHeartbeat(state.activeSessionId, id);
		if (job) {
			this.removeQueuedHeartbeatFollowUp(state, job);
			this.cronScheduler.wake();
		}
		return job;
	}

	private listHeartbeats(): AgentConnectionHeartbeat[] {
		return this.cronStore
			.list()
			.filter((job) => isHeartbeatCronJob(job) && (job.status === "active" || job.status === "paused"))
			.map((job) => {
				const state = this.sessions.get(job.activeSessionId);
				const summary = state ? summaryForActiveSession(state) : undefined;
				return {
					job,
					...(summary?.sessionName ? { sessionName: summary.sessionName } : {}),
					...(summary?.firstMessage ? { firstMessage: summary.firstMessage } : {}),
				};
			});
	}

	private manageHeartbeat(
		activeSessionId: string,
		jobId: string,
		action: AgentHeartbeatManagementAction,
	): AgentCronJob | undefined {
		const job = this.cronStore.manageHeartbeat(activeSessionId, jobId, action);
		const state = this.sessions.get(activeSessionId);
		if (job && action !== "resume" && state) {
			this.removeQueuedHeartbeatFollowUp(state, job);
		}
		if (job) {
			this.cronScheduler.wake();
		}
		return job;
	}

	private rebindCronJobsToState(state: ActiveSessionState): void {
		const sessionFile = state.runtime.session.sessionFile;
		if (!sessionFile) {
			return;
		}
		const reboundJobs = this.cronStore.rebindSessionJobs({
			activeSessionId: state.activeSessionId,
			sessionId: state.runtime.session.sessionId,
			sessionFile,
			cwd: state.runtime.cwd,
		});
		if (reboundJobs.some((job) => job.status === "active")) {
			this.cronScheduler.wake();
		}
	}

	private cancelSubagentRlmHeartbeats(state: ActiveSessionState): void {
		if (state.runtime.metadata.kind !== "subagent") {
			return;
		}
		const cancelled = this.cronStore.cancelRlmHeartbeatsForSession(state.activeSessionId);
		for (const job of cancelled) {
			this.removeQueuedHeartbeatFollowUp(state, job);
		}
		if (cancelled.length > 0) {
			this.cronScheduler.wake();
		}
	}

	private cancelScheduledJobsForSession(state: ActiveSessionState): void {
		const session = state.runtime.session;
		const target: {
			activeSessionId: string;
			sessionId?: string;
			sessionFile?: string;
		} = {
			activeSessionId: state.activeSessionId,
		};
		if (session?.sessionId) {
			target.sessionId = session.sessionId;
		}
		if (session?.sessionFile) {
			target.sessionFile = session.sessionFile;
		}
		const cancelled = this.cronStore.cancelJobsForSession(target);
		for (const job of cancelled) {
			this.removeQueuedHeartbeatFollowUp(state, job);
		}
		if (cancelled.length > 0) {
			this.cronScheduler.wake();
		}
	}

	private cancelScheduledJobsForSessionFile(sessionFile: string): void {
		const cancelled = this.cronStore.cancelJobsForSession({ sessionFile });
		if (cancelled.length > 0) {
			this.cronScheduler.wake();
		}
	}

	private deleteSavedSessionFile(
		sessionPath: string,
		options?: Parameters<typeof deleteSessionFile>[1],
	): ReturnType<typeof deleteSessionFile> {
		return deleteSessionFile(sessionPath, options);
	}

	private removeQueuedHeartbeatFollowUp(state: ActiveSessionState, job: AgentCronJob): void {
		if (!isHeartbeatCronJob(job)) {
			return;
		}
		state.runtime.session.removeQueuedFollowUp(`heartbeat:${job.id}`);
	}

	private async getOrCreateCronJobSession(
		job: AgentCronJob,
		requirePersistedJob: boolean,
	): Promise<ActiveSessionState | undefined> {
		const dueJob = requirePersistedJob ? this.getRunnableCronJob(job.id) : job;
		if (!dueJob) {
			return undefined;
		}
		const activeIdMatch = this.sessions.get(dueJob.activeSessionId);
		const current =
			this.findSessionBySessionFile(dueJob.sessionFile) ??
			(!requirePersistedJob || activeIdMatch?.runtime.session.sessionId === dueJob.sessionId
				? activeIdMatch
				: undefined);
		const requiresRlmSubagentRestore =
			dueJob.source === "rlm_heartbeat" &&
			dueJob.runtimeKind === "subagent" &&
			current?.runtime.metadata.kind !== "subagent";
		// A half-bound match falls through to createRuntime, which awaits the
		// pending create for the same session file instead of prompting mid-bind.
		if (current && !this.bindingSessions.has(current.activeSessionId) && !requiresRlmSubagentRestore) {
			this.rebindCronJobsToState(current);
			const reboundJob = requirePersistedJob ? this.getRunnableCronJob(job.id) : dueJob;
			return reboundJob && this.isCronJobRunnableForState(reboundJob, current, requirePersistedJob)
				? current
				: undefined;
		}
		if (!requirePersistedJob) {
			return undefined;
		}
		if (dueJob.source === "rlm_heartbeat" && dueJob.runtimeKind === "subagent") {
			if (current && this.bindingSessions.has(current.activeSessionId)) {
				return undefined;
			}
			return this.restoreRlmHeartbeatSession(dueJob);
		}
		if (!(await this.isPersistedCronJobRunnable(dueJob.id))) {
			return undefined;
		}
		try {
			return await this.createRuntime({ type: "create", sessionPath: dueJob.sessionFile }, () =>
				this.isPersistedCronJobRunnable(dueJob.id),
			);
		} catch (error) {
			if (error instanceof RuntimeOpenCancelledError) {
				return undefined;
			}
			throw error;
		}
	}

	private async restoreRlmHeartbeatSession(job: AgentCronJob): Promise<ActiveSessionState | undefined> {
		const childInfo = await readSessionInfo(job.sessionFile);
		const parentSessionPath = childInfo?.parentSessionPath;
		const parentInfo = parentSessionPath ? await readSessionInfo(parentSessionPath) : undefined;
		if (
			!childInfo ||
			childInfo.id !== job.sessionId ||
			!parentSessionPath ||
			!parentInfo ||
			parentInfo.state?.status !== "active"
		) {
			this.cancelRlmHeartbeat(job.id);
			return undefined;
		}

		try {
			const residentChild = this.findSessionBySessionFile(job.sessionFile);
			await this.createRuntime(
				{ type: "create", sessionPath: parentSessionPath },
				() => this.getRunnableCronJob(job.id) !== undefined,
			);
			const passiveSubagent = await this.findPassiveRlmSubagent(
				job.sessionFile,
				residentChild !== undefined && residentChild.runtime.metadata.kind !== "subagent",
			);
			const resident = this.findSessionBySessionFile(job.sessionFile);
			const childState = passiveSubagent
				? await this.hydratePassiveRlmSubagent(passiveSubagent)
				: resident
					? await this.waitForBoundSession(resident)
					: undefined;
			if (passiveSubagent && childState && this.getRunnableCronJob(job.id) === undefined) {
				throw new RuntimeOpenCancelledError();
			}
			if (!childState || childState.runtime.metadata.kind !== "subagent") {
				this.cancelRlmHeartbeat(job.id);
				return undefined;
			}
			this.rebindCronJobsToState(childState);
			const reboundJob = this.getRunnableCronJob(job.id);
			return reboundJob && this.isCronJobRunnableForState(reboundJob, childState, true) ? childState : undefined;
		} catch (error) {
			if (error instanceof RuntimeOpenCancelledError || error instanceof BoundSessionUnavailableError) {
				return undefined;
			}
			throw error;
		}
	}

	private cancelRlmHeartbeat(jobId: string): void {
		if (this.cronStore.cancel(jobId)) {
			this.cronScheduler.wake();
		}
	}

	private async isPersistedCronJobRunnable(jobId: string): Promise<boolean> {
		for (let attempt = 0; attempt < 2; attempt++) {
			const job = this.getRunnableCronJob(jobId);
			if (!job) {
				return false;
			}
			const sessionFile = resolve(job.sessionFile);
			const sessionInfo = await readSessionInfo(sessionFile);
			const current = this.getRunnableCronJob(jobId);
			if (!current) {
				return false;
			}
			if (resolve(current.sessionFile) !== sessionFile || current.sessionId !== job.sessionId) {
				continue;
			}
			if (!sessionInfo || sessionInfo.id !== current.sessionId || sessionInfo.state?.status !== "active") {
				this.cancelScheduledJobsForSessionFile(current.sessionFile);
				return false;
			}
			return true;
		}
		return false;
	}

	private isCronJobRunnableForState(
		job: AgentCronJob,
		state: ActiveSessionState,
		requirePersistedJob: boolean,
	): boolean {
		if (this.sessions.get(state.activeSessionId) !== state || this.closingSessions.has(state.activeSessionId)) {
			return false;
		}
		if (!requirePersistedJob) {
			return job.status === "active" && job.activeSessionId === state.activeSessionId;
		}
		const current = this.getRunnableCronJob(job.id);
		const sessionFile = state.runtime.session.sessionFile;
		return (
			current !== undefined &&
			current.activeSessionId === state.activeSessionId &&
			current.sessionId === state.runtime.session.sessionId &&
			sessionFile !== undefined &&
			resolve(current.sessionFile) === resolve(sessionFile)
		);
	}

	private findSessionBySessionFile(sessionFile: string | undefined): ActiveSessionState | undefined {
		if (!sessionFile) {
			return undefined;
		}
		const target = resolve(sessionFile);
		for (const state of this.sessions.values()) {
			const file = state.runtime.session.sessionFile;
			if (file && resolve(file) === target) {
				return state;
			}
		}
		return undefined;
	}

	private getSessionState(id: string): ActiveSessionState {
		return resolveActiveSessionState(this.sessions, id);
	}

	// A bind failure disposes the runtime, so half-bound sessions must not be
	// targetable by attach, agent messages, or observe.
	private getBoundSessionState(id: string): ActiveSessionState {
		const state = this.getSessionState(id);
		if (this.bindingSessions.has(state.activeSessionId)) {
			throw new BoundSessionUnavailableError(`Active session ${state.activeSessionId} is still initializing`);
		}
		if (this.closingSessions.has(state.activeSessionId)) {
			throw new BoundSessionUnavailableError(`Active session ${state.activeSessionId} is closing`);
		}
		return state;
	}

	private async getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState> {
		let lookupError: unknown;
		try {
			return this.getBoundSessionState(id);
		} catch (error) {
			if (error instanceof BoundSessionUnavailableError) {
				return this.waitForHydratingChild(this.getSessionState(id), id);
			}
			if (error instanceof AmbiguousActiveSessionError) {
				throw error;
			}
			lookupError = error;
		}
		const passiveSubagent = await this.findPassiveRlmSubagent(id);
		if (passiveSubagent) {
			return this.hydratePassiveRlmSubagent(passiveSubagent);
		}
		const hydratingChild = [...this.sessions.values()].find(
			(state) => state.runtime.metadata.kind === "subagent" && state.runtime.metadata.rlmChildId === id,
		);
		if (hydratingChild) {
			return this.waitForHydratingChild(hydratingChild, id);
		}
		try {
			return this.getBoundSessionState(id);
		} catch (error) {
			if (error instanceof BoundSessionUnavailableError) {
				return this.waitForHydratingChild(this.getSessionState(id), id);
			}
			if (error instanceof AmbiguousActiveSessionError) throw error;
			throw lookupError;
		}
	}

	private async waitForHydratingChild(state: ActiveSessionState, selector: string): Promise<ActiveSessionState> {
		const sessionFile = state.runtime.session.sessionFile;
		if (!sessionFile || !this.findPassivationBySessionFile(sessionFile)) {
			return this.waitForBoundSession(state);
		}
		await this.waitForPassivation(sessionFile);
		const passive = await this.findPassiveRlmSubagent(sessionFile);
		return passive ? this.hydratePassiveRlmSubagent(passive) : this.getOrHydrateBoundSessionState(selector);
	}

	private createSubagentRuntimeHost(parentState: ActiveSessionState): SubagentRuntimeHost {
		return {
			createRlmSubagentRuntime: async (options) => this.createRlmSubagentRuntime(parentState, options),
			completeRlmSubagentRuntime: (childId, session) => {
				const state = [...this.sessions.values()].find(
					(candidate) =>
						candidate.runtime.metadata.kind === "subagent" &&
						candidate.runtime.metadata.parentActiveSessionId === parentState.activeSessionId &&
						candidate.runtime.metadata.rlmChildId === childId &&
						candidate.runtime.session === session,
				);
				if (!state) return false;
				if (!state.runtime.session.sessionManager.allowsPersistence()) return true;
				if (!state.runtime.session.sessionFile) return false;
				if (state.runtime.metadata.rehydratedCompleted) return true;
				const metadata = state.runtime.metadata;
				const model = session.model;
				return this.recordRlmSubagentState(parentState, {
					childId,
					sessionName: session.sessionName ?? childId,
					sessionDir: metadata.sessionDir ?? dirname(state.runtime.session.sessionFile),
					sessionFile: state.runtime.session.sessionFile,
					rlmDepth: session.rlmDepth,
					rlmMaxDepth: session.rlmMaxDepth,
					rlmParentNodeId: metadata.rlmParentNodeId,
					prompt: metadata.prompt && metadata.prompt.length <= 4096 ? metadata.prompt : undefined,
					spawnCode: metadata.spawnCode,
					...(model ? { model: { provider: model.provider, modelId: model.id } } : {}),
					status: "completed",
					createdAt: metadata.createdAt,
				});
			},
			releaseRlmSubagentRuntime: async (runtime, options, status) => {
				// Persist the deletion boundary first, but never let a registry failure
				// strand the cancelled child as a stale resident session.
				let deletionError: unknown;
				if (status === "cancelled") {
					try {
						await this.recordRlmSubagentDeletion(parentState, options.id, "revoked");
					} catch (error) {
						deletionError = error;
					}
				}
				const state = [...this.sessions.values()].find(
					(candidate) =>
						candidate.runtime.metadata.kind === "subagent" &&
						candidate.runtime.metadata.parentActiveSessionId === parentState.activeSessionId &&
						candidate.runtime.metadata.rlmChildId === options.id &&
						candidate.runtime.session === runtime.session,
				);
				const disposal = status === "cancelled" ? { kernelSnapshot: false } : undefined;
				try {
					if (state) {
						await this.closeSession(
							state,
							status === "cancelled" ? "killed" : "completed",
							true,
							true,
							undefined,
							disposal,
						);
					} else {
						await runtime.session.disposeAsync(disposal);
					}
				} finally {
					// Sweep even when teardown throws (see deleteRlmSubagentRuntime);
					// never throws, so it cannot mask a teardown error.
					if (status === "cancelled" && deletionError === undefined) {
						const childSessionFile = runtime.session?.sessionFile;
						if (childSessionFile) {
							await this.deleteRlmSubagentArtifacts(options.id, childSessionFile);
						}
					}
				}
				if (deletionError !== undefined) throw deletionError;
			},
			deleteRlmSubagentRuntime: async (childId, session) => {
				const state = [...this.sessions.values()].find(
					(candidate) =>
						candidate.runtime.metadata.kind === "subagent" &&
						candidate.runtime.metadata.parentActiveSessionId === parentState.activeSessionId &&
						candidate.runtime.metadata.rlmChildId === childId,
				);
				const parentFile = parentState.runtime.session.sessionFile;
				const parentPath = parentFile ? canonicalSessionPath(parentFile) : undefined;
				// Tombstoned edges included: a retried delete must still resolve the
				// child's path so its scheduled jobs get cancelled.
				const persistedEdge = parentPath
					? (await this.rlmSpawnLedger().edges(true)).find(
							(edge) => edge.childId === childId && canonicalSessionPath(edge.parent) === parentPath,
						)
					: undefined;
				// The writer-recorded path (not the ledger's realpath-canonical one)
				// keys the cron store and residency maps.
				const persisted =
					persistedEdge && parentFile
						? await this.passiveRlmSubagentEntryForEdge(persistedEdge, {
								sessionId: parentState.runtime.session.sessionId,
								sessionFile: parentFile,
							})
						: undefined;
				// Pre-ledger children have no edge at all (tombstoned or live): the
				// legacy registry (including its tombstones) is the last path source.
				const legacyFallback =
					!persisted && !state && parentFile
						? (
								await this.readLegacyRlmSubagentRegistry(
									this.legacyRlmSubagentRegistryPath(parentFile, parentState.runtime.session.sessionId),
								)
							).find((entry) => entry.childId === childId)
						: undefined;
				const childSessionFile =
					persisted?.sessionFile ?? state?.runtime.session.sessionFile ?? legacyFallback?.sessionFile;
				// Persist the deletion boundary before tearing down the runtime.
				await this.recordRlmSubagentDeletion(parentState, childId);
				const staleSession = state && session && state.runtime.session !== session ? session : undefined;
				try {
					try {
						if (state) {
							await this.closeSession(state, "killed", false, true, undefined, { kernelSnapshot: false });
						} else {
							await session?.disposeAsync({ kernelSnapshot: false });
						}
					} finally {
						await staleSession?.disposeAsync({ kernelSnapshot: false });
					}
				} finally {
					// Runs even when teardown throws: the jobs-cancel rewrite and the
					// kernel dispose's final snapshot flush may have already happened,
					// resurrecting the artifact dir swept in recordRlmSubagentDeletion.
					// A killed close can join a passivation close that already skipped
					// killed cleanup. Neither step may throw here: a jobs-store error
					// would mask the teardown error and skip the sweep.
					if (childSessionFile) {
						try {
							this.cancelScheduledJobsForSessionFile(childSessionFile);
						} catch (error) {
							this.log(
								`failed to cancel scheduled jobs for deleted RLM subagent ${childId}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						await this.deleteRlmSubagentArtifacts(childId, childSessionFile);
					}
				}
			},
			disposeRlmSubagentRuntimes: async () => {
				const cascadeError = await this.closeChildSessions(parentState, "replaced");
				if (cascadeError) {
					throw cascadeError;
				}
			},
		};
	}

	private async createRlmSubagentRuntime(
		parentState: ActiveSessionState,
		options: CreateRlmSubagentRuntimeOptions,
	): Promise<AgentSessionRuntime> {
		const childCwd = options.parentSession.sessionManager.getCwd();
		const sessionManager = options.parentSession.sessionManager.allowsPersistence()
			? SessionManager.create(childCwd, options.sessionDir)
			: SessionManager.inMemory(childCwd, options.sessionDir);
		sessionManager.newSession({
			parentSession: options.parentSession.sessionFile,
			rlmDepth: options.rlmDepth,
		});
		let stateRef: ActiveSessionState | undefined;
		// Subagents inherit the parent's client env (e.g. herdr pane identity).
		const runtime = await withClientEnv(parentState.clientEnv, () =>
			createAgentSessionRuntime(this.options.createRuntime, {
				cwd: sessionManager.getCwd(),
				agentDir: parentState.runtime.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "startup" },
				sessionConfig: parentState.runtime.runtimeConfig,
				sessionOptions: {
					model: options.model,
					thinkingLevel: options.thinkingLevel,
					serviceTier: options.serviceTier,
					scopedModels: options.scopedModels,
					initialActiveToolNames: options.activeToolNames,
					allowedToolNames: options.allowedToolNames,
					customTools: options.customTools,
					includeGoals: options.includeGoals,
					includeCompactSkill: options.includeCompactSkill,
					agentMessageController: this.createAgentMessageController(() => stateRef),
					agentObserveController: this.createAgentObserveController(() => stateRef),
					rlmHeartbeatController: {
						listRlmHeartbeats: (listOptions) => {
							if (!stateRef) {
								throw new Error("RLM heartbeat state is not ready for this session yet");
							}
							return this.cronStore.listRlmHeartbeats(stateRef.activeSessionId, listOptions);
						},
						createRlmHeartbeat: (input) => {
							if (!stateRef) {
								throw new Error("RLM heartbeat state is not ready for this session yet");
							}
							return this.createRlmHeartbeatForState(stateRef, input);
						},
						updateRlmHeartbeat: (input) => {
							if (!stateRef) {
								throw new Error("RLM heartbeat state is not ready for this session yet");
							}
							return this.updateRlmHeartbeatForState(stateRef, input);
						},
						deleteRlmHeartbeat: (id) => {
							if (!stateRef) {
								throw new Error("RLM heartbeat state is not ready for this session yet");
							}
							return this.deleteRlmHeartbeatForState(stateRef, id);
						},
					},
					rlmDepth: options.rlmDepth,
					rlmMaxDepth: options.rlmMaxDepth,
					rlmSessionDir: options.sessionDir,
					rlmParentNodeId: options.rlmParentNodeId,
					rlmParentAgent: options.parentSession.sessionName ?? options.parentSession.sessionId,
					semanticParentSessionId: options.parentSession.sessionId,
					semanticSpawnedByRequestId: options.spawnedByRequestId,
				},
				runtimeMetadata: {
					kind: "subagent",
					createdAt: Date.now(),
					parentActiveSessionId: parentState.activeSessionId,
					parentSessionId: options.parentSession.sessionId,
					parentSessionFile: options.parentSession.sessionFile,
					rlmChildId: options.id,
					rlmParentNodeId: options.rlmParentNodeId,
					prompt: options.prompt,
					spawnCode: options.spawnCode,
					sessionDir: options.sessionDir,
				},
			}),
		);
		let state: ActiveSessionState;
		try {
			state = await this.addRuntime(
				runtime,
				undefined,
				parentState.clientEnv,
				(createdState) => {
					stateRef = createdState;
				},
				() => options.parentSession.getRlmChildRunStatus(options.id) !== "cancelled",
				() => {
					if (runtime.session.sessionName !== options.sessionName) {
						runtime.session.setSessionName(options.sessionName);
					}
					if (runtime.session.sessionFile) {
						this.recordRlmSubagentState(parentState, {
							childId: options.id,
							sessionName: options.sessionName,
							sessionDir: options.sessionDir,
							sessionFile: runtime.session.sessionFile,
							rlmDepth: options.rlmDepth,
							rlmMaxDepth: options.rlmMaxDepth,
							rlmParentNodeId: options.rlmParentNodeId,
							prompt: options.prompt.length <= 4096 ? options.prompt : undefined,
							spawnCode: options.spawnCode,
							model: {
								provider: options.model.provider,
								modelId: options.model.id,
							},
							status: "running",
							createdAt: runtime.metadata.createdAt,
						});
					}
					options.onSessionPublished?.(runtime.session);
				},
			);
		} catch (error) {
			this.pendingRlmSpawnAppends.delete(`${parentState.activeSessionId}#${options.id}`);
			throw error;
		}
		// Admission is complete only once the spawn record is durably in the
		// ledger: no self-heal exists for a lost spawn record (seeding only runs
		// when the ledger file is absent; reconciliation only drops edges). A
		// failed append therefore FAILS admission — the just-added child is
		// closed like any other admission failure rather than admitted as a
		// ghost the ledger-driven listing and hydration could never find.
		const spawnAppend = this.pendingRlmSpawnAppends.get(`${parentState.activeSessionId}#${options.id}`);
		this.pendingRlmSpawnAppends.delete(`${parentState.activeSessionId}#${options.id}`);
		try {
			await spawnAppend;
		} catch (error) {
			await this.closeSession(state, "killed", false).catch(() => undefined);
			// The child was never admitted: no ledger edge exists, so the
			// display file written at the spawn write point must not remain
			// claiming a running child.
			try {
				rmSync(rlmSubagentDisplayPath(options.sessionDir), { force: true });
			} catch {
				// Best-effort: a stale display file without an edge is inert.
			}
			throw new Error(
				`Failed to record RLM subagent spawn for ${options.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		return runtime;
	}

	private async sessionPassivationSnapshot(
		state: ActiveSessionState,
		passiveRlmSubagents?: readonly PassiveRlmSubagent[],
	): Promise<SessionPassivationSnapshot> {
		const passiveDescendants = passiveRlmSubagents ?? (await this.listPassiveRlmSubagents());
		const summary = summaryForActiveSession(state);
		const sessionFile = state.runtime.session.sessionFile;
		const jobs = this.cronStore
			.list()
			.filter(
				(job) =>
					job.activeSessionId === state.activeSessionId &&
					job.status !== "cancelled" &&
					job.status !== "completed",
			);
		const hasPendingAdmission =
			[...this.promptAdmissions.values()].some(
				(admission) => admission.activeSessionId === state.activeSessionId && admission.status !== "cancelled",
			) || state.runtime.session.hasPendingAdmissionWaiters;
		return {
			isSessionActive: summary.isSessionActive || summary.hasRunningRlmChildren === true || hasPendingAdmission,
			// The same expression minus the kernel fold that summaryForActiveSession applies, so the
			// residency attribution log can tell "the kernel fact is what holds this session" from
			// "it was resident anyway". Attribution only; the policy reads isSessionActive.
			isSessionActiveIgnoringKernelWork:
				state.runtime.session.isSessionActive || summary.hasRunningRlmChildren === true || hasPendingAdmission,
			// Kernel liveness as its own term, read straight off the session rather than inherited
			// from the summary's isSessionActive fold: passivation closes the kernel, and the kernel
			// SIGTERMs every live bash() process group, so a background script a finished turn left
			// running is residency evidence even though nothing at the turn level is active. The
			// host-side bash controllers behind isBashRunning never see kernel handles (r44 form A).
			// Carrier 1 of 2, and the redundant one by construction: the summary this snapshot is
			// built from already folds the same fact into isSessionActive, so this layer would hold
			// even without the term. It is set anyway so passivation does not depend on a fold owned
			// by another module (daemon-session-list.ts), and it is what the residency attribution
			// below reads. Carrier 2 - the fold the supervisor consumes, since the supervisor has no
			// kernel to observe - is the load-bearing one for whole-worker eviction and empty-session
			// reclamation; deleting it reddens test/suite/live-kernel-work-residency.test.ts, while
			// deleting this term reddens the policy tests in test/session-action-store.test.ts.
			hasLiveKernelWork: state.runtime.session.isKernelWorkInFlight === true,
			attachedClients: state.clients.size + state.pendingAttaches,
			hasRegisteredCronJob: jobs.some((job) => !isHeartbeatCronJob(job)),
			lastActivityAt: Date.parse(summary.lastActivityAt ?? ""),
			hasParent: state.runtime.metadata.kind === "subagent" && !!state.runtime.metadata.parentActiveSessionId,
			hasNonPassiveDescendants: getChildActiveSessionStates(this.sessions, state).length > 0,
			isHydrating:
				this.bindingSessions.has(state.activeSessionId) ||
				(sessionFile ? this.openingSessions.has(resolve(sessionFile)) : false) ||
				passiveDescendants.some(
					(passive) =>
						passive.rootParentState === state &&
						passive.chain.some((entry) => this.openingSessions.has(resolve(entry.sessionFile))),
				),
		};
	}

	private async passivateSession(
		state: ActiveSessionState,
		idleEvictionMinutes: IdleEvictionMinutes,
		now: number,
		selectedSnapshot?: SessionPassivationSnapshot,
	): Promise<boolean> {
		const sessionFile = state.runtime.session.sessionFile;
		const metadata = state.runtime.metadata;
		if (!sessionFile || metadata.kind !== "subagent" || !metadata.rlmChildId || !metadata.parentActiveSessionId) {
			return false;
		}
		const sessionKey = resolve(sessionFile);
		const parentActiveSessionId = metadata.parentActiveSessionId;
		const childId = metadata.rlmChildId;
		const existing = this.passivatingSessions.get(sessionKey);
		if (existing) {
			await existing;
			return false;
		}
		const snapshot = selectedSnapshot ?? (await this.sessionPassivationSnapshot(state));
		if (!canPassivateSession(snapshot, idleEvictionMinutes, now)) return false;

		// Publish the durable identity before running the close so opens and lazy
		// hydration can join throughout closeSessionOnce, including after sessions.delete.
		const passivation = Promise.resolve().then(async () => {
			// Fence against touches and state changes after candidate selection. This
			// snapshot is intentionally fresh rather than reusing the sweep snapshot.
			if (
				this.shuttingDown ||
				this.updateRestart !== undefined ||
				this.sessions.get(state.activeSessionId) !== state ||
				!canPassivateSession(await this.sessionPassivationSnapshot(state), idleEvictionMinutes, now)
			) {
				return;
			}
			const parentState = this.sessions.get(parentActiveSessionId);
			if (!parentState) return;
			const idleMinutes = Math.floor((now - snapshot.lastActivityAt) / 60_000);
			// Detach parent tracking before the standard graceful runtime disposal. The
			// registry/catalog rows remain the sole passive representation after close.
			const unsubscribeChild = parentState.runtime.session.releaseRlmChildSession(childId, state.runtime.session);
			if (!unsubscribeChild) {
				return;
			}
			try {
				await this.closeSession(state, "shutdown", true, false);
			} catch (error) {
				if (
					this.sessions.get(state.activeSessionId) === state &&
					this.sessions.get(parentActiveSessionId) === parentState
				) {
					throw error;
				}
				unsubscribeChild();
				throw error;
			}
			unsubscribeChild();
			this.log(
				`Passivated idle child sessionId=${state.runtime.session.sessionId} name=${JSON.stringify(state.runtime.session.sessionName ?? "")} idleMinutes=${idleMinutes}`,
			);
		});
		this.passivatingSessions.set(sessionKey, passivation);
		try {
			await passivation;
			return this.sessions.get(state.activeSessionId) !== state;
		} finally {
			if (this.passivatingSessions.get(sessionKey) === passivation) {
				this.passivatingSessions.delete(sessionKey);
			}
		}
	}

	/** Last supervisor clock reading plus this side's monotonic anchor for it. */
	private foreignPassivationClock: { wall: number; mono: number } | undefined;

	/**
	 * When each session last logged "idle, but held resident by kernel work". Residency that blocks
	 * a sweep must be attributable (T2②-1) without becoming a line per sweep per session forever.
	 */
	private readonly kernelResidencyLogAt = new Map<string, number>();
	/** Last time an "orphan exit deferred" line was logged (throttle for B2-C07). */
	private orphanExitDeferredLogAt: number | undefined = undefined;

	private async passivateIdleChildren(
		idleEvictionMinutes: IdleEvictionMinutes,
		now: number,
		limit: number,
	): Promise<number> {
		if (this.shuttingDown || this.updateRestart !== undefined || limit <= 0) return 0;
		// `now` is the supervisor's wall clock while the snapshots' activity timestamps are
		// this worker's: clamp the borrowed reading by the monotonic time measured here since
		// the previous sweep, so a forward step on either side cannot evict early.
		const monoNow = performance.now();
		now = clampForeignClockNow(now, this.foreignPassivationClock, monoNow);
		this.foreignPassivationClock = { wall: now, mono: monoNow };
		const states = [...this.sessions.values()];
		const passiveRlmSubagents = await this.listPassiveRlmSubagents();
		const snapshots = await Promise.all(
			states.map(async (state) => ({
				state,
				snapshot: await this.sessionPassivationSnapshot(state, passiveRlmSubagents),
			})),
		);
		this.logKernelPinnedResidency(snapshots, idleEvictionMinutes, now);
		const eligible = snapshots
			.filter(({ snapshot }) => canPassivateSession(snapshot, idleEvictionMinutes, now))
			.sort((left, right) => left.snapshot.lastActivityAt - right.snapshot.lastActivityAt);
		const candidates = eligible.slice(0, limit);
		if (eligible.length > candidates.length) {
			// The per-sweep cap leaving idle children behind used to be silent (B2-C07):
			// one line names how many were skipped so a slow drain is attributable.
			// Bounded by the sweep cadence (at most one line per sweep).
			this.log(
				`child passivation capped: passivating ${candidates.length} of ${eligible.length} idle child session(s) this sweep (limit ${limit})`,
			);
		}
		const results = await Promise.all(
			candidates.map(({ state, snapshot }) => this.passivateSession(state, idleEvictionMinutes, now, snapshot)),
		);
		return results.filter(Boolean).length;
	}

	/**
	 * Name the sessions this sweep would have passivated on age alone but for their live kernel work.
	 *
	 * The idle threshold does not apply to a session whose kernel still owns a `bash()` handle:
	 * passivating it would close the kernel, whose shutdown SIGTERMs that handle's process group, and
	 * the transcript would look perfectly healthy afterwards (r44 form A). The pin is accepted for as
	 * long as the handle lives - a live process is the workload this policy exists to protect - so it
	 * is logged instead of timed out. Same carrier as the whole-worker layer, which reads the fact
	 * inside the summary's `isSessionActive` (folded in summaryForActiveSession) rather than through
	 * this snapshot; the two paths are independent and each has its own lock test.
	 */
	private logKernelPinnedResidency(
		snapshots: readonly { state: ActiveSessionState; snapshot: SessionPassivationSnapshot }[],
		idleEvictionMinutes: IdleEvictionMinutes,
		now: number,
	): void {
		// Bounded: entries only accumulate for sessions that are still resident.
		for (const key of this.kernelResidencyLogAt.keys()) {
			if (!this.sessions.has(key)) this.kernelResidencyLogAt.delete(key);
		}
		for (const { state, snapshot } of snapshots) {
			if (snapshot.hasLiveKernelWork !== true) continue;
			// Attribute only what this rule actually caused: log when the sweep *would* have
			// passivated the session had the kernel term not been there. The inverse test (skip
			// when it would have passivated) reports sessions that are resident for their own
			// reasons - a root session, one idle for only minutes, one held by a cron job or an
			// attached client - as "kept resident for live kernel bash work", which is the
			// misleading forensic this line exists to prevent.
			if (
				!canPassivateSession(
					{
						...snapshot,
						hasLiveKernelWork: false,
						isSessionActive: snapshot.isSessionActiveIgnoringKernelWork ?? snapshot.isSessionActive,
					},
					idleEvictionMinutes,
					now,
				)
			) {
				continue;
			}
			const key = state.activeSessionId;
			const last = this.kernelResidencyLogAt.get(key);
			if (last !== undefined && now - last < KERNEL_RESIDENCY_LOG_GAP_MS) continue;
			this.kernelResidencyLogAt.set(key, now);
			this.log(
				`Kept idle child resident for live kernel bash work sessionId=${state.runtime.session.sessionId} name=${JSON.stringify(state.runtime.session.sessionName ?? "")} idleMinutes=${Math.floor((now - snapshot.lastActivityAt) / 60_000)}`,
			);
		}
	}

	private findPassivationBySessionFile(sessionFile: string): Promise<void> | undefined {
		return this.passivatingSessions.get(resolve(sessionFile));
	}

	private async waitForPassivation(sessionFile: string): Promise<void> {
		const passivation = this.findPassivationBySessionFile(sessionFile);
		if (!passivation) return;
		// Bounded (P1-1). The passivation is never cancelled - a half-written session file is
		// worse than a slow one, and the next caller joins the same in-flight promise - but the
		// caller gets a factual, retryable error instead of parking for as long as the client
		// request that triggered it lives.
		await withBound(
			passivation.catch(() => {}),
			{
				timeoutMs: this.agentMessageWaits().passivationMs,
				phase: "passivation",
				target: sessionFile,
				label: "Session target",
				targetState: () => `${sessionFile} is still being passivated`,
				onTimeout: (facts) => this.logAgentMessageWaitTimeout(facts),
			},
		);
	}

	/**
	 * Wait tiers for a transitional message target, read from disk on every wait so an operator
	 * editing settings.json is honoured by the next one (C14/F17).
	 */
	private agentMessageWaits(): ResolvedAgentMessageWaitSettings {
		return readAgentMessageWaitSettings(this.options.defaultSessionConfig.cwd ?? process.cwd(), this.agentDir);
	}

	/** The countable signature for a bounded wait that ran out of time, with its waitedMs sample. */
	private logAgentMessageWaitTimeout(facts: WaitTimeoutFacts): void {
		const state = facts.targetState === undefined ? "" : ` state="${facts.targetState}"`;
		this.log(
			`agent message target wait timed out (target=${facts.target} phase=${facts.phase} waitedMs=${facts.waitedMs}${state})`,
		);
	}

	private async hydratePassiveRlmSubagent(
		passive: PassiveRlmSubagent,
		clientEnv?: Record<string, string>,
	): Promise<ActiveSessionState> {
		if (this.updateRestart !== undefined) {
			throw new BoundSessionUnavailableError("Daemon is preparing an update restart");
		}
		const isResident = (state: ActiveSessionState): boolean =>
			this.sessions.get(state.activeSessionId) === state && !this.closingSessions.has(state.activeSessionId);
		const restartAfterParentChange = async (staleParent: ActiveSessionState): Promise<ActiveSessionState> => {
			const staleParentFile = staleParent.runtime.session.sessionFile;
			if (staleParentFile) await this.waitForPassivation(staleParentFile);
			const refreshed = await this.findPassiveRlmSubagent(passive.entry.sessionFile, true);
			if (!refreshed) throw new RuntimeOpenCancelledError();
			const resident = this.findSessionBySessionFile(passive.entry.sessionFile);
			if (
				resident &&
				resident.runtime.metadata.kind === "subagent" &&
				resident.runtime.metadata.rlmChildId === passive.entry.childId
			) {
				return this.waitForBoundSession(resident);
			}
			return this.hydratePassiveRlmSubagent(refreshed, clientEnv);
		};
		const rootParent = passive.rootParentState;
		if (!rootParent) {
			throw new Error(`Cannot hydrate RLM subagent ${passive.entry.childId} without a resident root parent`);
		}
		const rootParentFile = rootParent.runtime.session.sessionFile;
		if (rootParentFile) await this.waitForPassivation(rootParentFile);
		if (!isResident(rootParent)) {
			return restartAfterParentChange(rootParent);
		}
		let parentState = rootParent;
		for (const entry of passive.chain) {
			await this.waitForPassivation(entry.sessionFile);
			if (!isResident(parentState)) {
				return restartAfterParentChange(parentState);
			}
			const hydratingParent = parentState;
			const activeSessionId = entry === passive.entry ? passive.info.id : undefined;
			let hydrated: ActiveSessionState;
			try {
				hydrated = await this.rehydrateCompletedRlmSubagent(hydratingParent, entry, activeSessionId, clientEnv);
			} catch (error) {
				const passivation = this.findPassivationBySessionFile(entry.sessionFile);
				if (error instanceof BoundSessionUnavailableError && passivation) {
					await passivation.catch(() => {});
					return restartAfterParentChange(hydratingParent);
				}
				if (isResident(hydratingParent)) throw error;
				return restartAfterParentChange(hydratingParent);
			}
			if (!isResident(hydratingParent)) {
				return restartAfterParentChange(hydratingParent);
			}
			if (!isResident(hydrated)) {
				return restartAfterParentChange(hydrated);
			}
			parentState = hydrated;
		}
		return parentState;
	}

	private async rehydrateCompletedRlmSubagent(
		parentState: ActiveSessionState,
		entry: PassiveRlmSubagentEntry,
		restoreActiveSessionId?: string,
		clientEnv?: Record<string, string>,
		attempts?: AttemptBudget,
	): Promise<ActiveSessionState> {
		if (this.updateRestart !== undefined) {
			throw new BoundSessionUnavailableError("Daemon is preparing an update restart");
		}
		// Both re-entries below are legitimate contention - another caller holds the reservation,
		// or published a different child under the same path - so neither can be told apart from a
		// loop by looking at one step. The budget is the mechanical ceiling: 32 attempts *and* a
		// total deadline, deliberately not derived from RLM_MAX_DEPTH, which counts agent
		// generations and would cap a hydration at four re-entries (M19).
		const budget = attempts ?? createAttemptBudget(REHYDRATE_MAX_ATTEMPTS, this.agentMessageWaits().hydrateMs);
		const reentryContext = { phase: "hydrate", target: entry.childId };
		const sessionKey = resolve(entry.sessionFile);
		const reservation = this.reservingSessionOpens.get(sessionKey);
		if (reservation) {
			consumeAttempt(budget, reentryContext);
			await reservation;
			return this.rehydrateCompletedRlmSubagent(parentState, entry, restoreActiveSessionId, clientEnv, budget);
		}
		const pending = this.openingSessions.get(sessionKey);
		if (pending) {
			const state = await pending;
			if (state.runtime.metadata.kind !== "subagent" || state.runtime.metadata.rlmChildId !== entry.childId) {
				consumeAttempt(budget, reentryContext);
				if (this.openingSessions.get(sessionKey) === pending) this.openingSessions.delete(sessionKey);
				return this.rehydrateCompletedRlmSubagent(parentState, entry, restoreActiveSessionId, clientEnv, budget);
			}
			return this.waitForBoundSession(state);
		}
		const existing = this.findSessionBySessionFile(entry.sessionFile);
		if (existing?.runtime.metadata.kind === "subagent" && existing.runtime.metadata.rlmChildId === entry.childId) {
			return this.waitForBoundSession(existing);
		}
		const hydration = (async () => {
			if (existing) {
				await this.closeSession(existing, "replaced");
			}
			return this.rehydrateCompletedRlmSubagentOnce(parentState, entry, restoreActiveSessionId, clientEnv);
		})();
		// Explicit opens and all lazy triggers share this path-keyed publication,
		// so no caller can acquire a second lease/runtime while hydration binds.
		this.openingSessions.set(sessionKey, hydration);
		try {
			return await hydration;
		} finally {
			if (this.openingSessions.get(sessionKey) === hydration) {
				this.openingSessions.delete(sessionKey);
			}
		}
	}

	private async waitForBoundSession(state: ActiveSessionState): Promise<ActiveSessionState> {
		const completion = this.bindingCompletions.get(state.activeSessionId);
		if (completion) {
			// Bounded (P1-1): the bind keeps running, and a caller that ran out of patience gets a
			// retryable fact naming the session instead of riding out the client's own timeout.
			await withBound(completion, {
				timeoutMs: this.agentMessageWaits().bindMs,
				phase: "bind",
				target: state.activeSessionId,
				label: "Session target",
				targetState: () => `session ${state.activeSessionId} is still binding`,
				onTimeout: (facts) => this.logAgentMessageWaitTimeout(facts),
			});
		}
		if (this.sessions.get(state.activeSessionId) !== state || this.bindingSessions.has(state.activeSessionId)) {
			throw new BoundSessionUnavailableError(`Active session ${state.activeSessionId} did not finish initializing`);
		}
		if (this.closingSessions.has(state.activeSessionId)) {
			throw new BoundSessionUnavailableError(`Active session ${state.activeSessionId} is closing`);
		}
		return state;
	}

	private async rehydrateCompletedRlmSubagentOnce(
		parentState: ActiveSessionState,
		entry: PassiveRlmSubagentEntry,
		restoreActiveSessionId?: string,
		clientEnv?: Record<string, string>,
	): Promise<ActiveSessionState> {
		const hydrationEnv = parentState.clientEnv ?? clientEnv;
		let stateRef: ActiveSessionState | undefined;
		let runtime: AgentSessionRuntime | undefined;
		let sessionLease: SessionLease | undefined;
		try {
			sessionLease = await acquireSessionLeaseAsync(entry.sessionFile, parentState.runtime.services.agentDir);
			// This runtime takes over writing the child transcript: repair under the lease.
			repairOwnedSessionFile(entry.sessionFile);
			const sessionManager = await SessionManager.openAsync(entry.sessionFile, entry.sessionDir);
			const modelRegistry = parentState.runtime.services.modelRegistry;
			let rehydratedModel: Model<Api> | undefined;
			if (entry.model) {
				const resolved = modelRegistry.find(entry.model.provider, entry.model.modelId);
				if (resolved && (await modelRegistry.canUseModel(resolved))) {
					rehydratedModel = resolved;
				}
			}
			runtime = await withClientEnv(hydrationEnv, () =>
				createAgentSessionRuntime(this.options.createRuntime, {
					cwd: sessionManager.getCwd(),
					agentDir: parentState.runtime.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "startup" },
					sessionConfig: parentState.runtime.runtimeConfig,
					sessionLease,
					sessionOptions: {
						...(rehydratedModel ? { model: rehydratedModel } : {}),
						agentMessageController: this.createAgentMessageController(() => stateRef),
						agentObserveController: this.createAgentObserveController(() => stateRef),
						rlmHeartbeatController: {
							listRlmHeartbeats: (listOptions) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.cronStore.listRlmHeartbeats(stateRef.activeSessionId, listOptions);
							},
							createRlmHeartbeat: (input) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.createRlmHeartbeatForState(stateRef, input);
							},
							updateRlmHeartbeat: (input) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.updateRlmHeartbeatForState(stateRef, input);
							},
							deleteRlmHeartbeat: (id) => {
								if (!stateRef) {
									throw new Error("RLM heartbeat state is not ready for this session yet");
								}
								return this.deleteRlmHeartbeatForState(stateRef, id);
							},
						},
						rlmSessionDir: entry.sessionDir,
						// Registry depth is authoritative (written at spawn); for legacy entries
						// without it, the shared accessor resolves persisted header depth or the
						// session file's sub- path before the depth-1 default.
						rlmDepth:
							entry.rlmDepth ??
							(existsSync(entry.sessionFile)
								? resolveSessionRlmDepth(sessionManager.getHeader() ?? {}, entry.sessionFile)
								: 1),
						rlmMaxDepth: entry.rlmMaxDepth,
						rlmParentNodeId: entry.rlmParentNodeId ?? entry.childId,
					},
					runtimeMetadata: {
						kind: "subagent",
						createdAt: entry.createdAt,
						parentActiveSessionId: parentState.activeSessionId,
						parentSessionId: parentState.runtime.session.sessionId,
						...(parentState.runtime.session.sessionFile
							? { parentSessionFile: parentState.runtime.session.sessionFile }
							: {}),
						rlmChildId: entry.childId,
						rlmParentNodeId: entry.rlmParentNodeId ?? entry.childId,
						rehydratedCompleted: true,
						...(entry.prompt ? { prompt: entry.prompt } : {}),
						...(entry.spawnCode ? { spawnCode: entry.spawnCode } : {}),
						sessionDir: entry.sessionDir,
					},
				}),
			);
			const state = await this.addRuntime(
				runtime,
				undefined,
				hydrationEnv,
				(createdState) => {
					stateRef = createdState;
				},
				undefined,
				undefined,
				restoreActiveSessionId,
			);
			// The session transcript is authoritative for mutable metadata such as a
			// later user-assigned name; the registry value is only the spawn snapshot.
			if (!parentState.runtime.session.registerRlmChildSession(entry.childId, runtime.session)) {
				await this.closeSession(state, "replaced");
				throw new RuntimeOpenCancelledError();
			}
			if (
				this.sessions.get(parentState.activeSessionId) !== parentState ||
				this.closingSessions.has(parentState.activeSessionId)
			) {
				const unsubscribeChild = parentState.runtime.session.releaseRlmChildSession(entry.childId, runtime.session);
				try {
					await this.closeSession(state, "replaced");
				} finally {
					if (unsubscribeChild) {
						unsubscribeChild();
					}
				}
				throw new RuntimeOpenCancelledError();
			}
			return state;
		} catch (error) {
			if (stateRef && this.sessions.get(stateRef.activeSessionId) === stateRef) {
				await this.closeSession(stateRef, "completed").catch(() => undefined);
			} else {
				await runtime?.dispose().catch(() => undefined);
			}
			sessionLease?.release();
			throw error;
		}
	}

	private createAgentMessageController(
		getCurrentState: () => ActiveSessionState | undefined,
	): AgentSessionMessageController {
		const requireCurrentState = () => {
			const current = getCurrentState();
			if (!current) {
				throw new Error("Agent message state is not ready for this session yet");
			}
			return current;
		};
		return {
			listAgents: () => this.createAgentMessageListResult(requireCurrentState()),
			// One directory, two entries: this roster is the observe-owned family directory
			// (the very call `agent_observe.list_agents()` renders), projected into the legacy
			// roster shape so every existing caller keeps working unchanged.
			roster: async () =>
				buildAgentFamilyRosterFromDirectory(
					await this.createAgentObserveController(requireCurrentState).familyDirectory!(),
				),
			assertSessionNameAvailable: (input) => this.assertFamilySessionNameAvailable(input),
			setSessionName: (name) => this.setStateSessionNameViaSupervisor(requireCurrentState(), name),
			sendAgentMessage: (input) =>
				this.sendAgentSessionMessage({
					targetSelector: input.target,
					message: input.message,
					fromState: requireCurrentState(),
					origin: "agent",
				}),
		};
	}

	private createAgentObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController {
		const requireCurrentState = () => {
			const current = getCurrentState();
			if (!current) {
				throw new Error("Agent observe state is not ready for this session yet");
			}
			return current;
		};
		return {
			listAgents: () => this.createAgentObserveListResult(requireCurrentState()),
			familyDirectory: () => this.createAgentFamilyDirectory(requireCurrentState()),
			getAgent: (target) => this.createAgentObserveAgentSnapshot(requireCurrentState(), target),
			recentMessages: (input) => this.createAgentObserveRecentMessages(requireCurrentState(), input),
		};
	}

	private async createAgentObserveListResult(currentState: ActiveSessionState): Promise<AgentObserveListResult> {
		// Membership comes from the one family directory that `send` resolves targets
		// against, so the observe list and the agent_message roster cannot disagree. A
		// member with no live session here still gets a row, reported from persisted facts.
		const directory = await this.createAgentFamilyDirectory(currentState);
		const residentBySessionId = new Map(
			this.listTargetableSessionStates(currentState).map((state) => [state.runtime.session.sessionId, state]),
		);
		return createAgentObserveFamilyList({
			current: this.createAgentObserveSummary(currentState, currentState),
			directory,
			liveSummary: (member) => {
				const state = residentBySessionId.get(member.entry.id);
				return state ? this.createAgentObserveSummary(state, currentState) : undefined;
			},
		});
	}

	private async createAgentObserveAgentSnapshot(
		currentState: ActiveSessionState,
		target: string,
	): Promise<AgentObserveAgentSnapshot> {
		const targetState = await this.getOrHydrateAuthorizedAgentFamilyTarget(currentState, target);
		this.assertAgentFamilyReachable(currentState, targetState);
		return {
			agent: this.createAgentObserveSummary(targetState, currentState),
		};
	}

	private async createAgentObserveRecentMessages(
		currentState: ActiveSessionState,
		input: AgentObserveRecentMessagesInput,
	): Promise<AgentObserveRecentMessagesResult> {
		const targetState = await this.getOrHydrateAuthorizedAgentFamilyTarget(currentState, input.target);
		this.assertAgentFamilyReachable(currentState, targetState);
		const limit = normalizeObserveLimit(input.limit);
		const maxChars = normalizeObserveMaxChars(input.maxChars);
		const messages = targetState.runtime.session.messages;
		const startIndex = Math.max(0, messages.length - limit);
		return {
			agent: this.createAgentObserveSummary(targetState, currentState),
			messages: messages
				.slice(startIndex)
				.map((message, offset) => createAgentObserveMessagePreview(message, startIndex + offset, maxChars)),
			limit,
			maxChars,
			truncated: startIndex > 0,
		};
	}

	private createAgentObserveSummary(
		state: ActiveSessionState,
		currentState: ActiveSessionState,
	): AgentObserveAgentSummary {
		const summary = summaryForActiveSession(state);
		const session = state.runtime.session;
		const messages = session.messages;
		const latest = messages.at(-1);
		const status = session.isStreaming
			? session.state.pendingToolCalls.size > 0
				? "tool"
				: "model"
			: session.isCompacting
				? "compacting"
				: session.isSessionActive || session.hasRunningRlmChildren()
					? "busy"
					: state.clients.size > 0
						? "user"
						: "idle";
		return {
			activeSessionId: state.activeSessionId,
			sessionId: summary.sessionId,
			...(summary.sessionName ? { sessionName: summary.sessionName } : {}),
			...(summary.runtimeKind ? { runtimeKind: summary.runtimeKind } : {}),
			cwd: summary.cwd,
			status,
			isCurrent: state.activeSessionId === currentState.activeSessionId,
			isStreaming: summary.isStreaming,
			isCompacting: summary.isCompacting,
			attachedClients: summary.attachedClients,
			messageCount: summary.messageCount,
			queuedCount: summary.sessionActions.queuedCount,
			isSessionActive: summary.isSessionActive,
			...(summary.parentActiveSessionId ? { parentActiveSessionId: summary.parentActiveSessionId } : {}),
			...(summary.parentSessionId ? { parentSessionId: summary.parentSessionId } : {}),
			...(summary.rlmChildId ? { rlmChildId: summary.rlmChildId } : {}),
			...(summary.rlmParentNodeId ? { rlmParentNodeId: summary.rlmParentNodeId } : {}),
			...(summary.firstMessage ? { firstMessage: summary.firstMessage } : {}),
			...(latest
				? {
						latestMessage: createAgentObserveMessagePreview(
							latest,
							messages.length - 1,
							AGENT_OBSERVE_PREVIEW_MAX_CHARS,
						),
					}
				: {}),
		};
	}

	private handleConnection(socket: Socket): void {
		const client: DaemonSocketClient = {
			id: createActiveSessionId(),
			socket,
			attachedActiveSessionIds: new Set(),
			catchupActiveSessionIds: new Set(),
			backpressured: false,
			authenticated: this.options.worker === undefined,
			transport: this.options.worker ? "private-framed" : "jsonl",
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(DAEMON_DEFAULT_CLIENT_CAPABILITIES),
		};
		this.clients.add(client);
		this.write(client, {
			type: "daemon_hello",
			socketPath: this.socketPath,
			protocol: DAEMON_PROTOCOL_INFO,
			schemaId: DAEMON_SCHEMA_ID,
			schemaRevision: DAEMON_SCHEMA_REVISION,
			appVersion: VERSION,
			runtime: getDaemonRuntimeIdentity(),
			clientId: client.id,
			serverCapabilities: DAEMON_DEFAULT_SERVER_CAPABILITIES,
		});

		if (client.transport === "private-framed") {
			const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
			const onData = (chunk: Buffer) => {
				try {
					for (const frame of decoder.push(chunk)) {
						if (frame.header.kind === "command") {
							void this.handleLine(client, frame.payload.toString("utf8"));
						}
					}
				} catch (error) {
					socket.destroy(error instanceof Error ? error : new Error(String(error)));
				}
			};
			const onEnd = () => {
				try {
					decoder.finish();
				} catch (error) {
					socket.destroy(error instanceof Error ? error : new Error(String(error)));
				}
			};
			socket.on("data", onData);
			socket.on("end", onEnd);
			client.detachInput = () => {
				socket.off("data", onData);
				socket.off("end", onEnd);
			};
		} else {
			client.detachInput = attachJsonlLineReader(
				socket,
				(line) => {
					void this.handleLine(client, line);
				},
				{
					maxLineLength: DAEMON_COMMAND_MAX_LINE_BYTES,
					onLineOverflow: () => {
						// Bounded like the supervisor's command reader and the private
						// frame transport: an over-long line is dropped with the
						// connection instead of buffered without limit.
						this.log(
							`Destroyed client connection ${client.id}: a command line exceeded ${DAEMON_COMMAND_MAX_LINE_BYTES} bytes`,
						);
						socket.destroy(new Error("Daemon command line too long"));
					},
				},
			);
		}

		let cleanedUp = false;
		const cleanup = () => {
			if (cleanedUp) {
				return;
			}
			cleanedUp = true;
			socket.off("close", cleanup);
			socket.off("error", cleanup);
			this.clearClientCatchupRetry(client);
			for (const [pauseId, entry] of this.sessionInputPauses) {
				if (entry.owner !== client) continue;
				entry.pause.release();
				this.sessionInputPauses.delete(pauseId);
			}
			this.detachClient(client);
			client.detachInput();
			this.clients.delete(client);
			this.peerClaims.delete(client);
			// The fence check revokes a stale claim before ending the socket; the role survives.
			const wasSupervisor = client.authenticationRole === "supervisor";
			this.revokeSupervisorClaim(client);
			const supervisorSocketPath = this.supervisorSocketPathFromEnv();
			if (this.options.worker && wasSupervisor && supervisorSocketPath) {
				this.scheduleSupervisorAvailabilityCheck(supervisorSocketPath, 100);
			}
		};
		socket.on("close", cleanup);
		socket.on("error", cleanup);
		socket.on("drain", () => {
			client.backpressured = false;
			if (!client.snapshotStreaming) {
				void this.catchUpBackpressuredClient(client).catch((error) =>
					this.log(`could not catch up snapshot client ${client.id}: ${String(error)}`),
				);
			}
		});
	}

	private promptAdmissionKey(activeSessionId: string, admissionId: string): string {
		return `${activeSessionId}\0${admissionId}`;
	}

	/**
	 * Parse and synchronously register prompt admission before returning a promise.
	 * This method is intentionally non-async: handleLine invokes it before its first await.
	 */
	private parseCommandAndRegisterPromptAdmission(client: DaemonSocketClient, line: string): unknown {
		const wireValue = JSON.parse(line) as unknown;
		if (isDaemonCommandEnvelope(wireValue) && wireValue.clientId) client.id = wireValue.clientId;
		const parsed = (isDaemonCommandEnvelope(wireValue) ? { ...wireValue.command, id: wireValue.id } : wireValue) as {
			type?: unknown;
			activeSessionId?: unknown;
			admissionId?: unknown;
		};
		if (parsed.type === "prompt" || parsed.type === "prompt_and_wait") {
			if (parsed.admissionId !== undefined) {
				if (typeof parsed.activeSessionId !== "string" || typeof parsed.admissionId !== "string") {
					throw new Error("Prompt admission requires string activeSessionId and admissionId");
				}
				if (parsed.admissionId === "") throw new Error("admissionId must not be empty");
				const key = this.promptAdmissionKey(parsed.activeSessionId, parsed.admissionId);
				if (this.promptAdmissions.has(key)) {
					throw new Error(`Prompt admission id is already in use: ${parsed.admissionId}`);
				}
				this.promptAdmissions.set(key, {
					activeSessionId: parsed.activeSessionId,
					admissionId: parsed.admissionId,
					controller: new AbortController(),
					status: "waiting",
				});
			}
		}
		return parsed;
	}

	private async handleLine(client: DaemonSocketClient, line: string): Promise<void> {
		let command: DaemonCommand;
		let clearParsedAdmission = () => {};
		let promptHandlerOwnsAdmission = false;
		try {
			const parsed = this.parseCommandAndRegisterPromptAdmission(client, line) as {
				id?: unknown;
				type?: unknown;
				token?: unknown;
				grantId?: unknown;
				workerInstanceId?: unknown;
				purpose?: unknown;
				supervisorGeneration?: unknown;
				supervisorPid?: unknown;
				supervisorProcessStartId?: unknown;
				supervisorSocketPath?: unknown;
				activeSessionId?: unknown;
				admissionId?: unknown;
				capabilities?: unknown;
				supportsExtensionUi?: unknown;
				job?: unknown;
			};
			const parsedAdmission =
				(parsed.type === "prompt" || parsed.type === "prompt_and_wait") &&
				typeof parsed.activeSessionId === "string" &&
				typeof (parsed as { admissionId?: unknown }).admissionId === "string"
					? this.promptAdmissions.get(
							this.promptAdmissionKey(parsed.activeSessionId, (parsed as { admissionId: string }).admissionId),
						)
					: undefined;
			clearParsedAdmission = () => {
				if (!parsedAdmission) return;
				const key = this.promptAdmissionKey(parsedAdmission.activeSessionId, parsedAdmission.admissionId);
				if (this.promptAdmissions.get(key) === parsedAdmission) {
					this.promptAdmissions.delete(key);
				}
			};
			// Envelope client identity is irrelevant to worker-local prompt admission.
			// Public supervisor authentication has already bound this socket's identity.
			if (this.options.worker && client.authenticated !== true) {
				const commandId = typeof parsed.id === "string" ? parsed.id : undefined;
				if (parsed.type === "peer_auth") {
					// Single use: the grant is burned before its token is checked.
					const grant = typeof parsed.grantId === "string" ? this.peerGrants.get(parsed.grantId) : undefined;
					if (typeof parsed.grantId === "string") this.peerGrants.delete(parsed.grantId);
					const presentedTokenHash =
						typeof parsed.token === "string" ? createHash("sha256").update(parsed.token).digest() : undefined;
					const expectedTokenHash = grant ? createHash("sha256").update(grant.token).digest() : undefined;
					const expiresAt = grant ? Date.parse(grant.expiresAt) : Number.NaN;
					if (
						this.peerAdmissionsFenced ||
						!grant ||
						!presentedTokenHash ||
						!expectedTokenHash ||
						!timingSafeEqual(presentedTokenHash, expectedTokenHash) ||
						parsed.workerInstanceId !== grant.workerInstanceId ||
						parsed.purpose !== grant.purpose ||
						!Number.isFinite(expiresAt) ||
						expiresAt <= Date.now()
					) {
						clearParsedAdmission();
						this.write(client, failure(commandId, "peer_auth", "Peer authentication failed"));
						client.socket.end();
						return;
					}
					client.authenticated = true;
					client.authenticationRole = "session_client";
					this.peerClaims.set(client, grant);
					this.write(client, {
						id: commandId,
						type: "response",
						command: "peer_auth",
						success: true,
						data: {
							workerInstanceId: grant.workerInstanceId,
							activeSessionId: grant.activeSessionId,
							purpose: grant.purpose,
						},
					});
					return;
				}
				if (
					parsed.type !== "worker_auth" ||
					parsed.token !== this.options.worker.authenticationToken ||
					// Enforced only when presented: a downgraded (pre-instance-id) supervisor must still adopt live workers.
					(parsed.workerInstanceId !== undefined &&
						parsed.workerInstanceId !== this.options.worker.workerInstanceId) ||
					typeof parsed.supervisorGeneration !== "string" ||
					!Number.isInteger(parsed.supervisorPid) ||
					(parsed.supervisorPid as number) <= 0 ||
					(parsed.supervisorProcessStartId !== undefined && typeof parsed.supervisorProcessStartId !== "string") ||
					typeof parsed.supervisorSocketPath !== "string"
				) {
					clearParsedAdmission();
					this.write(client, failure(commandId, "worker_auth", "Worker authentication failed"));
					client.socket.end();
					return;
				}
				const claim: SupervisorGenerationClaim = {
					supervisorGeneration: parsed.supervisorGeneration,
					supervisorPid: parsed.supervisorPid as number,
					...(typeof parsed.supervisorProcessStartId === "string"
						? { supervisorProcessStartId: parsed.supervisorProcessStartId }
						: {}),
					supervisorSocketPath: parsed.supervisorSocketPath,
				};
				let ownerFingerprint: string;
				try {
					ownerFingerprint = await this.assertSupervisorClaimCurrent(claim);
				} catch {
					this.write(client, failure(commandId, "worker_auth", "supervisor_generation_stale"));
					client.socket.end();
					return;
				}
				for (const previous of this.supervisorClaims.keys()) {
					if (previous !== client) {
						this.revokeSupervisorClaim(previous);
						previous.socket.end();
					}
				}
				client.authenticated = true;
				client.authenticationRole = "supervisor";
				this.supervisorClaims.set(client, { claim, ownerFingerprint });
				this.clearSupervisorAvailabilityCheck();
				this.scheduleSupervisorFenceCheck();
				this.write(client, {
					id: commandId,
					type: "response",
					command: "worker_auth",
					success: true,
					data: {
						capabilities: [
							DAEMON_WORKER_ROSTER_CAPABILITY,
							...(this.options.worker.workerInstanceId !== undefined
								? [DAEMON_WORKER_PEER_TRANSPORT_CAPABILITY]
								: []),
						],
					},
				});
				this.rosterReporter.snapshotPending = true;
				this.scheduleRosterFlush();
				return;
			}
			const peerClaim = this.options.worker ? this.peerClaims.get(client) : undefined;
			if (peerClaim) {
				const commandId = typeof parsed.id === "string" ? parsed.id : undefined;
				const commandName = typeof parsed.type === "string" ? parsed.type : "unknown";
				// Reachable only through shutdown, which fences admissions without ending live peers.
				if (this.peerAdmissionsFenced) {
					clearParsedAdmission();
					this.write(client, failure(commandId, commandName, "Direct peer transport is fenced"));
					return;
				}
				if (
					typeof parsed.type !== "string" ||
					!isSessionPlaneDaemonCommand(parsed.type) ||
					parsed.activeSessionId !== peerClaim.activeSessionId
				) {
					clearParsedAdmission();
					this.write(
						client,
						failure(commandId, commandName, "Command is not allowed on this direct peer transport"),
					);
					return;
				}
			} else if (this.options.worker) {
				const boundClaim = this.supervisorClaims.get(client);
				if (!boundClaim) {
					clearParsedAdmission();
					this.write(
						client,
						failure(
							typeof parsed.id === "string" ? parsed.id : undefined,
							"worker_auth",
							"supervisor_generation_stale",
						),
					);
					client.socket.end();
					return;
				}
				const claimCheck = this.assertSupervisorClaimCurrent(boundClaim.claim, boundClaim.ownerFingerprint);
				// Observe the already-running fence check even if admission cancellation
				// wins the command wait below.
				void claimCheck.catch(() => {});
				try {
					const ownerFingerprint = await waitForPromptAdmission(claimCheck, parsedAdmission?.controller?.signal);
					if (this.supervisorClaims.get(client) !== boundClaim || client.socket.destroyed) {
						clearParsedAdmission();
						return;
					}
					boundClaim.ownerFingerprint = ownerFingerprint;
				} catch (error) {
					const admissionCancelled = error instanceof PromptAdmissionCancelledError;
					if (admissionCancelled) {
						// The fence check remains authoritative after cancellation. Its rejection
						// revokes only the exact binding that initiated it; replacements survive.
						void claimCheck.catch(() => {
							if (this.revokeSupervisorClaim(client, boundClaim)) client.socket.end();
						});
					}
					clearParsedAdmission();
					if (this.supervisorClaims.get(client) !== boundClaim || client.socket.destroyed) return;
					this.write(
						client,
						failure(
							typeof parsed.id === "string" ? parsed.id : undefined,
							typeof parsed.type === "string" ? parsed.type : "worker_auth",
							admissionCancelled ? error : "supervisor_generation_stale",
						),
					);
					// Cancelling this prompt only abandons its admission wait. A genuine
					// stale supervisor claim fences only the binding that it checked.
					if (!admissionCancelled && this.revokeSupervisorClaim(client, boundClaim)) {
						client.socket.end();
					}
					return;
				}
			}
			if (this.options.worker && typeof parsed.type === "string" && parsed.type.startsWith("worker_")) {
				const workerCommand = parsed as DaemonWorkerCommand;
				const updateLifecycle =
					workerCommand.type === "worker_prepare_update" ||
					workerCommand.type === "worker_commit_update" ||
					workerCommand.type === "worker_cancel_update";
				if (this.updateRestart && !updateLifecycle) {
					this.write(
						client,
						failure(workerCommand.id, workerCommand.type, "Daemon is preparing an update restart"),
					);
					return;
				}
				if (!updateLifecycle) this.mutationDrain.begin();
				try {
					await this.handleWorkerCommand(client, workerCommand);
				} finally {
					if (!updateLifecycle) this.mutationDrain.end();
				}
				return;
			}

			if (typeof parsed.type !== "string" || !DAEMON_COMMAND_TYPES.has(parsed.type)) {
				const commandName = typeof parsed.type === "string" ? parsed.type : "unknown";
				const commandId = typeof parsed.id === "string" ? parsed.id : undefined;
				this.write(client, failure(commandId, commandName, `Unknown daemon command: ${commandName}`));
				return;
			}
			command = parsed as DaemonCommand;
		} catch (error) {
			this.write(client, failure(salvageDaemonCommandId(line), "parse", error, serializeDaemonError(error)));
			return;
		}

		const missingCapability = missingDeclaredCommandCapability(
			client.declaredCapabilities,
			client.declaredCommandCapabilities,
			command,
		);
		if (missingCapability !== undefined) {
			clearParsedAdmission();
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

		const mutation = command.type !== "prepare_update_restart" && isDaemonMutatingCommand(command);
		const restartPhase = this.updateRestart?.phase;
		// Mirror the supervisor's drain/fence split: abort-style commands stay
		// admitted only while mutations drain; once the checkpoint is being
		// captured they could race the snapshot and are rejected too.
		const restartRejected =
			restartPhase === "preparing"
				? !UPDATE_RESTART_DRAIN_COMMANDS.has(command.type)
				: restartPhase !== undefined && command.type !== "shutdown";
		if (mutation && restartRejected) {
			clearParsedAdmission();
			this.write(client, failure(command.id, command.type, "Daemon is preparing an update restart"));
			return;
		}
		if (mutation) this.mutationDrain.begin();
		try {
			const response = await this.handleCommand(client, command, () => {
				promptHandlerOwnsAdmission = true;
			});
			if (response) {
				this.write(client, response);
			}
		} catch (error) {
			// Only the error message reaches the client (serializeDaemonError drops
			// the rest), so log the full stack here — this is the one place a handler
			// crash like a RangeError from a pathological session is recoverable.
			this.log(
				`daemon command "${command.type}" failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
			);
			this.write(client, failure(command.id, command.type, error, serializeDaemonError(error)));
		} finally {
			if (!promptHandlerOwnsAdmission) clearParsedAdmission();
			if (mutation) this.mutationDrain.end();
		}
	}

	private writeWorkerSuccess(client: DaemonSocketClient, command: DaemonWorkerCommand, data?: unknown): void {
		this.write(client, {
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			...(data !== undefined ? { data } : {}),
		});
	}

	private async handleWorkerCommand(client: DaemonSocketClient, command: DaemonWorkerCommand): Promise<void> {
		try {
			switch (command.type) {
				case "worker_auth":
					this.write(client, failure(command.id, command.type, "Worker is already authenticated"));
					return;
				case "worker_register_peer_transport": {
					const grant = command.grant;
					const boundClaim = this.supervisorClaims.get(client);
					const expiresAt = Date.parse(grant.expiresAt);
					const now = Date.now();
					for (const [grantId, pending] of this.peerGrants) {
						if (Date.parse(pending.expiresAt) < now) this.peerGrants.delete(grantId);
					}
					if (
						this.peerAdmissionsFenced ||
						!boundClaim ||
						grant.issuerGeneration !== boundClaim.claim.supervisorGeneration ||
						grant.purpose !== "session_client" ||
						!grant.grantId ||
						!grant.token ||
						grant.workerInstanceId !== this.options.worker?.workerInstanceId ||
						!this.sessions.has(grant.activeSessionId) ||
						this.peerGrants.size >= PEER_GRANT_LIMIT ||
						!Number.isFinite(expiresAt) ||
						expiresAt <= now ||
						expiresAt - now > PEER_GRANT_TTL_LIMIT_MS
					) {
						this.write(client, failure(command.id, command.type, "Peer transport grant is invalid"));
						return;
					}
					this.peerGrants.set(grant.grantId, grant);
					this.writeWorkerSuccess(client, command);
					return;
				}
				case "worker_subscribe": {
					const state = this.getBoundSessionState(command.activeSessionId);
					setDaemonClientSessionCapabilities(
						client,
						state.activeSessionId,
						normalizeClientCapabilities(command.capabilities, command.supportsExtensionUi),
					);
					state.clients.add(client);
					client.attachedActiveSessionIds.add(state.activeSessionId);
					this.write(client, success(command.id, "attach", summaryForActiveSession(state)));
					return;
				}
				case "worker_unsubscribe": {
					const state = this.getSessionState(command.activeSessionId);
					this.detachClientFromSession(client, state);
					this.write(client, success(command.id, "detach"));
					return;
				}
				case "worker_archive_and_shutdown": {
					// Close sessions first so direct peers read session_closed "killed", not a daemon shutdown.
					for (const state of [...this.sessions.values()]) {
						await this.closeSession(state, "killed");
					}
					this.fencePeerTransports();
					this.writeWorkerSuccess(client, command);
					setImmediate(() => void this.shutdown(0));
					return;
				}
				case "worker_passivate_idle_children": {
					const count = await this.passivateIdleChildren(command.idleEvictionMinutes, command.now, command.limit);
					this.writeWorkerSuccess(client, command, { count });
					return;
				}
				case "worker_deliver_message": {
					const receipt = await this.sendAgentSessionMessage({
						targetSelector: command.targetActiveSessionId,
						message: command.message,
						sender: command.sender,
						senderKey: command.sender.activeSessionId ?? `client:${command.sender.clientId}`,
						// K3L-1: the supervisor computed the relationship because the
						// sender's session lives in another worker; without it this send
						// reported no relationship and defeated every direction gate.
						...(command.fromRelationship ? { fromRelationship: command.fromRelationship } : {}),
						origin: "agent",
					});
					this.writeWorkerSuccess(client, command, receipt);
					return;
				}
				case "worker_prepare_update": {
					this.fencePeerTransports("update");
					const transaction = this.beginUpdateRestartTransaction(client);
					const manifest = await this.runUpdateRestartPreparation(transaction);
					this.writeWorkerSuccess(client, command, manifest);
					return;
				}
				case "worker_commit_update": {
					const transaction = this.updateRestart;
					if (!transaction || transaction.phase === "preparing" || transaction.phase === "fencing") {
						throw new Error("Daemon has no prepared update checkpoint");
					}
					if (transaction.phase === "publishing") {
						throw new Error("Daemon update checkpoint is already committing");
					}
					if (transaction.owner !== client)
						throw new Error("Daemon update checkpoint belongs to another supervisor");
					if (transaction.deadline) clearTimeout(transaction.deadline);
					transaction.deadline = undefined;
					transaction.phase = "publishing";
					let manifest: DaemonUpdateRestartManifest;
					try {
						manifest = await this.commitPreparedUpdateRestart(transaction.id);
					} catch (error) {
						if (this.updateRestart === transaction) transaction.phase = "prepared";
						if (transaction.abort.signal.aborted) this.cancelPreparedUpdateRestart(transaction.id);
						throw error;
					}
					this.writeWorkerSuccess(client, command, manifest);
					if (!this.supervisorClaims.has(client)) {
						setImmediate(() => void this.shutdown(0));
					}
					return;
				}
				case "worker_cancel_update": {
					const transaction = this.updateRestart;
					if (transaction && transaction.owner !== client) {
						throw new Error("Daemon update checkpoint belongs to another supervisor");
					}
					if (transaction?.phase === "publishing") {
						throw new Error("Daemon update checkpoint is already committing");
					}
					if (transaction) this.cancelPreparedUpdateRestart(transaction.id);
					this.peerAdmissionsFenced = false;
					this.writeWorkerSuccess(client, command);
					return;
				}
				default: {
					// Legacy commands from older supervisors (e.g. worker_sync_agent_peers) must fail fast, not time out.
					const unknown = command as { id?: string; type: string };
					this.write(client, failure(unknown.id, unknown.type, `Unknown worker command: ${unknown.type}`));
					return;
				}
			}
		} catch (error) {
			this.write(client, failure(command.id, command.type, error, serializeDaemonError(error)));
		}
	}

	private async handleCommand(
		client: DaemonSocketClient,
		command: DaemonCommand,
		onPromptHandlerOwnsAdmission: () => void = () => {},
	): Promise<DaemonResponse | undefined> {
		if ("agentMessageId" in command && command.agentMessageId === "") {
			throw new Error("agentMessageId must not be empty");
		}
		if ("admissionId" in command && command.admissionId === "") {
			throw new Error("admissionId must not be empty");
		}
		if ((command.type === "steer" || command.type === "follow_up") && command.expandPromptTemplates !== false) {
			const replayFields = (["content", "customMessage", "prefixMessages"] as const).filter(
				(field) => command[field] !== undefined,
			);
			if (replayFields.length > 0) {
				throw new Error(
					`${command.type} replay fields (${replayFields.join(", ")}) require expandPromptTemplates=false`,
				);
			}
		}
		switch (command.type) {
			case "ack_result":
				return undefined;
			case "list": {
				const activeSessions = Array.from(this.sessions.values());
				const scheduledJobs = this.cronStore.list();
				const listSessionDir = command.sessionDir ?? this.options.defaultSessionConfig.sessionDir;
				let savedSessions: SessionInfo[] = [];
				if (command.all) {
					savedSessions = command.cwd
						? await SessionManager.list(resolve(command.cwd), listSessionDir)
						: listSessionDir !== undefined
							? await SessionManager.listAll(undefined, listSessionDir)
							: await SessionManager.listAll();
				}
				const sessions = await this.buildSessionListWithPassiveRlmSubagents(
					activeSessions,
					savedSessions,
					scheduledJobs,
				);
				return success(command.id, "list", {
					sessions: command.omitStreamingMessages ? sessions.map(summaryWithoutStreamingMessage) : sessions,
				});
			}

			case "list_saved_sessions": {
				let activeSessionId: string | undefined;
				let cwd: string;
				let sessionDir: string | undefined;
				if ("activeSessionId" in command) {
					activeSessionId = command.activeSessionId;
					const sessionManager = this.getSessionState(activeSessionId).runtime.session.sessionManager;
					cwd = sessionManager.getCwd();
					sessionDir = sessionManager.getSessionDir();
				} else {
					cwd = resolve(command.cwd);
					sessionDir = command.sessionDir;
				}
				const callbacks = command.id
					? {
							onProgress: (loaded: number, total: number) => {
								this.write(client, {
									id: command.id,
									type: "session_list_progress",
									command: "list_saved_sessions",
									...(activeSessionId ? { activeSessionId } : {}),
									loaded,
									total,
								});
							},
							onSession: (session: SessionInfo) => {
								this.write(client, {
									id: command.id,
									type: "session_list_item",
									command: "list_saved_sessions",
									...(activeSessionId ? { activeSessionId } : {}),
									session: serializeSavedSessionInfo(session),
								});
							},
						}
					: undefined;
				const savedSessions =
					command.scope === "current"
						? await SessionManager.list(cwd, sessionDir, callbacks)
						: await SessionManager.listAll(callbacks, sessionDir);
				const sessions = await withPassiveRlmDescendantInfos(savedSessions, this.rlmSpawnLedgerFor(sessionDir), {
					...(command.scope === "current" ? { cwd } : {}),
					...(callbacks ? { onSession: callbacks.onSession } : {}),
					log: (message) => this.log(message),
				});
				return success(command.id, "list_saved_sessions", {
					sessions: sessions.map(serializeSavedSessionInfo),
				});
			}

			case "create": {
				const state = await this.createRuntime(command);
				return success(command.id, "create", summaryForActiveSession(state));
			}

			case "attach": {
				const state = await this.getOrHydrateBoundSessionState(command.activeSessionId);
				if (command.clientId) {
					client.id = command.clientId;
				}
				setDaemonClientSessionCapabilities(
					client,
					state.activeSessionId,
					normalizeClientCapabilities(command.capabilities, command.supportsExtensionUi),
				);
				const streamsSnapshot =
					client.transport === "private-framed" &&
					daemonClientCapabilitiesForSession(client, state.activeSessionId).has("chunked_snapshot");
				// Attach is admitted during update-restart preparation as a read. Env
				// adoption remains safe while mutations are only draining; after fencing,
				// defer it until rollback so the checkpoint never omits a live identity.
				const clientEnv = filterClientEnv(command.env);
				const deferClientEnv = this.updateRestart && this.updateRestart.phase !== "preparing";
				if (!deferClientEnv) this.adoptClientEnv(state, clientEnv);
				const snapshotSignal = streamsSnapshot
					? markClientSnapshotStreaming(client, state.activeSessionId)
					: undefined;
				let result: DaemonAttachResult;
				state.pendingAttaches++;
				try {
					result = await this.createAttachResult(client, state, command);
					if (
						this.sessions.get(state.activeSessionId) !== state ||
						this.closingSessions.has(state.activeSessionId)
					) {
						throw new BoundSessionUnavailableError(
							`Active session ${state.activeSessionId} closed during attach`,
						);
					}
				} catch (error) {
					removeDaemonClientSessionCapabilities(client, state.activeSessionId);
					if (streamsSnapshot) {
						finishClientSnapshotStreaming(client, state.activeSessionId);
					}
					throw error;
				} finally {
					state.pendingAttaches--;
				}
				state.clients.add(client);
				client.attachedActiveSessionIds.add(state.activeSessionId);
				// Carrier-less mutation: a direct viewer changes directAttachedClients with no session event.
				if (client.authenticationRole === "session_client") this.scheduleRosterFlush();
				if (deferClientEnv && clientEnv) {
					this.updateRestart?.deferredClientEnv.push({
						client,
						state,
						env: clientEnv,
					});
				}
				if (streamsSnapshot) {
					const snapshotId = this.nextSnapshotId(state);
					let transcript: SnapshotTranscriptChunkSource;
					try {
						transcript = createSnapshotTranscriptChunks({
							activeSessionId: state.activeSessionId,
							snapshotId,
							messages: result.snapshot.messages,
							serializedMessages: this.serializedTranscriptFor(state, result.snapshot.messages),
							targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
							signal: snapshotSignal,
						});
					} catch (error) {
						state.clients.delete(client);
						client.attachedActiveSessionIds.delete(state.activeSessionId);
						removeDaemonClientSessionCapabilities(client, state.activeSessionId);
						finishClientSnapshotStreaming(client, state.activeSessionId);
						throw error;
					}
					const streamedResult: DaemonAttachResult = {
						...result,
						messages: result.messages ? [] : undefined,
						snapshot: { ...result.snapshot, messages: [] },
						snapshotStream: {
							id: snapshotId,
							messageCount: result.snapshot.messages.length,
							targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
						},
					};
					setImmediate(() => {
						void this.streamWorkerSnapshot(
							client,
							streamedResult,
							transcript,
							"attach",
							snapshotSignal,
							true,
						).catch((error) => this.log(`could not stream attach snapshot: ${String(error)}`));
					});
					return success(command.id, "attach", streamedResult);
				}
				// Slim clients consume only the command response; legacy clients (e.g.
				// the plain daemon attach REPL) read state/messages off this event.
				// Skipping it for slim clients halves the attach payload.
				if (result.state && result.messages) {
					this.write(client, {
						type: "session_attached",
						activeSessionId: state.activeSessionId,
						state: result.state,
						messages: result.messages,
						snapshot: result.snapshot,
						replay: result.replay,
						lastEventSequence: result.lastEventSequence,
					});
				}
				return success(command.id, "attach", result);
			}

			case "detach": {
				if (command.activeSessionId) {
					const state = this.getSessionState(command.activeSessionId);
					for (const [pauseId, entry] of this.sessionInputPauses) {
						if (entry.owner !== client || entry.activeSessionId !== command.activeSessionId) continue;
						entry.pause.release();
						this.sessionInputPauses.delete(pauseId);
					}
					this.detachClientFromSession(client, state);
				} else {
					for (const [pauseId, entry] of this.sessionInputPauses) {
						if (entry.owner !== client) continue;
						entry.pause.release();
						this.sessionInputPauses.delete(pauseId);
					}
					this.detachClient(client);
				}
				return success(command.id, "detach");
			}

			case "kill": {
				const state = this.getSessionState(command.activeSessionId);
				await this.closeSession(state, "killed");
				return success(command.id, "kill");
			}

			case "rename": {
				const state = this.getSessionState(command.activeSessionId);
				const name = command.name.trim();
				if (!name) {
					throw new Error("Session name cannot be empty");
				}
				await this.setStateSessionNameForCommand(state, name);
				return success(command.id, "rename", summaryForActiveSession(state));
			}

			case "rename_saved_session": {
				if (command.activeSessionId) {
					this.getSessionState(command.activeSessionId);
				}
				const state = this.findActiveSessionByFile(command.sessionPath);
				const name = command.name.trim();
				if (!name) {
					throw new Error("Session name cannot be empty");
				}
				if (state) {
					await this.setStateSessionNameForCommand(state, name);
				} else {
					const info = await readSessionInfo(command.sessionPath);
					if (!info) throw new Error(`Session not found: ${command.sessionPath}`);
					const depth = info.rlmDepth ?? 0;
					await this.withSessionNameReservation(
						{
							name,
							depth,
							...(depth > 0 && info.parentSessionPath ? { parentSessionPath: info.parentSessionPath } : {}),
						},
						async () => {
							await this.assertFamilySessionNameAvailable(
								{
									name,
									depth,
									...(depth > 0 && info.parentSessionPath
										? { parentSessionPath: info.parentSessionPath }
										: {}),
									ignoreSessionId: info.id,
								},
								undefined,
								true,
							);
							// Same torn-tail rule as the catalog rename path: repair before
							// appending, or the session_info line glues onto a torn tail.
							// K3P-5: and the same lease rule - the repair truncates, so it
							// only happens under the write lease, never over a live writer.
							await appendOwnedSessionLineAsync(command.sessionPath, this.agentDir, (manager) => {
								manager.appendSessionInfo(name);
							});
							await this.rlmSpawnLedger()
								.appendRenameByChildPath(command.sessionPath, name)
								.catch((error) => {
									this.log(
										`failed to append RLM ledger rename: ${error instanceof Error ? error.message : String(error)}`,
									);
								});
						},
					);
				}
				return success(command.id, "rename_saved_session");
			}

			case "delete_saved_session": {
				if (command.activeSessionId) {
					this.getSessionState(command.activeSessionId);
				}
				if (this.findActiveSessionByFile(command.sessionPath)) {
					throw new Error("Cannot delete the currently active session");
				}
				const composedEntry = this.rosterEntryForSessionPath(canonicalSessionPath(command.sessionPath));
				const { deletedInfo, ledgerEdge } = await tombstoneSavedSessionDelete(
					this.rlmSpawnLedger(),
					command.sessionPath,
					composedEntry?.summary,
				);
				const result = await this.deleteSavedSessionFile(command.sessionPath, {
					afterFileRemoved: () => {
						this.cancelScheduledJobsForSessionFile(command.sessionPath);
					},
				});
				if (result.ok && this.options.worker) {
					const removedAgentId =
						composedEntry?.agentId ??
						(ledgerEdge ? this.rosterAgentIdForRlmChild(ledgerEdge.childId, ledgerEdge.parent) : deletedInfo?.id);
					if (removedAgentId) {
						this.rosterReporter.removedAgentIds.set(
							removedAgentId,
							composedEntry?.summary.sessionId ?? deletedInfo?.id,
						);
						this.scheduleRosterFlush();
					}
				}
				return success(command.id, "delete_saved_session", result);
			}

			case "cancel_prompt_admission": {
				const admission = this.promptAdmissions.get(
					this.promptAdmissionKey(command.activeSessionId, command.admissionId),
				);
				if (!admission) {
					return success(command.id, command.type, {
						status: "unknown" as const,
					});
				}
				if (admission.status === "owned") {
					if (command.cancelOwned) admission.controller?.abort();
					return success(command.id, command.type, {
						status: "owned" as const,
					});
				}
				if (admission.status === "waiting") {
					admission.status = "cancelled";
					admission.controller?.abort();
				}
				return success(command.id, command.type, {
					status: "cancelled" as const,
				});
			}

			case "prompt":
			case "prompt_and_wait": {
				onPromptHandlerOwnsAdmission();
				const admissionKey = command.admissionId
					? this.promptAdmissionKey(command.activeSessionId, command.admissionId)
					: undefined;
				const admission = admissionKey ? this.promptAdmissions.get(admissionKey) : undefined;
				if (command.admissionId && !admission) {
					throw new Error("Prompt admission was not registered during command parsing");
				}
				const clearAdmission = () => {
					if (admissionKey && this.promptAdmissions.get(admissionKey) === admission) {
						this.promptAdmissions.delete(admissionKey);
					}
				};
				const commitAdmission = () => {
					if (admission?.status === "waiting") admission.status = "owned";
				};
				let state: ActiveSessionState;
				try {
					if (admission?.status === "cancelled") throw new PromptAdmissionCancelledError();
					state = this.getBoundSessionState(command.activeSessionId);
				} catch (error) {
					clearAdmission();
					throw error;
				}
				const options: PromptOptions = {
					content: command.content,
					images: command.images,
					streamingBehavior: command.streamingBehavior,
					queueIfBusy: command.queueIfBusy ?? command.streamingBehavior !== undefined,
					resumeIfIdle: command.streamingBehavior !== undefined,
					expandPromptTemplates: command.expandPromptTemplates,
					skipInputHandlers: command.expandPromptTemplates === false ? true : undefined,
					source: command.source,
					...(admission?.controller
						? {
								signal: admission.controller.signal,
								admissionCommitted: commitAdmission,
							}
						: {}),
				};
				if (command.type === "prompt_and_wait") {
					try {
						await state.runtime.session.promptAndWait(command.message, {
							...options,
							preflightResult: (didSucceed) => {
								if (didSucceed) this.recordWorkerRecoveryState(state, "prompt_accepted", true);
							},
						});
						return success(command.id, command.type);
					} finally {
						clearAdmission();
					}
				}

				let responseSent = false;
				let preflightRejected = false;
				const sendSuccessResponse = () => {
					if (responseSent) return;
					responseSent = true;
					this.write(client, success(command.id, "prompt"));
				};
				const prompt =
					command.agentMessageId !== undefined && command.expandPromptTemplates === false
						? state.runtime.session.acceptAgentMessagePrompt.bind(state.runtime.session)
						: state.runtime.session.promptUntilAccepted.bind(state.runtime.session);
				void prompt(command.message, {
					...options,
					agentMessageId: command.agentMessageId,
					customMessage: command.customMessage,
					preflightResult: (didSucceed) => {
						if (didSucceed) {
							this.recordWorkerRecoveryState(state, "prompt_accepted", true);
							sendSuccessResponse();
						} else {
							preflightRejected = true;
						}
					},
				})
					.then(() => {
						if (preflightRejected) {
							const error = new Error("Prompt was not accepted by the session.");
							this.write(client, failure(command.id, "prompt", error, serializeDaemonError(error)));
						} else {
							sendSuccessResponse();
						}
					})
					.catch((error) => {
						if (responseSent) {
							this.broadcastToSession(state, failure(undefined, "prompt", error, serializeDaemonError(error)));
						} else {
							this.write(client, failure(command.id, "prompt", error, serializeDaemonError(error)));
						}
					})
					.finally(clearAdmission);
				return undefined;
			}

			case "steer": {
				const state = this.getBoundSessionState(command.activeSessionId);
				if (command.expandPromptTemplates === false) {
					await state.runtime.session.restoreSteeringMessage(command.message, command.images, {
						queueKey: command.queueKey,
						agentMessageId: command.agentMessageId,
						content: command.content,
						customMessage: command.customMessage,
						prefixMessages: command.prefixMessages,
					});
				} else {
					await state.runtime.session.steer(command.message, command.images, {
						queueKey: command.queueKey,
						agentMessageId: command.agentMessageId,
						resumeIfIdle: true,
					});
				}
				this.recordWorkerRecoveryState(state, "steer_queued", true);
				return success(command.id, "steer");
			}

			case "follow_up": {
				const state = this.getBoundSessionState(command.activeSessionId);
				let queued = true;
				let admitted = true;
				if (command.expandPromptTemplates === false) {
					queued = await state.runtime.session.restoreFollowUpMessage(command.message, command.images, {
						queueKey: command.queueKey,
						agentMessageId: command.agentMessageId,
						content: command.content,
						customMessage: command.customMessage,
						prefixMessages: command.prefixMessages,
					});
					admitted = queued;
				} else {
					queued = await state.runtime.session.followUp(command.message, command.images, {
						queueKey: command.queueKey,
						agentMessageId: command.agentMessageId,
						resumeIfIdle: true,
					});
					admitted = queued;
				}
				if (admitted) {
					this.recordWorkerRecoveryState(state, "follow_up_queued", true);
				}
				return success(command.id, "follow_up", { queued });
			}

			case "restore_next_turn": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.restorePendingNextTurnMessages(command.messages);
				return success(command.id, "restore_next_turn");
			}

			case "restore_actions": {
				const state = this.getSessionState(command.activeSessionId);
				const restored = await state.runtime.session.restoreSessionActions(command.snapshot);
				if (restored > 0) this.recordWorkerRecoveryState(state, "actions_restored", true);
				return success(command.id, "restore_actions", { restored });
			}

			case "append_custom_message": {
				const state = this.getSessionState(command.activeSessionId);
				await state.runtime.session.sendCustomMessage(command.message);
				return success(command.id, "append_custom_message");
			}

			case "resume_queue": {
				const state = this.getSessionState(command.activeSessionId);
				// Connection-facing resume: the update-restart fence stays up (the
				// false result maps to the "No queued work to resume" no-op below).
				if (!state.runtime.session.resumeQueuedWorkFromConnection()) {
					const error = new Error("No queued work to resume");
					return failure(command.id, "resume_queue", error, serializeDaemonError(error));
				}
				return success(command.id, "resume_queue");
			}

			case "send_message": {
				const fromState = command.fromActiveSessionId
					? this.getSessionState(command.fromActiveSessionId)
					: undefined;
				const receipt = await this.sendAgentSessionMessage({
					targetSelector: command.targetActiveSessionId,
					message: command.message,
					fromState,
					clientId: client.id,
					senderKey: this.createCliAgentMessageSenderKey(),
					origin: command.agentOrigin === true ? "agent" : "cli",
				});
				return success(command.id, "send_message", receipt);
			}

			case "agent_messages_status": {
				return success(command.id, "agent_messages_status", this.getAgentMessageSafetyStatus());
			}

			case "agent_messages_pause": {
				this.agentMessagesPaused = true;
				this.agentMessageRateLimiter.clear();
				await this.clearQueuedAgentSessionMessagesForAllStates();
				return success(command.id, "agent_messages_pause", this.getAgentMessageSafetyStatus());
			}

			case "agent_messages_resume": {
				this.agentMessagesPaused = false;
				return success(command.id, "agent_messages_resume", this.getAgentMessageSafetyStatus());
			}

			case "agent_messages_clear": {
				const state = this.getSessionState(command.activeSessionId);
				this.agentMessageRateLimiter.clearMatching((key) => key.endsWith(`->${state.activeSessionId}`));
				const cleared = state.runtime.session.clearQueuedAgentMessages();
				return success(command.id, "agent_messages_clear", cleared);
			}

			case "abort": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.requestAbort();
				return success(command.id, "abort");
			}

			case "abort_and_send_queued": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.abortAndSendQueued();
				return success(command.id, "abort_and_send_queued");
			}

			case "start_side_question": {
				const state = this.getSessionState(command.activeSessionId);
				if (this.sideQuestionRuns.has(command.sideQuestionId)) {
					throw new Error(`Side question already exists: ${command.sideQuestionId}`);
				}
				if (this.hasActiveSideQuestionFor(client, state.activeSessionId)) {
					throw new Error("A side question is already running for this client and session");
				}
				const run = startSideQuestion(
					state.runtime.session.agent,
					command.sideQuestionId,
					command.question,
					(event) => {
						this.write(client, {
							type: "side_question_event",
							activeSessionId: state.activeSessionId,
							event,
						});
						if (event.status !== "running") {
							this.sideQuestionRuns.delete(event.id);
						}
					},
					command.previousTurns,
					// No module layer wraps a side question: the provider client is its
					// outermost retry layer and retries per this session's policy.
					providerRetryPolicy(state.runtime.session.settingsManager),
				);
				this.sideQuestionRuns.set(command.sideQuestionId, {
					run,
					client,
					activeSessionId: state.activeSessionId,
				});
				void run.done.catch((error) => {
					this.sideQuestionRuns.delete(command.sideQuestionId);
					this.log(
						`side question ${command.sideQuestionId} failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
				return success(command.id, "start_side_question");
			}

			case "abort_side_question": {
				this.getSessionState(command.activeSessionId);
				const entry = this.sideQuestionRuns.get(command.sideQuestionId);
				if (!entry || entry.client !== client || entry.activeSessionId !== command.activeSessionId) {
					return success(command.id, "abort_side_question", { aborted: false });
				}
				entry.run.abort();
				return success(command.id, "abort_side_question", { aborted: true });
			}

			case "execute_bash": {
				const state = this.getSessionState(command.activeSessionId);
				if (state.runtime.session.isBashRunning) {
					throw new Error("A bash command is already running");
				}
				// Respond before completion (bash can outlive the client request
				// timeout); output and completion stream via bash_* session events.
				const bash = state.runtime.session.runUserBash(command.command, {
					excludeFromContext: command.excludeFromContext,
					transient: command.transient,
					runId: command.runId,
				});
				state.inFlightBash = Promise.allSettled([state.inFlightBash, bash]).then(() => undefined);
				void bash.catch((error) => {
					this.broadcastToSession(state, failure(undefined, "execute_bash", error, serializeDaemonError(error)));
				});
				return success(command.id, "execute_bash");
			}

			case "execute_bash_and_wait": {
				const state = this.getSessionState(command.activeSessionId);
				const bash = state.runtime.session.executeBash(command.command);
				state.inFlightBash = Promise.allSettled([state.inFlightBash, bash]).then(() => undefined);
				try {
					return success(command.id, "execute_bash_and_wait", await bash);
				} finally {
					this.scheduleRosterFlush();
				}
			}

			case "abort_bash": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.abortBash();
				return success(command.id, "abort_bash");
			}

			case "cancel_rlm_child": {
				const state = this.getSessionState(command.activeSessionId);
				const cancelled = state.runtime.session.cancelRlmChildRun(command.childId);
				return success(command.id, "cancel_rlm_child", { cancelled });
			}

			case "delete_rlm_subagent": {
				const state = this.getSessionState(command.activeSessionId);
				const isResidentChildRunning = () => {
					const childState = [...this.sessions.values()].find(
						(candidate) =>
							candidate.runtime.metadata.kind === "subagent" &&
							candidate.runtime.metadata.rlmChildId === command.childId,
					);
					return (
						childState !== undefined &&
						(childState.runtime.session.isStreaming || childState.runtime.session.unfinishedActionCount > 0)
					);
				};
				const result = isResidentChildRunning()
					? "running"
					: await state.runtime.session.deleteInactiveRlmSubagent(command.childId, isResidentChildRunning);
				return success(command.id, "delete_rlm_subagent", {
					deleted: result === "deleted",
					...(result === "running" ? { reason: "running" } : {}),
				});
			}

			case "acquire_session_input_pause": {
				const existing = [...this.sessionInputPauses].find(
					([, entry]) =>
						entry.owner === client &&
						entry.activeSessionId === command.activeSessionId &&
						entry.leaseKey === command.leaseKey,
				);
				if (existing) {
					return success(command.id, "acquire_session_input_pause", { pauseId: existing[0] });
				}
				const state = this.getSessionState(command.activeSessionId);
				const pauseId = randomUUID();
				this.sessionInputPauses.set(pauseId, {
					activeSessionId: command.activeSessionId,
					owner: client,
					leaseKey: command.leaseKey,
					pause: state.runtime.session.acquireSessionInputPause(),
				});
				return success(command.id, "acquire_session_input_pause", { pauseId });
			}

			case "release_session_input_pause": {
				const entry = this.sessionInputPauses.get(command.pauseId);
				if (!entry) return success(command.id, "release_session_input_pause");
				if (entry.owner !== client || entry.activeSessionId !== command.activeSessionId) {
					throw new Error(`Session input pause is owned by another client: ${command.pauseId}`);
				}
				this.sessionInputPauses.delete(command.pauseId);
				entry.pause.release();
				return success(command.id, "release_session_input_pause");
			}

			case "wait_for_idle": {
				const state = this.getSessionState(command.activeSessionId);
				await state.runtime.session.waitForIdle();
				return success(command.id, "wait_for_idle");
			}

			case "wait_for_headless_completion": {
				const state = this.getSessionState(command.activeSessionId);
				return success(
					command.id,
					"wait_for_headless_completion",
					await waitForHeadlessCompletion(state.runtime.session, {
						waitForRlmQuiescence: command.waitForRlmQuiescence,
						// The wait is read-only; autonomous gate continuations are not.
						// Stop prompting once an update-restart transaction is underway so
						// the checkpoint never races a gate continuation turn.
						shouldStopGateContinuations: () => this.updateRestart !== undefined,
					}),
				);
			}

			case "get_session_header": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_session_header", {
					header: state.runtime.session.sessionManager.getHeader(),
				});
			}

			case "get_state": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_state", summaryForActiveSession(state));
			}

			case "get_connection_state": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_connection_state", this.createConnectionState(state));
			}

			case "get_messages": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_messages", {
					messages: state.runtime.session.messages,
				});
			}

			case "get_rlm_children": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_rlm_children", {
					children: state.runtime.session.getRlmChildSnapshots(),
					eventSequence: state.lastEventSequence,
				});
			}

			case "get_session_stats": {
				const state = this.getSessionState(command.activeSessionId);
				const stats: SessionStats = state.runtime.session.getSessionStats();
				return success(command.id, "get_session_stats", stats);
			}

			case "get_context_tree": {
				const state = this.getSessionState(command.activeSessionId);
				const tree = state.runtime.session.getContextTree();
				// The scan diagnostics ride the tree for clients that render them; log them
				// too, so a headless caller that ignores the field still leaves a record
				// that the roster it received was partial.
				const scan = tree.scan;
				if (scan?.truncated) {
					this.log(
						`get_context_tree truncated: ${scan.skippedByBudget} child sessions not shown (budget: ${scan.truncatedReason}); ${scan.scannedChildren} read, ${scan.bytesRead} of ${scan.bytesPlanned} bytes`,
					);
				}
				return success(command.id, "get_context_tree", tree);
			}

			case "get_commands": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_commands", {
					commands: createAgentConnectionCommands(state.runtime.session),
				});
			}

			case "get_resource_snapshot": {
				const state = this.getSessionState(command.activeSessionId);
				return success(
					command.id,
					"get_resource_snapshot",
					createAgentConnectionResourceSnapshot(state.runtime.session),
				);
			}

			case "replace_acp_mcp_servers": {
				if (!command.ownerId) throw new Error("ACP MCP owner id is required");
				const state = this.getSessionState(command.activeSessionId);
				if (!state.clients.has(client)) throw new Error("Daemon client is not attached to this session");
				if (command.servers.length > 0 && state.runtime.session.isStreaming) {
					throw new Error("Cannot replace ACP MCP servers while the agent is running");
				}
				const commandPause =
					command.servers.length > 0 ? state.runtime.session.acquireSessionInputPause() : undefined;
				try {
					let currentOwner = this.acpMcpOwners.get(state.activeSessionId);
					if (currentOwner?.release) {
						await currentOwner.release.catch(() => undefined);
						currentOwner = this.acpMcpOwners.get(state.activeSessionId);
					}
					const ownedByClient = currentOwner?.client === client && currentOwner.ownerId === command.ownerId;
					if (command.servers.length === 0 && !ownedByClient) {
						return success(command.id, "replace_acp_mcp_servers");
					}
					if (command.servers.length === 0) {
						if (!currentOwner) return success(command.id, "replace_acp_mcp_servers");
						const release = state.runtime.session.releaseAcpMcpServers(command.ownerId, currentOwner.serverNames);
						currentOwner.release = release;
						try {
							await release;
						} catch (error) {
							currentOwner.release = undefined;
							throw error;
						}
						if (this.acpMcpOwners.get(state.activeSessionId) === currentOwner) {
							this.acpMcpOwners.delete(state.activeSessionId);
						}
						return success(command.id, "replace_acp_mcp_servers");
					}

					if (currentOwner && !ownedByClient) {
						throw new Error("ACP MCP configuration is owned by another daemon client");
					}
					const claim = {
						client,
						ownerId: command.ownerId,
						serverNames: [
							...new Set([
								...(currentOwner?.serverNames ?? []),
								...command.servers.map((server) => server.name),
							]),
						],
					};
					this.acpMcpOwners.set(state.activeSessionId, claim);
					const rollback = async (): Promise<void> => {
						try {
							await state.runtime.session.releaseAcpMcpServers(command.ownerId, claim.serverNames);
						} catch (error) {
							this.log(`failed to roll back ACP MCP config: ${String(error)}`);
						}
						if (this.acpMcpOwners.get(state.activeSessionId) === claim) {
							this.acpMcpOwners.delete(state.activeSessionId);
						}
					};
					try {
						await withClientEnv(state.clientEnv, async () =>
							state.runtime.session.replaceAcpMcpServers(command.servers, command.ownerId),
						);
					} catch (error) {
						await rollback();
						throw error;
					}
					if (!state.clients.has(client) || this.acpMcpOwners.get(state.activeSessionId) !== claim) {
						await rollback();
						throw new Error("Daemon client detached during ACP MCP replacement");
					}
					return success(command.id, "replace_acp_mcp_servers");
				} finally {
					commandPause?.release();
				}
			}

			case "get_available_models": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_available_models", {
					models: await state.runtime.session.modelRegistry.refreshAvailableModels(),
				});
			}

			case "get_model_catalog": {
				const state = this.getSessionState(command.activeSessionId);
				return success(
					command.id,
					"get_model_catalog",
					await state.runtime.session.modelRegistry.refreshModelCatalog(),
				);
			}

			case "get_queue": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_queue", {
					steering: [...state.runtime.session.getSteeringMessagePreviews()],
					followUp: [...state.runtime.session.getFollowUpMessagePreviews()],
				});
			}

			case "mutate_queued_message": {
				const state = this.getSessionState(command.activeSessionId);
				const status = state.runtime.session.mutateQueuedMessage(
					command.lane,
					command.index,
					command.expectedText,
					command.mutation,
				);
				return success(command.id, "mutate_queued_message", { status });
			}

			case "clear_queue": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "clear_queue", state.runtime.session.clearQueue());
			}

			case "abort_and_clear_queue": {
				const state = this.getSessionState(command.activeSessionId);
				const queue = state.runtime.session.clearQueue();
				state.runtime.session.requestAbort();
				return success(command.id, "abort_and_clear_queue", queue);
			}

			case "cron_list": {
				const jobs = this.cronStore.list().filter((job) => {
					if (!command.includeInactive && job.status !== "active" && job.status !== "paused") {
						return false;
					}
					if (command.activeSessionId && job.activeSessionId !== command.activeSessionId) {
						return false;
					}
					return true;
				});
				return success(command.id, "cron_list", { jobs });
			}

			case "heartbeats_list":
				return success(command.id, "heartbeats_list", {
					heartbeats: this.listHeartbeats(),
				});

			case "heartbeat_manage": {
				const heartbeat = this.manageHeartbeat(command.activeSessionId, command.jobId, command.action);
				if (!heartbeat) {
					throw new Error(`No active heartbeat found: ${command.jobId}`);
				}
				return success(command.id, "heartbeat_manage", { heartbeat });
			}

			case "cron_add": {
				const state = this.getSessionState(command.activeSessionId);
				const job = this.createCronJobForState(state, command.schedule, command.prompt);
				this.scheduleRosterFlush();
				return success(command.id, "cron_add", { job });
			}

			case "cron_cancel": {
				const job = this.cronStore.cancel(command.jobId);
				if (!job) {
					throw new Error(`No cron job found: ${command.jobId}`);
				}
				const state = this.sessions.get(job.activeSessionId);
				if (state) {
					this.removeQueuedHeartbeatFollowUp(state, job);
				}
				this.cronScheduler.wake();
				this.scheduleRosterFlush();
				return success(command.id, "cron_cancel", { job });
			}

			case "heartbeat_get": {
				const state = this.getSessionState(command.activeSessionId);
				const heartbeat = this.cronStore.getHeartbeat(state.activeSessionId);
				return success(command.id, "heartbeat_get", {
					heartbeat: heartbeat ?? null,
				});
			}

			case "heartbeat_set": {
				const state = this.getSessionState(command.activeSessionId);
				const deliveryMode = normalizeHeartbeatDeliveryMode(command.deliveryMode);
				const heartbeat = this.createHeartbeatForState(state, command.schedule, command.prompt, deliveryMode);
				return success(command.id, "heartbeat_set", { heartbeat });
			}

			case "heartbeat_update": {
				const state = this.getSessionState(command.activeSessionId);
				const heartbeat = this.updateHeartbeatForState(state, command.action);
				return success(command.id, "heartbeat_update", {
					heartbeat: heartbeat ?? null,
				});
			}

			case "set_model": {
				const state = this.getSessionState(command.activeSessionId);
				const session = state.runtime.session;
				const availableModels = await session.modelRegistry.refreshAvailableModels();
				const model = availableModels.find((candidate) => {
					return candidate.provider === command.provider && candidate.id === command.modelId;
				});
				if (!model) {
					throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model, {
					waitForExtensions: !(session.isStreaming || session.isCompacting),
				});
				this.scheduleRosterFlush();
				return success(command.id, "set_model", model);
			}

			case "cycle_model": {
				const state = this.getSessionState(command.activeSessionId);
				const session = state.runtime.session;
				const result = await session.cycleModel(command.direction, {
					waitForExtensions: !(session.isStreaming || session.isCompacting),
				});
				this.scheduleRosterFlush();
				return success(command.id, "cycle_model", result ?? null);
			}

			case "set_scoped_models": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setScopedModels(command.scopedModels);
				return success(command.id, "set_scoped_models");
			}

			case "set_thinking_level": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setThinkingLevel(command.level);
				return success(command.id, "set_thinking_level");
			}

			case "set_service_tier": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setServiceTier(command.serviceTier);
				return success(command.id, "set_service_tier");
			}

			case "cycle_thinking_level": {
				const state = this.getSessionState(command.activeSessionId);
				const level = state.runtime.session.cycleThinkingLevel();
				return success(command.id, "cycle_thinking_level", level ? { level } : null);
			}

			case "set_transport": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.settingsManager.setTransport(command.transport);
				state.runtime.session.agent.transport = command.transport;
				return success(command.id, "set_transport");
			}

			case "set_steering_mode": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setSteeringMode(command.mode);
				return success(command.id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setFollowUpMode(command.mode);
				return success(command.id, "set_follow_up_mode");
			}

			case "set_auto_compaction": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setAutoCompactionEnabled(command.enabled);
				return success(command.id, "set_auto_compaction");
			}

			case "set_auto_retry": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.setAutoRetryEnabled(command.enabled);
				return success(command.id, "set_auto_retry");
			}

			case "compact": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.session.compact(command.customInstructions);
				return success(command.id, "compact", result);
			}

			case "refine": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.session.refine({
					instructions: command.instructions,
					rollbackId: command.rollbackId,
					global: command.global,
				});
				return success(command.id, "refine", result);
			}

			case "abort_compaction": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.abortCompaction();
				return success(command.id, "abort_compaction");
			}

			case "abort_branch_summary": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.abortBranchSummary();
				return success(command.id, "abort_branch_summary");
			}

			case "abort_retry": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.abortRetry();
				return success(command.id, "abort_retry");
			}

			case "reload": {
				const state = this.getSessionState(command.activeSessionId);
				// Reload re-evaluates extension modules, which capture client env
				// (e.g. herdr pane identity) synchronously at load.
				await withClientEnv(state.clientEnv, () => state.runtime.session.reload());
				return success(command.id, "reload");
			}

			case "new_session": {
				const state = this.getSessionState(command.activeSessionId);
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await state.runtime.newSession(options);
				this.rebindCronJobsToState(state);
				return success(command.id, "new_session", result);
			}

			case "switch_session": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.switchSession(command.sessionPath, {
					cwdOverride: command.cwdOverride,
				});
				this.rebindCronJobsToState(state);
				return success(command.id, "switch_session", result);
			}

			case "fork": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.fork(command.entryId, {
					position: command.position,
				});
				this.rebindCronJobsToState(state);
				return success(command.id, "fork", result);
			}

			case "navigate_tree": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.session.navigateTree(command.targetId, {
					summarize: command.summarize,
					customInstructions: command.customInstructions,
					replaceInstructions: command.replaceInstructions,
					label: command.label,
				});
				// Carrier-less mutation: branch navigation swaps the message list
				// without a session event, so the row refresh must be scheduled.
				this.scheduleRosterFlush();
				return success(command.id, "navigate_tree", result);
			}

			case "import_jsonl": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.importFromJsonl(command.inputPath, command.cwdOverride);
				return success(command.id, "import_jsonl", result);
			}

			case "export_html": {
				const state = this.getSessionState(command.activeSessionId);
				const path = await state.runtime.session.exportToHtml(command.outputPath);
				return success(command.id, "export_html", { path });
			}

			case "export_jsonl": {
				const state = this.getSessionState(command.activeSessionId);
				const path = state.runtime.session.exportToJsonl(command.outputPath);
				return success(command.id, "export_jsonl", { path });
			}

			case "set_session_name": {
				const state = this.getSessionState(command.activeSessionId);
				const name = command.name.trim();
				if (!name) {
					throw new Error("Session name cannot be empty");
				}
				await this.setStateSessionNameForCommand(state, name);
				return success(command.id, "set_session_name");
			}

			case "get_rlm_max_depth_status": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_rlm_max_depth_status", state.runtime.session.getRlmMaxDepthStatus());
			}

			case "set_rlm_max_depth": {
				const state = this.getSessionState(command.activeSessionId);
				const result = await state.runtime.session.setRlmMaxDepth(command.maxDepth, { global: command.global });
				return success(command.id, "set_rlm_max_depth", result);
			}

			case "get_session_context": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_session_context", {
					context: state.runtime.session.buildSessionContext(),
				});
			}

			case "get_session_tree": {
				const state = this.getSessionState(command.activeSessionId);
				const sessionManager = state.runtime.session.sessionManager;
				// Every entry ships whole, so an uncapped response is O(entries) bytes - a
				// 100k-entry session is ~90MB per call. The cap keeps the live leaf's entry
				// and ancestor chain first and the newest entries after them: the leaf is NOT
				// the last entry in file order after a rewind, because branch() records the
				// move with a leaf_position marker appended as the file's last line, so a
				// pure tail cut would drop the resumable branch while leafId still points at
				// it. The stats travel to the client so the omission is reportable, not
				// silent.
				const bounded = sessionManager.getBoundedFlatTree();
				if (bounded.stats.truncated) {
					this.log(
						`get_session_tree truncated: ${bounded.stats.returnedNodes} of ${bounded.stats.totalEntries} entries (max ${bounded.stats.maxNodes}); older branches omitted`,
					);
				}
				return success(command.id, "get_session_tree", {
					flatNodes: bounded.nodes,
					leafId: sessionManager.getLeafId(),
					treeBound: bounded.stats,
				});
			}

			case "get_user_messages_for_forking": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_user_messages_for_forking", {
					messages: state.runtime.session.getUserMessagesForForking(),
				});
			}

			case "get_last_assistant_text": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_last_assistant_text", {
					text: state.runtime.session.getLastAssistantText(),
				});
			}

			case "get_system_prompt": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_system_prompt", {
					systemPrompt: state.runtime.session.systemPrompt,
				});
			}

			case "get_tool_definition": {
				const state = this.getSessionState(command.activeSessionId);
				return success(command.id, "get_tool_definition", {
					toolDefinition: createAgentConnectionToolDefinition(
						state.runtime.session.getToolDefinition(command.name),
					),
				});
			}

			case "set_session_entry_label": {
				const state = this.getSessionState(command.activeSessionId);
				state.runtime.session.sessionManager.appendLabelChange(command.entryId, command.label);
				return success(command.id, "set_session_entry_label");
			}

			case "extension_ui_response": {
				const state = this.getSessionState(command.activeSessionId);
				const pending = state.extensionUiRequests.get(command.requestId);
				if (!pending) {
					throw new Error(`Unknown extension UI request: ${command.requestId}`);
				}
				state.extensionUiRequests.delete(command.requestId);
				pending.resolve(command.response);
				return success(command.id, "extension_ui_response");
			}

			case "declare_client_capabilities": {
				client.declaredCommandCapabilities = new Set(normalizeDeclaredCapabilities(command.capabilities));
				client.declaredCapabilities = true;
				return success(command.id, command.type, { declared: [...client.declaredCommandCapabilities] });
			}

			case "prepare_update_restart":
				this.log(
					`prepare_update_restart command received over socket; ${this.sessions.size} active session(s) will be closed`,
				);
				return success(command.id, "prepare_update_restart", await this.prepareUpdateRestart());

			case "retry_worker":
				throw new Error("Worker retry is only available through the daemon supervisor");

			case "restart":
				setImmediate(() => {
					void this.shutdown(0);
				});
				return success(command.id, command.type);

			case "shutdown":
				this.log(`shutdown command received over socket; ${this.sessions.size} active session(s) will be closed`);
				setImmediate(() => {
					void this.shutdown(0);
				});
				return success(command.id, "shutdown");
		}
	}

	private async createAttachResult(
		client: DaemonSocketClient,
		state: ActiveSessionState,
		command: Extract<DaemonCommand, { type: "attach" }>,
	): Promise<DaemonAttachResult> {
		const snapshot = await this.createSessionSnapshot(state);
		const replay =
			command.resumeCursor?.activeSessionId && command.resumeCursor.activeSessionId !== state.activeSessionId
				? {
						status: "unavailable" as const,
						fromSequence:
							"sequence" in command.resumeCursor
								? command.resumeCursor.sequence
								: command.resumeCursor.eventSequence,
						toSequence: state.lastEventSequence,
						toCursor: {
							generation: state.eventGeneration,
							sequence: state.lastEventSequence,
						},
						reason: "resume_cursor_session_mismatch",
					}
				: createDaemonReplayInfo(command.resumeCursor, state.lastEventSequence, state.eventGeneration);
		// Slim clients read summary/messages from the snapshot; duplicating them at
		// the top level would serialize the full history twice more per attach.
		const capabilities = daemonClientCapabilitiesForSession(client, state.activeSessionId);
		const slim = capabilities.has("slim_attach");
		return {
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId: state.activeSessionId,
			...(slim ? {} : { state: snapshot.summary, messages: snapshot.messages }),
			snapshot,
			replay,
			lastEventSequence: state.lastEventSequence,
			lastEventCursor: {
				generation: state.eventGeneration,
				sequence: state.lastEventSequence,
			},
			client: {
				id: client.id,
				capabilities: [...capabilities],
			},
		};
	}

	private async createSessionSnapshot(state: ActiveSessionState): Promise<DaemonSessionSnapshot> {
		const metadata = state.runtime.metadata;
		const parent =
			metadata.parentActiveSessionId || metadata.parentSessionId || metadata.rlmParentNodeId || metadata.rlmChildId
				? {
						...(metadata.parentActiveSessionId ? { activeSessionId: metadata.parentActiveSessionId } : {}),
						...(metadata.parentSessionId ? { sessionId: metadata.parentSessionId } : {}),
						...(metadata.rlmParentNodeId ? { nodeId: metadata.rlmParentNodeId } : {}),
						...(metadata.rlmChildId ? { childId: metadata.rlmChildId } : {}),
					}
				: undefined;
		let session = state.runtime.session;
		let children = await this.buildRlmChildSnapshotsWithPassiveRlmSubagents(state);
		for (
			let retries = 0;
			retries < MAX_SESSION_SNAPSHOT_STABILIZATION_RETRIES && state.runtime.session !== session;
			retries++
		) {
			session = state.runtime.session;
			children = await this.buildRlmChildSnapshotsWithPassiveRlmSubagents(state);
		}
		session = state.runtime.session;
		const connectionState = this.createConnectionState(state);
		return {
			activeSessionId: state.activeSessionId,
			summary: summaryForActiveSession(state),
			state: connectionState,
			messages: session.messages,
			// Omit duplicate heavy payloads from attach. The client can derive render
			// context from messages + state, and fetch the full session tree lazily
			// when the tree/branch selector opens.
			lastEventSequence: state.lastEventSequence,
			lastEventCursor: {
				generation: state.eventGeneration,
				sequence: state.lastEventSequence,
			},
			...(parent ? { parent } : {}),
			children,
		};
	}

	private async streamWorkerSnapshot(
		client: DaemonSocketClient,
		result: DaemonAttachResult,
		transcript: SnapshotTranscriptChunkSource,
		purpose: "attach" | "replacement" | "catchup" = "attach",
		signal?: AbortSignal,
		snapshotAlreadyMarked = false,
	): Promise<void> {
		const stream = result.snapshotStream;
		if (!stream) {
			if (snapshotAlreadyMarked) {
				finishClientSnapshotStreaming(client, result.activeSessionId);
			}
			transcript.dispose?.();
			return;
		}
		if (snapshotAlreadyMarked && !signal) {
			throw new Error(`Snapshot ${stream.id} is missing its transfer signal`);
		}
		const transferSignal = signal ?? markClientSnapshotStreaming(client, result.activeSessionId);
		if (client.socket.destroyed) {
			finishClientSnapshotStreaming(client, result.activeSessionId);
			transcript.dispose?.();
			return;
		}
		client.snapshotTransferTails ??= new Map();
		const previousTransfer = client.snapshotTransferTails.get(result.activeSessionId);
		let finishTransfer!: () => void;
		const transfer = new Promise<void>((resolve) => {
			finishTransfer = resolve;
		});
		client.snapshotTransferTails.set(result.activeSessionId, transfer);
		if (previousTransfer) {
			await previousTransfer;
		}
		const { messages: _messages, ...snapshot } = result.snapshot;
		const snapshotBegin: DaemonOutbound = {
			type: "session_snapshot_begin",
			activeSessionId: result.activeSessionId,
			snapshotId: stream.id,
			snapshot,
			messageCount: stream.messageCount,
			targetChunkBytes: stream.targetChunkBytes,
			purpose: purpose === "catchup" ? "resync" : purpose,
		};
		const deliverSnapshotFailure = async (streamError: Error, includeBegin = false): Promise<void> => {
			transcript.markFailed?.(streamError);
			if (client.socket.destroyed) {
				return;
			}
			try {
				if (
					includeBegin &&
					!(await this.writeWorkerSnapshotRecord(
						client,
						snapshotBegin,
						purpose,
						undefined,
						WORKER_SNAPSHOT_TERMINAL_DRAIN_TIMEOUT_MS,
					))
				) {
					if (!client.socket.destroyed) {
						client.socket.destroy(streamError);
					}
					return;
				}
				const delivered = await this.writeWorkerSnapshotRecord(
					client,
					{
						type: "session_snapshot_failed",
						activeSessionId: result.activeSessionId,
						snapshotId: stream.id,
						error: streamError.message,
					},
					purpose,
					undefined,
					WORKER_SNAPSHOT_TERMINAL_DRAIN_TIMEOUT_MS,
				);
				if (!delivered && !client.socket.destroyed) {
					client.socket.destroy(streamError);
				}
			} catch (deliveryError) {
				client.socket.destroy(deliveryError instanceof Error ? deliveryError : new Error(String(deliveryError)));
			}
		};
		try {
			if (transferSignal.aborted) {
				await deliverSnapshotFailure(new Error(`Snapshot ${stream.id} was aborted`), true);
				return;
			}
			if (!(await this.writeWorkerSnapshotRecord(client, snapshotBegin, purpose, transferSignal))) {
				if (transferSignal.aborted) {
					await deliverSnapshotFailure(new Error(`Snapshot ${stream.id} was aborted`));
				}
				return;
			}
			let chunkCount = 0;
			for await (const chunk of transcript) {
				if (transferSignal.aborted) {
					await deliverSnapshotFailure(new Error(`Snapshot ${stream.id} was aborted`));
					return;
				}
				const headerMessage: DaemonOutbound = {
					type: "session_snapshot_chunk",
					activeSessionId: result.activeSessionId,
					snapshotId: stream.id,
					index: chunkCount,
					messages: [],
				};
				if (!(await this.writeWorkerSnapshotBuffer(client, chunk, headerMessage, purpose, transferSignal))) {
					if (transferSignal.aborted) {
						await deliverSnapshotFailure(new Error(`Snapshot ${stream.id} was aborted`));
					}
					return;
				}
				chunkCount++;
			}
			if (transferSignal.aborted) {
				await deliverSnapshotFailure(new Error(`Snapshot ${stream.id} was aborted`));
				return;
			}
			await this.writeWorkerSnapshotRecord(
				client,
				{
					type: "session_snapshot_end",
					activeSessionId: result.activeSessionId,
					snapshotId: stream.id,
					chunkCount,
					lastEventSequence: result.lastEventSequence,
					lastEventCursor: result.lastEventCursor,
				},
				purpose,
				transferSignal,
			);
		} catch (error) {
			if (transferSignal.aborted) {
				await deliverSnapshotFailure(new Error(`Snapshot ${stream.id} was aborted`));
				return;
			}
			const streamError = error instanceof Error ? error : new Error(String(error));
			await deliverSnapshotFailure(streamError);
			throw streamError;
		} finally {
			finishTransfer();
			if (client.snapshotTransferTails.get(result.activeSessionId) === transfer) {
				client.snapshotTransferTails.delete(result.activeSessionId);
			}
			finishClientSnapshotStreaming(client, result.activeSessionId);
			transcript.dispose?.();
			if (!client.snapshotStreaming && client.catchupActiveSessionIds?.size) {
				void this.catchUpBackpressuredClient(client).catch((error) =>
					this.log(`could not catch up snapshot client ${client.id}: ${String(error)}`),
				);
			}
		}
	}

	private writeWorkerSnapshotRecord(
		client: DaemonSocketClient,
		message: DaemonOutbound,
		purpose: "attach" | "replacement" | "catchup",
		signal?: AbortSignal,
		drainTimeoutMs?: number,
	): Promise<boolean> {
		return this.writeWorkerSnapshotBuffer(
			client,
			Buffer.from(serializeJsonLine(message)),
			message,
			purpose,
			signal,
			drainTimeoutMs,
		);
	}

	private async writeWorkerSnapshotBuffer(
		client: DaemonSocketClient,
		buffer: Buffer,
		message: DaemonOutbound,
		purpose: "attach" | "replacement" | "catchup",
		signal?: AbortSignal,
		drainTimeoutMs?: number,
	): Promise<boolean> {
		if (signal?.aborted || client.socket.destroyed) {
			return false;
		}
		if (this.writeSerialized(client, buffer, message, "jsonl", purpose)) {
			return true;
		}
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
			const onAbort = () => finish(false);
			client.socket.once("drain", onDrain);
			client.socket.once("close", onClose);
			client.socket.once("error", onClose);
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

	private createConnectionState(state: ActiveSessionState): ReturnType<typeof createAgentConnectionState> {
		const connectionState = createAgentConnectionState(state.runtime, state.activeSessionId);
		connectionState.heartbeat = this.cronStore.getLatestHeartbeat(state.activeSessionId) ?? null;
		if (state.summaryState?.summary) {
			connectionState.recap = state.summaryState.summary;
		}
		return connectionState;
	}

	private createAgentSessionMessageEndpoint(state: ActiveSessionState): AgentSessionMessageEndpoint {
		const metadata = state.runtime.metadata;
		return {
			activeSessionId: state.activeSessionId,
			sessionId: state.runtime.session.sessionId,
			...(state.runtime.session.sessionName ? { sessionName: state.runtime.session.sessionName } : {}),
			runtimeKind: metadata.kind,
		};
	}

	private createAgentSessionMessageSender(
		state: ActiveSessionState | undefined,
		clientId: string,
	): AgentSessionMessageSender {
		if (!state) {
			return { clientId };
		}
		return {
			...this.createAgentSessionMessageEndpoint(state),
			clientId,
		};
	}

	private createAgentMessageAgentSummary(state: ActiveSessionState): AgentSessionMessageAgentSummary {
		const metadata = state.runtime.metadata;
		const session = state.runtime.session;
		return {
			...this.createAgentSessionMessageEndpoint(state),
			cwd: state.runtime.cwd,
			isStreaming: session.isStreaming,
			unfinishedActionCount: session.unfinishedActionCount,
			...(metadata.parentActiveSessionId ? { parentActiveSessionId: metadata.parentActiveSessionId } : {}),
			...(metadata.parentSessionId ? { parentSessionId: metadata.parentSessionId } : {}),
			...(metadata.parentSessionFile ? { parentSessionPath: metadata.parentSessionFile } : {}),
			rlmDepth: session.rlmDepth,
			status: classifySessionRosterStatus({
				activeSessionId: state.activeSessionId,
				runtimeKind: metadata.kind,
				activity: session.isSessionActive ? "working" : "idle",
				isSessionActive: session.isSessionActive,
				hasRunningRlmChildren: session.hasRunningRlmChildren?.() ?? false,
				isStreaming: session.isStreaming,
			} as SessionSummary),
			...(metadata.rlmChildId ? { rlmChildId: metadata.rlmChildId } : {}),
			...(metadata.sessionDir ? { sessionDir: metadata.sessionDir } : {}),
			...(session.sessionFile ? { sessionPath: session.sessionFile } : {}),
		};
	}

	/**
	 * The cross-worker half of the agent family directory. Two different answers
	 * used to be the same empty array: "there is no supervisor to ask" (this process
	 * is the whole family — a complete answer, nothing to report) and "the ask
	 * failed" (a 1s connect, a 5s request, or a worker token the supervisor no
	 * longer accepts). The consumers are a2a reachability, cross-worker name
	 * uniqueness and the agent_observe roster, all of which phrase their result as
	 * "this agent does not exist" — so the second one has to be visible, or a
	 * one-second hiccup silently redefines the family as "whatever this process can
	 * see" with nothing in the log to trace it back to.
	 */
	private async listSupervisorAgentPeers(): Promise<AgentSessionMessageAgentSummary[]> {
		const supervisorSocketPath = this.supervisorSocketPathFromEnv();
		const link = this.supervisorLink();
		if (!this.options.worker || !link || !supervisorSocketPath) return [];
		try {
			const response = await link.request(
				{ type: "list_agent_peers", workerToken: this.options.worker.authenticationToken },
				5000,
			);
			if (!response.success) throw deserializeDaemonError(response);
			// SAFETY: The authenticated supervisor constructs the peer response.
			return (response.data as { peers: AgentSessionMessageAgentSummary[] }).peers;
		} catch (error) {
			this.logAgentDirectoryIncomplete(supervisorSocketPath, error);
			return [];
		}
	}

	/** Throttled: a supervisor that is down is asked by every session's roster pass. */
	private logAgentDirectoryIncomplete(supervisorSocketPath: string, error: unknown): void {
		const now = Date.now();
		if (now - this.agentDirectoryFailureLoggedAt < AGENT_DIRECTORY_FAILURE_LOG_MIN_GAP_MS) {
			return;
		}
		this.agentDirectoryFailureLoggedAt = now;
		this.log(
			`Agent family directory is incomplete: list_agent_peers on ${supervisorSocketPath} failed, so reachability, name uniqueness and the family roster cover this process only: ${String(error)}`,
		);
	}

	private async createAgentMessageListResult(
		current: ActiveSessionState,
		peers?: AgentSessionMessageAgentSummary[],
	): Promise<AgentSessionMessageListResult> {
		peers ??= await this.listSupervisorAgentPeers();
		const localAgents = this.listTargetableSessionStates(current).map((state) =>
			this.createAgentMessageAgentSummary(state),
		);
		for (const passive of await this.listPassiveRlmSubagents()) {
			const { entry, info } = passive;
			localAgents.push({
				// Before hydration the persisted session id is its supervisor-routable id.
				activeSessionId: info.id,
				sessionId: info.id,
				sessionName: info.name ?? entry.sessionName,
				runtimeKind: "subagent",
				cwd: info.cwd,
				isStreaming: false,
				unfinishedActionCount: 0,
				...(passive.chain.length === 1 && passive.rootParentState
					? { parentActiveSessionId: passive.rootParentState.activeSessionId }
					: {}),
				parentSessionId: entry.parentSessionId,
				parentSessionPath:
					entry.parentSessionFile ??
					passive.chain.at(-2)?.sessionFile ??
					passive.rootParentState?.runtime.session.sessionFile ??
					passive.rootInfo?.path,
				rlmDepth: info.rlmDepth ?? entry.rlmDepth,
				status: "inactive",
				rlmChildId: entry.childId,
				// The summary field reports the persisted registry status; the read-side
				// "stale" demotion of a silent `running` child is a presentation fact this
				// surface does not carry (the session glue already renders non-completed
				// children as errored).
				rlmChildRegistryStatus: entry.status === "stale" ? "running" : entry.status,
				sessionDir: entry.sessionDir,
				sessionPath: entry.sessionFile,
			});
		}
		const localIds = new Set(localAgents.map((agent) => agent.activeSessionId));
		const remoteAgents = peers.filter(
			(peer) => !localIds.has(peer.activeSessionId) && !this.closingSessions.has(peer.activeSessionId),
		);
		return {
			current: this.createAgentSessionMessageEndpoint(current),
			agents: [...localAgents, ...remoteAgents],
		};
	}

	private async createAgentFamilyCatalog(currentState?: ActiveSessionState): Promise<AgentFamilyCatalogEntry[]> {
		const current =
			currentState ?? [...this.sessions.values()].find((state) => !this.bindingSessions.has(state.activeSessionId));
		const remotePeers = current ? await this.listSupervisorAgentPeers() : [];
		const listed = current ? await this.createAgentMessageListResult(current, remotePeers) : { agents: [] };
		const remotePeerSet = new Set(remotePeers);
		const localAgents = current
			? [this.createAgentMessageAgentSummary(current), ...listed.agents.filter((agent) => !remotePeerSet.has(agent))]
			: listed.agents;
		const activePaths = new Set(
			localAgents.flatMap((agent) => (agent.sessionPath ? [canonicalSessionPath(agent.sessionPath)] : [])),
		);
		const savedRoots = (await SessionManager.listAll(undefined, this.options.defaultSessionConfig.sessionDir))
			.filter(
				(info) =>
					(info.rlmDepth ?? (info.parentSessionPath ? -1 : 0)) === 0 &&
					!activePaths.has(canonicalSessionPath(info.path)),
			)
			.map(
				(info): AgentFamilyCatalogEntry => ({
					id: info.id,
					...(info.name ? { name: info.name } : {}),
					depth: info.rlmDepth ?? 0,
					status: "inactive",
					sessionPath: canonicalSessionPath(info.path),
					cwd: info.cwd,
					// Persisted counts only: a saved root's opening prompt stays off the wire,
					// or one roster reply would carry the first message of every saved session.
					messageCount: info.messageCount,
				}),
			);
		const byId = new Map<string, AgentFamilyCatalogEntry>(savedRoots.map((entry) => [entry.id, entry]));
		// `remote` peers live in another worker: their active id stays routable, while a
		// local summary's stand-in id for a passive child is not an active session.
		const addAgent = (agent: AgentSessionMessageAgentSummary, remote = false) => {
			const depth = agent.rlmDepth ?? 0;
			byId.set(agent.sessionId, {
				id: agent.sessionId,
				...(agent.sessionName ? { name: agent.sessionName } : {}),
				depth,
				status: agent.status ?? "idle",
				...(agent.runtimeKind === "subagent"
					? (() => {
							const repliedSinceTask = this.findSessionBySessionFile(agent.sessionPath)?.runtime.session
								.repliedToParentSinceTask;
							return repliedSinceTask === undefined ? {} : { repliedSinceTask };
						})()
					: {}),
				...(depth > 0 && agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
				...(depth > 0 && agent.parentSessionPath
					? { parentSessionPath: canonicalSessionPath(agent.parentSessionPath) }
					: {}),
				...(agent.sessionPath ? { sessionPath: canonicalSessionPath(agent.sessionPath) } : {}),
				...(agent.rlmChildId ? { rlmChildId: agent.rlmChildId } : {}),
				...(remote ? { activeSessionId: agent.activeSessionId } : {}),
				cwd: agent.cwd,
			});
		};
		for (const peer of remotePeers) addAgent(peer, true);
		for (const agent of localAgents) addAgent(agent);
		for (const state of this.sessions.values()) {
			const entry = byId.get(state.runtime.session.sessionId);
			if (entry && state.runtime.session.sessionFile)
				entry.sessionPath = canonicalSessionPath(state.runtime.session.sessionFile);
		}
		for (const passive of await this.listPassiveRlmSubagents()) {
			const entry = byId.get(passive.info.id);
			if (!entry) continue;
			entry.sessionPath = canonicalSessionPath(passive.entry.sessionFile);
			entry.messageCount = passive.info.messageCount;
			entry.firstMessage = passive.info.firstMessage;
		}
		return [...byId.values()];
	}

	/**
	 * The one family directory: membership plus relationship, relative to the session that
	 * asked. `agent_observe.list_agents()` renders it and `agent_message`'s roster projects
	 * it, so both discovery entry points read one construction.
	 */
	private async createAgentFamilyDirectory(currentState: ActiveSessionState): Promise<AgentFamilyDirectory> {
		const catalog = await this.createAgentFamilyCatalog(currentState);
		const current = catalog.find((entry) => entry.id === currentState.runtime.session.sessionId);
		if (!current) throw new Error("Current agent is missing from the family catalog");
		return selectAgentFamilyDirectory(current, catalog);
	}

	private async assertFamilySessionNameAvailable(
		input: {
			name: string;
			depth: number;
			parentSessionId?: string;
			parentSessionPath?: string;
			ignoreSessionId?: string;
		},
		currentState?: ActiveSessionState,
		ignorePendingReservation = false,
	): Promise<void> {
		if (!ignorePendingReservation && this.pendingSessionNames.has(sessionNameReservationKey(input))) {
			throw new Error(formatAgentSessionNameUnavailable(input.name, input.depth));
		}
		assertAgentSessionNameAvailable(await this.createAgentFamilyCatalog(currentState), {
			...input,
			...(input.parentSessionPath ? { parentSessionPath: canonicalSessionPath(input.parentSessionPath) } : {}),
		});
	}

	private resolveHeaderParentSessionPath(state: ActiveSessionState): string | undefined {
		const session = state.runtime.session;
		const headerParent = session.sessionManager?.getHeader?.()?.parentSession;
		if (!headerParent || isAbsolute(headerParent)) return headerParent;
		return session.sessionFile ? resolve(dirname(session.sessionFile), headerParent) : undefined;
	}

	private async assertStateSessionNameAvailable(state: ActiveSessionState, name: string): Promise<void> {
		const session = state.runtime.session;
		const metadata = state.runtime.metadata;
		const depth = session.rlmDepth ?? 0;
		const headerParent = depth > 0 ? this.resolveHeaderParentSessionPath(state) : undefined;
		await this.assertFamilySessionNameAvailable(
			{
				name,
				depth,
				...(depth > 0 && !headerParent && metadata.parentSessionId
					? { parentSessionId: metadata.parentSessionId }
					: {}),
				...(depth > 0 && (headerParent ?? metadata.parentSessionFile)
					? { parentSessionPath: headerParent ?? metadata.parentSessionFile }
					: {}),
				ignoreSessionId: session.sessionId,
			},
			state,
			true,
		);
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

	private async setStateSessionNameViaSupervisor(state: ActiveSessionState, name: string): Promise<void> {
		const link = this.supervisorLink();
		if (!this.options.worker || !link) {
			return this.setStateSessionName(state, name);
		}
		const response = await link.request(
			{
				type: "set_session_name",
				activeSessionId: state.activeSessionId,
				name,
				workerToken: this.options.worker.authenticationToken,
			},
			30_000,
		);
		if (!response.success) throw deserializeDaemonError(response);
	}

	private setStateSessionNameForCommand(state: ActiveSessionState, name: string): Promise<void> {
		return this.options.worker ? this.applyStateSessionName(state, name) : this.setStateSessionName(state, name);
	}

	private async applyStateSessionName(state: ActiveSessionState, name: string): Promise<void> {
		state.runtime.session.setSessionName(name);
		await this.appendRlmLedgerRenameForState(state, name);
	}

	private async setStateSessionName(state: ActiveSessionState, name: string): Promise<void> {
		const normalizedName = name.trim();
		if (!normalizedName) {
			throw new Error("Session name cannot be empty");
		}
		const session = state.runtime.session;
		const metadata = state.runtime.metadata;
		const depth = session.rlmDepth ?? 0;
		const headerParent = depth > 0 ? this.resolveHeaderParentSessionPath(state) : undefined;
		return this.withSessionNameReservation(
			{
				name: normalizedName,
				depth,
				...(depth > 0 && !headerParent && metadata.parentSessionId
					? { parentSessionId: metadata.parentSessionId }
					: {}),
				...(depth > 0 && (headerParent ?? metadata.parentSessionFile)
					? { parentSessionPath: headerParent ?? metadata.parentSessionFile }
					: {}),
			},
			async () => {
				await this.assertStateSessionNameAvailable(state, normalizedName);
				await this.applyStateSessionName(state, normalizedName);
			},
		);
	}

	// Half-bound sessions are hidden from other sessions' listings; the current
	// session stays visible to itself (controllers run during its own bind).
	private listTargetableSessionStates(current: ActiveSessionState): ActiveSessionState[] {
		return [...this.sessions.values()].filter(
			(state) =>
				state.activeSessionId === current.activeSessionId ||
				(!this.bindingSessions.has(state.activeSessionId) && !this.closingSessions.has(state.activeSessionId)),
		);
	}

	private getAgentMessageSafetyStatus() {
		return {
			paused: this.agentMessagesPaused,
			maxMessageChars: DEFAULT_AGENT_MESSAGE_MAX_CHARS,
			maxPendingPerSession: DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
			rateLimitCapacity: DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY,
			rateLimitRefillMs: DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS,
		};
	}

	private createCliAgentMessageSenderKey(): string {
		return `cli:${this.socketPath}`;
	}

	private async clearQueuedAgentSessionMessagesForState(state: ActiveSessionState) {
		return state.runtime.session.clearQueuedAgentMessages();
	}

	private async clearQueuedAgentSessionMessagesForAllStates(): Promise<void> {
		await Promise.all(
			[...this.sessions.values()].map((state) => this.clearQueuedAgentSessionMessagesForState(state)),
		);
	}

	private agentFamilyEntry(state: ActiveSessionState): AgentFamilyCatalogEntry {
		const metadata = state.runtime.metadata;
		const depth = state.runtime.session.rlmDepth ?? 0;
		const headerParent = depth > 0 ? this.resolveHeaderParentSessionPath(state) : undefined;
		const parentSessionPath = depth > 0 ? (headerParent ?? metadata.parentSessionFile) : undefined;
		return {
			id: state.runtime.session.sessionId,
			...(state.runtime.session.sessionName ? { name: state.runtime.session.sessionName } : {}),
			depth,
			status: "running",
			...(depth > 0 && !headerParent && metadata.parentSessionId
				? { parentSessionId: metadata.parentSessionId }
				: {}),
			...(parentSessionPath ? { parentSessionPath: canonicalSessionPath(parentSessionPath) } : {}),
			...(state.runtime.session.sessionFile
				? { sessionPath: canonicalSessionPath(state.runtime.session.sessionFile) }
				: {}),
		};
	}

	private passiveAgentFamilyEntry(passive: PassiveRlmSubagent): AgentFamilyCatalogEntry {
		const entry = passive.entry;
		const depth = passive.info.rlmDepth ?? entry.rlmDepth ?? passive.chain.length;
		const parentSessionPath =
			depth > 0
				? (entry.parentSessionFile ??
					passive.chain.at(-2)?.sessionFile ??
					passive.rootParentState?.runtime.session.sessionFile ??
					passive.rootInfo?.path)
				: undefined;
		return {
			id: passive.info.id,
			name: passive.info.name ?? entry.sessionName,
			depth,
			status: "idle",
			...(depth > 0 && entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
			...(parentSessionPath ? { parentSessionPath: canonicalSessionPath(parentSessionPath) } : {}),
			sessionPath: canonicalSessionPath(entry.sessionFile),
		};
	}

	private async getOrHydrateAuthorizedAgentFamilyTarget(
		currentState: ActiveSessionState,
		target: string,
	): Promise<ActiveSessionState> {
		try {
			return this.getBoundSessionState(target);
		} catch (error) {
			if (error instanceof BoundSessionUnavailableError) {
				const targetState = this.getSessionState(target);
				this.assertAgentFamilyReachable(currentState, targetState);
				return this.getOrHydrateBoundSessionState(target);
			}
			if (error instanceof AmbiguousActiveSessionError) {
				const targetState = this.resolveAgentFamilySessionName(currentState, target, error);
				return this.getOrHydrateBoundSessionState(targetState.activeSessionId);
			}
		}
		const passive = await this.findPassiveRlmSubagent(target);
		if (!passive) return this.getOrHydrateBoundSessionState(target);
		assertAgentFamilyReach(this.agentFamilyEntry(currentState), this.passiveAgentFamilyEntry(passive));
		return this.hydratePassiveRlmSubagent(passive);
	}

	private resolveAgentFamilySessionName(
		currentState: ActiveSessionState,
		target: string,
		ambiguity: AmbiguousActiveSessionError,
	): ActiveSessionState {
		const reachableMatches = new Map(
			[...this.sessions.values()]
				.filter((state) => {
					const session = state.runtime.session;
					return (
						(session.sessionId === target || session.sessionName === target) &&
						(state.activeSessionId === currentState.activeSessionId ||
							this.isAgentFamilyReachable(currentState, state))
					);
				})
				.map((state) => [state.activeSessionId, state]),
		).values();
		const matches = [...reachableMatches];
		if (matches.length !== 1) throw ambiguity;
		return matches[0]!;
	}

	private isAgentFamilyReachable(currentState: ActiveSessionState, targetState: ActiveSessionState): boolean {
		try {
			assertAgentFamilyReach(this.agentFamilyEntry(currentState), this.agentFamilyEntry(targetState));
			return true;
		} catch (error) {
			if (error instanceof Error && error.message === AGENT_FAMILY_REACH_ERROR) return false;
			throw error;
		}
	}

	private assertAgentFamilyReachable(currentState: ActiveSessionState, targetState: ActiveSessionState): void {
		if (currentState.activeSessionId === targetState.activeSessionId) return;
		assertAgentFamilyReach(this.agentFamilyEntry(currentState), this.agentFamilyEntry(targetState));
	}

	private agentMessageRelationship(
		fromState: ActiveSessionState | undefined,
		targetState: ActiveSessionState,
	): AgentFamilyRelationship | undefined {
		if (!fromState) return undefined;
		return agentFamilyRelationship(this.agentFamilyEntry(targetState), this.agentFamilyEntry(fromState));
	}

	private async sendAgentSessionMessage(options: {
		targetSelector: string;
		message: string;
		fromState?: ActiveSessionState;
		/** Pre-computed relationship for senders whose session state is not local (cross-worker delivery). */
		fromRelationship?: AgentFamilyRelationship;
		sender?: AgentSessionMessageSender;
		clientId?: string;
		senderKey?: string;
		origin: "agent" | "cli";
	}): Promise<AgentSessionMessageReceipt> {
		if (this.agentMessagesPaused) {
			throw new Error("Agent messaging is paused");
		}
		const targetSelector = assertDirectAgentMessageTarget(options.targetSelector);
		const message = normalizeAgentSessionMessage(options.message, DEFAULT_AGENT_MESSAGE_MAX_CHARS);
		let targetState: ActiveSessionState;
		try {
			targetState = this.getBoundSessionState(targetSelector);
		} catch (error) {
			if (error instanceof BoundSessionUnavailableError) {
				if (options.origin === "agent" && options.fromState) {
					this.assertAgentFamilyReachable(options.fromState, this.getSessionState(targetSelector));
				}
				targetState = await this.getOrHydrateBoundSessionState(targetSelector);
			} else {
				if (error instanceof AmbiguousActiveSessionError) {
					if (options.origin !== "agent" || !options.fromState) throw error;
					const resolved = this.resolveAgentFamilySessionName(options.fromState, targetSelector, error);
					targetState = await this.getOrHydrateBoundSessionState(resolved.activeSessionId);
				} else {
					const passiveSubagent = await this.findPassiveRlmSubagent(targetSelector);
					if (passiveSubagent) {
						if (options.origin === "agent" && options.fromState) {
							assertAgentFamilyReach(
								this.agentFamilyEntry(options.fromState),
								this.passiveAgentFamilyEntry(passiveSubagent),
							);
						}
						targetState = await this.hydratePassiveRlmSubagent(passiveSubagent);
					} else {
						const hydratingChild = [...this.sessions.values()].find(
							(state) =>
								state.runtime.metadata.kind === "subagent" &&
								state.runtime.metadata.rlmChildId === targetSelector,
						);
						if (hydratingChild) {
							targetState = await this.waitForHydratingChild(hydratingChild, targetSelector);
						} else if (this.options.worker && options.fromState) {
							// The supervisor can resolve and wake a saved worker even when it is no longer
							// present in this worker's resident peer snapshot.
							return this.sendRemoteAgentSessionMessage(options.fromState, targetSelector, message);
						} else {
							throw error;
						}
					}
				}
			}
		}
		if (options.fromState?.activeSessionId === targetState.activeSessionId) {
			throw new Error("Agent messaging cannot target the sending session");
		}
		if (options.origin === "agent" && options.fromState) {
			this.assertAgentFamilyReachable(options.fromState, targetState);
		}
		const senderKey =
			options.senderKey ?? options.fromState?.activeSessionId ?? `client:${options.clientId ?? "unknown"}`;
		const rateLimitKey = `${senderKey}->${targetState.activeSessionId}`;
		const rateLimit = this.agentMessageRateLimiter.tryConsume(rateLimitKey);
		if (!rateLimit.ok) {
			throw new Error(`Agent messaging rate limit exceeded; retry after ${rateLimit.retryAfterMs}ms`);
		}
		const payload: AgentSessionMessagePayload = {
			id: createAgentSessionMessageId(),
			source: AGENT_MESSAGE_SOURCE,
			message,
			from:
				options.sender ??
				this.createAgentSessionMessageSender(options.fromState, options.clientId ?? options.origin),
			// A local fromState is authoritative; the forwarded relationship is the
			// only source when the sender's session lives in another worker.
			fromRelationship: options.fromState
				? this.agentMessageRelationship(options.fromState, targetState)
				: options.fromRelationship,
			target: this.createAgentSessionMessageEndpoint(targetState),
		};
		try {
			const outcome = await this.acceptAgentSessionMessage(targetState, payload);
			// A queued send is a fact the sender must be able to act on: how full the
			// target's queue is, and whether this is a repeat of an unread earlier send.
			const queued =
				outcome.status === "queued"
					? this.recordQueuedAgentMessage(senderKey, targetState.activeSessionId, outcome)
					: this.clearQueuedAgentMessage(senderKey, targetState.activeSessionId);
			return createAgentSessionMessageReceipt(payload, outcome.status, undefined, queued);
		} catch (error) {
			this.agentMessageRateLimiter.refund(rateLimitKey);
			throw error;
		}
	}

	private async sendRemoteAgentSessionMessage(
		fromState: ActiveSessionState,
		targetSelector: string,
		message: string,
	): Promise<AgentSessionMessageReceipt> {
		const link = this.supervisorLink();
		if (!link) {
			throw new Error(`Unknown active session: ${targetSelector}`);
		}
		const deadline = Date.now() + 30_000;
		let lastError: unknown;
		// Connect-window loop only: the supervisor may still be starting up. The
		// message itself is sent exactly once — daemon commands are not idempotent,
		// so a rejected or timed-out send must never be retried.
		while (Date.now() < deadline && !this.shuttingDown) {
			try {
				await link.ensureConnected();
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
			}
		}
		if (lastError !== undefined) {
			throw lastError instanceof Error ? lastError : new Error(`Unknown active session: ${targetSelector}`);
		}
		const response = await link.request(
			{
				type: "send_message",
				targetActiveSessionId: targetSelector,
				message,
				fromActiveSessionId: fromState.activeSessionId,
				agentOrigin: true,
			},
			30_000,
		);
		if (!response.success) {
			throw deserializeDaemonError(response);
		}
		if (!response.data || typeof response.data !== "object") {
			throw new Error("Supervisor returned an invalid agent-message receipt");
		}
		return response.data as AgentSessionMessageReceipt;
	}

	/**
	 * Consecutive queued-but-unread sends per sender→target pair. Bounded: an entry
	 * is dropped as soon as a send to that target is delivered, and the map is capped
	 * so a long-lived daemon cannot accumulate one row per historical pair.
	 */
	private readonly agentMessageQueuedRuns = new Map<string, { count: number; firstQueuedAt: number }>();

	private recordQueuedAgentMessage(
		senderKey: string,
		targetActiveSessionId: string,
		outcome: { queuedReason?: AgentMessageQueuedReason; queuedPosition?: number },
	): AgentSessionMessageQueuedFacts {
		const key = `${senderKey}->${targetActiveSessionId}`;
		const previous = this.agentMessageQueuedRuns.get(key);
		const count = (previous?.count ?? 0) + 1;
		this.agentMessageQueuedRuns.delete(key);
		this.agentMessageQueuedRuns.set(key, { count, firstQueuedAt: previous?.firstQueuedAt ?? Date.now() });
		while (this.agentMessageQueuedRuns.size > AGENT_MESSAGE_QUEUED_RUN_TRACKING_LIMIT) {
			const oldest = this.agentMessageQueuedRuns.keys().next();
			if (oldest.done === true) break;
			this.agentMessageQueuedRuns.delete(oldest.value);
		}
		if (count > 1) {
			// Countable signature for "the same sender keeps queueing into a target
			// that is not reading" (appendix B).
			structuredLog.info("agent message queued repeat (same target)", {
				senderKey,
				targetActiveSessionId,
				count,
				queuedReason: outcome.queuedReason,
			});
		}
		return {
			reason: outcome.queuedReason,
			position: outcome.queuedPosition,
			repeatCount: count,
			notice: formatAgentMessageQueuedNotice({
				reason: outcome.queuedReason,
				position: outcome.queuedPosition,
				maxPending: DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
				repeatCount: count,
				previousQueuedSecondsAgo: previous
					? Math.max(1, Math.round((Date.now() - previous.firstQueuedAt) / 1000))
					: undefined,
			}),
		};
	}

	private clearQueuedAgentMessage(senderKey: string, targetActiveSessionId: string): undefined {
		this.agentMessageQueuedRuns.delete(`${senderKey}->${targetActiveSessionId}`);
		return undefined;
	}

	private async acceptAgentSessionMessage(
		targetState: ActiveSessionState,
		payload: AgentSessionMessagePayload,
	): Promise<{
		status: AgentSessionMessageDeliveryStatus;
		queuedReason?: AgentMessageQueuedReason;
		queuedPosition?: number;
	}> {
		const message = createAgentSessionMessage(payload);
		let preflightFailed = false;
		let preflightQueued = false;
		let queuedReason: AgentMessageQueuedReason | undefined;
		await targetState.runtime.session.acceptAgentMessagePrompt(message.content, {
			expandPromptTemplates: false,
			streamingBehavior: "steer",
			queueIfBusy: true,
			customMessage: message,
			admissionCommitted: () => {
				if (this.agentMessagesPaused) {
					throw new Error("Agent messaging is paused");
				}
				if (
					!this.sessions.has(targetState.activeSessionId) ||
					this.closingSessions.has(targetState.activeSessionId)
				) {
					throw new Error("Target session is closing before agent message delivery");
				}
				if (targetState.runtime.session.sessionId !== payload.target.sessionId) {
					throw new Error("Target session changed before agent message delivery");
				}
			},
			preflightResult: (didSucceed, didQueue, reason) => {
				preflightFailed = !didSucceed;
				preflightQueued = didSucceed && didQueue === true;
				if (preflightQueued) queuedReason = reason;
			},
		});
		if (preflightFailed) {
			throw new Error("Agent message was not accepted");
		}
		if (!preflightQueued) return { status: "delivered" };
		return {
			status: "queued",
			queuedReason,
			queuedPosition: targetState.runtime.session.unfinishedActionCount,
		};
	}

	private detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void {
		const acpMcpOwner = this.acpMcpOwners.get(state.activeSessionId);
		if (acpMcpOwner?.client === client && !acpMcpOwner.release) {
			const release = state.runtime.session.releaseAcpMcpServers(acpMcpOwner.ownerId, acpMcpOwner.serverNames);
			acpMcpOwner.release = release;
			void release
				.catch((error) => this.log(`failed to release detached ACP MCP config: ${String(error)}`))
				.finally(() => {
					if (this.acpMcpOwners.get(state.activeSessionId) === acpMcpOwner) {
						this.acpMcpOwners.delete(state.activeSessionId);
					}
				});
		}
		this.abortSideQuestionsFor(client, state.activeSessionId);
		abortClientSnapshotStreaming(client, state.activeSessionId);
		detachClientFromActiveSession(client, state);
		if (client.authenticationRole === "session_client") this.scheduleRosterFlush();
		this.write(client, {
			type: "session_detached",
			activeSessionId: state.activeSessionId,
		});
		// Discard an abandoned empty draft rather than retaining an empty session file.
		// Abandoned new-chat: discard it so it doesn't linger in memory or leave an
		// empty file. Replaces the old DeferredAgentConnection.
		if (this.isDiscardableDraft(state)) {
			// Re-check after yielding: a client may reattach before the async close
			// runs, in which case the draft is no longer abandoned and must be kept.
			queueMicrotask(() => {
				if (this.sessions.has(state.activeSessionId) && this.isDiscardableDraft(state)) {
					void this.closeSession(state, "killed");
				}
			});
		}
	}

	private isDiscardableDraft(state: ActiveSessionState): boolean {
		if (this.options.worker) {
			return false;
		}
		if (state.clients.size > 0) {
			return false;
		}
		if (state.runtime.metadata.kind === "subagent") {
			return false;
		}
		if (state.runtime.session.isBashRunning || hasLiveSessionWork(state)) {
			return false;
		}
		return this.isEmptyDraftContent(state);
	}

	/**
	 * True when a session holds nothing worth persisting: no messages, no user
	 * config (model/name/etc.), and no scheduled jobs. Shared by the detach-time
	 * discard and the close-time file deletion so both agree on what an abandoned
	 * draft is.
	 */
	private isEmptyDraftContent(state: ActiveSessionState): boolean {
		const session = state.runtime.session;
		if (session.messages.length > 0 || session.sessionManager.hasUserContent()) {
			return false;
		}
		return !this.hasScheduledJobsForSession(state.activeSessionId);
	}

	private createUpdateRestartSession(state: ActiveSessionState): DaemonUpdateRestartSession | undefined {
		const session = state.runtime.session;
		const queue = {
			actions: session.getSessionActionRecoverySnapshot(),
			nextTurn: [...session.getPendingNextTurnMessageSnapshots()],
		};
		const hasQueuedMessages = queue.actions.actions.length > 0 || queue.nextTurn.length > 0;
		const wasStreaming = session.isStreaming;
		const wasCompacting = session.isCompacting;
		const wasBashRunning = session.isBashRunning;
		const hadRunningRlmChildren = session.hasRunningRlmChildren();
		const wasRetrying = session.isRetrying;
		const hadAcceptedPromptInFlight = session.hasAcceptedPromptInFlight;
		const shouldResume =
			wasStreaming ||
			wasCompacting ||
			wasBashRunning ||
			hadRunningRlmChildren ||
			wasRetrying ||
			hadAcceptedPromptInFlight ||
			queue.actions.actions.length > 0;
		const sessionFile =
			session.sessionFile ??
			(hasQueuedMessages || shouldResume
				? session.sessionManager.writeCheckpointFile(
						state.runtime.runtimeConfig?.sessionDir ?? this.options.defaultSessionConfig.sessionDir,
					)
				: undefined);
		if (sessionFile && !session.sessionManager.allowsPersistence()) {
			this.updateRestart?.memoryCheckpointFiles.add(sessionFile);
		}
		if (!sessionFile || (this.isEmptyDraftContent(state) && !hasQueuedMessages && !shouldResume)) {
			return undefined;
		}
		return {
			activeSessionId: state.activeSessionId,
			sessionId: session.sessionId,
			sessionFile,
			...(session.sessionManager.allowsPersistence() ? {} : { persistence: "memory" as const }),
			cwd: session.sessionManager.getCwd(),
			config: {
				...state.runtime.runtimeConfig,
				cwd: session.sessionManager.getCwd(),
			},
			runtimeMetadata: state.runtime.metadata,
			...(state.clientEnv ? { clientEnv: { ...state.clientEnv } } : {}),
			queue,
			shouldResume,
			wasStreaming,
			wasCompacting,
			wasBashRunning,
			hadRunningRlmChildren,
			wasRetrying,
			hadAcceptedPromptInFlight,
		};
	}

	private appendUpdateRestartMarker(state: ActiveSessionState, restartSession: DaemonUpdateRestartSession): void {
		if (!restartSession.shouldResume) {
			return;
		}
		state.runtime.session.sessionManager.appendCustomMessageEntry(
			"prime-agent.update_restart",
			UPDATE_RESTART_MARKER,
			false,
			{
				activeSessionId: restartSession.activeSessionId,
				wasStreaming: restartSession.wasStreaming,
				wasCompacting: restartSession.wasCompacting,
				wasBashRunning: restartSession.wasBashRunning,
				hadRunningRlmChildren: restartSession.hadRunningRlmChildren,
				wasRetrying: restartSession.wasRetrying,
				hadAcceptedPromptInFlight: restartSession.hadAcceptedPromptInFlight,
			},
		);
	}

	private writeUpdateRestartManifest(manifest: DaemonUpdateRestartManifest): void {
		const path = getDaemonUpdateRestartManifestPath(this.socketPath, this.agentDir);
		writeUpdateRestartManifestFile(path, manifest);
	}

	private getUpdateRestartSessionDepth(state: ActiveSessionState): number {
		let depth = 0;
		let metadata: AgentSessionRuntimeMetadata = state.runtime.metadata;
		const seen = new Set<string>([state.activeSessionId]);
		while (metadata.parentActiveSessionId && !seen.has(metadata.parentActiveSessionId)) {
			const parent = this.sessions.get(metadata.parentActiveSessionId);
			if (!parent) {
				break;
			}
			seen.add(parent.activeSessionId);
			depth++;
			metadata = parent.runtime.metadata;
		}
		return depth;
	}

	private assertUpdateRestartNotCancelled(transaction: { id: symbol; abort: AbortController }): void {
		if (transaction.abort.signal.aborted || this.updateRestart?.id !== transaction.id) {
			throw new Error("Update restart preparation cancelled");
		}
	}

	private beginUpdateRestartTransaction(owner?: DaemonSocketClient): NonNullable<AgentDaemon["updateRestart"]> {
		if (this.updateRestart) throw new Error("Daemon is already preparing an update restart");
		const transaction: NonNullable<AgentDaemon["updateRestart"]> = {
			id: Symbol("update-restart"),
			...(owner ? { owner } : {}),
			abort: new AbortController(),
			phase: "preparing",
			memoryCheckpointFiles: new Set(),
			deferredClientEnv: [],
		};
		this.updateRestart = transaction;
		this.cronScheduler.stop();
		transaction.deadline = setTimeout(() => {
			transaction.abort.abort();
			this.cancelPreparedUpdateRestart(transaction.id);
		}, UPDATE_RESTART_PREPARE_TIMEOUT_MS);
		transaction.deadline.unref();
		return transaction;
	}

	private async runUpdateRestartPreparation(
		transaction: NonNullable<AgentDaemon["updateRestart"]>,
	): Promise<DaemonUpdateRestartManifest> {
		try {
			await this.mutationDrain.waitForDrain(0, transaction.abort.signal, "Update restart preparation cancelled");
			this.assertUpdateRestartNotCancelled(transaction);
			transaction.phase = "fencing";
			await this.mutationDrain.waitForDrain(0, transaction.abort.signal, "Update restart preparation cancelled");
			this.assertUpdateRestartNotCancelled(transaction);
			const manifest = await this.prepareUpdateRestartCheckpoint(transaction);
			this.assertUpdateRestartNotCancelled(transaction);
			transaction.manifest = manifest;
			transaction.phase = "prepared";
			return manifest;
		} catch (error) {
			this.cancelPreparedUpdateRestart(transaction.id);
			throw error;
		}
	}

	private async prepareUpdateRestartCheckpoint(
		transaction: NonNullable<AgentDaemon["updateRestart"]>,
	): Promise<DaemonUpdateRestartManifest> {
		const signal = transaction.abort.signal;
		try {
			const states = [...this.sessions.values()];
			this.updateRestartQueuePauses.clear();
			for (const state of states) {
				this.updateRestartQueuePauses.set(state.activeSessionId, state.runtime.session.acquireQueuedWorkPause());
			}
			await Promise.all(states.map((state) => state.runtime.session.waitForSessionInputCheckpoint(signal)));
			this.assertUpdateRestartNotCancelled(transaction);
			const snapshottedIds = new Set(states.map((state) => state.activeSessionId));
			const addedSession = [...this.sessions.keys()].find((activeSessionId) => !snapshottedIds.has(activeSessionId));
			if (addedSession) throw new Error(`Session ${addedSession} became resident during update preparation`);

			const restartSessions = states
				.filter((state) => this.sessions.get(state.activeSessionId) === state)
				.map((state) => this.createUpdateRestartSession(state))
				.filter((session): session is DaemonUpdateRestartSession => session !== undefined)
				.sort((left, right) => {
					const leftState = this.sessions.get(left.activeSessionId);
					const rightState = this.sessions.get(right.activeSessionId);
					return (
						(leftState ? this.getUpdateRestartSessionDepth(leftState) : 0) -
						(rightState ? this.getUpdateRestartSessionDepth(rightState) : 0)
					);
				});
			this.assertUpdateRestartNotCancelled(transaction);
			const includedActiveSessionIds = new Set(restartSessions.map((session) => session.activeSessionId));
			const discardedActiveSessionIds = states
				.filter(
					(state) =>
						this.sessions.get(state.activeSessionId) === state &&
						!includedActiveSessionIds.has(state.activeSessionId),
				)
				.map((state) => state.activeSessionId);
			return {
				formatVersion: DAEMON_UPDATE_RESTART_FORMAT_VERSION,
				createdAt: new Date().toISOString(),
				sessions: restartSessions,
				...(discardedActiveSessionIds.length > 0 ? { discardedActiveSessionIds } : {}),
			};
		} catch (error) {
			this.cancelPreparedUpdateRestart(transaction.id);
			throw error;
		}
	}

	private async commitPreparedUpdateRestart(transactionId: symbol): Promise<DaemonUpdateRestartManifest> {
		const transaction = this.updateRestart;
		if (transaction?.id !== transactionId || !transaction.manifest) {
			throw new Error("Daemon has no prepared update checkpoint");
		}
		const manifest = transaction.manifest;
		const restartByActiveSessionId = new Map(manifest.sessions.map((session) => [session.activeSessionId, session]));
		for (const state of this.sessions.values()) {
			const restartSession = restartByActiveSessionId.get(state.activeSessionId);
			if (restartSession) this.appendUpdateRestartMarker(state, restartSession);
		}
		const closeStates = [...this.sessions.values()].sort(
			(left, right) => this.getUpdateRestartSessionDepth(right) - this.getUpdateRestartSessionDepth(left),
		);
		for (const state of closeStates) {
			if (this.sessions.has(state.activeSessionId)) {
				await this.closeSession(state, restartByActiveSessionId.has(state.activeSessionId) ? "update" : "killed");
			}
		}
		for (const state of [...this.sessions.values()]) await this.closeSession(state, "killed");
		return manifest;
	}

	private removeMemoryRestartCheckpoints(manifest: DaemonUpdateRestartManifest | undefined): void {
		for (const session of manifest?.sessions ?? []) {
			if (session.persistence === "memory") rmSync(session.sessionFile, { force: true });
		}
	}

	private cancelPreparedUpdateRestart(transactionId?: symbol): void {
		const transaction = this.updateRestart;
		if (!transaction || (transactionId && transaction.id !== transactionId)) return;
		if (transaction.deadline) clearTimeout(transaction.deadline);
		transaction.deadline = undefined;
		transaction.abort.abort();
		if (transaction.phase === "publishing") return;
		this.removeMemoryRestartCheckpoints(transaction.manifest);
		for (const path of transaction.memoryCheckpointFiles) rmSync(path, { force: true });
		transaction.memoryCheckpointFiles.clear();
		this.updateRestart = undefined;
		for (const deferred of transaction.deferredClientEnv) {
			if (
				this.sessions.get(deferred.state.activeSessionId) === deferred.state &&
				deferred.state.clients.has(deferred.client) &&
				deferred.client.attachedActiveSessionIds.has(deferred.state.activeSessionId)
			) {
				this.adoptClientEnv(deferred.state, deferred.env);
			}
		}
		transaction.deferredClientEnv.length = 0;
		for (const pause of this.updateRestartQueuePauses.values()) pause.release();
		this.updateRestartQueuePauses.clear();
		if (!this.shuttingDown) {
			this.peerAdmissionsFenced = false;
			this.cronScheduler.start();
		}
	}

	private async prepareUpdateRestart(): Promise<DaemonUpdateRestartManifest> {
		const transaction = this.beginUpdateRestartTransaction();
		try {
			const manifest = await this.runUpdateRestartPreparation(transaction);
			if (transaction.deadline) clearTimeout(transaction.deadline);
			transaction.deadline = undefined;
			transaction.phase = "publishing";
			this.writeUpdateRestartManifest(manifest);
			return await this.commitPreparedUpdateRestart(transaction.id);
		} catch (error) {
			if (this.updateRestart === transaction && transaction.phase === "publishing") {
				transaction.phase = "prepared";
			}
			this.cancelPreparedUpdateRestart(transaction.id);
			throw error;
		}
	}

	private hasScheduledJobsForSession(activeSessionId: string): boolean {
		return this.cronStore
			.list()
			.some(
				(job) =>
					job.activeSessionId === activeSessionId && job.status !== "cancelled" && job.status !== "completed",
			);
	}

	private detachClient(client: DaemonSocketClient): void {
		for (const activeSessionId of [...client.attachedActiveSessionIds]) {
			const state = this.sessions.get(activeSessionId);
			if (state) {
				this.detachClientFromSession(client, state);
			}
		}
		abortClientSnapshotStreaming(client);
	}

	private findActiveSessionByFile(sessionPath: string): ActiveSessionState | undefined {
		const canonicalPath = canonicalSessionPath(sessionPath);
		for (const state of this.sessions.values()) {
			const sessionFile = state.runtime.session.sessionFile;
			if (sessionFile && canonicalSessionPath(sessionFile) === canonicalPath) {
				return state;
			}
		}
		return undefined;
	}

	private abortWaitingPromptAdmissionsForSession(activeSessionId: string): void {
		for (const admission of this.promptAdmissions.values()) {
			if (admission.activeSessionId === activeSessionId && admission.status === "waiting") {
				admission.status = "cancelled";
				admission.controller?.abort();
			}
		}
	}

	private async closeSession(
		state: ActiveSessionState,
		reason: DaemonSessionClosedReason,
		waitForAbort = true,
		cascadeChildren = true,
		descendantCollector?: Set<ActiveSessionState>,
		disposal?: AgentSessionRuntimeDisposeOptions,
	): Promise<void> {
		this.abortWaitingPromptAdmissionsForSession(state.activeSessionId);
		for (const client of state.clients) {
			this.abortSideQuestionsFor(client, state.activeSessionId);
		}
		const existingClose = this.closingSessions.get(state.activeSessionId);
		if (existingClose) {
			const requestedReason = this.isStrongerCloseReason(reason, existingClose.reason)
				? reason
				: existingClose.reason;
			let closeError: unknown;
			let closeFailed = false;
			try {
				await existingClose.promise;
			} catch (error) {
				closeError = error;
				closeFailed = true;
			}
			const reasonUpgrade = (existingClose.reasonUpgrade ?? Promise.resolve()).then(() => {
				if (!this.isStrongerCloseReason(requestedReason, existingClose.reason)) return;
				try {
					this.applyReasonUpgrade(state, existingClose.descendants, existingClose.reason, requestedReason);
				} finally {
					existingClose.reason = requestedReason;
				}
			});
			existingClose.reasonUpgrade = reasonUpgrade.catch(() => undefined);
			try {
				await reasonUpgrade;
			} finally {
				descendantCollector?.add(state);
				for (const descendant of existingClose.descendants) descendantCollector?.add(descendant);
			}
			if (closeFailed) throw closeError;
			return;
		}
		const descendants = new Set<ActiveSessionState>();
		const closePromise = Promise.resolve().then(() =>
			this.closeSessionOnce(state, reason, waitForAbort, cascadeChildren, descendants, disposal),
		);
		const close = { promise: closePromise, reason, descendants };
		this.closingSessions.set(state.activeSessionId, close);
		try {
			await closePromise;
		} finally {
			descendantCollector?.add(state);
			for (const descendant of descendants) descendantCollector?.add(descendant);
			if (this.closingSessions.get(state.activeSessionId) === close) {
				this.closingSessions.delete(state.activeSessionId);
			}
		}
	}

	private closeReasonStrength(reason: DaemonSessionClosedReason): number {
		if (reason === "killed") return 2;
		if (reason === "completed" || reason === "replaced") return 1;
		return 0;
	}

	private isStrongerCloseReason(candidate: DaemonSessionClosedReason, current: DaemonSessionClosedReason): boolean {
		return this.closeReasonStrength(candidate) > this.closeReasonStrength(current);
	}

	private applyReasonUpgrade(
		state: ActiveSessionState,
		descendants: ReadonlySet<ActiveSessionState>,
		from: DaemonSessionClosedReason,
		to: DaemonSessionClosedReason,
	): void {
		let persistError: unknown;
		let persistenceFailed = false;
		for (const target of [state, ...descendants]) {
			try {
				if (to === "killed") this.cancelScheduledJobsForSession(target);
			} catch (error) {
				if (!persistenceFailed) persistError = error;
				persistenceFailed = true;
			}
			try {
				if (this.closeKeepsResumeEntry(from)) this.archiveSession(target);
			} catch (error) {
				if (!persistenceFailed) persistError = error;
				persistenceFailed = true;
			}
		}
		if (persistenceFailed) throw persistError;
	}

	private closeKeepsResumeEntry(reason: DaemonSessionClosedReason): boolean {
		return reason === "shutdown" || reason === "update";
	}

	private archiveSession(state: ActiveSessionState): void {
		state.runtime.session.sessionManager.appendSessionState({ status: "archived" });
	}

	private async abortBashForClose(state: ActiveSessionState): Promise<void> {
		const session = state.runtime.session;
		if (!session.isBashRunning) {
			return;
		}
		session.abortBash();
		await Promise.race([state.inFlightBash ?? Promise.resolve(), delay(UPDATE_RESTART_ABORT_BASH_TIMEOUT_MS)]);
	}

	private async closeSessionOnce(
		state: ActiveSessionState,
		reason: DaemonSessionClosedReason,
		waitForAbort: boolean,
		cascadeChildren: boolean,
		descendants: Set<ActiveSessionState>,
		disposal?: AgentSessionRuntimeDisposeOptions,
	): Promise<void> {
		if (!this.sessions.has(state.activeSessionId)) {
			return;
		}
		if (reason === "killed") {
			this.cancelScheduledJobsForSession(state);
		} else if (reason !== "shutdown" && reason !== "update") {
			this.cancelSubagentRlmHeartbeats(state);
		}
		// Abort in-flight status work before any await/dispose so it can't write
		// agent_status to a session being torn down.
		this.summarizer.forget(state.activeSessionId);
		const cascadeError = cascadeChildren
			? await this.closeChildSessions(state, reason, waitForAbort, descendants, disposal)
			: undefined;
		// Empty draft (no messages, config, or jobs): discard rather than persist an
		// empty session file. Mirrors the detach-time discard so a config-bearing
		// draft closed via kill/completed is never wiped.
		const keepsResumeEntry = this.closeKeepsResumeEntry(reason);
		const isEmptyDraftSession = !keepsResumeEntry && this.isEmptyDraftContent(state);
		let persistError: unknown;
		// Clean shutdown leaves the session un-archived so it stays in the resume list.
		if (!keepsResumeEntry && !isEmptyDraftSession) {
			try {
				this.archiveSession(state);
			} catch (error) {
				persistError = error;
			}
		}
		cancelPendingExtensionUiRequests(state);
		if (reason === "killed" || reason === "shutdown" || reason === "replaced" || reason === "update") {
			await this.abortBashForClose(state);
		}
		if (reason === "update") {
			state.runtime.session.abortForUpdateRestart();
		}
		if (reason === "killed") {
			const abort = state.runtime.session.abort().catch(() => undefined);
			if (waitForAbort) {
				await abort;
			}
		} else if (reason === "shutdown" || reason === "replaced") {
			await state.runtime.session.abort().catch(() => undefined);
		}
		this.recordWorkerRecoveryState(state, `closed:${reason}`, false);
		state.unsubscribe?.();
		let disposeError: unknown;
		try {
			await state.runtime.dispose(disposal);
		} catch (error) {
			disposeError = error;
		}
		for (const client of state.clients) {
			abortClientSnapshotStreaming(client, state.activeSessionId);
		}
		this.broadcastToSession(state, { type: "session_closed", activeSessionId: state.activeSessionId, reason });
		for (const client of state.clients) {
			client.attachedActiveSessionIds.delete(state.activeSessionId);
			removeDaemonClientSessionCapabilities(client, state.activeSessionId);
		}
		state.clients.clear();
		this.acpMcpOwners.delete(state.activeSessionId);
		this.transcriptSerializationCaches.delete(state.activeSessionId);
		this.sessions.delete(state.activeSessionId);
		// Archived top-level sessions leave the worker's list; subagent rows mirror the registry and stay.
		if (!keepsResumeEntry && state.runtime.metadata.kind !== "subagent" && this.options.worker) {
			this.rosterReporter.removedAgentIds.set(this.rosterAgentIdForState(state), state.runtime.session.sessionId);
		}
		this.scheduleRosterFlush();
		if (isEmptyDraftSession) {
			const sessionFile = state.runtime.session.sessionFile;
			if (sessionFile) {
				await deleteSessionFile(sessionFile).catch(() => undefined);
			}
		}
		if (disposeError) {
			throw disposeError;
		}
		if (persistError && !keepsResumeEntry && reason !== "completed") {
			throw persistError;
		}
		if (cascadeError && !keepsResumeEntry && reason !== "completed") {
			throw cascadeError;
		}
	}

	private async closeChildSessions(
		parentState: ActiveSessionState,
		reason: DaemonSessionClosedReason,
		waitForAbort = true,
		descendants = new Set<ActiveSessionState>(),
		disposal?: AgentSessionRuntimeDisposeOptions,
	): Promise<unknown> {
		let cascadeError: unknown;
		for (const childState of getChildActiveSessionStates(this.sessions, parentState)) {
			descendants.add(childState);
			try {
				await this.closeSession(childState, reason, waitForAbort, true, descendants, disposal);
			} catch (error) {
				cascadeError ??= error;
			}
		}
		return cascadeError;
	}

	private broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void {
		if (message.type === "session_event") {
			const eventType = message.event.type;
			// A finished turn/compaction is the cue to refresh status.
			if (eventType === "turn_end" || eventType === "compaction_end") {
				this.summarizer.notifyActivity(state);
			}
			// A draft whose last client detached while it was busy isn't discardable
			// at detach time; re-check once any work (turn, compaction, or bash)
			// settles so it doesn't linger in the daemon.
			if (
				(eventType === "turn_end" || eventType === "compaction_end" || eventType === "bash_end") &&
				this.isDiscardableDraft(state)
			) {
				void this.closeSession(state, "killed");
			}
			if (RECOVERY_CHECKPOINT_EVENTS.has(eventType)) {
				this.recordWorkerRecoveryState(state, eventType);
			}
		}
		this.stampRlmChildActiveSessionId(message);
		this.observeRosterEvent(state, message);
		const sequencedMessage = this.addSessionEventMeta(state, message);
		let serialized: string | undefined;
		for (const client of state.clients) {
			if (!shouldSendDaemonOutboundToClient(client, sequencedMessage)) {
				continue;
			}
			if (sequencedMessage.type === "session_closed") {
				client.catchupActiveSessionIds?.delete(state.activeSessionId);
				client.catchupPurposes?.delete(state.activeSessionId);
				this.write(client, sequencedMessage);
				continue;
			}
			if (client.snapshotActiveSessionIds?.has(state.activeSessionId)) {
				this.queueClientCatchup(
					client,
					state.activeSessionId,
					sequencedMessage.type === "session_replaced" ? "replacement" : "resync",
				);
				continue;
			}
			if (client.backpressured === true) {
				this.queueClientCatchup(
					client,
					state.activeSessionId,
					sequencedMessage.type === "session_replaced" ? "replacement" : "resync",
				);
				continue;
			}
			if (
				sequencedMessage.type === "session_replaced" &&
				client.transport === "private-framed" &&
				daemonClientCapabilitiesForSession(client, state.activeSessionId).has("chunked_snapshot")
			) {
				this.beginReplacementSnapshot(client, state, sequencedMessage);
				continue;
			}
			if (client.transport === "private-framed") {
				this.write(client, sequencedMessage);
			} else {
				serialized ??= serializeJsonLine(sequencedMessage);
				this.writeSerialized(client, serialized, sequencedMessage);
			}
		}
	}

	private beginReplacementSnapshot(
		client: DaemonSocketClient,
		state: ActiveSessionState,
		message: Extract<DaemonOutbound, { type: "session_replaced" }>,
	): void {
		const snapshotId = this.nextSnapshotId(state);
		// Mark before the registry read so later events queue behind this snapshot.
		const snapshotSignal = markClientSnapshotStreaming(client, state.activeSessionId);
		void this.prepareReplacementSnapshot(client, state, message, snapshotId, snapshotSignal).catch((error) => {
			finishClientSnapshotStreaming(client, state.activeSessionId);
			this.log(`could not prepare replacement snapshot: ${String(error)}`);
			if (!client.socket.destroyed && this.sessions.get(state.activeSessionId) === state) {
				this.write(client, message);
			}
			if (!client.snapshotStreaming && client.catchupActiveSessionIds?.size) {
				void this.catchUpBackpressuredClient(client).catch((catchupError) =>
					this.log(`could not catch up replacement snapshot: ${String(catchupError)}`),
				);
			}
		});
	}

	private async prepareReplacementSnapshot(
		client: DaemonSocketClient,
		state: ActiveSessionState,
		message: Extract<DaemonOutbound, { type: "session_replaced" }>,
		snapshotId: string,
		snapshotSignal: AbortSignal,
	): Promise<void> {
		const result = await this.createAttachResult(client, state, {
			type: "attach",
			activeSessionId: state.activeSessionId,
		});
		if (this.sessions.get(state.activeSessionId) !== state) {
			finishClientSnapshotStreaming(client, state.activeSessionId);
			if (!client.snapshotStreaming && client.catchupActiveSessionIds?.size) {
				void this.catchUpBackpressuredClient(client).catch((catchupError) =>
					this.log(`could not catch up replacement snapshot: ${String(catchupError)}`),
				);
			}
			return;
		}
		const transcript = createSnapshotTranscriptChunks({
			activeSessionId: state.activeSessionId,
			snapshotId,
			messages: result.snapshot.messages,
			serializedMessages: this.serializedTranscriptFor(state, result.snapshot.messages),
			targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
			signal: snapshotSignal,
		});
		this.write(client, { ...message, messages: [], snapshotFollows: true });
		void this.streamWorkerSnapshot(
			client,
			{
				...result,
				messages: result.messages ? [] : undefined,
				snapshot: { ...result.snapshot, messages: [] },
				snapshotStream: {
					id: snapshotId,
					messageCount: result.snapshot.messages.length,
					targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
				},
			},
			transcript,
			"replacement",
			snapshotSignal,
			true,
		).catch((error) => {
			this.log(`could not stream replacement snapshot: ${String(error)}`);
			this.queueClientCatchup(client, state.activeSessionId, "replacement");
			if (!client.snapshotStreaming) {
				void this.catchUpBackpressuredClient(client).catch((catchupError) =>
					this.log(`could not catch up replacement snapshot: ${String(catchupError)}`),
				);
			}
		});
	}

	private broadcastGlobal(message: DaemonOutbound): void {
		for (const client of this.clients) {
			this.write(client, message);
		}
	}

	private rosterEntryForSessionPath(canonicalPath: string): WorkerRosterEntry | undefined {
		for (const entry of this.rosterReporter.lastComposed.values()) {
			if (entry.summary.sessionFile && canonicalSessionPath(entry.summary.sessionFile) === canonicalPath) {
				return entry;
			}
		}
		return undefined;
	}

	private rosterAgentIdForState(state: ActiveSessionState): string {
		const session = state.runtime.session;
		const metadata = state.runtime.metadata;
		if (metadata.kind === "subagent" && metadata.rlmChildId) {
			return rosterAgentIdForSummary({
				runtimeKind: "subagent",
				rlmChildId: metadata.rlmChildId,
				sessionId: metadata.rlmChildId,
				parentSessionPath: metadata.parentSessionFile,
				parentActiveSessionId: metadata.parentActiveSessionId,
			});
		}
		return session.sessionId;
	}

	/** Two resident states sharing an agentId would mix reuse and recompute for one row; callers fall back to a full rebuild. */
	private hasDuplicateRosterAgentIds(): boolean {
		const seen = new Set<string>();
		for (const state of this.sessions.values()) {
			const agentId = this.rosterAgentIdForState(state);
			if (seen.has(agentId)) return true;
			seen.add(agentId);
		}
		return false;
	}

	private rosterAgentIdForRlmChild(childId: string, parentSessionPath: string | undefined): string {
		return rosterAgentIdForSummary({
			runtimeKind: "subagent",
			rlmChildId: childId,
			sessionId: childId,
			parentSessionPath,
		});
	}

	private observeRosterEvent(state: ActiveSessionState, message: DaemonOutbound): void {
		if (!this.options.worker) return;
		if (message.type === "session_event") {
			if (message.event.type === "rlm_child_update") {
				this.observeRosterChildUpdate(state, message.event.child);
				return;
			}
			if (!ROSTER_SESSION_EVENT_TRIGGERS.has(message.event.type)) return;
		} else if (
			message.type !== "session_status" &&
			message.type !== "session_closed" &&
			message.type !== "session_replaced"
		) {
			return;
		}
		this.scheduleRosterFlush({ activeSessionId: state.activeSessionId });
	}

	private observeRosterChildUpdate(state: ActiveSessionState, child: AgentConnectionRlmChildAgentSnapshot): void {
		const bound = child.activeSessionId !== undefined || this.hasSessionForRlmChild(state, child.id);
		const entry = this.queuedChildRosterEntry(state, child);
		if (!bound && (child.status === "queued" || child.status === "running")) {
			this.rosterReporter.queuedChildren.set(entry.agentId, entry);
		} else {
			this.rosterReporter.queuedChildren.delete(entry.agentId);
		}
		// The parent's row carries hasRunningRlmChildren; a bound child's own row
		// recomputes through the queued-row reuse guard or its own session events.
		this.scheduleRosterFlush({ activeSessionId: state.activeSessionId });
	}

	private hasSessionForRlmChild(parentState: ActiveSessionState, childId: string): boolean {
		for (const candidate of this.sessions.values()) {
			const metadata = candidate.runtime.metadata;
			if (metadata.rlmChildId === childId && metadata.parentActiveSessionId === parentState.activeSessionId) {
				return true;
			}
		}
		return false;
	}

	private queuedChildRosterEntry(
		state: ActiveSessionState,
		child: AgentConnectionRlmChildAgentSnapshot,
	): WorkerRosterEntry {
		const parentSession = state.runtime.session;
		const summary: RosterSessionSummary = {
			id: child.id,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			runtimeKind: "subagent",
			rlmDepth: (parentSession.rlmDepth ?? 0) + 1,
			sessionId: child.id,
			sessionName: child.sessionName,
			cwd: parentSession.sessionManager.getCwd(),
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			firstMessage: child.label,
			parentActiveSessionId: state.activeSessionId,
			parentSessionId: parentSession.sessionId,
			parentSessionPath: parentSession.sessionFile,
			rlmChildId: child.id,
		};
		return { agentId: rosterAgentIdForSummary(summary), queuedChild: true, summary };
	}

	private scheduleRosterFlush(scope?: { activeSessionId: string }): void {
		if (!this.options.worker || this.shuttingDown) return;
		// A scoped call owes only the emitting session's row; every other caller
		// (structure, clients, cron, commands) invalidates the whole composed roster.
		if (scope) {
			const dirty = this.rosterReporter.dirtyActiveSessionIds;
			if (dirty) dirty.add(scope.activeSessionId);
			else this.rosterReporter.dirtyActiveSessionIds = new Set([scope.activeSessionId]);
		} else {
			this.rosterReporter.allDirty = true;
		}
		if (this.rosterFlushScheduled) return;
		this.rosterFlushScheduled = true;
		setImmediate(() => {
			this.rosterFlushScheduled = false;
			try {
				this.flushRoster();
			} catch (error) {
				this.log(`could not publish roster delta: ${String(error)}`);
			}
		});
	}

	private flushRoster(): void {
		const reporter = this.rosterReporter;
		const entries = new Map<string, WorkerRosterEntry>();
		// Serialized json carried over for reused rows: their delta comparison is a
		// map lookup, so a flush recomputes and re-stringifies only dirty sessions.
		const reusedJson = new Map<string, string>();
		const scheduledJobs = this.cronStore.list();
		const dirty = reporter.dirtyActiveSessionIds;
		// Session-event flushes recompute only the emitting sessions' rows; every other
		// row is carried over verbatim. Unscoped invalidation, direct calls with no dirty
		// tracking, and duplicate agent ids (mid-teardown races) take the full rebuild.
		const incremental = reporter.allDirty !== true && dirty !== undefined && dirty.size > 0;
		if (incremental && !this.hasDuplicateRosterAgentIds()) {
			for (const state of this.sessions.values()) {
				const agentId = this.rosterAgentIdForState(state);
				const previous = reporter.lastComposed.get(agentId);
				if (
					previous !== undefined &&
					previous.queuedChild !== true &&
					previous.summary.activeSessionId === state.activeSessionId &&
					!dirty.has(state.activeSessionId)
				) {
					entries.set(agentId, previous);
					const json = reporter.lastComposedJson.get(agentId);
					if (json !== undefined) reusedJson.set(agentId, json);
					continue;
				}
				const [summary] = buildSessionList([state], [], scheduledJobs);
				if (summary === undefined) continue;
				const entry = workerRosterEntryFromSummary(summary);
				entries.set(entry.agentId, entry);
			}
		} else {
			for (const summary of buildSessionList([...this.sessions.values()], [], scheduledJobs)) {
				const entry = workerRosterEntryFromSummary(summary);
				entries.set(entry.agentId, entry);
			}
		}
		reporter.allDirty = false;
		dirty?.clear();
		for (const [agentId, queued] of reporter.queuedChildren) {
			if (entries.has(agentId)) {
				reporter.queuedChildren.delete(agentId);
				continue;
			}
			entries.set(agentId, queued);
		}
		// A terminal unbound child run owns no transcript: it is a removal, never a passivated row.
		// A vanished row whose state lives on under a new sessionId was swapped in place
		// (new_session/switch/fork): also a removal — plain list never served the old transcript.
		const composedActiveIds = new Set<string>();
		for (const entry of entries.values()) {
			if (entry.summary.activeSessionId !== undefined) composedActiveIds.add(entry.summary.activeSessionId);
		}
		for (const [agentId, previous] of reporter.lastComposed) {
			if (entries.has(agentId)) continue;
			const swapped =
				previous.summary.activeSessionId !== undefined && composedActiveIds.has(previous.summary.activeSessionId);
			if (previous.queuedChild === true || swapped) {
				reporter.removedAgentIds.set(agentId, previous.summary.sessionId);
			}
		}
		for (const [agentId, targetSessionId] of reporter.removedAgentIds) {
			const composed = entries.get(agentId);
			// A new incarnation cancels the stale removal, as does a revived resident top-level row
			// (switch-back, resume-after-archive); a resident subagent row with the removed sessionId
			// is the mid-teardown race and stays suppressed.
			const revived = composed?.summary.activeSessionId !== undefined && composed.summary.runtimeKind !== "subagent";
			if (composed && (composed.queuedChild === true || composed.summary.sessionId !== targetSessionId || revived)) {
				reporter.removedAgentIds.delete(agentId);
				continue;
			}
			entries.delete(agentId);
			reporter.queuedChildren.delete(agentId);
		}
		const registrations = scheduledJobRegistrations(scheduledJobs);
		for (const [agentId, previous] of reporter.lastComposed) {
			if (!entries.has(agentId) && !reporter.removedAgentIds.has(agentId)) {
				const file = previous.summary.sessionFile ? resolve(previous.summary.sessionFile) : undefined;
				entries.set(
					agentId,
					passivatedWorkerRosterEntry(previous, {
						hasRegisteredHeartbeat: file !== undefined && registrations.heartbeatSessionFiles.has(file),
						hasRegisteredCronJob: file !== undefined && registrations.cronSessionFiles.has(file),
					}),
				);
			}
		}
		const changed: WorkerRosterEntry[] = [];
		const nextJson = new Map<string, string>();
		for (const entry of entries.values()) {
			const json = reusedJson.get(entry.agentId) ?? JSON.stringify(entry);
			nextJson.set(entry.agentId, json);
			if (reporter.lastComposedJson.get(entry.agentId) !== json) changed.push(entry);
		}
		const removedAgentIds = [...reporter.removedAgentIds.keys()];
		reporter.lastComposed = new Map(entries);
		reporter.lastComposedJson = nextJson;
		if (!this.hasAuthenticatedSupervisorClient()) {
			if (changed.length > 0 || removedAgentIds.length > 0) reporter.snapshotPending = true;
			return;
		}
		if (reporter.snapshotPending) {
			const delivered = this.broadcastRosterFrame({
				type: "roster_delta",
				snapshot: true,
				entries: [...entries.values()],
				...(removedAgentIds.length > 0 ? { removedAgentIds } : {}),
			});
			if (delivered) {
				reporter.snapshotPending = false;
				reporter.removedAgentIds.clear();
			}
			return;
		}
		if (changed.length === 0 && removedAgentIds.length === 0) return;
		const delivered = this.broadcastRosterFrame({
			type: "roster_delta",
			entries: changed,
			...(removedAgentIds.length > 0 ? { removedAgentIds } : {}),
		});
		if (delivered) reporter.removedAgentIds.clear();
		else reporter.snapshotPending = true;
	}

	private hasAuthenticatedSupervisorClient(): boolean {
		for (const client of this.clients) {
			if (this.supervisorClaims.has(client) && !client.socket.destroyed) {
				return true;
			}
		}
		return false;
	}

	private broadcastRosterFrame(message: DaemonWorkerRosterOutbound): boolean {
		const payload = Buffer.from(serializeJsonLine(message));
		let delivered = false;
		for (const client of this.clients) {
			if (!this.supervisorClaims.has(client) || client.socket.destroyed) {
				continue;
			}
			// socket.write queues under backpressure, so a queued frame is delivered, never a loss gap.
			client.socket.write(
				encodePrivateFrame<DaemonWorkerFrameHeader>({ kind: "outbound", outboundType: message.type }, payload),
			);
			delivered = true;
		}
		return delivered;
	}

	private recordWorkerRecoveryState(state: ActiveSessionState, operation: string, busyOverride?: boolean): void {
		if (!this.recoveryJournal) {
			return;
		}
		const session = state.runtime.session;
		const busy =
			busyOverride ?? (hasLiveSessionWork(state) || session.isRetrying || session.hasAcceptedPromptInFlight);
		try {
			this.recoveryJournal.record({
				activeSessionId: state.activeSessionId,
				sessionId: session.sessionId,
				...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
				busy,
				operation,
			});
		} catch (error) {
			this.log(`could not checkpoint worker operation state: ${String(error)}`);
		}
	}

	private catchUpBackpressuredClient(client: DaemonSocketClient): Promise<void> {
		if (client.catchupPromise) {
			return client.catchupPromise;
		}
		if (client.snapshotStreaming || client.backpressured) {
			return Promise.resolve();
		}
		this.clearClientCatchupRetry(client);
		const catchup = this.drainBackpressuredClientCatchupQueue(client).finally(() => {
			if (client.catchupPromise === catchup) {
				client.catchupPromise = undefined;
			}
		});
		client.catchupPromise = catchup;
		return catchup;
	}

	private clearClientCatchupRetry(client: DaemonSocketClient): void {
		if (!client.catchupRetryTimer) {
			return;
		}
		clearTimeout(client.catchupRetryTimer);
		client.catchupRetryTimer = undefined;
	}

	private scheduleClientCatchupRetry(client: DaemonSocketClient): void {
		if (client.socket.destroyed || client.catchupRetryTimer) {
			return;
		}
		client.catchupRetryTimer = setTimeout(() => {
			client.catchupRetryTimer = undefined;
			if (client.socket.destroyed || !client.catchupActiveSessionIds?.size) {
				return;
			}
			if (client.snapshotStreaming || client.backpressured) {
				this.scheduleClientCatchupRetry(client);
				return;
			}
			void this.catchUpBackpressuredClient(client).catch((error) =>
				this.log(`could not retry catch-up for client ${client.id}: ${String(error)}`),
			);
		}, CLIENT_CATCHUP_RETRY_MS);
	}

	private async drainBackpressuredClientCatchupQueue(client: DaemonSocketClient): Promise<void> {
		while (
			!client.socket.destroyed &&
			!client.snapshotStreaming &&
			!client.backpressured &&
			client.catchupActiveSessionIds?.size
		) {
			if ((await this.drainBackpressuredClientCatchups(client)) === "retry-later") {
				return;
			}
		}
	}

	private async drainBackpressuredClientCatchups(client: DaemonSocketClient): Promise<"drained" | "retry-later"> {
		if (client.socket.destroyed) {
			return "drained";
		}
		const pending = [...(client.catchupActiveSessionIds ?? [])].map((activeSessionId) => ({
			activeSessionId,
			purpose: client.catchupPurposes?.get(activeSessionId) ?? ("resync" as const),
		}));
		client.catchupActiveSessionIds?.clear();
		client.catchupPurposes?.clear();
		for (let index = 0; index < pending.length; index++) {
			const { activeSessionId, purpose } = pending[index]!;
			const state = this.sessions.get(activeSessionId);
			if (!state || !state.clients.has(client)) {
				continue;
			}
			try {
				const result = await this.createAttachResult(client, state, {
					type: "attach",
					activeSessionId,
				});
				if (this.sessions.get(activeSessionId) !== state || !state.clients.has(client)) {
					continue;
				}
				if (
					client.transport === "private-framed" &&
					daemonClientCapabilitiesForSession(client, activeSessionId).has("chunked_snapshot")
				) {
					if (purpose === "replacement") {
						this.write(client, {
							type: "session_replaced",
							activeSessionId,
							state: result.snapshot.state,
							messages: [],
							snapshotFollows: true,
							meta: createDaemonEventMeta(
								activeSessionId,
								state.lastEventSequence,
								undefined,
								state.eventGeneration,
							),
						});
					}
					const snapshotId = this.nextSnapshotId(state);
					const snapshotSignal = markClientSnapshotStreaming(client, activeSessionId);
					let transcript: SnapshotTranscriptChunkSource;
					try {
						transcript = createSnapshotTranscriptChunks({
							activeSessionId,
							snapshotId,
							messages: result.snapshot.messages,
							serializedMessages: this.serializedTranscriptFor(state, result.snapshot.messages),
							targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
							signal: snapshotSignal,
						});
					} catch (error) {
						finishClientSnapshotStreaming(client, activeSessionId);
						throw error;
					}
					await this.streamWorkerSnapshot(
						client,
						{
							...result,
							messages: result.messages ? [] : undefined,
							snapshot: { ...result.snapshot, messages: [] },
							snapshotStream: {
								id: snapshotId,
								messageCount: result.snapshot.messages.length,
								targetChunkBytes: SNAPSHOT_TARGET_CHUNK_BYTES,
							},
						},
						transcript,
						purpose === "replacement" ? "replacement" : "catchup",
						snapshotSignal,
						true,
					);
					continue;
				}
				const meta = createDaemonEventMeta(
					activeSessionId,
					state.lastEventSequence,
					undefined,
					state.eventGeneration,
				);
				const catchup: DaemonOutbound =
					purpose === "replacement"
						? {
								type: "session_replaced",
								activeSessionId,
								state: result.snapshot.state,
								messages: result.snapshot.messages,
								meta,
							}
						: { type: "session_resynced", activeSessionId, snapshot: result.snapshot, meta };
				if (!this.write(client, catchup)) {
					for (const remaining of pending.slice(index + 1)) {
						this.queueClientCatchup(client, remaining.activeSessionId, remaining.purpose);
					}
					return "retry-later";
				}
			} catch (error) {
				for (const remaining of pending.slice(index)) {
					this.queueClientCatchup(client, remaining.activeSessionId, remaining.purpose);
				}
				this.log(`could not catch up client ${client.id} for ${activeSessionId}: ${String(error)}`);
				this.scheduleClientCatchupRetry(client);
				return "retry-later";
			}
		}
		return "drained";
	}

	private queueClientCatchup(
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

	// The AgentSession doesn't know its own daemon active-session id, so fill it in here.
	private stampRlmChildActiveSessionId(message: DaemonOutbound): void {
		if (
			message.type !== "session_event" ||
			message.event.type !== "rlm_child_update" ||
			message.event.child.activeSessionId
		) {
			return;
		}
		const childId = message.event.child.id;
		for (const candidate of this.sessions.values()) {
			if (candidate.runtime.metadata.rlmChildId === childId) {
				message.event.child.activeSessionId = candidate.activeSessionId;
				return;
			}
		}
	}

	private addSessionEventMeta(state: ActiveSessionState, message: DaemonOutbound): DaemonOutbound {
		if (!isSequencedSessionOutbound(message) || message.meta) {
			return message;
		}
		const meta = createDaemonEventMeta(
			state.activeSessionId,
			state.lastEventSequence + 1,
			undefined,
			state.eventGeneration,
		);
		state.lastEventSequence = meta.sequence ?? state.lastEventSequence;
		return { ...message, meta };
	}

	private write(client: DaemonSocketClient, message: DaemonOutbound): boolean {
		// The supervisor leg always takes compact deltas. A direct session peer
		// takes them only when it declared streaming_deltas on attach (the
		// client-side reconstructor lives behind that capability), and takes
		// fragment-only tool-call deltas only with streaming_delta_fragments.
		const capabilities = hasDaemonOutboundActiveSessionId(message)
			? daemonClientCapabilitiesForSession(client, message.activeSessionId)
			: client.capabilities;
		const plan = planCompactAssistantDelta(client.transport, client.authenticationRole, capabilities);
		const compactDelta = plan.compact
			? createCompactAssistantDelta(message, { toolCallArguments: plan.toolCallArguments })
			: undefined;
		return this.writeSerialized(
			client,
			serializeJsonLine(compactDelta ?? message),
			message,
			compactDelta ? "assistant-delta" : "jsonl",
		);
	}

	private writeSerialized(
		client: DaemonSocketClient,
		line: string | Buffer,
		message: DaemonOutbound,
		payloadEncoding: "jsonl" | "assistant-delta" = "jsonl",
		snapshotPurpose?: "attach" | "replacement" | "catchup",
	): boolean {
		if (client.socket.destroyed) {
			return false;
		}
		const wireData =
			client.transport === "private-framed"
				? encodePrivateFrame<DaemonWorkerFrameHeader>(
						{
							kind: "outbound",
							outboundType: message.type,
							...("id" in message && typeof message.id === "string" ? { requestId: message.id } : {}),
							...(hasDaemonOutboundActiveSessionId(message) ? { activeSessionId: message.activeSessionId } : {}),
							...("snapshotId" in message && typeof message.snapshotId === "string"
								? { snapshotId: message.snapshotId }
								: {}),
							...(message.type === "session_event" ? { sessionEventType: message.event.type } : {}),
							payloadEncoding,
							...(snapshotPurpose ? { snapshotPurpose } : {}),
						},
						typeof line === "string" ? Buffer.from(line) : line,
					)
				: line;
		const accepted = client.socket.write(wireData);
		if (!accepted) {
			client.backpressured = true;
		}
		return accepted;
	}

	private abortSideQuestionsFor(client: DaemonSocketClient, activeSessionId: string): void {
		for (const [id, entry] of this.sideQuestionRuns) {
			if (entry.client !== client || entry.activeSessionId !== activeSessionId) {
				continue;
			}
			entry.run.abort();
			this.sideQuestionRuns.delete(id);
		}
	}

	private hasActiveSideQuestionFor(client: DaemonSocketClient, activeSessionId: string): boolean {
		for (const entry of this.sideQuestionRuns.values()) {
			if (entry.client === client && entry.activeSessionId === activeSessionId) {
				return true;
			}
		}
		return false;
	}

	private registerSignalHandlers(): void {
		const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}
		for (const signal of signals) {
			const handler = () => {
				this.log(`received ${signal}; shutting down`);
				killTrackedDetachedChildren();
				void this.shutdown(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
		const exitHandler = () => this.cleanupSocketPath();
		process.on("exit", exitHandler);
		this.signalCleanupHandlers.push(() => process.off("exit", exitHandler));
	}

	private getShutdownClosingReason(): DaemonClosingReason {
		return this.updateRestart?.phase === "publishing" ? "update" : "shutdown";
	}

	private async shutdown(exitCode: number): Promise<never> {
		if (this.shuttingDown) {
			process.exit(exitCode);
		}
		this.shuttingDown = true;
		this.peerAdmissionsFenced = true;
		this.peerGrants.clear();
		this.supervisorLinkInstance?.close();
		this.cancelArmedSupervisorAvailabilityCheck();
		if (this.supervisorFenceTimer) {
			clearTimeout(this.supervisorFenceTimer);
			this.supervisorFenceTimer = undefined;
		}
		if (this.rosterHeartbeatTimer) {
			clearInterval(this.rosterHeartbeatTimer);
			this.rosterHeartbeatTimer = undefined;
		}
		this.log(`shutting down (exit ${exitCode}); closing ${this.sessions.size} active session(s)`);
		const closingReason = this.getShutdownClosingReason();
		for (const client of this.clients) {
			abortClientSnapshotStreaming(client);
			this.write(client, { type: "daemon_closing", reason: closingReason });
		}

		this.summarizer.stop();
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.cronScheduler.stop();
		for (const state of [...this.sessions.values()]) {
			await this.closeSession(state, closingReason);
		}
		for (const client of this.clients) {
			client.detachInput();
			client.socket.end();
		}
		await new Promise<void>((resolveClose) => {
			if (!this.server) {
				resolveClose();
				return;
			}
			this.server.close(() => resolveClose());
		});
		this.cleanupSocketPath();
		// process.exit skips the drain the journal's in-flight start-id captures rely
		// on. Records this worker leaves active are reaped by the supervisor from the
		// journal, and an identity-free record can only be matched by a bare pid.
		await flushOrphanProcessJournal();
		process.exit(exitCode);
	}
}

interface WorkerRosterReporterState {
	lastComposed: Map<string, WorkerRosterEntry>;
	lastComposedJson: Map<string, string>;
	queuedChildren: Map<string, WorkerRosterEntry>;
	/** Pending removals: agentId -> removed sessionId; a new incarnation of the id cancels it. */
	removedAgentIds: Map<string, string | undefined>;
	snapshotPending: boolean;
	/** Structural invalidation (sessions, clients, cron, commands): the next flush rebuilds every row. */
	allDirty?: boolean;
	/** Sessions whose own events fired since the last flush; only their rows are recomputed. */
	dirtyActiveSessionIds?: Set<string>;
}

const ROSTER_SESSION_EVENT_TRIGGERS = new Set([
	"turn_start",
	"turn_end",
	"bash_start",
	"bash_end",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"tool_execution_start",
	"tool_execution_end",
	"message_end",
	"session_action_update",
	"session_info_changed",
	"thinking_level_changed",
	// The stall marker rides on the row (summary.stall) and a wedged session is
	// silent by definition, so the watchdog events are its only recompute carrier.
	"stall_warning",
	"stall_abort",
	"stall_unsettled",
]);

function hasDaemonOutboundActiveSessionId(
	message: DaemonOutbound,
): message is DaemonOutbound & { activeSessionId: string } {
	return "activeSessionId" in message && typeof message.activeSessionId === "string";
}

export function getChildActiveSessionStates(
	sessions: ReadonlyMap<string, ActiveSessionState>,
	parentState: ActiveSessionState,
): ActiveSessionState[] {
	return [...sessions.values()].filter(
		(state) =>
			state.activeSessionId !== parentState.activeSessionId &&
			state.runtime.metadata.parentActiveSessionId === parentState.activeSessionId,
	);
}

export function detachClientFromActiveSession(client: DaemonSocketClient, state: ActiveSessionState): void {
	state.clients.delete(client);
	client.attachedActiveSessionIds.delete(state.activeSessionId);
	removeDaemonClientSessionCapabilities(client, state.activeSessionId);
	if (state.clients.size === 0) {
		cancelPendingExtensionUiRequests(state);
	}
}

export function setDaemonClientSessionCapabilities(
	client: DaemonSocketClient,
	activeSessionId: string,
	capabilities: ReadonlySet<DaemonClientCapability>,
): void {
	client.capabilitiesByActiveSessionId ??= new Map();
	client.capabilitiesByActiveSessionId.set(activeSessionId, new Set(capabilities));
	client.supportsExtensionUi = [...client.capabilitiesByActiveSessionId.values()].some((value) =>
		value.has("extension_ui"),
	);
}

function removeDaemonClientSessionCapabilities(client: DaemonSocketClient, activeSessionId: string): void {
	client.capabilitiesByActiveSessionId?.delete(activeSessionId);
	client.supportsExtensionUi = [...(client.capabilitiesByActiveSessionId?.values() ?? [])].some((value) =>
		value.has("extension_ui"),
	);
}

function daemonClientCapabilitiesForSession(
	client: DaemonSocketClient,
	activeSessionId: string,
): ReadonlySet<DaemonClientCapability> {
	return client.capabilitiesByActiveSessionId?.get(activeSessionId) ?? client.capabilities;
}

function daemonClientSupportsExtensionUi(client: DaemonSocketClient, activeSessionId: string): boolean {
	return client.capabilitiesByActiveSessionId?.get(activeSessionId)?.has("extension_ui") ?? client.supportsExtensionUi;
}

export function markClientSnapshotStreaming(client: DaemonSocketClient, activeSessionId: string): AbortSignal {
	client.snapshotStreaming = true;
	client.snapshotActiveSessionIds ??= new Set();
	client.snapshotActiveSessionIds.add(activeSessionId);
	client.snapshotActiveSessionCounts ??= new Map();
	client.snapshotActiveSessionCounts.set(
		activeSessionId,
		(client.snapshotActiveSessionCounts.get(activeSessionId) ?? 0) + 1,
	);
	client.snapshotTransferAbortControllers ??= new Map();
	let controller = client.snapshotTransferAbortControllers.get(activeSessionId);
	if (!controller || controller.signal.aborted) {
		controller = new AbortController();
		client.snapshotTransferAbortControllers.set(activeSessionId, controller);
	}
	return controller.signal;
}

function abortClientSnapshotStreaming(client: DaemonSocketClient, activeSessionId?: string): void {
	if (activeSessionId) {
		client.snapshotTransferAbortControllers?.get(activeSessionId)?.abort();
		return;
	}
	for (const controller of client.snapshotTransferAbortControllers?.values() ?? []) {
		controller.abort();
	}
}

export function finishClientSnapshotStreaming(client: DaemonSocketClient, activeSessionId: string): void {
	const count = client.snapshotActiveSessionCounts?.get(activeSessionId) ?? 1;
	if (count > 1) {
		client.snapshotActiveSessionCounts?.set(activeSessionId, count - 1);
	} else {
		client.snapshotActiveSessionCounts?.delete(activeSessionId);
		client.snapshotActiveSessionIds?.delete(activeSessionId);
		client.snapshotTransferAbortControllers?.delete(activeSessionId);
	}
	client.snapshotStreaming = (client.snapshotActiveSessionIds?.size ?? 0) > 0;
	if (!client.snapshotStreaming) {
		client.backpressured = false;
	}
}

export function cancelPendingExtensionUiRequests(state: ActiveSessionState): void {
	const pendingRequests = [...state.extensionUiRequests.values()];
	state.extensionUiRequests.clear();
	for (const pending of pendingRequests) {
		pending.resolve({ cancelled: true });
	}
}

function normalizeClientCapabilities(
	capabilities: readonly DaemonClientCapability[] | undefined,
	supportsExtensionUi: boolean | undefined,
): Set<DaemonClientCapability> {
	const normalized = new Set<DaemonClientCapability>();
	for (const capability of capabilities ?? DAEMON_DEFAULT_CLIENT_CAPABILITIES) {
		if (DAEMON_CLIENT_CAPABILITY_SET.has(capability)) {
			normalized.add(capability);
		}
	}
	if (supportsExtensionUi) {
		normalized.add("extension_ui");
	}
	return normalized;
}

type SequencedDaemonOutbound = Extract<
	DaemonOutbound,
	{
		type:
			| "session_event"
			| "session_status"
			| "session_replaced"
			| "session_resynced"
			| "session_closed"
			| "extension_ui_request"
			| "extension_error";
	}
>;

function isSequencedSessionOutbound(message: DaemonOutbound): message is SequencedDaemonOutbound {
	return (
		message.type === "session_event" ||
		message.type === "session_status" ||
		message.type === "session_replaced" ||
		message.type === "session_resynced" ||
		message.type === "session_closed" ||
		message.type === "extension_ui_request" ||
		message.type === "extension_error"
	);
}

export function shouldSendDaemonOutboundToClient(client: DaemonSocketClient, message: DaemonOutbound): boolean {
	return (
		message.type !== "extension_ui_request" ||
		!isDaemonDialogExtensionUiRequest(message.method) ||
		daemonClientSupportsExtensionUi(client, message.activeSessionId)
	);
}

export async function resolveDaemonSessionPath(selector: string, cwd: string, sessionDir?: string): Promise<string> {
	return (await resolveSessionPath(selector, cwd, sessionDir)).path;
}
