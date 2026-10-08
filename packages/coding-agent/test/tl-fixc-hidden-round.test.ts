import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, setKeybindings, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createCompactionOutcomeMessage, createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import {
	assignWakeCause,
	isAckRound,
	QuietTurnSummary,
	ReceivedReports,
	resolveTurnHeaders,
	WakeCause,
} from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import type { TimelineFacts } from "../src/modes/interactive/components/timeline-rows.js";
import { TurnActivityState } from "../src/modes/interactive/components/turn-activity.js";
import { TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { TurnTimeline } from "../src/modes/interactive/components/turn-timeline.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { replay } from "./tl-fd-helpers.js";
import { addCommand, assistant, plain, quietTurn, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

/**
 * A round the timeline leaves out (only a bookkeeping notice woke it) draws nothing: not its
 * lines, and not what its strip carries after the answer either. The closing row of the question
 * stays the last line. Live and replayed alike.
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

const ASK = "对最近的改动做全面的审查";
const FIRST = "派出去了，等它交回。";
const LONG = "审查完成：四个车道都收口了。";
const ACK = "查过了，这条通知不用处理。";
const SKIP = "Auto-compaction skipped: conversation is too short to compact";
const MEMORY_LINE = "·  ✦ 回合后整理记忆：没写进去  ·";
const CLOSING = /^ {9}╵ {6}[✓■✗]/;

const silent = (name: string, at: number) =>
	createRlmChildTerminalNoticeMessage(
		{ kind: "completed_without_reply", childId: `${name}-id`, sessionName: name },
		at,
	);

function ackRound(): LiveChat {
	const chat = new LiveChat();
	chat.prompt(ASK, { answer: FIRST });
	chat.wake("m1", { name: "A", answer: LONG });
	chat.flow.agentStart();
	chat.notice(silent("A", T0 + 5_000));
	chat.say(T0 + 8_000, { words: ACK });
	chat.endRun();
	vi.advanceTimersByTime(1_000);
	return chat;
}

function drawn(chat: LiveChat, width = 100): string[] {
	return plain(chat.lines(width))
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0);
}

describe("a compaction after a round the timeline leaves out", () => {
	it("skipped: the closing row stays the last line and the hidden round draws nothing", () => {
		const chat = ackRound();
		chat.flow.compactionStart("threshold");
		chat.flow.compactionEnd({ reason: "threshold", aborted: false, errorMessage: SKIP, errorSeverity: "warning" });
		vi.advanceTimersByTime(1_000);
		const summaries = chat.summaries();
		const hidden = summaries[summaries.length - 1];
		expect(hidden && isAckRound(hidden.state)).toBe(true);
		expect(hidden && chat.flow.stripFor(hidden)?.render(100)).toEqual([]);
		const lines = drawn(chat);
		expect(lines.at(-1)).toMatch(CLOSING);
		expect(lines.some((line) => line.includes("暂不整理"))).toBe(false);
		chat.flow.dispose();
	});

	it("cancelled: the same", () => {
		const chat = ackRound();
		chat.flow.compactionStart("threshold");
		chat.flow.compactionEnd({ reason: "threshold", aborted: true });
		vi.advanceTimersByTime(1_000);
		const lines = drawn(chat);
		expect(lines.at(-1)).toMatch(CLOSING);
		expect(lines.some((line) => line.includes("已取消"))).toBe(false);
		chat.flow.dispose();
	});

	it("replayed: the closing row is the last line too", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: ASK, timestamp: T0 + 1_000 },
			assistant(T0 + 2_000, [{ type: "text", text: FIRST }], "stop"),
			handedBack("m1", T0 + 3_000, "A", LONG),
			assistant(T0 + 4_000, [{ type: "text", text: LONG }], "stop"),
			silent("A", T0 + 5_000),
			assistant(T0 + 6_000, [{ type: "text", text: ACK }], "stop"),
			createCompactionOutcomeMessage(SKIP, { reason: "threshold", outcome: "skipped" }, true, T0 + 7_000),
		];
		const host = await replay(messages);
		const lines = plain(host.chatContainer.children.flatMap((child) => child.render(100)))
			.map((line) => line.trimEnd())
			.filter((line) => line.length > 0);
		expect(lines.at(-1)).toMatch(CLOSING);
		expect(lines.some((line) => line.includes("暂不整理"))).toBe(false);
	});

	it("a memory line that arrives later goes above the closing row, not under it", () => {
		const chat = ackRound();
		chat.flow.compactionStart("threshold");
		chat.flow.compactionEnd({ reason: "threshold", aborted: false, errorMessage: SKIP, errorSeverity: "warning" });
		vi.advanceTimersByTime(1_000);
		chat.flow.addRowAboveClosingRow(new Text(MEMORY_LINE));
		const lines = drawn(chat);
		const memory = lines.findIndex((line) => line.includes("回合后整理记忆"));
		const closing = lines.findIndex((line) => CLOSING.test(line));
		expect(memory).toBeGreaterThan(-1);
		expect(closing).toBeGreaterThan(memory);
		expect(lines.at(-1)).toMatch(CLOSING);
		chat.flow.dispose();
	});
});

describe("a strip that does not end its question", () => {
	const AT = new Date(2026, 8, 30, 18, 55, 0).getTime();

	function facts(overrides: Partial<TimelineFacts> = {}): TimelineFacts {
		return {
			thinkCount: 0,
			commandCount: 0,
			readCount: 0,
			stepCount: 1,
			subagentCount: 0,
			errorCount: 0,
			projectChanges: [],
			scratchChanges: [],
			memories: [],
			trackingIncomplete: false,
			afterAnswer: [{ key: "compact:1", at: AT, text: "整理完成，重要的结论都留着" }],
			...overrides,
		};
	}

	it("with only a compaction row after the answer does not leave an empty rail row hanging under it", () => {
		const strip = new TurnStripComponent({
			timeline: new TurnTimeline(),
			facts: () => facts(),
			requestRender: vi.fn(),
			endsRequest: () => false,
		});
		const lines = plain(strip.render(100)).map((line) => line.trimEnd());
		expect(lines).toEqual(["         │", ` 18:55   ◆      整理完成，重要的结论都留着`]);
	});

	it("a strip whose source says the round is hidden renders nothing and takes no focus", () => {
		const strip = new TurnStripComponent({
			timeline: new TurnTimeline(),
			facts: () => facts({ stepCount: 2 }),
			requestRender: vi.fn(),
			hidden: () => true,
		});
		expect(strip.render(100)).toEqual([]);
		expect(strip.getFocusOrder()).toEqual([]);
		expect(strip.getClickRegions()).toEqual([]);
	});
});

describe("a compaction the owner cancelled", () => {
	it("says so without the failure wording", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: ASK, timestamp: T0 },
			assistant(T0 + 1_000, [{ type: "text", text: FIRST }], "stop"),
			createCompactionOutcomeMessage("cancelled", { reason: "threshold", outcome: "cancelled" }, true, T0 + 2_000),
		];
		const host = await replay(messages);
		const lines = plain(host.chatContainer.children.flatMap((child) => child.render(100)));
		expect(lines.some((line) => line.includes("这次没整理成"))).toBe(false);
		expect(lines.some((line) => line.includes("已取消，未整理"))).toBe(true);
	});

	it("is not news to a hidden round whatever wording the compaction carries", () => {
		const state = new TurnActivityState(T0);
		state.startedByUser = false;
		const reports = new ReceivedReports();
		reports.restore(["A"]);
		const cause = new WakeCause(reports);
		cause.add(silent("A", T0));
		assignWakeCause(state, cause);
		state.timeline.addReplayCompaction(T0 + 1_000, { failed: "换了一句别的话", cancelled: true });
		expect(isAckRound(state)).toBe(true);
	});

	it("a compaction that really failed still shows a hidden round", () => {
		const state = new TurnActivityState(T0);
		state.startedByUser = false;
		const reports = new ReceivedReports();
		reports.restore(["A"]);
		const cause = new WakeCause(reports);
		cause.add(silent("A", T0));
		assignWakeCause(state, cause);
		state.timeline.addReplayCompaction(T0 + 1_000, { failed: "boom: no room" });
		expect(isAckRound(state)).toBe(false);
	});
});

describe("the blank row a woken round keeps above itself", () => {
	function hiddenRound(): QuietTurnSummary {
		const state = new TurnActivityState(T0);
		state.startedByUser = false;
		const reports = new ReceivedReports();
		reports.restore(["A"]);
		const cause = new WakeCause(reports);
		cause.add(silent("A", T0));
		assignWakeCause(state, cause);
		const summary = new QuietTurnSummary(state);
		expect(isAckRound(state)).toBe(true);
		return summary;
	}

	it("renders nothing as the same empty array every time, not a fresh []", () => {
		// A fresh [] per render defeats the aggregator's identity memo and rebuilds
		// the transcript lines every frame.
		const summary = hiddenRound();
		const first = summary.render(80);
		expect(first).toHaveLength(0);
		expect(summary.render(80)).toBe(first);
	});

	it("looks past a round the timeline leaves out to what is really above", () => {
		const stopped = new AssistantMessageComponent(
			assistant(
				T0,
				[{ type: "toolCall", id: "t1", name: "ipython", arguments: { code: "await bash('sleep 60')" } }],
				"aborted",
			),
			false,
			undefined,
			"Thinking",
			{ quiet: true },
		);
		const first = quietTurn({ live: false });
		addCommand(first, "c0", "echo first");
		first.state.markTurnEnded(Date.now());
		const woken = quietTurn({ live: false });
		woken.state.startedByUser = false;
		addCommand(woken, "c1", "echo woken");
		woken.state.markTurnEnded(Date.now());
		resolveTurnHeaders([first.summary, stopped, new Container(), hiddenRound(), woken.summary]);
		// What is above ends in the stopped reply's own blank line, so the woken round adds none.
		expect(plain(woken.summary.render(100))[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}跑了 1 条命令/);
	});
});
