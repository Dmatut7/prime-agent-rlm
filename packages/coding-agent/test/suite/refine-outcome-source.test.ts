import { afterEach, describe, expect, it } from "vitest";
import { REFINEMENT_OUTCOME_CUSTOM_TYPE, type RefinementOutcomeMessage } from "../../src/core/messages.js";
import type { ExtensionFactory } from "../../src/index.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * wave-47 FRESH-EYES A: the refinement outcome row hid whenever nothing went
 * wrong (the auto-tidy quiet rule), so a user-invoked /refine left zero visible
 * feedback - the loader vanished and the transcript showed a bare `/refine`.
 * The outcome now stamps how the refinement was initiated (`details.source`) so
 * the TUI keeps user-invoked outcomes visible while background tidies stay
 * quiet. These tests pin the stamping at the session boundary; the render
 * behavior is pinned in test/refinement-outcome-message.test.ts.
 */

/** A refinement pass whose planner decides there is nothing to change. */
const noOpRefine: ExtensionFactory = (pi) => {
	pi.on("session_before_refine", async () => ({
		proposal: {
			summary: "No refinement needed: nothing reusable.",
			rationale: "r",
			expectedOutcome: "o",
			edits: [],
		},
	}));
};

function outcomes(harness: Harness): RefinementOutcomeMessage[] {
	return harness.session.messages.filter(
		(message): message is RefinementOutcomeMessage =>
			message.role === "custom" && message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE,
	);
}

describe("refinement outcome source stamping (wave-47 A)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("stamps the queued /refine outcome as user-initiated", async () => {
		const harness = await createHarness({ persistSession: true, extensionFactories: [noOpRefine] });
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello");

		await harness.session.prompt("/refine");

		const found = outcomes(harness);
		expect(found).toHaveLength(1);
		expect(found[0]!.details.source).toBe("user");
		expect(found[0]!.details.edits).toEqual([]);
	});

	it("stamps an auto-triggered refine as auto", async () => {
		const harness = await createHarness({ persistSession: true, extensionFactories: [noOpRefine] });
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello");

		await harness.session.refine({}, { trigger: "auto" });

		const found = outcomes(harness);
		expect(found).toHaveLength(1);
		expect(found[0]!.details.source).toBe("auto");
	});
});
