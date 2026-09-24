import { afterEach, describe, expect, it } from "vitest";
import {
	clearProviderRequestBudgetCeiling,
	configureProviderRequestBudget,
	DEFAULT_MAX_TOTAL_PROVIDER_REQUESTS,
	forgetProviderRequestBudget,
	getProviderRequestBudget,
} from "../src/providers/request-budget.js";

/**
 * The agent loop creates a chain's budget on its first request, before the session
 * that owns the retry policy looks at it. Whichever layer creates the chain, the
 * ceiling must be the owner's, or the loop's default silently caps every chain.
 */
describe("provider request budget ceiling", () => {
	const chain = "chain-ceiling-test";
	afterEach(() => {
		forgetProviderRequestBudget(chain);
		clearProviderRequestBudgetCeiling(chain);
	});

	it("gives a chain the configured ceiling even when a layer without one creates it", () => {
		configureProviderRequestBudget(chain, 24);
		expect(getProviderRequestBudget(chain).maxRequests).toBe(24);
	});

	it("moves a live chain to the owner's ceiling without losing its count", () => {
		const budget = getProviderRequestBudget(chain);
		expect(budget.maxRequests).toBe(DEFAULT_MAX_TOTAL_PROVIDER_REQUESTS);
		for (let request = 0; request < DEFAULT_MAX_TOTAL_PROVIDER_REQUESTS; request += 1) budget.record();
		expect(budget.exhausted).toBe(true);

		expect(getProviderRequestBudget(chain, 24)).toBe(budget);
		expect([budget.used, budget.maxRequests, budget.exhausted]).toEqual([12, 24, false]);
	});

	it("keeps the configured ceiling for the next chain after one was forgotten", () => {
		configureProviderRequestBudget(chain, 30);
		getProviderRequestBudget(chain).record();
		forgetProviderRequestBudget(chain);
		const next = getProviderRequestBudget(chain);
		expect([next.used, next.maxRequests]).toEqual([0, 30]);

		clearProviderRequestBudgetCeiling(chain);
		forgetProviderRequestBudget(chain);
		expect(getProviderRequestBudget(chain).maxRequests).toBe(DEFAULT_MAX_TOTAL_PROVIDER_REQUESTS);
	});
});
