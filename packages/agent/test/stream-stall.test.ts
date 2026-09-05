import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.js";

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
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function createContext(): AgentContext {
	return {
		systemPrompt: "You are helpful.",
		messages: [],
		tools: [],
	};
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

describe("agent loop stream stall detection", () => {
	it("settles a silent stream with a retryable error once streamStallTimeoutMs elapses", async () => {
		const context = createContext();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStallTimeoutMs: 40,
		};
		let providerSignal: AbortSignal | undefined;
		const streamFn = vi.fn((_model: Model<any>, _context: unknown, options: { signal?: AbortSignal }) => {
			providerSignal = options?.signal;
			return new MockAssistantStream(); // never pushes an event
		});

		const events: AgentEvent[] = [];
		const startedAt = Date.now();
		const messages = await runAgentLoop(
			[createUserMessage("hello")],
			context,
			config,
			async (event) => {
				events.push(event);
			},
			undefined,
			streamFn as never,
		);
		const elapsedMs = Date.now() - startedAt;

		expect(elapsedMs).toBeGreaterThanOrEqual(30);
		expect(providerSignal?.aborted).toBe(true);
		const assistant = lastAssistant(messages);
		expect(assistant?.stopReason).toBe("error");
		expect(assistant?.errorMessage).toContain("Stream stalled");
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
		// Exactly one assistant message_end: the fork's stall path used to emit a
		// duplicate for the same turn, which .some() could not see. The prompt's own
		// message_end is separate, so filter by role rather than counting them all.
		expect(events.filter((event) => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(
			1,
		);
	});

	it("resets the stall deadline when events keep arriving", async () => {
		const context = createContext();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStallTimeoutMs: 50,
		};
		const stream = new MockAssistantStream();
		let partial = createAssistantMessage([{ type: "text", text: "" }], "stop");
		// An event every 20ms stays ahead of the 50ms deadline; silence after the
		// last event then trips the stall.
		let pushes = 0;
		const pusher = setInterval(() => {
			pushes++;
			if (pushes === 1) {
				stream.push({ type: "start", partial });
			} else if (pushes < 4) {
				partial = {
					...partial,
					content: [{ type: "text", text: `chunk-${pushes}` }],
				};
				stream.push({ type: "text_delta", contentIndex: 0, delta: `chunk-${pushes}`, partial });
			} else {
				clearInterval(pusher);
			}
		}, 20);

		const events: AgentEvent[] = [];
		const startedAt = Date.now();
		const messages = await runAgentLoop(
			[createUserMessage("hello")],
			context,
			config,
			async (event) => {
				events.push(event);
			},
			undefined,
			(() => stream) as never,
		);
		const elapsedMs = Date.now() - startedAt;

		expect(pushes).toBeGreaterThanOrEqual(3);
		// Three event bursts (~60ms) plus the final silent window (~50ms).
		expect(elapsedMs).toBeGreaterThanOrEqual(100);
		const assistant = lastAssistant(messages);
		expect(assistant?.stopReason).toBe("error");
		expect(assistant?.errorMessage).toContain("Stream stalled");
	});

	it("does not apply a stall timeout when streamStallTimeoutMs is unset or 0", async () => {
		for (const streamStallTimeoutMs of [undefined, 0]) {
			const context = createContext();
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				streamStallTimeoutMs,
			};
			const stream = new MockAssistantStream();
			const controller = new AbortController();
			const events: AgentEvent[] = [];
			const runPromise = runAgentLoop(
				[createUserMessage("hello")],
				context,
				config,
				async (event) => {
					events.push(event);
				},
				controller.signal,
				(() => stream) as never,
			);

			// The silent stream must still be running after the window in which a
			// default stall detector would have fired.
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(events.some((event) => event.type === "agent_end")).toBe(false);

			controller.abort();
			stream.push({
				type: "error",
				reason: "aborted",
				error: createAssistantMessage([{ type: "text", text: "" }], "aborted"),
			});
			const messages = await runPromise;
			expect(lastAssistant(messages)?.stopReason).toBe("aborted");
		}
	});
});
