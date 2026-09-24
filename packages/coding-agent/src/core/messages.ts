/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentCronJob } from "./cron-jobs.js";
import { PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE } from "./provider-fallback.js";
import {
	type AppliedRefinementEdit,
	formatRefinementNoticeBody,
	type HarnessScope,
	type RefinementResult,
} from "./refinement/refinement.js";
import type { RlmChildFailureKind } from "./rlm-child-terminal.js";
import { isSessionSlashCommandName, parseSessionSlashCommand, type SessionSlashCommand } from "./slash-commands.js";

export type { RlmChildFailureKind };

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary. Compaction is lossy: this summary may be incomplete, and content the compacted history carried can be missing from it. Treat the machine-generated blocks it carries (file lists, fact appendix, user requests), the persisted session state and other persistent records as authoritative for exact constraints and values, and re-check anything load-bearing that only this summary's narrative states.
The retained messages below are authoritative; this summary may lag behind them.

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `[branch-summary]

The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export const HEARTBEAT_PROMPT_CUSTOM_TYPE = "heartbeat_prompt";
export const HEARTBEAT_PROMPT_PREVIEW_LABEL = "Heartbeat prompt";
export const IPYTHON_STATE_RESTORED_CUSTOM_TYPE = "ipython_state_restored";
export const PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE = "python_skills_unavailable";
export const SESSION_SLASH_COMMAND_CUSTOM_TYPE = "session_slash_command";
export const SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE = "session_slash_command_result";
export const COMPACTION_OUTCOME_CUSTOM_TYPE = "compaction_outcome";
export const MCP_CONNECTION_OUTCOME_CUSTOM_TYPE = "mcp_connection_outcome";
export const REFINEMENT_OUTCOME_CUSTOM_TYPE = "refinement_outcome";
export const REFINEMENT_NOTICE_CUSTOM_TYPE = "refinement_notice";
export const HARNESS_DIGEST_CUSTOM_TYPE = "harness_digest";
export const RLM_CHILD_FAILURE_CUSTOM_TYPE = "rlm_child_failure";
export const RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE = "rlm_child_terminal_notice";
export const ASYNC_BASH_COMPLETION_CUSTOM_TYPE = "async_bash_completion";
/**
 * One-shot recovery continuation the session queues after the empty-response retry
 * ladder is exhausted: the failure shape goes back to the model itself, so the task
 * gets a turn to be recovered instead of ending in a silent stop.
 */
export const EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE = "empty_response_recovery";
/** Self-recovery continue: the session nudges itself after an announced-but-undone step or a missing child reply. */
export const AUTO_CONTINUE_CUSTOM_TYPE = "auto_continue";
export const ASYNC_BASH_COMPLETION_PREVIEW_LABEL = "Background command finished";

export const THINKING_LEVEL_CLAMPED_CUSTOM_TYPE = "thinking_level_clamped";
export const IMAGE_DELIVERY_SUSPICION_CUSTOM_TYPE = "image_delivery_suspicion";

/**
 * Framing for a refinement outcome that is rendered back into the model's
 * context. Custom messages reach the provider as user-role messages, so the text
 * has to say out loud that it is an automatic receipt and not a user instruction.
 */
export const REFINEMENT_OUTCOME_PREFIX = `Continual harness refinement result (automatic system receipt from the refinement subsystem, not a message from the user and not a new instruction: keep working on your current task and treat this only as a record of what the refinement did or refused to do).`;
export const RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE = "rlm_child_stall_notice";
/**
 * System interruption the stall-recovery executor queues into a wedged session
 * (r4 recovery-shell): the turn is killed and this message becomes the next
 * turn's only input, so the model learns what happened and changes approach
 * instead of ending in a silent stop.
 */
export const SYSTEM_INTERRUPTION_CUSTOM_TYPE = "system_interruption";
/**
 * Parent-facing receipt for an automatic stall-recovery action on a child
 * (r4 recovery-shell): who acted, why, what was done, and the one-line
 * re-dispatch command the parent can paste if it prefers a fresh worker. Never
 * sent by the child itself and never implying the parent asked for anything.
 */
export const RLM_CHILD_RECOVERY_ACTION_CUSTOM_TYPE = "rlm_child_recovery_action";

/**
 * Names and other metadata interpolated into a `[<kind> ...]` header line must not
 * carry the characters that delimit the header itself (brackets, newlines, commas,
 * or the relationship separator ":").
 */
export function sanitizeMessageHeaderValue(value: string): string {
	return value.replace(/[\s,:[\]]+/g, " ").trim();
}

export interface SessionSlashCommandDetails {
	command: SessionSlashCommand;
	commandEntryId?: string;
}

export interface SessionSlashCommandResultDetails {
	command: SessionSlashCommand;
	success: boolean;
	severity: "info" | "warning" | "error";
	error?: string;
	commandEntryId?: string;
}

export interface SessionSlashCommandMessage extends CustomMessage<SessionSlashCommandDetails> {
	customType: typeof SESSION_SLASH_COMMAND_CUSTOM_TYPE;
	content: string;
	details: SessionSlashCommandDetails;
}

export interface SessionSlashCommandResultMessage extends CustomMessage<SessionSlashCommandResultDetails> {
	customType: typeof SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE;
	content: string;
	details: SessionSlashCommandResultDetails;
}

export type CompactionOutcomeReason = "threshold" | "overflow" | "requested";
export type CompactionOutcome = "skipped" | "cancelled" | "failed";

export interface CompactionOutcomeDetails {
	reason: CompactionOutcomeReason;
	outcome: CompactionOutcome;
}

export interface CompactionOutcomeMessage extends CustomMessage<CompactionOutcomeDetails> {
	customType: typeof COMPACTION_OUTCOME_CUSTOM_TYPE;
	content: string;
	details: CompactionOutcomeDetails;
}

/**
 * Level-one (suspicion, not confirmed) image-delivery receipt: the committed
 * turn batch carried images, the response completed cleanly on an
 * OpenAI-completions API, and the usage frame had no image token count. The
 * measured defect behind it: a provider whose catalog entry claims image input
 * can serve 2xx and silently drop the images. Some vision-capable providers
 * never report image token counts (stepfun), so the receipt stays worded as a
 * suspicion and never changes configuration on its own.
 */
export interface ImageDeliverySuspicionDetails {
	/** Model that served the request, as the assistant message recorded it. */
	model: string;
	/** Provider of the serving model. */
	provider: string;
	/** Stop reason of the completed response that carried the usage. */
	stopReason: string;
	/** What was observed, spelled so it can be re-verified against the usage frame. */
	evidence: "usage.prompt_tokens_details.image_tokens absent";
	/** ISO timestamp of the observation. */
	measuredAt: string;
}

export interface ImageDeliverySuspicionMessage extends CustomMessage<ImageDeliverySuspicionDetails> {
	customType: typeof IMAGE_DELIVERY_SUSPICION_CUSTOM_TYPE;
	content: string;
	details: ImageDeliverySuspicionDetails;
}

export function createImageDeliverySuspicionMessage(
	observed: Pick<ImageDeliverySuspicionDetails, "model" | "provider" | "stopReason">,
	timestamp = Date.now(),
): ImageDeliverySuspicionMessage {
	return {
		role: "custom",
		customType: IMAGE_DELIVERY_SUSPICION_CUSTOM_TYPE,
		content: [
			"[Image delivery suspicion] Automatic session notice, not a message from the user: the request for this turn carried image content, but the response usage reported no image token count, so the model may not have received the images. Treat any claim to have seen them accordingly.",
			"Suspicion only, never a confirmed failure: some vision-capable providers do not report image token counts, so a missing count alone proves nothing. No settings were changed. If the answers ignore the images, verify with a question that is answerable only from the image.",
		].join("\n\n"),
		display: true,
		details: {
			model: observed.model,
			provider: observed.provider,
			stopReason: observed.stopReason,
			evidence: "usage.prompt_tokens_details.image_tokens absent",
			measuredAt: new Date(timestamp).toISOString(),
		},
		timestamp,
	};
}

export interface RefinementOutcomeDetails {
	refinementId: string;
	summary: string;
	scope: HarnessScope;
	rollbackOf?: string;
	edits: AppliedRefinementEdit[];
	/**
	 * Present when the refinement did not complete (parse/length/provider/persist
	 * failure): the receipt is the model-visible failure record. Nothing was
	 * persisted, so `edits` is empty and `error` carries the reason.
	 */
	failed?: true;
	/** Short failure reason; model-visible alongside `failed`. */
	error?: string;
}

export interface RefinementOutcomeMessage extends CustomMessage<RefinementOutcomeDetails> {
	customType: typeof REFINEMENT_OUTCOME_CUSTOM_TYPE;
	content: string;
	details: RefinementOutcomeDetails;
}

/** How a refinement was initiated: reviewer-triggered auto-refine, the /refine slash command, or the model's own refine.run(). */
export type RefinementSource = "auto" | "user" | "self";

export interface RefinementNoticeDetails extends RefinementOutcomeDetails {
	source: RefinementSource;
}

export interface RefinementNoticeMessage extends CustomMessage<RefinementNoticeDetails> {
	customType: typeof REFINEMENT_NOTICE_CUSTOM_TYPE;
	content: string;
	details: RefinementNoticeDetails;
}

/**
 * The compact continual-harness menu (`formatHarnessStateForPrompt`) carried as
 * context instead of system-prompt text, so a refinement that rewrites harness
 * state no longer invalidates the provider's cached prompt prefix. `digest` is
 * kept verbatim next to `content` so resume-time dedupe can compare identity
 * without re-parsing the framed text.
 */
export interface HarnessDigestDetails {
	digest: string;
	/** Fingerprint of the harness state at delivery time; cold boundaries skip re-delivery when it still matches. */
	stateFingerprint?: string;
}

/**
 * Framing for the harness digest delivered in-context at a cold boundary. Custom
 * messages reach the provider as user-role messages, so the text has to say out
 * loud that it is mechanical context and not a user instruction (the same rule
 * REFINEMENT_OUTCOME_PREFIX follows).
 */
export const HARNESS_DIGEST_PREFIX = `Continual harness state as of this session's cold boundary (automatic system context injected by the harness, not a message from the user and not a new instruction: keep working on your current task and read this only as the current harness menu).

<harness_state>
`;

export const HARNESS_DIGEST_SUFFIX = `
</harness_state>`;

/**
 * Boundary-injected harness digest. `display: false` because the TUI has nothing
 * to render: the model is the only audience.
 */
export function createHarnessDigestMessage(
	digest: string,
	timestamp = Date.now(),
	stateFingerprint?: string,
): CustomMessage<HarnessDigestDetails> {
	return {
		role: "custom",
		customType: HARNESS_DIGEST_CUSTOM_TYPE,
		content: HARNESS_DIGEST_PREFIX + digest + HARNESS_DIGEST_SUFFIX,
		display: false,
		details: { digest, ...(stateFingerprint ? { stateFingerprint } : {}) },
		timestamp,
	};
}

/** How an MCP connection attempt finished: verified handshake, saved but unverified, or unrecorded result. */
export type McpConnectionVerificationState = "connected" | "unverified" | "unsaved";

/** Which flow produced the outcome: a completed login, an inline token paste, or a pending-account retry verification. */
export type McpConnectionOutcomeSource = "login" | "paste" | "retry";

/** Whether the saved connection change is live in the current session. */
export type McpConnectionActivationState = "active" | "inactive";

export interface McpConnectionOutcomeDetails {
	/** Absent on entries written before disconnect outcomes existed; both mean "connect". */
	kind?: "connect";
	/** Display label the outcome line names, e.g. "Linear" or "Acme (acme-2)". */
	label: string;
	source: McpConnectionOutcomeSource;
	verification: McpConnectionVerificationState;
	/** Tools verified by the MCP handshake; present only when verification is "connected". */
	toolCount?: number;
	/** Human-readable reason the handshake did not complete; present only when verification is "unverified". */
	issue?: string;
	/** Probe error category behind `issue` (e.g. "http-unauthorized"), so the renderer can name the fix. */
	issueCategory?: string;
	/** Account connection id when the outcome is account-scoped. */
	connectionId?: string;
	/** True when the login added a new account to a multi-account service. */
	addedAccount?: boolean;
	/** Whether the saved change is live in this session; absent until activation resolves. */
	activation?: McpConnectionActivationState;
}

/**
 * How a disconnect finished. Only outcomes that actually removed the stored
 * credential are representable: a failed or partial removal never gets a
 * durable "Disconnected" entry.
 */
export type McpDisconnectionState = "removed" | "credential-only" | "preserved";

export interface McpDisconnectionOutcomeDetails {
	kind: "disconnect";
	/** Display label the outcome line names, e.g. "Granola" or "account acme-2". */
	label: string;
	removal: McpDisconnectionState;
	/** Account connection id when the outcome is account-scoped. */
	connectionId?: string;
	/** Whether the saved change is live in this session; absent until activation resolves. */
	activation?: McpConnectionActivationState;
}

/** Either side of the MCP connection lifecycle, carried by one durable entry type. */
export type McpOutcomeDetails = McpConnectionOutcomeDetails | McpDisconnectionOutcomeDetails;

/** Connect details predate the disconnect entry, so a missing `kind` means "connect". */
export function isMcpDisconnectionOutcome(details: McpOutcomeDetails): details is McpDisconnectionOutcomeDetails {
	return (details as Partial<McpDisconnectionOutcomeDetails>).kind === "disconnect";
}

export interface McpConnectionOutcomeMessage extends CustomMessage<McpOutcomeDetails> {
	customType: typeof MCP_CONNECTION_OUTCOME_CUSTOM_TYPE;
	content: string;
	details: McpOutcomeDetails;
}

export interface RlmChildFailureDetails {
	childId: string;
	sessionName: string;
	error: string;
	/**
	 * Terminal classification bucket, so "how many children were killed by the
	 * watchdog" is countable instead of inferred from prose. Absent on transcripts
	 * written before classification existed and on non-terminal failure reports.
	 */
	kind?: RlmChildFailureKind;
	/** Watchdog facts behind a `stall_killed` failure. */
	stall?: {
		silentMs: number;
		thresholdMs: number;
		inFlightTools: readonly string[];
		/** The abort fired but the run never settled. */
		unsettled?: boolean;
	};
}

export type RlmChildTerminalNoticeDetails =
	| {
			kind: "cancelled";
			childId: string;
			sessionName: string;
			reason?: string;
	  }
	| {
			kind: "completed_without_reply";
			childId: string;
			sessionName: string;
			/**
			 * The child's last assistant text, quoted from its own transcript. Not a
			 * message it sent: a child that wrote its answer instead of calling
			 * `agent_message.send` produces a preview that reads exactly like the reply
			 * the parent never got, so the notice text has to say where this came from.
			 */
			lastAssistantTextPreview?: string;
	  };

export interface AsyncBashCompletionDetails {
	pid: number;
	command: string;
	exitCode: number;
}

interface AsyncBashCompletionMessage extends CustomMessage<AsyncBashCompletionDetails> {
	customType: typeof ASYNC_BASH_COMPLETION_CUSTOM_TYPE;
	content: string;
}

export function createAsyncBashCompletionMessage(
	details: AsyncBashCompletionDetails,
	timestamp = Date.now(),
): AsyncBashCompletionMessage {
	return {
		role: "custom",
		customType: ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
		content: `[bash-done pid:${details.pid} exit:${details.exitCode}]

Command: ${JSON.stringify(details.command)}`,
		display: true,
		details,
		timestamp,
	};
}

export interface EmptyResponseRecoveryDetails {
	/** Total provider attempts the ladder spent (fast tier + slow tier). */
	attempts: number;
	/** Total wait between attempts, in ms. */
	waitedMs: number;
	/** Slow-tier (escalated) attempts and wait, in ms. */
	escalatedAttempts: number;
	escalatedWaitedMs: number;
	/** Which limit stopped the ladder: attempts, budget, abort, or request_budget. */
	terminatedBy: string;
	/** 1 for the first recovery continuation of this episode; the hard stop is at 2. */
	recoveryGeneration: number;
	/** Episode continuation cap the session configured; the message wording must not
	 * claim "no another one" when the cap allows a second generation. */
	maxContinuations?: number;
	provider?: string;
	model?: string;
	requestBudget?: { used: number; maxRequests?: number };
}

/**
 * The recovery continuation message: facts about the exhausted ladder plus the
 * instructions that make the turn useful (verify state, save progress, continue or
 * report). Written for the model; `display: true` keeps the transcript auditable.
 */
export function createEmptyResponseRecoveryMessage(
	details: EmptyResponseRecoveryDetails,
	timestamp = Date.now(),
): CustomMessage<EmptyResponseRecoveryDetails> {
	const facts = [
		`attempts: ${details.attempts} (slow tier: ${details.escalatedAttempts}, waited ${Math.round(details.waitedMs / 1000)}s)`,
		`stopped by: ${details.terminatedBy}`,
		`recovery generation: ${details.recoveryGeneration}`,
	];
	if (details.requestBudget) {
		facts.push(`request budget: ${details.requestBudget.used}/${details.requestBudget.maxRequests ?? "unbounded"}`);
	}
	if (details.provider && details.model) facts.push(`model: ${details.provider}/${details.model}`);
	return {
		role: "custom",
		customType: EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE,
		content: [
			`[empty-response recovery] The previous request chain returned empty model turns until the retry ladder was exhausted (${facts.join("; ")}).`,
			"The context is intact and the task is still open. This is not a user instruction and not a connection failure: the provider answered with clean but empty turns.",
			"Pick the work back up yourself; nobody else will. The action you meant to take last may or may not have happened, and repeating a half-done edit or commit can do damage, so look at the current state before redoing anything. Save in-progress work to files now, so another failure does not lose it. If the provider keeps answering empty, say in your reply what is blocking you: a silent end reads to the owner as a finished task. A subagent sends its parent one short status line, because the parent cannot see this notice.",
			Number.isFinite(details.maxContinuations) && (details.maxContinuations ?? 1) > details.recoveryGeneration
				? `This is an automatic continuation (generation ${details.recoveryGeneration} of at most ${details.maxContinuations}); a further one may follow only if this turn itself exhausts the ladder.`
				: `This is an automatic one-shot continuation (generation ${details.recoveryGeneration}); the system will not send another for this episode.`,
		].join("\n"),
		display: true,
		details,
		timestamp,
	};
}

/** Details of an automatic continue (see self-recovery.ts). */
export interface AutoContinueMessageDetails {
	reason: "announced_next_step" | "child_reply_missing";
	excerpt?: string;
	ordinal: number;
}

/**
 * The session's own continue after a turn that stopped right after announcing its
 * next step (or a subagent that finished without replying): the model is told plainly
 * what happened and that nobody is waiting to approve it. `display: true` keeps it
 * visible and auditable.
 */
export function createAutoContinueMessage(
	details: AutoContinueMessageDetails,
	timestamp = Date.now(),
): CustomMessage<AutoContinueMessageDetails> {
	const content =
		details.reason === "child_reply_missing"
			? [
					"[auto-continue] You ended your run without sending your result to your parent agent, which is waiting for it. The parent sees only what you send; your final text stays in your own transcript.",
					'If your task calls for an answer, send it now with `await agent_message.send(<your result>, receiver_role="parent")`, then stop. If no answer is needed, reply with one short line saying so.',
				].join("\n")
			: [
					`[auto-continue] Your last reply ended by announcing a next step (${JSON.stringify(details.excerpt ?? "")}) but the turn stopped before doing it. If the owner left this running, a stop here leaves the work half done until they come back.`,
					"Judge what that sentence was. A step you meant to take: take it now. An offer after work that is actually finished: give the final result in a line and stop. A step that needs the owner's approval (irreversible, spending money, or sending anything outside this machine): do not take it, because a continue is not their consent; ask and stop. Blocked, or any other decision only the owner can make: say exactly what and stop.",
					`This is an automatic continue (${details.ordinal} of at most 2 for this request).`,
				].join("\n");
	return {
		role: "custom",
		customType: AUTO_CONTINUE_CUSTOM_TYPE,
		content,
		display: true,
		details,
		timestamp,
	};
}

export function createRlmChildFailureMessage(
	details: RlmChildFailureDetails,
	timestamp = Date.now(),
): CustomMessage<RlmChildFailureDetails> {
	const stall = details.stall;
	const stallSuffix = stall
		? ` [silentMs=${stall.silentMs}, thresholdMs=${stall.thresholdMs}, in-flight tools: ${
				stall.inFlightTools.length > 0 ? stall.inFlightTools.join(", ") : "none recorded"
			}${stall.unsettled ? ", abort did not settle" : ""}]`
		: "";
	return {
		role: "custom",
		customType: RLM_CHILD_FAILURE_CUSTOM_TYPE,
		content: `RLM child ${details.sessionName} (${details.childId}) failed: ${details.error}${stallSuffix}`,
		display: true,
		details,
		timestamp,
	};
}

/**
 * Facts behind a parent-facing "this child is still silent" notice. The notice is
 * informational: it exists so a long silence reaches the parent as a signal, and
 * the parent - not the watchdog - decides whether the work is genuine or wedged.
 */
export interface RlmChildStallNoticeDetails {
	childId: string;
	sessionName: string;
	/** Milliseconds without any observed activity when the notice fired. */
	silentMs: number;
	/** Silence threshold that fired the notice (the watchdog's warn stage). */
	thresholdMs: number;
	/** Tools still in flight, each as `name` or `name (Ns)`; empty when none were recorded. */
	inFlightTools: readonly string[];
	/**
	 * Reasons the watchdog's own evidence says externally owned work is in flight
	 * (a live bash handle, a kernel loop awaiting the cell). Empty when the silence
	 * has no evidence behind it, which is the case a parent most needs to look at.
	 */
	workEvidence?: readonly string[];
	/** Silence after which the watchdog would abort the turn; 0 or absent means warn-only. */
	abortAfterMs?: number;
	/**
	 * Set only by an emitter whose build serves the agent abort lever
	 * (agent_message.abort): the notice then names that lever before the destructive
	 * delete. Absent on the in-process emitter, whose text stays exactly as before.
	 */
	canAbortAgentTarget?: boolean;
}

/**
 * Parent-facing stall notice: the same silence that used to be visible only on the
 * roster, delivered into the parent's own transcript. A kill makes the parent aware
 * of a wedged child as a side effect; a warn-only watchdog that never tells the
 * parent would trade a false kill for no signal at all, which is why the notice
 * exists separately from any abort.
 */
export function createRlmChildStallNoticeMessage(
	details: RlmChildStallNoticeDetails,
	timestamp = Date.now(),
): CustomMessage<RlmChildStallNoticeDetails> {
	const silentSeconds = Math.max(1, Math.round(details.silentMs / 1000));
	const thresholdSeconds = Math.max(1, Math.round(details.thresholdMs / 1000));
	const inFlight = details.inFlightTools.length > 0 ? details.inFlightTools.join(", ") : "none recorded";
	const evidence =
		details.workEvidence && details.workEvidence.length > 0
			? `Evidence of work in flight: ${details.workEvidence.join(", ")}.`
			: "No evidence of progress was observed.";
	const deadline =
		details.abortAfterMs !== undefined && details.abortAfterMs > 0
			? ` The turn will be interrupted after ${Math.max(1, Math.round(details.abortAfterMs / 1000))}s of silence unless the work resumes or you cancel it first.`
			: " No turn is killed for silence while the watchdog is warn-only, so letting it run is a valid answer.";
	// Both levers interpolate the name into quoted call sites, so it carries the same
	// header sanitization the terminal notice applies.
	const childName = sanitizeMessageHeaderValue(details.sessionName);
	const levers = details.canAbortAgentTarget
		? `abort just the stuck turn with \`await agent_message.abort(receiver_role="child", receiver_name="${childName}")\` ` +
			"(the child stays alive and its queued work is delivered in one new turn), " +
			`or cancel the whole child with \`await rlm.delete_subagent("${childName}")\`, or re-dispatch the task.`
		: `cancel it with \`await rlm.delete_subagent("${childName}")\` or re-dispatch the task.`;
	return {
		role: "custom",
		customType: RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE,
		content:
			`RLM child ${details.sessionName} (${details.childId}) has been silent for ${silentSeconds}s while its turn is running ` +
			`(silence threshold ${thresholdSeconds}s). In-flight tools: ${inFlight}. ${evidence}` +
			`${deadline} Check its status: if it is genuinely working, let it continue; if it looks wedged, ` +
			levers,
		display: true,
		details,
		timestamp,
	};
}

/**
 * Facts behind the system interruption the stall-recovery executor queues into
 * a wedged session (r4 recovery-shell). Everything the model needs to tell an
 * automatic intervention apart from a user Esc: the executor, the measured
 * silence, and the tools that were still in flight when the turn was killed.
 */
export interface SystemInterruptionDetails {
	/** Always "stall_recovery" in this build; named so future triggers stay distinguishable. */
	trigger: "stall_recovery";
	/** True when the interrupted session is an RLM subagent (adds the parent-report clause). */
	isChild: boolean;
	/** Milliseconds without observable activity when the action fired. */
	silentMs: number;
	/** Silence threshold that armed the recovery (the watchdog's warn stage). */
	thresholdMs: number;
	/** Tools still in flight in the killed turn, each as `name` or `name (Ns)`; empty when none. */
	inFlightTools: readonly string[];
	/** True when the watchdog's exemption was still vouching for the silence at action time. */
	excused: boolean;
	/** Who performed the action. */
	executor: "daemon";
}

/**
 * The system interruption message: facts about the automatic interrupt plus the
 * change-of-approach instructions that make the recovery turn useful. Written
 * for the model; `display: true` keeps the transcript auditable (the same
 * convention as the empty-response recovery message).
 *
 * The copy must state out loud that this is neither a user Esc nor a user
 * instruction: custom messages reach the provider as user-role text, and a
 * model that reads "interrupted" as "the user told me to stop" would end the
 * task instead of recovering it.
 */
export function createSystemInterruptionMessage(
	details: SystemInterruptionDetails,
	timestamp = Date.now(),
): CustomMessage<SystemInterruptionDetails> {
	const silentSeconds = Math.max(1, Math.round(details.silentMs / 1000));
	const thresholdSeconds = Math.max(1, Math.round(details.thresholdMs / 1000));
	const inFlight = details.inFlightTools.length > 0 ? details.inFlightTools.join(", ") : "none recorded";
	const lines = [
		`[system] Your previous turn was interrupted automatically: it had been silent for ${silentSeconds}s (silence threshold ${thresholdSeconds}s; in-flight tools: ${inFlight}).`,
		"This is NOT a user Esc and NOT a user instruction - nobody told you to stop and nobody told you to continue. The turn was killed because it produced no observable progress for that long.",
		"Your session, context, and queued work are intact. Change approach on this attempt:",
		"1. If a tool call was wedged, retry that work with a bounded timeout or a smaller input instead of waiting indefinitely.",
		"2. If you were waiting on something external, verify it is still there before waiting on it again.",
		"3. If you cannot make progress, say so in one short paragraph and list what you tried - do not end the turn silently.",
	];
	if (details.isChild) {
		lines.push(
			"4. You are a subagent: after your next step, report this interruption and your new approach to your parent with one short status line.",
		);
	}
	lines.push(
		"This is a one-shot automatic intervention for this silence episode; it will not repeat for the same turn.",
	);
	return {
		role: "custom",
		customType: SYSTEM_INTERRUPTION_CUSTOM_TYPE,
		content: lines.join("\n"),
		display: true,
		details,
		timestamp,
	};
}

/** Re-dispatch facts for the parent-facing receipt's pasteable one-liner. */
export interface RlmChildReDispatchFacts {
	/** The stalled run's original task (truncated for the line). */
	prompt: string;
	/** Provider/model selector the run used, as the parent would spell it. */
	model: string;
	/** Suggested name for the retry run (the original name plus a suffix). */
	sessionName: string;
	/** The child's thinking level, when the parent knows it (a hint, not a mandate). */
	thinkingLevel?: string;
}

/**
 * Token-slot sanitizer for the pasteable re-dispatch line (r4-p2: blind-2 F3 /
 * blind-3 finding 6 / blind-1 F4). Token slots (name, model, thinking) only
 * need to stay inside one double-quoted string argument: strip quotes, the
 * backslash, statement separators, parentheses, and the comment character, so a
 * slot can neither close its string, chain a second statement, nor comment out
 * the rest of the line.
 */
function sanitizeRlmReDispatchToken(value: string): string {
	return value.replace(/["'\\:;()#\x00-\x1f\x7f]/g, "").trim();
}

/**
 * The one-line re-dispatch command the receipt carries. The prompt is truncated,
 * any triple-quote sequence is neutralized, and a trailing quote or backslash is
 * padded with a space; token slots carry the token sanitizer above, and the
 * truncation marker rides as a trailing Python comment - so pasting the line
 * into a Python REPL always parses as exactly one `await rlm(...)` call. The
 * truncation marker tells the parent the task may need restating.
 */
export function formatRlmReDispatchLine(facts: RlmChildReDispatchFacts): string {
	const name = sanitizeRlmReDispatchToken(sanitizeMessageHeaderValue(facts.sessionName ?? "")) || "child";
	const model = sanitizeRlmReDispatchToken(facts.model);
	const thinkingLevel = facts.thinkingLevel ? sanitizeRlmReDispatchToken(facts.thinkingLevel) : undefined;
	const truncated = facts.prompt.length > RLM_RE_DISPATCH_PROMPT_MAX_CHARS;
	let prompt = facts.prompt
		.slice(0, RLM_RE_DISPATCH_PROMPT_MAX_CHARS)
		.replace(/"""+/g, "'''")
		.replace(/[\n\r]+/g, " ")
		.replace(/\x00/g, "")
		.trim();
	// A trailing quote or backslash abuts the closing delimiter and would break
	// out of (or escape) it: pad with a space so the literal always closes.
	if (prompt.endsWith('"') || prompt.endsWith("\\")) prompt += " ";
	const thinking = thinkingLevel ? `, thinking="${thinkingLevel}"` : "";
	// The truncation marker is a trailing Python comment, never a bare suffix:
	// anything after the closing paren would parse as a second (invalid) call.
	const truncationNote = truncated ? "  # first 800 chars - restate the full task if this is truncated" : "";
	return `await rlm("""${prompt}""", name="${name}-retry", model="${model}"${thinking})${truncationNote}`;
}

/** Cap for the prompt carried in the receipt's re-dispatch line. */
export const RLM_RE_DISPATCH_PROMPT_MAX_CHARS = 800;

/**
 * Facts behind the parent-facing stall-recovery receipt. Two variants share the
 * type: the action receipt (sent right after the intervention) and the
 * escalation (`escalated: true`, sent once when the child is still silent
 * `escalateAfterMs` after the action).
 */
export interface RlmChildRecoveryActionDetails {
	childId: string;
	sessionName: string;
	/** Who performed the action. */
	executor: "daemon";
	/** What was done: "abort_and_send" (turn killed, system instruction queued as next input) or "abort" (turn killed only). */
	action: "abort_and_send" | "abort";
	/** Epoch ms the action executed. */
	at: number;
	/** Milliseconds without observable activity when the action fired. */
	silentMs: number;
	thresholdMs: number;
	/** Tools still in flight in the killed turn, each as `name` or `name (Ns)`; empty when none. */
	inFlightTools: readonly string[];
	/** True on the escalation variant (still silent `escalateAfterMs` after the action). */
	escalated?: boolean;
	/**
	 * The escalation window the policy guarantees, in ms - the same constant on
	 * both variants. r4-p2 (blind-3 finding 10): this field is no longer the
	 * measured action-to-escalation gap; that value lives in
	 * `silentSinceActionMs`, so the two semantics do not share one field.
	 */
	escalateAfterMs?: number;
	/** Measured action-to-escalation gap, on the escalation variant only. */
	silentSinceActionMs?: number;
	/** Re-dispatch facts when the parent's live run for the child is known; absent for retained children. */
	reDispatch?: RlmChildReDispatchFacts;
	/** The child's session dir, for inspection after an escalation. */
	sessionDir?: string;
}

/**
 * The parent-facing receipt for an automatic stall-recovery action on a child.
 * The copy must read as "someone took over, the child is retrying" - not as the
 * child's own failure - and must state that no automatic re-dispatch will
 * happen, so the parent knows the decision is still its own.
 */
export function createRlmChildRecoveryActionMessage(
	details: RlmChildRecoveryActionDetails,
	timestamp = Date.now(),
): CustomMessage<RlmChildRecoveryActionDetails> {
	const childName = sanitizeMessageHeaderValue(details.sessionName) || details.childId;
	const silentSeconds = Math.max(1, Math.round(details.silentMs / 1000));
	const thresholdSeconds = Math.max(1, Math.round(details.thresholdMs / 1000));
	const inFlight = details.inFlightTools.length > 0 ? details.inFlightTools.join(", ") : "none recorded";
	// r4-p2 (blind-3 finding 10): the escalation variant quotes the measured
	// action-to-escalation gap; the action variant quotes the policy window.
	const quotedSilenceMs =
		details.escalated === true
			? (details.silentSinceActionMs ?? details.escalateAfterMs ?? 0)
			: (details.escalateAfterMs ?? 0);
	const escalateSeconds = Math.max(1, Math.round(quotedSilenceMs / 1000));
	const reDispatchLine = details.reDispatch ? formatRlmReDispatchLine(details.reDispatch) : undefined;
	const lines: string[] = [];
	if (details.escalated === true) {
		lines.push(
			`RLM child ${childName} (${details.childId}) is still silent ${escalateSeconds}s after the automatic stall-recovery action (executor: ${details.executor}; action: ${details.action}).`,
			"Automatic intervention stops here: there will be no further interrupts and no automatic re-dispatch. The child's session, context, and transcript are intact.",
		);
		if (details.sessionDir) lines.push(`Session dir: ${details.sessionDir}`);
		lines.push(
			"Your move - inspect it, steer it, or delete it and re-dispatch the task. Delete it before re-dispatching: a child that is only slow keeps working, and two workers on the same files overwrite each other.",
		);
		lines.push(`  await agent_observe.get_agent("${childName}")`);
		lines.push(`  await rlm.delete_subagent("${childName}")`);
		lines.push(
			reDispatchLine ? `  ${reDispatchLine}` : `  await rlm(<restate the original task>, name="${childName}-retry")`,
		);
	} else {
		lines.push(
			`RLM child ${childName} (${details.childId}): automatic stall recovery acted (executor: ${details.executor}; action: ${details.action}).`,
			`It had been silent for ${silentSeconds}s (silence threshold ${thresholdSeconds}s; in-flight tools: ${inFlight}). ` +
				"The turn was interrupted and a system instruction was queued as the child's next input, telling it to change approach; the child session, its context, and its queued work are intact. " +
				"This was not a user action and not your instruction.",
			`If the child is still silent ~${escalateSeconds}s after the action you will receive one escalation notice. No automatic re-dispatch will happen - that decision stays with you.`,
		);
		if (reDispatchLine) {
			lines.push(
				"If you would rather re-dispatch it yourself now, delete the original first (it may still be working, and two workers on the same files overwrite each other), then paste this line:",
			);
			lines.push(`  await rlm.delete_subagent("${childName}")`);
			lines.push(`  ${reDispatchLine}`);
		} else {
			lines.push(
				`If you would rather re-dispatch it yourself now, delete the original first (it may still be working): await rlm.delete_subagent("${childName}"), then await rlm(<restate the original task>, name="${childName}-retry")`,
			);
		}
	}
	return {
		role: "custom",
		customType: RLM_CHILD_RECOVERY_ACTION_CUSTOM_TYPE,
		content: lines.join("\n"),
		display: true,
		details,
		timestamp,
	};
}

/**
 * r4-p2 (blind-1 F2 / blind-3 findings 2 and 5): the depth-0 (root) escalation
 * notice. A main session that is still silent after its automatic
 * stall-recovery action has no parent to notify, so the notice lands in the
 * session's own transcript (append-only, never turn input). The details carry
 * the marker's real values - the action the sweep actually took and the
 * measured silence since it - so the notice cannot misreport an abort-only
 * degrade. Custom-type data is additive: an older reader degrades the message
 * to plain transcript text.
 */
export const STALL_RECOVERY_ESCALATION_CUSTOM_TYPE = "stall_recovery_escalation";

export interface StallRecoveryEscalationDetails {
	/** Who performed the action this escalation reports on. */
	executor: "daemon";
	/** Epoch ms the automatic action executed. */
	actedAt: number;
	/** Measured milliseconds between the action and this escalation. */
	silentSinceActionMs: number;
	/** The action the sweep took: "abort_and_send", or "abort" when the queue could not deliver. */
	action: "abort_and_send" | "abort";
	/** Consecutive automatic actions on this session since the last external input. */
	count: number;
	/** Display name of the session, for the pasteable attach line. */
	sessionName: string;
}

export function createStallRecoveryEscalationMessage(
	details: StallRecoveryEscalationDetails,
	timestamp = Date.now(),
): CustomMessage<StallRecoveryEscalationDetails> {
	const silentMinutes = Math.max(1, Math.round(details.silentSinceActionMs / 60_000));
	// The name is interpolated into a pasteable CLI line, so it carries the same
	// header sanitization the other notices apply.
	const name = sanitizeMessageHeaderValue(details.sessionName);
	const lines: string[] = [
		`This session${name ? ` (${name})` : ""} is still silent ${silentMinutes}m after the automatic stall-recovery action (executor: ${details.executor}; action: ${details.action}; action ${details.count} of this chain).`,
		"Automatic intervention stops here: there will be no further interrupts and no automatic re-dispatch. The session, its context, and its transcript are intact.",
		"Your move - attach and prompt it, steer it, or close it:",
	];
	if (name) {
		lines.push(`  prime-agent attach ${name}`);
	} else {
		lines.push("  prime-agent agents (find this session in the list)");
	}
	if (details.action === "abort") {
		lines.push(
			"The last action was abort-only: nothing was queued as this session's next input, so a new prompt is needed to restart the work.",
		);
	}
	return {
		role: "custom",
		customType: STALL_RECOVERY_ESCALATION_CUSTOM_TYPE,
		content: lines.join("\n"),
		display: true,
		details,
		timestamp,
	};
}

export function createRlmChildTerminalNoticeMessage(
	details: RlmChildTerminalNoticeDetails,
	timestamp = Date.now(),
): CustomMessage<RlmChildTerminalNoticeDetails> {
	// The synthetic notice address is interpolated into a header-shaped line, so a session
	// name carrying brackets or newlines must not be able to forge a second header.
	const childName = sanitizeMessageHeaderValue(details.sessionName);
	const content =
		details.kind === "cancelled"
			? `RLM child ${childName} (${details.childId}) was cancelled${details.reason ? `: ${details.reason}` : ""}`
			: `RLM child ${childName} (${details.childId}) completed without sending a reply${
					details.lastAssistantTextPreview
						? `. Its last assistant text (written to its own transcript, never sent to you): ${details.lastAssistantTextPreview}. If that text answers the task, use it; if it is cut off or unclear, read the child's files or transcript before re-dispatching, since the work is usually already done`
						: ". Read the child's files or transcript before re-dispatching: finishing without a reply usually means the work is done and only the report is missing"
				}`;
	return {
		role: "custom",
		customType: RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
		content,
		display: true,
		details,
		timestamp,
	};
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface HeartbeatPromptDetails {
	jobId: string;
	schedule: string;
	status: AgentCronJob["status"];
	runCount: number;
	nextRunAt?: string;
	lastRunAt?: string;
}

export interface IpythonStateRestoredDetails {
	restored: boolean;
}

/** Import names of the pre-imported Python skills that failed to import into the kernel. */
export interface PythonSkillsUnavailableDetails {
	skills: string[];
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	/** Number of retained messages that precede this summary in transcript presentation. */
	retainedMessageCount?: number;
	/** User instructions that guided the summary (from `/compact <instructions>`) */
	customInstructions?: string;
	/**
	 * Harness digest snapshot rendered before the summary in LLM context. Attached
	 * mechanically at compaction time; it never flows through the summarizer.
	 */
	harnessDigest?: string;
	/** Fingerprint of the harness state behind `harnessDigest` at compaction time; lets cold boundaries skip re-delivery. */
	harnessStateFingerprint?: string;
	timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * Format bash output for LLM context. The fence must be longer than any
 * backtick run in the output so command output cannot terminate it early.
 */
export function bashOutputToText(
	msg: Pick<BashExecutionMessage, "output" | "exitCode" | "cancelled" | "truncated" | "fullOutputPath">,
): string {
	let text = "";
	if (msg.output) {
		let longestBacktickRun = 0;
		for (const match of msg.output.matchAll(/`+/g)) {
			longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
		}
		const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
		text += `${fence}\n${msg.output}\n${fence}`;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated) {
		text += msg.fullOutputPath
			? `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`
			: "\n\n[Output truncated.]";
	}
	return text;
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	return `Ran \`${msg.command}\`\n${bashOutputToText(msg)}`;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	customInstructions?: string,
	retainedMessageCount?: number,
	harnessDigest?: string,
	harnessStateFingerprint?: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		retainedMessageCount,
		customInstructions,
		harnessDigest,
		harnessStateFingerprint,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createSessionSlashCommandMessage(
	command: SessionSlashCommand,
	details: Omit<SessionSlashCommandDetails, "command"> = {},
	display = true,
	timestamp = Date.now(),
): SessionSlashCommandMessage {
	return {
		role: "custom",
		customType: SESSION_SLASH_COMMAND_CUSTOM_TYPE,
		content: command.text,
		display,
		details: { ...details, command: { ...command } },
		timestamp,
	};
}

export function createSessionSlashCommandResultMessage(
	content: string,
	details: SessionSlashCommandResultDetails,
	display = true,
	timestamp = Date.now(),
): SessionSlashCommandResultMessage {
	return {
		role: "custom",
		customType: SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
		content,
		display,
		details: { ...details, command: { ...details.command } },
		timestamp,
	};
}

export function createCompactionOutcomeMessage(
	content: string,
	details: CompactionOutcomeDetails,
	display = true,
	timestamp = Date.now(),
): CompactionOutcomeMessage {
	return {
		role: "custom",
		customType: COMPACTION_OUTCOME_CUSTOM_TYPE,
		content,
		display,
		details: { ...details },
		timestamp,
	};
}

export function createRefinementOutcomeMessage(
	result: RefinementResult,
	display = true,
	timestamp = Date.now(),
): RefinementOutcomeMessage {
	return {
		role: "custom",
		customType: REFINEMENT_OUTCOME_CUSTOM_TYPE,
		content: `Refinement complete: ${result.summary}`,
		display,
		details: {
			refinementId: result.id,
			summary: result.summary,
			scope: result.scope ?? "local",
			...(result.rollbackOf ? { rollbackOf: result.rollbackOf } : {}),
			edits: result.appliedEdits,
		},
		timestamp,
	};
}

/**
 * MV-5: the failure receipt for a refinement that died (parse, length, provider,
 * or persist failure). Successes already reach the model through
 * `refinementOutcomeToLlmText` (e6c1af56); without this receipt a failure was
 * event/UI-only and the model never learned its refine.run or auto-refine
 * attempt produced nothing.
 */
export function createRefinementFailureMessage(
	failure: { refinementId: string; scope: HarnessScope; reason: string },
	display = true,
	timestamp = Date.now(),
): RefinementOutcomeMessage {
	return {
		role: "custom",
		customType: REFINEMENT_OUTCOME_CUSTOM_TYPE,
		content: `Refinement failed: ${failure.reason}`,
		display,
		details: {
			refinementId: failure.refinementId,
			summary: failure.reason,
			scope: failure.scope,
			edits: [],
			failed: true,
			error: failure.reason,
		},
		timestamp,
	};
}

/** Model-facing refinement notice: passes convertToLlm (unlike the refinement_outcome audit entry); display false because the TUI renders the outcome message. */
export function createRefinementNoticeMessage(
	result: RefinementResult,
	source: RefinementSource,
	timestamp = Date.now(),
): RefinementNoticeMessage {
	return {
		role: "custom",
		customType: REFINEMENT_NOTICE_CUSTOM_TYPE,
		content: `[${source}-refinement]\n\n${formatRefinementNoticeBody(result)}`,
		display: false,
		details: {
			refinementId: result.id,
			summary: result.summary,
			scope: result.scope ?? "local",
			...(result.rollbackOf ? { rollbackOf: result.rollbackOf } : {}),
			edits: result.appliedEdits,
			source,
		},
		timestamp,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The saved-but-not-live tail every outcome line shares. */
function activationSuffix(details: McpOutcomeDetails): string {
	return details.activation === "inactive" ? " The change remains saved, but it is not active in this session." : "";
}

/** Plain-text outcome line for a completed MCP disconnect. */
function formatMcpDisconnectionNotice(details: McpDisconnectionOutcomeDetails): string {
	const suffix = activationSuffix(details);
	switch (details.removal) {
		case "removed":
			return `Disconnected ${details.label}.${suffix}`;
		case "credential-only":
			return `Disconnected ${details.label}. No saved connection entry existed; the stored credential was removed.${suffix}`;
		case "preserved":
			return `Disconnected ${details.label}. The saved connection entry was kept and now shows as not connected.${suffix}`;
	}
}

/**
 * Plain-text outcome line for an MCP connect or disconnect. This is the
 * durable wording the flows already reported: it is what the entry persists as
 * `content` and what the transient fallback shows, so it stays a full sentence
 * even where the rendered entry splits it into a header and a detail line.
 */
export function formatMcpConnectionOutcomeNotice(details: McpOutcomeDetails): string {
	if (isMcpDisconnectionOutcome(details)) return formatMcpDisconnectionNotice(details);
	const prefix =
		details.source === "login" && details.addedAccount === true && details.connectionId
			? `Added account ${details.connectionId}. `
			: "";
	const suffix = activationSuffix(details);
	switch (details.verification) {
		case "connected":
			return `${prefix}Connected ${details.label}${
				details.toolCount !== undefined ? ` (${details.toolCount} tools verified)` : ""
			}.${suffix}`;
		case "unverified":
			if (details.source === "retry") {
				return `Verification did not complete: ${details.issue}. The connection is saved; retry from /plugins.${suffix}`;
			}
			if (details.source === "paste") {
				// No login happened: the user pasted a token. "Login succeeded"
				// would be a false claim here.
				return `Token saved for ${details.label}, but connection verification did not complete: ${details.issue}. The connection is saved; retry from /plugins.${suffix}`;
			}
			return `${prefix}Login succeeded for ${details.label}, but connection verification did not complete: ${details.issue}. The connection is saved; retry from /plugins.${suffix}`;
		case "unsaved":
			if (details.source === "retry") {
				return `The verification result could not be saved. The connection is saved; retry from /plugins.${suffix}`;
			}
			if (details.source === "paste") {
				return `Token saved for ${details.label}, but the verification result could not be saved. The connection is saved; retry from /plugins.${suffix}`;
			}
			return `${prefix}Login succeeded for ${details.label}, but the verification result could not be saved. The connection is saved; retry from /plugins.${suffix}`;
	}
}

export function createMcpConnectionOutcomeMessage(
	details: McpOutcomeDetails,
	display = true,
	timestamp = Date.now(),
): McpConnectionOutcomeMessage {
	return {
		role: "custom",
		customType: MCP_CONNECTION_OUTCOME_CUSTOM_TYPE,
		content: formatMcpConnectionOutcomeNotice(details),
		display,
		details: { ...details },
		timestamp,
	};
}

function hasValidCustomMessageEnvelope(message: Record<string, unknown>, customType: string): boolean {
	return (
		message.role === "custom" &&
		message.customType === customType &&
		typeof message.content === "string" &&
		typeof message.display === "boolean" &&
		typeof message.timestamp === "number" &&
		Number.isFinite(message.timestamp)
	);
}

export function isSessionSlashCommand(value: unknown): value is SessionSlashCommand {
	if (
		!isRecord(value) ||
		!isSessionSlashCommandName(value.name) ||
		typeof value.args !== "string" ||
		typeof value.text !== "string"
	) {
		return false;
	}
	const parsed = parseSessionSlashCommand(value.text);
	return (
		parsed !== undefined && parsed.name === value.name && parsed.args === value.args && parsed.text === value.text
	);
}

function isValidCommandEntryId(value: unknown): value is string | undefined {
	return value === undefined || (typeof value === "string" && value.length > 0);
}

export function isSessionSlashCommandMessage(message: unknown): message is SessionSlashCommandMessage {
	if (
		!isRecord(message) ||
		!hasValidCustomMessageEnvelope(message, SESSION_SLASH_COMMAND_CUSTOM_TYPE) ||
		typeof message.content !== "string"
	) {
		return false;
	}
	if (!isRecord(message.details) || !isSessionSlashCommand(message.details.command)) return false;
	return message.content === message.details.command.text && isValidCommandEntryId(message.details.commandEntryId);
}

export function isSessionSlashCommandResultMessage(message: unknown): message is SessionSlashCommandResultMessage {
	if (!isRecord(message) || !hasValidCustomMessageEnvelope(message, SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE))
		return false;
	if (!isRecord(message.details) || !isSessionSlashCommand(message.details.command)) return false;
	return (
		typeof message.details.success === "boolean" &&
		(message.details.severity === "info" ||
			message.details.severity === "warning" ||
			message.details.severity === "error") &&
		(message.details.error === undefined || typeof message.details.error === "string") &&
		isValidCommandEntryId(message.details.commandEntryId)
	);
}

export function isCompactionOutcomeMessage(message: unknown): message is CompactionOutcomeMessage {
	if (!isRecord(message) || !hasValidCustomMessageEnvelope(message, COMPACTION_OUTCOME_CUSTOM_TYPE)) return false;
	if (!isRecord(message.details)) return false;
	return (
		(message.details.reason === "threshold" ||
			message.details.reason === "overflow" ||
			message.details.reason === "requested") &&
		(message.details.outcome === "skipped" ||
			message.details.outcome === "cancelled" ||
			message.details.outcome === "failed")
	);
}

function isAppliedRefinementEdit(value: unknown): value is AppliedRefinementEdit {
	return (
		isRecord(value) &&
		(value.action === "create" || value.action === "update" || value.action === "delete") &&
		typeof value.kind === "string" &&
		typeof value.id === "string" &&
		typeof value.applied === "boolean"
	);
}

export function isRefinementOutcomeMessage(message: unknown): message is RefinementOutcomeMessage {
	if (!isRecord(message) || !hasValidCustomMessageEnvelope(message, REFINEMENT_OUTCOME_CUSTOM_TYPE)) return false;
	if (!isRecord(message.details)) return false;
	return (
		typeof message.details.summary === "string" &&
		(message.details.scope === "local" || message.details.scope === "global") &&
		Array.isArray(message.details.edits) &&
		message.details.edits.every(isAppliedRefinementEdit)
	);
}

function isValidMcpActivation(activation: unknown): boolean {
	return activation === undefined || activation === "active" || activation === "inactive";
}

function isValidMcpDisconnectionDetails(details: Record<string, unknown>): boolean {
	return (
		typeof details.label === "string" &&
		(details.removal === "removed" || details.removal === "credential-only" || details.removal === "preserved") &&
		(details.connectionId === undefined || typeof details.connectionId === "string") &&
		isValidMcpActivation(details.activation)
	);
}

export function isMcpConnectionOutcomeMessage(message: unknown): message is McpConnectionOutcomeMessage {
	if (!isRecord(message) || !hasValidCustomMessageEnvelope(message, MCP_CONNECTION_OUTCOME_CUSTOM_TYPE)) return false;
	if (!isRecord(message.details)) return false;
	if (message.details.kind === "disconnect") return isValidMcpDisconnectionDetails(message.details);
	return (
		(message.details.kind === undefined || message.details.kind === "connect") &&
		typeof message.details.label === "string" &&
		(message.details.source === "login" ||
			message.details.source === "retry" ||
			message.details.source === "paste") &&
		(message.details.verification === "connected" ||
			message.details.verification === "unverified" ||
			message.details.verification === "unsaved") &&
		(message.details.toolCount === undefined ||
			(typeof message.details.toolCount === "number" && Number.isInteger(message.details.toolCount))) &&
		(message.details.issue === undefined || typeof message.details.issue === "string") &&
		(message.details.issueCategory === undefined || typeof message.details.issueCategory === "string") &&
		(message.details.connectionId === undefined || typeof message.details.connectionId === "string") &&
		(message.details.addedAccount === undefined || typeof message.details.addedAccount === "boolean") &&
		isValidMcpActivation(message.details.activation)
	);
}

export interface HeartbeatPromptMessage extends CustomMessage<HeartbeatPromptDetails> {
	customType: typeof HEARTBEAT_PROMPT_CUSTOM_TYPE;
	// NOT narrowed to `content: string` (upstream #2336 did narrow it, and deleted the fork
	// test that needs the wide shape). test/suite/regressions/4482-heartbeat-injected-prompt.test.ts
	// is UD keep-ours (主文档 §3.2「249 个删测不拿」) and assigns an image block array to
	// message.content to exercise placeholder rendering; with the narrowing that file cannot
	// compile (tsgo TS2322 at :540). CustomMessage<HeartbeatPromptDetails>["content"] is the
	// pi-ai union our HEAD already used, so the fork test compiles unchanged.
	//
	// The content is the BARE `job.prompt` (fork form). Upstream #2336's
	// `[heartbeat: <schedule> run#N]\n\n` prefix is rolled back: it IS pinned against, in
	// four places, all of which compare the heartbeat text for exact equality with
	// `createHeartbeat().prompt` (test/suite/regressions/4482-heartbeat-injected-prompt.test.ts
	// :134, :260, :308, and :392 where a prefix silently drops the heartbeat out of a
	// `.filter(text => [...].includes(text))`), plus
	// test/suite/agent-session-model-extension.test.ts:445. No test anywhere pins the
	// prefixed form (`grep -rn "run#\|\[heartbeat" test/` -> zero hits). The schedule and
	// runCount remain on `details`, so the UI badge and daemon accounting keep them.
}

export function createHeartbeatPromptMessage(job: AgentCronJob, timestamp = Date.now()): HeartbeatPromptMessage {
	return {
		role: "custom",
		customType: HEARTBEAT_PROMPT_CUSTOM_TYPE,
		content: job.prompt,
		display: true,
		details: {
			jobId: job.id,
			schedule: job.schedule.expression,
			status: job.status,
			runCount: job.runCount,
			nextRunAt: job.nextRunAt,
			lastRunAt: job.lastRunAt,
		},
		timestamp,
	};
}

/** Longest refinement summary echoed back to the model; the edit rows are the payload. */
const REFINEMENT_OUTCOME_SUMMARY_LIMIT = 240;

function truncateRefinementSummary(summary: string): string {
	const collapsed = summary.replace(/\s+/g, " ").trim();
	if (collapsed.length <= REFINEMENT_OUTCOME_SUMMARY_LIMIT) {
		return collapsed;
	}
	return `${collapsed.slice(0, REFINEMENT_OUTCOME_SUMMARY_LIMIT - 1)}…`;
}

/**
 * Model-visible text for a refinement outcome, or undefined when the outcome has
 * nothing to report. A refinement that wrote no entry and refused none carries no
 * information, so it must not spend context.
 */
export function refinementOutcomeToLlmText(details: RefinementOutcomeDetails): string | undefined {
	if (details.failed) {
		// A failure reports itself even with zero edit rows: the whole point of
		// the receipt is that the model learns the attempt produced nothing.
		const lines = [
			`<refinement id="${details.refinementId}" scope="${details.scope}" outcome="failed">`,
			`reason: ${truncateRefinementSummary(details.error ?? details.summary)}`,
			"no edits were applied and the harness state on disk is unchanged.",
			"</refinement>",
		];
		return `${REFINEMENT_OUTCOME_PREFIX}\n\n${lines.join("\n")}`;
	}
	if (details.edits.length === 0) {
		return undefined;
	}
	const rollback = details.rollbackOf ? ` rollback-of="${details.rollbackOf}"` : "";
	const lines = [
		`<refinement id="${details.refinementId}" scope="${details.scope}"${rollback}>`,
		`summary: ${truncateRefinementSummary(details.summary)}`,
	];
	for (const edit of details.edits) {
		const reason = edit.error ?? "no reason reported";
		lines.push(
			`${edit.applied ? "applied" : "refused"}: ${edit.action} ${edit.kind}:${edit.id}${edit.applied ? "" : ` (${reason})`}`,
		);
	}
	lines.push("</refinement>");
	return `${REFINEMENT_OUTCOME_PREFIX}\n\n${lines.join("\n")}`;
}

/**
 * Renders a refinement outcome as a model-visible receipt. Returns undefined for
 * malformed or empty outcomes, which are silently dropped exactly as before.
 */
function refinementOutcomeToLlmMessage(message: unknown): Message | undefined {
	if (!isRefinementOutcomeMessage(message)) {
		return undefined;
	}
	const text = refinementOutcomeToLlmText(message.details);
	if (text === undefined) {
		return undefined;
	}
	return { role: "user", content: [{ type: "text", text }], timestamp: message.timestamp };
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					if (m.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE) {
						// Refinement used to be filtered out together with the other
						// session bookkeeping types, which left the model unable to tell a
						// recorded lesson from one that was silently refused. Only outcomes
						// that actually report something reach the model.
						return refinementOutcomeToLlmMessage(m);
					}
					if (
						m.customType === SESSION_SLASH_COMMAND_CUSTOM_TYPE ||
						m.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE ||
						m.customType === COMPACTION_OUTCOME_CUSTOM_TYPE ||
						m.customType === MCP_CONNECTION_OUTCOME_CUSTOM_TYPE ||
						m.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE ||
						m.customType === PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE
					) {
						return undefined;
					}
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary": {
					// Memories first: the digest is the menu the summary assumes the
					// model still has, and it is attached mechanically at compaction.
					const digestBlock = m.harnessDigest
						? `${HARNESS_DIGEST_PREFIX}${m.harnessDigest}${HARNESS_DIGEST_SUFFIX}\n\n`
						: "";
					return {
						role: "user",
						content: [
							{
								type: "text" as const,
								text: digestBlock + COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX,
							},
						],
						timestamp: m.timestamp,
					};
				}
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}
