import { Container, setKeybindings, Text, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { headerIndex } from "./grow-box-helpers.js";
import { addStep, host, plain, type QuietTurn, quietTurn, T0 } from "./ui-blocks-helpers.js";

/**
 * Folding a box from its pinned header: the folded card has to land where the window's top row is,
 * so the pin's `line` is the first row of the box (its top rule), the row the folded box starts on.
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
	const turn = quietTurn({ host: host({ growBox: () => true, viewportRows: () => ROWS }) });
	for (let index = 0; index < steps; index++) addTimedCommand(turn, index);
	return turn;
}

function pinnedLine(turn: QuietTurn): number {
	const [header] = turn.summary.getStickyHeaders();
	if (!header) throw new Error("no sticky header");
	return header.line;
}

describe("the pinned header's line", () => {
	for (const [name, shown, blank] of [
		["with the `◆ prime` line", true, false],
		["without it", false, false],
		["with a blank line above", false, true],
	] as const) {
		it(`is the row a folded box starts on, ${name}`, () => {
			const turn = openTurn(6);
			turn.summary.setHeaderShown(shown);
			turn.summary.setLeadingBlank(blank);
			const open = plain(turn.summary.render(WIDTH));
			const line = pinnedLine(turn);
			expect(open[line]).toMatch(/^ ╭─+╮$/);
			turn.summary.toggleBox();
			const folded = turn.summary.render(WIDTH);
			expect(turn.state.boxOpen).toBe(false);
			expect(headerIndex(folded)).toBe(line);
		});
	}

	it("is the row the framed box starts on when a failure keeps the frame after the fold", () => {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ growBox: () => true, viewportRows: () => ROWS }) });
		addTimedCommand(turn, 0);
		addTimedCommand(turn, 1, false);
		addTimedCommand(turn, 2);
		turn.summary.render(WIDTH);
		const line = pinnedLine(turn);
		turn.summary.toggleBox();
		const folded = plain(turn.summary.render(WIDTH));
		expect(folded[line]).toMatch(/^ ╭─+╮$/);
	});

	it("still says the same number of steps are out of sight for the same window top", () => {
		const turn = openTurn(12);
		const lines = turn.summary.render(WIDTH);
		const header = pinned(turn);
		const headerRow = headerIndex(lines);
		const hidden = (top: number): number => {
			const match = /前面还有 (\d+) 步/.exec(stripAnsi(header.render(top - header.line)[1] ?? ""));
			return match ? Number(match[1]) : 0;
		};
		// Blocks are two lines each and the first starts two lines under the header row.
		expect([0, 1, 2, 3, 4, 9, 10, 40].map((past) => hidden(headerRow + past))).toEqual([0, 1, 1, 2, 2, 5, 5, 12]);
	});
});

function pinned(turn: QuietTurn) {
	const [header] = turn.summary.getStickyHeaders();
	if (!header) throw new Error("no sticky header");
	return header;
}

interface Screen {
	terminal: VirtualTerminal;
	tui: TUI;
	turn: QuietTurn;
	click(row: number): Promise<void>;
	top(): string;
}

async function startScreen(): Promise<Screen> {
	const terminal = new VirtualTerminal(WIDTH, ROWS);
	const tui = new TUI(terminal);
	const turn = openTurn(STEPS);
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
		top: () => stripAnsi(terminal.getViewport()[0] ?? ""),
	};
}

describe("a click on the pinned header in the fullscreen window", () => {
	it("folds the box and shows the folded card at the window's top row", async () => {
		const screen = await startScreen();
		screen.tui.scrollToTop();
		screen.tui.scrollBy(12);
		await screen.terminal.waitForRender();
		expect(screen.top()).toMatch(/进行中/);
		expect(stripAnsi(screen.terminal.getViewport()[1] ?? "")).toContain("点框头可收起");

		await screen.click(1);

		expect(screen.turn.state.boxOpen).toBe(false);
		expect(screen.top()).toMatch(/进行中/);
		expect(screen.top()).toMatch(/›\s*$/);
		expect(stripAnsi(screen.terminal.getViewport()[1] ?? "")).toContain("after 0");
	});

	it("keeps the header row where it was when the pinned rows had just come up", async () => {
		const screen = await startScreen();
		screen.tui.scrollToTop();
		// The window's top is the header row itself (the top rule is just above it): the pin paints over the card in place.
		screen.tui.scrollBy(3);
		await screen.terminal.waitForRender();
		expect(screen.top()).toMatch(/进行中/);
		await screen.click(1);
		expect(screen.turn.state.boxOpen).toBe(false);
		expect(screen.top()).toMatch(/进行中/);
	});
});
