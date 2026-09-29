import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/** The words that describe the box and the status line say what the code does now. */

const config: SettingsConfig = {
	autoCompact: true,
	idleEvictionMinutes: 90,
	showImages: true,
	autoResizeImages: true,
	blockImages: false,
	enableSkillCommands: true,
	enableBuiltinSkills: true,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	transport: "sse",
	thinkingLevel: "off",
	availableThinkingLevels: ["off"],
	currentTheme: "dark",
	availableThemes: ["dark"],
	hideThinkingBlock: false,
	mermaidRenderingMode: "streaming",
	processMode: "quiet",
	timelineOpenWhileWorking: true,
	timelineAutoFold: true,
	reduceMotion: false,
	treeFilterMode: "user-only",
	showHardwareCursor: false,
	editorPaddingX: 0,
	autocompleteMaxVisible: 5,
	quietStartup: false,
	clearOnShrink: false,
	showTerminalProgress: false,
	fullscreen: true,
	warnings: {},
};

const noop = () => {};
const callbacks: SettingsCallbacks = {
	onAutoCompactChange: noop,
	onIdleEvictionMinutesChange: noop,
	onShowImagesChange: noop,
	onAutoResizeImagesChange: noop,
	onBlockImagesChange: noop,
	onEnableSkillCommandsChange: noop,
	onEnableBuiltinSkillsChange: noop,
	onSteeringModeChange: noop,
	onFollowUpModeChange: noop,
	onTransportChange: noop,
	onThinkingLevelChange: noop,
	onThemeChange: noop,
	onHideThinkingBlockChange: noop,
	onMermaidRenderingModeChange: noop,
	onProcessModeChange: noop,
	onTimelineOpenWhileWorkingChange: noop,
	onTimelineAutoFoldChange: noop,
	onReduceMotionChange: noop,
	onTreeFilterModeChange: noop,
	onShowHardwareCursorChange: noop,
	onEditorPaddingXChange: noop,
	onAutocompleteMaxVisibleChange: noop,
	onQuietStartupChange: noop,
	onClearOnShrinkChange: noop,
	onShowTerminalProgressChange: noop,
	onFullscreenChange: noop,
	onWarningsChange: noop,
	onCancel: noop,
};

function read(relative: string): string {
	return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function settingsRow(key: string): string {
	const row = read("../docs/settings.md")
		.split("\n")
		.find((line) => line.startsWith(`| \`${key}\``));
	if (!row) throw new Error(`no row for ${key}`);
	return row;
}

describe("the auto-fold setting", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("says in the settings screen that a box opened while the turn ran folds too", () => {
		const component = new SettingsSelectorComponent(config, callbacks);
		for (const character of "干完自动") component.getSettingsList().handleInput(character);
		const shown = stripAnsi(component.render(200).join("\n"));
		expect(shown).toContain("干完自动收起");
		expect(shown).toContain("跑的时候你点开的也会收");
		expect(shown).not.toContain("你自己点开或收起过的框不动");
	});

	it("says in the docs the same: closed by hand stays closed, opened after the end stays open, opened during the run folds", () => {
		const row = settingsRow("ui.timelineAutoFold");
		expect(row).not.toContain("keeps your choice");
		expect(row).toContain("opened while the turn ran");
		expect(row).toContain("closed stays closed");
		expect(row).toContain("after the turn ended stays open");
		expect(row).toContain("`false` never folds a box on its own");
	});
});

describe("the subagent spend setting", () => {
	it("puts the spend on the status line, where the code draws it", () => {
		const row = settingsRow("ui.subagentSpendCell");
		expect(row).not.toContain("tray");
		expect(row).toContain("status line");
		expect(row).toContain("subagent blocks");
	});
});

describe("the changelog fragments", () => {
	const fragments = ["../.changes/grow-box.md", "../.changes/grow-bottom.md", "../../tui/.changes/grow-sticky.md"];

	it("are one past-tense bullet per line", () => {
		expect(fragments.length).toBeGreaterThan(0);
		for (const fragment of fragments) {
			const lines = read(fragment)
				.split("\n")
				.filter((line) => line.trim().length > 0);
			expect(lines.length, fragment).toBeGreaterThan(0);
			for (const line of lines) expect(line, fragment).toMatch(/^- (Added|Changed|Fixed|Removed) /);
		}
	});

	it("say the spend is trimmed after the location, not before anything else", () => {
		const bottom = read("../.changes/grow-bottom.md");
		expect(bottom).not.toContain("before anything else");
		expect(bottom).toContain("after the location");
	});

	it("say a mid-run opening folds unless auto-fold is off", () => {
		const box = read("../.changes/grow-box.md");
		expect(box).toContain("unless `ui.timelineAutoFold` is off");
	});

	it("describe the pinned header as it works: while its top is out of sight, with the click and the page keys", () => {
		const sticky = read("../../tui/.changes/grow-sticky.md");
		expect(sticky).not.toContain("taller than the screen");
		expect(sticky).toContain("scrolled out of sight");
		expect(sticky).toContain("page keys");
	});
});
