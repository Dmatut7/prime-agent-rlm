import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { TurnActivityState } from "../src/modes/interactive/components/turn-activity.js";
import { type BoxHeader, computeBoxHeader } from "../src/modes/interactive/components/turn-box.js";
import { theme } from "../src/modes/interactive/theme/theme.js";
import {
	addActivities,
	addClosingAnswer,
	addCommand,
	addStep,
	addThought,
	hasFg,
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
	vi.useRealTimers();
});

const WIDTH = 140;

/** Every step is added ten seconds after the last, so no two of them share a message. */
function useSteppedClock(): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
}

function later(): void {
	vi.setSystemTime(Date.now() + 10_000);
}

function finish(turn: QuietTurn): void {
	turn.state.markTurnEnded(Date.now());
	turn.state.finishBox(Date.now());
}

/** What the box header computes for a finished turn (the live tail's fallback words). */
function headerOf(state: TurnActivityState): BoxHeader {
	const view = state.boxView();
	return computeBoxHeader({
		rows: view.rows,
		facts: view.facts,
		timeline: state.timeline,
		live: view.live,
		phase: "waiting",
		currentThinking: "",
		now: Date.now(),
	});
}

function mistake(turn: QuietTurn): void {
	addStep(turn, "x1", "import nope", "error", Date.now() - 6_000);
	turn.timeline.mergeStep(
		"x1",
		"ipython",
		{},
		{
			isError: true,
			details: { error: { ename: "ModuleNotFoundError", evalue: "No module named 'nope'", traceback: [] } },
		},
		false,
	);
}

const mutedDots = (header: BoxHeader) => header.parts.filter((part) => part.text === " · " && part.color === "muted");

describe("the finished turn's counts are colored by kind", () => {
	it("reads thoughts, commands, file changes, memories and subagents on the event line, and paints each in its kind's color in the header", () => {
		useSteppedClock();
		const turn = quietTurn({ live: false });
		addThought(turn, "先看一下。再看一下。");
		later();
		addCommand(turn, "c1", "git status");
		later();
		addActivities(turn, "e1", [], {
			fileChanges: [
				{
					path: "/work/app/a.go",
					relPath: "a.go",
					kind: "modified",
					scope: "project",
					added: 12,
					removed: 4,
					source: "edit",
					at: 1,
				},
			],
			memoryChanges: [
				{ op: "created", kind: "memory", scope: "session", title: "一条记忆", after: "内容。", at: 3 },
			],
		});
		later();
		turn.timeline.upsertSubagent({ childId: "c1", name: "审查员", status: "done", result: "好了" });
		finish(turn);

		// The timeline says the counts once, on the event's line, in the line's own color; the dispatch has its own line.
		const lines = turn.summary.render(WIDTH);
		expect(plain(lines)).toHaveLength(3);
		expect(plain(lines)[1]).toMatch(/^ {9}├ {6}◇ {2}审查员$/);
		expect(plain(lines)[2]?.trimEnd()).toBe("         │");
		expect(plain(lines)[0]).toMatch(
			/^ \d\d:\d\d {3}◆ {6}想了 1 次 · 跑了 1 条命令 · 改了 1 个文件 · 记住 1 条 · 派了 1 个子代理 +4 步 ▸ {2}$/,
		);
		expect(lines[0]).toContain(
			theme.fg("text", "想了 1 次 · 跑了 1 条命令 · 改了 1 个文件 · 记住 1 条 · 派了 1 个子代理"),
		);
		for (const kind of ["kindThink", "kindCommand", "kindEdit", "kindMemory", "kindSubagent"] as const) {
			expect(hasFg(lines[0] ?? "", kind), `${kind} is not on the drawn line`).toBe(false);
		}

		const header = headerOf(turn.state);
		expect(header.status).toBe("done");
		expect(header.plain).toBe("想了 1 次 · 跑了 1 条命令 · 改了 1 个文件 +12 −4 · 记住 1 条 · 派了 1 个子代理");
		expect(header.parts).toContainEqual({ text: "想了 1 次", color: "kindThink" });
		expect(header.parts).toContainEqual({ text: "跑了 1 条命令", color: "kindCommand" });
		expect(header.parts).toContainEqual({ text: "改了 1 个文件 ", color: "kindEdit" });
		expect(header.parts).toContainEqual({ text: "记住 1 条", color: "kindMemory" });
		expect(header.parts).toContainEqual({ text: "派了 1 个子代理", color: "kindSubagent" });
		expect(mutedDots(header)).toHaveLength(4);
	});

	it("reads a read count on the event line and paints it in the read color in the header", () => {
		const turn = quietTurn({ live: false });
		addActivities(turn, "r1", [
			{ id: "a", kind: "read", label: "a.go", status: "ok", startedAt: 1 },
			{ id: "b", kind: "read", label: "b.go", status: "ok", startedAt: 2 },
		]);
		finish(turn);
		const lines = turn.summary.render(WIDTH);
		expect(plain(lines)[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}读了 2 个文件 +1 步 ▸ {2}$/);
		const header = headerOf(turn.state);
		expect(header.plain).toContain("读了 2 个文件");
		expect(header.parts).toContainEqual({ text: "读了 2 个文件", color: "kindRead" });
	});

	it("paints a failure count red and a corrected mistake in the recovered color, and draws the failure red and the correction not", () => {
		const failed = quietTurn({ live: false });
		mistake(failed);
		failed.timeline.errorEnded = true;
		finish(failed);
		const failedHeader = headerOf(failed.state);
		expect(failedHeader.parts).toContainEqual({ text: "1 处出错", color: "kindError" });
		const failedLines = failed.summary.render(WIDTH);
		expect(plain(failedLines)[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}Python 出错：/);
		expect(failedLines[0]).toContain(
			theme.fg("timelineMust", "Python 出错：ModuleNotFoundError: No module named 'nope'"),
		);

		const recovered = quietTurn({ live: false });
		mistake(recovered);
		addCommand(recovered, "c1", "pip install nope");
		addClosingAnswer(recovered);
		finish(recovered);
		const recoveredHeader = headerOf(recovered.state);
		expect(recoveredHeader.parts).toContainEqual({ text: "出错 1 次，已改正", color: "kindRecovered" });
		expect(recoveredHeader.parts.some((part) => part.color === "kindError")).toBe(false);
		const recoveredLines = recovered.summary.render(WIDTH);
		expect(plain(recoveredLines)).toHaveLength(1);
		expect(hasFg(recoveredLines[0] ?? "", "timelineMust")).toBe(false);
		recovered.summary.toggleBox();
		const opened = recovered.summary.render(WIDTH);
		const fixed = opened.find((line) => plain([line])[0]?.includes("下一格改好了")) ?? "";
		expect(fixed).toContain(theme.fg("timelineFix", "下一格改好了"));
		expect(hasFg(fixed, "timelineMust")).toBe(false);
	});

	it("keeps the words themselves unchanged, and draws no status pill, clock or token count", () => {
		useSteppedClock();
		const turn = quietTurn({ live: false });
		addThought(turn, "先看一下。再看一下。");
		later();
		addCommand(turn, "c1", "git status");
		finish(turn);
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}想了 1 次 · 跑了 1 条命令 +2 步 ▸ {2}$/);
		expect(lines[0]).not.toMatch(/完成|\d+秒|↓/);
		expect(headerOf(turn.state).plain).toBe("想了 1 次 · 跑了 1 条命令");
	});
});
