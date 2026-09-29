import { type ClickRegion, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { BOX_FOCUS_MARKER } from "../src/modes/interactive/components/turn-box.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import {
	addActivities,
	addCommand,
	addSay,
	hasBg,
	host,
	plain,
	type QuietTurn,
	quietTurn,
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
const hoverBg = () => theme.getBgAnsi("timelineHoverBg");

function regionsOn(turn: QuietTurn, line: number): ClickRegion[] {
	return turn.summary.getClickRegions().filter((region) => region.line === line);
}

/** The one click area of a line. */
function regionOn(turn: QuietTurn, line: number): ClickRegion | undefined {
	const regions = regionsOn(turn, line);
	expect(regions.length).toBeLessThanOrEqual(1);
	return regions[0];
}

/** Display width of a plain line (wide characters count two columns). */
function widthOf(line: string): number {
	let cols = 0;
	for (const ch of line) cols += /[ᄀ-ᅟ⺀-鿿가-힣＀-｠]/.test(ch) ? 2 : 1;
	return cols;
}

/** Index of the first line after the first whose plain text contains `needle`, or -1. */
function lineOf(lines: readonly string[], needle: string): number {
	return plain(lines).findIndex((line, index) => index > 0 && line.includes(needle));
}

/** Two steps in one millisecond would share a message: every step is added a second after the last. */
function useSteppedClock(): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
}

function later(): void {
	vi.setSystemTime(Date.now() + 1_000);
}

/** A turn with one command, its event opened, and the line its step sits on. */
function boxWithCommand(options: { output?: string; text?: string } = {}) {
	const hostMock = host();
	const turn = quietTurn({ host: hostMock });
	const label = options.text ?? "git status";
	addCommand(turn, "c1", label, { output: options.output ?? "clean" });
	turn.summary.toggleBox();
	const lines = turn.summary.render(WIDTH);
	const at = lineOf(lines, `$  ${label.slice(0, 16)}`);
	expect(at).toBeGreaterThan(0);
	return { turn, hostMock, at };
}

/** Indexes of the lines painted with the hover color. */
function litLines(lines: readonly string[]): number[] {
	return lines.flatMap((line, index) => (line.includes(hoverBg()) ? [index] : []));
}

describe("a line tells the pointer layer who it is", () => {
	it("gives a step's line its own hover key and callback, and the row under it none", () => {
		const { turn, at } = boxWithCommand();
		const head = regionOn(turn, at);
		expect(head?.hoverKey).toBeTypeOf("string");
		expect(head?.hoverKey).toContain(CMD_KEY);
		expect(head?.onHover).toBeTypeOf("function");
		expect(regionsOn(turn, at + 1)).toHaveLength(0);
		// The event above it is a target of its own.
		const event = regionOn(turn, 0);
		expect(event?.hoverKey).toContain(":ev:");
		expect(event?.hoverKey).not.toBe(head?.hoverKey);
		expect(event?.onHover).toBeTypeOf("function");
	});

	it("keeps the key the same from frame to frame and different between rows and between boxes", () => {
		useSteppedClock();
		const { turn, at } = boxWithCommand();
		const keyOf = (t: QuietTurn, line: number) => regionOn(t, line)?.hoverKey;
		const first = keyOf(turn, at);
		turn.summary.invalidate();
		turn.summary.render(WIDTH);
		expect(keyOf(turn, at)).toBe(first);

		later();
		addCommand(turn, "c2", "git log", { output: "abc" });
		const lines = turn.summary.render(WIDTH);
		const second = keyOf(turn, lineOf(lines, "$  git log"));
		expect(second).toBeDefined();
		expect(second).not.toBe(first);

		later();
		const other = boxWithCommand();
		expect(keyOf(other.turn, other.at)).toBeDefined();
		expect(keyOf(other.turn, other.at)).not.toBe(first);
	});

	it("gives what hangs under a step, an interjection and the gaps no click area at all", () => {
		useSteppedClock();
		const turn = quietTurn();
		addSay(turn, "趁等待，查一个风险点。", "s1");
		later();
		addCommand(turn, "c1", "git status", { output: "clean\nmore" });
		later();
		turn.timeline.addSteer("先别动安卓的，只升级 Go", Date.now());
		turn.summary.toggleBox();
		turn.summary.render(WIDTH);
		turn.summary.activate(CMD_KEY);
		const shown = plain(turn.summary.render(WIDTH));
		const passive = {
			detail: shown.findIndex((line) => /^ {9}│ {14}clean$/.test(line)),
			steer: shown.findIndex((line) => line.includes("你插话")),
			gap: shown.findIndex((line) => line.trimEnd() === "         │"),
		};
		expect(Object.values(passive).every((line) => line > 0)).toBe(true);
		for (const [name, line] of Object.entries(passive)) {
			expect(regionsOn(turn, line), `regions on the ${name} line`).toHaveLength(0);
		}
	});
});

describe("the line under the pointer lights up", () => {
	it("paints the whole line in the hover color, moves nothing, and leaves again", () => {
		const { turn, hostMock, at } = boxWithCommand();
		const calm = turn.summary.render(WIDTH);
		expect(litLines(calm)).toHaveLength(0);

		regionOn(turn, at)?.onHover?.(true);
		expect(hostMock.requestRender).toHaveBeenCalled();
		const lit = turn.summary.render(WIDTH);
		const block = lit[at] ?? "";
		expect(block.startsWith(hoverBg())).toBe(true);
		expect(block.endsWith("\x1b[49m")).toBe(true);
		expect(hasBg(block, "kindCommandHoverBg")).toBe(false);
		// The line keeps its words and its width to the last column: no hint is added.
		expect(plain(lit)[at]).toBe(plain(calm)[at]);
		expect(plain(lit)[at]).not.toContain("点开");
		expect(widthOf(plain(lit)[at] ?? "")).toBe(WIDTH);
		expect(litLines(lit)).toEqual([at]);

		regionOn(turn, at)?.onHover?.(false);
		const after = turn.summary.render(WIDTH);
		expect(litLines(after)).toHaveLength(0);
		expect(plain(after)).toEqual(plain(calm));
	});

	it("lights only the line the pointer is on: an event does not light its steps, nor a step its event", () => {
		const { turn, at } = boxWithCommand();
		regionOn(turn, 0)?.onHover?.(true);
		expect(litLines(turn.summary.render(WIDTH))).toEqual([0]);
		regionOn(turn, at)?.onHover?.(true);
		expect(litLines(turn.summary.render(WIDTH))).toEqual([at]);
	});

	it("keeps an opened event's arrow and an opened step's line as they are under the pointer, and Enter says 收起", () => {
		const { turn, at } = boxWithCommand();
		const eventKey = turn.summary.getFocusOrder()[0] ?? "";
		const opened = plain(turn.summary.render(WIDTH));
		expect(opened[0]).toMatch(/1 步 ▴ {2}$/);
		expect(turn.summary.enterLabel(eventKey)).toBe("收起");
		regionOn(turn, 0)?.onHover?.(true);
		expect(plain(turn.summary.render(WIDTH))[0]).toBe(opened[0]);
		expect(plain(turn.summary.render(WIDTH))[0]).not.toContain("收起");

		expect(turn.summary.enterLabel(CMD_KEY)).toBe("展开");
		turn.summary.activate(CMD_KEY);
		expect(turn.summary.enterLabel(CMD_KEY)).toBe("收起");
		const before = plain(turn.summary.render(WIDTH))[at];
		regionOn(turn, at)?.onHover?.(true);
		const pointed = turn.summary.render(WIDTH);
		expect(plain(pointed)[at]).toBe(before);
		expect(plain(pointed)[at]).not.toMatch(/收起|▾|▴/);
		expect(litLines(pointed)).toEqual([at]);
	});

	it("cuts a long text to make room for the result instead of dropping the result", () => {
		const long = `git log --stat --format=%H ${"very-long-argument ".repeat(8)}`.trim();
		const { turn, at } = boxWithCommand({ text: long });
		const calm = plain(turn.summary.render(60))[at] ?? "";
		expect(calm).toMatch(/^ {9}│ {11}\$ {2}git log .*…\s+✓ done {4}$/);
		regionOn(turn, at)?.onHover?.(true);
		const lit = turn.summary.render(60);
		expect(lit[at]).toContain(hoverBg());
		const line = plain(lit)[at] ?? "";
		expect(line).toBe(calm);
		expect(line).toContain("…");
		expect(line).toMatch(/…\s+✓ done {4}$/);
		expect(widthOf(line)).toBe(60);
	});

	it("only asks for a frame when the pointed line changed", () => {
		const { turn, hostMock, at } = boxWithCommand();
		const head = regionOn(turn, at);
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

	it("keeps the newer step lit when the older one reports leaving after it", () => {
		useSteppedClock();
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean" });
		later();
		addCommand(turn, "c2", "git log", { output: "abc" });
		turn.summary.toggleBox();
		const lines = turn.summary.render(WIDTH);
		const firstAt = lineOf(lines, "$  git status");
		const secondAt = lineOf(lines, "$  git log");
		expect(firstAt).toBeGreaterThan(0);
		expect(secondAt).toBeGreaterThan(0);
		const first = regionOn(turn, firstAt);
		const second = regionOn(turn, secondAt);
		first?.onHover?.(true);
		second?.onHover?.(true);
		first?.onHover?.(false);
		expect(litLines(turn.summary.render(WIDTH))).toEqual([secondAt]);
	});
});

describe("the keyboard's selection looks like the pointer's", () => {
	it("lights the selected step with the hover color and marks it for the viewport, not with the old focus tint", () => {
		const { turn, at } = boxWithCommand();
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = CMD_KEY;
		turn.timeline.ui.bump();
		const lit = turn.summary.render(WIDTH);
		expect(lit[at]?.startsWith(BOX_FOCUS_MARKER)).toBe(true);
		expect(lit[at]).toContain(hoverBg());
		expect(hasBg(lit[at] ?? "", "cardFocusBg")).toBe(false);
		expect(litLines(lit)).toEqual([at]);
		expect(lit.filter((line) => line.includes(BOX_FOCUS_MARKER))).toHaveLength(1);
		expect(plain(lit)[at]).toMatch(/^ {9}│ {11}\$ {2}git status/);
		expect(plain(lit)[at]).not.toContain("点开");
		expect(widthOf(plain(lit)[at] ?? "")).toBe(WIDTH);
	});

	it("lights a selected step that only has the facts of its step to open, the same way", () => {
		const turn = quietTurn();
		addActivities(turn, "r1", [{ id: "a", kind: "read", label: "README.md", status: "ok", startedAt: 1 }]);
		turn.summary.toggleBox();
		turn.summary.render(WIDTH);
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = "act:r1:a";
		turn.timeline.ui.bump();
		const lines = turn.summary.render(WIDTH);
		const at = lineOf(lines, "读取 README.md");
		expect(at).toBeGreaterThan(0);
		expect(lines[at]?.startsWith(BOX_FOCUS_MARKER)).toBe(true);
		expect(lines[at]).toContain(hoverBg());
		expect(litLines(lines)).toEqual([at]);
	});

	it("lights the first line the walk stops on when the focus sits on `header`", () => {
		const { turn } = boxWithCommand();
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = "header";
		turn.timeline.ui.bump();
		const lines = turn.summary.render(WIDTH);
		expect(lines[0]?.startsWith(BOX_FOCUS_MARKER)).toBe(true);
		expect(litLines(lines)).toEqual([0]);
		expect(turn.summary.enterLabel("header")).toBe("收起");
	});
});

describe("a new row does not flash", () => {
	it("draws a new step in no hover color, then or a second later", () => {
		useSteppedClock();
		const turn = quietTurn({ startedAt: T0 - 5_000 });
		turn.summary.render(WIDTH);
		addCommand(turn, "c1", "git status", { output: "clean" });
		turn.summary.toggleBox();
		const fresh = turn.summary.render(WIDTH);
		expect(lineOf(fresh, "$  git status")).toBeGreaterThan(0);
		expect(litLines(fresh)).toHaveLength(0);
		expect(fresh.some((line) => hasBg(line, "kindCommandHoverBg"))).toBe(false);
		vi.setSystemTime(T0 + 1_000);
		turn.summary.invalidate();
		const settled = turn.summary.render(WIDTH);
		expect(lineOf(settled, "$  git status")).toBeGreaterThan(0);
		expect(litLines(settled)).toHaveLength(0);
		expect(plain(settled)).toEqual(plain(fresh));
	});

	it("draws a new step in no hover color with reduced motion either", () => {
		useSteppedClock();
		setMotionReduced(true);
		const turn = quietTurn({ startedAt: T0 - 5_000 });
		turn.summary.render(WIDTH);
		addCommand(turn, "c1", "git status", { output: "clean" });
		turn.summary.toggleBox();
		const lines = turn.summary.render(WIDTH);
		expect(lineOf(lines, "$  git status")).toBeGreaterThan(0);
		expect(litLines(lines)).toHaveLength(0);
		expect(lines.some((line) => hasBg(line, "kindCommandHoverBg"))).toBe(false);
	});
});
