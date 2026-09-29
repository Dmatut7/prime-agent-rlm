import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { type BoxHeader, computeBoxHeader } from "../src/modes/interactive/components/turn-box.js";
import { formatBoxDuration } from "../src/modes/interactive/components/turn-timeline.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const T0 = 1_700_000_000_000;

function assistant(
	timestamp: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
		...(errorMessage ? { errorMessage } : {}),
	};
}

function toolResult(id: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp,
	};
}

/** The one turn a replay of `messages` builds. */
function replayedSummary(messages: AgentMessage[]): TurnSummaryComponent {
	const components = buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
	});
	const summaries = components.filter((component) => component instanceof TurnSummaryComponent);
	expect(summaries).toHaveLength(1);
	return summaries[0] as TurnSummaryComponent;
}

/** How the turn's facts sum up a finished turn (the timeline draws no header of it, and carries no clock in it). */
function labelOf(summary: TurnSummaryComponent): BoxHeader {
	const { state } = summary;
	const view = state.boxView();
	return computeBoxHeader({
		rows: view.rows,
		facts: view.facts,
		timeline: state.timeline,
		live: view.live,
		phase: state.currentPhase,
		currentThinking: "",
		now: Date.now(),
	});
}

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

/** The turn's clock as the status line reads it, and that it stopped with the turn: no hours pass however late it is asked. */
function expectFourSeconds(summary: TurnSummaryComponent): void {
	const { state } = summary;
	expect(state.turnDurationMs()).toBe(4_000);
	expect(state.turnDurationMs(Date.now() + 10 * 3_600_000)).toBe(4_000);
	const clock = formatBoxDuration(state.turnDurationMs());
	expect(clock).toMatch(/(?<!\d)4秒/);
	expect(clock).not.toMatch(/小时/);
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

describe("a replayed turn that ended on an interrupt or an error keeps its own clock", () => {
	// The turn's first reply is at T0+1s and the cut-off one at T0+5s: four seconds, years before now.
	const cutOff = (stopReason: "aborted" | "error", errorMessage?: string): AgentMessage[] => [
		{ role: "user", content: "跑一下测试", timestamp: T0 },
		assistant(
			T0 + 1_000,
			[{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } }],
			"toolUse",
		),
		toolResult("c1", T0 + 3_000),
		assistant(
			T0 + 5_000,
			[{ type: "toolCall", id: "c2", name: "ipython", arguments: { code: "print(2)" } }],
			stopReason,
			errorMessage,
		),
	];

	it("reads four seconds for a turn the owner interrupted, not the hours since its messages", () => {
		const summary = replayedSummary(cutOff("aborted"));
		expectFourSeconds(summary);
		expect(labelOf(summary).status).toBe("stopped");
		// The stopped step is said on its own line once the event is opened; no line carries hours.
		const closed = plain(summary.render(120));
		expect(closed.slice(0, 2)).toEqual(["         │      ", "         │      "]);
		closed.splice(0, 2);
		expect(closed).toHaveLength(1);
		expect(closed[0]?.trimEnd().endsWith("2 步 ▸")).toBe(true);
		expect(summary.activate(summary.getFocusOrder()[0] ?? "")).toBe(true);
		const open = plain(summary.render(120));
		const stopped = open.find((line) => line.includes("你停下了")) ?? "";
		expect(stopped).toContain("■");
		expect(stopped).toContain("print(2)");
		expect(open.join("\n")).not.toMatch(/小时/);
	});

	it("reads four seconds for a turn that ended on a model error too", () => {
		const summary = replayedSummary(cutOff("error", "model gave up"));
		expectFourSeconds(summary);
		expect(labelOf(summary)).toMatchObject({ status: "error", glyph: "✗" });
		// The failure that ended the turn is a red event line of its own, under the event of the step that ran.
		const raw = summary.render(120);
		const lines = plain(raw);
		const failure = lines.findIndex((line) => line.includes("模型出错：model gave up"));
		expect(failure).toBeGreaterThan(0);
		expect(raw[failure]).toContain(theme.getFgAnsi("timelineMust"));
		expect(lines.join("\n")).not.toMatch(/小时/);
	});
});
