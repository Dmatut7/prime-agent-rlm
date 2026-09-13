import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS } from "../src/core/compaction/utils.js";

function toolResult(text: string): Message[] {
	return [
		{
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "ipython",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now(),
		},
	];
}

describe("serializeConversation", () => {
	it("keeps the head and the tail of a long tool result", () => {
		const head = "h".repeat(TOOL_RESULT_HEAD_CHARS);
		const middle = "m".repeat(4000);
		const tail = "T".repeat(TOOL_RESULT_TAIL_CHARS);
		const result = serializeConversation(toolResult(`${head}${middle}${tail}`));

		expect(result).toContain("[Tool result]:");
		expect(result).toContain(`[... ${middle.length} characters truncated ...]`);
		expect(result).toContain(head);
		expect(result).toContain(tail);
		// The middle is what goes: not one character of it survives.
		expect(result).not.toContain("m");
	});

	it("reaches the verdict a test runner prints last", () => {
		// The measured failure: 183 facts existed only past the 2000-character cut,
		// because a runner prints its failure list at the end of a long log.
		const passing = Array.from({ length: 200 }, (_, i) => `✓ test/case-${i}.test.ts passed`).join("\n");
		const verdict =
			"\nFAIL test/suite/regressions/4603-lag.test.ts > keeps the panel responsive\nError: timed out after 30000ms";
		expect(passing.length).toBeGreaterThan(TOOL_RESULT_HEAD_CHARS);
		const result = serializeConversation(toolResult(`${passing}${verdict}`));

		expect(result).toContain("4603-lag.test.ts");
		expect(result).toContain("Error: timed out after 30000ms");
		expect(result).toContain("characters truncated");
	});

	it("does not truncate a result that fits head plus tail", () => {
		const content = "x".repeat(TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS);
		const result = serializeConversation(toolResult(content));

		expect(result).toBe(`[Tool result]: ${content}`);
		expect(result).not.toContain("truncated");
	});

	it("does not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const result = serializeConversation(toolResult(shortContent));

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
