import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { budgetSummarizationInput } from "../src/core/compaction/index.js";

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function extractText(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			if (message.role !== "user") return "";
			const content = message.content;
			if (typeof content === "string") return content;
			return content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join(" ");
		})
		.join("\n");
}

describe("budgetSummarizationInput (scan2 C4)", () => {
	const big = (label: string): AgentMessage => createUserMessage(`${label} ${"z".repeat(8000)}`); // ~2000 tokens

	it("keeps the newest messages within budget and counts elided", () => {
		const messages = [big("old"), big("mid"), createUserMessage("recent")];
		const { messages: kept, elided } = budgetSummarizationInput(messages, 2500);
		expect(elided).toBe(1);
		expect(kept).toHaveLength(2);
		expect(extractText(kept)).toContain("mid");
		expect(extractText(kept)).toContain("recent");
		expect(extractText(kept)).not.toContain("old");
	});

	it("always keeps the newest message even when it alone exceeds the budget", () => {
		const messages = [big("a"), big("b"), createUserMessage("tiny")];
		const { messages: kept, elided } = budgetSummarizationInput(messages, 10);
		expect(elided).toBe(2);
		expect(kept).toHaveLength(1);
	});

	it("disables trimming with a non-positive budget", () => {
		const messages = [big("a"), big("b")];
		expect(budgetSummarizationInput(messages, 0)).toEqual({ messages, elided: 0 });
	});
});
