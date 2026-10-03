/**
 * RLM child follow-up watch cluster extracted from agent-session.ts: the per
 * retained-child watch that notices a parent-started follow-up turn (an
 * agent_message.send to a finished child) ending without a reply, and delivers
 * the terminal notice the parent otherwise never gets. The moved methods keep
 * exactly the same bodies; they read the session through
 * {@link RlmChildFollowUpHost}, which `AgentSession` satisfies structurally, so
 * the move changes no runtime behavior.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getLogger } from "@earendil-works/pi-ai";
import type { QueuedParentReplyBackfills } from "./agent-messages.js";
import type { AgentSession, AgentSessionEvent } from "./agent-session.js";
import {
	boundRlmChildLastText,
	type CustomMessage,
	createRlmChildFailureMessage,
	createRlmChildTerminalNoticeMessage,
} from "./messages.js";
import {
	noopRlmChildEventUnsubscribe,
	type RlmChildRun,
	type RlmChildSnapshotHost,
	rlmChildSnapshotForSession,
} from "./rlm-child-run.js";
import { createDefaultRlmSubagentSessionName } from "./rlm-runtime.js";

// Same logger name as agent-session.ts: the follow-up watch moved here verbatim
// and its log lines keep the namespace they have always emitted under.
const sessionLog = getLogger("coding-agent.agent-session");

/**
 * How long a follow-up check keeps re-polling a child that is busy without a turn
 * (compacting, running bash). A new turn ends in its own agent_end, which re-arms
 * the check, so only turn-less work needs the poll.
 */
const RLM_FOLLOW_UP_CHECK_POLL_MS = 2_000;
const RLM_FOLLOW_UP_CHECK_MAX_POLLS = 900;

export interface RlmChildFollowUpWatch {
	session: AgentSession;
	unsubscribe: () => void;
	/** `_parentFollowUpCount` of the child when this watch last reported (or started). */
	reportedFollowUpCount: number;
	timer?: ReturnType<typeof setTimeout>;
	polls: number;
}

/**
 * The seam of `AgentSession` the extracted follow-up watch reads and mutates.
 * Member names mirror the class's own members so the extraction stays a textual
 * `this.` -> `host.` rename; `AgentSession._watchRlmChildFollowUps`,
 * `_stopRlmChildFollowUpWatch` and `_stopAllRlmChildFollowUpWatches` delegate
 * with `this`.
 */
export interface RlmChildFollowUpHost extends RlmChildSnapshotHost {
	readonly _rlmChildFollowUpWatches: Map<string, RlmChildFollowUpWatch>;
	readonly _activeRlmChildRuns: Map<string, RlmChildRun>;
	readonly _queuedChildReplyBackfills: QueuedParentReplyBackfills;
	readonly _disposed: boolean;
	readonly _disposing: boolean;
	readonly sessionId: string;
	_isRlmChildHiddenFromCollect(childId: string, run?: RlmChildRun): boolean;
	_emit(event: AgentSessionEvent): void;
	_findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined;
	_deferRlmTerminalNotice(message: CustomMessage): Promise<void>;
}

/**
 * Watch a retained child for follow-up turns this session started (an
 * agent_message.send to a finished child) that end without a reply. The first
 * task has its own terminal notice; a follow-up had nothing, so a parent that
 * sent one and ended its turn to wait was never woken - and an unattended parent
 * waited for days. A runless child (rehydrated after it was closed) also gets its
 * roster row refreshed here, since no run subscription reports its turns.
 */
export function watchRlmChildFollowUps(host: RlmChildFollowUpHost, childId: string, child: AgentSession): void {
	if (host._rlmChildFollowUpWatches.get(childId)?.session === child) return;
	stopRlmChildFollowUpWatch(host, childId);
	const watch: RlmChildFollowUpWatch = {
		session: child,
		unsubscribe: noopRlmChildEventUnsubscribe,
		reportedFollowUpCount: child._parentFollowUpCount,
		polls: 0,
	};
	watch.unsubscribe = child.subscribe((event) => {
		if (event.type !== "agent_start" && event.type !== "agent_end") return;
		if (host._rlmChildFollowUpWatches.get(childId) !== watch) return;
		if (!host._rlmChildSessions.get(childId)?.run && !host._isRlmChildHiddenFromCollect(childId)) {
			host._emit({ type: "rlm_child_update", child: rlmChildSnapshotForSession(host, childId, child) });
		}
		if (event.type === "agent_start") {
			clearRlmChildFollowUpTimer(watch);
			watch.polls = 0;
			return;
		}
		// After the listeners of this agent_end ran: the session is only idle then.
		armRlmChildFollowUpCheck(host, childId, watch, 0);
	});
	host._rlmChildFollowUpWatches.set(childId, watch);
}

export function stopRlmChildFollowUpWatch(host: RlmChildFollowUpHost, childId: string): void {
	const watch = host._rlmChildFollowUpWatches.get(childId);
	if (!watch) return;
	host._rlmChildFollowUpWatches.delete(childId);
	clearRlmChildFollowUpTimer(watch);
	watch.unsubscribe();
}

export function stopAllRlmChildFollowUpWatches(host: RlmChildFollowUpHost): void {
	for (const childId of [...host._rlmChildFollowUpWatches.keys()]) stopRlmChildFollowUpWatch(host, childId);
}

function clearRlmChildFollowUpTimer(watch: RlmChildFollowUpWatch): void {
	if (watch.timer === undefined) return;
	clearTimeout(watch.timer);
	watch.timer = undefined;
}

function armRlmChildFollowUpCheck(
	host: RlmChildFollowUpHost,
	childId: string,
	watch: RlmChildFollowUpWatch,
	delayMs: number,
): void {
	clearRlmChildFollowUpTimer(watch);
	const timer = setTimeout(() => {
		watch.timer = undefined;
		checkRlmChildFollowUpReply(host, childId, watch);
	}, delayMs);
	timer.unref?.();
	watch.timer = timer;
}

/**
 * Decide, once the child is idle, whether the follow-up it last received went
 * unanswered. Every "not yet" here is either a turn still to come (whose own
 * agent_end re-arms the check) or a reply that already exists; only a child that
 * is quiet, owes nothing further, and never answered is reported.
 */
function checkRlmChildFollowUpReply(host: RlmChildFollowUpHost, childId: string, watch: RlmChildFollowUpWatch): void {
	if (host._disposed || host._disposing || host._rlmChildFollowUpWatches.get(childId) !== watch) return;
	const child = watch.session;
	if (host._rlmChildSessions.get(childId)?.session !== child || host._isRlmChildHiddenFromCollect(childId)) return;
	const run = host._activeRlmChildRuns.get(childId);
	if (run && !run.settled) return;
	const followUps = child._parentFollowUpCount;
	if (followUps <= watch.reportedFollowUpCount) return;
	if (child._repliedToParentSinceTask !== false) {
		watch.reportedFollowUpCount = followUps;
		return;
	}
	// Another turn is coming: queued input, or descendants whose results will wake it.
	if (child.isStreaming || child.unfinishedActionCount > 0 || child._hasUnsettledRlmQuiescenceWork()) return;
	if (child.isSessionActive) {
		// Busy without a turn (compaction, bash): no agent_end will re-arm the check.
		if (watch.polls < RLM_FOLLOW_UP_CHECK_MAX_POLLS) {
			watch.polls += 1;
			armRlmChildFollowUpCheck(host, childId, watch, RLM_FOLLOW_UP_CHECK_POLL_MS);
		}
		return;
	}
	watch.reportedFollowUpCount = followUps;
	// A reply that sits in this session's own queue is a reply, just not read yet.
	if (host._queuedChildReplyBackfills.owedMessageIdsForSender(child.sessionId).length > 0) return;
	void deliverRlmChildFollowUpOutcome(host, childId, child).catch(() => undefined);
}

async function deliverRlmChildFollowUpOutcome(
	host: RlmChildFollowUpHost,
	childId: string,
	child: AgentSession,
): Promise<void> {
	const sessionName = child.sessionName ?? createDefaultRlmSubagentSessionName("", childId);
	const lastAssistant = host._findLastAssistantInMessages(child.messages);
	// Cleared by the next agent_start, so it describes the turn that just ended.
	const abortReason = child._lastTurnAbortReason;
	let message: CustomMessage;
	if (abortReason === "user" || (abortReason === undefined && lastAssistant?.stopReason === "aborted")) {
		message = createRlmChildTerminalNoticeMessage({
			kind: "cancelled",
			childId,
			sessionName,
			reason: "the user stopped its follow-up turn before it replied",
			followUp: true,
		});
	} else if (abortReason !== undefined) {
		message = createRlmChildFailureMessage({
			childId,
			sessionName,
			error: `its follow-up turn was aborted (${abortReason}) before it replied`,
			kind: abortReason === "stall_watchdog" ? "stall_killed" : "aborted",
			followUp: true,
		});
	} else if (lastAssistant?.stopReason === "error") {
		message = createRlmChildFailureMessage({
			childId,
			sessionName,
			error: lastAssistant.errorMessage?.trim() || "its follow-up turn ended in a model or provider error",
			kind: "error",
			followUp: true,
		});
	} else {
		const lastAssistantText = child.getLastAssistantText();
		message = createRlmChildTerminalNoticeMessage({
			kind: "completed_without_reply",
			childId,
			sessionName,
			lastAssistantText: lastAssistantText ? boundRlmChildLastText(lastAssistantText) : undefined,
			followUp: true,
		});
	}
	sessionLog.info("rlm child follow-up ended without a reply; notifying parent", {
		sessionId: host.sessionId,
		childId,
		childSessionId: child.sessionId,
		stopReason: lastAssistant?.stopReason,
	});
	await host._deferRlmTerminalNotice(message);
}
