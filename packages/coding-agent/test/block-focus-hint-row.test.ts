import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	BLOCK_REVEAL_MARKER,
	decorateFocusedBlock,
	isVisibleRow,
} from "../src/modes/interactive/components/block-focus.js";
import { timelineRow } from "../src/modes/interactive/components/timeline-gutter.js";
import { addCommand, addSay, plain, quietTurn, useTruecolorTheme } from "./ui-blocks-helpers.js";

/**
 * R3-M15: block navigation and the turn box each picked "the box's first row" their own way - the
 * box by its specs' content, the highlight by what a rendered row shows, gutter included. A box that
 * opens on empty rail rows (every box under a question does) put the key hint on the top rail row
 * while the first event row had already given up its `N 步 ▸` to make room for that hint, so the hint
 * landed on nothing and the step count went missing.
 */

const HINT_WORD = "复制";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => restoreTheme());

/** A finished turn whose box opens on two empty rail rows, as a box under a question does. */
function boxWithLeadingRows(leadingRows: number) {
	const turn = quietTurn({ live: false });
	addSay(turn, "范围定了：16 个提交。", "s1");
	addCommand(turn, "c1", "npm run check", { output: "ok" });
	turn.summary.setLeadingRows(leadingRows);
	turn.state.markTurnEnded(Date.now());
	return turn;
}

describe("the key hint of a focused turn box", () => {
	it("lands on the row that gave up its step count, not on an empty rail row above it", () => {
		const turn = boxWithLeadingRows(2);
		const open = plain(turn.summary.render(100));
		const stepRow = open.findIndex((line) => line.includes("2 步 ▸"));
		expect(stepRow).toBe(2);

		turn.summary.setBlockFocus({ reveal: false, toggleLabel: "展开" });
		const focused = turn.summary.render(100);
		const shown = plain(focused);
		const hintRow = shown.findIndex((line) => line.includes(HINT_WORD));
		// The hint sits on the row that dropped its right side for it, and on nothing else.
		expect(hintRow).toBe(stepRow);
		expect(shown.filter((line) => line.includes(HINT_WORD))).toHaveLength(1);
		expect(shown[0]?.includes(HINT_WORD)).toBe(false);
		// The row keeps its own words; only the step count made way for the hint.
		expect(shown[hintRow]).toContain("范围定了");
		expect(shown[hintRow]).not.toContain("2 步 ▸");
	});

	it("scrolls to the row it highlights: the reveal marker is on that row too", () => {
		const turn = boxWithLeadingRows(2);
		turn.summary.setBlockFocus({ reveal: true, toggleLabel: "展开" });
		const focused = turn.summary.render(100);
		const marked = focused
			.map((line, index) => (line.includes(BLOCK_REVEAL_MARKER) ? index : -1))
			.filter((i) => i >= 0);
		expect(marked).toEqual([plain(focused).findIndex((line) => line.includes(HINT_WORD))]);
	});

	it("shows on a first row that already fills the terminal, cutting that row short", () => {
		const turn = quietTurn({ live: false });
		addSay(turn, "这一句话很长".repeat(10), "s1");
		addCommand(turn, "c1", "npm run check", { output: "ok" });
		turn.state.markTurnEnded(Date.now());
		const open = plain(turn.summary.render(60));
		const stepRow = open.findIndex((line) => line.includes("2 步 ▸"));
		expect(stepRow).toBe(0);

		turn.summary.setBlockFocus({ reveal: false, toggleLabel: "展开" });
		const shown = plain(turn.summary.render(60));
		const hintRow = shown.findIndex((line) => line.includes(HINT_WORD));
		// The hint still lands on the row that gave up its step count, and the row stays inside the width.
		expect(hintRow).toBe(stepRow);
		expect(visibleWidth(shown[hintRow] ?? "")).toBeLessThanOrEqual(60);
		expect(shown[hintRow]).toContain("…");
	});

	it("still lands on the first row of a box with no rail rows above it", () => {
		const turn = boxWithLeadingRows(0);
		const open = plain(turn.summary.render(100));
		expect(open.findIndex((line) => line.includes("2 步 ▸"))).toBe(0);
		turn.summary.setBlockFocus({ reveal: false, toggleLabel: "展开" });
		const shown = plain(turn.summary.render(100));
		expect(shown.findIndex((line) => line.includes(HINT_WORD))).toBe(0);
	});
});

describe("the hint's own width", () => {
	it("keeps a focused row inside the terminal, however narrow, hint or no hint", () => {
		const widths = [12, 20, 28, 40, 60, 100];
		expect(widths.length).toBeGreaterThan(0);
		let hinted = 0;
		for (const width of widths) {
			const row = timelineRow({ main: "ai", time: "14:33" }, "范围定了：16 个提交、96 个文件。", "2 步 ▸", width);
			const painted = decorateFocusedBlock([row], width, { reveal: true, toggleLabel: "展开" });
			expect(painted, `width ${width}`).toHaveLength(1);
			expect(visibleWidth(painted[0] ?? ""), `width ${width}`).toBeLessThanOrEqual(width);
			if (painted[0]?.includes(HINT_WORD)) hinted += 1;
		}
		// The guard is about the narrowest terminals only: a workable width still carries the hint.
		expect(hinted).toBeGreaterThan(0);
	});
});

describe("what a rendered row shows", () => {
	it("counts a row of gutter alone as empty, whatever rails or a clock it carries", () => {
		const turn = boxWithLeadingRows(2);
		addSay(turn, "第二件事。", "s2", Date.now() - 1_000);
		const rows = turn.summary.render(100);
		expect(rows.length).toBeGreaterThan(3);
		// The two leading rail rows are gutter only; the event rows carry words.
		expect(rows.slice(0, 2).every((row) => !isVisibleRow(row))).toBe(true);
		expect(rows.slice(2).some((row) => isVisibleRow(row))).toBe(true);
	});
});
