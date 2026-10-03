/**
 * RLM child terminal-outcome cluster extracted from agent-session.ts: recording a
 * child's stall-watchdog stage on the parent side, collecting the facts the
 * terminal classifier reads, and delivering exactly the notice the classification
 * asks for. The classifier itself stays a pure function in rlm-child-terminal.ts;
 * this module is the session-touching half around it. The moved methods keep
 * exactly the same bodies; they read the session through
 * {@link RlmChildTerminalOutcomeHost}, which `AgentSession` satisfies structurally,
 * so the move changes no runtime behavior.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, getLogger } from "@earendil-works/pi-ai";
import type { QueuedParentReplyBackfills } from "./agent-messages.js";
import type { AgentSession } from "./agent-session.js";
import type { DutyEvent } from "./duty-log.js";
import {
	boundRlmChildLastText,
	type CustomMessage,
	createRlmChildFailureMessage,
	createRlmChildTerminalNoticeMessage,
} from "./messages.js";
import type { RlmChildRun } from "./rlm-child-run.js";
import { classifyRlmChildTerminalOutcomeSafely, type RlmChildTerminalFacts } from "./rlm-child-terminal.js";
import type { StallDiagnostics } from "./stall-diagnostics.js";

// Same logger name as agent-session.ts: the terminal-outcome delivery moved here
// verbatim and its log lines keep the namespace they have always emitted under.
const sessionLog = getLogger("coding-agent.agent-session");

/**
 * The seam of `AgentSession` the extracted terminal-outcome delivery reads and
 * mutates. Member names mirror the class's own members so the extraction stays a
 * textual `this.` -> `host.` rename; `AgentSession._deliverRlmChildTerminalOutcome`
 * delegates with `this`, and `_recordRlmChildStallEvent` forwards to the host-free
 * recorder below.
 */
export interface RlmChildTerminalOutcomeHost {
	readonly sessionId: string;
	readonly _queuedChildReplyBackfills: QueuedParentReplyBackfills;
	_findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined;
	_recordDutyEvent(event: DutyEvent): void;
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
export function recordRlmChildStallEvent(
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
function collectRlmChildTerminalFacts(
	host: RlmChildTerminalOutcomeHost,
	run: RlmChildRun,
	child: AgentSession | undefined,
	parentReplyCountBeforeRun: number,
): RlmChildTerminalFacts {
	const lastAssistant = child ? host._findLastAssistantInMessages(child.messages) : undefined;
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
export async function deliverRlmChildTerminalOutcome(
	host: RlmChildTerminalOutcomeHost,
	input: {
		run: RlmChildRun;
		child: AgentSession | undefined;
		sessionName: string;
		parentReplyCountBeforeRun: number;
		deliver: (message: CustomMessage) => Promise<void>;
	},
): Promise<void> {
	const { run, child, sessionName, parentReplyCountBeforeRun, deliver } = input;
	if (run.detachedDeletion || run.suppressTerminalNotice) return;
	const facts = collectRlmChildTerminalFacts(host, run, child, parentReplyCountBeforeRun);
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
		const owedReplyIds = host._queuedChildReplyBackfills.owedMessageIdsForSender(child.sessionId);
		if (owedReplyIds.length > 0) {
			run.provisionalNoReplyReplyIds = owedReplyIds;
			sessionLog.info("no-reply verdict is provisional on a queued reply", {
				sessionId: host.sessionId,
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
				sessionId: host.sessionId,
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
			lastAssistantText: lastAssistantText ? boundRlmChildLastText(lastAssistantText) : undefined,
		}),
	);
	// The parent gets the child's last answer without waiting for a reply that never came.
	host._recordDutyEvent({ kind: "child_auto_delivered", child: sessionName });
}
