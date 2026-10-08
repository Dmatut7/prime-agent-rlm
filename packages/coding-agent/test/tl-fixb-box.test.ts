import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineRow } from "../src/modes/interactive/components/timeline-gutter.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { BOX_FOCUS_MARKER } from "../src/modes/interactive/components/turn-box.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

/**
 * Small display details of the timeline box: Ctrl+T opens and closes the thoughts,
 * `全部 ›` has a way back, and a row with nothing on its right uses the whole width.
 */

const T0 = 1_700_000_000_000;

function assistant(
	at: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
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
		timestamp: at,
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

function newTurn() {
	const state = new TurnActivityState(T0);
	state.modelId = "glm-5.3-prime";
	const summary = new TurnSummaryComponent(state);
	summary.setTimelineHost(host());
	summary.setQuiet(true);
	return { state, summary, render: (width = 100) => plain(summary.render(width)) };
}

type Turn = ReturnType<typeof newTurn>;

/** A finished turn: an optional thought, one sentence, then `commands` commands: one event of that many steps. */
function finishedTurn(commands: number, options: { thought?: boolean } = {}): Turn {
	const turn = newTurn();
	const { state } = turn;
	const ids = Array.from({ length: commands }, (_, index) => `c${index + 1}`);
	state.timeline.noteMessage(
		assistant(T0, [
			...(options.thought === false ? [] : [{ type: "thinking" as const, thinking: "先想第一步。再想第二步。" }]),
			{ type: "text", text: "我跑几条命令。" },
			...ids.map((id, index) => ({
				type: "toolCall" as const,
				id,
				name: "ipython",
				arguments: { code: `await bash('cmd${index + 1}')` },
			})),
		]),
		true,
	);
	ids.forEach((id, index) => {
		const args = { code: `await bash('cmd${index + 1}')` };
		state.addStep({ toolCallId: id, toolName: "ipython", args, status: "queued" });
		state.setStepStatus(id, "running", T0 + (index + 1) * 1_000);
		state.setStepStatus(id, "done", T0 + (index + 1) * 1_000 + 500);
	});
	state.markTurnEnded(T0 + 10_000);
	state.finishBox(T0 + 10_000);
	return turn;
}

/** The event's key: focus targets exist once the box has been drawn. */
function eventKeyOf(turn: Turn): string {
	turn.render();
	const key = turn.summary.getFocusOrder().find((entry) => entry.startsWith("ev:"));
	expect(key).toBeDefined();
	return key ?? "";
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
});

describe("Ctrl+T on a turn's thinking rows", () => {
	it("opens the thoughts, closes them, and opens them again", () => {
		setMotionReduced(true);
		const turn = finishedTurn(4);
		const folded = turn.render();
		expect(folded.join("\n")).not.toContain("思考");
		expect(folded.join("\n")).toContain("5 步 ▸");

		turn.summary.toggleThinkingRows();
		const opened = turn.render();
		expect(opened.join("\n")).toContain("思考了 先想第一步");

		turn.summary.toggleThinkingRows();
		const closed = turn.render();
		expect(closed.join("\n")).not.toContain("思考");
		expect(closed).toEqual(folded);

		turn.summary.toggleThinkingRows();
		expect(turn.render()).toEqual(opened);
	});

	it("leaves an event the owner had opened by hand open when the thoughts close", () => {
		setMotionReduced(true);
		const turn = finishedTurn(4);
		expect(turn.summary.activate(eventKeyOf(turn))).toBe(true);
		const byHand = turn.render();
		expect(byHand.join("\n")).toContain("cmd1");
		expect(byHand.join("\n")).toContain("思考了 先想第一步");

		turn.summary.toggleThinkingRows();
		turn.summary.toggleThinkingRows();
		expect(turn.render()).toEqual(byHand);
	});
});

describe("全部 › and its way back", () => {
	it("draws ▴ 收起 under the last of the steps once all are listed, and a click on it folds the list back", () => {
		setMotionReduced(true);
		const turn = finishedTurn(6, { thought: false });
		const eventKey = eventKeyOf(turn);
		turn.summary.activate(eventKey);
		const threeSteps = turn.render();
		expect(threeSteps.join("\n")).toContain("全部 ›");
		expect(threeSteps.join("\n")).not.toContain("收起");

		const allKey = `all:${eventKey}`;
		expect(turn.summary.activate(allKey)).toBe(true);
		const all = turn.render();
		expect(all.filter((line) => /cmd\d/.test(line))).toHaveLength(6);
		expect(all.join("\n")).not.toContain("全部 ›");
		const backAt = all.findIndex((line) => line.includes("收起"));
		expect(all.filter((line) => line.includes("收起"))).toHaveLength(1);
		const lastCmd = all.map((line) => /cmd\d/.test(line)).lastIndexOf(true);
		expect(backAt).toBe(lastCmd + 1);
		expect(all[backAt]?.trimEnd().endsWith("▴ 收起")).toBe(true);
		expect(turn.summary.getFocusOrder()).toContain(allKey);

		const region = turn.summary.getClickRegions().find((entry) => entry.line === backAt);
		expect(region).toBeDefined();
		region?.onClick({ row: 0, col: 0 });
		expect(turn.render()).toEqual(threeSteps);
	});

	it("is a stop of the keyboard walk: the focus mark sits on the ▴ 收起 line", () => {
		setMotionReduced(true);
		const turn = finishedTurn(6, { thought: false });
		const eventKey = eventKeyOf(turn);
		turn.summary.activate(eventKey);
		turn.render();
		expect(turn.summary.activate(`all:${eventKey}`)).toBe(true);
		turn.render();
		expect(turn.summary.getFocusOrder().at(-1)).toBe(`all:${eventKey}`);
		const ui = turn.state.timeline.ui;
		ui.focused = true;
		ui.focusKey = `all:${eventKey}`;
		ui.bump();
		const marked = turn.summary.render(100).filter((line) => line.includes(BOX_FOCUS_MARKER));
		expect(marked).toHaveLength(1);
		expect(plain(marked)[0]).toContain("▴ 收起");
	});

	it("takes Enter the same way, and names it 全部 then 收起", () => {
		setMotionReduced(true);
		const turn = finishedTurn(6, { thought: false });
		const eventKey = eventKeyOf(turn);
		turn.summary.activate(eventKey);
		const allKey = `all:${eventKey}`;
		const threeSteps = turn.render();
		expect(turn.summary.enterLabel(allKey)).toBe("全部");
		turn.summary.activate(allKey);
		turn.render();
		expect(turn.summary.enterLabel(allKey)).toBe("收起");
		turn.summary.activate(allKey);
		expect(turn.render()).toEqual(threeSteps);
		expect(turn.summary.enterLabel(allKey)).toBe("全部");
	});

	it("draws neither for an event whose steps all fit in the first three", () => {
		setMotionReduced(true);
		const turn = finishedTurn(2, { thought: false });
		turn.summary.activate(eventKeyOf(turn));
		const lines = turn.render();
		expect(lines.filter((line) => /cmd\d/.test(line))).toHaveLength(2);
		expect(lines.join("\n")).not.toContain("全部");
		expect(lines.join("\n")).not.toContain("收起");
	});
});

describe("a row with nothing on its right", () => {
	const content = "x".repeat(200);

	it("gives its content the whole width, whether right is empty, blanks, or blanks in a color", () => {
		const widths = [20, 30, 40, 60, 80, 100];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const bare = stripAnsi(timelineRow({ main: "rail" }, content, "", width));
			expect(visibleWidth(bare), `width ${width}`).toBe(width);
			for (const blank of ["  ", "    ", theme.fg("timelineFaint", ""), `${theme.fg("timelineFaint", "")}  `]) {
				const row = stripAnsi(timelineRow({ main: "rail" }, content, blank, width));
				expect(row, `width ${width} right ${JSON.stringify(blank)}`).toBe(bare);
			}
		}
	});

	it("still keeps the columns of a right side that says something", () => {
		const row = stripAnsi(timelineRow({ main: "rail" }, content, "✓ 21秒  ", 80));
		expect(visibleWidth(row)).toBe(80);
		expect(row.slice(16)).toMatch(/^x+…? +✓ 21秒 {2}$/u);
	});

	it("draws a step with no result, such as a file read, out to the last column", () => {
		setMotionReduced(true);
		const width = 60;
		const turn = newTurn();
		const { state } = turn;
		const path = `/work/app/${"deep/".repeat(20)}file.ts`;
		state.timeline.noteMessage(
			assistant(T0, [
				{ type: "text", text: "读一个文件。" },
				{ type: "toolCall", id: "r1", name: "ipython", arguments: { code: "print(open(p).read())" } },
			]),
			true,
		);
		state.addStep({ toolCallId: "r1", toolName: "ipython", args: {}, status: "queued" });
		state.setStepStatus("r1", "running", T0 + 1_000);
		state.timeline.mergeStep(
			"r1",
			"ipython",
			{},
			{ details: { activities: [{ id: "1", kind: "read", label: path, status: "ok", startedAt: T0 + 1_000 }] } },
			false,
		);
		state.setStepStatus("r1", "done", T0 + 1_100);
		state.markTurnEnded(T0 + 10_000);
		state.finishBox(T0 + 10_000);
		turn.summary.activate(eventKeyOf(turn));
		const rows = turn.render(width).filter((line) => line.includes("│") && line.includes("✓") && line.includes("…"));
		expect(rows).toHaveLength(1);
		expect(visibleWidth((rows[0] ?? "").trimEnd())).toBe(width);
	});
});
