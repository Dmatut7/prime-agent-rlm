import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import {
	addClosingAnswer,
	addCommand,
	addStep,
	assistant,
	hasBg,
	plain,
	type QuietTurn,
	quietTurn,
	rawLineWith,
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

afterEach(() => {
	setMotionReduced(false);
});

const WIDTH = 120;
const ERROR_TEXT = "ModuleNotFoundError: No module named 'nope'";

/** A turn with one cell that raised and a command that then went fine. */
function turnWithAMistake(): QuietTurn {
	setMotionReduced(true);
	const turn = quietTurn({ live: false });
	addStep(turn, "x1", "import nope", "error");
	turn.timeline.mergeStep(
		"x1",
		"ipython",
		{},
		{
			isError: true,
			details: { error: { ename: "ModuleNotFoundError", evalue: "No module named 'nope'", traceback: [] } },
		},
		false,
	);
	addCommand(turn, "c1", "pip install nope", { detail: "装好了" });
	// The AI fixed it and said so: that is what makes the mistake a corrected one.
	addClosingAnswer(turn);
	return turn;
}

function finish(turn: QuietTurn): void {
	turn.state.markTurnEnded(Date.now());
	turn.state.finishBox(Date.now());
}

const headerLine = (turn: QuietTurn) => plain(turn.summary.render(WIDTH))[2] ?? "";

describe("a mistake the turn corrected itself", () => {
	it("goes into the box header as `出错 N 次，已改正` in the recovered color, and leaves no red row hanging outside", () => {
		const turn = turnWithAMistake();
		finish(turn);
		const closed = turn.summary.render(WIDTH);
		expect(headerLine(turn)).toContain("跑了 1 条命令 · 出错 1 次，已改正");
		expect(headerLine(turn)).not.toContain("处出错");
		expect(closed[2]).toContain(theme.fg("kindRecovered", "出错 1 次，已改正"));
		expect(text(closed)).not.toContain(ERROR_TEXT);
		expect(turn.summary.getFocusOrder()).toEqual(["header"]);
	});

	it("is still in the timeline once the box is opened, as a red block", () => {
		const turn = turnWithAMistake();
		finish(turn);
		turn.summary.render(WIDTH);
		turn.summary.toggleBox();
		const opened = turn.summary.render(WIDTH);
		expect(text(opened)).toContain(ERROR_TEXT);
		expect(hasBg(rawLineWith(opened, ERROR_TEXT), "kindErrorBg")).toBe(true);
	});

	it("counts several mistakes", () => {
		const turn = turnWithAMistake();
		addStep(turn, "x2", "import nope2", "error");
		turn.timeline.mergeStep(
			"x2",
			"ipython",
			{},
			{
				isError: true,
				details: { error: { ename: "ModuleNotFoundError", evalue: "No module named 'nope2'", traceback: [] } },
			},
			false,
		);
		finish(turn);
		expect(headerLine(turn)).toContain("出错 2 次，已改正");
	});
});

describe("a mistake nobody corrected keeps its alarm", () => {
	it("keeps a turn that ended on an error red: the row stays out when folded and the header counts it", () => {
		const turn = turnWithAMistake();
		turn.timeline.errorEnded = true;
		finish(turn);
		const closed = turn.summary.render(WIDTH);
		expect(headerLine(turn)).toContain("✗ ");
		expect(headerLine(turn)).toContain("1 处出错");
		expect(headerLine(turn)).not.toContain("已改正");
		expect(text(closed)).toContain(ERROR_TEXT);
		expect(hasBg(rawLineWith(closed, ERROR_TEXT), "kindErrorBg")).toBe(true);
	});

	it("keeps the row of a turn the owner stopped only when the step really failed", () => {
		const turn = turnWithAMistake();
		turn.timeline.stopped = true;
		finish(turn);
		expect(headerLine(turn)).not.toContain("已改正");
	});

	it("keeps the row while the turn still runs", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addStep(turn, "x1", "import nope", "error");
		turn.timeline.mergeStep(
			"x1",
			"ipython",
			{},
			{
				isError: true,
				details: { error: { ename: "ModuleNotFoundError", evalue: "No module named 'nope'", traceback: [] } },
			},
			false,
		);
		turn.state.setCollapsed(true);
		expect(text(turn.summary.render(WIDTH))).toContain(ERROR_TEXT);
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
		setMotionReduced(true);
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

	it("keeps the red row and the count when the run ended right after the failed step", () => {
		const summary = replayed([prompt, call("t1", T0 + 1_000), failedResult("t1", T0 + 2_000)]);
		const closed = summary.render(WIDTH);
		expect(plain(closed)[2]).toContain("1 处出错");
		expect(plain(closed)[2]).not.toContain("已改正");
		expect(text(closed)).toContain("command failed exit 1");
		expect(hasBg(rawLineWith(closed, "command failed exit 1"), "kindErrorBg")).toBe(true);
	});

	it("keeps the red row when the last reply was cut off by the length limit", () => {
		const summary = replayed([
			prompt,
			call("t1", T0 + 1_000),
			failedResult("t1", T0 + 2_000),
			assistant(T0 + 3_000, [{ type: "text", text: "让我再试" }], "length"),
		]);
		const closed = summary.render(WIDTH);
		expect(plain(closed)[2]).toContain("1 处出错");
		expect(plain(closed)[2]).not.toContain("已改正");
		expect(text(closed)).toContain("command failed exit 1");
	});

	it("keeps the red row when the failure is followed by a new step and nothing after it", () => {
		const summary = replayed([
			prompt,
			call("t1", T0 + 1_000),
			failedResult("t1", T0 + 2_000),
			call("t2", T0 + 3_000),
			fixedResult("t2", T0 + 4_000),
		]);
		const closed = summary.render(WIDTH);
		expect(plain(closed)[2]).toContain("1 处出错");
		expect(plain(closed)[2]).not.toContain("已改正");
		expect(text(closed)).toContain("command failed exit 1");
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
		const closed = summary.render(WIDTH);
		expect(plain(closed)[2]).toContain("出错 1 次，已改正");
		expect(text(closed)).not.toContain("command failed exit 1");
	});

	it("says the same for a turn watched live: cut off after a step keeps its alarm, a closed answer folds it", () => {
		setMotionReduced(true);
		const cutOff = turnWithAMistake();
		// A live turn whose last message asked for a step and was never answered.
		cutOff.timeline.noteMessage(call("t9", Date.now() - 100), true);
		finish(cutOff);
		expect(headerLine(cutOff)).not.toContain("已改正");

		const closed = turnWithAMistake();
		finish(closed);
		expect(headerLine(closed)).toContain("已改正");
	});
});
