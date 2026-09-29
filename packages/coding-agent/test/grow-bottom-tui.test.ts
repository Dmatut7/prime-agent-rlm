import { Container, setKeybindings, Text, TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type SubagentPanelRow,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

/**
 * The subagent strip in a real fullscreen TUI on a virtual terminal: the wheel
 * and the clicks arrive as terminal mouse reports, go through the dock's click
 * regions, and reach the strip the way the owner's mouse does.
 */

const COLUMNS = 60;
const ROWS = 10;

const rows: SubagentPanelRow[] = Array.from({ length: 10 }, (_, index) => ({
	id: `c${index}`,
	name: `agent-${index}`,
	state: "running" as const,
}));

interface Screen {
	terminal: VirtualTerminal;
	strip: SubagentSummaryLine;
	tui: TUI;
	onOpen: ReturnType<typeof vi.fn>;
	/** The screen row the strip is on: the dock is that single row. */
	stripRow: number;
	wheel(direction: -1 | 1, column?: number, row?: number): Promise<void>;
	click(column: number, row?: number): Promise<void>;
	move(column: number, row?: number): Promise<void>;
	stripText(): Promise<string>;
}

const screens: TUI[] = [];

/** The 1-based terminal column where `needle` starts in a row of text (wide characters take two columns). */
function columnOf(text: string, needle: string): number {
	const at = text.indexOf(needle);
	if (at < 0) throw new Error(`${needle} is not in ${text}`);
	return visibleWidth(text.slice(0, at)) + 1;
}

async function createScreen(options: { openable?: boolean } = {}): Promise<Screen> {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const tui = new TUI(terminal);
	const strip = new SubagentSummaryLine();
	strip.setSubagentCounts({ total: rows.length, running: rows.length, idle: 0, inactive: 0 });
	strip.setSubagentRows(rows);
	strip.setOpenable(options.openable ?? true);
	const onOpen = vi.fn();
	strip.onOpen = onOpen;
	const chat = new Text(Array.from({ length: 40 }, (_, index) => `chat line ${index}`).join("\n"), 0, 0);
	const dock = new Container();
	dock.addChild(strip);
	tui.addChild(chat);
	tui.addChild(dock);
	tui.start();
	tui.enterFullscreen({ scroll: [chat], dock, mouse: true });
	screens.push(tui);
	await terminal.waitForRender();
	const stripRow = ROWS;
	return {
		terminal,
		strip,
		tui,
		onOpen,
		stripRow,
		wheel: async (direction, column = 5, row = stripRow) => {
			terminal.sendInput(`\x1b[<${direction === 1 ? 65 : 64};${column};${row}M`);
			await terminal.waitForRender();
		},
		click: async (column, row = stripRow) => {
			terminal.sendInput(`\x1b[<0;${column};${row}M`);
			terminal.sendInput(`\x1b[<0;${column};${row}m`);
			await terminal.waitForRender();
		},
		move: async (column, row = stripRow) => {
			terminal.sendInput(`\x1b[<35;${column};${row}M`);
			await terminal.waitForRender();
		},
		stripText: async () => {
			await terminal.waitForRender();
			return terminal.getViewport()[ROWS - 1] ?? "";
		},
	};
}

describe("the subagent strip in a fullscreen terminal", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		for (const tui of screens.splice(0)) tui.stop();
	});

	it("sits on the last row, under the transcript, and shows the blocks", async () => {
		const screen = await createScreen();
		const text = await screen.stripText();
		expect(text).toContain("◇ agent-0 回答中");
		expect(text).toMatch(/还有 \d+ 个 ›/);
	});

	it("pages the row sideways with the wheel over it, and leaves the transcript where it was", async () => {
		const screen = await createScreen();
		const before = await screen.stripText();
		const chatBefore = screen.terminal.getViewport().slice(0, ROWS - 1);
		await screen.wheel(1);
		const after = await screen.stripText();
		expect(after).not.toBe(before);
		expect(after).toContain("‹ 还有 1 个");
		expect(after).not.toContain("agent-0");
		expect(screen.terminal.getViewport().slice(0, ROWS - 1)).toEqual(chatBefore);
		await screen.wheel(-1);
		expect(await screen.stripText()).toBe(before);
	});

	it("scrolls the transcript instead once the row is at its end", async () => {
		const screen = await createScreen();
		const chatBefore = screen.terminal.getViewport().slice(0, ROWS - 1);
		// At the left end a wheel-up is the transcript's.
		await screen.wheel(-1);
		expect(await screen.stripText()).toContain("◇ agent-0");
		expect(screen.terminal.getViewport().slice(0, ROWS - 1)).not.toEqual(chatBefore);
		for (let notch = 0; notch < 20; notch++) await screen.wheel(1);
		expect(await screen.stripText()).toContain("agent-9");
		expect(await screen.stripText()).not.toContain("›");
	});

	it("opens the child whose block is clicked, and does nothing when children cannot be opened", async () => {
		const screen = await createScreen();
		const text = await screen.stripText();
		const column = columnOf(text, "agent-1");
		// The name sits inside the second block.
		await screen.click(column + 2);
		expect(screen.onOpen).toHaveBeenCalledTimes(1);
		expect(screen.onOpen).toHaveBeenCalledWith(rows[1]);

		const closed = await createScreen({ openable: false });
		await closed.click(column + 2);
		expect(closed.onOpen).not.toHaveBeenCalled();
	});

	it("lights the block under the pointer and puts it out when the pointer leaves, without moving anything", async () => {
		const screen = await createScreen();
		const text = await screen.stripText();
		const hoverBg = theme.bg("kindSubagentHoverBg", "").replace(/\x1b\[49m$/, "");
		const plainLines = screen.strip.render(COLUMNS).map(stripAnsi);
		expect(screen.strip.render(COLUMNS)[0]).not.toContain(hoverBg);

		await screen.move(columnOf(text, "agent-1") + 1);
		const lit = screen.strip.render(COLUMNS);
		expect(lit[0]).toContain(hoverBg);
		expect(lit.map(stripAnsi)).toEqual(plainLines);
		expect(await screen.stripText()).toBe(text);

		// Off the blocks (the far right of the row is empty space): the block goes back to its own color.
		await screen.move(COLUMNS);
		expect(screen.strip.render(COLUMNS)[0]).not.toContain(hoverBg);
	});

	it("pages a screenful with a click on the marker at the row's end", async () => {
		const screen = await createScreen();
		const text = await screen.stripText();
		const shown = text.match(/agent-\d+/g)?.length ?? 0;
		expect(shown).toBeGreaterThan(0);
		await screen.click(columnOf(text, "还有") + 2);
		const next = await screen.stripText();
		expect(next).toContain(`agent-${shown}`);
		expect(next).not.toContain("agent-0");
	});
});
