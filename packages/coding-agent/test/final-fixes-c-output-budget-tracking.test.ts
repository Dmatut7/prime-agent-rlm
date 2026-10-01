import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import {
	anyBudgetTruncatable,
	resetBudgetTruncatableTracking,
	setQuietConversationBudget,
	setToolOutputFull,
	toolOutputFull,
} from "../src/modes/interactive/components/tool-output-budget.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * FIX-20: the set of blocks the output budget held back was only ever added to.
 * After /new (or any rebuild of the chat) the discarded bash and ipython blocks
 * stayed in it, so Alt+Shift+O never said "没有被省略的输出" again - it silently
 * flipped the global full-output switch - and every discarded block, with its whole
 * output text, stayed reachable from that process-wide set.
 *
 * Blocks are the app's own (the bash tool's renderer, the ipython cell), expanded
 * with the real Alt+O key and rendered as the chat renders them; the chat is then
 * discarded by the mode's own code paths.
 */

const ALT_O = "\x1b[111;3u";
const ALT_SHIFT_O = "\x1b[111;4u";
const NOTHING_HELD_BACK = "没有被省略的输出";
const WIDTH = 100;
const LONG_OUTPUT_LINES = 160;

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
	setToolOutputFull(false);
	resetBudgetTruncatableTracking();
});

afterEach(() => {
	setToolOutputFull(false);
	setQuietConversationBudget(false);
	resetBudgetTruncatableTracking();
});

const outputOf = (lines: number, tag: string): string =>
	Array.from({ length: lines }, (_v, index) => `${tag}-line-${String(index).padStart(3, "0")}`).join("\n");

interface Rig {
	mode: InteractiveMode;
	chat: Container;
	toasts: string[];
	press(data: string): void;
	render(): string;
}

/** A mode on a real editor and a real chat: what the budget key needs, and what /new tears down. */
function createRig(processMode: "quiet" | "legacy" = "legacy"): Rig {
	const chat = new Container();
	const requestRender = vi.fn();
	const ui = {
		requestRender,
		requestRenderPreservingViewport: requestRender,
		isFullscreen: () => false,
		isFullscreenReviewing: () => false,
		terminal: {
			rows: 40,
			columns: WIDTH,
			abortPendingInput: () => {},
			drainInput: async () => {},
		},
	};
	const defaultEditor = new CustomEditor(ui as unknown as TUI, getEditorTheme(), new KeybindingsManager());
	const toasts: string[] = [];
	const noop = () => {};
	const fake: Record<string, unknown> = {
		chatContainer: chat,
		ui,
		defaultEditor,
		editor: defaultEditor,
		toolOutputExpanded: false,
		thinkingExpanded: false,
		agentMessagesExpanded: false,
		editDiffsExpanded: false,
		customHeader: undefined,
		builtInHeader: undefined,
		uiServices: { settingsManager: { getProcessMode: () => processMode } },
		settingsManager: { getProcessMode: () => processMode, getShowImages: () => true, getCodeBlockIndent: () => "  " },
		showToast: (text: string) => {
			toasts.push(text);
		},
		showStatus: noop,
		// What /new, /tree and a rebuild leave alone or hand back to the connection.
		stopWorkingLoader: noop,
		handleFatalRuntimeError: async (prefix: string, error: unknown): Promise<never> => {
			throw new Error(`${prefix}: ${String(error)}`);
		},
		sessionEventQueue: Promise.resolve(),
		renderInitialMessages: async () => {},
		updatePendingMessagesDisplay: noop,
		syncWorkingLoader: noop,
		clearSideQuestion: noop,
		resetBlockNavigation: noop,
		endFeatureHintRun: noop,
		shortcutGuideContainer: new Container(),
		pendingMessagesContainer: new Container(),
		queuedMessagesContainer: new Container(),
		pendingQueueEdit: undefined,
		pendingQueueMove: false,
		queueSelection: { reset: noop },
		featureHintSuppressedByQueue: false,
		liveImageMarkerIds: () => new Set<number>(),
		pastedImages: new Map(),
		streamingComponent: undefined,
		streamingMessage: undefined,
		activeBashComponent: undefined,
		discardRefineLoader: noop,
		disposeTransientStatusOverlays: noop,
		pendingBashComponents: [],
		activityTracker: { reset: noop },
		contextUsageTokenBaseline: 0,
		pendingTools: new Map(),
		pendingToolCreations: new Set(),
		startedToolCalls: new Set(),
		pendingToolGeneration: 0,
		agentRunFileChanges: new Map(),
		renderRecap: noop,
		ipythonToolComponents: new Map(),
		lateIpythonSentAgentMessages: new Map(),
		chatTranscriptTrimmed: false,
		chatCapRebuildFloor: 0,
		slimOrphanToolResults: new Map(),
		liveTurnFlowStore: undefined,
		currentTurnState: undefined,
		currentTurnSummary: undefined,
		sessionOutputTokens: undefined,
		resetSubagentSummary: noop,
		getGoalState: () => undefined,
		setGoalAnnouncementBaseline: noop,
		syncGoalTray: noop,
		releasePromptStashSession: noop,
		fullscreenEnabled: false,
		stop: noop,
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	const mode = fake as unknown as InteractiveMode;
	Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
	return {
		mode,
		chat,
		toasts,
		press: (data) => defaultEditor.handleInput(data),
		render: () => stripAnsi(chat.render(WIDTH).join("\n")),
	};
}

function call(rig: Rig, name: string, ...args: unknown[]): Promise<void> {
	return Reflect.get(InteractiveMode.prototype, name).call(rig.mode, ...args);
}

const fakeTui = (): TUI => ({ requestRender: vi.fn(), isFullscreen: () => false }) as unknown as TUI;

/** A `bash` step whose output is over the budget, as the chat holds it. */
function bashBlock(id: string, lines = LONG_OUTPUT_LINES): ToolExecutionComponent {
	const block = new ToolExecutionComponent("bash", id, { command: `seq ${lines}` }, {}, undefined, fakeTui(), "/tmp");
	block.updateResult({ content: [{ type: "text", text: outputOf(lines, id) }], isError: false }, false);
	return block;
}

/** An `ipython` cell whose printed output is over the budget. */
function ipythonBlock(id: string, lines = LONG_OUTPUT_LINES): ToolExecutionComponent {
	const stdout = outputOf(lines, id);
	const block = new ToolExecutionComponent(
		"ipython",
		id,
		{ code: `for i in range(${lines}): print(i)` },
		{},
		undefined,
		fakeTui(),
		"/tmp",
	);
	block.updateResult(
		{ content: [{ type: "text", text: stdout }], details: { status: "ok", durationMs: 5, stdout }, isError: false },
		false,
	);
	return block;
}

// A cell only holds output back under the quiet conversation's window; the bash block has its own budget.
const BLOCK_KINDS = [
	{ kind: "bash", build: bashBlock, quietBudget: false, holdBackNote: /\.\.\. \d+ more lines/ },
	{ kind: "ipython", build: ipythonBlock, quietBudget: true, holdBackNote: /还有 \d+ 行/ },
] as const;

/** Expand every step with the global key and let the chat draw, as a user looking at long output does. */
function openLongOutput(rig: Rig): void {
	rig.press(ALT_O);
	rig.render();
}

describe.each(BLOCK_KINDS)(
	"Alt+Shift+O after the chat drops a long $kind block (FIX-20)",
	({ build, quietBudget, holdBackNote }) => {
		beforeEach(() => {
			setQuietConversationBudget(quietBudget);
		});

		it("says nothing is held back once /new has cleared the chat", async () => {
			const rig = createRig();
			rig.chat.addChild(build("before-new"));
			openLongOutput(rig);
			expect(anyBudgetTruncatable()).toBe(true);
			expect(rig.render()).toMatch(holdBackNote);

			await Reflect.get(InteractiveMode.prototype, "handleClearCommand").call(
				Object.assign(rig.mode, {
					agentConnection: { newSession: async () => ({ cancelled: false }) },
					renderCurrentSessionState: Reflect.get(InteractiveMode.prototype, "renderCurrentSessionState").bind(
						rig.mode,
					),
				}),
			);
			expect(rig.chat.children.some((child) => child instanceof ToolExecutionComponent)).toBe(false);

			rig.press(ALT_SHIFT_O);

			expect(rig.toasts).toEqual([NOTHING_HELD_BACK]);
			expect(toolOutputFull()).toBe(false);
		});

		it("does not keep the discarded block reachable from the budget's tracking", async () => {
			const rig = createRig();
			rig.chat.addChild(build("discarded"));
			openLongOutput(rig);
			expect(anyBudgetTruncatable()).toBe(true);

			await call(rig, "resetCurrentSessionRenderState");

			expect(rig.chat.children).toHaveLength(0);
			expect(anyBudgetTruncatable()).toBe(false);
		});

		it("still acts on a block that is on screen when nothing was cleared", () => {
			const rig = createRig();
			rig.chat.addChild(build("on-screen"));
			openLongOutput(rig);
			expect(rig.render()).not.toContain("on-screen-line-159");
			expect(rig.render()).toMatch(holdBackNote);

			rig.press(ALT_SHIFT_O);

			expect(rig.toasts).toEqual([]);
			expect(toolOutputFull()).toBe(true);
			expect(rig.render()).toContain("on-screen-line-159");
			expect(rig.render()).not.toMatch(holdBackNote);
		});
	},
);

describe("the other places the chat is discarded (FIX-20)", () => {
	it("forgets the blocks when /tree rebuilds the chat", async () => {
		const rig = createRig();
		rig.chat.addChild(bashBlock("before-tree"));
		openLongOutput(rig);
		expect(anyBudgetTruncatable()).toBe(true);

		await call(rig, "renderTreeNavigation", {});

		expect(rig.chat.children.some((child) => child instanceof ToolExecutionComponent)).toBe(false);
		expect(anyBudgetTruncatable()).toBe(false);
		rig.press(ALT_SHIFT_O);
		expect(rig.toasts).toEqual([NOTHING_HELD_BACK]);
	});

	it("forgets the blocks when the session's UI is torn down for the agents view", async () => {
		const rig = createRig();
		rig.chat.addChild(bashBlock("before-teardown"));
		rig.chat.addChild(ipythonBlock("before-teardown-cell"));
		openLongOutput(rig);
		expect(anyBudgetTruncatable()).toBe(true);

		await call(rig, "teardownSessionUi", { preserveAltScreen: true });

		expect(anyBudgetTruncatable()).toBe(false);
	});
});

describe.each(BLOCK_KINDS)("a rebuild of the chat around a $kind block (FIX-20)", ({ kind, build, quietBudget }) => {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	beforeEach(() => {
		setQuietConversationBudget(quietBudget);
	});

	/** The transcript the rebuild replays: one step of this kind that printed `lines` lines. */
	function transcript(id: string, lines: number): AgentMessage[] {
		const text = outputOf(lines, id);
		const call = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id,
					name: kind,
					arguments: kind === "bash" ? { command: `seq ${lines}` } : { code: `print(${lines})` },
				},
			],
			api: "openai-responses",
			provider: "openai",
			model: "m",
			usage,
			stopReason: "toolUse",
			timestamp: 1_100,
		} satisfies AssistantMessage;
		const result = {
			role: "toolResult",
			toolCallId: id,
			toolName: kind,
			content: [{ type: "text", text }],
			...(kind === "ipython" ? { details: { status: "ok", durationMs: 5, stdout: text } } : {}),
			isError: false,
			timestamp: 1_200,
		} satisfies ToolResultMessage;
		return [{ role: "user", content: "count", timestamp: 1_000 }, call, result];
	}

	function rebuildRig(messages: AgentMessage[]): Rig {
		const rig = createRig("legacy");
		Object.assign(rig.mode, {
			agentConnection: { getSessionContext: async () => ({ messages, thinkingLevel: "medium", model: null }) },
			preloadToolDefinitions: async () => {},
			getCachedToolDefinition: () => undefined,
			getCurrentCwd: () => "/tmp",
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			defaultHiddenThinkingLabel: "Thinking...",
			connectionState: { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0 },
			footer: { invalidate: () => {} },
			updateEditorBorderColor: () => {},
			addMessageToChat: () => {},
			showError: () => {},
		});
		return rig;
	}

	it("forgets what the old block held back, so a rebuild around short output says nothing is held back", async () => {
		const rig = rebuildRig(transcript("short-run", 3));
		rig.chat.addChild(build("old-long"));
		openLongOutput(rig);
		expect(anyBudgetTruncatable()).toBe(true);

		await call(rig, "rebuildChatFromMessages");

		expect(rig.chat.children.some((child) => child instanceof ToolExecutionComponent)).toBe(true);
		expect(rig.render()).toContain("short-run-line-002");
		expect(anyBudgetTruncatable()).toBe(false);
		rig.press(ALT_SHIFT_O);
		expect(rig.toasts).toEqual([NOTHING_HELD_BACK]);
	});

	it("lets the rebuilt block report for itself, so the key still lifts the budget on it", async () => {
		const rig = rebuildRig(transcript("long-run", LONG_OUTPUT_LINES));
		rig.chat.addChild(build("old-long"));
		openLongOutput(rig);
		expect(anyBudgetTruncatable()).toBe(true);

		await call(rig, "rebuildChatFromMessages");
		expect(rig.render()).not.toContain("long-run-line-159");
		expect(anyBudgetTruncatable()).toBe(true);

		rig.press(ALT_SHIFT_O);

		expect(rig.toasts).toEqual([]);
		expect(toolOutputFull()).toBe(true);
		expect(rig.render()).toContain("long-run-line-159");
	});
});
