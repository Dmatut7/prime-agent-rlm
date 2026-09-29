import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { built, screenLines, summariesOf } from "./tl-fd-helpers.js";
import { assistant, plain, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

/**
 * A subagent's report, or the owner's own words, landing while the run's first reply is still
 * streaming a tool call sits inside that step, live as in a replay: the round is not closed, the
 * message is not moved out of it, and the step is counted once.
 */

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

const CODE = "await bash('sleep 60')";
const TOOL_CALL = [{ type: "toolCall" as const, id: "k1", name: "ipython", arguments: { code: CODE } }];
// The provider's stop reason is only settled when the message ends; while it streams it still reads "stop".
const streaming = () => assistant(T0 + 1_000, TOOL_CALL, "stop");
const ended = () => assistant(T0 + 1_000, TOOL_CALL, "toolUse");
const RESULT = { details: {}, content: [{ type: "text" as const, text: "ok" }] };

function openStreamingStep(chat: LiveChat): void {
	chat.user("跑一下");
	chat.flow.assistantStart(streaming());
	chat.flow.assistantUpdate(streaming(), { type: "toolcall_start", contentIndex: 0, partial: streaming() });
}

function finishRun(chat: LiveChat): void {
	chat.flow.assistantEnd(ended());
	chat.flow.toolStart("k1", "ipython", { code: CODE });
	chat.flow.toolEnd("k1", "ipython", RESULT, false);
	chat.say(T0 + 3_000, { words: "跑完了。" });
	chat.endRun();
	vi.advanceTimersByTime(1_000);
}

function transcript(): AgentMessage[] {
	return [
		{ role: "user", content: "跑一下", timestamp: T0 },
		ended(),
		handedBack("p1", T0 + 1_500, "child-A"),
		{
			role: "toolResult",
			toolCallId: "k1",
			toolName: "ipython",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: T0 + 2_000,
		},
		assistant(T0 + 3_000, [{ type: "text", text: "跑完了。" }], "stop"),
	];
}

describe("a report that lands while the first reply streams a tool call", () => {
	it("does not close the round: no closing row, one round, the step still queued in it", () => {
		const chat = new LiveChat();
		openStreamingStep(chat);
		chat.report(handedBack("p1", T0 + 1_500, "child-A"));
		expect(chat.summaries()).toHaveLength(1);
		const round = chat.summaries()[0];
		expect(round?.state.timeline.finishedAt).toBeUndefined();
		expect(round?.state.steps.map((step) => `${step.toolCallId}:${step.status}`)).toEqual(["k1:queued"]);
		expect(plain(chat.lines()).some((line) => line.includes("╵"))).toBe(false);
		chat.flow.dispose();
	});

	it("counts the command once and keeps the report inside the round until the end", () => {
		const chat = new LiveChat();
		openStreamingStep(chat);
		chat.report(handedBack("p1", T0 + 1_500, "child-A"));
		finishRun(chat);
		expect(chat.summaries()).toHaveLength(1);
		expect(chat.summaries()[0]?.state.steps.map((step) => `${step.toolCallId}:${step.status}`)).toEqual(["k1:done"]);
		const lines = plain(chat.lines()).map((line) => line.trimEnd());
		expect(lines.filter((line) => line.includes("A 交回"))).toHaveLength(1);
		expect(lines.filter((line) => line.includes("╵"))).toHaveLength(1);
		expect(lines.at(-1)).toMatch(/╵/);
		chat.flow.dispose();
	});

	it("draws the same lines as the replay of the same transcript", () => {
		const chat = new LiveChat();
		openStreamingStep(chat);
		chat.report(handedBack("p1", T0 + 1_500, "child-A"));
		finishRun(chat);
		const live = screenLines(chat.chat.children);
		const replayed = screenLines(built(transcript()));
		expect(live.length).toBeGreaterThan(0);
		expect(live).toEqual(replayed);
		expect(summariesOf(chat.chat.children)).toHaveLength(summariesOf(built(transcript())).length);
		chat.flow.dispose();
	});
});

describe("the owner's words while the first reply streams a tool call", () => {
	it("are a steer in the running round, not a new question", () => {
		const chat = new LiveChat();
		openStreamingStep(chat);
		expect(chat.flow.userMessage("等一下，先别删", T0 + 1_400)).toBe("interjection");
		expect(chat.summaries()).toHaveLength(1);
		chat.flow.dispose();
	});
});

describe("what still splits a round", () => {
	it("a report after the round settled on a plain answer starts a round of its own", () => {
		const chat = new LiveChat();
		chat.prompt("你好", { answer: "在的。" });
		vi.advanceTimersByTime(1_000);
		chat.wake("m1", { name: "A", answer: "A 交回了，没问题。" });
		expect(chat.summaries()).toHaveLength(2);
		chat.flow.dispose();
	});

	it("the first wake of an idle session opens a round of its own", () => {
		const chat = new LiveChat();
		chat.wake("m1", { name: "A", answer: "A 交回了。" });
		expect(chat.summaries()).toHaveLength(1);
		expect(chat.summaries()[0]?.state.startedByUser).toBe(false);
		chat.flow.dispose();
	});
});
