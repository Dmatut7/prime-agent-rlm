import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import type { PromptStashState } from "../src/modes/interactive/prompt-stash-state.js";

type FakeEditor = {
	text: string;
	getText: () => string;
	getExpandedText: () => string;
	setText: (text: string) => void;
};

type FakeInteractiveMode = {
	ctrlCExitHintExpiresAt: number;
	ctrlCExitHintTimer: ReturnType<typeof setTimeout> | undefined;
	escapeRepeatAction: "tree" | undefined;
	escapeRepeatExpiresAt: number;
	escapeRepeatTimer: ReturnType<typeof setTimeout> | undefined;
	traceUploadAllAbortController: AbortController | undefined;
	isShuttingDown: boolean;
	editor: FakeEditor;
	connectionState: {
		isStreaming: boolean;
		isCompacting: boolean;
		isBashRunning: boolean;
		retryAttempt: number;
		sessionActions: { queuedCount: number; steering: readonly string[]; followUps: readonly string[] };
	};
	agentConnection: {
		abort: Mock;
		abortAndSendQueued: Mock;
		clearQueue: Mock;
		abortAndClearQueue: Mock;
		abortRetry: Mock;
		abortCompaction: Mock;
		abortBranchSummary: Mock;
		abortBash: Mock;
	};
	subagentSummaryLine: { invalidate: Mock };
	ui: { requestRender: Mock; onDebug?: () => void };
	updatePendingMessagesDisplay: Mock;
	showError: Mock;
	showWarning: Mock;
	showStatus: Mock;
	showToast: Mock;
	showTreeSelector: Mock;
	shutdown: Mock;
	updateEditorBorderColor: Mock;
	queueSelection: { isBrowsing: boolean; hasDraft?: boolean; reset: () => string };
	promptStashState: PromptStashState;
	pastedImages: Map<number, unknown>;
	defaultEditor?: {
		onAction: Mock;
		getHeaderLine?: () => string | undefined;
		onEscape?: () => void;
		onCtrlD?: () => void;
		onPasteImage?: () => void;
		onMoveBelowPrompt?: () => boolean;
		onChange?: (text: string) => void;
	};
	keybindings?: KeybindingsManager;
	handleDebugCommand?: Mock;
	showShortcutGuide?: Mock;
	uiServices: { settingsManager: { getProcessMode(): "quiet" | "legacy" } };
};

function createEditor(text = ""): FakeEditor {
	const editor: FakeEditor = {
		text,
		getText() {
			return this.text;
		},
		getExpandedText() {
			return this.text;
		},
		setText(nextText: string) {
			this.text = nextText;
		},
	};
	return editor;
}

function createInteractiveFake(options: {
	editorText?: string;
	streaming?: boolean;
	compacting?: boolean;
	bashRunning?: boolean;
	retryAttempt?: number;
}): FakeInteractiveMode {
	const editor = createEditor(options.editorText ?? "");
	const fake: FakeInteractiveMode = {
		ctrlCExitHintExpiresAt: 0,
		ctrlCExitHintTimer: undefined,
		escapeRepeatAction: undefined,
		escapeRepeatExpiresAt: 0,
		escapeRepeatTimer: undefined,
		traceUploadAllAbortController: undefined,
		isShuttingDown: false,
		editor,
		connectionState: {
			isStreaming: options.streaming ?? false,
			isCompacting: options.compacting ?? false,
			isBashRunning: options.bashRunning ?? false,
			retryAttempt: options.retryAttempt ?? 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		},
		agentConnection: {
			abort: vi.fn().mockResolvedValue(undefined),
			// What the streaming interrupt calls since #2426 was wired to the key: an empty
			// result is a peer that served the command, so no degradation warning is owed.
			abortAndSendQueued: vi.fn().mockResolvedValue({}),
			clearQueue: vi.fn().mockResolvedValue({ steering: [], followUp: [] }),
			abortAndClearQueue: vi.fn().mockResolvedValue({ steering: [], followUp: [] }),
			// Promise-returning, as the real connection is: the interrupt path attaches a
			// .catch() to each of these best-effort aborts.
			abortRetry: vi.fn().mockResolvedValue(undefined),
			abortCompaction: vi.fn().mockResolvedValue(undefined),
			abortBranchSummary: vi.fn().mockResolvedValue(undefined),
			abortBash: vi.fn().mockResolvedValue(undefined),
		},
		subagentSummaryLine: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		queueSelection: { isBrowsing: false, hasDraft: false, reset: () => "" },
		promptStashState: {},
		pastedImages: new Map(),
		updatePendingMessagesDisplay: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		showToast: vi.fn(),
		showTreeSelector: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		updateEditorBorderColor: vi.fn(),
		showShortcutGuide: vi.fn(),
		// handleEscape reads the process mode (T8 quiet Esc walk) through the settings service.
		uiServices: { settingsManager: { getProcessMode: () => "quiet" } },
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

describe("InteractiveMode interrupt shortcuts", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-08T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("interrupts streaming on first Ctrl+C without arming exit", () => {
		const mode = createInteractiveFake({ streaming: true });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.agentConnection.abortAndSendQueued).toHaveBeenCalledTimes(1);
		expect(mode.agentConnection.abort).not.toHaveBeenCalled();
		expect(mode.shutdown).not.toHaveBeenCalled();
		// Stopping work only stops it: the usual double press to stop a task must not quit.
		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBeUndefined();
	});

	it("interrupts bash and streaming on the same Ctrl+C", () => {
		const mode = createInteractiveFake({ streaming: true, bashRunning: true });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.agentConnection.abortBash).toHaveBeenCalledTimes(1);
		expect(mode.agentConnection.abortAndSendQueued).toHaveBeenCalledTimes(1);
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it.each([
		["Ctrl+C", "handleCtrlC"],
		["Escape", "handleEscape"],
	] as const)("cancels an upload-all operation on %s", (_label, handlerName) => {
		const mode = createInteractiveFake({});
		const controller = new AbortController();
		mode.traceUploadAllAbortController = controller;

		Reflect.get(InteractiveMode.prototype, handlerName).call(mode);

		expect(controller.signal.aborted).toBe(true);
		expect(controller.signal.reason).toEqual(new Error("Trace upload cancelled"));
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it("sends the queue with the interrupt instead of clearing it, and keeps the draft", () => {
		// Retitled with the #2426 wiring: the interrupt no longer leaves the queue for the next
		// submit, it carries it out - so what must not happen is a clear, and the draft is still
		// nobody's business but the user's.
		const mode = createInteractiveFake({ editorText: "draft", streaming: true });
		mode.connectionState.sessionActions = { queuedCount: 2, steering: ["steer"], followUps: ["follow"] };

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.agentConnection.abortAndSendQueued).toHaveBeenCalledTimes(1);
		expect(mode.agentConnection.abortAndClearQueue).not.toHaveBeenCalled();
		expect(mode.agentConnection.clearQueue).not.toHaveBeenCalled();
		expect(mode.editor.getText()).toBe("draft");
		expect(mode.connectionState.sessionActions).toEqual({
			queuedCount: 2,
			steering: ["steer"],
			followUps: ["follow"],
		});
	});

	it("a double Ctrl+C during a run stops it without quitting; an idle double press exits", () => {
		const mode = createInteractiveFake({ streaming: true });
		const handleCtrlC = Reflect.get(InteractiveMode.prototype, "handleCtrlC");

		handleCtrlC.call(mode);
		mode.connectionState.isStreaming = false;
		handleCtrlC.call(mode);
		expect(mode.shutdown).not.toHaveBeenCalled();
		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBe("再按一次 Ctrl+C 退出");

		handleCtrlC.call(mode);
		expect(mode.agentConnection.abortAndSendQueued).toHaveBeenCalledTimes(1);
		expect(mode.shutdown).toHaveBeenCalledTimes(1);
	});

	it("clears the exit hint after two seconds", async () => {
		const mode = createInteractiveFake({ editorText: "draft" });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);
		expect(mode.editor.getText()).toBe("draft");
		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBe("再按一次 Ctrl+C 退出");

		await vi.advanceTimersByTimeAsync(2000);

		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBeUndefined();
		// U6: the override label rides the uncached tray info line; a frame
		// request repaints it (no summary-line cache to drop).
		expect(mode.ui.requestRender).toHaveBeenCalled();
	});

	it("preserves idle draft input on first Ctrl+C", () => {
		const mode = createInteractiveFake({ editorText: "draft" });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.editor.getText()).toBe("draft");
		expect(mode.agentConnection.abortAndSendQueued).not.toHaveBeenCalled();
		expect(mode.agentConnection.abort).not.toHaveBeenCalled();
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it("cancels the tree repeat when typing after interrupting streaming", () => {
		const actionHandlers = new Map<string, () => void>();
		const mode = createInteractiveFake({ editorText: "draft", streaming: true });
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn((action: string, handler: () => void) => {
				actionHandlers.set(action, handler);
			}),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		expect(defaultEditor.onEscape).toBeDefined();
		defaultEditor.onEscape?.();
		expect(mode.agentConnection.abortAndSendQueued).toHaveBeenCalledTimes(1);
		expect(mode.editor.getText()).toBe("draft");
		mode.editor.setText("queued draft");
		defaultEditor.onChange?.("queued draft");

		defaultEditor.onEscape?.();

		expect(mode.showTreeSelector).not.toHaveBeenCalled();
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it("preserves the tree repeat while browsing into a queued message", () => {
		const mode = createInteractiveFake({});
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn(),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
			isApplyingQueueSelectionText: false,
		});
		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		const setText = mode.editor.setText.bind(mode.editor);
		mode.editor.setText = (text) => {
			setText(text);
			defaultEditor.onChange?.(text);
		};
		mode.escapeRepeatAction = "tree";
		mode.escapeRepeatExpiresAt = Date.now() + 500;

		Reflect.get(InteractiveMode.prototype, "setEditorTextFromQueueSelection").call(mode, "queued item");

		expect(mode.editor.getText()).toBe("queued item");
		expect(mode.escapeRepeatAction).toBe("tree");
	});

	it("clears an idle draft on a single Escape, with nothing armed behind it", () => {
		const actionHandlers = new Map<string, () => void>();
		const mode = createInteractiveFake({ editorText: "draft" });
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn((action: string, handler: () => void) => {
				actionHandlers.set(action, handler);
			}),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		defaultEditor.onEscape?.();

		// The documented behavior (keybindings.md: `app.input.clear` = Clear input):
		// one press clears; no 500ms double-press window is involved.
		expect(mode.editor.getText()).toBe("");
		expect(mode.escapeRepeatAction).toBeUndefined();
		expect(mode.agentConnection.abortAndSendQueued).not.toHaveBeenCalled();
		expect(mode.agentConnection.abort).not.toHaveBeenCalled();
	});

	it("opens the tree on double Escape with an empty idle prompt", () => {
		const mode = createInteractiveFake({});
		const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");

		handleEscape.call(mode);
		handleEscape.call(mode);

		expect(mode.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(mode.editor.getText()).toBe("");
	});

	it("asks the tree to preselect the latest user message on double Escape", () => {
		// The double-Esc landing is the edit-and-resend flow: the tree opens with
		// the latest user message highlighted, so Enter forks it back into the
		// editor. The explicit /tree entry keeps the current-leaf highlight.
		const mode = createInteractiveFake({});
		const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");

		handleEscape.call(mode);
		handleEscape.call(mode);

		expect(mode.showTreeSelector).toHaveBeenCalledWith(undefined, { preselectLatestUserMessage: true });
	});

	it("clears a whitespace draft on a single Escape", () => {
		const mode = createInteractiveFake({ editorText: "   " });
		const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");

		handleEscape.call(mode);

		expect(mode.showTreeSelector).not.toHaveBeenCalled();
		expect(mode.editor.getText()).toBe("");
	});

	it("stashes an idle draft on Escape; the stash key restores it", () => {
		const mode = createInteractiveFake({ editorText: "draft text to test esc" });
		const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");

		handleEscape.call(mode);

		// One press still clears; the draft survives in the stash instead of vanishing.
		expect(mode.editor.getText()).toBe("");
		expect(mode.promptStashState.stash?.text).toBe("draft text to test esc");
		expect(mode.showToast).toHaveBeenCalledWith("✓ stashed");
		expect(mode.escapeRepeatAction).toBeUndefined();

		// The restore path is the manual stash's: Ctrl+S on the empty editor.
		Reflect.get(InteractiveMode.prototype, "handlePromptStash").call(mode);
		expect(mode.editor.getText()).toBe("draft text to test esc");
		expect(mode.promptStashState.stash).toBeUndefined();
		expect(mode.showToast).toHaveBeenCalledWith("✓ draft restored");
	});

	it("queues an earlier manual stash behind the Escape-stashed draft", () => {
		const mode = createInteractiveFake({ editorText: "esc cleared draft" });
		mode.promptStashState.stash = { text: "manual stash" };
		const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");
		const handlePromptStash = Reflect.get(InteractiveMode.prototype, "handlePromptStash");

		handleEscape.call(mode);

		expect(mode.editor.getText()).toBe("");
		expect(mode.promptStashState.stash?.text).toBe("esc cleared draft");
		expect(mode.promptStashState.queuedStashes?.map((stash) => stash.text)).toEqual(["manual stash"]);

		// The draft Esc just cleared restores first; the older stash is next in line.
		handlePromptStash.call(mode);
		expect(mode.editor.getText()).toBe("esc cleared draft");
		mode.editor.setText("");
		handlePromptStash.call(mode);
		expect(mode.editor.getText()).toBe("manual stash");
		expect(mode.promptStashState.stash).toBeUndefined();
	});

	it("clears a whitespace-only draft without stashing it", () => {
		const mode = createInteractiveFake({ editorText: "  \n  " });

		Reflect.get(InteractiveMode.prototype, "handleEscape").call(mode);

		expect(mode.editor.getText()).toBe("");
		expect(mode.promptStashState.stash).toBeUndefined();
		expect(mode.promptStashState.queuedStashes).toBeUndefined();
		expect(mode.showToast).not.toHaveBeenCalled();
	});

	it("does not arm the tree on the Escape that interrupts streaming work", () => {
		const mode = createInteractiveFake({ editorText: "draft", streaming: true });
		const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");

		handleEscape.call(mode);
		// Stop is just stop (the Ctrl+C rule): the interrupting press arms nothing,
		// so the habitual second press cannot pop the session tree open.
		expect(mode.agentConnection.abortAndSendQueued).toHaveBeenCalledTimes(1);
		expect(mode.escapeRepeatAction).toBeUndefined();
		expect(mode.editor.getText()).toBe("draft");

		handleEscape.call(mode);

		expect(mode.showTreeSelector).not.toHaveBeenCalled();
		expect(mode.agentConnection.abortAndSendQueued).toHaveBeenCalledTimes(2);
		expect(mode.escapeRepeatAction).toBeUndefined();
	});

	for (const [label, options] of [
		["a retry", { retryAttempt: 1 }],
		["compaction", { compacting: true }],
		["a bash command", { bashRunning: true }],
	] as const) {
		it(`stops ${label} on Escape without arming the tree or clearing the draft`, () => {
			const mode = createInteractiveFake({ editorText: "draft", ...options });
			const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");

			handleEscape.call(mode);

			// Stop is just stop: the press that cancelled the work arms no tree.
			expect(mode.showTreeSelector).not.toHaveBeenCalled();
			expect(mode.escapeRepeatAction).toBeUndefined();
			expect(mode.editor.getText()).toBe("draft");

			// The work gone and the draft still there, one Esc clears the draft...
			mode.connectionState.isCompacting = false;
			mode.connectionState.isBashRunning = false;
			mode.connectionState.retryAttempt = 0;
			handleEscape.call(mode);
			expect(mode.editor.getText()).toBe("");
			expect(mode.showTreeSelector).not.toHaveBeenCalled();

			// ...and only the empty idle prompt keeps the double-press tree.
			handleEscape.call(mode);
			expect(mode.showTreeSelector).not.toHaveBeenCalled();
			handleEscape.call(mode);
			expect(mode.showTreeSelector).toHaveBeenCalledTimes(1);
		});
	}

	it("clears the Escape repeat before a separate interrupt", () => {
		const mode = createInteractiveFake({});
		mode.escapeRepeatAction = "tree";
		mode.escapeRepeatExpiresAt = Date.now() + 500;

		Reflect.get(InteractiveMode.prototype, "handleInterruptKey").call(mode);

		expect(mode.escapeRepeatAction).toBeUndefined();
	});

	it("expires the Escape tree-repeat window on an empty idle prompt", async () => {
		const actionHandlers = new Map<string, () => void>();
		const mode = createInteractiveFake({});
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn((action: string, handler: () => void) => {
				actionHandlers.set(action, handler);
			}),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		defaultEditor.onEscape?.();
		expect(mode.escapeRepeatAction).toBe("tree");
		await vi.advanceTimersByTimeAsync(500);

		// Past the window the press re-arms instead of firing...
		defaultEditor.onEscape?.();
		expect(mode.showTreeSelector).not.toHaveBeenCalled();
		expect(mode.escapeRepeatAction).toBe("tree");

		// ...and the press inside the new window opens the tree.
		defaultEditor.onEscape?.();
		expect(mode.showTreeSelector).toHaveBeenCalledTimes(1);
	});

	it("opens keyboard shortcuts from the configured app action", () => {
		const actionHandlers = new Map<string, () => void>();
		const mode = createInteractiveFake({});
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn((action: string, handler: () => void) => {
				actionHandlers.set(action, handler);
			}),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		actionHandlers.get("app.shortcuts")?.();

		expect(mode.showShortcutGuide).toHaveBeenCalledTimes(1);
	});

	it("a session replacement clears an armed Ctrl+C exit hint and Esc tree repeat", () => {
		const mode = createInteractiveFake({});
		Reflect.get(InteractiveMode.prototype, "showCtrlCExitHint").call(mode);
		Reflect.get(InteractiveMode.prototype, "armEscapeRepeat").call(mode);
		expect(mode.ctrlCExitHintExpiresAt).toBeGreaterThan(0);
		expect(mode.escapeRepeatAction).toBe("tree");

		// The session-scoped state resetCurrentSessionRenderState walks; everything
		// not under test is stubbed, the two armed repeats above are the point.
		Object.assign(mode, {
			endFeatureHintRun: vi.fn(),
			resetBlockNavigation: vi.fn(),
			chatContainer: { clear: vi.fn() },
			shortcutGuideContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			queuedMessagesContainer: { clear: vi.fn() },
			pendingQueueEdit: undefined,
			pendingQueueMove: false,
			defaultEditor: { clearHistory: vi.fn(), setText: vi.fn() },
			ui: { requestRender: vi.fn(), terminal: { abortPendingInput: vi.fn() } },
			liveImageMarkerIds: vi.fn(() => new Set()),
			pastedImages: new Map(),
			discardRefineLoader: vi.fn(),
			disposeTransientStatusOverlays: vi.fn(),
			removeStallActionBar: vi.fn(),
			releaseStallDiagnostics: vi.fn(),
			pendingBashComponents: [],
			activityTracker: { reset: vi.fn() },
			contextUsageTokenBaseline: 0,
			pendingToolGeneration: 0,
			pendingTools: new Map(),
			pendingToolCreations: new Set(),
			startedToolCalls: new Set(),
			agentRunFileChanges: new Map(),
			renderRecap: vi.fn(),
			ipythonToolComponents: new Map(),
			lateIpythonSentAgentMessages: new Map(),
			chatTranscriptTrimmed: true,
			chatCapRebuildFloor: 1,
			slimTranscriptOmitted: 5,
			slimTranscriptBackfillInFlight: false,
			slimTranscriptMarker: undefined,
			slimTranscriptViewEpoch: 0,
			slimOrphanToolResults: new Map([["tool-x", { role: "toolResult" }]]),
			liveTurnFlowStore: undefined,
			resetSubagentSummary: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			getGoalState: vi.fn(() => ({})),
			syncGoalTray: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "resetCurrentSessionRenderState").call(mode);

		expect(mode.ctrlCExitHintExpiresAt).toBe(0);
		expect(mode.ctrlCExitHintTimer).toBeUndefined();
		expect(mode.escapeRepeatAction).toBeUndefined();
		expect(mode.escapeRepeatTimer).toBeUndefined();
		expect(mode.escapeRepeatExpiresAt).toBe(0);
		expect(Reflect.get(mode, "slimOrphanToolResults").size).toBe(0);
		expect(Reflect.get(mode, "slimTranscriptOmitted")).toBe(0);
	});
});
