import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import {
	addCommand,
	addStep,
	hasBg,
	plain,
	type QuietTurn,
	quietTurn,
	rawLineWith,
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
