/**
 * ID-3: one assistant message that reuses a single tool call id for two calls.
 *
 * Providers are not required to keep tool call ids unique inside a message, and
 * nothing downstream could repair the ambiguity: both calls executed, both results
 * carried the reused id, the UI (pendingTools keyed by id) hung one result on the
 * wrong row and dropped the other, and the next request body carried two tool_use
 * and two tool_result blocks sharing one id, so pairing on the wire was undecidable.
 *
 * The agent loop now renames the colliding call deterministically on the way in and
 * reports the rewrite on the assistant message. These assertions are that contract:
 * unique result ids, two correctly paired UI rows, unique ids on the wire, and a
 * diagnostic that names the original id, the tool and the replacement.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { streamAnthropic } from "../../../../ai/src/providers/anthropic.js";
import { convertToLlm } from "../../../src/core/messages.js";
import { buildConversationComponents } from "../../../src/modes/interactive/components/conversation-components.js";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const DUPLICATE_ID = "dup-1";
const DEDUPLICATED_ID = `${DUPLICATE_ID}__dup2`;
const COLLISION_DIAGNOSTIC_TYPE = "tool_call_id_collision";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) {
		harnesses.pop()?.cleanup();
	}
});

function createTool(name: string, output: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: output }], details: {} }),
	};
}

/** A session whose model answers with two tool calls that share one id. */
async function createDuplicateIdHarness(): Promise<Harness> {
	const harness = await createHarness({
		tools: [createTool("alpha", "RESULT_ALPHA"), createTool("beta", "RESULT_BETA")],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("alpha", {}, { id: DUPLICATE_ID }), fauxToolCall("beta", {}, { id: DUPLICATE_ID })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("run both tools");
	return harness;
}

function assistantToolCallIds(harness: Harness): string[] {
	const message = harness.session.messages.find((candidate) => candidate.role === "assistant") as
		| AssistantMessage
		| undefined;
	expect(message).toBeDefined();
	return (message?.content ?? []).filter((part) => part.type === "toolCall").map((part) => part.id);
}

function toolResults(harness: Harness): ToolResultMessage[] {
	return harness.session.messages.filter((message) => message.role === "toolResult") as ToolResultMessage[];
}

function renderToolRows(harness: Harness): string[] {
	const components = buildConversationComponents(harness.session.messages, {
		ui: { requestRender: () => undefined } as never,
		cwd: harness.tempDir,
		toolOptions: {},
		getToolDefinition: () => undefined,
	});
	return components
		.filter((component) => component instanceof ToolExecutionComponent)
		.map((component) => stripAnsi(component.render(120).join(" ")).replace(/\s+/g, " "));
}

describe("assistant messages that reuse a tool call id", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("gives every result its own id and does not reuse the collided one", async () => {
		const harness = await createDuplicateIdHarness();

		const results = toolResults(harness);
		expect(results.map((result) => [result.toolCallId, result.toolName])).toEqual([
			[DUPLICATE_ID, "alpha"],
			[DEDUPLICATED_ID, "beta"],
		]);
		expect(results.map((result) => result.content[0]?.type === "text" && result.content[0].text)).toEqual([
			"RESULT_ALPHA",
			"RESULT_BETA",
		]);

		const ids = assistantToolCallIds(harness);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		// The result id equals the id its own call carries, so pairs are decidable.
		expect(results.map((result) => result.toolCallId)).toEqual(ids);
	});

	test("pairs each UI row with its own result and leaves no row running", async () => {
		const harness = await createDuplicateIdHarness();

		const rows = renderToolRows(harness);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain("alpha");
		expect(rows[0]).toContain("RESULT_ALPHA");
		expect(rows[1]).toContain("beta");
		expect(rows[1]).toContain("RESULT_BETA");
		expect(rows[0]).not.toContain("RESULT_BETA");
		expect(rows[1]).not.toContain("RESULT_ALPHA");
		for (const row of rows) {
			expect(row).not.toContain("running");
		}
	});

	test("hands live stream consumers the renamed id before the tool runs", async () => {
		const harness = await createDuplicateIdHarness();

		const expected = assistantToolCallIds(harness);
		// Every partial message a live consumer sees (the chat UI keys its pending tool
		// rows by this id) addresses at most one call per id.
		for (const event of harness.eventsOfType("message_update")) {
			if (event.message.role !== "assistant") {
				continue;
			}
			const ids = event.message.content.filter((part) => part.type === "toolCall").map((part) => part.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
		// The nested completion event carries the same id as the message it belongs to.
		const endedCallIds = harness
			.eventsOfType("message_update")
			.filter((event) => event.assistantMessageEvent.type === "toolcall_end")
			.map((event) =>
				event.assistantMessageEvent.type === "toolcall_end" ? event.assistantMessageEvent.toolCall.id : "",
			);
		expect(endedCallIds).toEqual(expected);
		// Execution addresses the same ids the assistant message carries.
		expect(harness.eventsOfType("tool_execution_start").map((event) => event.toolCallId)).toEqual(expected);
	});

	test("puts only unique tool ids in the next request body", async () => {
		const harness = await createDuplicateIdHarness();

		let captured: { messages?: unknown[] } | undefined;
		const server = http.createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				captured = JSON.parse(body) as { messages?: unknown[] };
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		const model: Model<"anthropic-messages"> = {
			id: "claude-sonnet-4-5",
			name: "claude-sonnet-4-5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: `http://127.0.0.1:${port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 4096,
		};
		try {
			await streamAnthropic(
				model,
				{ messages: convertToLlm(harness.session.messages), tools: [] },
				{
					apiKey: "sk-ant-api03-fake",
				},
			).result();
		} finally {
			server.close();
		}

		const blocks = (captured?.messages ?? []).flatMap((message) => {
			const candidate = message as { role?: string; content?: Array<Record<string, unknown>> };
			return (candidate.content ?? []).map((block) => ({
				role: candidate.role ?? "",
				type: String(block.type ?? ""),
				id: String(block.id ?? block.tool_use_id ?? ""),
			}));
		});
		const toolUseIds = blocks.filter((block) => block.type === "tool_use").map((block) => block.id);
		const toolResultIds = blocks.filter((block) => block.type === "tool_result").map((block) => block.id);
		expect(toolUseIds).toHaveLength(2);
		expect(toolResultIds).toHaveLength(2);
		expect(new Set(toolUseIds).size).toBe(2);
		expect(new Set(toolResultIds).size).toBe(2);
		expect(toolResultIds.slice().sort()).toEqual(toolUseIds.slice().sort());
	});

	test("reports the rewrite on the assistant message instead of repairing it silently", async () => {
		const harness = await createDuplicateIdHarness();

		const message = harness.session.messages.find((candidate) => candidate.role === "assistant") as
			| AssistantMessage
			| undefined;
		const collision = message?.diagnostics?.find((diagnostic) => diagnostic.type === COLLISION_DIAGNOSTIC_TYPE);
		expect(collision).toBeDefined();
		expect(collision?.details?.collisions).toEqual([
			{
				originalId: DUPLICATE_ID,
				deduplicatedId: DEDUPLICATED_ID,
				toolName: "beta",
				contentIndex: 1,
				occurrence: 2,
			},
		]);
		expect(String(collision?.details?.message)).toContain(DUPLICATE_ID);
		expect(String(collision?.details?.message)).toContain("beta");
	});
});
