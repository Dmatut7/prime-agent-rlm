import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { emptyUsage } from "../src/core/usage.js";
import type { AgentConnectionSessionContext } from "../src/modes/agent-connection/index.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

const LIVE_CHAT_COMPONENT_LIMIT = 800;

type CapHarness = {
	chatContainer: Container;
	pendingTools: Map<string, ToolExecutionComponent>;
	pendingToolCreations: Set<string>;
	startedToolCalls: Set<string>;
	pendingToolGeneration: number;
	ipythonToolComponents: Map<string, unknown>;
	lateIpythonSentAgentMessages: Map<string, unknown[]>;
	toolOutputExpanded: boolean;
	agentMessagesExpanded: boolean;
	editDiffsExpanded: boolean;
	hideThinkingBlock: boolean;
	hiddenThinkingLabel: string;
	defaultHiddenThinkingLabel: string;
	streamingComponent: AssistantMessageComponent | undefined;
	streamingMessage: Extract<AgentMessage, { role: "assistant" }> | undefined;
	activeBashComponent: { render: () => string[]; invalidate: () => void } | undefined;
	customHeader: undefined;
	builtInHeader: undefined;
	connectionState: {
		isStreaming: boolean;
		isCompacting: boolean;
		isBashRunning: boolean;
		retryAttempt: number;
		sessionActions: { active?: { kind: string } };
	};
	chatTranscriptTrimmed: boolean;
	chatCapRebuildFloor: number;
	chatCapRebuildInFlight: boolean;
	/** Set by a test to stub the rebuild body; absent, the prototype's real method runs. */
	renderSessionContext?: (context: AgentConnectionSessionContext, options?: unknown) => Promise<void>;
	editor: { addToHistory?: (text: string) => void };
	footer: { invalidate: () => void };
	settingsManager: {
		getShowImages: () => boolean;
		setShowImages: (enabled: boolean) => void;
		setFullscreen: (enabled: boolean) => void;
		getFullscreenMouse: () => boolean;
		getProcessMode: () => "quiet" | "legacy";
		getCodeBlockIndent: () => string;
	};
	preloadToolDefinitions: (names: string[]) => Promise<void>;
	getCachedToolDefinition: () => undefined;
	getCurrentCwd: () => string;
	getAppKeyDisplay: (action: string) => string;
	showStatus: (status: string) => void;
	showError: ReturnType<typeof vi.fn>;
	updateEditorBorderColor: () => void;
	addMessageToChat: (message: AgentMessage, options?: { populateHistory?: boolean }) => void;
	connectionCommands: unknown[];
	seenSubagentFailureIds: Set<string>;
	agentConnection: { getSessionContext: () => Promise<AgentConnectionSessionContext> };
	ui: {
		requestRender: () => void;
		requestRenderPreservingViewport: () => void;
		isFullscreen: () => boolean;
		isFullscreenReviewing: () => boolean;
		enterFullscreen: (options: unknown) => void;
		exitFullscreen: () => void;
	};
};

type Proto = {
	renderSessionContext(
		this: CapHarness,
		context: AgentConnectionSessionContext,
		options?: { updateFooter?: boolean; populateHistory?: boolean; clearChat?: boolean; limitTranscript?: boolean },
	): Promise<void>;
	rebuildChatFromMessages(this: CapHarness): Promise<void>;
	enforceChatComponentCap(this: CapHarness): Promise<void>;
	applyChatExpansion(this: CapHarness): void;
	setHiddenThinkingLabel(this: CapHarness, label?: string): void;
	setFullscreenMode(this: CapHarness, enabled: boolean): void;
	ensureAssistantStreamingComponent(
		this: CapHarness,
		message: Extract<AgentMessage, { role: "assistant" }>,
	): AssistantMessageComponent;
	reattachLiveChatComponents(this: CapHarness): void;
};

const proto = InteractiveMode.prototype as unknown as Proto;

function userMessage(index: number): Extract<AgentMessage, { role: "user" }> {
	return { role: "user", content: `user message ${index}`, timestamp: index };
}

function toolCallMessage(index: number): Extract<AgentMessage, { role: "assistant" }> {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name: "wait", id: `tool-${index}`, arguments: {} }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp: index,
	};
}

function toolResultMessage(index: number): Extract<AgentMessage, { role: "toolResult" }> {
	return {
		role: "toolResult",
		toolCallId: `tool-${index}`,
		toolName: "wait",
		content: [{ type: "text", text: `result ${index}` }],
		isError: false,
		timestamp: index,
	};
}

/** 300 turns: user + assistant(toolCall) + toolResult = 900 messages, well over the 400 render window. */
function longTranscript(): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let index = 0; index < 300; index++) {
		messages.push(userMessage(index), toolCallMessage(index), toolResultMessage(index));
	}
	return messages;
}

function sessionContext(messages: AgentMessage[]): AgentConnectionSessionContext {
	return { messages, thinkingLevel: "medium", serviceTier: "default", model: null } as AgentConnectionSessionContext;
}

function createCapHarness(overrides: Partial<CapHarness> = {}): CapHarness {
	const chatContainer = overrides.chatContainer ?? new Container();
	const addMessageToChat = vi.fn((message: AgentMessage) => {
		if (message.role === "assistant") {
			const component = new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", {
				expanded: false,
				precededByToolActivity: false,
			});
			chatContainer.addChild(component);
		} else if (message.role === "user") {
			const text = typeof message.content === "string" ? message.content : "";
			chatContainer.addChild(new UserMessageComponent(text, getMarkdownTheme(), () => false));
		}
	});
	const harness: CapHarness = {
		chatContainer,
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
		defaultHiddenThinkingLabel: "Thinking...",
		streamingComponent: undefined,
		streamingMessage: undefined,
		activeBashComponent: undefined,
		customHeader: undefined,
		builtInHeader: undefined,
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
		editor: {},
		footer: { invalidate: vi.fn() },
		settingsManager: {
			getShowImages: () => true,
			setShowImages: vi.fn(),
			setFullscreen: vi.fn(),
			getFullscreenMouse: () => false,
			getProcessMode: () => "quiet" as const,
			getCodeBlockIndent: () => "  ",
		},
		preloadToolDefinitions: vi.fn(async () => {}),
		getCachedToolDefinition: () => undefined,
		getCurrentCwd: () => "/tmp",
		getAppKeyDisplay: () => "Ctrl+F",
		showStatus: vi.fn(),
		showError: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		addMessageToChat,
		connectionCommands: [],
		seenSubagentFailureIds: new Set<string>(),
		agentConnection: { getSessionContext: vi.fn(async () => sessionContext(longTranscript())) },
		ui: {
			requestRender: vi.fn(),
			requestRenderPreservingViewport: vi.fn(),
			isFullscreen: () => false,
			isFullscreenReviewing: () => false,
			enterFullscreen: vi.fn(),
			exitFullscreen: vi.fn(),
		},
		...overrides,
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return harness;
}

function fillOverCap(chatContainer: Container, count = LIVE_CHAT_COMPONENT_LIMIT + 50): void {
	for (let index = 0; index < count; index++) {
		chatContainer.addChild({ render: () => [`line ${index}`], invalidate: () => {} } as never);
	}
}

function childComponents<T extends Component>(chatContainer: Container, ctor: new (...args: never[]) => T): T[] {
	return chatContainer.children.filter((child): child is T => child instanceof ctor);
}

describe("InteractiveMode live chat component cap", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("over the cap, a settled tree rebuilds through the render window bounded and paired", async () => {
		const harness = createCapHarness();
		fillOverCap(harness.chatContainer);
		const updateResult = vi.spyOn(ToolExecutionComponent.prototype, "updateResult");

		await proto.enforceChatComponentCap.call(harness);

		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.chatContainer.children.length).toBeLessThanOrEqual(LIVE_CHAT_COMPONENT_LIMIT);
		expect(harness.chatContainer.children.length).toBeGreaterThan(0);
		expect(harness.chatTranscriptTrimmed).toBe(true);
		// A rebuild that lands under the cap clears the floor: the cap itself is the trigger again.
		expect(harness.chatCapRebuildFloor).toBe(0);

		// Windowed rebuild keeps toolCall/toolResult pairing: every rendered tool
		// component got its result, and user/assistant messages rendered too.
		const toolComponents = childComponents(harness.chatContainer, ToolExecutionComponent);
		expect(toolComponents.length).toBeGreaterThan(0);
		expect(updateResult.mock.calls.length).toBeGreaterThanOrEqual(toolComponents.length);
		expect(childComponents(harness.chatContainer, AssistantMessageComponent).length).toBeGreaterThan(0);
		expect(childComponents(harness.chatContainer, UserMessageComponent).length).toBeGreaterThan(0);
	});

	test("a second settle on a trimmed tree under the cap does not re-trim", async () => {
		const harness = createCapHarness();
		fillOverCap(harness.chatContainer);
		await proto.enforceChatComponentCap.call(harness);
		const boundedCount = harness.chatContainer.children.length;
		expect(boundedCount).toBeLessThanOrEqual(LIVE_CHAT_COMPONENT_LIMIT);
		const getSessionContext = harness.agentConnection.getSessionContext as ReturnType<typeof vi.fn>;
		getSessionContext.mockClear();

		await proto.enforceChatComponentCap.call(harness);

		expect(getSessionContext).not.toHaveBeenCalled();
		expect(harness.chatContainer.children.length).toBe(boundedCount);
	});

	test("a window that stays over the cap ratchets the floor with hysteresis instead of re-trimming every settle", async () => {
		// The render window itself cannot get this session under the cap (one huge
		// turn fills it): the floor parks the trigger past the tree plus slack.
		const overCapCount = LIVE_CHAT_COMPONENT_LIMIT + 50;
		const harness = createCapHarness();
		harness.renderSessionContext = vi.fn(async () => {
			harness.chatContainer.clear();
			fillOverCap(harness.chatContainer, overCapCount);
		});
		fillOverCap(harness.chatContainer);

		await proto.enforceChatComponentCap.call(harness);

		// Mirrors LIVE_CHAT_CAP_FLOOR_HYSTERESIS in interactive-mode.ts.
		expect(harness.chatCapRebuildFloor).toBe(overCapCount + 200);
		const getSessionContext = harness.agentConnection.getSessionContext as ReturnType<typeof vi.fn>;
		getSessionContext.mockClear();

		// Growth inside the hysteresis band does not re-trim...
		fillOverCap(harness.chatContainer, 150);
		await proto.enforceChatComponentCap.call(harness);
		expect(getSessionContext).not.toHaveBeenCalled();

		// ...and growth past it triggers exactly one rebuild.
		fillOverCap(harness.chatContainer, 100);
		await proto.enforceChatComponentCap.call(harness);
		expect(getSessionContext).toHaveBeenCalledTimes(1);
		expect(harness.chatCapRebuildFloor).toBe(overCapCount + 200);
	});

	test("a rebuild that lands back under the cap clears a stale ratchet floor", async () => {
		const harness = createCapHarness();
		harness.renderSessionContext = vi.fn(async () => {
			harness.chatContainer.clear();
			fillOverCap(harness.chatContainer, LIVE_CHAT_COMPONENT_LIMIT - 10);
		});
		// A ratchet from an earlier over-cap window would otherwise keep the
		// trigger parked above the cap forever.
		harness.chatCapRebuildFloor = 5000;
		fillOverCap(harness.chatContainer, 5100);

		await proto.enforceChatComponentCap.call(harness);

		expect(harness.chatCapRebuildFloor).toBe(0);
		const getSessionContext = harness.agentConnection.getSessionContext as ReturnType<typeof vi.fn>;
		getSessionContext.mockClear();

		// Ordinary growth re-triggers at the cap itself, not at the old floor.
		fillOverCap(harness.chatContainer, 5);
		await proto.enforceChatComponentCap.call(harness);
		expect(getSessionContext).not.toHaveBeenCalled();
	});

	test("does not trim while a permission confirmation is active", async () => {
		const harness = createCapHarness();
		fillOverCap(harness.chatContainer);
		harness.connectionState.sessionActions = { active: { kind: "permission" } };

		await proto.enforceChatComponentCap.call(harness);

		expect(harness.chatContainer.children.length).toBe(LIVE_CHAT_COMPONENT_LIMIT + 50);
		expect(harness.chatTranscriptTrimmed).toBe(false);
		expect(harness.agentConnection.getSessionContext).not.toHaveBeenCalled();
	});

	test("does not trim while streaming, while reviewing fullscreen, or under the cap", async () => {
		const streaming = createCapHarness();
		fillOverCap(streaming.chatContainer);
		streaming.connectionState.isStreaming = true;
		await proto.enforceChatComponentCap.call(streaming);
		expect(streaming.chatContainer.children.length).toBe(LIVE_CHAT_COMPONENT_LIMIT + 50);

		const reviewing = createCapHarness();
		fillOverCap(reviewing.chatContainer);
		reviewing.ui.isFullscreen = () => true;
		reviewing.ui.isFullscreenReviewing = () => true;
		await proto.enforceChatComponentCap.call(reviewing);
		expect(reviewing.chatContainer.children.length).toBe(LIVE_CHAT_COMPONENT_LIMIT + 50);
		expect(reviewing.chatTranscriptTrimmed).toBe(false);

		const small = createCapHarness();
		await proto.enforceChatComponentCap.call(small);
		expect(small.agentConnection.getSessionContext).not.toHaveBeenCalled();
	});

	test("abandons a cap rebuild if streaming starts while session context is loading", async () => {
		const harness = createCapHarness();
		fillOverCap(harness.chatContainer);
		const originalCount = harness.chatContainer.children.length;
		let resume!: (context: AgentConnectionSessionContext) => void;
		const pending = new Promise<AgentConnectionSessionContext>((resolve) => {
			resume = resolve;
		});
		harness.agentConnection.getSessionContext = vi.fn(() => pending);

		const run = proto.enforceChatComponentCap.call(harness);
		harness.connectionState.isStreaming = true;
		resume(sessionContext(longTranscript()));
		await run;

		expect(harness.chatContainer.children.length).toBe(originalCount);
		expect(harness.chatTranscriptTrimmed).toBe(false);
	});

	test("trims in default fullscreen rendering when the user is still following", async () => {
		const harness = createCapHarness();
		fillOverCap(harness.chatContainer);
		harness.ui.isFullscreen = () => true;
		harness.ui.isFullscreenReviewing = () => false;

		await proto.enforceChatComponentCap.call(harness);

		expect(harness.chatTranscriptTrimmed).toBe(true);
		expect(harness.chatContainer.children.length).toBeLessThanOrEqual(LIVE_CHAT_COMPONENT_LIMIT);
	});

	test("expansion toggles still reach every rebuilt component after the cap trim", async () => {
		const harness = createCapHarness();
		fillOverCap(harness.chatContainer);
		await proto.enforceChatComponentCap.call(harness);

		harness.toolOutputExpanded = true;
		const setToolExpanded = vi.spyOn(ToolExecutionComponent.prototype, "setExpanded");
		const setAgentExpanded = vi.spyOn(AssistantMessageComponent.prototype, "setExpanded");

		proto.applyChatExpansion.call(harness);

		const toolComponents = childComponents(harness.chatContainer, ToolExecutionComponent);
		const assistantComponents = childComponents(harness.chatContainer, AssistantMessageComponent);
		expect(setToolExpanded.mock.calls.length).toBeGreaterThanOrEqual(toolComponents.length);
		expect(setAgentExpanded.mock.calls.length).toBeGreaterThanOrEqual(assistantComponents.length);
		expect(harness.ui.requestRenderPreservingViewport).toHaveBeenCalled();
	});

	test("hidden-thinking label still applies to rebuilt assistant components after the cap trim", async () => {
		const harness = createCapHarness();
		fillOverCap(harness.chatContainer);
		await proto.enforceChatComponentCap.call(harness);

		const setLabel = vi.spyOn(AssistantMessageComponent.prototype, "setHiddenThinkingLabel");
		proto.setHiddenThinkingLabel.call(harness, "custom-hidden-label");

		const assistantComponents = childComponents(harness.chatContainer, AssistantMessageComponent);
		expect(assistantComponents.length).toBeGreaterThan(0);
		expect(setLabel.mock.calls.length).toBe(assistantComponents.length);
		expect(harness.hiddenThinkingLabel).toBe("custom-hidden-label");
	});

	test("show-images and hide-thinking settings walks still reach rebuilt components after the cap trim", async () => {
		const harness = createCapHarness();
		fillOverCap(harness.chatContainer);
		await proto.enforceChatComponentCap.call(harness);

		// Same walks the settings change handlers run over chatContainer children.
		const setShowImages = vi.spyOn(ToolExecutionComponent.prototype, "setShowImages");
		for (const child of harness.chatContainer.children) {
			if (child instanceof ToolExecutionComponent) child.setShowImages(false);
		}
		const setHideThinkingBlock = vi.spyOn(AssistantMessageComponent.prototype, "setHideThinkingBlock");
		for (const child of harness.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(true);
		}

		expect(setShowImages.mock.calls.length).toBe(
			childComponents(harness.chatContainer, ToolExecutionComponent).length,
		);
		expect(setHideThinkingBlock.mock.calls.length).toBe(
			childComponents(harness.chatContainer, AssistantMessageComponent).length,
		);
		expect(setShowImages.mock.calls.length).toBeGreaterThan(0);
		expect(setHideThinkingBlock.mock.calls.length).toBeGreaterThan(0);
	});

	test("reattaches in-flight streaming after fullscreen restore rebuilds the tree", async () => {
		const originalIsTTY = process.stdout.isTTY;
		(process.stdout as { isTTY?: boolean }).isTTY = true;
		try {
			const harness = createCapHarness();
			fillOverCap(harness.chatContainer);
			await proto.enforceChatComponentCap.call(harness);
			expect(harness.chatTranscriptTrimmed).toBe(true);

			const streamingMessage: Extract<AgentMessage, { role: "assistant" }> = {
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				api: "openai-responses",
				provider: "openai",
				model: "test-model",
				usage: emptyUsage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const streaming = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", {
				expanded: false,
				precededByToolActivity: false,
			});
			streaming.updateContent(streamingMessage);
			harness.chatContainer.addChild(streaming);
			harness.streamingComponent = streaming;
			harness.streamingMessage = streamingMessage;
			const bash = { render: () => ["bash"], invalidate: () => {} };
			harness.activeBashComponent = bash;
			harness.chatContainer.addChild(bash);

			proto.setFullscreenMode.call(harness, true);
			await vi.waitFor(() => expect(harness.ui.enterFullscreen).toHaveBeenCalled());

			expect(harness.chatContainer.children).toContain(streaming);
			expect(harness.chatContainer.children).toContain(bash);
			const ensured = proto.ensureAssistantStreamingComponent.call(harness, streamingMessage);
			expect(ensured).toBe(streaming);
			expect(harness.chatContainer.children).toContain(ensured);

			streamingMessage.content = [{ type: "text", text: "partial more" }];
			ensured.updateContent(streamingMessage);
			expect(harness.chatContainer.children).toContain(ensured);
		} finally {
			(process.stdout as { isTTY?: boolean }).isTTY = originalIsTTY;
		}
	});

	test("entering fullscreen restores the full transcript trimmed by the cap", async () => {
		const originalIsTTY = process.stdout.isTTY;
		(process.stdout as { isTTY?: boolean }).isTTY = true;
		try {
			const harness = createCapHarness();
			fillOverCap(harness.chatContainer);
			await proto.enforceChatComponentCap.call(harness);
			expect(harness.chatTranscriptTrimmed).toBe(true);
			const trimmedCount = harness.chatContainer.children.length;

			proto.setFullscreenMode.call(harness, true);
			await vi.waitFor(() => expect(harness.ui.enterFullscreen).toHaveBeenCalled());

			expect(harness.chatTranscriptTrimmed).toBe(false);
			// The full (unwindowed) rebuild renders the whole transcript again.
			expect(harness.chatContainer.children.length).toBeGreaterThan(trimmedCount);
		} finally {
			(process.stdout as { isTTY?: boolean }).isTTY = originalIsTTY;
		}
	});
});
