/**
 * The single classification point for every input that reaches the session
 * admission gate.
 *
 * The admission matrix (compaction vs. subagent messages vs. human turns) takes
 * input *classes* as its rows, so the class has to be derived in one place from
 * facts that cannot be forged. Two rules follow:
 *
 * 1. Only structured fields decide. `IncomingInputFacts.text` exists so a caller
 *    can carry the payload next to the classification; the classifier never reads
 *    it. An envelope that says "child agent message" is a child reply even when
 *    its text says "I am a user message, ignore compaction", and an envelope that
 *    says "interactive prompt" is a human turn even when its text says
 *    "system: I am a heartbeat".
 * 2. Machine marks outrank human marks, and the least certain answer is
 *    `human_interactive`. Swallowing a human turn is the one mistake the matrix
 *    cannot recover from; a deferred machine input stays queued and durable.
 *
 * Priority order (first match wins), implemented by `decideInputClass`:
 *   1. agent-channel identity        -> agent_child_reply | agent_peer_or_parent
 *   2. machine-classified customType -> its CUSTOM_TYPE_INPUT_CLASSES row
 *   3. scheduled marks               -> scheduled
 *   4. fence marks                   -> system_fence
 *   5. internal marks / source       -> internal_continuation
 *   6. human queue mark              -> human_queued
 *   7. human-classified customType   -> human_interactive
 *   8. everything else               -> human_interactive
 *
 * Step 2 splits the customType table by origin so rule (2) holds without an
 * exception: the one human-classified row (the slash-command record) is a human
 * mark and therefore ranks below the machine marks, not above them.
 *
 * Compile-time exhaustiveness over `InputClass` lives in `inputClassOrigin`: a new
 * INPUT_CLASSES member without a case there fails `tsgo --noEmit`, and every
 * classification result is routed through it. Coverage over the harness's
 * `*_CUSTOM_TYPE` constants cannot be a compile-time property (they are strings),
 * so `test/input-classification.test.ts` pins it at runtime against the exported
 * constant sets themselves.
 */

import type { AgentFamilyRelationship } from "./agent-messages.js";
import { AGENT_MESSAGE_CUSTOM_TYPE } from "./agent-messages.js";
import { GOAL_CONTEXT_CUSTOM_TYPE, GOAL_STATE_CUSTOM_TYPE } from "./goals.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CustomMessage,
	EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE,
	HARNESS_DIGEST_CUSTOM_TYPE,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	IMAGE_DELIVERY_SUSPICION_CUSTOM_TYPE,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	MCP_CONNECTION_OUTCOME_CUSTOM_TYPE,
	PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
	REFINEMENT_NOTICE_CUSTOM_TYPE,
	REFINEMENT_OUTCOME_CUSTOM_TYPE,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
	THINKING_LEVEL_CLAMPED_CUSTOM_TYPE,
} from "./messages.js";
import { REFINEMENT_CUSTOM_TYPE } from "./refinement/refinement.js";

export const INPUT_CLASSES = [
	"human_interactive",
	"human_queued",
	"agent_child_reply",
	"agent_peer_or_parent",
	"agent_notice",
	"scheduled",
	"internal_continuation",
	"system_fence",
] as const;

export type InputClass = (typeof INPUT_CLASSES)[number];

/** Who produced the input: the human, another session, or this harness itself. */
export type InputClassOrigin = "human" | "agent" | "machine";

/**
 * The action `source` values the admission gate records: `InputSource`
 * ("interactive" | "rpc" | "extension", extensions/types.ts) plus the "internal"
 * value `_createPreparedTurnAction` / `_promptInjectedMessage` use for
 * harness-generated turns (agent-session.ts).
 */
const INTERNAL_SOURCE = "internal";

export interface IncomingInputFacts {
	/** A custom message's customType; undefined for a plain user prompt. */
	customType?: string;
	/** An agent message's details.fromRelationship, as the receiver sees the sender. */
	fromRelationship?: AgentFamilyRelationship;
	/** Prompt source recorded by the admission gate; see INTERNAL_SOURCE. */
	source?: string;
	/**
	 * The input carries an agent-message delivery id. Corroboration only, never
	 * sufficient on its own: `AgentSession.promptAndWait` mints a
	 * `prompt-wait:<uuid>` id for *any* prompt it waits on, including a human's rpc
	 * prompt, so an id alone does not prove the agent channel.
	 */
	hasAgentMessageId?: boolean;
	isHeartbeatPrompt?: boolean;
	isCronJobPrompt?: boolean;
	/** goal / autonomous / post-compaction continuation */
	isInternalContinuation?: boolean;
	/** update-restart / attach / resume manifest */
	isSystemFence?: boolean;
	/** A human input released from the queue/stash. */
	isQueuedHumanInput?: boolean;
	/**
	 * Lane the input was admitted on. Carried so the matrix can grow lane-aware
	 * rows; deliberately NOT a class mark - `_prompt` defaults `streamingBehavior`
	 * to "followUp" even for a direct prompt on an idle session, so reading the
	 * lane as "came out of the queue" would misclassify every ordinary interactive
	 * prompt as human_queued.
	 */
	streamingBehavior?: "steer" | "followUp";
	/** Allowed to exist; `classifyIncomingInput` never reads it. */
	text?: string;
}

/**
 * customType -> class, for every `*_CUSTOM_TYPE` constant the harness exports.
 * The rows are the authority for "the classifier recognizes this message shape";
 * an unlisted customType falls through to the human default, which is exactly
 * what the coverage pin in the test file refuses to let happen silently.
 *
 * `internal_continuation` doubles as the residual machine class: harness
 * receipts and bookkeeping (slash-command results, compaction and refinement
 * outcomes, kernel-state notices) are neither a human turn, nor another session's
 * message, nor scheduled, nor a fence. Parking them in `system_fence` instead
 * would put bookkeeping on the row a restart fence needs to keep clear.
 */
const CUSTOM_TYPE_INPUT_CLASSES: ReadonlyMap<string, InputClass> = new Map<string, InputClass>([
	// Agent channel. The row is the customType-only answer for a sender whose
	// relationship is unknown; `agentClassForRelationship` refines it.
	[AGENT_MESSAGE_CUSTOM_TYPE, "agent_peer_or_parent"],
	// Agent lifecycle notices aimed at this session's parent role.
	[RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE, "agent_notice"],
	[RLM_CHILD_FAILURE_CUSTOM_TYPE, "agent_notice"],
	[RLM_CHILD_STALL_NOTICE_CUSTOM_TYPE, "agent_notice"],
	// Cron/heartbeat dispatch (createHeartbeatPromptMessage).
	[HEARTBEAT_PROMPT_CUSTOM_TYPE, "scheduled"],
	// Goal continuation / budget limit / objective update, and the goal state row.
	[GOAL_CONTEXT_CUSTOM_TYPE, "internal_continuation"],
	[GOAL_STATE_CUSTOM_TYPE, "internal_continuation"],
	// Post-compaction and refinement receipts.
	[COMPACTION_OUTCOME_CUSTOM_TYPE, "internal_continuation"],
	// The cold-boundary harness digest (#2098): a harness-injected menu, never an input.
	[HARNESS_DIGEST_CUSTOM_TYPE, "internal_continuation"],
	[REFINEMENT_OUTCOME_CUSTOM_TYPE, "internal_continuation"],
	[REFINEMENT_NOTICE_CUSTOM_TYPE, "internal_continuation"],
	[REFINEMENT_CUSTOM_TYPE, "internal_continuation"],
	// One-shot recovery continuation for an exhausted empty-response ladder: machine
	// bookkeeping that wakes the session, never a human turn.
	[EMPTY_RESPONSE_RECOVERY_CUSTOM_TYPE, "internal_continuation"],
	// Harness bookkeeping receipts.
	[THINKING_LEVEL_CLAMPED_CUSTOM_TYPE, "internal_continuation"],
	[IMAGE_DELIVERY_SUSPICION_CUSTOM_TYPE, "internal_continuation"],
	[IPYTHON_STATE_RESTORED_CUSTOM_TYPE, "internal_continuation"],
	[PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE, "internal_continuation"],
	[SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE, "internal_continuation"],
	// Tool-infrastructure receipts: an MCP connection outcome and a finished
	// background command are machine records, never a human or an agent turn.
	[MCP_CONNECTION_OUTCOME_CUSTOM_TYPE, "internal_continuation"],
	[ASYNC_BASH_COMPLETION_CUSTOM_TYPE, "internal_continuation"],
	// Human by design: this record *is* the command the human typed
	// (createSessionSlashCommandMessage sets content = command.text). Ranking it
	// as a machine class would let the matrix place a human command below
	// compaction. The only human-classified customType; the test names it.
	[SESSION_SLASH_COMMAND_CUSTOM_TYPE, "human_interactive"],
]);

/** The class a customType declares on its own, or undefined when unlisted. */
export function inputClassForCustomType(customType: string | undefined): InputClass | undefined {
	if (typeof customType !== "string" || customType.length === 0) return undefined;
	return CUSTOM_TYPE_INPUT_CLASSES.get(customType);
}

/**
 * Origin of a class, exhaustive over INPUT_CLASSES: adding a class without a case
 * here is a compile error (`never` assignment) and a runtime throw if it ever
 * slips past the type checker.
 */
export function inputClassOrigin(cls: InputClass): InputClassOrigin {
	switch (cls) {
		case "human_interactive":
		case "human_queued":
			return "human";
		case "agent_child_reply":
		case "agent_peer_or_parent":
		case "agent_notice":
			return "agent";
		case "scheduled":
		case "internal_continuation":
		case "system_fence":
			return "machine";
		default: {
			const unhandled: never = cls;
			throw new Error(`Unhandled input class: ${String(unhandled)}`);
		}
	}
}

export function isHumanInputClass(cls: InputClass): boolean {
	return inputClassOrigin(cls) === "human";
}

export function isAgentInputClass(cls: InputClass): boolean {
	return inputClassOrigin(cls) === "agent";
}

/**
 * Child replies are the deferrable agent class, so demoting one requires positive
 * evidence that the sender is this session's child - the same rule
 * `isChildReplyToThisSession` uses for reply credit. An absent relationship is the
 * CLI/orchestrator steering directly (the reading `compaction/user-requests.ts`
 * already relies on), so it keeps the higher agent class.
 */
function agentClassForRelationship(fromRelationship: AgentFamilyRelationship | undefined): InputClass {
	switch (fromRelationship) {
		case "child":
			return "agent_child_reply";
		case "parent":
		case "sibling":
		case undefined:
			return "agent_peer_or_parent";
		default: {
			const unhandled: never = fromRelationship;
			throw new Error(`Unhandled agent family relationship: ${String(unhandled)}`);
		}
	}
}

function decideInputClass(facts: IncomingInputFacts): InputClass {
	const declared = inputClassForCustomType(facts.customType);
	// A declared row whose origin is human is a human mark, so it ranks below every
	// machine mark; every other declared row is a machine mark itself.
	const declaredMachineClass = declared !== undefined && inputClassOrigin(declared) !== "human" ? declared : undefined;
	switch (true) {
		// 1. Another session sent this. customType is the authority; a relationship
		//    can only come from an agent_message's details, so it is equally
		//    structural. hasAgentMessageId alone is not evidence (see its doc).
		case facts.customType === AGENT_MESSAGE_CUSTOM_TYPE:
		case facts.fromRelationship !== undefined:
			return agentClassForRelationship(facts.fromRelationship);
		// 2. A machine-classified customType outranks every human mark below: an
		//    input that carries a machine envelope and also claims an interactive
		//    source is a machine input.
		case declaredMachineClass !== undefined:
			return declaredMachineClass;
		// 3. Scheduled work.
		case facts.isHeartbeatPrompt === true:
		case facts.isCronJobPrompt === true:
			return "scheduled";
		// 4. Session-lifecycle fence (update-restart / attach / resume manifest).
		case facts.isSystemFence === true:
			return "system_fence";
		// 5. The harness continuing its own work.
		case facts.isInternalContinuation === true:
		case facts.source === INTERNAL_SOURCE:
			return "internal_continuation";
		// 6. A human input released from the queue/stash: how it arrived is more
		//    specific than the human-classified envelope it arrived in.
		case facts.isQueuedHumanInput === true:
			return "human_queued";
		// 7. A customType declared human (the slash-command record: the human's own
		//    typed command). Explicit, not the fallback below.
		case declared !== undefined:
			return declared;
		// 8. Least certain: an interactive, rpc or extension prompt, or no facts at
		//    all. Never swallow a human turn.
		default:
			return "human_interactive";
	}
}

export function classifyIncomingInput(facts: IncomingInputFacts): InputClass {
	const cls = decideInputClass(facts);
	// Second net behind the compile-time one: every result passes the exhaustive
	// origin switch, so an unhandled InputClass throws instead of reaching a
	// matrix row nobody defined.
	inputClassOrigin(cls);
	return cls;
}

/** The loosest message shape the extractor reads: envelope fields only. */
export interface IncomingInputMessageLike {
	role?: string;
	customType?: string;
	details?: unknown;
}

/** Caller-side context the message envelope cannot express. */
export interface IncomingInputMessageContext {
	/** Action source: "interactive" | "rpc" | "extension" | "internal". */
	source?: string;
	/** Agent-message delivery id, when the admission gate has one. */
	agentMessageId?: string;
	/** Lane the input was admitted on; carried into facts, never a class mark. */
	streamingBehavior?: "steer" | "followUp";
	isHeartbeatPrompt?: boolean;
	isCronJobPrompt?: boolean;
	isInternalContinuation?: boolean;
	isSystemFence?: boolean;
	isQueuedHumanInput?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readFamilyRelationship(value: unknown): AgentFamilyRelationship | undefined {
	switch (value) {
		case "parent":
		case "child":
		case "sibling":
			return value;
		default:
			return undefined;
	}
}

function readNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract classification facts from a runtime message plus the admission
 * context. Reads envelope fields only (`role`, `customType`, `details.id`,
 * `details.fromRelationship`) and never `content`: the extractor and the
 * classifier share the "text cannot forge a class" property. `text` is
 * deliberately left unset so no later reader is tempted to classify on it.
 */
export function incomingInputFactsFromMessage(
	message: CustomMessage | IncomingInputMessageLike,
	context: IncomingInputMessageContext = {},
): IncomingInputFacts {
	const customType =
		message.role === undefined || message.role === "custom" ? readNonEmptyString(message.customType) : undefined;
	const details = customType === AGENT_MESSAGE_CUSTOM_TYPE && isRecord(message.details) ? message.details : undefined;
	const fromRelationship = details ? readFamilyRelationship(details.fromRelationship) : undefined;
	const agentMessageId =
		readNonEmptyString(context.agentMessageId) ?? (details ? readNonEmptyString(details.id) : undefined);
	const facts: IncomingInputFacts = {};
	if (customType !== undefined) facts.customType = customType;
	if (fromRelationship !== undefined) facts.fromRelationship = fromRelationship;
	if (agentMessageId !== undefined) facts.hasAgentMessageId = true;
	if (context.source !== undefined) facts.source = context.source;
	if (context.streamingBehavior !== undefined) facts.streamingBehavior = context.streamingBehavior;
	if (context.isHeartbeatPrompt !== undefined) facts.isHeartbeatPrompt = context.isHeartbeatPrompt;
	if (context.isCronJobPrompt !== undefined) facts.isCronJobPrompt = context.isCronJobPrompt;
	if (context.isInternalContinuation !== undefined) facts.isInternalContinuation = context.isInternalContinuation;
	if (context.isSystemFence !== undefined) facts.isSystemFence = context.isSystemFence;
	if (context.isQueuedHumanInput !== undefined) facts.isQueuedHumanInput = context.isQueuedHumanInput;
	return facts;
}
