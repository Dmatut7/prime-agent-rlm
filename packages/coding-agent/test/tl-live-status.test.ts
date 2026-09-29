import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	FooterComponent,
	finishedRunForms,
	formatDoneClock,
	formatLiveClock,
	type StatusBarState,
	workingRunForms,
} from "../src/modes/interactive/components/footer.js";
import { renderSubagentSpendCell } from "../src/modes/interactive/components/subagent-summary-line.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

/**
 * The status line, cell for cell against the Tl2Live / Tl2Done design's last row:
 * `glm-5.3-prime · 思考 最高    上下文 ━━━━━━━━ 12%` on the left, the run's state
 * on the right with two blank columns after it.
 */

const WIDTH = 160;
const MINUTE = 60_000;

function familySpend(): string[] {
	return renderSubagentSpendCell({ cost: 4.2, tokens: 1_000_000, parentCost: 5.6, unpriced: [], partial: false });
}

function bar(state: Partial<StatusBarState> & Pick<StatusBarState, "right">, width = WIDTH): string {
	const footer = new FooterComponent({ getGitBranch: () => null } as never);
	footer.setStatusBarSource(() => ({ model: "glm-5.3-prime", level: "最高", subagents: 0, ...state }));
	return footer.render(width)[0] ?? "";
}

const plain = (text: string): string => stripAnsi(text);

/** The design's `row(left, right)`: the gap between them is spaces, the right text carries its own trailing pair. */
function designRow(left: string, right: string, width = WIDTH): string {
	return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}

describe("the status line while the AI works", () => {
	initTheme("dark");
	const spendCells = familySpend();
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	const working = workingRunForms({
		label: "工作中",
		spinner: "⠹",
		elapsedMs: 10 * MINUTE,
		outputTokens: 180_000,
		stopKey: "Esc",
		spendCells,
	});
	const state: StatusBarState = {
		model: "glm-5.3-prime",
		level: "最高",
		context: { percent: 12, warn: false },
		subagents: 0,
		right: working,
		spendForms: spendCells.length,
	};

	it("reads left ` model · 思考 level    上下文 bar %` and right `⠹ 工作中 10分 · ↓ 180k · 子代理 ¥4.20 · 全部 ¥9.80 · Esc 停止`", () => {
		expect(spendCells.length).toBeGreaterThan(0);
		const left = " glm-5.3-prime · 思考 最高    上下文 ━━━━━━━━ 12%";
		const right = "⠹ 工作中 10分 · ↓ 180k · 子代理 ¥4.20 · 全部 ¥9.80 · Esc 停止  ";
		expect(plain(bar(state))).toBe(designRow(left, right));
	});

	it("paints the whole right side in the live color, the first meter cell in the user color, the rest in the rail color", () => {
		const line = bar(state);
		expect(line).toContain(theme.fg("timelineLive", "⠹ 工作中 10分 · ↓ 180k · 子代理 ¥4.20 · 全部 ¥9.80 · Esc 停止"));
		expect(line).toContain(`${theme.fg("timelineUser", "━")}${theme.fg("timelineRail", "━━━━━━━")}`);
		expect(line).toContain(theme.fg("timelineTime", "glm-5.3-prime · 思考 最高"));
		expect(line).toContain(theme.fg("timelineTime", "上下文"));
		expect(line).toContain(theme.fg("timelineTime", "12%"));
	});

	it("says 思考, not 思考强度", () => {
		expect(plain(bar(state))).not.toContain("思考强度");
	});

	it("keeps the amber warning on a meter that is nearly full", () => {
		const line = bar({ ...state, context: { percent: 90, warn: true } });
		expect(line).toContain(theme.fg("warning", "━".repeat(7)));
		expect(line).toContain(theme.fg("warning", "90%"));
	});

	it("puts the place and branch last, and drops them first on a narrow screen", () => {
		const withPlace: StatusBarState = { ...state, location: "~/work/app · main" };
		const wide = plain(bar(withPlace, 200));
		expect(wide).toContain("上下文 ━━━━━━━━ 12%    ~/work/app · main");
		expect(wide.indexOf("~/work/app")).toBeLessThan(wide.indexOf("⠹"));
		const widths = Array.from({ length: 24 }, (_, index) => 200 - index * 6);
		expect(widths.length).toBeGreaterThan(0);
		let placeGone = false;
		for (const width of widths) {
			const text = plain(bar(withPlace, width));
			expect(visibleWidth(text), `width ${width}`).toBeLessThanOrEqual(width);
			if (!text.includes("~/work/app")) {
				placeGone = true;
				// The first width without the place still has the meter and the whole run state.
				if (text.includes("Esc 停止") || text.includes("¥")) {
					expect(text).toContain("上下文 ━━━━━━━━ 12%");
				}
			} else {
				expect(placeGone, `place back at ${width}`).toBe(false);
			}
		}
		expect(placeGone).toBe(true);
	});

	it("drops the spend whole before the clock or the tokens lose anything", () => {
		const widths = Array.from({ length: 40 }, (_, index) => 170 - index * 3);
		expect(widths.length).toBeGreaterThan(0);
		let spendGone = false;
		let stateIntactAfterSpend = false;
		for (const width of widths) {
			const text = plain(bar(state, width));
			expect(visibleWidth(text), `width ${width}`).toBeLessThanOrEqual(width);
			if (text.includes("¥")) {
				expect(spendGone, `spend back at ${width}`).toBe(false);
				expect(text).toContain("工作中 10分 · ↓ 180k");
			} else if (!spendGone) {
				spendGone = true;
				stateIntactAfterSpend = text.includes("工作中 10分 · ↓ 180k") && text.includes("Esc 停止");
			}
		}
		expect(spendGone).toBe(true);
		expect(stateIntactAfterSpend).toBe(true);
	});

	it("builds the ladder without a spend cell and without a stop key", () => {
		const plainForms = workingRunForms({
			label: "整理上下文",
			spinner: "⠹",
			elapsedMs: 45_000,
			outputTokens: 812,
			spendCells: [],
		}).map(plain);
		expect(plainForms).toEqual(["⠹ 整理上下文 45秒 · ↓ 812", "⠹ 整理上下文 45秒"]);
	});
});

describe("the status line when the run is done", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	const spendCells = () => familySpend();

	it("reads `✓ 完成 · 20 分钟 · ↓ 286k` in the dim color, meter untouched", () => {
		const forms = finishedRunForms({
			outcome: "done",
			elapsedMs: 20 * MINUTE,
			outputTokens: 286_000,
			spendCells: [],
		});
		const line = bar({ context: { percent: 14, warn: false }, right: forms });
		const left = " glm-5.3-prime · 思考 最高    上下文 ━━━━━━━━ 14%";
		expect(plain(line)).toBe(designRow(left, "✓ 完成 · 20 分钟 · ↓ 286k  "));
		expect(line).toContain(theme.fg("timelineTime", "✓ 完成 · 20 分钟 · ↓ 286k"));
	});

	it("keeps a stopped or failed run visible in its own words", () => {
		const stopped = finishedRunForms({ outcome: "stopped", elapsedMs: 5_000, outputTokens: 900, spendCells: [] });
		expect(plain(stopped[0] ?? "")).toBe("■ 已停止 · 5 秒 · ↓ 900");
		const failed = finishedRunForms({ outcome: "error", elapsedMs: 90_000, outputTokens: 1_500, spendCells: [] });
		expect(plain(failed[0] ?? "")).toBe("✗ 出错 · 2 分钟 · ↓ 1.5k");
		expect(failed[0]).toContain(theme.fg("error", "✗"));
	});

	it("puts the spend after the tokens and the session total, and gives them up one at a time", () => {
		const forms = finishedRunForms({
			outcome: "done",
			elapsedMs: 20 * MINUTE,
			outputTokens: 286_000,
			sessionTokens: 900_000,
			spendCells: spendCells(),
		}).map(plain);
		expect(forms).toEqual([
			"✓ 完成 · 20 分钟 · ↓ 286k · 本会话 ↓ 900k · 子代理 ¥4.20 · 全部 ¥9.80",
			"✓ 完成 · 20 分钟 · ↓ 286k · 本会话 ↓ 900k · 子代理 ¥4.20",
			"✓ 完成 · 20 分钟 · ↓ 286k · 本会话 ↓ 900k",
			"✓ 完成 · 20 分钟 · ↓ 286k",
			"✓ 完成",
		]);
	});
});

describe("the clocks", () => {
	it("counts a live run in seconds, then whole minutes, then hours", () => {
		expect(formatLiveClock(0)).toBe("0秒");
		expect(formatLiveClock(45_000)).toBe("45秒");
		expect(formatLiveClock(10 * MINUTE)).toBe("10分");
		expect(formatLiveClock(10 * MINUTE + 59_000)).toBe("10分");
		expect(formatLiveClock(65 * MINUTE)).toBe("1小时05分");
	});

	it("rounds a finished run to something a person says out loud", () => {
		expect(formatDoneClock(45_000)).toBe("45 秒");
		expect(formatDoneClock(20 * MINUTE)).toBe("20 分钟");
		expect(formatDoneClock(20 * MINUTE + 40_000)).toBe("21 分钟");
		expect(formatDoneClock(65 * MINUTE)).toBe("1 小时 5 分钟");
		expect(formatDoneClock(120 * MINUTE)).toBe("2 小时");
	});
});
