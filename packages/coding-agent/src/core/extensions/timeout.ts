/**
 * Liveness backstop for extension factories and event handlers.
 *
 * Handlers still run to completion when they finish in time (sync semantics).
 * The timeout only fires when a handler or factory never returns, so the
 * session and abort path stay alive. AbortSignal, when provided, unblocks
 * sooner than the wall-clock timeout.
 */

export const DEFAULT_EXTENSION_HANDLER_TIMEOUT_MS = 30_000;

export class ExtensionTimeoutError extends Error {
	readonly timeoutMs: number;
	readonly label: string;

	constructor(label: string, timeoutMs: number) {
		super(`Extension ${label} timed out after ${timeoutMs}ms`);
		this.name = "ExtensionTimeoutError";
		this.label = label;
		this.timeoutMs = timeoutMs;
	}
}

export class ExtensionAbortedError extends Error {
	readonly label: string;

	constructor(label: string) {
		super(`Extension ${label} aborted`);
		this.name = "ExtensionAbortedError";
		this.label = label;
	}
}

export function awaitWithTimeout<T>(
	promise: Promise<T>,
	options: { timeoutMs: number; signal?: AbortSignal; label: string },
): Promise<T> {
	const { timeoutMs, signal, label } = options;
	if (signal?.aborted) {
		// The caller's promise still needs a handler: an unhandled rejection here is
		// fatal in daemon mode, which exits the whole process on unhandledRejection.
		void promise.catch(() => {});
		return Promise.reject(new ExtensionAbortedError(label));
	}

	const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0;
	if (!hasTimeout && !signal) {
		return promise;
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
			signal?.removeEventListener("abort", onAbort);
		};

		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			action();
		};

		const onAbort = () => {
			finish(() => reject(new ExtensionAbortedError(label)));
		};

		if (hasTimeout) {
			timer = setTimeout(() => {
				finish(() => reject(new ExtensionTimeoutError(label, timeoutMs)));
			}, timeoutMs);
		}

		signal?.addEventListener("abort", onAbort, { once: true });

		// Defensive only: the shortcut below cannot fire, because this function already
		// returned at the top when signal.aborted was set and nothing awaits in between.
		// Handlers are attached before it regardless, so the input promise always has one
		// if that ever changes; finish() is idempotent, so the ordering is safe. The
		// load-bearing half of the abort fix is the `void promise.catch(() => {})` at the
		// top of this function.
		promise.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);

		if (signal?.aborted) {
			onAbort();
		}
	});
}
