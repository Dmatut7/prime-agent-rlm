import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { setToolOutputFull } from "../src/modes/interactive/components/tool-output-budget.js";
import { useTruecolorTheme } from "./ui-blocks-helpers.js";

/**
 * R4-M7: the cell builds its own rows - it never hands its text to `Text`, so the
 * central render gate does not see them. Three of its inputs are model or kernel
 * text: the step label read off the cell's code, the error name from the kernel's
 * reply, and the cell's source in the expanded view. An OSC 52 in any of them
 * writes the owner's clipboard on every repaint, a CSI J clears the screen, a
 * newline in the error name turns one accounted row into two physical ones.
 */
const OSC52 = "\u001b]52;c;cGFzdGU=\u0007";
const CLEAR = "\u001b[2J";
const BEL = "\u0007";
const CR = "\r";

type CellState = ConstructorParameters<typeof IPythonCellComponent>[0];

function render(state: CellState, width = 100): string[] {
	return new IPythonCellComponent(state).render(width);
}

function expectNoInjection(rows: string[]): void {
	const joined = rows.join("\n");
	expect(joined).not.toContain("\u001b]52");
	expect(joined).not.toContain("cGFzdGU=");
	expect(joined).not.toContain(CLEAR);
	expect(joined).not.toContain(BEL);
	expect(joined).not.toContain(CR);
}

describe("IPythonCellComponent sanitize", () => {
	let restoreTheme: () => void;
	beforeAll(() => {
		// The assertion below reads the theme's own color escape, whose shape
		// depends on the detected color mode: pin truecolor so the test is green
		// on every machine, not only on 256-color terminals.
		restoreTheme = useTruecolorTheme("dark");
	});

	afterAll(() => {
		restoreTheme();
	});

	afterEach(() => {
		setToolOutputFull(false);
	});

	it("keeps an injected step label off the top row", () => {
		// `printf` is a quiet command, so the label shows the command itself -
		// escapes and all, unless the row is washed where the label is inserted.
		const rows = render({
			code: `%%bash\nprintf done${CLEAR}${BEL}${CR}`,
			executionStarted: true,
			argsComplete: true,
			details: { status: "ok" },
		});
		expectNoInjection(rows);
		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "").trim()).toBe("✓ 运行 printf done");
	});

	it("keeps bare control bytes out of the cell's stdout rows", () => {
		// The output paths wash through normalizeErrorDetails; a bash BEL used to
		// reach the screen and ring on every repaint.
		setToolOutputFull(true);
		const rows = render({
			code: "print(1)",
			executionStarted: true,
			argsComplete: true,
			expanded: true,
			details: { status: "ok", stdout: `line one${BEL}${CLEAR}\nline two${CR}overwritten` },
		});
		expectNoInjection(rows);
		const visible = rows.map((row) => stripAnsi(row)).join("\n");
		expect(visible).toContain("line one");
		expect(visible).toContain("line two");
		expect(visible).toContain("overwritten");
	});

	it("keeps an injected kernel error name off the top row", () => {
		const rows = render({
			code: "print(1)",
			executionStarted: true,
			argsComplete: true,
			isError: true,
			details: { status: "error", error: { ename: `ValueError${OSC52}${CLEAR}`, evalue: "bad", traceback: [] } },
		});
		expectNoInjection(rows);
		expect(rows).toHaveLength(1);
		expect(stripAnsi(rows[0] ?? "")).toContain("ValueError");
	});

	it("keeps the top row one physical row when the error name carries a newline", () => {
		const rows = render({
			code: "print(1)",
			executionStarted: true,
			argsComplete: true,
			isError: true,
			details: { status: "error", errorEname: "ValueError\nsecond row" },
		});
		expect(rows).toHaveLength(1);
		expect(rows.every((row) => !row.includes("\n"))).toBe(true);
		expect(stripAnsi(rows[0] ?? "")).toContain("ValueError second row");
	});

	it("keeps injected escapes out of the expanded code rows", () => {
		setToolOutputFull(true);
		const code = ['print("hi")', `${OSC52}${CLEAR}x = 1${BEL}`, "    indented = '中文 🎉'", "\ttabbed = 2"].join(
			"\n",
		);
		const rows = render({ code, executionStarted: true, argsComplete: true, expanded: true, details: {} });
		expectNoInjection(rows);
		const visible = rows.map((row) => stripAnsi(row));
		expect(visible).toContain(' │ print("hi")');
		expect(visible).toContain(" │ x = 1");
		expect(visible).toContain(" │     indented = '中文 🎉'");
		// A tab is a control character: the wash widens it to the four spaces the
		// diff rows use, so the row's width no longer depends on the terminal's
		// tab stops.
		expect(visible).toContain(" │     tabbed = 2");
		// The wash takes the escapes out of the code, not the cell's own paint: the
		// theme's truecolor foreground on the code rows proves the coloring survived.
		expect(rows.some((row) => row.includes("\u001b[38;2;"))).toBe(true);
	});

	it("renders a clean cell exactly as it did before the wash", () => {
		setToolOutputFull(true);
		const code = [
			"import json",
			"",
			"def helper(x):",
			"    return json.dumps(x)  # 中文注释 🎉",
			"",
			"print(helper({'a': 1}))",
		].join("\n");
		const rows = render({ code, executionStarted: true, argsComplete: true, expanded: true, details: {} });
		// Compared with trailing padding trimmed: an empty code row's padding depends on
		// whether the lazy syntax highlighter has loaded yet (before it does, the cell's
		// own `" "` fallback paints one column less), which is not what this case is
		// about - it is about the wash leaving a clean cell's visible text alone.
		expect(rows.map((row) => stripAnsi(row).trimEnd())).toEqual([
			" ✓ 定义 helper",
			" │ import json",
			" │",
			" │ def helper(x):",
			" │     return json.dumps(x)  # 中文注释 🎉",
			" │",
			" │ print(helper({'a': 1}))",
			"",
			"   没有输出",
		]);
	});
});
