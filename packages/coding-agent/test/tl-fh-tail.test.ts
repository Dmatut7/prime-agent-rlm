import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { addStep, plain, quietTurn, T0 } from "./ui-blocks-helpers.js";

/**
 * The tail of a turn that still runs: `在跑  <command>` and its clock give way the way a step
 * line does on a narrow screen. The clock goes first; the words keep their minimum before it stays.
 */

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

const COMMAND = "npx vitest --run test/grow-bottom-tui.test.ts";
const CLOCK = /\d+秒 *$/;

function runningTurn(command = COMMAND) {
	const turn = quietTurn({ startedAt: T0 - 60_000 });
	addStep(turn, "c1", `await bash(${JSON.stringify(command)})`, "running", T0 - 30_000);
	turn.timeline.mergeStep(
		"c1",
		"ipython",
		{},
		{
			details: {
				activities: [
					{ id: "a", kind: "command", label: command, status: "running", detail: "", startedAt: T0 - 30_000 },
				],
			},
		},
		true,
	);
	return turn;
}

/** The tail's `╎` line at `width`, and every line of the box at that width. */
function tipAt(width: number, command = COMMAND): { tip: string; shown: string[] } {
	const shown = plain(runningTurn(command).summary.render(width));
	const tip = shown.find((line) => line.includes("╎")) ?? "";
	return { tip, shown };
}

describe("the `在跑` line of a running turn on a narrow screen", () => {
	it("shows the command and its clock at full width", () => {
		const { tip } = tipAt(100);
		expect(tip).toMatch(/^ {9}╎ {11}在跑 {2}npx vitest --run test\/grow-bottom-tui\.test\.ts +30秒 {4}$/);
	});

	it("drops the clock before it cuts the words below the room a step line keeps", () => {
		const widths = [100, 80, 70, 60, 55, 50, 48, 46, 44, 42, 40, 38, 36, 34, 32, 30, 28];
		expect(widths.length).toBeGreaterThan(0);
		let dropped = 0;
		for (const width of widths) {
			const { tip } = tipAt(width);
			expect(tip, `width ${width}`).not.toBe("");
			expect(visibleWidth(tip), `width ${width}`).toBeLessThanOrEqual(width);
			const words = tip.replace(CLOCK, "").trimEnd();
			if (CLOCK.test(tip)) {
				// The clock stays only while the words keep their minimum: 5 + `在跑  ` + 12 columns.
				expect(visibleWidth(words), `width ${width}`).toBeGreaterThanOrEqual(16 + 5 + 6 + 12);
			} else {
				dropped += 1;
			}
		}
		expect(dropped).toBeGreaterThan(0);
	});

	it("at 40 columns keeps as many words as the row has room for and no clock", () => {
		const { tip } = tipAt(40);
		expect(tip).not.toMatch(/\d+秒/);
		expect(tip).toMatch(/^ {9}╎ {11}在跑 {2}npx vitest -…$/);
		expect(visibleWidth(tip)).toBe(40);
	});

	it("at 30 columns still says what runs, not a bare ellipsis and a clock", () => {
		const { tip } = tipAt(30);
		expect(tip).not.toMatch(/\d+秒/);
		expect(tip).toMatch(/^ {9}╎ {11}在跑 {2}np…$/);
		expect(visibleWidth(tip)).toBe(30);
	});

	it("keeps the clock of a short command while its words fit whole", () => {
		const { tip } = tipAt(60, "sleep 5");
		expect(tip).toMatch(/^ {9}╎ {11}在跑 {2}sleep 5 +30秒 {4}$/);
	});
});
