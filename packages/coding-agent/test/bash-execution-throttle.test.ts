import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/** Minimal TUI stub that only exposes terminal.columns */
function createTuiStub(columns = 120): ConstructorParameters<typeof BashExecutionComponent>[1] {
	return {
		terminal: { columns, rows: 24 },
		// Loader calls ui.addInterval / ui.removeInterval
		addInterval: (_cb: () => void, _ms: number) => ({ dispose: () => {} }),
		removeInterval: () => {},
		requestRender: () => {},
	} as unknown as ConstructorParameters<typeof BashExecutionComponent>[1];
}

function renderedText(component: BashExecutionComponent, width = 120): string {
	return stripAnsi(component.render(width).join("\n"));
}

describe("BashExecutionComponent streaming updates", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the first chunk immediately and holds later chunks until the 100ms cadence", () => {
		const component = new BashExecutionComponent("make", createTuiStub());
		component.appendOutput("first\n");
		expect(renderedText(component)).toContain("first");

		component.appendOutput("second\n");
		expect(renderedText(component)).not.toContain("second");

		vi.advanceTimersByTime(99);
		expect(renderedText(component)).not.toContain("second");

		vi.advanceTimersByTime(1);
		expect(renderedText(component)).toContain("second");
	});

	it("coalesces chunks arriving within one cadence into a single trailing flush", () => {
		const component = new BashExecutionComponent("make", createTuiStub());
		component.appendOutput("aaa\n");
		vi.advanceTimersByTime(10);
		component.appendOutput("bbb\n");
		vi.advanceTimersByTime(10);
		component.appendOutput("ccc\n");
		expect(renderedText(component)).not.toContain("bbb");

		vi.advanceTimersByTime(80);
		const rendered = renderedText(component);
		expect(rendered).toContain("bbb");
		expect(rendered).toContain("ccc");
	});

	it("flushes pending output synchronously on setComplete", () => {
		const component = new BashExecutionComponent("make", createTuiStub());
		component.appendOutput("one\n");
		component.appendOutput("two\n");
		component.setComplete(0, false);
		const rendered = renderedText(component);
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("Running...");
	});

	it("keeps the collapsed running preview at the last 20 lines without the completion hint", () => {
		const component = new BashExecutionComponent("seq", createTuiStub());
		const lines = Array.from({ length: 30 }, (_, i) => `line-${String(i + 1).padStart(2, "0")}`);
		component.appendOutput(lines.join("\n"));

		const running = renderedText(component);
		expect(running).toContain("line-30");
		expect(running).toContain("line-11");
		expect(running).not.toContain("line-10");
		expect(running).not.toContain("line-01");
		expect(running).not.toContain("more lines");

		component.setComplete(0, false);
		// U4: a completed collapsed block drops the preview body for a one-line
		// tally; the full tail is reachable by expanding.
		const done = renderedText(component);
		expect(done).toContain("… 30 行输出");
		expect(done).toContain("展开");
		expect(done).not.toContain("line-30");
		component.setExpanded(true);
		const expanded = renderedText(component);
		expect(expanded).toContain("line-30");
		expect(expanded).toContain("line-01");
	});

	it("still renders the tail of an oversized single line while running", () => {
		const component = new BashExecutionComponent("big", createTuiStub());
		const huge = `${"x".repeat(30000)}TAILMARKER${"y".repeat(30000)}`;
		component.appendOutput(huge);
		const lines = component.render(120);
		for (let i = 0; i < lines.length; i++) {
			const w = visibleWidth(lines[i]);
			expect(w, `Line ${i} visibleWidth=${w} > 120`).toBeLessThanOrEqual(120);
		}
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("yyy");
		expect(rendered).not.toContain("TAILMARKER");
	});
});
