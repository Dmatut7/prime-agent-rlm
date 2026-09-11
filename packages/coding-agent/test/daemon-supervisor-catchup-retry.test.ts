import { afterEach, describe, expect, it } from "vitest";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import {
	type ClientCatchupRetryPolicy,
	clientCatchupRetryDelayMs,
	DEFAULT_CLIENT_CATCHUP_RETRY_POLICY,
	isTransientCatchupFailure,
} from "../src/modes/daemon/daemon-supervisor.js";
import { disposeSupervisorHarnesses, startSupervisorHarness } from "./fixtures/supervisor-harness.js";

/**
 * T3-1 / P0-5a: a catch-up snapshot failure used to be logged and dropped, so one
 * transient `recovering` left the client's view permanently incomplete. The
 * supervisor now requeues the failed session and retries on a bounded backoff, and
 * only tells the client to re-pull once the budget is spent (F8: never a terminal
 * `closed` frame) or the failure is permanent.
 */

afterEach(async () => {
	await disposeSupervisorHarnesses();
});

/** Fast, deterministic retry schedule: no jitter, short backoff, small attempt cap. */
function testRetryPolicy(maxAttempts: number, backoffMs = 200): ClientCatchupRetryPolicy {
	return {
		backoffMs: [backoffMs],
		capMs: backoffMs,
		maxAttempts,
		jitterMs: 0,
		deadlineMs: 60_000,
		logThrottleMs: 60_000,
	};
}

async function startCatchupHarness(policy: ClientCatchupRetryPolicy) {
	const harness = await startSupervisorHarness({
		prefix: "ma-t3-1-catchup-",
		catchupRetryPolicy: policy,
	});
	// Adoption runs in the background now (L3): wait for the roster row before attaching.
	await harness.waitForWorkerReady();
	const response = await harness.request({
		type: "attach",
		activeSessionId: harness.session.activeSessionId,
		capabilities: ["attach_snapshot", "event_sequence"],
		supportsExtensionUi: false,
	});
	if (!response.success) {
		throw new Error(`Fixture attach failed: ${response.error}`);
	}
	const worker = harness.worker;
	if (!worker) {
		throw new Error("Harness started without a fake worker");
	}
	return {
		harness,
		worker,
		/** Queues a catch-up by pushing a delta frame the supervisor cannot reconstruct. */
		triggerCatchup: async () => {
			worker.pushUnreconstructableDelta();
			await harness.settle(50);
		},
	};
}

const isResynced = (message: DaemonOutbound): boolean => message.type === "session_resynced";
const isSnapshotFailed = (message: DaemonOutbound): boolean => message.type === "session_snapshot_failed";

describe("T3-1 daemon supervisor catch-up retry", () => {
	it("bounds the retry backoff and stops at the attempt cap", () => {
		const policy = DEFAULT_CLIENT_CATCHUP_RETRY_POLICY;
		const delays = [1, 2, 3, 4, 5, 6, 7].map((attempt) => clientCatchupRetryDelayMs(policy, attempt, 0, 60_000));
		expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 8_000]);
		expect(delays.length).toBeGreaterThan(0);
		// Mutation anchor: an unbounded schedule would keep growing past the cap and
		// would still hand out a delay at the attempt cap.
		expect(clientCatchupRetryDelayMs(policy, policy.maxAttempts, 0, 60_000)).toBeUndefined();
		expect(clientCatchupRetryDelayMs(policy, policy.maxAttempts + 5, 0, 60_000)).toBeUndefined();
		expect(clientCatchupRetryDelayMs(policy, 1, 0, 0)).toBeUndefined();
		// Jitter spreads clients but never pushes a retry past the remaining budget.
		expect(clientCatchupRetryDelayMs(policy, 1, policy.jitterMs, 400)).toBe(400);
		expect(clientCatchupRetryDelayMs(policy, 6, policy.jitterMs, 60_000)).toBeLessThanOrEqual(
			policy.capMs + policy.jitterMs,
		);
	});

	it("retries only transient catch-up failures", () => {
		expect(isTransientCatchupFailure(new Error("Session worker is recovering"))).toBe(true);
		expect(isTransientCatchupFailure(new Error("Snapshot snapshot-1 was superseded"))).toBe(true);
		expect(isTransientCatchupFailure(new Error("Timed out waiting for daemon worker response to attach"))).toBe(true);
		expect(isTransientCatchupFailure(new Error("Unknown active session: active-root"))).toBe(false);
		expect(isTransientCatchupFailure(new Error('Ambiguous active session "x"'))).toBe(false);
	});

	it("retries a transient catch-up failure until the client is resynced", async () => {
		const { harness, worker, triggerCatchup } = await startCatchupHarness(testRetryPolicy(5));
		const attachesAfterFirstAttach = worker.attachCount();
		expect(attachesAfterFirstAttach).toBeGreaterThan(0);

		worker.failNextAttaches("Session worker is recovering", 1);
		await triggerCatchup();

		// RED on HEAD: the failure was logged and dropped, so this frame never arrived.
		await harness.waitFor(isResynced);
		expect(worker.attachCount()).toBeGreaterThan(attachesAfterFirstAttach + 1);
		expect(harness.messages.filter(isSnapshotFailed)).toHaveLength(0);
	}, 30_000);

	it("tells the client to re-pull once the retry budget is spent, without a closed frame", async () => {
		const policy = testRetryPolicy(3, 100);
		const { harness, worker, triggerCatchup } = await startCatchupHarness(policy);

		worker.failNextAttaches("Session worker is recovering", policy.maxAttempts + 2);
		await triggerCatchup();

		const failed = await harness.waitFor(isSnapshotFailed);
		if (failed.type !== "session_snapshot_failed") {
			throw new Error("waitFor returned the wrong frame type");
		}
		expect(failed.reason).toBe("catchup_exhausted");
		expect(failed.purpose).toBe("resync");
		expect(failed.activeSessionId).toBe(harness.session.activeSessionId);
		expect(failed.error).toContain("recovering");

		// F8: giving up is loud, never terminal. No closed frame, and the armed timer
		// is cleared, so the supervisor stops hammering the worker.
		expect(harness.messages.filter((message) => message.type === "session_closed")).toHaveLength(0);
		const attachesAtGiveUp = worker.attachCount();
		await harness.settle(600);
		expect(worker.attachCount()).toBe(attachesAtGiveUp);
		expect(harness.messages.filter(isSnapshotFailed)).toHaveLength(1);
	}, 30_000);

	it("hands a permanent catch-up failure to the client without retrying", async () => {
		const { harness, worker, triggerCatchup } = await startCatchupHarness(testRetryPolicy(5, 100));
		const attachesAfterFirstAttach = worker.attachCount();

		worker.failNextAttaches("Unknown active session: active-root", 5);
		await triggerCatchup();

		const failed = await harness.waitFor(isSnapshotFailed);
		if (failed.type !== "session_snapshot_failed") {
			throw new Error("waitFor returned the wrong frame type");
		}
		expect(failed.reason).toBe("catchup_failed");
		await harness.settle(500);
		expect(worker.attachCount()).toBe(attachesAfterFirstAttach + 1);
	}, 30_000);

	it("starts a fresh retry budget after a delivered resync", async () => {
		const policy = testRetryPolicy(2, 150);
		const { harness, worker, triggerCatchup } = await startCatchupHarness(policy);

		// Streak one: one transient failure, then the retry delivers the resync.
		worker.failNextAttaches("Session worker is recovering", 1);
		await triggerCatchup();
		await harness.waitFor(isResynced);

		// Streak two must start from attempt one again: with a stale counter the very
		// next failure would hit the cap and push a healed client into a full re-pull.
		worker.failNextAttaches("Session worker is recovering", 1);
		await triggerCatchup();
		await harness.waitForCount(isResynced, 2);
		expect(harness.messages.filter(isResynced)).toHaveLength(2);
		expect(harness.messages.filter(isSnapshotFailed)).toHaveLength(0);
	}, 30_000);

	it("drops the retry budget when the client re-attaches on its own", async () => {
		const policy = testRetryPolicy(2, 400);
		const { harness, worker, triggerCatchup } = await startCatchupHarness(policy);

		worker.failNextAttaches("Session worker is recovering", 1);
		await triggerCatchup();
		// The client heals itself with a full attach while a retry is armed.
		const selfHeal = await harness.request({
			type: "attach",
			activeSessionId: harness.session.activeSessionId,
			capabilities: ["attach_snapshot", "event_sequence"],
			supportsExtensionUi: false,
		});
		expect(selfHeal.success).toBe(true);
		const attachesAfterSelfHeal = worker.attachCount();
		await harness.settle(900);

		// I-8: a healed client is never told it fell behind, and the armed retry is gone.
		expect(harness.messages.filter(isSnapshotFailed)).toHaveLength(0);
		expect(worker.attachCount()).toBe(attachesAfterSelfHeal);
	}, 30_000);
});
