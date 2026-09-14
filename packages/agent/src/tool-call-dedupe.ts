/**
 * Deterministic de-duplication of tool call ids inside one assistant message.
 *
 * Providers are not required to keep tool call ids unique, and this chain cannot
 * repair a collision after the fact: both calls execute and both results carry the
 * reused id, every consumer that pairs calls with results by id (UI rows, stall
 * bookkeeping, the next request body) has to guess, and the wire ends up with two
 * tool_use blocks and two tool_result blocks sharing one id, which is undecidable.
 * So the loop makes the ids unique on the way in and reports what it changed.
 *
 * The first occurrence keeps its id; each later collision gets a `__dupN` suffix,
 * with N bumped until the id is unused among the ids assigned so far in the message.
 * Assignment is strictly left to right, so the id a call gets never changes when
 * more content streams in behind it.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Longest id {@link deduplicateToolCallIds} will produce.
 *
 * Providers truncate outbound ids (64 chars for anthropic/bedrock/google, 40 for
 * OpenAI) when they normalize them, so a suffix appended past the truncation point
 * would be cut off and the id would collide again on the wire. 40 is the tightest
 * of those bounds. The suffix is built from `[a-z0-9_]`, which no observed
 * normalization rewrites.
 */
export const MAX_DEDUPLICATED_TOOL_CALL_ID_LENGTH = 40;

/** Base for a deduplicated id whose original is empty; an empty id is not addressable. */
const EMPTY_ID_BASE = "toolcall";

/** One reused tool call id that was rewritten, with enough context to find the call. */
export interface ToolCallIdCollision {
	/** The id as it arrived from the provider. */
	originalId: string;
	/** The unique id this call now carries. */
	deduplicatedId: string;
	/** Name of the tool the call was for. */
	toolName: string;
	/** Position of the call within the assistant message content. */
	contentIndex: number;
	/** 1-based count of how many times `originalId` appeared up to this call. */
	occurrence: number;
}

export interface ToolCallIdDedupeResult {
	/** The message content with unique tool call ids; the input array when nothing collided. */
	content: AssistantMessage["content"];
	/** Collisions found, in content order; empty when the ids were already unique. */
	collisions: ToolCallIdCollision[];
}

function uniqueDeduplicatedId(originalId: string, used: ReadonlySet<string>): string {
	const base = originalId.trim().length > 0 ? originalId : EMPTY_ID_BASE;
	for (let duplicate = 2; ; duplicate += 1) {
		const suffix = `__dup${duplicate}`;
		const room = Math.max(1, MAX_DEDUPLICATED_TOOL_CALL_ID_LENGTH - suffix.length);
		const candidate = `${base.length > room ? base.slice(0, room) : base}${suffix}`;
		if (!used.has(candidate)) {
			return candidate;
		}
	}
}

/** Rewrites every repeated tool call id in `content` to a unique, stable id. */
export function deduplicateToolCallIds(content: AssistantMessage["content"]): ToolCallIdDedupeResult {
	const used = new Set<string>();
	const occurrences = new Map<string, number>();
	let rewritten: AssistantMessage["content"] | undefined;
	let collisions: ToolCallIdCollision[] | undefined;

	for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
		const part = content[contentIndex]!;
		if (part.type !== "toolCall") {
			continue;
		}
		const occurrence = (occurrences.get(part.id) ?? 0) + 1;
		occurrences.set(part.id, occurrence);
		if (!used.has(part.id)) {
			used.add(part.id);
			continue;
		}
		const deduplicatedId = uniqueDeduplicatedId(part.id, used);
		used.add(deduplicatedId);
		rewritten ??= content.slice();
		rewritten[contentIndex] = { ...part, id: deduplicatedId };
		collisions ??= [];
		collisions.push({ originalId: part.id, deduplicatedId, toolName: part.name, contentIndex, occurrence });
	}

	if (!rewritten || !collisions) {
		return { content, collisions: [] };
	}
	return { content: rewritten, collisions };
}

/**
 * Reads the collisions carried by a collision diagnostic's `details`, ignoring
 * entries a different writer version produced in a shape this one cannot use.
 */
export function readToolCallIdCollisions(details: Record<string, unknown> | undefined): ToolCallIdCollision[] {
	const raw = details?.collisions;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.filter((entry): entry is ToolCallIdCollision => {
		const candidate = entry as Partial<ToolCallIdCollision>;
		return (
			typeof candidate.originalId === "string" &&
			typeof candidate.deduplicatedId === "string" &&
			typeof candidate.toolName === "string"
		);
	});
}

/** One-line human summary of a collision batch, for logs and diagnostics. */
export function formatToolCallIdCollisions(collisions: readonly ToolCallIdCollision[]): string {
	if (collisions.length === 0) {
		return "No tool call id collisions.";
	}
	const parts = collisions.map(
		(collision) => `"${collision.originalId}" (${collision.toolName}) -> "${collision.deduplicatedId}"`,
	);
	return (
		`The provider reused a tool call id inside one assistant message; renamed ${parts.join(", ")}. ` +
		"Tool call ids must be unique within a message."
	);
}
