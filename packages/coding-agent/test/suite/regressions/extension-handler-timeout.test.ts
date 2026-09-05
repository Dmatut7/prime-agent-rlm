/**
 * A never-returning message_update handler used to freeze the agent event
 * queue, including abort. Per-handler timeout must keep the session live.
 */

import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.js";

describe("extension handler timeout keeps the session live", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("times out a hanging message_update handler so prompt and abort still complete", {
		timeout: 15_000,
	}, async () => {
		const errors: Array<{ event: string; error: string }> = [];
		const harness = await createHarness({
			settings: { extensionHandlerTimeoutMs: 40 },
			extensionFactories: [
				(pi) => {
					pi.on("message_update", async () => {
						await new Promise(() => {});
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			onError: (error) => {
				errors.push({ event: error.event, error: error.error });
			},
		});

		harness.setResponses([fauxAssistantMessage("still alive")]);
		const started = Date.now();
		await harness.session.prompt("hello");
		expect(getAssistantTexts(harness)).toEqual(["still alive"]);
		expect(errors.some((error) => error.event === "message_update" && error.error.includes("timed out"))).toBe(true);

		const abortStarted = Date.now();
		await harness.session.abort();
		expect(Date.now() - abortStarted).toBeLessThan(1000);
		expect(Date.now() - started).toBeLessThan(10_000);
	});
});
