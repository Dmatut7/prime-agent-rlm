import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

// r25 red: two concurrent manual compact() calls are not mutually excluded —
// both start (admission is set only after an internal await), so the session
// can get two compaction summaries and abortCompaction() loses the first scope.

describe("r25 concurrent compact exclusion", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("serializes two concurrent manual compactions into one compaction record", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("one response"),
			fauxAssistantMessage("two response"),
			fauxAssistantMessage("model-generated summary A"),
			fauxAssistantMessage("model-generated summary B"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const starts: number[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") starts.push(starts.length);
		});
		await Promise.all([harness.session.compact(), harness.session.compact()]);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const summaries = harness.session.messages.filter((m) => m.role === "compactionSummary");

		console.error(
			`[r25] compaction_start=${starts.length} compactionEntries=${compactionEntries.length} summaries=${summaries.length} messages=${harness.session.messages.length}`,
		);
		expect(starts.length).toBe(1); // RED: second compact must not start a second compaction
		expect(compactionEntries).toHaveLength(1);
		expect(summaries).toHaveLength(1);
		// Disk record and live view must describe the same single compaction.
		expect(compactionEntries[0]?.summary).toBe(summaries[0]?.summary);
	});

	it("abortCompaction cancels the one running compaction even when two compacts were issued", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						// Hang until the compaction abort signal fires; pre-fix the first
						// scope's controller was overwritten, so this never resolved.
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one response"), fauxAssistantMessage("two response")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const first = harness.session.compact();
		const second = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(first).rejects.toThrow("Compaction cancelled");
		await expect(second).rejects.toThrow("Compaction cancelled");
		// Nothing was committed: no starts beyond the single admitted one, and
		// the disk/live pair stays empty and consistent.
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.session.messages.filter((m) => m.role === "compactionSummary")).toHaveLength(0);
	});

	it("does not coalesce a compact issued after the previous one settled", async () => {
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

		await harness.session.compact();
		// A genuinely later compact is a fresh attempt (here: "Already compacted"),
		// not a coalesce onto the settled operation.
		await expect(harness.session.compact()).rejects.toThrow("Already compacted");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
});
