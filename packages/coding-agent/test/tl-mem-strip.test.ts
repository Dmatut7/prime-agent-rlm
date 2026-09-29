import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelMemoryChange } from "../src/core/kernel/shared.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ChangeEntry } from "../src/modes/interactive/components/feed-data.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { formatTimelineTime } from "../src/modes/interactive/components/timeline-gutter.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import type { TimelineFacts } from "../src/modes/interactive/components/timeline-rows.js";
import {
	formatSpan,
	STRIP_ALL,
	STRIP_EDITS,
	type StripSource,
	TurnStripComponent,
} from "../src/modes/interactive/components/turn-strip.js";
import { TurnTimeline } from "../src/modes/interactive/components/turn-timeline.js";
import { type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";
import { useTruecolorTheme } from "./ui-blocks-helpers.js";

const AT = new Date(2026, 8, 29, 19, 6, 20).getTime();
const DESIGN_MEMORY = [
	"范围：merge/repl-kernel 的 adc7ca82c..b4c296f65，16 个提交、96 个文件。",
	"P0：0.11.16 发版提交删掉了三个改动说明文件，grow-fix-copy 测试要读它们，任何环境都会红。",
	"P1：256 色终端里子代理和出错的四个底色变成同一个颜色，普通、悬停、选中分不出来。",
	"修法：新提交修测试和颜色 → 全绿 → 发 0.11.17。",
];

let restoreTheme: () => void;
let chalkLevel: typeof chalk.level;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	// Bold only shows in the output when the color level is on.
	chalkLevel = chalk.level;
	chalk.level = 3;
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	chalk.level = chalkLevel;
	restoreTheme();
});

afterEach(() => {
	setMotionReduced(false);
	timelineShowAll.set(false);
});

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));
const squeeze = (value: string) => value.replace(/\s+/g, "");

function memory(overrides: Partial<KernelMemoryChange> = {}): KernelMemoryChange {
	return {
		op: "created",
		kind: "memory",
		scope: "global",
		title: "grow 批次审查结论（2026-09-29）",
		after: DESIGN_MEMORY.join("\n"),
		at: AT,
		...overrides,
	};
}

function file(overrides: Partial<ChangeEntry> = {}): ChangeEntry {
	return {
		key: "/w/src/a.ts",
		path: "src/a.ts",
		kind: "modified",
		scope: "project",
		added: 12,
		removed: 3,
		rows: [
			{ kind: "del", line: 1, text: "old()" },
			{ kind: "add", line: 1, text: "fresh()" },
		],
		truncated: false,
		binary: false,
		firstAt: AT - 60_000,
		...overrides,
	};
}

function facts(overrides: Partial<TimelineFacts> = {}): TimelineFacts {
	return {
		thinkCount: 0,
		commandCount: 0,
		readCount: 0,
		stepCount: 1,
		subagentCount: 0,
		errorCount: 0,
		projectChanges: [],
		scratchChanges: [],
		memories: [{ key: "m1", change: memory() }],
		trackingIncomplete: false,
		...overrides,
	};
}

function strip(data: TimelineFacts, extra: Partial<StripSource> = {}, timeline = new TurnTimeline()) {
	const requestRender = vi.fn();
	const component = new TurnStripComponent({ timeline, facts: () => data, requestRender, ...extra });
	return { component, timeline, requestRender };
}

/** The design's `row()`: the timeline gutter, the content, and the right text closing the row to `width`. */
function designRow(width: number, time: string, main: string, content: string, right = ""): string {
	const cell = (text: string) => visibleWidth(text);
	const head = ` ${time || "     "}   ${main}      `;
	const tail = right ? `${right}  ` : "";
	const pad = right ? " ".repeat(Math.max(1, width - cell(head) - cell(content) - cell(tail))) : "";
	return `${head}${content}${pad}${tail}`;
}

interface Cell {
	char: string;
	fg: string | undefined;
	bg: string | undefined;
	bold: boolean;
}

/** The styled characters of a rendered row, from its escape sequences. */
function cells(line: string): Cell[] {
	const out: Cell[] = [];
	let fg: string | undefined;
	let bg: string | undefined;
	let bold = false;
	for (let index = 0; index < line.length; ) {
		const sgr = /^\x1b\[([0-9;]*)m/.exec(line.slice(index));
		if (sgr) {
			const code = sgr[1] ?? "";
			if (code.startsWith("38;")) fg = sgr[0];
			else if (code === "39") fg = undefined;
			else if (code.startsWith("48;")) bg = sgr[0];
			else if (code === "49") bg = undefined;
			else if (code === "1") bold = true;
			else if (code === "22") bold = false;
			else if (code === "0") {
				fg = undefined;
				bg = undefined;
				bold = false;
			}
			index += sgr[0].length;
			continue;
		}
		const marker = /^\x1b_[^\x07]*\x07/.exec(line.slice(index));
		if (marker) {
			index += marker[0].length;
			continue;
		}
		const char = String.fromCodePoint(line.codePointAt(index) ?? 32);
		out.push({ char, fg, bg, bold });
		index += char.length;
	}
	return out;
}

/** The style of `needle` in `line`; every character of it must share one style. */
function styleOf(line: string, needle: string): { fg: string | undefined; bold: boolean } {
	const all = cells(line);
	const text = all.map((cell) => cell.char).join("");
	const at = text.indexOf(needle);
	expect(at, `${needle} in ${text}`).toBeGreaterThanOrEqual(0);
	const chars = all.slice(at, at + [...needle].length);
	const first = chars[0];
	for (const cell of chars) {
		expect(cell.fg, `${needle} fg`).toBe(first?.fg);
		expect(cell.bold, `${needle} bold`).toBe(first?.bold);
	}
	return { fg: first?.fg, bold: first?.bold ?? false };
}

/** The escape a token paints with; the terminal's own foreground reads as no color at all. */
const fgOf = (token: ThemeColor): string | undefined => {
	const ansi = theme.getFgAnsi(token);
	return ansi === "\x1b[39m" ? undefined : ansi;
};

describe("the memory and closing rows, cell for cell with the design", () => {
	const W = 160;

	function openedDesignStrip() {
		setMotionReduced(true);
		const built = strip(facts(), {
			elapsedMs: () => 20 * 60_000,
			spend: () => ({ cost: 4.2, parentCost: 5.6 }),
		});
		built.component.activate("strip:item:m1");
		return built;
	}

	it("draws one blank rail row, the memory row, its words on the ┃ bar, a blank row, and the closing row", () => {
		const { component } = openedDesignStrip();
		const time = formatTimelineTime(AT);
		expect(time).toBe("19:06");
		const rows = plain(component.render(W));
		const expected = [
			designRow(W, "", "│", ""),
			designRow(W, time, "✦", "记住了   grow 批次审查结论（2026-09-29）", "▴"),
			...DESIGN_MEMORY.map((line) => designRow(W, "", "┃", line)),
			designRow(W, "", "│", ""),
			designRow(W, "", "╵", "✓ 用了 20 分钟 · 子代理 ¥4.20 · 全部 ¥9.80", "完整过程 ▸"),
		];
		expect(rows).toEqual(expected);
		for (const row of rows.filter((row) => row.includes("▴") || row.includes("完整过程"))) {
			expect(visibleWidth(row)).toBe(W);
		}
	});

	it("folds to the memory row and the closing row, with ▸ instead of ▴", () => {
		setMotionReduced(true);
		const { component } = strip(facts(), {
			elapsedMs: () => 20 * 60_000,
			spend: () => ({ cost: 4.2, parentCost: 5.6 }),
		});
		const rows = plain(component.render(W));
		expect(rows).toEqual([
			designRow(W, "", "│", ""),
			designRow(W, "19:06", "✦", "记住了   grow 批次审查结论（2026-09-29）", "▸"),
			designRow(W, "", "│", ""),
			designRow(W, "", "╵", "✓ 用了 20 分钟 · 子代理 ¥4.20 · 全部 ¥9.80", "完整过程 ▸"),
		]);
	});

	it("paints each cell with the design's color", () => {
		const { component } = openedDesignStrip();
		const rows = component.render(W);
		const memoryRow = rows[1] ?? "";
		expect(styleOf(memoryRow, "19:06")).toEqual({ fg: fgOf("timelineTime"), bold: false });
		expect(styleOf(memoryRow, "✦")).toEqual({ fg: fgOf("timelineMemory"), bold: true });
		expect(styleOf(memoryRow, "记住了")).toEqual({ fg: fgOf("timelineMemory"), bold: true });
		expect(styleOf(memoryRow, "grow 批次审查结论（2026-09-29）").bold).toBe(false);
		expect(styleOf(memoryRow, "grow 批次审查结论（2026-09-29）").fg).toBe(fgOf("text"));
		expect(styleOf(memoryRow, "▴")).toEqual({ fg: fgOf("timelineMemory"), bold: true });
		const bodyRow = rows[2] ?? "";
		expect(styleOf(bodyRow, "┃")).toEqual({ fg: fgOf("timelineMemory"), bold: false });
		expect(styleOf(bodyRow, "范围：merge/repl-kernel").fg).toBe(fgOf("timelineSoft"));
		const blankRow = rows[1 + 1 + DESIGN_MEMORY.length] ?? "";
		expect(styleOf(blankRow, "│").fg).toBe(fgOf("timelineRail"));
		const closing = rows.at(-1) ?? "";
		expect(styleOf(closing, "╵").fg).toBe(fgOf("timelineRail"));
		expect(styleOf(closing, "用了 20 分钟 · 子代理 ¥4.20 · 全部 ¥9.80").fg).toBe(fgOf("timelineFaint"));
		expect(styleOf(closing, "✓").fg).toBe(fgOf("timelineFaint"));
		expect(styleOf(closing, "完整过程 ▸")).toEqual({ fg: fgOf("timelineFaint"), bold: false });
	});

	it("shows a closed memory's ▸ bold and faint", () => {
		const { component } = strip(facts(), { elapsedMs: () => 60_000 });
		const row = component.render(W)[1] ?? "";
		expect(styleOf(row, "▸")).toEqual({ fg: fgOf("timelineFaint"), bold: true });
	});
});

describe("blank rows around the strip", () => {
	it("adds one blank row above a memory (the answer's own blank row is the other), and none above the closing row alone", () => {
		const withMemory = plain(strip(facts()).component.render(100));
		expect(withMemory[0]).toBe(designRow(100, "", "│", ""));
		expect(withMemory[1]).toContain("✦");

		const alone = plain(strip(facts({ memories: [] })).component.render(100));
		expect(alone).toHaveLength(1);
		expect(alone[0]).toContain("╵");
	});

	it("puts a blank row between the file row and the memory rows, and one before the closing row", () => {
		const rows = plain(strip(facts({ projectChanges: [file()] })).component.render(100));
		const kinds = rows.map((row) =>
			row.includes("✎") ? "edits" : row.includes("✦") ? "memory" : row.includes("╵") ? "end" : "gap",
		);
		expect(kinds).toEqual(["gap", "edits", "gap", "memory", "gap", "end"]);
	});

	it("leaves a blank row between opened memories, and none between folded ones", () => {
		const two = facts({
			memories: [
				{ key: "m1", change: memory({ title: "第一条", after: "甲" }) },
				{ key: "m2", change: memory({ title: "第二条", after: "乙" }) },
			],
		});
		const folded = strip(two);
		expect(
			plain(folded.component.render(100)).map((row) =>
				row.includes("✦") ? "m" : row.includes("╵") ? "end" : "gap",
			),
		).toEqual(["gap", "m", "m", "gap", "end"]);
		setMotionReduced(true);
		const opened = strip(two);
		opened.component.activate("strip:item:m1");
		const rows = plain(opened.component.render(100));
		expect(
			rows.map((row) => (row.includes("✦") ? "m" : row.includes("┃") ? "bar" : row.includes("╵") ? "end" : "gap")),
		).toEqual(["gap", "m", "bar", "gap", "m", "gap", "end"]);
	});

	it("draws nothing when a later turn closes the request and this turn kept nothing", () => {
		expect(strip(facts({ memories: [] }), { endsRequest: () => false }).component.render(100)).toEqual([]);
		const kept = plain(strip(facts(), { endsRequest: () => false }).component.render(100));
		expect(kept.some((row) => row.includes("╵"))).toBe(false);
		expect(kept.some((row) => row.includes("✦"))).toBe(true);
		expect(
			strip(facts(), { endsRequest: () => true })
				.component.render(100)
				.some((row) => row.includes("╵")),
		).toBe(true);
	});

	it("draws nothing while the turn still runs", () => {
		const component = new TurnStripComponent({
			timeline: new TurnTimeline(),
			facts: () => undefined,
			requestRender: vi.fn(),
		});
		expect(component.render(100)).toEqual([]);
		expect(component.getClickRegions()).toEqual([]);
		expect(component.getFocusOrder()).toEqual([]);
	});
});

describe("opening a memory", () => {
	it("opens straight to its words with one click, and closes with the next", () => {
		setMotionReduced(true);
		const { component, requestRender } = strip(facts());
		const region = component.getClickRegions()[0];
		expect(region).toBeUndefined();
		component.render(100);
		const regions = component.getClickRegions();
		expect(regions.map((each) => each.line)).toEqual([1, 3]);
		expect(plain(component.render(100)).join("\n")).not.toContain("范围：");
		regions[0]?.onClick({ row: 0, col: 5 });
		expect(requestRender).toHaveBeenCalledTimes(1);
		const openedRows = plain(component.render(100));
		const words = openedRows.filter((row) => row.includes("┃")).map((row) => row.slice(16));
		expect(squeeze(words.join(""))).toBe(squeeze(DESIGN_MEMORY.join("")));
		expect(openedRows.join("\n")).not.toContain("+ 范围");
		component.getClickRegions()[0]?.onClick({ row: 0, col: 5 });
		expect(plain(component.render(100)).join("\n")).not.toContain("范围：");
	});

	it("opens each of several memories on its own", () => {
		setMotionReduced(true);
		const { component } = strip(
			facts({
				memories: [
					{ key: "m1", change: memory({ title: "第一条", after: "甲甲甲" }) },
					{ key: "m2", change: memory({ title: "第二条", after: "乙乙乙" }) },
				],
			}),
		);
		component.render(100);
		expect(component.getFocusOrder()).toEqual(["strip:item:m1", "strip:item:m2", STRIP_ALL]);
		component.activate("strip:item:m2");
		const out = plain(component.render(100)).join("\n");
		expect(out).toContain("乙乙乙");
		expect(out).not.toContain("甲甲甲");
		expect(component.enterLabel("strip:item:m2")).toBe("收起");
		expect(component.enterLabel("strip:item:m1")).toBe("展开");
	});

	it("wraps a long memory at the screen's width and never cuts it", () => {
		setMotionReduced(true);
		const long = `${"记".repeat(150)}\n\n${"word ".repeat(70).trim()}`;
		const widths = [30, 40, 80, 120];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const { component } = strip(facts({ memories: [{ key: "m1", change: memory({ after: long }) }] }));
			component.activate("strip:item:m1");
			const rows = plain(component.render(width));
			const body = rows.filter((row) => row.includes("┃")).map((row) => row.slice(16));
			expect(squeeze(body.join("")), `text at ${width}`).toBe(squeeze(long));
			for (const row of rows) expect(visibleWidth(row), `row at ${width}`).toBeLessThanOrEqual(width);
			for (const row of body) expect(row, `ellipsis at ${width}`).not.toContain("…");
		}
	});

	it("marks a renamed or changed memory in words, with the memory's own new title on the row", () => {
		setMotionReduced(true);
		const { component } = strip(
			facts({
				memories: [
					{
						key: "m1",
						change: memory({
							op: "updated",
							title: "规则",
							previousTitle: "旧规则",
							before: "一\n二",
							after: "一\n三",
						}),
					},
				],
			}),
		);
		component.activate("strip:item:m1");
		const out = plain(component.render(100)).join("\n");
		expect(out).toContain("改了记忆   规则");
		expect(out).toContain("改名  旧规则 → 规则");
		expect(out).toContain("− 二");
		expect(out).toContain("+ 三");
	});

	it("reads an id-shaped title as words and cuts it at a word when the row is short", () => {
		const slug = "prime_agent_grow批次审查_20260929_四车道_无功能p0_但发版提交打红套件";
		const { component } = strip(facts({ memories: [{ key: "m1", change: memory({ title: slug }) }] }));
		const wide = plain(component.render(160))[1] ?? "";
		expect(wide).toContain("记住了   prime agent grow批次审查 四车道 无功能p0 但发版提交打红套件");
		const narrow = plain(component.render(60))[1] ?? "";
		expect(narrow).toContain("…");
		expect(narrow).toContain("记住了   prime agent");
		expect(narrow).not.toContain("_");
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(60);
	});

	it("dates the row from the memory's own time, else from the turn's last message", () => {
		const stamped = plain(strip(facts()).component.render(100))[1] ?? "";
		expect(stamped.startsWith(` ${formatTimelineTime(AT)}   ✦`)).toBe(true);
		const timeline = new TurnTimeline();
		const message = {
			role: "assistant",
			content: [],
			api: "a",
			provider: "p",
			model: "m",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: AT + 3 * 60_000,
		} satisfies AssistantMessage;
		timeline.noteMessage(message, true);
		const fallback =
			plain(
				strip(facts({ memories: [{ key: "m1", change: memory({ at: 0 }) }] }), {}, timeline).component.render(100),
			)[1] ?? "";
		expect(fallback.startsWith(` ${formatTimelineTime(AT + 3 * 60_000)}   ✦`)).toBe(true);
	});
});

describe("hover, focus and keys", () => {
	it("gives every row a hover key and a hover callback that only change colors", () => {
		setMotionReduced(true);
		const { component, timeline, requestRender } = strip(facts({ projectChanges: [file()] }));
		component.activate("strip:item:m1");
		const before = component.render(100);
		const regionsBefore = component
			.getClickRegions()
			.map((region) => ({ ...region, onClick: undefined, onHover: undefined }));
		expect(component.getClickRegions().length).toBeGreaterThan(0);
		for (const region of component.getClickRegions()) {
			expect(region.hoverKey).toBeTypeOf("string");
			expect(region.onHover).toBeTypeOf("function");
			expect(region.width).toBe(100);
			expect(region.col).toBe(0);
		}
		const memoryRegion = component.getClickRegions().find((region) => region.line === 3);
		memoryRegion?.onHover?.(true);
		expect(requestRender).toHaveBeenCalled();
		expect(timeline.ui.hoverKey).toBe("strip:item:m1");
		const hovered = component.render(100);
		expect(plain(hovered)).toEqual(plain(before));
		expect(hovered).not.toEqual(before);
		expect(hovered[3]).toContain(theme.getBgAnsi("timelineHoverBg"));
		expect(hovered.map((line) => visibleWidth(line))).toEqual(before.map((line) => visibleWidth(line)));
		expect(
			component.getClickRegions().map((region) => ({ ...region, onClick: undefined, onHover: undefined })),
		).toEqual(regionsBefore);
		memoryRegion?.onHover?.(false);
		expect(component.render(100)).toEqual(before);
	});

	it("lists the focus targets top to bottom and names what Enter does", () => {
		const { component } = strip(facts({ projectChanges: [file(), file({ key: "/w/b.go", path: "b.go" })] }));
		component.render(100);
		expect(component.getFocusOrder()).toEqual([STRIP_EDITS, "strip:item:m1", STRIP_ALL]);
		component.activate(STRIP_EDITS);
		component.render(100);
		expect(component.getFocusOrder()).toEqual([
			STRIP_EDITS,
			"strip:item:file:/w/src/a.ts",
			"strip:item:file:/w/b.go",
			"strip:item:m1",
			STRIP_ALL,
		]);
		expect(component.enterLabel(STRIP_EDITS)).toBe("收起");
		expect(component.enterLabel(STRIP_ALL)).toBe("展开");
		expect(component.activate("strip:unknown")).toBe(false);
		expect(component.enterLabel("nothing")).toBeUndefined();
	});

	it("paints the focused row with the hover background and the reveal marker", () => {
		const { component, timeline } = strip(facts());
		timeline.ui.focused = true;
		timeline.ui.focusKey = "strip:item:m1";
		const rows = component.render(100);
		expect(rows[1]).toContain("\x1b_pi:box-focus\x07");
		expect(rows[1]).toContain(theme.getBgAnsi("timelineHoverBg"));
		expect(rows[3]).not.toContain(theme.getBgAnsi("timelineHoverBg"));
	});
});

describe("the closing row", () => {
	it("says how long the request took, and the spend the status line knows", () => {
		const row = (source: Partial<StripSource>, data = facts({ memories: [] })) =>
			plain(strip(data, source).component.render(120)).at(-1) ?? "";
		expect(row({ elapsedMs: () => 20 * 60_000 })).toBe(designRow(120, "", "╵", "✓ 用了 20 分钟", "完整过程 ▸"));
		expect(row({ elapsedMs: () => 20 * 60_000, spend: () => ({ cost: 4.2, parentCost: 5.6 }) })).toBe(
			designRow(120, "", "╵", "✓ 用了 20 分钟 · 子代理 ¥4.20 · 全部 ¥9.80", "完整过程 ▸"),
		);
		expect(row({ elapsedMs: () => 45_000, spend: () => ({ cost: 0, parentCost: 1.5 }) })).toBe(
			designRow(120, "", "╵", "✓ 用了 45 秒 · 全部 ¥1.50", "完整过程 ▸"),
		);
		expect(row({ elapsedMs: () => 90_000, spend: () => ({ cost: 0, parentCost: 0 }) })).toBe(
			designRow(120, "", "╵", "✓ 用了 1 分 30 秒", "完整过程 ▸"),
		);
		expect(row({ elapsedMs: () => 60_000, spend: () => ({ cost: 2, parentCost: 1, partial: true }) })).toContain(
			"子代理 ≈¥2.00 · 全部 ≈¥3.00",
		);
		expect(row({})).toBe(designRow(120, "", "╵", "✓ 完成", "完整过程 ▸"));
	});

	it("names how the turn ended when it did not finish cleanly", () => {
		const stopped = new TurnTimeline();
		stopped.stopped = true;
		const failed = new TurnTimeline();
		failed.errorEnded = true;
		const line = (timeline: TurnTimeline) =>
			plain(strip(facts({ memories: [] }), { elapsedMs: () => 60_000 }, timeline).component.render(120)).at(-1) ??
			"";
		expect(line(stopped)).toContain("■ 已停止 · 用了 1 分钟");
		expect(line(failed)).toContain("✗ 出错 · 用了 1 分钟");
		const painted =
			strip(facts({ memories: [] }), {}, failed)
				.component.render(120)
				.at(-1) ?? "";
		expect(styleOf(painted, "✗").fg).toBe(fgOf("timelineMust"));
	});

	it("reads the span off the turn's messages when the host gives none", () => {
		const timeline = new TurnTimeline();
		const message = (timestamp: number) =>
			({
				role: "assistant",
				content: [],
				api: "a",
				provider: "p",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp,
			}) satisfies AssistantMessage;
		timeline.noteMessage(message(AT), true);
		timeline.noteMessage(message(AT + 150_000), true);
		const row = plain(strip(facts({ memories: [] }), {}, timeline).component.render(120)).at(-1) ?? "";
		expect(row).toContain("✓ 用了 2 分 30 秒");
	});

	it("toggles the full process with a click or Enter, and says which way it points", () => {
		const { component, requestRender } = strip(facts({ memories: [] }));
		const closing = () => plain(component.render(100)).at(-1) ?? "";
		expect(closing()).toContain("完整过程 ▸");
		const region = component.getClickRegions().find((each) => each.hoverKey?.endsWith(STRIP_ALL));
		expect(region?.line).toBe(0);
		region?.onClick({ row: 0, col: 3 });
		expect(timelineShowAll.value).toBe(true);
		expect(requestRender).toHaveBeenCalled();
		expect(closing()).toContain("完整过程 ▴");
		expect(component.enterLabel(STRIP_ALL)).toBe("收起");
		expect(component.activate(STRIP_ALL)).toBe(true);
		expect(timelineShowAll.value).toBe(false);
		expect(closing()).toContain("完整过程 ▸");
	});

	it("drops the money, then the wording, instead of cutting a figure in half", () => {
		const source = { elapsedMs: () => 20 * 60_000, spend: () => ({ cost: 4.2, parentCost: 5.6 }) };
		const widths = Array.from({ length: 70 }, (_, index) => index + 1);
		for (const width of widths) {
			const row = plain(strip(facts({ memories: [] }), source).component.render(width)).at(-1) ?? "";
			expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width);
			for (const figure of row.match(/¥[0-9.]*/g) ?? [])
				expect(["¥4.20", "¥9.80"], `${row} at ${width}`).toContain(figure);
		}
		expect(plain(strip(facts({ memories: [] }), source).component.render(60)).at(-1)).toContain(
			"用了 20 分钟 · 子代理 ¥4.20",
		);
	});

	it("formats spans in plain words", () => {
		const table: Array<[number, string]> = [
			[400, "1 秒"],
			[45_000, "45 秒"],
			[90_000, "1 分 30 秒"],
			[600_000, "10 分钟"],
			[20 * 60_000, "20 分钟"],
			[20 * 60_000 + 40_000, "20 分钟"],
			[3_600_000, "1 小时"],
			[3_600_000 + 5 * 60_000, "1 小时 5 分钟"],
		];
		expect(table.length).toBeGreaterThan(0);
		for (const [ms, expected] of table) expect(formatSpan(ms), String(ms)).toBe(expected);
	});
});

describe("the changed-files row", () => {
	it("is one timeline row like the memory row: `✎ 改了 2 个文件 +20 −7`, opening to the files and then a diff", () => {
		setMotionReduced(true);
		const { component } = strip(
			facts({
				memories: [],
				projectChanges: [
					file({ added: 12, removed: 3 }),
					file({ key: "/w/b.go", path: "b.go", added: 8, removed: 4, rows: [] }),
				],
				commitId: "abc1234",
			}),
		);
		const rows = plain(component.render(100));
		expect(rows[0]).toBe(
			designRow(100, formatTimelineTime(AT - 60_000), "·", "✎ 改了 2 个文件 +20 −7 · 已提交 abc1234", "▸"),
		);
		component.activate(STRIP_EDITS);
		const list = plain(component.render(100));
		expect(list[0]).toContain("▴");
		expect(list[1]).toBe(designRow(100, "", "│", "  ✎ src/a.ts", "+12 −3  ▸"));
		expect(list[2]).toBe(designRow(100, "", "│", "  ✎ b.go", "+8 −4  ▸"));
		component.activate("strip:item:file:/w/src/a.ts");
		const diff = plain(component.render(100)).join("\n");
		expect(diff).toContain("− old()");
		expect(diff).toContain("+ fresh()");
		expect(component.enterLabel("strip:item:file:/w/src/a.ts")).toBe("收起");
	});

	it("says a commit or an incomplete record even when no project file changed", () => {
		const commit = plain(strip(facts({ memories: [], commitId: "abc1234" })).component.render(100));
		expect(commit[0]).toContain("已提交 abc1234");
		const lost = plain(strip(facts({ memories: [], trackingIncomplete: true })).component.render(100));
		expect(lost[0]).toContain("（有些改动没记全）");
	});

	it("says how many temp files sit outside the project once opened", () => {
		setMotionReduced(true);
		const { component } = strip(
			facts({
				memories: [],
				projectChanges: [file()],
				scratchChanges: [file({ key: "/tmp/x", path: "/tmp/x", scope: "scratch" })],
			}),
		);
		component.activate(STRIP_EDITS);
		expect(plain(component.render(100)).join("\n")).toContain("另有 1 个临时文件，不算项目改动");
	});
});

describe("narrow screens", () => {
	it("never draws a row wider than the screen, and keeps every click area on it", () => {
		setMotionReduced(true);
		const data = facts({
			projectChanges: [file({ added: 999999, removed: 888888 })],
			scratchChanges: [file({ key: "/tmp/x", path: "/tmp/x", scope: "scratch" })],
			commitId: "abc1234",
			trackingIncomplete: true,
			memories: [{ key: "m1", change: memory({ after: `${"记".repeat(80)}\n\n${"word ".repeat(30)}` }) }],
		});
		const widths = Array.from({ length: 60 }, (_, index) => index + 1);
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const { component } = strip(data, {
				elapsedMs: () => 20 * 60_000,
				spend: () => ({ cost: 4.2, parentCost: 5.6 }),
			});
			component.activate(STRIP_EDITS);
			component.activate("strip:item:file:/w/src/a.ts");
			component.activate("strip:item:m1");
			const rows = component.render(width);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) expect(visibleWidth(row), `width ${width}`).toBeLessThanOrEqual(width);
			for (const region of component.getClickRegions()) {
				expect(region.col + region.width, `area at ${width}`).toBeLessThanOrEqual(width);
				expect(region.line).toBeLessThan(rows.length);
			}
		}
	});
});
