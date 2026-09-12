import type Anthropic from "@anthropic-ai/sdk";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [
									{
										delta: {
											tool_calls: [
												{ index: 0, id: "call_1", function: { name: "edit", arguments: '{"path":"REA' } },
											],
										},
									},
								],
							};
							yield {
								choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'DME.md"}' } }] } }],
							};
							throw new Error("connection reset mid tool call");
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

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		send(): Promise<unknown> {
			const stream = (async function* () {
				yield { messageStart: { role: "assistant" } };
				yield {
					contentBlockStart: {
						contentBlockIndex: 0,
						start: { toolUse: { toolUseId: "tool_1", name: "edit" } },
					},
				};
				yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"path":"REA' } } } };
				yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: 'DME.md"}' } } } };
				throw new Error("bedrock stream reset mid tool call");
			})();
			return Promise.resolve({ $metadata: {}, stream });
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { getModel } from "../src/models.js";
import { streamBedrock } from "../src/providers/amazon-bedrock.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Context, Model, ToolCall } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

// Mid-stream parses are throttled by time and growth. Freezing Date keeps the
// second argument delta inside the throttle window, so without the error-path
// final parse the persisted arguments would be stuck at the first delta's
// parse ({ path: "REA" }) instead of the full buffer.
function freezeThrottleWindow(): void {
	vi.useFakeTimers({ toFake: ["Date"] });
}

const context: Context = {
	messages: [{ role: "user", content: "Edit the readme.", timestamp: Date.now() }],
};

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

function expectFreshToolCallArguments(content: AssistantMessage["content"]): ToolCall {
	expect(content.length).toBeGreaterThan(0);
	const block = content[0];
	expect(block?.type).toBe("toolCall");
	if (block?.type !== "toolCall") {
		throw new Error("Expected a toolCall block");
	}
	expect(block.arguments).toEqual({ path: "README.md" });
	return block;
}

describe("final tool-argument parse on error paths", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the freshest arguments when an anthropic stream stalls mid tool call", async () => {
		freezeThrottleWindow();
		const model = getModel("anthropic", "claude-haiku-4-5");
		const sseEvent = (type: string, payload: Record<string, unknown>) => ({
			event: type,
			data: JSON.stringify({ type, ...payload }),
		});
		const response = createSseResponse([
			sseEvent("message_start", {
				message: {
					id: "msg_test",
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			}),
			sseEvent("content_block_start", {
				index: 0,
				content_block: { type: "tool_use", id: "tool_1", name: "edit", input: {} },
			}),
			sseEvent("content_block_delta", {
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"path":"REA' },
			}),
			sseEvent("content_block_delta", {
				index: 0,
				delta: { type: "input_json_delta", partial_json: 'DME.md"}' },
			}),
			// No content_block_stop/message_stop: the stream stalls and the provider
			// fails with "ended before message_stop".
		]);

		const result = await streamAnthropic(model, context, { client: createFakeAnthropicClient(response) }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("message_stop");
		const block = expectFreshToolCallArguments(result.content);
		expect("partialJson" in block).toBe(false);
	});

	it("keeps the freshest arguments when an openai-completions stream errors mid tool call", async () => {
		freezeThrottleWindow();
		const model: Model<"openai-completions"> = {
			id: "qwen-test",
			name: "Test Completions Model",
			api: "openai-completions",
			provider: "bailian",
			baseUrl: "https://example.invalid/compatible-mode/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 131072,
			maxTokens: 8192,
		};

		const result = await streamOpenAICompletions(model, context, { apiKey: "test-key" }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("connection reset");
		const block = expectFreshToolCallArguments(result.content);
		expect("partialArgs" in block).toBe(false);
		expect("streamIndex" in block).toBe(false);
	});

	it("keeps the freshest arguments when a bedrock stream errors mid tool call", async () => {
		freezeThrottleWindow();
		const model = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

		const result = await streamBedrock(model, context).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("stream reset");
		const block = expectFreshToolCallArguments(result.content);
		expect("partialJson" in block).toBe(false);
		expect("index" in block).toBe(false);
	});

	it("keeps the freshest arguments when a responses stream errors mid tool call", async () => {
		freezeThrottleWindow();
		const model: Model<"openai-responses"> = {
			id: "gpt-5-mini",
			name: "GPT-5 Mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const stream = new AssistantMessageEventStream();
		const events = (async function* (): AsyncGenerator<ResponseStreamEvent> {
			yield {
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_test", call_id: "call_test", name: "edit", arguments: "" },
			} as ResponseStreamEvent;
			yield { type: "response.function_call_arguments.delta", delta: '{"path":"REA' } as ResponseStreamEvent;
			yield { type: "response.function_call_arguments.delta", delta: 'DME.md"}' } as ResponseStreamEvent;
			throw new Error("responses stream failed mid tool call");
		})();

		await expect(processResponsesStream(events, output, stream, model)).rejects.toThrow("responses stream failed");

		// Callers strip partialJson in their catch blocks after processResponsesStream
		// rethrows; the arguments must already carry the final parse at that point.
		expectFreshToolCallArguments(output.content);
	});

	it("keeps the freshest arguments when a responses stream stalls without output_item.done", async () => {
		freezeThrottleWindow();
		const model: Model<"openai-responses"> = {
			id: "gpt-5-mini",
			name: "GPT-5 Mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const stream = new AssistantMessageEventStream();
		const events = (async function* (): AsyncGenerator<ResponseStreamEvent> {
			yield {
				type: "response.output_item.added",
				item: { type: "function_call", id: "fc_test", call_id: "call_test", name: "edit", arguments: "" },
			} as ResponseStreamEvent;
			yield { type: "response.function_call_arguments.delta", delta: '{"path":"REA' } as ResponseStreamEvent;
			yield { type: "response.function_call_arguments.delta", delta: 'DME.md"}' } as ResponseStreamEvent;
			// Stream ends without arguments.done/output_item.done.
		})();

		await processResponsesStream(events, output, stream, model);

		expectFreshToolCallArguments(output.content);
	});
});
