import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { BOX_FOCUS_MARKER } from "../src/modes/interactive/components/turn-box.js";
import { addSay, host, plain, type QuietTurn, quietTurn, T0, useTruecolorTheme } from "./ui-blocks-helpers.js";

/**
 * A running turn folds a long stretch of events into `⋯ 中间还有 N 件事`. What the user opened, and the
 * event the keyboard stands on, are not the fold's to take: they stay, with their steps, in the
 * focus order.
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

const WIDTH = 120;

function say(turn: QuietTurn, index: number): void {
	vi.setSystemTime(T0 + index * 10);
	addSay(turn, `第 ${index} 件：先查这个风险点。`, `s${index}`, T0 + index * 10);
}

function turnWith(count: number): QuietTurn {
	const turn = quietTurn({ host: host({ viewportRows: () => 60 }), startedAt: T0 - 5_000 });
	for (let index = 1; index <= count; index++) say(turn, index);
	return turn;
}

const rows = (turn: QuietTurn) => plain(turn.summary.render(WIDTH));
const eventKeys = (turn: QuietTurn) => turn.summary.getFocusOrder().filter((key) => key.startsWith("ev:"));
const shows = (turn: QuietTurn, index: number) => rows(turn).some((row) => row.includes(`第 ${index} 件：`));
const foldRows = (turn: QuietTurn) => rows(turn).filter((row) => row.includes("⋯  中间还有"));

/** The key of the event that says `第 index 件`, from the focus order after a render. */
function keyOfEvent(turn: QuietTurn, index: number): string {
	turn.summary.render(WIDTH);
	const position = rows(turn)
		.filter((row) => /^ {1}\d\d:\d\d {3}◆/.test(row))
		.findIndex((row) => row.includes(`第 ${index} 件：`));
	const key = eventKeys(turn)[position] ?? "";
	expect(key, `event ${index}`).not.toBe("");
	return key;
}

describe("a fold never takes an event the user opened", () => {
	it("keeps an opened event, its steps and its place in the focus order while more events arrive", () => {
		const turn = turnWith(4);
		expect(foldRows(turn)).toEqual([]);
		const key = keyOfEvent(turn, 2);
		turn.summary.activate(key);
		const before = rows(turn);
		const stepRows = before.filter((row) => /^ {9}│ {11}\S/.test(row) && !row.includes("⋯"));
		expect(stepRows.length).toBeGreaterThan(0);

		say(turn, 5);
		say(turn, 6);

		const after = rows(turn);
		expect(shows(turn, 2)).toBe(true);
		expect(after.filter((row) => /^ {9}│ {11}\S/.test(row) && !row.includes("⋯"))).toEqual(stepRows);
		expect(turn.summary.getFocusOrder()).toContain(key);
		expect(turn.summary.enterLabel(key)).toBe("收起");
		// The rest of the stretch still folds: events 3 and 4 are the run, 1 and 2 and the last two stay.
		expect(foldRows(turn)).toHaveLength(1);
		expect(foldRows(turn)[0]).toMatch(/中间还有 2 件事/);
		expect(shows(turn, 3)).toBe(false);
		expect(shows(turn, 4)).toBe(false);
		expect(shows(turn, 5)).toBe(true);
		expect(shows(turn, 6)).toBe(true);
	});

	it("keeps the latest event once opened when three more arrive: it stays, its step stays open, and it is reachable", () => {
		const turn = turnWith(4);
		const key = keyOfEvent(turn, 4);
		turn.summary.activate(key);
		const stepsBefore = rows(turn).filter((row) => /^ {9}│ {11}\S/.test(row) && !row.includes("⋯"));
		expect(stepsBefore).toHaveLength(1);
		say(turn, 5);
		say(turn, 6);
		say(turn, 7);
		expect(shows(turn, 4)).toBe(true);
		expect(rows(turn).filter((row) => /^ {9}│ {11}\S/.test(row) && !row.includes("⋯"))).toEqual(stepsBefore);
		expect(turn.summary.getFocusOrder()).toContain(key);
		expect(turn.summary.getFocusOrder().filter((candidate) => candidate.startsWith("step:"))).toHaveLength(1);
		expect(foldRows(turn)[0]).toMatch(/中间还有 2 件事/);
	});

	it("keeps the event the keyboard stands on, and paints its line as focused", () => {
		const turn = turnWith(4);
		const key = keyOfEvent(turn, 3);
		const ui = turn.timeline.ui;
		ui.focused = true;
		ui.focusKey = key;
		ui.bump();

		say(turn, 5);
		say(turn, 6);
		say(turn, 7);

		expect(shows(turn, 3)).toBe(true);
		expect(turn.summary.getFocusOrder()).toContain(key);
		const focusedLines = turn.summary.render(WIDTH).filter((line) => line.includes(BOX_FOCUS_MARKER));
		expect(focusedLines).toHaveLength(1);
		expect(plain(focusedLines)[0]).toContain("第 3 件：");
		// Events 2 and 3 stay (the second is the focused one); 4 and 5 are the run that folds.
		expect(shows(turn, 2)).toBe(true);
		expect(shows(turn, 4)).toBe(false);
		expect(shows(turn, 5)).toBe(false);
		expect(foldRows(turn)).toHaveLength(1);
		expect(foldRows(turn)[0]).toMatch(/中间还有 2 件事/);
	});

	it("keeps the focused step of an opened event reachable while more events arrive", () => {
		const turn = turnWith(4);
		const key = keyOfEvent(turn, 2);
		turn.summary.activate(key);
		turn.summary.render(WIDTH);
		const step = turn.summary.getFocusOrder().find((candidate) => !/^(?:ev|all|hid):/.test(candidate));
		expect(step).toBeDefined();
		const ui = turn.timeline.ui;
		ui.focused = true;
		ui.focusKey = step;
		ui.bump();
		say(turn, 5);
		say(turn, 6);
		say(turn, 7);
		expect(shows(turn, 2)).toBe(true);
		expect(turn.summary.getFocusOrder()).toContain(step);
		expect(turn.summary.render(WIDTH).filter((line) => line.includes(BOX_FOCUS_MARKER))).toHaveLength(1);
	});

	it("gives the event back to the fold once it is closed and the focus has left", () => {
		const turn = turnWith(4);
		const key = keyOfEvent(turn, 2);
		turn.summary.activate(key);
		say(turn, 5);
		say(turn, 6);
		expect(shows(turn, 2)).toBe(true);
		turn.summary.activate(key);
		expect(shows(turn, 2)).toBe(false);
		expect(foldRows(turn)[0]).toMatch(/中间还有 3 件事/);
	});

	it("does not fold the rest of an opened fold when an event inside it is opened", () => {
		const turn = turnWith(8);
		expect(foldRows(turn)[0]).toMatch(/中间还有 5 件事/);
		const hid = turn.summary.getFocusOrder().find((candidate) => candidate.startsWith("hid:")) ?? "";
		expect(hid).not.toBe("");
		turn.summary.activate(hid);
		const key = keyOfEvent(turn, 4);
		turn.summary.activate(key);

		for (let index = 1; index <= 8; index++) expect(shows(turn, index), `event ${index}`).toBe(true);
		expect(foldRows(turn)).toHaveLength(1);
		expect(foldRows(turn)[0]).toMatch(/收起$|收起 {2}$/);
		expect(turn.summary.getFocusOrder()).toContain(key);
	});
});
