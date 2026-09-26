import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PROVIDER_FALLBACK_RETURN_AFTER_MS,
	providerLongWaitDelayMs,
	readProviderFallbackEntries,
} from "../../src/core/provider-fallback.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, getUserTexts, type Harness } from "./harness.js";

const CHAIN = ["faux/faux-1", "faux/faux-kimi", "faux/faux-qwen"];
const MODELS = [{ id: "faux-1" }, { id: "faux-kimi" }, { id: "faux-qwen" }];

function serverError(): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 internal_server_error" }),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "server_error", status: 500 },
			},
		],
	};
}

function quotaFailure(): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind: "rate_limit", status: 429 },
			},
		],
	};
}

/** Answers per model: each call is served by `script[modelId]` in turn; records which model served each call. */
function perModel(script: Record<string, AssistantMessage[]>, served: string[]): FauxResponseStep {
	return (_context, _options, _state, model) => {
		served.push(model.id);
		const queue = script[model.id];
		const next = queue?.shift();
		if (!next) throw new Error(`no scripted answer left for ${model.id}`);
		return next;
	};
}

function dutyEvents(harness: Harness): Array<Record<string, unknown>> {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "duty_event")
		.map((entry) => (entry as { data?: Record<string, unknown> }).data ?? {});
}

function settings(overrides: Partial<Settings> = {}): Partial<Settings> {
	return {
		providerFallbackModels: CHAIN,
		retry: {
			enabled: true,
			maxRetries: 2,
			baseDelayMs: 1,
			provider: {
				waitForUsage: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1, maxWaitMs: 5 },
				fallbackLongWait: { baseDelayMs: 5, maxDelayMs: 10, maxRounds: 3 },
			},
		},
		...overrides,
	};
}

const echoTool: AgentTool = {
	name: "echo",
	label: "echo",
	description: "echo",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: String((params as { text: string }).text) }],
		details: {},
	}),
};

describe("provider fallback chain (unattended self-recovery)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harnessWith(overrides?: Partial<Settings>, tools?: AgentTool[]): Promise<Harness> {
		const harness = await createHarness({
			models: MODELS,
			settings: settings(overrides),
			...(tools ? { tools } : {}),
		});
		harnesses.push(harness);
		return harness;
	}

	it("rides out a short 500 burst on the same model with quick retries", async () => {
		const harness = await harnessWith();
		const served: string[] = [];
		const step = perModel({ "faux-1": [serverError(), serverError(), fauxAssistantMessage("done")] }, served);
		harness.setResponses([step, step, step]);

		await harness.session.prompt("do the work");

		expect(served).toEqual(["faux-1", "faux-1", "faux-1"]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.reason)).toEqual([undefined, undefined]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(readProviderFallbackEntries(harness.sessionManager.getEntries())).toEqual([]);
	});

	it("moves to the next model once quick retries are spent and keeps the same task context", async () => {
		const harness = await harnessWith();
		const served: string[] = [];
		const step = perModel(
			{
				"faux-1": [serverError(), serverError(), serverError()],
				"faux-kimi": [fauxAssistantMessage("kimi answer")],
			},
			served,
		);
		harness.setResponses([step, step, step, step]);

		await harness.session.prompt("do the work");

		expect(served).toEqual(["faux-1", "faux-1", "faux-1", "faux-kimi"]);
		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts.map((event) => event.reason)).toEqual([undefined, undefined, "backup"]);
		expect(starts[2]?.backupModel).toBe("faux/faux-kimi");
		expect(starts[2]?.errorMessage).toBe("faux连续 500");
		// Same task: the one user prompt, answered by the fallback, no duplicate prompt.
		expect(getUserTexts(harness)).toEqual(["do the work"]);
		const last = harness.session.messages.at(-1);
		expect(last?.role === "assistant" ? last.model : undefined).toBe("faux-kimi");
		// Sticky: the next turn stays on the fallback.
		expect(harness.session.model?.id).toBe("faux-kimi");
		expect(readProviderFallbackEntries(harness.sessionManager.getEntries())).toEqual([
			expect.objectContaining({ kind: "switch", from: "faux/faux-1", to: "faux/faux-kimi", cause: "faux连续 500" }),
		]);
		expect(dutyEvents(harness).map((event) => event.kind)).toEqual([
			"provider_retry",
			"provider_retry",
			"model_fallback",
			"provider_retry",
		]);
		expect(dutyEvents(harness)[2]).toEqual({
			kind: "model_fallback",
			from: "faux/faux-1",
			to: "faux/faux-kimi",
			reason: "provider_errors",
		});
	});

	it("moves on at once when the model's quota is exhausted", async () => {
		const harness = await harnessWith();
		const served: string[] = [];
		const step = perModel({ "faux-1": [quotaFailure()], "faux-kimi": [fauxAssistantMessage("kimi answer")] }, served);
		harness.setResponses([step, step]);

		await harness.session.prompt("do the work");

		expect(served).toEqual(["faux-1", "faux-kimi"]);
		expect(harness.eventsOfType("auto_retry_start").map((event) => [event.reason, event.backupModel])).toEqual([
			["backup", "faux/faux-kimi"],
		]);
		expect(harness.session.model?.id).toBe("faux-kimi");
	});

	it("moves a run off a model that keeps calling tools that do not exist", async () => {
		const harness = await harnessWith({}, [echoTool]);
		const served: string[] = [];
		const garbage = fauxAssistantMessage(
			[
				fauxToolCall("ipythonscheduler_code_placeholder</arg_value>", {}),
				fauxToolCall("ipython_x", {}),
				fauxToolCall("garbage", {}),
			],
			{ stopReason: "toolUse" },
		);
		const step = perModel({ "faux-1": [garbage], "faux-kimi": [fauxAssistantMessage("kimi finished")] }, served);
		harness.setResponses([step, step]);

		await harness.session.prompt("do the work");

		// The same run's next request already went to the fallback.
		expect(served).toEqual(["faux-1", "faux-kimi"]);
		expect(harness.session.model?.id).toBe("faux-kimi");
		expect(readProviderFallbackEntries(harness.sessionManager.getEntries())).toEqual([
			expect.objectContaining({ kind: "switch", to: "faux/faux-kimi", cause: "连续 3 次无效工具调用" }),
		]);
		expect(dutyEvents(harness)).toEqual([
			{ kind: "model_fallback", from: "faux/faux-1", to: "faux/faux-kimi", reason: "bad_tool_calls" },
		]);
		const starts = harness.eventsOfType("auto_retry_start");
		expect(starts.map((event) => [event.reason, event.backupModel, event.errorMessage])).toEqual([
			["backup", "faux/faux-kimi", "连续 3 次无效工具调用"],
		]);
	});

	it("does not count failures of real tools as a storm", async () => {
		const failing: AgentTool = {
			...echoTool,
			execute: async () => {
				throw new Error("disk full");
			},
		};
		const harness = await harnessWith({}, [failing]);
		const served: string[] = [];
		const calls = fauxAssistantMessage(
			[
				fauxToolCall("echo", { text: "a" }),
				fauxToolCall("echo", { text: "b" }),
				fauxToolCall("echo", { text: "c" }),
			],
			{ stopReason: "toolUse" },
		);
		const step = perModel({ "faux-1": [calls, fauxAssistantMessage("gave up")] }, served);
		harness.setResponses([step, step]);

		await harness.session.prompt("do the work");

		expect(served).toEqual(["faux-1", "faux-1"]);
		expect(readProviderFallbackEntries(harness.sessionManager.getEntries())).toEqual([]);
	});

	it("waits in long rounds when every model fails, then starts over on the primary instead of ending", async () => {
		const harness = await harnessWith();
		const served: string[] = [];
		const failing = (count: number) => Array.from({ length: count }, () => serverError());
		const step = perModel(
			{
				// The primary: first try plus 2 quick retries; the answer comes after the long wait.
				"faux-1": [...failing(3), fauxAssistantMessage("back on the primary")],
				// Each fallback: the switched attempt plus one quick retry (the shared attempt counter).
				"faux-kimi": failing(2),
				// The last model also takes the bounded wait's single ping.
				"faux-qwen": failing(3),
			},
			served,
		);
		harness.setResponses(Array.from({ length: 12 }, () => step));

		await harness.session.prompt("do the work");

		expect(served).toEqual([
			"faux-1",
			"faux-1",
			"faux-1",
			"faux-kimi",
			"faux-kimi",
			"faux-qwen",
			"faux-qwen",
			"faux-qwen",
			"faux-1",
		]);
		const last = harness.session.messages.at(-1);
		expect(last?.role === "assistant" ? last.stopReason : undefined).toBe("stop");
		expect(harness.session.model?.id).toBe("faux-1");
		const longWaits = harness.eventsOfType("auto_retry_start").filter((event) => event.delayMs === 5);
		expect(longWaits.map((event) => [event.reason, event.attempt])).toEqual([["unavailable", 1]]);
		expect(readProviderFallbackEntries(harness.sessionManager.getEntries()).map((entry) => entry.kind)).toEqual([
			"switch",
			"switch",
			"return",
			"long_wait",
		]);
		expect(harness.eventsOfType("auto_retry_end").at(-1)?.success).toBe(true);
	});

	it("probes the primary again once the cooldown has passed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const harness = await harnessWith();
		const served: string[] = [];
		const step = perModel(
			{
				"faux-1": [quotaFailure(), fauxAssistantMessage("primary is back")],
				"faux-kimi": [fauxAssistantMessage("kimi answer"), fauxAssistantMessage("still kimi")],
			},
			served,
		);
		harness.setResponses([step, step, step, step]);

		await harness.session.prompt("one");
		expect(harness.session.model?.id).toBe("faux-kimi");
		await harness.session.prompt("two");
		expect(served.at(-1)).toBe("faux-kimi");

		vi.setSystemTime(Date.now() + PROVIDER_FALLBACK_RETURN_AFTER_MS + 1_000);
		await harness.session.prompt("three");

		expect(served).toEqual(["faux-1", "faux-kimi", "faux-kimi", "faux-1"]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(readProviderFallbackEntries(harness.sessionManager.getEntries()).map((entry) => entry.kind)).toEqual([
			"switch",
			"return",
		]);
		expect(dutyEvents(harness).at(-1)).toEqual({ kind: "model_restored", to: "faux/faux-1" });
	});

	it("never switches when the chain is off", async () => {
		const harness = await harnessWith({ providerFallbackModels: [] });
		const served: string[] = [];
		const step = perModel({ "faux-1": [quotaFailure(), fauxAssistantMessage("waited it out")] }, served);
		harness.setResponses([step, step]);

		await harness.session.prompt("do the work");

		expect(served).toEqual(["faux-1", "faux-1"]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("auto_retry_start").some((event) => event.reason === "backup")).toBe(false);
	});

	it("is off when providerFallbackModels is unset: no model fleet is built in", async () => {
		const harness = await createHarness({
			models: MODELS,
			settings: { ...settings(), providerFallbackModels: undefined },
		});
		harnesses.push(harness);
		const served: string[] = [];
		const step = perModel({ "faux-1": [quotaFailure(), fauxAssistantMessage("waited it out")] }, served);
		harness.setResponses([step, step]);

		await harness.session.prompt("do the work");

		expect(served).toEqual(["faux-1", "faux-1"]);
	});

	it("skips a model that cannot see images when the context holds images the serving model reads", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", input: ["text", "image"] },
				{ id: "faux-kimi", input: ["text"] },
				{ id: "faux-qwen", input: ["text", "image"] },
			],
			settings: settings(),
		});
		harnesses.push(harness);
		const served: string[] = [];
		const step = perModel(
			{ "faux-1": [quotaFailure()], "faux-qwen": [fauxAssistantMessage("qwen saw the picture")] },
			served,
		);
		harness.setResponses([step, step]);

		await harness.session.prompt("what is in this picture?", {
			images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
		});

		expect(served).toEqual(["faux-1", "faux-qwen"]);
	});

	it("pins the session to an explicitly selected model: quota pressure stays put", async () => {
		const harness = await harnessWith();
		const served: string[] = [];
		const step = perModel(
			{
				"faux-1": [quotaFailure(), quotaFailure(), quotaFailure(), quotaFailure()],
				"faux-kimi": [fauxAssistantMessage("kimi must not serve")],
				"faux-qwen": [fauxAssistantMessage("qwen must not serve")],
			},
			served,
		);
		harness.setResponses([step, step, step, step]);
		const pinned = harness.getModel("faux-1");
		expect(pinned).toBeDefined();
		await harness.session.setModel(pinned!);
		await harness.session.prompt("do the work");
		expect(served.every((id) => id === "faux-1")).toBe(true);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("re-pins on the next explicit choice: a pinned session can still be moved by hand", async () => {
		const harness = await harnessWith();
		const served: string[] = [];
		const step = perModel(
			{
				"faux-1": [quotaFailure(), fauxAssistantMessage("back on one")],
				"faux-kimi": [fauxAssistantMessage("kimi answer")],
				"faux-qwen": [quotaFailure(), quotaFailure(), quotaFailure()],
			},
			served,
		);
		harness.setResponses([step, step, step, step, step]);
		// Unpinned start: quota moves the session along the chain as before.
		await harness.session.prompt("one");
		expect(served).toEqual(["faux-1", "faux-kimi"]);
		// The owner picks qwen by hand: that pins qwen.
		const qwen = harness.getModel("faux-qwen");
		expect(qwen).toBeDefined();
		await harness.session.setModel(qwen!);
		await harness.session.prompt("two");
		expect(served.slice(2).every((id) => id === "faux-qwen")).toBe(true);
		expect(harness.session.model?.id).toBe("faux-qwen");
	});

	it("gives explicit user model choices precedence over a running fallback", async () => {
		const harness = await harnessWith();
		const served: string[] = [];
		const step = perModel(
			{
				"faux-1": [quotaFailure()],
				"faux-kimi": [fauxAssistantMessage("kimi")],
				"faux-qwen": [fauxAssistantMessage("qwen")],
			},
			served,
		);
		harness.setResponses([step, step, step]);
		await harness.session.prompt("one");
		const qwen = harness.getModel("faux-qwen");
		expect(qwen).toBeDefined();
		await harness.session.setModel(qwen!);
		await harness.session.prompt("two");
		expect(served.at(-1)).toBe("faux-qwen");
		expect(harness.session.model?.id).toBe("faux-qwen");
	});
});

describe("providerLongWaitDelayMs", () => {
	it("doubles from the base up to the ceiling", () => {
		expect([1, 2, 3, 4, 10].map((round) => providerLongWaitDelayMs(round))).toEqual([
			300_000, 600_000, 1_200_000, 1_200_000, 1_200_000,
		]);
		expect(providerLongWaitDelayMs(2, 5, 7)).toBe(7);
	});
});
