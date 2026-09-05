import type { SessionEntry } from "./session-manager.js";

function assistantToolCallIds(entry: SessionEntry): string[] {
	if (entry.type !== "message" || entry.message.role !== "assistant") {
		return [];
	}
	const content = entry.message.content;
	if (!Array.isArray(content)) {
		return [];
	}
	const ids: string[] = [];
	for (const block of content) {
		if (block.type === "toolCall" && typeof block.id === "string") {
			ids.push(block.id);
		}
	}
	return ids;
}

function toolResultCallId(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "toolResult") {
		return undefined;
	}
	return entry.message.toolCallId;
}

/**
 * Fork/navigate keep from the root to a leaf. Compaction's findValidCutPoints
 * never starts a keep-window on a toolResult; the dual for a keep-to-leaf cut
 * is never ending on an incomplete tool pair (assistant with unmatched
 * toolCall, or a partial toolResult run). Snap backward to the entry before
 * that assistant, or undefined if the incomplete pair starts the path.
 */
export function resolveCompleteToolPairLeaf(path: SessionEntry[]): SessionEntry | undefined {
	if (path.length === 0) {
		return undefined;
	}

	let pendingIds: Set<string> | null = null;
	let openPairStart = -1;

	for (let i = 0; i < path.length; i++) {
		const entry = path[i]!;
		const toolCallIds = assistantToolCallIds(entry);
		if (toolCallIds.length > 0) {
			pendingIds = new Set(toolCallIds);
			openPairStart = i;
			continue;
		}
		const resultId = toolResultCallId(entry);
		if (resultId !== undefined) {
			if (pendingIds) {
				pendingIds.delete(resultId);
				if (pendingIds.size === 0) {
					pendingIds = null;
					openPairStart = -1;
				}
			}
			continue;
		}
		if (entry.type === "message") {
			pendingIds = null;
			openPairStart = -1;
		}
	}

	if (pendingIds && pendingIds.size > 0 && openPairStart >= 0) {
		return openPairStart > 0 ? path[openPairStart - 1] : undefined;
	}
	return path[path.length - 1];
}
