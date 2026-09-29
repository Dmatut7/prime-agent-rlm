import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createCompactionOutcomeMessage, createRefinementFailureMessage } from "../src/core/messages.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import { TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { built, type ReplayHost, replay, screenLines, summariesOf } from "./tl-fd-helpers.js";
import { assistant, host, plain, quietTurn, T0 } from "./ui-blocks-helpers.js";
import { LiveChat } from "./ui-live-chat.js";

/**
 * What the box says about a compaction and a retry, and how a turn's closing row and thoughts
 * behave: the live flow and both replays draw the same lines.
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

function step(id: string, at: number, words: string): AgentMessage[] {
	return [
		assistant(
			at,
			[
				{ type: "text", text: words },
				{ type: "toolCall", id, name: "ipython", arguments: { code: `await bash('${id}')` } },
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

/** Every event of every turn opened, then the chat's lines. */
function openedLines(children: readonly Component[]): string[] {
	for (const turn of children) {
		if (!(turn instanceof TurnSummaryComponent)) continue;
		turn.render(100);
		for (const key of turn.getFocusOrder()) if (key.startsWith("ev:")) turn.activate(key);
		turn.render(100);
	}
	return screenLines(children);
}

describe("a compaction that failed", () => {
	const REASON = "boom: no room";
	const FAILED = `这次没整理成：${REASON}`;

	function liveRun(): LiveChat {
		const chat = new LiveChat();
		chat.user(ASK);
		chat.say(T0 + 1_000, {
			words: "先看目录里有什么。",
			calls: [{ id: "c1", code: "await bash('ls')", endsAt: T0 + 1_500 }],
		});
		chat.flow.compactionStart("threshold");
		chat.flow.compactionEnd({ reason: "threshold", aborted: false, errorMessage: REASON, errorSeverity: "error" });
		chat.say(T0 + 3_000, { words: "升级好了。" });
		chat.endRun();
		vi.advanceTimersByTime(1_000);
		return chat;
	}

	function messages(): AgentMessage[] {
		return [
			{ role: "user", content: ASK, timestamp: T0 },
			...step("c1", T0 + 1_000, "先看目录里有什么。"),
			createCompactionOutcomeMessage(REASON, { reason: "threshold", outcome: "failed" }, true, T0 + 2_000),
			assistant(T0 + 3_000, [{ type: "text", text: "升级好了。" }], "stop"),
		];
	}

	const line = (lines: string[]) => lines.find((entry) => entry.includes(FAILED)) ?? "";

	it("is a line of the timeline of its own when the turn ends well, live and in both replays", async () => {
		const chat = liveRun();
		const replayed = await replay(messages());
		for (const [where, lines] of [
			["live", screenLines(chat.chat.children)],
			["mode replay", screenLines(replayed.chatContainer.children)],
			["builder", screenLines(built(messages()))],
		] as const) {
			expect(line(lines), where).not.toBe("");
			expect(line(lines), where).toMatch(/^ HH:MM {3}◆ {6}这次没整理成/);
			expect(line(lines), where).not.toContain("步 ▸");
		}
		chat.flow.dispose();
	});

	it("draws the same lines live and replayed, and keeps the event of the step it interrupted apart", async () => {
		const chat = liveRun();
		const replayed = await replay(messages());
		expect(screenLines(replayed.chatContainer.children)).toEqual(screenLines(chat.chat.children));
		expect(screenLines(built(messages()))).toEqual(screenLines(chat.chat.children));
		expect(screenLines(replayed.chatContainer.children).filter((entry) => entry.includes(FAILED))).toHaveLength(1);
		chat.flow.dispose();
	});

	it("is drawn in the warning color, the way a failed retry is", async () => {
		const replayed = await replay(messages());
		const raw = replayed.chatContainer.children.flatMap((child) => child.render(100));
		const drawn = raw.find((entry) => plain([entry])[0]?.includes(FAILED)) ?? "";
		expect(drawn).toContain(theme.getFgAnsi("timelineMust"));
	});

	it("leaves a compaction that only waited (skipped) among the steps it interrupted", async () => {
		const skipped: AgentMessage[] = [
			{ role: "user", content: ASK, timestamp: T0 },
			...step("c1", T0 + 1_000, "先看目录里有什么。"),
			createCompactionOutcomeMessage(
				"Auto-compaction skipped: conversation is too short to compact",
				{ reason: "threshold", outcome: "skipped" },
				true,
				T0 + 2_000,
			),
			assistant(T0 + 3_000, [{ type: "text", text: "升级好了。" }], "stop"),
		];
		const replayed = await replay(skipped);
		const closed = screenLines(replayed.chatContainer.children);
		expect(closed.some((entry) => entry.includes("暂不整理"))).toBe(false);
		expect(openedLines(replayed.chatContainer.children).some((entry) => entry.includes("暂不整理"))).toBe(true);
	});
});

describe("a compaction after the turn's last answer", () => {
	const DONE = "整理完成（原来 166k tokens），重要的结论都留着";

	function liveRun(): LiveChat {
		const chat = new LiveChat();
		chat.user(ASK);
		chat.say(T0 + 1_000, {
			words: "先看目录里有什么。",
			calls: [{ id: "c1", code: "await bash('ls')", endsAt: T0 + 1_500 }],
		});
		chat.say(T0 + 3_000, { words: "升级好了。" });
		chat.endRun();
		chat.flow.compactionStart("threshold");
		chat.flow.compactionEnd({ reason: "threshold", result: { tokensBefore: 166_000 }, aborted: false });
		vi.advanceTimersByTime(1_000);
		return chat;
	}

	function messages(): AgentMessage[] {
		return [
			{ role: "user", content: ASK, timestamp: T0 },
			...step("c1", T0 + 1_000, "先看目录里有什么。"),
			assistant(T0 + 3_000, [{ type: "text", text: "升级好了。" }], "stop"),
			{ role: "compactionSummary", summary: "## 目标\n升级依赖", tokensBefore: 166_000, timestamp: T0 + 4_000 },
		];
	}

	it("is a line of its own after the last event, not a step of an event that ended", async () => {
		const chat = liveRun();
		const replayed = await replay(messages());
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", replayed.chatContainer.children],
			["builder", built(messages())],
		] as const) {
			const lines = screenLines(children);
			const at = lines.findIndex((entry) => entry.includes(DONE));
			expect(at, where).toBeGreaterThan(-1);
			expect(lines[at], where).not.toContain("步 ▸");
			// The event of the command still counts its one step.
			expect(
				lines.some((entry) => entry.includes("先看目录里有什么") && entry.includes("1 步 ▸")),
				where,
			).toBe(true);
			const opened = openedLines(children);
			const inSteps = opened.filter((entry) => entry.includes("⇣") && entry.includes(DONE));
			expect(inSteps, where).toEqual([]);
		}
		chat.flow.dispose();
	});

	it("draws the same lines live and replayed", async () => {
		const chat = liveRun();
		const replayed = await replay(messages());
		expect(screenLines(replayed.chatContainer.children)).toEqual(screenLines(chat.chat.children));
		expect(screenLines(built(messages()))).toEqual(screenLines(chat.chat.children));
		chat.flow.dispose();
	});

	it("still lists a compaction between two steps of a turn as a step of the event it interrupts", async () => {
		const between: AgentMessage[] = [
			{ role: "user", content: ASK, timestamp: T0 },
			...step("c1", T0 + 1_000, "先看目录里有什么。"),
			{ role: "compactionSummary", summary: "## 目标\n升级依赖", tokensBefore: 166_000, timestamp: T0 + 2_000 },
			assistant(T0 + 3_000, [{ type: "text", text: "升级好了。" }], "stop"),
		];
		const replayed = await replay(between);
		const closed = screenLines(replayed.chatContainer.children);
		expect(closed.some((entry) => entry.includes(DONE))).toBe(false);
		expect(openedLines(replayed.chatContainer.children).some((entry) => entry.includes(`⇣  ${DONE}`))).toBe(true);
	});
});

describe("a model call that a retry followed", () => {
	const ERROR = "request timed out";

	function liveRun(): LiveChat {
		const chat = new LiveChat();
		chat.user(ASK);
		const failed = { ...assistant(T0 + 1_000, [], "error"), errorMessage: ERROR };
		chat.flow.assistantStart(failed);
		chat.flow.assistantEnd(failed);
		chat.flow.retryStart({ delayMs: 2_000, attempt: 1, errorMessage: ERROR });
		chat.flow.retryEnd({ success: true });
		chat.say(T0 + 4_000, { words: "升级好了。" });
		chat.endRun();
		vi.advanceTimersByTime(1_000);
		return chat;
	}

	function messages(): AgentMessage[] {
		return [
			{ role: "user", content: ASK, timestamp: T0 },
			{ ...assistant(T0 + 1_000, [], "error"), errorMessage: ERROR },
			assistant(T0 + 4_000, [{ type: "text", text: "升级好了。" }], "stop"),
		];
	}

	it("says 已自动重试 in the replays as it does live, never a model error the next step fixed", async () => {
		const chat = liveRun();
		const replayed = await replay(messages());
		for (const [where, children] of [
			["live", chat.chat.children],
			["mode replay", replayed.chatContainer.children],
			["builder", built(messages())],
		] as const) {
			const opened = openedLines(children).join("\n");
			expect(opened, where).toContain("↻  模型接口超时，已自动重试");
			expect(opened, where).not.toContain("模型出错");
			expect(opened, where).not.toContain("下一格改好了");
		}
		chat.flow.dispose();
	});

	it("draws the same lines live and replayed, closed and opened", async () => {
		const chat = liveRun();
		const replayed = await replay(messages());
		expect(screenLines(replayed.chatContainer.children)).toEqual(screenLines(chat.chat.children));
		expect(screenLines(built(messages()))).toEqual(screenLines(chat.chat.children));
		expect(openedLines(replayed.chatContainer.children)).toEqual(openedLines(chat.chat.children));
		chat.flow.dispose();
	});

	it("still says a model error that nothing followed", async () => {
		const ended: AgentMessage[] = messages().slice(0, 2);
		const replayed = await replay(ended);
		const lines = screenLines(replayed.chatContainer.children).join("\n");
		expect(lines).toContain("模型出错：request timed out");
		expect(lines).not.toContain("已自动重试");
	});
});

describe("a memory line that arrives after the turn finished", () => {
	type AddProto = { addMessageToChat(this: ReplayHost, message: AgentMessage): void };
	const addProto = InteractiveMode.prototype as unknown as AddProto;
	const tidy = (at: number) =>
		createRefinementFailureMessage({ refinementId: "r1", scope: "local", reason: "超时" }, true, at);
	const TIDY = "回合后整理记忆：没写进去";

	const asked: AgentMessage[] = [
		{ role: "user", content: ASK, timestamp: T0 },
		assistant(T0 + 1_000, [{ type: "text", text: "升级好了。" }], "stop"),
	];

	/** The chat's components after the answer, in order, by what they are. */
	function tail(host: ReplayHost): string[] {
		const children = host.chatContainer.children;
		const out: string[] = [];
		for (const child of children.slice(-4)) {
			if (child instanceof TurnStripComponent) out.push("closing");
			else if (child instanceof RefinementOutcomeMessageComponent) out.push("memory");
			else out.push("other");
		}
		return out;
	}

	it("sits above the closing row when it arrives live and when the session is reopened", async () => {
		const reopened = await replay([...asked, tidy(T0 + 2_000)]);
		expect(tail(reopened).slice(-2)).toEqual(["memory", "closing"]);

		const live = await replay(asked);
		vi.advanceTimersByTime(1_000);
		addProto.addMessageToChat.call(live, tidy(T0 + 2_000));
		expect(tail(live).slice(-2)).toEqual(["memory", "closing"]);

		expect(screenLines(live.chatContainer.children).join("\n")).toContain(TIDY);
		expect(summariesOf(live.chatContainer.children)).toHaveLength(1);
	});

	it("draws the closing row as the last line either way", async () => {
		const reopened = await replay([...asked, tidy(T0 + 2_000)]);
		const live = await replay(asked);
		addProto.addMessageToChat.call(live, tidy(T0 + 2_000));
		const last = (host: ReplayHost) =>
			plain(host.chatContainer.children.flatMap((child) => child.render(100)))
				.map((entry) => entry.trimEnd())
				.filter((entry) => entry !== "")
				.at(-1);
		expect(last(live)).toBe(last(reopened));
		expect(last(live)).not.toContain(TIDY);
	});
});

describe("Ctrl+T after Ctrl+O", () => {
	function finished(commands: number) {
		const turn = quietTurn({ live: false, host: host(), startedAt: T0 });
		turn.timeline.noteMessage(
			assistant(
				T0,
				[
					{ type: "thinking", thinking: "先想第一步。再想第二步。" },
					{ type: "text", text: "我跑几条命令。" },
					...Array.from({ length: commands }, (_, index) => ({
						type: "toolCall" as const,
						id: `c${index + 1}`,
						name: "ipython",
						arguments: { code: `await bash('cmd${index + 1}')` },
					})),
				],
				"toolUse",
			),
			true,
		);
		for (let index = 0; index < commands; index++) {
			const id = `c${index + 1}`;
			turn.state.addStep({
				toolCallId: id,
				toolName: "ipython",
				args: { code: `await bash('cmd${index + 1}')` },
				status: "queued",
			});
			turn.state.setStepStatus(id, "running", T0 + (index + 1) * 1_000);
			turn.state.setStepStatus(id, "done", T0 + (index + 1) * 1_000 + 500);
		}
		turn.state.markTurnEnded(T0 + 10_000);
		turn.state.finishBox(T0 + 10_000);
		return turn;
	}

	const draw = (turn: ReturnType<typeof finished>) => plain(turn.summary.render(100)).join("\n");

	it("opens the thoughts again on the third press, not the fold of what is already out of sight", () => {
		const turn = finished(4);
		expect(draw(turn)).not.toContain("思考了");
		turn.summary.toggleThinkingRows();
		expect(draw(turn)).toContain("思考了 先想第一步");
		turn.summary.toggleBox();
		expect(draw(turn)).not.toContain("思考了");
		turn.summary.toggleThinkingRows();
		expect(draw(turn)).toContain("思考了 先想第一步");
		turn.summary.toggleThinkingRows();
		expect(draw(turn)).not.toContain("思考了");
	});

	it("opens them again when the owner folded the event by hand", () => {
		const turn = finished(4);
		turn.summary.toggleThinkingRows();
		turn.summary.render(100);
		const key = turn.summary.getFocusOrder().find((entry) => entry.startsWith("ev:")) ?? "";
		expect(key).not.toBe("");
		turn.summary.activate(key);
		expect(draw(turn)).not.toContain("思考了");
		turn.summary.toggleThinkingRows();
		expect(draw(turn)).toContain("思考了 先想第一步");
	});
});
