import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The quiet conversation's live path, driven through the interactive mode's
 * own event handler: one prompt makes one box, an interjection is a row in
 * it, the run's end settles into the finished face with the change strip
 * under the answer, and a retry or a compaction carries the same box on.
 */

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type HandleEvent = (this: LiveMode, event: AgentConnectionSessionEvent) => Promise<void>;
const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
/** Escape while the AI works: the interactive mode's own interrupt. */
const interrupt = (InteractiveMode.prototype as unknown as { interruptOrClearInput(this: LiveMode): void })
	.interruptOrClearInput;

interface LiveMode {
	chatContainer: Container;
	connectionState: { isStreaming: boolean; contextUsage?: { tokens: number; contextWindow: number } };
}

function createLiveMode(): LiveMode {
	const chatContainer = new Container();
	const mode = {
		isInitialized: true,
		settingsManager: {
			getShowTerminalProgress: () => false,
			getProcessMode: () => "quiet" as const,
			getShowImages: () => false,
		},
		connectionState: { isStreaming: false },
		toolOutputExpanded: false,
		footer: { invalidate: vi.fn() },
		activityTracker: new AgentActivityTracker(),
		ui: {
			requestRender: vi.fn(),
			isFullscreen: () => false,
			requestRenderPreservingViewport: vi.fn(),
			terminal: { rows: 40, columns: 100 },
		} as unknown as TUI,
		chatContainer,
		recapContainer: new Container(),
		statusContainer: new Container(),
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingTools: new Map<string, ToolExecutionComponent>(),
		pendingToolCreations: new Set<string>(),
		startedToolCalls: new Set<string>(),
		agentRunFileChanges: new Map(),
		consecutiveToolErrors: 0,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		workingVisible: false,
		updateConnectionStateFromEvent: vi.fn(),
		getRetryAttempt: () => 0,
		getCurrentCwd: () => "/work/app",
		resetPendingToolState: vi.fn(),
		renderRecap: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		stopWorkingLoader: vi.fn(),
		startWorkingLoader: vi.fn(),
		syncWorkingLoader: vi.fn(),
		updateWorkingLoaderMessage: vi.fn(),
		updateWorkingPulse: vi.fn(),
		noticeImageModelServing: vi.fn(),
		startAssistantStreamingMessage: vi.fn(),
		ensureAssistantStreamingComponent: () => ({ updateContent: vi.fn() }),
		getOrCreatePendingToolComponent: vi.fn(async () => undefined),
		scheduleSubagentSpendRefresh: vi.fn(),
		recordSpeedSample: vi.fn(),
		invalidateFooterTelemetry: vi.fn(),
		settleStallActionBar: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		applyOptimisticContextUsage: vi.fn(),
		refreshConnectionContextUsage: vi.fn(async () => {}),
		refreshServingModel: vi.fn(async () => {}),
		checkShutdownRequested: vi.fn(async () => {}),
		startCompactionLoader: vi.fn(),
		rebuildChatFromMessages: vi.fn(async () => {}),
		showError: vi.fn(),
		showStatus: vi.fn(),
		clearShortcutGuide: vi.fn(),
		agentConnection: { abortAndSendQueued: vi.fn(async () => ({})) },
		addMessageToChat: (message: AgentMessage) => {
			if (message.role === "user") {
				const content = message.content;
				chatContainer.addChild(new UserMessageComponent(typeof content === "string" ? content : ""));
			}
		},
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return mode;
}

let clock = 1_700_000_000_000;
const tick = (ms = 1_000) => {
	clock += ms;
	vi.setSystemTime(clock);
	return clock;
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: EMPTY_USAGE,
		stopReason,
		timestamp: tick(),
	};
}

async function userTurn(mode: LiveMode, text: string): Promise<void> {
	await handleEvent.call(mode, {
		type: "message_start",
		message: { role: "user", content: text, timestamp: tick() },
	} as AgentConnectionSessionEvent);
}

async function assistantMessage(mode: LiveMode, message: AssistantMessage): Promise<void> {
	await handleEvent.call(mode, { type: "message_start", message } as AgentConnectionSessionEvent);
	await handleEvent.call(mode, { type: "message_end", message } as AgentConnectionSessionEvent);
}

async function bashStep(mode: LiveMode, id: string, command: string, output: string): Promise<void> {
	await assistantMessage(mode, assistant([{ type: "toolCall", id, name: "bash", arguments: { command } }], "toolUse"));
	await handleEvent.call(mode, {
		type: "tool_execution_start",
		toolCallId: id,
		toolName: "bash",
		args: { command },
	} as AgentConnectionSessionEvent);
	tick();
	await handleEvent.call(mode, {
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "bash",
		result: { content: [{ type: "text", text: output }], details: undefined },
		isError: false,
	} as AgentConnectionSessionEvent);
}

async function endRun(mode: LiveMode): Promise<void> {
	mode.connectionState.isStreaming = false;
	await handleEvent.call(mode, { type: "agent_end", messages: [] } as AgentConnectionSessionEvent);
}

const boxes = (mode: LiveMode) =>
	mode.chatContainer.children.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);
const screen = (mode: LiveMode) => stripAnsi(mode.chatContainer.render(100).join("\n"));

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

describe("a quiet turn, live", () => {
	it("keeps one box per prompt, puts an interjection in it, and settles into the finished face with the strip", async () => {
		vi.useFakeTimers({ now: clock });
		setMotionReduced(true);
		const mode = createLiveMode();
		mode.connectionState.isStreaming = true;
		await handleEvent.call(mode, { type: "agent_start" } as AgentConnectionSessionEvent);
		await userTurn(mode, "修一下测试");
		await bashStep(mode, "call-1", "npm test", "54 passed");
		// Typed while the AI is between steps: a row in the same box.
		await userTurn(mode, "顺便看下 lint");
		await bashStep(mode, "call-2", "npm run lint", "ok");
		await assistantMessage(mode, assistant([{ type: "text", text: "测试和 lint 都过了。" }], "stop"));

		expect(boxes(mode)).toHaveLength(1);
		expect(mode.chatContainer.children.filter((child) => child instanceof UserMessageComponent)).toHaveLength(1);
		const live = screen(mode);
		expect(live).toContain("› 你插话：顺便看下 lint");
		expect(live).toMatch(/npm test/);
		expect(live).toMatch(/npm run lint/);

		await endRun(mode);
		// The settle: the box keeps its live face for a moment (a retry may still come).
		expect(boxes(mode)[0]!.state.timeline.finishedAt).toBeUndefined();
		vi.advanceTimersByTime(450);
		const box = boxes(mode)[0]!;
		expect(box.state.timeline.finishedAt).toBeDefined();
		// Opened only because of the setting: it folds away at the end.
		expect(box.state.boxOpen).toBe(false);
		const done = screen(mode);
		expect(done).toMatch(/▸ ✓ .*跑了 2 条命令/);
		expect(done).not.toContain("你插话");
		// The strip lands at the chat's end, under the answer.
		expect(mode.chatContainer.children.at(-1)).toBeInstanceOf(TurnStripComponent);
	});

	it("reopens the same box for a retry and for a compaction's continuation", async () => {
		vi.useFakeTimers({ now: clock });
		setMotionReduced(true);
		const mode = createLiveMode();
		mode.connectionState.isStreaming = true;
		await handleEvent.call(mode, { type: "agent_start" } as AgentConnectionSessionEvent);
		await userTurn(mode, "跑一遍构建");
		await bashStep(mode, "call-1", "npm run build", "done");
		await assistantMessage(mode, {
			...assistant([], "error"),
			errorMessage: "503 upstream overloaded",
		});
		await endRun(mode);

		// The retry arrives inside the settle: the box goes live again with a countdown row.
		await handleEvent.call(mode, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 5_000,
			errorMessage: "503 upstream overloaded",
		} as AgentConnectionSessionEvent);
		vi.advanceTimersByTime(450);
		expect(boxes(mode)).toHaveLength(1);
		const box = boxes(mode)[0]!;
		expect(box.state.boxLive).toBe(true);
		expect(screen(mode)).toContain("↻");

		mode.connectionState.isStreaming = true;
		await handleEvent.call(mode, { type: "agent_start" } as AgentConnectionSessionEvent);
		await handleEvent.call(mode, {
			type: "auto_retry_end",
			success: true,
			attempt: 1,
		} as AgentConnectionSessionEvent);
		await bashStep(mode, "call-2", "npm run build", "done");
		await assistantMessage(mode, assistant([{ type: "text", text: "构建好了。" }], "stop"));
		await endRun(mode);

		// An automatic compaction right after: a row in the same box, which waits for it.
		mode.connectionState.contextUsage = { tokens: 182_000, contextWindow: 200_000 };
		await handleEvent.call(mode, { type: "compaction_start", reason: "threshold" } as AgentConnectionSessionEvent);
		vi.advanceTimersByTime(450);
		expect(box.state.timeline.finishedAt).toBeUndefined();
		mode.connectionState.contextUsage = { tokens: 41_000, contextWindow: 200_000 };
		await handleEvent.call(mode, {
			type: "compaction_end",
			reason: "threshold",
			aborted: false,
			willRetry: false,
			result: { summary: "s", firstKeptEntryId: "e", tokensBefore: 182_000, details: {} },
		} as AgentConnectionSessionEvent);
		vi.advanceTimersByTime(450);

		expect(boxes(mode)).toHaveLength(1);
		expect(box.state.timeline.finishedAt).toBeDefined();
		box.toggleBox();
		const opened = screen(mode);
		expect(opened).toContain("⇣ 整理完成：182k → 41k tokens");
		expect(opened).toMatch(/↻/);
	});
	it("keeps a message taken at a step boundary in the same box, and a turn the owner stops ends stopped", async () => {
		vi.useFakeTimers({ now: clock });
		setMotionReduced(true);
		const mode = createLiveMode();
		mode.connectionState.isStreaming = true;
		await handleEvent.call(mode, { type: "agent_start" } as AgentConnectionSessionEvent);
		await userTurn(mode, "跑一下慢检查");
		await bashStep(mode, "call-1", "npm run check-slow", "ok");
		// The run stops after the step to take the queued message, then goes on with it.
		await endRun(mode);
		mode.connectionState.isStreaming = true;
		await handleEvent.call(mode, { type: "agent_start" } as AgentConnectionSessionEvent);
		await userTurn(mode, "顺便把 lint 也跑了");
		await assistantMessage(
			mode,
			assistant(
				[{ type: "toolCall", id: "call-2", name: "bash", arguments: { command: "npm run lint" } }],
				"toolUse",
			),
		);
		expect(boxes(mode)).toHaveLength(1);
		expect(mode.chatContainer.children.filter((child) => child instanceof UserMessageComponent)).toHaveLength(1);
		expect(screen(mode)).toContain("› 你插话：顺便把 lint 也跑了");

		// Escape mid-step: the box ends stopped, and the next prompt is a new turn.
		interrupt.call(mode);
		await endRun(mode);
		vi.advanceTimersByTime(450);
		expect(screen(mode)).toContain("■ 已停止");
		mode.connectionState.isStreaming = true;
		await handleEvent.call(mode, { type: "agent_start" } as AgentConnectionSessionEvent);
		await userTurn(mode, "算了，先看测试");
		await assistantMessage(mode, assistant([{ type: "text", text: "好。" }], "stop"));
		expect(boxes(mode)).toHaveLength(2);
		expect(screen(mode)).not.toContain("你插话：算了");
	});
});
