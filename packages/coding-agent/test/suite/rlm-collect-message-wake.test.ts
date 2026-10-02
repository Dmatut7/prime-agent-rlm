/**
 * `rlm.collect` message wake (kernel protocol 5), wire level.
 *
 * A wake-capable kernel asks the host to end a collect wait early when an agent
 * message arrives for the session (`wake_on_message`; see
 * prime-agent-runtime/src/rlm/repl.md "Message wake"). The host answers with the
 * current snapshots plus `messages_pending`, and the kernel surfaces that as a
 * note telling the model to end its turn and receive the message.
 *
 * The anti-spin gate: only an arrival newer than the last early answer may end a
 * wait. Without it a model that re-arms a long collect without consuming the
 * message would be answered immediately again, forever.
 *
 * Red at HEAD: `createRlmCollectHostHandler` neither validated `wake_on_message`
 * nor knew a message-wake source, so the wait always ran to its bound.
 */
import { describe, expect, it } from "vitest";
import {
	createRlmCollectHostHandler,
	type RlmCollectHandler,
	type RlmCollectMessageWakeSource,
} from "../../src/core/rlm-runtime.js";

/** How the fake collect's wait ended - the deterministic signal behind every row. */
type ReleaseKind = "timeout" | "abort";

/**
 * A session-side arrival ledger stand-in: a monotonic count plus waiters that
 * resolve once the count advances past the caller's marker.
 */
function createWakeSource(initialCount = 0): {
	source: RlmCollectMessageWakeSource;
	arrive: (n?: number) => void;
	count: () => number;
} {
	let count = initialCount;
	const waiters = new Set<{
		since: number;
		resolve: (arrived: boolean) => void;
		finish: (arrived: boolean) => void;
	}>();
	const source: RlmCollectMessageWakeSource = {
		arrivalCount: () => count,
		waitForArrival: (since, timeoutMs, signal) =>
			new Promise<boolean>((resolve) => {
				if (count > since) {
					resolve(true);
					return;
				}
				if (signal?.aborted || timeoutMs <= 0) {
					resolve(false);
					return;
				}
				const timer = setTimeout(() => finish(false), timeoutMs);
				timer.unref?.();
				const onAbort = () => finish(false);
				const finish = (arrived: boolean) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					waiters.delete(waiter);
					resolve(arrived);
				};
				const waiter = { since, resolve, finish };
				waiters.add(waiter);
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
	};
	return {
		source,
		count: () => count,
		arrive: (n = 1) => {
			count += n;
			for (const waiter of [...waiters]) {
				if (count > waiter.since) waiter.finish(true);
			}
		},
	};
}

/** A collect that parks until its bound or its signal, then returns snapshots. */
function createParkingCollect(): {
	handler: RlmCollectHandler;
	calls: { timeoutMs: number; releasedBy: ReleaseKind }[];
} {
	const calls: { timeoutMs: number; releasedBy: ReleaseKind }[] = [];
	const handler: RlmCollectHandler = (_targets, timeoutMs, signal) =>
		new Promise((resolve) => {
			let settled = false;
			const finish = (releasedBy: ReleaseKind) => {
				// The host aborts the derived signal after the wait ended for its own reason;
				// only the first ending counts (withBound's finally does the same).
				if (settled) return;
				settled = true;
				calls.push({ timeoutMs, releasedBy });
				resolve({ results: [] });
			};
			if (timeoutMs <= 0 || signal?.aborted) {
				finish(signal?.aborted ? "abort" : "timeout");
				return;
			}
			const timer = setTimeout(() => finish("timeout"), timeoutMs);
			timer.unref?.();
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				finish("abort");
			});
		});
	return { handler, calls };
}

/** Park until `ms` elapsed; keeps an arrival point without wall-clock assertions on the reply. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("rlm.collect message wake", () => {
	it("validates the wake_on_message shape", async () => {
		const { handler } = createParkingCollect();
		const collect = createRlmCollectHostHandler(handler, {
			messageWake: createWakeSource().source,
		});
		await expect(collect({ wake_on_message: "yes" })).rejects.toThrow("wake_on_message must be a boolean");
		await expect(collect({ wake_on_message: 1 })).rejects.toThrow("wake_on_message must be a boolean");
	});

	it("behaves exactly as before when no message-wake source is configured", async () => {
		// The rollback shape: a host built without the session's arrival ledger waits
		// the full bound even when the kernel asks for the wake.
		const { handler, calls } = createParkingCollect();
		const collect = createRlmCollectHostHandler(handler);

		const reply = await collect({ timeout_ms: 200, wake_on_message: true });

		expect(reply).toMatchObject({ results: [], timeout_ms: 200 });
		expect(reply).not.toHaveProperty("messages_pending");
		expect(calls).toEqual([{ timeoutMs: 200, releasedBy: "timeout" }]);
	});

	it("ignores the wake path for a non-blocking read", async () => {
		const wake = createWakeSource(1);
		const { handler, calls } = createParkingCollect();
		const collect = createRlmCollectHostHandler(handler, { messageWake: wake.source });

		const reply = await collect({ timeout_ms: 0, wake_on_message: true });

		expect(reply).not.toHaveProperty("messages_pending");
		expect(calls).toEqual([{ timeoutMs: 0, releasedBy: "timeout" }]);
	});

	it("answers early with messages_pending when an arrival lands mid-wait", async () => {
		const wake = createWakeSource();
		const { handler, calls } = createParkingCollect();
		const collect = createRlmCollectHostHandler(handler, { messageWake: wake.source });

		const pending = collect({ timeout_ms: 30_000, wake_on_message: true });
		await sleep(20);
		wake.arrive(1);
		const reply = await pending;

		expect(calls).toEqual([{ timeoutMs: 30_000, releasedBy: "abort" }]);
		expect(reply).toMatchObject({ results: [], timeout_ms: 30_000, messages_pending: 1 });
	});

	it("answers immediately when news landed between turns", async () => {
		// An arrival admitted while no collect was parked is still news the waiting cell
		// has not seen: the first wake-capable collect after it answers at once.
		const wake = createWakeSource(2);
		const { handler, calls } = createParkingCollect();
		const collect = createRlmCollectHostHandler(handler, { messageWake: wake.source });

		const reply = await collect({ timeout_ms: 30_000, wake_on_message: true });

		expect(calls).toEqual([{ timeoutMs: 30_000, releasedBy: "abort" }]);
		expect(reply).toMatchObject({ messages_pending: 2 });
	});

	it("does not answer early twice for the same arrival", async () => {
		// The gate: a re-armed long wait must run its bound when nothing newer than the
		// last early answer arrived - otherwise the model's natural "collect again" loops
		// as an instant-answer spin.
		const wake = createWakeSource();
		const { handler, calls } = createParkingCollect();
		const collect = createRlmCollectHostHandler(handler, { messageWake: wake.source });

		const first = collect({ timeout_ms: 30_000, wake_on_message: true });
		await sleep(20);
		wake.arrive(1);
		await first;

		const second = await collect({ timeout_ms: 200, wake_on_message: true });
		expect(second).not.toHaveProperty("messages_pending");
		expect(calls[1]).toEqual({ timeoutMs: 200, releasedBy: "timeout" });

		// A genuinely new arrival wakes the next wait again, reporting only the delta.
		const third = collect({ timeout_ms: 30_000, wake_on_message: true });
		await sleep(20);
		wake.arrive(2);
		const thirdReply = await third;
		expect(thirdReply).toMatchObject({ messages_pending: 2 });
		expect(calls[2]).toEqual({ timeoutMs: 30_000, releasedBy: "abort" });
	});

	it("ends the wait on a cell abort without reporting a wake", async () => {
		const wake = createWakeSource();
		const { handler, calls } = createParkingCollect();
		const collect = createRlmCollectHostHandler(handler, { messageWake: wake.source });
		const requestAbort = new AbortController();

		const pending = collect({ timeout_ms: 30_000, wake_on_message: true }, requestAbort.signal);
		await sleep(20);
		requestAbort.abort(new Error("cell interrupted"));
		const reply = await pending;

		expect(calls).toEqual([{ timeoutMs: 30_000, releasedBy: "abort" }]);
		expect(reply).not.toHaveProperty("messages_pending");
	});

	it("waits the full bound when nothing arrives", async () => {
		const wake = createWakeSource();
		const { handler, calls } = createParkingCollect();
		const collect = createRlmCollectHostHandler(handler, { messageWake: wake.source });

		const reply = await collect({ timeout_ms: 200, wake_on_message: true });

		expect(reply).not.toHaveProperty("messages_pending");
		expect(calls).toEqual([{ timeoutMs: 200, releasedBy: "timeout" }]);
	});
});
