import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	type CustomMessage,
	createRefinementFailureMessage,
	createRlmChildTerminalNoticeMessage,
} from "../src/core/messages.js";
import { latestShownTurn } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { STRIP_ALL, TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { built, replay } from "./tl-fd-helpers.js";
import { assistant, plain, T0 } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

/**
 * The closing row ("✓ 用了 … 完整过程 ▸"): every question of the conversation ends with one, under the
 * last round of it the timeline draws, and it says how long that question took. The live flow and
 * the mode's replay draw the same lines, a round left out never owns the row, and a memory line
 * that arrives late sits above it.
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

const W = 200;

/** Every line the chat draws, the closing rows too, the clock words blanked. */
function fullScreen(children: readonly Component[]): string[] {
	return plain(children.flatMap((child) => child.render(W)))
		.map((line) => line.replace(/\d\d:\d\d(?::\d\d)?/g, "HH:MM").trimEnd())
		.filter((line) => line !== "");
}

const closingRows = (children: readonly Component[]): string[] =>
	fullScreen(children).filter((line) => line.includes("完整过程"));

/** The strip under `summary`: the first one after it in the chat. */
function stripAfter(children: readonly Component[], summary: TurnSummaryComponent): TurnStripComponent | undefined {
	const start = children.indexOf(summary);
	for (const child of children.slice(start + 1)) if (child instanceof TurnStripComponent) return child;
	return undefined;
}

const summariesIn = (children: readonly Component[]): TurnSummaryComponent[] =>
	children.filter((child): child is TurnSummaryComponent => child instanceof TurnSummaryComponent);

describe("every question ends with a closing row", () => {
	const Q1 = "第一个问题";
	const Q2 = "第二个问题";

	function messages(): AgentMessage[] {
		return [
			{ role: "user", content: Q1, timestamp: T0 + 1_000 },
			assistant(T0 + 2_000, [{ type: "text", text: "好的，第一件办完了。" }], "stop"),
			{ role: "user", content: Q2, timestamp: T0 + 120_000 },
			assistant(T0 + 121_000, [{ type: "text", text: "第二件也办完了。" }], "stop"),
		];
	}

	function live(): LiveChat {
		const chat = new LiveChat();
		vi.setSystemTime(T0 + 2_000);
		chat.prompt(Q1, { answer: "好的，第一件办完了。" });
		vi.advanceTimersByTime(1_000);
		chat.setClock(T0 + 119_000);
		vi.setSystemTime(T0 + 121_000);
		chat.prompt(Q2, { answer: "第二件也办完了。" });
		vi.advanceTimersByTime(1_000);
		return chat;
	}

	it("draws one under each question, live and in the mode's replay", async () => {
		const chat = live();
		const replayed = await replay(messages());
		expect(closingRows(chat.chat.children)).toHaveLength(2);
		expect(closingRows(replayed.chatContainer.children)).toHaveLength(2);
		chat.flow.dispose();
	});

	it("puts the first question's row above the second question and the second's last", async () => {
		const chat = live();
		const replayed = await replay(messages());
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", replayed.chatContainer.children],
		] as const) {
			const lines = fullScreen(children);
			const first = lines.findIndex((line) => line.includes("完整过程"));
			const second = lines.findIndex((line) => line.includes(Q2));
			expect(first, where).toBeGreaterThan(-1);
			expect(first, where).toBeLessThan(second);
			expect(lines.at(-1), where).toContain("完整过程");
		}
		chat.flow.dispose();
	});

	it("says how long each question took: from its start to its last answer, idle time between questions left out", async () => {
		const chat = live();
		const replayed = await replay(messages());
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", replayed.chatContainer.children],
		] as const) {
			const rows = closingRows(children);
			expect(rows, where).toHaveLength(2);
			for (const row of rows) expect(row, where).toContain("✓ 用了 1 秒");
		}
		chat.flow.dispose();
	});

	it("draws the same lines live and replayed", async () => {
		const chat = live();
		const replayed = await replay(messages());
		expect(fullScreen(replayed.chatContainer.children)).toEqual(fullScreen(chat.chat.children));
		chat.flow.dispose();
	});

	it("names the money only under the newest question: it is the session's total, not what an earlier question cost", () => {
		const chat = new LiveChat({ spend: () => ({ cost: 4.2, parentCost: 5.6 }) });
		vi.setSystemTime(T0 + 2_000);
		chat.prompt(Q1, { answer: "好的，第一件办完了。" });
		vi.advanceTimersByTime(1_000);
		chat.setClock(T0 + 119_000);
		vi.setSystemTime(T0 + 121_000);
		chat.prompt(Q2, { answer: "第二件也办完了。" });
		vi.advanceTimersByTime(1_000);
		const [first, second] = closingRows(chat.chat.children);
		expect(first).not.toContain("¥");
		expect(second).toContain("子代理 ¥4.20");
		expect(second).toContain("全部 ¥9.80");
		chat.flow.dispose();
	});
});

describe("a memory tidy that finishes long after the answer", () => {
	const tidy = createRefinementFailureMessage(
		{ refinementId: "r1", scope: "local", reason: "超时" },
		true,
		T0 + 62_000,
	);
	const messages = (): AgentMessage[] => [
		{ role: "user", content: "问一句", timestamp: T0 + 1_000 },
		assistant(T0 + 2_000, [{ type: "text", text: "答一句。" }], "stop"),
		tidy,
	];

	it("is not counted in the question's time, live or reopened, and sits above the closing row", async () => {
		const chat = new LiveChat();
		vi.setSystemTime(T0 + 2_000);
		chat.prompt("问一句", { answer: "答一句。" });
		vi.advanceTimersByTime(60_000);
		chat.flow.addRowAboveClosingRow(new RefinementOutcomeMessageComponent(tidy));
		const reopened = await replay(messages());
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", reopened.chatContainer.children],
		] as const) {
			const lines = fullScreen(children);
			expect(lines.at(-1), where).toContain("✓ 用了 1 秒");
			expect(
				lines.some((line) => line.includes("回合后整理记忆")),
				where,
			).toBe(true);
			expect(
				lines.findIndex((line) => line.includes("回合后整理记忆")),
				where,
			).toBeLessThan(lines.length - 1);
		}
		chat.flow.dispose();
	});
});

describe("how long a replayed round lasted", () => {
	it("is the same in the test builder and the mode's replay: to the round's own last message, not to what came after", async () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "问一句", timestamp: T0 + 1_000 },
			assistant(T0 + 4_000, [{ type: "text", text: "答一句。" }], "stop"),
			{ role: "user", content: "再问一句", timestamp: T0 + 90_000 },
			assistant(T0 + 91_000, [{ type: "text", text: "再答一句。" }], "stop"),
			createRefinementFailureMessage({ refinementId: "r1", scope: "local", reason: "超时" }, true, T0 + 200_000),
		];
		const reopened = await replay(messages);
		for (const [where, children] of [
			["mode replay", reopened.chatContainer.children],
			["builder", built(messages)],
		] as const) {
			const rounds = summariesIn(children);
			expect(rounds, where).toHaveLength(2);
			expect(
				rounds.map((round) => round.state.turnDurationMs()),
				where,
			).toEqual([0, 0]);
		}
	});
});

describe("a question that took steps and a round that came later", () => {
	const ASK = "跑一下再回来告诉我";

	function messages(): AgentMessage[] {
		return [
			{ role: "user", content: ASK, timestamp: T0 + 1_000 },
			assistant(
				T0 + 2_000,
				[
					{ type: "text", text: "先跑起来。" },
					{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } },
				],
				"toolUse",
			),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ipython",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: T0 + 32_000,
			},
			assistant(T0 + 33_000, [{ type: "text", text: "跑完了。" }], "stop"),
			handedBack("m1", T0 + 300_000, "A"),
			assistant(T0 + 301_000, [{ type: "text", text: "A 也回来了，没问题。" }], "stop"),
		];
	}

	function live(): LiveChat {
		const chat = new LiveChat();
		vi.setSystemTime(T0 + 2_000);
		chat.setClock(T0 + 1_000);
		chat.user(ASK);
		chat.say(T0 + 2_000, { words: "先跑起来。", calls: [{ id: "c1", code: "print(1)", endsAt: T0 + 32_000 }] });
		vi.setSystemTime(T0 + 33_000);
		chat.say(T0 + 33_000, { words: "跑完了。" });
		chat.endRun();
		vi.advanceTimersByTime(1_000);
		vi.setSystemTime(T0 + 301_000);
		chat.setClock(T0 + 299_000);
		chat.wake("m1", { name: "A", answer: "A 也回来了，没问题。" });
		vi.advanceTimersByTime(1_000);
		return chat;
	}

	it("draws one closing row for the question, under its last round, counting the whole span", async () => {
		const chat = live();
		const replayed = await replay(messages());
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", replayed.chatContainer.children],
		] as const) {
			const rows = closingRows(children);
			expect(rows, where).toHaveLength(1);
			expect(rows[0], where).toMatch(/✓ 用了 4 分 59 秒/);
			expect(fullScreen(children).at(-1), where).toContain("完整过程");
		}
		chat.flow.dispose();
	});
});

describe("a question whose last round is left out", () => {
	const ASK = "对最近的改动做全面的审查";
	const LONG = "审查完成：四个车道都收口了，这批代码本身没问题。";
	const ACK = "查过了，这条通知不用处理。";
	const TIDY = "回合后整理记忆：没写进去";

	const silent = (name: string, at: number): CustomMessage =>
		createRlmChildTerminalNoticeMessage(
			{ kind: "completed_without_reply", childId: `${name}-id`, sessionName: name },
			at,
		);
	const tidy = (at: number) =>
		createRefinementFailureMessage({ refinementId: "r1", scope: "local", reason: "超时" }, true, at);

	function messages(extra: AgentMessage[] = []): AgentMessage[] {
		return [
			{ role: "user", content: ASK, timestamp: T0 + 1_000 },
			assistant(T0 + 2_000, [{ type: "text", text: "派出去了，等它交回。" }], "stop"),
			handedBack("m1", T0 + 3_000, "A"),
			assistant(T0 + 4_000, [{ type: "text", text: LONG }], "stop"),
			silent("A", T0 + 5_000),
			assistant(T0 + 6_000, [{ type: "text", text: ACK }], "stop"),
			...extra,
		];
	}

	function live(): LiveChat {
		const chat = new LiveChat();
		chat.prompt(ASK, { answer: "派出去了，等它交回。" });
		chat.wake("m1", { name: "A", answer: LONG });
		chat.wakeByNotice("A", { answer: ACK });
		vi.advanceTimersByTime(1_000);
		return chat;
	}

	it("gives the closing row to the last round that is drawn, live and in the mode's replay", async () => {
		const chat = live();
		const replayed = await replay(messages());
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", replayed.chatContainer.children],
		] as const) {
			expect(fullScreen(children).join("\n"), where).not.toContain(ACK);
			expect(closingRows(children), where).toHaveLength(1);
			const summaries = summariesIn(children);
			expect(summaries).toHaveLength(3);
			const shown = latestShownTurn(children);
			expect(shown, where).toBe(summaries[1]);
			const owner = stripAfter(children, summaries[1] as TurnSummaryComponent);
			const left = stripAfter(children, summaries[2] as TurnSummaryComponent);
			expect(
				owner?.render(W).some((line) => line.includes("完整过程")),
				where,
			).toBe(true);
			expect(left?.render(W) ?? [], where).toEqual([]);
		}
		chat.flow.dispose();
	});

	it("puts the row where the keyboard walks: the strip of the latest turn that is drawn", async () => {
		const chat = live();
		const replayed = await replay(messages());
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", replayed.chatContainer.children],
		] as const) {
			const shown = latestShownTurn(children);
			expect(shown, where).toBeDefined();
			const strip = stripAfter(children, shown as TurnSummaryComponent);
			strip?.render(W);
			expect(strip?.getFocusOrder(), where).toContain(STRIP_ALL);
		}
		chat.flow.dispose();
	});

	it("moves the row to the last round when 完整过程 brings every round back", async () => {
		const replayed = await replay(messages());
		const children = replayed.chatContainer.children;
		timelineShowAll.set(true);
		const summaries = summariesIn(children);
		expect(latestShownTurn(children)).toBe(summaries[2]);
		expect(stripAfter(children, summaries[1] as TurnSummaryComponent)?.render(W).length).toBe(0);
		expect(
			stripAfter(children, summaries[2] as TurnSummaryComponent)
				?.render(W)
				.some((line) => line.includes("完整过程")),
		).toBe(true);
	});

	it("keeps a memory line that arrives late above the closing row, live and reopened", async () => {
		const chat = live();
		chat.flow.addRowAboveClosingRow(new RefinementOutcomeMessageComponent(tidy(T0 + 7_000)));
		const reopened = await replay(messages([tidy(T0 + 7_000)]));
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", reopened.chatContainer.children],
		] as const) {
			const lines = fullScreen(children);
			const memory = lines.findIndex((line) => line.includes(TIDY));
			expect(memory, where).toBeGreaterThan(-1);
			expect(
				lines.findIndex((line) => line.includes("完整过程")),
				where,
			).toBeGreaterThan(memory);
			expect(lines.at(-1), where).toContain("完整过程");
		}
		chat.flow.dispose();
	});
});
