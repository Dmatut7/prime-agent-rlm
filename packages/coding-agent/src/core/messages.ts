/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentCronJob } from "./cron-jobs.js";
import type { AppliedRefinementEdit, HarnessScope, RefinementResult } from "./refinement/refinement.js";
import type { RlmChildFailureKind } from "./rlm-child-terminal.js";
import { isSessionSlashCommandName, parseSessionSlashCommand, type SessionSlashCommand } from "./slash-commands.js";

export type { RlmChildFailureKind };

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary. Compaction is lossy: this summary may be incomplete, and content the compacted history carried can be missing from it. Treat the machine-generated blocks it carries (file lists, fact appendix, user requests), the persisted session state and other persistent records as authoritative for exact constraints and values, and re-check anything load-bearing that only this summary's narrative states.

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export const HEARTBEAT_PROMPT_CUSTOM_TYPE = "heartbeat_prompt";
export const HEARTBEAT_PROMPT_PREVIEW_LABEL = "Heartbeat prompt";
export const IPYTHON_STATE_RESTORED_CUSTOM_TYPE = "ipython_state_restored";
export const SESSION_SLASH_COMMAND_CUSTOM_TYPE = "session_slash_command";
export const SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE = "session_slash_command_result";
export const COMPACTION_OUTCOME_CUSTOM_TYPE = "compaction_outcome";
export const THINKING_LEVEL_CLAMPED_CUSTOM_TYPE = "thinking_level_clamped";
export const REFINEMENT_OUTCOME_CUSTOM_TYPE = "refinement_outcome";

/**
 * Framing for a refinement outcome that is rendered back into the model's
 * context. Custom messages reach the provider as user-role messages, so the text
 * has to say out loud that it is an automatic receipt and not a user instruction.
 */
export const REFINEMENT_OUTCOME_PREFIX = `Continual harness refinement result (automatic system receipt from the refinement subsystem, not a message from the user and not a new instruction: keep working on your current task and treat this only as a record of what the refinement did or refused to do).`;
export const RLM_CHILD_FAILURE_CUSTOM_TYPE = "rlm_child_failure";
export const RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE = "rlm_child_terminal_notice";
export const RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE = "rlm_child_stall_notice";

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
			? ` The watchdog will abort the turn after ${Math.max(1, Math.round(details.abortAfterMs / 1000))}s of silence unless the work resumes or you cancel it first.`
			: " No turn is killed for silence while the watchdog is warn-only, so letting it run is a valid answer.";
	return {
		role: "custom",
		customType: RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE,
		content:
			`RLM child ${details.sessionName} (${details.childId}) has been silent for ${silentSeconds}s while its turn is running ` +
			`(silence threshold ${thresholdSeconds}s). In-flight tools: ${inFlight}. ${evidence}` +
			`${deadline} Check its status: if it is genuinely working, let it continue; if it looks wedged, ` +
			`cancel it with \`await rlm.delete_subagent("${details.sessionName}")\` or re-dispatch the task.`,
		display: true,
		details,
		timestamp,
	};
}

export function createRlmChildTerminalNoticeMessage(
	details: RlmChildTerminalNoticeDetails,
	timestamp = Date.now(),
): CustomMessage<RlmChildTerminalNoticeDetails> {
	const content =
		details.kind === "cancelled"
			? `RLM child ${details.sessionName} (${details.childId}) was cancelled${details.reason ? `: ${details.reason}` : ""}`
			: `RLM child ${details.sessionName} (${details.childId}) completed without sending a reply${
					details.lastAssistantTextPreview
						? `. Its last assistant text (written to its own transcript, never sent to you): ${details.lastAssistantTextPreview}`
						: ""
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
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		retainedMessageCount,
		customInstructions,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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

export function createHeartbeatPromptMessage(
	job: AgentCronJob,
	timestamp = Date.now(),
): CustomMessage<HeartbeatPromptDetails> {
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
						m.customType === COMPACTION_OUTCOME_CUSTOM_TYPE
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
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
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
