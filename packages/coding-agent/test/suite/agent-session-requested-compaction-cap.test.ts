import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACTION_OUTCOME_CUSTOM_TYPE } from "../../src/core/messages.js";
import { createHarness, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

/**
 * wave-40 secondary: a model-requested compaction (compact.run over the host
 * bridge) used to retry uncapped: every failure restored the pending request, the
 * next turn boundary ran it again, and a deterministically failing summarizer
 * burned a paid call per turn forever. The pending request now carries a failure
 * budget (dropped with a visible outcome once spent) and a failed attempt arms
 * the same branch-growth cooldown a failed threshold compaction gets, so a retry
 * waits for new material or a model change instead of spinning.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

/** A permanent provider failure: never retried, so each attempt consumes exactly one call. */
const permanentSummaryFailure = (): AssistantMessage => ({
	...fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 bad request" }),
	diagnostics: [
		{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind: "invalid_request", status: 400 } },
	],
});

function requestedCompactionStarts(harness: Harness) {
	return harness.eventsOfType("compaction_start").filter((event) => event.reason === "requested");
}

function outcomeTexts(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === COMPACTION_OUTCOME_CUSTOM_TYPE)
		.map((entry) => (entry.type === "custom_message" ? String(entry.content) : ""));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** The failure path resumes the interrupted loop; prompts must wait that turn out. */
async function waitForSessionIdle(harness: Harness): Promise<void> {
	await waitFor(
		() => !harness.session.isStreaming && !harness.session.isCompacting && harness.session.queuedActionCount === 0,
		"the session to go idle",
	);
}

describe("model-requested compaction failure budget", () => {
	it("cools down after a failure and drops the request after three failed attempts", async () => {
		const gate = createDeferred<void>();
		const gateTool: AgentTool = {
			name: "gate",
			label: "gate",
			description: "holds the turn open so compact.run can be requested mid-turn",
			parameters: Type.Object({}),
			execute: async () => {
				await gate.promise;
				return { content: [{ type: "text", text: "gate done" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [gateTool],
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			// A minimal kept tail, so the small history is summarizable at all and
			// compact.run does not refuse the request as nothing-to-summarize.
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 500 } },
		});
		harnesses.push(harness);

		const mainScript: AssistantMessage[] = [
			fauxAssistantMessage("one"),
			fauxAssistantMessage(fauxToolCall("gate", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
			fauxAssistantMessage("four"),
			fauxAssistantMessage("five"),
			fauxAssistantMessage("six"),
		];
		const step = (context: Context) => {
			if (context.systemPrompt?.includes("context summarization assistant")) {
				return permanentSummaryFailure();
			}
			const next = mainScript.shift();
			if (!next) throw new Error("no scripted answer left");
			return next;
		};
		harness.setResponses([step, step, step, step, step, step, step, step, step, step]);

		await harness.session.prompt("first");
		const promptTwo = harness.session.prompt("second");
		await waitFor(() => harness.eventsOfType("tool_execution_start").length > 0, "the gated tool to start");
		const requested = harness.session.handleCompactHostRequest("compact.run");
		expect(requested).toMatchObject({ scheduled: true });
		gate.resolve();
		await promptTwo;

		// Attempt 1 ran and failed.
		await waitFor(() => requestedCompactionStarts(harness).length === 1, "the first requested compaction");
		await waitFor(() => harness.eventsOfType("compaction_end").length === 1, "the first compaction to settle");
		await waitForSessionIdle(harness);
		expect(harness.session.handleCompactHostRequest("compact.status")).toMatchObject({ scheduled: true });

		// Same model, branch barely grown: the cooldown holds the retry back.
		await harness.session.prompt("third");
		await waitForSessionIdle(harness);
		expect(requestedCompactionStarts(harness)).toHaveLength(1);

		// A model change lifts the cooldown (a different window may succeed): attempt 2.
		const faux2 = harness.getModel("faux-2");
		const faux1 = harness.getModel("faux-1");
		if (!faux2 || !faux1) throw new Error("models missing");
		await harness.session.setModel(faux2);
		await harness.session.prompt("fourth");
		await waitFor(() => requestedCompactionStarts(harness).length === 2, "the second requested compaction");
		await waitFor(() => harness.eventsOfType("compaction_end").length === 2, "the second compaction to settle");
		await waitForSessionIdle(harness);

		// Attempt 3.
		await harness.session.setModel(faux1);
		await harness.session.prompt("fifth");
		await waitFor(() => requestedCompactionStarts(harness).length === 3, "the third requested compaction");
		await waitFor(() => harness.eventsOfType("compaction_end").length === 3, "the third compaction to settle");
		await waitForSessionIdle(harness);

		// The budget is spent: the request is dropped with a visible outcome instead
		// of a fourth paid summarization attempt.
		await harness.session.setModel(faux2);
		await harness.session.prompt("sixth");
		await waitForSessionIdle(harness);
		expect(requestedCompactionStarts(harness)).toHaveLength(3);
		expect(harness.session.handleCompactHostRequest("compact.status")).toMatchObject({ scheduled: false });
		expect(outcomeTexts(harness).some((text) => text.includes("gave up"))).toBe(true);
	});
});
