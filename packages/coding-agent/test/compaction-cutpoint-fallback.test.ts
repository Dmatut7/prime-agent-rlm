import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it } from "vitest";
import { estimateTokens, estimateTokensByContent, findCutPoint } from "../src/core/compaction/index.js";
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

/**
 * The calibers this file operates in, with the arithmetic written out. A fixture is
 * only relabeled if its numbers move under the density caliber; ASCII prose in a
 * single text run is priced identically by both (chars/4), so it cannot move.
 */
describe("findCutPoint prices the retained slice by content density", () => {
	/** The trigger pin's CJK sentence (30 characters), repeated to 300 per message. */
	const CJK_STEP = "压缩必须在供应商输入墙之前触发，否则普通请求先收到四百错误。".repeat(10);

	function assistantText(text: string): AgentMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: createMockUsage(100, 10),
			stopReason: "stop",
			timestamp: Date.now(),
			api: "faux",
			provider: "faux",
			model: "faux-1",
		} as AssistantMessage as AgentMessage;
	}

	function alternating(text: string, count: number): SessionEntry[] {
		const entries: SessionEntry[] = [];
		for (let i = 0; i < count; i++) {
			entries.push(createMessageEntry(i % 2 === 0 ? createUserMessage(text) : assistantText(text)));
		}
		return entries;
	}

	it("cuts earlier than the flat chars/4 caliber on a CJK transcript", () => {
		const entries = alternating(CJK_STEP, 6);
		const first = entries[0];
		if (first.type !== "message") throw new Error("fixture must start with a message");

		// Math, not a fudge factor. Every message is 300 CJK characters:
		//   flat caliber:    ceil(300 / 4) = 75 per message; 6 x 75 = 450 < 1000, so
		//                    the old walk never crossed the budget and kept everything
		//                    (cut at the first cut point, entry 0).
		//   density caliber: CJK is spent at 1.5 characters per token, so
		//                    ceil(300 / 1.5) = 200 per message. Walking backwards from
		//                    entry 5 the budget of 1000 is crossed at entry 1
		//                    (200 / 400 / 600 / 800 / 1000 over entries 5, 4, 3, 2, 1).
		expect(estimateTokens(first.message)).toBe(75);
		expect(estimateTokensByContent(first.message)).toBe(200);
		expect(estimateTokens(first.message) * entries.length).toBeLessThan(1000);
		expect(estimateTokensByContent(first.message) * entries.length).toBeGreaterThanOrEqual(1000);

		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(1);
		expect(result.isSplitTurn).toBe(true);
		expect(result.turnStartIndex).toBe(0);
	});

	it("prices ASCII prose exactly as the flat caliber does, so an ASCII fixture cannot move", () => {
		const text = "step ".padEnd(1200, "x");
		const entries = alternating(text, 6);
		const first = entries[0];
		if (first.type !== "message") throw new Error("fixture must start with a message");

		// One text run of ASCII: both calibers are ceil(1200 / 4) = 300.
		expect(estimateTokensByContent(first.message)).toBe(estimateTokens(first.message));
		expect(estimateTokens(first.message)).toBe(300);
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			expect(estimateTokensByContent(entry.message)).toBe(estimateTokens(entry.message));
		}

		// Same walk in either caliber: entries 5, 4, 3 accumulate 300 / 600 / 900 and
		// entry 2 crosses the budget at 1200, so the cut sits on the user message at 2.
		expect(findCutPoint(entries, 0, entries.length, 1000).firstKeptEntryIndex).toBe(2);
	});
});
