import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	DEFAULT_SHORT_TARGET_WAIT_MS,
	WaitTimeoutError,
	type WaitTimeoutFacts,
	withBound,
} from "../utils/bounded-wait.js";
import type { HostRequestHandler } from "./kernel/index.js";
import type { CustomMessage } from "./messages.js";
import { HEARTBEAT_PROMPT_CUSTOM_TYPE } from "./messages.js";
import { canonicalSessionPath } from "./session-lease.js";

export const AGENT_MESSAGE_CUSTOM_TYPE = "agent_message";
export const AGENT_MESSAGE_SKILL_NAME = "agent-message";
export const AGENT_MESSAGE_IMPORT_NAME = "agent_message";
export const AGENT_MESSAGE_SOURCE = "agent_message";
export const AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL = "Agent message received";
export const DEFAULT_AGENT_MESSAGE_MAX_CHARS = 16_384;
export const DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION = 20;
export const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY = 3;
export const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS = 1000;

/** Machine-detectable marker prefixed to subagent terminal-error notices sent to the parent. */
export const SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX = "[subagent-terminal-error]";
export const SUBAGENT_TERMINAL_ERROR_SUMMARY_MAX_CHARS = 500;

/** Legacy daemon wire input accepted and ignored for compatibility. */
export type AgentSessionMessageDeliveryMode = "auto" | "steer" | "follow_up";
export type AgentSessionMessageDeliveryStatus = "delivered" | "queued";
/** Why a send was queued instead of delivered; reported back to the sender. */
export type AgentMessageQueuedReason = "target_suspended" | "target_busy";
export type AgentSessionMessageRuntimeKind = "top-level" | "subagent";
export type AgentFamilyStatus = "running" | "idle" | "inactive";
export type AgentFamilyRelationship = "parent" | "sibling" | "child";

export const AGENT_FAMILY_REACH_ERROR = "Agent reach is limited to parent, siblings, and children";

export interface AgentSessionMessageEndpoint {
	activeSessionId: string;
	sessionId: string;
	sessionName?: string;
	runtimeKind?: AgentSessionMessageRuntimeKind;
}

export interface AgentSessionMessageSender extends Partial<AgentSessionMessageEndpoint> {
	clientId?: string;
}

export type AgentMessageDirection = "received" | "sent";

/** Format the directional role/name segment shared by received and sent agent-message UI. */
export function formatAgentMessageParticipant(
	direction: AgentMessageDirection,
	role: AgentFamilyRelationship | undefined,
	endpoint: (Partial<AgentSessionMessageEndpoint> & { clientId?: string }) | null = {},
): string {
	const normalizedEndpoint = endpoint ?? {};
	const nameOrId =
		normalizedEndpoint.sessionName?.trim() ||
		normalizedEndpoint.activeSessionId?.trim() ||
		normalizedEndpoint.clientId?.trim() ||
		normalizedEndpoint.sessionId?.trim() ||
		"unknown";
	const participant = role ? `${role} ${nameOrId}` : nameOrId;
	return `${direction === "received" ? "from" : "to"} ${participant}`;
}

export interface AgentSessionMessageAgentSummary extends AgentSessionMessageEndpoint {
	cwd: string;
	isStreaming: boolean;
	unfinishedActionCount: number;
	parentActiveSessionId?: string;
	rlmChildId?: string;
	sessionDir?: string;
	sessionPath?: string;
	parentSessionId?: string;
	parentSessionPath?: string;
	rlmDepth?: number;
	status?: AgentFamilyStatus;
	rlmChildRegistryStatus?: "running" | "completed" | "deleted";
}

export interface AgentSessionMessageListResult {
	current?: AgentSessionMessageEndpoint;
	agents: AgentSessionMessageAgentSummary[];
}

export interface AgentFamilyCatalogEntry {
	id: string;
	name?: string;
	depth: number;
	status: AgentFamilyStatus;
	repliedSinceTask?: boolean;
	parentSessionId?: string;
	parentSessionPath?: string;
	sessionPath?: string;
}

export interface AgentFamilyRosterEntry {
	relationship: AgentFamilyRelationship;
	name: string;
	id: string;
	depth: number;
	status: AgentFamilyStatus;
	repliedSinceTask?: boolean;
}

export interface AgentFamilyRosterResult {
	current: { name: string; id: string; depth: number };
	entries: AgentFamilyRosterEntry[];
}

export interface AgentSessionNameScope {
	parentSessionId?: string;
	parentSessionPath?: string;
	depth: number;
}

export interface AgentSessionNameAvailabilityInput extends AgentSessionNameScope {
	name: string;
	ignoreSessionId?: string;
}

export interface AgentSessionMessagePayload {
	id: string;
	source: typeof AGENT_MESSAGE_SOURCE;
	message: string;
	from?: AgentSessionMessageSender;
	/** Sender relationship from the receiver's point of view. */
	fromRelationship?: AgentFamilyRelationship;
	target: AgentSessionMessageEndpoint;
}

export interface AgentSessionMessageDetails {
	id: string;
	message: string;
	from?: AgentSessionMessageSender;
	fromRelationship?: AgentFamilyRelationship;
	target?: AgentSessionMessageEndpoint;
}

export interface AgentSessionMessage extends CustomMessage<AgentSessionMessageDetails> {
	customType: typeof AGENT_MESSAGE_CUSTOM_TYPE;
	content: string;
	details: AgentSessionMessageDetails;
}

export interface AgentSessionMessageReceipt {
	id: string;
	source: typeof AGENT_MESSAGE_SOURCE;
	target: AgentSessionMessageEndpoint;
	from?: AgentSessionMessageSender;
	message: string;
	// Not named "status": the kernel host bridge envelope reserves that key.
	deliveryStatus: AgentSessionMessageDeliveryStatus;
	/** Present only for delivered messages: when the target context received it. */
	deliveredAt?: string;
	/** Present only for queued messages: when it was placed behind current work. */
	queuedAt?: string;
	/** Present only for queued messages: why it could not be delivered now. */
	queuedReason?: AgentMessageQueuedReason;
	/** Present only for queued messages: 1-based position in the target's queue. */
	queuedPosition?: number;
	/** How many of this sender's messages to this target are already queued and unread. */
	queuedRepeatCount?: number;
	/**
	 * Actionable consequence text for a queued delivery: what "queued" costs, how
	 * many retries are useful, and what to do instead. A bare `queued` status reads
	 * as success to a model that then waits forever.
	 */
	queuedNotice?: string;
	deliveryMode?: "steer";
}

export interface AgentSessionMessageSendInput {
	target: string;
	message: string;
	receiverRole?: AgentFamilyRelationship;
	/**
	 * The sender kernel's own id for this call, when it sent one. Exactly-once is enforced at the
	 * host boundary before delivery, so this is carried for correlation (receipts and logs), not
	 * for deduplication.
	 */
	messageId?: string;
}

export interface AgentSessionMessageController {
	listAgents(): AgentSessionMessageListResult | Promise<AgentSessionMessageListResult>;
	roster?(): AgentFamilyRosterResult | Promise<AgentFamilyRosterResult>;
	awaitPendingChildPublication?(selector: string, signal?: AbortSignal): Promise<string | undefined>;
	assertSessionNameAvailable?(input: AgentSessionNameAvailabilityInput): void | Promise<void>;
	setSessionName?(name: string): void | Promise<void>;
	sendAgentMessage(input: AgentSessionMessageSendInput): Promise<AgentSessionMessageReceipt>;
}

export interface AgentSessionMessageSafetyStatus {
	paused: boolean;
	maxMessageChars: number;
	maxPendingPerSession: number;
	rateLimitCapacity: number;
	rateLimitRefillMs: number;
}

/**
 * Structural reservation key for sibling-scoped session names. JSON encoding keeps
 * parent paths and names containing delimiter characters from colliding into one key;
 * the worker- and supervisor-side reservation maps must never diverge in encoding.
 */
export function sessionNameReservationKey(input: {
	name: string;
	depth: number;
	parentSessionId?: string;
	parentSessionPath?: string;
}): string {
	const [parentType, parentValue] =
		input.depth === 0
			? ["root", ""]
			: input.parentSessionPath
				? ["path", canonicalSessionPath(input.parentSessionPath)]
				: input.parentSessionId
					? ["id", input.parentSessionId]
					: ["root", ""];
	return JSON.stringify([input.depth, parentType, parentValue, input.name]);
}

function agentSessionNameUnavailablePrefix(name: string, depth: number): string {
	return `Agent name "${name}" is unavailable: an agent of that name already exists at depth ${depth} under this parent`;
}

/**
 * The name is held by something other than this call: a registered child, a sibling under the
 * same parent, or a reservation in another session. The two actions that resolve it are named,
 * because "unavailable" on its own reads as a transient failure worth retrying.
 */
export function formatAgentSessionNameUnavailable(name: string, depth: number): string {
	return (
		`${agentSessionNameUnavailablePrefix(name, depth)}. ` +
		"Call `await rlm.list_subagents()` to see the children already registered under this parent, " +
		"or pass a different `name=`."
	);
}

/**
 * The name collides with a same-depth sibling whose parent we could NOT compare against this
 * one's (one side records only a parent id, the other only a parent path, and the catalog cannot
 * bridge them). Unlike {@link formatAgentSessionNameUnavailable} we cannot claim the two share a
 * parent, so the copy says the parent could not be confirmed and points at the same two actions.
 */
export function formatAgentSessionNameParentUnconfirmed(name: string, depth: number): string {
	return (
		`Agent name "${name}" is unavailable: a same-depth agent of that name exists, but its ` +
		`parent could not be confirmed against this one (depth ${depth}; the two record different ` +
		"identifier shapes and the catalog cannot compare them). " +
		"Call `await rlm.list_subagents()` to see the existing children and their parents, " +
		"or pass a different `name=`."
	);
}

/**
 * The name is reserved by an admission this same session already started - the shape a retry of
 * your own `rlm()` call hits. Spawning again would create a second child for one task, so the copy
 * points at the handle that is about to exist instead of at a new name.
 */
export function formatAgentSessionNameReserved(name: string, depth: number): string {
	return (
		`${agentSessionNameUnavailablePrefix(name, depth)} - an admission for this name is already in ` +
		"flight from this session. If this is a retry of your own spawn, the child is being created " +
		"right now: call `await rlm.list_subagents()` and use the handle it returns instead of " +
		"spawning a second one."
	);
}

export function assertAgentSessionNameAvailable(
	catalog: readonly AgentFamilyCatalogEntry[],
	input: AgentSessionNameAvailabilityInput,
): void {
	let unresolvedConflict = false;
	for (const entry of catalog) {
		if (entry.id === input.ignoreSessionId || entry.name !== input.name || entry.depth !== input.depth) {
			continue;
		}
		const match = classifyAgentSessionNameParent(entry, input, catalog);
		if (match === "same") {
			throw new Error(formatAgentSessionNameUnavailable(input.name, input.depth));
		}
		if (match === "unresolved") {
			unresolvedConflict = true;
		}
	}
	if (unresolvedConflict) {
		throw new Error(formatAgentSessionNameParentUnconfirmed(input.name, input.depth));
	}
}

export function buildAgentFamilyRoster(
	current: AgentFamilyCatalogEntry,
	catalog: readonly AgentFamilyCatalogEntry[],
): AgentFamilyRosterResult {
	const parent = catalog.find((entry) => isAgentFamilyParent(entry, current));
	const siblings = catalog.filter(
		(entry) =>
			entry.id !== current.id && entry.depth === current.depth && sameAgentFamilyParent(entry, current, catalog),
	);
	const children = catalog.filter((entry) => entry.depth === current.depth + 1 && isAgentFamilyParent(current, entry));
	const row = (relationship: AgentFamilyRelationship, entry: AgentFamilyCatalogEntry): AgentFamilyRosterEntry => ({
		relationship,
		name: entry.name ?? entry.id,
		id: entry.id,
		depth: entry.depth,
		status: entry.status,
		...(relationship === "child" && entry.repliedSinceTask !== undefined
			? { repliedSinceTask: entry.repliedSinceTask }
			: {}),
	});
	return {
		current: {
			name: current.name ?? current.id,
			id: current.id,
			depth: current.depth,
		},
		entries: [
			...(parent ? [row("parent", parent)] : []),
			...siblings
				.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id))
				.map((entry) => row("sibling", entry)),
			...children.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map((entry) => row("child", entry)),
		],
	};
}

function classifyAgentSessionNameParent(
	left: AgentSessionNameScope,
	right: AgentSessionNameScope,
	catalog: readonly AgentFamilyCatalogEntry[],
): "same" | "unrelated" | "unresolved" {
	// All depth-0 sessions share the top-level naming scope regardless of parent identifiers, so
	// two roots are always a proven collision.
	if (left.depth === 0 && right.depth === 0) {
		return "same";
	}
	return classifyAgentFamilyParent(left, right, catalog);
}

/**
 * Whether two scopes could plausibly sit under the same parent.
 *
 * - "same": the parent identifiers positively match (path==path, id==id, the catalog bridges
 *   an id to a path, or both are parentless roots).
 * - "unrelated": the parent difference is proven - both sides carry the same kind of parent
 *   identifier and the values differ, or a mixed id/path pair resolves through the catalog to
 *   two different parents. A parentless non-root is also unrelated: an anonymous orphan must
 *   not collide with, or be grouped into, a named family.
 * - "unresolved": the sides carry different kinds of identifier (one id-only, one path-only)
 *   and the catalog holds no entry that lets the two be compared. This is NOT proof of an
 *   unrelated pair - it is a missing comparison.
 */
function classifyAgentFamilyParent(
	left: AgentSessionNameScope,
	right: AgentSessionNameScope,
	catalog: readonly AgentFamilyCatalogEntry[],
): "same" | "unrelated" | "unresolved" {
	if (left.parentSessionPath !== undefined && left.parentSessionPath === right.parentSessionPath) {
		return "same";
	}
	if (left.parentSessionId !== undefined && left.parentSessionId === right.parentSessionId) {
		return "same";
	}
	const hasCatalogParentPair = (parentSessionId: string | undefined, parentSessionPath: string | undefined) =>
		parentSessionId !== undefined &&
		parentSessionPath !== undefined &&
		catalog.some(
			(entry) =>
				(entry.id === parentSessionId && entry.sessionPath === parentSessionPath) ||
				(entry.parentSessionId === parentSessionId && entry.parentSessionPath === parentSessionPath),
		);
	if (
		hasCatalogParentPair(left.parentSessionId, right.parentSessionPath) ||
		hasCatalogParentPair(right.parentSessionId, left.parentSessionPath)
	) {
		return "same";
	}
	if (
		left.depth === 0 &&
		right.depth === 0 &&
		left.parentSessionPath === undefined &&
		right.parentSessionPath === undefined &&
		left.parentSessionId === undefined &&
		right.parentSessionId === undefined
	) {
		return "same";
	}
	// No positive match. Distinguish a proven difference from a comparison we could not make.
	const leftHasId = left.parentSessionId !== undefined;
	const leftHasPath = left.parentSessionPath !== undefined;
	const rightHasId = right.parentSessionId !== undefined;
	const rightHasPath = right.parentSessionPath !== undefined;
	// A side that carries NO parent identifier at all (a depth>0 orphan, or a scope whose
	// parent was never recorded) is kept unrelated ON PURPOSE, not as a gap: merging it into
	// "possibly related" would (1) make an anonymous orphan block a real named family from
	// using that name and (2) attach an unrelated orphan as a reachable sibling in the roster.
	// The mixed-identifier defect SC-4 is about is a pair where BOTH sides name a parent but in
	// incomparable shapes - that is handled as "unresolved" below. A truly absent parent on either
	// side is a product decision ("orphans do not merge into named families"), pinned by
	// test/agent-session-bus.test.ts "resolves sibling parents canonically without grouping
	// parentless non-roots" and "authorizes exactly one persisted nuclear-family edge".
	if (!(leftHasId || leftHasPath) || !(rightHasId || rightHasPath)) {
		return "unrelated";
	}
	// Same-kind identifiers present on both sides and not equal above -> proven distinct.
	if (leftHasPath && rightHasPath) {
		return "unrelated";
	}
	if (leftHasId && rightHasId) {
		return "unrelated";
	}
	// Mixed: one side is id-only, the other path-only, and the catalog bridge above failed.
	// If the id maps to a catalog session with a known path, that path differs from the other
	// side (else the bridge matched) -> proven distinct. If the id is absent from the catalog,
	// we cannot compare the two parents at all -> unresolved.
	const idOnlySide = leftHasId ? left : right;
	const resolvesInCatalog = catalog.some(
		(entry) => entry.id === idOnlySide.parentSessionId && entry.sessionPath !== undefined,
	);
	return resolvesInCatalog ? "unrelated" : "unresolved";
}

function sameAgentFamilyParent(
	left: AgentSessionNameScope,
	right: AgentSessionNameScope,
	catalog: readonly AgentFamilyCatalogEntry[],
): boolean {
	// Only a proven difference makes two scopes unrelated; an unresolved comparison is treated
	// as possibly the same parent so a same-named sibling cannot slip under the same parent.
	return classifyAgentFamilyParent(left, right, catalog) !== "unrelated";
}

function isAgentFamilyParent(parent: AgentFamilyCatalogEntry, child: AgentFamilyCatalogEntry): boolean {
	return (
		(child.parentSessionPath !== undefined && child.parentSessionPath === parent.sessionPath) ||
		(child.parentSessionId !== undefined && child.parentSessionId === parent.id)
	);
}

/** Pure nuclear-family policy over persisted parent-edge snapshots. */
export function agentFamilyRelationship(
	current: AgentFamilyCatalogEntry,
	target: AgentFamilyCatalogEntry,
): AgentFamilyRelationship | undefined {
	if (current.id === target.id) return undefined;
	if (isAgentFamilyParent(target, current)) return "parent";
	if (isAgentFamilyParent(current, target)) return "child";
	if (current.depth === target.depth && sameAgentFamilyParent(current, target, [current, target])) return "sibling";
	return undefined;
}

export function assertAgentFamilyReach(
	current: AgentFamilyCatalogEntry,
	target: AgentFamilyCatalogEntry,
): AgentFamilyRelationship {
	const relationship = agentFamilyRelationship(current, target);
	if (!relationship) throw new Error(AGENT_FAMILY_REACH_ERROR);
	return relationship;
}

export function createAgentSessionMessageId(): string {
	return `agentmsg_${randomUUID()}`;
}

export interface SubagentTerminalErrorNoticeInput {
	errorMessage?: string;
	provider?: string;
	model?: string;
	retrySummary: string;
}

/**
 * Text for the agent_message a subagent session sends to its parent when a turn
 * ends in a terminal model/provider failure (retries exhausted or the error was
 * never retryable). The parent must be able to distinguish this from a normal
 * reply, so the content carries an explicit terminal-state marker.
 */
export function formatSubagentTerminalErrorNotice(input: SubagentTerminalErrorNoticeInput): string {
	const trimmed = (input.errorMessage ?? "").trim() || "Unknown error";
	const errorSummary =
		trimmed.length > SUBAGENT_TERMINAL_ERROR_SUMMARY_MAX_CHARS
			? `${trimmed.slice(0, SUBAGENT_TERMINAL_ERROR_SUMMARY_MAX_CHARS)}…`
			: trimmed;
	const modelRef = [input.provider, input.model].filter(Boolean).join("/") || "unknown model";
	return [
		`${SUBAGENT_TERMINAL_ERROR_NOTICE_PREFIX} Terminal state: this subagent turn ended with a permanent model/provider failure; no model output was produced.`,
		`Error summary: ${errorSummary}`,
		`Model: ${modelRef}`,
		`Retry status: ${input.retrySummary}`,
		`The session is idle in needs_input. Sending another message retries the turn, but the same error will recur until the underlying cause (credentials/config/provider) is fixed.`,
	].join("\n");
}

export function normalizeAgentSessionMessage(message: string, maxChars = DEFAULT_AGENT_MESSAGE_MAX_CHARS): string {
	const trimmed = message.trim();
	if (!trimmed) {
		throw new Error("Agent session message cannot be empty");
	}
	if (trimmed.length > maxChars) {
		throw new Error(`Agent session message is too long: ${trimmed.length} chars exceeds ${maxChars}`);
	}
	return trimmed;
}

export function assertDirectAgentMessageTarget(target: string): string {
	const normalized = target.trim();
	if (!normalized) {
		throw new Error("Agent message target cannot be empty");
	}
	if (normalized === "*" || normalized.toLowerCase() === "all" || normalized.toLowerCase() === "broadcast") {
		throw new Error("Broadcast agent messaging is not supported");
	}
	return normalized;
}

/**
 * Whether an outbound agent-message receipt counts as "this subagent replied to
 * its parent" (B1).
 *
 * A `queued` receipt must not count: the parent has not seen anything yet, and
 * treating an undelivered reply as delivered makes the parent's terminal gate
 * skip its own notice - the child believes it answered, the parent never hears
 * anything, and both stay silent.
 */
export function countsAsDeliveredParentReply(input: {
	rlmDepth: number;
	deliveryStatus: AgentSessionMessageDeliveryStatus;
	addressedParent: boolean;
}): boolean {
	return input.rlmDepth > 0 && input.deliveryStatus === "delivered" && input.addressedParent;
}

/**
 * Whether an inbound agent message is a subagent's reply to *this* session, i.e. a
 * message whose delivery has to be credited back to its sender.
 *
 * This is the receiving half of {@link countsAsDeliveredParentReply}. A `queued`
 * receipt leaves the sender unable to count its own reply - correctly, because the
 * queue may never drain - and the receiving session is the only one that sees the
 * moment it does. Without the credit the reply never counts at all, and a child
 * that answered a busy parent is reported as "completed without sending a reply".
 *
 * The sender's session id is required: it is the key the credit is delivered on,
 * and a message that cannot name its sender cannot be credited to anyone.
 */
export function isChildReplyToThisSession(input: {
	fromRelationship: AgentFamilyRelationship | undefined;
	senderSessionId: string | undefined;
}): boolean {
	return (
		input.fromRelationship === "child" &&
		typeof input.senderSessionId === "string" &&
		input.senderSessionId.trim().length > 0
	);
}

/**
 * Cap for {@link QueuedParentReplyBackfills}. Far above the per-session pending
 * message limit, so eviction is a leak guard and not a normal path.
 */
export const QUEUED_PARENT_REPLY_BACKFILL_LIMIT = 64;

/**
 * Child replies this session accepted into its queue but has not delivered yet,
 * keyed by message id with the sender's session id as the value.
 *
 * Registering on the queued admission and taking on delivery is what keeps the
 * credit exactly once: a synchronously delivered reply is counted by its sender
 * and is never registered here, and `take` hands an id out only once. A queued
 * reply that is dropped instead of delivered is simply never taken, which is the
 * B1 answer - an undelivered reply does not count.
 */
export class QueuedParentReplyBackfills {
	private readonly senderSessionIds = new Map<string, string>();

	constructor(private readonly limit: number = QUEUED_PARENT_REPLY_BACKFILL_LIMIT) {}

	/** Record a queued child reply. Re-registering an id refreshes it. */
	register(messageId: string, senderSessionId: string): void {
		this.senderSessionIds.delete(messageId);
		this.senderSessionIds.set(messageId, senderSessionId);
		const limit = Math.max(1, this.limit);
		while (this.senderSessionIds.size > limit) {
			const oldest = this.senderSessionIds.keys().next().value;
			if (oldest === undefined) break;
			this.senderSessionIds.delete(oldest);
		}
	}

	/**
	 * Drop every credit still owed to one sender, returning how many were dropped.
	 *
	 * Used at a run boundary: a reply the previous run left in the queue belongs to
	 * that run's verdict, which has already been delivered, so letting it land on the
	 * new run's baseline would report a silent child as one that replied.
	 */
	discardForSender(senderSessionId: string): number {
		let dropped = 0;
		for (const [messageId, sender] of this.senderSessionIds) {
			if (sender !== senderSessionId) continue;
			this.senderSessionIds.delete(messageId);
			dropped += 1;
		}
		return dropped;
	}

	/**
	 * Ids this session still owes a delivery credit for, for one sender.
	 *
	 * Read at verdict time: a run whose reply is in this list has a reply the parent
	 * has accepted but not read yet, so its no-reply notice is provisional until the
	 * queue settles the question. Peeking must not consume - `take` stays the only
	 * way an id leaves the ledger, which is what keeps the credit exactly once.
	 */
	owedMessageIdsForSender(senderSessionId: string): string[] {
		const owed: string[] = [];
		for (const [messageId, sender] of this.senderSessionIds) {
			if (sender === senderSessionId) owed.push(messageId);
		}
		return owed;
	}

	/**
	 * The sender of a queued reply that has now been delivered, or undefined for an
	 * id this session never queued (a direct delivery) or already credited.
	 */
	take(messageId: string): string | undefined {
		const senderSessionId = this.senderSessionIds.get(messageId);
		if (senderSessionId === undefined) return undefined;
		this.senderSessionIds.delete(messageId);
		return senderSessionId;
	}

	get size(): number {
		return this.senderSessionIds.size;
	}

	clear(): void {
		this.senderSessionIds.clear();
	}
}

export function assertAgentMessageQueueCapacity(
	unfinishedActionCount: number,
	maxPending = DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
): void {
	if (unfinishedActionCount >= maxPending) {
		// Actionable on purpose (L10.2): the sender must be able to tell that the
		// message was neither queued nor lost, and what to do instead of hammering.
		throw new Error(
			`Target session has too many pending messages: ${unfinishedActionCount} unfinished, limit is ${maxPending}. ` +
				"This message was NOT queued and NOT delivered - nothing was lost on your side. Do not retry immediately: " +
				"wait for the target to drain its queue, or write your result to a file and end the turn.",
		);
	}
}

export function parseAgentSessionMessagePromptId(text: string): string | undefined {
	const lines = text.split("\n");
	const offset = lines[0]?.startsWith("[from ") ? 1 : 0;
	if (
		lines[offset] !== "Agent-to-agent message received." ||
		lines[offset + 1] !== `Source: ${AGENT_MESSAGE_SOURCE}`
	) {
		return undefined;
	}
	const toLineIndex = lines[offset + 2]?.startsWith("From: ") ? offset + 3 : offset + 2;
	if (!lines[toLineIndex]?.startsWith("To: ")) {
		return undefined;
	}
	const match = /^Message id: (agentmsg_[^\n]+)$/.exec(lines[toLineIndex + 1] ?? "");
	return match?.[1];
}

export function isAgentSessionMessagePrompt(text: string): boolean {
	return parseAgentSessionMessagePromptId(text) !== undefined;
}

export function createAgentSessionMessagePrompt(payload: AgentSessionMessagePayload): string {
	const relationshipLabel = payload.fromRelationship
		? `[from ${payload.fromRelationship}${payload.fromRelationship === "parent" ? "" : `:${formatAgentSessionMessageMetadata(payload.from?.sessionName ?? payload.from?.sessionId ?? payload.from?.activeSessionId ?? "unknown")}`}]`
		: undefined;
	const lines = [
		...(relationshipLabel ? [relationshipLabel] : []),
		"Agent-to-agent message received.",
		`Source: ${payload.source}`,
	];
	if (payload.from) {
		lines.push(`From: ${formatAgentSessionMessageSender(payload.from)}`);
	}
	lines.push(`To: ${formatAgentSessionMessageEndpoint(payload.target)}`);
	lines.push(`Message id: ${payload.id}`);
	lines.push("");
	lines.push(payload.message);
	return lines.join("\n");
}

export function createAgentSessionMessage(
	payload: AgentSessionMessagePayload,
	timestamp = Date.now(),
): AgentSessionMessage {
	return {
		role: "custom",
		customType: AGENT_MESSAGE_CUSTOM_TYPE,
		content: createAgentSessionMessagePrompt(payload),
		display: true,
		details: {
			id: payload.id,
			message: payload.message,
			from: payload.from,
			fromRelationship: payload.fromRelationship,
			target: payload.target,
		},
		timestamp,
	};
}

export function isAgentSessionMessage(message: AgentMessage): message is AgentSessionMessage {
	if (message.role !== "custom" || message.customType !== AGENT_MESSAGE_CUSTOM_TYPE) {
		return false;
	}
	const details = message.details;
	return (
		typeof details === "object" &&
		details !== null &&
		typeof (details as { id?: unknown }).id === "string" &&
		typeof (details as { message?: unknown }).message === "string"
	);
}

// A message that starts a new agent run (prompt-turn boundary).
export function startsAgentRun(message: AgentMessage): boolean {
	return (
		message.role === "user" ||
		isAgentSessionMessage(message) ||
		(message.role === "custom" && message.customType === HEARTBEAT_PROMPT_CUSTOM_TYPE)
	);
}

export interface AgentSessionMessageQueuedFacts {
	reason?: AgentMessageQueuedReason;
	position?: number;
	repeatCount?: number;
	notice?: string;
}

export function createAgentSessionMessageReceipt(
	payload: AgentSessionMessagePayload,
	status: AgentSessionMessageDeliveryStatus,
	at = new Date().toISOString(),
	queued?: AgentSessionMessageQueuedFacts,
): AgentSessionMessageReceipt {
	return {
		id: payload.id,
		source: payload.source,
		target: payload.target,
		from: payload.from,
		message: payload.message,
		deliveryStatus: status,
		...(status === "delivered" ? { deliveredAt: at } : { queuedAt: at }),
		...(status === "queued" && queued?.reason ? { queuedReason: queued.reason } : {}),
		...(status === "queued" && queued?.position !== undefined ? { queuedPosition: queued.position } : {}),
		...(status === "queued" && queued?.repeatCount !== undefined ? { queuedRepeatCount: queued.repeatCount } : {}),
		...(status === "queued" && queued?.notice ? { queuedNotice: queued.notice } : {}),
		deliveryMode: "steer",
	};
}

/**
 * Consequence-bearing text for a queued send (M5). States that nothing was
 * delivered, how full the target's queue is, and - from the second queued send on -
 * that the previous one is still unread, which is the fact that should stop a model
 * from looping.
 */
export function formatAgentMessageQueuedNotice(input: {
	reason?: AgentMessageQueuedReason;
	position?: number;
	maxPending: number;
	repeatCount: number;
	previousQueuedSecondsAgo?: number;
}): string {
	const why =
		input.reason === "target_suspended"
			? "the target session is suspended (its turn was aborted), so nothing is reading right now"
			: "the target session is busy with its current turn";
	const position =
		input.position !== undefined
			? ` Position ${input.position}/${input.maxPending}.`
			: ` Queue limit ${input.maxPending}.`;
	const repeat =
		input.repeatCount > 1
			? ` This is the ${input.repeatCount}nd time in a row your message to this target ended up queued, and the earlier one is still unread${
					input.previousQueuedSecondsAgo !== undefined ? ` (queued ${input.previousQueuedSecondsAgo}s ago)` : ""
				}.`
			: "";
	return (
		`Queued, NOT delivered:${" "}${why}.${position}${repeat}` +
		" The message is not lost. Do not retry immediately - retrying only adds another copy and is refused once the queue is full." +
		" If you need an answer from this target, write your result to a file and end the turn instead of waiting."
	);
}

/**
 * What a failed send's message text can prove. The typed contract lives in
 * prompt-admission.ts (`deliveredNothing` / `retryNowSucceeds`), but a
 * cross-process send surfaces only the message string, so this classifier is
 * the *decoder* of that contract's serialized form - not a second authority.
 *
 * - `deliveredNothing` (a): every pattern here is a refusal the host raises
 *   *before* handing the message to the target (a full queue, the rate
 *   limiter, a suspended or fenced pump, a refused admission, or one of the
 *   bounded pre-delivery waits). Anything else that fails the delivery leg
 *   leaves the outcome unknown, and unknown has to be treated as
 *   possibly-delivered - the duplicate-delivery window the id gate fails
 *   closed on. Adding a pattern here therefore also claims "this failure
 *   never delivered"; only add one when that is true.
 * - `retryNowSucceeds` (b): decoded only where the serialized form carries it
 *   (the Suspended `retryable=` token and fence sentence, the paused
 *   teardown append) and `undefined` everywhere else. `undefined` means
 *   "this shape cannot answer (b)" and must not be guessed: the M6b terminal
 *   guidance differs between "retry later" and "resend after the restart".
 */
export interface AgentMessageSendFailureClassification {
	deliveredNothing: boolean;
	retryNowSucceeds: boolean | undefined;
}

export function classifyAgentMessageSendFailureByMessage(message: string): AgentMessageSendFailureClassification {
	// Suspended serializes (b): the fence sentence is the named false source,
	// the `retryable=` token carries the field value (token name is frozen
	// history; it serializes retryNowSucceeds). A bare prefix without either
	// cannot answer (b).
	if (/queued session input is suspended/i.test(message)) {
		const retryable = /\bretryable=(true|false)\b/i.exec(message)?.[1]?.toLowerCase();
		return {
			deliveredNothing: true,
			retryNowSucceeds: retryable === undefined ? undefined : retryable === "true",
		};
	}
	// Paused serializes (b) only for the update-restart teardown lease: the
	// ordinary lease releases, the teardown one only a restart releases.
	if (/session input admission is paused/i.test(message)) {
		return { deliveredNothing: true, retryNowSucceeds: !/update-restart teardown/i.test(message) };
	}
	// QP-3 (r39): a same-key duplicate arrived while its owner was committing;
	// refused before delivery, retrying after the turn ends is correct.
	if (/equivalent follow-up.*is already committing/i.test(message)) {
		return { deliveredNothing: true, retryNowSucceeds: true };
	}
	if (
		/too many pending messages/i.test(message) ||
		/rate limit exceeded/i.test(message) ||
		/Agent message was not accepted/i.test(message) ||
		// A bounded wait (P1-1) that ran out of time: the target is mid-transition, nothing was
		// cancelled, and the same call joins the in-flight operation instead of starting a second
		// one. Counting it here is what gives the new retryable errors a mechanical ceiling -
		// three in a row for one target turn terminal (M6b).
		/wait timed out/i.test(message)
	) {
		return { deliveredNothing: true, retryNowSucceeds: undefined };
	}
	return { deliveredNothing: false, retryNowSucceeds: undefined };
}

/**
 * Terminal replacement text once a sender has burned its retry budget (M6b).
 * `fenced` marks the (b)=false shape: the target is behind an update-restart
 * fence, so the guidance is to persist and resend after the restart instead of
 * the generic "write a file and move on".
 */
export function formatAgentMessageRetryExhaustedError(input: {
	target: string;
	attempts: number;
	lastError: string;
	fenced?: boolean;
}): string {
	if (input.fenced) {
		return (
			`Agent messaging to ${input.target} failed ${input.attempts} times in a row (last: ${input.lastError}). ` +
			"The target is fenced for an update-restart: Nothing was delivered, and retrying in this process cannot succeed. " +
			"Do not call agent_message.send again for this target in this turn: persist your result (write it to a file or end the turn) and resend it after the restart."
		);
	}
	return (
		`Agent messaging to ${input.target} failed ${input.attempts} times in a row (last: ${input.lastError}). ` +
		"This error is terminal, not retryable: do not call agent_message.send again for this target in this turn. " +
		"Nothing was delivered. Write the result to a file or end the turn so the recipient can pick it up later."
	);
}

export interface AgentSessionMessageRateLimiterOptions {
	capacity?: number;
	refillMs?: number;
	now?: () => number;
}

export class AgentSessionMessageRateLimiter {
	private readonly capacity: number;
	private readonly refillMs: number;
	private readonly now: () => number;
	private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

	constructor(options: AgentSessionMessageRateLimiterOptions = {}) {
		this.capacity = options.capacity ?? DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY;
		this.refillMs = options.refillMs ?? DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS;
		this.now = options.now ?? (() => Date.now());
	}

	tryConsume(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
		const now = this.now();
		const bucket = this.buckets.get(key) ?? {
			tokens: this.capacity,
			updatedAt: now,
		};
		const elapsed = Math.max(0, now - bucket.updatedAt);
		const refilledTokens = Math.floor(elapsed / this.refillMs);
		if (refilledTokens > 0) {
			bucket.tokens = Math.min(this.capacity, bucket.tokens + refilledTokens);
			bucket.updatedAt += refilledTokens * this.refillMs;
		}
		if (bucket.tokens <= 0) {
			this.buckets.set(key, bucket);
			return {
				ok: false,
				retryAfterMs: Math.max(1, bucket.updatedAt + this.refillMs - now),
			};
		}
		bucket.tokens -= 1;
		this.buckets.set(key, bucket);
		return { ok: true };
	}

	refund(key: string): void {
		const bucket = this.buckets.get(key);
		if (!bucket) {
			return;
		}
		bucket.tokens = Math.min(this.capacity, bucket.tokens + 1);
		this.buckets.set(key, bucket);
	}

	clear(key?: string): void {
		if (key) {
			this.buckets.delete(key);
			return;
		}
		this.buckets.clear();
	}

	clearMatching(predicate: (key: string) => boolean): void {
		for (const key of this.buckets.keys()) {
			if (predicate(key)) {
				this.buckets.delete(key);
			}
		}
	}
}

export interface AgentMessageHostHandlerOptions {
	/**
	 * Bound on waiting for an in-flight child to publish its session. Default
	 * {@link DEFAULT_SHORT_TARGET_WAIT_MS}; `Infinity` (the settings rollback lever) waits
	 * forever, which is today's behaviour.
	 */
	publicationWaitMs?: number;
	/** Every timed-out wait, for the countable `agent message target wait timed out` signature. */
	onWaitTimeout?: (facts: WaitTimeoutFacts) => void;
	/**
	 * Exactly-once gate for sender-minted message ids; a fresh one is created per handler set, so
	 * the gate lives exactly as long as the session runtime that registered it.
	 */
	handledMessageIds?: HandledAgentMessageIds;
	/** Every suppressed duplicate, for the countable `agent message duplicate suppressed` line. */
	onDuplicateSuppressed?: (info: { messageId: string; record: HandledAgentMessageRecord }) => void;
}

/** How many delivered message ids one session remembers for exactly-once delivery (C15). */
export const HANDLED_AGENT_MESSAGE_ID_LIMIT = 1024;

/**
 * What the host knows about the first attempt for one message id.
 *
 * `uncertain` is the interesting one: the delivery leg ran and then failed to report back, so the
 * message may or may not have reached the target. That is the duplicate-delivery window, and it is
 * answered by refusing the resend rather than by guessing.
 */
export type HandledAgentMessageOutcome = AgentSessionMessageDeliveryStatus | "uncertain";

/** What one handled id is worth remembering: enough to answer a duplicate, never the payload. */
export interface HandledAgentMessageRecord {
	outcome: HandledAgentMessageOutcome;
	/** Active session id the message went to, when the send resolved one. */
	target?: string;
	/** Epoch ms of the attempt. */
	at: number;
}

/**
 * Receiver-side exactly-once for agent messages (C15, first half).
 *
 * The sender's kernel mints one `message_id` per `send()` call, so an id that arrives twice is a
 * repeat of one call: a transport-level duplicate, or a retry of a call whose reply was lost -
 * which is exactly what a kernel death or a bounded wait produces. Delivering it a second time is
 * the failure that makes a model's retry dangerous.
 *
 * This is the half of idempotence that needs no content key. Two *different* calls carrying the
 * same text still mint two ids and both are delivered, so the legitimate "say the same thing to
 * two agents" (or twice, deliberately) is not taken away; only a repeat of one call is suppressed.
 *
 * Records stay compact (status, target, timestamp) so 1024 of them cost nothing, and eviction
 * degrades to today's behaviour - a duplicate might slip through - rather than to a wrong answer.
 * In memory only: a restarted host has no ids to repeat, because the kernel that minted them is
 * gone with it.
 */
export class HandledAgentMessageIds {
	private readonly records = new Map<string, HandledAgentMessageRecord>();

	constructor(private readonly limit: number = HANDLED_AGENT_MESSAGE_ID_LIMIT) {}

	/** The record for an id already handled, or undefined. A hit refreshes the id's recency. */
	find(id: string): HandledAgentMessageRecord | undefined {
		const record = this.records.get(id);
		if (!record) return undefined;
		this.records.delete(id);
		this.records.set(id, record);
		return record;
	}

	/** Remember one delivered id, evicting the least recently handled beyond the limit. */
	record(id: string, entry: HandledAgentMessageRecord): void {
		this.records.delete(id);
		this.records.set(id, entry);
		const limit = Math.max(1, this.limit);
		while (this.records.size > limit) {
			const oldest = this.records.keys().next().value;
			if (oldest === undefined) break;
			this.records.delete(oldest);
		}
	}

	get size(): number {
		return this.records.size;
	}
}

/**
 * The reply for a `message_id` this session already handled. Shaped like a receipt so the sending
 * skill renders it without a special case, but it says plainly that nothing was delivered again:
 * a model that retried because it never saw a receipt needs to know the first send worked.
 */
export function formatDuplicateAgentMessageReply(input: {
	messageId: string;
	record: HandledAgentMessageRecord;
}): Record<string, unknown> {
	const { record } = input;
	return {
		id: input.messageId,
		duplicateSuppressed: true,
		deliveryStatus: record.outcome === "uncertain" ? undefined : record.outcome,
		...(record.target === undefined ? {} : { target: { activeSessionId: record.target, sessionId: record.target } }),
		notice:
			`This message_id was already handled at ${new Date(record.at).toISOString()} and was ${record.outcome} then, ` +
			"so it was NOT delivered again. Nothing is lost and nothing is duplicated. If you retried because " +
			"you never saw a receipt, the first send is the one that counted: check with the recipient (or read " +
			"its transcript with agent_observe) instead of sending again.",
	};
}

/**
 * The fail-closed answer to resending an id whose first attempt ended with an unknown outcome.
 *
 * This is an error, not a receipt: a receipt shape would let a model read "delivered" or "queued"
 * into it, and the whole point is that the host does not know. It is deliberately terminal for this
 * id (so the retry gate cannot be talked into looping on it) and it names the two ways out - verify
 * with the recipient, or send a genuinely new message, which mints a new id and is not blocked.
 */
export function formatUncertainAgentMessageResendError(input: {
	messageId: string;
	record: HandledAgentMessageRecord;
}): string {
	const { record } = input;
	const target = record.target === undefined ? "the recipient" : `the recipient (${record.target})`;
	return (
		`Refusing to resend message_id ${input.messageId}: the earlier attempt at ${new Date(record.at).toISOString()} ` +
		"failed after the message had been handed to the delivery leg, so the host cannot tell whether it arrived - " +
		"and it may have. This call delivered nothing and the message is not delivered again by retrying it; the same " +
		`refusal will answer every further attempt with this id. Find out first: ask ${target}, or read its transcript ` +
		"with agent_observe.recent. If it genuinely did not arrive, send a new message - a fresh send() call mints a new " +
		`message_id and is not blocked. This error is terminal for ${input.messageId}, not something to retry.`
	);
}

export function createAgentMessageHostHandlers(
	controller: Pick<AgentSessionMessageController, "roster" | "sendAgentMessage" | "awaitPendingChildPublication">,
	options: AgentMessageHostHandlerOptions = {},
): Record<string, HostRequestHandler> {
	const publicationWaitMs = options.publicationWaitMs ?? DEFAULT_SHORT_TARGET_WAIT_MS;
	const handled = options.handledMessageIds ?? new HandledAgentMessageIds();
	/** Sender-minted id of this call, when the kernel is new enough to send one. */
	const messageIdOf = (payload: Record<string, unknown>): string | undefined =>
		typeof payload.message_id === "string" && payload.message_id.length > 0 ? payload.message_id : undefined;
	const remember = (messageId: string | undefined, outcome: HandledAgentMessageOutcome, target?: string): void => {
		if (messageId === undefined) return;
		handled.record(messageId, {
			outcome,
			...(target === undefined ? {} : { target }),
			at: Date.now(),
		});
	};
	/**
	 * What a failed delivery leg leaves behind. A refusal the host raised before handing the
	 * message over provably delivered nothing, so the id stays unspent and the retry that is the
	 * correct action still works. Anything else (a worker request that timed out, a connection
	 * that dropped, a kernel that died between the write and the reply) leaves the outcome
	 * unknown, and unknown is spent: a resend of that id is refused until the sender has checked.
	 */
	const rememberFailure = (messageId: string | undefined, error: unknown, target?: string): void => {
		if (messageId === undefined) return;
		const message = error instanceof Error ? error.message : String(error);
		// Only (a) decides whether the id is spent: a provably pre-delivery
		// refusal leaves it unspent so the correct resend still works. Whether a
		// retry can succeed now ((b)) is not this ledger's question.
		if (classifyAgentMessageSendFailureByMessage(message).deliveredNothing) return;
		remember(messageId, "uncertain", target);
	};
	return {
		// Read-only, so it is on the cancellable list: a cell abort releases the wait instead of
		// leaving it parked until the kernel host tears down (P1-2a).
		"agent_message.list_agents": async (_payload, signal) => {
			if (!controller.roster) throw new Error("agent family roster is not available in this session");
			signal?.throwIfAborted();
			return (await controller.roster()) as unknown as Record<string, unknown>;
		},
		"agent_message.send": async (payload, signal) => {
			if (typeof payload.message !== "string") {
				throw new Error("agent_message.send message must be a string");
			}
			// Checked before anything else: a repeat of one call must not resolve a roster, wait on
			// a publication, or deliver a second copy (C15).
			const messageId = messageIdOf(payload);
			if (messageId !== undefined) {
				const duplicate = handled.find(messageId);
				if (duplicate) {
					options.onDuplicateSuppressed?.({ messageId, record: duplicate });
					if (duplicate.outcome === "uncertain") {
						throw new Error(formatUncertainAgentMessageResendError({ messageId, record: duplicate }));
					}
					return formatDuplicateAgentMessageReply({ messageId, record: duplicate });
				}
			}
			let target: string;
			if (typeof payload.target === "string") {
				if (payload.target !== "all") {
					throw new Error(
						"positional agent_message.send targets are not supported; use receiver_role and receiver_name",
					);
				}
				if (payload.receiver_role !== undefined || payload.receiver_name !== undefined) {
					throw new Error("agent_message.send broadcast cannot be combined with receiver_role/receiver_name");
				}
				if (!controller.roster) throw new Error("agent family roster is not available in this session");
				const roster = await controller.roster();
				const results = await Promise.allSettled(
					roster.entries.map((entry) =>
						controller.sendAgentMessage({
							target: entry.id,
							message: payload.message as string,
							receiverRole: entry.relationship,
						}),
					),
				);
				const receipts = results.map((result, index) =>
					result.status === "fulfilled"
						? result.value
						: {
								target: roster.entries[index]!.id,
								error: result.reason instanceof Error ? result.reason.message : String(result.reason),
							},
				);
				// One id per call, so a broadcast is remembered once. A rejection the host raised
				// before handing that leg over provably delivered nothing; any other rejection
				// leaves that leg's outcome unknown, and unknown spends the id.
				const uncertain = results.some(
					(result) =>
						result.status === "rejected" &&
						!classifyAgentMessageSendFailureByMessage(
							result.reason instanceof Error ? result.reason.message : String(result.reason),
						).deliveredNothing,
				);
				remember(
					messageId,
					uncertain
						? "uncertain"
						: results.every(
									(result) => result.status === "fulfilled" && result.value.deliveryStatus === "delivered",
								)
							? "delivered"
							: "queued",
				);
				return { receipts } as unknown as Record<string, unknown>;
			} else {
				const role = payload.receiver_role;
				if (role !== "parent" && role !== "sibling" && role !== "child") {
					throw new Error('agent_message.send receiver_role must be "parent", "sibling", or "child"');
				}
				const receiverName = payload.receiver_name;
				if (role === "parent" && receiverName !== undefined && receiverName !== null) {
					throw new Error("agent_message.send receiver_name must be omitted for parent messages");
				}
				if (role !== "parent" && (typeof receiverName !== "string" || !receiverName.trim())) {
					throw new Error("agent_message.send receiver_name is required for sibling and child messages");
				}
				if (!controller.roster) throw new Error("agent family roster is not available in this session");
				const selector = typeof receiverName === "string" ? receiverName.trim() : undefined;
				// Bounded (P1-1): a child whose publication never settles used to park this cell
				// for as long as the parent turn lived. The bound does not cancel the publication
				// - it keeps running - and on timeout the send falls through to the roster match,
				// which either finds the child or fails with an actionable "no child matches".
				const publishedId =
					role === "child" && selector && controller.awaitPendingChildPublication
						? await withBound(controller.awaitPendingChildPublication(selector, signal), {
								timeoutMs: publicationWaitMs,
								phase: "publication",
								target: selector,
								label: "Agent message target",
								targetState: () => `child ${selector} has not published its session yet`,
								...(signal ? { signal } : {}),
								...(options.onWaitTimeout ? { onTimeout: options.onWaitTimeout } : {}),
							}).catch((error: unknown) => {
								if (error instanceof WaitTimeoutError) return undefined;
								throw error;
							})
						: undefined;
				const roster = await controller.roster();
				const matches = roster.entries.filter(
					(entry) =>
						entry.relationship === role &&
						(role === "parent" || entry.name === selector || entry.id === selector || entry.id === publishedId),
				);
				if (matches.length !== 1) {
					throw new Error(
						matches.length === 0
							? `No ${role} matches ${role === "parent" ? "the current agent" : JSON.stringify(receiverName)}`
							: `${role} selector ${JSON.stringify(receiverName)} is ambiguous`,
					);
				}
				target = matches[0]!.id;
			}
			let receipt: AgentSessionMessageReceipt;
			try {
				receipt = await controller.sendAgentMessage({
					target,
					message: payload.message,
					receiverRole: payload.receiver_role as AgentFamilyRelationship,
					...(messageId === undefined ? {} : { messageId }),
				});
			} catch (error) {
				// The delivery leg itself failed. It may have landed and only the answer was lost,
				// which is the duplicate-delivery window: spend the id unless the error is one of
				// the host's own pre-delivery refusals.
				rememberFailure(messageId, error, target);
				throw error;
			}
			remember(messageId, receipt.deliveryStatus, receipt.target?.activeSessionId ?? target);
			return receipt as unknown as Record<string, unknown>;
		},
	};
}

function formatAgentSessionMessageMetadata(value: string): string {
	return value.replace(/[\s,[\]]+/g, " ").trim();
}

function formatAgentSessionMessageSender(sender: AgentSessionMessageSender): string {
	const parts: string[] = [];
	if (sender.sessionName) {
		const sessionName = formatAgentSessionMessageMetadata(sender.sessionName);
		if (sessionName) {
			parts.push(sessionName);
		}
	}
	if (sender.activeSessionId) {
		parts.push(`active ${formatAgentSessionMessageMetadata(sender.activeSessionId)}`);
	}
	if (sender.sessionId) {
		parts.push(`session ${formatAgentSessionMessageMetadata(sender.sessionId)}`);
	}
	if (sender.clientId) {
		parts.push(`client ${formatAgentSessionMessageMetadata(sender.clientId)}`);
	}
	return parts.length > 0 ? parts.join(", ") : "unknown sender";
}

function formatAgentSessionMessageEndpoint(endpoint: AgentSessionMessageEndpoint): string {
	const name = endpoint.sessionName ? `${formatAgentSessionMessageMetadata(endpoint.sessionName)}, ` : "";
	return `${name}active ${formatAgentSessionMessageMetadata(endpoint.activeSessionId)}, session ${formatAgentSessionMessageMetadata(endpoint.sessionId)}`;
}
