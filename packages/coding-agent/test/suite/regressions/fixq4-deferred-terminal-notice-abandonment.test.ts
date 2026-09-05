/**
 * FIX-Q4 regression: deferred RLM terminal notices must not pin a session
 * forever. After an abort the pump is suspended, flush is a no-op, and the
 * notices would keep isSessionActive true indefinitely (never passivated,
 * quiescence waits spin). Past the abandonment threshold the session attempts
 * delivery via the normal flush and otherwise abandons the notices, becoming
 * evictable, with a record of the attempt.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../../../src/core/messages.js";
import { createRlmChildTerminalNoticeMessage } from "../../../src/core/messages.js";
import { createHarness, type Harness } from "../harness.js";

const STALE_MS = 6 * 60_000;

type SessionWithNextTurnInternals = {
	_takePendingNextTurnMessages(): CustomMessage[];
	_pushPendingNextTurnMessages(...messages: CustomMessage[]): void;
	_unshiftPendingNextTurnMessages(...messages: CustomMessage[]): void;
	_enqueuePendingNextTurnMessages(messages: readonly CustomMessage[], atFront: boolean): void;
};

function terminalNotice(id: string) {
	return createRlmChildTerminalNoticeMessage({
		kind: "cancelled",
		childId: id,
		sessionName: "worker",
		reason: "aborted before delivery",
	});
}

describe("FIX-Q4 stale deferred terminal notices stop pinning the session", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("pins while fresh, abandons past the threshold, and becomes evictable", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		const notice = terminalNotice("child-fix-q4");
		harness.session.restorePendingNextTurnMessages([notice]);

		// Fresh deferral pins the session (FIX-Q2 behavior preserved).
		expect(harness.session.deferredRlmTerminalNoticeSince).toBeTypeOf("number");
		expect(harness.session.isSessionActive).toBe(true);

		// Below the threshold nothing is abandoned.
		harness.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + 60_000);
		expect(harness.session.rlmTerminalNoticeAbandonment).toBeUndefined();
		expect(harness.session.isSessionActive).toBe(true);

		// Past the threshold the delivery attempt (flush) fails against the
		// suspended pump and the notice is abandoned with a record.
		harness.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + STALE_MS);
		expect(harness.session.rlmTerminalNoticeAbandonment).toMatchObject({ count: 1 });
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
		expect(harness.session.isSessionActive).toBe(false);
	});

	it("does not abandon or flush when isSessionActive is merely read", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.requestAbort();
		harness.session.restorePendingNextTurnMessages([terminalNotice("child-pure-getter")]);

		// Backdate past the threshold. Reading activity is a poll path (session list,
		// roster, subagent snapshots), so it must not discard a child's report or
		// admit a turn action just because somebody asked whether the session is busy.
		const internals = harness.session as unknown as { _rlmTerminalNoticeDeferredSince: number | undefined };
		internals._rlmTerminalNoticeDeferredSince = Date.now() - STALE_MS;

		// Stale notices stop pinning the session, which is the same answer the old
		// flush-then-recheck shape gave - but now without the side effects.
		for (let i = 0; i < 5; i++) expect(harness.session.isSessionActive).toBe(false);

		expect(harness.session.rlmTerminalNoticeAbandonment).toBeUndefined();
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toHaveLength(1);
	});

	it("abandons on its own timer without anything reading isSessionActive", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		vi.useFakeTimers();
		try {
			harness.session.restorePendingNextTurnMessages([terminalNotice("child-own-driver")]);
			expect(harness.session.deferredRlmTerminalNoticeSince).toBeTypeOf("number");
			expect(harness.session.rlmTerminalNoticeAbandonment).toBeUndefined();

			// Nobody reads isSessionActive here. The threshold must still fire, because
			// a session that nobody polls used to keep its stale notices forever.
			await vi.advanceTimersByTimeAsync(STALE_MS + 1000);

			expect(harness.session.rlmTerminalNoticeAbandonment).toMatchObject({ count: 1 });
			expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stamps the deferral when a terminal notice is re-queued through sendCustomMessage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Any path that puts a terminal notice back into the next-turn queue must stamp
		// the deferral. Without a timestamp no abandonment timer is armed and the
		// staleness predicate never fires, so the session stays pinned forever.
		await harness.session.sendCustomMessage(terminalNotice("child-requeue"), { deliverAs: "nextTurn" });

		expect(harness.session.getPendingNextTurnMessageSnapshots()).toHaveLength(1);
		expect(harness.session.deferredRlmTerminalNoticeSince).toBeTypeOf("number");
	});

	it.each([
		["_pushPendingNextTurnMessages", "push"],
		["_unshiftPendingNextTurnMessages", "unshift"],
	] as const)("%s stamps the deferral for a terminal notice (%s route)", async (member, _route) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithNextTurnInternals;

		expect(harness.session.deferredRlmTerminalNoticeSince).toBeUndefined();
		internals[member](terminalNotice(`child-${member}`));

		expect(harness.session.getPendingNextTurnMessageSnapshots()).toHaveLength(1);
		expect(harness.session.deferredRlmTerminalNoticeSince).toBeTypeOf("number");
	});

	it("does not stamp the deferral for a message that is not a terminal notice", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithNextTurnInternals;

		internals._enqueuePendingNextTurnMessages(
			[
				{
					role: "custom",
					customType: "not-a-terminal-notice",
					content: "x",
					timestamp: Date.now(),
				} as unknown as CustomMessage,
			],
			true,
		);

		expect(harness.session.getPendingNextTurnMessageSnapshots()).toHaveLength(1);
		expect(harness.session.deferredRlmTerminalNoticeSince).toBeUndefined();
	});

	// Source scan, in-repo precedent: daemon-protocol.test.ts reads its own source to pin the
	// schema digest. This is what makes "every injection point routes through the mutators"
	// fail-able instead of a manual grep: routing one point around the mutators reddens it, and
	// so does any future injection point that writes the array directly. Seven of the nine
	// injection points have no nail of their own, so this is their only guard.
	//
	// Scope limit, so the next reader does not assume full coverage: the slice runs from the
	// kernel's doc comment to the mark helper's, which puts both directional shells inside the
	// block. A shell that bypassed the kernel and wrote the array directly would still be
	// "inside", so inside.length stays satisfied and this test would not notice. That property -
	// the shells must delegate to the kernel - is held by the mutator-level pair below and by the
	// temporal chain, not by this scan.
	it("routes every next-turn queue injection through the mutators", () => {
		const source = readFileSync(resolve(__dirname, "../../../src/core/agent-session.ts"), "utf8");
		const ANCHOR_START = "The only way messages enter the next-turn queue";
		const ANCHOR_END = "/** Record that terminal notices are deferred, and arm the abandonment driver. */";
		const start = source.indexOf(ANCHOR_START);
		const end = source.indexOf(ANCHOR_END);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const mutatorBlock = source.slice(start, end);

		// splice(0, 0, ...) inserts too, so it is in the scan. A concat-shaped insert does not
		// match here because .concat is called on the other operand; that whole family is covered
		// by the reassignment rule below instead. A bare index assignment is not worth chasing.
		const injection = /_pendingNextTurnMessages\.(push|unshift|splice)\(/;
		const inside = mutatorBlock.split("\n").filter((line) => injection.test(line));
		const outside = source
			.replace(mutatorBlock, "")
			.split("\n")
			.filter((line) => injection.test(line))
			.map((line) => line.trim());

		// The kernel inserts with the spread parameter; nothing else may insert at all except the
		// goal-context push, which never carries a terminal notice.
		expect(inside.length).toBeGreaterThanOrEqual(1);
		// Two legitimate direct uses, both listed verbatim so any third one reddens this test:
		// the goal-context push, which never carries a terminal notice, and the flush loop's
		// removal of a notice it has just delivered as a real action.
		expect(outside).toEqual([
			'this._pendingNextTurnMessages.push(createGoalContextMessage(this._goalState, "continuation"));',
			"this._pendingNextTurnMessages.splice(index, 1);",
		]);

		// Reassigning the field can also insert (restorable.concat(pending), for example), and no
		// method-call scan catches that shape. The rule is directional: a reassignment may only
		// clear or shrink the queue, never grow it, so the RHS has to be [] or a filter of itself.
		const reassign = /_pendingNextTurnMessages\s*=[^=]/;
		const grown = source
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => reassign.test(line))
			.filter(
				(line) =>
					!line.startsWith("this._pendingNextTurnMessages = [];") &&
					!line.startsWith("this._pendingNextTurnMessages = this._pendingNextTurnMessages.filter("),
			);
		expect(grown).toEqual([]);
	});

	// The temporal chain, driven through the unshift route: defer and arm, a turn drains the
	// queue, the timer fires against an empty queue and clears the stamp without rearming, the
	// restore puts the notice back, and the rearmed driver abandons on its own - with nobody
	// reading isSessionActive for its side effects anywhere in this test.
	it("re-stamps the deferral when a drained terminal notice is put back through the unshift path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as SessionWithNextTurnInternals;

		// Suspend the pump first, like the sibling nails: with it running, the flush inside
		// restorePendingNextTurnMessages would deliver the notice and leave nothing to drain.
		harness.session.requestAbort();
		expect(harness.session.isQueuedWorkSuspended).toBe(true);

		vi.useFakeTimers();
		try {
			harness.session.restorePendingNextTurnMessages([terminalNotice("child-drained")]);
			const stampedAt = harness.session.deferredRlmTerminalNoticeSince;
			expect(stampedAt).toBeTypeOf("number");
			expect(harness.session.isSessionActive).toBe(true);

			// Re-marking must not move the stamp: the ??= is load-bearing, because a plain
			// assignment would reset the abandonment clock on every re-injection and a busy
			// session would never reach the threshold.
			await vi.advanceTimersByTimeAsync(60_000);
			internals._unshiftPendingNextTurnMessages(terminalNotice("child-second"));
			expect(harness.session.deferredRlmTerminalNoticeSince).toBe(stampedAt);

			// A turn takes the whole queue as prefix context. The stamp must survive: take is a
			// drain, not a delivery.
			const taken = internals._takePendingNextTurnMessages();
			expect(taken).toHaveLength(2);
			expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
			expect(harness.session.deferredRlmTerminalNoticeSince).toBe(stampedAt);

			// The armed timer fires against an empty queue: maybeAbandon's first branch clears the
			// stamp and disarms, and the callback does not rearm because the stamp is gone.
			await vi.advanceTimersByTimeAsync(STALE_MS + 1000);
			expect(harness.session.deferredRlmTerminalNoticeSince).toBeUndefined();
			expect(harness.session.rlmTerminalNoticeAbandonment).toBeUndefined();

			// The turn fails and puts the notices back (production shape: _cancelSessionActions'
			// restorable path and the _startPreparedTurnActions restore paths both unshift).
			internals._unshiftPendingNextTurnMessages(...taken);
			expect(harness.session.getPendingNextTurnMessageSnapshots()).toHaveLength(2);
			expect(harness.session.deferredRlmTerminalNoticeSince).toBeTypeOf("number");
			expect(harness.session.isSessionActive).toBe(true);

			// Nobody reads isSessionActive from here on: the rearmed driver must finish the job.
			await vi.advanceTimersByTimeAsync(STALE_MS + 1000);
			expect(harness.session.rlmTerminalNoticeAbandonment).toMatchObject({ count: 2 });
			expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
			expect(harness.session.isSessionActive).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("delivers through the flush attempt when the pump can run again", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("notice delivered")]);

		const pause = harness.session.acquireSessionInputPause();
		const notice = terminalNotice("child-fix-q4-deliver");
		harness.session.restorePendingNextTurnMessages([notice]);
		expect(harness.session.isSessionActive).toBe(true);
		pause.release();

		// Past the threshold, but the pump is runnable again: the flush attempt
		// delivers, so nothing is abandoned.
		harness.session.maybeAbandonStaleDeferredRlmTerminalNotices(Date.now() + STALE_MS);
		expect(harness.session.rlmTerminalNoticeAbandonment).toBeUndefined();

		await harness.session.waitForIdle();
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([]);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.content === notice.content),
		).toBe(true);
	});
});
