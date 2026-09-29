import { type ClickRegion, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type SubagentPanelRow,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * A click on a block opens what the block stands for now. The region a frame drew can
 * outlive the data it was drawn from (a redraw that changes nothing visible is cached),
 * so the click reads the strip's current blocks instead of the row it captured.
 */

const WIDTH = 60;

function strip(rows: readonly SubagentPanelRow[]): { line: SubagentSummaryLine; onOpen: ReturnType<typeof vi.fn> } {
	const line = new SubagentSummaryLine();
	line.setSubagentCounts({ total: rows.length, running: rows.length, idle: 0, inactive: 0 });
	line.setSubagentRows(rows);
	line.setOpenable(true);
	const onOpen = vi.fn();
	line.onOpen = onOpen;
	return { line, onOpen };
}

function chipRegions(line: SubagentSummaryLine): ClickRegion[] {
	return line.getClickRegions().filter((region) => region.hoverKey?.startsWith("subagent-chip:"));
}

describe("a click on a subagent block", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("opens the child directly once the row learned its session, though nothing on screen changed", () => {
		const { line, onOpen } = strip([{ id: "a", name: "alpha", state: "running" }]);
		const before = line.render(WIDTH);
		const [region] = chipRegions(line);
		expect(region).toBeDefined();

		line.setSubagentRows([{ id: "a", name: "alpha", state: "running", activeSessionId: "session-a" }]);
		// Same words and colors, so the frame is the cached one and the region is the old one.
		expect(line.render(WIDTH)).toBe(before);
		expect(chipRegions(line)[0]).toBe(region);

		region?.onClick({ row: 0, col: 1 });
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(onOpen.mock.calls[0]?.[0]).toMatchObject({ id: "a", activeSessionId: "session-a" });
	});

	it("opens the session directory the row gained too", () => {
		const { line, onOpen } = strip([{ id: "a", name: "alpha", state: "idle" }]);
		line.render(WIDTH);
		const [region] = chipRegions(line);
		line.setSubagentRows([{ id: "a", name: "alpha", state: "idle", sessionDir: "/work/a" }]);
		line.render(WIDTH);
		region?.onClick({ row: 0, col: 1 });
		expect(onOpen.mock.calls[0]?.[0]).toMatchObject({ id: "a", sessionDir: "/work/a" });
	});

	it("opens nothing for a block whose child is gone, rather than a child it no longer shows", () => {
		const { line, onOpen } = strip([
			{ id: "a", name: "alpha", state: "running" },
			{ id: "b", name: "beta", state: "running" },
		]);
		line.render(WIDTH);
		const regions = chipRegions(line);
		expect(regions).toHaveLength(2);
		line.setSubagentRows([{ id: "b", name: "beta", state: "running" }]);
		line.setSubagentCounts({ total: 1, running: 1, idle: 0, inactive: 0 });
		regions[0]?.onClick({ row: 0, col: 1 });
		expect(onOpen).not.toHaveBeenCalled();
		regions[1]?.onClick({ row: 0, col: 1 });
		expect(onOpen.mock.calls[0]?.[0]).toMatchObject({ id: "b" });
	});

	it("still opens the family view from the counts block", () => {
		const line = new SubagentSummaryLine();
		line.setSubagentCounts({ total: 3, running: 3, idle: 0, inactive: 0 });
		line.setOpenable(true);
		const onOpen = vi.fn();
		line.onOpen = onOpen;
		line.render(WIDTH);
		const [region] = chipRegions(line);
		expect(region).toBeDefined();
		region?.onClick({ row: 0, col: 1 });
		expect(onOpen).toHaveBeenCalledWith(undefined);
	});
});
