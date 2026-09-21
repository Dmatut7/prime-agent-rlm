import type { ContextUsage } from "./extensions/index.js";

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
	/**
	 * U2: trailing consecutive errored tool results; a success resets it to 0.
	 * Optional on the wire: an older daemon omits it and the UI keeps its local count.
	 */
	consecutiveToolErrors?: number;
}

/**
 * U2: count the trailing consecutive errored tool results; any successful
 * tool result ends the streak. Structural on purpose so replay paths can
 * feed session messages without importing the AgentSession type family.
 */
export function consecutiveToolErrorsFromMessages(
	messages: ReadonlyArray<{ role: string; isError?: boolean }>,
): number {
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "toolResult") {
			continue;
		}
		if (message.isError === true) {
			count++;
		} else {
			break;
		}
	}
	return count;
}
