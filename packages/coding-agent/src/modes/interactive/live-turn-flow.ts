import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { Container } from "@earendil-works/pi-tui";
import type { CustomMessage } from "../../core/messages.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../agent-connection/types.js";
import { SubagentLane } from "./components/agent-message.js";
import {
	assignWakeCause,
	countThinkingSegments,
	giveLaneTracker,
	isWakeMessage,
	latestThinkingText,
	NO_STEP_STOP,
	noteWakeInRound,
	resolveTurnHeaders,
	type StepResultStop,
	stepResultStop,
	WakeCause,
} from "./components/conversation-components.js";
import { formatFileChangePath, getToolFileChanges } from "./components/edit-summary.js";
import { collectBashHandleCommands } from "./components/step-label.js";
import { isSubagentNoticeMessage } from "./components/system-notice.js";
import { TurnActivityState, TurnSummaryComponent } from "./components/turn-activity.js";
import { TurnStripComponent } from "./components/turn-strip.js";
import {
	boxRecordFromMessage,
	compactionMissText,
	describeRetryReason,
	isBoxNoticeMessage,
	replyHasWork,
} from "./components/turn-timeline.js";
import { UserMessageComponent } from "./components/user-message.js";

/**
 * How live session events become the quiet conversation's turn boxes: one box
 * per prompt, a message typed between steps as a row in it, a retry or a
 * compaction continuing the same box, the settle before the finished face, and
 * the change strip under the answer. Display only: nothing here reaches the model.
 *
 * The interactive mode owns the chat and the live turn slot; the flow reads and
 * replaces them through its host.
 */
export interface LiveTurnFlowHost {
	/** The chat the boxes live in. */
	chat(): Container;
	/** The quiet conversation (boxes) is on. */
	quiet(): boolean;
	isStreaming(): boolean;
	/** The session still waits to retry (its retry counter is up). */
	retryPending(): boolean;
	/** The session is compacting right now. */
	compacting(): boolean;
	/** Context tokens right now, when known. */
	contextTokens(): number | undefined;
	cwd(): string;
	/** The session's own node id: its direct children get subagent rows. */
	rlmNodeId(): string | undefined;
	/** A new turn head, wired for clicks and the settings. */
	createSummary(state: TurnActivityState): TurnSummaryComponent;
	/** When the live run's clock started, when known. */
	runStartedAt(): number | undefined;
	/** A new live turn starts with its process lane open (the legacy global Ctrl+O). */
	startExpanded(): boolean;
	currentState(): TurnActivityState | undefined;
	currentSummary(): TurnSummaryComponent | undefined;
	setCurrent(summary: TurnSummaryComponent | undefined): void;
	/** Earlier answers of the turn fold into its box once a later reply starts. */
	foldEarlierAnswers(summary: TurnSummaryComponent): void;
	requestRender(): void;
	/** Whether a live box exists changed (spinners and clocks need the pulse). */
	liveChanged(): void;
	/** What the session has spent, when it is known: the request's closing row words it. */
	subagentSpend?(): RequestSpend | undefined;
}

/** The session's spend as the closing row of a request words it. */
export interface RequestSpend {
	/** Every subagent's own cost. */
	cost: number;
	/** The root's own cost; the total is `parentCost + cost`. */
	parentCost: number;
	/** A scan budget cut the count short: the figures are lower bounds. */
	partial?: boolean;
}

/** Files a settled step changed land on its turn, so the collapsed process line can list them. */
export function recordStepFileChanges(
	state: TurnActivityState | undefined,
	toolCallId: string,
	result: { details?: unknown; isError: boolean },
	cwd: string,
): void {
	const step = state?.steps.find((candidate) => candidate.toolCallId === toolCallId);
	if (!state || !step) return;
	state.addFileChanges(
		getToolFileChanges(step.toolName, step.args, result, cwd).map((change) => ({
			...change,
			path: formatFileChangePath(change.path, cwd),
		})),
	);
}

const FINISH_SETTLE_MS = 400;

export class LiveTurnFlow {
	/** Each settling box has its own finish timer: a rebuild can settle several at once. */
	private readonly finishTimers = new Map<TurnActivityState, ReturnType<typeof setTimeout>>();
	/** How the live run's latest assistant message ended: a user message after a tool call is an interjection. */
	private lastStop: AssistantMessage["stopReason"] | undefined;
	/**
	 * The previous run stopped right after a step to take a message typed meanwhile
	 * (the queue's 做完手上这一步就看): that message is an interjection in the same box.
	 */
	private runCutMidTask = false;
	/** The owner interrupted the running turn (Escape): its box ends as stopped. */
	private userStopped = false;
	/** How the run's latest step result says it went on: a stop from another view leaves only its stub. */
	private stepStop: StepResultStop = NO_STEP_STOP;
	/** Turns whose run ended on a stop's stub: they finish as stopped if nothing carries them on. */
	private readonly stubStopped = new WeakSet<TurnActivityState>();
	/** The open reply already folded its turn's earlier answers into the box. */
	private openReplyFolded = false;
	/** The assistant message that started and has not ended yet, in the turn that shows it. */
	private openMessage: { state: TurnActivityState; message: AssistantMessage } | undefined;
	/** The box the lost connection finished early: what it said, undone when the session comes back. */
	private lostBox: { state: TurnActivityState; noticeKey: string; steps: string[] } | undefined;
	/** A run-starting message (a prompt) arrived since the last agent_start; otherwise the run continues a turn. */
	private starterSinceRunStart = false;
	/** Who opened the run in progress: the user's prompt, or a message that woke the agent (none: it went on by itself). */
	private starterKind: "user" | "wake" | undefined;
	/** A compaction row still waiting for the context size it ended with (the next reply's usage). */
	private compactionAwaitingAfter: string | undefined;
	private lastFinishedState: TurnActivityState | undefined;
	private readonly strips = new WeakMap<TurnSummaryComponent, TurnStripComponent>();
	/** Handle variable → the command its `bash()` call started, across the session's cells. */
	private readonly handleCommands = new Map<string, string>();
	/** Which subagents of the current question are still out: the lane every timeline row is drawn in. */
	readonly subagentLane = new SubagentLane();
	/** What woke the run in progress; the turn it opens takes it. */
	private pendingCause: WakeCause | undefined;

	constructor(private readonly host: LiveTurnFlowHost) {}

	/** The newest turn that finished in this view (the status bar's done/stopped face). */
	get lastFinished(): TurnActivityState | undefined {
		return this.lastFinishedState;
	}

	/** Whether a turn box is live right now (its spinners and clocks need frames). */
	hasLiveBox(): boolean {
		const state = this.host.currentState();
		return state !== undefined && state.boxMode && state.boxLive;
	}

	/** The run's turn head, created once before its first block. */
	ensureCurrent(): TurnActivityState {
		const existing = this.host.currentSummary();
		if (existing) return existing.state;
		const state = new TurnActivityState(this.host.runStartedAt() ?? Date.now());
		state.live = true;
		state.startedByUser = this.starterKind === "user";
		if (this.pendingCause) assignWakeCause(state, this.pendingCause);
		this.pendingCause = undefined;
		const summary = this.host.createSummary(state);
		giveLaneTracker(summary, this.subagentLane.tracker);
		summary.setExpanded(this.host.startExpanded());
		summary.setQuiet(this.host.quiet());
		this.host.setCurrent(summary);
		this.host.chat().addChild(summary);
		resolveTurnHeaders(this.host.chat().children);
		return state;
	}

	agentStart(): void {
		// The quiet conversation groups by prompt: a run without a prompt of its
		// own (a retry, a compaction's continuation) goes on in the same box,
		// exactly as a replay of the transcript groups it.
		this.starterSinceRunStart = false;
		this.starterKind = undefined;
		this.pendingCause = undefined;
		const state = this.host.currentState();
		this.runCutMidTask =
			this.host.quiet() &&
			(this.lastStop ?? this.replayedStop(state)) === "toolUse" &&
			state?.boxMode === true &&
			!state.timeline.stopped;
		this.lastStop = undefined;
		this.userStopped = false;
		if (!this.host.quiet()) this.host.setCurrent(undefined);
	}

	/**
	 * A custom message arrived. One that wakes the AI outside a tool loop (a
	 * heartbeat, an agent message or a subagent notice while idle) starts a new
	 * turn, so the answer the last turn ended on stays where it is; a compaction
	 * notice the box shows as a row goes there. True when the box took the message.
	 */
	customMessage(message: CustomMessage): boolean {
		if (!this.host.quiet()) return false;
		if (isWakeMessage(message) && this.lastStop !== "toolUse" && !this.runCutMidTask) {
			this.starterSinceRunStart = true;
			this.starterKind = "wake";
			this.pendingCause ??= new WakeCause();
			this.pendingCause.add(message);
			this.endLiveTurnForNewRun();
			return false;
		}
		// Inside the tool loop the message joins the round that is running.
		if (isWakeMessage(message)) noteWakeInRound(this.host.currentState(), message);
		// A subagent notice is a row of the timeline the chat draws, never one of the box's.
		if (isSubagentNoticeMessage(message)) return false;
		if (!isBoxNoticeMessage(message)) return false;
		const turn = this.continuableTurn();
		if (!turn?.state.boxMode) return false;
		const record = boxRecordFromMessage(message);
		if (record?.kind !== "compaction") return false;
		const timeline = turn.state.timeline;
		const at = Number(message.timestamp) || Date.now();
		if (timeline.latestCompaction()?.endedAt === undefined) {
			// A skipped or failed compaction the live row has not settled yet.
			timeline.addReplayCompaction(at, record.facts);
		}
		this.host.requestRender();
		return true;
	}

	/** A user message arrived: an interjection in the running turn's box, or a new prompt. */
	userMessage(text: string, timestamp: number): "interjection" | "prompt" {
		const quiet = this.host.quiet();
		const state = this.host.currentState();
		const summary = this.host.currentSummary();
		const lastStop = this.lastStop ?? (state?.isTurnEnded ? undefined : this.replayedStop(state));
		const steered = lastStop === "toolUse" || this.runCutMidTask;
		if (quiet && steered && state?.boxMode) {
			// A run that stopped to take this message goes on in the same box.
			if (state.isTurnEnded && summary) this.resumeTurn(summary);
			state.timeline.addSteer(text.trim() || "[图片]", timestamp || Date.now());
			this.host.requestRender();
			return "interjection";
		}
		this.starterSinceRunStart = true;
		this.starterKind = "user";
		this.pendingCause = undefined;
		if (quiet) this.endLiveTurnForNewRun();
		// A new question: nobody is out yet.
		this.subagentLane.reset();
		return "prompt";
	}

	/**
	 * How the live turn's last reply ended, for a view that attached while a step
	 * ran: it never saw that reply end, the replayed turn says it.
	 */
	private replayedStop(state: TurnActivityState | undefined): AssistantMessage["stopReason"] | undefined {
		if (!state?.live) return undefined;
		const entries = state.timeline.entries;
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry?.kind === "message") return entry.message.stopReason;
		}
		return undefined;
	}

	assistantStart(message: AssistantMessage): void {
		this.runCutMidTask = false;
		this.stepStop = NO_STEP_STOP;
		this.openReplyFolded = false;
		if (this.host.quiet()) {
			// No prompt since the run started: this run continues a turn that
			// already ended (a retry, the work after a compaction).
			const current = this.host.currentSummary();
			if (current?.state.isTurnEnded) {
				this.resumeTurn(current);
			} else if (!current && !this.starterSinceRunStart) {
				const turn = this.continuableTurn();
				if (turn) this.resumeTurn(turn);
			}
		}
		const state = this.ensureCurrent();
		this.dropOpenMessage(message);
		state.timeline.noteMessage(message, false);
		this.openMessage = { state, message };
		state.setLiveThinkingSegments(countThinkingSegments(message));
		// The header names the model; until the first token arrives the box says it waits.
		state.modelId = message.model || state.modelId;
		state.notePhase("waiting");
		// The title depends on the model, which is only known now.
		resolveTurnHeaders(this.host.chat().children);
	}

	assistantUpdate(message: AssistantMessage, event: AssistantMessageEvent): void {
		const state = this.host.currentState();
		if (!state) return;
		state.setLiveThinkingSegments(countThinkingSegments(message));
		const kind = event.type;
		if (kind === "thinking_start" || kind === "thinking_delta") {
			state.noteThinking(true);
			state.notePhase("thinking");
		} else if (kind === "text_start" || kind === "text_delta") {
			if (kind === "text_start") state.noteThinking(false);
			state.notePhase("writing");
		} else if (kind === "toolcall_start" || kind === "toolcall_delta") {
			if (kind === "toolcall_start") state.noteThinking(false);
			state.notePhase("waiting");
		} else {
			if (kind === "thinking_end") state.noteThinking(false);
			state.noteActivity();
		}
		const thinking = latestThinkingText(message);
		state.latestThinking = thinking || state.latestThinking;
		state.currentThinking = thinking;
		state.timeline.noteMessage(message, false);
		state.timeline.noteStreamEvent(message, event);
		for (const content of message.content) {
			if (content.type === "toolCall") this.noteToolCall(content, false);
		}
		// A later reply of the same turn moves the earlier answer into the box, once
		// it has something to show (a text block starts empty; its words follow).
		if (!this.openReplyFolded && replyHasWork(message)) {
			this.openReplyFolded = true;
			const summary = this.host.currentSummary();
			if (summary?.state.boxMode) this.host.foldEarlierAnswers(summary);
		}
	}

	/** One tool call of the live message: a step of its turn (added once, its arguments kept current). */
	noteToolCall(call: { id: string; name: string; arguments: unknown }, started: boolean): void {
		const state = this.ensureCurrent();
		if (state.steps.some((step) => step.toolCallId === call.id)) {
			state.updateStepArgs(call.id, call.arguments);
			return;
		}
		state.addStep({
			toolCallId: call.id,
			toolName: call.name,
			args: call.arguments,
			status: started ? "running" : "queued",
		});
	}

	assistantEnd(message: AssistantMessage): void {
		this.lastStop = message.stopReason;
		this.openMessage = undefined;
		const state = this.host.currentState();
		if (state) {
			// The landed message's thinking blocks settle into the turn count.
			state.addThinkingSegments(countThinkingSegments(message));
			state.setLiveThinkingSegments(0);
			state.noteThinking(false);
			state.notePhase("waiting");
			const timeline = state.timeline;
			timeline.noteMessage(message, true);
			// The box says how the run ended: stopped by the owner, or on an error
			// no retry recovers (a retry reopens the turn and clears this).
			if (message.stopReason === "aborted") timeline.stopped = true;
			if (message.stopReason === "error") timeline.errorEnded = true;
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				// A message that dies mid-turn leaves its steps running forever; settle
				// them as the replay does, and stamp the turn's clock.
				const endedAt = Number(message.timestamp) || Date.now();
				for (const step of state.steps) {
					if (step.status === "queued" || step.status === "running") {
						state.setStepStatus(step.toolCallId, "error", endedAt);
					}
				}
				state.markTurnEnded(endedAt);
			}
		}
		// The first reply after a compaction measures the context it left.
		const awaiting = this.compactionAwaitingAfter;
		const usage = message.usage;
		const contextTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite + usage.output : 0;
		if (awaiting && contextTokens > 0) {
			this.compactionAwaitingAfter = undefined;
			this.setCompactionAfter(awaiting, contextTokens);
		}
	}

	toolStart(toolCallId: string, toolName: string, args: unknown): void {
		// The start event carries the complete arguments; streaming may have left partial ones.
		this.noteToolCall({ id: toolCallId, name: toolName, arguments: args }, true);
		const state = this.host.currentState();
		state?.updateStepArgs(toolCallId, args);
		state?.markRunning(toolCallId);
		if (this.host.quiet()) this.noteStepHandles(state, toolCallId, args);
	}

	/** Partial results carry the steps, files and memories so far: the box shows them as they happen. */
	toolUpdate(
		toolCallId: string,
		toolName: string,
		args: unknown,
		partialResult: { details?: unknown; content?: unknown },
		owner?: TurnActivityState,
	): void {
		this.host.currentState()?.noteActivity();
		(owner ?? this.stepOwner(toolCallId))?.timeline.mergeStep(
			toolCallId,
			toolName,
			args,
			{ ...partialResult, isError: false },
			true,
		);
	}

	/** A step settled, in the turn that shows it (a step replayed from history belongs to its own turn). */
	toolEnd(
		toolCallId: string,
		toolName: string,
		result: { details?: unknown; content?: unknown },
		isError: boolean,
		owner?: TurnActivityState,
	): void {
		const state = owner ?? this.stepOwner(toolCallId);
		if (!state) return;
		this.stepStop = stepResultStop({ ...result, isError });
		state.timeline.mergeStep(
			toolCallId,
			toolName,
			state.steps.find((step) => step.toolCallId === toolCallId)?.args,
			{ ...result, isError },
			false,
		);
		if (!state.steps.some((step) => step.toolCallId === toolCallId)) return;
		state.setStepStatus(toolCallId, isError ? "error" : "done");
		recordStepFileChanges(state, toolCallId, { details: result.details, isError }, this.host.cwd());
	}

	agentEnd(): void {
		this.openMessage = undefined;
		const state = this.host.currentState();
		// The run is over; a thinking-only turn's clock stops here.
		state?.markTurnEnded(Date.now());
		// Interrupted by the owner mid-step: the box says it stopped.
		if (this.userStopped && state?.boxMode) state.timeline.stopped = true;
		// A stop from another view leaves only its stub: stopped, unless a message carries the turn on.
		else if (this.stepStop.endsTurn && state?.boxMode) this.stubStopped.add(state);
		this.userStopped = false;
		this.stepStop = NO_STEP_STOP;
		// The box shows its finished face after a short settle: a retry or a
		// compaction's continuation may still carry the same turn on.
		if (state?.boxMode) this.scheduleFinish(state);
	}

	/** Escape while the run works or waits to retry. */
	interrupt(): void {
		this.userStopped = true;
	}

	/**
	 * The connection to the background session is gone: no more events will
	 * come for the live turn, so its box finishes now and says why. A reconnect
	 * rebuilds the chat from the session as it is then.
	 */
	connectionLost(): void {
		this.openMessage = undefined;
		this.userStopped = false;
		const state = this.host.currentState();
		if (!state?.boxMode || state.timeline.finishedAt !== undefined) return;
		const now = Date.now();
		const timeline = state.timeline;
		const cut: string[] = [];
		for (const step of state.steps) {
			if (step.status === "queued" || step.status === "running") {
				cut.push(step.toolCallId);
				timeline.mergeStep(
					step.toolCallId,
					step.toolName,
					step.args,
					{ content: [{ type: "text", text: "连接断了，没收到结果" }], isError: true },
					false,
				);
				state.setStepStatus(step.toolCallId, "error", now);
			}
		}
		timeline.endRetry("failed", "连接断了");
		if (timeline.activeCompaction()) timeline.endCompaction(now, { failed: "连接断了" });
		const noticeKey = timeline.addNotice({ tone: "error", text: "和后台的连接断了，这一轮后面的进展收不到" }, now);
		this.lostBox = { state, noticeKey, steps: cut };
		timeline.errorEnded = true;
		if (!state.isTurnEnded) state.markTurnEnded(now);
		this.finish(state, { force: true });
	}

	/**
	 * The session is back and its chat is about to be rebuilt from what really
	 * happened: the box the lost connection ended early goes back to waiting for
	 * that rebuild (its replayed twin carries on, or finishes, from there).
	 */
	connectionRestored(): void {
		const lost = this.lostBox;
		this.lostBox = undefined;
		if (!lost) return;
		const timeline = lost.state.timeline;
		timeline.dropEntry(lost.noticeKey);
		for (const toolCallId of lost.steps) timeline.stepData.delete(toolCallId);
		timeline.errorEnded = false;
		timeline.finishedAt = undefined;
		if (this.lastFinishedState === lost.state) this.lastFinishedState = undefined;
	}

	/** An automatic compaction is a row in the turn it interrupts; true when a box shows it. */
	compactionStart(reason: string): boolean {
		if (!this.host.quiet() || reason === "manual") return false;
		const turn = this.continuableTurn();
		const tokens = this.host.contextTokens();
		turn?.state.timeline.startCompaction(Date.now(), typeof tokens === "number" ? tokens : undefined);
		return turn !== undefined;
	}

	/** Settle the compaction row a compaction_end belongs to; returns its key for the after-figure. */
	compactionEnd(event: {
		reason: string;
		result?: { tokensBefore: number };
		aborted: boolean;
		errorMessage?: string;
		errorSeverity?: "warning" | "error";
	}): string | undefined {
		if (!this.host.quiet() || event.reason === "manual") return undefined;
		const children = this.host.chat().children;
		for (let index = children.length - 1; index >= 0; index--) {
			const child = children[index];
			if (!(child instanceof TurnSummaryComponent)) continue;
			const timeline = child.state.timeline;
			const active = timeline.activeCompaction();
			if (!active) continue;
			const skipped = !event.aborted && !event.result && event.errorSeverity === "warning";
			const failed = event.aborted ? "已取消" : event.result ? undefined : compactionMissText(event);
			timeline.endCompaction(Date.now(), {
				...(event.result ? { before: event.result.tokensBefore } : {}),
				...(failed ? { failed } : {}),
				...(skipped ? { skipped: true } : {}),
			});
			const state = child.state;
			if (state.isTurnEnded && state.timeline.finishedAt === undefined) this.scheduleFinish(state);
			this.host.requestRender();
			return `compact:${active.startedAt}`;
		}
		return undefined;
	}

	/** After a compaction's rebuild, its row gets the context size it ended with (now, or from the next reply). */
	compactionRebuilt(key: string | undefined): void {
		if (!key) return;
		const tokens = this.host.contextTokens();
		if (typeof tokens === "number" && this.setCompactionAfter(key, tokens)) return;
		this.compactionAwaitingAfter = key;
	}

	/** A retry carries the same turn on: its box reopens with a countdown row. True when a box shows it. */
	retryStart(event: {
		delayMs: number;
		attempt: number;
		errorMessage: string;
		reason?: "usage" | "unavailable" | "backup";
		backupModel?: string;
	}): boolean {
		if (!this.host.quiet()) return false;
		const turn = this.continuableTurn();
		if (!turn) return false;
		const state = this.resumeTurn(turn);
		state.timeline.startRetry({
			startedAt: Date.now(),
			delayMs: event.delayMs,
			attempt: event.attempt,
			reason: describeRetryReason(event),
		});
		return true;
	}

	retryEnd(event: { success: boolean; finalError?: string }): void {
		// The live turn, else the box whose retry row still waits (a rebuild replaced the live one).
		let state = this.host.currentState();
		if (!state?.timeline.activeRetry()) {
			const children = this.host.chat().children;
			for (let index = children.length - 1; index >= 0; index--) {
				const child = children[index];
				if (child instanceof TurnSummaryComponent && child.state.timeline.activeRetry()) {
					state = child.state;
					break;
				}
			}
		}
		const ownerStop = !event.success && this.userStopped;
		if (!event.success) this.userStopped = false;
		if (!state?.boxMode) return;
		const timeline = state.timeline;
		timeline.endRetry(
			event.success ? "ok" : ownerStop ? "stopped" : "failed",
			ownerStop ? undefined : event.finalError,
		);
		if (!event.success) {
			// The owner cancelled the wait: a stop, not an error.
			if (ownerStop) timeline.stopped = true;
			else timeline.errorEnded = true;
			// A retry cancelled in its countdown (or one that never started) has no run to end the turn.
			if (!state.isTurnEnded && !this.host.isStreaming()) state.markTurnEnded(Date.now());
			if (state.isTurnEnded) this.scheduleFinish(state);
		}
	}

	/**
	 * A direct child's snapshot becomes a row in the turn that started it: the
	 * live turn for a child first seen now, else whichever turn already has it.
	 */
	subagentUpdate(child: AgentConnectionRlmChildAgentSnapshot): void {
		if (!this.host.quiet() || child.parentId !== this.host.rlmNodeId() || child.status === "cancelled") return;
		let timeline: TurnActivityState["timeline"] | undefined;
		for (const component of this.host.chat().children) {
			if (component instanceof TurnSummaryComponent && component.state.timeline.hasSubagent(child.id)) {
				timeline = component.state.timeline;
			}
		}
		const live = this.host.currentState();
		if (!timeline && live?.boxMode && live.boxLive && (child.status === "running" || child.status === "queued")) {
			timeline = live.timeline;
		}
		if (!timeline) return;
		const firstLine = (text: string | undefined) =>
			text
				?.split("\n")
				.map((line) => line.trim())
				.find((line) => line.length > 0);
		const running = child.status === "running" || child.status === "queued";
		const activity = child.activity;
		const line =
			activity?.kind === "executing"
				? activity.toolName
					? `在执行 ${activity.toolName}`
					: "在执行"
				: activity?.kind === "writing"
					? "在写回答"
					: activity?.kind === "waiting"
						? "在等模型"
						: activity?.kind === "stalled"
							? "没有动静"
							: (firstLine(child.recap) ?? "刚派出去…");
		timeline.upsertSubagent({
			childId: child.id,
			name: child.sessionName ?? child.label,
			status: running ? "running" : child.status === "error" ? "failed" : "done",
			line,
			...(child.status === "error"
				? { result: firstLine(child.error) ?? "出错" }
				: firstLine(child.answerPreview)
					? { result: firstLine(child.answerPreview) }
					: {}),
			...(child.answerPreview || child.recap ? { report: child.answerPreview ?? child.recap } : {}),
		});
		this.host.requestRender();
	}

	/** Remember the commands a step starts under a handle, and resolve the ones it waits on. */
	noteStepHandles(state: TurnActivityState | undefined, toolCallId: string, args: unknown): void {
		const code =
			typeof (args as { code?: unknown } | undefined)?.code === "string" ? (args as { code: string }).code : "";
		if (!code) return;
		if (state) {
			const referenced = new Map<string, string>();
			for (const match of code.matchAll(
				/\bawait\s+([A-Za-z_][A-Za-z0-9_]*)|\b([A-Za-z_][A-Za-z0-9_]*)\.(?:poll|tail|output)\(/g,
			)) {
				const name = match[1] ?? match[2];
				const command = name ? this.handleCommands.get(name) : undefined;
				if (name && command) referenced.set(name, command);
			}
			if (referenced.size > 0) state.timeline.stepHandleContext.set(toolCallId, referenced);
		}
		for (const [name, command] of collectBashHandleCommands(code)) this.handleCommands.set(name, command);
	}

	/** A replay starts over: the handles are re-learned from its cells. */
	forgetHandles(): void {
		this.handleCommands.clear();
	}

	/** The change strip of a turn, when it has one. */
	stripFor(summary: TurnSummaryComponent): TurnStripComponent | undefined {
		return this.strips.get(summary);
	}

	/** The strip goes at the chat's end, which is where the finished turn's answer is. */
	attachStrip(summary: TurnSummaryComponent): void {
		let strip = this.strips.get(summary);
		if (!strip) {
			strip = new TurnStripComponent(this.stripSource(summary));
			this.strips.set(summary, strip);
		}
		const chat = this.host.chat();
		chat.removeChild(strip);
		chat.addChild(strip);
	}

	/**
	 * What a turn's strip reads: its facts, and for the request's closing row how
	 * long the request took, what it cost, and whether this turn is the last round
	 * that answered it (a round a later message wakes hands the row on).
	 */
	private stripSource(summary: TurnSummaryComponent) {
		const state = summary.state;
		return {
			timeline: state.timeline,
			facts: () => (state.boxLive ? undefined : state.boxView().facts),
			requestRender: () => this.host.requestRender(),
			elapsedMs: () => this.requestElapsedMs(summary),
			spend: () => this.host.subagentSpend?.(),
			endsRequest: () => this.lastTurn() === summary,
		};
	}

	/** From the request's first round to the end of this one: a woken round counts its earlier rounds in. */
	private requestElapsedMs(summary: TurnSummaryComponent): number {
		const children = this.host.chat().children;
		let first = summary;
		for (let index = children.indexOf(summary) - 1; index >= 0; index--) {
			const child = children[index];
			if (child instanceof UserMessageComponent) break;
			if (child instanceof TurnSummaryComponent) first = child;
		}
		const end = summary.state.startedAt + summary.state.turnDurationMs();
		return Math.max(0, end - first.state.startedAt);
	}

	private lastTurn(): TurnSummaryComponent | undefined {
		const children = this.host.chat().children;
		for (let index = children.length - 1; index >= 0; index--) {
			const child = children[index];
			if (child instanceof TurnSummaryComponent) return child;
		}
		return undefined;
	}

	/** Every quiet turn's box in the chat, keyed by each of its messages, to carry over a rebuild. */
	captureBoxes(): Map<string, TurnSummaryComponent> {
		const boxes = new Map<string, TurnSummaryComponent>();
		for (const child of this.host.chat().children) {
			if (!(child instanceof TurnSummaryComponent)) continue;
			for (const entry of child.state.timeline.entries) {
				if (entry.kind === "message" && !boxes.has(entry.key)) boxes.set(entry.key, child);
			}
		}
		return boxes;
	}

	/**
	 * Carry each box's live-only facts and open rows over to its replayed twin
	 * (the box that replays any of its messages). `keepHistory` (a rebuild after
	 * a compaction) keeps the part the compaction summarized away.
	 */
	carryOver(boxes: Map<string, TurnSummaryComponent>, options: { keepHistory?: boolean } = {}): void {
		if (boxes.size === 0) return;
		const keepHistory = options.keepHistory === true;
		for (const child of this.host.chat().children) {
			if (!(child instanceof TurnSummaryComponent)) continue;
			const carried = child.state.timeline.entries
				.map((entry) => (entry.kind === "message" ? boxes.get(entry.key) : undefined))
				.find((box) => box !== undefined);
			if (!carried || carried === child) continue;
			this.cancelFinish(carried.state);
			carried.state.timeline.transferTo(child.state.timeline, { keepHistory });
			if (keepHistory) child.state.adoptHistory(carried.state);
			// A box that was still settling when the chat was rebuilt finishes here
			// (the one a run still streams into waits for that run's end).
			const timeline = child.state.timeline;
			if (timeline.observedLive && timeline.finishedAt === undefined) this.scheduleFinish(child.state);
		}
	}

	/**
	 * The run ended: after a short settle (a retry or a compaction can still
	 * continue the same turn) the box shows its finished face and the change
	 * strip lands under the answer.
	 */
	scheduleFinish(state: TurnActivityState, delayMs = FINISH_SETTLE_MS): void {
		this.cancelFinish(state);
		const timer = setTimeout(() => {
			this.finishTimers.delete(state);
			this.finish(state);
		}, delayMs);
		timer.unref?.();
		this.finishTimers.set(state, timer);
	}

	/** A new session: every box of the previous chat is gone. */
	reset(): void {
		this.dispose();
		this.lastFinishedState = undefined;
		this.lastStop = undefined;
		this.runCutMidTask = false;
		this.userStopped = false;
		this.openMessage = undefined;
		this.lostBox = undefined;
		this.starterSinceRunStart = false;
		this.starterKind = undefined;
		this.pendingCause = undefined;
		this.compactionAwaitingAfter = undefined;
		this.handleCommands.clear();
		this.subagentLane.reset();
	}

	/** Teardown: no finish timer may fire into a stopped screen. */
	dispose(): void {
		for (const timer of this.finishTimers.values()) clearTimeout(timer);
		this.finishTimers.clear();
	}

	private cancelFinish(state: TurnActivityState): void {
		const timer = this.finishTimers.get(state);
		if (timer) clearTimeout(timer);
		this.finishTimers.delete(state);
	}

	private finish(state: TurnActivityState, options: { force?: boolean } = {}): void {
		this.cancelFinish(state);
		if (!state.boxMode || state.timeline.finishedAt !== undefined) return;
		// A box a rebuild replaced (or the chat trimmed away) is gone: nothing to finish.
		const summary = this.summaryForState(state);
		if (!summary) return;
		if (!options.force) {
			// Reopened by a continuation: its own agent_end schedules the finish again.
			if (!state.isTurnEnded) return;
			const timeline = state.timeline;
			// A retry or a compaction whose end this view missed (a rebuild, a reconnect) is over.
			if (timeline.activeRetry() && !this.host.retryPending() && !this.host.isStreaming()) {
				timeline.endRetry(timeline.errorEnded ? "failed" : "ok");
			}
			if (timeline.activeCompaction() && !this.host.compacting()) timeline.endCompaction(Date.now(), {});
			const continuing = this.host.isStreaming() && this.host.currentState() === state;
			if (continuing || timeline.activeRetry() || timeline.activeCompaction()) {
				// A continuation is starting, a retry waits or a compaction runs: look again later.
				this.scheduleFinish(state);
				return;
			}
		}
		if (!state.isTurnEnded) state.markTurnEnded(Date.now());
		if (this.stubStopped.has(state)) state.timeline.stopped = true;
		this.stubStopped.delete(state);
		state.finishBox();
		this.lastFinishedState = state;
		this.attachStrip(summary);
		this.host.liveChanged();
		this.host.requestRender();
	}

	/**
	 * A new attempt started while the previous one never ended: the session
	 * dropped it (an empty-turn retry), so its row and never-run steps go.
	 */
	private dropOpenMessage(next: AssistantMessage): void {
		const open = this.openMessage;
		this.openMessage = undefined;
		if (!open || open.message.timestamp === next.timestamp) return;
		const key = `m:${open.message.timestamp}`;
		const entry = open.state.timeline.entries.find((candidate) => candidate.key === key);
		const latest = entry?.kind === "message" ? entry.message : open.message;
		open.state.timeline.dropEntry(key);
		const calls = new Set<string>();
		for (const content of latest.content) {
			if (content.type === "toolCall") calls.add(content.id);
		}
		if (calls.size > 0) open.state.dropQueuedSteps(calls);
	}

	/** A new prompt starts a new turn: the live one finishes now. */
	private endLiveTurnForNewRun(): void {
		const state = this.host.currentState();
		if (state?.boxMode) this.finish(state, { force: true });
		// A box a rebuild left settling (it lost its place as the live turn) finishes too.
		for (const child of this.host.chat().children) {
			if (!(child instanceof TurnSummaryComponent)) continue;
			const timeline = child.state.timeline;
			if (child.state.boxMode && timeline.observedLive && timeline.finishedAt === undefined) {
				this.finish(child.state, { force: true });
			}
		}
		this.host.setCurrent(undefined);
	}

	/** Make `summary` the live turn again (a continuation after it ended). */
	private resumeTurn(summary: TurnSummaryComponent): TurnActivityState {
		const state = summary.state;
		this.cancelFinish(state);
		this.stubStopped.delete(state);
		if (state.isTurnEnded) state.reopen();
		state.live = true;
		const strip = this.strips.get(summary);
		if (strip) this.host.chat().removeChild(strip);
		this.host.setCurrent(summary);
		this.host.liveChanged();
		return state;
	}

	/**
	 * The turn a run without a prompt of its own continues (a retry, or the
	 * continuation after a compaction): the live turn, else the newest turn in
	 * the chat when no user message came after it.
	 */
	private continuableTurn(): TurnSummaryComponent | undefined {
		const children = this.host.chat().children;
		const current = this.host.currentSummary();
		if (current && children.includes(current)) return current;
		for (let index = children.length - 1; index >= 0; index--) {
			const child = children[index];
			if (child instanceof UserMessageComponent) return undefined;
			if (child instanceof TurnSummaryComponent) return child;
		}
		return undefined;
	}

	/** The turn that shows a step: the live one when it has it, else the box in the chat that does. */
	private stepOwner(toolCallId: string): TurnActivityState | undefined {
		const current = this.host.currentState();
		if (!current || current.steps.some((step) => step.toolCallId === toolCallId)) return current;
		for (const child of this.host.chat().children) {
			if (
				child instanceof TurnSummaryComponent &&
				child.state.steps.some((step) => step.toolCallId === toolCallId)
			) {
				return child.state;
			}
		}
		return current;
	}

	private summaryForState(state: TurnActivityState): TurnSummaryComponent | undefined {
		for (const child of this.host.chat().children) {
			if (child instanceof TurnSummaryComponent && child.state === state) return child;
		}
		return undefined;
	}

	private setCompactionAfter(key: string, tokens: number): boolean {
		for (const child of this.host.chat().children) {
			if (!(child instanceof TurnSummaryComponent)) continue;
			const entry = child.state.timeline.entries.find((candidate) => candidate.key === key);
			if (entry?.kind === "compact") {
				entry.compaction.after = tokens;
				child.state.timeline.ui.bump();
				this.host.requestRender();
				return true;
			}
		}
		return false;
	}
}
