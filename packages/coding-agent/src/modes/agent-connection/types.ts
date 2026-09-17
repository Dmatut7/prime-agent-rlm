import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, ServiceTier, TextContent, Transport, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionMessageReceipt, AgentSessionMessageSafetyStatus } from "../../core/agent-messages.js";
import type { AuthSourceToken } from "../../core/auth-storage.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import type { ContextTreeNode } from "../../core/context-tree.js";
import type {
	AgentCronJob,
	AgentHeartbeatDeliveryMode,
	AgentHeartbeatManagementAction,
	AgentHeartbeatUpdateAction,
} from "../../core/cron-jobs.js";
import type { ReplayBuiltInToolName } from "../../core/extensions/index.js";
import type { InputSource } from "../../core/extensions/types.js";
import type { GoalState } from "../../core/goals.js";
import type { KernelSentAgentMessage } from "../../core/kernel/index.js";
import type { AcpMcpServerConfig } from "../../core/mcp/acp-mcp-types.js";
import type { RefinementResult } from "../../core/refinement/index.js";
import type { RlmMaxDepthStatus, SetRlmMaxDepthResult } from "../../core/rlm-max-depth.js";
import type {
	QueuedMessageLane,
	QueuedMessageMutation,
	QueuedMessageMutationStatus,
	SessionActionSnapshot,
} from "../../core/session-action-store.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type { SessionStats } from "../../core/session-stats.js";
import type { StallDiagnostics } from "../../core/stall-diagnostics.js";
import type { SessionUsageSummary } from "../../core/usage.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import type { HeadlessCompletionResult } from "../headless-completion.js";

/**
 * Client-side interaction boundary consumed by InteractiveMode.
 *
 * This is not the final hosted/gateway wire protocol. Local and future remote
 * adapters may implement this interface, but network transports should translate
 * at their edge to versioned DTOs with their own framing, sequencing, replay,
 * and command lifecycle semantics.
 *
 * Keep runtime ownership details out of this contract. InteractiveMode must not
 * receive AgentSessionRuntime, AgentSession, SessionManager, daemon socket
 * clients, in-process event emitters, or executable callbacks through
 * AgentConnection. Local-only compatibility hooks belong in adapter/service
 * layers such as InteractiveModeLocalSessionHost.
 *
 * Transitional note: AgentEvent and AgentMessage are still reused below so this
 * PR can move the TUI behind a boundary without rewriting the transcript
 * renderer and stream event model. Replace those aliases with stable
 * connection-owned/network DTOs before treating this surface as a remote wire
 * contract.
 */
export type AgentConnectionQueueMode = "all" | "one-at-a-time";
export type AgentConnectionModel = Model<Api>;
export interface AgentConnectionModelCatalog {
	models: AgentConnectionModel[];
	configuredProviders: string[];
}
export type AgentConnectionSavedSessionScope = "current" | "all";

export interface AgentConnectionSessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	rlmDepth?: number;
	git?: {
		repoUrl?: string;
		commit?: string;
		branch?: string;
	};
}

export type AgentConnectionSavedSessionStateStatus = "active" | "archived" | "crash";

export type AgentConnectionSourceScope = "user" | "project" | "temporary";
export type AgentConnectionSourceOrigin = "package" | "top-level";

export interface AgentConnectionSourceInfo {
	path: string;
	source: string;
	scope: AgentConnectionSourceScope;
	origin: AgentConnectionSourceOrigin;
	baseDir?: string;
}

export interface AgentConnectionResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string;
	winnerPath: string;
	loserPath: string;
	winnerSource?: string;
	loserSource?: string;
}

export interface AgentConnectionResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: AgentConnectionResourceCollision;
}

export interface AgentConnectionSavedSessionState {
	status: AgentConnectionSavedSessionStateStatus;
}

export interface AgentConnectionAgentStatus {
	summary: string;
	// Includes "error" so the connection layer can carry a transcript-derived
	// error verdict (upstream #2310). The strictly validated saved-session wire
	// never emits it yet: serializeSavedSessionInfo downshifts error verdicts and
	// daemon-client's validator still rejects the value, so old clients are safe
	// until the daemon protocol takes the enum.
	taskState?: "needs_input" | "completed" | "error";
	basedOnMessageCount: number;
}

/**
 * Saved-session registry row for the current local TUI migration.
 *
 * Existing fields intentionally preserve local behavior, including filesystem
 * paths and Date objects. Do not add new TUI features that require these local
 * shapes through AgentConnection. Hosted/gateway work should introduce opaque
 * session/artifact identifiers and string timestamp DTOs before exposing this
 * data across a network.
 */
export interface AgentConnectionSavedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	state?: AgentConnectionSavedSessionState;
	parentSessionPath?: string;
	rlmDepth?: number;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	agentStatus?: AgentConnectionAgentStatus;
	usage?: SessionUsageSummary;
}

export type AgentConnectionSessionListProgress = (loaded: number, total: number) => void;

export interface AgentConnectionSessionListCallbacks {
	onProgress?: AgentConnectionSessionListProgress;
	onSession?: (session: AgentConnectionSavedSessionInfo) => void;
}

export interface AgentConnectionSessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface AgentConnectionSessionMessageEntry extends AgentConnectionSessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface AgentConnectionThinkingLevelChangeEntry extends AgentConnectionSessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface AgentConnectionServiceTierChangeEntry extends AgentConnectionSessionEntryBase {
	type: "service_tier_change";
	serviceTier: ServiceTier;
}

export interface AgentConnectionModelChangeEntry extends AgentConnectionSessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface AgentConnectionCompactionEntry extends AgentConnectionSessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
	fromHook?: boolean;
}

export interface AgentConnectionBranchSummaryEntry extends AgentConnectionSessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: unknown;
	fromHook?: boolean;
}

export interface AgentConnectionCustomEntry extends AgentConnectionSessionEntryBase {
	type: "custom";
	customType: string;
	data?: unknown;
}

export interface AgentConnectionChildUsageAttributionEntry extends AgentConnectionSessionEntryBase {
	type: "child_usage_attributed";
	targetId: string;
	childUsage: Usage;
	aggregateUsage: Usage;
	origin?: "spawn_task" | "agent_message" | "direct_user";
}

export interface AgentConnectionCustomMessageEntry extends AgentConnectionSessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
}

export interface AgentConnectionLabelEntry extends AgentConnectionSessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

export interface AgentConnectionSessionInfoEntry extends AgentConnectionSessionEntryBase {
	type: "session_info";
	name?: string;
}

export interface AgentConnectionSessionStateEntry extends AgentConnectionSessionEntryBase {
	type: "session_state";
	state: AgentConnectionSavedSessionState;
}

export interface AgentConnectionAgentStatusEntry extends AgentConnectionSessionEntryBase {
	type: "agent_status";
	status: AgentConnectionAgentStatus;
}

export interface AgentConnectionGitStateEntry extends AgentConnectionSessionEntryBase {
	type: "git_state";
	git: {
		repoUrl?: string;
		commit?: string;
		branch?: string;
	};
}

export interface AgentConnectionLeafPositionEntry extends AgentConnectionSessionEntryBase {
	type: "leaf_position";
	targetId: string | null;
}

export type AgentConnectionSessionEntry =
	| AgentConnectionSessionMessageEntry
	| AgentConnectionThinkingLevelChangeEntry
	| AgentConnectionServiceTierChangeEntry
	| AgentConnectionModelChangeEntry
	| AgentConnectionCompactionEntry
	| AgentConnectionBranchSummaryEntry
	| AgentConnectionCustomEntry
	| AgentConnectionChildUsageAttributionEntry
	| AgentConnectionCustomMessageEntry
	| AgentConnectionLabelEntry
	| AgentConnectionSessionInfoEntry
	| AgentConnectionSessionStateEntry
	| AgentConnectionAgentStatusEntry
	| AgentConnectionGitStateEntry
	| AgentConnectionLeafPositionEntry;

export interface AgentConnectionSessionTreeFlatNode {
	entry: AgentConnectionSessionEntry;
	label?: string;
	labelTimestamp?: string;
}

export interface AgentConnectionSessionTreeNode extends AgentConnectionSessionTreeFlatNode {
	children: AgentConnectionSessionTreeNode[];
}

/**
 * What a depth-bounded session tree left out, so a truncation is never silent.
 *
 * This is the connection-owned wire DTO for the local manager's `SessionTreeDepthStats`.
 * The contract deliberately does not import that module: `SessionManager` is runtime
 * ownership, and a remote adapter must be able to implement this surface without the local
 * session runtime in its type graph (see test/interactive-mode-boundary.test.ts). The two
 * field sets are pinned to each other by test/session-tree-wire-bounds.test.ts, so the
 * mirror cannot drift silently.
 */
export interface AgentConnectionSessionTreeBound {
	/** Entries in the session. */
	entries: number;
	/** Nodes the client receives. */
	returnedNodes: number;
	/**
	 * Nodes outside both retained depth windows: present in the session, absent from the
	 * returned tree. The windows are anchored at the deepest entry and at the live leaf's
	 * own depth, so these are the *older* ancestors of either chain.
	 */
	omittedNodes: number;
	/** Depth (parent edges) of the deepest entry in the session. */
	maxDepth: number;
	depthLimit: number;
	/**
	 * Depth of the shallowest retained node, i.e. how many top layers were cut. 0 does not
	 * by itself mean the whole tree fit: a width-only cut (see {@link maxNodes}) can drop
	 * the oldest siblings while the session's root-depth layer survives, so `truncated` is
	 * the field that says whether anything was dropped. A retained node whose parent is
	 * not retained comes back as a root, so a client can tell a truncated view from a
	 * session that really starts there.
	 */
	retainedFromDepth: number;
	/**
	 * The node cap the returned tree honors: `returnedNodes` never exceeds it. Absent on
	 * the pre-34 wire (older daemons do not send it), and `Number.MAX_SAFE_INTEGER` for an
	 * unbounded build, since the stats ride the wire and JSON has no Infinity.
	 */
	maxNodes: number;
	/**
	 * The session's live leaf is a node in the returned tree: the window is anchored at the
	 * leaf's own depth, so the entry the session resumes on keeps its ancestor chain. False
	 * when the session has no leaf.
	 */
	leafIncluded: boolean;
	truncated: boolean;
}

/**
 * What a node-count-bounded flat session tree left out, so a truncation is never silent.
 *
 * This is the connection-owned wire DTO for the local manager's `SessionFlatTreeStats`,
 * the shape the daemon's `get_session_tree` response carries as `treeBound`. It follows
 * the same rule as {@link AgentConnectionSessionTreeBound}: the contract does not import
 * the session runtime's module, and the two field sets are pinned to each other by
 * test/session-tree-wire-bounds.test.ts so the mirror cannot drift silently.
 */
export interface AgentConnectionSessionTreeFlatStats {
	/** Entries in the session. */
	totalEntries: number;
	/** Nodes the client receives. */
	returnedNodes: number;
	/** Entries present in the session, absent from the returned nodes (the oldest). */
	omittedNodes: number;
	maxNodes: number;
	truncated: boolean;
}

export interface AgentConnectionSessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	serviceTier: ServiceTier;
	model: { provider: string; modelId: string } | null;
}

export type AgentConnectionReplayStatus = "complete" | "partial" | "unavailable";

export interface AgentConnectionReplayInfo {
	status: AgentConnectionReplayStatus;
	fromSequence?: number;
	toSequence: number;
	fromCursor?: AgentConnectionEventCursor;
	toCursor?: AgentConnectionEventCursor;
	reason?: string;
}

export interface AgentConnectionEventCursor {
	generation: string;
	sequence: number;
}

export interface AgentConnectionParentMetadata {
	activeSessionId?: string;
	sessionId?: string;
	nodeId?: string;
	childId?: string;
}

export interface AgentConnectionSnapshot {
	state: AgentConnectionState;
	messages: AgentMessage[];
	/** In-flight assistant message, separate from finalized transcript messages. */
	streamingMessage?: AgentMessage;
	sessionContext?: AgentConnectionSessionContext;
	sessionTree?: {
		tree: AgentConnectionSessionTreeNode[];
		leafId: string | null;
		/** Present when the tree was depth-bounded; says what the bound left out. */
		bound?: AgentConnectionSessionTreeBound;
	};
	parent?: AgentConnectionParentMetadata;
	/** Live RLM children, including descendants, known to the host at snapshot time. */
	children?: AgentConnectionRlmChildAgentSnapshot[];
	lastEventSequence?: number;
	lastEventCursor?: AgentConnectionEventCursor;
	replay?: AgentConnectionReplayInfo;
}

export interface AgentConnectionScopedModel {
	model: AgentConnectionModel;
	thinkingLevel?: ThinkingLevel;
}

export interface AgentConnectionModelCycleResult {
	model: AgentConnectionModel;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	isScoped: boolean;
}

export interface AgentConnectionState {
	activeSessionId?: string;
	cwd: string;
	model?: AgentConnectionModel;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	availableThinkingLevels: ThinkingLevel[];
	isStreaming: boolean;
	isCompacting: boolean;
	isBashRunning: boolean;
	retryAttempt: number;
	steeringMode: AgentConnectionQueueMode;
	followUpMode: AgentConnectionQueueMode;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	sessionDir?: string;
	leafId: string | null;
	autoCompactionEnabled: boolean;
	messageCount: number;
	sessionActions: SessionActionSnapshot;
	compactionCount: number;
	goal: GoalState;
	heartbeat?: AgentCronJob | null;
	scopedModels: AgentConnectionScopedModel[];
	activeToolNames: string[];
	contextUsage: SessionStats["contextUsage"];
	/** One-line recent-work recap for the prompt UI. */
	recap?: string;
}

export interface AgentConnectionSlashCommand {
	name: string;
	registeredName?: string;
	description?: string;
	argumentHint?: string;
	source: "extension" | "prompt" | "skill";
	sourceInfo: AgentConnectionSourceInfo;
}

export type AgentConnectionArtifactType = "context_file" | "extension" | "prompt" | "skill" | "theme";

export interface AgentConnectionArtifactReference {
	id: string;
	sessionId: string;
	type: AgentConnectionArtifactType;
	logicalPath: string;
	relativePath?: string;
	mimeType?: string;
}

export interface AgentConnectionResourceContextFile {
	path: string;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourceSkill {
	name: string;
	description?: string;
	filePath: string;
	sourceInfo?: AgentConnectionSourceInfo;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourcePrompt {
	name: string;
	description?: string;
	argumentHint?: string;
	filePath: string;
	sourceInfo?: AgentConnectionSourceInfo;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourceExtension {
	path: string;
	sourceInfo?: AgentConnectionSourceInfo;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourceTheme {
	name?: string;
	sourcePath?: string;
	sourceInfo?: AgentConnectionSourceInfo;
	artifact?: AgentConnectionArtifactReference;
}

export interface AgentConnectionResourceDiagnostics {
	skills: AgentConnectionResourceDiagnostic[];
	prompts: AgentConnectionResourceDiagnostic[];
	extensions: AgentConnectionResourceDiagnostic[];
	themes: AgentConnectionResourceDiagnostic[];
}

export interface AgentConnectionResourceSnapshot {
	contextFiles: AgentConnectionResourceContextFile[];
	skills: AgentConnectionResourceSkill[];
	prompts: AgentConnectionResourcePrompt[];
	extensions: AgentConnectionResourceExtension[];
	themes: AgentConnectionResourceTheme[];
	diagnostics: AgentConnectionResourceDiagnostics;
}

export interface AgentConnectionToolDefinition {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	renderShell?: "default" | "self";
	replayBuiltInToolName?: ReplayBuiltInToolName;
}

/** Only confirmed cancellation makes prompt-admission failure retry-safe. */
export class AgentConnectionPromptAdmissionError extends Error {
	readonly cancelled: boolean;

	constructor(
		message: string,
		readonly status: "cancelled" | "owned" | "unknown" | "unsupported",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.cancelled = status === "cancelled";
		this.name = "AgentConnectionPromptAdmissionError";
	}
}

export interface AgentConnectionPromptOptions {
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	queueIfBusy?: boolean;
	source?: InputSource;
	/** Cancels only while admission waits; accepted prompts remain session-owned. */
	signal?: AbortSignal;
}

export interface AgentConnectionSideQuestionEvent {
	id: string;
	question: string;
	answer: string;
	status: "running" | "complete" | "cancelled" | "error";
	errorMessage?: string;
}

export interface AgentConnectionSideQuestionTurn {
	question: string;
	answer: string;
}

export interface AgentConnectionExecuteBashOptions {
	excludeFromContext?: boolean;
	/** Side-conversation bash is not recorded into the session. */
	transient?: boolean;
	/**
	 * Caller-generated id echoed on the run's bash_start/bash_end events, so the
	 * requesting client can tell its own run apart from other clients' runs
	 * broadcast on the same session.
	 */
	runId?: string;
}

export interface AgentConnectionNewSessionOptions {
	parentSession?: string;
}

export interface AgentConnectionForkOptions {
	position?: "before" | "at";
}

export interface AgentConnectionSwitchSessionOptions {
	cwdOverride?: string;
}

export interface AgentConnectionNavigateTreeOptions {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface AgentConnectionNavigateTreeResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
}

export interface AgentConnectionUserMessage {
	entryId: string;
	text: string;
}

export interface AgentConnectionQueueState {
	steering: string[];
	followUp: string[];
}

export type AgentConnectionQueuedMessageLane = QueuedMessageLane;
export type AgentConnectionQueuedMessageMutation = QueuedMessageMutation;
/** `unsupported` means an older remote daemon lacks queued-message mutation. */
export type AgentConnectionQueuedMessageMutationStatus = QueuedMessageMutationStatus | "unsupported";

export interface AgentConnectionHeartbeat {
	job: AgentCronJob;
	sessionName?: string;
	firstMessage?: string;
}

export type AgentConnectionExtensionUiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface AgentConnectionExtensionUiRequest {
	id: string;
	method: string;
	payload: Record<string, unknown>;
}

export type AgentConnectionRlmChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface AgentConnectionRlmChildAgentActivity {
	kind: "waiting" | "writing" | "executing" | "stalled";
	toolName?: string;
}

/**
 * Stall facts for a child whose watchdog fired. Wire addition gated by the
 * `rlm_child_stall_activity` server capability; clients that do not see the
 * capability downgrade `stalled` activity to `waiting` and drop this field.
 */
export interface AgentConnectionRlmChildStallState {
	silentMs: number;
	thresholdMs: number;
	inFlightTools: string[];
	unsettled?: boolean;
	/**
	 * True while an unspent exemption (a host-owned phase or a kernel/host liveness vouch) is
	 * excusing the silence: healthy long work, not a wedge. Additive and optional, so a client that
	 * predates it renders the facts it knows; one without the `rlm_child_stall_activity` capability
	 * never sees this field at all, because the whole segment is dropped for it.
	 */
	excused?: boolean;
	/** Exemption sub-reasons behind `excused` (e.g. `live_bash_handles`). */
	excusedReasons?: string[];
}

export interface AgentConnectionRlmChildAgentSnapshot {
	id: string;
	parentId?: string;
	/** Child daemon active-session id, for direct attachment. */
	activeSessionId?: string;
	/** Stable daemon-visible child name for addressing and display. */
	sessionName?: string;
	/** Exact provider/model selector used by the child. */
	model?: string;
	label: string;
	status: AgentConnectionRlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	repliedSinceTask?: boolean;
	toolUseCount?: number;
	tokenCount?: number;
	recap?: string;
	sessionDir: string;
	activity?: AgentConnectionRlmChildAgentActivity;
	error?: string;
	stall?: AgentConnectionRlmChildStallState;
}

export type AgentConnectionSessionEvent =
	| AgentEvent
	| { type: "ipython_sent_agent_message"; toolCallId: string; message: KernelSentAgentMessage }
	| { type: "session_action_update"; actions: SessionActionSnapshot }
	| {
			type: "compaction_start";
			reason: "manual" | "threshold" | "overflow" | "requested";
			customInstructions?: string;
	  }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "service_tier_changed"; serviceTier: ServiceTier }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow" | "requested";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			errorSeverity?: "warning" | "error";
			customInstructions?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "auth_stale"; provider: string; sourceTokens?: readonly AuthSourceToken[] }
	| { type: "rlm_child_update"; child: AgentConnectionRlmChildAgentSnapshot }
	| { type: "recap_update"; recap: string | undefined }
	| { type: "goal_update"; goal: GoalState }
	| { type: "bash_start"; command: string; excludeFromContext: boolean; transient?: boolean; runId?: string }
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
	| { type: "session_persist_failed"; error: string }
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
			/**
			 * Optional because the wire crosses versions: a daemon from before the
			 * diagnostics payload emits the stall events without it, and the renderers
			 * already degrade a missing payload to an explicit "unknown" line instead of
			 * crashing (see formatStallDiagnosticsLines). The type now says what the wire
			 * can actually carry, so a new consumer cannot assume the field exists.
			 */
			diagnostics?: StallDiagnostics;
	  }
	| {
			type: "stall_abort";
			message: string;
			silentMs: number;
			thresholdMs: number;
			/**
			 * Optional because the wire crosses versions: a daemon from before the
			 * diagnostics payload emits the stall events without it, and the renderers
			 * already degrade a missing payload to an explicit "unknown" line instead of
			 * crashing (see formatStallDiagnosticsLines). The type now says what the wire
			 * can actually carry, so a new consumer cannot assume the field exists.
			 */
			diagnostics?: StallDiagnostics;
	  }
	| {
			type: "stall_unsettled";
			message: string;
			silentMs: number;
			thresholdMs: number;
			/**
			 * Optional because the wire crosses versions: a daemon from before the
			 * diagnostics payload emits the stall events without it, and the renderers
			 * already degrade a missing payload to an explicit "unknown" line instead of
			 * crashing (see formatStallDiagnosticsLines). The type now says what the wire
			 * can actually carry, so a new consumer cannot assume the field exists.
			 */
			diagnostics?: StallDiagnostics;
	  };

export type AgentConnectionEvent =
	| { type: "session_event"; event: AgentConnectionSessionEvent }
	| { type: "side_question_event"; event: AgentConnectionSideQuestionEvent }
	| { type: "session_replaced"; state: AgentConnectionState; messages: AgentMessage[] }
	| { type: "session_resynced"; snapshot: AgentConnectionSnapshot }
	| { type: "session_status"; recap?: string }
	| { type: "extension_ui_request"; request: AgentConnectionExtensionUiRequest }
	| { type: "extension_error"; extensionPath: string; event: string; error: string }
	| {
			type: "connection_status";
			status: "reconnecting" | "connected";
			error?: string;
			/**
			 * Set while the low-speed background retry runs after the fast reconnect
			 * budget was spent (P1-7b): the 1-based attempt count, so the UI can say
			 * recovery is still going instead of showing a dead connection.
			 */
			backgroundAttempt?: number;
	  }
	| { type: "heartbeats_changed" }
	| { type: "closed"; error?: string };

export type AgentConnectionEventListener = (event: AgentConnectionEvent) => void | Promise<void>;
export type AgentConnectionBeforeSessionInvalidateListener = () => void;

export interface AgentConnectionHeadlessCompletionOptions {
	/** Wait for descendant terminal publication and the parent turns it triggers. */
	waitForRlmQuiescence?: boolean;
}

export interface AgentConnectionDisposeOptions {
	/**
	 * Leave the session and its still-running RLM descendants alive instead of
	 * tearing the session down. Used when a headless run gave up waiting for
	 * deep descendants: an owned daemon session is promoted to resident (the
	 * worker keeps running) and an in-process session skips its runtime teardown,
	 * so completing the run does not cascade into aborting descendants.
	 */
	keepSessionRunning?: boolean;
}

/**
 * What a dispose actually achieved, so a caller that asked to keep the session
 * running can report the truth instead of assuming it. Absent when the dispose
 * was not asked to keep the session running.
 */
export interface AgentConnectionDisposeOutcome {
	keepSessionRunning?: {
		/** True when the session (and its running descendants) survives the dispose. */
		leftRunning: boolean;
		/** Why the session could not be left running, when it could not. */
		errorMessage?: string;
	};
}

export interface AgentConnectionSessionInputPause {
	release(): Promise<void>;
}

export interface AgentConnection {
	subscribe(listener: AgentConnectionEventListener): () => void;
	onBeforeSessionInvalidate(listener: AgentConnectionBeforeSessionInvalidateListener): () => void;

	getState(): Promise<AgentConnectionState>;
	getInitialSnapshot(): Promise<AgentConnectionSnapshot>;
	getRlmChildSnapshots(): Promise<AgentConnectionRlmChildAgentSnapshot[]>;
	getMessages(): Promise<AgentMessage[]>;
	getSessionHeader(): Promise<AgentConnectionSessionHeader | undefined>;
	getCommands(): Promise<AgentConnectionSlashCommand[]>;
	getResourceSnapshot(): Promise<AgentConnectionResourceSnapshot>;
	getModelCatalog(): Promise<AgentConnectionModelCatalog>;
	getAvailableModels(): Promise<AgentConnectionModel[]>;
	getSessionStats(): Promise<SessionStats>;
	getContextTree(): Promise<ContextTreeNode>;
	getSessionContext(): Promise<AgentConnectionSessionContext>;
	getSessionTree(): Promise<{
		tree: AgentConnectionSessionTreeNode[];
		leafId: string | null;
		/**
		 * What a bounded view left out, so a truncation is never silent at this boundary.
		 *
		 * The daemon path returns the flat bound (`treeBound` on the get_session_tree
		 * response, a node-count cap); the snapshot and in-process paths return the depth
		 * bound of the nested tree. Absent when the view was not truncated (or an old
		 * daemon did not send one); present and `truncated: true` when the client is
		 * seeing fewer nodes than the session holds.
		 */
		bound?: AgentConnectionSessionTreeBound | AgentConnectionSessionTreeFlatStats;
	}>;
	listSavedSessions(
		scope: AgentConnectionSavedSessionScope,
		callbacks?: AgentConnectionSessionListCallbacks,
	): Promise<AgentConnectionSavedSessionInfo[]>;
	getQueue(): Promise<AgentConnectionQueueState>;
	mutateQueuedMessage(
		lane: AgentConnectionQueuedMessageLane,
		index: number,
		expectedText: string,
		mutation: AgentConnectionQueuedMessageMutation,
	): Promise<AgentConnectionQueuedMessageMutationStatus>;
	clearQueue(): Promise<AgentConnectionQueueState>;
	abortAndClearQueue(): Promise<AgentConnectionQueueState>;
	acquireSessionInputPause(leaseKey: string): Promise<AgentConnectionSessionInputPause>;
	/** Resume draining queued session input after an abort suspended it. Returns whether queued input was there to drain. */
	resumeQueuedWork(): Promise<boolean>;
	listCronJobs(options?: { includeInactive?: boolean }): Promise<AgentCronJob[]>;
	listHeartbeats(): Promise<AgentConnectionHeartbeat[]>;
	manageHeartbeat(
		activeSessionId: string,
		jobId: string,
		action: AgentHeartbeatManagementAction,
	): Promise<AgentCronJob>;
	addCronJob(schedule: string, prompt: string): Promise<AgentCronJob>;
	cancelCronJob(jobId: string): Promise<AgentCronJob>;
	getHeartbeat(): Promise<AgentCronJob | undefined>;
	setHeartbeat(
		schedule: string,
		instruction: string,
		deliveryMode?: AgentHeartbeatDeliveryMode,
	): Promise<AgentCronJob>;
	updateHeartbeat(action: AgentHeartbeatUpdateAction): Promise<AgentCronJob | undefined>;
	sendAgentMessage(targetActiveSessionId: string, message: string): Promise<AgentSessionMessageReceipt>;
	getAgentMessageStatus(): Promise<AgentSessionMessageSafetyStatus>;
	pauseAgentMessages(): Promise<AgentSessionMessageSafetyStatus>;
	resumeAgentMessages(): Promise<AgentSessionMessageSafetyStatus>;
	clearAgentMessages(): Promise<number>;
	getUserMessagesForForking(): Promise<AgentConnectionUserMessage[]>;
	getLastAssistantText(): Promise<string | undefined>;
	getSystemPrompt(): Promise<string>;
	getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined>;
	setSessionEntryLabel(entryId: string, label: string | undefined): Promise<void>;
	respondToExtensionUiRequest(requestId: string, response: AgentConnectionExtensionUiResponse): Promise<void>;
	subscribeAgentRoster?(listener: () => void): Promise<{ summaries(): SessionSummary[]; dispose(): Promise<void> }>;
	supportsAcpMcpServers?(): boolean;
	/** True when waitForHeadlessCompletion accepts the RLM quiescence barrier. */
	supportsRlmQuiescenceBarrier?(): boolean;
	replaceAcpMcpServers?(servers: readonly AcpMcpServerConfig[], ownerId: string): Promise<void>;
	releaseAcpMcpServers?(ownerId: string, serverNames: readonly string[]): Promise<void>;

	prompt(message: string, options?: AgentConnectionPromptOptions): Promise<void>;
	promptAndWait(message: string, options?: AgentConnectionPromptOptions): Promise<void>;
	startSideQuestion(id: string, question: string, previousTurns?: AgentConnectionSideQuestionTurn[]): Promise<void>;
	abortSideQuestion(id: string): Promise<boolean>;
	steer(message: string, images?: ImageContent[]): Promise<void>;
	followUp(message: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<void>;
	cancelRlmChild(childId: string): Promise<boolean>;
	waitForIdle(): Promise<void>;
	waitForHeadlessCompletion(options?: AgentConnectionHeadlessCompletionOptions): Promise<HeadlessCompletionResult>;

	/**
	 * Run a user-initiated bash command (! / !! prefix). Resolution timing is
	 * adapter-specific; rendering must be driven by the bash_start/bash_output/
	 * bash_end session events, which reach every attached client.
	 */
	executeBash(command: string, options?: AgentConnectionExecuteBashOptions): Promise<void>;
	executeBashAndWait(command: string): Promise<BashResult>;
	abortBash(): Promise<void>;

	setModel(provider: string, modelId: string): Promise<AgentConnectionModel>;
	cycleModel(direction?: "forward" | "backward"): Promise<AgentConnectionModelCycleResult | undefined>;
	setScopedModels(scopedModels: AgentConnectionScopedModel[]): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	setServiceTier(serviceTier: ServiceTier): Promise<void>;
	cycleThinkingLevel(): Promise<ThinkingLevel | undefined>;
	setTransport(transport: Transport): Promise<void>;
	setSteeringMode(mode: AgentConnectionQueueMode): Promise<void>;
	setFollowUpMode(mode: AgentConnectionQueueMode): Promise<void>;
	setAutoCompactionEnabled(enabled: boolean): Promise<void>;
	setAutoRetryEnabled(enabled: boolean): Promise<void>;

	compact(customInstructions?: string): Promise<CompactionResult>;
	refine(options?: { instructions?: string; rollbackId?: string; global?: boolean }): Promise<RefinementResult>;
	abortCompaction(): Promise<void>;
	abortBranchSummary(): Promise<void>;
	abortRetry(): Promise<void>;

	reload(): Promise<void>;
	newSession(options?: AgentConnectionNewSessionOptions): Promise<{ cancelled: boolean }>;
	switchSession(sessionPath: string, options?: AgentConnectionSwitchSessionOptions): Promise<{ cancelled: boolean }>;
	fork(entryId: string, options?: AgentConnectionForkOptions): Promise<{ cancelled: boolean; selectedText?: string }>;
	navigateTree(
		targetId: string,
		options?: AgentConnectionNavigateTreeOptions,
	): Promise<AgentConnectionNavigateTreeResult>;
	importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }>;
	exportToHtml(outputPath?: string): Promise<string>;
	exportToJsonl(outputPath?: string): Promise<string>;
	setSessionName(name: string): Promise<void>;
	getRlmMaxDepthStatus(): Promise<RlmMaxDepthStatus>;
	setRlmMaxDepth(maxDepth: number, options?: { global?: boolean }): Promise<SetRlmMaxDepthResult>;
	renameSavedSession(sessionPath: string, name: string): Promise<void>;
	deleteSavedSession(sessionPath: string): Promise<DeleteSessionFileResult>;

	/** Read-only live-session watcher; unavailable transports return undefined. */
	watchSession(activeSessionId: string): Promise<AgentConnectionSessionWatcher | undefined>;

	dispose(options?: AgentConnectionDisposeOptions): Promise<AgentConnectionDisposeOutcome | undefined>;
}

export interface AgentConnectionSessionWatcher {
	getMessages(): Promise<AgentMessage[]>;
	getCommands(): Promise<AgentConnectionSlashCommand[]>;
	subscribe(listener: AgentConnectionEventListener): () => void;
	getToolDefinition(name: string): Promise<AgentConnectionToolDefinition | undefined>;
	close(): Promise<void>;
}
