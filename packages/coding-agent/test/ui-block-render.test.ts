import { type ClickRegion, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { type ThemeBg, type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";
import {
	addActivities,
	addCommand,
	addSay,
	addStep,
	addThought,
	assistant,
	hasBg,
	hasFg,
	plain,
	type QuietTurn,
	quietTurn,
	useTruecolorTheme,
} from "./ui-blocks-helpers.js";

let restoreTheme: () => void;

beforeAll(() => {
	restoreTheme = useTruecolorTheme();
	setKeybindings(new KeybindingsManager());
});

afterAll(() => {
	restoreTheme();
});

const WIDTH = 100;
const CMD_KEY = "act:c1:c1-a";
/** The rail of a step's line: column 9, then the lane and the gap up to the step's own indent. */
const STEP_RAIL = /^ {9}│ {11}/;
/** Any background color escape. */
const ANY_BG = "\x1b[48;";

function regionsOn(turn: QuietTurn, line: number): ClickRegion[] {
	return turn.summary.getClickRegions().filter((region) => region.line === line);
}

/** Display width of a plain line (wide characters count two columns). */
function widthOf(line: string): number {
	let cols = 0;
	for (const ch of line) cols += /[ᄀ-ᅟ⺀-鿿가-힣＀-｠]/.test(ch) ? 2 : 1;
	return cols;
}

/** The column a string starts at in a plain line. */
function cell(line: string, needle: string): number {
	const at = line.indexOf(needle);
	expect(at).toBeGreaterThanOrEqual(0);
	return widthOf(line.slice(0, at));
}

/** Index of the first line after the first whose plain text contains `needle`, or -1. */
function lineOf(lines: readonly string[], needle: string): number {
	return plain(lines).findIndex((line, index) => index > 0 && line.includes(needle));
}

/** Opens every event that lists steps, the way Ctrl+O does. */
function openAll(turn: QuietTurn): string[] {
	turn.summary.toggleBox();
	return turn.summary.render(WIDTH);
}

/** A turn with one step of a kind, and where the timeline draws it. */
interface KindCase {
	name: string;
	needle: string;
	/** The block color the old box gave the kind: nothing paints it any more. */
	bg: ThemeBg;
	/** The character a step or dispatch line starts its content with; absent for a spinner. */
	glyph?: string;
	glyphColor: ThemeColor;
	/** The rail column: `│` under an event, `├` on a dispatch line. */
	rail: string;
	/** The step's result on the right, in its color. */
	status?: { text: string; color: ThemeColor };
	build: (turn: QuietTurn) => void;
}

const KIND_CASES: KindCase[] = [
	{
		name: "a thought",
		needle: "先看日志",
		bg: "kindThinkBg",
		glyph: "∴",
		glyphColor: "kindThink",
		rail: "│",
		build: (turn) => addThought(turn, "先看日志。再看代码，还有很多话要说。"),
	},
	{
		name: "a command",
		needle: "$  git status",
		bg: "kindCommandBg",
		glyph: "$",
		glyphColor: "kindCommand",
		rail: "│",
		build: (turn) => addCommand(turn, "c1", "git status"),
	},
	{
		name: "a file read",
		needle: "读取 README.md",
		bg: "kindReadBg",
		glyph: "✓",
		glyphColor: "kindRead",
		rail: "│",
		build: (turn) =>
			addActivities(turn, "r1", [{ id: "a", kind: "read", label: "README.md", status: "ok", startedAt: 1 }]),
	},
	{
		name: "a general step",
		needle: "搜索 foo bar",
		bg: "kindReadBg",
		glyph: "✓",
		glyphColor: "kindRead",
		rail: "│",
		status: { text: "✓ 3 条", color: "timelineFaint" },
		build: (turn) =>
			addActivities(turn, "s1", [
				{ id: "a", kind: "search", label: "foo bar", status: "ok", startedAt: 1, detail: "3 条" },
			]),
	},
	{
		name: "a changed file",
		needle: "a.go",
		bg: "kindEditBg",
		glyph: "✎",
		glyphColor: "kindEdit",
		rail: "│",
		build: (turn) =>
			addActivities(turn, "e1", [], {
				fileChanges: [
					{
						path: "/work/app/a.go",
						relPath: "a.go",
						kind: "modified",
						scope: "project",
						added: 1,
						removed: 1,
						source: "edit",
						at: 1,
					},
				],
			}),
	},
	{
		name: "a memory",
		needle: "记住：go",
		bg: "kindMemoryBg",
		glyph: "✦",
		glyphColor: "kindMemory",
		rail: "│",
		build: (turn) =>
			addActivities(turn, "m1", [], {
				memoryChanges: [
					{
						op: "created",
						kind: "memory",
						scope: "session",
						title: "go_http_请求要带_context",
						after: "带上 context。",
						at: 3,
					},
				],
			}),
	},
	{
		name: "a subagent",
		needle: "◇  审查员·Go",
		bg: "kindSubagentBg",
		glyph: "◇",
		glyphColor: "timelineSub",
		rail: "├",
		build: (turn) =>
			turn.timeline.upsertSubagent({ childId: "c1", name: "审查员·Go", status: "done", result: "发现 1 处问题" }),
	},
	{
		name: "a failed command",
		needle: "$  make build",
		bg: "kindErrorBg",
		glyph: "$",
		glyphColor: "kindCommand",
		rail: "│",
		status: { text: "退出码 2", color: "timelineMust" },
		build: (turn) => addCommand(turn, "c1", "make build", { ok: false, detail: "exit code 2" }),
	},
	{
		name: "a cell that raised",
		needle: "出错：FileNotFoundError",
		bg: "kindErrorBg",
		glyph: "✗",
		glyphColor: "timelineMust",
		rail: "│",
		status: { text: "出错了", color: "timelineMust" },
		build: (turn) => {
			const code = "print(open('config.toml').read())";
			addStep(turn, "x1", code);
			turn.timeline.mergeStep(
				"x1",
				"ipython",
				{ code },
				{
					content: [{ type: "text", text: "FileNotFoundError: [Errno 2] No such file: 'config.toml'" }],
					details: {
						status: "error",
						error: { ename: "FileNotFoundError", evalue: "no such file", traceback: [] },
					},
					isError: false,
				},
				false,
			);
		},
	},
	{
		name: "a retry in progress",
		needle: "模型接口超时",
		bg: "customMessageBg",
		glyphColor: "timelineLive",
		rail: "│",
		build: (turn) => {
			turn.timeline.startRetry({ startedAt: Date.now(), delayMs: 3_000, attempt: 1, reason: "模型接口超时" });
		},
	},
	{
		name: "a retry that worked",
		needle: "模型接口超时，已自动重试",
		bg: "customMessageBg",
		glyph: "↻",
		glyphColor: "kindRecovered",
		rail: "│",
		build: (turn) => {
			turn.timeline.startRetry({
				startedAt: Date.now() - 4_000,
				delayMs: 3_000,
				attempt: 1,
				reason: "模型接口超时",
			});
			turn.timeline.endRetry("ok");
		},
	},
	{
		name: "a compaction",
		needle: "整理完成",
		bg: "customMessageBg",
		glyph: "⇣",
		glyphColor: "timelineFaint",
		rail: "│",
		build: (turn) => {
			turn.timeline.startCompaction(Date.now() - 2_000, 182_000);
			turn.timeline.endCompaction(Date.now(), { before: 182_000 });
		},
	},
	{
		name: "a notice",
		needle: "做完了，没发回消息",
		bg: "customMessageBg",
		glyph: "◇",
		glyphColor: "timelineFaint",
		rail: "│",
		build: (turn) => {
			turn.timeline.addNotice({ tone: "muted", text: "子代理 审查员 做完了，没发回消息" }, Date.now());
		},
	},
];

describe("every step is a line in its kind's color", () => {
	it("gives each kind its own glyph color and draws no background, frame or separator row", () => {
		expect(KIND_CASES.length).toBeGreaterThan(0);
		for (const testCase of KIND_CASES) {
			const turn = quietTurn();
			testCase.build(turn);
			const lines = openAll(turn);
			const shown = plain(lines);
			const at = lineOf(lines, testCase.needle);
			expect(at, `${testCase.name} is drawn`).toBeGreaterThan(0);
			const line = lines[at] ?? "";
			expect(shown[at]?.startsWith(`         ${testCase.rail}`), `${testCase.name} sits on the rail`).toBe(true);
			if (testCase.glyph) {
				expect(line, `${testCase.name} glyph color`).toContain(
					theme.bold(theme.fg(testCase.glyphColor, testCase.glyph)),
				);
			} else {
				expect(hasFg(line, testCase.glyphColor), `${testCase.name} glyph color`).toBe(true);
			}
			if (testCase.status) {
				expect(line, `${testCase.name} result color`).toContain(
					theme.fg(testCase.status.color, testCase.status.text),
				);
			}
			expect(hasBg(line, testCase.bg), `${testCase.name} has no block color`).toBe(false);
			expect(line.includes(ANY_BG), `${testCase.name} has no background at all`).toBe(false);
			expect(shown.join("\n"), `${testCase.name} draws no frame or separator row`).not.toMatch(/[▀▎╭╮╰╯]/);
		}
	});

	it("puts a step's glyph at column 21 and its result at the right edge", () => {
		const turn = quietTurn();
		addCommand(turn, "c1", "git log --stat -100", { detail: "100 次提交", output: "abc123 fix" });
		const lines = openAll(turn);
		const at = lineOf(lines, "$  git log --stat -100");
		const shown = plain(lines)[at] ?? "";
		expect(shown).toMatch(/^ {9}│ {11}\$ {2}git log --stat -100 +✓ 100 次提交 {4}$/);
		expect(widthOf(shown)).toBe(WIDTH);
		expect(cell(shown, "$")).toBe(21);
		expect(lines[at]).toContain(theme.bold(theme.fg("kindCommand", "$")));
	});

	it("draws the open arrow in the AI's color and the closed one faint", () => {
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean" });
		const closed = turn.summary.render(WIDTH)[0] ?? "";
		expect(plain([closed])[0]).toMatch(/1 步 ▸ {2}$/);
		expect(closed).toContain(theme.bold(theme.fg("timelineFaint", "▸")));
		const opened = openAll(turn)[0] ?? "";
		expect(plain([opened])[0]).toMatch(/1 步 ▴ {2}$/);
		expect(opened).toContain(theme.bold(theme.fg("timelineAi", "▴")));
		expect(opened).not.toContain(theme.bold(theme.fg("timelineFaint", "▴")));
	});

	it("keeps a running step's spinner in the live color, with its elapsed time on the right", () => {
		const turn = quietTurn();
		addStep(turn, "c1", "r = await bash('npm test')", "running");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{
				details: {
					activities: [
						{ id: "a", kind: "command", label: "npm test", status: "running", startedAt: Date.now() - 2_000 },
					],
				},
			},
			true,
		);
		const lines = openAll(turn);
		const at = lineOf(lines, "npm test");
		expect(plain(lines)[at]).toMatch(/^ {9}│ {11}[⠀-⣿] {2}npm test +\d+秒 {4}$/);
		expect(hasFg(lines[at] ?? "", "timelineLive")).toBe(true);
		expect(hasFg(lines[at] ?? "", "kindCommand")).toBe(false);
		expect(hasBg(lines[at] ?? "", "kindCommandBg")).toBe(false);
		// The command that runs now is also the live tail's own line.
		const tail = plain(lines).find((line) => line.includes("在跑")) ?? "";
		expect(tail.startsWith("         ╎")).toBe(true);
		expect(cell(tail, "在跑")).toBe(21);
		expect(tail).toContain("在跑  npm test");
	});

	it("makes a click area of a step with no lines of its own, and of nothing around it", () => {
		const turn = quietTurn();
		addActivities(turn, "r1", [{ id: "a", kind: "read", label: "README.md", status: "ok", startedAt: 1 }]);
		const lines = openAll(turn);
		const at = lineOf(lines, "读取 README.md");
		expect(hasBg(lines[at] ?? "", "kindReadBg")).toBe(false);
		expect(plain(lines)[at]).not.toMatch(/[▸▾]/);
		const region = regionsOn(turn, at);
		expect(region).toHaveLength(1);
		expect(region[0]?.width).toBe(WIDTH);
		expect(region[0]?.height).toBe(1);
		region[0]?.onClick({ row: 0, col: 0 });
		const opened = plain(turn.summary.render(WIDTH));
		expect(opened[at + 1]).toMatch(/^ {9}│ {14}读取 README\.md$/);
		// No separator row belongs to the step: the line under it is not a click area.
		expect(regionsOn(turn, at + 1)).toHaveLength(0);
		expect(regionsOn(turn, at + 2)).toHaveLength(0);
	});
});

describe("what hangs under a step", () => {
	it("shows an opened step's lines indented under it, on no color and with no bar or separator", () => {
		const turn = quietTurn();
		addCommand(turn, "c1", "git log --stat -100", { output: "first line\nsecond line" });
		openAll(turn);
		turn.summary.activate(CMD_KEY);
		const lines = turn.summary.render(WIDTH);
		const shown = plain(lines);
		const at = lineOf(lines, "$  git log --stat -100");
		expect(shown[at]).toMatch(STEP_RAIL);
		for (const [offset, expected] of ["first line", "second line"].entries()) {
			const detail = shown[at + 1 + offset] ?? "";
			// Eight columns further in than the step's own glyph: the rail at 9, the glyph at 21, the lines at 24.
			expect(detail).toMatch(new RegExp(`^ {9}│ {14}${expected}$`));
			expect(cell(detail, expected)).toBe(24);
			expect(lines[at + 1 + offset]?.includes(ANY_BG)).toBe(false);
			expect(shown[at + 1 + offset]).not.toContain("▎");
			expect(regionsOn(turn, at + 1 + offset)).toHaveLength(0);
		}
		expect(hasBg(lines[at] ?? "", "kindCommandHoverBg")).toBe(false);
		expect(shown[at + 3]?.trimEnd()).toBe("         │");
		expect(shown.join("\n")).not.toContain("▀");
		expect(regionsOn(turn, at)).toHaveLength(1);
	});

	it("opens a step when its own line is clicked and closes it on the next click", () => {
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean" });
		const lines = openAll(turn);
		const at = lineOf(lines, "$  git status");
		const head = regionsOn(turn, at);
		expect(head).toHaveLength(1);
		// The row under the step is no part of its click area.
		expect(regionsOn(turn, at + 1)).toHaveLength(0);
		head[0]?.onClick({ row: 0, col: 0 });
		expect(turn.timeline.ui.expanded.has(CMD_KEY)).toBe(true);
		expect(plain(turn.summary.render(WIDTH))[at + 1]).toMatch(/^ {9}│ {14}clean$/);
		regionsOn(turn, at)[0]?.onClick({ row: 0, col: 0 });
		expect(turn.timeline.ui.expanded.has(CMD_KEY)).toBe(false);
		expect(plain(turn.summary.render(WIDTH)).join("\n")).not.toContain("clean");
	});

	it("draws a diff line's own tint to the end of its text and puts no panel color behind it", () => {
		const turn = quietTurn();
		addActivities(turn, "e1", [], {
			fileChanges: [
				{
					path: "/work/app/a.go",
					relPath: "a.go",
					kind: "modified",
					scope: "project",
					added: 1,
					removed: 1,
					source: "edit",
					at: 1,
					diff: "--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,2 @@\n-old()\n+new()\n keep()\n",
				},
			],
		});
		openAll(turn);
		const key = turn.summary.getFocusOrder().find((entry) => entry.startsWith("file:"));
		expect(key).toBeDefined();
		turn.summary.activate(key ?? "");
		const lines = turn.summary.render(WIDTH);
		const added = lines.find((line) => plain([line])[0]?.includes("new()")) ?? "";
		expect(added).toBeTruthy();
		expect(plain([added])[0]).toMatch(/^ {9}│ {14} *\d+ \+ new\(\) $/);
		const tint = theme.getBgAnsi("diffAddedLineBg");
		expect(added).toContain(tint);
		// The tint is closed after its segment, so it never runs on to the panel or the edge.
		expect(added.indexOf("\x1b[49m", added.indexOf(tint))).toBeGreaterThan(added.indexOf(tint));
		expect(added).not.toContain(theme.getBgAnsi("kindPanelBg"));
	});

	it("shows a running command on its step line and the tail's `在跑` line, not its latest output", () => {
		const turn = quietTurn();
		addStep(turn, "c1", "r = await bash('go test')", "running");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{
				details: {
					activities: [
						{
							id: "a",
							kind: "command",
							label: "go test",
							status: "running",
							detail: "=== RUN TestRetry",
							startedAt: Date.now() - 2_000,
						},
					],
				},
			},
			true,
		);
		openAll(turn);
		turn.summary.activate("act:c1:a");
		const shown = plain(turn.summary.render(WIDTH));
		const at = shown.findIndex((line, index) => index > 0 && line.includes("go test"));
		expect(shown[at]).toMatch(/^ {9}│ {11}[⠀-⣿] {2}go test +\d+秒 {4}$/);
		expect(shown.some((line) => /^ {9}╎ {11}在跑 {2}go test +\d+秒 {4}$/.test(line))).toBe(true);
		// What an opened step says about a run in progress is its command and how long it has run.
		expect(shown[at + 1]).toMatch(/^ {9}│ {14}go test$/);
		expect(shown[at + 2]).toMatch(/^ {9}│ {14}时间 {2}\d\d:\d\d:\d\d · 已跑 \d+秒$/);
		expect(shown.join("\n")).not.toContain("=== RUN TestRetry");
		expect(shown.join("\n")).not.toContain("└");
	});

	it("puts the live thought's first sentence on the spinner line, with no three-line window", () => {
		const turn = quietTurn();
		turn.timeline.noteMessage(assistant(Date.now(), [{ type: "thinking", thinking: "先看测试为什么挂。" }]), false);
		const lines = turn.summary.render(WIDTH);
		const shown = plain(lines);
		const spin = shown.findIndex((line) => /^ \d\d:\d\d {3}[⠀-⣿] {6}先看测试为什么挂/.test(line));
		expect(spin).toBeGreaterThan(0);
		expect(cell(shown[spin] ?? "", "先看测试为什么挂")).toBe(16);
		expect(shown[spin]).toMatch(/第 1 步 {2}$/);
		expect(shown[spin + 1]).toMatch(/^ {9}╎ {11}思考中…$/);
		expect(shown.join("\n")).not.toContain("▎");
		for (const line of [spin, spin + 1]) expect(regionsOn(turn, line)).toHaveLength(0);
	});
});

describe("a short note is the event's own line", () => {
	const NOTE = "趁等待，查一个风险点。";

	it("shows a short note whole on the event line at column 16, with its step behind `N 步`", () => {
		const turn = quietTurn();
		addSay(turn, NOTE, "s1");
		const lines = turn.summary.render(WIDTH);
		const shown = plain(lines);
		expect(shown[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}趁等待，查一个风险点。 +1 步 ▸ {2}$/);
		expect(cell(shown[0] ?? "", "◆")).toBe(9);
		expect(cell(shown[0] ?? "", NOTE)).toBe(16);
		expect(lines[0]).toContain(theme.fg("text", NOTE));
		expect(lines[0]?.includes(ANY_BG)).toBe(false);
		expect(shown.filter((line) => line.includes(NOTE))).toHaveLength(1);
		// The line is what opens the step behind it.
		expect(regionsOn(turn, 0)).toHaveLength(1);
		expect(shown.join("\n")).not.toContain("$  true");
		regionsOn(turn, 0)[0]?.onClick({ row: 0, col: 0 });
		const opened = plain(turn.summary.render(WIDTH));
		expect(opened[0]).toMatch(/1 步 ▴ {2}$/);
		expect(opened[1]).toMatch(/^ {9}│ {11}\$ {2}true/);
	});

	it("keeps a note that is wider than the line on that one line and cuts it with an ellipsis", () => {
		const turn = quietTurn();
		const words = "一二三四五六七八九十".repeat(6);
		addSay(turn, words, "s1");
		const shown = plain(turn.summary.render(60));
		const noteLines = shown.filter((line) => line.includes("一二三四"));
		expect(noteLines).toHaveLength(1);
		expect(noteLines[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}一二三四五六七八九十一二三四五六… +1 步 ▸ {2}$/);
		expect(widthOf(noteLines[0] ?? "")).toBe(60);
		expect(shown.join("").replace(/[^一-鿿]/g, "")).not.toContain(words);
	});

	it("shows the first paragraph of a longer note and opens to the whole text", () => {
		const turn = quietTurn();
		const first = "先说第一句。";
		const rest = "后面还有很多很多话，".repeat(12);
		addSay(turn, `${first}\n\n${rest}`, "s1");
		const closed = turn.summary.render(60);
		expect(plain(closed)[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}先说第一句。 +1 步 ▸ {2}$/);
		expect(plain(closed).join("\n")).not.toContain("后面还有很多很多话");
		const region = regionsOn(turn, 0);
		expect(region).toHaveLength(1);
		expect(closed[0]?.includes(ANY_BG)).toBe(false);
		region[0]?.onClick({ row: 0, col: 0 });
		const openedLines = plain(turn.summary.render(60));
		expect(openedLines[0]).toMatch(/1 步 ▴ {2}$/);
		const text = openedLines
			.filter((line) => /^ {9}│ {6}\S/.test(line))
			.map((line) => line.replace(/^ {9}│ {6}/, ""))
			.join("");
		expect(text).toBe(`${first}${rest}`);
		expect(openedLines.join("\n")).not.toContain("▎");
	});

	it("shows a short interjection as one `你插话` line, with nothing to click", () => {
		const turn = quietTurn();
		turn.timeline.addSteer("先别动安卓的，只升级 Go", Date.now());
		const short = turn.summary.render(WIDTH);
		const shortShown = plain(short);
		expect(shortShown[0]).toMatch(/^ \d\d:\d\d {3}● {6}你插话 {3}先别动安卓的，只升级 Go$/);
		expect(cell(shortShown[0] ?? "", "●")).toBe(9);
		expect(cell(shortShown[0] ?? "", "你插话")).toBe(16);
		expect(short[0]).toContain(theme.bold(theme.fg("timelineUser", "你插话")));
		expect(shortShown[0]).not.toContain("▸");
		expect(regionsOn(turn, 0)).toHaveLength(0);
		expect(turn.summary.getFocusOrder()).toHaveLength(0);
	});

	/**
	 * R5-M17: an interjection the row cut used to be cut for good - no arrow, no click area and no
	 * key to walk to, so what the owner had typed past the first screenful was unreachable.
	 */
	it("opens a long interjection to the whole of what the owner typed", () => {
		const words = "这一条插话很长，".repeat(14);
		const turn = quietTurn();
		turn.timeline.addSteer(words, Date.now());
		const closed = turn.summary.render(60);
		const closedShown = plain(closed);
		expect(closedShown[0]).toMatch(/^ \d\d:\d\d {3}● {6}你插话 {3}这一条插话很长.*… +▸ {2}$/);
		expect(widthOf(closedShown[0] ?? "")).toBeLessThanOrEqual(60);
		expect(closed[0]?.includes(ANY_BG)).toBe(false);
		expect(closedShown.join("\n")).not.toContain(words);
		expect(regionsOn(turn, 0)).toHaveLength(1);
		const order = turn.summary.getFocusOrder();
		expect(order).toHaveLength(1);
		expect(order[0]?.startsWith("ev:steer:")).toBe(true);

		regionsOn(turn, 0)[0]?.onClick({ row: 0, col: 0 });
		const opened = plain(turn.summary.render(60));
		expect(opened[0]).toMatch(/▴ {2}$/);
		const whole = opened
			.filter((line) => /^ {9}│ {6}\S/.test(line))
			.map((line) => line.replace(/^ {9}│ {6}/, ""))
			.join("");
		expect(whole).toBe(words);
	});

	it("walks events and their steps with the keyboard, never a note or an interjection on its own", () => {
		const turn = quietTurn();
		addSay(turn, NOTE, "s1");
		addCommand(turn, "c1", "git status", { output: "clean" });
		turn.timeline.addSteer("先别动安卓的，只升级 Go", Date.now());
		turn.summary.render(WIDTH);
		const closed = turn.summary.getFocusOrder();
		expect(closed).toHaveLength(1);
		expect(closed[0]?.startsWith("ev:")).toBe(true);
		openAll(turn);
		const order = turn.summary.getFocusOrder();
		expect(order.some((key) => key.startsWith("say:") || key.startsWith("steer:"))).toBe(false);
		expect(order[0]).toBe(closed[0]);
		expect(order).toContain(CMD_KEY);
	});
});
