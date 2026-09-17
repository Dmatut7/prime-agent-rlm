import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentFamilyDirectory, AgentFamilyMember, AgentFamilyRelationship } from "./agent-messages.js";

export const AGENT_OBSERVE_SKILL_NAME = "agent-observe";
export const AGENT_OBSERVE_IMPORT_NAME = "agent_observe";
export const ORCHESTRATION_HEARTBEAT_SKILL_NAME = "orchestration-heartbeat";
/** Shared cap for the message previews a roster row carries. */
export const AGENT_OBSERVE_PREVIEW_MAX_CHARS = 240;

export interface AgentObserveAgentSummary {
	/** Absent for a family member that has no live session in this daemon. */
	activeSessionId?: string;
	sessionId: string;
	sessionName?: string;
	/** Absent for the current agent: self is not one of its own family members. */
	relationship?: AgentFamilyRelationship;
	runtimeKind?: "top-level" | "subagent";
	cwd?: string;
	status: string;
	isCurrent: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	attachedClients: number;
	messageCount?: number;
	queuedCount: number;
	isSessionActive: boolean;
	repliedSinceTask?: boolean;
	parentActiveSessionId?: string;
	parentSessionId?: string;
	rlmChildId?: string;
	rlmParentNodeId?: string;
	firstMessage?: string;
	latestMessage?: AgentObserveMessagePreview;
}

export interface AgentObserveListResult {
	current: AgentObserveAgentSummary;
	agents: AgentObserveAgentSummary[];
}

export interface AgentObserveAgentSnapshot {
	agent: AgentObserveAgentSummary;
}

export interface AgentObserveRecentMessagesInput {
	target: string;
	limit?: number;
	maxChars?: number;
}

export interface AgentObserveRecentMessagesResult {
	agent: AgentObserveAgentSummary;
	messages: AgentObserveMessagePreview[];
	limit: number;
	maxChars: number;
	truncated: boolean;
}

export interface AgentObserveMessagePreview {
	index: number;
	role: string;
	timestamp?: number;
	text: string;
	truncated: boolean;
	toolCalls?: string[];
	customType?: string;
}

export interface AgentObserveController {
	listAgents(): AgentObserveListResult | Promise<AgentObserveListResult>;
	/**
	 * The one family directory behind `listAgents()`: membership and relationship for this
	 * agent's family. `agent_message`'s roster is built from this same call, so the two
	 * discovery entry points cannot disagree about who is reachable.
	 */
	familyDirectory?(): AgentFamilyDirectory | Promise<AgentFamilyDirectory>;
	getAgent(target: string): AgentObserveAgentSnapshot | Promise<AgentObserveAgentSnapshot>;
	recentMessages(
		input: AgentObserveRecentMessagesInput,
	): AgentObserveRecentMessagesResult | Promise<AgentObserveRecentMessagesResult>;
}

export function createAgentObserveHostHandlers(controller: AgentObserveController) {
	return {
		"agent_observe.list": async () => controller.listAgents() as unknown as Record<string, unknown>,
		"agent_observe.get": async (payload: Record<string, unknown> = {}) => {
			if (typeof payload.target !== "string") {
				throw new Error("agent_observe.get target must be a string");
			}
			return (await controller.getAgent(payload.target)) as unknown as Record<string, unknown>;
		},
		"agent_observe.recent": async (payload: Record<string, unknown> = {}) => {
			if (typeof payload.target !== "string") {
				throw new Error("agent_observe.recent target must be a string");
			}
			return (await controller.recentMessages({
				target: payload.target,
				limit: normalizeOptionalInteger(payload.limit, "agent_observe.recent limit"),
				maxChars: normalizeOptionalInteger(payload.max_chars ?? payload.maxChars, "agent_observe.recent max_chars"),
			})) as unknown as Record<string, unknown>;
		},
	};
}

/**
 * A family member with no live session in this daemon: only the persisted catalog facts
 * are known, so its runtime flags read false and its previews stay capped. A peer live in
 * another worker is not one of those, so it keeps the active session id its summary reports.
 */
export function createPersistedAgentObserveSummary(member: AgentFamilyMember): AgentObserveAgentSummary {
	const entry = member.entry;
	return {
		...(entry.activeSessionId ? { activeSessionId: entry.activeSessionId } : {}),
		sessionId: entry.id,
		...(entry.name ? { sessionName: entry.name } : {}),
		relationship: member.relationship,
		runtimeKind: entry.depth > 0 ? "subagent" : "top-level",
		...(entry.cwd ? { cwd: entry.cwd } : {}),
		status: entry.status,
		isCurrent: false,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		...(entry.messageCount !== undefined ? { messageCount: entry.messageCount } : {}),
		queuedCount: 0,
		isSessionActive: entry.status === "running",
		...(entry.repliedSinceTask !== undefined ? { repliedSinceTask: entry.repliedSinceTask } : {}),
		...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
		...(entry.rlmChildId ? { rlmChildId: entry.rlmChildId } : {}),
		...(entry.firstMessage ? { firstMessage: entry.firstMessage.slice(0, AGENT_OBSERVE_PREVIEW_MAX_CHARS) } : {}),
	};
}

/**
 * Render the one family directory as the observe list. A member resident in this daemon
 * keeps its live summary, annotated with the relationship a caller needs to address it;
 * every other member is reported from persisted facts only. The rows follow the directory
 * order, so the list is a snapshot of the same membership `agent_message.list_agents()`
 * returns in its legacy shape.
 */
export function createAgentObserveFamilyList(input: {
	current: AgentObserveAgentSummary;
	directory: AgentFamilyDirectory;
	/** Live summary for a member resident here, or undefined when it has no session here. */
	liveSummary?: (member: AgentFamilyMember) => AgentObserveAgentSummary | undefined;
}): AgentObserveListResult {
	return {
		current: input.current,
		agents: input.directory.members.map((member) => {
			const live = input.liveSummary?.(member);
			if (!live) return createPersistedAgentObserveSummary(member);
			return {
				...live,
				relationship: member.relationship,
				...(member.entry.repliedSinceTask !== undefined ? { repliedSinceTask: member.entry.repliedSinceTask } : {}),
			};
		}),
	};
}

export function normalizeObserveLimit(limit: number | undefined, defaultLimit = 8): number {
	return clampInteger(limit ?? defaultLimit, 1, 50, "agent_observe limit");
}

export function normalizeObserveMaxChars(maxChars: number | undefined, defaultMaxChars = 800): number {
	return clampInteger(maxChars ?? defaultMaxChars, 80, 2_000, "agent_observe max_chars");
}

export function createAgentObserveMessagePreview(
	message: AgentMessage,
	index: number,
	maxChars: number,
): AgentObserveMessagePreview {
	const text = messageText(message);
	const clipped = truncate(text, maxChars);
	const toolCalls = message.role === "assistant" ? assistantToolCalls(message) : undefined;
	return {
		index,
		role: message.role,
		...(message.timestamp ? { timestamp: message.timestamp } : {}),
		text: clipped.text,
		truncated: clipped.truncated,
		...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
		...(message.role === "custom" ? { customType: message.customType } : {}),
	};
}

function normalizeOptionalInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`${label} must be an integer when provided`);
	}
	return value;
}

function clampInteger(value: number, min: number, max: number, label: string): number {
	if (!Number.isInteger(value)) {
		throw new Error(`${label} must be an integer`);
	}
	if (value < min || value > max) {
		throw new Error(`${label} must be between ${min} and ${max}`);
	}
	return value;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}
	return { text: text.slice(0, maxChars), truncated: true };
}

function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "assistant":
			return contentText(message.content);
		case "toolResult":
			return contentText(message.content);
		case "bashExecution":
			return [message.command, message.output].filter(Boolean).join("\n");
		case "custom":
			return typeof message.content === "string" ? message.content : contentText(message.content);
		case "branchSummary":
			return message.summary;
		case "compactionSummary":
			return message.summary;
		default: {
			const exhaustive: never = message;
			return JSON.stringify(exhaustive);
		}
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block) => {
			if (!block || typeof block !== "object" || !("type" in block)) {
				return "";
			}
			if (block.type === "text" && "text" in block && typeof block.text === "string") {
				return block.text;
			}
			if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") {
				return block.thinking;
			}
			if (block.type === "image") {
				return "[image]";
			}
			if (block.type === "toolCall" && "name" in block && typeof block.name === "string") {
				return `[tool_call:${block.name}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function assistantToolCalls(message: Extract<AgentMessage, { role: "assistant" }>): string[] {
	return message.content.filter((block) => block.type === "toolCall").map((block) => block.name);
}
