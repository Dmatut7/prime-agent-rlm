import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Spacer } from "@earendil-works/pi-tui";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import {
	type CustomMessage,
	createRlmChildFailureMessage,
	createRlmChildTerminalNoticeMessage,
} from "../src/core/messages.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
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
import { LiveTurnFlow, type RequestSpend } from "../src/modes/interactive/live-turn-flow.js";
import { assistant, T0 } from "./ui-blocks-helpers.js";

export function handedBack(id: string, at = T0, name = "ff-review-d-keys", text = "审查完毕"): AgentSessionMessage {
	return createAgentSessionMessage(
		{
			id,
			source: AGENT_MESSAGE_SOURCE,
			message: text,
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

	constructor(options: { spend?: () => RequestSpend | undefined } = {}) {
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
			...(options.spend ? { subagentSpend: options.spend } : {}),
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
		const row = createAgentMessageRow(message, {
			quiet: true,
			lane: this.flow.subagentLane,
			previous: lastDrawnComponent(this.chat.children),
		});
		if (!this.flow.placeRow(row, message.timestamp)) this.chat.addChild(row);
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
		for (const other of options.also ?? []) {
			const next = handedBack(other.id, this.tick(), other.name);
			if (!this.flow.customMessage(next)) this.addMessageRow(next);
		}
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
		options: {
			model?: string;
			answer?: string;
			failed?: boolean;
			cancelled?: boolean;
			lastText?: string;
			running?: boolean;
		} = {},
	): void {
		this.streaming = true;
		this.flow.agentStart();
		const at = this.tick();
		const notice = options.failed
			? createRlmChildFailureMessage({ childId: `${name}-id`, sessionName: name, error: "boom", kind: "error" }, at)
			: createRlmChildTerminalNoticeMessage(
					options.cancelled
						? { kind: "cancelled", childId: `${name}-id`, sessionName: name }
						: {
								kind: "completed_without_reply",
								childId: `${name}-id`,
								sessionName: name,
								...(options.lastText ? { lastAssistantText: options.lastText } : {}),
							},
					at,
				);
		if (!this.flow.customMessage(notice)) {
			const row = subagentNoticeRow(notice, this.flow.subagentLane);
			if (row && !this.flow.placeRow(row, at)) this.chat.addChild(row);
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

	/** The clock the next message is stamped with. */
	setClock(at: number): void {
		this.clock = at;
	}

	/** The owner sends a prompt; the AI has not answered yet. */
	user(text: string): void {
		this.streaming = true;
		this.flow.agentStart();
		if (this.flow.userMessage(text, this.clock) === "prompt") {
			if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
			this.chat.addChild(
				createUserMessage(text, { quiet: true, lane: this.flow.subagentLane.tracker.lane, sentAt: this.clock }),
			);
		}
	}

	/**
	 * An assistant message stamped `at`: optional words, an optional thought, then tool calls. Each
	 * call ends at once with `results[id]` (the tool result's details); a message with no call is a
	 * plain reply. `open` leaves the message streaming with its calls still running.
	 */
	say(
		at: number,
		content: {
			words?: string;
			thought?: string;
			calls?: Array<{
				id: string;
				code: string;
				details?: unknown;
				isError?: boolean;
				text?: string;
				endsAt?: number;
			}>;
		},
		options: { open?: boolean } = {},
	): void {
		this.clock = at;
		const calls = content.calls ?? [];
		const message = assistant(
			at,
			[
				...(content.thought ? [{ type: "thinking" as const, thinking: content.thought }] : []),
				...(content.words ? [{ type: "text" as const, text: content.words }] : []),
				...calls.map((call) => ({
					type: "toolCall" as const,
					id: call.id,
					name: "ipython",
					arguments: { code: call.code },
				})),
			],
			calls.length > 0 ? "toolUse" : "stop",
		);
		this.flow.assistantStart(message);
		const component = new QuietAssistantMessage(this.current?.state, undefined, false, undefined, "Thinking", {
			quiet: true,
		});
		giveLane(component, this.flow.subagentLane.tracker.lane);
		this.chat.addChild(component);
		component.updateContent(message, false);
		this.streamed(message);
		if (options.open) {
			for (const call of calls) {
				this.flow.toolStart(call.id, "ipython", { code: call.code });
				// The kernel's records so far (a running command already has its label).
				if (call.details !== undefined) {
					this.flow.toolUpdate(call.id, "ipython", { code: call.code }, { details: call.details });
				}
			}
			return;
		}
		this.flow.assistantEnd(message);
		for (const call of calls) {
			this.flow.toolStart(call.id, "ipython", { code: call.code });
			if (call.endsAt !== undefined) this.clock = call.endsAt;
			this.flow.toolEnd(
				call.id,
				"ipython",
				{ details: call.details ?? {}, content: [{ type: "text", text: call.text ?? "ok" }] },
				call.isError === true,
			);
		}
	}

	/** A subagent's message reaches the parent while its run goes on: its row lands in the chat. */
	report(message: AgentSessionMessage): void {
		if (!this.flow.customMessage(message)) this.addMessageRow(message);
	}

	/** A subagent's notice reaches the parent while its run goes on: the flow takes it, else it is a row of the chat. */
	notice(message: CustomMessage): void {
		if (this.flow.customMessage(message)) return;
		const row = subagentNoticeRow(message, this.flow.subagentLane);
		if (row && !this.flow.placeRow(row, message.timestamp)) this.chat.addChild(row);
	}

	/** A child's snapshot, as the daemon reports it. */
	child(snapshot: AgentConnectionRlmChildAgentSnapshot): void {
		this.flow.subagentUpdate(snapshot);
	}

	summaries(): TurnSummaryComponent[] {
		return this.chat.children.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);
	}

	lines(width = 100): string[] {
		return this.chat.children.flatMap((child) => child.render(width));
	}
}
