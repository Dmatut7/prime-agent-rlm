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

function boxedTurn() {
	setMotionReduced(true);
	const turn = quietTurn({ live: false });
	addCommand(turn, "c1", "git log --stat -100", { detail: "100 次提交" });
	return turn;
}

describe("the box fills the terminal's width", () => {
	it("draws every framed line as wide as the terminal, past 120 columns", () => {
		const widths = [80, 120, 121, 160, 200];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const turn = boxedTurn();
			const lines = turn.summary.render(width);
			// Line 0 is the `◆ prime` line; the frame's lines follow it.
			const framed = lines.slice(1);
			expect(framed.length, `framed lines at ${width}`).toBeGreaterThan(0);
			for (const line of framed) expect(visibleWidth(line), `line width at ${width}`).toBe(width);
			expect(plain(framed)[0], `top border at ${width}`).toBe(` ╭${"─".repeat(width - 3)}╮`);
		}
	});

	it("keeps a row's result against the frame's right edge on a wide screen", () => {
		const turn = boxedTurn();
		turn.state.setCollapsed(false);
		const rows = plain(turn.summary.render(200)).filter((line) => line.includes("git log --stat -100"));
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.trimEnd().endsWith("│")).toBe(true);
			expect(row).toMatch(/100 次提交\s+│$/);
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
