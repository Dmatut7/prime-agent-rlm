import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_SOURCE, createAgentSessionMessage } from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import { type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";
import { quietTurn, useTruecolorTheme } from "./ui-blocks-helpers.js";
import { handedBack, LiveChat } from "./ui-live-chat.js";

/**
 * The finished (Tl2Done) and the running (Tl2Live) review, built the way the interactive mode builds
 * them (its live flow, its rows, its strip) and compared line by line with the design at 160 columns:
 * glyphs, columns, blank rows and the lane. Words the design fixes by hand (a step's result, a
 * command's error) are the fields the real system computes; the rest is the design's.
 */

const W = 160;
let restoreTheme: () => void;
let chalkLevel: typeof chalk.level;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	chalkLevel = chalk.level;
	chalk.level = 3;
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	chalk.level = chalkLevel;
	restoreTheme();
});

afterEach(() => {
	setMotionReduced(false);
	timelineShowAll.set(false);
	vi.useRealTimers();
});

const at = (h: number, m: number, s = 0) => new Date(2026, 8, 29, h, m, s).getTime();
const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));

const LANE = { off: "   ", on: "  ┆", sub: "  ◇", split: "──╮", join: "──╯" } as const;
type Lane = keyof typeof LANE;

/** The design's `row()`: the gutter (` HH:MM   `, the main glyph, the lane, three spaces), content, right side at the edge. */
function drow(time: string, main: string, lane: Lane, content = "", right = ""): string {
	const head = ` ${time || "     "}   ${main}${LANE[lane]}   `;
	const tail = right ? `${right}  ` : "";
	const pad = right
		? " ".repeat(Math.max(1, W - visibleWidth(head) - visibleWidth(content) - visibleWidth(tail)))
		: "";
	return `${head}${content}${pad}${tail}`;
}
const gap = (lane: Lane) => drow("", "│", lane);
/** A step of an opened event: the glyph at column 21, the words, its status four columns from the edge. */
const step = (lane: Lane, glyph: string, words: string, status: string) =>
	drow("", "│", lane, `     ${glyph}  ${words}`, `${status}  `);
const verdict = (time: string, who: string, what: string, text: string) =>
	drow(time, "│", "sub", `${who} 交回   ${what}：${text}`, "›");

function command(
	id: string,
	label: string,
	options: { start: number; tookS?: number; ok?: boolean; detail?: string },
): { id: string; code: string; endsAt: number; details: unknown } {
	const end = options.start + (options.tookS ?? 1) * 1000;
	return {
		id,
		code: `r = await bash(${JSON.stringify(label)})`,
		endsAt: end,
		details: {
			activities: [
				{
					id: `${id}-a`,
					kind: "command",
					label,
					status: options.ok === false ? "error" : "ok",
					detail: options.detail ?? "",
					startedAt: options.start,
					endedAt: end,
				},
			],
		},
	};
}

/** A cell that only touches subagents: the dispatch row says it, so it lists no step of its own. */
function subagentCell(id: string, names: string[], start: number) {
	return {
		id,
		code: "await rlm.spawn(...)",
		details: {
			activities: names.map((name) => ({
				id: `${id}-${name}`,
				kind: "subagent",
				label: name,
				status: "ok",
				detail: "",
				startedAt: start,
				endedAt: start + 1000,
			})),
		},
	};
}

const LABELS: Record<string, string> = {
	A: "钉住框头：检查框头在滚动时是否钉住",
	B: "框的折叠：长高和收起",
	C: "子代理小块：一排块和状态行",
	D: "测试和发版：看发版有没有弄坏测试",
};

function snapshot(
	name: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"] = "running",
): AgentConnectionRlmChildAgentSnapshot {
	return {
		id: `child-${name}`,
		label: LABELS[name] ?? name,
		sessionName: name,
		activeSessionId: `${name}-active`,
		status,
		sessionDir: `/tmp/${name}`,
	};
}

const MEMORY = [
	"范围：merge/repl-kernel 的 adc7ca82c..b4c296f65，16 个提交、96 个文件。",
	"P0：0.11.16 发版提交删掉了三个改动说明文件，grow-fix-copy 测试要读它们，任何环境都会红。",
	"P1：256 色终端里子代理和出错的四个底色变成同一个颜色，普通、悬停、选中分不出来。",
	"修法：新提交修测试和颜色 → 全绿 → 发 0.11.17。",
];

const REPORTS: Array<[number, number, string, string, string]> = [
	[18, 54, "B", "框的长高和折叠", "没问题（7 条小建议）"],
	[19, 0, "A", "钉住框头和滚动", "没问题（4 条小建议）"],
	[19, 3, "D", "测试和发版", "1 条必修，发版删了测试要读的文件"],
	[19, 5, "C", "子代理小块", "1 条要修，256 色撞色"],
];

/** The start of the review both screens share: the question, two events, the dispatch and the AI's own checks. */
function reviewSoFar(chat: LiveChat, options: { steps: number; memory: boolean }): void {
	vi.setSystemTime(at(18, 47));
	chat.setClock(at(18, 47));
	chat.user("对最近的改动做全面的审查 多个代理一起");
	chat.say(at(18, 47, 5), {
		words: "先看最近的提交，定下审查范围。",
		calls: [
			command("c1", "git log --oneline -30", { start: at(18, 47, 6), detail: "30 个提交" }),
			command("c2", "git branch --show-current", { start: at(18, 47, 8), detail: "merge/repl-kernel" }),
		],
	});
	vi.setSystemTime(at(18, 48));
	chat.say(at(18, 48), {
		words: "范围定了：16 个提交、96 个文件。派四个代理并行审查。",
		calls: [subagentCell("spawn", ["A", "B", "C", "D"], at(18, 48))],
	});
	for (const name of ["A", "B", "C", "D"]) chat.child(snapshot(name));
	vi.setSystemTime(at(18, 50));
	const calls = [
		command("t1", "npx tsgo --noEmit", { start: at(18, 50), tookS: 21 }),
		command("t2", "npx vitest --run test/grow-*.test.ts", {
			start: at(18, 50, 22),
			tookS: 38,
			ok: false,
			detail: "Tests  4 failed | 10 passed (14)",
		}),
		{
			id: "t3",
			code: 'r = await bash("ls docs")',
			isError: true,
			text: "引号没闭合",
			details: { error: "引号没闭合" },
			endsAt: at(18, 51, 1),
		},
	];
	for (let index = calls.length + 1; index <= options.steps; index++) {
		const call = command(`t${index}`, `echo ${index}`, { start: at(18, 51, index) });
		if (options.memory && index === 10) {
			(call.details as { memoryChanges?: unknown[] }).memoryChanges = [
				{
					op: "created",
					kind: "memory",
					scope: "session",
					title: "grow 批次审查结论（2026-09-29）",
					after: MEMORY.join("\n"),
					at: at(19, 6, 20),
				},
			];
		}
		calls.push(call);
	}
	chat.say(at(18, 50), { words: "趁它们干活，我自己跑检查和测试。", calls });
}

function report(chat: LiveChat, index: number): void {
	const [hour, minute, name, what, text] = REPORTS[index] ?? REPORTS[0]!;
	vi.setSystemTime(at(hour, minute));
	chat.child(snapshot(name, "done"));
	chat.report(handedBack(`r${index}`, at(hour, minute), name, `车道${name}（${what}）审查完成。\n结论：${text}。`));
}

function finishedReview(): LiveChat {
	const chat = new LiveChat({ spend: () => ({ cost: 4.2, parentCost: 5.6 }) });
	reviewSoFar(chat, { steps: 23, memory: true });
	chat.say(at(18, 53), {
		words: "找到一个问题：256 色终端里四个底色撞成同一个颜色，那 4 个测试失败都是它。",
		calls: [subagentCell("wait", ["A"], at(18, 53))],
	});
	for (let index = 0; index < REPORTS.length; index++) report(chat, index);
	vi.setSystemTime(at(19, 6));
	chat.say(at(19, 6), {
		words: [
			"审查完成，四个代理并行、加上我自己的复核，都收口了。",
			"",
			"**一句话结论**",
			"这批「框长高 + 子代理小块」的代码本身没问题；但 0.11.16 发版时把一个测试弄红了，远程检查现在是红的。",
			"",
			"**要修的三件**",
			"1. 改 grow-fix-copy 测试：发版删掉了它要读的说明文件，任何环境都会红",
			"2. 256 色终端里子代理和出错的底色撞成同一个颜色，要换颜色",
			"3. tui 覆盖率检查从 0.11.15 起就是红的（测试计数差 1），一起修",
		].join("\n"),
	});
	vi.setSystemTime(at(19, 7));
	chat.endRun();
	vi.advanceTimersByTime(1000);
	// The design shows the second event and the memory opened, the first event closed.
	const summary = chat.summaries()[0]!;
	summary.render(W);
	summary.activate(summary.getFocusOrder().filter((key) => key.startsWith("ev:"))[1] ?? "");
	const strip = chat.flow.stripFor(summary)!;
	strip.render(W);
	strip.activate(strip.getFocusOrder().find((key) => key.startsWith("strip:item:mem")) ?? "");
	return chat;
}

function runningReview(): LiveChat {
	const chat = new LiveChat({ spend: () => ({ cost: 4.2, parentCost: 5.6 }) });
	reviewSoFar(chat, { steps: 11, memory: false });
	report(chat, 0);
	vi.setSystemTime(at(18, 57));
	const running = command("t12", "npx vitest --run test/grow-bottom-tui.test.ts", { start: at(18, 57) });
	chat.say(
		at(18, 57),
		{
			thought: "正在查：那 4 个测试失败是不是颜色的问题。",
			calls: [{ id: running.id, code: running.code, details: runningRecord(running.details) }],
		},
		{ open: true },
	);
	vi.setSystemTime(at(18, 57, 12));
	const summary = chat.summaries()[0]!;
	summary.render(W);
	summary.activate(summary.getFocusOrder().filter((key) => key.startsWith("ev:"))[1] ?? "");
	return chat;
}

/** The kernel's record of a command that is still running: no end yet. */
function runningRecord(details: unknown): unknown {
	const [first] = (details as { activities: Array<Record<string, unknown>> }).activities;
	return { activities: [{ ...first, status: "running", endedAt: undefined }] };
}

/** The lines as the terminal shows them, one string per row, with the spinner frame fixed. */
function screen(chat: LiveChat): string[] {
	return plain(chat.lines(W)).map((line) => line.replace(/^( \d\d:\d\d {3})[⠀-⣿]/, "$1⠹"));
}

function expectRows(actual: readonly string[], expected: readonly string[]): void {
	expect(expected.length).toBeGreaterThan(0);
	const count = Math.max(actual.length, expected.length);
	for (let row = 0; row < count; row++) {
		expect(actual[row]?.replace(/\s+$/, ""), `row ${row}`).toBe(expected[row]?.replace(/\s+$/, ""));
		// A row of the design has exactly the trailing spaces its right side leaves.
		expect(actual[row], `row ${row}`).toBe(expected[row]);
	}
}

const DONE_ROWS = [
	drow("18:47", "●", "off", "你   对最近的改动做全面的审查 多个代理一起"),
	gap("off"),
	gap("off"),
	drow("18:47", "◆", "off", "先看最近的提交，定下审查范围。", "2 步 ▸"),
	drow("18:48", "◆", "off", "范围定了：16 个提交、96 个文件。派四个代理并行审查。"),
	drow("", "├", "split", "◇  A 钉住框头   B 框的折叠   C 子代理小块   D 测试和发版"),
	gap("on"),
	drow("18:50", "◆", "on", "趁它们干活，我自己跑检查和测试。", "24 步 ▴"),
	step("on", "$", "npx tsgo --noEmit", "✓ 21秒"),
	step("on", "$", "npx vitest --run test/grow-*.test.ts", "10 通过 · 4 失败  38秒"),
	step("on", "✗", "列目录 docs 出错：引号没闭合", "下一格改好了"),
	step("on", "⋯", "另外 21 步", "全部 ›"),
	drow("18:53", "◆", "on", "找到一个问题：256 色终端里四个底色撞成同一个颜色，那 4 个测试失败都是它。"),
	gap("on"),
	verdict("18:54", "B", "框的长高和折叠", "没问题（7 条小建议）"),
	verdict("19:00", "A", "钉住框头和滚动", "没问题（4 条小建议）"),
	verdict("19:03", "D", "测试和发版", "1 条必修，发版删了测试要读的文件"),
	verdict("19:05", "C", "子代理小块", "1 条要修，256 色撞色"),
	drow("", "├", "join", "四个都交回了"),
	gap("off"),
	gap("off"),
	drow("19:06", "◆", "off", "总结"),
	drow("", "┃", "off"),
	drow("", "┃", "off", "审查完成，四个代理并行、加上我自己的复核，都收口了。"),
	drow("", "┃", "off"),
	drow("", "┃", "off", "一句话结论"),
	drow(
		"",
		"┃",
		"off",
		"这批「框长高 + 子代理小块」的代码本身没问题；但 0.11.16 发版时把一个测试弄红了，远程检查现在是红的。",
	),
	drow("", "┃", "off"),
	drow("", "┃", "off", "要修的三件"),
	drow("", "┃", "off", "1. 改 grow-fix-copy 测试：发版删掉了它要读的说明文件，任何环境都会红"),
	drow("", "┃", "off", "2. 256 色终端里子代理和出错的底色撞成同一个颜色，要换颜色"),
	drow("", "┃", "off", "3. tui 覆盖率检查从 0.11.15 起就是红的（测试计数差 1），一起修"),
	gap("off"),
	gap("off"),
	drow("19:06", "✦", "off", "记住了   grow 批次审查结论（2026-09-29）", "▴"),
	...MEMORY.map((text) => drow("", "┃", "off", text)),
	gap("off"),
	drow("", "╵", "off", "✓ 用了 20 分钟 · 子代理 ¥4.20 · 全部 ¥9.80", "完整过程 ▸"),
];

describe("Tl2Done: the finished review, 160 columns", () => {
	it("draws every row of the design: the question, events, dispatch, returns, summary, memory and closing row", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const rows = screen(finishedReview());
		expectRows(rows, DONE_ROWS);
	});

	it("keeps every glyph in the design's column and color, whichever part drew the row", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const rows = plain(screen(finishedReview()));
		const raw = finishedReview().lines(W);
		expect(raw.length).toBe(rows.length);
		const fg = (token: ThemeColor) => theme.getFgAnsi(token);
		const main: Record<string, { token: ThemeColor; bold: boolean }> = {
			"│": { token: "timelineRail", bold: false },
			"●": { token: "timelineUser", bold: true },
			"◆": { token: "timelineAi", bold: true },
			"✦": { token: "timelineMemory", bold: true },
			"╵": { token: "timelineRail", bold: false },
			"├": { token: "timelineRail", bold: false },
		};
		let seen = 0;
		raw.forEach((line, index) => {
			const cells = styled(line);
			const glyph = cells[9];
			const plainRow = rows[index] ?? "";
			if (glyph && glyph.char === "┃") {
				// The summary's bar is the AI's color, the memory's bar the memory's.
				const memoryBar = MEMORY.some((text) => plainRow.includes(text));
				expect(glyph.fg, plainRow).toBe(fg(memoryBar ? "timelineMemory" : "timelineAi"));
				seen += 1;
			} else if (glyph && main[glyph.char]) {
				const want = main[glyph.char];
				expect(glyph.fg, plainRow).toBe(fg(want?.token ?? "text"));
				expect(glyph.bold, plainRow).toBe(want?.bold);
				seen += 1;
			}
			// The lane: dotted amber, the subagent's diamond bold orange, the split and join in the rail's color.
			const lane = cells
				.slice(10, 13)
				.map((cell) => cell.char)
				.join("");
			if (lane === "  ┆") {
				expect(cells[12]?.fg, plainRow).toBe(fg("timelineLane"));
				seen += 1;
			} else if (lane === "  ◇") {
				expect(cells[12]?.fg, plainRow).toBe(fg("timelineSub"));
				expect(cells[12]?.bold, plainRow).toBe(true);
				seen += 1;
			} else if (lane === "──╮" || lane === "──╯") {
				for (const cell of cells.slice(10, 13)) expect(cell.fg, plainRow).toBe(fg("timelineRail"));
				seen += 1;
			}
			// A stamp is the dim color.
			if (/^ \d\d:\d\d /.test(plainRow)) {
				for (const cell of cells.slice(1, 6)) expect(cell.fg, plainRow).toBe(fg("timelineTime"));
				seen += 1;
			}
		});
		expect(seen).toBeGreaterThan(60);
	});

	it("lights the lane on every row from the dispatch to the last return, and on none after", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const rows = screen(finishedReview());
		const split = rows.findIndex((row) => row.includes("├──╮"));
		const join = rows.findIndex((row) => row.includes("├──╯"));
		expect(split).toBeGreaterThan(0);
		expect(join).toBeGreaterThan(split);
		for (const row of rows.slice(split + 1, join)) expect(row.slice(10, 13), row).toMatch(/^ {2}[┆◇]$/);
		for (const row of rows.slice(join + 1)) expect(row.slice(10, 13), row).toBe("   ");
		for (const row of rows.slice(0, split)) expect(row.slice(10, 13), row).toBe("   ");
	});
});

describe("Tl2Live: the review, one subagent back, the AI at its checks", () => {
	it("draws the rows of the design in order, the return above the live tail", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const rows = screen(runningReview());
		const expected = [
			drow("18:47", "●", "off", "你   对最近的改动做全面的审查 多个代理一起"),
			gap("off"),
			gap("off"),
			drow("18:47", "◆", "off", "先看最近的提交，定下审查范围。", "2 步 ▸"),
			drow("18:48", "◆", "off", "范围定了：16 个提交、96 个文件。派四个代理并行审查。"),
			drow("", "├", "split", "◇  A 钉住框头   B 框的折叠   C 子代理小块   D 测试和发版"),
			gap("on"),
			// 11 commands, the running one and its thought
			drow("18:50", "◆", "on", "趁它们干活，我自己跑检查和测试。", "13 步 ▴"),
			step("on", "$", "npx tsgo --noEmit", "✓ 21秒"),
			step("on", "$", "npx vitest --run test/grow-*.test.ts", "10 通过 · 4 失败  38秒"),
			step("on", "✗", "列目录 docs 出错：引号没闭合", "出错了"),
			step("on", "⋯", "另外 10 步", "全部 ›"),
			gap("on"),
			verdict("18:54", "B", "框的长高和折叠", "没问题（7 条小建议）"),
			gap("on"),
			drow("18:57", "⠹", "on", "正在查：那 4 个测试失败是不是颜色的问题", "第 15 步"),
			drow("", "╎", "on", "     在跑  npx vitest --run test/grow-bottom-tui.test.ts", "12秒  "),
			drow("", "╎", "on"),
			drow("", " ", "on", "A、C、D 还在干活"),
		];
		expectRows(rows, expected);
	});
});

describe("the empty rows between blocks, counted", () => {
	/** A turn's command runs before its answer, as in a tool loop. */
	function withCommands(chat: LiveChat): LiveChat {
		chat.summaries().forEach((summary, index) => {
			const entries = summary.state.timeline.entries;
			const before = entries.length;
			const call = command(`w${index}`, `echo ${index}`, { start: at(18, 47, index) });
			summary.state.addStep({
				toolCallId: call.id,
				toolName: "ipython",
				args: { code: call.code },
				status: "queued",
			});
			summary.state.timeline.noteMessage(
				{
					role: "assistant",
					content: [{ type: "toolCall", id: call.id, name: "ipython", arguments: { code: call.code } }],
					api: "test-api",
					provider: "test-provider",
					model: "glm-5.3-prime",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: at(18, 47, index) - 1,
				},
				true,
			);
			summary.state.timeline.mergeStep(call.id, "ipython", { code: call.code }, { details: call.details }, false);
			summary.state.setStepStatus(call.id, "done");
			entries.unshift(...entries.splice(before));
		});
		return chat;
	}

	/** The rows with the clock words and the durations made the same, so rows compare by shape. */
	function shape(chat: LiveChat): string[] {
		return screen(chat).map((row) => row.replace(/^ \d\d:\d\d/, " HH:MM").replace(/用了 \d+ 秒/, "用了 N 秒"));
	}

	const row = (main: string, content = "", right = "") => drow("", main, "off", content, right);
	const stamped = (main: string, content = "", right = "") => drow("HH:MM", main, "off", content, right);

	it("puts two empty rows between the question and its summary when the turn has nothing to list", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.prompt("你好", { answer: "在的。" });
		vi.advanceTimersByTime(1000);
		expect(shape(chat)).toEqual([
			stamped("●", "你   你好"),
			row("│"),
			row("│"),
			stamped("◆", "总结"),
			row("┃"),
			row("┃", "在的。"),
			row("│"),
			row("╵", "✓ 用了 N 秒", "完整过程 ▸"),
		]);
	});

	it("puts two empty rows between the question and the events, and two before the summary, as Tl2Done has them", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.prompt("跑一下", { answer: "跑完了。" });
		withCommands(chat);
		vi.advanceTimersByTime(1000);
		expect(shape(chat)).toEqual([
			stamped("●", "你   跑一下"),
			row("│"),
			row("│"),
			stamped("◆", "跑了 1 条命令", "1 步 ▸"),
			row("│"),
			row("│"),
			stamped("◆", "总结"),
			row("┃"),
			row("┃", "跑完了。"),
			row("│"),
			row("╵", "✓ 用了 N 秒", "完整过程 ▸"),
		]);
	});

	it("puts one empty row between a return and the woken turn's first event, and never three in a row", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.prompt("审查", { answer: "派出去了。" });
		chat.wake("m1", { name: "B", answer: "B 回来了，没问题。" });
		withCommands(chat);
		vi.advanceTimersByTime(1000);
		const rows = shape(chat);
		expect(rows).toEqual([
			stamped("●", "你   审查"),
			row("│"),
			row("│"),
			stamped("◆", "跑了 1 条命令", "1 步 ▸"),
			row("│"),
			row("│"),
			stamped("◆", "总结"),
			row("┃"),
			row("┃", "派出去了。"),
			// The summary's own row, and the one the return keeps above itself.
			row("│"),
			row("│"),
			drow("HH:MM", "│", "sub", "B 交回   审查完毕", "›"),
			// The woken turn's lines open with one empty row.
			row("│"),
			stamped("◆", "跑了 1 条命令", "1 步 ▸"),
			row("│"),
			row("│"),
			stamped("◆", "总结"),
			row("┃"),
			row("┃", "B 回来了，没问题。"),
			row("│"),
			row("╵", "✓ 用了 N 秒", "完整过程 ▸"),
		]);
		let run = 0;
		let longest = 0;
		for (const line of rows) {
			run = /^ {9}│[ ┆]*$/.test(line) ? run + 1 : 0;
			longest = Math.max(longest, run);
		}
		expect(longest).toBe(2);
		chat.flow.dispose();
	});

	it("keeps two empty rows above a return that opens a turn, not three", () => {
		setMotionReduced(true);
		const turn = quietTurn({ live: false });
		turn.summary.setLeadingRows(2);
		// A report that landed before the turn drew a line of its own: the row is the first thing the turn draws.
		turn.summary.addInlineRow(
			{ render: () => ["         │      ", " 18:55   │  ◇   B 交回   审查完毕"], invalidate: () => {} },
			at(18, 55),
		);
		turn.state.markTurnEnded(at(18, 56));
		const lines = plain(turn.summary.render(W));
		expect(lines.map((line) => line.trimEnd())).toEqual([
			"         │",
			"         │",
			" 18:55   │  ◇   B 交回   审查完毕",
		]);
	});
});

describe("the subagent lane closes when the last one is back", () => {
	function dispatchFour(chat: LiveChat): void {
		vi.setSystemTime(at(18, 47));
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "派四个代理并行审查。",
			calls: [subagentCell("spawn", ["A", "B", "C", "D"], at(18, 48))],
		});
		for (const name of ["A", "B", "C", "D"]) chat.child(snapshot(name));
		chat.say(at(18, 49), {
			words: "趁它们干活，我自己看看。",
			calls: [command("k1", "git status", { start: at(18, 49) })],
		});
	}

	it("draws `├──╯   四个都交回了` after the fourth return, and every row after it off the lane", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		dispatchFour(chat);
		const order = ["B", "A", "D", "C"];
		order.forEach((name, index) => {
			vi.setSystemTime(at(19, index));
			chat.child(snapshot(name, "done"));
			chat.report(
				handedBack(`r${index}`, at(19, index), name, `车道${name}（任务${name}）审查完成。\n结论：没问题。`),
			);
			const rows = screen(chat);
			const joins = rows.filter((row) => row.includes("├──╯"));
			if (index < order.length - 1) {
				expect(joins, `after ${name}`).toHaveLength(0);
				expect(chat.flow.subagentLane.tracker.pending).toHaveLength(order.length - 1 - index);
			} else {
				expect(joins.map((row) => row.trimEnd())).toEqual(["         ├──╯   四个都交回了"]);
				expect(chat.flow.subagentLane.tracker.active).toBe(false);
			}
		});
		vi.setSystemTime(at(19, 10));
		chat.say(at(19, 10), { words: "都看完了，没有问题。" });
		chat.endRun();
		vi.advanceTimersByTime(1000);
		const rows = screen(chat);
		const join = rows.findIndex((row) => row.includes("├──╯"));
		expect(join).toBeGreaterThan(0);
		for (const row of rows.slice(join + 1)) expect(row.slice(10, 13), row).toBe("   ");
		const summary = rows.findIndex((row) => row.endsWith("总结"));
		expect(summary).toBeGreaterThan(join);
	});

	it("releases a subagent that has no session name by its active session id, on both sides", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "派一个代理。",
			calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: {} }],
		});
		const { sessionName: _named, ...unnamed } = snapshot("X");
		chat.child({ ...unnamed, label: "X" });
		expect(chat.flow.subagentLane.tracker.pending).toEqual(["X-active"]);
		chat.report(
			createAgentSessionMessage(
				{
					id: "u1",
					source: AGENT_MESSAGE_SOURCE,
					message: "审查完成。\n结论：没问题。",
					from: { sessionId: "x-session", activeSessionId: "X-active" },
					fromRelationship: "child",
					target: { activeSessionId: "main-active", sessionId: "main" },
				},
				at(18, 55),
			),
		);
		expect(chat.flow.subagentLane.tracker.active).toBe(false);
		expect(screen(chat).some((row) => row.includes("├──╯"))).toBe(true);
	});
});

describe("a return sits among the turn's lines by its time", () => {
	it("draws an event that started after the return below it, and one that started before it above it", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), {
			words: "派两个代理。",
			calls: [subagentCell("spawn", ["A", "B"], at(18, 48))],
		});
		for (const name of ["A", "B"]) chat.child(snapshot(name));
		chat.say(at(18, 50), { words: "我先跑测试。", calls: [command("k1", "npm test", { start: at(18, 50) })] });
		report(chat, 0);
		chat.say(at(18, 57), {
			words: "B 回来了，我接着查颜色。",
			calls: [command("k2", "npm run lint", { start: at(18, 57) })],
		});
		const rows = screen(chat);
		const before = rows.findIndex((row) => row.includes("我先跑测试。"));
		const back = rows.findIndex((row) => row.includes("B 交回"));
		const after = rows.findIndex((row) => row.includes("B 回来了，我接着查颜色。"));
		expect(before).toBeGreaterThan(0);
		expect(back).toBeGreaterThan(before);
		expect(after).toBeGreaterThan(back);
	});
});

describe("the dispatch row names the task", () => {
	it("gives each subagent its short task tag, and none when the child has no name of its own", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), { words: "派两个。", calls: [{ id: "spawn", code: "await rlm.spawn(...)", details: {} }] });
		chat.child(snapshot("A"));
		const { sessionName: _named, ...unnamed } = snapshot("B");
		chat.child({ ...unnamed, label: "B" });
		const row = screen(chat).find((line) => line.includes("├──╮")) ?? "";
		expect(row.trimEnd()).toBe("         ├──╮   ◇  A 钉住框头   B");
	});
});

describe("an answer is drawn once", () => {
	const count = (rows: readonly string[], needle: string) => rows.filter((row) => row.includes(needle)).length;

	it("draws a plain reply a later step of the same turn took over as an event line, not also as a summary", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("看一下");
		chat.say(at(18, 48), { words: "先答一句：目录里有三个文件。" });
		chat.say(at(18, 49), {
			words: "再确认一下。",
			calls: [command("k1", "ls", { start: at(18, 49), detail: "3 个文件" })],
		});
		chat.say(at(18, 50), { words: "确认过了，三个文件。" });
		chat.endRun();
		vi.advanceTimersByTime(1000);
		const rows = screen(chat);
		expect(count(rows, "先答一句：目录里有三个文件。")).toBe(1);
		const early = rows.find((row) => row.includes("先答一句")) ?? "";
		expect(early).toMatch(/^ 18:48 {3}◆ {6}先答一句/);
		expect(count(rows, "确认过了，三个文件。")).toBe(1);
		const last = rows.find((row) => row.includes("确认过了")) ?? "";
		expect(last.startsWith("         ┃")).toBe(true);
	});

	it("draws the answer a turn ended on as its summary once when a report then wakes the AI", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		chat.setClock(at(18, 47));
		chat.user("审查");
		chat.say(at(18, 48), { words: "派出去了，等它们交回。" });
		chat.endRun();
		vi.advanceTimersByTime(1000);
		chat.setClock(at(19, 0));
		chat.wake("w1", { name: "B", answer: "B 回来了，没问题。" });
		vi.advanceTimersByTime(1000);
		const rows = screen(chat);
		expect(count(rows, "派出去了，等它们交回。")).toBe(1);
		const first = rows.find((row) => row.includes("派出去了")) ?? "";
		expect(first.startsWith("         ┃")).toBe(true);
		expect(count(rows, "B 回来了，没问题。")).toBe(1);
	});
});

describe("an opened memory step keeps its whole text", () => {
	it("wraps a long memory under its step and cuts none of it", () => {
		setMotionReduced(true);
		vi.useFakeTimers();
		vi.setSystemTime(at(18, 47));
		const chat = new LiveChat();
		const text = `${MEMORY.join("，")}。${"再说一遍这条结论的每一个细节。".repeat(6)}`;
		chat.setClock(at(18, 47));
		chat.user("记一下");
		const call = command("m1", "echo mem", { start: at(18, 48) });
		(call.details as { memoryChanges?: unknown[] }).memoryChanges = [
			{ op: "created", kind: "memory", scope: "session", title: "长结论 记忆", after: text, at: at(18, 48) },
		];
		chat.say(at(18, 48), { words: "记下来。", calls: [call] });
		chat.endRun();
		vi.advanceTimersByTime(1000);
		const summary = chat.summaries()[0]!;
		summary.render(60);
		const keys = summary.getFocusOrder();
		summary.activate(keys.find((key) => key.startsWith("ev:")) ?? "");
		summary.render(60);
		summary.activate(summary.getFocusOrder().find((key) => key.startsWith("mem:")) ?? "");
		const opened = plain(summary.render(60)).join("");
		const squeeze = (value: string) => value.replace(/[\s│┆]/g, "");
		expect(squeeze(opened)).toContain(squeeze(text));
	});
});

interface StyledCell {
	char: string;
	fg: string | undefined;
	bold: boolean;
}

/** The styled characters of a rendered row, from its escape sequences. */
function styled(line: string): StyledCell[] {
	const out: StyledCell[] = [];
	let fg: string | undefined;
	let bold = false;
	for (let index = 0; index < line.length; ) {
		const sgr = /^\x1b\[([0-9;]*)m/.exec(line.slice(index));
		if (sgr) {
			const code = sgr[1] ?? "";
			if (code.startsWith("38;")) fg = sgr[0];
			else if (code === "39") fg = undefined;
			else if (code === "1") bold = true;
			else if (code === "22") bold = false;
			else if (code === "0") {
				fg = undefined;
				bold = false;
			}
			index += sgr[0].length;
			continue;
		}
		const marker = /^\x1b[\]_][^\x07]*\x07/.exec(line.slice(index));
		if (marker) {
			index += marker[0].length;
			continue;
		}
		const char = String.fromCodePoint(line.codePointAt(index) ?? 32);
		out.push({ char, fg, bold });
		index += char.length;
	}
	return out;
}
