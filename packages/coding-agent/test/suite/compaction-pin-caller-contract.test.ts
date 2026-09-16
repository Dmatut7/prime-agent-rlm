import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLatestCompactionEntry } from "../../src/core/session-manager.js";
import { userMsg } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * The caller contract behind issue #19: the pin.
 *
 * `AgentSession` captures the leaf before the summarization call (the pin) and hands
 * it to `appendCompaction()` at commit. SessionManager-level tests cannot guard that:
 * delete the pin, or replace it with "read the leaf at commit time", and the
 * forward-append case below stays green because the two are then indistinguishable.
 * Only a real navigation during the window tells them apart - with a pin the summary
 * belongs to the branch it summarized and stays off the live chain; without one it
 * lands on the live chain and drags the position back.
 *
 * So: case A proves the fix works end to end, case B is the pin's guard.
 */
describe("the compaction pin (caller contract, issue #19)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	/** Starts a compaction and returns it held in flight, plus the lever that releases it. */
	async function heldCompaction() {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		let release: ((message: AssistantMessage) => void) | undefined;
		const held = () =>
			new Promise<AssistantMessage>((resolve) => {
				release = resolve;
			});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), held]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const seededIds = harness.sessionManager.getBranch().map((entry) => entry.id);
		const compactPromise = harness.session.compact();
		await vi.waitFor(
			() => {
				expect(harness.session.isCompacting).toBe(true);
			},
			{ timeout: 15_000, interval: 10 },
		);
		// The summarization call is in flight and nothing has been committed yet.
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		return {
			harness,
			compactPromise,
			seededIds,
			releaseSummary: () => {
				if (!release) throw new Error("the held summary response was never requested");
				release(fauxAssistantMessage("model-generated summary"));
			},
		};
	}

	it("A: an entry appended while the summary is in flight does not lose the summary", async () => {
		const { harness, compactPromise, releaseSummary } = await heldCompaction();

		// The window append: a refinement audit entry, i.e. an ordinary same-branch
		// append that advances the leaf (a child usage attribution does the same).
		const windowEntry = harness.sessionManager.appendCustomEntry("prime-agent.refinement", { probe: true });
		expect(harness.sessionManager.getLeafId()).toBe(windowEntry);

		releaseSummary();
		const result = await compactPromise;
		expect(result.summary).toContain("model-generated summary");

		const branch = harness.sessionManager.getBranch();
		const branchIds = branch.map((entry) => entry.id);
		// The summary is on the live chain, and the window append was not orphaned.
		expect(getLatestCompactionEntry(branch)).not.toBeNull();
		expect(branchIds).toContain(windowEntry);
		expect(harness.sessionManager.buildSessionContext().messages.some((m) => m.role === "compactionSummary")).toBe(
			true,
		);
		// The session still sees its own history: the kept tail is intact.
		expect(harness.session.messages.length).toBeGreaterThan(0);
	});

	it("B: a real navigation while the summary is in flight keeps it off the live chain (the pin's guard)", async () => {
		const { harness, compactPromise, seededIds, releaseSummary } = await heldCompaction();

		// Leave the branch being summarized: branch back to an ancestor of the pin and
		// build a different continuation there.
		const ancestor = seededIds[0] as string;
		harness.sessionManager.branch(ancestor);
		const other = harness.sessionManager.appendMessage(userMsg("a different question"));
		const leafBeforeCommit = harness.sessionManager.getLeafId();
		expect(leafBeforeCommit).toBe(other);

		releaseSummary();
		await compactPromise;

		const branch = harness.sessionManager.getBranch();
		const branchIds = branch.map((entry) => entry.id);
		const compactionId = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction")
			?.id as string;
		// The summary belongs to the branch it summarized: it is committed, but it is
		// not on the live chain, and the live position was not dragged back to it.
		expect(compactionId).toBeTruthy();
		expect(branchIds).not.toContain(compactionId);
		expect(getLatestCompactionEntry(branch)).toBeNull();
		expect(harness.sessionManager.getLeafId()).toBe(leafBeforeCommit);
		// The navigated-to branch keeps its own append.
		expect(branchIds).toContain(other);
	});
});
