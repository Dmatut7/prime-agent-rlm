import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyUsage } from "../src/core/usage.js";
import type { AgentConnectionSessionContext } from "../src/modes/agent-connection/index.js";
import { DAEMON_SLIM_ATTACH_MESSAGE_TAIL } from "../src/modes/daemon/daemon-protocol.js";
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
	rebuildChatFromMessages(this: ModeFake): Promise<void>;
	renderInitialMessages(this: ModeFake): Promise<void>;
	renderResyncedSession(this: ModeFake, snapshot: unknown): Promise<void>;
};

const proto = InteractiveMode.prototype as unknown as Proto;

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

	it("shows the load hint only where clicks dispatch (fullscreen + mouse)", async () => {
		const clickable = createHarness({ slimTranscriptOmitted: 5 });
		await proto.renderSessionContext.call(clickable, sessionContext(transcript(1, "tail")), {});
		expect(chatText(clickable)).toContain("点击或在此处向上滚动加载");

		const inline = createHarness({
			slimTranscriptOmitted: 5,
			ui: {
				requestRender: vi.fn(),
				requestRenderPreservingViewport: vi.fn(),
				isFullscreen: () => false,
				isFullscreenReviewing: () => false,
				scrollBy: vi.fn(),
				terminal: { columns: 120, rows: 40 },
			},
		});
		await proto.renderSessionContext.call(inline, sessionContext(transcript(1, "tail")), {});
		const text = chatText(inline);
		expect(text).toContain("更早的 5 条消息未加载");
		expect(text).not.toContain("点击");
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
		expect((mode.ui as { scrollBy: ReturnType<typeof vi.fn> }).scrollBy).toHaveBeenCalled();
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
