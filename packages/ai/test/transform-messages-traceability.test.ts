import { afterEach, describe, expect, it } from "vitest";
import { type LogEntry, setLogSink } from "../src/log.js";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, StopReason, ToolResultMessage } from "../src/types.js";

/**
 * Every message transformMessages rewrites is a rewrite the caller cannot see: an orphaned tool
 * result is dropped and a missing one is replaced with "No result provided". Both must leave a
 * trace in the log, otherwise the conversation the provider receives silently differs from the
 * conversation on disk.
 */

const model: Model<"anthropic-messages"> = {
	id: "fixture",
	name: "Fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function assistant(stopReason: StopReason, ...ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "fixture_tool", arguments: {} })),
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
		stopReason,
		timestamp: 0,
	};
}

function toolResult(toolCallId: string, text = "completed"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture_tool",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	};
}

const user: Message = { role: "user", content: "Run fixture", timestamp: 0 };

let entries: LogEntry[] = [];
let sinkInstalled = false;

function captureLog(): LogEntry[] {
	entries = [];
	setLogSink((entry) => {
		entries.push(entry);
	});
	sinkInstalled = true;
	return entries;
}

afterEach(() => {
	if (sinkInstalled) {
		setLogSink(undefined);
		sinkInstalled = false;
	}
});

function warningsAbout(id: string): LogEntry[] {
	return entries.filter(
		(entry) =>
			entry.level === "warn" && entry.component === "transform-messages" && JSON.stringify(entry).includes(id),
	);
}

describe("transformMessages traceability", () => {
	it("logs the drop of a tool result that matches no call", () => {
		captureLog();
		const messages = [user, assistant("toolUse", "kept"), toolResult("kept"), toolResult("orphan-1")];

		const transformed = transformMessages(messages, model);

		expect(transformed.some((message) => message.role === "toolResult" && message.toolCallId === "orphan-1")).toBe(
			false,
		);
		const dropped = warningsAbout("orphan-1");
		expect(dropped.length).toBeGreaterThan(0);
		expect(dropped[0].toolCallId).toBe("orphan-1");
		expect(dropped[0].msg).toContain("Dropped");
	});

	it("logs the synthetic result it writes for a call without one", () => {
		captureLog();
		const messages = [user, assistant("toolUse", "missing-1")];

		const transformed = transformMessages(messages, model);

		const synthetic = transformed.find(
			(message) => message.role === "toolResult" && message.toolCallId === "missing-1",
		) as ToolResultMessage | undefined;
		expect(synthetic?.content).toEqual([{ type: "text", text: "No result provided" }]);
		const synthesized = warningsAbout("missing-1");
		expect(synthesized.length).toBeGreaterThan(0);
		expect(synthesized[0].toolCallId).toBe("missing-1");
		expect(synthesized[0].msg).toContain("Synthesized");
	});

	it("stays quiet when every result matches its call", () => {
		captureLog();
		const messages = [user, assistant("toolUse", "kept"), toolResult("kept")];

		transformMessages(messages, model);

		expect(entries).toEqual([]);
	});
});
