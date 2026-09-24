import { getLogger } from "../log.js";

/**
 * Cross-layer accounting for provider requests.
 *
 * Three independent layers can each turn one logical request into several billed HTTP
 * requests: the OpenAI/Anthropic SDK clients retry on their own (2 retries by default),
 * the agent loop resends clean-but-empty turns in place (3 attempts), and the session
 * resends a failed turn (3 retries by default). Each layer counted only its own attempts,
 * so the layers multiplied - up to a dozen or more identical full-context requests for one
 * failure - and nothing in the transcript said so.
 *
 * A budget is one counter shared by every layer that can issue a provider request for the
 * same request chain. Chains are reset by a *successful* response, never by a retry: the
 * budget bounds request amplification, it does not cap the many-request shape of a normal
 * agentic turn. When the budget runs out, the SDK layer stops retrying (see retry-cap.ts),
 * the loop stops resending empty turns, and the session stops resending the turn - each on
 * its own, and each with a notice.
 *
 * A chain is one model's attempt ladder. A session that deliberately starts a new ladder
 * (a switch to another model, a return to the primary, a recovery ping after a bounded
 * wait) resets the chain: those requests are the recovery design, not amplification, and
 * counting them into one pool ended an unattended task long before its waits ran.
 */

/**
 * Default ceiling for one request chain: four session attempts (3 retries + the original)
 * of three SDK requests each (2 retries + the original) with the stock settings. The
 * number is the envelope the layers already multiplied up to; the budget makes it shared
 * and enforced instead of per-layer and uncoordinated.
 */
export const DEFAULT_MAX_TOTAL_PROVIDER_REQUESTS = 12;

/** Why the client did not retry after this attempt, when it did not. */
export type ProviderRetrySuppression =
	/** The shared request budget had no requests left for another attempt. */
	| "request_budget"
	/** The server asked for a wait longer than `maxRetryDelayMs`. */
	| "retry_delay_cap";

/** One outbound provider request attempt, reported whether or not it was retried. */
export interface ProviderRequestAttemptNotice {
	/** 1-based attempt number inside the current chain (resets on a successful response). */
	attempt: number;
	/** Requests spent in this chain, including this one. */
	used: number;
	/** Chain ceiling, when the chain is bounded. */
	maxRequests?: number;
	/** HTTP status, absent when the attempt failed before a response arrived. */
	status?: number;
	/** True when the attempt failed without any response (connection error, timeout). */
	networkError?: boolean;
	/** Set when this attempt was the last one: the named layer refused to retry it. */
	retrySuppressedBy?: ProviderRetrySuppression;
}

const log = getLogger("ai.provider");

/**
 * One shared counter for a request chain. Immutable ceiling, mutable usage; every layer
 * that can issue a request for the chain records through the same instance.
 */
export class ProviderRequestBudget {
	private _used = 0;
	private _maxRequests: number | undefined;

	constructor(maxRequests?: number) {
		this._maxRequests = normalizeCeiling(maxRequests);
	}

	/** Requests spent in this chain. */
	get used(): number {
		return this._used;
	}

	/** Chain ceiling, if it has one. */
	get maxRequests(): number | undefined {
		return this._maxRequests;
	}

	/** Requests left in the chain, or `undefined` when the chain is unbounded. */
	get remaining(): number | undefined {
		return this._maxRequests === undefined ? undefined : Math.max(0, this._maxRequests - this._used);
	}

	/** True when no request is left for another attempt. */
	get exhausted(): boolean {
		return this._maxRequests !== undefined && this._used >= this._maxRequests;
	}

	/**
	 * Count one outbound request. `allowRetry` is false when this attempt used the last
	 * request of the chain, i.e. the caller must surface the failure instead of retrying.
	 */
	record(): { attempt: number; allowRetry: boolean; used: number; maxRequests?: number } {
		this._used += 1;
		return {
			attempt: this._used,
			allowRetry: !this.exhausted,
			used: this._used,
			maxRequests: this._maxRequests,
		};
	}

	/** Start a new chain: the previous one ended with a successful response, or a new ladder began. */
	reset(): void {
		this._used = 0;
	}

	/** Move the ceiling: the layer that owns the chain's retry policy knows its real envelope. */
	setMaxRequests(maxRequests: number | undefined): void {
		this._maxRequests = normalizeCeiling(maxRequests);
	}

	/** A short human-readable summary for messages and diagnostics. */
	describe(): string {
		const ceiling = this._maxRequests === undefined ? "no ceiling" : `ceiling ${this._maxRequests}`;
		return `${this._used} provider request(s) in this chain (${ceiling})`;
	}
}

function normalizeCeiling(maxRequests: number | undefined): number | undefined {
	return maxRequests === undefined ? undefined : Math.max(1, Math.floor(maxRequests));
}

const budgetsByChain = new Map<string, ProviderRequestBudget>();
const ceilingsByChain = new Map<string, number>();

/**
 * The budget shared by every layer working on one request chain.
 *
 * The chain id is the session id: the agent loop, the provider fetch wrapper and the
 * session all see the same session, so they all count into the same pool. Whichever
 * layer creates the chain first, its ceiling is the one configured for the chain (see
 * {@link configureProviderRequestBudget}), so the loop creating it before the session
 * looks cannot pin the chain to the default. An explicit `maxRequests` also moves an
 * existing chain's ceiling.
 */
export function getProviderRequestBudget(chainId: string, maxRequests?: number): ProviderRequestBudget {
	const existing = budgetsByChain.get(chainId);
	if (existing) {
		if (maxRequests !== undefined && existing.maxRequests !== normalizeCeiling(maxRequests)) {
			existing.setMaxRequests(maxRequests);
		}
		return existing;
	}
	const budget = new ProviderRequestBudget(
		maxRequests ?? ceilingsByChain.get(chainId) ?? DEFAULT_MAX_TOTAL_PROVIDER_REQUESTS,
	);
	budgetsByChain.set(chainId, budget);
	return budget;
}

/**
 * Set the ceiling every future budget of a chain starts with, and move a live one. The
 * layer that owns the retry policy (the session) calls this before handing a turn to the
 * loop, because the loop - not the session - creates the chain on the first request.
 */
export function configureProviderRequestBudget(chainId: string, maxRequests: number): void {
	ceilingsByChain.set(chainId, Math.max(1, Math.floor(maxRequests)));
	budgetsByChain.get(chainId)?.setMaxRequests(maxRequests);
}

/** Drop a chain's configured ceiling (its owner went away). */
export function clearProviderRequestBudgetCeiling(chainId: string): void {
	ceilingsByChain.delete(chainId);
}

/** The budget for a chain, if any layer already started counting one. */
export function peekProviderRequestBudget(chainId: string): ProviderRequestBudget | undefined {
	return budgetsByChain.get(chainId);
}

/**
 * Forget a chain. Called when the chain ends (successfully or terminally), so the pool
 * never outlives the request it accounts for.
 */
export function forgetProviderRequestBudget(chainId: string): void {
	budgetsByChain.delete(chainId);
}

/** Reset every layer's counter for a chain that ended with a successful response. */
export function resetProviderRequestBudget(chainId: string): void {
	budgetsByChain.get(chainId)?.reset();
}

/** Test seam: number of live chains (used to assert the pool does not grow). */
export function providerRequestBudgetChainCount(): number {
	return budgetsByChain.size;
}

/** One structured log line whenever a chain issues more than the first request, or is cut short. */
export function logProviderRequestAttempt(notice: ProviderRequestAttemptNotice, provider?: string): void {
	if (notice.attempt === 1 && notice.retrySuppressedBy === undefined) {
		return;
	}
	log.warn("provider request attempt", {
		provider,
		attempt: notice.attempt,
		used: notice.used,
		maxRequests: notice.maxRequests,
		status: notice.status,
		networkError: notice.networkError,
		retrySuppressedBy: notice.retrySuppressedBy,
	});
}
