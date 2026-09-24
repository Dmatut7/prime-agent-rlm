import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

/**
 * Design board 06 (子代理并行): a rule header with the family count and spend,
 * then one row per child — state glyph, padded name, state word with elapsed
 * time, and what it is doing.
 */
describe("subagent panel matches design board 06", () => {
	it("renders the header rule and one row per child in state order", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 2, idle: 0, inactive: 1 });
		line.setSubagentRows([
			{ id: "c1", name: "review", state: "running", elapsedMs: 134_000, activity: "读取 footer.ts" },
			{ id: "c2", name: "docs", state: "running", elapsedMs: 41_000, activity: "编辑 FORK_NOTES.md" },
			{ id: "c3", name: "lint", state: "done", elapsedMs: 62_000, activity: "无问题" },
		]);
		const rows = line
			.render(100)
			.map(strip)
			.filter((row) => row.trim().length > 0);
		expect(rows.length).toBe(4);
		expect(rows[0]).toMatch(/^ 子代理 3 .*─/);
		expect(rows[1]).toMatch(/^ {3}● review +运行 2:14 +读取 footer\.ts/);
		expect(rows[2]).toMatch(/^ {3}● docs +运行 0:41 +编辑 FORK_NOTES\.md/);
		expect(rows[3]).toMatch(/^ {3}✓ lint +完成 1:02 +无问题/);
		for (const row of rows) expect(row.length).toBeLessThanOrEqual(100);
	});
});
