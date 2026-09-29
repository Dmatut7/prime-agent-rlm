import { visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatTimelineTime } from "../src/modes/interactive/components/timeline-gutter.js";
import type { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { BOX_FOCUS_MARKER } from "../src/modes/interactive/components/turn-box.js";
import { initTheme, type ThemeBg, type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";
import {
	addCommand,
	addStep,
	hasBg,
	plain,
	type QuietTurn,
	quietTurn,
	text,
	useTruecolorTheme,
} from "./ui-blocks-helpers.js";

let restoreTheme: () => void;
let chalkLevel: typeof chalk.level;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	// Bold and the like only show in the output when the color level is on.
	chalkLevel = chalk.level;
	chalk.level = 3;
});

afterAll(() => {
	chalk.level = chalkLevel;
	restoreTheme();
});

const WIDTH = 100;
/** The words of the event line a single command makes when the AI said nothing before it. */
const EVENT_WORDS = "跑了 1 条命令";
/** An event line: time, the AI's diamond, then the gutter's spaces. */
const EVENT_LINE = /^ \d\d:\d\d {3}◆/;
/** The spinner line a running turn ends on. */
const SPINNER_LINE = /^ \d\d:\d\d {3}[⠀-⣿]/;
const FAILURE_WORDS = "Python 出错：ModuleNotFoundError: No module named 'nope'";

function finished(): QuietTurn {
	const turn = quietTurn({ live: false });
	addCommand(turn, "c1", "npm test");
	turn.state.markTurnEnded(Date.now());
	return turn;
}

/** The turn's last step was still running when the owner stopped it. */
function stopped(): QuietTurn {
	const turn = quietTurn({ live: false });
	addStep(turn, "r1", "await bash('sleep 5')", "running");
	turn.timeline.stopped = true;
	turn.state.markTurnEnded(Date.now());
	return turn;
}

/** A failure the AI never fixed: the turn ended on it. */
function failed(): QuietTurn {
	const turn = quietTurn({ live: false });
	addStep(turn, "x1", "import nope", "error");
	turn.timeline.mergeStep(
		"x1",
		"ipython",
		{},
		{
			isError: true,
			details: { error: { ename: "ModuleNotFoundError", evalue: "No module named 'nope'", traceback: [] } },
		},
		false,
	);
	turn.timeline.errorEnded = true;
	turn.state.markTurnEnded(Date.now());
	return turn;
}

function running(): QuietTurn {
	const turn = quietTurn();
	addStep(turn, "r1", "await bash('sleep 5')", "running");
	return turn;
}

/** A running turn whose event lists its step. */
function runningOpen(): QuietTurn {
	const turn = running();
	turn.summary.toggleBox();
	return turn;
}

/** The visible columns painted on `bg` in a line: from its first open to its last reset. */
function paintedColumns(line: string, bg: ThemeBg): number {
	const open = theme.getBgAnsi(bg);
	const from = line.indexOf(open);
	const to = line.lastIndexOf("\x1b[49m");
	if (from < 0 || to < from) return 0;
	return visibleWidth(stripAnsi(line.slice(from, to)));
}

/** The turn's first line, with its colors. */
function firstLine(turn: QuietTurn, width = WIDTH): string {
	return turn.summary.render(width)[0] ?? "";
}

/** The click region of the turn's first line (its first event). */
function eventRegion(summary: TurnSummaryComponent) {
	const region = summary.getClickRegions().find((candidate) => candidate.line === 0);
	if (!region) throw new Error("no event region");
	return region;
}

function hover(turn: QuietTurn, hovered: boolean): void {
	turn.summary.render(WIDTH);
	eventRegion(turn.summary).onHover?.(hovered);
}

describe("an event line is lit as a whole", () => {
	it("has no color behind it while calm, and the pointer paints the whole line, out to the last column, on the hover color", () => {
		const turns = [
			{ name: "finished", turn: finished() },
			{ name: "running", turn: running() },
		];
		expect(turns.length).toBeGreaterThan(0);
		for (const { name, turn } of turns) {
			expect(firstLine(turn), name).not.toContain("\x1b[48;");
			hover(turn, true);
			const lit = firstLine(turn);
			expect(hasBg(lit, "timelineHoverBg"), name).toBe(true);
			expect(paintedColumns(lit, "timelineHoverBg"), name).toBe(WIDTH);
			// The card colors of the old header are not used any more.
			expect(hasBg(lit, "boxHeadBg"), name).toBe(false);
			expect(hasBg(lit, "boxHeadLiveBg"), name).toBe(false);
		}
	});

	it("uses colors that stand clearly apart: the hover color from the panel color, and the four status colors from each other", () => {
		expect(theme.getBgAnsi("timelineHoverBg")).not.toBe(theme.getBgAnsi("kindPanelBg"));
		const status: ThemeColor[] = ["timelineLive", "timelineOk", "timelineMust", "timelineFix"];
		expect(new Set(status.map((token) => theme.getFgAnsi(token))).size).toBe(status.length);
	});

	it("keeps the diamond's and the arrow's own colors through the hover: the hover color opens once and closes once", () => {
		const turn = finished();
		hover(turn, true);
		const lit = firstLine(turn);
		expect(lit).toContain(theme.bold(theme.fg("timelineAi", "◆")));
		expect(lit).toContain(theme.bold(theme.fg("timelineFaint", "▸")));
		expect(lit.startsWith(theme.getBgAnsi("timelineHoverBg"))).toBe(true);
		expect(lit.endsWith("\x1b[49m")).toBe(true);
		expect(lit.split("\x1b[49m")).toHaveLength(2);
	});
});

describe("how the turn stands", () => {
	const cases: Array<{ name: string; turn: () => QuietTurn; line: string; raw: () => string }> = [
		{
			name: "finished",
			turn: finished,
			line: EVENT_WORDS,
			raw: () => theme.fg("text", EVENT_WORDS),
		},
		{
			name: "stopped",
			turn: () => {
				const turn = stopped();
				turn.summary.toggleBox();
				return turn;
			},
			line: "■  sleep 5 · 你停下了",
			raw: () => theme.bold(theme.fg("timelineFaint", "■")),
		},
		{
			name: "failed",
			turn: failed,
			line: FAILURE_WORDS,
			raw: () => theme.fg("timelineMust", FAILURE_WORDS),
		},
	];

	it("says how the turn ended in its own words and colors, and never ends on the spinner", () => {
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			const lines = testCase.turn().summary.render(WIDTH);
			const shown = plain(lines);
			const at = shown.findIndex((line) => line.includes(testCase.line));
			expect(at, testCase.name).toBeGreaterThanOrEqual(0);
			expect(lines[at], testCase.name).toContain(testCase.raw());
			expect(
				shown.some((line) => SPINNER_LINE.test(line)),
				testCase.name,
			).toBe(false);
			expect(shown.join("\n"), testCase.name).not.toContain("在跑");
		}
	});

	it("says the turn goes on, with the spinner and the running command, while it runs", () => {
		const lines = running().summary.render(WIDTH);
		const shown = plain(lines);
		const at = shown.findIndex((line) => SPINNER_LINE.test(line));
		expect(at).toBeGreaterThan(0);
		expect(shown[at]).toMatch(/^ \d\d:\d\d {3}[⠀-⣿] {6}正在运行命令 +第 1 步 {2}$/);
		expect(lines[at]).toContain(theme.getFgAnsi("timelineLive"));
		expect(shown[at + 1]).toMatch(/^ {9}╎ {11}在跑 {2}sleep 5 +\d+秒 {4}$/);
	});

	it("says the stop once, by the step it cut short, and keeps no status word beside it", () => {
		const turn = stopped();
		turn.summary.toggleBox();
		const words = text(turn.summary.render(WIDTH));
		expect(words.match(/你停下了/g)).toHaveLength(1);
		for (const gone of ["已停止", "做到第", "进行中", "完成 "]) expect(words).not.toContain(gone);
	});

	it("has a color of its own in every theme", () => {
		const tokens: Array<ThemeBg | ThemeColor> = [
			"timelineRail",
			"timelineTime",
			"timelineFaint",
			"timelineSoft",
			"timelineUser",
			"timelineAi",
			"timelineLane",
			"timelineSub",
			"timelineMemory",
			"timelineLive",
			"timelineMust",
			"timelineFix",
			"timelineOk",
			"timelineHoverBg",
		];
		expect(tokens.length).toBe(14);
		const ansiOf = (token: ThemeBg | ThemeColor): string =>
			token.endsWith("Bg") ? theme.getBgAnsi(token as ThemeBg) : theme.getFgAnsi(token as ThemeColor);
		const seen = new Map<string, string[]>();
		for (const name of ["dark", "light", "prime"]) {
			initTheme(name);
			seen.set(
				name,
				tokens.map((token) => ansiOf(token)),
			);
		}
		initTheme("prime");
		for (const [name, ansi] of seen) {
			expect(
				ansi.every((entry) => entry.length > 0),
				name,
			).toBe(true);
		}
		// Light is its own set, not the dark one: the lines stay apart from a light page.
		expect(seen.get("light")).not.toEqual(seen.get("dark"));
		expect(seen.get("prime")).toEqual(seen.get("dark"));
	});
});

describe("the words, the count and the arrow", () => {
	it("draws the words in the text color and the count and arrow faint on the right, with no clock or tokens", () => {
		const raw = firstLine(finished());
		expect(raw).toContain(theme.fg("text", EVENT_WORDS));
		expect(raw).toContain(theme.fg("timelineFaint", "1 步 ") + theme.bold(theme.fg("timelineFaint", "▸")));
		const words = plain([raw])[0] ?? "";
		expect(words).toMatch(/跑了 1 条命令 +1 步 ▸ {2}$/);
		expect(words).not.toMatch(/\d+秒|↓/);
		// The bold, colored sentence is the running tail's.
		const live = running().summary.render(WIDTH);
		const spin = live.find((line) => SPINNER_LINE.test(stripAnsi(line))) ?? "";
		expect(spin).toContain(theme.bold(theme.fg("timelineLive", "正在运行命令")));
	});

	it("puts a bold arrow on the right: `▸` folded, `▴` open, and no caret on the left", () => {
		const turn = finished();
		const folded = firstLine(turn);
		const foldedWords = plain([folded])[0] ?? "";
		expect(folded).toContain(theme.bold(theme.fg("timelineFaint", "▸")));
		expect(foldedWords).not.toContain("▴");
		expect(foldedWords).toMatch(EVENT_LINE);
		expect(foldedWords.slice(0, foldedWords.indexOf(EVENT_WORDS))).not.toMatch(/[▸▴▾]/);
		turn.summary.toggleBox();
		const open = firstLine(turn);
		const openWords = plain([open])[0] ?? "";
		expect(open).toContain(theme.bold(theme.fg("timelineAi", "▴")));
		expect(openWords).not.toContain("▸");
		expect(openWords.slice(0, openWords.indexOf(EVENT_WORDS))).not.toMatch(/[▸▴▾]/);
	});
});

describe("pointing at an event line", () => {
	it("lights the line while the pointer is on it, keeps its arrow, and goes back after", () => {
		const turn = finished();
		turn.summary.render(WIDTH);
		const calm = firstLine(turn);
		hover(turn, true);
		const lit = firstLine(turn);
		expect(hasBg(lit, "timelineHoverBg")).toBe(true);
		expect(hasBg(lit, "boxHeadBg")).toBe(false);
		expect(lit).toContain(theme.bold(theme.fg("timelineFaint", "▸")));
		expect(calm).not.toBe(lit);
		hover(turn, false);
		expect(firstLine(turn)).toBe(calm);
	});

	it("names its region the same way every frame, and changes no row or region place on hover", () => {
		const turn = finished();
		const first = turn.summary.render(WIDTH);
		const before = turn.summary.getClickRegions().map((region) => ({ line: region.line, height: region.height }));
		const target = turn.summary.getFocusOrder()[0];
		expect(target).toBeDefined();
		const key = eventRegion(turn.summary).hoverKey;
		expect(key).toBe(`${turn.timeline.ui.id}:${target}`);
		eventRegion(turn.summary).onHover?.(true);
		const lit = turn.summary.render(WIDTH);
		expect(eventRegion(turn.summary).hoverKey).toBe(key);
		expect(lit).toHaveLength(first.length);
		expect(turn.summary.getClickRegions().map((region) => ({ line: region.line, height: region.height }))).toEqual(
			before,
		);
	});

	it("lights it for the keyboard focus too, and marks it as the focused line", () => {
		const turn = finished();
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = "header";
		turn.timeline.ui.bump();
		const line = firstLine(turn);
		expect(hasBg(line, "timelineHoverBg")).toBe(true);
		expect(line.startsWith(BOX_FOCUS_MARKER)).toBe(true);
		expect(paintedColumns(line, "timelineHoverBg")).toBe(WIDTH);
	});

	it("lights the line of an event that is open, too", () => {
		const live = runningOpen();
		hover(live, true);
		const lines = live.summary.render(WIDTH);
		expect(plain(lines)[0]).toMatch(/1 步 ▴ {2}$/);
		expect(hasBg(lines[0] ?? "", "timelineHoverBg")).toBe(true);
	});
});

describe("a folded turn", () => {
	it("is one row: no frame lines at all", () => {
		const turn = finished();
		turn.summary.setHeaderShown(false);
		const lines = turn.summary.render(WIDTH);
		expect(lines).toHaveLength(1);
		expect(text(lines)).not.toMatch(/[╭╮╰╯├┤]/);
		expect(plain(lines)[0]).toMatch(EVENT_LINE);
	});

	it("shows a failure it keeps on show as its own red line, with no frame around it", () => {
		const turn = failed();
		const lines = turn.summary.render(WIDTH);
		const words = text(lines);
		expect(lines).toHaveLength(1);
		expect(words).not.toContain("╭");
		expect(words).not.toContain("╰");
		expect(words).toContain("ModuleNotFoundError");
		expect(lines[0]).toContain(theme.fg("timelineMust", FAILURE_WORDS));
		expect(turn.summary.activate(turn.summary.getFocusOrder()[0] ?? "")).toBe(true);
		const open = turn.summary.render(WIDTH);
		expect(open).toHaveLength(2);
		expect(plain(open)[0]).toMatch(/▴ {2}$/);
		expect(plain(open)[1]).toContain("ModuleNotFoundError");
		expect(text(open)).not.toMatch(/[╭╮╰╯├┤]/);
	});

	it("lists the steps of an open turn with no frame around them", () => {
		const turn = finished();
		turn.summary.toggleBox();
		const words = text(turn.summary.render(WIDTH));
		expect(words).not.toContain("╭");
		expect(words).not.toContain("╰");
		expect(words).toContain("npm test");
	});

	it("opens and folds from the same event line's click, whichever it is on", () => {
		const turn = finished();
		turn.summary.render(WIDTH);
		eventRegion(turn.summary).onClick({ row: 0, col: 0 });
		expect(turn.state.boxOpen).toBe(true);
		turn.summary.render(WIDTH);
		eventRegion(turn.summary).onClick({ row: 0, col: 0 });
		expect(turn.state.boxOpen).toBe(false);
	});
});

describe("a narrow terminal", () => {
	const widths = [80, 50, 40, 30, 26, 24, 20];
	const AT = new Date(2026, 8, 29, 18, 47, 0).getTime();
	const HEAD = ` ${formatTimelineTime(AT)}   ◆      `;

	function fixed(): QuietTurn {
		const turn = quietTurn({ live: false });
		addStep(turn, "c1", "await bash('npm test')", "done", AT);
		turn.state.markTurnEnded(AT + 5_000);
		return turn;
	}

	it("keeps the count and the arrow, cuts the words first, keeps the arrow alone when the count no longer fits, and drops it only when the gutter alone fills the line", () => {
		expect(widths.length).toBeGreaterThan(0);
		const expected: Record<number, string> = {
			80: `${HEAD}${EVENT_WORDS}${" ".repeat(43)}1 步 ▸  `,
			50: `${HEAD}${EVENT_WORDS}${" ".repeat(13)}1 步 ▸  `,
			40: `${HEAD}${EVENT_WORDS}${" ".repeat(3)}1 步 ▸  `,
			30: `${HEAD}跑…   1 步 ▸  `,
			26: `${HEAD}  1 步 ▸  `,
			24: `${HEAD}跑…  ▸  `,
			20: `${HEAD}跑…`,
		};
		for (const width of widths) {
			const [line] = fixed().summary.render(width);
			expect(visibleWidth(line ?? ""), `width ${width}`).toBeLessThanOrEqual(width);
			expect(plain([line ?? ""])[0], `width ${width}`).toBe(expected[width]);
		}
	});

	it("cuts the words before it drops the count and the arrow", () => {
		let sawWholeWords = false;
		let sawCutWords = false;
		for (const width of widths) {
			const shown = plain(fixed().summary.render(width))[0] ?? "";
			const hasWords = shown.includes(EVENT_WORDS);
			if (hasWords) {
				sawWholeWords = true;
				expect(shown, `width ${width}: whole words stay only beside the arrow`).toContain("1 步 ▸");
			} else sawCutWords = true;
		}
		expect(sawWholeWords).toBe(true);
		expect(sawCutWords).toBe(true);
	});

	it("draws an open turn down to the narrowest the timeline can be, never wider than the terminal", () => {
		for (const width of [40, 24, 12, 6, 4]) {
			const lines = runningOpen().summary.render(width);
			expect(lines, `width ${width}`).toHaveLength(5);
			for (const line of lines) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
		}
		const wide = text(runningOpen().summary.render(40));
		expect(wide).toContain("正在运行命令");
		expect(wide).toContain("在跑");
	});
});
