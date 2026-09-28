import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { Container, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { emptyUsage } from "../src/core/usage.js";
import type {
	AgentConnectionEvent,
	AgentConnectionSessionContext,
	AgentConnectionSessionEvent,
	AgentConnectionSnapshot,
	AgentConnectionState,
} from "../src/modes/agent-connection/types.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The quiet turn box's lifecycle as the interactive mode drives it: the status
 * bar after a failed turn, a connection that closes mid-run, attaching to a
 * running session, and reopening a session whose last turn is longer than the
 * reopen window or ended on a stop. Events go through the mode's own event
 * queue (subscribeToAgent) into a real chat.
 */

type Listener = (event: AgentConnectionEvent) => Promise<void>;

const mode = InteractiveMode.prototype as unknown as {
	subscribeToAgent(this: object): void;
	statusBarRight(this: object): string[];
	renderCurrentSessionState(this: object): Promise<void>;
	renderSessionContext(
		this: object,
		context: AgentConnectionSessionContext,
		options?: { clearChat?: boolean; limitTranscript?: boolean },
	): Promise<void>;
};

function connectionState(overrides: Partial<AgentConnectionState> = {}): AgentConnectionState {
	return {
		activeSessionId: "active-1",
		cwd: "/work/app",
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
		pendingMessageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	} as AgentConnectionState;
}

interface Screen {
	/** The fake the prototype methods run on. */
	host: {
		chatContainer: Container;
		connectionState: AgentConnectionState;
	};
	errors: string[];
	send(event: AgentConnectionSessionEvent): Promise<void>;
	connection(event: AgentConnectionEvent): Promise<void>;
	statusRight(): string;
	boxes(): TurnSummaryComponent[];
	prompts(): string[];
}

/**
 * An interactive mode over a real chat and the real event queue; everything
 * outside the chat and the status bar is a no-op.
 */
function createScreen(
	options: { snapshot?: AgentConnectionSnapshot; getToolDefinition?: () => Promise<undefined> } = {},
): Screen {
	const chatContainer = new Container();
	const errors: string[] = [];
	let listener: Listener | undefined;
	const noop = () => {};
	const host = {
		isInitialized: true,
		options: {},
		editor: {},
		chatContainer,
		recapContainer: new Container(),
		statusContainer: new Container(),
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingTools: new Map(),
		pendingToolCreations: new Set(),
		startedToolCalls: new Set(),
		pendingToolGeneration: 0,
		ipythonToolComponents: new Map(),
		lateIpythonSentAgentMessages: new Map(),
		toolDefinitionCache: new Map(),
		agentRunFileChanges: new Map(),
		consecutiveToolErrors: 0,
		processBlockOpenOrder: [],
		toolOutputExpanded: false,
		agentMessagesExpanded: false,
		editDiffsExpanded: false,
		thinkingExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		defaultHiddenThinkingLabel: "Thinking...",
		sessionEventQueue: Promise.resolve(),
		sessionEventGeneration: 0,
		chatTranscriptTrimmed: false,
		chatCapRebuildFloor: 0,
		chatCapRebuildInFlight: false,
		connectionState: connectionState(),
		settingsManager: {
			getShowTerminalProgress: () => false,
			getProcessMode: () => "quiet" as const,
			getShowImages: () => false,
			getSubagentSpendCellEnabled: () => false,
		},
		footer: { invalidate: noop, setToolErrorCount: noop, setAutoCompactEnabled: noop },
		activityTracker: new AgentActivityTracker(),
		ui: {
			requestRender: noop,
			requestRenderPreservingViewport: noop,
			isFullscreen: () => false,
			isFullscreenReviewing: () => false,
			terminal: { rows: 40, columns: 100, setProgress: noop },
		},
		subagentSnapshots: new Map(),
		seenSubagentFailureIds: new Set(),
		subagentSummaryLine: new SubagentSummaryLine(),
		subagentCounts: { total: 0, running: 0, idle: 0, inactive: 0 },
		footerDataProvider: { getGitBranch: () => undefined },
		agentConnection: {
			subscribe(next: Listener) {
				listener = next;
				return noop;
			},
			getToolDefinition: options.getToolDefinition ?? (async () => undefined),
			getInitialSnapshot: async () => options.snapshot,
			abortRetry: async () => {},
		},
		getCurrentCwd: () => "/work/app",
		getMarkdownThemeWithSettings: () => undefined,
		updateConnectionStateFromEvent: noop,
		resetCurrentSessionRenderState: noop,
		seedSubagentSummary: noop,
		applyConnectionStateSnapshot(state: AgentConnectionState) {
			host.connectionState = state;
		},
		restoreTurnStartFromMessages: noop,
		restoreStreamingMessageFromSnapshot: async () => {},
		showDutyLog: async () => {},
		renderRecap: noop,
		updatePendingMessagesDisplay: noop,
		syncWorkingLoader: noop,
		stopWorkingLoader: noop,
		startWorkingLoader: noop,
		updateWorkingLoaderMessage: noop,
		updateWorkingPulse: noop,
		noticeImageModelServing: noop,
		scheduleSubagentSpendRefresh: noop,
		scheduleHeartbeatManagerRefresh: noop,
		syncSubagentSpendCell: noop,
		recordSpeedSample: noop,
		invalidateFooterTelemetry: noop,
		settleStallActionBar: noop,
		flushPendingBashComponents: noop,
		applyOptimisticContextUsage: noop,
		refreshConnectionContextUsage: async () => {},
		refreshServingModel: async () => {},
		checkShutdownRequested: async () => {},
		enforceChatComponentCap: async () => {},
		resetBlockNavigation: noop,
		addMessageToEditorHistory: noop,
		clearShortcutGuide: noop,
		noteSubagentFailureSeen: noop,
		handleTurnLanesClicked: noop,
		showStatus: noop,
		showWarning: noop,
		showError: (message: string) => {
			errors.push(message);
		},
		addMessageToChat: (message: AgentMessage) => {
			if (message.role === "user") {
				const text = typeof message.content === "string" ? message.content : "";
				chatContainer.addChild(new UserMessageComponent(text));
			}
		},
	};
	Object.setPrototypeOf(host, InteractiveMode.prototype);
	mode.subscribeToAgent.call(host);
	const deliver = (event: AgentConnectionEvent): Promise<void> => {
		if (!listener) throw new Error("not subscribed");
		return listener(event);
	};
	return {
		host,
		errors,
		send: (event) => deliver({ type: "session_event", event }),
		connection: deliver,
		statusRight: () => stripAnsi(mode.statusBarRight.call(host)[0] ?? ""),
		boxes: () =>
			chatContainer.children.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent),
		prompts: () =>
			chatContainer.children
				.filter((child) => child instanceof UserMessageComponent)
				.map((child) => stripAnsi(child.render(100).join("\n")).trim().split("\n").at(-1)?.trim() ?? ""),
	};
}

const T0 = 1_700_000_000_000;

function assistant(
	at: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
	extra: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: { ...emptyUsage(), output: 40, totalTokens: 40 },
		stopReason,
		timestamp: at,
		...extra,
	};
}

function bashCall(id: string, command: string, at: number): AssistantMessage {
	return assistant(at, [{ type: "toolCall", id, name: "bash", arguments: { command } }]);
}

function result(id: string, at: number, text: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: at,
		...extra,
	};
}

function user(text: string, at: number): AgentMessage {
	return { role: "user", content: text, timestamp: at };
}

/** A box's text with its body open (a finished box folds up), scrolled to its first row when asked. */
function opened(box: TurnSummaryComponent, options: { top?: boolean } = {}): string {
	if (!box.state.boxOpen) box.toggleBox();
	const text = stripAnsi(box.render(100).join("\n"));
	if (!options.top) return text;
	box.state.timeline.ui.scrollBody(-1_000_000);
	return stripAnsi(box.render(100).join("\n"));
}

/** A live run: the prompt, one command started. */
async function startRun(screen: Screen, command: string): Promise<void> {
	screen.host.connectionState = { ...screen.host.connectionState, isStreaming: true };
	await screen.send({ type: "agent_start" });
	await screen.send({ type: "message_start", message: user("跑一下", T0) });
	const call = bashCall("call-1", command, T0 + 1_000);
	await screen.send({ type: "message_start", message: call });
	await screen.send({ type: "message_end", message: call });
	await screen.send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command } });
}

async function endRun(screen: Screen): Promise<void> {
	screen.host.connectionState = { ...screen.host.connectionState, isStreaming: false };
	await screen.send({ type: "agent_end", messages: [] });
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
});

afterEach(() => {
	vi.useRealTimers();
	setMotionReduced(false);
});

function useClock(): void {
	vi.useFakeTimers({ now: T0 });
}

describe("the status bar after a turn", () => {
	it("says a turn that ended on an error failed, not done", async () => {
		useClock();
		const screen = createScreen();
		await startRun(screen, "npm test");
		await screen.send({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		const failed = assistant(T0 + 3_000, [{ type: "text", text: "" }], "error", {
			errorMessage: "503 upstream overloaded",
		});
		await screen.send({ type: "message_start", message: failed });
		await screen.send({ type: "message_end", message: failed });
		await endRun(screen);
		vi.advanceTimersByTime(450);

		expect(screen.boxes()[0]?.state.boxLive).toBe(false);
		expect(screen.statusRight()).toMatch(/^✗ 出错/);
		expect(screen.statusRight()).not.toContain("完成");
	});

	it("still says done after a turn that finished well", async () => {
		useClock();
		const screen = createScreen();
		await startRun(screen, "npm test");
		await screen.send({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		const answer = assistant(T0 + 3_000, [{ type: "text", text: "都过了。" }], "stop");
		await screen.send({ type: "message_start", message: answer });
		await screen.send({ type: "message_end", message: answer });
		await endRun(screen);
		vi.advanceTimersByTime(450);

		expect(screen.statusRight()).toMatch(/^✓ 完成/);
	});
});

describe("a connection that closes mid-run", () => {
	it("stops the working face, finishes the live box and says the connection was lost", async () => {
		useClock();
		const screen = createScreen();
		await startRun(screen, "npm run e2e");
		expect(screen.statusRight()).toContain("工作中");

		await screen.connection({ type: "closed", error: "Daemon reconnection failed: socket hang up" });
		vi.advanceTimersByTime(450);

		expect(screen.statusRight()).not.toContain("工作中");
		expect(screen.statusRight()).toContain("和后台的连接断了");
		const box = screen.boxes()[0]!;
		expect(box.state.boxLive).toBe(false);
		const text = opened(box);
		expect(text).toContain("和后台的连接断了，这一轮后面的进展收不到");
		expect(text).not.toMatch(/⠋|正在运行/);
		expect(screen.errors.some((error) => error.includes("和后台的连接断了"))).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("attaching to a running session", () => {
	it("keeps a step result that lands while the first replay waits on its requests", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let markAsked!: () => void;
		const asked = new Promise<void>((resolve) => {
			markAsked = resolve;
		});
		const screen = createScreen({
			snapshot: {
				state: connectionState({ isStreaming: true }),
				messages: [user("正在跑的一轮", T0), bashCall("live-1", "sleep 5", T0 + 1_000)],
			},
			getToolDefinition: async () => {
				markAsked();
				await gate;
				return undefined;
			},
		});

		const replay = mode.renderCurrentSessionState.call(screen.host);
		await asked;
		// The step finishes while the replay still waits for its tool's definition.
		const delivered = screen.send({
			type: "tool_execution_end",
			toolCallId: "live-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "slept" }] },
			isError: false,
		});
		release();
		await replay;
		await delivered;

		const box = screen.boxes()[0]!;
		expect(screen.boxes()).toHaveLength(1);
		expect(box.state.steps.map((step) => [step.toolCallId, step.status])).toEqual([["live-1", "done"]]);
		expect(opened(box)).toContain("sleep 5");
		expect(opened(box)).not.toContain("正在运行 sleep 5");
	});
});

describe("reopening a session", () => {
	/** One turn of `steps` commands, one second apart, then its answer. */
	function longTurn(steps: number, prompt = "一轮超长任务", start = T0): AgentMessage[] {
		const messages: AgentMessage[] = [user(prompt, start)];
		let at = start + 1_000;
		for (let index = 0; index < steps; index++) {
			messages.push(bashCall(`${prompt}-${index}`, `step ${index}`, at));
			messages.push(result(`${prompt}-${index}`, at + 500, `done ${index}`));
			at += 1_000;
		}
		messages.push(assistant(at, [{ type: "text", text: "全部做完了。" }], "stop"));
		return messages;
	}

	const clockOf = (box: TurnSummaryComponent) => /\d+分\d+秒|\d+秒/.exec(stripAnsi(box.render(120).join("\n")))?.[0];

	it("keeps a long turn's prompt, clock and step count when the window starts inside it", async () => {
		const messages = longTurn(250);
		const full = createScreen();
		await mode.renderSessionContext.call(
			full.host,
			{ messages, thinkingLevel: "medium", serviceTier: "default", model: null },
			{ clearChat: true },
		);
		const windowed = createScreen();
		await mode.renderSessionContext.call(
			windowed.host,
			{ messages, thinkingLevel: "medium", serviceTier: "default", model: null },
			{ clearChat: true, limitTranscript: true },
		);

		expect(windowed.boxes()).toHaveLength(1);
		const box = windowed.boxes()[0]!;
		expect(windowed.prompts()).toEqual(["一轮超长任务"]);
		expect(clockOf(box)).toBeDefined();
		expect(clockOf(box)).toBe(clockOf(full.boxes()[0]!));
		const shown = box.state.steps.length;
		expect(shown).toBeLessThan(250);
		expect(opened(box, { top: true })).toContain(`… 更早的 ${250 - shown} 步没列出`);
	});

	it("says nothing extra when the window starts at a prompt", async () => {
		// A short turn, then one of exactly the window's size.
		const messages = [...longTurn(0, "先问一句"), ...longTurn(199, "再做一件事", T0 + 10_000)];
		const windowed = createScreen();
		await mode.renderSessionContext.call(
			windowed.host,
			{ messages, thinkingLevel: "medium", serviceTier: "default", model: null },
			{ clearChat: true, limitTranscript: true },
		);
		expect(messages.length).toBe(402);
		expect(windowed.prompts()).toEqual(["再做一件事"]);
		expect(windowed.boxes()).toHaveLength(1);
		expect(opened(windowed.boxes()[0]!)).not.toContain("没列出");
	});

	it("shows a turn the owner stopped mid-command as stopped, as it looked live", async () => {
		const screen = createScreen();
		await mode.renderSessionContext.call(
			screen.host,
			{
				messages: [
					user("慢慢跑", T0),
					bashCall("slow", "sleep 100", T0 + 1_000),
					result("slow", T0 + 2_000, "Tool execution aborted", { isError: true }),
				],
				thinkingLevel: "medium",
				serviceTier: "default",
				model: null,
			},
			{ clearChat: true },
		);
		const box = screen.boxes()[0]!;
		const text = opened(box);
		expect(text).toContain("■ 已停止");
		expect(text).toContain("■ sleep 100 · 你停下了");
		expect(text).not.toMatch(/出错|✗/);
	});

	it("keeps a message typed during a cut-off step as a row of the same turn, as live", async () => {
		const screen = createScreen();
		await mode.renderSessionContext.call(
			screen.host,
			{
				messages: [
					user("跑一下 e2e", T0),
					bashCall("e2e", "npm run e2e", T0 + 1_000),
					result("e2e", T0 + 3_000, "ran npm run e2e", { details: { status: "aborted" } }),
					user("失败了就只跑出错的那个", T0 + 2_000),
					bashCall("bail", "npm run e2e -- --bail", T0 + 4_000),
					result("bail", T0 + 5_000, "ran npm run e2e -- --bail"),
					assistant(T0 + 6_000, [{ type: "text", text: "e2e 过了。" }], "stop"),
				],
				thinkingLevel: "medium",
				serviceTier: "default",
				model: null,
			},
			{ clearChat: true },
		);
		expect(screen.boxes()).toHaveLength(1);
		expect(screen.prompts()).toEqual(["跑一下 e2e"]);
		expect(opened(screen.boxes()[0]!)).toContain("› 你插话：失败了就只跑出错的那个");
	});
});
