/**
 * Motion for the turn box: every animation is a whole-row change in a few
 * theme color steps, never a moving character.
 *
 * - a new row enters on a teal tint that fades out in two steps (0.6s)
 * - a finished step's glyph flashes green once; a failed row flashes red
 * - the box header's text fades in when it changes (0.2s)
 * - opening a row (or the box) slides its lines in (0.2s)
 * - at turn end the body folds up row by row (0.3s)
 *
 * Nothing here runs a timer while idle: a component that is mid animation
 * asks for the one frame where its look changes next, and the scheduler keeps
 * a single pending timeout for the earliest such frame. The `reduceMotion`
 * setting turns all of it off (the spinner keeps turning: it is state, not
 * decoration).
 *
 * Process-wide state, read during render, the same shape as the spinner tick
 * (../theme/working-icon.ts) and the tool output budget.
 */

/** How long a new row keeps its highlight. */
export const ROW_ENTER_MS = 600;
/** When the strong first highlight step hands over to the fainter second one. */
export const ROW_ENTER_FADE_AT_MS = 250;
/** How long a finished step's glyph flashes. */
export const SETTLE_FLASH_MS = 600;
/** How long a failed row keeps its red tint before it stays plain red. */
export const ERROR_FLASH_MS = 1000;
/** How long the box header's new text stays faint before it reads normally. */
export const LABEL_FADE_MS = 200;
/** How long an opened row or box takes to slide its lines in. */
export const SLIDE_MS = 200;
/** How long the turn-end fold takes to remove the body rows. */
export const TURN_FOLD_MS = 300;

/** The highlight a row shows: the strong step, the faint step, or none. */
export type RowEnterStage = "flash" | "fade" | "none";

let reduced = false;
let requestFrame: (() => void) | undefined;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
let pendingAt = Number.POSITIVE_INFINITY;
let motionSeen = false;

/**
 * Whether any motion helper reported an animation in progress since the last
 * call. A component whose render found none can cache its lines.
 */
export function takeMotionActive(): boolean {
	const seen = motionSeen;
	motionSeen = false;
	return seen;
}

/** Whether highlight, fade, slide and fold animations are switched off (the `reduceMotion` setting). */
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

/** True (and a frame is booked for its end) while `since` is less than `durationMs` ago. */
export function withinMotion(since: number | undefined, durationMs: number, now = Date.now()): boolean {
	if (reduced || since === undefined) return false;
	const age = now - since;
	if (age < 0 || age >= durationMs) return false;
	motionSeen = true;
	scheduleMotionFrame(since + durationMs, now);
	return true;
}

/**
 * The highlight stage of a row that first appeared at `since`, and schedules
 * the frame where the stage changes next. Reduced motion never highlights.
 */
export function rowEnterStage(since: number | undefined, now = Date.now()): RowEnterStage {
	if (reduced || since === undefined) return "none";
	const age = now - since;
	if (age < 0 || age >= ROW_ENTER_MS) return "none";
	motionSeen = true;
	if (age < ROW_ENTER_FADE_AT_MS) {
		scheduleMotionFrame(since + ROW_ENTER_FADE_AT_MS, now);
		return "flash";
	}
	scheduleMotionFrame(since + ROW_ENTER_MS, now);
	return "fade";
}

/**
 * Progress 0..1 of a row-by-row motion over `rows` rows that started at
 * `startedAt` and lasts `durationMs`; books the frame where the next row
 * changes. Reduced motion (or no start) is already complete.
 */
export function stepProgress(
	startedAt: number | undefined,
	rows: number,
	durationMs: number,
	now = Date.now(),
): number {
	if (reduced || startedAt === undefined || rows <= 0) return 1;
	const elapsed = now - startedAt;
	if (elapsed >= durationMs) return 1;
	motionSeen = true;
	if (elapsed < 0) return 0;
	const step = durationMs / rows;
	const nextStepAt = startedAt + (Math.floor(elapsed / step) + 1) * step;
	scheduleMotionFrame(Math.min(startedAt + durationMs, Math.ceil(nextStepAt)), now);
	return elapsed / durationMs;
}

/** The turn-end fold's progress. */
export function foldProgress(startedAt: number | undefined, rows: number, now = Date.now()): number {
	return stepProgress(startedAt, rows, TURN_FOLD_MS, now);
}

/** How many of `total` lines an opening that started at `openedAt` shows by now. */
export function slideCount(openedAt: number | undefined, total: number, now = Date.now()): number {
	if (total <= 0) return total;
	const progress = stepProgress(openedAt, Math.min(total, 8), SLIDE_MS, now);
	return progress >= 1 ? total : Math.max(1, Math.ceil(total * progress));
}
