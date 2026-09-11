import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
}

export interface AgentSessionMessageController {
	listAgents(): AgentSessionMessageListResult | Promise<AgentSessionMessageListResult>;
	roster?(): AgentFamilyRosterResult | Promise<AgentFamilyRosterResult>;
	awaitPendingChildPublication?(selector: string): Promise<string | undefined>;
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

export function formatAgentSessionNameUnavailable(name: string, depth: number): string {
	return `Agent name "${name}" is unavailable: an agent of that name already exists at depth ${depth} under this parent`;
}

export function assertAgentSessionNameAvailable(
	catalog: readonly AgentFamilyCatalogEntry[],
	input: AgentSessionNameAvailabilityInput,
): void {
	const conflict = catalog.some(
		(entry) =>
			entry.id !== input.ignoreSessionId &&
			entry.name === input.name &&
			entry.depth === input.depth &&
			sameAgentSessionNameParent(entry, input, catalog),
	);
	if (conflict) {
		throw new Error(formatAgentSessionNameUnavailable(input.name, input.depth));
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

function sameAgentSessionNameParent(
	left: AgentSessionNameScope,
	right: AgentSessionNameScope,
	catalog: readonly AgentFamilyCatalogEntry[],
): boolean {
	if (left.depth === 0 && right.depth === 0) {
		return true;
	}
	return sameAgentFamilyParent(left, right, catalog);
}

function sameAgentFamilyParent(
	left: AgentSessionNameScope,
	right: AgentSessionNameScope,
	catalog: readonly AgentFamilyCatalogEntry[],
): boolean {
	if (left.parentSessionPath !== undefined && left.parentSessionPath === right.parentSessionPath) {
		return true;
	}
	if (left.parentSessionId !== undefined && left.parentSessionId === right.parentSessionId) {
		return true;
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
		return true;
	}
	if (
		left.depth === 0 &&
		right.depth === 0 &&
		left.parentSessionPath === undefined &&
		right.parentSessionPath === undefined &&
		left.parentSessionId === undefined &&
		right.parentSessionId === undefined
	) {
		return true;
	}
	// Unresolved mixed identifiers stay unrelated to avoid false name conflicts across families.
	return false;
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
 * Whether a failed send is worth retrying at all. Used to stop the
 * "retryable error x host vouch x model persistence" loop: after a bounded number
 * of consecutive retryable failures for the same target the caller must turn the
 * error terminal instead of offering another retry.
 */
export function isRetryableAgentMessageSendError(message: string): boolean {
	return (
		/too many pending messages/i.test(message) ||
		/rate limit exceeded/i.test(message) ||
		/queued session input is suspended/i.test(message) ||
		/Agent message was not accepted/i.test(message)
	);
}

/** Terminal replacement text once a sender has burned its retry budget (M6b). */
export function formatAgentMessageRetryExhaustedError(input: {
	target: string;
	attempts: number;
	lastError: string;
}): string {
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

export function createAgentMessageHostHandlers(
	controller: Pick<AgentSessionMessageController, "roster" | "sendAgentMessage" | "awaitPendingChildPublication">,
): Record<string, HostRequestHandler> {
	return {
		"agent_message.list_agents": async () => {
			if (!controller.roster) throw new Error("agent family roster is not available in this session");
			return (await controller.roster()) as unknown as Record<string, unknown>;
		},
		"agent_message.send": async (payload) => {
			if (typeof payload.message !== "string") {
				throw new Error("agent_message.send message must be a string");
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
				const publishedId =
					role === "child" && selector && controller.awaitPendingChildPublication
						? await controller.awaitPendingChildPublication(selector)
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
			return (await controller.sendAgentMessage({
				target,
				message: payload.message,
				receiverRole: payload.receiver_role as AgentFamilyRelationship,
			})) as unknown as Record<string, unknown>;
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
