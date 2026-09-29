import { FullscreenViewport } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { BOX_FOCUS_MARKER, boxBodyRows } from "../src/modes/interactive/components/turn-box.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addCommand, addStep, host, plain, type QuietTurn, quietTurn, text } from "./ui-blocks-helpers.js";

beforeAll(() => {
	initTheme("prime");
});

afterEach(() => {
	vi.useRealTimers();
	setMotionReduced(false);
});

const SCREEN = 30;

function growingTurn(steps: number, options: { grow?: boolean } = {}): QuietTurn {
	const turn = quietTurn({ host: host({ viewportRows: () => SCREEN, growBox: () => options.grow ?? true }) });
	for (let index = 0; index < steps; index++) {
		addStep(turn, `s${index}`, `await bash('echo step-${index}')`, "done", Date.now() - 4_000 + index);
	}
	return turn;
}

/** The order the box lists its steps in: the row a block is on, by its text. */
function stepOrder(lines: readonly string[]): number[] {
	return plain(lines).flatMap((line) => {
		const match = /\$ echo step-(\d+)/.exec(line);
		return match ? [Number(match[1])] : [];
	});
}

describe("a box in the fullscreen window grows with its content", () => {
	it("shows every step of a long turn, with no rows hidden above and no new-content bar", () => {
		const turn = growingTurn(60);
		const lines = turn.summary.render(100);
		expect(stepOrder(lines)).toHaveLength(60);
		expect(new Set(stepOrder(lines)).size).toBe(60);
		expect(text(lines)).not.toContain("上面还有");
		expect(text(lines)).not.toContain("有新内容");
		expect(lines.length).toBeGreaterThan(boxBodyRows(SCREEN) * 4);
	});

	it("grows by one block for each step that arrives, and never scrolls inside the frame", () => {
		const turn = growingTurn(20);
		const before = turn.summary.render(100).length;
		addStep(turn, "late", "await bash('echo step-late')", "done", Date.now() - 100);
		const after = turn.summary.render(100);
		expect(after.length).toBe(before + 2);
		expect(text(after)).toContain("echo step-late");
		expect(turn.timeline.ui.scrollBody(-5)).toBe(false);
		expect(turn.timeline.ui.scrollBody(5)).toBe(false);
	});

	it("gives the wheel to the page: none of the box's regions takes it", () => {
		const turn = growingTurn(40);
		turn.summary.render(100);
		const regions = turn.summary.getClickRegions();
		expect(regions.length).toBeGreaterThan(0);
		expect(regions.filter((region) => region.onWheel !== undefined)).toEqual([]);
	});

	it("keeps the fixed height and the inner scroll in an inline screen", () => {
		const inline = growingTurn(60, { grow: false });
		const lines = inline.summary.render(100);
		expect(text(lines)).toContain("上面还有");
		expect(stepOrder(lines).length).toBeLessThan(10);
		expect(inline.summary.getClickRegions().some((region) => region.onWheel !== undefined)).toBe(true);
	});

	it("follows the mode the host reports on the next frame", () => {
		let grow = false;
		const turn = quietTurn({ host: host({ viewportRows: () => SCREEN, growBox: () => grow }) });
		for (let index = 0; index < 40; index++) {
			addStep(turn, `s${index}`, `await bash('echo step-${index}')`, "done", Date.now() - 4_000 + index);
		}
		const inline = stepOrder(turn.summary.render(100)).length;
		grow = true;
		expect(stepOrder(turn.summary.render(100)).length).toBe(40);
		grow = false;
		expect(stepOrder(turn.summary.render(100)).length).toBe(inline);
	});
});

describe("opening a block in a growing box", () => {
	function withOutput(lineCount: number, options: { screen?: number } = {}): QuietTurn {
		const turn = quietTurn({ host: host({ viewportRows: () => options.screen ?? SCREEN, growBox: () => true }) });
		for (let index = 0; index < 6; index++) addCommand(turn, `c${index}`, `echo step-${index}`);
		const output = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join("\n");
		addCommand(turn, "big", "cat big.txt", { output });
		return turn;
	}

	function blockRegion(turn: QuietTurn, needle: string) {
		const lines = plain(turn.summary.render(100));
		const line = lines.findIndex((entry) => entry.includes(needle));
		const region = turn.summary.getClickRegions().find((candidate) => candidate.line === line && !candidate.passive);
		if (!region) throw new Error(`no clickable block for ${needle}`);
		return region;
	}

	it("grows in place by all the block's lines, however many, and says how many rows it will show below", () => {
		setMotionReduced(true);
		const turn = withOutput(60, { screen: 100 });
		const before = turn.summary.render(100).length;
		const region = blockRegion(turn, "cat big.txt");
		region.onHover?.(true);
		turn.summary.render(100);
		const pointed = blockRegion(turn, "cat big.txt");
		expect(pointed.revealBelow).toBeGreaterThanOrEqual(60);
		pointed.onClick({ row: 0, col: 0 });
		const after = turn.summary.render(100);
		expect(after.length - before).toBeGreaterThanOrEqual(60);
		expect(text(after)).toContain("line 1");
		expect(text(after)).toContain("line 60");
		expect(text(after)).not.toContain("上面还有");
	});

	it("shows all the lines of a tall block on the very next frame, so the window can keep the clicked row in place", () => {
		const turn = withOutput(60, { screen: 100 });
		const before = turn.summary.render(100).length;
		const region = blockRegion(turn, "cat big.txt");
		region.onHover?.(true);
		turn.summary.render(100);
		blockRegion(turn, "cat big.txt").onClick({ row: 0, col: 0 });
		const after = turn.summary.render(100);
		expect(after.length - before).toBeGreaterThanOrEqual(60);
		expect(text(after)).toContain("line 60");
	});

	it("never says there is new content below after a block was opened by hand", () => {
		setMotionReduced(true);
		const turn = withOutput(12);
		blockRegion(turn, "echo step-1").onClick({ row: 0, col: 0 });
		turn.summary.render(100);
		addStep(turn, "late", "await bash('echo late')", "done", Date.now() - 100);
		const lines = turn.summary.render(100);
		expect(text(lines)).toContain("echo late");
		expect(text(lines)).not.toContain("有新内容");
		expect(turn.summary.getClickRegions().some((region) => region.onWheel !== undefined)).toBe(false);
	});

	it("asks the window for at most one screen of rows", () => {
		setMotionReduced(true);
		const turn = withOutput(150, { screen: 40 });
		blockRegion(turn, "cat big.txt").onHover?.(true);
		turn.summary.render(100);
		expect(blockRegion(turn, "cat big.txt").revealBelow).toBe(40);
	});

	it("does not count the lines of every block while the pointer is elsewhere", () => {
		setMotionReduced(true);
		const turn = withOutput(60, { screen: 100 });
		const quiet = blockRegion(turn, "echo step-1");
		expect(quiet.revealBelow).toBeGreaterThan(0);
		expect(quiet.revealBelow).toBeLessThanOrEqual(8);
	});

	it("gives nothing to reveal when the block is already open", () => {
		setMotionReduced(true);
		const turn = withOutput(10);
		blockRegion(turn, "cat big.txt").onClick({ row: 0, col: 0 });
		turn.summary.render(100);
		expect(blockRegion(turn, "cat big.txt").revealBelow).toBe(0);
	});

	it("asks the window to show all of the body when a folded box opens", () => {
		setMotionReduced(true);
		const turn = withOutput(20, { screen: 100 });
		turn.state.markTurnEnded();
		turn.state.finishBox();
		const closed = turn.summary.render(100);
		expect(closed).toHaveLength(2);
		const header = turn.summary.getClickRegions().find((region) => region.line === 1);
		header?.onClick({ row: 0, col: 0 });
		const opened = turn.summary.render(100);
		// Exactly the rows the click adds: the frame's top, the rule under the header, the body and the bottom.
		expect(opened.length - closed.length).toBeGreaterThan(10);
		expect(header?.revealBelow).toBe(opened.length - closed.length);
	});
});

describe("walking the steps with the keyboard in a growing box", () => {
	/** The plain text of the line the box marks as focused, and its place among the box's lines. */
	function markedLine(turn: QuietTurn): { at: number; words: string } {
		const raw = turn.summary.render(100);
		const marked = raw.flatMap((line, index) => (line.includes(BOX_FOCUS_MARKER) ? [index] : []));
		expect(marked).toHaveLength(1);
		const at = marked[0] ?? -1;
		return { at, words: (plain(raw)[at] ?? "").trim() };
	}

	it("marks the focused block wherever it is in the box, so the window can scroll to it", () => {
		const turn = growingTurn(50);
		const ui = turn.timeline.ui;
		ui.focused = true;
		turn.summary.render(100);
		const order = turn.summary.getFocusOrder();
		expect(order.length).toBeGreaterThan(40);
		const seen = new Set<string>();
		for (const target of [order[1], order[25], order[order.length - 1]]) {
			ui.focusKey = target;
			ui.bump();
			const { words } = markedLine(turn);
			expect(words).toContain("$ echo step-");
			seen.add(words);
		}
		expect(seen.size).toBe(3);
	});

	it("scrolls the fullscreen window to the focused block, near the top and near the bottom of a tall box", () => {
		const turn = growingTurn(80);
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
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = "s5";
		const viewport = new FullscreenViewport();
		viewport.setRevealMarker(BOX_FOCUS_MARKER);
		const shown = viewport.composeFrame(turn.summary.render(100), [], 40).join("\n");
		expect(shown).not.toContain(BOX_FOCUS_MARKER);
	});
});

describe("the frames of a long box", () => {
	it("serves a finished box that did not change from its cache", () => {
		setMotionReduced(true);
		const turn = growingTurn(150);
		turn.state.markTurnEnded();
		turn.state.finishBox();
		turn.summary.toggleBox();
		const first = turn.summary.render(100);
		expect(first.length).toBeGreaterThan(300);
		expect(turn.summary.render(100)).toBe(first);
		expect(turn.summary.render(100)).toBe(first);
		turn.timeline.ui.setHover("s3", true);
		expect(turn.summary.render(100)).not.toBe(first);
	});
});
