import { afterEach, describe, expect, it, vi } from "vitest";
import { REFINEMENT_OUTCOME_CUSTOM_TYPE } from "../../src/core/messages.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * K3R-8: a non-Error failure thrown out of the refinement application reaches
 * two catch sites - refine()'s own catch and the queued /refine command's
 * catch. The WeakSet idempotency keyed on the raw value missed both (strings
 * are not Objects; the queued path wraps in a fresh Error), so one failure
 * produced two refine_failed events and two receipts.
 */

vi.mock("../../src/core/refinement/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/refinement/index.js")>();
	return {
		...actual,
		applyRefinementProposal: () => {
			// A non-Error thrown value: legal JavaScript, and the exact shape the
			// receipt guard failed to deduplicate.
			throw "apply kaboom";
		},
	};
});

describe("K3R-8: refinement failure receipt idempotency for non-Error throws", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reports one receipt when the same non-Error failure passes both catch paths", async () => {
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => ({
						proposal: {
							summary: "planned summary",
							rationale: "r",
							expectedOutcome: "o",
							edits: [
								{
									action: "create" as const,
									kind: "memory" as const,
									title: "Note",
									content: "captured",
								},
							],
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		await harness.session.prompt("/refine").catch(() => {});

		// RED on HEAD: two refine_failed events and two failure receipts for one failure.
		expect(harness.eventsOfType("refine_failed")).toHaveLength(1);
		const receipts = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE,
		);
		expect(receipts).toHaveLength(1);
	});
});
