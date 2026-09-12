import { afterEach, describe, expect, it } from "vitest";
import { type PendingDeliveryAbortReason, PendingDeliveryQueue } from "../src/modes/daemon/pending-delivery-queue.js";
import {
	disposeSupervisorHarnesses,
	type SupervisorHarness,
	startSupervisorHarness,
} from "./fixtures/supervisor-harness.js";

/**
 * F2. `send_message` stopped holding the mutation drain latch (P1-7c), and that
 * latch was also all the eviction fence waited on, so a stop could overtake a
 * delivery in flight: the message evaporated and the sender got a bare transport
 * error instead of the explicit receipt the queue promises (B10). A residency
 * decision now treats an in-flight delivery as work, a stop receipts the entries
 * aimed at its tree before the socket closes, and a lost answer after a dispatch
 * is reported as uncertain.
 *
 * F3. The requeue loop kept the worker object it was admitted with. Once that
 * registration was deleted, the stale object reported "stopping" forever, so the
 * delivery bounced every retry interval until the 24h budget ran out.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

async function waitForLogLine(harness: SupervisorHarness, needle: string, timeoutMs = 20_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const log = harness.logText();
		if (log.includes(needle)) {
			return log;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for a log line containing ${JSON.stringify(needle)}. Log:\n${log}`);
		}
		await harness.settle(50);
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

const errorMessage = async (pending: Promise<{ success: boolean; error?: string }>): Promise<string> => {
	const response = await pending;
	if (response.success) {
		throw new Error("Expected the delivery to fail");
	}
	return response.error ?? "";
};

describe("F2 pending delivery queue targeted drain", () => {
	it("aborts only the entries aimed at the stopping worker's sessions", () => {
		const queue = new PendingDeliveryQueue({ capacity: 2 });
		const mine = queue.admit("target-a", "sender-a", "conn-a");
		const other = queue.admit("target-b", "sender-b", "conn-b");
		if (!mine.ok || !other.ok) throw new Error("admission failed");

		expect(queue.hasEntriesForTargets(["target-a"])).toBe(true);
		expect(queue.hasEntriesForTargets(["target-c"])).toBe(false);
		expect(queue.hasEntriesForTargets([])).toBe(false);

		const seen: PendingDeliveryAbortReason[] = [];
		const unsubscribe = mine.entry.onAbort((reason) => seen.push(reason));
		// RED on HEAD: no targeted drain existed, so a worker stop left the entry to
		// die on the closing socket.
		expect(queue.drainTargets(["target-a", "target-c"], "worker_stopped")).toHaveLength(1);
		expect(seen).toEqual(["worker_stopped"]);
		expect(queue.counters.drained).toBe(1);
		// The other target keeps its entry and its capacity.
		expect(queue.depth("target-b")).toBe(1);
		expect(queue.hasEntriesForTargets(["target-a"])).toBe(false);
		expect(queue.drainTargets(["target-a"], "worker_stopped")).toHaveLength(0);
		// The delivery loop's own drop after the abort must not count twice.
		queue.drop(mine.entry);
		expect(queue.counters.dropped).toBe(0);
		unsubscribe();
	});
});

describe("F2 a worker stop receipts an in-flight delivery", () => {
	it("answers the sender with an uncertain receipt instead of a transport error", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-f2-stop-receipt-",
			sessionCount: 2,
			hangWorkerCommands: ["worker_deliver_message"],
			supervisorOptions: { pendingDeliveryRetryIntervalMs: 25 },
		});
		await harness.waitForWorkerReady();

		// The dispatch is written and the target never answers it: the delivery is in
		// flight, which is exactly what a stop used to cut off without a receipt.
		const inFlight = harness.request(deliveryCommand(harness, "in flight"), 30_000);
		await harness.settle(400);

		const kill = await harness.request({ type: "kill", activeSessionId: harness.session.activeSessionId });
		expect(kill.success).toBe(true);

		const failure = await errorMessage(inFlight);
		// RED on HEAD: a bare "Daemon worker client closed" style transport error.
		expect(failure).toContain("may already have been delivered");
		expect(failure).toContain("worker stopped");
		expect(failure).toContain("Do not re-send it blindly");
		const log = await waitForLogLine(harness, "drained 1 pending agent-message delivery of stopping worker");
		expect(log).toContain("state uncertain");
	}, 60_000);

	it("does not evict an empty session tree while a delivery to it is in flight", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-f2-eviction-",
			sessionCount: 2,
			emptySessionSummaries: true,
			hangWorkerCommands: ["worker_deliver_message"],
			supervisorOptions: { pendingDeliveryRetryIntervalMs: 25 },
		});
		await harness.waitForWorkerReady();
		const child = harness.sessions[1];
		if (!child) throw new Error("Harness did not create a child session");
		const sender = await harness.connectClient();

		const attach = async (activeSessionId: string): Promise<void> => {
			const response = await harness.request({
				type: "attach",
				activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence"],
				supportsExtensionUi: false,
			});
			if (!response.success) throw new Error(`Fixture attach failed: ${response.error}`);
		};
		const detach = async (): Promise<void> => {
			const response = await harness.request({ type: "detach", activeSessionId: child.activeSessionId });
			if (!response.success) throw new Error(`Fixture detach failed: ${response.error}`);
		};

		await attach(child.activeSessionId);
		const inFlight = sender.client.request(deliveryCommand(harness, "in flight"), 30_000);
		await harness.settle(400);

		// The last client leaves: the tree is empty and idle, so it looks evictable.
		await detach();
		await harness.settle(800);
		// RED on HEAD: the eviction ran and took the in-flight delivery with it.
		expect(harness.logText()).not.toContain("Evicted empty session worker");
		expect(harness.readDescriptor()).not.toBeUndefined();

		// Once the sender gives up, the same detach evicts: both directions converge.
		// A closed client rejects locally, so the daemon-side receipt is the log line.
		void inFlight.catch(() => undefined);
		sender.client.close();
		await waitForLogLine(harness, "abandoned 1 pending agent-message delivery of disconnected sender");

		await attach(child.activeSessionId);
		await detach();
		await waitForLogLine(harness, "Evicted empty session worker");
	}, 90_000);
});

describe("F3 a delivery stops bouncing once its target registration is gone", () => {
	it("fails terminally with an honest receipt instead of spinning to the delivery budget", async () => {
		const harness = await startSupervisorHarness({
			prefix: "ma-f3-target-gone-",
			sessionCount: 2,
			supervisorOptions: {
				pendingDeliveryRetryIntervalMs: 25,
				pendingDeliveryTargetGoneGraceMs: 80,
				pendingDeliveryLogThrottleMs: 40,
			},
		});
		await harness.waitForWorkerReady();
		const worker = harness.worker;
		if (!worker) throw new Error("Harness started without a fake worker");

		// Drop the connection: the reconnect authenticates but the hung subscribe keeps
		// the registration in `recovering` while its client stays live.
		worker.hangCommand("worker_subscribe");
		worker.dropConnections();
		await harness.waitForDescriptorLifecycle("recovering", 30_000);
		const bouncing = harness.request(deliveryCommand(harness, "nobody home"), 30_000);
		await waitForLogLine(harness, "deliver message requeued");
		// The frame needs the supervisor's reconnect: recovery dials back ~250ms after
		// the close, and auth must land before the worker client accepts frames.
		const reconnected = Date.now() + 30_000;
		while (worker.connectionCount() === 0 && Date.now() < reconnected) {
			await harness.settle(25);
		}
		expect(worker.connectionCount()).toBeGreaterThan(0);
		await harness.settle(300);

		// The worker's own root session ends. The supervisor deregisters the tree for
		// that event without a stop, so nothing drains the queue on its behalf.
		const rootId = harness.session.activeSessionId;
		worker.pushFrame(
			{ kind: "outbound", outboundType: "session_closed", activeSessionId: rootId },
			new TextEncoder().encode(
				`${JSON.stringify({ type: "session_closed", activeSessionId: rootId, reason: "shutdown" })}\n`,
			),
		);

		const failure = await errorMessage(bouncing);
		// RED on HEAD: the loop kept bouncing on the stale worker object until the 24h
		// delivery budget ran out.
		expect(failure).toContain("was not delivered");
		expect(failure).toContain("its session worker is gone");
		expect(failure).toContain("Send it again to a live session");
		// Nobody stopped the tree, so the stand-in process was never signalled.
		expect(await harness.processIsGone()).toBe(false);
		expect(harness.readDescriptor()).toBeUndefined();
	}, 60_000);
});
