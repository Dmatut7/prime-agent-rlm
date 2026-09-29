import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessage,
	createAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { initTheme, type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";
import { assistant } from "./ui-blocks-helpers.js";
import { LiveChat } from "./ui-live-chat.js";

/**
 * Data shaped like the owner's real review session (01a0ecc6…): the four subagents are started from a
 * Python cell, so the kernel's record of that cell lists them as `subagent` activities named after
 * their sessions and no snapshot ever tells the timeline; the reports come as `agent_message`s from
 * `child:<session name>`; a notice says a child finished without a word.
 */

let chalkLevel: typeof chalk.level;

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
	chalkLevel = chalk.level;
	chalk.level = 3;
});

afterAll(() => {
	chalk.level = chalkLevel;
});

afterEach(() => {
	setMotionReduced(false);
	timelineShowAll.set(false);
	vi.useRealTimers();
});

const at = (h: number, m: number, s = 0) => new Date(2026, 8, 29, h, m, s).getTime();
const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b[\]_][^\x07]*\x07/g, ""));

const NAMES = ["review-grow-A-tui", "review-grow-B-box", "review-grow-C-strip", "review-grow-D-hygiene"];

/** The kernel's record of the cell that started the four subagents (real field values). */
const SPAWN_DETAILS = {
	durationMs: 1850,
	status: "ok",
	stdout: `${NAMES.join(" ")}\n`,
	activities: NAMES.map((label, index) => ({
		id: `subagent-${8 + index}`,
		kind: "subagent",
		label,
		status: "ok",
		detail: index < 2 ? "bailian/glm-5.3-prime" : "bailian/deepseek-v4.1-flash",
		startedAt: at(18, 48, index),
		endedAt: at(18, 48, index + 1),
	})),
};

function report(name: string, at_: number, conclusion: string): AgentSessionMessage {
	return createAgentSessionMessage(
		{
			id: `agentmsg_${name}`,
			source: AGENT_MESSAGE_SOURCE,
			message: `车道（${name}）审查完成，报告：/tmp/review/${name}.md\n\n结论：${conclusion}`,
			from: { sessionName: name, sessionId: `${name}-session`, activeSessionId: `${name}-active` },
			fromRelationship: "child",
			target: { activeSessionId: "main-active", sessionId: "main" },
		},
		at_,
	);
}

function toolResult(
	id: string,
	at_: number,
	details: unknown = { status: "ok", stdout: "" },
	isError = false,
): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text: isError ? "命令失败" : "ok" }],
		details,
		isError,
		timestamp: at_,
	};
}

function call(id: string, at_: number, words: string | undefined, code = "print(1)"): AgentMessage {
	return assistant(
		at_,
		[
			...(words ? [{ type: "text" as const, text: words }] : []),
			{ type: "toolCall" as const, id, name: "ipython", arguments: { code } },
		],
		"toolUse",
	);
}

/** The review as a transcript: a spawn cell, the AI's own checks, four reports, the summary. */
function transcript(): AgentMessage[] {
	const messages: AgentMessage[] = [
		{ role: "user", content: "对最近的改动做全面的审查 多个代理一起", timestamp: at(18, 47) },
		call("c1", at(18, 47, 5), "先看最近的提交。"),
		toolResult("c1", at(18, 47, 6)),
		call("spawn", at(18, 48), "四个车道并行审查。", "await rlm.spawn('review-grow-A-tui', task)"),
		toolResult("spawn", at(18, 48, 4), SPAWN_DETAILS),
		call("c2", at(18, 50), "趁它们干活，我自己跑检查。"),
		toolResult("c2", at(18, 50, 5)),
		call("c3", at(18, 53), "还在跑测试。"),
		toolResult("c3", at(18, 53, 5)),
	];
	const back: Array<[string, number, number, string]> = [
		[NAMES[1] ?? "", 18, 54, "无 P0/P1，7 条 P2"],
		[NAMES[0] ?? "", 19, 0, "无 P0、无 P1，4 条 P2"],
		[NAMES[3] ?? "", 19, 4, "P0×1、P1×2"],
		[NAMES[2] ?? "", 19, 5, "无 P0"],
	];
	back.forEach(([name, hour, minute, conclusion], index) => {
		messages.push(report(name, at(hour, minute), conclusion));
		messages.push(call(`d${index}`, at(hour, minute, 30), `车道交卷了，我接着查 ${index}。`));
		messages.push(toolResult(`d${index}`, at(hour, minute, 40)));
	});
	messages.push(assistant(at(19, 6), [{ type: "text", text: "审查完成，四车道都收口了。" }], "stop"));
	return messages;
}

function replay(messages: AgentMessage[], width = 160): string[] {
	const container = new Container();
	for (const component of buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
	})) {
		container.addChild(component);
	}
	return plain(container.render(width));
}

describe("subagents started from a Python cell get their dispatch row and lane", () => {
	it("replays the dispatch row, the dotted lane, the returns and the join", () => {
		setMotionReduced(true);
		const rows = replay(transcript());
		const split = rows.findIndex((row) => row.includes("├──╮"));
		expect(split).toBeGreaterThan(0);
		expect(rows[split]?.trimEnd()).toBe("         ├──╮   ◇  A   B   C   D");
		// The cell's own records are not listed a second time as steps.
		expect(rows.join("\n")).not.toContain("子代理 review-grow");
		const join = rows.findIndex((row) => row.includes("├──╯"));
		expect(join).toBeGreaterThan(split);
		expect(rows[join]?.trimEnd()).toBe("         ├──╯   四个都交回了");
		expect(rows.filter((row) => row.includes("├──╯"))).toHaveLength(1);
		// From the dispatch to the last return every row is on the lane; before and after none is.
		for (const row of rows.slice(split + 1, join)) expect(row.slice(10, 13), row).toMatch(/^ {2}[┆◇]$/);
		for (const row of rows.slice(0, split)) expect(row.slice(10, 13), row).toBe("   ");
		for (const row of rows.slice(join + 1)) expect(row.slice(10, 13), row).toBe("   ");
		const returns = rows.filter((row) => /│ {2}◇ {3}\S 交回/.test(row));
		expect(returns.map((row) => /◇ {3}(\S) 交回/.exec(row)?.[1])).toEqual(["B", "A", "D", "C"]);
	});

	it("lights the events between the dispatch and the returns even though every subagent is back", () => {
		setMotionReduced(true);
		const rows = replay(transcript());
		const during = rows.find((row) => row.includes("趁它们干活")) ?? "";
		expect(during.slice(0, 16)).toMatch(/^ 18:50 {3}◆ {2}┆ {3}$/);
		const before = rows.find((row) => row.includes("先看最近的提交")) ?? "";
		expect(before.slice(10, 13)).toBe("   ");
		// After A's return D and C are still out; after C's, the last one, nobody is.
		const between = rows.find((row) => row.includes("我接着查 1")) ?? "";
		expect(between.slice(10, 13)).toBe("  ┆");
		const after = rows.find((row) => row.includes("我接着查 3")) ?? "";
		expect(after.slice(10, 13)).toBe("   ");
	});

	it("draws the same dispatch live, from the cell's records alone", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "四个车道并行审查。",
			calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: SPAWN_DETAILS, endsAt: at(18, 48, 4) }],
		});
		expect(chat.flow.subagentLane.tracker.pending).toEqual(NAMES);
		chat.say(at(18, 50), { words: "趁它们干活，我自己跑检查。" });
		const rows = plain(chat.lines(160));
		expect(rows.find((row) => row.includes("├──╮"))?.trimEnd()).toBe("         ├──╮   ◇  A   B   C   D");
		NAMES.forEach((name, index) => {
			vi.setSystemTime(at(19, index));
			chat.report(report(name, at(19, index), "没问题"));
		});
		expect(chat.flow.subagentLane.tracker.active).toBe(false);
		// Something drawn after the last return, so the rows below the join are there to be checked.
		chat.say(at(19, 5), { words: "四个都交回了，我来汇总。" });
		const done = plain(chat.lines(160));
		expect(done.filter((row) => row.includes("├──╯"))).toHaveLength(1);
		const join = done.findIndex((row) => row.includes("├──╯"));
		expect(join).toBeGreaterThan(-1);
		const after = done.slice(join + 1);
		expect(after.length).toBeGreaterThan(0);
		for (const row of after) expect(row.slice(10, 13), row).toBe("   ");
		chat.flow.dispose();
	});

	it("does not draw the dispatch twice when a snapshot of the same subagent arrives too", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "四个车道并行审查。",
			calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: SPAWN_DETAILS, endsAt: at(18, 48, 4) }],
		});
		for (const name of NAMES) {
			chat.child({
				id: `child-${name}`,
				label: `${name.slice(-4)}：检查这一批的改动`,
				sessionName: name,
				activeSessionId: `${name}-active`,
				status: "running",
				sessionDir: `/tmp/${name}`,
			});
		}
		const rows = plain(chat.lines(160));
		expect(rows.filter((row) => row.includes("├──╮"))).toHaveLength(1);
		expect(rows.find((row) => row.includes("├──╮"))).toContain("A ");
		expect(chat.flow.subagentLane.tracker.pending).toEqual(NAMES);
		chat.flow.dispose();
	});
});

/** The round the real session shows after its summary: a notice that a child finished without a word. */
describe("a round woken only by a silent-finish notice", () => {
	const ACK =
		"查过了，这条通知不用处理：车道 C 其实交了报告——我上一轮就收到了它的回复和完整报告文件，内容也已经并入给你的总报告里（就是 256 色撞码根因、旧面板信息丢失那几条）。它的报告文件还在 /tmp/review_20260929_growbatch/车道C_报告.md，四份车道报告都在原处，这条「没发回复」的系统提示是记账滞后，实际交付齐全。";

	function afterSummary(extra: AgentMessage[] = [], reply: AgentMessage | undefined = undefined): AgentMessage[] {
		const readReport = assistant(
			at(19, 7),
			[
				{ type: "thinking", thinking: "先确认它交没交。" },
				{
					type: "toolCall",
					id: "n1",
					name: "ipython",
					arguments: { code: 'print(open("/tmp/review/车道C_报告.md").read()[:200])' },
				},
			],
			"toolUse",
		);
		return [
			...transcript(),
			createRlmChildTerminalNoticeMessage(
				{ kind: "completed_without_reply", childId: "sub-80b28b9e", sessionName: NAMES[2] ?? "" },
				at(19, 8),
			),
			readReport,
			toolResult("n1", at(19, 8, 5), {
				status: "ok",
				stdout: "exists: True\n",
				activities: [
					{
						id: "cmd-1",
						kind: "command",
						label: "cat 车道C_报告.md",
						status: "ok",
						detail: "",
						startedAt: at(19, 8, 2),
						endedAt: at(19, 8, 4),
					},
				],
			}),
			...extra,
			reply ?? assistant(at(19, 9), [{ type: "text", text: ACK }], "stop"),
		];
	}

	it("draws nothing of a long acknowledgement with three steps, and everything with 完整过程", () => {
		setMotionReduced(true);
		expect(ACK.length).toBeGreaterThan(150);
		const rows = replay(afterSummary());
		const screen = rows.join("\n");
		expect(screen).toContain("审查完成，四车道都收口了。");
		expect(screen).not.toContain("查过了，这条通知不用处理");
		expect(rows.filter((row) => row.endsWith("总结"))).toHaveLength(1);
		timelineShowAll.set(true);
		expect(replay(afterSummary()).join("\n")).toContain("查过了，这条通知不用处理");
	});

	it("keeps the round when it saved a memory or ended on an unfixed error", () => {
		setMotionReduced(true);
		const memory = toolResult("n2", at(19, 8, 30), {
			status: "ok",
			memoryChanges: [
				{
					op: "created",
					kind: "memory",
					scope: "session",
					title: "车道 收口 记账",
					after: "已核",
					at: at(19, 8, 30),
				},
			],
		});
		const saved = replay(afterSummary([call("n2", at(19, 8, 20), undefined), memory])).join("\n");
		expect(saved).toContain("查过了，这条通知不用处理");
		// The run ended right after a failed step, its last reply cut off: nothing corrected the failure.
		const broken = toolResult("n3", at(19, 8, 40), { status: "error", error: "命令失败" }, true);
		const cut = assistant(at(19, 9), [{ type: "text", text: "查过了，这条通知不用处理，让我再试" }], "length");
		const failed = replay(afterSummary([call("n3", at(19, 8, 35), undefined), broken], cut)).join("\n");
		expect(failed).toContain("查过了，这条通知不用处理");
		// A failed step the AI then corrected and answered is not an alarm: the round stays out of sight.
		const fixed = replay(afterSummary([call("n3", at(19, 8, 35), undefined), broken])).join("\n");
		expect(fixed).not.toContain("查过了，这条通知不用处理");
	});
});

/** The AI's sentences as the real session has them: backticks, bold, and a link, all raw in the text. */
describe("inline markdown in event rows", () => {
	const WORDS = [
		"上次审查收在 `adc7ca82c`（16:43），之后又落了一批。",
		"**HEAD 上本批新测试有 4 个失败**（2 个文件，`grow-bottom-tui.test.ts` 悬停断言等），而且 **tui 包 690 行的测试**没人看。",
		"设计稿见 [方向二](https://claude.ai/artifact/Xv4F9BkxFzPvdsLmARpvbN?sk=x)，路径 `**/*.ts` 要留着。",
	];

	function chatWith(words: string[]): LiveChat {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		words.forEach((text, index) => {
			chat.say(at(18, 48 + index), {
				words: text,
				calls: [{ id: `k${index}`, code: "print(1)", details: {}, endsAt: at(18, 48 + index, 2) }],
			});
		});
		chat.endRun();
		vi.advanceTimersByTime(1000);
		return chat;
	}

	it("draws code without its backticks, bold without its asterisks, and a link as its text", () => {
		const rows = plain(chatWith(WORDS).lines(160));
		const events = rows.filter((row) => /^ \d\d:\d\d {3}◆ {6}/.test(row));
		expect(events).toHaveLength(3);
		expect(events[0]).toContain("上次审查收在 adc7ca82c（16:43），之后又落了一批。");
		expect(events[1]).toContain(
			"HEAD 上本批新测试有 4 个失败（2 个文件，grow-bottom-tui.test.ts 悬停断言等），而且 tui 包 690 行的测试没人看。",
		);
		expect(events[2]).toContain("设计稿见 方向二，路径 **/*.ts 要留着。");
		for (const row of events) {
			expect(row).not.toContain("`");
			expect(row).not.toContain("https://");
		}
		expect(events[1]).not.toContain("**");
	});

	it("paints bold words bold and code in the soft color, the rest in the text color", () => {
		const raw = chatWith(WORDS).lines(160);
		const line = raw.find((row) => stripAnsi(row).includes("HEAD 上本批新测试")) ?? "";
		expect(line).toContain(theme.bold(theme.fg("text", "HEAD 上本批新测试有 4 个失败")));
		expect(line).toContain(theme.fg("timelineSoft", "grow-bottom-tui.test.ts"));
		expect(line).toContain(theme.fg("text", "（2 个文件，"));
		const first = raw.find((row) => stripAnsi(row).includes("上次审查收在")) ?? "";
		expect(first).toContain(theme.fg("timelineSoft", "adc7ca82c"));
		const color = (token: ThemeColor) => theme.fg(token, "x").split("x")[0];
		expect(color("timelineSoft")).not.toBe(color("text"));
	});

	it("still says a cut line opens to the whole text, without the markup", () => {
		const long = `**${"很长的一句话".repeat(30)}**，后面还有 \`code\`。`;
		const chat = chatWith([long]);
		const rows = plain(chat.lines(100));
		const event = rows.find((row) => /^ \d\d:\d\d {3}◆ {6}/.test(row)) ?? "";
		expect(event).not.toContain("**");
		expect(event.trimEnd().endsWith("▸")).toBe(true);
	});

	it("puts no raw markup on the live tail's sentence", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("看一下");
		vi.setSystemTime(at(18, 57));
		chat.say(
			at(18, 57),
			{
				thought: "实锤了，**256 色下四个底色撞码**，见 [报告](https://x.y/z)，先看 `kindSubagentBg`。",
				calls: [
					{
						id: "r1",
						code: 'r = await bash("npm test")',
						details: {
							activities: [
								{
									id: "r1-a",
									kind: "command",
									label: "npm test",
									status: "running",
									detail: "",
									startedAt: at(18, 57),
								},
							],
						},
					},
				],
			},
			{ open: true },
		);
		const spinner = plain(chat.lines(160)).find((row) => /^ \d\d:\d\d {3}[⠀-⣿]/.test(row)) ?? "";
		expect(spinner).toContain("实锤了，256 色下四个底色撞码，见 报告，先看 kindSubagentBg");
		for (const raw of ["**", "`", "https://", "]("]) expect(spinner).not.toContain(raw);
		chat.flow.dispose();
	});
});

/** The real session's first turn: about 45 events in a row, every step narrated. */
describe("a long stretch of events folds to the first, the last two and what carries news", () => {
	const TEXTS = [
		"收到，我先看仓库最近的提交，确定这次要审的范围。",
		"上次审查收在 `adc7ca82c`（16:43），之后到现在 18:41 又落了一批。",
		"96 个文件，+5487/-852。我把完整文件清单拿出来，好切车道。",
		"发版提交已推（origin 在 `c18d3e534`），grow 这批 19 个提交还没推。",
		"预检结论：四个包版本齐平 0.11.15，旧 fragment 全部折叠干净。",
		"`npm run check` 里带 `biome --write` 会改工作区文件，我改跑只读等价物。",
		"后台五个检查已启动。等结果的同时我自己抽读最高风险的两个文件。",
		"命令拼错了（`env -u` 少写了 `env` 前缀），不作数。重跑。",
		"重跑期间，我抽读 `subagent-summary-line.ts` 的重写。",
		"点击处理是点击时按键重新查当前项，处理正确。",
		"**HEAD 上本批新测试有 4 个失败**，而且 tui 包的测试其实会被 `npm test` 跑到。",
		"4 个失败全部定位到子代理条带这一族。",
		"直接用仓库的 theme 模块算两色的转义码。",
		"实锤了，这是个真产品缺陷，不只是测试问题。",
		"主题按 `COLORTERM` 判真彩，macOS Terminal.app 这类常见终端落到 256 色。",
	];

	/** Words that carry news, by the rule the timeline states: bold, or 发现 / 实锤 / 出错 / 失败 / 问题 / 结论. */
	const carriesNews = (text: string) => /\*\*[^*\n]+\*\*|发现|实锤|出错|失败|问题|结论/.test(text);

	function longTurn(count: number, options: { dispatchAfter?: number } = {}): LiveChat {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("对最近的改动做全面的审查 多个代理一起");
		for (let index = 0; index < count; index++) {
			const time = at(18, 47) + index * 20_000;
			vi.setSystemTime(time);
			const spawn = options.dispatchAfter === index + 1;
			chat.say(time, {
				words: `${TEXTS[index % TEXTS.length]}（第 ${index + 1} 件）`,
				calls: [
					spawn
						? { id: `s${index}`, code: "await rlm.spawn(...)", details: SPAWN_DETAILS, endsAt: time + 4_000 }
						: { id: `k${index}`, code: "print(1)", details: {}, endsAt: time + 2_000 },
				],
			});
		}
		chat.say(at(19, 30), { words: "审查完成。" });
		chat.endRun();
		vi.advanceTimersByTime(1000);
		return chat;
	}

	const eventRows = (chat: LiveChat, width = 160) =>
		plain(chat.lines(width)).filter((row) => /^ \d\d:\d\d {3}◆ {2}[ ┆]/.test(row) && !row.endsWith("总结"));
	const foldRows = (chat: LiveChat, width = 160) => plain(chat.lines(width)).filter((row) => row.includes("⋯  中间"));

	it("shows the first event, the last two and up to three that carry news; the rest is one folded row", () => {
		const chat = longTurn(45);
		const rows = plain(chat.lines(160));
		const events = rows.filter((row) => /^ \d\d:\d\d {3}◆ {6}/.test(row) && !row.endsWith("总结"));
		const texts = Array.from({ length: 45 }, (_, index) => `${TEXTS[index % TEXTS.length]}（第 ${index + 1} 件）`);
		const middle = texts.slice(1, -2);
		const news = middle.filter(carriesNews).slice(0, 3);
		expect(news.length).toBe(3);
		const stripped = (text: string) => text.replace(/`/g, "").replace(/\*\*/g, "");
		const shown = [texts[0], ...news, ...texts.slice(-2)].map(stripped);
		expect(events).toHaveLength(shown.length);
		shown.forEach((text, index) => {
			expect(events[index], text).toContain(text.slice(0, 30));
		});
		const folds = foldRows(chat);
		expect(folds.length).toBeGreaterThan(0);
		const hiddenTotal = folds
			.map((row) => Number(/中间还有 (\d+) 件事/.exec(row)?.[1]))
			.reduce((sum, count) => sum + count, 0);
		expect(hiddenTotal).toBe(45 - shown.length);
		for (const row of folds) {
			expect(row).toMatch(/^ {9}│ {6}⋯ {2}中间还有 \d+ 件事 +\d+ 件事 ▸ {2}$/);
		}
		chat.flow.dispose();
	});

	it("opens the folded events in place on a click and closes them again with 收起", () => {
		const chat = longTurn(45);
		const summary = chat.summaries()[0]!;
		summary.render(160);
		const key = summary.getFocusOrder().find((candidate) => candidate.startsWith("hid:")) ?? "";
		expect(key).not.toBe("");
		const before = eventRows(chat).length;
		expect(summary.enterLabel(key)).toBe("展开");
		summary.activate(key);
		const opened = plain(chat.lines(160));
		expect(eventRows(chat).length).toBeGreaterThan(before);
		expect(opened.some((row) => row.includes("⋯  中间还有") && row.trimEnd().endsWith("▴ 收起"))).toBe(true);
		expect(summary.enterLabel(key)).toBe("收起");
		summary.activate(key);
		expect(eventRows(chat).length).toBe(before);
		chat.flow.dispose();
	});

	it("keeps the steps of a folded event reachable once the fold is opened", () => {
		const chat = longTurn(45);
		const summary = chat.summaries()[0]!;
		summary.render(160);
		summary.activate(summary.getFocusOrder().find((candidate) => candidate.startsWith("hid:")) ?? "");
		summary.render(160);
		const hiddenEvent = summary.getFocusOrder().filter((candidate) => candidate.startsWith("ev:"))[1] ?? "";
		summary.activate(hiddenEvent);
		expect(plain(summary.render(160)).some((row) => row.includes("Python") || row.includes("做了 1 步"))).toBe(true);
		chat.flow.dispose();
	});

	it("does not fold a stretch of three events or fewer, or a single event in the middle", () => {
		for (const count of [2, 3, 4]) {
			const chat = longTurn(count);
			expect(foldRows(chat), `${count} events`).toEqual([]);
			expect(eventRows(chat)).toHaveLength(count);
			chat.flow.dispose();
		}
	});

	it("folds each stretch between boundaries on its own: the dispatch row ends one, a return starts the next", () => {
		const chat = longTurn(45, { dispatchAfter: 20 });
		chat.report(report(NAMES[0] ?? "", at(19, 20), "没问题"));
		const rows = plain(chat.lines(160));
		const split = rows.findIndex((row) => row.includes("├──╮"));
		expect(split).toBeGreaterThan(0);
		const before = rows.slice(0, split).filter((row) => row.includes("⋯  中间"));
		const after = rows.slice(split + 1).filter((row) => row.includes("⋯  中间"));
		expect(before.length).toBeGreaterThan(0);
		expect(after.length).toBeGreaterThan(0);
		// The event that carries the dispatch row is the last one of its stretch, so it is shown.
		expect(rows[split - 1]).toContain("（第 20 件）");
		chat.flow.dispose();
	});

	it("leaves the events of Tl2Done as they are: its stretches have two events", () => {
		const chat = longTurn(2);
		expect(foldRows(chat)).toEqual([]);
		chat.flow.dispose();
	});
});
