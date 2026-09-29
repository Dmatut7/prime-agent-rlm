import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { addCommand, lineIndexWith, plain, quietTurn, useTruecolorTheme } from "./ui-blocks-helpers.js";

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

describe("a hovered block on a narrow terminal keeps its hint", () => {
	it("shows `点开 ▸` at 40, 30 and 24 columns, dropping the result before the hint", () => {
		const widths = [40, 30, 24];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			setMotionReduced(true);
			const turn = quietTurn();
			turn.timeline.upsertSubagent({
				childId: "c1",
				name: "审查员·Go",
				status: "done",
				result: "发现 1 处问题，需要处理",
				report: "报告",
			});
			const lines = turn.summary.render(width);
			const at = lineIndexWith(lines, "◇");
			expect(at, `block at ${width}`).toBeGreaterThan(0);
			const region = turn.summary.getClickRegions().find((entry) => entry.line === at && !entry.passive);
			region?.onHover?.(true);
			const lit = plain(turn.summary.render(width))[at] ?? "";
			expect(lit, `hint at ${width}`).toContain("点开 ▸");
			expect(visibleWidth(lit), `width at ${width}`).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the result next to the hint when both fit", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean", detail: "完成" });
		const lines = turn.summary.render(80);
		const at = lineIndexWith(lines, "$ git status");
		turn.summary
			.getClickRegions()
			.find((entry) => entry.line === at && !entry.passive)
			?.onHover?.(true);
		expect(plain(turn.summary.render(80))[at]).toMatch(/点开 ▸ +✓ 完成 +│$/);
	});
});
