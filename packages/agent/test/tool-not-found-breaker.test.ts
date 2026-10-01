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
	isToolNotFoundBreakerFailure,
	runAgentLoop,
	suggestToolNames,
	TOOL_NOT_FOUND_BREAKER_DEFAULTS,
	TOOL_NOT_FOUND_BREAKER_DIAGNOSTIC_TYPE,
	TOOL_NOT_FOUND_BREAKER_STOP_REASON_RAW,
} from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";

/**
 * W11-C (model-cases C1/C2/C3): the "Tool X not found" receipt used to be nineteen
 * characters of dead end - no tool list, no suggestion - and nothing inside the run
 * bounded a model that kept inventing tool names (C1: 152 in a row over 44 minutes).
 * The loop now (1) answers every unknown-tool call with the available tool names and
 * a did-you-mean suggestion, and (2) runs a per-run breaker: a warn receipt at N
 * unknown-tool calls and a classified terminal error at M.
 */

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

function createUsage(): AssistantMessage["usage"] {
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

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): AssistantMessage["content"][number] {
	return { type: "toolCall", id, name, arguments: args };
}

function assistantWith(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

const echoTool: AgentTool<any> = {
	name: "echo",
	label: "echo",
	description: "Echoes the text back",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: String((params as { text: string }).text) }],
		details: {},
	}),
};

const ipythonTool: AgentTool<any> = {
	name: "ipython",
	label: "ipython",
	description: "Runs python in the REPL kernel",
	parameters: Type.Object({ code: Type.String() }),
	execute: async (_id, params) => ({
		content: [{ type: "text", text: String((params as { code: string }).code) }],
		details: {},
	}),
};

interface ScriptedRun {
	messages: AgentMessage[];
	events: AgentEvent[];
	streamCalls: () => number;
}

/** Drives one run off a script of assistant messages, one per provider request. */
async function runScripted(options: {
	tools: AgentTool<any>[];
	steps: AssistantMessage[];
	config?: Partial<AgentLoopConfig>;
}): Promise<ScriptedRun> {
	const context: AgentContext = { systemPrompt: "You are helpful.", messages: [], tools: options.tools };
	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm: identityConverter,
		...options.config,
	};
	let calls = 0;
	const streamFn = vi.fn(() => {
		const step = options.steps[calls];
		calls += 1;
		if (!step) throw new Error(`script exhausted at provider call ${calls}`);
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: step });
			stream.push({ type: "done", reason: step.stopReason === "toolUse" ? "toolUse" : "stop", message: step });
		});
		return stream;
	});
	const events: AgentEvent[] = [];
	const messages = await runAgentLoop(
		[createUserMessage("do the work")],
		context,
		config,
		async (event) => {
			events.push(event);
		},
		undefined,
		streamFn,
	);
	return { messages, events, streamCalls: () => calls };
}

function toolResultTexts(messages: AgentMessage[]): string[] {
	return messages
		.filter((message) => message.role === "toolResult")
		.map((message) =>
			(message.role === "toolResult" ? message.content : [])
				.map((block) => (block.type === "text" ? block.text : ""))
				.join("\n"),
		);
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage {
	const last = [...messages].reverse().find((message) => message.role === "assistant");
	if (!last || last.role !== "assistant") throw new Error("expected an assistant message");
	return last;
}

describe("suggestToolNames", () => {
	it("suggests the real name for a typo and for XML-corrupted suffixes (C1)", () => {
		expect(suggestToolNames("ipyton", ["ipython", "echo"])).toEqual(["ipython"]);
		expect(suggestToolNames("ipython</arg_value>", ["ipython", "echo"])).toEqual(["ipython"]);
	});

	it("matches case-insensitively", () => {
		expect(suggestToolNames("Echo", ["echo", "ipython"])).toEqual(["echo"]);
	});

	it("suggests nothing for an invented name with no near neighbor (C2/C3)", () => {
		expect(suggestToolNames("rlm", ["ipython", "echo"])).toEqual([]);
		expect(suggestToolNames("agent_observe", ["ipython", "echo"])).toEqual([]);
	});

	it("returns nothing when no tools are available", () => {
		expect(suggestToolNames("echo", [])).toEqual([]);
	});
});

describe("tool-not-found receipt", () => {
	it("attaches the available tool list and a did-you-mean suggestion", async () => {
		const { messages, streamCalls } = await runScripted({
			tools: [ipythonTool, echoTool],
			steps: [assistantWith([toolCall("c1", "ipyton")]), assistantWith([{ type: "text", text: "done" }])],
		});

		const [receipt] = toolResultTexts(messages);
		expect(receipt).toContain("Tool ipyton not found");
		expect(receipt).toContain("Available tools: ipython, echo");
		expect(receipt).toContain('Did you mean: "ipython"?');
		// One bad call is below the warn threshold: no breaker wording yet.
		expect(receipt).not.toContain("tool-not-found breaker");
		expect(streamCalls()).toBe(2);
	});

	it("says there are no tools instead of listing an empty set", async () => {
		const { messages } = await runScripted({
			tools: [],
			steps: [assistantWith([toolCall("c1", "anything")]), assistantWith([{ type: "text", text: "done" }])],
		});

		const [receipt] = toolResultTexts(messages);
		expect(receipt).toContain("Tool anything not found");
		expect(receipt).toContain("No tools are available");
		expect(receipt).not.toContain("Available tools:");
	});

	it("keeps the legacy first line so the bad-call storm classifier still matches", async () => {
		const { messages } = await runScripted({
			tools: [echoTool],
			steps: [assistantWith([toolCall("c1", "garbage")]), assistantWith([{ type: "text", text: "done" }])],
		});

		const [receipt] = toolResultTexts(messages);
		expect(receipt.split("\n")[0]).toBe("Tool garbage not found");
	});
});

describe("tool-not-found breaker", () => {
	it("warns at the Nth unknown-tool call and terminates the run at the Mth (defaults 3/5)", async () => {
		const steps = Array.from({ length: TOOL_NOT_FOUND_BREAKER_DEFAULTS.terminateAfter + 3 }, (_unused, index) =>
			assistantWith([toolCall(`c${index}`, "rlm")]),
		);
		const { messages, streamCalls } = await runScripted({ tools: [ipythonTool, echoTool], steps });

		// The run stopped at the default terminateAfter: five provider requests, not eight.
		expect(streamCalls()).toBe(TOOL_NOT_FOUND_BREAKER_DEFAULTS.terminateAfter);

		const receipts = toolResultTexts(messages);
		expect(receipts).toHaveLength(TOOL_NOT_FOUND_BREAKER_DEFAULTS.terminateAfter);
		expect(receipts[0]).not.toContain("tool-not-found breaker");
		expect(receipts[1]).not.toContain("tool-not-found breaker");
		// The warn receipt carries the forced-correction instruction (restate the tools).
		expect(receipts[2]).toContain("tool-not-found breaker");
		expect(receipts[2]).toContain("restate");
		expect(receipts[2]).toContain("ipython");
		expect(receipts[3]).toContain("tool-not-found breaker");

		// The terminal message is a classified error, not a silent stop.
		const terminal = lastAssistant(messages);
		expect(terminal.stopReason).toBe("error");
		expect(terminal.stopReasonRaw).toBe(TOOL_NOT_FOUND_BREAKER_STOP_REASON_RAW);
		expect(isToolNotFoundBreakerFailure(terminal)).toBe(true);
		expect(terminal.errorMessage).toContain('"rlm"');
		expect(terminal.errorMessage).toContain("5");
		expect(
			terminal.diagnostics?.some(
				(diagnostic) =>
					diagnostic.type === "agent_lifecycle_failure" &&
					(diagnostic.details as { source?: string } | undefined)?.source === "tool_not_found_breaker",
			),
		).toBe(true);
		const breakerDiagnostic = terminal.diagnostics?.find(
			(diagnostic) => diagnostic.type === TOOL_NOT_FOUND_BREAKER_DIAGNOSTIC_TYPE,
		);
		expect(breakerDiagnostic).toBeDefined();
		expect((breakerDiagnostic?.details ?? {}) as { toolName?: string }).toMatchObject({ toolName: "rlm" });
	});

	it("counts a whole parallel batch: four bad calls in one message warn on the third", async () => {
		const { messages, streamCalls } = await runScripted({
			tools: [ipythonTool],
			steps: [
				assistantWith([toolCall("c1", "rlm"), toolCall("c2", "rlm"), toolCall("c3", "rlm"), toolCall("c4", "rlm")]),
				assistantWith([{ type: "text", text: "recovered" }]),
			],
		});

		const receipts = toolResultTexts(messages);
		expect(receipts).toHaveLength(4);
		expect(receipts[0]).not.toContain("tool-not-found breaker");
		expect(receipts[2]).toContain("tool-not-found breaker");
		// Below terminateAfter, so the run went on and the model's recovery was accepted.
		expect(streamCalls()).toBe(2);
		expect(lastAssistant(messages).stopReason).toBe("stop");
	});

	it("C2 relapse: a recovered name that comes back still counts toward the per-name limit", async () => {
		const { messages, streamCalls } = await runScripted({
			tools: [ipythonTool, echoTool],
			steps: [
				// Four hallucinated `rlm` calls in one batch (the C2 opening).
				assistantWith([toolCall("c1", "rlm"), toolCall("c2", "rlm"), toolCall("c3", "rlm"), toolCall("c4", "rlm")]),
				// The model finds the right path and runs one good call...
				assistantWith([toolCall("c5", "ipython", { code: "spawn()" })]),
				// ...and four lines later relapses (C2 verbatim). The fifth `rlm` trips the breaker.
				assistantWith([toolCall("c6", "rlm")]),
				assistantWith([{ type: "text", text: "should never be requested" }]),
			],
		});

		expect(streamCalls()).toBe(3);
		const terminal = lastAssistant(messages);
		expect(isToolNotFoundBreakerFailure(terminal)).toBe(true);
		expect(terminal.errorMessage).toContain('"rlm"');
	});

	it("a good call resets the consecutive streak, so scattered different names below the per-name limit do not trip", async () => {
		const { messages, streamCalls } = await runScripted({
			tools: [echoTool],
			steps: [
				assistantWith([toolCall("c1", "nope1"), toolCall("c2", "nope2")]),
				assistantWith([toolCall("c3", "echo", { text: "ok" })]),
				assistantWith([toolCall("c4", "nope3"), toolCall("c5", "nope4")]),
				assistantWith([{ type: "text", text: "done" }]),
			],
		});

		// Total unknown-tool calls: 4, but never 3 in a row and no name repeats.
		expect(streamCalls()).toBe(4);
		expect(lastAssistant(messages).stopReason).toBe("stop");
	});

	it("honors custom warn/terminate thresholds", async () => {
		const steps = Array.from({ length: 5 }, (_unused, index) => assistantWith([toolCall(`c${index}`, "rlm")]));
		const { messages, streamCalls } = await runScripted({
			tools: [echoTool],
			steps,
			config: { toolNotFoundBreaker: { warnAfter: 1, terminateAfter: 2 } },
		});

		expect(streamCalls()).toBe(2);
		const receipts = toolResultTexts(messages);
		expect(receipts[0]).toContain("tool-not-found breaker");
		expect(isToolNotFoundBreakerFailure(lastAssistant(messages))).toBe(true);
	});

	it("disabled keeps the enriched receipts but never counts and never terminates", async () => {
		const steps = [
			...Array.from({ length: 6 }, (_unused, index) => assistantWith([toolCall(`c${index}`, "rlm")])),
			assistantWith([{ type: "text", text: "done" }]),
		];
		const { messages, streamCalls } = await runScripted({
			tools: [echoTool],
			steps,
			config: { toolNotFoundBreaker: { enabled: false } },
		});

		expect(streamCalls()).toBe(7);
		const receipts = toolResultTexts(messages);
		expect(receipts).toHaveLength(6);
		for (const receipt of receipts) {
			expect(receipt).toContain("Available tools: echo");
			expect(receipt).not.toContain("tool-not-found breaker");
		}
		expect(lastAssistant(messages).stopReason).toBe("stop");
	});

	it("the terminal turn still delivers its tool results before the run ends", async () => {
		const steps = [
			...Array.from({ length: 4 }, (_unused, index) => assistantWith([toolCall(`c${index}`, "rlm")])),
			assistantWith([toolCall("c4", "rlm"), toolCall("c5", "echo", { text: "evidence" })]),
		];
		const { messages, events } = await runScripted({ tools: [echoTool], steps });

		// The tripping batch's good call still executed and its result is on record.
		const receipts = toolResultTexts(messages);
		expect(receipts.some((text) => text === "evidence")).toBe(true);
		expect(events.some((event) => event.type === "turn_end")).toBe(true);
		expect(events.at(-1)?.type).toBe("agent_end");
	});
});
