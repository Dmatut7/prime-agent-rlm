import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Container, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type CustomMessage,
	createRlmChildFailureMessage,
	createRlmChildTerminalNoticeMessage,
} from "../src/core/messages.js";
import { latestShownTurn } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { built, replay, screenLines, screenOf, summariesOf } from "./tl-fd-helpers.js";
import { modeMethod } from "./tl-fix-host.js";
import { assistant, plain, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

/**
 * Which rounds the timeline draws and which it leaves out: only a round that woke on nothing
 * but bookkeeping (a cancel or a silent finish of a subagent whose report had already come)
 * is out of sight, from its first word to its last. Every path that builds the chat agrees.
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
const LONG = "审查完成：四个车道都收口了，这批代码本身没问题，但发版把一个测试弄红了，远程检查现在是红的。";
const ACK = "查过了，这条通知不用处理。";

type NoticeKind = "silent" | "cancelled" | "failed";

function notice(kind: NoticeKind, name: string, at: number): CustomMessage {
	if (kind === "failed") {
		return createRlmChildFailureMessage(
			{ childId: `${name}-id`, sessionName: name, error: "boom", kind: "error" },
			at,
		);
	}
	return createRlmChildTerminalNoticeMessage(
		kind === "cancelled"
			? { kind: "cancelled", childId: `${name}-id`, sessionName: name }
			: { kind: "completed_without_reply", childId: `${name}-id`, sessionName: name },
		at,
	);
}

/** The owner asks, subagent A hands its report back, and then a notice about `about` wakes the AI once more. */
function transcript(kind: NoticeKind, about: string): AgentMessage[] {
	return [
		{ role: "user", content: ASK, timestamp: T0 },
		assistant(T0 + 1_000, [{ type: "text", text: "派出去了，等它们交回。" }], "stop"),
		handedBack("m1", T0 + 2_000, "A"),
		assistant(T0 + 4_000, [{ type: "text", text: LONG }], "stop"),
		notice(kind, about, T0 + 5_000),
		assistant(T0 + 6_000, [{ type: "text", text: ACK }], "stop"),
	];
}

function liveRun(kind: NoticeKind, about: string, options: { running?: boolean } = {}): LiveChat {
	const chat = new LiveChat();
	chat.prompt(ASK, { answer: "派出去了，等它们交回。" });
	chat.wake("m1", { name: "A", answer: LONG });
	chat.wakeByNotice(about, {
		answer: ACK,
		failed: kind === "failed",
		cancelled: kind === "cancelled",
		...(options.running ? { running: true } : {}),
	});
	if (!options.running) vi.advanceTimersByTime(1_000);
	return chat;
}

const drawnLive = (chat: LiveChat): string => plain(chat.lines(200)).join("\n");

describe("a round only a notice woke", () => {
	const cases: Array<{ label: string; kind: NoticeKind; about: string; hidden: boolean }> = [
		{ label: "a silent finish of a subagent whose report came", kind: "silent", about: "A", hidden: true },
		{ label: "a cancel of a subagent whose report came", kind: "cancelled", about: "A", hidden: true },
		{ label: "a silent finish of a subagent that never reported", kind: "silent", about: "B", hidden: false },
		{ label: "a cancel of a subagent that never reported", kind: "cancelled", about: "B", hidden: false },
		{ label: "a failure, even of a subagent whose report came", kind: "failed", about: "A", hidden: false },
	];

	for (const { label, kind, about, hidden } of cases) {
		it(`${hidden ? "leaves out" : "draws"} the reply to ${label}, live and in both replays`, async () => {
			const chat = liveRun(kind, about);
			const messages = transcript(kind, about);
			const replayed = await replay(messages);
			const rebuilt = built(messages);
			for (const [where, screen] of [
				["live", drawnLive(chat)],
				["mode replay", screenOf(replayed.chatContainer.children, 200)],
				["builder", screenOf(rebuilt, 200)],
			] as const) {
				expect(screen.includes(ACK), where).toBe(!hidden);
				expect(screen.includes(LONG), where).toBe(true);
			}
			chat.flow.dispose();
		});
	}

	it("draws the same lines live and replayed for a round left out and for one shown", async () => {
		for (const [kind, about] of [
			["silent", "A"],
			["silent", "B"],
			["failed", "A"],
		] as const) {
			const chat = liveRun(kind, about);
			const messages = transcript(kind, about);
			const replayed = await replay(messages);
			const live = screenLines(chat.chat.children);
			expect(screenLines(replayed.chatContainer.children), `${kind} ${about}`).toEqual(live);
			expect(screenLines(built(messages)), `${kind} ${about}`).toEqual(live);
			chat.flow.dispose();
		}
	});

	it("never draws a round left out while it streams, and never draws one that is shown only when it ends", () => {
		const hiddenRun = liveRun("silent", "A", { running: true });
		expect(drawnLive(hiddenRun)).not.toContain(ACK);
		hiddenRun.endRun();
		vi.advanceTimersByTime(1_000);
		expect(drawnLive(hiddenRun)).not.toContain(ACK);
		hiddenRun.flow.dispose();

		const shownRun = liveRun("silent", "B", { running: true });
		expect(drawnLive(shownRun)).toContain(ACK);
		shownRun.endRun();
		vi.advanceTimersByTime(1_000);
		expect(drawnLive(shownRun)).toContain(ACK);
		shownRun.flow.dispose();
	});

	it("leaves out the round only while all its notices repeat what the AI has, and 完整过程 brings it back", async () => {
		const both: AgentMessage[] = [
			{ role: "user", content: ASK, timestamp: T0 },
			assistant(T0 + 1_000, [{ type: "text", text: "派出去了。" }], "stop"),
			handedBack("m1", T0 + 2_000, "A"),
			assistant(T0 + 3_000, [{ type: "text", text: LONG }], "stop"),
			notice("silent", "A", T0 + 4_000),
			notice("silent", "B", T0 + 4_500),
			assistant(T0 + 5_000, [{ type: "text", text: ACK }], "stop"),
		];
		const replayed = await replay(both);
		expect(screenOf(replayed.chatContainer.children)).toContain(ACK);
		expect(screenOf(built(both))).toContain(ACK);

		const hidden = transcript("silent", "A");
		const shown = await replay(hidden);
		expect(screenOf(shown.chatContainer.children)).not.toContain(ACK);
		timelineShowAll.set(true);
		expect(screenOf(shown.chatContainer.children)).toContain(ACK);
	});
});

describe("a report that reaches the parent after its final answer, in the same run", () => {
	const REPLY = "收到，A 的结论是没问题。";

	function sameRun(): AgentMessage[] {
		return [
			{ role: "user", content: ASK, timestamp: T0 },
			assistant(
				T0 + 1_000,
				[{ type: "toolCall", id: "spawn", name: "ipython", arguments: { code: "await rlm.spawn(...)" } }],
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "spawn",
				toolName: "ipython",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: T0 + 2_000,
			},
			assistant(T0 + 3_000, [{ type: "text", text: "派出去了，等它交回。" }], "stop"),
			handedBack("m1", T0 + 4_000, "A"),
			assistant(T0 + 5_000, [{ type: "text", text: REPLY }], "stop"),
		];
	}

	function liveSameRun(): LiveChat {
		const chat = new LiveChat();
		chat.user(ASK);
		chat.say(T0 + 1_000, { calls: [{ id: "spawn", code: "await rlm.spawn(...)", endsAt: T0 + 2_000 }] });
		chat.say(T0 + 3_000, { words: "派出去了，等它交回。" });
		chat.report(handedBack("m1", T0 + 4_000, "A"));
		chat.say(T0 + 5_000, { words: REPLY });
		chat.endRun();
		vi.advanceTimersByTime(1_000);
		return chat;
	}

	it("starts a round of its own that the owner did not open, live and in both replays", async () => {
		const chat = liveSameRun();
		const replayed = await replay(sameRun());
		expect(summariesOf(chat.chat.children).map((summary) => summary.state.startedByUser)).toEqual([true, false]);
		expect(summariesOf(replayed.chatContainer.children).map((summary) => summary.state.startedByUser)).toEqual([
			true,
			false,
		]);
		expect(summariesOf(built(sameRun())).map((summary) => summary.state.startedByUser)).toEqual([true, false]);
		chat.flow.dispose();
	});

	it("draws the same lines, blank rows included, live and replayed", async () => {
		const chat = liveSameRun();
		const live = screenLines(chat.chat.children);
		expect(screenLines((await replay(sameRun())).chatContainer.children)).toEqual(live);
		expect(screenLines(built(sameRun()))).toEqual(live);
		expect(live.join("\n")).toContain(REPLY);
		chat.flow.dispose();
	});

	it("takes a notice landing there as a round of its own too, drawn or left out by the same rule", async () => {
		const withNotice = (about: string): AgentMessage[] => [
			...sameRun().slice(0, 4),
			notice("silent", about, T0 + 4_000),
			assistant(T0 + 5_000, [{ type: "text", text: ACK }], "stop"),
		];
		const liveWith = (about: string): LiveChat => {
			const chat = new LiveChat();
			chat.user(ASK);
			chat.say(T0 + 1_000, { calls: [{ id: "spawn", code: "await rlm.spawn(...)", endsAt: T0 + 2_000 }] });
			chat.say(T0 + 3_000, { words: "派出去了，等它交回。" });
			chat.notice(notice("silent", about, T0 + 4_000));
			chat.say(T0 + 5_000, { words: ACK });
			chat.endRun();
			vi.advanceTimersByTime(1_000);
			return chat;
		};
		for (const about of ["A", "B"]) {
			const chat = liveWith(about);
			const replayed = await replay(withNotice(about));
			expect(
				summariesOf(chat.chat.children).map((summary) => summary.state.startedByUser),
				about,
			).toEqual([true, false]);
			expect(screenLines(replayed.chatContainer.children), about).toEqual(screenLines(chat.chat.children));
			// No report from A came in this run, so the notice is news for both children.
			expect(drawnLive(chat), about).toContain(ACK);
			chat.flow.dispose();
		}
	});
});

describe("a notice that lands inside a running tool loop", () => {
	function loop(): AgentMessage[] {
		const call = (id: string, at: number, text: string) =>
			assistant(at, [
				{ type: "text", text },
				{ type: "toolCall", id, name: "ipython", arguments: { code: id } },
			]);
		const result = (id: string, at: number): AgentMessage => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "ipython",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: at,
		});
		return [
			{ role: "user", content: ASK, timestamp: T0 },
			call("c1", T0 + 1_000, "先看第一处。"),
			result("c1", T0 + 2_000),
			notice("failed", "A", T0 + 3_000),
			call("c2", T0 + 4_000, "再看第二处。"),
			result("c2", T0 + 5_000),
			assistant(T0 + 6_000, [{ type: "text", text: "都看完了。" }], "stop"),
		];
	}

	it("is a row of the turn in the test builder, between the events around it, as in the mode's replay", async () => {
		const replayed = screenLines((await replay(loop())).chatContainer.children);
		const rebuilt = screenLines(built(loop()));
		const index = (lines: string[], needle: string) => lines.findIndex((line) => line.includes(needle));
		for (const lines of [replayed, rebuilt]) {
			expect(index(lines, "先看第一处")).toBeGreaterThan(-1);
			expect(index(lines, "子代理 A 失败")).toBeGreaterThan(index(lines, "先看第一处"));
			expect(index(lines, "子代理 A 失败")).toBeLessThan(index(lines, "再看第二处"));
		}
		expect(rebuilt).toEqual(replayed);
	});
});

describe("the keys that act on the latest turn", () => {
	const THOUGHT = "先想想这条通知要不要处理。再看它对应的报告有没有收到。";

	function chatMessages(): AgentMessage[] {
		return [
			{ role: "user", content: ASK, timestamp: T0 },
			assistant(T0 + 1_000, [{ type: "text", text: "派出去了。" }], "stop"),
			handedBack("m1", T0 + 2_000, "A"),
			assistant(
				T0 + 3_000,
				[
					{ type: "thinking", thinking: THOUGHT },
					{ type: "text", text: LONG },
				],
				"stop",
			),
			notice("silent", "A", T0 + 4_000),
			assistant(T0 + 5_000, [{ type: "text", text: ACK }], "stop"),
		];
	}

	it("finds the newest turn that is drawn, and the newest of all when 完整过程 is on", async () => {
		const host = await replay(chatMessages());
		const summaries = summariesOf(host.chatContainer.children);
		expect(summaries).toHaveLength(3);
		expect(latestShownTurn(host.chatContainer.children)).toBe(summaries[1]);
		timelineShowAll.set(true);
		expect(latestShownTurn(host.chatContainer.children)).toBe(summaries[2]);
	});

	it("finds the same turn live and replayed", async () => {
		const chat = liveRun("silent", "A");
		const live = summariesOf(chat.chat.children);
		expect(latestShownTurn(chat.chat.children)).toBe(live[1]);
		chat.flow.dispose();
	});

	const toggleThinking = modeMethod<(this: object) => void>("toggleThinkingBlockVisibility");
	const toggleOutput = modeMethod<(this: object) => void>("toggleToolOutputExpansion");

	function keyMode(chat: Container) {
		const fake = {
			uiServices: { settingsManager: { getProcessMode: () => "quiet" as const } },
			chatContainer: chat,
			hideThinkingBlock: false,
			thinkingExpanded: false,
			toolOutputExpanded: false,
			agentMessagesExpanded: false,
			editDiffsExpanded: false,
			processBlockOpenOrder: [] as unknown[],
			editor: { getText: () => "", handleInput: () => {} },
			showToast: vi.fn(),
			showStatus: vi.fn(),
			ui: {
				requestRender: vi.fn(),
				requestRenderPreservingViewport: vi.fn(),
				isFullscreen: () => false,
				terminal: { rows: 40, columns: 100 },
			},
		};
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		// The key handlers are private; the fake drives them by name (see tl-fix-host.ts).
		return {
			showToast: fake.showToast,
			toggleThinkingBlockVisibility: () => toggleThinking.call(fake),
			toggleToolOutputExpansion: () => toggleOutput.call(fake),
		};
	}

	it("Ctrl+T opens the thoughts of the turn on screen, not of a turn nothing draws", async () => {
		const host = await replay(chatMessages());
		const mode = keyMode(host.chatContainer);
		mode.toggleThinkingBlockVisibility();
		expect(mode.showToast).not.toHaveBeenCalled();
		const shownTurn = summariesOf(host.chatContainer.children)[1];
		expect(shownTurn?.state.thinkingExpanded).toBe(true);
		expect(screenOf(host.chatContainer.children)).toContain("再看它对应的报告有没有收到");
	});

	it("Ctrl+O acts on the turn on screen, and on the newest of all when 完整过程 is on", async () => {
		const host = await replay(chatMessages());
		const [, shownTurn, hiddenTurn] = summariesOf(host.chatContainer.children);
		const mode = keyMode(host.chatContainer);
		mode.toggleToolOutputExpansion();
		expect(mode.showToast).not.toHaveBeenCalledWith("这一轮没有可以展开的步骤");
		expect(shownTurn?.state.boxOpen).toBe(true);
		expect(hiddenTurn?.state.boxOpen).toBe(false);
	});
});
