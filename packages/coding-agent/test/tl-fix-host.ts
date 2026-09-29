import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container } from "@earendil-works/pi-tui";
import type {
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionContext,
} from "../src/modes/agent-connection/index.js";
import type { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * The interactive mode's replay (`renderSessionContext`, what a resync, a compaction or an attach
 * runs) and `addMessageToChat` on a host that has only what they read: the chat container and a few
 * settings. Both methods are private on the mode and the mode has no public entry for either, so this
 * file is the one place the tests reach them; a rename fails at the lookup below with its name.
 */

export interface ReplayHost {
	chatContainer: Container;
	currentTurnState?: TurnSummaryComponent["state"];
	[key: string]: unknown;
}

export interface ReplayOptions {
	clearChat?: boolean;
	updateFooter?: boolean;
	populateHistory?: boolean;
	limitTranscript?: boolean;
	keepCompactedHistory?: boolean;
}

type RenderSessionContext = (
	this: ReplayHost,
	context: AgentConnectionSessionContext,
	options?: ReplayOptions,
) => Promise<void>;

type AddMessageToChat = (this: ReplayHost, message: AgentMessage) => void;

/** A method of the interactive mode by name, for the tests that drive one the mode keeps private. A rename throws here, naming it. */
export function modeMethod<T>(name: string): T {
	const found: unknown = Reflect.get(InteractiveMode.prototype, name);
	if (typeof found !== "function") throw new Error(`InteractiveMode has no ${name}`);
	return found as T;
}

const renderSessionContext = modeMethod<RenderSessionContext>("renderSessionContext");
const addMessage = modeMethod<AddMessageToChat>("addMessageToChat");

export function createReplayHost(children: readonly AgentConnectionRlmChildAgentSnapshot[] = []): ReplayHost {
	const noop = () => {};
	const host: ReplayHost = {
		chatContainer: new Container(),
		pendingTools: new Map(),
		pendingToolCreations: new Set(),
		startedToolCalls: new Set(),
		pendingToolGeneration: 0,
		ipythonToolComponents: new Map(),
		lateIpythonSentAgentMessages: new Map(),
		toolDefinitionCache: new Map(),
		processBlockOpenOrder: [],
		toolOutputExpanded: false,
		agentMessagesExpanded: false,
		editDiffsExpanded: false,
		thinkingExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		bindLocalSessionExtensions: false,
		mermaidMarkdownTransform: undefined,
		seenSubagentFailureIds: new Set(),
		connectionCommands: [],
		connectionState: {
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			retryAttempt: 0,
			sessionActions: {},
		},
		chatTranscriptTrimmed: false,
		chatCapRebuildFloor: 0,
		subagentSnapshots: new Map(children.map((child) => [child.id, child])),
		editor: {},
		footer: { invalidate: noop, setToolErrorCount: noop },
		settingsManager: {
			getShowImages: () => false,
			getProcessMode: () => "quiet" as const,
			getCodeBlockIndent: () => "  ",
		},
		ui: { requestRender: noop, isFullscreen: () => false, terminal: { rows: 40, columns: 100 } },
		preloadToolDefinitions: async () => {},
		getCachedToolDefinition: () => undefined,
		getCurrentCwd: () => "/work/app",
		updateEditorBorderColor: noop,
		updateSubagentSummaryLine: noop,
		handleTurnLanesClicked: noop,
		resetBlockNavigation: noop,
		addMessageToEditorHistory: noop,
		showError: noop,
	};
	Object.setPrototypeOf(host, InteractiveMode.prototype);
	return host;
}

/** Replay `messages` into the host's chat, the way a rebuild does. */
export async function replayInto(
	host: ReplayHost,
	messages: AgentMessage[],
	options: ReplayOptions = { clearChat: true },
): Promise<void> {
	const context: AgentConnectionSessionContext = {
		messages,
		thinkingLevel: "medium",
		serviceTier: "default",
		model: null,
	};
	await renderSessionContext.call(host, context, options);
}

/** One message added to the host's chat, as the mode does for a message that arrives after the replay. */
export function addMessageToChat(host: ReplayHost, message: AgentMessage): void {
	addMessage.call(host, message);
}
