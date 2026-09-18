import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, RlmQuiescenceOutcome } from "../core/agent-session.js";
import {
	type AgentAutonomousStatus,
	autonomousLimitReason,
	buildAutonomousGateFailureContinuation,
} from "../core/autonomous.js";
import {
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CompactionOutcomeMessage,
	HARNESS_DIGEST_CUSTOM_TYPE,
	isCompactionOutcomeMessage,
	isSessionSlashCommandResultMessage,
	REFINEMENT_NOTICE_CUSTOM_TYPE,
	REFINEMENT_OUTCOME_CUSTOM_TYPE,
	type SessionSlashCommandResultMessage,
} from "../core/messages.js";

export function latestAutonomousGateAttempt(status: AgentAutonomousStatus): number {
	return Math.max(status.lastGateFailure?.attempt ?? 0, 0, ...Object.values(status.gateAttempts));
}

export type HeadlessTerminalResultMessage = AssistantMessage | SessionSlashCommandResultMessage;

export interface HeadlessTerminalResult {
	primary?: HeadlessTerminalResultMessage;
	compactionOutcomes: CompactionOutcomeMessage[];
}

export function selectHeadlessTerminalResult(messages: readonly AgentMessage[]): HeadlessTerminalResult {
	let index = messages.length - 1;
	const compactionOutcomes: CompactionOutcomeMessage[] = [];
	while (index >= 0) {
		const message = messages[index];
		if (isCompactionOutcomeMessage(message)) {
			compactionOutcomes.unshift(message);
			index--;
			continue;
		}
		// A corrupt outcome is still part of the terminal outcome suffix. Skip it
		// without letting it hide earlier valid outcomes or their failure status.
		// The boundary-injected harness digest is skipped for the same reason: a
		// resume appends it at the tail, and it is never the saved final output.
		// The refinement-notice vocabulary is skipped as defense in depth: this
		// fork has no producer for it, but a journal written by an upstream build
		// could carry one, and a notice is never the saved final output either.
		if (
			message.role === "custom" &&
			(message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE ||
				message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE ||
				message.customType === HARNESS_DIGEST_CUSTOM_TYPE ||
				message.customType === REFINEMENT_NOTICE_CUSTOM_TYPE)
		) {
			index--;
			continue;
		}
		break;
	}
	const precedingMessage = messages[index];
	const primary =
		precedingMessage?.role === "assistant" || isSessionSlashCommandResultMessage(precedingMessage)
			? precedingMessage
			: undefined;
	return { primary, compactionOutcomes };
}

function shouldContinueAutonomousGates(status: AgentAutonomousStatus): boolean {
	return (
		status.enabled &&
		status.gates.commands.length > 0 &&
		!!status.lastGateFailure &&
		latestAutonomousGateAttempt(status) <= status.gates.maxRetries &&
		!autonomousLimitReason(status)
	);
}

function autonomousProgressKey(status: AgentAutonomousStatus): string {
	return [
		latestAutonomousGateAttempt(status),
		status.continuationsUsed,
		status.turnsUsed,
		status.tokensUsed,
		status.lastGateFailure?.exitText ?? "",
	].join(":");
}

export interface HeadlessCompletionOptions {
	/** Include descendant settlement and the parent turns caused by their results. */
	waitForRlmQuiescence?: boolean;
	/**
	 * Checked before each autonomous gate continuation prompt. The headless
	 * completion wait is a read-only daemon command, but gate continuations
	 * prompt the session; a caller in the middle of an update-restart handoff
	 * returns true here to stop the mutating part and finish with the current
	 * status instead of racing the checkpoint.
	 */
	shouldStopGateContinuations?: () => boolean;
}

/**
 * The autonomous status of a headless run plus the RLM quiescence barrier's
 * final outcome. `rlmQuiescence` is present only when the caller asked for the
 * barrier; `settled: false` with `timedOut: true` means descendants were still
 * running when the wait gave up on its deadline, so the run is not a clean
 * completion and callers must not treat it as one.
 */
export interface HeadlessCompletionResult extends AgentAutonomousStatus {
	/** Outcome of the last RLM quiescence barrier wait in this run. */
	rlmQuiescence?: RlmQuiescenceOutcome;
}

export async function waitForHeadlessCompletion(
	session: AgentSession,
	options: HeadlessCompletionOptions = {},
): Promise<HeadlessCompletionResult> {
	let lastPromptedProgressKey: string | undefined;
	let repeatedProgressPrompts = 0;
	// K3Q-1: the barrier's give-up outcome must travel with the result. The
	// caller (print mode, ACP) has to be able to tell "everything settled" apart
	// from "descendants were still running when the wait gave up" - the outcome
	// used to be discarded here, so a 5-minute deadline completed the run as if
	// nothing was left behind.
	let rlmQuiescence: RlmQuiescenceOutcome | undefined;
	const withQuiescence = (status: AgentAutonomousStatus): HeadlessCompletionResult =>
		rlmQuiescence === undefined ? status : { ...status, rlmQuiescence };
	while (true) {
		if (options.waitForRlmQuiescence) rlmQuiescence = await session.waitForRlmQuiescence();
		else await session.waitForHeadlessIdle();
		const status = session.getAutonomousStatus();
		if (!shouldContinueAutonomousGates(status) || !status.lastGateFailure) {
			return withQuiescence(status);
		}
		// Gate continuations are the only mutating step of this wait. A handoff in
		// progress must not be raced by fresh prompts; finish with the current
		// status (the run reports the still-failing gate) instead.
		if (options.shouldStopGateContinuations?.()) {
			return withQuiescence(status);
		}
		const progressKey = autonomousProgressKey(status);
		if (progressKey === lastPromptedProgressKey) {
			repeatedProgressPrompts++;
		} else {
			repeatedProgressPrompts = 0;
			lastPromptedProgressKey = progressKey;
		}
		if (repeatedProgressPrompts > 0) {
			await new Promise((resolve) => setTimeout(resolve, Math.min(1000, repeatedProgressPrompts * 50)));
		}
		session.recordHostAutonomousContinuation();
		await session.prompt(
			buildAutonomousGateFailureContinuation(
				{ ...status.lastGateFailure, attempt: latestAutonomousGateAttempt(status) },
				status.gates.maxRetries,
			),
			{
				streamingBehavior: "followUp",
				internalPrompt: true,
				suppressAutonomousContinuation: true,
			},
		);
		await session.waitForIdle();
		await session.refreshAutonomousGates();
		const { primary } = selectHeadlessTerminalResult(session.state.messages);
		if (primary?.role === "assistant") {
			if (primary.stopReason === "error" || primary.stopReason === "aborted") {
				const postErrorStatus = session.getAutonomousStatus();
				if (shouldContinueAutonomousGates(postErrorStatus) && postErrorStatus.lastGateFailure) {
					continue;
				}
				if (options.waitForRlmQuiescence) continue;
				return withQuiescence(postErrorStatus);
			}
		}
	}
}
