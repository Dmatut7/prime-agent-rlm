import { FullscreenViewport } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { BOX_FOCUS_MARKER } from "../src/modes/interactive/components/turn-box.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addCommand, addStep, host, plain, type QuietTurn, quietTurn, text } from "./ui-blocks-helpers.js";

beforeAll(() => {
	initTheme("prime");
});

const SCREEN = 30;

/** Rows the timeline asks the window to show for a closed step (`STEP_REVEAL` in turn-box.ts). */
const STEP_REVEAL = 8;

/** A running turn of `steps` finished commands: one event (the AI said nothing) that lists them. */
function growingTurn(steps: number, options: { grow?: boolean } = {}): QuietTurn {
	const turn = quietTurn({ host: host({ viewportRows: () => SCREEN, growBox: () => options.grow ?? true }) });
	for (let index = 0; index < steps; index++) {
		addStep(turn, `s${index}`, `await bash('echo step-${index}')`, "done", Date.now() - 4_000 + index);
	}
	return turn;
}

/** The order the timeline lists its steps in: the step a line is, by its text. */
function stepOrder(lines: readonly string[]): number[] {
	return plain(lines).flatMap((line) => {
		const match = /\$ +echo step-(\d+)/.exec(line);
		return match ? [Number(match[1])] : [];
	});
}

/** Open the turn's first event and list every step under it (`全部 ›`). */
function listAll(turn: QuietTurn): void {
	turn.summary.render(100);
	const event = turn.summary.getFocusOrder().find((key) => key.startsWith("ev:"));
	if (!event) throw new Error("the turn has no event");
	if (!turn.timeline.ui.expanded.has(event)) turn.summary.activate(event);
	turn.summary.render(100);
	const all = turn.summary.getFocusOrder().find((key) => key.startsWith("all:"));
	if (all) turn.summary.activate(all);
}

describe("a turn in the fullscreen window grows with its content", () => {
	it("shows every step of a long turn, with no rows hidden above and no new-content bar", () => {
		const turn = growingTurn(60);
		listAll(turn);
		const lines = turn.summary.render(100);
		expect(stepOrder(lines)).toEqual(Array.from({ length: 60 }, (_, index) => index));
		expect(text(lines)).not.toContain("上面还有");
		expect(text(lines)).not.toContain("有新内容");
		// The event line, the sixty steps, the `▴ 收起` line, one blank rail line and the spinner line: taller than two screens.
		expect(lines).toHaveLength(64);
		expect(lines.length).toBeGreaterThan(SCREEN * 2);
	});

	it("grows by one line for each step that arrives, and never scrolls inside the timeline", () => {
		const turn = growingTurn(20);
		listAll(turn);
		const before = turn.summary.render(100).length;
		addStep(turn, "late", "await bash('echo step-late')", "done", Date.now() - 100);
		const after = turn.summary.render(100);
		expect(after.length).toBe(before + 1);
		expect(text(after)).toContain("echo step-late");
		expect(plain(after)[0]).toMatch(/21 步 ▴ {2}$/);
		expect(turn.timeline.ui.scrollBody(-5)).toBe(false);
		expect(turn.timeline.ui.scrollBody(5)).toBe(false);
	});

	it("gives the wheel to the page: none of the timeline's regions takes it", () => {
		const turn = growingTurn(40);
		listAll(turn);
		turn.summary.render(100);
		const regions = turn.summary.getClickRegions();
		expect(regions.length).toBeGreaterThan(0);
		expect(regions.filter((region) => region.onWheel !== undefined)).toEqual([]);
	});

	it("draws an inline screen as it draws a fullscreen one: every step, and no inner scroll", () => {
		const inline = growingTurn(60, { grow: false });
		listAll(inline);
		const lines = inline.summary.render(100);
		const grown = growingTurn(60);
		listAll(grown);
		expect(text(lines)).not.toContain("上面还有");
		expect(stepOrder(lines)).toHaveLength(60);
		expect(stepOrder(lines)).toEqual(stepOrder(grown.summary.render(100)));
		expect(lines).toHaveLength(grown.summary.render(100).length);
		expect(inline.summary.getClickRegions().some((region) => region.onWheel !== undefined)).toBe(false);
	});

	it("ignores the mode the host reports: the next frame is the same in either", () => {
		let grow = false;
		const turn = quietTurn({ host: host({ viewportRows: () => SCREEN, growBox: () => grow }) });
		for (let index = 0; index < 40; index++) {
			addStep(turn, `s${index}`, `await bash('echo step-${index}')`, "done", Date.now() - 4_000 + index);
		}
		listAll(turn);
		const inline = stepOrder(turn.summary.render(100));
		expect(inline).toHaveLength(40);
		grow = true;
		expect(stepOrder(turn.summary.render(100))).toEqual(inline);
		grow = false;
		expect(stepOrder(turn.summary.render(100))).toEqual(inline);
	});
});

describe("opening a step in a growing turn", () => {
	/** Six commands and one that printed `lineCount` lines, all under one event that lists every step. */
	function withOutput(lineCount: number, options: { screen?: number } = {}): QuietTurn {
		const turn = quietTurn({ host: host({ viewportRows: () => options.screen ?? SCREEN }) });
		for (let index = 0; index < 6; index++) addCommand(turn, `c${index}`, `echo step-${index}`);
		const output = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join("\n");
		addCommand(turn, "big", "cat big.txt", { output });
		return turn;
	}

	function blockRegion(turn: QuietTurn, needle: string) {
		const lines = plain(turn.summary.render(100));
		const line = lines.findIndex((entry) => entry.includes(needle));
		const region = turn.summary.getClickRegions().find((candidate) => candidate.line === line && !candidate.passive);
		if (!region) throw new Error(`no clickable step for ${needle}`);
		return region;
	}

	it("grows in place by all the step's lines, however many, and asks the window for the rows below it", () => {
		const turn = withOutput(60, { screen: 100 });
		listAll(turn);
		const before = turn.summary.render(100).length;
		const region = blockRegion(turn, "cat big.txt");
		region.onHover?.(true);
		turn.summary.render(100);
		const pointed = blockRegion(turn, "cat big.txt");
		expect(pointed.revealBelow).toBe(STEP_REVEAL);
		pointed.onClick({ row: 0, col: 0 });
		const after = turn.summary.render(100);
		expect(after.length - before).toBeGreaterThanOrEqual(60);
		expect(text(after)).toContain("line 1");
		expect(text(after)).toContain("line 60");
		expect(text(after)).not.toContain("上面还有");
	});

	it("shows all the lines of a tall step on the very next frame, so the window can keep the clicked line in place", () => {
		const turn = withOutput(60, { screen: 100 });
		listAll(turn);
		const before = turn.summary.render(100).length;
		const region = blockRegion(turn, "cat big.txt");
		region.onHover?.(true);
		turn.summary.render(100);
		blockRegion(turn, "cat big.txt").onClick({ row: 0, col: 0 });
		const after = turn.summary.render(100);
		expect(after.length - before).toBeGreaterThanOrEqual(60);
		expect(text(after)).toContain("line 60");
	});

	it("never says there is new content below after a step was opened by hand", () => {
		const turn = withOutput(12);
		listAll(turn);
		blockRegion(turn, "echo step-1").onClick({ row: 0, col: 0 });
		turn.summary.render(100);
		addStep(turn, "late", "await bash('echo late')", "done", Date.now() - 100);
		const lines = turn.summary.render(100);
		expect(text(lines)).toContain("echo late");
		expect(text(lines)).not.toContain("有新内容");
		expect(turn.summary.getClickRegions().some((region) => region.onWheel !== undefined)).toBe(false);
	});

	it("asks the window for at most one screen of rows", () => {
		const small = withOutput(150, { screen: 5 });
		listAll(small);
		blockRegion(small, "cat big.txt").onHover?.(true);
		small.summary.render(100);
		expect(blockRegion(small, "cat big.txt").revealBelow).toBe(5);
		const tall = withOutput(150, { screen: 40 });
		listAll(tall);
		tall.summary.render(100);
		expect(blockRegion(tall, "cat big.txt").revealBelow).toBe(STEP_REVEAL);
	});

	it("does not count the lines of every step: a tall one asks for the same rows as a short one", () => {
		const turn = withOutput(60, { screen: 100 });
		listAll(turn);
		const quiet = blockRegion(turn, "echo step-1");
		expect(quiet.revealBelow).toBeGreaterThan(0);
		expect(quiet.revealBelow).toBeLessThanOrEqual(STEP_REVEAL);
		expect(blockRegion(turn, "cat big.txt").revealBelow).toBe(quiet.revealBelow);
	});

	it("gives nothing to reveal when the step is already open", () => {
		const turn = withOutput(10);
		listAll(turn);
		blockRegion(turn, "cat big.txt").onClick({ row: 0, col: 0 });
		turn.summary.render(100);
		expect(blockRegion(turn, "cat big.txt").revealBelow).toBe(0);
	});

	it("asks the window to show all the rows an event adds when a folded turn opens it", () => {
		const turn = withOutput(20, { screen: 100 });
		turn.state.markTurnEnded();
		turn.state.finishBox();
		const closed = turn.summary.render(100);
		expect(closed).toHaveLength(1);
		const header = turn.summary.getClickRegions().find((region) => region.line === 0);
		header?.onClick({ row: 0, col: 0 });
		const opened = turn.summary.render(100);
		// Exactly the rows the click adds: the first three steps and the `另外 4 步` line.
		expect(opened.length - closed.length).toBe(4);
		expect(header?.revealBelow).toBe(opened.length - closed.length);
	});
});

describe("walking the steps with the keyboard in a growing turn", () => {
	/** The plain text of the line the timeline marks as focused, and its place among the lines. */
	function markedLine(turn: QuietTurn): { at: number; words: string } {
		const raw = turn.summary.render(100);
		const marked = raw.flatMap((line, index) => (line.includes(BOX_FOCUS_MARKER) ? [index] : []));
		expect(marked).toHaveLength(1);
		const at = marked[0] ?? -1;
		return { at, words: (plain(raw)[at] ?? "").trim() };
	}

	it("marks the focused step wherever it is in the turn, so the window can scroll to it", () => {
		const turn = growingTurn(50);
		listAll(turn);
		const ui = turn.timeline.ui;
		ui.focused = true;
		turn.summary.render(100);
		const order = turn.summary.getFocusOrder();
		expect(order.length).toBeGreaterThan(40);
		const seen = new Set<string>();
		// The last target is the `▴ 收起` line under the steps; the last step is the one before it.
		for (const target of [order[1], order[25], order[order.length - 2]]) {
			ui.focusKey = target;
			ui.bump();
			const { words } = markedLine(turn);
			expect(words).toContain("$  echo step-");
			seen.add(words);
		}
		expect(seen.size).toBe(3);
	});

	it("scrolls the fullscreen window to the focused step, near the top and near the bottom of a tall turn", () => {
		const turn = growingTurn(150);
		listAll(turn);
		const ui = turn.timeline.ui;
		ui.focused = true;
		const viewport = new FullscreenViewport();
		const window = 14;
		const frame = (): string[] => viewport.composeFrame(turn.summary.render(100), [], window);
		frame();
		turn.summary.render(100);
		const order = turn.summary.getFocusOrder();
		expect(order.length).toBeGreaterThan(60);
		expect(turn.summary.render(100).length).toBeGreaterThan(window * 8);
		const picks = [order[3], order[order.length - 3], order[40], order[6]];
		expect(picks.every((pick) => pick !== undefined)).toBe(true);
		for (const pick of picks) {
			ui.focusKey = pick;
			ui.bump();
			const { words } = markedLine(turn);
			viewport.setRevealMarker(BOX_FOCUS_MARKER);
			expect(plain(frame()).join("\n"), `focus ${pick}`).toContain(words);
		}
	});

	it("does not leave the marker in what the window shows", () => {
		const turn = growingTurn(10);
		listAll(turn);
		turn.summary.render(100);
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = turn.summary.getFocusOrder()[6];
		turn.timeline.ui.bump();
		const lines = turn.summary.render(100);
		expect(lines.filter((line) => line.includes(BOX_FOCUS_MARKER))).toHaveLength(1);
		const viewport = new FullscreenViewport();
		viewport.setRevealMarker(BOX_FOCUS_MARKER);
		const shown = viewport.composeFrame(lines, [], 40).join("\n");
		expect(shown).not.toContain(BOX_FOCUS_MARKER);
	});
});

describe("the frames of a long turn", () => {
	it("serves a finished turn that did not change from its cache", () => {
		const turn = growingTurn(150);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		turn.summary.toggleBox();
		listAll(turn);
		const first = turn.summary.render(100);
		// The event line, its hundred and fifty steps and the `▴ 收起` line.
		expect(first).toHaveLength(152);
		expect(turn.summary.render(100)).toBe(first);
		expect(turn.summary.render(100)).toBe(first);
		turn.timeline.ui.setHover(turn.summary.getFocusOrder()[4] ?? "", true);
		expect(turn.summary.render(100)).not.toBe(first);
	});
});
