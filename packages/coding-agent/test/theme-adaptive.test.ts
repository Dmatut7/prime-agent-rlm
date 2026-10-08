import { clearDefaultTerminalColors, setDefaultTerminalColors } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEditorTheme, initTheme, setThemeInstance, Theme, theme } from "../src/modes/interactive/theme/theme.js";

function ansi256IndexToRgb(index: number): { r: number; g: number; b: number } {
	if (index >= 232) {
		const v = 8 + (index - 232) * 10;
		return { r: v, g: v, b: v };
	}
	const cube = [0, 95, 135, 175, 215, 255];
	const n = index - 16;
	return { r: cube[Math.floor(n / 36)]!, g: cube[Math.floor((n % 36) / 6)]!, b: cube[n % 6]! };
}

function luminanceRgb(color: { r: number; g: number; b: number }): number {
	return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

function extractRgbLuminance(rendered: string): number {
	const match = /48;2;(\d+);(\d+);(\d+)m/.exec(rendered);
	if (!match) throw new Error(`Expected truecolor background escape, got: ${JSON.stringify(rendered)}`);
	return 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3]);
}

describe("adaptive TUI theme colors", () => {
	let previousColorTerm: string | undefined;
	let previousColorFgBg: string | undefined;

	beforeEach(() => {
		previousColorTerm = process.env.COLORTERM;
		previousColorFgBg = process.env.COLORFGBG;
		process.env.COLORTERM = "truecolor";
		delete process.env.COLORFGBG;
		clearDefaultTerminalColors();
		initTheme("prime");
	});

	afterEach(() => {
		clearDefaultTerminalColors();
		if (previousColorTerm === undefined) {
			delete process.env.COLORTERM;
		} else {
			process.env.COLORTERM = previousColorTerm;
		}
		if (previousColorFgBg === undefined) {
			delete process.env.COLORFGBG;
		} else {
			process.env.COLORFGBG = previousColorFgBg;
		}
	});

	it("frames the prompt with rules instead of a filled surface", () => {
		expect(getEditorTheme().backgroundColor).toBeUndefined();
	});

	it("uses theme colors for editor chrome when the terminal background is unknown", () => {
		const editorTheme = getEditorTheme();

		expect(theme.getEditorBackgroundColor()?.("x")).toBe(theme.bg("userMessageBg", "x"));
		expect(editorTheme.borderColor("x")).toBe(theme.fg("timelineRail", "x"));
	});

	it("keeps theme editor chrome on dark terminal backgrounds", () => {
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 0, g: 0, b: 0 },
		});

		const editorTheme = getEditorTheme();

		expect(theme.getEditorBackgroundColor()?.("x")).toBe(theme.bg("userMessageBg", "x"));
		expect(editorTheme.borderColor("x")).toBe(theme.fg("timelineRail", "x"));
	});

	it("nudges the editor surface when it matches the terminal background", () => {
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 26, g: 26, b: 31 },
		});

		const editorTheme = getEditorTheme();

		expect(theme.getEditorBackgroundColor()?.("x")).not.toBe(theme.bg("userMessageBg", "x"));
		expect(theme.getEditorBackgroundColor()?.("x")).toMatch(/\x1b\[48;2;\d+;\d+;\d+mx\x1b\[49m/);
		expect(editorTheme.borderColor("x")).toBe(theme.fg("timelineRail", "x"));
	});

	it("keeps theme editor chrome on light terminal backgrounds", () => {
		setDefaultTerminalColors({
			foreground: { r: 0, g: 0, b: 0 },
			background: { r: 255, g: 255, b: 255 },
		});

		const editorTheme = getEditorTheme();

		expect(theme.getEditorBackgroundColor()?.("x")).toBe(theme.bg("userMessageBg", "x"));
		expect(editorTheme.borderColor("x")).toBe(theme.fg("timelineRail", "x"));
	});

	it("keeps the theme selection background when the terminal background is unknown", () => {
		expect(theme.getSelectionBackgroundColor()("x")).toBe(theme.bg("selectedBg", "x"));
	});

	it("keeps the theme selection background on clearly different terminal backgrounds", () => {
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 0, g: 0, b: 0 },
		});

		expect(theme.getSelectionBackgroundColor()("x")).toBe(theme.bg("selectedBg", "x"));
	});

	it("strengthens the selection background when it nearly matches the terminal background", () => {
		setDefaultTerminalColors({
			foreground: { r: 235, g: 219, b: 178 },
			background: { r: 29, g: 32, b: 33 },
		});

		const selection = theme.getSelectionBackgroundColor()("x");
		expect(selection).not.toBe(theme.bg("selectedBg", "x"));
		expect(selection).toMatch(/\x1b\[48;2;\d+;\d+;\d+mx\x1b\[49m/);
	});

	it("darkens a selection background that is darker than a dark terminal background", () => {
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 60, g: 60, b: 60 },
		});

		const rendered = theme.getSelectionBackgroundColor()("x");
		expect(rendered).not.toBe(theme.bg("selectedBg", "x"));
		// Selection luminance 34.5 against a terminal luminance of 60 has delta 25.5;
		// blending darker reaches the minimum without crossing the background.
		expect(Math.abs(extractRgbLuminance(rendered) - 60)).toBeGreaterThanOrEqual(27.5);
		expect(extractRgbLuminance(rendered)).toBeLessThan(34.5);
	});

	it("lightens a selection background that is brighter than a light terminal background", () => {
		initTheme("light");
		setDefaultTerminalColors({
			foreground: { r: 0, g: 0, b: 0 },
			background: { r: 200, g: 200, b: 200 },
		});

		const rendered = theme.getSelectionBackgroundColor()("x");
		expect(rendered).not.toBe(theme.bg("selectedBg", "x"));
		// light theme selectedBg #d0d0e0 has luminance ~209.7, terminal has 200.
		expect(extractRgbLuminance(rendered)).toBeGreaterThan(209.7);
		expect(Math.abs(extractRgbLuminance(rendered) - 200)).toBeGreaterThanOrEqual(27.5);
	});

	it("crosses the background when the selection sits at the blend endpoint", () => {
		setThemeInstance(
			new Theme(
				{} as ConstructorParameters<typeof Theme>[0],
				{ selectedBg: "#000000" } as ConstructorParameters<typeof Theme>[1],
				"truecolor",
			),
		);
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 1, g: 1, b: 1 },
		});

		const rendered = theme.getSelectionBackgroundColor()("x");
		expect(rendered).not.toBe(theme.bg("selectedBg", "x"));
		// Blending toward black cannot change a black selection, so it must blend
		// upward across the background to reach the minimum contrast.
		expect(Math.abs(extractRgbLuminance(rendered) - 1)).toBeGreaterThanOrEqual(27.5);

		initTheme("prime");
	});

	it("falls back across the background when the same-side blend is capped", () => {
		// Prime selectedBg (#222226, luminance ~34.5) is slightly darker than this
		// terminal background; blending darker is capped at 0.5 and cannot reach 28,
		// so the highlight must cross upward instead.
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 35, g: 35, b: 35 },
		});

		const rendered = theme.getSelectionBackgroundColor()("x");
		expect(rendered).not.toBe(theme.bg("selectedBg", "x"));
		expect(Math.abs(extractRgbLuminance(rendered) - 35)).toBeGreaterThanOrEqual(27.5);
	});

	it("keeps contrast after 256-color quantization", () => {
		setThemeInstance(
			new Theme(
				{} as ConstructorParameters<typeof Theme>[0],
				{ selectedBg: "#e93e4d" } as ConstructorParameters<typeof Theme>[1],
				"256color",
			),
		);
		// #e93e4d (luminance 114.9) on #2ca649 (luminance 118.9): the pre-quantized
		// blend is fine, but naive quantization lands on #af5f5f, matching the
		// terminal background exactly.
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 44, g: 166, b: 73 },
		});

		const rendered = theme.getSelectionBackgroundColor()("x");
		const match = /48;5;(\d+)m/.exec(rendered);
		if (!match) throw new Error(`Expected 256-color background escape, got: ${JSON.stringify(rendered)}`);
		const quantized = ansi256IndexToRgb(Number(match[1]));
		expect(Math.abs(luminanceRgb(quantized) - 118.9)).toBeGreaterThanOrEqual(27.5);

		initTheme("prime");
	});

	it("searches stronger blends when 256-color quantization undershoots", () => {
		setThemeInstance(
			new Theme(
				{} as ConstructorParameters<typeof Theme>[0],
				{ selectedBg: "#2f4d50" } as ConstructorParameters<typeof Theme>[1],
				"256color",
			),
		);
		// #2f4d50 (luminance 68.4) on #751dce (luminance 75.5): both exact-target
		// blends quantize far below the threshold; a stronger blend toward white
		// quantizes to #87afaf and clears it.
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 117, g: 29, b: 206 },
		});

		const rendered = theme.getSelectionBackgroundColor()("x");
		const match = /48;5;(\d+)m/.exec(rendered);
		if (!match) throw new Error(`Expected 256-color background escape, got: ${JSON.stringify(rendered)}`);
		expect(Math.abs(luminanceRgb(ansi256IndexToRgb(Number(match[1]))) - 75.5)).toBeGreaterThanOrEqual(27.5);

		initTheme("prime");
	});

	it("adapts when 256-color quantization erases the configured contrast", () => {
		setThemeInstance(
			new Theme(
				{} as ConstructorParameters<typeof Theme>[0],
				{ selectedBg: "#e82d6a" } as ConstructorParameters<typeof Theme>[1],
				"256color",
			),
		);
		// #e82d6a (luminance ~108) on #d6005d (luminance ~74.6): raw delta 33 passes,
		// but the selection quantizes to #d7005f which nearly matches the terminal.
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 214, g: 0, b: 93 },
		});

		const rendered = theme.getSelectionBackgroundColor()("x");
		expect(rendered).not.toBe(theme.bg("selectedBg", "x"));
		const match = /48;5;(\d+)m/.exec(rendered);
		if (!match) throw new Error(`Expected 256-color background escape, got: ${JSON.stringify(rendered)}`);
		expect(Math.abs(luminanceRgb(ansi256IndexToRgb(Number(match[1]))) - 74.6)).toBeGreaterThanOrEqual(27.5);

		initTheme("prime");
	});

	it("leaves terminal-defined basic ANSI selection colors alone", () => {
		setThemeInstance(
			new Theme(
				{} as ConstructorParameters<typeof Theme>[0],
				{ selectedBg: 0 } as ConstructorParameters<typeof Theme>[1],
				"256color",
			),
		);
		setDefaultTerminalColors({
			foreground: { r: 235, g: 219, b: 178 },
			background: { r: 29, g: 32, b: 33 },
		});

		expect(theme.getSelectionBackgroundColor()("x")).toBe(theme.bg("selectedBg", "x"));

		initTheme("prime");
	});

	it("derives a contrasting selection when selectedBg uses the terminal default", () => {
		setThemeInstance(
			new Theme(
				{} as ConstructorParameters<typeof Theme>[0],
				{ selectedBg: "" } as ConstructorParameters<typeof Theme>[1],
				"256color",
			),
		);
		setDefaultTerminalColors({
			foreground: { r: 235, g: 219, b: 178 },
			background: { r: 29, g: 32, b: 33 },
		});

		const rendered = theme.getSelectionBackgroundColor()("x");
		expect(rendered).not.toBe(theme.bg("selectedBg", "x"));
		const match = /48;5;(\d+)m/.exec(rendered);
		if (!match) throw new Error(`Expected 256-color background escape, got: ${JSON.stringify(rendered)}`);
		// Terminal background luminance is 31.2; the derived highlight must clear it.
		expect(Math.abs(luminanceRgb(ansi256IndexToRgb(Number(match[1]))) - 31.2)).toBeGreaterThanOrEqual(27.5);

		initTheme("prime");
	});

	it("darkens a light selection background that nearly matches a light terminal background", () => {
		initTheme("light");
		setDefaultTerminalColors({
			foreground: { r: 0, g: 0, b: 0 },
			background: { r: 210, g: 210, b: 220 },
		});

		const selection = theme.getSelectionBackgroundColor()("x");
		expect(selection).not.toBe(theme.bg("selectedBg", "x"));
		expect(selection).toMatch(/\x1b\[48;2;\d+;\d+;\d+mx\x1b\[49m/);
	});

	it("uses COLORFGBG for automatic default theme selection when OSC colors are unavailable", () => {
		process.env.COLORFGBG = "0;15";
		clearDefaultTerminalColors();
		initTheme(undefined);

		expect(theme.name).toBe("light");

		process.env.COLORFGBG = "15;0";
		clearDefaultTerminalColors();
		initTheme(undefined);

		expect(theme.name).toBe("prime");
	});

	it("strengthens the surface blend when the small fixed blend undershoots the minimum delta", () => {
		setThemeInstance(
			new Theme(
				{} as ConstructorParameters<typeof Theme>[0],
				{ userMessageBg: "#1c1c22" } as ConstructorParameters<typeof Theme>[1],
				"truecolor",
			),
		);
		// Surface luminance 28.7 vs terminal 38: raw delta 9.3 < 12 triggers the
		// blend, but a single 0.08 blend lands at luminance ~46.8 — still only 8.8
		// away, leaving the panel indistinguishable from the terminal background.
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 38, g: 38, b: 38 },
		});

		const rendered = theme.getEditorBackgroundColor()?.("x");
		expect(rendered).not.toBe(theme.bg("userMessageBg", "x"));
		if (rendered === undefined) throw new Error("editor background color missing");
		expect(Math.abs(extractRgbLuminance(rendered) - 38)).toBeGreaterThanOrEqual(11);

		initTheme("prime");
	});
});

describe("emphasis styling", () => {
	let savedEnv: Record<"NO_COLOR" | "TERM" | "FORCE_COLOR", string | undefined>;

	beforeEach(() => {
		savedEnv = { NO_COLOR: process.env.NO_COLOR, TERM: process.env.TERM, FORCE_COLOR: process.env.FORCE_COLOR };
		delete process.env.NO_COLOR;
		delete process.env.FORCE_COLOR;
		process.env.TERM = "xterm-256color";
		initTheme("dark");
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		clearDefaultTerminalColors();
	});

	it("emits SGR emphasis even when chalk's TTY sniffing would disable it", () => {
		// theme.fg emits colors unconditionally; emphasis used to vanish under
		// piped stdout (chalk.level = 0) while the colors still flowed.
		const previousLevel = chalk.level;
		chalk.level = 0;
		try {
			expect(theme.bold("x")).toBe("\x1b[1mx\x1b[22m");
			expect(theme.italic("x")).toBe("\x1b[3mx\x1b[23m");
		} finally {
			chalk.level = previousLevel;
		}
	});

	it("drops emphasis under NO_COLOR", () => {
		process.env.NO_COLOR = "1";
		expect(theme.bold("x")).toBe("x");
		expect(theme.italic("x")).toBe("x");
		expect(theme.underline("x")).toBe("x");
		expect(theme.strikethrough("x")).toBe("x");
	});

	it("drops emphasis when TERM=dumb", () => {
		process.env.TERM = "dumb";
		expect(theme.bold("x")).toBe("x");
		expect(theme.inverse("x")).toBe("x");
	});

	it("FORCE_COLOR overrides TERM=dumb", () => {
		process.env.TERM = "dumb";
		process.env.FORCE_COLOR = "1";
		expect(theme.bold("x")).toBe("\x1b[1mx\x1b[22m");
	});
});
