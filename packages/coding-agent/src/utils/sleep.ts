import { performance } from "node:perf_hooks";
import { getLogger } from "@earendil-works/pi-ai";

const sleepLog = getLogger("coding-agent.sleep");

/**
 * Iteration bound for the blocking loop of one `sleepSync`. Each of its iterations blocks on the
 * shared buffer until the monotonic deadline, so a host that wakes the wait early cannot keep a
 * caller in that loop. It is deliberately not a bound on how long the sleep may last: an iteration
 * cap that also ends the sleep early is not a backstop, it is a silent no-op - measured on a host
 * that refuses `Atomics.wait`, a requested 200ms returned in 10.9ms after 10000 thrown exceptions,
 * which turns every caller's lock backoff into an immediate retry.
 */
const SYNC_SLEEP_MAX_ITERATIONS = 10_000;

/**
 * Consecutive identical monotonic readings after which the fallback spin gives up.
 *
 * A spin whose only exit condition is `performance.now()` cannot return early while that clock
 * advances, and a frozen monotonic clock cannot end it at all - so this counter is the only way
 * out, and taking it is announced. The limit is generous because a coarse timer (some hosts
 * quantize `performance.now()` to a millisecond) reads the same value for many iterations before
 * it ticks.
 */
const SYNC_SLEEP_FROZEN_CLOCK_READINGS = 1_000_000;

let sharedSleepBuffer: Int32Array | undefined;

/**
 * Buffer for the blocking wait, or undefined when this host has no `SharedArrayBuffer` (or
 * rejects the constructor). Callers then spin instead, still bounded by the monotonic deadline.
 */
function syncSleepBuffer(): Int32Array | undefined {
	if (sharedSleepBuffer === undefined) {
		try {
			sharedSleepBuffer = new Int32Array(new SharedArrayBuffer(4));
		} catch {
			sharedSleepBuffer = undefined;
		}
	}
	return sharedSleepBuffer;
}

/**
 * Block the current thread on the shared buffer. `Atomics.wait` times out on the runtime's own
 * monotonic timer, so a wall-clock change during the wait cannot extend it. Returns false when the
 * host refuses the wait (some runtimes forbid main-thread waits): the caller then owes the delay
 * through the spin below instead of returning early.
 */
function blockOnBuffer(buffer: Int32Array, timeoutMs: number): boolean {
	try {
		Atomics.wait(buffer, 0, 0, Math.max(0, timeoutMs));
		return true;
	} catch {
		return false;
	}
}

/**
 * Wait out the deadline with no blocking primitive, on the monotonic clock alone.
 *
 * Every iteration re-reads `performance.now()`, so the loop cannot end before the deadline while
 * that clock advances - a host that refuses `Atomics.wait` still has a monotonic timer, and a
 * caller that asked to sleep 200ms has to sleep 200ms. The stall counter is the only exit for a
 * clock that does not advance; taking it warns, because an unannounced early return is exactly the
 * bug this fallback exists to remove.
 */
function spinUntilDeadline(deadline: number): void {
	let lastReading = performance.now();
	let stalledReadings = 0;
	for (;;) {
		const now = performance.now();
		if (now >= deadline) return;
		if (now === lastReading) {
			stalledReadings++;
			if (stalledReadings >= SYNC_SLEEP_FROZEN_CLOCK_READINGS) {
				sleepLog.warn("gave up on a sync sleep before its deadline: the monotonic clock is not advancing", {
					overdueMs: deadline - now,
				});
				return;
			}
			continue;
		}
		lastReading = now;
		stalledReadings = 0;
	}
}

/**
 * Sleep synchronously for `delayMs` without waiting on the wall clock.
 *
 * Callers use this to back off between lock retries without turning themselves async, so both
 * parts of the contract matter: it returns, and it has waited. `performance.now()` is the deadline
 * (monotonic, so a clock correction cannot extend it), `Atomics.wait` on a shared buffer is how the
 * CPU idles until then, and the spin is what happens when that wait is refused. The
 * `while (Date.now() - start < delayMs)` spin this replaces had neither a monotonic deadline nor an
 * exit for a host without a blocking wait: a clock stepping backwards inside it left the condition
 * true forever, and the caller - owning the event loop - never returned.
 */
export function sleepSync(delayMs: number): void {
	if (!(delayMs > 0)) {
		return;
	}
	const deadline = performance.now() + delayMs;
	const buffer = syncSleepBuffer();
	if (!buffer) {
		spinUntilDeadline(deadline);
		return;
	}
	// The blocking wait is the idle path. The first refusal (a host that forbids main-thread
	// waits) moves this call to the spin, because the sleep still owes the caller its delay: the
	// budget above bounds the *loop*, never the sleep.
	let blocking = true;
	for (let iteration = 0; iteration < SYNC_SLEEP_MAX_ITERATIONS; iteration++) {
		const remainingMs = deadline - performance.now();
		if (remainingMs <= 0) {
			return;
		}
		if (!blocking) break;
		blocking = blockOnBuffer(buffer, remainingMs);
	}
	spinUntilDeadline(deadline);
}

/**
 * Sleep helper that respects abort signal.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
