import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/index.js";
import {
	buildSubagentPanelRows,
	type SubagentPanelRow,
	SubagentSummaryLine,
	subagentTaskTag,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

/**
 * The subagent strip, cell for cell against the Tl2Live design's third foot row:
 * ` ◇ A 钉住框头 回答中  ◇ B 框的折叠 ✓ 已交回 ...` and, at the right edge,
 * `↓ 选一个进去看` followed by two blank columns.
 */

const WIDTH = 160;

const designRows: SubagentPanelRow[] = [
	{ id: "a", name: "A", tag: "钉住框头", state: "running" },
	{ id: "b", name: "B", tag: "框的折叠", state: "done" },
	{ id: "c", name: "C", tag: "子代理小块", state: "running" },
	{ id: "d", name: "D", tag: "测试和发版", state: "running" },
];

function strip(rows: readonly SubagentPanelRow[]): SubagentSummaryLine {
	const line = new SubagentSummaryLine();
	line.setSubagentCounts({ total: rows.length, running: rows.length, idle: 0, inactive: 0 });
	line.setSubagentRows(rows);
	line.setOpenable(true);
	return line;
}

function snapshot(overrides: Partial<AgentConnectionRlmChildAgentSnapshot>): AgentConnectionRlmChildAgentSnapshot {
	return { id: "c1", label: "child agent", status: "running", sessionDir: "/tmp/c1", ...overrides };
}

describe("the subagent strip as the design draws it", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("draws one block per child with the task tag, a single space between blocks, and the hint at the right edge", () => {
		const line = stripAnsi(strip(designRows).render(WIDTH)[0] ?? "");
		const blocks =
			" ◇ A 钉住框头 回答中 " +
			" " +
			" ◇ B 框的折叠 ✓ 已交回 " +
			" " +
			" ◇ C 子代理小块 回答中 " +
			" " +
			" ◇ D 测试和发版 回答中 ";
		const hint = "↓ 选一个进去看  ";
		expect(line).toBe(` ${blocks}${" ".repeat(WIDTH - 1 - visibleWidth(blocks) - visibleWidth(hint))}${hint}`);
	});

	it("colors the pieces: glyph in the subagent color, name in the text color, states by outcome, hint faint", () => {
		const raw = strip(designRows).render(WIDTH)[0] ?? "";
		expect(raw).toContain(theme.bold(theme.fg("timelineSub", "◇")));
		expect(raw).toContain(theme.fg("timelineAi", "回答中"));
		expect(raw).toContain(theme.fg("timelineOk", "✓ 已交回"));
		expect(raw).toContain(theme.fg("text", "A 钉住框头"));
		expect(raw).toContain(theme.fg("timelineFaint", "↓ 选一个进去看"));
		const background = theme.bg("kindSubagentBg", "").replace(/\x1b\[49m$/, "");
		expect(background.length).toBeGreaterThan(0);
		expect(raw).toContain(background);
	});

	it("leaves the tag out of every block once they would not all fit with it, and never pages sooner because of it", () => {
		const rows: SubagentPanelRow[] = Array.from({ length: 6 }, (_, index) => ({
			id: `r${index}`,
			name: `agent-${index}`,
			tag: "钉住框头",
			state: "running" as const,
		}));
		const roomy = stripAnsi(strip(rows).render(200)[0] ?? "");
		expect(roomy).toContain("agent-0 钉住框头 回答中");
		const tight = stripAnsi(strip(rows).render(90)[0] ?? "");
		expect(tight).not.toContain("钉住框头");
		expect(tight).toContain("agent-0 回答中");
		const untagged = rows.map(({ tag: _tag, ...row }) => row);
		expect(stripAnsi(strip(untagged).render(90)[0] ?? "")).toBe(tight);
	});

	it("keeps a child without a tag exactly as before", () => {
		const line = stripAnsi(strip([{ id: "x", name: "review", state: "running" }]).render(80)[0] ?? "");
		expect(line.startsWith("  ◇ review 回答中 ")).toBe(true);
	});

	it("underlines the name of the selected block and keeps every width the same", () => {
		const focused = strip(designRows);
		const before = focused.render(WIDTH)[0] ?? "";
		focused.focused = true;
		const after = focused.render(WIDTH)[0] ?? "";
		expect(after).toContain(theme.fg("text", theme.underline(theme.bold("A 钉住框头"))));
		expect(visibleWidth(after)).toBe(visibleWidth(before));
	});
});

describe("the order of the blocks", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	const dispatched = [
		snapshot({ id: "a", sessionName: "A", label: "钉住框头：检查滚动" }),
		snapshot({ id: "b", sessionName: "B", label: "框的折叠：检查折叠", status: "done" }),
		snapshot({ id: "c", sessionName: "C", label: "子代理小块：检查块" }),
		snapshot({ id: "d", sessionName: "D", label: "测试和发版：跑测试" }),
	];

	it("follows the dispatch order A B C D with the delivered one in the middle, not the state order", () => {
		const rows = buildSubagentPanelRows(dispatched, undefined);
		// The list still ranks the delivered child last.
		expect(rows.map((row) => row.name)).toEqual(["A", "C", "D", "B"]);
		const line = stripAnsi(strip(rows).render(WIDTH)[0] ?? "");
		expect(line).toMatch(
			/^ {2}◇ A 钉住框头 回答中 {3}◇ B 框的折叠 ✓ 已交回 {3}◇ C 子代理小块 回答中 {3}◇ D 测试和发版 回答中 /,
		);
	});

	it("keeps the blocks in dispatch order as a child changes state", () => {
		const line = strip(buildSubagentPanelRows(dispatched, undefined));
		const names = (text: string) => [...text.matchAll(/◇ ([A-D]) /g)].map((match) => match[1]);
		expect(names(stripAnsi(line.render(WIDTH)[0] ?? ""))).toEqual(["A", "B", "C", "D"]);
		const later = dispatched.map((child) => (child.id === "a" ? { ...child, status: "done" as const } : child));
		line.setSubagentRows(buildSubagentPanelRows(later, undefined));
		expect(names(stripAnsi(line.render(WIDTH)[0] ?? ""))).toEqual(["A", "B", "C", "D"]);
	});

	it("draws again when only a tag changes", () => {
		const line = strip([{ id: "a", name: "A", tag: "钉住框头", state: "running", dispatchIndex: 0 }]);
		expect(stripAnsi(line.render(WIDTH)[0] ?? "")).toContain("A 钉住框头 回答中");
		line.setSubagentRows([{ id: "a", name: "A", tag: "新任务", state: "running", dispatchIndex: 0 }]);
		expect(stripAnsi(line.render(WIDTH)[0] ?? "")).toContain("A 新任务 回答中");
	});
});

describe("the task tag", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("takes the first clause of the task brief", () => {
		expect(subagentTaskTag("钉住框头：检查框头在滚动时是否钉住", "A")).toBe("钉住框头");
		expect(subagentTaskTag("Review the pinned header. Then check folding", "A")).toBe("Review the pi…");
		expect(subagentTaskTag("  \n  ", "A")).toBeUndefined();
	});

	it("does not repeat the child's own name", () => {
		expect(subagentTaskTag("review: box folding", "review")).toBe("box folding");
		expect(subagentTaskTag("review", "review")).toBeUndefined();
	});

	it("is filled on panel rows only for a child that has a name of its own", () => {
		const rows = buildSubagentPanelRows(
			[
				snapshot({ id: "a", sessionName: "A", label: "钉住框头：检查滚动" }),
				snapshot({ id: "b", label: "只有任务描述没有名字" }),
			],
			undefined,
		);
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(byId.get("a")?.tag).toBe("钉住框头");
		expect(byId.get("b")?.name).toBe("只有任务描述没有名字");
		expect(byId.get("b")?.tag).toBeUndefined();
	});
});
