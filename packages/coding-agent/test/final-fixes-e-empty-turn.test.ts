import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { formatTimelineTime } from "../src/modes/interactive/components/timeline-gutter.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { type BoxHeader, computeBoxHeader } from "../src/modes/interactive/components/turn-box.js";
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

function host(): TimelineHost {
	return {
		cwd: () => "/work/app",
		viewportRows: () => 40,
		openWhileWorking: () => true,
		autoFold: () => true,
		requestRender: vi.fn(),
	};
}

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

/** The finished box of a turn made of `replies`, as the timeline sees them. */
function finishedBox(replies: AssistantMessage[], options: { errorEnded?: boolean } = {}) {
	const state = new TurnActivityState(T0);
	state.modelId = "glm-5.3-prime";
	const summary = new TurnSummaryComponent(state);
	summary.setTimelineHost(host());
	summary.setQuiet(true);
	for (const reply of replies) state.timeline.noteMessage(reply, true);
	state.timeline.errorEnded = options.errorEnded === true;
	state.markTurnEnded(T0 + 5_000);
	return summary;
}

/**
 * How the turn's facts sum up a finished turn. The timeline draws no summary line of a finished turn, but
 * what it says (`想了 1 次`, `直接回答了`, `（这轮没有输出）`) is what the live tail falls back to and what stays worked out.
 */
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

/** A finished turn the timeline draws nothing of: no line, and nothing for the keyboard to walk. */
function expectNothingDrawn(summary: TurnSummaryComponent): void {
	expect(plain(summary.render(120))).toEqual([]);
	expect(summary.getFocusOrder()).toEqual([]);
	expect(summary.getClickRegions()).toHaveLength(0);
}

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

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

describe("a turn that produced nothing says so instead of claiming an answer", () => {
	it("says the turn had no output for a reply with no text, no step and no thought", () => {
		const summary = finishedBox([assistant(T0 + 1_000, [], "length")]);
		expectNothingDrawn(summary);
		expect(summary.state.boxView().facts.noOutput).toBe(true);
		const label = labelOf(summary);
		expect(label).toMatchObject({ status: "done", glyph: "✓", plain: "（这轮没有输出）" });
		expect(label.plain).not.toContain("直接回答了");
	});

	it("counts blank text and a blank thought as nothing too", () => {
		const blank = assistant(
			T0 + 1_000,
			[
				{ type: "thinking", thinking: "  " },
				{ type: "text", text: " \n" },
			],
			"length",
		);
		const summary = finishedBox([blank]);
		expectNothingDrawn(summary);
		expect(summary.state.boxView().facts.noOutput).toBe(true);
		expect(labelOf(summary).plain).toContain("（这轮没有输出）");
		expect(labelOf(summary).plain).not.toContain("直接回答了");
	});

	it("says it on a replayed session, whose facts are worked out again from its messages", () => {
		const summary = replayedSummary([
			{ role: "user", content: "在吗", timestamp: T0 },
			assistant(T0 + 1_000, [], "length"),
		]);
		expectNothingDrawn(summary);
		expect(summary.state.boxView().facts.noOutput).toBe(true);
		expect(labelOf(summary).plain).toContain("（这轮没有输出）");
	});
});

describe("a turn that did say something keeps its wording", () => {
	/** A plain answer is drawn by the answer's own lane, not by the timeline: nothing of it is drawn here. */
	function expectAnsweredDirectly(summary: TurnSummaryComponent): void {
		expectNothingDrawn(summary);
		expect(summary.state.boxView().facts.noOutput).toBeUndefined();
		const label = labelOf(summary);
		expect(label).toMatchObject({ status: "done", glyph: "✓", plain: "直接回答了" });
		expect(label.plain).not.toContain("这轮没有输出");
	}

	it("still says the turn answered directly for a plain text reply", () => {
		expectAnsweredDirectly(
			finishedBox([assistant(T0 + 1_000, [{ type: "text", text: "好的，已经改好了。" }], "stop")]),
		);
	});

	it("still says it on a replayed plain text reply", () => {
		expectAnsweredDirectly(
			replayedSummary([
				{ role: "user", content: "在吗", timestamp: T0 },
				assistant(T0 + 1_000, [{ type: "text", text: "在的。" }], "stop"),
			]),
		);
	});

	it("counts an empty reply followed by a text reply of the same turn as an answer", () => {
		expectAnsweredDirectly(
			finishedBox([
				assistant(T0 + 1_000, [], "length"),
				assistant(T0 + 2_000, [{ type: "text", text: "换个说法重答一遍。" }], "stop"),
			]),
		);
	});

	it("counts a text reply followed by an empty reply of the same turn as an answer too", () => {
		expectAnsweredDirectly(
			finishedBox([
				assistant(T0 + 1_000, [{ type: "text", text: "先答一句。" }], "stop"),
				assistant(T0 + 2_000, [], "length"),
			]),
		);
	});

	it("keeps counting a thought that has text as a thought, on an event line of its own", () => {
		const summary = finishedBox([
			assistant(T0 + 1_000, [{ type: "thinking", thinking: "先想一想。再想一想。" }], "length"),
		]);
		const lines = plain(summary.render(120));
		expect(lines).toHaveLength(1);
		expect(lines[0]?.startsWith(` ${formatTimelineTime(T0 + 1_000)}   ◆`)).toBe(true);
		expect(lines[0]).toContain("想了 1 次");
		expect(lines[0]?.trimEnd().endsWith("1 步 ▸")).toBe(true);
		expect(lines[0]).not.toContain("这轮没有输出");
		expect(lines[0]).not.toContain("直接回答了");
		const label = labelOf(summary);
		expect(label.plain).toContain("想了 1 次");
		expect(label.plain).not.toContain("这轮没有输出");
		expect(label.plain).not.toContain("直接回答了");
	});

	it("leaves a turn that ended on a model error to its error line", () => {
		const summary = finishedBox([assistant(T0 + 1_000, [], "error", "接口超时")], { errorEnded: true });
		const label = labelOf(summary);
		expect(label).toMatchObject({ status: "error", glyph: "✗", plain: "1 处出错" });
		expect(label.plain).not.toContain("这轮没有输出");
		expect(label.plain).not.toContain("直接回答了");
		// The failure that ended the turn is a red event line of its own, whatever the turn's steps are.
		const raw = summary.render(120);
		const lines = plain(raw);
		expect(lines).toHaveLength(1);
		expect(lines[0]?.startsWith(` ${formatTimelineTime(T0 + 1_000)}   ◆`)).toBe(true);
		expect(lines[0]).toContain("模型出错：接口超时");
		expect(lines[0]?.trimEnd().endsWith("▸")).toBe(true);
		expect(raw[0]).toContain(theme.getFgAnsi("timelineMust"));
		// Opening it says why.
		expect(summary.activate(summary.getFocusOrder()[0] ?? "")).toBe(true);
		const open = plain(summary.render(120));
		expect(open[0]?.trimEnd().endsWith("▴")).toBe(true);
		expect(open[1]).toContain("接口超时");
	});
});
