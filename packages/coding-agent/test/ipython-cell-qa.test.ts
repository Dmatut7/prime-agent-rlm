import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import {
	setQuietConversationBudget,
	setToolOutputFull,
} from "../src/modes/interactive/components/tool-output-budget.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const longOutput = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n");

describe("IPythonCellComponent QA fixes", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		setToolOutputFull(false);
		setQuietConversationBudget(false);
	});

	it("repaints an expanded cell as soon as full output is toggled (H2)", () => {
		setQuietConversationBudget(true);
		const cell = new IPythonCellComponent({
			code: "%%bash\nseq 1 40",
			details: { status: "ok", durationMs: 5, stdout: longOutput },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		const windowed = stripAnsi(cell.render(100).join("\n"));
		expect(windowed).toContain("还有 34 行");
		expect(windowed).not.toContain("line 40");
		setToolOutputFull(true);
		const full = stripAnsi(cell.render(100).join("\n"));
		expect(full).toContain("line 40");
		expect(full).not.toContain("还有 34 行");
	});

	it("reads a KeyboardInterrupt as a calm 已中断 and hides its traceback outside the full view (M2)", () => {
		const traceback = [
			"Traceback (most recent call last):",
			'  File "<cell>", line 1, in <module>',
			"KeyboardInterrupt",
		];
		const state = {
			code: "%%bash\nsleep 25",
			content: [{ type: "text", text: `tick 1\ntick 2\n${traceback.join("\n")}` }],
			details: { status: "error" as const, durationMs: 5_900, errorEname: "KeyboardInterrupt" },
			isError: true,
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		};
		const rendered = stripAnsi(new IPythonCellComponent(state).render(100).join("\n"));
		const top = rendered.split("\n")[0] ?? "";
		expect(top).toContain("已中断");
		expect(top).not.toContain("KeyboardInterrupt");
		expect(top).toContain("2 行输出");
		expect(rendered).not.toContain("Traceback (most recent call last)");
		expect(rendered).toContain("tick 2");
		setToolOutputFull(true);
		expect(stripAnsi(new IPythonCellComponent(state).render(100).join("\n"))).toContain(
			"Traceback (most recent call last)",
		);
	});

	it("keeps the right-aligned facts whole and shortens the label instead (M4)", () => {
		const cell = new IPythonCellComponent({
			code: "%%bash\nrm -rf /tmp/some/really/long/path/that/goes/on && touch another/long/file/name.txt && echo done",
			details: { status: "ok", durationMs: 1_234, stdout: "a\nb\nc\nd\ne\nf" },
			executionStarted: true,
			argsComplete: true,
		});
		for (const width of [60, 50, 40]) {
			const top = stripAnsi(cell.render(width)[0] ?? "");
			expect(visibleWidth(top)).toBeLessThanOrEqual(width);
			expect(top.trimEnd().endsWith("6 行输出 · 1.2s")).toBe(true);
		}
	});

	it("shows an unlabeled cell's code with a plain gutter, not the user marker (M3)", () => {
		const rendered = stripAnsi(
			new IPythonCellComponent({
				code: "x = 1\ny = x + 1",
				details: { status: "ok", durationMs: 1 },
				executionStarted: true,
				argsComplete: true,
				expanded: true,
			})
				.render(80)
				.join("\n"),
		);
		expect(rendered).toContain("│ x = 1");
		expect(rendered).not.toContain("› ");
	});
});
