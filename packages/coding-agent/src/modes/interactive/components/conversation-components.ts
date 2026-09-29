import { ABORT_TRUNCATION_MARKER, type AgentMessage, TOOL_ABORT_FALLBACK_MESSAGE } from "@earendil-works/pi-agent-core";
import { type Component, type MarkdownTheme, Spacer, type TUI } from "@earendil-works/pi-tui";
import { isAgentSessionMessage } from "../../../core/agent-messages.js";
import {
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	isCompactionOutcomeMessage,
	isRefinementOutcomeMessage,
	isSessionSlashCommandMessage,
	isSessionSlashCommandResultMessage,
	REFINEMENT_OUTCOME_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
} from "../../../core/messages.js";
import type { ProcessModeSetting } from "../../../core/settings-manager.js";
import { AGENT_MESSAGE_TURN_INSET, AgentMessageComponent } from "./agent-message.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { BashExecutionComponent } from "./bash-execution.js";
import {
	CompactionOutcomeMessageComponent,
	MalformedCompactionOutcomeMessageComponent,
} from "./compaction-outcome-message.js";
import { CompactionSummaryMessageComponent, QuietCompactionNoticeComponent } from "./compaction-summary-message.js";
import { CustomMessageComponent } from "./custom-message.js";
import { InjectedPromptMessageComponent, isInjectedPromptMessage } from "./injected-prompt-message.js";
import { IPythonCellComponent } from "./ipython-cell.js";
import {
	MalformedRefinementOutcomeMessageComponent,
	RefinementOutcomeMessageComponent,
} from "./refinement-outcome-message.js";
import { SlashCommandMessageComponent } from "./slash-command-message.js";
import { SlashCommandResultMessageComponent } from "./slash-command-result-message.js";
import {
	selectLatestToolExpandHint,
	ToolExecutionComponent,
	type ToolExecutionDefinition,
	type ToolExecutionOptions,
} from "./tool-execution.js";
import { type TimelineHost, TurnActivityState, type TurnStep, TurnSummaryComponent } from "./turn-activity.js";
import { boxRecordFromMessage, isBoxNoticeMessage, isPlainAnswer, replyHasWork } from "./turn-timeline.js";
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

/** Build conversation components from a message list, matching tool results to their calls. */
export function buildConversationComponents(
	messages: readonly AgentMessage[],
	options: ConversationComponentsOptions,
): Component[] {
	const components: Component[] = [];
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const expanded = options.toolsExpanded ?? false;
	const thinkingExpanded = options.thinkingExpanded ?? false;
	const agentMessagesExpanded = options.agentMessagesExpanded ?? false;
	const editDiffsExpanded = options.editDiffsExpanded ?? false;
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

	const ensureTurn = (startedAt: number): TurnActivityState => {
		if (!turnState) {
			turnState = new TurnActivityState(startedAt);
			if (options.timelineHost) turnState.host = options.timelineHost;
		}
		return turnState;
	};
	const quiet = options.processMode === "quiet";
	let lastAssistant: AgentMessage | undefined;
	// An interjection lands after the step's results came back; a user message
	// straight after a tool call (an orphaned call) starts a turn.
	let resultsArrived = false;
	// How the last step's result says the turn went on (the owner's stop ends it there).
	let resultStop = NO_STEP_STOP;
	const closeTurn = (): void => {
		if (!turnState || lastAssistant?.role !== "assistant") return;
		turnState.timeline.stopped = lastAssistant.stopReason === "aborted" || resultStop.stopped;
		turnState.timeline.errorEnded = lastAssistant.stopReason === "error";
	};

	for (const message of messages) {
		if (message.role === "user") {
			// Typed while the AI was between its steps: an interjection row in
			// the quiet turn's box, not a new turn (the live view does the same).
			if (
				quiet &&
				turnState &&
				lastAssistant?.role === "assistant" &&
				lastAssistant.stopReason === "toolUse" &&
				resultsArrived &&
				!resultStop.endsTurn
			) {
				turnState.timeline.addSteer(
					readUserText(message.content).trim() || "[图片]",
					Number(message.timestamp) || 0,
				);
				continue;
			}
			// A user prompt starts a new turn; the previous group is settled by
			// then, so freeze its clock (thinking-only turns have no steps to
			// settle) and reset the grouping from here on.
			closeTurn();
			turnState?.markTurnEnded(Number(message.timestamp) || Date.now());
			turnState = undefined;
			turnSummary = undefined;
			sentCommIds.clear();
		}
		if (message.role === "assistant") {
			// The turn summary is created at the turn head, before the first
			// assistant component; it renders nothing until the turn has steps
			// or thinking to aggregate.
			const state = ensureTurn(Number(message.timestamp) || Date.now());
			state.addThinkingSegments(countThinkingSegments(message));
			state.latestThinking = latestThinkingText(message) || state.latestThinking;
			state.modelId = message.model || state.modelId;
			state.timeline.noteMessage(message, true);
			state.noteReplyAt(Number(message.timestamp));
			lastAssistant = message;
			resultsArrived = false;
			resultStop = NO_STEP_STOP;
			if (!turnSummary) {
				turnSummary = new TurnSummaryComponent(state);
				turnSummary.setExpanded(expanded);
				// TUI v4: quiet turns carry the one-line footnote at their head.
				turnSummary.setQuiet(options.processMode === "quiet");
				components.push(turnSummary);
			}
			components.push(
				new AssistantMessageComponent(
					message,
					options.hideThinkingBlock ?? false,
					options.markdownTheme,
					options.hiddenThinkingLabel ?? "Thinking",
					{
						cwd: options.cwd,
						expanded,
						thinkingExpanded,
						precededByToolActivity:
							components.at(-1) instanceof ToolExecutionComponent ||
							components.at(-1) instanceof AgentMessageComponent,
						// TUI v4: the same quiet gate covers the test builder path.
						quiet: options.processMode === "quiet",
					},
				),
			);
			for (const content of message.content) {
				if (content.type !== "toolCall") {
					continue;
				}
				const step: TurnStep = {
					toolCallId: content.id,
					toolName: content.name,
					args: content.arguments,
					status: "queued",
				};
				state.addStep(step);
				const tool = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					{ ...options.toolOptions, includeImageDimensions: false },
					options.getToolDefinition(content.name),
					options.ui,
					options.cwd,
				);
				tool.setTurnActivity(state);
				tool.setExpanded(expanded);
				tool.setAgentMessagesExpanded(agentMessagesExpanded);
				tool.setEditDiffsExpanded(editDiffsExpanded);
				tool.markExecutionStarted();
				tool.setArgsComplete();
				state.markRunning(content.id, Number(message.timestamp) || Date.now());
				selectLatestToolExpandHint(components, tool);
				components.push(tool);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					tool.updateResult({
						content: [
							{
								type: "text",
								text:
									message.errorMessage && message.errorMessage !== "Operation aborted"
										? message.errorMessage
										: "已中断",
							},
						],
						isError: true,
					});
					state.timeline.mergeStep(
						content.id,
						content.name,
						content.arguments,
						{ content: [{ type: "text", text: message.errorMessage || "已中断" }], isError: true },
						false,
					);
					state.setStepStatus(content.id, "error", Number(message.timestamp) || Date.now());
				} else {
					pendingTools.set(content.id, tool);
				}
			}
		} else if (message.role === "toolResult") {
			resultsArrived = true;
			resultStop = stepResultStop(message);
			pendingTools.get(message.toolCallId)?.updateResult(message);
			pendingTools.delete(message.toolCallId);
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
		} else if (
			message.role === "custom" &&
			(message.customType === SESSION_SLASH_COMMAND_CUSTOM_TYPE ||
				message.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE)
		) {
			if (!message.display) continue;
			if (isSessionSlashCommandMessage(message)) {
				components.push(new SlashCommandMessageComponent(message.content));
			} else if (isSessionSlashCommandResultMessage(message)) {
				components.push(new SlashCommandResultMessageComponent(message));
			} else {
				components.push(new UserMessageComponent("[Malformed session command message]", options.markdownTheme));
			}
		} else if (quiet && turnState && message.role === "custom" && isBoxNoticeMessage(message)) {
			// The box says it as its own row (a subagent that finished, a compaction that waited).
			const record = boxRecordFromMessage(message);
			if (record?.kind === "notice") turnState.timeline.addNotice(record.notice, Number(message.timestamp) || 0);
			if (record?.kind === "compaction") {
				turnState.timeline.addReplayCompaction(Number(message.timestamp) || 0, record.facts);
			}
		} else if (quiet && message.role === "compactionSummary") {
			if (turnState) {
				turnState.timeline.addReplayCompaction(Number(message.timestamp) || 0, { before: message.tokensBefore });
			} else {
				components.push(new QuietCompactionNoticeComponent(message, options.markdownTheme));
			}
		} else if (message.role === "custom" && message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE) {
			if (!message.display) continue;
			components.push(
				isCompactionOutcomeMessage(message)
					? new CompactionOutcomeMessageComponent(message, { quiet })
					: new MalformedCompactionOutcomeMessageComponent(),
			);
		} else if (message.role === "custom" && message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE) {
			if (!message.display) continue;
			// The memory line opens by its own click or Enter, never with the process lane.
			components.push(
				isRefinementOutcomeMessage(message)
					? new RefinementOutcomeMessageComponent(message)
					: new MalformedRefinementOutcomeMessageComponent(),
			);
		} else if (isAgentSessionMessage(message) && message.display) {
			// TUI v4: a received agent-message row is one comm in this turn.
			turnSummary?.addCommMessage();
			const component = new AgentMessageComponent(message, options.markdownTheme, {
				suppressLeadingSpace: isCompactAgentMessageNeighbor(components.at(-1)),
				// Inside a quiet turn the row lines up with the turn's steps.
				inset: options.processMode === "quiet" && turnSummary ? AGENT_MESSAGE_TURN_INSET : 0,
			});
			component.setExpanded(agentMessagesExpanded);
			components.push(component);
		} else if (isInjectedPromptMessage(message) && message.display) {
			const component = new InjectedPromptMessageComponent(message, options.markdownTheme);
			component.setExpanded(expanded);
			components.push(component);
		} else if (message.role === "user") {
			const text = readUserText(message.content);
			const hasContent =
				typeof message.content === "string" ? message.content.length > 0 : message.content.length > 0;
			// An image-only prompt has no text; show a placeholder rather than dropping it.
			const display = text || (hasContent ? "[image]" : "");
			if (display) {
				components.push(
					new UserMessageComponent(
						display,
						options.markdownTheme,
						options.isRecognizedSlashCommand,
						Number(message.timestamp) || undefined,
					),
				);
			}
		}
		// Non-conversational messages (bash/branch-summary/compaction/other custom) aren't shown.
	}
	// The last turn has no following user prompt; freeze its clock at the last
	// message so a thinking-only line stops ticking.
	closeTurn();
	turnState?.markTurnEnded(Number(messages.at(-1)?.timestamp) || Date.now());
	if (quiet) {
		foldEarlierAnswers(components);
		resolveTurnHeaders(components);
	}
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

/**
 * Rows that already keep a blank line above them and none below: a turn woken
 * by one of them hangs straight under it, a turn woken by anything else gets a
 * blank line of its own.
 */
function keepsItsOwnSpace(component: Component | undefined): boolean {
	return (
		component === undefined ||
		component instanceof Spacer ||
		component instanceof UserMessageComponent ||
		component instanceof AgentMessageComponent ||
		component instanceof InjectedPromptMessageComponent ||
		component instanceof CustomMessageComponent
	);
}

/** Width at which a component above is asked what it draws; only whether its last line is blank matters. */
const BLANK_PROBE_WIDTH = 80;
const TERMINAL_ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[\]_][^\x07]*\x07/g;

/**
 * Whether the nearest component above `index` that draws anything ends in a blank
 * line (a stopped reply does, its own spacer). A box above ends in its border, and
 * with nothing above there is no line to keep apart from.
 */
function endsInBlankLine(children: readonly Component[], index: number): boolean {
	for (let above = index - 1; above >= 0; above--) {
		const component = children[above];
		if (component instanceof TurnSummaryComponent) return false;
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
 * groups stay one blank line apart: a woken turn whose message row is not right
 * above it gets that blank line itself, unless what is above already ends in one.
 */
export function resolveTurnHeaders(children: readonly Component[]): void {
	let shownModel: string | undefined;
	let previous: Component | undefined;
	for (const [index, child] of children.entries()) {
		if (child instanceof TurnSummaryComponent) {
			const model = child.state.modelId;
			const show = child.state.startedByUser || shownModel === undefined || shownModel !== model;
			child.setHeaderShown(show);
			child.setLeadingBlank(
				!child.state.startedByUser && !keepsItsOwnSpace(previous) && !endsInBlankLine(children, index),
			);
			if (show) shownModel = model;
		} else if (child instanceof UserMessageComponent || isTitleBoundary(child)) {
			shownModel = undefined;
		}
		previous = child;
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
