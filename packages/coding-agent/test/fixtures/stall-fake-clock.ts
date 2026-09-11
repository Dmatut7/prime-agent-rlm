import type { StallWatchdogTimers } from "../../src/core/stall-watchdog.js";

/**
 * Deterministic clock for watchdog tests: timers fire in deadline order when the
 * clock advances past them, so exemption budgets can be exercised in milliseconds.
 */
export class StallFakeClock {
	nowMs = 0;
	private nextId = 1;
	private timers: Array<{ id: number; at: number; fn: () => void }> = [];

	readonly timersImpl: StallWatchdogTimers = {
		setTimeout: (fn, delayMs) => {
			const id = this.nextId++;
			this.timers.push({ id, at: this.nowMs + delayMs, fn });
			return id;
		},
		clearTimeout: (handle) => {
			this.timers = this.timers.filter((timer) => timer.id !== handle);
		},
		now: () => this.nowMs,
	};

	advance(ms: number): void {
		const target = this.nowMs + ms;
		for (;;) {
			this.timers.sort((a, b) => a.at - b.at);
			const next = this.timers.find((timer) => timer.at <= target);
			if (!next) break;
			this.timers = this.timers.filter((timer) => timer !== next);
			this.nowMs = next.at;
			next.fn();
		}
		this.nowMs = target;
	}

	/** Advance in `stepMs` slices, calling `onStep` after each slice. */
	advanceInSteps(totalMs: number, stepMs: number, onStep: (elapsedMs: number) => void): void {
		let elapsed = 0;
		while (elapsed < totalMs) {
			const step = Math.min(stepMs, totalMs - elapsed);
			this.advance(step);
			elapsed += step;
			onStep(elapsed);
		}
	}
}

export const MINUTE_MS = 60 * 1000;
