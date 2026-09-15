/**
 * Shared enforcement of `StreamOptions.maxRetryDelayMs` and of the cross-layer request
 * budget for SDK-backed providers.
 *
 * The OpenAI and Anthropic SDKs both implement "if the API asks us to wait a certain
 * amount of time, just do what it says": a `retry-after`/`retry-after-ms` header is
 * slept through verbatim with no upper bound. Both SDKs do honor the non-standard
 * `x-should-retry: false` response header, so a fetch wrapper is enough to (a) cap
 * server-requested waits at the configured value and (b) tell the caller that the
 * server answered and asked for a wait, which is a rate limit, not a dead connection.
 * The same header is what lets (c) the shared request budget stop an SDK retry: every
 * attempt passing through here is counted, and the attempt that spent the last request
 * of the chain is answered with "do not retry" so the SDK surfaces the provider's own
 * error instead of spending another request. This wrapper is the only place that sees
 * every SDK-level attempt, which is why the counting lives here.
 */

import {
	logProviderRequestAttempt,
	type ProviderRequestAttemptNotice,
	type ProviderRequestBudget,
} from "./request-budget.js";

/** Default cap for a server-requested retry wait, mirroring `retry.provider.maxRetryDelayMs`. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/** HTTP statuses the OpenAI and Anthropic SDKs treat as retryable. */
const SDK_RETRYABLE_STATUSES = new Set([408, 409, 418, 429]);

export interface ProviderRetryNotice {
	/** HTTP status the provider answered with. The server responded; the connection is alive. */
	status: number;
	/** Retry wait requested by the provider, in milliseconds. */
	delayMs: number;
	/** Raw `retry-after`/`retry-after-ms` value, when the provider sent one. */
	retryAfter?: string;
	/** True when the configured cap rejected the wait: the request fails instead of sleeping. */
	capped: boolean;
}

export interface RetryCapFetchOptions {
	/** Cap in ms. `0` disables the cap; undefined applies `DEFAULT_MAX_RETRY_DELAY_MS`. */
	maxRetryDelayMs?: number;
	/** Called for every server-requested retry wait, capped or not. */
	onProviderRetry?: (notice: ProviderRetryNotice) => void;
	/**
	 * Shared request budget for the current request chain. Every attempt through this
	 * wrapper is counted; the attempt that spends the last request of the chain is
	 * marked non-retryable for the SDK, so the provider's own error surfaces instead of
	 * another request being sent.
	 */
	requestBudget?: ProviderRequestBudget;
	/**
	 * Called for every provider request attempt, retried or not, with the attempt number
	 * and (when it was the last one) which layer refused to retry it. Diagnostic only.
	 */
	onProviderRequestAttempt?: (notice: ProviderRequestAttemptNotice) => void;
}

type SdkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Whether a status would make the OpenAI/Anthropic SDKs schedule another attempt. */
export function isSdkRetryableStatus(status: number): boolean {
	return SDK_RETRYABLE_STATUSES.has(status) || status >= 500;
}

/** Resolve the effective cap: `undefined` means "no cap" (`maxRetryDelayMs: 0`). */
export function resolveRetryDelayCapMs(maxRetryDelayMs?: number): number | undefined {
	if (maxRetryDelayMs === 0) return undefined;
	return maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
}

/** Parse `retry-after-ms` then `retry-after` (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfterMs(headers: Headers): number | undefined {
	const msRaw = headers.get("retry-after-ms");
	if (msRaw != null) {
		const ms = parseFloat(msRaw);
		if (!Number.isNaN(ms) && ms >= 0) return ms;
	}
	const raw = headers.get("retry-after");
	if (raw == null) return undefined;
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const seconds = Number(trimmed);
		if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
		return undefined;
	}
	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
	return undefined;
}

/**
 * Wrap `fetch` so a provider-requested retry wait above the cap fails immediately
 * (informative error, no sleep), every attempt is reported to `onProviderRequestAttempt`,
 * every server-requested wait is reported to `onProviderRetry`, and an exhausted request
 * budget stops the SDK from spending another request. Responses the SDK may not retry,
 * and waits within the cap, are passed through untouched.
 */
export function createRetryCapFetch(
	options: RetryCapFetchOptions = {},
	baseFetch: SdkFetch = globalThis.fetch,
): SdkFetch {
	const capMs = resolveRetryDelayCapMs(options.maxRetryDelayMs);
	const budget = options.requestBudget;
	const hasSink =
		options.onProviderRetry !== undefined || options.onProviderRequestAttempt !== undefined || budget !== undefined;
	const reportAttempt = (notice: ProviderRequestAttemptNotice): void => {
		try {
			options.onProviderRequestAttempt?.(notice);
		} catch {
			// A diagnostic sink must never change request behavior.
		}
		logProviderRequestAttempt(notice);
	};
	return async (input, init) => {
		let response: Response;
		try {
			response = await baseFetch(input, init);
		} catch (error) {
			// A connection that never answered is still a spent request, and the SDK
			// retrying it is exactly the invisible amplification this counts.
			const recorded = budget?.record();
			reportAttempt({
				attempt: recorded?.attempt ?? 1,
				used: recorded?.used ?? 1,
				maxRequests: recorded?.maxRequests,
				networkError: true,
				retrySuppressedBy: recorded && !recorded.allowRetry ? "request_budget" : undefined,
			});
			throw error;
		}
		if (!hasSink && capMs === undefined) return response;

		const recorded = budget?.record();
		const retryable = isSdkRetryableStatus(response.status);
		const delayMs = retryable ? parseRetryAfterMs(response.headers) : undefined;
		const capped = retryable && delayMs !== undefined && capMs !== undefined && delayMs > capMs;
		// The budget's last request was just spent: the SDK must not retry, or the chain
		// exceeds its ceiling. The provider's own error is kept either way.
		const budgetBlocked = retryable && recorded !== undefined && !recorded.allowRetry;
		if (delayMs !== undefined) {
			const retryAfter = response.headers.get("retry-after") ?? response.headers.get("retry-after-ms") ?? undefined;
			try {
				options.onProviderRetry?.({ status: response.status, delayMs, retryAfter, capped });
			} catch {
				// A diagnostic sink must never change request behavior.
			}
		}
		reportAttempt({
			attempt: recorded?.attempt ?? 1,
			used: recorded?.used ?? 1,
			maxRequests: recorded?.maxRequests,
			status: response.status,
			retrySuppressedBy: capped ? "retry_delay_cap" : budgetBlocked ? "request_budget" : undefined,
		});
		if (!capped && !budgetBlocked) return response;

		// Refuse the SDK's sleep or retry by keeping the provider's own error and marking
		// it non-retryable. The SDK then throws the status error right away, so the
		// failure keeps its real classification (a 429 stays a rate limit).
		const headers = new Headers(response.headers);
		headers.set("x-should-retry", "false");
		// The body is already decoded; keeping these headers would make the copy
		// attempt a second decode and garble the provider error text.
		headers.delete("content-encoding");
		headers.delete("content-length");
		return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
	};
}
