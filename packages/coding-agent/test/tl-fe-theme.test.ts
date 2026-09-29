import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadThemeFromPath, type ThemeBg, type ThemeColor } from "../src/modes/interactive/theme/theme.js";

/**
 * `timelineFaint` carries the arrows (`▸`), `N 步`, `全部 ›`, `完整过程 ▸`, the closing line and the
 * step times. On the light theme it has to stay readable on white and on the hovered line, while
 * staying lighter than the time stamp.
 */

const themeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modes", "interactive", "theme");
const light = loadThemeFromPath(join(themeDir, "light.json"), "truecolor");

type Rgb = [number, number, number];

function rgbOf(token: ThemeColor | ThemeBg, layer: "fg" | "bg"): Rgb {
	const sequence = layer === "fg" ? light.getFgAnsi(token as ThemeColor) : light.getBgAnsi(token as ThemeBg);
	const match = /[34]8;2;(\d+);(\d+);(\d+)m/.exec(sequence);
	if (!match) throw new Error(`${token}: expected a truecolor sequence`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]: Rgb): number {
	const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((channel) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function contrast(foreground: Rgb, background: Rgb): number {
	const [light_, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return ((light_ ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

const WHITE: Rgb = [255, 255, 255];

describe("the light theme's faint timeline text", () => {
	it("reads 3.5 to 1 on white", () => {
		expect(contrast(rgbOf("timelineFaint", "fg"), WHITE)).toBeGreaterThanOrEqual(3.5);
	});

	it("reads 3 to 1 on the hovered line", () => {
		expect(contrast(rgbOf("timelineFaint", "fg"), rgbOf("timelineHoverBg", "bg"))).toBeGreaterThanOrEqual(3);
	});

	it("stays lighter than the time stamp and darker than the rail", () => {
		const faint = contrast(rgbOf("timelineFaint", "fg"), WHITE);
		expect(faint).toBeLessThan(contrast(rgbOf("timelineTime", "fg"), WHITE));
		expect(faint).toBeGreaterThan(contrast(rgbOf("timelineRail", "fg"), WHITE));
	});
});
