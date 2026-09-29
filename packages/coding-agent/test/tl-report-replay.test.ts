import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Container, Spacer, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import type { AgentConnectionSessionContext } from "../src/modes/agent-connection/index.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { TimelineNoticeRow } from "../src/modes/interactive/components/system-notice.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { assistant, plain, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

/**
 * The interactive mode's own replay (`renderSessionContext`) against the live flow: the same
 * conversation must draw the same layout whether it came in as events or is rebuilt from the
 * session file.
 */

type Host = {
	chatContainer: Container;
	[key: string]: unknown;
};

type Proto = {
	renderSessionContext(
		this: Host,
		context: AgentConnectionSessionContext,
		options?: { clearChat?: boolean },
	): Promise<void>;
};

const proto = InteractiveMode.prototype as unknown as Proto;

function createHost(): Host {
	const noop = () => {};
	const host: Host = {
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
		subagentSummaryLine: { getSubagentSpend: () => undefined },
		handleTurnLanesClicked: noop,
		resetBlockNavigation: noop,
		showError: noop,
	};
	Object.setPrototypeOf(host, InteractiveMode.prototype);
	return host;
}

async function replay(messages: AgentMessage[]): Promise<Host> {
	const host = createHost();
	await proto.renderSessionContext.call(
		host,
		{ messages, thinkingLevel: "medium", serviceTier: "default", model: null } as AgentConnectionSessionContext,
		{ clearChat: true },
	);
	return host;
}

const LONG_ANSWER = "审查完成：四个车道都收口了，这批代码本身没问题，但发版把一个测试弄红了，远程检查现在是红的。";
const ACK = "查过了，这条通知不用处理。";

function outline(children: readonly Component[]): string[] {
	const out: string[] = [];
	for (const child of children) {
		if (child instanceof Spacer) continue;
		const text = plain(child.render(200))
			.map((line) =>
				line
					.replace(/\d\d:\d\d/, "HH:MM")
					.replace(/用了 \d+ 秒/, "用了 N 秒")
					.trim(),
			)
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

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

beforeEach(() => {
	setMotionReduced(true);
	vi.useFakeTimers();
	vi.setSystemTime(T0);
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
	timelineShowAll.set(false);
});

function transcript(): AgentMessage[] {
	return [
		{ role: "user", content: "对最近的改动做全面的审查", timestamp: T0 },
		assistant(T0 + 1_000, [{ type: "text", text: "派出去了，等它们交回。" }], "stop"),
		handedBack("m1", T0 + 2_000, "review-grow-A-tui"),
		handedBack("m2", T0 + 3_000, "review-grow-B-box"),
		assistant(T0 + 4_000, [{ type: "text", text: LONG_ANSWER }], "stop"),
		createRlmChildTerminalNoticeMessage(
			{ kind: "completed_without_reply", childId: "c-id", sessionName: "review-grow-C-strip" },
			T0 + 5_000,
		),
		assistant(T0 + 6_000, [{ type: "text", text: ACK }], "stop"),
	];
}

describe("the mode's own replay of a conversation subagents woke", () => {
	it("draws the layout a live run drew: three turns, the reports, the notice out of sight, every answer in full", async () => {
		const host = await replay(transcript());
		const chat = new LiveChat();
		chat.prompt("对最近的改动做全面的审查", { answer: "派出去了，等它们交回。" });
		chat.wake("m1", {
			name: "review-grow-A-tui",
			also: [{ id: "m2", name: "review-grow-B-box" }],
			answer: LONG_ANSWER,
		});
		chat.wakeByNotice("review-grow-C-strip", { answer: ACK });
		vi.advanceTimersByTime(1_000);
		const replayed = outline(host.chatContainer.children);
		expect(replayed.filter((entry) => entry.startsWith("turn("))).toEqual([
			"turn(byUser=true)",
			"turn(byUser=false)",
			"turn(byUser=false)",
		]);
		expect(replayed).toEqual(outline(chat.chat.children));
		// The acknowledgement of the silent subagent's notice is out of sight, live and replayed alike.
		expect(replayed.filter((entry) => entry === "answer: (nothing drawn)")).toHaveLength(1);
		expect(replayed.some((entry) => entry.includes(ACK))).toBe(false);
		expect(replayed.find((entry) => entry.includes(LONG_ANSWER))?.startsWith("answer: ")).toBe(true);
		chat.flow.dispose();
	});

	it("keeps a subagent's silent finish out of every turn's box and out of sight until 完整过程 is on", async () => {
		const host = await replay(transcript());
		const text = plain(host.chatContainer.children.flatMap((child) => child.render(100))).join("\n");
		expect(text).not.toContain("没发回消息");
		expect(text).not.toContain("RLM child");
		timelineShowAll.set(true);
		const all = plain(host.chatContainer.children.flatMap((child) => child.render(100))).join("\n");
		expect(all).toContain("子代理 review-grow-C-strip 做完了，没发回消息");
	});

	it("puts a report that lands inside the tool loop in the turn it interrupts", async () => {
		const call = assistant(
			T0 + 1_000,
			[{ type: "toolCall", id: "t1", name: "ipython", arguments: { code: "1" } }],
			"toolUse",
		);
		const host = await replay([
			{ role: "user", content: "审查", timestamp: T0 },
			call,
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "ipython",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: T0 + 2_000,
			},
			handedBack("m1", T0 + 3_000, "review-grow-A-tui"),
			assistant(T0 + 4_000, [{ type: "text", text: "收到。" }], "stop"),
		]);
		const summaries = host.chatContainer.children.filter((child) => child instanceof TurnSummaryComponent);
		expect(summaries).toHaveLength(1);
	});
});
