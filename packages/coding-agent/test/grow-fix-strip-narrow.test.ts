import { type ClickRegion, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type SubagentPanelRow,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * However narrow the screen, a block that is drawn says which child it is: at least the first
 * character of its name. A block that cannot say that is left to the `还有 N 个 ›` marker.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const NAMES = ["reviewer-agent-long", "评审代理很长的名字", "🚀 launch-control", "ab"];

function rows(name: string): SubagentPanelRow[] {
	return [
		{ id: "first", name: `${name}-1`, state: "running" },
		{ id: "second", name: `${name}-2`, state: "done" },
		{ id: "third", name: `${name}-3`, state: "failed" },
		{ id: "last", name: `${name}-4`, state: "idle" },
	];
}

function strip(list: readonly SubagentPanelRow[]): SubagentSummaryLine {
	const line = new SubagentSummaryLine();
	line.setSubagentCounts({ total: list.length, running: 1, idle: 1, inactive: 0 });
	line.setSubagentRows(list);
	line.setOpenable(true);
	return line;
}

function chipRegions(line: SubagentSummaryLine): ClickRegion[] {
	return line.getClickRegions().filter((region) => region.hoverKey?.startsWith("subagent-chip:"));
}

/** The plain text a region covers, by terminal columns (a wide character takes two). */
function textAt(plain: string, region: ClickRegion): string {
	let col = 0;
	let out = "";
	for (const { segment } of segmenter.segment(plain)) {
		const width = visibleWidth(segment);
		if (col >= region.col && col + width <= region.col + region.width) out += segment;
		col += width;
	}
	return out;
}

function firstCharOf(name: string): string {
	return [...segmenter.segment(name)][0]?.segment ?? "";
}

/** Scrolls the row to its far end with the wheel, the way an owner with many children reaches the last block. */
function scrollToEnd(line: SubagentSummaryLine, width: number): void {
	line.render(width);
	for (let step = 0; step < 20; step++) {
		const wheel = line.getClickRegions().find((region) => region.onWheel !== undefined);
		if (!wheel?.onWheel?.(1)) break;
		line.render(width);
	}
}

describe("the subagent blocks on a narrow screen", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	for (const paged of [false, true]) {
		it(`every block that is drawn shows the first character of its name, ${paged ? "after paging to the end" : "at the start"}, at every width`, () => {
			let drawn = 0;
			for (const name of NAMES) {
				for (let width = 1; width <= 80; width++) {
					const line = strip(rows(name));
					if (paged) scrollToEnd(line, width);
					const rendered = line.render(width);
					expect(rendered, `${name} at ${width}`).toHaveLength(1);
					expect(visibleWidth(rendered[0] ?? ""), `${name} at ${width}`).toBeLessThanOrEqual(width);
					const text = stripAnsi(rendered[0] ?? "");
					for (const region of chipRegions(line)) {
						const chip = textAt(text, region);
						const child = rows(name).find((candidate) => chip.includes(firstCharOf(candidate.name)));
						expect(child, `${name} at ${width}: "${chip}"`).toBeDefined();
						expect(chip.trim().length, `${name} at ${width}: "${chip}"`).toBeGreaterThan(2);
						drawn += 1;
					}
				}
			}
			expect(drawn).toBeGreaterThan(0);
		});
	}

	it("still draws a block from width 8 on, at the start and at the end of a long row", () => {
		for (const name of NAMES.filter((candidate) => candidate !== "🚀 launch-control")) {
			for (const paged of [false, true]) {
				for (let width = 8; width <= 40; width++) {
					const line = strip(rows(name));
					if (paged) scrollToEnd(line, width);
					line.render(width);
					expect(chipRegions(line).length, `${name} paged=${paged} at ${width}`).toBeGreaterThan(0);
				}
			}
		}
	});

	it("gives a block at 24 columns its name before its state word, after the row scrolled", () => {
		const line = strip([
			{ id: "a", name: "reviewer-agent-long", state: "running" },
			{ id: "b", name: "second-child-with-a-long-name", state: "running" },
			{ id: "c", name: "third-child-with-a-long-name", state: "running" },
		]);
		scrollToEnd(line, 24);
		const text = stripAnsi(line.render(24)[0] ?? "");
		expect(text).toMatch(/‹ 还有 \d+ 个/);
		expect(text).toMatch(/◇ third-/);
	});
});
