import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, StopReason } from "../src/types.js";

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
});
