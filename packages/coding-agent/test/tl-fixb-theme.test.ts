import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadThemeFromPath, type ThemeColor } from "../src/modes/interactive/theme/theme.js";

/**
 * The light theme draws on white. The timeline's colors that carry words (the AI's line, the
 * live state, the subagent and fix marks) must stay readable there: WCAG contrast of 4.5 or more.
 */

const themeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modes", "interactive", "theme");
const light = loadThemeFromPath(join(themeDir, "light.json"), "truecolor");

function rgbOf(token: ThemeColor): [number, number, number] {
	const match = /38;2;(\d+);(\d+);(\d+)m/.exec(light.getFgAnsi(token));
	if (!match) throw new Error(`${token}: expected a truecolor foreground`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]: [number, number, number]): number {
	const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((channel) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrastOnWhite(token: ThemeColor): number {
	return 1.05 / (luminance(rgbOf(token)) + 0.05);
}

const TEXT_COLORS = [
	"timelineAi",
	"timelineLive",
	"timelineSub",
	"timelineFix",
	"timelineLane",
	"timelineOk",
] as const satisfies readonly ThemeColor[];

describe("the light theme's timeline colors on white", () => {
	it("reads 4.5 to 1 or better for the colors that carry words", () => {
		expect(TEXT_COLORS.length).toBeGreaterThan(0);
		for (const token of TEXT_COLORS) {
			expect(contrastOnWhite(token), token).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("draws a fix mark in the same orange as a subagent mark, as it is meant to", () => {
		expect(rgbOf("timelineFix")).toEqual(rgbOf("timelineSub"));
	});

	it("keeps the lane's amber apart from the subagent's orange", () => {
		const [lr, lg, lb] = rgbOf("timelineLane");
		const [sr, sg, sb] = rgbOf("timelineSub");
		expect(Math.hypot(lr - sr, lg - sg, lb - sb)).toBeGreaterThanOrEqual(50);
	});

	it("keeps the weakest layers weak: the rail and the faint text stay lighter than the time stamp", () => {
		expect(contrastOnWhite("timelineRail")).toBeLessThan(contrastOnWhite("timelineFaint"));
		expect(contrastOnWhite("timelineFaint")).toBeLessThan(contrastOnWhite("timelineTime"));
	});
});
