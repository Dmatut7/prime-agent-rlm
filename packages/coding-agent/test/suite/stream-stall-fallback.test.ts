import type { Context, FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	providerStreamFailureKind,
	providerStreamFailureStatus,
	providerWaitClass,
} from "../../src/core/provider-retry.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, type Harness, type HarnessOptions } from "./harness.js";

/**
 * Wave-40 (review fix): a provider stream that accepts the request and then goes
 * silent - no events, no Retry-After wait on record - used to settle as an error
 * message with NO `provider_stream_failure` diagnostic. The session's
 * `providerWaitClass` reads a missing kind as "permanent", so the quick retries ran
 * but the backup model and the fallback chain never engaged: the task died on a dead
 * connection while a healthy fallback model sat configured. The loop now classifies
 * the stall as kind "unknown" (transient), and the chain takes over.
 */

const MODELS = [{ id: "faux-1" }, { id: "faux-kimi" }];

/** Accepts the request and never streams anything back: a dead connection. */
const hang = (): Promise<never> => new Promise<never>(() => {});

interface Call {
	model: string;
	context: Pick<Context, "messages">;
}

function settings(overrides: Partial<Settings> = {}): Partial<Settings> {
	return {
		providerFallbackModels: ["faux/faux-kimi"],
		retry: {
			enabled: true,
			maxRetries: 2,
			baseDelayMs: 1,
			provider: {
				streamStallTimeoutMs: 60,
				// Kept tiny so a misrouted wait class fails fast instead of parking the test.
				waitForUsage: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1, maxWaitMs: 5 },
				fallbackLongWait: { baseDelayMs: 5, maxDelayMs: 10, maxRounds: 3 },
			},
		},
		...overrides,
	};
}

describe("stream stall with no provider answer engages the fallback chain", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harnessWith(options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({
			models: MODELS,
			settings: settings(),
			shareRequestBudget: true,
			...options,
		});
		harnesses.push(harness);
		return harness;
	}

	it("classifies the stall as transient and the fallback model serves the turn", async () => {
		const harness = await harnessWith();
		// The suite harness constructs its Agent without the loop's stall timeout
		// (production wires it from retry.provider.streamStallTimeoutMs in sdk.ts), so
		// the test sets the same public field to the same value directly.
		harness.session.agent.streamStallTimeoutMs = 60;

		const calls: Call[] = [];
		const step: FauxResponseStep = (context, _options, _state, model) => {
			calls.push({ model: model.id, context: { messages: structuredClone(context.messages) } });
			return model.id === "faux-1" ? hang() : fauxAssistantMessage("recovered");
		};
		harness.setResponses(Array.from({ length: 8 }, () => step));

		await harness.session.prompt("do the work");

		// The stall classified as transient: quick retries on the primary, then the
		// fallback chain - never the dead-stop the missing diagnostic used to cause.
		expect(calls.map((call) => call.model)).toEqual(["faux-1", "faux-1", "faux-1", "faux-kimi"]);
		const stalled = [...harness.session.messages]
			.reverse()
			.find((message) => message.role === "assistant" && message.stopReason === "error");
		expect(stalled).toBeDefined();
		if (stalled?.role !== "assistant") throw new Error("expected the stalled assistant message on the transcript");
		expect(stalled.errorMessage).toContain("Stream stalled");
		expect(providerStreamFailureKind(stalled)).toBe("unknown");
		expect(
			providerWaitClass(
				providerStreamFailureKind(stalled),
				providerStreamFailureStatus(stalled),
				stalled.errorMessage,
			),
		).toBe("transient");
		const fallbackRetry = harness
			.eventsOfType("auto_retry_start")
			.find((event) => "backupModel" in event && event.backupModel !== undefined);
		expect(fallbackRetry && "backupModel" in fallbackRetry ? fallbackRetry.backupModel : undefined).toBe(
			"faux/faux-kimi",
		);
		const last = harness.session.messages.at(-1);
		expect(last?.role === "assistant" ? last.stopReason : undefined).toBe("stop");
	});
});
