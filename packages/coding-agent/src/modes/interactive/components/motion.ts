/**
 * Row motion for the live activity feed and the turn-end fold.
 *
 * Motion is whole-row only: a new row enters on a tinted background that
 * settles in two steps, and at turn end the step rows fold away bottom-up.
 * Nothing here runs a timer of its own while idle: a component that is mid
 * animation asks for the one frame where its look changes next, and the
 * scheduler keeps a single pending timeout for the earliest such frame.
 *
 * Process-wide state, read during render, the same shape as the spinner tick
 * (../theme/working-icon.ts) and the tool output budget.
 */

/** How long a new row keeps its highlight. */
export const ROW_ENTER_MS = 400;
/** When the strong first highlight step hands over to the fainter second one. */
export const ROW_ENTER_FADE_AT_MS = 150;
/** How long the turn-end fold takes to remove the step rows. */
export const TURN_FOLD_MS = 300;

/** The highlight a row shows: the strong step, the faint step, or none. */
export type RowEnterStage = "flash" | "fade" | "none";

let reduced = false;
let requestFrame: (() => void) | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let pendingAt = Number.POSITIVE_INFINITY;

/** Whether highlight and fold animations are switched off (the `reduceMotion` setting). */
export function motionReduced(): boolean {
	return reduced;
}

/** Returns true when the setting actually changed. */
export function setMotionReduced(value: boolean): boolean {
	if (reduced === value) return false;
	reduced = value;
	if (value) cancelMotionFrame();
	return true;
}

/** Who repaints when a scheduled motion frame is due; undefined detaches (teardown). */
export function setMotionFrameRequester(requester: (() => void) | undefined): void {
	requestFrame = requester;
	if (!requester) cancelMotionFrame();
}

function cancelMotionFrame(): void {
	if (pendingTimer) clearTimeout(pendingTimer);
	pendingTimer = undefined;
	pendingAt = Number.POSITIVE_INFINITY;
}

/**
 * Ask for one repaint at `at` (epoch ms). An earlier request already pending
 * covers a later one: that frame's render asks again for whatever comes next.
 */
export function scheduleMotionFrame(at: number, now = Date.now()): void {
	if (reduced || !requestFrame) return;
	if (pendingTimer && pendingAt <= at) return;
	cancelMotionFrame();
	pendingAt = at;
	pendingTimer = setTimeout(
		() => {
			pendingTimer = undefined;
			pendingAt = Number.POSITIVE_INFINITY;
			requestFrame?.();
		},
		Math.max(0, at - now),
	);
	pendingTimer.unref?.();
}

/**
 * The highlight stage of a row that first appeared at `since`, and schedules
 * the frame where the stage changes next. Reduced motion never highlights.
 */
export function rowEnterStage(since: number | undefined, now = Date.now()): RowEnterStage {
	if (reduced || since === undefined) return "none";
	const age = now - since;
	if (age < 0 || age >= ROW_ENTER_MS) return "none";
	if (age < ROW_ENTER_FADE_AT_MS) {
		scheduleMotionFrame(since + ROW_ENTER_FADE_AT_MS, now);
		return "flash";
	}
	scheduleMotionFrame(since + ROW_ENTER_MS, now);
	return "fade";
}

/**
 * Fold progress 0..1 for a fold that started at `startedAt`; schedules the
 * next frame while it runs. Reduced motion (or no start) is already folded.
 */
export function foldProgress(startedAt: number | undefined, rows: number, now = Date.now()): number {
	if (reduced || startedAt === undefined || rows <= 0) return 1;
	const elapsed = now - startedAt;
	if (elapsed >= TURN_FOLD_MS) return 1;
	if (elapsed < 0) return 0;
	// One frame per removed row, so the fold reads row by row.
	const step = TURN_FOLD_MS / rows;
	const nextStepAt = startedAt + (Math.floor(elapsed / step) + 1) * step;
	scheduleMotionFrame(Math.min(startedAt + TURN_FOLD_MS, Math.ceil(nextStepAt)), now);
	return elapsed / TURN_FOLD_MS;
}
