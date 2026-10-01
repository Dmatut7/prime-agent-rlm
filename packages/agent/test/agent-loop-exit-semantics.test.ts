import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { agentLoop, isStreamEofFailure, runAgentLoop, STREAM_EOF_STOP_REASON_RAW } from "../src/agent-loop.js";
import { streamProxy } from "../src/proxy.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	UndeliveredMessageSource,
} from "../src/types.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createContext(): AgentContext {
	return { systemPrompt: "You are helpful.", messages: [], tools: [] };
}

function baseConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return { model: createModel(), convertToLlm: identityConverter, ...overrides };
}

/** A streamFn answering every request with a plain terminal text message. */
function terminalStreamFn(text = "done") {
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text }]) });
		});
		return stream;
	};
}

function collectEvents(): { events: AgentEvent[]; sink: (event: AgentEvent) => void } {
	const events: AgentEvent[] = [];
	return {
		events,
		sink: (event) => {
			events.push(event);
		},
	};
}

describe("raw agentLoop failure channel (W9-B finding 3)", () => {
	it("surfaces a non-abort loop failure as a terminal error message instead of a silent empty end", async () => {
		const config = baseConfig({
			convertToLlm: () => {
				throw new Error("convertToLlm boom");
			},
		});
		const stream = agentLoop([createUserMessage("Hello")], createContext(), config);

		const events: AgentEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		const agentEnd = events.find((event) => event.type === "agent_end");
		expect(agentEnd).toBeDefined();
		expect(messages).toHaveLength(1);
		const failure = messages[0];
		expect(failure.role).toBe("assistant");
		if (failure.role !== "assistant") throw new Error("expected an assistant failure message");
		expect(failure.stopReason).toBe("error");
		expect(failure.errorMessage).toContain("convertToLlm boom");
		expect(failure.diagnostics?.some((d) => d.type === "agent_lifecycle_failure")).toBe(true);
	});

	it("keeps the pinned abort shape: empty result, no agent_end", async () => {
		const controller = new AbortController();
		const stream = agentLoop([createUserMessage("Hello")], createContext(), baseConfig(), controller.signal);
		const consume = (async () => {
			const events: string[] = [];
			for await (const event of stream) {
				events.push(event.type);
			}
			return events;
		})();
		controller.abort();
		const events = await consume;

		await expect(stream.result()).resolves.toEqual([]);
		expect(events).not.toContain("agent_end");
	});
});

describe("bare EOF stream termination (W9-B finding 4)", () => {
	it("settles a stream that ends without a terminal event as a stream error instead of hanging", async () => {
		const streamFn = () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "start",
					partial: createAssistantMessage([{ type: "text", text: "partial answer" }]),
				});
				// The defect this guards: a clean EOF with no done/error event left
				// result() pending forever and the turn hung with no watchdog left.
				stream.end();
			});
			return stream;
		};

		const run = runAgentLoop(
			[createUserMessage("Hello")],
			createContext(),
			baseConfig(),
			async () => {},
			undefined,
			streamFn,
		);
		const messages = await Promise.race([
			run,
			delay(2_000).then(() => {
				throw new Error("loop hung on a terminal-less EOF");
			}),
		]);

		const assistant = messages.find((message) => message.role === "assistant");
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") throw new Error("expected an assistant message");
		expect(assistant.stopReason).toBe("error");
		expect(assistant.stopReasonRaw).toBe(STREAM_EOF_STOP_REASON_RAW);
		expect(isStreamEofFailure(assistant)).toBe(true);
		// The partial content the stream did deliver is preserved on the error message.
		expect(assistant.content).toEqual([{ type: "text", text: "partial answer" }]);
	});

	it("streamProxy closes a terminal-less EOF with an explicit error event", async () => {
		const events = [
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "partial" },
			{ type: "text_end", contentIndex: 0 },
		];
		const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n`).join("")}\n`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })),
		);
		try {
			const stream = streamProxy(
				createModel(),
				{ messages: [{ role: "user", content: "hello proxy", timestamp: Date.now() }] },
				{ authToken: "token", proxyUrl: "https://proxy.invalid" },
			);
			const message = await Promise.race([
				stream.result(),
				delay(2_000).then(() => {
					throw new Error("proxy result() hung on a terminal-less EOF");
				}),
			]);
			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("without a terminal");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("undelivered poll products hand-back (W9-B finding 2)", () => {
	it("hands back steering products when the abort wins the poll race", async () => {
		const controller = new AbortController();
		const steered: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "steered in" }],
			timestamp: Date.now(),
		};
		const handedBack: { messages: AgentMessage[]; source: UndeliveredMessageSource }[] = [];
		let polls = 0;
		const config = baseConfig({
			getSteeringMessages: async () => {
				polls += 1;
				if (polls === 1) return [];
				// Abort while this poll is in flight: the products below are produced
				// after the loop already gave up waiting.
				controller.abort();
				await delay(20);
				return [steered];
			},
			onUndeliveredMessages: (messages, source) => {
				handedBack.push({ messages, source });
			},
		});
		const { events, sink } = collectEvents();

		const messages = await runAgentLoop(
			[createUserMessage("Hello")],
			createContext(),
			config,
			sink,
			controller.signal,
			terminalStreamFn(),
		);
		await delay(60);

		expect(polls).toBe(2);
		expect(handedBack).toEqual([{ messages: [steered], source: "steering" }]);
		expect(messages).not.toContain(steered);
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
	});

	it("hands back the undelivered remainder when delivering polled messages fails", async () => {
		const first: AgentMessage = { role: "user", content: [{ type: "text", text: "first" }], timestamp: Date.now() };
		const second: AgentMessage = { role: "user", content: [{ type: "text", text: "second" }], timestamp: Date.now() };
		const handedBack: { messages: AgentMessage[]; source: UndeliveredMessageSource }[] = [];
		let polls = 0;
		const config = baseConfig({
			getSteeringMessages: async () => {
				polls += 1;
				return polls === 1 ? [] : [first, second];
			},
			onUndeliveredMessages: (messages, source) => {
				handedBack.push({ messages, source });
			},
		});

		await expect(
			runAgentLoop(
				[createUserMessage("Hello")],
				createContext(),
				config,
				(event) => {
					if (event.type === "message_start" && event.message === first) {
						throw new Error("sink boom");
					}
				},
				undefined,
				terminalStreamFn(),
			),
		).rejects.toThrow("sink boom");

		// Neither message reached the context, so both go back - not just the one the
		// sink failed on.
		expect(handedBack).toEqual([{ messages: [first, second], source: "steering" }]);
	});

	it("Agent re-queues continuation products the abort kept from being delivered", async () => {
		const continuation: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "continue the goal" }],
			timestamp: Date.now(),
		};
		let pollStarted!: () => void;
		const pollStartedPromise = new Promise<void>((resolve) => {
			pollStarted = resolve;
		});
		const agent = new Agent({
			streamFn: terminalStreamFn(),
			getContinuationMessages: async () => {
				pollStarted();
				await delay(50);
				return [continuation];
			},
		});

		const promptPromise = agent.prompt("hello");
		await pollStartedPromise;
		agent.abort();
		await promptPromise;
		await delay(120);

		expect(agent.state.messages).not.toContain(continuation);
		expect(agent.hasQueuedMessages()).toBe(true);
		expect(agent.removeQueuedMessages((message) => message === continuation)).toEqual([continuation]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("Agent routes undelivered products to a host-provided onUndeliveredMessages instead", async () => {
		const continuation: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "continue the goal" }],
			timestamp: Date.now(),
		};
		const handedBack: { messages: AgentMessage[]; source: UndeliveredMessageSource }[] = [];
		let pollStarted!: () => void;
		const pollStartedPromise = new Promise<void>((resolve) => {
			pollStarted = resolve;
		});
		const agent = new Agent({
			streamFn: terminalStreamFn(),
			getContinuationMessages: async () => {
				pollStarted();
				await delay(50);
				return [continuation];
			},
			onUndeliveredMessages: (messages, source) => {
				handedBack.push({ messages, source });
			},
		});

		const promptPromise = agent.prompt("hello");
		await pollStartedPromise;
		agent.abort();
		await promptPromise;
		await delay(120);

		expect(handedBack).toEqual([{ messages: [continuation], source: "continuation" }]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});
});

describe("parallel tool batch emit failure (W9-B finding 5)", () => {
	const toolSchema = Type.Object({});

	function batchTool(
		name: string,
		text: string,
		ran: string[],
		settleMs = 0,
	): AgentTool<typeof toolSchema, Record<string, unknown>> {
		return {
			name,
			label: name,
			description: name,
			parameters: toolSchema,
			execute: async (): Promise<AgentToolResult<Record<string, unknown>>> => {
				if (settleMs > 0) await delay(settleMs);
				ran.push(name);
				return { content: [{ type: "text", text }], details: {} };
			},
		};
	}

	it("a failing tool_execution_end sink no longer orphans the in-flight siblings", async () => {
		const ran: string[] = [];
		const fast = batchTool("fast", "fast output", ran);
		const slow = batchTool("slow", "slow output", ran, 30);
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [fast, slow] };
		const toolUseMessage = createAssistantMessage(
			[
				{ type: "toolCall", id: "call-fast", name: "fast", arguments: {} },
				{ type: "toolCall", id: "call-slow", name: "slow", arguments: {} },
			],
			"toolUse",
		);
		let calls = 0;
		const streamFn = () => {
			const stream = new MockAssistantStream();
			const first = calls === 0;
			calls += 1;
			queueMicrotask(() => {
				stream.push(
					first
						? { type: "done", reason: "toolUse", message: toolUseMessage }
						: {
								type: "done",
								reason: "stop",
								message: createAssistantMessage([{ type: "text", text: "wrapped up" }]),
							},
				);
			});
			return stream;
		};
		const events: AgentEvent[] = [];
		const messages = await runAgentLoop(
			[createUserMessage("Hello")],
			context,
			baseConfig({ toolExecution: "parallel" }),
			(event) => {
				events.push(event);
				if (event.type === "tool_execution_end" && event.toolCallId === "call-fast") {
					throw new Error("sink boom");
				}
			},
			undefined,
			streamFn,
		);

		// Both side effects landed, and every started call produced exactly one result:
		// the invariant the old Promise.all rejection broke for the in-flight siblings.
		expect(ran.sort()).toEqual(["fast", "slow"]);
		const toolResults = messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		const textOf = (toolCallId: string) => {
			const result = toolResults.find(
				(message) => message.role === "toolResult" && message.toolCallId === toolCallId,
			);
			expect(result).toBeDefined();
			if (result?.role !== "toolResult") throw new Error("expected a tool result");
			return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		};
		expect(textOf("call-fast")).toContain("fast output");
		expect(textOf("call-slow")).toContain("slow output");
		expect(events.some((event) => event.type === "tool_execution_end" && event.toolCallId === "call-slow")).toBe(
			true,
		);
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
		expect(calls).toBe(2);
	});
});

describe("run config isolation (W9-B finding 7)", () => {
	it("a mid-run model switch does not leak into the caller's config object", async () => {
		const first = getModel("openai", "gpt-4o-mini");
		const second = getModel("openai", "gpt-4o");
		const served: string[] = [];
		let takes = 0;
		const config = baseConfig({
			model: first as Model<any>,
			takeNextTurnModel: () => {
				takes += 1;
				return takes === 1 ? { model: second as Model<any> } : undefined;
			},
		});
		const streamFn = (model: Model<any>) => {
			served.push(model.id);
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: createAssistantMessage([{ type: "text", text: "ok" }]),
				});
			});
			return stream;
		};

		await runAgentLoop([createUserMessage("Hello")], createContext(), config, async () => {}, undefined, streamFn);

		expect(served).toEqual([second.id]);
		expect(config.model).toBe(first);
		expect(config.reasoning).toBeUndefined();
		expect(config.serviceTier).toBeUndefined();
	});
});

describe("failure message usage isolation (W9-B finding 8)", () => {
	it("handleRunFailure messages get independent usage objects", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("stream broke");
			},
		});

		await agent.prompt("first");
		const failureA = agent.state.messages.at(-1);
		expect(failureA?.role).toBe("assistant");
		if (failureA?.role !== "assistant") throw new Error("expected an assistant failure message");
		expect(failureA.stopReason).toBe("error");
		failureA.usage.cost.total = 999;
		failureA.usage.input = 5;

		await agent.prompt("second");
		const failureB = agent.state.messages.at(-1);
		expect(failureB?.role).toBe("assistant");
		if (failureB?.role !== "assistant") throw new Error("expected an assistant failure message");
		expect(failureB.stopReason).toBe("error");
		expect(failureB.usage).not.toBe(failureA.usage);
		expect(failureB.usage.cost).not.toBe(failureA.usage.cost);
		expect(failureB.usage.cost.total).toBe(0);
		expect(failureB.usage.input).toBe(0);
	});
});
