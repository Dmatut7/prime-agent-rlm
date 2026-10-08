import { ABORT_TRUNCATION_MARKER, type AgentMessage, TOOL_ABORT_FALLBACK_MESSAGE } from "@earendil-works/pi-agent-core";
import type { TextContent, ToolCall } from "@earendil-works/pi-ai";
import {
	type ClickRegion,
	type Component,
	Container,
	type MarkdownTheme,
	Spacer,
	type StickyHeader,
	type TableCellSelectionRegion,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { type AgentSessionMessage, isAgentSessionMessage, startsAgentRun } from "../../../core/agent-messages.js";
import type { MessageRenderer } from "../../../core/extensions/types.js";
import {
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CustomMessage,
	isCompactionOutcomeMessage,
	isRefinementOutcomeMessage,
	isSessionSlashCommandMessage,
	isSessionSlashCommandResultMessage,
	REFINEMENT_OUTCOME_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	SESSION_CONTEXT_LOSS_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
} from "../../../core/messages.js";
import { PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE } from "../../../core/provider-fallback.js";
import type { ProcessModeSetting } from "../../../core/settings-manager.js";
import { parseSkillBlock } from "../../../core/skill-blocks.js";
import type { TruncationResult } from "../../../core/tools/truncate.js";
import { theme } from "../theme/theme.js";
import { AgentMessageComponent, SubagentLane } from "./agent-message.js";
import { AssistantMessageComponent, type AssistantMessageComponentOptions } from "./assistant-message.js";
import { BashExecutionComponent } from "./bash-execution.js";
import { BranchSummaryMessageComponent } from "./branch-summary-message.js";
import {
	CompactionOutcomeMessageComponent,
	MalformedCompactionOutcomeMessageComponent,
} from "./compaction-outcome-message.js";
import { CompactionSummaryMessageComponent, QuietCompactionNoticeComponent } from "./compaction-summary-message.js";
import { CustomMessageComponent } from "./custom-message.js";
import { InjectedPromptMessageComponent, isInjectedPromptMessage } from "./injected-prompt-message.js";
import { IPythonCellComponent } from "./ipython-cell.js";
import type { MermaidMarkdownTransform } from "./mermaid.js";
import {
	MalformedRefinementOutcomeMessageComponent,
	RefinementOutcomeMessageComponent,
} from "./refinement-outcome-message.js";
import { SkillInvocationMessageComponent } from "./skill-invocation-message.js";
import { SlashCommandMessageComponent } from "./slash-command-message.js";
import { SlashCommandResultMessageComponent } from "./slash-command-result-message.js";
import { isSubagentNoticeMessage, subagentNoticeRow, TimelineNoticeRow } from "./system-notice.js";
import type { TimelineLane } from "./timeline-gutter.js";
import { type TimelineLaneTracker, timelineShowAll } from "./timeline-lane.js";
import {
	selectLatestToolExpandHint,
	ToolExecutionComponent,
	type ToolExecutionDefinition,
	type ToolExecutionOptions,
} from "./tool-execution.js";
import { type TimelineHost, TurnActivityState, type TurnStep, TurnSummaryComponent } from "./turn-activity.js";
import { TurnStripComponent } from "./turn-strip.js";
import {
	boxRecordFromMessage,
	isBoxNoticeMessage,
	isPlainAnswer,
	replyHasWork,
	type TimelineCompaction,
} from "./turn-timeline.js";
import { UserMessageComponent } from "./user-message.js";

export interface ConversationComponentsOptions {
	ui: TUI;
	cwd: string;
	toolOptions: ToolExecutionOptions;
	getToolDefinition: (name: string) => ToolExecutionDefinition | undefined;
	markdownTheme?: MarkdownTheme;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	toolsExpanded?: boolean;
	thinkingExpanded?: boolean;
	agentMessagesExpanded?: boolean;
	editDiffsExpanded?: boolean;
	isRecognizedSlashCommand?: (name: string) => boolean;
	/** TUI v4: quiet folds intermediate narration behind the turn footnote; legacy keeps the old face. */
	processMode?: ProcessModeSetting;
	/** What the quiet turns' boxes read (settings, screen height, working directory). */
	timelineHost?: TimelineHost;
	/** Mermaid blocks of a replayed answer render through the live view's transform. */
	mermaidTransform?: MermaidMarkdownTransform;
	/**
	 * The transcript ends mid-run (production: the agent is streaming): the last
	 * turn stays open for live events to continue instead of being closed off.
	 * Tool calls without results keep the turn open either way.
	 */
	keepFinalTurnOpen?: () => boolean;
	/** Production wiring the plain build has no need of; see ConversationReplayHooks. */
	hooks?: ConversationReplayHooks;
}

/** What a replay writes into: the chat container in production, a plain array in tests. */
export interface ConversationReplayTarget {
	readonly children: readonly Component[];
	addChild(component: Component): void;
	removeChild(component: Component): void;
}

/**
 * The production-only wiring of a replay: the live flow's lane and report
 * memory, the heartbeat catalog's prompt classification, the extension
 * renderers, the change strips. Every hook defaults to the plain behavior, so
 * a test that passes no hooks replays exactly what production replays minus
 * the live-session wiring - there is no second replay implementation to drift.
 */
export interface ConversationReplayHooks {
	/** The lane the replay draws in (production: the live flow's, seeded and restored around the replay). Default: a fresh one. */
	subagentLane?: SubagentLane;
	/** The reports the conversation received before this replay (production: the live flow's, pre-noted). Default: a fresh set. */
	reports?: ReceivedReports;
	/** The lane a replayed user row draws in (production: the time-aware laneAt). Default: the lane's current. */
	userLane?(timestamp: number | undefined): TimelineLane;
	/**
	 * The rows of a user prompt that is not the plain bubble (production: a
	 * stored heartbeat prompt renders as an injected notice and does not open an
	 * owner turn). Undefined: the plain bubble (or a skill block).
	 */
	renderUserPrompt?(
		message: Extract<AgentMessage, { role: "user" }>,
		text: string,
	): { components: Component[]; ownerOpened: boolean } | undefined;
	/** The turn head (production wires its lane clicks and timeline host). Default: QuietTurnSummary. */
	createTurnSummary?(state: TurnActivityState): TurnSummaryComponent;
	/** A turn just started (production: a window that cut into it restores its real start and hidden steps). */
	onTurnCreated?(state: TurnActivityState, summary: TurnSummaryComponent): void;
	/** An owner prompt opened a turn (production: question bookkeeping and the lane restore of a windowed replay). */
	onOwnerPrompt?(message: Extract<AgentMessage, { role: "user" }>, timestamp: number | undefined): void;
	/** A tool call joined the turn, before its card exists (production: step handles and the carried-over lanes). */
	onToolStep?(state: TurnActivityState, summary: TurnSummaryComponent | undefined, content: ToolCall): void;
	/** A tool card was created (production: ipython registration). */
	onToolComponent?(component: ToolExecutionComponent, content: ToolCall, state: TurnActivityState): void;
	/** The retry counter behind an aborted tool's "重试 N 次后已中断" (production: the connection's). Default: 0. */
	retryAttempt?(): number;
	/** A tool result landed (production: record the step's file changes for the change strip). */
	onToolResult?(message: Extract<AgentMessage, { role: "toolResult" }>, state: TurnActivityState | undefined): void;
	/** The renderer a session extension registered for a custom message type. */
	extensionMessageRenderer?(customType: string): MessageRenderer | undefined;
	/** A replayed turn closed (production: the change strip goes under its answer). */
	onTurnClose?(state: TurnActivityState, summary: TurnSummaryComponent): void;
	/** An assistant message replayed (production: the stop reason the next live event reads). */
	onAssistantMessage?(message: Extract<AgentMessage, { role: "assistant" }>): void;
}

export interface ConversationReplayResult {
	/** The turn the transcript ends in, when it was left open for the live run; undefined once closed. */
	turnState?: TurnActivityState;
	turnSummary?: TurnSummaryComponent;
	turnOpen: boolean;
	/** Tool cards whose results never came; production hands them to the live path. */
	pendingTools: Map<string, ToolExecutionComponent>;
	/**
	 * Results whose calls this replay never saw (the call sits above the rendered
	 * window). Production buffers them so a slim-transcript backfill page ending
	 * on one of those calls can settle it with its real result.
	 */
	orphanToolResults: Map<string, Extract<AgentMessage, { role: "toolResult" }>>;
}

/** Parts of the timeline that other lines own take the subagent lane through these optional hooks. */
interface AcceptsLaneTracker {
	setLaneTracker(tracker: TimelineLaneTracker): void;
}

interface AcceptsLane {
	setLane(lane: TimelineLane): void;
}

/** Hand the question's lane tracker to a turn head, when it takes one. */
export function giveLaneTracker(component: Component, tracker: TimelineLaneTracker): void {
	const hook = (component as Partial<AcceptsLaneTracker>).setLaneTracker;
	if (typeof hook === "function") hook.call(component, tracker);
}

/** The question's constructor, with the fifth argument the timeline row needs (`quiet`, `lane`). */
type UserMessageWithLane = new (
	text: string,
	markdownTheme?: MarkdownTheme,
	isRecognizedSlashCommand?: (name: string) => boolean,
	sentAt?: number,
	options?: { quiet?: boolean; lane?: TimelineLane },
) => UserMessageComponent;

const QuestionRow: UserMessageWithLane = UserMessageComponent;

/** The owner's question: the timeline's first row in the quiet conversation, a bubble otherwise. */
export function createUserMessage(
	text: string,
	options: {
		markdownTheme?: MarkdownTheme;
		isRecognizedSlashCommand?: (name: string) => boolean;
		sentAt?: number;
		quiet: boolean;
		lane: TimelineLane;
	},
): UserMessageComponent {
	return new QuestionRow(text, options.markdownTheme, options.isRecognizedSlashCommand, options.sentAt, {
		quiet: options.quiet,
		lane: options.lane,
	});
}

/** Hand the lane a row is appended in to a timeline component, when it takes one. */
export function giveLane(component: Component, lane: TimelineLane): void {
	const hook = (component as Partial<AcceptsLane>).setLane;
	if (typeof hook === "function") hook.call(component, lane);
}

/**
 * A message that wakes the AI when it is idle: a run-starting one (a subagent's
 * report, a heartbeat, a finished background command) or a notice that a
 * subagent it waits on ended, failed or went quiet.
 */
export function isWakeMessage(message: AgentMessage): boolean {
	return message.role === "custom" && (startsAgentRun(message) || isSubagentNoticeMessage(message));
}

/** Which subagents of the conversation have handed a report back, learned in transcript order. */
export class ReceivedReports {
	private readonly names = new Set<string>();

	/** A message of the conversation: a report from a child is remembered under its name. */
	note(message: AgentMessage): void {
		if (!isAgentSessionMessage(message) || message.details.fromRelationship !== "child") return;
		const name = message.details.from?.sessionName?.trim();
		if (name) this.names.add(name);
	}

	has(name: string): boolean {
		return this.names.has(name);
	}

	/** Who has reported so far, for a rebuild whose replay no longer holds those reports. */
	snapshot(): string[] {
		return [...this.names];
	}

	restore(names: Iterable<string>): void {
		for (const name of names) this.names.add(name);
	}

	clear(): void {
		this.names.clear();
	}
}

/** A notice that only says again what the AI has: a cancel or a silent finish of a subagent whose report came. */
function repeatsReceivedReport(message: AgentMessage, reports: ReceivedReports): boolean {
	if (message.role !== "custom" || message.customType !== RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE) return false;
	const name = (message.details as { sessionName?: unknown } | undefined)?.sessionName;
	return typeof name === "string" && name.trim() !== "" && reports.has(name.trim());
}

/**
 * What woke a round the owner did not start. It is bookkeeping only while every message that
 * woke it is a subagent notice that repeats a report already received; a report, a failure or
 * a stall notice, a heartbeat, or a silent end of a child that never reported is news.
 */
export class WakeCause {
	private onlyNotices = true;
	private onlyRepeats = true;

	constructor(private readonly reports: ReceivedReports) {}

	/** A message that woke the AI (or joined the round that woke it), judged against the reports received before it. */
	add(message: AgentMessage): void {
		if (!isSubagentNoticeMessage(message)) this.onlyNotices = false;
		if (!repeatsReceivedReport(message, this.reports)) this.onlyRepeats = false;
	}

	get isBookkeeping(): boolean {
		return this.onlyNotices && this.onlyRepeats;
	}
}

const wakeCauses = new WeakMap<TurnActivityState, WakeCause>();
/** Rounds that showed news once: they stay drawn from then on. */
const revealedRounds = new WeakSet<TurnActivityState>();

/** The round `state` is: woken by `cause`. */
export function assignWakeCause(state: TurnActivityState, cause: WakeCause): void {
	wakeCauses.set(state, cause);
}

/** A message that woke the AI landed in the round `state` (inside its tool loop): it may be news. */
export function noteWakeInRound(state: TurnActivityState | undefined, message: AgentMessage): void {
	if (state) wakeCauses.get(state)?.add(message);
}

/** A compaction that failed for real: one the owner cancelled (their own doing, not news), or that the session chose to wait on, did not. */
function compactionFailed(compaction: TimelineCompaction): boolean {
	return compaction.failed !== undefined && compaction.skipped !== true && compaction.cancelled !== true;
}

/** Whether a round woken by bookkeeping did anything the owner would look for. */
function roundHasNews(state: TurnActivityState): boolean {
	const timeline = state.timeline;
	if (timeline.stopped || timeline.errorEnded) return true;
	for (const entry of timeline.entries) {
		// Something the owner typed in the round, or a compaction that broke in it, is theirs to see.
		if (entry.kind === "subagent" || entry.kind === "steer") return true;
		if (entry.kind === "compact" && compactionFailed(entry.compaction)) return true;
	}
	if (state.steps.length === 0 && timeline.entries.every((entry) => entry.kind === "message")) return false;
	const facts = state.boxView().facts;
	if (facts.subagentCount > 0 || facts.projectChanges.length > 0 || facts.scratchChanges.length > 0) return true;
	if (facts.memories.length > 0) return true;
	return state.isTurnEnded && facts.errorCount > 0 && facts.errorsRecovered !== true;
}

/**
 * Whether a round is only the AI dealing with bookkeeping notices (a child that reported earlier
 * was cancelled or finished without a word): the owner did not start it, only such notices woke it,
 * and it did no work the owner would look for - it dispatched nothing, changed no files, saved no
 * memory, heard nothing from the owner, lost no compaction and ended without an unfixed error or a
 * stop. Whatever the reply says and however many steps it took, such a round is not drawn unless
 * "完整过程" is on. It is decided when the round is woken and holds from its first word to its last;
 * only news turns it into a drawn round, for good.
 */
export function isAckRound(state: TurnActivityState): boolean {
	if (timelineShowAll.value || state.startedByUser || revealedRounds.has(state)) return false;
	if (!wakeCauses.get(state)?.isBookkeeping) return false;
	if (roundHasNews(state)) {
		revealedRounds.add(state);
		return false;
	}
	return true;
}

/** The newest turn head the chat draws: a round that is left out is not one (with 完整过程 on, every round is). */
export function latestShownTurn(children: readonly Component[]): TurnSummaryComponent | undefined {
	for (let index = children.length - 1; index >= 0; index--) {
		const child = children[index];
		if (child instanceof TurnSummaryComponent && !isAckRound(child.state)) return child;
	}
	return undefined;
}

/** The turn head of a round that is only an acknowledgement: nothing of it is drawn. */
export class QuietTurnSummary extends TurnSummaryComponent {
	override render(width: number): string[] {
		return isAckRound(this.state) ? [] : super.render(width);
	}

	override getClickRegions(): ReadonlyArray<ClickRegion> {
		return isAckRound(this.state) ? [] : super.getClickRegions();
	}

	override getStickyHeaders(): ReadonlyArray<StickyHeader> {
		return isAckRound(this.state) ? [] : super.getStickyHeaders();
	}

	override getFocusOrder(): readonly string[] {
		return isAckRound(this.state) ? [] : super.getFocusOrder();
	}
}

/** The reply of a round that is only an acknowledgement: nothing of it is drawn. */
export class QuietAssistantMessage extends AssistantMessageComponent {
	constructor(
		private readonly round: TurnActivityState | undefined,
		...args: ConstructorParameters<typeof AssistantMessageComponent>
	) {
		super(...args);
	}

	private get hidden(): boolean {
		return this.round !== undefined && isAckRound(this.round);
	}

	override render(width: number): string[] {
		return this.hidden ? [] : super.render(width);
	}

	override getClickRegions(): ReadonlyArray<ClickRegion> {
		return this.hidden ? [] : super.getClickRegions();
	}

	override getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return this.hidden ? [] : super.getSelectionRegions();
	}
}

/** The nearest component above that draws something: a notice the timeline keeps out of sight does not count. */
export function lastDrawnComponent(children: readonly Component[]): Component | undefined {
	for (let index = children.length - 1; index >= 0; index--) {
		const child = children[index];
		if (child instanceof TimelineNoticeRow && child.drawsNothing) continue;
		return child;
	}
	return undefined;
}

/**
 * The row of a message another agent sent. In the quiet conversation it sits on
 * the timeline: a subagent's report comes back out of the lane, and the row that
 * closes the lane follows the last one. Otherwise it is the legacy row.
 */
export function createAgentMessageRow(
	message: AgentSessionMessage,
	options: {
		markdownTheme?: MarkdownTheme;
		quiet: boolean;
		lane: SubagentLane;
		previous: Component | undefined;
	},
): AgentMessageComponent {
	if (!options.quiet) {
		return new AgentMessageComponent(message, options.markdownTheme, {
			suppressLeadingSpace: isCompactAgentMessageNeighbor(options.previous),
		});
	}
	const tracker = options.lane.tracker;
	const back =
		message.details.fromRelationship === "child"
			? options.lane.comeBack(
					message.details.from?.sessionName,
					message.details.from?.activeSessionId,
					message.timestamp,
				)
			: { before: tracker.lane, after: tracker.lane };
	return new AgentMessageComponent(message, options.markdownTheme, {
		suppressLeadingSpace: options.previous instanceof AgentMessageComponent,
		timeline: back,
	});
}

export function isCompactAgentMessageNeighbor(component: Component | undefined): boolean {
	return (
		component instanceof AgentMessageComponent ||
		component instanceof ToolExecutionComponent ||
		component instanceof IPythonCellComponent ||
		component instanceof BashExecutionComponent
	);
}

function readUserText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

/** How a step's result says its turn went on, for a replay that cannot see the owner's key press. */
export interface StepResultStop {
	/** The run ended there on a stop: a message after it starts the next turn. */
	endsTurn: boolean;
	/** With nothing after it, the turn ended as stopped (not as an error). */
	stopped: boolean;
}

export const NO_STEP_STOP: StepResultStop = { endsTurn: false, stopped: false };

/**
 * The owner's stop leaves the agent loop's bare abort stub on the step it
 * caught (a stop with a reason, such as the stall watchdog's, names it, and
 * the live view does not count that as the owner's). A cell that reports
 * `status: "aborted"` was cut off, and the turn may still go on after it.
 */
export function stepResultStop(message: { content?: unknown; details?: unknown; isError?: boolean }): StepResultStop {
	const blocks = Array.isArray(message.content) ? (message.content as Array<{ type?: unknown; text?: unknown }>) : [];
	const ownerStop =
		message.isError === true &&
		blocks.some(
			(block) =>
				block.type === "text" &&
				(block.text === TOOL_ABORT_FALLBACK_MESSAGE || block.text === ABORT_TRUNCATION_MARKER),
		);
	const details = message.details;
	const cut =
		typeof details === "object" && details !== null && (details as { status?: unknown }).status === "aborted";
	return { endsTurn: ownerStop, stopped: ownerStop || cut };
}

/**
 * A reply that stopped on tool calls whose results have not come back yet. A report landing now is
 * inside that step, though the transcript orders it before the result (the live run joins it too).
 */
export function awaitsStepResults(reply: AgentMessage | undefined, resultsArrived: boolean): boolean {
	return (
		!resultsArrived &&
		reply?.role === "assistant" &&
		reply.stopReason === "toolUse" &&
		reply.content.some((block) => block.type === "toolCall")
	);
}

/**
 * Mirrors the literal customType in core/agent-session.ts
 * (_syncKernelStateAfterCompaction's prune notice), which is module-private
 * there - the same mirror arrangement as quota-park-status.ts. The source pin in
 * test/quota-park-status-ui.test.ts fails if either side is renamed.
 */
const IPYTHON_STATE_PRUNED_CUSTOM_TYPE = "ipython_state_pruned";

/** Row construction shared by the replay engine and the live custom-message path. */
interface ReplayExpandable {
	setExpanded(expanded: boolean): void;
}

function isReplayExpandable(obj: unknown): obj is ReplayExpandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
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

/**
 * Push one lane bundle onto a row: the per-turn values come from the owning
 * turn's TurnActivityState, the globals serve turn-less children. (U6 K3 ②)
 */
export function applyExpansionLanes(
	child: unknown,
	lanes: { thinking: boolean; tools: boolean; agentMessages: boolean; editDiffs: boolean },
): void {
	if (child instanceof AssistantMessageComponent) {
		// U6 two-key model: T drives the thinking traces; O drives the error
		// detail surface.
		child.setThinkingExpanded(lanes.thinking);
	}
	// A memory card opens by its own click or Enter; the process key never opens it.
	if (isReplayExpandable(child) && !(child instanceof RefinementOutcomeMessageComponent)) {
		child.setExpanded(child instanceof AgentMessageComponent ? lanes.agentMessages : lanes.tools);
	}
	if (hasAgentMessagesExpansion(child)) {
		child.setAgentMessagesExpanded(lanes.agentMessages);
	}
	if (hasEditDiffsExpansion(child)) {
		child.setEditDiffsExpanded(lanes.editDiffs);
	}
}

/**
 * A fallback-chain notice as one status row, like the live switch notice, so a
 * return to the primary or an unread image reads the same live and on replay.
 */
export function createProviderFallbackNoticeRow(message: CustomMessage): Component {
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

/**
 * THE replay: the one message-list -> chat-rows implementation. The interactive
 * mode's renderSessionContext (attach, resync, compaction and cap rebuilds)
 * drives it with the live wiring in `options.hooks`; buildConversationComponents
 * is the same run into a plain array, for tests. R3-5: a second, test-only
 * implementation had drifted from production (no bashExecution, branchSummary,
 * skill-block, legacy-heartbeat or provider-fallback rows, a different aborted-tool
 * wording, a different final-turn close) - there is now exactly one.
 */
export function replayConversation(
	messages: readonly AgentMessage[],
	target: ConversationReplayTarget,
	options: ConversationComponentsOptions,
): ConversationReplayResult {
	const hooks = options.hooks;
	const pendingTools = new Map<string, ToolExecutionComponent>();
	// Results that arrived without their call in this replay (the call is above
	// the window). Returned to the caller; a backfill page re-pairs them.
	const orphanToolResults = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
	const expanded = options.toolsExpanded ?? false;
	const thinkingExpanded = options.thinkingExpanded ?? false;
	const agentMessagesExpanded = options.agentMessagesExpanded ?? false;
	const editDiffsExpanded = options.editDiffsExpanded ?? false;
	const quiet = options.processMode === "quiet";
	const expansionLanes = {
		thinking: thinkingExpanded,
		tools: expanded,
		agentMessages: agentMessagesExpanded,
		editDiffs: editDiffsExpanded,
	};
	// U4/U6: one aggregate line per agent turn (the tool activity between two
	// user prompts), pinned at the turn head - the first line after the user
	// prompt. Settled tools hide themselves while the group is collapsed; the
	// turn's thinking blocks count into the same line (`思考 N 段`) and render
	// no rows of their own while collapsed.
	let turnState: TurnActivityState | undefined;
	let turnSummary: TurnSummaryComponent | undefined;
	// TUI v4: comms counted per turn (received agent-message rows + sent
	// agent messages inside ipython tool details), deduped by message id.
	const sentCommIds = new Set<string>();
	// Which subagents of the current question are still out: the lane the rows are drawn in.
	const lane = hooks?.subagentLane ?? new SubagentLane();
	// A turn a message woke (a subagent's report, a notice) is not the owner's own.
	let nextStartedByUser = true;
	// What woke the turn about to start; the turn takes it when its first reply comes.
	let pendingCause: WakeCause | undefined;
	// The reports the conversation has received so far: a notice that repeats one is bookkeeping.
	// (Production passes the live flow's own, pre-noted with what the window left out.)
	const reports = hooks?.reports ?? new ReceivedReports();
	// The owner's prompt opened the turn about to start: a report landing before its first reply does not take it over.
	let promptOpened = false;
	// The quiet timeline's round ends where its own last message landed, not when whatever came after it began.
	let roundEndedAt: number | undefined;
	const noteRoundAt = (message: AgentMessage): void => {
		const at = Number(message.timestamp);
		if (quiet && Number.isFinite(at) && at > 0) roundEndedAt = Math.max(roundEndedAt ?? 0, at);
	};
	let lastAssistant: AgentMessage | undefined;
	// An interjection lands after the step's results came back; a user message
	// straight after a tool call (an orphaned call) starts a turn.
	let resultsArrived = false;
	// How the last step's result says the turn went on (the owner's stop ends it there).
	let resultStop = NO_STEP_STOP;
	const closeTurn = (): void => {
		if (!turnState || !turnSummary || !quiet) return;
		turnState.timeline.stopped =
			(lastAssistant?.role === "assistant" && lastAssistant.stopReason === "aborted") || resultStop.stopped;
		turnState.timeline.errorEnded = lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error";
		hooks?.onTurnClose?.(turnState, turnSummary);
	};
	/** Freeze the turn's clock, then close it (the strip of a closed turn reads the frozen clock). */
	const endTurn = (at: number): void => {
		turnState?.markTurnEnded(at);
		closeTurn();
		turnState = undefined;
		turnSummary = undefined;
		lastAssistant = undefined;
		sentCommIds.clear();
	};

	// The run goes on inside the tool loop: a message that lands right after a step's results is part of the same turn.
	const insideToolLoop = (): boolean =>
		quiet &&
		turnState !== undefined &&
		lastAssistant?.role === "assistant" &&
		lastAssistant.stopReason === "toolUse" &&
		resultsArrived &&
		!resultStop.endsTurn;
	// A report is inside the round while its step runs too, though its result comes after it in the transcript.
	const insideRound = (): boolean =>
		insideToolLoop() || (quiet && turnState !== undefined && awaitsStepResults(lastAssistant, resultsArrived));

	/** The error text of a tool call left open by an aborted/error reply. */
	const interruptedToolErrorText = (message: AgentMessage): string => {
		if (message.role === "assistant" && message.stopReason === "aborted") {
			const retryAttempt = hooks?.retryAttempt?.() ?? 0;
			if (retryAttempt > 0) return `重试 ${retryAttempt} 次后已中断`;
			return message.errorMessage &&
				message.errorMessage !== "Request was aborted" &&
				message.errorMessage !== "Operation aborted"
				? message.errorMessage
				: "已中断";
		}
		return (message.role === "assistant" ? message.errorMessage : undefined) || "Error";
	};

	/**
	 * Where a report or notice row goes: a row of the turn that is running, among
	 * its lines by time; false when it belongs at the chat's end.
	 */
	const placeRow = (row: Component, at: number, into: TurnSummaryComponent | undefined): boolean => {
		if (!(row instanceof AgentMessageComponent) && !(row instanceof TimelineNoticeRow)) return false;
		if (!into?.state.boxMode) return false;
		const before = into.inlineRowBefore(at);
		if (before instanceof AgentMessageComponent && row instanceof AgentMessageComponent) row.joinPreviousRow();
		into.addInlineRow(row, at);
		return true;
	};

	/**
	 * A row that reaches the chat after its request's last turn finished (a memory
	 * line the tidy-up wrote): it goes above the closing row, so that stays the
	 * request's last line. Rounds the timeline leaves out may follow that row;
	 * they draw nothing and do not count.
	 */
	const addRowAboveClosingRow = (row: Component): void => {
		let index = target.children.length - 1;
		// Measurement render: a plain render() spends the turn reveal's one-shot
		// marker, and this probe runs between the arm and the frame that owes it.
		while (index >= 0 && blankAt(target.children[index])) index--;
		const closing = target.children[index];
		if (!(closing instanceof TurnStripComponent) || !closing.drawsClosingRow()) {
			target.addChild(row);
			return;
		}
		const tail = target.children.slice(index);
		for (const child of tail) target.removeChild(child);
		target.addChild(row);
		for (const child of tail) target.addChild(child);
	};

	/** The row of a displayed custom message, by customType. */
	const customRow = (message: CustomMessage): Component => {
		if (message.customType === PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE) return createProviderFallbackNoticeRow(message);
		if (isSessionSlashCommandMessage(message)) return new SlashCommandMessageComponent(message.content);
		if (isSessionSlashCommandResultMessage(message)) return new SlashCommandResultMessageComponent(message);
		if (
			message.customType === SESSION_SLASH_COMMAND_CUSTOM_TYPE ||
			message.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE
		) {
			return new UserMessageComponent("[Malformed session command message]", options.markdownTheme);
		}
		if (isCompactionOutcomeMessage(message)) return new CompactionOutcomeMessageComponent(message, { quiet });
		if (message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE)
			return new MalformedCompactionOutcomeMessageComponent();
		if (isRefinementOutcomeMessage(message)) return new RefinementOutcomeMessageComponent(message);
		if (message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE)
			return new MalformedRefinementOutcomeMessageComponent();
		// A subagent that ended, failed or went quiet: a row of the timeline, out of sight unless it failed.
		if (quiet) {
			const noticeRow = subagentNoticeRow(message, lane);
			if (noticeRow) return noticeRow;
		}
		if (isAgentSessionMessage(message)) {
			return createAgentMessageRow(message, {
				markdownTheme: options.markdownTheme,
				quiet,
				lane,
				previous: lastDrawnComponent(target.children),
			});
		}
		if (isInjectedPromptMessage(message)) return new InjectedPromptMessageComponent(message, options.markdownTheme);
		// 记忆-2 / 半落地尾巴①: the prune and context-loss notices are the only place
		// the owner hears about either; naming them keeps the mirrors of the
		// module-private producer literals referenced, so a rename cannot drop them
		// into the generic box unnoticed (source pins in quota-park-status-ui.test.ts
		// and session-context-loss-replay.test.ts).
		if (
			message.customType === IPYTHON_STATE_PRUNED_CUSTOM_TYPE ||
			message.customType === SESSION_CONTEXT_LOSS_CUSTOM_TYPE
		) {
			return new CustomMessageComponent(
				message,
				hooks?.extensionMessageRenderer?.(message.customType),
				options.markdownTheme,
			);
		}
		// Every remaining owner-visible custom notice renders as the generic box
		// instead of dropping into an "other custom" hole: provider_failure_recovery,
		// empty_response_recovery, system_interruption, stall_recovery_escalation,
		// rlm_child_recovery_action, image_delivery_suspicion, async_bash_completion,
		// autonomous_status, mcp_connection_outcome, ipython_bootstrap_failed,
		// thinking_level_clamped, ...
		return new CustomMessageComponent(
			message,
			hooks?.extensionMessageRenderer?.(message.customType),
			options.markdownTheme,
		);
	};

	for (const message of messages) {
		// A message that wakes the AI after its turn ended starts the next turn: the answer the turn
		// ended on stays its own, and the woken turn never folds it away (a live run does the same).
		// The wake machinery is quiet-only; the legacy face never splits a turn on a wake.
		if (quiet && isWakeMessage(message) && insideRound()) noteWakeInRound(turnState, message);
		if (quiet && isWakeMessage(message) && !insideRound() && !promptOpened) {
			pendingCause ??= new WakeCause(reports);
			pendingCause.add(message);
			endTurn(roundEndedAt ?? (Number(message.timestamp) || Date.now()));
			nextStartedByUser = false;
		}
		reports.note(message);
		if (message.role === "user") {
			const text = readUserText(message.content);
			// A message typed while the AI was between its steps: an interjection row in
			// the quiet turn's box, not a new turn (the live view does the same).
			if (turnState && insideToolLoop()) {
				turnState.timeline.addSteer(text.trim() || "[图片]", Number(message.timestamp) || Date.now());
				noteRoundAt(message);
				continue;
			}
			// A stored heartbeat prompt renders as an injected notice and never opens an owner turn.
			const special = text ? hooks?.renderUserPrompt?.(message, text) : undefined;
			const ownerOpened = special?.ownerOpened ?? true;
			// A user prompt starts a new turn; the previous group is settled by
			// then, so freeze its clock (thinking-only turns have no steps to
			// settle) and reset the grouping from here on.
			endTurn(roundEndedAt ?? (Number(message.timestamp) || Date.now()));
			// A new question: nobody is out, and the turn is the owner's own.
			if (ownerOpened) {
				lane.reset();
				hooks?.onOwnerPrompt?.(message, Number(message.timestamp) || undefined);
			}
			nextStartedByUser = ownerOpened;
			promptOpened = ownerOpened;
			pendingCause = undefined;
			if (!text) continue;
			if (target.children.length > 0) target.addChild(new Spacer(1));
			if (special) {
				for (const component of special.components) target.addChild(component);
				continue;
			}
			const skillBlock = parseSkillBlock(text);
			if (skillBlock) {
				const skill = new SkillInvocationMessageComponent(skillBlock, options.markdownTheme);
				skill.setExpanded(expanded);
				target.addChild(skill);
				if (skillBlock.userMessage) {
					target.addChild(
						createUserMessage(skillBlock.userMessage, {
							markdownTheme: options.markdownTheme,
							isRecognizedSlashCommand: options.isRecognizedSlashCommand,
							sentAt: Number(message.timestamp) || undefined,
							quiet,
							lane: hooks?.userLane?.(Number(message.timestamp) || undefined) ?? lane.tracker.lane,
						}),
					);
				}
				continue;
			}
			target.addChild(
				createUserMessage(text, {
					markdownTheme: options.markdownTheme,
					isRecognizedSlashCommand: options.isRecognizedSlashCommand,
					sentAt: Number(message.timestamp) || undefined,
					quiet,
					lane: hooks?.userLane?.(Number(message.timestamp) || undefined) ?? lane.tracker.lane,
				}),
			);
			continue;
		}
		if (message.role === "assistant") {
			hooks?.onAssistantMessage?.(message);
			// The turn summary is created at the turn head, before the first
			// assistant component; it renders nothing until the turn has steps
			// or thinking to aggregate.
			if (!turnState) {
				turnState = new TurnActivityState(Number(message.timestamp) || Date.now());
				roundEndedAt = undefined;
				turnState.startedByUser = nextStartedByUser;
				promptOpened = false;
				if (pendingCause) assignWakeCause(turnState, pendingCause);
				pendingCause = undefined;
				if (options.timelineHost) turnState.host = options.timelineHost;
				turnSummary = hooks?.createTurnSummary?.(turnState) ?? new QuietTurnSummary(turnState);
				if (options.timelineHost) turnSummary.setTimelineHost(options.timelineHost);
				turnSummary.setExpanded(expanded);
				// TUI v4: quiet turns carry the one-line footnote at their head.
				turnSummary.setQuiet(quiet);
				giveLaneTracker(turnSummary, lane.tracker);
				target.addChild(turnSummary);
				hooks?.onTurnCreated?.(turnState, turnSummary);
			}
			turnState.addThinkingSegments(countThinkingSegments(message));
			turnState.latestThinking = latestThinkingText(message) || turnState.latestThinking;
			turnState.modelId = message.model || turnState.modelId;
			turnState.timeline.noteMessage(message, true, true);
			turnState.noteReplyAt(Number(message.timestamp));
			noteRoundAt(message);
			lastAssistant = message;
			resultsArrived = false;
			resultStop = NO_STEP_STOP;
			const answer = new QuietAssistantMessage(
				turnState,
				message,
				options.hideThinkingBlock ?? false,
				options.markdownTheme,
				options.hiddenThinkingLabel ?? "Thinking",
				{
					cwd: options.cwd,
					expanded,
					thinkingExpanded,
					precededByToolActivity:
						target.children.at(-1) instanceof ToolExecutionComponent ||
						target.children.at(-1) instanceof AgentMessageComponent,
					// TUI v4: the replay path folds intermediate narration in quiet mode.
					quiet,
					...(options.mermaidTransform ? { mermaidTransform: options.mermaidTransform } : {}),
				} satisfies AssistantMessageComponentOptions,
			);
			giveLane(answer, lane.tracker.lane);
			target.addChild(answer);
			for (const content of message.content) {
				if (content.type !== "toolCall") {
					continue;
				}
				const step: TurnStep = {
					toolCallId: content.id,
					toolName: content.name,
					args: content.arguments,
					status: "running",
				};
				turnState.addStep(step);
				hooks?.onToolStep?.(turnState, turnSummary, content);
				const tool = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					{ ...options.toolOptions, includeImageDimensions: false },
					options.getToolDefinition(content.name),
					options.ui,
					options.cwd,
				);
				tool.setTurnActivity(turnState);
				tool.setExpanded(expanded || !turnState.isCollapsed);
				tool.setAgentMessagesExpanded(agentMessagesExpanded || turnState.agentMessagesExpanded);
				tool.setEditDiffsExpanded(editDiffsExpanded);
				selectLatestToolExpandHint(target.children, tool);
				target.addChild(tool);
				hooks?.onToolComponent?.(tool, content, turnState);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					const errorText = interruptedToolErrorText(message);
					tool.updateResult({
						content: [{ type: "text", text: errorText }],
						isError: true,
					});
					turnState.timeline.mergeStep(
						content.id,
						content.name,
						content.arguments,
						{ content: [{ type: "text", text: errorText }], isError: true },
						false,
					);
					// Batch1 review P1-2: settle the step like the live path
					// (message_end) does - without this the aborted turn's steps stay
					// "running" forever, the footnote's duration becomes
					// Date.now()-startedAt and never freezes.
					turnState.setStepStatus(content.id, "error", Number(message.timestamp) || Date.now());
				} else {
					pendingTools.set(content.id, tool);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			resultsArrived = true;
			resultStop = stepResultStop(message);
			noteRoundAt(message);
			// Match tool results to pending tool components
			const component = pendingTools.get(message.toolCallId);
			if (component) {
				component.updateResult(message);
				pendingTools.delete(message.toolCallId);
			} else {
				// The call is outside this replay's window (or was already settled
				// as interrupted): keep the result for a backfill page to re-pair.
				orphanToolResults.set(message.toolCallId, message);
			}
			turnState?.setStepStatus(
				message.toolCallId,
				message.isError ? "error" : "done",
				Number(message.timestamp) || Date.now(),
			);
			turnState?.timeline.mergeStep(
				message.toolCallId,
				message.toolName,
				turnState.steps.find((step) => step.toolCallId === message.toolCallId)?.args,
				message,
				false,
			);
			hooks?.onToolResult?.(message, turnState);
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
					if (id === undefined || sentCommIds.has(id)) {
						continue;
					}
					sentCommIds.add(id);
					turnSummary?.addCommMessage();
				}
			}
			continue;
		}
		if (
			quiet &&
			turnState &&
			message.role === "custom" &&
			!isSubagentNoticeMessage(message) &&
			isBoxNoticeMessage(message)
		) {
			// The box says it as its own row (a compaction that waited). A subagent
			// notice that is also a box notice never lands here: it dispatches as a
			// timeline row below, like the mode's replay orders it.
			const record = boxRecordFromMessage(message);
			if (record?.kind === "compaction") {
				turnState.timeline.addReplayCompaction(Number(message.timestamp) || 0, record.facts);
			}
			continue;
		}
		if (message.role === "compactionSummary") {
			if (quiet && turnState) {
				// Inside a turn the compaction is a row of its box.
				turnState.timeline.addReplayCompaction(Number(message.timestamp) || 0, { before: message.tokensBefore });
			} else if (quiet) {
				// The quiet conversation says it in one faint line; the summary opens on a click.
				target.addChild(new QuietCompactionNoticeComponent(message, options.markdownTheme));
			} else {
				target.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, options.markdownTheme);
				component.setExpanded(expanded);
				target.addChild(component);
			}
			continue;
		}
		if (message.role === "bashExecution") {
			const component = new BashExecutionComponent(message.command, options.ui, message.excludeFromContext, {
				suppressLeadingSpace: target.children.at(-1) instanceof AgentMessageComponent,
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
			target.addChild(component);
			continue;
		}
		if (message.role === "branchSummary") {
			target.addChild(new Spacer(1));
			const component = new BranchSummaryMessageComponent(message, options.markdownTheme);
			component.setExpanded(expanded);
			target.addChild(component);
			continue;
		}
		if (message.role === "custom") {
			if (!message.display) continue;
			// TUI v4: a received agent-message row is one comm in this turn.
			if (isAgentSessionMessage(message)) turnSummary?.addCommMessage();
			if (isSessionSlashCommandMessage(message) && target.children.length > 0) target.addChild(new Spacer(1));
			const component = customRow(message);
			applyExpansionLanes(component, expansionLanes);
			const at = Number(message.timestamp) || Date.now();
			// A report that joined the running round is a row of that turn, not of the chat's end.
			const into = quiet && isWakeMessage(message) && insideRound() ? turnSummary : undefined;
			if (!placeRow(component, at, into)) {
				// A memory line after a finished request goes above its closing row, which stays the last line.
				if (message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE) {
					addRowAboveClosingRow(component);
				} else {
					target.addChild(component);
				}
			}
		}
		// display:false customs aren't shown.
	}
	// The last turn has no following user prompt; freeze its clock at the last
	// message so a thinking-only line stops ticking - unless the run is still
	// going and the live path takes the open turn over.
	const turnOpen = turnState !== undefined && (pendingTools.size > 0 || options.keepFinalTurnOpen?.() === true);
	if (!turnOpen) {
		turnState?.markTurnEnded(roundEndedAt ?? (Number(messages.at(-1)?.timestamp) || Date.now()));
		closeTurn();
		turnState = undefined;
		turnSummary = undefined;
	}
	if (quiet) {
		// Within a box turn only the last reply's answer stays under the box, and a
		// turn no user message opened draws no second title.
		foldEarlierAnswers(target.children);
		resolveTurnHeaders(target.children);
	}
	return {
		turnState,
		turnSummary,
		turnOpen,
		pendingTools,
		orphanToolResults,
	};
}

/**
 * The replay into a plain array, for tests: the same single implementation
 * production drives, minus the live-session hooks.
 */
export function buildConversationComponents(
	messages: readonly AgentMessage[],
	options: ConversationComponentsOptions,
): Component[] {
	const components: Component[] = [];
	const target: ConversationReplayTarget = {
		children: components,
		addChild: (component) => {
			components.push(component);
		},
		removeChild: (component) => {
			const index = components.indexOf(component);
			if (index >= 0) components.splice(index, 1);
		},
	};
	replayConversation(messages, target, options);
	return components;
}

/**
 * Within one box turn only the last reply's answer stays under the box: an
 * earlier answer (the run was carried on by a notice, a retry or a compaction)
 * folds into the box as a row. `only` limits the walk to one turn.
 */
export function foldEarlierAnswers(children: readonly Component[], only?: TurnSummaryComponent): void {
	let span: AssistantMessageComponent[] | undefined;
	const settle = (): void => {
		const replies = span;
		span = undefined;
		if (!replies) return;
		replies.forEach((component, index) => {
			const later = replies.slice(index + 1).some((next) => replyHasWork(next.message));
			if (later && isPlainAnswer(component.message)) component.setSuperseded(true);
		});
	};
	for (const child of children) {
		if (child instanceof TurnSummaryComponent) {
			settle();
			if (child.state.boxMode && (only === undefined || child === only)) span = [];
		} else if (child instanceof UserMessageComponent) {
			settle();
		} else if (span && child instanceof AssistantMessageComponent) {
			span.push(child);
		}
	}
	settle();
}

/** Where a turn's title starts over: a compaction between two turns. */
function isTitleBoundary(child: Component): boolean {
	return (
		child instanceof QuietCompactionNoticeComponent ||
		child instanceof CompactionSummaryMessageComponent ||
		child instanceof CompactionOutcomeMessageComponent ||
		child instanceof MalformedCompactionOutcomeMessageComponent
	);
}

/** Width at which a component above is asked what it draws; only whether its last line is blank matters. */
const BLANK_PROBE_WIDTH = 80;

function blankAt(child: Component | undefined): boolean {
	if (!child) return true;
	const measurable = child as { renderForMeasurement?: (width: number) => string[] };
	const lines = measurable.renderForMeasurement
		? measurable.renderForMeasurement(BLANK_PROBE_WIDTH)
		: child.render(BLANK_PROBE_WIDTH);
	return lines.length === 0;
}
const TERMINAL_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[\]_][^\x07]*\x07/g;

/**
 * Whether the nearest component above `index` that draws anything ends in a blank
 * line (a stopped reply does, its own spacer). A box above ends in its border, and
 * with nothing above there is no line to keep apart from.
 */
function endsInBlankLine(children: readonly Component[], index: number): boolean {
	for (let above = index - 1; above >= 0; above--) {
		const component = children[above];
		if (component instanceof TurnSummaryComponent) {
			// A round left out draws nothing: what is above it decides.
			if (isAckRound(component.state)) continue;
			return false;
		}
		const last = component?.render(BLANK_PROBE_WIDTH).at(-1);
		if (last !== undefined) return last.replace(TERMINAL_ESCAPES, "").trim() === "";
	}
	return true;
}

/**
 * One title per question: a turn that no user message opened (a handed-back
 * message woke it, a background command ended, the run went on by itself) and
 * whose model is the one on the nearest title shown above it draws no
 * `◆ prime  <model>` line of its own, its box hangs under what is above. The
 * first turn, the first turn after a user message or a compaction, a turn a
 * user message opened and a turn on another model keep their title. Consecutive
 * groups stay apart by empty main-line rows: the block of a turn the user opened
 * draws two above its lines, a woken turn's one, unless what is above already ends in a blank line.
 */
export function resolveTurnHeaders(children: readonly Component[]): void {
	let shownModel: string | undefined;
	for (const [index, child] of children.entries()) {
		if (child instanceof TurnSummaryComponent) {
			const model = child.state.modelId;
			const show = child.state.startedByUser || shownModel === undefined || shownModel !== model;
			child.setHeaderShown(show);
			// The question leaves no empty row under itself: its turn's lines open with two, a woken turn's
			// with one (none when what is above already ends in a blank line).
			child.setLeadingRows(child.state.startedByUser ? 2 : endsInBlankLine(children, index) ? 0 : 1);
			if (show) shownModel = model;
		} else if (child instanceof UserMessageComponent || isTitleBoundary(child)) {
			shownModel = undefined;
		}
	}
}

/** The last non-empty thinking trace of one assistant message, or "". */
export function latestThinkingText(message: { content: ReadonlyArray<{ type: string; thinking?: string }> }): string {
	for (let index = message.content.length - 1; index >= 0; index--) {
		const block = message.content[index];
		const text = block?.type === "thinking" ? (block.thinking ?? "").trim() : "";
		if (text) return text;
	}
	return "";
}

/** Non-empty thinking blocks of one assistant message (U6 segment counting). */
export function countThinkingSegments(message: {
	content: ReadonlyArray<{ type: string; thinking?: string }>;
}): number {
	return message.content.filter((block) => block.type === "thinking" && (block.thinking ?? "").trim().length > 0)
		.length;
}
