import { type ClickRegion, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import {
	addActivities,
	addCommand,
	addSay,
	addThought,
	host,
	lineIndexWith,
	plain,
	type QuietTurn,
	quietTurn,
	T0,
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

afterEach(() => {
	setMotionReduced(false);
});

const WIDTH = 60;
const LONG_PATH = "packages/coding-agent/src/modes/interactive/components/very-long-directory-name/some-file.md";
const LONG_COMMAND = "grep -rn --include=*.ts onAction packages/coding-agent/src/modes/interactive | wc -l";
const LONG_QUERY = "how does the timeline decide which rows are persistent when the turn folds up";

/** A step the box draws as a block that has no lines of its own to open. */
interface FactsCase {
	name: string;
	/** What the block's own row starts with (still readable at 60 columns). */
	needle: string;
	/** The whole text of the step: cut off in the row, whole in the opened panel. */
	full: string;
	/** What the right side of the row says, repeated in the panel. */
	result?: string;
	/** The panel says when the step happened. */
	timed: boolean;
	/** The panel says the command printed nothing. */
	noOutput?: boolean;
	build: (turn: QuietTurn) => void;
}

const CASES: FactsCase[] = [
	{
		name: "a general step",
		needle: "✓ 搜索 how does",
		full: `搜索 ${LONG_QUERY}`,
		result: "✓ 3 条",
		timed: true,
		build: (turn) =>
			addActivities(turn, "s1", [
				{
					id: "a",
					kind: "search",
					label: LONG_QUERY,
					status: "ok",
					detail: "3 条",
					startedAt: T0 - 3_000,
					endedAt: T0 - 1_000,
				},
			]),
	},
	{
		name: "a command that printed nothing",
		needle: `$ ${LONG_COMMAND.slice(0, 20)}`,
		full: LONG_COMMAND,
		result: "✓ 完成",
		timed: true,
		noOutput: true,
		build: (turn) =>
			addActivities(turn, "c1", [
				{
					id: "a",
					kind: "command",
					label: LONG_COMMAND,
					status: "ok",
					detail: "",
					startedAt: T0 - 3_000,
					endedAt: T0 - 1_000,
				},
			]),
	},
	{
		name: "a single file read",
		needle: "✓ 读取 packages/coding-agent",
		full: `读取 ${LONG_PATH}`,
		timed: true,
		build: (turn) =>
			addActivities(turn, "r1", [{ id: "a", kind: "read", label: LONG_PATH, status: "ok", startedAt: T0 - 2_000 }]),
	},
	{
		name: "a subagent that reported nothing",
		needle: "◇ 子代理 审查员",
		full: "子代理 审查员·屏幕与设置与输出预算的只读审查车道",
		result: "✓ 好了",
		timed: true,
		build: (turn) =>
			turn.timeline.upsertSubagent(
				{
					childId: "c9",
					name: "审查员·屏幕与设置与输出预算的只读审查车道",
					status: "done",
					result: "好了",
					startedAt: T0 - 5_000,
				},
				T0 - 1_000,
			),
	},
	{
		name: "a notice",
		needle: "◇ 子代理 审查员",
		full: "子代理 审查员·屏幕与设置与输出预算的只读审查车道 做完了，没发回消息",
		timed: true,
		build: (turn) =>
			turn.timeline.addNotice(
				{ tone: "muted", text: "子代理 审查员·屏幕与设置与输出预算的只读审查车道 做完了，没发回消息" },
				T0 - 4_000,
			),
	},
	{
		name: "a retry",
		needle: "↻ 模型接口超时",
		full: "模型接口超时，已自动重试",
		timed: true,
		build: (turn) => {
			turn.timeline.startRetry({ startedAt: T0 - 4_000, delayMs: 3_000, attempt: 1, reason: "模型接口超时" });
			turn.timeline.endRetry("ok");
		},
	},
	{
		name: "a compaction",
		needle: "⇣ 整理完成",
		full: "整理完成：182k → 41k tokens，重要的结论都留着",
		timed: true,
		build: (turn) => {
			turn.timeline.startCompaction(T0 - 6_000, 182_000);
			turn.timeline.endCompaction(T0 - 1_000, { before: 182_000 });
			const compaction = turn.timeline.latestCompaction();
			if (compaction) compaction.after = 41_000;
		},
	},
	{
		name: "a memory without texts",
		needle: "✦ 记住：go",
		full: "记住：go http 请求要带 context",
		result: "新记",
		timed: false,
		build: (turn) =>
			addActivities(turn, "m1", [], {
				memoryChanges: [
					{ op: "created", kind: "memory", scope: "session", title: "go_http_请求要带_context", at: T0 },
				],
			}),
	},
];

function clickable(turn: QuietTurn, line: number): ClickRegion | undefined {
	return turn.summary.getClickRegions().find((region) => region.line === line && !region.passive);
}

const squeeze = (value: string) => value.replace(/\s+/g, "");

/** The lines of the panel hanging under the block, without the frame and the bar. */
function panelText(turn: QuietTurn, head: number): string {
	const lines = plain(turn.summary.render(WIDTH));
	const panel: string[] = [];
	for (let index = head + 1; index < lines.length && /^ │ ▎/.test(lines[index] ?? ""); index++) {
		panel.push((lines[index] ?? "").replace(/^ │ ▎|│$/g, ""));
	}
	return panel.join("\n");
}

describe("a block with nothing of its own to open opens to the facts of its step", () => {
	it("covers every kind of block that has no lines of its own", () => {
		expect(CASES.length).toBeGreaterThan(0);
		for (const testCase of CASES) {
			setMotionReduced(true);
			const turn = quietTurn({ host: host({ viewportRows: () => 60 }) });
			testCase.build(turn);
			const closed = turn.summary.render(WIDTH);
			const at = lineIndexWith(closed, testCase.needle);
			expect(at, `${testCase.name} is drawn`).toBeGreaterThan(0);
			// It looks and behaves like any block: a caret, a click area with hover fields, a hint under the pointer.
			expect(plain(closed)[at], `${testCase.name} caret`).toContain("▸");
			const region = clickable(turn, at);
			expect(region, `${testCase.name} click area`).toBeDefined();
			expect(region?.hoverKey, `${testCase.name} hover key`).toBeTypeOf("string");
			expect(region?.onHover, `${testCase.name} hover callback`).toBeTypeOf("function");
			expect(clickable(turn, at + 1)?.hoverKey, `${testCase.name} separator hover key`).toBe(region?.hoverKey);
			region?.onHover?.(true);
			expect(plain(turn.summary.render(WIDTH))[at], `${testCase.name} hint`).toContain("点开 ▸");
			region?.onHover?.(false);

			// A click opens the panel with the step's whole text and its facts.
			region?.onClick({ row: 0, col: 0 });
			const opened = plain(turn.summary.render(WIDTH));
			expect(opened[at], `${testCase.name} opened caret`).toContain("▾");
			const panel = panelText(turn, at);
			expect(panel.length, `${testCase.name} panel`).toBeGreaterThan(0);
			expect(squeeze(panel), `${testCase.name} whole text`).toContain(squeeze(testCase.full));
			if (testCase.result) {
				expect(panel, `${testCase.name} result label`).toMatch(/结果/);
				expect(squeeze(panel), `${testCase.name} result`).toContain(squeeze(testCase.result));
			}
			if (testCase.timed) expect(panel, `${testCase.name} time`).toMatch(/时间\s+\d\d:\d\d:\d\d/);
			else expect(panel, `${testCase.name} has no time`).not.toMatch(/\d\d:\d\d:\d\d/);
			if (testCase.noOutput) expect(panel, `${testCase.name} no output`).toContain("没有输出");
			else expect(panel, `${testCase.name} has output or none to say`).not.toContain("没有输出");

			// Clicking again closes it.
			clickable(turn, at)?.onClick({ row: 0, col: 0 });
			expect(plain(turn.summary.render(WIDTH))[at], `${testCase.name} closed again`).toContain("▸");
		}
	});

	it("says how long a finished step took when it knows both ends", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addActivities(turn, "s1", [
			{
				id: "a",
				kind: "search",
				label: "foo",
				status: "ok",
				detail: "3 条",
				startedAt: T0 - 3_000,
				endedAt: T0 - 1_000,
			},
		]);
		const lines = turn.summary.render(100);
		const at = lineIndexWith(lines, "搜索 foo");
		clickable(turn, at)?.onClick({ row: 0, col: 0 });
		expect(panelTextAt(turn, at, 100)).toMatch(/时间\s+\d\d:\d\d:\d\d · 用了 2秒/);
	});

	it("says 不到 1秒 for a step that took less than a second", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addActivities(turn, "s1", [
			{
				id: "a",
				kind: "search",
				label: "foo",
				status: "ok",
				detail: "3 条",
				startedAt: T0 - 3_000,
				endedAt: T0 - 2_400,
			},
		]);
		const at = lineIndexWith(turn.summary.render(100), "搜索 foo");
		clickable(turn, at)?.onClick({ row: 0, col: 0 });
		expect(panelTextAt(turn, at, 100)).toContain("用了 不到 1秒");
	});

	it("leaves out what it does not know instead of guessing", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addActivities(turn, "r1", [{ id: "a", kind: "read", label: "a.go", status: "ok", startedAt: 0 }]);
		const lines = turn.summary.render(100);
		const at = lineIndexWith(lines, "读取 a.go");
		clickable(turn, at)?.onClick({ row: 0, col: 0 });
		const panel = panelTextAt(turn, at, 100);
		expect(panel).toContain("读取 a.go");
		expect(panel).not.toMatch(/时间|结果/);
	});

	it("does not say a command printed nothing when the cell's output belongs to its last command", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addActivities(
			turn,
			"c1",
			[
				{
					id: "a",
					kind: "command",
					label: "make lint",
					status: "ok",
					detail: "",
					startedAt: T0 - 5_000,
					endedAt: T0 - 4_000,
				},
				{
					id: "b",
					kind: "command",
					label: "make test",
					status: "ok",
					detail: "",
					startedAt: T0 - 3_000,
					endedAt: T0 - 1_000,
				},
			],
			{ stdout: "all 54 passed" },
		);
		const lines = turn.summary.render(100);
		const first = lineIndexWith(lines, "$ make lint");
		clickable(turn, first)?.onClick({ row: 0, col: 0 });
		expect(panelTextAt(turn, first, 100)).not.toContain("没有输出");
	});

	it("keeps a command's own output as its panel, without the made-up facts", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean tree" });
		const lines = turn.summary.render(100);
		const at = lineIndexWith(lines, "$ git status");
		clickable(turn, at)?.onClick({ row: 0, col: 0 });
		const panel = panelTextAt(turn, at, 100);
		expect(panel).toContain("clean tree");
		expect(panel).not.toContain("没有输出");
		expect(panel).not.toMatch(/结果/);
	});
});

function panelTextAt(turn: QuietTurn, head: number, width: number): string {
	const lines = plain(turn.summary.render(width));
	const panel: string[] = [];
	for (let index = head + 1; index < lines.length && /^ │ ▎/.test(lines[index] ?? ""); index++) {
		panel.push((lines[index] ?? "").replace(/^ │ ▎|│$/g, ""));
	}
	return panel.join("\n");
}

describe("what stays out of the block rule", () => {
	it("still draws a short note and a short interjection as plain text nobody can click", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addSay(turn, "趁等待，查一个风险点。", "s1");
		turn.timeline.addSteer("先别动安卓的，只升级 Go", T0);
		const lines = turn.summary.render(100);
		for (const needle of ["趁等待，查一个风险点。", "你插话：先别动安卓的"]) {
			const at = lineIndexWith(lines, needle);
			expect(at, needle).toBeGreaterThan(0);
			expect(plain(lines)[at], needle).not.toContain("▸");
			expect(clickable(turn, at), needle).toBeUndefined();
		}
		expect(turn.summary.getFocusOrder().some((key) => key.startsWith("say:") || key.startsWith("steer:"))).toBe(
			false,
		);
	});

	it("does not let Ctrl+T open the facts of a thought whose words are hidden", () => {
		setMotionReduced(true);
		const turn = quietTurn({ host: host({ hideThinking: () => true }) });
		addThought(turn, "这段思考的文字不该露出来。再想一步。");
		const lines = turn.summary.render(100);
		const at = lineIndexWith(lines, "思考了");
		expect(at).toBeGreaterThan(0);
		turn.summary.toggleThinkingRows();
		expect(turn.timeline.ui.expanded.size).toBe(0);
		expect(plain(turn.summary.render(100)).join("\n")).not.toContain("这段思考的文字");
	});
});
