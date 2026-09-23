import { afterEach, describe, expect, it } from "vitest";
import {
	expandedOutputSkippedDetail,
	expandedOutputWindow,
	QUIET_EXPANDED_TOOL_OUTPUT_MAX_LINES,
	setQuietConversationBudget,
} from "../src/modes/interactive/components/tool-output-budget.js";

/**
 * TUI v4 batch 2 / T7 (R2.4): the quiet conversation pins the per-step
 * expanded output window to a dozen lines with an "N more lines" tail;
 * `app.tools.expandFull` (alt+shift+O) still lifts the whole budget.
 */
describe("quiet per-step output window (TUI v4 T7)", () => {
	afterEach(() => {
		setQuietConversationBudget(false);
	});

	it("caps the expanded window at 12 lines in quiet mode and reports the holdback", () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
		setQuietConversationBudget(true);
		const window = expandedOutputWindow(lines);
		expect(window.lines).toHaveLength(QUIET_EXPANDED_TOOL_OUTPUT_MAX_LINES);
		expect(window.skippedLines).toBe(28);
		expect(window.truncated).toBe(true);
		expect(expandedOutputSkippedDetail(window)).toBe("28 more lines");
	});

	it("keeps the legacy 40-line window when quiet mode is off", () => {
		const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
		setQuietConversationBudget(false);
		const window = expandedOutputWindow(lines);
		expect(window.lines).toHaveLength(40);
		expect(window.truncated).toBe(false);
	});

	it("a body that fits the tighter window passes through untouched", () => {
		const lines = ["only", "a few", "lines"];
		setQuietConversationBudget(true);
		const window = expandedOutputWindow(lines);
		expect(window.lines).toBe(lines);
		expect(window.truncated).toBe(false);
	});
});
