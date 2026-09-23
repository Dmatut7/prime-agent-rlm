import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
import {
	Container,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type { IdleEvictionMinutes } from "../../../core/session-action-store.js";
import type { MermaidRenderingMode, ProcessModeSetting, WarningSettings } from "../../../core/settings-manager.js";
import { getSelectListTheme, getSettingsListTheme, theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

const SETTINGS_SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "不思考",
	minimal: "极简思考",
	low: "浅度思考",
	medium: "中等思考",
	high: "深度思考",
	xhigh: "很深的思考",
	max: "最深思考",
};

export interface SettingsConfig {
	autoCompact: boolean;
	idleEvictionMinutes: IdleEvictionMinutes;
	showImages: boolean;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	enableBuiltinSkills: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	currentTheme: string;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	processMode: ProcessModeSetting;
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	fullscreen: boolean;
	warnings: WarningSettings;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onIdleEvictionMinutesChange: (value: IdleEvictionMinutes) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onEnableBuiltinSkillsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onThinkingLevelChange: (level: ThinkingLevel) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onProcessModeChange: (mode: ProcessModeSetting) => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onFullscreenChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}

class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic 额外用量",
				description: "Anthropic 订阅可能产生付费额外用量时提醒",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class SelectSubmenu extends Container {
	private selectList: SelectList;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
	) {
		super();

		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		this.addChild(new Spacer(1));

		this.selectList = new SelectList(
			options,
			Math.min(options.length, 10),
			getSelectListTheme(),
			SETTINGS_SUBMENU_SELECT_LIST_LAYOUT,
		);

		const currentIndex = options.findIndex((o) => o.value === currentValue);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		this.selectList.onCancel = onCancel;

		if (onSelectionChange) {
			this.selectList.onSelectionChange = (item) => {
				onSelectionChange(item.value);
			};
		}

		this.addChild(this.selectList);

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · esc to go back"), 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		let currentWarnings = { ...config.warnings };
		const idleEvictionValues = [30, 60, 90, 180, 360];
		if (typeof config.idleEvictionMinutes === "number" && !idleEvictionValues.includes(config.idleEvictionMinutes)) {
			idleEvictionValues.push(config.idleEvictionMinutes);
			idleEvictionValues.sort((a, b) => a - b);
		}

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "自动压缩",
				description: "上下文太长时自动压缩",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "idle-eviction-minutes",
				label: "空闲回收",
				description: "代理完全空闲这么多分钟后停掉（全局后台策略）",
				currentValue: String(config.idleEvictionMinutes),
				values: ["off", ...idleEvictionValues.map(String)],
			},
			{
				id: "steering-mode",
				label: "插话方式",
				description: "运行中按 Enter 插话。one-at-a-time：一次送一条，等回应再送下一条；all：一次全部送达。",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "排队方式",
				description: "Alt+Enter 排队的消息在本轮结束后发送。one-at-a-time：一次一条；all：一次全部。",
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "transport",
				label: "传输方式",
				description: "支持多种传输的模型服务优先用哪种",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "hide-thinking",
				label: "隐藏 Thinking",
				description: "不显示 AI 回答里的 Thinking 内容",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mermaid-rendering",
				label: "Mermaid 图",
				description: "把 Mermaid 代码块画成字符图",
				currentValue: config.mermaidRenderingMode,
				values: ["off", "final", "streaming"],
			},
			{
				id: "process-mode",
				label: "过程显示",
				description: "quiet：每轮收成一行过程；legacy：显示完整过程",
				currentValue: config.processMode,
				values: ["quiet", "legacy"],
			},
			{
				id: "quiet-startup",
				label: "安静启动",
				description: "启动时不打印详细信息",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "tree-filter-mode",
				label: "会话树过滤",
				description: "打开 /tree 时默认的过滤方式",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			{
				id: "warnings",
				label: "提醒",
				description: "开关各类提醒",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
			{
				id: "thinking",
				label: "Thinking 强度",
				description: "支持 Thinking 的模型要想多深",
				currentValue: config.thinkingLevel,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"Thinking 强度",
						"选择模型的思考深度",
						config.availableThinkingLevels.map((level) => ({
							value: level,
							label: level,
							description: THINKING_DESCRIPTIONS[level],
						})),
						currentValue,
						(value) => {
							callbacks.onThinkingLevelChange(value as ThinkingLevel);
							done(value);
						},
						() => done(),
					),
			},
			{
				id: "theme",
				label: "主题",
				description: "界面配色",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new SelectSubmenu(
						"主题",
						"选择配色",
						config.availableThemes.map((t) => ({
							value: t,
							label: t,
						})),
						currentValue,
						(value) => {
							callbacks.onThemeChange(value);
							done(value);
						},
						() => {
							// Restore original theme on cancel
							callbacks.onThemePreview?.(currentValue);
							done();
						},
						(value) => {
							// Preview theme on selection change
							callbacks.onThemePreview?.(value);
						},
					),
			},
		];

		items.splice(1, 0, {
			id: "show-images",
			label: "显示图片信息",
			description: "在终端里显示图片类型和尺寸",
			currentValue: config.showImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(2, 0, {
			id: "auto-resize-images",
			label: "自动缩小图片",
			description: "把大图缩到 2000x2000 以内，模型更容易处理",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "禁止发送图片",
			description: "不把图片发给模型服务",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "技能命令",
			description: "把技能注册成 /skill:名称 命令",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// Built-in skills toggle (insert after skill-commands)
		const skillCommandsItemIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsItemIndex + 1, 0, {
			id: "builtin-skills",
			label: "内置技能",
			description: "加载 prime-agent 自带的技能（重新加载后生效）",
			currentValue: config.enableBuiltinSkills ? "true" : "false",
			values: ["true", "false"],
		});

		// Hardware cursor toggle (insert after builtin-skills)
		const skillCommandsIndex = items.findIndex((item) => item.id === "builtin-skills");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "显示终端光标",
			description: "显示终端自带光标（便于输入法定位）",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "输入框边距",
			description: "输入框左右留白（0-3）",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Autocomplete max visible toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "补全列表长度",
			description: "自动补全最多显示几项（3-20）",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "收缩时清屏",
			description: "内容变短时清掉空行（可能闪烁）",
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: "终端进度条",
			description: "在终端标签栏显示 OSC 9;4 进度",
			currentValue: config.showTerminalProgress ? "true" : "false",
			values: ["true", "false"],
		});

		// Fullscreen toggle (insert after terminal-progress)
		const terminalProgressIndex = items.findIndex((item) => item.id === "terminal-progress");
		items.splice(terminalProgressIndex + 1, 0, {
			id: "fullscreen",
			label: "全屏模式",
			description: "全屏界面，可滚动查看全部对话，输入框固定在底部",
			currentValue: config.fullscreen ? "true" : "false",
			values: ["true", "false"],
		});

		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "idle-eviction-minutes":
						callbacks.onIdleEvictionMinutesChange(newValue === "off" ? "off" : Number(newValue));
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "builtin-skills":
						callbacks.onEnableBuiltinSkillsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "mermaid-rendering":
						callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
						break;
					case "process-mode":
						callbacks.onProcessModeChange(newValue as ProcessModeSetting);
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "true");
						break;
					case "fullscreen":
						callbacks.onFullscreenChange(newValue === "true");
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
