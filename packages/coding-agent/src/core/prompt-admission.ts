/**
 * Base contract for every typed admission refusal: the action was refused
 * *before* anything was queued or delivered. The two propositions callers
 * kept collapsing into one "retryable" boolean live here as two fields:
 * (a) `deliveredNothing` - this attempt spent nothing (the message id stays
 *     unspent, a resend of the same id is correct);
 * (b) `retryNowSucceeds` - retrying the same action later *in this process*
 *     can succeed. False means the refusal is tied to a restart fence: the
 *     session is closing, so the correct action is to persist the result and
 *     resend after the restart, not to burn retries against a dead window.
 * A new admission refusal class must extend this base, which is what keeps
 * the (a)/(b) split from regressing into a single boolean again.
 */
export abstract class SessionInputRefusedBeforeDeliveryError extends Error {
	/** This attempt queued and delivered nothing (structural: refusals happen before delivery). */
	readonly deliveredNothing: true;
	/** Whether an in-process retry can succeed; false is the update-restart fence. */
	abstract readonly retryNowSucceeds: boolean;

	constructor(message: string) {
		super(message);
		this.deliveredNothing = true;
	}
}

/**
 * Session input admission is suspended: `requestAbort` parked the pump, or
 * `abortForUpdateRestart` fenced it so queued work survives into the restart
 * manifest. Typed so a caller can tell "parked, do not hammer it" from a
 * permanent failure; the message keeps the historical substring that existing
 * transcripts and tests match on, including the `retryable=` token, which
 * serializes `retryNowSucceeds` (the token name is frozen history).
 */
export class SessionInputSuspendedError extends SessionInputRefusedBeforeDeliveryError {
	/** False for the update-restart fence: retrying cannot succeed until restart. */
	readonly retryNowSucceeds: boolean;
	readonly queuedActionCount: number;
	/** Named source of retryNowSucceeds===false: the update-restart fence. */
	readonly suspendedForUpdateRestart: boolean;

	constructor(options: {
		queuedActionCount: number;
		suspendedForUpdateRestart: boolean;
		retryable?: boolean;
	}) {
		const retryable = options.retryable ?? !options.suspendedForUpdateRestart;
		super(
			`Cannot admit a session action while queued session input is suspended.` +
				`${
					options.suspendedForUpdateRestart
						? " The suspension is an update-restart fence: queued work must survive into the restart manifest, so retrying cannot wake it."
						: ""
				}` +
				` ${options.queuedActionCount} action(s) already queued; retryable=${retryable}.`,
		);
		this.name = "SessionInputSuspendedError";
		this.retryNowSucceeds = retryable;
		this.queuedActionCount = options.queuedActionCount;
		this.suspendedForUpdateRestart = options.suspendedForUpdateRestart;
	}
}

/**
 * Session input admission is paused: an owner (a kernel MCP transport reload,
 * an ACP stop/cancel window, or the update-restart teardown fence) holds an
 * admission pause lease, so the action is refused before anything is queued or
 * delivered. Typed so a caller can tell "paused, retry the same message later"
 * from a permanent failure; the message keeps the historical substring that
 * existing transcripts and tests match on.
 */
export class SessionInputAdmissionPausedError extends SessionInputRefusedBeforeDeliveryError {
	/** True unless the lease is the update-restart teardown, which only a restart releases. */
	readonly retryNowSucceeds: boolean;

	constructor(options: { pausedCount?: number; forUpdateRestart?: boolean } = {}) {
		super(
			"Cannot admit a session action while session input admission is paused. " +
				`Nothing was delivered and nothing was queued (${options.pausedCount ?? 1} pause lease(s) held); ` +
				"retry the same message once the pause is released." +
				(options.forUpdateRestart
					? " The pause is held for an update-restart teardown; the session is closing, so resend after the restart."
					: ""),
		);
		this.name = "SessionInputAdmissionPausedError";
		this.retryNowSucceeds = !options.forUpdateRestart;
	}
}

/**
 * A same-key follow-up arrived while its queue-key owner is committing - the
 * window between handing the prompt to the agent and the running turn, where
 * coalescing no longer applies but a second queued copy would double-deliver
 * the same key. Refused before delivery, so retrying after the turn ends is
 * the correct action.
 */
export class SessionInputCoalescingError extends SessionInputRefusedBeforeDeliveryError {
	readonly retryNowSucceeds: boolean;
	readonly queueKey: string;
	readonly ownerActionId: string;

	constructor(options: { queueKey: string; ownerActionId: string }) {
		super(
			`Cannot admit a session action because an equivalent follow-up (key ${options.queueKey}) is already committing. ` +
				"Nothing was delivered; retry the same message after the current turn ends.",
		);
		this.name = "SessionInputCoalescingError";
		this.retryNowSucceeds = true;
		this.queueKey = options.queueKey;
		this.ownerActionId = options.ownerActionId;
	}
}

/**
 * The typed pre-delivery admission refusal contract above. This is the only
 * typed authority for "this attempt delivered nothing": a scheduler whose tick
 * hit one records a deferral instead of a burned run, and reads
 * `retryNowSucceeds` separately to pick the retry cadence.
 */
export function isSessionInputRefusedBeforeDelivery(error: unknown): error is SessionInputRefusedBeforeDeliveryError {
	return error instanceof SessionInputRefusedBeforeDeliveryError;
}

export class PromptAdmissionCancelledError extends Error {
	constructor() {
		super("Prompt admission was cancelled.");
		this.name = "PromptAdmissionCancelledError";
	}
}

export function throwIfPromptAdmissionCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new PromptAdmissionCancelledError();
}

/**
 * Await `promise` unless `signal` aborts first. Always observes the supplied
 * work's rejection so a cancelled admission never leaks an unhandled rejection.
 */
export function waitForPromptAdmission<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		void promise.catch(() => {});
		return Promise.reject(new PromptAdmissionCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(new PromptAdmissionCancelledError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// Close the listener-registration race before observing the awaited work.
		if (signal.aborted) return onAbort();
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}
