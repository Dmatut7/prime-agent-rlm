/**
 * Wall-clock reader that absorbs backward steps (an NTP correction or a manual time change).
 *
 * Every age, budget and delay that compares "now" against an anchor assumes time only moves
 * forward; `Math.max(0, now - anchor)` hides the violation by clamping the age to zero, which
 * freezes budgets and defers deadlines for exactly as long as the wall clock stays behind.
 * This reader keeps wall values (recorded timestamps stay honest wall time) while never
 * returning a reading earlier than the previous one, and never one that lags the monotonic
 * clock's own progress since the previous reading: a detected backward step is folded into a
 * permanent offset, so elapsed time measured through it keeps advancing with real time.
 * Same stance as the monotonic deadline in sleep.ts: a wall-clock change cannot extend a
 * bounded wait.
 */
export class StepCompensatedClock {
	private lastWallMs = Number.NEGATIVE_INFINITY;
	private lastMonoMs = Number.NEGATIVE_INFINITY;
	private offsetMs = 0;

	now(rawMs: number, monoMs: number): number {
		const monoDelta = Math.max(0, monoMs - this.lastMonoMs);
		const corrected = rawMs + this.offsetMs;
		// How far time has provably moved since the last reading, whichever clock says so.
		const floor = this.lastWallMs + monoDelta;
		if (corrected < floor) {
			this.offsetMs = floor - rawMs;
			this.lastWallMs = floor;
			this.lastMonoMs = monoMs;
			return floor;
		}
		this.lastWallMs = corrected;
		this.lastMonoMs = monoMs;
		return corrected;
	}
}
