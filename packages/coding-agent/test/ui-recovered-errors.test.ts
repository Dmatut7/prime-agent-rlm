import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { type TurnActivityState, TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { type BoxHeader, computeBoxHeader } from "../src/modes/interactive/components/turn-box.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import {
	addClosingAnswer,
	addCommand,
	addStep,
	assistant,
	hasBg,
	hasFg,
	plain,
	type QuietTurn,
	quietTurn,
	T0,
	text,
	useTruecolorTheme,
} from "./ui-blocks-helpers.js";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
});

const WIDTH = 120;
const ERROR_TEXT = "ModuleNotFoundError: No module named 'nope'";
/** The line a mistake that nobody corrected is drawn as: its own event, with an arrow and no step count. */
const FAIL_LINE = /^ \d\d:\d\d {3}◆ {6}Python 出错：ModuleNotFoundError.* +▸ {2}$/;

function mistake(turn: QuietTurn, id: string, module: string, at: number): void {
	addStep(turn, id, `import ${module}`, "error", at);
	turn.timeline.mergeStep(
		id,
		"ipython",
		{},
		{
			isError: true,
			details: { error: { ename: "ModuleNotFoundError", evalue: `No module named '${module}'`, traceback: [] } },
		},
		false,
	);
}

/** A turn with `count` cells that raised and a command that then went fine, each step a moment after the last. */
function turnWithAMistake(count = 1): QuietTurn {
	const turn = quietTurn({ live: false });
	const start = Date.now() - 6_000;
	for (let index = 1; index <= count; index++) {
		mistake(turn, `x${index}`, index === 1 ? "nope" : `nope${index}`, start + index * 10);
	}
	addCommand(turn, "c1", "pip install nope", { detail: "装好了" });
	// The AI fixed it and said so: that is what makes the mistake a corrected one.
	addClosingAnswer(turn);
	return turn;
}

function finish(turn: QuietTurn): void {
	turn.state.markTurnEnded(Date.now());
	turn.state.finishBox(Date.now());
}

/** What the box header computes for a turn (the live tail's fallback words), from the state alone. */
function headerOf(state: TurnActivityState): BoxHeader {
	const view = state.boxView();
	return computeBoxHeader({
		rows: view.rows,
		facts: view.facts,
		timeline: state.timeline,
		live: view.live,
		phase: "waiting",
		currentThinking: "",
		now: Date.now(),
	});
}

describe("a mistake the turn corrected itself", () => {
	it("stays a step of its event and leaves no red line hanging outside", () => {
		const turn = turnWithAMistake();
		finish(turn);
		const closed = turn.summary.render(WIDTH);
		expect(plain(closed)).toHaveLength(1);
		expect(plain(closed)[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令 +2 步 ▸ {2}$/);
		expect(text(closed)).not.toContain(ERROR_TEXT);
		expect(hasFg(closed[0] ?? "", "timelineMust")).toBe(false);
		const order = turn.summary.getFocusOrder();
		expect(order).toHaveLength(1);
		expect(order[0]?.startsWith("ev:")).toBe(true);
	});

	it("counts it in the facts as `出错 N 次，已改正` in the recovered color, never as a failure", () => {
		const turn = turnWithAMistake();
		finish(turn);
		const facts = turn.state.boxView().facts;
		expect(facts.errorCount).toBe(1);
		expect(facts.errorsRecovered).toBe(true);
		const header = headerOf(turn.state);
		expect(header.status).toBe("done");
		expect(header.plain).toContain("跑了 1 条命令 · 出错 1 次，已改正");
		expect(header.plain).not.toContain("处出错");
		expect(header.parts).toContainEqual({ text: "出错 1 次，已改正", color: "kindRecovered" });
	});

	it("is still in the timeline once the event is opened, as a step marked `下一格改好了`, not red", () => {
		const turn = turnWithAMistake();
		finish(turn);
		turn.summary.render(WIDTH);
		turn.summary.toggleBox();
		const opened = turn.summary.render(WIDTH);
		const at = plain(opened).findIndex((line) => line.includes(ERROR_TEXT));
		expect(at).toBeGreaterThan(0);
		expect(plain(opened)[at]).toMatch(/^ {9}│ {11}✗ {2}Python 出错：ModuleNotFoundError.* +下一格改好了 {4}$/);
		const line = opened[at] ?? "";
		expect(line).toContain(theme.bold(theme.fg("timelineFix", "✗")));
		expect(line).toContain(theme.fg("timelineFix", "下一格改好了"));
		expect(hasFg(line, "timelineMust")).toBe(false);
		expect(hasBg(line, "kindErrorBg")).toBe(false);
	});

	it("counts several mistakes", () => {
		const turn = turnWithAMistake(2);
		finish(turn);
		expect(turn.state.boxView().facts.errorCount).toBe(2);
		expect(headerOf(turn.state).plain).toContain("出错 2 次，已改正");
		turn.summary.render(WIDTH);
		turn.summary.toggleBox();
		const fixed = plain(turn.summary.render(WIDTH)).filter((line) => line.includes("下一格改好了"));
		expect(fixed).toHaveLength(2);
	});
});

describe("a mistake nobody corrected keeps its alarm", () => {
	it("keeps a turn that ended on an error red: the failure is its own line when folded and the count reads 处出错", () => {
		const turn = turnWithAMistake();
		turn.timeline.errorEnded = true;
		finish(turn);
		const closed = turn.summary.render(WIDTH);
		expect(plain(closed)).toHaveLength(2);
		expect(plain(closed)[0]).toMatch(FAIL_LINE);
		expect(closed[0]).toContain(theme.fg("timelineMust", `Python 出错：${ERROR_TEXT}`));
		expect(hasBg(closed[0] ?? "", "kindErrorBg")).toBe(false);
		expect(plain(closed)[1]).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令 +1 步 ▸ {2}$/);
		expect(turn.summary.getFocusOrder().map((key) => key.split(":")[0])).toEqual(["ev", "ev"]);
		expect(turn.summary.getFocusOrder()[0]).toBe("ev:err:x1");
		const header = headerOf(turn.state);
		expect(header.status).toBe("error");
		expect(header.glyph).toBe("✗");
		expect(header.plain).toContain("1 处出错");
		expect(header.plain).not.toContain("已改正");
		expect(header.parts).toContainEqual({ text: "1 处出错", color: "kindError" });
		expect(turn.state.boxView().facts.errorsRecovered).toBeUndefined();
	});

	it("keeps the failure of a turn the owner stopped as its own line, and never calls it corrected", () => {
		const turn = turnWithAMistake();
		turn.timeline.stopped = true;
		finish(turn);
		const closed = turn.summary.render(WIDTH);
		expect(plain(closed)[0]).toMatch(FAIL_LINE);
		expect(closed[0]).toContain(theme.fg("timelineMust", `Python 出错：${ERROR_TEXT}`));
		const header = headerOf(turn.state);
		expect(header.status).toBe("stopped");
		expect(header.plain).not.toContain("已改正");
		expect(turn.state.boxView().facts.errorsRecovered).toBeUndefined();
	});

	it("keeps the error as a step behind `N 步` while the turn still runs, and opens to it", () => {
		const turn = quietTurn();
		mistake(turn, "x1", "nope", Date.now() - 6_000);
		turn.state.setCollapsed(true);
		const closed = turn.summary.render(WIDTH);
		expect(plain(closed)[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}做了 1 步 +1 步 ▸ {2}$/);
		expect(text(closed)).not.toContain(ERROR_TEXT);
		turn.summary.toggleBox();
		const opened = turn.summary.render(WIDTH);
		const at = plain(opened).findIndex((line) => line.includes(ERROR_TEXT));
		expect(at).toBe(1);
		expect(plain(opened)[at]).toMatch(/^ {9}│ {11}✗ {2}Python 出错：ModuleNotFoundError.* +出错了 {4}$/);
		expect(opened[at]).toContain(theme.bold(theme.fg("timelineMust", "✗")));
		expect(opened[at]).toContain(theme.fg("timelineMust", "出错了"));
		expect(hasBg(opened[at] ?? "", "kindErrorBg")).toBe(false);
	});
});

describe("a turn cut off after a failed step corrected nothing", () => {
	const call = (id: string, at: number) =>
		assistant(at, [{ type: "toolCall", id, name: "ipython", arguments: { code: "await bash('false')" } }]);
	const failedResult = (id: string, at: number): ToolResultMessage => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: "command failed exit 1" }],
		isError: true,
		timestamp: at,
	});
	const fixedResult = (id: string, at: number): ToolResultMessage => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: at,
	});

	/** The chat a replay builds from `messages`, and its one turn box. */
	function replayed(messages: AgentMessage[]): TurnSummaryComponent {
		const components = buildConversationComponents(messages, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			cwd: "/work/app",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode: "quiet",
		});
		const summary = components.find((component) => component instanceof TurnSummaryComponent);
		if (!(summary instanceof TurnSummaryComponent)) throw new Error("no turn box");
		return summary;
	}

	const prompt: AgentMessage = { role: "user", content: "跑一下", timestamp: T0 };

	/** The turn's lines without the two empty rows it opens with under the question. */
	function ownLines(summary: TurnSummaryComponent): string[] {
		const lines = summary.render(WIDTH);
		expect(plain(lines.slice(0, 2))).toEqual(["         │      ", "         │      "]);
		return lines.slice(2);
	}
	const FAILED_LINE = /^ \d\d:\d\d {3}◆ {6}运行 false 出错：command failed exit 1 +▸ {2}$/;

	/** The red line of the failure, its count in the header, and what says it was not corrected. */
	function expectAlarm(summary: TurnSummaryComponent, closed: string[]): void {
		const shown = plain(closed);
		expect(shown[0]).toMatch(FAILED_LINE);
		expect(closed[0]).toContain(theme.fg("timelineMust", "运行 false 出错：command failed exit 1"));
		expect(hasBg(closed[0] ?? "", "kindErrorBg")).toBe(false);
		expect(headerOf(summary.state).plain).toContain("1 处出错");
		expect(headerOf(summary.state).plain).not.toContain("已改正");
		expect(summary.state.boxView().facts.errorsRecovered).toBeUndefined();
	}

	it("keeps the red line and the count when the run ended right after the failed step", () => {
		const summary = replayed([prompt, call("t1", T0 + 1_000), failedResult("t1", T0 + 2_000)]);
		const closed = ownLines(summary);
		expect(closed).toHaveLength(1);
		expectAlarm(summary, closed);
	});

	it("keeps the red line when the last reply was cut off by the length limit", () => {
		const summary = replayed([
			prompt,
			call("t1", T0 + 1_000),
			failedResult("t1", T0 + 2_000),
			assistant(T0 + 3_000, [{ type: "text", text: "让我再试" }], "length"),
		]);
		const closed = ownLines(summary);
		expect(closed).toHaveLength(1);
		expectAlarm(summary, closed);
	});

	it("keeps the red line when the failure is followed by a new step and nothing after it", () => {
		const summary = replayed([
			prompt,
			call("t1", T0 + 1_000),
			failedResult("t1", T0 + 2_000),
			call("t2", T0 + 3_000),
			fixedResult("t2", T0 + 4_000),
		]);
		const closed = ownLines(summary);
		expect(closed).toHaveLength(2);
		expectAlarm(summary, closed);
		expect(plain(closed)[1]).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令 +1 步 ▸ {2}$/);
	});

	it("still calls a mistake corrected once the AI fixed it and finished its answer", () => {
		const summary = replayed([
			prompt,
			call("t1", T0 + 1_000),
			failedResult("t1", T0 + 2_000),
			call("t2", T0 + 3_000),
			fixedResult("t2", T0 + 4_000),
			assistant(T0 + 5_000, [{ type: "text", text: "改好了。" }], "stop"),
		]);
		const closed = ownLines(summary);
		expect(headerOf(summary.state).plain).toContain("出错 1 次，已改正");
		expect(summary.state.boxView().facts.errorsRecovered).toBe(true);
		expect(closed).toHaveLength(1);
		expect(plain(closed)[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令 +2 步 ▸ {2}$/);
		expect(text(closed)).not.toContain("command failed exit 1");
		summary.toggleBox();
		const opened = plain(summary.render(WIDTH));
		expect(
			opened.some((line) => /^ {9}│ {11}✗ {2}运行 false 出错：command failed exit 1 +下一格改好了 {4}$/.test(line)),
		).toBe(true);
	});

	it("says the same for a turn watched live: cut off after a step keeps its alarm, a closed answer folds it", () => {
		const cutOff = turnWithAMistake();
		// A live turn whose last message asked for a step and was never answered.
		cutOff.timeline.noteMessage(call("t9", Date.now() - 100), true);
		finish(cutOff);
		expect(headerOf(cutOff.state).plain).not.toContain("已改正");
		expect(cutOff.state.boxView().facts.errorsRecovered).toBeUndefined();
		expect(plain(cutOff.summary.render(WIDTH))[0]).toMatch(FAIL_LINE);

		const closed = turnWithAMistake();
		finish(closed);
		expect(headerOf(closed.state).plain).toContain("已改正");
		expect(text(closed.summary.render(WIDTH))).not.toContain(ERROR_TEXT);
	});
});
