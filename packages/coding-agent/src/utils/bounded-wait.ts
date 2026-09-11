/**
 * Bounded waits for operations this process does not own (P1-1 / C14).
 *
 * Four waits in the agent-message and subagent-hydration paths used to be unbounded: a
 * passivation, a session bind, a hydration and a child publication each parked the caller until
 * the other side settled. A wedged target therefore held a kernel cell - and with it the stall
 * watchdog's whole attention - for as long as the parent turn lived, and the model got no fact it
 * could act on.
 *
 * The bound deliberately does *not* cancel anything. Passivation, binding and hydration all mutate
 * shared session state, and interrupting one halfway leaves a torn session that is worse than a
 * slow one. So the operation keeps running to completion and the *caller* gets a factual,
 * retryable error naming what it waited for, how long, and what the target's state was at that
 * moment. Retrying is then safe (the same wait joins the in-flight operation instead of starting a
 * second one), and P1-2's exactly-once delivery covers the message leg.
 *
 * Every timer created here is unref'd and cleared on all four paths - settle, timeout, abort, and
 * an already-settled promise - so a bounded wait can neither hold the process open nor leak a
 * timer.
 */

/** Default bound for the longest tier: waiting for a session to finish passivating. */
export const DEFAULT_TARGET_WAIT_MS = 120_000;
/**
 * Default bound for the shorter tiers (bind, hydrate, publication): half the long one. They are
 * joined to a single setting so an operator tuning the wait cannot leave one tier unbounded by
 * forgetting it, and so the ratio survives a change of scale.
 */
export const DEFAULT_SHORT_TARGET_WAIT_MS = 60_000;

export interface WaitTimeoutFacts {
	/** Which wait ran out of time (`passivation`, `bind`, `hydrate`, `publication`). */
	phase: string;
	/** What was being waited for, as the caller names it (a session file, a child selector). */
	target: string;
	/** How long the caller waited, in ms. */
	waitedMs: number;
	/** The target's own state at the timeout, when the caller can supply it. */
	targetState?: string;
	/** Heading of the message; the retryable classifier keys off "wait timed out". */
	label?: string;
}

/**
 * A wait that ran out of time. The operation behind it is still running: this error is a fact
 * about the caller's patience, not about the target failing.
 */
export class WaitTimeoutError extends Error {
	readonly phase: string;
	readonly target: string;
	readonly waitedMs: number;
	readonly targetState?: string;
	/** Always true: the point of the bound is that a retry is safe and cheap. */
	readonly retryable = true;

	constructor(facts: WaitTimeoutFacts) {
		super(formatWaitTimeoutMessage(facts));
		this.name = "WaitTimeoutError";
		this.phase = facts.phase;
		this.target = facts.target;
		this.waitedMs = facts.waitedMs;
		if (facts.targetState !== undefined) this.targetState = facts.targetState;
	}
}

/**
 * The model-facing text of a timed-out wait. It states the three things that stop a retry loop:
 * nothing was cancelled, the wait is bounded so the same call is cheap to repeat, and what to do
 * instead of waiting again.
 */
export function formatWaitTimeoutMessage(facts: WaitTimeoutFacts): string {
	const label = facts.label ?? "Target";
	const state = facts.targetState ? ` Target state: ${facts.targetState}.` : "";
	return (
		`${label} wait timed out after ${facts.waitedMs}ms (phase: ${facts.phase}, target: ${facts.target}).${state} ` +
		"Nothing was cancelled - the operation is still running and may finish on its own, so this error is " +
		"retryable. Do not retry in a tight loop: either wait for the target to settle and try once more, or " +
		"write your result to a file and end the turn so the recipient can pick it up later."
	);
}

export interface WithBoundOptions {
	/** Bound in ms. Must be finite and positive; anything else disables the bound. */
	timeoutMs: number;
	phase: string;
	target: string;
	/** Aborts the *wait* only. The underlying promise keeps running either way. */
	signal?: AbortSignal;
	/** Target state rendered into the timeout error; read at the moment of the timeout. */
	targetState?: () => string | undefined;
	/** Heading of the timeout message. */
	label?: string;
	now?: () => number;
	onTimeout?: (facts: WaitTimeoutFacts) => void;
}

/**
 * Await `promise` for at most `options.timeoutMs`.
 *
 * Four outcomes, and the timer is cleared on every one: the promise settles in time (its value or
 * its own error is passed through untouched), the bound trips (a {@link WaitTimeoutError}), the
 * signal aborts first (the signal's reason, or a plain abort error), or the promise was already
 * settled when the wait started (resolved immediately). A non-finite or non-positive `timeoutMs`
 * disables the bound, which is the rollback lever for the whole mechanism.
 */
export async function withBound<T>(promise: Promise<T>, options: WithBoundOptions): Promise<T> {
	const now = options.now ?? (() => Date.now());
	const bounded = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0;
	if (!bounded && !options.signal) {
		return promise;
	}
	const started = now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<T>((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(abortReason(options.signal, options));
				return;
			}
			if (bounded) {
				timer = setTimeout(() => {
					const state = options.targetState?.();
					const facts: WaitTimeoutFacts = {
						phase: options.phase,
						target: options.target,
						waitedMs: Math.max(0, now() - started),
						...(options.label === undefined ? {} : { label: options.label }),
						...(state === undefined ? {} : { targetState: state }),
					};
					options.onTimeout?.(facts);
					reject(new WaitTimeoutError(facts));
				}, options.timeoutMs);
				timer.unref?.();
			}
			if (options.signal) {
				onAbort = () => reject(abortReason(options.signal, options));
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
			// A late settlement after a timeout is handled here, so it can never surface as an
			// unhandled rejection.
			promise.then(resolve, reject);
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
	}
}

function abortReason(signal: AbortSignal | undefined, options: WithBoundOptions): Error {
	const reason = signal?.reason;
	if (reason instanceof Error) return reason;
	return new Error(`Wait for ${options.target} aborted during ${options.phase}`);
}

/**
 * Await `promise` until it settles or the signal aborts, whichever comes first. An abort resolves
 * with `undefined` instead of rejecting: this is for waits whose caller has a graceful fallback
 * (a roster match, the state as it currently is) and must not turn a cancelled cell into an error.
 * No timer is involved, and the listener is removed on both paths.
 */
export async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
	if (!signal) return promise;
	if (signal.aborted) return undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await new Promise<T | undefined>((resolve, reject) => {
			onAbort = () => resolve(undefined);
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(resolve, reject);
		});
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Re-entry ceiling for a self-recursive wait. Deliberately unrelated to `RLM_MAX_DEPTH`: that
 * setting counts *agent generations* (default 2), so borrowing it here would cap a hydration at
 * four re-entries and fail legitimate concurrency - several clients attaching to one session each
 * publish and re-enter, and none of them is a recursion depth (M19).
 */
export const DEFAULT_ATTEMPT_BUDGET_MAX = 32;

/** A count-and-deadline budget: whichever trips first ends the loop. */
export interface AttemptBudget {
	attempts: number;
	readonly maxAttempts: number;
	readonly startedAt: number;
	readonly deadlineAt: number;
}

export function createAttemptBudget(
	maxAttempts: number = DEFAULT_ATTEMPT_BUDGET_MAX,
	deadlineMs: number = DEFAULT_SHORT_TARGET_WAIT_MS,
	now: number = Date.now(),
): AttemptBudget {
	return {
		attempts: 0,
		maxAttempts: Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : DEFAULT_ATTEMPT_BUDGET_MAX,
		startedAt: now,
		deadlineAt: Number.isFinite(deadlineMs) && deadlineMs > 0 ? now + deadlineMs : Number.POSITIVE_INFINITY,
	};
}

/** A re-entry loop that hit its count or its deadline. Retryable later, not immediately. */
export class AttemptBudgetExceededError extends Error {
	readonly attempts: number;
	readonly elapsedMs: number;
	readonly phase: string;
	readonly target: string;
	readonly retryable = true;

	constructor(input: {
		attempts: number;
		elapsedMs: number;
		phase: string;
		target: string;
		maxAttempts: number;
	}) {
		super(
			`${input.phase} wait timed out: re-entered ${input.attempts} times over ${input.elapsedMs}ms for ${input.target} ` +
				`without settling (limit ${input.maxAttempts} attempts and a total deadline). Nothing was cancelled. ` +
				"This is retryable, but not immediately: another caller is still working on the same target, so wait for it " +
				"to settle, or write your result to a file and end the turn.",
		);
		this.name = "AttemptBudgetExceededError";
		this.attempts = input.attempts;
		this.elapsedMs = input.elapsedMs;
		this.phase = input.phase;
		this.target = input.target;
	}
}

/**
 * Spend one re-entry. Throws once the count or the total deadline is spent, which is the
 * mechanical ceiling on a loop that would otherwise be unbounded because every retry looks like
 * legitimate contention (M6b/M19).
 */
export function consumeAttempt(
	budget: AttemptBudget,
	context: { phase: string; target: string },
	now: number = Date.now(),
): void {
	budget.attempts += 1;
	const elapsedMs = Math.max(0, now - budget.startedAt);
	if (budget.attempts > budget.maxAttempts || now > budget.deadlineAt) {
		throw new AttemptBudgetExceededError({
			attempts: budget.attempts,
			elapsedMs,
			phase: context.phase,
			target: context.target,
			maxAttempts: budget.maxAttempts,
		});
	}
}
