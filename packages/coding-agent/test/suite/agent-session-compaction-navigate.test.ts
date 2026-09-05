import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

describe("compaction leaf pinning (scan2 C3)", () => {
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

	it("attaches the compaction to the branch it summarized when navigation races it", async () => {
		let forkTargetId: string | undefined;
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						// Simulate the user switching branches while the summary is
						// being generated.
						await harness.session.navigateTree(forkTargetId!);
						return {};
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("second answer"),
			fauxAssistantMessage("model-generated summary"),
			fauxAssistantMessage("turn prefix summary"),
		]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const branch = harness.sessionManager.getBranch();
		const userEntries = branch.filter((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntries.length).toBe(2);
		// Navigating to a user message branches to its parent (the text returns to
		// the editor), so the session lands on the parent entry.
		const secondUserEntry = userEntries[1];
		forkTargetId = secondUserEntry.id;
		const expectedLeafAfterNavigate = secondUserEntry.parentId;
		expect(expectedLeafAfterNavigate).toBeTruthy();
		const leafBeforeCompact = harness.sessionManager.getLeafId();

		await harness.session.compact();

		const compactionEntry = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(compactionEntry).toBeDefined();
		// The entry stays on the branch it summarized instead of following the
		// session to the navigated leaf.
		expect(compactionEntry!.parentId).toBe(leafBeforeCompact);
		// The session remains where the navigation put it.
		expect(harness.sessionManager.getLeafId()).toBe(expectedLeafAfterNavigate);
		// The navigated branch is not polluted by a summary of the other branch.
		expect(harness.session.messages.some((message) => message.role === "compactionSummary")).toBe(false);
		// The summarized branch still carries the compaction.
		const compactedBranch = harness.sessionManager.getBranch(compactionEntry!.id);
		expect(compactedBranch.some((entry) => entry.id === compactionEntry!.id)).toBe(true);
	});
});
