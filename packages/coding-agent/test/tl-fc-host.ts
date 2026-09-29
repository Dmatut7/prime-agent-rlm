import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import type {
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionContext,
} from "../src/modes/agent-connection/index.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * The interactive mode's replay (`renderSessionContext`, what a resync, a compaction or an attach
 * runs) on a host that has only what the replay reads: the chat container and a few settings.
 */

export const at = (h: number, m: number, s = 0) => new Date(2026, 8, 29, h, m, s).getTime();
export const plain = (lines: readonly string[]) =>
	lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

export interface ReplayHost {
	chatContainer: Container;
	[key: string]: unknown;
}

export interface ReplayOptions {
	clearChat?: boolean;
	keepCompactedHistory?: boolean;
	limitTranscript?: boolean;
}

interface Proto {
	renderSessionContext(
		this: ReplayHost,
		context: AgentConnectionSessionContext,
		options?: ReplayOptions,
	): Promise<void>;
}

const proto = InteractiveMode.prototype as unknown as Proto;

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
	await proto.renderSessionContext.call(
		host,
		{ messages, thinkingLevel: "medium", serviceTier: "default", model: null } as AgentConnectionSessionContext,
		options,
	);
}

export function summariesOf(host: ReplayHost): TurnSummaryComponent[] {
	return host.chatContainer.children.filter(
		(child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent,
	);
}

export function screenOf(host: ReplayHost, width = 160): string[] {
	return plain(host.chatContainer.children.flatMap((child) => child.render(width)));
}
