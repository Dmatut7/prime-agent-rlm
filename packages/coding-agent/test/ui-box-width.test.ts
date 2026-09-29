import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addCommand, plain, quietTurn } from "./ui-blocks-helpers.js";

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
});

/** A turn with one command, still running (its lines end on the spinner). */
function boxedTurn() {
	setMotionReduced(true);
	const turn = quietTurn({ live: false });
	addCommand(turn, "c1", "git log --stat -100", { detail: "100 次提交" });
	return turn;
}

/** The same turn once it ended: its lines are the event alone. */
function endedTurn() {
	const turn = boxedTurn();
	turn.state.markTurnEnded(Date.now());
	return turn;
}

describe("the timeline fills the terminal's width", () => {
	it("draws every line that has a right side as wide as the terminal, past 120 columns", () => {
		const widths = [80, 120, 121, 160, 200];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const running = boxedTurn().summary.render(width);
			const ended = endedTurn().summary.render(width);
			expect(ended, `ended lines at ${width}`).toHaveLength(1);
			// Event line, one blank rail row, spinner line.
			expect(running, `running lines at ${width}`).toHaveLength(3);
			for (const [name, lines] of [
				["running", running],
				["ended", ended],
			] as const) {
				const shown = plain(lines);
				// Line 0 is the event: no title line above it, no frame around it.
				expect(shown[0], `${name} event at ${width}`).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令 +1 步 ▸ {2}$/);
				expect(visibleWidth(lines[0] ?? ""), `${name} event width at ${width}`).toBe(width);
				expect(shown.join("\n"), `${name} frame at ${width}`).not.toMatch(/[╭╮├┤╰╯]/);
			}
			const shown = plain(running);
			expect(shown[1], `rail row at ${width}`).toBe("         │      ");
			expect(shown[2], `spinner at ${width}`).toMatch(/^ \d\d:\d\d {3}\S {6}等待模型回应… +第 1 步 {2}$/);
			expect(visibleWidth(running[2] ?? ""), `spinner width at ${width}`).toBe(width);
		}
	});

	it("keeps a step's result four columns from the right edge on a wide screen", () => {
		const turn = boxedTurn();
		turn.state.setCollapsed(false);
		const lines = turn.summary.render(200);
		const rows = plain(lines).filter((line) => line.includes("git log --stat -100"));
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row).toMatch(/^ {9}│ {11}\$ {2}git log --stat -100 +✓ 100 次提交 {4}$/);
			expect(visibleWidth(row)).toBe(200);
		}
	});

	it("still draws nothing wider than the terminal at 1 to 4 columns", () => {
		const narrow = [1, 2, 3, 4];
		for (const width of narrow) {
			const turn = boxedTurn();
			const lines = turn.summary.render(width);
			expect(lines.length, `lines at ${width}`).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line), `line width at ${width}`).toBeLessThanOrEqual(width);
			for (const region of turn.summary.getClickRegions()) {
				expect(region.col + region.width, `area on line ${region.line} at ${width}`).toBeLessThanOrEqual(width);
			}
		}
	});
});
