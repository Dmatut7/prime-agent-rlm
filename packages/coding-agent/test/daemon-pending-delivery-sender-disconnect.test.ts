import { afterEach, describe, expect, it } from "vitest";
import { type PendingDeliveryAbortReason, PendingDeliveryQueue } from "../src/modes/daemon/pending-delivery-queue.js";
import {
	disposeSupervisorHarnesses,
	type SupervisorHarness,
	startSupervisorHarness,
} from "./fixtures/supervisor-harness.js";

/**
 * FIX-8a. A delivery entry outlived its sender. An agent-to-agent send waits ~30s
 * (daemon-mode.ts `sendRemoteAgentSessionMessage`) and then closes its connection,
 * while the entry kept requeueing against an unreachable target for the whole 24h
 * delivery budget. Capacity is per target, so a target that stayed down collected
 * one orphaned slot per abandoned send and then rejected every sender that was
 * still connected. A sender disconnect now abandons that connection's entries.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

async function waitForLogLine(logText: () => string, needle: string, timeoutMs = 20_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const log = logText();
		if (log.includes(needle)) {
			return log;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for a log line containing ${JSON.stringify(needle)}. Log:\n${log}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
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

describe("FIX-8a pending delivery queue sender abort", () => {
	it("frees the target's capacity for the senders that are still connected", () => {
		const queue = new PendingDeliveryQueue({ capacity: 2 });
		expect(queue.admit("target-a", "sender-a", "conn-gone").ok).toBe(true);
		expect(queue.admit("target-a", "sender-b", "conn-gone").ok).toBe(true);
		// Two orphaned entries occupy every slot the target has.
		expect(queue.admit("target-a", "sender-c", "conn-here").ok).toBe(false);
		expect(queue.counters.overflow).toBe(1);

		expect(queue.abortSender("conn-gone", "sender_disconnected")).toHaveLength(2);
		expect(queue.depth("target-a")).toBe(0);
		expect(queue.size()).toBe(0);
		// RED on HEAD: the slots stayed taken until the 24h delivery budget ran out.
		expect(queue.admit("target-a", "sender-c", "conn-here").ok).toBe(true);
		expect(queue.counters.overflow).toBe(1);
	});

	it("abandons only the disconnected connection and receipts each entry once", async () => {
		const queue = new PendingDeliveryQueue({ capacity: 5 });
		const gone = queue.admit("target-a", "sender-a", "conn-gone");
		const stays = queue.admit("target-a", "sender-b", "conn-stays");
		const otherTarget = queue.admit("target-b", "sender-a", "conn-gone");
		const unattributed = queue.admit("target-b", "sender-c");
		if (!gone.ok || !stays.ok || !otherTarget.ok || !unattributed.ok) {
			throw new Error("admission failed");
		}

		const seen: PendingDeliveryAbortReason[] = [];
		const unsubscribe = gone.entry.onAbort((reason) => seen.push(reason));

		const abandoned = queue.abortSender("conn-gone", "sender_disconnected");
		expect(abandoned.map((entry) => entry.deliveryId).sort()).toEqual(
			[gone.entry.deliveryId, otherTarget.entry.deliveryId].sort(),
		);
		expect(seen).toEqual(["sender_disconnected"]);
		await expect(gone.entry.aborted).resolves.toBe("sender_disconnected");
		// Another connection's entry survives, and so does one admitted without a connection.
		expect(queue.depth("target-a")).toBe(1);
		expect(queue.depth("target-b")).toBe(1);
		expect(queue.counters).toMatchObject({ admitted: 4, dropped: 2, completed: 0, drained: 0 });

		// A socket reports close and error, and the delivery loop drops its own entry
		// after the abort rejects it: neither may count the same entry twice.
		expect(queue.abortSender("conn-gone", "sender_disconnected")).toHaveLength(0);
		queue.drop(gone.entry);
		expect(queue.counters.dropped).toBe(2);
		unsubscribe();
	});
});

describe("FIX-8a supervisor sender disconnect", () => {
	it("abandons a pending delivery when its sender disconnects and frees the target's capacity", async () => {
		const harness = await startSupervisorHarness({
			prefix: "fix-8-sender-disconnect-",
			sessionCount: 2,
			supervisorOptions: {
				pendingDeliveryCapacity: 1,
				pendingDeliveryRetryIntervalMs: 25,
				pendingDeliveryLogThrottleMs: 100,
			},
		});
		await harness.waitForWorkerReady();
		// The worker leaves its socket, so a delivery to its sessions requeues instead of landing.
		await harness.worker?.close();
		await harness.waitForDescriptorLifecycle("recovering");

		const orphaned = harness.request(deliveryCommand(harness, "nobody will read this"), 30_000);
		void orphaned.catch(() => undefined);
		await waitForLogLine(() => harness.logText(), "deliver message requeued");

		// The sender's own budget runs out and it closes the connection.
		harness.client?.close();
		const log = await waitForLogLine(
			() => harness.logText(),
			"abandoned 1 pending agent-message delivery of disconnected sender",
		);
		// The entry leaves through its terminal outcome, attributed and honest about
		// what is provable: nothing was ever written to a worker here.
		expect(log).toContain("deliver message dropped");
		expect(log).toContain("sender disconnected");
		expect(log).toContain("state undelivered");

		// A sender that is still connected gets the freed slot. RED on HEAD: the
		// orphaned entry still held it, so this command was rejected on capacity and
		// deferred until the client's own budget ran out.
		const settled = await harness.connectClient();
		const deferred = await settled.client
			.request(deliveryCommand(harness, "still here"), 1_500)
			.then(() => undefined)
			.catch((error: unknown) => error as Error);
		expect(harness.logText()).not.toContain("deliver queue overflow");
		expect(deferred).toBeInstanceOf(Error);
		expect(deferred?.message ?? "").not.toContain("kept deferring the command");
		settled.client.close();
	}, 60_000);
});
