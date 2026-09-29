import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import { addCommand, addSay, plain, quietTurn, useTruecolorTheme } from "./ui-blocks-helpers.js";

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

describe("a hovered line on a narrow terminal keeps its arrow", () => {
	function dispatchTurn() {
		setMotionReduced(true);
		const turn = quietTurn();
		addSay(turn, "派审查员去看 Go 代码，回来告诉我结果。", "s1");
		turn.timeline.upsertSubagent({
			childId: "c1",
			name: "审查员·Go",
			status: "done",
			result: "发现 1 处问题，需要处理",
			report: "报告",
		});
		return turn;
	}

	it("keeps `1 步 ▸` at 40, 30 and 26 columns, cutting the words before the count", () => {
		// At 26 columns the count and the arrow take everything the words had.
		const widths = [
			{ width: 40, cut: /^ \d\d:\d\d {3}◆ {6}派审查员去看 …/ },
			{ width: 30, cut: /^ \d\d:\d\d {3}◆ {6}派…/ },
			{ width: 26, cut: /^ \d\d:\d\d {3}◆ +1 步 ▸ {2}$/ },
		];
		expect(widths.length).toBeGreaterThan(0);
		for (const { width, cut } of widths) {
			const turn = dispatchTurn();
			const lines = turn.summary.render(width);
			const at = plain(lines).findIndex((line) => line.includes("◆"));
			expect(at, `event at ${width}`).toBe(0);
			// The dispatch under the event is not a target: the event line is the only one.
			expect(turn.summary.getFocusOrder(), `targets at ${width}`).toHaveLength(1);
			const region = turn.summary.getClickRegions().find((entry) => entry.line === at && !entry.passive);
			expect(region, `area at ${width}`).toBeDefined();
			expect(region?.width, `area width at ${width}`).toBe(width);
			region?.onHover?.(true);
			const litRaw = turn.summary.render(width)[at] ?? "";
			const lit = plain([litRaw])[0] ?? "";
			expect(lit, `arrow at ${width}`).toMatch(/1 步 ▸ {2}$/);
			// The words give way first.
			expect(lit, `words at ${width}`).toMatch(cut);
			expect(lit, `words at ${width}`).not.toContain("回来告诉我结果");
			expect(visibleWidth(litRaw), `width at ${width}`).toBe(width);
			expect(litRaw.startsWith(theme.getBgAnsi("timelineHoverBg")), `hover paint at ${width}`).toBe(true);
		}
	});

	it("still paints the whole line on hover at 25 and 24 columns, where the arrow stays and the words give way", () => {
		const widths = [25, 24];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const turn = dispatchTurn();
			const before = turn.summary.render(width);
			expect(visibleWidth(before[0] ?? ""), `line before hover at ${width}`).toBeLessThanOrEqual(width);
			const region = turn.summary.getClickRegions().find((entry) => entry.line === 0 && !entry.passive);
			expect(region?.width, `area width at ${width}`).toBe(width);
			region?.onHover?.(true);
			const litRaw = turn.summary.render(width)[0] ?? "";
			expect(visibleWidth(litRaw), `width at ${width}`).toBe(width);
			expect(litRaw.startsWith(theme.getBgAnsi("timelineHoverBg")), `hover paint at ${width}`).toBe(true);
			expect(plain([litRaw])[0], `words at ${width}`).toMatch(/^ \d\d:\d\d {3}◆ {6}派…\s+▸ {2}$/);
			// Clicking the cut line still opens it.
			region?.onClick({ line: 0, col: 0 } as never);
			expect(turn.state.boxOpen, `opened at ${width}`).toBe(true);
		}
	});

	it("keeps the result at the right edge of a hovered step, with the whole line painted", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean", detail: "完成" });
		turn.state.setCollapsed(false);
		const lines = turn.summary.render(80);
		const at = plain(lines).findIndex((line) => line.includes("$  git status"));
		expect(at).toBe(1);
		turn.summary
			.getClickRegions()
			.find((entry) => entry.line === at && !entry.passive)
			?.onHover?.(true);
		const litRaw = turn.summary.render(80)[at] ?? "";
		expect(plain([litRaw])[0]).toMatch(/^ {9}│ {11}\$ {2}git status +✓ 完成 {4}$/);
		expect(visibleWidth(litRaw)).toBe(80);
		expect(litRaw.startsWith(theme.getBgAnsi("timelineHoverBg"))).toBe(true);
	});
});
