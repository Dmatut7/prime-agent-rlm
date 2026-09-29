import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import type { AgentConnectionSessionContext } from "../src/modes/agent-connection/index.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { TimelineNoticeRow } from "../src/modes/interactive/components/system-notice.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { plain } from "./ui-blocks-helpers.js";

/** The chat the interactive mode's own replay builds, and the other two ways to build one: live events, the test builder. */

export type ReplayHost = {
	chatContainer: Container;
	currentTurnState?: TurnSummaryComponent["state"];
	[key: string]: unknown;
};

export type ReplayOptions = {
	clearChat?: boolean;
	updateFooter?: boolean;
	populateHistory?: boolean;
	limitTranscript?: boolean;
	keepCompactedHistory?: boolean;
};

type Proto = {
	renderSessionContext(
		this: ReplayHost,
		context: AgentConnectionSessionContext,
		options?: ReplayOptions,
	): Promise<void>;
};

const proto = InteractiveMode.prototype as unknown as Proto;

export function createHost(): ReplayHost {
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

/** The mode's own replay of a session file's messages. */
export async function replay(
	messages: AgentMessage[],
	options: ReplayOptions = { clearChat: true },
	host: ReplayHost = createHost(),
): Promise<ReplayHost> {
	await proto.renderSessionContext.call(
		host,
		{ messages, thinkingLevel: "medium", serviceTier: "default", model: null } as AgentConnectionSessionContext,
		options,
	);
	return host;
}

/** The test builder's chat for the same messages. */
export function built(messages: readonly AgentMessage[]): Component[] {
	return buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
	});
}

export const summariesOf = (children: readonly Component[]) =>
	children.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);

/** Every line the chat draws, times blanked, with the closing rows left out (only the live flow and the mode's replay draw them). */
export function screenLines(children: readonly Component[], width = 100): string[] {
	return plain(
		children.filter((child) => !(child instanceof TurnStripComponent)).flatMap((child) => child.render(width)),
	).map((line) => line.replace(/\d\d:\d\d(?::\d\d)?/g, "HH:MM").trimEnd());
}

export const screenOf = (children: readonly Component[], width = 100): string =>
	screenLines(children, width).join("\n");

/** What the chat is, one entry per component: the same words say the same layout live and replayed. */
export function outline(children: readonly Component[]): string[] {
	const out: string[] = [];
	for (const child of children) {
		if (child instanceof Spacer || child instanceof TurnStripComponent) continue;
		const text = plain(child.render(200))
			.map((line) => line.replace(/\d\d:\d\d/, "HH:MM").trim())
			.filter((line) => line.length > 0)
			.join(" / ");
		if (child instanceof TurnSummaryComponent) out.push(`turn(byUser=${child.state.startedByUser})`);
		else if (child instanceof UserMessageComponent) out.push(`user: ${text}`);
		else if (child instanceof AssistantMessageComponent) out.push(`answer: ${text || "(nothing drawn)"}`);
		else if (child instanceof AgentMessageComponent) out.push(`report: ${text}`);
		else if (child instanceof TimelineNoticeRow) out.push(`notice: ${text || "(out of sight)"}`);
		else if (text) out.push(`other: ${text}`);
	}
	return out;
}
