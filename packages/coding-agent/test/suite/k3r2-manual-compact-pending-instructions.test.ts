import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/**
 * MVS-2 (r32 model-visible): `compact.run` receipts promise the instructions
 * join the compaction that eventually runs ("Any compaction consumes a pending
 * model request and honors its instructions", agent-session auto path). A
 * manual /compact that succeeded used to clear the pending request without
 * merging its instructions: the run that actually restructured the context
 * dropped the content the model named, silently.
 */

function setStreaming(harness: Harness, streaming: boolean) {
	(harness.session.agent.state as { isStreaming: boolean }).isStreaming = streaming;
}

/** Extension that supplies compaction content so no provider call is needed. */
function extensionCompaction() {
	return (pi: any) => {
		pi.on("session_before_compact", async (event: any) => ({
			compaction: {
				summary: "requested summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {},
			},
		}));
	};
}

describe("K3R2/MVS-2: a manual compaction honors a pending request's instructions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("merges the pending compact.run instructions into the manual compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		expect(
			harness.session.handleCompactHostRequest("compact.run", {
				instructions: "keep the failing test names and the migration checklist",
			}).scheduled,
		).toBe(true);
		setStreaming(harness, false);

		// The user compacts manually (slash /compact or SDK) before the turn ends.
		await harness.session.compact();

		// Before the fix: the manual run cleared the pending request without its
		// instructions - compaction_start carried customInstructions: undefined and
		// the summary never saw the named content.
		expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({
			reason: "manual",
			customInstructions: expect.stringContaining("keep the failing test names and the migration checklist"),
		});
		// The request is still satisfied by the manual run.
		expect(harness.session.handleCompactHostRequest("compact.status").scheduled).toBe(false);
	});

	it("keeps manual instructions first when both sides supplied instructions", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [extensionCompaction()],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		setStreaming(harness, true);
		expect(
			harness.session.handleCompactHostRequest("compact.run", { instructions: "keep the token counts" }).scheduled,
		).toBe(true);
		setStreaming(harness, false);

		await harness.session.compact("user asked for the file list");

		const instructions = harness.eventsOfType("compaction_start").at(-1)?.customInstructions ?? "";
		expect(instructions).toContain("user asked for the file list");
		expect(instructions).toContain("keep the token counts");
		// The user's manual instruction stays first.
		expect(instructions.indexOf("user asked for the file list")).toBeLessThan(
			instructions.indexOf("keep the token counts"),
		);
	});
});
