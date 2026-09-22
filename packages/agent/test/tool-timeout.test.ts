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
interface ToolTurnOptions {
	tools: AgentTool<any>[];
	toolCalls: Array<{ id: string; name: string }>;
	config?: Partial<AgentLoopConfig>;
	signal?: AbortSignal;
	/** Async observers hold the loop's update flush open, which races the deadline timer. */
	onEvent?: (event: AgentEvent) => void | Promise<void>;
}

async function runToolTurn(options: ToolTurnOptions): Promise<{
	messages: AgentMessage[];
	events: AgentEvent[];
	streamCalls: () => number;
}> {
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
		// Async so a slow observer in a test can hold the loop's update flush open.
		async (event) => {
			events.push(event);
			await options.onEvent?.(event);
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
		expect(textOf(toolResult)).toContain("Abort cause: stall watchdog");
		expect(textOf(toolResult)).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		// The deadline's own wording is a superset of the abort stub, so the stub
		// alone cannot tell the two producers apart: the distinctive parts must.
		expect(textOf(toolResult)).not.toContain("per-call deadline");
	});

	it("a deadline-cancelled tool result never carries terminate back into a live turn", async () => {
		// 0902 deep review, must-2: the tool settled `terminate: true` in flight, and the
		// deadline harvested its partial output. The harvested result must NOT spread
		// `terminate` - only the run-abort harvest (the turn is already dying) does - or
		// the turn ends retroactively and the model loses the "same turn, different
		// approach" contract the types.ts invariant promises.
		const terminator = slowTool(60, "terminator");
		const originalExecute = terminator.execute;
		terminator.execute = async (...args) => {
			const result = await originalExecute(...args);
			return { ...result, terminate: true } as Awaited<ReturnType<typeof originalExecute>>;
		};
		const { messages, streamCalls } = await runToolTurn({
			tools: [terminator],
			toolCalls: [{ id: "tool_1", name: "terminator" }],
			config: { toolTimeout: { afterMs: 20 } },
		});

		const toolResult = toolResultOf(messages);
		// The harvest still caught the late output and tagged the deadline cause.
		expect(textOf(toolResult)).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		// But the turn stayed alive: terminate must not survive the timeout harvest.
		expect(streamCalls()).toBe(2);
		const last = messages.at(-1);
		expect(last?.role).toBe("assistant");
	});

	it("a run-aborted tool result still carries terminate (the turn is dying anyway)", async () => {
		// Negative control for the same guard: the run-abort harvest path keeps the
		// tool's own terminate so a run abort cannot resurrect a turn the tool ended.
		const controller = new AbortController();
		const terminator = slowTool(60, "terminator");
		const originalExecute = terminator.execute;
		terminator.execute = async (...args) => {
			const result = await originalExecute(...args);
			return { ...result, terminate: true } as Awaited<ReturnType<typeof originalExecute>>;
		};
		setTimeout(() => controller.abort("Abort cause: watchdog"), 10);
		const { messages } = await runToolTurn({
			tools: [terminator],
			toolCalls: [{ id: "tool_1", name: "terminator" }],
			signal: controller.signal,
			config: { toolTimeout: { afterMs: 60_000 } },
		});

		const toolResult = toolResultOf(messages);
		// The abort fired at 10ms; the tool settled at 60ms, so the harvest caught the
		// late partial output (marker + abort cause), not the fallback message. The
		// run-abort harvest is the path that still carries the tool's own terminate
		// internally (createToolResultMessage never puts it on the wire, so the pin
		// asserts the observable surface; the deadline pin above is the load-bearing one).
		expect(textOf(toolResult)).toContain(ABORT_TRUNCATION_MARKER);
		expect(textOf(toolResult)).toContain("Abort cause: watchdog");
		expect(toolResult.isError).toBe(true);
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

	it("a throwing vouch defers instead of cancelling (the judge must not execute the sentence)", async () => {
		const vouch = () => {
			throw new Error("arbiter unavailable");
		};
		// The tool settles well after the deadline: only the throwing arbiter's
		// extension keeps the call alive to complete.
		const { messages } = await runToolTurn({
			tools: [slowTool(150)],
			toolCalls: [{ id: "tool_1", name: "slow" }],
			config: { toolTimeout: { afterMs: 25, vouch } },
		});
		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(false);
		expect(textOf(toolResult)).toContain("late partial output");
		expect(textOf(toolResult)).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
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

	it("a real tool error is not rewritten into a deadline cancellation (same-frame double trigger)", async () => {
		// The tool settles by failing; a slow update flush keeps the catch inside the
		// function when the deadline timer fires. The settled failure must win: its
		// error text is the result, not the deadline's "produced no settled result".
		const tool: AgentTool<any> = {
			name: "failing",
			label: "Failing",
			description: "Emits an update then fails",
			parameters: toolSchema,
			execute: async (_id, _args, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} });
				await new Promise((resolve) => setTimeout(resolve, 5));
				throw new Error("real tool failure");
			},
		};
		const { messages, streamCalls } = await runToolTurn({
			tools: [tool],
			toolCalls: [{ id: "tool_1", name: "failing" }],
			config: { toolTimeout: { afterMs: 40 } },
			// Slow event delivery keeps the update flush pending past the deadline.
			onEvent: async (event) => {
				if (event.type === "tool_execution_update") {
					await new Promise((resolve) => setTimeout(resolve, 120));
				}
			},
		});
		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(textOf(toolResult)).toContain("real tool failure");
		expect(textOf(toolResult)).not.toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(streamCalls()).toBe(2);
	});

	it("the tool itself receives the deadline's abort signal with the timeout cause", async () => {
		let observedReason: string | undefined;
		const tool: AgentTool<any> = {
			name: "observing",
			label: "Observing",
			description: "Records the abort reason",
			parameters: toolSchema,
			execute: (_id, _args, signal) => {
				signal?.addEventListener("abort", () => {
					observedReason = String(signal.reason);
				});
				return new Promise<AgentToolResult<Record<string, unknown>>>(() => {});
			},
		};
		await runToolTurn({
			tools: [tool],
			toolCalls: [{ id: "tool_1", name: "observing" }],
			config: { toolTimeout: { afterMs: 25 } },
		});
		// The tool saw the cancellation itself (so it can interrupt its own
		// subprocess), and the reason carries the machine-greppable cause.
		expect(observedReason).toBeDefined();
		expect(observedReason).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		expect(observedReason).toContain("observing");
	});

	it("an operator perTool budget outranks the tool's own declaration", async () => {
		const quicker = { ...slowTool(90, "budgeted"), executionTimeoutMs: 5_000 };
		const { messages } = await runToolTurn({
			tools: [quicker],
			toolCalls: [{ id: "tool_1", name: "budgeted" }],
			config: { toolTimeout: { afterMs: 60_000, perTool: { budgeted: 20 } } },
		});
		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(textOf(toolResult)).toContain(TOOL_TIMEOUT_CAUSE_PREFIX);
		// The budget the deadline enforced was the operator's, not the tool's.
		expect(textOf(toolResult)).toContain("per-call budget 20ms");
	});

	it("an operator perTool 0 exempts one tool while the shared deadline stays armed", async () => {
		const exempt = { ...slowTool(90, "exempt"), executionTimeoutMs: 20 };
		const { messages } = await runToolTurn({
			tools: [exempt],
			toolCalls: [{ id: "tool_1", name: "exempt" }],
			config: { toolTimeout: { afterMs: 60_000, perTool: { exempt: 0 } } },
		});
		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(false);
		expect(textOf(toolResult)).toContain("late partial output");
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
