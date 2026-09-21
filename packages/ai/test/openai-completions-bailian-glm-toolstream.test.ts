import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Model, Tool } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

/**
 * The compat the production ~/.prime/agent/models.json carries for the two
 * Bailian GLM 5.3 family entries. The `toolStream: false` key is the GLM
 * tool-call corruption fix (cc4a17379): Bailian defaults `tool_stream` to
 * true server-side, and streamed tool-call argument shards are what corrupt
 * long-context GLM calls. This fixture mirrors that entry verbatim.
 */
const BAILIAN_GLM_COMPAT = {
	thinkingFormat: "zai",
	supportsReasoningEffort: true,
	toolStream: false,
	reasoningCountsTowardMaxTokens: true,
} as const;

const BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

function bailianGlmModel(
	id: string,
	compat: Record<string, unknown> = { ...BAILIAN_GLM_COMPAT },
): Model<"openai-completions"> {
	return {
		id,
		provider: "bailian",
		name: id,
		api: "openai-completions",
		baseUrl: BAILIAN_BASE_URL,
		contextWindow: 1_000_000,
		maxTokens: 8192,
		input: ["text"],
		tools: true,
		thinking: true,
		// Zeroed rates keep the stream's cost accounting from reading undefined.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat,
	} as Model<"openai-completions">;
}

const TOOLS: Tool[] = [
	{
		name: "ping",
		description: "Ping tool",
		parameters: Type.Object({ ok: Type.Boolean() }),
	},
];

async function lastPayloadFor(model: Model<"openai-completions">): Promise<Record<string, unknown>> {
	mockState.lastParams = undefined;
	// Asserting the settled message keeps the payload probe honest: a failed
	// stream would reject here instead of vacuously passing on captured params.
	const message = await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "Call ping with ok=true", timestamp: Date.now() }],
			tools: TOOLS,
		},
		{ apiKey: "test" },
	).result();
	expect(message.usage?.output).toBe(1);
	return (mockState.lastParams ?? {}) as Record<string, unknown>;
}

describe("openai-completions bailian GLM tool_stream compat probe", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	for (const modelId of ["bailian/glm-5.3", "bailian/glm-5.3-prime"]) {
		it(`sends tool_stream=false for ${modelId} with tools when its compat pins it`, async () => {
			const payload = await lastPayloadFor(bailianGlmModel(modelId));
			expect(payload.tools).toBeDefined();
			expect(payload.tool_stream).toBe(false);
		});
	}

	it("omits tool_stream when the compat entry lacks the key (the pre-fix Bailian default)", async () => {
		const { toolStream: _omitted, ...withoutToolStream } = { ...BAILIAN_GLM_COMPAT };
		const payload = await lastPayloadFor(bailianGlmModel("bailian/glm-5.3", withoutToolStream));
		// Absent on the wire: Bailian's server-side default (true) then applies —
		// the streaming-shard corruption path the models.json key exists to close.
		expect(payload.tool_stream).toBeUndefined();
	});

	it("keeps tool_stream off without tools in the context", async () => {
		mockState.lastParams = undefined;
		await streamSimple(
			bailianGlmModel("bailian/glm-5.3"),
			{
				messages: [{ role: "user", content: "plain prompt", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();
		const payload = (mockState.lastParams ?? {}) as Record<string, unknown>;
		expect(payload.tools).toBeUndefined();
		expect(payload.tool_stream).toBeUndefined();
	});
});

describe("production models.json glm entries pin toolStream: false", () => {
	const modelsJsonPath = join(homedir(), ".prime", "agent", "models.json");

	it.skipIf(!existsSync(modelsJsonPath))(
		"both glm-5.3 family entries in ~/.prime/agent/models.json carry compat.toolStream=false",
		() => {
			const parsed = JSON.parse(readFileSync(modelsJsonPath, "utf8")) as {
				providers?: Record<string, { models?: Array<{ id?: string; compat?: { toolStream?: boolean } }> }>;
			};
			const bailian = parsed.providers?.bailian;
			expect(bailian?.models?.length ?? 0).toBeGreaterThan(0);
			for (const id of ["glm-5.3", "glm-5.3-prime"]) {
				const entry = bailian?.models?.find((model) => model.id === id);
				expect(entry, `${id} present in models.json`).toBeDefined();
				expect(entry?.compat?.toolStream, `${id} compat.toolStream`).toBe(false);
			}
		},
	);
});
