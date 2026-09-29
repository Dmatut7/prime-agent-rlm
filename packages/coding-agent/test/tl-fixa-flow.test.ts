import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { subagentNoticeRow } from "../src/modes/interactive/components/system-notice.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { built, replay, summariesOf } from "./tl-fd-helpers.js";
import { assistant, plain, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

const screenOf = (children: readonly Component[], width = 100) =>
	plain(children.flatMap((child) => child.render(width))).join("\n");

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

const ASK = "现在进度如何？";
const SHORT_ANSWER = "查过了，这条通知不用处理。";

function noticeFor(name: string, at: number) {
	return createRlmChildTerminalNoticeMessage(
		{ kind: "completed_without_reply", childId: `${name}-id`, sessionName: name },
		at,
	);
}

/** The owner asks, a subagent's notice lands before the AI's first word, and the AI answers in one short line. */
function askedThenNotified(): AgentMessage[] {
	return [
		{ role: "user", content: ASK, timestamp: T0 },
		noticeFor("review-grow-C-strip", T0 + 500),
		assistant(T0 + 1_000, [{ type: "text", text: SHORT_ANSWER }], "stop"),
	];
}

describe("a turn the owner opened stays the owner's when a report lands before the first answer", () => {
	it("keeps the short answer of the live run on screen, in a turn the owner started", () => {
		const chat = new LiveChat();
		chat.user(ASK);
		const notice = noticeFor("review-grow-C-strip", T0 + 500);
		if (!chat.flow.customMessage(notice)) {
			const row = subagentNoticeRow(notice, chat.flow.subagentLane);
			if (row && !chat.flow.placeRow(row, T0 + 500)) chat.chat.addChild(row);
		}
		chat.say(T0 + 1_000, { words: SHORT_ANSWER });
		expect(screenOf(chat.chat.children)).toContain(SHORT_ANSWER);
		chat.endRun();
		vi.advanceTimersByTime(1_000);
		expect(summariesOf(chat.chat.children).map((summary) => summary.state.startedByUser)).toEqual([true]);
		expect(screenOf(chat.chat.children)).toContain(SHORT_ANSWER);
		chat.flow.dispose();
	});

	it("also keeps a turn the owner opened when a subagent's report, not a notice, lands first", () => {
		const chat = new LiveChat();
		chat.user(ASK);
		chat.report(handedBack("m1", T0 + 500, "review-grow-A-tui"));
		chat.say(T0 + 1_000, { words: SHORT_ANSWER });
		chat.endRun();
		vi.advanceTimersByTime(1_000);
		expect(summariesOf(chat.chat.children).map((summary) => summary.state.startedByUser)).toEqual([true]);
		expect(screenOf(chat.chat.children)).toContain(SHORT_ANSWER);
		chat.flow.dispose();
	});

	it("draws the same short answer when the conversation is rebuilt from messages", () => {
		const children = built(askedThenNotified());
		expect(summariesOf(children).map((summary) => summary.state.startedByUser)).toEqual([true]);
		expect(screenOf(children)).toContain(SHORT_ANSWER);
	});

	it("draws the same short answer when the mode replays the session", async () => {
		const host = await replay(askedThenNotified());
		expect(summariesOf(host.chatContainer.children).map((summary) => summary.state.startedByUser)).toEqual([true]);
		expect(screenOf(host.chatContainer.children)).toContain(SHORT_ANSWER);
	});

	it("still hides the short reply of a round only a notice of a subagent that had reported woke", () => {
		const children = built([
			{ role: "user", content: ASK, timestamp: T0 },
			handedBack("m0", T0 + 500, "review-grow-C-strip"),
			assistant(T0 + 1_000, [{ type: "text", text: "都在跑，稍等。" }], "stop"),
			noticeFor("review-grow-C-strip", T0 + 2_000),
			assistant(T0 + 3_000, [{ type: "text", text: SHORT_ANSWER }], "stop"),
		]);
		expect(summariesOf(children).map((summary) => summary.state.startedByUser)).toEqual([true, false]);
		expect(screenOf(children)).not.toContain(SHORT_ANSWER);
	});
});

const CALL_ID = "t1";
const REPORT_TEXT = "车道A（钉住框头）审查完成。\n结论：没问题。";

function report(at: number): AgentSessionMessage {
	return handedBack("m1", at, "review-grow-A-tui", REPORT_TEXT);
}

function toolResult(at: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: CALL_ID,
		toolName: "ipython",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: at,
	};
}

function toolCall(at: number): AgentMessage {
	return assistant(
		at,
		[{ type: "toolCall", id: CALL_ID, name: "ipython", arguments: { code: "await bash('sleep 30')" } }],
		"toolUse",
	);
}

/** The report reaches the parent while the command still runs: the file has it between the call and its result. */
function reportInsideStep(): AgentMessage[] {
	return [
		{ role: "user", content: "审查", timestamp: T0 },
		toolCall(T0 + 1_000),
		report(T0 + 2_000),
		toolResult(T0 + 3_000),
		assistant(T0 + 4_000, [{ type: "text", text: "收到，继续。" }], "stop"),
	];
}

function stepStatuses(children: readonly Component[]): string[] {
	return summariesOf(children).flatMap((summary) => summary.state.steps.map((step) => step.status));
}

function chatLevelReports(children: readonly Component[]): number {
	return children.filter((child) => child instanceof AgentMessageComponent).length;
}

describe("a report that lands in the middle of a command keeps the command's turn whole", () => {
	it("rebuilds one turn with the step done and the report inside it", () => {
		const children = built(reportInsideStep());
		expect(summariesOf(children)).toHaveLength(1);
		expect(stepStatuses(children)).toEqual(["done"]);
		expect(chatLevelReports(children)).toBe(0);
		expect(screenOf(summariesOf(children), 100)).toContain("没问题");
	});

	it("rebuilds the same turn after a compaction", async () => {
		const host = await replay(reportInsideStep(), { clearChat: true, keepCompactedHistory: true });
		const children = host.chatContainer.children;
		expect(summariesOf(children)).toHaveLength(1);
		expect(stepStatuses(children)).toEqual(["done"]);
		expect(chatLevelReports(children)).toBe(0);
	});

	it("rebuilds the same turn when the connection comes back", async () => {
		const host = await replay(reportInsideStep(), { clearChat: true, updateFooter: true });
		const again = await replay(reportInsideStep(), { clearChat: true, updateFooter: true }, host);
		const children = again.chatContainer.children;
		expect(summariesOf(children)).toHaveLength(1);
		expect(stepStatuses(children)).toEqual(["done"]);
		expect(chatLevelReports(children)).toBe(0);
	});

	it("keeps the running turn live when a view attaches while the command still runs", async () => {
		const host = await replay(
			[{ role: "user", content: "审查", timestamp: T0 }, toolCall(T0 + 1_000), report(T0 + 2_000)],
			{ updateFooter: true, populateHistory: true, limitTranscript: true },
		);
		const children = host.chatContainer.children;
		expect(summariesOf(children)).toHaveLength(1);
		expect(stepStatuses(children)).toEqual(["running"]);
		expect(chatLevelReports(children)).toBe(0);
		expect(host.currentTurnState?.live).toBe(true);
	});

	it("still starts a new turn for a report that follows a finished step's answer", () => {
		const children = built([
			{ role: "user", content: "审查", timestamp: T0 },
			toolCall(T0 + 1_000),
			toolResult(T0 + 2_000),
			assistant(T0 + 3_000, [{ type: "text", text: "跑完了。" }], "stop"),
			report(T0 + 4_000),
			assistant(T0 + 5_000, [{ type: "text", text: "收到，继续。" }], "stop"),
		]);
		expect(summariesOf(children)).toHaveLength(2);
		expect(chatLevelReports(children)).toBe(1);
	});
});

describe("two messages stamped in the same millisecond are two rows", () => {
	const FIRST = "先看目录里有什么。";
	const SECOND = "再看日志里有什么。";

	function twoCalls() {
		return [
			assistant(
				T0 + 1_000,
				[
					{ type: "text", text: FIRST },
					{ type: "toolCall", id: "k1", name: "ipython", arguments: { code: "await bash('ls')" } },
				],
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "k1",
				toolName: "ipython",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: T0 + 1_500,
			} as AgentMessage,
			assistant(
				T0 + 1_000,
				[
					{ type: "text", text: SECOND },
					{ type: "toolCall", id: "k2", name: "ipython", arguments: { code: "await bash('tail log')" } },
				],
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "k2",
				toolName: "ipython",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: T0 + 2_500,
			} as AgentMessage,
			assistant(T0 + 3_000, [{ type: "text", text: "都看完了。" }], "stop"),
		];
	}

	it("keeps both of a live run's words in the box", () => {
		const chat = new LiveChat();
		chat.user("看一下");
		chat.say(T0 + 1_000, {
			words: FIRST,
			calls: [{ id: "k1", code: "await bash('ls')", endsAt: T0 + 1_500 }],
		});
		chat.say(T0 + 1_000, {
			words: SECOND,
			calls: [{ id: "k2", code: "await bash('tail log')", endsAt: T0 + 2_500 }],
		});
		const screen = screenOf(chat.chat.children);
		expect(screen).toContain(FIRST);
		expect(screen).toContain(SECOND);
		chat.flow.dispose();
	});

	it("keeps both when the conversation is rebuilt from messages", () => {
		const children = built([{ role: "user", content: "看一下", timestamp: T0 }, ...twoCalls()]);
		const screen = screenOf(children);
		expect(screen).toContain(FIRST);
		expect(screen).toContain(SECOND);
	});

	it("keeps both when the mode replays the session", async () => {
		const host = await replay([{ role: "user", content: "看一下", timestamp: T0 }, ...twoCalls()]);
		const screen = screenOf(host.chatContainer.children);
		expect(screen).toContain(FIRST);
		expect(screen).toContain(SECOND);
	});
});

describe("a subagent with no name and no session id is not put on the lane", () => {
	it("never sticks the lane on, and a report from it leaves the lane as it was", () => {
		const chat = new LiveChat();
		chat.user("审查");
		chat.say(T0 + 1_000, {
			words: "派一个代理。",
			calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: {} }],
		});
		chat.child({ id: "child-Z", label: "Z 的任务", status: "running", sessionDir: "/tmp/Z" });
		expect(chat.flow.subagentLane.tracker.pending).toEqual([]);
		expect(chat.flow.subagentLane.tracker.active).toBe(false);
		chat.report(
			createAgentSessionMessage(
				{
					id: "z1",
					source: AGENT_MESSAGE_SOURCE,
					message: "审查完成。\n结论：没问题。",
					from: { sessionId: "z-session", activeSessionId: "Z-active" },
					fromRelationship: "child",
					target: { activeSessionId: "main-active", sessionId: "main" },
				},
				T0 + 2_000,
			),
		);
		expect(chat.flow.subagentLane.tracker.active).toBe(false);
		chat.flow.dispose();
	});

	it("puts it on the lane from the snapshot that first carries its session id, and a report from it releases it", () => {
		const chat = new LiveChat();
		chat.user("审查");
		chat.say(T0 + 1_000, {
			words: "派一个代理。",
			calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: {} }],
		});
		const child = { id: "child-Z", label: "Z 的任务", status: "running" as const, sessionDir: "/tmp/Z" };
		chat.child(child);
		expect(chat.flow.subagentLane.tracker.pending).toEqual([]);
		chat.child({ ...child, activeSessionId: "Z-active" });
		expect(chat.flow.subagentLane.tracker.pending).toEqual(["Z-active"]);
		chat.child({ ...child, activeSessionId: "Z-active" });
		expect(chat.flow.subagentLane.tracker.pending).toEqual(["Z-active"]);
		chat.report(
			createAgentSessionMessage(
				{
					id: "z2",
					source: AGENT_MESSAGE_SOURCE,
					message: "审查完成。\n结论：没问题。",
					from: { sessionId: "z-session", activeSessionId: "Z-active" },
					fromRelationship: "child",
					target: { activeSessionId: "main-active", sessionId: "main" },
				},
				T0 + 2_000,
			),
		);
		expect(chat.flow.subagentLane.tracker.active).toBe(false);
		chat.flow.dispose();
	});

	it("still puts a named subagent on the lane", () => {
		const chat = new LiveChat();
		chat.user("审查");
		chat.say(T0 + 1_000, {
			words: "派一个代理。",
			calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: {} }],
		});
		chat.child({ id: "child-A", label: "A 的任务", sessionName: "A", status: "running", sessionDir: "/tmp/A" });
		expect(chat.flow.subagentLane.tracker.pending).toEqual(["A"]);
		chat.flow.dispose();
	});
});
