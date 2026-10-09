import { resetCapabilitiesCache, setCapabilities, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	formatSettingValue,
	projectPinnedSettingItems,
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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

const callbacks: SettingsCallbacks = {
	onAutoCompactChange: () => {},
	onIdleEvictionMinutesChange: () => {},
	onShowImagesChange: () => {},
	onAutoResizeImagesChange: () => {},
	onBlockImagesChange: () => {},
	onEnableSkillCommandsChange: () => {},
	onEnableBuiltinSkillsChange: () => {},
	onSteeringModeChange: () => {},
	onFollowUpModeChange: () => {},
	onTransportChange: () => {},
	onThinkingLevelChange: () => {},
	onThemeChange: () => {},
	onHideThinkingBlockChange: () => {},
	onMermaidRenderingModeChange: () => {},
	onProcessModeChange: () => {},
	onTimelineOpenWhileWorkingChange: () => {},
	onTimelineAutoFoldChange: () => {},
	onReduceMotionChange: () => {},
	onTreeFilterModeChange: () => {},
	onShowHardwareCursorChange: () => {},
	onEditorPaddingXChange: () => {},
	onAutocompleteMaxVisibleChange: () => {},
	onQuietStartupChange: () => {},
	onClearOnShrinkChange: () => {},
	onShowTerminalProgressChange: () => {},
	onFullscreenChange: () => {},
	onWarningsChange: () => {},
	onCancel: () => {},
};

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("shows the image metadata toggle without a terminal graphics protocol", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		try {
			const component = new SettingsSelectorComponent(config, callbacks);
			const rendered = stripAnsi(component.render(120).join("\n"));

			expect(rendered).toContain("显示图片信息");
			expect(rendered).toContain("自动缩小图片");
			for (const character of "idle") component.getSettingsList().handleInput(character);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("空闲回收");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("marks a project-pinned row so a swallowed toggle is visible (R4-M20)", () => {
		expect(projectPinnedSettingItems({ theme: "dark" }).has("theme")).toBe(true);
		expect(
			projectPinnedSettingItems({
				ui: { processMode: "legacy" },
				terminal: { showImages: false },
			}).has("process-mode"),
		).toBe(true);
		expect(
			projectPinnedSettingItems({
				ui: { processMode: "legacy" },
				terminal: { showImages: false },
			}).has("show-images"),
		).toBe(true);
		expect(projectPinnedSettingItems({ theme: "dark" }).has("show-images")).toBe(false);
		expect(projectPinnedSettingItems({}).size).toBe(0);

		const component = new SettingsSelectorComponent({ ...config, projectPinnedItems: new Set(["theme"]) }, callbacks);
		const list = component.getSettingsList();
		for (const character of "theme") list.handleInput(character);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("主题");
		expect(rendered).toContain("项目 settings.json 固定了此项");
	});

	test("marks the auto-compact row when the project pins the key the toggle writes (W8 2.2)", () => {
		// The /settings toggle writes compaction.perModel for the serving model
		// (the bare compaction.enabled when none is) into the GLOBAL file, while
		// the panel and the compaction gate read the deep-merged value: a project
		// entry for the same key swallows the switch in silence, so the row must
		// carry the same pinned hint as every other project-pinned item.
		const project = { compaction: { perModel: { "anthropic/claude-x": false } } };
		expect(projectPinnedSettingItems(project, "anthropic/claude-x").has("autocompact")).toBe(true);
		// A different model's entry does not pin this model's switch.
		expect(projectPinnedSettingItems(project, "openai/gpt-y").has("autocompact")).toBe(false);
		// Without the serving model the toggle writes the bare enabled key.
		expect(projectPinnedSettingItems({ compaction: { enabled: false } }).has("autocompact")).toBe(true);
		expect(projectPinnedSettingItems({}).has("autocompact")).toBe(false);

		const component = new SettingsSelectorComponent(
			{ ...config, projectPinnedItems: new Set(["autocompact"]) },
			callbacks,
		);
		const list = component.getSettingsList();
		for (const character of "auto") list.handleInput(character);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("自动压缩");
		expect(rendered).toContain("项目 settings.json 固定了此项");
	});

	test("shows values in Chinese while the stored values stay unchanged", () => {
		const onProcessModeChange = vi.fn();
		const component = new SettingsSelectorComponent(config, { ...callbacks, onProcessModeChange });
		const list = component.getSettingsList();
		for (const character of "process") list.handleInput(character);
		const before = stripAnsi(component.render(120).join("\n"));
		expect(before).toContain("安静");
		expect(before).not.toMatch(/\bquiet\b/);
		list.handleInput("\r");
		expect(onProcessModeChange).toHaveBeenCalledWith("legacy");
		expect(stripAnsi(component.render(120).join("\n"))).toContain("经典");
		expect(formatSettingValue("true")).toBe("开");
		expect(formatSettingValue("false")).toBe("关");
		expect(formatSettingValue("some-theme")).toBe("some-theme");
	});

	test("renders the process-mode row and cycles quiet to legacy", () => {
		const onProcessModeChange = vi.fn();
		const component = new SettingsSelectorComponent(config, { ...callbacks, onProcessModeChange });
		const list = component.getSettingsList();
		for (const character of "process") list.handleInput(character);

		expect(stripAnsi(component.render(120).join("\n"))).toContain("过程显示");

		list.handleInput("\r");

		expect(onProcessModeChange).toHaveBeenCalledWith("legacy");
	});

	test("cycles a custom idle eviction value to the next numeric option", () => {
		const onIdleEvictionMinutesChange = vi.fn();
		const component = new SettingsSelectorComponent(
			{ ...config, idleEvictionMinutes: 120 },
			{ ...callbacks, onIdleEvictionMinutesChange },
		);
		const list = component.getSettingsList();
		for (const character of "idle") list.handleInput(character);

		list.handleInput("\r");

		expect(onIdleEvictionMinutesChange).toHaveBeenCalledWith(180);
	});

	test.each([0.5, 1.5])("round-trips a fractional idle eviction value of %s", (value) => {
		const onIdleEvictionMinutesChange = vi.fn();
		const component = new SettingsSelectorComponent(
			{ ...config, idleEvictionMinutes: value },
			{ ...callbacks, onIdleEvictionMinutesChange },
		);
		const list = component.getSettingsList();
		for (const character of "idle") list.handleInput(character);

		// Cycle through every option and back onto the custom fractional value.
		for (let index = 0; index < 7; index++) list.handleInput("\r");

		expect(onIdleEvictionMinutesChange).toHaveBeenLastCalledWith(value);
		expect(stripAnsi(component.render(120).join("\n"))).toContain(String(value));
	});

	test("shrinks the visible item count on a short terminal", () => {
		// 10 was hardcoded: on a short terminal the panel overflowed and the dock
		// clipped the search field off the top.
		const tall = new SettingsSelectorComponent(config, callbacks);
		const short = new SettingsSelectorComponent({ ...config, getRows: () => 16 }, callbacks);

		const tallRows = tall.render(120).length;
		const shortRows = short.render(120).length;

		expect(shortRows).toBeLessThan(tallRows);
	});

	test("left arrow closes a submenu", () => {
		setKeybindings(new KeybindingsManager());
		const component = new SettingsSelectorComponent(config, callbacks);
		const list = component.getSettingsList();
		for (const character of "主题") list.handleInput(character);
		list.handleInput("\r"); // open the theme submenu
		expect(stripAnsi(component.render(120).join("\n"))).toContain("选择配色");

		list.handleInput("\x1b[D");

		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("选择配色");
	});

	test("left arrow closes the main settings panel (W13 13)", () => {
		// Left used to fall through to the search field, whose filter pass reset
		// the selection to the first item: the user who pressed left to go back
		// saw the panel stay open with the cursor teleported to the top row.
		setKeybindings(new KeybindingsManager());
		const onCancel = vi.fn();
		const component = new SettingsSelectorComponent(config, { ...callbacks, onCancel });
		const list = component.getSettingsList();

		for (let index = 0; index < 3; index++) list.handleInput("\x1b[B");

		list.handleInput("\x1b[D");

		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
