import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import {
	deduplicateToolCallIds,
	formatToolCallIdCollisions,
	MAX_DEDUPLICATED_TOOL_CALL_ID_LENGTH,
} from "../src/tool-call-dedupe.js";

function toolCall(id: string, name = "alpha"): ToolCall {
	return { type: "toolCall", id, name, arguments: {} };
}

function text(value: string): AssistantMessage["content"][number] {
	return { type: "text", text: value };
}

function ids(content: AssistantMessage["content"]): string[] {
	return content.filter((part) => part.type === "toolCall").map((part) => part.id);
}

describe("deduplicateToolCallIds", () => {
	test("returns the input array untouched when every id is already unique", () => {
		const content: AssistantMessage["content"] = [text("hello"), toolCall("a"), toolCall("b")];

		const result = deduplicateToolCallIds(content);

		expect(result.collisions).toEqual([]);
		expect(result.content).toBe(content);
	});

	test("renames the second and third occurrence in content order", () => {
		const content: AssistantMessage["content"] = [toolCall("dup-1"), toolCall("dup-1"), toolCall("dup-1")];

		const result = deduplicateToolCallIds(content);

		expect(ids(result.content)).toEqual(["dup-1", "dup-1__dup2", "dup-1__dup3"]);
		expect(result.collisions).toEqual([
			{ originalId: "dup-1", deduplicatedId: "dup-1__dup2", toolName: "alpha", contentIndex: 1, occurrence: 2 },
			{ originalId: "dup-1", deduplicatedId: "dup-1__dup3", toolName: "alpha", contentIndex: 2, occurrence: 3 },
		]);
	});

	test("keeps a call whose id equals an id already assigned to an earlier call unique", () => {
		const content: AssistantMessage["content"] = [toolCall("dup-1"), toolCall("dup-1"), toolCall("dup-1__dup2")];

		const result = deduplicateToolCallIds(content);

		expect(ids(result.content)).toEqual(["dup-1", "dup-1__dup2", "dup-1__dup2__dup2"]);
		expect(new Set(ids(result.content)).size).toBe(3);
	});

	test("keeps an assigned id stable when more calls stream in behind it", () => {
		const prefix: AssistantMessage["content"] = [toolCall("dup-1"), toolCall("dup-1")];
		const streamed: AssistantMessage["content"] = [...prefix, toolCall("dup-1__dup2"), toolCall("dup-1")];

		const first = deduplicateToolCallIds(prefix);
		const second = deduplicateToolCallIds(streamed);

		expect(ids(first.content)).toEqual(["dup-1", "dup-1__dup2"]);
		expect(ids(second.content)).toEqual(["dup-1", "dup-1__dup2", "dup-1__dup2__dup2", "dup-1__dup3"]);
		expect(second.content.slice(0, prefix.length).map((part) => (part.type === "toolCall" ? part.id : ""))).toEqual(
			first.content.map((part) => (part.type === "toolCall" ? part.id : "")),
		);
	});

	test("caps the replacement so provider truncation cannot collapse it back", () => {
		const longId = "x".repeat(80);
		const content: AssistantMessage["content"] = [toolCall(longId), toolCall(longId)];

		const result = deduplicateToolCallIds(content);

		const [first, second] = ids(result.content);
		expect(first).toBe(longId);
		expect(second).toBe(`${"x".repeat(MAX_DEDUPLICATED_TOOL_CALL_ID_LENGTH - "__dup2".length)}__dup2`);
		expect(second.length).toBe(MAX_DEDUPLICATED_TOOL_CALL_ID_LENGTH);
		// The two ids stay distinct after a 40- and a 64-character truncation.
		expect(second).not.toBe(first.slice(0, MAX_DEDUPLICATED_TOOL_CALL_ID_LENGTH));
		expect(second).not.toBe(first.slice(0, 64));
	});

	test("gives an empty repeated id a non-empty unique replacement", () => {
		const content: AssistantMessage["content"] = [toolCall(""), toolCall("")];

		const result = deduplicateToolCallIds(content);

		expect(ids(result.content)).toEqual(["", "toolcall__dup2"]);
		expect(result.collisions).toHaveLength(1);
	});

	test("names the original id, the tool and the replacement in the summary", () => {
		const content: AssistantMessage["content"] = [toolCall("dup-1", "alpha"), toolCall("dup-1", "beta")];

		const summary = formatToolCallIdCollisions(deduplicateToolCallIds(content).collisions);

		expect(summary).toContain('"dup-1"');
		expect(summary).toContain("beta");
		expect(summary).toContain('"dup-1__dup2"');
	});
});
