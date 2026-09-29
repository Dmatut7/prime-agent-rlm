import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, Spacer, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import {
	buildConversationComponents,
	giveLane,
	giveLaneTracker,
	isWakeMessage,
} from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { TimelineNoticeRow } from "../src/modes/interactive/components/system-notice.js";
import type { TimelineLane } from "../src/modes/interactive/components/timeline-gutter.js";
import { TimelineLaneTracker } from "../src/modes/interactive/components/timeline-lane.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { assistant, plain, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

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
});

const LONG_ANSWER = "审查完成：四个车道都收口了，这批代码本身没问题，但发版把一个测试弄红了，远程检查现在是红的。";
const ACK = "查过了，这条通知不用处理。";

/** What the chat is, one entry per component: the same words say the same layout live and replayed. */
function outline(children: readonly Component[]): string[] {
	const out: string[] = [];
	for (const child of children) {
		if (child instanceof Spacer) continue;
		const text = plain(child.render(100))
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

function replayed(messages: AgentMessage[]): Component[] {
	return buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
	});
}

function noticeFor(name: string, at: number): AgentMessage {
	return createRlmChildTerminalNoticeMessage(
		{ kind: "completed_without_reply", childId: `${name}-id`, sessionName: name },
		at,
	);
}

function transcript(): AgentMessage[] {
	return [
		{ role: "user", content: "对最近的改动做全面的审查", timestamp: T0 },
		assistant(T0 + 1_000, [{ type: "text", text: "派出去了，等它们交回。" }], "stop"),
		handedBack("m1", T0 + 2_000, "review-grow-A-tui"),
		handedBack("m2", T0 + 3_000, "review-grow-B-box"),
		assistant(T0 + 4_000, [{ type: "text", text: LONG_ANSWER }], "stop"),
		noticeFor("review-grow-C-strip", T0 + 5_000),
		assistant(T0 + 6_000, [{ type: "text", text: ACK }], "stop"),
	];
}

function liveRun(): LiveChat {
	const chat = new LiveChat();
	chat.prompt("对最近的改动做全面的审查", { answer: "派出去了，等它们交回。" });
	chat.wake("m1", {
		name: "review-grow-A-tui",
		also: [{ id: "m2", name: "review-grow-B-box" }],
		answer: LONG_ANSWER,
	});
	chat.wakeByNotice("review-grow-C-strip", { answer: ACK });
	vi.advanceTimersByTime(1_000);
	return chat;
}

describe("the answer a turn ends on is never taken over by the turn a message wakes", () => {
	it("keeps the long conclusion under its own turn when a silent subagent's notice wakes the AI afterwards", () => {
		const chat = new LiveChat();
		chat.prompt("对最近的改动做全面的审查", { answer: LONG_ANSWER });
		chat.wakeByNotice("review-grow-C-strip", { answer: ACK });
		vi.advanceTimersByTime(1_000);
		expect(chat.summaries()).toHaveLength(2);
		expect(chat.summaries().map((summary) => summary.state.startedByUser)).toEqual([true, false]);
		const answers = chat.chat.children.filter((child) => child instanceof AssistantMessageComponent);
		expect(answers).toHaveLength(2);
		expect(plain(answers[0]?.render(100) ?? []).join("\n")).toContain(LONG_ANSWER);
		expect(plain(answers[1]?.render(100) ?? []).join("\n")).toContain(ACK);
		chat.flow.dispose();
	});

	it("does not fold the notice into the box of the turn it woke either", () => {
		const chat = new LiveChat();
		chat.prompt("跑一下", { answer: "好了。" });
		chat.wakeByNotice("review-grow-C-strip", { answer: ACK });
		vi.advanceTimersByTime(1_000);
		const text = plain(chat.lines()).join("\n");
		expect(text).not.toContain("没发回消息");
		expect(text).not.toContain("RLM child");
		expect(chat.chat.children.some((child) => child instanceof TimelineNoticeRow)).toBe(true);
		chat.flow.dispose();
	});

	it("carries a run on in the same turn when the previous run stopped right after a step to take a message", () => {
		const chat = new LiveChat();
		chat.prompt("跑一个很久的命令");
		const before = chat.summaries().length;
		chat.flow.agentStart();
		const step = assistant(
			T0 + 90_000,
			[{ type: "toolCall", id: "t1", name: "ipython", arguments: { code: "1" } }],
			"toolUse",
		);
		chat.flow.assistantStart(step);
		chat.flow.assistantEnd(step);
		chat.flow.agentEnd();
		chat.flow.agentStart();
		// The run was cut after a step: a report that arrives now belongs to the same request.
		expect(chat.flow.customMessage(handedBack("m9", T0 + 91_000))).toBe(false);
		chat.flow.assistantStart(assistant(T0 + 92_000, [{ type: "text", text: "收到。" }], "stop"));
		expect(chat.summaries()).toHaveLength(before);
		chat.flow.dispose();
	});
});

describe("a live run and its replay draw the same layout", () => {
	it("draws the same turns, reports, notices and answers in the same order", () => {
		const live = liveRun();
		const replay = outline(replayed(transcript()));
		expect(outline(live.chat.children)).toEqual(replay);
		live.flow.dispose();
	});

	it("has three turns, the woken ones not the owner's, and the conclusion drawn as an answer", () => {
		const layout = outline(replayed(transcript()));
		expect(layout.filter((entry) => entry.startsWith("turn("))).toEqual([
			"turn(byUser=true)",
			"turn(byUser=false)",
			"turn(byUser=false)",
		]);
		expect(layout.filter((entry) => entry.startsWith("report: "))).toHaveLength(2);
		expect(layout.some((entry) => entry.startsWith("notice: "))).toBe(true);
		expect(layout.find((entry) => entry.includes(LONG_ANSWER))?.startsWith("answer: ")).toBe(true);
		expect(layout.filter((entry) => entry === "answer: (nothing drawn)")).toEqual([]);
	});

	it("leaves the layout of a chat that nothing woke as it was", () => {
		const chat = new LiveChat();
		chat.prompt("你好", { answer: "在的。" });
		chat.prompt("再来", { answer: "好。" });
		vi.advanceTimersByTime(1_000);
		const messages: AgentMessage[] = [
			{ role: "user", content: "你好", timestamp: T0 },
			assistant(T0 + 1_000, [{ type: "text", text: "在的。" }], "stop"),
			{ role: "user", content: "再来", timestamp: T0 + 2_000 },
			assistant(T0 + 3_000, [{ type: "text", text: "好。" }], "stop"),
		];
		expect(outline(chat.chat.children)).toEqual(outline(replayed(messages)));
		chat.flow.dispose();
	});
});

describe("the subagent lane while a request runs", () => {
	it("draws the dotted lane under the rows until the last subagent is back, live", () => {
		const chat = new LiveChat();
		chat.prompt("审查", { answer: "派出去了。" });
		chat.dispatch("review-grow-A-tui", "review-grow-B-box");
		chat.wake("m1", { name: "review-grow-A-tui", answer: undefined });
		vi.advanceTimersByTime(1_000);
		const rows = plain(chat.lines()).map((line) => line.trimEnd());
		expect(rows.some((line) => line === "         │  ┆")).toBe(true);
		expect(rows.some((line) => /^ \d\d:\d\d {3}│ {2}◇ {3}A 交回/.test(line))).toBe(true);
		expect(rows.some((line) => line.includes("├──╯"))).toBe(false);
		chat.wake("m2", { name: "review-grow-B-box", answer: undefined });
		const after = plain(chat.lines()).map((line) => line.trimEnd());
		expect(after.filter((line) => line === "         ├──╯   两个都交回了")).toHaveLength(1);
		chat.flow.dispose();
	});

	it("forgets who is out when the owner asks something new", () => {
		const chat = new LiveChat();
		chat.prompt("审查", { answer: "派出去了。" });
		chat.dispatch("review-grow-A-tui");
		expect(chat.flow.subagentLane.tracker.active).toBe(true);
		chat.prompt("换个话题", { answer: "好。" });
		expect(chat.flow.subagentLane.tracker.active).toBe(false);
		chat.flow.dispose();
	});

	it("lets a subagent that failed or finished without a word go from the lane", () => {
		const chat = new LiveChat();
		chat.prompt("审查", { answer: "派出去了。" });
		chat.dispatch("review-grow-A-tui", "review-grow-C-strip");
		chat.wakeByNotice("review-grow-C-strip", { failed: true, answer: undefined });
		expect(chat.flow.subagentLane.tracker.pending).toEqual(["review-grow-A-tui"]);
		chat.wakeByNotice("review-grow-A-tui", { answer: undefined });
		expect(chat.flow.subagentLane.tracker.active).toBe(false);
		const rows = plain(chat.lines()).map((line) => line.trimEnd());
		expect(rows.some((line) => line.includes("子代理 review-grow-C-strip 失败（出错）"))).toBe(true);
		expect(rows.filter((line) => line === "         ├──╯   两个都交回了")).toHaveLength(1);
		chat.flow.dispose();
	});
});

describe("the calls that hand the lane to the parts other lines own", () => {
	it("calls setLane and setLaneTracker on a component that has them and leaves any other alone", () => {
		const calls: string[] = [];
		const takes: Component & {
			setLane(lane: TimelineLane): void;
			setLaneTracker(tracker: TimelineLaneTracker): void;
		} = {
			render: () => [],
			invalidate: () => {},
			setLane: (lane) => calls.push(`lane:${lane}`),
			setLaneTracker: () => calls.push("tracker"),
		};
		const plainComponent: Component = { render: () => [], invalidate: () => {} };
		giveLane(takes, "on");
		giveLaneTracker(takes, new TimelineLaneTracker());
		giveLane(plainComponent, "on");
		giveLaneTracker(plainComponent, new TimelineLaneTracker());
		expect(calls).toEqual(["lane:on", "tracker"]);
	});

	it("takes a subagent's report or notice as a message that wakes the AI, and a plain reply as none", () => {
		const message: AgentSessionMessage = createAgentSessionMessage({
			id: "x",
			source: AGENT_MESSAGE_SOURCE,
			message: "hi",
			from: { sessionName: "A", sessionId: "a" },
			fromRelationship: "child",
			target: { activeSessionId: "m", sessionId: "m" },
		});
		expect(isWakeMessage(message)).toBe(true);
		expect(isWakeMessage(noticeFor("A", T0))).toBe(true);
		expect(isWakeMessage(assistant(T0, [{ type: "text", text: "x" }], "stop"))).toBe(false);
		expect(isWakeMessage({ role: "user", content: "x", timestamp: T0 })).toBe(false);
	});
});
