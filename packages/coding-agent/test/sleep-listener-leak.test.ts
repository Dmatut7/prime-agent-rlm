import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { sleep } from "../src/utils/sleep.js";

// Regression lock for the abort-listener leak in the shared sleep helper.
//
// Counting rules (learned from review):
// - Count only after every sleep has settled. While sleeps are in flight, both the
//   leaky and the fixed implementation hold one listener per sleep, so an in-flight
//   count cannot tell them apart.
// - Use real timers. With vi.useFakeTimers() an awaited sleep never settles unless
//   timers are advanced, and the count would stay at the in-flight value.
// - getEventListeners is a Node-specific API that returns a snapshot array; assert on
//   its length, and guard against the API disappearing.
// - RED-PROOF: reverting the timer callback in src/utils/sleep.ts to the pre-fix
//   shape `setTimeout(resolve, ms)` makes the cleanup tests below fail with 15
//   lingering listeners (verified before this test was committed).

function abortListenerCount(signal: AbortSignal): number {
	expect(typeof getEventListeners).toBe("function");
	expect(process.versions.node).toBeTruthy();
	return getEventListeners(signal, "abort").length;
}

describe("sleep abort listener cleanup", () => {
	it("leaves no listeners after repeated resolved sleeps on a long-lived signal", async () => {
		const controller = new AbortController();
		const N = 15; // above Node's default EventTarget max-listener threshold
		for (let i = 0; i < N; i++) {
			await sleep(1, controller.signal);
		}
		expect(abortListenerCount(controller.signal)).toBe(0);
	});

	it("balances add/remove calls on the signal", async () => {
		const controller = new AbortController();
		const addSpy = vi.spyOn(controller.signal, "addEventListener");
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

		const N = 15;
		for (let i = 0; i < N; i++) {
			await sleep(1, controller.signal);
		}
		const abortCalls = (mock: typeof addSpy.mock) => mock.calls.filter(([type]) => type === "abort").length;
		expect(abortCalls(addSpy.mock)).toBe(N);
		expect(abortCalls(removeSpy.mock)).toBe(N);
	});

	it("leaves no listeners after abort while a sleep is in flight", async () => {
		const controller = new AbortController();
		const pending = sleep(60_000, controller.signal);
		controller.abort();
		await expect(pending).rejects.toThrow("Aborted");
		expect(abortListenerCount(controller.signal)).toBe(0);
	});
});

describe("sleep behavior", () => {
	it("resolves without a signal", async () => {
		await expect(sleep(1)).resolves.toBeUndefined();
	});

	it("resolves with a non-aborted signal", async () => {
		const controller = new AbortController();
		await expect(sleep(1, controller.signal)).resolves.toBeUndefined();
	});

	it("rejects with an Error carrying the exact 'Aborted' message when aborted in flight", async () => {
		const controller = new AbortController();
		const pending = sleep(60_000, controller.signal).then(
			() => "resolved",
			(error: unknown) => error,
		);
		controller.abort();
		const error = await pending;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Aborted");
	});

	it("rejects immediately on a pre-aborted signal without touching the listener list", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(sleep(1, controller.signal)).rejects.toThrow("Aborted");
		expect(abortListenerCount(controller.signal)).toBe(0);
	});
});
