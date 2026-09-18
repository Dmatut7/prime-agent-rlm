import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	Agent,
	type AgentContext,
	AgentContinueError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	EMPTY_TURN_RETRY_DEFAULTS,
	formatToolCallIdCollisions,
	type GetContinuationMessagesContext,
	isEmptyTurnRetryExhausted,
	isServerDirectedRetryStall,
	readToolCallIdCollisions,
	type ShouldStopAfterTurnContext,
	type ThinkingLevel,
	TOOL_CALL_ID_COLLISION_DIAGNOSTIC_TYPE,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	ServiceTier,
	TextContent,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	forgetProviderRequestBudget,
	getLogger,
	getProviderRequestBudget,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	type ProviderRequestBudget,
	resetApiProviders,
	resetProviderRequestBudget,
	supportsFastMode,
} from "@earendil-works/pi-ai";
import { theme } from "../modes/interactive/theme/theme.js";
import { untilAborted, type WaitTimeoutFacts, withBound } from "../utils/bounded-wait.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "../utils/private-files.js";
import { sleep } from "../utils/sleep.js";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL,
	AGENT_MESSAGE_SKILL_NAME,
	type AgentFamilyCatalogEntry,
	type AgentFamilyRosterEntry,
	type AgentFamilyRosterResult,
	type AgentMessageQueuedReason,
	type AgentSessionMessage,
	type AgentSessionMessageAgentSummary,
	type AgentSessionMessageController,
	type AgentSessionMessageListResult,
	type AgentSessionMessageReceipt,
	assertAgentMessageQueueCapacity,
	assertAgentSessionNameAvailable,
	assertDirectAgentMessageTarget,
	classifyAgentMessageSendFailureByMessage,
	countsAsDeliveredParentReply,
	createAgentMessageHostHandlers,
	DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
	formatAgentMessageRetryExhaustedError,
	formatAgentSessionNameReserved,
	formatAgentSessionNameUnavailable,
	formatSubagentTerminalErrorNotice,
	isAgentSessionMessage,
	isAgentSessionMessagePrompt,
	isChildReplyToThisSession,
	normalizeAgentSessionMessage,
	parseAgentSessionMessagePromptId,
	QueuedParentReplyBackfills,
	startsAgentRun,
} from "./agent-messages.js";
import {
	AGENT_OBSERVE_SKILL_NAME,
	type AgentObserveAgentSnapshot,
	type AgentObserveController,
	type AgentObserveListResult,
	type AgentObserveRecentMessagesResult,
	createAgentObserveHostHandlers,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
	ORCHESTRATION_HEARTBEAT_SKILL_NAME,
} from "./agent-observe.js";
import {
	addLoginGuidanceToAuthError,
	formatAuthenticationFailedMessage,
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	formatStaleAuthMessage,
	isLikelyAuthenticationError,
} from "./auth-guidance.js";
import type { AuthSourceToken } from "./auth-storage.js";
import {
	type AgentAutonomousConfig,
	type AgentAutonomousStatus,
	type AutonomousRuntimeState,
	addAutonomousContinuation,
	addAutonomousUsage,
	autonomousLimitReason,
	autonomousStatus,
	createAutonomousContinuationMessage,
	createAutonomousGateFailureContinuationMessage,
	createAutonomousRuntimeState,
	createAutonomousSubagentKeepAliveMessage,
	isUnlimitedAutonomousLimit,
	MAX_SUBAGENT_KEEP_ALIVE_MS,
	nextAutonomousContinuation,
	refreshAutonomousQualityGates,
	setAutonomousEnabled,
	setAutonomousLimits,
	shouldAutonomouslyContinue,
	UNLIMITED_AUTONOMOUS_LIMIT,
} from "./autonomous.js";
import { type BashResult, executeBashWithOperations } from "./bash-executor.js";
import {
	buildCompactionRecoveryHint,
	buildEmergencyShrinkNotice,
	buildEmergencyShrinkSummary,
	COMPACT_SKILL_NAME,
	COMPACTION_EMERGENCY_SHRINK_FAILURES,
	COMPACTION_RECOVERY_HINT_THRESHOLD,
	type CompactionResult,
	type CompactionSettings,
	type CompactionWindowLimits,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	compactionThresholdTokens,
	estimateContextTokens,
	generateBranchSummary,
	isAssistantUsageSource,
	planEmergencyShrink,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
	shrunkKeepRecentTokens,
} from "./compaction/index.js";
import {
	ContextTreeDiskScanCache,
	type ContextTreeNode,
	type ContextWindowResolver,
	contextTreeScanDiagnostics,
	createContextTreeScanState,
	loadContextTreeChildFromDisk,
	OwnUsageAccumulator,
	scanContextTreeChildrenFromDisk,
} from "./context-tree.js";
import type { AgentCronJob, AgentRlmHeartbeatController, AgentRlmHeartbeatStatusUpdate } from "./cron-jobs.js";
import { normalizeHeartbeatDeliveryMode } from "./cron-jobs.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.js";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.js";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeRefineResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import {
	createGoalContextMessage,
	emptyGoalState,
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTEXT_PREVIEW_LABEL,
	GOAL_SKILL_NAME,
	GOAL_STATE_CUSTOM_TYPE,
	type GoalContextDetails,
	type GoalHostResponse,
	type GoalState,
	type GoalStatus,
	goalHostResponse,
	goalTokenDeltaForUsage,
	isPersistedGoalState,
	MAX_GOAL_CONTINUATIONS,
	normalizeGoalState,
	validateGoalBudget,
	validateGoalObjective,
} from "./goals.js";
import { classifyIncomingInput, incomingInputFactsFromMessage, inputClassOrigin } from "./input-classification.js";
import type {
	HostRequestHandlers,
	KernelDeathCause,
	KernelLateHostReply,
	KernelSentAgentMessage,
	KernelUnexpectedExitFacts,
} from "./kernel/index.js";
import {
	compactionKernelStateLines,
	type RestoreResult,
	restoreNoticeLines,
	snapshotFailureNoticeLines,
	snapshotPathIn,
} from "./kernel/state-snapshot.js";
import type { AcpMcpServerConfig } from "./mcp/acp-mcp-types.js";
import type { McpManager } from "./mcp/mcp-manager.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	ASYNC_BASH_COMPLETION_PREVIEW_LABEL,
	type AsyncBashCompletionDetails,
	type BashExecutionMessage,
	type CompactionOutcome,
	type CompactionOutcomeReason,
	type CustomMessage,
	convertToLlm,
	createAsyncBashCompletionMessage,
	createCompactionOutcomeMessage,
	createHarnessDigestMessage,
	createHeartbeatPromptMessage,
	createRefinementFailureMessage,
	createRefinementOutcomeMessage,
	createRlmChildFailureMessage,
	createRlmChildStallNoticeMessage,
	createRlmChildTerminalNoticeMessage,
	createSessionSlashCommandMessage,
	createSessionSlashCommandResultMessage,
	HARNESS_DIGEST_CUSTOM_TYPE,
	type HarnessDigestDetails,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	HEARTBEAT_PROMPT_PREVIEW_LABEL,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	isSessionSlashCommandMessage,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	type RlmChildFailureDetails,
	THINKING_LEVEL_CLAMPED_CUSTOM_TYPE,
} from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { findExactModelReferenceMatch } from "./model-resolver.js";
import {
	SessionInputAdmissionPausedError,
	SessionInputCoalescingError,
	SessionInputSuspendedError,
	throwIfPromptAdmissionCancelled,
} from "./prompt-admission.js";
import { expandPromptTemplate, type PromptTemplate, parseCommandArgs } from "./prompt-templates.js";
import {
	isAgentLifecycleFailure,
	isFauxProviderQueueExhausted,
	isPermanentProviderFailureKind,
	type ProviderWaitPolicy,
	parseProviderResetMs,
	providerRetryDelay,
	providerRetryPolicy,
	providerStreamFailureKind,
	providerStreamFailureRetryAfterMs,
	providerStreamFailureStatus,
	providerWaitClass,
	providerWaitDecision,
} from "./provider-retry.js";
import {
	type AutoRefineReason,
	type AutoRefineReview,
	applyRefinementProposal,
	assertHarnessStateWritable,
	formatHarnessStateForPrompt,
	generateRefinementId,
	getGlobalHarnessStateDir,
	getHarnessStatePath,
	getLocalHarnessStateDir,
	getRefinementHistory,
	type HarnessQueryTerms,
	type HarnessScope,
	type HarnessState,
	type HarnessStateStamp,
	harnessDigestFingerprint,
	harnessQueryTerms,
	harnessStateStampsEqual,
	inferRefinementResultScope,
	isPersistentHarnessStorageSupported,
	loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	mergeRefinementHistory,
	normalizeRefinementProposal,
	persistAppliedRefinement,
	planRefinement,
	REFINE_SKILL_NAME,
	type RefinementPlan,
	type RefinementResult,
	readHarnessStateStamp,
	reviewAutoRefine,
	WINDOWS_HARNESS_PERSISTENCE_UNSUPPORTED_ERROR,
} from "./refinement/index.js";
import { resolveConfigValue } from "./resolve-config-value.js";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";
import {
	classifyRlmChildTerminalOutcomeSafely,
	type RlmChildStallAbortFacts,
	type RlmChildTerminalFacts,
	type RlmChildTerminalOutcomeKind,
	type RlmChildTurnAbortReason,
	readStallKernelReasons,
} from "./rlm-child-terminal.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createAsyncBashCompletionHostHandler,
	createAsyncBashConsumedHostHandler,
	createDefaultRlmSubagentSessionName,
	createRlmCollectHostHandler,
	createRlmCreateSessionHostHandler,
	createRlmDeleteSubagentHostHandler,
	createRlmFindModelsHostHandler,
	createRlmListSubagentsHostHandler,
	createRlmProgressNoteHostHandler,
	createRlmRunHostHandler,
	findRlmModelMatches,
	findUniqueRlmShortFormModelMatch,
	formatRlmModelUnavailableError,
	normalizeRequestedRlmSubagentModel,
	normalizeRequestedRlmSubagentSessionName,
	normalizeRequestedRlmSubagentThinkingLevel,
	type RlmCollectResult,
	type RlmCollectResultEntry,
	type RlmCreateSessionResult,
	type RlmDeleteSubagentResult,
	type RlmFindModelsResult,
	type RlmListSubagentsResult,
	type RlmProgressNoteResult,
	type RlmSpawnHandle,
	type RlmSubagentRegistryEntry,
	type RlmSubagentRuntime,
	rlmCollectStallAbort,
	type SubagentRuntimeHost,
} from "./rlm-runtime.js";
import {
	modelRequestHeaders,
	SemanticEdgeRecorder,
	semanticEdgeLedgerPath,
	wrapStreamFnWithSemanticEdges,
} from "./semantic-edges.js";
import {
	ActionStore,
	type ActionTicket,
	ActionTicketController,
	canSelectSessionAction,
	type DeliveryPolicy,
	type DeliveryRecord,
	type QueuedMessageLane,
	type QueuedMessageMutation,
	type QueuedMessageMutationStatus,
	queuedMessageLaneDeliveryPolicy,
	type RuntimeActivity,
	type SessionAction,
	type SessionActionSnapshot,
	type SessionCommandPayload,
	type SessionTurnPayload,
	transitionSessionAction,
	type WakePolicy,
} from "./session-action-store.js";
import type { BranchSummaryEntry, CompactionEntry, SessionContext, SessionMessageEntry } from "./session-manager.js";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	type SessionHeader,
	SessionManager,
} from "./session-manager.js";
import type { SessionStats } from "./session-stats.js";
import { resolveCompleteToolPairLeaf } from "./session-tool-pair.js";
import { DEFAULT_STREAM_STALL_TIMEOUT_MS, type SettingsManager } from "./settings-manager.js";
import { getPythonSkillRuntimeInfo, type Skill } from "./skills.js";
import {
	BUILTIN_SLASH_COMMANDS,
	findSlashCommandSuggestion,
	isBuiltinSlashCommandName,
	parseRefineCommandOptions,
	parseSessionSlashCommand,
	parseSlashCommand,
	type RefineCommandOptions,
	SESSION_SLASH_COMMAND_NAMES,
	type SessionSlashCommand,
	type SlashCommandInfo,
} from "./slash-commands.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import {
	buildStallAbortMessage,
	buildStallAbortUnsettledMessage,
	buildStallWarnMessage,
	formatStallExemptionEventLog,
	normalizeStallKernelFacts,
	type StallExemptionEvent,
	type StallKernelDiagnostics,
	type StallMessageContext,
	type StallVouchFacts,
	StallWatchdog,
	type StallWatchdogOptions,
	type StallWatchdogStageInfo,
	type StallWatchdogTimers,
} from "./stall-watchdog.js";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.js";
import { THINKING_LEVELS } from "./thinking-levels.js";
import { acpMcpToolNames, createAcpMcpToolDefinitions } from "./tools/acp-mcp.js";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.js";
import { createAllToolDefinitions } from "./tools/index.js";
import { formatIpythonAbortCause, type IpythonAbortCause, IpythonKernelProvisioner } from "./tools/ipython.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";
import {
	createTurnLiveness,
	type JournaledBashFacts,
	type TurnLiveness,
	type TurnLivenessEvent,
	type TurnLivenessKernelFacts,
} from "./turn-liveness.js";
import {
	addAssistantUsage,
	cloneUsage,
	emptyUsage,
	type SessionUsageSummary,
	sessionUsageSummaryFrom,
} from "./usage.js";
import { SERPER_CREDENTIAL_ID, SERPER_ENV_VAR, WEBSEARCH_SKILL_NAME } from "./websearch-credential.js";

export type { GoalState, GoalStatus } from "./goals.js";
export type { SessionStats } from "./session-stats.js";
export { type ParsedSkillBlock, parseSkillBlock } from "./skill-blocks.js";

export type RlmChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface RlmChildAgentActivity {
	kind: "waiting" | "writing" | "executing" | "stalled";
	toolName?: string;
}

/**
 * Forensic stall facts for a child whose watchdog fired, mirrored on the daemon
 * wire behind the `rlm_child_stall_activity` capability.
 */
export interface RlmChildStallState {
	silentMs: number;
	thresholdMs: number;
	inFlightTools: string[];
	/** True once the watchdog reported abort_unsettled: the abort did not stop the run. */
	unsettled?: boolean;
	/**
	 * True while the silence is being excused by an unspent exemption - a host-owned phase or a
	 * kernel/host liveness vouch. B9/I-13: healthy long work must not wear the "stalled" label, so
	 * renderers say what it is instead and the row keeps its real activity. Never true for an
	 * abort that did not settle: by then the budget was spent and the kill is the story.
	 */
	excused?: boolean;
	/** Exemption sub-reasons behind `excused` (e.g. `live_bash_handles`), for an honest label. */
	excusedReasons?: string[];
}

export interface RlmChildAgentSnapshot {
	id: string;
	parentId?: string;
	activeSessionId?: string;
	sessionName?: string;
	model?: string;
	label: string;
	status: RlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	toolUseCount?: number;
	tokenCount?: number;
	recap?: string;
	sessionDir: string;
	activity?: RlmChildAgentActivity;
	repliedSinceTask?: boolean;
	/** Latest child progress note (`rlm.progress.note`), newest wins. */
	progressNote?: string;
	/** Wall-clock ms of the last tracked child activity (seeded at admission, then model/tool/note events). */
	lastActivityAt?: number;
	/**
	 * Active time in ms since the last tracked activity, once past the staleness
	 * threshold, for a running child that is not executing a tool call.
	 * Measured against the monotonic clock, so a host sleep that freezes the
	 * session does not flag every running child stale on wake.
	 */
	activityStaleMs?: number;
	error?: string;
	stall?: RlmChildStallState;
}

export type CompactionReason = "manual" | "threshold" | "overflow" | "requested";

const sessionLog = getLogger("coding-agent.agent-session");

import type { StallDiagnostics } from "./stall-diagnostics.js";
import { detectToolNameConflicts, type ToolNameSource } from "./tool-name-conflicts.js";

export type { StallDiagnostics };

export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "ipython_sent_agent_message";
			toolCallId: string;
			message: KernelSentAgentMessage;
	  }
	| { type: "session_action_update"; actions: SessionActionSnapshot }
	| {
			type: "compaction_start";
			reason: CompactionReason;
			customInstructions?: string;
	  }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "service_tier_changed"; serviceTier: ServiceTier }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			errorSeverity?: "warning" | "error";
			customInstructions?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			/**
			 * Requests spent in the current chain, shared with the provider layer. Present
			 * only when the shared budget counted at least one request, so consumers that
			 * predate it see the same event shape they always did.
			 */
			requestBudget?: { used: number; maxRequests?: number };
			/** Why the retry loop re-issues the turn; absent = ordinary quick retry. */
			reason?: "usage" | "unavailable" | "backup";
			/** Present when reason is "backup": "provider/model-id" of the backup. */
			backupModel?: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
			/** "provider/model-id" restored after a backup-model retry succeeded. */
			restoredModel?: string;
	  }
	| {
			type: "auth_stale";
			provider: string;
			sourceTokens?: readonly AuthSourceToken[];
	  }
	| { type: "rlm_child_update"; child: RlmChildAgentSnapshot }
	| { type: "rlm_progress_note"; message: string; timestamp: number }
	| { type: "recap_update"; recap: string | undefined }
	| { type: "goal_update"; goal: GoalState }
	| {
			type: "bash_start";
			command: string;
			excludeFromContext: boolean;
			transient?: boolean;
			runId?: string;
	  }
	| { type: "bash_output"; chunk: string }
	| {
			type: "bash_end";
			exitCode: number | undefined;
			cancelled: boolean;
			truncated: boolean;
			fullOutputPath?: string;
			errorMessage?: string;
			transient?: boolean;
			runId?: string;
	  }
	| { type: "refine_complete"; result: RefinementResult }
	| { type: "refine_failed"; error: string }
	/**
	 * A transcript write failed. Emitted from the single SessionManager
	 * persist-failure hook, so every append path is covered (messages, goal,
	 * model/thinking/service-tier changes, compaction, bash, session name,
	 * labels, child usage, refinement). Reports back off exponentially until a
	 * write succeeds again; the lost entry is backfilled by the next rewrite.
	 */
	| { type: "session_persist_failed"; error: string }
	/**
	 * Deferred RLM child terminal notices could not be delivered. `abandoned` counts
	 * the routine notices that were dropped (the session had to stay evictable);
	 * `persistedToTranscript` counts the failure notices that were written into the
	 * transcript instead of being dropped. Expected ~0 in production; non-zero is
	 * now forensically visible instead of a silent filter.
	 */
	| {
			type: "rlm_terminal_notice_abandoned";
			abandoned: number;
			persistedToTranscript: number;
			deferredMs: number;
	  }
	| {
			type: "stall_warning";
			message: string;
			silentMs: number;
			thresholdMs: number;
			diagnostics: StallDiagnostics;
	  }
	| {
			type: "stall_abort";
			message: string;
			silentMs: number;
			thresholdMs: number;
			diagnostics: StallDiagnostics;
	  }
	/**
	 * The stall watchdog aborted the turn but it never settled (no `agent_end`).
	 * Emitted instead of - not in addition to - `stall_warning`, so "killed but
	 * still running" stays countable apart from "looks stuck".
	 */
	| {
			type: "stall_unsettled";
			message: string;
			silentMs: number;
			thresholdMs: number;
			diagnostics: StallDiagnostics;
	  };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

type UserBashEndDetails = {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	errorMessage?: string;
};

export class CompactionSkippedError extends Error {}

/** Thrown when a session_before_refine extension skips the refinement round. */
export class RefineSkippedError extends Error {}

/**
 * A refinement persist failure annotated with the effective target scope (the
 * requested scope can differ: a local request rolling back a global record
 * writes the global store). The message is the underlying persist error's;
 * failure receipts read the scope off this wrapper instead of the request.
 */
export class RefinePersistScopeError extends Error {
	constructor(
		message: string,
		readonly scope: HarnessScope,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "RefinePersistScopeError";
	}
}

/**
 * Kernel-owned work that must keep a session resident after its turn ends (LIVE-1, r44): a
 * cell executing right now, or bash() handles the kernel's newest heartbeat attests. Closing
 * the session closes the kernel, and the kernel kills those handle's process groups, so an
 * eviction policy that treats "turn idle" as "idle" kills long-lived background scripts.
 */
export interface KernelResidencyFacts {
	/** A kernel cell request is executing right now (host-side fact, always fresh). */
	hasActiveExecution: boolean;
	/** The kernel's newest heartbeat reports live bash() handles. */
	isKernelBashRunning: boolean;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	serviceTierPreference?: ServiceTier;
	cwd: string;
	agentDir?: string;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	resourceLoader: ResourceLoader;
	customTools?: ToolDefinition[];
	modelRegistry: ModelRegistry;
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	/**
	 * Whether the built-in long-running goals feature is available: the bundled
	 * goal skill in the Python kernel, its goal.* host handlers, and /goal.
	 * Default: true.
	 */
	includeGoals?: boolean;
	agentMessageController?: AgentSessionMessageController;
	agentObserveController?: AgentObserveController;
	/**
	 * Whether the bundled compact skill and its compact.* host handlers are
	 * available to the model. Default: the compaction.agentCallable setting.
	 */
	includeCompactSkill?: boolean;
	/**
	 * Optional host-side controller for the bundled rlm-heartbeat Python skill.
	 * When omitted, rlm_heartbeat.* host requests are unavailable.
	 */
	rlmHeartbeatController?: AgentRlmHeartbeatController;
	/**
	 * Optional MCP integration manager. When present, its mcp.* host requests
	 * (refresh, begin_login) are exposed to the kernel.
	 */
	mcpManager?: McpManager;
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	extensionRunnerRef?: { current?: ExtensionRunner };
	sessionStartEvent?: SessionStartEvent;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	/**
	 * Cap on simultaneously live children this session admits; 0 disables the cap.
	 * Falls back to RLM_MAX_DEPTH-style resolution through RLM_MAX_CHILDREN, then to
	 * DEFAULT_RLM_MAX_CONCURRENT_CHILDREN.
	 */
	rlmMaxChildren?: number;
	rlmSessionDir?: string;
	rlmParentNodeId?: string;
	rlmParentAgent?: string;
	semanticParentSessionId?: string;
	semanticSpawnedByRequestId?: string;
	subagentRuntimeHost?: SubagentRuntimeHost;
	autonomous?: AgentAutonomousConfig;
	prewarmIpythonKernel?: boolean;
	autoRefineReviewer?: AutoRefineReviewer;
	/**
	 * When true, auto-refine runs synchronously between turns at the
	 * shouldStopAfterTurn boundary instead of in the background after
	 * agent_end. Used for print/headless autonomous runs so refinement
	 * never overlaps the primary model request. Default: false.
	 */
	serializedRefine?: boolean;
	/**
	 * Initial goal to seed at session creation. Only applied when rlmDepth
	 * is 0 and no persisted thread_goal_state entry exists in the branch.
	 */
	initialGoal?: { objective: string; tokenBudget?: number };
	/**
	 * How long the stall watchdog waits after an auto-abort for the run to settle
	 * before reporting `stall_unsettled`. Defaults to the watchdog's own 10s;
	 * exposed so an operator (or a test) can shorten the "killed but never
	 * stopped" detection window.
	 */
	stallAbortSettleGraceMs?: number;
	/**
	 * Timers/clock the stall watchdog runs on. Injectable so tests drive the warn/abort/deferral
	 * cascade deterministically with a fake clock instead of real 50-100ms thresholds racing a
	 * loaded runner; defaults to real setTimeout and Date.now. The thresholds themselves still
	 * come from settings.
	 */
	stallWatchdogTimers?: StallWatchdogTimers;
	/**
	 * Kernel/host liveness facts behind the stall watchdog's vouch (T1-2/T1-3). Injectable so the
	 * exemption wiring is testable without a kernel; defaults to this session's ipython kernel
	 * client. Sampled on every watchdog touch, so it must stay O(1) and side-effect free.
	 */
	stallKernelLivenessFacts?: () => TurnLivenessKernelFacts | undefined;
	/**
	 * Degraded fact source for when the kernel heartbeat is stale or absent: the journaled bash
	 * children of this kernel (B4). Injectable for tests; defaults to reading the orphan-process
	 * journal, at most once per stall stage.
	 */
	stallJournaledBashHandles?: (kernelPid: number | undefined) => JournaledBashFacts | undefined;
	/**
	 * Kernel residency facts behind the eviction-facing activity term of this session: a cell
	 * executing right now, and live bash() handles the kernel's newest heartbeat attests.
	 * Injectable so the residency wiring is testable without a kernel; defaults to this
	 * session's ipython kernel client. Pure and O(1) - summary and roster polling read it.
	 */
	kernelResidencyFacts?: () => KernelResidencyFacts | undefined;
	/**
	 * How long a deferred RLM child terminal notice may wait for delivery before it
	 * is abandoned (default 5 minutes). Injectable so the abandonment path is
	 * testable without waiting five minutes, and tunable per host.
	 */
	rlmTerminalNoticeAbandonAfterMs?: number;
	/**
	 * Window after an Esc/kill inside which one aggregated failure wake is allowed
	 * (default 50 minutes). Distinct from the stall watchdog's exemption budget:
	 * same order of magnitude, different clock and different meaning.
	 */
	failureWakeQuietWindowMs?: number;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface AutoRefineReviewRequest {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

/**
 * Discriminated result from a serialized-mode background planning pass.
 * - "plan": review approved and planning succeeded; carry the exact plan,
 *   options, and abort controller so the boundary can apply directly
 *   without a second planning request.
 * - "skip": reviewer declined; no refine needed.
 * - "failure": review or planning threw; boundary should not retry.
 */
export type SerializedBackgroundPlanResult =
	| {
			status: "plan";
			plan: RefinementPlan;
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			abort: AbortController;
			branchVersion: number;
	  }
	| { status: "skip"; explicit?: boolean }
	| { status: "invalidated"; branchVersion: number }
	| {
			status: "failure";
			explicit: boolean;
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			branchVersion: number;
	  };

export type AutoRefineReviewer = (request: AutoRefineReviewRequest, signal?: AbortSignal) => Promise<AutoRefineReview>;

export interface PromptOptions {
	expandPromptTemplates?: boolean;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	followUpQueueKey?: string;
	source?: InputSource;
	preflightResult?: (success: boolean, queued?: boolean, queuedReason?: AgentMessageQueuedReason) => void;
	queueIfBusy?: boolean;
	resumeIfIdle?: boolean;
	internalPrompt?: boolean;
	suppressAutonomousContinuation?: boolean;
	skipInputHandlers?: boolean;
	signal?: AbortSignal;
	admissionCommitted?: () => void;
	agentMessageId?: string;
	content?: (TextContent | ImageContent)[];
	customMessage?: CustomMessage;
}

interface InternalPromptOptions extends PromptOptions {
	skipPrePromptWork?: boolean;
	returnAfterAccepted?: boolean;
	agentMessageId?: string;
}

type SubmissionExtensionCommandPolicy = "execute" | "reject" | "ignore";

interface SubmissionNormalizationPolicy {
	parseSessionCommands: boolean;
	extensionCommands: SubmissionExtensionCommandPolicy;
	inputSource?: InputSource;
	expandSkills: boolean;
	expandPromptTemplates: boolean;
}

type NormalizedSubmission =
	| { kind: "prompt"; text: string; images?: ImageContent[] }
	| {
			kind: "sessionCommand";
			text: string;
			images?: ImageContent[];
			command: SessionSlashCommand;
	  }
	| { kind: "extensionCommand"; completion: Promise<void> }
	| { kind: "handled" };

type PreTurnCompactionTiming = "beforeModelSelection" | "afterModelSelection" | "skip";
type RefineBarrierPolicy = "always" | "ifInFlight" | "skip";

interface CommitPreparationPolicy {
	initialRefineBarrier: RefineBarrierPolicy;
	flushPendingBashBeforeValidation: boolean;
	validateModelAndAuth: boolean;
	awaitPendingModelSelection: boolean;
	preTurnCompaction: PreTurnCompactionTiming;
	finalRefineBarrier: RefineBarrierPolicy;
}

interface CommitPreparationSteps<TPrepared, TCommitted> {
	afterValidation?: () => void;
	prepare: () => Promise<TPrepared>;
	shouldCommit?: (prepared: TPrepared) => boolean;
	beforeFinalRefineBarrier?: (prepared: TPrepared) => void;
	commit: (prepared: TPrepared, passedFinalRefineBarrier: boolean) => TCommitted;
}

type QueuedAgentMessage = UserMessage | CustomMessage;
type SessionInputSchedule = "steer" | "followUp";

export interface TurnExecutionPolicy {
	preparation: CommitPreparationPolicy;
	runBeforeAgentStart: boolean;
	nextTurnContextTiming: "preparation" | "commit" | "skip";
	preserveEmptyExtensionPrompt: boolean;
	completionIncludesRetryChain: boolean;
}

function turnExecutionPoliciesEqual(left: TurnExecutionPolicy, right: TurnExecutionPolicy): boolean {
	return (
		left.preparation.initialRefineBarrier === right.preparation.initialRefineBarrier &&
		left.preparation.flushPendingBashBeforeValidation === right.preparation.flushPendingBashBeforeValidation &&
		left.preparation.validateModelAndAuth === right.preparation.validateModelAndAuth &&
		left.preparation.awaitPendingModelSelection === right.preparation.awaitPendingModelSelection &&
		left.preparation.preTurnCompaction === right.preparation.preTurnCompaction &&
		left.preparation.finalRefineBarrier === right.preparation.finalRefineBarrier &&
		left.runBeforeAgentStart === right.runBeforeAgentStart &&
		left.nextTurnContextTiming === right.nextTurnContextTiming &&
		left.preserveEmptyExtensionPrompt === right.preserveEmptyExtensionPrompt &&
		left.completionIncludesRetryChain === right.completionIncludesRetryChain
	);
}

interface PreparedTurnPayload extends SessionTurnPayload {
	images?: ImageContent[];
	content?: (TextContent | ImageContent)[];
	customMessage?: CustomMessage;
	prepared?: PreparedPromptPreparation;
	executionPolicy: TurnExecutionPolicy;
	queueVisible: boolean;
	acceptedAgentMessage: boolean;
	acceptedBeforeCompletion: boolean;
	captureRunMessages?: Set<AgentMessage>;
	cancelledDispatchEnded?: boolean;
}

interface PreparedCommandPayload extends SessionCommandPayload {
	images?: ImageContent[];
}

type QueuedSessionAction = SessionAction<PreparedTurnPayload | PreparedCommandPayload>;

interface PreparedPromptPreparation {
	result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>;
	basePromptSnapshot: string;
}

class DeferredSessionInputError extends Error {}

function oncePreflight(
	preflightResult: ((success: boolean, queued?: boolean, queuedReason?: AgentMessageQueuedReason) => void) | undefined,
): (success: boolean, queued?: boolean, queuedReason?: AgentMessageQueuedReason) => void {
	let settled = false;
	return (success, queued = false, queuedReason) => {
		if (!settled) {
			settled = true;
			preflightResult?.(success, queued, queuedReason);
		}
	};
}

interface RestoredPromptInput {
	text: string;
	content?: (TextContent | ImageContent)[];
	images?: ImageContent[];
	queueKey?: string;
	agentMessageId?: string;
	customMessage?: CustomMessage;
	prefixMessages?: CustomMessage[];
}

export const SESSION_ACTION_RECOVERY_FORMAT_VERSION = 1;

export interface SessionActionRecoveryRecord {
	id: string;
	role: DeliveryRecord["role"];
	message: QueuedAgentMessage;
	ownerActionId: string;
}

export type SessionActionRecoveryPayload =
	| {
			kind: "turn";
			text: string;
			preview?: string;
			records: SessionActionRecoveryRecord[];
			images?: ImageContent[];
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			executionPolicy: TurnExecutionPolicy;
			queueVisible: boolean;
			acceptedAgentMessage: boolean;
			acceptedBeforeCompletion: boolean;
	  }
	| {
			kind: "session_command";
			text: string;
			command: SessionSlashCommand;
			images?: ImageContent[];
	  };

export interface SessionActionRecoveryAction {
	id: string;
	source: InputSource | "internal";
	delivery: DeliveryPolicy;
	wake: WakePolicy;
	payload: SessionActionRecoveryPayload;
	queueKey?: string;
	agentMessageId?: string;
	suppressAutonomousContinuation?: boolean;
}

export interface SessionActionRecoverySnapshot {
	formatVersion: typeof SESSION_ACTION_RECOVERY_FORMAT_VERSION;
	actions: SessionActionRecoveryAction[];
}

function cloneCustomMessage(message: CustomMessage): CustomMessage {
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

function cloneQueuedAgentMessage(message: QueuedAgentMessage): QueuedAgentMessage {
	if (message.role === "custom") return cloneCustomMessage(message);
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

/**
 * The two harness stores a session's digest renders from: the machine-wide global
 * store and this session's own local store. `null` means "no state file", which is a
 * stamp like any other (its appearance and disappearance are both material changes).
 */
interface HarnessStoreStamps {
	global: HarnessStateStamp | null;
	local: HarnessStateStamp | null;
}

function harnessStoreStampsEqual(left: HarnessStoreStamps, right: HarnessStoreStamps): boolean {
	return harnessStateStampsEqual(left.global, right.global) && harnessStateStampsEqual(left.local, right.local);
}

/**
 * Entry keys whose presence or version differs between two fingerprints: the
 * added / removed / version-bumped set the material-change gate judges.
 */
function changedHarnessEntryKeys(previous: Map<string, number>, next: Map<string, number>): Set<string> {
	const changed = new Set<string>();
	for (const [key, version] of next) {
		if (previous.get(key) !== version) changed.add(key);
	}
	for (const key of previous.keys()) {
		if (!next.has(key)) changed.add(key);
	}
	return changed;
}

function primaryDeliveryRecord(action: QueuedSessionAction): DeliveryRecord {
	if (action.payload.kind !== "turn") throw new Error(`Session action ${action.id} is not a turn`);
	const record = action.payload.records.find((candidate) => candidate.role === "primary");
	if (!record) throw new Error(`Turn action ${action.id} has no primary delivery record`);
	return record;
}

function normalizeMessageContent(content: string | (TextContent | ImageContent)[]): {
	text: string;
	images?: ImageContent[];
} {
	if (typeof content === "string") return { text: content };
	const text = content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = content.filter((part): part is ImageContent => part.type === "image");
	return { text, ...(images.length > 0 ? { images } : {}) };
}

function queuedAgentMessagePreview(action: QueuedSessionAction): string {
	const payload = action.payload;
	if (payload.kind === "session_command") return payload.text;
	if (payload.customMessage && isAgentSessionMessage(payload.customMessage)) {
		return `${AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL}: ${payload.customMessage.details.message}`;
	}
	if (payload.customMessage?.customType === ASYNC_BASH_COMPLETION_CUSTOM_TYPE) {
		const details = payload.customMessage.details as AsyncBashCompletionDetails | undefined;
		return details
			? `${ASYNC_BASH_COMPLETION_PREVIEW_LABEL}: pid ${details.pid}, exit ${details.exitCode}`
			: ASYNC_BASH_COMPLETION_PREVIEW_LABEL;
	}
	return payload.preview ?? payload.text;
}

function visibleSessionActionProjection(actions: readonly QueuedSessionAction[]): readonly QueuedSessionAction[] {
	return actions.filter(
		(action) =>
			action.payload.kind === "session_command" ||
			action.payload.queueVisible ||
			action.payload.acceptedAgentMessage,
	);
}

const IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY = "ipython_sent_agent_message";

/**
 * How many new branch entries must accumulate before a skipped or failed
 * threshold compaction retries. Prevents re-firing every turn when the context
 * cannot actually shrink (e.g. a single tool result larger than the usable window).
 */
const THRESHOLD_COMPACTION_RETRY_MIN_NEW_ENTRIES = 5;

/**
 * How long a compaction may hold queued agent messages before the admission gate
 * aborts it and lets them through.
 *
 * The stall watchdog cannot be this bound: it ships warn-only (`abortAfterSeconds`
 * defaults to 0) and it snoozes while a host phase owns the turn boundary, which
 * compaction does. Without a bound of its own, a gate that ranks compaction above
 * agent messages would turn one hung summarization call into a starved family. Two
 * times the default provider stream-stall timeout, so a genuinely slow 1M-token
 * summary still finishes while a wedged stream is cut.
 */
const COMPACTION_GATE_ABORT_AFTER_SECONDS = (DEFAULT_STREAM_STALL_TIMEOUT_MS / 1000) * 2;

interface PersistedIpythonSentAgentMessage {
	toolCallId: string;
	message: KernelSentAgentMessage;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedIpythonSentAgentMessage(value: unknown): PersistedIpythonSentAgentMessage | undefined {
	if (!isObjectRecord(value) || typeof value.toolCallId !== "string" || !isObjectRecord(value.message)) {
		return undefined;
	}
	const { id, message, deliveryStatus, target } = value.message;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		!isObjectRecord(target) ||
		typeof target.activeSessionId !== "string" ||
		typeof target.sessionId !== "string"
	) {
		return undefined;
	}
	return {
		toolCallId: value.toolCallId,
		message: {
			id,
			message,
			deliveryStatus,
			target: {
				activeSessionId: target.activeSessionId,
				sessionId: target.sessionId,
				...(typeof target.sessionName === "string" ? { sessionName: target.sessionName } : {}),
			},
		},
	};
}

function appendSentAgentMessageToToolResult(
	message: AgentMessage,
	toolCallId: string,
	sentMessage: KernelSentAgentMessage,
): boolean {
	if (message.role !== "toolResult" || message.toolName !== "ipython" || message.toolCallId !== toolCallId) {
		return false;
	}
	const details = isObjectRecord(message.details) ? message.details : {};
	const current = Array.isArray(details.sentAgentMessages) ? details.sentAgentMessages : [];
	if (current.some((entry) => isObjectRecord(entry) && entry.id === sentMessage.id)) {
		return true;
	}
	message.details = {
		...details,
		sentAgentMessages: [...current, sentMessage],
	};
	return true;
}

function injectedMessagePreviewLabel(message: CustomMessage): string | undefined {
	switch (message.customType) {
		case HEARTBEAT_PROMPT_CUSTOM_TYPE:
			return HEARTBEAT_PROMPT_PREVIEW_LABEL;
		case ASYNC_BASH_COMPLETION_CUSTOM_TYPE:
			return ASYNC_BASH_COMPLETION_PREVIEW_LABEL;
		case GOAL_CONTEXT_CUSTOM_TYPE:
			return GOAL_CONTEXT_PREVIEW_LABEL;
		default:
			return undefined;
	}
}

interface AgentMessageDeferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

interface AgentMessageOutcome {
	delivery?: AgentMessageDeferred;
	completion?: AgentMessageDeferred;
}

function createAgentMessageDeferred(): AgentMessageDeferred {
	const deferred = {} as AgentMessageDeferred;
	deferred.promise = new Promise<void>((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	deferred.promise.catch(() => undefined);
	return deferred;
}

/** One-shot settlement for a scheduled post-compaction continuation; a settled failure is never re-exposed to later waiters. */
interface PostCompactionContinuationSettlement extends AgentMessageDeferred {
	continueAfterSessionInput: boolean;
	settled: boolean;
}

function createPostCompactionContinuationSettlement(): PostCompactionContinuationSettlement {
	return { ...createAgentMessageDeferred(), continueAfterSessionInput: false, settled: false };
}

export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	isScoped: boolean;
}

interface ModelSelectOptions {
	waitForExtensions?: boolean;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

type GoalSlashCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "start"; objective: string; tokenBudget?: number };

type AutonomousSlashCommand = { kind: "status" } | { kind: "on"; config?: AgentAutonomousConfig } | { kind: "off" };

import type { RlmMaxDepthSource, RlmMaxDepthStatus, SetRlmMaxDepthResult } from "./rlm-max-depth.js";

export type { RlmMaxDepthSource, RlmMaxDepthStatus, SetRlmMaxDepthResult } from "./rlm-max-depth.js";

interface PersistedRlmMaxDepthState {
	maxDepth: number;
}

type AutonomousRuntimeSnapshot = Pick<
	AutonomousRuntimeState,
	"continuationsUsed" | "gateAttempts" | "lastGateFailure" | "lastGateFailureSnapshot"
>;

interface RlmChildRun {
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	/**
	 * The parent's own assistant entry the child's usage is attributed to, resolved on first use.
	 * The lookup scans the whole transcript, so resolving it per child assistant message costs a
	 * copy-and-scan of every entry written so far; the answer cannot change while the run is live.
	 */
	parentUsageEntry?: SessionMessageEntry;
	model: Model<Api>;
	status: RlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	toolUseCount: number;
	activity?: RlmChildAgentActivity;
	/**
	 * Bounded ring of the child's latest progress notes (newest last). Optional:
	 * admission seeds it, but a lifecycle record built by hand (a test's minimal
	 * run literal, a restored registry row) carries no ring, and every reader
	 * treats "no ring" as "no note" rather than throwing.
	 */
	progressNotes?: string[];
	/**
	 * Wall-clock ms of the last tracked child activity; carried into snapshots.
	 * Seeded at admission so a child that never emits a tracked event still
	 * crosses the staleness threshold once running.
	 */
	lastActivityAt?: number;
	/**
	 * Monotonic counterpart of lastActivityAt (performance.now()), written by
	 * the same events. Staleness measures this so wall-clock jumps (a host
	 * sleep freezing the whole session) do not inflate it.
	 */
	lastActivityMonotonicAt?: number;
	error?: string;
	/**
	 * Stall-watchdog kill facts recorded while this run was in flight. Set by the
	 * parent's subscription when the child reports stall_abort/stall_unsettled and
	 * consumed by the terminal classifier, which must rank a kill above "it
	 * replied" instead of reporting the kill as a completed-without-reply.
	 */
	stallAbort?: RlmChildStallAbortFacts;
	/** Display/forensic stall state for the roster row; cleared by the next agent_start. */
	stall?: RlmChildStallState;
	/**
	 * Epoch ms of the last parent-facing "this child is still silent" notice. A rate
	 * limit only - the watchdog's warn stage is edge-triggered per silence episode -
	 * so a child that keeps re-arming the stage cannot flood the parent transcript.
	 */
	lastStallNoticeAt?: number;
	/**
	 * Terminal classification recorded by the run's own terminal path, with the
	 * reason text that went with it. Read-only forensics for `collectRlmChildren`:
	 * a fan-in reader has to tell a watchdog kill from a child that finished
	 * without replying, and it cannot re-derive the classification later because
	 * the reply baseline lived in the run loop's closure. Undefined while the run
	 * is in flight, and for a child whose notice path never ran (suppressed after a
	 * parent abort, or explicitly deleted).
	 */
	terminalKind?: RlmChildTerminalOutcomeKind;
	terminalReason?: string;
	/**
	 * Replies this session still owed this child when the terminal verdict was
	 * recorded, i.e. replies the parent had accepted into its queue but not read.
	 * A `completed_without_reply` notice is provisional on them: the verdict is a
	 * snapshot taken when the child settled, while the notice is published when this
	 * session's queue drains - in production a median of 19 minutes later.
	 */
	provisionalNoReplyReplyIds?: readonly string[];
	/**
	 * The provisional reply that was delivered after the verdict. Set by the delivery
	 * credit, read by the publication gate, and never set for an id a later run
	 * boundary discarded, so an earlier run's notice cannot be suppressed by a reply
	 * that run never earned.
	 */
	noReplyVerdictSupersededBy?: string;
	/**
	 * Set when the publication gate actually withheld this run's no-reply notice, so a
	 * reader that sees `terminal_kind: "completed_without_reply"` but no notice in the
	 * parent's transcript can reconcile the two instead of guessing.
	 */
	noReplyNoticeSuperseded?: boolean;
	/**
	 * The child's own terminal-error report, still queued when this run's failure
	 * verdict was taken. Per run on purpose: a child session outlives the run that
	 * failed, so a session-wide flag would swallow the NEXT run's death report - the
	 * one case where the synthesized notice is the only record.
	 */
	provisionalFailureNoticeReplyId?: string;
	/** That report was delivered after the verdict, so the synthesized one is a duplicate. */
	failureVerdictSupersededBy?: string;
	abort: () => void;
	publication: AgentMessageDeferred;
	/** Resolves after terminal result publication and detached-run cleanup finish. */
	settlement: AgentMessageDeferred;
	/** Child session, once its runtime exists. Used to cancel nested child runs. */
	session?: AgentSession;
	settled: boolean;
	/** Do not inject a late terminal notice after the parent session is aborted. */
	suppressTerminalNotice?: boolean;
	/** Excluded from future strong barriers after an authoritative cancellation cut. */
	abandonedForQuiescence?: boolean;
	/** Selector snapshot for an admitted explicit delete. */
	detachedDeletion?: RlmSubagentRegistryEntry;
	/** Shared physical runtime cleanup owned by the explicit-delete path. */
	deletionCleanup?: Promise<void>;
	deletionCleanupObserver?: Promise<boolean>;
	/** Resolves when a deletion may release its selector reservation. */
	deletionReservation: AgentMessageDeferred;
	deletionCleanupFailed?: boolean;
	deletionRunFinished?: boolean;
	deletionNotice?: Promise<void>;
	deletionFailureNotice?: Promise<void>;
	deletionNeedsCompletionNotice?: boolean;
	completeDeletion?: () => Promise<void>;
	reportDeletionCleanupFailure?: (error: unknown) => Promise<void>;
	emitUpdate?: () => void;
	lastEmittedUpdate?: string;
	/**
	 * Cached rlmChildLabel(prompt): the prompt is a run-level constant, and the
	 * snapshot builder used to re-regex the whole brief on every streaming chunk.
	 */
	label?: string;
	/**
	 * Incremental preview accumulator for the child's in-flight assistant message.
	 * Keeps the per-chunk preview work O(delta) instead of O(text so far).
	 */
	streamPreview?: RlmChildStreamPreview;
	/**
	 * Volatile snapshot fields as last emitted, for the cheap unchanged check that
	 * keeps streaming chunks off the snapshot build and JSON.stringify.
	 */
	lastEmittedFields?: RlmChildEmitFields;
	unsubscribe?: () => void;
}

/**
 * The fields of {@link RlmChildAgentSnapshot} that can change while a run is live.
 * Equal fields (with reference equality for the model and stall objects) imply an
 * identical serialization, so an update whose fields all match the last emission
 * cannot carry anything new on the wire.
 */
interface RlmChildEmitFields {
	model: Model<Api> | undefined;
	sessionName: string | undefined;
	status: RlmChildAgentStatus;
	durationMs: number | undefined;
	answerPreview: string | undefined;
	toolUseCount: number | undefined;
	tokenCount: number | undefined;
	recap: string | undefined;
	activityKind: RlmChildAgentActivity["kind"] | undefined;
	activityToolName: string | undefined;
	repliedSinceTask: boolean | undefined;
	error: string | undefined;
	stall: RlmChildStallState | undefined;
}

/**
 * Reference/strict equality over {@link RlmChildEmitFields}: every field is either a
 * primitive, an immutable model record, or an object that is replaced (never mutated
 * in place) when it changes. Equal fields serialize identically, so an update whose
 * fields all match the last emission cannot carry anything new on the wire.
 */
function rlmChildEmitFieldsEqual(fields: RlmChildEmitFields, last: RlmChildEmitFields | undefined): boolean {
	if (last === undefined) return false;
	return (
		fields.model === last.model &&
		fields.sessionName === last.sessionName &&
		fields.status === last.status &&
		fields.durationMs === last.durationMs &&
		fields.answerPreview === last.answerPreview &&
		fields.toolUseCount === last.toolUseCount &&
		fields.tokenCount === last.tokenCount &&
		fields.recap === last.recap &&
		fields.activityKind === last.activityKind &&
		fields.activityToolName === last.activityToolName &&
		fields.repliedSinceTask === last.repliedSinceTask &&
		fields.error === last.error &&
		fields.stall === last.stall
	);
}

interface RetainedRlmChild {
	session: AgentSession;
	run?: RlmChildRun;
}

interface RlmSubagentModelSelection {
	model: Model<Api>;
}

const KERNEL_STATE_LISTING_TIMEOUT_MS = 5000;
/** How much of a dead kernel's stderr tail the session log keeps; the ring itself holds 8 KiB. */
const KERNEL_DEATH_STDERR_LOG_CHARS = 1024;
/** Two unexpected exits this close together are a crash loop, not bad luck (F2). */
const KERNEL_FAST_RESTART_GAP_MS = 60_000;

/**
 * Kernel host request types a cell abort may cancel (P1-2a). Every entry is read-only, and the
 * annotation is the review artifact: a wrong entry here loses admitted work, which is a
 * rollback-level mistake rather than a bug.
 *
 * Deliberately absent - each has a side effect, so each keeps the teardown-only signal and stays
 * fire-and-forget:
 *   rlm.run              admits a child that must outlive the turn that spawned it (M7);
 *   rlm.delete_subagent  deletes a child and its artifacts;
 *   agent_message.send   delivers a message the recipient may already have acted on;
 *   goal.* / compact.* / refine.* / rlm_heartbeat.*  mutate session or harness state;
 *   mcp.*                the host cannot know what a server does with a call, so it is not
 *                        declared read-only by default.
 */
export const CANCELLABLE_KERNEL_HOST_REQUEST_TYPES: readonly string[] = [
	"rlm.find_models", // reads the authenticated model catalog
	"rlm.list_subagents", // reads this session's own child roster
	"rlm.collect", // bounded read-only wait for this session's own children; cancelling it cancels no child
	"agent_observe.*", // list/get/recent: reads transcripts and status
	"model.info", // reads this session's model
	"agent_message.list_agents", // reads the family roster
];
const SESSION_PERSIST_FAILURE_REPORT_BASE_MS = 30_000;
const SESSION_PERSIST_FAILURE_REPORT_MAX_MS = 300_000;
const RLM_MAX_DEPTH_STATE_CUSTOM_TYPE = "rlm_max_depth_state";
/** Minimum spacing between accepted progress notes from one child session. */
const RLM_PROGRESS_NOTE_MIN_INTERVAL_MS = 10_000;
/** Bounded ring of progress notes kept per child run; the snapshot exposes the newest. */
const RLM_CHILD_PROGRESS_NOTE_RING_MAX = 5;
/** A running child with no tracked activity for this long reports activityStaleMs. */
const RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS = 10 * 60_000;
/** How long a deferred RLM terminal notice may wait for delivery before it is abandoned. */
const RLM_TERMINAL_NOTICE_ABANDON_AFTER_MS = 5 * 60_000;

/**
 * Minimum spacing between two parent-facing "this child is still silent" notices for
 * one run. The watchdog's warn stage is already edge-triggered (it fires once per
 * silence episode and re-arms on the child's next event), so this only bounds the
 * case of a child that keeps re-arming the stage with a trickle of events: the
 * parent gets at most one notice per interval instead of one per re-arm.
 */
const RLM_CHILD_STALL_NOTICE_MIN_INTERVAL_MS = 10 * 60_000;
/** Consecutive retryable agent-message send failures before the error becomes terminal (M6b). */
const AGENT_MESSAGE_RETRYABLE_FAILURE_LIMIT = 3;

/**
 * FR-4: how long one quiescence barrier waits before giving up. A descendant
 * that never settles must not park the barrier (and every headless completion
 * behind it) forever; past the deadline the wait warns and reports
 * `{ settled: false }`.
 */
const RLM_QUIESCENCE_GIVE_UP_MS = 5 * 60_000;

/** O1: how long a recorded agent-message send failure stays "consecutive". */
const AGENT_MESSAGE_SEND_FAILURE_TTL_MS = 24 * 60 * 60_000;

/** O1: hard ceiling on distinct failed targets kept in the ledger. */
const AGENT_MESSAGE_SEND_FAILURE_MAX_TARGETS = 512;

/** Outcome of a quiescence barrier wait: settled, or gave up on the deadline. */
export interface RlmQuiescenceOutcome {
	/** False when the wait gave up on its deadline with work still unsettled. */
	settled: boolean;
	/** Present when settled is false because the give-up deadline fired. */
	timedOut?: true;
}
/** How long failure-class terminal notices are collected before one aggregated wake. */
const FAILURE_WAKE_AGGREGATION_MS = 2_000;
/**
 * After an Esc/kill, at most one aggregated failure wake inside this window; later
 * failures are persisted instead of re-igniting the session (B3/N-3 total gate).
 * Deliberately named apart from the stall watchdog's own 50min exemption budget:
 * same length, different clock and different meaning.
 */
const FAILURE_WAKE_QUIET_WINDOW_MS = 50 * 60_000;
/** Retry cadence for flushing deferred failure notices once the pump is runnable again. */
const RLM_TERMINAL_NOTICE_FLUSH_RETRY_MS = 30_000;
/** Bound on one aggregated wake's text so a failing family cannot flood the turn. */
const FAILURE_WAKE_REASON_MAX_CHARS = 200;
/** Sidecar file prefix holding notices/queued replies a dispose would otherwise drop (B10). */
const UNDELIVERED_RLM_NOTICES_FILE = "undelivered-rlm-notices.jsonl";
/** Bound on sidecar rows so a family failing in a loop cannot grow the file forever. */
const UNDELIVERED_RLM_NOTICES_MAX_ROWS = 200;
/**
 * Live children one session may hold at once before admission refuses (SC-1). Depth alone
 * does not bound anything: a single session could fan out without limit, and every admitted
 * run is another kernel, another session file, and another entry in an unbounded map.
 * Overridable per session (`rlmMaxChildren`) or per process (`RLM_MAX_CHILDREN`); 0 disables
 * the cap, which is the only way back to the old unbounded behavior.
 */
const DEFAULT_RLM_MAX_CONCURRENT_CHILDREN = 8;

interface UndeliveredRlmNoticeRow {
	key: string;
	message: CustomMessage;
	writtenAt: number;
}
/**
 * How long a writability probe stays valid. Writability rarely flips mid-session,
 * and refine() re-checks it before writing, so a stale "allowed" cannot turn into
 * a silent write failure - it only avoids re-reading the whole harness state on
 * every turn boundary.
 */
const AUTO_REFINE_WRITABLE_PROBE_TTL_MS = 60_000;

/**
 * Turn text for one aggregated failure wake: states the count and each cause, and
 * points at the per-child notices that ride along as prefix messages.
 */
function aggregatedFailureWakeText(notices: readonly CustomMessage[]): string {
	const entries = notices.map((notice) => {
		const details = notice.details as RlmChildFailureDetails | undefined;
		const name = details?.sessionName ?? "subagent";
		const reason = (details?.error ?? (typeof notice.content === "string" ? notice.content : ""))
			.replace(/\s+/g, " ")
			.trim();
		return `${name}: ${reason.slice(0, FAILURE_WAKE_REASON_MAX_CHARS)}`;
	});
	const noun = notices.length === 1 ? "subagent failed" : "subagents failed";
	return (
		`${notices.length} ${noun} while this session was stopped. ${entries.join(" | ")}. ` +
		"Each failure notice is included below; nothing was lost. Read the causes before re-dispatching: " +
		"re-sending the same task to the same wedged shape will fail the same way."
	);
}

function noopRlmChildAbort(): void {}
function noopRlmChildEventUnsubscribe(): void {}

function autoRefineInstructions(reason: AutoRefineReason, review: AutoRefineReview): string {
	const detail = review.instructions
		? `
Reviewer instructions: ${review.instructions}`
		: "";
	return `Automatic refine review triggered by ${reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: ${review.rationale}${detail}`;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseDepth(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value === "") {
		return fallback;
	}
	if (!/^\d+$/.test(value)) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	const parsed = Number(value);
	if (!isNonNegativeInteger(parsed)) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return parsed;
}

/**
 * The cap on simultaneously live children this session admits (SC-1). Explicit config wins,
 * then `RLM_MAX_CHILDREN`, then the default bound; 0 means "no cap".
 */
function resolveRlmMaxConcurrentChildren(configured: number | undefined): number {
	if (configured !== undefined) {
		if (!isNonNegativeInteger(configured)) {
			throw new Error("rlmMaxChildren must be a non-negative integer (0 disables the cap)");
		}
		return configured;
	}
	return parseDepth(process.env.RLM_MAX_CHILDREN, DEFAULT_RLM_MAX_CONCURRENT_CHILDREN, "RLM_MAX_CHILDREN");
}

function isPersistedRlmMaxDepthState(value: unknown): value is PersistedRlmMaxDepthState {
	return (
		typeof value === "object" && value !== null && isNonNegativeInteger((value as PersistedRlmMaxDepthState).maxDepth)
	);
}

function parseGoalBudgetValue(value: string): number {
	if (!/^[1-9]\d*$/.test(value)) {
		throw new Error("Goal token budget must be a positive integer.");
	}
	const budget = validateGoalBudget(Number(value));
	if (budget === undefined) {
		throw new Error("Goal token budget must be a positive integer.");
	}
	return budget;
}

const AUTONOMOUS_STATUS_NUMBER_FORMAT = new Intl.NumberFormat("en-US");

const AUTONOMOUS_BUDGET_USAGE =
	"Usage: /autonomous [status|off] or /autonomous on [--max-continuations <n|unlimited>] [--max-turns <n|unlimited>] [--max-tokens <n|unlimited>] [--timeout-ms <n|unlimited>] [--gate <command>] [--gate-retries <n>] [--gate-timeout-ms <n>] [--subagent-keep-alive-ms <n>]";

// `/autonomous` budget flags mirror the `--autonomous-*` CLI options. The CLI
// spelling (`--autonomous-max-continuations`) is accepted as an alias so the
// exact CLI budget flags also work from the slash command.
const AUTONOMOUS_BUDGET_FLAGS: ReadonlySet<string> = new Set([
	"max-continuations",
	"max-turns",
	"max-tokens",
	"timeout-ms",
	"gate",
	"gate-retries",
	"gate-timeout-ms",
	"subagent-keep-alive-ms",
]);

/** Keep-alive windows accept 0 (disable the valve) or a positive integer. */
function parseSubagentKeepAliveMs(value: string): number {
	const digits = value.replace(/[,_]/g, "");
	if (digits === "0" || /^[1-9]\d*$/.test(digits)) {
		const parsed = Number(digits);
		if (parsed <= MAX_SUBAGENT_KEEP_ALIVE_MS) {
			return parsed;
		}
	}
	throw new Error(
		`--subagent-keep-alive-ms must be 0 or a positive integer up to ${MAX_SUBAGENT_KEEP_ALIVE_MS}. ${AUTONOMOUS_BUDGET_USAGE}`,
	);
}

function parseAutonomousBudgetInt(flag: string, value: string, allowUnlimited = false): number {
	if (allowUnlimited && value.toLowerCase() === "unlimited") {
		return UNLIMITED_AUTONOMOUS_LIMIT;
	}
	// Commas and underscores are accepted as digit separators (100,000,000).
	const digits = value.replace(/[,_]/g, "");
	if (!/^[1-9]\d*$/.test(digits)) {
		throw new Error(
			`--${flag} must be a positive integer${allowUnlimited ? ' or "unlimited"' : ""}. ${AUTONOMOUS_BUDGET_USAGE}`,
		);
	}
	return Number(digits);
}

function parseAutonomousBudgetOptions(tokens: string[]): AgentAutonomousConfig {
	const config: AgentAutonomousConfig = {};
	const gateCommands: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!token.startsWith("--")) {
			throw new Error(`Unexpected autonomous argument: ${token}. ${AUTONOMOUS_BUDGET_USAGE}`);
		}
		const equalsIndex = token.indexOf("=");
		const rawFlag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
		const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
		const flag = rawFlag.startsWith("--autonomous-") ? rawFlag.slice("--autonomous-".length) : rawFlag.slice(2);
		if (!AUTONOMOUS_BUDGET_FLAGS.has(flag)) {
			throw new Error(`Unknown autonomous budget flag: ${rawFlag}. ${AUTONOMOUS_BUDGET_USAGE}`);
		}
		let value = inlineValue;
		if (value === undefined) {
			const next = tokens[i + 1];
			if (next === undefined || next.startsWith("--")) {
				throw new Error(`Missing value for ${rawFlag}. ${AUTONOMOUS_BUDGET_USAGE}`);
			}
			value = next;
			i++;
		}
		if (value === "") {
			throw new Error(`Missing value for ${rawFlag}. ${AUTONOMOUS_BUDGET_USAGE}`);
		}
		switch (flag) {
			case "gate":
				gateCommands.push(value);
				break;
			case "gate-retries":
				config.gates = config.gates ?? {};
				config.gates.maxRetries = parseAutonomousBudgetInt(flag, value);
				break;
			case "gate-timeout-ms":
				config.gates = config.gates ?? {};
				config.gates.timeoutMs = parseAutonomousBudgetInt(flag, value);
				break;
			case "max-continuations":
				config.maxContinuations = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "max-turns":
				config.maxTurns = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "max-tokens":
				config.maxTokens = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "timeout-ms":
				config.timeoutMs = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "subagent-keep-alive-ms":
				config.subagentKeepAliveMs = parseSubagentKeepAliveMs(value);
				break;
		}
	}
	if (gateCommands.length > 0) {
		config.gates = { ...config.gates, commands: gateCommands };
	}
	// Named budget flags define the whole budget: any limit the user did not
	// name stops cutting the run short. With no budget flags at all, the
	// configured or default limits still apply.
	if (
		config.maxContinuations !== undefined ||
		config.maxTurns !== undefined ||
		config.maxTokens !== undefined ||
		config.timeoutMs !== undefined
	) {
		config.maxContinuations ??= UNLIMITED_AUTONOMOUS_LIMIT;
		config.maxTurns ??= UNLIMITED_AUTONOMOUS_LIMIT;
		config.maxTokens ??= UNLIMITED_AUTONOMOUS_LIMIT;
		config.timeoutMs ??= UNLIMITED_AUTONOMOUS_LIMIT;
	}
	return config;
}

export function compactRlmText(text: string, maxLength = 160): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

// Child-agent label: collapse to one line but keep the full prompt — the TUI
// truncates to the visible width and elides shared prefixes, so capping here
// would only hide the divergence between near-identical sibling prompts.
export function rlmChildLabel(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim() || "child agent";
}

/**
 * Incremental counterpart of {@link compactRlmText} for a streaming assistant
 * message. The preview only depends on the first ~maxLength collapsed characters, so
 * the window stays bounded and freezes once the cap is crossed; new text is folded in
 * by tracking how much of each text block has been consumed, which keeps the per-chunk
 * work at O(new characters + block count) instead of a full join and regex per chunk.
 * String lengths are O(1) in V8, so the tracking itself never touches the old text.
 * A block structure the length tracking cannot describe (a block shrinking, the text
 * count dropping) pays one exact full-text pass instead.
 *
 * At every point the folded text equals readAssistantText(message) as it stood at the
 * last update, so `update()` returns exactly `compactRlmText(textSoFar, maxLength)`.
 */
class RlmChildStreamPreview {
	/** Consumed length per text block, aligned with the message's text-block order. */
	private foldedTextBlockLengths: number[] = [];
	private buf = "";
	private cappedResult: string | undefined;

	constructor(private readonly maxLength: number = 160) {}

	/** Fold the message's new text in and return the compacted preview. */
	update(message: AssistantMessage): string {
		const lengths: number[] = [];
		const deltas: string[] = [];
		let structural = false;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const consumed = this.foldedTextBlockLengths[lengths.length] ?? 0;
			if (block.text.length < consumed) {
				structural = true;
				break;
			}
			if (block.text.length > consumed) deltas.push(block.text.slice(consumed));
			lengths.push(block.text.length);
		}
		if (structural || lengths.length < this.foldedTextBlockLengths.length) {
			this.foldedTextBlockLengths = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block.type === "text" ? block.text.length : 0));
			this.buf = readAssistantText(message).replace(/\s+/g, " ");
			this.cappedResult = undefined;
			this.applyCap();
			return this.preview();
		}
		this.foldedTextBlockLengths = lengths;
		if (this.cappedResult === undefined) {
			for (const delta of deltas) {
				if (delta.length === 0) continue;
				// The window may carry one trailing space so a delta that opens with
				// whitespace collapses against it, exactly like the full-text regex would.
				this.buf = `${this.buf}${delta}`.replace(/\s+/g, " ");
				this.applyCap();
				if (this.cappedResult !== undefined) break;
			}
		}
		return this.preview();
	}

	preview(): string {
		return this.cappedResult ?? this.buf.trim();
	}

	private applyCap(): void {
		// Same cap decision as compactRlmText: it caps on the trimmed length, so the
		// window's optional trailing space must not tip a text under the cap over it.
		const trimmed = this.buf.trim();
		if (trimmed.length > this.maxLength) {
			this.cappedResult = `${trimmed.slice(0, Math.max(0, this.maxLength - 3)).trimEnd()}...`;
			this.buf = "";
		}
	}
}

/**
 * Record a tracked child activity on both clocks: lastActivityAt stays
 * wall-clock ms for snapshots, and its monotonic twin bounds staleness so a
 * host sleep cannot inflate it.
 */
function touchRlmChildActivity(run: RlmChildRun): void {
	run.lastActivityAt = Date.now();
	run.lastActivityMonotonicAt = performance.now();
}

/**
 * Lazily computed staleness for a running child: how long since the last
 * tracked activity, once past the threshold. Computed at snapshot build time
 * only — no background timers update it.
 *
 * A tool call in flight (activity "executing") is legitimately quiet for its
 * whole duration — a minutes-long bash() run emits no events while it works —
 * so an executing child never reports stale. Staleness measures active time:
 * the wall clock alone would mark every running child stale after a laptop
 * sleep, so the smaller of the wall and monotonic clock deltas bounds it to
 * time the host was actually awake.
 */
function rlmActivityStaleMs(
	status: RlmChildAgentStatus,
	activity: RlmChildAgentActivity | undefined,
	lastActivityAt: number | undefined,
	lastActivityMonotonicAt: number | undefined,
): number | undefined {
	if (status !== "running" || lastActivityAt === undefined) return undefined;
	if (activity?.kind === "executing") return undefined;
	const wallStaleMs = Date.now() - lastActivityAt;
	const monotonicStaleMs =
		lastActivityMonotonicAt === undefined ? wallStaleMs : performance.now() - lastActivityMonotonicAt;
	// Integer ms like every other roster wire field: performance.now() deltas
	// are fractional, and the kernel parser rejects non-int activity_stale_ms.
	const staleMs = Math.floor(Math.min(wallStaleMs, monotonicStaleMs));
	return staleMs >= RLM_CHILD_STALE_ACTIVITY_THRESHOLD_MS ? staleMs : undefined;
}

function readAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function waitForPromiseOrAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	abortMessage: string,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error(abortMessage));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(new Error(abortMessage));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		// Close the listener-registration race before observing the awaited work.
		if (signal.aborted) return onAbort();
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function attributeChildUsage(parentUsage: Usage, childUsage: Usage): void {
	const parentContextTokens =
		parentUsage.totalTokens ||
		parentUsage.input + parentUsage.output + parentUsage.cacheRead + parentUsage.cacheWrite;
	// Recursive children are launched from an assistant tool call, so the parent assistant
	// message carries their billable usage for session-level cost totals.
	addAssistantUsage(parentUsage, childUsage);
	// Child work affects session-level billable totals, not the parent's model-facing context size.
	parentUsage.totalTokens = parentContextTokens;
}

/**
 * Join the instructions a manual compaction was given with the instructions a
 * pending compact.run request carries (MVS-2): the manual run satisfies the
 * request, and the auto path's contract - any compaction honors a pending
 * request's instructions - holds for it too. The caller's own instructions stay
 * first; empty strings never contribute.
 */
function joinCompactionInstructions(manual: string | undefined, pending: string | undefined): string | undefined {
	const parts = [manual, pending].filter(
		(value): value is string => typeof value === "string" && value.trim().length > 0,
	);
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	private _serviceTierPreference: ServiceTier;
	/** The user's requested thinking level, before per-model clamping (r43 MC-3). */
	private _requestedThinkingLevel: ThinkingLevel | undefined;

	private _scopedModels: Array<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}>;

	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _lastSessionActionSnapshot: SessionActionSnapshot = {
		queuedCount: 0,
		steering: [],
		followUps: [],
	};
	private _agentEventQueue: Promise<void> = Promise.resolve();

	/** Session-owned actions. Items are never fed into Agent.steer/followUp. */
	private readonly _actionStore = new ActionStore<QueuedSessionAction>();
	// One-shot "all" steering batch armed by abortAndSendQueued: read on selection, never
	// consumed on read, and disarmed once the armed actions leave the steering queue.
	private _forcedAllSteeringActionIds: ReadonlySet<string> | undefined;
	private _sessionInputPump: Promise<void> = Promise.resolve();
	private _sessionInputPumpRequested = false;
	// Invalidates preparation when a branch pause starts and finishes before its next await resumes.
	private _sessionInputPumpEpoch = 0;
	private _sessionInputArrivalEpoch = 0;
	// Persists abort/restart suspension after the initiating call returns.
	private _sessionInputPumpSuspended = false;
	private _sessionInputSuspendedForUpdateRestart = false;
	// Branch mutation pause leases can overlap and must all release before dispatch resumes.
	private readonly _queuedWorkPauses = new Set<symbol>();
	private readonly _sessionInputAdmissionPauses = new Map<symbol, { forUpdateRestart: boolean }>();
	/** Admission pause held while the update-restart teardown fence is up (QP-2, r39). */
	private _updateRestartAdmissionPause: { release(): void } | undefined;
	private readonly _durableRlmTerminalNoticeActionIds = new Set<string>();
	private _rlmTerminalNoticeDeferredSince: number | undefined;
	private _rlmTerminalNoticeAbandonment: { abandonedAt: number; count: number } | undefined;
	/** When the pump was suspended by the current Esc/kill, if it is suspended. */
	private _sessionInputSuspendedSince: number | undefined;
	/** One aggregated failure wake per suspension window (B3 total gate). */
	private _failureWakeUsedForSuspension = false;
	/** Failure-class notices collected for the next aggregated wake. */
	private readonly _pendingFailureWakeNotices: CustomMessage[] = [];
	private _failureWakeTimer: ReturnType<typeof setTimeout> | undefined;
	private _failureWakeFlushTimer: ReturnType<typeof setTimeout> | undefined;
	private _rlmTerminalNoticeAbandonTimer: ReturnType<typeof setTimeout> | undefined;
	private _sessionActionCommitTail: Promise<void> = Promise.resolve();
	private _sessionActionCommitOwner: symbol | undefined;
	private _pendingSessionActionFenceWaiters = 0;
	private readonly _sessionActionCommitContext = new AsyncLocalStorage<symbol>();
	private readonly _sessionActionCommitDisposeAbortController = new AbortController();
	// Checkpoint, handoff, and activity waiters share lifecycle-edge notifications to avoid polling.
	private readonly _sessionInputCheckpointWaiters = new Set<() => void>();
	private _pendingNextTurnMessages: CustomMessage[] = [];

	private _goalState: GoalState = emptyGoalState();
	private _goalAccountingStartedAt: number | undefined = undefined;
	private _goalContinuationAwaitsRlmWork = false;
	private _goalAccountedAssistantMessages = new WeakSet<AssistantMessage>();
	private _goalAbortInProgress = false;
	private _autonomousState: AutonomousRuntimeState;
	private _autonomousContinuationSuppressionDepth = 0;
	private _autonomousContinuationSuppressedMessages = new WeakSet<AgentMessage>();
	// Held autonomous continuation owed while descendant work runs; mirrors
	// _goalContinuationAwaitsRlmWork. Child replies and exit notices are the
	// real wake-up signals, so timer-driven continuations pause instead of
	// re-prompting a waiting parent (and pause without consuming budget).
	private _autonomousContinuationAwaitsRlmWork = false;
	private _autonomousSubagentKeepAliveTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	// In-flight gate evaluation for an owed continuation; holds the promise so
	// settlement sites never double-fire the resume.
	private _autonomousContinuationResumeTask: Promise<void> | undefined = undefined;
	// Monotonic count of admitted RLM child terminal notices; differencing
	// against the arrival epoch separates sibling notices (benign for the
	// owed continuation) from user-driven admissions.
	private _rlmTerminalNoticeAdmissionCount = 0;

	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	// The auto compaction scope a manual compact() preempted (K3R-11). That abort
	// is not the user cancelling the queued work, so the auto compaction's catch
	// must treat it differently from abortCompaction()/requestAbort().
	private _autoCompactionPreemptedByManual: AbortController | undefined = undefined;
	private _compactionOperation: Promise<void> | undefined = undefined;
	/** Timer that aborts a compaction holding queued agent messages for too long. */
	private _compactionGateWatchdog: ReturnType<typeof setTimeout> | undefined = undefined;
	/** In-flight manual compact() (r25-1): synchronous admission for mutual exclusion. */
	private _manualCompactionInFlight:
		| { operation: Promise<CompactionResult>; customInstructions: string | undefined }
		| undefined = undefined;
	/** One recovery attempt per overflow; "reported" dedups the failure notice. */
	private _overflowRecovery: "idle" | "attempted" | "reported" = "idle";
	/**
	 * Compactions that failed in a row, counted across auto and manual attempts.
	 * A context above its threshold whose compaction cannot run does not shrink on
	 * its own, so once this reaches COMPACTION_RECOVERY_HINT_THRESHOLD the failure
	 * notice carries the user's way out instead of only the provider error.
	 */
	private _consecutiveCompactionFailures = 0;
	private _continueAfterThresholdCompaction = false;
	/**
	 * Cooldown after a threshold compaction that skipped or failed, so an
	 * unshrinkable context (e.g. one tool result larger than the usable window)
	 * does not re-fire a wasted summarization attempt on every single turn.
	 * Retry once the branch grows by a few entries or the model changes.
	 */
	private _thresholdCompactionCooldown: { branchEntryCount: number; modelKey: string } | undefined;
	private _pendingRequestedCompaction: { customInstructions?: string } | undefined;
	private _pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;

	private _branchSummaryAbortController: AbortController | undefined = undefined;
	private _branchSummaryOperation: Promise<void> | undefined = undefined;

	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/** Bumped by every retry resolution; stale scheduled-continue callbacks check it before touching retry state. */
	private _retryGeneration = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	private _retryAuthFailureSources: AuthSourceToken[] = [];
	/** Ongoing wait-for-recovery state: pings issued and when the wait started. */
	private _providerWait: { attempts: number; startedAtMs: number } | undefined = undefined;
	/** Set while turns are routed to the user-configured backup model. */
	private _backupModel:
		| {
				backup: Model<any>;
				primary: Model<any>;
				thinkingLevel: ThinkingLevel;
				serviceTier: ServiceTier;
		  }
		| undefined = undefined;
	private _agentMessageClearEpoch = 0;
	private _agentMessageOutcomes = new Map<string, AgentMessageOutcome>();
	/**
	 * Child replies this session queued but has not delivered yet. Delivery credits
	 * the sender's reply count, which a `queued` receipt deliberately did not (B1).
	 */
	private readonly _queuedChildReplyBackfills = new QueuedParentReplyBackfills();
	private _lateIpythonSentAgentMessages = new Map<string, KernelSentAgentMessage[]>();
	/** Outcome disclosures whose session-file append failed; retained for context rebuilds. */
	private readonly _unpersistedOutcomes: CustomMessage[] = [];
	/**
	 * Fresh/empty contexts defer digest injection to the first committed turn, so an
	 * untouched session keeps reading as empty to every raw message-count check
	 * (draft cleanup, daemon session list, branch seedability, hasExistingSession).
	 */
	private _harnessDigestPending = false;
	/** Store stamps as of the last digest render; unchanged stamps skip the render entirely. */
	private _harnessDigestStamps: HarnessStoreStamps | undefined;
	/** Entry identity as of the last digest render, for the material-change difference. */
	private _harnessDigestFingerprint: Map<string, number> | undefined;
	/**
	 * Entry keys this session already itemized for the model in a refinement receipt
	 * (applied and refused), so a digest delta does not deliver the same news twice.
	 */
	private readonly _refinementReportedEntryVersions = new Map<string, number>();
	private _bashAbortControllers = new Set<AbortController>();
	private _userBashRunning = false;
	private _userBashAbortRequested = false;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	private _extensionRunner!: ExtensionRunner;
	private _execEnvProvider?: () => Record<string, string | undefined> | undefined;
	private _turnIndex = 0;
	private _modelSelectEmitQueue: Promise<void> = Promise.resolve();
	private _modelSelectEmitQueueIdle = true;
	private _modelSelectEmitContext = new AsyncLocalStorage<boolean>();

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _acpMcpTools: ToolDefinition[] = [];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _agentDir?: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _includeGoals: boolean;
	private _includeCompactSkill: boolean;
	private _rlmHeartbeatController?: AgentRlmHeartbeatController;
	private _agentMessageController?: AgentSessionMessageController;
	private _agentObserveController?: AgentObserveController;
	private _mcpManager?: McpManager;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	/**
	 * Open extension dialogs. A turn blocked on one is waiting for the user, not stalled.
	 * A dialog that never settles keeps this above zero; the watchdog's pause budget
	 * (maxPausedMs) bounds how long that can silence escalation.
	 */
	private _pendingUiDialogs = 0;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _disposed = false;
	private readonly _disposeCallbacks = new Set<() => void | Promise<void>>();
	private _disposeCallbacksPromise?: Promise<void>;
	// Set at the start of async teardown so a child finishing mid-disposeAsync doesn't
	// re-populate the retained map after it's been cleared.
	private _disposing = false;
	private _disposeAsyncPromise?: Promise<void>;
	private _ipythonKernelProvisioner?: IpythonKernelProvisioner;
	/** Artifact dir backing the current provisioner's kernel snapshot, if any. */
	private _ipythonKernelSnapshotDir?: string;
	/** True once the runtime has been built once; later builds are in-process rebuilds (/reload). */
	private _ipythonRuntimeBuilt = false;
	private readonly _prewarmIpythonKernel: boolean;
	private _rlmDepth: number;
	private readonly _configuredRlmMaxDepth: number | undefined;
	private _rlmMaxDepth: number;
	private _rlmMaxDepthSource: RlmMaxDepthSource;
	/** Cap on simultaneously live children; 0 disables it (SC-1). */
	private readonly _rlmMaxConcurrentChildren: number;
	/**
	 * Ceiling an ancestor imposed on this session *after* it was admitted (SC-2). A child
	 * snapshots its parent's cap at spawn; a later reduction on the ancestor would otherwise
	 * leave the in-flight subtree spawning at the old, wider cap. This is that live push, and
	 * it is deliberately tracked (not ratcheted): an ancestor that widens its cap again pushes
	 * the wider value, so a subtree can never get stuck behind an invisible limit.
	 */
	private _rlmMaxDepthCeiling: number | undefined;
	private _rlmSessionDir?: string;
	/** True when `_rlmSessionDir` is this session's own `prime-agent-rlm-*` tmpdir (RC-6). */
	private _rlmSessionDirEphemeral = false;
	private readonly _semanticEdges: SemanticEdgeRecorder;
	private _rlmParentNodeId?: string;
	private _rlmParentAgent?: string;
	private _repliedToParentSinceTask: boolean | undefined;
	private _parentReplyCount = 0;
	/**
	 * Stall-watchdog abort facts for the turn in flight, if the watchdog fired.
	 * `settled` flips false when the watchdog reports abort_unsettled, so a run
	 * that was never stopped is not reported as killed.
	 */
	private _lastStallAbort: RlmChildStallAbortFacts | undefined;
	/**
	 * Live stall marker for roster rows: set when the watchdog reports a stage,
	 * cleared by the next agent_start. Published so a daemon can put a wedged
	 * session's silence on its summary row even when the parent that spawned it
	 * lives in another worker.
	 */
	private _stallState: RlmChildStallState | undefined;
	/** Why the last abort of this session was requested; cleared by the next agent_start. */
	private _lastTurnAbortReason: RlmChildTurnAbortReason | undefined;
	/** The child already delivered its own terminal-error notice to the parent. */
	private _terminalErrorNoticeDelivered = false;
	/**
	 * Message id of this session's terminal-error notice while it sits in the
	 * parent's queue. The send receipt said `queued`, so B1 keeps
	 * `_terminalErrorNoticeDelivered` false; the parent's delivery credit names the
	 * id it just delivered, which is how this session learns the report did land.
	 */
	private _queuedTerminalErrorNoticeMessageId: string | undefined;

	/**
	 * Consecutive retryable `agent_message.send` failures per target. Bounded on
	 * purpose: a retryable error plus a host liveness vouch plus a persistent model
	 * is a no-output loop, so after a few attempts the error becomes terminal.
	 *
	 * O1: entries are not forever. A target that failed once and was never
	 * addressed again used to keep its count forever - a long-lived session
	 * accumulated one entry per ever-failed target, and a failure from yesterday
	 * still counted as "consecutive" today. Entries expire after 24h, and the
	 * ledger holds a hard volume ceiling so a pathological sender fan-out cannot
	 * grow it without bound.
	 */
	private readonly _agentMessageSendFailures = new Map<
		string,
		{ count: number; lastError: string; lastFailedAt: number }
	>();
	/**
	 * Retry attempts consumed by the failure sequence that reached the last
	 * terminal-error junction. Lets the parent-facing terminal notice say whether
	 * retries were exhausted or never attempted, even though `_retryAttempt` is
	 * already reset by the time the notice is composed.
	 */
	private _terminalFailureAttemptCount = 0;
	private _subagentRuntimeHost?: SubagentRuntimeHost;
	private _activeRlmChildRuns = new Map<string, RlmChildRun>();
	/** Wall-clock ms of the last accepted progress note; throttles rlm.progress.note. */
	private _lastRlmProgressNoteAt: number | undefined;
	private _unsettledRlmChildRuns = new Set<RlmChildRun>();
	private _abandonedRlmQuiescenceChildIds = new Set<string>();
	private _rlmQuiescenceWaitAborts = new Set<AbortController>();
	private _pendingRlmSubagentSessionNames = new Set<string>();
	// Inline mode keeps finished child sessions so the inspector can still read them;
	// the daemon does the same by leaving the child session resident in its registry.
	private _rlmChildSessions = new Map<string, RetainedRlmChild>();
	private _deletedRlmChildIds = new Set<string>();
	// Failed explicit deletes stay hidden from listings but retain their original
	// selector so a later delete can retry cleanup without orphaning the runtime.
	private _rlmChildCleanupFailures = new Map<string, RlmSubagentRegistryEntry>();
	private _deletingRlmChildren = new Map<
		string,
		{
			subagent: RlmSubagentRegistryEntry;
			promise: Promise<RlmDeleteSubagentResult>;
		}
	>();
	// Kept alive for retained children so nested updates (e.g. a grandchild cancel)
	// still forward to root; torn down when the retained child is disposed.
	private _rlmChildUnsubscribes = new Map<string, () => void>();
	/** Latest recap for this session, written by the daemon summarizer; read by a parent to label its child snapshots. */
	private _currentRecap?: string;

	private _modelRegistry: ModelRegistry;

	private _toolRegistry: Map<string, AgentTool> = new Map();
	private readonly _warnedToolNameConflicts = new Set<string>();
	private readonly _notifiedToolNameConflicts = new Set<string>();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _assistantTurnsSinceAutoRefine = 0;
	private _lastAutoRefineReviewAt = 0;
	private _autoRefineInProgress = false;
	private readonly _autoRefineOperations = new Set<Promise<void>>();
	private readonly _scheduledAutoRefineTimers = new Set<ReturnType<typeof setTimeout>>();
	private _stallWatchdog: StallWatchdog | undefined;
	private readonly _stallAbortSettleGraceMs: number | undefined;
	/** Injected watchdog timers; undefined means real timers (production). */
	private readonly _stallWatchdogTimers: StallWatchdogTimers | undefined;
	/** Aggregates the kernel/host facts the watchdog's vouch samples (T1-3). */
	private _turnLiveness: TurnLiveness | undefined;
	private readonly _stallKernelLivenessFacts: (() => TurnLivenessKernelFacts | undefined) | undefined;
	private readonly _stallJournaledBashHandles:
		| ((kernelPid: number | undefined) => JournaledBashFacts | undefined)
		| undefined;
	/** Kernel residency facts override for the eviction-facing activity term; defaults to the kernel client. */
	private readonly _kernelResidencyFacts: (() => KernelResidencyFacts | undefined) | undefined;
	/** Predicate names that already logged a failure this turn (one line per turn, not per sample). */
	private readonly _stallPredicateFailures = new Set<string>();
	/** Turn-liveness event kinds already logged this turn (the degraded path must stay countable). */
	private readonly _turnLivenessLogged = new Set<string>();
	/**
	 * Why the watchdog aborted the turn, for the ipython tool's aborted-cell report. Cleared by the
	 * next agent_start so a new turn never inherits an old cause. Distinct from `_lastStallAbort`,
	 * which is the roster/terminal-classifier record and deliberately outlives the turn.
	 */
	private _lastStallAbortCause: IpythonAbortCause | undefined;
	private readonly _rlmTerminalNoticeAbandonAfterMs: number;
	private readonly _failureWakeQuietWindowMs: number;
	private _stallLastEvent: { type: string; at: number } | undefined;
	private readonly _stallInFlightTools = new Map<string, { toolName: string; startedAt: number }>();
	private _compactAutoRefinePending = false;
	private _turnIntervalAutoRefinePending = false;
	private _postCompactionContinuationScheduled = false;
	private _postCompactionContinuationSettlement: PostCompactionContinuationSettlement | undefined;
	private _postCompactionContinuationMessages: AgentMessage[] = [];
	private _scheduledPostCompactionContinuationMessages: AgentMessage[] = [];
	private _queuedAutonomousThresholdContinuations = new WeakMap<AssistantMessage, AgentMessage>();
	private _queuedAutonomousContinuationSnapshots = new WeakMap<AgentMessage, AutonomousRuntimeSnapshot>();
	private _pendingThresholdCompactionAutonomousMessages: AgentMessage[] = [];
	private _queuedGoalThresholdContinuation: AgentMessage | undefined;
	private _pendingAutoRefineReview: { reason: AutoRefineReason; review: AutoRefineReview } | undefined;
	private _autoRefineBranchVersion = 0;
	private _autoRefineReviewAbort?: AbortController;
	private _autoRefineWritableProbe?: { at: number; allowed: boolean };
	private _refineAbortController?: AbortController;
	private readonly _autoRefineReviewer?: AutoRefineReviewer;
	private readonly _serializedRefine: boolean;
	private _refineInFlight?: Promise<void>;
	private _refinePlanInFlight?: Promise<void>;
	private _serializedPlanInFlight?: Promise<SerializedBackgroundPlanResult | undefined>;
	private _serializedPlanClaim?: Promise<void>;
	private _serializedExplicitRefineOptions?: {
		instructions?: string;
		global?: boolean;
	};

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		// Failed transcript writes are visible on every channel (interactive, ACP,
		// daemon attach); a successful write resets the report backoff. This single
		// hook covers every append path (messages, goal, model, thinking, service
		// tier, compaction, bash, name, labels, child usage, refinement).
		this.sessionManager.onPersistFailure((error) => this._reportSessionPersistFailure(error));
		this.sessionManager.onPersist(() => this._resetSessionPersistFailureBackoff());
		this.settingsManager = config.settingsManager;
		this._serviceTierPreference = config.serviceTierPreference ?? config.agent.state.serviceTier;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = config.agentDir;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._includeGoals = config.includeGoals ?? true;
		this._includeCompactSkill = config.includeCompactSkill ?? this.settingsManager.getCompactionAgentCallable();
		this._rlmHeartbeatController = config.rlmHeartbeatController;
		this._agentMessageController = config.agentMessageController;
		this._agentObserveController = config.agentObserveController;
		this._mcpManager = config.mcpManager;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		const headerRlmDepth = this.sessionManager.getHeader()?.rlmDepth;
		this._rlmDepth =
			config.rlmDepth ??
			(isNonNegativeInteger(headerRlmDepth) ? headerRlmDepth : parseDepth(process.env.RLM_DEPTH, 0, "RLM_DEPTH"));
		this._configuredRlmMaxDepth = config.rlmMaxDepth;
		if (this._configuredRlmMaxDepth !== undefined && !isNonNegativeInteger(this._configuredRlmMaxDepth)) {
			throw new Error("rlmMaxDepth must be a non-negative integer");
		}
		const resolvedRlmMaxDepth = this._resolveRlmMaxDepth();
		this._rlmMaxDepth = resolvedRlmMaxDepth.maxDepth;
		this._rlmMaxDepthSource = resolvedRlmMaxDepth.source;
		this._rlmMaxConcurrentChildren = resolveRlmMaxConcurrentChildren(config.rlmMaxChildren);
		this._prewarmIpythonKernel = (config.prewarmIpythonKernel ?? false) && this._rlmDepth === 0;
		this._autoRefineReviewer = config.autoRefineReviewer;
		this._serializedRefine = config.serializedRefine ?? false;
		this._stallAbortSettleGraceMs = config.stallAbortSettleGraceMs;
		this._stallWatchdogTimers = config.stallWatchdogTimers;
		this._stallKernelLivenessFacts = config.stallKernelLivenessFacts;
		this._stallJournaledBashHandles = config.stallJournaledBashHandles;
		this._kernelResidencyFacts = config.kernelResidencyFacts;
		this._rlmTerminalNoticeAbandonAfterMs =
			config.rlmTerminalNoticeAbandonAfterMs ?? RLM_TERMINAL_NOTICE_ABANDON_AFTER_MS;
		this._failureWakeQuietWindowMs = config.failureWakeQuietWindowMs ?? FAILURE_WAKE_QUIET_WINDOW_MS;
		this._rlmSessionDir = config.rlmSessionDir;
		this._rlmParentNodeId = config.rlmParentNodeId;
		this._rlmParentAgent = config.rlmParentAgent;
		this._semanticEdges = new SemanticEdgeRecorder({
			// A non-persisted session (an in-memory root and its RLM descendants) must leave
			// nothing on disk, so the ledger is only wired up when persistence is allowed.
			ledgerPath: this.sessionManager.allowsPersistence()
				? semanticEdgeLedgerPath({
						rlmSessionDir: this._rlmSessionDir,
						sessionArtifactDir: this.sessionManager.getSessionArtifactDir(),
					})
				: undefined,
			sessionId: this.sessionManager.getSessionId(),
			parentSessionId: config.semanticParentSessionId,
			spawnedByRequestId: config.semanticSpawnedByRequestId,
		});
		this.agent.streamFn = wrapStreamFnWithSemanticEdges(this.agent.streamFn, this._semanticEdges);
		// A resumed child may have replied before this process started; false would
		// claim knowledge that is not present in the session transcript.
		this._repliedToParentSinceTask =
			this._rlmDepth > 0 && this.sessionManager.getBranch().some((entry) => entry.type === "message")
				? undefined
				: false;
		this._subagentRuntimeHost = config.subagentRuntimeHost;
		this._autonomousState = createAutonomousRuntimeState(config.autonomous, {
			cwd: this._cwd,
			defaultLimits: this.settingsManager.getAutonomousLimits(),
		});
		this._goalState = this._loadPersistedGoalState();
		// Seed initial goal from CLI --goal flag, but only for top-level sessions
		// and only when the branch contains only bootstrap entry types (model_change,
		// thinking_level_change, service_tier_change) and no persisted
		// thread_goal_state. This prevents reseeding after clear/complete/error
		// or restart/rehydration of a session that already has messages or a goal.
		if (this._rlmDepth === 0 && config.initialGoal && this._isBranchSeedable()) {
			this._goalState = this._startGoal(config.initialGoal.objective, config.initialGoal.tokenBudget);
			// Goal context is the model's only source of goal visibility; action
			// admission is unavailable mid-construction, so ride the next turn.
			this._pendingNextTurnMessages.push(createGoalContextMessage(this._goalState, "continuation"));
		}
		this._restoreLateIpythonSentAgentMessages();
		if (this._rlmDepth > 0 && !this._includeGoals && this._goalState.status === "active") {
			// G2 (r37 hbgoal-ts): goals are disabled for subagent sessions, so a goal
			// persisted by an older build has no continuation path after passivation;
			// terminate it with a visible reason instead of letting it dangle active.
			this._finishGoalWithError(
				"Goals are disabled for this subagent session (goal persisted before it was disabled).",
			);
		}
		if (this._goalState.status === "active") {
			this._goalAccountingStartedAt = Date.now();
		}

		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentTurnHook();
		this._installAgentContinuationHook();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});

		this._turnLiveness = this._createTurnLiveness();
		this._stallWatchdog = this._createStallWatchdog();
		// A restart of the same session picks up whatever the previous process could
		// not deliver (B10: every in-memory queue answers "where is it after a
		// restart"). No-op when the session dir holds no sidecar.
		this._reflowUndeliveredRlmNotices();
		// After reflow on purpose: reflow pushes messages, and the empty-context test
		// below must see the session the way the rest of the constructor left it.
		this._ensureHarnessDigestContext();
	}

	/** Refreshes MCP provider registrations without rebuilding the session runtime. */
	refreshMcpProviders(): void {
		const removedServers = this._mcpManager?.refresh() ?? [];
		// When the agent is busy, /reload (which disposes the kernel and reaps every
		// MCP child) is deferred, so a removed or force-disabled user server's live
		// kernel transport would otherwise leak until kernel exit. Retire those
		// generations once the agent goes idle. Best-effort: a kernel failure here
		// must not break the credential refresh that triggered it.
		if (removedServers.length > 0 && (this.isStreaming || this.isCompacting)) {
			void this._closeKernelMcpTransports(removedServers, "MCP").catch(() => {});
		}
	}

	/**
	 * Set the RLM heartbeat controller after construction. Used by
	 * print/headless mode to attach an in-process heartbeat scheduler
	 * when the session is created outside the daemon.
	 */
	setRlmHeartbeatController(controller: AgentRlmHeartbeatController): void {
		if (this._rlmHeartbeatController === controller) {
			return;
		}
		this._rlmHeartbeatController = controller;
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			includeAllExtensionTools: true,
		});
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	replaceAcpMcpServers(servers: readonly AcpMcpServerConfig[], ownerId: string): void {
		if (this.isStreaming) throw new Error("Cannot replace ACP MCP servers while the agent is running");
		if (!this._mcpManager) {
			if (servers.length > 0) throw new Error("MCP is unavailable in this session");
			return;
		}
		if (servers.length > 0 && !this._ipythonKernelProvisioner) {
			throw new Error("ACP MCP servers require the built-in cpython tool");
		}
		this._assertAcpMcpToolNamesAvailable(acpMcpToolNames(servers));
		if (!this._mcpManager.replaceAcpServers(servers, ownerId)) return;
		this._rebuildRuntimeForAcpMcpServers();
	}

	async releaseAcpMcpServers(ownerId: string, serverNames: readonly string[]): Promise<void> {
		if (!this._mcpManager?.canReleaseAcpServers(ownerId)) return;
		if (this._mcpManager.replaceAcpServers([], ownerId)) {
			const removedToolNames = new Set(this._acpMcpTools.map((tool) => tool.name));
			const activeToolNames = this.getActiveToolNames().filter((name) => !removedToolNames.has(name));
			for (const name of removedToolNames) this._allowedToolNames?.delete(name);
			this._acpMcpTools = [];
			this._refreshToolRegistry({ activeToolNames, includeAllExtensionTools: true });
			this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
		const names = [...new Set(serverNames)];
		if (names.length === 0) return;
		await this._closeKernelMcpTransports(names, "ACP MCP");
	}

	/**
	 * Close kernel-owned MCP transports by name without rebuilding or killing the
	 * notebook. Waits for the current turn, then asks the kernel-side registry to
	 * drop only these cached generations (reaping any stdio child processes).
	 */
	private async _closeKernelMcpTransports(names: readonly string[], label: string): Promise<void> {
		const inputPause = this.acquireSessionInputPause();
		try {
			await this.agent.waitForIdle();
			await this._agentEventQueue;
			const manager = this._ipythonKernelProvisioner?.manager;
			if (!manager?.isRunning) return;
			const code = [
				"import importlib as _prime_importlib",
				'_prime_mcp = _prime_importlib.import_module("rlm.mcp")',
				`_prime_mcp_names = ${JSON.stringify(names)}`,
				"_prime_mcp_errors = []",
				"for _prime_mcp_name in _prime_mcp_names:",
				"    try:",
				"        await _prime_mcp.reload(_prime_mcp_name)",
				"    except BaseException as _prime_mcp_error:",
				"        _prime_mcp_errors.append(_prime_mcp_error)",
				"if _prime_mcp_errors:",
				"    raise _prime_mcp_errors[0]",
				"del _prime_mcp, _prime_importlib, _prime_mcp_names, _prime_mcp_errors, _prime_mcp_name",
			].join("\n");
			const result = await manager.execute(code);
			if (result.status !== "ok") {
				throw new Error(`Failed to close ${label} kernel transports: ${result.stderr || "kernel error"}`);
			}
		} finally {
			inputPause.release();
		}
	}

	private _assertAcpMcpToolNamesAvailable(names: readonly string[]): void {
		const occupiedNames = new Set([
			...this._baseToolDefinitions.keys(),
			...this._customTools.map((tool) => tool.name),
			...this._extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name),
		]);
		for (const name of names) {
			if (occupiedNames.has(name)) {
				throw new Error(`ACP MCP tool name conflicts with an existing tool: ${name}`);
			}
		}
	}

	private _rebuildRuntimeForAcpMcpServers(): void {
		const previousToolNames = new Set(this._acpMcpTools.map((tool) => tool.name));
		const nextToolNames = acpMcpToolNames(this._mcpManager?.getAcpServers() ?? []);
		this._assertAcpMcpToolNamesAvailable(nextToolNames);
		const activeToolNames = this.getActiveToolNames().filter((name) => !previousToolNames.has(name));
		activeToolNames.push(...nextToolNames);
		this._buildRuntime({
			activeToolNames,
			includeAllExtensionTools: true,
		});
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	setSubagentRuntimeHost(host?: SubagentRuntimeHost): void {
		this._subagentRuntimeHost = host;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
		requestModel: Model<Api>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers, requestModel: result.requestModel ?? model };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(formatAuthenticationFailedMessage(model.provider));
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			await this._agentEventQueue;

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	private _installAgentContinuationHook(): void {
		this.agent.getContinuationMessages = (context, signal) => this._getContinuationMessages(context, signal);
	}

	private _installAgentTurnHook(): void {
		this.agent.shouldStopBeforeTurn = () => this._shouldStopBeforeTurn();
		this.agent.shouldStopAfterTurn = (context) => this._shouldStopAfterTurn(context);
	}

	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			try {
				l(event);
			} catch {
				// A failing observer must not prevent other subscribers from
				// receiving lifecycle and persistence events.
			}
		}
	}

	private _lastSessionPersistFailureAt = 0;
	private _sessionPersistFailureBackoffMs = SESSION_PERSIST_FAILURE_REPORT_BASE_MS;

	/** A successful write ends the failure episode: the next failure reports at once. */
	private _resetSessionPersistFailureBackoff(): void {
		this._sessionPersistFailureBackoffMs = SESSION_PERSIST_FAILURE_REPORT_BASE_MS;
		this._lastSessionPersistFailureAt = 0;
	}

	/**
	 * Surface a failed transcript write. A broken disk fails every event, so
	 * reports back off exponentially (30s, 60s, … capped at 5min) regardless of
	 * the error text — distinct errors must not spam the UI either. Recovery is
	 * implicit: the next successful persist backfills via a full rewrite and
	 * resets the backoff.
	 */
	private _reportSessionPersistFailure(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const now = Date.now();
		if (now - this._lastSessionPersistFailureAt < this._sessionPersistFailureBackoffMs) {
			return;
		}
		this._lastSessionPersistFailureAt = now;
		this._sessionPersistFailureBackoffMs = Math.min(
			this._sessionPersistFailureBackoffMs * 2,
			SESSION_PERSIST_FAILURE_REPORT_MAX_MS,
		);
		this._emit({ type: "session_persist_failed", error: message });
	}

	private _emitQueueUpdate(): void {
		const actions = this.getSessionActionSnapshot();
		if (JSON.stringify(actions) === JSON.stringify(this._lastSessionActionSnapshot)) return;
		this._lastSessionActionSnapshot = actions;
		this._emit({ type: "session_action_update", actions });
	}

	private _restoreLateIpythonSentAgentMessages(): void {
		this._lateIpythonSentAgentMessages.clear();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY) {
				continue;
			}
			const persisted = parsePersistedIpythonSentAgentMessage(entry.data);
			if (persisted) {
				this._rememberLateIpythonSentAgentMessage(persisted.toolCallId, persisted.message);
			}
		}
	}

	private _rememberLateIpythonSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): boolean {
		const messages = this._lateIpythonSentAgentMessages.get(toolCallId) ?? [];
		const isNew = !messages.some((entry) => entry.id === message.id);
		if (isNew) {
			messages.push(message);
			this._lateIpythonSentAgentMessages.set(toolCallId, messages);
		}
		for (let index = this.agent.state.messages.length - 1; index >= 0; index -= 1) {
			if (appendSentAgentMessageToToolResult(this.agent.state.messages[index], toolCallId, message)) {
				break;
			}
		}
		return isNew;
	}

	private _applyLateIpythonSentAgentMessages(message: AgentMessage): void {
		if (message.role !== "toolResult" || message.toolName !== "ipython") {
			return;
		}
		for (const sentMessage of this._lateIpythonSentAgentMessages.get(message.toolCallId) ?? []) {
			appendSentAgentMessageToToolResult(message, message.toolCallId, sentMessage);
		}
	}

	private _recordLateIpythonSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): void {
		const record = () => {
			if (this._disposed || !this._rememberLateIpythonSentAgentMessage(toolCallId, message)) {
				return;
			}
			try {
				this.sessionManager.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, { toolCallId, message });
			} catch (error) {
				this._reportSessionPersistFailure(error);
			}
			this._emit({ type: "ipython_sent_agent_message", toolCallId, message });
		};
		this._agentEventQueue = this._agentEventQueue.then(record, record);
		this._agentEventQueue.catch(() => {});
	}

	private _emitGoalUpdate(): void {
		this._emit({ type: "goal_update", goal: this.goalState });
	}

	private _loadPersistedRlmMaxDepthState(): PersistedRlmMaxDepthState | undefined {
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry.type === "custom" &&
				entry.customType === RLM_MAX_DEPTH_STATE_CUSTOM_TYPE &&
				isPersistedRlmMaxDepthState(entry.data)
			) {
				return entry.data;
			}
		}
		return undefined;
	}

	private _resolveRlmMaxDepth(): {
		maxDepth: number;
		source: RlmMaxDepthSource;
	} {
		const persisted = this._loadPersistedRlmMaxDepthState();
		if (persisted) {
			return { maxDepth: persisted.maxDepth, source: "chat" };
		}
		if (this._configuredRlmMaxDepth !== undefined) {
			return { maxDepth: this._configuredRlmMaxDepth, source: "inherited" };
		}
		const global = this.settingsManager.getRlmMaxDepth();
		if (global !== undefined && isNonNegativeInteger(global)) {
			return { maxDepth: global, source: "global" };
		}
		const env = process.env.RLM_MAX_DEPTH;
		if (env !== undefined && env !== "") {
			return { maxDepth: parseDepth(env, 1, "RLM_MAX_DEPTH"), source: "env" };
		}
		return { maxDepth: 2, source: "default" };
	}

	private _loadPersistedGoalState(): GoalState {
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry.type === "custom" &&
				entry.customType === GOAL_STATE_CUSTOM_TYPE &&
				isPersistedGoalState(entry.data)
			) {
				return normalizeGoalState(entry.data);
			}
		}
		return emptyGoalState();
	}

	/**
	 * Whether the session branch is seedable for an initial goal. Returns true
	 * only when the branch contains exclusively bootstrap entry types
	 * (model_change, thinking_level_change, service_tier_change) and no
	 * thread_goal_state custom entry. Any message, custom entry, or persisted
	 * goal (including cleared/complete/error) means the session has been used
	 * and should not be reseeded.
	 */
	private _isBranchSeedable(): boolean {
		const branch = this.sessionManager.getBranch();
		for (const entry of branch) {
			switch (entry.type) {
				case "model_change":
				case "thinking_level_change":
				case "service_tier_change":
					continue;
				case "custom":
					if (entry.customType === GOAL_STATE_CUSTOM_TYPE) {
						return false;
					}
					return false;
				default:
					return false;
			}
		}
		return true;
	}

	/**
	 * The cap this session may actually spawn under: its own resolved depth, tightened by any
	 * ceiling an ancestor pushed after admission (SC-2).
	 */
	private _effectiveRlmMaxDepth(): number {
		return this._rlmMaxDepthCeiling === undefined
			? this._rlmMaxDepth
			: Math.min(this._rlmMaxDepth, this._rlmMaxDepthCeiling);
	}

	/**
	 * Apply an ancestor's live cap. Deliberately tracked rather than ratcheted: a widening push
	 * must lift the ceiling again, or a subtree would stay confined by a limit nobody can see.
	 * Nothing is rebuilt when the effective cap is unchanged, so idempotent pushes stay cheap.
	 */
	private _applyRlmMaxDepthCeiling(maxDepth: number): void {
		const previousEffective = this._effectiveRlmMaxDepth();
		this._rlmMaxDepthCeiling = maxDepth;
		if (this._effectiveRlmMaxDepth() === previousEffective) return;
		const oldBase = this._baseSystemPrompt;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._refreshExtensionSystemPrompt(this.agent.state.systemPrompt, oldBase);
		this._pushRlmMaxDepthToChildren();
	}

	/** Admitted children that have not settled yet - the population SC-1 bounds. */
	private _liveRlmChildRunCount(): number {
		const live = new Set<RlmChildRun>();
		for (const run of this._unsettledRlmChildRuns) {
			if (!run.settled) live.add(run);
		}
		for (const run of this._activeRlmChildRuns.values()) {
			if (!run.settled) live.add(run);
		}
		return live.size;
	}

	/** Child sessions of this session that can still receive a push (retained or in flight). */
	private _rlmChildSessionsForCapPush(): AgentSession[] {
		const sessions: AgentSession[] = [];
		const seen = new Set<AgentSession>();
		const add = (session: AgentSession | undefined) => {
			if (!session || seen.has(session)) return;
			seen.add(session);
			sessions.push(session);
		};
		for (const retained of this._rlmChildSessions.values()) add(retained.session);
		for (const run of this._activeRlmChildRuns.values()) {
			add(run.session ?? this._rlmChildSessions.get(run.id)?.session);
		}
		return sessions;
	}

	/**
	 * Push this session's effective cap onto every child it still holds; each child forwards
	 * its own effective cap onward, so one reduction on an ancestor reaches the whole subtree
	 * it already dispatched (SC-2). A run admitted but not yet published is covered by the
	 * grant comparison at publication instead.
	 */
	private _pushRlmMaxDepthToChildren(): void {
		const cap = this._effectiveRlmMaxDepth();
		for (const child of this._rlmChildSessionsForCapPush()) {
			if (!(child instanceof AgentSession)) continue;
			child._applyRlmMaxDepthCeiling(cap);
		}
	}

	private _reloadGoalStateFromBranch(options: { monotonicTokens?: boolean } = {}): void {
		const previous = this._goalState;
		const reloaded = this._loadPersistedGoalState();
		if (options.monotonicTokens && reloaded.goalId !== undefined && reloaded.goalId === previous.goalId) {
			// A context rebuild continues the same timeline, but the rebuilt branch's
			// last persisted goal entry can lag the in-memory state (queue/flush
			// races; child-usage attribution landing late). Neither the accounting
			// counters nor an already-fired gate (budget limit, pause, completion)
			// for the same logical goal may regress across the cold boundary. Tree
			// navigation keeps faithful branch semantics by calling without the flag.
			this._goalState = {
				...previous,
				tokensUsed: Math.max(previous.tokensUsed, reloaded.tokensUsed),
				continuationsUsed: Math.max(previous.continuationsUsed, reloaded.continuationsUsed),
				timeUsedSeconds: Math.max(previous.timeUsedSeconds, reloaded.timeUsedSeconds),
			};
		} else {
			this._goalState = reloaded;
		}
		this._goalAccountingStartedAt = this._goalState.status === "active" ? Date.now() : undefined;
		this._emitGoalUpdate();
	}

	private _reloadRlmMaxDepthFromBranch(): void {
		const previousMaxDepth = this._rlmMaxDepth;
		const resolved = this._resolveRlmMaxDepth();
		this._rlmMaxDepth = resolved.maxDepth;
		this._rlmMaxDepthSource = resolved.source;
		if (resolved.maxDepth !== previousMaxDepth) {
			this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
		// The reloaded cap is this session's current policy; children still in flight must spawn
		// under it (SC-2).
		this._pushRlmMaxDepthToChildren();
	}

	private _persistGoalState(goal: GoalState): void {
		this.sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, goal);
		// Force flush so the goal state is durable on disk immediately,
		// even before the first assistant response. This ensures idempotent
		// restart/rehydration can detect the persisted goal.
		this.sessionManager.flushNow();
	}

	private _setGoalState(next: GoalState, options: { persist?: boolean } = {}): void {
		const normalized = normalizeGoalState({
			...next,
			updatedAt: Date.now(),
		});
		this._goalState = normalized;
		if (normalized.status === "active") {
			this._goalAccountingStartedAt ??= Date.now();
		} else {
			this._goalAccountingStartedAt = undefined;
		}
		if (options.persist !== false) {
			this._persistGoalState(normalized);
		}
		this._emitGoalUpdate();
	}

	private _goalWithCurrentWallClock(now = Date.now()): GoalState {
		if (this._goalState.status !== "active" || !this._goalAccountingStartedAt) {
			return this._goalState;
		}
		const elapsedSeconds = Math.floor((now - this._goalAccountingStartedAt) / 1000);
		if (elapsedSeconds <= 0) {
			return this._goalState;
		}
		return {
			...this._goalState,
			timeUsedSeconds: this._goalState.timeUsedSeconds + elapsedSeconds,
		};
	}

	private _goalWithAccountedWallClock(): GoalState {
		const now = Date.now();
		const goal = this._goalWithCurrentWallClock(now);
		if (goal !== this._goalState) {
			this._goalAccountingStartedAt = now;
		}
		return goal;
	}

	private _cancelSessionActions(
		predicate: (action: QueuedSessionAction) => boolean,
		error: Error,
		candidates = this._actionStore.clearableActions(),
	): QueuedSessionAction[] {
		const matching = candidates.filter(predicate);
		const previousStates = new Map(matching.map((action) => [action.id, action.lifecycle.state]));
		const preparing = this._actionStore
			.activeActions()
			.filter(
				(action): action is SessionAction<PreparedTurnPayload> =>
					action.payload.kind === "turn" && action.lifecycle.state === "preparing",
			);
		const previousAnchor = preparing.at(-1);
		const actions = this._actionStore.remove(predicate, candidates);
		const restorableMessages: CustomMessage[] = [];
		const removed = new Set(actions);
		if (previousAnchor && removed.has(previousAnchor)) {
			for (const action of preparing) {
				if (!removed.has(action)) action.payload.prepared = undefined;
			}
		}
		for (const action of actions) {
			const ticket = this._actionStore.ticketFor(action);
			if (
				action.payload.kind === "turn" &&
				(action.payload.acceptedAgentMessage ||
					!action.payload.queueVisible ||
					previousStates.get(action.id) !== "queued")
			) {
				ticket.rejectDelivered(error);
			} else {
				ticket.settleDelivered({ status: "not_applicable" });
			}
			ticket.settleCompleted(error);
			const dispatched = previousStates.get(action.id) === "committing" && action.payload.kind === "turn";
			if (action.payload.kind === "turn") {
				const payload = action.payload;
				const restorable = payload.records
					.filter(
						(record): record is DeliveryRecord & { message: CustomMessage } =>
							(record.role === "next_turn" || (payload.acceptedAgentMessage && record.role === "prefix")) &&
							record.message.role === "custom" &&
							record.message.customType !== HARNESS_DIGEST_CUSTOM_TYPE &&
							!record.durable,
					)
					.map((record) => cloneCustomMessage(record.message));
				restorableMessages.push(...restorable);
				// Lazy injection owns digest delivery: a cancelled turn re-arms it rather
				// than restoring a message whose digest may already be stale.
				// Defense in depth, and honestly labeled as such: no reachable public
				// entry currently hits this strip branch, because the code between the
				// delivery records and `agent.prompt` has no await point, so a mid-flight
				// abort cannot find the action in the committing state (measured with a
				// gated provider: identical readings with and without a mutation that
				// deletes this re-arm). The park path below is the reachable half and is
				// pinned; if a reachable cancel entry ever appears (likely on the daemon
				// recovery / snapshot face), pin this branch in the same commit.
				if (
					payload.records.some(
						(record) =>
							record.message.role === "custom" && record.message.customType === HARNESS_DIGEST_CUSTOM_TYPE,
					)
				) {
					this._harnessDigestPending = true;
					this._invalidateHarnessDigestBaselines();
				}
				if (dispatched) {
					payload.captureRunMessages = new Set(payload.records.map((record) => record.message));
					const retained: AgentMessage[] = [];
					let strippedHarnessDigest = false;
					for (const message of this.agent.state.messages) {
						if (payload.captureRunMessages?.has(message)) {
							if (message.role === "custom" && message.customType === HARNESS_DIGEST_CUSTOM_TYPE) {
								strippedHarnessDigest = true;
							}
							continue;
						}
						retained.push(message);
					}
					this.agent.state.messages = retained;
					// A digest that left the context with the turn also invalidates the
					// baseline that says "this store state is already delivered": without
					// this the moved stamp would be consumed and the delta lost for good.
					if (strippedHarnessDigest) this._invalidateHarnessDigestBaselines();
				}
			}
			if (!dispatched) {
				this._actionStore.releaseTerminal(action);
			}
		}
		this._unshiftPendingNextTurnMessages(...restorableMessages);
		if (actions.length > 0) this._notifySessionInputCheckpointChange();
		return actions;
	}

	private _clearQueuedGoalContexts(): void {
		this._goalContinuationAwaitsRlmWork = false;
		this._pendingNextTurnMessages = this._pendingNextTurnMessages.filter(
			(message) => message.customType !== GOAL_CONTEXT_CUSTOM_TYPE,
		);
		this.agent.removeQueuedMessages(
			(message) => message.role === "custom" && message.customType === GOAL_CONTEXT_CUSTOM_TYPE,
		);
		this._cancelSessionActions(
			(action) =>
				action.payload.kind === "turn" && action.payload.customMessage?.customType === GOAL_CONTEXT_CUSTOM_TYPE,
			new Error("Queued goal context was cleared before delivery."),
		);
		this._emitQueueUpdate();
	}

	private _startGoal(objectiveText: string, tokenBudget: number | undefined): GoalState {
		const objective = validateGoalObjective(objectiveText);
		const budget = validateGoalBudget(tokenBudget);
		const now = Date.now();
		const goal: GoalState = {
			active: true,
			status: "active",
			goalId: randomUUID(),
			objective,
			tokenBudget: budget,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			createdAt: now,
			updatedAt: now,
		};
		this._goalAccountingStartedAt = now;
		this._goalContinuationAwaitsRlmWork = false;
		this._setGoalState(goal);
		return this._goalState;
	}

	private _clearGoal(): void {
		this._clearQueuedGoalContexts();
		this._setGoalState(emptyGoalState());
	}

	private _pauseGoal(reason = "Paused by user"): void {
		this._clearQueuedGoalContexts();
		if (this._goalState.status !== "active") {
			this._emitGoalUpdate();
			return;
		}
		const goal = this._goalWithAccountedWallClock();
		this._setGoalState({
			...goal,
			active: false,
			status: "paused",
			lastReason: reason,
			lastError: undefined,
		});
	}

	private async _resumeGoal(): Promise<void> {
		if (!this._goalState.objective) {
			this._emitGoalUpdate();
			return;
		}
		if (this._goalState.status !== "paused" && this._goalState.status !== "budget_limited") {
			this._emitGoalUpdate();
			return;
		}
		const exhausted =
			this._goalState.tokenBudget !== undefined && this._goalState.tokensUsed >= this._goalState.tokenBudget;
		const nextStatus: GoalStatus = exhausted ? "budget_limited" : "active";
		this._setGoalState({
			...this._goalState,
			active: nextStatus === "active",
			status: nextStatus,
			lastReason: exhausted ? "Goal token budget already reached" : undefined,
			lastError: undefined,
		});
		if (nextStatus === "active") {
			await this._runOrQueueGoalContext("continuation");
		}
	}

	private _finishGoalWithError(errorMessage: string): void {
		if (!this._goalState.objective || this._goalState.status !== "active") {
			return;
		}
		const goal = this._goalWithAccountedWallClock();
		this._setGoalState({
			...goal,
			active: false,
			status: "error",
			lastReason: errorMessage,
			lastError: errorMessage,
		});
	}

	private _finishGoalForTerminalAssistantMessage(message: AssistantMessage): void {
		if (this._goalState.status !== "active") {
			return;
		}

		if (message.stopReason === "aborted") {
			this._goalAbortInProgress = false;
			return;
		}

		if (message.stopReason === "error") {
			if (this._goalAbortInProgress) {
				this._goalAbortInProgress = false;
				return;
			}
			this._finishGoalWithError(message.errorMessage || "Assistant response failed");
		}
	}

	private _stopGoalContinuationForTerminalMessage(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" && message.stopReason !== "aborted") {
			return false;
		}
		try {
			this._finishGoalForTerminalAssistantMessage(message);
		} catch {
			// Goal hooks must not reject; listener failures should not crash the agent loop.
		}
		return true;
	}

	private _parseGoalSlashCommand(text: string): GoalSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "goal") return undefined;

		const rest = command.args;
		const normalized = rest.toLowerCase();
		if (!rest || normalized === "status") {
			return { kind: "status" };
		}
		if (normalized === "clear" || normalized === "stop") {
			return { kind: "clear" };
		}
		if (normalized === "pause") {
			return { kind: "pause" };
		}
		if (normalized === "resume") {
			return { kind: "resume" };
		}

		let tokenBudget: number | undefined;
		let objective = rest;
		const firstToken = rest.split(/\s+/, 1)[0] ?? "";
		if (
			firstToken === "--budget" ||
			firstToken === "--token-budget" ||
			firstToken.startsWith("--budget=") ||
			firstToken.startsWith("--token-budget=")
		) {
			let valueText: string;
			if (firstToken === "--budget" || firstToken === "--token-budget") {
				const withoutFlag = rest.slice(firstToken.length).trimStart();
				const nextSpace = withoutFlag.search(/\s/);
				if (nextSpace < 0) {
					throw new Error("Usage: /goal [--budget <tokens>] <objective>");
				}
				valueText = withoutFlag.slice(0, nextSpace);
				objective = withoutFlag.slice(nextSpace + 1).trim();
			} else {
				const separator = firstToken.indexOf("=");
				valueText = firstToken.slice(separator + 1);
				objective = rest.slice(firstToken.length).trim();
			}
			tokenBudget = parseGoalBudgetValue(valueText);
		}

		return {
			kind: "start",
			objective: validateGoalObjective(objective),
			tokenBudget,
		};
	}

	private _parseAutonomousSlashCommand(text: string): AutonomousSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "autonomous") return undefined;
		const tokens = parseCommandArgs(command.args);
		if (tokens.length === 0 || tokens[0]!.toLowerCase() === "status") {
			if (tokens.length > 1) {
				throw new Error(`Unexpected autonomous argument: ${tokens[1]}. ${AUTONOMOUS_BUDGET_USAGE}`);
			}
			return { kind: "status" };
		}
		const subcommand = tokens[0]!.toLowerCase();
		if (subcommand === "on" || subcommand === "enable" || subcommand === "enabled") {
			return { kind: "on", config: parseAutonomousBudgetOptions(tokens.slice(1)) };
		}
		if (subcommand === "off" || subcommand === "disable" || subcommand === "disabled") {
			if (tokens.length > 1) {
				throw new Error(`Unexpected autonomous argument: ${tokens[1]}. ${AUTONOMOUS_BUDGET_USAGE}`);
			}
			return { kind: "off" };
		}
		throw new Error(AUTONOMOUS_BUDGET_USAGE);
	}

	private _formatAutonomousStatus(): string {
		const status = this.getAutonomousStatus();
		const state = status.enabled ? "on" : "off";
		const elapsedSeconds = status.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : 0;
		const gateSummary =
			status.gates.commands.length > 0 ? status.gates.commands.map((command) => `"${command}"`).join(", ") : "none";
		const formatCount = (value: number): string =>
			isUnlimitedAutonomousLimit(value) ? "unlimited" : AUTONOMOUS_STATUS_NUMBER_FORMAT.format(value);
		const timeBudget = isUnlimitedAutonomousLimit(status.limits.timeoutMs)
			? "unlimited"
			: `${AUTONOMOUS_STATUS_NUMBER_FORMAT.format(Math.round(status.limits.timeoutMs / 1000))}s`;
		const subagentKeepAliveMs = status.subagentKeepAliveMs ?? 0;
		const keepAlive =
			subagentKeepAliveMs > 0
				? subagentKeepAliveMs >= 60_000
					? `${AUTONOMOUS_STATUS_NUMBER_FORMAT.format(Math.round(subagentKeepAliveMs / 60_000))}m`
					: `${AUTONOMOUS_STATUS_NUMBER_FORMAT.format(subagentKeepAliveMs)}ms`
				: "off";
		return `[autonomous-status: ${state}]\n\nContinuations: ${formatCount(status.continuationsUsed)}/${formatCount(status.limits.maxContinuations)}. Turns: ${formatCount(status.turnsUsed)}/${formatCount(status.limits.maxTurns)}. Tokens: ${formatCount(status.tokensUsed)}/${formatCount(status.limits.maxTokens)}. Time: ${elapsedSeconds}s/${timeBudget}. Gates: ${gateSummary}. Subagent keep-alive: ${keepAlive}.`;
	}

	private _emitAutonomousStatus(): void {
		const message = {
			role: "custom" as const,
			customType: "autonomous_status",
			content: this._formatAutonomousStatus(),
			display: true,
			details: this.getAutonomousStatus(),
			timestamp: Date.now(),
		} satisfies CustomMessage<AgentAutonomousStatus>;
		this.agent.state.messages.push(message);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private async _handleAutonomousSlashCommand(text: string): Promise<boolean> {
		const command = this._parseAutonomousSlashCommand(text);
		if (!command) {
			return false;
		}
		if (command.kind === "on") {
			setAutonomousEnabled(this._autonomousState, true, { cwd: this._cwd });
			setAutonomousLimits(this._autonomousState, command.config);
			// Re-sync the keep-alive with the new window: a 0 setting must
			// disarm an already-armed timer, and a shortened window must not
			// keep the old one pending.
			this._disarmAutonomousSubagentKeepAlive();
			if (this._autonomousContinuationAwaitsRlmWork) {
				this._armAutonomousSubagentKeepAlive();
			}
		} else if (command.kind === "off") {
			setAutonomousEnabled(this._autonomousState, false);
			this._clearQueuedAutonomousContinuations();
			this._clearAutonomousContinuationAwait();
		}
		this._emitAutonomousStatus();
		return true;
	}

	private _appendBeforeAgentStartMessages(
		messages: AgentMessage[],
		result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>,
	): void {
		if (!result?.messages) return;
		for (const message of result.messages) {
			messages.push({
				role: "custom",
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				timestamp: Date.now(),
			});
		}
	}

	private async _validateCanStartAgentRun(): Promise<void> {
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}
		if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
			const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
			if (isOAuth) {
				throw new Error(formatAuthenticationFailedMessage(this.model.provider));
			}
			// A stale mark means the credential exists but was 401/401-rejected and
			// disabled: say that instead of "No API key found", which sends the user
			// hunting for a key they never lost.
			if (this._modelRegistry.getProviderAuthStatus(this.model.provider).source === "stale") {
				throw new Error(formatStaleAuthMessage(this.model.provider));
			}
			throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
		}
	}

	/**
	 * Goals are pursued through the kernel goal skill, so the only tool the
	 * model needs is ipython. Force-activate it (including into a live
	 * continuation context) so the model can always reach `goal.complete()`.
	 */
	private _ensureGoalRuntimeActive(context?: AgentContext): void {
		if (!this._includeGoals) {
			throw new Error("Goals are disabled. Enable goals before using /goal.");
		}
		const ipythonTool = this._toolRegistry.get("ipython");
		if (!ipythonTool) {
			throw new Error("Goals require the ipython tool, which is not available in this session.");
		}
		const activeToolNames = new Set(this.getActiveToolNames());
		if (!activeToolNames.has("ipython")) {
			activeToolNames.add("ipython");
			this.setActiveToolsByName([...activeToolNames]);
		}
		if (context) {
			const contextTools = [...(context.tools ?? [])];
			if (!contextTools.some((tool) => tool.name === "ipython")) {
				contextTools.push(ipythonTool);
				context.tools = contextTools;
			}
		}
	}

	private _maybeResumeGoalContinuationAfterRlmWork(): void {
		if (!this._goalContinuationAwaitsRlmWork) return;
		if (this._disposed || this._disposing || this._hasUnsettledRlmQuiescenceWork()) return;
		if (this._goalState.status !== "active" || !this._goalState.objective) {
			this._goalContinuationAwaitsRlmWork = false;
			return;
		}
		// K3R-11: a goal turn already queued (for example the threshold compaction
		// that a manual compact preempted preserved its continuation) is the owed
		// continuation; the re-arm must not queue a second one on top of it.
		if (
			this._actionStore
				?.unfinishedActions()
				.some(
					(action) =>
						action.payload.kind === "turn" &&
						action.payload.customMessage?.customType === GOAL_CONTEXT_CUSTOM_TYPE,
				)
		) {
			this._goalContinuationAwaitsRlmWork = false;
			return;
		}
		// Keep the deferral while admission is paused or the pump is suspended
		// (post-abort); the pause release and resumeQueuedWork retry.
		if (this._sessionInputAdmissionPauses.size > 0 || this._sessionInputPumpSuspended) return;
		if (this._goalContinuationBudgetExhausted()) {
			this._goalContinuationAwaitsRlmWork = false;
			return;
		}
		const goalBeforeResume = this._goalState;
		try {
			this._ensureGoalRuntimeActive();
			this._setGoalState({
				...this._goalState,
				continuationsUsed: this._goalState.continuationsUsed + 1,
				lastReason: undefined,
				lastError: undefined,
			});
			const message = createGoalContextMessage(this._goalState, "continuation");
			const normalized = normalizeMessageContent(message.content);
			// No front: a settling child's terminal notice must be read first.
			this._admitSessionInput(
				this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				}),
			);
			this._goalContinuationAwaitsRlmWork = false;
		} catch {
			// Admission can race a new pause; roll back so the retry re-counts.
			this._setGoalState(goalBeforeResume);
		}
	}

	/**
	 * Hold the timer-driven autonomous continuation while descendant work is
	 * unsettled, mirroring the goal gate: delegating and ending the turn is
	 * correct behavior, and child replies and exit notices are the real
	 * wake-up signals. The owed continuation is delivered when descendants
	 * settle without consuming the continuation budget while it waits. An
	 * active goal holds its own continuation, so the held continuation is
	 * not double-queued behind it.
	 */
	private _holdAutonomousContinuationForRlmWork(message: AssistantMessage): boolean {
		if (!this._autonomousState.enabled) {
			return false;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return false;
		}
		if (autonomousLimitReason(this._autonomousState)) {
			// The run is over: hold nothing so the hook can apply the limit.
			return false;
		}
		if (!this._hasUnsettledRlmQuiescenceWork()) {
			return false;
		}
		// An active goal's own continuation gate owns the wake-up discipline;
		// drop any owed continuation so both are never queued.
		if (this._goalOwnsContinuationWakeup()) {
			this._clearAutonomousContinuationAwait();
			return true;
		}
		this._autonomousContinuationAwaitsRlmWork = true;
		this._armAutonomousSubagentKeepAlive();
		return true;
	}

	/** True while an active goal's continuation loop owns the session wake-ups. */
	private _goalOwnsContinuationWakeup(): boolean {
		return this._goalState.status === "active" && !!this._goalState.objective;
	}

	/** Deliver the owed continuation once descendant work settles. */
	private _maybeResumeAutonomousContinuationAfterRlmWork(): void {
		if (!this._autonomousContinuationAwaitsRlmWork) return;
		if (this._disposed || this._disposing || this._hasUnsettledRlmQuiescenceWork()) return;
		if (!this._autonomousState.enabled || this._goalOwnsContinuationWakeup()) {
			this._clearAutonomousContinuationAwait();
			return;
		}
		// Keep the deferral while admission is paused or the pump is suspended
		// (post-abort); the pause release and resumeQueuedWork retry.
		if (this._sessionInputAdmissionPauses.size > 0 || this._sessionInputPumpSuspended) return;
		if (this._autonomousContinuationResumeTask) return;
		this._autonomousContinuationResumeTask = this._resumeOwedAutonomousContinuation().finally(() => {
			this._autonomousContinuationResumeTask = undefined;
		});
	}

	/**
	 * Deliver the owed continuation, evaluating configured quality gates first
	 * so a settlement never spends a turn when the gates already pass. Counted
	 * at delivery like a goal continuation; a failed admission rolls the count
	 * back and keeps the deferral for the pause-release retry.
	 */
	private async _resumeOwedAutonomousContinuation(): Promise<void> {
		const snapshot = this._snapshotAutonomousRuntimeState();
		const beforeGates = {
			arrivalEpoch: this._sessionInputArrivalEpoch,
			noticeAdmissions: this._rlmTerminalNoticeAdmissionCount,
		};
		try {
			// agent_end clears the live field, so fall back to the transcript;
			// either way the session's last assistant turn decides the gate run.
			const lastAssistantMessage =
				this._lastAssistantMessage ?? this._findLastAssistantInMessages(this.agent.state.messages);
			if (!lastAssistantMessage) {
				if (autonomousLimitReason(this._autonomousState)) {
					// The run is over; no continuation is owed anymore.
					this._clearAutonomousContinuationAwait();
					return;
				}
				addAutonomousContinuation(this._autonomousState);
				this._admitOwedAutonomousContinuation(createAutonomousContinuationMessage(this._autonomousState));
				return;
			}
			// Configured quality gates decide whether the run is already done.
			// The decision runs before any accounting is written so a stale
			// drop never spends a continuation or clobbers a user reset.
			const decision = await shouldAutonomouslyContinue(this._autonomousState, lastAssistantMessage, {
				cwd: this._cwd,
				signal: this.agent.signal,
			});
			if (!decision.shouldContinue) {
				this._clearAutonomousContinuationAwait();
				return;
			}
			// Re-validate after the gate await: mode-off, a goal takeover, or
			// any user-driven admission (finished or queued) must not be
			// bypassed by a stale continuation. Sibling terminal notices are
			// the exception: this owed continuation is exactly the wake that
			// reads them.
			const admissions = this._sessionInputArrivalEpoch - beforeGates.arrivalEpoch;
			const noticeAdmissions = this._rlmTerminalNoticeAdmissionCount - beforeGates.noticeAdmissions;
			const userDrivenAdmissions = admissions > noticeAdmissions;
			if (
				this._disposed ||
				this._disposing ||
				!this._autonomousState.enabled ||
				this._goalOwnsContinuationWakeup() ||
				userDrivenAdmissions
			) {
				this._clearAutonomousContinuationAwait();
				return;
			}
			addAutonomousContinuation(this._autonomousState);
			const message =
				(decision.reason === "gate_failed"
					? createAutonomousGateFailureContinuationMessage(this._autonomousState)
					: undefined) ?? createAutonomousContinuationMessage(this._autonomousState);
			this._admitOwedAutonomousContinuation(message);
		} catch {
			// Admission can race a new pause; roll back so the retry re-counts.
			this._restoreAutonomousRuntimeSnapshot(snapshot);
		}
	}

	/** Admit an already-built owed continuation behind pending notices. */
	private _admitOwedAutonomousContinuation(message: UserMessage): void {
		const normalized = normalizeMessageContent(message.content);
		// No front: a settling child's terminal notice must be read first.
		this._admitSessionInput(
			this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
				message,
				resumeIfIdle: true,
			}),
		);
		this._clearAutonomousContinuationAwait();
	}

	/**
	 * Deliver the keep-alive continuation while subagents are still active.
	 * Returns false when admission raced a pause so the window can re-arm.
	 */
	private _deliverAutonomousSubagentKeepAlive(): boolean {
		if (autonomousLimitReason(this._autonomousState)) {
			// The run is over; no keep-alive is owed anymore.
			this._clearAutonomousContinuationAwait();
			return true;
		}
		const snapshot = this._snapshotAutonomousRuntimeState();
		try {
			addAutonomousContinuation(this._autonomousState);
			this._admitOwedAutonomousContinuation(createAutonomousSubagentKeepAliveMessage(this._autonomousState));
			return true;
		} catch {
			// Admission can race a new pause; roll back so the retry re-counts.
			this._restoreAutonomousRuntimeSnapshot(snapshot);
			return false;
		}
	}

	/** One keep-alive continuation per window of continuous subagent activity. */
	private _armAutonomousSubagentKeepAlive(): void {
		if (this._autonomousSubagentKeepAliveTimer !== undefined) return;
		const keepAliveMs = this._autonomousState.subagentKeepAliveMs;
		if (!keepAliveMs || keepAliveMs <= 0) return;
		const timer = setTimeout(() => {
			this._autonomousSubagentKeepAliveTimer = undefined;
			this._fireAutonomousSubagentKeepAlive();
		}, keepAliveMs);
		// A pending keep-alive must not hold the event loop open on its own.
		timer.unref();
		this._autonomousSubagentKeepAliveTimer = timer;
	}

	private _disarmAutonomousSubagentKeepAlive(): void {
		if (this._autonomousSubagentKeepAliveTimer === undefined) return;
		clearTimeout(this._autonomousSubagentKeepAliveTimer);
		this._autonomousSubagentKeepAliveTimer = undefined;
	}

	private _clearAutonomousContinuationAwait(): void {
		this._autonomousContinuationAwaitsRlmWork = false;
		this._disarmAutonomousSubagentKeepAlive();
	}

	/**
	 * Safety valve for hung children: while subagents stay active past the
	 * keep-alive window, wake the parent so it can inspect and unblock them
	 * (a stopped SIGTTIN child never delivers its exit notice).
	 */
	private _fireAutonomousSubagentKeepAlive(): void {
		if (!this._autonomousContinuationAwaitsRlmWork) return;
		if (this._disposed || this._disposing) return;
		if (!this._hasUnsettledRlmQuiescenceWork()) {
			// Descendants settled while the keep-alive was pending; the normal
			// resume path owns delivery.
			this._maybeResumeAutonomousContinuationAfterRlmWork();
			return;
		}
		if (!this._autonomousState.enabled || this._goalOwnsContinuationWakeup()) {
			this._clearAutonomousContinuationAwait();
			return;
		}
		// Keep the deferral while admission is paused or the pump is suspended
		// (post-abort); the pause release and resumeQueuedWork retry.
		if (this._sessionInputAdmissionPauses.size > 0 || this._sessionInputPumpSuspended) {
			this._armAutonomousSubagentKeepAlive();
			return;
		}
		if (!this._deliverAutonomousSubagentKeepAlive()) {
			// Admission raced a pause; retry after another window.
			this._armAutonomousSubagentKeepAlive();
		}
	}

	/**
	 * Queued goal continuations snapshot goal accounting at queue time, but
	 * delivery can lag arbitrarily (a threshold compaction, admission pauses,
	 * other queued work) while usage keeps accruing. A continuation's whole
	 * purpose is "here is the current goal state — keep working", so stale
	 * numbers misreport the budget and can mislead the model into stopping
	 * early or ignoring limits. Refresh the frozen content in place at
	 * delivery, preserving the message identity every queue/dedup marker
	 * (post-compaction continuation tracking, threshold dedup) matches on.
	 * Budget-limit steers are excluded: they are created immediately after the
	 * accounting event they report, and `objective_updated` carries the
	 * objective snapshot that was the event.
	 */
	private _refreshGoalContextMessageAtDelivery(message: AgentMessage): void {
		if (message.role !== "custom" || message.customType !== GOAL_CONTEXT_CUSTOM_TYPE) return;
		const custom = message as CustomMessage<GoalContextDetails | undefined>;
		const details = custom.details;
		if (details?.kind !== "continuation" || details.goalId === undefined) return;
		if (
			this._goalState.status !== "active" ||
			this._goalState.goalId !== details.goalId ||
			!this._goalState.objective
		) {
			return;
		}
		const images = Array.isArray(custom.content)
			? custom.content.filter((block): block is ImageContent => block.type === "image")
			: undefined;
		const fresh = createGoalContextMessage(this._goalState, "continuation", images);
		custom.content = fresh.content;
		custom.details = fresh.details;
		custom.timestamp = fresh.timestamp;
	}

	private _runOrQueueGoalContext(kind: "continuation" | "objective_updated", images?: ImageContent[]): void {
		if (!this._goalState.objective) return;
		this._ensureGoalRuntimeActive();
		const message = createGoalContextMessage(this._goalState, kind, images);
		const normalized = normalizeMessageContent(message.content);
		const action = this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
			message,
			resumeIfIdle: true,
		});
		this._admitSessionInput(action, { front: true, wake: false });
	}

	private async _handleGoalSlashCommand(text: string, images: ImageContent[] | undefined): Promise<boolean> {
		const command = this._parseGoalSlashCommand(text);
		if (!command) {
			return false;
		}

		if (command.kind === "status") {
			this._emitGoalUpdate();
			return true;
		}

		if (command.kind === "clear") {
			this._clearGoal();
			return true;
		}

		if (command.kind === "pause") {
			this._pauseGoal();
			return true;
		}

		if (command.kind === "resume") {
			await this._resumeGoal();
			return true;
		}

		const previousWasActive = this._goalState.status === "active";
		if (!this.isStreaming) {
			await this._validateCanStartAgentRun();
		}
		this._ensureGoalRuntimeActive();
		this._clearQueuedGoalContexts();
		this._startGoal(command.objective, command.tokenBudget);
		await this._runOrQueueGoalContext(previousWasActive ? "objective_updated" : "continuation", images);
		return true;
	}

	private _accountGoalUsageForAssistantMessage(message: AssistantMessage): boolean {
		if (!this._goalState.objective) {
			return false;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return false;
		}
		if (this._goalAccountedAssistantMessages.has(message)) {
			return false;
		}
		// Usage is attributed at the assistant message's message_end, which fires
		// before that turn's ipython cell runs. goal.complete() only arrives later
		// over the kernel host bridge, so the completing turn is always accounted
		// while the goal is still active. Only count turns spent pursuing the goal;
		// post-completion turns (e.g. a closing summary) must not be attributed.
		if (this._goalState.status !== "active") {
			return false;
		}
		this._goalAccountedAssistantMessages.add(message);
		const tokenDelta = goalTokenDeltaForUsage(message.usage);
		const goal = this._goalWithAccountedWallClock();
		const nextGoal: GoalState = {
			...goal,
			tokensUsed: goal.tokensUsed + tokenDelta,
		};
		const budgetReached = nextGoal.tokenBudget !== undefined && nextGoal.tokensUsed >= nextGoal.tokenBudget;
		if (!budgetReached) {
			this._setGoalState(nextGoal);
			return false;
		}
		this._setGoalState({
			...nextGoal,
			active: false,
			status: "budget_limited",
			lastReason: `Reached ${nextGoal.tokenBudget} token goal budget`,
			lastError: undefined,
		});
		return true;
	}

	private get _steeringStopPending(): boolean {
		return (
			this._actionStore.queuedActions("next_turn_boundary").length > 0 ||
			this._actionStore
				.activeActions("next_turn_boundary")
				.some(
					(action) =>
						action.payload.kind === "turn" &&
						(action.lifecycle.state === "selected" || action.lifecycle.state === "preparing"),
				)
		);
	}

	private _shouldStopBeforeTurn(): boolean {
		return this._steeringStopPending;
	}

	private async _shouldStopAfterTurn(context: ShouldStopAfterTurnContext): Promise<boolean> {
		if (this._stopGoalContinuationForTerminalMessage(context.message)) {
			return true;
		}
		try {
			if (this._accountGoalUsageForAssistantMessage(context.message)) {
				const message = createGoalContextMessage(this._goalState, "budget_limit");
				const normalized = normalizeMessageContent(message.content);
				await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				});
			}
		} catch {
			// Goal accounting must not interrupt the core agent loop.
		}
		// Serialized refine checkpoint: in print/headless mode, run refinement
		// planning+apply synchronously here — the quiescent boundary between
		// turns — so it never overlaps the primary model request.
		// This MUST run BEFORE threshold compaction to prevent the
		// compaction model call from overlapping an in-flight refine
		// plan/apply that was started at message_end.
		if (this._serializedRefine) {
			// Ensure the preceding message_end processing (counter increment,
			// background plan kickoff) has completed before the checkpoint.
			await this._agentEventQueue;
			await this._runSerializedRefineCheckpoint();
		}
		if (await this._shouldStopForThresholdCompaction(context)) {
			return true;
		}
		// Steering stops continuation only after mandatory serialized checkpoints.
		// Returning true here still prevents the agent loop from starting another turn.
		return this._steeringStopPending;
	}

	private async _shouldStopForThresholdCompaction(context: ShouldStopAfterTurnContext): Promise<boolean> {
		this._continueAfterThresholdCompaction = false;
		if (this._pendingRequestedCompaction === undefined && !(await this._thresholdCompactionNeeded(context))) {
			return false;
		}

		const lastMessage = this.agent.state.messages[this.agent.state.messages.length - 1];
		// A queued continuation disproves the assistant-last "task finished" heuristic, so preserve a true set above.
		this._continueAfterThresholdCompaction ||= lastMessage !== undefined && lastMessage.role !== "assistant";
		return true;
	}

	/**
	 * Serialized-mode auto-refine checkpoint called from _shouldStopAfterTurn.
	 * Runs the review, planning, and application phases inline between turns
	 * at the quiescent shouldStopAfterTurn boundary. This path NEVER calls
	 * _maybeAutoRefine, _runApprovedRefine, public refine(), agent.abort(),
	 * or agent.waitForIdle — all of which would deadlock or defer because
	 * the agent loop still owns activeRun at this point. Instead it calls
	 * _reviewAutoRefine, _planRefine, and _applyRefine directly with proper
	 * in-flight guards and counter resets.
	 */
	private async _runSerializedRefineCheckpoint(): Promise<void> {
		if (this._disposed || this._disposing) {
			return;
		}

		// 1. Await any background plan that was started at message_end
		//    (either for a pending refine.run or for interval-triggered
		//    auto-refine). This must be checked BEFORE the pending and
		//    interval checks because background planning may have consumed
		//    the pending request at message_end.
		const branchVersion = this._autoRefineBranchVersion;
		const bgConsumption = await this._consumeSerializedBackgroundPlan(async (bgResult) => {
			if (this._disposed || this._disposing) {
				return true;
			}

			if (bgResult?.status === "plan") {
				if (bgResult.branchVersion !== this._autoRefineBranchVersion) {
					if (!this._pendingRequestedRefine) {
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
						return true;
					}
				} else {
					// Apply the EXACT background plan directly via _applyRefine
					// (no second _planRefine call).
					try {
						await this._applySerializedPlan(bgResult);
					} catch (error) {
						this._emitRefineFailed(error, bgResult.options.global ? "global" : "local");
					}
					this._lastAutoRefineReviewAt = Date.now();
					this._assistantTurnsSinceAutoRefine = 0;
					if (!this._pendingRequestedRefine) {
						return true;
					}
				}
			}

			if (bgResult?.status === "skip") {
				// Reviewer declined or an extension skipped during background planning.
				// Reset exactly once. Never retry the interval review; only fall through for a separate pending refine.run.
				if (bgResult.explicit) {
					this._emitRefineFailed(new RefineSkippedError("Refinement skipped by extension"));
				}
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				if (!this._pendingRequestedRefine) {
					return true;
				}
			}

			if (bgResult?.status === "failure") {
				// Background review or planning failure stamps cooldown without a synchronous retry.
				// A separately queued refine.run may still be serviced below.
				if (branchVersion === this._autoRefineBranchVersion) {
					this._lastAutoRefineReviewAt = Date.now();
				}
				// Re-queue an explicit refine.run whose background plan failed,
				// but only when branchVersion is still current and no newer
				// pending request has arrived since the background plan consumed
				// the original one. A newer request retains priority; interval
				// failures keep existing no-retry cooldown semantics.
				if (
					bgResult.explicit &&
					bgResult.branchVersion === this._autoRefineBranchVersion &&
					!this._pendingRequestedRefine
				) {
					this._pendingRequestedRefine = bgResult.options;
				}
				if (!this._pendingRequestedRefine) {
					return true;
				}
			}

			if (bgResult?.status === "invalidated" && !this._pendingRequestedRefine) {
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				return true;
			}

			await this._runSerializedRefineCheckpointAfterBackground(branchVersion);
			return true;
		});
		if (this._disposed || this._disposing || bgConsumption !== "none") {
			return;
		}
		await this._runSerializedRefineCheckpointAfterBackground(branchVersion);
	}

	private async _runSerializedRefineCheckpointAfterBackground(branchVersion: number): Promise<void> {
		// No background result, or a refine.run arrived while the background result was
		// in flight. Fall through so an explicit pending request is serviced at this boundary.

		// 2. Agent-callable refine.run requests that were NOT consumed by
		//    background planning (e.g. interval not reached at message_end,
		//    or cooldown was active). Service them synchronously.
		const pending = this._pendingRequestedRefine;
		if (pending) {
			this._pendingRequestedRefine = undefined;
			try {
				await this._runSerializedRefine(pending);
			} catch (error) {
				this._emitRefineFailed(error, pending.global ? "global" : "local");
			}
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
			return;
		}

		// 3. Post-compaction auto-refine. Serialized sessions defer the
		// compaction trigger to this boundary instead of entering the interactive
		// path, which waits for agent idle and can never run inside a tool loop.
		if (!this._autoRefineAllowedForSession()) {
			this._compactAutoRefinePending = false;
			return;
		}
		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			this._compactAutoRefinePending = false;
			return;
		}
		if (this._compactAutoRefinePending) {
			if (!settings.compact) {
				this._compactAutoRefinePending = false;
			} else {
				const nowMs = Date.now();
				const underCooldown =
					this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
				if (underCooldown) {
					// Preserve the compact trigger for a later boundary, matching the
					// interactive path's pending behavior while the cooldown is active.
					return;
				}
				this._compactAutoRefinePending = false;
				await this._runSerializedAutoRefineReview("compact", branchVersion);
				return;
			}
		}

		// 4. Interval-triggered auto-refine (no background plan was started).
		if (this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}
		await this._runSerializedAutoRefineReview("turn_interval", branchVersion);
	}

	private async _runSerializedAutoRefineReview(
		reason: "compact" | "turn_interval",
		branchVersion: number,
	): Promise<void> {
		const reviewAbort = new AbortController();
		this._autoRefineReviewAbort = reviewAbort;
		this._autoRefineInProgress = true;
		try {
			const review = await this._reviewAutoRefine(
				{ reason, turnsSinceLastReview: this._assistantTurnsSinceAutoRefine },
				reviewAbort.signal,
			);
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			if (!review.shouldRefine) {
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				return;
			}
			await this._runSerializedRefine({ instructions: autoRefineInstructions(reason, review) }, "auto");
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
		} catch (error) {
			if (branchVersion === this._autoRefineBranchVersion) {
				this._lastAutoRefineReviewAt = Date.now();
				// An extension skip is an intentional non-round, not a failure.
				if (error instanceof RefineSkippedError) {
					this._assistantTurnsSinceAutoRefine = 0;
				} else {
					this._emitRefineFailed(error);
				}
			}
		} finally {
			if (this._autoRefineReviewAbort === reviewAbort) {
				this._autoRefineReviewAbort = undefined;
			}
			this._autoRefineInProgress = false;
		}
	}

	/**
	 * Claim and process the serialized background plan if one is in flight.
	 * A concurrent caller waits for the claim holder's full processing callback
	 * instead of resuming as soon as planning settles.
	 */
	private async _consumeSerializedBackgroundPlan(
		consume: (result: SerializedBackgroundPlanResult | undefined) => Promise<boolean>,
	): Promise<"none" | "waited" | "continue" | "stop"> {
		if (this._serializedPlanClaim) {
			await this._serializedPlanClaim.catch(() => undefined);
			return "waited";
		}
		const planInFlight = this._serializedPlanInFlight;
		if (!planInFlight) {
			return "none";
		}

		let releaseClaim: () => void = () => {};
		const claim = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		this._serializedPlanClaim = claim;
		try {
			const result = await planInFlight.catch(() => undefined);
			if (this._serializedPlanInFlight === planInFlight) {
				this._serializedPlanInFlight = undefined;
				this._serializedExplicitRefineOptions = undefined;
			}
			return (await consume(result)) ? "stop" : "continue";
		} finally {
			releaseClaim();
			if (this._serializedPlanClaim === claim) {
				this._serializedPlanClaim = undefined;
			}
		}
	}

	/**
	 * Apply an exact background plan directly via _applyRefine without
	 * calling _planRefine again. Sets _refineInFlight for safety.
	 */
	private async _applySerializedPlan(
		bgResult: Extract<SerializedBackgroundPlanResult, { status: "plan" }>,
	): Promise<void> {
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			await this._applyRefine(bgResult.plan, bgResult.options, bgResult.abort);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._notifySessionInputCheckpointChange();
			this._scheduleSessionInputPump();
		}
	}

	/**
	 * Start background refinement planning at assistant message_end, while
	 * tools are still executing. The plan (if any) is awaited at the
	 * shouldStopAfterTurn boundary before applying. Planning overlaps tool
	 * execution only — never another model request.
	 */
	private _maybeStartSerializedBackgroundPlan(): void {
		if (!this._serializedRefine || this._disposed || this._disposing) {
			return;
		}
		// Don't start if a plan is already in flight.
		if (this._serializedPlanInFlight || this._refineInFlight || this._refinePlanInFlight) {
			return;
		}

		// Start background planning for a pending agent-callable
		// refine.run request, so its plan is ready at the shouldStopAfterTurn
		// boundary. The pending request is consumed (cleared) here so the
		// boundary doesn't re-plan it. Explicit refine.run skips the review gate.
		const pending = this._pendingRequestedRefine;
		if (pending) {
			this._pendingRequestedRefine = undefined;
			this._serializedExplicitRefineOptions = pending;
			const refineAbort = new AbortController();
			this._refineAbortController = refineAbort;
			const branchVersion = this._autoRefineBranchVersion;
			this._serializedPlanInFlight = this._runBackgroundPlan(pending, refineAbort, branchVersion, true);
			return;
		}

		// Interval-triggered auto-refine background planning.
		if (!this._autoRefineAllowedForSession()) {
			return;
		}
		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			return;
		}
		if (this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;
		const branchVersion = this._autoRefineBranchVersion;
		// Pass empty options — _runBackgroundPlan derives instructions from
		// the review result for interval-triggered auto-refine.
		this._serializedPlanInFlight = this._runBackgroundPlan({}, refineAbort, branchVersion);
	}

	/**
	 * Shared background planning coroutine. Runs review + planRefine and
	 * returns a discriminated result so the boundary can distinguish
	 * reviewer-declined ("skip") from failure ("failure") from a ready
	 * plan ("plan") and apply that exact plan without re-planning.
	 */
	private async _runBackgroundPlan(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
		branchVersion: number,
		skipReview = false,
	): Promise<SerializedBackgroundPlanResult | undefined> {
		try {
			let planOptions = options;
			if (!skipReview) {
				// Interval-triggered: run the review gate first, then derive
				// instructions from the review result (not prepopulated).
				const review = await this._reviewAutoRefine(
					{
						reason: "turn_interval",
						turnsSinceLastReview: this._assistantTurnsSinceAutoRefine,
					},
					refineAbort.signal,
				);
				if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
					return { status: "invalidated", branchVersion };
				}
				if (!review.shouldRefine) {
					return { status: "skip" };
				}
				planOptions = {
					instructions: autoRefineInstructions("turn_interval", review),
				};
			}
			// For explicit refine.run (skipReview=true), plan directly with
			// the user-provided options — no auto-review gate.
			const plan = await this._planRefine(planOptions, refineAbort.signal, skipReview ? "manual" : "auto");
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return { status: "invalidated", branchVersion };
			}
			return {
				status: "plan",
				plan,
				options: planOptions,
				abort: refineAbort,
				branchVersion,
			};
		} catch (error) {
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return { status: "invalidated", branchVersion };
			}
			if (error instanceof RefineSkippedError) {
				return { status: "skip", explicit: skipReview };
			}
			return {
				status: "failure",
				explicit: skipReview,
				options,
				branchVersion,
			};
		} finally {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
		}
	}

	/**
	 * Direct serialized plan+apply. Calls _planRefine and _applyRefine with
	 * proper in-flight guards but NEVER agent.waitForIdle or agent.abort.
	 * The caller (shouldStopAfterTurn) is already at the quiescent boundary,
	 * so the agent is between turns and _applyRefine's disconnect/reconnect
	 * is safe.
	 */
	private async _runSerializedRefine(
		options: {
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		},
		trigger: "manual" | "auto" = "manual",
	): Promise<void> {
		if (this._disposed || this._disposing) {
			return;
		}
		// Guard: serialize against concurrent _runSerializedRefine calls.
		// _serializedPlanInFlight covers background planning; _refineInFlight
		// covers the apply phase. Both must be settled before starting a new
		// plan+apply cycle.
		while (this._serializedPlanInFlight || this._refineInFlight || this._refinePlanInFlight) {
			if (this._serializedPlanInFlight) {
				await this._consumeSerializedBackgroundPlan(async () => false);
			} else if (this._refineInFlight) {
				await this._refineInFlight;
			} else {
				await this._refinePlanInFlight;
			}
		}
		if (this._disposed || this._disposing) {
			return;
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;

		const planRun = this._planRefine(options, refineAbort.signal, trigger);
		const planSettled = planRun.then(
			() => undefined,
			() => undefined,
		);
		this._refinePlanInFlight = planSettled;
		let plan: RefinementPlan;
		try {
			plan = await planRun;
		} catch (error) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._scheduleSessionInputPump();
			throw error;
		} finally {
			if (this._refinePlanInFlight === planSettled) {
				this._refinePlanInFlight = undefined;
			}
		}

		if (this._disposed || refineAbort.signal.aborted) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._scheduleSessionInputPump();
			return;
		}

		// Do NOT call agent.waitForIdle() — we are at the quiescent boundary
		// already (shouldStopAfterTurn). _applyRefine handles disconnect/reconnect internally.
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			await this._applyRefine(plan, options, refineAbort);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._notifySessionInputCheckpointChange();
			this._scheduleSessionInputPump();
		}
	}

	private async _thresholdCompactionNeeded(context: ShouldStopAfterTurnContext): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		const contextWindow = this.model?.contextWindow ?? 0;
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		if (compactionTimestamp !== undefined && context.message.timestamp <= compactionTimestamp) {
			return false;
		}

		const contextTokens = this._getThresholdContextTokens(context.message, compactionTimestamp);
		if (
			contextTokens === undefined ||
			!shouldCompact(contextTokens, contextWindow, settings, this._compactionWindowLimits())
		) {
			return false;
		}

		// Mirror _checkCompaction: a cooling-down threshold must not stop the loop or
		// queue continuations for a compaction that will not run. Without this the hook
		// ends the turn and burns a continuation while agent_end's cooldown check skips
		// the compaction, so nothing is compacted, nothing is disclosed, and
		// _continueAfterThresholdCompaction leaks into the next compaction.
		if (this._isThresholdCompactionCoolingDown(contextWindow)) return false;

		// Goal continuation takes exclusive priority over autonomous continuation, matching _getContinuationMessages.
		if (this._queueGoalContinuationForThresholdCompaction(context.message)) {
			this._continueAfterThresholdCompaction = true;
		} else if (await this._queueAutonomousContinuationForThresholdCompaction(context.message)) {
			this._continueAfterThresholdCompaction = true;
		}
		return true;
	}

	private _snapshotAutonomousRuntimeState(): AutonomousRuntimeSnapshot {
		return {
			continuationsUsed: this._autonomousState.continuationsUsed,
			gateAttempts: { ...this._autonomousState.gateAttempts },
			lastGateFailure: this._autonomousState.lastGateFailure
				? { ...this._autonomousState.lastGateFailure }
				: undefined,
			lastGateFailureSnapshot: this._autonomousState.lastGateFailureSnapshot
				? { ...this._autonomousState.lastGateFailureSnapshot }
				: undefined,
		};
	}

	private _restoreAutonomousRuntimeSnapshot(snapshot: AutonomousRuntimeSnapshot): void {
		this._autonomousState.continuationsUsed = snapshot.continuationsUsed;
		this._autonomousState.gateAttempts = { ...snapshot.gateAttempts };
		this._autonomousState.lastGateFailure = snapshot.lastGateFailure ? { ...snapshot.lastGateFailure } : undefined;
		this._autonomousState.lastGateFailureSnapshot = snapshot.lastGateFailureSnapshot
			? { ...snapshot.lastGateFailureSnapshot }
			: undefined;
	}

	private async _queueAutonomousContinuationForThresholdCompaction(
		message: AssistantMessage,
	): Promise<AgentMessage | undefined> {
		const queuedMessage = this._queuedAutonomousThresholdContinuations.get(message);
		if (queuedMessage && this._postCompactionContinuationMessages.includes(queuedMessage)) {
			return queuedMessage;
		}
		// Hold the post-compaction continuation while descendants are unsettled;
		// the owed continuation is delivered when they settle.
		if (this._holdAutonomousContinuationForRlmWork(message)) {
			return undefined;
		}
		const snapshot = this._snapshotAutonomousRuntimeState();
		const arrivalEpoch = this._sessionInputArrivalEpoch;
		const autonomousMessage = await nextAutonomousContinuation(this._autonomousState, message, {
			cwd: this._cwd,
			signal: this.agent.signal,
		});
		if (!autonomousMessage) {
			return undefined;
		}
		if (this._sessionInputArrivalEpoch !== arrivalEpoch) {
			this._restoreAutonomousRuntimeSnapshot(snapshot);
			return undefined;
		}
		this._queuedAutonomousThresholdContinuations.set(message, autonomousMessage);
		this._queuedAutonomousContinuationSnapshots.set(autonomousMessage, snapshot);
		this._postCompactionContinuationMessages.push(autonomousMessage);
		this._pendingThresholdCompactionAutonomousMessages.push(autonomousMessage);
		const text =
			typeof autonomousMessage.content === "string"
				? autonomousMessage.content
				: autonomousMessage.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		try {
			this._admitSessionInput(
				this._createPreparedTurnAction("followUp", text, undefined, {
					message: autonomousMessage,
				}),
			);
		} catch (error) {
			// Admission can close inside the await above: a dispose, or an input pause
			// (the ACP release path waits for the agent to go idle while
			// shouldStopAfterTurn is still running). Escaping would end the turn on an
			// unrelated "Cannot admit ..." error, and leaving the message in the
			// tracking arrays would make the session own a continuation that was never
			// admitted. Roll the queueing back the way the goal path does; the
			// compaction still stops the loop, just without a continuation.
			this._queuedAutonomousThresholdContinuations.delete(message);
			this._clearQueuedAutonomousContinuations({
				messages: [autonomousMessage],
				restoreAutonomousState: true,
			});
			sessionLog.warn("threshold compaction continuation was not admitted", {
				sessionId: this.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
		return autonomousMessage;
	}

	// The role heuristic reads an assistant-last threshold stop as "task finished" and
	// agent.continue() cannot resume from it, so the goal continuation is queued as a session input.
	private _queueGoalContinuationForThresholdCompaction(message: AssistantMessage): boolean {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return false;
		}
		if (this._goalState.status !== "active" || !this._goalState.objective) {
			return false;
		}
		const alreadyQueued = this._queuedGoalThresholdContinuation;
		if (
			alreadyQueued !== undefined &&
			this._actionStore.unfinishedActions().some((action) => {
				if (action.payload.kind !== "turn" || primaryDeliveryRecord(action).message !== alreadyQueued) return false;
				// A running continuation may already need a successor; only undelivered actions deduplicate.
				return (
					action.lifecycle.state === "queued" ||
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing" ||
					action.lifecycle.state === "committing"
				);
			})
		) {
			return true;
		}
		if (this._goalContinuationBudgetExhausted()) {
			return false;
		}
		const goalBeforeQueue = this._goalState;
		try {
			this._ensureGoalRuntimeActive();
			this._setGoalState({
				...this._goalState,
				continuationsUsed: this._goalState.continuationsUsed + 1,
				lastReason: undefined,
				lastError: undefined,
			});
			const goalMessage = createGoalContextMessage(this._goalState, "continuation");
			const normalized = normalizeMessageContent(goalMessage.content);
			this._admitSessionInput(
				this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message: goalMessage,
				}),
			);
			this._queuedGoalThresholdContinuation = goalMessage;
			return true;
		} catch {
			// Admission can race a pause or disposal; roll back the queue-time
			// increment so the next natural stop re-queues and re-counts it (G4,
			// r37 hbgoal-ts; mirrors _maybeResumeGoalContinuationAfterRlmWork).
			this._setGoalState(goalBeforeQueue);
			return false;
		}
	}

	// Withdraws a goal continuation queued for a threshold compaction the user cancelled,
	// rolling back the continuationsUsed increment so the next natural stop re-queues it.
	private _clearQueuedGoalContinuationAfterCancelledThresholdCompaction(
		queuedGoalContinuation: AgentMessage | undefined,
	): void {
		if (queuedGoalContinuation === undefined) return;
		const cancelled = this._cancelSessionActions(
			(action) => action.payload.kind === "turn" && primaryDeliveryRecord(action).message === queuedGoalContinuation,
			new Error("Queued goal continuation was cleared before delivery."),
		);
		this._queuedGoalThresholdContinuation = undefined;
		// A stale marker (continuation already consumed) matches no action; only an
		// actual cancellation may roll back its queue-time continuationsUsed increment.
		if (cancelled.length === 0) return;
		this._setGoalState({ ...this._goalState, continuationsUsed: this._goalState.continuationsUsed - 1 });
		this._emitQueueUpdate();
	}

	private _clearQueuedAutonomousContinuations(
		options: { restoreAutonomousState?: boolean; messages?: AgentMessage[] } = {},
	): void {
		const requestedMessages = options.messages ?? [...this._postCompactionContinuationMessages];
		const requestedMessageSet = new Set(requestedMessages);
		const queuedMessages = this._postCompactionContinuationMessages.filter((message) =>
			requestedMessageSet.has(message),
		);
		if (queuedMessages.length === 0) {
			return;
		}
		const queuedMessageSet = new Set(queuedMessages);
		this._postCompactionContinuationMessages = this._postCompactionContinuationMessages.filter(
			(message) => !queuedMessageSet.has(message),
		);
		this.agent.removeQueuedMessages((message) => queuedMessageSet.has(message));
		this._cancelSessionActions(
			(action) => action.payload.kind === "turn" && queuedMessageSet.has(primaryDeliveryRecord(action).message),
			new Error("Queued autonomous continuation was cleared before delivery."),
		);
		this._emitQueueUpdate();
		if (options.restoreAutonomousState) {
			for (const queuedMessage of queuedMessages) {
				const snapshot = this._queuedAutonomousContinuationSnapshots.get(queuedMessage);
				if (snapshot) {
					this._restoreAutonomousRuntimeSnapshot(snapshot);
					break;
				}
			}
		}
		for (const queuedMessage of queuedMessages) {
			this._queuedAutonomousContinuationSnapshots.delete(queuedMessage);
		}
		this._pendingThresholdCompactionAutonomousMessages = this._pendingThresholdCompactionAutonomousMessages.filter(
			(message) => !queuedMessageSet.has(message),
		);
		if (options.messages === undefined) {
			this._continueAfterThresholdCompaction = false;
		}
		if (!this.agent.hasQueuedMessages() && this.unfinishedActionCount === 0) {
			this._cancelPostCompactionContinue();
		}
	}

	private _clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
		shouldContinueAfterThreshold: boolean,
		queuedMessages: AgentMessage[],
	): void {
		if (shouldContinueAfterThreshold) {
			this._clearQueuedAutonomousContinuations({
				restoreAutonomousState: true,
				messages: queuedMessages,
			});
		}
	}

	/**
	 * Handle a goal.* request from the Python kernel host bridge (the bundled
	 * goal skill). All goal state stays host-side; the kernel only sees the
	 * serialized snake_case response.
	 */
	handleGoalHostRequest(type: string, payload: Record<string, unknown> = {}): GoalHostResponse {
		if (!this._includeGoals) {
			throw new Error("goals are disabled in this session");
		}
		switch (type) {
			case "goal.get":
				return goalHostResponse(this.goalState, false);
			case "goal.create": {
				if (typeof payload.objective !== "string") {
					throw new Error("goal.create objective must be a string");
				}
				if (payload.token_budget !== undefined && typeof payload.token_budget !== "number") {
					throw new Error("goal.create token_budget must be an integer when provided");
				}
				return goalHostResponse(this._createGoalFromHost(payload.objective, payload.token_budget), false);
			}
			case "goal.complete":
				return goalHostResponse(this._completeGoalFromHost(), true);
			default:
				throw new Error(`unknown goal request type "${type}"`);
		}
	}

	/**
	 * Handle a compact.* request from the kernel host bridge. Compaction would
	 * abort the run executing the requesting cell, so compact.run only schedules
	 * it; _checkCompaction consumes the request at the turn boundary.
	 */
	handleCompactHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		if (!this._includeCompactSkill) {
			throw new Error("the compact skill is disabled in this session");
		}
		switch (type) {
			case "compact.status": {
				const usage = this.getContextUsage();
				return {
					tokens: usage?.tokens ?? null,
					context_window: usage?.contextWindow ?? null,
					percent: usage?.percent ?? null,
					scheduled: this._pendingRequestedCompaction !== undefined,
				};
			}
			case "compact.run": {
				const instructions = payload.instructions;
				if (instructions !== undefined && typeof instructions !== "string") {
					throw new Error("compact.run instructions must be a string when provided");
				}
				if (!this.isStreaming) {
					return {
						scheduled: false,
						reason: "no active turn; compaction can only be requested while a turn is running",
					};
				}
				const preparation = prepareCompaction(
					this.sessionManager.getBranch(),
					this.settingsManager.getCompactionSettings(),
					this.model?.contextWindow,
					this._compactionWindowLimits(),
				);
				if (!preparation) {
					const lastEntry = this.sessionManager.getBranch().at(-1);
					return {
						scheduled: false,
						reason: lastEntry?.type === "compaction" ? "already compacted" : "session is too short to compact",
					};
				}
				this._pendingRequestedCompaction = { customInstructions: instructions };
				return {
					scheduled: true,
					note: "Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally.",
				};
			}
			default:
				throw new Error(`unknown compact request type "${type}"`);
		}
	}

	/**
	 * Handle a refine.* request from the kernel host bridge. Like compact,
	 * refinement waits for the current turn to become idle before applying
	 * changes, so refine.run only schedules it; _consumePendingRequestedRefine
	 * fires it at the turn boundary. This prevents a deadlock that would occur
	 * if refine() awaited agent idle from within the active tool call.
	 */
	handleRefineHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		switch (type) {
			case "refine.status": {
				return {
					pending: this._pendingRequestedRefine !== undefined,
					in_flight:
						this._refineInFlight !== undefined ||
						this._refinePlanInFlight !== undefined ||
						this._serializedPlanInFlight !== undefined,
				};
			}
			case "refine.run": {
				const instructions = payload.instructions;
				if (instructions !== undefined && typeof instructions !== "string") {
					throw new Error("refine.run instructions must be a string when provided");
				}
				const globalFlag = payload.global;
				if (globalFlag !== undefined && typeof globalFlag !== "boolean") {
					throw new Error("refine.run global must be a boolean when provided");
				}
				if (!this.isStreaming) {
					return {
						scheduled: false,
						reason: "no active turn; refine can only be requested while a turn is running",
					};
				}
				const previous = this._pendingRequestedRefine ?? this._serializedExplicitRefineOptions;
				this._pendingRequestedRefine = {
					instructions: instructions ?? previous?.instructions,
					global: globalFlag ?? previous?.global,
				};
				// In serialized mode, kick off background planning immediately
				// (the primary response ended at message_end, tools are active).
				// This lets planning overlap tool execution rather than waiting
				// for the shouldStopAfterTurn boundary.
				if (this._serializedRefine) {
					if (this._serializedPlanInFlight) {
						this._autoRefineBranchVersion++;
						if (this._refineAbortController) {
							this._refineAbortController.abort();
						} else {
							this._serializedPlanInFlight = Promise.resolve({
								status: "invalidated",
								branchVersion: this._autoRefineBranchVersion,
							});
						}
					} else {
						this._maybeStartSerializedBackgroundPlan();
					}
				}
				return {
					scheduled: true,
					note: "Refinement runs when the current turn ends; applied edits are appended to your context as a refinement notice and you resume automatically. Continue working normally.",
				};
			}
			default:
				throw new Error(`unknown refine request type "${type}"`);
		}
	}

	/**
	 * Handle an rlm_heartbeat.* request from the bundled rlm-heartbeat skill.
	 * These heartbeats are internal to this active session and never read or
	 * mutate the user-level /heartbeat.
	 */
	handleRlmHeartbeatHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		const controller = this._rlmHeartbeatController;
		if (!controller) {
			throw new Error("RLM heartbeat skill is not available in this session");
		}
		switch (type) {
			case "rlm_heartbeat.list": {
				const includeInactive = payload.include_inactive === true || payload.includeInactive === true;
				return {
					heartbeats: controller
						.listRlmHeartbeats({ includeInactive })
						.map((heartbeat) => rlmHeartbeatHostResponse(heartbeat)),
				};
			}
			case "rlm_heartbeat.create": {
				if (typeof payload.instruction !== "string") {
					throw new Error("rlm_heartbeat.create instruction must be a string");
				}
				if (payload.interval !== undefined && typeof payload.interval !== "string") {
					throw new Error("rlm_heartbeat.create interval must be a string when provided");
				}
				if (payload.label !== undefined && typeof payload.label !== "string") {
					throw new Error("rlm_heartbeat.create label must be a string when provided");
				}
				const deliveryMode = normalizeHeartbeatDeliveryMode(payload.delivery_mode ?? payload.deliveryMode);
				return {
					heartbeat: rlmHeartbeatHostResponse(
						controller.createRlmHeartbeat({
							instruction: payload.instruction,
							interval: payload.interval,
							label: payload.label,
							deliveryMode,
						}),
					),
				};
			}
			case "rlm_heartbeat.update": {
				if (typeof payload.id !== "string") {
					throw new Error("rlm_heartbeat.update id must be a string");
				}
				if (payload.instruction !== undefined && typeof payload.instruction !== "string") {
					throw new Error("rlm_heartbeat.update instruction must be a string when provided");
				}
				if (payload.interval !== undefined && typeof payload.interval !== "string") {
					throw new Error("rlm_heartbeat.update interval must be a string when provided");
				}
				if (payload.label !== undefined && typeof payload.label !== "string") {
					throw new Error("rlm_heartbeat.update label must be a string when provided");
				}
				if (payload.status !== undefined && !isRlmHeartbeatStatusUpdate(payload.status)) {
					throw new Error('rlm_heartbeat.update status must be "pause" or "resume" when provided');
				}
				const rawDeliveryMode = payload.delivery_mode ?? payload.deliveryMode;
				const deliveryMode = normalizeHeartbeatDeliveryMode(rawDeliveryMode);
				if (
					payload.instruction === undefined &&
					payload.interval === undefined &&
					payload.label === undefined &&
					payload.status === undefined &&
					rawDeliveryMode === undefined
				) {
					throw new Error("rlm_heartbeat.update requires at least one field to update");
				}
				const heartbeat = controller.updateRlmHeartbeat({
					id: payload.id,
					instruction: payload.instruction,
					interval: payload.interval,
					label: payload.label,
					status: payload.status,
					deliveryMode,
				});
				return {
					heartbeat: heartbeat ? rlmHeartbeatHostResponse(heartbeat) : null,
				};
			}
			case "rlm_heartbeat.delete": {
				if (typeof payload.id !== "string") {
					throw new Error("rlm_heartbeat.delete id must be a string");
				}
				const heartbeat = controller.deleteRlmHeartbeat(payload.id);
				return {
					heartbeat: heartbeat ? rlmHeartbeatHostResponse(heartbeat) : null,
				};
			}
			default:
				throw new Error(`unknown RLM heartbeat request type "${type}"`);
		}
	}

	handleAgentMessageHostRequest(
		type: string,
		payload: Record<string, unknown> = {},
	):
		| Promise<AgentSessionMessageListResult | AgentSessionMessageReceipt | AgentFamilyRosterResult>
		| AgentSessionMessageListResult
		| AgentFamilyRosterResult {
		if (!this._agentMessageController) {
			throw new Error("agent messaging is not available in this session");
		}
		switch (type) {
			case "agent_message.list_agents":
				if (!this._agentMessageController.roster)
					throw new Error("agent family roster is not available in this session");
				return this._agentMessageController.roster();
			case "agent_message.send": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_message.send target must be a string");
				}
				if (typeof payload.message !== "string") {
					throw new Error("agent_message.send message must be a string");
				}
				const target = assertDirectAgentMessageTarget(payload.target);
				const message = normalizeAgentSessionMessage(payload.message);
				const controller = this._agentMessageController;
				// The retry ledger and its TTL live on the session (O1), so the
				// public host request is the seam that owns them; the kernel
				// handler below only adds the delivery-receipt bookkeeping. The
				// wrapper keeps this method's mixed sync/async return type.
				return (async () => {
					try {
						const receipt = await controller.sendAgentMessage({ target, message });
						this._agentMessageSendFailures.delete(target);
						return receipt;
					} catch (error) {
						throw this._terminalizeRepeatedAgentMessageSendFailure(target, error);
					}
				})();
			}
			default:
				throw new Error(`unknown agent message request type "${type}"`);
		}
	}

	handleAgentObserveHostRequest(
		type: string,
		payload: Record<string, unknown> = {},
	):
		| AgentObserveListResult
		| AgentObserveAgentSnapshot
		| AgentObserveRecentMessagesResult
		| Promise<AgentObserveListResult | AgentObserveAgentSnapshot | AgentObserveRecentMessagesResult> {
		const controller = this._agentObserveController;
		if (!controller) {
			throw new Error("agent observation is not available in this session");
		}
		switch (type) {
			case "agent_observe.list":
				return controller.listAgents();
			case "agent_observe.get": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_observe.get target must be a string");
				}
				return controller.getAgent(payload.target);
			}
			case "agent_observe.recent": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_observe.recent target must be a string");
				}
				return controller.recentMessages({
					target: payload.target,
					limit: normalizeObserveLimit(payload.limit as number | undefined),
					maxChars: normalizeObserveMaxChars((payload.max_chars ?? payload.maxChars) as number | undefined),
				});
			}
			default:
				throw new Error(`unknown agent observe request type "${type}"`);
		}
	}

	private _createGoalFromHost(objective: string, tokenBudget: number | undefined): GoalState {
		switch (this._goalState.status) {
			case "active":
				throw new Error(
					"cannot create a new goal because this thread already has an active goal; run `await goal.complete()` when it is achieved, or ask the user to clear it with /goal clear",
				);
			case "paused":
				throw new Error(
					"cannot create a new goal because a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
				);
			case "budget_limited":
				throw new Error(
					"cannot create a new goal because a budget-limited goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
				);
			default:
				// idle, or a terminal record (complete / error): nothing pending, start fresh.
				return this._startGoal(objective, tokenBudget);
		}
	}

	private _completeGoalFromHost(): GoalState {
		if (!this._goalState.objective || this._goalState.status === "idle") {
			throw new Error("cannot complete goal because this thread has no goal");
		}
		const goal = this._goalWithAccountedWallClock();
		// A turn can cross the budget and complete the goal at once: accounting
		// runs at message_end, before the completing ipython cell executes, so a
		// budget-limit context may already be steered. It is stale now — drop it.
		this._clearQueuedGoalContexts();
		this._setGoalState({
			...goal,
			active: false,
			status: "complete",
			lastReason: "Goal achieved",
			lastError: undefined,
		});
		return this._goalState;
	}

	/**
	 * True when the goal has consumed its automatic-continuation budget. Marks the
	 * goal budget_limited with a visible stop reason the first time the exhausted
	 * budget is observed, so the stop leaves a durable trace instead of silently
	 * dangling active (G1, r37 hbgoal-ts).
	 */
	private _goalContinuationBudgetExhausted(): boolean {
		if (this._goalState.status !== "active" || this._goalState.continuationsUsed < MAX_GOAL_CONTINUATIONS) {
			return false;
		}
		const goal = this._goalWithAccountedWallClock();
		this._setGoalState({
			...goal,
			active: false,
			status: "budget_limited",
			lastReason: `goal continuation budget exhausted (${goal.continuationsUsed}/${MAX_GOAL_CONTINUATIONS} continuations); the goal stopped to avoid unbounded turns`,
			lastError: undefined,
		});
		return true;
	}

	private async _getGoalContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this._stopGoalContinuationForTerminalMessage(context.message)) {
			return [];
		}
		if (signal?.aborted || this._goalState.status !== "active" || !this._goalState.objective) {
			return [];
		}
		// Delegating and ending the turn is correct behavior; hold the continuation
		// until descendants settle instead of re-prompting a waiting parent.
		if (this._hasUnsettledRlmQuiescenceWork()) {
			this._goalContinuationAwaitsRlmWork = true;
			return [];
		}
		this._goalContinuationAwaitsRlmWork = false;
		if (this._goalContinuationBudgetExhausted()) {
			return [];
		}
		try {
			this._ensureGoalRuntimeActive(context.context);
			const nextGoal = {
				...this._goalState,
				continuationsUsed: this._goalState.continuationsUsed + 1,
				lastReason: undefined,
				lastError: undefined,
			};
			this._setGoalState(nextGoal);
			return [createGoalContextMessage(this._goalState, "continuation")];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				this._finishGoalWithError(message);
			} catch {
				// The continuation hook must not reject; listener failures should not crash the agent loop.
			}
			return [];
		}
	}

	private async _getContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this.queuedActionCount > 0) {
			return [];
		}
		const arrivalEpoch = this._sessionInputArrivalEpoch;
		const goalSnapshot = this._goalState;
		const goalAccountingStartedAt = this._goalAccountingStartedAt;
		const goalMessages = await this._getGoalContinuationMessages(context, signal);
		if (goalMessages.length > 0 || signal?.aborted) {
			if (goalMessages.length > 0 && this._sessionInputArrivalEpoch !== arrivalEpoch) {
				this._setGoalState(goalSnapshot);
				this._goalAccountingStartedAt = goalAccountingStartedAt;
				return [];
			}
			return goalMessages;
		}
		if (
			this._autonomousContinuationSuppressionDepth > 0 ||
			context.newMessages.some((message) => this._autonomousContinuationSuppressedMessages.has(message))
		) {
			return [];
		}
		// Delegating and ending the turn is correct behavior; hold the
		// continuation until descendants settle instead of re-prompting a
		// waiting parent, mirroring the goal gate above.
		if (this._holdAutonomousContinuationForRlmWork(context.message)) {
			return [];
		}
		const autonomousSnapshot = this._snapshotAutonomousRuntimeState();
		const autonomousMessage = await nextAutonomousContinuation(this._autonomousState, context.message, {
			cwd: this._cwd,
			signal,
		});
		if (autonomousMessage && this._sessionInputArrivalEpoch !== arrivalEpoch) {
			this._restoreAutonomousRuntimeSnapshot(autonomousSnapshot);
			return [];
		}
		return autonomousMessage ? [autonomousMessage] : [];
	}

	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	private _agentMessageOutcome(agentMessageId: string): AgentMessageOutcome {
		let outcome = this._agentMessageOutcomes.get(agentMessageId);
		if (!outcome) {
			outcome = {};
			this._agentMessageOutcomes.set(agentMessageId, outcome);
		}
		return outcome;
	}

	/**
	 * Register a delivery waiter before submitting the prompt. Delivery outcomes are not retained
	 * for late lookup, so callers that register after admission may wait for a future use of the id.
	 */
	waitForAgentMessagePromptDelivery(agentMessageId: string): Promise<void> {
		const outcome = this._agentMessageOutcome(agentMessageId);
		outcome.delivery ??= createAgentMessageDeferred();
		return outcome.delivery.promise;
	}

	private _settleAgentMessage(
		agentMessageId: string | undefined,
		leg: "delivery" | "completion",
		error?: Error,
	): void {
		if (agentMessageId === undefined) return;
		const outcome = this._agentMessageOutcomes.get(agentMessageId);
		if (!outcome) return;
		const deferred = outcome[leg];
		if (!deferred) return;
		outcome[leg] = undefined;
		if (!outcome.delivery && !outcome.completion) {
			this._agentMessageOutcomes.delete(agentMessageId);
		}
		if (error) deferred.reject(error);
		else deferred.resolve();
	}

	private _rejectAgentMessage(agentMessageId: string | undefined, error: Error): void {
		if (agentMessageId === undefined) return;
		this._settleAgentMessage(agentMessageId, "delivery", error);
		this._settleAgentMessage(agentMessageId, "completion", error);
	}

	private _rejectQueuedAgentMessageDeliveries(deliveryError: Error, completionError = deliveryError): void {
		for (const action of this._actionStore.unfinishedActions()) {
			this._settleAgentMessage(action.agentMessageId, "delivery", deliveryError);
			this._settleAgentMessage(action.agentMessageId, "completion", completionError);
		}
	}

	/**
	 * Take custody of a child reply this session could not deliver now.
	 *
	 * The sender saw a `queued` receipt and - correctly (B1) - did not count it as a
	 * reply, and nothing outside this session sees the moment the queue drains. So
	 * the pairing is recorded here and consumed by `_creditQueuedChildReplyDelivery`.
	 * A reply that is dropped instead of delivered is never taken, which keeps the
	 * B1 answer: an undelivered reply does not count.
	 */
	private _registerQueuedChildReply(message: AgentSessionMessage | undefined): void {
		if (!message) return;
		const senderSessionId = message.details.from?.sessionId;
		if (!isChildReplyToThisSession({ fromRelationship: message.details.fromRelationship, senderSessionId })) {
			return;
		}
		if (senderSessionId === undefined) return;
		this._queuedChildReplyBackfills.register(message.details.id, senderSessionId);
		// Countable: this is the line saying a reply credit is owed at delivery.
		sessionLog.info("queued child reply awaiting delivery credit", {
			sessionId: this.sessionId,
			messageId: message.details.id,
			senderSessionId,
		});
	}

	/**
	 * A queued child reply just landed in this session's context: credit its sender
	 * exactly once. Without this the reply never counts at all, and a child that
	 * answered a busy parent settles as `completed_without_reply` - a false alarm
	 * about a reply the parent has already read.
	 */
	private _creditQueuedChildReplyDelivery(message: AgentMessage): void {
		if (!isAgentSessionMessage(message)) return;
		const senderSessionId = this._queuedChildReplyBackfills.take(message.details.id);
		if (senderSessionId === undefined) return;
		// Marked before the sender lookup on purpose: a run outlives its session
		// binding, and "the reply this verdict called missing just landed" has to be
		// recorded even when the credit itself has nowhere to go.
		this._markTerminalVerdictsSupersededByDelivery(message.details.id);
		const child = this._rlmChildSessionBySessionId(senderSessionId);
		if (!child) {
			// The credit has nowhere to land: the sender is gone (a deleted child, or
			// a restart that re-flowed the queue with an empty ledger). Logging beats
			// guessing, since a wrong session credited is a wrong terminal verdict.
			sessionLog.warn("queued child reply delivered after its sender session was gone", {
				sessionId: this.sessionId,
				messageId: message.details.id,
				senderSessionId,
			});
			return;
		}
		child._creditDeliveredQueuedParentReply(message.details.id);
	}

	/**
	 * Every run this session can still answer for: in flight, and retained next to its
	 * session after it settled. A settled run leaves `_activeRlmChildRuns` before its
	 * queued reply drains, which is exactly when the credit lands, so reading only the
	 * active map would miss every run this gate exists for.
	 */
	private _knownRlmChildRuns(): RlmChildRun[] {
		const runs = new Map<string, RlmChildRun>([...this._activeRlmChildRuns.entries()]);
		for (const retained of this._rlmChildSessions.values()) {
			if (retained.run && !runs.has(retained.run.id)) runs.set(retained.run.id, retained.run);
		}
		return [...runs.values()];
	}

	/**
	 * Record that a message a settled run was still owed has now been delivered.
	 *
	 * Both terminal verdicts that a late delivery can disprove are marked here, and
	 * both are narrow on purpose: only a run that recorded this exact id when its
	 * verdict was taken is marked, and `take` hands an id out once, so neither a reply
	 * a later run boundary discarded nor a newer run of the same child session can be
	 * suppressed by an older message.
	 */
	private _markTerminalVerdictsSupersededByDelivery(messageId: string): void {
		for (const run of this._knownRlmChildRuns()) {
			if (run.noReplyVerdictSupersededBy === undefined && run.provisionalNoReplyReplyIds?.includes(messageId)) {
				run.noReplyVerdictSupersededBy = messageId;
				// Countable: this is the moment a no-reply verdict becomes known-stale,
				// which is minutes before the notice that would have repeated it.
				sessionLog.info("queued child reply landed after its run's no-reply verdict", {
					sessionId: this.sessionId,
					childId: run.id,
					messageId,
				});
			}
			if (run.failureVerdictSupersededBy === undefined && run.provisionalFailureNoticeReplyId === messageId) {
				run.failureVerdictSupersededBy = messageId;
				sessionLog.info("queued subagent terminal-error notice landed after its run's failure verdict", {
					sessionId: this.sessionId,
					childId: run.id,
					messageId,
				});
			}
		}
	}

	/** The running or retained child session with this transcript id, if this session owns one. */
	private _rlmChildSessionBySessionId(sessionId: string): AgentSession | undefined {
		for (const run of this._activeRlmChildRuns.values()) {
			if (run.session?.sessionId === sessionId) return run.session;
		}
		for (const { session } of this._rlmChildSessions.values()) {
			if (session.sessionId === sessionId) return session;
		}
		return undefined;
	}

	/**
	 * Count a reply this session sent earlier whose delivery only just happened: the
	 * receiving parent's queue held it, so the send receipt said `queued` and the
	 * count stayed put (B1). Called by that parent, once per message id.
	 */
	private _creditDeliveredQueuedParentReply(messageId: string): void {
		this._repliedToParentSinceTask = true;
		this._parentReplyCount += 1;
		// The parent marks the run it owes this delivery to before calling in here, so
		// the id has served its purpose; dropping it keeps a later run of this session
		// from being matched against an older report.
		if (this._queuedTerminalErrorNoticeMessageId === messageId) this._queuedTerminalErrorNoticeMessageId = undefined;
		sessionLog.info("queued parent reply delivered; reply credit backfilled", {
			sessionId: this.sessionId,
			messageId,
			parentReplyCount: this._parentReplyCount,
		});
	}

	private _capturingCancelledAction(message: AgentMessage): QueuedSessionAction | undefined {
		return this._actionStore
			.ownedActions()
			.find(
				(action) =>
					action.lifecycle.state === "cancelled" &&
					action.payload.kind === "turn" &&
					action.payload.captureRunMessages?.has(message) === true,
			);
	}

	private _hasCancelledDispatchCapture(): boolean {
		return this._actionStore
			.ownedActions()
			.some(
				(action) =>
					action.lifecycle.state === "cancelled" &&
					action.payload.kind === "turn" &&
					action.payload.captureRunMessages !== undefined,
			);
	}

	private _handleAgentEvent = (event: AgentEvent): void => {
		this._recordStallWatchdogActivity(event);
		this._createRetryPromiseForAgentEnd(event);
		if (event.type === "message_start" || event.type === "message_end") {
			for (const action of this._actionStore.ownedActions()) {
				if (
					action.payload.kind !== "turn" ||
					!action.payload.captureRunMessages ||
					action.payload.cancelledDispatchEnded
				) {
					continue;
				}
				const primary = primaryDeliveryRecord(action);
				if (event.message === primary.message || primary.started) {
					action.payload.captureRunMessages.add(event.message);
				}
			}
		} else if (event.type === "agent_end") {
			const captured = new Set<AgentMessage>();
			for (const action of this._actionStore.ownedActions()) {
				if (action.payload.kind === "turn" && action.payload.captureRunMessages) {
					for (const message of action.payload.captureRunMessages) captured.add(message);
					action.payload.cancelledDispatchEnded = true;
				}
			}
			if (captured.size > 0) {
				this.agent.state.messages = this.agent.state.messages.filter((message) => !captured.has(message));
			}
		}
		if (event.type === "message_start" && (event.message.role === "user" || event.message.role === "custom")) {
			for (const action of this._actionStore.actionsForMessage(event.message)) {
				const record =
					action.payload.kind === "turn"
						? action.payload.records.find((candidate) => candidate.message === event.message)
						: undefined;
				if (record) record.started = true;
				if (record?.role === "primary") {
					this._actionStore.ticketFor(action).settleDelivered({ status: "delivered" });
					this._settleAgentMessage(action.agentMessageId, "delivery");
					this._creditQueuedChildReplyDelivery(event.message);
				} else if (record) {
					// A child reply can also ride in as prefix/next-turn context (a restart
					// reflow, an aggregated wake): it reaches this session's context all the
					// same, so the credit is owed. `take` hands an id out once, so a message
					// delivered on both routes cannot be counted twice.
					this._creditQueuedChildReplyDelivery(event.message);
				}
			}
		} else if (event.type === "message_end" && (event.message.role === "user" || event.message.role === "custom")) {
			for (const action of this._actionStore.actionsForMessage(event.message)) {
				const record =
					action.payload.kind === "turn"
						? action.payload.records.find((candidate) => candidate.message === event.message)
						: undefined;
				if (record) record.durable = true;
				if (record?.role === "primary" && action.lifecycle.state === "committing") {
					transitionSessionAction(action, {
						state: "running",
						execution: "agent_turn",
					});
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
				}
			}
		}
		this._agentEventQueue = this._agentEventQueue.then(
			() => this._processAgentEvent(event),
			() => this._processAgentEvent(event),
		);
		this._agentEventQueue.catch(() => {});
	};

	/**
	 * Whether a host-owned phase currently owns this session's silence, so the watchdog snoozes
	 * instead of escalating (compaction, branch summaries, serialized refinement, a UI dialog).
	 *
	 * Deliberately *not* extended by the kernel-liveness vouch: a vouch only defers the abort, and
	 * B2 requires the warning to keep firing, which merging the two here would suppress. The
	 * "is this silence excused" question a parent needs for its label (B9/I-13) is answered by the
	 * exemption segment on the stall event - see `RlmChildStallState.excused` - not by this getter.
	 */
	/** Current stall marker, if the watchdog has fired and the turn has not restarted. */
	get stallState(): RlmChildStallState | undefined {
		return this._stallState;
	}

	/**
	 * Why the last abort of this session was requested, until the next turn starts.
	 * Published for diagnostics and for a parent classifying a child's terminal
	 * state: a stale reason would turn a healthy follow-up turn into a reported
	 * abort, which is exactly what the agent_start reset prevents.
	 */
	get lastTurnAbortReason(): RlmChildTurnAbortReason | undefined {
		return this._lastTurnAbortReason;
	}

	get stallExempted(): boolean {
		return (
			this._disposed ||
			this._disposing ||
			this.isCompacting ||
			this._branchSummaryOperation !== undefined ||
			this._autoRefineInProgress ||
			this._pendingUiDialogs > 0
		);
	}

	private _createStallWatchdog(): StallWatchdog {
		const options: StallWatchdogOptions = {
			enabled: () => this.settingsManager.getStallWatchdogSettings().enabled,
			warnAfterMs: () => this.settingsManager.getStallWatchdogSettings().warnAfterSeconds * 1000,
			abortAfterMs: () => {
				const s = this.settingsManager.getStallWatchdogSettings();
				return s.abortAfterSeconds > 0 ? s.abortAfterSeconds * 1000 : undefined;
			},
			// Both predicates are sampled from inside the watchdog's timer callbacks, so an
			// exception would escape into the timer, leave the watchdog with no timer armed, and
			// silently end escalation for this arm cycle (F2). The watchdog is the component that
			// has to survive other components misbehaving, so a throwing predicate degrades to
			// "no exemption" and is logged instead.
			isPaused: () => {
				try {
					return this.stallExempted;
				} catch (error) {
					this._reportStallPredicateFailure("isPaused", error);
					return false;
				}
			},
			vouch: () => this._sampleStallVouch(),
			// The default exemption sink logs without a session identity, and a daemon worker
			// hosts many sessions per process behind one shared stall-evidence file: a line that
			// cannot be attributed to the session it vouched for is a line a post-mortem cannot
			// use (JIT-1B). The formatter is shared with the default sink so the fields cannot drift.
			onExemptionEvent: (event) => this._logStallExemptionEvent(event),
			onStage: (info) => this._handleStallWatchdogStage(info),
			...(this._stallAbortSettleGraceMs === undefined ? {} : { abortSettleGraceMs: this._stallAbortSettleGraceMs }),
			...(this._stallWatchdogTimers === undefined ? {} : { timers: this._stallWatchdogTimers }),
		};
		return new StallWatchdog(options);
	}

	private _createTurnLiveness(): TurnLiveness {
		return createTurnLiveness({
			kernel: () =>
				this._stallKernelLivenessFacts ? this._stallKernelLivenessFacts() : this._kernelLivenessFactsFromClient(),
			...(this._stallJournaledBashHandles ? { readJournaledBashHandles: this._stallJournaledBashHandles } : {}),
			// Read live so an operator can widen or disable the bound without a new session (B7).
			revivalVouchMaxAgeMs: () => this.settingsManager.getKernelRestartSettings().revivalVouchMaxAgeMs,
			onEvent: (event) => this._handleTurnLivenessEvent(event),
		});
	}

	/**
	 * Kernel facts for the vouch, adapted from this session's kernel client. O(1) and read-only:
	 * the watchdog samples it on every touch. Returns undefined when the session has no kernel,
	 * which is "no facts", never "no work in flight".
	 */
	private _kernelLivenessFactsFromClient(): TurnLivenessKernelFacts | undefined {
		const kernel = this._ipythonKernelProvisioner?.manager;
		if (!kernel) return undefined;
		const liveness = kernel.kernelLiveness;
		return {
			...(liveness?.protocol === undefined ? {} : { protocol: liveness.protocol }),
			...(liveness?.latest ? { latest: liveness.latest } : {}),
			...(liveness?.previous ? { previous: liveness.previous } : {}),
			rejectedFrames: liveness?.rejectedFrames,
			consecutiveRejectedFrames: liveness?.consecutiveRejectedFrames,
			hostRequestCount: kernel.hostRequestCount,
			hostRequestOldestAgeMs: kernel.hostRequestOldestAgeMs,
			kernelPid: kernel.kernelPid,
			hasActiveExecution: kernel.hasActiveExecution,
			...(kernel.revivalVouch ? { revival: kernel.revivalVouch } : {}),
		};
	}

	/**
	 * Kernel-owned work this session is hosting: a cell executing right now, or live bash()
	 * handles the kernel's newest heartbeat attests. Residency evidence for the eviction-facing
	 * summaries (LIVE-1, r44): a session that ended its turn with a background script running is
	 * idle at the turn level, but closing it closes the kernel, and the kernel kills those
	 * handles' process groups, so eviction policy must treat the session as not idle.
	 *
	 * Deliberately not part of {@link isSessionActive}, which RLM quiescence and goal continuation
	 * read: those wait for turn-level work, and a long-lived background handle must not park them.
	 * Side-effect free for the caller, but not file-free: at most one cached `statSync`, because the
	 * kernel-side `isKernelBashRunning` reads the orphan-process journal behind a cache (one bounded
	 * read when the journal changed, or when a positive count outlived its TTL). That read is what
	 * keeps the fact true while the kernel sits idle hosting a background script, and false once the
	 * script exits - a heartbeat can do neither, since a runtime only sends frames while a request is
	 * in flight.
	 */
	get isKernelWorkInFlight(): boolean {
		const facts = this._kernelResidencyFacts ? this._kernelResidencyFacts() : this._kernelResidencyFactsFromClient();
		return facts?.hasActiveExecution === true || facts?.isKernelBashRunning === true;
	}

	private _kernelResidencyFactsFromClient(): KernelResidencyFacts | undefined {
		const kernel = this._ipythonKernelProvisioner?.manager;
		if (!kernel) return undefined;
		return {
			hasActiveExecution: kernel.hasActiveExecution === true,
			isKernelBashRunning: kernel.isKernelBashRunning === true,
		};
	}

	/**
	 * The vouch predicate (T1-3). Sampled at the moment of escalation and on every touch, so it
	 * caches nothing and adds no timer of its own.
	 *
	 * The first term is a necessary conjunction, not an optimization: with no tool in flight the
	 * silence belongs to the model stream, which `streamStallTimeoutMs` owns. Without it a live
	 * kernel handle would excuse a stuck provider response, which is the one case the judgement
	 * table explicitly excludes.
	 */
	private _sampleStallVouch(): StallVouchFacts | undefined {
		try {
			if (this.settingsManager.getStallWatchdogSettings().toolLivenessExemption === false) return undefined;
			if (this._stallInFlightTools.size === 0) return undefined;
			const facts = this._turnLiveness?.sample();
			if (!facts?.vouched) return undefined;
			return {
				active: true,
				reasons: facts.reasons,
				// Two tiers: movement buys the full budget, mere existence buys the short one that
				// stays near the pre-exemption abort threshold (M3).
				tier: facts.progress ? "progress" : "liveness",
				// The watchdog settles accrued exempt silence when this changes between two samples,
				// which is what keeps a long build that never stops producing from being charged for
				// the wall clock it takes (P1). Existence-only facts carry no token and settle nothing.
				...(facts.movementToken === undefined ? {} : { movementToken: facts.movementToken }),
				kernel: {
					...(facts.protocol === undefined ? {} : { protocol: facts.protocol }),
					...(facts.livenessAgeMs === undefined ? {} : { livenessAgeMs: facts.livenessAgeMs }),
					...(facts.liveBashHandles === undefined ? {} : { liveBashHandles: facts.liveBashHandles }),
					hostRequestCount: facts.hostRequestCount,
					...(facts.kernelPid === undefined ? {} : { kernelPid: facts.kernelPid }),
					reasons: facts.kernelReasons,
				},
			};
		} catch (error) {
			this._reportStallPredicateFailure("vouch", error);
			return undefined;
		}
	}

	private _reportStallPredicateFailure(predicate: string, error: unknown): void {
		// One line per predicate per turn: the failure has to be loud (a silently dead watchdog is
		// worse than the bug it was guarding) but sampling happens on every touch.
		if (this._stallPredicateFailures.has(predicate)) return;
		this._stallPredicateFailures.add(predicate);
		sessionLog.warn("stall watchdog predicate failed; treating it as no exemption", {
			predicate,
			error: error instanceof Error ? error.message : String(error),
			sessionId: this.sessionManager.getSessionId(),
		});
	}

	private _logStallExemptionEvent(event: StallExemptionEvent): void {
		const { msg, fields } = formatStallExemptionEventLog(event);
		sessionLog.info(msg, { ...fields, sessionId: this.sessionManager.getSessionId() });
	}

	private _handleTurnLivenessEvent(event: TurnLivenessEvent): void {
		// B4: the degraded path is a fallback, not a silent no-op. One line per kind per turn keeps
		// it countable in the daemon log without repeating it on every sample.
		if (this._turnLivenessLogged.has(event.kind)) return;
		this._turnLivenessLogged.add(event.kind);
		const fields = { ...event, sessionId: this.sessionManager.getSessionId() };
		if (event.kind === "degraded_read") {
			sessionLog.info("stall watchdog: kernel heartbeat unusable, fell back to journaled bash handles", fields);
			return;
		}
		sessionLog.warn(`stall watchdog: kernel liveness ${event.kind.replaceAll("_", " ")}`, fields);
	}

	/**
	 * Re-read the degraded facts when the kernel heartbeat cannot vouch. Bounded to one journal
	 * read per stall stage (a sync file read, tens of ms) and only while a tool is in flight, so
	 * the fallback cannot become a polling loop. The result lands in time for the next sampling:
	 * a deferred abort re-checks at most one warn window later.
	 */
	private _refreshStallDegradedFacts(): void {
		try {
			if (this._stallInFlightTools.size === 0) return;
			const facts = this._turnLiveness?.sample();
			if (!facts || facts.state === "fresh") return;
			this._turnLiveness?.refreshDegradedFacts();
		} catch (error) {
			this._reportStallPredicateFailure("degradedFacts", error);
		}
	}

	/** Kernel segment for a stall diagnostics payload; undefined when there is no kernel. */
	private _collectStallKernelDiagnostics(): StallKernelDiagnostics | undefined {
		try {
			const facts = this._turnLiveness?.sample();
			if (!facts || facts.protocol === undefined) return undefined;
			return normalizeStallKernelFacts({
				protocol: facts.protocol,
				...(facts.livenessAgeMs === undefined ? {} : { livenessAgeMs: facts.livenessAgeMs }),
				...(facts.liveBashHandles === undefined ? {} : { liveBashHandles: facts.liveBashHandles }),
				hostRequestCount: facts.hostRequestCount,
				...(facts.kernelPid === undefined ? {} : { kernelPid: facts.kernelPid }),
				reasons: facts.kernelReasons,
			});
		} catch (error) {
			this._reportStallPredicateFailure("diagnostics", error);
			return undefined;
		}
	}

	/**
	 * Why the watchdog aborted the current turn, for the ipython tool's aborted-cell report.
	 * Read-only; undefined until a stall abort fires, and cleared by the next agent_start.
	 */
	get lastStallAbortCause(): IpythonAbortCause | undefined {
		return this._lastStallAbortCause;
	}

	/**
	 * Feeds the stall watchdog: every agent event counts as activity. `agent_start`
	 * arms it, `agent_end` disarms it, so the watchdog only runs while a turn (or a
	 * multi-turn run) is in flight.
	 */
	private _recordStallWatchdogActivity(event: AgentEvent): void {
		const watchdog = this._stallWatchdog;
		if (!watchdog) return;
		const now = Date.now();
		this._stallLastEvent = { type: event.type, at: now };
		if (event.type === "tool_execution_start") {
			this._stallInFlightTools.set(event.toolCallId, { toolName: event.toolName, startedAt: now });
			// B4 ordering: the degraded read is bounded by its own lifetime, so refreshing here lets
			// the first warning already see the journaled handles instead of promising an abort that
			// the next sampling then defers. It only reads at all when the kernel heartbeat cannot
			// vouch (a protocol-3 kernel, or one whose frames stopped arriving).
			this._refreshStallDegradedFacts();
		} else if (event.type === "tool_execution_end") {
			this._stallInFlightTools.delete(event.toolCallId);
		}
		if (event.type === "agent_start") {
			this._stallInFlightTools.clear();
			// A new turn means the aborted turn is history: without this reset a
			// follow-up turn that completes normally would still be classified
			// against the earlier abort reason, and the roster would keep showing a
			// stall marker for a session that recovered.
			this._lastTurnAbortReason = undefined;
			this._stallState = undefined;
			// Same rule for the vouch's own state: a degraded journal read from the previous turn
			// must not excuse this one, and the once-per-turn log throttles restart with the turn.
			this._lastStallAbortCause = undefined;
			this._turnLiveness?.reset();
			this._stallPredicateFailures.clear();
			this._turnLivenessLogged.clear();
			watchdog.arm();
			return;
		}
		if (event.type === "agent_end") {
			this._stallInFlightTools.clear();
			// The abort took effect: the run produced a terminal event after it.
			if (this._lastStallAbort) this._lastStallAbort = { ...this._lastStallAbort, settled: true };
			watchdog.disarm();
			return;
		}
		watchdog.touch();
	}

	private _collectStallDiagnostics(silentMs: number): StallDiagnostics {
		const now = Date.now();
		const lastEvent = this._stallLastEvent;
		// The exemption segment is measured against the clock without re-sampling the predicates,
		// so collecting diagnostics cannot perturb the watchdog it describes.
		const exemption = this._stallWatchdog?.collectExemptionDiagnostics();
		const kernel = this._collectStallKernelDiagnostics();
		return {
			silentMs,
			busy: {
				streaming: this.isStreaming,
				compacting: this.isCompacting,
				retrying: this.isRetrying,
				bashRunning: this.isBashRunning,
			},
			lastEvent: lastEvent ? { ...lastEvent, ageMs: now - lastEvent.at } : undefined,
			inFlightToolCalls: [...this._stallInFlightTools.entries()].map(([toolCallId, entry]) => ({
				toolCallId,
				toolName: entry.toolName,
				startedAt: entry.startedAt,
				elapsedMs: now - entry.startedAt,
			})),
			pump: {
				suspended: this._sessionInputPumpSuspended,
				requested: this._sessionInputPumpRequested,
				epoch: this._sessionInputPumpEpoch,
			},
			unfinishedActions: this._actionStore.unfinishedActions().length,
			// Only a claimed exemption gets a segment: `collectExemptionDiagnostics` always returns
			// a shape, and an empty one in the payload would read as "an exemption was considered
			// and measured" rather than "nothing was ever excused".
			...(exemption?.reason ? { exemption } : {}),
			...(kernel ? { kernel } : {}),
		};
	}

	private _handleStallWatchdogStage(info: StallWatchdogStageInfo): void {
		const settings = this.settingsManager.getStallWatchdogSettings();
		// The watchdog re-checks its own live flag before firing, but a stage can be in
		// flight when the user disables it. Never warn about, or abort, a live turn the
		// user just put back under their own control.
		if (!settings.enabled) return;
		// B4: when the kernel heartbeat cannot vouch (stale, absent, or all frames rejected), the
		// journaled bash children are the only remaining fact. Read them once per stage, before
		// this stage's diagnostics are collected, so the next sampling sees them: a deferred abort
		// re-checks within one warn window.
		this._refreshStallDegradedFacts();
		const diagnostics = this._collectStallDiagnostics(info.silentMs);
		const logFields = {
			stage: info.stage,
			silentMs: info.silentMs,
			sessionId: this.sessionManager.getSessionId(),
			diagnostics,
		};
		// Roster marker: survives until the next agent_start so a wedged session
		// keeps reporting its silence instead of reading as healthy progress.
		// B9: an unspent exemption means the silence is owned work, not a wedge. The label travels
		// with the facts so every renderer (roster row, agents view, daemon-attached parent) reads
		// the same verdict instead of re-deriving one from `silentMs`.
		const stageExemption = info.exemption;
		const excused = stageExemption !== undefined && !stageExemption.exhausted;
		this._stallState = {
			silentMs: info.silentMs,
			thresholdMs: info.stage === "warn" ? settings.warnAfterSeconds * 1000 : settings.abortAfterSeconds * 1000,
			inFlightTools: diagnostics.inFlightToolCalls.map((call) => call.toolName),
			unsettled: info.stage === "abort_unsettled" || this._stallState?.unsettled === true ? true : undefined,
			...(excused && stageExemption ? { excused: true, excusedReasons: [...stageExemption.reasons] } : {}),
		};
		const kernelReasons = readStallKernelReasons(diagnostics);
		// F3: a warn-only watchdog (abortAfterSeconds 0) has no abort channel, so an exemption
		// defers nothing and the vouched copy would promise a deferral that cannot happen. Such a
		// session gets the unexempted text it has always gotten; the exemption is still in the
		// diagnostics and the log either way.
		const messageContext: StallMessageContext = {
			silentMs: info.silentMs,
			abortAfterSeconds: settings.abortAfterSeconds,
			...(settings.abortAfterSeconds > 0 && info.exemption ? { exemption: info.exemption } : {}),
			...(diagnostics.kernel ? { kernel: diagnostics.kernel } : {}),
		};
		const exemptionFields = info.exemption ? { exemption: info.exemption } : {};
		if (info.stage === "warn") {
			const message = buildStallWarnMessage(messageContext);
			sessionLog.warn("stall watchdog: no activity while turn running", { ...logFields, ...exemptionFields });
			this._emit({
				type: "stall_warning",
				message,
				silentMs: info.silentMs,
				thresholdMs: settings.warnAfterSeconds * 1000,
				diagnostics,
			});
			return;
		}
		if (info.stage === "abort") {
			const message = buildStallAbortMessage(messageContext);
			sessionLog.error("stall watchdog: aborting silent turn", { ...logFields, ...exemptionFields });
			// Recorded before the abort so the terminal classifier can tell a
			// watchdog kill from an ordinary completion; `settled` starts true and
			// only the abort_unsettled stage below revokes it.
			this._lastStallAbort = {
				silentMs: info.silentMs,
				thresholdMs: settings.abortAfterSeconds * 1000,
				inFlightTools: this._stallState.inFlightTools,
				kernelReasons: kernelReasons.length > 0 ? kernelReasons : undefined,
				settled: true,
			};
			// Structured cause for the aborted cell's own report (T1-5): what was vouching when the
			// budget ran out is part of the story, so both reason lists ride along, deduplicated.
			this._lastStallAbortCause = {
				silentMs: info.silentMs,
				reasons: [...new Set(["stall_watchdog", ...(info.exemption?.reasons ?? []), ...kernelReasons])],
				...(diagnostics.kernel?.kernelPid === undefined ? {} : { kernelPid: diagnostics.kernel.kernelPid }),
				at: Date.now(),
			};
			this._emit({
				type: "stall_abort",
				message,
				silentMs: info.silentMs,
				thresholdMs: settings.abortAfterSeconds * 1000,
				diagnostics,
			});
			this.requestAbort({ reason: "stall_watchdog" });
			return;
		}
		// abort_unsettled: the abort fired but the run never produced agent_end.
		// Emitted as its own type (not a second stall_warning) so "killed but still
		// running" is countable apart from "looks stuck"; a parent that sees it
		// records the fact on the run and keeps the kill classification.
		const message = buildStallAbortUnsettledMessage(messageContext);
		sessionLog.error("stall watchdog: abort did not settle the turn", { ...logFields, ...exemptionFields });
		if (this._lastStallAbort) this._lastStallAbort = { ...this._lastStallAbort, settled: false };
		this._emit({
			type: "stall_unsettled",
			message,
			silentMs: info.silentMs,
			thresholdMs: settings.abortAfterSeconds * 1000,
			diagnostics,
		});
	}

	private _createRetryPromiseForAgentEnd(event: AgentEvent): void {
		if (event.type !== "agent_end" || this._retryPromise) {
			return;
		}

		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return;
		}

		const lastAssistant = this._findLastAssistantInMessages(event.messages);
		const concreteAuthFailure = lastAssistant ? this._isConcreteProviderAuthFailure(lastAssistant) : false;
		if (!lastAssistant || (!this._isRetryableError(lastAssistant) && !concreteAuthFailure)) {
			return;
		}
		if (concreteAuthFailure) {
			this._captureRetryAuthFailureSource(lastAssistant);
		}

		this._retryPromise = new Promise((resolve) => {
			this._retryResolve = resolve;
		});
	}

	private _findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	private _addLoginGuidanceToAuthError(event: AgentEvent): void {
		const message =
			event.type === "message_end" && event.message.role === "assistant"
				? (event.message as AssistantMessage)
				: event.type === "agent_end"
					? this._findLastAssistantInMessages(event.messages)
					: undefined;
		if (!message || message.stopReason !== "error" || !message.errorMessage) {
			return;
		}
		if (!isLikelyAuthenticationError(message.errorMessage)) {
			return;
		}
		message.errorMessage = addLoginGuidanceToAuthError(message.errorMessage);
	}

	private async _processAgentEvent(event: AgentEvent): Promise<void> {
		let clearedDispatchEnded = false;
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult") {
			this._applyLateIpythonSentAgentMessages(event.message);
		}
		if (event.type === "message_start" || event.type === "message_end") {
			const cleared = this._capturingCancelledAction(event.message);
			if (cleared?.payload.kind === "turn" && cleared.payload.captureRunMessages) {
				const captured = cleared.payload.captureRunMessages;
				this.agent.state.messages = this.agent.state.messages.filter((message) => !captured.has(message));
				return;
			}
		}
		if (event.type === "agent_end") {
			const cleared = this._actionStore
				.ownedActions()
				.filter(
					(action) =>
						action.lifecycle.state === "cancelled" &&
						action.payload.kind === "turn" &&
						action.payload.captureRunMessages !== undefined,
				);
			if (cleared.length > 0) {
				clearedDispatchEnded = true;
				const removed = new Set(
					cleared.flatMap((action) =>
						action.payload.kind === "turn" ? [...(action.payload.captureRunMessages ?? [])] : [],
					),
				);
				this.agent.state.messages = this.agent.state.messages.filter((message) => !removed.has(message));
				(this.agent.state as { errorMessage?: string }).errorMessage = undefined;
				this._lastAssistantMessage = undefined;
				for (const action of cleared) this._actionStore.releaseTerminal(action);
				this._notifySessionInputCheckpointChange();
				this._resolveRetry();
			}
		}

		if (event.type === "message_start" && startsAgentRun(event.message)) {
			this._overflowRecovery = "idle";
		}

		await this._emitExtensionEvent(event);
		if (event.type === "message_start" || event.type === "message_end") {
			const cleared = this._capturingCancelledAction(event.message);
			if (cleared?.payload.kind === "turn" && cleared.payload.captureRunMessages) {
				const captured = cleared.payload.captureRunMessages;
				this.agent.state.messages = this.agent.state.messages.filter((message) => !captured.has(message));
				return;
			}
		}

		this._addLoginGuidanceToAuthError(event);

		this._emit(event);

		if (event.type === "message_end") {
			try {
				if (event.message.role === "custom") {
					this.sessionManager.appendCustomMessageEntry(
						event.message.customType,
						event.message.content,
						event.message.display,
						event.message.details,
					);
				} else if (
					event.message.role === "user" ||
					event.message.role === "assistant" ||
					event.message.role === "toolResult"
				) {
					this.sessionManager.appendMessage(event.message);
				}
			} catch (error) {
				// A failed transcript write must surface and must not stall the event
				// queue: the entry stays in memory and the next successful persist
				// rewrites the full transcript (SessionManager drops its flushed mark).
				this._reportSessionPersistFailure(error);
			}

			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				this._reportToolCallIdCollisions(assistantMsg);
				if (assistantMsg.stopReason !== "error") {
					addAutonomousUsage(this._autonomousState, assistantMsg.usage);
				}
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
					this._assistantTurnsSinceAutoRefine++;
					// In serialized mode, kick off background refinement planning
					// immediately after the primary stream finishes, while tools
					// are still executing. The plan is awaited at shouldStopAfterTurn
					// before applying, so planning overlaps tools only — never another
					// model request.
					this._maybeStartSerializedBackgroundPlan();
				}
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecovery = "idle";
				}
				if (this._isConcreteProviderAuthFailure(assistantMsg)) {
					this._captureRetryAuthFailureSource(assistantMsg);
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error") {
					// A real answer ends the request chain: the next failure starts from a
					// clean pool. The loop resets the same counter; doing it here as well
					// keeps the accounting correct for callers that stream without the loop.
					resetProviderRequestBudget(this.sessionId);
				}
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					const restoredModel = this._restorePrimaryModelAfterBackup();
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
						...(restoredModel ? { restoredModel } : {}),
					});
					this._retryAttempt = 0;
					this._terminalFailureAttemptCount = 0;
					this._providerWait = undefined;
					this._retryAuthFailureSources = [];
				}
				if (this._accountGoalUsageForAssistantMessage(assistantMsg)) {
					const message = createGoalContextMessage(this._goalState, "budget_limit");
					const normalized = normalizeMessageContent(message.content);
					await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
						message,
						resumeIfIdle: true,
					});
				}
			}
		}

		if (clearedDispatchEnded) {
			return;
		}

		if (event.type === "agent_end") {
			const msg =
				this._lastAssistantMessage ??
				(this._retryPromise ? this._findLastAssistantInMessages(event.messages) : undefined);
			this._lastAssistantMessage = undefined;
			if (!msg) {
				this._resolveRetry();
				return;
			}

			const concreteAuthFailure = this._isConcreteProviderAuthFailure(msg);
			const retryConcreteAuthFailure =
				concreteAuthFailure && !this._isStructuredPermanentProviderRetryExhausted(msg);
			if (this._isRetryableError(msg) || retryConcreteAuthFailure) {
				if (retryConcreteAuthFailure) {
					this._captureRetryAuthFailureSource(msg);
				}
				const didRetry = await this._handleRetryableError(msg, {
					markAuthStaleOnFailure: retryConcreteAuthFailure,
					authSourceTokens: retryConcreteAuthFailure ? this._retryAuthFailureSources : undefined,
				});
				if (didRetry) return; // Retry was initiated, don't proceed to compaction
			}

			const compactionWillRetry = await this._checkCompaction(msg);
			if (compactionWillRetry && this._retryAttempt > 0) {
				return;
			}
			this._finishActiveRetryWithFailure(msg);
			if (!compactionWillRetry && msg.stopReason === "error") {
				// Terminal failure: retries are exhausted, disabled, or the error was
				// never retryable. A subagent must tell its parent instead of parking
				// silently in needs_input (the synthesized completed_without_reply
				// notice carries no error context and reads like a normal completion).
				try {
					await this._notifyParentOfTerminalError(msg);
				} catch (error) {
					// The parent notice is best-effort; the retry resolution and goal
					// finalization below are not. A throw here would reject
					// _processAgentEvent, which is swallowed, leaving _retryPromise
					// unresolved and the session wedged in isRetrying.
					sessionLog.warn("subagent terminal-error notice failed", {
						sessionId: this.sessionManager.getSessionId(),
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			this._resolveRetry();
			if (!compactionWillRetry) {
				this._finishGoalForTerminalAssistantMessage(msg);
				// In serialized mode, agent-callable refine.run is serviced
				// at the shouldStopAfterTurn boundary, not here at agent_end.
				if (!this._serializedRefine) {
					const consumedRequestedRefine = this._consumePendingRequestedRefine();
					if (!consumedRequestedRefine) {
						this._scheduleAutoRefineAfterAgentEnd();
					}
				}
			}
		}
	}

	private _resolveRetry(): void {
		// The chain is over (answered, exhausted, disabled or cancelled): drop the shared
		// counter so the pool never outlives the request it accounts for.
		forgetProviderRequestBudget(this.sessionId);
		this._retryGeneration += 1;
		this._semanticEdges.clearTurnRetry();
		if (this._retryResolve) {
			this._retryResolve();
			this._retryResolve = undefined;
			this._retryPromise = undefined;
			this._notifySessionInputCheckpointChange();
			this._scheduleSessionInputPump();
		}
	}

	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _processAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			this.sessionManager.recordGitStateIfChanged();
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			// Also capture at end of turn so commits made during the run (e.g. via a bash tool) land.
			this.sessionManager.recordGitStateIfChanged();
			await this._extensionRunner.emit({
				type: "agent_end",
				messages: event.messages,
			});
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				this._replaceMessageInPlace(event.message, replacement);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	/**
	 * Async teardown for graceful quit/switch: await the Python kernel's dispose
	 * (which flushes a final namespace snapshot) before the synchronous dispose, so
	 * the latest state reaches disk instead of racing process exit.
	 */
	async disposeAsync(options?: { kernelSnapshot?: boolean }): Promise<void> {
		if (this._disposed) {
			return this._disposeCallbacksPromise;
		}
		// Concurrent callers await the same in-flight teardown so none resolves before
		// the kernel snapshot flush finishes.
		if (this._disposeAsyncPromise) {
			return this._disposeAsyncPromise;
		}
		const kernelSnapshot = options?.kernelSnapshot ?? true;
		this._disposeAsyncPromise = (async () => {
			// Drain before marking _disposing so a refine triggered at the final
			// agent_end completes instead of being aborted by dispose().
			await this._drainPendingRefinementForDisposal();
			if (this._disposed) {
				return this._disposeCallbacksPromise;
			}
			this._disposing = true;
			this._sessionActionCommitDisposeAbortController.abort();
			await this._disposeAsyncOnce(kernelSnapshot);
		})();
		return this._disposeAsyncPromise;
	}

	/**
	 * Await any in-flight refinement (planning or application) and run a
	 * pending auto-refine that was scheduled but not yet started. Called
	 * from disposeAsync before _disposing is set so refinement completes
	 * before disposal.
	 */
	private async _drainPendingRefinementForDisposal(): Promise<void> {
		for (const timer of this._scheduledAutoRefineTimers) {
			clearTimeout(timer);
		}
		this._scheduledAutoRefineTimers.clear();
		await Promise.allSettled([...this._autoRefineOperations]);
		for (const timer of this._scheduledAutoRefineTimers) {
			clearTimeout(timer);
		}
		this._scheduledAutoRefineTimers.clear();
		// Wait for in-flight refinement (including serialized background plan) to settle.
		while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
			if (this._refineInFlight) {
				await this._refineInFlight;
			} else if (this._refinePlanInFlight) {
				await this._refinePlanInFlight;
			} else if (this._serializedPlanInFlight) {
				// Await the background plan and apply a ready "plan" result before teardown.
				await this._consumeSerializedBackgroundPlan(async (bgResult) => {
					if (bgResult?.status === "plan" && bgResult.branchVersion === this._autoRefineBranchVersion) {
						try {
							await this._applySerializedPlan(bgResult);
						} catch (error) {
							this._emitRefineFailed(error, bgResult.options.global ? "global" : "local");
						}
						// Stamp cooldown and reset counter so the interval
						// check below does not trigger a duplicate refine.
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
					}
					// Preserve a consumed explicit request when its background plan failed,
					// matching the turn-boundary recovery path. The pending drain below
					// retries it once before disposal.
					if (
						bgResult?.status === "failure" &&
						bgResult.explicit &&
						bgResult.branchVersion === this._autoRefineBranchVersion &&
						!this._pendingRequestedRefine
					) {
						this._pendingRequestedRefine = bgResult.options;
					}
					if (bgResult?.status === "skip" && bgResult.explicit) {
						this._emitRefineFailed(new RefineSkippedError("Refinement skipped by extension"));
					}
					// For "skip" or "failure", stamp cooldown and reset counter
					// so the interval check below does not trigger a duplicate
					// terminal retry.
					if (
						bgResult?.status === "skip" ||
						bgResult?.status === "failure" ||
						bgResult?.status === "invalidated"
					) {
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
					}
					return false;
				});
			} else {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		}
		// Drain an agent-callable refine.run request that was scheduled but
		// not yet consumed. Use the direct serialized path (no waitForIdle)
		// since the agent may still own activeRun at the final agent_end.
		if (this._pendingRequestedRefine) {
			const pending = this._pendingRequestedRefine;
			this._pendingRequestedRefine = undefined;
			try {
				await this._runSerializedRefine(pending);
			} catch {
				// Best-effort drain; refinement errors must not block disposal.
			}
			// Stamp cooldown and reset counter so the interval check below
			// does not trigger a duplicate refine after the explicit drain.
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
		}
		// A serialized compaction can finish without another model turn. Drain its
		// pending review here so disposal does not silently lose the trigger.
		if (this._serializedRefine && this._compactAutoRefinePending && this._autoRefineAllowedForSession()) {
			const compactSettings = this.settingsManager.getAutoRefineSettings();
			if (!compactSettings.enabled || !compactSettings.compact) {
				this._compactAutoRefinePending = false;
			} else {
				const nowMs = Date.now();
				const underCooldown =
					this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < compactSettings.cooldownMs;
				this._compactAutoRefinePending = false;
				if (!underCooldown) {
					try {
						await this._runSerializedAutoRefineReview("compact", this._autoRefineBranchVersion);
					} catch {
						// Best-effort drain; refinement errors must not block disposal.
					}
					return;
				}
			}
		}

		// If auto-refine is due but has not started yet, run it now so the
		// refinement is persisted before disposal. Use the direct serialized
		// path in serialized mode, or _maybeAutoRefine in interactive mode
		// (where the agent is idle at this point).
		if (this._disposed || !this._autoRefineAllowedForSession()) {
			return;
		}
		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			return;
		}
		if (this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}
		if (this._serializedRefine) {
			await this._runSerializedRefineCheckpoint();
		} else {
			await this._maybeAutoRefine("turn_interval");
		}
	}

	private async _disposeAsyncOnce(kernelSnapshot: boolean): Promise<void> {
		// Flush kernels/traces for both still-running and retained children; the sync
		// dispose() below only tears them down synchronously.
		for (const run of [...this._activeRlmChildRuns.values()]) {
			const childSession = run.session;
			if (!childSession) continue;
			if (run.detachedDeletion) {
				run.suppressTerminalNotice = true;
				if (run.deletionCleanupObserver) {
					await run.deletionCleanupObserver.catch(() => false);
				} else if (run.deletionCleanup) {
					await run.deletionCleanup.catch(() => childSession.disposeAsync().catch(() => undefined));
				} else {
					// Cleanup already failed and was exposed for retry before disposal.
					await childSession.disposeAsync().catch(() => undefined);
				}
				if (!run.settled) await this._finishRlmRunDeletion(run);
			} else {
				await childSession.disposeAsync().catch(() => undefined);
			}
		}
		for (const unsubscribe of this._rlmChildUnsubscribes.values()) {
			unsubscribe();
		}
		this._rlmChildUnsubscribes.clear();
		for (const { session } of this._rlmChildSessions.values()) {
			await session.disposeAsync().catch(() => undefined);
		}
		this._rlmChildSessions.clear();
		this._rlmChildCleanupFailures.clear();
		this._deletedRlmChildIds.clear();
		try {
			await this._ipythonKernelProvisioner?.dispose({ snapshot: kernelSnapshot });
		} catch {
			// a failed kernel startup already cleaned up after itself
		}
		this.dispose();
		await this._disposeCallbacksPromise;
	}

	private _startDisposeCallbacks(): Promise<void> {
		if (this._disposeCallbacksPromise) {
			return this._disposeCallbacksPromise;
		}
		const pending: Promise<void>[] = [];
		for (const callback of this._disposeCallbacks) {
			try {
				const result = callback();
				if (result) {
					pending.push(result.catch(() => undefined));
				}
			} catch {
				// Disposal remains best-effort; one owner must not block the rest.
			}
		}
		this._disposeCallbacks.clear();
		this._disposeCallbacksPromise = Promise.all(pending).then(() => undefined);
		return this._disposeCallbacksPromise;
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._stallWatchdog?.dispose();
		this._clearRlmTerminalNoticeAbandonTimer();
		for (const run of this._unsettledRlmChildRuns) run.suppressTerminalNotice = true;
		for (const controller of this._rlmQuiescenceWaitAborts) controller.abort();
		this._sessionActionCommitDisposeAbortController.abort();
		try {
			// Invalidate scheduled timers and abort any in-flight review so a late
			// resolution cannot write harness state or re-subscribe handlers.
			this._autoRefineReviewAbort?.abort();
			this._refineAbortController?.abort();
			this._autoRefineWritableProbe = undefined;
			for (const timer of this._scheduledAutoRefineTimers) {
				clearTimeout(timer);
			}
			this._scheduledAutoRefineTimers.clear();
			this._disarmAutonomousSubagentKeepAlive();
			this._serializedPlanInFlight = undefined;
			this._serializedExplicitRefineOptions = undefined;
			this._pendingRequestedRefine = undefined;
			this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
			this._autoRefineBranchVersion++;
			this._cancelActiveRlmChildRuns("Parent session disposed");
			for (const unsubscribe of this._rlmChildUnsubscribes.values()) {
				unsubscribe();
			}
			this._rlmChildUnsubscribes.clear();
			for (const { session } of this._rlmChildSessions.values()) {
				session.dispose();
			}
			this._rlmChildSessions.clear();
			this._rlmChildCleanupFailures.clear();
			this._deletedRlmChildIds.clear();
			// A deferred `!cmd` result never reaches a turn boundary when the session
			// ends first, so it is persisted here instead of being dropped.
			this._flushPendingBashMessagesBeforeDispose();
			// B1 后半: dropping the queue here used to be silent, which made "queued"
			// blinder than the hard failure it replaced. Persist first, then clear.
			this._persistUndeliveredWorkBeforeDispose();
			this._pendingNextTurnMessages = [];
			const deliveryError = new Error("Session disposed before prompt delivery.");
			const completionError = new Error("Session disposed before prompt completion.");
			this._rejectQueuedAgentMessageDeliveries(deliveryError, completionError);
			// Undelivered replies stop being owed a credit; the persisted queue above is
			// what survives, and a re-flowed message starts with an empty ledger.
			this._queuedChildReplyBackfills.clear();
			for (const [agentMessageId, outcome] of this._agentMessageOutcomes) {
				if (outcome.delivery) this._settleAgentMessage(agentMessageId, "delivery", deliveryError);
				if (outcome.completion) this._settleAgentMessage(agentMessageId, "completion", completionError);
			}
			this._cancelSessionActions(() => true, deliveryError);
			this.agent.clearAllQueues();
			this._extensionRunner.invalidate(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
			);
			this._disconnectFromAgent();
			this._eventListeners = [];
			cleanupSessionResources(this.sessionId);
		} finally {
			// After the child sessions above were disposed (their final flushes may
			// still write inside it), the ephemeral directory has no remaining owner.
			this._removeEphemeralRlmSessionDir();
			void this._startDisposeCallbacks();
		}
	}

	registerDisposeCallback(callback: () => void | Promise<void>): void {
		if (this._disposed) {
			try {
				const result = callback();
				if (result) void result.catch(() => undefined);
			} catch {
				// Late registration follows the same best-effort disposal contract.
			}
			return;
		}
		this._disposeCallbacks.add(callback);
	}

	get state(): AgentState {
		return this.agent.state;
	}

	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	get serviceTier(): ServiceTier {
		return this.agent.state.serviceTier;
	}

	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	get retryAttempt(): number {
		return this._retryAttempt;
	}

	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	private _collectToolNameSources(): ToolNameSource[] {
		const sources: ToolNameSource[] = [];
		const allowedToolNames = this._allowedToolNames;
		const isAllowedTool = (name: string): boolean => !allowedToolNames || allowedToolNames.has(name);
		for (const name of this._baseToolDefinitions.keys()) {
			if (!isAllowedTool(name)) continue;
			sources.push({ name, kind: "builtin", label: `<builtin:${name}>` });
		}
		for (const tool of this._extensionRunner.getAllRegisteredTools()) {
			if (!isAllowedTool(tool.definition.name)) continue;
			const path = tool.sourceInfo?.path ?? `<extension:${tool.definition.name}>`;
			sources.push({ name: tool.definition.name, kind: "extension", label: path, path });
		}
		for (const tool of this._customTools) {
			if (!isAllowedTool(tool.name)) continue;
			sources.push({ name: tool.name, kind: "sdk", label: `<sdk:${tool.name}>` });
		}
		for (const tool of this._acpMcpTools) {
			if (!isAllowedTool(tool.name)) continue;
			sources.push({ name: tool.name, kind: "acp-mcp", label: `<acp-mcp:${tool.name}>` });
		}
		return sources;
	}

	/**
	 * Tool name collisions in the session tool registry: a custom tool that reuses a built-in name
	 * (allowed, the custom tool wins) or two custom tools from different sources fighting over one
	 * name. Extension-vs-extension collisions are reported by the extension runner instead.
	 */
	getToolDiagnostics(): ResourceDiagnostic[] {
		return detectToolNameConflicts(this._collectToolNameSources(), "last-wins").diagnostics;
	}

	private _reportToolNameConflicts(): void {
		for (const diagnostic of this.getToolDiagnostics()) {
			if (this._extensionRunner.hasUI()) {
				if (this._notifiedToolNameConflicts.has(diagnostic.message)) continue;
				this._notifiedToolNameConflicts.add(diagnostic.message);
				this._extensionRunner.getUIContext().notify(diagnostic.message, "warning");
			} else {
				if (this._warnedToolNameConflicts.has(diagnostic.message)) continue;
				this._warnedToolNameConflicts.add(diagnostic.message);
				console.warn(diagnostic.message);
			}
		}
	}

	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		const seenToolNames = new Set<string>();
		for (const name of toolNames) {
			if (seenToolNames.has(name)) {
				continue;
			}
			const tool = this._toolRegistry.get(name);
			if (tool) {
				seenToolNames.add(name);
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	buildSessionContext(): SessionContext {
		const context = this.sessionManager.buildSessionContext();
		for (const message of context.messages) {
			this._applyLateIpythonSentAgentMessages(message);
		}
		this._mergeUnpersistedOutcomes(context.messages);
		return context;
	}

	private _mergeUnpersistedOutcomes(messages: AgentMessage[]): void {
		for (const outcome of this._unpersistedOutcomes) {
			let insertAt = messages.length;
			while (insertAt > 0 && messages[insertAt - 1]!.timestamp > outcome.timestamp) {
				insertAt -= 1;
			}
			messages.splice(insertAt, 0, outcome);
		}
	}

	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	get rlmDepth(): number {
		return this._rlmDepth;
	}

	get semanticEdges(): SemanticEdgeRecorder {
		return this._semanticEdges;
	}

	get rlmMaxDepth(): number {
		return this._rlmMaxDepth;
	}

	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get goalState(): GoalState {
		return { ...this._goalWithCurrentWallClock() };
	}

	getAutonomousStatus(): AgentAutonomousStatus {
		return autonomousStatus(this._autonomousState);
	}

	recordHostAutonomousContinuation(): void {
		addAutonomousContinuation(this._autonomousState);
	}

	async refreshAutonomousGates(): Promise<void> {
		await refreshAutonomousQualityGates(this._autonomousState, {
			cwd: this._cwd,
		});
	}

	private async _runWithAutonomousContinuationSuppressed<T>(fn: () => Promise<T>): Promise<T> {
		this._autonomousContinuationSuppressionDepth++;
		try {
			return await fn();
		} finally {
			this._autonomousContinuationSuppressionDepth--;
		}
	}

	private _markAutonomousContinuationSuppressed(message: AgentMessage): void {
		this._autonomousContinuationSuppressedMessages.add(message);
	}

	get scopedModels(): ReadonlyArray<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}> {
		return this._scopedModels;
	}

	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._modelVisibleSkills();
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			messagesPath: this.sessionManager.getSessionFile(),
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			allowRecursion: this._rlmDepth < this._effectiveRlmMaxDepth(),
			rlmDepth: this._rlmDepth,
			rlmParentAgent: this._rlmParentAgent,
			// No harnessState on purpose (#2098): the digest rides in-context at cold
			// boundaries (_ensureHarnessDigestContext), so every rebuild point below is
			// byte-identical unless tools, skills, depth or context files really changed.
			genericMcpServers: this._mcpManager?.getEnabledPersistentGenericServers(),
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	private _refreshExtensionSystemPrompt(extensionPrompt: string, baseSnapshot: string): string {
		if (this._baseSystemPrompt === baseSnapshot) {
			return extensionPrompt;
		}
		if (!extensionPrompt.includes(baseSnapshot)) {
			return extensionPrompt;
		}
		return extensionPrompt.replace(baseSnapshot, () => this._baseSystemPrompt);
	}

	private _finishSubmissionNormalization(
		text: string,
		images: ImageContent[] | undefined,
		policy: SubmissionNormalizationPolicy,
	): NormalizedSubmission {
		if (policy.expandPromptTemplates) this._throwIfUnknownSlashCommand(text);
		let expandedText = text;
		if (policy.expandSkills) expandedText = this._expandSkillCommand(expandedText);
		if (policy.expandPromptTemplates) {
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}
		return { kind: "prompt", text: expandedText, images };
	}

	/**
	 * Reject slash-command typos before they burn a model round trip and pollute
	 * the transcript. Only fires when a registered command name is close enough to
	 * be the intended one; anything else passes through, so genuine prompts that
	 * merely start with "/" keep working.
	 */
	private _throwIfUnknownSlashCommand(text: string): void {
		const parsed = parseSlashCommand(text);
		if (!parsed) return;
		// No registered command name is anywhere near this long; oversized
		// /-prefixed inputs are prompts, and fuzzy matching them would be
		// quadratic work on the event loop.
		if (parsed.name.length > 64) return;
		if (isBuiltinSlashCommandName(parsed.name)) return;
		if (this.promptTemplates.some((template) => template.name === parsed.name)) return;
		const skills = this._resourceLoader.getSkills().skills;
		if (parsed.name.startsWith("skill:") && skills.some((skill) => skill.name === parsed.name.slice("skill:".length)))
			return;
		const candidates = [
			...BUILTIN_SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
			...SESSION_SLASH_COMMAND_NAMES,
			...this.promptTemplates.map((template) => template.name),
			...this._extensionRunner.getRegisteredCommands().map((command) => command.invocationName),
			...skills.map((skill) => `skill:${skill.name}`),
		];
		const suggestion = findSlashCommandSuggestion(parsed.name, candidates);
		if (!suggestion) return;
		throw new Error(`Unknown command: /${parsed.name}. Did you mean /${suggestion}?`);
	}

	private _normalizeSubmission(
		text: string,
		images: ImageContent[] | undefined,
		policy: SubmissionNormalizationPolicy,
	): NormalizedSubmission | Promise<NormalizedSubmission> {
		if (policy.parseSessionCommands) {
			const command = parseSessionSlashCommand(text);
			if (command) return { kind: "sessionCommand", text, images, command };
		}

		if (text.startsWith("/")) {
			if (policy.extensionCommands === "execute") {
				const completion = this._executeExtensionCommand(text);
				if (completion) return { kind: "extensionCommand", completion };
			} else if (policy.extensionCommands === "reject") {
				this._throwIfExtensionCommand(text);
			}
		}

		if (policy.inputSource !== undefined && this._extensionRunner.hasHandlers("input")) {
			return this._extensionRunner.emitInput(text, images, policy.inputSource).then((result) => {
				if (result.action === "handled") return { kind: "handled" };
				if (result.action === "transform") {
					return this._finishSubmissionNormalization(result.text, result.images ?? images, policy);
				}
				return this._finishSubmissionNormalization(text, images, policy);
			});
		}

		return this._finishSubmissionNormalization(text, images, policy);
	}

	private async _runPreTurnCompaction(): Promise<void> {
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) await this._checkCompaction(lastAssistant, false, false);
	}

	private async _prepareForCommit<TPrepared, TCommitted>(
		policy: CommitPreparationPolicy,
		steps: CommitPreparationSteps<TPrepared, TCommitted>,
	): Promise<TCommitted | undefined> {
		if (
			policy.initialRefineBarrier === "always" ||
			(policy.initialRefineBarrier === "ifInFlight" && this._refineInFlight)
		) {
			await this._waitForRefineIdle();
		}
		if (policy.flushPendingBashBeforeValidation) this._flushPendingBashMessages();
		if (policy.validateModelAndAuth) await this._validateCanStartAgentRun();
		steps.afterValidation?.();
		if (!policy.flushPendingBashBeforeValidation) this._flushPendingBashMessages();

		if (policy.preTurnCompaction === "beforeModelSelection") await this._runPreTurnCompaction();
		if (policy.awaitPendingModelSelection) {
			const pendingModelSelectEmit = this._pendingModelSelectEmit();
			if (pendingModelSelectEmit) await pendingModelSelectEmit;
		}
		if (policy.preTurnCompaction === "afterModelSelection") await this._runPreTurnCompaction();

		const prepared = await steps.prepare();
		if (steps.shouldCommit && !steps.shouldCommit(prepared)) return undefined;
		steps.beforeFinalRefineBarrier?.(prepared);
		let passedFinalRefineBarrier = false;
		if (
			policy.finalRefineBarrier === "always" ||
			(policy.finalRefineBarrier === "ifInFlight" && this._refineInFlight)
		) {
			await this._waitForRefineIdle();
			passedFinalRefineBarrier = true;
		}
		return steps.commit(prepared, passedFinalRefineBarrier);
	}

	private _applyPreparedSystemPrompt(
		preparation: PreparedPromptPreparation | undefined,
		preserveEmptyExtensionPrompt: boolean,
	): void {
		const extensionPrompt = preparation?.result?.systemPrompt;
		const hasExtensionPrompt = preserveEmptyExtensionPrompt
			? extensionPrompt !== undefined
			: Boolean(extensionPrompt);
		this.agent.state.systemPrompt =
			hasExtensionPrompt && extensionPrompt !== undefined && preparation !== undefined
				? this._refreshExtensionSystemPrompt(extensionPrompt, preparation.basePromptSnapshot)
				: this._baseSystemPrompt;
	}

	private _canStartSessionActionImmediately(): boolean {
		return (
			!this.isStreaming &&
			!this.isCompacting &&
			!this.isRetrying &&
			!this.isBashRunning &&
			!this._sessionInputPumpSuspended &&
			this._queuedWorkPauses.size === 0 &&
			!this._disposed &&
			!this._disposing
		);
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		return this._prompt(text, options);
	}

	async promptUntilAccepted(text: string, options?: PromptOptions): Promise<void> {
		return this._prompt(text, { ...options, returnAfterAccepted: true });
	}

	async promptAndWait(text: string, options?: PromptOptions): Promise<void> {
		const agentMessageId = options?.agentMessageId ?? `prompt-wait:${randomUUID()}`;
		if (this._agentMessageOutcomes.get(agentMessageId)?.completion) {
			throw new Error(`Prompt completion id is already in use: ${agentMessageId}`);
		}
		const outcome = this._agentMessageOutcome(agentMessageId);
		outcome.completion = createAgentMessageDeferred();
		const completion = outcome.completion.promise;
		const signal = options?.signal;
		let cancelQueuedPrompt: (() => void) | undefined;
		try {
			await this.promptUntilAccepted(text, { ...options, agentMessageId });
			if (signal) {
				cancelQueuedPrompt = () => {
					const error = new Error("Prompt was cancelled before it started.");
					const cancelled = this._cancelSessionActions(
						(action) => action.agentMessageId === agentMessageId && action.payload.kind === "turn",
						error,
					);
					if (cancelled.length > 0) {
						this._settleAgentMessage(agentMessageId, "completion", error);
					}
				};
				signal.addEventListener("abort", cancelQueuedPrompt, { once: true });
				if (signal.aborted) cancelQueuedPrompt();
			}
			await completion;
		} catch (error) {
			this._settleAgentMessage(agentMessageId, "completion", this._asError(error));
			throw error;
		} finally {
			if (signal && cancelQueuedPrompt) {
				signal.removeEventListener("abort", cancelQueuedPrompt);
			}
		}
	}

	async acceptAgentMessagePrompt(text: string, options?: PromptOptions): Promise<void> {
		const customMessage =
			options?.customMessage && isAgentSessionMessage(options.customMessage) ? options.customMessage : undefined;
		const clearEpoch = this._agentMessageClearEpoch;
		const admissionCommitted = () => {
			options?.admissionCommitted?.();
			if (clearEpoch !== this._agentMessageClearEpoch) {
				throw new Error("Agent message was cleared before admission");
			}
		};
		if (this._sessionInputPumpSuspended && options?.queueIfBusy === true && options.streamingBehavior) {
			// P0-3a: a suspended pump is a reason to queue, not to refuse. The
			// idle-and-suspended case used to fall through to _prompt and fail loudly,
			// so a child replying to a parent that had been aborted (or stall-killed)
			// got a hard tool error and concluded the message could not be sent at all.
			// Queuing keeps the message durable and visible; the update-restart fence
			// still refuses to *wake* the pump (wakeSuspendedSessionInput guards it),
			// and a disposed session stays a terminal error.
			if (this._disposed || this._disposing) {
				throw new Error("Cannot admit a session action because the session is disposing or disposed.");
			}
			admissionCommitted();
			const queued = await this.queueAgentMessagePrompt(text, options.streamingBehavior, customMessage);
			options.preflightResult?.(queued, queued, "target_suspended");
			return;
		}
		// Compaction outranks an incoming agent message
		// (compaction.priorityOverAgentMessages). Without this the reply took the
		// direct-prompt branch of _prompt, whose execution policy skips pre-turn
		// compaction (skipPrePromptWork), so it opened a turn on the over-threshold
		// context and the compaction only ran at that turn's agent_end - one request
		// closer to the provider's input wall every time. The message queues instead
		// (durable, visible, credited as queued) and the compaction starts now; the
		// pump delivers the message once the compaction settles.
		const compactionGate = this._incomingAgentMessageCompactionGate(customMessage, options);
		if (compactionGate !== undefined && options?.streamingBehavior) {
			if (this._disposed || this._disposing) {
				throw new Error("Cannot admit a session action because the session is disposing or disposed.");
			}
			admissionCommitted();
			// Start the compaction before queueing: _runAutoCompaction arms its abort
			// controller synchronously, so isCompacting is already true when the queued
			// action becomes selectable and the pump defers it instead of starting a turn.
			if (compactionGate === "compaction_pending") this._startThresholdCompactionForIncomingInput();
			else this._armCompactionGateWatchdog();
			const queued = await this.queueAgentMessagePrompt(text, options.streamingBehavior, customMessage);
			options.preflightResult?.(queued, queued, "compaction_pending");
			sessionLog.info("agent message queued behind compaction", {
				sessionId: this.sessionId,
				gate: compactionGate,
				queued,
			});
			// A compaction that settled before the queueing finished scheduled a pump that
			// had nothing to select; schedule again so the message is not stranded until
			// the next unrelated wake.
			this._scheduleSessionInputPump();
			return;
		}
		// A queued admission puts this session in custody of a child's reply: the
		// sender's receipt says `queued`, so the sender does not count it (B1), and
		// the credit is owed when the queue drains instead.
		const preflightResult = options?.preflightResult;
		const reportPreflight = (success: boolean, queued?: boolean, queuedReason?: AgentMessageQueuedReason): void => {
			if (success && queued === true) this._registerQueuedChildReply(customMessage);
			preflightResult?.(success, queued, queuedReason);
		};
		await this._prompt(text, {
			...options,
			resumeIfIdle: false,
			expandPromptTemplates: false,
			skipInputHandlers: true,
			skipPrePromptWork: true,
			returnAfterAccepted: true,
			agentMessageId: options?.agentMessageId ?? customMessage?.details.id ?? parseAgentSessionMessagePromptId(text),
			customMessage,
			admissionCommitted,
			preflightResult: reportPreflight,
		});
		if (customMessage?.details.fromRelationship === "parent") this._repliedToParentSinceTask = false;
	}

	async queueAgentMessagePrompt(
		text: string,
		streamingBehavior: "steer" | "followUp",
		customMessage?: AgentSessionMessage,
	): Promise<boolean> {
		const agentMessageId = customMessage?.details.id ?? parseAgentSessionMessagePromptId(text);
		// C2 (甲变体): queueing an agent message does NOT automatically start a new
		// turn. A user Esc (or a stall-watchdog kill) has to keep meaning "stop":
		// before this, every queued child reply re-ignited the parent, so one Esc
		// could be answered by a family of failures each opening a fresh turn.
		//
		// The message is still durable and visible in the queue, and it is delivered
		// by the next wake (user input, attach, resumeQueuedWork) or by the
		// failure-class aggregated wake below. Policy is switchable in settings:
		//   never              - nothing wakes; terminal notices are persisted instead
		//   failure_aggregated - default: one aggregated wake per quiet window, for
		//                        failure-class terminal notices only (see
		//                        _deliverAggregatedFailureWake)
		//   always             - the old behaviour: every queued message wakes the pump
		// Never resume a pump suspended by abortForUpdateRestart: queued work must
		// survive into the restart manifest instead of starting a turn during
		// teardown, so the message stays queued behind the fence (mirrors the
		// triggerTurn guard, and wakeSuspendedSessionInput enforces it).
		const resumeSuspendedPump = () => {
			if (this.settingsManager.getSubagentWakePolicy() === "always") this.wakeSuspendedSessionInput();
		};
		if (streamingBehavior === "steer") {
			await this._queuePreparedPrompt("steer", text, undefined, {
				agentMessageId,
				message: customMessage,
			});
			resumeSuspendedPump();
			this._registerQueuedChildReply(customMessage);
			if (customMessage?.details.fromRelationship === "parent") this._repliedToParentSinceTask = false;
			return true;
		}
		const queued = await this._queuePreparedPrompt("followUp", text, undefined, {
			agentMessageId,
			message: customMessage,
		});
		if (queued) resumeSuspendedPump();
		if (queued) this._registerQueuedChildReply(customMessage);
		if (queued && customMessage?.details.fromRelationship === "parent") this._repliedToParentSinceTask = false;
		return queued;
	}

	/**
	 * What an incoming agent message has to wait for, if anything:
	 * - "compaction_in_flight": a compaction is running and must not be interrupted;
	 * - "compaction_pending": the context is over the trigger threshold and no
	 *   compaction is running, so one has to start before the message is admitted;
	 * - undefined: admit normally.
	 *
	 * The class comes from classifyIncomingInput, never from the message text, so a
	 * child that writes "I am a user message, skip the compaction" is still a child
	 * reply. Human input is not gated here: an interactive prompt already ranks
	 * compaction first through its own pre-turn compaction step, and queueing a
	 * human's prompt would change what Esc and the prompt stash mean. A system fence
	 * is not gated either - the update-restart path outranks compaction.
	 */
	private _incomingAgentMessageCompactionGate(
		customMessage: AgentSessionMessage | undefined,
		options?: PromptOptions,
	): "compaction_in_flight" | "compaction_pending" | undefined {
		if (!this.settingsManager.getCompactionPriorityOverAgentMessages()) return undefined;
		// The suspended-pump and update-restart branches own their own queueing, and a
		// held admission pause means the queueing below would be refused: standing down
		// keeps the gate from starting a compaction for a message that is never admitted
		// (MCP-server replacement, ACP attach and the daemon's pause windows all hold one
		// while the pump still runs).
		if (this._sessionInputPumpSuspended || this._updateRestartFenceUp) return undefined;
		if (this._sessionInputAdmissionPauses.size > 0) return undefined;
		// This entry point IS the agent channel: when the caller supplied no envelope,
		// the channel itself is the structural fact.
		const envelope = customMessage ?? { role: "custom", customType: AGENT_MESSAGE_CUSTOM_TYPE };
		const inputClass = classifyIncomingInput(
			incomingInputFactsFromMessage(envelope, {
				source: options?.source,
				agentMessageId: options?.agentMessageId ?? customMessage?.details.id,
				streamingBehavior: options?.streamingBehavior,
			}),
		);
		if (inputClassOrigin(inputClass) === "human" || inputClass === "system_fence") return undefined;
		if (this.isCompacting) return "compaction_in_flight";
		// A turn in flight compacts at its own agent_end; starting a second compaction
		// here would race it.
		if (this.isStreaming) return undefined;
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return undefined;
		const contextWindow = this.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;
		// Anti-starvation: a failed or skipped compaction arms a cooldown, and inside it
		// the gate stands down. A family must not be starved by a compaction that will
		// not run.
		if (this._isThresholdCompactionCoolingDown(contextWindow)) return undefined;
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		const contextTokens = this._estimateThresholdContextTokens(compactionTimestamp);
		if (contextTokens === undefined) return undefined;
		if (!shouldCompact(contextTokens, contextWindow, settings, this._compactionWindowLimits())) return undefined;
		return "compaction_pending";
	}

	/**
	 * Start the threshold compaction a queued agent message is waiting for.
	 * Fire-and-forget on purpose: admission must not block on the summarization call,
	 * and _runAutoCompaction reports its own outcome through the compaction events.
	 */
	private _startThresholdCompactionForIncomingInput(): void {
		if (this.isCompacting || this._disposed || this._disposing) return;
		void this._runAutoCompaction("threshold", false).catch((error: unknown) => {
			sessionLog.error("threshold compaction started by an incoming agent message failed", {
				sessionId: this.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
		this._armCompactionGateWatchdog();
	}

	/**
	 * Bound how long a compaction may hold queued agent messages.
	 *
	 * The stall watchdog snoozes while a host phase owns the turn boundary
	 * (stall-watchdog.ts: `isPaused()` covers compaction), so a hung summarization
	 * call would otherwise hold every queued reply forever: the gate that ranks
	 * compaction first must not become a way to starve the family. After the
	 * configured stall budget the compaction is aborted and the pump is scheduled, so
	 * the queued input is delivered instead.
	 */
	private _armCompactionGateWatchdog(): void {
		if (this._compactionGateWatchdog !== undefined) return;
		const operation = this._compactionOperation;
		if (!operation) return;
		const configured = this.settingsManager.getStallWatchdogSettings().abortAfterSeconds;
		// The stall watchdog ships warn-only (abortAfterSeconds 0), and it snoozes while
		// compaction owns the turn boundary anyway, so the gate carries its own bound.
		const abortAfterSeconds =
			Number.isFinite(configured) && configured > 0 ? configured : COMPACTION_GATE_ABORT_AFTER_SECONDS;
		const timer = setTimeout(() => {
			this._compactionGateWatchdog = undefined;
			if (this._disposed || this._disposing) return;
			if (!this.isCompacting) return;
			sessionLog.warn("compaction holding queued agent messages exceeded the stall budget; aborting it", {
				sessionId: this.sessionId,
				abortAfterSeconds,
			});
			this.abortCompaction();
			this._scheduleSessionInputPump();
		}, abortAfterSeconds * 1000);
		timer.unref?.();
		this._compactionGateWatchdog = timer;
		const clear = (): void => {
			if (this._compactionGateWatchdog === timer) {
				clearTimeout(timer);
				this._compactionGateWatchdog = undefined;
			}
		};
		void operation.then(clear, clear);
	}

	async promptHeartbeat(job: AgentCronJob, options?: PromptOptions): Promise<AgentHeartbeatPromptResult> {
		const message = createHeartbeatPromptMessage(job);
		return await this._promptInjectedMessage(job.prompt, message, {
			...options,
			followUpQueueKey: options?.followUpQueueKey ?? `heartbeat:${job.id}`,
			resumeIfIdle: true,
		});
	}

	private _isRlmTerminalNotice(message: CustomMessage): boolean {
		return (
			message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE
		);
	}

	private _assertRlmTerminalNotice(message: CustomMessage): void {
		if (!this._isRlmTerminalNotice(message)) {
			throw new Error("Deferred terminal admission only accepts RLM child terminal notices.");
		}
	}

	private _isRlmTerminalNoticeAction(action: QueuedSessionAction): boolean {
		if (action.payload.kind !== "turn") return false;
		const message = primaryDeliveryRecord(action).message;
		return message.role === "custom" && this._isRlmTerminalNotice(message);
	}

	private _hasDeferredRlmTerminalNotices(): boolean {
		return this._pendingNextTurnMessages.some((message) => this._isRlmTerminalNotice(message));
	}

	/**
	 * Why a deferred terminal notice is no longer true, or undefined if this session
	 * cannot disprove it.
	 *
	 * A terminal verdict is a snapshot taken when the child settles; the notice that
	 * carries it is published when this session's queue drains, which in production is
	 * a median of 19 minutes later. Everything queued ahead of the notice has been
	 * delivered by the time this runs - a child reply is a steer (`next_turn_boundary`)
	 * and a notice is a follow-up (`when_run_idle`), and `selectFirst` always prefers
	 * the steer - so re-reading two facts here is race free:
	 *
	 * - a no-reply notice whose provisional reply was credited in between;
	 * - a failure notice whose child reported the same failure through agent_message
	 *   in between (the child's own notice is a steer too, so it lands first).
	 *
	 * Nothing is re-decided. `run.terminalKind` keeps the verdict `collectRlmChildren`
	 * already published, the classifier's inputs are untouched, and a notice this
	 * cannot disprove - no live run to read, a reply that was cleared instead of
	 * delivered - is published unchanged. Fail open: losing a child's death report is
	 * worse than repeating one.
	 *
	 * `delivering` covers the one case where the disproof has not landed yet because
	 * it is landing in this very turn: a suspended pump leaves the notice in the
	 * pending queue, and the wake that drains it can be the reply it calls missing,
	 * which would otherwise prepend the notice ahead of that reply.
	 */
	private _supersededRlmTerminalNoticeReason(
		message: CustomMessage,
		delivering?: readonly AgentMessage[],
	): string | undefined {
		if (!this._isRlmTerminalNotice(message)) return undefined;
		const details = message.details as { kind?: string; childId?: string } | undefined;
		const childId = details?.childId;
		if (typeof childId !== "string" || childId.length === 0) return undefined;
		const run = this._activeRlmChildRuns.get(childId) ?? this._rlmChildSessions.get(childId)?.run;
		if (message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE) {
			if (details?.kind !== "completed_without_reply") return undefined;
			const supersededBy = run?.noReplyVerdictSupersededBy;
			if (supersededBy !== undefined) return `the reply it calls missing was delivered (${supersededBy})`;
			const owed = run?.provisionalNoReplyReplyIds;
			if (owed && delivering) {
				for (const candidate of delivering) {
					if (!isAgentSessionMessage(candidate)) continue;
					if (!owed.includes(candidate.details.id)) continue;
					return `the reply it calls missing is being delivered in this same turn (${candidate.details.id})`;
				}
			}
			if (!run) {
				// Countable: a restored notice (a session re-hydrated after a dispose) has
				// no run left to re-validate against, so it publishes unverified.
				sessionLog.info("rlm no-reply notice published without re-validation; its run is gone", {
					sessionId: this.sessionId,
					childId,
				});
			}
			return undefined;
		}
		const failureDetails = message.details as { kind?: string } | undefined;
		if (failureDetails?.kind !== undefined && failureDetails.kind !== "error") return undefined;
		const supersededFailure = run?.failureVerdictSupersededBy;
		return supersededFailure !== undefined
			? `the child's own terminal-error notice was delivered first (${supersededFailure})`
			: undefined;
	}

	/**
	 * Log one suppression: a fix that hides a notice has to leave a countable trace.
	 * A withheld no-reply notice is also recorded on its run, so `collectRlmChildren`
	 * can reconcile "the verdict says no reply" with "no notice ever arrived".
	 */
	private _reportSupersededRlmTerminalNotice(message: CustomMessage, reason: string): void {
		const details = message.details as { kind?: string; childId?: string; sessionName?: string } | undefined;
		sessionLog.info("rlm terminal notice superseded before publication", {
			sessionId: this.sessionId,
			childId: details?.childId,
			sessionName: details?.sessionName,
			kind: details?.kind ?? message.customType,
			reason,
		});
		if (details?.kind !== "completed_without_reply" || typeof details.childId !== "string") return;
		const run = this._activeRlmChildRuns.get(details.childId) ?? this._rlmChildSessions.get(details.childId)?.run;
		if (run) run.noReplyNoticeSuperseded = true;
	}

	/** The notices that are still true, dropping (and logging) the disproved ones. */
	private _filterSupersededRlmTerminalNotices(
		messages: CustomMessage[],
		delivering?: readonly AgentMessage[],
	): CustomMessage[] {
		if (messages.length === 0) return messages;
		const kept: CustomMessage[] = [];
		for (const message of messages) {
			const reason = this._supersededRlmTerminalNoticeReason(message, delivering);
			if (reason === undefined) {
				kept.push(message);
				continue;
			}
			this._reportSupersededRlmTerminalNotice(message, reason);
		}
		return kept;
	}

	/**
	 * Cancel queued terminal notices a later delivery disproved, before the pump can
	 * select them. A no-op unless a notice is in flight and its verdict went stale.
	 */
	private _dropSupersededRlmTerminalNoticeActions(): void {
		const superseded = new Map<QueuedSessionAction, string>();
		// Deliberately not fed the pending next-turn queue: a reply still sitting there
		// needs this very action's turn to be delivered, so cancelling the notice would
		// strand the reply it was meant to be disproved by. Only a delivery that has
		// already happened (or one riding in this same turn, handled by
		// `_takePendingNextTurnMessagesForTurn`) can disprove a notice.
		for (const action of this._actionStore.clearableActions()) {
			if (action.lifecycle.state === "preparing" || action.payload.kind !== "turn") continue;
			const primary = primaryDeliveryRecord(action).message;
			if (this._isRlmTerminalNoticeAction(action)) {
				if (primary.role !== "custom") continue;
				const reason = this._supersededRlmTerminalNoticeReason(primary);
				if (reason !== undefined) superseded.set(action, reason);
				continue;
			}
			// An aggregated failure wake folds notices in as prefix records behind a
			// synthetic summary, so the notice is not this action's primary message and
			// a gate that only reads the primary would wave the duplicate through.
			this._stripSupersededFoldedRlmTerminalNotices(action, superseded);
		}
		if (superseded.size === 0) return;
		const ids = new Set([...superseded.keys()].map((action) => action.id));
		for (const [action, reason] of superseded) {
			const message = primaryDeliveryRecord(action).message;
			if (message.role === "custom") this._reportSupersededRlmTerminalNotice(message, reason);
			this._durableRlmTerminalNoticeActionIds.delete(action.id);
		}
		this._cancelSessionActions(
			(action) => ids.has(action.id),
			new Error("RLM child terminal notice was superseded before publication."),
		);
		this._emitQueueUpdate();
	}

	/**
	 * Drop superseded notices folded into an action as non-primary records.
	 *
	 * The wake's summary text names every failure it folded, so it is rebuilt from the
	 * survivors: a summary still claiming a failure whose notice was just withheld
	 * would repeat the duplicate in prose. When nothing survives, the whole action is
	 * handed back to the caller for cancellation - a wake with nothing to report must
	 * not start a turn.
	 */
	private _stripSupersededFoldedRlmTerminalNotices(
		action: QueuedSessionAction,
		cancel: Map<QueuedSessionAction, string>,
	): void {
		if (action.payload.kind !== "turn") return;
		const struck: DeliveryRecord[] = [];
		for (const record of action.payload.records) {
			if (record.role === "primary" || record.durable) continue;
			const message = record.message;
			if (message.role !== "custom" || !this._isRlmTerminalNotice(message)) continue;
			const reason = this._supersededRlmTerminalNoticeReason(message);
			if (reason === undefined) continue;
			this._reportSupersededRlmTerminalNotice(message, reason);
			struck.push(record);
		}
		if (struck.length === 0) return;
		const struckSet = new Set<DeliveryRecord>(struck);
		action.payload.records = action.payload.records.filter((record) => !struckSet.has(record));
		const survivors = action.payload.records
			.map((record) => record.message)
			.filter(
				(message): message is CustomMessage => message.role === "custom" && this._isRlmTerminalNotice(message),
			);
		if (survivors.length === 0) {
			const firstReason = "every folded terminal notice was superseded before publication";
			cancel.set(action, firstReason);
			return;
		}
		const summary = aggregatedFailureWakeText(survivors);
		action.payload.text = summary;
		action.payload.content = [{ type: "text", text: summary }];
		const primary = primaryDeliveryRecord(action).message;
		if (primary.role === "user") primary.content = [{ type: "text", text: summary }];
	}

	/**
	 * Deferred next-turn context for a turn that is about to start, minus any terminal
	 * notice this very turn disproves. See `_supersededRlmTerminalNoticeReason`: the
	 * prepended-notice route is the one place a notice could otherwise reach the parent
	 * ahead of the reply it calls missing.
	 */
	private _takePendingNextTurnMessagesForTurn(turns: readonly SessionAction<PreparedTurnPayload>[]): CustomMessage[] {
		const messages = this._takePendingNextTurnMessages();
		if (messages.length === 0) return messages;
		return this._filterSupersededRlmTerminalNotices(
			messages,
			turns.map((action) => primaryDeliveryRecord(action).message),
		);
	}

	/** When the currently deferred terminal notices first became stuck, if any. */
	get deferredRlmTerminalNoticeSince(): number | undefined {
		return this._rlmTerminalNoticeDeferredSince;
	}

	/** Record of the last abandonment of undeliverable deferred terminal notices. */
	get rlmTerminalNoticeAbandonment(): { abandonedAt: number; count: number } | undefined {
		return this._rlmTerminalNoticeAbandonment;
	}

	/**
	 * Deferred terminal notices are undelivered work, but they must not pin a
	 * session forever: when the pump stays suspended after an abort nothing
	 * flushes them, and the session would never passivate or evict. Once a
	 * notice has waited past the threshold, attempt delivery through the normal
	 * flush (which succeeds if the pump became runnable again) and otherwise
	 * abandon it so the session becomes evictable. Forcing a turn while the pump
	 * is intentionally suspended would break the suspension contract, so
	 * abandonment is the stable fallback.
	 */
	maybeAbandonStaleDeferredRlmTerminalNotices(now = Date.now()): void {
		if (!this._hasDeferredRlmTerminalNotices()) {
			this._clearRlmTerminalNoticeDeferred();
			return;
		}
		const deferredSince = this._rlmTerminalNoticeDeferredSince;
		if (deferredSince === undefined || now - deferredSince < this._rlmTerminalNoticeAbandonAfterMs) return;
		this._flushDeferredRlmTerminalNotices();
		if (!this._hasDeferredRlmTerminalNotices()) {
			this._clearRlmTerminalNoticeDeferred();
			return;
		}
		// C3: the two classes part ways here. A failure notice is the only record
		// that a child died, so it is written straight into this session's transcript
		// (and survives a restart through the sidecar written at dispose) instead of
		// being dropped. `completed_without_reply` / `cancelled` keep the old
		// abandonment so a session holding only those can still passivate or evict.
		// Same gate as the publication path: an abandoned failure notice is written
		// straight into the transcript, so a duplicate the child already reported by
		// hand must not be written either.
		this._pendingNextTurnMessages = this._filterSupersededRlmTerminalNotices(this._pendingNextTurnMessages);
		const persisted: CustomMessage[] = [];
		let abandoned = 0;
		this._pendingNextTurnMessages = this._pendingNextTurnMessages.filter((message) => {
			if (!this._isRlmTerminalNotice(message)) return true;
			if (message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE) {
				persisted.push(message);
				return false;
			}
			abandoned += 1;
			return false;
		});
		for (const message of persisted) this._appendCustomMessageToTranscript(message);
		this._clearRlmTerminalNoticeDeferred();
		if (persisted.length === 0 && abandoned === 0) return;
		this._rlmTerminalNoticeAbandonment = { abandonedAt: now, count: abandoned + persisted.length };
		// Three observable exits (event, log, transcript/sidecar) replace a filter
		// that used to discard a child's death report without a trace. Production
		// expectation is ~0; anything else is now forensically visible.
		sessionLog.error("rlm terminal notices were not deliverable", {
			sessionId: this.sessionId,
			abandoned,
			persistedToTranscript: persisted.length,
			deferredMs: now - deferredSince,
			pumpSuspended: this._sessionInputPumpSuspended,
		});
		this._emit({
			type: "rlm_terminal_notice_abandoned",
			abandoned,
			persistedToTranscript: persisted.length,
			deferredMs: now - deferredSince,
		});
	}

	/**
	 * Write a custom message straight into the transcript.
	 *
	 * `sendCustomMessage`'s direct-land branch is an `else`: while the session is
	 * streaming the same call becomes a steer/follow-up queue entry, i.e. exactly the
	 * "wait for the pump" path an undeliverable terminal notice must not take (the
	 * pump may never come back). This is the unconditional form of the same three
	 * steps, and the only writer used by the abandonment path.
	 */
	private _appendCustomMessageToTranscript(message: CustomMessage): void {
		const entry = cloneCustomMessage(message);
		this.agent.state.messages.push(entry);
		this.sessionManager.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
		this._emit({ type: "message_start", message: entry });
		this._emit({ type: "message_end", message: entry });
	}

	/**
	 * Sidecar holding undelivered notices/queued replies across a restart (B10).
	 *
	 * Undefined for a session that does not persist: an in-memory session (a test
	 * harness, an inline RLM descendant) has no session dir of its own, so a path
	 * would resolve against the process cwd - dropping a private file into the
	 * repository and letting an unrelated session reflow somebody else's notices.
	 */
	get undeliveredRlmNoticeSidecarPath(): string | undefined {
		if (!this.sessionManager.allowsPersistence()) return undefined;
		// A subagent's own artifact dir is per-session already; a top-level session
		// shares its sessions dir with every other session, so the file name carries
		// the session id - otherwise a restart of one session would reflow another
		// session's undelivered notices.
		const dir = this._rlmSessionDir || this.sessionManager.getSessionDir();
		if (!dir) return undefined;
		return join(dir, `${UNDELIVERED_RLM_NOTICES_FILE}.${this.sessionManager.getSessionId()}`);
	}

	/**
	 * Dedup identity for one persisted message. A childId is unique per spawn (it is
	 * the run id), and the notice's own timestamp separates two terminal events for
	 * the same child and kind, so the same message written twice is one row.
	 */
	private _undeliveredRlmNoticeKey(message: CustomMessage): string {
		const details = message.details as { childId?: string; kind?: string } | undefined;
		return `${details?.childId ?? "unknown"}:${details?.kind ?? message.customType}:${message.timestamp}`;
	}

	private _readUndeliveredRlmNoticeRows(): UndeliveredRlmNoticeRow[] {
		const path = this.undeliveredRlmNoticeSidecarPath;
		if (!path || !existsSync(path)) return [];
		const rows: UndeliveredRlmNoticeRow[] = [];
		try {
			for (const line of readFileSync(path, "utf8").split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const parsed = JSON.parse(trimmed) as UndeliveredRlmNoticeRow;
				if (parsed && typeof parsed.key === "string" && parsed.message?.role === "custom") rows.push(parsed);
			}
		} catch (error) {
			sessionLog.warn("undelivered rlm notice sidecar is unreadable", {
				sessionId: this.sessionId,
				path,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
		return rows;
	}

	/**
	 * Persist messages that a dispose would otherwise drop (B1 后半 / B10). Written
	 * atomically at 0600 and bounded, so a family failing in a loop cannot grow the
	 * file without limit.
	 */
	private _appendUndeliveredRlmNoticeRows(messages: readonly CustomMessage[]): void {
		if (messages.length === 0) return;
		const path = this.undeliveredRlmNoticeSidecarPath;
		if (!path) return;
		try {
			const existing = this._readUndeliveredRlmNoticeRows();
			const seen = new Set(existing.map((row) => row.key));
			const rows = [...existing];
			for (const message of messages) {
				const key = this._undeliveredRlmNoticeKey(message);
				if (seen.has(key)) continue;
				seen.add(key);
				rows.push({ key, message: cloneCustomMessage(message), writtenAt: Date.now() });
			}
			const bounded = rows.slice(-UNDELIVERED_RLM_NOTICES_MAX_ROWS);
			ensurePrivateDirectory(dirname(path));
			writePrivateFileAtomic(path, `${bounded.map((row) => JSON.stringify(row)).join("\n")}\n`, {
				privateParent: false,
			});
		} catch (error) {
			sessionLog.error("undelivered rlm notice sidecar write failed", {
				sessionId: this.sessionId,
				path,
				count: messages.length,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Reflow sidecar rows into the next-turn queue (idempotent by key) and drop the
	 * file, so a restart of the same session delivers what the previous process
	 * could not. Runs at construction and on every admission resume.
	 */
	private _reflowUndeliveredRlmNotices(): void {
		const rows = this._readUndeliveredRlmNoticeRows();
		if (rows.length === 0) return;
		const known = new Set(this._pendingNextTurnMessages.map((message) => this._undeliveredRlmNoticeKey(message)));
		const restored = rows.filter((row) => !known.has(row.key)).map((row) => row.message);
		if (restored.length > 0) {
			// A restored reply goes ahead of a restored notice: the dispose-time writer
			// emits deferred notices first, and prepending that order would hand the
			// parent a "completed without a reply" report above the reply itself.
			const ordered = [
				...restored.filter((message) => isAgentSessionMessage(message)),
				...restored.filter((message) => !isAgentSessionMessage(message)),
			];
			this._unshiftPendingNextTurnMessages(...ordered);
			for (const message of ordered) this._registerRestoredQueuedChildReply(message);
			sessionLog.info("rlm terminal notices restored from sidecar", {
				sessionId: this.sessionId,
				count: restored.length,
			});
		}
		const path = this.undeliveredRlmNoticeSidecarPath;
		if (!path) return;
		try {
			rmSync(path, { force: true });
		} catch {
			// A stale sidecar is re-read and de-duplicated by key on the next start.
		}
	}

	/**
	 * Re-arm the delivery credit for a queued child reply this session got back from a
	 * restart.
	 *
	 * `_queuedChildReplyBackfills` is in-memory and a dispose clears it, while the reply
	 * itself survives in the persisted queue. Without this the delivery lands with
	 * nothing to credit - and silently, because the "sender session was gone" warning
	 * only fires for an id the ledger still holds.
	 */
	private _registerRestoredQueuedChildReply(message: CustomMessage): void {
		if (!isAgentSessionMessage(message)) return;
		const owedBefore = this._queuedChildReplyBackfills.size;
		this._registerQueuedChildReply(message);
		if (this._queuedChildReplyBackfills.size <= owedBefore) return;
		sessionLog.info("re-armed a queued child reply credit after a session restart", {
			sessionId: this.sessionId,
			messageId: message.details.id,
		});
	}

	/**
	 * Everything a dispose would silently drop: deferred terminal notices and queued
	 * agent-message replies that never reached a turn. Written to the sidecar so the
	 * next start of this session reflows them (B1 后半: without this, "queued" would
	 * be blinder than the old hard failure it replaced).
	 */
	private _persistUndeliveredWorkBeforeDispose(): void {
		const messages: CustomMessage[] = [];
		for (const message of this._pendingNextTurnMessages) {
			if (this._isRlmTerminalNotice(message) || isAgentSessionMessage(message)) messages.push(message);
		}
		for (const action of this._actionStore.unfinishedActions()) {
			if (action.payload.kind !== "turn") continue;
			const message = primaryDeliveryRecord(action).message;
			if (message.role === "custom" && isAgentSessionMessage(message)) messages.push(message);
		}
		this._appendUndeliveredRlmNoticeRows(messages);
	}

	/**
	 * Deferred terminal notices still inside their delivery window.
	 *
	 * Pure on purpose: `isSessionActive` is read by session-list and roster polling,
	 * and a read path must not flush notices, admit a turn action, or discard a
	 * child's terminal report. Equivalent to the old flush-then-recheck shape, which
	 * always ended up false once the threshold had passed. The abandonment itself is
	 * driven by its own timer (see _armRlmTerminalNoticeAbandonTimer), not by whoever
	 * happens to read activity.
	 */
	private _hasActionableDeferredRlmTerminalNotices(): boolean {
		return this._hasDeferredRlmTerminalNotices() && !this._isDeferredRlmTerminalNoticeStale();
	}

	/** Whether the deferred notices have waited past the abandonment threshold. */
	private _isDeferredRlmTerminalNoticeStale(now = Date.now()): boolean {
		const deferredSince = this._rlmTerminalNoticeDeferredSince;
		return deferredSince !== undefined && now - deferredSince >= this._rlmTerminalNoticeAbandonAfterMs;
	}

	/**
	 * The only way messages enter the next-turn queue. Stamping the deferral here makes
	 * "a queued terminal notice always has a timestamp" structural rather than something
	 * each re-injection path has to remember: without a timestamp no abandonment timer is
	 * armed and the staleness predicate never fires, so the session stays pinned forever.
	 *
	 * The guard lives in this one core, not in each directional shell, so it cannot be
	 * half-present: dropping it breaks both the push and the unshift routes at once.
	 */
	private _enqueuePendingNextTurnMessages(messages: readonly CustomMessage[], atFront: boolean): void {
		if (atFront) this._pendingNextTurnMessages.unshift(...messages);
		else this._pendingNextTurnMessages.push(...messages);
		if (messages.some((message) => this._isRlmTerminalNotice(message))) {
			this._markRlmTerminalNoticeDeferred();
		}
	}

	private _pushPendingNextTurnMessages(...messages: CustomMessage[]): void {
		this._enqueuePendingNextTurnMessages(messages, false);
	}

	private _unshiftPendingNextTurnMessages(...messages: CustomMessage[]): void {
		this._enqueuePendingNextTurnMessages(messages, true);
	}

	/**
	 * Remove one queued message by identity. Lives in the mutator core with the two
	 * insertion shells: the aggregated failure wake folds buffered notices out of the
	 * queue and into a single turn, and that removal must not become a third
	 * un-guarded write to the array.
	 */
	private _removePendingNextTurnMessage(message: CustomMessage): boolean {
		const index = this._pendingNextTurnMessages.indexOf(message);
		if (index < 0) return false;
		this._pendingNextTurnMessages.splice(index, 1);
		return true;
	}

	/** Record that terminal notices are deferred, and arm the abandonment driver. */
	private _markRlmTerminalNoticeDeferred(): void {
		this._rlmTerminalNoticeDeferredSince ??= Date.now();
		this._armRlmTerminalNoticeAbandonTimer();
	}

	private _clearRlmTerminalNoticeDeferred(): void {
		this._rlmTerminalNoticeDeferredSince = undefined;
		this._clearRlmTerminalNoticeAbandonTimer();
	}

	/**
	 * Abandonment used to happen only when something read `isSessionActive`, so a
	 * session nobody polled kept its stale notices - and stayed resident - forever.
	 * The timer is unref'd: it must never by itself hold the process open.
	 */
	private _armRlmTerminalNoticeAbandonTimer(): void {
		if (this._rlmTerminalNoticeAbandonTimer !== undefined) return;
		const deferredSince = this._rlmTerminalNoticeDeferredSince;
		const elapsed = deferredSince === undefined ? 0 : Date.now() - deferredSince;
		const waitMs = Math.max(0, this._rlmTerminalNoticeAbandonAfterMs - elapsed);
		const timer = setTimeout(() => {
			this._rlmTerminalNoticeAbandonTimer = undefined;
			this.maybeAbandonStaleDeferredRlmTerminalNotices();
			// Still deferred and not yet abandoned (the flush could not deliver and the
			// threshold was not reached): keep driving instead of going quiet.
			if (this._rlmTerminalNoticeDeferredSince !== undefined) this._armRlmTerminalNoticeAbandonTimer();
		}, waitMs);
		timer.unref?.();
		this._rlmTerminalNoticeAbandonTimer = timer;
	}

	private _clearRlmTerminalNoticeAbandonTimer(): void {
		if (this._rlmTerminalNoticeAbandonTimer !== undefined) {
			clearTimeout(this._rlmTerminalNoticeAbandonTimer);
			this._rlmTerminalNoticeAbandonTimer = undefined;
		}
	}

	private _enqueueRlmTerminalNoticeAction(message: CustomMessage): void {
		this._assertRlmTerminalNotice(message);
		const action = this._createPreparedTurnAction("followUp", message.content as string, undefined, {
			message,
			suppressAutonomousContinuation: true,
			resumeIfIdle: false,
			source: "internal",
			executionPolicy: this._turnExecutionPolicy("injected"),
			queueVisible: false,
		});
		this._durableRlmTerminalNoticeActionIds.add(action.id);
		try {
			const result = this._admitSessionInput(action, { wake: false });
			if (!result.accepted) throw new Error("RLM child terminal notice was not admitted.");
			this._rlmTerminalNoticeAdmissionCount++;
		} catch (error) {
			this._durableRlmTerminalNoticeActionIds.delete(action.id);
			throw error;
		}
	}

	/**
	 * Admit a stall notice as its own turn, the way a terminal notice reaches the
	 * parent: the input pump schedules it once the session is free, so a parent that
	 * is idle when its child goes quiet still gets told instead of finding out
	 * whenever it happens to run next.
	 */
	private _enqueueRlmChildStallNoticeAction(message: CustomMessage): void {
		const action = this._createPreparedTurnAction("followUp", message.content as string, undefined, {
			message,
			suppressAutonomousContinuation: true,
			resumeIfIdle: false,
			source: "internal",
			executionPolicy: this._turnExecutionPolicy("injected"),
			queueVisible: false,
		});
		const result = this._admitSessionInput(action, { wake: false });
		if (!result.accepted) throw new Error("RLM child stall notice was not admitted.");
	}

	/**
	 * Tell the parent (this session) that a direct child has been silent past the
	 * watchdog's warn stage - without killing anything.
	 *
	 * The warn stage used to be roster-only: the sole stall signal a parent model ever
	 * received was the failure notice that a kill produced, so a warn-only watchdog
	 * would have traded a false kill for no signal at all. The notice is the signal;
	 * whether the silence is genuine work or a wedge is the parent's call, and the
	 * parent holds the lever (`rlm.delete_subagent`) for the wedge case.
	 */
	private _notifyRlmChildStall(
		run: RlmChildRun,
		child: AgentSession,
		sessionName: string,
		event: { silentMs: number; thresholdMs: number; diagnostics: StallDiagnostics },
	): void {
		// Same two-flag guard the terminal-notice publication gate uses: a run that is
		// being deleted (detachedDeletion) or whose notices are suppressed must not be
		// pinged - the parent itself asked for this child to go away.
		if (this._disposed || this._disposing || run.detachedDeletion || run.suppressTerminalNotice) return;
		const now = Date.now();
		if (run.lastStallNoticeAt !== undefined && now - run.lastStallNoticeAt < RLM_CHILD_STALL_NOTICE_MIN_INTERVAL_MS) {
			return;
		}
		run.lastStallNoticeAt = now;
		const inFlightTools = event.diagnostics.inFlightToolCalls.map((call) =>
			call.elapsedMs > 0 ? `${call.toolName} (${Math.max(1, Math.round(call.elapsedMs / 1000))}s)` : call.toolName,
		);
		const exemption = event.diagnostics.exemption;
		const workEvidence = exemption !== undefined && exemption.exhausted !== true ? [...exemption.reasons] : [];
		// The deadline that matters is the child's own watchdog - it is the one that can
		// abort the turn - so the notice describes the child's configuration, not the
		// parent's. The two differ whenever a project-scope settings file overrides the
		// global one for one side only.
		const abortAfterMs = child.settingsManager.getStallWatchdogSettings().abortAfterSeconds * 1000;
		const message = createRlmChildStallNoticeMessage({
			childId: run.id,
			sessionName,
			silentMs: event.silentMs,
			thresholdMs: event.thresholdMs,
			inFlightTools,
			...(workEvidence.length > 0 ? { workEvidence } : {}),
			...(abortAfterMs > 0 ? { abortAfterMs } : {}),
		});
		try {
			this._enqueueRlmChildStallNoticeAction(message);
			this._scheduleSessionInputPump();
		} catch (error) {
			// A paused pump (a user dialog, compaction) must not drop the only signal the
			// parent gets; keep the notice for the next turn boundary instead.
			this._pushPendingNextTurnMessages(cloneCustomMessage(message));
			sessionLog.warn("child stall notice deferred to the next turn boundary", {
				sessionId: this.sessionId,
				childId: run.id,
				message: this._asError(error).message,
			});
		}
	}

	private _flushDeferredRlmTerminalNotices(): void {
		if (
			this._sessionInputAdmissionPauses.size > 0 ||
			this._sessionInputPumpSuspended ||
			this._queuedWorkPauses.size > 0 ||
			this._disposed ||
			this._disposing
		) {
			return;
		}
		// A notice that waited here can outlive the verdict it carries: drop the ones a
		// delivery in between disproved before they become actions.
		this._pendingNextTurnMessages = this._filterSupersededRlmTerminalNotices(this._pendingNextTurnMessages);
		while (true) {
			const index = this._pendingNextTurnMessages.findIndex((message) => this._isRlmTerminalNotice(message));
			if (index < 0) break;
			const message = this._pendingNextTurnMessages[index];
			try {
				this._enqueueRlmTerminalNoticeAction(message);
			} catch {
				return;
			}
			this._pendingNextTurnMessages.splice(index, 1);
		}
		if (!this._hasDeferredRlmTerminalNotices()) {
			this._clearRlmTerminalNoticeDeferred();
		}
		this._scheduleSessionInputPump();
	}

	private async _acquireRlmTerminalNoticeRetentionFence(): Promise<{ owner: symbol; release(): void } | undefined> {
		const disposeSignal = this._sessionActionCommitDisposeAbortController.signal;
		while (!this._disposed && !this._disposing && !disposeSignal.aborted) {
			if (this._queuedWorkPauses.size > 0) {
				let wake = () => {};
				const pauseReleased = new Promise<void>((resolve) => {
					wake = resolve;
					this._sessionInputCheckpointWaiters.add(resolve);
				});
				try {
					await waitForPromiseOrAbort(pauseReleased, disposeSignal, "Terminal notice retention cancelled");
				} catch {
					return undefined;
				} finally {
					this._sessionInputCheckpointWaiters.delete(wake);
				}
				continue;
			}
			let fence: { owner: symbol; release(): void };
			try {
				fence = await this._acquireSessionActionCommitFence(disposeSignal);
			} catch {
				return undefined;
			}
			if (this._queuedWorkPauses.size === 0 && !this._disposed && !this._disposing) return fence;
			fence.release();
		}
		return undefined;
	}

	private async _deferRlmTerminalNotice(message: CustomMessage): Promise<void> {
		this._assertRlmTerminalNotice(message);
		const fence = await this._acquireRlmTerminalNoticeRetentionFence();
		if (!fence) return;
		try {
			if (this._disposed || this._disposing) return;
			const deferred = cloneCustomMessage(message);
			this._pushPendingNextTurnMessages(deferred);
			this._flushDeferredRlmTerminalNotices();
			this._maybeBufferFailureWake(deferred);
		} finally {
			fence.release();
		}
	}

	/**
	 * B3/N-3: a failure-class notice that could not be delivered because the pump is
	 * suspended joins the aggregation buffer instead of waking the session by
	 * itself. Ordinary child replies are not buffered: they wait for the next wake,
	 * which is what keeps an Esc meaning "stop".
	 */
	private _maybeBufferFailureWake(message: CustomMessage): void {
		if (message.customType !== RLM_CHILD_FAILURE_CUSTOM_TYPE) return;
		if (!this._sessionInputPumpSuspended || this._sessionInputSuspendedForUpdateRestart) return;
		if (this.settingsManager.getSubagentWakePolicy() === "never") return;
		if (this._pendingFailureWakeNotices.includes(message)) return;
		this._pendingFailureWakeNotices.push(message);
		this._armFailureWakeAggregation();
	}

	private _armFailureWakeAggregation(): void {
		if (this._failureWakeTimer !== undefined) return;
		const timer = setTimeout(() => {
			this._failureWakeTimer = undefined;
			this._deliverAggregatedFailureWake();
		}, FAILURE_WAKE_AGGREGATION_MS);
		timer.unref?.();
		this._failureWakeTimer = timer;
	}

	private _armFailureWakeFlushRetry(): void {
		if (this._failureWakeFlushTimer !== undefined) return;
		const timer = setTimeout(() => {
			this._failureWakeFlushTimer = undefined;
			if (this._disposed || this._disposing) return;
			// Delivers as soon as the pump is runnable again; otherwise keeps
			// re-offering so a revived pump never waits on a notice nobody retries.
			this._flushDeferredRlmTerminalNotices();
			if (!this._hasDeferredRlmTerminalNotices()) return;
			if (this._sessionInputPumpSuspended && this._pendingFailureWakeNotices.length > 0) {
				this._deliverAggregatedFailureWake();
				return;
			}
			this._armFailureWakeFlushRetry();
		}, RLM_TERMINAL_NOTICE_FLUSH_RETRY_MS);
		timer.unref?.();
		this._failureWakeFlushTimer = timer;
	}

	private _clearFailureWakeTimers(): void {
		if (this._failureWakeTimer !== undefined) {
			clearTimeout(this._failureWakeTimer);
			this._failureWakeTimer = undefined;
		}
		if (this._failureWakeFlushTimer !== undefined) {
			clearTimeout(this._failureWakeFlushTimer);
			this._failureWakeFlushTimer = undefined;
		}
	}

	/**
	 * One wake for a family of failures.
	 *
	 * The wake itself is pump-level - `wakeSuspendedSessionInput` resumes admission
	 * and schedules the pump, it cannot be filtered per message - so the buffered
	 * notices are folded into a SINGLE turn first: they ride along as prefix
	 * messages and the turn text states the aggregate. Waking first would release
	 * every queued notice as its own turn, which is exactly the N-turn re-ignition
	 * an Esc is supposed to prevent (F11: the "one wake releases the whole backlog"
	 * semantics of the pump is unchanged and stays documented).
	 */
	private _deliverAggregatedFailureWake(): void {
		if (this._disposed || this._disposing) return;
		if (!this._sessionInputPumpSuspended || this._sessionInputSuspendedForUpdateRestart) {
			// The pump came back on its own: ordinary delivery handles everything.
			this._pendingFailureWakeNotices.length = 0;
			this._flushDeferredRlmTerminalNotices();
			return;
		}
		const buffered = this._pendingFailureWakeNotices.splice(0, this._pendingFailureWakeNotices.length);
		if (buffered.length === 0) {
			this._armFailureWakeFlushRetry();
			return;
		}
		const suspendedSince = this._sessionInputSuspendedSince;
		const withinQuietWindow =
			suspendedSince !== undefined && Date.now() - suspendedSince <= this._failureWakeQuietWindowMs;
		if (
			this.settingsManager.getSubagentWakePolicy() === "never" ||
			this._failureWakeUsedForSuspension ||
			!withinQuietWindow
		) {
			// Past the total gate (or policy forbids waking): stop re-igniting the
			// session. The notices stay deferred for the persistence path and the
			// flush timer keeps re-offering them to a pump that revives on its own.
			this._pendingFailureWakeNotices.push(...buffered);
			sessionLog.info("rlm failure wake suppressed", {
				sessionId: this.sessionId,
				count: buffered.length,
				policy: this.settingsManager.getSubagentWakePolicy(),
				alreadyWoke: this._failureWakeUsedForSuspension,
				withinQuietWindow,
			});
			this._armFailureWakeFlushRetry();
			return;
		}
		// Fold the buffered notices out of the next-turn queue into one turn so the
		// wake cannot fan them out into one turn per failure.
		const notices = buffered.filter((message) => this._removePendingNextTurnMessage(message));
		if (notices.length === 0) {
			this._armFailureWakeFlushRetry();
			return;
		}
		const summary = aggregatedFailureWakeText(notices);
		const action = this._createPreparedTurnAction("followUp", summary, undefined, {
			prefixMessages: notices,
			suppressAutonomousContinuation: true,
			resumeIfIdle: false,
			source: "internal",
			executionPolicy: this._turnExecutionPolicy("injected"),
			queueVisible: false,
		});
		this._durableRlmTerminalNoticeActionIds.add(action.id);
		try {
			const result = this._admitSessionInput(action, { wake: false });
			if (!result.accepted) throw new Error("Aggregated RLM failure wake was not admitted.");
		} catch (error) {
			this._durableRlmTerminalNoticeActionIds.delete(action.id);
			// Put them back so the persistence path still sees every notice.
			this._unshiftPendingNextTurnMessages(...notices);
			this._pendingFailureWakeNotices.push(...notices);
			sessionLog.warn("rlm failure wake aggregation failed", {
				sessionId: this.sessionId,
				count: notices.length,
				error: error instanceof Error ? error.message : String(error),
			});
			this._armFailureWakeFlushRetry();
			return;
		}
		this._failureWakeUsedForSuspension = true;
		// Countable signature for "one Esc, one aggregated wake".
		sessionLog.info("rlm failure wake aggregated", {
			sessionId: this.sessionId,
			count: notices.length,
			childIds: notices.map((notice) => (notice.details as { childId?: string } | undefined)?.childId),
			sinceAbortMs: suspendedSince === undefined ? undefined : Date.now() - suspendedSince,
		});
		// The folded notices left the queue, but anything still deferred (a routine
		// completed_without_reply, say) must keep its stamp and its abandonment
		// driver: clearing unconditionally here would strand it forever, which both
		// pins the session (FIX-Q2) and makes it undroppable (FIX-Q4).
		if (this._hasDeferredRlmTerminalNotices()) this._markRlmTerminalNoticeDeferred();
		else this._clearRlmTerminalNoticeDeferred();
		this.wakeSuspendedSessionInput();
	}

	private _demoteRlmTerminalNoticeActions(): void {
		const actions = this._actionStore
			.clearableActions()
			.filter((action) => this._durableRlmTerminalNoticeActionIds.has(action.id));
		if (actions.length === 0) return;
		for (const action of actions) {
			if (!this._isRlmTerminalNoticeAction(action)) continue;
			const message = primaryDeliveryRecord(action).message;
			if (message.role === "custom") this._pushPendingNextTurnMessages(cloneCustomMessage(message));
		}
		const ids = new Set(actions.map((action) => action.id));
		this._cancelSessionActions(
			(action) => ids.has(action.id),
			new Error("RLM child terminal notice deferred across session input suspension."),
			actions,
		);
		for (const id of ids) this._durableRlmTerminalNoticeActionIds.delete(id);
	}

	/**
	 * The kernel read the command's result before the notice reached the model, so
	 * the notice has nothing left to report: drop it while it is still queued.
	 * Delivered notices are no longer clearable, which makes this a no-op.
	 */
	private _withdrawAsyncBashCompletionNotice(details: { pid: number; command: string }): void {
		// One read withdraws one notice: pid reuse can queue an identical key twice,
		// and the read belongs to the older handle, which is the earlier notice.
		const notice = this._actionStore
			.clearableActions()
			.find((action) => this._isAsyncBashCompletionActionFor(action, details));
		if (!notice) return;
		this._cancelSessionActions(
			(action) => action === notice,
			new Error("Background command completion notice withdrawn: the kernel read the result first."),
		);
		this._emitQueueUpdate();
	}

	private _isAsyncBashCompletionActionFor(
		action: QueuedSessionAction,
		details: { pid: number; command: string },
	): boolean {
		if (action.payload.kind !== "turn") return false;
		const message = primaryDeliveryRecord(action).message;
		if (message.role !== "custom" || message.customType !== ASYNC_BASH_COMPLETION_CUSTOM_TYPE) return false;
		// pids are reused across handles, so the command has to match too.
		const completion = message.details as AsyncBashCompletionDetails | undefined;
		return completion?.pid === details.pid && completion.command === details.command;
	}

	private async _promptInjectedMessage(
		text: string,
		message: CustomMessage,
		options?: InternalPromptOptions & { executionPolicy?: TurnExecutionPolicy },
	): Promise<AgentHeartbeatPromptResult> {
		// Never lift the update-restart fence: injected work (heartbeats) must stay
		// queued for the restart manifest instead of starting a turn during teardown.
		if (!this.isStreaming && options?.resumeIfIdle && !this._sessionInputSuspendedForUpdateRestart) {
			this._resumeSessionInputAdmission();
		}
		const admissionEpoch = this._sessionInputPumpEpoch;
		const admissionFence = await this._acquireDirectTurnAdmissionFence(options?.signal).catch((error: unknown) => {
			throwIfPromptAdmissionCancelled(options?.signal);
			throw error;
		});
		const reportPreflight = oncePreflight(options?.preflightResult);
		try {
			throwIfPromptAdmissionCancelled(options?.signal);
			if (admissionEpoch !== this._sessionInputPumpEpoch) {
				throw new Error("Injected session input was invalidated before admission");
			}
			options?.admissionCommitted?.();
			const queueForStreaming = this.isStreaming;
			const queueForBusy = options?.queueIfBusy === true && this._isBusyForSessionInput("preflight");
			const visibleQueued = queueForStreaming || queueForBusy;
			if (visibleQueued && !options?.streamingBehavior) {
				const stateDescription = queueForStreaming ? "Agent is already processing" : "Agent has queued work";
				throw new Error(
					`${stateDescription}. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`,
				);
			}
			const schedule = options?.streamingBehavior ?? "followUp";
			const prefixMessages = visibleQueued ? this._takePendingNextTurnMessages() : undefined;
			const action = this._createPreparedTurnAction(schedule, text, undefined, {
				message,
				prefixMessages,
				queueKey: options?.followUpQueueKey,
				previewLabel: injectedMessagePreviewLabel(message),
				suppressAutonomousContinuation: options?.suppressAutonomousContinuation,
				resumeIfIdle:
					!visibleQueued ||
					options?.resumeIfIdle ||
					(options?.queueIfBusy === true && canSelectSessionAction(this._runtimeActivity())),
				source: options?.source ?? "internal",
				executionPolicy:
					options?.executionPolicy ??
					(visibleQueued ? this._turnExecutionPolicy("queued") : this._turnExecutionPolicy("injected")),
				queueVisible: visibleQueued,
			});
			const result = this._admitSessionInput(action, {
				immediatelyEligible: !visibleQueued,
			});
			admissionFence.release();
			if (!result.accepted || !result.ticket) {
				if (prefixMessages) this._unshiftPendingNextTurnMessages(...prefixMessages);
				reportPreflight(false, false);
				// G5 (r37 hbgoal-ts): a coalesced or rejected follow-up created no new
				// action; report that so the cron dispatch can record a skip instead
				// of counting a run that never happened.
				return { admitted: false, coalesced: true };
			}
			if (result.disposition === "queued") {
				reportPreflight(true, true);
			} else {
				void result.ticket.delivered.then(
					() => reportPreflight(true),
					() => reportPreflight(false),
				);
			}
			if (options?.returnAfterAccepted) {
				if (result.disposition === "starts_when_admitted") await result.ticket.delivered;
				return { admitted: true, coalesced: false };
			}
			if (visibleQueued) return { admitted: true, coalesced: false };
			await result.ticket.completed;
			return { admitted: true, coalesced: false };
		} catch (error) {
			reportPreflight(false);
			throw error;
		} finally {
			admissionFence.release();
		}
	}

	private async _prompt(text: string, options?: InternalPromptOptions): Promise<void> {
		const resumeSuspendedInput = options?.resumeIfIdle !== false;
		if (!this.isStreaming) {
			// QP-1 (r39): never let an idle resume lift the update-restart fence - a
			// direct prompt during teardown must hit the admission refusal (mirrors
			// the sendCustomMessage triggerTurn guard) instead of reviving the pump
			// and draining the backlog that the restart manifest owns.
			if (resumeSuspendedInput && !this._sessionInputSuspendedForUpdateRestart) {
				this._resumeSessionInputAdmission();
			}
			this._assertSessionActionAdmissionAvailable();
		}
		const admissionEpoch = this._sessionInputPumpEpoch;
		const commitFence = this.isStreaming
			? undefined
			: await this._acquireDirectTurnAdmissionFence(options?.signal).catch((error: unknown) => {
					throwIfPromptAdmissionCancelled(options?.signal);
					throw error;
				});
		const reportPreflight = oncePreflight(options?.preflightResult);
		const run = async () => {
			try {
				throwIfPromptAdmissionCancelled(options?.signal);
				if (!resumeSuspendedInput && admissionEpoch !== this._sessionInputPumpEpoch) {
					throw new Error("Session input was invalidated before admission");
				}
				options?.admissionCommitted?.();
				const isInternalPrompt = options?.internalPrompt === true;
				const expandPromptTemplates = isInternalPrompt ? false : (options?.expandPromptTemplates ?? true);
				const normalizationResult = this._normalizeSubmission(text, options?.images, {
					parseSessionCommands: !isInternalPrompt && !options?.skipPrePromptWork,
					extensionCommands: expandPromptTemplates ? "execute" : "ignore",
					inputSource:
						!isInternalPrompt && !options?.skipInputHandlers ? (options?.source ?? "interactive") : undefined,
					expandSkills: expandPromptTemplates,
					expandPromptTemplates,
				});
				const normalized = normalizationResult instanceof Promise ? await normalizationResult : normalizationResult;
				// Async input handlers ran between the admission check above and
				// admission itself; re-check so content invalidated during that
				// await (e.g. a cron job cancelled or updated) is not admitted.
				if (normalizationResult instanceof Promise) options?.admissionCommitted?.();
				if (normalized.kind === "extensionCommand") {
					commitFence?.release();
					reportPreflight(true);
					void normalized.completion.then(
						() => this._settleAgentMessage(options?.agentMessageId, "completion"),
						(error) => this._settleAgentMessage(options?.agentMessageId, "completion", error),
					);
					void normalized.completion.catch(() => undefined);
					if (!options?.returnAfterAccepted) await normalized.completion.catch(() => undefined);
					return;
				}
				if (normalized.kind === "handled") {
					commitFence?.release();
					reportPreflight(true);
					this._settleAgentMessage(options?.agentMessageId, "completion");
					return;
				}

				const pendingOwnedWork = this._actionStore.unfinishedActions().length > 0;
				const wasRuntimeBusy = this.isStreaming || this.isCompacting || this.isRetrying || this.isBashRunning;
				const wasBusy = wasRuntimeBusy || pendingOwnedWork;
				if (normalized.kind === "sessionCommand") {
					const schedule = options?.streamingBehavior ?? (this.isStreaming ? "steer" : "followUp");
					const action = this._createSessionCommandAction(
						normalized.text,
						normalized.command,
						normalized.images,
						schedule,
						{
							agentMessageId: options?.agentMessageId,
							source: isInternalPrompt ? "internal" : (options?.source ?? "interactive"),
						},
					);
					const result = this._admitSessionInput(action, {
						immediatelyEligible: !wasBusy && this._canStartSessionActionImmediately(),
					});
					commitFence?.release();
					reportPreflight(result.accepted, result.disposition === "queued");
					if (!result.accepted || !result.ticket) return;
					if (options?.returnAfterAccepted) {
						if (result.disposition === "starts_when_admitted") await result.ticket.delivered;
						return;
					}
					if (result.disposition === "queued") return;
					await this.waitForSessionInputIdle();
					return;
				}

				const queueForStreaming = this.isStreaming;
				const queueForBusy = options?.queueIfBusy === true && this._isBusyForSessionInput("preflight");
				const visibleQueued = queueForStreaming || queueForBusy;
				if (visibleQueued && !options?.streamingBehavior) {
					const stateDescription = queueForStreaming ? "Agent is already processing" : "Agent has queued work";
					throw new Error(
						`${stateDescription}. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`,
					);
				}
				const schedule = options?.streamingBehavior ?? "followUp";
				const prefixMessages = visibleQueued ? this._takePendingNextTurnMessages() : undefined;
				const content = options?.content
					? options.content.map((block) => ({ ...block }))
					: this._buildPromptContent(normalized.text, normalized.images);
				const suppliedMessage = options?.customMessage;
				const primaryMessage = suppliedMessage
					? visibleQueued
						? suppliedMessage
						: cloneCustomMessage(suppliedMessage)
					: ({
							role: "user",
							content: content.map((block) => ({ ...block })),
							timestamp: Date.now(),
						} satisfies UserMessage);
				const acceptedAgentMessage = options?.skipPrePromptWork === true && options.returnAfterAccepted === true;
				const action = this._createPreparedTurnAction(schedule, normalized.text, normalized.images, {
					agentMessageId: options?.agentMessageId,
					queueKey: options?.followUpQueueKey,
					content,
					message: primaryMessage,
					prefixMessages,
					suppressAutonomousContinuation: options?.suppressAutonomousContinuation,
					resumeIfIdle:
						!visibleQueued ||
						options?.resumeIfIdle ||
						(options?.queueIfBusy === true && canSelectSessionAction(this._runtimeActivity())),
					source: isInternalPrompt ? "internal" : (options?.source ?? "interactive"),
					executionPolicy: visibleQueued
						? this._turnExecutionPolicy("queued")
						: this._turnExecutionPolicy("directPrompt", {
								returnAfterAccepted: options?.returnAfterAccepted,
								skipPrePromptWork: options?.skipPrePromptWork,
							}),
					queueVisible: visibleQueued,
					acceptedAgentMessage,
					acceptedBeforeCompletion: options?.returnAfterAccepted === true,
				});
				if (action.suppressAutonomousContinuation) {
					this._markAutonomousContinuationSuppressed(primaryDeliveryRecord(action).message);
				}
				const result = this._admitSessionInput(action, {
					immediatelyEligible: !visibleQueued && this._canStartSessionActionImmediately(),
				});
				commitFence?.release();
				if (!result.accepted || !result.ticket) {
					if (prefixMessages) this._unshiftPendingNextTurnMessages(...prefixMessages);
					reportPreflight(false, false);
					return;
				}
				if (result.disposition === "queued") {
					reportPreflight(true, true);
				} else {
					void result.ticket.delivered.then(
						() => reportPreflight(true),
						() => reportPreflight(false),
					);
				}
				const deferralObserver =
					acceptedAgentMessage &&
					options?.queueIfBusy === true &&
					!options.streamingBehavior &&
					result.disposition === "starts_when_admitted"
						? this._observeSessionActionDeferral(action)
						: undefined;
				if (acceptedAgentMessage && !queueForStreaming && !queueForBusy && !options?.streamingBehavior) {
					try {
						const outcome = deferralObserver
							? await Promise.race([
									result.ticket.delivered.then(() => "delivered" as const),
									deferralObserver.deferred.then(() => "deferred" as const),
								])
							: await result.ticket.delivered.then(() => "delivered" as const);
						if (outcome === "deferred" && !options?.streamingBehavior) {
							const error = new Error(
								"Agent became busy before prompt delivery. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
							);
							this._rejectAgentMessage(action.agentMessageId, error);
							this._cancelSessionActions((candidate) => candidate === action, error);
							this._emitQueueUpdate();
							throw error;
						}
						return;
					} finally {
						deferralObserver?.stop();
					}
				}
				if (options?.returnAfterAccepted) {
					if (result.disposition === "starts_when_admitted" || (acceptedAgentMessage && !visibleQueued)) {
						await result.ticket.delivered;
					}
					return;
				}
				if (visibleQueued) return;
				await result.ticket.completed;
				await this.waitForSessionInputIdle();
			} catch (error) {
				reportPreflight(false);
				throw error;
			} finally {
				commitFence?.release();
			}
		};
		return commitFence ? this._sessionActionCommitContext.run(commitFence.owner, run) : run();
	}

	private _executeExtensionCommand(text: string): Promise<void> | undefined {
		const parsed = parseSlashCommand(text);
		if (!parsed) return undefined;
		const commandName = parsed.name;
		const args = parsed.args;

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return undefined;
		const context = this._extensionRunner.createCommandContext(command.sourceInfo.path);
		return Promise.resolve()
			.then(() => command.handler(args, context))

			.catch((error: unknown) => {
				const commandError = error instanceof Error ? error : new Error(String(error));
				this._extensionRunner.emitError({
					extensionPath: `command:${commandName}`,
					event: "command",
					error: commandError.message,
				});
				throw commandError;
			});
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const parsed = parseSlashCommand(text);
		if (!parsed?.name.startsWith("skill:")) return text;
		const skillName = parsed.name.slice("skill:".length);
		const args = parsed.args;

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			resumeIfIdle?: boolean;
		} = {},
	): Promise<void> {
		const normalized = this._normalizeSubmission(text, images, {
			parseSessionCommands: false,
			extensionCommands: "reject",
			expandSkills: true,
			expandPromptTemplates: true,
		});
		if (normalized instanceof Promise || normalized.kind !== "prompt") {
			throw new Error("Queued prompt normalization did not produce a prompt");
		}

		await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			resumeIfIdle: options.resumeIfIdle,
		});
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			resumeIfIdle?: boolean;
		} = {},
	): Promise<boolean> {
		const normalized = this._normalizeSubmission(text, images, {
			parseSessionCommands: false,
			extensionCommands: "reject",
			expandSkills: true,
			expandPromptTemplates: true,
		});
		if (normalized instanceof Promise || normalized.kind !== "prompt") {
			throw new Error("Queued prompt normalization did not produce a prompt");
		}

		return this._queuePreparedPrompt("followUp", normalized.text, normalized.images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			resumeIfIdle: options.resumeIfIdle,
		});
	}

	async restoreSessionActions(snapshot: SessionActionRecoverySnapshot): Promise<number> {
		if (snapshot.formatVersion !== SESSION_ACTION_RECOVERY_FORMAT_VERSION) {
			throw new Error(`Unsupported session action recovery format version: ${snapshot.formatVersion}`);
		}
		const actionIds = new Set(this._actionStore.ownedActions().map((action) => action.id));
		const actions = snapshot.actions.map((recovered): QueuedSessionAction => {
			if (actionIds.has(recovered.id)) throw new Error(`Duplicate session action id: ${recovered.id}`);
			actionIds.add(recovered.id);
			if (
				recovered.payload.kind === "turn" &&
				recovered.payload.records.some((record) => record.ownerActionId !== recovered.id)
			) {
				throw new Error(`Session action ${recovered.id} has invalid delivery correlation`);
			}
			const payload: PreparedTurnPayload | PreparedCommandPayload =
				recovered.payload.kind === "turn"
					? {
							kind: "turn",
							text: recovered.payload.text,
							...(recovered.payload.preview ? { preview: recovered.payload.preview } : {}),
							records: recovered.payload.records.map((record) => ({
								id: record.id,
								role: record.role,
								message: cloneQueuedAgentMessage(record.message),
								started: false,
								durable: false,
								ownerActionId: record.ownerActionId,
							})),
							...(recovered.payload.images
								? {
										images: recovered.payload.images.map((image) => ({
											...image,
										})),
									}
								: {}),
							...(recovered.payload.content
								? {
										content: recovered.payload.content.map((block) => ({
											...block,
										})),
									}
								: {}),
							...(recovered.payload.customMessage
								? {
										customMessage: cloneCustomMessage(recovered.payload.customMessage),
									}
								: {}),
							executionPolicy: {
								...recovered.payload.executionPolicy,
								preparation: {
									...recovered.payload.executionPolicy.preparation,
								},
							},
							queueVisible: recovered.payload.queueVisible,
							acceptedAgentMessage: recovered.payload.acceptedAgentMessage,
							acceptedBeforeCompletion: recovered.payload.acceptedBeforeCompletion,
						}
					: {
							kind: "session_command",
							text: recovered.payload.text,
							command: { ...recovered.payload.command },
							...(recovered.payload.images
								? {
										images: recovered.payload.images.map((image) => ({
											...image,
										})),
									}
								: {}),
						};
			return {
				id: recovered.id,
				source: recovered.source,
				delivery: recovered.delivery,
				wake: recovered.wake,
				payload,
				lifecycle: { state: "queued" },
				...(recovered.queueKey ? { queueKey: recovered.queueKey } : {}),
				...(recovered.agentMessageId ? { agentMessageId: recovered.agentMessageId } : {}),
				...(recovered.suppressAutonomousContinuation ? { suppressAutonomousContinuation: true } : {}),
			};
		});
		for (const action of actions) {
			const durableTerminalNotice = this._isRlmTerminalNoticeAction(action);
			if (durableTerminalNotice) this._durableRlmTerminalNoticeActionIds.add(action.id);
			try {
				this._admitSessionInput(action, { restore: true });
			} catch (error) {
				if (durableTerminalNotice) this._durableRlmTerminalNoticeActionIds.delete(action.id);
				throw error;
			}
			// A restored queue entry is still a reply somebody is owed a credit for.
			const restoredMessage = action.payload.kind === "turn" ? action.payload.customMessage : undefined;
			if (restoredMessage) this._registerRestoredQueuedChildReply(restoredMessage);
		}
		return actions.length;
	}

	private _restoreSessionCommand(
		text: string,
		customMessage: CustomMessage | undefined,
		images: ImageContent[] | undefined,
		schedule: SessionInputSchedule,
		agentMessageId: string | undefined,
	): boolean | undefined {
		if (!isSessionSlashCommandMessage(customMessage) || text !== customMessage.details.command.text) {
			return undefined;
		}
		return this._admitSessionInput(
			this._createSessionCommandAction(text, customMessage.details.command, images, schedule, {
				agentMessageId,
				source: "internal",
			}),
			{ restore: true },
		).accepted;
	}

	private async _restorePromptInput(schedule: SessionInputSchedule, snapshot: RestoredPromptInput): Promise<boolean> {
		const queued = await this._queuePreparedPrompt(schedule, snapshot.text, snapshot.images, {
			queueKey: snapshot.queueKey,
			agentMessageId: snapshot.agentMessageId,
			content: snapshot.content,
			message: snapshot.customMessage,
			prefixMessages: snapshot.prefixMessages,
			source: "internal",
			// The snapshot already captured this action, so admission-pause leases
			// (QP-2, r39) must not refuse the restore; coalesce still dedupes it.
			admissionPauseExempt: true,
			// Restored input replays the order it was admitted in.
			preserveOrder: true,
		});
		// Same debt as the sidecar reflow: the queue survived, the ledger did not.
		if (queued && snapshot.customMessage) this._registerRestoredQueuedChildReply(snapshot.customMessage);
		return queued;
	}

	async restoreSteeringMessage(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
		} = {},
	): Promise<void> {
		if (
			this._restoreSessionCommand(text, options.customMessage, images, "steer", options.agentMessageId) !== undefined
		)
			return;

		await this._restorePromptInput("steer", {
			text,
			images,
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			content: options.content,
			customMessage: options.customMessage,
			prefixMessages: options.prefixMessages,
		});
	}

	async restoreFollowUpMessage(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
		} = {},
	): Promise<boolean> {
		const restoredCommand = this._restoreSessionCommand(
			text,
			options.customMessage,
			images,
			"followUp",
			options.agentMessageId,
		);
		if (restoredCommand !== undefined) return restoredCommand;

		return this._restorePromptInput("followUp", {
			text,
			images,
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			content: options.content,
			customMessage: options.customMessage,
			prefixMessages: options.prefixMessages,
		});
	}

	private _buildPromptContent(text: string, images?: ImageContent[]): (TextContent | ImageContent)[] {
		const content: (TextContent | ImageContent)[] = [];
		content.push({ type: "text", text });
		if (images) content.push(...images);
		return content;
	}

	private _takePendingNextTurnMessages(): CustomMessage[] {
		const messages = this._pendingNextTurnMessages;
		this._pendingNextTurnMessages = [];
		return messages;
	}

	private _deliveryPolicy(schedule: SessionInputSchedule): DeliveryPolicy {
		return schedule === "steer" ? "next_turn_boundary" : "when_run_idle";
	}

	private _createDeliveryRecord(
		actionId: string,
		role: DeliveryRecord["role"],
		message: QueuedAgentMessage,
	): DeliveryRecord {
		return {
			id: randomUUID(),
			role,
			message,
			started: false,
			durable: false,
			ownerActionId: actionId,
		};
	}

	private _turnExecutionPolicy(
		kind: "queued" | "directPrompt" | "injected" | "customTrigger",
		options: {
			returnAfterAccepted?: boolean;
			skipPrePromptWork?: boolean;
		} = {},
	): TurnExecutionPolicy {
		if (kind === "queued") {
			return {
				preparation: {
					initialRefineBarrier: "skip",
					flushPendingBashBeforeValidation: false,
					validateModelAndAuth: true,
					awaitPendingModelSelection: true,
					preTurnCompaction: "beforeModelSelection",
					finalRefineBarrier: "always",
				},
				runBeforeAgentStart: true,
				nextTurnContextTiming: "commit",
				preserveEmptyExtensionPrompt: true,
				completionIncludesRetryChain: true,
			};
		}
		if (kind === "directPrompt") {
			return {
				preparation: {
					initialRefineBarrier: options.returnAfterAccepted ? "skip" : "always",
					flushPendingBashBeforeValidation: true,
					validateModelAndAuth: true,
					awaitPendingModelSelection: true,
					preTurnCompaction: options.skipPrePromptWork ? "skip" : "afterModelSelection",
					finalRefineBarrier: "ifInFlight",
				},
				runBeforeAgentStart: !options.skipPrePromptWork,
				nextTurnContextTiming: "preparation",
				preserveEmptyExtensionPrompt: false,
				completionIncludesRetryChain: true,
			};
		}
		if (kind === "injected") {
			return {
				preparation: {
					initialRefineBarrier: "always",
					flushPendingBashBeforeValidation: true,
					validateModelAndAuth: true,
					awaitPendingModelSelection: true,
					preTurnCompaction: "beforeModelSelection",
					finalRefineBarrier: "ifInFlight",
				},
				runBeforeAgentStart: true,
				nextTurnContextTiming: "preparation",
				preserveEmptyExtensionPrompt: true,
				completionIncludesRetryChain: true,
			};
		}
		return {
			preparation: {
				initialRefineBarrier: "always",
				flushPendingBashBeforeValidation: false,
				validateModelAndAuth: false,
				awaitPendingModelSelection: false,
				preTurnCompaction: "skip",
				finalRefineBarrier: "skip",
			},
			runBeforeAgentStart: false,
			nextTurnContextTiming: "skip",
			preserveEmptyExtensionPrompt: false,
			completionIncludesRetryChain: false,
		};
	}

	private _createPreparedTurnAction(
		schedule: SessionInputSchedule,
		text: string,
		images: ImageContent[] | undefined,
		options: {
			agentMessageId?: string;
			queueKey?: string;
			content?: (TextContent | ImageContent)[];
			message?: QueuedAgentMessage;
			prefixMessages?: CustomMessage[];
			previewLabel?: string;
			suppressAutonomousContinuation?: boolean;
			resumeIfIdle?: boolean;
			source?: InputSource | "internal";
			executionPolicy?: TurnExecutionPolicy;
			queueVisible?: boolean;
			acceptedAgentMessage?: boolean;
			acceptedBeforeCompletion?: boolean;
		},
	): QueuedSessionAction {
		const id = randomUUID();
		const content = options.content ?? this._buildPromptContent(text, images);
		const message =
			options.message ??
			({
				role: "user",
				content: content.map((block) => ({ ...block })),
				timestamp: Date.now(),
			} satisfies UserMessage);
		const prefixMessages = options.prefixMessages?.map((prefix) => cloneCustomMessage(prefix)) ?? [];
		const preview = options.previewLabel ? `${options.previewLabel}: ${text}` : undefined;
		const payload: PreparedTurnPayload = {
			kind: "turn",
			text,
			records: [
				...prefixMessages.map((prefix) => this._createDeliveryRecord(id, "prefix", prefix)),
				this._createDeliveryRecord(id, "primary", message),
			],
			preview,
			images: images?.map((image) => ({ ...image })),
			content: content.map((block) => ({ ...block })),
			customMessage: options.message?.role === "custom" ? cloneCustomMessage(options.message) : undefined,
			executionPolicy: options.executionPolicy ?? this._turnExecutionPolicy("queued"),
			queueVisible: options.queueVisible ?? true,
			acceptedAgentMessage: options.acceptedAgentMessage ?? false,
			acceptedBeforeCompletion: options.acceptedBeforeCompletion ?? false,
		};
		const source = options.source ?? "internal";
		return {
			id,
			source,
			delivery: this._deliveryPolicy(schedule),
			wake:
				options.resumeIfIdle === true
					? "immediate"
					: schedule === "steer"
						? "on_lower_boundary"
						: "external_resume",
			payload,
			lifecycle: { state: "queued" },
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			suppressAutonomousContinuation: options.suppressAutonomousContinuation,
		};
	}

	private _createSessionCommandAction(
		text: string,
		command: SessionSlashCommand,
		images: ImageContent[] | undefined,
		schedule: SessionInputSchedule,
		options: {
			agentMessageId?: string;
			source?: InputSource | "internal";
		} = {},
	): QueuedSessionAction {
		const source = options.source ?? "internal";
		return {
			id: randomUUID(),
			source,
			delivery: this._deliveryPolicy(schedule),
			wake: "immediate",
			payload: { kind: "session_command", text, command, images },
			lifecycle: { state: "queued" },
			agentMessageId: options.agentMessageId,
		};
	}

	private _coalescedFollowUpOwner(action: QueuedSessionAction): QueuedSessionAction | undefined {
		if (action.delivery !== "when_run_idle" || action.payload.kind !== "turn" || !action.queueKey) return undefined;
		return this._actionStore
			.unfinishedActions()
			.find(
				(candidate) =>
					candidate.queueKey === action.queueKey &&
					(candidate.lifecycle.state === "queued" ||
						candidate.lifecycle.state === "selected" ||
						candidate.lifecycle.state === "preparing"),
			);
	}

	/**
	 * The same-key owner in the committing window (QP-3, r39): the prompt has been
	 * handed to the agent, so a new same-key admission is refused as retryable
	 * instead of queueing a duplicate that would also deliver.
	 */
	private _committingFollowUpOwner(action: QueuedSessionAction): QueuedSessionAction | undefined {
		if (action.delivery !== "when_run_idle" || action.payload.kind !== "turn" || !action.queueKey) return undefined;
		return this._actionStore
			.unfinishedActions()
			.find((candidate) => candidate.queueKey === action.queueKey && candidate.lifecycle.state === "committing");
	}

	private _assertSessionActionAdmissionAvailable(): void {
		if (this._disposed || this._disposing) {
			throw new Error("Cannot admit a session action because the session is disposing or disposed.");
		}
		// Fence first: a direct (non-queueing) caller during update-restart teardown
		// keeps the fence-specific SessionInputSuspendedError diagnosis (the manifest
		// owns the queue; retrying cannot wake this session). Then the pause leases
		// (QP-2, r39 retryable refusal), then the ordinary abort suspension.
		// Queueing callers never get here: _admitSessionInput's own pause check
		// refuses them with the retryable error instead.
		if (this._sessionInputPumpSuspended && this._sessionInputSuspendedForUpdateRestart) {
			throw new SessionInputSuspendedError({
				queuedActionCount: this.unfinishedActionCount,
				suspendedForUpdateRestart: true,
			});
		}
		if (this._sessionInputAdmissionPauses.size > 0) {
			throw new SessionInputAdmissionPausedError({
				pausedCount: this._sessionInputAdmissionPauses.size,
				forUpdateRestart: this._anySessionInputPauseForUpdateRestart(),
			});
		}
		if (this._sessionInputPumpSuspended) {
			throw new SessionInputSuspendedError({
				queuedActionCount: this.unfinishedActionCount,
				suspendedForUpdateRestart: false,
			});
		}
	}

	private _admitSessionInput(
		action: QueuedSessionAction,
		options: {
			restore?: boolean;
			/** QP-2 (r39): a manifest restore re-admits captured work; pause leases do not refuse it. */
			admissionPauseExempt?: boolean;
			front?: boolean;
			preserveOrder?: boolean;
			wake?: boolean;
			immediatelyEligible?: boolean;
		} = {},
	): {
		accepted: boolean;
		disposition: "starts_when_admitted" | "queued";
		ticket?: ActionTicket;
	} {
		if (this._disposed || this._disposing) {
			throw new Error("Cannot admit a session action because the session is disposing or disposed.");
		}
		// QP-2 (r39): typed and retryable, so an agent-message sender whose reply
		// lands in a pause window (MCP reload, ACP stop, update-restart teardown)
		// does not burn its message id as uncertain and is told to retry later.
		// Restores are exempt: they re-admit actions the restart manifest already
		// captured, so they are the recovery source rather than a new admission.
		if (
			options.restore !== true &&
			options.admissionPauseExempt !== true &&
			this._sessionInputAdmissionPauses.size > 0
		) {
			throw new SessionInputAdmissionPausedError({
				pausedCount: this._sessionInputAdmissionPauses.size,
				forUpdateRestart: this._anySessionInputPauseForUpdateRestart(),
			});
		}
		if (
			options.restore !== true &&
			action.payload.kind === "turn" &&
			isAgentSessionMessage(primaryDeliveryRecord(action).message)
		) {
			assertAgentMessageQueueCapacity(
				this._actionStore.unfinishedActions().length,
				DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
			);
		}
		const coalescedOwner = options.restore ? undefined : this._coalescedFollowUpOwner(action);
		if (coalescedOwner) {
			// QP-3 (r39): a coalesce hit used to be a silent drop - no ticket, no
			// trace, a "queued" disposition that never came true. Settle a standalone
			// ticket as coalesced onto the surviving owner and log the hit so the
			// deduplication is visible; the queue snapshot itself is untouched.
			const controller = new ActionTicketController(action.id);
			controller.settleAccepted({ status: "coalesced", existingActionId: coalescedOwner.id });
			controller.settleDelivered({ status: "not_applicable" });
			controller.settleCompleted();
			sessionLog.info(`session input coalesced into running ${action.queueKey}`, {
				sessionId: this.sessionId,
				queueKey: action.queueKey,
				existingActionId: coalescedOwner.id,
				agentMessageId: action.agentMessageId,
			});
			if (action.agentMessageId !== coalescedOwner.agentMessageId) {
				this._rejectAgentMessage(
					action.agentMessageId,
					new Error("Prompt was not queued because an equivalent follow-up is already pending."),
				);
			}
			return { accepted: false, disposition: "queued", ticket: controller.ticket };
		}
		// QP-3 (r39): the committing window is not a coalesce window - the owner has
		// handed its prompt to the agent, so a second same-key admission would queue
		// a duplicate that also delivers. Refuse it as retryable instead (mirrors the
		// QP-2 admission refusal semantics); a running owner still accepts a queued
		// same-key action for the next tick.
		const committingOwner = options.restore ? undefined : this._committingFollowUpOwner(action);
		if (committingOwner) {
			throw new SessionInputCoalescingError({
				queueKey: committingOwner.queueKey ?? "",
				ownerActionId: committingOwner.id,
			});
		}
		const canStartImmediately =
			options.immediatelyEligible === true &&
			(this._actionStore.unfinishedActions().length === 0 || options.front === true);
		if (options.front) this._actionStore.enqueueFront(action);
		else this._actionStore.enqueue(action);
		let disposition: "starts_when_admitted" | "queued" = "queued";
		if (canStartImmediately && this._actionStore.selectFirst() === action) disposition = "starts_when_admitted";
		const controller = this._actionStore.ticketFor(action);
		controller.settleAccepted({
			status: "accepted",
			actionId: action.id,
			disposition,
		});
		this._sessionInputArrivalEpoch++;
		this._emitQueueUpdate();
		if (
			!options.restore &&
			options.wake !== false &&
			(disposition === "starts_when_admitted" ||
				(action.delivery === "next_turn_boundary" && this.isStreaming) ||
				action.payload.kind === "session_command" ||
				action.wake === "immediate")
		) {
			if (action.payload.kind === "turn" && action.wake === "immediate") {
				// The update-restart fence keeps queued work bound for the restart
				// manifest; admission wake must not start turns during teardown.
				if (!this._sessionInputSuspendedForUpdateRestart) this._resumeSessionInputAdmission();
			}
			this._scheduleSessionInputPump();
		}
		return { accepted: true, disposition, ticket: controller.ticket };
	}

	private async _queuePreparedPrompt(
		schedule: SessionInputSchedule,
		text: string,
		images?: ImageContent[],
		options: {
			agentMessageId?: string;
			queueKey?: string;
			content?: (TextContent | ImageContent)[];
			message?: QueuedAgentMessage;
			prefixMessages?: CustomMessage[];
			previewLabel?: string;
			suppressAutonomousContinuation?: boolean;
			resumeIfIdle?: boolean;
			source?: InputSource | "internal";
			/** A manifest restore re-admits captured work; pause leases do not refuse it. */
			admissionPauseExempt?: boolean;
			preserveOrder?: boolean;
		} = {},
	): Promise<boolean> {
		const action = this._createPreparedTurnAction(schedule, text, images, options);
		if (action.suppressAutonomousContinuation) {
			this._markAutonomousContinuationSuppressed(primaryDeliveryRecord(action).message);
		}
		return this._admitSessionInput(action, {
			...(options.admissionPauseExempt === true ? { admissionPauseExempt: true } : {}),
			preserveOrder: options.preserveOrder,
		}).accepted;
	}

	private _runtimeActivity(): RuntimeActivity {
		return {
			lowerAgentRun: this.isStreaming,
			compaction: this.isCompacting,
			retry: this.isRetrying,
			bash: this.isBashRunning,
			refinementApply: this._refineInFlight !== undefined,
			branchMutation: this._branchSummaryOperation !== undefined,
			schedulerPauseCount: this._queuedWorkPauses.size + (this._sessionInputPumpSuspended ? 1 : 0),
			disposing: this._disposed || this._disposing,
		};
	}

	private _hasSelectableSessionInput(): boolean {
		return (
			this._actionStore.queuedActions().length > 0 ||
			this._actionStore.activeActions().some((action) => action.lifecycle.state === "selected")
		);
	}

	get hasPendingSessionWork(): boolean {
		return this._actionStore.unfinishedActions().some((action) => {
			const state = action.lifecycle.state;
			return (
				state === "queued" ||
				state === "selected" ||
				state === "preparing" ||
				(state === "committing" && action.payload.kind === "turn" && !primaryDeliveryRecord(action).durable)
			);
		});
	}

	get hasPendingAdmissionWaiters(): boolean {
		return (
			this._sessionActionCommitOwner !== undefined ||
			this._pendingSessionActionFenceWaiters > 0 ||
			this._sessionInputCheckpointWaiters.size > 0
		);
	}

	private _scheduleSessionInputPump(): void {
		if (this._sessionInputPumpSuspended || this._queuedWorkPauses.size > 0) return;
		if (this._disposed || this._disposing || this._sessionInputPumpRequested || !this._hasSelectableSessionInput()) {
			return;
		}
		this._sessionInputPumpRequested = true;
		const epoch = this._sessionInputPumpEpoch;
		const pump = async () => {
			this._sessionInputPumpRequested = false;
			await this._pumpSessionInputs(epoch);
		};
		this._sessionInputPump = this._sessionInputPump.then(pump, pump);
		this._sessionInputPump.catch(() => {});
	}

	private async _pumpSessionInputs(epoch: number): Promise<void> {
		let blocked = false;
		try {
			while (!this._disposed && !this._disposing && this._hasSelectableSessionInput()) {
				await this.agent.waitForIdle();
				// Publication gate: a verdict recorded when the child settled is handed to
				// the parent here, so this is the last moment the facts can be re-read.
				this._dropSupersededRlmTerminalNoticeActions();
				const preselected = this._actionStore
					.activeActions()
					.find((action) => action.lifecycle.state === "selected");
				if (epoch !== this._sessionInputPumpEpoch) {
					if (preselected) {
						this._actionStore.rollback(preselected);
						this._notifySessionInputCheckpointChange();
						this._emitQueueUpdate();
					}
					return;
				}
				if (!this._hasCancelledDispatchCapture()) await this._agentEventQueue;
				if (!preselected || preselected.payload.kind === "session_command") await this._waitForRefineIdle();
				const activity = this._runtimeActivity();
				const canSelectPreselectedTurn =
					preselected?.payload.kind === "turn" && canSelectSessionAction({ ...activity, refinementApply: false });
				if (
					this._isSessionInputHandoffDeferred(epoch) ||
					(!canSelectPreselectedTurn && !canSelectSessionAction(activity))
				) {
					blocked = true;
					this._notifySessionInputCheckpointChange();
					return;
				}
				const first = preselected ?? this._actionStore.selectFirst();
				if (!first) return;
				if (first.payload.kind === "session_command") {
					await this._executeSelectedSessionCommand(first, epoch);
					return;
				}

				const forcedAllSteeringActionIds = this._forcedAllSteeringBatch(first);
				const mode =
					forcedAllSteeringActionIds !== undefined
						? "all"
						: first.delivery === "next_turn_boundary"
							? this.steeringMode
							: this.followUpMode;
				const actions: QueuedSessionAction[] = [first];
				while (!preselected && mode === "all") {
					const next = this._actionStore.queuedActions(first.delivery)[0];
					if (
						!next ||
						next.payload.kind !== "turn" ||
						(forcedAllSteeringActionIds !== undefined && !forcedAllSteeringActionIds.has(next.id)) ||
						!turnExecutionPoliciesEqual(first.payload.executionPolicy, next.payload.executionPolicy)
					) {
						break;
					}
					this._actionStore.selectFirst();
					actions.push(next);
				}
				if (epoch !== this._sessionInputPumpEpoch) {
					for (const action of actions) this._actionStore.rollback(action);
					return;
				}
				for (const action of actions) transitionSessionAction(action, { state: "preparing" });
				this._notifySessionInputCheckpointChange();
				this._emitQueueUpdate();
				try {
					await this._startPreparedTurnActions(actions, epoch);
					for (const action of actions) {
						if (action.lifecycle.state === "committing") {
							const primary = primaryDeliveryRecord(action);
							if (this.agent.state.messages.includes(primary.message)) {
								primary.durable = true;
								transitionSessionAction(action, {
									state: "running",
									execution: "agent_turn",
								});
							}
						}
						if (action.lifecycle.state === "running") {
							transitionSessionAction(action, { state: "completed" });
							this._actionStore.ticketFor(action).settleCompleted();
							this._settleAgentMessage(action.agentMessageId, "completion");
						}
					}
				} catch (error) {
					const transcript = this.agent.state.messages;
					const delivered = new Set(transcript);
					const undelivered: QueuedSessionAction[] = [];
					for (const action of actions) {
						if (action.payload.kind !== "turn" || action.lifecycle.state === "cancelled") continue;
						for (const record of action.payload.records) record.durable ||= delivered.has(record.message);
						action.payload.records = action.payload.records.filter((record) => {
							if (record.role === "prefix") return !record.durable;
							if (record.role === "next_turn") return record.durable;
							return true;
						});
						if (!primaryDeliveryRecord(action).durable) undelivered.push(action);
					}
					if (this._isDeferredSessionInputError(error, epoch)) {
						for (const action of undelivered) {
							if (action.lifecycle.state === "committing") {
								this._actionStore.rollback(action, {
									dispatchSettled: true,
									transcript,
								});
							} else if (action.lifecycle.state === "preparing" || action.lifecycle.state === "selected") {
								this._actionStore.rollback(action);
							}
						}
						if (undelivered.length > 0) this._emitQueueUpdate();
						blocked = epoch !== this._sessionInputPumpEpoch || this._isBusyForSessionInput("pump");
						if (blocked) return;
						continue;
					}
					const terminalError = this._asError(error);
					for (const action of actions) {
						if (action.lifecycle.state === "cancelled") continue;
						if (action.lifecycle.state !== "completed" && action.lifecycle.state !== "failed") {
							transitionSessionAction(action, {
								state: "failed",
								error: terminalError,
							});
						}
						const ticket = this._actionStore.ticketFor(action);
						if (undelivered.includes(action)) {
							ticket.rejectDelivered(terminalError);
							this._settleAgentMessage(action.agentMessageId, "delivery", terminalError);
						}
						this._settleAgentMessage(action.agentMessageId, "completion", terminalError);
						ticket.settleCompleted(terminalError);
					}
					if (actions.some((action) => action.payload.kind !== "turn" || action.payload.queueVisible)) {
						this._surfaceSessionInputError(error);
					}
				} finally {
					for (const action of actions) {
						const retainedCancelledDispatch =
							action.lifecycle.state === "cancelled" &&
							action.payload.kind === "turn" &&
							action.payload.captureRunMessages !== undefined;
						if (
							!retainedCancelledDispatch &&
							(action.lifecycle.state === "completed" ||
								action.lifecycle.state === "failed" ||
								action.lifecycle.state === "cancelled")
						) {
							this._durableRlmTerminalNoticeActionIds.delete(action.id);
							this._actionStore.releaseTerminal(action);
						}
					}
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
				}
				if (epoch !== this._sessionInputPumpEpoch || blocked) return;
			}
		} finally {
			if (!blocked && epoch === this._sessionInputPumpEpoch && this._hasSelectableSessionInput()) {
				this._scheduleSessionInputPump();
			}
		}
	}

	private async _executeSelectedSessionCommand(action: QueuedSessionAction, epoch: number): Promise<void> {
		if (action.payload.kind !== "session_command") throw new Error("Expected a selected session command");
		const input = action.payload;
		const commitFence = await this._acquireSessionActionCommitFence();
		try {
			await this._sessionActionCommitContext.run(commitFence.owner, async () => {
				const isCancelled = () => action.lifecycle.state === "cancelled";
				if (isCancelled()) return;
				await this._waitForRefineIdle();
				if (isCancelled()) return;
				if (this._isSessionInputHandoffDeferred(epoch) || !canSelectSessionAction(this._runtimeActivity())) {
					this._actionStore.rollback(action);
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
					return;
				}
				transitionSessionAction(action, {
					state: "running",
					execution: "session_command",
				});
				this._notifySessionInputCheckpointChange();
				this._emitQueueUpdate();
				try {
					this._appendDurableSessionCommandMessage(input.text, input.command, false);
					this._actionStore.ticketFor(action).settleDelivered({ status: "not_applicable" });
					this._settleAgentMessage(action.agentMessageId, "delivery");
					await this._executeQueuedSessionCommand(action);
					transitionSessionAction(action, { state: "completed" });
					this._actionStore.ticketFor(action).settleCompleted();
					this._settleAgentMessage(action.agentMessageId, "completion");
				} catch (error) {
					const commandError = this._asError(error);
					transitionSessionAction(action, {
						state: "failed",
						error: commandError,
					});
					const ticket = this._actionStore.ticketFor(action);
					ticket.rejectDelivered(commandError);
					ticket.settleCompleted(commandError);
					this._rejectAgentMessage(action.agentMessageId, commandError);
				} finally {
					this._actionStore.releaseTerminal(action);
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
				}
			});
		} finally {
			commitFence.release();
		}
	}

	/**
	 * Busy inputs: compaction, retry, bash, plus (for "pump") disposal,
	 * suspension, queued-work pauses, and branch-summary mutation. Waiters
	 * parked on this predicate rely on every clear site notifying the
	 * session-input checkpoint waiters; the idle waiter therefore parks on
	 * every source except disposal, whose clear site runs only at the end of
	 * a teardown that can itself block.
	 */
	private _isBusyForSessionInput(point: "preflight" | "pump"): boolean {
		const externalBusy = this.isCompacting || this.isRetrying || this.isBashRunning;
		if (point === "pump") {
			return (
				externalBusy ||
				this._disposed ||
				this._disposing ||
				this._sessionInputPumpSuspended ||
				this._queuedWorkPauses.size > 0 ||
				this._branchSummaryOperation !== undefined
			);
		}
		return externalBusy || this._actionStore.unfinishedActions().length > 0;
	}

	private _isSessionInputHandoffDeferred(epoch: number): boolean {
		return epoch !== this._sessionInputPumpEpoch || this._isBusyForSessionInput("pump");
	}

	private _asError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}

	private _isDeferredSessionInputError(error: unknown, epoch: number): boolean {
		if (error instanceof DeferredSessionInputError) return true;
		if (epoch !== this._sessionInputPumpEpoch) return true;
		if (this._isBusyForSessionInput("pump")) {
			this._surfaceSessionInputError(error);
			return true;
		}
		return false;
	}

	private _surfaceSessionInputError(error: unknown): void {
		const normalized = this._asError(error);
		try {
			this._extensionRunner.emitError({
				extensionPath: "<session-input>",
				event: "session_input",
				error: normalized.message,
				stack: normalized.stack,
			});
		} catch {
			// Best-effort: a throwing error listener must not break the pump's requeue path.
		}
	}

	private async _startPreparedTurnActions(actions: QueuedSessionAction[], epoch: number): Promise<void> {
		let nextTurnMessages: CustomMessage[] = [];
		const activeTurns = () =>
			actions.filter(
				(action): action is SessionAction<PreparedTurnPayload> =>
					action.payload.kind === "turn" && action.lifecycle.state === "preparing",
			);
		const firstTurn = activeTurns()[0];
		if (!firstTurn) return;
		const executionPolicy = firstTurn.payload.executionPolicy;
		const parkNextTurnMessages = (messages: CustomMessage[]) => {
			// The digest is never parked as pending context: a parked copy plus a
			// re-armed injection could double-deliver, and skip-policy turns never
			// drain the park. Filter it out and re-arm lazy injection instead.
			const parked = messages.filter((message) => message.customType !== HARNESS_DIGEST_CUSTOM_TYPE);
			if (parked.length !== messages.length) {
				this._harnessDigestPending = true;
				this._invalidateHarnessDigestBaselines();
			}
			// Route through the guarded inserter so deferred RLM terminal notices keep
			// their deferral timestamps (fork B10 guard).
			this._unshiftPendingNextTurnMessages(...parked);
		};
		const restoreNextTurnContext = () => {
			parkNextTurnMessages(nextTurnMessages);
			nextTurnMessages = [];
		};
		try {
			const preparedTurn = await this._prepareForCommit(executionPolicy.preparation, {
				afterValidation: () => {
					if (this._isSessionInputHandoffDeferred(epoch)) {
						throw new DeferredSessionInputError("Session input paused before preflight");
					}
				},
				prepare: async () => {
					if (executionPolicy.nextTurnContextTiming === "preparation") {
						nextTurnMessages = this._takePendingNextTurnMessagesForTurn(activeTurns());
					}
					if (!executionPolicy.runBeforeAgentStart) return undefined;
					while (activeTurns().some((action) => action.payload.prepared === undefined)) {
						if (this._isSessionInputHandoffDeferred(epoch)) {
							throw new DeferredSessionInputError("Session input paused before preparation");
						}
						const preparationAction = activeTurns().at(-1);
						if (!preparationAction) return undefined;
						const basePromptSnapshot = this._baseSystemPrompt;
						const result = await this._extensionRunner.emitBeforeAgentStart(
							preparationAction.payload.text,
							preparationAction.payload.images,
							basePromptSnapshot,
							this._baseSystemPromptOptions,
						);
						if (activeTurns().at(-1) !== preparationAction) continue;
						const prepared = { result, basePromptSnapshot };
						for (const action of activeTurns()) action.payload.prepared = prepared;
					}
					if (this._isSessionInputHandoffDeferred(epoch)) {
						throw new DeferredSessionInputError("Session input paused before handoff");
					}
					return activeTurns()[0]?.payload.prepared;
				},
				shouldCommit: () => activeTurns().length > 0,
				commit: (prepared) => {
					if (this._isSessionInputHandoffDeferred(epoch)) {
						throw new DeferredSessionInputError("Session input paused before handoff");
					}
					const turns = activeTurns();
					if (turns.length === 0) return undefined;
					return { prepared, turns };
				},
			});
			if (!preparedTurn) {
				restoreNextTurnContext();
				return;
			}
			const { prepared, turns } = preparedTurn;
			const commitFence = await this._acquireSessionActionCommitFence();
			let promptPromise: Promise<void>;
			try {
				promptPromise = this._sessionActionCommitContext.run(commitFence.owner, () => {
					if (
						this._isSessionInputHandoffDeferred(epoch) ||
						this.isStreaming ||
						turns.some((action) => action.lifecycle.state !== "preparing")
					) {
						throw new DeferredSessionInputError("Agent became active before session input handoff");
					}
					if (executionPolicy.nextTurnContextTiming === "commit") {
						nextTurnMessages = this._takePendingNextTurnMessagesForTurn(turns);
					}
					// Outside the timing switch on purpose: custom-triggered turns run the
					// "skip" policy, and a fresh session whose first turn was a custom
					// trigger still has to see the digest.
					if (this._harnessDigestPending) {
						this._harnessDigestPending = false;
						const { digest, stateFingerprint, state } = this._harnessDigestWithFingerprint();
						this._recordHarnessDigestBaselines(state);
						const latest = this._latestContextHarnessDigestDetails();
						if (!latest || !this._harnessDigestIsFresh(latest, digest, stateFingerprint)) {
							// Rides the turn's delivery records, so cancelling this first turn
							// strips the digest with the rest of the turn and re-arms it.
							nextTurnMessages = [
								createHarnessDigestMessage(digest, Date.now(), stateFingerprint),
								...nextTurnMessages,
							];
						}
					} else {
						// Material-change re-injection: an entry written since the last
						// delivered digest (this session's own refine excluded - its receipt
						// already itemized it) becomes visible on this turn, append-only.
						this._refreshHarnessDigestIfMateriallyChanged();
					}
					const contextRecords = nextTurnMessages.map((message) =>
						this._createDeliveryRecord(turns[0].id, "next_turn", message),
					);
					const firstPrimaryIndex = turns[0].payload.records.indexOf(primaryDeliveryRecord(turns[0]));
					turns[0].payload.records.splice(firstPrimaryIndex, 0, ...contextRecords);
					for (const action of turns) {
						// Queued continuations must report goal accounting as of delivery,
						// not as of queue time (see refresh rationale).
						this._refreshGoalContextMessageAtDelivery(primaryDeliveryRecord(action).message);
					}
					const preparedMessages: AgentMessage[] = turns.flatMap((action) =>
						action.payload.records.map((record) => record.message),
					);
					for (const action of turns) {
						if (action.suppressAutonomousContinuation) {
							this._markAutonomousContinuationSuppressed(primaryDeliveryRecord(action).message);
						}
					}
					if (executionPolicy.runBeforeAgentStart) {
						this._appendBeforeAgentStartMessages(preparedMessages, prepared?.result);
						this._applyPreparedSystemPrompt(prepared, executionPolicy.preserveEmptyExtensionPrompt);
					} else if (executionPolicy.nextTurnContextTiming !== "skip") {
						this.agent.state.systemPrompt = this._baseSystemPrompt;
					}
					for (const action of turns) transitionSessionAction(action, { state: "committing" });
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
					return turns.some((action) => action.suppressAutonomousContinuation)
						? this._runWithAutonomousContinuationSuppressed(() => this.agent.prompt(preparedMessages))
						: this.agent.prompt(preparedMessages);
				});
			} finally {
				commitFence.release();
			}
			await promptPromise;
			if (executionPolicy.completionIncludesRetryChain) await this.waitForRetry();
			if (!this._hasCancelledDispatchCapture()) await this._agentEventQueue;
			if (
				turns.some(
					(action) =>
						action.lifecycle.state !== "cancelled" &&
						!primaryDeliveryRecord(action).durable &&
						!this.agent.state.messages.includes(primaryDeliveryRecord(action).message),
				)
			) {
				throw new Error("Session input dispatch settled without durable delivery");
			}
			this._forgetConsumedPostCompactionContinuations(turns.map((action) => primaryDeliveryRecord(action).message));
		} catch (error) {
			const delivered = new Set(this.agent.state.messages);
			parkNextTurnMessages(nextTurnMessages.filter((message) => !delivered.has(message)));
			for (const action of actions) {
				if (action.payload.kind === "turn") {
					action.payload.records = action.payload.records.filter((record) => record.role !== "next_turn");
				}
			}
			throw error;
		}
	}

	private async _executeQueuedSessionCommand(action: QueuedSessionAction): Promise<void> {
		if (action.payload.kind !== "session_command") throw new Error("Expected a session command action");
		const input = action.payload;
		try {
			let resultText: string | undefined;
			let displayResult = true;
			switch (input.command.name) {
				case "compact":
					try {
						await this.compact(input.command.args || undefined, {
							skipAbort: true,
						});
					} catch (error) {
						if (!(error instanceof CompactionSkippedError)) throw error;
						// K3R-7 follow-up (r28): a queued /compact that skipped never ran
						// its instructions anywhere. Without instructions the skip is
						// benign; with them the drop must be visible instead of the
						// silent return the shared catch gives CompactionSkippedError.
						if (input.command.args) {
							resultText = `Compact skipped: ${error instanceof Error ? error.message : String(error)}`;
						}
					}
					break;
				case "refine": {
					let result: RefinementResult;
					// MV-5: the parse sits inside the try so a bad /refine invocation
					// still emits refine_failed and leaves a model-visible receipt; the
					// pre-fix placement outside the try lost both.
					let options: RefineCommandOptions | undefined;
					try {
						options = parseRefineCommandOptions(input.command.args);
						result = await this.refine(options, { skipAbort: true });
					} catch (error) {
						// Only a failure of the refinement itself is a refine failure; a later
						// result-row persist error must not report a completed refinement as failed.
						this._emitRefineFailed(this._asError(error), options?.global ? "global" : "local");
						throw error;
					}
					const applied = result.appliedEdits.filter((edit) => edit.applied).length;
					resultText = `Refined continual harness state: ${applied} edit${applied === 1 ? "" : "s"} applied.`;
					displayResult = false;
					break;
				}
				case "goal":
					await this._handleGoalSlashCommand(input.text, input.images);
					resultText = this._goalState.objective
						? `Goal ${this._goalState.status}: ${this._goalState.objective}`
						: "No active goal.";
					break;
				case "autonomous":
					await this._handleAutonomousSlashCommand(input.text);
					break;
			}
			if (resultText) {
				this._appendDurableSessionCommandMessage(resultText, input.command, true, false, displayResult);
			}
		} catch (error) {
			if (error instanceof CompactionSkippedError) return;
			const commandError = error instanceof Error ? error : new Error(String(error));
			try {
				this._appendDurableSessionCommandMessage(
					`Command failed: ${commandError.message}`,
					input.command,
					true,
					true,
				);
			} catch {
				// The result row is also the command-correlated UI settle edge.
				const message = createSessionSlashCommandResultMessage(`Command failed: ${commandError.message}`, {
					command: input.command,
					success: false,
					severity: "error",
					error: commandError.message,
				});
				this._emit({ type: "message_start", message });
				this._emit({ type: "message_end", message });
			}
			throw commandError;
		}
	}

	private _appendDurableSessionCommandMessage(
		content: string,
		command: SessionSlashCommand,
		isResult: boolean,
		isError = false,
		display = true,
	): void {
		const message: CustomMessage = isResult
			? createSessionSlashCommandResultMessage(
					content,
					{
						command,
						success: !isError,
						severity: isError ? "error" : "info",
						...(isError ? { error: content.replace(/^Command failed:\s*/, "") } : {}),
					},
					display,
				)
			: createSessionSlashCommandMessage(command);
		// Persist before touching live state so a failed write cannot leave an
		// unsaved leaf that the next entry would silently parent onto.
		this.sessionManager.appendCustomMessageEntryWithRollback(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this.agent.state.messages.push(message);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private _throwIfExtensionCommand(text: string): void {
		const commandName = parseSlashCommand(text)?.name ?? "";
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
		},
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pushPendingNextTurnMessages(appMessage);
		} else if (this.isStreaming) {
			const normalized = normalizeMessageContent(message.content);
			if (options?.deliverAs === "followUp") {
				await this._queuePreparedPrompt("followUp", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
				});
			} else {
				await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
				});
			}
		} else if (options?.triggerTurn) {
			if (!this._sessionInputSuspendedForUpdateRestart) this._resumeSessionInputAdmission();
			const admissionFence = await this._acquireDirectTurnAdmissionFence();
			try {
				const normalized = normalizeMessageContent(message.content);
				const immediatelyEligible = this._canStartSessionActionImmediately();
				const action = this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
					executionPolicy: this._turnExecutionPolicy("customTrigger"),
					queueVisible: false,
				});
				const result = this._admitSessionInput(action, { immediatelyEligible });
				admissionFence.release();
				if (!result.ticket) return;
				await result.ticket.completed;
			} finally {
				admissionFence.release();
			}
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this._prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
			resumeIfIdle: true,
		});
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const clearable = this._actionStore
			.clearableActions()
			.filter((action) => action.payload.kind === "session_command" || action.payload.queueVisible);
		if (clearable.some((action) => action.payload.kind === "turn" && action.lifecycle.state === "preparing")) {
			this._sessionInputPumpEpoch++;
		}
		const steering = clearable
			.filter((action) => action.delivery === "next_turn_boundary")
			.map((action) => action.payload.text);
		const followUp = clearable
			.filter((action) => action.delivery === "when_run_idle")
			.map((action) => action.payload.text);
		const promptError = new Error("Queued prompt was cleared before delivery.");
		const agentMessageError = new Error("Queued agent message was cleared before delivery.");
		for (const action of clearable) {
			const error =
				action.payload.kind === "turn" && action.lifecycle.state === "preparing" ? promptError : agentMessageError;
			this._settleAgentMessage(action.agentMessageId, "delivery", error);
			this._settleAgentMessage(action.agentMessageId, "completion", error);
		}
		const clearableIds = new Set(clearable.map((action) => action.id));
		this._cancelSessionActions((action) => clearableIds.has(action.id), agentMessageError);
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	private _invalidateQueuedPromptPreparation(): void {
		for (const action of this._actionStore.clearableActions()) {
			if (action.payload.kind === "turn") action.payload.prepared = undefined;
		}
	}

	clearQueuedAgentMessages(): { steering: string[]; followUp: string[] } {
		this._agentMessageClearEpoch++;
		// customType identifies agent messages; the text parser covers persisted pre-grammar prompts.
		return this._clearQueuedTurnActionsMatching(
			(action) =>
				isAgentSessionMessage(primaryDeliveryRecord(action).message) ||
				isAgentSessionMessagePrompt(action.payload.text),
		);
	}

	clearQueuedUserMessagesMatching(predicate: (text: string) => boolean): { steering: string[]; followUp: string[] } {
		return this._clearQueuedTurnActionsMatching((action) => predicate(action.payload.text));
	}

	private _clearQueuedTurnActionsMatching(matches: (action: QueuedSessionAction) => boolean): {
		steering: string[];
		followUp: string[];
	} {
		const ownedActions = this._actionStore.ownedActions();
		const dispatchedTurnCount = ownedActions.filter(
			(action) =>
				action.payload.kind === "turn" &&
				(action.lifecycle.state === "committing" || action.lifecycle.state === "running"),
		).length;
		const matching = ownedActions.filter(
			(action) =>
				action.payload.kind === "turn" &&
				action.agentMessageId !== undefined &&
				matches(action) &&
				(action.lifecycle.state === "queued" ||
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing" ||
					(action.lifecycle.state === "committing" &&
						dispatchedTurnCount === 1 &&
						!primaryDeliveryRecord(action).started)),
		);
		if (matching.length === 0) return { steering: [], followUp: [] };
		const removedTexts = (delivery: DeliveryPolicy) =>
			[
				...matching.filter((action) => action.delivery === delivery && action.lifecycle.state === "queued"),
				...matching.filter((action) => action.delivery === delivery && action.lifecycle.state !== "queued"),
			].map((action) => action.payload.text);
		const removedSteering = removedTexts("next_turn_boundary");
		const removedFollowUp = removedTexts("when_run_idle");
		const acceptedError = new Error("Accepted agent message was cleared before delivery.");
		const queuedError = new Error("Queued agent message was cleared before delivery.");
		for (const action of matching) {
			const error =
				action.payload.kind === "turn" && action.payload.acceptedAgentMessage ? acceptedError : queuedError;
			this._rejectAgentMessage(action.agentMessageId, error);
			// A cleared reply is never delivered, so the credit owed for it dies here:
			// B1 keeps an undelivered reply from counting.
			if (action.agentMessageId !== undefined) this._queuedChildReplyBackfills.take(action.agentMessageId);
		}
		for (const [accepted, error] of [
			[true, acceptedError],
			[false, queuedError],
		] as const) {
			const ids = new Set(
				matching
					.filter((action) => action.payload.kind === "turn" && action.payload.acceptedAgentMessage === accepted)
					.map((action) => action.id),
			);
			if (ids.size > 0) this._cancelSessionActions((action) => ids.has(action.id), error, matching);
		}
		if (
			matching.some(
				(action) =>
					action.lifecycle.state === "cancelled" &&
					action.payload.kind === "turn" &&
					action.payload.captureRunMessages,
			)
		) {
			this.agent.abort();
		}
		this._emitQueueUpdate();
		return { steering: removedSteering, followUp: removedFollowUp };
	}

	/**
	 * Mutate a single visible queued message, addressed by its position in the same
	 * projection the session-action snapshot publishes. expectedText must match the
	 * item's current preview so clients never edit a shifted queue by accident.
	 */
	mutateQueuedMessage(
		lane: QueuedMessageLane,
		index: number,
		expectedText: string,
		mutation: QueuedMessageMutation,
	): QueuedMessageMutationStatus {
		const policy = queuedMessageLaneDeliveryPolicy(lane);
		const projection = visibleSessionActionProjection(this._actionStore.queuedActions(policy));
		const item = projection[index];
		if (!item || queuedAgentMessagePreview(item) !== expectedText) return "rejected";
		if (mutation.type === "delete") {
			const error = new Error("Queued prompt was deleted before delivery.");
			this._rejectAgentMessage(item.agentMessageId, error);
			this._cancelSessionActions((candidate) => candidate === item, error);
			this._emitQueueUpdate();
			this._resumeQueuedWorkUnlessFenced();
			return "applied";
		}
		if (mutation.type === "move") {
			const neighbor = projection[index + mutation.direction];
			if (!neighbor) return "rejected";
			this._actionStore.swapQueued(item, neighbor);
			this._emitQueueUpdate();
			return "applied";
		}
		if (
			item.payload.kind === "turn" &&
			(item.payload.acceptedAgentMessage ||
				item.payload.records.some((record) => record.role === "primary" && record.message.role !== "user"))
		) {
			return "rejected";
		}
		const images = mutation.images?.map((image) => ({ ...image }));
		if (item.payload.kind === "session_command") {
			const command = parseSessionSlashCommand(mutation.text);
			if (!command) return "invalid";
			item.payload.text = mutation.text;
			item.payload.command = command;
			if (mutation.images !== undefined) item.payload.images = images?.length ? images : undefined;
		} else {
			item.payload.text = mutation.text;
			const text = { type: "text" as const, text: mutation.text };
			if (mutation.images !== undefined) {
				item.payload.images = images?.length ? images : undefined;
				item.payload.content = [text, ...(images?.map((image) => ({ ...image })) ?? [])];
			} else if (item.payload.content) {
				item.payload.content = [text, ...item.payload.content.filter((block) => block.type !== "text")];
			}
			item.payload.preview = undefined;
			item.payload.prepared = undefined;
			for (const record of item.payload.records) {
				if (record.role === "primary" && record.message.role === "user") {
					record.message.content = item.payload.content?.map((block) => ({ ...block })) ?? mutation.text;
				}
			}
		}
		const targetPolicy = queuedMessageLaneDeliveryPolicy(mutation.lane);
		if (targetPolicy !== policy) {
			item.queueKey = undefined;
			item.wake = mutation.lane === "steering" ? "on_lower_boundary" : "external_resume";
			this._actionStore.moveQueued(item, targetPolicy, this._actionStore.queuedActions(targetPolicy).length);
		}
		this._resumeQueuedWorkUnlessFenced();
		this._emitQueueUpdate();
		return "applied";
	}

	get queuedActionCount(): number {
		return visibleSessionActionProjection(this._actionStore.queuedActions()).length;
	}

	get unfinishedActionCount(): number {
		return this._actionStore.unfinishedActions().length;
	}

	get isQueuedWorkSuspended(): boolean {
		return this._sessionInputPumpSuspended;
	}

	/**
	 * Unfinished actions that something is actually working on.
	 *
	 * `queued` never counts: a message waiting for a wake is not activity, and after
	 * an Esc it would otherwise pin the session - and with it the whole worker -
	 * resident until somebody typed something. `selected` does not count while the
	 * pump is suspended either: the pump claimed the action but is not allowed to
	 * consume it, so it is still waiting, not working. Every other non-terminal state
	 * (preparing/committing/running) counts, which keeps `wait_for_idle` and RLM
	 * quiescence honest about work in flight.
	 */
	private _consumedUnfinishedActionCount(): number {
		const suspended = this._sessionInputPumpSuspended;
		let count = 0;
		for (const action of this._actionStore.unfinishedActions()) {
			const state = action.lifecycle.state;
			if (state === "queued") continue;
			if (state === "selected" && suspended) continue;
			count += 1;
		}
		return count;
	}

	get isSessionActive(): boolean {
		return (
			// Upstream folded the kernel's background-work mime into isSessionActive here.
			// This fork forbids that fold: the worker reports kernel work as its own term
			// (`session.isSessionActive || session.isKernelWorkInFlight === true`,
			// daemon-session-list.ts) because folding it in silently reopens r44 form A
			// for the whole worker, and our runtime never emits that mime at all
			// (2053(a): KernelClient has no hasBackgroundWork).
			this.isStreaming ||
			this.isCompacting ||
			this.isRetrying ||
			this.isBashRunning ||
			this._refineInFlight !== undefined ||
			this._branchSummaryOperation !== undefined ||
			this._postCompactionContinuationSettlement !== undefined ||
			// I-2: only work that is actually being consumed counts. After an Esc the
			// queue can hold up to 20 undelivered agent messages; counting them would
			// pin the session (and therefore the whole worker) resident forever, so
			// queued-but-unconsumed messages wait for a wake instead of claiming
			// activity. They are not lost: queued actions round-trip through
			// getSessionActionRecoverySnapshot()/restoreSessionActions().
			this._consumedUnfinishedActionCount() > 0 ||
			// Deferred RLM terminal notices are undelivered work: requestAbort demotes
			// admitted notices back to next-turn deferral, and a session holding only
			// those would otherwise look idle and be passivated/evicted, dropping the
			// child's terminal report before the parent ever receives it. Counting them
			// as activity keeps the session resident until a resume flushes them; once a
			// notice is stale past the abandonment threshold it stops pinning the
			// session so an aborted session can still be evicted.
			this._hasActionableDeferredRlmTerminalNotices()
		);
	}

	getSessionActionSnapshot(): SessionActionSnapshot {
		const steering = visibleSessionActionProjection(this._actionStore.queuedActions("next_turn_boundary")).map(
			queuedAgentMessagePreview,
		);
		const followUps = visibleSessionActionProjection(this._actionStore.queuedActions("when_run_idle")).map(
			queuedAgentMessagePreview,
		);
		const active = visibleSessionActionProjection(this._actionStore.activeActions())[0];
		const activeState = active?.lifecycle.state;
		const phase =
			activeState === "selected"
				? "preparing"
				: activeState === "preparing" || activeState === "committing" || activeState === "running"
					? activeState
					: undefined;
		return {
			queuedCount: steering.length + followUps.length,
			steering,
			followUps,
			...(active && phase
				? {
						active: {
							kind: active.payload.kind,
							phase,
							label: compactRlmText(active.payload.text),
						},
					}
				: {}),
		};
	}

	getSteeringMessages(): readonly string[] {
		return visibleSessionActionProjection(this._actionStore.queuedActions("next_turn_boundary")).map(
			(action) => action.payload.text,
		);
	}

	getSteeringMessagePreviews(): readonly string[] {
		return visibleSessionActionProjection(this._actionStore.queuedActions("next_turn_boundary")).map(
			queuedAgentMessagePreview,
		);
	}

	getFollowUpMessages(): readonly string[] {
		return visibleSessionActionProjection(this._actionStore.queuedActions("when_run_idle")).map(
			(action) => action.payload.text,
		);
	}

	getFollowUpMessagePreviews(): readonly string[] {
		return visibleSessionActionProjection(this._actionStore.queuedActions("when_run_idle")).map(
			queuedAgentMessagePreview,
		);
	}

	getSessionActionRecoverySnapshot(): SessionActionRecoverySnapshot {
		return {
			formatVersion: SESSION_ACTION_RECOVERY_FORMAT_VERSION,
			actions: this._actionStore.snapshotActions().map((action) => ({
				id: action.id,
				source: action.source,
				delivery: action.delivery,
				wake: action.wake,
				...(action.queueKey ? { queueKey: action.queueKey } : {}),
				...(action.agentMessageId ? { agentMessageId: action.agentMessageId } : {}),
				...(action.suppressAutonomousContinuation ? { suppressAutonomousContinuation: true } : {}),
				payload:
					action.payload.kind === "turn"
						? {
								kind: "turn",
								text: action.payload.text,
								...(action.payload.preview ? { preview: action.payload.preview } : {}),
								records: action.payload.records.map((record) => ({
									id: record.id,
									role: record.role,
									message: cloneQueuedAgentMessage(record.message),
									ownerActionId: record.ownerActionId,
								})),
								...(action.payload.images
									? {
											images: action.payload.images.map((image) => ({
												...image,
											})),
										}
									: {}),
								...(action.payload.content
									? {
											content: action.payload.content.map((block) => ({
												...block,
											})),
										}
									: {}),
								...(action.payload.customMessage
									? {
											customMessage: cloneCustomMessage(action.payload.customMessage),
										}
									: {}),
								executionPolicy: {
									...action.payload.executionPolicy,
									preparation: {
										...action.payload.executionPolicy.preparation,
									},
								},
								queueVisible: action.payload.queueVisible,
								acceptedAgentMessage: action.payload.acceptedAgentMessage,
								acceptedBeforeCompletion: action.payload.acceptedBeforeCompletion,
							}
						: {
								kind: "session_command",
								text: action.payload.text,
								command: { ...action.payload.command },
								...(action.payload.images
									? {
											images: action.payload.images.map((image) => ({
												...image,
											})),
										}
									: {}),
							},
			})),
		};
	}

	private _notifySessionInputCheckpointChange(): void {
		const waiters = [...this._sessionInputCheckpointWaiters];
		this._sessionInputCheckpointWaiters.clear();
		for (const resolve of waiters) resolve();
	}

	private _waitForSessionActivityChange(signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			const finish = () => {
				this._sessionInputCheckpointWaiters.delete(finish);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			this._sessionInputCheckpointWaiters.add(finish);
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted) finish();
		});
	}

	private _observeSessionActionDeferral(action: QueuedSessionAction): {
		deferred: Promise<void>;
		stop(): void;
	} {
		let resolveDeferral = () => {};
		const deferred = new Promise<void>((resolve) => {
			resolveDeferral = resolve;
		});
		const check = () => {
			if (action.lifecycle.state === "queued") resolveDeferral();
			else this._sessionInputCheckpointWaiters.add(check);
		};
		this._sessionInputCheckpointWaiters.add(check);
		return {
			deferred,
			stop: () => this._sessionInputCheckpointWaiters.delete(check),
		};
	}

	async waitForSessionInputCheckpoint(signal?: AbortSignal): Promise<void> {
		const blocksCheckpoint = () =>
			this._actionStore.activeActions().some((action) => {
				if (action.payload.kind === "session_command") {
					return action.lifecycle.state === "selected" || action.lifecycle.state === "running";
				}
				return (
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing" ||
					(action.lifecycle.state === "committing" && !primaryDeliveryRecord(action).durable)
				);
			});
		while (true) {
			while (blocksCheckpoint()) {
				if (signal?.aborted) throw new Error("Update restart preparation cancelled");
				await new Promise<void>((resolve, reject) => {
					const onChange = () => {
						cleanup();
						resolve();
					};
					const onAbort = () => {
						cleanup();
						reject(new Error("Update restart preparation cancelled"));
					};
					const cleanup = () => {
						this._sessionInputCheckpointWaiters.delete(onChange);
						signal?.removeEventListener("abort", onAbort);
					};
					this._sessionInputCheckpointWaiters.add(onChange);
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				});
			}
			const commitFence = await this._acquireSessionActionCommitFence(signal);
			try {
				if (blocksCheckpoint()) continue;
				if (signal?.aborted) throw new Error("Update restart preparation cancelled");
				await waitForPromiseOrAbort(this._agentEventQueue, signal, "Update restart preparation cancelled");
				if (signal?.aborted) throw new Error("Update restart preparation cancelled");
				this.sessionManager.flushNow();
				return;
			} finally {
				commitFence.release();
			}
		}
	}

	acquireSessionInputPause(options: { forUpdateRestart?: boolean } = {}): { release(): void } {
		const token = Symbol("session-input-admission-pause");
		this._sessionInputAdmissionPauses.set(token, { forUpdateRestart: options.forUpdateRestart === true });
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this._sessionInputAdmissionPauses.delete(token);
				this._sessionInputPumpEpoch++;
				this._notifySessionInputCheckpointChange();
				this._flushDeferredRlmTerminalNotices();
				this._maybeResumeGoalContinuationAfterRlmWork();
				this._maybeResumeAutonomousContinuationAfterRlmWork();
				this._scheduleSessionInputPump();
			},
		};
	}

	/** True when any held admission pause belongs to the update-restart teardown window. */
	private _anySessionInputPauseForUpdateRestart(): boolean {
		for (const pause of this._sessionInputAdmissionPauses.values()) {
			if (pause.forUpdateRestart) return true;
		}
		return false;
	}

	acquireQueuedWorkPause(): { release(): void } {
		const token = Symbol("queued-work-pause");
		this._queuedWorkPauses.add(token);
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this._queuedWorkPauses.delete(token);
				this._notifySessionInputCheckpointChange();
				this._flushDeferredRlmTerminalNotices();
				this._scheduleSessionInputPump();
			},
		};
	}

	private async _acquireDirectTurnAdmissionFence(signal?: AbortSignal): Promise<{ owner: symbol; release(): void }> {
		const inheritedOwner = this._sessionActionCommitContext.getStore();
		if (inheritedOwner !== undefined && inheritedOwner === this._sessionActionCommitOwner) {
			this._assertSessionActionAdmissionAvailable();
			return this._acquireSessionActionCommitFence(signal);
		}
		const disposeSignal = this._sessionActionCommitDisposeAbortController.signal;
		const waitSignal = signal ? AbortSignal.any([signal, disposeSignal]) : disposeSignal;
		while (true) {
			this._assertSessionActionAdmissionAvailable();
			if (this._queuedWorkPauses.size > 0) {
				let wake = () => {};
				const pauseReleased = new Promise<void>((resolve) => {
					wake = resolve;
					this._sessionInputCheckpointWaiters.add(resolve);
				});
				try {
					await waitForPromiseOrAbort(pauseReleased, waitSignal, "Update restart preparation cancelled");
				} catch (error) {
					if (disposeSignal.aborted) {
						throw new Error("Cannot admit a session action because the session is disposing or disposed.");
					}
					throw error;
				} finally {
					this._sessionInputCheckpointWaiters.delete(wake);
				}
				continue;
			}
			const fence = await this._acquireSessionActionCommitFence(signal);
			try {
				if (this._queuedWorkPauses.size === 0) {
					this._assertSessionActionAdmissionAvailable();
					return fence;
				}
			} catch (error) {
				fence.release();
				throw error;
			}
			fence.release();
		}
	}

	private async _acquireSessionActionCommitFence(signal?: AbortSignal): Promise<{ owner: symbol; release(): void }> {
		const inheritedOwner = this._sessionActionCommitContext.getStore();
		if (inheritedOwner !== undefined && inheritedOwner === this._sessionActionCommitOwner) {
			return { owner: inheritedOwner, release: () => {} };
		}
		const previous = this._sessionActionCommitTail;
		let resolve = () => {};
		this._sessionActionCommitTail = new Promise<void>((release) => {
			resolve = release;
		});
		const disposeSignal = this._sessionActionCommitDisposeAbortController.signal;
		const waitSignal = signal ? AbortSignal.any([signal, disposeSignal]) : disposeSignal;
		this._pendingSessionActionFenceWaiters++;
		try {
			await waitForPromiseOrAbort(previous, waitSignal, "Update restart preparation cancelled");
		} catch (error) {
			this._pendingSessionActionFenceWaiters--;
			// A cancelled waiter remains in the FIFO chain until its predecessor releases.
			void previous.then(resolve, resolve);
			if (disposeSignal.aborted) {
				throw new Error("Cannot admit a session action because the session is disposing or disposed.");
			}
			throw error;
		}
		const owner = Symbol("session-action-commit");
		this._sessionActionCommitOwner = owner;
		this._pendingSessionActionFenceWaiters--;
		let released = false;
		return {
			owner,
			release: () => {
				if (released) return;
				released = true;
				if (this._sessionActionCommitOwner === owner) this._sessionActionCommitOwner = undefined;
				resolve();
			},
		};
	}

	private _resumeSessionInputAdmission(): void {
		if (!this._sessionInputPumpSuspended) return;
		this._sessionInputPumpSuspended = false;
		this._sessionInputSuspendedForUpdateRestart = false;
		this._sessionInputPumpEpoch++;
		// The pump is runnable again: the aggregated failure wake is pointless now,
		// and the ordinary flush below delivers every deferred notice.
		this._sessionInputSuspendedSince = undefined;
		this._clearFailureWakeTimers();
		this._pendingFailureWakeNotices.length = 0;
		this._notifySessionInputCheckpointChange();
		// Reflow before flushing so a sidecar left by an earlier process is delivered
		// by the same resume that revives the pump.
		this._reflowUndeliveredRlmNotices();
		this._flushDeferredRlmTerminalNotices();
		// Lifting the suspension ends the teardown window: the update-restart
		// admission pause (QP-2, r39) must not outlive the fence it guards.
		this._updateRestartAdmissionPause?.release();
		this._updateRestartAdmissionPause = undefined;
	}

	/**
	 * Wake a pump suspended by an ordinary requestAbort so stranded queued work
	 * can drain (e.g. a visible heartbeat action left behind by an abort that
	 * would otherwise defer every later tick forever). Never lifts the
	 * update-restart fence: that queued work must survive into the restart
	 * manifest instead of starting a turn during teardown. Returns whether the
	 * suspension was lifted.
	 */
	wakeSuspendedSessionInput(): boolean {
		if (!this._sessionInputPumpSuspended || this._sessionInputSuspendedForUpdateRestart) return false;
		this._resumeSessionInputAdmission();
		this._scheduleSessionInputPump();
		return true;
	}

	/**
	 * QP-1 (r39): queue bookkeeping (mutateQueuedMessage, the compact
	 * preempted-auto finally) must never lift the update-restart fence - the
	 * parked queue belongs to the restart manifest, not to a fresh turn during
	 * teardown (mirrors resumeQueuedWorkFromConnection/wakeSuspendedSessionInput
	 * refusals). Direct resumeQueuedWork() calls keep the recovery contract
	 * (post-restart restore, in-process unwedge). Refusing here touches neither
	 * the pump flags nor the epoch, so in-flight preparations stay valid.
	 */
	private _resumeQueuedWorkUnlessFenced(): void {
		if (this._updateRestartFenceUp) return;
		this.resumeQueuedWork();
	}

	/** Resume the scheduler after requestAbort/abortForUpdateRestart suspended it; owned pause leases are unaffected. */
	resumeQueuedWork(): boolean {
		this._resumeSessionInputAdmission();
		this._maybeResumeGoalContinuationAfterRlmWork();
		this._maybeResumeAutonomousContinuationAfterRlmWork();
		this._scheduleSessionInputPump();
		return this._hasSelectableSessionInput();
	}

	/** True while abortForUpdateRestart holds queued work behind the restart fence. */
	private get _updateRestartFenceUp(): boolean {
		return this._sessionInputPumpSuspended && this._sessionInputSuspendedForUpdateRestart;
	}

	/**
	 * Resume requested by a live connection (TUI Enter on an empty editor, the
	 * daemon resume_queue command). Never lifts the update-restart fence: queued
	 * work must survive into the restart manifest instead of starting a new turn
	 * during teardown (mirrors the triggerTurn and agent-message wake guards).
	 * Recovery flows (post-restart restore, in-process unwedge) call
	 * resumeQueuedWork() directly.
	 */
	resumeQueuedWorkFromConnection(): boolean {
		if (this._updateRestartFenceUp) return false;
		return this.resumeQueuedWork();
	}

	async waitForSessionInputIdle(): Promise<void> {
		while (true) {
			const pump = this._sessionInputPump;
			await pump;
			if (pump === this._sessionInputPump && !this._sessionInputPumpRequested) return;
		}
	}

	async waitForIdle(): Promise<void> {
		await this._waitForIdleOrSettlement();
	}

	/**
	 * {@link waitForIdle} loop; with a settlement, returns once that settlement is
	 * superseded so a cancelled post-compaction runner cannot keep a checkpoint
	 * waiter registered (a leaked waiter holds hasPendingAdmissionWaiters true and
	 * blocks daemon passivation).
	 */
	private async _waitForIdleOrSettlement(settlement?: PostCompactionContinuationSettlement): Promise<void> {
		while (settlement === undefined || this._postCompactionContinuationSettlement === settlement) {
			if (this._actionStore.queuedActions().length > 0) {
				// Park while the pump would refuse scheduling or selection: rescheduling
				// a blocked pump completes on already-resolved promises, so looping here
				// would spin on the microtask queue and starve the IO that ends the busy state.
				// Disposal stays out of the park: disposeAsync() sets _disposing before the
				// teardown that cancels the queue, and that teardown can block on a wedged
				// kernel, so parking here would pin a checkpoint waiter (and
				// hasPendingAdmissionWaiters) for the whole teardown. The fall-through below
				// resolves once dispose() cancels the queue.
				if (this._isBusyForSessionInput("pump") && !this._disposed && !this._disposing) {
					let wake = () => {};
					const changed = new Promise<void>((resolve) => {
						wake = resolve;
						this._sessionInputCheckpointWaiters.add(resolve);
					});
					try {
						await (settlement ? Promise.race([changed, settlement.promise]) : changed);
					} finally {
						this._sessionInputCheckpointWaiters.delete(wake);
					}
					continue;
				}
				this._scheduleSessionInputPump();
			}
			const pump = this._sessionInputPump;
			await pump;
			await this.agent.waitForIdle();
			const agentEventQueue = this._agentEventQueue;
			await agentEventQueue;
			if (
				pump === this._sessionInputPump &&
				agentEventQueue === this._agentEventQueue &&
				!this._sessionInputPumpRequested &&
				!this.agent.state.isStreaming &&
				this.unfinishedActionCount === 0
			) {
				return;
			}
		}
	}

	/** Waits out any owned post-compaction continuation and rejects when one cannot start; {@link waitForIdle} never rejects. */
	async waitForHeadlessIdle(): Promise<void> {
		while (true) {
			await this.waitForIdle();
			const postCompactionContinuation = this._postCompactionContinuationSettlement?.promise;
			if (!postCompactionContinuation) return;
			await postCompactionContinuation;
		}
	}

	getPendingNextTurnMessageSnapshots(): readonly CustomMessage[] {
		const messages = this._pendingNextTurnMessages.map((message) => cloneCustomMessage(message));
		for (const action of this._actionStore.unfinishedActions()) {
			if (
				action.payload.kind !== "turn" ||
				!action.payload.acceptedAgentMessage ||
				!primaryDeliveryRecord(action).started
			) {
				continue;
			}
			messages.push(
				...action.payload.records
					.filter(
						(record): record is DeliveryRecord & { message: CustomMessage } =>
							(record.role === "next_turn" || record.role === "prefix") &&
							record.message.role === "custom" &&
							!record.durable,
					)
					.map((record) => cloneCustomMessage(record.message)),
			);
		}
		return messages;
	}

	restorePendingNextTurnMessages(messages: readonly CustomMessage[]): void {
		const restored = messages.map((message) => cloneCustomMessage(message));
		// Same two duties as the sidecar reflow: a restored child reply still owes its
		// sender a delivery credit, and it goes ahead of any restored notice so a turn
		// that takes both as next-turn context cannot put the verdict above the reply.
		this._pushPendingNextTurnMessages(
			...restored.filter((message) => isAgentSessionMessage(message)),
			...restored.filter((message) => !isAgentSessionMessage(message)),
		);
		for (const message of restored) this._registerRestoredQueuedChildReply(message);
		this._flushDeferredRlmTerminalNotices();
	}

	removeQueuedFollowUp(queueKey: string): boolean {
		const matching = this._actionStore
			.clearableActions()
			.filter((action) => action.payload.kind === "turn" && action.queueKey === queueKey);
		if (matching.length === 0) return false;
		const error = new Error("Queued agent message was cleared before delivery.");
		for (const action of matching) this._rejectAgentMessage(action.agentMessageId, error);
		const ids = new Set(matching.map((action) => action.id));
		this._cancelSessionActions((action) => ids.has(action.id), error);
		this._emitQueueUpdate();
		return true;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort the turn in flight without cascading into subagents: descendants keep
	 * their own watchdogs and their own cancel entry points (agents view, kill).
	 * `reason` is recorded so the terminal classifier can tell a user Esc from a
	 * stall-watchdog kill; the next agent_start clears it.
	 */
	requestAbort(options?: { reason?: RlmChildTurnAbortReason }): void {
		if (options?.reason) this._lastTurnAbortReason = options.reason;
		for (const run of [...this._unsettledRlmChildRuns]) {
			if (run.status === "cancelled") this._abandonRlmRunForQuiescence(run);
		}
		for (const controller of this._rlmQuiescenceWaitAborts) controller.abort();
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		this._sessionInputPumpSuspended = true;
		this._sessionInputSuspendedForUpdateRestart = false;
		// A plain abort downgrades the update-restart fence to an ordinary
		// suspension, so the teardown admission pause goes with it (QP-2, r39).
		this._updateRestartAdmissionPause?.release();
		this._updateRestartAdmissionPause = undefined;
		// Start the failure-wake quiet window: one aggregated failure wake per Esc,
		// later failures are persisted instead of re-igniting the session (B3).
		this._sessionInputSuspendedSince = Date.now();
		this._failureWakeUsedForSuspension = false;
		this._demoteRlmTerminalNoticeActions();
		this._cancelSessionActions(
			(action) =>
				action.payload.kind === "turn" &&
				!action.payload.queueVisible &&
				!this._durableRlmTerminalNoticeActionIds.has(action.id),
			new Error("Prompt aborted before delivery."),
		);
		this._settleAbortedDispatchedTurnActions();
		this._cancelPostCompactionContinue();
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		this.abortBash();
		this._pendingRequestedRefine = undefined;
		this._autoRefineBranchVersion++;
		this._autoRefineReviewAbort?.abort();
		this._refineAbortController?.abort();
		// DO-4: the watchdog's structured cause rides on the abort signal so every
		// in-flight tool (bash included) and the aborted assistant message report
		// why the turn was killed, not just "Request was aborted".
		this.agent.abort(
			options?.reason === "stall_watchdog" ? formatIpythonAbortCause(this._lastStallAbortCause) : undefined,
		);
	}

	/**
	 * Settle queue-dispatched turn actions that were already delivered into the
	 * agent run when the abort arrived. The pump's deferred-error path only
	 * rolls back undelivered work, so a delivered action stuck in
	 * `committing`/`running` would never reach a terminal state:
	 * `unfinishedActionCount` stays nonzero forever, which keeps `isSessionActive`
	 * true and makes `wait_for_idle` and RLM quiescence hang. The delivered
	 * messages stay in the transcript; only the action lifecycle ends.
	 * Undelivered dispatched work is left to the pump's rollback so it can
	 * re-queue.
	 *
	 * Queue-visible turns and RLM child terminal notices are settled here: a
	 * direct (non-queued) prompt is awaited by its caller and driven through the
	 * ordinary abort flow, and settling it with an error would reject a
	 * `prompt()` that previously resolved normally on abort. Terminal notices
	 * are `queueVisible: false` but have no awaiting caller, and the abort
	 * cancellation predicate spares them as durable work — without settling, a
	 * notice dispatched when the abort arrived would stay committing/running
	 * forever (the pump's deferred-error path does not roll delivered work
	 * back), pinning `unfinishedActionCount` above zero.
	 */
	private _settleAbortedDispatchedTurnActions(): void {
		const transcript = this.agent.state.messages;
		const error = new Error("Prompt aborted after delivery.");
		const dispatched = this._actionStore
			.unfinishedActions()
			.filter(
				(action): action is SessionAction<PreparedTurnPayload> =>
					action.payload.kind === "turn" &&
					(action.payload.queueVisible === true || this._durableRlmTerminalNoticeActionIds.has(action.id)) &&
					(action.lifecycle.state === "committing" || action.lifecycle.state === "running") &&
					(primaryDeliveryRecord(action).durable || transcript.includes(primaryDeliveryRecord(action).message)),
			);
		if (dispatched.length === 0) return;
		for (const action of dispatched) {
			primaryDeliveryRecord(action).durable = true;
			transitionSessionAction(action, { state: "failed", error });
			const ticket = this._actionStore.ticketFor(action);
			ticket.rejectDelivered(error);
			ticket.settleCompleted(error);
			this._settleAgentMessage(action.agentMessageId, "delivery", error);
			this._settleAgentMessage(action.agentMessageId, "completion", error);
		}
		// Leave the terminal actions in the store: the dispatching pump batch still
		// references them and releases them in its finally once the abort error lands
		// (a second release here would make that path look the ticket up twice).
		this._notifySessionInputCheckpointChange();
		this._emitQueueUpdate();
	}

	async abort(): Promise<void> {
		const compactionOperation = this._compactionOperation;
		const branchSummaryOperation = this._branchSummaryOperation;
		this.requestAbort();
		this._abortRlmSubtree("Parent session aborted");
		this._goalAbortInProgress = this._goalState.status === "active";
		try {
			await Promise.allSettled([
				this.agent.waitForIdle(),
				this._agentEventQueue,
				...(compactionOperation ? [compactionOperation] : []),
				...(branchSummaryOperation ? [branchSummaryOperation] : []),
			]);
		} finally {
			this._goalAbortInProgress = false;
		}
	}

	/**
	 * Abort the active run and deliver every queued user steering message in one new turn.
	 * Abort-only when the visible steering queue is empty or the scheduler must stay
	 * suspended; an update-restart suspension is left untouched. steeringMode is never changed.
	 */
	abortAndSendQueued(): boolean {
		// requestAbort would clear the restart flag, letting later admissions resume
		// work during the restart window; abortForUpdateRestart already aborted the run.
		if (this._sessionInputSuspendedForUpdateRestart) {
			return false;
		}
		const queuedSteering = visibleSessionActionProjection(
			this._actionStore.queuedActions("next_turn_boundary"),
		).filter(
			(action) =>
				action.payload.kind === "turn" &&
				!action.payload.acceptedAgentMessage &&
				primaryDeliveryRecord(action).message.role === "user",
		);
		const canResume =
			!this._disposed &&
			!this._disposing &&
			this._sessionInputAdmissionPauses.size === 0 &&
			this._queuedWorkPauses.size === 0;
		if (queuedSteering.length === 0 || !canResume) {
			this.requestAbort();
			return false;
		}
		this._forcedAllSteeringActionIds = new Set(queuedSteering.map((action) => action.id));
		this.requestAbort();
		this.resumeQueuedWork();
		return true;
	}

	private _forcedAllSteeringBatch(first: QueuedSessionAction): ReadonlySet<string> | undefined {
		const armed = this._forcedAllSteeringActionIds;
		if (armed === undefined) return undefined;
		if (first.delivery === "next_turn_boundary" && armed.has(first.id)) return armed;
		if (!this._actionStore.queuedActions("next_turn_boundary").some((action) => armed.has(action.id))) {
			this._forcedAllSteeringActionIds = undefined;
		}
		return undefined;
	}

	abortForUpdateRestart(): void {
		// Cancel scheduled pumps and suspend new ones: queued inputs must survive
		// into the restart manifest instead of starting a turn during teardown.
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		this._sessionInputPumpSuspended = true;
		this._sessionInputSuspendedForUpdateRestart = true;
		// QP-2 (r39): pause admission for the whole teardown window. The restart
		// manifest snapshot is already taken by the time teardown starts, so a
		// message admitted now would answer "queued" and then vanish with the
		// closing session; refusing it with retry semantics (the admission-pause
		// error) lets the sender redeliver after the restart instead. Released when
		// the fence marker is cleared (requestAbort) or the suspension is lifted.
		this._updateRestartAdmissionPause?.release();
		// D1a: the teardown lease is flagged so the queued path's pause refusal
		// reports retryNowSucceeds=false (the session is closing; resend after the
		// restart) instead of luring senders into burning retries against it.
		this._updateRestartAdmissionPause = this.acquireSessionInputPause({ forUpdateRestart: true });
		this._cancelPostCompactionContinue();
		this.abortRetry();
		for (const controller of this._rlmQuiescenceWaitAborts) controller.abort();
		this._abortRlmSubtree("Parent session aborted for update restart");
		this._goalAbortInProgress = this._goalState.status === "active";
		this.agent.abort();
		if (this._goalAbortInProgress) {
			void this.agent
				.waitForIdle()
				.then(() => this._agentEventQueue)
				.catch(() => undefined)
				.finally(() => {
					this._goalAbortInProgress = false;
				});
		}
	}

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	private _queueModelSelectEmit(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		const emit = () =>
			this._modelSelectEmitContext.run(true, () => this._emitModelSelect(nextModel, previousModel, source));
		this._modelSelectEmitQueueIdle = false;
		const promise = this._modelSelectEmitQueue.then(emit, emit);
		const queued = promise.catch(() => {});
		this._modelSelectEmitQueue = queued;
		void queued.finally(() => {
			if (this._modelSelectEmitQueue === queued) {
				this._modelSelectEmitQueueIdle = true;
			}
		});
		return promise;
	}

	async setModel(model: Model<any>, options: ModelSelectOptions = {}): Promise<void> {
		// Explicit selection recovers from a stale-auth lockout, but only a fully
		// validated switch commits the clear (single owner): failed selections never unlock.
		const staleOnly =
			!this._modelRegistry.hasConfiguredAuth(model) &&
			this._modelRegistry.getProviderAuthStatus(model.provider).source === "stale";
		if (!staleOnly && !this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}
		if (!(await this._modelRegistry.canUseModel(model, { assumeAuthConfigured: staleOnly }))) {
			throw new Error(`Model "${model.provider}/${model.id}" is not available for the current Prime team.`);
		}
		if (staleOnly) {
			this._modelRegistry.clearProviderAuthStale(model.provider);
			if (!this._modelRegistry.hasConfiguredAuth(model)) {
				throw new Error(`No API key for ${model.provider}/${model.id}`);
			}
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(model, previousModel, "set");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}
	}

	private _trackModelSelectEmitError(emitPromise: Promise<void>): void {
		void emitPromise.catch((error) => {
			this._extensionRunner.emitError({
				extensionPath: "<internal>",
				event: "model_select",
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		});
	}

	private _shouldWaitForModelSelectEmit(options: ModelSelectOptions): boolean {
		return options.waitForExtensions !== false && !this._modelSelectEmitContext.getStore();
	}

	private _pendingModelSelectEmit(): Promise<void> | undefined {
		if (!this._modelSelectEmitContext.getStore() && !this._modelSelectEmitQueueIdle) {
			return this._modelSelectEmitQueue;
		}
		return undefined;
	}

	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelSelectOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelSelectOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.refreshAvailableModels();
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableModels.some((model) => modelsAreEqual(model, scoped.model)),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);
		const serviceTier = this._getServiceTierForModelSwitch();

		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(next.model, currentModel, "cycle");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}

		return {
			model: next.model,
			thinkingLevel: this.thinkingLevel,
			serviceTier: this.serviceTier,
			isScoped: true,
		};
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelSelectOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.refreshAvailableModels();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(nextModel, currentModel, "cycle");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}

		return {
			model: nextModel,
			thinkingLevel: this.thinkingLevel,
			serviceTier: this.serviceTier,
			isScoped: false,
		};
	}

	setThinkingLevel(level: ThinkingLevel): void {
		// Record the user's requested level as the intent; the effective level is
		// derived per model, so a later model switch re-clamps from what was asked
		// instead of from the value clamped for the previous model.
		this._requestedThinkingLevel = level;
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		if (effectiveLevel !== level && this.model) {
			// Clamping must not be silent: the user asked for one tier and runs another.
			const clampedMessage = `Model ${this.model.provider}/${this.model.id} does not support thinking level "${level}"; using "${effectiveLevel}" instead.`;
			sessionLog.warn(clampedMessage, {
				requested: level,
				effective: effectiveLevel,
				provider: this.model.provider,
				modelId: this.model.id,
			});
			this.sessionManager.appendCustomMessageEntry(THINKING_LEVEL_CLAMPED_CUSTOM_TYPE, clampedMessage, true, {
				requested: level,
				effective: effectiveLevel,
				provider: this.model.provider,
				modelId: this.model.id,
			});
		}

		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
		}
		if (this.supportsThinking() || level !== "off") {
			// Persist the requested level, never the clamped value: the saved default
			// must keep the user's meaning so it survives model switches.
			this.settingsManager.setDefaultThinkingLevel(level);
		}
		if (isChanging) {
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	setServiceTier(serviceTier: ServiceTier): void {
		const effectiveServiceTier = this._getEffectiveServiceTier(serviceTier);
		const preferenceChanged = effectiveServiceTier !== this._serviceTierPreference;
		const effectiveTierChanged = effectiveServiceTier !== this.agent.state.serviceTier;
		if (!preferenceChanged && !effectiveTierChanged) {
			return;
		}
		this._serviceTierPreference = effectiveServiceTier;
		if (preferenceChanged) {
			this.sessionManager.appendServiceTierChange(effectiveServiceTier);
			if (this.model && supportsFastMode(this.model)) {
				this.settingsManager.setDefaultServiceTier(effectiveServiceTier);
			}
		}
		if (effectiveTierChanged) {
			this.agent.state.serviceTier = effectiveServiceTier;
			this._emit({
				type: "service_tier_changed",
				serviceTier: effectiveServiceTier,
			});
		}
	}

	private _getEffectiveServiceTier(serviceTier: ServiceTier): ServiceTier {
		return serviceTier === "priority" && (!this.model || !supportsFastMode(this.model)) ? "default" : serviceTier;
	}

	private _getServiceTierForModelSwitch(): ServiceTier {
		return this._serviceTierPreference;
	}

	private _clampServiceTierForModel(serviceTier: ServiceTier = this.serviceTier): void {
		const effectiveServiceTier = this._getEffectiveServiceTier(serviceTier);
		if (effectiveServiceTier === this.agent.state.serviceTier) {
			return;
		}
		this.agent.state.serviceTier = effectiveServiceTier;
		this._emit({
			type: "service_tier_changed",
			serviceTier: effectiveServiceTier,
		});
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		// Prefer the user's requested level over the effective level clamped for the
		// previous model: setThinkingLevel re-clamps it for the new model.
		return this._requestedThinkingLevel ?? this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	private async _syncKernelStateAfterCompaction(): Promise<void> {
		const provisioner = this._ipythonKernelProvisioner;
		if (!provisioner?.hasRunningKernel) return;
		const snapshot = await provisioner.pruneOversizedVariables().catch(() => null);
		// FR-5: a null write on a kernel with no snapshot machine is not a failed
		// write; the notice must not talk about a snapshot that never existed.
		// Optional probe: an older provisioner (or a test fake) may not expose
		// hasSnapshotTarget; missing it defaults to assuming a snapshot machine.
		const hasSnapshotConfig =
			typeof provisioner.hasSnapshotTarget === "function" ? provisioner.hasSnapshotTarget() : true;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), KERNEL_STATE_LISTING_TIMEOUT_MS);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		let names: string[] | null;
		try {
			names = await provisioner.listNamespaceNames(abort.signal).catch(() => null);
		} finally {
			clearTimeout(timer);
		}
		if (names === null && !provisioner.hasRunningKernel) return;
		const content = [
			"<ipython_state>",
			...compactionKernelStateLines({ snapshot, names, hasSnapshotConfig }),
			"</ipython_state>",
		].join("\n");
		const message = {
			role: "custom" as const,
			customType: "ipython_state",
			content,
			display: false,
			timestamp: Date.now(),
		} satisfies CustomMessage;
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		const insertBeforeError = last?.role === "assistant" && (last as AssistantMessage).stopReason === "error";
		if (insertBeforeError) {
			messages.splice(messages.length - 1, 0, message);
		} else {
			messages.push(message);
		}
		this.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, undefined);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	/**
	 * RT-2: a namespace snapshot write failed outside compaction. The kernel keeps
	 * running, so without this receipt the model keeps treating its namespace as
	 * persisted while only the in-memory stderr ring saw the failure.
	 */
	private _onKernelSnapshotWriteFailure(detail: string): void {
		const content = ["<ipython_state>", ...snapshotFailureNoticeLines(detail), "</ipython_state>"].join("\n");
		void this.sendCustomMessage(
			{
				customType: "ipython_state",
				content,
				display: false,
				details: { snapshotWriteFailed: true },
			},
			{ deliverAs: "nextTurn" },
		).catch(() => {});
	}

	/**
	 * A background prewarm failed (r36 INSB-4/F5): the failure used to be swallowed, so a first
	 * run without network showed the "~30s" progress line and then nothing. Log it and tell the
	 * model on the next turn - the ipython tool retries on first use.
	 */
	private _onIpythonStartupFailure(error: Error): void {
		sessionLog.error("ipython kernel prewarm failed", { sessionId: this.sessionId, message: error.message });
		const content = [
			"<ipython_bootstrap_failed>",
			`Python kernel failed to start: ${error.message}`,
			"The ipython tool will retry on first use; the message above names the underlying cause.",
			"</ipython_bootstrap_failed>",
		].join("\n");
		void this.sendCustomMessage(
			{ customType: "ipython_bootstrap_failed", content, display: true, details: { prewarmFailed: true } },
			{ deliverAs: "nextTurn" },
		).catch(() => {});
	}

	private _onIpythonStateRestored(result: RestoreResult): void {
		if (result.failed.length > 0) {
			sessionLog.error("kernel state restore partial", {
				sessionId: this.sessionId,
				names: result.failed.map((failure) => failure.name),
				snapshotPolicy: result.snapshotPolicy,
			});
		}
		const lines = ["<ipython_state_restored>", ...restoreNoticeLines(result), "</ipython_state_restored>"];
		void this.sendCustomMessage(
			{
				customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
				content: lines.join("\n"),
				display: true,
				details: { restored: result.restored.length > 0 },
			},
			{ deliverAs: "nextTurn" },
		).catch(() => {});
	}

	/**
	 * One bounded wait that ran out of time (P1-1). The `waitedMs` field is the distribution the
	 * tier values get retuned against, so the line is the observable, not just a diagnostic.
	 */
	private _reportAgentMessageWaitTimeout(facts: WaitTimeoutFacts): void {
		sessionLog.warn("agent message target wait timed out", {
			sessionId: this.sessionId,
			target: facts.target,
			phase: facts.phase,
			waitedMs: facts.waitedMs,
			...(facts.targetState === undefined ? {} : { targetState: facts.targetState }),
		});
	}

	/**
	 * A host request that finished after the kernel that asked for it was gone (I-6). The reply is
	 * lost, but the work is not: for a spawn the child exists and is on the roster, which is the
	 * fact that stops a model from spawning the same worker twice after a kernel death.
	 */
	private _reportLateKernelHostReply(reply: KernelLateHostReply): void {
		const spawnedName = reply.label?.startsWith("name=") ? reply.label.slice("name=".length) : undefined;
		const alreadyRegistered =
			spawnedName === undefined
				? undefined
				: [...this._activeRlmChildRuns.values()].some((run) => run.sessionName === spawnedName);
		sessionLog.warn("late kernel host reply", {
			sessionId: this.sessionId,
			requestId: reply.requestId,
			type: reply.type,
			ok: reply.ok,
			...(reply.label === undefined ? {} : { label: reply.label }),
			...(alreadyRegistered === undefined ? {} : { childAlreadyRegistered: alreadyRegistered }),
		});
	}

	/**
	 * A kernel death the host did not order. The manager's stderr ring never leaves the host
	 * process, so this line is the only per-session trace of the cause (code/signal/origin), and
	 * the origin is what keeps a protocol-repair kill out of the crash statistics.
	 */
	private _reportUnexpectedKernelExit(cause: KernelDeathCause, facts: KernelUnexpectedExitFacts): void {
		const { decision, unresolvedHostRequests } = facts;
		const fields = {
			sessionId: this.sessionId,
			code: cause.code,
			signal: cause.signal,
			origin: cause.origin,
			stderrTail: cause.stderrTail.slice(-KERNEL_DEATH_STDERR_LOG_CHARS),
			restartCount: decision.restartCount,
			budgetRemaining: decision.budgetRemaining,
			...(decision.sincePreviousMs === undefined ? {} : { sincePreviousMs: decision.sincePreviousMs }),
			unresolvedHostRequests: unresolvedHostRequests.map((request) => request.type),
		};
		if (decision.exhausted) {
			// Appendix B signature: an unattended session in this state produces nothing but
			// errors until the window expires or a human reloads it, so it has to be countable.
			sessionLog.error("kernel budget exhausted", {
				...fields,
				windowMinutes: Math.round(decision.windowMs / 60_000),
				scheduledJobs: this._hasScheduledWork(),
			});
			return;
		}
		sessionLog.error("kernel exited unexpectedly", fields);
		if (!decision.revive) return;
		// F2: the burn is observable per revival, and a crash loop is louder than one crash.
		const line = {
			sessionId: this.sessionId,
			restartCount: decision.restartCount,
			budgetRemaining: decision.budgetRemaining,
			lastOrigin: cause.origin,
		};
		if (decision.sincePreviousMs !== undefined && decision.sincePreviousMs < KERNEL_FAST_RESTART_GAP_MS) {
			sessionLog.warn("kernel restarts are coming fast; the budget will fail the session closed", line);
			return;
		}
		sessionLog.info("kernel revival armed", line);
	}

	/**
	 * Whether anything can start a turn in this session without a human (a heartbeat or cron
	 * job). An unattended session that fails closed burns tokens on errors nobody reads, so the
	 * budget-exhausted signature carries the fact.
	 */
	private _hasScheduledWork(): boolean {
		try {
			const jobs = this._rlmHeartbeatController?.listRlmHeartbeats();
			return (jobs ?? []).some((job) => job.status === "active");
		} catch {
			return false;
		}
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	async compact(customInstructions?: string, options: { skipAbort?: boolean } = {}): Promise<CompactionResult> {
		if (options.skipAbort && this.isStreaming) {
			throw new Error("Cannot compact without aborting while the agent is running.");
		}
		// r25-1: manual compaction admission must be synchronous. The body below
		// publishes _compactionOperation only after `await this.abort()`, so two
		// concurrent compact() calls used to both pass this point, overwrite each
		// other's abort controller, and record two compactions. A second caller
		// coalesces onto the in-flight operation instead (same gate shape as the
		// navigateTree _branchNavigationQueue chain), so exactly one compaction
		// runs and abortCompaction() always reaches the live scope.
		// K3R-7: coalescing is only honest when the second caller asked for the
		// same compaction. Different customInstructions used to be silently
		// dropped - the second caller received the first's result and its
		// instructions never ran anywhere. Those now queue behind the in-flight
		// compaction and get their own run, and the merge is logged.
		const inFlight = this._manualCompactionInFlight;
		if (inFlight) {
			if (customInstructions !== inFlight.customInstructions) {
				sessionLog.warn(
					"manual compaction coalesced: a second compact with different instructions queues behind the in-flight one",
					{ sessionId: this.sessionId, queuedInstructions: customInstructions ?? null },
				);
				return inFlight.operation.catch(() => undefined).then(() => this.compact(customInstructions, options));
			}
			return inFlight.operation;
		}
		// K3R-7 (F6): a manual compact preempts an in-flight auto compaction
		// instead of queueing a second full compaction behind it on the
		// just-compacted context (double LLM compaction, or an "Already
		// compacted" failure). Aborting the auto scope settles it as cancelled;
		// the wait in _compact then proceeds into this manual run.
		// K3R-11: the preempted scope is marked so its catch keeps the queued
		// continuations alive (a manual /compact is not the user cancelling them).
		const preemptedAutoCompaction = this._autoCompactionAbortController;
		if (preemptedAutoCompaction) {
			this._autoCompactionPreemptedByManual = preemptedAutoCompaction;
			preemptedAutoCompaction.abort();
		}
		const operation = this._compact(customInstructions, options);
		this._manualCompactionInFlight = { operation, customInstructions };
		try {
			return await operation;
		} finally {
			if (this._manualCompactionInFlight?.operation === operation) {
				this._manualCompactionInFlight = undefined;
			}
			// K3R-11: _compact()'s abort() suspends the session input pump, which is
			// what delivers the continuations the preempted auto compaction left
			// queued. Revive it so the preserved work runs after this compaction -
			// unless teardown fenced the queue meanwhile (QP-1, r39): the fence
			// outranks the revival, same as the other queue-mutation resumes.
			if (preemptedAutoCompaction) this._resumeQueuedWorkUnlessFenced();
		}
	}

	private async _compact(
		customInstructions?: string,
		options: { skipAbort?: boolean } = {},
	): Promise<CompactionResult> {
		// Serialize against an auto compaction that was still registering when
		// abort() snapshotted _compactionOperation; wait it out before running.
		const autoCompactionOperation = this._compactionOperation;
		if (autoCompactionOperation) {
			await autoCompactionOperation.catch(() => undefined);
		}
		// MVS-2: this run is the compaction that actually restructures the context,
		// so a pending compact.run request is satisfied by it - and, exactly like the
		// auto path ("any compaction consumes a pending model request and honors its
		// instructions"), the request's instructions join this run's instead of
		// vanishing. The pending state itself is only cleared on success below; on
		// failure the request stays scheduled for the next turn boundary.
		const pendingRequestedCompaction = this._pendingRequestedCompaction;
		const effectiveCustomInstructions = joinCompactionInstructions(
			customInstructions,
			pendingRequestedCompaction?.customInstructions,
		);
		const hadPostCompactionContinue = this._postCompactionContinuationScheduled;
		const continueAfterSessionInput = this._postCompactionContinuationSettlement?.continueAfterSessionInput ?? false;
		this._disconnectFromAgent();
		if (!options.skipAbort) await this.abort();
		let didCompact = false;
		const compactionAbort = new AbortController();
		this._compactionAbortController = compactionAbort;
		let resolveCompactionOperation: () => void = () => {};
		const compactionOperation = new Promise<void>((resolve) => {
			resolveCompactionOperation = resolve;
		});
		this._compactionOperation = compactionOperation;
		this._emit({
			type: "compaction_start",
			reason: "manual",
			customInstructions: effectiveCustomInstructions,
		});

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers, requestModel } = await this._getRequiredRequestAuth(this.model);
			const result = await this._performCompaction({
				model: requestModel,
				apiKey,
				headers,
				customInstructions: effectiveCustomInstructions,
				signal: compactionAbort.signal,
			});

			this._emit({
				type: "compaction_end",
				reason: "manual",
				result,
				aborted: false,
				willRetry: false,
				customInstructions: effectiveCustomInstructions,
			});
			didCompact = true;
			// Manual compaction restructures the context; drop any stale threshold cooldown.
			this._thresholdCompactionCooldown = undefined;
			this._clearCompactionFailures();
			// A manual compaction satisfies any pending model request; on failure the
			// request stays scheduled for the next turn boundary.
			this._pendingRequestedCompaction = undefined;
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			const skipped = error instanceof CompactionSkippedError;
			// A manual /compact that fails is the user already trying to recover, so a
			// repeating failure has to surface the remaining options where they will be
			// read: the thrown message is what the slash-command result prints.
			const recoveryHint = aborted || skipped ? "" : this._registerCompactionFailure();
			// Same valve as the auto path: a user hammering /compact on a context whose
			// summarization keeps failing is already trying to recover by hand, and the
			// shrink is the one thing that works without a bigger window. An abort or a
			// skip is not a failure to summarize, so neither counts toward the streak.
			if (!aborted && !skipped) await this._runEmergencyContextShrink("requested", message);
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : skipped ? message : `Compaction failed: ${message}${recoveryHint}`,
				errorSeverity: skipped ? "warning" : "error",
				customInstructions: effectiveCustomInstructions,
			});
			if (recoveryHint && error instanceof Error) {
				throw new Error(`${error.message}${recoveryHint}`, { cause: error });
			}
			// K3R-7 follow-up (r28): a skipped manual compact never consumed its
			// customInstructions anywhere - a queued second compact re-entering after
			// the first settled hits "Already compacted" and the instructions silently
			// die. A bare "Already compacted" does not say that; name the loss.
			if (skipped && customInstructions !== undefined) {
				throw new CompactionSkippedError(`${message} — the custom instructions were not applied`, {
					cause: error,
				});
			}
			throw error;
		} finally {
			if (this._compactionAbortController === compactionAbort) {
				this._compactionAbortController = undefined;
			}
			this._reconnectToAgent();
			if (this._compactionOperation === compactionOperation) {
				this._compactionOperation = undefined;
			}
			resolveCompactionOperation();
			this._notifySessionInputCheckpointChange();
			this._scheduleSessionInputPump();
			if (didCompact) {
				this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
				if (this._goalState.status === "active" && !compactionAbort.signal.aborted) {
					this._goalContinuationAwaitsRlmWork ||= !this.agent.hasQueuedMessages();
					// Fork adaptation: a compaction must not lift the update-restart fence.
					// A queued /compact runs with skipAbort, so a restart landing mid-compaction
					// still holds the fence here; the armed continuation then waits for the
					// restart instead of opening a goal turn during teardown.
					if (!this._updateRestartFenceUp) this.resumeQueuedWork();
					if (this.agent.hasQueuedMessages()) this._schedulePostCompactionContinue();
				}
				if (hadPostCompactionContinue) {
					this._schedulePostCompactionContinue(continueAfterSessionInput);
				}
				// Queued agent or session-owned inputs resume the loop; defer refine
				// behind them instead of interleaving it before their turns.
				this._scheduleAutoRefineAfterCompaction(
					this._goalContinuationAwaitsRlmWork ||
						hadPostCompactionContinue ||
						this.agent.hasQueuedMessages() ||
						this.unfinishedActionCount > 0,
				);
			}
		}
	}

	/**
	 * Compaction settings for this attempt, with the failure valve applied.
	 *
	 * From the second consecutive failure on, each retry halves keepRecentTokens
	 * (floor MIN_SHRUNK_KEEP_RECENT_TOKENS, never above the configured value): a
	 * summarization request that keeps failing is usually failing because the slice
	 * it has to carry does not fit the provider's input limit, and a smaller
	 * retained tail is the one knob that shrinks the request without user input.
	 */
	private _compactionSettingsForAttempt(): CompactionSettings {
		const configured = this.settingsManager.getCompactionSettings();
		const keepRecentTokens = shrunkKeepRecentTokens(configured.keepRecentTokens, this._consecutiveCompactionFailures);
		if (keepRecentTokens === configured.keepRecentTokens) return configured;
		sessionLog.warn("compaction retry with a shrunk keep-recent budget", {
			sessionId: this.sessionId,
			consecutiveFailures: this._consecutiveCompactionFailures,
			configuredKeepRecentTokens: configured.keepRecentTokens,
			keepRecentTokens,
		});
		return { ...configured, keepRecentTokens };
	}

	/**
	 * Shared compaction core behind /compact, auto-compaction, and the compact
	 * skill. Throws CompactionSkippedError when there is nothing to compact and
	 * Error("Compaction cancelled") on abort or extension cancel.
	 */
	private async _performCompaction(options: {
		model: Model<any>;
		apiKey: string;
		headers?: Record<string, string>;
		customInstructions?: string;
		signal: AbortSignal;
	}): Promise<CompactionResult> {
		const { model, apiKey, headers, customInstructions, signal } = options;
		const pathEntries = this.sessionManager.getBranch();
		const settings = this._compactionSettingsForAttempt();
		// Pin the branch position for the duration of the summarization call. If
		// the user navigates the tree while the summary is being generated, the
		// resulting entry still attaches to the branch it summarized.
		const compactionLeafId = this.sessionManager.getLeafId();

		const preparation = prepareCompaction(pathEntries, settings, model.contextWindow, {
			provider: model.provider,
			modelId: model.id,
		});
		if (!preparation) {
			const lastEntry = pathEntries[pathEntries.length - 1];
			if (lastEntry?.type === "compaction") {
				throw new CompactionSkippedError("Already compacted");
			}
			throw new CompactionSkippedError("Session is too short to compact — try again once it grows");
		}

		let extensionCompaction: CompactionResult | undefined;
		let fromExtension = false;

		const semanticCompaction = this._semanticEdges.beginCompaction();
		let compactionRecorded = false;
		const uncommittedSlices: string[] = [];
		let compactionSettled = false;
		let summary: string;
		let firstKeptEntryId: string;
		let tokensBefore: number;
		let details: CompactionResult["details"];
		let usage: CompactionResult["usage"];
		try {
			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			if (extensionCompaction) {
				({ summary, firstKeptEntryId, tokensBefore, details, usage } = extensionCompaction);
			} else {
				// Each summary wire call gets its own request ID: split turns send two
				// different bodies, and one Idempotency-Key must never cover both. A slice
				// that succeeds on the wire stays uncommitted until the compaction itself
				// commits: a racing sibling's failure (or an abort) must leave no committed
				// summary request for the next turn's continuation edge to attach to.
				const summaryCall = async <T>(
					call: (callHeaders: Record<string, string> | undefined) => Promise<T>,
				): Promise<T> => {
					const requestId = this._semanticEdges.startCompactionRequest(semanticCompaction.compactionId);
					if (requestId === undefined) {
						return call(headers);
					}
					try {
						const result = await call({ ...headers, ...modelRequestHeaders(requestId) });
						// A slice resolving after a sibling's rejection already settled the
						// compaction would push into a drained list and stay in-flight forever.
						if (compactionSettled) {
							this._semanticEdges.failRequest(requestId);
						} else {
							uncommittedSlices.push(requestId);
						}
						return result;
					} catch (error) {
						this._semanticEdges.failRequest(requestId);
						throw error;
					}
				};
				({ summary, firstKeptEntryId, tokensBefore, details, usage } = await compact(
					preparation,
					model,
					apiKey,
					headers,
					customInstructions,
					signal,
					this.thinkingLevel,
					summaryCall,
					providerRetryPolicy(this.settingsManager),
					this.sessionId,
				));
			}

			if (signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			// Ledger-before-effect: the compaction outcome is durable before the transcript
			// commits it. Marked first: the ID is consumed even when the write throws, and a
			// second finish attempt would mask the original I/O error.
			compactionRecorded = true;
			compactionSettled = true;
			for (const requestId of uncommittedSlices.splice(0)) {
				this._semanticEdges.finishRequest(requestId);
			}
			this._semanticEdges.finishCompaction(semanticCompaction.compactionId, "completed");
			// Attached mechanically at the new head; the digest never flows through
			// the summarizer LLM, and its fingerprint lets the next cold boundary
			// skip re-delivering an unchanged state.
			const { digest: harnessDigest, stateFingerprint: harnessStateFingerprint } =
				this._harnessDigestWithFingerprint();
			this.sessionManager.appendCompaction(
				summary,
				firstKeptEntryId,
				tokensBefore,
				details,
				fromExtension,
				customInstructions,
				{
					leafId: compactionLeafId ?? undefined,
					usage,
					harnessDigest,
					harnessStateFingerprint,
					// Issue #19 forensics: SessionManager has no logger, and these fields
					// must not ride in `details` (the next compaction reads the previous
					// entry's details back to seed its fact/user-request ledgers). The
					// caller owns the log line.
					onCommit: (info) => {
						sessionLog.info("compaction committed", {
							sessionId: this.sessionId,
							...info,
						});
					},
				},
			);
		} catch (error) {
			compactionSettled = true;
			for (const requestId of uncommittedSlices.splice(0)) {
				this._semanticEdges.failRequest(requestId);
			}
			if (!compactionRecorded) {
				const cancelled =
					error instanceof Error && (error.name === "AbortError" || error.message === "Compaction cancelled");
				this._semanticEdges.finishCompaction(semanticCompaction.compactionId, cancelled ? "cancelled" : "failed");
			}
			throw error;
		}
		const newEntries = this.sessionManager.getEntries();
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		this._mergeUnpersistedOutcomes(this.agent.state.messages);
		this._restoreLateIpythonSentAgentMessages();

		const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
			| CompactionEntry
			| undefined;
		if (savedCompactionEntry) {
			await this._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			});
		}
		await this._syncKernelStateAfterCompaction();
		await this._reapDeletedRlmSubagentRuntimesAfterCompaction();

		return { summary, firstKeptEntryId, tokensBefore, details };
	}

	private async _reapDeletedRlmSubagentRuntimesAfterCompaction(): Promise<void> {
		const childIds = [...this._rlmChildCleanupFailures.keys()].filter(
			(childId) => !this._activeRlmChildRuns.get(childId)?.detachedDeletion,
		);
		await Promise.allSettled(childIds.map((childId) => this.deleteRlmSubagent(childId)));
	}

	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	private _localHarnessStateDir(): string | undefined {
		return (
			getLocalHarnessStateDir(this.sessionManager.ensureSessionArtifactDir()) ??
			(this._rlmSessionDir ? getLocalHarnessStateDir(this._rlmSessionDir) : undefined)
		);
	}

	private _autoRefineAllowedForSession(): boolean {
		if (!isPersistentHarnessStorageSupported() || this._rlmDepth !== 0) return false;
		// The cache is consulted before anything is resolved, so a hit costs no I/O at
		// all: _localHarnessStateDir() can mkdir the session artifact directory, and
		// loading the harness state walks every path segment and parses the whole local
		// store. This runs on the event queue, several times per turn.
		const probe = this._autoRefineWritableProbe;
		if (probe !== undefined && Date.now() - probe.at < AUTO_REFINE_WRITABLE_PROBE_TTL_MS) return probe.allowed;
		// One call, one local: this used to call _localHarnessStateDir() twice, the
		// second time behind a non-null assertion. A missing directory is deliberately
		// not cached, because it can appear later.
		//
		// A false verdict is cached too. Re-probing at every turn boundary is what this
		// cache exists to avoid, and the cost of a stale false is at most one TTL of
		// skipped auto-refine; the hard preflight before an actual refine still catches a
		// genuinely unwritable store.
		const dir = this._localHarnessStateDir();
		if (dir === undefined) return false;
		let allowed = false;
		try {
			assertHarnessStateWritable(loadHarnessState(dir, "local"));
			allowed = true;
		} catch {
			allowed = false;
		}
		this._autoRefineWritableProbe = { at: Date.now(), allowed };
		return allowed;
	}

	private _settlePostCompactionContinue(error?: Error): void {
		if (!error && this._postCompactionContinuationScheduled) return;
		const settlement = this._postCompactionContinuationSettlement;
		if (!settlement || settlement.settled) return;
		settlement.settled = true;
		this._postCompactionContinuationSettlement = undefined;
		if (error) settlement.reject(error);
		else settlement.resolve();
		this._notifySessionInputCheckpointChange();
	}

	private _cancelPostCompactionContinue(): void {
		this._postCompactionContinuationScheduled = false;
		this._scheduledPostCompactionContinuationMessages = [];
		this._settlePostCompactionContinue();
	}

	private _discardPendingAutoRefine(options: { cancelPostCompactionContinue?: boolean } = {}): void {
		this._compactAutoRefinePending = false;
		this._turnIntervalAutoRefinePending = false;
		this._pendingAutoRefineReview = undefined;
		if (options.cancelPostCompactionContinue) {
			this._cancelPostCompactionContinue();
		}
	}

	private async _invalidatePendingAutoRefineForBranchChange(): Promise<void> {
		this._autoRefineReviewAbort?.abort();
		this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
		this._assistantTurnsSinceAutoRefine = 0;
		// Drop the cached verdict so the next refine re-probes. The branch change does
		// not move the session directory, so this is not about a new target: the probe
		// is only advisory. What actually stops a write to an unwritable harness state
		// is saveHarnessState re-asserting against the real target directory and
		// letting the syscall error propagate.
		this._autoRefineWritableProbe = undefined;
		// Increment branch version BEFORE aborting/awaiting the serialized plan.
		// This invalidates the plan's branchVersion check at the boundary
		// so even if the plan completes, the boundary will reject it
		// (bgResult.branchVersion !== this._autoRefineBranchVersion).
		this._autoRefineBranchVersion++;
		// Abort the in-flight refine/bplan controller so any pending
		// _planRefine or _reviewAutoRefine call settles via signal abort
		// rather than hanging forever.
		this._refineAbortController?.abort();
		if (this._serializedPlanInFlight) {
			await this._consumeSerializedBackgroundPlan(async () => false);
		}
		while (this._refinePlanInFlight) {
			await this._refinePlanInFlight;
		}
		await this._waitForRefineIdle();
	}

	/**
	 * Consume a refine request that was scheduled by the agent-callable refine
	 * skill (refine.run). Fire-and-forget: the refine() method handles its own
	 * background planning, idle wait, application, and error recovery. Called
	 * at the turn boundary after compaction checks and before auto-refine
	 * scheduling so the manual request takes priority.
	 */
	private _refineFailureReceipts = new WeakSet<object>();
	private _emitRefineFailed(error: unknown, scope: HarnessScope = "local"): void {
		// Idempotent per error object: refine() failures are reported by the direct
		// path AND by queued/auto callers that catch the same rethrown error; the
		// first receipt wins and later calls on the same error are no-ops.
		if (error instanceof Object && this._refineFailureReceipts.has(error)) return;
		const reason = error instanceof Error ? error.message : String(error);
		// MV-5: the requested scope is the caller's guess; a persist failure
		// knows the effective target scope (a local request can roll back a
		// global record) and the receipt must carry that one.
		const effectiveScope = error instanceof RefinePersistScopeError ? error.scope : scope;
		this._emit({
			type: "refine_failed",
			error: reason,
		});
		// MV-5: every refinement failure - plan parse, length guard, provider
		// error, or the persist rejection above - leaves a model-visible receipt,
		// the same surface successes use (e6c1af56). Without it the failure was
		// UI/event-only and the model never learned its refine.run produced
		// nothing. A skip is a deliberate decline, not a failure: it stays
		// event-only. K3R-8/F9: the skip early-return comes BEFORE the receipt-set
		// add - a reused skip sentinel must not be permanently silenced, and only
		// a value that actually produced a receipt guards later calls.
		if (error instanceof RefineSkippedError) return;
		if (error instanceof Object) this._refineFailureReceipts.add(error);
		this._recordRefinementFailureReceipt(reason, effectiveScope);
	}

	private _recordRefinementFailureReceipt(reason: string, scope: HarnessScope): void {
		const message = createRefinementFailureMessage({
			refinementId: generateRefinementId(),
			scope,
			reason,
		});
		try {
			this.sessionManager.appendCustomMessageEntryWithRollback(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} catch (error) {
			const persistenceError = error instanceof Error ? error.message : String(error);
			// Same disclosure rule as compaction outcomes: the receipt stays
			// model-visible for this process and says it could not be saved.
			const unpersisted = createRefinementFailureMessage(
				{ refinementId: message.details.refinementId, scope, reason },
				true,
				message.timestamp,
			);
			unpersisted.content = `${message.content}\n\nThis refinement failure receipt could not be saved to session history: ${persistenceError}`;
			this._unpersistedOutcomes.push(unpersisted);
			this.agent.state.messages.push(unpersisted);
			this._emit({ type: "message_start", message: unpersisted });
			this._emit({ type: "message_end", message: unpersisted });
			return;
		}
		this.agent.state.messages.push(message);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private _consumePendingRequestedRefine(): boolean {
		const pending = this._pendingRequestedRefine;
		if (!pending) return false;
		this._pendingRequestedRefine = undefined;
		void this.refine(pending).catch((error) => this._emitRefineFailed(error, pending.global ? "global" : "local"));
		return true;
	}

	private _scheduleAutoRefineAfterAgentEnd(): void {
		if (!this._autoRefineAllowedForSession()) {
			return;
		}
		if (this._pendingAutoRefineReview) {
			this._scheduleAutoRefine(this._pendingAutoRefineReview.reason);
			return;
		}
		if (this._compactAutoRefinePending) {
			if (this._postCompactionContinuationScheduled) {
				return;
			}
			this._scheduleAutoRefine("compact");
			return;
		}

		this._scheduleAutoRefine("turn_interval");
	}

	private _scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void {
		if (!this._autoRefineAllowedForSession()) {
			return;
		}
		if (this._serializedRefine) {
			// Serialized sessions must service compaction-triggered refinement at
			// shouldStopAfterTurn (or disposal), never through the interactive path.
			this._compactAutoRefinePending = true;
			return;
		}
		if (willContinueAfterCompaction) {
			this._compactAutoRefinePending = true;
			return;
		}

		this._scheduleAutoRefine("compact");
	}

	private _schedulePostCompactionContinue(continueAfterSessionInput = false): void {
		if (!this._postCompactionContinuationSettlement || this._postCompactionContinuationSettlement.settled) {
			this._postCompactionContinuationSettlement = createPostCompactionContinuationSettlement();
		}
		const settlement = this._postCompactionContinuationSettlement;
		settlement.continueAfterSessionInput ||= continueAfterSessionInput;
		if (this._postCompactionContinuationScheduled) {
			return;
		}
		this._postCompactionContinuationScheduled = true;
		this._scheduledPostCompactionContinuationMessages = [...this._postCompactionContinuationMessages];
		void this._runScheduledPostCompactionContinue(settlement)
			.catch(() => undefined)
			.finally(() => {
				if (this._postCompactionContinuationSettlement === settlement) {
					this._settlePostCompactionContinue();
				}
			});
	}

	private _sessionOwnsScheduledContinuations(continuationMessages: AgentMessage[]): boolean {
		return continuationMessages.some((message) => this._postCompactionContinuationMessages.includes(message));
	}

	private async _waitForQueuedWorkResume(settlement: PostCompactionContinuationSettlement): Promise<void> {
		while (this._queuedWorkPauses.size > 0 && this._postCompactionContinuationSettlement === settlement) {
			let resume = () => {};
			const resumed = new Promise<void>((resolve) => {
				resume = resolve;
				this._sessionInputCheckpointWaiters.add(resolve);
			});
			try {
				await Promise.race([resumed, settlement.promise]);
			} finally {
				this._sessionInputCheckpointWaiters.delete(resume);
			}
		}
	}

	private async _runScheduledPostCompactionContinue(settlement: PostCompactionContinuationSettlement): Promise<void> {
		while (this._postCompactionContinuationScheduled && this._postCompactionContinuationSettlement === settlement) {
			await this.agent.waitForIdle();
			await this.waitForRetry();
			await this._waitForRefineIdle();
			await this._waitForQueuedWorkResume(settlement);
			const compactionOperation = this._compactionOperation;
			if (compactionOperation) {
				await Promise.race([compactionOperation, settlement.promise]);
				continue;
			}

			const commitFence = await this._acquireSessionActionCommitFence();
			let continuation: Promise<void> | undefined;
			let continuationMessages: AgentMessage[] = [];
			let waitForSessionInput = false;
			try {
				await this.agent.waitForIdle();
				if (
					!this._postCompactionContinuationScheduled ||
					this._postCompactionContinuationSettlement !== settlement
				) {
					return;
				}

				if (this._queuedWorkPauses.size > 0 || this._compactionOperation || this._refineInFlight) {
					continue;
				}

				continuationMessages = [...this._scheduledPostCompactionContinuationMessages];
				if (continuationMessages.length > 0 && !this._sessionOwnsScheduledContinuations(continuationMessages)) {
					this._cancelPostCompactionContinue();
					this._scheduleAutoRefineAfterAgentEnd();
					return;
				}
				if (this.unfinishedActionCount > 0 || this._sessionInputPumpRequested) {
					this._scheduleSessionInputPump();
					waitForSessionInput = true;
				} else {
					this._postCompactionContinuationScheduled = false;
					continuation = this.agent.continue();
				}
			} finally {
				commitFence.release();
			}

			if (waitForSessionInput) {
				await this._waitForIdleOrSettlement(settlement);
				if (this._postCompactionContinuationSettlement !== settlement) return;
				const shouldContinue =
					(settlement.continueAfterSessionInput && continuationMessages.length === 0) ||
					this._sessionOwnsScheduledContinuations(continuationMessages);
				if (shouldContinue) {
					this._scheduledPostCompactionContinuationMessages = [...this._postCompactionContinuationMessages];
					continue;
				}
				this._postCompactionContinuationScheduled = false;
				this._scheduledPostCompactionContinuationMessages = [];
				this._scheduleAutoRefineAfterAgentEnd();
				return;
			}

			try {
				await continuation;
				if (this._postCompactionContinuationSettlement === settlement) {
					this._forgetConsumedPostCompactionContinuations(continuationMessages);
				}
				return;
			} catch (error) {
				const code = error instanceof AgentContinueError ? error.code : undefined;
				if (code === "busy") {
					if (this._postCompactionContinuationSettlement === settlement) {
						this._postCompactionContinuationScheduled = true;
						this._scheduledPostCompactionContinuationMessages = [...this._postCompactionContinuationMessages];
					}
					continue;
				}
				if (code !== "nothing-to-continue" && this._postCompactionContinuationSettlement === settlement) {
					this._settlePostCompactionContinue(this._asError(error));
				}
				return;
			}
		}
	}

	private _forgetConsumedPostCompactionContinuations(continuationMessages: AgentMessage[]): void {
		if (continuationMessages.length === 0) {
			return;
		}
		const continuationMessageSet = new Set(continuationMessages);
		const stillQueued = new Set(this.agent.removeQueuedMessages((message) => continuationMessageSet.has(message)));
		for (const message of stillQueued) {
			this.agent.followUp(message);
		}
		for (const message of continuationMessages) {
			if (!stillQueued.has(message)) {
				this._queuedAutonomousContinuationSnapshots.delete(message);
			}
		}
		this._postCompactionContinuationMessages = this._postCompactionContinuationMessages.filter(
			(message) => !continuationMessageSet.has(message) || stillQueued.has(message),
		);
	}

	private _shouldSkipAutoRefineForActiveAgent(): boolean {
		return this.isStreaming || this.isCompacting;
	}

	private _scheduleDeferredAutoRefineIfIdle(): void {
		if (this._autoRefineInProgress || this._shouldSkipAutoRefineForActiveAgent() || this._pendingAutoRefineReview) {
			return;
		}
		if (this._turnIntervalAutoRefinePending) {
			this._turnIntervalAutoRefinePending = false;
			this._scheduleAutoRefine("turn_interval");
		}
	}

	private _scheduleAutoRefine(reason: AutoRefineReason, branchVersion = this._autoRefineBranchVersion): void {
		const timer = setTimeout(() => {
			this._scheduledAutoRefineTimers.delete(timer);
			if (branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			const operation = this._maybeAutoRefine(reason);
			this._autoRefineOperations.add(operation);
			void operation.finally(() => this._autoRefineOperations.delete(operation)).catch(() => undefined);
		}, 0);
		this._scheduledAutoRefineTimers.add(timer);
	}

	private async _maybeAutoRefine(reason: AutoRefineReason): Promise<void> {
		if (this._disposed || this._disposing) {
			this._discardPendingAutoRefine();
			return;
		}
		if (!this._autoRefineAllowedForSession()) {
			this._discardPendingAutoRefine();
			return;
		}

		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			this._discardPendingAutoRefine();
			return;
		}
		if (this._autoRefineInProgress || this._shouldSkipAutoRefineForActiveAgent()) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			} else {
				this._turnIntervalAutoRefinePending = true;
			}
			return;
		}

		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;

		const pendingReview = this._pendingAutoRefineReview;
		if (pendingReview) {
			// A failed refine stamps the cooldown; keep the pending review for later.
			if (underCooldown) {
				return;
			}
			await this._runApprovedRefine(pendingReview.reason, pendingReview.review);
			return;
		}

		if (reason === "compact" && !settings.compact) {
			this._compactAutoRefinePending = false;
			reason = "turn_interval";
		}
		if (reason === "turn_interval" && this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		if (underCooldown) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			} else {
				this._turnIntervalAutoRefinePending = true;
			}
			return;
		}
		if (reason === "turn_interval") {
			this._turnIntervalAutoRefinePending = false;
		}
		if (!this.model) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			}
			return;
		}
		this._autoRefineInProgress = true;
		const turnsSinceLastReview = this._assistantTurnsSinceAutoRefine;
		const branchVersion = this._autoRefineBranchVersion;
		const reviewAbort = new AbortController();
		this._autoRefineReviewAbort = reviewAbort;
		let approvedReview: AutoRefineReview | undefined;
		try {
			const review = await this._reviewAutoRefine({ reason, turnsSinceLastReview }, reviewAbort.signal);
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			if (!review.shouldRefine) {
				const preserveTurnIntervalReview =
					reason === "compact" && this._assistantTurnsSinceAutoRefine >= settings.turnInterval;
				if (preserveTurnIntervalReview) {
					this._turnIntervalAutoRefinePending = true;
				} else {
					this._lastAutoRefineReviewAt = nowMs;
					this._assistantTurnsSinceAutoRefine = 0;
				}
				if (reason === "compact") {
					this._compactAutoRefinePending = false;
				}
				return;
			}
			if (this._shouldSkipAutoRefineForActiveAgent()) {
				this._pendingAutoRefineReview = { reason, review };
				return;
			}
			approvedReview = review;
		} catch {
			// Failed review: stamp the cooldown so a persistent failure (bad auth,
			// unparseable output) doesn't retry a full review on every agent end.
			if (branchVersion === this._autoRefineBranchVersion) {
				this._lastAutoRefineReviewAt = Date.now();
			}
		} finally {
			if (this._autoRefineReviewAbort === reviewAbort) {
				this._autoRefineReviewAbort = undefined;
			}
			this._autoRefineInProgress = false;
			// When a refine follows, _runApprovedRefine schedules the deferred pass.
			if (!approvedReview) {
				this._scheduleDeferredAutoRefineIfIdle();
			}
		}
		if (approvedReview) {
			await this._runApprovedRefine(reason, approvedReview);
		}
	}

	private async _runApprovedRefine(reason: AutoRefineReason, review: AutoRefineReview): Promise<void> {
		this._autoRefineInProgress = true;
		try {
			await this.refine({ instructions: autoRefineInstructions(reason, review) }, { trigger: "auto" });
			this._pendingAutoRefineReview = undefined;
			this._turnIntervalAutoRefinePending = false;
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
			if (reason === "compact") {
				this._compactAutoRefinePending = false;
			}
		} catch (error) {
			// Auto-refine is opportunistic; manual /refine remains available.
			// Stamp the cooldown so a persistently failing refine doesn't retry
			// (via a retained pending review) on every agent end.
			this._lastAutoRefineReviewAt = Date.now();
			if (error instanceof RefineSkippedError) {
				// A skipped round is consumed like a reviewer decline, not retained for retry.
				this._pendingAutoRefineReview = undefined;
				this._turnIntervalAutoRefinePending = false;
				this._assistantTurnsSinceAutoRefine = 0;
				if (reason === "compact") this._compactAutoRefinePending = false;
			}
		} finally {
			this._autoRefineInProgress = false;
			this._scheduleDeferredAutoRefineIfIdle();
		}
	}

	/**
	 * Refinement passes (review and planning) run with their own prompts, so
	 * issuing them on the session model evicts the provider's prefix-cache entry
	 * for the session and forces a full context re-read on the next session
	 * request. Route them to the configured auxiliary model when it is set and
	 * usable; fall back to the session model otherwise.
	 */
	private async _resolveRefinementModel(): Promise<
		{ model: Model<Api>; apiKey: string; headers?: Record<string, string> } | undefined
	> {
		const sessionModel = this.model;
		if (!sessionModel) {
			return undefined;
		}
		const selector = this.settingsManager.getAuxiliaryModel()?.trim().toLowerCase();
		if (!selector || `${sessionModel.provider}/${sessionModel.id}`.toLowerCase() === selector) {
			const { apiKey, headers, requestModel } = await this._getRequiredRequestAuth(sessionModel);
			return { model: requestModel, apiKey, headers };
		}
		try {
			const model = (await this._authenticatedRlmModels()).find(
				(candidate) => `${candidate.provider}/${candidate.id}`.toLowerCase() === selector,
			);
			if (!model) {
				throw new Error(`model "${selector}" is unavailable, unauthenticated, or expired`);
			}
			const { apiKey, headers, requestModel } = await this._getRequiredRequestAuth(model);
			return { model: requestModel, apiKey, headers };
		} catch {
			// Error details from the auth stack can embed credential material, so only
			// the selector is logged (CodeQL js/clear-text-logging).
			console.warn(`Warning: auxiliaryModel "${selector}" unusable for refinement; using the session model.`);
			const { apiKey, headers, requestModel } = await this._getRequiredRequestAuth(sessionModel);
			return { model: requestModel, apiKey, headers };
		}
	}

	private async _reviewAutoRefine(context: AutoRefineReviewRequest, signal?: AbortSignal): Promise<AutoRefineReview> {
		if (this._autoRefineReviewer) {
			return this._autoRefineReviewer(context, signal);
		}
		const refinementModel = await this._resolveRefinementModel();
		if (!refinementModel) {
			return { shouldRefine: false, rationale: "No model selected." };
		}
		return reviewAutoRefine(
			this.agent.state.messages,
			this._loadMergedHarnessState(),
			this._loadRefinementHistory(),
			refinementModel.model,
			refinementModel.apiKey,
			context,
			refinementModel.headers,
			signal,
			this.thinkingLevel,
			providerRetryPolicy(this.settingsManager),
			this.sessionId,
		);
	}

	/** Global harness state overlaid with this session's local state, when persisted. */
	/**
	 * The compact harness digest delivered at cold context boundaries (session start,
	 * resume, tree navigation, compaction head) and as a material-change delta.
	 */
	/**
	 * Digest plus the fingerprint of the state that produced it. Delivery decisions
	 * compare fingerprints, not rendered text (#2400): relevance query terms drift
	 * per turn, so a rendered-text comparison would re-deliver an unchanged digest
	 * at every boundary and stack near-duplicates into the context.
	 */
	private _harnessDigestWithFingerprint(): { digest: string; stateFingerprint: string; state: HarnessState } {
		const state = this._loadMergedHarnessState();
		const renderFlags = this._harnessDigestRenderFlags();
		return {
			digest: this._renderHarnessDigest(state, renderFlags),
			stateFingerprint: harnessDigestFingerprint(state, renderFlags),
			state,
		};
	}

	private _harnessDigestRenderFlags(): {
		includeIpythonExamples: boolean;
		includeShellExamples: boolean;
		includeRefineExamples: boolean;
	} {
		// Same validation `_rebuildSystemPrompt` applies before handing tool names to
		// the prompt: an unregistered name must not flip the example sections.
		const tools = this.getActiveToolNames().filter((name) => this._toolRegistry.has(name));
		const hasIpython = tools.includes("ipython");
		const visibleSkills = this._modelVisibleSkills().filter((skill) => !skill.disableModelInvocation);
		const hasRefineSkill = visibleSkills.some((skill) => skill.name === REFINE_SKILL_NAME);
		return {
			includeIpythonExamples: hasIpython,
			includeShellExamples: tools.includes("bash"),
			includeRefineExamples: hasIpython && hasRefineSkill,
		};
	}

	/**
	 * Rendered from the same inputs `buildSystemPrompt` used, so the text the model
	 * reads is byte-for-byte the menu it read when the digest still lived in the prompt.
	 */
	private _renderHarnessDigest(
		state: HarnessState,
		renderFlags: {
			includeIpythonExamples: boolean;
			includeShellExamples: boolean;
			includeRefineExamples: boolean;
		},
	): string {
		return formatHarnessStateForPrompt(state, {
			...renderFlags,
			queryTerms: this._buildHarnessDigestQueryTerms(),
		});
	}

	/**
	 * Relevance signal for the harness digest: terms from the active goal
	 * objective (strongest) and the last few user/assistant messages,
	 * newest first. Term overlap is cheap and capped so scoring stays trivial.
	 * A digest render happens before the current turn's message is committed,
	 * so the terms lag one turn behind the wording (same tradeoff upstream
	 * #2241 accepted); the next delivery picks the new wording up.
	 */
	private _buildHarnessDigestQueryTerms(): HarnessQueryTerms {
		const terms = new Map<string, number>();
		const addText = (text: string | undefined, weight: number) => {
			if (!text) return;
			for (const raw of harnessQueryTerms(text)) {
				if (terms.size >= 48 && !terms.has(raw)) return;
				if (!terms.has(raw)) terms.set(raw, weight);
			}
		};
		addText(this._goalState.objective, 3);
		const recent = this.agent.state.messages
			.filter(
				(message): message is UserMessage | AssistantMessage =>
					message.role === "user" || message.role === "assistant",
			)
			.slice(-4)
			.reverse();
		let recencyWeight = 2;
		for (const message of recent) {
			const text =
				message.role === "assistant"
					? readAssistantText(message)
					: typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is TextContent => block.type === "text")
								.map((block) => block.text)
								.join(" ");
			addText(text, recencyWeight);
			recencyWeight = Math.max(1, recencyWeight - 0.5);
		}
		return terms;
	}

	/**
	 * Cold-boundary digest delivery. An empty context defers to the first committed
	 * turn (an untouched session must keep reading as empty); a non-empty context
	 * appends only when the newest in-context digest no longer matches disk.
	 */
	private _ensureHarnessDigestContext(): void {
		if (this.agent.state.messages.length === 0) {
			this._harnessDigestPending = true;
			return;
		}
		this._harnessDigestPending = false;
		this._appendHarnessDigestIfStale();
	}

	private _appendHarnessDigestIfStale(): void {
		const { digest, stateFingerprint, state } = this._harnessDigestWithFingerprint();
		this._recordHarnessDigestBaselines(state);
		const latest = this._latestContextHarnessDigestDetails();
		if (latest && this._harnessDigestIsFresh(latest, digest, stateFingerprint)) return;
		this._appendHarnessDigest(digest, stateFingerprint);
	}

	/**
	 * Whether the newest in-context digest already reflects the current harness
	 * state. A digest is fresh when its state fingerprint matches the current
	 * one; a carrier written before fingerprints existed is compared by rendered
	 * text instead, so it can be superseded once and then carries a fingerprint.
	 */
	private _harnessDigestIsFresh(
		latest: { digest: string; stateFingerprint?: string },
		freshDigest: string,
		freshFingerprint: string,
	): boolean {
		return latest.stateFingerprint !== undefined
			? latest.stateFingerprint === freshFingerprint
			: latest.digest === freshDigest;
	}

	/**
	 * Material-change re-injection (merge doc 12.2, boss constraint: a long session
	 * must never freeze the harness menu). Runs at turn preparation, so an entry
	 * another seat wrote is model-visible on the next turn instead of at the next
	 * cold boundary. Append-only: it adds a message at the tail and never rewrites a
	 * byte that precedes it, so the provider's cached prefix survives.
	 *
	 * Cost discipline: every mutation path persists through `writePrivateFileAtomic`
	 * (a rename, so a new inode), which makes the two store stamps a complete change
	 * signal. When nothing moved the turn pays two `lstat` calls and reads no state
	 * file; only a moved stamp buys the parse plus render.
	 */
	private _refreshHarnessDigestIfMateriallyChanged(): void {
		const stamps = this._harnessStoreStamps();
		if (this._harnessDigestStamps !== undefined && harnessStoreStampsEqual(this._harnessDigestStamps, stamps)) {
			return;
		}
		const { digest, stateFingerprint, state } = this._harnessDigestWithFingerprint();
		this._harnessDigestStamps = stamps;
		const fingerprint = this._harnessEntryFingerprint(state);
		const previous = this._harnessDigestFingerprint;
		this._harnessDigestFingerprint = fingerprint;
		// The harness state is the criterion, not the file's mtime or the rendered
		// text: a touch, or a write that restored identical content, moves the stamp
		// and changes nothing; query-term drift moves the text and changes nothing.
		const latest = this._latestContextHarnessDigestDetails();
		if (latest && this._harnessDigestIsFresh(latest, digest, stateFingerprint)) return;
		if (previous !== undefined) {
			const changed = changedHarnessEntryKeys(previous, fingerprint);
			// Every moved entry was already itemized for the model by this session's own
			// refinement receipt (applied and refused alike), so a digest delta would
			// deliver the same news twice (merge doc 14.2).
			if (
				changed.size > 0 &&
				[...changed].every((key) => this._refinementReportedEntryVersions.get(key) === fingerprint.get(key))
			) {
				return;
			}
		}
		this._appendHarnessDigest(digest, stateFingerprint);
	}

	private _appendHarnessDigest(digest: string, stateFingerprint?: string): void {
		const message = createHarnessDigestMessage(digest, Date.now(), stateFingerprint);
		try {
			this.sessionManager.appendCustomMessageEntryWithRollback(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} catch (error) {
			if (this.sessionManager.getSessionFile()) {
				// A persisted session that cannot record the digest loses it at the next
				// context rebuild: report it instead of swallowing the failure.
				sessionLog.warn("harness digest could not be persisted", {
					sessionId: this.sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			// An in-memory session has nothing to persist; context-only is the design.
		}
		this.agent.state.messages.push(message);
	}

	/** Store stamps behind the material-change gate: the global store and this session's local one. */
	private _harnessStoreStamps(): HarnessStoreStamps {
		const localDir = this._localHarnessStateDir();
		return {
			global: readHarnessStateStamp(getGlobalHarnessStateDir()),
			local: localDir ? readHarnessStateStamp(localDir) : null,
		};
	}

	/** Drop the "already delivered" baselines so the next turn re-renders and re-checks. */
	private _invalidateHarnessDigestBaselines(): void {
		this._harnessDigestStamps = undefined;
		this._harnessDigestFingerprint = undefined;
	}

	private _recordHarnessDigestBaselines(state: HarnessState): void {
		this._harnessDigestStamps = this._harnessStoreStamps();
		this._harnessDigestFingerprint = this._harnessEntryFingerprint(state);
	}

	/** Identity of every harness entry (kind, store, id) to its version: additions, deletions and version bumps all move it. */
	private _harnessEntryFingerprint(state: HarnessState): Map<string, number> {
		const fingerprint = new Map<string, number>();
		for (const kind of Object.keys(state.entries) as Array<keyof HarnessState["entries"]>) {
			for (const [id, entry] of Object.entries(state.entries[kind] ?? {})) {
				fingerprint.set(`${kind}:${entry.scope ?? "unscoped"}:${id}`, entry.version);
			}
		}
		return fingerprint;
	}

	/**
	 * Recency is the greatest timestamp among all in-context digest carriers, not the
	 * last array position: retained pre-compaction messages are presented after the
	 * compaction head while being chronologically older, and an old retained digest
	 * must not defeat dedupe.
	 */
	private _latestContextHarnessDigestDetails():
		| { timestamp: number; digest: string; stateFingerprint?: string }
		| undefined {
		let latest: { timestamp: number; digest: string; stateFingerprint?: string } | undefined;
		for (const message of this.agent.state.messages) {
			if (message.role === "custom" && message.customType === HARNESS_DIGEST_CUSTOM_TYPE) {
				const details = message.details as HarnessDigestDetails | undefined;
				if (details?.digest !== undefined && (!latest || message.timestamp >= latest.timestamp)) {
					latest = {
						timestamp: message.timestamp,
						digest: details.digest,
						stateFingerprint: details.stateFingerprint,
					};
				}
			} else if (message.role === "compactionSummary") {
				if (message.harnessDigest !== undefined && (!latest || message.timestamp >= latest.timestamp)) {
					latest = {
						timestamp: message.timestamp,
						digest: message.harnessDigest,
						stateFingerprint: message.harnessStateFingerprint,
					};
				}
			}
		}
		return latest;
	}

	private _loadMergedHarnessState(): HarnessState {
		const localHarnessStateDir = this._localHarnessStateDir();
		return mergeHarnessStates(
			loadHarnessState(getGlobalHarnessStateDir(), "global"),
			localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined,
		);
	}

	private _loadRefinementHistory(): RefinementResult[] {
		return mergeRefinementHistory(
			loadGlobalRefinementHistory(getGlobalHarnessStateDir()),
			getRefinementHistory(this.sessionManager.getEntries().filter((entry) => entry.type === "custom")),
		);
	}

	/**
	 * Refine editable continual harness state: prompt notes, memory, skills, and subagent specs.
	 * The base system prompt is intentionally not editable through this path.
	 *
	 * Planning runs in the background and does NOT block turn entry points
	 * (`_waitForRefineIdle` only waits for `_refineInFlight`). Only the fast
	 * application phase (disk I/O + in-memory mutation) blocks turn entry points.
	 */
	async refine(
		options: {
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		} = {},
		internal: { skipAbort?: boolean; trigger?: "manual" | "auto" } = {},
	): Promise<RefinementResult> {
		if (!isPersistentHarnessStorageSupported()) {
			throw new Error(WINDOWS_HARNESS_PERSISTENCE_UNSUPPORTED_ERROR);
		}
		const preflightDir = options.global ? getGlobalHarnessStateDir() : this._localHarnessStateDir();
		if (preflightDir) assertHarnessStateWritable(loadHarnessState(preflightDir, options.global ? "global" : "local"));
		// Queued /refine executes from the session-input pump between turns;
		// refine never aborts the agent (planning is backgrounded and the apply
		// phase waits for quiescence), so skipAbort only asserts the pump's
		// idle invariant instead of changing abort behavior.
		if (internal.skipAbort && this.isStreaming) {
			throw new Error("Cannot refine without aborting while the agent is running.");
		}
		// Wait for any existing refine (both planning and application) before
		// starting a new run. This serializes concurrent /refine calls so two
		// planning phases cannot race into concurrent _applyRefine calls that
		// overwrite harness state.
		while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
			if (this._refineInFlight) {
				await this._refineInFlight;
			} else if (this._refinePlanInFlight) {
				await this._refinePlanInFlight;
			} else {
				// A serialized background plan is in flight (started during an
				// active turn at message_end). Wait for planning and for the active
				// turn to settle so its normal checkpoint can consume the plan.
				const serializedPlanInFlight = this._serializedPlanInFlight;
				await serializedPlanInFlight;
				if (this._refineInFlight || this._refinePlanInFlight) {
					continue;
				}
				await this.agent.waitForIdle();
				// Aborted turns skip shouldStopAfterTurn. Drop their settled plan
				// after idle so a later public refine cannot spin on it forever.
				if (this._serializedPlanInFlight === serializedPlanInFlight) {
					this._serializedPlanInFlight = undefined;
					this._serializedExplicitRefineOptions = undefined;
				}
			}
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;

		const planRun = this._planRefine(options, refineAbort.signal, internal.trigger ?? "manual");
		const planSettled = planRun.then(
			() => undefined,
			() => undefined,
		);
		this._refinePlanInFlight = planSettled;
		let plan: RefinementPlan;
		try {
			plan = await planRun;
		} catch (e) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._scheduleSessionInputPump();
			throw e;
		} finally {
			if (this._refinePlanInFlight === planSettled) {
				this._refinePlanInFlight = undefined;
			}
		}

		// Block new turns before waiting for the current turn to finish. One shared
		// settled promise covers the full transition and apply critical section.
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			// Wait for the session to become quiescent before applying. Planning is
			// allowed to overlap active user work, but application must not disconnect
			// event handling until that work and its queued events have completed.
			await this.agent.waitForIdle();
			while (true) {
				const eventQueue = this._agentEventQueue;
				const compactionOp = this._compactionOperation;
				const branchSummaryOp = this._branchSummaryOperation;
				await Promise.allSettled([
					eventQueue,
					...(compactionOp ? [compactionOp] : []),
					...(branchSummaryOp ? [branchSummaryOp] : []),
				]);
				if (
					eventQueue === this._agentEventQueue &&
					compactionOp === this._compactionOperation &&
					branchSummaryOp === this._branchSummaryOperation
				) {
					break;
				}
			}
			if (this._disposed || refineAbort.signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			try {
				return await this._applyRefine(plan, options, refineAbort);
			} catch (error) {
				// MV-5 parity for the direct refine() path (kernel skill, auto runs):
				// a persist/apply failure leaves a model-visible failure receipt the
				// same way the queued /refine command path does. K3R-8: normalize the
				// thrown value into one Error object here and rethrow THAT object, so
				// every downstream catch (queued /refine, pending refine.run) shares a
				// single idempotency key with _emitRefineFailed's receipt guard - a raw
				// non-Error value used to defeat the WeakSet dedup and double-report.
				const normalized = this._asError(error);
				this._emitRefineFailed(normalized, options?.global ? "global" : "local");
				throw normalized;
			}
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._notifySessionInputCheckpointChange();
			this._scheduleSessionInputPump();
		}
	}

	/**
	 * Block a new agent turn until any in-flight refine application phase has
	 * reattached event handling; otherwise the turn's messages are never
	 * persisted or rendered.
	 *
	 * The idle-wait and application phase (`_refineInFlight`) block here. The
	 * background planning phase (`_refinePlanInFlight`) does NOT block turns.
	 * Refine failures surface to the refine caller, not here.
	 */
	private async _waitForRefineIdle(): Promise<void> {
		while (this._refineInFlight) {
			await this._refineInFlight;
		}
	}

	/**
	 * Background planning phase: runs the LLM planning call via `planRefinement`.
	 * Does not disconnect from or abort the agent. Returns the plan without
	 * applying anything.
	 */
	private async _planRefine(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		signal: AbortSignal,
		trigger: "manual" | "auto" = "manual",
	): Promise<RefinementPlan> {
		if (this._disposed) {
			throw new Error("Cannot refine a disposed session.");
		}

		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		const refinementModel = await this._resolveRefinementModel();
		if (!refinementModel) {
			throw new Error(formatNoModelSelectedMessage());
		}
		const globalHarnessStateDir = getGlobalHarnessStateDir();
		const localHarnessStateDir = this._localHarnessStateDir();
		const requestedScope = options.global ? "global" : "local";
		if (!options.rollbackId && requestedScope === "local" && !localHarnessStateDir) {
			throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
		}
		const globalPlanningState = loadHarnessState(globalHarnessStateDir, "global");
		const localPlanningState = localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined;
		const planningState =
			requestedScope === "global"
				? globalPlanningState
				: mergeHarnessStates(globalPlanningState, localPlanningState);
		const history = this._loadRefinementHistory();
		const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
		let baselineScope = rollbackTarget
			? (inferRefinementResultScope(rollbackTarget) ?? requestedScope)
			: requestedScope;
		let baselineHarnessStateDir = baselineScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
		if (rollbackTarget?.harnessStatePath) {
			baselineHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
			baselineScope = resolve(baselineHarnessStateDir) === resolve(globalHarnessStateDir) ? "global" : "local";
		}
		if (!baselineHarnessStateDir) {
			throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
		}
		const baselineState = rollbackTarget
			? loadHarnessState(baselineHarnessStateDir, baselineScope)
			: baselineScope === "global"
				? globalPlanningState
				: localPlanningState!;
		if (!options.rollbackId && this._extensionRunner.hasHandlers("session_before_refine")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_refine",
				preparation: {
					trigger,
					instructions: options.instructions,
					scope: requestedScope,
					planningState,
					history,
					conversationText: serializeConversation(convertToLlm(this.agent.state.messages)).slice(-80_000),
				},
				signal,
			})) as SessionBeforeRefineResult | undefined;
			if (this._disposed || signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			if (result?.skip) {
				throw new RefineSkippedError("Refinement skipped by extension");
			}
			if (result?.proposal !== undefined) {
				return {
					proposal: normalizeRefinementProposal(result.proposal),
					id: generateRefinementId(),
					baselineState,
				};
			}
		}
		const plan = await planRefinement(
			this.agent.state.messages,
			planningState,
			history,
			refinementModel.model,
			refinementModel.apiKey,
			{ ...options, retry: providerRetryPolicy(this.settingsManager) },
			refinementModel.headers,
			signal,
			this.thinkingLevel,
			this.sessionId,
		);
		if (this._disposed || signal.aborted) {
			throw new Error("Refinement cancelled because the session was disposed.");
		}
		return { ...plan, baselineState };
	}

	private _recordRefinementOutcome(result: RefinementResult): void {
		// The receipt itemizes every edit it carries, applied and refused alike, so the
		// material-change gate can tell "the model already heard about this entry" from
		// "another seat moved the store" (merge doc 14.2: no double delivery).
		const scope = result.scope ?? "local";
		for (const edit of result.appliedEdits) {
			const entry = edit.after ?? edit.before;
			// Version-aware on purpose: the receipt itemized THIS version, so a later bump
			// by another writer is fresh news and must still re-inject (merge doc 12.2).
			if (entry) {
				this._refinementReportedEntryVersions.set(`${edit.kind}:${entry.scope ?? scope}:${edit.id}`, entry.version);
			}
		}
		this._appendDurableRefineMessage(createRefinementOutcomeMessage(result));
	}

	private _appendDurableRefineMessage(message: CustomMessage): void {
		try {
			this.sessionManager.appendCustomMessageEntryWithRollback(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} catch {
			// Not in the session file, so context rebuilds would drop the outcome.
			this._unpersistedOutcomes.push(message);
		}
		this.agent.state.messages.push(message);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	/**
	 * Synchronous application phase: disconnects from the agent, aborts any
	 * in-flight agent run, applies the refinement plan to disk and memory, then
	 * reconnects. This is the only phase that blocks turn entry points.
	 */
	private async _applyRefine(
		plan: RefinementPlan,
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
	): Promise<RefinementResult> {
		if (this._disposed) {
			throw new Error("Cannot refine a disposed session.");
		}
		// The caller has already set _refineInFlight and waited for agent idle.
		// Disconnect only for the brief apply + save + reconnect critical section.
		this._disconnectFromAgent();

		try {
			const globalHarnessStateDir = getGlobalHarnessStateDir();
			const localHarnessStateDir = this._localHarnessStateDir();
			const requestedScope = options.global ? "global" : "local";
			const history = this._loadRefinementHistory();
			const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
			let targetScope = plan.rollbackScope ?? requestedScope;
			let targetHarnessStateDir = targetScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
			if (targetScope === "local" && rollbackTarget?.harnessStatePath) {
				targetHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
				// Legacy records predate scope fields and default to "local" but may point
				// at the global store; honor the recorded path so its entries stay global.
				if (resolve(targetHarnessStateDir) === resolve(globalHarnessStateDir)) {
					targetScope = "global";
				}
			}
			if (!targetHarnessStateDir) {
				throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
			}
			// Re-read the target state immediately before applying so concurrent kernel
			// (`rlm.harness`) writes during the LLM pass are not clobbered. Capture
			// stamp so save refuses to overwrite a write that lands after this load.
			const expectedStamp = readHarnessStateStamp(targetHarnessStateDir);
			const state = loadHarnessState(targetHarnessStateDir, targetScope);
			const proposal = {
				...plan.proposal,
				edits: plan.proposal.edits.map((edit) => {
					const localPrefix = "local:";
					const globalPrefix = "global:";
					return {
						...edit,
						id: edit.id?.startsWith(localPrefix)
							? edit.id.slice(localPrefix.length)
							: edit.id?.startsWith(globalPrefix)
								? edit.id.slice(globalPrefix.length)
								: edit.id,
					};
				}),
			};
			if (this._disposed || refineAbort.signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			const result = applyRefinementProposal(state, proposal, {
				id: plan.id,
				rollbackOf: plan.rollbackOf,
				scope: targetScope,
				baselineState: plan.baselineState,
			});
			result.harnessStatePath = getHarnessStatePath(targetHarnessStateDir);
			let refinementPersistError: { error: unknown } | undefined;
			try {
				persistAppliedRefinement({
					harnessStateDir: targetHarnessStateDir,
					state,
					result,
					expectedStamp,
					appendSessionAudit: (entry) => {
						this.sessionManager.appendCustomEntry("prime-agent.refinement", entry);
					},
					globalHarnessStateDir: targetScope === "global" ? globalHarnessStateDir : undefined,
				});
			} catch (error) {
				refinementPersistError = { error };
			}
			// MV-6: the completion receipt only lands on the success path. The
			// pre-fix order recorded it before the persist error was thrown, so a
			// concurrent-write rejection left a "Refinement complete" receipt in the
			// message flow while nothing landed on disk; the failure path now
			// reports through `_emitRefineFailed` at the caller's catch instead.
			// The wrapper carries the *effective* target scope (MV-5): a local
			// request rolling back a global record must not be reported with the
			// requested scope.
			if (refinementPersistError) {
				const cause = refinementPersistError.error;
				throw cause instanceof Error
					? new RefinePersistScopeError(cause.message, targetScope, { cause })
					: new RefinePersistScopeError(String(cause), targetScope, { cause });
			}
			this._recordRefinementOutcome(result);
			// No rebuild and no swap here (#2098): the prompt stays byte-identical so the
			// provider's cached prefix survives the apply. The applied and refused edits
			// reach the model through the outcome receipt above; a harness menu that moved
			// reaches it through the next committed turn's material-change digest delta.
			try {
				this._emit({ type: "refine_complete", result });
			} catch {
				// Listener failures must not flip a successful refinement into
				// a reported failure — the refinement is already persisted.
			}
			try {
				await this._extensionRunner.emit({
					type: "refine_complete",
					id: result.id,
					summary: result.summary,
					appliedEdits: result.appliedEdits.filter((edit) => edit.applied).length,
					scope: result.scope ?? "local",
				});
			} catch {
				// Extension emit failures must not flip a successful refinement
				// into a reported failure — the refinement is already persisted.
			}
			return result;
		} finally {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			if (!this._disposed) {
				this._reconnectToAgent();
			}
		}
	}

	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, and continue only for stopped in-progress loops or queued messages
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private _getThresholdContextTokens(
		assistantMessage: AssistantMessage,
		compactionTimestamp: number | undefined,
	): number | undefined {
		if (estimateContextTokens(this.agent.state.messages).lastUsageIndex !== null) {
			return this._estimateThresholdContextTokens(compactionTimestamp);
		}

		if (assistantMessage.stopReason === "error") return undefined;
		return calculateContextTokens(assistantMessage.usage);
	}

	/**
	 * The context size the trigger reads, or undefined when it is unknowable.
	 *
	 * One caliber for every trigger site (agent_end, the shouldStopAfterTurn hook and
	 * the admission gate), so an input cannot be over the threshold for one of them
	 * and under it for another.
	 */
	private _estimateThresholdContextTokens(compactionTimestamp: number | undefined): number | undefined {
		const messages = this.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex === null) return estimate.tokens;
		// Verify the usage source is post-compaction. Kept pre-compaction messages
		// have stale usage reflecting the old (larger) context and would falsely
		// trigger compaction right after one just finished.
		const usageMsg = messages[estimate.lastUsageIndex];
		if (
			compactionTimestamp !== undefined &&
			usageMsg?.role === "assistant" &&
			usageMsg.timestamp <= compactionTimestamp
		) {
			return undefined;
		}
		return estimate.tokens;
	}

	/**
	 * Model identity for the compaction trigger: the declared window clamped to the
	 * provider's measured input limit, so a catalog entry that over-declares (1048576
	 * declared, 1000000 accepted) cannot push the trigger past the wall.
	 */
	private _compactionWindowLimits(): CompactionWindowLimits | undefined {
		return this.model ? { provider: this.model.provider, modelId: this.model.id } : undefined;
	}

	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		queueAutonomousContinuation = true,
	): Promise<boolean> {
		// An abort drops any compaction the model requested this turn, even on the
		// pre-prompt path (skipAbortedCheck=false) which continues to threshold checks.
		if (assistantMessage.stopReason === "aborted") {
			this._pendingRequestedCompaction = undefined;
			// An abort also drops any pending explicit refine.run request: the
			// turn that would service it (non-serialized: _consumePendingRequestedRefine
			// at agent_end; serialized: the shouldStopAfterTurn checkpoint) never
			// runs for an aborted turn, so a stale request would leak into the
			// next turn or checkpoint.
			this._pendingRequestedRefine = undefined;
			if (this._serializedPlanInFlight) {
				const serializedPlanInFlight = this._serializedPlanInFlight;
				this._autoRefineBranchVersion++;
				this._refineAbortController?.abort();
				await serializedPlanInFlight.catch(() => undefined);
				if (this._serializedPlanInFlight === serializedPlanInFlight) {
					this._serializedPlanInFlight = undefined;
					this._serializedExplicitRefineOptions = undefined;
				}
			}
			if (skipAbortedCheck) return false;
		}

		const settings = this.settingsManager.getCompactionSettings();
		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip overflow/threshold checks if this assistant message is older than the
		// latest compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		const assistantIsFromBeforeCompaction =
			compactionTimestamp !== undefined && assistantMessage.timestamp <= compactionTimestamp;

		// Case 1: Overflow - takes priority over a pending model request so the error
		// strip + retry still happen; the compaction it runs consumes the request.
		if (
			!assistantIsFromBeforeCompaction &&
			(settings.enabled || this._pendingRequestedCompaction !== undefined) &&
			sameModel &&
			isContextOverflow(assistantMessage, contextWindow)
		) {
			if (this._overflowRecovery !== "idle") {
				if (this._overflowRecovery === "attempted") {
					this._overflowRecovery = "reported";
					this._endCompactionUnsuccessfully(
						"overflow",
						"failed",
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
					);
				}
				return false;
			}

			this._overflowRecovery = "attempted";
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", true);
		}

		if (this._pendingRequestedCompaction !== undefined) {
			return await this._runAutoCompaction("requested", false);
		}

		if (!settings.enabled || assistantIsFromBeforeCompaction) return false;

		// Case 3: Threshold - context is getting large.
		// Use the full-session estimate so messages appended after the last successful
		// assistant usage are included, matching the /usage context display.
		const contextTokens = this._getThresholdContextTokens(assistantMessage, compactionTimestamp);
		if (contextTokens === undefined) return false;
		if (shouldCompact(contextTokens, contextWindow, settings, this._compactionWindowLimits())) {
			if (this._isThresholdCompactionCoolingDown(contextWindow)) return false;
			if (queueAutonomousContinuation && this._queueGoalContinuationForThresholdCompaction(assistantMessage)) {
				this._continueAfterThresholdCompaction = true;
			} else if (
				queueAutonomousContinuation &&
				(await this._queueAutonomousContinuationForThresholdCompaction(assistantMessage))
			) {
				this._continueAfterThresholdCompaction = true;
			}
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	private _currentModelKey(): string {
		return this.model ? `${this.model.provider}/${this.model.id}` : "";
	}

	/**
	 * True while a skipped/failed threshold compaction is still cooling down.
	 * The cooldown lifts once the branch grows by a few entries (new material to
	 * summarize) or the model changes (different window, so the attempt that
	 * failed may now succeed).
	 */
	private _isThresholdCompactionCoolingDown(contextWindow: number): boolean {
		const cooldown = this._thresholdCompactionCooldown;
		if (!cooldown) return false;
		if (cooldown.modelKey !== this._currentModelKey() || contextWindow <= 0) {
			this._thresholdCompactionCooldown = undefined;
			return false;
		}
		const branch = this.sessionManager.getBranch();
		if (branch.length >= cooldown.branchEntryCount + THRESHOLD_COMPACTION_RETRY_MIN_NEW_ENTRIES) {
			this._thresholdCompactionCooldown = undefined;
			return false;
		}
		return true;
	}

	private _armThresholdCompactionCooldown(): void {
		this._thresholdCompactionCooldown = {
			branchEntryCount: this.sessionManager.getBranch().length,
			modelKey: this._currentModelKey(),
		};
	}

	/**
	 * Count a compaction that failed to produce a summary and return the recovery
	 * guidance to attach once failures repeat (empty until then). Aborts and skips
	 * do not count: a user-initiated cancel is not a failure to summarize, and
	 * "nothing to compact" does not leave the session stuck.
	 */
	private _registerCompactionFailure(): string {
		this._consecutiveCompactionFailures += 1;
		if (this._consecutiveCompactionFailures < COMPACTION_RECOVERY_HINT_THRESHOLD) return "";
		return buildCompactionRecoveryHint(this._consecutiveCompactionFailures);
	}

	/** A compaction that produced a summary ends the failure streak. */
	private _clearCompactionFailures(): void {
		this._consecutiveCompactionFailures = 0;
	}

	/**
	 * Internal: Run automatic (threshold/overflow) or model-requested compaction
	 * with events.
	 */
	private _endCompactionUnsuccessfully(
		reason: CompactionOutcomeReason,
		outcome: CompactionOutcome,
		message: string,
		options: {
			aborted?: boolean;
			errorSeverity?: "warning" | "error";
			customInstructions?: string;
		} = {},
	): void {
		this._persistCompactionOutcome(reason, outcome, message);
		this._emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted: options.aborted ?? false,
			willRetry: false,
			// Aborts are user-initiated; they carry no error message on the event.
			errorMessage: options.aborted ? undefined : message,
			errorSeverity: options.errorSeverity,
			customInstructions: options.customInstructions,
		});
	}

	private _persistCompactionOutcome(
		reason: CompactionOutcomeReason,
		outcome: CompactionOutcome,
		message: string,
	): void {
		let outcomeMessage = createCompactionOutcomeMessage(message, {
			reason,
			outcome,
		});
		try {
			this.sessionManager.appendCustomMessageEntryWithRollback(
				outcomeMessage.customType,
				outcomeMessage.content,
				outcomeMessage.display,
				outcomeMessage.details,
			);
		} catch (error) {
			const persistenceError = error instanceof Error ? error.message : String(error);
			outcomeMessage = createCompactionOutcomeMessage(
				`${message}\n\nThis compaction outcome could not be saved to session history: ${persistenceError}`,
				{ reason, outcome },
			);
			// Not in the session file, so context rebuilds would drop the disclosure.
			this._unpersistedOutcomes.push(outcomeMessage);
		}
		this.agent.state.messages.push(outcomeMessage);
		this._emit({ type: "message_start", message: outcomeMessage });
		this._emit({ type: "message_end", message: outcomeMessage });
	}

	/**
	 * The last-resort valve for a session whose compaction keeps failing.
	 *
	 * After COMPACTION_EMERGENCY_SHRINK_FAILURES consecutive failures the context is
	 * still over the trigger threshold, so every further request is headed for the
	 * provider's input wall and the session cannot recover by itself: the next turn
	 * re-triggers the same failing summarization. The valve drops the oldest
	 * NON-summary context - a previous compaction summary and branch summaries are
	 * carried into the replacement summary instead of being lost - until the estimate
	 * lands under the threshold's emergency target.
	 *
	 * Never silent. The loss is named in three places: the replacement summary the
	 * model reads next turn, a persisted compaction-outcome notice the user reads in
	 * the transcript, and a warn-level session log line. Nothing is deleted from the
	 * transcript on disk, and the notice says so.
	 *
	 * Returns whether the shrink ran and whether it reached its target.
	 */
	private async _runEmergencyContextShrink(
		reason: CompactionOutcomeReason,
		lastError: string,
	): Promise<{ shrunk: boolean; reachedTarget: boolean }> {
		if (this._consecutiveCompactionFailures < COMPACTION_EMERGENCY_SHRINK_FAILURES) {
			return { shrunk: false, reachedTarget: false };
		}
		const settings = this.settingsManager.getCompactionSettings();
		const contextWindow = this.model?.contextWindow ?? 0;
		const threshold = compactionThresholdTokens(contextWindow, settings, this._compactionWindowLimits());
		if (threshold <= 0) return { shrunk: false, reachedTarget: false };
		const plan = planEmergencyShrink(this.sessionManager.getBranch(), threshold);
		if (!plan) return { shrunk: false, reachedTarget: false };
		const summary = buildEmergencyShrinkSummary(plan, {
			consecutiveFailures: this._consecutiveCompactionFailures,
			lastError,
			thresholdTokens: threshold,
		});
		const leafId = this.sessionManager.getLeafId();
		try {
			// Same cold-boundary rule as the main compaction head: the shrink
			// writes a new head, so it carries a fresh digest snapshot.
			const { digest: shrinkDigest, stateFingerprint: shrinkStateFingerprint } =
				this._harnessDigestWithFingerprint();
			this.sessionManager.appendCompaction(
				summary,
				plan.firstKeptEntryId,
				plan.tokensBefore,
				undefined,
				false,
				undefined,
				{
					leafId: leafId ?? undefined,
					harnessDigest: shrinkDigest,
					harnessStateFingerprint: shrinkStateFingerprint,
					onCommit: (info) => {
						sessionLog.warn("emergency context shrink committed", {
							sessionId: this.sessionId,
							...info,
							droppedEntries: plan.span.droppedEntries,
							droppedTokens: plan.span.droppedTokens,
							reachedTarget: plan.reachedTarget,
						});
					},
				},
			);
		} catch (error) {
			// The valve must not become a second, quieter failure: report that the shrink
			// itself could not be committed and leave the session exactly as it was.
			sessionLog.error("emergency context shrink could not be committed", {
				sessionId: this.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			this._persistCompactionOutcome(
				reason,
				"failed",
				`Emergency context shrink could not be committed: ${
					error instanceof Error ? error.message : String(error)
				}. The context is still over the compaction threshold; use /tree, /fork, /model or /new.`,
			);
			return { shrunk: false, reachedTarget: false };
		}
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		this._mergeUnpersistedOutcomes(this.agent.state.messages);
		this._restoreLateIpythonSentAgentMessages();
		this._persistCompactionOutcome(reason, "failed", buildEmergencyShrinkNotice(plan, lastError));
		await this._syncKernelStateAfterCompaction();
		if (plan.reachedTarget) {
			// The context is back under the threshold, so the cooldown that was armed for
			// the failed attempt no longer describes reality. The failure streak stays: a
			// further failure should shrink again instead of earning three fresh retries.
			this._thresholdCompactionCooldown = undefined;
		}
		return { shrunk: true, reachedTarget: plan.reachedTarget };
	}

	private async _runAutoCompaction(
		reason: "overflow" | "threshold" | "requested",
		willRetry: boolean,
	): Promise<boolean> {
		// Any compaction consumes a pending model request and honors its instructions
		// (overflow recovery can fire first and take the request with it).
		const pending = this._pendingRequestedCompaction;
		this._pendingRequestedCompaction = undefined;
		const customInstructions = pending?.customInstructions;
		const shouldContinueAfterCompaction =
			(reason === "threshold" || reason === "requested") && this._continueAfterThresholdCompaction;
		const queuedAutonomousContinuationsForThisCompaction =
			reason === "threshold" && shouldContinueAfterCompaction
				? this._pendingThresholdCompactionAutonomousMessages.splice(0)
				: [];
		const queuedGoalContinuationForThisCompaction =
			reason === "threshold" && shouldContinueAfterCompaction ? this._queuedGoalThresholdContinuation : undefined;
		this._continueAfterThresholdCompaction = false;

		// Requested/threshold stop the loop on purpose, so a failed or skipped compaction must not stall it.
		// Overflow stays excluded: a failed overflow recovery must not re-issue the overflowing request.
		const resumeAfterFailure = () => {
			if (
				(reason === "requested" || reason === "threshold") &&
				(shouldContinueAfterCompaction || this.agent.hasQueuedMessages() || this.hasPendingSessionWork)
			) {
				this._schedulePostCompactionContinue(shouldContinueAfterCompaction);
			}
		};

		this._emit({ type: "compaction_start", reason, customInstructions });
		const autoCompactionAbort = new AbortController();
		this._autoCompactionAbortController = autoCompactionAbort;
		let resolveCompactionOperation: () => void = () => {};
		const compactionOperation = new Promise<void>((resolve) => {
			resolveCompactionOperation = resolve;
		});
		this._compactionOperation = compactionOperation;
		// A compaction blocks the pump, so it blocks every queued input behind it, and
		// the stall watchdog snoozes while compaction owns the turn boundary. Bound it
		// whenever something is waiting - including the retry that a just-aborted
		// compaction's queued message triggers through its own pre-turn compaction, which
		// would otherwise hang on the same wedged summarizer with nobody left to cut it.
		if (this.hasPendingSessionWork) this._armCompactionGateWatchdog();

		try {
			const authResult = this.model ? await this._modelRegistry.getApiKeyAndHeaders(this.model) : undefined;
			if (!this.model || !authResult || !authResult.ok || !authResult.apiKey) {
				const detail =
					!this.model || !authResult
						? "no model is selected"
						: authResult.ok
							? "no API key is available"
							: authResult.error;
				const recoveryHint = this._registerCompactionFailure();
				this._endCompactionUnsuccessfully(reason, "failed", `Compaction failed: ${detail}${recoveryHint}`);
				this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
					reason === "threshold" && shouldContinueAfterCompaction,
					queuedAutonomousContinuationsForThisCompaction,
				);
				if (reason === "threshold") this._armThresholdCompactionCooldown();
				await this._runEmergencyContextShrink(reason, detail);
				resumeAfterFailure();
				return false;
			}

			const result = await this._performCompaction({
				model: authResult.requestModel ?? this.model,
				apiKey: authResult.apiKey,
				headers: authResult.headers,
				customInstructions,
				signal: autoCompactionAbort.signal,
			});
			// A successful compaction restructures the context; any earlier
			// skip/failure cooldown no longer reflects reality.
			this._thresholdCompactionCooldown = undefined;
			this._clearCompactionFailures();

			this._emit({
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry,
				customInstructions,
			});
			// Queued work lives in both the agent queues and the session-owned queues.
			const hasQueuedMessages = this.agent.hasQueuedMessages() || this.hasPendingSessionWork;
			const willContinueAfterCompaction = willRetry || shouldContinueAfterCompaction || hasQueuedMessages;

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}

				this._schedulePostCompactionContinue(true);
				this._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
				return true;
			} else if (shouldContinueAfterCompaction || hasQueuedMessages) {
				// Compaction can intentionally stop a tool loop between turns.
				// Queued follow-up/steering/custom messages can also be waiting.
				this._schedulePostCompactionContinue(shouldContinueAfterCompaction);
				this._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
			} else {
				this._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
			}
			return false;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const aborted =
				errorMessage === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			// K3R-11: a manual compact() preempts this scope; that abort is not the
			// user cancelling the queued work. The continuations this compaction
			// stopped the loop for must survive exactly as the success path leaves
			// them - the manual compaction runs on the same context and resumes the
			// loop for them when it settles. Only a user-level abort (abortCompaction,
			// requestAbort) keeps the destroy-and-roll-back semantics.
			const preemptedByManualCompaction = aborted && this._autoCompactionPreemptedByManual === autoCompactionAbort;
			if (preemptedByManualCompaction) {
				this._autoCompactionPreemptedByManual = undefined;
			} else {
				this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
					reason === "threshold" && shouldContinueAfterCompaction,
					queuedAutonomousContinuationsForThisCompaction,
				);
			}
			if (aborted) {
				if (!preemptedByManualCompaction) {
					this._clearQueuedGoalContinuationAfterCancelledThresholdCompaction(
						queuedGoalContinuationForThisCompaction,
					);
				}
				this._endCompactionUnsuccessfully(
					reason,
					"cancelled",
					`${reason === "requested" ? "Requested c" : "C"}ompaction cancelled`,
					{ aborted: true, customInstructions },
				);
				return false;
			}
			if (error instanceof CompactionSkippedError) {
				this._endCompactionUnsuccessfully(
					reason,
					"skipped",
					reason === "requested"
						? `Requested compaction skipped: ${errorMessage}`
						: `Auto-compaction skipped: ${errorMessage}`,
					{ errorSeverity: "warning", customInstructions },
				);
				if (reason === "threshold") this._armThresholdCompactionCooldown();
				resumeAfterFailure();
				return false;
			}
			const recoveryHint = this._registerCompactionFailure();
			this._endCompactionUnsuccessfully(
				reason,
				"failed",
				`${
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: reason === "requested"
							? `Requested compaction failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`
				}${recoveryHint}`,
				{ customInstructions },
			);
			if (reason === "threshold") this._armThresholdCompactionCooldown();
			// Last resort: a streak of failures leaves the context over the threshold with
			// no way back down, so the valve drops the oldest non-summary context and says
			// so loudly. Runs before resumeAfterFailure so the continuation it schedules
			// sees the shrunken context.
			await this._runEmergencyContextShrink(reason, errorMessage);
			resumeAfterFailure();
			return false;
		} finally {
			if (this._autoCompactionPreemptedByManual === autoCompactionAbort) {
				this._autoCompactionPreemptedByManual = undefined;
			}
			if (this._autoCompactionAbortController === autoCompactionAbort) {
				this._autoCompactionAbortController = undefined;
			}
			if (this._compactionOperation === compactionOperation) {
				this._compactionOperation = undefined;
			}
			resolveCompactionOperation();
			this._notifySessionInputCheckpointChange();
			this._scheduleSessionInputPump();
		}
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	/**
	 * Set the provider for extra env vars merged over process.env in extension
	 * pi.exec() subprocesses. The function is read at exec time, so a host (e.g.
	 * the daemon) can update the underlying value per attach without rebinding.
	 */
	setExecEnvProvider(provider: (() => Record<string, string | undefined> | undefined) | undefined): void {
		this._execEnvProvider = provider;
		const extensions = this._resourceLoader.getExtensions();
		extensions.runtime.getExecEnv = provider;
	}

	/**
	 * Count open extension dialogs so the stall watchdog can treat "waiting for the
	 * user" as a pause. Both hosts hand their UI context over through bindExtensions,
	 * so wrapping it here covers the interactive dialogs and the daemon-forwarded ones
	 * (which the daemon tracks in its own extensionUiRequests map) without either host
	 * having to report back. `notify` is not a dialog and stays untouched.
	 */
	private _withDialogTracking(uiContext: ExtensionUIContext): ExtensionUIContext {
		// Typed as the original signature so a generic member (custom<T>) keeps its type
		// parameters; Reflect.apply preserves the host's `this` binding, and the counter
		// always decrements even when the dialog rejects.
		const counted = <F extends (...args: never[]) => Promise<unknown>>(dialog: F): F => {
			const wrapped = (...args: Parameters<F>): Promise<unknown> => {
				this._pendingUiDialogs += 1;
				return Promise.resolve()
					.then(() => Reflect.apply(dialog, uiContext, args) as Promise<unknown>)
					.finally(() => {
						this._pendingUiDialogs -= 1;
					});
			};
			return wrapped as F;
		};
		// Every member that can hang indefinitely waiting for the user has to be counted;
		// missing one leaves the turn abortable while a dialog is open. That is
		// select/confirm/input, plus editor (multi-line editor) and custom (a component
		// that takes keyboard focus and settles through its done callback). notify is
		// fire-and-forget and every other member is synchronous, so they are left alone.
		//
		// Members that also accept opts.timeout or opts.signal are counted too, because a
		// caller may omit both and the daemon can cancel a session-level dialog out from
		// under it - "settles only on user input" is not what decides this, "can hang" is.
		// On the daemon and rpc hosts custom resolves immediately, so counting it there is
		// a harmless no-op.
		return {
			...uiContext,
			select: counted(uiContext.select),
			confirm: counted(uiContext.confirm),
			input: counted(uiContext.input),
			editor: counted(uiContext.editor),
			custom: counted(uiContext.custom),
		};
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = this._withDialogTracking(bindings.uiContext);
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		this._reportToolNameConflicts();
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: {
			source: string;
			scope: "temporary";
			origin: "top-level";
			baseDir?: string;
		};
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	refreshModelMetadata(): void {
		if (this.model?.provider === "xai") {
			this.agent.state.model = this._modelRegistry.getModelForCurrentAuth(this.model);
			this.setThinkingLevel(this.thinkingLevel);
			this._clampServiceTierForModel();
		}
		this._scopedModels = this._scopedModels.map((scoped) =>
			scoped.model.provider === "xai"
				? { ...scoped, model: this._modelRegistry.getModelForCurrentAuth(scoped.model) }
				: scoped,
		);
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: async (name) => {
					if (this._agentMessageController?.setSessionName) {
						await this._agentMessageController.setSessionName(name);
						return;
					}
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => !this.isStreaming,
				getSignal: () => this.agent.signal,
				abort: () => this.abort(),
				hasPendingMessages: () => this.queuedActionCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const sdkToolEntry = (definition: ToolDefinition) => ({
			definition,
			sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, {
				source: "sdk" as const,
			}),
		});
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map(sdkToolEntry),
			...this._acpMcpTools.map(sdkToolEntry),
		];
		const isAllowedTool = (name: string): boolean => !allowedToolNames || allowedToolNames.has(name);
		const allowedCustomTools = allCustomTools.filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, {
							source: "builtin",
						}),
					},
				]),
		);
		for (const tool of allowedCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allowedCustomTools, runner);
		// Resolve the runner at call time so a rebuild/reload rebinds built-in tools to the
		// live runner instead of wedging them on the invalidated one's stale-ctx guard.
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			() => this._extensionRunner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;
		this._reportToolNameConflicts();

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const pythonSkills = getPythonSkillRuntimeInfo(this._modelVisibleSkills());
		let configuredBaseToolDefinitions: Record<string, ToolDefinition>;
		if (this._baseToolsOverride) {
			configuredBaseToolDefinitions = Object.fromEntries(
				Object.entries(this._baseToolsOverride).map(([name, tool]) => [
					name,
					createToolDefinitionFromAgentTool(tool),
				]),
			);
		} else {
			// Rebuilding (e.g. /reload) replaces the provisioner; drop the previous
			// kernel so the session never holds two live kernels. Gate the new kernel's
			// startup on the old one's dispose (which flushes a final snapshot), so a
			// reload can't restore from a snapshot the old kernel is still writing.
			const previousDispose = this._ipythonKernelProvisioner?.dispose();
			// Write side: the kernel snapshot writer owns this directory, so it is
			// created here rather than by any read path that merely wants the path.
			this._ipythonKernelSnapshotDir = this.sessionManager.ensureSessionArtifactDir();
			// Only surface the "revived from your previous session" notice on the first
			// build (a genuine resume). A later rebuild (/reload) restores state silently
			// for continuity — the conversation is unchanged, so there's nothing to flag.
			const notifyRestore = !this._ipythonRuntimeBuilt;
			this._ipythonKernelProvisioner = new IpythonKernelProvisioner(this._cwd, {
				env: this._rlmKernelEnv(),
				commandPrefix: this.settingsManager.getShellCommandPrefix(),
				shellPath: this.settingsManager.getShellPath(),
				sessionId: this.sessionId,
				// Handler registration is a one-time snapshot taken here, while skill
				// visibility (_modelVisibleSkills) is recomputed on every system-prompt
				// rebuild. The writable-probe TTL therefore bounds a known
				// eventual-consistency window to at most one TTL: the model can briefly see
				// the refine skill before its handler is registered, or the reverse. This is
				// fail-closed - the hard preflight before an actual refine still catches a
				// genuinely unwritable store.
				hostHandlers: this._createKernelHostHandlers(),
				pythonSkills,
				snapshotDir: this._ipythonKernelSnapshotDir,
				readyGate: previousDispose,
				onRestore: notifyRestore ? (result) => this._onIpythonStateRestored(result) : undefined,
				onUnexpectedExit: (cause, facts) => this._reportUnexpectedKernelExit(cause, facts),
				onSnapshotFailure: (detail) => this._onKernelSnapshotWriteFailure(detail),
				onStartupFailure: (error) => this._onIpythonStartupFailure(error),
				restartPolicy: () => {
					const restart = this.settingsManager.getKernelRestartSettings();
					return { maxRestarts: restart.maxUnexpectedRestarts, windowMs: restart.windowMs };
				},
				cancellableHostRequestTypes: CANCELLABLE_KERNEL_HOST_REQUEST_TYPES,
				// Read-only requests borrow the short agent-message tier: they cannot tear state by
				// being cut off, and unbounded they would hold a cell (and the vouch excusing its
				// silence) for as long as the handler likes.
				readOnlyHostRequestTimeoutMs: () => this.settingsManager.getAgentMessageWaitSettings().bindMs,
				onLateHostReply: (reply) => this._reportLateKernelHostReply(reply),
			});
			configuredBaseToolDefinitions = createAllToolDefinitions(this._cwd, {
				ipython: {
					provisioner: this._ipythonKernelProvisioner,
					commandPrefix: this.settingsManager.getShellCommandPrefix(),
					shellPath: this.settingsManager.getShellPath(),
					onLateSentAgentMessage: (toolCallId, message) =>
						this._recordLateIpythonSentAgentMessage(toolCallId, message),
					getAbortCause: () => this.lastStallAbortCause,
				},
			});
		}

		this._baseToolDefinitions = new Map(
			Object.entries(configuredBaseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}
		// Re-apply on (re)build so the provider survives /reload. Guarded: the
		// runtime object can be shared across sessions from one ResourceLoader
		// (RLM children), so a provider-less session must not wipe the owner's.
		if (this._execEnvProvider) {
			extensionsResult.runtime.getExecEnv = this._execEnvProvider;
		}

		const previousRunner: ExtensionRunner | undefined = this._extensionRunner;
		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
			{ handlerTimeoutMs: this.settingsManager.getExtensionHandlerTimeoutMs() },
		);
		// Retire only when the extension world restarts (reload); runtime-only rebuilds adopt the timer host instead, so session_start timers survive and unload still cancels them.
		if (previousRunner) {
			if (previousRunner.builtFromSameExtensions(extensionsResult.extensions)) {
				this._extensionRunner.adoptHostTimers(previousRunner);
			} else {
				previousRunner.retire();
			}
		}
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const previousAcpMcpToolNames = new Set(this._acpMcpTools.map((tool) => tool.name));
		const acpServers = this._mcpManager?.getAcpServers() ?? [];
		if (acpServers.length > 0 && !this._ipythonKernelProvisioner) {
			throw new Error("ACP MCP servers require the built-in cpython tool");
		}
		const acpMcpTools = this._ipythonKernelProvisioner
			? createAcpMcpToolDefinitions(acpServers, this._ipythonKernelProvisioner)
			: [];
		this._assertAcpMcpToolNamesAvailable(acpMcpTools.map((tool) => tool.name));
		for (const name of previousAcpMcpToolNames) this._allowedToolNames?.delete(name);
		for (const tool of acpMcpTools) this._allowedToolNames?.add(tool.name);
		this._acpMcpTools = acpMcpTools;

		const defaultActiveToolNames = this._baseToolsOverride ? Object.keys(this._baseToolsOverride) : ["ipython"];
		const baseActiveToolNames = [...(options.activeToolNames ?? defaultActiveToolNames)];
		if (this._goalState.status === "active" && this._includeGoals) {
			// An active goal needs ipython so the model can reach the goal skill.
			baseActiveToolNames.push("ipython");
		}
		this._refreshToolRegistry({
			activeToolNames: [...new Set(baseActiveToolNames)],
			includeAllExtensionTools: options.includeAllExtensionTools,
		});

		// Prewarm when configured, or whenever we're resuming a session that already
		// has a kernel snapshot — so its state is revived and the model is told what
		// came back before the first turn, rather than a turn later when the kernel
		// would otherwise lazily start on first use.
		const hasSnapshot =
			!!this._ipythonKernelSnapshotDir && existsSync(snapshotPathIn(this._ipythonKernelSnapshotDir));
		if ((this._prewarmIpythonKernel || hasSnapshot) && this.getActiveToolNames().includes("ipython")) {
			this._ipythonKernelProvisioner?.prewarm();
		}

		// Subsequent builds are in-process rebuilds (/reload), not a fresh resume.
		this._ipythonRuntimeBuilt = true;
	}

	/**
	 * Skills exposed to the model (system prompt + kernel). The bundled goal
	 * and compact skills are withheld when disabled for this session.
	 */
	private _modelVisibleSkills(): Skill[] {
		let skills = this._resourceLoader.getSkills().skills;
		if (!this._includeGoals) {
			skills = skills.filter((skill) => skill.name !== GOAL_SKILL_NAME);
		}
		if (!this._includeCompactSkill) {
			skills = skills.filter((skill) => skill.name !== COMPACT_SKILL_NAME);
		}
		if (!this._autoRefineAllowedForSession()) {
			skills = skills.filter((skill) => skill.name !== REFINE_SKILL_NAME);
		}
		if (!this._agentMessageController) {
			skills = skills.filter((skill) => skill.name !== AGENT_MESSAGE_SKILL_NAME);
		}
		if (!this._agentObserveController) {
			skills = skills.filter((skill) => skill.name !== AGENT_OBSERVE_SKILL_NAME);
		}
		if (!this._agentObserveController || !this._rlmHeartbeatController) {
			skills = skills.filter((skill) => skill.name !== ORCHESTRATION_HEARTBEAT_SKILL_NAME);
		}
		return skills;
	}

	private _createKernelHostHandlers(): HostRequestHandlers {
		const handlers: HostRequestHandlers = {
			"rlm.run": createRlmRunHostHandler(async ({ prompt, kwargs, cellSourceCode }, signal) => ({
				...(await this.runRlmChild(prompt, kwargs, cellSourceCode, signal)),
			})),
			"rlm.create_session": createRlmCreateSessionHostHandler(async ({ prompt, kwargs }) => ({
				...(await this.createRlmSession(prompt, kwargs)),
			})),
			"bash.completed": createAsyncBashCompletionHostHandler(async (details) => {
				const message = createAsyncBashCompletionMessage(details);
				const disposeSignal = this._sessionActionCommitDisposeAbortController.signal;
				while (true) {
					let admissionCommitted = false;
					try {
						await this._promptInjectedMessage(message.content, message, {
							streamingBehavior: "steer",
							queueIfBusy: true,
							resumeIfIdle: true,
							returnAfterAccepted: true,
							suppressAutonomousContinuation: true,
							admissionCommitted: () => {
								admissionCommitted = true;
							},
						});
						return;
					} catch (error) {
						if (admissionCommitted || !(error instanceof SessionInputAdmissionPausedError)) throw error;
						while (this._sessionInputAdmissionPauses.size > 0 && !disposeSignal.aborted) {
							await this._waitForSessionActivityChange(disposeSignal);
						}
					}
				}
			}),
			"bash.consumed": createAsyncBashConsumedHostHandler((details) => {
				this._withdrawAsyncBashCompletionNotice(details);
			}),
			"rlm.find_models": createRlmFindModelsHostHandler((query, limit) => this.findRlmModels(query, limit)),
			"rlm.list_subagents": createRlmListSubagentsHostHandler(() => this.listRlmSubagents()),
			"rlm.collect": createRlmCollectHostHandler(
				(targets, timeoutMs, signal) => this.collectRlmChildren(targets, timeoutMs, signal),
				{
					// The same live value the kernel bounds a read-only host request with
					// (readOnlyHostRequestTimeoutMs). Staying inside it is what makes a
					// collect return snapshots instead of a kernel timeout error, and it
					// keeps the request from vouching for the cell's silence any longer
					// than any other read-only request may.
					maxWaitMs: () => this.settingsManager.getAgentMessageWaitSettings().bindMs,
					onClamped: ({ requestedMs, effectiveMs }) => {
						// Countable: a wait the host shortened is a fact the caller cannot
						// see any other way.
						sessionLog.info("rlm collect wait clamped", {
							sessionId: this.sessionId,
							requestedMs,
							effectiveMs,
						});
					},
				},
			),
			"rlm.progress.note": createRlmProgressNoteHostHandler((message) => this.noteRlmProgress(message)),
			"rlm.delete_subagent": createRlmDeleteSubagentHostHandler((target) => this.deleteRlmSubagent(target)),
			"model.info": async () => ({
				id: this.model?.id ?? null,
				provider: this.model?.provider ?? null,
				input: this.model?.input ?? [],
			}),
		};
		if (this._includeGoals) {
			for (const type of ["goal.get", "goal.create", "goal.complete"]) {
				handlers[type] = async (payload) => this.handleGoalHostRequest(type, payload);
			}
		}
		if (this._includeCompactSkill) {
			for (const type of ["compact.run", "compact.status"]) {
				handlers[type] = async (payload) => this.handleCompactHostRequest(type, payload);
			}
		}
		if (this._autoRefineAllowedForSession()) {
			for (const type of ["refine.run", "refine.status"]) {
				handlers[type] = async (payload) => this.handleRefineHostRequest(type, payload);
			}
		}
		if (this._rlmHeartbeatController) {
			for (const type of [
				"rlm_heartbeat.list",
				"rlm_heartbeat.create",
				"rlm_heartbeat.update",
				"rlm_heartbeat.delete",
			]) {
				handlers[type] = async (payload) => this.handleRlmHeartbeatHostRequest(type, payload);
			}
		}
		const visibleKernelSkillNames = new Set(
			this._modelVisibleSkills()
				.filter((skill) => !skill.disableModelInvocation)
				.map((skill) => skill.name),
		);
		const messageController = this._agentMessageController;
		if (messageController && visibleKernelSkillNames.has(AGENT_MESSAGE_SKILL_NAME)) {
			Object.assign(
				handlers,
				createAgentMessageHostHandlers(
					{
						roster: async () =>
							(await this.handleAgentMessageHostRequest("agent_message.list_agents")) as AgentFamilyRosterResult,
						awaitPendingChildPublication: (selector, signal) =>
							this._awaitPendingRlmChildPublication(selector, signal),
						sendAgentMessage: async (input) => {
							const receipt = (await this.handleAgentMessageHostRequest("agent_message.send", {
								target: input.target,
								message: input.message,
							})) as AgentSessionMessageReceipt;
							// B1: only a delivered reply counts as "the child replied". A
							// queued receipt means the parent has not seen anything yet, and
							// counting it would let the parent's terminal gate treat a
							// still-undelivered reply as delivered - the child believes it
							// answered while the parent never receives a notice.
							if (this._rlmDepth > 0) {
								let addressedParent = input.receiverRole === "parent";
								if (input.receiverRole === undefined && this._agentMessageController?.roster) {
									try {
										const roster = await this._agentMessageController.roster();
										addressedParent = roster.entries.some(
											(entry) =>
												entry.relationship === "parent" &&
												(entry.id === input.target || entry.name === input.target),
										);
									} catch {
										addressedParent = false;
									}
								}
								if (
									countsAsDeliveredParentReply({
										rlmDepth: this._rlmDepth,
										deliveryStatus: receipt.deliveryStatus,
										addressedParent,
									})
								) {
									this._repliedToParentSinceTask = true;
									this._parentReplyCount += 1;
								}
							}
							return receipt;
						},
					},
					{
						// Read live: an operator tuning the wait must not have to rebuild the runtime.
						publicationWaitMs: this.settingsManager.getAgentMessageWaitSettings().publicationMs,
						onWaitTimeout: (facts) => this._reportAgentMessageWaitTimeout(facts),
						onDuplicateSuppressed: ({ messageId, record }) => {
							// Countable: this is the line that says a retry was caught instead of
							// delivered twice, which is the whole point of sender-minted ids (C15).
							// outcome=uncertain marks the fail-closed refusals, which are the ones
							// worth watching: they mean a delivery leg failed to report back.
							sessionLog.info("agent message duplicate suppressed", {
								sessionId: this.sessionId,
								messageId,
								outcome: record.outcome,
								...(record.target === undefined ? {} : { target: record.target }),
								handledAt: record.at,
							});
						},
					},
				),
			);
		}
		if (this._agentObserveController) {
			Object.assign(
				handlers,
				createAgentObserveHostHandlers({
					listAgents: () => this.handleAgentObserveHostRequest("agent_observe.list") as AgentObserveListResult,
					getAgent: (target) =>
						this.handleAgentObserveHostRequest("agent_observe.get", {
							target,
						}) as AgentObserveAgentSnapshot,
					recentMessages: (input) =>
						this.handleAgentObserveHostRequest("agent_observe.recent", {
							target: input.target,
							limit: input.limit,
							max_chars: input.maxChars,
						}) as AgentObserveRecentMessagesResult,
				}),
			);
		}
		if (this._mcpManager) {
			Object.assign(handlers, this._mcpManager.hostHandlers());
		}
		return handlers;
	}

	async reload(): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, {
			type: "session_shutdown",
			reason: "reload",
		});
		await this.settingsManager.reload();
		// Re-read auth.json: a login saved by the client process (daemon mode) must be
		// visible here so MCP skill gating sees the new credentials.
		this._modelRegistry.authStorage.reload();
		resetApiProviders();
		this._mcpManager?.refresh();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await this._extensionRunner.emit({
				type: "session_start",
				reason: "reload",
			});
			await this.extendResourcesFromExtensions("reload");
		}
	}

	private _rlmKernelEnv(): Record<string, string> {
		// Kernel env is provisioning-time only: RLM_MAX_DEPTH may be stale in an already-running kernel;
		// the TypeScript-side spawn check remains authoritative.
		const env: Record<string, string> = {
			RLM_DEPTH: String(this._rlmDepth),
			// The effective cap, not this session's own value: a kernel told it may recurse when
			// an ancestor has already lowered the subtree cap only finds out by being refused.
			RLM_MAX_DEPTH: String(this._effectiveRlmMaxDepth()),
			RLM_GLOBAL_HARNESS_STATE_DIR: getGlobalHarnessStateDir(),
		};
		const rlmSessionDir = this._ensureRlmSessionDir();
		if (rlmSessionDir) {
			env.RLM_SESSION_DIR = rlmSessionDir;
			// Keep kernel writes and host reads (system prompt, review, /refine) on
			// the same local harness path. Subagents prefer their own artifact dir;
			// ephemeral sessions fall back to the RLM session dir once it exists.
			env.RLM_HARNESS_STATE_DIR = this._localHarnessStateDir() ?? getLocalHarnessStateDir(rlmSessionDir)!;
		}
		this._addWebsearchKeyEnv(env);
		return env;
	}

	private _addWebsearchKeyEnv(env: Record<string, string>): void {
		if (this._agentDir) {
			env.PRIME_AGENT_CODING_AGENT_DIR = this._agentDir;
		}

		if (process.env[SERPER_ENV_VAR]?.trim()) {
			return;
		}
		// Inject only when a websearch skill (bundled or custom) is actually loaded,
		// so the key isn't exposed to kernels that can't use it.
		if (!this._resourceLoader.getSkills().skills.some((skill) => skill.name === WEBSEARCH_SKILL_NAME)) {
			return;
		}
		const cred = this._modelRegistry.authStorage.get(SERPER_CREDENTIAL_ID);
		if (cred?.type !== "api_key") {
			return;
		}
		const resolved = resolveConfigValue(cred.key)?.trim();
		if (resolved) {
			env[SERPER_ENV_VAR] = resolved;
		}
	}

	// Undefined when there's no persistent artifact dir (e.g. the viewer client):
	// don't mkdtemp here, since this runs on every kernel build but a viewer never
	// does RLM work. The temp dir is created lazily in _createChildRlmSessionDir.
	private _ensureRlmSessionDir(): string | undefined {
		if (this._rlmSessionDir) {
			ensurePrivateDirectory(this._rlmSessionDir);
			return this._rlmSessionDir;
		}

		const sessionArtifactDir = this.sessionManager.ensureSessionArtifactDir();
		if (sessionArtifactDir) {
			ensurePrivateDirectory(sessionArtifactDir);
			this._rlmSessionDir = sessionArtifactDir;
			return sessionArtifactDir;
		}

		return undefined;
	}

	private _createChildRlmSessionDir(): string {
		const parentDir = this._ensureRlmSessionDir() ?? this._createEphemeralRlmSessionDir();
		for (let i = 0; i < 100; i++) {
			const childDir = join(parentDir, `sub-${randomUUID().slice(0, 8)}`);
			try {
				mkdirSync(childDir, { mode: 0o700 });
				return childDir;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") {
					continue;
				}
				throw error;
			}
		}
		throw new Error("Unable to create unique RLM child session directory");
	}

	/**
	 * Admit the child's session directory only around the checks that can still refuse the
	 * spawn (SC-3). The directory has to exist first because the default session name embeds
	 * its unique basename, so a refusal after creation must remove it again: a refused spawn
	 * that leaves `sub-xxxxxxxx` behind is a disk leak with no owner.
	 */
	private async _admitChildRlmSessionDir(
		requestedSessionName: string | undefined,
		prompt: string,
		signal: AbortSignal | undefined,
	): Promise<{ childSessionDir: string; childNodeId: string; sessionName: string }> {
		const childSessionDir = this._createChildRlmSessionDir();
		try {
			const childNodeId = basename(childSessionDir);
			const sessionName = requestedSessionName ?? createDefaultRlmSubagentSessionName(prompt, childNodeId);
			if (!requestedSessionName) await this._assertRlmSubagentSessionNameAvailable(sessionName);
			signal?.throwIfAborted();
			return { childSessionDir, childNodeId, sessionName };
		} catch (error) {
			try {
				rmSync(childSessionDir, { recursive: true, force: true });
			} catch (cleanupError) {
				sessionLog.warn("failed to remove the session directory of a refused subagent spawn", {
					sessionId: this.sessionId,
					sessionDir: childSessionDir,
					error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
				});
			}
			throw error;
		}
	}

	private _createEphemeralRlmSessionDir(): string {
		this._rlmSessionDir = mkdtempSync(join(tmpdir(), "prime-agent-rlm-"));
		this._rlmSessionDirEphemeral = true;
		return this._rlmSessionDir;
	}

	/**
	 * R31-8/RC-6: remove the ephemeral `prime-agent-rlm-*` temp directory at
	 * dispose. Nothing durable ever referenced it (an in-memory parent has no
	 * artifact dir; children and harness state live inside it), so keeping it
	 * was a per-session leak - 314 measured on one machine, all empty.
	 */
	private _removeEphemeralRlmSessionDir(): void {
		const directory = this._rlmSessionDirEphemeral ? this._rlmSessionDir : undefined;
		if (!directory) return;
		this._rlmSessionDir = undefined;
		this._rlmSessionDirEphemeral = false;
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch (error) {
			sessionLog.warn("failed to remove the ephemeral RLM session directory", {
				sessionId: this.sessionId,
				sessionDir: directory,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	_contextTokensForCurrentMessages(): number | undefined {
		const last = this._findLastAssistantMessage();
		return last ? calculateContextTokens(last.usage) : undefined;
	}

	setCurrentRecap(recap: string | undefined): void {
		if (this._currentRecap === recap) return;
		this._currentRecap = recap;
		this._emit({ type: "recap_update", recap });
	}

	get repliedToParentSinceTask(): boolean | undefined {
		return this._repliedToParentSinceTask;
	}

	getCurrentRecap(): string | undefined {
		return this._currentRecap;
	}

	private _findAssistantEntryForMessage(message: AssistantMessage): SessionMessageEntry | undefined {
		return this.sessionManager
			.getEntries()
			.find((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message === message);
	}

	private _createRlmSubagentRuntimeOptions(options: {
		id: string;
		prompt: string;
		sessionName: string;
		spawnCode?: string;
		sessionDir: string;
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
		spawnedByRequestId?: string;
	}): CreateRlmSubagentRuntimeOptions {
		return {
			parentSession: this,
			id: options.id,
			prompt: options.prompt,
			sessionName: options.sessionName,
			spawnCode: options.spawnCode,
			sessionDir: options.sessionDir,
			model: options.model,
			thinkingLevel:
				options.thinkingLevel ?? (clampThinkingLevel(options.model, this.thinkingLevel) as ThinkingLevel),
			serviceTier:
				this.serviceTier === "priority" && !supportsFastMode(options.model) ? "default" : this.serviceTier,
			scopedModels: [...this._scopedModels],
			activeToolNames: this.getActiveToolNames(),
			allowedToolNames: this._allowedToolNames ? [...this._allowedToolNames] : undefined,
			customTools: [...this._customTools],
			// G2 (r37 hbgoal-ts): goal pursuit stays a depth-0 capability, symmetric
			// with the CLI initialGoal seeding gate below; a subagent (rlmDepth >= 1)
			// must not be able to seed its own self-continuing goal chain.
			includeGoals: false,
			includeCompactSkill: this._includeCompactSkill,
			rlmDepth: this._rlmDepth + 1,
			// Re-read the cap in force *now*: the child is granted what this session currently
			// may spawn under, ceiling included, not the value it resolved for itself (SC-2).
			rlmMaxDepth: this._effectiveRlmMaxDepth(),
			rlmParentNodeId: options.id,
			spawnedByRequestId: options.spawnedByRequestId,
		};
	}

	private async _createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime> {
		if (this._subagentRuntimeHost) {
			return await this._subagentRuntimeHost.createRlmSubagentRuntime(options);
		}

		return this._createInlineRlmSubagentRuntime(options);
	}

	private _createInlineRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): RlmSubagentRuntime {
		const childSessionManager = options.parentSession.sessionManager.allowsPersistence()
			? SessionManager.create(this._cwd, options.sessionDir)
			: SessionManager.inMemory(this._cwd, options.sessionDir);
		childSessionManager.newSession({
			parentSession: options.parentSession.sessionFile,
			rlmDepth: options.rlmDepth,
		});
		childSessionManager.appendModelChange(options.model.provider, options.model.id);
		childSessionManager.appendThinkingLevelChange(options.thinkingLevel);
		childSessionManager.appendServiceTierChange(options.serviceTier);

		const childAgent = new Agent({
			initialState: {
				systemPrompt: "",
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				serviceTier: options.serviceTier,
				tools: [],
			},
			convertToLlm: this.agent.convertToLlm,
			transformContext: this.agent.transformContext,
			streamFn: this.agent.streamFn,
			getApiKey: this.agent.getApiKey,
			onPayload: this.agent.onPayload,
			onResponse: this.agent.onResponse,
			steeringMode: this.settingsManager.getSteeringMode(),
			followUpMode: this.settingsManager.getFollowUpMode(),
			sessionId: childSessionManager.getSessionId(),
			thinkingBudgets: this.settingsManager.getThinkingBudgets(),
			transport: this.settingsManager.getTransport(),
			toolExecution: this.agent.toolExecution,
			streamStallTimeoutMs: this.agent.streamStallTimeoutMs,
			emptyTurnRetry: this.settingsManager.getEmptyTurnRetrySettings(),
		});

		const child = new AgentSession({
			agent: childAgent,
			sessionManager: childSessionManager,
			settingsManager: this.settingsManager,
			cwd: this._cwd,
			agentDir: this._agentDir,
			scopedModels: options.scopedModels,
			resourceLoader: this._resourceLoader,
			customTools: options.customTools,
			modelRegistry: this._modelRegistry,
			initialActiveToolNames: options.activeToolNames,
			allowedToolNames: options.allowedToolNames,
			includeGoals: options.includeGoals,
			includeCompactSkill: options.includeCompactSkill,
			rlmDepth: options.rlmDepth,
			rlmMaxDepth: options.rlmMaxDepth,
			rlmSessionDir: options.sessionDir,
			rlmParentNodeId: options.rlmParentNodeId,
			rlmParentAgent: options.parentSession.sessionName ?? options.parentSession.sessionId,
			semanticParentSessionId: options.parentSession.sessionId,
			semanticSpawnedByRequestId: options.spawnedByRequestId,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		if (child.sessionName !== options.sessionName) {
			try {
				child.setSessionName(options.sessionName);
			} catch (error) {
				child.dispose();
				throw error;
			}
		}
		options.onSessionPublished?.(child);

		return { session: child };
	}

	private _abandonRlmRunForQuiescence(run: RlmChildRun): void {
		run.suppressTerminalNotice = true;
		run.abandonedForQuiescence = true;
		this._abandonedRlmQuiescenceChildIds.add(run.id);
		this._unsettledRlmChildRuns.delete(run);
		run.settlement.resolve();
		this._maybeResumeGoalContinuationAfterRlmWork();
		this._maybeResumeAutonomousContinuationAfterRlmWork();
	}

	/**
	 * Cancel the runs this session itself tracks. One step of the abort cascade
	 * (see `_abortRlmSubtree`) and the whole of dispose's cancellation, which then
	 * disposes every retained child session and lets each one cancel its own.
	 */
	private _cancelActiveRlmChildRuns(reason: string): void {
		for (const run of this._activeRlmChildRuns.values()) {
			this._cancelRlmChildRun(run, reason);
		}
	}

	/**
	 * Cancel every running or queued RLM run in this session's subtree *and* stop
	 * the in-flight turn of every retained descendant session.
	 *
	 * `_cancelActiveRlmChildRuns` alone only sees this session's own map, so a child
	 * that had already settled - then been followed up, then spawned a child of its
	 * own - kept running after the parent was killed, while `hasRunningRlmChildren()`
	 * (which walks the subtree) reported the family as busy. Walking the same subtree
	 * here aligns the kill with the judgement.
	 *
	 * `requestAbort` deliberately has no cascade semantics, so stopping each
	 * descendant's own turn costs O(nodes) rather than O(depth^2); the visited set in
	 * `_rlmSubtreeSessions` keeps a child that sits in both maps from being walked
	 * twice. This session is excluded from step 2 because the caller already aborted
	 * it. Cross-worker descendants are out of reach of an in-process walk and are
	 * covered by the supervisor's kill path instead.
	 */
	private _abortRlmSubtree(reason: string): { cancelled: number; failures: number; depth: number } {
		let cancelled = 0;
		let failures = 0;
		let depth = this._rlmDepth;
		for (const session of this._rlmSubtreeSessions()) {
			depth = Math.max(depth, session._rlmDepth);
			for (const run of [...session._activeRlmChildRuns.values()]) {
				try {
					if (!session._cancelRlmChildRun(run, reason)) continue;
					cancelled += 1;
					// The cancel already fired run.abort(); drop the handle so a second
					// trigger (a late publication, a repeated cascade) cannot abort the
					// same child session again.
					run.abort = noopRlmChildAbort;
				} catch (error) {
					failures += 1;
					sessionLog.warn("rlm abort cascade: cancelling a descendant run failed", {
						reason,
						childId: run.id,
						sessionId: session.sessionId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			if (session === this) continue;
			try {
				// A retained descendant can be mid-turn with no run of ours tracking it:
				// it settled, was followed up, and is now streaming that follow-up.
				if (session.isStreaming) session.requestAbort({ reason: "user" });
			} catch (error) {
				failures += 1;
				sessionLog.warn("rlm abort cascade: stopping a descendant turn failed", {
					reason,
					sessionId: session.sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (cancelled > 0 || failures > 0) {
			// Countable answer to "how much work did one Esc actually stop".
			sessionLog.info("rlm abort cascade", {
				reason,
				cancelled,
				failures,
				depth,
				sessionId: this.sessionId,
			});
		}
		return { cancelled, failures, depth };
	}

	private _cancelRlmChildRun(run: RlmChildRun, reason: string): boolean {
		// Cancellation is an idempotent terminal transition while the detached
		// run remains tracked. Concurrent callers must not mistake a previously
		// accepted cancellation for a completed child and start conflicting cleanup.
		if (run.status === "cancelled") {
			return true;
		}
		if (run.status !== "running" && run.status !== "queued") {
			return false;
		}
		run.status = "cancelled";
		if (this._sessionInputPumpSuspended) this._abandonRlmRunForQuiescence(run);
		run.error = reason;
		run.publication.reject(new Error(reason));
		run.abort();
		// Surface the cancellation immediately; the run's own terminal update is
		// delayed indefinitely when the child is stuck mid-stream, which is
		// exactly when users reach for the kill.
		run.emitUpdate?.();
		return true;
	}

	/**
	 * Stop a child session that was published after its run had already been
	 * cancelled. Per-session try/catch so a child that cannot be stopped still
	 * leaves a trace instead of failing the publish path.
	 */
	private _abortRlmChildSessionOnPublish(run: RlmChildRun, child: AgentSession): void {
		try {
			void child.abort();
		} catch (error) {
			sessionLog.warn("rlm child published after cancellation could not be aborted", {
				childId: run.id,
				sessionId: child.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * M6b: turn a repeatedly retryable send failure into a terminal one. The first
	 * attempts pass the original error through unchanged (so a transient rate limit
	 * or a full queue stays retryable); from the third consecutive failure the caller
	 * gets an error that says retrying is pointless and what to do instead.
	 */
	/**
	 * Drop expired entries (O1): entries whose last failure is older than the TTL
	 * are not "consecutive" with a fresh one. Runs before the count is read so a
	 * stale entry for the current target does not survive into the count.
	 */
	private _expireAgentMessageSendFailures(now: number): void {
		for (const [target, failure] of this._agentMessageSendFailures) {
			if (now - failure.lastFailedAt > AGENT_MESSAGE_SEND_FAILURE_TTL_MS) {
				this._agentMessageSendFailures.delete(target);
			}
		}
	}

	/**
	 * Enforce the volume ceiling (O1): the ledger never grows past
	 * `AGENT_MESSAGE_SEND_FAILURE_MAX_TARGETS` targets. The eviction prefers the
	 * entry carrying the least information - lowest consecutive-failure count,
	 * ties broken by least-recent failure (re-insertion on update keeps the map's
	 * insertion order aligned with recency). A target mid-failure-sequence (count
	 * already 2+) is therefore never evicted while single-failure targets exist;
	 * the pre-fix order pruned by plain recency before the count was read, which
	 * could reset the count of the target that was failing right now.
	 */
	private _enforceAgentMessageSendFailureCeiling(): void {
		while (this._agentMessageSendFailures.size >= AGENT_MESSAGE_SEND_FAILURE_MAX_TARGETS) {
			let victim: string | undefined;
			let victimCount = Number.POSITIVE_INFINITY;
			for (const [target, failure] of this._agentMessageSendFailures) {
				if (failure.count < victimCount) {
					victim = target;
					victimCount = failure.count;
				}
			}
			if (victim === undefined) break;
			this._agentMessageSendFailures.delete(victim);
		}
	}

	private _terminalizeRepeatedAgentMessageSendFailure(target: string, error: unknown): Error {
		const message = error instanceof Error ? error.message : String(error);
		const original = error instanceof Error ? error : new Error(message);
		// (a) drives the strike count: only a provably pre-delivery refusal is
		// retryable bookkeeping. (b) drives the terminal guidance once the budget
		// is burned: an update-restart fence must not invite another retry.
		const classification = classifyAgentMessageSendFailureByMessage(message);
		if (!classification.deliveredNothing) {
			this._agentMessageSendFailures.delete(target);
			return original;
		}
		const now = Date.now();
		this._expireAgentMessageSendFailures(now);
		const attempts = (this._agentMessageSendFailures.get(target)?.count ?? 0) + 1;
		this._agentMessageSendFailures.delete(target);
		this._agentMessageSendFailures.set(target, { count: attempts, lastError: message, lastFailedAt: now });
		this._enforceAgentMessageSendFailureCeiling();
		if (attempts < AGENT_MESSAGE_RETRYABLE_FAILURE_LIMIT) return original;
		// Countable signature for a sender that burned its retry budget (appendix B).
		sessionLog.warn("agent message retryable repeat terminal", {
			sessionId: this.sessionId,
			target,
			attempts,
			lastError: message,
		});
		return new Error(
			formatAgentMessageRetryExhaustedError({
				target,
				attempts,
				lastError: message,
				fenced: classification.retryNowSucceeds === false,
			}),
		);
	}

	getRlmChildRunStatus(childId: string): RlmChildAgentStatus | undefined {
		return this._activeRlmChildRuns.get(childId)?.status;
	}

	private async _currentActiveSessionId(): Promise<string | undefined> {
		try {
			return (await this._agentMessageController?.listAgents())?.current?.activeSessionId;
		} catch {
			return undefined;
		}
	}

	private async _awaitPendingRlmChildPublication(selector: string, signal?: AbortSignal): Promise<string | undefined> {
		const run = [...this._activeRlmChildRuns.values()].find(
			(candidate) =>
				(candidate.status === "queued" || candidate.status === "running" || candidate.status === "done") &&
				!candidate.detachedDeletion &&
				(candidate.id === selector || candidate.sessionName === selector),
		);
		if (!run) return undefined;
		// Abortable, and bounded by the caller that owns the wait settings
		// (createAgentMessageHostHandlers): a cancelled cell must not leave this parked on a
		// publication deferred that may never settle, and the wait never cancels the publication
		// itself, which would tear a child that is halfway through being created.
		await untilAborted(run.publication.promise, signal);
		return run.session?.sessionId;
	}

	/**
	 * Child-side progress note admission. The host wrapper validated shape and
	 * length; this throttles per session (event-loop spam guard) and re-emits
	 * an `rlm_progress_note` event for the parent's child-event subscription.
	 * Pull-based only: rejected notes return a retry hint instead of an error.
	 */
	noteRlmProgress(message: string): RlmProgressNoteResult {
		const now = Date.now();
		const lastAt = this._lastRlmProgressNoteAt;
		if (lastAt !== undefined && now - lastAt < RLM_PROGRESS_NOTE_MIN_INTERVAL_MS) {
			return { accepted: false, retry_after_ms: RLM_PROGRESS_NOTE_MIN_INTERVAL_MS - (now - lastAt) };
		}
		this._lastRlmProgressNoteAt = now;
		this._emit({ type: "rlm_progress_note", message, timestamp: now });
		return { accepted: true, retry_after_ms: undefined };
	}

	async listRlmSubagents(): Promise<RlmListSubagentsResult> {
		return this._buildRlmSubagentList(await this._agentMessageController?.listAgents());
	}

	private _buildRlmSubagentList(listedAgents?: AgentSessionMessageListResult): RlmListSubagentsResult {
		const daemonChildren = new Map<string, AgentSessionMessageAgentSummary>();
		const parentActiveSessionId = listedAgents?.current?.activeSessionId;
		if (parentActiveSessionId) {
			for (const agent of listedAgents.agents) {
				if (
					agent.runtimeKind === "subagent" &&
					agent.parentActiveSessionId === parentActiveSessionId &&
					agent.rlmChildId
				) {
					daemonChildren.set(agent.rlmChildId, agent);
				}
			}
		}

		const subagents: RlmListSubagentsResult["subagents"] = [];
		const recorded = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			if (this._deletingRlmChildren.has(run.id) || run.detachedDeletion || run.status === "cancelled") {
				continue;
			}
			const daemonChild = daemonChildren.get(run.id);
			subagents.push({
				rlm_child_id: run.id,
				active_session_id: daemonChild?.activeSessionId ?? null,
				session_id: daemonChild?.sessionId ?? run.session?.sessionId ?? null,
				session_name: daemonChild?.sessionName ?? run.session?.sessionName ?? run.sessionName,
				session_dir: run.sessionDir,
				status: run.status === "done" ? "completed" : run.status === "error" ? "error" : "running",
				// #2282 roster exception (parent ruling): the kernel roster is the
				// parent's polling surface for a child's latest progress note. Only
				// this one extra rides along - the collect envelope stays the fork's
				// six-field shape.
				...(run.progressNotes?.length ? { progress_note: run.progressNotes.at(-1) } : {}),
			});
			recorded.add(run.id);
		}
		for (const [childId, { session: childSession, run: retainedRun }] of this._rlmChildSessions) {
			if (
				this._deletingRlmChildren.has(childId) ||
				recorded.has(childId) ||
				this._rlmChildCleanupFailures.has(childId)
			) {
				continue;
			}
			const daemonChild = daemonChildren.get(childId);
			const sessionDir = childSession._rlmSessionDir;
			if (!sessionDir) {
				continue;
			}
			subagents.push({
				rlm_child_id: childId,
				active_session_id: daemonChild?.activeSessionId ?? null,
				session_id: daemonChild?.sessionId ?? childSession.sessionId,
				session_name:
					daemonChild?.sessionName ?? childSession.sessionName ?? createDefaultRlmSubagentSessionName("", childId),
				session_dir: sessionDir,
				status: "completed",
				...(retainedRun?.progressNotes?.length ? { progress_note: retainedRun.progressNotes.at(-1) } : {}),
			});
			recorded.add(childId);
		}
		for (const [childId, daemonChild] of daemonChildren) {
			if (
				recorded.has(childId) ||
				this._deletingRlmChildren.has(childId) ||
				this._deletedRlmChildIds.has(childId) ||
				this._rlmChildCleanupFailures.has(childId) ||
				!daemonChild.sessionDir
			) {
				continue;
			}
			subagents.push({
				rlm_child_id: childId,
				active_session_id: daemonChild.activeSessionId,
				session_id: daemonChild.sessionId,
				session_name: daemonChild.sessionName ?? createDefaultRlmSubagentSessionName("", childId),
				session_dir: daemonChild.sessionDir,
				status: daemonChild.rlmChildRegistryStatus === "completed" ? "completed" : "error",
			});
		}
		return { subagents };
	}

	/**
	 * Typed fan-in for direct RLM children: wait (bounded) for the selected runs to
	 * settle and return result envelopes.
	 *
	 * Never steers the parent, and never rejects on a timeout or a cell abort -
	 * both end the wait and return the snapshots as they are, and nothing behind
	 * the wait is cancelled, so the caller can end its turn, poll, or retry.
	 * `timeoutMs` of 0 is a guaranteed non-blocking read. `targets` are child ids,
	 * child session names, or child session ids; an empty list means every direct
	 * child that is not being deleted.
	 */
	async collectRlmChildren(targets: string[], timeoutMs: number, signal?: AbortSignal): Promise<RlmCollectResult> {
		const selected = this._selectRlmChildrenForCollect(targets);
		if (timeoutMs > 0) {
			const deadlineAt = Date.now() + timeoutMs;
			// allSettled on purpose: one run's timeout or abort must not strand the
			// other waits, and a settlement rejection is terminal state to report,
			// not a collect error.
			await Promise.allSettled(
				selected.runs
					.filter((run) => !run.settled)
					.map((run) => this._awaitRlmChildSettlementForCollect(run, deadlineAt, signal)),
			);
		}
		return {
			results: [
				...selected.runs.map((run) => this._rlmCollectEntryForRun(run)),
				...selected.runlessChildren.map(({ childId, child }) => this._rlmCollectEntryForSession(childId, child)),
			],
		};
	}

	/**
	 * The children one collect call may see.
	 *
	 * Three sources, because terminal cleanup and daemon recovery each move a child
	 * out of one of them: a run in flight, a settled run retained next to its
	 * session, and a session retained without any run (rehydrated after a daemon
	 * recovery). The roster shows all three, so a fan-in that saw less would report
	 * a finished child as unknown. Children pending deletion - or whose deletion
	 * cleanup failed - stay out: the delete path owns their selectors.
	 */
	private _selectRlmChildrenForCollect(targets: string[]): {
		runs: RlmChildRun[];
		runlessChildren: Array<{ childId: string; child: AgentSession }>;
	} {
		const runs = new Map<string, RlmChildRun>();
		for (const run of this._activeRlmChildRuns.values()) {
			if (this._isRlmChildHiddenFromCollect(run.id, run)) continue;
			runs.set(run.id, run);
		}
		const runlessChildren: Array<{ childId: string; child: AgentSession }> = [];
		for (const [childId, retained] of this._rlmChildSessions) {
			if (this._isRlmChildHiddenFromCollect(childId, retained.run)) continue;
			if (retained.run) {
				// The retained copy is the same run object the active map held, so this
				// only adds a run the terminal cleanup already dropped.
				if (!runs.has(childId)) runs.set(childId, retained.run);
				continue;
			}
			runlessChildren.push({ childId, child: retained.session });
		}
		if (targets.length === 0) {
			return { runs: [...runs.values()], runlessChildren };
		}
		const selectedRuns: RlmChildRun[] = [];
		const selectedRunless: Array<{ childId: string; child: AgentSession }> = [];
		const selectedIds = new Set<string>();
		for (const target of targets) {
			const matchedRuns = [...runs.values()].filter((run) => this._rlmChildRunMatchesCollectTarget(run, target));
			const matchedRunless = runlessChildren.filter(
				({ childId, child }) => childId === target || child.sessionId === target || child.sessionName === target,
			);
			if (matchedRuns.length + matchedRunless.length === 0) {
				throw new Error(`No direct RLM child matches "${target}" in the current parent session`);
			}
			if (matchedRuns.length + matchedRunless.length > 1) {
				throw new Error(`RLM child selector "${target}" is ambiguous in the current parent session`);
			}
			// A repeated selector collects the child once, not twice.
			for (const run of matchedRuns) {
				if (selectedIds.has(run.id)) continue;
				selectedIds.add(run.id);
				selectedRuns.push(run);
			}
			for (const entry of matchedRunless) {
				if (selectedIds.has(entry.childId)) continue;
				selectedIds.add(entry.childId);
				selectedRunless.push(entry);
			}
		}
		return { runs: selectedRuns, runlessChildren: selectedRunless };
	}

	private _isRlmChildHiddenFromCollect(childId: string, run?: RlmChildRun): boolean {
		return (
			run?.detachedDeletion !== undefined ||
			this._deletingRlmChildren.has(childId) ||
			this._deletedRlmChildIds.has(childId) ||
			this._rlmChildCleanupFailures.has(childId)
		);
	}

	private _rlmChildRunMatchesCollectTarget(run: RlmChildRun, target: string): boolean {
		const session = run.session ?? this._rlmChildSessions.get(run.id)?.session;
		return (
			run.id === target ||
			run.sessionName === target ||
			session?.sessionId === target ||
			session?.sessionName === target
		);
	}

	/**
	 * Wait for one run to settle, bounded by the collect deadline and by a cell
	 * abort. Both a timeout and an abort end the wait quietly: collect reports the
	 * facts it has, and the child keeps running either way.
	 */
	private async _awaitRlmChildSettlementForCollect(
		run: RlmChildRun,
		deadlineAt: number,
		signal?: AbortSignal,
	): Promise<void> {
		const remainingMs = deadlineAt - Date.now();
		if (run.settled || remainingMs <= 0) return;
		try {
			await withBound(
				// A settlement rejection is the run's terminal state, not a collect error.
				run.settlement.promise.then(
					() => undefined,
					() => undefined,
				),
				{
					timeoutMs: remainingMs,
					phase: "rlm_collect",
					target: run.id,
					label: "RLM child settlement",
					signal,
					targetState: () => run.status,
				},
			);
		} catch {
			// Timeout or abort: fall through to the snapshot the caller asked for.
		}
	}

	private _rlmCollectEntryForRun(run: RlmChildRun): RlmCollectResultEntry {
		const child = run.session ?? this._rlmChildSessions.get(run.id)?.session;
		const snapshot = this._rlmChildSnapshotForRun(run, child);
		return {
			rlm_child_id: snapshot.id,
			session_name: snapshot.sessionName,
			session_dir: snapshot.sessionDir,
			status: snapshot.status,
			settled: run.settled,
			answer_preview: snapshot.answerPreview,
			error: snapshot.error,
			duration_ms: snapshot.durationMs,
			tool_use_count: snapshot.toolUseCount,
			replied_since_task: snapshot.repliedSinceTask,
			activity_kind: snapshot.activity?.kind,
			terminal_kind: run.terminalKind,
			terminal_reason: run.terminalReason,
			no_reply_notice_superseded: run.noReplyNoticeSuperseded,
			// Same two sources the terminal classifier reads: the run's own record
			// survives a disposed child session, the child's copy is the fallback for
			// a kill the parent's subscription never observed.
			stall_abort: rlmCollectStallAbort(run.stallAbort ?? child?._lastStallAbort),
		};
	}

	private _rlmCollectEntryForSession(childId: string, child: AgentSession): RlmCollectResultEntry {
		const snapshot = this._rlmChildSnapshotForSession(childId, child);
		return {
			rlm_child_id: childId,
			session_name: snapshot.sessionName,
			session_dir: snapshot.sessionDir,
			status: snapshot.status,
			// No run exists (the daemon-recovery shape), so there is no settlement to
			// wait for; `activity_kind` is what says whether it is working again.
			settled: true,
			answer_preview: snapshot.answerPreview,
			error: snapshot.error,
			duration_ms: snapshot.durationMs,
			tool_use_count: snapshot.toolUseCount,
			replied_since_task: snapshot.repliedSinceTask,
			activity_kind: snapshot.activity?.kind,
			terminal_kind: undefined,
			terminal_reason: undefined,
			stall_abort: rlmCollectStallAbort(child._lastStallAbort),
		};
	}

	private _rlmSubagentMatchesTarget(entry: RlmSubagentRegistryEntry, target: string): boolean {
		return (
			entry.rlm_child_id === target ||
			entry.active_session_id === target ||
			entry.session_id === target ||
			entry.session_name === target
		);
	}

	private async _resolveDirectRlmSubagent(target: string): Promise<RlmSubagentRegistryEntry> {
		const candidates = [...(await this.listRlmSubagents()).subagents, ...this._rlmChildCleanupFailures.values()];
		const matches = candidates.filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		if (matches.length === 0) {
			throw new Error(`No direct RLM subagent matches "${target}" in the current parent session`);
		}
		if (matches.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		return matches[0]!;
	}

	async deleteInactiveRlmSubagent(
		childId: string,
		isExternallyRunning: () => boolean = () => false,
	): Promise<"deleted" | "not_found" | "running"> {
		for (const owner of this._rlmSubtreeSessions()) {
			const isRunning = (): boolean => {
				const status = owner._activeRlmChildRuns.get(childId)?.status;
				return status === "queued" || status === "running" || isExternallyRunning();
			};
			if (isRunning()) {
				return "running";
			}
			const subagent = [
				...(await owner.listRlmSubagents()).subagents,
				...owner._rlmChildCleanupFailures.values(),
			].find((entry) => entry.rlm_child_id === childId);
			if (!subagent) continue;
			if (isRunning()) {
				return "running";
			}
			const result = await owner._trackRlmSubagentDeletion(subagent, () => {
				if (isRunning()) {
					return Promise.resolve({ subagent, outcome: "skipped_running" });
				}
				return owner._deleteResolvedRlmSubagent(subagent);
			});
			return result.outcome === "skipped_running" ? "running" : "deleted";
		}
		return "not_found";
	}

	async deleteRlmSubagent(target: string): Promise<RlmDeleteSubagentResult> {
		const inFlight = [...this._deletingRlmChildren.values()].filter(({ subagent }) =>
			this._rlmSubagentMatchesTarget(subagent, target),
		);
		if (inFlight.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}

		// Running and retained children can be reserved synchronously. This keeps
		// them hidden immediately while the async daemon listing checks for a
		// conflicting passive selector.
		const localMatches = [
			...this._buildRlmSubagentList().subagents,
			...this._rlmChildCleanupFailures.values(),
		].filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		const matchingChildIds = new Set([
			...inFlight.map(({ subagent }) => subagent.rlm_child_id),
			...localMatches.map((subagent) => subagent.rlm_child_id),
		]);
		if (matchingChildIds.size > 1 || localMatches.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		if (inFlight[0]) {
			return inFlight[0].promise;
		}
		if (localMatches[0]) {
			const subagent = localMatches[0];
			return this._trackRlmSubagentDeletion(subagent, async () => {
				const listedAgents = await this._agentMessageController?.listAgents();
				const listedSubagents = this._buildRlmSubagentList(listedAgents).subagents;
				const passiveMatches = listedSubagents.filter(
					(entry) => entry.rlm_child_id !== subagent.rlm_child_id && this._rlmSubagentMatchesTarget(entry, target),
				);
				if (passiveMatches.length > 0) {
					throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
				}
				const parentActiveSessionId = listedAgents?.current?.activeSessionId;
				const daemonChild = listedAgents?.agents.find(
					(agent) =>
						agent.rlmChildId === subagent.rlm_child_id && agent.parentActiveSessionId === parentActiveSessionId,
				);
				const resolvedSubagent = daemonChild
					? {
							...subagent,
							active_session_id: daemonChild.activeSessionId,
							session_id: daemonChild.sessionId,
							session_name: daemonChild.sessionName ?? subagent.session_name,
						}
					: subagent;
				return this._deleteResolvedRlmSubagent(resolvedSubagent);
			});
		}

		const directMatches = [
			...(await this.listRlmSubagents()).subagents,
			...this._rlmChildCleanupFailures.values(),
		].filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		const directChildIds = new Set(directMatches.map((subagent) => subagent.rlm_child_id));
		if (directChildIds.size > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		const subagent = directMatches[0] ?? (await this._resolveDirectRlmSubagent(target));
		return this._trackRlmSubagentDeletion(subagent, () => this._deleteResolvedRlmSubagent(subagent));
	}

	private async _trackRlmSubagentDeletion(
		subagent: RlmSubagentRegistryEntry,
		startDeletion: () => Promise<RlmDeleteSubagentResult>,
	): Promise<RlmDeleteSubagentResult> {
		const existing = this._deletingRlmChildren.get(subagent.rlm_child_id);
		if (existing) return existing.promise;
		const deletion = Promise.resolve().then(startDeletion);
		this._deletingRlmChildren.set(subagent.rlm_child_id, {
			subagent,
			promise: deletion,
		});
		try {
			return await deletion;
		} finally {
			const clearReservation = () => {
				if (this._deletingRlmChildren.get(subagent.rlm_child_id)?.promise === deletion) {
					this._deletingRlmChildren.delete(subagent.rlm_child_id);
				}
			};
			const run = this._activeRlmChildRuns.get(subagent.rlm_child_id);
			if (run?.detachedDeletion) {
				// Keep every selector reserved until the run settles, or until a failed
				// cleanup is exposed for an explicit retry. Repeated deletes before that
				// boundary return the same accepted result.
				void run.deletionReservation.promise.then(clearReservation, clearReservation);
			} else {
				clearReservation();
			}
		}
	}

	private _deleteRlmSubagentSession(childId: string, session?: AgentSession): Promise<void> {
		if (this._subagentRuntimeHost) {
			return this._subagentRuntimeHost.deleteRlmSubagentRuntime(childId, session);
		}
		return session?.disposeAsync() ?? Promise.resolve();
	}

	private _ensureRlmRunDeletionCleanup(run: RlmChildRun, session: AgentSession): Promise<void> {
		if (run.deletionCleanup) return run.deletionCleanup;
		const cleanup = Promise.resolve().then(() => this._deleteRlmSubagentSession(run.id, session));
		run.deletionCleanup = cleanup;
		// Deletion admission is intentionally nonblocking. The detached run owner
		// joins this exact promise before settlement and records any failure.
		void cleanup.catch(() => undefined);
		return cleanup;
	}

	private async _recordRlmRunDeletionCleanupFailure(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
		error: unknown,
	): Promise<void> {
		if (this._disposed || this._disposing) {
			run.suppressTerminalNotice = true;
			await session.disposeAsync().catch(() => undefined);
			if (!run.settled) await this._finishRlmRunDeletion(run);
			return;
		}
		run.deletionCleanup = undefined;
		run.deletionCleanupObserver = undefined;
		run.deletionCleanupFailed = true;
		run.session = session;
		this._rlmChildCleanupFailures.set(run.id, subagent);
		// Make retry admission available before waking the parent model with the
		// retry-required notice.
		run.deletionReservation.resolve();
		await Promise.resolve();
		await run.reportDeletionCleanupFailure?.(error);
	}

	private async _finishRlmRunDeletion(run: RlmChildRun): Promise<void> {
		await run.completeDeletion?.();
		if (this._activeRlmChildRuns.get(run.id) === run) {
			this._removeRlmSubagentTracking(run.id, run);
		}
		run.settled = true;
		run.settlement.resolve();
		run.deletionReservation.resolve();
		this._unsettledRlmChildRuns.delete(run);
		this._maybeResumeGoalContinuationAfterRlmWork();
		this._maybeResumeAutonomousContinuationAfterRlmWork();
	}

	private _observeRlmRunDeletionCleanup(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
		cleanup: Promise<void>,
	): Promise<boolean> {
		if (run.deletionCleanupObserver) return run.deletionCleanupObserver;
		const observer = cleanup.then(
			() => true,
			async (error) => {
				await this._recordRlmRunDeletionCleanupFailure(run, subagent, session, error);
				return false;
			},
		);
		run.deletionCleanupObserver = observer;
		void observer.catch(() => undefined);
		return observer;
	}

	private _continueFinishedRlmRunDeletion(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
	): void {
		const cleanup = this._ensureRlmRunDeletionCleanup(run, session);
		const observer = this._observeRlmRunDeletionCleanup(run, subagent, session, cleanup);
		if (!run.deletionRunFinished) return;
		void observer
			.then(async (cleanupSucceeded) => {
				if (cleanupSucceeded) await this._finishRlmRunDeletion(run);
			})
			.catch(() => undefined);
	}

	private _removeRlmSubagentTracking(childId: string, run?: RlmChildRun): void {
		run?.unsubscribe?.();
		this._rlmChildUnsubscribes.get(childId)?.();
		this._rlmChildUnsubscribes.delete(childId);
		this._rlmChildSessions.delete(childId);
		this._rlmChildCleanupFailures.delete(childId);
		this._abandonedRlmQuiescenceChildIds.delete(childId);
		if (!run || this._activeRlmChildRuns.get(childId) === run) {
			this._activeRlmChildRuns.delete(childId);
		}
		if (run) {
			run.abort = noopRlmChildAbort;
			run.unsubscribe = undefined;
			run.session = undefined;
		}
	}

	private _emitRlmSubagentRemoval(subagent: RlmSubagentRegistryEntry): void {
		this._emit({
			type: "rlm_child_update",
			child: {
				id: subagent.rlm_child_id,
				parentId: this._rlmParentNodeId,
				activeSessionId: subagent.active_session_id ?? undefined,
				sessionName: subagent.session_name,
				label: subagent.session_name,
				status: "cancelled",
				sessionDir: subagent.session_dir,
				error: "Deleted by parent orchestrator",
			},
		});
	}

	private async _deleteResolvedRlmSubagent(subagent: RlmSubagentRegistryEntry): Promise<RlmDeleteSubagentResult> {
		const childId = subagent.rlm_child_id;
		const run = this._activeRlmChildRuns.get(childId);
		if (run) {
			if (run.deletionCleanupFailed) {
				// Reset retry coordination only after selector preflight reaches the
				// resolved child. A failed preflight must leave the prior retry boundary
				// intact so a later call can acquire it.
				run.deletionCleanupFailed = false;
				run.deletionFailureNotice = undefined;
				run.deletionReservation = createAgentMessageDeferred();
			}
			// The detached task remains the sole lifecycle owner. Mark deletion before
			// cancellation so its catch/finally path cannot race a normal release or
			// terminal notice against the physical delete.
			run.detachedDeletion = subagent;
			if (this._cancelRlmChildRun(run, "Deleted by parent orchestrator")) {
				run.deletionNeedsCompletionNotice = true;
			} else {
				this._emitRlmSubagentRemoval(subagent);
			}
			const liveSession = run.session;
			if (run.status === "error" && !liveSession && run.settled) {
				this._deletedRlmChildIds.add(childId);
				this._removeRlmSubagentTracking(childId, run);
				return { subagent };
			}
			if (liveSession && run.settled) {
				run.deletionRunFinished = true;
				run.settlement = createAgentMessageDeferred();
				run.settled = false;
				this._unsettledRlmChildRuns.add(run);
			}
			if (liveSession) this._continueFinishedRlmRunDeletion(run, subagent, liveSession);

			// Return once deletion is accepted. The run stays hidden but unsettled until
			// abort-insensitive model/tool work unwinds and the shared cleanup finishes.
			this._deletedRlmChildIds.add(childId);
			return { subagent };
		}

		this._emitRlmSubagentRemoval(subagent);
		const retained = this._rlmChildSessions.get(childId)?.session;
		try {
			await this._deleteRlmSubagentSession(childId, retained);
		} catch (error) {
			if (this._disposed || this._disposing) {
				this._removeRlmSubagentTracking(childId);
				void retained?.disposeAsync().catch(() => undefined);
			} else {
				this._rlmChildCleanupFailures.set(childId, subagent);
			}
			throw error;
		}
		this._deletedRlmChildIds.add(childId);
		this._removeRlmSubagentTracking(childId);
		return { subagent };
	}

	/**
	 * Retain a finished child session for the parent lifetime so inspectors and
	 * daemon-hosted agent messaging can keep addressing it. Returns false (and disposes
	 * the child) when the parent is already tearing down, so the caller can drop the
	 * matching event forwarder too.
	 */
	registerRlmChildSession(childId: string, session: AgentSession, unsubscribe?: () => void): boolean {
		// A child can finish concurrently while the parent is (or has) torn down; don't
		// resurrect the map (it would never be disposed), just drop the child now.
		if (this._deletingRlmChildren.has(childId) || this._deletedRlmChildIds.has(childId)) {
			return false;
		}
		if (this._subagentRuntimeHost?.completeRlmSubagentRuntime?.(childId, session) === false) {
			return false;
		}
		if (this._disposed || this._disposing) {
			void session.disposeAsync().catch(() => undefined);
			return false;
		}
		this._rlmChildSessions.set(childId, { session, run: this._activeRlmChildRuns.get(childId) });
		if (unsubscribe) {
			this._rlmChildUnsubscribes.set(childId, unsubscribe);
		}
		return true;
	}

	releaseRlmChildSession(childId: string, session: AgentSession): (() => void) | false {
		const run = this._activeRlmChildRuns.get(childId);
		if (run?.session === session && run.status === "done") {
			const unsubscribe = run.unsubscribe ?? noopRlmChildEventUnsubscribe;
			return () => {
				run.unsubscribe = undefined;
				this._activeRlmChildRuns.delete(childId);
				unsubscribe();
			};
		}
		if (this._rlmChildSessions.get(childId)?.session !== session) return false;
		const unsubscribe = this._rlmChildUnsubscribes.get(childId) ?? noopRlmChildEventUnsubscribe;
		return () => {
			this._rlmChildUnsubscribes.delete(childId);
			this._rlmChildSessions.delete(childId);
			unsubscribe();
		};
	}

	/**
	 * Record a child's stall-watchdog stage on the parent side.
	 *
	 * Label and facts are deliberately separate (B9/I-13): a child whose silence is
	 * exempted - a host-owned phase today, the kernel-liveness vouch once it lands -
	 * is healthy long work and keeps its real activity label, while the forensic
	 * record still reaches the roster row and the terminal classifier. The
	 * `unsettled` stage is the "killed but never stopped" fact: it revokes
	 * `settled` so a survivor is not reported dead and a non-survivor still is.
	 */
	private _recordRlmChildStallEvent(
		run: RlmChildRun,
		child: AgentSession,
		stage: "warn" | "abort" | "unsettled",
		event: { silentMs: number; thresholdMs: number; diagnostics: StallDiagnostics },
	): void {
		const inFlightTools = event.diagnostics.inFlightToolCalls.map((call) => call.toolName);
		if (stage === "abort") {
			run.stallAbort = {
				silentMs: event.silentMs,
				thresholdMs: event.thresholdMs,
				inFlightTools,
				settled: true,
			};
		} else if (stage === "unsettled") {
			run.stallAbort = {
				silentMs: event.silentMs,
				thresholdMs: event.thresholdMs,
				inFlightTools,
				settled: false,
			};
		}
		// B9/I-13: label and facts stay separate. An excused stall (a host-owned phase, or kernel
		// and host facts vouching that externally owned work is in flight) is healthy long work, so
		// the child keeps its real activity label while the forensic record still reaches the roster
		// row and the terminal classifier. Read from the event's own exemption segment: the watchdog
		// measured it at the moment it fired, and re-deriving it here would race the next sample.
		const exemption = event.diagnostics.exemption;
		const excused = stage !== "unsettled" && exemption?.reason !== undefined && exemption.exhausted !== true;
		run.stall = {
			silentMs: event.silentMs,
			thresholdMs: event.thresholdMs,
			inFlightTools,
			unsettled: stage === "unsettled" || run.stall?.unsettled === true ? true : undefined,
			...(excused ? { excused: true, excusedReasons: [...exemption.reasons] } : {}),
		};
		if (!child.stallExempted && !excused) run.activity = { kind: "stalled" };
		run.emitUpdate?.();
	}

	/**
	 * Facts the terminal classifier reads. Everything here is already recorded by
	 * the time a run settles; collecting it in one place keeps the classification
	 * itself a pure function of these fields.
	 */
	private _collectRlmChildTerminalFacts(
		run: RlmChildRun,
		child: AgentSession | undefined,
		parentReplyCountBeforeRun: number,
	): RlmChildTerminalFacts {
		const lastAssistant = child ? this._findLastAssistantInMessages(child.messages) : undefined;
		return {
			runStatus: run.status,
			lastStopReason: lastAssistant?.stopReason,
			lastErrorMessage: lastAssistant?.errorMessage,
			runError: run.error,
			// The run's own record survives a disposed child session; the child's copy
			// is the fallback for a kill the parent's subscription did not observe.
			stallAbort: run.stallAbort ?? child?._lastStallAbort,
			turnAbortReason: child?._lastTurnAbortReason,
			repliedDuringRun: child ? child._parentReplyCount > parentReplyCountBeforeRun : false,
			terminalErrorNoticeDelivered: child?._terminalErrorNoticeDelivered ?? false,
		};
	}

	/**
	 * Classify a finished run and deliver exactly the notice the classification
	 * asks for.
	 *
	 * Failure kinds (stall_killed/aborted/error) bypass the reply-count gate on
	 * purpose: "it replied" is not evidence it was not killed, and a watchdog kill
	 * the parent never sees is the failure this replaces - it used to arrive as
	 * `completed_without_reply`. `suppressTerminalNotice` and `detachedDeletion`
	 * still gate everything, so a parent that aborted itself is not woken by its
	 * own kill and an explicit delete keeps its own notice path.
	 */
	private async _deliverRlmChildTerminalOutcome(input: {
		run: RlmChildRun;
		child: AgentSession | undefined;
		sessionName: string;
		parentReplyCountBeforeRun: number;
		deliver: (message: CustomMessage) => Promise<void>;
	}): Promise<void> {
		const { run, child, sessionName, parentReplyCountBeforeRun, deliver } = input;
		if (run.detachedDeletion || run.suppressTerminalNotice) return;
		const facts = this._collectRlmChildTerminalFacts(run, child, parentReplyCountBeforeRun);
		const outcome = classifyRlmChildTerminalOutcomeSafely(facts, (detail) => {
			// A silent fallback is how a kill goes back to being reported as a
			// no-reply, so the degradation itself has to be countable.
			sessionLog.warn("rlm child terminal classification degraded", {
				childId: run.id,
				sessionName,
				runStatus: run.status,
				degraded: detail.reason,
				error: detail.error,
			});
		});
		// Recorded for `collectRlmChildren`, which reads the classification instead
		// of re-deriving it: by the time a retained run is collected, the reply
		// baseline this classification used is gone.
		run.terminalKind = outcome.kind;
		run.terminalReason = outcome.reason;
		if (outcome.channel === "none") return;
		if (outcome.kind === "completed_without_reply" && child) {
			// The verdict is right about the moment it was taken and wrong about the
			// moment it is read: this session may already be holding a reply from this
			// child that its queue has not drained yet. Record the debt so the
			// publication gate can drop the notice if the queue settles it first.
			const owedReplyIds = this._queuedChildReplyBackfills.owedMessageIdsForSender(child.sessionId);
			if (owedReplyIds.length > 0) {
				run.provisionalNoReplyReplyIds = owedReplyIds;
				sessionLog.info("no-reply verdict is provisional on a queued reply", {
					sessionId: this.sessionId,
					childId: run.id,
					childSessionId: child.sessionId,
					owedReplyIds,
				});
			}
		}
		if (outcome.channel === "failure") {
			// Only an `error` verdict can be a duplicate of the child's own report: a
			// watchdog kill or an abort is a different fact, and the child's terminal
			// error notice never claims either.
			const selfReportId = outcome.kind === "error" ? child?._queuedTerminalErrorNoticeMessageId : undefined;
			if (selfReportId !== undefined) {
				run.provisionalFailureNoticeReplyId = selfReportId;
				sessionLog.info("failure verdict is provisional on the child's own queued report", {
					sessionId: this.sessionId,
					childId: run.id,
					messageId: selfReportId,
				});
			}
			const stallAbort = run.stallAbort;
			await deliver(
				createRlmChildFailureMessage({
					childId: run.id,
					sessionName,
					error: outcome.reason,
					kind: outcome.kind,
					stall: stallAbort
						? {
								silentMs: stallAbort.silentMs,
								thresholdMs: stallAbort.thresholdMs,
								inFlightTools: stallAbort.inFlightTools,
								unsettled: stallAbort.settled ? undefined : true,
							}
						: undefined,
				}),
			);
			// A delivered failure notice is a delivered terminal report: keep the
			// child's reply accounting in sync so no second notice follows for the
			// same run.
			if (child) child._parentReplyCount += 1;
			return;
		}
		if (outcome.kind === "cancelled") {
			await deliver(
				createRlmChildTerminalNoticeMessage({
					kind: "cancelled",
					childId: run.id,
					sessionName,
					reason: outcome.reason,
				}),
			);
			return;
		}
		const lastAssistantText = child?.getLastAssistantText();
		await deliver(
			createRlmChildTerminalNoticeMessage({
				kind: "completed_without_reply",
				childId: run.id,
				sessionName,
				lastAssistantTextPreview: lastAssistantText ? compactRlmText(lastAssistantText) : undefined,
			}),
		);
	}

	private _rlmChildSnapshotForRun(
		run: RlmChildRun,
		child = run.session ?? this._rlmChildSessions.get(run.id)?.session,
	): RlmChildAgentSnapshot {
		const model = child?.model ?? run.model;
		// The brief is a run-level constant; re-regexing it per streaming chunk
		// was pure per-chunk CPU on a string that never changes.
		run.label ??= rlmChildLabel(run.prompt);
		return {
			id: run.id,
			parentId: this._rlmParentNodeId,
			sessionName: child?.sessionName ?? run.sessionName,
			model: `${model.provider}/${model.id}`,
			label: run.label,
			status: run.status,
			durationMs: run.durationMs,
			answerPreview: run.answerPreview,
			toolUseCount: run.toolUseCount > 0 ? run.toolUseCount : undefined,
			tokenCount: child?._contextTokensForCurrentMessages(),
			recap: child?.getCurrentRecap(),
			sessionDir: run.sessionDir,
			activity: run.activity,
			repliedSinceTask: child?._repliedToParentSinceTask,
			progressNote: run.progressNotes?.at(-1),
			lastActivityAt: run.lastActivityAt,
			activityStaleMs: rlmActivityStaleMs(run.status, run.activity, run.lastActivityAt, run.lastActivityMonotonicAt),
			error: run.error,
			stall: run.stall,
		};
	}

	/**
	 * Streaming preview for a child's in-flight assistant message. The chunk handler
	 * used to re-join and re-regex the whole message text per chunk - O(text so far)
	 * per chunk, O(text^2) over a long answer - while the preview only depends on the
	 * first collapsed characters; the incremental accumulator folds just the new text.
	 */
	private _rlmChildStreamingPreviewText(
		run: RlmChildRun,
		event: Extract<AgentSessionEvent, { type: "message_start" | "message_update" }>,
	): string {
		// The accumulator tracks one assistant message, not the run: a run folds
		// several assistant messages (tool-call rounds, agent_message continuation
		// rounds) and each starts from an empty text. Reading the previous message's
		// folded lengths as the new message's consumed prefix glued the old answer
		// onto a mid-word slice of the new one, or froze the preview at the old cap,
		// for the whole message. message_start is the per-message boundary; reset
		// there so only message_update folds incrementally.
		if (event.type === "message_start") run.streamPreview = undefined;
		run.streamPreview ??= new RlmChildStreamPreview();
		const preview = run.streamPreview;
		return preview.update(event.message as AssistantMessage);
	}

	/** The volatile snapshot fields as they stand right now. */
	private _rlmChildEmitFields(run: RlmChildRun, child: AgentSession | undefined): RlmChildEmitFields {
		return {
			model: child?.model ?? run.model,
			sessionName: child?.sessionName ?? run.sessionName,
			status: run.status,
			durationMs: run.durationMs,
			answerPreview: run.answerPreview,
			toolUseCount: run.toolUseCount > 0 ? run.toolUseCount : undefined,
			tokenCount: child?._contextTokensForCurrentMessages(),
			recap: child?.getCurrentRecap(),
			activityKind: run.activity?.kind,
			activityToolName: run.activity?.toolName,
			repliedSinceTask: child?._repliedToParentSinceTask,
			error: run.error,
			stall: run.stall,
		};
	}

	private _rlmChildSnapshotForSession(childId: string, child: AgentSession): RlmChildAgentSnapshot {
		let answerPreview: string | undefined;
		let toolUseCount = 0;
		const messages =
			child.state.streamingMessage?.role === "assistant"
				? [...child.messages, child.state.streamingMessage]
				: child.messages;
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const text = compactRlmText(readAssistantText(message));
			if (text) answerPreview = text;
			toolUseCount += message.content.filter((block) => block.type === "toolCall").length;
		}
		return {
			id: childId,
			parentId: this._rlmParentNodeId,
			sessionName: child.sessionName,
			model: child.model ? `${child.model.provider}/${child.model.id}` : undefined,
			label: child.sessionName ?? "child agent",
			status: "done",
			answerPreview,
			toolUseCount: toolUseCount > 0 ? toolUseCount : undefined,
			tokenCount: child._contextTokensForCurrentMessages(),
			recap: child.getCurrentRecap(),
			sessionDir: child._rlmSessionDir ?? child.sessionManager.getSessionDir(),
			// No run exists (e.g. a child rehydrated after daemon recovery), so live
			// session state is the only source for in-flight follow-up work. Mirror
			// the run projection's convention: status stays "done" (the recorded task
			// finished) and current work surfaces through activity.
			activity: child.isSessionActive ? { kind: child.isStreaming ? "writing" : "waiting" } : undefined,
			repliedSinceTask: child._repliedToParentSinceTask,
		};
	}

	private _isUnboundTerminalRlmChildRun(run: RlmChildRun): boolean {
		if (run.session !== undefined || this._rlmChildSessions.has(run.id)) return false;
		return run.status === "done" || run.status === "error" || run.status === "cancelled";
	}

	/** Live recursive child roster from lifecycle state, including nested work under retained parents. */
	getRlmChildSnapshots(): RlmChildAgentSnapshot[] {
		const snapshots: RlmChildAgentSnapshot[] = [];
		const recorded = new Set<string>();
		const traversed = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			const hidden =
				run.detachedDeletion ||
				this._deletingRlmChildren.has(run.id) ||
				this._deletedRlmChildIds.has(run.id) ||
				this._isUnboundTerminalRlmChildRun(run);
			const child = run.session;
			if (!hidden) {
				snapshots.push(this._rlmChildSnapshotForRun(run));
				recorded.add(run.id);
			}
			if (child) {
				traversed.add(run.id);
				snapshots.push(...child.getRlmChildSnapshots());
			}
		}
		for (const [childId, { session: child, run }] of this._rlmChildSessions) {
			if (recorded.has(childId) || traversed.has(childId)) continue;
			const hidden = this._deletingRlmChildren.has(childId) || this._deletedRlmChildIds.has(childId);
			if (!hidden) {
				const snapshot = run
					? this._rlmChildSnapshotForRun(run, child)
					: this._rlmChildSnapshotForSession(childId, child);
				snapshots.push({
					...snapshot,
					status: this._rlmChildCleanupFailures.has(childId) ? "cancelled" : snapshot.status,
				});
			}
			snapshots.push(...child.getRlmChildSnapshots());
		}
		return snapshots;
	}

	/** True when any direct or nested subagent is still running or queued. */
	hasRunningRlmChildren(): boolean {
		for (const session of this._rlmSubtreeSessions()) {
			for (const run of session._activeRlmChildRuns.values()) {
				if (run.status === "running" || run.status === "queued") {
					return true;
				}
			}
		}
		return false;
	}

	private _rlmChildSessionSnapshot(): AgentSession[] {
		const sessions = new Set<AgentSession>();
		for (const [childId, { session }] of this._rlmChildSessions) {
			if (!this._abandonedRlmQuiescenceChildIds.has(childId)) sessions.add(session);
		}
		for (const run of this._activeRlmChildRuns.values()) {
			if (run.session && !run.abandonedForQuiescence) sessions.add(run.session);
		}
		return [...sessions];
	}

	private _hasUnsettledRlmQuiescenceWork(): boolean {
		if (this._hasActionableDeferredRlmTerminalNotices()) return true;
		if ([...this._unsettledRlmChildRuns].some((run) => !run.settled)) return true;
		return this._rlmChildSessionSnapshot().some(
			(child) => child.isSessionActive || child._hasUnsettledRlmQuiescenceWork(),
		);
	}

	/**
	 * Wait for every admitted descendant run to publish its terminal parent
	 * message and for the resulting parent turns to drain. Re-snapshotting after
	 * each drain includes descendants spawned while earlier results were consumed.
	 *
	 * FR-4: the wait is bounded by a give-up deadline (5 minutes). A descendant
	 * that never settles used to park this barrier forever - and with it every
	 * headless completion that asked for quiescence. On the deadline the wait
	 * warns and returns `{ settled: false }` instead of hanging: the caller can
	 * proceed with the current state, and the log says descendants may still be
	 * running.
	 */
	async waitForRlmQuiescence(externalSignal?: AbortSignal): Promise<RlmQuiescenceOutcome> {
		const startedAt = Date.now();
		const cancellation = new AbortController();
		const cancelFromParent = () => cancellation.abort();
		if (externalSignal?.aborted) cancellation.abort();
		else externalSignal?.addEventListener("abort", cancelFromParent, { once: true });
		this._rlmQuiescenceWaitAborts.add(cancellation);
		let rejectCancelled = (_error: Error) => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			rejectCancelled = reject;
		});
		const onCancelled = () => rejectCancelled(new Error("RLM quiescence wait cancelled"));
		cancellation.signal.addEventListener("abort", onCancelled, { once: true });
		if (cancellation.signal.aborted) onCancelled();
		const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled]);
		// The give-up timer reuses the cancellation path so the recursive sibling
		// waits unwind exactly like an external abort; the flag separates "gave
		// up on the deadline" from a caller-driven cancellation, which still
		// rejects.
		let gaveUpAt: number | undefined;
		const giveUp = () => {
			gaveUpAt = Date.now();
			cancellation.abort();
		};
		const giveUpTimer = setTimeout(giveUp, RLM_QUIESCENCE_GIVE_UP_MS);
		if (typeof giveUpTimer === "object" && "unref" in giveUpTimer) giveUpTimer.unref();
		try {
			while (true) {
				await wait(this.waitForHeadlessIdle());
				// Strong RLM quiescence also owns session-level work (bash, refine,
				// branch mutation, and manual compaction) that interactive waitForIdle
				// intentionally ignores. Wake on activity changes (upstream #1859), raced
				// with a 1s tick so this loop re-checks a deferred terminal notice whose
				// delivery window closes while idle. The tick only observes: abandonment
				// itself is driven by its own timer (see
				// _armRlmTerminalNoticeAbandonTimer), because both predicates below are
				// pure reads and must not flush or discard anything.
				if (this.isSessionActive || this._hasActionableDeferredRlmTerminalNotices()) {
					// The 1s tick can win this race every iteration while bash/refine keep
					// the session active. Aborting the tick scope on settle removes the
					// losing activity-change waiter and its signal listener instead of
					// leaking one per second into MaxListenersExceededWarning spam.
					const tickAbort = new AbortController();
					let tickTimer: ReturnType<typeof setTimeout> | undefined;
					try {
						await wait(
							Promise.race([
								this._waitForSessionActivityChange(tickAbort.signal),
								new Promise<void>((resolve) => {
									tickTimer = setTimeout(resolve, 1000);
								}),
							]),
						);
					} finally {
						clearTimeout(tickTimer);
						tickAbort.abort();
					}
					continue;
				}
				const unsettledRuns = [...this._unsettledRlmChildRuns].filter((run) => !run.settled);
				const childSessions = this._rlmChildSessionSnapshot();
				if (unsettledRuns.length === 0 && !this._hasUnsettledRlmQuiescenceWork()) return { settled: true };
				await wait(
					Promise.all([
						...unsettledRuns.map((run) => run.settlement.promise),
						...childSessions.map((child) => child.waitForRlmQuiescence(cancellation.signal)),
					]),
				);
				// Always loop through the self-active/deferred checks again. Work may
				// start at the child-settlement boundary.
			}
		} catch (error) {
			// FR-4: the deadline fired and unwound the wait through the cancellation
			// path. Report the give-up instead of surfacing it as an error: the
			// caller asked "is everything settled" and the honest answer is "not
			// yet, and I stopped waiting".
			if (gaveUpAt !== undefined) {
				sessionLog.warn("rlm quiescence wait gave up after its deadline; descendants may still be unsettled", {
					sessionId: this.sessionId,
					waitedMs: gaveUpAt - startedAt,
					unsettledChildren: this._rlmChildSessionSnapshot().length,
				});
				return { settled: false, timedOut: true };
			}
			throw error;
		} finally {
			clearTimeout(giveUpTimer);
			// A local descendant error must cancel sibling recursive waits owned by
			// this barrier before their propagation listeners are removed.
			cancellation.abort();
			externalSignal?.removeEventListener("abort", cancelFromParent);
			cancellation.signal.removeEventListener("abort", onCancelled);
			this._rlmQuiescenceWaitAborts.delete(cancellation);
		}
	}

	// Inline (non-daemon) mode only; daemon clients attach to the child session directly.
	getRlmChildSession(childId: string): AgentSession | undefined {
		for (const session of this._rlmSubtreeSessions()) {
			const direct =
				session._activeRlmChildRuns.get(childId)?.session ?? session._rlmChildSessions.get(childId)?.session;
			if (direct) {
				return direct;
			}
		}
		return undefined;
	}

	/**
	 * Cancel a single RLM child run by id, searching nested child sessions.
	 *
	 * @returns true when a live run was cancelled or its unsettled terminal notice
	 * was suppressed; false when the id is unknown or the run already settled.
	 */
	cancelRlmChildRun(childId: string, reason = "Cancelled by user"): boolean {
		for (const session of this._rlmSubtreeSessions()) {
			const run = session._activeRlmChildRuns.get(childId);
			if (run) {
				if (run.status !== "running" && run.status !== "queued" && !run.settled) {
					if (session._sessionInputPumpSuspended) session._abandonRlmRunForQuiescence(run);
					else run.suppressTerminalNotice = true;
					return true;
				}
				// Running work retained under a settled descendant is reachable through
				// the subtree walk, and abort()/abortForUpdateRestart() cascade over the
				// same walk (see _abortRlmSubtree).
				const cancelled = session._cancelRlmChildRun(run, reason);
				const descendantsCancelled = run.session?.cancelRunningRlmDescendants(reason) ?? false;
				if (cancelled || descendantsCancelled) {
					return true;
				}
			}
			// A fruitless match keeps walking: child ids are only mkdir-unique among
			// siblings, so a colliding live run elsewhere must stay reachable.
			if (session._rlmChildSessions.get(childId)?.session.cancelRunningRlmDescendants(reason)) {
				return true;
			}
		}
		return false;
	}

	// A done child sits in BOTH maps until passivation; the visited set keeps that dual membership from doubling the walk.
	private *_rlmSubtreeSessions(): Generator<AgentSession> {
		const visited = new Set<AgentSession>([this]);
		const stack: AgentSession[] = [this];
		while (stack.length > 0) {
			const session = stack.pop()!;
			yield session;
			for (const run of session._activeRlmChildRuns.values()) {
				if (run.session && !visited.has(run.session)) {
					visited.add(run.session);
					stack.push(run.session);
				}
			}
			for (const { session: retained } of session._rlmChildSessions.values()) {
				if (!visited.has(retained)) {
					visited.add(retained);
					stack.push(retained);
				}
			}
		}
	}

	/** Cancel every running or queued run in this session's subtree. */
	cancelRunningRlmDescendants(reason = "Cancelled by user"): boolean {
		let cancelled = false;
		for (const session of this._rlmSubtreeSessions()) {
			for (const run of session._activeRlmChildRuns.values()) {
				if (session._cancelRlmChildRun(run, reason)) cancelled = true;
			}
		}
		return cancelled;
	}

	private async _assertRlmSubagentSessionNameAvailable(name: string, ignorePendingReservation = false): Promise<void> {
		const depth = this._rlmDepth + 1;
		if (!ignorePendingReservation && this._pendingRlmSubagentSessionNames.has(name)) {
			// Only reachable for a generated name (the explicit-name path checks the reservation
			// first, in _startRlmChildRun, and passes ignorePendingReservation). The caller did not
			// choose this name, so the "your own admission is in flight" copy would be a lie; the
			// plain one is right, and a retry generates a different name anyway.
			throw new Error(formatAgentSessionNameUnavailable(name, depth));
		}
		const localConflict =
			[...this._activeRlmChildRuns.values()].some(
				(run) => run.session?.sessionName === name || (!run.session && run.sessionName === name),
			) ||
			[...this._rlmChildSessions.values()].some(({ session }) => session.sessionName === name) ||
			[...this._rlmChildCleanupFailures.values()].some((entry) => entry.session_name === name);
		if (localConflict) {
			throw new Error(formatAgentSessionNameUnavailable(name, depth));
		}
		const controller = this._agentMessageController;
		if (!controller) return;
		const input = {
			name,
			depth,
			parentSessionId: this.sessionId,
			parentSessionPath: this.sessionFile,
		};
		if (controller.assertSessionNameAvailable) {
			await controller.assertSessionNameAvailable(input);
			return;
		}
		const listed = await controller.listAgents();
		const catalog = listed.agents.map(
			(agent): AgentFamilyCatalogEntry => ({
				id: agent.sessionId,
				...(agent.sessionName ? { name: agent.sessionName } : {}),
				depth: agent.rlmDepth ?? 0,
				status: agent.status ?? "idle",
				...(agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
				...(agent.parentSessionPath ? { parentSessionPath: agent.parentSessionPath } : {}),
				...(agent.sessionPath ? { sessionPath: agent.sessionPath } : {}),
			}),
		);
		assertAgentSessionNameAvailable(catalog, input);
	}

	private async _authenticatedRlmModels(): Promise<Model<Api>[]> {
		return (await this._modelRegistry.getExecutableModels()).filter((model) => {
			const status = this._modelRegistry.getProviderAuthStatus(model.provider);
			return status.source !== "stale" && status.label !== "expired";
		});
	}

	async findRlmModels(query: string, limit: number): Promise<RlmFindModelsResult> {
		return {
			models: findRlmModelMatches(query, await this._authenticatedRlmModels(), limit),
		};
	}

	private async _resolveRlmSubagentModel(
		reference: string | undefined,
		target = "subagent",
	): Promise<RlmSubagentModelSelection> {
		const parentModel = this.model;
		if (!parentModel) {
			throw new Error(formatNoModelSelectedMessage());
		}
		if (!reference) {
			return { model: parentModel };
		}

		const normalizedReference = reference.toLowerCase();
		if (`${parentModel.provider}/${parentModel.id}`.toLowerCase() === normalizedReference) {
			// The parent model is in active use, so a catalog miss must not
			// exclude it (e.g. an offline discovery refresh), but a stale or
			// expired provider has to fail the spawn here instead of starting
			// a child that fails its first model request.
			const status = this._modelRegistry.getProviderAuthStatus(parentModel.provider);
			if (status.source === "stale" || status.label === "expired") {
				throw new Error(`Requested ${target} model "${reference}" is unavailable, unauthenticated, or expired`);
			}
			const auth = await this._modelRegistry.getApiKeyAndHeaders(parentModel);
			if (!auth.ok) {
				throw new Error(`Requested ${target} model "${reference}" failed authentication preflight`);
			}
			return { model: parentModel };
		}
		const candidates = await this._authenticatedRlmModels();
		// The parent model can be missing from the authenticated catalog (offline
		// discovery or expired credentials) while staying selectable, so it backs
		// the short-form lookup when the catalog has no match. Several catalog
		// matches still leave the reference unresolved.
		const model =
			candidates.find(
				(candidate) => `${candidate.provider}/${candidate.id}`.toLowerCase() === normalizedReference,
			) ?? findUniqueRlmShortFormModelMatch(reference, candidates, parentModel);
		if (!model) {
			throw new Error(formatRlmModelUnavailableError(reference, target, candidates));
		}

		const auth = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(`Requested ${target} model "${reference}" failed authentication preflight`);
		}
		return { model };
	}

	private async _startRlmChildRun(
		prompt: string,
		kwargs: Record<string, unknown> = {},
		spawnCode?: string,
		signal?: AbortSignal,
	): Promise<RlmSpawnHandle> {
		signal?.throwIfAborted();
		// Snapshot before any await: the spawning request is the turn whose tool call is
		// executing now. A spawn arriving outside an active run (a detached kernel task
		// firing while the parent is idle) has no such turn; an absent edge beats a wrong one.
		const spawnedByRequestId = this.isStreaming ? this._semanticEdges.lastTurnRequestId : undefined;
		const { name: rawName, model: rawModel, thinking: rawThinking, ...unsupported } = kwargs;
		const unsupportedKwargs = Object.keys(unsupported);
		if (unsupportedKwargs.length > 0) {
			throw new Error(`Unsupported rlm.run kwargs: ${unsupportedKwargs.sort().join(", ")}`);
		}
		const requestedSessionName = normalizeRequestedRlmSubagentSessionName(rawName);
		const requestedModel = normalizeRequestedRlmSubagentModel(rawModel);
		const requestedThinkingLevel = normalizeRequestedRlmSubagentThinkingLevel(rawThinking);
		if (requestedSessionName) assertDirectAgentMessageTarget(requestedSessionName);
		// The gate reads the *effective* cap, not the value this session resolved for itself:
		// an ancestor that lowered its max depth after this session was admitted pushes a
		// ceiling, and a spawn under that ceiling must be refused now (SC-2).
		const grantedMaxDepth = this._effectiveRlmMaxDepth();
		if (this._rlmDepth >= grantedMaxDepth) {
			const ceilingNote =
				grantedMaxDepth < this._rlmMaxDepth
					? `; an ancestor session lowered this subtree's cap to ${grantedMaxDepth} after this session was admitted`
					: "";
			throw new Error(
				`RLM recursion depth limit reached (RLM_DEPTH=${this._rlmDepth}, RLM_MAX_DEPTH=${this._rlmMaxDepth}${ceilingNote})`,
			);
		}
		// Depth bounds how deep the tree goes, never how wide one session fans out: without
		// this gate a single turn could admit children without limit into an unbounded map.
		// Refusing loudly (instead of queueing) keeps the fleet observable: a queued spawn
		// looks identical to a running one from the parent's side.
		if (this._rlmMaxConcurrentChildren > 0) {
			const liveChildren = this._liveRlmChildRunCount();
			if (liveChildren >= this._rlmMaxConcurrentChildren) {
				throw new Error(
					`RLM subagent limit reached: this session already has ${liveChildren} live children and the concurrency cap is ${this._rlmMaxConcurrentChildren}. ` +
						"Fan-out is refused rather than queued, so the family stays observable: wait for one to settle with `await rlm.collect()`, " +
						'stop one with `await rlm.delete_subagent("<name-or-id>")`, or raise the cap with RLM_MAX_CHILDREN (or the rlmMaxChildren session config); 0 disables the cap.',
				);
			}
		}
		if (requestedSessionName) {
			if (this._pendingRlmSubagentSessionNames.has(requestedSessionName)) {
				throw new Error(formatAgentSessionNameReserved(requestedSessionName, this._rlmDepth + 1));
			}
			this._pendingRlmSubagentSessionNames.add(requestedSessionName);
		}
		let modelSelection: RlmSubagentModelSelection;
		try {
			if (requestedSessionName) await this._assertRlmSubagentSessionNameAvailable(requestedSessionName, true);
			// An unpinned spawn model resolves against the persisted subagent
			// default; an unavailable default fails the spawn instead of silently
			// inheriting the parent model.
			modelSelection = await this._resolveRlmSubagentModel(
				requestedModel ?? this.settingsManager.getSubagentDefaultModel(),
			);
		} finally {
			if (requestedSessionName) this._pendingRlmSubagentSessionNames.delete(requestedSessionName);
		}
		signal?.throwIfAborted();
		if (requestedThinkingLevel !== undefined) {
			const supported = getSupportedThinkingLevels(modelSelection.model) as ThinkingLevel[];
			if (!supported.includes(requestedThinkingLevel)) {
				throw new Error(
					`Requested thinking level "${requestedThinkingLevel}" is not supported by model "${modelSelection.model.provider}/${modelSelection.model.id}"; supported levels: ${supported.join(", ")}`,
				);
			}
		}
		if (this._disposed || this._disposing) throw new Error("Cannot spawn a subagent after its parent was disposed");

		const { childSessionDir, childNodeId, sessionName } = await this._admitChildRlmSessionDir(
			requestedSessionName,
			prompt,
			signal,
		);
		const startedAt = Date.now();
		const parentAssistantForUsage = this._findLastAssistantMessage();
		let runningToolCount = 0;
		let childSession: AgentSession | undefined;
		const startedMonotonicAt = performance.now();
		const run: RlmChildRun = {
			id: childNodeId,
			prompt,
			sessionName,
			sessionDir: childSessionDir,
			model: modelSelection.model,
			status: "queued",
			toolUseCount: 0,
			progressNotes: [],
			// Seed the staleness clock at admission: a child hung before its
			// first tracked event still crosses the threshold once running.
			lastActivityAt: startedAt,
			lastActivityMonotonicAt: startedMonotonicAt,
			settled: false,
			abort: noopRlmChildAbort,
			publication: createAgentMessageDeferred(),
			settlement: createAgentMessageDeferred(),
			deletionReservation: createAgentMessageDeferred(),
		};
		const throwIfCancelled = () => {
			if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
		};
		this._activeRlmChildRuns.set(run.id, run);
		this._unsettledRlmChildRuns.add(run);
		// The kernel host aborts its in-flight requests on teardown; cancel the
		// admitted run with it so a disposed host never leaves a live child behind.
		const abortFromHost = () => {
			const reason = signal?.reason;
			this._cancelRlmChildRun(run, reason instanceof Error ? reason.message : "IPython kernel host request aborted");
		};
		if (signal?.aborted) {
			abortFromHost();
		} else {
			signal?.addEventListener("abort", abortFromHost, { once: true });
		}
		const emitChildUpdate = () => {
			// Streaming chunks mostly change nothing the wire can see: the preview is
			// capped after the first ~160 characters and the label is a run-level
			// constant. Comparing the volatile fields first keeps the per-chunk cost
			// off the snapshot build and the JSON.stringify of the full brief.
			const child = run.session ?? this._rlmChildSessions.get(run.id)?.session;
			const fields = this._rlmChildEmitFields(run, child);
			if (rlmChildEmitFieldsEqual(fields, run.lastEmittedFields)) return;
			const snapshot = this._rlmChildSnapshotForRun(run, child);
			const serialized = JSON.stringify(snapshot);
			run.lastEmittedFields = fields;
			if (serialized === run.lastEmittedUpdate) return;
			run.lastEmittedUpdate = serialized;
			this._emit({ type: "rlm_child_update", child: snapshot });
		};
		run.emitUpdate = emitChildUpdate;
		emitChildUpdate();

		const publishChildSession = (child: AgentSession) => {
			childSession = child;
			// The child was granted the cap in force at admission. If an ancestor tightened it
			// while this run was still starting up, the child must not keep the wider grant
			// (SC-2); an unchanged cap pushes nothing, so a child that later raises its own
			// cap is still only limited by whatever its parent actually imposes.
			const currentCap = this._effectiveRlmMaxDepth();
			if (currentCap < grantedMaxDepth) child._applyRlmMaxDepthCeiling(currentCap);
			const tracked = this._activeRlmChildRuns.get(run.id) === run;
			// Cancellation admitted while runtime construction was blocked must stop
			// the child even when the run already left _activeRlmChildRuns (a cascade
			// that settled it, or an abort race): map membership is not evidence that
			// anything ever reached this child. The wiring below stays behind the
			// tracked guard, so a late publication cannot revive a settled run's
			// accounting (session/abort/unsubscribe) and hide a live child session
			// from its parent.
			if (run.status === "cancelled") this._abortRlmChildSessionOnPublish(run, child);
			if (!tracked) return;
			run.session = child;
			run.abort = () => void child.abort();
			run.publication.resolve();
		};
		const subagentOptions: CreateRlmSubagentRuntimeOptions = {
			...this._createRlmSubagentRuntimeOptions({
				id: childNodeId,
				prompt,
				sessionName,
				spawnCode,
				sessionDir: childSessionDir,
				model: modelSelection.model,
				thinkingLevel: requestedThinkingLevel,
				spawnedByRequestId,
			}),
			onSessionPublished: publishChildSession,
		};

		const deliverTerminalMessageToParent = async (message: CustomMessage): Promise<void> => {
			// Synthesized lifecycle notices always use the parent's private durable
			// path. Explicit child replies continue through agent_message separately.
			await this._deferRlmTerminalNotice(message);
		};

		run.completeDeletion = () => {
			if (!run.deletionNeedsCompletionNotice || run.suppressTerminalNotice || this._disposed || this._disposing) {
				return Promise.resolve();
			}
			if (run.deletionNotice) return run.deletionNotice;
			const notice = deliverTerminalMessageToParent(
				createRlmChildTerminalNoticeMessage({
					kind: "cancelled",
					childId: run.id,
					sessionName,
					reason: run.error ?? "Deleted by parent orchestrator",
				}),
			);
			run.deletionNotice = notice;
			return notice;
		};

		run.reportDeletionCleanupFailure = (error) => {
			if (run.suppressTerminalNotice || this._disposed || this._disposing) return Promise.resolve();
			if (run.deletionFailureNotice) return run.deletionFailureNotice;
			const cleanupError = error instanceof Error ? error.message : String(error);
			const notice = deliverTerminalMessageToParent(
				createRlmChildFailureMessage({
					childId: run.id,
					sessionName,
					error: `Deletion cleanup failed; retry rlm.delete_subagent("${run.id}") before completion: ${cleanupError}`,
				}),
			);
			run.deletionFailureNotice = notice;
			return notice;
		};

		// Runtime startup and the task run are deliberately detached. The public
		// spawn resolves at admission, while this task owns live tracking, usage,
		// retention, cancellation, and late-startup cleanup.
		void (async () => {
			let childRuntime: RlmSubagentRuntime | undefined;
			// Hoisted out of the try: the terminal classification runs in both the
			// success and the failure branch and needs the reply baseline either way.
			let parentReplyCountBeforeRun = 0;
			try {
				childRuntime = await this._createRlmSubagentRuntime(subagentOptions);
				const child = childRuntime.session;
				if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
				if (child.sessionName !== sessionName) child.setSessionName(sessionName);
				publishChildSession(child);
				throwIfCancelled();
				run.status = "running";
				emitChildUpdate();
				const unsubscribeChildEvents = child.subscribe((event) => {
					if (event.type === "rlm_child_update") {
						this._emit(event);
						return;
					}
					if (event.type === "stall_warning") {
						this._recordRlmChildStallEvent(run, child, "warn", event);
						this._notifyRlmChildStall(run, child, sessionName, event);
						return;
					}
					if (event.type === "stall_abort") {
						this._recordRlmChildStallEvent(run, child, "abort", event);
						return;
					}
					if (event.type === "stall_unsettled") {
						// P1-6: "the abort fired but the run never settled" must leave a
						// mark on the parent side, or the kill is invisible and the
						// terminal classifier has nothing to rank above "no reply".
						run.error ??= "stall watchdog aborted the turn but it did not settle";
						this._recordRlmChildStallEvent(run, child, "unsettled", event);
						return;
					}
					if (event.type === "agent_start") {
						run.activity = { kind: "waiting" };
						// A recovered child is no longer stalled; the forensic record stays
						// so the terminal classification can still see an unsettled abort.
						run.stall = undefined;
						touchRlmChildActivity(run);
						emitChildUpdate();
					} else if (event.type === "agent_end") {
						run.activity = undefined;
						touchRlmChildActivity(run);
						emitChildUpdate();
					} else if (event.type === "rlm_progress_note") {
						// Guarded init instead of `??=` inside the call expression:
						// biome's noAssignInExpressions rejects an assignment used as
						// an expression, and a hand-built run record has no ring yet.
						if (!run.progressNotes) run.progressNotes = [];
						run.progressNotes.push(event.message);
						if (run.progressNotes.length > RLM_CHILD_PROGRESS_NOTE_RING_MAX) {
							run.progressNotes.shift();
						}
						touchRlmChildActivity(run);
						emitChildUpdate();
					} else if (event.type === "message_end" && event.message.role === "assistant") {
						const assistant = event.message as AssistantMessage;
						if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
							attributeChildUsage(parentAssistantForUsage?.usage ?? emptyUsage(), assistant.usage);
							if (parentAssistantForUsage) {
								// Resolved once per run: the parent message is a run-level constant, while
								// the lookup copies and scans every entry the session has ever written.
								// A long child run used to pay that scan for every assistant message it
								// emitted (a session with 56k attributed messages spent minutes here).
								run.parentUsageEntry ??= this._findAssistantEntryForMessage(parentAssistantForUsage);
								const parentEntry = run.parentUsageEntry;
								if (parentEntry) {
									const messages = child.messages;
									const assistantIndex = messages.lastIndexOf(assistant);
									const precedingPrompt = messages
										.slice(0, assistantIndex)
										.reverse()
										.find((message) => message.role === "user" || message.role === "custom");
									const origin =
										precedingPrompt?.role === "custom" && isAgentSessionMessage(precedingPrompt)
											? precedingPrompt.details.id.startsWith("spawn:")
												? "spawn_task"
												: "agent_message"
											: "direct_user";
									this.sessionManager.appendChildUsageAttribution(
										parentEntry.id,
										assistant.usage,
										parentAssistantForUsage.usage,
										origin,
									);
								}
							}
						}
						const text = compactRlmText(readAssistantText(assistant));
						if (text) run.answerPreview = text;
						touchRlmChildActivity(run);
						emitChildUpdate();
					} else if (event.type === "message_start" || event.type === "message_update") {
						if (event.message.role === "assistant") {
							const text = this._rlmChildStreamingPreviewText(run, event);
							if (text) run.answerPreview = text;
							run.activity = { kind: "writing" };
							touchRlmChildActivity(run);
							emitChildUpdate();
						}
					} else if (event.type === "tool_execution_start") {
						run.toolUseCount += 1;
						runningToolCount += 1;
						run.activity = { kind: "executing", toolName: event.toolName };
						touchRlmChildActivity(run);
						emitChildUpdate();
					} else if (event.type === "tool_execution_end") {
						runningToolCount = Math.max(0, runningToolCount - 1);
						if (runningToolCount === 0) run.activity = { kind: "waiting" };
						touchRlmChildActivity(run);
						emitChildUpdate();
					} else if (event.type === "session_info_changed" || event.type === "recap_update") {
						emitChildUpdate();
					}
				});
				run.unsubscribe = unsubscribeChildEvents;
				const content = `[task from parent]\n\n${prompt}`;
				const spawnMessage: AgentSessionMessage = {
					role: "custom",
					customType: AGENT_MESSAGE_CUSTOM_TYPE,
					content,
					display: true,
					details: {
						id: `spawn:${run.id}`,
						message: prompt,
						from: {
							sessionId: this.sessionId,
							sessionName: this.sessionName,
							activeSessionId: await this._currentActiveSessionId(),
						},
						fromRelationship: "parent",
					},
					timestamp: Date.now(),
				};
				throwIfCancelled();
				parentReplyCountBeforeRun = child._parentReplyCount;
				// The baseline and the credits owed have to describe the same run: a
				// reply this child left in my queue during an earlier run belongs to
				// that run's verdict (already delivered), so it must not credit this one.
				const staleReplyCredits = this._queuedChildReplyBackfills.discardForSender(child.sessionId);
				if (staleReplyCredits > 0) {
					sessionLog.info("dropped queued reply credits left over from an earlier run", {
						sessionId: this.sessionId,
						childId: run.id,
						childSessionId: child.sessionId,
						dropped: staleReplyCredits,
					});
				}
				await child.promptAndWait(content, {
					expandPromptTemplates: false,
					source: "extension",
					customMessage: spawnMessage,
				});
				await child.waitForRlmQuiescence();
				if (run.error) throw new Error(run.error);
				run.status = "done";
				// Only successful completions return; the edge lands on the parent's next commit.
				const childLastCommitted = child.semanticEdges.lastCommittedRequestId;
				if (childLastCommitted !== undefined) {
					this._semanticEdges.recordChildReturned(child.sessionId, childLastCommitted);
				}
				run.durationMs = Date.now() - startedAt;
				run.activity = undefined;
				emitChildUpdate();
				// A turn that ends with a graceful error message resolves promptAndWait,
				// and so does a turn the stall watchdog aborted: both must be classified
				// here or the parent never learns the task failed.
				await this._deliverRlmChildTerminalOutcome({
					run,
					child,
					sessionName,
					parentReplyCountBeforeRun,
					deliver: deliverTerminalMessageToParent,
				});
				if (!this.registerRlmChildSession(run.id, child) && !run.detachedDeletion) {
					if (childRuntime && this._subagentRuntimeHost?.releaseRlmSubagentRuntime) {
						await this._subagentRuntimeHost
							.releaseRlmSubagentRuntime(childRuntime, subagentOptions, "error")
							.catch(() => void child.disposeAsync().catch(() => undefined));
					} else {
						await child.disposeAsync().catch(() => undefined);
					}
				}
			} catch (error) {
				const runError = error instanceof Error ? error : new Error(String(error));
				run.publication.reject(runError);
				if (run.status !== "cancelled") {
					run.status = "error";
					run.error = runError.message;
				}
				// A failed child still returns an error outcome the parent consumes;
				// cancelled runs and zero-commit children return nothing.
				const failedChild = childSession ?? childRuntime?.session;
				const failedLastCommitted = failedChild?.semanticEdges.lastCommittedRequestId;
				if (run.status === "error" && failedChild && failedLastCommitted !== undefined) {
					this._semanticEdges.recordChildReturned(failedChild.sessionId, failedLastCommitted);
				}
				run.durationMs = Date.now() - startedAt;
				run.activity = undefined;
				if (run.status === "error" && childSession === undefined) {
					// A pre-bind failure leaves no row: "cancelled" is the wire's removal signal.
					this._emit({
						type: "rlm_child_update",
						child: { ...this._rlmChildSnapshotForRun(run), status: "cancelled" },
					});
				} else {
					emitChildUpdate();
				}
				await this._deliverRlmChildTerminalOutcome({
					run,
					child: childSession ?? childRuntime?.session,
					sessionName,
					parentReplyCountBeforeRun,
					deliver: deliverTerminalMessageToParent,
				});
				if (!run.detachedDeletion && childSession && this._subagentRuntimeHost?.releaseRlmSubagentRuntime) {
					try {
						await this._subagentRuntimeHost.releaseRlmSubagentRuntime(
							childRuntime ?? { session: childSession },
							subagentOptions,
							run.status === "cancelled" ? "cancelled" : "error",
						);
						if (run.status === "cancelled" && !this._disposed && !this._disposing) {
							this._deletedRlmChildIds.add(run.id);
							this._removeRlmSubagentTracking(run.id);
						}
					} catch {
						await childSession?.disposeAsync().catch(() => undefined);
					}
				} else if (!run.detachedDeletion) {
					try {
						if (childRuntime && this._subagentRuntimeHost) {
							await this._subagentRuntimeHost.deleteRlmSubagentRuntime(run.id, childRuntime.session);
						} else if (childSession) {
							await childSession.disposeAsync();
						}
						if (run.status === "cancelled" && !this._disposed && !this._disposing) {
							this._deletedRlmChildIds.add(run.id);
							this._removeRlmSubagentTracking(run.id);
						}
					} catch {
						// A failed best-effort retry remains available through the retained cleanup maps.
					}
				}
			} finally {
				signal?.removeEventListener("abort", abortFromHost);
				try {
					// LAT-3: settle the coalesced child usage ledger so the file
					// matches what a reload folds once the run is over, instead of
					// holding deltas back for the next window flush.
					this.sessionManager.flushChildUsageAttributions();
				} catch {
					// Best-effort: the deltas stay in memory and the next persist
					// rewrites the whole transcript, backfilling them.
				}
				if (run.detachedDeletion) {
					run.deletionRunFinished = true;
					if (!run.settled) {
						let cleanupSucceeded = !run.deletionCleanupFailed;
						if (childRuntime && cleanupSucceeded) {
							const cleanup =
								run.deletionCleanup ?? this._ensureRlmRunDeletionCleanup(run, childRuntime.session);
							cleanupSucceeded = await this._observeRlmRunDeletionCleanup(
								run,
								run.detachedDeletion,
								childRuntime.session,
								cleanup,
							);
						}
						if (cleanupSucceeded) await this._finishRlmRunDeletion(run);
					}
				} else {
					if (this._activeRlmChildRuns.get(run.id) === run) {
						if (this._rlmChildSessions.has(run.id)) {
							this._activeRlmChildRuns.delete(run.id);
							if (run.unsubscribe) this._rlmChildUnsubscribes.set(run.id, run.unsubscribe);
							run.abort = noopRlmChildAbort;
							run.unsubscribe = undefined;
							run.session = undefined;
						} else if (run.status !== "error") {
							this._removeRlmSubagentTracking(run.id, run);
						} else {
							run.unsubscribe?.();
							run.abort = noopRlmChildAbort;
							run.unsubscribe = undefined;
						}
					}
					run.settled = true;
					run.settlement.resolve();
					this._unsettledRlmChildRuns.delete(run);
					this._maybeResumeGoalContinuationAfterRlmWork();
					this._maybeResumeAutonomousContinuationAfterRlmWork();
				}
			}
		})().catch(() => undefined);

		return {
			rlm_child_id: childNodeId,
			name: sessionName,
			session_dir: childSessionDir,
			model: `${modelSelection.model.provider}/${modelSelection.model.id}`,
		};
	}

	async createRlmSession(prompt: string, kwargs: Record<string, unknown> = {}): Promise<RlmCreateSessionResult> {
		const { name: rawName, model: rawModel, thinking: rawThinking, cwd: rawCwd, ...unsupported } = kwargs;
		const unsupportedKeys = Object.keys(unsupported);
		if (unsupportedKeys.length > 0) {
			throw new Error(`Unsupported rlm.create_session kwargs: ${unsupportedKeys.sort().join(", ")}`);
		}
		if (!prompt.trim()) {
			throw new Error("rlm.create_session prompt must not be empty");
		}
		if (this._rlmDepth !== 0) {
			throw new Error("rlm.create_session is available only from a depth-0 session");
		}
		if (this._disposed || this._disposing) {
			throw new Error("Cannot create a top-level session after the current session was disposed");
		}
		const host = this._subagentRuntimeHost;
		if (!host?.createRlmRootSession) {
			throw new Error("rlm.create_session requires a daemon-backed depth-0 session");
		}

		const operation = "rlm.create_session";
		const sessionName = normalizeRequestedRlmSubagentSessionName(rawName, operation);
		const requestedModel = normalizeRequestedRlmSubagentModel(rawModel, operation);
		const requestedThinkingLevel = normalizeRequestedRlmSubagentThinkingLevel(rawThinking, operation);
		if (sessionName) {
			assertDirectAgentMessageTarget(sessionName);
			const controller = this._agentMessageController;
			if (controller?.assertSessionNameAvailable) {
				await controller.assertSessionNameAvailable({ name: sessionName, depth: 0 });
			}
		}
		if (rawCwd !== undefined && (typeof rawCwd !== "string" || !rawCwd.trim())) {
			throw new Error("rlm.create_session cwd must be a non-empty string");
		}
		const cwd = rawCwd === undefined ? this._cwd : resolve(this._cwd, rawCwd.trim());
		const modelSelection = await this._resolveRlmSubagentModel(requestedModel, "top-level session");
		if (requestedThinkingLevel !== undefined) {
			const supported = getSupportedThinkingLevels(modelSelection.model) as ThinkingLevel[];
			if (!supported.includes(requestedThinkingLevel)) {
				throw new Error(
					`Requested thinking level "${requestedThinkingLevel}" is not supported by model "${modelSelection.model.provider}/${modelSelection.model.id}"; supported levels: ${supported.join(", ")}`,
				);
			}
		}
		const thinkingLevel =
			requestedThinkingLevel ?? (clampThinkingLevel(modelSelection.model, this.thinkingLevel) as ThinkingLevel);
		if (this._disposed || this._disposing) {
			throw new Error("Cannot create a top-level session after the current session was disposed");
		}
		return host.createRlmRootSession({
			prompt,
			sessionName,
			cwd,
			model: modelSelection.model,
			thinkingLevel,
		});
	}

	async runRlmChild(
		prompt: string,
		kwargs: Record<string, unknown> = {},
		spawnCode?: string,
		signal?: AbortSignal,
	): Promise<RlmSpawnHandle> {
		return this._startRlmChildRun(prompt, kwargs, spawnCode, signal);
	}

	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		// The agent loop already retried this in-place; a session-level retry would
		// resend the whole context on every attempt without ever reaching compaction.
		if (isEmptyTurnRetryExhausted(message)) return false;

		// The provider answered and told us how long to wait; the stall that followed is
		// throttling, not a dead connection. Resending the full context a couple of
		// seconds later is exactly what the rate limit forbids, so this shape is out of
		// the automatic-resend class and surfaces with the provider's own delay instead.
		if (isServerDirectedRetryStall(message)) return false;

		if (this._isFauxProviderQueueExhausted(message)) {
			return false;
		}

		if (this._isAgentLifecycleFailure(message)) {
			return false;
		}

		// The provider answered that the request itself is unacceptable (refusal, invalid
		// request, auth). Resending the same bytes asks the same question and bills a
		// second full-context request for the same answer: a retry only helps when it
		// sends something different. `_retryAttempt` gates below must not be able to
		// resurrect this class - the failing shape this guards was a "permanent" failure
		// that was retried once anyway because the check asked "did we already retry?".
		if (this._isStructuredPermanentProviderFailure(message)) {
			return false;
		}

		return true;
	}

	/**
	 * Cross-layer request budget for the current request chain: the counter the agent loop's
	 * in-place resends and this session's turn retries both spend from. The ceiling is the
	 * module's attempt count times the requests one of its attempts can spend: the session's
	 * provider layer makes a single attempt (see providerRetryStreamOptions), and the only
	 * layer that still turns one attempt into several requests is the loop's empty-turn
	 * resend.
	 *
	 * The ceiling used to be the product of *retry counts* from two layers, one of which no
	 * longer retries - a number that bounded a multiplication that cannot happen any more.
	 */
	private _crossLayerRequestBudget(): ProviderRequestBudget {
		const policy = providerRetryPolicy(this.settingsManager);
		const sessionAttempts = (policy.enabled ? policy.maxRetries : 0) + 1;
		const emptyTurnAttempts =
			this.settingsManager.getEmptyTurnRetrySettings().maxAttempts ?? EMPTY_TURN_RETRY_DEFAULTS.maxAttempts;
		return getProviderRequestBudget(this.sessionId, sessionAttempts * Math.max(1, emptyTurnAttempts));
	}

	private _isFauxProviderQueueExhausted(message: AssistantMessage): boolean {
		return isFauxProviderQueueExhausted(message);
	}

	private _isAgentLifecycleFailure(message: AssistantMessage): boolean {
		return isAgentLifecycleFailure(message);
	}

	/**
	 * A provider that puts one tool call id on two calls in the same assistant
	 * message makes call/result pairing undecidable downstream (two results sharing
	 * an id, UI rows keyed by id, the next request body). The agent loop renames the
	 * later calls before anything consumes them; a repaired id must not be silent,
	 * so the transcript keeps the loop's diagnostic and the session log gets a line.
	 */
	private _reportToolCallIdCollisions(message: AssistantMessage): void {
		const diagnostic = message.diagnostics?.find(
			(candidate) => candidate.type === TOOL_CALL_ID_COLLISION_DIAGNOSTIC_TYPE,
		);
		if (!diagnostic) {
			return;
		}
		const collisions = readToolCallIdCollisions(diagnostic.details);
		sessionLog.warn("provider reused a tool call id; renamed the repeated calls", {
			sessionId: this.sessionManager.getSessionId(),
			summary: formatToolCallIdCollisions(collisions),
			collisions,
		});
	}

	private _getProviderStreamFailureKind(message: AssistantMessage): string | undefined {
		return providerStreamFailureKind(message);
	}

	/**
	 * Permanent-failure shape for the auto-resend gate. Deliberately NOT
	 * `isPermanentProviderFailureKind`: that one gates auth on a retry having
	 * happened, and the class this guards is exactly the "permanent" failure that
	 * got retried once anyway because the check asked "did we already retry?".
	 * Restored by the merge: upstream #2045 deleted the method together with its
	 * only base call site, while this fork added a second call site (the resend
	 * gate below), which the auto-merge kept - leaving the call dangling.
	 */
	private _isStructuredPermanentProviderFailure(message: AssistantMessage): boolean {
		const kind = this._getProviderStreamFailureKind(message);
		return kind === "auth" || kind === "invalid_request" || kind === "refusal";
	}

	private _isStructuredPermanentProviderRetryExhausted(message: AssistantMessage): boolean {
		return isPermanentProviderFailureKind(
			this._getProviderStreamFailureKind(message),
			this._retryAttempt,
			providerStreamFailureStatus(message),
		);
	}

	private _getProviderStreamFailureAuthStatus(message: AssistantMessage): number | undefined {
		return providerStreamFailureStatus(message);
	}

	private _isConcreteProviderAuthFailure(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		const structuredStatus = this._getProviderStreamFailureAuthStatus(message);
		if (structuredStatus === 401 || structuredStatus === 403) {
			return true;
		}

		if (/\b(?:401|403)\b/.test(message.errorMessage) && /\bstatus code\b/i.test(message.errorMessage)) {
			return true;
		}

		return (
			/\b(?:401|403)\b/.test(message.errorMessage) &&
			/auth|unauthori[sz]ed|forbidden|api.?key|token|credential/i.test(message.errorMessage)
		);
	}

	private _captureRetryAuthFailureSource(message: AssistantMessage): AuthSourceToken | undefined {
		const token = this._modelRegistry.getCurrentProviderAuthSourceToken(message.provider);
		if (!token) {
			return undefined;
		}
		if (
			!this._retryAuthFailureSources.some(
				(existing) =>
					existing.provider === token.provider &&
					existing.source === token.source &&
					existing.identityFingerprint === token.identityFingerprint &&
					existing.valueFingerprint === token.valueFingerprint,
			)
		) {
			this._retryAuthFailureSources.push(token);
		}
		return token;
	}

	private _markProviderAuthStale(message: AssistantMessage, authSourceTokens?: readonly AuthSourceToken[]): boolean {
		if (authSourceTokens && authSourceTokens.length > 0) {
			let marked = false;
			for (const token of authSourceTokens) {
				marked = this._modelRegistry.markProviderAuthSourceStale(token) || marked;
			}
			if (marked) {
				this._emit({
					type: "auth_stale",
					provider: message.provider,
					sourceTokens: authSourceTokens,
				});
			}
			return marked;
		}
		const marked = this._modelRegistry.markProviderAuthStale(message.provider);
		if (marked) {
			this._emit({ type: "auth_stale", provider: message.provider });
		}
		return marked;
	}

	private _markProviderAuthStaleForRetryFailure(
		message: AssistantMessage,
		options?: {
			markAuthStaleOnFailure?: boolean;
			authSourceTokens?: readonly AuthSourceToken[];
		},
	): boolean {
		const authSourceTokens =
			this._retryAuthFailureSources.length > 0 ? this._retryAuthFailureSources : options?.authSourceTokens;
		if ((authSourceTokens?.length ?? 0) > 0 || options?.markAuthStaleOnFailure) {
			const marked = this._markProviderAuthStale(message, authSourceTokens);
			if (marked && message.errorMessage) {
				message.errorMessage = addLoginGuidanceToAuthError(message.errorMessage);
			}
			return marked;
		}
		return false;
	}

	private _finishActiveRetryWithFailure(message: AssistantMessage): void {
		if (this._retryAttempt === 0) {
			return;
		}
		this._markProviderAuthStaleForRetryFailure(message);
		this._restorePrimaryModelAfterBackup();
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt: this._retryAttempt,
			finalError: message.errorMessage,
		});
		this._terminalFailureAttemptCount = this._retryAttempt;
		this._retryAttempt = 0;
		this._providerWait = undefined;
		this._retryAuthFailureSources = [];
	}

	/**
	 * Tell the parent agent when a turn ends in a terminal model/provider failure.
	 * Without this, a subagent session parks silently in needs_input and the parent
	 * only sees the synthesized completed_without_reply notice, which carries no
	 * error context and reads like a normal completion. A successful delivery counts
	 * as a parent reply, which suppresses that misleading notice; when delivery
	 * fails here, the synthesized notice remains as the fallback.
	 */
	private async _notifyParentOfTerminalError(message: AssistantMessage): Promise<void> {
		if (this._rlmDepth <= 0 || this._disposed || this._disposing) return;
		const controller = this._agentMessageController;
		if (!controller?.roster || !controller.sendAgentMessage) return;
		let parent: AgentFamilyRosterEntry | undefined;
		try {
			const roster = await controller.roster();
			parent = roster.entries.find((entry) => entry.relationship === "parent");
		} catch {
			return;
		}
		if (!parent) return;
		// The module's own policy: the number the retry loop below actually stops at.
		const retryPolicy = providerRetryPolicy(this.settingsManager);
		const attempts = this._terminalFailureAttemptCount;
		const retrySummary =
			attempts > 0
				? retryPolicy.enabled && attempts >= retryPolicy.maxRetries
					? `auto-retry exhausted after ${attempts} attempt(s)`
					: `auto-retry stopped after ${attempts} attempt(s)`
				: retryPolicy.enabled
					? "error classified as non-retryable; no retries attempted"
					: "auto-retry disabled; no retries attempted";
		const notice = formatSubagentTerminalErrorNotice({
			errorMessage: message.errorMessage,
			provider: message.provider,
			model: message.model,
			retrySummary,
		});
		const target = parent.name.trim() || parent.id;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let receipt: AgentSessionMessageReceipt | undefined;
		try {
			// A hung send on a broken transport must not freeze the event queue of a
			// session whose turn already failed.
			receipt = await Promise.race([
				controller.sendAgentMessage({ target, message: notice, receiverRole: "parent" }),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Subagent terminal-error notice timed out")), 10_000);
				}),
			]);
		} catch {
			return;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		// B1: a queued receipt is not a delivered notice. Counting it would tell the
		// parent's terminal gate "the child already reported" while the report still
		// sits in a queue that may never drain, leaving both sides silent.
		if (receipt?.deliveryStatus !== "delivered") {
			sessionLog.info("subagent terminal-error notice was queued, not delivered", {
				sessionId: this.sessionId,
				target,
				deliveryStatus: receipt?.deliveryStatus,
			});
			// Remember which message carries the report. A queued receipt is still not
			// a delivered notice (B1, and the parent's classifier is right to report
			// the failure), but when the parent's queue drains it credits this session
			// by id - and that is when the parent's own failure notice for this run
			// turns into a second report of the same death.
			if (receipt?.deliveryStatus === "queued") this._queuedTerminalErrorNoticeMessageId = receipt.id;
			return;
		}
		this._repliedToParentSinceTask = true;
		this._parentReplyCount += 1;
		// The parent has now been told through agent_message: the synthesized
		// terminal notice for the same run must not repeat it (C7 double-send
		// suppression reads this flag).
		this._terminalErrorNoticeDelivered = true;
	}

	private async _handleRetryableError(
		message: AssistantMessage,
		options?: {
			markAuthStaleOnFailure?: boolean;
			authSourceTokens?: readonly AuthSourceToken[];
		},
	): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._retryAuthFailureSources = [];
			this._terminalFailureAttemptCount = 0;
			this._resolveRetry();
			return false;
		}

		// One retry count for the module layer: `retry.provider.maxRetries` (when set) is a
		// parameter of this policy, not a provider-client option any more, so the loop bound
		// and the attempt count it reports are the same number the one-shot consumers get.
		const retryPolicy = providerRetryPolicy(this.settingsManager);
		const requestBudget = this._crossLayerRequestBudget();
		// The shared chain is spent: another resend here would exceed the ceiling the
		// layers agreed on, so the failure surfaces with the count instead. This is the
		// only place that can see both the SDK's spend and its own retry budget.
		if (requestBudget.exhausted) {
			sessionLog.warn("cross-layer provider request budget exhausted; not retrying", {
				sessionId: this.sessionId,
				attempt: this._retryAttempt,
				requestBudget: { used: requestBudget.used, maxRequests: requestBudget.maxRequests },
				errorMessage: message.errorMessage,
			});
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: `${message.errorMessage ?? "Unknown error"} (not retried: the shared provider request budget is exhausted - ${requestBudget.describe()}).`,
			});
			this._terminalFailureAttemptCount = this._retryAttempt;
			this._retryAttempt = 0;
			this._retryAuthFailureSources = [];
			this._resolveRetry();
			return false;
		}

		if (!this._retryPromise) {
			this._retryPromise = new Promise((resolve) => {
				this._retryResolve = resolve;
			});
		}

		const waitClass = providerWaitClass(providerStreamFailureKind(message), providerStreamFailureStatus(message));

		// User-defined backup model (settings.providerBackupModel, default none):
		// route the failed turn to the backup instead of waiting while the
		// primary is quota-blocked or its provider is unavailable.
		if (waitClass !== "permanent") {
			const backupModel = this._resolveBackupModel();
			if (backupModel && !modelsAreEqual(this.model, backupModel)) {
				return this._handleBackupModelRetry(message, options, backupModel);
			}
		}

		this._retryAttempt++;

		const waitPolicy = this.settingsManager.getProviderWaitSettings();
		// Quota/subscription exhaustion: wait for usage to come back with bounded
		// exponential-backoff pings (and a scheduled resume when the provider
		// reports a reset time) instead of the quick-retry loop.
		if (waitClass === "quota" && waitPolicy.enabled) {
			return this._handleProviderWait(message, options, waitPolicy, "usage");
		}

		if (this._retryAttempt > retryPolicy.maxRetries) {
			this._markProviderAuthStaleForRetryFailure(message, options);
			const restoredModel = this._restorePrimaryModelAfterBackup();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: message.errorMessage,
				...(restoredModel ? { restoredModel } : {}),
			});
			this._terminalFailureAttemptCount = this._retryAttempt - 1;
			this._retryAttempt = 0;
			this._retryAuthFailureSources = [];
			this._resolveRetry(); // Resolve so waitForRetry() completes
			return false;
		}

		// Server-requested waits are honored, capped by retry.provider.maxRetryDelayMs (0 disables).
		const maxRetryDelayMs = this.settingsManager.getProviderRetrySettings().maxRetryDelayMs;
		const delay = providerRetryDelay(this._retryAttempt, providerStreamFailureRetryAfterMs(message), {
			baseDelayMs: settings.baseDelayMs,
			maxRetryDelayMs,
		});
		if (delay.kind === "exceeds-cap") {
			this._markProviderAuthStaleForRetryFailure(message, options);
			const restoredModel = this._restorePrimaryModelAfterBackup();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: `Provider requested a ${Math.ceil(delay.retryAfterMs / 1000)}s wait before retrying (above retry.provider.maxRetryDelayMs=${maxRetryDelayMs}ms): ${message.errorMessage || "unknown error"}`,
				...(restoredModel ? { restoredModel } : {}),
			});
			this._retryAttempt = 0;
			this._retryAuthFailureSources = [];
			this._resolveRetry();
			return false;
		}

		return this._retryAfterDelay(
			message,
			options,
			{
				type: "auto_retry_start",
				attempt: this._retryAttempt,
				maxAttempts: retryPolicy.maxRetries,
				delayMs: delay.delayMs,
				errorMessage: message.errorMessage || "Unknown error",
				// Fork visibility, moved here by the merge (it used to ride in the inline
				// emit inside _retryAfterDelay): the count the provider layer already spent
				// is the number that used to be invisible, since SDK-level retries logged
				// nothing. Present only when the shared budget counted a request.
				...(requestBudget.used > 0
					? { requestBudget: { used: requestBudget.used, maxRequests: requestBudget.maxRequests } }
					: {}),
			},
			delay.delayMs,
		);
	}

	/**
	 * Shared retry tail: park the failed turn, surface the retry attempt, wait,
	 * and re-issue the turn. Returns false when the retry was aborted instead.
	 */
	private async _retryAfterDelay(
		message: AssistantMessage,
		options:
			| {
					markAuthStaleOnFailure?: boolean;
					authSourceTokens?: readonly AuthSourceToken[];
			  }
			| undefined,
		emitStart: Extract<AgentSessionEvent, { type: "auto_retry_start" }>,
		delayMs: number,
	): Promise<boolean> {
		// Park now: the retry re-issues the failed call and must reuse its Idempotency-Key.
		// Payload hooks mutate the wire body after the hash point, so reuse is forfeited.
		if (!this._extensionRunner.hasHandlers("before_provider_request")) {
			this._semanticEdges.prepareTurnRetry();
		}

		this._emit(emitStart);

		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			const attempt = this._retryAttempt;
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._retryAttempt = 0;
			this._terminalFailureAttemptCount = attempt;
			this._retryAbortController = undefined;
			this._providerWait = undefined;
			const restoredModel = this._restorePrimaryModelAfterBackup();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
				...(restoredModel ? { restoredModel } : {}),
			});
			this._resolveRetry();
			this._retryAuthFailureSources = [];
			return false;
		}
		this._retryAbortController = undefined;

		const retryGeneration = this._retryGeneration;
		setTimeout(() => {
			// A retry aborted between the sleep and this scheduled start must not
			// re-issue the turn (e.g. onto a quota-blocked primary after a restore).
			if (this._retryGeneration !== retryGeneration || !this.isRetrying) return;
			this.agent.continue().catch((error: unknown) => {
				// A continue that never starts must still resolve the retry (else isRetrying
				// sticks forever) — unless a newer retry owns the state by now.
				if (this._retryGeneration !== retryGeneration || !this.isRetrying) return;
				this._markProviderAuthStaleForRetryFailure(message, options);
				const restoredModel = this._restorePrimaryModelAfterBackup();
				const attempt = this._retryAttempt;
				this._retryAttempt = 0;
				this._providerWait = undefined;
				this._retryAuthFailureSources = [];
				this._emit({
					type: "auto_retry_end",
					success: false,
					attempt,
					finalError: error instanceof Error ? error.message : String(error),
					...(restoredModel ? { restoredModel } : {}),
				});
				this._resolveRetry();
			});
		}, 0);

		return true;
	}

	/**
	 * Resolve the user-configured backup model reference against the available
	 * models. Unknown or unauthenticated references resolve to undefined: the
	 * wait loop runs instead, and never surprises the user with a switch.
	 */
	private _resolveBackupModel(): Model<any> | undefined {
		const reference = this.settingsManager.getProviderBackupModel();
		if (!reference) return undefined;
		const backupModel = findExactModelReferenceMatch(reference, this._modelRegistry.getAvailable());
		if (!backupModel || !this._modelRegistry.hasConfiguredAuth(backupModel)) {
			return undefined;
		}
		return backupModel;
	}

	/** Route the failed turn to the backup model and retry immediately on it. */
	private _handleBackupModelRetry(
		message: AssistantMessage,
		options:
			| {
					markAuthStaleOnFailure?: boolean;
					authSourceTokens?: readonly AuthSourceToken[];
			  }
			| undefined,
		backupModel: Model<any>,
	): Promise<boolean> {
		const previousModel = this.agent.state.model;
		const previousThinkingLevel = this.agent.state.thinkingLevel;
		const previousServiceTier = this.agent.state.serviceTier;
		this.agent.state.model = backupModel;
		// Clamp per-request fields to what the backup supports; all of them are
		// restored when the turn returns to the primary.
		this.agent.state.thinkingLevel = clampThinkingLevel(backupModel, previousThinkingLevel) as ThinkingLevel;
		this._clampServiceTierForModel();
		// Session-log the switch so primary->backup->primary transitions stay debuggable.
		this.sessionManager.appendModelChange(backupModel.provider, backupModel.id);
		this._backupModel = {
			backup: backupModel,
			primary: previousModel,
			thinkingLevel: previousThinkingLevel,
			serviceTier: previousServiceTier,
		};
		this._retryAttempt++;
		this._providerWait = undefined;

		return this._retryAfterDelay(
			message,
			options,
			{
				type: "auto_retry_start",
				attempt: this._retryAttempt,
				maxAttempts: providerRetryPolicy(this.settingsManager).maxRetries,
				delayMs: 0,
				errorMessage: message.errorMessage || "Unknown error",
				reason: "backup",
				backupModel: `${backupModel.provider}/${backupModel.id}`,
			},
			0,
		);
	}

	/**
	 * One bounded wait-for-recovery ping: exponential backoff with jitter, a
	 * scheduled resume when the provider reports a reset time, and hard abort
	 * bounds so the wait can never hang.
	 */
	private async _handleProviderWait(
		message: AssistantMessage,
		options:
			| {
					markAuthStaleOnFailure?: boolean;
					authSourceTokens?: readonly AuthSourceToken[];
			  }
			| undefined,
		policy: ProviderWaitPolicy,
		reason: "usage" | "unavailable",
	): Promise<boolean> {
		const wait = this._providerWait;
		const startedAtMs = wait?.startedAtMs ?? Date.now();
		const pingAttempt = (wait?.attempts ?? 0) + 1;
		this._providerWait = { attempts: pingAttempt, startedAtMs };

		const resetMs = providerStreamFailureRetryAfterMs(message) ?? parseProviderResetMs(message.errorMessage);
		const decision = providerWaitDecision(pingAttempt, Date.now() - startedAtMs, resetMs, policy);
		if (decision.kind === "abort") {
			this._markProviderAuthStaleForRetryFailure(message, options);
			const restoredModel = this._restorePrimaryModelAfterBackup();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: pingAttempt - 1,
				finalError: `${decision.message}: ${message.errorMessage || "unknown error"}`,
				...(restoredModel ? { restoredModel } : {}),
			});
			this._retryAttempt = 0;
			this._providerWait = undefined;
			this._retryAuthFailureSources = [];
			this._resolveRetry();
			return false;
		}

		return this._retryAfterDelay(
			message,
			options,
			{
				type: "auto_retry_start",
				attempt: pingAttempt,
				maxAttempts: policy.maxAttempts,
				delayMs: decision.delayMs,
				errorMessage: message.errorMessage || "Unknown error",
				reason,
			},
			decision.delayMs,
		);
	}

	/**
	 * Return to the primary model after a backup-model retry, unless the user
	 * switched models meanwhile. Returns the restored "provider/model-id"
	 * reference for the retry-end event.
	 */
	private _restorePrimaryModelAfterBackup(): string | undefined {
		const backup = this._backupModel;
		this._backupModel = undefined;
		if (!backup || !modelsAreEqual(this.model, backup.backup)) return undefined;
		this.agent.state.model = backup.primary;
		this.agent.state.thinkingLevel = backup.thinkingLevel;
		// Restore the saved effective tier: reclamping from the current state
		// would keep the tier the backup clamped it to.
		this._clampServiceTierForModel(backup.serviceTier);
		this.sessionManager.appendModelChange(backup.primary.provider, backup.primary.id);
		return `${backup.primary.provider}/${backup.primary.id}`;
	}

	abortRetry(): void {
		if (this._retryAbortController) {
			this._retryAbortController.abort();
			return;
		}
		if (this._retryAttempt > 0) {
			this._autoCompactionAbortController?.abort();
			this._cancelPostCompactionContinue();
			const restoredModel = this._restorePrimaryModelAfterBackup();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: "Retry cancelled",
				...(restoredModel ? { restoredModel } : {}),
			});
			this._retryAttempt = 0;
			this._providerWait = undefined;
		}
		this._terminalFailureAttemptCount = 0;
		this._retryAuthFailureSources = [];
		this._resolveRetry();
	}

	private async waitForRetry(): Promise<void> {
		if (!this._retryPromise) {
			return;
		}

		await this._retryPromise;
		await this.agent.waitForIdle();
	}

	get isRetrying(): boolean {
		return this._retryPromise !== undefined;
	}

	get hasAcceptedPromptInFlight(): boolean {
		return this._actionStore
			.unfinishedActions()
			.some(
				(action) =>
					action.payload.kind === "turn" &&
					!action.payload.queueVisible &&
					action.payload.acceptedBeforeCompletion,
			);
	}

	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: {
			excludeFromContext?: boolean;
			operations?: BashOperations;
			transient?: boolean;
		},
	): Promise<BashResult> {
		// Each invocation owns its controller so abortBash reaches every in-flight command.
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: abortController.signal,
				},
			);

			if (!options?.transient) {
				this.recordBashResult(command, result, options);
			}
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
			this._notifySessionInputCheckpointChange();
		}
	}

	/**
	 * Run a user-initiated bash command (! / !! prefix), emitting bash_start,
	 * bash_output, and bash_end session events so any attached client can render
	 * streaming output. Extensions can intercept execution via the user_bash event.
	 * Execution failures are reported through bash_end rather than a rejected promise;
	 * only the already-running guard and extension dispatch errors reject.
	 * @param command The bash command to execute
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 */
	async runUserBash(
		command: string,
		options?: {
			excludeFromContext?: boolean;
			transient?: boolean;
			runId?: string;
		},
	): Promise<void> {
		if (this.isBashRunning) {
			throw new Error("A bash command is already running");
		}
		// Claim the bash slot synchronously: isBashRunning is otherwise false until
		// executeBash installs its abort controller, which would let a second command
		// slip through during the user_bash extension dispatch below.
		this._userBashRunning = true;
		this._userBashAbortRequested = false;
		// Echoed on bash_start/bash_end so the requesting client can tell its own
		// run apart from other clients' runs broadcast on the same session.
		const identity = {
			...(options?.transient ? { transient: true } : {}),
			...(options?.runId !== undefined ? { runId: options.runId } : {}),
		};
		let end: UserBashEndDetails;
		try {
			end = await this.runUserBashLocked(
				command,
				options?.excludeFromContext ?? false,
				options?.transient ?? false,
				identity,
			);
		} finally {
			this._userBashRunning = false;
			this._notifySessionInputCheckpointChange();
		}
		// Emitted after the slot is released so clients never observe a bash_end
		// while the session still rejects new commands as already running.
		this._emit({ type: "bash_end", ...end, ...identity });
		void this._drainQueuedMessagesAfterBash().catch(() => undefined);
	}

	private async _drainQueuedMessagesAfterBash(): Promise<void> {
		await this.agent.waitForIdle();
		this._scheduleSessionInputPump();
	}

	private async runUserBashLocked(
		command: string,
		excludeFromContext: boolean,
		transient: boolean,
		identity: { transient?: boolean; runId?: string },
	): Promise<UserBashEndDetails> {
		const eventResult = await this._extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// Transient runs (side-conversation bash) live only in their pane: they
		// are never recorded, so reloads and rebuilds cannot resurface them.
		const record = transient
			? () => {}
			: (result: BashResult) => this.recordBashResult(command, result, { excludeFromContext });

		this._emit({
			type: "bash_start",
			command,
			excludeFromContext,
			...identity,
		});
		try {
			// If an extension returned a full result, surface it without executing
			if (eventResult?.result) {
				const result = eventResult.result;
				if (result.output) {
					this._emit({ type: "bash_output", chunk: result.output });
				}
				record(result);
				return {
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					truncated: result.truncated,
					fullOutputPath: result.fullOutputPath,
				};
			}

			// An abort that arrived before the process spawned (during extension
			// dispatch) has no abort controller to act on; honor it here instead.
			if (this._userBashAbortRequested) {
				record({
					output: "",
					exitCode: undefined,
					cancelled: true,
					truncated: false,
				});
				return { exitCode: undefined, cancelled: true, truncated: false };
			}

			const result = await this.executeBash(command, (chunk) => this._emit({ type: "bash_output", chunk }), {
				excludeFromContext,
				operations: eventResult?.operations,
				transient,
			});
			return {
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				truncated: result.truncated,
				fullOutputPath: result.fullOutputPath,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// Persist the failure like every other outcome so replayed transcripts
			// and the LLM context reflect that the command did not run.
			record({
				output: `bash failed: ${errorMessage}`,
				exitCode: undefined,
				cancelled: false,
				truncated: false,
			});
			return {
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				errorMessage,
			};
		}
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.agent.state.messages.push(bashMessage);

			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		// A user bash command may not have spawned yet (extension dispatch in
		// progress); flag the request so runUserBash cancels before executing.
		// runUserBash clears the flag at each start, so a stale flag is harmless.
		if (this._userBashRunning) {
			this._userBashAbortRequested = true;
		}
		for (const controller of this._bashAbortControllers) {
			controller.abort();
		}
	}

	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0 || this._userBashRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Dispose-time flush for deferred `!cmd` results.
	 *
	 * A bash result recorded while the agent was streaming waits for the next turn
	 * boundary (_prepareForCommit is the only other flush point), so quitting or
	 * being passivated before that turn used to drop it: the user had seen the
	 * output, the transcript never did. The flush is skipped while the run is still
	 * streaming - appending between an assistant tool call and its tool result is
	 * exactly the ordering corruption the deferral exists to prevent.
	 */
	private _flushPendingBashMessagesBeforeDispose(): void {
		if (this._pendingBashMessages.length === 0) return;
		if (this.isStreaming) return;
		try {
			this._flushPendingBashMessages();
		} catch (error) {
			// Disposal stays best-effort; a failed transcript write is still reported
			// through the regular persist-failure channel.
			this._reportSessionPersistFailure(error);
		}
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			this.agent.state.messages.push(bashMessage);

			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	getRlmMaxDepthStatus(): RlmMaxDepthStatus {
		return { maxDepth: this._rlmMaxDepth, source: this._rlmMaxDepthSource };
	}

	async setRlmMaxDepth(maxDepth: number, options: { global?: boolean } = {}): Promise<SetRlmMaxDepthResult> {
		if (!isNonNegativeInteger(maxDepth)) {
			throw new Error("RLM max depth must be a non-negative integer.");
		}

		this.sessionManager.appendCustomEntryWithRollback(RLM_MAX_DEPTH_STATE_CUSTOM_TYPE, { maxDepth });
		this._rlmMaxDepth = maxDepth;
		this._rlmMaxDepthSource = "chat";
		const oldBase = this._baseSystemPrompt;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._refreshExtensionSystemPrompt(this.agent.state.systemPrompt, oldBase);
		// A lowered cap is the operator's current policy for the whole subtree, not just for
		// spawns that start after this call (SC-2).
		this._pushRlmMaxDepthToChildren();

		let globalError: string | undefined;
		if (options.global) {
			await this.settingsManager.flush();
			const staleErrors = this.settingsManager.drainErrors("global");
			for (const { error } of staleErrors) {
				console.warn(`Warning: Earlier global settings write failed: ${error.message}`);
			}
			this.settingsManager.setRlmMaxDepth(maxDepth);
			await this.settingsManager.flush();
			const errors = this.settingsManager.drainErrors("global");
			globalError = errors.map(({ error }) => error.message).join("; ") || undefined;
		}

		return {
			...this.getRlmMaxDepthStatus(),
			globalSaved: options.global === true && globalError === undefined,
			...(globalError ? { globalError } : {}),
		};
	}

	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		this._emit({
			type: "session_info_changed",
			name: this.sessionManager.getSessionName(),
		});
	}

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	private _branchNavigationQueue: Promise<void> = Promise.resolve();

	async navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		} = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		const previous = this._branchNavigationQueue;
		let release = () => {};
		this._branchNavigationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await this._navigateTree(targetId, options);
		} finally {
			release();
		}
	}

	private async _navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		} = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		const queuedWorkPause = this.acquireQueuedWorkPause();
		let commitFence: { owner: symbol; release(): void } | undefined;
		try {
			// Branch navigation and turn dispatch mutate the same transcript leaf.
			commitFence = await this._acquireSessionActionCommitFence();
			return await this._sessionActionCommitContext.run(commitFence.owner, async () => {
				await this.agent.waitForIdle();
				await this._agentEventQueue;
				return this._navigateTreeUnderPause(targetId, targetEntry, options);
			});
		} finally {
			queuedWorkPause.release();
			commitFence?.release();
		}
	}

	private async _navigateTreeUnderPause(
		targetId: string,
		targetEntry: NonNullable<ReturnType<SessionManager["getEntry"]>>,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target after admitted work has settled.
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Do not switch branches while /refine has detached event handling and is
		// about to persist harness/session entries for the current branch.
		await this._invalidatePendingAutoRefineForBranchChange();

		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		this._branchSummaryAbortController = new AbortController();
		let resolveBranchSummaryOperation: () => void = () => {};
		const branchSummaryOperation = new Promise<void>((resolve) => {
			resolveBranchSummaryOperation = resolve;
		});
		this._branchSummaryOperation = branchSummaryOperation;

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const { apiKey, headers, requestModel: model } = await this._getRequiredRequestAuth(this.model!);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					signal: this._branchSummaryAbortController.signal,
					sessionId: this.sessionId,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					retry: providerRetryPolicy(this.settingsManager),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}

			if (newLeafId) {
				newLeafId = resolveCompleteToolPairLeaf(this.sessionManager.getBranch(newLeafId))?.id ?? null;
			}

			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				this.sessionManager.resetLeaf();
			} else {
				this.sessionManager.branch(newLeafId);
			}

			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			this._mergeUnpersistedOutcomes(this.agent.state.messages);
			this._restoreLateIpythonSentAgentMessages();
			// A context rebuild is a cold boundary: refresh the digest like resume does.
			this._ensureHarnessDigestContext();
			// A summary branch continues the same timeline, so the same goal's
			// accounting must never regress across the rebuild; a plain branch move
			// is time travel and keeps faithful branch semantics.
			this._reloadGoalStateFromBranch({ monotonicTokens: Boolean(summaryText) });
			this._reloadRlmMaxDepthFromBranch();
			this._invalidateQueuedPromptPreparation();

			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			if (this._branchSummaryOperation === branchSummaryOperation) {
				this._branchSummaryOperation = undefined;
			}
			resolveBranchSummaryOperation();
			this._notifySessionInputCheckpointChange();
		}
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		for (const message of state.messages) {
			if (message.role === "assistant") {
				toolCalls += (message as AssistantMessage).content.filter((c) => c.type === "toolCall").length;
			}
		}

		// Counts above describe the model-facing context; the token and cost totals
		// describe the session's spend, so they come from the whole transcript and
		// match /context and this session's roster row. Summing the live context
		// instead made every compaction and every rollback look like a refund.
		const { ownUsage } = this._ownUsageTotals();

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: ownUsage.input,
				output: ownUsage.output,
				cacheRead: ownUsage.cacheRead,
				cacheWrite: ownUsage.cacheWrite,
				total: ownUsage.input + ownUsage.output + ownUsage.cacheRead + ownUsage.cacheWrite,
			},
			cost: ownUsage.cost.total,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a readable assistant usage after the compaction boundary.
			// Keep scanning past aborted, errored and zero-usage assistants: stopping at
			// the first non-errored one reported "unknown" whenever a provider sent a
			// zero-usage response, while the compaction trigger - which reads the same
			// messages through estimateContextTokens - still had a usage source. Both
			// calibers now share isAssistantUsageSource.
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type !== "message") continue;
				if (isAssistantUsageSource(entry.message)) {
					hasPostCompactionUsage = true;
					break;
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	private _rlmSessionDirForReading(): string | undefined {
		return this._rlmSessionDir ?? this.sessionManager.getSessionArtifactDir({ create: false });
	}

	private _contextWindowResolver(): ContextWindowResolver {
		return (provider, modelId) => this._modelRegistry.find(provider, modelId)?.contextWindow;
	}

	private _ownUsageAccumulator?: OwnUsageAccumulator;
	/**
	 * Remembered on-disk half of the context tree for this session's RLM children.
	 *
	 * The tree is rebuilt on every /context paint and on every client refresh of the
	 * sub-agents tray, and its disk half reads and folds every child transcript under
	 * the session dir - the expensive part (a 544-child dir measured 2.2s / ~1.08GB) and
	 * usually the redundant one, because a UI refresh that changes nothing on disk used
	 * to pay it again. Owned per session, so one session's cache can never answer for
	 * another's dirs.
	 */
	private _contextTreeDiskCache?: ContextTreeDiskScanCache;
	private _ownUsageMemo?: { count: number; tailId: string | undefined; ownUsage: Usage; totalUsage: Usage };

	/**
	 * Whole-file own and total spend: the session's spend over every entry in the
	 * transcript, with attributed child usage subtracted from `ownUsage`. This is
	 * the persistent basis - the catalog scan, `getOwnUsageSummary` and `/context`
	 * all fold these same entries, so one session cannot report two totals.
	 *
	 * Incremental: the roster republishes many times per turn, and re-walking a
	 * transcript that only grows made each republication cost O(entries).
	 * `computeOwnAndTotalUsage(entries, entries)` is the same linear fold.
	 */
	private _ownUsageTotals(): { ownUsage: Usage; totalUsage: Usage } {
		// O(1) hit check: the stats advance with each append, so a flush that added
		// nothing compares two numbers instead of copying the whole transcript.
		const { count, tailId } = this.sessionManager.getEntryStats();
		const memo = this._ownUsageMemo;
		if (memo && memo.count === count && memo.tailId === tailId) {
			return { ownUsage: memo.ownUsage, totalUsage: memo.totalUsage };
		}
		const entries = this.sessionManager.getEntries();
		this._ownUsageAccumulator ??= new OwnUsageAccumulator();
		const { ownUsage, totalUsage } = this._ownUsageAccumulator.add(entries);
		this._ownUsageMemo = { count, tailId, ownUsage, totalUsage };
		return { ownUsage, totalUsage };
	}

	// Whole-file own spend, identical to the catalog scan so rows never shift at passivation.
	getOwnUsageSummary(): SessionUsageSummary | undefined {
		return sessionUsageSummaryFrom(this._ownUsageTotals().ownUsage);
	}

	/**
	 * Build the agent context overview for /context: this session as the root
	 * plus one node per RLM sub-agent, recursively. Running children are read
	 * from their live sessions; completed children from their persisted session
	 * dirs, so the tree survives child disposal and session resume.
	 */
	getContextTree(): ContextTreeNode {
		const resolveContextWindow = this._contextWindowResolver();
		// Spend comes from the persistent fold (every entry in the transcript, not the
		// active branch), so the root row reports the same total as this session's
		// roster/catalog row: a rollback or a fork moves work off the branch, but the
		// money it cost was still paid, and one session showing two different "spent"
		// numbers is worse than either basis alone. The context column stays
		// branch-scoped - that one really does describe only the branch the session
		// would resume on. Cloned because the fold is memoized and shared with the
		// roster's own copy of the same totals.
		const totals = this._ownUsageTotals();
		const ownUsage = cloneUsage(totals.ownUsage);
		const totalUsage = cloneUsage(totals.totalUsage);

		// One budget for the whole roster: the persisted children of this session and
		// of every live child are read for the same report, so they are charged to the
		// same accounting and the omission published here covers all of them.
		const scanState = createContextTreeScanState();
		if (!this._contextTreeDiskCache) this._contextTreeDiskCache = new ContextTreeDiskScanCache();
		const diskCache = this._contextTreeDiskCache;
		const children: ContextTreeNode[] = [];
		const liveIds = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			liveIds.add(run.id);
			// A child whose session is resident answers from memory - the usage fold the
			// session keeps for its own /usage, in O(1) - and only its own persisted
			// descendants come off the disk. `run.session` is unset for runs whose session
			// this process still holds (a settled run released its run handle, a run
			// abandoned for quiescence, a rehydrated child), and reading those transcripts
			// back from disk was both slower and staler than asking the session that owns
			// them: a live transcript is still growing, so every rescan re-read it.
			const liveChildSession = run.session ?? this._rlmChildSessions.get(run.id)?.session;
			const node =
				liveChildSession?.getContextTree() ??
				loadContextTreeChildFromDisk(run.sessionDir, resolveContextWindow, undefined, scanState, diskCache);
			children.push({
				...(node ?? {
					ownUsage: emptyUsage(),
					totalUsage: emptyUsage(),
					children: [],
				}),
				id: run.id,
				label: rlmChildLabel(run.prompt),
				status: run.status,
			});
		}
		const diskScan = scanContextTreeChildrenFromDisk(this._rlmSessionDirForReading(), resolveContextWindow, {
			skipIds: liveIds,
			state: scanState,
			cache: diskCache,
		});
		children.push(...diskScan.nodes);

		// Say what the budget refused instead of handing back a partial roster that
		// looks complete; nothing to say means the field stays off the wire.
		const scan = contextTreeScanDiagnostics(scanState);

		const model = this.model;
		return {
			id: "root",
			label: this.sessionName ?? "main agent",
			status: "active",
			model: model ? { provider: model.provider, id: model.id } : undefined,
			ownUsage,
			totalUsage,
			contextUsage: this.getContextUsage(),
			children,
			...(scan.truncated ? { scan } : {}),
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.settingsManager.getTheme();

		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolve(outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writePrivateFileAtomic(filePath, `${lines.join("\n")}\n`, { privateParent: false });
		return filePath;
	}

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		// The initiating extension is not in scope here; label timers with the context kind instead.
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext("<session-replacement>")),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}

function isRlmHeartbeatStatusUpdate(value: unknown): value is AgentRlmHeartbeatStatusUpdate {
	return value === "pause" || value === "resume";
}

function rlmHeartbeatHostResponse(job: AgentCronJob): Record<string, unknown> {
	return {
		id: job.id,
		status: job.status,
		label: job.label ?? null,
		delivery_mode: job.deliveryMode ?? "steer",
		instruction: job.prompt,
		schedule: job.schedule,
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		next_run_at: job.nextRunAt ?? null,
		last_run_at: job.lastRunAt ?? null,
		last_error: job.lastError ?? null,
		run_count: job.runCount,
	};
}

/** Outcome of an injected heartbeat prompt admission (G5, r37 hbgoal-ts). */
export interface AgentHeartbeatPromptResult {
	/** True when a new session action was admitted (immediately or queued). */
	admitted: boolean;
	/** True when an equivalent follow-up was already pending, so nothing new was queued. */
	coalesced: boolean;
}
