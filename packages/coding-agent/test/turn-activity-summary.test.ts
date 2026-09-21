import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import {
	TurnActivityState,
	TurnSummaryComponent,
	turnStepVerb,
} from "../src/modes/interactive/components/turn-activity.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const ui = { requestRender: vi.fn() } as unknown as TUI;

function assistant(parts: AssistantMessage["content"], timestamp = 1_000): AssistantMessage {
	return {
		role: "assistant",
		content: parts,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(toolCallId: string, toolName: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** A tool-heavy turn: the mechanical noise U4 targets. */
function toolHeavyTurn(): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (let i = 1; i <= 6; i++) {
		out.push(
			assistant(
				i % 2 === 0
					? [{ type: "toolCall", id: `bash-${i}`, name: "bash", arguments: { command: `npm test --grep ${i}` } }]
					: [{ type: "toolCall", id: `edit-${i}`, name: "edit", arguments: { path: `src/file-${i}.ts` } }],
				1_000 + i * 100,
			),
		);
		out.push(
			toolResult(
				i % 2 === 0 ? `bash-${i}` : `edit-${i}`,
				i % 2 === 0 ? "bash" : "edit",
				`output line ${i}`,
				1_000 + i * 110,
			),
		);
	}
	out.push(assistant([{ type: "text", text: "All six checks passed; the build is green." }], 2_000));
	return out;
}

function renderAll(messages: readonly AgentMessage[], expanded: boolean): string {
	const components = buildConversationComponents(messages, {
		ui,
		cwd: "/tmp",
		toolOptions: {},
		getToolDefinition: () => undefined,
		toolsExpanded: expanded,
	});
	return components
		.flatMap((component) => component.render(120))
		.map(stripAnsi)
		.join("\n");
}

describe("turn activity summary (U4)", () => {
	beforeAll(() => initTheme("dark"));

	it("collapses one tool-heavy turn to a single aggregate line and expands on demand", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "run the checks", timestamp: 900 },
			...toolHeavyTurn(),
		];
		const collapsed = renderAll(messages, false);
		const collapsedLines = collapsed.split("\n").filter((line) => line.trim().length > 0);

		// The aggregate line: step count, duration, verb summary, expand hint.
		expect(collapsed).toContain("本轮 6 步");
		expect(collapsed).toContain("bash×3");
		expect(collapsed).toContain("edit×3");
		expect(collapsed).toContain("展开");
		// Settled tool bodies are hidden; the assistant prose stays.
		expect(collapsed).toContain("All six checks passed");
		expect(collapsed).not.toContain("npm test --grep 2");
		expect(collapsed).not.toContain("output line 2");

		const expanded = renderAll(messages, true);
		const expandedLines = expanded.split("\n").filter((line) => line.trim().length > 0);
		expect(expanded).toContain("npm test --grep 2");
		expect(expanded).toContain("output line 2");
		// U4 acceptance, mechanical form: the collapsed view has strictly fewer
		// non-empty lines than the expanded view for the same transcript.
		expect(collapsedLines.length).toBeLessThan(expandedLines.length);
	});

	it("groups per user turn: two prompts get two independent summary lines", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "first", timestamp: 900 },
			...toolHeavyTurn(),
			{ role: "user", content: "second", timestamp: 3_000 },
			assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } }], 3_100),
			toolResult("read-1", "read", "contents", 3_150),
			assistant([{ type: "text", text: "Done." }], 3_200),
		];
		const collapsed = renderAll(messages, false);
		const summaries = collapsed.split("\n").filter((line) => line.includes("本轮"));
		expect(summaries).toHaveLength(2);
		expect(collapsed).toContain("本轮 1 步");
		expect(collapsed).not.toContain("contents");
	});

	it("running steps never hide their live tool body while a later step runs", () => {
		const state = new TurnActivityState(1_000);
		state.addStep({ toolCallId: "t1", toolName: "bash", args: { command: "npm test" }, status: "done" });
		state.addStep({ toolCallId: "t2", toolName: "bash", args: { command: "npm run build" }, status: "running" });
		const summary = new TurnSummaryComponent(state);
		const line = stripAnsi(summary.render(120).join("\n"));
		expect(line).toContain("本轮 2 步");
		expect(line).toContain("运行中");
		// A settled turn pins its line; the verb summary keeps one fragment per verb.
		state.setStepStatus("t2", "done", 2_500);
		const settled = stripAnsi(summary.render(120).join("\n"));
		expect(settled).toContain("1.5s");
		expect(settled).toContain("bash×2");
	});

	it("turnStepVerb maps ipython cells to python and keeps other names", () => {
		expect(turnStepVerb("ipython")).toBe("python");
		expect(turnStepVerb("edit")).toBe("edit");
		expect(turnStepVerb("agent")).toBe("agent");
	});
});
