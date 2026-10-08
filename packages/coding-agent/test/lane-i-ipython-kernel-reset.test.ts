/**
 * R3-M10: the ipython tool result carries `details.kernelRestarted` and
 * `details.kernelReset` when the cell ran on a replacement kernel, but
 * readDetails ignored both - the owner saw a normal-looking cell while every
 * variable the session had built was gone, and only hit a NameError later.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("IPythonCellComponent kernel reset notice (R3-M10)", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		// The render cache is keyed by state version; fresh components per case
		// below make this a no-op safety net.
	});

	it("shows a kernel-reset warning line under the top line, collapsed too", () => {
		const raw = new IPythonCellComponent({
			code: "df = load_dataframe()",
			details: { status: "ok" as const, durationMs: 900, kernelReset: true },
			executionStarted: true,
			argsComplete: true,
		}).render(100);
		const rendered = stripAnsi(raw.join("\n"));
		// Collapsed view: the notice is the second line, directly under the top line.
		expect(rendered.split("\n")).toHaveLength(2);
		expect(rendered).toContain("内核已重置");
		expect(rendered).toContain("变量与导入可能已丢失");
		// The warning color carries the tone; the top line does not change.
		expect(raw[1]).toContain(theme.getFgAnsi("warning"));
		expect(raw[1]).toContain("⚠");
		expect(stripAnsi(raw[0] ?? "")).not.toContain("内核");
	});

	it("says restarted (interrupt-rebuild) for kernelRestarted", () => {
		const rendered = stripAnsi(
			new IPythonCellComponent({
				code: "h = bash('npm test')",
				details: { status: "ok" as const, durationMs: 2_100, kernelRestarted: true },
				executionStarted: true,
				argsComplete: true,
				expanded: true,
			})
				.render(100)
				.join("\n"),
		);
		expect(rendered).toContain("内核已重启");
		expect(rendered).toContain("变量与任务可能已丢失");
		expect(rendered).not.toContain("内核已重置");
	});

	it("a cell on the same kernel it started on shows no notice", () => {
		const rendered = stripAnsi(
			new IPythonCellComponent({
				code: "x = 1",
				details: { status: "ok" as const, durationMs: 10 },
				executionStarted: true,
				argsComplete: true,
				expanded: true,
			})
				.render(100)
				.join("\n"),
		);
		expect(rendered).not.toContain("内核已重置");
		expect(rendered).not.toContain("内核已重启");
	});
});
