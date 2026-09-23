import { Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	BrandSplashHeader,
	getRandomStartHint,
	InteractiveMode,
	START_HINTS,
} from "../src/modes/interactive/interactive-mode.js";
import type { PromptStashState } from "../src/modes/interactive/prompt-stash-state.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

describe("InteractiveMode startup hints", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	function createMode(messageCount = 0, returnToAgentsView = false, getEditorText = () => "") {
		const mode = {
			options: { returnToAgentsView },
			editor: { getText: getEditorText },
			uiServices: { settingsManager: { getFooterTelemetry: () => "on" } },
			heartbeatCatalog: [],
			subagentSnapshots: new Map(),
			connectionState: {
				model: { name: "test-model", reasoning: true },
				thinkingLevel: "high",
				messageCount,
				isStreaming: false,
			},
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		return mode;
	}

	it("renders a compact splash: wordmark, then one labelled row per fact", () => {
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
			undefined,
			{
				topPadding: true,
				getExtraMetadata: () => [{ label: "agents", value: "3 idle" }],
			},
		);

		const lines = header.render(120).map((line) => stripAnsi(line).trimEnd());

		expect(lines).toEqual([
			"",
			" prime-agent  v0.0.0",
			"",
			" 模型    test-model",
			" 目录    /tmp/project",
			" agents  3 idle",
		]);
		const output = lines.join("\n");
		// No logo mark by default and no start hint (the prompt placeholder owns it).
		expect(output).not.toContain("█");
		expect(output).not.toContain("▀");
		expect(output).not.toContain("Try");

		const unpadded = new BrandSplashHeader(
			"0.0.0",
			() => "test-model",
			() => "/tmp/project",
		);
		expect(stripAnsi(unpadded.render(120)[0] ?? "").trim()).toBe("prime-agent  v0.0.0");
	});

	it("renders an explicitly passed logo above the wordmark", () => {
		const header = new BrandSplashHeader(
			"0.0.0",
			() => "m",
			() => "/tmp",
			undefined,
			{ logo: "LOGO-1\nLOGO-2" },
		);
		const lines = header.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines.slice(0, 4)).toEqual([" LOGO-1", " LOGO-2", "", " prime-agent  v0.0.0"]);
	});

	it("randomly selects from five concise Chinese start hints", () => {
		expect(START_HINTS).toHaveLength(5);
		expect(new Set(START_HINTS).size).toBe(5);

		for (const [index, hint] of START_HINTS.entries()) {
			expect(getRandomStartHint(() => index / START_HINTS.length)).toBe(hint);
			expect(hint).toContain("@");
			expect(hint).not.toContain("Try");
		}
	});

	it("leaves the hint line's status side empty for a plain top-level session", () => {
		const mode = createMode();
		const label = Reflect.get(InteractiveMode.prototype, "getTrayStatusLabel").call(mode);

		// No model, no shortcuts, no navigation on the status side.
		expect(label).toBeUndefined();
	});

	it("shows the agent depth on the hint line's status side", () => {
		const mode = Object.assign(createMode(), { options: { returnToAgentsView: false, sessionDepth: 2 } });
		expect(Reflect.get(InteractiveMode.prototype, "getTrayStatusLabel").call(mode)).toBe("深度 2");
	});

	it("keeps fresh-chat guidance on the new-chat hints until the chat has messages", () => {
		const mode = createMode();
		const patchConnectionState = (patch: Record<string, unknown>) => Object.assign(mode.connectionState, patch);
		Object.assign(mode, {
			patchConnectionState,
			builtInHeader: { invalidate: vi.fn() },
			subagentSummaryLine: { invalidate: vi.fn() },
		});
		const updateConnectionStateFromEvent = Reflect.get(
			InteractiveMode.prototype,
			"updateConnectionStateFromEvent",
		) as (event: unknown) => void;
		const getHints = () => Reflect.get(InteractiveMode.prototype, "getTrayHints").call(mode) as string[];
		const message = { role: "user", content: "hello", timestamp: 1 };

		expect(getHints()).toEqual(["/ 命令", "@ 文件", "? 快捷键"]);

		updateConnectionStateFromEvent.call(mode, { type: "agent_start" });
		updateConnectionStateFromEvent.call(mode, { type: "message_start", message });
		Object.assign(mode.connectionState, { messageCount: 0, isStreaming: true });
		// A running turn offers the interrupt, even before any message is committed.
		expect(getHints()).toEqual(["Esc 中断", "Ctrl+O 过程", "Ctrl+T 思考"]);

		updateConnectionStateFromEvent.call(mode, { type: "message_end", message });
		updateConnectionStateFromEvent.call(mode, { type: "agent_end", messages: [message] });
		Object.assign(mode.connectionState, { messageCount: 1, isStreaming: false });
		expect(getHints()).toEqual(["Ctrl+O 过程", "Ctrl+T 思考", "? 快捷键"]);
	});

	it("routes session-view requests through the existing agents-view return path", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(0, true), { returnToAgentsView });

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledOnce();
	});

	it("no longer blocks the agents-view handoff on a draft", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const showStatus = vi.fn();
		const mode = Object.assign(
			createMode(0, true, () => "draft prompt"),
			{ returnToAgentsView, showStatus },
		);

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledOnce();
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("no longer blocks the scoped agents-view handoff on a draft", async () => {
		const returnToAgentsView = vi.fn(async () => {});
		const showStatus = vi.fn();
		const mode = Object.assign(
			createMode(0, true, () => "scoped draft"),
			{ returnToAgentsView, showStatus },
		);

		await Reflect.get(InteractiveMode.prototype, "openScopedAgentsView").call(mode);

		expect(returnToAgentsView).toHaveBeenCalledWith("scoped_agents_view");
		expect(showStatus).not.toHaveBeenCalled();
	});

	it("stashes the draft once per agents-view handoff even when re-requested mid-teardown", async () => {
		const promptStashState: PromptStashState = {};
		let resolveDispose!: () => void;
		const disposePromise = new Promise<void>((resolve) => {
			resolveDispose = resolve;
		});
		const mode = Object.assign(
			createMode(0, true, () => "draft prompt"),
			{
				promptStashState,
				pastedImages: new Map(),
				isShuttingDown: false,
				agentsViewRequest: undefined,
				unregisterSignalHandlers: vi.fn(),
				teardownSessionUi: vi.fn(async () => {}),
				agentConnection: { dispose: vi.fn(() => disposePromise) },
			},
		);
		const returnToAgentsView = Reflect.get(InteractiveMode.prototype, "returnToAgentsView");

		const firstHandoff = returnToAgentsView.call(mode);
		await returnToAgentsView.call(mode);

		expect(promptStashState.stash).toMatchObject({ text: "draft prompt", restoreOnOpen: true });
		expect(promptStashState.queuedStashes).toBeUndefined();
		resolveDispose();
		await firstHandoff;
	});

	it("opens the shared session view on back navigation for process-local chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(0, false), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(requestAgentsView).toHaveBeenCalledOnce();
		expect(returnToAgentsView).not.toHaveBeenCalled();
	});

	it("returns to the daemon agents view on back navigation for daemon chats", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const returnToAgentsView = vi.fn(async () => {});
		const mode = Object.assign(createMode(0, true), { requestAgentsView, returnToAgentsView });

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(true);
		expect(returnToAgentsView).toHaveBeenCalledOnce();
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("leaves back navigation to the editor while a draft exists", async () => {
		const requestAgentsView = vi.fn(async () => {});
		const mode = Object.assign(
			createMode(0, false, () => "draft prompt"),
			{ requestAgentsView },
		);

		const handled = Reflect.get(InteractiveMode.prototype, "handleAgentsBack").call(mode) as boolean;

		expect(handled).toBe(false);
		expect(requestAgentsView).not.toHaveBeenCalled();
	});

	it("explains that the agents view needs the daemon for non-daemon chats", async () => {
		const showStatus = vi.fn();
		const shutdown = vi.fn(async () => {});
		const mode = Object.assign(createMode(0, false), {
			returnToAgentsView: vi.fn(async () => {}),
			showStatus,
			shutdown,
		});

		await Reflect.get(InteractiveMode.prototype, "requestAgentsView").call(mode);

		expect(showStatus).toHaveBeenCalledWith(expect.stringContaining("needs the daemon"));
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("offers the session list on the hints only when the agents view is reachable", () => {
		let editorText = "";
		const daemonChat = createMode(1, true, () => editorText);
		const getHints = (mode: object) => Reflect.get(InteractiveMode.prototype, "getTrayHints").call(mode) as string[];

		expect(getHints(daemonChat)).toEqual(["Ctrl+O 过程", "Ctrl+T 思考", "← 会话列表", "? 快捷键"]);
		// The hints do not react to editor text.
		editorText = "draft prompt";
		expect(getHints(daemonChat)).toEqual(["Ctrl+O 过程", "Ctrl+T 思考", "← 会话列表", "? 快捷键"]);

		expect(getHints(createMode(0, true))).toEqual(["/ 命令", "@ 文件", "← 会话列表", "? 快捷键"]);
		expect(getHints(createMode(1, false))).toEqual(["Ctrl+O 过程", "Ctrl+T 思考", "? 快捷键"]);
	});

	it("keeps the status side empty through edits for a plain session", () => {
		let editorText = "";
		const mode = createMode(0, false, () => editorText);
		const getLabel = () => Reflect.get(InteractiveMode.prototype, "getTrayStatusLabel").call(mode);

		expect(getLabel()).toBeUndefined();
		editorText = "draft prompt";
		expect(getLabel()).toBeUndefined();
		editorText = " ";
		expect(getLabel()).toBeUndefined();
	});

	it("keeps the question-mark shortcut guide compact", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getShortcutGuide").call(createMode());

		expect(guide).toContain("`!` shell mode · `/` commands · `@` file paths");
		expect(guide).toContain("stash prompt");
		expect(guide).toContain("`/hotkeys` full reference");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("suspend");
		expect(guide).not.toContain("**Navigation**");
		expect(guide).not.toContain("**Extensions**");
	});

	it("renders question-mark shortcut help ephemerally without appending to chat history", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);
		Reflect.get(InteractiveMode.prototype, "showShortcutGuide").call(mode);

		expect(chatContainer.children).toHaveLength(0);
		expect(shortcutGuideContainer.children).toHaveLength(2);

		Reflect.get(InteractiveMode.prototype, "clearShortcutGuide").call(mode);

		expect(shortcutGuideContainer.children).toHaveLength(0);
	});

	it("keeps /hotkeys comprehensive without Ctrl+Z", () => {
		const guide = Reflect.get(InteractiveMode.prototype, "getHotkeysGuide").call(createMode());

		expect(guide).toContain("**Navigation**");
		expect(guide).toContain("**Editing**");
		expect(guide).toContain("**Fullscreen mode (`/fullscreen`)**");
		expect(guide).toContain("Queue follow-up message");
		expect(guide).not.toContain("Ctrl+Z");
		expect(guide).not.toContain("Suspend to background");
	});

	it("renders /hotkeys in chat history instead of the temporary guide", () => {
		const shortcutGuideContainer = new Container();
		const chatContainer = new Container();
		const mode = Object.assign(createMode(), {
			shortcutGuideContainer,
			chatContainer,
			ui: { requestRender: vi.fn() },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		});

		Reflect.get(InteractiveMode.prototype, "handleHotkeysCommand").call(mode);

		expect(chatContainer.children).toHaveLength(2);
		expect(shortcutGuideContainer.children).toHaveLength(0);
	});
});
