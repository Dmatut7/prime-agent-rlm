import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createCompactionOutcomeMessage } from "../src/core/messages.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import type { TimelineFacts } from "../src/modes/interactive/components/timeline-rows.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { TurnTimeline } from "../src/modes/interactive/components/turn-timeline.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { built, replay, screenLines } from "./tl-fd-helpers.js";
import { assistant, plain, T0 } from "./ui-blocks-helpers.js";
import { LiveChat } from "./ui-live-chat.js";

/**
 * A compaction after the turn's last answer is drawn after that answer, in time order, and a compaction
 * the owner cancelled is a step of the event it interrupted, not a line of its own. Live and replayed alike.
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

const ASK = "把依赖升级一下";
const WORDS = "先看目录里有什么。";
const ANSWER = "升级好了。";
const DONE = "整理完成（原来 166k tokens），重要的结论都留着";
const CANCELLED = "已取消，未整理";
const REASON = "boom: no room";
const FAILED = `这次没整理成：${REASON}`;

function step(id: string, at: number, words: string, code = "await bash('ls')"): AgentMessage[] {
	return [
		assistant(
			at,
			[
				{ type: "text", text: words },
				{ type: "toolCall", id, name: "ipython", arguments: { code } },
			],
			"toolUse",
		),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "ipython",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: at + 500,
		},
	];
}

/** Every line the chat draws, the closing rows included, with the clock times blanked. */
function drawn(children: readonly Component[], width = 100): string[] {
	return plain(children.flatMap((child) => child.render(width))).map((line) =>
		line.replace(/\d\d:\d\d(?::\d\d)?/g, "HH:MM").trimEnd(),
	);
}

/** Every event of every turn opened, then the chat's lines. */
function opened(children: readonly Component[]): string[] {
	for (const turn of children) {
		if (!(turn instanceof TurnSummaryComponent)) continue;
		turn.render(100);
		for (const key of turn.getFocusOrder()) if (key.startsWith("ev:")) turn.activate(key);
		turn.render(100);
	}
	return screenLines(children);
}

const at = (lines: string[], needle: string) => lines.findIndex((line) => line.includes(needle));
const isRail = (line: string | undefined) => line !== undefined && /^ {9}│$/.test(line);

type Ending = "done" | "failed" | "cancelled" | "skipped";

const AFTER_ANSWER: Record<Ending, { text: string; message: AgentMessage; end: () => (chat: LiveChat) => void }> = {
	done: {
		text: DONE,
		message: {
			role: "compactionSummary",
			summary: "## 目标\n升级依赖",
			tokensBefore: 166_000,
			timestamp: T0 + 4_000,
		},
		end: () => (chat) =>
			chat.flow.compactionEnd({ reason: "threshold", result: { tokensBefore: 166_000 }, aborted: false }),
	},
	failed: {
		text: FAILED,
		message: createCompactionOutcomeMessage(REASON, { reason: "threshold", outcome: "failed" }, true, T0 + 4_000),
		end: () => (chat) =>
			chat.flow.compactionEnd({ reason: "threshold", aborted: false, errorMessage: REASON, errorSeverity: "error" }),
	},
	cancelled: {
		text: CANCELLED,
		message: createCompactionOutcomeMessage(
			"cancelled",
			{ reason: "threshold", outcome: "cancelled" },
			true,
			T0 + 4_000,
		),
		end: () => (chat) => chat.flow.compactionEnd({ reason: "threshold", aborted: true }),
	},
	skipped: {
		text: "暂不整理：对话还太短，等它长一些再整理",
		message: createCompactionOutcomeMessage(
			"Auto-compaction skipped: conversation is too short to compact",
			{ reason: "threshold", outcome: "skipped" },
			true,
			T0 + 4_000,
		),
		end: () => (chat) =>
			chat.flow.compactionEnd({
				reason: "threshold",
				aborted: false,
				errorMessage: "conversation is too short to compact",
				errorSeverity: "warning",
			}),
	},
};

function liveAfterAnswer(ending: Ending): LiveChat {
	const chat = new LiveChat();
	chat.user(ASK);
	chat.say(T0 + 1_000, { words: WORDS, calls: [{ id: "c1", code: "await bash('ls')", endsAt: T0 + 1_500 }] });
	chat.say(T0 + 3_000, { words: ANSWER });
	chat.endRun();
	chat.flow.compactionStart("threshold");
	vi.setSystemTime(T0 + 4_000);
	AFTER_ANSWER[ending].end()(chat);
	vi.advanceTimersByTime(1_000);
	return chat;
}

function replayedAfterAnswer(ending: Ending): AgentMessage[] {
	return [
		{ role: "user", content: ASK, timestamp: T0 },
		...step("c1", T0 + 1_000, WORDS),
		assistant(T0 + 3_000, [{ type: "text", text: ANSWER }], "stop"),
		AFTER_ANSWER[ending].message,
	];
}

describe("a compaction after the turn's last answer", () => {
	const endings = Object.keys(AFTER_ANSWER) as Ending[];

	for (const ending of endings) {
		it(`is drawn after the answer and above the closing row when it ${ending}, live and in the mode's replay`, async () => {
			const chat = liveAfterAnswer(ending);
			const replayed = await replay(replayedAfterAnswer(ending));
			const wanted = AFTER_ANSWER[ending].text;
			for (const [where, children] of [
				["live", chat.chat.children],
				["mode replay", replayed.chatContainer.children],
			] as const) {
				const lines = drawn(children);
				const answer = at(lines, "总结");
				const answerText = at(lines, ANSWER);
				const compaction = at(lines, wanted);
				const closing = at(lines, "╵");
				expect(answer, where).toBeGreaterThan(-1);
				expect(answerText, where).toBeGreaterThan(answer);
				expect(compaction, where).toBeGreaterThan(answerText);
				expect(closing, where).toBeGreaterThan(compaction);
				expect(lines[compaction], where).toMatch(/^ HH:MM {3}◆ {6}/);
				expect(lines[compaction], where).not.toContain("步 ▸");
				// Two blank main-line rows under the answer, one above the closing row: the strip's spacing.
				expect(isRail(lines[compaction - 1]), where).toBe(true);
				expect(isRail(lines[compaction - 2]), where).toBe(true);
				expect(isRail(lines[compaction - 3]), where).toBe(false);
				expect(isRail(lines[compaction + 1]), where).toBe(true);
				expect(closing, where).toBe(compaction + 2);
				// The event of the command still counts its one step, and no step lists the compaction.
				expect(
					lines.some((line) => line.includes(WORDS) && line.includes("1 步 ▸")),
					where,
				).toBe(true);
				expect(
					opened(children).filter((line) => line.includes("⇣")),
					where,
				).toEqual([]);
				expect(
					lines.filter((line) => line.includes(wanted)),
					where,
				).toHaveLength(1);
			}
			chat.flow.dispose();
		});
	}

	it("draws the same lines live and replayed, from the question to the compaction line", async () => {
		for (const ending of endings) {
			const chat = liveAfterAnswer(ending);
			const replayed = await replay(replayedAfterAnswer(ending));
			const upTo = (lines: string[]) => lines.slice(0, at(lines, AFTER_ANSWER[ending].text) + 1);
			const live = upTo(drawn(chat.chat.children));
			expect(live.length, ending).toBeGreaterThan(5);
			expect(upTo(drawn(replayed.chatContainer.children)), ending).toEqual(live);
			chat.flow.dispose();
		}
	});

	it("says a failed one in the color of a failure and the others in plain text", async () => {
		const colored = async (ending: Ending, color: "timelineMust" | "text") => {
			const replayed = await replay(replayedAfterAnswer(ending));
			const raw = replayed.chatContainer.children.flatMap((child) => child.render(100));
			const line = raw.find((entry) => plain([entry])[0]?.includes(AFTER_ANSWER[ending].text)) ?? "";
			expect(line, ending).not.toBe("");
			expect(line, ending).toContain(theme.getFgAnsi(color));
			if (color === "text") expect(line, ending).not.toContain(theme.getFgAnsi("timelineMust"));
		};
		await colored("failed", "timelineMust");
		await colored("done", "text");
	});

	it("stays a step of the event it interrupts when an answer or a step follows it", async () => {
		const between: AgentMessage[] = [
			{ role: "user", content: ASK, timestamp: T0 },
			...step("c1", T0 + 1_000, WORDS),
			{ role: "compactionSummary", summary: "## 目标\n升级依赖", tokensBefore: 166_000, timestamp: T0 + 2_000 },
			assistant(T0 + 3_000, [{ type: "text", text: ANSWER }], "stop"),
		];
		const replayed = await replay(between);
		expect(drawn(replayed.chatContainer.children).some((line) => line.includes(DONE))).toBe(false);
		expect(opened(replayed.chatContainer.children).some((line) => line.includes(`⇣  ${DONE}`))).toBe(true);
	});

	it("is said after the answer while it runs, too, once the turn has settled", () => {
		const RUNNING = "上下文快满了，正在整理前面的内容…";
		const chat = new LiveChat();
		chat.user(ASK);
		chat.say(T0 + 3_000, { words: ANSWER });
		chat.endRun();
		vi.advanceTimersByTime(5_000);
		chat.flow.compactionStart("threshold");
		const running = drawn(chat.chat.children);
		expect(at(running, RUNNING)).toBeGreaterThan(at(running, ANSWER));
		expect(at(running, "╵")).toBeGreaterThan(at(running, RUNNING));
		chat.flow.compactionEnd({ reason: "threshold", result: { tokensBefore: 166_000 }, aborted: false });
		vi.advanceTimersByTime(1_000);
		const settled = drawn(chat.chat.children);
		expect(at(settled, RUNNING)).toBe(-1);
		expect(at(settled, DONE)).toBeGreaterThan(at(settled, ANSWER));
		chat.flow.dispose();
	});

	it("is not a line above the answer while the turn still runs; the tail says it is at work", () => {
		const RUNNING = "上下文快满了，正在整理前面的内容…";
		const chat = new LiveChat();
		chat.user(ASK);
		chat.say(T0 + 3_000, { words: ANSWER });
		chat.endRun();
		chat.flow.compactionStart("threshold");
		const lines = drawn(chat.chat.children);
		expect(at(lines, RUNNING)).toBe(-1);
		expect(lines.some((line) => /[⠀-⣿] +上下文快满了，正在整理前面的内容$/.test(line))).toBe(true);
		chat.flow.dispose();
	});

	it("leaves the box, so the test builder (it draws no closing part) agrees with the live chat on every other line", async () => {
		const chat = liveAfterAnswer("done");
		const messages = replayedAfterAnswer("done");
		expect(screenLines(built(messages))).toEqual(screenLines(chat.chat.children));
		chat.flow.dispose();
	});
});

describe("a compaction the owner cancelled", () => {
	function liveRun(): LiveChat {
		const chat = new LiveChat();
		chat.user(ASK);
		chat.say(T0 + 1_000, { words: WORDS, calls: [{ id: "c1", code: "await bash('ls')", endsAt: T0 + 1_500 }] });
		chat.flow.compactionStart("threshold");
		chat.flow.compactionEnd({ reason: "threshold", aborted: true });
		chat.say(T0 + 3_000, { words: ANSWER });
		chat.endRun();
		vi.advanceTimersByTime(1_000);
		return chat;
	}

	function messages(outcome: "cancelled" | "failed"): AgentMessage[] {
		return [
			{ role: "user", content: ASK, timestamp: T0 },
			...step("c1", T0 + 1_000, WORDS),
			createCompactionOutcomeMessage(
				outcome === "failed" ? REASON : "cancelled",
				{ reason: "threshold", outcome },
				true,
				T0 + 2_000,
			),
			assistant(T0 + 3_000, [{ type: "text", text: ANSWER }], "stop"),
		];
	}

	it("folds into the steps of the event it interrupted, live and in both replays", async () => {
		const chat = liveRun();
		const replayed = await replay(messages("cancelled"));
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", replayed.chatContainer.children],
			["builder", built(messages("cancelled"))],
		] as const) {
			const closed = screenLines(children);
			expect(at(closed, WORDS), where).toBeGreaterThan(-1);
			expect(
				closed.some((line) => line.includes(CANCELLED)),
				where,
			).toBe(false);
			// The command and the cancelled compaction are its two steps.
			expect(
				closed.some((line) => line.includes(WORDS) && line.includes("2 步 ▸")),
				where,
			).toBe(true);
			expect(
				opened(children).some((line) => line.includes(`⇣  ${CANCELLED}`)),
				where,
			).toBe(true);
		}
		chat.flow.dispose();
	});

	it("is not drawn in the color of a failure", async () => {
		const replayed = await replay(messages("cancelled"));
		opened(replayed.chatContainer.children);
		const raw = replayed.chatContainer.children.flatMap((child) => child.render(100));
		const drawnLines = raw.filter((entry) => plain([entry])[0]?.includes(CANCELLED));
		expect(drawnLines.length).toBeGreaterThan(0);
		for (const entry of drawnLines) expect(entry).not.toContain(theme.getFgAnsi("timelineMust"));
	});

	it("draws the same lines live and replayed", async () => {
		const chat = liveRun();
		const replayed = await replay(messages("cancelled"));
		expect(screenLines(replayed.chatContainer.children)).toEqual(screenLines(chat.chat.children));
		expect(opened(replayed.chatContainer.children)).toEqual(opened(chat.chat.children));
		chat.flow.dispose();
	});

	it("leaves a compaction that really failed a line of its own", async () => {
		const replayed = await replay(messages("failed"));
		const lines = screenLines(replayed.chatContainer.children);
		const line = lines.find((entry) => entry.includes(FAILED)) ?? "";
		expect(line).toMatch(/^ HH:MM {3}◆ {6}这次没整理成/);
		expect(line).not.toContain("步 ▸");
	});
});

describe("the closing part with a compaction after the answer", () => {
	const AT = new Date(2026, 8, 30, 18, 55, 0).getTime();
	const NOTE = "整理完成（原来 166k tokens），重要的结论都留着";

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
			afterAnswer: [{ key: "compact:1", at: AT, text: NOTE }],
			...overrides,
		};
	}

	function rows(data: TimelineFacts, width = 100): string[] {
		const strip = new TurnStripComponent({ timeline: new TurnTimeline(), facts: () => data, requestRender: vi.fn() });
		return plain(strip.render(width)).map((line) => line.trimEnd());
	}

	it("says it on a main-line row with its time, one blank row below the answer's own and one above the closing row", () => {
		const lines = rows(facts());
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe("         │");
		expect(lines[1]).toBe(` 18:55   ◆      ${NOTE}`);
		expect(lines[2]).toBe("         │");
		expect(lines[3]).toMatch(/^ {9}╵ {6}✓ .*完整过程 ▸$/);
	});

	it("comes after the memory the turn kept, a blank row between", () => {
		const memory = {
			op: "created" as const,
			kind: "memory" as const,
			scope: "global" as const,
			title: "结论",
			at: AT - 1_000,
		};
		const lines = rows(facts({ memories: [{ key: "m1", change: memory }] }));
		const note = lines.findIndex((line) => line.includes(NOTE));
		const kept = lines.findIndex((line) => line.includes("✦"));
		expect(kept).toBeGreaterThan(-1);
		expect(note).toBeGreaterThan(kept);
		expect(lines[note - 1]).toBe("         │");
	});

	it("stays out of the strip when the turn has no such row", () => {
		const lines = rows(facts({ afterAnswer: undefined }));
		expect(lines.some((line) => line.includes("◆"))).toBe(false);
	});

	it("is cut to the width on a narrow screen", () => {
		const raw = new TurnStripComponent({
			timeline: new TurnTimeline(),
			facts: () => facts(),
			requestRender: vi.fn(),
		}).render(40);
		expect(raw.length).toBeGreaterThan(0);
		for (const line of raw) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
		expect(plain(raw).some((line) => line.includes("◆") && line.includes("…"))).toBe(true);
	});
});
