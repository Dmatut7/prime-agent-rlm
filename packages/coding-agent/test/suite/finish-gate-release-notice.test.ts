import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type CustomMessage, convertToLlm } from "../../src/core/messages.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * Emission side of the finish gate's release notice (the render side lives in
 * test/finish-gate-notice.test.ts): when the gate lets an unverified completion
 * claim through after FINISH_GATE_MAX_STRIKES nudges, the session writes one
 * display:true `finish_gate_released` custom message into the transcript, the
 * event stream and the live message list - and convertToLlm must never turn it
 * (or the kernel prune notice, which claimed the same privacy but leaked on
 * resume) into model input.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function quickTool(): AgentTool {
	return {
		name: "read_file",
		label: "Read",
		description: "Reads",
		parameters: Type.Object({ path: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "file body" }], details: {} }),
	};
}

async function releasedRun(): Promise<Harness> {
	const harness = await createHarness({ tools: [quickTool()] });
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("read_file", { path: "a.ts" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("修好了。"),
		fauxAssistantMessage("搞定了。"),
		fauxAssistantMessage("全部完成。"),
	]);
	await harness.session.promptAndWait("fix it");
	return harness;
}

function releaseNotices(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "finish_gate_released");
}

describe("finish-gate release notice (emission side)", () => {
	it("writes one display notice into the transcript when the gate releases", async () => {
		const harness = await releasedRun();

		const notices = releaseNotices(harness);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			display: true,
			details: { excerpt: "全部完成。", strikes: 2 },
		});
		const content = String((notices[0] as { content: unknown }).content);
		expect(content).toContain("[finish gate]");
		expect(content).toContain("全部完成。");
	});

	it("publishes the notice on the event stream", async () => {
		const harness = await releasedRun();

		for (const type of ["message_start", "message_end"] as const) {
			const events = harness
				.eventsOfType(type)
				.filter((event) => event.message.role === "custom" && event.message.customType === "finish_gate_released");
			expect(events).toHaveLength(1);
			expect(events[0]?.message).toMatchObject({ display: true, details: { excerpt: "全部完成。", strikes: 2 } });
		}
	});

	it("keeps the notice in the live message list but out of the rebuilt model input", async () => {
		const harness = await releasedRun();

		// Live: the notice is transcript + events + the session's message list - a
		// view rebuilt from live state (switching away and back) must still show the
		// "unverified completion" reminder; only the event stream would lose it.
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "finish_gate_released",
			),
		).toBe(true);

		// Resume: the transcript entry rebuilds into the presented context, but
		// convertToLlm must drop it there - a user-role copy would read as a new
		// instruction to the model.
		const rebuilt = harness.sessionManager.buildSessionContext().messages;
		expect(
			rebuilt.some((message) => message.role === "custom" && message.customType === "finish_gate_released"),
		).toBe(true);
		const llmMessages = convertToLlm(rebuilt);
		expect(llmMessages.some((message) => JSON.stringify(message).includes("unverified completion claim"))).toBe(
			false,
		);
		// The live list is equally closed to the model.
		expect(
			convertToLlm(harness.session.messages).some((message) =>
				JSON.stringify(message).includes("unverified completion claim"),
			),
		).toBe(false);
	});
});

describe("convertToLlm exclusions", () => {
	function customNotice(customType: string): CustomMessage {
		return { role: "custom", customType, content: "durable display text", display: true, timestamp: 123 };
	}

	it("drops the kernel prune notice (its fact already reached the model in the <ipython_state> block)", () => {
		expect(convertToLlm([customNotice("ipython_state_pruned")])).toEqual([]);
	});

	it("drops the finish-gate release notice", () => {
		expect(convertToLlm([customNotice("finish_gate_released")])).toEqual([]);
	});

	it("still includes ordinary custom messages", () => {
		expect(convertToLlm([customNotice("extension_notice")])).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "durable display text" }] },
		]);
	});
});
