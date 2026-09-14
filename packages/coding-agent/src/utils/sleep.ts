import { performance } from "node:perf_hooks";

/**
 * Iteration bound for one `sleepSync`. The bound is deliberately independent of both clocks: it
 * is the backstop for hosts where the blocking wait below is unavailable, so an unusable clock
 * cannot keep a caller inside this helper.
 */
const SYNC_SLEEP_MAX_ITERATIONS = 10_000;

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
 * monotonic timer, so a wall-clock change during the wait cannot extend it; a host that refuses
 * main-thread waits throws, which leaves the caller spinning under its other bounds.
 */
function blockOnBuffer(buffer: Int32Array, timeoutMs: number): void {
	try {
		Atomics.wait(buffer, 0, 0, Math.max(0, timeoutMs));
	} catch {
		// Fall through: the caller's loop bounds still end the sleep.
	}
}

/**
 * Sleep synchronously for `delayMs` without waiting on the wall clock.
 *
 * Callers use this to back off between lock retries without turning themselves async, so
 * returning is part of the contract. Three things bound it: `performance.now()` (monotonic, so a
 * clock correction cannot extend the deadline), `Atomics.wait` on a shared buffer (the runtime's
 * monotonic timeout, which keeps the CPU idle), and an iteration cap. The
 * `while (Date.now() - start < delayMs)` spin this replaces had none of them: a clock stepping
 * backwards inside the spin left the condition true forever, and the caller - owning the event
 * loop - never returned.
 */
export function sleepSync(delayMs: number): void {
	if (!(delayMs > 0)) {
		return;
	}
	const deadline = performance.now() + delayMs;
	const buffer = syncSleepBuffer();
	for (let iteration = 0; iteration < SYNC_SLEEP_MAX_ITERATIONS; iteration++) {
		const remainingMs = deadline - performance.now();
		if (remainingMs <= 0) {
			return;
		}
		if (buffer) {
			blockOnBuffer(buffer, remainingMs);
		}
	}
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
