/**
 * 2026-09-19 audit, second-batch ledger (docs/fork/audit-20260919-findings.md): a pump
 * that early-returned on a busy-slot block left the admission-selected (`preselected`)
 * action stranded in `selected`. `selected` work is invisible to every queue-based
 * reschedule source, so the input sat undispatched until the next unrelated admission
 * happened to wake a pump - one user input silently swallowed.
 *
 * The fix is two halves, and each is pinned here:
 *
 * 1. The blocked pump rolls the preselected action back into the queue instead of
 *    returning with the selection held. For a direct prompt the rollback is observable
 *    only as "parked: still pending, still undelivered" (a direct prompt is not
 *    queue-visible), then as dispatch once the busy slot clears - with NO further
 *    admission, because the bash clear site reschedules the pump. Pre-fix the prompt
 *    promise below hangs until the test timeout: nothing ever dispatched the turn.
 * 2. A `starts_when_admitted` agent message (send with queueIfBusy, no
 *    streamingBehavior) parks a deferral observer on the action leaving `selected`;
 *    pre-fix that observer could never fire, so the sender hung on a delivery promise
 *    that could no longer settle. The rollback fires it, and the sender is told to
 *    retry with streamingBehavior instead of hanging.
 *
 * Fault injection is the documented public seam from
 * test/fixtures/wait-for-idle-spin-fixture.ts: the agent's own idle wait is held at the
 * pump's first await so the bash lands inside the window between admission (which
 * selects the action) and the pump's block check. No private member is probed.
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

const quietSettings = { stallWatchdog: { enabled: false }, retry: { enabled: false } } as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe("2026-09-19 pump blocked early-return orphan (swallowed input)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("dispatches a rolled-back direct prompt when the busy slot clears, with no further admission", {
		timeout: 30_000,
	}, async () => {
		const harness = await createHarness({ settings: { ...quietSettings } });
		harnesses.push(harness);
		const agent = harness.session.agent;
		let releasePump: () => void = () => {};
		const pumpHold = new Promise<void>((resolve) => {
			releasePump = resolve;
		});
		agent.waitForIdle = () => pumpHold;
		harness.setResponses([fauxAssistantMessage("turn done")]);

		const prompt = harness.session.prompt("stranded turn");
		await vi.waitFor(() => {
			expect(harness.session.unfinishedActionCount).toBe(1);
		});
		// Let the pump reach the held await.
		await sleep(100);
		const bash = harness.session.executeBash("sleep 1");
		await vi.waitFor(() => {
			expect(harness.session.isBashRunning).toBe(true);
		});
		agent.waitForIdle = () => Promise.resolve();
		releasePump();

		// While the bash holds the busy slot the turn must stay parked: still pending,
		// still undelivered. A pump that dispatched behind the bash lands the user
		// message inside this window; a pump that lost the action drops the count.
		await sleep(200);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.unfinishedActionCount).toBe(1);

		// No further admission happens from here. The bash clear site reschedules the
		// pump, the rolled-back turn dispatches, and the prompt promise - which settles
		// only on a completed turn - resolves. Pre-fix this await hangs until the test
		// timeout, which is the swallowed input.
		await bash;
		await prompt;
		expect(getUserTexts(harness)).toEqual(["stranded turn"]);
		expect(getAssistantTexts(harness)).toEqual(["turn done"]);
		expect(harness.session.unfinishedActionCount).toBe(0);
	});

	it("reports the deferral to a starts_when_admitted agent message instead of hanging", {
		timeout: 30_000,
	}, async () => {
		const harness = await createHarness({ settings: { ...quietSettings } });
		harnesses.push(harness);
		const agent = harness.session.agent;
		let releasePump: () => void = () => {};
		const pumpHold = new Promise<void>((resolve) => {
			releasePump = resolve;
		});
		agent.waitForIdle = () => pumpHold;
		harness.setResponses([fauxAssistantMessage("turn done")]);

		const accepted = harness.session.acceptAgentMessagePrompt("child reply", { queueIfBusy: true });
		const outcome = accepted.then(
			() => "resolved" as const,
			(error: unknown) => error,
		);
		await vi.waitFor(() => {
			expect(harness.session.unfinishedActionCount).toBe(1);
		});
		// Let the pump reach the held await.
		await sleep(100);
		const bash = harness.session.executeBash("sleep 1");
		await vi.waitFor(() => {
			expect(harness.session.isBashRunning).toBe(true);
		});
		agent.waitForIdle = () => Promise.resolve();
		releasePump();

		// The rollback fires the deferral observer: the sender gets a loud, retryable
		// answer instead of a delivery promise that can never settle. Pre-fix this await
		// hangs until the test timeout.
		const result = await outcome;
		expect(result).toBeInstanceOf(Error);
		expect((result as Error).message).toContain("Agent became busy before prompt delivery");
		// A deferred agent message is cancelled, not parked: nothing lingers to be
		// picked up by a later unrelated turn.
		await vi.waitFor(() => {
			expect(harness.session.unfinishedActionCount).toBe(0);
		});
		await bash;
	});
});
