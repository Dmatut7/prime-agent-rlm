import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, type EditorTheme, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AppKeybinding, KEYBINDINGS, KeybindingsManager } from "../src/core/keybindings.js";
import {
	BUILTIN_SLASH_COMMANDS,
	builtinSlashCommandTakesArgument,
	isBuiltinSlashCommandName,
	NO_ARGUMENT_BUILTIN_SLASH_COMMANDS,
} from "../src/core/slash-commands.js";
import { emptyUsage } from "../src/core/usage.js";
import type { AgentConnectionSessionContext } from "../src/modes/agent-connection/index.js";
import { DAEMON_SLIM_ATTACH_MESSAGE_TAIL } from "../src/modes/daemon/daemon-protocol.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { formatKeyText } from "../src/modes/interactive/components/keybinding-hints.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { InteractiveMode, SLIM_TRANSCRIPT_PAGE_SIZE } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * The interactive half of the slim attach transcript (daemon protocol rev 44,
 * capability slim_attach_transcript):
 *
 * - renderSessionContext puts a marker line above the transcript when the
 *   snapshot held older history back (messagesOmitted > 0).
 * - The marker pages the previous SLIM_TRANSCRIPT_PAGE_SIZE messages in through
 *   get_messages before/limit and prepends them without rebuilding the live chat.
 * - A rebuild sourced from the full session context (rebuildChatFromMessages)
 *   clears the omission state; renderInitialMessages / renderResyncedSession
 *   seed it from their snapshots.
 *
 * Driven through the real prototype methods on a partial-mode fake, the same
 * harness pattern as interactive-mode-chat-cap.test.ts.
 */

type ModeFake = Record<string, unknown>;

type Proto = {
	renderSessionContext(
		this: ModeFake,
		context: AgentConnectionSessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean; clearChat?: boolean; limitTranscript?: boolean },
	): Promise<void>;
	loadEarlierTranscriptPage(this: ModeFake): Promise<void>;
	requestTranscriptBackfill(this: ModeFake): void;
	setupKeyHandlers(this: ModeFake): void;
	setupEditorSubmitHandler(this: ModeFake): void;
	rebuildChatFromMessages(this: ModeFake): Promise<void>;
	renderInitialMessages(this: ModeFake): Promise<void>;
	renderResyncedSession(this: ModeFake, snapshot: unknown): Promise<void>;
};

const proto = InteractiveMode.prototype as unknown as Proto;

type TurnStartProto = {
	restoreTurnStartFromMessages(this: ModeFake, messages: readonly AgentMessage[]): void;
};

const turnStartProto = InteractiveMode.prototype as unknown as TurnStartProto;

function userMessage(index: number, text?: string): Extract<AgentMessage, { role: "user" }> {
	return { role: "user", content: text ?? `user message ${index}`, timestamp: index };
}

function assistantMessage(index: number, text?: string): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [{ type: "text", text: text ?? `assistant answer ${index}` }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: index + 0.5,
	};
}

/** An assistant message whose tool call has no result in the same window (stopReason "toolUse"). */
function assistantToolCall(index: number, toolCallId: string): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name: "wait", id: toolCallId, arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp: index + 0.5,
	};
}

function toolResult(index: number, toolCallId: string, text: string): Extract<AgentMessage, { role: "toolResult" }> {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "wait",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: index + 0.75,
	};
}

/** `turns` user/assistant pairs; `label` prefixes the text so pages are told apart. */
function transcript(turns: number, label: string, offset = 0): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < turns; index++) {
		messages.push(userMessage(offset + index * 2, `${label} question ${index}`));
		messages.push(assistantMessage(offset + index * 2, `${label} answer ${index}`));
	}
	return messages;
}

function sessionContext(messages: AgentMessage[]): AgentConnectionSessionContext {
	return { messages, thinkingLevel: "medium", serviceTier: "default", model: null } as AgentConnectionSessionContext;
}

function createHarness(overrides: ModeFake = {}): ModeFake {
	const harness: ModeFake = {
		chatContainer: new Container(),
		pendingTools: new Map(),
		pendingToolCreations: new Set(),
		startedToolCalls: new Set(),
		pendingToolGeneration: 0,
		ipythonToolComponents: new Map(),
		lateIpythonSentAgentMessages: new Map(),
		toolOutputExpanded: false,
		agentMessagesExpanded: false,
		editDiffsExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		streamingComponent: undefined,
		streamingMessage: undefined,
		activeBashComponent: undefined,
		connectionState: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			retryAttempt: 0,
			sessionActions: {},
		},
		chatTranscriptTrimmed: false,
		chatCapRebuildFloor: 0,
		chatCapRebuildInFlight: false,
		slimTranscriptOmitted: 0,
		slimTranscriptBackfillInFlight: false,
		slimTranscriptMarker: undefined,
		slimTranscriptViewEpoch: 0,
		slimOrphanToolResults: new Map(),
		editor: {},
		footer: { invalidate: vi.fn() },
		settingsManager: {
			getShowImages: () => false,
			getFullscreenMouse: () => true,
			getProcessMode: () => "quiet" as const,
			getCodeBlockIndent: () => "  ",
		},
		preloadToolDefinitions: vi.fn(async () => {}),
		getCachedToolDefinition: () => undefined,
		getCurrentCwd: () => "/tmp",
		showStatus: vi.fn(),
		showError: vi.fn(),
		showToast: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		connectionCommands: [],
		seenSubagentFailureIds: new Set<string>(),
		agentConnection: {
			getMessagesWindow: vi.fn(async () => ({ messages: [], totalMessages: 0, firstIndex: 0 })),
			getSessionContext: vi.fn(async () => sessionContext([])),
		},
		ui: {
			requestRender: vi.fn(),
			requestRenderPreservingViewport: vi.fn(),
			isFullscreen: () => true,
			isFullscreenReviewing: () => false,
			scrollBy: vi.fn(),
			noteTranscriptPrepend: vi.fn(),
			terminal: { columns: 120, rows: 40 },
		},
		...overrides,
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return harness;
}

function chatText(mode: ModeFake, width = 120): string {
	return stripAnsi((mode.chatContainer as Container).render(width).join("\n"));
}

describe("slim attach transcript marker (rev 44)", () => {
	beforeAll(() => {
		initTheme("dark");
		// The marker's inline hint names the bound key through the global manager.
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("pins the backfill page size to the daemon's slim attach tail", () => {
		expect(SLIM_TRANSCRIPT_PAGE_SIZE).toBe(DAEMON_SLIM_ATTACH_MESSAGE_TAIL);
	});

	it("renders the omission marker above the transcript when the snapshot held history back", async () => {
		const mode = createHarness({ slimTranscriptOmitted: 250 });

		await proto.renderSessionContext.call(mode, sessionContext(transcript(3, "tail")), {});

		const text = chatText(mode);
		expect(text).toContain("更早的 250 条消息未加载");
		expect(text).toContain("tail question 0");
		// The marker sits above everything the tail rendered.
		expect(text.indexOf("更早的 250 条消息未加载")).toBeLessThan(text.indexOf("tail question 0"));
		expect(mode.slimTranscriptMarker).toBeDefined();
	});

	it("renders no marker when nothing was omitted", async () => {
		const mode = createHarness({ slimTranscriptOmitted: 0 });

		await proto.renderSessionContext.call(mode, sessionContext(transcript(2, "tail")), {});

		expect(chatText(mode)).not.toContain("未加载");
		expect(mode.slimTranscriptMarker).toBeUndefined();
	});

	it("truncates the marker to a narrow width without losing the count", async () => {
		const mode = createHarness({ slimTranscriptOmitted: 250 });

		await proto.renderSessionContext.call(mode, sessionContext(transcript(1, "tail")), {});

		const lines = (mode.chatContainer as Container).render(16);
		const markerLine = stripAnsi(lines[0] ?? "");
		expect(markerLine.length).toBeLessThanOrEqual(16);
		expect(markerLine).toContain("250");
	});

	it("shows the click hint only where clicks dispatch (fullscreen + mouse)", async () => {
		const clickable = createHarness({ slimTranscriptOmitted: 5 });
		await proto.renderSessionContext.call(clickable, sessionContext(transcript(1, "tail")), {});
		expect(chatText(clickable)).toContain("点击或在此处向上滚动加载");
	});

	it("names the non-mouse triggers inline, where click regions never dispatch", async () => {
		const inline = createHarness({
			slimTranscriptOmitted: 5,
			ui: {
				requestRender: vi.fn(),
				requestRenderPreservingViewport: vi.fn(),
				isFullscreen: () => false,
				isFullscreenReviewing: () => false,
				scrollBy: vi.fn(),
				noteTranscriptPrepend: vi.fn(),
				terminal: { columns: 120, rows: 40 },
			},
		});
		await proto.renderSessionContext.call(inline, sessionContext(transcript(1, "tail")), {});
		const text = chatText(inline);
		expect(text).toContain("更早的 5 条消息未加载");
		expect(text).not.toContain("点击");
		expect(text).toContain("/backfill");
		expect(text).toContain(formatKeyText("alt+u"));
	});

	it("keeps the marker bare in fullscreen without the mouse (neither entry works there)", async () => {
		const fullscreenNoMouse = createHarness({
			slimTranscriptOmitted: 5,
			settingsManager: {
				getShowImages: () => false,
				getFullscreenMouse: () => false,
				getProcessMode: () => "quiet" as const,
				getCodeBlockIndent: () => "  ",
			},
		});
		await proto.renderSessionContext.call(fullscreenNoMouse, sessionContext(transcript(1, "tail")), {});
		const text = chatText(fullscreenNoMouse);
		expect(text).toContain("更早的 5 条消息未加载");
		expect(text).not.toContain("点击");
		expect(text).not.toContain("/backfill");
	});

	it("a live-cap trim against an old daemon (no slim_attach_transcript capability) gets the static note, not a clickable marker", async () => {
		// The adapter has getMessagesWindow either way; an unrestarted daemon rejects
		// the windowed read, so the marker's click would land on an error.
		const getMessagesWindow = vi.fn(async () => {
			throw new Error("daemon does not know before/limit");
		});
		const mode = createHarness({
			agentConnection: { getMessagesWindow, supportsMessagesWindow: () => false },
		});

		await proto.renderSessionContext.call(mode, sessionContext(transcript(210, "full")), { limitTranscript: true });

		expect(mode.slimTranscriptOmitted).toBe(0);
		expect(mode.slimTranscriptMarker).toBeUndefined();
		const text = chatText(mode);
		expect(text).not.toContain("未加载");
		expect(text).toContain("只显示最近");
	});

	it("a live-cap trim against a capable daemon keeps the pageable marker", async () => {
		const mode = createHarness({
			agentConnection: {
				getMessagesWindow: vi.fn(async () => ({ messages: [], totalMessages: 0, firstIndex: 0 })),
				supportsMessagesWindow: () => true,
			},
		});

		await proto.renderSessionContext.call(mode, sessionContext(transcript(210, "full")), { limitTranscript: true });

		expect(mode.slimTranscriptOmitted).toBeGreaterThan(0);
		expect(mode.slimTranscriptMarker).toBeDefined();
		expect(chatText(mode)).toContain("未加载");
	});
});

describe("slim attach transcript backfill (rev 44)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("a marker click pages the previous messages in above the tail", async () => {
		const page = transcript(2, "older", 0);
		const getMessagesWindow = vi.fn(async (options?: { before?: number; limit?: number }) => {
			expect(options).toEqual({ before: 250, limit: 100 });
			return { messages: page, totalMessages: 254, firstIndex: 246 };
		});
		const mode = createHarness({
			slimTranscriptOmitted: 250,
			agentConnection: { getMessagesWindow },
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(2, "tail", 500)), {});
		const marker = mode.slimTranscriptMarker as { getClickRegions(): ReadonlyArray<{ onClick(p: unknown): void }> };
		expect(marker).toBeDefined();
		// Regions are produced by render; the click dispatch reads them off the frame.
		chatText(mode);
		const region = marker.getClickRegions()[0];
		expect(region).toBeDefined();

		region.onClick({ row: 0, col: 0 });
		await vi.waitFor(() => expect(mode.slimTranscriptOmitted).toBe(246));

		expect(getMessagesWindow).toHaveBeenCalledTimes(1);
		const text = chatText(mode);
		expect(text).toContain("更早的 246 条消息未加载");
		expect(text).toContain("older question 0");
		expect(text).toContain("tail question 0");
		// The page landed between the marker and the attach tail.
		expect(text.indexOf("更早的 246 条消息未加载")).toBeLessThan(text.indexOf("older question 0"));
		expect(text.indexOf("older question 0")).toBeLessThan(text.indexOf("tail question 0"));
		// The following view is undisturbed; a scrolled-up view keeps its anchor.
		expect((mode.ui as { noteTranscriptPrepend: ReturnType<typeof vi.fn> }).noteTranscriptPrepend).toHaveBeenCalled();
	});

	it("wheeling up over the marker loads a page; wheeling down does not", async () => {
		const page = transcript(1, "older", 0);
		const getMessagesWindow = vi.fn(async () => ({ messages: page, totalMessages: 12, firstIndex: 8 }));
		const mode = createHarness({
			slimTranscriptOmitted: 10,
			agentConnection: { getMessagesWindow },
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(1, "tail", 20)), {});
		const marker = mode.slimTranscriptMarker as {
			getClickRegions(): ReadonlyArray<{ onWheel?(direction: -1 | 1): boolean }>;
		};
		chatText(mode);
		const region = marker.getClickRegions()[0];
		expect(region?.onWheel).toBeDefined();

		expect(region?.onWheel?.(1)).toBe(false);
		expect(getMessagesWindow).not.toHaveBeenCalled();

		expect(region?.onWheel?.(-1)).toBe(false);
		await vi.waitFor(() => expect(mode.slimTranscriptOmitted).toBe(8));
		expect(getMessagesWindow).toHaveBeenCalledWith({ before: 10, limit: 100 });
	});

	it("loading the last page removes the marker from the chat", async () => {
		const page = transcript(15, "older", 0);
		const getMessagesWindow = vi.fn(async () => ({ messages: page, totalMessages: 32, firstIndex: 0 }));
		const mode = createHarness({
			slimTranscriptOmitted: 30,
			agentConnection: { getMessagesWindow },
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(1, "tail", 60)), {});

		await proto.loadEarlierTranscriptPage.call(mode);

		expect(mode.slimTranscriptOmitted).toBe(0);
		expect(mode.slimTranscriptMarker).toBeUndefined();
		const text = chatText(mode);
		expect(text).not.toContain("未加载");
		expect(text).toContain("older question 0");
		expect(text).toContain("older question 14");
		expect(text).toContain("tail question 0");
		expect(text.indexOf("older question 14")).toBeLessThan(text.indexOf("tail question 0"));
	});

	it("a failed page load keeps the marker and the omission count", async () => {
		const getMessagesWindow = vi.fn(async () => {
			throw new Error("daemon went away");
		});
		const mode = createHarness({
			slimTranscriptOmitted: 250,
			agentConnection: { getMessagesWindow },
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(1, "tail")), {});

		await proto.loadEarlierTranscriptPage.call(mode);

		expect(mode.showError).toHaveBeenCalledWith(expect.stringContaining("daemon went away"));
		expect(mode.slimTranscriptOmitted).toBe(250);
		expect(mode.slimTranscriptBackfillInFlight).toBe(false);
		expect(chatText(mode)).toContain("更早的 250 条消息未加载");
	});

	it("refuses a page that does not abut the loaded tail (a compaction raced the read)", async () => {
		// The daemon's transcript shrank to 200 messages under the read: the answer's
		// window ends at its own end (100 + 100), not at the 250 the view anchored on.
		const getMessagesWindow = vi.fn(async () => ({
			messages: transcript(50, "shifted", 0),
			totalMessages: 200,
			firstIndex: 100,
		}));
		const mode = createHarness({
			slimTranscriptOmitted: 250,
			agentConnection: { getMessagesWindow },
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(1, "tail")), {});
		const childrenBefore = (mode.chatContainer as Container).children.length;

		await proto.loadEarlierTranscriptPage.call(mode);

		expect(mode.showStatus).toHaveBeenCalledWith(expect.stringContaining("压缩"));
		expect(mode.slimTranscriptOmitted).toBe(250);
		expect((mode.chatContainer as Container).children.length).toBe(childrenBefore);
		expect(chatText(mode)).not.toContain("shifted question 0");
	});

	it("drops a page whose read raced a chat rebuild", async () => {
		const page = transcript(2, "older", 0);
		let resolveRead:
			| ((window: { messages: AgentMessage[]; totalMessages: number; firstIndex: number }) => void)
			| undefined;
		const getMessagesWindow = vi.fn(
			() =>
				new Promise<{ messages: AgentMessage[]; totalMessages: number; firstIndex: number }>((resolve) => {
					resolveRead = resolve;
				}),
		);
		const mode = createHarness({
			slimTranscriptOmitted: 250,
			agentConnection: {
				getMessagesWindow,
				getSessionContext: vi.fn(async () => sessionContext(transcript(2, "fresh", 900))),
			},
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(2, "tail", 500)), {});
		const inFlight = proto.loadEarlierTranscriptPage.call(mode);
		await vi.waitFor(() => expect(getMessagesWindow).toHaveBeenCalled());

		// The rebuild lands mid-read: it sources the full context and clears the omission.
		await proto.rebuildChatFromMessages.call(mode);
		expect(mode.slimTranscriptOmitted).toBe(0);
		resolveRead?.({ messages: page, totalMessages: 254, firstIndex: 246 });
		await inFlight;

		const text = chatText(mode);
		expect(text).toContain("fresh question 0");
		expect(text).not.toContain("older question 0");
		expect(text).not.toContain("未加载");
		expect(mode.slimTranscriptBackfillInFlight).toBe(false);
	});

	it("a rebuild sourced from the full session context clears the omission state", async () => {
		const mode = createHarness({
			slimTranscriptOmitted: 250,
			agentConnection: {
				getSessionContext: vi.fn(async () => sessionContext(transcript(3, "full", 0))),
			},
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(1, "tail", 500)), {});
		expect(chatText(mode)).toContain("更早的 250 条消息未加载");

		await proto.rebuildChatFromMessages.call(mode);

		expect(mode.slimTranscriptOmitted).toBe(0);
		const text = chatText(mode);
		expect(text).not.toContain("未加载");
		expect(text).toContain("full question 0");
	});

	it("a backfill page ending on a tool call pairs the result the tail window dropped", async () => {
		// The window cut between the call and its result: the tail replay dropped
		// the result as an orphan, and the page ends on the still-open call.
		const tail: AgentMessage[] = [
			toolResult(100, "tool-1", "the real result text"),
			userMessage(101, "tail question"),
			assistantMessage(101, "tail answer"),
		];
		const page: AgentMessage[] = [userMessage(98, "older question"), assistantToolCall(98, "tool-1")];
		const getMessagesWindow = vi.fn(async () => ({ messages: page, totalMessages: 103, firstIndex: 98 }));
		const mode = createHarness({
			slimTranscriptOmitted: 100,
			agentConnection: { getMessagesWindow },
		});
		await proto.renderSessionContext.call(mode, sessionContext(tail), {});
		expect((mode.slimOrphanToolResults as Map<string, unknown>).has("tool-1")).toBe(true);

		const updateResult = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
		await proto.loadEarlierTranscriptPage.call(mode);

		// The page's tool card settled with the real result instead of running forever.
		expect(updateResult).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "tool-1", isError: false }));
		expect((mode.slimOrphanToolResults as Map<string, unknown>).has("tool-1")).toBe(false);
		expect(mode.showError).not.toHaveBeenCalled();
		expect(chatText(mode)).toContain("older question");
	});

	it("a backfill page-end call with no result anywhere settles as missing, never running", async () => {
		const tail: AgentMessage[] = [userMessage(50, "tail question"), assistantMessage(50, "tail answer")];
		const page: AgentMessage[] = [userMessage(48, "older question"), assistantToolCall(48, "tool-9")];
		const getMessagesWindow = vi.fn(async () => ({ messages: page, totalMessages: 52, firstIndex: 48 }));
		const mode = createHarness({
			slimTranscriptOmitted: 50,
			agentConnection: { getMessagesWindow },
		});
		await proto.renderSessionContext.call(mode, sessionContext(tail), {});
		expect((mode.slimOrphanToolResults as Map<string, unknown>).size).toBe(0);

		const updateResult = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");
		await proto.loadEarlierTranscriptPage.call(mode);

		// No result exists in the loaded view: the card closes as an error, so the
		// page's last turn ends instead of spinning forever.
		expect(updateResult).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "tool-9", isError: true }));
		expect(mode.showError).not.toHaveBeenCalled();
		expect(chatText(mode)).toContain("older question");
	});
});

describe("slim attach omission seeding (rev 44)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function seedingHarness(snapshot: unknown): ModeFake {
		return createHarness({
			agentConnection: { getInitialSnapshot: vi.fn(async () => snapshot) },
			getSessionContextFromConnectionSnapshot: vi.fn((snap: { messages: AgentMessage[] }) => ({
				messages: snap.messages,
				thinkingLevel: "medium",
				serviceTier: "default",
				model: null,
			})),
			seedSubagentSummary: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			applySnapshotQuotaPark: vi.fn(),
			restoreTurnStartFromMessages: vi.fn(),
			renderSessionContext: vi.fn(async () => {}),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			showDutyLog: vi.fn(async () => {}),
			rlmNodeId: undefined,
		});
	}

	it("renderInitialMessages seeds the omission count from the attach snapshot", async () => {
		const mode = seedingHarness({ state: { compactionCount: 0 }, messages: [], messagesOmitted: 42 });

		await proto.renderInitialMessages.call(mode);

		expect(mode.slimTranscriptOmitted).toBe(42);
		expect(mode.renderSessionContext).toHaveBeenCalledTimes(1);
	});

	it("renderInitialMessages resets the count when the snapshot carries the full transcript", async () => {
		const mode = seedingHarness({ state: { compactionCount: 0 }, messages: [] });
		mode.slimTranscriptOmitted = 42;

		await proto.renderInitialMessages.call(mode);

		expect(mode.slimTranscriptOmitted).toBe(0);
	});

	it("backfills the editor history from the omitted prefix after a slim attach", async () => {
		const older = transcript(3, "older", 0);
		const tail = transcript(2, "tail", 300);
		const getMessagesWindow = vi.fn(async (options?: { before?: number; limit?: number }) => {
			const before = options?.before ?? older.length;
			const messages = older.slice(Math.max(0, before - 100), before);
			return { messages, totalMessages: older.length + tail.length, firstIndex: before - messages.length };
		});
		const history: string[] = [];
		const editor = {
			addToHistory: vi.fn((text: string) => {
				history.unshift(text);
			}),
			getHistory: vi.fn(() => [...history]),
			clearHistory: vi.fn(() => {
				history.length = 0;
			}),
		};
		const mode = createHarness({
			editor,
			agentConnection: {
				getMessagesWindow,
				getInitialSnapshot: vi.fn(async () => ({
					state: { compactionCount: 0 },
					messages: tail,
					messagesOmitted: older.length,
				})),
			},
			getSessionContextFromConnectionSnapshot: vi.fn((snap: { messages: AgentMessage[] }) =>
				sessionContext(snap.messages),
			),
			seedSubagentSummary: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			applySnapshotQuotaPark: vi.fn(),
			restoreTurnStartFromMessages: vi.fn(),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			showDutyLog: vi.fn(async () => {}),
		});

		await proto.renderInitialMessages.call(mode);

		// The tail's questions lead (most recent first); the omitted prefix pages in
		// behind them, oldest questions last.
		await vi.waitFor(() => expect(history).toHaveLength(5));
		expect(history).toEqual([
			"tail question 1",
			"tail question 0",
			"older question 2",
			"older question 1",
			"older question 0",
		]);
		expect(getMessagesWindow).toHaveBeenCalledWith({ before: 6, limit: 100 });
	});

	it("does not backfill the editor history when nothing was omitted", async () => {
		const getMessagesWindow = vi.fn(async () => ({ messages: [], totalMessages: 0, firstIndex: 0 }));
		const mode = createHarness({
			agentConnection: {
				getMessagesWindow,
				getInitialSnapshot: vi.fn(async () => ({ state: { compactionCount: 0 }, messages: transcript(1, "tail") })),
			},
			getSessionContextFromConnectionSnapshot: vi.fn((snap: { messages: AgentMessage[] }) =>
				sessionContext(snap.messages),
			),
			seedSubagentSummary: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			applySnapshotQuotaPark: vi.fn(),
			restoreTurnStartFromMessages: vi.fn(),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			showDutyLog: vi.fn(async () => {}),
		});

		await proto.renderInitialMessages.call(mode);
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(getMessagesWindow).not.toHaveBeenCalled();
	});

	it("anchors the working clock at the oldest visible message when the attach window starts inside the running turn", () => {
		// A slim attach into a long turn: the tail holds only mid-turn steps, so the
		// scan for the run's start walks off the window's front. The clock must anchor
		// there, not at the attach moment.
		const mode = createHarness({
			connectionState: { isStreaming: true, isCompacting: false, isBashRunning: false, retryAttempt: 0 },
			workingStartedAt: 1_700_000_000_000,
		});

		turnStartProto.restoreTurnStartFromMessages.call(mode, [
			assistantToolCall(900, "tool-1"),
			toolResult(900, "tool-1", "ok"),
		]);

		expect(mode.turnStartedAt).toBe(900.5);
		expect(mode.workingStartedAt).toBe(900.5);
	});

	it("still finds the run's own start when it is inside the window", () => {
		const mode = createHarness({
			connectionState: { isStreaming: true, isCompacting: false, isBashRunning: false, retryAttempt: 0 },
			workingStartedAt: 1_700_000_000_000,
		});

		turnStartProto.restoreTurnStartFromMessages.call(mode, [
			userMessage(800, "the real question"),
			assistantToolCall(801, "tool-1"),
			toolResult(801, "tool-1", "ok"),
		]);

		expect(mode.turnStartedAt).toBe(800);
		expect(mode.workingStartedAt).toBe(800);
	});

	it("leaves the clock alone when the agent is not streaming", () => {
		const mode = createHarness({ workingStartedAt: 1234 });
		mode.turnStartedAt = 5678;

		turnStartProto.restoreTurnStartFromMessages.call(mode, [assistantToolCall(900, "tool-1")]);

		expect(mode.turnStartedAt).toBeUndefined();
		expect(mode.workingStartedAt).toBe(1234);
	});

	function resyncHarness(): ModeFake {
		return createHarness({
			applyConnectionStateSnapshot: vi.fn(),
			refreshQueueSelectionFromState: vi.fn(),
			restoreTurnStartFromMessages: vi.fn(),
			getSessionContextFromConnectionSnapshot: vi.fn((snap: { messages: AgentMessage[] }) => ({
				messages: snap.messages,
				thinkingLevel: "medium",
				serviceTier: "default",
				model: null,
			})),
			replaceSubagentSummary: vi.fn(),
			renderSessionContext: vi.fn(async () => {}),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			updatePendingMessagesDisplay: vi.fn(),
			updateTerminalTitle: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			getGoalState: vi.fn(() => ({ active: false })),
			syncGoalTray: vi.fn(),
			syncWorkingLoader: vi.fn(),
			rlmNodeId: undefined,
		});
	}

	it("renderResyncedSession re-seeds from the resync snapshot, full or windowed", async () => {
		const mode = resyncHarness();
		mode.slimTranscriptOmitted = 33;

		await proto.renderResyncedSession.call(mode, {
			state: { isStreaming: false, isBashRunning: false },
			messages: [],
			messagesOmitted: 7,
		});
		expect(mode.slimTranscriptOmitted).toBe(7);

		await proto.renderResyncedSession.call(mode, {
			state: { isStreaming: false, isBashRunning: false },
			messages: [],
		});
		expect(mode.slimTranscriptOmitted).toBe(0);
	});
});

const passthrough = (text: string) => text;

const editorTheme: EditorTheme = {
	borderColor: passthrough,
	selectList: {
		selectedPrefix: passthrough,
		selectedText: passthrough,
		description: passthrough,
		scrollInfo: passthrough,
		noMatch: passthrough,
	},
};

const fakeTui = {
	requestRender: vi.fn(),
	terminal: { rows: 24, columns: 80 },
} as unknown as TUI;

/** The editor-submit fields setupEditorSubmitHandler reads before the command dispatch. */
function submitFields(): ModeFake {
	let editorText = "";
	return {
		defaultEditor: {},
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
		},
		submittedInputBehavior: "steer",
		queueSelection: undefined,
		pendingQueueEdit: undefined,
		inputSubmissionGeneration: 0,
		inputSubmissionsPending: 0,
		clearShortcutGuide: vi.fn(),
		dutyLogContainer: undefined,
		promptStashState: {},
		promptStashSessionId: "session-1",
		promptStash: undefined,
		pendingSubmittedPromptStash: undefined,
		latestEditorPromptStash: undefined,
		snapshotPromptStash: vi.fn(() => ({ text: "" })),
		sideQuestionComponent: undefined,
		isShuttingDown: false,
		agentsViewRequest: undefined,
		pendingPromptStashReleases: [],
		restorePromptStashIfEditorEmpty: vi.fn(),
		completeDeferredPromptStashRelease: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		collectImagesFor: vi.fn(() => []),
		updatePendingMessagesDisplay: vi.fn(),
	};
}

function submitter(mode: ModeFake): (text: string) => Promise<void> {
	proto.setupEditorSubmitHandler.call(mode);
	const submit = (mode.defaultEditor as { onSubmit?: (text: string) => Promise<void> }).onSubmit;
	expect(submit).toBeDefined();
	return submit!;
}

describe("slim attach backfill non-mouse triggers", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("registers /backfill as a no-argument built-in command", () => {
		expect(isBuiltinSlashCommandName("backfill")).toBe(true);
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "backfill")).toBe(true);
		expect(NO_ARGUMENT_BUILTIN_SLASH_COMMANDS.has("backfill")).toBe(true);
		expect(builtinSlashCommandTakesArgument("backfill")).toBe(false);
	});

	it("binds app.transcript.loadEarlier to alt+u, a key no other default claims", () => {
		const manager = new KeybindingsManager();
		expect(manager.getKeys("app.transcript.loadEarlier")).toEqual(["alt+u"]);
		const ids = Object.keys(KEYBINDINGS);
		expect(ids.length).toBeGreaterThan(0);
		for (const id of ids) {
			if (id === "app.transcript.loadEarlier") continue;
			expect(manager.getKeys(id as AppKeybinding), id).not.toContain("alt+u");
		}
	});

	it("dispatches the bound key through the editor to the registered action", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const onLoadEarlier = vi.fn();
		editor.onAction("app.transcript.loadEarlier", onLoadEarlier);

		editor.handleInput("\x1bu"); // legacy alt+u

		expect(onLoadEarlier).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("");
	});

	it("wires the keybinding action in setupKeyHandlers to the page load", async () => {
		const page = transcript(2, "older", 0);
		const getMessagesWindow = vi.fn(async () => ({ messages: page, totalMessages: 254, firstIndex: 246 }));
		const mode = createHarness({
			slimTranscriptOmitted: 250,
			agentConnection: { getMessagesWindow },
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(2, "tail", 500)), {});
		const handlers = new Map<string, () => unknown>();
		mode.defaultEditor = {
			onAction: (action: string, handler: () => unknown) => handlers.set(action, handler),
		};

		proto.setupKeyHandlers.call(mode);
		const handler = handlers.get("app.transcript.loadEarlier");
		expect(handler).toBeDefined();
		handler!();

		await vi.waitFor(() => expect(mode.slimTranscriptOmitted).toBe(246));
		expect(getMessagesWindow).toHaveBeenCalledWith({ before: 250, limit: 100 });
		const text = chatText(mode);
		expect(text).toContain("older question 0");
		expect(text).toContain("tail question 0");
	});

	it("the typed /backfill command loads a page through the same backfill path", async () => {
		const page = transcript(2, "older", 0);
		const getMessagesWindow = vi.fn(async () => ({ messages: page, totalMessages: 254, firstIndex: 246 }));
		const prompt = vi.fn(async () => undefined);
		const mode = createHarness({
			slimTranscriptOmitted: 250,
			agentConnection: { getMessagesWindow, prompt },
			...submitFields(),
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(2, "tail", 500)), {});
		const submit = submitter(mode);

		await submit("/backfill");

		await vi.waitFor(() => expect(mode.slimTranscriptOmitted).toBe(246));
		expect(getMessagesWindow).toHaveBeenCalledWith({ before: 250, limit: 100 });
		expect(prompt).not.toHaveBeenCalled();
		expect(chatText(mode)).toContain("older question 0");
	});

	it("/backfill with nothing held back says so instead of prompting", async () => {
		const prompt = vi.fn(async () => undefined);
		const fields = submitFields();
		const editor = fields.editor as { getText: () => string };
		const mode = createHarness({
			slimTranscriptOmitted: 0,
			agentConnection: {
				getMessagesWindow: vi.fn(),
				prompt,
			},
			...fields,
		});
		const submit = submitter(mode);

		await submit("/backfill");

		expect(mode.showStatus).toHaveBeenCalledWith("没有更早的消息可加载");
		expect(editor.getText()).toBe("");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("/backfill rejects stray arguments with a usage error and restores the draft", async () => {
		const prompt = vi.fn(async () => undefined);
		const fields = submitFields();
		const editor = fields.editor as { getText: () => string };
		const mode = createHarness({
			agentConnection: { prompt },
			...fields,
		});
		const submit = submitter(mode);

		await submit("/backfill 5");

		expect(mode.showError).toHaveBeenCalledWith("用法：/backfill");
		expect(editor.getText()).toBe("/backfill 5");
		expect(prompt).not.toHaveBeenCalled();
	});

	it("a second trigger while a page load is in flight says so and does not double-read", async () => {
		let resolveRead:
			| ((window: { messages: AgentMessage[]; totalMessages: number; firstIndex: number }) => void)
			| undefined;
		const getMessagesWindow = vi.fn(
			() =>
				new Promise<{ messages: AgentMessage[]; totalMessages: number; firstIndex: number }>((resolve) => {
					resolveRead = resolve;
				}),
		);
		const mode = createHarness({
			slimTranscriptOmitted: 250,
			agentConnection: { getMessagesWindow },
		});
		await proto.renderSessionContext.call(mode, sessionContext(transcript(2, "tail", 500)), {});

		proto.requestTranscriptBackfill.call(mode);
		await vi.waitFor(() => expect(getMessagesWindow).toHaveBeenCalledTimes(1));
		proto.requestTranscriptBackfill.call(mode);

		expect(mode.showStatus).toHaveBeenCalledWith("正在加载更早的消息…");
		expect(getMessagesWindow).toHaveBeenCalledTimes(1);
		resolveRead?.({ messages: transcript(2, "older", 0), totalMessages: 254, firstIndex: 246 });
		await vi.waitFor(() => expect(mode.slimTranscriptOmitted).toBe(246));
	});
});
