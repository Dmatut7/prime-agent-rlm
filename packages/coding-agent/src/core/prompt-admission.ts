/**
 * Session input admission is suspended: `requestAbort` parked the pump, or
 * `abortForUpdateRestart` fenced it so queued work survives into the restart
 * manifest. Typed so a caller can tell "parked, do not hammer it" from a
 * permanent failure; the message keeps the historical substring that existing
 * transcripts and tests match on.
 */
export class SessionInputSuspendedError extends Error {
	/** False for the update-restart fence: retrying cannot succeed until restart. */
	readonly retryable: boolean;
	readonly queuedActionCount: number;
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
		this.retryable = retryable;
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
export class SessionInputAdmissionPausedError extends Error {
	/** True: the pause is released by its owner, so a later retry can succeed. */
	readonly retryable: boolean;

	constructor(options: { pausedCount?: number } = {}) {
		super(
			"Cannot admit a session action while session input admission is paused. " +
				`Nothing was delivered and nothing was queued (${options.pausedCount ?? 1} pause lease(s) held); ` +
				"retry the same message once the pause is released.",
		);
		this.name = "SessionInputAdmissionPausedError";
		this.retryable = true;
	}
}

/**
 * A same-key follow-up arrived while its queue-key owner is committing - the
 * window between handing the prompt to the agent and the running turn, where
 * coalescing no longer applies but a second queued copy would double-deliver
 * the same key. Refused before delivery, so retrying after the turn ends is
 * the correct action.
 */
export class SessionInputCoalescingError extends Error {
	readonly retryable: boolean;
	readonly queueKey: string;
	readonly ownerActionId: string;

	constructor(options: { queueKey: string; ownerActionId: string }) {
		super(
			`Cannot admit a session action because an equivalent follow-up (key ${options.queueKey}) is already committing. ` +
				"Nothing was delivered; retry the same message after the current turn ends.",
		);
		this.name = "SessionInputCoalescingError";
		this.retryable = true;
		this.queueKey = options.queueKey;
		this.ownerActionId = options.ownerActionId;
	}
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
