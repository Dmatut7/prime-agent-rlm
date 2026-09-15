import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * K3R-7: concurrent manual compaction admission must not silently drop the
 * second caller's customInstructions, and a manual compact must preempt an
 * in-flight auto compaction instead of queueing a second full compaction
 * behind it on the just-compacted context.
 *
 * r28 K3R-11: the preemption abort must not destroy the work the in-flight
 * threshold compaction had stopped the loop for (queued autonomous
 * continuations, the goal continuation) - a manual /compact is not the user
 * cancelling that work.
 */

/** Faux ipython tool that services goal.* host requests like the real kernel bridge. */
function createFauxIpythonTool(sessionRef: { current?: AgentSession }): AgentTool {
	return {
		name: "ipython",
		label: "ipython",
		description: "Execute Python code in the agent kernel.",
		parameters: Type.Object({ code: Type.String() }),
		execute: async (_toolCallId: string, params: unknown) => {
			const session = sessionRef.current;
			if (!session) throw new Error("test session is not initialized");
			const code = (params as { code: string }).code.trim();
			let text = "";
			if (code.startsWith("goal.")) {
				const spaceIndex = code.indexOf(" ");
				const type = spaceIndex < 0 ? code : code.slice(0, spaceIndex);
				const payload = spaceIndex < 0 ? {} : JSON.parse(code.slice(spaceIndex + 1));
				text = JSON.stringify(session.handleGoalHostRequest(type, payload));
			}
			return { content: [{ type: "text" as const, text }], details: {} };
		},
	};
}

describe("K3R-7: manual compaction admission", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("queues a second compact with different instructions instead of dropping them", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("model-generated summary A"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const first = harness.session.compact("instructions A");
		const second = harness.session.compact("instructions B");
		const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);

		// RED on HEAD: the second compact silently returned the first's result and
		// "instructions B" never appeared anywhere.
		expect(firstOutcome.status).toBe("fulfilled");
		expect(secondOutcome.status).toBe("rejected");
		const starts = harness.eventsOfType("compaction_start");
		expect(starts.map((event) => event.customInstructions)).toEqual(["instructions A", "instructions B"]);
	});

	it("still coalesces concurrent compacts with the same instructions", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("model-generated summary A"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const results = await Promise.all([harness.session.compact("same"), harness.session.compact("same")]);

		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(results[0]).toEqual(results[1]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("a manual compact preempts an in-flight auto compaction", async () => {
		let extensionCalls = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 185_000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						extensionCalls += 1;
						if (extensionCalls === 1) {
							// The auto compaction parks until its scope is aborted.
							return await new Promise<{ cancel: true }>((resolve) => {
								event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							});
						}
						return {
							compaction: {
								summary: "manual summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "extension" },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		// The faux provider derives usage from the prompt size, so an oversized
		// prompt pushes the trailing context over the threshold and the auto
		// compaction fires at the end of the turn.
		harness.setResponses([fauxAssistantMessage("done")]);

		const prompted = harness.session.prompt(`summarize this: ${"x".repeat(120_000)}`);
		// The auto compaction (overflow recovery here - same in-flight shape)
		// started and is parked in the extension.
		await expect
			.poll(() => harness.eventsOfType("compaction_start").filter((event) => event.reason !== "manual").length)
			.toBe(1);

		const manual = harness.session.compact("manual instructions");
		// RED on HEAD: the manual compact queued behind the parked auto compaction,
		// so no manual compaction ever started.
		await expect
			.poll(() => harness.eventsOfType("compaction_start").filter((event) => event.reason === "manual").length, {
				timeout: 5_000,
			})
			.toBe(1);
		const manualStart = harness.eventsOfType("compaction_start").find((event) => event.reason === "manual");
		expect(manualStart?.customInstructions).toBe("manual instructions");

		const result = await manual;
		expect(result.summary).toBe("manual summary");
		// The preempted auto compaction settled as cancelled, not as a success.
		const autoEnd = harness.eventsOfType("compaction_end").find((event) => event.reason !== "manual");
		expect(autoEnd?.aborted).toBe(true);
		await prompted;
	});

	/** Oversized prompt + small window: the trailing context crosses the threshold. */
	const bigPrompt = `summarize this: ${"x".repeat(120_000)}`;

	it("a manual compact preempting a threshold compaction preserves the queued goal continuation", async () => {
		let extensionCalls = 0;
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			settings: { compaction: { enabled: true, reserveTokens: 185_000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						extensionCalls += 1;
						if (extensionCalls === 1) {
							// The auto compaction parks until its scope is aborted.
							return await new Promise<{ cancel: true }>((resolve) => {
								event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							});
						}
						return {
							compaction: {
								summary: "manual summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "extension" },
							},
						};
					});
				},
			],
		});
		sessionRef.current = harness.session;
		harnesses.push(harness);
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		harness.setResponses([
			fauxAssistantMessage("done"),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "goal.complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer after the goal turn"),
		]);

		const prompted = harness.session.prompt(bigPrompt);
		// The threshold compaction parked in the extension and queued the goal
		// continuation it stopped the loop for.
		await expect
			.poll(() => harness.eventsOfType("compaction_start").filter((event) => event.reason === "threshold").length)
			.toBe(1);
		await expect
			.poll(() => harness.eventsOfType("goal_update").some((event) => event.goal.continuationsUsed >= 1))
			.toBe(true);

		await harness.session.compact("manual instructions");
		await prompted;

		// The queue-time increment must never be rolled back: the manual compact that
		// preempted the auto scope is not the user cancelling the goal continuation.
		const goalUpdates = harness.eventsOfType("goal_update");
		const firstQueued = goalUpdates.findIndex((event) => event.goal.continuationsUsed >= 1);
		expect(firstQueued).toBeGreaterThan(-1);
		for (let index = firstQueued; index < goalUpdates.length; index++) {
			expect(goalUpdates[index].goal.continuationsUsed).toBeGreaterThanOrEqual(1);
		}
		// The preserved goal turn runs exactly once after the compaction.
		await expect.poll(() => harness.getPendingResponseCount(), { timeout: 5_000 }).toBe(0);
		const goalContexts = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "goal_context",
		);
		expect(goalContexts).toHaveLength(1);
	});

	it("a manual compact preempting a threshold compaction preserves the queued autonomous continuation", async () => {
		let extensionCalls = 0;
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1, maxTurns: 100 },
			settings: { compaction: { enabled: true, reserveTokens: 185_000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						extensionCalls += 1;
						if (extensionCalls === 1) {
							return await new Promise<{ cancel: true }>((resolve) => {
								event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							});
						}
						return {
							compaction: {
								summary: "manual summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "extension" },
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("autonomous continuation answer")]);

		const prompted = harness.session.prompt(bigPrompt);
		await expect
			.poll(() => harness.eventsOfType("compaction_start").filter((event) => event.reason === "threshold").length)
			.toBe(1);
		// The threshold stop queued one autonomous continuation.
		await expect.poll(() => harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		expect(harness.session.getFollowUpMessages()).toHaveLength(1);

		await harness.session.compact("manual instructions");
		await prompted;

		// The queued continuation survives the preemption: its bookkeeping is not
		// rolled back and the loop keeps working after the compaction instead of
		// sitting idle with the continuation destroyed.
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
		await expect.poll(() => harness.getPendingResponseCount(), { timeout: 5_000 }).toBe(0);
		expect(harness.session.getLastAssistantText()).toBe("autonomous continuation answer");
	});

	it("control: a user abort still cancels the queued goal continuation of a threshold compaction", async () => {
		let extensionCalls = 0;
		const sessionRef: { current?: AgentSession } = {};
		const harness = await createHarness({
			tools: [createFauxIpythonTool(sessionRef)],
			settings: { compaction: { enabled: true, reserveTokens: 185_000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						extensionCalls += 1;
						if (extensionCalls === 1) {
							return await new Promise<{ cancel: true }>((resolve) => {
								event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							});
						}
						return {
							compaction: {
								summary: "manual summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "extension" },
							},
						};
					});
				},
			],
		});
		sessionRef.current = harness.session;
		harnesses.push(harness);
		harness.session.handleGoalHostRequest("goal.create", { objective: "finish the task" });
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("never delivered")]);

		const prompted = harness.session.prompt(bigPrompt);
		await expect
			.poll(() => harness.eventsOfType("compaction_start").filter((event) => event.reason === "threshold").length)
			.toBe(1);
		await expect
			.poll(() => harness.eventsOfType("goal_update").some((event) => event.goal.continuationsUsed >= 1))
			.toBe(true);

		harness.session.abortCompaction();
		await prompted;
		await expect
			.poll(() => harness.eventsOfType("compaction_end").filter((event) => event.reason === "threshold").length)
			.toBe(1);

		// The user's abort cancels the queued goal continuation and rolls its
		// queue-time increment back: nothing re-queues it, no goal turn runs.
		expect(harness.session.goalState.continuationsUsed).toBe(0);
		const goalContexts = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "goal_context",
		);
		expect(goalContexts).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("a skipped compact with instructions names the loss instead of a bare skip", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("model-generated summary A"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		// The first compact succeeds; a second compact with different instructions
		// re-enters on the just-compacted context (no new entries in between), finds
		// nothing left to summarize, and its instructions never run anywhere.
		await harness.session.compact("instructions A");
		await expect(harness.session.compact("instructions B")).rejects.toThrow(
			"Already compacted — the custom instructions were not applied",
		);
		// Without instructions the skip stays a bare, benign skip.
		await expect(harness.session.compact()).rejects.toThrow("Already compacted");
	});
});
