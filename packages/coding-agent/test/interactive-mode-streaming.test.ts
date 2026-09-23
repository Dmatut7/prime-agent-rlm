import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, type MarkdownTheme, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import type { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import type { FileChangeSummary } from "../src/modes/interactive/components/edit-summary.js";
import { FooterComponent } from "../src/modes/interactive/components/footer.js";
import { createMermaidMarkdownTransform } from "../src/modes/interactive/components/mermaid.js";
import {
	type SubagentSummaryCounts,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type HandleEventThis = {
	isInitialized: boolean;
	settingsManager: { getShowTerminalProgress(): boolean; getProcessMode(): "quiet" | "legacy" };
	connectionState: { isStreaming: boolean };
	toolOutputExpanded: boolean;
	footer: { invalidate(): void };
	ui: TUI;
	chatContainer: Container;
	recapContainer: Container;
	sessionRecap: string | undefined;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: AssistantMessage | undefined;
	pendingTools: Map<string, ToolExecutionComponent>;
	agentRunFileChanges: Map<string, FileChangeSummary>;
	subagentCounts: SubagentSummaryCounts;
	subagentSummaryLine: SubagentSummaryLine;
	updateConnectionStateFromEvent(event: AgentConnectionSessionEvent): void;
	getMarkdownThemeWithSettings(): MarkdownTheme;
	getOrCreatePendingToolComponent(): Promise<ToolExecutionComponent | undefined>;
	getRetryAttempt(): number;
	getCurrentCwd(): string;
	stopWorkingLoader(): void;
	resetPendingToolState(): void;
	checkShutdownRequested(): Promise<void>;
	applyOptimisticContextUsage(): void;
	refreshConnectionContextUsage(): Promise<void>;
	clearShortcutGuide(): void;
	addMessageToChat(): void;
};

type HandleEvent = (this: HandleEventThis, event: AgentConnectionSessionEvent) => Promise<void>;
type GetUserInput = (this: {
	agentsViewRequest?: "agents_view" | "scoped_agents_view";
	onInputCallback?: (text: string | undefined) => void;
}) => Promise<string | undefined>;
type HandleSubagentSummaryChatAction = (
	this: {
		keybindings: { matches(data: string, action: string): boolean };
		editor: { handleInput(data: string): void };
		focusEditor(): void;
		toggleToolOutputExpansion(): void;
		toggleThinkingBlockVisibility(): void;
	},
	data: string,
) => void;

function createFakeInteractiveModeThis(): HandleEventThis {
	const fakeThis = {
		isInitialized: true,
		settingsManager: { getShowTerminalProgress: () => false, getProcessMode: () => "quiet" as const },
		// message_end/agent_end feed the subagent spend cell; with zero children the
		// schedule path clears the cell and never arms a timer.
		subagentCounts: { total: 0, running: 0, idle: 0, inactive: 0 } satisfies SubagentSummaryCounts,
		subagentSummaryLine: new SubagentSummaryLine(),
		connectionState: { isStreaming: false },
		toolOutputExpanded: false,
		footer: { invalidate: vi.fn() },
		activityTracker: new AgentActivityTracker(),
		ui: { requestRender: vi.fn() } as unknown as TUI,
		chatContainer: new Container(),
		recapContainer: new Container(),
		sessionRecap: "Updated files",
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		streamingComponent: undefined,
		streamingMessage: undefined,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		pendingTools: new Map<string, ToolExecutionComponent>(),
		agentRunFileChanges: new Map<string, FileChangeSummary>(),
		updateConnectionStateFromEvent: vi.fn(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getOrCreatePendingToolComponent: vi.fn(async () => undefined),
		getRetryAttempt: () => 0,
		getCurrentCwd: () => "/tmp",
		stopWorkingLoader: vi.fn(),
		resetPendingToolState: vi.fn(),
		checkShutdownRequested: vi.fn(async () => {}),
		applyOptimisticContextUsage: vi.fn(),
		refreshConnectionContextUsage: vi.fn(async () => {}),
		clearShortcutGuide: vi.fn(),
		addMessageToChat: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);
	return fakeThis;
}

function createAssistantMessage(text: string, usage: Usage = EMPTY_USAGE): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode streaming events", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders assistant updates when attaching after message_start", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage("partial response"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial response",
				partial: createAssistantMessage("partial response"),
			},
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("partial response");

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage("final response"),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("final response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("drops the unmatched streaming bubble when the next message_start arrives", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const droppedAttempt: AssistantMessage = {
			...createAssistantMessage(""),
			content: [{ type: "thinking", thinking: "pondering the discarded turn" }],
		};

		// An empty-turn retry emits a fresh message_start per attempt and no message_end
		// for the dropped one. That message was popped and never persisted, so settling
		// it here would leave a bubble that /resume does not show.
		await handleEvent.call(fakeThis, { type: "message_start", message: droppedAttempt });
		// U6: the turn's aggregate line rides at the turn head and carries the live
		// thinking count; the dropped attempt's thinking text itself never renders.
		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderChat(fakeThis.chatContainer)).toContain("思考");
		expect(renderChat(fakeThis.chatContainer)).not.toContain("pondering the discarded turn");

		await handleEvent.call(fakeThis, {
			type: "message_start",
			message: createAssistantMessage("second attempt"),
		});

		expect(fakeThis.chatContainer.children).toHaveLength(2);
		expect(renderChat(fakeThis.chatContainer)).not.toContain("pondering the discarded turn");
		// The replaced live message has no thinking: the count resets with it.
		expect(renderChat(fakeThis.chatContainer)).not.toContain("思考");
	});

	test("renders assistant end events when attaching after all updates", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage("final response"),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("final response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("does not block later compaction events on the agent-end stats refresh", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		let resolveRefresh!: () => void;
		fakeThis.refreshConnectionContextUsage = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveRefresh = resolve;
				}),
		);
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await expect(handleEvent.call(fakeThis, { type: "agent_end", messages: [] })).resolves.toBeUndefined();
		expect(fakeThis.refreshConnectionContextUsage).toHaveBeenCalledOnce();
		resolveRefresh();
	});

	test("keeps attached partial assistant text when agent_end arrives without message_end", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage("partial response"),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "partial response",
				partial: createAssistantMessage("partial response"),
			},
		});
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });

		expect(renderChat(fakeThis.chatContainer)).toContain("partial response");
		expect(fakeThis.streamingComponent).toBeUndefined();
		expect(fakeThis.streamingMessage).toBeUndefined();
	});

	test("defers mermaid rendering to message_end in final mode", async () => {
		const fakeThis = createFakeInteractiveModeThis() as HandleEventThis & {
			mermaidMarkdownTransform?: ReturnType<typeof createMermaidMarkdownTransform>;
		};
		fakeThis.mermaidMarkdownTransform = createMermaidMarkdownTransform({ getMode: () => "final" });
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const mermaidText = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: createAssistantMessage(mermaidText),
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: mermaidText,
				partial: createAssistantMessage(mermaidText),
			},
		});

		expect(renderChat(fakeThis.chatContainer)).not.toContain("───▶");

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: createAssistantMessage(mermaidText),
		});

		expect(renderChat(fakeThis.chatContainer)).toContain("───▶");
	});

	test("renders one agent-run edit total only when files changed", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		const message = createAssistantMessage("");
		message.content = [{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts" } }];

		await handleEvent.call(fakeThis, {
			type: "turn_end",
			message,
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "edit-1",
					toolName: "edit",
					content: [],
					details: { diff: "-1 old\n+1 new" },
					isError: false,
					timestamp: 0,
				},
			],
		});
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });
		const recap = renderChat(fakeThis.recapContainer);
		expect(recap).toContain("Recap: Updated files");
		expect(recap).toContain("1 file changed | +1 -1");
		expect(recap.indexOf("1 file changed")).toBeLessThan(recap.indexOf("Recap:"));
		expect(renderChat(fakeThis.chatContainer)).not.toContain("file changed");

		const unchanged = createFakeInteractiveModeThis();
		await handleEvent.call(unchanged, { type: "agent_end", messages: [] });
		expect(renderChat(unchanged.recapContainer)).not.toContain("file changed");
	});

	test("keeps edit totals across automatic retries", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.agentRunFileChanges.set("/tmp/a.ts", { path: "a.ts", added: 1, removed: 1 });
		fakeThis.getRetryAttempt = () => 1;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, { type: "agent_start" });

		expect([...fakeThis.agentRunFileChanges.values()]).toEqual([{ path: "a.ts", added: 1, removed: 1 }]);
	});

	test("keeps edit totals when compaction restarts the agent", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.agentRunFileChanges.set("/tmp/a.ts", { path: "a.ts", added: 1, removed: 1 });
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeThis, { type: "agent_start" });

		expect([...fakeThis.agentRunFileChanges.values()]).toEqual([{ path: "a.ts", added: 1, removed: 1 }]);
	});

	test("clears edit totals when a new user prompt starts", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		fakeThis.agentRunFileChanges.set("/tmp/a.ts", { path: "a.ts", added: 1, removed: 1 });
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		await handleEvent.call(fakeThis, { type: "agent_end", messages: [] });
		expect(renderChat(fakeThis.recapContainer)).toContain("1 file changed");

		await handleEvent.call(fakeThis, {
			type: "message_start",
			message: { role: "user", content: "next task", timestamp: Date.now() },
		});

		expect(fakeThis.agentRunFileChanges.size).toBe(0);
		expect(renderChat(fakeThis.recapContainer)).not.toContain("file changed");
		expect(renderChat(fakeThis.recapContainer)).toContain("Recap: Updated files");
	});

	test("resolves input immediately after return to agents view was requested", async () => {
		const getUserInput = (InteractiveMode.prototype as unknown as { getUserInput: GetUserInput }).getUserInput;

		await expect(getUserInput.call({ agentsViewRequest: "agents_view" })).resolves.toBeUndefined();
	});

	test("forwards typed keys from focused subagent summary back to the editor", () => {
		const handleSubagentSummaryChatAction = (
			InteractiveMode.prototype as unknown as { handleSubagentSummaryChatAction: HandleSubagentSummaryChatAction }
		).handleSubagentSummaryChatAction;
		const fakeThis = {
			keybindings: { matches: vi.fn(() => false) },
			editor: { handleInput: vi.fn() },
			focusEditor: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
		};

		handleSubagentSummaryChatAction.call(fakeThis, "x");

		expect(fakeThis.focusEditor).toHaveBeenCalledOnce();
		expect(fakeThis.editor.handleInput).toHaveBeenCalledWith("x");
		expect(fakeThis.toggleToolOutputExpansion).not.toHaveBeenCalled();
		expect(fakeThis.toggleThinkingBlockVisibility).not.toHaveBeenCalled();
	});

	test("keeps focused subagent summary shortcuts in the chat surface", () => {
		const handleSubagentSummaryChatAction = (
			InteractiveMode.prototype as unknown as { handleSubagentSummaryChatAction: HandleSubagentSummaryChatAction }
		).handleSubagentSummaryChatAction;
		const fakeThis = {
			keybindings: { matches: vi.fn((_data: string, action: string) => action === "app.tools.expand") },
			editor: { handleInput: vi.fn() },
			focusEditor: vi.fn(),
			toggleToolOutputExpansion: vi.fn(),
			toggleThinkingBlockVisibility: vi.fn(),
		};

		handleSubagentSummaryChatAction.call(fakeThis, "\x0f");

		expect(fakeThis.toggleToolOutputExpansion).toHaveBeenCalledOnce();
		expect(fakeThis.focusEditor).not.toHaveBeenCalled();
		expect(fakeThis.editor.handleInput).not.toHaveBeenCalled();
	});

	test("does not pulse renders for background-only subagent work", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const mode = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
			Object.assign(mode, {
				connectionState: { isStreaming: false },
				subagentSnapshots: new Map([["worker", { id: "worker", status: "running" }]]),
				pulseTimer: undefined,
				ui: { requestRender },
			});
			const updatePulse = Reflect.get(InteractiveMode.prototype, "updateWorkingPulse") as (
				this: typeof mode,
			) => void;

			updatePulse.call(mode);
			vi.advanceTimersByTime(1000);

			expect(requestRender).not.toHaveBeenCalled();
			expect(Reflect.get(mode, "pulseTimer")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	describe("speed display tok/sec tracking", () => {
		const speedLine = (footer: FooterComponent) => stripAnsi(footer.render(200).join("\n"));
		const makeSpeedThis = (enabled = true) => {
			const fakeThis = createFakeInteractiveModeThis();
			const footer = new FooterComponent({ getGitBranch: () => null } as ReadonlyFooterDataProvider);
			footer.setSpeedEnabled(enabled);
			Object.assign(fakeThis as Record<string, unknown>, { footer, speedDisplayEnabled: enabled });
			return { fakeThis, footer };
		};
		const speedPrototype = InteractiveMode.prototype as unknown as {
			handleEvent(this: Record<string, unknown>, event: AgentConnectionSessionEvent): Promise<void>;
			recordSpeedSample(this: Record<string, unknown>, message: AssistantMessage): void;
		};
		afterEach(() => vi.restoreAllMocks());
		test("records output tok/s per completed assistant message with a session average", async () => {
			const { fakeThis, footer } = makeSpeedThis();
			const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
			const first = createAssistantMessage("first", { ...EMPTY_USAGE, output: 100, totalTokens: 100 });
			now.mockReturnValue(3_000);
			await speedPrototype.handleEvent.call(fakeThis, { type: "message_end", message: first });
			expect(speedLine(footer)).toBe("50.0 tok/s");
			const second = createAssistantMessage("second", { ...EMPTY_USAGE, output: 300, totalTokens: 300 });
			now.mockReturnValue(5_500);
			await speedPrototype.handleEvent.call(fakeThis, { type: "message_end", message: second });
			expect(speedLine(footer)).toBe("120 tok/s · avg 88.9");
		});
		test.each<[string, boolean, number, number, string, Record<string, unknown>]>([
			["zero output tokens", true, 0, 2_000, "9.9 tok/s", { timestamp: 1_000 }],
			["zero duration", true, 100, 0, "9.9 tok/s", {}],
			["aborted message", true, 50, 2_000, "9.9 tok/s", { stopReason: "aborted", timestamp: 1_000 }],
			["stripped usage and timestamp", true, 100, 2_000, "9.9 tok/s", { usage: undefined, timestamp: undefined }],
			["display disabled", false, 100, 2_000, "", {}],
		])("skips the sample when %s", (_label, enabled, output, durationMs, expected, overrides) => {
			const { fakeThis, footer } = makeSpeedThis(enabled);
			footer.setSpeedText("9.9 tok/s");
			vi.spyOn(Date, "now").mockReturnValue(1_000 + durationMs);
			const message = Object.assign(createAssistantMessage("partial", { ...EMPTY_USAGE, output }), overrides);
			speedPrototype.recordSpeedSample.call(fakeThis, message);
			expect(speedLine(footer)).toBe(expected);
		});
	});
});
