import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type CustomMessage,
	createCompactionOutcomeMessage,
	createRlmChildTerminalNoticeMessage,
} from "../src/core/messages.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { built, createHost, replay, screenLines, screenOf } from "./tl-fd-helpers.js";
import { assistant, plain, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

/**
 * Rounds the timeline leaves out (a round only a notice woke, when the notice repeats a report the AI
 * already has) come back as soon as the owner or the work makes them news: a message the owner typed
 * in them, a compaction that failed. Live and both replays agree, and a rebuild after a compaction
 * still knows which reports were received.
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
const LONG = "审查完成：四个车道都收口了，这批代码本身没问题，但发版把一个测试弄红了，远程检查现在是红的。";
const LOOK = "先看这条通知。";
const ACK = "查过了，这条通知不用处理。";
const STEER = "顺便把 README 也看一下";
const ANSWER = "README 也看了，没问题。";

function silentNotice(name: string, at: number): CustomMessage {
	return createRlmChildTerminalNoticeMessage(
		{ kind: "completed_without_reply", childId: `${name}-id`, sessionName: name },
		at,
	);
}

const call = (id: string, at: number, words: string): AgentMessage =>
	assistant(
		at,
		[
			{ type: "text", text: words },
			{ type: "toolCall", id, name: "ipython", arguments: { code: "print(1)" } },
		],
		"toolUse",
	);

const result = (id: string, at: number): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "ipython",
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp: at,
});

/** The question, A's report and the round it woke: what every case here builds on (LiveChat stamps by 1 s ticks). */
function beforeNotice(): AgentMessage[] {
	return [
		{ role: "user", content: ASK, timestamp: T0 + 1_000 },
		assistant(T0 + 2_000, [{ type: "text", text: FIRST }], "stop"),
		handedBack("m1", T0 + 3_000, "A"),
		assistant(T0 + 4_000, [{ type: "text", text: LONG }], "stop"),
	];
}

function liveBeforeNotice(): LiveChat {
	const chat = new LiveChat();
	chat.prompt(ASK, { answer: FIRST });
	chat.wake("m1", { name: "A", answer: LONG });
	return chat;
}

/** A silent-finish notice of A (whose report came) wakes the AI, which starts working and then goes on to `finish`. */
function liveHiddenRound(steps: (chat: LiveChat) => void): LiveChat {
	const chat = liveBeforeNotice();
	chat.flow.agentStart();
	chat.notice(silentNotice("A", T0 + 5_000));
	chat.say(T0 + 6_000, { words: LOOK, calls: [{ id: "c1", code: "print(1)", endsAt: T0 + 6_500 }] });
	steps(chat);
	chat.endRun();
	vi.advanceTimersByTime(1_000);
	return chat;
}

async function threeWays(messages: AgentMessage[], chat: LiveChat): Promise<Array<[string, string]>> {
	const replayed = await replay(messages);
	return [
		["live", screenOf(chat.chat.children, 200)],
		["mode replay", screenOf(replayed.chatContainer.children, 200)],
		["builder", screenOf(built(messages), 200)],
	];
}

describe("a message the owner types in a round that would be left out", () => {
	const messages = (): AgentMessage[] => [
		...beforeNotice(),
		silentNotice("A", T0 + 5_000),
		call("c1", T0 + 6_000, LOOK),
		result("c1", T0 + 6_500),
		{ role: "user", content: STEER, timestamp: T0 + 7_000 },
		assistant(T0 + 8_000, [{ type: "text", text: ANSWER }], "stop"),
	];

	const live = (): LiveChat =>
		liveHiddenRound((chat) => {
			chat.flow.userMessage(STEER, T0 + 7_000);
			chat.say(T0 + 8_000, { words: ANSWER });
		});

	it("makes the round news: the owner's words and the AI's answer to them are drawn, live and in both replays", async () => {
		const chat = live();
		for (const [where, screen] of await threeWays(messages(), chat)) {
			expect(screen, where).toContain(STEER);
			expect(screen, where).toContain(ANSWER);
		}
		chat.flow.dispose();
	});

	it("draws the same lines in all three", async () => {
		const chat = live();
		const expected = screenLines(chat.chat.children);
		const replayed = await replay(messages());
		expect(screenLines(replayed.chatContainer.children)).toEqual(expected);
		expect(screenLines(built(messages()))).toEqual(expected);
		chat.flow.dispose();
	});

	it("still leaves the same round out when nobody typed anything in it", async () => {
		const quiet: AgentMessage[] = [
			...beforeNotice(),
			silentNotice("A", T0 + 5_000),
			call("c1", T0 + 6_000, LOOK),
			result("c1", T0 + 6_500),
			assistant(T0 + 8_000, [{ type: "text", text: ANSWER }], "stop"),
		];
		const chat = liveHiddenRound((run) => run.say(T0 + 8_000, { words: ANSWER }));
		for (const [where, screen] of await threeWays(quiet, chat)) {
			expect(screen, where).not.toContain(ANSWER);
			expect(screen, where).not.toContain(LOOK);
		}
		chat.flow.dispose();
	});
});

describe("a compaction that failed in a round that would be left out", () => {
	const REASON = "boom: no room";

	function messages(outcome: "failed" | "cancelled" | "skipped"): AgentMessage[] {
		const content = outcome === "skipped" ? "Auto-compaction skipped: conversation is too short to compact" : REASON;
		return [
			...beforeNotice(),
			silentNotice("A", T0 + 5_000),
			call("c1", T0 + 6_000, LOOK),
			result("c1", T0 + 6_500),
			createCompactionOutcomeMessage(content, { reason: "threshold", outcome }, true, T0 + 7_000),
			assistant(T0 + 8_000, [{ type: "text", text: ACK }], "stop"),
		];
	}

	function live(outcome: "failed" | "cancelled" | "skipped"): LiveChat {
		return liveHiddenRound((chat) => {
			chat.flow.compactionStart("threshold");
			chat.flow.compactionEnd(
				outcome === "cancelled"
					? { reason: "threshold", aborted: true }
					: outcome === "skipped"
						? {
								reason: "threshold",
								aborted: false,
								errorMessage: "Auto-compaction skipped: conversation is too short to compact",
								errorSeverity: "warning",
							}
						: { reason: "threshold", aborted: false, errorMessage: REASON, errorSeverity: "error" },
			);
			chat.say(T0 + 8_000, { words: ACK });
		});
	}

	for (const [outcome, drawn] of [
		["failed", true],
		["cancelled", false],
		["skipped", false],
	] as const) {
		it(`${drawn ? "draws" : "leaves out"} the round when the compaction ${outcome === "failed" ? "failed" : outcome === "cancelled" ? "was cancelled" : "only waited"}, live and in both replays`, async () => {
			const chat = live(outcome);
			for (const [where, screen] of await threeWays(messages(outcome), chat)) {
				expect(screen.includes(ACK), where).toBe(drawn);
				if (drawn) expect(screen, where).toContain("这次没整理成");
			}
			chat.flow.dispose();
		});
	}

	it("draws the same lines live and replayed when the compaction failed", async () => {
		const chat = live("failed");
		const expected = screenLines(chat.chat.children);
		const replayed = await replay(messages("failed"));
		expect(screenLines(replayed.chatContainer.children)).toEqual(expected);
		expect(screenLines(built(messages("failed")))).toEqual(expected);
		chat.flow.dispose();
	});
});

describe("a rebuild after an automatic compaction", () => {
	const summary = (at: number): AgentMessage => ({
		role: "compactionSummary",
		summary: "## 目标\n审查最近的改动",
		tokensBefore: 166_000,
		timestamp: at,
	});

	it("still knows the reports it received before the compaction, so a repeated notice stays out of sight", async () => {
		const host = createHost();
		const whole: AgentMessage[] = [
			...beforeNotice(),
			silentNotice("A", T0 + 5_000),
			assistant(T0 + 6_000, [{ type: "text", text: ACK }], "stop"),
		];
		await replay(whole, { clearChat: true }, host);
		expect(plain(host.chatContainer.children.flatMap((child) => child.render(200))).join("\n")).not.toContain(ACK);
		// The compaction folded the question and A's report away: the context starts at the summary.
		const compacted: AgentMessage[] = [
			summary(T0 + 4_500),
			silentNotice("A", T0 + 5_000),
			assistant(T0 + 6_000, [{ type: "text", text: ACK }], "stop"),
		];
		await replay(compacted, { clearChat: true, keepCompactedHistory: true }, host);
		const screen = plain(host.chatContainer.children.flatMap((child) => child.render(200))).join("\n");
		expect(screen).not.toContain(ACK);
	});

	it("learns the reports from the transcript alone when nothing was compacted (a branch that never had them)", async () => {
		const host = createHost();
		await replay([...beforeNotice()], { clearChat: true }, host);
		const branch: AgentMessage[] = [
			{ role: "user", content: ASK, timestamp: T0 + 1_000 },
			assistant(T0 + 2_000, [{ type: "text", text: FIRST }], "stop"),
			silentNotice("A", T0 + 5_000),
			assistant(T0 + 6_000, [{ type: "text", text: ACK }], "stop"),
		];
		await replay(branch, { clearChat: true }, host);
		const screen = plain(host.chatContainer.children.flatMap((child) => child.render(200))).join("\n");
		expect(screen).toContain(ACK);
	});

	it("does not take a subagent that never reported for one that did", async () => {
		const host = createHost();
		await replay([...beforeNotice()], { clearChat: true }, host);
		const compacted: AgentMessage[] = [
			summary(T0 + 4_500),
			silentNotice("B", T0 + 5_000),
			assistant(T0 + 6_000, [{ type: "text", text: ACK }], "stop"),
		];
		await replay(compacted, { clearChat: true, keepCompactedHistory: true }, host);
		const screen = plain(host.chatContainer.children.flatMap((child) => child.render(200))).join("\n");
		expect(screen).toContain(ACK);
	});
});
