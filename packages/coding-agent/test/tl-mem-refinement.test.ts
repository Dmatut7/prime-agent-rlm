import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRefinementOutcomeMessage } from "../src/core/messages.js";
import type { HarnessEntry, RefinementResult } from "../src/core/refinement/refinement.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import { useTruecolorTheme } from "./ui-blocks-helpers.js";

const AT = new Date(2026, 8, 29, 19, 7, 5).getTime();

let restoreTheme: () => void;
let chalkLevel: typeof chalk.level;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	chalkLevel = chalk.level;
	chalk.level = 3;
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	chalk.level = chalkLevel;
	restoreTheme();
});

afterEach(() => {
	timelineShowAll.set(false);
});

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

function entry(overrides: Partial<HarnessEntry> = {}): HarnessEntry {
	return {
		id: "grow-review",
		kind: "memory",
		title: "grow 批次审查结论",
		content: "范围：16 个提交。\n\n修法：发 0.11.17。",
		path: "memories/grow-review.md",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "refinement",
		created_at: "2026-09-29T00:00:00.000Z",
		updated_at: "2026-09-29T00:00:00.000Z",
		version: 1,
		...overrides,
	};
}

function result(): RefinementResult {
	const after = entry();
	return {
		id: "refine-1",
		summary: "记下审查结论。",
		rationale: "r",
		expectedOutcome: "o",
		appliedEdits: [
			{
				action: "create",
				kind: "memory",
				id: after.id,
				title: after.title,
				content: after.content,
				path: after.path,
				after,
				applied: true,
			},
		],
		harnessStatePath: "/tmp/harness/state.json",
		scope: "local",
	};
}

function component(overrides: Partial<RefinementResult> = {}) {
	return new RefinementOutcomeMessageComponent(
		createRefinementOutcomeMessage({ ...result(), ...overrides }, true, AT),
	);
}

/** The gutter's time, glyph and lane of a note row, then its content and right text, closed to `width`. */
function noteRow(width: number, content: string, right: string, main = "·"): string {
	const head = ` 19:07   ${main}      `;
	const tail = `${right}  `;
	return `${head}${content}${" ".repeat(width - visibleWidth(head) - visibleWidth(content) - visibleWidth(tail))}${tail}`;
}

describe("the background memory tidy on the timeline", () => {
	it("is hidden until the full process is on, and follows the switch without being told", () => {
		const shown = component();
		expect(shown.render(120)).toEqual([]);
		expect(shown.getClickRegions()).toEqual([]);
		timelineShowAll.set(true);
		expect(plain(shown.render(120)).join("\n")).toContain("回合后整理记忆");
		timelineShowAll.set(false);
		expect(shown.render(120)).toEqual([]);
	});

	it("draws `HH:MM · 回合后整理记忆：新记 1 条（本会话）   展开 ▸` on a dim note row under a blank rail row", () => {
		timelineShowAll.set(true);
		const rows = plain(component().render(160));
		expect(rows).toEqual(["         │      ", noteRow(160, "回合后整理记忆：新记 1 条（本会话）", "展开 ▸")]);
	});

	it("paints the note dim, its bullet faint, and turns amber when an edit was not written", () => {
		timelineShowAll.set(true);
		const line = component().render(160)[1] ?? "";
		expect(line).toContain(`${theme.getFgAnsi("timelineFaint")}·`);
		expect(line).toContain(`${theme.getFgAnsi("timelineTime")}回合后整理记忆：新记 1 条（本会话）`);
		const partial = result();
		partial.appliedEdits = [
			...partial.appliedEdits,
			{ ...partial.appliedEdits[0]!, id: "b", title: "B", applied: false, error: "disk full" },
		];
		const amber = component(partial).render(160)[1] ?? "";
		expect(amber).toContain(`${theme.getFgAnsi("timelineFix")}回合后整理记忆：新记 1 条，1 条没写进去（本会话）`);
	});

	it("opens to the memory's title on a ✦ row and its words on the ┃ bar, nothing cut and no `+`", () => {
		timelineShowAll.set(true);
		const opened = component();
		opened.setExpanded(true);
		const rows = plain(opened.render(160));
		expect(rows).toEqual([
			"         │      ",
			noteRow(160, "回合后整理记忆：新记 1 条（本会话）", "收起 ▴"),
			"         │      记下审查结论。",
			"         │      ",
			"         ✦      记住了   grow 批次审查结论",
			"         ┃      范围：16 个提交。",
			"         ┃      ",
			"         ┃      修法：发 0.11.17。",
		]);
	});

	it("says a memory that was not written in the timeline's red", () => {
		timelineShowAll.set(true);
		const partial = result();
		partial.appliedEdits = [{ ...partial.appliedEdits[0]!, applied: false, error: "disk full" }];
		const opened = component(partial);
		opened.setExpanded(true);
		const rows = opened.render(120);
		const failed = rows.find((row) => stripAnsi(row).includes("✗")) ?? "";
		expect(stripAnsi(failed)).toContain("✗ grow 批次审查结论  没写进去：disk full");
		expect(failed).toContain(`${theme.getFgAnsi("timelineMust")}✗`);
	});

	it("changes only colors on hover, and opens with one click", () => {
		timelineShowAll.set(true);
		const note = component();
		const before = note.render(100);
		const region = note.getClickRegions()[0];
		expect(region?.line).toBe(1);
		expect(region?.hoverKey).toBeTypeOf("string");
		region?.onHover?.(true);
		const hovered = note.render(100);
		expect(plain(hovered)).toEqual(plain(before));
		expect(hovered[1]).toContain(theme.getBgAnsi("timelineHoverBg"));
		expect(hovered.map((row) => visibleWidth(row))).toEqual(before.map((row) => visibleWidth(row)));
		expect(note.getClickRegions()[0]).toMatchObject({ line: 1, col: 0, width: 100, height: 1 });
		region?.onHover?.(false);
		expect(note.render(100)).toEqual(before);
		region?.onClick({ row: 0, col: 0 });
		expect(note.isBlockExpanded()).toBe(true);
		expect(plain(note.render(100)).join("\n")).toContain("范围：16 个提交。");
	});

	it("gives each note its own hover key", () => {
		timelineShowAll.set(true);
		const first = component();
		const second = component();
		first.render(80);
		second.render(80);
		expect(first.getClickRegions()[0]?.hoverKey).not.toBe(second.getClickRegions()[0]?.hoverKey);
	});

	it("reads a refiner that produced nothing as a failed tidy, in amber", () => {
		timelineShowAll.set(true);
		const nothing = component({ appliedEdits: [] });
		const row = nothing.render(160)[1] ?? "";
		expect(stripAnsi(row)).toContain("回合后整理记忆：没写进去 · 整理器这次没给出结果，下一轮会再试");
		expect(row).toContain(theme.getFgAnsi("timelineFix"));
		expect(nothing.getClickRegions()).toEqual([]);
	});

	it("never draws a row past the screen's edge", () => {
		timelineShowAll.set(true);
		const opened = component();
		opened.setExpanded(true);
		const widths = Array.from({ length: 40 }, (_, index) => index + 1);
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			for (const row of opened.render(width)) expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width);
		}
	});
});
