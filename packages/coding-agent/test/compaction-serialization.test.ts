import type { AssistantMessage, Message, ToolCall, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation, TOOL_RESULT_HEAD_CHARS, TOOL_RESULT_TAIL_CHARS } from "../src/core/compaction/utils.js";

function toolResult(text: string, toolName = "ipython", isError = false, toolCallId = "tc1"): Message[] {
	return [
		{
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError,
			timestamp: Date.now(),
		},
	];
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function assistantWithCalls(calls: ToolCall[]): AssistantMessage {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return {
		role: "assistant",
		content: calls,
		api: "anthropic",
		provider: "anthropic",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("serializeConversation", () => {
	it("keeps the head and the tail of a long tool result", () => {
		const head = "h".repeat(TOOL_RESULT_HEAD_CHARS);
		const middle = "m".repeat(4000);
		const tail = "T".repeat(TOOL_RESULT_TAIL_CHARS);
		const result = serializeConversation(toolResult(`${head}${middle}${tail}`));

		expect(result).toContain("[Tool result (ipython)]:");
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

		expect(result).toBe(`[Tool result (ipython)]: ${content}`);
		expect(result).not.toContain("truncated");
	});

	it("does not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const result = serializeConversation(toolResult(shortContent));

		expect(result).toBe(`[Tool result (ipython)]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it.each([
		["labels a short success result with its tool name", "bash", false, "[Tool result (bash)]"],
		["labels a short failed result as an error", "edit", true, "[Tool result (edit, error)]"],
	])("%s", (_label, toolName, isError, expected) => {
		const shortContent = "x".repeat(1500);
		expect(serializeConversation(toolResult(shortContent, toolName, isError))).toBe(`${expected}: ${shortContent}`);
	});

	it("pairs repeated same-name tool calls with their results by index", () => {
		const serialized = serializeConversation([
			assistantWithCalls([toolCall("c1", "ipython", { code: "a" }), toolCall("c2", "ipython", { code: "b" })]),
			...toolResult("first output", "ipython", false, "c1"),
			...toolResult("second output", "ipython", true, "c2"),
		]);

		expect(serialized).toBe(
			'[Assistant tool calls]: #1 ipython(code="a"); #2 ipython(code="b")\n\n' +
				"[Tool result (ipython) #1]: first output\n\n" +
				"[Tool result (ipython, error) #2]: second output",
		);
	});

	it("falls back to the name-only label when the result's call was not serialized", () => {
		const serialized = serializeConversation([
			assistantWithCalls([toolCall("c1", "bash", { command: "ls" })]),
			...toolResult("orphan output", "ipython", false, "tc-orphan"),
		]);

		expect(serialized).toBe(
			'[Assistant tool calls]: #1 bash(command="ls")\n\n[Tool result (ipython)]: orphan output',
		);
	});

	it("keeps every serialized body byte-identical and bounds what the labels add", () => {
		// The summarizer input is a model-visible surface: identity and error
		// attribution are additive, so the bodies must survive byte for byte and
		// the labels must not become a budget line of their own on a realistic
		// transcript (long results that truncate, repeated tools, one failure).
		// Provider toolCallIds can run past 450 characters; the `#N` index exists so
		// they never reach the token-budgeted summarizer input.
		const longId = (n: string) => `toolu_${n}${"x".repeat(500)}`;
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "make the failing suite green" }], timestamp: Date.now() },
			assistantWithCalls([
				toolCall(longId("1"), "ipython", { code: "run tests" }),
				toolCall(longId("2"), "bash", { command: "npm run check" }),
				toolCall(longId("3"), "edit", { path: "src/a.ts", old_str: "x", new_str: "y" }),
			]),
			...toolResult(`${"pass ".repeat(900)}FAIL src/a.test.ts`, "ipython", false, longId("1")),
			...toolResult("Error: check failed\nexit 1", "bash", true, longId("2")),
			...toolResult("Edited src/a.ts", "edit", false, longId("3")),
		];
		const serialized = serializeConversation(messages);
		// Strip the labels and the `#N` call prefixes: what is left must be exactly
		// the bodies the anonymous form carried.
		const bodies = serialized.replace(/\[Tool result \([^\]]*\)( #\d+)?\]: /g, "").replace(/#\d+ /g, "");

		expect(bodies).toContain("make the failing suite green");
		expect(bodies).toContain('ipython(code="run tests"); bash(command="npm run check")');
		expect(bodies).toContain("FAIL src/a.test.ts");
		expect(bodies).toContain("Error: check failed");
		expect(bodies).not.toContain("[Tool result");
		expect(bodies).not.toContain("#1 ");

		// The failure is attributable to the call that produced it, the raw ids stay
		// out, and stripping the labels removes exactly the bytes they are spelled
		// with - so nothing else in the serialized bodies moved.
		expect(serialized).toContain("[Tool result (bash, error) #2]: Error: check failed");
		expect(serialized).not.toContain(longId("1"));
		const labelOverhead = serialized.length - bodies.length;
		expect(labelOverhead).toBe(
			"#1 ".length +
				"#2 ".length +
				"#3 ".length +
				"[Tool result (ipython) #1]: ".length +
				"[Tool result (bash, error) #2]: ".length +
				"[Tool result (edit) #3]: ".length,
		);
	});

	it("keeps the label overhead under 2% of a transcript shaped like a real one", () => {
		// The summarizer input is token-budgeted, so the identity labels may not
		// become a budget line of their own. Real transcripts are dominated by long
		// tool results (ipython and bash output), not by the two-line fixtures above.
		const calls: ToolCall[] = [];
		const results: Message[] = [];
		for (let index = 0; index < 12; index++) {
			const id = `c${index}`;
			const name = index % 3 === 0 ? "ipython" : index % 3 === 1 ? "bash" : "edit";
			calls.push(toolCall(id, name, { index }));
			const body = `${name} output line ${index}\n`.repeat(120);
			results.push(...toolResult(body, name, index % 4 === 3, id));
		}
		const serialized = serializeConversation([assistantWithCalls(calls), ...results]);
		const bodies = serialized.replace(/\[Tool result \([^\]]*\)( #\d+)?\]: /g, "").replace(/#\d+ /g, "");

		expect(bodies).toContain("edit output line 11");
		expect(serialized).toContain("[Tool result (bash, error) #8]:");
		expect(serialized.length - bodies.length).toBeLessThan(serialized.length * 0.02);
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
