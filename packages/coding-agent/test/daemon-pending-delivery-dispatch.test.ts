import { describe, expect, it } from "vitest";
import { deliveryDispatchTimeoutTier } from "../src/modes/daemon/daemon-supervisor.js";
import { WORKER_REQUEST_TIMEOUT_TIERS } from "../src/modes/daemon/daemon-timeouts.js";
import { type PendingDeliveryAbortReason, PendingDeliveryQueue } from "../src/modes/daemon/pending-delivery-queue.js";

/**
 * B5. Two defects in the pending-delivery retry loop:
 *
 * 1. The first-dispatch timeout tier was keyed on `entry.attempts`, which ticks
 *    on every pre-dispatch bounce too (target unreachable -> requeue -> wait).
 *    A delivery that bounced even once before reaching a worker dispatched on
 *    the 120s `deliver` tier instead of the `long` budget the spec reserves for
 *    the first attempt (daemon-timeouts.ts T4-3: "The first attempt keeps the
 *    long budget ... cutting it to 120s would trade a late delivery for an
 *    uncertain one"), exactly in the recovering-from-outage case where a slow
 *    target hydration is legitimate work.
 *
 * 2. `raceDeliveryAbort` chained a fresh `.then` onto `entry.aborted` on every
 *    bounce iteration. That promise stays pending for the whole delivery budget
 *    (up to 24h), so a long outage accumulated reactions on it without bound.
 *    The entry now carries a single fan-out reaction installed at admission;
 *    racers subscribe and unsubscribe instead.
 */

describe("B5 dispatch timeout tier", () => {
	it("keeps the long budget for the first dispatch and gives retried dispatches the deliver tier", () => {
		// The tier keys on dispatches written to a worker; pre-dispatch bounces
		// never advance it, so the first dispatch after any number of bounces is
		// still dispatch number zero.
		expect(deliveryDispatchTimeoutTier(0)).toBe("long");
		expect(deliveryDispatchTimeoutTier(1)).toBe("deliver");
		expect(deliveryDispatchTimeoutTier(2)).toBe("deliver");
		expect(WORKER_REQUEST_TIMEOUT_TIERS[deliveryDispatchTimeoutTier(0)]).toBe(WORKER_REQUEST_TIMEOUT_TIERS.long);
		expect(WORKER_REQUEST_TIMEOUT_TIERS[deliveryDispatchTimeoutTier(1)]).toBe(WORKER_REQUEST_TIMEOUT_TIERS.deliver);
	});
});

describe("B5 abort subscription", () => {
	it("calls live subscribers once on drain and never calls unsubscribed ones", async () => {
		const queue = new PendingDeliveryQueue({ capacity: 5 });
		const admitted = queue.admit("target-a", "sender-a");
		if (!admitted.ok) throw new Error("admission failed");
		const entry = admitted.entry;

		const seen: PendingDeliveryAbortReason[] = [];
		const unsubscribe = entry.onAbort((reason) => seen.push(reason));
		const gone: PendingDeliveryAbortReason[] = [];
		const unsubscribeGone = entry.onAbort((reason) => gone.push(reason));
		unsubscribeGone();

		// The bounce loop races the entry once per iteration; every race
		// subscribes and unsubscribes again. Thousands of cycles must leave
		// nothing callable behind when the drain finally lands.
		let churnCalls = 0;
		const cycles = 2_000;
		for (let index = 0; index < cycles; index++) {
			const unsubscribeChurn = entry.onAbort(() => {
				churnCalls++;
			});
			unsubscribeChurn();
		}

		expect(queue.drain("shutdown")).toHaveLength(1);
		await expect(entry.aborted).resolves.toBe("shutdown");
		expect(churnCalls).toBe(0);
		expect(seen).toEqual(["shutdown"]);
		expect(gone).toEqual([]);
		unsubscribe();
	});

	it("calls a handler registered after the drain synchronously, exactly once", () => {
		const queue = new PendingDeliveryQueue({ capacity: 5 });
		const admitted = queue.admit("target-a", "sender-a");
		if (!admitted.ok) throw new Error("admission failed");
		expect(queue.drain("update_restart")).toHaveLength(1);

		const seen: PendingDeliveryAbortReason[] = [];
		const unsubscribe = admitted.entry.onAbort((reason) => seen.push(reason));
		// No missed wakeup: the abort already happened, so the handler runs now.
		expect(seen).toEqual(["update_restart"]);
		unsubscribe();
		expect(seen).toEqual(["update_restart"]);
	});

	it("drains every subscriber of every entry exactly once", () => {
		const queue = new PendingDeliveryQueue({ capacity: 5 });
		const entries = [queue.admit("target-a", "sender-a"), queue.admit("target-b", "sender-b")];
		const seen: string[] = [];
		for (const admitted of entries) {
			if (!admitted.ok) throw new Error("admission failed");
			admitted.entry.onAbort((reason) => seen.push(`${admitted.entry.targetActiveSessionId}:${reason}`));
		}
		expect(queue.drain("supervisor_stopping")).toHaveLength(2);
		expect(seen).toEqual(["target-a:supervisor_stopping", "target-b:supervisor_stopping"]);
	});
});
