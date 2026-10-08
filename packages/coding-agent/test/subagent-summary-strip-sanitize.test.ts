import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type SubagentPanelRow,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import { useTruecolorTheme } from "./ui-blocks-helpers.js";

/**
 * The subagent strip is a dock row that repaints every second and builds its own
 * styled line: the child names and task tags it draws come from a child's session
 * name and task brief, which a model (or a page it read) writes. These are the
 * vectors that reach it - a clipboard write, a screen clear, a bell, a hyperlink,
 * a newline that turns one row into two, and a name carrying the `": "` a stall
 * marker used to be split on.
 */
const OSC52 = "\u001b]52;c;cGFzdGU=\u0007";
const CLEAR = "\u001b[2J\u001b[H";
const BEL = "\u0007";
const HYPERLINK = "\u001b]8;;http://evil.example\u0007";

function strip(rows: readonly SubagentPanelRow[]): SubagentSummaryLine {
	const line = new SubagentSummaryLine();
	line.setSubagentCounts({ total: rows.length, running: rows.length, idle: 0, inactive: 0 });
	line.setSubagentRows(rows);
	line.setOpenable(true);
	return line;
}

const plain = (lines: readonly string[]): string => stripAnsi(lines.join("\n"));
const count = (text: string, needle: string): number => text.split(needle).length - 1;
/** The opening escape of a background token, without its closing `49`: how a block's paint is counted. */
function bgOpen(token: "kindSubagentBg" | "kindErrorBg"): string {
	const painted = theme.bg(token, "");
	return painted.slice(0, painted.indexOf("\u001b[49m"));
}

describe("the subagent strip's one row", () => {
	const chalkLevel = chalk.level;
	let restoreTheme: () => void;
	beforeAll(() => {
		// Bold and underline come from chalk, which is off without a terminal.
		chalk.level = 3;
		restoreTheme = useTruecolorTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterAll(() => {
		chalk.level = chalkLevel;
		restoreTheme();
	});

	it("keeps one block for a stalled child whose name carries ': '", () => {
		const line = strip([{ id: "c1", name: "lane: review", state: "stalled" }]);
		const rendered = line.render(120);
		expect(rendered).toHaveLength(1);
		const text = plain(rendered);
		// One child, one block, one 卡住: the state word says the stall on the block itself.
		expect(text).toContain(" ◇ lane: review ⚠ 卡住 ");
		expect(count(text, "lane")).toBe(1);
		expect(count(text, "卡住")).toBe(1);
		expect(count(rendered[0] ?? "", bgOpen("kindErrorBg"))).toBe(0);
	});

	it("keeps one physical row when a task tag carries a newline", () => {
		const line = strip([{ id: "c1", name: "worker", state: "running", tag: "review\nsecond row" }]);
		const rendered = line.render(120);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).not.toContain("\n");
		expect(plain(rendered)).toContain(" ◇ worker review second row 回答中 ");
	});

	it("keeps one physical row when a name carries a newline", () => {
		// Two children that shorten to the same letter each keep their own name, so the
		// chip draws the name as the snapshot spelled it - newline included, unless washed.
		const line = strip([
			{ id: "c1", name: "rev-A-one\nsecond", state: "running" },
			{ id: "c2", name: "rev-A-two", state: "running" },
		]);
		const rendered = line.render(120);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).not.toContain("\n");
		expect(plain(rendered)).toContain(" ◇ rev-A-one second 回答中 ");
	});

	it("never lets a clipboard write, a screen clear, a bell or a hyperlink reach the dock", () => {
		const line = strip([
			{ id: "c1", name: `rev-A-one${OSC52}${CLEAR}${BEL}`, state: "running", tag: `${HYPERLINK}审查` },
			{ id: "c2", name: "rev-A-two", state: "running" },
		]);
		const rendered = line.render(120);
		const raw = rendered.join("\n");
		expect(raw).not.toContain("\u001b]52");
		expect(raw).not.toContain("\u001b[2J");
		expect(raw).not.toContain("\u0007");
		expect(raw).not.toContain("\u001b]8;");
		expect(plain(rendered)).toContain(" ◇ rev-A-one 审查 回答中 ");
	});

	it("names a child whose name was nothing but escapes instead of drawing a nameless block", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 2, running: 2, idle: 0, inactive: 0 });
		line.setSubagentRows([
			{ id: "c1", name: `${OSC52}${CLEAR}`, state: "running" },
			{ id: "c2", name: "helper", state: "stalled" },
		]);
		const rendered = line.render(120);
		const raw = rendered.join("\n");
		expect(raw).not.toContain("\u001b]52");
		expect(raw).not.toContain("\u0007");
		const text = plain(rendered);
		expect(text).toContain(" ◇ 子代理 回答中 ");
		expect(text).toContain(" ◇ helper ⚠ 卡住 ");
		// Neither block is drawn as an empty name between its glyph and its state word.
		expect(text).not.toContain("◇  回答中");
		expect(text).not.toContain("◇  卡住");
	});

	it("draws an ordinary name, a CJK one and the short-name rule exactly as before", () => {
		const line = strip([
			{ id: "c1", name: "车道 C 审查", state: "running", tag: "钉住框头" },
			{ id: "c2", name: "review-grow-B-box", state: "idle" },
			{ id: "c3", name: "vps_1", state: "done" },
		]);
		const rendered = line.render(120);
		expect(rendered).toHaveLength(1);
		const [raw] = rendered;
		// The visible bytes: the short-name rule (`车道 C 审查` reads `C`, `review-grow-B-box`
		// reads `B`), an underscore name whole, the tag, and the three state words.
		expect(plain(rendered).trimStart().startsWith("◇ C 钉住框头 回答中   ◇ B 空闲   ◇ vps_1 ✓ 已交回")).toBe(true);
		// The wash takes a child's escapes, not the strip's own paint.
		expect(count(raw ?? "", bgOpen("kindSubagentBg"))).toBe(3);
		expect(raw).toContain(theme.fg("timelineAi", "回答中"));
		expect(raw).toContain(theme.fg("dim", "空闲"));
		expect(raw).toContain(theme.fg("timelineOk", "✓ 已交回"));
	});

	it("never draws past the width with a dirty name, and pages the same row", () => {
		const widths = [120, 80, 60, 40, 24, 12, 8, 4, 1];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const line = strip(
				Array.from({ length: 6 }, (_, index) => ({
					id: `c${index}`,
					name: `rev-A-${index}${index === 0 ? `${OSC52}\nsecond` : ""}`,
					state: "running" as const,
					...(index === 1 ? { tag: `${CLEAR}tag` } : {}),
				})),
			);
			for (const focused of [false, true]) {
				line.focused = focused;
				const rendered = line.render(width);
				expect(rendered, `width ${width}`).toHaveLength(1);
				const raw = rendered[0] ?? "";
				expect(visibleWidth(raw), `width ${width}`).toBeLessThanOrEqual(width);
				expect(raw, `width ${width}`).not.toContain("\n");
				expect(raw, `width ${width}`).not.toContain("\u001b]52");
				expect(raw, `width ${width}`).not.toContain("\u001b[2J");
				expect(raw, `width ${width}`).not.toContain("\u0007");
			}
		}
	});
});
