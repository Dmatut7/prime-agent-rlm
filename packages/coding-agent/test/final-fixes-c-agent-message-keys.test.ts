import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Component, Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_SOURCE, createAgentSessionMessage } from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { TurnActivityState, TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * FIX-19: Ctrl+P / Alt+P said "还没有代理消息可以展开" only in a chat that holds
 * nothing at all. Any other component (the startup warning block, the status line
 * after /new, an assistant reply, a tool call) counted as an agent message, so in
 * a real session both keys flipped a lane nobody could see and stayed silent.
 *
 * The keys are pressed on a real editor wired by the mode's own key handlers; the
 * chat is built from the same components the app puts there.
 */

const CTRL_P = "\x10";
const ALT_P = "\x1bp";
const NOTHING_TO_EXPAND = "还没有代理消息可以展开";
// The collapsed row keeps one truncated line; only the open row shows the marker on the second line.
const OPEN_ONLY_MARKER = "OPEN-ONLY-MARKER";
const MESSAGE_BODY = `${"summary of the handover ".repeat(8)}\n${OPEN_ONLY_MARKER} second line`;

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	setKeybindings(new KeybindingsManager());
});

interface Rig {
	mode: InteractiveMode;
	chat: Container;
	toasts: string[];
	press(data: string): void;
	rendered(): string;
}

function createRig(processMode: "quiet" | "legacy" = "quiet"): Rig {
	const chat = new Container();
	const requestRender = vi.fn();
	const ui = {
		requestRender,
		requestRenderPreservingViewport: requestRender,
		isFullscreen: () => false,
		isFullscreenReviewing: () => false,
		terminal: { rows: 30, columns: 100 },
	};
	const defaultEditor = new CustomEditor(ui as unknown as TUI, getEditorTheme(), new KeybindingsManager());
	const toasts: string[] = [];
	const fake = {
		chatContainer: chat,
		ui,
		defaultEditor,
		toolOutputExpanded: false,
		thinkingExpanded: false,
		agentMessagesExpanded: false,
		editDiffsExpanded: false,
		customHeader: undefined,
		builtInHeader: undefined,
		uiServices: { settingsManager: { getProcessMode: () => processMode } },
		showToast: (text: string) => {
			toasts.push(text);
		},
		// What /new needs from the connection: an empty session and a cleared chat.
		stopWorkingLoader: () => {},
		agentConnection: { newSession: async () => ({ cancelled: false }) },
		renderCurrentSessionState: async () => {
			chat.clear();
		},
		handleFatalRuntimeError: async (prefix: string, error: unknown): Promise<never> => {
			throw new Error(`${prefix}: ${String(error)}`);
		},
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	const mode = fake as unknown as InteractiveMode;
	Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
	return {
		mode,
		chat,
		toasts,
		press: (data) => defaultEditor.handleInput(data),
		rendered: () => stripAnsi(chat.children.flatMap((child) => child.render(100)).join("\n")),
	};
}

/** What a fresh session's chat holds after startup: the warning block the mode shows for a startup notice. */
function showStartupWarning(rig: Rig): void {
	rig.mode.showWarning("已把凭据迁移到 auth.json：openai");
}

/** What /new leaves behind: the mode's own clear command, against a connection that opens an empty session. */
async function runNewSession(rig: Rig): Promise<void> {
	await Reflect.get(InteractiveMode.prototype, "handleClearCommand").call(rig.mode);
}

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	timestamp: number,
) {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "m",
		usage: USAGE,
		stopReason,
		timestamp,
	} satisfies AssistantMessage;
}

function toolCall(id: string, name: string, args: Record<string, unknown>, timestamp: number): AssistantMessage {
	return assistant([{ type: "toolCall", id, name, arguments: args }], "toolUse", timestamp);
}

function toolResult(id: string, name: string, timestamp: number, details?: unknown): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		details,
		isError: false,
		timestamp,
	};
}

const prompt = (timestamp: number, text = "run the checks"): AgentMessage => ({
	role: "user",
	content: text,
	timestamp,
});

const finalAnswer = (timestamp: number): AgentMessage =>
	assistant([{ type: "text", text: "All checks passed." }], "stop", timestamp);

function receivedAgentMessage(id: string, timestamp: number): AgentMessage {
	return createAgentSessionMessage(
		{
			id,
			source: AGENT_MESSAGE_SOURCE,
			message: MESSAGE_BODY,
			target: { activeSessionId: "worker-active", sessionId: "worker-session" },
		},
		timestamp,
	);
}

/** A replayed conversation, built the way the app rebuilds one: turn head, replies, tool calls, agent rows. */
function conversation(messages: readonly AgentMessage[], processMode: "quiet" | "legacy"): Component[] {
	return buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/tmp",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode,
	});
}

function addAll(rig: Rig, components: readonly Component[]): void {
	for (const component of components) rig.chat.addChild(component);
}

const turnSummaries = (rig: Rig) => rig.chat.children.filter((child) => child instanceof TurnSummaryComponent);
const agentRows = (rig: Rig) => rig.chat.children.filter((child) => child instanceof AgentMessageComponent);

describe("Ctrl+P on a chat with no turn yet (FIX-19)", () => {
	it("says there is nothing to expand when the chat only holds a startup warning", () => {
		const rig = createRig();
		showStartupWarning(rig);
		expect(rig.chat.children.length).toBeGreaterThan(0);
		expect(turnSummaries(rig)).toHaveLength(0);

		rig.press(CTRL_P);

		expect(rig.toasts).toEqual([NOTHING_TO_EXPAND]);
	});

	it("says it after /new, when the chat only holds the new-session status line", async () => {
		const rig = createRig();
		showStartupWarning(rig);
		await runNewSession(rig);
		expect(rig.rendered()).toContain("已开新会话");
		expect(turnSummaries(rig)).toHaveLength(0);

		rig.press(CTRL_P);

		expect(rig.toasts).toEqual([NOTHING_TO_EXPAND]);
	});

	it("says it on an empty chat too", () => {
		const rig = createRig();
		rig.press(CTRL_P);
		expect(rig.toasts).toEqual([NOTHING_TO_EXPAND]);
	});

	it("opens a received agent message that sits in a chat without a turn, without a toast", () => {
		const rig = createRig();
		showStartupWarning(rig);
		addAll(rig, conversation([receivedAgentMessage("agentmsg_before_any_turn", 900)], "quiet"));
		expect(agentRows(rig)).toHaveLength(1);
		expect(turnSummaries(rig)).toHaveLength(0);
		expect(rig.rendered()).not.toContain(OPEN_ONLY_MARKER);

		rig.press(CTRL_P);

		expect(rig.toasts).toEqual([]);
		expect(rig.rendered()).toContain(OPEN_ONLY_MARKER);
		rig.press(CTRL_P);
		expect(rig.rendered()).not.toContain(OPEN_ONLY_MARKER);
	});
});

describe("Ctrl+P once a turn exists", () => {
	it("switches the latest turn without a toast, even when that turn holds no agent message", () => {
		const rig = createRig();
		addAll(
			rig,
			conversation(
				[prompt(1_000), toolCall("t1", "bash", { command: "ls" }, 1_100), toolResult("t1", "bash", 1_200)],
				"quiet",
			),
		);
		const [summary] = turnSummaries(rig) as TurnSummaryComponent[];
		expect(summary).toBeDefined();
		expect(summary.state.commMessageCount).toBe(0);
		expect(summary.state.commsBlockExpanded).toBe(false);

		rig.press(CTRL_P);

		expect(rig.toasts).toEqual([]);
		expect(summary.state.commsBlockExpanded).toBe(true);
	});
});

describe.each(["quiet", "legacy"] as const)("Alt+P in the %s face", (processMode) => {
	const noAgentMessages = (): AgentMessage[] => [
		prompt(1_000),
		toolCall("t1", "bash", { command: "ls" }, 1_100),
		toolResult("t1", "bash", 1_200),
		finalAnswer(1_300),
	];

	it("says there is nothing to expand when the turns hold no agent message", () => {
		const rig = createRig(processMode);
		showStartupWarning(rig);
		addAll(rig, conversation(noAgentMessages(), processMode));
		const [summary] = turnSummaries(rig) as TurnSummaryComponent[];
		expect(summary).toBeDefined();
		expect(summary.state.commMessageCount).toBe(0);

		rig.press(ALT_P);

		expect(rig.toasts).toEqual([NOTHING_TO_EXPAND]);
		expect(summary.state.agentMessagesExpanded).toBe(false);
	});

	it("does not take a tool call for an agent message", () => {
		const rig = createRig(processMode);
		addAll(
			rig,
			conversation(
				[prompt(1_000), toolCall("t1", "bash", { command: "ls" }, 1_100), toolResult("t1", "bash", 1_200)],
				processMode,
			),
		);
		expect(rig.chat.children.length).toBeGreaterThan(1);

		rig.press(ALT_P);

		expect(rig.toasts).toEqual([NOTHING_TO_EXPAND]);
	});

	it("says it again on the second press instead of flipping a lane nobody can see", () => {
		const rig = createRig(processMode);
		addAll(rig, conversation(noAgentMessages(), processMode));

		rig.press(ALT_P);
		rig.press(ALT_P);

		expect(rig.toasts).toEqual([NOTHING_TO_EXPAND, NOTHING_TO_EXPAND]);
	});

	it("opens every turn's received agent messages when one turn holds one", () => {
		const rig = createRig(processMode);
		showStartupWarning(rig);
		addAll(
			rig,
			conversation(
				[
					...noAgentMessages(),
					prompt(2_000, "and again"),
					toolCall("t2", "bash", { command: "pwd" }, 2_100),
					toolResult("t2", "bash", 2_200),
					receivedAgentMessage("agentmsg_second_turn", 2_250),
					finalAnswer(2_300),
				],
				processMode,
			),
		);
		const summaries = turnSummaries(rig) as TurnSummaryComponent[];
		expect(summaries).toHaveLength(2);
		expect(summaries.map((summary) => summary.state.commMessageCount)).toEqual([0, 1]);
		expect(rig.rendered()).not.toContain(OPEN_ONLY_MARKER);

		rig.press(ALT_P);

		expect(rig.toasts).toEqual([]);
		expect(rig.rendered()).toContain(OPEN_ONLY_MARKER);
		expect(summaries.map((summary) => summary.state.agentMessagesExpanded)).toEqual([true, true]);

		rig.press(ALT_P);
		expect(rig.toasts).toEqual([]);
		expect(rig.rendered()).not.toContain(OPEN_ONLY_MARKER);
	});

	it("counts a message the model sent from a cell as an agent message", () => {
		const rig = createRig(processMode);
		const sent = {
			id: "agentmsg_sent_from_cell",
			message: "handing the log over",
			deliveryStatus: "delivered",
			receiverRole: "child",
			target: { activeSessionId: "child-active", sessionId: "child-session" },
		};
		addAll(
			rig,
			conversation(
				[
					prompt(1_000),
					toolCall("cell-1", "ipython", { code: "send_message('child', 'handing the log over')" }, 1_100),
					toolResult("cell-1", "ipython", 1_200, { sentAgentMessages: [sent] }),
					finalAnswer(1_300),
				],
				processMode,
			),
		);
		const [summary] = turnSummaries(rig) as TurnSummaryComponent[];
		expect(summary.state.commMessageCount).toBe(1);

		rig.press(ALT_P);

		expect(rig.toasts).toEqual([]);
		expect(summary.state.agentMessagesExpanded).toBe(true);
	});
});

describe("Alt+P on the live legacy shape of a turn that sent a message from a cell (FIX-19)", () => {
	// The live path never calls addCommMessage for a message the model sends from a cell: the turn
	// head's count stays 0 and only the tool block's own result carries the sent message.
	const SENT_BODY = `${"handing the log over ".repeat(8)}\nSECOND-LINE-MARKER of the body`;

	function liveTurnWithSentMessage(): { rig: Rig; summary: TurnSummaryComponent } {
		const rig = createRig("legacy");
		const state = new TurnActivityState(1_000);
		state.boxMode = false;
		const summary = new TurnSummaryComponent(state);
		rig.chat.addChild(summary);
		const tool = new ToolExecutionComponent(
			"ipython",
			"cell-1",
			{ code: "send_message('child', 'x')" },
			{},
			undefined,
			{ requestRender: vi.fn(), isFullscreen: () => false } as unknown as TUI,
			"/tmp",
		);
		tool.setTurnActivity(state);
		state.addStep({ toolCallId: "cell-1", toolName: "ipython", args: {}, status: "running" });
		tool.markExecutionStarted();
		tool.updateResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					status: "ok",
					durationMs: 5,
					sentAgentMessages: [
						{
							id: "agentmsg_live_sent",
							message: SENT_BODY,
							deliveryStatus: "delivered",
							receiverRole: "child",
							target: { activeSessionId: "child-active", sessionId: "child-session" },
						},
					],
				},
				isError: false,
			},
			false,
		);
		state.setStepStatus("cell-1", "done", 1_200);
		summary.setExpanded(true);
		tool.setExpanded(true);
		rig.chat.addChild(tool);
		return { rig, summary };
	}

	it("opens the sent message instead of saying there is none", () => {
		const { rig, summary } = liveTurnWithSentMessage();
		expect(summary.state.commMessageCount).toBe(0);
		expect(rig.rendered()).toContain("已发消息");
		expect(rig.rendered()).not.toContain("SECOND-LINE-MARKER");

		rig.press(ALT_P);

		expect(rig.toasts).toEqual([]);
		expect(rig.rendered()).toContain("SECOND-LINE-MARKER");
	});
});
