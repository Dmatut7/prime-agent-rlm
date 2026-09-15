import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/**
 * K3R-7: concurrent manual compaction admission must not silently drop the
 * second caller's customInstructions, and a manual compact must preempt an
 * in-flight auto compaction instead of queueing a second full compaction
 * behind it on the just-compacted context.
 */

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
			settings: { compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 } },
			models: [{ id: "faux-1", contextWindow: 20_000 }],
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
});
