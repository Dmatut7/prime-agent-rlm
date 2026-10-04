/**
 * W11-C (model-cases C1/C2/C3): tool-not-found breaker + self-correction receipts.
 *
 * C1: GLM streamed XML-corrupted tool names and re-issued them 152 times over 44
 * minutes - the receipt never listed the available tools and nothing in the run
 * bounded the loop (the fallback storm detector only acts when a fallback chain is
 * configured). C2: the model corrected itself and relapsed four lines later. C3:
 * invented cross-harness tool names.
 *
 * The loop answers every unknown-tool call with the available tool names and a
 * did-you-mean suggestion, warns on the receipt at N (default 3) unknown-tool calls,
 * and at M (default 5) grants a recovery turn instead of ending the run outright:
 * a resolved call (or a clean stop) closes the episode and resets the counts. Every
 * trigger - the limit hit or a relapse inside an open recovery turn - spends one of
 * the per-run recovery budget (default 3), and the run ends with a classified
 * terminal error - the non-retryable class, so a broken model is not re-fed the
 * same context - only once that budget is spent. Per-name counts decay by one per
 * resolved call, so C2's isolated relapse warns instead of ending a long task
 * (wave-40; per-run recovery budget added 2026-10).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { TOOL_NOT_FOUND_BREAKER_STOP_REASON_RAW } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const echoTool: AgentTool = {
	name: "echo",
	label: "echo",
	description: "Echoes the text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: String((params as { text: string }).text) }],
		details: {},
	}),
};

function toolResultTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "toolResult")
		.map((message) => getMessageText(message));
}

describe("W11-C tool-not-found breaker", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harnessWithTools(tools: AgentTool[]): Promise<Harness> {
		const harness = await createHarness({ tools });
		harnesses.push(harness);
		return harness;
	}

	it("C2 relapse: a good call decays the per-name count, so the relapse warns and the run continues", async () => {
		const harness = await harnessWithTools([echoTool]);
		harness.setResponses([
			// The C2 opening: four parallel calls to a tool that does not exist.
			fauxAssistantMessage(
				[fauxToolCall("rlm", {}), fauxToolCall("rlm", {}), fauxToolCall("rlm", {}), fauxToolCall("rlm", {})],
				{ stopReason: "toolUse" },
			),
			// The model self-corrects and one good call lands, decaying `rlm` 4 -> 3...
			fauxAssistantMessage([fauxToolCall("echo", { text: "spawned" })], { stopReason: "toolUse" }),
			// ...then relapses four lines later (C2 verbatim). The decayed count is the
			// 4th: a warn, not the cumulative fifth that used to kill the whole task.
			fauxAssistantMessage([fauxToolCall("rlm", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("spawned four subagents"),
		]);

		await harness.session.prompt("spawn four subagents");

		// Nothing stopped the run: the recovery came from the model, not the breaker.
		expect(harness.faux.state.callCount).toBe(4);

		const receipts = toolResultTexts(harness);
		expect(receipts).toHaveLength(6);
		// Every receipt names the failure and lists what actually exists (C1's missing grip).
		for (const receipt of receipts.slice(0, 4)) {
			expect(receipt.split("\n")[0]).toBe("Tool rlm not found");
			expect(receipt).toContain("Available tools: echo");
		}
		// The third unknown-tool call of the run carries the forced-correction warning.
		expect(receipts[2]).toContain("tool-not-found breaker");
		expect(receipts[0]).not.toContain("tool-not-found breaker");
		// The good call in between really ran (the relapse did not rewrite history).
		expect(receipts[4]).toBe("spawned");
		// The relapse is a warn, not a trip: the run lived on to answer.
		expect(receipts[5]).toContain("Tool rlm not found");
		expect(receipts[5]).toContain("tool-not-found breaker");
		expect(receipts[5]).not.toContain("final correction");
		const last = harness.session.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("expected the final assistant message");
		expect(last.stopReason).toBe("stop");
	});

	it("C3: a typo'd name gets the did-you-mean receipt and the run recovers below the thresholds", async () => {
		const harness = await harnessWithTools([echoTool]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ecko", { text: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("The echo tool returned: hi."),
		]);

		await harness.session.prompt("echo hi");

		const receipts = toolResultTexts(harness);
		expect(receipts).toHaveLength(2);
		expect(receipts[0]?.split("\n")[0]).toBe("Tool ecko not found");
		expect(receipts[0]).toContain("Available tools: echo");
		expect(receipts[0]).toContain('Did you mean: "echo"?');
		expect(receipts[0]).not.toContain("tool-not-found breaker");
		expect(receipts[1]).toBe("hi");

		const last = harness.session.messages.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role !== "assistant") throw new Error("expected the final assistant message");
		expect(last.stopReason).toBe("stop");
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("C1: five same-name failures grant a recovery turn; relapses spend the per-run budget (3) before the run ends", async () => {
		const ipythonTool: AgentTool = {
			name: "ipython",
			label: "ipython",
			description: "Runs python in the REPL kernel",
			parameters: Type.Object({ code: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const harness = await harnessWithTools([ipythonTool, echoTool]);
		harness.setResponses(
			Array.from({ length: 9 }, () =>
				fauxAssistantMessage([fauxToolCall("ipython</arg_value>", {})], { stopReason: "toolUse" }),
			),
		);

		await harness.session.prompt("run the analysis");

		// Five turns of garbage earn recovery turn 1; each relapse inside an open
		// recovery turn spends the next grant, and the fourth trigger - budget spent -
		// ends the run. The ninth scripted answer is never consumed.
		expect(harness.faux.state.callCount).toBe(8);
		const receipts = toolResultTexts(harness);
		expect(receipts[0]).toContain('Did you mean: "ipython"');
		// Every limit hit granted a recovery turn rather than stopping outright.
		expect(receipts[4]).toContain("recovery turn 1 of 3");
		expect(receipts[5]).toContain("recovery turn 2 of 3");
		expect(receipts[6]).toContain("recovery turn 3 of 3");
		expect(receipts[7]).toContain("the run stops");
		const last = harness.session.messages.at(-1);
		if (last?.role !== "assistant") throw new Error("expected the terminal assistant message");
		expect(last.stopReason).toBe("error");
		expect(last.stopReasonRaw).toBe(TOOL_NOT_FOUND_BREAKER_STOP_REASON_RAW);
		// The corrupted name is quoted and the corruption still maps back to a real tool.
		expect(last.errorMessage).toContain("ipython</arg_value>");
		// Not handed to the quick-retry ladder: the same context would produce the same garbage.
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
	});
});
