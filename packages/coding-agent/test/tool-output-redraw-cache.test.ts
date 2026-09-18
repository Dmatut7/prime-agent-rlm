/**
 * Pins for the three changes that make a tool block cheap to re-enter without changing
 * a single pixel of what it shows:
 *
 *   1. the expanded bash body is cached on the block's persistent render state, so the
 *      rebuilds that a ctrl+o press, a chat-level invalidate (theme switch, mermaid
 *      toggle) and a streaming update all trigger for an unchanged body reuse the very
 *      same lines instead of restyling and rewrapping them,
 *   2. setExpanded() returns early when the state did not move - applyChatExpansion
 *      walks every chat component on each toggle and on each transcript rebuild,
 *   3. the 1s tick of a running command rewrites its "Elapsed" label in place and asks
 *      for a frame, instead of invalidating (and so rebuilding) the whole block.
 *
 * Each pin goes red when its change is reverted: see EVIDENCE/mutations in the fix seat's
 * working tree for the mutation runs.
 */
import { type Component, type Container, setKeybindings, Text } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ToolDefinition, ToolRenderContext } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createBashToolDefinition } from "../src/core/tools/bash.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const WIDTH = 120;

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

const bashDefinition = createBashToolDefinition(process.cwd());
const renderBashResult = (() => {
	const fn = bashDefinition.renderResult;
	if (!fn) {
		throw new Error("bash tool definition must provide renderResult");
	}
	return fn;
})();

/** One render slot's context; `state` and `lastComponent` are what a rebuild reuses. */
function bashContext(
	state: Record<string, unknown>,
	lastComponent: Component | undefined,
	extra: Partial<ToolRenderContext> = {},
): ToolRenderContext {
	return {
		args: { command: "cmd" },
		toolCallId: "bash-cache",
		invalidate: () => {},
		lastComponent,
		state,
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showExpandHint: true,
		showImages: false,
		includeImageDimensions: false,
		isError: false,
		...extra,
	};
}

function renderBash(
	output: string,
	state: Record<string, unknown>,
	lastComponent: Component | undefined,
	extra: Partial<ToolRenderContext> = {},
	expanded = true,
): Component {
	return renderBashResult(
		{ content: [{ type: "text", text: output }], details: undefined } as any,
		{ expanded, isPartial: false },
		theme,
		bashContext(state, lastComponent, { expanded, ...extra }),
	);
}

/** The body child of a bash result component (index 0: no warnings, no timer mounted). */
function bodyChild(component: Component): Component {
	const children = (component as Container).children;
	if (children.length === 0) {
		throw new Error("expected the bash result component to hold a body child");
	}
	return children[0]!;
}

describe("tool output redraw cache and cheap re-entries", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		initTheme("dark");
	});

	test("a rebuild for an unchanged body reuses the very same expanded lines", () => {
		const state: Record<string, unknown> = {};
		const output = bodyLines(420).join("\n");

		const first = renderBash(output, state, undefined);
		const firstLines = bodyChild(first).render(WIDTH);
		expect(firstLines.length).toBeGreaterThan(0);

		// Exactly what a ctrl+o press, a chat-level invalidate and the 1s tick of a
		// running command all do: rebuild the slot for the same body.
		const second = renderBash(output, state, first);
		second.invalidate();
		const secondLines = bodyChild(second).render(WIDTH);
		expect(secondLines).toBe(firstLines);

		const third = renderBash(output, state, second);
		expect(bodyChild(third).render(WIDTH)).toBe(firstLines);

		// A different body still renders a different window.
		const other = renderBash(bodyLines(300).join("\n"), state, third);
		expect(bodyChild(other).render(WIDTH)).not.toBe(firstLines);
	});

	test("a narrower width or a new theme re-renders the window instead of serving it stale", () => {
		const state: Record<string, unknown> = {};
		const output = bodyLines(420).join("\n");
		const first = renderBash(output, state, undefined);
		const wide = bodyChild(first).render(WIDTH);
		expect(bodyChild(first).render(WIDTH)).toBe(wide);

		// The cache holds one width at a time, so a resize recomputes and a resize back
		// recomputes again - same content, no stale lines.
		const narrow = bodyChild(first).render(80);
		expect(narrow).not.toEqual(wide);
		expect(bodyChild(first).render(WIDTH)).toEqual(wide);

		initTheme("light");
		const themed = renderBash(output, state, first);
		themed.invalidate();
		const themedLines = bodyChild(themed).render(WIDTH);
		expect(themedLines).not.toEqual(wide);
		// It matches what a from-scratch block renders under the same theme, so the
		// cache keyed on the theme sample cannot serve dark lines for a light theme.
		const fresh = renderBash(output, {}, undefined);
		expect(themedLines).toEqual(bodyChild(fresh).render(WIDTH));
	});

	test("an unchanged expansion state does not rebuild the block", () => {
		const renderResult = vi.fn(
			(_result: any, options: any, _theme: any, _context: ToolRenderContext) =>
				new Text(options.expanded ? "expanded body" : "collapsed body", 0, 0),
		);
		const definition: ToolDefinition = {
			name: "probe_tool",
			label: "probe_tool",
			description: "probe",
			parameters: Type.Any(),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			renderResult,
		};
		const { tui } = createFakeTui();
		const component = new ToolExecutionComponent("probe_tool", "probe-1", {}, {}, definition, tui, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);

		const afterResult = renderResult.mock.calls.length;
		component.setExpanded(true);
		expect(renderResult.mock.calls.length).toBe(afterResult + 1);
		// applyChatExpansion walks every chat component on each toggle and on each
		// transcript rebuild; a block whose state did not move must not pay for it.
		component.setExpanded(true);
		component.setExpanded(true);
		expect(renderResult.mock.calls.length).toBe(afterResult + 1);
		component.setExpanded(false);
		expect(renderResult.mock.calls.length).toBe(afterResult + 2);
	});

	test("the 1s tick of a running command moves its label without rebuilding the block", () => {
		vi.useFakeTimers();
		const { tui, requestRender } = createFakeTui();
		const component = new ToolExecutionComponent(
			"bash",
			"running",
			{ command: "sleep 30" },
			{},
			undefined,
			tui,
			process.cwd(),
		);
		const invalidate = vi.spyOn(component, "invalidate");
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: bodyLines(420).join("\n") }], isError: false }, true);
		component.setExpanded(true);
		component.render(WIDTH);
		invalidate.mockClear();
		requestRender.mockClear();

		vi.advanceTimersByTime(1000);

		expect(invalidate).not.toHaveBeenCalled();
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(stripAnsi(component.render(WIDTH).join("\n"))).toContain("Elapsed 1.0s");

		// The label keeps moving, and settling the command disarms the tick for good.
		vi.advanceTimersByTime(1000);
		expect(stripAnsi(component.render(WIDTH).join("\n"))).toContain("Elapsed 2.0s");
		component.updateResult({ content: [{ type: "text", text: bodyLines(420).join("\n") }], isError: false }, false);
		expect(stripAnsi(component.render(WIDTH).join("\n"))).toContain("Took 2.0s");
		requestRender.mockClear();
		vi.advanceTimersByTime(3000);
		expect(requestRender).not.toHaveBeenCalled();
		expect(invalidate).not.toHaveBeenCalled();
	});

	test("the tick falls back to a full invalidate when the host cannot request a frame", () => {
		vi.useFakeTimers();
		const invalidate = vi.fn();
		const context = bashContext({ startedAt: Date.now() }, undefined, {
			invalidate,
			executionStarted: true,
			isPartial: true,
			requestRender: undefined,
		});
		const component = renderBashResult(
			{ content: [{ type: "text", text: "working..." }], details: undefined } as any,
			{ expanded: true, isPartial: true },
			theme,
			context,
		);
		expect(component).toBeDefined();
		invalidate.mockClear();

		vi.advanceTimersByTime(1000);
		expect(invalidate).toHaveBeenCalledTimes(1);
		vi.clearAllTimers();
	});
	test("the collapsed preview frame is assembled once, not once per frame", () => {
		const state: Record<string, unknown> = {};
		const output = bodyLines(60).join("\n");
		const component = renderBash(output, state, undefined, {}, false);
		const first = bodyChild(component).render(WIDTH);
		expect(stripAnsi(first.join("\n"))).toContain("earlier lines");
		// Every collapsed block in the transcript runs this on every frame; resolving the
		// shortcut text and re-truncating it each time was the steady-state garbage.
		expect(bodyChild(component).render(WIDTH)).toBe(first);

		initTheme("light");
		const themed = bodyChild(component).render(WIDTH);
		expect(themed).not.toBe(first);
		expect(themed).not.toEqual(first);
	});

	test("re-delivering an unchanged result keeps both caches", () => {
		const state: Record<string, unknown> = {};
		const output = bodyLines(60).join("\n");

		const collapsed = renderBash(output, state, undefined, {}, false);
		const collapsedLines = bodyChild(collapsed).render(WIDTH);
		// The streaming path re-delivers a result every BASH_UPDATE_THROTTLE_MS, and a
		// rebuild used to invalidate the whole slot whether or not the text had moved.
		const collapsedAgain = renderBash(output, state, collapsed, {}, false);
		expect(bodyChild(collapsedAgain).render(WIDTH)).toBe(collapsedLines);

		const expanded = renderBash(output, state, collapsedAgain, {});
		const expandedLines = bodyChild(expanded).render(WIDTH);
		const expandedAgain = renderBash(output, state, expanded, {});
		expect(bodyChild(expandedAgain).render(WIDTH)).toBe(expandedLines);

		// A body that did move still re-renders.
		const grown = renderBash(`${output}\nline-extra`, state, expandedAgain, {}, false);
		const grownLines = bodyChild(grown).render(WIDTH);
		expect(grownLines).not.toBe(collapsedLines);
		expect(stripAnsi(grownLines.join("\n"))).toContain("line-extra");
	});
});
