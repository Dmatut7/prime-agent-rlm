/**
 * Terminal-outcome classification for a finished RLM child run.
 *
 * A child killed by the stall watchdog used to surface to its parent as
 * "completed without sending a reply", reporting a killing as a no-reply. The
 * classification is a pure function of recorded facts so the whole table can be
 * pinned by unit tests without a session, and so the ordering rule that matters
 * most - a stall kill outranks "it replied" - cannot drift silently.
 */

export type RlmChildRunStatus = "queued" | "running" | "done" | "error" | "cancelled";

/** Failure kinds: delivered unconditionally through the failure channel. */
export type RlmChildFailureKind = "stall_killed" | "aborted" | "error";

/** Notice kinds: synthesized terminal notices, still gated by their own rules. */
export type RlmChildNoticeKind = "cancelled" | "completed_without_reply";

export type RlmChildTerminalKind = RlmChildFailureKind | RlmChildNoticeKind;

/**
 * Where the outcome has to go: `failure` is the unconditional failure channel
 * (rlm_child_failure), `notice` the synthesized terminal notice, `none` means the
 * parent already knows and nothing may be synthesized.
 */
export type RlmChildTerminalChannel = "failure" | "notice" | "none";

export interface RlmChildStallAbortFacts {
	silentMs: number;
	thresholdMs: number;
	/** Names of the tools still in flight when the watchdog aborted the turn. */
	inFlightTools: readonly string[];
	/** Kernel liveness reasons recorded with the abort, once the kernel reports them. */
	kernelReasons?: readonly string[];
	/**
	 * False once the watchdog reported `abort_unsettled`: the abort fired but the
	 * run never produced `agent_end`, so "killed" is not yet a fact.
	 */
	settled: boolean;
}

export type RlmChildTurnAbortReason = "user" | "stall_watchdog";

export interface RlmChildTerminalFacts {
	runStatus: RlmChildRunStatus;
	/** stopReason of the last assistant message in the child transcript, if any. */
	lastStopReason?: string;
	lastErrorMessage?: string;
	/** Error recorded on the run itself (cancellation reason, thrown message). */
	runError?: string;
	stallAbort?: RlmChildStallAbortFacts;
	turnAbortReason?: RlmChildTurnAbortReason;
	repliedDuringRun: boolean;
	/** The child already sent its own terminal-error notice to the parent. */
	terminalErrorNoticeDelivered: boolean;
}

export type RlmChildTerminalOutcome =
	| { kind: "none"; channel: "none"; reason: string }
	| {
			kind: RlmChildNoticeKind;
			channel: "notice";
			reason: string;
			/**
			 * Set when the facts could not decide the outcome and the classifier fell
			 * back to the legacy "completed without reply" notice. Callers must log
			 * it: a silent fallback is how a kill goes back to being reported as a
			 * no-reply.
			 */
			degraded?: "indeterminate_facts";
	  }
	| { kind: RlmChildFailureKind; channel: "failure"; reason: string };

const DEFAULT_ABORTED_REASON = "turn aborted before completion";
const DEFAULT_ERROR_REASON = "Assistant turn failed";
const COMPLETED_WITHOUT_REPLY_REASON = "completed without sending a reply";

/** Diagnostic facts a caller may pass straight from a stall event. */
export interface RlmChildStallDiagnosticsInput {
	silentMs: number;
	inFlightToolCalls: readonly { toolName: string; elapsedMs: number }[];
	/** Kernel liveness segment, present only once the kernel heartbeat lands. */
	kernel?: { reasons?: readonly string[] };
}

/**
 * Kernel liveness reasons carried by a stall event. Reads through a structural
 * type so the kernel segment is picked up as soon as the watchdog reports it,
 * without this module depending on that field existing yet.
 */
export function readStallKernelReasons(diagnostics: RlmChildStallDiagnosticsInput): string[] {
	return [...(diagnostics.kernel?.reasons ?? [])];
}

export function formatStallKilledReason(
	stall: Pick<RlmChildStallAbortFacts, "silentMs" | "inFlightTools" | "kernelReasons">,
	diagnostics?: RlmChildStallDiagnosticsInput,
): string {
	const silentSeconds = Math.max(1, Math.round(stall.silentMs / 1000));
	const parts = [`killed by the stall watchdog after ${silentSeconds}s of silence (silentMs=${stall.silentMs})`];
	const inFlight = diagnostics?.inFlightToolCalls ?? [];
	if (inFlight.length > 0) {
		const tools = inFlight
			.map((call) => `${call.toolName} (${Math.max(1, Math.round(call.elapsedMs / 1000))}s)`)
			.join(", ");
		parts.push(`in-flight tools: ${tools}`);
	} else if (stall.inFlightTools.length > 0) {
		parts.push(`in-flight tools: ${stall.inFlightTools.join(", ")}`);
	} else {
		parts.push("in-flight tools: none recorded");
	}
	const kernelReasons = stall.kernelReasons ?? diagnostics?.kernel?.reasons ?? [];
	if (kernelReasons.length > 0) parts.push(`kernel: ${kernelReasons.join("; ")}`);
	parts.push("work in the aborted turn was lost; re-dispatch the task or change the approach");
	return parts.join("; ");
}

function legacyTwoStateOutcome(facts: RlmChildTerminalFacts): RlmChildTerminalOutcome {
	const failed = facts.runStatus === "error" || facts.lastStopReason === "error";
	if (failed) {
		return facts.terminalErrorNoticeDelivered
			? { kind: "none", channel: "none", reason: "terminal error notice already delivered" }
			: {
					kind: "error",
					channel: "failure",
					reason: facts.runError ?? facts.lastErrorMessage ?? DEFAULT_ERROR_REASON,
				};
	}
	return { kind: "completed_without_reply", channel: "notice", reason: COMPLETED_WITHOUT_REPLY_REASON };
}

/**
 * Classify one terminal run. Ordering is load-bearing:
 *
 * 1. `cancelled` - an explicit cancel keeps the existing notice (still gated by
 *    the caller's suppressTerminalNotice, so a parent that aborted itself is not
 *    woken by its own kill).
 * 2. `stall_killed` - before `repliedDuringRun` on purpose: "it replied" is not
 *    evidence it was not killed, and a reply used to swallow the kill.
 * 3. `aborted` - a user Esc or an aborted stop reason.
 * 4. `error` - provider/model failure.
 * 5. replied => nothing to synthesize.
 * 6. otherwise the legacy `completed_without_reply` notice.
 *
 * F7: an abort that never settled is not a kill once the run recovered and
 * replied; that combination reports `none` so a survivor is not reported dead.
 * `terminalErrorNoticeDelivered` downgrades a failure to `none` because the child
 * already told the parent through agent_message - the parent must see one failure,
 * not two.
 */
export function classifyRlmChildTerminalOutcome(facts: RlmChildTerminalFacts): RlmChildTerminalOutcome {
	if (facts.runStatus === "cancelled") {
		return { kind: "cancelled", channel: "notice", reason: facts.runError ?? "cancelled" };
	}
	const stallAbort = facts.stallAbort;
	if (stallAbort || facts.turnAbortReason === "stall_watchdog") {
		if (stallAbort && !stallAbort.settled && facts.repliedDuringRun) {
			return { kind: "none", channel: "none", reason: "stall_survived" };
		}
		if (facts.terminalErrorNoticeDelivered) {
			return { kind: "none", channel: "none", reason: "terminal error notice already delivered" };
		}
		return {
			kind: "stall_killed",
			channel: "failure",
			reason: stallAbort ? formatStallKilledReason(stallAbort) : DEFAULT_ABORTED_REASON,
		};
	}
	if (facts.turnAbortReason === "user" || facts.lastStopReason === "aborted") {
		if (facts.terminalErrorNoticeDelivered) {
			return { kind: "none", channel: "none", reason: "terminal error notice already delivered" };
		}
		return {
			kind: "aborted",
			channel: "failure",
			reason: facts.runError ?? facts.lastErrorMessage ?? DEFAULT_ABORTED_REASON,
		};
	}
	if (facts.runStatus === "error" || facts.lastStopReason === "error") {
		if (facts.terminalErrorNoticeDelivered) {
			return { kind: "none", channel: "none", reason: "terminal error notice already delivered" };
		}
		return {
			kind: "error",
			channel: "failure",
			reason: facts.runError ?? facts.lastErrorMessage ?? DEFAULT_ERROR_REASON,
		};
	}
	if (facts.repliedDuringRun) {
		return { kind: "none", channel: "none", reason: "replied during the run" };
	}
	if (facts.runStatus !== "done") {
		// No terminal facts (the run never reached a terminal status): fall back to
		// the legacy notice and mark it degraded so the caller logs the gap.
		return {
			kind: "completed_without_reply",
			channel: "notice",
			reason: COMPLETED_WITHOUT_REPLY_REASON,
			degraded: "indeterminate_facts",
		};
	}
	return { kind: "completed_without_reply", channel: "notice", reason: COMPLETED_WITHOUT_REPLY_REASON };
}

/**
 * Classification that cannot throw into the run's terminal path: on an
 * unexpected error it reports the problem through `onDegraded` (callers log it)
 * and falls back to the legacy two-state outcome.
 */
export function classifyRlmChildTerminalOutcomeSafely(
	facts: RlmChildTerminalFacts,
	onDegraded: (detail: { reason: "classifier_error" | "indeterminate_facts"; error?: string }) => void,
): RlmChildTerminalOutcome {
	let outcome: RlmChildTerminalOutcome;
	try {
		outcome = classifyRlmChildTerminalOutcome(facts);
	} catch (error) {
		onDegraded({
			reason: "classifier_error",
			error: error instanceof Error ? error.message : String(error),
		});
		return legacyTwoStateOutcome(facts);
	}
	if (outcome.channel === "notice" && outcome.degraded) onDegraded({ reason: outcome.degraded });
	return outcome;
}
