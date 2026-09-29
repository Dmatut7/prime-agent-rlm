import { type ClickRegion, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import {
	buildSubagentPanelRows,
	type SubagentPanelRow,
	type SubagentPanelRowState,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import { useTruecolorTheme } from "./ui-blocks-helpers.js";

/**
 * The subagent strip under the prompt: one row of small blocks, one per child,
 * that pages sideways when they do not all fit. Everything is driven through
 * render(), getClickRegions() and handleInput().
 */

const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

function row(id: string, state: SubagentPanelRowState = "running", name = id): SubagentPanelRow {
	return { id, name, state };
}

function agents(count: number, state: SubagentPanelRowState = "running"): SubagentPanelRow[] {
	return Array.from({ length: count }, (_, index) => row(`c${index}`, state, `agent-${index}`));
}

function strip(rows: readonly SubagentPanelRow[], options: { openable?: boolean } = {}): SubagentSummaryLine {
	const line = new SubagentSummaryLine();
	line.setSubagentCounts({ total: rows.length, running: rows.length, idle: 0, inactive: 0 });
	line.setSubagentRows(rows);
	line.setOpenable(options.openable ?? true);
	return line;
}

const plain = (lines: readonly string[]): string => stripAnsi(lines.join("\n"));

function chipRegions(line: SubagentSummaryLine): ClickRegion[] {
	return line.getClickRegions().filter((region) => region.hoverKey?.startsWith("subagent-chip:"));
}

/** The paging markers: clickable regions that are neither a block nor the passive wheel row. */
function markerRegions(line: SubagentSummaryLine): ClickRegion[] {
	return line.getClickRegions().filter((region) => !region.passive && region.hoverKey === undefined);
}

function visibleNames(text: string): string[] {
	return [...text.matchAll(/agent-\d+/g)].map((match) => match[0]);
}

function bgOpen(token: "kindSubagentBg" | "kindSubagentHoverBg" | "kindErrorBg"): string {
	const painted = theme.bg(token, "");
	return painted.slice(0, painted.indexOf("\x1b[49m"));
}

function count(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

describe("the subagent strip", () => {
	const chalkLevel = chalk.level;
	let restoreTheme: () => void;
	beforeAll(() => {
		// Bold and underline come from chalk, which is off without a terminal.
		chalk.level = 3;
		restoreTheme = useTruecolorTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterAll(() => {
		chalk.level = chalkLevel;
		restoreTheme();
	});

	it("takes exactly one row however many children there are and however narrow the screen", () => {
		const sizes = [1, 3, 10, 40];
		const widths = [120, 80, 60, 40, 24];
		expect(sizes.length * widths.length).toBeGreaterThan(0);
		for (const size of sizes) {
			for (const width of widths) {
				const line = strip(agents(size));
				expect(line.render(width), `${size} agents at ${width}`).toHaveLength(1);
				line.focused = true;
				expect(line.render(width), `${size} agents focused at ${width}`).toHaveLength(1);
			}
		}
		const withOrphans = strip(agents(10));
		withOrphans.setStallMarkers(["ghost-a: stalled 70s", "ghost-b: stalled 80s"]);
		expect(withOrphans.render(60)).toHaveLength(1);
	});

	it("renders nothing without children", () => {
		const line = new SubagentSummaryLine();
		expect(line.render(100)).toEqual([]);
		line.setSubagentRows(agents(2));
		expect(line.render(100)).toEqual([]);
	});

	it("never draws past the width", () => {
		for (const width of [120, 80, 60, 40, 24, 12, 8, 6, 3, 2, 1]) {
			const line = strip(agents(10));
			line.setStallMarkers(["ghost: stalled 70s"]);
			for (const focused of [false, true]) {
				line.focused = focused;
				for (const rendered of line.render(width)) {
					expect(visibleWidth(rendered), `width ${width}`).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("writes each child as a gold block with its state in plain words and the state's own color", () => {
		const line = strip([
			row("a", "running", "alpha"),
			row("b", "idle", "beta"),
			row("c", "done", "gamma"),
			row("d", "failed", "delta"),
			row("e", "stalled", "epsilon"),
		]);
		const [rendered] = line.render(120);
		const text = plain([rendered ?? ""]);
		expect(text).toContain(" ◇ alpha 回答中 ");
		expect(text).toContain(" ◇ beta 空闲 ");
		expect(text).toContain(" ◇ gamma ✓ 已交回 ");
		expect(text).toContain(" ◇ delta ✗ 出错 ");
		expect(text).toContain(" ◇ epsilon ⚠ 卡住 ");
		expect(count(rendered ?? "", bgOpen("kindSubagentBg"))).toBe(5);
		expect(rendered).toContain(theme.bold(theme.fg("timelineSub", "◇")));
		expect(rendered).toContain(theme.fg("timelineAi", "回答中"));
		expect(rendered).toContain(theme.fg("dim", "空闲"));
		expect(rendered).toContain(theme.fg("timelineOk", "✓ 已交回"));
		expect(rendered).toContain(theme.fg("error", "✗ 出错"));
		expect(rendered).toContain(theme.fg("error", "⚠ 卡住"));
		// A space between blocks, and none of the old header or per-child list.
		expect(text).not.toContain("子代理 5");
		expect(text).not.toContain("─");
	});

	it("cuts a long name to about 16 columns with an ellipsis", () => {
		const name = "a-very-long-subagent-name-indeed";
		const line = strip([row("a", "running", name)]);
		const text = plain(line.render(120));
		expect(text).not.toContain(name);
		expect(text).toContain("…");
		const shown = /◇ (\S+…)/.exec(text)?.[1] ?? "";
		expect(visibleWidth(shown)).toBeLessThanOrEqual(16);
		expect(visibleWidth(shown)).toBeGreaterThanOrEqual(12);
	});

	it("lays the blocks out in the order the children were dispatched, while the rows stay most-relevant-first", () => {
		const child = (id: string, status: AgentConnectionRlmChildAgentSnapshot["status"], extra = {}) =>
			({ id, label: id, status, sessionDir: `/tmp/${id}`, ...extra }) as AgentConnectionRlmChildAgentSnapshot;
		const rows = buildSubagentPanelRows(
			[
				child("done-1", "done"),
				child("run-1", "running"),
				child("err-1", "error", { error: "boom" }),
				child("stall-1", "running", {
					activity: { kind: "stalled" },
					stall: { silentMs: 95_000, thresholdMs: 60_000, inFlightTools: [] },
				}),
			],
			undefined,
		);
		// The list (the agents panel, the duty log) still ranks by state.
		expect(rows.map((row) => row.id)).toEqual(["stall-1", "err-1", "run-1", "done-1"]);
		const text = plain(strip(rows).render(160));
		const order = ["done-1", "run-1", "err-1", "stall-1"].map((name) => text.indexOf(name));
		expect(order.every((at) => at >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	describe("when the blocks do not all fit", () => {
		it("shows how many are off to the right, then how many are off to the left, with the right numbers", () => {
			const line = strip(agents(10));
			let text = plain(line.render(60));
			const shown = visibleNames(text).length;
			expect(shown).toBeGreaterThan(0);
			expect(shown).toBeLessThan(10);
			expect(text).not.toContain("‹");
			expect(text).toContain(`还有 ${10 - shown} 个 ›`);

			const wheel = line.getClickRegions().find((region) => region.onWheel);
			expect(wheel?.onWheel?.(1)).toBe(true);
			text = plain(line.render(60));
			const names = visibleNames(text);
			const left = Number(/‹ 还有 (\d+) 个/.exec(text)?.[1]);
			const right = Number(/还有 (\d+) 个 ›/.exec(text)?.[1] ?? 0);
			expect(left).toBe(1);
			expect(names[0]).toBe("agent-1");
			expect(left + names.length + right).toBe(10);
		});

		it("scrolls one block per wheel notch, both ways, and hands the wheel back at each end", () => {
			const line = strip(agents(10));
			const wheel = () => line.getClickRegions().find((region) => region.onWheel);
			line.render(60);
			// Already at the left end: the page scrolls instead.
			expect(wheel()?.onWheel?.(-1)).toBe(false);

			expect(wheel()?.onWheel?.(1)).toBe(true);
			expect(visibleNames(plain(line.render(60)))[0]).toBe("agent-1");
			expect(wheel()?.onWheel?.(1)).toBe(true);
			expect(visibleNames(plain(line.render(60)))[0]).toBe("agent-2");
			expect(wheel()?.onWheel?.(-1)).toBe(true);
			expect(visibleNames(plain(line.render(60)))[0]).toBe("agent-1");

			let notches = 0;
			while (wheel()?.onWheel?.(1)) {
				line.render(60);
				notches += 1;
				expect(notches).toBeLessThan(20);
			}
			const end = plain(line.render(60));
			expect(visibleNames(end)).toContain("agent-9");
			expect(end).not.toContain("›");
			expect(end).toContain("‹");
			// At the right end the wheel goes back to the page; coming back left still works.
			expect(wheel()?.onWheel?.(1)).toBe(false);
			expect(wheel()?.onWheel?.(-1)).toBe(true);
		});

		it("keeps the wheel area over the whole row, gaps included", () => {
			const line = strip(agents(10));
			line.render(60);
			const wheelRegions = line.getClickRegions().filter((region) => region.onWheel);
			expect(wheelRegions.length).toBeGreaterThan(0);
			const rowRegion = wheelRegions.find((region) => region.passive === true && region.col === 0);
			expect(rowRegion).toBeDefined();
			expect(rowRegion?.width).toBe(60);
			expect(rowRegion?.line).toBe(0);
			expect(rowRegion?.height).toBe(1);
		});

		it("pages a screenful when the right or left marker is clicked", () => {
			const line = strip(agents(30));
			const first = visibleNames(plain(line.render(60)));
			markerRegions(line)[0]?.onClick({ row: 0, col: 0 });
			const second = visibleNames(plain(line.render(60)));
			expect(second[0]).toBe(`agent-${first.length}`);

			const back = markerRegions(line).find((region) => region.col < 6);
			expect(back).toBeDefined();
			back?.onClick({ row: 0, col: 0 });
			expect(visibleNames(plain(line.render(60)))[0]).toBe("agent-0");
		});
	});

	describe("clicking and pointing", () => {
		it("opens the child whose block was clicked", () => {
			const rows = agents(3);
			const line = strip(rows);
			line.render(120);
			const onOpen = vi.fn();
			line.onOpen = onOpen;
			const regions = chipRegions(line);
			expect(regions).toHaveLength(3);
			regions[1]?.onClick({ row: 0, col: 2 });
			expect(onOpen).toHaveBeenCalledTimes(1);
			expect(onOpen).toHaveBeenCalledWith(rows[1]);
		});

		it("does nothing on a click when the session cannot open children", () => {
			const line = strip(agents(3), { openable: false });
			line.render(120);
			const onOpen = vi.fn();
			line.onOpen = onOpen;
			const blocks = line.getClickRegions().filter((region) => !region.passive);
			expect(blocks).toHaveLength(3);
			for (const region of blocks) region.onClick({ row: 0, col: 0 });
			expect(onOpen).not.toHaveBeenCalled();
			// Nothing to light up either.
			expect(blocks.every((region) => region.onHover === undefined)).toBe(true);
			expect(line.isSelectable()).toBe(false);
		});

		it("puts each block's click area exactly over the block", () => {
			const line = strip(agents(3));
			const [rendered] = line.render(120);
			const regions = chipRegions(line);
			const text = plain([rendered ?? ""]);
			for (const [index, region] of regions.entries()) {
				const block = ` ◇ agent-${index} 回答中 `;
				const at = text.indexOf(block);
				expect(at).toBeGreaterThanOrEqual(0);
				expect(region.line).toBe(0);
				expect(region.height).toBe(1);
				expect(region.col).toBe(visibleWidth(text.slice(0, at)));
				expect(region.width).toBe(visibleWidth(block));
			}
		});

		it("lights the pointed block's background without moving anything", () => {
			const line = strip(agents(3));
			const before = line.render(120);
			const regionsBefore = line.getClickRegions().map((region) => ({ ...region }));
			const target = chipRegions(line)[1];
			expect(target?.onHover).toBeDefined();

			target?.onHover?.(true);
			const during = line.render(120);
			expect(during).toHaveLength(before.length);
			expect(plain(during)).toBe(plain(before));
			expect(during).not.toEqual(before);
			expect(count(during[0] ?? "", bgOpen("kindSubagentHoverBg"))).toBe(1);
			expect(count(during[0] ?? "", bgOpen("kindSubagentBg"))).toBe(2);
			const regionsDuring = line.getClickRegions();
			expect(regionsDuring.map(({ line: l, col, width, height }) => ({ line: l, col, width, height }))).toEqual(
				regionsBefore.map(({ line: l, col, width, height }) => ({ line: l, col, width, height })),
			);
			expect(regionsDuring.map((region) => region.hoverKey)).toEqual(regionsBefore.map((region) => region.hoverKey));

			target?.onHover?.(false);
			expect(line.render(120)).toEqual(before);
		});

		it("gives every block its own stable hover identity", () => {
			const line = strip(agents(4));
			line.render(120);
			const keys = chipRegions(line).map((region) => region.hoverKey);
			expect(new Set(keys).size).toBe(4);
			line.render(120);
			expect(chipRegions(line).map((region) => region.hoverKey)).toEqual(keys);
		});

		it("returns the same lines until something on the row changes", () => {
			const line = strip(agents(3));
			const first = line.render(120);
			expect(line.render(120)).toBe(first);
			chipRegions(line)[0]?.onHover?.(true);
			expect(line.render(120)).not.toBe(first);
		});
	});

	describe("with the keyboard", () => {
		it("moves the selection with the arrow keys, opens with Enter and leaves with Up or Esc", () => {
			const rows = agents(4);
			const line = strip(rows);
			const onOpen = vi.fn();
			const onCancel = vi.fn();
			line.onOpen = onOpen;
			line.onCancel = onCancel;
			line.focused = true;

			line.handleInput(ENTER);
			expect(onOpen).toHaveBeenLastCalledWith(rows[0]);
			line.handleInput(RIGHT);
			line.handleInput(RIGHT);
			line.handleInput(ENTER);
			expect(onOpen).toHaveBeenLastCalledWith(rows[2]);
			line.handleInput(LEFT);
			line.handleInput(ENTER);
			expect(onOpen).toHaveBeenLastCalledWith(rows[1]);

			// The ends are floors, not loops.
			line.handleInput(LEFT);
			line.handleInput(LEFT);
			line.handleInput(ENTER);
			expect(onOpen).toHaveBeenLastCalledWith(rows[0]);
			for (let press = 0; press < 6; press++) line.handleInput(RIGHT);
			line.handleInput(ENTER);
			expect(onOpen).toHaveBeenLastCalledWith(rows[3]);

			expect(onCancel).not.toHaveBeenCalled();
			line.handleInput(UP);
			expect(onCancel).toHaveBeenCalledTimes(1);
			line.handleInput(ESC);
			expect(onCancel).toHaveBeenCalledTimes(2);
		});

		it("marks the selected block with a brighter background and an underlined name, and only while focused", () => {
			const line = strip(agents(3));
			const idle = line.render(120)[0] ?? "";
			expect(idle).not.toContain(bgOpen("kindSubagentHoverBg"));
			expect(idle).not.toContain(theme.underline("agent-0"));

			line.focused = true;
			const first = line.render(120)[0] ?? "";
			line.handleInput(RIGHT);
			const focused = line.render(120)[0] ?? "";
			expect(count(focused, bgOpen("kindSubagentHoverBg"))).toBe(1);
			expect(count(focused, bgOpen("kindSubagentBg"))).toBe(2);
			expect(focused).toContain(theme.underline(theme.bold("agent-1")));
			// The brighter block is the second one on screen.
			const onBrighter = focused.slice(focused.indexOf(bgOpen("kindSubagentHoverBg")));
			expect(stripAnsi(onBrighter.slice(0, onBrighter.indexOf("\x1b[49m")))).toContain("agent-1");
			// Moving the selection changes colors only: same text, same width.
			expect(stripAnsi(focused)).toBe(stripAnsi(first));
			expect(visibleWidth(focused)).toBe(visibleWidth(first));
		});

		it("scrolls the row to keep the selected block in view, so every child can be reached", () => {
			const rows = agents(12);
			const line = strip(rows);
			const onOpen = vi.fn();
			line.onOpen = onOpen;
			line.focused = true;
			expect(line.render(60)).toHaveLength(1);
			for (let index = 0; index < rows.length; index++) {
				const text = plain(line.render(60));
				expect(visibleNames(text), `selection ${index}`).toContain(`agent-${index}`);
				line.handleInput(ENTER);
				expect(onOpen).toHaveBeenLastCalledWith(rows[index]);
				line.handleInput(RIGHT);
			}
			// And back to the start.
			for (let press = 0; press < 20; press++) line.handleInput(LEFT);
			expect(visibleNames(plain(line.render(60)))).toContain("agent-0");
			line.handleInput(ENTER);
			expect(onOpen).toHaveBeenLastCalledWith(rows[0]);
		});

		it("keeps the selection on the same child when the rows reorder", () => {
			const line = strip([row("x"), row("y"), row("z")]);
			line.focused = true;
			line.handleInput(RIGHT);
			line.setSubagentRows([row("x"), row("z"), row("y", "done")]);
			const onOpen = vi.fn();
			line.onOpen = onOpen;
			line.handleInput(ENTER);
			expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "y" }));
		});

		it("keeps the stop-all key working and hands other keys to the prompt", () => {
			const line = strip(agents(2));
			const onStopAll = vi.fn();
			const onChatAction = vi.fn();
			line.onStopAll = onStopAll;
			line.onChatAction = onChatAction;
			line.focused = true;
			line.handleInput("\x1bx");
			expect(onStopAll).toHaveBeenCalledTimes(1);
			line.handleInput("q");
			expect(onChatAction).toHaveBeenCalledWith("q");
			// Down has nowhere to go on a single row: it stays put instead of typing into the prompt.
			line.handleInput(DOWN);
			expect(onChatAction).toHaveBeenCalledTimes(1);
		});

		it("takes the selection keys from the configurable bindings", () => {
			setKeybindings(new KeybindingsManager({ "app.subagents.next": "ctrl+l", "app.subagents.prev": "ctrl+h" }));
			try {
				const rows = agents(3);
				const line = strip(rows);
				const onOpen = vi.fn();
				line.onOpen = onOpen;
				line.focused = true;
				line.handleInput("\x0c");
				line.handleInput(ENTER);
				expect(onOpen).toHaveBeenLastCalledWith(rows[1]);
				line.handleInput("\x08");
				line.handleInput(ENTER);
				expect(onOpen).toHaveBeenLastCalledWith(rows[0]);
				const hint = plain(line.render(120));
				expect(hint).toContain("Ctrl+H/Ctrl+L 选");
			} finally {
				setKeybindings(new KeybindingsManager());
			}
		});
	});

	describe("the hint at the end of the row", () => {
		it("leaves a key out of the hint while it is unbound", () => {
			setKeybindings(new KeybindingsManager({ "app.subagents.prev": [], "app.subagents.next": [] }));
			try {
				const line = strip(agents(2, "idle"));
				line.focused = true;
				const text = plain(line.render(120)).trimEnd();
				expect(text.endsWith("Enter 进去 · Esc 返回")).toBe(true);
				expect(text).not.toContain("/ 选");
				expect(text).not.toContain("  选");
			} finally {
				setKeybindings(new KeybindingsManager());
			}
		});

		it("says how to get in while the prompt has the keyboard, and how to move once inside", () => {
			const line = strip(agents(2));
			expect(plain(line.render(120)).trimEnd().endsWith("↓ 选一个进去看")).toBe(true);
			line.focused = true;
			const focused = plain(line.render(120)).trimEnd();
			expect(focused).toContain("←/→ 选 · Enter 进去 · Esc 返回");
			expect(focused).not.toContain("选一个进去看");
			// Something is working, so stopping them all is offered too; not when all are idle.
			expect(focused).toMatch(/全部停止$/);
			const settled = strip(agents(2, "idle"));
			settled.focused = true;
			expect(plain(settled.render(120)).trimEnd().endsWith("←/→ 选 · Enter 进去 · Esc 返回")).toBe(true);
		});

		it("shows no hint when the session cannot open children, and drops it when there is no room", () => {
			const closed = strip(agents(2), { openable: false });
			expect(plain(closed.render(120))).not.toContain("选一个进去看");

			const line = strip(agents(2));
			const blocksOnly = visibleWidth(plain(closed.render(120)).trimEnd());
			expect(plain(line.render(blocksOnly + 3))).not.toContain("↓");
			expect(plain(line.render(blocksOnly + 3))).toContain("agent-1");
			expect(plain(line.render(blocksOnly + 40))).toContain("↓ 选一个进去看");
		});

		it("explains an all-finished family in the hint when there is room, and keeps the blocks either way", () => {
			const line = strip([row("a", "done", "one"), row("b", "done", "two")]);
			line.setSubagentCounts({ total: 2, running: 0, idle: 0, inactive: 2 });
			const wide = plain(line.render(120));
			expect(wide).toContain("✓ 已交回");
			expect(wide).toContain("都做完了，已自动关闭（记录保留）");
			const narrow = plain(line.render(40));
			expect(narrow).toContain("✓ 已交回");
			expect(narrow).not.toContain("都做完了");
			expect(line.render(40)).toHaveLength(1);

			line.setSubagentRows([row("a", "done", "one"), row("b", "idle", "two")]);
			expect(plain(line.render(120))).toContain("闲置一阵后会自动关闭");
		});
	});

	describe("a stalled descendant without a block of its own", () => {
		it("becomes a red block in the same row instead of a line of its own", () => {
			const line = strip([row("w", "stalled", "worker")]);
			line.setStallMarkers(["worker: stalled 70s", "ghost: stalled 90s, in-flight: bash"]);
			const rendered = line.render(120);
			expect(rendered).toHaveLength(1);
			const text = plain(rendered);
			expect(text).toContain(" ⚠ ghost 卡住 ");
			// The worker already says 卡住 on its own block: no second block for it.
			expect(text).not.toContain("worker: stalled");
			expect(count(text, "worker")).toBe(1);
			expect(count(rendered[0] ?? "", bgOpen("kindErrorBg"))).toBe(1);
			expect(rendered[0]).toContain(theme.fg("kindError", "⚠"));
			expect(text.indexOf("ghost")).toBeLessThan(text.indexOf("worker"));
		});

		it("can be reached with the arrow keys and opens the family view", () => {
			const line = strip([row("w", "running", "worker")]);
			line.setStallMarkers(["ghost: stalled 90s"]);
			const onOpen = vi.fn();
			line.onOpen = onOpen;
			line.focused = true;
			line.handleInput(ENTER);
			expect(onOpen).toHaveBeenLastCalledWith(undefined);
			line.handleInput(RIGHT);
			line.handleInput(ENTER);
			expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "w" }));
		});
	});

	describe("a family the roster counts but no snapshot describes", () => {
		it("keeps one block with the counts, which opens the family view", () => {
			const line = new SubagentSummaryLine();
			line.setSubagentCounts({ total: 3, running: 2, idle: 0, inactive: 1 });
			line.setOpenable(true);
			const rendered = line.render(120);
			expect(rendered).toHaveLength(1);
			const text = plain(rendered);
			expect(text).toContain("子代理 3");
			expect(text).toContain("运行 2 · 收口 1");
			expect(line.hasChipRow()).toBe(false);
			const onOpen = vi.fn();
			line.onOpen = onOpen;
			chipRegions(line)[0]?.onClick({ row: 0, col: 0 });
			expect(onOpen).toHaveBeenCalledWith(undefined);
			expect(line.isSelectable()).toBe(true);
		});

		it("reports a block row only while there are per-child blocks", () => {
			const line = strip(agents(2));
			expect(line.hasChipRow()).toBe(true);
			line.setSubagentRows([]);
			expect(line.hasChipRow()).toBe(false);
			line.setSubagentRows(agents(2));
			line.setSubagentCounts({ total: 0, running: 0, idle: 0, inactive: 0 });
			expect(line.hasChipRow()).toBe(false);
		});
	});

	it("keeps the spend figure for the status line to read", () => {
		const line = strip(agents(1));
		expect(line.getSubagentSpend()).toBeUndefined();
		const spend = { cost: 4.56, tokens: 1000, parentCost: 0.5, unpriced: [], partial: false };
		line.setSubagentSpend(spend);
		expect(line.getSubagentSpend()).toBe(spend);
		expect(plain(line.render(120))).not.toContain("¥");
	});
});
