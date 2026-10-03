import {
	type AssistantMessage,
	type Context,
	type FauxResponseStep,
	fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/core/compaction/index.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * CC 2.1.282: a compaction whose summarization request is refused gets one retry
 * on the configured fallback model. The refusal is a verdict of the model that
 * answered, not of the request, so only a fallback that also fails (or none at
 * all) counts as a compaction failure.
 */

const REFUSAL_MESSAGE = "Model refused to respond (refusal)";

/** The wave-31 refusal shape: an errored reply carrying the structured kind and the raw stop reason. */
function refusalResponse(): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: REFUSAL_MESSAGE }),
		stopReasonRaw: "refusal",
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "refusal", providerErrorType: "refusal" },
			},
		],
	};
}

const MODELS = [{ id: "faux-1" }, { id: "faux-kimi" }];

/**
 * Answers per call: ordinary turns get a plain reply; summarization calls (the
 * summarizer's own system prompt is the tell) follow the per-model script.
 */
function scriptedStep(calls: string[], summarizationScript: Record<string, () => AssistantMessage>): FauxResponseStep {
	return (context: Context, _options, _state, model) => {
		calls.push(model.id);
		if (context.systemPrompt === SUMMARIZATION_SYSTEM_PROMPT) {
			const script = summarizationScript[model.id];
			if (!script) throw new Error(`no scripted summarization answer for ${model.id}`);
			return script();
		}
		return fauxAssistantMessage(`reply from ${model.id}`);
	};
}

describe("compaction summarization refusal (CC 2.1.282)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createRefusalHarness(providerFallbackModels: string[] | undefined): Promise<Harness> {
		const harness = await createHarness({
			models: MODELS,
			settings: {
				compaction: { enabled: true, reserveTokens: 500, keepRecentTokens: 1 },
				...(providerFallbackModels ? { providerFallbackModels } : {}),
			},
		});
		harnesses.push(harness);
		return harness;
	}

	it("retries a refused summarization once on the fallback model and commits its summary", async () => {
		const harness = await createRefusalHarness(["faux/faux-kimi"]);
		const calls: string[] = [];
		const step = scriptedStep(calls, {
			"faux-1": refusalResponse,
			"faux-kimi": () => fauxAssistantMessage("summary written by the fallback model"),
		});
		harness.setResponses([step, step, step, step]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const result = await harness.session.compact();

		expect(result.summary).toContain("summary written by the fallback model");
		// Two turns on the session model, the refused summarization on it, then exactly
		// one retry on the fallback - the retry is one-shot.
		expect(calls).toEqual(["faux-1", "faux-1", "faux-1", "faux-kimi"]);
		// The recovered compaction is a success end to end: the refusal never reaches
		// the failure path, so it never counts toward the consecutive-failure streak.
		const ends = harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toBeUndefined();
		expect(ends[0]?.result?.summary).toContain("summary written by the fallback model");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("counts the refusal as one failure when no fallback model is configured", async () => {
		const harness = await createRefusalHarness(undefined);
		const calls: string[] = [];
		const step = scriptedStep(calls, { "faux-1": refusalResponse });
		harness.setResponses([step, step, step]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await expect(harness.session.compact()).rejects.toThrow(REFUSAL_MESSAGE);

		// No fallback, no retry: one summarization call, one failure.
		expect(calls).toEqual(["faux-1", "faux-1", "faux-1"]);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.result).toBeUndefined();
		expect(ends[0]?.errorMessage).toContain(REFUSAL_MESSAGE);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("stops after one fallback attempt when the fallback refuses too", async () => {
		const harness = await createRefusalHarness(["faux/faux-kimi"]);
		const calls: string[] = [];
		const step = scriptedStep(calls, { "faux-1": refusalResponse, "faux-kimi": refusalResponse });
		harness.setResponses([step, step, step, step, step]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await expect(harness.session.compact()).rejects.toThrow(REFUSAL_MESSAGE);

		// The fallback's refusal surfaces as the failure; the chain is not walked further.
		expect(calls).toEqual(["faux-1", "faux-1", "faux-1", "faux-kimi"]);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.result).toBeUndefined();
		expect(ends[0]?.errorMessage).toContain(REFUSAL_MESSAGE);
	});

	it("does not spend the fallback retry on a non-refusal summarization failure", async () => {
		const harness = await createRefusalHarness(["faux/faux-kimi"]);
		const calls: string[] = [];
		const serverError = () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 internal_server_error" });
		const step = scriptedStep(calls, {
			"faux-1": serverError,
			"faux-kimi": () => fauxAssistantMessage("summary written by the fallback model"),
		});
		harness.setResponses([step, step, step, step]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await expect(harness.session.compact()).rejects.toThrow("500 internal_server_error");

		// A server error is not a refusal: no model switch, the failure stays put.
		expect(calls).toEqual(["faux-1", "faux-1", "faux-1"]);
		const ends = harness.eventsOfType("compaction_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.errorMessage).toContain("500 internal_server_error");
	});
});
