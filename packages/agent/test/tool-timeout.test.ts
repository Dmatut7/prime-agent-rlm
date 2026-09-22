import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	ABORT_TRUNCATION_MARKER,
	runAgentLoop,
	TOOL_ABORT_FALLBACK_MESSAGE,
	TOOL_TIMEOUT_CAUSE_PREFIX,
} from "../src/agent-loop.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	ToolTimeoutVerdict,
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
		cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
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

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "toolResult") as Message[];
}

const toolSchema = Type.Object({});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

function toolResultOf(messages: AgentMessage[]): Extract<AgentMessage, { role: "toolResult" }> {
	const toolResult = [...messages].reverse().find((message) => message.role === "toolResult");
	expect(toolResult?.role).toBe("toolResult");
	if (toolResult?.role !== "toolResult") throw new Error("expected a tool result message");
	return toolResult;
}

/**
 * One tool turn followed by a terminal assistant message, mirroring the loop's real
 * shape: the first stream answers with tool calls, the second sees the tool result
 * and finishes the turn. The number of stream calls is the "turn continued" receipt.
 */
async function runToolTurn(options: {
	tools: AgentTool<any>[];
	toolCalls: Array<{ id: string; name: string }>;
	config?: Partial<AgentLoopConfig>;
	signal?: AbortSignal;
	onEvent?: (event: AgentEvent) => void;
}): Promise<{ messages: AgentMessage[]; events: AgentEvent[]; streamCalls: () => number }> {
	const context: AgentContext = { systemPrompt: "You are helpful.", messages: [], tools: options.tools };
	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm: identityConverter,
		toolExecution: "sequential",
		...options.config,
	};
	const toolUseMessage = createAssistantMessage(
		options.toolCalls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: {} })),
	);
	const terminalMessage: AssistantMessage = {
		...toolUseMessage,
		content: [{ type: "text", text: "changed approach" }],
		stopReason: "stop",
	};
	let calls = 0;
	const streamFn = () => {
		const stream = new MockAssistantStream();
		const first = calls === 0;
		calls += 1;
		queueMicrotask(() => {
			if (first) {
				stream.push({ type: "done", reason: "toolUse", message: toolUseMessage });
			} else {
				stream.push({ type: "done", reason: "stop", message: terminalMessage });
			}
		});
		return stream;
	};
	const events: AgentEvent[] = [];
	const messages = await runAgentLoop(
		[createUserMessage("Hello")],
		context,
		config,
		(event) => {
			events.push(event);
			options.onEvent?.(event);
		},
		options.signal,
		streamFn,
	);
	return { messages, events, streamCalls: () => calls };
}

function hangTool(name = "hang"): AgentTool<any> {
	return {
		name,
		label: name,
		description: "A tool that never settles",
		parameters: toolSchema,
		execute: () => new Promise<AgentToolResult<Record<string, unknown>>>(() => {}),
	};
}

function slowTool(settleMs: number, name = "slow"): AgentTool<any> {
	return {
		name,
		label: name,
		description: "A tool that settles late",
		parameters: toolSchema,
		execute: async () => {
			await new Promise((resolve) => setTimeout(resolve, settleMs));
			return { content: [{ type: "text", text: "late partial output" }], details: {} };
		},
	};
}

describe("per-tool-call deadline", () => {
	it("cancels one wedged tool call and the turn continues with the model seeing why", async () => {
		const { messages, streamCalls } = await runToolTurn({
			tools: [hangTool()],
			toolCalls: [{ id: "tool_1", name: "hang" }],
			config: { toolTimeout: { afterMs: 30 } },
		});

		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(textOf(toolResult)).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(textOf(toolResult)).toContain("hang");
		expect(textOf(toolResult)).not.toContain(ABORT_TRUNCATION_MARKER);
		// The turn did not die: the model answered the cancelled call in a second request.
		expect(streamCalls()).toBe(2);
		const last = messages.at(-1);
		expect(last?.role).toBe("assistant");
		if (last?.role === "assistant") {
			expect(textOf({ content: last.content })).toContain("changed approach");
		}
	});

	it("harvests partial output from a call the deadline cancelled mid-flight", async () => {
		// Settles 60ms after the 20ms deadline: the harvest window (1250ms) must catch it.
		const { messages, streamCalls } = await runToolTurn({
			tools: [slowTool(60)],
			toolCalls: [{ id: "tool_1", name: "slow" }],
			config: { toolTimeout: { afterMs: 20 } },
		});

		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(textOf(toolResult)).toContain("late partial output");
		expect(textOf(toolResult)).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(streamCalls()).toBe(2);
	});

	it("a run abort keeps the abort wording - the two producers never cross", async () => {
		const controller = new AbortController();
		// Abort the run while the tool hangs, long before the 60s deadline could fire:
		// whichever producer wins, the result must speak the run abort's language.
		setTimeout(() => controller.abort("Abort cause: stall watchdog"), 20);
		const { messages } = await runToolTurn({
			tools: [hangTool()],
			toolCalls: [{ id: "tool_1", name: "hang" }],
			signal: controller.signal,
			config: { toolTimeout: { afterMs: 60_000 } },
		});

		const toolResult = toolResultOf(messages);
		expect(textOf(toolResult)).toContain(TOOL_ABORT_FALLBACK_MESSAGE);
		expect(textOf(toolResult)).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
	});

	it("an extension buys exactly one window: the next fire re-asks and fails", async () => {
		const vouch = vi.fn<(info: { elapsedMs: number; timeoutMs: number }) => ToolTimeoutVerdict | undefined>();
		vouch.mockReturnValueOnce({ action: "extend", recheckMs: 15 }).mockReturnValueOnce(undefined);

		const { messages, streamCalls } = await runToolTurn({
			tools: [hangTool()],
			toolCalls: [{ id: "tool_1", name: "hang" }],
			config: { toolTimeout: { afterMs: 25, vouch } },
		});

		expect(vouch).toHaveBeenCalledTimes(2);
		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(textOf(toolResult)).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(streamCalls()).toBe(2);
		// The verdict saw the real budget and a plausible elapsed time.
		const first = vouch.mock.calls[0][0];
		expect(first.timeoutMs).toBe(25);
		expect(first.elapsedMs).toBeGreaterThanOrEqual(20);
	});

	it("a throwing vouch fails towards cancelling the call", async () => {
		const vouch = () => {
			throw new Error("arbiter unavailable");
		};
		const { messages } = await runToolTurn({
			tools: [hangTool()],
			toolCalls: [{ id: "tool_1", name: "hang" }],
			config: { toolTimeout: { afterMs: 25, vouch } },
		});
		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(textOf(toolResult)).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
	});

	it("afterMs 0 arms no deadline (the rollback handle)", async () => {
		const { messages, streamCalls } = await runToolTurn({
			tools: [slowTool(60)],
			toolCalls: [{ id: "tool_1", name: "slow" }],
			config: { toolTimeout: { afterMs: 0 } },
		});
		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(false);
		expect(textOf(toolResult)).toContain("late partial output");
		expect(textOf(toolResult)).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(streamCalls()).toBe(2);
	});

	it("executionTimeoutMs 0 opts one tool out while the deadline stays armed for the rest", async () => {
		const exempt = { ...slowTool(80), executionTimeoutMs: 0 };
		const { messages } = await runToolTurn({
			tools: [exempt],
			toolCalls: [{ id: "tool_1", name: "slow" }],
			config: { toolTimeout: { afterMs: 20 } },
		});
		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(false);
		expect(textOf(toolResult)).toContain("late partial output");
	});

	it("a per-tool executionTimeoutMs refines the shared deadline", async () => {
		const quicker = { ...slowTool(90), executionTimeoutMs: 20 };
		const { messages } = await runToolTurn({
			tools: [quicker],
			toolCalls: [{ id: "tool_1", name: "slow" }],
			config: { toolTimeout: { afterMs: 60_000 } },
		});
		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(textOf(toolResult)).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
	});

	it("a cancelled call does not stop the rest of a sequential batch", async () => {
		const hang = hangTool("hang");
		const followUp: AgentTool<any> = {
			name: "followup",
			label: "Follow Up",
			description: "Runs after the cancelled call",
			parameters: toolSchema,
			execute: async () => ({ content: [{ type: "text", text: "follow-up ran" }], details: {} }),
		};
		const { messages } = await runToolTurn({
			tools: [hang, followUp],
			toolCalls: [
				{ id: "tool_1", name: "hang" },
				{ id: "tool_2", name: "followup" },
			],
			config: { toolTimeout: { afterMs: 25 } },
		});
		const toolResults = messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(2);
		const first = toolResults[0];
		const second = toolResults[1];
		if (first?.role !== "toolResult" || second?.role !== "toolResult") throw new Error("expected tool results");
		expect(first.isError).toBe(true);
		expect(textOf(first)).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		// The batch kept going: the run-level signal never aborted, so the next call ran.
		expect(second.isError).toBe(false);
		expect(textOf(second)).toContain("follow-up ran");
	});

	it("clears the deadline timer when the call settles (no per-call timer leak)", async () => {
		vi.useFakeTimers();
		try {
			const quick: AgentTool<any> = {
				name: "quick",
				label: "Quick",
				description: "Settles immediately",
				parameters: toolSchema,
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			};
			const { messages } = await runToolTurn({
				tools: [quick],
				toolCalls: [{ id: "tool_1", name: "quick" }],
				config: { toolTimeout: { afterMs: 10_000 } },
			});
			expect(textOf(toolResultOf(messages))).toContain("ok");
			// The settled call must have dropped its armed deadline: nothing stays
			// pending that could fire 10s later or keep the process alive.
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
