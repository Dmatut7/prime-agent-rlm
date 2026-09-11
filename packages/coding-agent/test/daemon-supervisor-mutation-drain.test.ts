import { afterEach, describe, expect, it } from "vitest";
import type { DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { DEFAULT_CLIENT_CATCHUP_RETRY_POLICY } from "../src/modes/daemon/daemon-supervisor.js";
import {
	DEFAULT_PENDING_DELIVERY_CAPACITY,
	PENDING_DELIVERY_REQUEUE_LOG_THROTTLE_MS,
	PendingDeliveryQueue,
} from "../src/modes/daemon/pending-delivery-queue.js";
import {
	disposeSupervisorHarnesses,
	type SupervisorHarness,
	startSupervisorHarness,
} from "./fixtures/supervisor-harness.js";

/**
 * P1-7c. A `send_message` was a fence-gated mutation, so one delivery whose
 * target took a while to hydrate held the update-restart drain latch and failed
 * the whole prepare at 80s. The delivery is now tracked in a pending-delivery
 * queue and exempt from the latch, which means two things have to stay true: a
 * real mutation still gates the drain (otherwise the latch is simply gone), and
 * a delivery the supervisor owns never disappears without its sender hearing
 * about it (B10/F10).
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

const DRAIN_TIMEOUT_MS = 500;

async function twoSessionHarness(
	prefix: string,
	hangWorkerCommands: readonly string[],
	capacity?: number,
): Promise<SupervisorHarness> {
	const harness = await startSupervisorHarness({
		prefix,
		sessionCount: 2,
		hangWorkerCommands,
		supervisorOptions: {
			updateRestartDrainTimeoutMs: DRAIN_TIMEOUT_MS,
			pendingDeliveryRetryIntervalMs: 25,
			...(capacity === undefined ? {} : { pendingDeliveryCapacity: capacity }),
		},
	});
	await harness.waitForWorkerReady();
	return harness;
}

function failureText(response: DaemonResponse): string {
	return response.success ? "" : response.error;
}

function deliveryCommand(harness: SupervisorHarness, message: string) {
	const [source, target] = harness.sessions;
	if (!source || !target) throw new Error("Harness did not create two sessions");
	return {
		type: "send_message",
		fromActiveSessionId: source.activeSessionId,
		targetActiveSessionId: target.activeSessionId,
		message,
	} as const;
}

describe("P1-7c send_message and the update-restart drain", () => {
	it("completes the drain while an agent-message delivery is still in flight", async () => {
		const harness = await twoSessionHarness("ma-t4-3-drain-send-", ["worker_deliver_message"]);
		const send = harness.request(deliveryCommand(harness, "wake up"), 30_000);
		void send.catch(() => undefined);
		await harness.settle(300);

		const startedAt = Date.now();
		const prepare = await harness.request({ type: "prepare_update_restart" }, 20_000);
		const elapsedMs = Date.now() - startedAt;

		// RED on HEAD: the send held the latch and the prepare died on the drain timeout.
		expect(elapsedMs).toBeLessThan(DRAIN_TIMEOUT_MS * 4);
		expect(prepare).toMatchObject({ success: false });
		expect(failureText(prepare)).not.toContain("Timed out draining daemon mutations");
		// The prepare got all the way to fencing the workers, which is where the
		// fixture worker's manifest-less answer stops it.
		expect(failureText(prepare)).toContain("invalid update manifest");

		// B10: the drained delivery answers its sender instead of evaporating.
		const sendResponse = await send;
		expect(sendResponse).toMatchObject({ success: false });
		expect(failureText(sendResponse)).toContain("was not delivered");
		expect(failureText(sendResponse)).toContain("update restart");
		expect(harness.logText()).toContain("drained 1 pending agent-message delivery");
	});

	it("still waits for a hanging mutation that is not a delivery", async () => {
		const harness = await twoSessionHarness("ma-t4-3-drain-abort-", ["abort"]);
		const abort = harness.request({ type: "abort", activeSessionId: harness.sessions[0]!.activeSessionId }, 30_000);
		void abort.catch(() => undefined);
		await harness.settle(300);

		const startedAt = Date.now();
		const prepare = await harness.request({ type: "prepare_update_restart" }, 20_000);
		const elapsedMs = Date.now() - startedAt;

		// Positive control: the latch was not simply removed.
		expect(elapsedMs).toBeGreaterThanOrEqual(DRAIN_TIMEOUT_MS);
		expect(prepare).toMatchObject({ success: false });
		expect(failureText(prepare)).toContain("Timed out draining daemon mutations");
	});

	it("requeues a delivery whose target is unreachable and receipts it at restart", async () => {
		const harness = await twoSessionHarness("ma-t4-3-requeue-", []);
		// The worker drops off its socket, so the target is recovering: the state a
		// delivery used to fail on immediately.
		await harness.worker?.close();
		await harness.waitForDescriptorLifecycle("recovering");

		const send = harness.request(deliveryCommand(harness, "come back later"), 30_000);
		void send.catch(() => undefined);
		await harness.settle(300);
		expect(harness.logText()).toContain("deliver message requeued");

		const prepare = await harness.request({ type: "prepare_update_restart" }, 20_000);
		expect(prepare.success).toBe(false);

		const sendResponse = await send;
		expect(sendResponse).toMatchObject({ success: false });
		expect(failureText(sendResponse)).toContain("was not delivered");
		// The retry loop stopped at the drain instead of requeueing forever.
		expect(harness.logText()).toContain("deliver message dropped");
	});

	it("rejects a delivery past the per-session capacity with an actionable hint", async () => {
		const harness = await twoSessionHarness("ma-t4-3-capacity-", ["worker_deliver_message"], 2);
		for (let index = 0; index < 2; index++) {
			const request = harness.request(deliveryCommand(harness, `held ${index}`), 5_000);
			void request.catch(() => undefined);
		}
		await harness.settle(400);

		// A short budget on purpose: the rejection carries a 5s retry hint, and a
		// client with room to wait would honour it instead of surfacing the rejection.
		const rejected = await harness
			.request(deliveryCommand(harness, "one too many"), 1_000)
			.then(() => undefined)
			.catch((error: unknown) => error as Error);

		expect(rejected?.name).toBe("DaemonRequestTimeoutError");
		expect(rejected?.message).toContain("kept deferring the command");
		expect(harness.logText()).toContain("deliver queue overflow");
	});
});

describe("P1-7c pending delivery queue", () => {
	it("bounds one target's pending set and counts the overflow", () => {
		const queue = new PendingDeliveryQueue({ capacity: 2, deliveryBudgetMs: 1_000, now: () => 5_000 });
		const first = queue.admit("target-a", "sender-a");
		const second = queue.admit("target-a", "sender-b");
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(queue.depth("target-a")).toBe(2);
		// A different target has its own budget.
		expect(queue.admit("target-b", "sender-a").ok).toBe(true);

		const third = queue.admit("target-a", "sender-c");
		expect(third.ok).toBe(false);
		if (third.ok) throw new Error("unreachable");
		expect(third).toMatchObject({ reason: "capacity", queueDepth: 2, capacity: 2 });
		expect(queue.counters.overflow).toBe(1);
		expect(queue.size()).toBe(3);
		expect(DEFAULT_PENDING_DELIVERY_CAPACITY).toBe(100);
	});

	it("carries a deadline and aborts every entry exactly once on drain", async () => {
		const queue = new PendingDeliveryQueue({ capacity: 5, deliveryBudgetMs: 60_000, now: () => 1_000 });
		const admitted = queue.admit("target-a", "sender-a");
		if (!admitted.ok) throw new Error("admission failed");
		expect(admitted.entry.deadlineAt).toBe(61_000);
		expect(admitted.entry.enqueuedAt).toBe(1_000);

		const drained = queue.drain("update_restart");
		expect(drained).toHaveLength(1);
		expect(queue.size()).toBe(0);
		expect(queue.counters.drained).toBe(1);
		await expect(admitted.entry.aborted).resolves.toBe("update_restart");
		// A second drain finds nothing: an entry cannot be receipted twice.
		expect(queue.drain("shutdown")).toHaveLength(0);
	});

	it("leaves the queue empty through complete and drop", () => {
		const queue = new PendingDeliveryQueue({ capacity: 5 });
		const completed = queue.admit("target-a", "sender-a");
		const dropped = queue.admit("target-b", "sender-b");
		if (!completed.ok || !dropped.ok) throw new Error("admission failed");

		queue.complete(completed.entry);
		queue.drop(dropped.entry);

		expect(queue.size()).toBe(0);
		expect(queue.counters).toMatchObject({ admitted: 2, completed: 1, dropped: 1, drained: 0 });
		// Counting is idempotent per entry, so a late complete cannot inflate it.
		queue.complete(completed.entry);
		expect(queue.counters.completed).toBe(1);
	});
});

describe("P1-7c requeue log throttle", () => {
	it("writes one requeue line per target per window and folds the rest into a count", () => {
		let now = 0;
		const queue = new PendingDeliveryQueue({
			capacity: 5,
			requeueLogThrottleMs: 60_000,
			now: () => now,
		});
		const admitted = queue.admit("target-a", "sender-a");
		if (!admitted.ok) throw new Error("admission failed");

		// First requeue of the window is written out.
		expect(queue.noteRequeueForLog("target-a")).toEqual({ emit: true, suppressed: 0 });
		// A full queue retrying every 5s must not write 20 lines a second.
		const suppressed: number[] = [];
		for (let index = 0; index < 19; index++) {
			queue.requeue(admitted.entry);
			suppressed.push(queue.noteRequeueForLog("target-a").emit ? 1 : 0);
		}
		expect(suppressed.reduce((total, value) => total + value, 0)).toBe(0);
		// The counter stays exact even though the log is throttled.
		expect(queue.counters.requeued).toBe(19);
		expect(queue.noteRequeueForLog("target-a")).toEqual({ emit: false, suppressed: 20 });

		// Past the window one line comes back, carrying what was swallowed.
		now = 60_000;
		expect(queue.noteRequeueForLog("target-a")).toEqual({ emit: true, suppressed: 20 });
		expect(queue.noteRequeueForLog("target-a")).toEqual({ emit: false, suppressed: 1 });

		// A different target has its own window.
		expect(queue.noteRequeueForLog("target-b")).toEqual({ emit: true, suppressed: 0 });
	});

	it("matches the client catch-up throttle window", () => {
		// The parent's ask: the same throttle the catch-up retry already has.
		expect(PENDING_DELIVERY_REQUEUE_LOG_THROTTLE_MS).toBe(DEFAULT_CLIENT_CATCHUP_RETRY_POLICY.logThrottleMs);
	});

	it("drops the throttle state with the target's last entry", () => {
		const now = 0;
		const queue = new PendingDeliveryQueue({ capacity: 5, requeueLogThrottleMs: 60_000, now: () => now });
		const admitted = queue.admit("target-a", "sender-a");
		if (!admitted.ok) throw new Error("admission failed");
		expect(queue.noteRequeueForLog("target-a")).toEqual({ emit: true, suppressed: 0 });
		expect(queue.noteRequeueForLog("target-a")).toEqual({ emit: false, suppressed: 1 });

		queue.complete(admitted.entry);

		// A long-lived supervisor must not keep one row per historical target.
		expect(queue.throttleStateSize()).toBe(0);
		expect(queue.noteRequeueForLog("target-a")).toEqual({ emit: true, suppressed: 0 });
	});

	it("bounds the requeue lines a supervisor writes while a target stays unreachable", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-t4-3-requeue-throttle-",
			sessionCount: 2,
			supervisorOptions: {
				pendingDeliveryRetryIntervalMs: 10,
				pendingDeliveryLogThrottleMs: 200,
			},
		});
		await harness.waitForWorkerReady();
		await harness.worker?.close();
		await harness.waitForDescriptorLifecycle("recovering");
		const [source, target] = harness.sessions;
		if (!source || !target) throw new Error("Harness did not create two sessions");

		const send = harness.request(
			{
				type: "send_message",
				fromActiveSessionId: source.activeSessionId,
				targetActiveSessionId: target.activeSessionId,
				message: "throttled",
			},
			10_000,
		);
		void send.catch(() => undefined);
		await harness.settle(600);

		// 600ms at a 10ms retry interval is dozens of requeues; RED on HEAD wrote
		// one line for every single one of them.
		const lines = harness
			.logText()
			.split("\n")
			.filter((line) => line.includes("deliver message requeued"));
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.length).toBeLessThanOrEqual(5);
		expect(lines.some((line) => line.includes("suppressed"))).toBe(true);
	});
});
