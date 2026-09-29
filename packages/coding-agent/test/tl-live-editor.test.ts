import { Container, setKeybindings, Text, TUI, type TUI as TuiType } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import {
	type SubagentPanelRow,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The prompt's chrome, as the Tl2Live / Tl2Done design's foot draws it: a top rule, the input line,
 * then the subagent blocks in the bottom rule's place, then the status line.
 */

const COLUMNS = 60;

const fakeTui = {
	requestRender: vi.fn(),
	showOverlay: vi.fn(),
	terminal: { rows: 40, columns: COLUMNS },
} as unknown as TuiType;

const rows: SubagentPanelRow[] = [
	{ id: "a", name: "A", tag: "钉住框头", state: "running", dispatchIndex: 0 },
	{ id: "b", name: "B", tag: "框的折叠", state: "done", dispatchIndex: 1 },
];

function stripWith(children: readonly SubagentPanelRow[]): SubagentSummaryLine {
	const strip = new SubagentSummaryLine();
	strip.setSubagentCounts({ total: children.length, running: children.length, idle: 0, inactive: 0 });
	strip.setSubagentRows(children);
	strip.setOpenable(true);
	return strip;
}

function statusLine(): FooterComponent {
	const footer = new FooterComponent({ getGitBranch: () => null } as never);
	footer.setStatusBarSource(() => ({ model: "glm-5.3-prime", subagents: 0, right: [] }));
	return footer;
}

/** The prompt area's stack the way the interactive mode builds it: the box hides its bottom rule under the blocks. */
function promptArea(children: readonly SubagentPanelRow[], quiet = true) {
	const editor = new CustomEditor(fakeTui, getEditorTheme(), new KeybindingsManager());
	const strip = stripWith(children);
	editor.hideBottomRule = () => quiet && strip.hasBlocks();
	const dock = new Container();
	dock.addChild(editor);
	dock.addChild(strip);
	dock.addChild(statusLine());
	return { editor, strip, dock };
}

const screens: TUI[] = [];

describe("the prompt's bottom rule", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		for (const tui of screens.splice(0)) tui.stop();
	});

	it("is left out while the callback says so, and drawn otherwise", () => {
		const editor = new CustomEditor(fakeTui, getEditorTheme(), new KeybindingsManager());
		const drawn = editor.render(40).map(stripAnsi);
		expect(drawn).toHaveLength(3);
		expect(drawn[2]).toBe("─".repeat(40));
		editor.hideBottomRule = () => false;
		expect(editor.render(40).map(stripAnsi)).toEqual(drawn);
		editor.hideBottomRule = () => true;
		const hidden = editor.render(40).map(stripAnsi);
		expect(hidden).toEqual(drawn.slice(0, 2));
		expect(hidden[0]).toBe("─".repeat(40));
	});

	it("keeps the scroll indicator that sits on the last row", () => {
		const editor = new CustomEditor(fakeTui, getEditorTheme(), new KeybindingsManager());
		editor.hideBottomRule = () => true;
		editor.setText(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
		// The cursor starts at the end, where nothing is below; walk it back up so lines are hidden below.
		for (let step = 0; step < 29; step++) editor.handleInput("\x1b[A");
		const lines = editor.render(40).map(stripAnsi);
		expect(lines.at(-1)).toMatch(/^─── ↓ 还有 \d+ 行/);
		// At the end of the text nothing is below, so the plain rule goes.
		editor.setText("one\ntwo");
		expect(editor.render(40).map(stripAnsi).at(-1)).toContain("two");
	});

	it("gives the blocks the rule's row in the inline stack, and takes the rule back when there are none", () => {
		const withBlocks = promptArea(rows).dock.render(COLUMNS).map(stripAnsi);
		expect(withBlocks).toHaveLength(4);
		expect(withBlocks[0]).toBe("─".repeat(COLUMNS));
		expect(withBlocks[1]).toContain("›");
		expect(withBlocks[2]).toContain("◇ A 钉住框头 回答中");
		expect(withBlocks[3]).toContain("glm-5.3-prime");

		// No child, no blocks: the rule is back, so the prompt area keeps its four rows.
		const alone = promptArea([]).dock.render(COLUMNS).map(stripAnsi);
		expect(alone).toHaveLength(4);
		expect(alone[0]).toBe("─".repeat(COLUMNS));
		expect(alone[2]).toBe("─".repeat(COLUMNS));
		expect(alone[3]).toContain("glm-5.3-prime");
	});

	it("keeps the rule when the conversation is not quiet", () => {
		const lines = promptArea(rows, false).dock.render(COLUMNS).map(stripAnsi);
		expect(lines).toHaveLength(5);
		expect(lines[2]).toBe("─".repeat(COLUMNS));
		expect(lines[3]).toContain("◇ A 钉住框头");
	});

	it("shows rule, prompt, blocks, status on the last four rows of a fullscreen terminal", async () => {
		const terminal = new VirtualTerminal(COLUMNS, 12);
		const tui = new TUI(terminal);
		const { editor, dock } = promptArea(rows);
		const chat = new Text(Array.from({ length: 40 }, (_, index) => `chat line ${index}`).join("\n"), 0, 0);
		tui.addChild(chat);
		tui.addChild(dock);
		tui.setFocus(editor);
		tui.start();
		tui.enterFullscreen({ scroll: [chat], dock, mouse: false });
		screens.push(tui);
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		const last = viewport.slice(-4);
		expect(last[0]).toBe("─".repeat(COLUMNS));
		expect(last[1]).toContain("›");
		expect(last[2]).toContain("◇ A 钉住框头 回答中");
		expect(last[3]).toContain("glm-5.3-prime");
		expect(viewport.slice(0, -4).some((line) => /^─+$/.test(line))).toBe(false);
	});
});

describe("the strip reports whether it draws a row", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("is true with a block and false with none", () => {
		expect(stripWith(rows).hasBlocks()).toBe(true);
		expect(stripWith([]).hasBlocks()).toBe(false);
	});
});
