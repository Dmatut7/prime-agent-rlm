/**
 * W9-A (agent-222): the session input pump and a cancelled preselected turn.
 *
 * 1. The pump reads a `starts_when_admitted` action as its preselected batch head,
 *    then awaits the agent event queue. An abort landing in that window cancels
 *    and releases the action; the pump used to roll it back or drive it into
 *    `preparing` anyway, throwing an illegal cancelled -> queued/preparing
 *    transition OUTSIDE the batch try - the pump promise rejected
 *    (waitForSessionInputIdle callers failed with an unexplained "Illegal
 *    transition") and the chain's catch swallowed it without a trace. The pump now
 *    re-checks the action's state after every await, and _cancelSessionActions
 *    moves the pump epoch for every selected/preparing cancel (clearQueue's own
 *    bump covered only preparing turns).
 * 2. The pump reschedules itself from its own finally, so any deterministic throw
 *    became an unbounded microtask spin (the 2026-09-19 wedge class). Failures are
 *    now logged, counted, and the self-reschedule is fused after 8 straight
 *    failures; external triggers still schedule fresh passes, so a transient fault
 *    heals.
 *
 * Fault injection uses public seams only: an extension message_end handler gates the
 * event queue, and the Agent instance's public waitForIdle is replaced on the
 * instance (the same seam the spin-deadlock suite uses for prompt).
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/index.js";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

describe("W9-A pump: preselected turn cancelled mid-pass", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("drops a preselected turn cancelled while the pump awaited, without throwing", async () => {
		// The first turn's message_end processing parks the agent event queue on a
		// gate we control, so the second prompt's pump pass parks between reading
		// its preselected action and driving it - the abort lands in that window.
		let releaseGate: (() => void) | undefined;
		let gateEntered = false;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const blockingExtension: ExtensionFactory = (pi) => {
			pi.on("message_end", async (event) => {
				if (event.message.role === "assistant" && !gateEntered) {
					gateEntered = true;
					await gate;
				}
			});
		};
		const harness = await createHarness({ extensionFactories: [blockingExtension] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("third answer")]);

		const first = harness.session.prompt("one");
		await vi.waitFor(() => {
			expect(gateEntered).toBe(true);
		});

		// The event queue is parked, but the session is otherwise idle: the second
		// prompt admits as starts_when_admitted, so the pump preselects it and then
		// parks on the gated event queue.
		const second = harness.session.prompt("two");
		// Let the pump reach its park on the event queue before cancelling. The gate
		// is held the whole time, so any wait past a few macrotasks is deterministic.
		await sleep(50);
		harness.session.requestAbort();
		releaseGate?.();

		// The abort settles the caller with its own error, not the illegal
		// transition the preselected re-drive used to throw.
		await expect(second).rejects.toThrow(/aborted before delivery/);
		// The aborted turn never dispatched: only two provider calls happen in this
		// test (turn one and turn three).
		expect(harness.faux.state.callCount).toBe(1);
		// The pump pass itself survives: idle waits resolve instead of rejecting.
		await harness.session.waitForSessionInputIdle();
		await first;

		// The session healed: a fresh prompt lifts the abort suspension and runs.
		await harness.session.prompt("three");
		expect(getAssistantTexts(harness)).toContain("third answer");
	});

	it("fuses the pump's self-reschedule after repeated failures and heals on the next admission", async () => {
		const harness = await createHarness({
			settings: { stallWatchdog: { enabled: false }, retry: { enabled: false } },
		});
		harnesses.push(harness);
		const agent = harness.session.agent;
		const realWaitForIdle = agent.waitForIdle.bind(agent);
		let faultArmed = true;
		let faultCalls = 0;
		// The pump's first await every pass; throwing here fails the pass before any
		// selection happens, so the selectable input stays queued for every rethrow.
		agent.waitForIdle = async () => {
			if (faultArmed) {
				faultCalls += 1;
				throw new Error("injected pump fault");
			}
			return realWaitForIdle();
		};
		harness.setResponses([fauxAssistantMessage("queued answer"), fauxAssistantMessage("later answer")]);

		await harness.session.followUp("queued work", undefined, { resumeIfIdle: true });
		await sleep(150);
		const callsAtRest = faultCalls;

		// The fuse stopped the self-reschedule: bounded fault calls instead of a
		// spin (an unfused pump reaches hundreds of passes inside 150ms), and the
		// queued work is still waiting.
		expect(callsAtRest).toBeGreaterThan(0);
		expect(callsAtRest).toBeLessThanOrEqual(16);
		await sleep(150);
		expect(faultCalls).toBe(callsAtRest);
		expect(harness.session.hasPendingSessionWork).toBe(true);

		// A new admission schedules a fresh pass: with the fault gone the backlog drains.
		faultArmed = false;
		await harness.session.followUp("more work", undefined, { resumeIfIdle: true });
		await harness.session.waitForIdle();
		expect(getAssistantTexts(harness)).toContain("queued answer");
		expect(getAssistantTexts(harness)).toContain("later answer");
		expect(harness.session.hasPendingSessionWork).toBe(false);
	});
});
