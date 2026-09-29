import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TurnActivityState, TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { BOX_FOCUS_MARKER } from "../src/modes/interactive/components/turn-box.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import {
	addCommand,
	addSay,
	addStep,
	hasBg,
	host,
	plain,
	type QuietTurn,
	quietTurn,
	T0,
	text,
} from "./ui-blocks-helpers.js";

beforeAll(() => {
	initTheme("prime");
});

afterEach(() => {
	vi.useRealTimers();
});

const WIDTH = 100;
/** An event line: time, the AI's diamond. */
const EVENT_LINE = /^ \d\d:\d\d {3}◆/;
/** The spinner line a running turn ends on. */
const SPINNER_LINE = /^ \d\d:\d\d {3}[⠀-⣿]/;
/** What the old pinned header said about rows out of sight and about folding. */
const OLD_HINT = /前面还有|往上滚|点框头可收起/;

/** A turn of `steps` commands whose event lists its steps. */
function openTurn(steps: number, options: { live?: boolean } = {}): QuietTurn {
	const turn = quietTurn({ live: options.live ?? true, host: host({ growBox: () => true, viewportRows: () => 40 }) });
	for (let index = 0; index < steps; index++) addCommand(turn, `c${index}`, `echo step-${index}`);
	turn.summary.toggleBox();
	return turn;
}

/** The click region on line `line` of the turn's last frame. */
function regionAt(turn: QuietTurn, line: number) {
	const region = turn.summary.getClickRegions().find((candidate) => candidate.line === line);
	if (!region) throw new Error(`no region on line ${line}`);
	return region;
}

describe("an open turn has no header to offer the window", () => {
	it("starts on its event line and ends on its spinner line, with no top or bottom rule and nothing pinned", () => {
		const turn = openTurn(6);
		const lines = turn.summary.render(WIDTH);
		const shown = plain(lines);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		expect(shown[0]).toMatch(EVENT_LINE);
		expect(shown[0]).toMatch(/6 步 ▴ {2}$/);
		expect(shown[lines.length - 1]).toMatch(SPINNER_LINE);
		expect(shown.some((line) => /^ ?[╭╰]─+[╮╯]$/.test(line))).toBe(false);
	});

	it("keeps the lines where they are with no title line of its own and a blank above it", () => {
		const turn = openTurn(3);
		turn.summary.setHeaderShown(false);
		turn.summary.setLeadingRows(1);
		const lines = turn.summary.render(WIDTH);
		const shown = plain(lines);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		// The blank line above is a blank line of the rail; the first event follows it.
		expect(shown[0]?.trimEnd()).toBe("         │");
		expect(shown[1]).toMatch(EVENT_LINE);
		expect(shown[lines.length - 1]).toMatch(SPINNER_LINE);
	});

	it("offers nothing while the turn is folded, open, before it renders, or in the older two-line view", () => {
		const turn = openTurn(3);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		turn.summary.render(WIDTH);
		expect(turn.state.boxOpen).toBe(true);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		turn.summary.render(WIDTH);
		expect(turn.state.boxOpen).toBe(false);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		turn.summary.toggleBox();
		turn.summary.render(WIDTH);
		expect(turn.state.boxOpen).toBe(true);
		expect(turn.summary.getStickyHeaders()).toEqual([]);

		const legacy = new TurnSummaryComponent(new TurnActivityState());
		legacy.render(WIDTH);
		expect(legacy.getStickyHeaders()).toEqual([]);
	});
});

describe("what the lines say instead of pinned rows", () => {
	it("draws the event line once, in place, and pins no copy of it", () => {
		const turn = openTurn(5);
		const lines = turn.summary.render(WIDTH);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		expect(plain(lines).filter((line) => line.includes("跑了 5 条命令"))).toHaveLength(1);
	});

	it("follows the state in place: the running clock and a hover", () => {
		vi.useFakeTimers({ now: 1_700_000_000_000 });
		const turn = quietTurn();
		addStep(turn, "r1", "await bash('sleep 5')", "running", Date.now() - 1_000);
		turn.summary.toggleBox();
		const first = plain(turn.summary.render(WIDTH));
		const clockOf = (shown: string[]) => shown.find((line) => line.includes("在跑"))?.match(/(\d+)秒/)?.[1];
		expect(clockOf(first)).toBe("1");
		vi.advanceTimersByTime(7_000);
		const later = plain(turn.summary.render(WIDTH));
		expect(clockOf(later)).toBe("8");
		expect(later.find((line) => line.includes("sleep 5") && !line.includes("在跑"))).toMatch(/8秒/);

		regionAt(turn, 0).onHover?.(true);
		const lit = turn.summary.render(WIDTH);
		expect(hasBg(lit[0] ?? "", "timelineHoverBg")).toBe(true);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
	});

	it("is the same after the turn, finished and unchanged, is served from its cache", () => {
		const turn = openTurn(4, { live: false });
		turn.state.markTurnEnded();
		const first = turn.summary.render(WIDTH);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		expect(turn.summary.render(WIDTH)).toBe(first);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
	});

	it("carries the keyboard-focus marker on one line only: the event line in the transcript", () => {
		const turn = openTurn(4);
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = "header";
		turn.timeline.ui.bump();
		const lines = turn.summary.render(WIDTH);
		expect(lines.filter((line) => line.includes(BOX_FOCUS_MARKER))).toHaveLength(1);
		expect(lines[0]?.startsWith(BOX_FOCUS_MARKER)).toBe(true);
		expect(plain(lines)[0]).toMatch(EVENT_LINE);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
	});

	it("draws no hint about what is out of sight or that a click folds the turn", () => {
		const turn = openTurn(12);
		const words = text(turn.summary.render(WIDTH));
		expect(words).not.toMatch(OLD_HINT);
		expect(words).not.toContain("↑");
		expect(turn.summary.getStickyHeaders()).toEqual([]);
	});

	it("counts the steps once, in the event's own count, and the ones it does not list in `另外 N 步`", () => {
		const counts = [1, 2, 3, 4, 10, 40];
		expect(counts.length).toBeGreaterThan(0);
		for (const count of counts) {
			const shown = plain(openTurn(count).summary.render(WIDTH));
			expect(shown[0], `${count} steps`).toMatch(new RegExp(`${count} 步 ▴ {2}$`));
			const hidden = shown.find((line) => line.includes("另外"));
			if (count > 3) expect(hidden, `${count} steps`).toContain(`另外 ${count - 3} 步`);
			else expect(hidden, `${count} steps`).toBeUndefined();
			expect(shown.join("\n"), `${count} steps`).not.toMatch(OLD_HINT);
		}
	});

	it("does not count a short note the AI said between steps: it is the event line, not a step", () => {
		const turn = quietTurn({ host: host({ growBox: () => true }) });
		addSay(turn, "先说一句。", "n1", T0);
		addStep(turn, "c1", "await bash('echo one')", "done", T0 + 500);
		addSay(turn, "再说一句。", "n2", T0 + 1_000);
		addStep(turn, "c2", "await bash('echo two')", "done", T0 + 1_500);
		turn.summary.toggleBox();
		const shown = plain(turn.summary.render(WIDTH));
		const events = shown.filter((line) => EVENT_LINE.test(line));
		expect(events).toHaveLength(2);
		expect(events[0]).toMatch(/先说一句。 +2 步 ▴ {2}$/);
		expect(events[1]).toMatch(/再说一句。 +2 步 ▴ {2}$/);
		const steps = shown.filter((line) => /^ {9}│ {11}\S/.test(line));
		expect(steps).toHaveLength(4);
		expect(steps.some((line) => line.includes("先说一句") || line.includes("再说一句"))).toBe(false);
	});

	it("draws no hint at all when nothing is out of sight", () => {
		const turn = openTurn(6);
		const words = text(turn.summary.render(WIDTH));
		expect(words).not.toMatch(OLD_HINT);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
	});

	it("keeps every line inside a narrow terminal", () => {
		const turn = openTurn(8);
		for (const width of [60, 40, 24, 12]) {
			turn.summary.invalidate();
			const lines = turn.summary.render(width);
			expect(lines.length, `width ${width}`).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
			expect(turn.summary.getStickyHeaders(), `width ${width}`).toEqual([]);
		}
	});

	it("tells a running turn from a finished one by its last line, and draws no frame in either", () => {
		const live = openTurn(3);
		const liveShown = plain(live.summary.render(WIDTH));
		const done = openTurn(3, { live: false });
		done.state.markTurnEnded();
		const doneShown = plain(done.summary.render(WIDTH));
		expect(liveShown.at(-1)).toMatch(SPINNER_LINE);
		expect(doneShown.some((line) => SPINNER_LINE.test(line))).toBe(false);
		expect(doneShown.at(-1)).toMatch(/\$ +echo step-\d/);
		for (const shown of [liveShown, doneShown]) expect(shown.join("\n")).not.toMatch(/[╭╮╰╯]/);
	});
});

describe("a click on the event line", () => {
	it("has one region on the event line, no second one on a pinned copy", () => {
		const turn = openTurn(5);
		turn.summary.render(WIDTH);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		const onFirst = turn.summary.getClickRegions().filter((candidate) => candidate.line === 0);
		expect(onFirst).toHaveLength(1);
		const [region] = onFirst;
		expect(region?.height).toBe(1);
		expect(region?.col).toBe(0);
		expect(region?.width).toBe(WIDTH);
		expect(region?.hoverKey).toBe(`${turn.timeline.ui.id}:${turn.summary.getFocusOrder()[0]}`);
	});

	it("folds the whole event, and leaves nothing pinned behind", () => {
		const turn = openTurn(5);
		turn.summary.render(WIDTH);
		expect(turn.state.boxOpen).toBe(true);
		regionAt(turn, 0).onClick({ row: 0, col: 3 });
		expect(turn.state.boxOpen).toBe(false);
		turn.summary.render(WIDTH);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
	});

	it("does not ask the window to scroll: the event is open already", () => {
		const turn = openTurn(5);
		turn.summary.render(WIDTH);
		expect(regionAt(turn, 0).revealBelow ?? 0).toBe(0);
	});

	it("asks the window for the rows opening it adds, while the event is folded", () => {
		const turn = openTurn(5);
		turn.summary.toggleBox();
		turn.summary.render(WIDTH);
		expect(turn.state.boxOpen).toBe(false);
		// The first three steps and the `另外 2 步` line.
		expect(regionAt(turn, 0).revealBelow).toBe(4);
	});
});

describe("steps the window has to see", () => {
	it("lists every step on an inline host as well, so there is no partial view to pin", () => {
		const turn = quietTurn({ host: host({ growBox: () => false, viewportRows: () => 20 }) });
		for (let index = 0; index < 20; index++) addStep(turn, `s${index}`, `await bash('echo ${index}')`);
		const folded = plain(turn.summary.render(WIDTH));
		expect(folded[0]).toMatch(/20 步 ▸ {2}$/);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		turn.summary.toggleBox();
		turn.summary.render(WIDTH);
		const all = turn.summary.getFocusOrder().find((key) => key.startsWith("all:"));
		expect(all).toBeDefined();
		turn.summary.activate(all ?? "");
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines.filter((line) => /\$ +echo \d+/.test(line))).toHaveLength(20);
		expect(text(lines)).not.toMatch(OLD_HINT);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
	});
});
