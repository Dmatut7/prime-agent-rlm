import { type Component, Container, setKeybindings, Text } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionEvent } from "../src/modes/agent-connection/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The interactive host's extension-UI event surface (wave-7 R3-M1/M3/M4):
 *
 * - R3-M1: a daemon-hosted extension failure arrives as the connection-scoped
 *   extension_error event. print/acp/rpc all consume it; the interactive
 *   subscriber dropped it, so a broken extension was invisible in the TUI.
 * - R3-M3: extension_ui_dismiss closes a locally shown dialog without the
 *   client answering the (already settled) request again.
 * - R3-M4: extension dialogs share one editorContainer slot; opening a second
 *   dialog cancels the first instead of leaving its promise hanging.
 *
 * Driven through the real prototype methods on a partial-mode fake, the same
 * harness pattern as interactive-mode-quota-park.test.ts.
 */

type ModeFake = Record<string, unknown>;

const proto = InteractiveMode.prototype as unknown as {
	subscribeToAgent(this: ModeFake): void;
};

interface ConnectionBus {
	connection: {
		subscribe: ReturnType<typeof vi.fn>;
		respondToExtensionUiRequest: ReturnType<typeof vi.fn>;
	};
	emit(event: AgentConnectionEvent): Promise<void>;
	listenerCount(): number;
}

/** Connection stub exposing the subscription listener, same shape as acp-extension-error.test.ts. */
function connectionBus(): ConnectionBus {
	const listeners: Array<(event: AgentConnectionEvent) => void | Promise<void>> = [];
	return {
		connection: {
			subscribe: vi.fn((listener: (event: AgentConnectionEvent) => void | Promise<void>) => {
				listeners.push(listener);
				return () => {};
			}),
			respondToExtensionUiRequest: vi.fn(async () => {}),
		},
		async emit(event: AgentConnectionEvent) {
			await Promise.all(listeners.map((listener) => listener(event)));
		},
		listenerCount: () => listeners.length,
	};
}

function modeFake(overrides: ModeFake = {}): ModeFake {
	const fake: ModeFake = {
		chatContainer: new Container(),
		ui: { requestRender: vi.fn(), setFocus: vi.fn() },
		showError: vi.fn(),
		sessionEventQueue: Promise.resolve(),
		sessionEventGeneration: 0,
		handleEvent: vi.fn(),
		...overrides,
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

function chatText(mode: ModeFake): string {
	return stripAnsi((mode.chatContainer as Container).render(120).join("\n"));
}

describe("extension_error forwarding (R3-M1)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("shows a daemon-hosted extension failure in the chat exactly once, off the session queue", async () => {
		const bus = connectionBus();
		const mode = modeFake({ agentConnection: bus.connection });
		proto.subscribeToAgent.call(mode);
		expect(bus.listenerCount()).toBe(1);

		await bus.emit({
			type: "extension_error",
			extensionPath: "/ext/broken.ts",
			event: "tool_call",
			error: "handler exploded",
		});

		const rendered = chatText(mode);
		expect(rendered).toContain('Extension "/ext/broken.ts" error: handler exploded');
		// The error is a connection-scoped diagnostic, not a session event: it must
		// not enter the serialized session event queue.
		expect(mode.handleEvent).not.toHaveBeenCalled();
		// Interactive mode owns exactly one extension-error surface per report: the
		// in-process connection only binds extensions for headless modes
		// (bindHeadlessExtensions, used by print/acp/rpc), and a daemon connection
		// hosts extensions daemon-side, so no local onError double-report exists.
		expect(rendered.split("handler exploded").length - 1).toBe(1);
		expect(mode.showError).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Dialog fakes: drive the real show*/hide* methods on a partial-mode fake.
// ---------------------------------------------------------------------------

type DialogProto = {
	showExtensionSelector(
		this: ModeFake,
		title: string,
		options: string[],
		opts?: { timeout?: number },
	): Promise<string | undefined>;
	showExtensionInput(
		this: ModeFake,
		title: string,
		placeholder?: string,
		opts?: { timeout?: number },
	): Promise<string | undefined>;
	showExtensionEditor(this: ModeFake, title: string, prefill?: string): Promise<string | undefined>;
	showExtensionCustom(
		this: ModeFake,
		factory: (tui: unknown, thm: unknown, keybindings: unknown, done: (result: unknown) => void) => Component,
	): Promise<unknown>;
	resetExtensionUI(this: ModeFake): void;
	cancelActiveExtensionDialog(this: ModeFake): void;
};

const dialogProto = InteractiveMode.prototype as unknown as DialogProto;

interface InputCapable {
	handleInput(data: string): void;
}

function editorFake(): Text {
	return Object.assign(new Text(""), {
		getText: () => "",
		setText: vi.fn(),
		setAutocompleteProvider: vi.fn(),
		getPaddingX: () => 0,
		setPaddingX: vi.fn(),
		actionHandlers: new Map<string, () => void>(),
	});
}

function dialogFake(overrides: ModeFake = {}): ModeFake {
	const editor = editorFake();
	const footer = Object.assign(new Text(""), { invalidate: vi.fn() });
	const footerSlot = new Container();
	footerSlot.addChild(footer);
	const fake: ModeFake = {
		editorContainer: new Container(),
		chatContainer: new Container(),
		editor,
		defaultEditor: editor,
		ui: { requestRender: vi.fn(), setFocus: vi.fn(), terminal: { rows: 24, setTitle: vi.fn() } },
		keybindings: new KeybindingsManager(),
		showError: vi.fn(),
		// resetExtensionUI's teardown surface
		activeConnectionExtensionUiRequests: new Map(),
		extensionSelector: undefined,
		extensionInput: undefined,
		extensionCustomOverlays: new Set(),
		extensionTerminalInputUnsubscribers: new Set(),
		customFooter: undefined,
		footerSlot,
		footer,
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		customHeader: undefined,
		builtInHeader: undefined,
		headerContainer: new Container(),
		extensionWidgetsAbove: new Map(),
		extensionWidgetsBelow: new Map(),
		widgetContainerAbove: new Container(),
		widgetContainerBelow: new Container(),
		autocompleteProviderWrappers: [],
		setupAutocompleteProvider: vi.fn(),
		editorComponentFactory: undefined,
		connectionState: undefined,
		uiServices: { getInitialCwd: () => "/tmp", getInitialSessionName: () => undefined },
		pastedImages: new Map(),
		heartbeatManager: undefined,
		heartbeatManagerHandle: undefined,
		heartbeatManagerRefreshTimer: undefined,
		workingIndicatorOptions: undefined,
		loadingAnimation: undefined,
		hiddenThinkingLabel: undefined,
		defaultHiddenThinkingLabel: "thinking",
		streamingComponent: undefined,
		...overrides,
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

function editorContainerChildren(mode: ModeFake): unknown[] {
	return [...(mode.editorContainer as Container).children];
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("extension dialog mutual exclusion (R3-M4)", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("a second selector cancels the first: it resolves undefined and the container shows the replacement", async () => {
		const mode = dialogFake();
		const first = dialogProto.showExtensionSelector.call(mode, "First", ["a", "b"]);
		let firstOutcome: string | undefined | "pending" = "pending";
		void first.then((value) => {
			firstOutcome = value;
		});
		const firstComponent = mode.extensionSelector;
		expect(editorContainerChildren(mode)).toEqual([firstComponent]);

		const second = dialogProto.showExtensionSelector.call(mode, "Second", ["c", "d"]);
		await flushMicrotasks();

		expect(firstOutcome).toBeUndefined();
		const secondComponent = mode.extensionSelector;
		expect(secondComponent).toBeDefined();
		expect(secondComponent).not.toBe(firstComponent);
		expect(editorContainerChildren(mode)).toEqual([secondComponent]);

		// The replacement still answers normally through its own cancel path.
		(secondComponent as InputCapable).handleInput("\x1b");
		await expect(second).resolves.toBeUndefined();
		expect(editorContainerChildren(mode)).toEqual([mode.editor]);
	});

	it("the evicted dialog's expired countdown cannot tear down its replacement", async () => {
		vi.useFakeTimers();
		try {
			const mode = dialogFake();
			const first = dialogProto.showExtensionSelector.call(mode, "First", ["a"], { timeout: 5_000 });
			let firstOutcome: string | undefined | "pending" = "pending";
			void first.then((value) => {
				firstOutcome = value;
			});
			const second = dialogProto.showExtensionSelector.call(mode, "Second", ["b"], { timeout: 60_000 });
			const secondComponent = mode.extensionSelector;
			await flushMicrotasks();
			expect(firstOutcome).toBeUndefined();

			// The first dialog's original 5s deadline passes: its timer was disposed at
			// eviction, so nothing fires and the second dialog survives.
			vi.advanceTimersByTime(10_000);
			expect(editorContainerChildren(mode)).toEqual([secondComponent]);

			// The second dialog's own countdown still expires on schedule.
			vi.advanceTimersByTime(61_000);
			await expect(second).resolves.toBeUndefined();
			expect(editorContainerChildren(mode)).toEqual([mode.editor]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a bare eviction disposes the evicted dialog and restores the editor container", async () => {
		const mode = dialogFake();
		const pending = dialogProto.showExtensionSelector.call(mode, "Pick", ["a"]);

		// The reset path evicts without opening a replacement: the eviction itself must
		// dispose the component and hand the editor container back, not leave the dialog
		// mounted until a replacement or a full rebuild cleans up after it.
		dialogProto.cancelActiveExtensionDialog.call(mode);
		await flushMicrotasks();

		expect(mode.extensionSelector).toBeUndefined();
		expect(editorContainerChildren(mode)).toEqual([mode.editor]);
		await expect(pending).resolves.toBeUndefined();
	});

	it("eviction works across dialog kinds (selector evicted by input, input by editor)", async () => {
		const mode = dialogFake();
		const selector = dialogProto.showExtensionSelector.call(mode, "Pick", ["a"]);
		let selectorOutcome: string | undefined | "pending" = "pending";
		void selector.then((value) => {
			selectorOutcome = value;
		});

		const input = dialogProto.showExtensionInput.call(mode, "Name?");
		await flushMicrotasks();
		expect(selectorOutcome).toBeUndefined();
		const inputComponent = mode.extensionInput;
		expect(inputComponent).toBeDefined();
		expect(editorContainerChildren(mode)).toEqual([inputComponent]);

		const editor = dialogProto.showExtensionEditor.call(mode, "Edit");
		await flushMicrotasks();
		await expect(input).resolves.toBeUndefined();
		const editorComponent = editorContainerChildren(mode)[0] as InputCapable;
		expect(editorComponent).toBeDefined();

		editorComponent.handleInput("\x1b");
		await expect(editor).resolves.toBeUndefined();
		expect(editorContainerChildren(mode)).toEqual([mode.editor]);
	});

	it("resetExtensionUI resolves a pending dialog as cancelled and restores the editor", async () => {
		const mode = dialogFake();
		const pending = dialogProto.showExtensionSelector.call(mode, "Pick", ["a"]);
		let outcome: string | undefined | "pending" = "pending";
		void pending.then((value) => {
			outcome = value;
		});

		dialogProto.resetExtensionUI.call(mode);
		await flushMicrotasks();

		expect(outcome).toBeUndefined();
		expect(editorContainerChildren(mode)).toEqual([mode.editor]);
	});

	it("a selector evicts a custom component dialog, resolving it as cancelled", async () => {
		const mode = dialogFake();
		const custom = dialogProto.showExtensionCustom.call(mode, () => new Text("custom-ui"));
		await flushMicrotasks();
		expect(editorContainerChildren(mode)).toHaveLength(1);

		const selector = dialogProto.showExtensionSelector.call(mode, "Pick", ["a"]);
		await flushMicrotasks();

		await expect(custom).resolves.toBeUndefined();
		expect(editorContainerChildren(mode)).toEqual([mode.extensionSelector]);

		(mode.extensionSelector as InputCapable).handleInput("\x1b");
		await expect(selector).resolves.toBeUndefined();
	});

	it("a custom component dialog evicts a selector and its own completion restores the editor", async () => {
		const mode = dialogFake();
		const selector = dialogProto.showExtensionSelector.call(mode, "Pick", ["a"]);
		let selectorOutcome: string | undefined | "pending" = "pending";
		void selector.then((value) => {
			selectorOutcome = value;
		});

		let done: ((result: unknown) => void) | undefined;
		const custom = dialogProto.showExtensionCustom.call(mode, (_tui, _thm, _kb, doneCallback) => {
			done = doneCallback;
			return new Text("custom-ui");
		});
		await flushMicrotasks();
		expect(selectorOutcome).toBeUndefined();
		expect(editorContainerChildren(mode)).toHaveLength(1);
		expect(editorContainerChildren(mode)).not.toContain(mode.editor);

		if (!done) throw new Error("factory never received its done callback");
		done("finished");
		await expect(custom).resolves.toBe("finished");
		expect(editorContainerChildren(mode)).toEqual([mode.editor]);
	});
});

describe("extension_ui_dismiss handling (R3-M3)", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	function dismissFake(): { mode: ModeFake; bus: ConnectionBus } {
		const bus = connectionBus();
		const mode = dialogFake({
			agentConnection: bus.connection,
			chatContainer: new Container(),
			sessionEventQueue: Promise.resolve(),
			sessionEventGeneration: 0,
			handleEvent: vi.fn(),
		});
		proto.subscribeToAgent.call(mode);
		return { mode, bus };
	}

	it("closes the local dialog for the dismissed request without answering it", async () => {
		const { mode, bus } = dismissFake();
		// The request's listener run settles only when the dialog does.
		const requestRun = bus.emit({
			type: "extension_ui_request",
			request: { id: "req-1", method: "select", payload: { title: "Pick", options: ["a", "b"] } },
		});
		expect(editorContainerChildren(mode)).toEqual([mode.extensionSelector]);

		await bus.emit({ type: "extension_ui_dismiss", id: "req-1", reason: "timeout" });

		expect(editorContainerChildren(mode)).toEqual([mode.editor]);
		// The request already settled daemon-side: answering again would hit the
		// daemon as a late response, so the dismissal sends nothing back.
		expect(bus.connection.respondToExtensionUiRequest).not.toHaveBeenCalled();
		expect((mode.activeConnectionExtensionUiRequests as Map<string, unknown>).size).toBe(0);
		await requestRun;
	});

	it("a local answer still goes back, and the dismiss that trails it is a no-op", async () => {
		const { mode, bus } = dismissFake();
		const requestRun = bus.emit({
			type: "extension_ui_request",
			request: { id: "req-2", method: "select", payload: { title: "Pick", options: ["a", "b"] } },
		});
		const selector = mode.extensionSelector as InputCapable;
		selector.handleInput("\x1b");
		await requestRun;

		expect(bus.connection.respondToExtensionUiRequest).toHaveBeenCalledTimes(1);
		expect(bus.connection.respondToExtensionUiRequest).toHaveBeenCalledWith("req-2", { cancelled: true });

		await bus.emit({ type: "extension_ui_dismiss", id: "req-2", reason: "timeout" });
		expect(bus.connection.respondToExtensionUiRequest).toHaveBeenCalledTimes(1);
		expect(mode.showError).not.toHaveBeenCalled();
	});

	it("ignores a dismiss for a request that never arrived", async () => {
		const { mode, bus } = dismissFake();
		await bus.emit({ type: "extension_ui_dismiss", id: "never-seen", reason: "closed" });
		expect(mode.showError).not.toHaveBeenCalled();
		expect(editorContainerChildren(mode)).toHaveLength(0);
	});
});
