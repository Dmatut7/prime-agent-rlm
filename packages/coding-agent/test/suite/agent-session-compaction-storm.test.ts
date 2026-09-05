import type { ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

type SessionWithCompactionInternals = {
	_checkCompaction: (
		assistantMessage: AssistantMessage,
		skipAbortedCheck?: boolean,
		queueAutonomousContinuation?: boolean,
	) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold" | "requested", willRetry: boolean) => Promise<boolean>;
	_thresholdCompactionNeeded: (context: ShouldStopAfterTurnContext) => Promise<boolean>;
	_continueAfterThresholdCompaction: boolean;
};

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(harness: Harness, options: { totalTokens?: number; timestamp: number }): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", { stopReason: "stop", timestamp: options.timestamp }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

describe("threshold compaction storm guards (scan2 C1/C2/C4)", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.useRealTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does not fire threshold compaction when the reserve consumes the window", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 16_384 }],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithCompactionInternals;
		const assistant = createAssistant(harness, { totalTokens: 16_000, timestamp: Date.now() });
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "x".repeat(400_000) }], timestamp: Date.now() - 1000 },
			assistant,
		];

		const runSpy = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue(false);
		await internals._checkCompaction(assistant, false, false);

		expect(runSpy).not.toHaveBeenCalled();
	});

	it("summarizes an oversized trailing turn by cutting at the issuing assistant", async () => {
		// window 100k, reserve 1k -> threshold 99k. The giant tool result alone
		// (~200k estimated tokens) sits above it; usage inputs stay below the
		// window so this exercises the threshold path, not overflow recovery.
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 } },
			models: [{ id: "faux-1", contextWindow: 100_000 }],
			persistSession: true,
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		const baseTime = Date.now() - 60_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "start work" }],
			timestamp: baseTime,
		});
		const toolCallAssistantId = harness.sessionManager.appendMessage({
			...fauxAssistantMessage("", { stopReason: "stop", timestamp: baseTime + 1000 }),
			content: [{ type: "toolCall", id: "tc1", name: "ipython", arguments: { code: "print(1)" } }],
			usage: createUsage(110),
		});
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "ipython",
			content: [{ type: "text", text: "x".repeat(800_000) }],
			isError: false,
			timestamp: baseTime + 2000,
		});
		const syncMessages = () => {
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		};
		syncMessages();

		// Without the C2 fallback this preparation comes back "too short" (cut at
		// the first entry, nothing to summarize) and the threshold re-fires forever.
		harness.setResponses([fauxAssistantMessage("storm summary")]);
		const assistant1 = createAssistant(harness, { totalTokens: 5000, timestamp: Date.now() + 10_000 });
		await internals._checkCompaction(assistant1, false, false);

		const firstCompaction = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(firstCompaction).toMatchObject({ type: "compaction", firstKeptEntryId: toolCallAssistantId });
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
			reason: "threshold",
			result: expect.objectContaining({ summary: expect.any(String) }),
		});
		expect(harness.getPendingResponseCount()).toBe(0);

		// A follow-up turn still over threshold summarizes the giant result itself
		// (cut at the next turn boundary), shrinking the context for real.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "keep going" }],
			timestamp: Date.now() + 20_000,
		});
		const assistant2 = createAssistant(harness, { totalTokens: 99_500, timestamp: Date.now() + 30_000 });
		harness.sessionManager.appendMessage(assistant2);
		syncMessages();
		harness.appendResponses([fauxAssistantMessage("second summary")]);
		await internals._checkCompaction(assistant2, false, false);

		const compactions = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactions).toHaveLength(2);

		// Nothing summarizable remains before the newest entries: this attempt is
		// skipped once and arms the cooldown instead of re-firing.
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "and again" }],
			timestamp: Date.now() + 40_000,
		});
		const assistant3 = createAssistant(harness, { totalTokens: 99_500, timestamp: Date.now() + 50_000 });
		harness.sessionManager.appendMessage(assistant3);
		syncMessages();
		await internals._checkCompaction(assistant3, false, false);

		const outcomes = harness.session.messages.filter(
			(message) =>
				message.role === "custom" && (message as { customType?: string }).customType === "compaction_outcome",
		);
		expect(outcomes.length).toBeGreaterThan(0);

		// Still over threshold, but the cooldown suppresses the next attempt.
		const assistant4 = createAssistant(harness, { totalTokens: 99_500, timestamp: Date.now() + 60_000 });
		harness.sessionManager.appendMessage(assistant4);
		syncMessages();
		const runSpy = vi.spyOn(internals, "_runAutoCompaction");
		const startCountBefore = harness.eventsOfType("compaction_start").length;
		await internals._checkCompaction(assistant4, false, false);
		expect(runSpy).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_start").length).toBe(startCountBefore);
		expect(harness.getPendingResponseCount()).toBe(0);

		// Enough new branch entries lift the cooldown and allow a retry (which
		// skips again immediately, re-arming the cooldown).
		for (let i = 0; i < 3; i++) {
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `filler ${i}` }],
				timestamp: Date.now() + 70_000 + i * 1000,
			});
			harness.sessionManager.appendMessage(
				createAssistant(harness, { totalTokens: 99_500, timestamp: Date.now() + 70_500 + i * 1000 }),
			);
		}
		syncMessages();
		await internals._checkCompaction(
			createAssistant(harness, { totalTokens: 99_500, timestamp: Date.now() + 80_000 }),
			false,
			false,
		);
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("cools down after a skip even when the estimate stays above the threshold", async () => {
		// Session too short to compact but usage reports a large context: skip
		// once, then the cooldown suppresses the next attempt.
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		harness.setResponses([fauxAssistantMessage("seed reply")]);
		await harness.session.prompt("seed");

		const runSpy = vi.spyOn(internals, "_runAutoCompaction");
		await internals._runAutoCompaction("threshold", false);
		expect(runSpy).toHaveBeenCalledTimes(1);

		const assistant = createAssistant(harness, { totalTokens: 190_000, timestamp: Date.now() + 1000 });
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		await internals._checkCompaction(assistant, false, false);
		expect(runSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps the turn running while the threshold cooldown is armed", async () => {
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithCompactionInternals;

		harness.setResponses([fauxAssistantMessage("seed reply")]);
		await harness.session.prompt("seed");
		// Arm the cooldown the same way the case above does: one skipped attempt.
		await internals._runAutoCompaction("threshold", false);

		const assistant = createAssistant(harness, { totalTokens: 190_000, timestamp: Date.now() + 1000 });
		harness.sessionManager.appendMessage(assistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		// The shouldStopAfterTurn hook has to agree with _checkCompaction. Cooling down
		// must not stop the loop, queue a continuation for a compaction that will not
		// run, or set the flag that would leak into the next compaction. The hook only
		// reads `message` from its context.
		const needed = await internals._thresholdCompactionNeeded({
			message: assistant,
		} as unknown as ShouldStopAfterTurnContext);

		expect(needed).toBe(false);
		expect(internals._continueAfterThresholdCompaction).toBe(false);
	});
});
