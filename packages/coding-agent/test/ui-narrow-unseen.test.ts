import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { addCommand, addSay, host, plain, quietTurn, T0, text, useTruecolorTheme } from "./ui-blocks-helpers.js";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
});

beforeEach(() => {
	// Each step's message is keyed by its time: give every one its own millisecond.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

/** The clock moves on, so the next message is a new one. */
function later(): void {
	vi.setSystemTime(Date.now() + 10);
}

describe("a narrower terminal does not make old steps look new", () => {
	it("keeps every event on one line and every count where it was when the terminal narrows and notes get cut", () => {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ viewportRows: () => 24 }) });
		for (let index = 0; index < 8; index++) {
			addSay(
				turn,
				`趁等待，先查第 ${index} 个风险点：旧规则的返回值到底怎么处理。`,
				`s${index}`,
				Date.now() - 20_000 + index * 10,
			);
			later();
			addCommand(turn, `c${index}`, `echo ${index}`, { output: "x" });
			later();
		}
		// Eight events in a row fold to the first and the last two; the fold opens to all of them.
		const folded = plain(turn.summary.render(120));
		expect(folded.filter((line) => line.includes("◆"))).toHaveLength(3);
		expect(folded.some((line) => line.includes("⋯  中间还有 5 件事"))).toBe(true);
		turn.summary.activate(turn.summary.getFocusOrder().find((key) => key.startsWith("hid:")) ?? "");
		const wide = plain(turn.summary.render(120));
		const narrow = turn.summary.render(50);
		const shortLines = plain(narrow);
		const events = wide.filter((line) => line.includes("◆"));
		expect(events).toHaveLength(8);
		// The long notes are cut to one line each, not wrapped onto more lines.
		expect(shortLines).toHaveLength(wide.length);
		expect(shortLines.filter((line) => line.includes("◆"))).toHaveLength(8);
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(50);
		for (const line of shortLines.filter((entry) => entry.includes("◆"))) {
			expect(line).toMatch(/趁等待，先查第 \d 个风险…/);
			expect(line).toMatch(/2 步 ▸ {2}$/);
		}
		// The counts say the same at both widths: a narrow terminal marks nothing as new.
		expect(wide.at(-1)).toMatch(/第 16 步 {2}$/);
		expect(shortLines.at(-1)).toMatch(/第 16 步 {2}$/);
		expect(wide.join("\n")).not.toMatch(/有新内容|上面还有/);
		expect(shortLines.join("\n")).not.toMatch(/有新内容|上面还有/);
	});

	it("still says a step that really arrived is new: the counts move, and no scrolled-up marker exists", () => {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ viewportRows: () => 24 }) });
		for (let index = 0; index < 8; index++) {
			addCommand(turn, `c${index}`, `echo ${index}`, { output: "x" });
			later();
		}
		const before = plain(turn.summary.render(100));
		expect(before[0]).toMatch(/跑了 8 条命令 +8 步 ▸ {2}$/);
		expect(before.at(-1)).toMatch(/第 8 步 {2}$/);
		addCommand(turn, "late", "echo late", { output: "x" });
		const after = turn.summary.render(100);
		expect(plain(after)[0]).toMatch(/跑了 9 条命令 +9 步 ▸ {2}$/);
		expect(plain(after).at(-1)).toMatch(/第 9 步 {2}$/);
		expect(text(after)).not.toMatch(/有新内容|上面还有/);
	});
});
