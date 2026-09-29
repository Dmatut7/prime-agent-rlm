import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { TurnActivityState, TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { BOX_FOCUS_MARKER } from "../src/modes/interactive/components/turn-box.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { headerIndex, headerRaw } from "./grow-box-helpers.js";
import { addCommand, addSay, addStep, host, plain, type QuietTurn, quietTurn } from "./ui-blocks-helpers.js";

beforeAll(() => {
	initTheme("prime");
});

afterEach(() => {
	vi.useRealTimers();
	setMotionReduced(false);
});

const WIDTH = 100;

function openTurn(steps: number, options: { live?: boolean } = {}): QuietTurn {
	setMotionReduced(true);
	const turn = quietTurn({ live: options.live ?? true, host: host({ growBox: () => true, viewportRows: () => 40 }) });
	for (let index = 0; index < steps; index++) addCommand(turn, `c${index}`, `echo step-${index}`);
	return turn;
}

/** Only pinned header of the box, once the box has rendered. */
function pinned(turn: QuietTurn) {
	const headers = turn.summary.getStickyHeaders();
	expect(headers).toHaveLength(1);
	const [header] = headers;
	if (!header) throw new Error("no sticky header");
	return header;
}

const hint = (rows: readonly string[]): string => stripAnsi(rows[1] ?? "");

describe("an open box offers its header to the window", () => {
	it("says where the box's first row (its top rule, just above the header row) and its last row are in its own output", () => {
		const turn = openTurn(6);
		const lines = turn.summary.render(WIDTH);
		const header = pinned(turn);
		expect(header.line).toBe(headerIndex(lines) - 1);
		expect(header.line).toBeGreaterThan(0);
		expect(plain(lines)[header.line]).toMatch(/^ ╭─+╮$/);
		expect(header.endLine).toBe(lines.length - 1);
		expect(plain(lines)[header.endLine]).toMatch(/^ ╰─+╯$/);
	});

	it("keeps the offsets right when the box has no `◆ prime` line of its own or a blank above it", () => {
		const turn = openTurn(3);
		turn.summary.setHeaderShown(false);
		turn.summary.setLeadingBlank(true);
		const lines = turn.summary.render(WIDTH);
		const header = pinned(turn);
		expect(header.line).toBe(headerIndex(lines) - 1);
		expect(plain(lines)[0]).toBe("");
		expect(header.endLine).toBe(lines.length - 1);
	});

	it("offers nothing while the box is folded, before it renders, or in the older two-line view", () => {
		const turn = openTurn(3);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		turn.summary.render(WIDTH);
		expect(turn.summary.getStickyHeaders()).toHaveLength(1);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		turn.summary.render(WIDTH);
		expect(turn.state.boxOpen).toBe(false);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
		turn.summary.toggleBox();
		turn.summary.render(WIDTH);
		expect(turn.summary.getStickyHeaders()).toHaveLength(1);

		const legacy = new TurnSummaryComponent(new TurnActivityState());
		legacy.render(WIDTH);
		expect(legacy.getStickyHeaders()).toEqual([]);
	});
});

describe("what the pinned rows say", () => {
	it("repeats the header card exactly as it is drawn in place", () => {
		const turn = openTurn(5);
		const lines = turn.summary.render(WIDTH);
		const rows = pinned(turn).render(0);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toBe(headerRaw(lines));
	});

	it("follows the header's state: the spinner, the running clock and a hover", () => {
		vi.useFakeTimers({ now: 1_700_000_000_000 });
		const turn = openTurn(3);
		const first = turn.summary.render(WIDTH);
		expect(pinned(turn).render(0)[0]).toBe(headerRaw(first));
		vi.advanceTimersByTime(7_000);
		const later = turn.summary.render(WIDTH);
		expect(headerRaw(later)).not.toBe(headerRaw(first));
		expect(pinned(turn).render(0)[0]).toBe(headerRaw(later));

		const region = pinned(turn).regions?.[0];
		region?.onHover?.(true);
		const lit = turn.summary.render(WIDTH);
		expect(pinned(turn).render(0)[0]).toBe(headerRaw(lit));
		expect(headerRaw(lit)).not.toBe(headerRaw(later));
	});

	it("is the same after the box, finished and unchanged, is served from its cache", () => {
		const turn = openTurn(4, { live: false });
		turn.state.markTurnEnded();
		turn.summary.toggleBox();
		const first = turn.summary.render(WIDTH);
		const rows = pinned(turn).render(3);
		expect(turn.summary.render(WIDTH)).toBe(first);
		expect(pinned(turn).render(3)).toEqual(rows);
	});

	it("leaves the keyboard-focus marker out of the copy: only the row in the transcript carries it", () => {
		const turn = openTurn(4);
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = "header";
		turn.timeline.ui.bump();
		const lines = turn.summary.render(WIDTH);
		expect(lines.filter((line) => line.includes(BOX_FOCUS_MARKER))).toHaveLength(1);
		const rows = pinned(turn).render(0);
		expect(rows.join("")).not.toContain(BOX_FOCUS_MARKER);
		expect(rows[0]).toBe(headerRaw(lines).split(BOX_FOCUS_MARKER).join(""));
	});

	it("puts a faint hint under it, inside the frame, that says what is out of sight and that a click folds the box", () => {
		const turn = openTurn(12);
		turn.summary.render(WIDTH);
		// The window's top is 7 rows under the header row, 8 under the top rule the pin counts from.
		const rows = pinned(turn).render(8);
		expect(hint(rows)).toMatch(/^ │ ↑ 前面还有 4 步，往上滚就能看到 · 点框头可收起 +│$/);
		expect(visibleWidth(rows[1] ?? "")).toBe(WIDTH);
	});

	it("counts the blocks the pinned rows cover or the window has scrolled past", () => {
		const turn = openTurn(10);
		turn.summary.render(WIDTH);
		const header = pinned(turn);
		// A block is two lines and the first one starts two lines under the header row: it counts once the
		// window's top is past the header (or the pinned rows cover it). The pin counts rows from the top
		// rule, one above the header row.
		const counts = [0, 1, 2, 3, 4, 9, 10, 40].map((below) => {
			const match = /前面还有 (\d+) 步/.exec(hint(header.render(below + 1)));
			return match ? Number(match[1]) : 0;
		});
		expect(counts).toEqual([0, 1, 1, 2, 2, 5, 5, 10]);
	});

	it("does not count a short note the AI said between steps: it is not a block", () => {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ growBox: () => true }) });
		addSay(turn, "先说一句。", "n1");
		addCommand(turn, "c1", "echo one");
		addSay(turn, "再说一句。", "n2");
		addCommand(turn, "c2", "echo two");
		turn.summary.render(WIDTH);
		const words = hint(pinned(turn).render(200));
		const blocks = plain(turn.summary.render(WIDTH)).filter((line) => /^ │ +[▸▾] /.test(line)).length;
		expect(blocks).toBeGreaterThan(0);
		expect(words).toContain(`前面还有 ${blocks} 步`);
	});

	it("says only that a click folds the box when no block is out of sight", () => {
		const turn = openTurn(6);
		turn.summary.render(WIDTH);
		expect(hint(pinned(turn).render(0))).toMatch(/^ │ 点框头可收起 +│$/);
	});

	it("keeps the hint inside a narrow terminal", () => {
		const turn = openTurn(8);
		for (const width of [60, 40, 24, 12]) {
			turn.summary.invalidate();
			turn.summary.render(width);
			const rows = pinned(turn).render(9);
			expect(visibleWidth(rows[0] ?? ""), `header at ${width}`).toBeLessThanOrEqual(width);
			expect(visibleWidth(rows[1] ?? ""), `hint at ${width}`).toBeLessThanOrEqual(width);
		}
	});

	it("marks its frame the way the box does while the turn runs and after", () => {
		const live = openTurn(3);
		live.summary.render(WIDTH);
		const liveRows = pinned(live).render(3);
		const done = openTurn(3, { live: false });
		done.state.markTurnEnded();
		done.summary.toggleBox();
		done.summary.render(WIDTH);
		const doneRows = pinned(done).render(3);
		expect(liveRows[1]).not.toBe(doneRows[1]);
	});
});

describe("a click on the pinned header", () => {
	it("has one region on the header row, the same the box's own header has", () => {
		const turn = openTurn(5);
		turn.summary.render(WIDTH);
		const header = pinned(turn);
		expect(header.regions).toHaveLength(1);
		const [region] = header.regions ?? [];
		expect(region?.line).toBe(0);
		expect(region?.height).toBe(1);
		expect(region?.col).toBe(0);
		const inPlace = turn.summary.getClickRegions().find((candidate) => candidate.line === header.line + 1);
		expect(inPlace?.hoverKey).toBeDefined();
		expect(region?.hoverKey).toBe(inPlace?.hoverKey);
	});

	it("folds the whole box, as the header in place does", () => {
		const turn = openTurn(5);
		turn.summary.render(WIDTH);
		const region = pinned(turn).regions?.[0];
		expect(turn.state.boxOpen).toBe(true);
		region?.onClick({ row: 0, col: 3 });
		expect(turn.state.boxOpen).toBe(false);
		turn.summary.render(WIDTH);
		expect(turn.summary.getStickyHeaders()).toEqual([]);
	});

	it("does not ask the window to scroll: the box is open already", () => {
		const turn = openTurn(5);
		turn.summary.render(WIDTH);
		expect(pinned(turn).regions?.[0]?.revealBelow ?? 0).toBe(0);
	});
});

describe("steps the window has to see", () => {
	it("counts blocks by the lines they have when the box shows only part of them (an inline box)", () => {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ growBox: () => false, viewportRows: () => 20 }) });
		for (let index = 0; index < 20; index++) addStep(turn, `s${index}`, `await bash('echo ${index}')`);
		const lines = turn.summary.render(WIDTH);
		const header = pinned(turn);
		expect(header.line).toBe(headerIndex(lines) - 1);
		const shown = plain(lines).filter((line) => /\$ echo/.test(line)).length;
		expect(shown).toBeLessThan(20);
		expect(hint(header.render(400))).toContain(`前面还有 ${shown} 步`);
	});
});
