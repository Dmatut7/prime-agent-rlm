import { type ClickRegion, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import {
	addActivities,
	addCommand,
	addSay,
	bgAsFg,
	hasBg,
	host,
	lineIndexWith,
	plain,
	type QuietTurn,
	quietTurn,
	rawLineWith,
	T0,
	useTruecolorTheme,
} from "./ui-blocks-helpers.js";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

const WIDTH = 100;
const CMD_KEY = "act:c1:c1-a";

function regionsOn(turn: QuietTurn, line: number): ClickRegion[] {
	return turn.summary.getClickRegions().filter((region) => region.line === line);
}

function boxWithCommand(options: { output?: string; text?: string } = {}) {
	setMotionReduced(true);
	const hostMock = host();
	const turn = quietTurn({ host: hostMock });
	addCommand(turn, "c1", options.text ?? "git status", { output: options.output ?? "clean" });
	const lines = turn.summary.render(WIDTH);
	const at = lineIndexWith(lines, `$ ${(options.text ?? "git status").slice(0, 16)}`);
	return { turn, hostMock, at };
}

describe("a block tells the pointer layer who it is", () => {
	it("gives the block's row and its separator row the same hover key and callback", () => {
		const { turn, at } = boxWithCommand();
		const head = regionsOn(turn, at).find((region) => !region.passive);
		const gap = regionsOn(turn, at + 1).find((region) => !region.passive);
		expect(head?.hoverKey).toBeTypeOf("string");
		expect(head?.hoverKey).toContain(CMD_KEY);
		expect(gap?.hoverKey).toBe(head?.hoverKey);
		expect(head?.onHover).toBeTypeOf("function");
		expect(gap?.onHover).toBeTypeOf("function");
	});

	it("keeps the key the same from frame to frame and different between rows and between boxes", () => {
		const { turn, at } = boxWithCommand();
		const keyOf = (t: QuietTurn, line: number) => regionsOn(t, line).find((region) => !region.passive)?.hoverKey;
		const first = keyOf(turn, at);
		turn.summary.invalidate();
		turn.summary.render(WIDTH);
		expect(keyOf(turn, at)).toBe(first);

		addCommand(turn, "c2", "git log", { output: "abc" });
		const lines = turn.summary.render(WIDTH);
		const second = keyOf(turn, lineIndexWith(lines, "$ git log"));
		expect(second).toBeDefined();
		expect(second).not.toBe(first);

		const other = boxWithCommand();
		expect(keyOf(other.turn, other.at)).toBeDefined();
		expect(keyOf(other.turn, other.at)).not.toBe(first);
	});

	it("gives what hangs under a block and a note no hover fields", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addSay(turn, "趁等待，查一个风险点。", "s1");
		addCommand(turn, "c1", "git status", { output: "clean\nmore" });
		turn.timeline.ui.toggleRow(CMD_KEY);
		const lines = turn.summary.render(WIDTH);
		const shown = plain(lines);
		const passiveLines = [
			lineIndexWith(lines, "趁等待"),
			shown.findIndex((line) => line.includes("▎") && line.includes("clean")),
		];
		expect(passiveLines.every((line) => line > 0)).toBe(true);
		for (const line of passiveLines) {
			const regions = regionsOn(turn, line);
			expect(regions.length, `regions on line ${line}`).toBeGreaterThan(0);
			for (const region of regions) {
				expect(region.hoverKey, `hover key on line ${line}`).toBeUndefined();
				expect(region.onHover, `hover callback on line ${line}`).toBeUndefined();
			}
		}
	});
});

describe("the block under the pointer lights up", () => {
	it("repaints the block in its hover color with a colored caret and a hint, and leaves again", () => {
		const { turn, hostMock, at } = boxWithCommand();
		const head = regionsOn(turn, at).find((region) => !region.passive);
		expect(hasBg(rawLineWith(turn.summary.render(WIDTH), "$ git status"), "kindCommandBg")).toBe(true);

		head?.onHover?.(true);
		expect(hostMock.requestRender).toHaveBeenCalled();
		const lit = turn.summary.render(WIDTH);
		const block = lit[at] ?? "";
		expect(hasBg(block, "kindCommandHoverBg")).toBe(true);
		expect(hasBg(block, "kindCommandBg")).toBe(false);
		expect(block).toContain(theme.fg("kindCommand", "▸"));
		expect(plain(lit)[at]).toMatch(/\$ git status +点开 ▸ +✓ done +│$/);
		expect(block).toContain(theme.fg("kindCommand", "点开 ▸"));
		expect((lit[at + 1] ?? "").includes(bgAsFg("kindCommandHoverBg"))).toBe(true);

		head?.onHover?.(false);
		const calm = turn.summary.render(WIDTH);
		expect(hasBg(calm[at] ?? "", "kindCommandBg")).toBe(true);
		expect(plain(calm)[at]).not.toContain("点开");
	});

	it("lights the block when the pointer is on its separator row too", () => {
		const { turn, at } = boxWithCommand();
		regionsOn(turn, at + 1)
			.find((region) => !region.passive)
			?.onHover?.(true);
		expect(hasBg(turn.summary.render(WIDTH)[at] ?? "", "kindCommandHoverBg")).toBe(true);
	});

	it("says 收起 on an opened block that is pointed at, and shows ▾ on it either way", () => {
		const { turn, at } = boxWithCommand();
		turn.timeline.ui.toggleRow(CMD_KEY);
		const opened = turn.summary.render(WIDTH);
		expect(hasBg(opened[at] ?? "", "kindCommandHoverBg")).toBe(true);
		expect(plain(opened)[at]).toContain("▾");
		expect(plain(opened)[at]).not.toContain("收起");
		regionsOn(turn, at)
			.find((region) => !region.passive)
			?.onHover?.(true);
		const pointed = plain(turn.summary.render(WIDTH))[at] ?? "";
		expect(pointed).toContain("收起 ▴");
		expect(pointed).toContain("▾");
	});

	it("cuts a long text to make room for the hint instead of dropping the hint", () => {
		const long = `git log --stat --format=%H ${"very-long-argument ".repeat(8)}`.trim();
		const { turn, at } = boxWithCommand({ text: long });
		regionsOn(turn, at)
			.find((region) => !region.passive)
			?.onHover?.(true);
		const lit = plain(turn.summary.render(60));
		const line = lit.find((entry) => entry.includes("$ git log")) ?? "";
		expect(line).toContain("点开 ▸");
		expect(line).toContain("…");
		expect(line).toMatch(/…\s+点开 ▸\s+✓ done\s+│$/);
	});

	it("only asks for a frame when the pointed block changed", () => {
		const { turn, hostMock, at } = boxWithCommand();
		const head = regionsOn(turn, at).find((region) => !region.passive);
		const requests = () => vi.mocked(hostMock.requestRender).mock.calls.length;
		const before = requests();
		head?.onHover?.(false);
		expect(requests()).toBe(before);
		head?.onHover?.(true);
		expect(requests()).toBe(before + 1);
		head?.onHover?.(true);
		expect(requests()).toBe(before + 1);
		head?.onHover?.(false);
		expect(requests()).toBe(before + 2);
	});

	it("keeps the newer block lit when the older one reports leaving after it", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean" });
		addCommand(turn, "c2", "git log", { output: "abc" });
		const lines = turn.summary.render(WIDTH);
		const first = regionsOn(turn, lineIndexWith(lines, "$ git status")).find((region) => !region.passive);
		const second = regionsOn(turn, lineIndexWith(lines, "$ git log")).find((region) => !region.passive);
		first?.onHover?.(true);
		second?.onHover?.(true);
		first?.onHover?.(false);
		const after = turn.summary.render(WIDTH);
		expect(hasBg(rawLineWith(after, "$ git log"), "kindCommandHoverBg")).toBe(true);
		expect(hasBg(rawLineWith(after, "$ git status"), "kindCommandBg")).toBe(true);
	});
});

describe("the keyboard's selection looks like the pointer's", () => {
	it("lights the selected block with its hover color and hint, not the old focus tint", () => {
		const { turn, at } = boxWithCommand();
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = CMD_KEY;
		turn.timeline.ui.bump();
		const lit = turn.summary.render(WIDTH);
		expect(hasBg(lit[at] ?? "", "kindCommandHoverBg")).toBe(true);
		expect(hasBg(lit[at] ?? "", "cardFocusBg")).toBe(false);
		expect(plain(lit)[at]).toContain("点开 ▸");
		expect((lit[at] ?? "").includes(theme.fg("kindCommand", "▸"))).toBe(true);
	});

	it("lights a selected block that only has the facts of its step to open, with the same hint", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addActivities(turn, "r1", [{ id: "a", kind: "read", label: "README.md", status: "ok", startedAt: 1 }]);
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = "act:r1:a";
		turn.timeline.ui.bump();
		const lines = turn.summary.render(WIDTH);
		const at = lineIndexWith(lines, "读取 README.md");
		expect(hasBg(lines[at] ?? "", "kindReadHoverBg")).toBe(true);
		expect(plain(lines)[at]).toContain("点开 ▸");
	});
});

describe("a new row flashes in its hover color", () => {
	it("flashes the block in its hover color, then settles to its own color", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const turn = quietTurn({ startedAt: T0 - 5_000 });
		turn.summary.render(WIDTH);
		addCommand(turn, "c1", "git status", { output: "clean" });
		const flashing = turn.summary.render(WIDTH);
		expect(hasBg(rawLineWith(flashing, "$ git status"), "kindCommandHoverBg")).toBe(true);
		vi.setSystemTime(T0 + 1_000);
		turn.summary.invalidate();
		const settled = turn.summary.render(WIDTH);
		expect(hasBg(rawLineWith(settled, "$ git status"), "kindCommandBg")).toBe(true);
		expect(hasBg(rawLineWith(settled, "$ git status"), "kindCommandHoverBg")).toBe(false);
	});

	it("does not flash with reduced motion", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		setMotionReduced(true);
		const turn = quietTurn({ startedAt: T0 - 5_000 });
		turn.summary.render(WIDTH);
		addCommand(turn, "c1", "git status", { output: "clean" });
		const lines = turn.summary.render(WIDTH);
		expect(hasBg(rawLineWith(lines, "$ git status"), "kindCommandBg")).toBe(true);
		expect(hasBg(rawLineWith(lines, "$ git status"), "kindCommandHoverBg")).toBe(false);
	});
});
