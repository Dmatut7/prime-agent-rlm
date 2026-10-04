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
	type AgentModelOverride,
	type AgentState,
	type AgentTool,
	EMPTY_TURN_RETRY_DEFAULTS,
	EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE,
	ESCALATED_EMPTY_TURN_RETRY_DEFAULTS,
	formatToolCallIdCollisions,
	type GetContinuationMessagesContext,
	isEmptyTurnRetryExhausted,
	isServerDirectedRetryStall,
	readToolCallIdCollisions,
	type ShouldStopAfterTurnContext,
	type ThinkingLevel,
	TOOL_CALL_ID_COLLISION_DIAGNOSTIC_TYPE,
	type UndeliveredMessageSource,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	ServiceTier,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	clearProviderRequestBudgetCeiling,
	configureProviderRequestBudget,
	forgetProviderRequestBudget,
	getLogger,
	getProviderRequestBudget,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	type ProviderRequestBudget,
	peekProviderRequestBudget,
	resetApiProviders,
	resetProviderRequestBudget,
	supportsFastMode,
} from "@earendil-works/pi-ai";
import { theme } from "../modes/interactive/theme/theme.js";
import { untilAborted, type WaitTimeoutFacts } from "../utils/bounded-wait.js";
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
	type AgentSessionMessageAbortReceipt,
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
	formatAgentSessionNameUnavailable,
	formatSubagentTerminalErrorNotice,
	isAgentSessionMessage,
	isAgentSessionMessageId,
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
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	type CompactionWindowLimits,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	compactionSkipMessage,
	compactionThresholdTokens,
	type EmergencyShrinkPlan,
	estimateContextTokens,
	estimateTokensByContent,
	generateBranchSummary,
	isAssistantUsageSource,
	planEmergencyShrink,
	prepareCompactionOutcome,
	SummarizationRefusalError,
	type SummaryCallRunner,
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
import {
	type AgentCronJob,
	type AgentCronJobStore,
	type AgentRlmHeartbeatController,
	type AgentRlmHeartbeatStatusUpdate,
	normalizeHeartbeatDeliveryMode,
} from "./cron-jobs.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import type { ResourceDiagnostic } from "./diagnostics.js";
import { autonomousPromptFingerprint, DUTY_EVENT_CUSTOM_TYPE, type DutyEvent } from "./duty-log.js";
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
	goalContinuationLimit,
	goalHostResponse,
	goalTokenDeltaForUsage,
	isPersistedGoalState,
	MAX_GOAL_CONTINUATIONS,
	normalizeGoalState,
	PERSISTENT_GOAL_MIN_CONTINUATION_INTERVAL_MS,
	parseGoalPersistentFlag,
	persistentGoalCompletionRejection,
	validateGoalBudget,
	validateGoalObjective,
} from "./goals.js";
import {
	ensureHarnessDigestContext,
	type HarnessStoreStamps,
	harnessDigestIsFresh,
	harnessDigestWithFingerprint,
	invalidateHarnessDigestBaselines,
	latestContextHarnessDigestDetails,
	loadMergedHarnessState,
	noteHarnessDigestToolFaceChange,
	type PreparedHarnessDigest,
	prepareHarnessDigest,
	recordHarnessDigestBaselines,
	refreshHarnessDigestIfMateriallyChanged,
} from "./harness-digest.js";
import { type ImageModelRoutingInputs, resolveImageModelRoute } from "./image-model-routing.js";
import {
	batchCarriesImages,
	beginImageRoute,
	type ImageRouteDecision,
	imageModelRoutingInputs,
	imageRouteForTurns,
	imageRouteModel,
	installImageRouteContextHook,
	isImageRoutedRun,
	maybeNoticeImageDeliverySuspicion,
	routeImagesOnAgentEvent,
	runModel,
} from "./image-routing.js";
import {
	classifyIncomingInput,
	type InputClass,
	incomingInputFactsFromMessage,
	inputClassOrigin,
} from "./input-classification.js";
import {
	CHANGE_TRACKING_ENV_VAR,
	type HostRequestHandlers,
	type KernelDeathCause,
	type KernelLateHostReply,
	type KernelSentAgentMessage,
	type KernelUnexpectedExitFacts,
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
	createAsyncBashCompletionMessage,
	createAutoContinueMessage,
	createCompactionOutcomeMessage,
	createEmptyResponseRecoveryMessage,
	createHarnessDigestMessage,
	createHeartbeatPromptMessage,
	createModelChangeMessage,
	createSessionSlashCommandMessage,
	createSessionSlashCommandResultMessage,
	EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE,
	HARNESS_DIGEST_CUSTOM_TYPE,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	HEARTBEAT_PROMPT_PREVIEW_LABEL,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	isSessionSlashCommandMessage,
	MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
	type ModelChangeMessage,
	type ModelChangeNoticeDetails,
	PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	type RlmChildFailureDetails,
	SESSION_CONTEXT_LOSS_CUSTOM_TYPE,
	THINKING_LEVEL_CLAMPED_CUSTOM_TYPE,
} from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { findExactModelReferenceMatch, findPreferredDefaultModel } from "./model-resolver.js";
import {
	SessionInputAdmissionPausedError,
	SessionInputCoalescingError,
	SessionInputSuspendedError,
	throwIfPromptAdmissionCancelled,
} from "./prompt-admission.js";
import { expandPromptTemplate, type PromptTemplate, parseCommandArgs } from "./prompt-templates.js";
import {
	BAD_TOOL_CALL_STORM_THRESHOLD,
	CONTENT_INSPECTION_WITHHOLD_STEPS,
	contextHasImages,
	createImageUnreadNoticeText,
	describeProviderFailureCause,
	isBadToolCall,
	isInputContentInspectionRejection,
	isWithheldToolResult,
	PROVIDER_FALLBACK_ENTRY_TYPE,
	PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE,
	PROVIDER_FALLBACK_RETURN_AFTER_MS,
	PROVIDER_IMAGE_UNREAD_CUSTOM_TYPE,
	PROVIDER_INSPECTION_WITHHELD_ENTRY_TYPE,
	PROVIDER_LONG_WAIT_RESUME_MARKER_TEXT,
	PROVIDER_LONG_WAIT_WAKE_GRACE_MS,
	type ProviderFallbackEntryData,
	providerLongWaitDelayMs,
	readPersistedFallbackEpisode,
	readPersistedLongWait,
	toolResultText,
	withheldToolResult,
} from "./provider-fallback.js";
import {
	isAgentLifecycleFailure,
	isFauxProviderQueueExhausted,
	isPermanentProviderFailureKind,
	isProviderModelRejection,
	type ProviderWaitPolicy,
	providerRetryDelay,
	providerRetryPolicy,
	providerStreamFailureDetails,
	providerStreamFailureKind,
	providerStreamFailureRetryAfterMs,
	providerStreamFailureStatus,
	providerWaitClass,
} from "./provider-retry.js";
import {
	completeQuotaParkResume,
	createQuotaResumeJob,
	handleAbortedQuotaPark,
	handleErroredQuotaParkProbe,
	handleProviderWait,
	normalizeMessageContent,
	primaryDeliveryRecord,
	reloadQuotaParkFromBranch,
	resolveQuotaResumeJob,
	restoreQuotaPark,
} from "./quota-park.js";
import {
	type AutoRefineReviewer,
	type AutoRefineReviewRequest,
	applyRefine,
	emitRefineFailed,
	planRefine,
	RefinePersistScopeError,
	RefineSkippedError,
	refine,
	runAutoRefineReview,
	waitForRefineIdle,
} from "./refine-execution.js";
import {
	applySerializedPlan,
	autoRefineAllowedForSession,
	consumePendingRequestedRefine,
	consumeSerializedBackgroundPlan,
	discardPendingAutoRefine,
	drainPendingRefinementForDisposal,
	handleRefineHostRequest,
	invalidatePendingAutoRefineForBranchChange,
	maybeAutoRefine,
	maybeStartSerializedBackgroundPlan,
	runApprovedRefine,
	runBackgroundPlan,
	runSerializedAutoRefineReview,
	runSerializedRefine,
	runSerializedRefineCheckpoint,
	runSerializedRefineCheckpointAfterBackground,
	type SerializedBackgroundPlanResult,
	scheduleAutoRefine,
	scheduleAutoRefineAfterAgentEnd,
	scheduleAutoRefineAfterCompaction,
	scheduleDeferredAutoRefineIfIdle,
	shouldSkipAutoRefineForActiveAgent,
} from "./refine-scheduler.js";
import {
	type AutoRefineReason,
	type AutoRefineReview,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	type HarnessScope,
	type HarnessState,
	REFINE_SKILL_NAME,
	type RefinementPlan,
	type RefinementResult,
} from "./refinement/index.js";
import { resolveConfigValue } from "./resolve-config-value.js";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";
import { type ClosedRlmChildCollectEntry, collectRlmChildren } from "./rlm-child-collect.js";
import {
	deleteInactiveRlmSubagent,
	deleteRlmSubagent,
	ensureRlmRunDeletionCleanup,
	finishRlmRunDeletion,
	observeRlmRunDeletionCleanup,
} from "./rlm-child-delete.js";
import {
	type RlmChildFollowUpWatch,
	stopAllRlmChildFollowUpWatches,
	stopRlmChildFollowUpWatch,
	watchRlmChildFollowUps,
} from "./rlm-child-followup.js";
import {
	abortRlmSubtree,
	hasUnsettledRlmQuiescenceWork,
	rlmSubtreeSessions,
	waitForRlmQuiescence,
} from "./rlm-child-quiescence.js";
import {
	getRlmChildSnapshots,
	hasRunningRlmChildren,
	type RetiredRlmChildRun,
	registerRlmChildSession,
	releaseRlmChildSession,
	removeRlmSubagentTracking,
	rlmChildRunForNotice,
	rlmChildSessionSnapshot,
} from "./rlm-child-retention.js";
import {
	buildRlmSubagentList,
	listRlmSubagents,
	pruneRlmSubagents,
	type RlmListSubagentsOptions,
	type RlmPruneSubagentsResult,
	type RlmSubagentRosterView,
} from "./rlm-child-roster.js";
import {
	type AgentMessageDeferred,
	compactRlmText,
	createAgentMessageDeferred,
	type RlmChildDeriveCounts,
	type RlmChildRun,
	resetRlmChildDeriveCounts,
	rlmChildDeriveCounts,
	rlmChildLabel,
	startRlmChildRun,
} from "./rlm-child-run.js";
import { cloneCustomMessage } from "./rlm-child-stall-notice.js";

export type { RlmChildDeriveCounts };
export { compactRlmText, resetRlmChildDeriveCounts, rlmChildDeriveCounts, rlmChildLabel };

import {
	RLM_CHILD_SETTLED_CUSTOM_TYPE,
	type RlmChildSettledDetails,
	type RlmChildStallAbortFacts,
	type RlmChildTurnAbortReason,
} from "./rlm-child-terminal.js";
import { deliverRlmChildTerminalOutcome, recordRlmChildStallEvent } from "./rlm-child-terminal-outcome.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createAsyncBashCompletionHostHandler,
	createAsyncBashConsumedHostHandler,
	createDefaultRlmSubagentSessionName,
	createRlmCollectHostHandler,
	createRlmCreateSessionHostHandler,
	createRlmDeleteSubagentHostHandler,
	createRlmFindModelsHostHandler,
	createRlmProgressNoteHostHandler,
	createRlmRunHostHandler,
	findRlmModelMatches,
	findUniqueRlmShortFormModelMatch,
	formatRlmModelUnavailableError,
	normalizeRequestedRlmSubagentModel,
	normalizeRequestedRlmSubagentSessionName,
	normalizeRequestedRlmSubagentThinkingLevel,
	type RlmCollectResult,
	type RlmCreateSessionResult,
	type RlmDeleteSubagentResult,
	type RlmFindModelsResult,
	type RlmListSubagentsResult,
	type RlmProgressNoteResult,
	type RlmSpawnHandle,
	type RlmSubagentRegistryEntry,
	type RlmSubagentRuntime,
	type SubagentRuntimeHost,
} from "./rlm-runtime.js";
import {
	announcedNextStep,
	autoContinuesInRun,
	completionClaimWithoutEvidence,
	createOutputTruncatedContinueMessage,
	createProviderFailureRecoveryMessage,
	dutyEventFor,
	FINISH_GATE_MAX_STRIKES,
	finishGateStrikesInRun,
	lastUserPromptText,
	PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE,
	ranToolsSinceLastPrompt,
	runHasVerificationEvidence,
	SELF_RECOVERY_CUSTOM_ENTRY,
	type SelfRecoveryRecord,
} from "./self-recovery.js";
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
	type SessionActionPlacement,
	type SessionActionPriority,
	type SessionActionSnapshot,
	type SessionCommandPayload,
	type SessionTurnPayload,
	transitionSessionAction,
	type WakePolicy,
} from "./session-action-store.js";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	SessionContext,
	SessionMessageEntry,
	TranscriptLineSkip,
} from "./session-manager.js";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	getTranscriptLineSkips,
	type SessionHeader,
	SessionManager,
} from "./session-manager.js";
import { consecutiveToolErrorsFromMessages, type SessionStats } from "./session-stats.js";
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
import type { StallWatchdog, StallWatchdogTimers } from "./stall-watchdog.js";
import {
	createSessionStallWatchdog,
	createSessionTurnLiveness,
	recordStallWatchdogActivity,
	resolvedToolTimeoutConfig,
	trackStallStepOutput,
} from "./stall-watchdog-wiring.js";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.js";
import { THINKING_LEVELS } from "./thinking-levels.js";
import { acpMcpToolNames, createAcpMcpToolDefinitions } from "./tools/acp-mcp.js";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.js";
import { createAllToolDefinitions } from "./tools/index.js";
import {
	formatIpythonAbortCause,
	type IpythonAbortCause,
	IpythonKernelProvisioner,
	type UnavailablePythonSkills,
} from "./tools/ipython.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";
import type { JournaledBashFacts, TurnLiveness, TurnLivenessKernelFacts } from "./turn-liveness.js";
import { cloneUsage, emptyUsage, type SessionUsageSummary, sessionUsageSummaryFrom } from "./usage.js";
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

import type { StallDiagnostics, StallEventActions } from "./stall-diagnostics.js";
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
			/**
			 * The chain closed because an overflow compaction took over the
			 * continuation: the task is still running, so this end is not a failure
			 * (success stays true) and the marker lets a client render the handoff.
			 */
			supersededByCompaction?: boolean;
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
			/**
			 * Actions the event offers to whoever is watching (r4 recovery-shell).
			 * Optional and additive: the in-process emitter never sets it (the
			 * interactive host resolves its own keys), the daemon fills it once its
			 * stall-recovery sweep has the session under observation, and an older
			 * client ignores it. Terminal stages never carry it (S1).
			 */
			actions?: StallEventActions;
	  }
	| {
			type: "stall_abort";
			message: string;
			silentMs: number;
			thresholdMs: number;
			diagnostics: StallDiagnostics;
			/** Never populated: the turn is dead, there is nothing left to act on (S1). */
			actions?: StallEventActions;
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
			/** Never populated: the turn is dead, there is nothing left to act on (S1). */
			actions?: StallEventActions;
	  }
	| {
			/**
			 * The empty-response retry ladder (fast tier, escalated slow tier, and any
			 * recovery continuation) is exhausted and the run ended without model output.
			 * The loud, structured form of a failure that used to end in a silent stop;
			 * parents, clients, and logs all see the real attempt counts.
			 */
			type: "empty_response_exhausted";
			message: string;
			/** Total provider attempts the ladder spent. */
			attempts: number;
			/** Total wait between attempts, in ms. */
			waitedMs: number;
			/** Slow-tier (escalated) attempts and wait, in ms. */
			escalatedAttempts: number;
			escalatedWaitedMs: number;
			/** Which limit stopped the ladder: attempts, budget, abort, or request_budget. */
			terminatedBy: string;
			/** Recovery continuations spent in this episode before the terminal. */
			recoveryContinuations: number;
			provider?: string;
			model?: string;
	  };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

type UserBashEndDetails = {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	errorMessage?: string;
};

export class CompactionSkippedError extends Error {
	/** When the skip outcome carries a shrink plan (over threshold with nothing
	 * summarizable outside the kept tail), the plan rides the error and the caller
	 * decides whether to spend the valve. Running the shrink inside the
	 * summarization scope would digest a shrink failure into that scope's own
	 * compaction_end instead of letting it escape to the caller (w9a pin). */
	emergencyShrink?: EmergencyShrinkPlan | null;
}

/**
 * Moved to ./refine-execution.js and ./refine-scheduler.js with the refine
 * cluster cuts; re-exported here so existing import paths (including the test
 * harness) keep working.
 */
export type { AutoRefineReviewer, AutoRefineReviewRequest, SerializedBackgroundPlanResult };
export { RefinePersistScopeError, RefineSkippedError };

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
	 * Minimum wall-clock spacing between the automatic continuations of a
	 * persistent goal. Defaults to PERSISTENT_GOAL_MIN_CONTINUATION_INTERVAL_MS;
	 * exposed so tests can shrink the throttle instead of waiting it out.
	 */
	persistentGoalMinContinuationIntervalMs?: number;
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
	 * Cumulative CPU (ms) of the running step's process tree, for the silent-step rule.
	 * Tests inject it; the default sums the kernel and its journaled bash handles with `ps`.
	 */
	stepCpuProbe?: () => number | undefined;
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
	/** Overrides the queue priority derived from the input classification. */
	priority?: SessionActionPriority;
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

export type QueuedAgentMessage = UserMessage | CustomMessage;
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

export interface PreparedTurnPayload extends SessionTurnPayload {
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

export type QueuedSessionAction = SessionAction<PreparedTurnPayload | PreparedCommandPayload>;

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
	/** Absent in snapshots written before #2334: the restore path re-derives it. */
	priority?: SessionActionPriority;
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

function cloneQueuedAgentMessage(message: QueuedAgentMessage): QueuedAgentMessage {
	if (message.role === "custom") return cloneCustomMessage(message);
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

/**
 * Queue priority is derived from the fork's single input-classification point instead of
 * carrying its own heuristic (#2334 reconciliation). `classifyIncomingInput` reads structure
 * only - never the message text - so a child reply cannot forge its way to the front of the
 * queue, and its human default means an input nobody recognizes keeps human priority instead
 * of being silently demoted. Agent-to-agent delivery ids demote unconditionally: that check is
 * structural too, and it is what keeps `promptAndWait`'s self-minted `prompt-wait:<uuid>` id
 * (which is not agent traffic) at human priority.
 *
 * `source` is optional on purpose: the parked-queue restore path records `source: "internal"`
 * for input a person typed, so a caller that cannot vouch for the source leaves it out and lets
 * the message envelope decide.
 */
/**
 * The single class -> priority mapping. Deriving it from `inputClassOrigin` (which is
 * compile-time exhaustive over `InputClass`) is what keeps the two faces from drifting:
 * a machine class added later - the harness digest row #2098 added is exactly that case -
 * lands in `background` without anyone having to remember this function.
 */
export function sessionActionPriorityForInputClass(inputClass: InputClass): SessionActionPriority {
	return inputClassOrigin(inputClass) === "human" ? "user" : "background";
}

export function sessionActionPriorityFor(facts: {
	source?: InputSource | "internal";
	message?: QueuedAgentMessage;
	agentMessageId?: string;
}): SessionActionPriority {
	if (isAgentSessionMessageId(facts.agentMessageId)) return "background";
	const classification = classifyIncomingInput(
		incomingInputFactsFromMessage(facts.message ?? { role: "user" }, {
			...(facts.source === undefined ? {} : { source: facts.source }),
			...(facts.agentMessageId === undefined ? {} : { agentMessageId: facts.agentMessageId }),
		}),
	);
	return sessionActionPriorityForInputClass(classification);
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

/**
 * waitForIdle's macrotask fuse. A cycle that made progress yields with `setImmediate`,
 * which is enough to keep timers and IO alive without adding latency to a draining
 * queue; a cycle that made none waits this long instead, so a stranded state costs a
 * bounded poll rather than a hot loop.
 */
const WAIT_FOR_IDLE_POLL_MS = 50;
/** Mirrors RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH in core/rlm-runtime.ts: the cap a minted successor name must stay under. */
const RLM_SUCCESSOR_SESSION_NAME_CAP = 64;

/** Closed-after-idle children kept for `rlm.collect`; each entry is a few hundred bytes. */
const CLOSED_RLM_CHILD_COLLECT_ENTRIES_MAX = 1024;

/**
 * Consecutive progress-free cycles after which waitForIdle stops waiting and reports the
 * wedge. Only consulted while nothing owns the wait (see
 * {@link AgentSession._waitForIdleBlockOwner}), so a long compaction, retry, bash or
 * pause never trips it; 16 polls is under a second of a state that cannot advance.
 */
const WAIT_FOR_IDLE_STAGNANT_CYCLE_LIMIT = 16;

/**
 * Consecutive failed pump passes after which the session input pump stops
 * rescheduling itself. The pump reschedules from its own finally, so a
 * deterministic throw would otherwise spin the microtask queue without ever
 * yielding to timers or IO - the 2026-09-19 100%-CPU wedge class. Every
 * failure is logged; a clean pass resets the streak; and external triggers
 * (admission, checkpoint changes, retry resolution) still schedule fresh
 * passes, so a transient fault heals while a persistent one goes quiet.
 */
const SESSION_INPUT_PUMP_FAILURE_LIMIT = 8;

/** One waitForIdle cycle's observable state; two equal snapshots mean the loop made no progress. */
interface WaitForIdleProgress {
	agentEventQueue: Promise<void>;
	pumpRequested: boolean;
	streaming: boolean;
	queuedActions: number;
	unfinishedActions: number;
	blockOwner: string | undefined;
}

function sameWaitForIdleProgress(left: WaitForIdleProgress, right: WaitForIdleProgress): boolean {
	return (
		left.agentEventQueue === right.agentEventQueue &&
		left.pumpRequested === right.pumpRequested &&
		left.streaming === right.streaming &&
		left.queuedActions === right.queuedActions &&
		left.unfinishedActions === right.unfinishedActions &&
		left.blockOwner === right.blockOwner
	);
}

/** Hand the turn to the event loop so timers, IO and other sessions' work get a slice. */
function nextEventLoopTurn(): Promise<void> {
	return new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function waitForIdlePoll(): Promise<void> {
	return new Promise<void>((resolve) => {
		setTimeout(resolve, WAIT_FOR_IDLE_POLL_MS);
	});
}

const IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY = "ipython_sent_agent_message";

/** Details of the session_context_loss notice; `signature` dedups re-resumes of the same damage. */
interface SessionContextLossDetails {
	/** Stable description of the defect set, so a second resume of the same damage adds no copy. */
	signature: string;
	/** One clause per defect found (bad lines, broken chain, unresolvable compaction anchor). */
	findings: string[];
}

/**
 * How many new branch entries must accumulate before a skipped or failed
 * threshold compaction retries. Prevents re-firing every turn when the context
 * cannot actually shrink (e.g. a single tool result larger than the usable window).
 */
const THRESHOLD_COMPACTION_RETRY_MIN_NEW_ENTRIES = 5;

/**
 * Failed runs of one model-requested compaction before the request is dropped
 * with a visible outcome. Every failure also arms the branch-growth cooldown, so
 * the next attempt waits for new material (or a model change) instead of burning
 * a summarization call on the same failing context at every turn boundary.
 */
const REQUESTED_COMPACTION_MAX_FAILED_ATTEMPTS = 3;

/**
 * How long a compaction may hold queued input before the session aborts it and lets
 * that input through.
 *
 * The stall watchdog cannot be this bound: it ships warn-only (`abortAfterSeconds`
 * defaults to 0) and it snoozes while a host phase owns the turn boundary, which
 * compaction does. Without a bound of its own, a gate that ranks compaction above
 * agent messages would turn one hung summarization call into a starved family - and
 * a person typing during one would wait it out with no upper bound at all.
 *
 * Caliber honesty (B2-03): this is the ONLY wall-clock bound on the compaction wire
 * call. `streamStallTimeoutMs` lives in the agent loop and never reaches
 * `completeSimple`/`streamSimple`, so the "2x the stream-stall timeout" reading is
 * about sharing one operator knob, not about stacking behind another cut - a slow
 * but healthy giant summary and a wedged stream get the same budget. Exported
 * because the matrix pins the caliber: shrinking this constant (or the stream-stall
 * default it derives from) shrinks the bound every queued input gets, and that must
 * turn a test red (B2-15).
 */
export const COMPACTION_GATE_ABORT_AFTER_SECONDS = (DEFAULT_STREAM_STALL_TIMEOUT_MS / 1000) * 2;

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

interface AgentMessageOutcome {
	delivery?: AgentMessageDeferred;
	completion?: AgentMessageDeferred;
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

/**
 * customType of the visible chat notice emitted when a non-interactive caller (a
 * daemon set_model/cycle_model command from another attached client, or the
 * extension API) switches the session model: every attached window except the
 * initiator gets a chat line instead of finding out on the next lazy footer
 * refresh. The notice rides message_start/message_end and is deliberately kept
 * out of the live context and out of the custom_message transcript form -
 * convertToLlm passes an unknown customType through to the model, so the only
 * safe homes are the event stream and a ledger-only custom entry.
 */
export { MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE } from "./messages.js";

/** Who drove a non-interactive model switch; recorded on the notice and its ledger entry. */
export type ModelChangeOriginNoticeSource = "daemon_command" | "extension";

export interface ModelChangeOriginNoticeDetails {
	provider: string;
	modelId: string;
	previousProvider?: string;
	previousModelId?: string;
	origin: ModelChangeOriginNoticeSource;
	/** Per-switch correlator the daemon uses to exempt the initiating client; wire-only, never persisted. */
	token?: string;
}

interface ModelSelectOptions {
	waitForExtensions?: boolean;
	/**
	 * Non-interactive callers (daemon set_model/cycle_model, extension API) set this
	 * so attached witnesses get the visible notice. The interactive window's own
	 * /model leaves it unset: its local status line and footer update already
	 * answered the user, and a notice would double-report.
	 */
	changeNotice?: { origin: ModelChangeOriginNoticeSource; token?: string };
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

type GoalSlashCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "pause" }
	| { kind: "resume"; tokenBudget?: number }
	| { kind: "start"; objective: string; tokenBudget?: number; persistent?: boolean };

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

export interface RetainedRlmChild {
	session: AgentSession;
	run?: RlmChildRun;
}

export interface RlmSubagentModelSelection {
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
	"model.info", // reads the model serving the current run (routed image turns included)
	"agent_message.list_agents", // reads the family roster
];
const SESSION_PERSIST_FAILURE_REPORT_BASE_MS = 30_000;
const SESSION_PERSIST_FAILURE_REPORT_MAX_MS = 300_000;
const RLM_MAX_DEPTH_STATE_CUSTOM_TYPE = "rlm_max_depth_state";
/** Minimum spacing between accepted progress notes from one child session. */
const RLM_PROGRESS_NOTE_MIN_INTERVAL_MS = 10_000;
/** How long a deferred RLM terminal notice may wait for delivery before it is abandoned. */
const RLM_TERMINAL_NOTICE_ABANDON_AFTER_MS = 5 * 60_000;

/** Consecutive retryable agent-message send failures before the error becomes terminal (M6b). */
const AGENT_MESSAGE_RETRYABLE_FAILURE_LIMIT = 3;

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

/** Label for the durable one-shot wake that backs a fallback long wait across a restart. */
const PROVIDER_LONG_WAIT_RESUME_CRON_LABEL = "provider-long-wait-resume";
/** Service tiers a persisted fallback switch may name (anything else keeps the current tier). */
const PERSISTED_SERVICE_TIERS: readonly ServiceTier[] = ["auto", "default", "flex", "scale", "priority"];

/** One run's routed image model moved along the fallback chain. */
interface ImageFallbackEpisode {
	/** The image model routing picked for the run. */
	original: Model<any>;
	/** The override now serving the run. */
	override: AgentModelOverride;
	tried: string[];
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
	_agentEventQueue: Promise<void> = Promise.resolve();

	/** Session-owned actions. Items are never fed into Agent.steer/followUp. */
	readonly _actionStore = new ActionStore<QueuedSessionAction>();
	// One-shot "all" steering batch armed by abortAndSendQueued: read on selection, never
	// consumed on read, and disarmed once the armed actions leave the steering queue.
	private _forcedAllSteeringActionIds: ReadonlySet<string> | undefined;
	private _sessionInputPump: Promise<void> = Promise.resolve();
	_sessionInputPumpRequested = false;
	// Invalidates preparation when a branch pause starts and finishes before its next await resumes.
	_sessionInputPumpEpoch = 0;
	/**
	 * Consecutive pump passes that escaped with an error; a clean pass resets it.
	 * At SESSION_INPUT_PUMP_FAILURE_LIMIT the pump stops rescheduling itself
	 * (external triggers still can) instead of spinning on a deterministic throw.
	 */
	private _sessionInputPumpFailureStreak = 0;
	private _sessionInputArrivalEpoch = 0;
	// Persists abort/restart suspension after the initiating call returns.
	_sessionInputPumpSuspended = false;
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

	_goalState: GoalState = emptyGoalState();
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
	/**
	 * Set when a manual compact() preempted an in-flight OVERFLOW recovery: the
	 * auto scope's willRetry path never ran, so the manual run owes the
	 * overflowed request its retry (strip the rebuilt error tail + schedule the
	 * continuation) when it settles. Consumed in _compact's finally.
	 */
	private _preemptedOverflowRecoveryRetry = false;
	_compactionOperation: Promise<void> | undefined = undefined;
	/** Timer that aborts a compaction holding queued input for too long. */
	// `unknown`, not `ReturnType<typeof setTimeout>`: when `stallWatchdogTimers` is
	// injected the handle belongs to that clock (a fake-clock id), not to Node.
	private _compactionGateWatchdog: unknown = undefined;
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
	/**
	 * Over-threshold nothing-to-summarize skips (W29-B10). A dedicated streak, not
	 * the failure streak: _consecutiveCompactionFailures also feeds the
	 * keepRecentTokens halving in _compactionSettingsForAttempt, and a skip must
	 * not move the next attempt's cut. A successful compaction clears both streaks
	 * (_clearCompactionFailures).
	 */
	private _consecutiveCompactionSkips = 0;
	private _continueAfterThresholdCompaction = false;
	/**
	 * Cooldown after a threshold compaction that skipped or failed, so an
	 * unshrinkable context (e.g. one tool result larger than the usable window)
	 * does not re-fire a wasted summarization attempt on every single turn.
	 * Retry once the branch grows by a few entries or the model changes.
	 */
	private _thresholdCompactionCooldown: { branchEntryCount: number; modelKey: string } | undefined;
	private _pendingRequestedCompaction: { customInstructions?: string; failedAttempts?: number } | undefined;
	_pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;

	private _branchSummaryAbortController: AbortController | undefined = undefined;
	_branchSummaryOperation: Promise<void> | undefined = undefined;

	private _retryAbortController: AbortController | undefined = undefined;
	_retryAttempt = 0;
	/**
	 * Recovery continuations spent in the current empty-response failure episode
	 * (r4 recovery): reset by any non-error assistant message, spent one per episode,
	 * and the second exhaustion in the same episode is the hard stop.
	 */
	private _emptyTurnRecoveryUsed = 0;
	/**
	 * The same per-episode budget for the provider-failure recovery: when the retry
	 * ladder is spent, the failure shape goes back to the model as one queued turn
	 * instead of the run ending silently. Reset by any non-error assistant message.
	 */
	private _providerFailureRecoveryUsed = 0;
	/**
	 * Set by the retry handler when the ladder is spent and the run would end:
	 * agent_end then queues the one-shot provider-failure recovery turn (and skips
	 * the terminal flow while it is pending), or lets the failure go terminal when
	 * the episode's recovery was already spent.
	 */
	_providerFailureRecoveryPending = false;
	/** Bumped by every retry resolution; stale scheduled-continue callbacks check it before touching retry state. */
	private _retryGeneration = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	_retryAuthFailureSources: AuthSourceToken[] = [];
	/** Ongoing wait-for-recovery state: pings issued and when the wait started. */
	_providerWait: { attempts: number; startedAtMs: number } | undefined = undefined;
	/**
	 * Quota park state: the session ended its turn because the provider-reported
	 * usage reset was beyond the bounded wait, and a wake (in-process timer plus
	 * a durable one-shot scheduled job) will resume the task automatically. While
	 * parked the session itself makes no model calls.
	 */
	_quotaPark:
		| {
				/** Parks consumed in this quota episode; bounded by waitForUsage.maxParks. */
				parkCount: number;
				/** Wall-clock wake time for the current park. */
				resumeAtMs: number;
				/**
				 * Provider-reported quota reset the park waits on. resumeAtMs moves on
				 * wake re-arms (it drives the wake schedule); this stays at the real
				 * reset so re-arm entries can keep reporting it as quotaResumeAt.
				 */
				quotaResumeAtMs?: number;
				/** Id of the durable one-shot wake job, when the session persists artifacts. */
				jobId?: string;
				/** Pending in-process wake timer for the current park. */
				timer?: ReturnType<typeof setTimeout>;
				/** True from the wake until the park state clears (the resume probe is running). */
				waking?: boolean;
				/** Wake re-arms consumed without a resume; bounded by QUOTA_WAKE_MAX_RETRIES. */
				wakeRetries?: number;
				/** Provider whose quota reset the park waits on; carried onto re-arm entries. */
				provider?: string;
		  }
		| undefined = undefined;
	/** Lazily built session-artifact store for durable quota-resume wake jobs. */
	_quotaResumeJobStore: AgentCronJobStore | undefined = undefined;
	/** Wake jobs branch navigation cancelled, so returning to the parked branch can rebuild one. */
	readonly _navigationCancelledWakeJobs = new Set<string>();
	/** Set while turns are routed to the user-configured backup model. */
	private _backupModel:
		| {
				backup: Model<any>;
				primary: Model<any>;
				thinkingLevel: ThinkingLevel;
				serviceTier: ServiceTier;
				/** Image-model routing active when the backup took over; restored on return. */
				routedOverride?: AgentModelOverride;
		  }
		| undefined = undefined;
	/**
	 * Set while the session runs on a fallback-chain model. Unlike the backup
	 * model it stays after a success; the primary is probed again once
	 * PROVIDER_FALLBACK_RETURN_AFTER_MS has passed.
	 */
	private _fallback:
		| {
				primary: Model<any>;
				thinkingLevel: ThinkingLevel;
				serviceTier: ServiceTier;
				current: Model<any>;
				switchedAtMs: number;
				/** `provider/id` of every model this episode already moved to. */
				tried: string[];
		  }
		| undefined = undefined;
	/**
	 * Set while one run's routed image model was moved along the fallback chain. Only
	 * the run's override moves: the session model the owner chose never failed. The
	 * next dispatch routes afresh, which makes this stale (its override is no longer
	 * the agent's).
	 */
	private _imageFallback: ImageFallbackEpisode | undefined = undefined;
	/** Long-wait rounds spent after every model of the chain failed (reset on success). */
	private _fallbackLongWaitRound = 0;
	/** Durable wake of the long wait in progress, cancelled once the in-process wait ends. */
	private _fallbackLongWaitJobId: string | undefined = undefined;
	/** Chain entries already reported as unusable, so each is reported once per session. */
	private readonly _reportedUnusableFallbackReferences = new Set<string>();
	/** Content-inspection recovery steps spent on the current failure (reset on success). */
	private _inspectionRecoverySteps = 0;
	/** Consecutive invalid tool calls from the serving model in the current run. */
	private _badToolCallStreak = 0;
	/** Arguments of in-flight tool calls, for the empty-argument half of the storm check. */
	private readonly _toolCallArgs = new Map<string, unknown>();
	private _agentMessageClearEpoch = 0;
	private _agentMessageOutcomes = new Map<string, AgentMessageOutcome>();
	/**
	 * Child replies this session queued but has not delivered yet. Delivery credits
	 * the sender's reply count, which a `queued` receipt deliberately did not (B1).
	 */
	readonly _queuedChildReplyBackfills = new QueuedParentReplyBackfills();
	private _lateIpythonSentAgentMessages = new Map<string, KernelSentAgentMessage[]>();
	/** Outcome disclosures whose session-file append failed; retained for context rebuilds. */
	readonly _unpersistedOutcomes: CustomMessage[] = [];
	/**
	 * Fresh/empty contexts defer digest injection to the first committed turn, so an
	 * untouched session keeps reading as empty to every raw message-count check
	 * (draft cleanup, daemon session list, branch seedability, hasExistingSession).
	 */
	_harnessDigestPending = false;
	/** Store stamps as of the last digest render; unchanged stamps skip the render entirely. */
	_harnessDigestStamps: HarnessStoreStamps | undefined;
	/** Entry identity as of the last digest render, for the material-change difference. */
	_harnessDigestFingerprint: Map<string, number> | undefined;
	/**
	 * Tool-face identity as of the last system-prompt rebuild (OBS-2). The digest's
	 * call-contract wording follows the render flags, and a mid-session tool change
	 * rebuilds the prompt without moving either store stamp, so the material-change
	 * gate on its own would never notice.
	 */
	_harnessDigestRenderFlagsKey: string | undefined;
	/**
	 * Entry keys this session already itemized for the model in a refinement receipt
	 * (applied and refused), so a digest delta does not deliver the same news twice.
	 */
	readonly _refinementReportedEntryVersions = new Map<string, number>();
	private _bashAbortControllers = new Set<AbortController>();
	private _userBashRunning = false;
	private _userBashAbortRequested = false;
	private _pendingBashMessages: BashExecutionMessage[] = [];
	/**
	 * Model-change notices recorded while a run is streaming. Pushed at the next
	 * tool-batch boundary (turn_end) instead of mid-batch: an immediate push lands
	 * between an assistant tool call and its tool result, and the next request
	 * then pairs them wrong (the model re-runs the tool whose result it never
	 * saw). The durable model_change ledger entry is still written at once; this
	 * queue holds only the live-context notice. Same deferral shape as
	 * _pendingBashMessages.
	 */
	private _pendingModelChangeMessages: ModelChangeMessage[] = [];

	_extensionRunner!: ExtensionRunner;
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
	_agentMessageController?: AgentSessionMessageController;
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
	_disposed = false;
	private readonly _disposeCallbacks = new Set<() => void | Promise<void>>();
	private _disposeCallbacksPromise?: Promise<void>;
	// Set at the start of async teardown so a child finishing mid-disposeAsync doesn't
	// re-populate the retained map after it's been cleared.
	_disposing = false;
	private _disposeAsyncPromise?: Promise<void>;
	_ipythonKernelProvisioner?: IpythonKernelProvisioner;
	/** Artifact dir backing the current provisioner's kernel snapshot, if any. */
	private _ipythonKernelSnapshotDir?: string;
	/** True once the runtime has been built once; later builds are in-process rebuilds (/reload). */
	private _ipythonRuntimeBuilt = false;
	private readonly _prewarmIpythonKernel: boolean;
	_rlmDepth: number;
	private readonly _configuredRlmMaxDepth: number | undefined;
	_rlmMaxDepth: number;
	private _rlmMaxDepthSource: RlmMaxDepthSource;
	/** Cap on simultaneously live children; 0 disables it (SC-1). */
	readonly _rlmMaxConcurrentChildren: number;
	/**
	 * Ceiling an ancestor imposed on this session *after* it was admitted (SC-2). A child
	 * snapshots its parent's cap at spawn; a later reduction on the ancestor would otherwise
	 * leave the in-flight subtree spawning at the old, wider cap. This is that live push, and
	 * it is deliberately tracked (not ratcheted): an ancestor that widens its cap again pushes
	 * the wider value, so a subtree can never get stuck behind an invisible limit.
	 */
	private _rlmMaxDepthCeiling: number | undefined;
	_rlmSessionDir?: string;
	/** True when `_rlmSessionDir` is this session's own `prime-agent-rlm-*` tmpdir (RC-6). */
	private _rlmSessionDirEphemeral = false;
	readonly _semanticEdges: SemanticEdgeRecorder;
	_rlmParentNodeId?: string;
	private _rlmParentAgent?: string;
	_repliedToParentSinceTask: boolean | undefined;
	_parentReplyCount = 0;
	/**
	 * Stall-watchdog abort facts for the turn in flight, if the watchdog fired.
	 * `settled` flips false when the watchdog reports abort_unsettled, so a run
	 * that was never stopped is not reported as killed.
	 */
	_lastStallAbort: RlmChildStallAbortFacts | undefined;
	/**
	 * Live stall marker for roster rows: set when the watchdog reports a stage,
	 * cleared by the next agent_start. Published so a daemon can put a wedged
	 * session's silence on its summary row even when the parent that spawned it
	 * lives in another worker.
	 */
	_stallState: RlmChildStallState | undefined;
	/**
	 * Turns this session has started (r4 recovery-shell). Incremented on every
	 * agent_start; the stall-recovery executor uses it to scope "exactly one
	 * auto action per (session, turn)": a claim keyed by this epoch stops
	 * matching the moment a new turn begins, so a recovered session that stalls
	 * again in a later turn is a new episode, never a skipped or repeated one.
	 */
	_turnLifecycleEpoch = 0;
	/** Why the last abort of this session was requested; cleared by the next agent_start. */
	_lastTurnAbortReason: RlmChildTurnAbortReason | undefined;
	/** The child already delivered its own terminal-error notice to the parent. */
	_terminalErrorNoticeDelivered = false;
	/**
	 * Message id of this session's terminal-error notice while it sits in the
	 * parent's queue. The send receipt said `queued`, so B1 keeps
	 * `_terminalErrorNoticeDelivered` false; the parent's delivery credit names the
	 * id it just delivered, which is how this session learns the report did land.
	 */
	_queuedTerminalErrorNoticeMessageId: string | undefined;

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
	_terminalFailureAttemptCount = 0;
	_subagentRuntimeHost?: SubagentRuntimeHost;
	_activeRlmChildRuns = new Map<string, RlmChildRun>();
	/**
	 * Runs whose child was deleted or released, newest last. A terminal notice about
	 * such a child is still published after it is gone (the queue drains later), and
	 * re-validating it needs the run's delivery record: without it a reply that did
	 * land reads as missing and the parent is woken by a false "no reply" notice.
	 */
	readonly _retiredRlmChildRuns = new Map<string, RetiredRlmChildRun>();
	/** Wall-clock ms of the last accepted progress note; throttles rlm.progress.note. */
	private _lastRlmProgressNoteAt: number | undefined;
	_unsettledRlmChildRuns = new Set<RlmChildRun>();
	_abandonedRlmQuiescenceChildIds = new Set<string>();
	_rlmQuiescenceWaitAborts = new Set<AbortController>();
	_pendingRlmSubagentSessionNames = new Set<string>();
	/**
	 * Cap slots held by spawns between the live-children check and the run's
	 * registration (the admission round-trip is async). Counted by the
	 * `_rlmMaxConcurrentChildren` gate so parallel spawns cannot both pass it on
	 * the same pre-admission count.
	 */
	readonly _pendingRlmChildAdmissions = new Set<string>();
	/**
	 * Every child session name this session has ever admitted or learned of
	 * (deleted and idle-closed bearers included). The timeline keys a child's
	 * dispatch row, lane and return rows by name, so a re-spawn wearing the exact
	 * name of a child the transcript still shows would merge into that child's
	 * rows: the successor takes a numbered name instead. Seeded lazily from the
	 * transcript's spawn records so a re-opened session numbers re-spawns of
	 * children a previous process deleted.
	 */
	private readonly _rlmHistoricalChildNames = new Set<string>();
	private _rlmHistoricalChildNamesSeeded = false;
	// Inline mode keeps finished child sessions so the inspector can still read them;
	// the daemon does the same by leaving the child session resident in its registry.
	_rlmChildSessions = new Map<string, RetainedRlmChild>();
	_deletedRlmChildIds = new Set<string>();
	/**
	 * Terminal children `pruneRlmSubagents` retired from every roster view. The mark
	 * hides the row only: collect keeps the result, deletion still resolves through
	 * the full registry view, and a retained session stays resident for the daemon's
	 * idle passivation. Re-registration (a follow-up re-engaging the child) clears it.
	 */
	readonly _prunedRlmChildIds = new Set<string>();
	// Failed explicit deletes stay hidden from listings but retain their original
	// selector so a later delete can retry cleanup without orphaning the runtime.
	_rlmChildCleanupFailures = new Map<string, RlmSubagentRegistryEntry>();
	_deletingRlmChildren = new Map<
		string,
		{
			subagent: RlmSubagentRegistryEntry;
			promise: Promise<RlmDeleteSubagentResult>;
		}
	>();
	// Kept alive for retained children so nested updates (e.g. a grandchild cancel)
	// still forward to root; torn down when the retained child is disposed.
	_rlmChildUnsubscribes = new Map<string, () => void>();
	/**
	 * What `rlm.collect` reports for a finished child the daemon closed after it sat
	 * idle. Closing drops the child from both live maps, but its result is still the
	 * parent's to read: collect promises a completed child keeps its result until it
	 * is deleted. Bounded, oldest dropped first.
	 */
	readonly _closedRlmChildCollectEntries = new Map<string, ClosedRlmChildCollectEntry>();
	/** A full collect already asked the daemon for children closed before this session object existed. */
	_closedRlmChildrenDaemonScanned = false;
	/** Per retained child: watches follow-up turns the parent started for a missing reply. */
	readonly _rlmChildFollowUpWatches = new Map<string, RlmChildFollowUpWatch>();
	/**
	 * Messages from the parent this session has admitted (spawn task excluded). The
	 * parent's follow-up watch compares it against the count it last reported on, so
	 * one follow-up that ends without a reply is reported once, not once per turn.
	 */
	_parentFollowUpCount = 0;
	/** Latest recap for this session, written by the daemon summarizer; read by a parent to label its child snapshots. */
	private _currentRecap?: string;

	_modelRegistry: ModelRegistry;

	_toolRegistry: Map<string, AgentTool> = new Map();
	private readonly _warnedToolNameConflicts = new Set<string>();
	private readonly _notifiedToolNameConflicts = new Set<string>();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	_assistantTurnsSinceAutoRefine = 0;
	_lastAutoRefineReviewAt = 0;
	_autoRefineInProgress = false;
	readonly _autoRefineOperations = new Set<Promise<void>>();
	readonly _scheduledAutoRefineTimers = new Set<ReturnType<typeof setTimeout>>();
	_stallWatchdog: StallWatchdog | undefined;
	readonly _stallAbortSettleGraceMs: number | undefined;
	/** Minimum spacing between a persistent goal's automatic continuations. */
	private readonly _persistentGoalMinContinuationIntervalMs: number;
	/** When the last goal continuation was handed out; the throttle's clock. */
	private _goalContinuationLastAt: number | undefined;
	/** The one pending wake a throttled persistent-goal continuation may hold. */
	private _goalContinuationWakeTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * The abort signal of the run the last continuation poll served. The loop hands
	 * back the products of a poll its abort beat; `aborted` on this signal is how
	 * the handback knows the run was stopped rather than merely outraced.
	 */
	private _continuationPollSignal: AbortSignal | undefined;
	/**
	 * The spend behind the most recently produced goal continuation, for repaying
	 * it when the run's abort keeps the continuation from ever being delivered.
	 * Overwritten by each production; identity-matched on handback, and a
	 * delivered continuation is never handed back, so a stale record cannot match.
	 */
	private _goalContinuationHandout:
		| {
				messages: readonly AgentMessage[];
				previousGoal: GoalState;
				previousAccountingStartedAt: number | undefined;
				previousContinuationLastAt: number | undefined;
		  }
		| undefined;
	/** Injected watchdog timers; undefined means real timers (production). */
	readonly _stallWatchdogTimers: StallWatchdogTimers | undefined;
	/** Aggregates the kernel/host facts the watchdog's vouch samples (T1-3). */
	_turnLiveness: TurnLiveness | undefined;
	readonly _stallKernelLivenessFacts: (() => TurnLivenessKernelFacts | undefined) | undefined;
	readonly _stallJournaledBashHandles: ((kernelPid: number | undefined) => JournaledBashFacts | undefined) | undefined;
	readonly _stepCpuProbe: (() => number | undefined) | undefined;
	/** Kernel residency facts override for the eviction-facing activity term; defaults to the kernel client. */
	private readonly _kernelResidencyFacts: (() => KernelResidencyFacts | undefined) | undefined;
	/** Predicate names that already logged a failure this turn (one line per turn, not per sample). */
	readonly _stallPredicateFailures = new Set<string>();
	/** Turn-liveness event kinds already logged this turn (the degraded path must stay countable). */
	readonly _turnLivenessLogged = new Set<string>();
	/**
	 * Why the watchdog aborted the turn, for the ipython tool's aborted-cell report. Cleared by the
	 * next agent_start so a new turn never inherits an old cause. Distinct from `_lastStallAbort`,
	 * which is the roster/terminal-classifier record and deliberately outlives the turn.
	 */
	_lastStallAbortCause: IpythonAbortCause | undefined;
	private readonly _rlmTerminalNoticeAbandonAfterMs: number;
	private readonly _failureWakeQuietWindowMs: number;
	_stallLastEvent: { type: string; at: number } | undefined;
	readonly _stallInFlightTools = new Map<string, { toolName: string; startedAt: number }>();
	/** Per in-flight call: its arguments and when it last produced output, for the silent-step rule. */
	readonly _stepOutputWatch = new Map<
		string,
		{
			toolName: string;
			args: unknown;
			startedAt: number;
			lastOutputAt: number;
			movementToken?: string;
			cpuMs?: number;
		}
	>();
	/** Steps stopped as stuck in this run, keyed by their description. */
	readonly _stuckStepsThisRun = new Map<string, number>();
	/**
	 * Why the deadline verdict just stopped a call, read once by the cancellation text: a silent
	 * step, or a busy one that outran the exemption budget of an owner-armed watchdog abort.
	 */
	readonly _stepStopCauses = new Map<
		string,
		{ kind: "silent" } | { kind: "time_limit"; budgetMs: number; usedMs: number }
	>();
	/** Direct child runs an in-flight `collectRlmChildren` wait is blocked on, with a count per wait. */
	readonly _rlmCollectWaits = new Map<RlmChildRun, number>();
	_compactAutoRefinePending = false;
	_turnIntervalAutoRefinePending = false;
	_postCompactionContinuationScheduled = false;
	private _postCompactionContinuationSettlement: PostCompactionContinuationSettlement | undefined;
	private _postCompactionContinuationMessages: AgentMessage[] = [];
	private _scheduledPostCompactionContinuationMessages: AgentMessage[] = [];
	private _queuedAutonomousThresholdContinuations = new WeakMap<AssistantMessage, AgentMessage>();
	private _queuedAutonomousContinuationSnapshots = new WeakMap<AgentMessage, AutonomousRuntimeSnapshot>();
	private _pendingThresholdCompactionAutonomousMessages: AgentMessage[] = [];
	private _queuedGoalThresholdContinuation: AgentMessage | undefined;
	_pendingAutoRefineReview: { reason: AutoRefineReason; review: AutoRefineReview } | undefined;
	_autoRefineBranchVersion = 0;
	_autoRefineReviewAbort?: AbortController;
	_autoRefineWritableProbe?: { at: number; allowed: boolean };
	_refineAbortController?: AbortController;
	readonly _autoRefineReviewer?: AutoRefineReviewer;
	readonly _serializedRefine: boolean;
	_refineInFlight?: Promise<void>;
	_refinePlanInFlight?: Promise<void>;
	_serializedPlanInFlight?: Promise<SerializedBackgroundPlanResult | undefined>;
	_serializedPlanClaim?: Promise<void>;
	_serializedExplicitRefineOptions?: {
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
		this._persistentGoalMinContinuationIntervalMs =
			config.persistentGoalMinContinuationIntervalMs ?? PERSISTENT_GOAL_MIN_CONTINUATION_INTERVAL_MS;
		this._stallWatchdogTimers = config.stallWatchdogTimers;
		this._stallKernelLivenessFacts = config.stallKernelLivenessFacts;
		this._stallJournaledBashHandles = config.stallJournaledBashHandles;
		this._stepCpuProbe = config.stepCpuProbe;
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
		this._restoreQuotaPark();
		this._restoreFallbackEpisode();
		if (this._goalState.status === "active") {
			this._goalAccountingStartedAt = Date.now();
		}

		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentTurnHook();
		this._installAgentContinuationHook();
		this._installImageRouteContextHook();
		this._refreshAgentLoopRuntimeSettings();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});

		this._turnLiveness = createSessionTurnLiveness(this);
		this._stallWatchdog = createSessionStallWatchdog(this);
		// A restart of the same session picks up whatever the previous process could
		// not deliver (B10: every in-memory queue answers "where is it after a
		// restart"). No-op when the session dir holds no sidecar.
		this._reflowUndeliveredRlmNotices();
		// After reflow on purpose: reflow pushes messages, and the empty-context test
		// below must see the session the way the rest of the constructor left it.
		this._ensureHarnessDigestContext();
		this._discloseContextLossOnLoad();
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

	async _getRequiredRequestAuth(model: Model<any>): Promise<{
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
		this.agent.onUndeliveredMessages = (messages, source) => this._handBackUndeliveredMessages(messages, source);
	}

	/**
	 * The loop hands back products a poll already spent but the run never consumed
	 * (the abort won the race, or the run died first). The Agent default re-queues
	 * everything; here, continuation products of an aborted run are regenerable -
	 * the next turn's poll re-derives them from live state - so re-queueing only
	 * resurfaces a stale continuation after the owner's next prompt. Drop them and
	 * repay the goal continuation spend that produced them. Steering and follow-up
	 * products are the owner's words: keep the default.
	 */
	private _handBackUndeliveredMessages(messages: AgentMessage[], source: UndeliveredMessageSource): void {
		if (source === "continuation" && this._continuationPollSignal?.aborted === true) {
			this._repayUndeliveredGoalContinuation(messages);
			return;
		}
		if (source === "steering") this.agent.steer(messages);
		else this.agent.followUp(messages);
	}

	/** Repay the continuation spend when the handed-back batch is the one the goal poll produced. */
	private _repayUndeliveredGoalContinuation(messages: AgentMessage[]): void {
		const handout = this._goalContinuationHandout;
		if (!handout) return;
		if (!handout.messages.some((message) => messages.includes(message))) return;
		this._goalContinuationHandout = undefined;
		this._setGoalState(handout.previousGoal);
		this._goalAccountingStartedAt = handout.previousAccountingStartedAt;
		this._goalContinuationLastAt = handout.previousContinuationLastAt;
	}

	/**
	 * Re-resolve the loop-facing retry and deadline knobs from live settings (r4
	 * recovery). The four rollback handles - `retry.emptyTurn.escalatedAttempts: 0`,
	 * `retry.emptyTurn.recovery.enabled: false`, `tools.timeout.enabled: false`, and
	 * `tools.timeout.afterMs: 0` - must take effect on the next turn without a daemon
	 * restart, so every run dispatch rebuilds them: the input pump, the post-compaction
	 * continuation, and the delayed retry each call this before handing the agent a
	 * turn.
	 */
	private _refreshAgentLoopRuntimeSettings(): void {
		this.agent.emptyTurnRetry = this.settingsManager.getEmptyTurnRetrySettings();
		this.agent.toolTimeout = resolvedToolTimeoutConfig(this);
		this.agent.toolNotFoundBreaker = this.settingsManager.getToolNotFoundBreakerSettings();
		this._configureCrossLayerRequestBudget();
	}

	private _installAgentTurnHook(): void {
		this.agent.shouldStopBeforeTurn = () => this._shouldStopBeforeTurn();
		this.agent.shouldStopAfterTurn = (context) => this._shouldStopAfterTurn(context);
	}

	_emit(event: AgentSessionEvent): void {
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
	_reportSessionPersistFailure(error: unknown): void {
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
	_effectiveRlmMaxDepth(): number {
		return this._rlmMaxDepthCeiling === undefined
			? this._rlmMaxDepth
			: Math.min(this._rlmMaxDepth, this._rlmMaxDepthCeiling);
	}

	/**
	 * Apply an ancestor's live cap. Deliberately tracked rather than ratcheted: a widening push
	 * must lift the ceiling again, or a subtree would stay confined by a limit nobody can see.
	 * Nothing is rebuilt when the effective cap is unchanged, so idempotent pushes stay cheap.
	 */
	_applyRlmMaxDepthCeiling(maxDepth: number): void {
		const previousEffective = this._effectiveRlmMaxDepth();
		this._rlmMaxDepthCeiling = maxDepth;
		if (this._effectiveRlmMaxDepth() === previousEffective) return;
		const oldBase = this._baseSystemPrompt;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._refreshExtensionSystemPrompt(this.agent.state.systemPrompt, oldBase);
		this._pushRlmMaxDepthToChildren();
	}

	/** Admitted children that have not settled yet - the population SC-1 bounds. */
	_liveRlmChildRunCount(): number {
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
		// A cancelled selected/preparing action may be the pump's in-flight
		// preselected batch head; the pump re-reads the store when the epoch moves,
		// so every cancel path moves it (the pump also re-checks the action's own
		// state before driving it, as a second line of defense).
		if (
			actions.some((action) => {
				const previous = previousStates.get(action.id);
				return previous === "selected" || previous === "preparing";
			})
		) {
			this._sessionInputPumpEpoch++;
		}
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
							// Prefix records are parked next-turn context the action captured
							// on admission; a cancelled turn hands them back, like the
							// admission-rejection and dispatch-failure paths already do.
							(record.role === "next_turn" || record.role === "prefix") &&
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

	private _startGoal(objectiveText: string, tokenBudget: number | undefined, persistent?: boolean): GoalState {
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
		if (persistent) goal.persistent = true;
		this._goalAccountingStartedAt = now;
		this._goalContinuationAwaitsRlmWork = false;
		// A new goal starts with a clean throttle clock: inheriting the previous
		// goal's last-continuation timestamp would throttle this goal's first
		// continuation by however much of the interval is left, and a wake armed
		// for the old goal would fire into this one.
		this._goalContinuationLastAt = undefined;
		this._clearGoalContinuationWake();
		this._setGoalState(goal);
		return this._goalState;
	}

	/** Disarm the throttled persistent-goal continuation's pending wake, if any. */
	private _clearGoalContinuationWake(): void {
		if (this._goalContinuationWakeTimer !== undefined) {
			clearTimeout(this._goalContinuationWakeTimer);
			this._goalContinuationWakeTimer = undefined;
		}
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

	private async _resumeGoal(tokenBudget?: number): Promise<void> {
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
		// A spent token budget cannot be resumed into: the goal would re-limit on
		// the first continuation and the "resumed" promise would be a lie. The owner
		// extends the budget explicitly, or clears the goal.
		if (exhausted && tokenBudget === undefined) {
			throw new Error(
				`Goal token budget already reached (${this._goalState.tokensUsed}/${this._goalState.tokenBudget} tokens). Extend it with /goal resume --budget <tokens>, or clear the goal with /goal clear.`,
			);
		}
		if (tokenBudget !== undefined && tokenBudget <= this._goalState.tokensUsed) {
			throw new Error(
				`Goal token budget must exceed the tokens already used (${this._goalState.tokensUsed}); got ${tokenBudget}.`,
			);
		}
		this._setGoalState({
			...this._goalState,
			active: true,
			status: "active",
			tokenBudget: tokenBudget ?? this._goalState.tokenBudget,
			lastReason: undefined,
			lastError: undefined,
		});
		await this._runOrQueueGoalContext("continuation");
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
			// A live quota park owns the resume: the parked turn is the park's
			// pause, not the goal's death, so the goal survives until the wake
			// (or a spent park budget, which clears the park first) ends it.
			if (this._quotaPark !== undefined) {
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
		if (normalized.startsWith("resume ")) {
			// The one resume parameter: a new token budget, for a goal that stopped at
			// its old one. Anything else is a usage error, not a silent ignore.
			const args = rest.slice("resume ".length).trim();
			const separator = args.indexOf("=");
			let valueText: string | undefined;
			if (separator > 0 && (args.startsWith("--budget=") || args.startsWith("--token-budget="))) {
				valueText = args.slice(separator + 1);
			} else if (args.startsWith("--budget ") || args.startsWith("--token-budget ")) {
				valueText = args.slice(args.indexOf(" ") + 1).trim();
			}
			if (valueText === undefined) {
				throw new Error("Usage: /goal resume [--budget <tokens>]");
			}
			return { kind: "resume", tokenBudget: parseGoalBudgetValue(valueText) };
		}

		const persistentParse = parseGoalPersistentFlag(rest);
		const persistent = persistentParse.persistent;
		const goalArgs = persistentParse.rest;

		let tokenBudget: number | undefined;
		let objective = goalArgs;
		const firstToken = goalArgs.split(/\s+/, 1)[0] ?? "";
		if (
			firstToken === "--budget" ||
			firstToken === "--token-budget" ||
			firstToken.startsWith("--budget=") ||
			firstToken.startsWith("--token-budget=")
		) {
			let valueText: string;
			if (firstToken === "--budget" || firstToken === "--token-budget") {
				const withoutFlag = goalArgs.slice(firstToken.length).trimStart();
				const nextSpace = withoutFlag.search(/\s/);
				if (nextSpace < 0) {
					throw new Error("Usage: /goal [--persistent] [--budget <tokens>] <objective>");
				}
				valueText = withoutFlag.slice(0, nextSpace);
				objective = withoutFlag.slice(nextSpace + 1).trim();
			} else {
				const separator = firstToken.indexOf("=");
				valueText = firstToken.slice(separator + 1);
				objective = goalArgs.slice(firstToken.length).trim();
			}
			tokenBudget = parseGoalBudgetValue(valueText);
		}

		return {
			kind: "start",
			objective: validateGoalObjective(objective),
			tokenBudget,
			persistent,
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

	/** Whether the batch committed for the current run carried image content. */
	_dispatchedBatchCarriedImages = false;
	/** Whether a tool result delivered during the current run attached image content. */
	_runToolResultsCarriedImages = false;
	/** Whether the current run already emitted an image-delivery suspicion notice. */
	_imageDeliverySuspicionNotified = false;

	/** Context-only image routes already spent on a picture, so a failing image model gives up. */
	readonly _imageLookAttempts = new WeakMap<AgentMessage, number>();

	/** Replies a routed image model gave that put the images into words (the handback trigger). */
	readonly _imageDescriptions = new WeakSet<AssistantMessage>();

	/**
	 * The image routing of the current run: the override it was dispatched with, the
	 * image message it was routed for, how many requests the image model served since,
	 * and whether the run has already been handed back to the session model.
	 */
	_imageRoute:
		| {
				override: AgentModelOverride;
				handedBack: boolean;
				handback?: AgentModelOverride;
				anchor: AgentMessage | undefined;
				requests: number;
		  }
		| undefined;

	private _imageRouteForTurns(
		turns: SessionAction<PreparedTurnPayload>[],
		extraMessages: AgentMessage[] = [],
	): ImageRouteDecision | undefined {
		return imageRouteForTurns(this, turns, extraMessages);
	}

	private _imageModelRoutingInputs(sessionModel: Model<any>): ImageModelRoutingInputs {
		return imageModelRoutingInputs(this, sessionModel);
	}

	private _beginImageRoute(route: ImageRouteDecision | undefined): void {
		beginImageRoute(this, route);
	}

	private _installImageRouteContextHook(): void {
		installImageRouteContextHook(this);
	}

	private _routeImagesOnAgentEvent(event: AgentEvent): void {
		routeImagesOnAgentEvent(this, event);
	}

	private _runModel(): Model<any> | undefined {
		return runModel(this);
	}

	private _maybeNoticeImageDeliverySuspicion(message: AssistantMessage): void {
		maybeNoticeImageDeliverySuspicion(this, message);
	}

	/**
	 * Whether a dispatched turn is still in flight: streaming, retrying with
	 * backoff, compacting before a continuation, an overflow recovery or
	 * provider wait still settling, or a post-compaction continuation that
	 * has been scheduled but not yet dispatched. Model selection during any
	 * of these must not tear down a routed run's override, or the run's
	 * retries, continuations, and failure attribution would leave the
	 * image-capable model mid-turn.
	 */
	private get _hasActiveTurnLifecycle(): boolean {
		return (
			this.isStreaming ||
			this.isRetrying ||
			this.isCompacting ||
			this._postCompactionContinuationScheduled ||
			// Covers the whole submission-to-settled window: preflight (before the
			// action enqueues), the queued turn, and any in-flight run - without
			// latching on stale overflow-recovery state.
			this._promptSubmissionInFlight ||
			this._hasPendingOrRunningTurnAction
		);
	}

	private get _hasPendingOrRunningTurnAction(): boolean {
		return this._actionStore.unfinishedActions().some((action) => action.payload.kind === "turn");
	}

	/**
	 * An explicit selection wins over image-model routing still lingering from
	 * the last dispatched turn, but not over the model already serving an
	 * active run. Cycling or switching mid-stream keeps the routed override
	 * until the turn settles; the next dispatch re-evaluates the routing
	 * against the new selection.
	 */
	private _clearModelOverrideWhenIdle(): void {
		if (this._hasActiveTurnLifecycle) return;
		this.agent.modelOverride = undefined;
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

	_maybeResumeGoalContinuationAfterRlmWork(): void {
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
	_maybeResumeAutonomousContinuationAfterRlmWork(): void {
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
		this._recordAutonomousContinuationDutyEvent(message);
		this._clearAutonomousContinuationAwait();
	}

	/**
	 * Mark a continuation prompt /autonomous sent. It lands in the transcript as a user message, and
	 * the duty log would otherwise read it as the owner coming back.
	 */
	private _recordAutonomousContinuationDutyEvent(message: UserMessage): void {
		const text = normalizeMessageContent(message.content).text;
		this._recordDutyEvent({ kind: "autonomous_continue", prompt: autonomousPromptFingerprint(text) });
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
			// Front insertion only holds while nothing can be admitted ahead of it.
			priority: "pinned",
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
			await this._resumeGoal(command.tokenBudget);
			return true;
		}

		const previousWasActive = this._goalState.status === "active";
		if (!this.isStreaming) {
			await this._validateCanStartAgentRun();
		}
		this._ensureGoalRuntimeActive();
		this._clearQueuedGoalContexts();
		this._startGoal(command.objective, command.tokenBudget, command.persistent);
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
		this._dropSpentRequestedCompaction();
		const requestedReady =
			this._pendingRequestedCompaction !== undefined &&
			!this._isThresholdCompactionCoolingDown(this._sessionContextWindow());
		if (!requestedReady && !(await this._thresholdCompactionNeeded(context))) {
			return false;
		}

		const lastMessage = this.agent.state.messages[this.agent.state.messages.length - 1];
		// A queued continuation disproves the assistant-last "task finished" heuristic, so preserve a true set above.
		this._continueAfterThresholdCompaction ||= lastMessage !== undefined && lastMessage.role !== "assistant";
		return true;
	}

	async _runSerializedRefineCheckpoint(): Promise<void> {
		return runSerializedRefineCheckpoint(this);
	}

	async _runSerializedRefineCheckpointAfterBackground(branchVersion: number): Promise<void> {
		return runSerializedRefineCheckpointAfterBackground(this, branchVersion);
	}

	async _runSerializedAutoRefineReview(reason: "compact" | "turn_interval", branchVersion: number): Promise<void> {
		return runSerializedAutoRefineReview(this, reason, branchVersion);
	}

	async _consumeSerializedBackgroundPlan(
		consume: (result: SerializedBackgroundPlanResult | undefined) => Promise<boolean>,
	): Promise<"none" | "waited" | "continue" | "stop"> {
		return consumeSerializedBackgroundPlan(this, consume);
	}

	async _applySerializedPlan(bgResult: Extract<SerializedBackgroundPlanResult, { status: "plan" }>): Promise<void> {
		return applySerializedPlan(this, bgResult);
	}

	_maybeStartSerializedBackgroundPlan(): void {
		maybeStartSerializedBackgroundPlan(this);
	}

	async _runBackgroundPlan(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
		branchVersion: number,
		skipReview = false,
	): Promise<SerializedBackgroundPlanResult | undefined> {
		return runBackgroundPlan(this, options, refineAbort, branchVersion, skipReview);
	}

	async _runSerializedRefine(
		options: {
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		},
		trigger: "manual" | "auto" = "manual",
	): Promise<void> {
		return runSerializedRefine(this, options, trigger);
	}

	/** Automatic compaction triggers read the per-model switch (the bare enabled
	 * flag is the default for models without an entry). Manual /compact is
	 * unaffected: it flows through the pending-request clause, not this gate. */
	private _compactionEnabledForCurrentModel(): boolean {
		const model = this.model;
		return this.settingsManager.getCompactionEnabledForModel(model ? `${model.provider}/${model.id}` : undefined);
	}

	private async _thresholdCompactionNeeded(context: ShouldStopAfterTurnContext): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!this._compactionEnabledForCurrentModel()) return false;

		const contextWindow = this._sessionContextWindow();
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
				const preparationOutcome = prepareCompactionOutcome(
					this.sessionManager.getBranch(),
					this.settingsManager.getCompactionSettings(),
					this.model ? this._sessionContextWindow() : undefined,
					this._compactionWindowLimits(),
				);
				if (preparationOutcome.kind === "skip") {
					return {
						scheduled: false,
						reason: compactionSkipMessage(preparationOutcome.reason),
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

	handleRefineHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		return handleRefineHostRequest(this, type, payload);
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
		| Promise<
				| AgentSessionMessageListResult
				| AgentSessionMessageReceipt
				| AgentFamilyRosterResult
				| AgentSessionMessageAbortReceipt
		  >
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
			case "agent_message.abort": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_message.abort target must be a string");
				}
				const target = assertDirectAgentMessageTarget(payload.target);
				const sendQueued = payload.send_queued !== false;
				const controller = this._agentMessageController;
				if (!controller.abortAgentMessage) {
					throw new Error("agent abort is not available in this session");
				}
				return controller.abortAgentMessage({ target, sendQueued });
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
		if (this._goalState.persistent && this._goalState.status === "active") {
			throw new Error(persistentGoalCompletionRejection(this._goalState));
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
		if (
			this._goalState.status !== "active" ||
			this._goalState.continuationsUsed < goalContinuationLimit(this._goalState)
		) {
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
		// A persistent goal's continuation is its heartbeat: when turns end as fast
		// as the provider answers, an unspaced heartbeat is a billing spin. The
		// throttled continuation is not dropped - it wakes once the interval has
		// elapsed - so the goal keeps going without the spin.
		if (this._throttlePersistentGoalContinuation()) {
			return [];
		}
		try {
			this._ensureGoalRuntimeActive(context.context);
			const previousGoal = this._goalState;
			const previousAccountingStartedAt = this._goalAccountingStartedAt;
			const previousContinuationLastAt = this._goalContinuationLastAt;
			const nextGoal = {
				...this._goalState,
				continuationsUsed: this._goalState.continuationsUsed + 1,
				lastReason: undefined,
				lastError: undefined,
			};
			this._setGoalState(nextGoal);
			this._goalContinuationLastAt = Date.now();
			const produced = [createGoalContextMessage(this._goalState, "continuation")];
			// The spend rides with the handout: if the run's abort keeps the
			// continuation from ever being delivered, the loop hands it back and
			// _repayUndeliveredGoalContinuation puts the budget back.
			this._goalContinuationHandout = {
				messages: produced,
				previousGoal,
				previousAccountingStartedAt,
				previousContinuationLastAt,
			};
			return produced;
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

	/**
	 * Spacing for the persistent-goal heartbeat. Returns true (and schedules the
	 * delayed wake) when the last continuation is younger than the minimum
	 * interval; the first continuation after a goal starts is never throttled.
	 */
	private _throttlePersistentGoalContinuation(): boolean {
		if (!this._goalState.persistent) return false;
		const last = this._goalContinuationLastAt;
		if (last === undefined) return false;
		const remainingMs = this._persistentGoalMinContinuationIntervalMs - (Date.now() - last);
		if (remainingMs <= 0) return false;
		this._schedulePersistentGoalContinuationWake(remainingMs);
		return true;
	}

	private _schedulePersistentGoalContinuationWake(delayMs: number): void {
		if (this._goalContinuationWakeTimer !== undefined) return;
		this._goalContinuationWakeTimer = setTimeout(() => {
			this._goalContinuationWakeTimer = undefined;
			if (this._disposed || this._disposing) return;
			if (this._goalState.status !== "active" || !this._goalState.persistent) return;
			this._queueThrottledGoalContinuation();
		}, delayMs);
		// A throttle wake must never hold a dying process open.
		this._goalContinuationWakeTimer.unref?.();
	}

	/**
	 * Queue the continuation a throttle held back, once the interval has elapsed.
	 * Mirrors the threshold-compaction goal continuation: counted at queue time,
	 * rolled back when admission rejects it.
	 */
	private _queueThrottledGoalContinuation(): void {
		if (this._goalContinuationBudgetExhausted()) {
			return;
		}
		const goalBeforeQueue = this._goalState;
		try {
			this._ensureGoalRuntimeActive();
			this._goalContinuationLastAt = Date.now();
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
					// The throttle fires while the session is idle: the wake must start the turn.
					resumeIfIdle: true,
				}),
			);
		} catch {
			// Admission can race a pause or disposal; roll back the queue-time
			// increment so the next natural stop re-queues and re-counts it.
			this._setGoalState(goalBeforeQueue);
		}
	}

	private async _getContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		this._continuationPollSignal = signal;
		if (this.queuedActionCount > 0) {
			return [];
		}
		const arrivalEpoch = this._sessionInputArrivalEpoch;
		const goalSnapshot = this._goalState;
		const goalAccountingStartedAt = this._goalAccountingStartedAt;
		const goalMessages = await this._getGoalContinuationMessages(context, signal);
		if (goalMessages.length > 0 || signal?.aborted) {
			if (goalMessages.length > 0 && this._sessionInputArrivalEpoch !== arrivalEpoch) {
				this._goalContinuationHandout = undefined;
				this._setGoalState(goalSnapshot);
				this._goalAccountingStartedAt = goalAccountingStartedAt;
				return [];
			}
			return goalMessages;
		}
		// The suppression belongs to the autonomous loop only on a recovery turn: a
		// provider-failure or empty-turn recovery turn is admitted with it so the
		// /autonomous machinery cannot re-loop the run, but a recovery turn that
		// stops mid-task still gets its self-recovery continue - otherwise an
		// unattended task parks at the announcement the recovery itself produced.
		// Every other suppressed prompt (gate retries, heartbeats, terminal
		// notices) keeps the full suppression: their own drivers own continuation.
		const suppressAutonomous =
			this._autonomousContinuationSuppressionDepth > 0 ||
			context.newMessages.some((message) => this._autonomousContinuationSuppressedMessages.has(message));
		if (suppressAutonomous && !this._isRecoveryTurnContinuation(context.newMessages)) {
			return [];
		}
		if (!suppressAutonomous) {
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
			if (autonomousMessage) {
				this._recordAutonomousContinuationDutyEvent(autonomousMessage);
				return [autonomousMessage];
			}
		}
		if (signal?.aborted || this._sessionInputArrivalEpoch !== arrivalEpoch) return [];
		const selfRecovery = this._selfRecoveryContinuation(context);
		return selfRecovery ? [selfRecovery] : [];
	}

	/**
	 * Whether this run's prompt is a provider-failure or empty-response recovery
	 * continuation - the one suppressed prompt class whose turn still gets
	 * self-recovery (review 2026-10-04 item 4).
	 */
	private _isRecoveryTurnContinuation(newMessages: readonly AgentMessage[]): boolean {
		return newMessages.some(
			(message) =>
				message.role === "custom" &&
				(message.customType === PROVIDER_FAILURE_RECOVERY_CUSTOM_TYPE ||
					message.customType === EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE),
		);
	}

	/**
	 * Self-recovery for unattended runs, after goal and autonomous continuations had
	 * nothing to say. A main session whose turn stopped right after tool work with a
	 * reply that only announces the next step gets one automatic continue, and so does
	 * a turn the output budget cut off mid-answer (stopReason "length" - including a
	 * provider pause the model layer reports as a length stop). A truncated answer is
	 * incomplete whether or not the turn ran tools, so the truncation continue does
	 * not require tool work; the announced-next-step scan still does (a pure chat
	 * answer is a finished answer). The finish gate covers the third way a run ends
	 * early: a clean stop whose reply declares the work done without showing the proof
	 * gets asked for the evidence. All of these count into the same per-prompt budget
	 * (`selfRecovery.maxAutoContinues`); once it is spent the run is left to end,
	 * unless the last word is still a bare completion claim - that release is
	 * recorded (finish_gate_released, cause budget_exhausted) instead of passing
	 * silently. A subagent cut off mid-answer while it still owes its parent the result is resumed
	 * under the same budget (a resumed child whose pre-restart reply state is unknown
	 * is left alone, mirroring the reply nudge's conservatism), and a subagent that
	 * finished its task without replying is asked once to send its result. Anything
	 * that reads as a final answer or waiting on children is left alone; a question
	 * or offer ending only exempts a turn that did no tool work.
	 */
	private _selfRecoveryContinuation(context: GetContinuationMessagesContext): AgentMessage | undefined {
		const settings = this.settingsManager.getSelfRecoverySettings();
		const message = context.message;
		if (message.stopReason !== "stop" && message.stopReason !== "length") return undefined;
		if (this._goalState.status === "active") return undefined;
		if (this._hasUnsettledRlmQuiescenceWork()) return undefined;
		const used = autoContinuesInRun(context.newMessages);
		if (this._rlmDepth > 0) {
			// Cut off mid-answer before the result reached the parent: resume under the
			// shared per-prompt budget. `_repliedToParentSinceTask === false` is the
			// known-unreplied state; a resumed child (undefined) may have delivered
			// before the restart, so it is not continued on this signal alone.
			if (message.stopReason === "length") {
				if (!settings.autoContinue || this._repliedToParentSinceTask !== false) return undefined;
				if (used >= settings.maxAutoContinues) return undefined;
				const ordinal = used + 1;
				this._recordSelfRecovery({
					kind: "auto_continue",
					excerpt: "output truncated (stopReason: length)",
					ordinal,
					at: Date.now(),
				});
				return createOutputTruncatedContinueMessage({
					reason: "output_truncated",
					ordinal,
					maxOrdinal: settings.maxAutoContinues,
					deliverable: "parent_reply",
				});
			}
			if (!settings.childReplyNudge || this._repliedToParentSinceTask !== false || used > 0) return undefined;
			if (!ranToolsSinceLastPrompt(context.newMessages)) return undefined;
			this._recordSelfRecovery({ kind: "child_reply_nudge", at: Date.now() });
			// The child-reply nudge is a one-shot (`used > 0` blocks repeats), so its budget is 1.
			return createAutoContinueMessage({ reason: "child_reply_missing", ordinal: 1, maxOrdinal: 1 });
		}
		const ranTools = ranToolsSinceLastPrompt(context.newMessages);
		if (used >= settings.maxAutoContinues) {
			// The budget is spent with the run still ending on a bare completion
			// claim: that is the same unverified finish the gate exists to catch,
			// so the release goes on the record instead of the run ending silently.
			if (settings.finishGate && message.stopReason === "stop") {
				const excerpt = completionClaimWithoutEvidence(message, {
					ranTools,
					promptText: lastUserPromptText(context.newMessages),
					verifiedWork: ranTools && runHasVerificationEvidence(context.newMessages),
				});
				if (excerpt) {
					const strikes = finishGateStrikesInRun(context.newMessages);
					this._recordSelfRecovery({
						kind: "finish_gate_released",
						excerpt,
						strikes,
						ordinal: used + 1,
						cause: "budget_exhausted",
						at: Date.now(),
					});
					this._emitFinishGateReleasedNotice(excerpt, strikes, "budget_exhausted");
				}
			}
			return undefined;
		}
		const ordinal = used + 1;
		if (settings.autoContinue) {
			// Cut off mid-answer: resume where the turn stopped instead of judging the
			// text. Tool work is not required here - a long prose answer the budget cut
			// off mid-sentence is as unfinished as a tool-working turn.
			if (message.stopReason === "length") {
				const excerpt = "output truncated (stopReason: length)";
				this._recordSelfRecovery({ kind: "auto_continue", excerpt, ordinal, at: Date.now() });
				return createOutputTruncatedContinueMessage({
					reason: "output_truncated",
					ordinal,
					maxOrdinal: settings.maxAutoContinues,
				});
			}
			if (ranTools) {
				const excerpt = announcedNextStep(message, { ranTools });
				if (excerpt) {
					this._recordSelfRecovery({ kind: "auto_continue", excerpt, ordinal, at: Date.now() });
					return createAutoContinueMessage({
						reason: "announced_next_step",
						excerpt,
						ordinal,
						maxOrdinal: settings.maxAutoContinues,
					});
				}
			}
		}
		if (!settings.finishGate || message.stopReason !== "stop") return undefined;
		const excerpt = completionClaimWithoutEvidence(message, {
			ranTools,
			promptText: lastUserPromptText(context.newMessages),
			verifiedWork: ranTools && runHasVerificationEvidence(context.newMessages),
		});
		if (!excerpt) return undefined;
		const strikes = finishGateStrikesInRun(context.newMessages);
		if (strikes >= FINISH_GATE_MAX_STRIKES) {
			// The claim was challenged twice and still came back bare: let the run end,
			// and leave on the record that the claimed completion was never verified.
			this._recordSelfRecovery({ kind: "finish_gate_released", excerpt, strikes, ordinal, at: Date.now() });
			this._emitFinishGateReleasedNotice(excerpt, strikes);
			return undefined;
		}
		this._recordSelfRecovery({ kind: "auto_continue", excerpt, ordinal, at: Date.now() });
		return createAutoContinueMessage({
			reason: "finish_gate",
			excerpt,
			ordinal,
			maxOrdinal: settings.maxAutoContinues,
		});
	}

	/**
	 * Owner-facing notice that the finish gate let a completion claim through
	 * unverified: shown in the chat, kept in the transcript, never part of the
	 * model's context (convertToLlm drops the type). It also joins the live
	 * message list: the notice fires at the turn boundary (the tool batch is
	 * closed, so no tool_use/tool_result pairing can break), and a session view
	 * rebuilt from live state - switching away and back - must still show the
	 * "treat the claimed completion as unverified" reminder instead of dropping
	 * it with the transient event stream. The literal
	 * customType mirrors the "finish_gate_released" record kind in self-recovery.ts
	 * and the TUI's FINISH_GATE_RELEASED_CUSTOM_TYPE; the source pin in
	 * test/finish-gate-notice.test.ts anchors all three. A "budget_exhausted"
	 * cause says the continuation budget ran out before the strike count did.
	 */
	private _emitFinishGateReleasedNotice(excerpt: string, strikes: number, cause?: "budget_exhausted"): void {
		const claim = excerpt.replace(/\s+/g, " ").trim();
		const message: CustomMessage = {
			role: "custom",
			customType: "finish_gate_released",
			content: [
				cause === "budget_exhausted"
					? `[finish gate] released an unverified completion claim after ${strikes} challenges: the continuation budget is spent.`
					: `[finish gate] released an unverified completion claim after ${strikes} challenges.`,
				`The reply claimed the work was done ("${claim}") but never showed the proof it was asked for, so the run was left to end. Treat the claimed completion as unverified and check it yourself before relying on it.`,
			].join("\n"),
			display: true,
			details: { excerpt, strikes, ...(cause === undefined ? {} : { cause }) },
			timestamp: Date.now(),
		};
		try {
			this.sessionManager.appendCustomMessageEntry(message.customType, message.content, true, message.details);
		} catch (error) {
			this._reportSessionPersistFailure(error);
		}
		this.agent.state.messages.push(message);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
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
		for (const run of new Set([...this._knownRlmChildRuns(), ...this._retiredRlmChildRuns.values()])) {
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
		if (event.type === "agent_start") {
			// The abortRetry half of _goalAbortInProgress: a new run means the
			// cancelled chain's terminal error was already consumed (or is never
			// coming), so a failure of this run must fail the goal again.
			this._goalAbortInProgress = false;
		}
		trackStallStepOutput(this, event);
		recordStallWatchdogActivity(this, event);
		this._recordFallbackActivity(event);
		this._createRetryPromiseForAgentEnd(event);
		this._routeImagesOnAgentEvent(event);
		// A completed turn's tool batch is closed (turn_end follows the batch's
		// tool results): deferred model-change notices land here, synchronously, so
		// the loop's next request already carries them. Skipped on error/abort
		// turns - the retry machinery expects the failed assistant message last.
		if (
			event.type === "turn_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason !== "error" &&
			event.message.stopReason !== "aborted"
		) {
			this._flushPendingModelChangeMessages();
		}
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
					this._noteAgentMessageDelivered(this._agentMessageDeliveryId(action, event.message));
				} else if (record) {
					// A child reply can also ride in as prefix/next-turn context (a restart
					// reflow, an aggregated wake): it reaches this session's context all the
					// same, so the credit is owed. `take` hands an id out once, so a message
					// delivered on both routes cannot be counted twice.
					this._creditQueuedChildReplyDelivery(event.message);
					// Same for the delivered ledger: a reflowed delivery is a delivery.
					this._noteAgentMessageDelivered(this._agentMessageDeliveryId(action, event.message));
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

	/** Current stall marker, if the watchdog has fired and the turn has not restarted. */
	get stallState(): RlmChildStallState | undefined {
		return this._stallState;
	}

	/**
	 * Wall-clock ms of the last agent event this session observed (r4 phase-2
	 * blind fix A): the signal a sweep measures true silence against. Every
	 * event refreshes it - token deltas and tool starts/ends included - while
	 * `messages.length` only moves on `message_end`, so a streaming reply or a
	 * long tool call leaves the transcript frozen while the session is alive.
	 */
	get lastAgentEventAt(): number | undefined {
		return this._stallLastEvent?.at;
	}

	/**
	 * The watchdog's own exemption verdict, sampled right now (r4 phase-2 blind
	 * fix A): the single arbiter of "is this silence owned work". Reads the live
	 * exemption segment against the clock without re-sampling the predicates,
	 * so a diagnostic read cannot perturb the watchdog, and the budget running
	 * out - not the marker written when the warn fired - is what ends the
	 * excuse. Undefined/disarmed watchdog or no exemption: false.
	 */
	get excusedNow(): boolean {
		return this._stallWatchdog?.isExcusedNow() === true;
	}

	/**
	 * Turns this session has started; advances on every agent_start. The
	 * stall-recovery claim key scopes auto actions to one per (session, epoch).
	 */
	get turnLifecycleEpoch(): number {
		return this._turnLifecycleEpoch;
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

	/**
	 * Whether a host-owned phase currently owns this session's silence, so the watchdog snoozes
	 * instead of escalating (compaction, branch summaries, serialized refinement, a UI dialog).
	 *
	 * Deliberately *not* extended by the kernel-liveness vouch: a vouch only defers the abort, and
	 * B2 requires the warning to keep firing, which merging the two here would suppress. The
	 * "is this silence excused" question a parent needs for its label (B9/I-13) is answered by the
	 * exemption segment on the stall event - see `RlmChildStallState.excused` - not by this getter.
	 */
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

	/** Append one self-recovery action (and its duty-log event); bookkeeping must never break the turn. */
	_recordSelfRecovery(record: SelfRecoveryRecord): void {
		try {
			this.sessionManager.appendCustomEntry(SELF_RECOVERY_CUSTOM_ENTRY, record);
		} catch (error) {
			sessionLog.warn("could not record a self-recovery action", {
				sessionId: this.sessionId,
				kind: record.kind,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		this._recordDutyEvent(dutyEventFor(record));
	}

	/** Append one duty-log event for the "while you were away" summary. */
	_recordDutyEvent(event: DutyEvent): void {
		try {
			this.sessionManager.appendCustomEntry(DUTY_EVENT_CUSTOM_TYPE, event);
		} catch (error) {
			sessionLog.warn("could not record a duty event", {
				sessionId: this.sessionId,
				kind: event.kind,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Append the transcript-only settle record for a run that ended by replying
	 * (rlm-child-terminal-outcome). A `custom` entry: never a message, so it never
	 * enters the model's context or renders - the compaction handoff scanner is the
	 * only reader.
	 */
	_recordRlmChildSettled(details: RlmChildSettledDetails): void {
		try {
			this.sessionManager.appendCustomEntry(RLM_CHILD_SETTLED_CUSTOM_TYPE, details);
		} catch (error) {
			sessionLog.warn("could not record an rlm child settle marker", {
				sessionId: this.sessionId,
				childId: details.childId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Why the watchdog aborted the current turn, for the ipython tool's aborted-cell report.
	 * Read-only; undefined until a stall abort fires, and cleared by the next agent_start.
	 */
	get lastStallAbortCause(): IpythonAbortCause | undefined {
		return this._lastStallAbortCause;
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

	_findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined {
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
					// It also ends the empty-response failure episode: the recovery
					// continuation budget is per-episode, so a fresh ladder starts fresh.
					this._emptyTurnRecoveryUsed = 0;
					// Same for the provider-failure recovery: a real answer ends the
					// failure episode, so a later exhaustion re-arms its one-shot turn.
					this._providerFailureRecoveryUsed = 0;
				}
				if (assistantMsg.stopReason !== "error") {
					this._fallbackLongWaitRound = 0;
					this._inspectionRecoverySteps = 0;
					this._cancelFallbackLongWaitWake();
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
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					// An errored or aborted response is not a clean 2xx completion, so
					// its usage frame says nothing about whether images were counted.
				} else {
					this._maybeNoticeImageDeliverySuspicion(assistantMsg);
				}
				if (assistantMsg.stopReason === "aborted") {
					this._handleAbortedQuotaPark();
				} else if (assistantMsg.stopReason !== "error" && this._quotaPark) {
					// A parked session that completes a model call has its quota back:
					// clear the park (cancelling the pending wake) and resume the task.
					this._completeQuotaParkResume();
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

			// The empty-response ladder ends here (r4 recovery). One recovery
			// continuation per failure episode hands the failure shape back to the
			// model, so the episode is not terminal while that turn is pending: goal
			// finalization and the parent terminal notice wait for the recovery turn's
			// own agent_end. When no continuation is queued - disabled, spent, or the
			// run was aborted between attempts - the failure is terminal and must be
			// heard: an event and a log line instead of the silent stop this was.
			if (isEmptyTurnRetryExhausted(msg)) {
				// K3 deep review, must-1: the retry chain must resolve before the recovery
				// turn is queued. When the empty ladder exhausted inside a retry run, this
				// run WAS the retry outcome - the promise's job is done. Returning with it
				// still pending leaves isRetrying true, the pump gate (:10320) blocks the
				// queued recovery turn, and the session deadlocks with no Esc escape for
				// children (episode semantics live in _emptyTurnRecoveryUsed/_retryAttempt).
				// Blind-2, high: closing the promise alone leaves the retry LEDGER
				// (_retryAttempt/_providerWait/auth sources) on the books - the failed chain
				// never emits auto_retry_end success:false, the recovery turn's real answer
				// later emits a FALSE auto_retry_end success:true credited to this failed
				// chain, and a retryable error inside the recovery turn starts at
				// attempt=2, permanently eating a maxRetries slot per turn.
				// _finishActiveRetryWithFailure is idempotent (no-op without a live chain).
				this._finishActiveRetryWithFailure(msg);
				this._resolveRetry();
				if (this._queueEmptyTurnRecoveryTurn(msg)) return;
				this._emitEmptyResponseExhausted(msg);
			}

			// The provider retry ladder ends here: one recovery turn per failure
			// episode hands the failure shape back to the model, so - exactly like the
			// empty-response recovery above - the episode is not terminal while that
			// turn is pending: the compaction check, the parent terminal notice and
			// goal finalization wait for the recovery turn's own agent_end. The retry
			// chain itself was already closed by the exhausted branch that set the flag.
			if (this._providerFailureRecoveryPending) {
				this._providerFailureRecoveryPending = false;
				if (this._queueProviderFailureRecoveryTurn(msg)) return;
			}

			// The compaction check must never reject out of here: a throw would
			// reject _processAgentEvent, which the event-queue catch swallows,
			// leaving _finishActiveRetryWithFailure and _resolveRetry below
			// unrun and the session wedged in isRetrying - the same shape the
			// parent-notice guard below is armored against. Treat a failed check
			// as "no compaction" so the terminal path closes the retry chain.
			let compactionWillRetry = false;
			try {
				compactionWillRetry = await this._checkCompaction(msg);
			} catch (error) {
				sessionLog.error("compaction check failed at agent_end; treating the turn as terminal without compaction", {
					sessionId: this.sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			if (compactionWillRetry && this._retryAttempt > 0) {
				// The retry chain ends here: the compaction owns the continuation now
				// (its scheduled continue waits on waitForRetry() first), so returning
				// with the chain still open wedges the continuation on a promise
				// nobody will resolve - isRetrying sticks and only Esc unwedges the
				// session. The handoff is not a failure - the task continues through
				// the compaction - so the chain closes with a non-failure end event;
				// a success:false here painted one fake "retry failed" per overflow.
				this._finishActiveRetryForCompactionHandoff(msg);
				this._resolveRetry();
				return;
			}
			this._finishActiveRetryWithFailure(msg);
			if (!compactionWillRetry && msg.stopReason === "error") {
				// Terminal failure: retries are exhausted, disabled, or the error was
				// never retryable. A rejection of the model itself first reconciles the
				// persisted selection (session ledger + saved default) onto a model
				// that can serve; every other failure shape leaves it standing.
				this._reconcileRejectedModelSelection(msg);
				// A subagent must tell its parent instead of parking
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
				this._handleErroredQuotaParkProbe(msg);
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

	_resolveRetry(): void {
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

	_findLastAssistantMessage(): AssistantMessage | undefined {
		return this._findLastAssistantInMessages(this.agent.state.messages);
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
	_disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	_reconnectToAgent(): void {
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

	async _drainPendingRefinementForDisposal(): Promise<void> {
		return drainPendingRefinementForDisposal(this);
	}

	private async _disposeAsyncOnce(kernelSnapshot: boolean): Promise<void> {
		// Queue settlement goes first, before any await: a wedged child session or kernel
		// below can only make progress on the event loop, and a waitForIdle waiter that still
		// sees unfinished work keeps starving it (the 2026-09-19 self-locking teardown).
		// dispose() repeats the pass at the end; see _settleQueuedSessionWorkForDisposal.
		this._settleQueuedSessionWorkForDisposal();
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
		this._stopAllRlmChildFollowUpWatches();
		for (const { session } of this._rlmChildSessions.values()) {
			await session.disposeAsync().catch(() => undefined);
		}
		this._rlmChildSessions.clear();
		this._rlmChildCleanupFailures.clear();
		this._deletedRlmChildIds.clear();
		this._prunedRlmChildIds.clear();
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

	/**
	 * Settle everything the session still owes its queue: persist undelivered work, fail
	 * the deliveries and completions waiting on it, cancel the clearable actions, and drop
	 * the agent's own queues.
	 *
	 * Idempotent by construction - every step consumes the state it settles, and the
	 * sidecar writer de-duplicates by key - because disposeAsync() runs it before its first
	 * await and dispose() runs it again at the end of the teardown. The early pass is the
	 * point: the awaits below it (child sessions, the ipython kernel) can block on IO, and
	 * a waitForIdle waiter that still sees unfinished work is exactly what starves the event
	 * loop that IO needs. Settling first breaks that self-locking chain, and work a child
	 * enqueues during the teardown is settled by the late pass.
	 */
	private _settleQueuedSessionWorkForDisposal(): void {
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
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._stallWatchdog?.dispose();
		// B2-16: the gate watchdog may still be armed against an in-flight compaction;
		// a disposed session must not keep a live timer (or a fake-clock registration).
		this._clearCompactionGateWatchdog();
		this._clearRlmTerminalNoticeAbandonTimer();
		this._clearGoalContinuationWake();
		for (const run of this._unsettledRlmChildRuns) run.suppressTerminalNotice = true;
		for (const controller of this._rlmQuiescenceWaitAborts) controller.abort();
		this._sessionActionCommitDisposeAbortController.abort();
		// A retry sleeping off a provider backoff dies with the session: the abort
		// rejects the sleep and its catch path resolves the retry, so the scheduled
		// continuation can never re-issue a turn on a disposed session.
		this._retryAbortController?.abort();
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
			// The in-process wake dies with the session; the durable one-shot job
			// stays so a restart can still restore the session and resume the task.
			if (this._quotaPark) {
				if (this._quotaPark.timer) clearTimeout(this._quotaPark.timer);
				this._quotaPark = undefined;
			}
			// A long wait's durable wake stays for the same reason.
			clearProviderRequestBudgetCeiling(this.sessionId);
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
			this._stopAllRlmChildFollowUpWatches();
			for (const { session } of this._rlmChildSessions.values()) {
				session.dispose();
			}
			this._rlmChildSessions.clear();
			this._rlmChildCleanupFailures.clear();
			this._deletedRlmChildIds.clear();
			this._prunedRlmChildIds.clear();
			this._settleQueuedSessionWorkForDisposal();
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
		// Every context rebuild passes here: tool output a provider's content
		// inspection refused must stay withheld, or the rebuilt context is refused again.
		this._reapplyInspectionWithholding(messages);
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
		// OBS-2: a rebuild is the seam where the tool face moves, and the digest's
		// call-contract wording is derived from it. The digest rides in context behind a
		// gate that watches only the two store stamps, so without this the delivered menu
		// would keep describing tools the model no longer has until the next cold
		// boundary. Dropping the baselines here costs nothing per turn, and the next
		// turn's fingerprint - which covers the render flags - decides whether a fresh
		// carrier is owed.
		this._noteHarnessDigestToolFaceChange();
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
		// Deferred model-change notices ride the same barrier: a prompt about to
		// commit must carry every switch recorded before it.
		this._flushPendingModelChangeMessages();

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

	/** Monotonic count of agent messages admitted for this session; backs the protocol-5 message wake. */
	private _agentMessageArrivalCount = 0;
	/**
	 * Monotonic count of admitted agent messages that are no longer pending: delivered
	 * into the conversation, or settled as undeliverable (cleared before their turn
	 * ever ran). This - not the arrival count - is the wake baseline a collect counts
	 * news against: an admitted-but-undelivered message is still news the model has
	 * not seen, and the wake is what pushes it to end the turn so the message lands.
	 */
	private _agentMessageDeliveredCount = 0;
	/**
	 * Arrival-counted message ids still awaiting delivery; `arrival - delivered` in
	 * set form. The set (not a bare counter) is what keeps the delivered count exact:
	 * an id enters once at admission and leaves once at delivery or drop, so a
	 * reflowed message delivered twice still counts once.
	 */
	private readonly _pendingAgentMessageDeliveryIds = new Set<string>();
	/** Parked wake_on_message collect waits to nudge when the count advances; each re-checks the count. */
	private readonly _agentMessageArrivalWaiters = new Set<() => void>();

	private _noteAgentMessageAdmitted(admissionMessageId?: string): void {
		this._agentMessageArrivalCount += 1;
		if (admissionMessageId !== undefined) this._pendingAgentMessageDeliveryIds.add(admissionMessageId);
		for (const waiter of [...this._agentMessageArrivalWaiters]) waiter();
		void this._ipythonKernelProvisioner?.manager?.notifyAgentMessageArrived?.();
	}

	/**
	 * An admitted agent message left the pending set: delivered into the
	 * conversation, or dropped before its turn ever ran. Unknown or repeat ids are
	 * no-ops, so the delivered count advances exactly once per admission. The kernel
	 * learns the remaining pending count so its own ledger can clamp down to it (a
	 * delivered message must not stay "pending" for the model).
	 */
	private _noteAgentMessageDelivered(messageId: string | undefined): void {
		if (messageId === undefined || !this._pendingAgentMessageDeliveryIds.delete(messageId)) return;
		this._agentMessageDeliveredCount += 1;
		void this._ipythonKernelProvisioner?.manager?.notifyAgentMessageDelivered?.(
			this._pendingAgentMessageDeliveryIds.size,
		);
	}

	/**
	 * The id an admission was tracked under, recovered at delivery: the custom
	 * envelope's own id, or the legacy text-encoded one for a text-only admission
	 * (the same expression the admission sites compute).
	 */
	private _agentMessageDeliveryId(action: QueuedSessionAction, message: AgentMessage): string | undefined {
		if (isAgentSessionMessage(message)) return message.details.id;
		if (action.payload.kind === "turn") return parseAgentSessionMessagePromptId(action.payload.text);
		return undefined;
	}

	private _waitForAgentMessageArrival(since: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		if (this._agentMessageArrivalCount > since) return Promise.resolve(true);
		if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			let waiter: () => void;
			const finish = (arrived: boolean) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this._agentMessageArrivalWaiters.delete(waiter);
				resolve(arrived);
			};
			const onAbort = () => finish(false);
			const timer = setTimeout(() => finish(false), timeoutMs);
			timer.unref?.();
			waiter = () => {
				if (this._agentMessageArrivalCount > since) finish(true);
			};
			this._agentMessageArrivalWaiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async acceptAgentMessagePrompt(text: string, options?: PromptOptions): Promise<void> {
		const customMessage =
			options?.customMessage && isAgentSessionMessage(options.customMessage) ? options.customMessage : undefined;
		// The id the pending-delivery ledger tracks this admission under: the custom
		// envelope's own id, or the legacy text-encoded one. Keyed by the message, never
		// by options.agentMessageId (a caller-supplied tracking id that may differ).
		const admissionMessageId = customMessage?.details.id ?? parseAgentSessionMessagePromptId(text);
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
			if (queued) this._noteAgentMessageAdmitted(admissionMessageId);
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
			if (queued) this._noteAgentMessageAdmitted(admissionMessageId);
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
		this._noteAgentMessageAdmitted(admissionMessageId);
		if (customMessage?.details.fromRelationship === "parent") this._noteParentFollowUpAdmitted();
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
			if (customMessage?.details.fromRelationship === "parent") this._noteParentFollowUpAdmitted();
			return true;
		}
		const queued = await this._queuePreparedPrompt("followUp", text, undefined, {
			agentMessageId,
			message: customMessage,
		});
		if (queued) resumeSuspendedPump();
		if (queued) this._registerQueuedChildReply(customMessage);
		if (queued && customMessage?.details.fromRelationship === "parent") this._noteParentFollowUpAdmitted();
		return queued;
	}

	/** A parent message opens a new task this session owes the parent a reply for. */
	private _noteParentFollowUpAdmitted(): void {
		this._repliedToParentSinceTask = false;
		this._parentFollowUpCount += 1;
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
		// Defense in depth, and honestly labeled as such: no reachable public entry gets a
		// human-class or system-fence input to this line. The gate has exactly one caller
		// (`acceptAgentMessagePrompt`), which drops an envelope that fails
		// `isAgentSessionMessage()` before it gets here, and the default envelope above
		// makes the channel itself the structural fact - every source that can reach this
		// point (interactive, rpc, extension, internal, unspecified) classifies with origin
		// "agent", because the classifier's agent-message rule fires before any human
		// marking. `system_fence` needs `facts.isSystemFence`, which only a caller-side
		// context can supply and the context literal above never does, so that half is
		// unreachable the same way. Deleting this line is therefore not observable
		// (re-measured with the two admission-bound rows in place: the 29
		// compaction/priority pin cases - 22 in `compaction-input-priority-matrix` and 7 in
		// `2334-human-priority-lane-scoped` - stay green with it removed), and it is kept
		// because `compaction-during-child-reply` states the stand-down as a contract, not
		// because a pin holds it. The observable half - a human prompt is never gated, and
		// human priority never preempts a running compaction - is pinned in
		// `2334-human-priority-lane-scoped.test.ts`, which admits a child reply and a human
		// prompt into the same in-flight window and reads `compaction_pending` for the
		// receipt against `undefined` for the person; the matrix's two "admitted INTO a hung
		// compaction" watchdog rows add the bound to that same window shape. If a reachable
		// human entry ever appears (most likely by moving this ruling into
		// `_admitSessionInput`, which every input passes through), pin it in the same commit.
		//
		// `_admitSessionInput` did grow a compaction-related call - it arms
		// `_armCompactionGateWatchdog` for input admitted into a compaction that is already
		// running - and that is deliberately NOT the move above: a ceiling neither ranks nor
		// defers anything and does not route input through this function, so the caller set
		// is still one entry wide and both halves of the next line stay unreachable.
		if (inputClassOrigin(inputClass) === "human" || inputClass === "system_fence") return undefined;
		if (this.isCompacting) return "compaction_in_flight";
		// A turn in flight compacts at its own agent_end; starting a second compaction
		// here would race it.
		if (this.isStreaming) return undefined;
		const settings = this.settingsManager.getCompactionSettings();
		if (!this._compactionEnabledForCurrentModel()) return undefined;
		const contextWindow = this._sessionContextWindow();
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
	 * Bound how long a compaction may hold queued input.
	 *
	 * The stall watchdog snoozes while a host phase owns the turn boundary
	 * (stall-watchdog.ts: `isPaused()` covers compaction), so a hung summarization
	 * call would otherwise hold every queued reply forever: the gate that ranks
	 * compaction first must not become a way to starve the family. After the
	 * configured stall budget the compaction is aborted and the pump is scheduled, so
	 * the queued input is delivered instead.
	 *
	 * One bound, four arming points, so that neither ordering leaves a gap: the
	 * agent-message gate (it either starts the compaction or finds one running),
	 * `_runAutoCompaction` (the work already queued when a compaction begins),
	 * `_compact` (the manual `/compact` start point, same queue-first ordering) and
	 * `_admitSessionInput` (input admitted into a compaction that is already running,
	 * which is how a person typing during a hung compaction used to wait forever).
	 * An abort is a cancellation, not a summarization failure: both compaction paths
	 * settle it without touching the consecutive-failure streak or the emergency
	 * shrink valve.
	 */
	private _armCompactionGateWatchdog(): void {
		if (this._compactionGateWatchdog !== undefined) return;
		// Branch summary counts as compacting (it blocks the same pump and pauses the
		// same stall watchdog), so it gets the same bound: without it a hung
		// `session_before_tree` handler or wedged summary stream held every queued
		// input forever with no warn and no log (B2-C02). The abort reaches it
		// through `abortBranchSummary()` in the callback below.
		const operation = this._compactionOperation ?? this._branchSummaryOperation;
		if (!operation) return;
		const configured = this.settingsManager.getStallWatchdogSettings().abortAfterSeconds;
		// The stall watchdog ships warn-only (abortAfterSeconds 0), and it snoozes while
		// compaction owns the turn boundary anyway, so this bound carries its own budget.
		const abortAfterSeconds =
			Number.isFinite(configured) && configured > 0 ? configured : COMPACTION_GATE_ABORT_AFTER_SECONDS;
		// Run on the injected stall-watchdog clock when one is present: the bound is a
		// watchdog timer like the warn/abort cascade, so tests drive it through the
		// same deterministic seam instead of racing real 50ms budgets on a loaded
		// runner. With no injection the real timers are used and the handle is unref'd.
		const timers = this._stallWatchdogTimers;
		const schedule: (callback: () => void, delayMs: number) => unknown = timers
			? (callback, delayMs) => timers.setTimeout(callback, delayMs)
			: (callback, delayMs) => setTimeout(callback, delayMs);
		const unschedule: (handle: unknown) => void = timers
			? (handle) => timers.clearTimeout(handle)
			: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>);
		const operationKind = operation === this._compactionOperation ? "compaction" : "branch_summary";
		const timer = schedule(() => {
			this._compactionGateWatchdog = undefined;
			if (this._disposed || this._disposing) return;
			if (!this.isCompacting) return;
			sessionLog.warn("compaction holding queued input exceeded the stall budget; aborting it", {
				sessionId: this.sessionId,
				abortAfterSeconds,
				operationKind,
			});
			this.abortCompaction();
			this.abortBranchSummary();
			// The manual path parked the pump behind its own abort() for the whole
			// summarization (K3R-11), so scheduling alone no-ops there: lifting that
			// suspension is what actually lets the queued input through once the
			// watchdog has cut the compaction. An ordinary Esc suspension cannot
			// co-exist with a live compaction (Esc cancels it at once), and the
			// update-restart fence still refuses the wake inside.
			this.wakeSuspendedSessionInput();
			this._scheduleSessionInputPump();
		}, abortAfterSeconds * 1000);
		if (timers === undefined) (timer as ReturnType<typeof setTimeout>).unref?.();
		this._compactionGateWatchdog = timer;
		const clear = (): void => {
			if (this._compactionGateWatchdog === timer) {
				unschedule(timer);
				this._compactionGateWatchdog = undefined;
			}
		};
		void operation.then(clear, clear);
	}

	/** Disarm the compaction gate watchdog (dispose path; the identity guard lives in the armer). */
	private _clearCompactionGateWatchdog(): void {
		if (this._compactionGateWatchdog === undefined) return;
		const timers = this._stallWatchdogTimers;
		if (timers) {
			timers.clearTimeout(this._compactionGateWatchdog);
		} else {
			clearTimeout(this._compactionGateWatchdog as ReturnType<typeof setTimeout>);
		}
		this._compactionGateWatchdog = undefined;
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
		if ((message.details as { followUp?: unknown }).followUp === true) {
			return this._supersededRlmFollowUpNoticeReason(childId, delivering);
		}
		const run = this._rlmChildRunForNotice(childId);
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
	 * A follow-up notice is about the child's latest task, not its spawn run, so the
	 * run's verdict fields do not apply; the live child is the witness. A reply that
	 * landed since the notice was queued (or rides in this very turn) disproves it.
	 */
	private _supersededRlmFollowUpNoticeReason(
		childId: string,
		delivering?: readonly AgentMessage[],
	): string | undefined {
		const child = this._rlmChildSessions.get(childId)?.session;
		if (!child) return undefined;
		if (child._repliedToParentSinceTask === true)
			return "the child replied to its follow-up after the notice was queued";
		const replying = delivering?.some(
			(candidate) => isAgentSessionMessage(candidate) && candidate.details.from?.sessionId === child.sessionId,
		);
		return replying ? "the child's reply to its follow-up is being delivered in this same turn" : undefined;
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
		// A follow-up notice says nothing about the spawn run's verdict.
		if ((message.details as { followUp?: unknown }).followUp === true) return;
		const run = this._rlmChildRunForNotice(details.childId);
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
	 * steps, used by the abandonment path and by receipts that must not queue
	 * behind a turn (the image-delivery suspicion notice).
	 */
	_appendCustomMessageToTranscript(message: CustomMessage): void {
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
	_hasActionableDeferredRlmTerminalNotices(): boolean {
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

	_pushPendingNextTurnMessages(...messages: CustomMessage[]): void {
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

	async _deferRlmTerminalNotice(message: CustomMessage): Promise<void> {
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

	private _promptSubmissionInFlight = false;

	private async _prompt(text: string, options?: InternalPromptOptions): Promise<void> {
		// Synchronous preflight guard: from submission until the prompt promise
		// settles, a model switch must not tear down a routed turn's override
		// (the routing decision for this turn's images may already be made).
		this._promptSubmissionInFlight = true;
		try {
			return await this._promptInner(text, options);
		} finally {
			this._promptSubmissionInFlight = false;
		}
	}

	private async _promptInner(text: string, options?: InternalPromptOptions): Promise<void> {
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
							priority: options?.priority,
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
					priority: options?.priority,
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
			/** Machine callers (cron, heartbeats) opt out; the default caller of this API is a person. */
			priority?: SessionActionPriority;
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
			// A live steering submission is a person typing unless the caller says otherwise.
			// The action keeps the queue path's recorded source; only the priority asks the
			// classifier the way a human client would (an agent delivery id still demotes).
			priority:
				options.priority ??
				sessionActionPriorityFor({ source: "interactive", agentMessageId: options.agentMessageId }),
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
			/** Machine callers (cron, heartbeats) opt out; the default caller of this API is a person. */
			priority?: SessionActionPriority;
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
			// Same contract as steer(): a live follow-up submission is a person typing unless
			// the caller says otherwise, and the lane still decides who drains first (QP-4).
			priority:
				options.priority ??
				sessionActionPriorityFor({ source: "interactive", agentMessageId: options.agentMessageId }),
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
			const primaryMessage =
				payload.kind === "turn" ? payload.records.find((record) => record.role === "primary")?.message : undefined;
			return {
				id: recovered.id,
				source: recovered.source,
				delivery: recovered.delivery,
				// Snapshots written before #2334 carry no priority: re-derive it from the
				// recorded source and envelope. Restored actions replay in stored order
				// (placement "tail"), so this only matters once new input joins the queue.
				priority:
					recovered.priority ??
					sessionActionPriorityFor({
						source: recovered.source,
						message: primaryMessage,
						agentMessageId: recovered.agentMessageId,
					}),
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
				// A session slash command is a person's command; the restore path rewrites the
				// recorded source to "internal", so the source cannot vouch for it here.
				priority: "user",
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
			// The parked-queue snapshot records source "internal" for input a person typed, so
			// the source gets no vote here: the message envelope decides. No envelope means a
			// parked human prompt (machine traffic always carries a custom message), and an
			// agent/heartbeat/digest envelope classifies as machine traffic.
			priority: sessionActionPriorityFor({
				message: snapshot.customMessage,
				agentMessageId: snapshot.agentMessageId,
			}),
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

	_turnExecutionPolicy(
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

	_createPreparedTurnAction(
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
			priority?: SessionActionPriority;
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
			priority:
				options.priority ?? sessionActionPriorityFor({ source, message, agentMessageId: options.agentMessageId }),
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
			priority?: SessionActionPriority;
		} = {},
	): QueuedSessionAction {
		const source = options.source ?? "internal";
		return {
			id: randomUUID(),
			source,
			delivery: this._deliveryPolicy(schedule),
			priority: options.priority ?? sessionActionPriorityFor({ source, agentMessageId: options.agentMessageId }),
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

	_admitSessionInput(
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
		// A restore replays the order it was persisted in, so priority must not reorder it;
		// everything else joins the lane at its priority slot (#2334, lane-scoped by QP-4).
		const placement: SessionActionPlacement = options.front
			? "front"
			: options.restore || options.preserveOrder
				? "tail"
				: "priority";
		this._actionStore.enqueue(action, placement);
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
		// A running compaction defers every queued input (`canSelectSessionAction`), but
		// only the work that was ALREADY waiting when the compaction started was bounded:
		// `_runAutoCompaction` arms the gate watchdog from `hasPendingSessionWork`, and the
		// agent-message gate arms it for its own channel. Input admitted *into* a running
		// compaction had no bound, and the stall watchdog snoozes while compaction owns the
		// turn boundary, so a wedged summarization call held it forever - the boss typing
		// during a hung compaction is the observed case, and machine traffic stalls the
		// same way (measured with a heartbeat; an RLM child terminal notice is admitted
		// through the identical call). Admission is the one choke point every input passes
		// through, so the bound is armed here and stops depending on which of the two
		// happened first.
		if (this.isCompacting) this._armCompactionGateWatchdog();
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

	async _queuePreparedPrompt(
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
			priority?: SessionActionPriority;
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

	_scheduleSessionInputPump(): void {
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
		let failed = false;
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
				// A preselected action cancelled while this pass awaited (an abort,
				// clearQueue or agent-message clear landing between the read above and
				// here) is terminal and already released by the cancelling side;
				// rolling it back or driving it into preparing would throw an illegal
				// transition outside the batch try below. Treat it as gone.
				const livePreselected = preselected?.lifecycle.state === "selected" ? preselected : undefined;
				const activity = this._runtimeActivity();
				const canSelectPreselectedTurn =
					livePreselected?.payload.kind === "turn" &&
					canSelectSessionAction({ ...activity, refinementApply: false });
				if (
					this._isSessionInputHandoffDeferred(epoch) ||
					(!canSelectPreselectedTurn && !canSelectSessionAction(activity))
				) {
					blocked = true;
					// A preselected action must not outlive a blocked return: `selected` work is
					// invisible to the queue-based reschedule sources, so it stranded until an
					// unrelated admission happened to wake a pump - one input silently swallowed
					// (docs/fork/audit-20260919-findings.md, second-batch ledger). Rolling back
					// also lets a `starts_when_admitted` agent-message sender observe the
					// deferral instead of hanging on a delivery promise that can no longer settle.
					if (livePreselected) this._actionStore.rollback(livePreselected);
					this._notifySessionInputCheckpointChange();
					if (livePreselected) this._emitQueueUpdate();
					return;
				}
				const first = livePreselected ?? this._actionStore.selectFirst();
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
				while (!livePreselected && mode === "all") {
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
						// The rollback above is the undelivered half. The delivered half has
						// nowhere to go: `committing`/`running` is outside CLEARABLE_STATES, so
						// no later cancel (not even dispose()) can reach it, and a "deferred"
						// error is never re-driven for work whose dispatch already settled. Left
						// alone it pinned unfinishedActionCount above zero for the rest of the
						// session's life - every idle wait, RLM quiescence check and eviction
						// decision behind it. The batch's finally releases the terminal actions.
						this._settleDeferredDeliveredTurnActions(actions, transcript, this._asError(error));
						if (undelivered.length > 0) this._emitQueueUpdate();
						blocked = epoch !== this._sessionInputPumpEpoch || this._isBusyForSessionInput("pump");
						if (blocked) {
							// The rollback above returned survivors to queued, and the
							// finally below skips its self-reschedule when blocked - without
							// a fresh pass the survivors wedge in the queue until some
							// unrelated event happens to schedule one (the wave-4-e contract
							// is that every busy-slot clear site reschedules). The scheduler
							// self-guards (pause/suspend/disposed/empty queue), so this is
							// safe whether the block was an epoch move or a busy sibling.
							this._scheduleSessionInputPump();
							return;
						}
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
		} catch (error) {
			failed = true;
			this._sessionInputPumpFailureStreak += 1;
			// Logged, never propagated: a rejecting pump used to surface in
			// waitForSessionInputIdle callers as an unexplained failure while the
			// pump chain's own catch swallowed it without a trace. The failure
			// streak fuses the self-reschedule below, so a deterministic throw
			// cannot spin the microtask queue (the 2026-09-19 wedge class).
			sessionLog.error("session input pump pass failed", {
				sessionId: this.sessionId,
				error: error instanceof Error ? error.message : String(error),
				failureStreak: this._sessionInputPumpFailureStreak,
			});
		} finally {
			if (!failed) this._sessionInputPumpFailureStreak = 0;
			if (!blocked && epoch === this._sessionInputPumpEpoch && this._hasSelectableSessionInput()) {
				if (this._sessionInputPumpFailureStreak < SESSION_INPUT_PUMP_FAILURE_LIMIT) {
					this._scheduleSessionInputPump();
				} else if (this._sessionInputPumpFailureStreak === SESSION_INPUT_PUMP_FAILURE_LIMIT) {
					// Give up once, loudly. Admission, checkpoint changes and retry
					// resolution still schedule fresh passes; only the tight
					// self-reschedule loop is fused.
					sessionLog.error("session input pump stopped rescheduling itself after repeated failures", {
						sessionId: this.sessionId,
						failureStreak: this._sessionInputPumpFailureStreak,
					});
				}
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
	 * a teardown that can itself block. A clear site must also reschedule the
	 * session-input pump: work the pump rolled back into the queue while the
	 * site held the busy slot has no other dispatch source short of the next
	 * unrelated admission.
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

	_asError(error: unknown): Error {
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
					// Re-evaluate image routing for this batch before any pre-commit read of
					// the serving model: pre-turn compaction must not follow the previous
					// turn's override. Retries and post-compaction continuations of a routed
					// turn re-read the override, so they keep serving it; the next dispatch
					// overwrites it with its fresh decision.
					this.agent.modelOverride = this._imageRouteForTurns(activeTurns())?.override;
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
						const prepared = this._prepareHarnessDigest();
						this._recordHarnessDigestBaselines(prepared.state);
						const latest = this._latestContextHarnessDigestDetails();
						if (!latest || !this._harnessDigestIsFresh(latest, prepared)) {
							// Rides the turn's delivery records, so cancelling this first turn
							// strips the digest with the rest of the turn and re-arms it.
							nextTurnMessages = [
								createHarnessDigestMessage(prepared.render(), Date.now(), prepared.stateFingerprint),
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
					// Loop-facing knobs are re-read here so settings changes apply to the
					// next turn (the four r4 rollback handles included).
					this._refreshAgentLoopRuntimeSettings();
					// Re-evaluate image routing for the exact message set being sent:
					// before_agent_start injections land after the earlier per-turn
					// decision and may carry images the session model cannot serve.
					const imageRoute = this._imageRouteForTurns(turns, preparedMessages);
					// A handback the previous run set after its last request must not be taken by
					// this run's first request: this dispatch made its own routing decision.
					if (this._imageRoute?.handback && this.agent.pendingTurnModel === this._imageRoute.handback) {
						this.agent.pendingTurnModel = undefined;
					}
					this._beginImageRoute(imageRoute);
					// Same batch, same authority: the image-delivery suspicion check
					// reads at message_end whether the request this run actually sends
					// carries images (the committed batch plus image blocks tool results
					// deliver mid-run), and re-arms its one-notice-per-batch budget.
					// A route for an image already in context sends that image too.
					this._dispatchedBatchCarriedImages =
						batchCarriesImages(turns, preparedMessages) || imageRoute?.contextOnly === true;
					this._runToolResultsCarriedImages = false;
					this._imageDeliverySuspicionNotified = false;
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
		// The pump-epoch bump for cancelled selected/preparing actions lives in
		// _cancelSessionActions, so every cancel path - not just this one - moves it.
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
			// The delivered ledger settles the same way: a cleared message must not
			// stay "pending" forever, or every later collect would wake for it.
			if (action.payload.kind === "turn") {
				const custom = action.payload.customMessage;
				this._noteAgentMessageDelivered(
					custom && isAgentSessionMessage(custom)
						? custom.details.id
						: parseAgentSessionMessagePromptId(action.payload.text),
				);
			}
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
				priority: action.priority,
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

	_notifySessionInputCheckpointChange(): void {
		const waiters = [...this._sessionInputCheckpointWaiters];
		this._sessionInputCheckpointWaiters.clear();
		for (const resolve of waiters) resolve();
	}

	_waitForSessionActivityChange(signal: AbortSignal): Promise<void> {
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
		let previousProgress: WaitForIdleProgress | undefined;
		let stagnantCycles = 0;
		while (settlement === undefined || this._postCompactionContinuationSettlement === settlement) {
			if (this._actionStore.queuedActions().length > 0) {
				// Park while the pump would refuse scheduling or selection: rescheduling
				// a blocked pump completes on already-resolved promises, so looping here
				// would spin on the microtask queue and starve the IO that ends the busy state.
				// Disposal stays out of the park: disposeAsync() sets _disposing before the
				// teardown that cancels the queue, and that teardown can block on a wedged
				// kernel, so parking here would pin a checkpoint waiter (and
				// hasPendingAdmissionWaiters) for the whole teardown. The fall-through below
				// resolves once dispose() cancels the queue - and disposeAsync() now settles
				// it before its first await, so that release does not depend on the teardown
				// making progress.
				if (this._isBusyForSessionInput("pump") && !this._disposed && !this._disposing) {
					let wake = () => {};
					const changed = new Promise<void>((resolve) => {
						wake = resolve;
						this._sessionInputCheckpointWaiters.add(resolve);
					});
					// Bounded: the park normally ends on a checkpoint notification, and every
					// clear site sends one, but a state that never transitions again would
					// leave this waiter registered forever - which is what
					// hasPendingAdmissionWaiters reports to daemon passivation. One macrotask
					// per poll is the price of not depending on that invariant holding.
					const poll = waitForIdlePoll();
					try {
						await (settlement
							? Promise.race([changed, settlement.promise, poll])
							: Promise.race([changed, poll]));
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
			// Fuse. Every await above can be an already-settled promise: an action stranded
			// outside the queue (a delivered dispatch a deferred error left in `committing`,
			// a turn the pump selected and then refused) makes the exit condition permanently
			// false while nothing here blocks, and the loop then never returns to the event
			// loop. Timers, IO and the teardown that would clear the state all starve
			// together - the 2026-09-19 worker spun 40 minutes at 100% CPU with every RPC
			// timing out and its own stall watchdog silent. So: yield a macrotask per cycle,
			// pace that yield down to a poll once cycles stop making progress, and stop
			// waiting entirely when no operation owns the wait.
			const progress = this._waitForIdleProgress();
			const stagnant = previousProgress !== undefined && sameWaitForIdleProgress(previousProgress, progress);
			previousProgress = progress;
			stagnantCycles = stagnant ? stagnantCycles + 1 : 0;
			if (stagnantCycles >= WAIT_FOR_IDLE_STAGNANT_CYCLE_LIMIT && progress.blockOwner === undefined) {
				// Self-heal. Nothing in flight can still advance this state, so waiting on it
				// is unbounded; report and return instead. waitForIdle never rejects (see
				// waitForHeadlessIdle), and a released waiter is what lets daemon passivation
				// and the next idle check proceed on a session that is wedged either way.
				sessionLog.error("waitForIdle gave up on a session input state that cannot advance", {
					sessionId: this.sessionId,
					unfinishedActions: progress.unfinishedActions,
					queuedActions: progress.queuedActions,
					streaming: progress.streaming,
					stagnantCycles,
				});
				return;
			}
			await (stagnant ? waitForIdlePoll() : nextEventLoopTurn());
		}
	}

	/** The observable state one waitForIdle cycle ended on; see {@link sameWaitForIdleProgress}. */
	private _waitForIdleProgress(): WaitForIdleProgress {
		return {
			// The pump promise identity is deliberately absent: a pump that refuses to select
			// work is rescheduled every cycle, so a fresh identity each time is the symptom of
			// a wedge, not progress. A processed agent event is progress, so that identity
			// is kept.
			agentEventQueue: this._agentEventQueue,
			pumpRequested: this._sessionInputPumpRequested,
			streaming: this.agent.state.isStreaming,
			queuedActions: this._actionStore.queuedActions().length,
			unfinishedActions: this.unfinishedActionCount,
			blockOwner: this._waitForIdleBlockOwner(),
		};
	}

	/**
	 * The operation that owns a waitForIdle wait, when one does. The stagnation break in
	 * {@link _waitForIdleOrSettlement} fires only when this is undefined: everything listed
	 * here has an owner that ends it and notifies the checkpoint waiters, so giving up early
	 * would report a busy session as idle.
	 *
	 * A live agent run is deliberately absent. The loop awaits `agent.waitForIdle()` itself,
	 * so a cycle that completes with the streaming flag still up is a contradiction to stop
	 * waiting on, not an operation to respect. Disposal is absent for the mirror reason:
	 * disposeAsync() settles the queue before its first await, so a waiter still stuck here
	 * is waiting on something the teardown can no longer clear, and holding it pins
	 * hasPendingAdmissionWaiters for a session that is going away.
	 */
	private _waitForIdleBlockOwner(): string | undefined {
		if (this.isCompacting) return "compaction";
		if (this.isRetrying) return "retry";
		if (this.isBashRunning) return "bash";
		if (this._refineInFlight !== undefined) return "refinement";
		if (this._branchSummaryOperation !== undefined) return "branch-summary";
		if (this._postCompactionContinuationSettlement !== undefined) return "post-compaction-continuation";
		if (this._queuedWorkPauses.size > 0) return "queued-work-pause";
		if (this._sessionInputPumpSuspended) {
			return this._sessionInputSuspendedForUpdateRestart ? "update-restart-fence" : "abort-suspension";
		}
		return undefined;
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

	/**
	 * Terminalize the delivered half of a pump batch whose dispatch closed on a deferred
	 * error - the mirror of {@link _settleAbortedDispatchedTurnActions} for the pump's own
	 * error path, which only ever rolled undelivered work back. Same contract: the
	 * delivered messages stay in the transcript, only the action lifecycle ends, and the
	 * dispatching batch's finally is what releases the terminal actions from the store.
	 *
	 * `failed` is the honest state: the primary message reached the context, and the
	 * dispatch that owned it did not settle. Its ticket and any agent-message outcome
	 * reject with the same error, so a caller waiting on the completion learns why instead
	 * of waiting forever.
	 */
	private _settleDeferredDeliveredTurnActions(
		actions: readonly QueuedSessionAction[],
		transcript: readonly AgentMessage[],
		error: Error,
	): void {
		for (const action of actions) {
			if (action.payload.kind !== "turn") continue;
			const state = action.lifecycle.state;
			if (state !== "committing" && state !== "running") continue;
			const primary = primaryDeliveryRecord(action);
			if (!primary.durable && !transcript.includes(primary.message)) continue;
			primary.durable = true;
			transitionSessionAction(action, { state: "failed", error });
			const ticket = this._actionStore.ticketFor(action);
			ticket.rejectDelivered(error);
			ticket.settleCompleted(error);
			this._settleAgentMessage(action.agentMessageId, "delivery", error);
			this._settleAgentMessage(action.agentMessageId, "completion", error);
		}
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
	 *
	 * `reason` (r4 recovery-shell) is forwarded to the abort so the terminal
	 * classifier can tell an automatic stall-recovery interrupt from a user Esc
	 * (see RlmChildTurnAbortReason); callers that omit it keep the exact
	 * previous behavior.
	 */
	abortAndSendQueued(options?: { reason?: RlmChildTurnAbortReason }): boolean {
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
			this.requestAbort(options);
			return false;
		}
		this._forcedAllSteeringActionIds = new Set(queuedSteering.map((action) => action.id));
		this.requestAbort(options);
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

		// An explicit pick ends any automatic fallback: never switch the user back.
		this._fallback = undefined;
		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.agent.state.model = model;
		this._clearModelOverrideWhenIdle();
		// The ledger entry lands even for a no-op re-selection: a restarted session
		// reads "the owner picked this model" from it (a fallback episode the owner
		// ended with an explicit pick must not rebuild). The model-facing notice is
		// the only part a same-model call skips: there is no switch to learn.
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (!modelsAreEqual(model, previousModel)) {
			this._pushModelChangeNotice({ provider: model.provider, modelId: model.id });
			if (options.changeNotice) {
				this._emitModelChangeOriginNotice(model, previousModel, options.changeNotice);
			}
		}
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

		// A cycled pick is as explicit as setModel: never switch the owner back.
		this._fallback = undefined;
		this.agent.state.model = next.model;
		this._clearModelOverrideWhenIdle();
		this._recordModelChangeForContext({ provider: next.model.provider, modelId: next.model.id });
		if (options.changeNotice) {
			this._emitModelChangeOriginNotice(next.model, currentModel, options.changeNotice);
		}
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
		// A cycled pick is as explicit as setModel: never switch the owner back.
		this._fallback = undefined;
		this.agent.state.model = nextModel;
		this._clearModelOverrideWhenIdle();
		this._recordModelChangeForContext({ provider: nextModel.provider, modelId: nextModel.id });
		if (options.changeNotice) {
			this._emitModelChangeOriginNotice(nextModel, currentModel, options.changeNotice);
		}
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

	/**
	 * 半落地尾巴① (记忆-1 surface half): session-manager's three context-loss
	 * warnings - transcript lines skipped on load, a broken entry chain, a
	 * compaction retention anchor that matches nothing - are log-only, so a damaged
	 * session looks healthy to the owner while the history before the damage is
	 * simply not in context. On construction the session says so itself: one
	 * persisted, user-visible notice (display: true; a custom message never reaches
	 * the model). Deduped by the defect signature: resuming the same damaged
	 * session must not stack a copy of the notice per resume.
	 */
	private _discloseContextLossOnLoad(): void {
		const findings: string[] = [];
		const sessionFile = this.sessionFile;
		if (sessionFile) {
			// The skip ledger is process-global and every read of the same damaged file
			// adds its own copy (listing scans, a reload), so count the distinct damage:
			// the set of lines that failed, not the number of reads that saw them.
			const skipped = new Map<string, TranscriptLineSkip>();
			for (const skip of getTranscriptLineSkips()) {
				if (skip.sessionFile === sessionFile) skipped.set(`${skip.line}:${skip.reason}`, skip);
			}
			if (skipped.size > 0) {
				const first = skipped.values().next().value as TranscriptLineSkip;
				findings.push(
					`${skipped.size} transcript line${skipped.size === 1 ? "" : "s"} could not be read (line ${first.line}: ${first.reason})`,
				);
			}
		}
		const branch = this.sessionManager.getBranch();
		const head = branch[0];
		if (head?.parentId) {
			// The leaf-to-root walk stopped early: this parent id names an entry the
			// transcript map does not hold (a skipped bad line, a torn write), and
			// everything before it left the rebuilt context.
			findings.push(`the entry chain is broken before entry ${head.id} (missing parent ${head.parentId})`);
		}
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry?.type !== "compaction") continue;
			// Only the newest compaction anchors the rebuilt context, so only its
			// missing anchor collapses the retained tail (mirrors buildSessionContext).
			const anchor = entry.firstKeptEntryId;
			if (typeof anchor === "string" && anchor.length > 0 && !branch.slice(0, index).some((e) => e.id === anchor)) {
				findings.push(`compaction ${entry.id}'s retained tail (firstKeptEntryId ${anchor}) matches no entry`);
			}
			break;
		}
		if (findings.length === 0) return;
		const signature = findings.join(" | ");
		const alreadyNoted = branch.some(
			(entry) =>
				entry.type === "custom_message" &&
				entry.customType === SESSION_CONTEXT_LOSS_CUSTOM_TYPE &&
				(entry.details as Partial<SessionContextLossDetails> | undefined)?.signature === signature,
		);
		if (alreadyNoted) return;
		const message = {
			role: "custom" as const,
			customType: SESSION_CONTEXT_LOSS_CUSTOM_TYPE,
			content: [
				`This session's transcript is damaged: ${findings.join("; ")}.`,
				"Everything before the damaged point is missing from the context this session runs on - the model cannot see it. Nothing was deleted: the transcript file on disk still holds every readable entry, and /export, /tree and /fork can still reach them.",
				"If the missing history matters, restore the transcript from a backup or continue in a fresh session (/new); otherwise no action is needed.",
			].join("\n"),
			display: true,
			details: { signature, findings } satisfies SessionContextLossDetails,
			timestamp: Date.now(),
		} satisfies CustomMessage<SessionContextLossDetails>;
		this.sessionManager.appendCustomMessageEntry(message.customType, message.content, true, message.details);
		// No event subscribers exist this early in construction; the attaching UI picks
		// the notice up from the transcript, so land it where session.messages reads.
		this.agent.state.messages.push(message);
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
		// The compaction already committed by the time this runs, so the kernel
		// sync is post-commit best-effort: a failed append must not flip the
		// compaction's outcome attribution (the caller would record the committed
		// compaction as failed, and an overflow recovery would lose its retry).
		// Degrade exactly like a compaction outcome: report the failure and track
		// the message as unpersisted so context rebuilds still carry it (the
		// in-memory push above is already ahead of the disk).
		try {
			this.sessionManager.appendCustomMessageEntryWithRollback(
				message.customType,
				message.content,
				message.display,
				undefined,
			);
		} catch (error) {
			this._reportSessionPersistFailure(error);
			this._unpersistedOutcomes.push(message);
		}
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });

		const pruned = snapshot?.pruned ?? [];
		if (pruned.length > 0) {
			// The prune deleted those names from the LIVE kernel, and the
			// <ipython_state> block above is model-only (display: false), so without
			// this notice the owner never hears that data was destroyed. Transcript +
			// event stream only: the model already got the same fact in the block
			// above, and a second copy would just pollute its context. The literal
			// customType follows the ipython_state precedent - it never enters the
			// input pipeline, so the input-classification coverage pin does not apply.
			const pruneNotice = {
				role: "custom" as const,
				customType: "ipython_state_pruned",
				content: [
					`Kernel variables removed by the post-compaction snapshot: ${pruned.join(", ")}.`,
					"Each exceeded the per-variable snapshot size limit, so it was deleted from the live Python kernel (too large to persist). The kernel and all other variables survived; the removed values are not in the kernel and not in the on-disk snapshot.",
					"To use them again, recreate them: re-run the cell that built them or reload the data from its source.",
				].join("\n"),
				display: true,
				timestamp: Date.now(),
			} satisfies CustomMessage;
			// Same post-commit best-effort rule as the ipython_state block above:
			// the compaction already committed, so a failed append only reports.
			// The notice deliberately stays out of _unpersistedOutcomes: it is a
			// transcript/event disclosure for the owner, and re-merging it into a
			// rebuilt context would tell the model the same fact twice (the
			// ipython_state block already carries it).
			try {
				this.sessionManager.appendCustomMessageEntryWithRollback(
					pruneNotice.customType,
					pruneNotice.content,
					true,
					undefined,
				);
			} catch (error) {
				this._reportSessionPersistFailure(error);
			}
			this._emit({ type: "message_start", message: pruneNotice });
			this._emit({ type: "message_end", message: pruneNotice });
		}
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

	/**
	 * Tell the model which pre-imported Python skills failed to import into the
	 * freshly started kernel, before it spends turns reading their SKILL.md and
	 * calling them (the placeholder objects only raise on first call).
	 */
	private _onPythonSkillsUnavailable(errors: UnavailablePythonSkills): void {
		const lines = ["[python-skills-unavailable]", ""];
		lines.push(
			"These installed Python skill modules failed to import into the Python kernel, so calling them raises an error:",
		);
		for (const [name, error] of Object.entries(errors)) {
			lines.push(`- ${name}: ${error}`);
		}
		lines.push(
			"",
			'Plan around them: a call raises the error above instead of doing the work. If the fix is in reach, make it (a missing dependency installs into the kernel interpreter with `uv pip install --python "<kernel-python>" <pkg>`, passing `sys.executable`). The kernel keeps the failed placeholder under the skill name, so an install alone changes nothing until the module is loaded again: `import sys, importlib; sys.modules.pop("<name>", None); <name> = importlib.import_module("<name>")` (a kernel restart also picks it up). Otherwise use another approach, and tell the owner which capability was missing when it limits the result.',
		);
		void this.sendCustomMessage(
			{
				customType: PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
				content: lines.join("\n"),
				display: true,
				details: { skills: Object.keys(errors) },
			},
			{ deliverAs: "nextTurn" },
		).catch(() => {});
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
		// The manual path is a compaction start point too (B2-C01): input that was
		// already queued when /compact began is this ordering's gap, and the gate
		// watchdog is its bound, exactly as in `_runAutoCompaction`.
		if (this.hasPendingSessionWork) this._armCompactionGateWatchdog();
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
			// A manual /compact that preempted an in-flight overflow recovery owes
			// the overflowed request its retry: the auto scope's willRetry path
			// never ran. A user-aborted manual run drops the debt (the abort owns
			// the stop); a failed one still retries. The strip mirrors the
			// willRetry path: a committed compaction (or a failure-path shrink)
			// rebuilt the context from the branch, reintroducing the persisted
			// overflow error at the tail, and continue() refuses an assistant tail.
			if (this._preemptedOverflowRecoveryRetry) {
				this._preemptedOverflowRecoveryRetry = false;
				if (!compactionAbort.signal.aborted) {
					const messages = this.agent.state.messages;
					const last = messages[messages.length - 1];
					if (last?.role === "assistant" && (last as AssistantMessage).stopReason === "error") {
						this.agent.state.messages = messages.slice(0, -1);
					}
					this._schedulePostCompactionContinue(true);
				}
			}
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

		const preparationOutcome = prepareCompactionOutcome(pathEntries, settings, this._registryContextWindow(model), {
			provider: model.provider,
			modelId: model.id,
		});
		if (preparationOutcome.kind === "skip") {
			if (preparationOutcome.reason === "missing-entry-ids") {
				// A real failure, not a skip: count it so repeated occurrences still
				// escalate to emergency shrink instead of silently skipping forever.
				throw new Error(compactionSkipMessage(preparationOutcome.reason));
			}
			// Over-threshold with nothing summarizable: the kept tail is one
			// oversized message, which is not a wall - the plan rides the skip so
			// the caller can spend the shrink valve instead of skipping forever
			// (wave-29 W29-B10). The shrink must not run inside this scope: a
			// shrink failure here would digest into this scope's compaction_end
			// instead of escaping to the caller (w9a pin).
			const skipError = new CompactionSkippedError(compactionSkipMessage(preparationOutcome.reason));
			skipError.emergencyShrink = preparationOutcome.emergencyShrink;
			throw skipError;
		}
		const preparation = preparationOutcome.preparation;

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
					// slice: getBranch() returns the live leaf-branch cache, which appends
					// extend in place, so the awaited handler gets a snapshot.
					branchEntries: pathEntries.slice(),
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
				({ summary, firstKeptEntryId, tokensBefore, details, usage } = await this._compactWithRefusalModelRetry(
					preparation,
					{ model, apiKey, headers, customInstructions, signal, summaryCall },
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
		// The rebuild synthesizes switch notices from the ledger; a still-pending
		// deferred copy would land a second time on the next flush.
		this._pendingModelChangeMessages = [];
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

	/**
	 * The summarization core of _performCompaction, with the one CC 2.1.282 retry:
	 * a refusal is a verdict of the model that answered, not of the request, so the
	 * next configured fallback model gets a single attempt at the same summary.
	 * Only when no fallback can serve, or it fails too, does the refusal reach the
	 * caller as a compaction failure and count toward the consecutive-failure
	 * streak. The fallback is one-shot for this summarization only - the session
	 * model does not switch.
	 */
	private async _compactWithRefusalModelRetry(
		preparation: CompactionPreparation,
		options: {
			model: Model<any>;
			apiKey: string;
			headers?: Record<string, string>;
			customInstructions?: string;
			signal: AbortSignal;
			summaryCall: SummaryCallRunner;
		},
	): Promise<CompactionResult> {
		const runCompact = (compactModel: Model<any>, compactApiKey: string, compactHeaders?: Record<string, string>) =>
			compact(
				preparation,
				compactModel,
				compactApiKey,
				compactHeaders,
				options.customInstructions,
				options.signal,
				this.thinkingLevel,
				options.summaryCall,
				providerRetryPolicy(this.settingsManager),
				this.sessionId,
			);
		try {
			return await runCompact(options.model, options.apiKey, options.headers);
		} catch (error) {
			if (!(error instanceof SummarizationRefusalError) || options.signal.aborted) throw error;
			const fallback = this._resolveNextFallbackModel();
			if (!fallback) throw error;
			let fallbackAuth: { apiKey: string; headers?: Record<string, string>; requestModel: Model<Api> };
			try {
				fallbackAuth = await this._getRequiredRequestAuth(fallback);
			} catch {
				// A chain entry whose auth cannot serve is no retry at all: the original
				// refusal is the failure the caller should see.
				throw error;
			}
			sessionLog.warn("compaction summarization refused; retrying once on a fallback model", {
				sessionId: this.sessionId,
				refusedProvider: options.model.provider,
				refusedModel: options.model.id,
				fallbackProvider: fallback.provider,
				fallbackModel: fallback.id,
			});
			return await runCompact(fallbackAuth.requestModel, fallbackAuth.apiKey, fallbackAuth.headers);
		}
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

	_localHarnessStateDir(): string | undefined {
		return (
			getLocalHarnessStateDir(this.sessionManager.ensureSessionArtifactDir()) ??
			(this._rlmSessionDir ? getLocalHarnessStateDir(this._rlmSessionDir) : undefined)
		);
	}

	_autoRefineAllowedForSession(): boolean {
		return autoRefineAllowedForSession(this);
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

	_cancelPostCompactionContinue(): void {
		this._postCompactionContinuationScheduled = false;
		this._scheduledPostCompactionContinuationMessages = [];
		this._settlePostCompactionContinue();
	}

	_discardPendingAutoRefine(options: { cancelPostCompactionContinue?: boolean } = {}): void {
		discardPendingAutoRefine(this, options);
	}

	async _invalidatePendingAutoRefineForBranchChange(): Promise<void> {
		return invalidatePendingAutoRefineForBranchChange(this);
	}

	_refineFailureReceipts = new WeakSet<object>();
	_emitRefineFailed(error: unknown, scope: HarnessScope = "local"): void {
		emitRefineFailed(this, error, scope);
	}

	_consumePendingRequestedRefine(): boolean {
		return consumePendingRequestedRefine(this);
	}

	_scheduleAutoRefineAfterAgentEnd(): void {
		scheduleAutoRefineAfterAgentEnd(this);
	}

	_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void {
		scheduleAutoRefineAfterCompaction(this, willContinueAfterCompaction);
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
					this._refreshAgentLoopRuntimeSettings();
					// Idle between runs: deferred switch notices land ahead of the
					// continuation's first request.
					this._flushPendingModelChangeMessages();
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

	_shouldSkipAutoRefineForActiveAgent(): boolean {
		return shouldSkipAutoRefineForActiveAgent(this);
	}

	_scheduleDeferredAutoRefineIfIdle(): void {
		scheduleDeferredAutoRefineIfIdle(this);
	}

	_scheduleAutoRefine(reason: AutoRefineReason, branchVersion = this._autoRefineBranchVersion): void {
		scheduleAutoRefine(this, reason, branchVersion);
	}

	async _maybeAutoRefine(reason: AutoRefineReason): Promise<void> {
		return maybeAutoRefine(this, reason);
	}

	async _runApprovedRefine(reason: AutoRefineReason, review: AutoRefineReview): Promise<void> {
		return runApprovedRefine(this, reason, review);
	}

	async _reviewAutoRefine(context: AutoRefineReviewRequest, signal?: AbortSignal): Promise<AutoRefineReview> {
		return runAutoRefineReview(this, context, signal);
	}

	private _prepareHarnessDigest(): PreparedHarnessDigest {
		return prepareHarnessDigest(this);
	}

	private _harnessDigestWithFingerprint(): { digest: string; stateFingerprint: string; state: HarnessState } {
		return harnessDigestWithFingerprint(this);
	}

	private _noteHarnessDigestToolFaceChange(): void {
		noteHarnessDigestToolFaceChange(this);
	}

	private _ensureHarnessDigestContext(): void {
		ensureHarnessDigestContext(this);
	}

	private _harnessDigestIsFresh(
		latest: { digest: string; stateFingerprint?: string },
		prepared: PreparedHarnessDigest,
	): boolean {
		return harnessDigestIsFresh(latest, prepared);
	}

	private _refreshHarnessDigestIfMateriallyChanged(): void {
		refreshHarnessDigestIfMateriallyChanged(this);
	}

	private _invalidateHarnessDigestBaselines(): void {
		invalidateHarnessDigestBaselines(this);
	}

	private _recordHarnessDigestBaselines(state: HarnessState): void {
		recordHarnessDigestBaselines(this, state);
	}

	private _latestContextHarnessDigestDetails():
		| { timestamp: number; digest: string; stateFingerprint?: string }
		| undefined {
		return latestContextHarnessDigestDetails(this);
	}

	_loadMergedHarnessState(): HarnessState {
		return loadMergedHarnessState(this);
	}

	async refine(
		options: {
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		} = {},
		internal: { skipAbort?: boolean; trigger?: "manual" | "auto" } = {},
	): Promise<RefinementResult> {
		return refine(this, options, internal);
	}

	async _waitForRefineIdle(): Promise<void> {
		return waitForRefineIdle(this);
	}

	async _planRefine(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		signal: AbortSignal,
		trigger: "manual" | "auto" = "manual",
	): Promise<RefinementPlan> {
		return planRefine(this, options, signal, trigger);
	}

	async _applyRefine(
		plan: RefinementPlan,
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
		trigger: "manual" | "auto" = "manual",
	): Promise<RefinementResult> {
		return applyRefine(this, plan, options, refineAbort, trigger);
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
		const usageTokens = calculateContextTokens(assistantMessage.usage);
		if (usageTokens > 0) return usageTokens;
		// A zero-usage reply must not read as an empty context (CC 2.1.288): with no
		// usable usage anchor anywhere, price the whole session by content density
		// instead of reporting zero and skipping the autocompact check.
		return estimateContextTokens(this.agent.state.messages).tokens;
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
	 * The context size a model-switch window check reads (fallback chain, backup
	 * model). `getContextUsage()` is the fresh caliber, but right after a
	 * compaction it reports `tokens: null` - the only usage anchors are
	 * pre-compaction - and a bare `estimateContextTokens` anchors on that stale
	 * usage, over-reporting by the summarized-away span. Both failure modes are
	 * the one the threshold caliber (`_estimateThresholdContextTokens`) exists
	 * for: a stale anchor is discarded and the whole current context is priced by
	 * content, the same fallback the estimator uses when no anchor exists.
	 */
	private _estimateCurrentContextTokens(): number {
		const fromUsage = this.getContextUsage()?.tokens;
		if (typeof fromUsage === "number") return fromUsage;
		const messages = this.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex === null) return estimate.tokens;
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		const anchor = messages[estimate.lastUsageIndex];
		const anchorIsStale =
			compactionTimestamp !== undefined && anchor?.role === "assistant" && anchor.timestamp <= compactionTimestamp;
		if (!anchorIsStale) return estimate.tokens;
		let total = 0;
		for (const message of messages) total += estimateTokensByContent(message);
		return total;
	}

	/**
	 * A routed image model overflowed although the owner's session is within the session
	 * model's threshold. Its request was already cut to its window
	 * (imageRouteRequestContext in image-routing.ts), so what is left is the image turn
	 * itself, and compacting the owner's session would lose history without making that
	 * turn fit.
	 */
	private _routedOverflowFitsSession(compactionTimestamp: number | undefined, settings: CompactionSettings): boolean {
		const routed = this.agent.modelOverride?.model;
		if (!routed || !this.model || modelsAreEqual(routed, this.model)) return false;
		const contextTokens = this._estimateThresholdContextTokens(compactionTimestamp);
		if (contextTokens === undefined) return false;
		return !shouldCompact(contextTokens, this._sessionContextWindow(), settings, this._compactionWindowLimits());
	}

	/**
	 * Context window threshold compaction sizes the session against: the session
	 * model's, never a routed image model's. A smaller-window image model reading one
	 * screenshot must not compact the owner's whole session; its request is trimmed to
	 * its window instead (imageRouteRequestContext in image-routing.ts).
	 *
	 * The window is re-resolved from the registry on every read, not taken from the
	 * model object captured at selection time: the registry reloads in place when the
	 * live catalog lands or models.json changes (reloadModelsAfterCatalogChange), and
	 * a provider re-reporting a smaller window for the serving model (a gateway cap)
	 * must reach the trigger without waiting for a re-pick or a restart. When the
	 * registry no longer knows the model (a synthetic custom-id model), the captured
	 * object's window stands.
	 */
	private _sessionContextWindow(): number {
		const model = this.model;
		return model ? this._registryContextWindow(model) : 0;
	}

	/**
	 * The registry's current window for a model, falling back to the captured model
	 * object when the registry no longer knows it (a synthetic custom-id model).
	 */
	private _registryContextWindow(model: Model<any>): number {
		const resolved = this._modelRegistry.find(model.provider, model.id)?.contextWindow;
		return resolved && resolved > 0 ? resolved : (model.contextWindow ?? 0);
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
		const runModel = this._runModel();
		const contextWindow = runModel ? this._registryContextWindow(runModel) : 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model. A routed image-model turn keeps
		// its override, so its overflow errors recover like the session model's own.
		const sameModel =
			runModel !== undefined &&
			assistantMessage.provider === runModel.provider &&
			assistantMessage.model === runModel.id;

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
			(this._compactionEnabledForCurrentModel() || this._pendingRequestedCompaction !== undefined) &&
			sameModel &&
			isContextOverflow(assistantMessage, contextWindow) &&
			!this._routedOverflowFitsSession(compactionTimestamp, settings)
		) {
			if (this._overflowRecovery !== "idle") {
				if (this._overflowRecovery === "attempted") {
					this._overflowRecovery = "reported";
					// The compact-and-retry did not fit the context, so the second
					// overflow is the signal that summarization alone cannot get the
					// session under the window (e.g. one uncompactably large tail).
					// Spend the lossy valve once before declaring the episode
					// terminal; only a shrink that cannot run or cannot reach the
					// target is the terminal failure.
					this._registerCompactionFailure();
					const shrink = await this._runEmergencyContextShrink(
						"overflow",
						`the retry after one compact-and-retry attempt still overflowed (${
							assistantMessage.errorMessage ?? "context overflow"
						})`,
						{ force: true },
					);
					if (shrink.shrunk && shrink.reachedTarget) {
						// Same retry-context rule as the first attempt: the overflow
						// error is history, not something the retry should re-read. The
						// shrink rebuilt the context from the branch, so the error is
						// back - drop it, keeping the shrink's outcome notice at the tail.
						const rebuilt = this.agent.state.messages;
						let tail = rebuilt.length - 1;
						while (tail >= 0 && rebuilt[tail].role === "custom") tail--;
						const tailMessage = tail >= 0 ? rebuilt[tail] : undefined;
						if (tailMessage?.role === "assistant" && tailMessage.stopReason === "error") {
							rebuilt.splice(tail, 1);
						}
						this._schedulePostCompactionContinue(true);
						return true;
					}
					this._endCompactionUnsuccessfully(
						"overflow",
						"failed",
						"Context overflow recovery failed after one compact-and-retry attempt and one emergency context shrink. Try reducing context or switching to a larger-context model.",
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

		this._dropSpentRequestedCompaction();
		if (
			this._pendingRequestedCompaction !== undefined &&
			!this._isThresholdCompactionCoolingDown(this._sessionContextWindow())
		) {
			return await this._runAutoCompaction("requested", false);
		}

		if (!this._compactionEnabledForCurrentModel() || assistantIsFromBeforeCompaction) return false;

		// Case 3: Threshold - context is getting large.
		// Use the full-session estimate so messages appended after the last successful
		// assistant usage are included, matching the /usage context display. The window
		// is the session model's even on a routed image turn: the owner's session is what
		// gets compacted, and the image model reads a trimmed copy when it is smaller.
		const contextTokens = this._getThresholdContextTokens(assistantMessage, compactionTimestamp);
		if (contextTokens === undefined) return false;
		const sessionWindow = this._sessionContextWindow();
		if (shouldCompact(contextTokens, sessionWindow, settings, this._compactionWindowLimits())) {
			if (this._isThresholdCompactionCoolingDown(sessionWindow)) return false;
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
	 * The failure budget of a model-requested compaction: once the pending request
	 * has failed REQUESTED_COMPACTION_MAX_FAILED_ATTEMPTS times, drop it instead of
	 * restoring it for yet another turn boundary, and say so where the owner reads
	 * it. A fresh compact.run request starts with a fresh budget.
	 */
	private _dropSpentRequestedCompaction(): void {
		const pending = this._pendingRequestedCompaction;
		if (pending === undefined) return;
		if ((pending.failedAttempts ?? 0) < REQUESTED_COMPACTION_MAX_FAILED_ATTEMPTS) return;
		this._pendingRequestedCompaction = undefined;
		this._persistCompactionOutcome(
			"requested",
			"failed",
			`Requested compaction gave up after ${pending.failedAttempts} failed attempts; the context is unchanged. The model may request it again, or run /compact by hand.`,
		);
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
		this._consecutiveCompactionSkips = 0;
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
	 * `options.force` skips the failure-streak gate: the overflow-recovery path
	 * calls the valve on the second overflow, where the compaction itself
	 * succeeded (so the streak is short) but the retry still overflowed - the
	 * proof there is the repeated overflow, not a failing summarizer.
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
		options: { force?: boolean } = {},
	): Promise<{ shrunk: boolean; reachedTarget: boolean }> {
		if (!options.force && this._consecutiveCompactionFailures < COMPACTION_EMERGENCY_SHRINK_FAILURES) {
			return { shrunk: false, reachedTarget: false };
		}
		const settings = this.settingsManager.getCompactionSettings();
		const contextWindow = this._sessionContextWindow();
		const threshold = compactionThresholdTokens(contextWindow, settings, this._compactionWindowLimits());
		if (threshold <= 0) return { shrunk: false, reachedTarget: false };
		const branch = this.sessionManager.getBranch();
		const plan = planEmergencyShrink(branch, threshold);
		if (!plan) return { shrunk: false, reachedTarget: false };
		// 记忆-5: the shrink writes no summarizer output of its own, so without a
		// details carry-over the next compaction would read this entry's undefined
		// details and the fact/user-request ledger chain would break (generation and
		// file lists lost). The summary text already carries the dropped span's
		// summaries forward verbatim; adopt the newest superseded compaction's details
		// so the structured ledger continues too. A hook-authored entry's details are
		// extension data, not ours (the same gate prepareCompaction applies), and an
		// entry without details has nothing to adopt - the rendered-block fallback in
		// prepareCompaction covers those, exactly as before.
		let supersededDetails: unknown;
		for (let index = plan.firstKeptEntryIndex - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry?.type !== "compaction") continue;
			if (!entry.fromHook && entry.details !== undefined) supersededDetails = entry.details;
			break;
		}
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
				supersededDetails,
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
		// Same rebuild-vs-deferral rule as the compaction commit: the synthesized
		// notices come from the ledger, so pending copies must not double them.
		this._pendingModelChangeMessages = [];
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
		// A model-issued compact.run request survives an unsuccessful compaction:
		// the manual path already keeps it scheduled on failure ("on failure the
		// request stays scheduled for the next turn boundary"), and the auto path
		// used to drop it - the instructions never reached any summarizer and the
		// request vanished. `??=` so a request issued while this compaction ran is
		// not clobbered. A user abort stays consumed; a manual preemption hands
		// the request to the manual run through the same restore. Restores after a
		// failure or skip count the spent attempt: the gate at the turn boundary
		// drops the request once the budget is exhausted, so a deterministically
		// failing summarizer cannot spin one attempt per turn forever.
		const restorePendingRequest = (countFailure = true) => {
			if (pending === undefined) return;
			const failedAttempts = (pending.failedAttempts ?? 0) + (countFailure ? 1 : 0);
			this._pendingRequestedCompaction ??= { customInstructions: pending.customInstructions, failedAttempts };
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
				if (reason !== "overflow") this._armThresholdCompactionCooldown();
				await this._runEmergencyContextShrink(reason, detail);
				restorePendingRequest();
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
				// Strip the trailing run of failed attempts, not just the last one: a
				// retry chain leaves one errored assistant per attempt on the branch,
				// the compaction rebuild retains them all, and a single slice would
				// leave an earlier failure last - which agent.continue() refuses
				// ("Cannot continue from message role: assistant"), silently killing
				// the scheduled continuation.
				const messages = this.agent.state.messages;
				let stripCount = 0;
				while (stripCount < messages.length) {
					const tail = messages[messages.length - 1 - stripCount];
					if (tail?.role !== "assistant" || (tail as AssistantMessage).stopReason !== "error") break;
					stripCount += 1;
				}
				if (stripCount > 0) {
					this.agent.state.messages = messages.slice(0, -stripCount);
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
				} else {
					// The manual run that preempted this scope inherits the pending
					// compact.run request: _compact captures it after this catch
					// settles (it waits on this scope's operation first). Not a
					// failure: the restore does not spend the request's budget.
					restorePendingRequest(false);
				}
				this._endCompactionUnsuccessfully(
					reason,
					"cancelled",
					`${reason === "requested" ? "Requested c" : "C"}ompaction cancelled`,
					{ aborted: true, customInstructions },
				);
				if (preemptedByManualCompaction && reason === "overflow") {
					// The preempted scope was an overflow recovery with willRetry
					// pending: the manual run compacts the same context, but nothing
					// would re-issue the overflowed request once it settles. Flag
					// the debt so the manual path's tail schedules the retry, and
					// report willRetry so this turn's terminal flow holds off.
					this._preemptedOverflowRecoveryRetry = true;
					return true;
				}
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
				if (reason !== "overflow") this._armThresholdCompactionCooldown();
				// W29-B10: an over-threshold nothing-to-summarize skip is the idle
				// spin - it repeats at every turn boundary and used to count as
				// nothing, so the shrink valve never ran. Count it on its own streak
				// (the failure streak must not move: it also drives the
				// keepRecentTokens halving for the next attempt), and once the spin
				// reaches the same count the failure valve uses, spend the shrink.
				// A transient mid-loop skip stays benign: the next successful
				// compaction clears the streak. Overflow keeps its own valve (the
				// attempted-branch forced shrink); a requested compaction's repeats
				// are bounded by the request's failure budget and the cooldown.
				if (reason === "threshold" && error.emergencyShrink) {
					this._consecutiveCompactionSkips++;
					if (this._consecutiveCompactionSkips >= COMPACTION_EMERGENCY_SHRINK_FAILURES) {
						await this._runEmergencyContextShrink(reason, errorMessage, { force: true });
					}
				}
				restorePendingRequest();
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
			if (reason !== "overflow") this._armThresholdCompactionCooldown();
			// Last resort: a streak of failures leaves the context over the threshold with
			// no way back down, so the valve drops the oldest non-summary context and says
			// so loudly. Runs before resumeAfterFailure so the continuation it schedules
			// sees the shrunken context.
			await this._runEmergencyContextShrink(reason, errorMessage);
			restorePendingRequest();
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
					// An extension switch has no initiating window to exempt: every attached
					// client is a witness and gets the visible notice.
					await this.setModel(model, { changeNotice: { origin: "extension" } });
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
				onUnavailableSkills: (errors) => this._onPythonSkillsUnavailable(errors),
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
			// Deferred one macrotask: the prewarm chain runs skill-content hashing
			// synchronously before its first await, and this build sits inside the
			// daemon create command — inline, that hashing delayed the create
			// response. The kernel still starts at session creation, just after the
			// reply goes out instead of before it.
			setImmediate(() => {
				if (this._disposed) return;
				this._ipythonKernelProvisioner?.prewarm();
			});
		}

		// Subsequent builds are in-process rebuilds (/reload), not a fresh resume.
		this._ipythonRuntimeBuilt = true;
	}

	/**
	 * Skills exposed to the model (system prompt + kernel). The bundled goal
	 * and compact skills are withheld when disabled for this session.
	 */
	_modelVisibleSkills(): Skill[] {
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
			// Inline (not createRlmListSubagentsHostHandler): the handler reads the
			// optional include_terminal flag, which the factory's no-payload shape
			// cannot express. Absent flag = the active roster, the rlm.list_subagents()
			// default.
			"rlm.list_subagents": async (payload) => ({
				subagents: (await this.listRlmSubagents({ includeTerminal: payload.include_terminal === true })).subagents,
			}),
			"rlm.prune_subagents": async (payload) => {
				const rawTargets = payload.targets;
				if (
					rawTargets !== undefined &&
					(!Array.isArray(rawTargets) || rawTargets.some((target) => typeof target !== "string"))
				) {
					throw new Error("rlm.prune_subagents targets must be an array of strings");
				}
				const { pruned } = await this.pruneRlmSubagents(rawTargets as string[] | undefined);
				return { pruned };
			},
			"rlm.collect": createRlmCollectHostHandler(
				(targets, timeoutMs, signal) => this.collectRlmChildren(targets, timeoutMs, signal),
				{
					messageWake: {
						arrivalCount: () => this._agentMessageArrivalCount,
						deliveredCount: () => this._agentMessageDeliveredCount,
						waitForArrival: (since, waitMs, signal) => this._waitForAgentMessageArrival(since, waitMs, signal),
					},
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
			"model.info": async () => {
				// Report the model that will read what the cell submits, not the session
				// model: a routed image turn serves on settings.imageModel, and on an
				// image-free turn of a text-only session model an attached image moves
				// the next request there, so attach_image's vision check judges that model.
				// blockImages and imageModelProblem let the skill name the actual reason an
				// image cannot be seen instead of always asking for an imageModel.
				const runModel = this._runModel();
				const blockImages = this.settingsManager.getBlockImages();
				const route = this.model ? resolveImageModelRoute(this._imageModelRoutingInputs(this.model)) : undefined;
				const servingModel =
					runModel?.input.includes("image") || route?.kind !== "routed" ? runModel : route.override.model;
				const imageModelProblem = route?.kind === "missing" || route?.kind === "unusable" ? route.kind : undefined;
				return {
					id: servingModel?.id ?? null,
					provider: servingModel?.provider ?? null,
					input: servingModel?.input ?? [],
					blockImages,
					...(imageModelProblem
						? { imageModelProblem, imageModel: this.settingsManager.getImageModel() ?? null }
						: {}),
				};
			},
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
						abortAgentMessage: (input) =>
							this.handleAgentMessageHostRequest("agent_message.abort", {
								target: input.target,
								send_queued: input.sendQueued,
							}) as Promise<AgentSessionMessageAbortReceipt>,
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
			// Display-only change tracking for the UI; always set, so the kernel never guesses.
			[CHANGE_TRACKING_ENV_VAR]: this.settingsManager.getChangeTrackingEnabled() ? "1" : "0",
		};
		// The kernel's harness write path reads these three at write time; settings.json is the
		// user-facing surface, so forward the resolved values. An explicit shell export wins over
		// settings: the spawn merges process.env under this dict, so leaving the key out keeps the
		// user's override live.
		if (process.env.PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP === undefined) {
			env.PRIME_AGENT_HARNESS_ENFORCE_INDEX_CAP = this.settingsManager.getHarnessEnforceIndexCap() ? "1" : "0";
		}
		if (process.env.PRIME_AGENT_HARNESS_INDEX_MAX_BYTES === undefined) {
			env.PRIME_AGENT_HARNESS_INDEX_MAX_BYTES = String(this.settingsManager.getHarnessDigestIndexMaxBytes());
		}
		if (process.env.PRIME_AGENT_HARNESS_PATH_VOCABULARY === undefined) {
			env.PRIME_AGENT_HARNESS_PATH_VOCABULARY = this.settingsManager.getHarnessPathVocabulary().join(",");
		}
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
	async _admitChildRlmSessionDir(
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

	_findAssistantEntryForMessage(message: AssistantMessage): SessionMessageEntry | undefined {
		return this.sessionManager
			.getEntries()
			.find((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message === message);
	}

	_createRlmSubagentRuntimeOptions(options: {
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

	async _createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime> {
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

	private _abortRlmSubtree(reason: string): { cancelled: number; failures: number; depth: number } {
		return abortRlmSubtree(this, reason);
	}

	_cancelRlmChildRun(run: RlmChildRun, reason: string): boolean {
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
	_abortRlmChildSessionOnPublish(run: RlmChildRun, child: AgentSession): void {
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

	async _currentActiveSessionId(): Promise<string | undefined> {
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

	async listRlmSubagents(options?: RlmListSubagentsOptions): Promise<RlmListSubagentsResult> {
		return listRlmSubagents(this, options);
	}

	_buildRlmSubagentList(
		listedAgents?: AgentSessionMessageListResult,
		view?: RlmSubagentRosterView,
	): RlmListSubagentsResult {
		return buildRlmSubagentList(this, listedAgents, view);
	}

	async pruneRlmSubagents(targets: string[] = []): Promise<RlmPruneSubagentsResult> {
		return pruneRlmSubagents(this, targets);
	}

	async collectRlmChildren(targets: string[], timeoutMs: number, signal?: AbortSignal): Promise<RlmCollectResult> {
		return collectRlmChildren(this, targets, timeoutMs, signal);
	}

	_rememberClosedRlmChild(childId: string, record: ClosedRlmChildCollectEntry): void {
		this._closedRlmChildCollectEntries.delete(childId);
		this._closedRlmChildCollectEntries.set(childId, record);
		while (this._closedRlmChildCollectEntries.size > CLOSED_RLM_CHILD_COLLECT_ENTRIES_MAX) {
			const oldest = this._closedRlmChildCollectEntries.keys().next().value;
			if (oldest === undefined) break;
			this._closedRlmChildCollectEntries.delete(oldest);
		}
	}

	_isRlmChildHiddenFromCollect(childId: string, run?: RlmChildRun): boolean {
		return (
			run?.detachedDeletion !== undefined ||
			this._deletingRlmChildren.has(childId) ||
			this._deletedRlmChildIds.has(childId) ||
			this._rlmChildCleanupFailures.has(childId)
		);
	}

	async deleteInactiveRlmSubagent(
		childId: string,
		isExternallyRunning: () => boolean = () => false,
	): Promise<"deleted" | "not_found" | "running"> {
		return deleteInactiveRlmSubagent(this, childId, isExternallyRunning);
	}

	async deleteRlmSubagent(target: string): Promise<RlmDeleteSubagentResult> {
		return deleteRlmSubagent(this, target);
	}

	_ensureRlmRunDeletionCleanup(run: RlmChildRun, session: AgentSession): Promise<void> {
		return ensureRlmRunDeletionCleanup(this, run, session);
	}

	async _finishRlmRunDeletion(run: RlmChildRun): Promise<void> {
		return finishRlmRunDeletion(this, run);
	}

	_observeRlmRunDeletionCleanup(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
		cleanup: Promise<void>,
	): Promise<boolean> {
		return observeRlmRunDeletionCleanup(this, run, subagent, session, cleanup);
	}

	private _rlmChildRunForNotice(childId: string): RetiredRlmChildRun | undefined {
		return rlmChildRunForNotice(this, childId);
	}

	_removeRlmSubagentTracking(childId: string, run?: RlmChildRun): void {
		removeRlmSubagentTracking(this, childId, run);
	}

	registerRlmChildSession(childId: string, session: AgentSession, unsubscribe?: () => void): boolean {
		return registerRlmChildSession(this, childId, session, unsubscribe);
	}

	releaseRlmChildSession(childId: string, session: AgentSession): (() => void) | false {
		return releaseRlmChildSession(this, childId, session);
	}

	_watchRlmChildFollowUps(childId: string, child: AgentSession): void {
		watchRlmChildFollowUps(this, childId, child);
	}

	_stopRlmChildFollowUpWatch(childId: string): void {
		stopRlmChildFollowUpWatch(this, childId);
	}

	private _stopAllRlmChildFollowUpWatches(): void {
		stopAllRlmChildFollowUpWatches(this);
	}

	_recordRlmChildStallEvent(
		run: RlmChildRun,
		child: AgentSession,
		stage: "warn" | "abort" | "unsettled",
		event: { silentMs: number; thresholdMs: number; diagnostics: StallDiagnostics },
	): void {
		recordRlmChildStallEvent(run, child, stage, event);
	}

	async _deliverRlmChildTerminalOutcome(input: {
		run: RlmChildRun;
		child: AgentSession | undefined;
		sessionName: string;
		parentReplyCountBeforeRun: number;
		deliver: (message: CustomMessage) => Promise<void>;
	}): Promise<void> {
		return deliverRlmChildTerminalOutcome(this, input);
	}

	/**
	 * Re-dispatch facts for one live child run (r4 recovery-shell): the original
	 * task and the model the run used, so the daemon's stall-recovery receipt can
	 * carry a pasteable one-liner for a parent that prefers a fresh worker. Reads
	 * the run registry only - a retained child (no live run) has no candidate,
	 * and the receipt then asks the parent to restate the task instead of
	 * inventing one. Exposed for the daemon executor; deliberately not on the
	 * roster snapshot, where a full prompt would ride every update event.
	 */
	getRlmChildRerouteCandidate(
		childId: string,
	): { prompt: string; model: string; sessionName: string; thinkingLevel?: ThinkingLevel } | undefined {
		const run = this._activeRlmChildRuns.get(childId);
		if (!run || run.detachedDeletion) return undefined;
		return {
			prompt: run.prompt,
			model: `${run.model.provider}/${run.model.id}`,
			sessionName: run.sessionName,
			...(run.session?.thinkingLevel !== undefined ? { thinkingLevel: run.session.thinkingLevel } : {}),
		};
	}

	/** Live recursive child roster from lifecycle state, including nested work under retained parents. */
	getRlmChildSnapshots(): RlmChildAgentSnapshot[] {
		return getRlmChildSnapshots(this);
	}

	/** True when any direct or nested subagent is still running or queued. */
	hasRunningRlmChildren(): boolean {
		return hasRunningRlmChildren(this);
	}

	_rlmChildSessionSnapshot(): AgentSession[] {
		return rlmChildSessionSnapshot(this);
	}

	_hasUnsettledRlmQuiescenceWork(): boolean {
		return hasUnsettledRlmQuiescenceWork(this);
	}

	/** Bounded barrier: every admitted descendant run settled and the resulting parent turns drained. */
	async waitForRlmQuiescence(externalSignal?: AbortSignal): Promise<RlmQuiescenceOutcome> {
		return waitForRlmQuiescence(this, externalSignal);
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
			const retained = session._rlmChildSessions.get(childId)?.session;
			if (retained) {
				const descendantsCancelled = retained.cancelRunningRlmDescendants(reason);
				// A finished child working on a follow-up has no run to cancel: its own
				// turn is the spend, so stopping the child means stopping that turn.
				const turnStopped = retained._stopRlmChildOwnTurn();
				if (descendantsCancelled || turnStopped) return true;
			}
		}
		return false;
	}

	/** Stop this child session's own in-flight work (a follow-up turn), as a user Esc would. */
	private _stopRlmChildOwnTurn(): boolean {
		if (!this.isSessionActive) return false;
		this.requestAbort({ reason: "user" });
		return true;
	}

	*_rlmSubtreeSessions(): Generator<AgentSession> {
		yield* rlmSubtreeSessions(this);
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

	/**
	 * Every child name this session knows, seeding the set from the transcript on
	 * first use: a re-opened session's only memory of a child a previous process
	 * deleted or closed is the spawn record its cell left (an "ok" subagent
	 * activity's label is the admitted name).
	 */
	_rlmHistoricalChildNamesNow(): Set<string> {
		if (this._rlmHistoricalChildNamesSeeded) return this._rlmHistoricalChildNames;
		this._rlmHistoricalChildNamesSeeded = true;
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult") continue;
			const activities = (message.details as { activities?: unknown } | undefined)?.activities;
			if (!Array.isArray(activities)) continue;
			for (const activity of activities) {
				if (typeof activity !== "object" || activity === null) continue;
				const record = activity as { kind?: unknown; status?: unknown; label?: unknown };
				if (record.kind !== "subagent" || record.status !== "ok") continue;
				if (typeof record.label !== "string" || record.label.trim() === "") continue;
				this._rlmHistoricalChildNames.add(record.label.trim());
			}
		}
		return this._rlmHistoricalChildNames;
	}

	/**
	 * The numbered successor for a re-used child name (`name-2`, `name-3`, ...),
	 * or undefined when the name is fresh. Only reached once the requested name
	 * itself passed the availability gate, so the earlier bearer is gone (deleted
	 * or idle-closed) and only its display rows remain; the minted candidate is
	 * reserved and availability-checked like a requested name, and a candidate
	 * that fails either check is skipped. The returned name stays reserved until
	 * the caller's reservation release runs.
	 */
	async _mintRlmSuccessorSessionName(requested: string | undefined): Promise<string | undefined> {
		if (requested === undefined) return undefined;
		const historical = this._rlmHistoricalChildNamesNow();
		if (!historical.has(requested)) return undefined;
		for (let n = 2; n < 1000; n++) {
			const suffix = `-${n}`;
			const candidate = `${requested.slice(0, RLM_SUCCESSOR_SESSION_NAME_CAP - suffix.length)}${suffix}`;
			if (historical.has(candidate) || this._pendingRlmSubagentSessionNames.has(candidate)) continue;
			this._pendingRlmSubagentSessionNames.add(candidate);
			try {
				await this._assertRlmSubagentSessionNameAvailable(candidate, true);
			} catch {
				this._pendingRlmSubagentSessionNames.delete(candidate);
				continue;
			}
			return candidate;
		}
		return undefined;
	}

	async _assertRlmSubagentSessionNameAvailable(name: string, ignorePendingReservation = false): Promise<void> {
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

	async _authenticatedRlmModels(): Promise<Model<Api>[]> {
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

	async _resolveRlmSubagentModel(
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
		return startRlmChildRun(this, prompt, kwargs, spawnCode, signal);
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

		const runModel = this._runModel();
		const contextWindow = runModel ? this._registryContextWindow(runModel) : 0;
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

		// Content inspection refusing the request's input is never cured by resending
		// the same bytes, but it is by different ones: the recovery below withholds the
		// tool output that tripped the filter, or moves to another provider.
		if (this._isInputInspectionRejection(message)) return true;
		// An expired or revoked key stays rejected on its provider, yet a fallback
		// model on another provider can carry the task.
		if (this._permanentAuthFallbackModel(message) !== undefined) return true;

		// The provider answered that the request itself is unacceptable (refusal,
		// invalid request, auth). Resending the same bytes asks the same question and
		// bills a second full-context request for the same answer: a retry only helps
		// when it sends something different. `_retryAttempt` gates below must not be
		// able to resurrect this class - the failing shape this guards was a
		// "permanent" failure that was retried once anyway because the check asked
		// "did we already retry?". One exception, per upstream #2375: a 404 lands in
		// the wait-for-recovery "transient" class (routing blips on live models), so
		// the bounded wait loop and backup routing get to handle it.
		if (
			this._isStructuredPermanentProviderFailure(message) &&
			providerWaitClass(
				this._getProviderStreamFailureKind(message),
				providerStreamFailureStatus(message),
				message.errorMessage,
			) === "permanent"
		) {
			return false;
		}

		return true;
	}

	/**
	 * The fallback model for a failure that stays permanent on its provider (an
	 * expired or revoked key): one on a different provider, once the single auth
	 * retry has run. Undefined when the failure is not that shape or no model of
	 * the chain qualifies.
	 */
	private _permanentAuthFallbackModel(message: AssistantMessage): Model<any> | undefined {
		if (message.stopReason !== "error" || this._retryAttempt === 0) return undefined;
		const kind = this._getProviderStreamFailureKind(message);
		const status = providerStreamFailureStatus(message);
		if (providerWaitClass(kind, status, message.errorMessage) !== "permanent") return undefined;
		if (kind !== "auth" && kind !== "permission" && !this._isConcreteProviderAuthFailure(message)) return undefined;
		return this._resolveNextFallbackModel({ otherProviderThan: message.provider });
	}

	/**
	 * Whether the provider's content inspection refused this request's input. The
	 * code survives in different places depending on the provider path: the raw
	 * error text (openai-completions keeps the body verbatim), the structured
	 * provider type, or the diagnostic's own error.
	 */
	private _isInputInspectionRejection(message: AssistantMessage): boolean {
		if (message.stopReason !== "error") return false;
		const failure = message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure");
		const providerErrorType = providerStreamFailureDetails(message)?.providerErrorType;
		const diagnosticError = (failure?.error as { message?: unknown } | undefined)?.message;
		return [message.errorMessage, providerErrorType, diagnosticError].some(
			(text) => typeof text === "string" && isInputContentInspectionRejection(text),
		);
	}

	/** The next model's ladder starts with a clean request pool: switching models is recovery, not amplification. */
	_startFreshRequestLadder(): void {
		peekProviderRequestBudget(this.sessionId)?.reset();
	}

	/** Hand the session's retry envelope to the loop before it creates the chain on its first request. */
	private _configureCrossLayerRequestBudget(): void {
		configureProviderRequestBudget(this.sessionId, this._crossLayerRequestCeiling());
	}

	private _crossLayerRequestCeiling(): number {
		const policy = providerRetryPolicy(this.settingsManager);
		const sessionAttempts = (policy.enabled ? policy.maxRetries : 0) + 1;
		// The ceiling covers the whole in-place ladder, slow tier included: a deeper
		// ladder buys a proportionally higher ceiling instead of silently tripping it.
		const emptyTurnSettings = this.settingsManager.getEmptyTurnRetrySettings();
		const emptyTurnAttempts =
			(emptyTurnSettings.maxAttempts ?? EMPTY_TURN_RETRY_DEFAULTS.maxAttempts) +
			(emptyTurnSettings.escalatedAttempts ?? ESCALATED_EMPTY_TURN_RETRY_DEFAULTS.escalatedAttempts);
		return sessionAttempts * Math.max(1, emptyTurnAttempts);
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
		// The loop usually created the chain first; the explicit ceiling moves it to this
		// session's envelope instead of leaving it at the loop's default.
		return getProviderRequestBudget(this.sessionId, this._crossLayerRequestCeiling());
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

	_markProviderAuthStaleForRetryFailure(
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
	 * Close the live retry chain when an overflow compaction takes over the turn.
	 * Same ledger cleanup as a failure close (idempotent without a live chain,
	 * backup restore, counter reset), but the end event is not a failure: the
	 * task continues through the compaction, and a success:false here painted
	 * one fake "retry failed" per overflow (review 2026-10-04, new issue 8).
	 */
	private _finishActiveRetryForCompactionHandoff(message: AssistantMessage): void {
		if (this._retryAttempt === 0) {
			return;
		}
		// Same auth-stale bookkeeping a failure close performs: the chain's
		// captured sources still describe a provider that rejected this episode.
		this._markProviderAuthStaleForRetryFailure(message);
		const restoredModel = this._restorePrimaryModelAfterBackup();
		this._emit({
			type: "auto_retry_end",
			success: true,
			attempt: this._retryAttempt,
			supersededByCompaction: true,
			...(restoredModel ? { restoredModel } : {}),
		});
		this._terminalFailureAttemptCount = this._retryAttempt;
		this._retryAttempt = 0;
		this._providerWait = undefined;
		this._retryAuthFailureSources = [];
	}

	/**
	 * Queue the one-shot recovery continuation for an exhausted empty-response ladder
	 * (r4 recovery): the failure shape goes back to the model as a custom message that
	 * wakes an idle session, so the task gets a turn to recover itself instead of a
	 * silent stop. Returns false - and leaves the episode terminal - when the budget is
	 * spent, the feature is off, the run was aborted between attempts, or admission is
	 * paused; every one of those still gets the exhausted event and the caller's
	 * terminal flow.
	 */
	private _queueEmptyTurnRecoveryTurn(message: AssistantMessage): boolean {
		if (this._disposed || this._disposing) return false;
		const settings = this.settingsManager.getEmptyTurnRecoverySettings();
		if (!settings.enabled) return false;
		// One continuation per failure episode. A recovery turn that itself exhausts
		// the ladder is the second generation; the hard stop is what keeps a provider
		// that answers empty forever from turning recovery into a self-loop.
		if (this._emptyTurnRecoveryUsed >= settings.maxContinuations) return false;
		const details = this._readEmptyTurnExhaustionDetails(message);
		// An aborted run is an intentional stop: a recovery turn would fight the abort
		// the user or the watchdog already chose.
		if (details.terminatedBy === "abort") return false;
		const recoveryGeneration = this._emptyTurnRecoveryUsed + 1;
		// r4 v1 hook (default off, key reserved): when the backup-model gear lands, the
		// switch happens here - route this recovery turn through
		// `_resolveBackupModel()` + the switch half of `_handleBackupModelRetry`, so
		// the restore-after-success bookkeeping stays the one mechanism. The
		// `useBackupModel` setting is registered but consumes nothing in this build.
		const recoveryMessage = createEmptyResponseRecoveryMessage({
			attempts: details.attempts,
			waitedMs: details.waitedMs,
			escalatedAttempts: details.escalatedAttempts,
			escalatedWaitedMs: details.escalatedWaitedMs,
			terminatedBy: details.terminatedBy,
			maxContinuations: settings.maxContinuations,
			recoveryGeneration,
			...(message.provider === undefined ? {} : { provider: message.provider }),
			...(message.model === undefined ? {} : { model: message.model }),
			...(details.requestBudget === undefined ? {} : { requestBudget: details.requestBudget }),
		});
		try {
			const action = this._createPreparedTurnAction("followUp", recoveryMessage.content as string, undefined, {
				message: recoveryMessage,
				suppressAutonomousContinuation: true,
				// An idle session must be woken to run the recovery turn (the async-bash
				// completion notices admit with the same shape).
				resumeIfIdle: true,
				source: "internal",
				executionPolicy: this._turnExecutionPolicy("injected"),
				queueVisible: false,
			});
			const result = this._admitSessionInput(action, { wake: false });
			if (!result.accepted) {
				sessionLog.warn("empty-response recovery continuation was not admitted", {
					sessionId: this.sessionId,
				});
				return false;
			}
		} catch (error) {
			// A paused admission window (compaction, update restart) must not silently
			// burn the budget: leave the episode terminal instead of parking a
			// half-admitted turn that may never run.
			sessionLog.warn("empty-response recovery continuation could not be admitted; the run stays terminal", {
				sessionId: this.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		this._emptyTurnRecoveryUsed = recoveryGeneration;
		this._scheduleSessionInputPump();
		return true;
	}

	/**
	 * Queue the one-shot recovery continuation for an exhausted provider retry
	 * ladder: the failure shape goes back to the model as a custom message that
	 * wakes an idle session, so the task gets a turn to recover - or to say exactly
	 * what it needs - instead of a silent stop. Returns false, leaving the episode
	 * terminal, when the episode's recovery was already spent or admission is
	 * paused; the caller's terminal flow still runs then.
	 */
	private _queueProviderFailureRecoveryTurn(message: AssistantMessage): boolean {
		if (this._disposed || this._disposing) return false;
		// One continuation per failure episode. A recovery turn that itself exhausts
		// the ladder is the hard stop: a provider that never answers must not turn
		// recovery into a self-loop.
		if (this._providerFailureRecoveryUsed >= 1) return false;
		const recoveryMessage = createProviderFailureRecoveryMessage({
			attempts: this._terminalFailureAttemptCount,
			waitClass: providerWaitClass(
				providerStreamFailureKind(message),
				providerStreamFailureStatus(message),
				message.errorMessage,
			),
			...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
			...(message.provider === undefined ? {} : { provider: message.provider }),
			...(message.model === undefined ? {} : { model: message.model }),
		});
		try {
			const action = this._createPreparedTurnAction("followUp", recoveryMessage.content as string, undefined, {
				message: recoveryMessage,
				suppressAutonomousContinuation: true,
				// An idle session must be woken to run the recovery turn (the async-bash
				// completion notices admit with the same shape).
				resumeIfIdle: true,
				source: "internal",
				executionPolicy: this._turnExecutionPolicy("injected"),
				queueVisible: false,
			});
			const result = this._admitSessionInput(action, { wake: false });
			if (!result.accepted) {
				sessionLog.warn("provider-failure recovery continuation was not admitted", {
					sessionId: this.sessionId,
				});
				return false;
			}
		} catch (error) {
			// A paused admission window (compaction, update restart) must not silently
			// burn the budget: leave the episode terminal instead of parking a
			// half-admitted turn that may never run.
			sessionLog.warn("provider-failure recovery continuation could not be admitted; the run stays terminal", {
				sessionId: this.sessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
		this._providerFailureRecoveryUsed = 1;
		this._scheduleSessionInputPump();
		return true;
	}

	/** The exhaustion diagnostic's facts, with safe defaults when a fixture omits it. */
	private _readEmptyTurnExhaustionDetails(message: AssistantMessage): {
		attempts: number;
		waitedMs: number;
		escalatedAttempts: number;
		escalatedWaitedMs: number;
		terminatedBy: string;
		requestBudget?: { used: number; maxRequests?: number };
	} {
		const diagnostic = message.diagnostics?.find(
			(candidate) => candidate.type === EMPTY_TURN_RETRY_EXHAUSTED_DIAGNOSTIC_TYPE,
		);
		const details = (diagnostic?.details ?? {}) as {
			attempts?: number;
			waitedMs?: number;
			escalatedAttempts?: number;
			escalatedWaitedMs?: number;
			terminatedBy?: string;
			requestBudget?: { used: number; maxRequests?: number };
		};
		return {
			attempts: details.attempts ?? 1,
			waitedMs: details.waitedMs ?? 0,
			escalatedAttempts: details.escalatedAttempts ?? 0,
			escalatedWaitedMs: details.escalatedWaitedMs ?? 0,
			terminatedBy: details.terminatedBy ?? "attempts",
			...(details.requestBudget === undefined ? {} : { requestBudget: details.requestBudget }),
		};
	}

	/**
	 * The terminal form of an exhausted ladder: a structured event plus one log line.
	 * Emitted only when no recovery continuation was queued - while a recovery turn is
	 * pending, the episode is still live.
	 */
	private _emitEmptyResponseExhausted(message: AssistantMessage): void {
		const details = this._readEmptyTurnExhaustionDetails(message);
		this._emit({
			type: "empty_response_exhausted",
			message: message.errorMessage ?? "Model returned empty responses until the retry ladder was exhausted.",
			attempts: details.attempts,
			waitedMs: details.waitedMs,
			escalatedAttempts: details.escalatedAttempts,
			escalatedWaitedMs: details.escalatedWaitedMs,
			terminatedBy: details.terminatedBy,
			recoveryContinuations: this._emptyTurnRecoveryUsed,
			...(message.provider === undefined ? {} : { provider: message.provider }),
			...(message.model === undefined ? {} : { model: message.model }),
		});
		sessionLog.error("empty-response retry ladder exhausted; the run ended without model output", {
			sessionId: this.sessionId,
			...details,
			recoveryContinuations: this._emptyTurnRecoveryUsed,
		});
	}

	/**
	 * Real retry facts for an empty-response terminal (r4 recovery, K3 ①-C): replaces
	 * the "non-retryable; no retries attempted" misreport - the ladder did retry, in
	 * place, and the parent can act on the actual counts.
	 */
	private _emptyTurnTerminalRetrySummary(message: AssistantMessage): string | undefined {
		if (!isEmptyTurnRetryExhausted(message)) return undefined;
		const details = this._readEmptyTurnExhaustionDetails(message);
		const recoverySuffix =
			this._emptyTurnRecoveryUsed > 0
				? ` plus ${this._emptyTurnRecoveryUsed} recovery continuation(s) that also came back empty`
				: "";
		return (
			`empty-response ladder exhausted after ${details.attempts} in-place provider attempt(s) ` +
			`(${details.escalatedAttempts} in the slow tier, waited ${Math.round(details.waitedMs / 1000)}s, ` +
			`stopped by ${details.terminatedBy})${recoverySuffix}`
		);
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
		// A live quota park owns the resume: the parked turn's error is the park's
		// pause, not the child's death, so the parent hears nothing until the wake
		// (or a spent park budget, which clears the park first) settles it. The
		// goal layer holds the same line in _finishGoalForTerminalAssistantMessage.
		if (this._quotaPark !== undefined) return;
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
		// An empty-response terminal is the one class that never reaches this loop, so
		// its summary comes from the ladder's own diagnostic instead of the misreport
		// "non-retryable; no retries attempted" (K3 ①-C).
		const emptyTurnSummary = this._emptyTurnTerminalRetrySummary(message);
		const retryPolicy = providerRetryPolicy(this.settingsManager);
		const attempts = this._terminalFailureAttemptCount;
		const retrySummary =
			emptyTurnSummary ??
			(attempts > 0
				? retryPolicy.enabled && attempts >= retryPolicy.maxRetries
					? `auto-retry exhausted after ${attempts} attempt(s)`
					: `auto-retry stopped after ${attempts} attempt(s)`
				: retryPolicy.enabled
					? "error classified as non-retryable; no retries attempted"
					: "auto-retry disabled; no retries attempted");
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
			// Same terminal shape as a spent ladder: agent_end hands the failure back
			// to the model as one recovery turn before the episode is terminal.
			this._providerFailureRecoveryPending = true;
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

		if (this._isInputInspectionRejection(message)) {
			return this._handleContentInspectionRejection(message, options);
		}

		const waitClass = providerWaitClass(
			providerStreamFailureKind(message),
			providerStreamFailureStatus(message),
			message.errorMessage,
		);

		// An expired or revoked key after its one retry: another provider's model of the
		// chain takes the task instead of the session dying on a key nobody can renew
		// while the owner is away.
		if (waitClass === "permanent") {
			const next = this._permanentAuthFallbackModel(message);
			if (next) return this._handleFallbackRetry(message, options, next, waitClass, { deadKey: true });
		}

		// User-defined backup model (settings.providerBackupModel, default none):
		// route the failed turn to the backup instead of waiting while the
		// primary is quota-blocked or its provider is unavailable. The guard
		// compares against the model serving the run, so a backup equal to a
		// routed turn's image model is recognized as the duplicate it is instead
		// of reporting a no-op backup switch with a zero-delay retry.
		if (waitClass !== "permanent") {
			const backupModel = this._resolveBackupModel();
			if (backupModel && !modelsAreEqual(this._runModel(), backupModel)) {
				return this._handleBackupModelRetry(message, options, backupModel);
			}
		}

		// Fallback chain: quota exhaustion moves to the next model at once; a wait
		// on this model buys nothing for an owner who is away.
		if (waitClass === "quota") {
			const next = this._resolveNextFallbackModel();
			if (next) return this._handleFallbackRetry(message, options, next, waitClass);
			// The routed image model ran out, not the session model: the task must not
			// park on the image model's credit.
			if (this._isImageRoutedRun()) return this._handBackFailedImageAttempt(message, options, waitClass);
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
			// Quick retries exhausted on an unavailable provider: try the next model
			// of the fallback chain before waiting on this one.
			if (waitClass === "transient") {
				const next = this._resolveNextFallbackModel();
				if (next) return this._handleFallbackRetry(message, options, next, waitClass);
				if (this._isImageRoutedRun()) return this._handBackFailedImageAttempt(message, options, waitClass);
			}
			// Otherwise keep pinging with bounded exponential backoff instead of giving up.
			if (waitClass === "transient" && waitPolicy.enabled) {
				return this._handleProviderWait(message, options, waitPolicy, "unavailable");
			}
			// The ladder is spent. The run is not terminal yet: agent_end hands the
			// failure shape back to the model as one queued recovery turn (once per
			// episode), and only a spent recovery budget ends the run for good.
			this._providerFailureRecoveryPending = true;
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
			// A transient failure whose server-requested wait outgrew the quick-retry cap
			// is not terminal: the bounded wait channel owns long waits (and its own
			// abort bounds), so the run survives a "come back in five minutes".
			if (waitClass === "transient" && waitPolicy.enabled) {
				return this._handleProviderWait(message, options, waitPolicy, "unavailable");
			}
			// Same terminal shape as a spent ladder: agent_end hands the failure back
			// to the model as one recovery turn before the episode is terminal.
			this._providerFailureRecoveryPending = true;
			this._markProviderAuthStaleForRetryFailure(message, options);
			const restoredModel = this._restorePrimaryModelAfterBackup();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: `Provider requested a ${Math.ceil(delay.retryAfterMs / 1000)}s wait before retrying (above retry.provider.maxRetryDelayMs=${maxRetryDelayMs}ms): ${message.errorMessage || "unknown error"}`,
				...(restoredModel ? { restoredModel } : {}),
			});
			this._terminalFailureAttemptCount = this._retryAttempt - 1;
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
	async _retryAfterDelay(
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
		this._recordDutyEvent({
			kind: "provider_retry",
			...(message.provider ? { provider: message.provider } : {}),
			...(message.model ? { model: message.model } : {}),
			...(message.errorMessage ? { error: message.errorMessage } : {}),
			waitMs: delayMs,
		});

		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}
		// The run is idle between the failure and the scheduled continue: deferred
		// switch notices land now, ahead of the retried request.
		this._flushPendingModelChangeMessages();

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
			// re-issue the turn (e.g. onto a quota-blocked primary after a restore),
			// and a disposed session must never run one at all.
			if (this._disposed || this._retryGeneration !== retryGeneration || !this.isRetrying) return;
			this._refreshAgentLoopRuntimeSettings();
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
	 * wait loop runs instead, and never surprises the user with a switch. A
	 * run routed for images also rejects a text-only backup the same way: the
	 * retry then stays on the routed model instead of serving the turn's
	 * images to a model that would silently downgrade them to placeholders.
	 * A backup whose window cannot hold the current context resolves to
	 * undefined too: the retry would just fail again on the backup.
	 */
	private _resolveBackupModel(): Model<any> | undefined {
		const reference = this.settingsManager.getProviderBackupModel();
		if (!reference) return undefined;
		const backupModel = findExactModelReferenceMatch(reference, this._modelRegistry.getAvailable());
		if (!backupModel || !this._modelRegistry.hasConfiguredAuth(backupModel)) {
			return undefined;
		}
		if (this.agent.modelOverride && !backupModel.input.includes("image")) {
			return undefined;
		}
		// The backup takes the turn as-is, context included: a window that cannot
		// hold it would fail the retry on the backup instead of on the primary.
		// Same 0.9 headroom as the fallback chain; when the measured usage is
		// unknowable (right after a compaction), price the context by content.
		if (backupModel.contextWindow > 0) {
			const contextTokens = this._estimateCurrentContextTokens();
			if (contextTokens > backupModel.contextWindow * 0.9) {
				return undefined;
			}
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
		// A routed image-model turn keeps serving on the override, so the backup
		// must take the override too or the retry would silently return to the
		// routed model while reporting the backup.
		const routedOverride = this.agent.modelOverride;
		this.agent.state.model = backupModel;
		// Clamp per-request fields to what the backup supports; all of them are
		// restored when the turn returns to the primary.
		this.agent.state.thinkingLevel = clampThinkingLevel(backupModel, previousThinkingLevel) as ThinkingLevel;
		this._clampServiceTierForModel();
		if (routedOverride) {
			this.agent.modelOverride = {
				model: backupModel,
				thinkingLevel: this.agent.state.thinkingLevel,
				serviceTier: this.agent.state.serviceTier,
			};
		}
		// Session-log the switch so primary->backup->primary transitions stay debuggable.
		this._recordModelChangeForContext({ provider: backupModel.provider, modelId: backupModel.id });
		this._startFreshRequestLadder();
		this._backupModel = {
			backup: backupModel,
			primary: previousModel,
			thinkingLevel: previousThinkingLevel,
			serviceTier: previousServiceTier,
			routedOverride,
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
	 * The next model of the fallback chain that can serve this turn: configured
	 * auth, not already tried this episode, not the serving model or the
	 * primary, image-capable when the run is routed for images or its context
	 * holds images the serving model reads, and with a context window that holds
	 * the current context (so a switch never needs to drop history). A routed
	 * image model walks its own ladder (the run's image episode), since the
	 * session model it serves beside never failed. `otherProviderThan` keeps a
	 * failure bound to one provider (a dead key, a content filter) off that
	 * provider's other models.
	 */
	private _resolveNextFallbackModel(options: { otherProviderThan?: string } = {}): Model<any> | undefined {
		const references = this.settingsManager.getProviderFallbackModels();
		if (references.length === 0) return undefined;
		const key = (model: Model<any>) => `${model.provider}/${model.id}`;
		const excluded = new Set<string>();
		if (this._isImageRoutedRun()) {
			const imageFallback = this._liveImageFallback();
			for (const tried of imageFallback?.tried ?? []) excluded.add(tried);
			if (imageFallback) excluded.add(key(imageFallback.original));
		} else {
			for (const tried of this._fallback?.tried ?? []) excluded.add(tried);
			if (this._fallback) excluded.add(key(this._fallback.primary));
		}
		const serving = this._runModel();
		if (serving) excluded.add(key(serving));
		// Post-compaction the measured usage is unknowable (getContextUsage reports
		// tokens: null): the shared estimator prices the current context by content
		// instead of letting every chain entry pass the window check on a 0, or
		// anchoring on a stale pre-compaction usage and skipping models that fit.
		const contextTokens = this._estimateCurrentContextTokens();
		const available = this._modelRegistry.getAvailable();
		// A run routed for images, or a vision model already reading images in this
		// context, must not move to a model that would silently drop them.
		const needsImages =
			this.agent.modelOverride !== undefined ||
			(serving?.input.includes("image") === true && contextHasImages(this.agent.state.messages));
		for (const reference of references) {
			const candidate = findExactModelReferenceMatch(reference, available);
			if (!candidate) {
				this._reportUnusableFallbackReference(reference);
				continue;
			}
			if (excluded.has(key(candidate))) continue;
			if (!this._modelRegistry.hasConfiguredAuth(candidate)) {
				this._reportUnusableFallbackReference(reference);
				continue;
			}
			if (options.otherProviderThan !== undefined && candidate.provider === options.otherProviderThan) continue;
			if (needsImages && !candidate.input.includes("image")) continue;
			if (candidate.contextWindow > 0 && contextTokens > candidate.contextWindow * 0.9) continue;
			return candidate;
		}
		return undefined;
	}

	/**
	 * A chain entry that can never serve (a typo, a provider that is not logged in,
	 * a missing key) used to be skipped without a word, so the owner believed a
	 * backup stood ready that did not exist. Reported once per session: in the chat,
	 * in the duty log's to-do list, and in the log.
	 */
	private _reportUnusableFallbackReference(reference: string): void {
		if (this._reportedUnusableFallbackReferences.has(reference)) return;
		this._reportedUnusableFallbackReferences.add(reference);
		const known = findExactModelReferenceMatch(reference, this._modelRegistry.getAll()) !== undefined;
		const reason = known ? "没有可用的 API key 或登录已失效" : "找不到这个模型，名字可能写错了";
		sessionLog.warn("provider fallback: chain entry cannot be used", {
			sessionId: this.sessionId,
			reference,
			reason: known ? "no_auth" : "unknown_model",
		});
		this._recordDutyEvent({
			kind: "decision_needed",
			question: `备用模型「${reference}」用不了（${reason}），已跳过；请检查设置里的 providerFallbackModels`,
		});
		this._emitFallbackNotice(
			`备用模型「${reference}」用不了（${reason}），已跳过。请检查设置里的 providerFallbackModels。`,
			{
				kind: "unusable_entry",
				reference,
			},
		);
	}

	/**
	 * Owner-facing notice of a fallback transition: shown in the chat, kept in the
	 * transcript for an owner who comes back later, never part of the model's
	 * context (convertToLlm drops the type). It is not pushed onto the live context
	 * either, so a retry still finds its failed assistant message last.
	 */
	private _emitFallbackNotice(text: string, details: Record<string, unknown>): void {
		const message: CustomMessage = {
			role: "custom",
			customType: PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE,
			content: text,
			display: true,
			details,
			timestamp: Date.now(),
		};
		try {
			this.sessionManager.appendCustomMessageEntry(message.customType, message.content, true, message.details);
		} catch (error) {
			this._reportSessionPersistFailure(error);
		}
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	/** Whether the run is served by a routed image model rather than the session model. */
	private _isImageRoutedRun(): boolean {
		return isImageRoutedRun(this);
	}

	/** The image episode of the current run, or undefined once a new dispatch routed afresh. */
	private _liveImageFallback(): ImageFallbackEpisode | undefined {
		if (this._imageFallback && this._imageFallback.override !== this.agent.modelOverride) {
			this._imageFallback = undefined;
		}
		return this._imageFallback;
	}

	_canFallbackLongWait(): boolean {
		return (
			this.settingsManager.getProviderFallbackModels().length > 0 &&
			this._fallbackLongWaitRound < this.settingsManager.getProviderFallbackLongWait().maxRounds
		);
	}

	private _recordFallbackEntry(data: ProviderFallbackEntryData): void {
		this._appendRecoveryEntry(PROVIDER_FALLBACK_ENTRY_TYPE, data);
	}

	private _appendRecoveryEntry(customType: string, data: unknown): void {
		try {
			this.sessionManager.appendCustomEntry(customType, data);
		} catch (error) {
			sessionLog.warn("could not record a provider recovery entry", {
				sessionId: this.sessionId,
				customType,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Move the serving model onto `next`, remembering the primary to come back to.
	 * When the failing model is a routed image model, only the run's override moves:
	 * the session model the owner chose never failed and must not be replaced.
	 */
	private _applyFallbackModel(
		next: Model<any>,
		cause: string,
		errorMessage: string | undefined,
		reason: "provider_errors" | "bad_tool_calls",
	): void {
		this._startFreshRequestLadder();
		if (this._isImageRoutedRun()) {
			this._applyImageFallbackModel(next, cause, errorMessage, reason);
			return;
		}
		const key = (model: Model<any>) => `${model.provider}/${model.id}`;
		const from = this.agent.state.model;
		if (!this._fallback) {
			// A backup-model retry already moved the session: the episode returns to the
			// model before it, never to the backup.
			const backup =
				this._backupModel && modelsAreEqual(this._backupModel.backup, from) ? this._backupModel : undefined;
			if (backup) this._backupModel = undefined;
			this._fallback = {
				primary: backup?.primary ?? from,
				thinkingLevel: backup?.thinkingLevel ?? this.agent.state.thinkingLevel,
				serviceTier: backup?.serviceTier ?? this.agent.state.serviceTier,
				current: next,
				switchedAtMs: Date.now(),
				tried: backup ? [key(backup.backup)] : [],
			};
		}
		const primaryThinking = this._fallback.thinkingLevel;
		const previousOverride = this.agent.modelOverride;
		this.agent.state.model = next;
		this.agent.state.thinkingLevel = clampThinkingLevel(next, primaryThinking) as ThinkingLevel;
		this._clampServiceTierForModel();
		// An override that is the session model itself (a backup retry that took a
		// routed run) moves with it; a routed image model is a different model.
		if (previousOverride && modelsAreEqual(previousOverride.model, from)) {
			this.agent.modelOverride = {
				model: next,
				thinkingLevel: this.agent.state.thinkingLevel,
				serviceTier: this.agent.state.serviceTier,
			};
		}
		this._fallback.current = next;
		this._fallback.switchedAtMs = Date.now();
		this._fallback.tried.push(key(next));
		this._recordModelChangeForContext({ provider: next.provider, modelId: next.id });
		const fromReference = key(from);
		this._recordFallbackEntry({
			kind: "switch",
			at: Date.now(),
			from: fromReference,
			to: key(next),
			cause,
			...(errorMessage ? { errorMessage } : {}),
			primary: key(this._fallback.primary),
			thinkingLevel: this._fallback.thinkingLevel,
			...(this._fallback.serviceTier ? { serviceTier: this._fallback.serviceTier } : {}),
		});
		this._recordDutyEvent({ kind: "model_fallback", from: fromReference, to: key(next), reason });
		sessionLog.warn("provider fallback: switched model", {
			sessionId: this.sessionId,
			from: fromReference,
			to: key(next),
			cause,
		});
	}

	/** Move one run's routed image model to an image-capable model of the chain. */
	private _applyImageFallbackModel(
		next: Model<any>,
		cause: string,
		errorMessage: string | undefined,
		reason: "provider_errors" | "bad_tool_calls",
	): void {
		const key = (model: Model<any>) => `${model.provider}/${model.id}`;
		const override = this.agent.modelOverride;
		if (!override) return;
		const episode = this._liveImageFallback() ?? { original: override.model, override, tried: [] };
		const moved: AgentModelOverride = {
			model: next,
			thinkingLevel: clampThinkingLevel(next, this.thinkingLevel) as ThinkingLevel,
			serviceTier: this.serviceTier === "priority" && !supportsFastMode(next) ? "default" : this.serviceTier,
		};
		this.agent.modelOverride = moved;
		// The run's image route follows the override, so the handback to the session
		// model after the image is described still happens on the moved model.
		if (this._imageRoute?.override === override) this._imageRoute.override = moved;
		episode.override = moved;
		episode.tried.push(key(next));
		this._imageFallback = episode;
		this._recordFallbackEntry({
			kind: "switch",
			scope: "image",
			at: Date.now(),
			from: key(override.model),
			to: key(next),
			cause,
			...(errorMessage ? { errorMessage } : {}),
		});
		this._recordDutyEvent({ kind: "model_fallback", from: key(override.model), to: key(next), reason });
		sessionLog.warn("provider fallback: moved the routed image model", {
			sessionId: this.sessionId,
			from: key(override.model),
			to: key(next),
			cause,
		});
	}

	/**
	 * A terminal failure that is the provider's deterministic verdict on the serving
	 * model itself (isProviderModelRejection) must not stay on the books: the session
	 * model, the session ledger, and a saved default pointing at the rejected model
	 * all move to a model that can serve, with an owner-visible notice, so a restart
	 * resumes the serving model instead of looping back onto the rejected one. Only
	 * positive rejection evidence reaches this point (unknown availability never
	 * rewrites a stored selection), and the replacement is taken only from what the
	 * registry can serve right now. A live fallback episode owns its own narrative
	 * and is left alone.
	 */
	private _reconcileRejectedModelSelection(message: AssistantMessage): void {
		if (!isProviderModelRejection(message)) return;
		if (this._fallback) return;
		const current = this.agent.state.model;
		if (!current) return;
		// The rejection must name the serving model; a routed image model's failure
		// is that run's own episode and never moves the session model.
		if (
			typeof message.provider === "string" &&
			typeof message.model === "string" &&
			(message.provider !== current.provider || message.model !== current.id)
		) {
			return;
		}
		// The configured image model only ever answered routed image turns: it is a
		// cheap vision helper, not a session driver, and it is often the last model
		// that served anything beside the rejected one. Moving the session - and a
		// saved default - onto it would turn one rejection into a silent downgrade,
		// so it is skipped in both resolution paths; when nothing else can serve,
		// the selection stands for the owner to fix.
		const imageRoute = this._imageRouteModel();
		const candidate = this._lastServingModel(current, imageRoute) ?? this._registryDefaultModel(current, imageRoute);
		if (!candidate) return;
		this.agent.state.model = candidate;
		this._clearModelOverrideWhenIdle();
		this._recordModelChangeForContext({ provider: candidate.provider, modelId: candidate.id });
		// A saved default pointing at the rejected model is the same stale selection:
		// move it with the session. A default naming another model is somebody else's
		// choice and is left alone.
		if (
			this.settingsManager.getDefaultProvider() === current.provider &&
			this.settingsManager.getDefaultModel() === current.id
		) {
			this.settingsManager.setDefaultModelAndProvider(candidate.provider, candidate.id);
		}
		this.setThinkingLevel(clampThinkingLevel(candidate, this.thinkingLevel) as ThinkingLevel);
		this._clampServiceTierForModel();
		const key = (model: Model<any>) => `${model.provider}/${model.id}`;
		const from = key(current);
		const to = key(candidate);
		this._recordDutyEvent({ kind: "model_fallback", from, to, reason: "provider_rejected" });
		sessionLog.warn("provider rejected the session model; reconciled the selection", {
			sessionId: this.sessionId,
			from,
			to,
			errorMessage: message.errorMessage,
		});
		const detail = message.errorMessage?.replace(/\s+/g, " ").trim().slice(0, 200);
		this._emitFallbackNotice(
			`所选模型 ${current.id} 被 ${current.provider} 拒绝（${detail ?? "无详情"}），本会话改由 ${candidate.id} 服役；会话记录和默认模型已同步，重启后也从 ${candidate.id} 恢复。`,
			{ kind: "rejected", from, to },
		);
		this._trackModelSelectEmitError(this._queueModelSelectEmit(candidate, current, "restore"));
	}

	/** The configured image-route helper, resolved against what can serve right now. */
	private _imageRouteModel(): Model<any> | undefined {
		return imageRouteModel(this);
	}

	/** The last model that actually answered on this branch, when it can still serve. */
	private _lastServingModel(exclude: Model<any>, alsoSkip?: Model<any>): Model<any> | undefined {
		for (let index = this.agent.state.messages.length - 1; index >= 0; index -= 1) {
			const message = this.agent.state.messages[index];
			if (message.role !== "assistant") continue;
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			const found = this._modelRegistry.find(message.provider, message.model);
			if (!found || modelsAreEqual(found, exclude) || (alsoSkip !== undefined && modelsAreEqual(found, alsoSkip))) {
				continue;
			}
			if (this._modelRegistry.hasConfiguredAuth(found)) return found;
		}
		return undefined;
	}

	/** The registry's preferred default among what can serve right now, never the rejected model. */
	private _registryDefaultModel(exclude: Model<any>, alsoSkip?: Model<any>): Model<any> | undefined {
		const available = this._modelRegistry
			.getAvailable()
			.filter(
				(model) => !modelsAreEqual(model, exclude) && (alsoSkip === undefined || !modelsAreEqual(model, alsoSkip)),
			);
		if (available.length === 0) return undefined;
		return findPreferredDefaultModel(available) ?? available[0];
	}

	/**
	 * The routed image model failed and no model of the chain can take images: end
	 * the image attempt and hand the turn back to the session model, which never
	 * failed, with a notice (for the model and the owner) that the image went unread.
	 * Waiting on the image model instead would park the whole task on its credit.
	 */
	private _handBackFailedImageAttempt(
		message: AssistantMessage,
		options:
			| {
					markAuthStaleOnFailure?: boolean;
					authSourceTokens?: readonly AuthSourceToken[];
			  }
			| undefined,
		waitClass: "quota" | "transient",
	): Promise<boolean> {
		const key = (model: Model<any>) => `${model.provider}/${model.id}`;
		const override = this.agent.modelOverride;
		const sessionModel = this.agent.state.model;
		const imageModel = override?.model ?? sessionModel;
		const cause = describeProviderFailureCause(message.provider, message.errorMessage, waitClass);
		this._imageFallback = undefined;
		this.agent.modelOverride = undefined;
		if (override && this.agent.pendingTurnModel === override) this.agent.pendingTurnModel = undefined;
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}
		this._appendCustomMessageToTranscript({
			role: "custom",
			customType: PROVIDER_IMAGE_UNREAD_CUSTOM_TYPE,
			content: createImageUnreadNoticeText(key(imageModel), key(sessionModel), message.errorMessage ?? cause),
			display: false,
			details: { imageModel: key(imageModel), sessionModel: key(sessionModel), cause },
			timestamp: Date.now(),
		});
		this._emitFallbackNotice(
			`看图模型 ${imageModel.id} 暂时用不了（${cause}），备用模型里也没有能看图的，所以这一轮改由 ${sessionModel.id} 接着做——图片没能读取。`,
			{ kind: "image_unread", imageModel: key(imageModel), sessionModel: key(sessionModel) },
		);
		this._recordFallbackEntry({
			kind: "switch",
			scope: "image",
			at: Date.now(),
			from: key(imageModel),
			to: key(sessionModel),
			cause,
			...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
		});
		this._recordDutyEvent({
			kind: "model_fallback",
			from: key(imageModel),
			to: key(sessionModel),
			reason: "image_model_unavailable",
		});
		this._startFreshRequestLadder();
		this._retryAttempt = 1;
		this._providerWait = undefined;
		return this._retryAfterDelay(
			message,
			options,
			{
				type: "auto_retry_start",
				attempt: this._retryAttempt,
				maxAttempts: providerRetryPolicy(this.settingsManager).maxRetries,
				delayMs: 0,
				errorMessage: `${cause}，图片没能读取`,
				reason: "backup",
				backupModel: key(sessionModel),
			},
			0,
		);
	}

	/** Re-issue the failed turn on the next fallback model, with its own quick retries. */
	private _handleFallbackRetry(
		message: AssistantMessage,
		options:
			| {
					markAuthStaleOnFailure?: boolean;
					authSourceTokens?: readonly AuthSourceToken[];
			  }
			| undefined,
		next: Model<any>,
		waitClass: "quota" | "transient" | "permanent",
		failure: { deadKey?: boolean } = {},
	): Promise<boolean> {
		const cause = describeProviderFailureCause(message.provider, message.errorMessage, waitClass);
		if (failure.deadKey) {
			// A dead key must still reach the owner: mark it stale (the login prompt
			// appears) even though the task goes on elsewhere.
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._retryAuthFailureSources = [];
		}
		this._applyFallbackModel(next, cause, message.errorMessage, "provider_errors");
		this._retryAttempt = 1;
		this._providerWait = undefined;
		return this._retryAfterDelay(
			message,
			options,
			{
				type: "auto_retry_start",
				attempt: this._retryAttempt,
				maxAttempts: providerRetryPolicy(this.settingsManager).maxRetries,
				delayMs: 0,
				errorMessage: cause,
				reason: "backup",
				backupModel: `${next.provider}/${next.id}`,
			},
			0,
		);
	}

	/**
	 * The provider's content inspection refused the request's input (Bailian
	 * `data_inspection_failed`). Resending the same history is refused forever, so
	 * each step changes the bytes instead: withhold the most recent batch of tool
	 * output (up to three batches, walking back), then move to a model on another
	 * provider, and only then stop - telling the owner what happened in every case.
	 */
	private _handleContentInspectionRejection(
		message: AssistantMessage,
		options:
			| {
					markAuthStaleOnFailure?: boolean;
					authSourceTokens?: readonly AuthSourceToken[];
			  }
			| undefined,
	): Promise<boolean> | boolean {
		const name = message.provider ?? "服务商";
		this._inspectionRecoverySteps += 1;
		const step = this._inspectionRecoverySteps;
		sessionLog.warn("provider content inspection rejected the request", {
			sessionId: this.sessionId,
			provider: message.provider,
			model: message.model,
			step,
		});
		if (step <= CONTENT_INSPECTION_WITHHOLD_STEPS) {
			const withheld = this._withholdMostRecentToolOutputs();
			if (withheld > 0) {
				this._emitFallbackNotice(
					`${name} 的内容审核拒绝了这次请求（多半是工具输出里有「攻击」「防火墙」这类词）。已把最近 ${withheld} 条工具输出从对话里隐去，并提示模型换个方式重新获取，正在自动重试。`,
					{ kind: "content_inspection", step, withheld },
				);
				this._startFreshRequestLadder();
				this._retryAttempt += 1;
				this._providerWait = undefined;
				return this._retryAfterDelay(
					message,
					options,
					{
						type: "auto_retry_start",
						attempt: this._retryAttempt,
						maxAttempts: CONTENT_INSPECTION_WITHHOLD_STEPS,
						delayMs: 0,
						errorMessage: `${name} 内容审核拒绝了请求，已隐去最近的工具输出后重试`,
					},
					0,
				);
			}
		}
		const next = this._resolveNextFallbackModel({ otherProviderThan: message.provider });
		if (next) {
			this._emitFallbackNotice(`${name} 的内容审核一直拒绝这段对话，改用另一家服务商的模型 ${next.id} 继续。`, {
				kind: "content_inspection",
				step,
				to: `${next.provider}/${next.id}`,
			});
			return this._handleFallbackRetry(message, options, next, "permanent");
		}
		const finalError =
			step > 1
				? `${name} 的内容审核拒绝了这次请求（data_inspection_failed），隐去最近的工具输出后仍被拒绝，也没有其他服务商的备用模型可换。请换个说法重发，或在设置里加一个其他服务商的备用模型。`
				: `${name} 的内容审核拒绝了这次请求（data_inspection_failed），对话里没有可以隐去的工具输出，也没有其他服务商的备用模型可换。请换个说法重发，或在设置里加一个其他服务商的备用模型。`;
		this._emitFallbackNotice(finalError, { kind: "content_inspection", step, terminal: true });
		const attempt = this._retryAttempt;
		// A retry that never started has no retry to end: the notice alone reports it.
		if (attempt > 0) this._emit({ type: "auto_retry_end", success: false, attempt, finalError });
		this._terminalFailureAttemptCount = attempt;
		this._retryAttempt = 0;
		this._providerWait = undefined;
		this._retryAuthFailureSources = [];
		// The next owner message starts a fresh recovery: it may bring new tool output.
		this._inspectionRecoverySteps = 0;
		this._resolveRetry();
		return false;
	}

	/**
	 * Replace the most recent batch of not-yet-withheld tool results with a short
	 * placeholder, in the live context, and record their ids so a restart or a
	 * context rebuild withholds them again. Returns how many were withheld.
	 */
	private _withholdMostRecentToolOutputs(): number {
		const messages = [...this.agent.state.messages];
		let index = messages.length - 1;
		if (index >= 0 && messages[index].role === "assistant") index -= 1;
		while (index >= 0 && !(messages[index].role === "toolResult" && !isWithheldToolResult(messages[index]))) {
			index -= 1;
		}
		const toolCallIds: string[] = [];
		while (index >= 0 && messages[index].role === "toolResult") {
			const result = messages[index] as ToolResultMessage;
			if (!isWithheldToolResult(result)) {
				messages[index] = withheldToolResult(result);
				toolCallIds.push(result.toolCallId);
			}
			index -= 1;
		}
		if (toolCallIds.length === 0) return 0;
		this.agent.state.messages = messages;
		this._appendRecoveryEntry(PROVIDER_INSPECTION_WITHHELD_ENTRY_TYPE, { at: Date.now(), toolCallIds });
		return toolCallIds.length;
	}

	/** Re-apply recorded withholdings after the context was rebuilt from the transcript. */
	private _reapplyInspectionWithholding(messages: AgentMessage[]): void {
		const ids = new Set<string>();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== PROVIDER_INSPECTION_WITHHELD_ENTRY_TYPE) continue;
			const recorded = (entry.data as { toolCallIds?: unknown } | undefined)?.toolCallIds;
			if (!Array.isArray(recorded)) continue;
			for (const id of recorded) if (typeof id === "string") ids.add(id);
		}
		if (ids.size === 0) return;
		for (let index = 0; index < messages.length; index += 1) {
			const message = messages[index];
			if (message.role !== "toolResult" || !ids.has(message.toolCallId) || isWithheldToolResult(message)) continue;
			messages[index] = withheldToolResult(message);
		}
	}

	/**
	 * Every model of the chain failed and the bounded wait ran out: wait a long
	 * round (5, 10, 20, 20 ... minutes), return to the primary and start the
	 * chain over, instead of ending a task nobody is watching. The in-process wait
	 * dies with the process, so a durable wake job backs it: a restart during the
	 * wait still resumes the task, a live process cancels the job when it wakes.
	 */
	async _handleFallbackLongWait(
		message: AssistantMessage,
		options:
			| {
					markAuthStaleOnFailure?: boolean;
					authSourceTokens?: readonly AuthSourceToken[];
			  }
			| undefined,
	): Promise<boolean> {
		this._fallbackLongWaitRound += 1;
		const round = this._fallbackLongWaitRound;
		const longWait = this.settingsManager.getProviderFallbackLongWait();
		const delayMs = providerLongWaitDelayMs(round, longWait.baseDelayMs, longWait.maxDelayMs);
		this._returnToPrimaryModel("long_wait");
		this._startFreshRequestLadder();
		this._providerWait = undefined;
		this._retryAttempt = 1;
		this._cancelFallbackLongWaitWake();
		const resumeAtMs = Date.now() + delayMs + PROVIDER_LONG_WAIT_WAKE_GRACE_MS;
		const jobId = this._createQuotaResumeJob(
			resumeAtMs,
			PROVIDER_LONG_WAIT_RESUME_CRON_LABEL,
			PROVIDER_LONG_WAIT_RESUME_MARKER_TEXT,
		);
		this._fallbackLongWaitJobId = jobId;
		this._recordFallbackEntry({
			kind: "long_wait",
			at: Date.now(),
			round,
			delayMs,
			cause: describeProviderFailureCause(message.provider, message.errorMessage, "transient"),
			...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
			...(jobId !== undefined ? { jobId, resumeAt: new Date(resumeAtMs).toISOString() } : {}),
		});
		const retried = await this._retryAfterDelay(
			message,
			options,
			{
				type: "auto_retry_start",
				attempt: round,
				maxAttempts: longWait.maxRounds,
				delayMs,
				errorMessage: message.errorMessage || "Unknown error",
				reason: "unavailable",
			},
			delayMs,
		);
		// The in-process wait is over (resumed or cancelled). A dispose is the one exit
		// that must keep the job: the process is going away and the job is the resume.
		if (!this._disposed && !this._disposing) this._cancelFallbackLongWaitWake();
		return retried;
	}

	private _cancelFallbackLongWaitWake(): void {
		const jobId = this._fallbackLongWaitJobId;
		this._fallbackLongWaitJobId = undefined;
		if (jobId !== undefined) this._resolveQuotaResumeJob(jobId);
	}

	/**
	 * Leave the fallback for the primary. Only the session model moves: the run's
	 * image routing is this run's own decision (made at dispatch, after the episode
	 * began), so it is kept. `pendingTurnModel` moves a run the session model is
	 * serving at its next request; `state.model` covers the runs after it. A model
	 * the user picked meanwhile is left alone.
	 */
	private _returnToPrimaryModel(why: "cooldown" | "long_wait"): boolean {
		const fallback = this._fallback;
		this._fallback = undefined;
		if (!fallback) return false;
		if (!modelsAreEqual(this.agent.state.model, fallback.current)) return false;
		if (!this._modelRegistry.hasConfiguredAuth(fallback.primary)) {
			// The primary's key went stale meanwhile: it cannot serve. Stay, and probe
			// again after another cooldown.
			this._fallback = { ...fallback, switchedAtMs: Date.now(), ...(why === "long_wait" ? { tried: [] } : {}) };
			return false;
		}
		const previousOverride = this.agent.modelOverride;
		this.agent.state.model = fallback.primary;
		this.agent.state.thinkingLevel = fallback.thinkingLevel;
		this._clampServiceTierForModel(fallback.serviceTier);
		// An override that was the fallback model itself (a backup retry took a routed
		// run) leaves with it; the next dispatch routes afresh.
		if (previousOverride && modelsAreEqual(previousOverride.model, fallback.current)) {
			this.agent.modelOverride = undefined;
		}
		if (this.agent.state.isStreaming && this.agent.modelOverride === undefined) {
			this.agent.pendingTurnModel = {
				model: fallback.primary,
				thinkingLevel: this.agent.state.thinkingLevel,
				serviceTier: this.agent.state.serviceTier,
			};
		}
		this._startFreshRequestLadder();
		const primary = `${fallback.primary.provider}/${fallback.primary.id}`;
		this._recordModelChangeForContext({ provider: fallback.primary.provider, modelId: fallback.primary.id });
		this._recordDutyEvent({ kind: "model_restored", to: primary });
		this._recordFallbackEntry({
			kind: "return",
			at: Date.now(),
			from: `${fallback.current.provider}/${fallback.current.id}`,
			to: primary,
			cause: why === "cooldown" ? "冷却期已过，试回原模型" : "所有模型都失败，等待后从原模型重试",
		});
		if (why === "cooldown") {
			const minutes = Math.max(1, Math.round((Date.now() - fallback.switchedAtMs) / 60_000));
			this._emitFallbackNotice(
				`已切回原模型 ${fallback.primary.id}（在备用模型 ${fallback.current.id} 上跑了约 ${minutes} 分钟，冷却期已过，先试试原模型好了没有）`,
				{ kind: "return", from: `${fallback.current.provider}/${fallback.current.id}`, to: primary },
			);
		}
		return true;
	}

	/**
	 * Rebuild the fallback episode the branch ended in (restart, resume, tree
	 * navigation). Without it a restart mid-episode kept the backup forever: the
	 * switch's model change is restored, but the memory of the primary was not.
	 */
	private _restoreFallbackEpisode(): void {
		this._fallback = undefined;
		const branch = this.sessionManager.getBranch();
		const longWait = readPersistedLongWait(branch);
		this._fallbackLongWaitRound = longWait.round;
		// A wait the restart interrupted is resumed by its durable job; remember the job
		// so an earlier success (the owner writing first) cancels it instead of letting
		// it deliver a stale resume.
		if (longWait.round > 0 && longWait.jobId !== undefined && this._fallbackLongWaitJobId === undefined) {
			this._fallbackLongWaitJobId = longWait.jobId;
		}
		this._reapplyInspectionWithholding(this.agent.state.messages);
		const episode = readPersistedFallbackEpisode(branch);
		const current = this.agent.state.model;
		if (!episode || !current || `${current.provider}/${current.id}` !== episode.current) return;
		const separator = episode.primary.indexOf("/");
		if (separator <= 0) return;
		const primary = this._modelRegistry.find(
			episode.primary.slice(0, separator),
			episode.primary.slice(separator + 1),
		);
		if (!primary) return;
		const thinkingLevel = THINKING_LEVELS.find((level) => level === episode.thinkingLevel);
		const serviceTier = PERSISTED_SERVICE_TIERS.find((tier) => tier === episode.serviceTier);
		this._fallback = {
			primary,
			thinkingLevel: thinkingLevel ?? this.agent.state.thinkingLevel,
			serviceTier: serviceTier ?? this.agent.state.serviceTier,
			current,
			switchedAtMs: episode.switchedAtMs,
			tried: [...episode.tried],
		};
	}

	/**
	 * A child spawned while this session runs on a fallback starts on the same
	 * fallback (the primary is failing right now), but knows the primary, so it
	 * returns after the same cooldown instead of treating the backup as home.
	 */
	_shareFallbackEpisodeWith(child: AgentSession): void {
		const fallback = this._fallback;
		if (!fallback || child._fallback || !modelsAreEqual(child.agent.state.model, fallback.current)) return;
		child._fallback = {
			primary: fallback.primary,
			thinkingLevel: clampThinkingLevel(fallback.primary, child.agent.state.thinkingLevel) as ThinkingLevel,
			serviceTier: fallback.serviceTier,
			current: child.agent.state.model,
			switchedAtMs: fallback.switchedAtMs,
			tried: [...fallback.tried],
		};
		const key = (model: Model<any>) => `${model.provider}/${model.id}`;
		child._recordFallbackEntry({
			kind: "switch",
			at: fallback.switchedAtMs,
			from: key(fallback.primary),
			to: key(fallback.current),
			cause: "父会话正在用备用模型",
			primary: key(fallback.primary),
			thinkingLevel: child._fallback.thinkingLevel,
			...(fallback.serviceTier ? { serviceTier: fallback.serviceTier } : {}),
		});
	}

	/**
	 * Fallback bookkeeping on the agent's event stream: probe the primary again
	 * at a turn boundary once the cooldown passed, and move off a model that
	 * keeps emitting invalid tool calls (garbage names, empty arguments).
	 */
	private _recordFallbackActivity(event: AgentEvent): void {
		if (event.type === "agent_start") {
			this._badToolCallStreak = 0;
			this._toolCallArgs.clear();
		}
		if (event.type === "agent_start" || event.type === "turn_start") {
			const fallback = this._fallback;
			if (fallback && Date.now() - fallback.switchedAtMs >= PROVIDER_FALLBACK_RETURN_AFTER_MS) {
				this._returnToPrimaryModel("cooldown");
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			this._toolCallArgs.set(event.toolCallId, event.args);
			return;
		}
		if (event.type !== "tool_execution_end") return;
		const args = this._toolCallArgs.get(event.toolCallId);
		this._toolCallArgs.delete(event.toolCallId);
		const text = toolResultText(event.result);
		// Resolve the tool's definition so a legitimate empty-args call to a tool
		// whose schema requires nothing is not counted as a bad call; an
		// unresolvable name keeps the conservative legacy reading (it counts).
		if (!isBadToolCall({ isError: event.isError, text, args }, this.getToolDefinition(event.toolName))) {
			if (!event.isError) this._badToolCallStreak = 0;
			return;
		}
		this._badToolCallStreak += 1;
		if (this._badToolCallStreak < BAD_TOOL_CALL_STORM_THRESHOLD) return;
		const streak = this._badToolCallStreak;
		this._badToolCallStreak = 0;
		const next = this._resolveNextFallbackModel();
		if (!next) return;
		const cause = `连续 ${streak} 次无效工具调用`;
		this._applyFallbackModel(next, cause, text, "bad_tool_calls");
		// The running loop takes the new model before its next request: the moved
		// image override when the storm came from a routed image model.
		this.agent.pendingTurnModel = this.agent.modelOverride ?? {
			model: next,
			thinkingLevel: this.agent.state.thinkingLevel,
			serviceTier: this.agent.state.serviceTier,
		};
		// Same event pair a retry-path switch produces, so every client shows it.
		this._emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 1,
			delayMs: 0,
			errorMessage: cause,
			reason: "backup",
			backupModel: `${next.provider}/${next.id}`,
		});
		this._emit({ type: "auto_retry_end", success: true, attempt: 1 });
	}

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
		return handleProviderWait(this, message, options, policy, reason);
	}

	private _createQuotaResumeJob(resumeAtMs: number, label?: string, prompt?: string): string | undefined {
		return createQuotaResumeJob(this, resumeAtMs, label, prompt);
	}

	private _resolveQuotaResumeJob(jobId: string): "delivered" | "user-cancelled" | "cancelled" | "gone" {
		return resolveQuotaResumeJob(this, jobId);
	}

	private _handleAbortedQuotaPark(): void {
		handleAbortedQuotaPark(this);
	}

	private _handleErroredQuotaParkProbe(message: AssistantMessage): void {
		handleErroredQuotaParkProbe(this, message);
	}

	private _reloadQuotaParkFromBranch(): void {
		reloadQuotaParkFromBranch(this);
	}

	private _restoreQuotaPark(): void {
		restoreQuotaPark(this);
	}

	private _completeQuotaParkResume(): void {
		completeQuotaParkResume(this);
	}

	/**
	 * Return to the primary model after a backup-model retry, unless the user
	 * switched models meanwhile. Returns the restored "provider/model-id"
	 * reference for the retry-end event.
	 */
	_restorePrimaryModelAfterBackup(): string | undefined {
		const backup = this._backupModel;
		this._backupModel = undefined;
		if (!backup || !modelsAreEqual(this.model, backup.backup)) return undefined;
		this.agent.state.model = backup.primary;
		this.agent.state.thinkingLevel = backup.thinkingLevel;
		this.agent.modelOverride = backup.routedOverride;
		// Restore the saved effective tier: reclamping from the current state
		// would keep the tier the backup clamped it to.
		this._clampServiceTierForModel(backup.serviceTier);
		this._recordModelChangeForContext({ provider: backup.primary.provider, modelId: backup.primary.id });
		return `${backup.primary.provider}/${backup.primary.id}`;
	}

	abortRetry(): void {
		// An abort disarms the throttled persistent-goal continuation's wake: it was
		// armed for the run the owner just stopped, and firing it later would
		// continue the goal behind the owner's back (it only died with dispose()).
		this._clearGoalContinuationWake();
		// Esc during a retry countdown lands here rather than in abort(): align the
		// two. An active goal must not read the cancelled chain's terminal error as
		// the goal's own failure (the in-flight agent_end resumes when the sleep
		// rejects, and reaches _finishGoalForTerminalAssistantMessage), and queued
		// work must not restart behind the owner's back - the pump suspends exactly
		// as requestAbort suspends it, and the next admission lifts it again. The
		// update-restart fence fields are untouched: abortForUpdateRestart owns
		// those and calls into here after arming them.
		if (this._retryAbortController || this._retryAttempt > 0) {
			this._goalAbortInProgress = this._goalState.status === "active";
			this._sessionInputPumpRequested = false;
			this._sessionInputPumpEpoch++;
			this._sessionInputPumpSuspended = true;
			this._sessionInputSuspendedSince = Date.now();
			this._failureWakeUsedForSuspension = false;
		}
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

	/** True while the session is parked waiting out a provider-reported usage reset. */
	get isQuotaParked(): boolean {
		return this._quotaPark !== undefined;
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
			// Work the pump rolled back while this command held the busy slot has no
			// other dispatch source.
			this._scheduleSessionInputPump();
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
		if (this._pendingBashMessages.length === 0 && this._pendingModelChangeMessages.length === 0) return;
		if (this.isStreaming) return;
		try {
			this._flushPendingBashMessages();
			// Not persisted here on purpose: the durable model_change ledger entry
			// was written at switch time and the rebuild synthesizes the notice.
			this._flushPendingModelChangeMessages();
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

	/**
	 * Record a model switch: the durable ledger entry lands at once (a restart
	 * re-derives the notice from it), the live-context notice waits out an open
	 * tool batch. Pushing mid-run would interleave the notice between an
	 * assistant tool call and its tool result - the ordering corruption
	 * _pendingBashMessages defers for the same reason.
	 */
	private _recordModelChangeForContext(details: ModelChangeNoticeDetails): void {
		this.sessionManager.appendModelChange(details.provider, details.modelId);
		this._pushModelChangeNotice(details);
	}

	/** The live-context half of a switch record; deferred while a tool batch is open. */
	private _pushModelChangeNotice(details: ModelChangeNoticeDetails): void {
		const message = createModelChangeMessage(details, Date.now());
		if (this.isStreaming) {
			this._pendingModelChangeMessages.push(message);
			return;
		}
		this.agent.state.messages.push(message);
	}

	/**
	 * The witness-facing half of a non-interactive switch (wave-42 SETMODEL-VIS): a
	 * visible chat line for every attached client except the initiator. Unlike the
	 * model-facing notice above this never enters the context - it is not pushed to
	 * state.messages and not persisted as a custom_message, because convertToLlm
	 * passes an unknown customType through to the model. The origin record lands in
	 * the ledger as a plain custom entry (never rebuilt into messages); the token
	 * stays wire-only so the daemon's exemption window cannot leak into the
	 * transcript. No deferral while streaming: with no context seat there is no
	 * tool-batch ordering to corrupt, and the witness wants the line now.
	 */
	private _emitModelChangeOriginNotice(
		model: Model<any>,
		previousModel: Model<any> | undefined,
		notice: { origin: ModelChangeOriginNoticeSource; token?: string },
	): void {
		const details: ModelChangeOriginNoticeDetails = {
			provider: model.provider,
			modelId: model.id,
			...(previousModel ? { previousProvider: previousModel.provider, previousModelId: previousModel.id } : {}),
			origin: notice.origin,
			...(notice.token ? { token: notice.token } : {}),
		};
		const originText = notice.origin === "extension" ? "扩展" : "另一个窗口或客户端";
		const message: CustomMessage<ModelChangeOriginNoticeDetails> = {
			role: "custom",
			customType: MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE,
			content: `模型已切换为「${model.provider}/${model.id}」（由${originText}发起）。`,
			display: true,
			details,
			timestamp: Date.now(),
		};
		try {
			const { token: _wireOnly, ...ledgerDetails } = details;
			this.sessionManager.appendCustomEntry(MODEL_CHANGE_ORIGIN_NOTICE_CUSTOM_TYPE, ledgerDetails);
		} catch (error) {
			this._reportSessionPersistFailure(error);
		}
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	/**
	 * Flush the deferred model-change notices. Safe points: a completed tool
	 * batch (turn_end), the prompt-preparation barrier, and pre-continue call
	 * sites - never mid-batch, and not on a failed/aborted turn, where the retry
	 * machinery expects the failed assistant message to be the tail.
	 */
	private _flushPendingModelChangeMessages(): void {
		if (this._pendingModelChangeMessages.length === 0) return;
		for (const message of this._pendingModelChangeMessages) {
			this.agent.state.messages.push(message);
		}
		this._pendingModelChangeMessages = [];
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
		// Branch summary is a compaction-state start point as well: input already
		// queued when the summary begins gets the same bound (B2-C02).
		if (this.hasPendingSessionWork) this._armCompactionGateWatchdog();

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
			// The rebuild synthesizes switch notices from the ledger; a still-pending
			// deferred copy would land a second time on the next flush.
			this._pendingModelChangeMessages = [];
			this._mergeUnpersistedOutcomes(this.agent.state.messages);
			this._restoreLateIpythonSentAgentMessages();
			// A context rebuild is a cold boundary: refresh the digest like resume does.
			this._ensureHarnessDigestContext();
			// A summary branch continues the same timeline, so the same goal's
			// accounting must never regress across the rebuild; a plain branch move
			// is time travel and keeps faithful branch semantics.
			this._reloadGoalStateFromBranch({ monotonicTokens: Boolean(summaryText) });
			this._reloadRlmMaxDepthFromBranch();
			this._reloadQuotaParkFromBranch();
			this._restoreFallbackEpisode();
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
			// Same contract as the bash/retry/compaction clear sites: work the pump
			// rolled back while the branch mutation held the busy slot needs a reschedule.
			this._scheduleSessionInputPump();
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
			// U2: the trailing tool-error streak, derived from the transcript tail
			// (a successful tool result ends it). Derived, not accumulated: the
			// transcript is the event-sourced truth and restores for free.
			consecutiveToolErrors: consecutiveToolErrorsFromMessages(state.messages),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = this._sessionContextWindow();
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a readable assistant usage after the compaction boundary.
			// Keep scanning past aborted, errored and zero-usage assistants: a zero-usage
			// reply is not a readable count for either caliber (isAssistantUsageSource,
			// CC 2.1.288), so both stay at "unknown" until a real response arrives
			// instead of one reporting a number while the other reports "unknown".
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
