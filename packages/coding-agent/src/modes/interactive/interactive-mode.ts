import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type ImageContent,
	type Message,
	type Model,
	type ServiceTier,
	supportsFastMode,
	type TextContent,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { BUILTIN_MCP_CATALOG } from "@earendil-works/pi-ai/mcp";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@earendil-works/pi-tui";
import {
	type ClickRegion,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	isKeyRelease,
	isMouseSequence,
	Loader,
	type LoaderIndicatorOptions,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	StallActions,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "child_process";
import {
	buildDaemonUpdateRestartReport,
	launchDaemonUpdateRestartCoordinator,
	resolveDaemonUpdateRestartSocketPath,
} from "../../cli/daemon-update-restart.js";
import { type CliSubprocessLaunchSpec, createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import {
	APP_NAME,
	APP_TITLE,
	getAgentDir,
	getAgentTracesLogPath,
	getDebugLogPath,
	getLogsDir,
	getSessionsDir,
	getShareViewerUrl,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	VERSION,
} from "../../config.js";
import {
	AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL,
	isAgentSessionMessage,
	startsAgentRun,
} from "../../core/agent-messages.js";
import {
	type AgentTracePreviewResult,
	type AgentTraceUploadAllResult,
	type AgentTraceUploadResult,
	getPrimeAgentTraceCredential,
	previewAgentTraceFile,
	uploadAgentTraceFile,
	uploadAllAgentTraces,
} from "../../core/agent-traces.js";
import { isNoModelsAvailableMessage } from "../../core/auth-guidance.js";
import { type CompactionWindowLimits, compactionThresholdTokens } from "../../core/compaction/compaction.js";
import type { ContextTreeNode } from "../../core/context-tree.js";
import {
	type AgentCronJob,
	type AgentHeartbeatManagementAction,
	DEFAULT_HEARTBEAT_DELIVERY_MODE,
	parseHeartbeatCommand,
} from "../../core/cron-jobs.js";
import { formatDutyLog, readDutyLogEntries, summarizeDutyLog } from "../../core/duty-log.js";
import type {
	AutocompleteProviderFactory,
	ContextUsage,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import { emptyGoalState, formatGoalUsage, GOAL_CONTEXT_PREVIEW_LABEL, type GoalState } from "../../core/goals.js";
import { resolveImageModelRoute } from "../../core/image-model-routing.js";
import type { KernelSentAgentMessage } from "../../core/kernel/index.js";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.js";
import { runMcpManagementCommand } from "../../core/mcp/mcp-command.js";
import {
	bashOutputToText,
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CustomMessage,
	createHeartbeatPromptMessage,
	HEARTBEAT_PROMPT_PREVIEW_LABEL,
	isCompactionOutcomeMessage,
	isRefinementOutcomeMessage,
	isSessionSlashCommandMessage,
	isSessionSlashCommandResultMessage,
	REFINEMENT_OUTCOME_CUSTOM_TYPE,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
} from "../../core/messages.js";
import { findExactModelReferenceMatch, resolveModelScopeFromModels } from "../../core/model-resolver.js";
import { parseNewSessionCommand } from "../../core/new-session-command.js";
import { resolvePrimeAgentTracesBaseUrl } from "../../core/prime-inference-auth.js";
import { resolvePrimeInferencePostLoginModelAction } from "../../core/prime-inference-model-selection.js";
import { parseCommandArgs } from "../../core/prompt-templates.js";
import { PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE } from "../../core/provider-fallback.js";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../../core/session-import-errors.js";
import { resolveSessionPath, SessionSelectorError, SessionSelectorNotFoundError } from "../../core/session-resolver.js";
import { consecutiveToolErrorsFromMessages } from "../../core/session-stats.js";
import {
	confirmShareIfSecrets,
	createShareTempHtmlFile,
	SHARE_UPLOAD_TIMEOUT_MS,
	shareExportIdentityHintFromFile,
} from "../../core/share-session.js";
import { parseSkillBlock } from "../../core/skill-blocks.js";
import {
	BUILTIN_SLASH_COMMANDS,
	builtinSlashCommandTakesArgument,
	isBuiltinSlashCommandName,
	parseSlashCommand,
	resolveBuiltinSlashCommandName,
} from "../../core/slash-commands.js";
import { createSpendPricing, type SpendPricing } from "../../core/spend-pricing.js";
import type { StallEventActions } from "../../core/stall-diagnostics.js";
import {
	formatStallEventLines,
	formatStallExplanation,
	formatStallSummary,
	type StallEventView,
	stallActionBarView,
	stallEvidenceHint,
} from "../../core/stall-diagnostics-render.js";
import {
	captureAgentCommandUsed,
	captureOnboardingCompleted,
	type TelemetryOnboardingOutcome,
} from "../../core/telemetry.js";
import { type TruncationResult, truncateTail } from "../../core/tools/truncate.js";
import { getChangelogPath, parseChangelog } from "../../utils/changelog.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { readClipboardImage } from "../../utils/clipboard-image.js";
import { parseGitUrl } from "../../utils/git.js";
import { resizeImage } from "../../utils/image-resize.js";
import { getCwdRelativePath } from "../../utils/paths.js";
import { backgroundNetworkOptOut } from "../../utils/privacy-opt-out.js";
import { createPrivateTempFile, readPrivateFile, writePrivateFileAtomic } from "../../utils/private-files.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { ensureTool, ensureToolWithStatus, formatMissingRipgrepMessage } from "../../utils/tools-manager.js";
import { checkForNewPiVersion } from "../../utils/version-check.js";
import type {
	AgentConnection,
	AgentConnectionExtensionUiRequest,
	AgentConnectionExtensionUiResponse,
	AgentConnectionHeartbeat,
	AgentConnectionModel,
	AgentConnectionModelCatalog,
	AgentConnectionQueuedMessageMutationStatus,
	AgentConnectionQueueState,
	AgentConnectionResourceDiagnostic,
	AgentConnectionResourceSnapshot,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionClosedReason,
	AgentConnectionSessionContext,
	AgentConnectionSessionEvent,
	AgentConnectionSessionTreeNode,
	AgentConnectionSideQuestionEvent,
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionSourceInfo,
	AgentConnectionState,
	AgentConnectionToolDefinition,
} from "../agent-connection/index.js";
import { AgentConnectionPromptAdmissionError } from "../agent-connection/index.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import { getModelArgumentCompletions } from "../model-autocomplete.js";
import {
	checkForPackageUpdates,
	checkTmuxKeyboardSetup,
	formatPackageUpdateNotice,
	formatUpdateAvailableNotice,
} from "../shared/startup-notices.js";
import { AGENT_ACTIVITY_LABELS, AgentActivityTracker, formatTokenCount } from "./agent-activity.js";
import { type AuthenticationResult, getAnthropicSubscriptionAuthWarning, ProviderAuthFlows } from "./auth-flows.js";
import { AGENT_MESSAGE_TURN_INSET, AgentMessageComponent } from "./components/agent-message.js";
import { ArminComponent } from "./components/armin.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import {
	BLOCK_REVEAL_MARKER,
	BlockNavigator,
	blockNavigationKeysText,
	componentRowOffset,
	type FocusableBlock,
	FocusableTextBlock,
	isExpandableBlock,
	isFocusableBlock,
	isVisibleRow,
} from "./components/block-focus.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { type FullPaneOverlayOptions, showFullPaneOverlay } from "./components/centered-overlay.js";
import {
	CompactionOutcomeMessageComponent,
	MalformedCompactionOutcomeMessageComponent,
} from "./components/compaction-outcome-message.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { ConfigurationMenuComponent, type ConfigurationMenuTab } from "./components/configuration-menu.js";
import { formatContextTree } from "./components/context-tree-format.js";
import {
	countThinkingSegments,
	isCompactAgentMessageNeighbor,
	latestThinkingText,
} from "./components/conversation-components.js";
import { CountdownTimer } from "./components/countdown-timer.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DutyLogBlock } from "./components/duty-log-block.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.js";
import {
	type FileChangeSummary,
	formatFileChangePath,
	formatTotalChangeSummary,
	getToolFileChanges,
	mergeTurnFileChanges,
} from "./components/edit-summary.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FEATURE_HINT_ANIMATION_INTERVAL_MS, FeatureHintComponent } from "./components/feature-hint.js";
import {
	FooterComponent,
	type FooterTelemetrySnapshot,
	type FooterTelemetrySource,
	formatContextTokens,
} from "./components/footer.js";
import { HeartbeatManagerComponent } from "./components/heartbeat-manager.js";
import { InjectedPromptMessageComponent, isInjectedPromptMessage } from "./components/injected-prompt-message.js";
import { formatKeyText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.js";
import { createMermaidMarkdownTransform } from "./components/mermaid.js";
import type { AuthSelectorProvider } from "./components/oauth-selector.js";
import { PrimeOnboardingSplashComponent } from "./components/prime-onboarding-splash.js";
import { styleArgumentTokens } from "./components/prompt-highlight.js";
import {
	MalformedRefinementOutcomeMessageComponent,
	RefinementOutcomeMessageComponent,
} from "./components/refinement-outcome-message.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SideQuestionComponent } from "./components/side-question.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import {
	isLeadingSlashCommand,
	SlashCommandMessageComponent,
	styleSlashCommandText,
} from "./components/slash-command-message.js";
import { SlashCommandResultMessageComponent } from "./components/slash-command-result-message.js";
import {
	buildSubagentPanelRows,
	classifySubagentSnapshotStatus,
	collectSubtreeSubagentSnapshots,
	countRosterSubagentStatuses,
	countSubtreeSubagentStatuses,
	formatSubagentStallMarker,
	type SubagentPanelRow,
	type SubagentSummaryCounts,
	SubagentSummaryLine,
	summarizeSubagentSpend,
	TrayInfoLine,
} from "./components/subagent-summary-line.js";
import { ThinkingSelectorComponent } from "./components/thinking-selector.js";
import {
	selectLatestToolExpandHint,
	ToolExecutionComponent,
	type ToolExecutionDefinition,
} from "./components/tool-execution.js";
import { setQuietConversationBudget, setToolOutputFull, toolOutputFull } from "./components/tool-output-budget.js";
import { TopBar } from "./components/top-bar.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import {
	PROCESS_FOLD_THRESHOLD,
	TurnActivityState,
	type TurnStep,
	TurnSummaryComponent,
} from "./components/turn-activity.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import { FeatureHintDeck } from "./feature-hints.js";
import { scopeHeartbeatsToSession } from "./heartbeat-scope.js";
import {
	collectMarkedImages,
	evictImagesToBudget,
	formatImageMarker,
	imageMarkerIds,
	remapImageMarkers,
} from "./image-markers.js";
import type {
	InteractiveModeLocalSessionHost,
	InteractiveModeLocalToolRendererDefinition,
	InteractiveModeUiServices,
} from "./interactive-mode-services.js";
import {
	isOnboardingModelReady,
	type OnboardingStartupState,
	shouldRunOnboarding,
	shouldRunPrimeCliOnboardingSplash,
} from "./onboarding.js";
import { PastedImageFiles, pastedImageProblemNotice } from "./pasted-image-files.js";
import { imageFilesInPaste } from "./pasted-image-paths.js";
import type { ClientPromptStashStore, PromptStash, PromptStashState } from "./prompt-stash-state.js";
import { QueueSelection, type QueueSelectionItem } from "./queue-selection.js";
import { findRecentSession, formatAgo, type RecentSession } from "./recent-session.js";
import { formatResumeHint } from "./resume-hint.js";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.js";
import { getSpinnerTick, SPINNER_INTERVAL_MS, setWorkingPulseTick, spinnerFrame } from "./theme/working-icon.js";

interface Expandable {
	setExpanded(expanded: boolean): void;
}

interface PendingToolCallRenderInput {
	id: string;
	name: string;
	arguments: ToolCall["arguments"];
}

const HEARTBEAT_LEGACY_PROMPT_MIN_TOLERANCE_MS = 15_000;
const HEARTBEAT_LEGACY_PROMPT_MAX_TOLERANCE_MS = 120_000;
const MODEL_CATALOG_REFRESH_TTL_MS = 60_000;

/**
 * Compaction window limits for a model: identity for the measured-input-limit
 * table plus the model's config-declared rate-quota heuristic (models.json
 * `usageWindowTokens`), so the footer's threshold readout matches the
 * session-side trigger exactly.
 */
function compactionLimitsForModel(model: Model<any>): CompactionWindowLimits {
	return { provider: model.provider, modelId: model.id, usageWindowTokens: model.usageWindowTokens };
}
/**
 * Frozen into the session's last frame when the terminal is handed back to the agents
 * view (F5). That view rebuilds its catalogs before it paints anything, so without this
 * the user watches a session that still looks live and typed-into.
 */
export const AGENTS_VIEW_HANDOFF_STATUS_MESSAGE = "Opening the agents view…";
const FEATURE_HINT_DELAY_MS = 5_000;
/**
 * Spend-cell refresh cadence. The figure comes from the context tree, whose
 * disk scan is budgeted but not free, so events coalesce through a debounce and
 * live activity rescans at most once per interval; forced refreshes (turn end)
 * bypass the throttle.
 *
 * Measured on real session families (2026-09-17, scanContextTreeChildrenFromDisk
 * with the default budget, this machine): an ordinary family (4 children,
 * ~28KiB of transcripts) scans in ~0.5-3ms reading 0.02MiB - far inside the 5s
 * cadence. Byte-budget-biting families (251 children / 220MiB and 544 children
 * / 743MiB on disk) scan in ~150-320ms while parsing the 64MiB the budget
 * allows, warm cache included. A scan slower than the heavy threshold therefore
 * pushes the cadence floor up to the heavy interval: a busy huge family costs
 * ~2% duty (320ms/15s) instead of ~6% (320ms/5s), while ordinary families keep
 * the 5s cadence untouched. The cadence only applies while sub-agent events are
 * firing; a quiet family schedules nothing and scans nothing.
 */
const SUBAGENT_SPEND_DEBOUNCE_MS = 500;
const SUBAGENT_SPEND_MIN_INTERVAL_MS = 5_000;
const SUBAGENT_SPEND_HEAVY_SCAN_MS = 100;
const SUBAGENT_SPEND_HEAVY_INTERVAL_MS = 15_000;
/**
 * Fallback idle heartbeat of a visible spend cell, in ms, for callers whose settings
 * surface predates `ui.subagentSpendCell.intervalMs` (the live value comes from the
 * settings manager; see `subagentSpendIntervalMs`).
 *
 * The cell stays fresh while a family works without polling per event: the context
 * tree behind it is a disk-scanning RPC, and a working family emits child updates
 * continuously, so a per-update refresh meant a tree scan behind every burst. One
 * tick per interval is the freshness the figure is worth - money spent by sub-agents
 * moves slowly compared to the update stream that used to trigger the scans - and a
 * quiet family costs one scan per tick instead of one per update.
 */
const SUBAGENT_SPEND_IDLE_TICK_MS = 15_000;
/** How long the first stop-all-subagents press stays armed for the confirming second press. */
const STOP_ALL_SUBAGENTS_CONFIRM_WINDOW_MS = 5_000;

/**
 * One context-tree scan and who it belongs to. The spend cell and the fullscreen top
 * bar both read their figure from this RPC, so the result is shared: `at` is when it
 * landed, `ms` how long it took (a heavy family widens the sharing window), and
 * `promise` is the scan in flight for consumers that arrive while it runs.
 */
interface SharedContextTree {
	connection: AgentConnection;
	sessionId: string | undefined;
	/** When the shared scan landed (epoch ms); 0 while there is no result. */
	at: number;
	/** Wall time of the shared scan (ms); 0 while there is no result. */
	ms: number;
	tree: ContextTreeNode | undefined;
	promise: Promise<ContextTreeNode> | undefined;
}

/** The prompt's placeholder while a turn runs: Enter steers the running turn. */
const WORKING_PROMPT_PLACEHOLDER = "随时补充或纠正，Enter 发给 AI";
/** How long a transient footer notice (`✓ copied`) stays lit. */
const FOOTER_TOAST_MS = 2000;
/** Session events that end a quiet spell: the stall bar stops counting its silence at the first one. */
const STALL_QUIET_ENDING_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_update",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);
/** The terminal's reply to a cell-size query: input on the wire, but not the owner pressing a key. */
const TERMINAL_CELL_SIZE_REPORT = /^\x1b\[6;\d+;\d+t$/;

export const START_HINTS = [
	"描述任务，@ 引用文件，/ 看命令",
	"比如：重构 @文件，让它更好读",
	"比如：修一下 @文件 里的 bug",
	"比如：给 @文件 补上测试",
	"比如：讲讲 @文件 是怎么工作的",
] as const;

export function getRandomStartHint(random = Math.random): (typeof START_HINTS)[number] {
	return START_HINTS[Math.floor(random() * START_HINTS.length)] ?? START_HINTS[0];
}

/**
 * Queue previews the session already labels (the English labels double as
 * detection keys in core), mapped to their display wording.
 */
const LABELED_QUEUED_PREVIEWS: ReadonlyArray<[prefix: string, display: string]> = [
	[`${HEARTBEAT_PROMPT_PREVIEW_LABEL}: `, "定时任务："],
	[`${GOAL_CONTEXT_PREVIEW_LABEL}: `, "目标："],
	[`${AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL}: `, "收到消息："],
];

/** The queued-message row labels: a steer lands in the running turn, a follow-up after it. */
const QUEUED_MESSAGE_LABELS = { Steering: "插话", "Follow-up": "稍后发送" } as const;

export function formatQueuedMessagePreview(message: string, label: "Steering" | "Follow-up"): string {
	for (const [prefix, display] of LABELED_QUEUED_PREVIEWS) {
		if (message.startsWith(prefix)) return `${display}${message.slice(prefix.length)}`;
	}
	return `${QUEUED_MESSAGE_LABELS[label]}：${message}`;
}

export function styleQueuedMessagePreview(
	message: string,
	label: "Steering" | "Follow-up",
	isRecognizedSlashCommand: (name: string) => boolean,
): string {
	const preview = formatQueuedMessagePreview(message, label);
	const styleDim = (segment: string) => theme.fg("dim", segment);
	if (!isLeadingSlashCommand(message, isRecognizedSlashCommand)) return styleArgumentTokens(preview, styleDim);
	const prefix = preview.slice(0, preview.length - message.length);
	return `${theme.fg("dim", prefix)}${styleSlashCommandText(message, (rest, includeBareSeparator) =>
		styleArgumentTokens(rest, styleDim, includeBareSeparator),
	)}`;
}

/**
 * A fallback-chain notice as one status row, like the live switch notice, so a
 * return to the primary or an unread image reads the same live and on replay.
 */
function createProviderFallbackNoticeRow(message: CustomMessage): Component {
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("\n");
	const kind = (message.details as { kind?: unknown } | undefined)?.kind;
	const row = new Container();
	row.addChild(new Spacer(1));
	row.addChild(new Text(theme.fg(kind === "return" ? "dim" : "warning", text), 1, 0));
	return row;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

/**
 * One lane bundle: where each expansion surface reads its state from. The
 * per-turn values come from the owning turn's TurnActivityState; the globals
 * serve turn-less children and the header (K3 ②).
 */
function applyExpansionLanes(
	child: unknown,
	lanes: { thinking: boolean; tools: boolean; agentMessages: boolean; editDiffs: boolean },
): void {
	if (child instanceof AssistantMessageComponent) {
		// U6 two-key model: T drives the thinking traces; O drives the error
		// detail surface.
		child.setThinkingExpanded(lanes.thinking);
	}
	if (isExpandable(child)) {
		child.setExpanded(child instanceof AgentMessageComponent ? lanes.agentMessages : lanes.tools);
	}
	if (hasAgentMessagesExpansion(child)) {
		child.setAgentMessagesExpanded(lanes.agentMessages);
	}
	if (hasEditDiffsExpansion(child)) {
		child.setEditDiffsExpanded(lanes.editDiffs);
	}
}

interface AgentMessagesExpandable {
	setAgentMessagesExpanded(expanded: boolean): void;
}

function hasAgentMessagesExpansion(obj: unknown): obj is AgentMessagesExpandable {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"setAgentMessagesExpanded" in obj &&
		typeof (obj as AgentMessagesExpandable).setAgentMessagesExpanded === "function"
	);
}

interface EditDiffsExpandable {
	setEditDiffsExpanded(expanded: boolean): void;
}

function hasEditDiffsExpansion(obj: unknown): obj is EditDiffsExpandable {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"setEditDiffsExpanded" in obj &&
		typeof (obj as EditDiffsExpandable).setEditDiffsExpanded === "function"
	);
}

class ExpandableText extends Text implements Expandable {
	private expandedState: boolean;
	private clickRegions: ClickRegion[] = [];

	constructor(
		private readonly getCollapsedText: () => string,
		private readonly getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.expandedState = expanded;
	}

	setExpanded(expanded: boolean): void {
		this.expandedState = expanded;
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		this.clickRegions =
			lines.length > 0
				? [{ line: 0, col: 0, width, height: 1, onClick: () => this.setExpanded(!this.expandedState) }]
				: [];
		return lines;
	}

	getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.clickRegions;
	}
}

export function formatSplashCwd(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/");
	const home = os.homedir().replace(/\\/g, "/");
	if (home && normalized === home) {
		return "~";
	}
	if (home && normalized.startsWith(`${home}/`)) {
		return `~${normalized.slice(home.length)}`;
	}

	return normalized;
}

function mergeSubagentSnapshot(
	previous: AgentConnectionRlmChildAgentSnapshot,
	incoming: AgentConnectionRlmChildAgentSnapshot,
): AgentConnectionRlmChildAgentSnapshot {
	const active = incoming.status === "running" || incoming.status === "queued";
	return {
		...previous,
		...incoming,
		parentId: incoming.parentId ?? previous.parentId,
		// Active updates may omit a previously known daemon session id, but a
		// terminal update without one means the child is no longer resident.
		activeSessionId: active ? (incoming.activeSessionId ?? previous.activeSessionId) : incoming.activeSessionId,
		// A completed retained child can become active again when it receives a
		// follow-up. Its RLM run status stays terminal, so activity must remain an
		// independent projection of the live session state.
		activity: active ? (incoming.activity ?? previous.activity) : incoming.activity,
	};
}

export function truncatePathMiddle(value: string, width: number): string {
	if (visibleWidth(value) <= width) {
		return value;
	}
	if (width <= 1) {
		return truncateToWidth(value, width, "");
	}

	const ellipsis = "…";
	const normalized = value.replace(/\\/g, "/");
	const prefix = normalized.startsWith("~/") ? "~/" : normalized.startsWith("/") ? "/" : "";
	const body = prefix ? normalized.slice(prefix.length) : normalized;
	const parts = body.split("/").filter((part) => part.length > 0);
	const last = parts.pop() ?? "";
	const previous = parts.pop();
	const suffix = previous ? `${previous}/${last}` : last;
	const candidate = `${prefix}${ellipsis}/${suffix}`;
	if (visibleWidth(candidate) <= width) {
		return candidate;
	}

	return truncateToWidth(candidate, width);
}

export interface BrandSplashMetadataLine {
	label: string;
	value: string;
}

export interface BrandSplashHeaderOptions {
	logo?: string;
	topPadding?: boolean;
	getExtraMetadata?: () => readonly BrandSplashMetadataLine[];
}

export class BrandSplashHeader implements Component {
	private readonly logoRaw: string[];
	private readonly labelWidth = 8;

	constructor(
		private readonly version: string,
		private readonly getModelId: () => string | undefined,
		private readonly getCwd: () => string,
		private readonly verboseInstructions?: string,
		private readonly options: BrandSplashHeaderOptions = {},
	) {
		this.logoRaw = options.logo ? options.logo.split("\n") : [];
	}

	invalidate(): void {
		// Render output is derived from current theme/session state.
	}

	/**
	 * A compact header: the wordmark and version, then one labelled row per
	 * fact (model, directory, extras). The logo mark only renders when a
	 * caller passes one explicitly; the start hint lives in the prompt's
	 * placeholder, not here.
	 */
	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const paddingX = safeWidth > 1 ? 1 : 0;
		const contentWidth = Math.max(1, safeWidth - paddingX * 2);
		const pad = (content: string) => {
			const fitted = truncateToWidth(content, contentWidth, "");
			return " ".repeat(paddingX) + fitted + " ".repeat(Math.max(0, safeWidth - paddingX - visibleWidth(fitted)));
		};
		const valueWidth = Math.max(1, contentWidth - this.labelWidth);
		const labelled = (label: string, value: string, isPath = false) =>
			theme.fg("dim", label + " ".repeat(Math.max(2, this.labelWidth - visibleWidth(label)))) +
			theme.fg("muted", isPath ? truncatePathMiddle(value, valueWidth) : truncateToWidth(value, valueWidth));
		const lines = this.options.topPadding ? [""] : [];
		if (this.options.logo) {
			for (const line of this.logoRaw) {
				lines.push(pad(theme.fg("text", line)));
			}
			lines.push(pad(""));
		}
		lines.push(pad(`${theme.bold(theme.fg("accent", "prime-agent"))}  ${theme.fg("dim", `v${this.version}`)}`));
		lines.push(pad(""));
		lines.push(pad(labelled("模型", this.getModelId() ?? "—")));
		lines.push(pad(labelled("目录", formatSplashCwd(this.getCwd()), true)));
		for (const line of this.options.getExtraMetadata?.() ?? []) {
			lines.push(pad(labelled(line.label, line.value)));
		}

		if (this.verboseInstructions) {
			lines.push(" ".repeat(safeWidth));
			for (const instruction of this.verboseInstructions.split("\n")) {
				lines.push(pad(instruction));
			}
		}

		return lines;
	}
}

type StartupPromptBarrierOutcome = "admitted" | "retained" | "lifecycle-cancelled";

type GoalAnnouncementSnapshot = {
	goalId?: string;
	status: GoalState["status"];
	objective?: string;
	lastReason?: string;
	lastError?: string;
};

type ModelFallbackWarningAction = "show" | "suppress";

interface OnboardingSplashHandle {
	showProgress(message: string): void;
	dismiss(): void;
}

const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Very deep reasoning",
	max: "Maximum reasoning",
};

const HEARTBEAT_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
	{
		value: "every ",
		label: "every <duration> <instruction>",
		description: "Set an interval, then add an instruction: /heartbeat every 10s Scan the logs",
	},
	{
		value: "--steer ",
		label: "--steer <instruction>",
		description: "Deliver by interrupting the current turn (default)",
	},
	{
		value: "--follow-up ",
		label: "--follow-up <instruction>",
		description: "Deliver as a follow-up after the current turn finishes",
	},
];

const TRACES_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Show trace sharing status" },
	{ value: "on", label: "on", description: "Enable automatic trace uploads" },
	{ value: "off", label: "off", description: "Disable automatic trace uploads" },
	{ value: "preview", label: "preview", description: "Preview the current session trace" },
	{ value: "upload", label: "upload", description: "Alias of upload-current" },
	{ value: "upload-current", label: "upload-current", description: "Upload the current session trace" },
	{ value: "upload-all", label: "upload-all", description: "Upload all persisted traces" },
	{ value: "login", label: "login", description: "Configure the Prime API key for trace uploads" },
];

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

// Cap on retained pasted-image bytes (base64). Images are resized below the
// inline limit before storing, so this holds many recent pastes; the oldest are
// evicted past the cap to keep a long session bounded.
const MAX_PASTED_IMAGE_BYTES = 64 * 1024 * 1024;
const INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT = 400;
// Live streaming only ever appends to the chat tree. When the settled tree grows
// past this component cap, rebuild it through the initial-render window so a long
// session's transcript stays bounded in memory.
const LIVE_CHAT_COMPONENT_LIMIT = 800;

function initialRenderMessages(messages: AgentMessage[]): AgentMessage[] {
	if (messages.length <= INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT) {
		return messages;
	}
	const toolCallMessages = new Map<string, { index: number; message: Extract<AgentMessage, { role: "assistant" }> }>();
	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const content of message.content) {
			if (content.type === "toolCall") {
				toolCallMessages.set(content.id, { index, message });
			}
		}
	}

	const initialStartIndex = messages.length - INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT;
	for (let startIndex = initialStartIndex; startIndex < messages.length; startIndex++) {
		const visibleMessages = messages.slice(startIndex);
		const visibleToolCallIds = new Set<string>();
		for (const message of visibleMessages) {
			if (message.role !== "assistant") {
				continue;
			}
			for (const content of message.content) {
				if (content.type === "toolCall") {
					visibleToolCallIds.add(content.id);
				}
			}
		}

		const requiredToolCallIdsByMessage = new Map<
			number,
			{ message: Extract<AgentMessage, { role: "assistant" }>; toolCallIds: Set<string> }
		>();
		for (const message of visibleMessages) {
			if (message.role !== "toolResult" || visibleToolCallIds.has(message.toolCallId)) {
				continue;
			}
			const toolCallMessage = toolCallMessages.get(message.toolCallId);
			if (!toolCallMessage || toolCallMessage.index >= startIndex) {
				continue;
			}
			const requiredMessage = requiredToolCallIdsByMessage.get(toolCallMessage.index) ?? {
				message: toolCallMessage.message,
				toolCallIds: new Set<string>(),
			};
			requiredMessage.toolCallIds.add(message.toolCallId);
			requiredToolCallIdsByMessage.set(toolCallMessage.index, requiredMessage);
		}

		if (visibleMessages.length + requiredToolCallIdsByMessage.size > INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT) {
			continue;
		}

		const requiredToolCallMessages = [...requiredToolCallIdsByMessage.entries()]
			.sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
			.map(([, { message, toolCallIds }]) => ({
				...message,
				content: message.content.filter((content) => content.type !== "toolCall" || toolCallIds.has(content.id)),
			}));
		return omitOrphanToolResults([...requiredToolCallMessages, ...visibleMessages]);
	}

	return [];
}

function omitOrphanToolResults(messages: AgentMessage[]): AgentMessage[] {
	const renderedToolCallIds = new Set<string>();
	const renderableMessages: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "toolCall") {
					renderedToolCallIds.add(content.id);
				}
			}
			renderableMessages.push(message);
		} else if (message.role === "toolResult") {
			if (renderedToolCallIds.has(message.toolCallId)) {
				renderableMessages.push(message);
			}
		} else {
			renderableMessages.push(message);
		}
	}
	return renderableMessages;
}

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

function getPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" ? value : undefined;
}

function getPayloadNumber(payload: Record<string, unknown>, key: string): number | undefined {
	const value = payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getPayloadBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
	const value = payload[key];
	return typeof value === "boolean" ? value : undefined;
}

function getPayloadStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
	const value = payload[key];
	if (value === undefined) {
		return undefined;
	}
	return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : undefined;
}

function getPayloadNotifyType(payload: Record<string, unknown>, key: string): "info" | "warning" | "error" | undefined {
	const value = payload[key];
	return value === "info" || value === "warning" || value === "error" ? value : undefined;
}

function getPayloadWidgetPlacement(
	payload: Record<string, unknown>,
	key: string,
): "aboveEditor" | "belowEditor" | undefined {
	const value = payload[key];
	return value === "aboveEditor" || value === "belowEditor" ? value : undefined;
}

function getPayloadWorkingIndicatorOptions(
	payload: Record<string, unknown>,
	key: string,
): LoaderIndicatorOptions | undefined {
	const value = payload[key];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const optionsPayload = value as Record<string, unknown>;
	const frames = getPayloadStringArray(optionsPayload, "frames");
	const intervalMs = getPayloadNumber(optionsPayload, "intervalMs");
	return {
		...(frames === undefined ? {} : { frames }),
		...(intervalMs === undefined ? {} : { intervalMs }),
	};
}

export interface DaemonReconnectBanner {
	message: string;
	tone: "dim" | "warning";
}

/**
 * One-line banner for a recovered daemon connection. When the restarted daemon
 * is NEWER than this window's binary, say so instead of pretending the window
 * is updated; the user restarts the window to pick up the new version. An
 * older or unorderable daemon version is reported without the advice (restarting
 * this window would pick up nothing).
 */
export function formatDaemonReconnectBanner(
	daemonVersion: string | undefined,
	clientVersion: string,
): DaemonReconnectBanner {
	if (!daemonVersion) {
		return { message: "Daemon reconnected", tone: "dim" };
	}
	if (daemonVersion === clientVersion) {
		return { message: `Daemon restarted (v${daemonVersion}) - reconnected`, tone: "dim" };
	}
	if (isDaemonVersionNewer(daemonVersion, clientVersion)) {
		return {
			message: `Daemon restarted (v${daemonVersion}), this window still runs v${clientVersion} - restart the window to pick up the update.`,
			tone: "warning",
		};
	}
	return { message: `Daemon restarted (v${daemonVersion}), this window runs v${clientVersion}.`, tone: "dim" };
}

/**
 * Numeric version-prefix comparison ("0.9.5-beta.7" orders by 0.9.5); unparseable segments
 * end the comparison. A numeric-equal release outranks the same version's prereleases.
 */
function isDaemonVersionNewer(daemonVersion: string, clientVersion: string): boolean {
	const daemon = parseNumericVersionPrefix(daemonVersion);
	const client = parseNumericVersionPrefix(clientVersion);
	for (let index = 0; index < Math.max(daemon.length, client.length); index++) {
		const difference = (daemon[index] ?? 0) - (client[index] ?? 0);
		if (difference !== 0) {
			return difference > 0;
		}
	}
	// Semver orders a release ahead of its own prereleases ("1.2.3" > "1.2.3-beta.1"),
	// so a numeric-equal daemon without a prerelease suffix outranks a client with one.
	return !hasPrereleaseSuffix(daemonVersion) && hasPrereleaseSuffix(clientVersion);
}

/** The dot- and dash-separated segments of a version: "1.2.3-beta.1" -> ["1", "2", "3", "beta", "1"]. */
function splitVersionSegments(value: string): string[] {
	return value.split(/[.-]/);
}

/** The leading numeric segments of a version string; the first unparseable segment ends the prefix. */
function parseNumericVersionPrefix(value: string): number[] {
	const segments: number[] = [];
	for (const segment of splitVersionSegments(value)) {
		const parsed = Number(segment);
		if (!Number.isFinite(parsed)) break;
		segments.push(parsed);
	}
	return segments;
}

/** Whether a version string continues past its numeric prefix with a prerelease suffix. */
function hasPrereleaseSuffix(version: string): boolean {
	const segments = splitVersionSegments(version);
	const prefixLength = parseNumericVersionPrefix(version).length;
	return prefixLength > 0 && prefixLength < segments.length;
}

export function updateArgsIncludeSelf(args: readonly string[]): boolean {
	let selfFlag = false;
	let extensionsOnlyFlag = false;
	let positional: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--self") {
			selfFlag = true;
		} else if (arg === "--extensions") {
			extensionsOnlyFlag = true;
		} else if (arg === "--extension") {
			extensionsOnlyFlag = true;
			index++;
		} else if (arg === "--daemon-socket") {
			index++;
		} else if (arg && !arg.startsWith("-") && positional === undefined) {
			positional = arg;
		}
	}
	if (selfFlag) {
		return true;
	}
	if (extensionsOnlyFlag) {
		return false;
	}
	if (!positional) {
		return true;
	}
	const normalized = positional.toLowerCase();
	return normalized === "self" || normalized === "pi" || normalized === APP_NAME.toLowerCase();
}

function argsIncludeSessionSelection(args: readonly string[]): boolean {
	for (const arg of args) {
		if (arg === "--resume" || arg === "-r" || arg === "--continue" || arg === "-c" || arg === "--fork") {
			return true;
		}
	}
	return false;
}

export function buildUpdateRelaunchArgs(args: readonly string[], sessionFile: string | undefined): string[] {
	const relaunchArgs = [...args];
	if (sessionFile && !argsIncludeSessionSelection(relaunchArgs)) {
		relaunchArgs.push("--resume", sessionFile);
	}
	return relaunchArgs;
}

type UpdateRelaunchExecve = (file: string, args: string[], environment: Record<string, string>) => never;

interface UpdateRelaunchExecOptions {
	platform: string;
	nodeVersion: string;
	cwd: string;
	previousCwd: string;
	environment: NodeJS.ProcessEnv;
	chdir: (directory: string) => void;
	execve?: UpdateRelaunchExecve;
}

function execveFailureThrows(nodeVersion: string): boolean {
	// Before Node 26.1, a failed execve syscall aborts the process instead of throwing for the fallback below.
	const match = /^(\d+)\.(\d+)\./.exec(nodeVersion);
	if (!match) {
		return false;
	}
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major > 26 || (major === 26 && minor >= 1);
}

export function tryExecUpdateRelaunch(launch: CliSubprocessLaunchSpec, options: UpdateRelaunchExecOptions): boolean {
	// Process replacement preserves the shell job and foreground terminal without retaining the old TUI.
	if (
		!options.execve ||
		options.platform === "win32" ||
		options.platform === "os400" ||
		!execveFailureThrows(options.nodeVersion)
	) {
		return false;
	}
	const environment = Object.fromEntries(
		Object.entries(options.environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	options.chdir(options.cwd);
	try {
		options.execve(launch.command, [launch.command, ...launch.args], environment);
	} catch (error) {
		// A thrown execve must not leave the fallback's process on a changed cwd.
		options.chdir(options.previousCwd);
		throw error;
	}
	return true;
}

export function buildUpdateChildArgs(args: readonly string[], daemonSocketPath: string): string[] {
	return args.includes("--daemon-socket") ? [...args] : [...args, "--daemon-socket", daemonSocketPath];
}

export function resolveInteractiveUpdateDaemonSocketPath(
	args: readonly string[],
	activeDaemonSocketPath: string,
): string {
	const socketFlagIndex = args.indexOf("--daemon-socket");
	return socketFlagIndex === -1 ? activeDaemonSocketPath : (args[socketFlagIndex + 1] ?? activeDaemonSocketPath);
}

export interface InteractiveInitialPrompt {
	text: string;
	images?: ImageContent[];
}

export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** One-off warning shown on startup. */
	startupNotice?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional text-only messages to send after the initial message. */
	initialMessages?: string[];
	/** Additional image-bearing prompts to send after the initial messages. */
	initialPrompts?: InteractiveInitialPrompt[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Agent execution boundary. InteractiveMode never talks directly to AgentSession for core execution. */
	agentConnection: AgentConnection;
	/** Exact daemon socket to preserve across an interactive self-update restart. */
	daemonSocketPath?: string;
	/**
	 * Local-only host for in-process extension binding and callback-bearing session operations.
	 * This must remain optional adapter glue, not a generic execution dependency.
	 */
	localSessionHost?: InteractiveModeLocalSessionHost;
	/** Bind extension handlers in the local session host. Disabled for daemon/gateway-backed clients. */
	bindLocalSessionExtensions?: boolean;
	/** UI-local services used for settings, auth, resources, and rendering. Defaults to services from localSessionHost. */
	uiServices?: InteractiveModeUiServices;
	/** Extra cleanup for externally-owned UI service hosts. Runs after the connection is disposed and before process exit. */
	onShutdown?: () => void | Promise<void>;
	/** Allow returning from a full session to the agents view without stopping the daemon-owned agent. */
	returnToAgentsView?: boolean;
	/** Enter fullscreen regardless of the persisted fullscreen preference. */
	forceFullscreen?: boolean;
	/**
	 * The agents view already surfaced global startup notices (app/extension updates, tmux setup),
	 * so this session must not repeat them in its chat stream. Distinct from `returnToAgentsView`,
	 * which also covers direct daemon attaches where the agents view was never shown.
	 */
	agentsViewOwnsStartupNotices?: boolean;
	/** Persisted RLM depth supplied by the daemon SessionSummary. */
	sessionDepth?: number;
	/** Whether the unified daemon/catalog projection had any direct children. */
	sessionHasChildren?: boolean;
	/** Client-owned stash store shared across chat views in this TUI process. */
	promptStashStore?: ClientPromptStashStore;
	/** Initial stable session id used to scope prompt stash state. */
	promptStashSessionId?: string;
}

export interface InteractiveModeRunResult {
	type: "agents_view" | "scoped_agents_view";
	/** A subagent picked in the chat's panel: the agents view opens it straight away. */
	openChildActiveSessionId?: string;
	/**
	 * The same pick by child identity, for a child that is no longer resident (the
	 * daemon closed it after it sat idle): the agents view reopens its saved session.
	 */
	openChild?: { childId: string; sessionDir?: string };
	/**
	 * This subagent's session was closed under the viewer (deleted, stopped, or
	 * finished): the agents view returns to its parent and shows this line.
	 */
	returnToParentNotice?: string;
	source: Pick<AgentConnectionState, "activeSessionId" | "sessionFile" | "sessionId" | "sessionName" | "cwd">;
}

/**
 * U6 评审短账: `深度 0` is zero-information decoration - the label renders only
 * for non-zero depths (a sub-agent's own nest level). `hasChildren` stays in
 * the signature for call-site compatibility and no longer widens the rule.
 */
export function formatAgentDepthLabel(depth: number | undefined, hasChildren: boolean): string | undefined {
	void hasChildren;
	if (depth === undefined || depth < 1) return undefined;
	return `深度 ${depth}`;
}

export class InteractiveMode {
	private static readonly EXIT_HINT_DURATION_MS = 2000;
	private static readonly ESCAPE_REPEAT_WINDOW_MS = 500;

	private uiServices: InteractiveModeUiServices;
	private agentConnection: AgentConnection;
	private localSessionHost: InteractiveModeLocalSessionHost | undefined;
	private bindLocalSessionExtensions: boolean;
	private ui: TUI;
	private chatContainer: Container;
	private shortcutGuideContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private queuedMessagesContainer: Container;
	private sideQuestionContainer: Container;
	private featureHintContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private readonly promptStashStore: ClientPromptStashStore | undefined;
	private promptStashSessionId: string | undefined;
	private promptStashState: PromptStashState;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private mainContainer: Container;
	private mainViewContainer: Container;
	// prompt bar (editor + footer slot) — the only thing pinned to the bottom in fullscreen
	private promptDock: Container;
	// wraps the active footer so custom-footer swaps reflect in both layouts
	private footerSlot: Container;
	private fullscreenEnabled = false;
	// /speed state: display flag plus per-session output tok/sec tracking (see recordSpeedSample).
	private speedDisplayEnabled = false;
	// Accumulated output-token/duration totals; allocated on the first recorded sample.
	private speedStats: { tokens: number; durationMs: number; samples: number } | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private readonly startHint = getRandomStartHint();
	private isInitialized = false;
	private onInputCallback?: (text: string | undefined) => void;
	private submittedInputBehavior: "steer" | "followUp" = "steer";
	private latestEditorPromptStash: PromptStash | undefined;
	private pendingSubmittedPromptStash: PromptStash | undefined;
	private inputSubmissionGeneration = 0;
	private inputSubmissionsPending = 0;
	private pendingPromptStashReleases: { sessionId: string; state: PromptStashState }[] = [];
	private readonly retainedSubmissionGenerations = new WeakMap<PromptStash, number>();
	private admitPendingStartupPrompts: (() => Promise<StartupPromptBarrierOutcome>) | undefined;
	private agentsViewRequest: InteractiveModeRunResult["type"] | undefined;
	private openChildActiveSessionId: string | undefined;
	private agentsViewHandoff: Pick<InteractiveModeRunResult, "openChild" | "returnToParentNotice"> = {};
	private loadingAnimation: Loader | undefined = undefined;
	private workingMessage: string | undefined = undefined;
	/** Block navigation (Alt+Up): the invisible focus owner and the focused block. */
	private blockNavigation:
		| {
				navigator: BlockNavigator;
				focused: FocusableBlock & Component;
				/** Following the tail when navigation began: leaving it follows again. */
				resumeFollow: boolean;
		  }
		| undefined;
	private recentSession: RecentSession | undefined;
	/** When the current agent run started (agent_start), the floor for its turn clock. */
	private agentRunStartedAt: number | undefined;
	private workingVisible = true;
	private workingIndicatorOptions: LoaderIndicatorOptions | undefined = undefined;
	private workingStartedAt: number | undefined = undefined;
	// Start of the in-flight run; survives loader teardown so the elapsed display doesn't reset on re-entry.
	private turnStartedAt: number | undefined = undefined;
	private workingTimer: NodeJS.Timeout | undefined = undefined;
	private readonly featureHintDeck = new FeatureHintDeck();
	private currentFeatureHint: string | undefined;
	private featureHintEligibleAt = 0;
	private featureHintTimer: NodeJS.Timeout | undefined;
	private featureHintAnimationTimer: NodeJS.Timeout | undefined;
	private featureHintComponent: FeatureHintComponent | undefined;
	private featureHintRunPending = false;
	private featureHintSuppressedByQueue = false;
	private pulseTimer: NodeJS.Timeout | undefined = undefined;
	private pulseFrame = 0;
	private readonly activityTracker = new AgentActivityTracker();
	// activityTracker token count already folded into the context snapshot; only output beyond
	// this counts as live in-flight (keeps auto-retries from re-adding a failed attempt).
	private contextUsageTokenBaseline = 0;
	// Refresh ordering: a stale failure must never clobber a newer success.
	private contextUsageRefresh = { generation: 0, lastSuccessGeneration: 0 };
	private readonly defaultHiddenThinkingLabel = "Thinking";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private ctrlCExitHintExpiresAt = 0;
	private ctrlCExitHintTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private escapeRepeatAction: "tree" | "clear" | undefined;
	private escapeRepeatExpiresAt = 0;
	private escapeRepeatTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private anthropicSubscriptionWarningShown = false;

	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;
	private lastGoalAnnouncement: GoalAnnouncementSnapshot | undefined = undefined;
	private goalTrayTimer: NodeJS.Timeout | undefined = undefined;

	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	/**
	 * r4 recovery-shell: the live stall action bar. Non-modal, no focus grab; the
	 * input listener below routes keys to it while it is visible (B1) and every
	 * other key dismisses it and flows on. Replaced by the next stall_warning,
	 * torn down by the terminal stall stages (S1), by turn_end (the warning's
	 * turn is over mid-run) and by agent_end (the run is over) - a bar must never
	 * outlive the turn it speaks for.
	 */
	private stallActionBar: StallActions | undefined;
	/** The stall event the live bar was mounted for (its diagnostics outlive the stall). */
	private stallActionBarEvent: (StallEventView & { actions?: StallEventActions }) | undefined;
	/** The live bar is the settled one (the turn went on; diagnostics only). */
	private stallActionBarSettled = false;
	/** When the live bar was mounted: its quiet time keeps counting from the event's reading. */
	private stallActionBarMountedAt: number | undefined;
	/** The first sign of activity after the bar mounted; the quiet ended there. */
	private stallActionBarActivityAt: number | undefined;
	/** B1: the stall bar's input route, registered once and unregistered on teardown. */
	private removeStallActionInputListener: (() => void) | undefined = undefined;
	/** The open stall diagnostics block; the diagnostics key pressed again closes it. */
	private stallDiagnosticsPanel: { components: Component[]; removeInputListener: () => void } | undefined;
	/**
	 * U6 评审②: the memoized watermark pair. One frame, one value: the footer
	 * and the tray fallback both read this, and it only recomputes after an
	 * invalidation (turn end, usage refresh, rebind, model/thinking change,
	 * settings reload) - never per-component.
	 */
	private footerTelemetryDirty = true;
	private footerTelemetryCached: FooterTelemetrySource | undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;
	private sideQuestionComponent: SideQuestionComponent | undefined;
	private sideQuestionEvent: AgentConnectionSideQuestionEvent | undefined;
	private sideQuestionTurns: AgentConnectionSideQuestionEvent[] = [];
	private activeSideQuestionId: string | undefined;
	// Set while a ! bash command runs inside the side conversation: its
	// BashExecutionComponent renders inside the pane instead of the main chat.
	// bash_* events broadcast to every attached client, so runs correlate by
	// runId — the runId we generate here is echoed on our run's events.
	private sideQuestionBash: { runId: string; input: string; seedTranscript: boolean } | undefined;
	// The pane-mounted component of our own side run; bash_end seeds the side
	// transcript only when it ends this exact component.
	private sideQuestionBashComponent: BashExecutionComponent | undefined;
	// Holds the runId of a side bash abandoned at pane close: that run's
	// remaining bash_* events are swallowed (until its bash_end) instead of
	// leaking into the main transcript.
	private sideQuestionBashDiscarded: string | undefined;

	// User bash execution tracking (! / !! prefix), driven by bash_* session events
	private activeBashComponent: BashExecutionComponent | undefined = undefined;
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Serializes session event handling; see subscribeToAgent
	private sessionEventQueue: Promise<void> = Promise.resolve();
	private sessionEventGeneration = 0;
	private fastModeToggleQueue: Promise<void> = Promise.resolve();

	private pendingTools = new Map<string, ToolExecutionComponent>();
	private ipythonToolComponents = new Map<string, ToolExecutionComponent>();
	private lateIpythonSentAgentMessages = new Map<string, KernelSentAgentMessage[]>();
	private pendingToolCreations = new Set<string>();
	private startedToolCalls = new Set<string>();
	private pendingToolGeneration = 0;
	/** The chat tree currently shows a windowed tail instead of the full transcript. */
	private chatTranscriptTrimmed = false;
	/** Component count left by the last cap rebuild; prevents re-trimming a window that is itself over the cap. */
	private chatCapRebuildFloor = 0;
	private chatCapRebuildInFlight = false;
	private toolDefinitionCache = new Map<string, ToolExecutionDefinition | undefined>();
	private agentRunFileChanges = new Map<string, FileChangeSummary>();

	// One summary line below the editor, backed by the existing child-status stream.
	private subagentSummaryLine: SubagentSummaryLine;
	private trayInfoLine: TrayInfoLine;
	private subagentSnapshots = new Map<string, AgentConnectionRlmChildAgentSnapshot>();
	/** Children whose failure notice this chat has shown: the parent already knows. */
	private readonly seenSubagentFailureIds = new Set<string>();
	/** Armed by the first stop-all press; a second press within the window stops them. */
	private stopAllSubagentsArmedUntil: number | undefined;
	/** How this session's latest assistant message ended; tells a failed close from a finished one. */
	private lastAssistantStopReason: AssistantMessage["stopReason"] | undefined;
	private subagentCounts: SubagentSummaryCounts = { total: 0, running: 0, idle: 0, inactive: 0 };
	private subagentSpendTimer: ReturnType<typeof setTimeout> | undefined;
	/** When the pending spend-refresh timer fires (epoch ms); 0 with no timer. */
	private subagentSpendTimerDeadline = 0;
	/** When the last context-tree scan finished starting (epoch ms); 0 before the first. */
	private subagentSpendLastScanAt = 0;
	/** Wall time of the last context-tree scan (ms); 0 before the first. */
	private subagentSpendLastScanMs = 0;
	private subagentSpendScanning = false;
	/** A refresh was requested while a scan was in flight; rerun when it settles. */
	private subagentSpendRescanRequested = false;
	/** The pending timer / rerun was asked for by a forced request (turn end). */
	private subagentSpendRescanForced = false;
	/** The armed spend-refresh timer was armed by a forced request. */
	private subagentSpendTimerForced = false;
	/** Idle heartbeat of the visible spend cell; undefined while the cell is off screen. */
	private subagentSpendTickTimer: ReturnType<typeof setInterval> | undefined;
	/** Period the armed tick was created with, so a settings change re-arms it. */
	private subagentSpendTickIntervalMs = 0;
	/**
	 * Set while the terminal is suspended (Ctrl-Z) and the TUI is stopped: nothing is on
	 * screen, so the spend cell neither ticks nor refreshes until SIGCONT restores it.
	 */
	private terminalSuspended = false;
	private rlmNodeId: string | undefined;
	private rosterBar: { summaries(): SessionSummary[]; dispose(): Promise<void> } | undefined;

	private toolOutputExpanded = false;
	// U4 turn aggregation for the live run: one aggregate line per agent turn.
	private currentTurnState: TurnActivityState | undefined;
	private currentTurnSummary: TurnSummaryComponent | undefined;
	// U2: trailing consecutive errored tool results; a success resets it.
	private consecutiveToolErrors = 0;
	private agentMessagesExpanded = false;
	private editDiffsExpanded = true;

	private hideThinkingBlock = false;
	/** U6 (two-key model): Ctrl+T's lane — the thinking traces of assistant messages. */
	private thinkingExpanded = false;
	private readonly mermaidMarkdownTransform = createMermaidMarkdownTransform({
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		theme,
	});

	private skillCommands = new Map<string, string>();
	private connectionCommands: AgentConnectionSlashCommand[] = [];
	private connectionModelCatalog: AgentConnectionModel[] = [];
	private connectionConfiguredProviders = new Set<string>();
	private connectionModelsFetchedAt = 0;
	private connectionModelsRefreshVersion = 0;
	private connectionModelsRefreshInFlight: { version: number; promise: Promise<AgentConnectionModel[]> } | undefined;
	private connectionState: AgentConnectionState | undefined;
	private connectionResourceSnapshot: AgentConnectionResourceSnapshot | undefined;
	private heartbeatCatalog: AgentConnectionHeartbeat[] = [];
	private heartbeatRefreshPromise: Promise<void> | undefined;
	private heartbeatRefreshRequested = false;
	private heartbeatManager: HeartbeatManagerComponent | undefined;
	private heartbeatManagerHandle: OverlayHandle | undefined;
	private heartbeatManagerRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatManagerRefreshAt: number | undefined;

	// Registry of images pasted this session, keyed by the `[image #N]` marker
	// shown to the user. Insertion-ordered; the bytes persist (bounded by
	// MAX_PASTED_IMAGE_BYTES) so a marker resolves to its image whenever the text
	// reappears — on submit, undo, history recall, retry, or dequeue. A submission
	// attaches only the images whose markers are present in the sent text.
	private pastedImages = new Map<number, ImageContent>();
	private nextImageMarkerId = 1;
	// Files behind pasted images: Ctrl+V images saved under the session, pasted image
	// paths being loaded. The sent text names each saved file next to its marker.
	private pastedImageFilesStore: PastedImageFiles | undefined;
	// `provider/model` of the image model last announced as reading this turn's images.
	private imageModelServingNotice: string | undefined;

	private unsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	private autoCompactionLoader: Loader | undefined = undefined;
	private refineLoader: Loader | undefined = undefined;

	private retryLoader: Loader | undefined = undefined;
	/** The `已自动切换到 …` row a backup/fallback retry shows once it succeeds. */
	private pendingModelFallbackNotice: string | undefined = undefined;
	private retryCountdown: CountdownTimer | undefined = undefined;
	private traceUploadAllAbortController: AbortController | undefined = undefined;

	private readonly queueSelection = new QueueSelection();
	private isApplyingQueueSelectionText = false;
	private queueMutationChain: Promise<void> = Promise.resolve();
	private pendingQueueEdit: symbol | undefined;
	private pendingQueueMove = false;

	private shutdownRequested = false;

	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();
	private activeConnectionExtensionUiRequests = new Map<string, { cancelLocal: () => void }>();

	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// One-line recap of the agent's recent work, rendered just above the editor.
	private recapContainer!: Container;
	/** The duty log (值班记录) above the prompt; cleared on the next submitted input. */
	private dutyLogContainer!: Container;
	private sessionRecap: string | undefined;

	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	private headerContainer: Container;
	/** Pinned fullscreen top bar identifying the chat by name while scrolling. */
	private topBar: TopBar;
	/**
	 * The last context-tree scan, shared by every figure read from it.
	 *
	 * The spend cell and the top bar are two consumers of one disk-scanning RPC and
	 * used to scan independently, so a turn end paid for the same bytes twice. Both
	 * read through this memo now: a scan still in flight is joined, and a scan that
	 * landed at or after the moment a refresh was aiming for already answers it.
	 * Keyed to the connection and session it was scanned for, so a rebind can never
	 * serve one chat's spend to the next.
	 */
	private contextTreeShare: SharedContextTree | undefined;

	private builtInHeader: Component | undefined = undefined;

	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private getLocalSessionHost(): InteractiveModeLocalSessionHost {
		if (!this.localSessionHost) {
			throw new Error("Local session host is not available in connection-backed interactive mode");
		}
		return this.localSessionHost;
	}
	private get settingsManager() {
		return this.uiServices.settingsManager;
	}
	private get modelRegistry() {
		return this.uiServices.modelRegistry;
	}

	/**
	 * `uiServices` as a partial-mode harness leaves it. The field is private and assigned by
	 * the constructor, so a mode built through the prototype (how the resync and throttle
	 * harnesses are built) has none; reading `this.uiServices` directly there throws out of
	 * whatever path called in. The cosmetic paths ask here instead, and stop when the answer
	 * is undefined - a real mode always has it, since the constructor refuses to build one
	 * without.
	 */
	private get uiServicesOrUndefined(): InteractiveModeUiServices | undefined {
		return (this as unknown as { uiServices?: InteractiveModeUiServices }).uiServices;
	}

	constructor(private options: InteractiveModeOptions) {
		const uiServices = options.uiServices ?? options.localSessionHost?.createUiServices();
		if (!uiServices) {
			throw new Error("InteractiveMode requires uiServices when no localSessionHost is supplied");
		}
		this.uiServices = uiServices;
		this.agentConnection = options.agentConnection;
		this.promptStashStore = options.promptStashStore;
		this.promptStashSessionId = options.promptStashSessionId;
		this.promptStashState =
			this.promptStashStore && this.promptStashSessionId
				? this.promptStashStore.forSession(this.promptStashSessionId)
				: {};
		this.hydratePromptStash();
		this.localSessionHost = options.localSessionHost;
		this.bindLocalSessionExtensions = options.bindLocalSessionExtensions ?? options.localSessionHost !== undefined;
		if (this.bindLocalSessionExtensions && !options.localSessionHost) {
			throw new Error("Local extension binding requires localSessionHost");
		}
		this.agentConnection.onBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
			this.resetSideQuestion();
		});
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.ui.onCopy = (text) => {
			void this.copyFullscreenSelection(text);
		};
		this.headerContainer = new Container();
		this.topBar = new TopBar({
			getChatName: () => this.getCurrentSessionName(),
		});
		this.chatContainer = new Container();
		this.shortcutGuideContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.queuedMessagesContainer = new Container();
		this.sideQuestionContainer = new Container();
		this.featureHintContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.recapContainer = new Container();
		this.dutyLogContainer = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			isArgumentCommand: builtinSlashCommandTakesArgument,
			placeholder: this.startHint,
			placeholderColor: (text) => theme.fg("dim", text),
			hintColor: (text) => theme.fg("dim", text),
		});
		this.editor = this.defaultEditor;
		this.mainContainer = new Container();
		this.mainViewContainer = new Container();
		this.promptDock = new Container();
		this.footerSlot = new Container();
		this.mainViewContainer.addChild(this.chatContainer);
		this.mainViewContainer.addChild(this.shortcutGuideContainer);
		this.mainViewContainer.addChild(this.pendingMessagesContainer);
		this.mainViewContainer.addChild(this.statusContainer);
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		// U6 status area: ① tray info line (pure navigation), then the footer
		// watermark (②), then the subagents line (③).
		// The key hints ride the prompt's top rule; the tray line keeps status only.
		this.defaultEditor.getBorderHints = () => this.getTrayHints();
		this.trayInfoLine = new TrayInfoLine(
			() => this.getTrayStatusLabel(),
			() => [],
			() => this.getTrayOverrideLabel(),
		);
		this.subagentSummaryLine = new SubagentSummaryLine();
		this.subagentSummaryLine.setOpenable(this.options.returnToAgentsView === true);
		this.subagentSummaryLine.onOpen = (row) => void this.openScopedAgentsView(row?.activeSessionId, row);
		this.subagentSummaryLine.onStopAll = () => void this.requestStopAllSubagents();
		this.subagentSummaryLine.onCancel = () => this.focusEditor();
		this.subagentSummaryLine.onChatAction = (data) => this.handleSubagentSummaryChatAction(data);
		this.footerDataProvider = new FooterDataProvider(this.uiServices.getInitialCwd());
		this.footer = new FooterComponent(this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.settingsManager.getCompactionEnabled());
		// U6 评审②: the watermark pulls its mode and snapshot from the memoized
		// source below - same frame, same value as the tray fallback.
		this.footer.setTelemetrySource(() => this.getFooterTelemetrySource());
		// The status line carries the run's liveness: `● 运行中 12s` (an
		// extension's own working message wins over the plain label).
		this.footer.setActivitySource(() => {
			// v3: a transient notice (`✓ copied`) lights up for a moment as a green
			// chip; the running turn is an accent chip with the spinner.
			const chips: string[] = [];
			const toast = this.footerToast;
			if (toast && toast.until > Date.now()) {
				chips.push(theme.bg("toastBg", theme.fg("toastText", ` ${toast.text} `)));
			}
			const started = this.workingStartedAt;
			if (this.loadingAnimation && started !== undefined && this.settingsManager.getProcessMode() === "quiet") {
				const label = this.workingMessage ?? "working";
				const elapsed = this.formatWorkingElapsed(Date.now() - started);
				chips.push(
					theme.bg(
						"chipBg",
						`${theme.fg("chipText", ` ${spinnerFrame(getSpinnerTick())} `)}${theme.fg("chipText", `${label} ${elapsed} `)}`,
					),
				);
			}
			return chips.length > 0 ? chips.join(" ") : undefined;
		});
		this.footer.setLocationSource(() => ({
			cwd: this.getCurrentCwd(),
			branch: this.footerDataProvider.getGitBranch(),
		}));
		this.setGoalAnnouncementBaseline(emptyGoalState());

		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		// TUI v4 T7: the quiet conversation's tighter per-step output window.
		setQuietConversationBudget(this.settingsManager.getProcessMode() === "quiet");

		setRegisteredThemes(this.uiServices.getThemes());
		initTheme(this.settingsManager.getTheme(), true);
	}

	private get promptStash(): PromptStash | undefined {
		return this.promptStashState.stash;
	}

	private set promptStash(stash: PromptStash | undefined) {
		this.promptStashState.stash = stash;
	}

	private hydratePromptStash(): void {
		for (const stash of [this.promptStash, ...(this.promptStashState?.queuedStashes ?? [])]) {
			if (!stash) continue;
			for (const [markerId, image] of stash.images ?? []) {
				this.pastedImages.set(markerId, image);
				this.nextImageMarkerId = Math.max(this.nextImageMarkerId, markerId + 1);
			}
			for (const markerId of imageMarkerIds(stash.text)) {
				this.nextImageMarkerId = Math.max(this.nextImageMarkerId, markerId + 1);
			}
		}
	}

	private bindPromptStashSession(sessionId: string): void {
		if (!this.promptStashStore || this.promptStashSessionId === sessionId) {
			return;
		}
		this.releasePromptStashSession();
		this.promptStashSessionId = sessionId;
		this.promptStashState = this.promptStashStore.forSession(sessionId);
		this.hydratePromptStash();
	}

	private releasePromptStashSession(): void {
		if (this.inputSubmissionsPending > 0) {
			// Capture the pair: a rebind may repoint the fields before the deferred
			// release fires, and repeated rebinds/teardowns each defer their own pair.
			if (
				this.promptStashSessionId &&
				!this.pendingPromptStashReleases.some((pending) => pending.sessionId === this.promptStashSessionId)
			) {
				this.pendingPromptStashReleases.push({
					sessionId: this.promptStashSessionId,
					state: this.promptStashState,
				});
			}
			return;
		}
		const pending = this.pendingPromptStashReleases;
		this.pendingPromptStashReleases = [];
		if (!this.promptStashStore) return;
		for (const release of pending) {
			this.promptStashStore.release(release.sessionId, release.state);
		}
		if (this.promptStashSessionId) {
			this.promptStashStore.release(this.promptStashSessionId, this.promptStashState);
		}
	}

	private completeDeferredPromptStashRelease(): void {
		const pending = this.pendingPromptStashReleases;
		if (pending.length === 0) return;
		this.pendingPromptStashReleases = [];
		if (!this.promptStashStore) return;
		for (const release of pending) {
			this.promptStashStore.release(release.sessionId, release.state);
		}
	}

	private getAutocompleteSourceTag(sourceInfo?: AgentConnectionSourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix =
			sourceInfo.scope === "user" ? "user" : sourceInfo.scope === "project" ? "project" : "temporary";
		const source = sourceInfo.source.trim();

		if (source === "builtin") {
			return "builtin";
		}

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private getAutocompleteSourceLabel(sourceInfo?: AgentConnectionSourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		return sourceTag ? `#${sourceTag}` : undefined;
	}

	private getBuiltInCommandConflictDiagnostics(
		commands: readonly AgentConnectionSlashCommand[],
	): AgentConnectionResourceDiagnostic[] {
		return commands
			.filter((command) => command.source === "extension")
			.filter((command) => isBuiltinSlashCommandName(command.registeredName ?? command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.name === (command.registeredName ?? command.name)
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.registeredName}' conflicts with built-in interactive command. Available as '/${command.name}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private isRecognizedSlashCommand(name: string): boolean {
		return isBuiltinSlashCommandName(name) || this.connectionCommands.some((command) => command.name === name);
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.filter(
			(command) => command.name !== "fast" || this.currentModelSupportsFastMode(),
		).map((command) => ({
			name: command.name,
			aliases: command.aliases,
			description: command.description,
			argumentHint: command.argumentHint,
			takesArgument: command.takesArgument,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				getModelArgumentCompletions(prefix, this.getCachedModelCandidates());
		}

		const effortCommand = slashCommands.find((command) => command.name === "effort");
		if (effortCommand) {
			effortCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getThinkingLevelCompletions(prefix);
			const levels = this.getAvailableThinkingLevels();
			if (levels.length > 0) {
				effortCommand.argumentHint = `[${levels.join("/")}]`;
			}
		}

		const heartbeatCommand = slashCommands.find((command) => command.name === "heartbeat");
		if (heartbeatCommand) {
			heartbeatCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getHeartbeatArgumentCompletions(prefix);
		}

		const tracesCommand = slashCommands.find((command) => command.name === "traces");
		if (tracesCommand) {
			tracesCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getTracesArgumentCompletions(prefix);
		}

		const connectionCommands = this.connectionCommands;
		const templateCommands: SlashCommand[] = connectionCommands
			.filter((cmd) => cmd.source === "prompt")
			.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				sourceTag: this.getAutocompleteSourceLabel(cmd.sourceInfo),
				...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
			}));

		const extensionCommands: SlashCommand[] = connectionCommands
			.filter((cmd) => cmd.source === "extension")
			.filter((cmd) => !isBuiltinSlashCommandName(cmd.name))
			.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				sourceTag: this.getAutocompleteSourceLabel(cmd.sourceInfo),
				getArgumentCompletions: this.bindLocalSessionExtensions
					? this.getLocalSessionHost().getExtensionRunner().getCommand(cmd.name)?.getArgumentCompletions
					: undefined,
			}));

		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of connectionCommands.filter((cmd) => cmd.source === "skill")) {
				const commandName = skill.name;
				skillCommandList.push({
					name: commandName,
					description: skill.description,
					sourceTag: this.getAutocompleteSourceLabel(skill.sourceInfo),
				});
			}
		}

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.getCurrentCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// fd powers autocomplete, and rg is available for shell commands.
		const [fdPath, rgResult] = await Promise.all([ensureTool("fd"), ensureToolWithStatus("rg")]);
		this.fdPath = fdPath;
		if (rgResult.status === "unavailable") {
			this.showWarning(formatMissingRipgrepMessage(rgResult));
		}

		this.ui.addChild(this.headerContainer);

		// Brand splash: side-panel layout with structured runtime metadata on the right.
		// The model/cwd are read through live getters, so they fill in once the
		// connection state loads (rebindCurrentSession below). Onboarding, when
		// required, renders as a full-screen overlay on top of this header.
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			// Verbose: include the full keybinding cheatsheet under the brand mark.
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);
			const verboseInstructions = this.options.verbose
				? [
						hint("app.clear", "中断"),
						rawKeyHint(`${keyText("app.clear")} 按两次`, "退出"),
						hint("app.input.clear", "清空输入"),
						hint("app.exit", "退出（输入为空时）"),
						hint("app.suspend", "挂到后台"),
						keyHint("tui.editor.deleteToLineEnd", "删到行尾"),
						rawKeyHint("/effort", "调推理强度"),
						hint("app.model.select", "选模型"),
						hint("app.tools.expand", "展开过程（工具调用、输出和改动）"),
						hint("app.thinking.toggle", "展开 Thinking"),
						hint("app.messages.expand", "展开代理消息"),
						hint("app.subagents.focus", "查看子代理"),
						hint("app.editor.external", "外部编辑器"),
						hint("app.prompt.stash", "暂存输入"),
						rawKeyHint("/", "命令"),
						hint("app.message.followUp", "排一条稍后发送"),
						hint("app.message.navigateOlder", "查看排队消息"),
						hint("app.clipboard.pasteImage", "粘贴图片"),
						rawKeyHint("拖入文件", "附加"),
					].join("\n")
				: undefined;
			this.builtInHeader = new BrandSplashHeader(
				this.version,
				() => this.getCurrentModelId(),
				() => this.getCurrentCwd(),
				verboseInstructions,
				{
					topPadding: true,
					getExtraMetadata: () => this.getContinueMetadata(),
				},
			);
			this.headerContainer.addChild(this.builtInHeader);
			void this.loadRecentSession();
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Quiet startup: skip the splash and surrounding padding entirely.
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}

		this.mainContainer.addChild(this.mainViewContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.mainContainer.addChild(this.widgetContainerAbove);
		this.renderRecap();
		for (const container of this.getPromptContextContainers()) {
			this.mainContainer.addChild(container);
		}
		this.mainContainer.addChild(this.trayInfoLine);
		this.mainContainer.addChild(this.editorContainer);
		this.footerSlot.addChild(this.footer);
		this.mainContainer.addChild(this.footerSlot);
		this.mainContainer.addChild(this.subagentSummaryLine);
		this.mainContainer.addChild(this.widgetContainerBelow);
		for (const component of this.getPromptDockComponents()) {
			this.promptDock.addChild(component);
		}
		this.ui.addChild(this.mainContainer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		this.ui.addInputListener((data) => this.dutyLogReturnRoute(data));

		this.ui.start();
		this.fullscreenEnabled =
			(this.options.forceFullscreen === true || this.settingsManager.getFullscreen()) &&
			process.stdout.isTTY === true;
		if (this.fullscreenEnabled) {
			this.applyFullscreen(true);
		}
		this.isInitialized = true;

		await this.rebindCurrentSession();

		await this.renderInitialMessages();

		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		await this.updateAvailableProviderCount();
	}

	/** The shared scan memo, dropped whenever the connection or the bound session moved. */
	private contextTreeShareMemo(): SharedContextTree {
		const connection = this.agentConnection;
		const sessionId = this.connectionState?.sessionId;
		const share = this.contextTreeShare;
		if (share && share.connection === connection && share.sessionId === sessionId) return share;
		const fresh: SharedContextTree = { connection, sessionId, at: 0, ms: 0, tree: undefined, promise: undefined };
		this.contextTreeShare = fresh;
		return fresh;
	}

	/**
	 * The context tree behind both spend figures, scanned at most once per window.
	 *
	 * `notBefore` is the moment the request was aiming for: a scan still in flight will
	 * land after it, and one that already landed at or after it is the answer, so both
	 * are shared instead of paid for twice. A request aiming past the shared result -
	 * the cell's forced turn-end refresh, a header request whose window lapsed - scans
	 * for real. A scan that failed is not shared: the next request retries.
	 */
	private fetchSharedContextTree(notBefore: number): Promise<ContextTreeNode> {
		const share = this.contextTreeShareMemo();
		if (share.promise) return share.promise;
		if (share.at > 0 && share.tree && share.at >= notBefore) return Promise.resolve(share.tree);
		const connection = share.connection;
		const startedAt = Date.now();
		const promise = connection.getContextTree();
		share.promise = promise;
		void promise.then(
			(tree) => {
				// Published only into the memo that asked for it: a rebind mid-scan must not
				// have the previous session's tree served to the next one.
				if (this.contextTreeShare === share) {
					share.at = Date.now();
					share.ms = Math.max(0, share.at - startedAt);
					share.tree = tree;
				}
				if (share.promise === promise) share.promise = undefined;
			},
			() => {
				if (this.contextTreeShare === share && share.promise === promise) share.promise = undefined;
			},
		);
		return promise;
	}
	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.getCurrentCwd());
		const sessionName = this.getCurrentSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	async run(): Promise<InteractiveModeRunResult> {
		await this.init();
		this.restorePromptStashOnOpen();

		// Global, environment-scoped notices (app update, extension updates, tmux setup)
		// belong on the agents view, not in a conversation. When the agents view already
		// showed them, skip the checks here entirely. (This is narrower than
		// `returnToAgentsView`, which is also set for direct daemon attaches that never
		// rendered the agents view and still want the in-session fallback.)
		const ownsGlobalStartupNotices = !this.options.agentsViewOwnsStartupNotices;
		const newVersionPromise = ownsGlobalStartupNotices ? checkForNewPiVersion(this.version) : undefined;
		const packageUpdatesPromise = ownsGlobalStartupNotices
			? checkForPackageUpdates({
					cwd: this.getCurrentCwd(),
					agentDir: getAgentDir(),
					settingsManager: this.settingsManager,
				})
			: undefined;
		const tmuxKeyboardWarningPromise = ownsGlobalStartupNotices ? checkTmuxKeyboardSetup() : undefined;

		const {
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages,
			initialPrompts,
		} = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`已把凭据迁移到 auth.json：${migratedProviders.join(", ")}`);
		}

		if (this.options.startupNotice) {
			this.showWarning(this.options.startupNotice);
		}

		const modelsJsonError = this.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json 有错：${modelsJsonError}`);
		}

		const startupPrompts: InteractiveInitialPrompt[] = [
			...(initialMessage ? [{ text: initialMessage, images: initialImages }] : []),
			...(initialMessages ?? []).map((text) => ({ text })),
			...(initialPrompts ?? []),
		];
		// One drive loop owns startup-prompt delivery: it retries on a 250ms cadence
		// while a model is missing or admission fails transiently, shows every
		// admission error, and skips a prompt after three failed attempts.
		// `startupPromptsSettled` is the user-submission barrier (startup prompts
		// stay ahead of user prompts). Its outcome distinguishes completed admission
		// from lifecycle cancellation so a resumed submit does not mutate torn-down
		// editor state or consume the client-owned durable stash.
		let startupPromptsDone = false;
		const startupAdmissionAbort = new AbortController();
		let settleStartupPrompts = (_outcome: StartupPromptBarrierOutcome) => {};
		const startupPromptsSettled = new Promise<StartupPromptBarrierOutcome>((resolve) => {
			settleStartupPrompts = (outcome) => {
				startupPromptsDone = true;
				resolve(outcome);
			};
		});
		/** Resolves false when the run lifecycle ended before the 250ms retry delay elapsed. */
		const startupRetryDelay = () =>
			new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(true), 250);
				timer.unref?.();
				void startupPromptsSettled.then(() => {
					clearTimeout(timer);
					resolve(false);
				});
			});
		const deliverStartupPrompts = async () => {
			let failures = 0;
			for (let next = 0; next < startupPrompts.length; ) {
				// The run lifecycle can settle the barrier while a prompt is being
				// admitted; stop instead of prompting a session we already left.
				if (startupPromptsDone) return;
				if (!this.getCurrentModel()) {
					if (!(await startupRetryDelay())) return;
					continue;
				}
				const prompt = startupPrompts[next]!;
				try {
					await this.agentConnection.prompt(prompt.text, {
						images: prompt.images,
						streamingBehavior: next === 0 ? "steer" : "followUp",
						queueIfBusy: true,
						signal: startupAdmissionAbort.signal,
					});
					failures = 0;
					next++;
				} catch (error) {
					if (startupPromptsDone || startupAdmissionAbort.signal.aborted) return;
					// An uncertain daemon admission may already be session-owned. Retrying
					// would duplicate it; only an acknowledged pre-ownership cancellation is safe.
					if (error instanceof AgentConnectionPromptAdmissionError && error.status === "owned") {
						failures = 0;
						next++;
						continue;
					}
					if (error instanceof AgentConnectionPromptAdmissionError && !error.cancelled) {
						// This attempt may already be session-owned, so never retry it. Preserve
						// it and every not-yet-attempted startup prompt in original order.
						this.retainStartupPromptDrafts(startupPrompts.slice(next));
						this.showError(error.message);
						settleStartupPrompts("retained");
						return;
					}
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					if (++failures < 3) {
						this.showError(errorMessage);
						if (!(await startupRetryDelay())) return;
						continue;
					}
					this.showError(`启动时的提示连续 3 次失败，已跳过：${errorMessage}`);
					failures = 0;
					next++;
				}
			}
		};
		this.admitPendingStartupPrompts = startupPrompts.length > 0 ? () => startupPromptsSettled : undefined;

		let deferredStartupNotificationsShown = false;
		const showDeferredStartupNotifications = () => {
			if (deferredStartupNotificationsShown) {
				return;
			}
			deferredStartupNotificationsShown = true;

			// The agents view owns these for daemon sessions. When there is no agents view,
			// show them once at the top of a fresh session, but never append them under a
			// restored conversation where they read as disconnected clutter.
			if (!ownsGlobalStartupNotices || !this.isNewChat()) {
				return;
			}

			void newVersionPromise
				?.then((newVersion) => {
					if (newVersion) {
						this.showNewVersionNotification(newVersion);
					}
				})
				.catch(() => {});

			void packageUpdatesPromise
				?.then((updates) => {
					if (updates.length > 0) {
						this.showPackageUpdateNotification(updates);
					}
				})
				.catch(() => {});

			void tmuxKeyboardWarningPromise
				?.then((warning) => {
					if (warning) {
						this.showWarning(warning);
					}
				})
				.catch(() => {});
		};

		let modelFallbackWarningShown = false;
		const showModelFallbackWarning = () => {
			if (modelFallbackWarningShown) {
				return;
			}
			const action = this.getModelFallbackWarningAction(modelFallbackMessage);
			modelFallbackWarningShown = true;
			if (action === "show" && modelFallbackMessage) {
				this.showWarning(modelFallbackMessage);
			}
		};

		await this.runStartupOnboarding();
		showDeferredStartupNotifications();
		showModelFallbackWarning();
		void this.maybeWarnAboutAnthropicSubscriptionAuth();
		void deliverStartupPrompts().then(
			() => settleStartupPrompts("admitted"),
			() => settleStartupPrompts("admitted"),
		);

		// Enter/Alt+Enter submit directly through AgentConnection. Wait for the
		// lifecycle signal exactly once; a returned editor value has already been
		// admitted and must never be submitted again here.
		try {
			await this.getUserInput();
		} finally {
			startupAdmissionAbort.abort();
			settleStartupPrompts("lifecycle-cancelled");
			this.admitPendingStartupPrompts = undefined;
		}

		const state = this.connectionState;
		return {
			type: this.agentsViewRequest ?? "agents_view",
			...(this.agentsViewRequest === "scoped_agents_view" && this.openChildActiveSessionId
				? { openChildActiveSessionId: this.openChildActiveSessionId }
				: {}),
			...this.agentsViewHandoff,
			source: {
				activeSessionId: state?.activeSessionId,
				sessionFile: state?.sessionFile,
				sessionId: state?.sessionId ?? this.promptStashSessionId ?? "",
				sessionName: state?.sessionName,
				cwd: state?.cwd ?? this.getCurrentCwd(),
			},
		};
	}

	private getModelFallbackWarningAction(modelFallbackMessage: string | undefined): ModelFallbackWarningAction {
		if (!modelFallbackMessage) {
			return "suppress";
		}
		// The no-models warning is a snapshot from whichever process created the
		// session; trust the live connection over it (e.g. credentials only
		// visible to the daemon, or added after the snapshot was taken).
		if (isNoModelsAvailableMessage(modelFallbackMessage) && this.getCurrentModel()) {
			return "suppress";
		}
		return "show";
	}

	private getOnboardingState(): OnboardingStartupState {
		return {
			settingsManager: this.settingsManager,
			modelRegistry: this.modelRegistry,
			model: this.getCurrentModel(),
		};
	}

	private shouldRunOnboarding(): boolean {
		return shouldRunOnboarding(this.getOnboardingState());
	}

	private shouldRunPrimeCliOnboardingSplash(): boolean {
		return shouldRunPrimeCliOnboardingSplash(this.getOnboardingState());
	}

	private markOnboardingShown(): void {
		if (!this.settingsManager.getOnboardingShown()) {
			this.settingsManager.setOnboardingShown(true);
		}
	}

	private async runStartupOnboarding(): Promise<boolean> {
		if (!this.shouldRunOnboarding()) {
			return false;
		}

		const startedAt = Date.now();
		const showPrimeCliSplash = this.shouldRunPrimeCliOnboardingSplash();
		let outcome: TelemetryOnboardingOutcome = "aborted";
		try {
			this.markOnboardingShown();
			await this.settingsManager.flush();
			await this.runOnboardingFlow(showPrimeCliSplash);
			outcome = isOnboardingModelReady(this.getOnboardingState()) ? "success" : "aborted";
			return true;
		} catch (error) {
			outcome = "error";
			throw error;
		} finally {
			const model = this.getCurrentModel();
			const authStatus = model ? this.modelRegistry.getProviderAuthStatus(model.provider) : undefined;
			const storedCredential = model ? this.modelRegistry.authStorage.get(model.provider) : undefined;
			void captureOnboardingCompleted({
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
				durationMs: Date.now() - startedAt,
				outcome,
				provider: model?.provider,
				authSource: authStatus?.source,
				storedCredentialType: storedCredential?.type,
			}).catch(() => {});
		}
	}

	private async showOnboardingModelSelection(splash: OnboardingSplashHandle): Promise<void> {
		try {
			await this.showConfigurationMenu("models");
		} finally {
			splash.dismiss();
		}
	}

	private async runOnboardingFlow(showPrimeCliSplash = this.shouldRunPrimeCliOnboardingSplash()): Promise<void> {
		this.modelRegistry.refresh();
		if (showPrimeCliSplash) {
			const splash = await this.showOnboardingSplash("choose a model");
			if (!splash) {
				return;
			}

			await this.showOnboardingModelSelection(splash);
			return;
		}

		const availableModels = await this.getModelCandidates();
		if (availableModels.length > 0) {
			await this.showConfigurationMenu("models");
			return;
		}

		const splash = await this.showOnboardingSplash();
		if (!splash) {
			return;
		}

		splash.showProgress("Signing in to Prime Intellect...");
		const authResult = await this.createAuthFlows().runPrimeInferenceLogin();
		if (authResult.status !== "success") {
			splash.dismiss();
			return;
		}

		splash.showProgress("Preparing models...");
		await this.prepareForModelSelectionAfterLogin(authResult);
		await this.showOnboardingModelSelection(splash);
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.getCurrentCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	private getShortPath(fullPath: string, sourceInfo?: AgentConnectionSourceInfo): string {
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: AgentConnectionSourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: AgentConnectionSourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: AgentConnectionSourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(
		extensions: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>,
	): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: AgentConnectionSourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: AgentConnectionSourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: AgentConnectionSourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: AgentConnectionSourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: AgentConnectionSourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(
		p: string,
		sourceInfos: Map<string, AgentConnectionSourceInfo>,
	): AgentConnectionSourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: AgentConnectionSourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(
		diagnostics: readonly AgentConnectionResourceDiagnostic[],
		sourceInfos: Map<string, AgentConnectionSourceInfo>,
	): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, AgentConnectionResourceDiagnostic[]>();
		const otherDiagnostics: AgentConnectionResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		const formatMessageLines = (diagnostic: AgentConnectionResourceDiagnostic, indent: number): string[] => {
			const color = diagnostic.type === "error" ? "error" : "warning";
			const prefix = " ".repeat(indent);
			return diagnostic.message.split("\n").map((line) => theme.fg(color, `${prefix}${line}`));
		};

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(...formatMessageLines(d, 4));
			} else {
				lines.push(...formatMessageLines(d, 2));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force === true || this.options.verbose === true;
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const diagnosticsHeader = (name: string, diagnostics: readonly AgentConnectionResourceDiagnostic[]): string => {
			if (diagnostics.some((diagnostic) => diagnostic.type === "collision")) {
				return `${name} conflicts`;
			}

			const errorCount = diagnostics.filter((diagnostic) => diagnostic.type === "error").length;
			const warningCount = diagnostics.filter((diagnostic) => diagnostic.type === "warning").length;
			if (errorCount > 0 && warningCount > 0) {
				return `${name} diagnostics`;
			}
			if (errorCount > 0) {
				return `${name} error${errorCount === 1 ? "" : "s"}`;
			}
			if (warningCount > 0) {
				return `${name} warning${warningCount === 1 ? "" : "s"}`;
			}

			return `${name} diagnostics`;
		};
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		const addLoadedSection = (
			name: string,
			collapsedBody: string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.chatContainer.addChild(section);
			this.chatContainer.addChild(new Spacer(1));
		};

		const resourceSnapshot = this.connectionResourceSnapshot;
		const skills = resourceSnapshot?.skills ?? [];
		const prompts = resourceSnapshot?.prompts ?? [];
		const loadedThemes = resourceSnapshot?.themes ?? [];
		const contextFiles = resourceSnapshot?.contextFiles ?? [];
		const extensions = options?.extensions ?? resourceSnapshot?.extensions ?? [];
		const sourceInfos = new Map<string, AgentConnectionSourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of loadedThemes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			if (contextFiles.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				const contextCompactList = formatCompactList(
					contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
					{ sort: false },
				);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			if (prompts.length > 0) {
				const groups = this.buildScopeGroups(
					prompts.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(prompts.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				const promptCompactList = formatCompactList(prompts.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
				});
				const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}

			// Show loaded themes (excluding built-in)
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const themeCompactList = formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				);
				addLoadedSection("Themes", themeCompactList, themeList);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = resourceSnapshot?.diagnostics.skills ?? [];
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(
						`${sectionHeader(diagnosticsHeader("Skill", skillDiagnostics), "warning")}\n${warningLines}`,
						0,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = resourceSnapshot?.diagnostics.prompts ?? [];
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(
						`${sectionHeader(diagnosticsHeader("Prompt", promptDiagnostics), "warning")}\n${warningLines}`,
						0,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: AgentConnectionResourceDiagnostic[] = [
				...(resourceSnapshot?.diagnostics.extensions ?? []),
			];

			if (this.bindLocalSessionExtensions) {
				const commandDiagnostics = this.getLocalSessionHost().getExtensionRunner().getCommandDiagnostics();
				extensionDiagnostics.push(...commandDiagnostics);
			}
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.connectionCommands));

			if (this.bindLocalSessionExtensions) {
				const localSessionHost = this.getLocalSessionHost();
				const shortcutDiagnostics = localSessionHost.getExtensionRunner().getShortcutDiagnostics();
				extensionDiagnostics.push(...shortcutDiagnostics);
				extensionDiagnostics.push(...localSessionHost.getExtensionRunner().getToolDiagnostics());
				extensionDiagnostics.push(...localSessionHost.getToolDiagnostics());
			}

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(
						`${sectionHeader(diagnosticsHeader("Extension", extensionDiagnostics), "warning")}\n${warningLines}`,
						0,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = resourceSnapshot?.diagnostics.themes ?? [];
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(
						`${sectionHeader(diagnosticsHeader("Theme", themeDiagnostics), "warning")}\n${warningLines}`,
						0,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const localSessionHost = this.getLocalSessionHost();
		const uiContext = this.createExtensionUIContext();
		await localSessionHost.bindExtensions({
			uiContext,
			commandContextActions: {
				waitForIdle: () => this.agentConnection.waitForIdle(),
				newSession: async (options) => {
					this.stopWorkingLoader();
					try {
						const result =
							options?.setup || options?.withSession
								? await localSessionHost.newSession(options)
								: await this.agentConnection.newSession(
										options?.parentSession ? { parentSession: options.parentSession } : undefined,
									);
						if (!result.cancelled) {
							await this.renderCurrentSessionState();
							this.ui.requestRender();
						}
						return result;
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = options?.withSession
							? await localSessionHost.fork(entryId, options)
							: await this.agentConnection.fork(entryId, { position: options?.position });
						if (!result.cancelled) {
							await this.renderCurrentSessionState();
							this.editor.setText("selectedText" in result ? (result.selectedText ?? "") : "");
							this.showStatus("已分叉到新会话");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.agentConnection.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					await this.renderTreeNavigation(result);
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.isAgentStreaming()) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.uiServices.getThemes());
		await this.refreshConnectionCatalog();
		this.setupAutocompleteProvider();

		const extensionRunner = localSessionHost.getExtensionRunner();
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
	}

	private applyRuntimeSettings(): void {
		this.footer.setAutoCompactEnabled(
			this.connectionState?.autoCompactionEnabled ?? this.settingsManager.getCompactionEnabled(),
		);
		// P2-D (Qwen review): a settings reload can change footer.telemetry and
		// the compaction settings the watermark reads - drop the memo so the
		// next frame recomputes (the c2332 message listed this trigger; the
		// wiring was missing).
		this.invalidateFooterTelemetry();

		this.footerDataProvider.setCwd(this.getCurrentCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private getConnectionQueue(): AgentConnectionQueueState {
		return {
			steering: [...(this.connectionState?.sessionActions.steering ?? [])],
			followUp: [...(this.connectionState?.sessionActions.followUps ?? [])],
		};
	}

	private async refreshConnectionCatalog(): Promise<void> {
		this.invalidateConnectionModelRefresh();
		const [state, commands, modelCatalog, resources] = await Promise.all([
			this.agentConnection.getState(),
			this.agentConnection.getCommands().catch(() => []),
			this.agentConnection.getModelCatalog(),
			this.agentConnection.getResourceSnapshot(),
		]);
		this.applyConnectionStateSnapshot(state);
		this.connectionCommands = commands;
		this.applyConnectionModelCatalog(modelCatalog);
		this.connectionModelsFetchedAt = Date.now();
		this.connectionResourceSnapshot = resources;
	}

	private refreshHeartbeatCatalog(): Promise<void> {
		if (this.heartbeatRefreshPromise) {
			this.heartbeatRefreshRequested = true;
			return this.heartbeatRefreshPromise;
		}
		const connection = this.agentConnection;
		const refresh = (async () => {
			do {
				this.heartbeatRefreshRequested = false;
				const heartbeats = await connection.listHeartbeats();
				if (this.agentConnection !== connection) return;
				this.applyHeartbeatCatalog(heartbeats);
			} while (this.heartbeatRefreshRequested);
		})().finally(() => {
			if (this.heartbeatRefreshPromise === refresh) {
				this.heartbeatRefreshPromise = undefined;
			}
		});
		this.heartbeatRefreshPromise = refresh;
		return refresh;
	}

	private applyHeartbeatCatalog(heartbeats: AgentConnectionHeartbeat[]): void {
		this.heartbeatCatalog = heartbeats;
		this.scheduleHeartbeatManagerRefresh();
		this.updateSubagentSummaryLine();
		this.ui.requestRender();
	}

	private getScopedHeartbeats(): AgentConnectionHeartbeat[] {
		return scopeHeartbeatsToSession(this.heartbeatCatalog, this.connectionState, this.subagentSnapshots.values());
	}

	private applyConnectionStateSnapshot(state: AgentConnectionState): void {
		this.bindPromptStashSession(state.sessionId);
		this.connectionState = state;
		this.scheduleHeartbeatManagerRefresh();
		// Don't touch contextUsageTokenBaseline: a mid-stream snapshot reflects only completed
		// turns (the in-flight message isn't persisted yet), so the in-flight delta must keep
		// accumulating. The baseline is managed at turn end (refreshConnectionContextUsage) and
		// reset on a new user message.
		this.footer.setAutoCompactEnabled(state.autoCompactionEnabled);
		this.sessionRecap = state.recap;
		this.renderRecap();
		this.updateWorkingPulse();
	}

	private patchConnectionState(patch: Partial<AgentConnectionState>): void {
		if (!this.connectionState) {
			return;
		}
		this.connectionState = { ...this.connectionState, ...patch };
		this.updateWorkingPulse();
	}

	// Bake this attempt's output into the snapshot so the tray doesn't dip in the gap between
	// isStreaming clearing and the async refresh landing.
	private applyOptimisticContextUsage(): void {
		this.invalidateFooterTelemetry();
		const snapshot = this.connectionState?.contextUsage;
		if (!snapshot || snapshot.tokens === null || snapshot.contextWindow <= 0) return;
		const completed = Math.max(0, this.activityTracker.getStatus().tokens - this.contextUsageTokenBaseline);
		if (completed <= 0) return;
		const tokens = snapshot.tokens + completed;
		this.patchConnectionState({
			contextUsage: {
				tokens,
				contextWindow: snapshot.contextWindow,
				percent: (tokens / snapshot.contextWindow) * 100,
			},
		});
	}

	/** Refresh the tray's context usage from the session after a turn or compaction completes. */
	/**
	 * U6 评审②: drop the memoized watermark pair. The next read - footer or tray
	 * - recomputes from the connection state once and the two stay identical
	 * until the next invalidation.
	 */
	private invalidateFooterTelemetry(): void {
		this.footerTelemetryDirty = true;
		this.footerTelemetryCached = undefined;
		// Partial-mode harnesses skip the constructor; the watermark is cosmetic
		// and must never crash a real flow.
		(this as unknown as { footer?: { invalidate?: () => void } }).footer?.invalidate?.();
	}

	/**
	 * The memoized watermark pair (评审②: one frame, one value). Recomputes only
	 * after invalidateFooterTelemetry; every reader - the footer line's pull
	 * source and the tray fallback - gets the same object, so the two context
	 * readouts can never disagree again.
	 */
	private getFooterTelemetrySource(): FooterTelemetrySource {
		// A snapshot taken before the session's model loaded has nothing to show;
		// retry until it does so the status line appears before the first turn.
		if (
			this.footerTelemetryDirty ||
			this.footerTelemetryCached === undefined ||
			this.footerTelemetryCached.snapshot?.modelName === undefined
		) {
			this.footerTelemetryCached = this.computeFooterTelemetry();
			this.footerTelemetryDirty = false;
		}
		return this.footerTelemetryCached;
	}

	private computeFooterTelemetry(): FooterTelemetrySource {
		const settingsManager = this.uiServicesOrUndefined?.settingsManager;
		const mode = settingsManager?.getFooterTelemetry?.() ?? "on";
		const model = this.getCurrentModel();
		const usage = this.getConnectionContextUsage();
		const thinkingLevel =
			model?.reasoning && this.connectionState?.thinkingLevel && this.connectionState.thinkingLevel !== "off"
				? this.connectionState.thinkingLevel
				: undefined;
		// 评审③: the notch and 压缩在即 read the real threshold - the configured
		// ratio over the model's effective input limit, minus the reserve
		// ceiling. A disabled threshold (settings off, or the reserve consuming
		// the whole base) renders neither; the 80% default is just the default.
		const compactionSettings = settingsManager?.getCompactionSettings?.();
		const windowTokens = usage?.contextWindow ?? 0;
		const thresholdTokens =
			compactionSettings && (compactionSettings.enabled ?? true) && windowTokens > 0
				? compactionThresholdTokens(
						windowTokens,
						compactionSettings,
						model ? compactionLimitsForModel(model) : undefined,
					)
				: 0;
		const snapshot: FooterTelemetrySnapshot = {
			modelName: model?.id,
			thinkingLevel,
			contextTokens: usage?.tokens ?? undefined,
			contextWindow: usage?.contextWindow,
			compactionThresholdTokens: thresholdTokens,
			usageWindowTokens: model?.usageWindowTokens,
		};
		return { mode, snapshot };
	}

	private async refreshConnectionContextUsage(): Promise<void> {
		this.invalidateFooterTelemetry();
		const generation = ++this.contextUsageRefresh.generation;
		const connection = this.agentConnection;
		const sessionId = this.connectionState?.sessionId;
		const stats = await connection?.getSessionStats?.().catch(() => undefined);
		if (!stats) return;
		// Drop results superseded by a newer successful refresh as well as results for a replaced session.
		if (
			generation < this.contextUsageRefresh.lastSuccessGeneration ||
			this.agentConnection !== connection ||
			this.connectionState?.sessionId !== sessionId
		) {
			return;
		}
		this.contextUsageRefresh.lastSuccessGeneration = generation;
		// Anything counted so far is now reflected in the snapshot; only later output is in-flight.
		this.contextUsageTokenBaseline = this.activityTracker.getStatus().tokens;
		this.patchConnectionState({ contextUsage: stats.contextUsage });
		// P2-D (Qwen review): the leading invalidation happened before the await
		// - a frame that rendered while the RPC was in flight re-memoized the
		// OLD usage, and this patch would land behind it. Drop the memo again
		// now that the fresh numbers are in the connection state.
		this.invalidateFooterTelemetry();

		// U2: the session's trailing tool-error streak is authoritative; an older
		// daemon without the field keeps the locally counted value.
		if (typeof stats.consecutiveToolErrors === "number") {
			this.consecutiveToolErrors = stats.consecutiveToolErrors;
			this.footer?.setToolErrorCount?.(this.consecutiveToolErrors);
		}
	}

	private refreshQueueSelectionFromState(): void {
		const selected = this.queueSelection.selected;
		if (selected && !this.pendingQueueEdit && !this.pendingQueueMove) {
			this.refreshQueueSelectionAt(this.getConnectionQueue(), selected, selected.index);
		}
	}

	private updateConnectionStateFromEvent(event: AgentConnectionSessionEvent): void {
		if (!this.connectionState) {
			return;
		}
		switch (event.type) {
			case "agent_start": {
				const wasNewChat = this.isNewChat();
				this.patchConnectionState({ isStreaming: true, activeToolNames: [] });
				if (wasNewChat) {
					this.builtInHeader?.invalidate();
				}
				break;
			}
			case "message_end": {
				const wasNewChat = this.isNewChat();
				this.patchConnectionState({ messageCount: this.connectionState.messageCount + 1 });
				if (wasNewChat) {
					this.builtInHeader?.invalidate();
				}
				break;
			}
			case "agent_end":
				this.patchConnectionState({ isStreaming: false, activeToolNames: [] });
				break;
			case "session_action_update":
				this.patchConnectionState({ sessionActions: event.actions });
				this.refreshQueueSelectionFromState();
				break;
			case "compaction_start":
				this.patchConnectionState({ isCompacting: true });
				break;
			case "compaction_end":
				this.patchConnectionState({ isCompacting: false });
				break;
			case "session_info_changed":
				this.patchConnectionState({ sessionName: event.name });
				break;
			case "thinking_level_changed":
				this.patchConnectionState({ thinkingLevel: event.level });
				break;
			case "service_tier_changed":
				this.patchConnectionState({ serviceTier: event.serviceTier });
				break;
			case "auto_retry_start":
				this.patchConnectionState({ retryAttempt: event.attempt });
				break;
			case "auto_retry_end":
				this.patchConnectionState({ retryAttempt: 0 });
				break;
			case "goal_update":
				this.patchConnectionState({ goal: event.goal });
				break;
			case "bash_start":
				this.patchConnectionState({ isBashRunning: true });
				break;
			case "bash_end":
				this.patchConnectionState({ isBashRunning: false });
				break;
		}
	}

	private getCurrentCwd(): string {
		return this.connectionState?.cwd ?? this.uiServices.getInitialCwd();
	}

	private getCurrentSessionName(): string | undefined {
		return this.connectionState?.sessionName ?? this.uiServices.getInitialSessionName();
	}

	private applyAuthStaleEvent(event: Extract<AgentConnectionSessionEvent, { type: "auth_stale" }>): void {
		let marked = false;
		for (const token of event.sourceTokens ?? []) {
			marked = this.modelRegistry.markProviderAuthSourceStale(token) || marked;
		}
		if (!marked) {
			this.modelRegistry.markProviderAuthStale(event.provider);
		}
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}

	private getCurrentModel(): AgentConnectionModel | undefined {
		return this.connectionState?.model;
	}

	private getCurrentModelId(): string | undefined {
		return this.getCurrentModel()?.id;
	}

	private isAgentStreaming(): boolean {
		return this.connectionState?.isStreaming ?? false;
	}

	private isAgentCompacting(): boolean {
		return this.connectionState?.isCompacting ?? false;
	}

	private isBashRunning(): boolean {
		return this.connectionState?.isBashRunning ?? false;
	}

	private hasInterruptibleWork(): boolean {
		return (
			this.isAgentStreaming() ||
			this.isAgentCompacting() ||
			this.isBashRunning() ||
			this.getRetryAttempt() > 0 ||
			this.connectionState?.sessionActions.active !== undefined ||
			this.traceUploadAllAbortController !== undefined ||
			this.sideQuestionEvent?.status === "running"
		);
	}

	private getRetryAttempt(): number {
		return this.connectionState?.retryAttempt ?? 0;
	}

	private getQueuedActionCount(): number {
		return this.connectionState?.sessionActions.queuedCount ?? 0;
	}

	/**
	 * Enter on an empty editor while messages wait in a queue that an interrupt
	 * suspended: send the parked queue instead of doing nothing.
	 */
	private async resumeParkedQueueIfIdle(): Promise<boolean> {
		if (this.isAgentStreaming() || this.getQueuedActionCount() === 0) return false;
		try {
			return await this.agentConnection.resumeQueuedWork();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	private getGoalState(): GoalState {
		return this.connectionState?.goal ?? emptyGoalState();
	}

	private getConnectionContextUsage(): AgentConnectionState["contextUsage"] {
		const snapshot = this.connectionState?.contextUsage;
		if (!snapshot || snapshot.tokens === null || snapshot.contextWindow <= 0) {
			return snapshot;
		}
		// Add only the output produced since the snapshot was last refreshed. The activity
		// tracker accumulates across auto-retries within a turn, so subtract the baseline
		// captured at the last refresh to avoid re-adding a failed attempt's tokens.
		const inFlight = this.isAgentStreaming()
			? Math.max(0, this.activityTracker.getStatus().tokens - this.contextUsageTokenBaseline)
			: 0;
		if (inFlight <= 0) {
			return snapshot;
		}
		const tokens = snapshot.tokens + inFlight;
		return {
			tokens,
			contextWindow: snapshot.contextWindow,
			percent: (tokens / snapshot.contextWindow) * 100,
		} satisfies ContextUsage;
	}

	private getScopedModelState(): AgentConnectionState["scopedModels"] {
		return this.connectionState?.scopedModels ?? [];
	}

	private async rebindCurrentSession(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		// Sessions are independent: a rebind (new/resume/switch) restarts tok/sec stats
		// and clears the readout left over from the previous session.
		this.speedStats = undefined;
		this.footer?.setSpeedText?.(undefined);
		(this as unknown as { invalidateFooterTelemetry?: () => void }).invalidateFooterTelemetry?.();
		void this.rosterBar?.dispose();
		this.rosterBar = undefined;
		if (this.localSessionHost) {
			this.uiServices = this.localSessionHost.createUiServices();
		}
		this.toolDefinitionCache.clear();
		this.applyRuntimeSettings();
		if (this.bindLocalSessionExtensions) {
			await this.bindCurrentSessionExtensions();
		} else {
			setRegisteredThemes(this.uiServices.getThemes());
			// Awaited on purpose: the first frame renders this snapshot (session, model, cwd,
			// queue, recap), and the two calls below read the command and resource catalogs it
			// fetches. All four are single RPCs to this session's own worker, never a fanout.
			await this.refreshConnectionCatalog();
			this.setupAutocompleteProvider();
			this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		}
		this.subscribeToAgent();
		// Awaited on purpose: the handle it stores is what the next rebind disposes, so a
		// late landing would leak the previous session's roster bar. The supervisor answers
		// it from its own in-memory roster, so there is no worker fanout to wait for.
		await this.subscribeToRosterBar();
		// A session_action_update in the unsubscribed gap above is lost; re-sync the queue post-subscription.
		// Awaited on purpose: the first frame renders this queue, and it is one RPC to this
		// session's own worker.
		this.patchConnectionState({ sessionActions: (await this.agentConnection.getState()).sessionActions });
		this.refreshQueueSelectionFromState();
		this.updatePendingMessagesDisplay();
		// Fire-and-forget (F4). The catalog is the one entry in this rebind that leaves the
		// session's own worker: the daemon fans it out to every resident worker and waits
		// for all of them, so one wedged worker used to hold the first frame of every
		// session switch for the whole fanout budget. Nothing on that frame depends on it -
		// applyHeartbeatCatalog requests its own render when the rows land, so the heartbeat
		// badges fill in a moment later instead of gating the switch.
		void this.refreshHeartbeatCatalog().catch(() => undefined);
		// Awaited on purpose: a single RPC to this session's own worker, never a fanout.
		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
		this.setGoalAnnouncementBaseline(this.getGoalState());
		this.syncGoalTray(this.getGoalState());
		this.syncWorkingLoader();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private resetCurrentSessionRenderState(options?: { clearPromptStash?: boolean }): void {
		this.endFeatureHintRun();
		this.resetBlockNavigation();
		this.chatContainer.clear();
		this.shortcutGuideContainer.clear();
		this.pendingMessagesContainer.clear();
		this.queuedMessagesContainer.clear();
		this.pendingQueueEdit = undefined;
		this.pendingQueueMove = false;
		// The selection and its stashed draft belong to the previous session;
		// every editor draft is cleared below, so discard rather than restore.
		this.queueSelection.reset();
		this.featureHintSuppressedByQueue = false;
		if (options?.clearPromptStash) {
			this.promptStash = undefined;
			if (this.promptStashState) this.promptStashState.queuedStashes = undefined;
		}
		// Clear every editor's prompt history, draft text, and queues, then prune
		// any pasted images no longer referenced by the remaining stashed draft.
		this.defaultEditor.clearHistory?.();
		this.defaultEditor.setText("");
		if (this.editor !== this.defaultEditor) {
			this.editor.clearHistory?.();
			this.editor.setText("");
		}
		this.ui.terminal.abortPendingInput();
		const keepImageIds = this.liveImageMarkerIds();
		for (const markerId of this.pastedImages.keys()) {
			if (!keepImageIds.has(markerId)) {
				this.pastedImages.delete(markerId);
			}
		}
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		// The discarded component's loader interval keeps firing otherwise; no
		// bash_end will reach it once the reference is dropped.
		this.activeBashComponent?.setComplete(undefined, true);
		this.activeBashComponent = undefined;
		// Likewise: the next session's view may never see this refine settle.
		this.discardRefineLoader();
		// Same for a retry countdown or a compaction loader from the session being
		// replaced: both keep an interval running that nothing in the next view owns.
		this.disposeTransientStatusOverlays();
		this.pendingBashComponents = [];
		this.activityTracker.reset();
		this.contextUsageTokenBaseline = 0;
		this.resetPendingToolState();
		this.agentRunFileChanges.clear();
		this.renderRecap();
		this.ipythonToolComponents.clear();
		this.lateIpythonSentAgentMessages.clear();
		this.chatTranscriptTrimmed = false;
		this.chatCapRebuildFloor = 0;
		this.resetSubagentSummary();
		this.setGoalAnnouncementBaseline(this.getGoalState());
		this.syncGoalTray(this.getGoalState());
	}

	private resetPendingToolState(): void {
		this.pendingToolGeneration++;
		this.pendingTools.clear();
		this.pendingToolCreations.clear();
		this.startedToolCalls.clear();
	}

	private async renderCurrentSessionState(): Promise<void> {
		// Replacement events own the session-scoped command catalog. The daemon
		// sends that event before its command response, but its handler may still
		// be refreshing commands when the response resolves.
		await this.sessionEventQueue;
		this.resetCurrentSessionRenderState();
		await this.renderInitialMessages();
		this.updatePendingMessagesDisplay();
		this.syncWorkingLoader();
	}

	private async refreshCommandCatalogForCurrentSession(): Promise<void> {
		try {
			this.connectionCommands = await this.agentConnection.getCommands();
		} catch {
			this.connectionCommands = [];
		}
		this.setupAutocompleteProvider();
	}

	private async renderResyncedSession(snapshot: AgentConnectionSnapshot): Promise<void> {
		const bashFinished = this.isBashRunning() && !snapshot.state.isBashRunning;
		this.applyConnectionStateSnapshot(snapshot.state);
		this.refreshQueueSelectionFromState();
		this.restoreTurnStartFromMessages(this.getSessionContextFromConnectionSnapshot(snapshot).messages);
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.rlmNodeId = snapshot.parent?.childId;
		this.replaceSubagentSummary(snapshot.children);
		await this.renderSessionContext(this.getSessionContextFromConnectionSnapshot(snapshot), {
			clearChat: true,
			updateFooter: true,
		});
		await this.restoreStreamingMessageFromSnapshot(snapshot.streamingMessage);
		this.updatePendingMessagesDisplay();
		if (bashFinished) {
			if (this.activeBashComponent) {
				this.activeBashComponent.setComplete(undefined, false);
				this.activeBashComponent = undefined;
				if (!snapshot.state.isStreaming) {
					this.flushPendingBashComponents();
				}
			}
			// A transient side bash is not persisted in the session snapshot, so a
			// reconnect cannot replay its missed bash_end event. Release the pane's
			// local running state when the authoritative snapshot says bash ended.
			if (this.sideQuestionBash) {
				this.sideQuestionComponent?.finishBash();
				this.sideQuestionBash = undefined;
				this.sideQuestionBashComponent = undefined;
			}
			this.sideQuestionBashDiscarded = undefined;
		}
		this.updateTerminalTitle();
		this.setGoalAnnouncementBaseline(this.getGoalState());
		this.syncGoalTray(this.getGoalState());
		this.syncWorkingLoader();
	}

	private getCachedToolDefinition(toolName: string): ToolExecutionDefinition | undefined {
		return this.toolDefinitionCache.get(toolName);
	}

	private async loadToolDefinition(toolName: string): Promise<ToolExecutionDefinition | undefined> {
		if (this.toolDefinitionCache.has(toolName)) {
			return this.toolDefinitionCache.get(toolName);
		}
		const definition = this.createToolExecutionDefinition(
			toolName,
			await this.agentConnection.getToolDefinition(toolName),
			this.localSessionHost?.getToolRendererDefinition(toolName),
		);
		this.toolDefinitionCache.set(toolName, definition);
		return definition;
	}

	private getLatestStreamingToolCall(toolCallId: string): ToolCall | undefined {
		return this.streamingMessage?.content.find(
			(content): content is ToolCall => content.type === "toolCall" && content.id === toolCallId,
		);
	}

	private registerIpythonToolComponent(toolName: string, toolCallId: string, component: ToolExecutionComponent): void {
		if (toolName !== "ipython") {
			return;
		}
		this.ipythonToolComponents.set(toolCallId, component);
		for (const lateMessage of this.lateIpythonSentAgentMessages.get(toolCallId) ?? []) {
			component.appendSentAgentMessage(lateMessage);
		}
	}

	/** Files a settled step changed land on its turn, so the collapsed process line can list them. */
	private recordTurnFileChanges(
		state: TurnActivityState | undefined,
		toolCallId: string,
		result: { details?: unknown; isError: boolean },
	): void {
		const step = state?.steps.find((candidate) => candidate.toolCallId === toolCallId);
		if (!state || !step) {
			return;
		}
		const cwd = this.getCurrentCwd();
		state.addFileChanges(
			getToolFileChanges(step.toolName, step.args, result, cwd).map((change) => ({
				...change,
				path: formatFileChangePath(change.path, cwd),
			})),
		);
	}

	/** Create the run's turn-summary line once, before its first tool block. */
	private ensureCurrentTurnSummary(): void {
		if (this.currentTurnSummary) {
			return;
		}
		const state = new TurnActivityState(this.workingStartedAt ?? Date.now());
		state.live = true;
		const summary = this.createTurnSummary(state);
		summary.setExpanded(this.toolOutputExpanded);
		// TUI v4: the live turn head renders the one-line footnote in quiet mode.
		summary.setQuiet(this.settingsManager.getProcessMode() === "quiet");
		this.currentTurnState = state;
		this.currentTurnSummary = summary;
		this.chatContainer.addChild(summary);
	}

	private async getOrCreatePendingToolComponent(
		toolCall: PendingToolCallRenderInput,
	): Promise<ToolExecutionComponent | undefined> {
		const existingComponent = this.pendingTools.get(toolCall.id);
		if (existingComponent) {
			existingComponent.updateArgs(toolCall.arguments);
			this.currentTurnState?.updateStepArgs(toolCall.id, toolCall.arguments);
			return existingComponent;
		}
		if (this.pendingToolCreations.has(toolCall.id)) {
			return undefined;
		}

		this.pendingToolCreations.add(toolCall.id);
		const generation = this.pendingToolGeneration;
		try {
			const toolDefinition = await this.loadToolDefinition(toolCall.name);
			if (generation !== this.pendingToolGeneration) {
				// Pending tool state was reset (abort/error) while loading; drop the stale component.
				return undefined;
			}
			const latestToolCall = this.getLatestStreamingToolCall(toolCall.id) ?? toolCall;
			const componentAfterLoad = this.pendingTools.get(latestToolCall.id);
			if (componentAfterLoad) {
				componentAfterLoad.updateArgs(latestToolCall.arguments);
				this.currentTurnState?.updateStepArgs(latestToolCall.id, latestToolCall.arguments);
				return componentAfterLoad;
			}

			const component = new ToolExecutionComponent(
				latestToolCall.name,
				latestToolCall.id,
				latestToolCall.arguments,
				{
					showImages: this.settingsManager.getShowImages(),
				},
				toolDefinition,
				this.ui,
				this.getCurrentCwd(),
			);
			this.ensureCurrentTurnSummary();
			this.currentTurnState?.addStep({
				toolCallId: latestToolCall.id,
				toolName: latestToolCall.name,
				args: latestToolCall.arguments,
				status: this.startedToolCalls.has(latestToolCall.id) ? "running" : "queued",
			});
			component.setTurnActivity(this.currentTurnState);
			// The live turn's own lanes (K3 ②), falling back to the globals.
			component.setExpanded(this.currentTurnState ? !this.currentTurnState.isCollapsed : this.toolOutputExpanded);
			component.setAgentMessagesExpanded(this.currentTurnState?.agentMessagesExpanded ?? this.agentMessagesExpanded);
			component.setEditDiffsExpanded(this.editDiffsExpanded);
			if (this.startedToolCalls.has(latestToolCall.id)) {
				component.markExecutionStarted();
			}
			selectLatestToolExpandHint(this.chatContainer.children, component);
			this.chatContainer.addChild(component);
			this.pendingTools.set(latestToolCall.id, component);
			this.registerIpythonToolComponent(latestToolCall.name, latestToolCall.id, component);
			return component;
		} finally {
			this.pendingToolCreations.delete(toolCall.id);
		}
	}

	private createToolExecutionDefinition(
		toolName: string,
		connectionDefinition: AgentConnectionToolDefinition | undefined,
		localRendererDefinition: InteractiveModeLocalToolRendererDefinition | undefined,
	): ToolExecutionDefinition | undefined {
		if (!connectionDefinition && !localRendererDefinition) {
			return undefined;
		}

		const definition: ToolExecutionDefinition = {
			...(connectionDefinition ?? {
				name: toolName,
				label: toolName,
				description: "",
				parameters: {},
			}),
		};
		if (localRendererDefinition?.renderShell !== undefined) {
			definition.renderShell = localRendererDefinition.renderShell;
		}
		if (localRendererDefinition?.renderCall !== undefined) {
			definition.renderCall = localRendererDefinition.renderCall;
		}
		if (localRendererDefinition?.renderResult !== undefined) {
			definition.renderResult = localRendererDefinition.renderResult;
		}
		return definition;
	}

	private async preloadToolDefinitions(toolNames: Iterable<string>): Promise<void> {
		const missingToolNames = Array.from(new Set(toolNames)).filter(
			(toolName) => !this.toolDefinitionCache.has(toolName),
		);
		if (missingToolNames.length === 0) {
			return;
		}
		await Promise.all(
			missingToolNames.map(async (toolName) => {
				const definition = this.createToolExecutionDefinition(
					toolName,
					await this.agentConnection.getToolDefinition(toolName),
					this.localSessionHost?.getToolRendererDefinition(toolName),
				);
				this.toolDefinitionCache.set(toolName, definition);
			}),
		);
	}

	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		const localSessionHost = this.getLocalSessionHost();
		// #2095 host timers: the shortcut path builds its own ctx, so its timers must be the same
		// host-owned ones the runner tracks. They are resolved when a handler actually schedules
		// one instead of being spread at construction time: building the shortcut context only
		// requires the runner surface the shortcut path owns (getShortcuts/hasUI/getUIContext),
		// and a host that hands a runner without the timer factory still gets a working context.
		const hostTimers = () => extensionRunner.createTimerBindings();
		const createContext = (): ExtensionContext => ({
			setTimeout: (callback, ms) => hostTimers().setTimeout(callback, ms),
			clearTimeout: (handle) => hostTimers().clearTimeout(handle),
			setInterval: (callback, ms) => hostTimers().setInterval(callback, ms),
			clearInterval: (handle) => hostTimers().clearInterval(handle),
			// The runner already holds the dialog-tracking wrapper that bindExtensions
			// installed, and extension handlers get their UI context from it. Building a
			// fresh one here left the shortcut path uncounted, so a dialog opened by a
			// shortcut handler did not pause the stall watchdog.
			//
			// The fallback is only reached when the runner has no bound UI context at all,
			// in which case there is no session-side wrapper either, so there is no dialog
			// counting to lose. It depends on every host passing uiContext to
			// bindExtensions; a host that bound an empty set while interactive mode kept
			// this fallback would hand out a real but uncounted context.
			ui: extensionRunner.hasUI() ? extensionRunner.getUIContext() : this.createExtensionUIContext(),
			hasUI: extensionRunner.hasUI(),
			cwd: this.getCurrentCwd(),
			sessionManager: localSessionHost.getSessionManager(),
			modelRegistry: this.modelRegistry,
			model: this.getCurrentModel(),
			isIdle: () => !this.isAgentStreaming(),
			signal: localSessionHost.getAbortSignal(),
			abort: () => this.agentConnection.abort(),
			hasPendingMessages: () => this.getQueuedActionCount() > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.getConnectionContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.agentConnection.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => localSessionHost.getSystemPrompt(),
		});

		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				if (matchesKey(data, shortcutStr as KeyId)) {
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`快捷键处理出错：${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private getWorkingLoaderMessage(): string {
		const elapsed =
			this.workingStartedAt === undefined
				? undefined
				: this.formatWorkingElapsed(Date.now() - this.workingStartedAt);
		const status = this.activityTracker.getStatus();
		// The subagent count/recaps live in the tree above the loader, so the loader
		// message itself no longer repeats "N subagents running".
		if (!this.isAgentStreaming()) {
			return "";
		}
		if (this.workingMessage !== undefined) {
			// Extensions and tool bootstrap own the message; keep the plain "<message> <elapsed>" form.
			return elapsed === undefined ? this.workingMessage : `${this.workingMessage} ${elapsed}`;
		}
		const parts: string[] = [AGENT_ACTIVITY_LABELS[status.activity]];
		if (elapsed !== undefined) {
			parts.push(elapsed);
		}
		if (status.tokens > 0 && status.direction === "down") {
			parts.push(`${formatTokenCount(status.tokens)} tok`);
		}
		return parts.join(" · ");
	}

	private createWorkingLoader(): Loader {
		return new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			this.getWorkingLoaderMessage(),
			this.workingIndicatorOptions,
		);
	}

	private formatWorkingElapsed(elapsedMs: number): string {
		const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
		if (totalSeconds < 60) {
			return `${totalSeconds}s`;
		}
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		if (minutes < 60) {
			return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
		}
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		if (hours < 24) {
			return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
		}
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return `${days}d ${remainingHours.toString().padStart(2, "0")}h ${remainingMinutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
	}

	private updateWorkingLoaderMessage(): void {
		this.loadingAnimation?.setMessage(this.getWorkingLoaderMessage());
	}

	private startWorkingTimer(): void {
		if (this.workingTimer) {
			clearInterval(this.workingTimer);
		}
		this.workingTimer = setInterval(() => this.updateWorkingLoaderMessage(), 1000);
		this.workingTimer.unref?.();
	}

	// Recover the in-flight run's start from a restored transcript so the elapsed timer survives re-attach.
	private restoreTurnStartFromMessages(messages: readonly AgentMessage[]): void {
		this.turnStartedAt = undefined;
		if (!this.isAgentStreaming()) return;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i]!;
			if (startsAgentRun(message)) {
				this.turnStartedAt = message.timestamp;
			} else if (message.role === "assistant" && message.stopReason !== "toolUse") {
				break;
			}
		}
		if (this.turnStartedAt !== undefined && this.workingStartedAt !== undefined) {
			this.workingStartedAt = this.turnStartedAt;
			this.updateWorkingLoaderMessage();
		}
	}

	private startWorkingLoader(): void {
		this.stopWorkingLoader();
		this.workingStartedAt = this.turnStartedAt ?? Date.now();
		this.loadingAnimation = this.createWorkingLoader();
		// The quiet face shows the live activity in the status line instead of
		// a row of its own in the conversation.
		if (this.settingsManager.getProcessMode() !== "quiet") {
			this.statusContainer.addChild(this.loadingAnimation);
		}
		this.startWorkingTimer();
		this.startFeatureHintPresentation();
		this.defaultEditor.setPlaceholder(WORKING_PROMPT_PLACEHOLDER);
	}

	private stopWorkingLoader(): void {
		this.clearFeatureHintPresentation();
		this.defaultEditor?.setPlaceholder(this.startHint);
		if (this.workingTimer) {
			clearInterval(this.workingTimer);
			this.workingTimer = undefined;
		}
		this.workingStartedAt = undefined;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
	}

	private startFeatureHintPresentation(): void {
		this.clearFeatureHintPresentation();
		if (this.shouldSuppressFeatureHint()) {
			return;
		}
		if (this.featureHintEligibleAt === 0) {
			this.featureHintEligibleAt = Date.now() + FEATURE_HINT_DELAY_MS;
		}
		const delay = Math.max(0, this.featureHintEligibleAt - Date.now());
		if (delay === 0) {
			this.showFeatureHint();
			return;
		}
		this.featureHintTimer = setTimeout(() => {
			this.featureHintTimer = undefined;
			this.showFeatureHint();
		}, delay);
		this.featureHintTimer.unref?.();
	}

	private showFeatureHint(): void {
		if (
			this.shouldSuppressFeatureHint() ||
			!this.loadingAnimation ||
			!this.shouldShowWorkingLoader() ||
			!this.statusContainer.children.includes(this.loadingAnimation)
		) {
			return;
		}
		if (!this.currentFeatureHint) {
			const hint = this.featureHintDeck.next({
				getKeybinding: (action) => {
					const key = keyText(action);
					return key ? this.capitalizeKey(key) : undefined;
				},
				isResidentSession: this.options.returnToAgentsView === true,
			});
			this.currentFeatureHint = hint?.text;
		}
		if (!this.currentFeatureHint) {
			return;
		}
		this.featureHintComponent = new FeatureHintComponent(this.currentFeatureHint);
		this.featureHintContainer.addChild(this.featureHintComponent);
		this.renderRecap();
		this.featureHintAnimationTimer = setInterval(() => {
			this.featureHintComponent?.advance();
			this.ui.requestRender();
		}, FEATURE_HINT_ANIMATION_INTERVAL_MS);
		this.featureHintAnimationTimer.unref?.();
		this.ui.requestRender();
	}

	private clearFeatureHintPresentation(): void {
		if (this.featureHintTimer) {
			clearTimeout(this.featureHintTimer);
			this.featureHintTimer = undefined;
		}
		if (this.featureHintAnimationTimer) {
			clearInterval(this.featureHintAnimationTimer);
			this.featureHintAnimationTimer = undefined;
		}
		if (this.featureHintComponent) {
			this.featureHintContainer.removeChild(this.featureHintComponent);
			this.featureHintComponent = undefined;
			this.renderRecap();
		}
	}

	private resumeFeatureHintPresentation(): void {
		if (
			!this.shouldSuppressFeatureHint() &&
			this.loadingAnimation &&
			this.shouldShowWorkingLoader() &&
			this.statusContainer.children.includes(this.loadingAnimation)
		) {
			this.startFeatureHintPresentation();
		}
	}

	private shouldSuppressFeatureHint(): boolean {
		const { steering, followUp } = this.getAllQueuedMessages();
		return steering.length > 0 || followUp.length > 0;
	}

	private endFeatureHintRun(): void {
		this.clearFeatureHintPresentation();
		this.currentFeatureHint = undefined;
		this.featureHintEligibleAt = 0;
		this.featureHintRunPending = false;
	}

	private prepareFeatureHintRun(message: AgentMessage): void {
		if (!this.featureHintRunPending) return;
		if (message.role === "assistant") {
			this.featureHintRunPending = false;
			return;
		}
		if (!startsAgentRun(message)) return;

		this.endFeatureHintRun();
		if (this.shouldShowWorkingLoader()) {
			this.startFeatureHintPresentation();
		}
	}

	private updateWorkingPulse(): void {
		const active = this.isAgentStreaming();
		if (!active) {
			this.stopWorkingPulse();
			return;
		}
		if (!this.pulseTimer) {
			// One ticker for both animations: the braille spinner advances every tick,
			// the ◇◈◆ markers derive their slower frame from the same count.
			this.pulseTimer = setInterval(() => this.tickWorkingPulse(), SPINNER_INTERVAL_MS);
			this.pulseTimer.unref?.();
		}
	}

	private tickWorkingPulse(): void {
		this.pulseFrame += 1;
		setWorkingPulseTick(this.pulseFrame);
		this.ui.requestRender();
	}

	private stopWorkingPulse(): void {
		if (this.pulseTimer) {
			clearInterval(this.pulseTimer);
			this.pulseTimer = undefined;
		}
	}

	private shouldShowWorkingLoader(): boolean {
		// Background subagents (agent turn done, asyncio tasks still running) would
		// otherwise show a textless spinner; the subagent tree above the loader carries
		// that state, so the loader only shows while the main agent is itself streaming.
		return this.workingVisible && this.isAgentStreaming();
	}

	// Reconcile the loader with current state for transitions that fire no live
	// agent_start edge (returning from agents view, resuming mid-stream).
	private startCompactionLoader(
		reason: "manual" | "requested" | "overflow" | "threshold",
		customInstructions?: string,
	): void {
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(true);
		}
		// Keep editor active; submissions are queued during compaction.
		// Fully stop the working loader (not just detach) so it isn't orphaned.
		this.stopWorkingLoader();
		this.statusContainer.clear();
		const cancelHint = `(${keyText("app.clear")} to cancel)`;
		const focus = customInstructions ? ` (focus: ${truncateToWidth(customInstructions, 60, "…")})` : "";
		const label =
			reason === "manual"
				? `Compacting context${focus}... ${cancelHint}`
				: reason === "requested"
					? `Agent requested compaction, compacting context${focus}... ${cancelHint}`
					: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		this.autoCompactionLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("muted", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
		this.statusContainer.addChild(this.autoCompactionLoader);
		this.ui.requestRender();
	}

	/** Live status for a user-issued /refine, mirroring the compaction loader. */
	private startRefineLoader(): void {
		this.stopWorkingLoader();
		this.statusContainer.clear();
		this.refineLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("muted", spinner),
			(text) => theme.fg("muted", text),
			"Refining continual harness state...",
		);
		this.statusContainer.addChild(this.refineLoader);
		this.ui.requestRender();
	}

	private stopRefineLoader(): void {
		if (!this.refineLoader) return;
		this.discardRefineLoader();
		this.statusContainer.clear();
		this.syncWorkingLoader();
	}

	/**
	 * Stops and removes the transient status overlays: the retry countdown, the retry
	 * loader and the compaction loader. Both a session replacement and a teardown need
	 * this. A countdown left running keeps ticking into the next session's view and
	 * re-rendering it, and on the teardown path its interval is what holds the process
	 * open after the UI is gone.
	 */
	private disposeTransientStatusOverlays(): void {
		if (this.retryCountdown) {
			this.retryCountdown.dispose();
			this.retryCountdown = undefined;
		}
		if (this.retryLoader) {
			this.retryLoader.stop();
			this.statusContainer.removeChild(this.retryLoader);
			this.retryLoader = undefined;
		}
		if (this.autoCompactionLoader) {
			this.autoCompactionLoader.stop();
			this.statusContainer.removeChild(this.autoCompactionLoader);
			this.autoCompactionLoader = undefined;
		}
	}

	/** Stops and removes the loader without remounting old-session state. */
	private discardRefineLoader(): void {
		if (!this.refineLoader) return;
		this.refineLoader.stop();
		this.statusContainer.removeChild(this.refineLoader);
		this.refineLoader = undefined;
	}

	private syncWorkingLoader(): void {
		// A compaction that started before this client attached (or while another
		// view was open) has no start-event edge; restore its loader from state.
		if (!this.autoCompactionLoader && this.isAgentCompacting()) {
			this.startCompactionLoader("manual");
			return;
		}
		// Compaction/retry own the status container while active; don't fight them.
		if (this.autoCompactionLoader || this.retryLoader) {
			return;
		}
		// Remount the refine loader if another owner (e.g. a compaction) cleared it.
		if (this.refineLoader) {
			if (!this.statusContainer.children.includes(this.refineLoader)) {
				this.statusContainer.clear();
				this.statusContainer.addChild(this.refineLoader);
			}
			return;
		}
		if (this.shouldShowWorkingLoader()) {
			// A bare `loadingAnimation != null` check isn't proof it's on screen:
			// other paths clear statusContainer without nulling it, orphaning the
			// loader. Re-attach unless it is actually mounted.
			if (!this.loadingAnimation || !this.statusContainer.children.includes(this.loadingAnimation)) {
				this.startWorkingLoader();
			}
		} else if (this.loadingAnimation) {
			this.stopWorkingLoader();
		}
		this.ui.requestRender();
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.stopWorkingLoader();
			this.ui.requestRender();
			return;
		}
		if (this.shouldShowWorkingLoader() && !this.loadingAnimation) {
			this.statusContainer.clear();
			this.startWorkingLoader();
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: LoaderIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		this.loadingAnimation?.setIndicator(options);
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		this.cancelActiveConnectionExtensionUiRequests();
		this.closeHeartbeatManager();
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.loadingAnimation) {
			this.updateWorkingLoaderMessage();
		}
		this.setHiddenThinkingLabel();
	}

	private static readonly MAX_WIDGET_LINES = 10;

	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderRecap(): void {
		if (!this.recapContainer) return;
		this.recapContainer.clear();
		const recap = this.sessionRecap?.trim();
		const showChanges = !this.isAgentStreaming() && this.agentRunFileChanges.size > 0;
		if (showChanges) {
			this.recapContainer.addChild(
				new TruncatedText(formatTotalChangeSummary([...this.agentRunFileChanges.values()]), 1, 0),
			);
		}
		if (recap) {
			this.recapContainer.addChild(new TruncatedText(theme.fg("dim", `Recap: ${recap}`), 1, 0));
		}
		if ((recap || showChanges) && !this.featureHintComponent) {
			this.recapContainer.addChild(new Spacer(1));
		}
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		if (this.customFooter) {
			this.footerSlot.removeChild(this.customFooter);
		} else {
			this.footerSlot.removeChild(this.footer);
		}

		if (factory) {
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.footerSlot.addChild(this.customFooter);
		} else {
			this.customFooter = undefined;
			this.footerSlot.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.loadingAnimation) {
					this.updateWorkingLoaderMessage();
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;
		// Snapshot the current editor before replacing it. Paste markers are only
		// meaningful while their originating editor still owns the paste snapshot.
		const currentEditor = this.editor;
		const currentPromptStash = this.snapshotPromptStashFrom(currentEditor, currentEditor.getText());

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Restore before wiring the shared onChange callback: setText may emit a
			// change, and an empty custom editor cannot reconstruct the old snapshot.
			const canRestorePasteSnapshot =
				currentPromptStash.pasteSnapshot === undefined || newEditor.restorePasteSnapshot !== undefined;
			newEditor.setText(
				canRestorePasteSnapshot
					? currentPromptStash.text
					: (currentPromptStash.expandedText ?? currentPromptStash.text),
			);
			if (currentPromptStash.pasteSnapshot && newEditor.restorePasteSnapshot) {
				newEditor.restorePasteSnapshot(currentPromptStash.pasteSnapshot);
			}

			// Wire up callbacks from the default editor. onChange snapshots the
			// active editor while it still owns paste markers and attachments, so
			// submit remains exact even when an editor clears before calling onSubmit.
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onMoveBelowPrompt) {
					customEditor.onMoveBelowPrompt = () => this.defaultEditor.onMoveBelowPrompt?.();
				}
				if (!customEditor.onAgentsBack) {
					customEditor.onAgentsBack = () => this.defaultEditor.onAgentsBack?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore the default editor with the same rich snapshot (or expanded
			// fallback text if this editor implementation cannot restore it).
			const canRestorePasteSnapshot =
				currentPromptStash.pasteSnapshot === undefined || this.defaultEditor.restorePasteSnapshot !== undefined;
			this.defaultEditor.setText(
				canRestorePasteSnapshot
					? currentPromptStash.text
					: (currentPromptStash.expandedText ?? currentPromptStash.text),
			);
			if (currentPromptStash.pasteSnapshot && this.defaultEditor.restorePasteSnapshot) {
				this.defaultEditor.restorePasteSnapshot(currentPromptStash.pasteSnapshot);
			}
			this.editor = this.defaultEditor;
		}
		this.latestEditorPromptStash = currentPromptStash;

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	private setupKeyHandlers(): void {
		this.defaultEditor.getHeaderLine = () => this.getQueueSelectionHeader();
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			this.handleEscape();
		};

		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onAction("app.interrupt", () => this.handleInterruptKey());
		this.defaultEditor.onAction("app.shortcuts", () => this.showShortcutGuide());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => {
			void this.handleDebugCommand();
		};
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.model.cycleForward", () => this.handleModelCycle("forward"));
		this.defaultEditor.onAction("app.model.cycleBackward", () => this.handleModelCycle("backward"));
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.tools.expandAll", () => this.toggleToolOutputExpansion(true));
		this.defaultEditor.onAction("app.tools.expandFull", () => this.toggleToolOutputFull());
		this.defaultEditor.onAction("app.messages.expand", () => this.toggleAgentMessageExpansion());
		this.defaultEditor.onAction("app.messages.expandAll", () => this.toggleAgentMessageExpansion(true));
		this.defaultEditor.onAction("app.edits.expand", () => this.toggleEditDiffExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.thinking.toggleAll", () => this.toggleThinkingBlockVisibility(true));
		this.defaultEditor.onAction("app.subagents.focus", () => this.focusSubagentSummary());
		this.defaultEditor.onAction("app.subagents.stopAll", () => void this.requestStopAllSubagents());
		this.defaultEditor.onAction("app.heartbeats.open", () => {
			void this.showHeartbeatManager();
		});
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.prompt.stash", () => this.handlePromptStash());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		// Alt+Up/Down browse the pending messages when there are any; otherwise they
		// walk the conversation blocks (the two share their default keys).
		this.defaultEditor.onAction("app.message.navigateOlder", () => {
			if (this.hasBrowsableQueue()) this.browseQueueSelection(-1);
			else this.startBlockNavigation(-1);
		});
		this.defaultEditor.onAction("app.message.navigateNewer", () => {
			if (this.hasBrowsableQueue()) this.browseQueueSelection(1);
		});
		this.defaultEditor.onAction("app.blocks.prev", () => this.startBlockNavigation(-1));
		this.defaultEditor.onAction("app.message.moveEarlier", () => this.moveQueueSelection(-1));
		this.defaultEditor.onAction("app.message.moveLater", () => this.moveQueueSelection(1));
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => {
			void this.showTreeSelector();
		});
		this.defaultEditor.onAction("app.session.fork", () => {
			void this.showUserMessageSelector();
		});
		this.defaultEditor.onAction("app.session.resume", () => {
			void this.requestAgentsView();
		});
		this.defaultEditor.onAgentsBack = () => this.handleAgentsBack();
		this.defaultEditor.onMoveBelowPrompt = () => this.focusSubagentSummary();

		this.defaultEditor.onChange = (text: string) => {
			if (text.length > 0 && !this.isApplyingQueueSelectionText) {
				this.latestEditorPromptStash = this.snapshotPromptStashFrom(this.editor, text);
			}
			if (this.escapeRepeatAction && !this.isApplyingQueueSelectionText) {
				this.clearEscapeRepeat();
			}
			if (text.length > 0) {
				this.clearCtrlCExitHint();
			}
		};

		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
		this.defaultEditor.transformPaste = (text) => this.attachPastedImageFiles(text);
	}

	private snapshotPromptStashFrom(editor: EditorComponent, text: string): PromptStash {
		const pasteSnapshot = editor.getPasteSnapshot?.();
		const images = this.getPromptStashImages(text);
		return {
			text,
			expandedText: pasteSnapshot ? (editor.getExpandedText?.() ?? text) : undefined,
			pasteSnapshot,
			...(images.length > 0 ? { images } : {}),
		};
	}

	private snapshotPromptStash(text: string): PromptStash {
		return this.snapshotPromptStashFrom(this.editor, text);
	}

	private restorePromptStashOnOpen(): void {
		if (!this.promptStash?.restoreOnOpen) return;
		this.restorePromptStashIfEditorEmpty();
	}

	private stashDraftForAgentsView(): void {
		const text = this.editor.getText();
		if (!text.trim()) return;
		// Head of the durable queue so it restores first on return; an existing
		// manual stash stays queued behind it and keeps its manual-stash semantics.
		const existing = [this.promptStashState.stash, ...(this.promptStashState.queuedStashes ?? [])].filter(
			(stash): stash is PromptStash => stash !== undefined,
		);
		this.promptStashState.stash = { ...this.snapshotPromptStash(text), restoreOnOpen: true };
		this.promptStashState.queuedStashes = existing.length > 0 ? existing : undefined;
	}

	private handlePromptStash(): void {
		const text = this.editor.getText();
		if (!text.trim()) {
			if (!this.restorePromptStashIfEditorEmpty()) {
				this.showStatus("没有可暂存的输入");
			}
			return;
		}
		if (this.promptStash !== undefined) {
			this.showStatus("暂存区已有一份草稿");
			return;
		}
		this.promptStash = this.snapshotPromptStash(text);
		this.editor.setText("");
		this.showToast("✓ stashed");
	}

	private restorePromptStashIfEditorEmpty(stash = this.promptStash): boolean {
		if (stash === undefined || this.editor.getText().trim()) {
			return false;
		}
		if (this.promptStash !== stash) {
			return false;
		}
		this.promptStash = this.promptStashState?.queuedStashes?.shift();
		if (this.promptStashState?.queuedStashes?.length === 0) this.promptStashState.queuedStashes = undefined;
		const canRestorePasteSnapshot =
			stash.pasteSnapshot === undefined || this.editor.restorePasteSnapshot !== undefined;
		this.editor.setText(canRestorePasteSnapshot ? stash.text : (stash.expandedText ?? stash.text));
		if (stash.pasteSnapshot && this.editor.restorePasteSnapshot) {
			this.editor.restorePasteSnapshot(stash.pasteSnapshot);
		}
		this.latestEditorPromptStash = this.snapshotPromptStash(this.editor.getText());
		this.showToast("✓ draft restored");
		return true;
	}

	private retainSubmittedDraft(
		stash: PromptStash,
		submissionGeneration: number,
		state: PromptStashState = this.promptStashState,
	): void {
		this.retainedSubmissionGenerations.set(stash, submissionGeneration);
		const ordered = [state.stash, ...(state.queuedStashes ?? [])].filter(
			(candidate): candidate is PromptStash => candidate !== undefined,
		);
		const insertAt = ordered.findIndex((candidate) => {
			const generation = this.retainedSubmissionGenerations.get(candidate);
			return generation !== undefined && generation > submissionGeneration;
		});
		ordered.splice(insertAt === -1 ? ordered.length : insertAt, 0, stash);
		state.stash = ordered.shift();
		state.queuedStashes = ordered.length > 0 ? ordered : undefined;
	}

	private retainStartupPromptDrafts(prompts: readonly InteractiveInitialPrompt[]): void {
		// Reserve every marker visible anywhere in the retained batch before assigning
		// any image. This prevents an early prompt's attachment from making a literal
		// marker in a later prompt resolve to the wrong image.
		const reserved = new Set(this.pastedImages.keys());
		for (const stash of [this.promptStash, ...(this.promptStashState.queuedStashes ?? [])]) {
			if (stash) for (const markerId of imageMarkerIds(stash.text)) reserved.add(markerId);
		}
		for (const prompt of prompts) {
			for (const markerId of imageMarkerIds(prompt.text)) reserved.add(markerId);
		}
		for (const markerId of reserved) {
			this.nextImageMarkerId = Math.max(this.nextImageMarkerId, markerId + 1);
		}
		const allocateMarker = () => {
			while (reserved.has(this.nextImageMarkerId)) this.nextImageMarkerId++;
			const markerId = this.nextImageMarkerId++;
			reserved.add(markerId);
			return markerId;
		};

		const retained: PromptStash[] = [];
		for (const prompt of prompts) {
			let text = prompt.text;
			// A startup prompt owns only the images passed with it. Remap literal
			// markers that already name registry data so restoring this draft cannot
			// accidentally attach an old or another prompt's image.
			const literalRemaps = new Map<number, number>();
			for (const markerId of imageMarkerIds(text)) {
				if (this.pastedImages.has(markerId) && !literalRemaps.has(markerId)) {
					literalRemaps.set(markerId, allocateMarker());
				}
			}
			text = remapImageMarkers(text, literalRemaps);

			const images: Array<readonly [number, ImageContent]> = [];
			for (const image of prompt.images ?? []) {
				const markerId = allocateMarker();
				images.push([markerId, image]);
				text += `${text.length > 0 && !/\s$/.test(text) ? " " : ""}${formatImageMarker(markerId)}`;
			}
			retained.push({
				text,
				...(images.length > 0 ? { images } : {}),
			});
			for (const [markerId, image] of images) this.pastedImages.set(markerId, image);
		}

		// Startup drafts form the head of the durable queue. Preserve any older
		// client draft after them, and let submissions released by the barrier append.
		const existing = [this.promptStashState.stash, ...(this.promptStashState.queuedStashes ?? [])].filter(
			(stash): stash is PromptStash => stash !== undefined,
		);
		const ordered = [...retained, ...existing];
		this.promptStashState.stash = ordered.shift();
		this.promptStashState.queuedStashes = ordered.length > 0 ? ordered : undefined;
	}

	private getPromptStashImages(text: string): readonly (readonly [number, ImageContent])[] {
		const images: Array<readonly [number, ImageContent]> = [];
		for (const markerId of imageMarkerIds(text)) {
			const image = this.pastedImages.get(markerId);
			if (image) {
				images.push([markerId, image]);
			}
		}
		return images;
	}

	private async handleClipboardImagePaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// Resize down to the inline image size limit, mirroring the CLI @file
			// path, so large screenshots don't exceed provider limits. Fall back to
			// the raw bytes if resizing is unavailable.
			const raw: ImageContent = {
				type: "image",
				data: Buffer.from(image.bytes).toString("base64"),
				mimeType: image.mimeType,
			};
			const resized = await resizeImage(raw);
			const attachment: ImageContent = resized
				? { type: "image", data: resized.data, mimeType: resized.mimeType }
				: raw;

			// Register the image and insert a visible marker. The image is attached to
			// the prompt as multimodal content, so a vision model receives it directly;
			// a copy saved under the session lets a model look at it again later.
			const markerId = this.nextImageMarkerId++;
			this.rememberPastedImage(markerId, attachment);
			this.pastedImageFiles.save(markerId, attachment, this.pastedImageDir());
			this.editor.insertTextAtCursor?.(formatImageMarker(markerId));
			this.ui.requestRender();
			await this.warnIfPastedImageUnseen();
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	/**
	 * A paste that is exactly one or more image file paths (typed, copied, or dropped
	 * from Finder) attaches each file as an image like Ctrl+V, keeping the path visible;
	 * anything else is left as the text it was.
	 */
	private attachPastedImageFiles(text: string): string {
		const files = imageFilesInPaste(text, this.getCurrentCwd());
		if (!files) return text;
		const markers = files.map((file) => {
			const markerId = this.nextImageMarkerId++;
			this.pastedImageFiles.load(markerId, file);
			return formatImageMarker(markerId);
		});
		void this.warnIfPastedImageUnseen();
		return `${text.trimEnd()} ${markers.join(" ")}`;
	}

	private get pastedImageFiles(): PastedImageFiles {
		this.pastedImageFilesStore ??= new PastedImageFiles({
			remember: (markerId, image) => this.rememberPastedImage(markerId, image),
			warn: (message) => this.showStatus(message, "warning"),
		});
		return this.pastedImageFilesStore;
	}

	/** Where this session keeps pasted images, or undefined for an unsaved session. */
	private pastedImageDir(): string | undefined {
		const state = this.connectionState;
		const artifactDir = this.uiServices.getSessionArtifactDir;
		if (!state?.sessionFile || !artifactDir) return undefined;
		try {
			return path.join(artifactDir(state.sessionFile, state.sessionId), "pasted-images");
		} catch {
			return undefined;
		}
	}

	/**
	 * Warn at paste time, in Chinese, when no model will see the image: the session model
	 * has no image input and imageModel is unset, unusable (unknown, not image-capable,
	 * not logged in), or images are turned off. Same checks the dispatch applies.
	 */
	private async warnIfPastedImageUnseen(): Promise<void> {
		const model = this.getCurrentModel();
		const state = this.connectionState;
		if (!model || !state || model.input.includes("image")) return;
		const availableModels = await this.getConnectionAvailableModels().catch(() =>
			this.getAvailableConnectionModels(),
		);
		const route = resolveImageModelRoute({
			sessionModel: model,
			thinkingLevel: state.thinkingLevel,
			serviceTier: state.serviceTier,
			imageModelReference: this.settingsManager.getImageModel(),
			availableModels,
			hasConfiguredAuth: (candidate) => this.isModelProviderConfigured(candidate),
			blockImages: this.settingsManager.getBlockImages(),
		});
		const notice = pastedImageProblemNotice(route, `${model.provider}/${model.id}`);
		if (notice) this.showStatus(notice, "warning");
	}

	/**
	 * Say which model reads the images when a turn of a text-only session model is
	 * served by an image-capable one, once per routed stretch.
	 */
	private noticeImageModelServing(message: AssistantMessage): void {
		const sessionModel = this.getCurrentModel();
		const served = `${message.provider}/${message.model}`;
		if (
			!sessionModel ||
			sessionModel.input.includes("image") ||
			(message.provider === sessionModel.provider && message.model === sessionModel.id)
		) {
			this.imageModelServingNotice = undefined;
			return;
		}
		const servingModel =
			this.connectionModelCatalog.find(
				(model) => model.provider === message.provider && model.id === message.model,
			) ?? this.modelRegistry.find(message.provider, message.model);
		if (!servingModel?.input.includes("image") || this.imageModelServingNotice === served) return;
		this.imageModelServingNotice = served;
		this.showStatus(`这张图交给 ${served} 看`);
	}

	/**
	 * Record a pasted image, evicting the oldest entries once the retained bytes
	 * exceed {@link MAX_PASTED_IMAGE_BYTES} so a long session stays bounded. The
	 * just-added image and any whose marker is still referenced (editor or queues)
	 * are never evicted, so a live marker never loses its image.
	 */
	private rememberPastedImage(id: number, image: ImageContent): void {
		this.pastedImages.set(id, image);
		const keep = this.liveImageMarkerIds();
		keep.add(id);
		evictImagesToBudget(this.pastedImages, (img) => img.data.length, MAX_PASTED_IMAGE_BYTES, keep);
	}

	/**
	 * Marker ids still reachable — current editor text, prompt history (recallable
	 * with the up arrow), the compaction queue, and the connection queue. These are
	 * never evicted so a recall or resend never finds a marker with no image.
	 */
	private liveImageMarkerIds(): Set<number> {
		const ids = new Set<number>();
		const add = (text: string) => {
			for (const markerId of imageMarkerIds(text)) {
				ids.add(markerId);
			}
		};
		add(this.editor.getText());
		for (const stash of [this.promptStash, ...(this.promptStashState?.queuedStashes ?? [])]) {
			if (stash) add(stash.text);
		}
		for (const entry of this.editor.getHistory?.() ?? []) {
			add(entry);
		}
		const queue = this.getConnectionQueue();
		for (const msg of [...queue.steering, ...queue.followUp]) {
			add(msg);
		}
		return ids;
	}

	/**
	 * The images whose `[image #N]` markers are present in `text`, or undefined if
	 * none. Read-only: the registry is never cleared here, so deleting a marker
	 * simply drops its image while restoring the marker (undo, history, retry,
	 * dequeue) brings it back. Marker presence in the sent text is the single
	 * source of truth.
	 *
	 * Attachments always reach the session: a text-only session model is either
	 * routed to settings.imageModel at dispatch or the turn fails there with an
	 * actionable setup error, so nothing is silently downgraded downstream.
	 */
	private collectImagesFor(text: string): ImageContent[] | undefined {
		const images = collectMarkedImages(this.pastedImages, text);
		return images.length > 0 ? images : undefined;
	}

	private hasPastedImagesFor(text: string): boolean {
		return imageMarkerIds(text).some((id) => this.pastedImages.has(id));
	}

	private async handleSideQuestion(question: string): Promise<void> {
		if (!question) {
			this.showWarning("用法：/btw <问题>");
			return;
		}
		if (this.activeSideQuestionId) {
			this.showWarning("请先等旁路提问结束，或先取消它。");
			return;
		}

		// Turns already answered in the open pane seed the follow-up's context.
		const previousTurns = this.sideQuestionTurns
			.filter((turn) => turn.answer)
			.map((turn) => ({ question: turn.question, answer: turn.answer }));
		const event: AgentConnectionSideQuestionEvent = {
			id: randomUUID(),
			question,
			answer: "",
			status: "running",
		};
		this.activeSideQuestionId = event.id;
		this.sideQuestionEvent = event;
		this.sideQuestionTurns.push(event);
		if (this.sideQuestionComponent) {
			this.sideQuestionComponent.addTurn(event);
		} else {
			this.sideQuestionComponent = new SideQuestionComponent(event, this.settingsManager.getEditorPaddingX());
			this.sideQuestionContainer.addChild(new Spacer(1));
			this.sideQuestionContainer.addChild(this.sideQuestionComponent);
		}
		this.ui.requestRender();

		try {
			await this.agentConnection.startSideQuestion(
				event.id,
				question,
				previousTurns.length > 0 ? previousTurns : undefined,
			);
		} catch (error) {
			this.handleSideQuestionEvent({
				...event,
				status: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private handleSideQuestionEvent(event: AgentConnectionSideQuestionEvent): void {
		if (event.id === this.activeSideQuestionId && event.status !== "running") {
			this.activeSideQuestionId = undefined;
		}
		if (event.id !== this.sideQuestionEvent?.id || !this.sideQuestionComponent) {
			return;
		}
		this.sideQuestionEvent = event;
		const turnIndex = this.sideQuestionTurns.findIndex((turn) => turn.id === event.id);
		if (turnIndex !== -1) {
			this.sideQuestionTurns[turnIndex] = event;
		}
		this.sideQuestionComponent.update(event);
		this.ui.requestRender();
	}

	private finishSideQuestionBash(
		event: Extract<AgentConnectionSessionEvent, { type: "bash_end" }>,
		rawOutput: string,
	): void {
		// Release the pane's running state before any early return so the cancel
		// hint cannot stay stuck if the pending state was already cleared.
		this.sideQuestionComponent?.finishBash();
		const bash = this.sideQuestionBash;
		if (!bash) {
			return;
		}
		this.sideQuestionBash = undefined;
		// The pane already rendered the run; this only seeds follow-up turns.
		if (!bash.seedTranscript || event.cancelled || event.errorMessage) {
			return;
		}
		const truncation = truncateTail(rawOutput);
		const output = truncation.content.replace(/\n+$/, "");
		this.sideQuestionTurns.push({
			id: `side-bash-${randomUUID()}`,
			question: bash.input,
			answer: bashOutputToText({
				output,
				exitCode: event.exitCode,
				cancelled: false,
				truncated: event.truncated || truncation.truncated,
				fullOutputPath: event.fullOutputPath,
			}),
			status: "complete",
		});
	}

	private clearSideQuestion(options: { abort?: boolean } = {}): void {
		const event = this.sideQuestionEvent;
		if (options.abort && event?.status === "running") {
			this.abortSideQuestion(event.id);
		}
		if (this.sideQuestionBash) {
			// A side-conversation bash run dies with its pane. Its bash_* events may
			// still be in flight (even bash_start), so swallow them until bash_end.
			const ownsRunningBash = this.sideQuestionBashComponent !== undefined;
			this.sideQuestionBashDiscarded = this.sideQuestionBash.runId;
			this.sideQuestionBash = undefined;
			this.sideQuestionBashComponent = undefined;
			// abort_bash is session-scoped. Before our matching bash_start arrives,
			// another client may own the slot, so only abort a run we have observed.
			if (ownsRunningBash) {
				void this.agentConnection.abortBash().catch(() => undefined);
			}
		}
		this.sideQuestionEvent = undefined;
		this.sideQuestionTurns = [];
		this.sideQuestionComponent = undefined;
		this.sideQuestionContainer.clear();
		if (this.isInitialized) {
			this.ui.requestRender();
		}
	}

	private resetSideQuestion(): void {
		this.clearSideQuestion({ abort: true });
		this.activeSideQuestionId = undefined;
	}

	private abortSideQuestion(id: string, reportError = false): void {
		void this.agentConnection
			.abortSideQuestion(id)
			.then((aborted) => {
				if (!aborted && this.activeSideQuestionId === id) {
					this.activeSideQuestionId = undefined;
				}
			})
			.catch((error) => {
				if (reportError) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
			});
	}

	private async renderTreeNavigation(result: { editorText?: string }): Promise<void> {
		this.clearSideQuestion({ abort: true });
		this.resetBlockNavigation();
		this.chatContainer.clear();
		await this.renderInitialMessages();
		if (result.editorText && !this.editor.getText().trim()) {
			this.editor.setText(result.editorText);
		}
		this.showStatus("已回到选中的位置");
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			const streamingBehavior = this.submittedInputBehavior;
			this.submittedInputBehavior = "steer";
			if (this.queueSelection?.isBrowsing && !this.pendingQueueEdit) {
				const targetLane = streamingBehavior === "followUp" ? "followUp" : "steering";
				try {
					if (await this.applyQueueSelection(text, targetLane)) return;
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
					return;
				}
			}
			text = text.trim();
			if (!text) {
				await this.resumeParkedQueueIfIdle();
				return;
			}
			const submissionGeneration = ++this.inputSubmissionGeneration;
			this.inputSubmissionsPending++;
			this.clearShortcutGuide();
			// The duty log answered "what happened while I was away"; the next input moves on.
			if (this.dutyLogContainer?.children.length) {
				this.dutyLogContainer.clear();
				this.ui.requestRender();
			}
			// A barrier wait can resume after /new repointed the live session fields.
			const submissionStashState = this.promptStashState;
			const submissionSessionId = this.promptStashSessionId;
			const promptStashToRestore = this.promptStash;
			const liveEditorText = this.editor.getText();
			const submittedDraft =
				this.pendingSubmittedPromptStash ??
				(liveEditorText.trim() ? this.snapshotPromptStash(liveEditorText) : this.latestEditorPromptStash);
			this.pendingSubmittedPromptStash = undefined;
			let restorePromptStashAfterSubmit = true;
			let submissionOutcome: StartupPromptBarrierOutcome = "admitted";

			try {
				const slashCommand = parseSlashCommand(text);
				const commandName = slashCommand ? resolveBuiltinSlashCommandName(slashCommand.name) : undefined;
				const commandArgs = slashCommand?.args ?? "";
				const canonicalCommandText = commandName ? `/${commandName}${commandArgs ? ` ${commandArgs}` : ""}` : text;

				// Slash commands are disabled while a side conversation is open: they
				// act on the main session, which is confusing mid-side-chat. The notice
				// renders as a pane response and never reaches the model. A reply that
				// merely starts with "/" (e.g. an absolute path) is not a command and
				// falls through to the side-conversation capture below.
				if (
					this.sideQuestionComponent &&
					slashCommand !== undefined &&
					(isBuiltinSlashCommandName(slashCommand.name) ||
						this.connectionCommands.some((command) => command.name === slashCommand.name))
				) {
					this.editor.addToHistory?.(text);
					this.sideQuestionComponent.addTurn({
						id: `side-notice-${randomUUID()}`,
						question: text,
						answer:
							"Slash commands are not available in side conversations. Press esc to return to the main thread.",
						status: "complete",
					});
					this.ui.requestRender();
					return;
				}
				if (commandName) {
					void captureAgentCommandUsed({
						agentDir: getAgentDir(),
						settingsManager: this.settingsManager,
						commandName,
					}).catch(() => {});
				}

				if (commandName === "btw") {
					this.editor.setText("");
					await this.handleSideQuestion(commandArgs);
					return;
				}
				if (commandName === "settings" && !commandArgs) {
					await this.showSettingsSelector();
					this.editor.setText("");
					return;
				}
				if (commandName === "scoped-models" && !commandArgs) {
					this.editor.setText("");
					await this.showModelsSelector();
					return;
				}
				if (commandName === "model") {
					const searchTerm = commandArgs || undefined;
					this.editor.setText("");
					await this.handleModelCommand(searchTerm);
					return;
				}
				if (commandName === "effort") {
					this.editor.setText("");
					this.handleEffortCommand(commandArgs);
					return;
				}
				if (commandName === "fast") {
					this.editor.setText("");
					if (commandArgs) {
						this.showError("用法：/fast");
					} else {
						this.handleFastCommand();
					}
					return;
				}
				if (commandName === "export") {
					await this.handleExportCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "import") {
					await this.handleImportCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "share" && !commandArgs) {
					await this.handleShareCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "copy" && !commandArgs) {
					await this.handleCopyCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "name") {
					await this.handleNameCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "rlm-max-depth") {
					this.editor.setText("");
					await this.handleRlmMaxDepthCommand(commandArgs);
					return;
				}
				if (commandName === "session" && !commandArgs) {
					this.echoLocalCommand(text);
					await this.handleSessionCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "system-prompt" && !commandArgs) {
					this.echoLocalCommand(text);
					await this.handleSystemPromptCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "traces") {
					await this.handleTracesCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "context" && !commandArgs) {
					this.echoLocalCommand(text);
					await this.handleContextCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "logs" && !commandArgs) {
					this.echoLocalCommand(text);
					this.handleLogsCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "heartbeat") {
					await this.handleHeartbeatCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "heartbeats") {
					this.editor.setText("");
					await this.showHeartbeatManager();
					return;
				}
				if (commandName === "changelog" && !commandArgs) {
					this.echoLocalCommand(text);
					this.handleChangelogCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "hotkeys" && !commandArgs) {
					this.echoLocalCommand(text);
					this.handleHotkeysCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "fork" && !commandArgs) {
					this.editor.setText("");
					await this.showUserMessageSelector();
					return;
				}
				if (commandName === "clone" && !commandArgs) {
					this.editor.setText("");
					await this.handleCloneCommand();
					return;
				}
				if (commandName === "tree" && !commandArgs) {
					this.editor.setText("");
					restorePromptStashAfterSubmit = false;
					await this.showTreeSelector();
					return;
				}
				if (commandName === "login" && !commandArgs) {
					this.editor.setText("");
					await this.showConfigurationMenu("providers");
					return;
				}
				if (commandName === "logout" && !commandArgs) {
					this.editor.setText("");
					await this.showLogoutSelector();
					return;
				}
				if (commandName === "mcp") {
					this.editor.setText("");
					await this.handleMcpCommand(commandArgs);
					return;
				}
				if (slashCommand?.name === "clear") {
					if (commandArgs) {
						this.editor.setText(text);
						this.showError("用法：/clear");
					} else {
						this.editor.setText("");
						await this.handleClearCommand();
					}
					return;
				}
				if (slashCommand?.name === "new") {
					let options: ReturnType<typeof parseNewSessionCommand>;
					try {
						options = parseNewSessionCommand(text.slice(4));
					} catch (error) {
						this.editor.setText(text);
						this.showError(error instanceof Error ? error.message : String(error));
						return;
					}
					this.editor.setText("");
					await this.handleClearCommand(options);
					return;
				}
				if (commandName === "resume") {
					this.editor.setText("");
					await this.handleResumeCommand(commandArgs);
					return;
				}
				if (commandName === "reload" && !commandArgs) {
					this.editor.setText("");
					await this.handleReloadCommand();
					return;
				}
				if (commandName === "update") {
					this.editor.setText("");
					const updateArgs = parseCommandArgs(commandArgs);
					if (
						!updateArgsIncludeSelf(updateArgs) &&
						(this.isAgentCompacting() || this.isAgentStreaming() || this.isBashRunning())
					) {
						this.showWarning("请等当前任务结束后再更新。");
						return;
					}
					await this.handleUpdateCommand(commandArgs);
					return;
				}
				if (commandName === "fullscreen") {
					this.editor.setText("");
					const arg = commandArgs?.trim().toLowerCase();
					if (arg && arg !== "on" && arg !== "off") {
						this.showError("用法：/fullscreen [on|off]");
						return;
					}
					const enable = arg === "on" ? true : arg === "off" ? false : !this.fullscreenEnabled;
					this.setFullscreenMode(enable);
					return;
				}
				if (commandName === "dutylog") {
					this.editor.setText("");
					await this.showDutyLog({ automatic: false });
					return;
				}
				if (commandName === "speed") {
					this.editor.setText("");
					const arg = commandArgs?.trim().toLowerCase();
					if (arg && arg !== "on" && arg !== "off") {
						this.showError("用法：/speed [on|off]");
						return;
					}
					const enable = arg === "on" ? true : arg === "off" ? false : !this.speedDisplayEnabled;
					this.setSpeedDisplay(enable);
					return;
				}
				if (commandName === "debug" && !commandArgs) {
					await this.handleDebugCommand();
					this.editor.setText("");
					return;
				}
				if (text === "/arminsayshi") {
					this.handleArminSaysHi();
					this.editor.setText("");
					return;
				}
				if (text === "/dementedelves") {
					this.handleDementedDelves();
					this.editor.setText("");
					return;
				}
				if (text === "/quit") {
					this.editor.setText("");
					await this.shutdown();
					return;
				}

				// Handle bash command (! for normal, !! for excluded from context)
				if (text.startsWith("!")) {
					const isExcluded = text.startsWith("!!");
					const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
					if (!command) {
						// Bare ! / !! is bash mode with nothing to run; don't send it as a prompt
						return;
					}
					if (this.isBashRunning()) {
						this.showWarning(
							`A bash command is already running. Press ${keyText("app.clear")} to cancel it first.`,
						);
						return;
					}
					// A streaming side turn blocks bash just like it blocks follow-up
					// replies: overlapping pane turns would seed out of order.
					if (this.sideQuestionComponent && this.activeSideQuestionId) {
						this.editor.setText(text);
						this.showWarning("请先等旁路提问结束，或先取消它。");
						return;
					}
					// Inside a side conversation the command runs inside the pane (its
					// bash_start event mounts the usual BashExecutionComponent there),
					// stays out of the main-session context, and (for !, not !!) seeds
					// follow-up side questions.
					const sideBash = this.sideQuestionComponent
						? { runId: randomUUID(), input: text, seedTranscript: !isExcluded }
						: undefined;
					if (sideBash) {
						this.sideQuestionBash = sideBash;
					} else {
						this.clearSideQuestion({ abort: true });
					}
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					// Optimistic: bash_start only fires after extension dispatch, and the
					// clear key must already route to abortBash in that window.
					this.patchConnectionState({ isBashRunning: true });
					try {
						await this.agentConnection.executeBash(command, {
							excludeFromContext: isExcluded || sideBash !== undefined,
							...(sideBash ? { transient: true, runId: sideBash.runId } : {}),
						});
					} catch (error) {
						// Re-sync rather than assume idle: the rejection may mean another
						// client's bash run already holds the slot.
						try {
							const state = await this.agentConnection.getState();
							this.patchConnectionState({ isBashRunning: state.isBashRunning });
						} catch {
							this.patchConnectionState({ isBashRunning: false });
						}
						if (this.sideQuestionBash === sideBash) {
							this.sideQuestionBash = undefined;
						}
						if (sideBash && this.sideQuestionBashDiscarded === sideBash.runId) {
							// The pane discarded this run, but it never started, so no
							// bash_end will arrive to consume the marker.
							this.sideQuestionBashDiscarded = undefined;
						}
						this.showError(error instanceof Error ? error.message : String(error));
					}
					return;
				}

				// An open side-question pane captures replies as follow-up side
				// questions; ! bash routed above and slash commands were rejected
				// earlier with a notice. Esc returns to the main thread.
				if (this.sideQuestionComponent) {
					// A follow-up submitted mid-bash would seed the transcript ahead of
					// the output it reacts to; make it wait like a running side turn.
					// The editor cleared its buffer before onSubmit fired, so blocked
					// paths put the draft back rather than merely skip clearing it.
					if (this.sideQuestionBash) {
						this.editor.setText(text);
						this.showWarning("请先等命令跑完，或先取消它。");
						return;
					}
					if (this.activeSideQuestionId) {
						this.editor.setText(text);
						await this.handleSideQuestion(text);
						return;
					}
					// Side questions are text-only end to end; a reply with pasted
					// images gets an in-pane notice instead of silently dropping them.
					if (this.hasPastedImagesFor(text)) {
						this.editor.setText(text);
						this.sideQuestionComponent.addTurn({
							id: `side-notice-${randomUUID()}`,
							question: text,
							answer: "Images are not supported in side conversations. Press esc to return to the main thread.",
							status: "complete",
						});
						this.ui.requestRender();
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleSideQuestion(text);
					return;
				}

				this.clearSideQuestion({ abort: true });
				this.flushPendingBashComponents();
				// A pasted image path is still being read: send its image, not a bare marker.
				if (this.pastedImageFiles.hasPending(text)) await this.pastedImageFiles.settle(text);
				const images = this.collectImagesFor(text);
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				const promptStashAfterClear = this.promptStash;
				submissionOutcome = (await this.admitPendingStartupPrompts?.()) ?? "admitted";
				// Retention is not admission. Startup drafts were inserted synchronously
				// before the barrier settled, so append this blocked submission behind them
				// and never let it prompt or overtake them.
				if (submissionOutcome === "retained") {
					this.retainSubmittedDraft(submittedDraft ?? { text }, submissionGeneration);
					return;
				}
				// The barrier also settles when the run lifecycle ends; a submit resumed
				// by teardown must neither prompt nor mutate the editor/durable stash.
				if (
					submissionOutcome === "lifecycle-cancelled" ||
					this.isShuttingDown ||
					this.agentsViewRequest ||
					this.promptStashSessionId !== submissionSessionId
				) {
					// The editor is already torn down, but its shared session stash outlives
					// this view. Preserve the submitted draft in the stash of the session it
					// was typed for, without overwriting an explicit older stash.
					this.retainSubmittedDraft(submittedDraft ?? { text }, submissionGeneration, submissionStashState);
					submissionOutcome = "lifecycle-cancelled";
					return;
				}
				try {
					await this.agentConnection.prompt(this.pastedImageFiles.annotate(text), {
						streamingBehavior,
						queueIfBusy: true,
						images,
					});
				} catch (error) {
					// Generation guards editor ownership, not draft durability: a stale
					// rejection must be retained rather than overwrite newer input or vanish.
					const rejectedDraft = submittedDraft ?? { text };
					const canRestore =
						!this.isShuttingDown &&
						!this.agentsViewRequest &&
						submissionGeneration === this.inputSubmissionGeneration &&
						this.editor.getText().length === 0;
					if (canRestore) {
						const canRestorePasteSnapshot =
							rejectedDraft.pasteSnapshot === undefined || this.editor.restorePasteSnapshot !== undefined;
						this.editor.setText(
							canRestorePasteSnapshot ? rejectedDraft.text : (rejectedDraft.expandedText ?? rejectedDraft.text),
						);
						if (rejectedDraft.pasteSnapshot && this.editor.restorePasteSnapshot) {
							this.editor.restorePasteSnapshot(rejectedDraft.pasteSnapshot);
						}
						this.latestEditorPromptStash = this.snapshotPromptStash(this.editor.getText());
						if (this.promptStash === promptStashAfterClear) this.promptStash = promptStashToRestore;
					} else {
						this.retainSubmittedDraft(rejectedDraft, submissionGeneration, submissionStashState);
					}
					this.showError(error instanceof Error ? error.message : String(error));
					return;
				}
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
			} finally {
				if (this.isShuttingDown || this.agentsViewRequest) {
					submissionOutcome = "lifecycle-cancelled";
				}
				if (
					submissionOutcome === "admitted" &&
					restorePromptStashAfterSubmit &&
					promptStashToRestore !== undefined &&
					submissionGeneration === this.inputSubmissionGeneration
				) {
					this.restorePromptStashIfEditorEmpty(promptStashToRestore);
				}
				this.inputSubmissionsPending--;
				if (this.inputSubmissionsPending === 0 && this.pendingPromptStashReleases.length > 0) {
					this.completeDeferredPromptStashRelease();
				}
			}
		};
	}

	private async subscribeToRosterBar(): Promise<void> {
		if (!this.agentConnection.subscribeAgentRoster) return;
		try {
			this.rosterBar = await this.agentConnection.subscribeAgentRoster(() => {
				this.updateSubagentSummaryLine();
				this.ui.requestRender();
			});
		} catch {
			this.rosterBar = undefined;
		}
		this.updateSubagentSummaryLine();
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.agentConnection.subscribe(async (event) => {
			try {
				if (event.type === "session_event") {
					if (event.event.type === "message_end" && event.event.message.role === "assistant") {
						this.lastAssistantStopReason = event.event.message.stopReason;
					}
					// Connection adapters dispatch without awaiting, so serialize events.
					// Replacement advances the generation before entering this queue, which
					// prevents already-queued source events from mutating the target UI.
					const generation = this.sessionEventGeneration;
					const run = this.sessionEventQueue.then(() =>
						generation === this.sessionEventGeneration ? this.handleEvent(event.event) : undefined,
					);
					this.sessionEventQueue = run.catch(() => {});
					await run;
				} else if (event.type === "session_replaced") {
					const generation = ++this.sessionEventGeneration;
					const run = this.sessionEventQueue.then(async () => {
						if (generation !== this.sessionEventGeneration) return;
						this.resetSideQuestion();
						this.resetExtensionUI();
						this.applyConnectionStateSnapshot(event.state);
						this.resetCurrentSessionRenderState();
						await this.rebindCurrentSession();
						await this.renderInitialMessages();
						this.ui.requestRender();
					});
					this.sessionEventQueue = run.catch(() => {});
					await run;
				} else if (event.type === "session_resynced") {
					const generation = this.sessionEventGeneration;
					const run = this.sessionEventQueue.then(async () => {
						if (generation !== this.sessionEventGeneration) return false;
						await this.refreshCommandCatalogForCurrentSession?.();
						if (generation !== this.sessionEventGeneration) return false;
						await this.renderResyncedSession(event.snapshot);
						return true;
					});
					this.sessionEventQueue = run.then(() => undefined).catch(() => {});
					if (await run) this.ui.requestRender();
				} else if (event.type === "session_status") {
					this.sessionRecap = event.recap;
					this.patchConnectionState({ recap: event.recap });
					this.renderRecap();
				} else if (event.type === "side_question_event") {
					this.handleSideQuestionEvent(event.event);
				} else if (event.type === "extension_ui_request") {
					await this.handleConnectionExtensionUiRequest(event.request);
				} else if (event.type === "connection_status") {
					if (event.status === "connected") {
						const banner = formatDaemonReconnectBanner(event.daemonVersion, VERSION);
						this.showStatus(banner.message, banner.tone);
					} else if (event.backgroundAttempt !== undefined) {
						this.showStatus(
							`Daemon connection lost; retrying in the background (attempt ${event.backgroundAttempt})`,
							"warning",
						);
					} else {
						this.showStatus("和后台的连接断开了，正在重连…", "warning");
					}
					if (event.status === "connected") {
						await this.refreshHeartbeatCatalog();
					}
				} else if (event.type === "heartbeats_changed") {
					await this.refreshHeartbeatCatalog();
				} else if (event.type === "closed") {
					if (!this.returnToParentAfterSubagentClosed(event.sessionClosedReason)) {
						this.showError(event.error ?? "Agent connection closed");
					}
				}
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
		});
	}

	private async handleConnectionExtensionUiRequest(request: AgentConnectionExtensionUiRequest): Promise<void> {
		let response: AgentConnectionExtensionUiResponse | undefined;
		const expectsResponse = this.expectsConnectionExtensionUiResponse(request);

		try {
			if (expectsResponse) {
				let cancelLocal: (response: AgentConnectionExtensionUiResponse) => void = () => {};
				const cancelled = new Promise<AgentConnectionExtensionUiResponse>((resolve) => {
					cancelLocal = resolve;
				});
				this.activeConnectionExtensionUiRequests.set(request.id, {
					cancelLocal: () => cancelLocal({ cancelled: true }),
				});
				response = await Promise.race([this.resolveConnectionExtensionUiRequest(request), cancelled]);
			} else {
				response = await this.resolveConnectionExtensionUiRequest(request);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			response = { cancelled: true };
		}

		if (response === undefined) {
			this.activeConnectionExtensionUiRequests.delete(request.id);
			return;
		}

		if (!this.activeConnectionExtensionUiRequests.delete(request.id)) {
			return;
		}

		try {
			await this.agentConnection.respondToExtensionUiRequest(request.id, response);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private expectsConnectionExtensionUiResponse(request: AgentConnectionExtensionUiRequest): boolean {
		return (
			request.method === "select" ||
			request.method === "confirm" ||
			request.method === "input" ||
			request.method === "editor"
		);
	}

	private cancelActiveConnectionExtensionUiRequests(): void {
		const requestIds = [...this.activeConnectionExtensionUiRequests.keys()];
		for (const requestId of requestIds) {
			const activeRequest = this.activeConnectionExtensionUiRequests.get(requestId);
			if (!activeRequest) {
				continue;
			}
			this.activeConnectionExtensionUiRequests.delete(requestId);
			activeRequest.cancelLocal();
			void this.agentConnection.respondToExtensionUiRequest(requestId, { cancelled: true }).catch((error) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
		}
	}

	private async resolveConnectionExtensionUiRequest(
		request: AgentConnectionExtensionUiRequest,
	): Promise<AgentConnectionExtensionUiResponse | undefined> {
		const { payload } = request;
		switch (request.method) {
			case "select": {
				const title = getPayloadString(payload, "title");
				const options = getPayloadStringArray(payload, "options");
				if (!title || !options) {
					return { cancelled: true };
				}
				const value = await this.showExtensionSelector(title, options, {
					timeout: getPayloadNumber(payload, "timeout"),
				});
				return value === undefined ? { cancelled: true } : { value };
			}
			case "confirm": {
				const title = getPayloadString(payload, "title");
				const message = getPayloadString(payload, "message");
				if (!title || message === undefined) {
					return { cancelled: true };
				}
				const confirmed = await this.showExtensionConfirm(title, message, {
					timeout: getPayloadNumber(payload, "timeout"),
				});
				return { confirmed };
			}
			case "input": {
				const title = getPayloadString(payload, "title");
				if (!title) {
					return { cancelled: true };
				}
				const value = await this.showExtensionInput(title, getPayloadString(payload, "placeholder"), {
					timeout: getPayloadNumber(payload, "timeout"),
				});
				return value === undefined ? { cancelled: true } : { value };
			}
			case "editor": {
				const title = getPayloadString(payload, "title");
				if (!title) {
					return { cancelled: true };
				}
				const value = await this.showExtensionEditor(title, getPayloadString(payload, "prefill"));
				return value === undefined ? { cancelled: true } : { value };
			}
			case "notify": {
				const message = getPayloadString(payload, "message");
				if (message) {
					this.showExtensionNotify(message, getPayloadNotifyType(payload, "notifyType"));
				}
				return undefined;
			}
			case "setStatus": {
				const key = getPayloadString(payload, "statusKey");
				if (key) {
					this.setExtensionStatus(key, getPayloadString(payload, "statusText"));
				}
				return undefined;
			}
			case "setWorkingMessage": {
				this.workingMessage = getPayloadString(payload, "message");
				if (this.loadingAnimation) {
					this.updateWorkingLoaderMessage();
				}
				return undefined;
			}
			case "setWorkingVisible": {
				const visible = getPayloadBoolean(payload, "visible");
				if (visible !== undefined) {
					this.setWorkingVisible(visible);
				}
				return undefined;
			}
			case "setWorkingIndicator": {
				this.setWorkingIndicator(getPayloadWorkingIndicatorOptions(payload, "options"));
				return undefined;
			}
			case "setHiddenThinkingLabel": {
				this.setHiddenThinkingLabel(getPayloadString(payload, "label"));
				return undefined;
			}
			case "setWidget": {
				const key = getPayloadString(payload, "widgetKey");
				if (key) {
					const placement = getPayloadWidgetPlacement(payload, "widgetPlacement");
					this.setExtensionWidget(
						key,
						getPayloadStringArray(payload, "widgetLines"),
						placement ? { placement } : undefined,
					);
				}
				return undefined;
			}
			case "setTitle": {
				const title = getPayloadString(payload, "title");
				if (title) {
					this.ui.terminal.setTitle(title);
				}
				return undefined;
			}
			case "setEditorText": {
				const text = getPayloadString(payload, "text");
				if (text !== undefined) {
					this.editor.setText(text);
				}
				return undefined;
			}
			default:
				this.showStatus(`扩展请求了不支持的界面操作：${request.method}`);
				return undefined;
		}
	}

	private async handleEvent(event: AgentConnectionSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();
		this.updateConnectionStateFromEvent(event);
		// A new user message resets the activity tracker to 0, so the in-flight baseline must
		// reset with it. (agent_start on auto-retry does not reset the tracker.)
		if (event.type === "message_start") {
			this.prepareFeatureHintRun(event.message);
		}
		if (event.type === "message_start" && (event.message.role === "user" || isAgentSessionMessage(event.message))) {
			this.contextUsageTokenBaseline = 0;
			this.clearShortcutGuide();
			this.agentRunFileChanges.clear();
			this.renderRecap();
		}
		this.activityTracker.handleEvent(event);
		this.updateWorkingLoaderMessage();
		if (this.stallActionBar !== undefined && STALL_QUIET_ENDING_EVENTS.has(event.type)) {
			this.stallActionBarActivityAt ??= Date.now();
		}

		switch (event.type) {
			case "agent_start":
				this.agentRunStartedAt = Date.now();
				this.featureHintRunPending = this.getRetryAttempt() === 0;
				this.resetPendingToolState();
				this.renderRecap();
				// The queued-messages footer offers Enter-to-send only while idle, so
				// refresh it on the idle -> streaming transition too.
				this.updatePendingMessagesDisplay();
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				// A new agent run starts a fresh turn group here — and only here:
				// mid-turn remounts (returning from the agents view, re-attach)
				// route through startWorkingLoader without this edge and must keep
				// the in-flight group intact (K3-2 remount finding). The settled
				// summary line of the previous run stays in the chat as history.
				this.currentTurnState = undefined;
				this.currentTurnSummary = undefined;
				this.stopWorkingLoader();
				if (this.workingVisible) {
					this.startWorkingLoader();
				}
				this.ui.requestRender();
				break;

			case "session_action_update": {
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;
			}

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				// The footer watermark carries the model · thinking level now;
				// the invalidation repaints the footer itself.
				this.invalidateFooterTelemetry();
				this.updateEditorBorderColor();
				break;

			case "service_tier_changed":
				this.footer.invalidate();
				break;

			case "bash_start": {
				if (this.sideQuestionBashDiscarded !== undefined) {
					if (event.runId === this.sideQuestionBashDiscarded) {
						// The discarded side run now owns the bash slot. Abort only
						// after matching its identity so a foreign run is never killed.
						void this.agentConnection.abortBash().catch(() => undefined);
						break;
					}
					// A different run claimed the slot, so the discarded run lost the
					// race and can never start (its execute_bash will reject); render
					// this run normally instead of swallowing it.
					this.sideQuestionBashDiscarded = undefined;
				}
				const ownSideBash = this.sideQuestionBash !== undefined && event.runId === this.sideQuestionBash.runId;
				if (event.transient && !ownSideBash) {
					// Another client's side-conversation run: it renders only in that
					// client's pane, never in this window's chat.
					break;
				}
				const component = new BashExecutionComponent(event.command, this.ui, event.excludeFromContext, {
					suppressLeadingSpace: this.chatContainer.children.at(-1) instanceof AgentMessageComponent,
				});
				if (ownSideBash && this.sideQuestionComponent) {
					// Same component as the main thread, mounted inside the pane.
					this.sideQuestionComponent.addBash(component);
					this.sideQuestionBashComponent = component;
				} else if (this.isAgentStreaming()) {
					this.pendingMessagesContainer.addChild(component);
					this.pendingBashComponents.push(component);
				} else {
					this.chatContainer.addChild(component);
				}
				this.activeBashComponent = component;
				this.ui.requestRender();
				break;
			}

			case "bash_output":
				if (this.sideQuestionBashDiscarded !== undefined) {
					break;
				}
				if (this.activeBashComponent) {
					this.activeBashComponent.appendOutput(event.chunk);
					this.ui.requestRender();
				}
				break;

			case "bash_end": {
				if (this.sideQuestionBashDiscarded !== undefined) {
					// Only the discarded run's own end consumes the marker; bash_start
					// already cleared it for any other run that claimed the slot.
					this.sideQuestionBashDiscarded = undefined;
					this.activeBashComponent = undefined;
					this.ui.requestRender();
					break;
				}
				const component = this.activeBashComponent;
				if (component) {
					if (event.errorMessage) {
						component.setFailed(event.errorMessage);
					} else {
						component.setComplete(
							event.exitCode,
							event.cancelled,
							event.truncated ? ({ truncated: true } as TruncationResult) : undefined,
							event.fullOutputPath,
						);
					}
					this.activeBashComponent = undefined;
				} else if (event.errorMessage && !event.transient) {
					// Transient failures surface in the owning client's pane, not here.
					this.showError(`命令执行失败：${event.errorMessage}`);
				}
				// Seed the side transcript only when our own pane-mounted run ended.
				if (component !== undefined && component === this.sideQuestionBashComponent) {
					this.sideQuestionBashComponent = undefined;
					this.finishSideQuestionBash(event, component.getOutput());
				}
				this.ui.requestRender();
				break;
			}

			case "message_start":
				// The run's first starter anchors the elapsed display; mid-turn steering must not restart it.
				if (this.turnStartedAt === undefined && startsAgentRun(event.message)) {
					// A queued follow-up carries the time it was typed; its run starts
					// when the agent picks it up, not while the previous run was going.
					const anchor = Math.max(event.message.timestamp, this.agentRunStartedAt ?? 0);
					this.turnStartedAt = anchor;
					if (this.workingStartedAt !== undefined) {
						this.workingStartedAt = anchor;
						this.updateWorkingLoaderMessage();
					}
				}
				if (event.message.role === "custom") {
					if (isSessionSlashCommandMessage(event.message) && event.message.details.command.name === "refine") {
						this.startRefineLoader();
					}
					// A fallback transition (a return to the primary, a routed image handed
					// back) moved the serving model without a model_select: repaint the footer.
					if (event.message.customType === PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE) void this.refreshServingModel();
					// The /refine result row is the user refine's settle edge; refine_complete
					// alone can belong to an agent/auto refinement the queued /refine waited on.
					if (
						isSessionSlashCommandResultMessage(event.message) &&
						event.message.details.command.name === "refine"
					) {
						this.stopRefineLoader();
					}
					// TUI v4: a received agent-message row is one comm in this turn.
					// A steering comm resets the turn group before the new summary
					// exists (lazy creation), so fall back to the latest turn - the
					// rebuild path counts the same row into the same turn span,
					// keeping the live and replay comm counts equal (T6).
					if (isAgentSessionMessage(event.message) && event.message.display) {
						(this.currentTurnSummary ?? this.latestTurnSummary())?.addCommMessage();
					}
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.noticeImageModelServing(event.message);
					// U6: the turn's aggregate line is created at the turn head,
					// before the first streaming assistant component.
					this.ensureCurrentTurnSummary();
					this.currentTurnState?.setLiveThinkingSegments(countThinkingSegments(event.message));
					if (this.currentTurnState) {
						// v3: the header names the model; until the first token arrives the
						// card says it is waiting for the reply.
						this.currentTurnState.modelId = event.message.model || this.currentTurnState.modelId;
						this.currentTurnState.notePhase("waiting");
					}
					this.startAssistantStreamingMessage(event.message);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.ensureAssistantStreamingComponent(event.message).updateContent(this.streamingMessage, true);
					this.currentTurnState?.setLiveThinkingSegments(countThinkingSegments(event.message));
					if (this.currentTurnState) {
						const kind = event.assistantMessageEvent.type;
						if (kind === "thinking_start" || kind === "thinking_delta") {
							this.currentTurnState.noteThinking(true);
						} else if (kind === "thinking_end" || kind === "text_start" || kind === "toolcall_start") {
							this.currentTurnState.noteThinking(false);
						}
						// v3: the running card names the model's phase.
						if (kind === "thinking_start" || kind === "thinking_delta") {
							this.currentTurnState.notePhase("thinking");
						} else if (kind === "text_start" || kind === "text_delta") {
							this.currentTurnState.notePhase("writing");
						} else if (kind === "toolcall_start" || kind === "toolcall_delta") {
							this.currentTurnState.notePhase("waiting");
						} else {
							this.currentTurnState.noteActivity();
						}
						const thinking = latestThinkingText(event.message);
						this.currentTurnState.latestThinking = thinking || this.currentTurnState.latestThinking;
						this.currentTurnState.currentThinking = thinking;
					}

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							await this.getOrCreatePendingToolComponent(content);
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (event.message.role === "assistant") {
					// Each landed assistant message grows the mother's own usage, i.e. the
					// secondary "总" figure; throttled, so this stays cheap mid-turn.
					this.scheduleSubagentSpendRefresh();
					// U6: the landed message's thinking blocks settle into the turn count.
					if (this.currentTurnState) {
						this.currentTurnState.addThinkingSegments(countThinkingSegments(event.message));
						this.currentTurnState.setLiveThinkingSegments(0);
						this.currentTurnState.noteThinking(false);
						this.currentTurnState.notePhase("waiting");
					}
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.getRetryAttempt();
						const elapsedSuffix =
							this.workingStartedAt === undefined
								? ""
								: ` · ${this.formatWorkingElapsed(Date.now() - this.workingStartedAt)}`;
						errorMessage =
							retryAttempt > 0 ? `重试 ${retryAttempt} 次后已中断${elapsedSuffix}` : `已中断${elapsedSuffix}`;
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.ensureAssistantStreamingComponent(event.message).updateContent(this.streamingMessage, false);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						// P1-B (Qwen review): a message that dies mid-turn leaves its
						// steps "running" forever in the live path (the replay marks
						// them error from stopReason) - the ⚙ line never settles and
						// the live tool rows stay unfolded. Mark every still-pending
						// step error so the aggregate ends with ✗N, exactly like the
						// replay face, and stamp the turn's clock.
						const endedAt = Number(event.message.timestamp) || Date.now();
						for (const step of this.currentTurnState?.steps ?? []) {
							if (step.status === "queued" || step.status === "running") {
								this.currentTurnState?.setStepStatus(step.toolCallId, "error", endedAt);
							}
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.currentTurnState?.markTurnEnded(endedAt);
						this.resetPendingToolState();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.recordSpeedSample(event.message);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
					this.invalidateFooterTelemetry();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				this.startedToolCalls.add(event.toolCallId);
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = await this.getOrCreatePendingToolComponent({
						id: event.toolCallId,
						name: event.toolName,
						arguments: event.args,
					});
				}
				if (component) {
					component.markExecutionStarted();
				}
				// The start event carries the complete arguments; streaming may have left partial ones.
				this.currentTurnState?.updateStepArgs(event.toolCallId, event.args);
				this.currentTurnState?.markRunning(event.toolCallId);
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				// Fresh output: the running card's quiet clock restarts.
				this.currentTurnState?.noteActivity();
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.startedToolCalls.delete(event.toolCallId);
					this.currentTurnState?.setStepStatus(event.toolCallId, event.isError ? "error" : "done");
					this.recordTurnFileChanges(this.currentTurnState, event.toolCallId, {
						details: event.result?.details,
						isError: event.isError,
					});
				}
				// U2: consecutive tool errors; a success resets the streak. Counted
				// outside the component lookup: an unknown id still settled a tool.
				this.consecutiveToolErrors = event.isError ? this.consecutiveToolErrors + 1 : 0;
				this.footer?.setToolErrorCount?.(this.consecutiveToolErrors);
				this.ui.requestRender();
				break;
			}

			case "ipython_sent_agent_message": {
				const messages = this.lateIpythonSentAgentMessages.get(event.toolCallId) ?? [];
				if (!messages.some((message) => message.id === event.message.id)) {
					messages.push(event.message);
					this.lateIpythonSentAgentMessages.set(event.toolCallId, messages);
					// TUI v4: a newly sent agent message is one comm in this turn.
					this.currentTurnSummary?.addCommMessage();
				}
				this.ipythonToolComponents.get(event.toolCallId)?.appendSentAgentMessage(event.message);
				this.ui.requestRender();
				break;
			}

			case "turn_end":
				mergeTurnFileChanges(this.agentRunFileChanges, event.message, event.toolResults, this.getCurrentCwd());
				// The warning's turn is over: a stalled turn emits no turn_end, so one
				// arriving while a bar is live means the turn recovered and finished.
				// The bar's "interrupt this turn" now refers to a turn that already
				// ended and its diagnostics captured that turn's snapshot, so it goes
				// with the turn - the same reasoning as agent_end below (blind3 7 / the
				// joint fix draft's N4, which takes both teardown points). The next
				// turn that stalls mounts a fresh bar: teardown is not a latch.
				// v3: it settles instead of vanishing, so its diagnostics key keeps working.
				this.settleStallActionBar();
				break;

			case "agent_end":
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				this.turnStartedAt = undefined;
				// The run is over; a thinking-only turn's clock stops here (a tool
				// turn already froze on its last settled step).
				this.currentTurnState?.markTurnEnded(Date.now());
				// Drops the loader; background subagents are shown by the tree, not the loader.
				this.syncWorkingLoader();
				if (this.streamingComponent) {
					if (this.streamingMessage) {
						this.streamingComponent.updateContent(this.streamingMessage, false);
					} else {
						this.chatContainer.removeChild(this.streamingComponent);
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				// A live stall bar promises "interrupt this turn" - an action that
				// can no longer happen once the turn is over. The daemon's recovery
				// abort and a naturally finished turn both land here, and neither
				// emits a terminal stall stage by itself, so this is the teardown
				// the bar actually depends on (blind2 F6 / blind3 7). The bar's
				// input route goes with it. A render is already requested at the
				// end of this case, so the teardown skips its own.
				// v3: settled, not removed - the diagnostics key keeps working.
				this.settleStallActionBar({ render: false });
				this.flushPendingBashComponents();
				this.resetPendingToolState();
				this.renderRecap();
				// The queued-messages footer offers Enter-to-send only while idle, so
				// refresh it on the streaming -> idle transition.
				this.updatePendingMessagesDisplay();

				this.applyOptimisticContextUsage();
				// Auto-compaction can start server-side while this event is being handled.
				// Do not hold its start event behind a stats RPC; stale refreshes are discarded.
				void this.refreshConnectionContextUsage();
				// Turn end is when child usage attributions settle; refresh the spend
				// cell now instead of waiting out the activity throttle.
				this.scheduleSubagentSpendRefresh(true);

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "compaction_start": {
				this.startCompactionLoader(event.reason, event.customInstructions);
				// The queue header now reads "compacting context"; repaint it without
				// touching statusContainer (the loader). Only queuedMessagesContainer changes.
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				// Restore the working loader if streaming/subagents still warrant it.
				this.syncWorkingLoader();
				if (event.aborted) {
					if (event.reason === "manual") this.showError("已取消压缩");
				} else if (event.result) {
					try {
						await this.rebuildChatFromMessages();
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						this.showError(`压缩完成，但对话没能刷新：${message}`);
					}
					await this.refreshConnectionContextUsage();
					this.footer.invalidate();
				} else if (event.errorMessage && event.reason === "manual") {
					if (event.errorSeverity === "warning") this.showWarning(event.errorMessage);
					else this.showError(event.errorMessage);
				}
				// Drop the "compacting context" queue header now that compaction is over.
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				this.stopWorkingLoader();
				this.statusContainer.clear();
				this.retryCountdown?.dispose();
				this.pendingModelFallbackNotice =
					event.reason === "backup" && event.backupModel
						? `已自动切换到 ${event.backupModel.split("/").pop()}（原因：${event.errorMessage}）`
						: undefined;
				// The switch already happened on the session: the footer names the model now serving.
				if (event.reason === "backup") void this.refreshServingModel();
				const cancelKey = keyText("app.clear");
				const retryMessage = (seconds: number) => {
					const cancel = cancelKey ? `（${cancelKey} 取消）` : "";
					if (event.reason === "backup" && event.backupModel) {
						return `已自动切换到 ${event.backupModel.split("/").pop()}，马上重试${cancel}`;
					}
					if (event.reason === "unavailable" && event.delayMs >= 60_000) {
						return `所有模型暂时不可用，${Math.ceil(seconds / 60)} 分钟后再试（第 ${event.attempt} 轮）${cancel}`;
					}
					if (event.reason === "usage") {
						return `额度用完或被限流，${seconds} 秒后再试（第 ${event.attempt} 次）${cancel}`;
					}
					return `服务器出错，第 ${event.attempt} 次重试，等 ${seconds} 秒${cancel}`;
				};
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("muted", spinner),
					(text) => theme.fg("muted", text),
					retryMessage(Math.ceil(event.delayMs / 1000)),
				);
				this.retryCountdown = new CountdownTimer(
					event.delayMs,
					this.ui,
					(seconds) => {
						this.retryLoader?.setMessage(retryMessage(seconds));
					},
					() => {
						this.retryCountdown = undefined;
					},
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Restore the working loader if streaming/subagents still warrant it.
				this.syncWorkingLoader();
				// A model switch stays visible as one dim row once the turn goes on.
				const fallbackNotice = this.pendingModelFallbackNotice;
				this.pendingModelFallbackNotice = undefined;
				if (event.success && fallbackNotice) {
					this.showStatus(fallbackNotice);
				}
				// A retry can end on another model (a backup restored, a chain switch that
				// failed over again): the footer follows whatever serves now.
				void this.refreshServingModel();
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`重试 ${event.attempt} 次后仍失败：${event.finalError || "未知错误"}`);
				}
				this.ui.requestRender();
				break;
			}

			case "auth_stale": {
				this.applyAuthStaleEvent(event);
				this.ui.requestRender();
				break;
			}

			case "rlm_child_update":
				this.updateSubagentSummary(event.child);
				break;

			case "goal_update":
				this.handleGoalUpdate(event.goal);
				break;

			case "refine_failed":
				// This event has no request identity; the matching command result settles its loader.
				this.showError(`经验沉淀失败：${event.error}`);
				break;

			case "session_persist_failed":
				this.showError(`会话保存失败：${event.error}`);
				break;

			case "rlm_terminal_notice_abandoned":
				// A child's terminal report could not be delivered through the queue.
				// Failure notices were written into the transcript instead of dropped;
				// routine notices were abandoned so the session stays evictable.
				this.showError(
					`Subagent terminal notices could not be delivered: ${event.persistedToTranscript} written to the transcript, ${event.abandoned} abandoned after ${Math.round(event.deferredMs / 1000)}s.`,
				);
				break;

			case "stall_warning": {
				// The event carries the full forensic snapshot; the message alone tells the
				// operator that something was silent but not what to interrupt or where to look.
				// The forensic text stays on the loud channel; the action bar (r4
				// recovery-shell) adds the actionable strip on top of it - it never
				// re-reports the message text, so the two channels cannot double-report
				// (B3), and a bar that cannot mount leaves exactly the old behavior.
				// The action bar is the notice: one plain line plus the keys. The forensic
				// lines stay one key away (stall diagnostics); only a host where the bar
				// cannot mount prints the summary line into the chat instead.
				if (!this.mountStallActionBar(event)) this.showWarning(formatStallSummary(event));
				break;
			}

			case "stall_abort":
				// S1: the turn is dead, there is no action left to offer - never a
				// bar, and any live one is torn down so it stops promising an
				// interrupt that can no longer happen.
				this.removeStallActionBar();
				this.showError(`${formatStallSummary(event)}\n  ${stallEvidenceHint()}`);
				break;

			case "stall_unsettled":
				// "Killed but still running" is a different failure than "looks
				// stuck": it needs the same loud channel, not a warning color.
				this.removeStallActionBar();
				this.showError(`${formatStallSummary(event)}\n  ${stallEvidenceHint()}`);
				break;

			case "refine_complete":
				break;
		}

		// A long session must not grow the component tree without bound; at settle
		// points over the cap this rebuilds through the initial-render window.
		await this.enforceChatComponentCap();
	}

	private startAssistantStreamingMessage(message: AssistantMessage): void {
		// An empty-turn retry emits a fresh message_start per attempt and no message_end
		// for the dropped one. Both message_end and agent_end clear streamingComponent,
		// so a live component here is always an unmatched start for a message that was
		// popped and never persisted: drop it instead of settling it into a bubble that
		// /resume would not show. Both fields are reassigned below, so there is nothing
		// to clear here.
		if (this.streamingComponent) {
			this.chatContainer.removeChild(this.streamingComponent);
		}
		this.streamingComponent = new AssistantMessageComponent(
			undefined,
			this.hideThinkingBlock,
			this.getMarkdownThemeWithSettings(),
			this.hiddenThinkingLabel,
			{
				// The live turn's own lanes (K3 ②), falling back to the globals.
				expanded: this.currentTurnState ? !this.currentTurnState.isCollapsed : this.toolOutputExpanded,
				thinkingExpanded: this.currentTurnState?.thinkingExpanded ?? this.thinkingExpanded,
				precededByToolActivity:
					this.chatContainer.children.at(-1) instanceof ToolExecutionComponent ||
					this.chatContainer.children.at(-1) instanceof AgentMessageComponent,
				mermaidTransform: this.mermaidMarkdownTransform,
				cwd: this.getCurrentCwd(),
				// TUI v4: quiet folds live intermediate narration into the turn stats.
				quiet: this.settingsManager.getProcessMode() === "quiet",
			},
		);
		this.streamingMessage = message;
		this.chatContainer.addChild(this.streamingComponent);
		this.streamingComponent.updateContent(this.streamingMessage, true);
	}

	private ensureAssistantStreamingComponent(message: AssistantMessage): AssistantMessageComponent {
		let component = this.streamingComponent;
		if (!component) {
			this.startAssistantStreamingMessage(message);
			component = this.streamingComponent;
		}
		if (!component) {
			throw new Error("Failed to create assistant streaming component");
		}
		return component;
	}

	private handleGoalUpdate(goal: GoalState): void {
		this.syncGoalTray(goal);
		if (this.shouldAnnounceGoalUpdate(goal)) {
			this.showStatus(this.formatGoalStatus(goal));
		} else {
			this.ui.requestRender();
		}
	}

	private syncGoalTray(goal: GoalState): void {
		// The goal label rides the uncached tray info line; a frame request
		// repaints it, no cache to drop.
		this.updateGoalTrayTimer(goal);
	}

	private updateGoalTrayTimer(goal: GoalState): void {
		if (goal.status === "active") {
			if (!this.goalTrayTimer) {
				this.goalTrayTimer = setInterval(() => {
					this.ui.requestRender();
				}, 1000);
				this.goalTrayTimer.unref?.();
			}
			return;
		}
		this.stopGoalTrayTimer();
	}

	private stopGoalTrayTimer(): void {
		if (!this.goalTrayTimer) {
			return;
		}
		clearInterval(this.goalTrayTimer);
		this.goalTrayTimer = undefined;
	}

	private setGoalAnnouncementBaseline(goal: GoalState): void {
		this.lastGoalAnnouncement = this.goalAnnouncementSnapshot(goal);
	}

	private goalAnnouncementSnapshot(goal: GoalState): GoalAnnouncementSnapshot {
		return {
			goalId: goal.goalId,
			status: goal.status,
			objective: goal.objective,
			lastReason: goal.lastReason,
			lastError: goal.lastError,
		};
	}

	private shouldAnnounceGoalUpdate(goal: GoalState): boolean {
		const previous = this.lastGoalAnnouncement;
		const next = this.goalAnnouncementSnapshot(goal);
		this.lastGoalAnnouncement = next;
		if (!previous) {
			return goal.status !== "idle";
		}
		if (previous.status !== next.status) {
			return true;
		}
		if (previous.goalId !== next.goalId) {
			return goal.status !== "idle";
		}
		switch (goal.status) {
			case "active":
				return false;
			case "paused":
			case "budget_limited":
			case "complete":
				return previous.lastReason !== next.lastReason;
			case "error":
				return previous.lastError !== next.lastError;
			case "idle":
				return false;
			default: {
				const _exhaustive: never = goal.status;
				return _exhaustive;
			}
		}
	}

	private formatGoalStatus(goal: GoalState): string {
		const usage = formatGoalUsage(goal);
		const usageText = usage ? ` (${usage})` : "";
		switch (goal.status) {
			case "idle":
				return "No active goal";
			case "active":
				return goal.objective
					? `Goal${this.formatGoalDetailSuffix(goal.objective, visibleWidth("Goal"))}`
					: "Pursuing goal";
			case "paused":
				return goal.lastReason
					? `Goal paused${this.formatGoalDetailSuffix(goal.lastReason, visibleWidth("Goal paused"))}`
					: "Goal paused (/goal resume)";
			case "budget_limited":
				if (goal.lastReason) {
					const prefix = `Goal budget limited${usageText}`;
					return prefix + this.formatGoalDetailSuffix(goal.lastReason, visibleWidth(prefix));
				}
				return `Goal budget limited${usageText}`;
			case "complete":
				return goal.lastReason
					? `Goal complete${this.formatGoalDetailSuffix(goal.lastReason, visibleWidth("Goal complete"))}`
					: "Goal complete";
			case "error":
				return goal.lastError
					? `Goal error${this.formatGoalDetailSuffix(goal.lastError, visibleWidth("Goal error"))}`
					: "Goal error";
			default: {
				const _exhaustive: never = goal.status;
				return _exhaustive;
			}
		}
	}

	private formatGoalDetailSuffix(value: string | undefined, prefixWidth: number): string {
		const detail = value?.replace(/\s+/g, " ").trim();
		if (!detail) {
			return "";
		}
		const availableWidth = Math.min(120, Math.max(1, this.ui.terminal.columns - prefixWidth - 2));
		if (availableWidth < 8) {
			return "";
		}
		return `: ${truncateToWidth(detail, availableWidth)}`;
	}

	private seedSubagentSummary(children: readonly AgentConnectionRlmChildAgentSnapshot[] | undefined): void {
		for (const child of children ?? []) {
			// Live updates can arrive before the initial snapshot; do not replace them
			// with the snapshot's older state.
			if (!this.subagentSnapshots.has(child.id) && child.status !== "cancelled") {
				this.subagentSnapshots.set(child.id, child);
			}
		}
		this.refreshSubagentSummary();
	}

	private replaceSubagentSummary(children: readonly AgentConnectionRlmChildAgentSnapshot[] | undefined): void {
		const next = new Map<string, AgentConnectionRlmChildAgentSnapshot>();
		for (const child of children ?? []) {
			if (child.status === "cancelled") continue;
			const previous = this.subagentSnapshots.get(child.id);
			next.set(child.id, previous ? mergeSubagentSnapshot(previous, child) : child);
		}
		this.subagentSnapshots = next;
		this.refreshSubagentSummary();
	}

	private updateSubagentSummary(child: AgentConnectionRlmChildAgentSnapshot): void {
		// "cancelled" also covers never-bound terminal runs; AgentSession owns that rule.
		if (child.status === "cancelled") {
			this.removeSubagentSnapshot(child.id);
		} else {
			const previous = this.subagentSnapshots.get(child.id);
			this.subagentSnapshots.set(child.id, previous ? mergeSubagentSnapshot(previous, child) : child);
		}
		this.refreshSubagentSummary();
	}

	private refreshSubagentSummary(): void {
		this.scheduleHeartbeatManagerRefresh();
		this.updateSubagentSummaryLine();
		this.updateWorkingPulse();
		this.syncWorkingLoader();
		this.updateWorkingLoaderMessage();
		this.ui.requestRender();
	}

	private updateSubagentSummaryLine(): void {
		const rosterSummaries = this.rosterBar?.summaries();
		// A client-owned session has no row on the public roster; only then do the
		// snapshots carry the bar. A public parent with zero roster children shows zero.
		const sessionOnRoster =
			rosterSummaries?.some((row) => row.sessionId === this.connectionState?.sessionId) === true;
		const counts =
			rosterSummaries && sessionOnRoster
				? countRosterSubagentStatuses(rosterSummaries, {
						activeSessionId: this.connectionState?.activeSessionId,
						sessionId: this.connectionState?.sessionId,
						sessionFile: this.connectionState?.sessionFile,
					})
				: countSubtreeSubagentStatuses(this.subagentSnapshots.values(), this.rlmNodeId);
		this.subagentCounts = counts;
		this.subagentSummaryLine.setSubagentCounts(counts);
		// The spend cell rides the same counts, but it is NOT refreshed from here. It is
		// computed from the context tree, which is a disk-scanning RPC, and this line runs
		// on every child update, roster republish, heartbeat catalog change and resync: a
		// working family therefore used to queue a tree scan behind every event burst -
		// and, on a daemon-hosted session, do it on the daemon's event loop, where it
		// delayed the roster/snapshot RPCs the agents view needs. Updates now only keep
		// the cell's cadence in step with what is on screen (see syncSubagentSpendCell);
		// the figure moves when an assistant message lands, when the turn ends, and on the
		// idle tick.
		this.syncSubagentSpendCell();
		// A stalled child still counts as running, so the stall has to be visible on
		// its own line or a wedged subagent reads as progress. Same subtree as the
		// counts: a wedge anywhere in the family must not need a direct-child slot.
		const stallMarkers: string[] = [];
		for (const child of collectSubtreeSubagentSnapshots(this.subagentSnapshots.values(), this.rlmNodeId)) {
			const marker = formatSubagentStallMarker(child);
			if (marker) stallMarkers.push(`${child.sessionName ?? child.label}: ${marker}`);
		}
		this.subagentSummaryLine.setStallMarkers(stallMarkers);
		this.subagentSummaryLine.setSubagentRows(
			buildSubagentPanelRows(this.subagentSnapshots.values(), this.rlmNodeId, this.seenSubagentFailureIds),
		);
		if (!this.subagentSummaryLine.isSelectable() && this.subagentSummaryLine.focused) this.focusEditor();
	}

	/**
	 * Event-driven refresh of the spend cell. The context tree is an async,
	 * disk-scanning RPC, so it is never awaited in a render path: events schedule
	 * a scan, the scan lands its figure on the component, and a render follows.
	 *
	 * Scheduling: a burst gets one leading scan after the debounce; further scans
	 * hold to the min interval (a heavy last scan backs it off further), so a busy
	 * roster reads real bytes at most once per interval; a forced refresh (turn
	 * end) fires immediately, bypassing both. Without sub-agents the cell is
	 * blank, not ¥0.00, and a quiet family arms no timer at all.
	 */
	private scheduleSubagentSpendRefresh(force = false): void {
		if (!this.isSubagentSpendCellVisible()) {
			// Nothing on screen to fill (no family, the cell switched off, or the terminal
			// suspended): a scan here would be spent on a figure nobody can see.
			this.clearSubagentSpendRefresh();
			this.subagentSummaryLine.setSubagentSpend(undefined);
			return;
		}
		const now = Date.now();
		// Leading debounce: a burst gets one scan ~500ms after it starts. The floor
		// holds sustained bursts to one scan per interval, and a heavy last scan
		// backs the interval off (see the constants above), so the worst families
		// pay for their size in freshness, not in worker event-loop stalls. A
		// forced request (turn end) bypasses both the debounce and the floor.
		const interval =
			this.subagentSpendLastScanMs > SUBAGENT_SPEND_HEAVY_SCAN_MS
				? SUBAGENT_SPEND_HEAVY_INTERVAL_MS
				: SUBAGENT_SPEND_MIN_INTERVAL_MS;
		const deadline = force
			? now
			: this.subagentSpendLastScanAt > 0
				? Math.max(now + SUBAGENT_SPEND_DEBOUNCE_MS, this.subagentSpendLastScanAt + interval)
				: now + SUBAGENT_SPEND_DEBOUNCE_MS;
		if (this.subagentSpendTimer !== undefined && this.subagentSpendTimerDeadline <= deadline) return;
		this.clearSubagentSpendRefresh();
		this.subagentSpendTimerDeadline = deadline;
		this.subagentSpendTimerForced = force;
		this.subagentSpendTimer = setTimeout(
			() => {
				this.subagentSpendTimer = undefined;
				// The deadline is the moment this refresh was aiming for: a shared scan that
				// lands at or after it is this refresh's scan, which is what keeps a turn end
				// (header refresh plus this forced one) at a single context-tree scan.
				const notBefore = this.subagentSpendTimerDeadline;
				this.subagentSpendTimerDeadline = 0;
				const forced = this.subagentSpendTimerForced;
				this.subagentSpendTimerForced = false;
				void this.refreshSubagentSpend(forced, notBefore);
			},
			Math.max(0, deadline - now),
		);
		this.subagentSpendTimer.unref?.();
		// A refresh that is worth scheduling is also the moment to make sure the idle
		// tick is running: it is what keeps the figure moving between events.
		this.startSubagentSpendIdleTick();
	}

	/**
	 * Whether the spend cell is on screen right now: the user left it enabled, the
	 * session has a sub-agent family to total up, and the terminal is not suspended.
	 */
	private isSubagentSpendCellVisible(): boolean {
		return (
			!this.terminalSuspended && this.subagentCounts.total > 0 && this.settingsManager.getSubagentSpendCellEnabled()
		);
	}

	/**
	 * Keep the cell's cadence in step with whether it is on screen.
	 *
	 * Called from every path that can change the answer (counts, the setting, the
	 * terminal moving in and out of suspension), and cheap on purpose: it arms the idle
	 * tick when there is a cell to keep fresh, and tears the tick, the pending refresh
	 * and the figure down when there is not - a disabled or empty cell must not keep
	 * scanning, and must not leave a stale figure behind for the next family.
	 */
	private syncSubagentSpendCell(): void {
		if (!this.isSubagentSpendCellVisible()) {
			this.stopSubagentSpendIdleTick();
			this.clearSubagentSpendRefresh();
			this.subagentSummaryLine.setSubagentSpend(undefined);
			return;
		}
		const interval = this.subagentSpendIntervalMs();
		if (!this.hasSubagentSpendFigure()) {
			// First sight of a family: fill the cell in now instead of waiting out a tick.
			this.scheduleSubagentSpendRefresh();
		} else if (this.subagentSpendAgeMs() >= interval) {
			// The figure has outlived its cadence while events kept arriving - a long turn
			// with a working family. The next event is the natural moment to catch up, so
			// the age is reset here rather than waiting out the tick's phase: the staleness
			// bound stays one interval, and no second timer is added to get it. Forced,
			// because the age it has already reached is exactly what the debounce and the
			// floor exist to ration.
			this.scheduleSubagentSpendRefresh(true);
		}
		this.startSubagentSpendIdleTick(interval);
	}

	/** How stale the on-screen figure may get, in ms (`ui.subagentSpendCell.intervalMs`). */
	private subagentSpendIntervalMs(): number {
		const settings = this.settingsManager as { getSubagentSpendCellIntervalMs?: () => number };
		return settings.getSubagentSpendCellIntervalMs?.() ?? SUBAGENT_SPEND_IDLE_TICK_MS;
	}

	/** Age of the figure on screen, in ms; +Infinity when there is none. */
	private subagentSpendAgeMs(): number {
		if (!(this.subagentSpendLastScanAt > 0)) return Number.POSITIVE_INFINITY;
		return Math.max(0, Date.now() - this.subagentSpendLastScanAt);
	}

	/**
	 * Whether a figure is already on screen or a scan is on its way to one. Written so
	 * that a receiver without the spend fields yet (an instance built through the
	 * prototype) reads as "no figure" rather than as a scheduled one.
	 */
	private hasSubagentSpendFigure(): boolean {
		return (
			this.subagentSpendLastScanAt > 0 ||
			this.subagentSpendScanning === true ||
			this.subagentSpendTimer !== undefined
		);
	}

	private startSubagentSpendIdleTick(intervalMs = this.subagentSpendIntervalMs()): void {
		if (this.subagentSpendTickTimer !== undefined) {
			if (this.subagentSpendTickIntervalMs === intervalMs) return;
			// The configured cadence moved while a tick was armed: re-arm at the new one
			// instead of letting the old period outlive the settings change.
			this.stopSubagentSpendIdleTick();
		}
		this.subagentSpendTickIntervalMs = intervalMs;
		this.subagentSpendTickTimer = setInterval(() => {
			// Re-checked per tick: the setting can flip, the family can go away, and the
			// terminal can suspend between ticks, none of which needs its own teardown path.
			if (!this.isSubagentSpendCellVisible()) {
				this.stopSubagentSpendIdleTick();
				return;
			}
			void this.refreshSubagentSpend(false);
		}, intervalMs);
		// A freshness nicety, never a reason to hold the process open.
		this.subagentSpendTickTimer.unref?.();
	}

	private stopSubagentSpendIdleTick(): void {
		this.subagentSpendTickIntervalMs = 0;
		if (this.subagentSpendTickTimer === undefined) return;
		clearInterval(this.subagentSpendTickTimer);
		this.subagentSpendTickTimer = undefined;
	}

	private clearSubagentSpendRefresh(): void {
		if (this.subagentSpendTimer !== undefined) {
			clearTimeout(this.subagentSpendTimer);
			this.subagentSpendTimer = undefined;
		}
		this.subagentSpendTimerDeadline = 0;
		this.subagentSpendTimerForced = false;
		this.subagentSpendRescanRequested = false;
		this.subagentSpendRescanForced = false;
	}

	/**
	 * One context-tree scan behind the spend cell - shared with the top bar, so a scan
	 * either consumer already paid for answers both (see fetchSharedContextTree).
	 * A failure keeps the last good figure (a blank would read as "spent nothing")
	 * and never surfaces an error: the cell is best-effort, the /context command
	 * remains the authoritative view.
	 *
	 * `notBefore` is the moment this refresh was aiming for (the armed timer's
	 * deadline, or now for a tick): a shared scan that landed at or after it, or is
	 * still in flight, is this refresh's scan and no second one is started.
	 */
	private async refreshSubagentSpend(forced = false, notBefore = Date.now()): Promise<void> {
		if (!this.isSubagentSpendCellVisible()) {
			// The cell went off screen between the request and its turn (family finished,
			// setting switched off, terminal suspended): not a scan worth starting.
			return;
		}
		if (this.subagentSpendScanning) {
			// A request arrived mid-scan: rerun once it settles, preserving urgency
			// so a throttled follow-up never delays a turn-end refresh, while event
			// noise during a slow scan cannot chain back-to-back forced rescans.
			this.subagentSpendRescanRequested = true;
			this.subagentSpendRescanForced ||= forced;
			return;
		}
		this.subagentSpendScanning = true;
		try {
			const tree = await this.fetchSharedContextTree(notBefore);
			// The scan may have been the header's: the cadence then reads when that scan
			// landed and how heavy it was, not how long this caller waited for it.
			const share = this.contextTreeShareMemo();
			this.subagentSpendLastScanAt = share.at > 0 ? share.at : Date.now();
			this.subagentSpendLastScanMs = share.ms;
			const pricing = this.spendPricing();
			this.subagentSummaryLine.setSubagentSpend(
				summarizeSubagentSpend(tree, (model) => pricing.isPriced(model), pricing),
			);
			this.ui.requestRender();
		} catch {
			// Silent degrade: no data, no cell update.
		} finally {
			this.subagentSpendScanning = false;
			if (this.subagentSpendRescanRequested) {
				const rerunForced = this.subagentSpendRescanForced;
				this.subagentSpendRescanRequested = false;
				this.subagentSpendRescanForced = false;
				this.scheduleSubagentSpendRefresh(rerunForced);
			}
		}
	}

	/**
	 * The price book behind every spend figure in this mode: a model's
	 * `ui.subagentSpendCell.priceOverrides` correction wins field by field, and
	 * the `models.json` rate (through the registry) fills the rest. Rates are
	 * read per refresh, so an edited override lands on the next one.
	 */
	private spendPricing(): SpendPricing {
		return createSpendPricing({
			overrides: this.settingsManager.getSubagentSpendCellPriceOverrides(),
			ratesFor: (model) => this.modelRegistry.find(model.provider, model.id)?.cost,
		});
	}

	private removeSubagentSnapshot(id: string): void {
		this.subagentSnapshots.delete(id);
		for (const child of [...this.subagentSnapshots.values()]) {
			if (child.parentId === id) this.removeSubagentSnapshot(child.id);
		}
	}

	private resetSubagentSummary(): void {
		this.subagentSnapshots.clear();
		this.rlmNodeId = undefined;
		this.updateSubagentSummaryLine();
		this.scheduleHeartbeatManagerRefresh();
		// Clearing snapshots can drop the last running subagent; reconcile the
		// pulse and loader so neither lingers when nothing is in flight.
		this.updateWorkingPulse();
		this.syncWorkingLoader();
	}

	private focusEditor(): void {
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private focusSubagentSummary(): boolean {
		if (!this.subagentSummaryLine.isSelectable() || this.getTrayOverrideLabel()) return false;
		this.ui.setFocus(this.subagentSummaryLine);
		this.ui.requestRender();
		return true;
	}

	/**
	 * Enter on the subagent panel: straight into the selected child when it has a
	 * daemon session to attach to, else this session's children list.
	 */
	private async openScopedAgentsView(childActiveSessionId?: string, row?: SubagentPanelRow): Promise<void> {
		if (!this.options.returnToAgentsView) {
			this.focusEditor();
			this.showStatus("会话列表需要后台服务；不带 --no-daemon 启动才能浏览会话");
			return;
		}
		// The row's child identity rides along: a child the daemon closed after it sat
		// idle has no live session to attach to, and the agents view reopens it by it.
		const reopenable = row !== undefined && row.state !== "running" && row.state !== "stalled";
		await this.returnToAgentsView("scoped_agents_view", childActiveSessionId, {
			...(reopenable
				? { openChild: { childId: row.id, ...(row.sessionDir ? { sessionDir: row.sessionDir } : {}) } }
				: {}),
		});
	}

	/**
	 * The stop-all-subagents key: the first press names how many children it would
	 * stop, a second press within the window stops them. Esc is left alone on
	 * purpose - it interrupts this session's own turn, and a child the owner still
	 * wants keeps working.
	 */
	private async requestStopAllSubagents(): Promise<void> {
		const working = collectSubtreeSubagentSnapshots(this.subagentSnapshots.values(), this.rlmNodeId).filter(
			(child) => classifySubagentSnapshotStatus(child) === "running",
		);
		if (working.length === 0) {
			this.stopAllSubagentsArmedUntil = undefined;
			this.showStatus("现在没有在跑的子代理");
			return;
		}
		const now = Date.now();
		if (this.stopAllSubagentsArmedUntil === undefined || now > this.stopAllSubagentsArmedUntil) {
			this.stopAllSubagentsArmedUntil = now + STOP_ALL_SUBAGENTS_CONFIRM_WINDOW_MS;
			this.showStatus(
				`再按一次 ${keyText("app.subagents.stopAll")} 停止全部 ${working.length} 个在跑的子代理（做到一半的会停下，记录保留）`,
				"warning",
			);
			return;
		}
		this.stopAllSubagentsArmedUntil = undefined;
		const results = await Promise.allSettled(working.map((child) => this.agentConnection.cancelRlmChild(child.id)));
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length > 0) {
			const first = failures[0];
			const reason =
				first?.status === "rejected" && first.reason instanceof Error ? first.reason.message : "未知错误";
			this.showStatus(`有 ${failures.length} 个子代理没停下：${reason}`, "warning");
			return;
		}
		this.showStatus(`已停止全部 ${working.length} 个在跑的子代理`);
	}

	/**
	 * The daemon closed the subagent this window is attached to - its parent deleted
	 * it, it was stopped, or it finished and was closed. The window would otherwise
	 * sit on a dead session with an English daemon error; instead it goes back to the
	 * parent with a line saying what happened. Returns false when this is not that
	 * case, and the caller shows the connection's own error.
	 */
	private returnToParentAfterSubagentClosed(reason: AgentConnectionSessionClosedReason | undefined): boolean {
		if (!this.options.returnToAgentsView || (this.options.sessionDepth ?? 0) < 1) return false;
		let notice: string;
		if (reason === "killed") {
			notice = "刚才看的子代理已被停止或删除（记录还在），已回到父代理";
		} else if (reason === "completed") {
			notice =
				this.lastAssistantStopReason === "error"
					? "刚才看的子代理出错停下了，已关闭（记录还在），已回到父代理"
					: "刚才看的子代理已做完并关闭（记录还在），已回到父代理";
		} else {
			return false;
		}
		void this.returnToAgentsView("agents_view", undefined, { returnToParentNotice: notice });
		return true;
	}

	/** A failure notice this chat shows is one the parent has received: its row stops holding the panel open. */
	private noteSubagentFailureSeen(message: CustomMessage): void {
		if (message.customType !== RLM_CHILD_FAILURE_CUSTOM_TYPE) return;
		const childId = (message.details as { childId?: unknown } | undefined)?.childId;
		if (typeof childId !== "string" || this.seenSubagentFailureIds.has(childId)) return;
		this.seenSubagentFailureIds.add(childId);
		this.updateSubagentSummaryLine();
	}

	private handleSubagentSummaryChatAction(data: string): void {
		if (this.keybindings.matches(data, "app.tools.expand")) {
			this.toggleToolOutputExpansion();
			return;
		}
		if (this.keybindings.matches(data, "app.tools.expandAll")) {
			this.toggleToolOutputExpansion(true);
			return;
		}
		if (this.keybindings.matches(data, "app.tools.expandFull")) {
			this.toggleToolOutputFull();
			return;
		}
		if (this.keybindings.matches(data, "app.messages.expand")) {
			this.toggleAgentMessageExpansion();
			return;
		}
		if (this.keybindings.matches(data, "app.messages.expandAll")) {
			this.toggleAgentMessageExpansion(true);
			return;
		}
		// A raw "\n" is a newline for the editor, not ctrl+j.
		if (data !== "\n" && this.keybindings.matches(data, "app.edits.expand")) {
			this.toggleEditDiffExpansion();
			return;
		}
		if (this.keybindings.matches(data, "app.thinking.toggle")) {
			this.toggleThinkingBlockVisibility();
			return;
		}
		if (this.keybindings.matches(data, "app.thinking.toggleAll")) {
			this.toggleThinkingBlockVisibility(true);
			return;
		}
		this.focusEditor();
		this.editor.handleInput(data);
	}

	private getTrayOverrideLabel(): string | undefined {
		if (this.isCtrlCExitHintVisible()) {
			const clearKey = keyText("app.clear");
			return clearKey ? `再按一次 ${clearKey} 退出` : "再按一次退出";
		}
		// The first Esc on an idle empty prompt says what a second one would do.
		if (this.escapeRepeatAction === "tree" && !this.hasInterruptibleWork() && this.editor.getText().length === 0) {
			const escKey = keyText("app.input.clear", { primaryOnly: true });
			return `再按一次 ${escKey || "Esc"} 回退到之前的消息`;
		}
		const text = this.editor.getExpandedText?.() ?? this.editor.getText();
		if (!this.isAgentStreaming() || !text.trim()) {
			return undefined;
		}
		const followUp = keyText("app.message.followUp");
		return followUp ? `${followUp} 排队，本轮结束后发送` : undefined;
	}

	/** Hint line left side: goal, heartbeats, agent depth, and the context figures when the footer's are off. */
	private getTrayStatusLabel(): string | undefined {
		const hasChildren = this.options.sessionHasChildren === true || (this.subagentSnapshots?.size ?? 0) > 0;
		const depthLabel = formatAgentDepthLabel(this.options.sessionDepth, hasChildren);
		return (
			[this.getTrayGoalLabel(), this.getTrayHeartbeatLabel(), depthLabel, this.getTrayContextFallbackLabel()]
				.filter((label): label is string => label !== undefined && label.length > 0)
				.join(" · ") || undefined
		);
	}

	/** The keys that work right now, most useful first; the hint line drops them from the end. */
	private getTrayHints(): string[] {
		const hint = (keybinding: AppKeybinding, label: string): string | undefined => {
			const key = keyText(keybinding, { primaryOnly: true });
			return key ? `${key} ${label}` : undefined;
		};
		// ← only reaches the session list from an empty prompt; with text it moves the cursor.
		const promptEmpty = (this.editor.getExpandedText?.() ?? this.editor.getText()).length === 0;
		const agentsBack =
			this.options.returnToAgentsView && promptEmpty ? hint("app.agents.back", "会话列表") : undefined;
		const hints = this.isAgentStreaming()
			? [hint("app.input.clear", "中断"), hint("app.tools.expand", "过程"), hint("app.thinking.toggle", "Thinking")]
			: !this.isNewChat()
				? [
						hint("app.tools.expand", "过程"),
						hint("app.thinking.toggle", "Thinking"),
						agentsBack,
						hint("app.shortcuts", "快捷键"),
					]
				: ["/ 命令", "@ 文件", agentsBack, hint("app.shortcuts", "快捷键")];
		return hints.filter((entry): entry is string => entry !== undefined);
	}

	/** The splash's `上次` row: the last session in this directory, while the chat is still empty. */
	private getContinueMetadata(): BrandSplashMetadataLine[] {
		const recent = this.recentSession;
		if (!recent || !this.isNewChat()) return [];
		const open = this.options.returnToAgentsView ? keyText("app.agents.back", { primaryOnly: true }) : "";
		const how = open ? `${open} 打开会话列表` : "prime-agent --resume";
		return [{ label: "上次", value: `「${recent.title}」 ${formatAgo(recent.modified)} · ${how}` }];
	}

	private async loadRecentSession(): Promise<void> {
		try {
			this.recentSession = await findRecentSession(
				getSessionsDir(),
				this.getCurrentCwd(),
				this.connectionState?.sessionFile,
			);
			if (this.recentSession) this.ui.requestRender();
		} catch {
			// The row is optional; a scan failure leaves the splash as it was.
		}
	}

	private isNewChat(): boolean {
		return (this.connectionState?.messageCount ?? 0) === 0 && this.connectionState?.isStreaming !== true;
	}

	/**
	 * U6 ① right side: the context figures, only while the footer watermark is
	 * off. Reads the footer's own snapshot - not a fresh usage query - so the
	 * tray and the footer can never disagree (the boss's 478k vs 518k defect).
	 */
	private getTrayContextFallbackLabel(): string | undefined {
		// 评审②: reads the same memoized pair the footer line renders - one
		// frame, one value; the 478k-vs-518k double readout cannot recur.
		const source = this.getFooterTelemetrySource();
		if (source.mode !== "off") {
			return undefined;
		}
		const snapshot = source.snapshot;
		const tokens = snapshot?.contextTokens;
		const windowTokens = snapshot?.contextWindow ?? 0;
		if (!snapshot?.modelName || tokens == null || windowTokens <= 0) {
			return undefined;
		}
		return `${formatContextTokens(tokens, windowTokens)} (${Math.round((tokens / windowTokens) * 100)}%)`;
	}

	private getTrayHeartbeatLabel(): string | undefined {
		const heartbeats = this.getScopedHeartbeats();
		if (heartbeats.length === 0) {
			return undefined;
		}
		const paused = heartbeats.filter((heartbeat) => heartbeat.job.status === "paused").length;
		const count = `${heartbeats.length} heartbeat${heartbeats.length === 1 ? "" : "s"}`;
		const pausedLabel = paused ? ` · ${paused} paused` : "";
		const shortcut = keyText("app.heartbeats.open");
		return `${count}${pausedLabel}${shortcut ? ` (${shortcut})` : ""}`;
	}

	private getTrayGoalLabel(): string | undefined {
		const goal = this.getGoalState();
		switch (goal.status) {
			case "active":
				return `Pursuing goal (${this.formatGoalElapsed(goal.timeUsedSeconds)})`;
			case "paused":
				return `Goal paused (${this.formatGoalElapsed(goal.timeUsedSeconds)})`;
			case "budget_limited":
				return `Goal budget limited (${this.formatGoalElapsed(goal.timeUsedSeconds)})`;
			case "idle":
			case "complete":
			case "error":
				return undefined;
			default: {
				const _exhaustive: never = goal.status;
				return _exhaustive;
			}
		}
	}

	private formatGoalElapsed(seconds: number): string {
		const totalSeconds = Math.max(0, Math.trunc(seconds));
		if (totalSeconds < 60) {
			return `${totalSeconds}s`;
		}
		const minutes = Math.floor(totalSeconds / 60);
		const remainingSeconds = totalSeconds % 60;
		if (minutes < 60) {
			return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
		}
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
	}

	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	private createLegacyHeartbeatPromptMessage(
		message: Message,
		textContent: string,
	): ReturnType<typeof createHeartbeatPromptMessage> | undefined {
		const heartbeat = this.connectionState?.heartbeat;
		if (
			message.role !== "user" ||
			!heartbeat ||
			!this.isTextOnlyUserMessage(message) ||
			textContent.trim() !== heartbeat.prompt.trim() ||
			!this.isLikelyHeartbeatPromptTimestamp(heartbeat, message.timestamp)
		) {
			return undefined;
		}

		return createHeartbeatPromptMessage(heartbeat, message.timestamp);
	}

	private isTextOnlyUserMessage(message: Message): boolean {
		if (message.role !== "user") {
			return false;
		}
		if (typeof message.content === "string") {
			return true;
		}
		return message.content.every((content) => content.type === "text");
	}

	private isLikelyHeartbeatPromptTimestamp(job: AgentCronJob, timestamp: number): boolean {
		const directRunTimes = [job.lastRunAt, job.nextRunAt]
			.map((value) => (value ? Date.parse(value) : Number.NaN))
			.filter((value) => Number.isFinite(value));
		const tolerance = this.heartbeatLegacyPromptToleranceMs(job);
		if (directRunTimes.some((runAt) => Math.abs(timestamp - runAt) <= tolerance)) {
			return true;
		}
		return false;
	}

	private heartbeatLegacyPromptToleranceMs(job: AgentCronJob): number {
		const intervalMs = job.schedule.intervalMs;
		if (!intervalMs || intervalMs <= 0) {
			return HEARTBEAT_LEGACY_PROMPT_MAX_TOLERANCE_MS;
		}
		return Math.min(
			HEARTBEAT_LEGACY_PROMPT_MAX_TOLERANCE_MS,
			Math.max(HEARTBEAT_LEGACY_PROMPT_MIN_TOLERANCE_MS, intervalMs / 3),
		);
	}

	/** The transient footer notice and when it goes out. */
	private footerToast: { text: string; until: number } | undefined;
	private footerToastTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * A notice that only confirms what the user just did (`✓ copied`): it lights
	 * up in the footer for two seconds and never lands in the conversation.
	 */
	private showToast(text: string): void {
		this.footerToast = { text, until: Date.now() + FOOTER_TOAST_MS };
		if (this.footerToastTimer) clearTimeout(this.footerToastTimer);
		this.footerToastTimer = setTimeout(() => {
			this.footerToastTimer = undefined;
			this.footerToast = undefined;
			this.ui.requestRender();
		}, FOOTER_TOAST_MS);
		this.footerToastTimer.unref?.();
		this.ui.requestRender();
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string, tone: "dim" | "warning" = "dim"): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg(tone, message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(children.length > 0 ? 1 : 0);
		const text = new Text(theme.fg(tone, message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private async copyFullscreenSelection(text: string): Promise<void> {
		try {
			await copyToClipboard(text);
			this.showToast("✓ copied");
		} catch (error) {
			this.showError(`复制失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Local slash commands (/context, /system-prompt, …) print into the chat
	// without round-tripping through the agent, so no user message event echoes
	// the typed command. Render the turn ourselves, mirroring the "user" case
	// above, so the output is anchored to a visible command instead of floating.
	private echoLocalCommand(text: string): void {
		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new UserMessageComponent(
				text,
				this.getMarkdownThemeWithSettings(),
				(name) => this.isRecognizedSlashCommand(name),
				Date.now(),
			),
		);
	}

	private addMessageToEditorHistory(message: AgentMessage): void {
		if (message.role !== "user") {
			return;
		}
		const textContent = this.getUserMessageText(message);
		if (textContent && !this.createLegacyHeartbeatPromptMessage(message, textContent)) {
			this.editor.addToHistory?.(textContent);
		}
	}

	private createDisplayedCustomMessageComponent(message: CustomMessage): Component {
		if (message.customType === PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE) return createProviderFallbackNoticeRow(message);
		if (isSessionSlashCommandMessage(message)) return new SlashCommandMessageComponent(message.content);
		if (isSessionSlashCommandResultMessage(message)) return new SlashCommandResultMessageComponent(message);
		if (
			message.customType === SESSION_SLASH_COMMAND_CUSTOM_TYPE ||
			message.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE
		) {
			return new UserMessageComponent("[Malformed session command message]", this.getMarkdownThemeWithSettings());
		}
		if (isCompactionOutcomeMessage(message)) return new CompactionOutcomeMessageComponent(message);
		if (message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE) {
			return new MalformedCompactionOutcomeMessageComponent();
		}
		if (isRefinementOutcomeMessage(message)) return new RefinementOutcomeMessageComponent(message);
		if (message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE) {
			return new MalformedRefinementOutcomeMessageComponent();
		}
		if (isAgentSessionMessage(message)) {
			return new AgentMessageComponent(message, this.getMarkdownThemeWithSettings(), {
				suppressLeadingSpace: isCompactAgentMessageNeighbor(this.chatContainer.children.at(-1)),
				inset: this.isInsideQuietTurn() ? AGENT_MESSAGE_TURN_INSET : 0,
			});
		}
		if (isInjectedPromptMessage(message)) {
			return new InjectedPromptMessageComponent(message, this.getMarkdownThemeWithSettings());
		}
		return new CustomMessageComponent(
			message,
			this.bindLocalSessionExtensions
				? this.getLocalSessionHost().getExtensionRunner().getMessageRenderer(message.customType)
				: undefined,
			this.getMarkdownThemeWithSettings(),
		);
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		if (message.role === "assistant") this.lastAssistantStopReason = message.stopReason;
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext, {
					suppressLeadingSpace: this.chatContainer.children.at(-1) instanceof AgentMessageComponent,
				});
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				this.noteSubagentFailureSeen(message);
				if (message.display) {
					const component = this.createDisplayedCustomMessageComponent(message);
					applyExpansionLanes(component, {
						thinking: this.thinkingExpanded,
						tools: this.toolOutputExpanded,
						agentMessages: this.agentMessagesExpanded,
						editDiffs: this.editDiffsExpanded,
					});
					if (isSessionSlashCommandMessage(message) && this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					const heartbeatMessage = this.createLegacyHeartbeatPromptMessage(message, textContent);
					if (heartbeatMessage) {
						if (this.chatContainer.children.length > 0) {
							this.chatContainer.addChild(new Spacer(1));
						}
						const component = new InjectedPromptMessageComponent(
							heartbeatMessage,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						break;
					}

					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								(name) => this.isRecognizedSlashCommand(name),
								Number(message.timestamp) || undefined,
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							(name) => this.isRecognizedSlashCommand(name),
							Number(message.timestamp) || undefined,
						);
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					{
						expanded: this.toolOutputExpanded,
						// F2: the thinking lane must survive a rebuild too - without
						// it, a compaction or chat-cap window rebuild silently collapses
						// the traces the user had expanded.
						thinkingExpanded: this.thinkingExpanded,
						precededByToolActivity:
							this.chatContainer.children.at(-1) instanceof ToolExecutionComponent ||
							this.chatContainer.children.at(-1) instanceof AgentMessageComponent,
						mermaidTransform: this.mermaidMarkdownTransform,
						cwd: this.getCurrentCwd(),
						// TUI v4: the replay path folds intermediate narration in quiet mode.
						quiet: this.settingsManager.getProcessMode() === "quiet",
					},
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 * @param options.clearChat Clear the current transcript immediately before rendering
	 * @param options.limitTranscript Limit transcript replay to the recent tail
	 */
	private orderMessagesForTranscript(messages: AgentMessage[]): AgentMessage[] {
		const summaryIndex = messages.findIndex((message) => message.role === "compactionSummary");
		if (summaryIndex === -1) return messages;
		const summary = messages[summaryIndex];
		if (summary.role !== "compactionSummary") return messages;
		const remaining = messages.filter((_, index) => index !== summaryIndex);
		if (Number.isSafeInteger(summary.retainedMessageCount) && summary.retainedMessageCount! >= 0) {
			const boundary = Math.min(summary.retainedMessageCount!, remaining.length);
			return [...remaining.slice(0, boundary), summary, ...remaining.slice(boundary)];
		}

		// Compatibility for summaries created before retainedMessageCount was added.
		const retained: AgentMessage[] = [];
		const later: AgentMessage[] = [];
		for (const message of remaining) {
			(message.timestamp < summary.timestamp ? retained : later).push(message);
		}
		return [...retained, summary, ...later];
	}

	private async renderSessionContext(
		sessionContext: AgentConnectionSessionContext,
		options: {
			updateFooter?: boolean;
			populateHistory?: boolean;
			clearChat?: boolean;
			limitTranscript?: boolean;
		} = {},
	): Promise<void> {
		// A rebuild (resync, cap trim, setting change) re-creates every turn;
		// carry each turn's open blocks over, keyed by its first tool call.
		const turnLanes = this.captureTurnLanes();
		const restoredSummaries: TurnSummaryComponent[] = [];
		// T8: a rebuild re-creates every summary component; the open order
		// cannot reference the dead ones.
		this.processBlockOpenOrder = [];
		this.resetPendingToolState();
		const transcriptMessages = this.orderMessagesForTranscript(sessionContext.messages);
		const messagesToRender = options.limitTranscript ? initialRenderMessages(transcriptMessages) : transcriptMessages;
		// A failure notice older than the render window was still received by this session.
		for (const message of transcriptMessages) {
			if (message.role === "custom") this.noteSubagentFailureSeen(message);
		}
		this.chatTranscriptTrimmed = messagesToRender.length < transcriptMessages.length;
		// A full (unwindowed) render resets the cap-rebuild floor.
		if (!options.limitTranscript) this.chatCapRebuildFloor = 0;
		this.ipythonToolComponents.clear();
		this.lateIpythonSentAgentMessages.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// U4: the startup replay mirrors buildConversationComponents' turn grouping:
		// one aggregate line per agent turn, settled tools hidden while collapsed.
		let replayTurnState: TurnActivityState | undefined;
		let replayTurnSummary: TurnSummaryComponent | undefined;
		// TUI v4: comms counted per replayed turn (received agent-message rows +
		// sent agent messages inside ipython tool details), deduped by id.
		const replaySentCommIds = new Set<string>();
		const replayQuiet = this.settingsManager.getProcessMode() === "quiet";
		const toolNames: string[] = [];
		for (const message of messagesToRender) {
			if (message.role !== "assistant") {
				continue;
			}
			for (const content of message.content) {
				if (content.type === "toolCall") {
					toolNames.push(content.name);
				}
			}
		}
		await this.preloadToolDefinitions(toolNames);

		if (options.clearChat) {
			this.resetBlockNavigation();
			this.chatContainer.clear();
		}

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		if (options.populateHistory) {
			for (const message of sessionContext.messages) {
				this.addMessageToEditorHistory(message);
			}
		}

		const renderOptions = { ...options, populateHistory: false };

		if (messagesToRender.length < sessionContext.messages.length) {
			this.chatContainer.addChild(
				new Text(
					theme.fg(
						"dim",
						`Showing latest ${messagesToRender.length} of ${sessionContext.messages.length} messages for faster open.`,
					),
					1,
					0,
				),
			);
			this.chatContainer.addChild(new Spacer(1));
		}

		for (const message of messagesToRender) {
			if (message.role === "user") {
				// Freeze the previous turn's clock (thinking-only turns have no
				// steps to settle) before the next turn starts.
				replayTurnState?.markTurnEnded(Number(message.timestamp) || Date.now());
				replayTurnState = undefined;
				replayTurnSummary = undefined;
				replaySentCommIds.clear();
			}
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				// U6: the turn's aggregate line renders at the turn head, before the
				// first assistant component, and counts this message's thinking.
				if (!replayTurnState) {
					replayTurnState = new TurnActivityState(Number(message.timestamp) || Date.now());
					replayTurnSummary = this.createTurnSummary(replayTurnState);
					replayTurnSummary.setExpanded(this.toolOutputExpanded);
					// TUI v4: quiet turns carry the one-line footnote at their head.
					replayTurnSummary.setQuiet(replayQuiet);
					this.chatContainer.addChild(replayTurnSummary);
				}
				replayTurnState.modelId = message.model || replayTurnState.modelId;
				replayTurnState.addThinkingSegments(countThinkingSegments(message));
				replayTurnState.latestThinking = latestThinkingText(message) || replayTurnState.latestThinking;
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						replayTurnState.addStep({
							toolCallId: content.id,
							toolName: content.name,
							args: content.arguments,
							status: "running",
						} satisfies TurnStep);
						const lanes = replayTurnState.steps.length === 1 ? turnLanes.get(content.id) : undefined;
						if (lanes && replayTurnSummary) {
							replayTurnState.setProcessKeySteps(lanes.keySteps);
							replayTurnState.thinkingExpanded = lanes.thinking;
							replayTurnState.agentMessagesExpanded = lanes.comms;
							replayTurnSummary.setExpanded(lanes.process);
							restoredSummaries.push(replayTurnSummary);
						}
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								includeImageDimensions: false,
							},
							this.getCachedToolDefinition(content.name),
							this.ui,
							this.getCurrentCwd(),
						);
						component.setTurnActivity(replayTurnState);
						component.setExpanded(this.toolOutputExpanded || !replayTurnState.isCollapsed);
						component.setAgentMessagesExpanded(
							this.agentMessagesExpanded || replayTurnState.agentMessagesExpanded,
						);
						component.setEditDiffsExpanded(this.editDiffsExpanded);
						selectLatestToolExpandHint(this.chatContainer.children, component);
						this.chatContainer.addChild(component);
						this.registerIpythonToolComponent(content.name, content.id, component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.getRetryAttempt();
								errorMessage =
									retryAttempt > 0
										? `重试 ${retryAttempt} 次后已中断`
										: message.errorMessage &&
												message.errorMessage !== "Request was aborted" &&
												message.errorMessage !== "Operation aborted"
											? message.errorMessage
											: "已中断";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
							// Batch1 review P1-2: settle the step like the live path
							// (message_end) does - without this the aborted turn's
							// steps stay "running" forever, the footnote's duration
							// becomes Date.now()-startedAt and never freezes.
							replayTurnState.setStepStatus(content.id, "error", Number(message.timestamp) || Date.now());
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
				replayTurnState?.setStepStatus(
					message.toolCallId,
					message.isError ? "error" : "done",
					Number(message.timestamp) || Date.now(),
				);
				this.recordTurnFileChanges(replayTurnState, message.toolCallId, message);
				// TUI v4: sent agent messages riding this tool result count as comms.
				const details =
					typeof message.details === "object" && message.details !== null
						? (message.details as Record<string, unknown>)
						: {};
				if (Array.isArray(details.sentAgentMessages)) {
					for (const entry of details.sentAgentMessages) {
						const id =
							typeof entry === "object" && entry !== null && "id" in entry
								? String((entry as Record<string, unknown>).id)
								: undefined;
						if (id === undefined || replaySentCommIds.has(id)) {
							continue;
						}
						replaySentCommIds.add(id);
						replayTurnSummary?.addCommMessage();
					}
				}
			} else {
				// TUI v4: a received agent-message row is one comm in this turn.
				if (isAgentSessionMessage(message) && message.display) {
					replayTurnSummary?.addCommMessage();
				}
				// All other messages use standard rendering
				this.addMessageToChat(message, renderOptions);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			component.setIncludeImageDimensions(true);
			this.pendingTools.set(toolCallId, component);
		}
		if (replayTurnState && (renderedPendingTools.size > 0 || this.isAgentStreaming())) {
			// Attaching mid-run: live tool and thinking events keep feeding this
			// turn's group, so the replayed state stays the live one - and stays
			// running until agent_end stamps it.
			this.currentTurnState = replayTurnState;
			this.currentTurnSummary = replayTurnSummary;
			replayTurnState.live = true;
		} else {
			// The last replayed turn has no following user prompt; freeze its clock.
			replayTurnState?.markTurnEnded(Number(messagesToRender.at(-1)?.timestamp) || Date.now());
		}
		for (const summary of restoredSummaries) {
			this.applyTurnLanes(summary);
			if (summary.state.processBlockExpanded) this.recordProcessBlockOpen(summary, "process");
			if (summary.state.thinkingBlockExpanded) this.recordProcessBlockOpen(summary, "thinking");
			if (summary.state.commsBlockExpanded) this.recordProcessBlockOpen(summary, "comms");
		}
		// U2: seed the tool-error streak from the replayed transcript tail.
		this.consecutiveToolErrors = consecutiveToolErrorsFromMessages(messagesToRender);
		this.footer?.setToolErrorCount?.(this.consecutiveToolErrors);
		this.ui.requestRender();
	}

	async renderInitialMessages(): Promise<void> {
		const snapshot = await this.agentConnection.getInitialSnapshot();
		const context = this.getSessionContextFromConnectionSnapshot(snapshot);
		const state = snapshot.state;
		const streamingMessage = snapshot.streamingMessage;
		this.rlmNodeId = snapshot.parent?.childId;
		this.seedSubagentSummary(snapshot.children);
		this.applyConnectionStateSnapshot(state);
		this.restoreTurnStartFromMessages(context.messages);
		await this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
			limitTranscript: true,
		});
		await this.restoreStreamingMessageFromSnapshot(streamingMessage);

		// Show compaction info if session was compacted
		const compactionCount = state.compactionCount;
		if (compactionCount > 0) {
			this.showStatus(`会话已压缩 ${compactionCount} 次`);
		}
		// Coming back after a while: say what happened meanwhile.
		void this.showDutyLog({ automatic: true });
	}

	/** When the owner last pressed a key in this TUI; the duty log's "came back" clock. */
	private lastOwnerKeyAt = Date.now();

	/**
	 * An owner who leaves the TUI attached for days never starts, attaches or resumes, so the
	 * automatic duty log would never show. The first key after an idle gap longer than the
	 * duty-log threshold is the moment they came back. Never consumes the key.
	 */
	private dutyLogReturnRoute(data: string): undefined {
		if (isMouseSequence(data) || isKeyRelease(data) || TERMINAL_CELL_SIZE_REPORT.test(data)) return undefined;
		const now = Date.now();
		const idleMs = now - this.lastOwnerKeyAt;
		this.lastOwnerKeyAt = now;
		const thresholdMinutes = this.settingsManager.getDutyLogAfterMinutes();
		if (thresholdMinutes > 0 && idleMs >= thresholdMinutes * 60_000) void this.showDutyLog({ automatic: true });
		return undefined;
	}

	/**
	 * The duty log for the current session. Automatic calls only show it when
	 * the owner has been away longer than the setting and something happened;
	 * `/dutylog` always answers.
	 */
	private async showDutyLog(options: { automatic: boolean }): Promise<void> {
		// Runs fire-and-forget after every initial render: nothing here may throw out.
		try {
			const sessionFile = this.connectionState?.sessionFile;
			const thresholdMinutes = this.settingsManager.getDutyLogAfterMinutes();
			if (options.automatic && thresholdMinutes <= 0) return;
			if (!sessionFile) {
				if (!options.automatic) this.showStatus("这个会话没有记录文件，没有值班记录可看");
				return;
			}
			const now = Date.now();
			const summary = summarizeDutyLog({
				entries: await readDutyLogEntries(sessionFile),
				now,
				children: buildSubagentPanelRows(this.subagentSnapshots.values(), this.rlmNodeId).map((row) => ({
					name: row.name,
					state: row.state,
				})),
			});
			if (!summary) {
				if (!options.automatic) this.showStatus("你离开之后这个会话没有新的动静");
				return;
			}
			if (options.automatic && summary.awayMs < thresholdMinutes * 60_000) return;
			this.dutyLogContainer.clear();
			this.dutyLogContainer.addChild(new DutyLogBlock(formatDutyLog(summary, now)));
			this.ui.requestRender();
		} catch (error) {
			if (!options.automatic) {
				this.showError(`读取值班记录失败：${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private async restoreStreamingMessageFromSnapshot(message: AgentMessage | undefined): Promise<void> {
		if (message?.role === "assistant") {
			this.startAssistantStreamingMessage(message);
			for (const content of message.content) {
				if (content.type === "toolCall") {
					this.startedToolCalls.add(content.id);
					await this.getOrCreatePendingToolComponent(content);
				}
			}
		}
	}

	private getSessionContextFromConnectionSnapshot(snapshot: AgentConnectionSnapshot): AgentConnectionSessionContext {
		if (snapshot.sessionContext) {
			return snapshot.sessionContext;
		}
		return {
			messages: snapshot.messages,
			thinkingLevel: snapshot.state.thinkingLevel,
			serviceTier: snapshot.state.serviceTier,
			model: snapshot.state.model
				? { provider: snapshot.state.model.provider, modelId: snapshot.state.model.id }
				: null,
		};
	}

	async getUserInput(): Promise<string | undefined> {
		if (this.agentsViewRequest) {
			return undefined;
		}
		return new Promise((resolve) => {
			this.onInputCallback = (text: string | undefined) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private reattachLiveChatComponents(): void {
		if (this.activeBashComponent && !this.chatContainer.children.includes(this.activeBashComponent)) {
			this.chatContainer.addChild(this.activeBashComponent);
		}
		if (this.streamingComponent && this.streamingMessage) {
			if (!this.chatContainer.children.includes(this.streamingComponent)) {
				this.chatContainer.addChild(this.streamingComponent);
			}
			this.streamingComponent.updateContent(this.streamingMessage);
		}
	}

	private async rebuildChatFromMessages(): Promise<void> {
		const context = await this.agentConnection.getSessionContext();
		await this.renderSessionContext(context, { clearChat: true });
		this.reattachLiveChatComponents();
	}

	/**
	 * Live appends only ever grow the chat tree, so a long session accumulates
	 * components without bound. Once the settled tree passes the live cap, trigger
	 * a windowed rebuild: the same initialRenderMessages path used on session open,
	 * including its toolCall/toolResult pairing repair, so the evicted components
	 * (and their result data) can be collected. Only runs at settle points;
	 * interruptible work (streaming, bash, permission confirm, retries) owns components a rebuild would detach.
	 */
	private liveChatCapBlocked(): boolean {
		return (
			this.hasInterruptibleWork() ||
			this.streamingComponent !== undefined ||
			this.activeBashComponent !== undefined ||
			this.ui.isFullscreenReviewing()
		);
	}

	private async enforceChatComponentCap(): Promise<void> {
		if (this.chatCapRebuildInFlight) return;
		const rebuildFloor = this.chatCapRebuildFloor ?? 0;
		if (this.chatContainer.children.length <= Math.max(LIVE_CHAT_COMPONENT_LIMIT, rebuildFloor)) {
			return;
		}
		if (this.liveChatCapBlocked()) return;
		this.chatCapRebuildInFlight = true;
		try {
			const context = await this.agentConnection.getSessionContext();
			if (this.liveChatCapBlocked()) return;
			await this.renderSessionContext(context, { clearChat: true, limitTranscript: true });
			this.chatCapRebuildFloor = this.chatContainer.children.length;
			this.ui.requestRender();
		} catch (error) {
			this.showError(
				`Failed to trim the chat transcript: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			this.chatCapRebuildInFlight = false;
		}
	}

	private handleEscape(): void {
		this.clearCtrlCExitHint();
		// An open shortcut panel is the first thing Esc closes.
		if ((this.shortcutGuideContainer?.children.length ?? 0) > 0) {
			this.clearShortcutGuide();
			return;
		}
		if (this.sideQuestionEvent) {
			this.clearEscapeRepeat();
			this.clearSideQuestion({ abort: true });
			return;
		}
		// Editing a queued message: Esc backs out of the edit (the draft comes
		// back, the message stays queued as it was) instead of interrupting the
		// turn, which would send the queue unedited.
		if (this.queueSelection?.isBrowsing && !this.pendingQueueEdit) {
			this.clearEscapeRepeat();
			this.setEditorTextFromQueueSelection(this.queueSelection.reset());
			this.ui.requestRender();
			return;
		}
		const action = this.takeEscapeRepeatAction();
		if (action === "tree") {
			void this.showTreeSelector();
			return;
		}
		if (action === "clear") {
			this.clearInputBar();
			return;
		}

		// TUI v4 T8: in the quiet conversation, with an empty editor and no
		// running work, Esc walks the open order backwards - the last-opened
		// process block folds first. The interrupt/clear semantics stay ahead
		// of this: a running turn or a non-empty editor never reaches here.
		if (
			this.settingsManager.getProcessMode() === "quiet" &&
			this.editor.getText().length === 0 &&
			!this.hasInterruptibleWork() &&
			this.closeLastOpenedProcessBlock()
		) {
			return;
		}

		this.armEscapeRepeat(this.hasInterruptibleWork() || this.editor.getText().length === 0 ? "tree" : "clear");
		this.interruptOrClearInput();
	}

	private armEscapeRepeat(action: "tree" | "clear"): void {
		this.clearEscapeRepeat();
		this.escapeRepeatAction = action;
		this.escapeRepeatExpiresAt = Date.now() + InteractiveMode.ESCAPE_REPEAT_WINDOW_MS;
		this.escapeRepeatTimer = setTimeout(() => {
			this.clearEscapeRepeat();
			this.ui.requestRender();
		}, InteractiveMode.ESCAPE_REPEAT_WINDOW_MS);
		this.escapeRepeatTimer.unref?.();
		this.ui.requestRender();
	}

	private takeEscapeRepeatAction(): "tree" | "clear" | undefined {
		if (!this.escapeRepeatAction || this.escapeRepeatExpiresAt <= Date.now()) {
			this.clearEscapeRepeat();
			return undefined;
		}
		const action = this.escapeRepeatAction;
		this.clearEscapeRepeat();
		return action;
	}

	private clearEscapeRepeat(): void {
		if (this.escapeRepeatTimer) {
			clearTimeout(this.escapeRepeatTimer);
			this.escapeRepeatTimer = undefined;
		}
		this.escapeRepeatAction = undefined;
		this.escapeRepeatExpiresAt = 0;
	}

	private handleCtrlC(): void {
		this.clearEscapeRepeat();
		if (this.isCtrlCExitHintVisible()) {
			void this.shutdown();
			return;
		}
		this.handleInterruptKey();
	}

	private handleInterruptKey(): void {
		this.clearEscapeRepeat();
		// A press that stops running work only stops it; arming "press again to
		// exit" in the same press would make the usual double press to stop a
		// task quit the app instead.
		const stoppedWork = this.hasInterruptibleWork();
		this.interruptOrClearInput();
		if (!stoppedWork) {
			this.showCtrlCExitHint();
		}
	}

	private interruptOrClearInput(): void {
		this.traceUploadAllAbortController?.abort(new Error("Trace upload cancelled"));
		if (this.sideQuestionEvent?.status === "running") {
			this.abortSideQuestion(this.sideQuestionEvent.id, true);
		}
		// Best-effort aborts issued next to the primary one below. Each needs its own
		// .catch(): a daemon that answers with an error would otherwise turn one Escape
		// press into an unhandled rejection. Swallowing is honest here - when one of these
		// fails the thing it was stopping keeps running on screen, and the primary
		// abort() reports its own failure to the user.
		if (this.getRetryAttempt() > 0) {
			void this.agentConnection.abortRetry().catch(() => undefined);
		}
		if (this.isAgentCompacting()) {
			void this.agentConnection.abortCompaction().catch(() => undefined);
			void this.agentConnection.abortBranchSummary().catch(() => undefined);
		}
		if (this.isBashRunning()) {
			void this.agentConnection.abortBash().catch(() => undefined);
		}
		if (this.isAgentStreaming()) {
			// Upstream #2426: the interrupt carries the queued steering messages out with it, so
			// "stop - and here is what I meant instead" is one key press instead of an interrupt
			// plus a resubmit. The queue is still preserved server-side, and a daemon too old for
			// the command aborts only and reports why through `degraded`: the queued messages then
			// wait for the next submit, which the user is told about instead of being left to
			// conclude the interrupt swallowed their words (P5 ruling,
			// docs/fork/merge-upstream-20260917.md §13.4).
			void this.agentConnection
				.abortAndSendQueued()
				.then((result) => {
					if (result.degraded !== undefined) {
						this.showWarning("后台服务版本较旧：已中断，但排队消息没有跟着发出，会在你下次发送时一起发出。");
					}
				})
				.catch((error) => {
					this.showError(error instanceof Error ? error.message : String(error));
				});
		}
	}

	/**
	 * Mount the stall action bar for one stall event (r4 recovery-shell).
	 *
	 * The interrupt label is resolved locally from the real `app.input.clear`
	 * binding (B2 - an empty label means unbound, and the action is then not
	 * offered). The two handler facts are constants in this host, not lookups:
	 * this method wires both callbacks unconditionally below, so `canInterrupt`
	 * and `canDiagnose` are always true here. That is not the general "host
	 * resolves its own state" contract `stallActionBarView` documents - the
	 * real per-mount resolution is deferred (r4 phase-3, blind3 8); the layer
	 * that actually gates the promises today is the TUI's callback AND
	 * (`effectiveActions`), which drops any action without a handler. A bar
	 * that cannot mount leaves exactly the pre-bar behavior - the forensic
	 * showError already fired (B3).
	 *
	 * F3: the daemon may have filled auto-recovery facts on the event's
	 * `actions`. Those are pass-through facts about the sweep, not actions this
	 * host resolves, so they are merged into the mounted view instead of being
	 * replaced by it - the bar then shows when the sweep will act, and the TUI
	 * re-derives the countdown from its own clock on every repaint (this host
	 * owns no countdown timer).
	 */
	private mountStallActionBar(event: StallEventView & { actions?: StallEventActions }): boolean {
		const interruptKeyLabel = keyText("app.input.clear");
		const daemonActions = event.actions;
		const view = stallActionBarView(event, {
			interruptKeyLabel,
			// Constant-true host facts, not resolutions - see the doc comment above.
			canInterrupt: true,
			canDiagnose: true,
		});
		if (view === undefined) {
			// B3: no usable action means the plain error channel is the whole
			// report; mounting a degraded bar here would double-report the same
			// text through two channels.
			return false;
		}
		this.removeStallActionBar();
		const mountedAt = Date.now();
		this.stallActionBarMountedAt = mountedAt;
		this.stallActionBarActivityAt = undefined;
		const bar = new StallActions(
			{
				...event,
				// Amber like the running card it belongs to (quiet past a minute already).
				summary: theme.bold(theme.fg("runCardWarn", formatStallSummary(event))),
				// Live: a bar left up for hours says how long it has really been quiet. The count
				// stops at the first sign of activity after the warning, which ends the quiet.
				summaryAt: (nowMs) =>
					theme.bold(
						theme.fg(
							"runCardWarn",
							formatStallSummary(event, (this.stallActionBarActivityAt ?? nowMs) - mountedAt),
						),
					),
				actions: {
					...view,
					...(daemonActions?.autoRecoveryArmed === true
						? {
								autoRecoveryArmed: true,
								executor: daemonActions.executor,
								autoRecoveryAtMs: daemonActions.autoRecoveryAtMs,
							}
						: {}),
				},
			},
			{
				interruptKeyLabel,
				matchesInterruptKey: (data) => this.keybindings.matches(data, "app.input.clear"),
				onInterrupt: () => {
					this.removeStallActionBar();
					// The same path an Esc would take: interrupt the turn (and send the
					// queued steering with it), not just clear the editor.
					this.interruptOrClearInput();
				},
				onDiagnostics: () => {
					this.removeStallActionBar();
					// The forensic text on request: a dim reference block, not an error -
					// nothing failed, the reader asked to look.
					this.showStallDiagnostics(event);
				},
			},
		);
		this.stallActionBar = bar;
		this.stallActionBarEvent = event;
		this.chatContainer.addChild(bar);
		if (this.removeStallActionInputListener === undefined) {
			this.removeStallActionInputListener = this.ui.addInputListener((data) => this.stallActionInputRoute(data));
		}
		this.ui.requestRender();
		return true;
	}

	/**
	 * The stalled turn went on (turn_end / agent_end): the bar can no longer
	 * interrupt it, but its diagnostics are still what the user may want to
	 * read. The quiet-step rule stops a silent call right as the warning fires,
	 * so tearing the bar down there made Ctrl+Y land on the editor (yank) a
	 * fraction of a second after the bar promised it. The bar stays, says the
	 * turn went on, and keeps only the diagnostics key; any other key
	 * dismisses it as before.
	 */
	private settleStallActionBar(options: { render?: boolean } = {}): void {
		const bar = this.stallActionBar;
		const event = this.stallActionBarEvent;
		if (bar === undefined || event === undefined || this.stallActionBarSettled) {
			return;
		}
		const quietSinceEventMs = this.stallQuietSinceEventMs();
		this.removeStallActionBar({ render: false });
		const settled = new StallActions(
			{
				...event,
				summary: `${theme.fg("success", "✓")} ${formatStallSummary(event, quietSinceEventMs).replace(/^⚠\s*/, "")}，现在已经接着往下走了`,
				actions: { canAbort: false, canDiagnose: true },
			},
			{
				interruptKeyLabel: keyText("app.input.clear"),
				onDiagnostics: () => {
					this.removeStallActionBar();
					this.showStallDiagnostics(event);
				},
			},
		);
		this.stallActionBar = settled;
		this.stallActionBarEvent = event;
		this.stallActionBarSettled = true;
		this.chatContainer.addChild(settled);
		this.removeStallActionInputListener ??= this.ui.addInputListener((data) => this.stallActionInputRoute(data));
		if (options.render !== false) this.ui.requestRender();
	}

	/**
	 * Whether the stall routes (the action bar, the diagnostics close key) may read keys: only
	 * while the plain editor has the keyboard. A dialog, selector or overlay with focus, an open
	 * autocomplete list, or block navigation owns Esc, Ctrl+Y and every other key instead.
	 */
	private stallRoutesOwnKeyboard(): boolean {
		if (this.blockNavigation !== undefined) return false;
		// A capturing overlay, a selector or a dialog takes focus; a non-capturing overlay does not
		// read keys, so it leaves the bar working.
		if (this.ui.getFocusedComponent() !== this.editor) return false;
		return !(this.editor === this.defaultEditor && this.defaultEditor.isShowingAutocomplete());
	}

	/** How much longer than the event's own reading the bar's quiet spell lasted (0 without a bar). */
	private stallQuietSinceEventMs(): number {
		const mountedAt = this.stallActionBarMountedAt;
		if (mountedAt === undefined) return 0;
		return Math.max(0, (this.stallActionBarActivityAt ?? Date.now()) - mountedAt);
	}

	/** Tear the live stall action bar down (if any). Safe when no bar is live. */
	private removeStallActionBar(options: { render?: boolean } = {}): void {
		this.stallActionBarEvent = undefined;
		this.stallActionBarSettled = false;
		const bar = this.stallActionBar;
		if (bar === undefined) return;
		this.stallActionBar = undefined;
		bar.dismiss();
		this.chatContainer.removeChild(bar);
		if (this.removeStallActionInputListener !== undefined) {
			this.removeStallActionInputListener();
			this.removeStallActionInputListener = undefined;
		}
		if (options.render !== false) this.ui.requestRender();
	}

	/**
	 * B1: the stall bar's input route, ahead of the editor. While a bar is live,
	 * a key goes to the bar first; an action key is consumed there, every other
	 * key dismisses the bar and flows on to its normal destination (the editor
	 * keeps focus the whole time - the bar never grabs it). Mouse reports and
	 * key-release frames are not "any other key": clicks must reach the bar's
	 * click regions, and a release must not re-trigger an action.
	 */
	private stallActionInputRoute(data: string): { consume?: boolean } | undefined {
		const bar = this.stallActionBar;
		if (bar === undefined || bar.isDismissed) return undefined;
		if (isMouseSequence(data) || isKeyRelease(data)) return undefined;
		// Input listeners run before the focused component, so an Esc meant for a dialog would
		// otherwise interrupt the turn. The bar neither acts nor dismisses while something else
		// has the keyboard.
		if (!this.stallRoutesOwnKeyboard()) return undefined;
		if (bar.handleInput(data)) return { consume: true };
		this.removeStallActionBar();
		return undefined;
	}

	private showCtrlCExitHint(): void {
		if (this.ctrlCExitHintTimer) {
			clearTimeout(this.ctrlCExitHintTimer);
		}
		this.ctrlCExitHintExpiresAt = Date.now() + InteractiveMode.EXIT_HINT_DURATION_MS;
		this.ctrlCExitHintTimer = setTimeout(() => {
			this.ctrlCExitHintTimer = undefined;
			if (!this.isCtrlCExitHintVisible()) {
				this.ctrlCExitHintExpiresAt = 0;
				this.ui.requestRender();
			}
		}, InteractiveMode.EXIT_HINT_DURATION_MS);
		this.ctrlCExitHintTimer.unref?.();
		this.ui.requestRender();
	}

	private clearCtrlCExitHint(options: { render?: boolean } = {}): void {
		if (!this.ctrlCExitHintTimer && this.ctrlCExitHintExpiresAt === 0) {
			return;
		}
		if (this.ctrlCExitHintTimer) {
			clearTimeout(this.ctrlCExitHintTimer);
			this.ctrlCExitHintTimer = undefined;
		}
		this.ctrlCExitHintExpiresAt = 0;
		if (options.render !== false) {
			this.ui.requestRender();
		}
	}

	private isCtrlCExitHintVisible(): boolean {
		return this.ctrlCExitHintExpiresAt > Date.now();
	}

	private handleCtrlD(): void {
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		this.clearCtrlCExitHint({ render: false });

		// Fetch while the connection is still alive; exit must not fail on a stats error.
		const sessionStats = await this.agentConnection.getSessionStats().catch(() => undefined);

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		try {
			await this.agentConnection.dispose();
		} finally {
			await this.options.onShutdown?.();
		}
		const resumeHint = formatResumeHint(sessionStats);
		if (resumeHint) {
			console.log(resumeHint);
		}
		process.exit(0);
	}

	/**
	 * Tear down the session's terminal UI before handing the terminal back to the
	 * agents view. Drains in-flight Kitty/SSH key-release sequences so they don't
	 * leak into the parent UI, then stops the renderer and theme watcher. Safe to
	 * call from a crash path too; idempotent via stop().
	 */
	async teardownSessionUi(options: { preserveAltScreen?: boolean } = {}): Promise<void> {
		await this.ui.terminal.drainInput(1000).catch(() => undefined);
		this.releasePromptStashSession();
		// Preserving the alt screen is what hands the frozen frame to the agents view, and
		// only a fullscreen session has such a frame to freeze: inline, the same line would
		// just be printed into scrollback.
		if (options.preserveAltScreen === true && this.fullscreenEnabled) {
			this.showAgentsViewHandoffStatus();
		}
		this.stop({ preserveAltScreen: options.preserveAltScreen });
		stopThemeWatcher();
	}

	/**
	 * Paint the handoff line into the frame stop() is about to freeze. Synchronous on
	 * purpose: stop() sets `stopped`, and every deferred render bails on it. Guarded
	 * because it is cosmetic - a line that cannot paint must not cost the teardown, or the
	 * session UI keeps fighting the agents view for the terminal.
	 */
	private showAgentsViewHandoffStatus(): void {
		try {
			this.showStatus(AGENTS_VIEW_HANDOFF_STATUS_MESSAGE);
			this.ui.flushRender();
		} catch {
			// The frozen frame keeps the transcript it already had.
		}
	}

	private handleAgentsBack(): boolean {
		if (this.editor.getText().trim()) {
			return false;
		}
		if (!this.options.returnToAgentsView) {
			void this.requestAgentsView();
			return true;
		}
		void this.returnToAgentsView();
		return true;
	}

	private async requestAgentsView(): Promise<void> {
		if (!this.options.returnToAgentsView) {
			this.showStatus("会话列表需要后台服务；不带 --no-daemon 启动才能浏览会话");
			return;
		}
		await this.returnToAgentsView();
	}

	private async returnToAgentsView(
		request: InteractiveModeRunResult["type"] = "agents_view",
		openChildActiveSessionId?: string,
		handoff: Pick<InteractiveModeRunResult, "openChild" | "returnToParentNotice"> = {},
	): Promise<void> {
		if (this.isShuttingDown || this.agentsViewRequest) return;
		this.stashDraftForAgentsView();
		this.agentsViewRequest = request;
		this.openChildActiveSessionId = openChildActiveSessionId;
		this.agentsViewHandoff = handoff;
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();

		await this.teardownSessionUi({ preserveAltScreen: true });
		let handoffComplete = false;
		try {
			try {
				await this.agentConnection.dispose();
			} finally {
				await this.options.onShutdown?.();
				this.onInputCallback?.(undefined);
				handoffComplete = true;
			}
		} finally {
			if (!handoffComplete) {
				this.ui.terminal.leaveAltScreen();
				this.ui.terminal.showCursor();
			}
		}
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				if (signal === "SIGHUP") {
					this.emergencyTerminalExit();
				}
				killTrackedDetachedChildren();
				void this.shutdown();
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Windows 不支持挂到后台");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.terminalSuspended = false;
			this.syncSubagentSpendCell();
			this.ui.start();
			// ui.stop() left the alt screen before suspending; re-enter it
			if (this.fullscreenEnabled) {
				this.applyFullscreen(true);
			}
			this.ui.requestRender(true);
		});

		try {
			// Nothing is on screen from here on: the spend cell stops ticking and
			// refreshing so a backgrounded session burns no scans nobody can see.
			this.terminalSuspended = true;
			this.syncSubagentSpendCell();
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			// The suspension never took: the TUI is still on screen, so the spend cell
			// must not stay frozen behind a flag nothing will clear.
			this.terminalSuspended = false;
			this.syncSubagentSpendCell();
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const editorText = this.editor.getText();
		const text = (this.editor.getExpandedText?.() ?? editorText).trim();
		if (this.queueSelection?.isBrowsing && !this.pendingQueueEdit) {
			await this.applyQueueSelection(text, "followUp").catch((error) =>
				this.showError(error instanceof Error ? error.message : String(error)),
			);
			return;
		}
		if (!text || !this.editor.onSubmit) return;

		// Unlike Enter, Alt+Enter does not go through Editor.submitValue(), so
		// capture and clear synchronously before an async/local handler can yield.
		this.pendingSubmittedPromptStash = this.snapshotPromptStash(editorText);
		this.editor.setText("");
		this.submittedInputBehavior = "followUp";
		// onSubmit consumes the behavior flag and bumps the generation synchronously;
		// capture the generation so an older failed submit never clobbers newer
		// typing or submissions.
		const submission = this.editor.onSubmit(text);
		this.submittedInputBehavior = "steer";
		const submissionGeneration = this.inputSubmissionGeneration;
		try {
			await submission;
		} catch (error) {
			if (submissionGeneration === this.inputSubmissionGeneration && this.editor.getText().length === 0) {
				this.editor.setText(text);
			}
			throw error;
		}
	}

	private refreshQueueSelectionAt(
		queue: AgentConnectionQueueState,
		selected: QueueSelectionItem,
		index: number,
	): void {
		const dropped = this.queueSelection.refreshAt(queue, selected.lane, index, selected.text);
		if (dropped !== undefined && this.editor.getText() === selected.text) {
			this.setEditorTextFromQueueSelection(dropped);
		}
	}

	private hasBrowsableQueue(): boolean {
		const queue = this.getConnectionQueue();
		return this.queueSelection.isBrowsing || queue.steering.length > 0 || queue.followUp.length > 0;
	}

	/** The conversation blocks block navigation walks, top to bottom. */
	private navigableBlocks(): (FocusableBlock & Component)[] {
		const width = Math.max(1, this.ui.terminal.columns);
		return this.chatContainer.children.filter(
			(child): child is FocusableBlock & Component =>
				isFocusableBlock(child) && child.render(width).some(isVisibleRow),
		);
	}

	/**
	 * Enter block navigation (Alt+Up from the prompt) on the newest block in
	 * view: the bottom block while following, otherwise the lowest block whose
	 * top row is on screen, so a scrolled-up fullscreen view stays put.
	 */
	private startBlockNavigation(direction: -1 | 1): void {
		if (this.blockNavigation) {
			this.moveBlockFocus(direction);
			return;
		}
		const blocks = this.navigableBlocks();
		const start = this.blockNearestView(blocks);
		if (!start) return;
		const navigator: BlockNavigator = new BlockNavigator({
			move: (step) => this.moveBlockFocus(step),
			toggle: () => this.toggleFocusedBlock(),
			copy: () => void this.copyFocusedBlock(),
			exit: (passThrough) => this.exitBlockNavigation(passThrough),
			blur: () => this.endBlockNavigation(navigator),
		});
		this.blockNavigation = {
			navigator,
			focused: start,
			resumeFollow: this.ui.isFullscreen() && !this.ui.isFullscreenReviewing(),
		};
		this.applyBlockFocus();
		this.ui.setFocus(navigator);
		this.ui.setFullscreenRevealMarker(BLOCK_REVEAL_MARKER);
		this.ui.requestRender();
	}

	private blockNearestView(blocks: readonly (FocusableBlock & Component)[]): (FocusableBlock & Component) | undefined {
		const last = blocks.at(-1);
		const scroll = this.ui.isFullscreenReviewing() ? this.ui.getScrollInfo() : null;
		if (!scroll) return last;
		const width = Math.max(1, this.ui.terminal.columns);
		const chatTop = componentRowOffset(this.getFullscreenScrollComponents(), this.chatContainer, width);
		if (chatTop === undefined) return last;
		const viewTop = scroll.linesAbove;
		// While reviewing, the window's bottom row carries the "back to bottom" hint.
		const viewBottom = viewTop + Math.max(1, scroll.windowHeight - 1);
		let row = chatTop;
		let covering: (FocusableBlock & Component) | undefined;
		let inView: (FocusableBlock & Component) | undefined;
		for (const child of this.chatContainer.children) {
			const lines = child.render(width);
			if (blocks.includes(child as FocusableBlock & Component)) {
				const block = child as FocusableBlock & Component;
				const top = row + Math.max(0, lines.findIndex(isVisibleRow));
				if (top >= viewTop && top < viewBottom) inView = block;
				else if (top < viewTop && row + lines.length > viewTop) covering = block;
			}
			row += lines.length;
			if (row >= viewBottom && inView) break;
		}
		return inView ?? covering ?? last;
	}

	private applyBlockFocus(): void {
		const navigation = this.blockNavigation;
		const focused = navigation?.focused;
		for (const block of this.navigableBlocks()) {
			if (block !== focused) {
				block.setBlockFocus(undefined);
				continue;
			}
			const toggleLabel = this.focusedBlockToggle(block)?.label;
			block.setBlockFocus({ reveal: this.ui.isFullscreen(), ...(toggleLabel ? { toggleLabel } : {}) });
		}
	}

	private moveBlockFocus(direction: -1 | 1): void {
		const navigation = this.blockNavigation;
		if (!navigation) return;
		const blocks = this.navigableBlocks();
		const index = blocks.indexOf(navigation.focused);
		const next = blocks[Math.max(0, Math.min(blocks.length - 1, (index === -1 ? blocks.length : index) + direction))];
		if (!next) return;
		navigation.focused = next;
		this.applyBlockFocus();
		// One scroll per move: between moves the wheel and page keys read freely.
		this.ui.setFullscreenRevealMarker(BLOCK_REVEAL_MARKER);
		this.ui.requestRender();
	}

	/** The turn a block belongs to: the nearest turn summary at or above it. */
	private turnSummaryFor(block: Component): TurnSummaryComponent | undefined {
		if (block instanceof TurnSummaryComponent) return block;
		const children = this.chatContainer.children;
		for (let i = children.indexOf(block); i >= 0; i--) {
			const child = children[i];
			if (child instanceof TurnSummaryComponent) return child;
			if (child instanceof UserMessageComponent) return undefined;
		}
		return undefined;
	}

	/**
	 * What Enter does to a block, or undefined where it does nothing: a process
	 * line or step runs the turn's Ctrl+O cycle, an answer with a trace flips its
	 * Thinking, a notice card opens or closes itself. The same paths as the
	 * keys, so the Esc close order and quiet mode's three-step cycle hold.
	 */
	private focusedBlockToggle(block: FocusableBlock & Component): { label: string; run: () => void } | undefined {
		if (block instanceof UserMessageComponent) return undefined;
		if (isExpandableBlock(block)) {
			const expanded = block.isBlockExpanded();
			return {
				label: expanded ? "收起" : "展开",
				run: () => {
					block.setExpanded(!expanded);
					this.requestExpansionRender();
				},
			};
		}
		const summary = this.turnSummaryFor(block);
		if (!summary) return undefined;
		if (block instanceof AssistantMessageComponent) {
			if (this.hideThinkingBlock || !block.hasThinkingTrace()) return undefined;
			return {
				label: summary.state.thinkingExpanded ? "收起 Thinking" : "展开 Thinking",
				run: () => this.toggleTurnThinking(summary),
			};
		}
		if (summary.state.stepCount === 0) return undefined;
		const state = summary.state;
		const label = state.isCollapsed ? "展开" : state.processKeyStepsView ? "展开全部" : "收起";
		return { label, run: () => this.cycleTurnProcess(summary) };
	}

	/** Enter/Space on the focused block. */
	private toggleFocusedBlock(): void {
		const focused = this.blockNavigation?.focused;
		if (!focused) return;
		const toggle = this.focusedBlockToggle(focused);
		if (!toggle) return;
		toggle.run();
		this.applyBlockFocus();
		this.ui.requestRender();
	}

	private async copyFocusedBlock(): Promise<void> {
		const text = this.blockNavigation?.focused.getBlockCopyText().trim();
		if (!text) {
			this.showStatus("这一块没有可复制的文字");
			return;
		}
		try {
			await copyToClipboard(text);
			this.showToast("✓ copied");
		} catch (error) {
			this.showError(`复制失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/**
	 * Tear block navigation down without touching focus: the highlight, the
	 * reveal marker, and - when the owner was following the tail when it began
	 * - back to following the output.
	 */
	private endBlockNavigation(navigator?: BlockNavigator): void {
		const navigation = this.blockNavigation;
		if (!navigation || (navigator && navigation.navigator !== navigator)) return;
		this.blockNavigation = undefined;
		navigation.navigator.deactivate();
		navigation.focused.setBlockFocus(undefined);
		this.applyBlockFocus();
		this.ui.setFullscreenRevealMarker(undefined);
		if (navigation.resumeFollow) this.ui.scrollToBottom();
		this.ui.requestRender();
	}

	private exitBlockNavigation(passThrough?: string): void {
		this.endBlockNavigation();
		this.focusEditor();
		if (passThrough !== undefined) this.editor.handleInput(passThrough);
		this.ui.requestRender();
	}

	/** The chat is being replaced (/new, /resume, a tree jump, reattach): its blocks are gone. */
	private resetBlockNavigation(): void {
		const navigation = this.blockNavigation;
		if (!navigation) return;
		const hadFocus = navigation.navigator.focused;
		this.endBlockNavigation();
		if (hadFocus) this.focusEditor();
	}

	private browseQueueSelection(direction: -1 | 1): void {
		if (this.pendingQueueEdit || this.pendingQueueMove) return;
		const text = this.queueSelection.move(this.getConnectionQueue(), this.editor.getText(), direction);
		if (text === undefined) return;
		this.setEditorTextFromQueueSelection(text);
		this.ui.requestRender();
	}

	/** Serializes queue mutations so rapid keypresses never race each other or use stale indices. */
	private enqueueQueueMutation<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queueMutationChain.then(run, run);
		this.queueMutationChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private moveQueueSelection(direction: -1 | 1): void {
		if (this.pendingQueueEdit || !this.queueSelection.selected) return;
		const sessionGeneration = this.sessionEventGeneration;
		void this.enqueueQueueMutation(async () => {
			if (sessionGeneration !== this.sessionEventGeneration) return;
			const selected = this.queueSelection.selected;
			if (!selected) return;
			this.pendingQueueMove = true;
			const actionsBefore = this.connectionState?.sessionActions;
			try {
				const status = await this.agentConnection.mutateQueuedMessage(
					selected.lane,
					selected.index,
					selected.text,
					{
						type: "move",
						direction,
					},
				);
				if (sessionGeneration !== this.sessionEventGeneration) return;
				await this.sessionEventQueue;
				if (sessionGeneration !== this.sessionEventGeneration) return;
				// The move's event can land after the response; mirror it locally (events assign a fresh sessionActions).
				if (status === "applied" && actionsBefore && this.connectionState?.sessionActions === actionsBefore) {
					const queue = this.getConnectionQueue();
					const lane = queue[selected.lane];
					const target = selected.index + direction;
					if (lane[selected.index] === selected.text && target >= 0 && target < lane.length) {
						[lane[selected.index], lane[target]] = [lane[target] as string, selected.text];
						this.patchConnectionState({
							sessionActions: { ...actionsBefore, steering: queue.steering, followUps: queue.followUp },
						});
						this.updatePendingMessagesDisplay();
					}
				}
				this.refreshQueueSelectionAt(
					this.getConnectionQueue(),
					selected,
					status === "applied" ? selected.index + direction : selected.index,
				);
				if (status === "applied") this.ui.requestRender();
				else if (status === "unsupported") this.showStatus("修改排队消息需要更新后台服务");
				else this.showStatus("排队消息已变化，没有调整顺序");
			} finally {
				this.pendingQueueMove = false;
			}
		}).catch((error) => {
			if (sessionGeneration === this.sessionEventGeneration) {
				this.refreshQueueSelectionFromState();
				this.showError(error instanceof Error ? error.message : String(error));
			}
		});
	}

	/**
	 * Applies the edited text to the selected queued message. Returns true when
	 * the submission was consumed (the caller must not treat it as a new prompt).
	 * Empty text deletes; otherwise replaces, moving the item to `targetLane`.
	 */
	private applyQueueSelection(text: string, targetLane: "steering" | "followUp"): Promise<boolean> {
		if (this.pendingQueueEdit || !this.queueSelection.selected) return Promise.resolve(false);
		const pendingQueueEdit = Symbol("pending-queue-edit");
		this.pendingQueueEdit = pendingQueueEdit;
		const sessionGeneration = this.sessionEventGeneration;
		const submissionGeneration = this.inputSubmissionGeneration;
		const trimmed = text.trim();
		const mutation =
			trimmed.length === 0
				? ({ type: "delete" } as const)
				: ({
						type: "replace",
						text: trimmed,
						images: this.collectQueueReplaceImages(trimmed),
						lane: targetLane,
					} as const);
		const editorTextBefore = this.editor.getText();
		const discardStaleSelection = (): boolean => {
			if (sessionGeneration === this.sessionEventGeneration) return false;
			if (this.pendingQueueEdit === pendingQueueEdit) {
				this.pendingQueueEdit = undefined;
				this.queueSelection.reset();
				if (submissionGeneration === this.inputSubmissionGeneration && this.editor.getText() === editorTextBefore) {
					this.setEditorTextFromQueueSelection("");
				}
				this.ui.requestRender();
			}
			return true;
		};
		return this.enqueueQueueMutation(async () => {
			if (discardStaleSelection()) return true;
			const selected = this.queueSelection.selected;
			let status: AgentConnectionQueuedMessageMutationStatus;
			if (selected) {
				try {
					status = await this.agentConnection.mutateQueuedMessage(
						selected.lane,
						selected.index,
						selected.text,
						mutation,
					);
				} catch (error) {
					if (discardStaleSelection()) return true;
					// The editor was already cleared by Enter; restore the edit before surfacing the error.
					const editorUntouched =
						submissionGeneration === this.inputSubmissionGeneration && this.editor.getText() === editorTextBefore;
					if (editorUntouched) {
						this.setEditorTextFromQueueSelection(text);
					}
					if (!this.queueSelection.isBrowsing) {
						this.queueSelection.replaceDraft(editorUntouched ? text : this.editor.getText());
					}
					throw error;
				}
			} else {
				status = "rejected";
			}
			if (discardStaleSelection()) return true;
			const editorUntouched =
				submissionGeneration === this.inputSubmissionGeneration && this.editor.getText() === editorTextBefore;
			if (status === "applied") {
				if (trimmed) this.editor.addToHistory?.(trimmed);
				const draft = this.queueSelection.reset();
				if (editorUntouched) this.setEditorTextFromQueueSelection(draft);
			} else {
				// Enter submissions clear the editor before onSubmit runs; restore the
				// edit so a failed mutation never swallows it.
				if (editorUntouched) this.setEditorTextFromQueueSelection(text);
				if (!this.queueSelection.isBrowsing) {
					this.queueSelection.replaceDraft(editorUntouched ? text : this.editor.getText());
				}
				if (status === "invalid") this.showStatus("改后的内容不是有效命令，已保留在输入框里");
				else if (status === "unsupported") this.showStatus("修改排队消息需要更新后台服务");
				else this.showStatus("排队消息已变化，修改保留在输入框里");
			}
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
			return true;
		}).finally(() => {
			if (this.pendingQueueEdit === pendingQueueEdit) {
				this.pendingQueueEdit = undefined;
				// Queue events were not reconciled while the edit was pending; drop a now-stale selection.
				this.refreshQueueSelectionFromState();
			}
		});
	}

	/**
	 * Images for a queue replace: undefined preserves the server's images (some
	 * markers cannot be resolved by this client), [] clears, a list replaces.
	 */
	private collectQueueReplaceImages(text: string): ImageContent[] | undefined {
		const markers = [...new Set(imageMarkerIds(text))];
		if (markers.length === 0) return [];
		const resolved = markers.map((markerId) => this.pastedImages.get(markerId));
		return resolved.every((image) => image !== undefined)
			? resolved.map((image) => ({ ...(image as ImageContent) }))
			: undefined;
	}

	private setEditorTextFromQueueSelection(text: string): void {
		this.isApplyingQueueSelectionText = true;
		try {
			this.editor.setText(text);
		} finally {
			this.isApplyingQueueSelectionText = false;
		}
	}

	private getQueueSelectionHeader(): string | undefined {
		const selected = this.queueSelection.selected;
		if (!selected) return undefined;
		const lane = selected.lane === "steering" ? "插话" : "稍后发送";
		const older = this.getAppKeyDisplay("app.message.navigateOlder");
		const newer = this.getAppKeyDisplay("app.message.navigateNewer");
		const earlier = this.getAppKeyDisplay("app.message.moveEarlier");
		const later = this.getAppKeyDisplay("app.message.moveLater");
		const queue = this.getAppKeyDisplay("app.message.followUp");
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const cancel = this.getAppKeyDisplay("app.input.clear");
		const parts = [
			`正在改排队消息（${lane} 第 ${selected.index + 1} 条）`,
			older && newer ? `${older}/${newer} 切换` : "",
			earlier && later ? `${earlier}/${later} 调顺序` : "",
			submit ? `${submit} 改后插话` : "",
			queue ? `${queue} 改后稍后发送` : "",
			"清空后发送即删除",
			cancel ? `${cancel} 不改了` : "",
		];
		return theme.fg("dim", parts.filter((part) => part.length > 0).join(" · "));
	}

	private updateEditorBorderColor(): void {
		const editorTheme = getEditorTheme();
		this.editor.borderColor = editorTheme.borderColor;
		this.editor.backgroundColor = editorTheme.backgroundColor;
		this.ui.requestRender();
	}

	private getPromptContextContainers(): Container[] {
		return [
			this.dutyLogContainer,
			this.recapContainer,
			this.featureHintContainer,
			this.queuedMessagesContainer,
			this.sideQuestionContainer,
		];
	}

	private getPromptDockComponents(): Component[] {
		// U6: ① tray info line, ② footer watermark, ③ subagents line.
		return [this.trayInfoLine, this.editorContainer, this.footerSlot, this.subagentSummaryLine];
	}

	/** What the fullscreen transcript window scrolls over, top to bottom. */
	private getFullscreenScrollComponents(): Component[] {
		return [
			this.headerContainer,
			this.mainViewContainer,
			this.widgetContainerAbove,
			...this.getPromptContextContainers(),
			this.widgetContainerBelow,
		];
	}

	/** Enter or leave fullscreen rendering without touching the persisted setting. */
	private applyFullscreen(enabled: boolean): void {
		if (enabled) {
			if (!process.stdout.isTTY) return;
			this.ui.enterFullscreen({
				scroll: this.getFullscreenScrollComponents(),
				dock: this.promptDock,
				pin: this.topBar,
				mouse: this.settingsManager.getFullscreenMouse(),
			});
		} else {
			this.ui.exitFullscreen();
		}
	}

	private setFullscreenMode(enabled: boolean): void {
		this.settingsManager.setFullscreen(enabled);
		if (enabled && !process.stdout.isTTY) {
			this.fullscreenEnabled = false;
			this.showStatus("全屏模式需要在交互式终端里使用");
			return;
		}
		this.fullscreenEnabled = enabled;
		void (async () => {
			if (enabled && this.chatTranscriptTrimmed) {
				// Fullscreen pageUp/top scroll the whole transcript; restore the tail
				// trimmed by the live component cap before entering.
				try {
					await this.rebuildChatFromMessages();
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
					return;
				}
			}
			this.applyFullscreen(enabled);
			const followKey = this.getEditorKeyDisplay("tui.viewport.follow");
			this.showStatus(
				enabled
					? `Fullscreen rendering on — wheel/pageUp scroll, ${followKey} follows output`
					: "Fullscreen rendering off",
			);
		})();
	}

	/** /speed on/off: toggles the footer tok/sec readout for this session. */
	private setSpeedDisplay(enabled: boolean): void {
		this.speedDisplayEnabled = enabled;
		if (!enabled) {
			this.resetSpeedStats();
		}
		this.footer.setSpeedEnabled(enabled);
		this.showStatus(
			enabled
				? "Speed display on — footer shows output tok/s per model response and a session average"
				: "Speed display off",
		);
		this.ui.requestRender();
	}

	/** Clears per-session tok/sec stats and the footer readout; keeps the display flag. */
	private resetSpeedStats(): void {
		this.speedStats = undefined;
		this.footer.setSpeedText(undefined);
	}

	/**
	 * Updates the footer tok/sec readout from a completed assistant message:
	 * output tokens over the wall-clock span from the message timestamp (set at
	 * provider stream start) to this message_end arrival. Timestamps keep the span
	 * true even when buffered session events replay back-to-back on attach.
	 * Aborted/failed responses and samples without a finite positive span or token
	 * count are skipped: some providers only fill usage at stream end, and extension
	 * message replacements may strip fields, so they never produce a bogus rate.
	 */
	private recordSpeedSample(message: AssistantMessage): void {
		if (!this.speedDisplayEnabled || message.stopReason === "aborted" || message.stopReason === "error") {
			return;
		}
		const durationMs = Date.now() - Number(message.timestamp);
		const outputTokens = Number(message.usage?.output ?? 0);
		if (!(durationMs > 0) || !(outputTokens > 0)) {
			return;
		}
		this.speedStats ??= { tokens: 0, durationMs: 0, samples: 0 };
		this.speedStats.tokens += outputTokens;
		this.speedStats.durationMs += durationMs;
		this.speedStats.samples++;
		const formatRate = (tokensPerSecond: number): string =>
			tokensPerSecond >= 100 ? tokensPerSecond.toFixed(0) : tokensPerSecond.toFixed(1);
		const last = formatRate(outputTokens / (durationMs / 1000));
		const average = formatRate(this.speedStats.tokens / (this.speedStats.durationMs / 1000));
		this.footer.setSpeedText(this.speedStats.samples > 1 ? `${last} tok/s · avg ${average}` : `${last} tok/s`);
	}

	/**
	 * U6 K3 ②: the latest turn in the chat tree (chat-tail anchored - the
	 * viewport-bottom turn in the common case; a session with no turns yet
	 * returns undefined and callers fall back to the global lanes).
	 */
	/**
	 * TUI v4 T8: the open order of the quiet conversation's process blocks.
	 * Esc (editor empty, nothing running) walks this backwards - the
	 * last-opened block folds first, 块→尾注→turn 逐层收.
	 */
	private processBlockOpenOrder?: Array<{
		summary: TurnSummaryComponent;
		lane: "thinking" | "process" | "comms";
	}>;

	/** Open blocks of every turn in the chat, keyed by the turn's first tool call id. */
	private captureTurnLanes(): Map<string, { process: boolean; keySteps: boolean; thinking: boolean; comms: boolean }> {
		const lanes = new Map<string, { process: boolean; keySteps: boolean; thinking: boolean; comms: boolean }>();
		for (const child of this.chatContainer.children) {
			if (!(child instanceof TurnSummaryComponent)) continue;
			const state = child.state;
			const firstStep = state.steps[0]?.toolCallId;
			const open = state.processBlockExpanded || state.thinkingBlockExpanded || state.commsBlockExpanded;
			if (!firstStep || !open) continue;
			lanes.set(firstStep, {
				process: state.processBlockExpanded,
				keySteps: state.processKeyStepsArmed,
				thinking: state.thinkingBlockExpanded,
				comms: state.commsBlockExpanded,
			});
		}
		return lanes;
	}

	private recordProcessBlockOpen(summary: TurnSummaryComponent, lane: "thinking" | "process" | "comms"): void {
		if (!this.processBlockOpenOrder) {
			this.processBlockOpenOrder = [];
		}
		this.processBlockOpenOrder = this.processBlockOpenOrder.filter(
			(entry) => !(entry.summary === summary && entry.lane === lane),
		);
		this.processBlockOpenOrder.push({ summary, lane });
	}

	private forgetProcessBlock(summary: TurnSummaryComponent, lane: "thinking" | "process" | "comms"): void {
		this.processBlockOpenOrder = (this.processBlockOpenOrder ?? []).filter(
			(entry) => !(entry.summary === summary && entry.lane === lane),
		);
	}

	/** T8: fold the last-opened block; returns false when nothing is open. */
	private closeLastOpenedProcessBlock(): boolean {
		const entry = (this.processBlockOpenOrder ?? []).at(-1);
		if (!entry || !this.processBlockOpenOrder) {
			return false;
		}
		this.processBlockOpenOrder.pop();
		if (entry.lane === "thinking") {
			entry.summary.state.thinkingExpanded = false;
		} else if (entry.lane === "process") {
			entry.summary.setExpanded(false);
		} else {
			entry.summary.state.agentMessagesExpanded = false;
		}
		this.applyTurnExpansion(entry.summary);
		return true;
	}

	/** Whether the chat's tail is a quiet turn (its summary comes after the latest user message). */
	private isInsideQuietTurn(): boolean {
		if (this.settingsManager.getProcessMode() !== "quiet") return false;
		const children = this.chatContainer.children;
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (child instanceof TurnSummaryComponent) return true;
			if (child instanceof UserMessageComponent) return false;
		}
		return false;
	}

	private latestTurnSummary(): TurnSummaryComponent | undefined {
		const children = this.chatContainer.children;
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i];
			if (child instanceof TurnSummaryComponent) {
				return child;
			}
		}
		return undefined;
	}

	/**
	 * Applies the lanes to one turn's span: the summary itself and every child
	 * after it until the next turn's summary. Turn-less children (before the
	 * first summary) read the global lanes.
	 */
	private applyTurnExpansion(summary: TurnSummaryComponent): void {
		if (!this.applyTurnLanes(summary)) {
			this.applyChatExpansion();
			return;
		}
		this.requestExpansionRender();
	}

	/** Push a turn's lanes onto its children; false when the summary is not in the chat. */
	private applyTurnLanes(summary: TurnSummaryComponent): boolean {
		const children = this.chatContainer.children;
		const start = children.indexOf(summary);
		if (start < 0) {
			return false;
		}
		const state = summary.state;
		summary.setExpanded(!state.isCollapsed);
		for (let i = start + 1; i < children.length; i++) {
			const child = children[i];
			if (child instanceof TurnSummaryComponent) {
				break;
			}
			applyExpansionLanes(child, {
				thinking: state.thinkingExpanded,
				tools: !state.isCollapsed,
				agentMessages: state.agentMessagesExpanded,
				editDiffs: !state.isCollapsed,
			});
		}
		return true;
	}

	private toggleToolOutputExpansion(global = false): void {
		// U6 (boss's two-key model): Ctrl+O owns the process surface — tool
		// calls, outputs, and edit diffs ride the same expanded state. The plain
		// key acts on the latest turn; Alt+O acts globally (K3 ②).
		if (!global) {
			const summary = this.latestTurnSummary();
			if (summary) {
				this.cycleTurnProcess(summary);
				return;
			}
		}
		this.editDiffsExpanded = !this.toolOutputExpanded;
		this.syncAllTurnLanes(!this.toolOutputExpanded, "tools");
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	/** One Ctrl+O press on one turn's process block (also Enter on a focused process line). */
	private cycleTurnProcess(summary: TurnSummaryComponent): void {
		if (this.settingsManager.getProcessMode() === "quiet") {
			// TUI v4 T6: a three-state cycle - closed → key steps (first
			// 3 + ⋯ + last 3 while >8 steps) → all steps → closed.
			// Legacy keeps the binary toggle.
			if (summary.state.isCollapsed) {
				// The key-steps fold only applies to a turn already long when
				// opened; a turn that grows past the threshold while open stays
				// fully open instead of folding under the reader.
				summary.state.setProcessKeySteps(summary.state.stepCount > PROCESS_FOLD_THRESHOLD);
				summary.setExpanded(true);
				this.recordProcessBlockOpen(summary, "process");
			} else if (summary.state.processKeyStepsView) {
				summary.state.setProcessKeySteps(false);
			} else {
				summary.setExpanded(false);
				this.forgetProcessBlock(summary, "process");
			}
		} else {
			const next = summary.state.isCollapsed;
			summary.setExpanded(next);
		}
		this.applyTurnExpansion(summary);
	}

	/** One Ctrl+T press on one turn's traces (also Enter on a focused answer). */
	private toggleTurnThinking(summary: TurnSummaryComponent): void {
		const next = !summary.state.thinkingExpanded;
		summary.state.thinkingExpanded = next;
		// T8: the open order records which block opened last.
		if (next) {
			this.recordProcessBlockOpen(summary, "thinking");
		} else {
			this.forgetProcessBlock(summary, "thinking");
		}
		// The opened or folded trace is the feedback; a status row per
		// press would pile up in the chat.
		this.applyTurnExpansion(summary);
	}

	/**
	 * A click on a turn's `◆ prime` header or footnote changed its lanes: record
	 * them in the Esc close order and push them onto the turn's rows, exactly as
	 * the keys would.
	 */
	private handleTurnLanesClicked(summary: TurnSummaryComponent): void {
		const state = summary.state;
		const lanes = [
			["thinking", state.thinkingBlockExpanded],
			["process", state.processBlockExpanded],
			["comms", state.commsBlockExpanded],
		] as const;
		for (const [lane, open] of lanes) {
			const recorded = (this.processBlockOpenOrder ?? []).some(
				(entry) => entry.summary === summary && entry.lane === lane,
			);
			if (open && !recorded) this.recordProcessBlockOpen(summary, lane);
			if (!open && recorded) this.forgetProcessBlock(summary, lane);
		}
		this.applyTurnExpansion(summary);
		if (this.blockNavigation) this.applyBlockFocus();
	}

	/** A new turn head, wired so its own clicks apply like the keys. */
	private createTurnSummary(state: TurnActivityState): TurnSummaryComponent {
		const summary = new TurnSummaryComponent(state);
		summary.setOnLanesChange(() => this.handleTurnLanesClicked(summary));
		return summary;
	}

	/**
	 * Lift or restore the expanded-output render budget (tool-output-budget.ts).
	 * Expanded blocks revalidate their cached lines against the budget mode when they
	 * render, so this only has to ask for a frame - applyChatExpansion does that and
	 * keeps the viewport anchored exactly like the ctrl+o toggle.
	 */
	private toggleToolOutputFull(): void {
		if (!setToolOutputFull(!toolOutputFull())) {
			return;
		}
		// The held-back rows appearing or folding are the feedback.
		this.applyChatExpansion();
	}

	private toggleAgentMessageExpansion(global = false): void {
		// U6: Ctrl+P keeps its own lane - agent message rows only. The plain key
		// acts on the latest turn; Alt+P acts globally (K3 ②).
		if (!global) {
			const summary = this.latestTurnSummary();
			if (summary) {
				const next = !summary.state.agentMessagesExpanded;
				summary.state.agentMessagesExpanded = next;
				// T8: the open order records which block opened last.
				if (next) {
					this.recordProcessBlockOpen(summary, "comms");
				} else {
					this.forgetProcessBlock(summary, "comms");
				}
				this.applyTurnExpansion(summary);
				return;
			}
		}
		this.agentMessagesExpanded = !this.agentMessagesExpanded;
		this.syncAllTurnLanes(this.agentMessagesExpanded, "agentMessages");
		this.applyChatExpansion();
	}

	private toggleEditDiffExpansion(): void {
		this.editDiffsExpanded = !this.editDiffsExpanded;
		this.applyChatExpansion();
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		this.applyChatExpansion();
	}

	/** Writes one lane's value into every turn's state (the Alt-global path, K3 ②). */
	private syncAllTurnLanes(value: boolean, lane: "thinking" | "tools" | "agentMessages"): void {
		for (const child of this.chatContainer.children) {
			if (child instanceof TurnSummaryComponent) {
				if (lane === "thinking") child.state.thinkingExpanded = value;
				if (lane === "agentMessages") child.state.agentMessagesExpanded = value;
				if (lane === "tools") child.setExpanded(value);
			}
		}
	}

	private applyChatExpansion(): void {
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(this.toolOutputExpanded);
		}
		// K3 ②: the walk is turn-aware - each turn's children read that turn's
		// lanes; children before the first summary (turn-less) read the globals.
		const globalLanes = {
			thinking: this.thinkingExpanded,
			tools: this.toolOutputExpanded,
			agentMessages: this.agentMessagesExpanded,
			editDiffs: this.editDiffsExpanded,
		};
		let turnLanes: { thinking: boolean; tools: boolean; agentMessages: boolean; editDiffs: boolean } | undefined;
		for (const child of this.chatContainer.children) {
			if (child instanceof TurnSummaryComponent) {
				const state = child.state;
				child.setExpanded(!state.isCollapsed);
				turnLanes = {
					thinking: state.thinkingExpanded,
					tools: !state.isCollapsed,
					agentMessages: state.agentMessagesExpanded,
					editDiffs: !state.isCollapsed,
				};
				continue;
			}
			applyExpansionLanes(child, turnLanes ?? globalLanes);
		}
		if (this.ui.isFullscreen()) {
			this.ui.requestRender();
		} else {
			this.ui.requestRenderPreservingViewport();
		}
	}

	/**
	 * Expanding/collapsing changes blocks above the viewport, which would
	 * otherwise force a full redraw that scrolls to the top and replays the
	 * whole transcript. Keep the user anchored at their current position.
	 * Fullscreen frames have no scrollback to preserve.
	 */
	private requestExpansionRender(): void {
		if (this.ui.isFullscreen()) {
			this.ui.requestRender();
		} else {
			this.ui.requestRenderPreservingViewport();
		}
	}

	private toggleThinkingBlockVisibility(global = false): void {
		// U6 (boss's two-key model): Ctrl+T owns the thinking block — it
		// expands/collapses the turn's thinking traces. The turn header stays
		// visible either way; the persisted hideThinkingBlock setting (never
		// show traces) is no longer bound to the key, and a press while it is
		// on guides the user to it instead of silently doing nothing (K3 ④).
		// The plain key acts on the latest turn; Alt+T acts globally (K3 ②).
		if (this.hideThinkingBlock) {
			this.showStatus("Thinking 已被 hideThinkingBlock 设置隐藏：关闭该设置后 Ctrl+T 可展开");
			return;
		}
		if (!global) {
			const summary = this.latestTurnSummary();
			if (summary) {
				this.toggleTurnThinking(summary);
				return;
			}
		}
		this.thinkingExpanded = !this.thinkingExpanded;
		this.syncAllTurnLanes(this.thinkingExpanded, "thinking");
		this.applyChatExpansion();
	}

	private openExternalEditor(): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("没有配置编辑器。请设置 $VISUAL 或 $EDITOR 环境变量。");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const temp = createPrivateTempFile("pi-editor-", ".pi.md", currentText);
		const tmpFile = temp.path;

		try {
			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			// On successful exit (status 0), replace editor content
			if (result.status === 0) {
				const newContent = readPrivateFile(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			try {
				// Cleanup failures must not leave the terminal UI stopped.
				fs.rmSync(temp.directory, { recursive: true, force: true });
			} finally {
				// Restart TUI
				this.ui.start();
				// ui.stop() left fullscreen so the editor got a clean terminal
				if (this.fullscreenEnabled) {
					this.applyFullscreen(true);
				}
				// Force full re-render since external editor uses alternate screen
				this.ui.requestRender(true);
			}
		}
	}

	private clearInputBar(): void {
		this.clearEscapeRepeat();
		this.clearCtrlCExitHint({ render: false });
		// Leaving browse mode restores the stashed draft instead of arming an
		// accidental empty-submit delete of the selected queued message.
		this.editor.setText(this.queueSelection.hasDraft ? this.queueSelection.reset() : "", { clearUndo: false });
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		// One blank line between chat blocks; the first block follows the header's own spacing.
		if (this.chatContainer.children.length > 0) this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new FocusableTextBlock(theme.fg("error", `出错：${errorMessage}`), `出错：${errorMessage}`),
		);
		this.ui.requestRender();
	}

	/**
	 * The stall's forensic lines, asked for with the diagnostics key: dim, titled, never an
	 * error. The block is long and only worth a look, so the same key closes it again; a
	 * live stall bar keeps that key for itself (it opens the newer stall's lines instead).
	 */
	private showStallDiagnostics(event: StallEventView): void {
		this.closeStallDiagnostics({ render: false });
		const components: Component[] = [];
		if (this.chatContainer.children.length > 0) components.push(new Spacer(1));
		const closeKey = keyText("app.stall.diagnostics");
		// The owner reads the plain explanation; the machine lines below it are for a developer.
		const body = [
			theme.fg("muted", "诊断详情"),
			...formatStallExplanation(event, {
				interruptKey: keyText("app.input.clear"),
				sinceEventMs: this.stallQuietSinceEventMs(),
			}),
			theme.fg("muted", "下面是给开发者看的原始记录，可以不看："),
			...formatStallEventLines(event).map((line) => theme.fg("dim", line)),
		];
		const withHint = new Text(
			[...body, ...(closeKey.trim().length > 0 ? [theme.fg("muted", `${closeKey} 收起`)] : [])].join("\n"),
			1,
			0,
		);
		const plain = new Text(body.join("\n"), 1, 0);
		// The close key only belongs to the block while it is the newest thing in the chat. Once
		// anything follows it (a reply, the next message, a notice) it is history, possibly far off
		// screen, and the key goes back to its editor meaning (yank); the hint goes with it.
		const isNewest = (): boolean => this.chatContainer.children.at(-1) === block;
		const block: Component = {
			render: (width) => (isNewest() ? withHint : plain).render(width),
			invalidate: () => {
				withHint.invalidate();
				plain.invalidate();
			},
		};
		components.push(block);
		for (const component of components) this.chatContainer.addChild(component);
		const removeInputListener = this.ui.addInputListener((data) => {
			if (isMouseSequence(data) || isKeyRelease(data)) return undefined;
			if (!this.keybindings.matches(data, "app.stall.diagnostics")) return undefined;
			if (this.stallActionBar !== undefined && !this.stallActionBar.isDismissed) return undefined;
			if (!this.stallRoutesOwnKeyboard()) return undefined;
			if (!isNewest()) {
				// Released, not removed: the block stays in history as a reference. Cleared chat
				// (/new, resume) lands here too, with nothing left to close.
				this.releaseStallDiagnostics();
				return undefined;
			}
			this.closeStallDiagnostics();
			return { consume: true };
		});
		this.stallDiagnosticsPanel = { components, removeInputListener };
		this.ui.requestRender();
	}

	/** Stop the close key from reaching the diagnostics block; the block itself stays. */
	private releaseStallDiagnostics(): void {
		const panel = this.stallDiagnosticsPanel;
		if (panel === undefined) return;
		this.stallDiagnosticsPanel = undefined;
		panel.removeInputListener();
	}

	private closeStallDiagnostics(options: { render?: boolean } = {}): void {
		const panel = this.stallDiagnosticsPanel;
		if (panel === undefined) return;
		this.stallDiagnosticsPanel = undefined;
		panel.removeInputListener();
		for (const component of panel.components) this.chatContainer.removeChild(component);
		if (options.render !== false) this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		if (this.chatContainer.children.length > 0) this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(
			new FocusableTextBlock(theme.fg("warning", `⚠ ${warningMessage}`), `⚠ ${warningMessage}`),
		);
		this.ui.requestRender();
	}

	showNewVersionNotification(newVersion: string): void {
		this.chatContainer.addChild(new Text(formatUpdateAvailableNotice(newVersion), 1, 0));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		this.chatContainer.addChild(new Text(formatPackageUpdateNotice(packages), 1, 0));
		this.ui.requestRender();
	}

	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return this.getConnectionQueue();
	}

	private updatePendingMessagesDisplay(): void {
		// pendingMessagesContainer holds only in-flight bash output for the current
		// turn, so it stays above the execution indicator. clear() detaches the
		// components but they stay tracked in pendingBashComponents until flushed.
		this.pendingMessagesContainer.clear();
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.addChild(component);
		}
		// Queued steering/follow-up previews are future turns, so they render in
		// their own container below the execution indicator and recap.
		this.queuedMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		const hasQueuedMessages = steeringMessages.length > 0 || followUpMessages.length > 0;
		if (hasQueuedMessages) {
			this.queuedMessagesContainer.addChild(new Spacer(1));
			// While compaction is in flight these queued turns cannot be delivered yet;
			// open the queue frame with a header that says so. N comes from the same
			// steering/followUp arrays rendered below (matching sessionActions.queuedCount,
			// which is derived from them) so the number can never drift from the visible rows.
			if (this.isAgentCompacting()) {
				const queuedCount = steeringMessages.length + followUpMessages.length;
				const compactionText = theme.fg(
					"dim",
					`╭─ 正在压缩上下文 · ${queuedCount} 条排队（代理消息等压缩完成后送达）`,
				);
				this.queuedMessagesContainer.addChild(new TruncatedText(compactionText, 1, 0));
			}
			for (const message of steeringMessages) {
				const text = styleQueuedMessagePreview(message, "Steering", (name) => this.isRecognizedSlashCommand(name));
				this.queuedMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = styleQueuedMessagePreview(message, "Follow-up", (name) => this.isRecognizedSlashCommand(name));
				this.queuedMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.navigateOlder");
			// While idle the queue is parked (an interrupt suspended it); tell the user Enter sends it.
			const submitKey = keyText("tui.input.submit");
			const sendHint = this.isAgentStreaming() || !submitKey ? "" : `${submitKey} 发送 · `;
			const hintText = theme.fg("dim", `╰─ ${sendHint}${dequeueHint} 查看或修改排队消息`);
			this.queuedMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
		if (hasQueuedMessages && !this.featureHintSuppressedByQueue) {
			this.featureHintSuppressedByQueue = true;
			this.clearFeatureHintPresentation();
		} else if (!hasQueuedMessages && this.featureHintSuppressedByQueue) {
			this.featureHintSuppressedByQueue = false;
			this.resumeFeatureHintPresentation();
		}
	}

	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private showFullPaneOverlay(component: Component, options: number | FullPaneOverlayOptions = 80): OverlayHandle {
		return showFullPaneOverlay(this.ui, component, options);
	}

	/**
	 * Apply a change made in the settings panel. Settings writes are queued and their failures are
	 * recorded rather than thrown, so a toggle used to look accepted while nothing reached disk;
	 * report the reason and the session-only consequence instead of staying silent (H-2).
	 */
	private applySetting(mutate: () => void): void {
		mutate();
		void this.settingsManager.persistenceFailure().then((reason) => {
			if (reason) {
				this.showError(`设置没有保存：${reason} 这次改动只在本次会话里有效，会话结束就恢复原样。`);
			}
		});
	}

	private async showSettingsSelector(): Promise<void> {
		let state: AgentConnectionState;
		try {
			state = await this.agentConnection.getState();
			this.applyConnectionStateSnapshot(state);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: state.autoCompactionEnabled,
					idleEvictionMinutes: this.settingsManager.getIdleEvictionMinutes(),
					showImages: this.settingsManager.getShowImages(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					enableBuiltinSkills: this.settingsManager.getEnableBuiltinSkills(),
					steeringMode: state.steeringMode,
					followUpMode: state.followUpMode,
					transport: this.settingsManager.getTransport(),
					thinkingLevel: state.thinkingLevel,
					availableThinkingLevels: state.availableThinkingLevels,
					currentTheme: this.settingsManager.getTheme() || "prime",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					mermaidRenderingMode: this.settingsManager.getMermaidRenderingMode(),
					processMode: this.settingsManager.getProcessMode(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					fullscreen: this.fullscreenEnabled,
					warnings: this.settingsManager.getWarnings(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.patchConnectionState({ autoCompactionEnabled: enabled });
						void this.agentConnection.setAutoCompactionEnabled(enabled).catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
						this.footer.setAutoCompactEnabled(enabled);
					},
					onIdleEvictionMinutesChange: (value) => {
						this.applySetting(() => this.settingsManager.setIdleEvictionMinutes(value));
					},
					onShowImagesChange: (enabled) => {
						this.applySetting(() => this.settingsManager.setShowImages(enabled));
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.applySetting(() => this.settingsManager.setImageAutoResize(enabled));
					},
					onBlockImagesChange: (blocked) => {
						this.applySetting(() => this.settingsManager.setBlockImages(blocked));
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.applySetting(() => this.settingsManager.setEnableSkillCommands(enabled));
						this.setupAutocompleteProvider();
					},
					onEnableBuiltinSkillsChange: (enabled) => {
						this.applySetting(() => this.settingsManager.setEnableBuiltinSkills(enabled));
						void this.handleReloadCommand();
					},
					onSteeringModeChange: (mode) => {
						this.patchConnectionState({ steeringMode: mode });
						void this.agentConnection.setSteeringMode(mode).catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
					},
					onFollowUpModeChange: (mode) => {
						this.patchConnectionState({ followUpMode: mode });
						void this.agentConnection.setFollowUpMode(mode).catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
					},
					onTransportChange: (transport) => {
						void this.agentConnection.setTransport(transport).catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
					},
					onThinkingLevelChange: (level) => {
						void this.agentConnection
							.setThinkingLevel(level)
							.then(() => {
								this.patchConnectionState({ thinkingLevel: level });
								this.footer.invalidate();
								this.updateEditorBorderColor();
							})
							.catch((error) => {
								this.showError(error instanceof Error ? error.message : String(error));
							});
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.applySetting(() => this.settingsManager.setTheme(themeName));
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`主题 "${themeName}" 加载失败：${result.error}\n已换回深色主题。`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.applySetting(() => this.settingsManager.setHideThinkingBlock(hidden));
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						void this.rebuildChatFromMessages().catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
					},
					onMermaidRenderingModeChange: (mode) => {
						this.applySetting(() => this.settingsManager.setMermaidRenderingMode(mode));
						this.chatContainer.invalidate();
						this.ui.requestRender();
					},
					onProcessModeChange: (mode) => {
						this.applySetting(() => this.settingsManager.setProcessMode(mode));
						// TUI v4 T7: the tighter per-step window follows the mode.
						setQuietConversationBudget(mode === "quiet");
						// The gate lives in the assistant components' render, so
						// the new face needs one rebuild (same as hide-thinking).
						void this.rebuildChatFromMessages().catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
					},
					onQuietStartupChange: (enabled) => {
						this.applySetting(() => this.settingsManager.setQuietStartup(enabled));
					},
					onTreeFilterModeChange: (mode) => {
						this.applySetting(() => this.settingsManager.setTreeFilterMode(mode));
					},
					onShowHardwareCursorChange: (enabled) => {
						this.applySetting(() => this.settingsManager.setShowHardwareCursor(enabled));
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.applySetting(() => this.settingsManager.setEditorPaddingX(padding));
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.applySetting(() => this.settingsManager.setAutocompleteMaxVisible(maxVisible));
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.applySetting(() => this.settingsManager.setClearOnShrink(enabled));
						this.ui.setClearOnShrink(enabled);
					},
					onShowTerminalProgressChange: (enabled) => {
						this.applySetting(() => this.settingsManager.setShowTerminalProgress(enabled));
					},
					onFullscreenChange: (enabled) => {
						this.setFullscreenMode(enabled);
					},
					onWarningsChange: (warnings) => {
						this.applySetting(() => this.settingsManager.setWarnings(warnings));
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				const authFlows = this.createAuthFlows();
				const providerOptions = authFlows.getLoginProviderOptions();
				if (!(await this.ensureModelProviderConfigured(model, authFlows, providerOptions))) return;
				await this.completeModelSelection(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<Api> | undefined> {
		const cachedMatch = findExactModelReferenceMatch(searchTerm, this.getCachedModelCandidates());
		if (cachedMatch) {
			return cachedMatch;
		}

		const refreshPromise = this.getModelSelectorRefreshPromise({ force: true });
		if (!refreshPromise) {
			return undefined;
		}

		try {
			return findExactModelReferenceMatch(searchTerm, await refreshPromise);
		} catch {
			return undefined;
		}
	}

	private async applySelectedModel(model: AgentConnectionModel): Promise<void> {
		const connection = this.agentConnection;
		const sessionId = this.connectionState?.sessionId;
		await connection.setModel(model.provider, model.id);
		const state = await connection.getState();
		if (
			this.agentConnection !== connection ||
			this.connectionState?.sessionId !== sessionId ||
			(sessionId !== undefined && state.sessionId !== sessionId)
		) {
			return;
		}
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		// The connection switched, so the model is in use; only the default for the next session is
		// at stake, and that part needs the write to have landed (H-2).
		const defaultSaveFailure = await this.settingsManager.persistenceFailure();
		if (defaultSaveFailure) {
			this.showError(
				`Default model ${model.provider}/${model.id} not saved: ${defaultSaveFailure} It applies to this session only and is lost when the session ends.`,
			);
		}
		this.applyModelSwitchUiState(state, model);
	}

	/**
	 * Re-read the session's model after an automatic switch (fallback chain, backup
	 * model, return to the primary). Those never go through model selection, so the
	 * footer kept naming the model that had stopped serving, in daemon mode too.
	 */
	private async refreshServingModel(): Promise<void> {
		const connection = this.agentConnection;
		const sessionId = this.connectionState?.sessionId;
		if (!connection || sessionId === undefined) return;
		const state = await connection.getState().catch(() => undefined);
		if (!state?.model || this.agentConnection !== connection || this.connectionState?.sessionId !== sessionId) return;
		const current = this.connectionState?.model;
		if (current && current.provider === state.model.provider && current.id === state.model.id) return;
		this.applyModelSwitchUiState(state, state.model);
	}

	/**
	 * Patch the model-derived connection state and refresh every face that reads it,
	 * so the header, model-selector highlight, /fast availability and /effort
	 * completions never keep describing the model that was just replaced.
	 */
	private applyModelSwitchUiState(
		state: Pick<AgentConnectionState, "model" | "serviceTier" | "availableThinkingLevels">,
		fallbackModel: AgentConnectionModel,
	): void {
		this.patchConnectionState({
			model: state.model ?? fallbackModel,
			serviceTier: state.serviceTier,
			availableThinkingLevels: state.availableThinkingLevels,
		});
		// The footer watermark carries the model · thinking level now; the
		// invalidation repaints the footer. Defensive for partial-mode harnesses
		// that stub only the pre-U6 method set.
		(this as unknown as { invalidateFooterTelemetry?: () => void }).invalidateFooterTelemetry?.();
		this.updateEditorBorderColor();
		// Rebuild so the /effort argument hint reflects the new model's levels.
		this.setupAutocompleteProvider();
	}

	private async completeModelSelection(model: AgentConnectionModel): Promise<void> {
		this.showStatus(`正在切换模型：${model.id}`);
		await this.applySelectedModel(model);
		this.showStatus(`模型：${model.id}`);
		void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
		this.checkDaxnutsEasterEgg(model);
	}

	private async ensureModelProviderConfigured(
		model: AgentConnectionModel,
		authFlows: ProviderAuthFlows,
		providerOptions: ReadonlyArray<AuthSelectorProvider>,
	): Promise<boolean> {
		if (this.isModelProviderConfigured(model)) return true;

		const provider = providerOptions.find(
			(option) => option.id === model.provider && (option.category ?? "provider") === "provider",
		);
		if (!provider) {
			this.showError(`${model.provider} 的登录需要在外部配置。`);
			return false;
		}

		const result = await authFlows.loginProvider(provider);
		if (result.status !== "success") return false;

		this.invalidateConnectionModels();
		await this.getConnectionAvailableModels();
		if (this.isModelProviderConfigured(model)) return true;

		this.showError(`已登录，但 ${model.provider} 仍不可用。`);
		return false;
	}

	private isModelProviderConfigured(model: AgentConnectionModel): boolean {
		return this.connectionConfiguredProviders.has(model.provider) || this.modelRegistry.hasConfiguredAuth(model);
	}

	private applyConnectionModelCatalog(catalog: AgentConnectionModelCatalog): void {
		this.connectionModelCatalog = [...catalog.models];
		this.connectionConfiguredProviders = new Set(catalog.configuredProviders);
	}

	private getAvailableConnectionModels(): AgentConnectionModel[] {
		return this.connectionModelCatalog.filter((model) => this.connectionConfiguredProviders.has(model.provider));
	}

	private async getConnectionAvailableModels(): Promise<AgentConnectionModel[]> {
		const inFlight = this.connectionModelsRefreshInFlight;
		if (inFlight && inFlight.version === this.connectionModelsRefreshVersion) {
			return [...(await inFlight.promise)];
		}

		const version = this.connectionModelsRefreshVersion;
		const promise = this.agentConnection.getModelCatalog().then((catalog) => {
			if (version !== this.connectionModelsRefreshVersion) {
				return this.getAvailableConnectionModels();
			}
			this.applyConnectionModelCatalog(catalog);
			this.connectionModelsFetchedAt = Date.now();
			return this.getAvailableConnectionModels();
		});
		this.connectionModelsRefreshInFlight = { version, promise };

		try {
			return [...(await promise)];
		} finally {
			if (this.connectionModelsRefreshInFlight?.promise === promise) {
				this.connectionModelsRefreshInFlight = undefined;
			}
		}
	}

	private async getConnectionModelCatalog(): Promise<AgentConnectionModel[]> {
		await this.getConnectionAvailableModels();
		return [...this.connectionModelCatalog];
	}

	private getCachedModelCandidates(): AgentConnectionModel[] {
		const modelsById = new Map<string, AgentConnectionModel>();
		for (const scoped of this.getScopedModelState()) {
			modelsById.set(`${scoped.model.provider}/${scoped.model.id}`, scoped.model);
		}
		for (const model of this.connectionModelCatalog) {
			modelsById.set(`${model.provider}/${model.id}`, model);
		}
		return [...modelsById.values()];
	}

	private getModelSelectorRefreshPromise(
		options: { force?: boolean } = {},
	): Promise<AgentConnectionModel[]> | undefined {
		const refreshCatalog = () => this.getConnectionAvailableModels().then(() => this.getCachedModelCandidates());
		if (this.connectionModelsRefreshInFlight) {
			return refreshCatalog();
		}
		if (options.force || this.connectionModelsFetchedAt === 0) {
			return refreshCatalog();
		}
		if (Date.now() - this.connectionModelsFetchedAt > MODEL_CATALOG_REFRESH_TTL_MS) {
			return refreshCatalog();
		}
		return undefined;
	}

	private invalidateConnectionModelRefresh(): void {
		this.connectionModelsRefreshVersion++;
		this.connectionModelsRefreshInFlight = undefined;
	}

	private invalidateConnectionModels(): void {
		this.connectionConfiguredProviders = new Set();
		this.connectionModelsFetchedAt = 0;
		this.invalidateConnectionModelRefresh();
	}

	private async refreshConnectionModelsAfterAuthChange(): Promise<void> {
		this.invalidateConnectionModels();
		await this.getConnectionAvailableModels();
	}

	private async getModelCandidates(): Promise<AgentConnectionModel[]> {
		const scopedModels = this.getScopedModelState();
		if (scopedModels.length > 0) {
			return scopedModels.map((scoped) => scoped.model);
		}

		try {
			return await this.getConnectionAvailableModels();
		} catch {
			return [];
		}
	}

	private getScopedModelsFromModelIds(
		enabledIds: readonly string[],
		allModels: readonly AgentConnectionModel[],
	): AgentConnectionState["scopedModels"] {
		const modelsById = new Map(allModels.map((model) => [`${model.provider}/${model.id}`, model]));
		const selectedIds = new Set<string>();
		const scopedModels: AgentConnectionState["scopedModels"] = [];

		for (const id of enabledIds) {
			if (selectedIds.has(id)) {
				continue;
			}

			const model = modelsById.get(id);
			if (!model) {
				continue;
			}

			selectedIds.add(id);
			scopedModels.push({ model });
		}

		return scopedModels;
	}

	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.getCurrentModel(),
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		const warning = await getAnthropicSubscriptionAuthWarning(this.modelRegistry, model);
		if (!warning) {
			return;
		}
		this.anthropicSubscriptionWarningShown = true;
		this.showWarning(warning);
	}

	private getAvailableThinkingLevels(): ThinkingLevel[] {
		const levels = this.connectionState?.availableThinkingLevels ?? [];
		const supportsThinking = levels.length > 0 && !(levels.length === 1 && levels[0] === "off");
		return supportsThinking ? levels : [];
	}

	private getThinkingLevelCompletions(prefix: string): AutocompleteItem[] | null {
		const levels = this.getAvailableThinkingLevels();
		if (levels.length === 0) return null;
		const current = this.connectionState?.thinkingLevel;
		const term = prefix.trim().toLowerCase();
		const matches = term ? levels.filter((level) => level.startsWith(term)) : levels;
		if (matches.length === 0) return null;
		return matches.map((level) => ({
			value: level,
			label: level,
			description:
				level === current ? `${THINKING_LEVEL_DESCRIPTIONS[level]} (current)` : THINKING_LEVEL_DESCRIPTIONS[level],
		}));
	}

	private getHeartbeatArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const term = prefix.trim().toLowerCase();
		const filtered = term
			? HEARTBEAT_ARGUMENT_COMPLETIONS.filter(
					(item) => item.value.toLowerCase().startsWith(term) || item.label.toLowerCase().startsWith(term),
				)
			: HEARTBEAT_ARGUMENT_COMPLETIONS;
		return filtered.length === 0 ? null : filtered;
	}

	private getTracesArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const term = prefix.trim().toLowerCase();
		const filtered = term
			? TRACES_ARGUMENT_COMPLETIONS.filter((item) => item.value.toLowerCase().startsWith(term))
			: TRACES_ARGUMENT_COMPLETIONS;
		return filtered.length === 0 ? null : filtered;
	}

	private currentModelSupportsFastMode(): boolean {
		const model = this.getCurrentModel();
		return model !== undefined && supportsFastMode(model);
	}

	private handleFastCommand(): void {
		const unavailableMessage =
			"Fast mode requires GPT-5.4, GPT-5.5, or GPT-5.6 with ChatGPT or OpenAI API key authentication";
		if (!this.currentModelSupportsFastMode()) {
			this.showStatus(unavailableMessage);
			return;
		}
		const connection = this.agentConnection;
		const sessionId = this.connectionState?.sessionId;
		this.fastModeToggleQueue = this.fastModeToggleQueue
			.then(async () => {
				if (this.agentConnection !== connection || this.connectionState?.sessionId !== sessionId) {
					return;
				}
				if (!this.currentModelSupportsFastMode()) {
					this.showStatus(unavailableMessage);
					return;
				}
				const enabled = this.connectionState?.serviceTier === "priority";
				const serviceTier: ServiceTier = enabled ? "default" : "priority";
				await connection.setServiceTier(serviceTier);
				if (this.agentConnection !== connection || this.connectionState?.sessionId !== sessionId) {
					return;
				}
				const state = await connection.getState();
				if (
					this.agentConnection !== connection ||
					this.connectionState?.sessionId !== sessionId ||
					state.sessionId !== sessionId
				) {
					return;
				}
				this.patchConnectionState({ serviceTier: state.serviceTier });
				this.footer.invalidate();
				this.showToast(`fast ${state.serviceTier === "priority" ? "on" : "off"}`);
			})
			.catch((error) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
	}

	private handleEffortCommand(arg: string): void {
		const levels = this.getAvailableThinkingLevels();
		if (levels.length === 0) {
			this.showStatus("当前模型不支持 Thinking");
			return;
		}
		const requested = arg.trim().toLowerCase();
		if (!requested) {
			this.showThinkingSelector(levels);
			return;
		}
		if (!levels.includes(requested as ThinkingLevel)) {
			this.showError(`没有 '${requested}' 这个推理强度，可选：${levels.join(", ")}`);
			return;
		}
		this.applyThinkingLevel(requested as ThinkingLevel);
	}

	private showThinkingSelector(levels: ThinkingLevel[] = this.getAvailableThinkingLevels()): void {
		const currentLevel = this.connectionState?.thinkingLevel ?? levels[0];
		if (!currentLevel) {
			this.showStatus("当前模型不支持 Thinking");
			return;
		}
		this.showSelector((done) => {
			const selector = new ThinkingSelectorComponent(
				currentLevel,
				levels,
				(level) => {
					done();
					this.applyThinkingLevel(level);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private applyThinkingLevel(level: ThinkingLevel): void {
		void this.agentConnection
			.setThinkingLevel(level)
			.then(() => {
				this.patchConnectionState({ thinkingLevel: level });
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showToast(`thinking ${level}`);
			})
			.catch((error) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
	}

	/**
	 * Cycle the session model (app.model.cycleForward/cycleBackward). The connection and
	 * the session id are captured before the await, like applySelectedModel, so a session
	 * switch mid-cycle discards the stale result instead of applying it to whichever
	 * session is active when the answer lands.
	 */
	private handleModelCycle(direction: "forward" | "backward"): void {
		const connection = this.agentConnection;
		const sessionId = this.connectionState?.sessionId;
		void connection
			.cycleModel(direction)
			.then(async (result) => {
				// Also the singleton scope and single-model cases: nothing else to cycle to.
				if (!result) {
					this.showStatus("没有其他可切换的模型");
					return;
				}
				const state = await connection.getState();
				if (
					this.agentConnection !== connection ||
					this.connectionState?.sessionId !== sessionId ||
					(sessionId !== undefined && state.sessionId !== sessionId)
				) {
					return;
				}
				this.applyModelSwitchUiState(state, result.model);
				this.showStatus(`模型：${result.model.provider}/${result.model.id}`);
			})
			.catch((error) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
	}

	private showModelSelector(initialSearchInput?: string): void {
		void this.showConfigurationMenu("models", initialSearchInput);
	}

	private showConfigurationMenu(initialTab: ConfigurationMenuTab, initialModelSearch?: string): Promise<void> {
		const modelCatalog = this.getCachedModelCandidates();
		const authFlows = this.createAuthFlows();
		const providerOptions = authFlows.getLoginProviderOptions();

		return new Promise((resolve) => {
			let handle: OverlayHandle | undefined;
			let settled = false;
			let hidden = false;
			let removed = false;
			let menu: ConfigurationMenuComponent;
			const hide = () => {
				if (removed) return;
				removed = true;
				hidden = true;
				handle?.hide();
				this.ui.requestRender();
			};
			const conceal = () => {
				if (hidden || removed) return;
				hidden = true;
				handle?.setHidden(true);
				this.ui.requestRender();
			};
			const show = () => {
				if (!hidden || removed || settled) return;
				hidden = false;
				handle?.setHidden(false);
				handle?.focus();
				this.ui.requestRender();
			};
			const finish = () => {
				if (settled) return;
				settled = true;
				hide();
				resolve();
			};
			const refreshModels = (force: boolean) => {
				const refreshPromise = this.getModelSelectorRefreshPromise({ force });
				if (!refreshPromise) return;
				void refreshPromise
					.then((models) => {
						if (!settled) menu.updateModels(this.getCurrentModel(), models, this.connectionConfiguredProviders);
					})
					.catch((error) => {
						if (!settled) this.showError(error instanceof Error ? error.message : String(error));
					});
			};
			const authenticate = (provider: AuthSelectorProvider, tab: "providers" | "mcp-connections") => {
				if (settled) return;
				void authFlows
					.loginProvider(provider)
					.then(async (authResult) => {
						if (settled) return;
						handle?.focus();
						menu.refreshAuthentication();
						if (authResult.status !== "success") return;

						if (tab === "mcp-connections") {
							if (!authResult.providerId.startsWith("mcp:")) return;
							if (this.isAgentStreaming() || this.isAgentCompacting()) {
								this.showStatus("已连接。当前这轮结束后运行 /reload 启用。");
								return;
							}
							finish();
							await this.handleReloadCommand();
							return;
						}

						await this.prepareForModelSelectionAfterLogin(authResult);
						menu.updateModels(
							this.getCurrentModel(),
							this.getCachedModelCandidates(),
							this.connectionConfiguredProviders,
						);
						menu.setActiveTab("models");
						refreshModels(true);
					})
					.catch((error) => {
						handle?.focus();
						this.showError(error instanceof Error ? error.message : String(error));
					});
			};

			menu = new ConfigurationMenuComponent({
				initialTab,
				tui: this.ui,
				authStorage: this.modelRegistry.authStorage,
				providerOptions,
				modelRegistry: this.modelRegistry,
				currentModel: this.getCurrentModel(),
				scopedModels: this.getScopedModelState(),
				availableModels: modelCatalog,
				configuredProviders: this.connectionConfiguredProviders,
				recentModels: this.settingsManager.getRecentModels(),
				initialModelSearch,
				getRows: () => this.ui.terminal.rows,
				requestRender: () => this.ui.requestRender(),
				onSelectProvider: (provider) => authenticate(provider, "providers"),
				onSelectMcpConnection: (provider) => authenticate(provider, "mcp-connections"),
				onSelectModel: (model) => {
					void (async () => {
						let completed = false;
						try {
							const ready = await this.ensureModelProviderConfigured(model, authFlows, providerOptions);
							handle?.focus();
							menu.refreshAuthentication();
							menu.updateModels(
								this.getCurrentModel(),
								this.getCachedModelCandidates(),
								this.connectionConfiguredProviders,
							);
							if (!ready || settled) return;
							conceal();
							await this.completeModelSelection(model);
							completed = true;
						} catch (error) {
							show();
							this.showError(error instanceof Error ? error.message : String(error));
						} finally {
							if (completed) finish();
						}
					})();
				},
				onCancel: finish,
			});
			handle = this.showFullPaneOverlay(menu, 96);
			refreshModels(initialModelSearch !== undefined);
		});
	}

	private async showModelsSelector(): Promise<void> {
		let allModels: AgentConnectionModel[];
		try {
			allModels = await this.getConnectionModelCatalog();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		if (allModels.length === 0) {
			this.showStatus("没有可用的模型");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.getScopedModelState();
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		let currentEnabledIds: string[] | null = null;

		if (hasSessionScope) {
			// Use current session's scoped models
			currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				const scopedModels = resolveModelScopeFromModels(patterns, allModels);
				currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			}
		}

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: string[] | null) => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
				const scopedModels = this.getScopedModelsFromModelIds(enabledIds, allModels);
				await this.agentConnection.setScopedModels(scopedModels);
				this.patchConnectionState({ scopedModels });
			} else {
				// All enabled or none enabled = no filter
				await this.agentConnection.setScopedModels([]);
				this.patchConnectionState({ scopedModels: [] });
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
				},
				{
					onChange: async (enabledIds) => {
						await updateSessionModels(enabledIds);
					},
					onPersist: async (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds === null || enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						const enabledIdsCopy = newPatterns ? [...newPatterns] : undefined;
						this.settingsManager.setEnabledModels(enabledIdsCopy);
						const saveFailure = await this.settingsManager.persistenceFailure();
						if (saveFailure) {
							this.showError(
								`Model selection not saved: ${saveFailure} It applies to this session only and is lost when the session ends.`,
							);
							return;
						}
						this.showStatus("模型选择已保存");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async showUserMessageSelector(): Promise<void> {
		let userMessages: Array<{ entryId: string; text: string }>;
		try {
			userMessages = await this.agentConnection.getUserMessagesForForking();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		if (userMessages.length === 0) {
			this.showStatus("没有可分叉的消息");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					try {
						const result = await this.agentConnection.fork(entryId);
						if (result.cancelled) {
							done();
							this.ui.requestRender();
							return;
						}

						await this.renderCurrentSessionState();
						this.editor.setText(result.selectedText ?? "");
						done();
						this.showStatus("已分叉到新会话");
					} catch (error: unknown) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		try {
			const { leafId } = await this.agentConnection.getSessionTree();
			if (!leafId) {
				this.showStatus("还没有可复制的内容");
				return;
			}

			const result = await this.agentConnection.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			await this.renderCurrentSessionState();
			this.editor.setText("");
			this.showStatus("已复制到新会话");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showTreeSelector(initialSelectedId?: string): Promise<void> {
		let tree: AgentConnectionSessionTreeNode[];
		let realLeafId: string | null;
		let truncationNotice: string | undefined;
		try {
			const sessionTree = await this.agentConnection.getSessionTree();
			tree = sessionTree.tree;
			realLeafId = sessionTree.leafId;
			// The tree may be bounded (depth or node count); say so instead of letting an
			// older branch look like it never existed.
			const bound = sessionTree.bound;
			if (bound?.truncated) {
				const total = "totalEntries" in bound ? bound.totalEntries : bound.entries;
				truncationNotice = `Tree truncated to ${bound.returnedNodes} of ${total} entries; older branches omitted`;
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("会话里还没有内容");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("已经在这个位置了");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								void this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					if (wantsSummary) {
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("muted", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${keyText("app.clear")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.agentConnection.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("已取消分支总结");
							void this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("已取消");
							return;
						}

						await this.renderTreeNavigation(result);
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					void this.agentConnection
						.setSessionEntryLabel(entryId, label)
						.then(() => {
							this.ui.requestRender();
						})
						.catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
				},
				initialSelectedId,
				initialFilterMode,
				truncationNotice,
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeCommand(args: string): Promise<void> {
		const selector = args.trim();
		if (!selector) {
			await this.requestAgentsView();
			return;
		}
		let sessionPath: string;
		try {
			sessionPath = (await resolveSessionPath(selector, this.getCurrentCwd(), this.connectionState?.sessionDir))
				.path;
		} catch (error) {
			if (error instanceof SessionSelectorError) {
				const suggestion =
					error instanceof SessionSelectorNotFoundError && error.suggestion
						? ` Did you mean '${error.suggestion}'?`
						: "";
				this.showError(`${error.message}.${suggestion}`);
				return;
			}
			throw error;
		}
		await this.handleResumeSession(sessionPath);
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		this.stopWorkingLoader();
		try {
			const result = options?.withSession
				? await this.getLocalSessionHost().switchSession(sessionPath, {
						withSession: options.withSession,
					})
				: await this.agentConnection.switchSession(sessionPath);
			if (result.cancelled) {
				return result;
			}
			await this.renderCurrentSessionState();
			this.showStatus("已继续会话");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("已取消继续");
					return { cancelled: true };
				}
				const result = options?.withSession
					? await this.getLocalSessionHost().switchSession(sessionPath, {
							cwdOverride: selectedCwd,
							withSession: options.withSession,
						})
					: await this.agentConnection.switchSession(sessionPath, { cwdOverride: selectedCwd });
				if (result.cancelled) {
					return result;
				}
				await this.renderCurrentSessionState();
				this.showStatus("已在当前目录继续会话");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private showOnboardingSplash(continueActionLabel?: string): Promise<OnboardingSplashHandle | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let dismissed = false;
			let handle: OverlayHandle | undefined;
			let selector: PrimeOnboardingSplashComponent | undefined;
			const settle = (result: OnboardingSplashHandle | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(result);
			};
			const dismiss = () => {
				if (dismissed) {
					return;
				}
				dismissed = true;
				selector?.dispose();
				handle?.hide();
				this.ui.requestRender();
			};
			selector = new PrimeOnboardingSplashComponent(
				() => {
					selector?.dispose();
					settle({
						showProgress: (message) => selector?.showProgress(message),
						dismiss,
					});
				},
				() => {
					dismiss();
					settle(undefined);
				},
				{
					getRows: () => this.ui.terminal.rows,
					requestRender: () => this.ui.requestRender(),
					...(continueActionLabel ? { continueActionLabel } : {}),
				},
			);
			handle = this.ui.showOverlay(selector, {
				width: "100%",
				maxHeight: "100%",
				row: 0,
				col: 0,
			});
		});
	}

	private createAuthFlows(): ProviderAuthFlows {
		return new ProviderAuthFlows({
			ui: this.ui,
			modelRegistry: this.modelRegistry,
			showStatus: (message) => this.showStatus(message),
			showError: (message) => this.showError(message),
			getAvailableModels: () => this.getConnectionAvailableModels(),
			onAuthChanged: async () => {
				await this.refreshConnectionModelsAfterAuthChange();
				await this.updateAvailableProviderCount();
				this.footer.invalidate();
				this.updateEditorBorderColor();
			},
			onLoginCompleted: () => {
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
			},
		});
	}

	private async prepareForModelSelectionAfterLogin(authResult: AuthenticationResult): Promise<boolean> {
		const currentModel = this.getCurrentModel();
		// The agent core uses unknown/unknown as its no-model sentinel.
		const selectedModel =
			currentModel?.provider === "unknown" && currentModel.id === "unknown" ? undefined : currentModel;
		let action = resolvePrimeInferencePostLoginModelAction(authResult, selectedModel, this.modelRegistry);
		if (!action.openModelPicker) {
			return false;
		}

		if (!selectedModel) {
			try {
				const availableModels = await this.getConnectionAvailableModels();
				action = resolvePrimeInferencePostLoginModelAction(authResult, selectedModel, {
					find: (provider, modelId) =>
						availableModels.find((model) => model.provider === provider && model.id === modelId) ??
						this.modelRegistry.find(provider, modelId),
				});
			} catch {
				// Preserve the registry fallback so selection can still report a specific failure below.
			}
		}

		if (action.fallbackModel) {
			try {
				await this.applySelectedModel(action.fallbackModel);
				await this.settingsManager.flush();
			} catch (error) {
				this.showError(
					`Prime Inference login succeeded, but the default model could not be selected: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else if (!selectedModel) {
			this.showError("Prime Inference 已登录，但默认的 GLM 5.2 模型不可用。");
		}

		return true;
	}

	private async handleMcpCommand(args: string | undefined): Promise<void> {
		const argv = parseCommandArgs((args ?? "").trim());
		const [sub, server] = argv;
		if (!sub) {
			await this.showConfigurationMenu("mcp-connections");
			return;
		}

		const authStorage = this.modelRegistry.authStorage;
		const isAuthed = (name: string) => authStorage.get(`mcp:${name}`) !== undefined;
		if (sub === "login") {
			if (!server || argv.length !== 2) {
				this.showError("用法：/mcp login <名称>（例如 /mcp login linear）");
				return;
			}
			const result = await this.createAuthFlows().runMcpLogin(server);
			if (result.status === "success") await this.reloadAfterMcpChange(`Connected ${server}.`);
			return;
		}

		if (sub === "logout") {
			if (!server || argv.length !== 2) {
				this.showError("用法：/mcp logout <名称>");
				return;
			}
			if (!isAuthed(server)) {
				this.showStatus(`${server} 未连接。`);
				return;
			}
			try {
				authStorage.logout(`mcp:${server}`);
			} catch (error) {
				this.showError(`退出登录失败：${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			await this.reloadAfterMcpChange(`Disconnected ${server}.`);
			return;
		}

		try {
			const result = await runMcpManagementCommand(argv, this.settingsManager, this.modelRegistry.authStorage);
			if (result.changed && result.serverChange) {
				const { name, transport, verb, usesOAuth } = result.serverChange;
				const hasMcpProviderRefresh = this.uiServices.refreshMcpProviders !== undefined;
				this.uiServices.refreshMcpProviders?.();
				const successMessage =
					verb === "removed"
						? `Removed MCP server "${name}" (${transport}). It is no longer available through mcp.`
						: usesOAuth
							? `${verb === "replaced" ? "Replaced" : "Added"} MCP server "${name}" (${transport}). ${hasMcpProviderRefresh ? "Run" : "Restart Prime Agent, then run"} /mcp login ${name} to connect.`
							: `${verb === "replaced" ? "Replaced" : "Added"} MCP server "${name}" (${transport}). Available next turn through mcp.`;
				await this.reloadAfterMcpChange(usesOAuth ? successMessage : result.message, successMessage);
			} else if (result.action === "list") {
				const builtins = BUILTIN_MCP_CATALOG.map(
					(entry) => `${entry.label} (${entry.server}): ${isAuthed(entry.server) ? "connected" : "not connected"}`,
				).join("\n");
				this.showStatus(
					`Built-in MCP integrations:\n${builtins}\n\nUser-configured MCP servers:\n${result.message}`,
				);
			} else {
				this.showStatus(result.message);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async reloadAfterMcpChange(message: string, successMessage = message): Promise<void> {
		if (this.isAgentStreaming() || this.isAgentCompacting()) {
			this.showStatus(`${message} 已保存。当前这轮结束后运行 /reload 生效。`);
			return;
		}
		const reloaded = await this.handleReloadCommand();
		if (reloaded) {
			this.showStatus(successMessage);
		} else {
			this.showWarning(`${message} 已保存，但本会话里还没生效。`);
		}
	}

	private async showLogoutSelector(): Promise<void> {
		// Only reload when an MCP integration was actually removed (its skill must
		// be disabled); a cancelled or non-MCP logout needs no reload.
		const loggedOut = await this.createAuthFlows().runLogout();
		if (loggedOut?.startsWith("mcp:")) {
			await this.handleReloadCommand();
		}
	}

	private async handleUpdateCommand(args: string): Promise<void> {
		const entrypoint = process.argv[1];
		if (!entrypoint) {
			this.showError("找不到当前程序入口，无法更新");
			return;
		}

		const updateArgs = parseCommandArgs(args);
		const includesSelf = updateArgsIncludeSelf(updateArgs);
		const updateCwd = this.getCurrentCwd();
		const daemonSocketPath = resolveInteractiveUpdateDaemonSocketPath(
			updateArgs,
			resolveDaemonUpdateRestartSocketPath(this.options.daemonSocketPath),
		);
		const updateChildArgs = includesSelf ? buildUpdateChildArgs(updateArgs, daemonSocketPath) : updateArgs;
		this.stopWorkingLoader();
		await this.ui.terminal.drainInput(1000).catch(() => undefined);
		this.ui.stop();

		const updateEnv = includesSelf ? { ...process.env, [SELF_UPDATE_INTERACTIVE_CHILD_ENV]: "1" } : process.env;
		const updateResult = spawnSync(
			process.execPath,
			[...process.execArgv, entrypoint, "update", ...updateChildArgs],
			{
				stdio: "inherit",
				cwd: updateCwd,
				env: updateEnv,
			},
		);
		const updateExitCode = updateResult.status ?? (updateResult.signal ? 1 : 0);
		const selfUpdateNotAttempted =
			includesSelf && !updateResult.error && updateExitCode === SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE;

		if (includesSelf && !selfUpdateNotAttempted) {
			const relaunchArgs = buildUpdateRelaunchArgs(process.argv.slice(2), this.connectionState?.sessionFile);
			if (updateResult.error) {
				console.error(`更新失败：${updateResult.error.message}`);
				console.error(`Relaunching ${APP_NAME}...`);
			} else if (updateExitCode !== 0) {
				console.error(
					updateResult.signal
						? `Update terminated by signal ${updateResult.signal}`
						: `Update exited with code ${updateExitCode}`,
				);
				console.error(`Relaunching ${APP_NAME}...`);
			}
			this.stop();
			await this.agentConnection.dispose().catch(() => undefined);
			try {
				await this.options.onShutdown?.();
			} catch {
				// The update already completed; do not block relaunch on local teardown.
			}
			if (!updateResult.error && updateExitCode === 0) {
				try {
					const status = await launchDaemonUpdateRestartCoordinator({
						socketPath: daemonSocketPath,
						agentDir: getAgentDir(),
						cwd: updateCwd,
						originActiveSessionId: this.connectionState?.activeSessionId,
					});
					const report = buildDaemonUpdateRestartReport(status);
					for (const message of report.info) {
						console.log(message);
					}
					for (const warning of report.warnings) {
						console.error(`Warning: ${warning}`);
					}
				} catch (error: unknown) {
					console.error(
						`Warning: updated, but could not coordinate the daemon restart (${error instanceof Error ? error.message : String(error)}).`,
					);
				}
			}
			const relaunch = createCliSubprocessLaunchSpec(relaunchArgs);
			const updateProcess = process as NodeJS.Process & { execve?: UpdateRelaunchExecve };
			try {
				if (
					tryExecUpdateRelaunch(relaunch, {
						platform: process.platform,
						nodeVersion: process.versions.node,
						cwd: updateCwd,
						previousCwd: process.cwd(),
						environment: process.env,
						chdir: (directory) => process.chdir(directory),
						execve: updateProcess.execve,
					})
				) {
					return;
				}
			} catch (error: unknown) {
				console.error(
					`Could not replace the current ${APP_NAME} process (${error instanceof Error ? error.message : String(error)}). Falling back to a child relaunch.`,
				);
			}
			const relaunchResult = spawnSync(relaunch.command, relaunch.args, {
				stdio: "inherit",
				cwd: updateCwd,
				env: process.env,
			});
			if (relaunchResult.error) {
				console.error(`Failed to relaunch ${APP_NAME}: ${relaunchResult.error.message}`);
				process.exit(1);
			}
			process.exit(relaunchResult.status ?? (relaunchResult.signal ? 1 : 0));
		}

		this.ui.start();
		if (this.fullscreenEnabled) {
			this.applyFullscreen(true);
		}
		this.ui.requestRender(true);

		if (selfUpdateNotAttempted) {
			this.showStatus(`${APP_NAME} 没有变化，正在重新加载…`);
			await this.handleReloadCommand();
			return;
		}
		if (updateResult.error) {
			this.showError(`更新失败：${updateResult.error.message}`);
			return;
		}
		if (updateExitCode !== 0) {
			this.showError(
				updateResult.signal
					? `Update terminated by signal ${updateResult.signal}`
					: `Update exited with code ${updateExitCode}`,
			);
			return;
		}
		this.showStatus("已更新，正在重新加载…");
		await this.handleReloadCommand();
	}

	private async handleReloadCommand(): Promise<boolean> {
		if (this.isAgentStreaming()) {
			this.showWarning("请等当前回复结束后再重新加载。");
			return false;
		}
		if (this.isAgentCompacting()) {
			this.showWarning("请等压缩结束后再重新加载。");
			return false;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes..."), 1, 0),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.agentConnection.reload();
			this.toolDefinitionCache.clear();
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.uiServices.getThemes());
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`主题 "${themeName}" 加载失败：${themeResult.error}\n已换回深色主题。`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			await this.refreshConnectionCatalog();
			this.setupAutocompleteProvider();
			if (this.bindLocalSessionExtensions) {
				const runner = this.getLocalSessionHost().getExtensionRunner();
				this.setupExtensionShortcuts(runner);
			}
			await this.rebuildChatFromMessages();
			dismissReloadBox(this.editor as Component);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json 有错：${modelsJsonError}`);
			}
			this.showStatus("已重新加载快捷键、扩展、技能、提示词和主题");
			return true;
		} catch (error) {
			dismissReloadBox(previousEditor as Component);
			this.showError(`重新加载失败：${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = await this.agentConnection.exportToJsonl(outputPath);
				this.showStatus(`会话已导出到：${filePath}`);
			} else {
				const filePath = await this.agentConnection.exportToHtml(outputPath);
				// The HTML export embeds the full session (cwd, usernames, emails) as
				// base64, invisible at a plain-text glance at the file: say what it
				// carries next to the path (round-27 SEC-5). A read that fails does not
				// invalidate the export, it just drops the notice.
				const identityHint = shareExportIdentityHintFromFile(filePath);
				if (identityHint !== undefined) {
					this.showStatus(`会话已导出到：${filePath}\n${identityHint}`, "warning");
				} else {
					this.showStatus(`会话已导出到：${filePath}`);
				}
			}
		} catch (error: unknown) {
			this.showError(`导出会话失败：${error instanceof Error ? error.message : "未知错误"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("用法：/import <文件.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("已取消导入");
			return;
		}

		try {
			this.stopWorkingLoader();
			const result = await this.agentConnection.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("已取消导入");
				return;
			}
			await this.renderCurrentSessionState();
			this.showStatus(`已从 ${inputPath} 导入会话`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("已取消导入");
					return;
				}
				const result = await this.agentConnection.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("已取消导入");
					return;
				}
				await this.renderCurrentSessionState();
				this.showStatus(`已从 ${inputPath} 导入会话`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`导入会话失败：${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI 还没登录，请先运行 'gh auth login'。");
				return;
			}
		} catch {
			this.showError("没装 GitHub CLI（gh），请到 https://cli.github.com/ 安装");
			return;
		}

		const temp = createShareTempHtmlFile();
		const tmpFile = temp.path;
		try {
			await this.agentConnection.exportToHtml(tmpFile);
		} catch (error: unknown) {
			fs.rmSync(temp.directory, { recursive: true, force: true });
			this.showError(`导出会话失败：${error instanceof Error ? error.message : "未知错误"}`);
			return;
		}

		// Scan the bytes that are actually uploaded. The HTML export also carries the
		// tool definitions and the working-directory context the exporter adds, so
		// scanning the raw messages instead would pass secrets it never looks at. The
		// session itself rides along base64-encoded inside those bytes, which is why the
		// preflight decodes the embedded payload and scans the plaintext it recovers.
		let exportedHtml: string;
		try {
			exportedHtml = readPrivateFile(tmpFile, "utf-8");
		} catch (error: unknown) {
			fs.rmSync(temp.directory, { recursive: true, force: true });
			this.showError(
				`Failed to read the session export: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return;
		}
		let confirmed: boolean;
		try {
			// The preflight scans the exported bytes for known credential shapes, for
			// credential-name assignment shapes, and compares every value this session has
			// loaded (its config files, environment and `--api-key` override) verbatim.
			// A hit is reported masked, with its shape and position, and nothing is uploaded
			// unless the user confirms here.
			confirmed = await confirmShareIfSecrets(exportedHtml, (title, message) =>
				this.showExtensionConfirm(title, message),
			);
		} catch (error: unknown) {
			// Building the confirm dialog can throw; without this the export would be
			// left on disk, since every other exit in this method removes it.
			fs.rmSync(temp.directory, { recursive: true, force: true });
			this.showError(
				`Failed to check the session export for secrets: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return;
		}
		if (!confirmed) {
			// The export already exists at this point, so cancelling must remove it.
			fs.rmSync(temp.directory, { recursive: true, force: true });
			this.showStatus("已取消分享");
			return;
		}

		// Show cancellable loader, replacing the editor. Constructing and mounting it can
		// throw, and restoreEditor - the method's other cleanup path - is not defined yet,
		// so a throw here would leave the 0700 directory and the 0600 export on disk.
		let loader: BorderedLoader;
		try {
			loader = new BorderedLoader(this.ui, theme, "Creating gist...");
			this.editorContainer.clear();
			this.editorContainer.addChild(loader);
			this.ui.setFocus(loader);
			this.ui.requestRender();
		} catch (error: unknown) {
			fs.rmSync(temp.directory, { recursive: true, force: true });
			// clear() may already have run, so put the editor back; a failure while doing
			// that must not mask the original error.
			try {
				this.editorContainer.clear();
				this.editorContainer.addChild(this.editor);
				this.ui.setFocus(this.editor);
			} catch {
				// Ignore restore errors
			}
			this.showError(
				`Failed to start the share upload: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return;
		}

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			try {
				fs.rmSync(temp.directory, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("已取消分享");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
				(resolve, reject) => {
					proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
					let stdout = "";
					let stderr = "";
					proc.stdout?.on("data", (data) => {
						stdout += data.toString();
					});
					proc.stderr?.on("data", (data) => {
						stderr += data.toString();
					});
					// A spawn that fails (gh removed from PATH after the preflight, EMFILE,
					// EACCES) emits 'error' and never 'close': without this listener the
					// await below never settles and /share hangs with the loader on screen.
					// The bound covers the third shape - a process that reports nothing at
					// all; the loader's own abort stays the fast path for the user.
					const bound = setTimeout(() => {
						proc?.kill();
						reject(new Error(`gh gist create timed out after ${Math.round(SHARE_UPLOAD_TIMEOUT_MS / 1000)}s`));
					}, SHARE_UPLOAD_TIMEOUT_MS);
					bound.unref?.();
					const settle = (outcome: () => void) => {
						clearTimeout(bound);
						outcome();
					};
					proc.on("error", (error) => settle(() => reject(error)));
					proc.on("close", (code) => settle(() => resolve({ stdout, stderr, code })));
				},
			);

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`创建 gist 失败：${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("没能从 gh 的输出里读到 gist ID");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`分享链接：${previewUrl}\nGist：${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`创建 gist 失败：${error instanceof Error ? error.message : "未知错误"}`);
			}
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = await this.agentConnection.getLastAssistantText();
		if (!text) {
			this.showError("还没有可复制的回复。");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showToast("✓ copied");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleNameCommand(text: string): Promise<void> {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.getCurrentSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("用法：/name <名称>");
			}
			this.ui.requestRender();
			return;
		}

		await this.agentConnection.setSessionName(name);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private async handleRlmMaxDepthCommand(args: string): Promise<void> {
		const tokens = args ? args.split(/\s+/) : [];
		if (tokens.length === 0) {
			try {
				const status = await this.agentConnection.getRlmMaxDepthStatus();
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(
					new Text(theme.fg("dim", `RLM max depth: ${status.maxDepth} (${status.source})`), 1, 0),
				);
				this.ui.requestRender();
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const global = tokens[1] === "--global";
		if (tokens.length > (global ? 2 : 1) || !/^\d+$/.test(tokens[0] ?? "")) {
			this.showWarning("用法：/rlm-max-depth [<非负整数> [--global]]");
			return;
		}
		const maxDepth = Number(tokens[0]);
		if (!Number.isSafeInteger(maxDepth)) {
			this.showWarning("RLM 最大深度必须是非负整数。");
			return;
		}

		try {
			const result = await this.agentConnection.setRlmMaxDepth(maxDepth, { global });
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					theme.fg(
						"dim",
						`RLM max depth set: ${result.maxDepth}${result.globalSaved ? " and saved as global default" : ""}`,
					),
					1,
					0,
				),
			);
			this.ui.requestRender();
			if (result.globalError) {
				this.showError(
					`RLM max depth set for this chat, but the global default was not saved: ${result.globalError}`,
				);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleSessionCommand(): Promise<void> {
		const stats = await this.agentConnection.getSessionStats();
		const sessionName = this.getCurrentSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += theme.fg("dim", "Use /context for token, cost, and context usage.");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleLogsCommand(): void {
		const logsDir = getLogsDir();
		let info = `${theme.bold("Logs")}\n\n`;
		info += `${theme.fg("dim", "Directory:")} ${logsDir}\n\n`;

		let files: string[] = [];
		try {
			if (fs.existsSync(logsDir)) {
				files = fs.readdirSync(logsDir).filter((name) => !name.startsWith("."));
			}
		} catch {
			// Fall through to the empty-state line below.
		}
		if (files.length === 0) {
			info += `${theme.fg("dim", "No logs written yet.")}\n`;
		} else {
			for (const name of files.sort()) {
				let size = "";
				try {
					size = ` ${theme.fg("dim", `(${(fs.statSync(path.join(logsDir, name)).size / 1024).toFixed(1)} KB)`)}`;
				} catch {
					// Skip the size if the file vanished between readdir and stat.
				}
				info += `${theme.fg("dim", "•")} ${name}${size}\n`;
			}
		}
		info += `\n${theme.fg("dim", "Daemon crashes log to <socket>.log; agent-open failures log to client-errors.log.")}`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private async handleSystemPromptCommand(): Promise<void> {
		const prompt = await this.agentConnection.getSystemPrompt();
		const header = `${theme.bold("System Prompt")} ${theme.fg("dim", `(${prompt.length} chars)`)}`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(header, 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(prompt, 1, 0));
		this.ui.requestRender();
	}

	private formatTraceUploadResult(result: AgentTraceUploadResult): string {
		switch (result.status) {
			case "uploaded":
				return `Trace uploaded (${result.bytesStored.toLocaleString()} bytes).`;
			case "disabled":
				return "Trace sharing is disabled.";
			case "unchanged":
				return "Trace is already uploaded; no new content since the last upload.";
			case "missing_credentials":
				return "trace 分享需要 Prime API key，请运行 /traces login。";
			case "no_session_file":
				return "Current session has no persisted trace yet.";
			case "empty_session":
				return "Current session trace is empty.";
			case "invalid_session":
				return `Trace upload skipped: ${result.message}.`;
			case "too_large":
				return `Trace upload skipped: session file is ${result.size.toLocaleString()} bytes; limit is ${result.maxBytes.toLocaleString()} bytes.`;
			case "failed":
				if (result.statusCode === 404) {
					return "Trace upload endpoint was not found. The platform API may not be deployed yet, or PRIME_AGENT_TRACES_BASE_URL points at the wrong API.";
				}
				return `Trace upload failed: ${result.statusCode ? `HTTP ${result.statusCode}: ` : ""}${result.message}. See ${getAgentTracesLogPath()} for details.`;
		}
	}

	private async uploadCurrentTraceOnce(): Promise<AgentTraceUploadResult> {
		const state = await this.agentConnection.getState();
		return uploadAgentTraceFile({
			sessionFile: state.sessionFile,
			authStorage: this.modelRegistry.authStorage,
			settingsManager: this.settingsManager,
			requireEnabled: false,
			reloadConfig: false,
		});
	}

	private async previewCurrentTrace(): Promise<void> {
		const state = await this.agentConnection.getState();
		const result = await previewAgentTraceFile({ sessionFile: state.sessionFile });
		let info: string;
		switch (result.status) {
			case "no_session_file":
				info = "Trace preview is unavailable until the current session has a persisted assistant response.";
				break;
			case "empty_session":
				info = "The current trace is empty.";
				break;
			case "invalid_session":
			case "failed":
				info = `Trace preview failed: ${result.message}.`;
				break;
			case "ready":
				info = this.formatTracePreview(result);
				break;
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private formatTracePreview(result: Extract<AgentTracePreviewResult, { status: "ready" }>): string {
		const lines = [
			theme.bold("Trace Preview"),
			theme.fg("dim", "Nothing has been uploaded by this command."),
			"",
			`${theme.fg("dim", "File:")} ${result.sessionFile}`,
			`${theme.fg("dim", "Size:")} ${result.size.toLocaleString()} bytes`,
			`${theme.fg("dim", "Uploadable:")} ${result.uploadable ? "Yes" : `No (limit ${result.maxBytes.toLocaleString()} bytes)`}`,
			`${theme.fg("dim", "Endpoint:")} ${result.endpoint}`,
			`${theme.fg("dim", "Session ID:")} ${result.sessionId}`,
			`${theme.fg("dim", "Trace ID:")} ${result.traceId}`,
		];
		if (result.parentSessionId) {
			lines.push(`${theme.fg("dim", "Parent session:")} ${result.parentSessionId}`);
		}
		if (result.gitRepo) {
			lines.push(`${theme.fg("dim", "Git repository:")} ${result.gitRepo}`);
		}
		if (result.gitCommit) {
			lines.push(`${theme.fg("dim", "Git commit:")} ${result.gitCommit}`);
		}
		lines.push("", theme.bold("Raw JSONL payload preview"));
		if (result.contentPreview) {
			lines.push(result.contentPreview);
			if (result.truncated) {
				lines.push("", theme.fg("dim", "Preview truncated; upload sends the complete file."));
			}
		} else {
			lines.push(theme.fg("dim", "Payload omitted because the trace exceeds the upload limit."));
		}
		return lines.join("\n");
	}

	private async uploadAllTraces(sessionDir?: string, signal?: AbortSignal): Promise<AgentTraceUploadAllResult> {
		return uploadAllAgentTraces({
			authStorage: this.modelRegistry.authStorage,
			settingsManager: this.settingsManager,
			sessionDir,
			requireEnabled: false,
			reloadConfig: false,
			signal,
			onProgress: ({ completed, total }) => {
				if (total > 0 && (completed === 0 || completed === total || completed % 10 === 0)) {
					this.showStatus(
						`Uploading traces: ${completed.toLocaleString()}/${total.toLocaleString()} (${keyText("app.clear")} to cancel)`,
					);
				}
			},
		});
	}

	private async handleTracesCommand(text: string): Promise<void> {
		const command =
			text
				.replace(/^\/traces\b/, "")
				.trim()
				.toLowerCase() || "status";

		if (command === "status") {
			await this.settingsManager.reload().catch(() => undefined);
			const credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			const state = await this.agentConnection.getState();
			const optOut = backgroundNetworkOptOut();
			const automaticUploads = !this.settingsManager.getAgentTracesEnabled()
				? "Disabled"
				: optOut === undefined
					? "Enabled"
					: `Enabled, suppressed by ${optOut}`;
			const info = [
				theme.bold("Trace Sharing"),
				"",
				`${theme.fg("dim", "Automatic uploads:")} ${automaticUploads}`,
				`${theme.fg("dim", "Credential:")} ${credential?.label ?? "Not configured"}`,
				`${theme.fg("dim", "Endpoint:")} ${resolvePrimeAgentTracesBaseUrl()}`,
				`${theme.fg("dim", "Session file:")} ${state.sessionFile ?? "In-memory"}`,
				"",
				theme.fg(
					"dim",
					"Commands: /traces on, /traces off, /traces preview, /traces upload-current, /traces upload-all, /traces login",
				),
			].join("\n");
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(info, 1, 0));
			this.ui.requestRender();
			return;
		}

		if (command === "off" || command === "disable") {
			this.settingsManager.setAgentTracesEnabled(false);
			const saveFailure = await this.settingsManager.persistenceFailure();
			if (saveFailure) {
				this.showError(
					`Trace sharing not saved: ${saveFailure} It is off for this session only and will be enabled again at the next start.`,
				);
				return;
			}
			this.showStatus("已关闭 trace 分享。");
			return;
		}

		if (command === "login") {
			await this.createAuthFlows().runPrimeAgentTracesLogin();
			return;
		}

		if (command === "preview") {
			await this.previewCurrentTrace();
			return;
		}

		if (command === "on" || command === "enable") {
			let credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			if (!credential) {
				const authResult = await this.createAuthFlows().runPrimeAgentTracesLogin();
				if (authResult.status !== "success") {
					return;
				}
				credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			}
			if (!credential) {
				this.showError("trace 分享需要 Prime API key。");
				return;
			}

			this.settingsManager.setAgentTracesEnabled(true);
			const saveFailure = await this.settingsManager.persistenceFailure();
			const uploadResult = await this.uploadCurrentTraceOnce();
			const uploadMessage =
				uploadResult.status === "no_session_file" || uploadResult.status === "empty_session"
					? "Current session will upload after the first assistant response."
					: this.formatTraceUploadResult(uploadResult);
			if (saveFailure) {
				// The upload did run, off the in-memory value; what did not happen is the setting, so
				// the next start falls back to whatever the file still says.
				this.showError(
					`Trace sharing not saved: ${saveFailure} It is on for this session only and will be off again at the next start. ${uploadMessage}`,
				);
				return;
			}
			this.showStatus(`已开启 trace 分享。${uploadMessage}`);
			return;
		}

		if (command === "upload" || command === "upload-current") {
			const credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			if (!credential) {
				this.showError("trace 分享需要 Prime API key，请运行 /traces login。");
				return;
			}
			const uploadResult = await this.uploadCurrentTraceOnce();
			const message = this.formatTraceUploadResult(uploadResult);
			if (uploadResult.status === "failed") {
				this.showError(message);
			} else {
				this.showStatus(message);
			}
			return;
		}

		if (command === "upload-all") {
			const credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			if (!credential) {
				this.showError("trace 分享需要 Prime API key，请运行 /traces login。");
				return;
			}
			if (this.traceUploadAllAbortController) {
				this.showWarning("已有一个 trace 在上传，请先取消再开始新的。");
				return;
			}
			const state = await this.agentConnection.getState();
			const abortController = new AbortController();
			this.traceUploadAllAbortController = abortController;
			let result: AgentTraceUploadAllResult;
			try {
				result = await this.uploadAllTraces(state.sessionDir, abortController.signal);
			} finally {
				if (this.traceUploadAllAbortController === abortController) {
					this.traceUploadAllAbortController = undefined;
				}
			}
			if (abortController.signal.aborted) {
				this.showStatus("已取消 trace 上传。");
				return;
			}
			if (result.total === 0) {
				this.showStatus("没有找到保存的 trace。");
				return;
			}
			const summary = [
				`Uploaded ${result.uploaded.toLocaleString()} of ${result.total.toLocaleString()} traces`,
				result.skipped > 0 ? `${result.skipped.toLocaleString()} skipped` : undefined,
				result.failed > 0 ? `${result.failed.toLocaleString()} failed` : undefined,
				`${result.bytesStored.toLocaleString()} bytes stored`,
			]
				.filter((part): part is string => part !== undefined)
				.join("; ");
			if (result.failed > 0) {
				this.showWarning(`${summary}。详情见 ${getAgentTracesLogPath()}`);
			} else {
				this.showStatus(`${summary}.`);
			}
			return;
		}

		this.showWarning("用法：/traces [status|on|off|preview|upload|upload-current|upload-all|login]");
	}

	private async handleContextCommand(): Promise<void> {
		let info: string;
		try {
			const tree = await this.agentConnection.getContextTree();
			const width = Math.max(60, Math.min(this.ui.terminal.columns - 2, 120));
			info = formatContextTree(tree, width, this.spendPricing());
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private async handleHeartbeatCommand(text: string): Promise<void> {
		try {
			const command = parseHeartbeatCommand(text);
			switch (command.type) {
				case "status": {
					const heartbeat = await this.agentConnection.getHeartbeat();
					this.patchConnectionState({ heartbeat: heartbeat ?? null });
					await this.refreshHeartbeatCatalog();
					this.showHeartbeat(heartbeat);
					return;
				}
				case "set": {
					const heartbeat = await this.agentConnection.setHeartbeat(
						command.schedule,
						command.instruction,
						command.deliveryMode,
					);
					this.patchConnectionState({ heartbeat });
					await this.refreshHeartbeatCatalog();
					this.showStatus(
						`Heartbeat set\nDelivery: ${heartbeat.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE}\nNext run: ${heartbeat.nextRunAt ?? "-"}`,
					);
					return;
				}
				case "pause": {
					const heartbeat = await this.agentConnection.updateHeartbeat("pause");
					if (!heartbeat) {
						this.showStatus("没有进行中的定时任务");
						return;
					}
					this.patchConnectionState({ heartbeat });
					await this.refreshHeartbeatCatalog();
					this.showStatus("定时任务已暂停");
					return;
				}
				case "resume": {
					const heartbeat = await this.agentConnection.updateHeartbeat("resume");
					if (!heartbeat) {
						this.showStatus("没有进行中的定时任务");
						return;
					}
					this.patchConnectionState({ heartbeat });
					await this.refreshHeartbeatCatalog();
					this.showStatus(`定时任务已恢复\n下次运行：${heartbeat.nextRunAt ?? "-"}`);
					return;
				}
				case "clear": {
					const heartbeat = await this.agentConnection.updateHeartbeat("clear");
					if (!heartbeat) {
						this.showStatus("没有进行中的定时任务");
						return;
					}
					this.patchConnectionState({ heartbeat: null });
					await this.refreshHeartbeatCatalog();
					this.showStatus("定时任务已清除");
					return;
				}
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showHeartbeatManager(): Promise<void> {
		if (this.heartbeatManagerHandle) {
			this.heartbeatManagerHandle.focus();
			return;
		}
		try {
			await this.refreshHeartbeatCatalog();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		const manager = new HeartbeatManagerComponent({
			getHeartbeats: () => this.getScopedHeartbeats(),
			getRows: () => this.ui.terminal.rows,
			onAction: (heartbeat, action) => this.manageHeartbeat(heartbeat, action),
			onClose: () => this.closeHeartbeatManager(),
			requestRender: () => this.ui.requestRender(),
		});
		this.heartbeatManager = manager;
		this.heartbeatManagerHandle = this.showFullPaneOverlay(manager, {
			fullWidth: true,
			suspendFullscreenMouse: true,
		});
		this.scheduleHeartbeatManagerRefresh();
	}

	private closeHeartbeatManager(): void {
		this.clearHeartbeatManagerRefreshTimer();
		this.heartbeatManagerHandle?.hide();
		this.heartbeatManagerHandle = undefined;
		this.heartbeatManager = undefined;
		this.ui.requestRender();
	}

	private scheduleHeartbeatManagerRefresh(): void {
		if (!this.heartbeatManager) {
			this.clearHeartbeatManagerRefreshTimer();
			return;
		}
		const nextRunAt = this.getScopedHeartbeats()
			.filter((heartbeat) => heartbeat.job.status === "active" && heartbeat.job.nextRunAt)
			.map((heartbeat) => Date.parse(heartbeat.job.nextRunAt!))
			.filter(Number.isFinite)
			.sort((left, right) => left - right)[0];
		if (nextRunAt === undefined) {
			this.clearHeartbeatManagerRefreshTimer();
			return;
		}
		const untilNextRun = nextRunAt - Date.now();
		const delay = untilNextRun > 0 ? Math.min(60_000, untilNextRun + 250) : 5_000;
		const refreshAt = Date.now() + delay;
		// Subagent snapshots re-derive this schedule constantly; keep an earlier
		// pending refresh instead of re-arming, or an overdue heartbeat's 5s
		// fallback would be postponed for as long as children stay busy.
		if (
			this.heartbeatManagerRefreshTimer &&
			this.heartbeatManagerRefreshAt !== undefined &&
			this.heartbeatManagerRefreshAt <= refreshAt
		) {
			return;
		}
		this.clearHeartbeatManagerRefreshTimer();
		this.heartbeatManagerRefreshAt = refreshAt;
		this.heartbeatManagerRefreshTimer = setTimeout(() => {
			this.heartbeatManagerRefreshTimer = undefined;
			this.heartbeatManagerRefreshAt = undefined;
			if (!this.heartbeatManager) {
				return;
			}
			void this.refreshHeartbeatCatalog().catch(() => this.scheduleHeartbeatManagerRefresh());
		}, delay);
		this.heartbeatManagerRefreshTimer.unref?.();
	}

	private clearHeartbeatManagerRefreshTimer(): void {
		if (this.heartbeatManagerRefreshTimer) {
			clearTimeout(this.heartbeatManagerRefreshTimer);
			this.heartbeatManagerRefreshTimer = undefined;
		}
		this.heartbeatManagerRefreshAt = undefined;
	}

	private async manageHeartbeat(
		heartbeat: AgentConnectionHeartbeat,
		action: AgentHeartbeatManagementAction,
	): Promise<void> {
		const updated = await this.agentConnection.manageHeartbeat(
			heartbeat.job.activeSessionId,
			heartbeat.job.id,
			action,
		);
		if (updated.source === "heartbeat" && updated.activeSessionId === this.connectionState?.activeSessionId) {
			this.patchConnectionState({ heartbeat: action === "stop" ? null : updated });
		}
		const remaining = this.heartbeatCatalog.filter((entry) => entry.job.id !== updated.id);
		this.applyHeartbeatCatalog(
			updated.status === "active" || updated.status === "paused"
				? [...remaining, { ...heartbeat, job: updated }]
				: remaining,
		);
		void this.refreshHeartbeatCatalog().catch(() => undefined);
	}

	private showHeartbeat(job: AgentCronJob | undefined): void {
		if (!job) {
			this.showStatus("没有进行中的定时任务");
			return;
		}
		const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "-";
		const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "-";
		const lines = [
			theme.bold("Heartbeat"),
			"",
			`${theme.fg("dim", "Status:")} ${job.status}`,
			`${theme.fg("dim", "Every:")} ${job.schedule.expression}`,
			`${theme.fg("dim", "Delivery:")} ${job.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE}`,
			`${theme.fg("dim", "Instruction:")} ${job.prompt}`,
			`${theme.fg("dim", "Next:")} ${next}`,
			`${theme.fg("dim", "Last:")} ${last}`,
			`${theme.fg("dim", "Runs:")} ${job.runCount}`,
		];
		if (job.lastError) {
			lines.push(`${theme.fg("dim", "Error:")} ${job.lastError}`);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => e.content)
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private capitalizeKey(key: string): string {
		return key
			.split("/")
			.map((k) =>
				k
					.split("+")
					.map((part) => (part === "esc" ? part : part.charAt(0).toUpperCase() + part.slice(1)))
					.join("+"),
			)
			.join("/");
	}

	private getAppKeyDisplay(action: AppKeybinding): string {
		return this.capitalizeKey(keyText(action));
	}

	private getEditorKeyDisplay(action: Keybinding): string {
		return this.capitalizeKey(keyText(action));
	}

	private getShortcutGuide(): string {
		const tab = this.getEditorKeyDisplay("tui.input.tab");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const clearInput = this.getAppKeyDisplay("app.input.clear");
		const shortcutsKey = this.getAppKeyDisplay("app.shortcuts");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const expandToolsFull = this.getAppKeyDisplay("app.tools.expandFull");
		const expandMessages = this.getAppKeyDisplay("app.messages.expand");
		const expandEdits = this.getAppKeyDisplay("app.edits.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const promptStash = this.getAppKeyDisplay("app.prompt.stash");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");
		const blocksPrev = this.getAppKeyDisplay("app.blocks.prev");
		const blocksNext = this.getAppKeyDisplay("app.blocks.next");

		return `
**输入**
\`!\` 运行 shell 命令 · \`/\` 命令 · \`@\` 引用文件
\`${tab}\` 补全路径 · \`${newLine}\` 换行
\`${clearInput}\` 中断 · 连按两次回退或清空输入

**查看与控制**
\`${selectModel}\` 选模型 · \`/effort\` 调推理强度 · \`${expandTools}\` 过程${expandToolsFull ? ` · \`${expandToolsFull}\` 看全文` : ""}
\`${expandMessages}\` 代理消息 · \`${expandEdits}\` 改动详情 · \`${toggleThinking}\` Thinking · \`${promptStash}\` 暂存输入 · \`${externalEditor}\` 用 \`$EDITOR\` 编辑
\`${pasteImage}\` 粘贴图片
${blocksPrev ? `\`${blocksPrev}\`${blocksNext ? ` / \`${blocksNext}\`` : ""} 逐块浏览对话（${blockNavigationKeysText()}）` : ""}

**帮助**
${shortcutsKey ? `\`${shortcutsKey}\` 快捷键（再按一次关闭） · ` : ""}\`/hotkeys\` 完整列表
`;
	}

	private getHotkeysGuide(): string {
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");
		const clear = this.getAppKeyDisplay("app.clear");
		const clearInput = this.getAppKeyDisplay("app.input.clear");
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const shortcutsKey = this.getAppKeyDisplay("app.shortcuts");
		const exit = this.getAppKeyDisplay("app.exit");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const expandToolsFull = this.getAppKeyDisplay("app.tools.expandFull");
		const expandMessages = this.getAppKeyDisplay("app.messages.expand");
		const expandEdits = this.getAppKeyDisplay("app.edits.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const focusSubagents = this.getAppKeyDisplay("app.subagents.focus");
		const manageHeartbeats = this.getAppKeyDisplay("app.heartbeats.open");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const promptStash = this.getAppKeyDisplay("app.prompt.stash");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const browseQueue = this.getAppKeyDisplay("app.message.navigateOlder");
		const blocksPrev = this.getAppKeyDisplay("app.blocks.prev");
		const blocksNext = this.getAppKeyDisplay("app.blocks.next");
		const reorderQueue = `${this.getAppKeyDisplay("app.message.moveEarlier")} / ${this.getAppKeyDisplay("app.message.moveLater")}`;
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");
		const viewportPageUp = this.getEditorKeyDisplay("tui.viewport.pageUp");
		const viewportPageDown = this.getEditorKeyDisplay("tui.viewport.pageDown");
		const viewportTop = this.getEditorKeyDisplay("tui.viewport.top");
		const viewportFollow = this.getEditorKeyDisplay("tui.viewport.follow");

		let hotkeys = `
**移动**
| 按键 | 作用 |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | 移动光标 / 翻历史（输入为空时按上） |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | 按词移动 |
| \`${cursorLineStart}\` | 行首 |
| \`${cursorLineEnd}\` | 行尾 |
| \`${jumpForward}\` | 向后跳到字符 |
| \`${jumpBackward}\` | 向前跳到字符 |
| \`${pageUp}\` / \`${pageDown}\` | 翻页 |

**编辑**
| 按键 | 作用 |
|-----|--------|
| \`${submit}\` | 发送 |
| \`${newLine}\` | 换行${process.platform === "win32" ? "（Windows Terminal 用 Ctrl+Enter）" : ""} |
| \`${deleteWordBackward}\` | 向前删一个词 |
| \`${deleteWordForward}\` | 向后删一个词 |
| \`${deleteToLineStart}\` | 删到行首 |
| \`${deleteToLineEnd}\` | 删到行尾 |
| \`${yank}\` | 粘贴最近删除的文字 |
| \`${yankPop}\` | 粘贴后切换更早删除的文字 |
| \`${undo}\` | 撤销 |

**其他**
| 按键 | 作用 |
|-----|--------|
| \`${tab}\` | 补全路径 / 接受补全 |
| \`${clearInput}\` | 清空输入 / 取消补全 |
| \`${clear}\` | 中断当前操作（空闲时再按一次退出） |
${interrupt ? `| \`${interrupt}\` | 中断当前操作 |\n` : ""}${shortcutsKey ? `| \`${shortcutsKey}\` | 快捷键面板 |\n` : ""}| \`${exit}\` | 退出（输入为空时） |
| \`${selectModel}\` | 选模型 |
| \`${expandTools}\` | 展开 / 收起过程 |
${expandToolsFull ? `| \`${expandToolsFull}\` | 看全文（不限行数） |\n` : ""}| \`${expandMessages}\` | 展开 / 收起代理消息 |
| \`${expandEdits}\` | 展开 / 收起改动详情 |
| \`${toggleThinking}\` | 展开 / 收起 Thinking |
| \`${focusSubagents}\` | 进入子代理面板 / 打开子代理列表 |
| \`${manageHeartbeats}\` | 管理定时任务 |
| \`${externalEditor}\` | 用外部编辑器写消息 |
| \`${promptStash}\` | 暂存 / 恢复草稿 |
| \`${followUp}\` | 排一条稍后发送的消息 |
| \`${browseQueue}\` | 查看或修改排队消息 |
${blocksPrev ? `| \`${blocksPrev}\`${blocksNext ? ` / \`${blocksNext}\`` : ""} | 逐块浏览对话（没有排队消息时；${blockNavigationKeysText()}） |\n` : ""}
| \`${reorderQueue}\` | 调整排队消息顺序 |
| \`${pasteImage}\` | 从剪贴板粘贴图片 |
| \`/\` | 命令 |

**全屏模式（\`/fullscreen\`）**
| 按键 | 作用 |
|-----|--------|
| \`${viewportPageUp}\` / \`${viewportPageDown}\` | 对话翻页 |
| \`${viewportTop}\` | 滚到顶部 |
| \`${viewportFollow}\` | 回到底部并跟随输出 |
| 鼠标滚轮 | 滚动对话 |
| 鼠标拖动 | 选中并复制 |
| 点击链接 | 在浏览器打开 |
`;

		const shortcuts = this.bindLocalSessionExtensions
			? this.getLocalSessionHost().getExtensionRunner().getShortcuts(this.keybindings.getEffectiveConfig())
			: undefined;
		if (shortcuts && shortcuts.size > 0) {
			hotkeys += `
**扩展**
| 按键 | 作用 |
|-----|--------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				hotkeys += `| \`${formatKeyText(key)}\` | ${description} |\n`;
			}
		}

		return hotkeys;
	}

	private showShortcutGuide(): void {
		// The same key closes the panel it opened.
		if (this.shortcutGuideContainer.children.length > 0) {
			this.clearShortcutGuide();
			return;
		}
		const hotkeys = this.getShortcutGuide();

		this.shortcutGuideContainer.clear();
		this.shortcutGuideContainer.addChild(new Spacer(1));
		this.shortcutGuideContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.ui.requestRender();
	}

	private handleHotkeysCommand(): void {
		const hotkeys = this.getHotkeysGuide();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.ui.requestRender();
	}

	private clearShortcutGuide(): void {
		if (this.shortcutGuideContainer.children.length === 0) {
			return;
		}
		this.shortcutGuideContainer.clear();
		this.ui.requestRender();
	}

	private async handleClearCommand(options: { name?: string; prompt?: string } = {}): Promise<void> {
		this.stopWorkingLoader();
		const retainedImages = options.prompt ? this.getPromptStashImages(options.prompt) : [];
		const restorePrompt = () => {
			if (!options.prompt) return;
			for (const [id, image] of retainedImages) this.pastedImages.set(id, image);
			this.editor.setText(options.prompt);
		};
		let created = false;
		try {
			const result = await this.agentConnection.newSession();
			if (result.cancelled) {
				restorePrompt();
				return;
			}
			created = true;
			await this.renderCurrentSessionState();
			for (const [id, image] of retainedImages) this.pastedImages.set(id, image);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ 已开新会话")}`, 1, 1));
			this.ui.requestRender();
			const images = options.prompt ? this.collectImagesFor(options.prompt) : undefined;
			if (options.name) await this.agentConnection.setSessionName(options.name);
			if (options.prompt) {
				this.editor.addToHistory?.(options.prompt);
				await this.agentConnection.prompt(this.pastedImageFiles.annotate(options.prompt), { images });
			}
		} catch (error: unknown) {
			if (!created) {
				await this.handleFatalRuntimeError("新建会话失败", error);
				return;
			}
			restorePrompt();
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleDebugCommand(): Promise<void> {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);
		try {
			const messages = await this.agentConnection.getMessages();
			const debugLogPath = getDebugLogPath();
			const debugData = [
				`Debug output at ${new Date().toISOString()}`,
				`Terminal: ${width}x${height}`,
				`Total lines: ${allLines.length}`,
				"",
				"=== All rendered lines with visible widths ===",
				...allLines.map((line, idx) => {
					const vw = visibleWidth(line);
					const escaped = JSON.stringify(line);
					return `[${idx}] (w=${vw}) ${escaped}`;
				}),
				"",
				"=== Agent messages (JSONL) ===",
				...messages.map((msg) => JSON.stringify(msg)),
				"",
			].join("\n");

			writePrivateFileAtomic(debugLogPath, debugData);

			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
			);
			this.ui.requestRender();
		} catch (error: unknown) {
			this.showError(`写调试日志失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDementedDelves(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	stop(options: { preserveAltScreen?: boolean } = {}): void {
		this.unregisterSignalHandlers();
		this.clearCtrlCExitHint({ render: false });
		this.clearEscapeRepeat();
		this.removeStallActionBar({ render: false });
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		this.stopWorkingLoader();
		this.discardRefineLoader();
		this.disposeTransientStatusOverlays();
		this.endFeatureHintRun();
		this.stopWorkingPulse();
		this.stopGoalTrayTimer();
		this.stopSubagentSpendIdleTick();
		this.clearSubagentSpendRefresh();
		this.closeHeartbeatManager();
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		void this.rosterBar?.dispose();
		this.rosterBar = undefined;
		if (this.isInitialized) {
			this.ui.stop({
				preserveAltScreen: options.preserveAltScreen,
				flushFullscreen: options.preserveAltScreen ? false : undefined,
			});
			this.isInitialized = false;
		}
	}
}
