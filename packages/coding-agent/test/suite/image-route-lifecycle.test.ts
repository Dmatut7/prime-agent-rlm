import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type ImageContent,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	IMAGE_LOOK_MAX_ATTEMPTS,
	IMAGE_ROUTE_BRIEF,
	IMAGE_ROUTE_MAX_REQUESTS,
} from "../../src/core/image-model-routing.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * The owner's session model is text-only and settings.imageModel reads images for it.
 * An image must reach the image model however the turn around it goes: interrupted,
 * failed, resumed, asked about again, loaded mid-run while the event queue lags, or
 * during a fallback episode - and the image model must hand the task back once it has
 * put the image into words, without compacting the owner's session on its own window.
 */

const IMAGE: ImageContent = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
const TEXT_ONLY: ("text" | "image")[] = ["text"];
const VISION: ("text" | "image")[] = ["text", "image"];
const MODELS = [
	{ id: "faux-1", input: TEXT_ONLY, contextWindow: 200_000 },
	{ id: "faux-vision", input: VISION, contextWindow: 200_000 },
	{ id: "faux-glm", input: TEXT_ONLY, contextWindow: 200_000 },
];
const SMALL_WINDOW_MODELS = [MODELS[0], { id: "faux-vision", input: VISION, contextWindow: 4_000 }];
const IMAGE_SETTINGS: Partial<Settings> = { imageModel: "faux/faux-vision", retry: { enabled: false } };

function tool(name: string, withImage = false): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({
			content: withImage ? [{ type: "text", text: "screenshot" }, IMAGE] : [{ type: "text", text: `${name} ok` }],
			details: {},
		}),
	};
}

interface Served {
	model: string;
	messages: Context["messages"];
}

/**
 * Each call answers from the next scripted message, stamped with the model that served
 * it like a real provider does, and records the model and the request context.
 */
function scripted(script: AssistantMessage[], served: Served[]): FauxResponseFactory {
	return (context, _options, _state, model) => {
		served.push({ model: model.id, messages: JSON.parse(JSON.stringify(context.messages)) });
		const next = script.shift();
		if (!next) throw new Error("no scripted answer left");
		return { ...next, api: model.api, provider: model.provider, model: model.id };
	};
}

function servedModels(served: Served[]): string[] {
	return served.map((entry) => entry.model);
}

function requestText(entry: Served | undefined): string {
	return JSON.stringify(entry?.messages ?? []);
}

const failed = (): AssistantMessage =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 invalid_request_error" });
const aborted = (): AssistantMessage => fauxAssistantMessage("", { stopReason: "aborted" });
const quotaFailure = (): AssistantMessage => ({
	...fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
	diagnostics: [
		{ type: "provider_stream_failure", timestamp: Date.now(), details: { kind: "rate_limit", status: 429 } },
	],
});

describe("image routing across interruptions, follow-ups, lag and fallback", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const created = await createHarness({
			models: MODELS,
			settings: IMAGE_SETTINGS,
			tools: [tool("run_step"), tool("take_screenshot", true)],
			...options,
		});
		harnesses.push(created);
		return created;
	}

	it.each([
		["a provider error", failed],
		["Esc", aborted],
	])("sends the picture back to the image model on 继续 after %s cut the image turn", async (_name, cut) => {
		const h = await harness();
		const served: Served[] = [];
		const step = scripted(
			[cut(), fauxAssistantMessage("图里是登录页，右下角写着 42。"), fauxAssistantMessage("好的")],
			served,
		);
		h.setResponses([step, step, step]);

		await h.session.prompt("看一下这张图", { images: [IMAGE] });
		await h.session.prompt("继续");
		// Answered now: an unrelated next turn is the session model's again.
		await h.session.prompt("好，下一步写代码");

		expect(servedModels(served)).toEqual(["faux-vision", "faux-vision", "faux-1"]);
		expect(h.session.agent.modelOverride).toBeUndefined();
	});

	it("sends an unanswered picture to the image model after the session was resumed", async () => {
		const first = await harness({ persistSession: true });
		const firstServed: Served[] = [];
		first.setResponses([scripted([failed()], firstServed)]);
		await first.session.prompt("看一下这张图", { images: [IMAGE] });
		const sessionFile = first.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();

		const resumed = await harness({ existingSessionFile: sessionFile });
		const served: Served[] = [];
		resumed.setResponses([scripted([fauxAssistantMessage("图里是一张账单。")], served)]);
		await resumed.session.prompt("继续");

		expect(servedModels(served)).toEqual(["faux-vision"]);
	});

	it("lets the image model answer a question about the picture it already described", async () => {
		const h = await harness();
		const served: Served[] = [];
		const step = scripted(
			[
				fauxAssistantMessage("一张账单截图，列了三行费用。"),
				fauxAssistantMessage("右下角的数字是 42。"),
				fauxAssistantMessage("脚本写好了。"),
			],
			served,
		);
		h.setResponses([step, step, step]);

		await h.session.prompt("看图", { images: [IMAGE] });
		await h.session.prompt("图里右下角那个数字是多少？");
		await h.session.prompt("帮我写个脚本把费用加起来");

		expect(servedModels(served)).toEqual(["faux-vision", "faux-vision", "faux-1"]);
	});

	it("stays on the session model for an unanswered picture when no image model is usable", async () => {
		const h = await harness({ settings: { retry: { enabled: false } } });
		const served: Served[] = [];
		h.setResponses([scripted([fauxAssistantMessage("我看不到图片内容。")], served)]);
		const earlier: AgentMessage = { role: "user", content: [fauxText("看图"), IMAGE], timestamp: Date.now() - 1000 };
		h.session.agent.state.messages = [earlier];

		await h.session.prompt("继续");

		expect(servedModels(served)).toEqual(["faux-1"]);
	});

	it("gives up re-sending a picture to an image model that keeps failing", async () => {
		const h = await harness();
		const served: Served[] = [];
		const script = [failed(), ...Array.from({ length: IMAGE_LOOK_MAX_ATTEMPTS }, failed), fauxAssistantMessage("ok")];
		const step = scripted(script, served);
		h.setResponses(script.map(() => step));

		await h.session.prompt("看图", { images: [IMAGE] });
		for (let attempt = 0; attempt <= IMAGE_LOOK_MAX_ATTEMPTS; attempt++) await h.session.prompt("继续");

		expect(servedModels(served)).toEqual([
			"faux-vision",
			...Array.from({ length: IMAGE_LOOK_MAX_ATTEMPTS }, () => "faux-vision"),
			"faux-1",
		]);
	});

	it("routes the request after an attached screenshot even while the event queue lags", async () => {
		const h = await harness({
			extensionFactories: [
				(pi) => {
					// A slow message_end handler holds the session's event queue behind the loop.
					pi.on("message_end", async () => {
						await new Promise((resolve) => setTimeout(resolve, 40));
					});
				},
			],
		});
		const served: Served[] = [];
		const step = scripted(
			[
				fauxAssistantMessage(fauxToolCall("take_screenshot", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("截图里是登录页，按钮错位了。"),
			],
			served,
		);
		h.setResponses([step, step]);

		await h.session.prompt("看看 ~/Desktop/shot.png");

		expect(servedModels(served)).toEqual(["faux-1", "faux-vision"]);
	});

	it("routes a picture the owner steers into a running task", async () => {
		const h = await harness();
		const served: Served[] = [];
		const script = [
			fauxAssistantMessage(fauxToolCall("run_step", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("截图里按钮错位了，我接着改。"),
		];
		let steered: Promise<void> | undefined;
		const step: FauxResponseStep = (context, options, state, model) => {
			// The owner pastes a screenshot while the first request is out.
			if (served.length === 0) {
				steered = h.session.prompt("看这张截图", { images: [IMAGE], streamingBehavior: "steer" });
			}
			return scripted(script, served)(context, options, state, model);
		};
		h.setResponses([step, step]);

		await h.session.prompt("修一下登录页");
		await steered;

		expect(servedModels(served)).toEqual(["faux-1", "faux-vision"]);
	});

	it("keeps the image model past a preamble and hands back after its description", async () => {
		const h = await harness();
		const served: Served[] = [];
		const step = scripted(
			[
				fauxAssistantMessage([fauxText("我来看看这张图。"), fauxToolCall("run_step", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage([fauxText("图里是登录页，按钮错位了。"), fauxToolCall("run_step", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("修好了。"),
			],
			served,
		);
		h.setResponses([step, step, step]);

		await h.session.prompt("看图并修掉问题", { images: [IMAGE] });

		expect(servedModels(served)).toEqual(["faux-vision", "faux-vision", "faux-1"]);
	});

	it("hands back after a few requests from an image model that only calls tools", async () => {
		const h = await harness();
		const served: Served[] = [];
		const toolOnly = () => fauxAssistantMessage(fauxToolCall("run_step", {}), { stopReason: "toolUse" });
		const script = [...Array.from({ length: IMAGE_ROUTE_MAX_REQUESTS }, toolOnly), fauxAssistantMessage("完成。")];
		const step = scripted(script, served);
		h.setResponses(script.map(() => step));

		await h.session.prompt("看图并处理", { images: [IMAGE] });

		expect(servedModels(served)).toEqual([
			...Array.from({ length: IMAGE_ROUTE_MAX_REQUESTS }, () => "faux-vision"),
			"faux-1",
		]);
	});

	it("tells the image model why it got the request, in that request only", async () => {
		const h = await harness();
		const served: Served[] = [];
		const step = scripted(
			[
				fauxAssistantMessage([fauxText("图里是登录页，按钮错位了。"), fauxToolCall("run_step", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("修好了。"),
			],
			served,
		);
		h.setResponses([step, step]);

		await h.session.prompt("看图并修掉问题", { images: [IMAGE] });

		expect(servedModels(served)).toEqual(["faux-vision", "faux-1"]);
		expect(requestText(served[0])).toContain("[Image hand-off]");
		expect(requestText(served[1])).not.toContain("[Image hand-off]");
		expect(JSON.stringify(h.session.messages)).not.toContain(IMAGE_ROUTE_BRIEF);
	});

	it("fits a routed request to a small image-model window instead of compacting the session", async () => {
		const h = await harness({
			models: SMALL_WINDOW_MODELS,
			settings: { ...IMAGE_SETTINGS, compaction: { enabled: true } },
		});
		const bulky = "很长的历史记录。".repeat(1500);
		const history: AgentMessage[] = [];
		for (let turn = 0; turn < 3; turn++) {
			history.push({ role: "user", content: [fauxText(`第 ${turn} 轮 ${bulky}`)], timestamp: Date.now() - 10_000 });
			history.push({
				...fauxAssistantMessage(`第 ${turn} 轮完成`),
				provider: "faux",
				model: "faux-1",
				timestamp: Date.now() - 9_000,
			});
		}
		h.session.agent.state.messages = history;
		const served: Served[] = [];
		h.setResponses([scripted([fauxAssistantMessage("图里是登录页。")], served)]);

		await h.session.prompt("看图", { images: [IMAGE] });

		expect(servedModels(served)).toEqual(["faux-vision"]);
		expect(h.eventsOfType("compaction_start")).toEqual([]);
		const request = requestText(served[0]);
		expect(request).not.toContain("第 0 轮");
		expect(request).toContain("Older conversation was left out");
		expect(
			served[0]?.messages.some(
				(message) => message.role === "user" && JSON.stringify(message).includes("image/png"),
			),
		).toBe(true);
		// The owner's session keeps its whole history.
		expect(JSON.stringify(h.session.messages)).toContain("第 0 轮");
	});

	it("does not compact the owner's session when the image model overflows on a session that fits", async () => {
		const h = await harness({
			models: SMALL_WINDOW_MODELS,
			settings: { ...IMAGE_SETTINGS, compaction: { enabled: true } },
		});
		const served: Served[] = [];
		const overflow = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "prompt is too long: 5000 tokens > 4000 maximum",
		});
		h.setResponses([scripted([overflow], served)]);

		await h.session.prompt("看图", { images: [IMAGE] });

		expect(servedModels(served)).toEqual(["faux-vision"]);
		expect(h.eventsOfType("compaction_start")).toEqual([]);
	});

	describe("during a fallback episode on a text-only fallback model", () => {
		const fallbackSettings: Partial<Settings> = {
			imageModel: "faux/faux-vision",
			providerFallbackModels: ["faux/faux-glm"],
			retry: {
				enabled: true,
				maxRetries: 2,
				baseDelayMs: 1,
				provider: {
					waitForUsage: { enabled: true, baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 1, maxWaitMs: 5 },
					fallbackLongWait: { baseDelayMs: 5, maxDelayMs: 10, maxRounds: 3 },
				},
			},
		};

		it("routes a screenshot the fallback model attaches and hands back to it", async () => {
			const h = await harness({ settings: fallbackSettings });
			const served: Served[] = [];
			const step = scripted(
				[
					quotaFailure(),
					fauxAssistantMessage(fauxToolCall("take_screenshot", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage([fauxText("截图里是登录页，按钮错位了。"), fauxToolCall("run_step", {})], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("修好了。"),
				],
				served,
			);
			h.setResponses([step, step, step, step]);

			await h.session.prompt("看看 ~/Desktop/shot.png 并修掉问题");

			expect(servedModels(served)).toEqual(["faux-1", "faux-glm", "faux-vision", "faux-glm"]);
			expect(h.session.model?.id).toBe("faux-glm");
		});

		it("hands a pasted-image run back to the fallback model", async () => {
			const h = await harness({ settings: fallbackSettings });
			const served: Served[] = [];
			const step = scripted(
				[
					quotaFailure(),
					fauxAssistantMessage("好的。"),
					fauxAssistantMessage([fauxText("图里是登录页，按钮错位了。"), fauxToolCall("run_step", {})], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("修好了。"),
				],
				served,
			);
			h.setResponses([step, step, step, step]);

			await h.session.prompt("你好");
			await h.session.prompt("看图并修掉问题", { images: [IMAGE] });

			expect(servedModels(served)).toEqual(["faux-1", "faux-glm", "faux-vision", "faux-glm"]);
			expect(h.session.agent.modelOverride).toBeUndefined();
		});
	});
});
