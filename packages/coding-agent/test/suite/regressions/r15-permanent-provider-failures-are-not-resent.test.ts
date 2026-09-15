import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

/**
 * RC-5: the session classified some provider failures as permanent (refusal, invalid
 * request, auth) and then retried them exactly once anyway, because the check asked
 * "have we already retried?" instead of "can a resend change the answer?". A refusal
 * therefore cost two full-context requests. The criterion asserted here: a failure is
 * only resent when the resend is a different question or a later one - never as an
 * identical copy of a request the provider already rejected.
 */
function structuredProviderFailure(failure: {
	kind: "auth" | "invalid_request" | "refusal";
	status?: number;
}): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: `provider ${failure.kind} failure` }),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: failure.kind, ...(failure.status === undefined ? {} : { status: failure.status }) },
			},
		],
	};
}

describe("permanent provider failures are not resent", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	for (const kind of ["refusal", "invalid_request", "auth"] as const) {
		it(`calls the provider once for a ${kind} failure that no resend can change`, async () => {
			const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
			harnesses.push(harness);
			harness.setResponses([
				structuredProviderFailure({ kind }),
				structuredProviderFailure({ kind }),
				fauxAssistantMessage("must not be requested"),
			]);

			await harness.session.prompt("test");

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.session.isRetrying).toBe(false);
		});
	}

	it("still retries a transient failure (positive control for the classifier)", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
	});

	it("keeps the single credential-refresh retry for a concrete 401 (issue #4491)", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		harnesses.push(harness);
		harness.setResponses([
			{
				...structuredProviderFailure({ kind: "auth", status: 401 }),
				errorMessage: "401 Unauthorized: invalid API key",
			},
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("test");

		// This retry re-resolves credentials instead of resending the same request, which
		// is why it is the one allowed exception. (Whether the refresh marks the source
		// stale on a *successful* retry belongs to #4491's own assertions, not this one.)
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
	});
});
