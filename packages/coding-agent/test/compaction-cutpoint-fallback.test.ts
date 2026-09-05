import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { findCutPoint } from "../src/core/compaction/index.js";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

let entryCounter = 0;
let lastId: string | null = null;

beforeEach(() => {
	entryCounter = 0;
	lastId = null;
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

describe("findCutPoint trailing oversized tool result (scan2 C2)", () => {
	it("cuts at the issuing assistant instead of keeping everything", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("start work")),
			createMessageEntry({
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "ipython", arguments: { code: "print(1)" } }],
				usage: createMockUsage(100, 10),
				stopReason: "stop",
				timestamp: Date.now(),
				api: "faux",
				provider: "faux",
				model: "faux-1",
			} as AssistantMessage),
			createMessageEntry({
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "ipython",
				content: [{ type: "text", text: "x".repeat(400_000) }],
				isError: false,
				timestamp: Date.now(),
			} as AgentMessage),
		];

		const result = findCutPoint(entries, 0, entries.length, 1000);
		// The budget is crossed at the huge tool result (index 2), which is not a
		// valid cut point. Cut at the closest valid point before it (the issuing
		// assistant at index 1), not the first cut point (index 0): keeping
		// everything would summarize nothing and re-fire every turn.
		expect(result.firstKeptEntryIndex).toBe(1);
		expect(result.isSplitTurn).toBe(true);
		expect(result.turnStartIndex).toBe(0);
	});
});
