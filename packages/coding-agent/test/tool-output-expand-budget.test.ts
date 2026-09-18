/**
 * Pins for the expanded tool-output render budget.
 *
 * Expanding tool output (ctrl+o) rebuilds every tool block in the transcript and
 * rewraps whatever body it releases, so one keystroke cost O(total released bytes):
 * seconds on a single core for a window holding many long outputs. Expanded blocks now
 * render a bounded window and name the shortcut that lifts it - `app.tools.expandFull`
 * renders every block in full, so the budget defers text and never drops it.
 *
 * Reverting the budget (or unbinding the shortcut) turns the tests here red.
 */
import { Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.js";
import { keyText } from "../src/modes/interactive/components/keybinding-hints.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import {
	EXPANDED_TOOL_OUTPUT_MAX_CHARS,
	EXPANDED_TOOL_OUTPUT_MAX_LINES,
	expandedOutputWindow,
	setToolOutputFull,
	toolOutputFull,
} from "../src/modes/interactive/components/tool-output-budget.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const WIDTH = 120;
/** Panel chrome around the body window: header, blank rows, the call line, the hint, the timer. */
const BLOCK_CHROME_SLACK = 12;

function createFakeTui(): { tui: any; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return {
		tui: { requestRender, requestRenderPreservingViewport: requestRender, isFullscreen: () => false } as any,
		requestRender,
	};
}

function bodyLines(count: number): string[] {
	return Array.from(
		{ length: count },
		(_v, i) => `line-${String(i).padStart(4, "0")}: check passed for tool-execution.ts:${i}`,
	);
}

function bashComponent(id: string, output: string, tui: any): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"bash",
		id,
		{ command: `echo ${id}` },
		{},
		undefined,
		tui,
		process.cwd(),
	);
	component.updateResult({ content: [{ type: "text", text: output }], isError: false }, false);
	return component;
}

describe("expanded tool output budget", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		setToolOutputFull(false);
		vi.useRealTimers();
		vi.restoreAllMocks();
		initTheme("dark");
	});

	test("the window keeps the head of an over-budget body and reports the rest", () => {
		const lines = bodyLines(EXPANDED_TOOL_OUTPUT_MAX_LINES + 160);
		const window = expandedOutputWindow(lines);
		expect(window.truncated).toBe(true);
		expect(window.lines).toEqual(lines.slice(0, EXPANDED_TOOL_OUTPUT_MAX_LINES));
		expect(window.skippedLines).toBe(160);
	});

	test("the window hands a body that fits back untouched", () => {
		const lines = bodyLines(EXPANDED_TOOL_OUTPUT_MAX_LINES);
		const window = expandedOutputWindow(lines);
		expect(window.lines).toBe(lines);
		expect(window.truncated).toBe(false);
		expect(window.skippedLines).toBe(0);
	});

	test("the window bounds long lines by characters, not just by count", () => {
		const long = Array.from({ length: 40 }, (_v, i) => `row-${i} ${"x".repeat(1000)}`);
		const window = expandedOutputWindow(long);
		expect(window.truncated).toBe(true);
		expect(window.lines.length).toBeLessThan(long.length);
		expect(window.lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(
			EXPANDED_TOOL_OUTPUT_MAX_CHARS,
		);
	});

	test("one line longer than the whole budget still shows a bounded prefix", () => {
		const huge = "y".repeat(EXPANDED_TOOL_OUTPUT_MAX_CHARS * 3);
		const window = expandedOutputWindow([huge]);
		expect(window.lines.length).toBe(1);
		expect(window.lines[0]!.length).toBe(EXPANDED_TOOL_OUTPUT_MAX_CHARS);
		expect(window.skippedLines).toBe(0);
		expect(window.skippedChars).toBe(EXPANDED_TOOL_OUTPUT_MAX_CHARS * 2);
		expect(window.truncated).toBe(true);
	});

	test("full-output mode lifts the budget", () => {
		const lines = bodyLines(EXPANDED_TOOL_OUTPUT_MAX_LINES + 160);
		expect(setToolOutputFull(true)).toBe(true);
		expect(toolOutputFull()).toBe(true);
		const window = expandedOutputWindow(lines);
		expect(window.lines).toBe(lines);
		expect(window.truncated).toBe(false);
		expect(setToolOutputFull(true)).toBe(false);
		expect(setToolOutputFull(false)).toBe(true);
	});

	test("the shortcut that lifts the budget is bound and named in the block tail", () => {
		expect(KEYBINDINGS["app.tools.expandFull"].defaultKeys).not.toEqual([]);
		expect(KEYBINDINGS["app.tools.expandFull"].defaultKeys).not.toBe(KEYBINDINGS["app.tools.expand"].defaultKeys);
		const key = keyText("app.tools.expandFull");
		expect(key.length).toBeGreaterThan(0);

		const { tui } = createFakeTui();
		const component = bashComponent("hint", bodyLines(EXPANDED_TOOL_OUTPUT_MAX_LINES + 160).join("\n"), tui);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(WIDTH).join("\n"));
		expect(rendered).toContain("line-0000");
		expect(rendered).toContain(`... 160 more lines`);
		expect(rendered).toContain(key);
		expect(rendered).toContain("for full output");
	});

	test("an expanded block renders its window, and full mode still reaches the last line", () => {
		const { tui } = createFakeTui();
		const body = bodyLines(420).join("\n");
		const component = bashComponent("window", body, tui);

		component.setExpanded(true);
		const budgeted = stripAnsi(component.render(WIDTH).join("\n"));
		expect(budgeted).toContain("line-0000");
		expect(budgeted).not.toContain("line-0419");
		const budgetedLines = component.render(WIDTH).length;
		expect(budgetedLines).toBeLessThanOrEqual(EXPANDED_TOOL_OUTPUT_MAX_LINES + BLOCK_CHROME_SLACK);

		setToolOutputFull(true);
		component.invalidate();
		const full = stripAnsi(component.render(WIDTH).join("\n"));
		expect(full).toContain("line-0000");
		expect(full).toContain("line-0419");
		expect(full).not.toContain("more lines");
		expect(component.render(WIDTH).length).toBeGreaterThan(budgetedLines);

		setToolOutputFull(false);
		component.invalidate();
		expect(stripAnsi(component.render(WIDTH).join("\n"))).toBe(budgeted);
	});

	test("a body inside the budget renders in full, and the collapsed preview keeps its tail", () => {
		const { tui } = createFakeTui();
		const body = bodyLines(12).join("\n");
		const component = bashComponent("small", body, tui);

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(WIDTH).join("\n"));
		expect(expanded).toContain("line-0000");
		expect(expanded).toContain("line-0011");
		expect(expanded).not.toContain("more lines");

		component.setExpanded(false);
		const collapsed = stripAnsi(component.render(WIDTH).join("\n"));
		expect(collapsed).toContain("line-0011");
		expect(collapsed).not.toContain("line-0000");

		component.setExpanded(true);
		expect(stripAnsi(component.render(WIDTH).join("\n"))).toBe(expanded);
	});

	test("sixty long blocks expanded at once stay inside sixty windows", () => {
		const { tui } = createFakeTui();
		const body = bodyLines(420).join("\n");
		const components = Array.from({ length: 60 }, (_v, i) => bashComponent(`bulk-${i}`, body, tui));
		for (const component of components) {
			component.setExpanded(true);
		}
		const perBlock = components.map((component) => component.render(WIDTH).length);
		const total = perBlock.reduce((sum, lines) => sum + lines, 0);
		expect(Math.max(...perBlock)).toBeLessThanOrEqual(EXPANDED_TOOL_OUTPUT_MAX_LINES + BLOCK_CHROME_SLACK);
		expect(total).toBeLessThanOrEqual(60 * (EXPANDED_TOOL_OUTPUT_MAX_LINES + BLOCK_CHROME_SLACK));
		// The unbounded view this replaced rendered all 420 body lines per block.
		expect(total).toBeLessThan(60 * 420);
	});

	test("the full-output toggle flips the budget, asks for a frame and says how to undo it", () => {
		const { tui, requestRender } = createFakeTui();
		const chatContainer = new Container();
		chatContainer.addChild(bashComponent("toggle", bodyLines(420).join("\n"), tui));
		const showStatus = vi.fn();
		const proto = InteractiveMode.prototype as unknown as {
			applyChatExpansion(this: any): void;
			expansionStateFor(this: any, component: unknown): boolean;
			toggleToolOutputFull(this: any): void;
		};
		const mode: any = {
			chatContainer,
			toolOutputExpanded: true,
			agentMessagesExpanded: false,
			editDiffsExpanded: false,
			customHeader: undefined,
			builtInHeader: undefined,
			ui: { isFullscreen: () => false, requestRender, requestRenderPreservingViewport: requestRender },
			showStatus,
		};
		mode.expansionStateFor = (component: unknown) => proto.expansionStateFor.call(mode, component);
		mode.applyChatExpansion = () => proto.applyChatExpansion.call(mode);

		expect(toolOutputFull()).toBe(false);
		proto.toggleToolOutputFull.call(mode);
		expect(toolOutputFull()).toBe(true);
		expect(requestRender).toHaveBeenCalled();
		expect(stripAnsi(showStatus.mock.calls[0]![0] as string)).toContain(keyText("app.tools.expandFull"));

		proto.toggleToolOutputFull.call(mode);
		expect(toolOutputFull()).toBe(false);
		expect(showStatus).toHaveBeenCalledTimes(2);
	});
});
