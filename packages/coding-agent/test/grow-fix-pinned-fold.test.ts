import { Container, setKeybindings, Text, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addStep, host, plain, type QuietTurn, quietTurn, T0 } from "./ui-blocks-helpers.js";

/**
 * Folding an open event from the window. The timeline pins nothing above the window: an event folds from
 * its own line, and the folded line lands on the row the event started on, where the window's top row is.
 */

const WIDTH = 70;
const ROWS = 14;
const STEPS = 30;
const screens: TUI[] = [];

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	for (const tui of screens.splice(0)) tui.stop();
	setMotionReduced(false);
});

/** A finished command step with a timestamp of its own (steps stamped in one millisecond share a message). */
function addTimedCommand(turn: QuietTurn, index: number, ok = true): void {
	const id = `c${index}`;
	const label = `echo step-${index}`;
	addStep(turn, id, `await bash(${JSON.stringify(label)})`, ok ? "done" : "error", T0 - 600_000 + index * 1_000);
	turn.timeline.mergeStep(
		id,
		"ipython",
		{},
		{
			details: {
				activities: [
					{
						id: `${id}-a`,
						kind: "command",
						label,
						status: ok ? "ok" : "error",
						detail: "done",
						startedAt: 1,
						endedAt: 2,
					},
				],
			},
		},
		false,
	);
}

function openTurn(steps: number): QuietTurn {
	setMotionReduced(true);
	const turn = quietTurn({ host: host({ viewportRows: () => ROWS }) });
	for (let index = 0; index < steps; index++) addTimedCommand(turn, index);
	return turn;
}

/** The turn's first event, opened with every step listed (`全部 ›` taken). */
function listEverySteps(turn: QuietTurn): string {
	turn.summary.render(WIDTH);
	const eventKey = turn.summary.getFocusOrder().find((key) => key.startsWith("ev:")) ?? "";
	expect(eventKey).not.toBe("");
	turn.summary.activate(eventKey);
	turn.summary.render(WIDTH);
	expect(turn.summary.activate(`all:${eventKey}`)).toBe(true);
	turn.summary.render(WIDTH);
	return eventKey;
}

describe("the event line's row", () => {
	for (const [name, shown, blank] of [
		["with the `◆ prime` line asked for", true, false],
		["without it", false, false],
		["with a blank line above", false, true],
	] as const) {
		it(`is the row a folded event stays on, ${name}`, () => {
			const turn = openTurn(6);
			turn.summary.setHeaderShown(shown);
			turn.summary.setLeadingBlank(blank);
			turn.summary.toggleBox();
			const open = plain(turn.summary.render(WIDTH));
			const line = open.findIndex((row) => row.trimEnd().endsWith("6 步 ▴"));
			// The `◆ prime` title line is gone: the event is the first line, or the second under a blank line.
			expect(line).toBe(blank ? 1 : 0);
			expect(open.join("\n")).not.toContain("◆ prime");
			expect(open[line + 1]).toContain("$  echo step-0");
			expect(turn.summary.getStickyHeaders()).toHaveLength(0);
			turn.summary.toggleBox();
			const folded = plain(turn.summary.render(WIDTH));
			expect(turn.state.boxOpen).toBe(false);
			expect(folded.findIndex((row) => row.trimEnd().endsWith("6 步 ▸"))).toBe(line);
			expect(turn.summary.getStickyHeaders()).toHaveLength(0);
		});
	}

	it("is the row the first event stays on when a failure that ended the turn keeps its own red line after the fold", () => {
		setMotionReduced(true);
		const turn = quietTurn({ live: false, host: host({ viewportRows: () => ROWS }) });
		addTimedCommand(turn, 0);
		addTimedCommand(turn, 1, false);
		addTimedCommand(turn, 2);
		turn.state.markTurnEnded(T0);
		turn.state.finishBox(T0);
		turn.summary.toggleBox();
		const open = plain(turn.summary.render(WIDTH));
		const line = open.findIndex((row) => row.trimEnd().endsWith("2 步 ▴"));
		expect(line).toBe(0);
		expect(open.findIndex((row) => row.includes("出错"))).toBeGreaterThan(line + 2);
		turn.summary.toggleBox();
		const folded = plain(turn.summary.render(WIDTH));
		expect(turn.state.boxOpen).toBe(false);
		expect(folded.findIndex((row) => row.trimEnd().endsWith("2 步 ▸"))).toBe(line);
		// Nothing of the steps is left on show, but the failure keeps its line right under the first event.
		expect(folded.filter((row) => row.includes("$  echo"))).toHaveLength(0);
		expect(folded[line + 1]).toContain("出错");
		expect(turn.summary.getStickyHeaders()).toHaveLength(0);
	});

	it("says how many steps are out of sight on the event's own lines, and pins no hint of it", () => {
		const turn = openTurn(12);
		const closed = plain(turn.summary.render(WIDTH));
		expect(closed[0]?.trimEnd().endsWith("12 步 ▸")).toBe(true);
		turn.summary.toggleBox();
		const open = plain(turn.summary.render(WIDTH));
		expect(open[0]?.trimEnd().endsWith("12 步 ▴")).toBe(true);
		// Three steps are listed; the rest is one line saying how many, then `全部 ›`.
		expect(open.filter((row) => row.includes("$  echo step-"))).toHaveLength(3);
		const more = open.find((row) => row.includes("另外 9 步")) ?? "";
		expect(more.trimEnd().endsWith("全部 ›")).toBe(true);
		expect(turn.summary.getStickyHeaders()).toHaveLength(0);
		for (const row of open) expect(row).not.toContain("前面还有");
	});
});

interface Screen {
	terminal: VirtualTerminal;
	tui: TUI;
	turn: QuietTurn;
	click(row: number): Promise<void>;
	row(index: number): string;
}

async function startScreen(): Promise<Screen> {
	const terminal = new VirtualTerminal(WIDTH, ROWS);
	const tui = new TUI(terminal);
	const turn = openTurn(STEPS);
	listEverySteps(turn);
	const chat = new Container();
	chat.addChild(new Text("earlier chat", 0, 0));
	chat.addChild(turn.summary);
	chat.addChild(new Text(Array.from({ length: 40 }, (_, index) => `after ${index}`).join("\n"), 0, 0));
	const dock = new Container();
	dock.addChild(new Text("prompt", 0, 0));
	tui.addChild(chat);
	tui.addChild(dock);
	tui.start();
	tui.enterFullscreen({ scroll: [chat], dock, mouse: true });
	screens.push(tui);
	await terminal.waitForRender();
	return {
		terminal,
		tui,
		turn,
		click: async (row) => {
			terminal.sendInput(`\x1b[<0;10;${row}M`);
			terminal.sendInput(`\x1b[<0;10;${row}m`);
			await terminal.waitForRender();
		},
		row: (index) => stripAnsi(terminal.getViewport()[index] ?? ""),
	};
}

describe("a click on the top row of the fullscreen window", () => {
	it("folds the event and leaves the folded line at the window's top row", async () => {
		const screen = await startScreen();
		screen.tui.scrollToTop();
		// "earlier chat" is the first chat line; the window's top row is the event's own line.
		screen.tui.scrollBy(1);
		await screen.terminal.waitForRender();
		expect(screen.row(0)).toMatch(/◆ +跑了 30 条命令 +30 步 ▴\s*$/);
		expect(screen.row(1)).toContain("$  echo step-0");

		await screen.click(1);

		expect(screen.turn.state.boxOpen).toBe(false);
		expect(screen.row(0)).toMatch(/◆ +跑了 30 条命令 +30 步 ▸\s*$/);
		const below = Array.from({ length: ROWS }, (_, index) => screen.row(index)).join("\n");
		expect(below).toContain("after 0");
		expect(below).not.toContain("$  echo step-");
		expect(screen.turn.summary.getStickyHeaders()).toHaveLength(0);
	});

	it("acts on the step under it once the event line has scrolled out of sight: nothing is pinned above it", async () => {
		const screen = await startScreen();
		screen.tui.scrollToTop();
		// The window's top is the first step, just under the event line (where a pinned header used to come up).
		screen.tui.scrollBy(2);
		await screen.terminal.waitForRender();
		expect(screen.row(0)).toContain("$  echo step-0");
		expect(screen.row(0)).not.toContain("30 步");
		expect(screen.turn.summary.getStickyHeaders()).toHaveLength(0);

		await screen.click(1);

		// The click opens that step; it does not fold the event.
		expect(screen.turn.state.boxOpen).toBe(true);
		expect(screen.turn.timeline.ui.expanded.has("act:c0:c0-a")).toBe(true);
		expect(screen.row(0)).toContain("$  echo step-0");
		expect(screen.row(1)).toContain("echo step-0");
		expect(Array.from({ length: ROWS }, (_, index) => screen.row(index)).join("\n")).toContain("结果");
	});
});
