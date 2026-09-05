/**
 * R1 regression: aborting a turn that the input pump dispatched from the queue
 * (steering/follow-up/agent-message rows, `queueVisible: true`) used to leave the
 * action stuck in `committing`/`running`. requestAbort only cancels
 * queue-invisible turns, and the pump's deferred-error path only rolls back
 * undelivered work, so `unfinishedActionCount` stayed nonzero and `wait_for_idle`
 * / RLM quiescence / eviction hung.
 *
 * The fix settles delivered queue-dispatched turns synchronously in
 * `requestAbort`. Direct (non-queued) prompts are deliberately left to the
 * ordinary abort flow: their caller awaits `prompt()` and settling them with an
 * error would reject a prompt that previously resolved on abort
 * (see agent-session-bash-persistence "persists aborted assistant messages").
 */
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

describe("R1 abort settles a queue-dispatched turn synchronously", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("drops unfinishedActionCount to zero for a dispatched follow-up", { timeout: 20000 }, async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		// Turn two hangs until aborted, keeping the dispatched follow-up running.
		const secondGate = new Promise<void>(() => {});
		const gated = (gate: Promise<void>, text: string) => {
			return async (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
				await Promise.race([
					gate,
					new Promise<void>((resolve) => {
						const signal = options?.signal;
						if (!signal) return;
						if (signal.aborted) {
							resolve();
							return;
						}
						signal.addEventListener("abort", () => resolve(), { once: true });
					}),
				]);
				return fauxAssistantMessage(text);
			};
		};
		harness.setResponses([gated(firstGate, "turn one done"), gated(secondGate, "turn two done")]);

		const store = (
			harness.session as unknown as {
				_actionStore: { actions(): Array<{ lifecycle: { state: string }; payload: { queueVisible?: boolean } }> };
			}
		)._actionStore;
		const runningQueuedTurn = () =>
			store.actions().find((action) => action.lifecycle.state === "running" && action.payload.queueVisible === true);

		void harness.session.prompt("first turn").catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 30));
		await harness.session.followUp("parked follow-up");
		expect(harness.session.queuedActionCount).toBe(1);

		// Finish turn one; the pump dispatches the parked follow-up as turn two.
		releaseFirst();
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !runningQueuedTurn()) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(runningQueuedTurn()).toBeDefined();
		expect(harness.session.unfinishedActionCount).toBe(1);

		// Abort while the queue-dispatched turn is running. requestAbort must
		// settle it synchronously; the ordinary flow would leave it running.
		harness.session.requestAbort();
		expect(harness.session.unfinishedActionCount).toBe(0);

		await harness.session.abort();
		const idle = await Promise.race([
			harness.session.waitForIdle().then(() => ({ ok: true as const })),
			new Promise<{ ok: false }>((resolve) => setTimeout(() => resolve({ ok: false }), 2000)),
		]);
		expect(idle).toEqual({ ok: true });
		expect(harness.session.unfinishedActionCount).toBe(0);
	});
});
