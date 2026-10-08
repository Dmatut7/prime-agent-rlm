import { Container } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConnectionState } from "../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The settings panel's reload wiring (R5-M29, R4-M11): toggling "内置技能" needs a
 * reload, and the reload swaps the editor container the panel lives in. The panel
 * component is a capture vessel here - the wiring under test is the callback
 * bodies showSettingsSelector hands it.
 */

type CapturedCallbacks = {
	onEnableBuiltinSkillsChange(enabled: boolean): void;
	onHideThinkingBlockChange(hidden: boolean): void;
	onProcessModeChange(mode: string): void;
	onCancel(): void;
};

const captured = vi.hoisted(() => ({
	instances: [] as Array<{ config: Record<string, unknown>; callbacks: CapturedCallbacks }>,
}));

vi.mock("../src/modes/interactive/components/settings-selector.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/modes/interactive/components/settings-selector.js")>();
	class MockSettingsSelectorComponent {
		constructor(
			public config: Record<string, unknown>,
			public callbacks: CapturedCallbacks,
		) {
			captured.instances.push({ config, callbacks });
		}
		getSettingsList() {
			return { render: () => [], invalidate: () => {} };
		}
		render(): string[] {
			return [];
		}
		invalidate(): void {}
	}
	return { ...original, SettingsSelectorComponent: MockSettingsSelectorComponent };
});

type Proto = {
	showSettingsSelector(this: Record<string, unknown>): Promise<void>;
};

const proto = InteractiveMode.prototype as unknown as Proto;

function createState(overrides: Partial<AgentConnectionState> = {}): AgentConnectionState {
	return {
		activeSessionId: "active-1",
		cwd: "/tmp/project",
		thinkingLevel: "medium",
		serviceTier: "default",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "all",
		sessionId: "session-1",
		leafId: null,
		autoCompactionEnabled: true,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		scopedModels: [],
		activeToolNames: [],
		contextUsage: undefined,
		...overrides,
	} as AgentConnectionState;
}

function createSettingsManager() {
	return {
		getIdleEvictionMinutes: () => 60,
		getShowImages: () => true,
		getImageAutoResize: () => true,
		getBlockImages: () => false,
		getEnableSkillCommands: () => true,
		getEnableBuiltinSkills: () => true,
		getTransport: () => "auto",
		getTheme: () => "dark",
		getMermaidRenderingMode: () => "off",
		getProcessMode: () => "quiet",
		getTimelineOpenWhileWorking: () => true,
		getTimelineAutoFold: () => true,
		getReduceMotion: () => false,
		getTreeFilterMode: () => "default",
		getShowHardwareCursor: () => false,
		getEditorPaddingX: () => 2,
		getAutocompleteMaxVisible: () => 10,
		getQuietStartup: () => false,
		getClearOnShrink: () => false,
		getShowTerminalProgress: () => false,
		getWarnings: () => ({}),
		getProjectSettings: () => ({}),
		persistenceFailure: () => Promise.resolve(undefined),
		setEnableBuiltinSkills: vi.fn(),
		setHideThinkingBlock: vi.fn(),
		setProcessMode: vi.fn(),
	};
}

function createHarness(overrides: Record<string, unknown> = {}) {
	const editorContainer = new Container();
	const editor = { render: () => [] as string[], invalidate: () => {} };
	editorContainer.addChild(editor as never);
	const state = createState();
	const harness: Record<string, unknown> = {
		editorContainer,
		editor,
		chatContainer: new Container(),
		fullscreenEnabled: false,
		hideThinkingBlock: false,
		heartbeatManager: undefined,
		heartbeatManagerRefreshTimer: undefined,
		promptStashStore: undefined,
		recapContainer: undefined,
		currentTurnState: undefined,
		pulseTimer: undefined,
		connectionState: undefined,
		settingsManager: createSettingsManager(),
		agentConnection: { getState: vi.fn(async () => state) },
		ui: { requestRender: vi.fn(), setFocus: vi.fn(), terminal: { columns: 120, rows: 40 } },
		footer: { invalidate: vi.fn(), setAutoCompactEnabled: vi.fn() },
		requestChatRebuild: vi.fn(),
		handleReloadCommand: vi.fn(async () => true),
		showError: vi.fn(),
		...overrides,
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return { harness, editorContainer, editor, state };
}

describe("settings panel reload wiring", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		captured.instances.length = 0;
	});

	it("toggling built-in skills leaves the panel up; the reload runs when it closes (R5-M29)", async () => {
		const { harness, editorContainer, editor } = createHarness();

		await proto.showSettingsSelector.call(harness);
		expect(captured.instances).toHaveLength(1);
		const panel = captured.instances[0]!;
		expect(editorContainer.children[0]).not.toBe(editor);

		panel.callbacks.onEnableBuiltinSkillsChange(false);

		// The panel must survive its own toggle: no reload while it is open.
		expect(harness.handleReloadCommand).not.toHaveBeenCalled();
		expect(editorContainer.children[0]).not.toBe(editor);

		panel.callbacks.onCancel();

		expect(harness.handleReloadCommand).toHaveBeenCalledTimes(1);
		// The panel closed first: the editor is back before the reload runs.
		expect(editorContainer.children[0]).toBe(editor);
	});

	it("closing the panel without the skills toggle runs no reload (R5-M29)", async () => {
		const { harness } = createHarness();

		await proto.showSettingsSelector.call(harness);
		captured.instances[0]!.callbacks.onCancel();

		expect(harness.handleReloadCommand).not.toHaveBeenCalled();
	});

	it("the face-changing settings route their rebuild through the deferring request (R4-M11)", async () => {
		const { harness } = createHarness();

		await proto.showSettingsSelector.call(harness);
		const panel = captured.instances[0]!;

		panel.callbacks.onHideThinkingBlockChange(true);
		expect(harness.requestChatRebuild).toHaveBeenCalledTimes(1);

		panel.callbacks.onProcessModeChange("legacy");
		expect(harness.requestChatRebuild).toHaveBeenCalledTimes(2);
	});
});
