import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateContextTokens, isAssistantUsageSource } from "../../src/core/compaction/index.js";
import { createHarness, type Harness } from "./harness.js";

const CONTEXT_WINDOW = 200_000;

function usageWith(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(totalTokens: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `assistant answer (${totalTokens})` }],
		usage: usageWith(totalTokens),
		stopReason,
		timestamp: Date.now(),
		api: "faux",
		provider: "faux",
		model: "faux-1",
	};
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("getContextUsage after a compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createCompactedHarness(): Promise<Harness> {
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: CONTEXT_WINDOW }],
		});
		harnesses.push(harness);
		return harness;
	}

	it("reads the same usage source as the compaction trigger when the newest assistant reports zeros", async () => {
		const harness = await createCompactedHarness();
		harness.sessionManager.appendMessage(user("pre-compaction question"));
		const keptEntryId = harness.sessionManager.appendMessage(assistant(100_000));
		harness.sessionManager.appendCompaction("compacted summary", keptEntryId, 100_000);
		const zeroUsageAssistant = assistant(0);
		harness.sessionManager.appendMessage(zeroUsageAssistant);
		harness.session.agent.state.messages = [zeroUsageAssistant, user("trailing question")];

		const usage = harness.session.getContextUsage();
		const triggerCaliber = estimateContextTokens(harness.session.messages);

		// The threshold trigger reads this assistant as its usage source, so /usage
		// and /context must report a number instead of claiming "unknown".
		expect(triggerCaliber.lastUsageIndex).not.toBeNull();
		expect(usage?.tokens).toBe(triggerCaliber.tokens);
		expect(usage?.contextWindow).toBe(CONTEXT_WINDOW);
		expect(usage?.percent).toBe((triggerCaliber.tokens / CONTEXT_WINDOW) * 100);
	});

	it("keeps scanning past an aborted assistant to the post-compaction usage before it", async () => {
		const harness = await createCompactedHarness();
		harness.sessionManager.appendMessage(user("pre-compaction question"));
		const keptEntryId = harness.sessionManager.appendMessage(assistant(100_000));
		harness.sessionManager.appendCompaction("compacted summary", keptEntryId, 100_000);
		const postCompactionAssistant = assistant(40_000);
		harness.sessionManager.appendMessage(postCompactionAssistant);
		const abortedAssistant = assistant(0, "aborted");
		harness.sessionManager.appendMessage(abortedAssistant);
		harness.session.agent.state.messages = [postCompactionAssistant, abortedAssistant];

		const usage = harness.session.getContextUsage();

		expect(usage?.tokens).toBe(estimateContextTokens(harness.session.messages).tokens);
		expect(usage?.tokens).not.toBeNull();
	});

	it("control: an errored post-compaction assistant is not a usage source", async () => {
		const harness = await createCompactedHarness();
		harness.sessionManager.appendMessage(user("pre-compaction question"));
		const keptEntryId = harness.sessionManager.appendMessage(assistant(100_000));
		harness.sessionManager.appendCompaction("compacted summary", keptEntryId, 100_000);
		const erroredAssistant = assistant(120_000, "error");
		harness.sessionManager.appendMessage(erroredAssistant);
		harness.session.agent.state.messages = [erroredAssistant];

		const usage = harness.session.getContextUsage();

		// The trigger reads no usable usage from an errored turn either, so both
		// calibers stay at "unknown" until a real response arrives.
		expect(estimateContextTokens(harness.session.messages).lastUsageIndex).toBeNull();
		expect(usage).toEqual({ tokens: null, contextWindow: CONTEXT_WINDOW, percent: null });
	});

	it("control: reports unknown while no assistant answered after the compaction", async () => {
		const harness = await createCompactedHarness();
		harness.sessionManager.appendMessage(user("pre-compaction question"));
		const keptEntryId = harness.sessionManager.appendMessage(assistant(100_000));
		harness.sessionManager.appendCompaction("compacted summary", keptEntryId, 100_000);
		harness.session.agent.state.messages = [user("question after the compaction")];

		const usage = harness.session.getContextUsage();

		expect(usage).toEqual({ tokens: null, contextWindow: CONTEXT_WINDOW, percent: null });
	});

	it("exposes one usage-source predicate for both calibers", () => {
		expect(isAssistantUsageSource(assistant(0))).toBe(true);
		expect(isAssistantUsageSource(assistant(100_000, "error"))).toBe(false);
		expect(isAssistantUsageSource(assistant(100_000, "aborted"))).toBe(false);
		expect(isAssistantUsageSource(user("x"))).toBe(false);
	});
});
