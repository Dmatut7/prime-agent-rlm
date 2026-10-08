import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineRow } from "../src/modes/interactive/components/timeline-gutter.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import { assistant, host, plain, type QuietTurn, quietTurn, T0, useTruecolorTheme } from "./ui-blocks-helpers.js";

/**
 * A narrow terminal shortens the right side of a line (`✓ 21秒`, the seconds, the result words)
 * before it takes the words of the line: a step keeps 12 columns of its command, and its glyph
 * never goes.
 */

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
});

beforeEach(() => {
	setMotionReduced(true);
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

const LONG = "npx tsgo --noEmit -p packages/coding-agent/tsconfig.json";

/** An opened event whose one step is the command `label`, which took `tookS` seconds and ended well or badly. */
function turnWithStep(label: string, options: { ok: boolean; tookS: number }): QuietTurn {
	const turn = quietTurn({ host: host({ viewportRows: () => 60 }), startedAt: T0 - 5_000 });
	const code = `await bash(${JSON.stringify(label)})`;
	turn.timeline.noteMessage(
		assistant(T0, [
			{ type: "text", text: "先跑一遍类型检查。" },
			{ type: "toolCall", id: "c1", name: "ipython", arguments: { code } },
		]),
		true,
	);
	turn.state.addStep({ toolCallId: "c1", toolName: "ipython", args: { code }, status: "queued" });
	turn.state.setStepStatus("c1", "running", T0 + 10);
	turn.state.setStepStatus("c1", "done", T0 + 10 + options.tookS * 1000);
	turn.timeline.mergeStep(
		"c1",
		"ipython",
		{},
		{
			details: {
				activities: [
					{
						id: "c1-a",
						kind: "command",
						label,
						status: options.ok ? "ok" : "error",
						detail: options.ok ? "" : "3 failed",
						startedAt: T0 + 10,
						endedAt: T0 + 10 + options.tookS * 1000,
					},
				],
			},
		},
		false,
	);
	turn.summary.render(100);
	for (const key of turn.summary.getFocusOrder()) if (key.startsWith("ev:")) turn.summary.activate(key);
	return turn;
}

/** The lines of the opened event that carry a step (a command `$`). */
const stepLines = (turn: QuietTurn, width: number) =>
	plain(turn.summary.render(width)).filter((line) => /^ {9}│ {11}[$✓✗]/.test(line));

describe("a step line on a narrow terminal", () => {
	it("keeps at least 12 columns of the command at 40, 60 and 80 columns", () => {
		for (const width of [40, 60, 80]) {
			const turn = turnWithStep(LONG, { ok: true, tookS: 21 });
			const lines = stepLines(turn, width);
			expect(lines, `width ${width}`).toHaveLength(1);
			const words = (lines[0] ?? "").replace(/^ {9}│ {11}\$ {2}/, "").replace(/ +✓.*$/, "");
			expect(visibleWidth(words.replace(/…$/, "")), `width ${width}: ${lines[0]}`).toBeGreaterThanOrEqual(12);
			expect(lines[0]).toContain("$  npx tsgo");
			expect(visibleWidth(lines[0] ?? ""), `width ${width}`).toBeLessThanOrEqual(width);
		}
	});

	it("drops the seconds and the result from the right first, and keeps them where the width allows", () => {
		const forty = stepLines(turnWithStep(LONG, { ok: true, tookS: 21 }), 40)[0] ?? "";
		expect(forty).not.toMatch(/21秒/);
		const sixty = stepLines(turnWithStep(LONG, { ok: true, tookS: 21 }), 60)[0] ?? "";
		expect(sixty).toMatch(/✓ 21秒 {2}$/);
		const eighty = stepLines(turnWithStep(LONG, { ok: true, tookS: 21 }), 80)[0] ?? "";
		expect(eighty).toMatch(/✓ 21秒 {2}$/);
	});

	it("aligns the step row's right margin with the event row's (two columns, not four)", () => {
		// timelineRow already ends every right side with two spaces; the step rows
		// added two more of their own, so their right edge sat left of the event's.
		const turn = turnWithStep(LONG, { ok: true, tookS: 21 });
		const lines = plain(turn.summary.render(80));
		const event = lines.find((line) => /▴/.test(line)) ?? "";
		const step = stepLines(turn, 80)[0] ?? "";
		expect(event).toMatch(/▴ {2}$/);
		expect(step).toMatch(/✓ 21秒 {2}$/);
		expect(step).not.toMatch(/ {3,}$/);
	});

	it("keeps a short command whole with its status at 40 columns", () => {
		const line = stepLines(turnWithStep("make", { ok: true, tookS: 21 }), 40)[0] ?? "";
		expect(line).toContain("$  make");
		expect(line).toMatch(/✓/);
	});

	it("keeps a failed step's mark when its words do not fit, and its words when they do", () => {
		const short = stepLines(turnWithStep("make", { ok: false, tookS: 38 }), 40)[0] ?? "";
		expect(short).toContain("$  make");
		expect(short).toMatch(/✗ {2}$/);
		expect(short).not.toMatch(/38秒/);
		const wide = stepLines(turnWithStep("make", { ok: false, tookS: 38 }), 80)[0] ?? "";
		expect(wide).toMatch(/3 失败 +38秒 {2}$/);
	});

	it("never cuts the glyph: it is on the line at every width from 30 up", () => {
		for (const width of [30, 34, 40, 50, 60, 80, 120]) {
			const line = stepLines(turnWithStep(LONG, { ok: true, tookS: 21 }), width)[0];
			expect(line, `width ${width}`).toBeDefined();
		}
	});
});

describe("timelineRow gives the content its columns before the right side", () => {
	const gutter = { main: "rail" } as const;
	const words = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸";
	const twelve = { minContent: 12 };

	it("shortens a right side that would leave the content under 12 columns to its last word", () => {
		const row = plain([timelineRow(gutter, words, "24 步 ▸", 36, twelve)])[0] ?? "";
		expect(row).toContain("一二三四五六七…");
		expect(row).not.toContain("24 步");
		expect(row).toMatch(/… +▸ {2}$/);
	});

	it("drops the right side altogether where even its last word would leave the content under 12 columns", () => {
		const row = plain([timelineRow(gutter, words, "24 步 ▸", 30, twelve)])[0] ?? "";
		expect(row).not.toContain("▸");
		expect(visibleWidth(row)).toBeLessThanOrEqual(30);
		expect(row).toContain("一二三四五六…");
	});

	it("keeps the whole right side where the content still has 12 columns", () => {
		const row = plain([timelineRow(gutter, words, "24 步 ▸", 80, twelve)])[0] ?? "";
		expect(row).toMatch(/24 步 ▸ {2}$/);
	});

	it("falls back to the caller's short form before dropping the right side", () => {
		const row = plain([timelineRow(gutter, words, "✓ 21秒", 36, { ...twelve, short: "✓" })])[0] ?? "";
		expect(row).toMatch(/✓ {2}$/);
		expect(row).not.toContain("21秒");
	});

	it("lets a short content keep its right side even when the room is small", () => {
		const row = plain([timelineRow(gutter, "第 1 件", "1 步 ▸", 40, twelve)])[0] ?? "";
		expect(row).toMatch(/第 1 件 +1 步 ▸ {2}$/);
	});

	it("keeps the old rule for a row that names no minimum: the words give way, the arrow stays", () => {
		const row = plain([timelineRow(gutter, words, "24 步 ▸", 26)])[0] ?? "";
		expect(row).toMatch(/… {2}▸ {2}$/);
	});

	it("the default short form keeps the last word's own color", () => {
		// A right side that is one styled run with a space inside it: cutting at
		// the last space drops the run's opening code, and the word shows in
		// whatever color the row left active.
		const styled = theme.fg("timelineFaint", "24 步 ▸");
		const row = timelineRow(gutter, words, styled, 36, twelve);
		expect(plain([row])[0] ?? "").toMatch(/… +▸ {2}$/);
		// The short form must carry the run's opening color, not borrow whatever
		// color the row left active.
		expect(row).toMatch(/\x1b\[38;[0-9;]+m▸/);
	});
});
