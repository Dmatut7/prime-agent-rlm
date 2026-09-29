import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadThemeFromPath, type Theme, type ThemeBg, type ThemeColor } from "../src/modes/interactive/theme/theme.js";

/**
 * A terminal without truecolor gets every theme color squeezed onto the 256-color palette, and
 * the dark themes' dim surfaces all land on the same gray (59). These tests read the escapes the
 * built-in themes really emit in 256-color mode and hold the colors that must stay apart.
 */

const themeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modes", "interactive", "theme");
const THEMES = ["dark", "prime", "light"] as const;
type ThemeName = (typeof THEMES)[number];

/** The terminal's own background is unknown; these are the palette entries a plain terminal shows. */
const DEFAULT_BACKGROUNDS: Record<ThemeName, number[]> = { dark: [0, 16], prime: [0, 16], light: [15, 231] };

const CUBE = [0, 95, 135, 175, 215, 255];

interface Rgb {
	r: number;
	g: number;
	b: number;
}

function codeToRgb(code: number): Rgb {
	if (code >= 232) {
		const value = 8 + (code - 232) * 10;
		return { r: value, g: value, b: value };
	}
	const cube = code - 16;
	return { r: CUBE[Math.floor(cube / 36)]!, g: CUBE[Math.floor((cube % 36) / 6)]!, b: CUBE[cube % 6]! };
}

const luminance = ({ r, g, b }: Rgb): number => 0.299 * r + 0.587 * g + 0.114 * b;

const themes256 = new Map<ThemeName, Theme>();
const themesTrue = new Map<ThemeName, Theme>();
for (const name of THEMES) {
	themes256.set(name, loadThemeFromPath(join(themeDir, `${name}.json`), "256color"));
	themesTrue.set(name, loadThemeFromPath(join(themeDir, `${name}.json`), "truecolor"));
}

function bgCode(name: ThemeName, token: ThemeBg): number {
	const sequence = themes256.get(name)!.getBgAnsi(token);
	const match = /48;5;(\d+)m/.exec(sequence);
	if (!match) throw new Error(`${name} ${token}: expected a 256-color background, got ${JSON.stringify(sequence)}`);
	return Number(match[1]);
}

function fgCode(name: ThemeName, token: ThemeColor): number {
	const sequence = themes256.get(name)!.getFgAnsi(token);
	const match = /38;5;(\d+)m/.exec(sequence);
	if (!match) throw new Error(`${name} ${token}: expected a 256-color foreground, got ${JSON.stringify(sequence)}`);
	return Number(match[1]);
}

function trueLuminance(name: ThemeName, token: ThemeBg | ThemeColor, layer: "bg" | "fg"): number {
	const theme = themesTrue.get(name)!;
	const sequence = layer === "bg" ? theme.getBgAnsi(token as ThemeBg) : theme.getFgAnsi(token as ThemeColor);
	const match = /[34]8;2;(\d+);(\d+);(\d+)m/.exec(sequence);
	if (!match) throw new Error(`${name} ${token}: expected a truecolor sequence, got ${JSON.stringify(sequence)}`);
	return luminance({ r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) });
}

function duplicates(entries: readonly (readonly [string, number])[]): string[] {
	const seen = new Map<number, string>();
	const out: string[] = [];
	for (const [label, code] of entries) {
		const earlier = seen.get(code);
		if (earlier !== undefined) out.push(`${earlier} and ${label} are both ${code}`);
		else seen.set(code, label);
	}
	return out;
}

const STRIP_BACKGROUNDS = [
	"kindSubagentBg",
	"kindSubagentHoverBg",
	"kindErrorBg",
	"kindErrorHoverBg",
] as const satisfies readonly ThemeBg[];

describe("the subagent and error blocks in a 256-color terminal", () => {
	for (const name of THEMES) {
		it(`${name}: four backgrounds are four different colors, none the panel or the terminal's own background`, () => {
			expect(STRIP_BACKGROUNDS.length).toBeGreaterThan(0);
			const entries = STRIP_BACKGROUNDS.map((token) => [token, bgCode(name, token)] as const);
			expect(duplicates(entries)).toEqual([]);
			const panel = bgCode(name, "kindPanelBg");
			for (const [token, code] of entries) {
				expect(code, `${name} ${token} against the panel`).not.toBe(panel);
				expect(DEFAULT_BACKGROUNDS[name], `${name} ${token} against the terminal background`).not.toContain(code);
			}
		});

		it(`${name}: hovering steps the same way and by a visible amount, as it does in truecolor`, () => {
			const pairs = [
				["kindSubagentBg", "kindSubagentHoverBg"],
				["kindErrorBg", "kindErrorHoverBg"],
			] as const;
			expect(pairs.length).toBeGreaterThan(0);
			for (const [normal, hover] of pairs) {
				const step256 = luminance(codeToRgb(bgCode(name, hover))) - luminance(codeToRgb(bgCode(name, normal)));
				const stepTrue = trueLuminance(name, hover, "bg") - trueLuminance(name, normal, "bg");
				expect(Math.sign(step256), `${name} ${hover} against ${normal}`).toBe(Math.sign(stepTrue));
				expect(Math.abs(step256), `${name} ${hover} against ${normal}`).toBeGreaterThanOrEqual(8);
			}
		});

		it(`${name}: an error block is red and a subagent block is not`, () => {
			const isRed = ({ r, g, b }: Rgb): boolean => r > g && r > b;
			for (const token of ["kindErrorBg", "kindErrorHoverBg"] as const) {
				expect(isRed(codeToRgb(bgCode(name, token))), `${name} ${token}`).toBe(true);
			}
			for (const token of ["kindSubagentBg", "kindSubagentHoverBg"] as const) {
				expect(isRed(codeToRgb(bgCode(name, token))), `${name} ${token}`).toBe(false);
			}
		});
	}
});

describe("the timeline colors in a 256-color terminal", () => {
	const GRAYS = [
		"timelineRail",
		"timelineFaint",
		"timelineTime",
		"timelineSoft",
	] as const satisfies readonly ThemeColor[];
	// Fix is drawn in the same orange as Sub on purpose.
	const DISTINCT = [
		...GRAYS,
		"timelineUser",
		"timelineAi",
		"timelineLane",
		"timelineSub",
		"timelineMemory",
		"timelineLive",
		"timelineMust",
		"timelineOk",
	] as const satisfies readonly ThemeColor[];

	for (const name of THEMES) {
		it(`${name}: no two timeline colors share a palette entry`, () => {
			expect(DISTINCT.length).toBeGreaterThan(0);
			expect(duplicates(DISTINCT.map((token) => [token, fgCode(name, token)] as const))).toEqual([]);
		});

		it(`${name}: the four grays keep their order of strength`, () => {
			const pairs: [ThemeColor, ThemeColor][] = [];
			for (const [index, first] of GRAYS.entries())
				for (const second of GRAYS.slice(index + 1)) pairs.push([first, second]);
			expect(pairs.length).toBe(6);
			for (const [first, second] of pairs) {
				const in256 = luminance(codeToRgb(fgCode(name, first))) - luminance(codeToRgb(fgCode(name, second)));
				const inTrue = trueLuminance(name, first, "fg") - trueLuminance(name, second, "fg");
				expect(Math.sign(in256), `${name} ${first} against ${second}`).toBe(Math.sign(inTrue));
			}
		});

		it(`${name}: nothing on the timeline is drawn in the hover row's own color`, () => {
			const hover = bgCode(name, "timelineHoverBg");
			expect(DISTINCT.length).toBeGreaterThan(0);
			for (const token of DISTINCT) expect(fgCode(name, token), `${name} ${token} on the hover row`).not.toBe(hover);
		});
	}
});
