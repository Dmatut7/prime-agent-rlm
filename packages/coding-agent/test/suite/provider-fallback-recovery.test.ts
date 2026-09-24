import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE,
	PROVIDER_FALLBACK_RETURN_AFTER_MS,
	PROVIDER_LONG_WAIT_RESUME_MARKER_TEXT,
	readProviderFallbackEntries,
} from "../../src/core/provider-fallback.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, type Harness, type HarnessOptions } from "./harness.js";

/**
 * Business-logic holes of the fallback chain, each driven through the session's
 * public entry points: the request budget that ended a chain before its waits ran,
 * restarts mid-episode, image routing beside a fallback, explicit picks, a backup
 * that was mistaken for the primary, subagents, a misconfigured chain, quota and
 * auth shapes the chain never saw, and a provider's content filter.
 */

const FILTERED_TEXT = "DDoS attack firewall bypass log";

const MODELS = [{ id: "faux-1" }, { id: "faux-kimi" }, { id: "faux-qwen" }, { id: "faux-glm" }];

function failure(errorMessage: string, details: Record<string, unknown>): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		diagnostics: [{ type: "provider_stream_failure", timestamp: Date.now(), details }],
	};
}
const serverError = () => failure("500 internal_server_error", { kind: "server_error", status: 500 });
const quotaFailure = () => failure("429 quota exceeded", { kind: "rate_limit", status: 429 });

interface Call {
	model: string;
	context: Pick<Context, "messages">;
	budget?: { used: number; maxRequests?: number };
}

/**
 * Answers per model; every call spends one request from the chain's shared budget,
 * exactly as the provider fetch wrapper does for a real HTTP request.
 */
function perModel(script: Record<string, Array<AssistantMessage | (() => AssistantMessage)>>, calls: Call[]) {
	const step: FauxResponseStep = (context, options, _state, model) => {
		const recorded = options?.requestBudget?.record();
		calls.push({
			model: model.id,
			context: { messages: structuredClone(context.messages) },
			...(recorded ? { budget: { used: recorded.used, maxRequests: recorded.maxRequests } } : {}),
		});
		const next = script[model.id]?.shift();
		if (!next) throw new Error(`no scripted answer left for ${model.id}`);
		return typeof next === "function" ? next() : next;
	};
	return step;
}

function settings(overrides: Partial<Settings> = {}): Partial<Settings> {
	return {
		providerFallbackModels: ["faux/faux-kimi", "faux/faux-qwen"],
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

function customEntries(harness: Harness, customType: string): Array<Record<string, unknown>> {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === customType)
		.map((entry) => (entry as { data?: Record<string, unknown> }).data ?? {});
}

function notices(harness: Harness): Array<{ text: string; kind: unknown }> {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE)
		.map((entry) => {
			const message = entry as { content?: unknown; details?: { kind?: unknown } };
			return { text: String(message.content), kind: message.details?.kind };
		});
}

function contextText(context: Pick<Context, "messages">): string {
	return JSON.stringify(context.messages);
}

/** Returns raw log text of the kind a provider's content filter refuses. */
const readLogTool: AgentTool = {
	name: "read_log",
	label: "read_log",
	description: "read the server log",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: FILTERED_TEXT }], details: {} }),
};

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

describe("fallback chain business logic", () => {
	const harnesses: Harness[] = [];
	const extraProviders: FauxProviderRegistration[] = [];
	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (extraProviders.length > 0) extraProviders.pop()?.unregister();
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

	/** A second provider in the same registry, for the failures bound to one provider. */
	function addOtherProvider(harness: Harness, step: FauxResponseStep, count: number): void {
		const other = registerFauxProvider({ provider: "otherco", models: [{ id: "other-1" }] });
		extraProviders.push(other);
		other.setResponses(Array.from({ length: count }, () => step));
		harness.authStorage.setRuntimeApiKey("otherco", "other-key");
		harness.modelRegistry.registerProvider("otherco", {
			baseUrl: other.models[0].baseUrl,
			apiKey: "other-key",
			api: other.api,
			models: other.models.map((model) => ({
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			})),
		});
	}

	it("gives every model of the chain its own request ladder, so the bounded wait still runs (item 1)", async () => {
		const harness = await harnessWith({
			settings: settings({
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					provider: {
						waitForUsage: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 40, maxWaitMs: 20_000 },
					},
				},
			}),
		});
		const calls: Call[] = [];
		const fail = (count: number) => Array.from({ length: count }, () => serverError);
		const step = perModel(
			{
				"faux-1": fail(4),
				"faux-kimi": fail(3),
				// The last model: its quick retries, then 27 pings of the bounded wait until it answers.
				"faux-qwen": [...fail(29), () => fauxAssistantMessage("finally served")],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 40 }, () => step));

		await harness.session.prompt("do the work");

		// 37 requests for one turn, far past any single ceiling, and the turn still lands:
		// each model's ladder and each recovery ping starts a fresh pool.
		expect(calls.map((call) => call.model)).toEqual([
			...Array(4).fill("faux-1"),
			...Array(3).fill("faux-kimi"),
			...Array(30).fill("faux-qwen"),
		]);
		const last = harness.session.messages.at(-1);
		expect(last?.role === "assistant" ? last.stopReason : undefined).toBe("stop");
		const failedEnds = harness.eventsOfType("auto_retry_end").filter((event) => !event.success);
		expect(failedEnds).toEqual([]);
		// The session's envelope (4 attempts x 6 in-place requests) is the ceiling the loop
		// counts against, not the loop's default of 12.
		expect(calls[0]?.budget?.maxRequests).toBe(24);
		// Within one model's ladder the requests still add up.
		expect(calls.slice(0, 4).map((call) => call.budget?.used)).toEqual([1, 2, 3, 4]);
	});

	it("rebuilds the episode after a restart, so the cooldown still returns to the primary (item 2)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const first = await harnessWith({ persistSession: true });
		first.sessionManager.materializeSessionFile();
		const calls: Call[] = [];
		const step = perModel({ "faux-1": [quotaFailure], "faux-kimi": [() => fauxAssistantMessage("kimi")] }, calls);
		first.setResponses([step, step]);
		await first.session.prompt("one");
		expect(first.session.model?.id).toBe("faux-kimi");
		const sessionFile = first.session.sessionFile!;
		first.session.dispose();

		const restarted = await harnessWith({ existingSessionFile: sessionFile, restoreSessionModel: true });
		expect(restarted.session.model?.id).toBe("faux-kimi");
		vi.setSystemTime(Date.now() + PROVIDER_FALLBACK_RETURN_AFTER_MS + 1_000);
		const after: Call[] = [];
		restarted.setResponses([perModel({ "faux-1": [() => fauxAssistantMessage("primary is back")] }, after)]);
		await restarted.session.prompt("two");

		expect(after.map((call) => call.model)).toEqual(["faux-1"]);
		expect(restarted.session.model?.id).toBe("faux-1");
		expect(readProviderFallbackEntries(restarted.sessionManager.getEntries()).map((entry) => entry.kind)).toEqual([
			"switch",
			"return",
		]);
	});

	it("does not rebuild an episode the owner ended with an explicit pick before the restart (item 2)", async () => {
		const first = await harnessWith({ persistSession: true });
		first.sessionManager.materializeSessionFile();
		const calls: Call[] = [];
		first.setResponses([
			perModel({ "faux-1": [quotaFailure], "faux-kimi": [() => fauxAssistantMessage("k")] }, calls),
		]);
		first.appendResponses([perModel({ "faux-kimi": [() => fauxAssistantMessage("k")] }, calls)]);
		await first.session.prompt("one");
		await first.session.setModel(first.getModel("faux-kimi")!);
		const sessionFile = first.session.sessionFile!;
		first.session.dispose();

		vi.useFakeTimers({ toFake: ["Date"] });
		const restarted = await harnessWith({ existingSessionFile: sessionFile, restoreSessionModel: true });
		vi.setSystemTime(Date.now() + PROVIDER_FALLBACK_RETURN_AFTER_MS + 1_000);
		const after: Call[] = [];
		restarted.setResponses([perModel({ "faux-kimi": [() => fauxAssistantMessage("still kimi")] }, after)]);
		await restarted.session.prompt("two");
		expect(after.map((call) => call.model)).toEqual(["faux-kimi"]);
	});

	it("backs a long wait with a durable wake that a live process cancels, and a dispose keeps (item 2)", async () => {
		const harness = await harnessWith({
			persistSession: true,
			settings: settings({
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					provider: {
						waitForUsage: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1, maxWaitMs: 5 },
						fallbackLongWait: { baseDelayMs: 40, maxDelayMs: 40, maxRounds: 3 },
					},
				},
			}),
		});
		harness.sessionManager.materializeSessionFile();
		const calls: Call[] = [];
		const step = perModel(
			{
				"faux-1": [serverError, () => fauxAssistantMessage("back")],
				"faux-kimi": [serverError],
				"faux-qwen": [serverError, serverError],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 8 }, () => step));
		const jobsFile = join(harness.sessionManager.getSessionArtifactDir()!, "scheduled-jobs.json");
		const readJobs = () =>
			(
				JSON.parse(readFileSync(jobsFile, "utf-8")) as {
					jobs: Array<{ id: string; status: string; prompt: string }>;
				}
			).jobs;
		let duringWait: Array<{ id: string; status: string; prompt: string }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start" && event.reason === "unavailable" && event.delayMs === 40) {
				duringWait = readJobs();
			}
		});

		await harness.session.prompt("do the work");

		const longWait = customEntries(harness, "provider_fallback").find((entry) => entry.kind === "long_wait");
		expect(longWait?.jobId).toBeTypeOf("string");
		expect(duringWait.find((job) => job.id === longWait?.jobId)).toMatchObject({
			status: "active",
			prompt: PROVIDER_LONG_WAIT_RESUME_MARKER_TEXT,
		});
		// The live process woke first, so the job must never fire a second resume.
		expect(readJobs().find((job) => job.id === longWait?.jobId)?.status).toBe("cancelled");
		expect(calls.at(-1)?.model).toBe("faux-1");

		// A process going away mid-wait keeps the job: it is the only thing left to resume the task.
		const second = await harnessWith({
			persistSession: true,
			settings: settings({
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					provider: {
						waitForUsage: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1, maxWaitMs: 5 },
						fallbackLongWait: { baseDelayMs: 30, maxDelayMs: 30, maxRounds: 3 },
					},
				},
			}),
		});
		second.sessionManager.materializeSessionFile();
		const secondCalls: Call[] = [];
		const secondStep = perModel(
			{ "faux-1": [serverError], "faux-kimi": [serverError], "faux-qwen": [serverError, serverError] },
			secondCalls,
		);
		second.setResponses(Array.from({ length: 6 }, () => secondStep));
		const waiting = new Promise<void>((resolve) => {
			second.session.subscribe((event) => {
				if (event.type === "auto_retry_start" && event.delayMs === 30) resolve();
			});
		});
		void second.session.prompt("do the work");
		await waiting;
		second.session.dispose();
		await new Promise((resolve) => setTimeout(resolve, 80));
		const secondJobsFile = join(second.sessionManager.getSessionArtifactDir()!, "scheduled-jobs.json");
		const secondJobs = (JSON.parse(readFileSync(secondJobsFile, "utf-8")) as { jobs: Array<{ status: string }> })
			.jobs;
		expect(secondJobs.map((job) => job.status)).toEqual(["active"]);
	});

	it("keeps this run's image routing when the cooldown returns to the primary (item 3)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const harness = await harnessWith({
			models: [
				{ id: "faux-1", input: ["text"] },
				{ id: "faux-kimi", input: ["text"] },
				{ id: "faux-vision", input: ["text", "image"] },
			],
			settings: settings({ providerFallbackModels: ["faux/faux-kimi"], imageModel: "faux/faux-vision" }),
			tools: [echoTool],
		});
		const calls: Call[] = [];
		const step = perModel(
			{
				"faux-1": [quotaFailure],
				"faux-kimi": [() => fauxAssistantMessage("kimi")],
				"faux-vision": [
					() => fauxAssistantMessage([fauxToolCall("echo", { text: "look closer" })], { stopReason: "toolUse" }),
					() => fauxAssistantMessage("a red square"),
				],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 6 }, () => step));
		await harness.session.prompt("one");
		expect(harness.session.model?.id).toBe("faux-kimi");

		vi.setSystemTime(Date.now() + PROVIDER_FALLBACK_RETURN_AFTER_MS + 1_000);
		await harness.session.prompt("what is in this picture?", {
			images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
		});

		// Both requests of the image run stay on the image model the run was routed to.
		expect(calls.slice(2).map((call) => call.model)).toEqual(["faux-vision", "faux-vision"]);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("moves only the routed image model along the chain, never the owner's session model (item 4)", async () => {
		const harness = await harnessWith({
			models: [
				{ id: "faux-1", input: ["text"] },
				{ id: "faux-kimi", input: ["text"] },
				{ id: "faux-vision", input: ["text", "image"] },
				{ id: "faux-qwen-vl", input: ["text", "image"] },
			],
			settings: settings({
				providerFallbackModels: ["faux/faux-kimi", "faux/faux-qwen-vl"],
				imageModel: "faux/faux-vision",
			}),
		});
		const calls: Call[] = [];
		const step = perModel(
			{
				"faux-vision": [quotaFailure],
				"faux-qwen-vl": [() => fauxAssistantMessage("a red square")],
				"faux-1": [() => fauxAssistantMessage("text turn")],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 4 }, () => step));

		await harness.session.prompt("what is in this picture?", {
			images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
		});
		expect(calls.map((call) => call.model)).toEqual(["faux-vision", "faux-qwen-vl"]);
		expect(harness.session.model?.id).toBe("faux-1");

		await harness.session.prompt("thanks");
		expect(calls.at(-1)?.model).toBe("faux-1");
		expect(readProviderFallbackEntries(harness.sessionManager.getEntries())).toEqual([
			expect.objectContaining({ kind: "switch", scope: "image", from: "faux/faux-vision", to: "faux/faux-qwen-vl" }),
		]);
	});

	it("hands an unreadable image turn back to the session model instead of parking on the image model's credit (item 4)", async () => {
		const harness = await harnessWith({
			models: [
				{ id: "faux-1", input: ["text"] },
				{ id: "faux-kimi", input: ["text"] },
				{ id: "faux-vision", input: ["text", "image"] },
			],
			settings: settings({
				providerFallbackModels: ["faux/faux-kimi"],
				imageModel: "faux/faux-vision",
				retry: {
					enabled: true,
					maxRetries: 2,
					baseDelayMs: 1,
					provider: {
						waitForUsage: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 5, maxWaitMs: 1_000 },
					},
				},
			}),
		});
		const calls: Call[] = [];
		const step = perModel(
			{
				"faux-vision": [
					() =>
						failure("429 quota exceeded, try again in 5 hours", {
							kind: "rate_limit",
							status: 429,
							retryAfterMs: 18_000_000,
						}),
				],
				"faux-1": [() => fauxAssistantMessage("I could not read the image")],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 3 }, () => step));

		await harness.session.prompt("what is in this picture?", {
			images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }],
		});

		expect(calls.map((call) => call.model)).toEqual(["faux-vision", "faux-1"]);
		expect(harness.session.isQuotaParked).toBe(false);
		expect(harness.session.model?.id).toBe("faux-1");
		// The session model is told nobody read the image.
		expect(contextText(calls[1]!.context)).toContain("[Image not read]");
		expect(notices(harness).map((notice) => notice.kind)).toEqual(["image_unread"]);
		expect(notices(harness)[0]?.text).toContain("图片没能读取");
		// The owner notice never reaches the model.
		expect(contextText(calls[1]!.context)).not.toContain("图片没能读取");
	});

	it("ends the episode on a Ctrl+P model cycle, so a later failure starts from the owner's pick (item 5)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const harness = await harnessWith({
			settings: settings({ providerFallbackModels: ["faux/faux-kimi", "faux/faux-qwen", "faux/faux-glm"] }),
		});
		const calls: Call[] = [];
		const step = perModel(
			{
				"faux-1": [quotaFailure],
				"faux-kimi": [() => fauxAssistantMessage("kimi"), () => fauxAssistantMessage("kimi again")],
				"faux-qwen": [quotaFailure, () => fauxAssistantMessage("qwen is back")],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 6 }, () => step));
		await harness.session.prompt("one");
		expect(harness.session.model?.id).toBe("faux-kimi");

		const cycled = await harness.session.cycleModel("forward");
		expect(cycled?.model.id).toBe("faux-qwen");
		// The registry refresh behind a cycle resets the API providers: serve the same api again.
		const again = registerFauxProvider({ api: harness.models[0].api, models: MODELS });
		extraProviders.push(again);
		again.setResponses(Array.from({ length: 4 }, () => step));
		await harness.session.prompt("two");
		// A fresh episode whose primary is the owner's pick: kimi (first in the chain) serves.
		expect(calls.map((call) => call.model)).toEqual(["faux-1", "faux-kimi", "faux-qwen", "faux-kimi"]);

		vi.setSystemTime(Date.now() + PROVIDER_FALLBACK_RETURN_AFTER_MS + 1_000);
		await harness.session.prompt("three");
		expect(calls.at(-1)?.model).toBe("faux-qwen");
		expect(harness.session.model?.id).toBe("faux-qwen");
	});

	it("returns to the original primary when the backup model had already taken over (item 6)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const harness = await harnessWith({
			settings: settings({ providerBackupModel: "faux/faux-kimi", providerFallbackModels: ["faux/faux-qwen"] }),
		});
		const calls: Call[] = [];
		const step = perModel(
			{
				"faux-1": [quotaFailure, () => fauxAssistantMessage("primary is back")],
				"faux-kimi": [quotaFailure],
				"faux-qwen": [() => fauxAssistantMessage("qwen")],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 5 }, () => step));
		await harness.session.prompt("one");
		expect(calls.map((call) => call.model)).toEqual(["faux-1", "faux-kimi", "faux-qwen"]);
		expect(harness.session.model?.id).toBe("faux-qwen");

		vi.setSystemTime(Date.now() + PROVIDER_FALLBACK_RETURN_AFTER_MS + 1_000);
		await harness.session.prompt("two");
		expect(calls.at(-1)?.model).toBe("faux-1");
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("starts a subagent spawned during a fallback with the episode, so it returns too (item 7)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const harness = await harnessWith();
		const calls: Call[] = [];
		const step = perModel(
			{
				"faux-1": [
					quotaFailure,
					() => fauxAssistantMessage("child on the primary"),
					() => fauxAssistantMessage("child follow-up"),
				],
				"faux-kimi": [
					() => fauxAssistantMessage("kimi"),
					() => fauxAssistantMessage("child on kimi"),
					() => fauxAssistantMessage("child follow-up"),
				],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 4 }, () => step));
		await harness.session.prompt("one");
		expect(harness.session.model?.id).toBe("faux-kimi");

		vi.setSystemTime(Date.now() + PROVIDER_FALLBACK_RETURN_AFTER_MS + 1_000);
		const handle = await harness.session.runRlmChild("child task", { name: "worker" });
		expect(handle.model).toBe("faux/faux-kimi");
		for (let tries = 0; tries < 200 && calls.length < 3; tries++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		// The child's first request already probes the primary, as the parent's would.
		expect(calls.map((call) => call.model).slice(0, 3)).toEqual(["faux-1", "faux-kimi", "faux-1"]);
	});

	it("reports a chain entry that can never serve, once (item 8)", async () => {
		const harness = await harnessWith({
			settings: settings({ providerFallbackModels: ["faux/does-not-exist", "faux/faux-kimi"] }),
		});
		const calls: Call[] = [];
		const step = perModel(
			{
				"faux-1": [quotaFailure],
				"faux-kimi": [() => fauxAssistantMessage("kimi"), quotaFailure],
				"faux-qwen": [],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 4 }, () => step));
		await harness.session.prompt("one");
		await harness.session.prompt("two").catch(() => undefined);

		expect(calls.slice(0, 2).map((call) => call.model)).toEqual(["faux-1", "faux-kimi"]);
		const unusable = notices(harness).filter((notice) => notice.kind === "unusable_entry");
		expect(unusable).toHaveLength(1);
		expect(unusable[0]?.text).toContain("faux/does-not-exist");
		const pending = customEntries(harness, "duty_event").filter((event) => event.kind === "decision_needed");
		expect(pending).toHaveLength(1);
		expect(String(pending[0]?.question)).toContain("providerFallbackModels");
	});

	it("moves to the next model when the account is out of balance, whatever the status says (item 9)", async () => {
		const harness = await harnessWith();
		const calls: Call[] = [];
		const step = perModel(
			{
				// The shape an older build persisted: invalid_request by status, the balance named only in the text.
				"faux-1": [
					() =>
						failure(
							'400 {"code":"Arrearage","message":"Access denied, please make sure your account is in good standing."}',
							{ kind: "invalid_request", status: 400 },
						),
				],
				"faux-kimi": [
					() =>
						failure("403 AllocationQuota.FreeTierOnly: The free tier of the model has been exhausted.", {
							kind: "quota",
							status: 403,
						}),
				],
				"faux-qwen": [() => fauxAssistantMessage("qwen served")],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 3 }, () => step));
		await harness.session.prompt("do the work");
		expect(calls.map((call) => call.model)).toEqual(["faux-1", "faux-kimi", "faux-qwen"]);
		expect(harness.session.model?.id).toBe("faux-qwen");
	});

	it("moves a dead key's task to a model on another provider after its one retry (item 9)", async () => {
		const harness = await harnessWith({
			settings: settings({ providerFallbackModels: ["faux/faux-kimi", "otherco/other-1"] }),
		});
		const calls: Call[] = [];
		const authFailure = () => failure("Provider authentication failed (401)", { kind: "auth", status: 401 });
		const step = perModel(
			{ "faux-1": [authFailure, authFailure], "other-1": [() => fauxAssistantMessage("other provider")] },
			calls,
		);
		harness.setResponses([step, step]);
		addOtherProvider(harness, step, 1);

		await harness.session.prompt("do the work");

		// The same provider's kimi would fail on the same key; the other provider carries it.
		expect(calls.map((call) => call.model)).toEqual(["faux-1", "faux-1", "other-1"]);
		expect(harness.session.model?.id).toBe("other-1");
	});

	it("announces the return to the primary to the owner, outside the model's context (item 10)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const harness = await harnessWith();
		const calls: Call[] = [];
		const step = perModel(
			{
				"faux-1": [
					quotaFailure,
					() => fauxAssistantMessage("primary is back"),
					() => fauxAssistantMessage("again"),
				],
				"faux-kimi": [() => fauxAssistantMessage("kimi")],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 4 }, () => step));
		await harness.session.prompt("one");
		vi.setSystemTime(Date.now() + PROVIDER_FALLBACK_RETURN_AFTER_MS + 1_000);
		await harness.session.prompt("two");
		await harness.session.prompt("three");

		const returned = notices(harness).filter((notice) => notice.kind === "return");
		expect(returned).toHaveLength(1);
		expect(returned[0]?.text).toContain("已切回原模型 faux-1");
		const liveNotice = harness
			.eventsOfType("message_end")
			.find(
				(event) =>
					event.message.role === "custom" && event.message.customType === PROVIDER_FALLBACK_NOTICE_CUSTOM_TYPE,
			);
		expect(liveNotice).toBeDefined();
		expect(contextText(calls.at(-1)!.context)).not.toContain("已切回原模型");
	});

	it("withholds the tool output a content filter refused and retries, and keeps it withheld after a restart (item 11)", async () => {
		const harness = await harnessWith({ persistSession: true, tools: [readLogTool] });
		harness.sessionManager.materializeSessionFile();
		const calls: Call[] = [];
		const inspection = () =>
			failure(
				'400 data: {"error":{"code":"data_inspection_failed","param":null,"message":"Input text data may contain inappropriate content.","type":"data_inspection_failed"}}',
				{ kind: "invalid_request", status: 400 },
			);
		const step = perModel(
			{
				"faux-1": [
					() => fauxAssistantMessage([fauxToolCall("read_log", {})], { stopReason: "toolUse" }),
					inspection,
					() => fauxAssistantMessage("summarized without the raw log"),
				],
			},
			calls,
		);
		harness.setResponses(Array.from({ length: 3 }, () => step));

		await harness.session.prompt("check the server logs");

		expect(calls.map((call) => call.model)).toEqual(["faux-1", "faux-1", "faux-1"]);
		expect(contextText(calls[1]!.context)).toContain("DDoS attack firewall bypass log");
		expect(contextText(calls[2]!.context)).not.toContain("DDoS attack firewall bypass log");
		expect(contextText(calls[2]!.context)).toContain("[Tool output withheld:");
		const last = harness.session.messages.at(-1);
		expect(last?.role === "assistant" ? last.stopReason : undefined).toBe("stop");
		expect(notices(harness).map((notice) => notice.kind)).toEqual(["content_inspection"]);

		const restarted = await harnessWith({ existingSessionFile: harness.session.sessionFile!, tools: [readLogTool] });
		const text = JSON.stringify(restarted.session.messages);
		expect(text).not.toContain("DDoS attack firewall bypass log");
		expect(text).toContain("[Tool output withheld:");
	});

	it("moves a refused conversation to another provider, or tells the owner, instead of dying silently (item 11)", async () => {
		const inspection = () =>
			failure("400 data_inspection_failed: Input text data may contain inappropriate content.", {
				kind: "invalid_request",
				status: 400,
			});

		const alone = await harnessWith();
		const aloneCalls: Call[] = [];
		alone.setResponses([perModel({ "faux-1": [inspection] }, aloneCalls)]);
		await alone.session.prompt("a prompt the filter refuses");
		// Nothing to withhold and nowhere else to go: one request, and the owner is told why.
		expect(aloneCalls).toHaveLength(1);
		const told = notices(alone);
		expect(told.map((notice) => notice.kind)).toEqual(["content_inspection"]);
		expect(told[0]?.text).toContain("内容审核拒绝了这次请求");
		expect(alone.session.isRetrying).toBe(false);

		const withOther = await harnessWith({
			settings: settings({ providerFallbackModels: ["faux/faux-kimi", "otherco/other-1"] }),
		});
		const calls: Call[] = [];
		const step = perModel(
			{ "faux-1": [inspection], "other-1": [() => fauxAssistantMessage("served elsewhere")] },
			calls,
		);
		withOther.setResponses([step]);
		addOtherProvider(withOther, step, 1);
		await withOther.session.prompt("a prompt the filter refuses");
		expect(calls.map((call) => call.model)).toEqual(["faux-1", "other-1"]);
		expect(withOther.session.model?.id).toBe("other-1");
	});
});
