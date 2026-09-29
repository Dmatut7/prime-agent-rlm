import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Spacer } from "@earendil-works/pi-tui";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { createRlmChildFailureMessage, createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import {
	createAgentMessageRow,
	createUserMessage,
	foldEarlierAnswers,
	giveLane,
	lastDrawnComponent,
	QuietAssistantMessage,
	QuietTurnSummary,
} from "../src/modes/interactive/components/conversation-components.js";
import { subagentNoticeRow } from "../src/modes/interactive/components/system-notice.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { LiveTurnFlow } from "../src/modes/interactive/live-turn-flow.js";
import { assistant, T0 } from "./ui-blocks-helpers.js";

export function handedBack(id: string, at = T0, name = "ff-review-d-keys"): AgentSessionMessage {
	return createAgentSessionMessage(
		{
			id,
			source: AGENT_MESSAGE_SOURCE,
			message: "审查完毕",
			from: { sessionName: name, sessionId: `${id}-child`, activeSessionId: `${id}-child-active` },
			fromRelationship: "child",
			target: { activeSessionId: "main-active", sessionId: "main" },
		},
		at,
	);
}

/**
 * The live path: a chat and the flow that feeds it, filled the way the interactive
 * mode fills its chat (a spacer before a prompt, a reply's component, a handed-back
 * message's row with its own spacing rule).
 */
export class LiveChat {
	readonly chat = new Container();
	readonly flow: LiveTurnFlow;
	private readonly timelineHost: TimelineHost;
	private current: TurnSummaryComponent | undefined;
	private streaming = false;
	private clock = T0;

	constructor() {
		const timelineHost: TimelineHost = {
			cwd: () => "/work/app",
			viewportRows: () => 40,
			openWhileWorking: () => true,
			autoFold: () => true,
			requestRender: () => {},
		};
		this.timelineHost = timelineHost;
		this.flow = new LiveTurnFlow({
			chat: () => this.chat,
			quiet: () => true,
			isStreaming: () => this.streaming,
			retryPending: () => false,
			compacting: () => false,
			contextTokens: () => undefined,
			cwd: () => "/work/app",
			rlmNodeId: () => undefined,
			createSummary: (state) => {
				const summary = new QuietTurnSummary(state);
				summary.setTimelineHost(timelineHost);
				return summary;
			},
			runStartedAt: () => undefined,
			startExpanded: () => false,
			currentState: () => this.current?.state,
			currentSummary: () => this.current,
			setCurrent: (summary) => {
				this.current = summary;
			},
			foldEarlierAnswers: (summary) => foldEarlierAnswers(this.chat.children, summary),
			requestRender: () => {},
			liveChanged: () => {},
		});
	}

	private tick(): number {
		this.clock += 1_000;
		return this.clock;
	}

	private reply(model: string, answer: string | undefined, cutMidStep = false, endRun = true): void {
		const content = cutMidStep
			? [
					{
						type: "toolCall" as const,
						id: `cut${this.clock}`,
						name: "ipython",
						arguments: { code: "await bash('sleep 60')" },
					},
				]
			: answer
				? [{ type: "text" as const, text: answer }]
				: [];
		const message = assistant(this.tick(), content, cutMidStep ? "aborted" : "stop", model);
		this.flow.assistantStart(message);
		const component = new QuietAssistantMessage(this.current?.state, undefined, false, undefined, "Thinking", {
			quiet: true,
		});
		giveLane(component, this.flow.subagentLane.tracker.lane);
		this.chat.addChild(component);
		component.updateContent(message, false);
		this.streamed(message);
		this.flow.assistantEnd(message);
		if (endRun) this.endRun();
	}

	/** The run is over (agent_end). */
	endRun(): void {
		this.flow.agentEnd();
		this.streaming = false;
	}

	/** The stream events a real message sends: the text lands, a later reply folds the earlier answers away. */
	private streamed(message: AssistantMessage): void {
		const index = message.content.findIndex((block) => block.type === "text");
		const block = message.content[index];
		if (block?.type === "text") {
			this.flow.assistantUpdate(message, {
				type: "text_end",
				contentIndex: index,
				content: block.text,
				partial: message,
			});
		}
	}

	private addMessageRow(message: AgentSessionMessage): void {
		this.chat.addChild(
			createAgentMessageRow(message, {
				quiet: true,
				lane: this.flow.subagentLane,
				previous: lastDrawnComponent(this.chat.children),
			}),
		);
	}

	/** The user types a prompt and the AI answers on `model` (or is stopped in the middle of a step). */
	prompt(text: string, options: { model?: string; answer?: string; cutMidStep?: boolean } = {}): void {
		this.streaming = true;
		this.flow.agentStart();
		if (this.flow.userMessage(text, this.tick()) === "prompt") {
			if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
			this.chat.addChild(
				createUserMessage(text, { quiet: true, lane: this.flow.subagentLane.tracker.lane, sentAt: this.clock }),
			);
		}
		this.reply(options.model ?? "glm-5.3-prime", options.answer, options.cutMidStep);
	}

	/**
	 * A subagent hands a message back, which wakes the AI on `model`; `also` are
	 * messages that land right after it, before the AI starts answering.
	 */
	wake(
		id: string,
		options: { model?: string; answer?: string; name?: string; also?: Array<{ id: string; name: string }> } = {},
	): void {
		this.streaming = true;
		this.flow.agentStart();
		const message = handedBack(id, this.tick(), options.name);
		if (!this.flow.customMessage(message)) this.addMessageRow(message);
		for (const other of options.also ?? []) this.addMessageRow(handedBack(other.id, this.tick(), other.name));
		this.reply(options.model ?? "glm-5.3-prime", options.answer);
	}

	/**
	 * A view that attaches while a step runs: the chat holds the replayed turn, live, whose last
	 * reply is a tool call this view never saw end (no agent_start reaches it).
	 */
	attachMidRun(prompt: string): void {
		this.chat.addChild(
			createUserMessage(prompt, { quiet: true, lane: this.flow.subagentLane.tracker.lane, sentAt: this.clock }),
		);
		const state = new TurnActivityState(this.clock);
		state.live = true;
		state.modelId = "glm-5.3-prime";
		const call = assistant(
			this.tick(),
			[{ type: "toolCall", id: `run${this.clock}`, name: "ipython", arguments: { code: "await bash('sleep 60')" } }],
			"toolUse",
		);
		state.timeline.noteMessage(call, true);
		const summary = new QuietTurnSummary(state);
		summary.setTimelineHost(this.timelineHost);
		summary.setQuiet(true);
		this.chat.addChild(summary);
		this.current = summary;
		this.streaming = true;
	}

	/** The AI dispatches subagents: what a turn's dispatch row does to the lane. */
	dispatch(...names: string[]): void {
		this.flow.subagentLane.tracker.spawned(names);
	}

	/** A subagent's notice wakes the AI (it finished without a word, or it failed). */
	wakeByNotice(
		name: string,
		options: { model?: string; answer?: string; failed?: boolean; lastText?: string; running?: boolean } = {},
	): void {
		this.streaming = true;
		this.flow.agentStart();
		const at = this.tick();
		const notice = options.failed
			? createRlmChildFailureMessage({ childId: `${name}-id`, sessionName: name, error: "boom", kind: "error" }, at)
			: createRlmChildTerminalNoticeMessage(
					{
						kind: "completed_without_reply",
						childId: `${name}-id`,
						sessionName: name,
						...(options.lastText ? { lastAssistantText: options.lastText } : {}),
					},
					at,
				);
		if (!this.flow.customMessage(notice)) {
			const row = subagentNoticeRow(notice, this.flow.subagentLane);
			if (row) this.chat.addChild(row);
		}
		this.reply(options.model ?? "glm-5.3-prime", options.answer, false, options.running !== true);
	}

	/** A wake-up whose message the chat does not show. */
	wakeUnseen(id: string, options: { model?: string; answer?: string } = {}): void {
		this.streaming = true;
		this.flow.agentStart();
		this.flow.customMessage({ ...handedBack(id, this.tick()), display: false });
		this.reply(options.model ?? "glm-5.3-prime", options.answer);
	}

	/** A run that no message started (an automatic continuation). */
	continueOnItsOwn(model = "glm-5.3-prime"): void {
		this.streaming = true;
		this.flow.agentStart();
		this.reply(model, undefined);
	}

	summaries(): TurnSummaryComponent[] {
		return this.chat.children.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);
	}

	lines(width = 100): string[] {
		return this.chat.children.flatMap((child) => child.render(width));
	}
}
