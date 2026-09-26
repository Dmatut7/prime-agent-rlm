import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildDashScopeRequest,
	convertMessages,
	isMultimodalModelClass,
	mapDashScopeFinishReason,
	parseDashScopeContent,
	resolveDashScopeEndpoint,
	streamDashScope,
	streamSimpleDashScope,
} from "../src/providers/dashscope.js";
import type { Context, Model, Tool } from "../src/types.js";

const BASE_URL = "https://llm-test.cn-beijing.maas.aliyuncs.com/api/v1";
const TEXT_ENDPOINT = `${BASE_URL}/services/aigc/text-generation/generation`;
const MULTIMODAL_ENDPOINT = `${BASE_URL}/services/aigc/multimodal-generation/generation`;

// Fixture JSON below is lifted from the official docs mirrored in
// .pipeline/dashscope-native/docs/ (07-qwen-api-via-dashscope and
// 05-vision-multimodal response/curl examples) so the parser is pinned to the
// documented wire format, not to an invented one.

function dsModel(id: string, overrides: Partial<Model<"dashscope">> = {}): Model<"dashscope"> {
	return {
		id,
		name: id,
		api: "dashscope",
		provider: "aliyun-dashscope",
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	} as Model<"dashscope">;
}

const envState = vi.hoisted(() => ({ saved: {} as Record<string, string | undefined> }));
const ENV_KEYS = [
	"PRIME_DASHSCOPE_MULTIMODAL_MODELS",
	"PRIME_DASHSCOPE_TEXT_MODELS",
	"PRIME_DASHSCOPE_PRESERVE_THINKING",
];

beforeEach(() => {
	envState.saved = {};
	for (const key of ENV_KEYS) {
		envState.saved[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = envState.saved[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("endpoint routing by model class", () => {
	it("routes text-class models to text-generation (07 请求地址表)", () => {
		for (const id of ["qwen-plus", "qwen3.7-max", "qwen3.6-max-preview", "deepseek-v4-pro", "glm-5.3-prime"]) {
			expect(resolveDashScopeEndpoint(BASE_URL, id)).toBe(TEXT_ENDPOINT);
		}
	});

	it("routes the probed multimodal class to multimodal-generation (实测矩阵 + 02 重要提示)", () => {
		for (const id of [
			"qwen3.8-max",
			"qwen3.8-flash",
			"qwen3.8-max-0902",
			"qwen3.8-omni-flash",
			"deepseek-v4.1-flash",
			"kimi-k3",
			"kimi-k2.7-code",
			"qwen3-vl-plus",
		]) {
			expect(resolveDashScopeEndpoint(BASE_URL, id)).toBe(MULTIMODAL_ENDPOINT);
		}
	});

	it("joins a trailing-slash baseUrl without doubling", () => {
		expect(resolveDashScopeEndpoint(`${BASE_URL}/`, "qwen-plus")).toBe(TEXT_ENDPOINT);
	});

	it("PRIME_DASHSCOPE_MULTIMODAL_MODELS replaces the default table wholesale", () => {
		process.env.PRIME_DASHSCOPE_MULTIMODAL_MODELS = "qwen-plus,glm-5.3";
		expect(isMultimodalModelClass("qwen-plus")).toBe(true);
		expect(isMultimodalModelClass("qwen3.8-max")).toBe(false);
	});

	it("PRIME_DASHSCOPE_TEXT_MODELS forces the text endpoint over the default table", () => {
		process.env.PRIME_DASHSCOPE_TEXT_MODELS = "qwen3.8-max";
		expect(isMultimodalModelClass("qwen3.8-max")).toBe(false);
	});
});

describe("request mapping", () => {
	it("wraps messages into input and pins message/incremental parameters (07 input 规则)", () => {
		const model = dsModel("qwen-plus");
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [{ role: "user", content: "你是谁？", timestamp: 1 }],
		};
		const body = buildDashScopeRequest(model, context);
		expect(body.model).toBe("qwen-plus");
		expect(body.input.messages).toEqual([
			{ role: "system", content: "You are a helpful assistant." },
			{ role: "user", content: "你是谁？" },
		]);
		expect(body.parameters.result_format).toBe("message");
		expect(body.parameters.incremental_output).toBe(true);
		// 07 "n": fixed to 1 with tools, only a couple of models accept it at all —
		// the provider never sends it (protocol default is 1).
		expect((body.parameters as Record<string, unknown>).n).toBeUndefined();
		expect(body.parameters.tools).toBeUndefined();
	});

	it("uses the bare-key content part array on the multimodal endpoint (05 curl)", () => {
		const model = dsModel("qwen3.8-max", { input: ["text", "image"] });
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [
						{ type: "image", mimeType: "image/jpeg", data: "aGk=" },
						{ type: "text", text: "图中描绘的是什么景象?" },
					],
					timestamp: 1,
				},
			],
		};
		const messages = convertMessages(model, context, { multimodal: true, preserveThinking: false });
		expect(messages).toEqual([
			{
				role: "user",
				content: [{ image: "data:image/jpeg;base64,aGk=" }, { text: "图中描绘的是什么景象?" }],
			},
		]);
	});

	it("keeps string user content on the text endpoint", () => {
		const model = dsModel("qwen-plus");
		const context: Context = {
			messages: [{ role: "user", content: "你是谁？", timestamp: 1 }],
		};
		const messages = convertMessages(model, context, { multimodal: false, preserveThinking: false });
		expect(messages).toEqual([{ role: "user", content: "你是谁？" }]);
	});

	it("maps assistant tool_calls with top-level ids and tool results with tool_call_id (07 消息类型)", () => {
		const model = dsModel("qwen-plus");
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1", name: "get_weather", arguments: { city: "北京" } }],
					api: "dashscope" as const,
					provider: "aliyun-dashscope",
					model: "qwen-plus",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 1,
				},
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "get_weather",
					content: [{ type: "text", text: "晴" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const messages = convertMessages(model, context, { multimodal: false, preserveThinking: false });
		expect(messages).toEqual([
			{
				role: "assistant",
				tool_calls: [
					{ id: "call-1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
				],
			},
			{ role: "tool", content: "晴", tool_call_id: "call-1" },
		]);
	});

	it("drops replayed thinking unless preserve_thinking is on (07 preserve_thinking 重要段)", () => {
		const model = dsModel("qwen3.8-max");
		const assistant = {
			role: "assistant" as const,
			content: [
				{ type: "thinking" as const, thinking: "let me think" },
				{ type: "text" as const, text: "answer" },
			],
			api: "dashscope" as const,
			provider: "aliyun-dashscope",
			model: "qwen3.8-max",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		};
		const context: Context = { messages: [assistant, { role: "user", content: "next", timestamp: 2 }] };
		const dropped = convertMessages(model, context, { multimodal: true, preserveThinking: false });
		expect(dropped).toEqual([
			{ role: "assistant", content: "answer" },
			{ role: "user", content: [{ text: "next" }] },
		]);
		const kept = convertMessages(model, context, { multimodal: true, preserveThinking: true });
		expect(kept[0]).toEqual({ role: "assistant", content: "answer", reasoning_content: "let me think" });
	});

	it("pins preserve_thinking=false for reasoning models unless opted in (qwen3.8 计费坑)", () => {
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const model = dsModel("qwen3.8-max");
		expect(buildDashScopeRequest(model, context).parameters.preserve_thinking).toBe(false);
		process.env.PRIME_DASHSCOPE_PRESERVE_THINKING = "true";
		expect(buildDashScopeRequest(model, context).parameters.preserve_thinking).toBe(true);
		delete process.env.PRIME_DASHSCOPE_PRESERVE_THINKING;
		// Non-reasoning models never see the parameter.
		const plain = dsModel("qwen3-vl-plus", { reasoning: false });
		expect(buildDashScopeRequest(plain, context).parameters.preserve_thinking).toBeUndefined();
	});

	it("maps tools to parameters.tools and never sends n (07 tools/n)", () => {
		const model = dsModel("qwen-plus");
		const tools: Tool[] = [
			{
				name: "get_weather",
				description: "Query weather",
				parameters: Type.Object({ city: Type.String() }),
			},
		];
		const body = buildDashScopeRequest(model, {
			messages: [{ role: "user", content: "天气", timestamp: 1 }],
			tools,
		});
		expect(body.parameters.tools).toEqual([
			{
				type: "function",
				function: {
					name: "get_weather",
					description: "Query weather",
					parameters: expect.objectContaining({ type: "object", properties: expect.anything() }),
				},
			},
		]);
		expect((body.parameters as Record<string, unknown>).n).toBeUndefined();
	});

	it("thinkingLevel rides reasoning_effort via thinkingLevelMap; cannot-disable models get no off signal", () => {
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const cannotDisable = dsModel("glm-5.3-prime", {
			thinkingLevelMap: { off: null, low: "low", high: "high" },
		});
		// level on → enable_thinking true + mapped effort
		let params = buildDashScopeRequest(cannotDisable, context, { reasoningLevel: "high" }).parameters;
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe("high");
		// explicit off on a cannot-disable model → parameter omitted (07: 传 false 会 400)
		params = buildDashScopeRequest(cannotDisable, context, { reasoningEnabled: false }).parameters;
		expect(params.enable_thinking).toBeUndefined();
		// unspecified → omitted, model default stands
		params = buildDashScopeRequest(cannotDisable, context).parameters;
		expect(params.enable_thinking).toBeUndefined();
		// can-disable model gets the explicit off signal
		const canDisable = dsModel("qwen3.7-plus", { thinkingLevelMap: { off: null } });
		expect(canDisable).toBeDefined();
		const hybrid = dsModel("qwen3.7-plus", { thinkingLevelMap: {} });
		params = buildDashScopeRequest(hybrid, context, { reasoningEnabled: false }).parameters;
		expect(params.enable_thinking).toBe(false);
	});
});

describe("response parsing", () => {
	it("parses string content and finish_reason stop (07 响应对象示例)", () => {
		expect(parseDashScopeContent("我是千问")).toBe("我是千问");
		expect(mapDashScopeFinishReason("stop")).toEqual({ stopReason: "stop" });
		expect(mapDashScopeFinishReason("length")).toEqual({ stopReason: "length" });
		expect(mapDashScopeFinishReason("tool_calls")).toEqual({ stopReason: "toolUse" });
		expect(mapDashScopeFinishReason(null)).toEqual({ stopReason: "stop" });
		// The gateway sends the *string* "null" on every unfinished frame (probe 08-native-sse-probe.txt).
		expect(mapDashScopeFinishReason("null")).toEqual({ stopReason: "stop" });
		expect(mapDashScopeFinishReason("")).toEqual({ stopReason: "stop" });
	});

	it("parses multimodal array content [{text}] (05 返回结果示例)", () => {
		expect(parseDashScopeContent([{ text: "海滩" }, { text: "照片" }])).toBe("海滩照片");
		expect(parseDashScopeContent([])).toBe("");
		expect(parseDashScopeContent(null)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Streaming (fetch mocked; fixtures from 07/05 official examples)
// ---------------------------------------------------------------------------

function sseResponse(frames: unknown[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const frame of frames) {
				controller.enqueue(encoder.encode(`data:${JSON.stringify(frame)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const fetchState = vi.hoisted(() => ({
	calls: [] as Array<{ url: string; init: RequestInit }>,
}));

function stubFetch(response: Response | (() => Response)) {
	fetchState.calls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			fetchState.calls.push({ url: String(url), init: init ?? {} });
			return typeof response === "function" ? response() : response;
		}),
	);
}

const usage = {
	input_tokens: 22,
	output_tokens: 17,
	total_tokens: 39,
	prompt_tokens_details: { cached_tokens: 0 },
};

describe("streamDashScope stray reasoning tag scrubbing", () => {
	it("drops a content frame that is only a leaked thinking close tag (PM 2026-09-26)", async () => {
		stubFetch(
			sseResponse([
				{
					output: {
						choices: [{ message: { role: "assistant", reasoning_content: "planning" } }],
					},
				},
				{ output: { choices: [{ message: { role: "assistant", content: "\n</think>\n\n" } }] } },
				{ output: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] } },
			]),
		);
		const message = await streamDashScope(
			dsModel("qwen3.8-max"),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: "sk-test" },
		).result();
		expect(message.stopReason).toBe("stop");
		expect(message.content.filter((b) => b.type === "text")).toEqual([]);
		expect(JSON.stringify(message.content)).not.toContain("</think>");
	});

	it("removes a lone tag line but keeps the prose around it", async () => {
		stubFetch(
			sseResponse([
				{ output: { choices: [{ message: { role: "assistant", content: "head\n</think>\ntail" } }] } },
				{ output: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "" } }] } },
			]),
		);
		const message = await streamDashScope(
			dsModel("qwen3.8-max"),
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ apiKey: "sk-test" },
		).result();
		expect(message.content).toEqual([{ type: "text", text: "head\ntail" }]);
	});
});

describe("streamDashScope wire behaviour", () => {
	it("sends the documented headers and body, and parses the text-endpoint stream (07 流式 curl)", async () => {
		// incremental_output=true frames: content is a delta per chunk.
		stubFetch(
			sseResponse([
				{
					request_id: "902fee3b-f7f0-9a8c-96a1-6b4ea25af114",
					output: { choices: [{ message: { role: "assistant", content: "我是" } }] },
				},
				{
					output: { choices: [{ message: { role: "assistant", content: "阿里云" } }] },
				},
				{
					output: {
						choices: [{ finish_reason: "stop", message: { role: "assistant", content: "开发的模型。" } }],
					},
					usage,
				},
			]),
		);
		const model = dsModel("qwen-plus");
		const message = await streamDashScope(
			model,
			{
				messages: [{ role: "user", content: "你是谁？", timestamp: 1 }],
			},
			{ apiKey: "sk-test" },
		).result();

		expect(fetchState.calls).toHaveLength(1);
		const { url, init } = fetchState.calls[0];
		expect(url).toBe(TEXT_ENDPOINT);
		const headers = init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer sk-test");
		expect(headers["X-DashScope-SSE"]).toBe("enable");
		const body = JSON.parse(String(init.body));
		expect(body.parameters.result_format).toBe("message");
		expect(body.parameters.incremental_output).toBe(true);
		expect(body.input.messages).toEqual([{ role: "user", content: "你是谁？" }]);

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "我是阿里云开发的模型。" }]);
		expect(message.usage.input).toBe(22);
		expect(message.usage.output).toBe(17);
		expect(message.responseId).toBe("902fee3b-f7f0-9a8c-96a1-6b4ea25af114");
	});

	it("routes qwen3.8-max to the multimodal endpoint and parses array content + reasoning (05 流式示例)", async () => {
		stubFetch(
			sseResponse([
				{
					request_id: "ccf845a3",
					output: { choices: [{ message: { role: "assistant", reasoning_content: "思考片段" } }] },
				},
				{
					output: { choices: [{ message: { role: "assistant", content: [{ text: "这是一张" }] } }] },
				},
				{
					output: {
						choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ text: "照片。" }] } }],
					},
					usage,
				},
			]),
		);
		const model = dsModel("qwen3.8-max", { input: ["text", "image"] });
		const message = await streamDashScope(
			model,
			{
				messages: [{ role: "user", content: "图中描绘的是什么景象?", timestamp: 1 }],
			},
			{ apiKey: "sk-test" },
		).result();

		expect(fetchState.calls[0].url).toBe(MULTIMODAL_ENDPOINT);
		const blocks = message.content;
		expect(blocks).toEqual([
			{ type: "thinking", thinking: "思考片段", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "这是一张照片。" },
		]);
		expect(message.stopReason).toBe("stop");
	});

	it("accumulates streamed tool_call fragments by index and maps finish_reason tool_calls (07 tool_calls/index)", async () => {
		stubFetch(
			sseResponse([
				{
					output: {
						choices: [
							{
								message: {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: "call-1",
											type: "function",
											function: { name: "get_weather", arguments: "" },
										},
									],
								},
							},
						],
					},
				},
				{
					output: {
						choices: [
							{
								message: {
									role: "assistant",
									tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
								},
							},
						],
					},
				},
				{
					output: {
						choices: [
							{
								finish_reason: "tool_calls",
								message: {
									role: "assistant",
									tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }],
								},
							},
						],
					},
					usage,
				},
			]),
		);
		const model = dsModel("qwen-plus");
		const message = await streamDashScope(
			model,
			{
				messages: [{ role: "user", content: "北京天气", timestamp: 1 }],
			},
			{ apiKey: "sk-test" },
		).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{ type: "toolCall", id: "call-1", name: "get_weather", arguments: { city: "北京" } },
		]);
	});

	it("assigns a generated id when streamed tool_calls never carry one (07 id 可选)", async () => {
		stubFetch(
			sseResponse([
				{
					output: {
						choices: [
							{
								finish_reason: "tool_calls",
								message: {
									role: "assistant",
									tool_calls: [{ index: 0, function: { name: "ping", arguments: "{}" } }],
								},
							},
						],
					},
					usage,
				},
			]),
		);
		const model = dsModel("qwen-plus");
		const message = await streamDashScope(
			model,
			{
				messages: [{ role: "user", content: "ping", timestamp: 1 }],
			},
			{ apiKey: "sk-test" },
		).result();
		const toolCall = message.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.id).toMatch(/^toolcall_\d+$/);
			expect(toolCall.name).toBe("ping");
		}
	});

	it("reports an HTTP error with code/message from the body and never emits done", async () => {
		const errorBody = JSON.stringify({
			code: "InvalidParameter",
			message: "spot the problem",
			request_id: "req-1",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(errorBody, { status: 400 })),
		);
		const model = dsModel("qwen-plus");
		const message = await streamDashScope(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			},
			{ apiKey: "sk-test" },
		).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("400");
		expect(message.errorMessage).toContain("InvalidParameter");
		expect(message.errorMessage).toContain("spot the problem");
	});

	it('treats the string finish_reason "null" on intermediate frames as unfinished, not as an error', async () => {
		// Regression: Bailian native SSE emits `"finish_reason":"null"` in every frame
		// before the last one. A truthiness check mapped that string into the error
		// branch, so 1118 of 1118 recorded native-path responses carried
		// `Provider finish_reason: null` even though their text arrived intact.
		// Evidence: .pipeline/night-20260925/08-native-sse-probe.txt (16 intermediate
		// frames with the string "null", final frame "stop").
		stubFetch(
			sseResponse([
				{
					output: {
						choices: [
							{
								finish_reason: "null",
								message: { role: "assistant", content: [], reasoning_content: "想一下" },
							},
						],
					},
					usage: { input_tokens: 35, output_tokens: 1, total_tokens: 36 },
				},
				{
					output: {
						choices: [{ finish_reason: "null", message: { role: "assistant", content: [{ text: "好" }] } }],
					},
					usage: { input_tokens: 35, output_tokens: 49, total_tokens: 84 },
				},
				{
					output: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: [] } }] },
					usage: { input_tokens: 35, output_tokens: 49, total_tokens: 84 },
				},
			]),
		);

		const message = await streamDashScope(
			dsModel("deepseek-v4.1-flash"),
			{ messages: [{ role: "user", content: '说"好"一个字', timestamp: 1 }] },
			{ apiKey: "sk-test" },
		).result();

		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
		expect(message.stopReasonRaw).toBeUndefined();
		expect(message.content.some((block) => block.type === "text" && block.text === "好")).toBe(true);
	});

	it("fails the stream when no finish_reason ever arrives (truncated upstream)", async () => {
		stubFetch(sseResponse([{ output: { choices: [{ message: { role: "assistant", content: "partial" } }] } }]));
		const model = dsModel("qwen-plus");
		const message = await streamDashScope(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			},
			{ apiKey: "sk-test" },
		).result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("finish_reason");
	});
});

describe("streamSimpleDashScope", () => {
	it("maps the reasoning level through thinkingLevelMap into reasoning_effort", async () => {
		stubFetch(
			sseResponse([
				{
					output: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] },
					usage,
				},
			]),
		);
		const model = dsModel("deepseek-v4.1-flash", {
			thinkingLevelMap: { off: null, low: "low", high: "high" },
		});
		const message = await streamSimpleDashScope(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: 1 }],
			},
			{ apiKey: "sk-test", reasoning: "high" },
		).result();

		expect(message.stopReason).toBe("stop");
		const body = JSON.parse(String(fetchState.calls[0].init.body));
		expect(body.parameters.reasoning_effort).toBe("high");
		expect(body.parameters.enable_thinking).toBe(true);
		expect(body.parameters.preserve_thinking).toBe(false);
		// deepseek-v4.1-flash is multimodal-class: routed endpoint check.
		expect(fetchState.calls[0].url).toBe(MULTIMODAL_ENDPOINT);
	});
});

describe("R1 审查处置钉桩（2026-09-25）", () => {
	const ctx = { systemPrompt: "s", messages: [{ role: "user", content: "ping", timestamp: 1 }] } as Context;
	it("omits reasoning_effort when the model has no thinkingLevelMap entry (glm 400 反例)", () => {
		const bare = dsModel("glm-5.3-prime", { thinkingLevelMap: undefined });
		const body = buildDashScopeRequest(bare, ctx, { reasoningLevel: "medium" });
		expect(body.parameters.reasoning_effort).toBeUndefined();
		const mappedModel = dsModel("deepseek-v4-pro", {
			thinkingLevelMap: { low: "low", medium: "high", high: "max", max: "max", off: null },
		} as any);
		const body2 = buildDashScopeRequest(mappedModel, ctx, { reasoningLevel: "medium" });
		expect(body2.parameters.reasoning_effort).toBe("high");
	});
	it("routes official-doc exceptions against prefix defaults (R1-M3)", () => {
		expect(isMultimodalModelClass("qwen3.8-2.4t-a95b")).toBe(false);
		expect(isMultimodalModelClass("qwen3.6-max-preview")).toBe(false);
		expect(isMultimodalModelClass("qwen3.7-max")).toBe(false);
		expect(isMultimodalModelClass("qwen3.7-max-2026-06-08")).toBe(false);
		expect(isMultimodalModelClass("qwen3.6-plus")).toBe(true);
		expect(isMultimodalModelClass("qwen3.8-max")).toBe(true);
	});
});
