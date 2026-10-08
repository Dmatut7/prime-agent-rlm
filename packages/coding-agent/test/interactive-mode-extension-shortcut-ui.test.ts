import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

function createOverlayStackUi() {
	const stack: Array<{ component: unknown }> = [];
	return {
		stack,
		requestRender: vi.fn(),
		setFocus: vi.fn(),
		terminal: { setTitle: vi.fn(), columns: 120, rows: 40 },
		showOverlay: vi.fn((component: unknown) => {
			const entry = { component };
			stack.push(entry);
			return {
				hide: () => {
					const index = stack.indexOf(entry);
					if (index >= 0) stack.splice(index, 1);
				},
				setHidden: vi.fn(),
				isHidden: () => false,
				focus: vi.fn(),
				unfocus: vi.fn(),
				isFocused: () => false,
			};
		}),
		hideOverlay: vi.fn(() => {
			stack.pop();
		}),
	};
}

type ExtensionUiProto = {
	showExtensionCustom<T>(
		this: Record<string, unknown>,
		factory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => { render(width: number): string[]; invalidate(): void },
		options?: { overlay?: boolean },
	): Promise<T>;
	resetExtensionUI(this: Record<string, unknown>): void;
};

const extensionUiProto = InteractiveMode.prototype as unknown as ExtensionUiProto;

function createResetHarness(ui: ReturnType<typeof createOverlayStackUi>) {
	const editor = { getText: () => "", setText: vi.fn() };
	const defaultEditor = { setText: vi.fn(), onExtensionShortcut: undefined };
	const harness: Record<string, unknown> = {
		ui,
		editor,
		defaultEditor,
		editorContainer: { clear: vi.fn(), addChild: vi.fn() },
		chatContainer: { children: [] },
		keybindings: undefined,
		activeConnectionExtensionUiRequests: new Map(),
		extensionCustomOverlays: new Set(),
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionEditor: undefined,
		heartbeatManager: undefined,
		heartbeatManagerHandle: undefined,
		heartbeatManagerRefreshTimer: undefined,
		extensionTerminalInputUnsubscribers: new Set(),
		extensionWidgetsAbove: new Map(),
		extensionWidgetsBelow: new Map(),
		widgetContainerAbove: undefined,
		widgetContainerBelow: undefined,
		customFooter: undefined,
		footerSlot: { removeChild: vi.fn(), addChild: vi.fn() },
		footer: { invalidate: vi.fn() },
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		pastedImages: new Map(),
		hiddenThinkingLabel: "Thinking...",
		defaultHiddenThinkingLabel: "Thinking...",
		streamingComponent: undefined,
		loadingAnimation: undefined,
		workingMessage: undefined,
		workingVisible: true,
		workingIndicatorOptions: undefined,
		// Collaborators with no bearing on overlay ownership.
		setupAutocompleteProvider: vi.fn(),
		updateTerminalTitle: vi.fn(),
		showError: vi.fn(),
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return harness;
}

describe("InteractiveMode extension overlay teardown (R5-M28)", () => {
	test("resetExtensionUI removes only the extension's own overlay, never a foreign one on top", async () => {
		const ui = createOverlayStackUi();
		const harness = createResetHarness(ui);
		const extensionOverlayComponent = { render: () => ["ext"], invalidate: () => {} };
		void extensionUiProto.showExtensionCustom.call(harness, () => extensionOverlayComponent, { overlay: true });
		await vi.waitFor(() => expect(ui.stack).toHaveLength(1));

		// A login dialog (OAuth polling in the background) lands on top.
		const loginDialog = { render: () => ["login"], invalidate: () => {} };
		ui.showOverlay(loginDialog);
		expect(ui.stack).toHaveLength(2);

		extensionUiProto.resetExtensionUI.call(harness);

		expect(ui.stack).toHaveLength(1);
		expect(ui.stack[0]?.component).toBe(loginDialog);
	});

	test("an extension overlay closing itself never pops a foreign overlay on top", async () => {
		const ui = createOverlayStackUi();
		const harness = createResetHarness(ui);
		let done: ((result: string) => void) | undefined;
		const result = extensionUiProto.showExtensionCustom.call(
			harness,
			(_tui, _theme, _keybindings, resolve) => {
				done = resolve;
				return { render: () => ["ext"], invalidate: () => {} };
			},
			{ overlay: true },
		);
		await vi.waitFor(() => expect(ui.stack).toHaveLength(1));
		const loginDialog = { render: () => ["login"], invalidate: () => {} };
		ui.showOverlay(loginDialog);

		done?.("picked");
		await result;

		expect(ui.stack).toHaveLength(1);
		expect(ui.stack[0]?.component).toBe(loginDialog);
	});
});

/**
 * The shortcut path builds its own ExtensionContext instead of using the runner's, so its `ui`
 * has to come from the runner: bindExtensions installs the dialog-tracking wrapper there, and a
 * fresh context would leave shortcut-opened dialogs uncounted, so the stall watchdog would not
 * pause for them.
 *
 * Scope limit, so the next reader does not assume one test covers the whole property. "A dialog
 * opened through a shortcut pauses the stall watchdog" is a three-link chain: this identity nail
 * (the shortcut context is the runner's), the wiring nail in
 * test/suite/agent-session-ui-dialog-pause.test.ts (a bound dialog open makes an armed watchdog
 * snooze), and the static fact that hasUI() and getUIContext() key off the same field, so a true
 * hasUI() always means the wrapped context. No single test covers the chain, and breaking one
 * link does not redden any one of them alone.
 */
function extract(runnerHasUI: boolean) {
	const tracked = { __which: "tracked", confirm: vi.fn() };
	const fresh = { __which: "fresh", confirm: vi.fn() };
	let received: { ui: unknown; hasUI: boolean } | undefined;
	const runner = {
		getShortcuts: () =>
			new Map([
				[
					"x",
					{
						handler: (ctx: { ui: unknown; hasUI: boolean }) => {
							received = ctx;
						},
					},
				],
			]),
		hasUI: () => runnerHasUI,
		getUIContext: () => tracked,
	};
	const fakeThis = {
		keybindings: { getEffectiveConfig: () => ({}) },
		getLocalSessionHost: () => ({
			getSessionManager: () => ({}),
			getAbortSignal: () => new AbortController().signal,
			getSystemPrompt: () => "",
		}),
		createExtensionUIContext: () => fresh,
		getCurrentCwd: () => "/tmp",
		modelRegistry: {},
		getCurrentModel: () => undefined,
		isAgentStreaming: () => false,
		agentConnection: { abort: vi.fn(), compact: vi.fn() },
		getQueuedActionCount: () => 0,
		getConnectionContextUsage: () => undefined,
		defaultEditor: {} as { onExtensionShortcut?: (data: string) => boolean },
		showError: vi.fn(),
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any -- prototype extraction, in-repo
	// precedent: interactive-mode-status.test.ts calls createExtensionUIContext the same way.
	const proto = InteractiveMode as unknown as {
		prototype: { setupExtensionShortcuts(runner: unknown): void };
	};
	proto.prototype.setupExtensionShortcuts.call(fakeThis, runner);
	const matched = fakeThis.defaultEditor.onExtensionShortcut?.("x");
	return { matched, received: received as { ui: { __which: string }; hasUI: boolean } | undefined, tracked, fresh };
}

describe("InteractiveMode.setupExtensionShortcuts UI context", () => {
	test("hands the shortcut handler the runner's dialog-tracked context", () => {
		const { matched, received, tracked } = extract(true);

		expect(matched).toBe(true);
		expect(received).toBeDefined();
		// Identity, not shape: a freshly built context would also have a confirm member.
		expect(received?.ui).toBe(tracked);
		expect(received?.hasUI).toBe(true);
	});

	test("falls back to a fresh context, and says so, when the runner has no bound UI", () => {
		const { matched, received, fresh } = extract(false);

		expect(matched).toBe(true);
		expect(received?.ui).toBe(fresh);
		expect(received?.hasUI).toBe(false);
	});
});
