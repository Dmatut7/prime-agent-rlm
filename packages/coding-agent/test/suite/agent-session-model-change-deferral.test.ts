import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_CHANGE_CUSTOM_TYPE } from "../../src/core/messages.js";
import { createHarness, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

/**
 * wave-40 must-1: the model-change notice must never land between an assistant
 * tool call and its tool result. setModel() and the other switch sites pushed the
 * notice onto the live context immediately, so a switch mid tool batch broke the
 * tool_use/tool_result pairing the next request is built from (providers reject
 * the pairing, or the model re-runs the tool whose result it never saw). While a
 * run is streaming, the notice now waits for the batch boundary (turn_end), the
 * same deferral _pendingBashMessages uses; the durable model_change ledger entry
 * is still written at once.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

const MODELS = [{ id: "faux-1" }, { id: "faux-2" }];

function isModelChangeNotice(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === MODEL_CHANGE_CUSTOM_TYPE;
}

function noticeIndexes(harness: Harness): number[] {
	return harness.session.messages.flatMap((message, index) => (isModelChangeNotice(message) ? [index] : []));
}

function roleSequence(harness: Harness): string[] {
	return harness.session.messages.map((message) => (isModelChangeNotice(message) ? "model-change" : message.role));
}

describe("model-change notice ordering", () => {
	it("defers a mid-tool-batch setModel notice to the batch boundary", async () => {
		const gate = createDeferred<void>();
		const slowTool: AgentTool = {
			name: "slow",
			label: "slow",
			description: "holds the tool batch open",
			parameters: Type.Object({}),
			execute: async () => {
				await gate.promise;
				return { content: [{ type: "text", text: "slow done" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [slowTool], models: MODELS });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("wrapped up"),
		]);

		const promptDone = harness.session.prompt("run the slow tool");
		// Wait until the tool call is actually executing (the batch is open).
		await waitForCondition(() => harness.eventsOfType("tool_execution_start").length > 0);
		expect(harness.session.isStreaming).toBe(true);

		const other = harness.getModel("faux-2");
		if (!other) throw new Error("faux-2 missing");
		await harness.session.setModel(other);

		// While the batch is open the notice must not sit between the call and its result.
		expect(noticeIndexes(harness)).toHaveLength(0);

		gate.resolve();
		await promptDone;

		const roles = roleSequence(harness);
		const toolCallIndex = roles.indexOf("assistant");
		const toolResultIndex = roles.indexOf("toolResult");
		const noticeIndex = roles.indexOf("model-change");
		expect(toolCallIndex).toBeGreaterThanOrEqual(0);
		expect(toolResultIndex).toBeGreaterThan(toolCallIndex);
		// Flushed at the batch boundary: after the tool result, before the next turn.
		expect(noticeIndex).toBeGreaterThan(toolResultIndex);
		expect(roles[noticeIndex + 1]).toBe("assistant");
		// The durable ledger entry was written at once, mid-batch or not.
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "model_change" && entry.modelId === "faux-2"),
		).toBe(true);
	});

	it("pushes immediately when the session is idle", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		expect(harness.session.isStreaming).toBe(false);

		const other = harness.getModel("faux-2");
		if (!other) throw new Error("faux-2 missing");
		await harness.session.setModel(other);
		expect(noticeIndexes(harness)).toHaveLength(1);
	});

	it("records no notice when the model did not change", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");

		const current = harness.session.model;
		if (!current) throw new Error("no current model");
		await harness.session.setModel(current);
		expect(noticeIndexes(harness)).toHaveLength(0);
	});
});

async function waitForCondition(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not met in time");
}
