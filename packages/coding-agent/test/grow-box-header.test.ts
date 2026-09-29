import { visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import type { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { initTheme, type ThemeBg, type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";
import { headerIndex, headerPlain, headerRaw } from "./grow-box-helpers.js";
import {
	addCommand,
	addStep,
	hasBg,
	host,
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

afterEach(() => {
	vi.useRealTimers();
	setMotionReduced(false);
});

const WIDTH = 100;

function finished(options: { stopped?: boolean; failed?: boolean } = {}): QuietTurn {
	setMotionReduced(true);
	const turn = quietTurn({ live: false, host: host({ growBox: () => true }) });
	addCommand(turn, "c1", "npm test");
	if (options.stopped) turn.timeline.stopped = true;
	if (options.failed) turn.timeline.errorEnded = true;
	turn.state.markTurnEnded(Date.now());
	return turn;
}

function running(): QuietTurn {
	setMotionReduced(true);
	const turn = quietTurn({ host: host({ growBox: () => true }) });
	addStep(turn, "r1", "await bash('sleep 5')", "running");
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

function headerRegion(summary: TurnSummaryComponent) {
	const region = summary.getClickRegions().find((candidate) => candidate.hoverKey?.endsWith(":header"));
	if (!region) throw new Error("no header region");
	return region;
}

describe("the header row is a card", () => {
	it("paints the whole row, borders excepted, on the finished color, and on the running color while it runs", () => {
		const turn = finished();
		const raw = headerRaw(turn.summary.render(WIDTH));
		expect(hasBg(raw, "boxHeadBg")).toBe(true);
		expect(hasBg(raw, "boxHeadLiveBg")).toBe(false);
		// A folded box is the card alone: it spans the box's width.
		expect(paintedColumns(raw, "boxHeadBg")).toBe(WIDTH - 1);

		const live = running();
		const liveRaw = headerRaw(live.summary.render(WIDTH));
		expect(hasBg(liveRaw, "boxHeadLiveBg")).toBe(true);
		expect(hasBg(liveRaw, "boxHeadBg")).toBe(false);
		// Framed, the row fills the frame between its borders.
		expect(paintedColumns(liveRaw, "boxHeadLiveBg")).toBe(WIDTH - 3);
	});

	it("uses colors that stand clearly apart from the box's own blocks", () => {
		const head = theme.getBgAnsi("boxHeadBg");
		const liveHead = theme.getBgAnsi("boxHeadLiveBg");
		const panel = theme.getBgAnsi("kindPanelBg");
		expect(head).not.toBe(liveHead);
		expect(head).not.toBe(panel);
		expect(liveHead).not.toBe(panel);
	});

	it("keeps the pill's own colors through the rest of the row", () => {
		const raw = headerRaw(finished().summary.render(WIDTH));
		const pill = theme.bg("boxPillDoneBg", theme.bold(theme.fg("boxPillDone", " ✓ 完成 ")));
		expect(raw).toContain(pill + theme.getBgAnsi("boxHeadBg"));
	});
});

describe("the status pill", () => {
	const cases: Array<{ name: string; turn: () => QuietTurn; pill: string; fg: ThemeColor; bg: ThemeBg }> = [
		{ name: "finished", turn: () => finished(), pill: " ✓ 完成 ", fg: "boxPillDone", bg: "boxPillDoneBg" },
		{
			name: "stopped",
			turn: () => finished({ stopped: true }),
			pill: " ■ 已停止 ",
			fg: "boxPillStopped",
			bg: "boxPillStoppedBg",
		},
		{
			name: "failed",
			turn: () => finished({ failed: true }),
			pill: " ✗ 出错 ",
			fg: "boxPillError",
			bg: "boxPillErrorBg",
		},
	];

	it("says how the turn ended, in its own words and colors, with a space each side", () => {
		expect(cases.length).toBeGreaterThan(0);
		for (const testCase of cases) {
			const raw = headerRaw(testCase.turn().summary.render(WIDTH));
			expect(raw, testCase.name).toContain(theme.bg(testCase.bg, theme.bold(theme.fg(testCase.fg, testCase.pill))));
		}
	});

	it("says the turn goes on, with the spinner, while it runs", () => {
		const live = running();
		const raw = headerRaw(live.summary.render(WIDTH));
		expect(stripAnsi(raw)).toMatch(/ \S 进行中 /);
		expect(hasBg(raw, "boxPillLiveBg")).toBe(true);
		expect(raw).toContain(theme.getFgAnsi("boxPillLive"));
	});

	it("does not say it twice in the words next to it", () => {
		const stopped = headerPlain(finished({ stopped: true }).summary.render(WIDTH));
		expect(stopped.match(/已停止/g)).toHaveLength(1);
		expect(stopped).toMatch(/■ 已停止 +做到第 1 步，做好的都留着/);
	});

	it("has a color of its own in every theme", () => {
		const tokens: Array<ThemeBg | ThemeColor> = [
			"boxHeadBg",
			"boxHeadLiveBg",
			"boxHeadHoverBg",
			"boxPillLive",
			"boxPillLiveBg",
			"boxPillDone",
			"boxPillDoneBg",
			"boxPillStopped",
			"boxPillStoppedBg",
			"boxPillError",
			"boxPillErrorBg",
		];
		expect(tokens.length).toBe(11);
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
		// Light is its own set, not the dark one: the header stays apart from a light page.
		expect(seen.get("light")).not.toEqual(seen.get("dark"));
		expect(seen.get("prime")).toEqual(seen.get("dark"));
	});
});

describe("the words, the clock and the arrow", () => {
	it("draws the title bold in its own color, and the clock and tokens on the right", () => {
		const turn = finished({ stopped: true });
		const raw = headerRaw(turn.summary.render(WIDTH));
		expect(raw).toContain(theme.bold(theme.fg("activityText", "做到第 1 步，做好的都留着")));
		const words = headerPlain(turn.summary.render(WIDTH));
		expect(words).toMatch(/做好的都留着 +\d+秒 · ↓ \d+ › *$/);
	});

	it("puts a bold arrow on the right: `›` folded, `⌄` open, and no caret on the left", () => {
		const turn = finished();
		const folded = turn.summary.render(WIDTH);
		expect(headerRaw(folded)).toContain(theme.bold(theme.fg("activityText", "›")));
		expect(headerPlain(folded)).not.toMatch(/[▾▸]/);
		expect(headerPlain(folded).trim().startsWith("✓")).toBe(true);
		turn.summary.toggleBox();
		const open = turn.summary.render(WIDTH);
		expect(headerRaw(open)).toContain(theme.bold(theme.fg("activityText", "⌄")));
		expect(headerPlain(open)).not.toMatch(/[▾▸]/);
	});
});

describe("pointing at the header", () => {
	it("lights the row and the arrow while the pointer is on it, and back after", () => {
		const turn = finished();
		turn.summary.render(WIDTH);
		const calm = headerRaw(turn.summary.render(WIDTH));
		headerRegion(turn.summary).onHover?.(true);
		const lit = headerRaw(turn.summary.render(WIDTH));
		expect(hasBg(lit, "boxHeadHoverBg")).toBe(true);
		expect(hasBg(lit, "boxHeadBg")).toBe(false);
		expect(lit).toContain(theme.bold(theme.fg("activityAccent", "›")));
		expect(calm).not.toBe(lit);
		headerRegion(turn.summary).onHover?.(false);
		expect(headerRaw(turn.summary.render(WIDTH))).toBe(calm);
	});

	it("names its region the same way every frame, and changes no row or region place on hover", () => {
		const turn = finished();
		const first = turn.summary.render(WIDTH);
		const before = turn.summary.getClickRegions().map((region) => ({ line: region.line, height: region.height }));
		const key = headerRegion(turn.summary).hoverKey;
		expect(key).toBeDefined();
		headerRegion(turn.summary).onHover?.(true);
		const lit = turn.summary.render(WIDTH);
		expect(headerRegion(turn.summary).hoverKey).toBe(key);
		expect(lit).toHaveLength(first.length);
		expect(turn.summary.getClickRegions().map((region) => ({ line: region.line, height: region.height }))).toEqual(
			before,
		);
	});

	it("lights it for the keyboard focus too", () => {
		const turn = finished();
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = "header";
		turn.timeline.ui.bump();
		expect(hasBg(headerRaw(turn.summary.render(WIDTH)), "boxHeadHoverBg")).toBe(true);
	});

	it("lights the header of a box that is open, too", () => {
		const live = running();
		live.summary.render(WIDTH);
		headerRegion(live.summary).onHover?.(true);
		expect(hasBg(headerRaw(live.summary.render(WIDTH)), "boxHeadHoverBg")).toBe(true);
	});
});

describe("a folded box", () => {
	it("is one row: no frame lines at all", () => {
		const turn = finished();
		turn.summary.setHeaderShown(false);
		const lines = turn.summary.render(WIDTH);
		expect(lines).toHaveLength(1);
		expect(text(lines)).not.toMatch(/[╭╮╰╯├┤]/);
		expect(headerIndex(lines)).toBe(0);
	});

	it("keeps the frame around a failure it keeps on show", () => {
		setMotionReduced(true);
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
		const lines = turn.summary.render(WIDTH);
		const words = text(lines);
		expect(words).toContain("╭");
		expect(words).toContain("╰");
		expect(words).toContain("ModuleNotFoundError");
	});

	it("keeps the frame around a box that is open", () => {
		const turn = finished();
		turn.summary.toggleBox();
		const words = text(turn.summary.render(WIDTH));
		expect(words).toContain("╭");
		expect(words).toContain("╰");
		expect(words).toContain("npm test");
	});

	it("opens and folds from the same header row's click, whichever it is on", () => {
		const turn = finished();
		turn.summary.render(WIDTH);
		headerRegion(turn.summary).onClick({ row: 0, col: 0 });
		expect(turn.state.boxOpen).toBe(true);
		turn.summary.render(WIDTH);
		headerRegion(turn.summary).onClick({ row: 0, col: 0 });
		expect(turn.state.boxOpen).toBe(false);
	});
});

describe("a narrow terminal", () => {
	const widths = [80, 50, 40, 30, 24, 20];

	it("keeps the pill and the arrow, cuts the words, and drops the clock and tokens first", () => {
		expect(widths.length).toBeGreaterThan(0);
		let clockGone = false;
		let wordsCut = false;
		for (const width of widths) {
			const turn = finished();
			turn.summary.setHeaderShown(false);
			const [line] = turn.summary.render(width);
			const shown = stripAnsi(line ?? "");
			expect(visibleWidth(line ?? ""), `width ${width}`).toBeLessThanOrEqual(width);
			expect(shown, `width ${width}`).toContain("✓ 完成");
			expect(shown, `width ${width}`).toContain("›");
			if (!/秒 · ↓/.test(shown)) {
				clockGone = true;
				// Once the clock is gone, the words have all the room there is.
			}
			if (/跑了 1 条命令/.test(shown) === false) wordsCut = true;
		}
		expect(clockGone).toBe(true);
		expect(wordsCut).toBe(true);
	});

	it("drops the clock before it cuts the words", () => {
		for (const width of widths) {
			const turn = finished();
			turn.summary.setHeaderShown(false);
			const shown = stripAnsi(turn.summary.render(width)[0] ?? "");
			const hasClock = /秒 · ↓/.test(shown);
			const hasWords = shown.includes("跑了 1 条命令");
			if (hasClock) expect(hasWords, `width ${width}: the clock stays only beside whole words`).toBe(true);
		}
	});

	it("frames an open box down to the narrowest the frame can be", () => {
		for (const width of [40, 24, 12, 6, 4]) {
			const live = running();
			const lines = live.summary.render(width);
			for (const line of lines) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
		}
		expect(plain(running().summary.render(40)).join("\n")).toContain("进行中");
	});
});
