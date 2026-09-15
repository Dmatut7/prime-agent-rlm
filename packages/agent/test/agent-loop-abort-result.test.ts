import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	ABORT_HARVEST_MAX_BYTES,
	ABORT_HARVEST_TIMEOUT_MS,
	ABORT_TRUNCATION_MARKER,
	harvestAbortedToolResult,
	runAgentLoop,
	TOOL_ABORT_FALLBACK_MESSAGE,
} from "../src/agent-loop.js";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
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

const toolSchema = Type.Object({});

function createTool(
	execute: AgentTool<typeof toolSchema, Record<string, unknown>>["execute"],
): AgentTool<typeof toolSchema, Record<string, unknown>> {
	return {
		name: "work",
		label: "Work",
		description: "Work",
		parameters: toolSchema,
		execute,
	};
}

interface TurnOptions {
	tool: AgentTool<typeof toolSchema, Record<string, unknown>>;
	signal?: AbortSignal;
	config?: Partial<AgentLoopConfig>;
	onEvent?: (event: AgentEvent) => void;
}

/** One tool turn followed by a terminal assistant message, so the loop always ends. */
async function runToolTurn(options: TurnOptions): Promise<{ messages: AgentMessage[]; events: AgentEvent[] }> {
	const context: AgentContext = {
		systemPrompt: "You are helpful.",
		messages: [],
		tools: [options.tool],
	};
	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm: identityConverter,
		toolExecution: "sequential",
		...options.config,
	};
	const toolUseMessage = createAssistantMessage(
		[{ type: "toolCall", id: "tool_1", name: options.tool.name, arguments: {} }],
		"toolUse",
	);
	const terminalMessage = createAssistantMessage([{ type: "text", text: "done" }], "stop");
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
	return { messages, events };
}

function toolResultOf(messages: AgentMessage[]): Extract<AgentMessage, { role: "toolResult" }> {
	const toolResult = [...messages].reverse().find((message) => message.role === "toolResult");
	expect(toolResult?.role).toBe("toolResult");
	if (toolResult?.role !== "toolResult") throw new Error("expected a tool result message");
	return toolResult;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("abort cause disclosure (DO-4)", () => {
	it("carries the abort cause into the in-flight tool result and the aborted assistant message", async () => {
		const controller = new AbortController();
		const cause = "Abort cause: the turn was aborted after 300s of session silence; reasons: stall_watchdog.";
		const tool = createTool(async () => ({
			content: [{ type: "text", text: "partial output from a long bash command" }],
			details: { status: "ok" },
		}));

		const { messages } = await runToolTurn({
			tool,
			signal: controller.signal,
			config: {
				afterToolCall: async () => {
					controller.abort(cause);
					return undefined;
				},
			},
		});

		const toolResult = toolResultOf(messages);
		expect(textOf(toolResult)).toContain(ABORT_TRUNCATION_MARKER);
		expect(textOf(toolResult)).toContain(cause);
	});

	it("keeps the bare abort stub when no cause was attached", async () => {
		const controller = new AbortController();
		const tool = createTool(async () => ({
			content: [{ type: "text", text: "partial output" }],
			details: { status: "ok" },
		}));
		const { messages } = await runToolTurn({
			tool,
			signal: controller.signal,
			config: {
				afterToolCall: async () => {
					controller.abort();
					return undefined;
				},
			},
		});
		const toolResult = toolResultOf(messages);
		expect(textOf(toolResult)).not.toContain("Abort cause");
		expect(JSON.stringify(toolResult.content)).not.toContain("Request was aborted");
	});
});

describe("aborted tool result evidence (T1-5)", () => {
	it("preserves the tool's own output when the turn aborts during finalization", async () => {
		const controller = new AbortController();
		const tool = createTool(async () => ({
			content: [{ type: "text", text: "partial output from a long cell" }],
			details: { status: "ok" },
		}));

		const { messages } = await runToolTurn({
			tool,
			signal: controller.signal,
			// The hook aborts the turn: HEAD rejected the wrapped hook with the abort
			// error and replaced the whole result with its 19-character message.
			config: {
				afterToolCall: async () => {
					controller.abort();
					return undefined;
				},
			},
		});

		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(toolResult.content[0]).toEqual({ type: "text", text: "partial output from a long cell" });
		expect(toolResult.content.some((block) => block.type === "text" && block.text === ABORT_TRUNCATION_MARKER)).toBe(
			true,
		);
		expect(toolResult.details).toEqual({ status: "ok" });
		expect(JSON.stringify(toolResult.content)).not.toContain("Request was aborted");
	});

	it("harvests the in-flight result when the abort left no tool output", async () => {
		const controller = new AbortController();
		const tool = createTool(async () => {
			controller.abort();
			await delay(20);
			return {
				content: [{ type: "text", text: "harvested tail of the cell" }],
				details: { status: "aborted" },
			};
		});

		const { messages } = await runToolTurn({ tool, signal: controller.signal });

		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(toolResult.content[0]).toEqual({ type: "text", text: "harvested tail of the cell" });
		expect(textOf(toolResult)).toContain(ABORT_TRUNCATION_MARKER);
	});

	it("bounds harvested output to the last 8KB of text without splitting a sequence", async () => {
		const controller = new AbortController();
		const head = "line-head-0001\n";
		const body = Array.from({ length: 3000 }, (_unused, index) => `line-${index.toString().padStart(5, "0")}\n`).join(
			"",
		);
		const multibyteTail = "尾段保留🚧\n";
		const payload = head + body + multibyteTail;
		expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(ABORT_HARVEST_MAX_BYTES);

		const tool = createTool(async () => {
			controller.abort();
			await delay(10);
			return { content: [{ type: "text", text: payload }], details: {} };
		});

		const { messages } = await runToolTurn({ tool, signal: controller.signal });

		const toolResult = toolResultOf(messages);
		const harvested = toolResult.content[0];
		expect(harvested?.type).toBe("text");
		if (harvested?.type !== "text") throw new Error("expected a text block");
		expect(Buffer.byteLength(harvested.text, "utf8")).toBeLessThanOrEqual(ABORT_HARVEST_MAX_BYTES);
		// Tail, not head: the last bytes of the cell are the ones worth re-reading.
		expect(harvested.text.endsWith(multibyteTail)).toBe(true);
		expect(harvested.text).not.toContain("line-head-0001");
		expect(harvested.text).not.toContain("\uFFFD");
		expect(textOf(toolResult)).toContain(ABORT_TRUNCATION_MARKER);
	});

	it("falls back to the abort stub when the harvest times out, within the documented bound", async () => {
		const controller = new AbortController();
		const tool = createTool(() => new Promise<AgentToolResult<Record<string, unknown>>>(() => {}));
		let abortedAt = 0;
		let endedAt = 0;

		const { messages } = await runToolTurn({
			tool,
			signal: controller.signal,
			onEvent: (event) => {
				if (event.type === "tool_execution_start") {
					setTimeout(() => {
						abortedAt = Date.now();
						controller.abort();
					}, 0);
				}
				if (event.type === "tool_execution_end" && abortedAt > 0) {
					endedAt = Date.now();
				}
			},
		});

		expect(abortedAt).toBeGreaterThan(0);
		expect(endedAt).toBeGreaterThanOrEqual(abortedAt);
		// M1: the user-visible cost of the harvest is bounded by the harvest itself.
		expect(endedAt - abortedAt).toBeLessThanOrEqual(ABORT_HARVEST_TIMEOUT_MS + 500);

		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(toolResult.content).toEqual([{ type: "text", text: TOOL_ABORT_FALLBACK_MESSAGE }]);
	});

	it("survives a tool that rejects after the abort without an unhandled rejection", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			const controller = new AbortController();
			const tool = createTool(async () => {
				controller.abort();
				await delay(20);
				throw new Error("kernel died mid-cell");
			});

			const { messages } = await runToolTurn({ tool, signal: controller.signal });
			const toolResult = toolResultOf(messages);
			expect(toolResult.content).toEqual([{ type: "text", text: TOOL_ABORT_FALLBACK_MESSAGE }]);
			await delay(60);
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});

	it("keeps overwriting the result when a hook fails without an abort (positive control)", async () => {
		const tool = createTool(async () => ({
			content: [{ type: "text", text: "tool output" }],
			details: {},
		}));

		const { messages } = await runToolTurn({
			tool,
			config: {
				afterToolCall: async () => {
					throw new Error("hook boom");
				},
			},
		});

		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(true);
		expect(toolResult.content).toEqual([{ type: "text", text: "hook boom" }]);
	});

	it("leaves an uninterrupted tool result untouched (positive control)", async () => {
		const tool = createTool(async () => ({
			content: [{ type: "text", text: "clean output" }],
			details: { status: "ok" },
		}));

		const { messages } = await runToolTurn({ tool });

		const toolResult = toolResultOf(messages);
		expect(toolResult.isError).toBe(false);
		expect(toolResult.content).toEqual([{ type: "text", text: "clean output" }]);
	});

	it("harvests a value that settles in time and swallows one that does not", async () => {
		expect(await harvestAbortedToolResult(Promise.resolve({ value: 1 }), 100)).toEqual({ value: 1 });
		expect(await harvestAbortedToolResult(Promise.reject(new Error("immediate failure")), 100)).toBeUndefined();
		const late = new Promise<{ value: number }>((_resolve, reject) => {
			setTimeout(() => reject(new Error("late failure")), 40);
		});
		expect(await harvestAbortedToolResult(late, 5)).toBeUndefined();
		// Positive control for the timeout branch: the same helper returns the value
		// when the operation wins the race.
		expect(
			await harvestAbortedToolResult(
				delay(5).then(() => ({ value: 2 })),
				200,
			),
		).toEqual({ value: 2 });
	});
});
