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
