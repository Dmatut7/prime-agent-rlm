import { type ClickRegion, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import {
	addActivities,
	addCommand,
	addSay,
	addThought,
	host,
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

const WIDTH = 60;
const LONG_PATH = "packages/coding-agent/src/modes/interactive/components/very-long-directory-name/some-file.md";
const LONG_COMMAND = "grep -rn --include=*.ts onAction packages/coding-agent/src/modes/interactive | wc -l";
const LONG_QUERY = "how does the timeline decide which rows are persistent when the turn folds up";
const LONG_NAME = "审查员·屏幕与设置与输出预算的只读审查车道";

/** A step the timeline draws as a line that has no lines of its own to open. */
interface FactsCase {
	name: string;
	/** What the step's own line starts with (still readable at 60 columns). */
	needle: string;
	/** The whole text of the step: cut off in the line, whole in the opened lines. */
	full: string;
	/** What the right side of the line says, repeated in the opened lines. */
	result?: string;
	/** The opened lines say when the step happened. */
	timed: boolean;
	/** The opened lines say the command printed nothing. */
	noOutput?: boolean;
	build: (turn: QuietTurn) => void;
}

const CASES: FactsCase[] = [
	{
		name: "a general step",
		needle: "✓  搜索 how does",
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
		needle: `$  ${LONG_COMMAND.slice(0, 20)}`,
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
		needle: "✓  读取 packages/coding-agent",
		full: `读取 ${LONG_PATH}`,
		timed: true,
		build: (turn) =>
			addActivities(turn, "r1", [{ id: "a", kind: "read", label: LONG_PATH, status: "ok", startedAt: T0 - 2_000 }]),
	},
	{
		name: "a notice",
		needle: "◇  子代理 审查员",
		full: `子代理 ${LONG_NAME} 做完了，没发回消息`,
		timed: true,
		build: (turn) =>
			turn.timeline.addNotice({ tone: "muted", text: `子代理 ${LONG_NAME} 做完了，没发回消息` }, T0 - 4_000),
	},
	{
		name: "a retry",
		needle: "↻  模型接口超时",
		full: "模型接口超时，已自动重试",
		timed: true,
		build: (turn) => {
			turn.timeline.startRetry({ startedAt: T0 - 4_000, delayMs: 3_000, attempt: 1, reason: "模型接口超时" });
			turn.timeline.endRetry("ok");
		},
	},
	{
		name: "a compaction",
		needle: "⇣  整理完成",
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
		needle: "✦  记住：go",
		full: "记住：go · http · 请求要带 · context",
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

const hoverBg = () => theme.getBgAnsi("timelineHoverBg");

function regionsOn(turn: QuietTurn, line: number): ClickRegion[] {
	return turn.summary.getClickRegions().filter((region) => region.line === line);
}

/** The one click area of a line, or undefined. */
function clickable(turn: QuietTurn, line: number): ClickRegion | undefined {
	const regions = regionsOn(turn, line);
	expect(regions.length).toBeLessThanOrEqual(1);
	return regions[0];
}

/** Index of the first line after the first whose plain text contains `needle`, or -1. */
function lineOf(lines: readonly string[], needle: string): number {
	return plain(lines).findIndex((line, index) => index > 0 && line.includes(needle));
}

/** Opens every event that lists steps and draws the turn. */
function openAll(turn: QuietTurn, width = WIDTH): string[] {
	turn.summary.toggleBox();
	return turn.summary.render(width);
}

const squeeze = (value: string) => value.replace(/\s+/g, "");

/** The lines an opened step lists under its own line (eight columns further in than its glyph). */
function detailText(turn: QuietTurn, head: number, width = WIDTH): string {
	const lines = plain(turn.summary.render(width));
	const detail: string[] = [];
	for (let index = head + 1; index < lines.length && /^ {9}│ {14}\S/.test(lines[index] ?? ""); index++) {
		detail.push((lines[index] ?? "").replace(/^ {9}│ {14}/, ""));
	}
	return detail.join("\n");
}

describe("a step with nothing of its own to open opens to the facts of its step", () => {
	it("covers every kind of step that has no lines of its own", () => {
		expect(CASES.length).toBeGreaterThan(0);
		for (const testCase of CASES) {
			const turn = quietTurn({ host: host({ viewportRows: () => 60 }) });
			testCase.build(turn);
			const closed = openAll(turn);
			const at = lineOf(closed, testCase.needle);
			expect(at, `${testCase.name} is drawn`).toBeGreaterThan(0);
			const stepKey = turn.summary.getFocusOrder().at(-1) ?? "";
			expect(stepKey.startsWith("ev:"), `${testCase.name} is a step of its event`).toBe(false);
			// It behaves like any step: a click area with hover fields, and nothing around it that clicks too.
			const region = clickable(turn, at);
			expect(region, `${testCase.name} click area`).toBeDefined();
			expect(region?.hoverKey, `${testCase.name} hover key`).toBeTypeOf("string");
			expect(region?.onHover, `${testCase.name} hover callback`).toBeTypeOf("function");
			expect(clickable(turn, at + 1), `${testCase.name} row under it`).toBeUndefined();
			expect(turn.summary.enterLabel(stepKey), `${testCase.name} enter label`).toBe("展开");
			// Under the pointer the whole line takes the hover color and nothing in it moves.
			region?.onHover?.(true);
			const lit = turn.summary.render(WIDTH);
			expect(lit[at], `${testCase.name} hover color`).toContain(hoverBg());
			expect(plain(lit)[at], `${testCase.name} hover keeps the words`).toBe(plain(closed)[at]);
			region?.onHover?.(false);
			expect(turn.summary.render(WIDTH)[at], `${testCase.name} hover leaves`).not.toContain(hoverBg());

			// A click opens the step's whole text and its facts under it.
			region?.onClick({ row: 0, col: 0 });
			expect(turn.summary.enterLabel(stepKey), `${testCase.name} opened`).toBe("收起");
			const detail = detailText(turn, at);
			expect(detail.length, `${testCase.name} opened lines`).toBeGreaterThan(0);
			expect(squeeze(detail), `${testCase.name} whole text`).toContain(squeeze(testCase.full));
			if (testCase.result) {
				expect(detail, `${testCase.name} result label`).toMatch(/结果/);
				expect(squeeze(detail), `${testCase.name} result`).toContain(squeeze(testCase.result));
			}
			if (testCase.timed) expect(detail, `${testCase.name} time`).toMatch(/时间\s+\d\d:\d\d:\d\d/);
			else expect(detail, `${testCase.name} has no time`).not.toMatch(/\d\d:\d\d:\d\d/);
			if (testCase.noOutput) expect(detail, `${testCase.name} no output`).toContain("没有输出");
			else expect(detail, `${testCase.name} has output or none to say`).not.toContain("没有输出");

			// Clicking again closes it.
			clickable(turn, at)?.onClick({ row: 0, col: 0 });
			expect(turn.summary.enterLabel(stepKey), `${testCase.name} closed again`).toBe("展开");
			expect(detailText(turn, at), `${testCase.name} closed lines`).toBe("");
		}
	});

	it("draws a subagent that reported nothing on its dispatch line, with nothing behind it to open", () => {
		const turn = quietTurn();
		turn.timeline.upsertSubagent(
			{ childId: "c9", name: LONG_NAME, status: "done", result: "好了", startedAt: T0 - 5_000 },
			T0 - 1_000,
		);
		const lines = openAll(turn);
		const shown = plain(lines);
		const at = lineOf(lines, "◇  审查员");
		expect(at).toBeGreaterThan(0);
		expect(shown[at]?.startsWith("         ├")).toBe(true);
		expect(shown[at]).toContain(`◇  ${LONG_NAME}`);
		expect(regionsOn(turn, at)).toHaveLength(0);
		expect(regionsOn(turn, at + 1)).toHaveLength(0);
		expect(turn.summary.getFocusOrder()).toHaveLength(0);
		expect(shown.join("\n")).not.toMatch(/结果|时间 /);
	});

	it("says how long a finished step took when it knows both ends", () => {
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
		const lines = openAll(turn, 100);
		const at = lineOf(lines, "搜索 foo");
		clickable(turn, at)?.onClick({ row: 0, col: 0 });
		expect(detailText(turn, at, 100)).toMatch(/时间\s+\d\d:\d\d:\d\d · 用了 2秒/);
	});

	it("says 不到 1秒 for a step that took less than a second", () => {
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
		const at = lineOf(openAll(turn, 100), "搜索 foo");
		clickable(turn, at)?.onClick({ row: 0, col: 0 });
		expect(detailText(turn, at, 100)).toContain("用了 不到 1秒");
	});

	it("leaves out what it does not know instead of guessing", () => {
		const turn = quietTurn();
		addActivities(turn, "r1", [{ id: "a", kind: "read", label: "a.go", status: "ok", startedAt: 0 }]);
		const lines = openAll(turn, 100);
		const at = lineOf(lines, "读取 a.go");
		clickable(turn, at)?.onClick({ row: 0, col: 0 });
		const detail = detailText(turn, at, 100);
		expect(detail).toContain("读取 a.go");
		expect(detail).not.toMatch(/时间|结果/);
	});

	it("does not say a command printed nothing when the cell's output belongs to its last command", () => {
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
		const lines = openAll(turn, 100);
		const first = lineOf(lines, "$  make lint");
		expect(first).toBeGreaterThan(0);
		clickable(turn, first)?.onClick({ row: 0, col: 0 });
		const detail = detailText(turn, first, 100);
		expect(detail).toContain("make lint");
		expect(detail).not.toContain("没有输出");
	});

	it("keeps a command's own output as its opened lines, without the made-up facts", () => {
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean tree" });
		const lines = openAll(turn, 100);
		const at = lineOf(lines, "$  git status");
		clickable(turn, at)?.onClick({ row: 0, col: 0 });
		const detail = detailText(turn, at, 100);
		expect(detail).toContain("clean tree");
		expect(detail).not.toContain("没有输出");
		expect(detail).not.toMatch(/结果/);
	});
});

describe("what stays out of the click and keyboard targets", () => {
	it("keeps an interjection out of every target and a note's words a target only as their event", () => {
		const turn = quietTurn();
		addSay(turn, "趁等待，查一个风险点。", "s1");
		turn.timeline.addSteer("先别动安卓的，只升级 Go", T0);
		const lines = turn.summary.render(100);
		const shown = plain(lines);
		expect(shown[0]).toContain("趁等待，查一个风险点。");
		const steer = shown.findIndex((line) => line.includes("你插话   先别动安卓的"));
		expect(steer).toBeGreaterThan(0);
		expect(shown[steer]).not.toContain("▸");
		expect(regionsOn(turn, steer)).toHaveLength(0);
		// The note's own line is the event: its one target opens the step behind it.
		expect(regionsOn(turn, 0)).toHaveLength(1);
		expect(regionsOn(turn, 0)[0]?.hoverKey).toContain(":ev:");
		const order = turn.summary.getFocusOrder();
		expect(order).toHaveLength(1);
		expect(order.some((key) => key.startsWith("say:") || key.startsWith("steer:"))).toBe(false);
	});

	it("does not let Ctrl+T open the facts of a thought whose words are hidden", () => {
		const turn = quietTurn({ host: host({ hideThinking: () => true }) });
		addThought(turn, "这段思考的文字不该露出来。再想一步。");
		turn.summary.render(100);
		const eventKey = turn.summary.getFocusOrder()[0] ?? "";
		expect(eventKey.startsWith("ev:")).toBe(true);
		turn.summary.activate(eventKey);
		const at = lineOf(turn.summary.render(100), "思考了");
		expect(at).toBeGreaterThan(0);
		turn.summary.activate(eventKey);
		expect(turn.timeline.ui.expanded.size).toBe(0);
		turn.summary.toggleThinkingRows();
		expect(turn.timeline.ui.expanded.size).toBe(0);
		turn.summary.activate(eventKey);
		expect(plain(turn.summary.render(100)).join("\n")).not.toContain("这段思考的文字");
		expect(turn.timeline.ui.expanded.size).toBe(1);
	});
});
