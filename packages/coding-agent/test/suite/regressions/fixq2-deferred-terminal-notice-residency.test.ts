/**
 * FIX-Q2 regression: a session holding deferred RLM child terminal notices
 * (demoted back to next-turn deferral by requestAbort) must stay active so
 * passivation/idle eviction cannot drop the child's terminal report before the
 * parent receives it. An empty action queue alone must not make it evictable.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRlmChildTerminalNoticeMessage } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

describe("FIX-Q2 deferred terminal notices keep the session resident", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("counts deferred terminal notices as activity after an abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.isSessionActive).toBe(false);

		// Suspend the pump; the abort alone leaves the session inactive.
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		expect(harness.session.isSessionActive).toBe(false);

		// Demote-style deferral: the notice lands in next-turn deferral while the
		// pump is suspended (flush is a no-op), mirroring requestAbort demoting an
		// already-admitted terminal notice action.
		const notice = createRlmChildTerminalNoticeMessage({
			kind: "cancelled",
			childId: "child-fix-q2",
			sessionName: "worker",
			reason: "aborted before delivery",
		});
		harness.session.restorePendingNextTurnMessages([notice]);

		// The deferred notice is undelivered work: the session must stay active so
		// passivation/eviction cannot drop it.
		expect(harness.session.isSessionActive).toBe(true);
		expect(harness.session.getPendingNextTurnMessageSnapshots().map((message) => message.content)).toContain(
			notice.content,
		);
	});

	it("stays inactive when no deferred notices are pending", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		expect(harness.session.isSessionActive).toBe(false);
	});
});
