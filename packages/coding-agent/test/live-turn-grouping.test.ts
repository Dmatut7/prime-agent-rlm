import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TOOL_ABORT_FALLBACK_MESSAGE } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { HEARTBEAT_PROMPT_CUSTOM_TYPE, type HeartbeatPromptMessage } from "../src/core/messages.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { at } from "./tl-fc-host.js";
import { assistant, text, useTruecolorTheme } from "./ui-blocks-helpers.js";
import { LiveChat } from "./ui-live-chat.js";

/**
 * Which box a message joins, on the live path, where the transcript says something the view cannot
 * see: a stored heartbeat prompt arrives as a plain user message (R3-M17), and a stop from another
 * view leaves nothing but its abort stub on the step it caught (R3-M18). Both used to be read as
 * "the owner cut in", which the replay of the same transcript never does - so the two faces of one
 * session grouped the same messages differently.
 */

const WIDTH = 160;
const LANE_B = "review-grow-B-box";
const LANE_C = "review-grow-C-strip";
const HEARTBEAT_TEXT = "看看夜里的构建有没有红，红的就报。";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => restoreTheme());

/** The notice a stored heartbeat prompt stands for (its content is the job's own prompt). */
function heartbeatPrompt(timestamp: number): HeartbeatPromptMessage {
	return {
		role: "custom",
		customType: HEARTBEAT_PROMPT_CUSTOM_TYPE,
		content: HEARTBEAT_TEXT,
		display: true,
		details: { jobId: "nightly-build", schedule: "every 30m", status: "active", runCount: 4 },
		timestamp,
	};
}

function roundsOf(components: readonly unknown[]): TurnSummaryComponent[] {
	return components.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);
}

function replay(messages: readonly AgentMessage[], ownerOpened: (message: AgentMessage) => boolean) {
	return buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
		hooks: {
			// What the interactive mode's own hook says of a stored heartbeat prompt.
			renderUserPrompt: (message) => (ownerOpened(message) ? undefined : { components: [], ownerOpened: false }),
		},
	});
}

function words(message: AgentMessage): string {
	if (message.role !== "user") return "";
	return typeof message.content === "string"
		? message.content
		: message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("the round a heartbeat prompt wakes", () => {
	it("keeps the lane of the question still running, and is not stamped as the owner's", () => {
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.prompt("派个代理审查这批改动", { answer: "派出去了，等它交回。" });
		chat.dispatch(LANE_B);
		const owner = chat.summaries();
		expect(owner).toHaveLength(1);
		expect(owner[0]!.state.startedByUser).toBe(true);
		expect(chat.flow.subagentLane.tracker.pending).toEqual([LANE_B]);

		chat.heartbeatPrompt(heartbeatPrompt(at(19, 0)), { answer: "构建是绿的。" });

		// The heartbeat woke a round of its own: the lane the question opened is still open, so the
		// "还在干活" row and the `──╯` that closes it survive the round in between.
		expect(chat.flow.subagentLane.tracker.pending).toEqual([LANE_B]);
		const rounds = chat.summaries();
		expect(rounds).toHaveLength(2);
		expect(rounds[0]!.state.startedByUser).toBe(true);
		expect(rounds[1]!.state.startedByUser).toBe(false);

		chat.wake("r1", { name: LANE_B, answer: "审查完毕：没问题。" });
		expect(text(chat.lines(WIDTH))).toContain("──╯");
		expect(chat.flow.subagentLane.tracker.pending).toEqual([]);
	});

	it("keeps the settle the lane recorded before it for the report that follows it", () => {
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.prompt("派两个代理审查", { answer: "派出去了。" });
		chat.dispatch(LANE_B, LANE_C);
		// C's terminal snapshot closed it out of band while the parent was between runs: the ledger
		// holds that settle for the next return to count into the round (agent-message.ts comeBack).
		chat.flow.subagentLane.tracker.settle(LANE_C, at(18, 55), "silent");

		chat.heartbeatPrompt(heartbeatPrompt(at(19, 0)), { answer: "构建是绿的。" });
		expect(chat.flow.subagentLane.tracker.pending).toEqual([LANE_B]);

		chat.wake("r1", { name: LANE_B, answer: "审查完毕：没问题。" });
		const rows = text(chat.lines(WIDTH));
		// B's report closes the lane, and the round's count still carries the settle the ledger kept.
		expect(rows).toContain("──╯");
		expect(rows).toContain("两个都回来了（1 个没发回消息）");
	});

	it("stamps the round the way a replay of the same transcript does", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "派个代理审查这批改动", timestamp: at(18, 47) },
			assistant(at(18, 48), [{ type: "text", text: "派出去了，等它交回。" }], "stop"),
			{ role: "user", content: HEARTBEAT_TEXT, timestamp: at(19, 0) },
			assistant(at(19, 1), [{ type: "text", text: "构建是绿的。" }], "stop"),
		];
		const rounds = roundsOf(replay(messages, (message) => words(message) !== HEARTBEAT_TEXT));
		expect(rounds).toHaveLength(2);
		expect(rounds[0]!.state.startedByUser).toBe(true);
		expect(rounds[1]!.state.startedByUser).toBe(false);
	});
});

describe("a stop from another view", () => {
	it("ends the group there: the next question opens a box of its own", () => {
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.prompt("跑一遍检查", { answer: "开始了。" });
		chat.stoppedInAnotherView(
			at(18, 50),
			{ id: "c1", code: "await bash('npm run check')" },
			{ words: "先跑一遍检查。" },
		);
		// The owner asks on inside the settle window, before that box has said 已停止 for itself.
		chat.prompt("那先看测试", { answer: "好。" });

		const rounds = chat.summaries();
		expect(rounds).toHaveLength(2);
		expect(text(chat.lines(WIDTH))).not.toContain("你插话");
		expect(rounds[0]!.state.timeline.stopped).toBe(true);
		expect(rounds[1]!.state.startedByUser).toBe(true);
	});

	it("keeps an interjection inside the box when the run really did stop to take it", () => {
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.prompt("把依赖都升级", { answer: "开始了。" });
		// The run went on: a step settled cleanly, so a message typed meanwhile is an interjection.
		chat.say(at(18, 50), {
			words: "先看有哪些能升。",
			calls: [{ id: "c1", code: "await bash('go list -m -u all')", text: "14 个可升级" }],
		});
		chat.prompt("先别动安卓的", { answer: "好，只升级 Go。" });
		expect(chat.summaries()).toHaveLength(1);
		expect(text(chat.lines(WIDTH))).toContain("你插话");
	});

	it("groups the same transcript the way the live view now does", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "跑一遍检查", timestamp: at(18, 47) },
			assistant(at(18, 48), [{ type: "text", text: "开始了。" }], "stop"),
			assistant(at(18, 50), [
				{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "await bash('npm run check')" } },
			]),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ipython",
				content: [{ type: "text", text: TOOL_ABORT_FALLBACK_MESSAGE }],
				isError: true,
				timestamp: at(18, 51),
			} satisfies ToolResultMessage,
			{ role: "user", content: "那先看测试", timestamp: at(18, 52) },
			assistant(at(18, 53), [{ type: "text", text: "好。" }], "stop"),
		];
		const components = replay(messages, () => true);
		expect(roundsOf(components)).toHaveLength(2);
		expect(text(components.flatMap((child) => child.render(WIDTH)))).not.toContain("你插话");
	});
});
