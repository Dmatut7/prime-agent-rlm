import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, StopReason, ToolResultMessage } from "../src/types.js";

/**
 * MV-4: a turn aborted during pure streaming leaves no tool result to carry the
 * abort cause, and transformMessages dropped the aborted assistant message
 * entirely - so the model's next request contained no trace of the abort (nor
 * of the DO-4 cause). The aborted turn must survive as a bounded trace while
 * the partial reasoning/tool calls that motivated the omission stay stripped.
 */
const model: Model<"anthropic-messages"> = {
	id: "fixture",
	name: "Fixture",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://localhost",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

const user: Message = { role: "user", content: "Run fixture", timestamp: 0 };

function assistant(
	content: AssistantMessage["content"],
	stopReason: StopReason,
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		errorMessage,
		timestamp: 0,
	};
}

function keptText(messages: Message[]): string {
	return messages
		.flatMap((msg) => (msg.role === "assistant" ? msg.content : []))
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "fixture_tool",
		content: [{ type: "text", text }],
		isError: true,
		timestamp: 0,
	};
}

const CAUSE =
	"Request was aborted (Abort cause: the turn was aborted after 300s of session silence; reasons: stall_watchdog)";

describe("aborted assistant cause trace (MV-4)", () => {
	it("keeps a trace of the abort cause for a pure streaming abort", () => {
		const messages = [user, assistant([{ type: "text", text: "let me run the long command" }], "aborted", CAUSE)];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(2);
		const text = keptText(out);
		expect(text).toContain("aborted");
		expect(text).toContain("stall_watchdog");
	});

	it("keeps the trace even when the aborted turn has no text of its own", () => {
		const messages = [user, assistant([], "aborted", CAUSE)];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(2);
		expect(keptText(out)).toContain("stall_watchdog");
	});

	it("truncates an over-long abort cause", () => {
		const longCause = `Request was aborted (Abort cause: ${"x".repeat(600)})`;
		const out = transformMessages([user, assistant([{ type: "text", text: "wip" }], "aborted", longCause)], model);

		const trace = keptText(out).replace("wip\n", "");
		expect(trace.length).toBeLessThanOrEqual(230);
		expect(trace).toContain("…");
	});

	it("strips partial thinking and tool calls from an aborted turn", () => {
		const messages = [
			user,
			assistant(
				[
					{ type: "thinking", thinking: "partial reasoning", thinkingSignature: "opaque" },
					{ type: "toolCall", id: "call|1", name: "fixture_tool", arguments: {} },
					{ type: "text", text: "wip" },
				],
				"aborted",
				CAUSE,
			),
		];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(2);
		const kept = out[1] as AssistantMessage;
		expect(kept.content.some((block) => block.type === "toolCall")).toBe(false);
		expect(kept.content.some((block) => block.type === "thinking")).toBe(false);
		expect(keptText(out)).toContain("wip");
		expect(keptText(out)).toContain("stall_watchdog");
	});

	it("still drops an aborted turn with no cause and nothing safe to replay", () => {
		const messages = [
			user,
			assistant([{ type: "toolCall", id: "call|1", name: "fixture_tool", arguments: {} }], "aborted"),
		];

		expect(transformMessages(messages, model)).toEqual([user]);
	});

	it("still drops errored assistant messages entirely, cause included", () => {
		const messages = [user, assistant([{ type: "text", text: "wip" }], "error", "upstream 503")];

		expect(transformMessages(messages, model)).toEqual([user]);
	});

	it("folds a harvested tool result into the abort trace instead of dropping it", () => {
		const messages = [
			user,
			assistant(
				[
					{ type: "toolCall", id: "call|1", name: "fixture_tool", arguments: {} },
					{ type: "text", text: "running the long command" },
				],
				"aborted",
				CAUSE,
			),
			toolResult("call|1", "partial build log: 42 tests passed"),
		];
		const original = structuredClone(messages);

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(2);
		expect(out.every((msg) => msg.role !== "toolResult")).toBe(true);
		const kept = out[1] as AssistantMessage;
		expect(kept.content.some((block) => block.type === "toolCall")).toBe(false);
		const text = keptText(out);
		expect(text).toContain("running the long command");
		expect(text).toContain("stall_watchdog");
		expect(text).toContain("[tool result from aborted turn (fixture_tool)]");
		expect(text).toContain("partial build log: 42 tests passed");
		expect(messages).toEqual(original);
	});

	it("materializes a trace from folded results when the aborted turn left neither text nor cause", () => {
		const messages = [
			user,
			assistant([{ type: "toolCall", id: "call|1", name: "fixture_tool", arguments: {} }], "aborted"),
			toolResult("call|1", "harvested partial output"),
		];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(2);
		const kept = out[1] as AssistantMessage;
		expect(kept.role).toBe("assistant");
		expect(kept.content).toEqual([
			{ type: "text", text: "[tool result from aborted turn (fixture_tool)]\nharvested partial output" },
		]);
	});

	it("folds several results of one aborted turn in order", () => {
		const messages = [
			user,
			assistant([], "aborted", CAUSE),
			toolResult("call|1", "first output"),
			toolResult("call|2", "second output"),
		];

		const out = transformMessages(messages, model);

		expect(out).toHaveLength(2);
		const text = keptText(out);
		expect(text.indexOf("first output")).toBeLessThan(text.indexOf("second output"));
	});

	it("bounds the folded tool result text", () => {
		const huge = "x".repeat(16 * 1024);
		const messages = [user, assistant([], "aborted", CAUSE), toolResult("call|1", huge)];

		const out = transformMessages(messages, model);

		const kept = out[1] as AssistantMessage;
		const folded = kept.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.find((text) => text.includes("tool result from aborted turn"));
		expect(folded).toBeDefined();
		expect(folded!.endsWith("…")).toBe(true);
		expect(folded!.length).toBeLessThanOrEqual(8 * 1024 + 100);
	});
});
