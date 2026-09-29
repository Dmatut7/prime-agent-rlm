import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ClickRegion, setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { shortAgentName } from "../src/modes/interactive/components/agent-message.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { subagentTaskTag } from "../src/modes/interactive/components/subagent-summary-line.js";
import { formatTimelineTime } from "../src/modes/interactive/components/timeline-gutter.js";
import { TimelineLaneTracker } from "../src/modes/interactive/components/timeline-lane.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { setWorkingPulseTick } from "../src/modes/interactive/theme/working-icon.js";

/** 18:47 local time on a fixed day, so the time column is the design's. */
const T0 = new Date(2026, 8, 29, 18, 47, 0).getTime();
const MINUTE = 60_000;

function assistant(
	timestamp: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		timestamp,
	};
}

function host(): TimelineHost {
	return {
		cwd: () => "/work/app",
		viewportRows: () => 40,
		openWhileWorking: () => true,
		autoFold: () => true,
		requestRender: vi.fn(),
	};
}

type Turn = ReturnType<typeof quietTurn>;

function quietTurn(live: boolean) {
	const state = new TurnActivityState(T0 - 1_000);
	if (live) state.live = true;
	state.modelId = "glm-5.3-prime";
	const summary = new TurnSummaryComponent(state);
	summary.setTimelineHost(host());
	summary.setQuiet(true);
	return { state, summary, timeline: state.timeline };
}

interface Call {
	id: string;
	command: string;
	status?: "running" | "done" | "error";
}

/** One assistant message: optional words before its calls, then the calls (each a `bash` cell). */
function say(turn: Turn, timestamp: number, words: string | undefined, calls: Call[], ended = true): void {
	const content: AssistantMessage["content"] = [
		...(words ? [{ type: "text" as const, text: words }] : []),
		...calls.map((call) => ({
			type: "toolCall" as const,
			id: call.id,
			name: "ipython",
			arguments: { code: `r = await bash('${call.command}')` },
		})),
	];
	turn.timeline.noteMessage(assistant(timestamp, content), ended);
	for (const call of calls) {
		const status = call.status ?? "done";
		turn.state.addStep({
			toolCallId: call.id,
			toolName: "ipython",
			args: { code: `r = await bash('${call.command}')` },
			status: "queued",
		});
		turn.state.setStepStatus(call.id, "running", timestamp);
		if (status !== "running") turn.state.setStepStatus(call.id, status, timestamp + 2_000);
	}
}

function plain(lines: readonly string[]): string[] {
	return lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));
}

/** The column a string starts at in a plain line (wide characters count two). */
function cell(line: string, needle: string): number {
	const at = line.indexOf(needle);
	expect(at).toBeGreaterThanOrEqual(0);
	let cols = 0;
	for (const ch of line.slice(0, at)) cols += /[ᄀ-ᅟ⺀-鿿가-힣＀-｠]/.test(ch) ? 2 : 1;
	return cols;
}

function widthOf(line: string): number {
	let cols = 0;
	for (const ch of line) cols += /[ᄀ-ᅟ⺀-鿿가-힣＀-｠]/.test(ch) ? 2 : 1;
	return cols;
}

function clickAt(regions: ReadonlyArray<ClickRegion>, line: number): void {
	const region = regions.find((candidate) => candidate.line === line);
	expect(region).toBeDefined();
	region?.onClick({ line, col: 0 } as never);
}

const WIDTH = 100;
const HH_MM = (at: number) => formatTimelineTime(at);

/** The design's screens: two events, a dispatch, then events while the agents work; done unless `live`. */
function designTurn(live = false): { turn: Turn; tracker: TimelineLaneTracker } {
	const turn = quietTurn(live);
	const tracker = new TimelineLaneTracker();
	turn.summary.setLaneTracker(tracker);
	say(turn, T0, "先看最近的提交，定下审查范围。", [
		{ id: "c1", command: "git log --oneline -30" },
		{ id: "c2", command: "git branch --show-current" },
	]);
	say(turn, T0 + MINUTE, "范围定了：16 个提交、96 个文件。派四个代理并行审查。", []);
	for (const [id, name, label] of [
		["a", "A", "A 钉住框头，看它有没有钉住"],
		["b", "B", "B 框的折叠：长高和收起"],
		["c", "C", "C 子代理小块"],
		["d", "D", "D 测试和发版"],
	] as const) {
		turn.timeline.upsertSubagent({ childId: id, name, label, status: "running" }, T0 + MINUTE);
	}
	say(turn, T0 + 3 * MINUTE, "趁它们干活，我自己跑检查和测试。", [
		{ id: "c3", command: "npx tsgo --noEmit" },
		{ id: "c4", command: "npx vitest --run test/grow-a.test.ts" },
		{ id: "c5", command: "npx vitest --run test/grow-b.test.ts" },
		{ id: "c6", command: "npx vitest --run test/grow-c.test.ts" },
		{ id: "c7", command: "npx vitest --run test/grow-d.test.ts" },
	]);
	if (!live) {
		turn.state.markTurnEnded(T0 + 20 * MINUTE);
		turn.state.finishBox(T0 + 20 * MINUTE);
	}
	return { turn, tracker };
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
	setWorkingPulseTick(0);
	vi.useRealTimers();
});

describe("the timeline draws a turn as event lines (Tl2Done)", () => {
	it("puts each event on its own line: time in column 1, the AI's diamond at column 9, words at column 16", () => {
		const { turn } = designTurn();
		const lines = plain(turn.summary.render(WIDTH));
		const first = lines[0] ?? "";
		expect(first.startsWith(` ${HH_MM(T0)}   ◆`)).toBe(true);
		expect(cell(first, "◆")).toBe(9);
		expect(cell(first, "先看最近的提交，定下审查范围。")).toBe(16);
		expect(first.trimEnd().endsWith("2 步 ▸")).toBe(true);
		const second = lines[1] ?? "";
		expect(second.startsWith(` ${HH_MM(T0 + MINUTE)}   ◆`)).toBe(true);
		expect(cell(second, "范围定了")).toBe(16);
		// Events sit on consecutive lines: no blank line between them.
		expect(lines.slice(0, 2).every((line) => line.trim() !== "")).toBe(true);
	});

	it("draws no frame, card, pill or title line", () => {
		const { turn } = designTurn();
		const all = plain(turn.summary.render(WIDTH)).join("\n");
		for (const gone of ["╭", "╰", "├─┤", "◆ prime", "完成 ", "进行中", "▀", "▎"]) expect(all).not.toContain(gone);
	});

	it("ends the count on `N 步 ▸` two columns from the right edge", () => {
		const { turn } = designTurn();
		const first = plain(turn.summary.render(WIDTH))[0] ?? "";
		expect(widthOf(first)).toBe(WIDTH);
		expect(first.endsWith("▸  ")).toBe(true);
		expect(widthOf(first.trimEnd().replace(/▸$/, "")) + 3).toBe(WIDTH);
	});

	it("draws the dispatch under its event: `├──╮`, a diamond and the names three spaces apart, then one blank line", () => {
		const { turn } = designTurn();
		const lines = plain(turn.summary.render(WIDTH));
		const split = lines.findIndex((line) => line.includes("├──╮"));
		expect(split).toBe(2);
		const row = lines[split] ?? "";
		expect(cell(row, "├")).toBe(9);
		expect(row.startsWith("         ├──╮   ◇  A 钉住框头   B 框的折叠   C 子代理小块   D 测试和发版")).toBe(true);
		expect(cell(row, "◇")).toBe(16);
		expect(cell(row, "A 钉住框头")).toBe(19);
		// The row after the dispatch is a blank one on the rail, with the lane dotted.
		expect(lines[split + 1]?.trimEnd()).toBe("         │  ┆");
		// The next event carries the lane.
		expect(lines[split + 2]?.slice(0, 16)).toBe(` ${HH_MM(T0 + 3 * MINUTE)}   ◆  ┆   `.slice(0, 16));
		expect(cell(lines[split + 2] ?? "", "趁它们干活")).toBe(16);
	});

	it("lists an opened event's first three steps and `⋯ 另外 N 步   全部 ›`", () => {
		const { turn } = designTurn();
		const before = plain(turn.summary.render(WIDTH));
		const eventLine = before.findIndex((line) => line.includes("趁它们干活"));
		expect(before[eventLine]?.trimEnd().endsWith("5 步 ▸")).toBe(true);
		turn.summary.activate(turn.summary.getFocusOrder().filter((key) => key.startsWith("ev:"))[1] ?? "");
		const open = plain(turn.summary.render(WIDTH));
		const at = open.findIndex((line) => line.includes("趁它们干活"));
		expect(open[at]?.trimEnd().endsWith("5 步 ▴")).toBe(true);
		const steps = open.slice(at + 1, at + 5);
		expect(steps).toHaveLength(4);
		for (const step of steps.slice(0, 3)) {
			// rail at column 9, the lane at column 12, then five columns of indent and the glyph at column 21
			expect(step.slice(0, 10)).toBe("         │");
			expect(cell(step, "$")).toBe(16 + 5);
		}
		expect(steps[0]).toContain("$  npx tsgo --noEmit");
		expect(steps[3]).toContain("⋯  另外 2 步");
		expect(steps[3]?.trimEnd().endsWith("全部 ›")).toBe(true);
	});

	it("paints an opened step's words and the `另外 N 步` words in the dim color, as the design does", () => {
		const { turn } = designTurn();
		turn.summary.render(WIDTH);
		turn.summary.activate(turn.summary.getFocusOrder().filter((key) => key.startsWith("ev:"))[1] ?? "");
		const raw = turn.summary.render(WIDTH);
		const dim = theme.getFgAnsi("timelineTime");
		const soft = theme.getFgAnsi("timelineSoft");
		expect(dim).not.toBe(soft);
		const step = raw.find((line) => line.includes("npx tsgo --noEmit")) ?? "";
		expect(step).toContain(`${dim}npx tsgo --noEmit`);
		const more = raw.find((line) => line.includes("另外 2 步")) ?? "";
		expect(more).toContain(`${dim}另外 2 步`);
	});

	it("`全部 ›` lists every step", () => {
		const { turn } = designTurn();
		turn.summary.render(WIDTH);
		const eventKey = turn.summary.getFocusOrder().filter((key) => key.startsWith("ev:"))[1] ?? "";
		turn.summary.activate(eventKey);
		turn.summary.render(WIDTH);
		const all = turn.summary.getFocusOrder().find((key) => key.startsWith("all:")) ?? "";
		turn.summary.activate(all);
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines.filter((line) => line.includes("$  npx")).length).toBe(5);
		expect(lines.join("\n")).not.toContain("全部 ›");
	});
});

describe("lanes follow the tracker", () => {
	it("draws `┆` in the lane column of every line after the dispatch while agents are out", () => {
		const { turn, tracker } = designTurn();
		const lines = plain(turn.summary.render(WIDTH));
		expect(tracker.active).toBe(true);
		const after = lines.slice(lines.findIndex((line) => line.includes("├──╮")) + 1);
		expect(after.length).toBeGreaterThan(0);
		for (const line of after) expect(line.slice(12, 13)).toBe("┆");
	});

	it("draws no lane without a tracker", () => {
		const turn = quietTurn(false);
		say(turn, T0, "先看最近的提交。", [{ id: "c1", command: "git log" }]);
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines.join("\n")).not.toContain("┆");
	});
});

describe("a turn still running (Tl2Live)", () => {
	function liveTurn() {
		const { turn, tracker } = designTurn(true);
		say(
			turn,
			Date.now() - 12_000,
			undefined,
			[{ id: "c8", command: "npx vitest --run grow-bottom.test.ts", status: "running" }],
			false,
		);
		return { turn, tracker };
	}

	it("ends on the spinner line, the running command and who is still out", () => {
		const { turn, tracker } = liveTurn();
		turn.summary.render(WIDTH);
		tracker.reported("B");
		const lines = plain(turn.summary.render(WIDTH));
		const spin = lines.findIndex((line) => /^ \d\d:\d\d {3}[⠀-⣿]/.test(line));
		expect(spin).toBeGreaterThan(0);
		expect(cell(lines[spin] ?? "", "第 ")).toBeGreaterThan(40);
		expect(lines[spin]?.trimEnd().endsWith("步")).toBe(true);
		const tip = lines[spin + 1] ?? "";
		expect(tip.startsWith("         ╎  ┆")).toBe(true);
		expect(cell(tip, "在跑")).toBe(16 + 5);
		expect(tip).toContain("npx vitest --run grow-bottom.test.ts");
		expect(tip.trimEnd().endsWith("秒")).toBe(true);
		expect(lines[spin + 2]?.trimEnd()).toBe("         ╎  ┆");
		const pending = lines[spin + 3] ?? "";
		expect(pending.startsWith("            ┆   A、C、D 还在干活")).toBe(true);
	});

	it("puts one blank rail line before the spinner", () => {
		const { turn } = liveTurn();
		const lines = plain(turn.summary.render(WIDTH));
		const spin = lines.findIndex((line) => /^ \d\d:\d\d {3}[⠀-⣿]/.test(line));
		expect(lines[spin - 1]?.replace(/\s+$/, "")).toMatch(/^\s+│\s+┆$/);
	});

	it("keeps steps behind `N 步` while live and folds an open event when the turn ends", () => {
		const { turn } = liveTurn();
		turn.summary.render(WIDTH);
		turn.summary.activate(turn.summary.getFocusOrder()[0] ?? "");
		expect(turn.state.boxOpen).toBe(true);
		turn.state.finishBox();
		expect(turn.state.boxOpen).toBe(false);
	});
});

describe("clicks and the keyboard", () => {
	it("makes an event line a click region that opens its steps", () => {
		const { turn } = designTurn();
		const first = plain(turn.summary.render(WIDTH));
		const regions = turn.summary.getClickRegions();
		expect(regions.length).toBeGreaterThan(0);
		clickAt(regions, 0);
		const after = plain(turn.summary.render(WIDTH));
		expect(after[0]?.trimEnd().endsWith("2 步 ▴")).toBe(true);
		expect(after.length).toBe(first.length + 2);
		expect(after[1]).toContain("$  git log --oneline -30");
	});

	it("paints the whole line on the hover color", () => {
		const { turn } = designTurn();
		turn.summary.render(WIDTH);
		const region = turn.summary.getClickRegions().find((candidate) => candidate.line === 0);
		region?.onHover?.(true);
		const lit = turn.summary.render(WIDTH)[0] ?? "";
		expect(lit).toContain(theme.getBgAnsi("timelineHoverBg"));
		expect(widthOf(stripAnsi(lit))).toBe(WIDTH);
		region?.onHover?.(false);
		expect(turn.summary.render(WIDTH)[0]).not.toContain(theme.getBgAnsi("timelineHoverBg"));
	});

	it("walks events and steps with the keyboard focus order", () => {
		const { turn } = designTurn();
		turn.summary.render(WIDTH);
		const order = turn.summary.getFocusOrder();
		expect(order.filter((key) => key.startsWith("ev:")).length).toBeGreaterThanOrEqual(2);
		turn.summary.activate(order[0] ?? "");
		turn.summary.render(WIDTH);
		const walked = turn.summary.getFocusOrder();
		expect(walked.length).toBeGreaterThan(order.length);
		expect(turn.summary.enterLabel(order[0] ?? "")).toBe("收起");
	});

	it("needs no pinned header", () => {
		const { turn } = designTurn();
		turn.summary.render(WIDTH);
		expect(turn.summary.getStickyHeaders()).toHaveLength(0);
	});
});

describe("a failure that was not fixed", () => {
	it("becomes its own red event line; a fixed one stays behind `N 步`", () => {
		const turn = quietTurn(false);
		say(turn, T0, "跑一下测试。", [{ id: "c1", command: "npx vitest --run" }]);
		turn.timeline.mergeStep("c1", "ipython", {}, { content: [{ type: "text", text: "boom" }], isError: true }, false);
		turn.state.setStepStatus("c1", "error", T0 + 1_000);
		turn.timeline.errorEnded = true;
		turn.state.markTurnEnded(T0 + 5_000);
		const lines = plain(turn.summary.render(WIDTH));
		const failed = lines.findIndex((line) => line.includes("出错"));
		expect(failed).toBeGreaterThan(0);
		expect(lines[failed]?.startsWith(` ${HH_MM(T0)}   ◆`) || lines[failed]?.startsWith("         ")).toBe(true);
		const raw = turn.summary.render(WIDTH)[failed] ?? "";
		expect(raw).toContain(theme.getFgAnsi("timelineMust"));
	});
});

describe("what the timeline says when the AI said nothing, or something went wrong", () => {
	it("sums up a message without words in its own event line", () => {
		const turn = quietTurn(false);
		say(turn, T0, undefined, [
			{ id: "c1", command: "git status" },
			{ id: "c2", command: "git diff" },
		]);
		turn.state.markTurnEnded(T0 + 5_000);
		turn.state.finishBox(T0 + 5_000);
		const first = plain(turn.summary.render(WIDTH))[0] ?? "";
		expect(first.startsWith(` ${HH_MM(T0)}   ◆`)).toBe(true);
		expect(cell(first, "跑了 2 条命令")).toBe(16);
		expect(first.trimEnd().endsWith("2 步 ▸")).toBe(true);
	});

	it("hangs the calls of a following message without words under the same event", () => {
		const turn = quietTurn(false);
		say(turn, T0, "先看一下。", [{ id: "c1", command: "git status" }]);
		say(turn, T0 + MINUTE, undefined, [{ id: "c2", command: "git diff" }]);
		turn.state.markTurnEnded(T0 + 5_000);
		turn.state.finishBox(T0 + 5_000);
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines).toHaveLength(1);
		expect(lines[0]?.trimEnd().endsWith("2 步 ▸")).toBe(true);
	});

	it("draws your interjection as a line of its own on the user's mark", () => {
		const turn = quietTurn(false);
		say(turn, T0, "先看一下。", [{ id: "c1", command: "git status" }]);
		turn.timeline.addSteer("等等，先别删文件", T0 + MINUTE);
		say(turn, T0 + 2 * MINUTE, "好，只读不写。", [{ id: "c2", command: "git diff" }]);
		turn.state.markTurnEnded(T0 + 5_000);
		turn.state.finishBox(T0 + 5_000);
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines).toHaveLength(3);
		expect(lines[1]?.startsWith(` ${HH_MM(T0 + MINUTE)}   ●`)).toBe(true);
		expect(cell(lines[1] ?? "", "你插话")).toBe(16);
		expect(lines[1]).toContain("等等，先别删文件");
	});

	it("keeps a mistake the AI fixed inside its steps, with `下一格改好了`, and hangs no red line outside", () => {
		const turn = quietTurn(false);
		say(turn, T0, "列一下目录。", [{ id: "c1", command: "ls 'src" }]);
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{ content: [{ type: "text", text: "unterminated quote" }], isError: true },
			false,
		);
		turn.state.setStepStatus("c1", "error", T0 + 1_000);
		say(turn, T0 + 2 * MINUTE, "换个写法。", [{ id: "c2", command: "ls src" }]);
		const final = assistant(T0 + 3 * MINUTE, [{ type: "text", text: "目录列好了。" }], "stop");
		turn.timeline.noteMessage(final, true);
		turn.state.markTurnEnded(T0 + 4 * MINUTE);
		turn.state.finishBox(T0 + 4 * MINUTE);
		const closed = plain(turn.summary.render(WIDTH));
		expect(closed).toHaveLength(2);
		expect(closed.join("\n")).not.toContain("出错");
		turn.summary.activate(turn.summary.getFocusOrder()[0] ?? "");
		const open = plain(turn.summary.render(WIDTH));
		const failed = open.find((line) => line.includes("✗")) ?? "";
		expect(failed.trimEnd().endsWith("下一格改好了")).toBe(true);
		const raw = turn.summary.render(WIDTH).find((line) => line.includes("下一格改好了")) ?? "";
		expect(raw).toContain(theme.getFgAnsi("timelineFix"));
	});

	it("opens an unfixed failure to its detail lines", () => {
		const turn = quietTurn(false);
		say(turn, T0, "跑一下测试。", [{ id: "c1", command: "npx vitest --run" }]);
		turn.timeline.mergeStep("c1", "ipython", {}, { content: [{ type: "text", text: "boom" }], isError: true }, false);
		turn.state.setStepStatus("c1", "error", T0 + 1_000);
		turn.timeline.errorEnded = true;
		turn.state.markTurnEnded(T0 + 5_000);
		turn.state.finishBox(T0 + 5_000);
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("出错");
		expect(lines[1]?.trimEnd().endsWith("▸")).toBe(true);
	});

	it("keeps every line within the terminal width, wide or narrow", () => {
		const { turn } = designTurn(true);
		say(
			turn,
			Date.now() - 5_000,
			undefined,
			[{ id: "c9", command: "npx vitest --run a-very-long-test-file-name.test.ts", status: "running" }],
			false,
		);
		turn.summary.render(80);
		for (const key of turn.summary.getFocusOrder().filter((entry) => entry.startsWith("ev:")))
			turn.summary.activate(key);
		for (const width of [30, 60, 100, 200]) {
			const lines = plain(turn.summary.render(width));
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(widthOf(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the lane a line was first drawn with after the agents have come back", () => {
		const { turn, tracker } = designTurn(true);
		turn.summary.render(WIDTH);
		for (const name of ["A", "B", "C", "D"]) tracker.reported(name);
		expect(tracker.active).toBe(false);
		const lines = plain(turn.summary.render(WIDTH));
		const at = lines.findIndex((line) => line.includes("趁它们干活"));
		expect(lines[at]?.slice(12, 13)).toBe("┆");
	});

	it("draws the dispatch line without a lane when no tracker was given", () => {
		const turn = quietTurn(false);
		say(turn, T0, "派个子代理。", [{ id: "c1", command: "git status" }]);
		turn.timeline.upsertSubagent(
			{ childId: "a", name: "A", label: "A 钉住框头，看它有没有钉住", status: "running" },
			T0,
		);
		turn.state.markTurnEnded(T0 + 5_000);
		turn.state.finishBox(T0 + 5_000);
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines).toHaveLength(3);
		expect(lines[1]?.startsWith("         ├")).toBe(true);
		expect(lines[1]).toContain("◇  A 钉住框头");
		expect(lines.join("\n")).not.toContain("┆");
	});
});

describe("the short tag of a subagent's task", () => {
	it("drops the name, keeps the first clause and cuts at 14 columns", () => {
		expect(subagentTaskTag("A 钉住框头，看它有没有钉住", "A")).toBe("钉住框头");
		expect(subagentTaskTag("review-box: check the fold", "review-box")).toBe("check the fold");
		const cut = subagentTaskTag("检查所有的测试文件是否都覆盖了新的时间线渲染", "B") ?? "";
		expect(cut.endsWith("…")).toBe(true);
		expect(widthOf(cut)).toBeLessThanOrEqual(14);
		expect(subagentTaskTag("", "A")).toBeUndefined();
	});
});

describe("who is out is told when the dispatch is noted, and named the way the hand-backs are", () => {
	it("tells the tracker at once, before anything is drawn, with the session name", () => {
		const turn = quietTurn(true);
		const tracker = new TimelineLaneTracker();
		turn.summary.setLaneTracker(tracker);
		say(turn, T0, "派个子代理。", [{ id: "c1", command: "git status" }]);
		turn.timeline.upsertSubagent({ childId: "a", name: "review-grow-A-box", status: "running" }, T0);
		expect(tracker.pending).toEqual(["review-grow-A-box"]);
		turn.timeline.upsertSubagent({ childId: "a", name: "review-grow-A-box", status: "running", line: "在执行" }, T0);
		expect(tracker.pending).toEqual(["review-grow-A-box"]);
		tracker.reported("review-grow-A-box");
		turn.timeline.upsertSubagent({ childId: "a", name: "review-grow-A-box", status: "done" }, T0);
		expect(tracker.active).toBe(false);
	});

	it("takes up the subagents a turn already waits on when the tracker arrives later", () => {
		const turn = quietTurn(true);
		say(turn, T0, "派个子代理。", [{ id: "c1", command: "git status" }]);
		turn.timeline.upsertSubagent({ childId: "a", name: "helper-one", status: "running" }, T0);
		turn.timeline.upsertSubagent({ childId: "b", name: "helper-two", status: "done" }, T0);
		const tracker = new TimelineLaneTracker();
		turn.summary.setLaneTracker(tracker);
		expect(tracker.pending).toEqual(["helper-one"]);
	});

	it("reads `review-grow-B-box` as `B` on the dispatch line and in who is still out", () => {
		const turn = quietTurn(true);
		const tracker = new TimelineLaneTracker();
		turn.summary.setLaneTracker(tracker);
		say(turn, T0, "派两个。", [{ id: "c1", command: "git status" }]);
		turn.timeline.upsertSubagent(
			{ childId: "a", name: "review-grow-A-box", label: "review-grow-A-box 钉住框头", status: "running" },
			T0,
		);
		turn.timeline.upsertSubagent({ childId: "b", name: "tester", status: "running" }, T0);
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines.join("\n")).toContain("◇  A 钉住框头   tester");
		expect(lines.at(-1)?.trimEnd().endsWith("A、tester 还在干活")).toBe(true);
	});

	it("shortens a name only when it has exactly one single-letter part", () => {
		expect(shortAgentName("review-grow-B-box")).toBe("B");
		expect(shortAgentName("a")).toBe("A");
		expect(shortAgentName("review-a-b")).toBe("review-a-b");
		expect(shortAgentName("tester")).toBe("tester");
	});

	it("leaves no blank rail row after the last event: the block below draws its own", () => {
		const { turn, tracker } = designTurn();
		expect(tracker.active).toBe(true);
		const lines = plain(turn.summary.render(WIDTH));
		expect(lines.at(-1)?.trim()).not.toBe("│");
		expect(lines.at(-1)).toContain("趁它们干活");
	});
});

describe("long words and empty turns", () => {
	it("opens a cut sentence to its whole text and shows no arrow on one that fits", () => {
		const turn = quietTurn(false);
		const long = `${"这一句话很长很长，".repeat(12)}到这里才结束。`;
		say(turn, T0, long, []);
		say(turn, T0 + MINUTE, "很短。", [{ id: "c1", command: "git status" }]);
		turn.state.markTurnEnded(T0 + 5_000);
		turn.state.finishBox(T0 + 5_000);
		const folded = plain(turn.summary.render(80));
		expect(folded[0]?.trimEnd().endsWith("…  ▸") || folded[0]?.trimEnd().endsWith("▸")).toBe(true);
		expect(folded.join("\n")).not.toContain("到这里才结束");
		turn.summary.activate(turn.summary.getFocusOrder()[0] ?? "");
		expect(plain(turn.summary.render(80)).join("").replace(/\s+/g, "")).toContain("到这里才结束");
		expect(folded[1]?.includes("很短。")).toBe(true);
		expect(folded[1]?.trimEnd().endsWith("1 步 ▸")).toBe(true);
	});

	it("draws nothing at all for a woken turn that has nothing to list", () => {
		const turn = quietTurn(false);
		turn.summary.setLeadingRows(1);
		turn.state.markTurnEnded(T0);
		expect(turn.summary.render(WIDTH)).toEqual([]);
	});

	it("makes a click on an open event's line ask the window for nothing", () => {
		const { turn } = designTurn();
		turn.summary.render(WIDTH);
		const region = () => turn.summary.getClickRegions().find((candidate) => candidate.line === 0);
		expect(region()?.revealBelow).toBeGreaterThan(0);
		turn.summary.activate(turn.summary.getFocusOrder()[0] ?? "");
		turn.summary.render(WIDTH);
		expect(region()?.revealBelow ?? 0).toBe(0);
	});

	it("puts the block-navigation key hint on the first line by giving up its count", () => {
		const { turn } = designTurn();
		turn.summary.setBlockFocus({ reveal: false, toggleLabel: "展开" });
		const first = plain(turn.summary.render(WIDTH))[0] ?? "";
		expect(first).toContain("Enter 展开");
		expect(first).not.toContain("步 ▸");
		turn.summary.setBlockFocus(undefined);
		expect(plain(turn.summary.render(WIDTH))[0]).toContain("2 步 ▸");
	});

	it("tells the host when an event is opened by a click or by Enter", () => {
		const { turn } = designTurn();
		const told = vi.fn();
		turn.summary.setOnLanesChange(told);
		turn.summary.render(WIDTH);
		clickAt(turn.summary.getClickRegions(), 0);
		expect(told).toHaveBeenCalledTimes(1);
		turn.summary.render(WIDTH);
		turn.summary.activate(turn.summary.getFocusOrder()[0] ?? "");
		expect(told).toHaveBeenCalledTimes(2);
	});
});

describe("the blank row above the live tail follows the lane as it is now", () => {
	it("draws `┆` there once agents are dispatched, though the tail was drawn before", () => {
		const turn = quietTurn(true);
		const tracker = new TimelineLaneTracker();
		turn.summary.setLaneTracker(tracker);
		say(turn, T0, "先看一下。", [{ id: "c1", command: "git status" }]);
		const spinRow = (lines: string[]) => lines.findIndex((line) => /^ \d\d:\d\d {3}[⠀-⣿]/.test(line));
		const before = plain(turn.summary.render(WIDTH));
		expect(before[spinRow(before) - 1]?.trimEnd()).toBe("         │");
		turn.timeline.upsertSubagent({ childId: "a", name: "A", status: "running" }, T0 + MINUTE);
		say(turn, Date.now() - 5_000, "趁它们干活。", [{ id: "c2", command: "git diff", status: "running" }], false);
		const after = plain(turn.summary.render(WIDTH));
		expect(after[spinRow(after) - 1]?.trimEnd()).toBe("         │  ┆");
		tracker.reported("A");
		const done = plain(turn.summary.render(WIDTH));
		expect(done[spinRow(done) - 1]?.trimEnd()).toBe("         │");
	});
});

describe("a line's lane comes from where it sits relative to the dispatch", () => {
	function dispatchTurn(options: { handedBack: boolean }) {
		const turn = quietTurn(false);
		const tracker = new TimelineLaneTracker();
		turn.summary.setLaneTracker(tracker);
		say(turn, T0, "先看最近的提交。", [{ id: "c1", command: "git log" }]);
		say(turn, T0 + MINUTE, "派两个代理。", [{ id: "c2", command: "git branch" }]);
		turn.timeline.upsertSubagent({ childId: "a", name: "A", label: "A 任务", status: "running" }, T0 + MINUTE);
		turn.timeline.upsertSubagent({ childId: "b", name: "B", label: "B 任务", status: "running" }, T0 + MINUTE);
		say(turn, T0 + 2 * MINUTE, "趁它们干活，我自己检查。", [{ id: "c3", command: "npx tsgo" }]);
		if (options.handedBack) {
			turn.timeline.upsertSubagent({ childId: "a", name: "A", status: "done" }, T0 + 4 * MINUTE);
			turn.timeline.upsertSubagent({ childId: "b", name: "B", status: "done" }, T0 + 5 * MINUTE);
			tracker.reported("A");
			tracker.reported("B");
		}
		say(turn, T0 + 6 * MINUTE, "都回来了，收尾。", [{ id: "c4", command: "git status" }]);
		turn.state.markTurnEnded(T0 + 7 * MINUTE);
		turn.state.finishBox(T0 + 7 * MINUTE);
		return { turn, tracker };
	}
	const laneOf = (lines: string[], needle: string) => lines.find((line) => line.includes(needle))?.slice(12, 13);

	it("keeps `┆` off the lines above the dispatch when the first frame is drawn after it", () => {
		const { turn, tracker } = dispatchTurn({ handedBack: false });
		expect(tracker.active).toBe(true);
		const lines = plain(turn.summary.render(WIDTH));
		expect(laneOf(lines, "先看最近的提交")).toBe(" ");
		expect(laneOf(lines, "派两个代理")).toBe(" ");
		const split = lines.findIndex((line) => line.includes("├──╮"));
		expect(lines[split + 1]?.trimEnd()).toBe("         │  ┆");
		expect(laneOf(lines, "趁它们干活")).toBe("┆");
	});

	it("draws `┆` between the dispatch and the hand-back when a finished turn is drawn for the first time", () => {
		const { turn, tracker } = dispatchTurn({ handedBack: true });
		expect(tracker.active).toBe(false);
		const lines = plain(turn.summary.render(WIDTH));
		expect(laneOf(lines, "先看最近的提交")).toBe(" ");
		expect(laneOf(lines, "派两个代理")).toBe(" ");
		const split = lines.findIndex((line) => line.includes("├──╮"));
		expect(lines[split + 1]?.trimEnd()).toBe("         │  ┆");
		expect(laneOf(lines, "趁它们干活")).toBe("┆");
		expect(laneOf(lines, "都回来了")).toBe(" ");
	});

	it("keeps a turn's lane the same when it is drawn again after the agents come back", () => {
		const { turn, tracker } = dispatchTurn({ handedBack: false });
		const first = plain(turn.summary.render(WIDTH));
		turn.timeline.upsertSubagent({ childId: "a", name: "A", status: "done" }, T0 + 4 * MINUTE);
		turn.timeline.upsertSubagent({ childId: "b", name: "B", status: "done" }, T0 + 5 * MINUTE);
		tracker.reported("A");
		tracker.reported("B");
		const second = plain(turn.summary.render(WIDTH));
		expect(second).toEqual(first);
	});

	it("starts a woken turn in the lane its tracker was in when the turn began", () => {
		const tracker = new TimelineLaneTracker();
		tracker.spawned(["Z"]);
		const turn = quietTurn(false);
		turn.summary.setLaneTracker(tracker);
		say(turn, T0, "顺手看一下。", [{ id: "c1", command: "git log" }]);
		turn.state.markTurnEnded(T0 + 5_000);
		turn.state.finishBox(T0 + 5_000);
		expect(laneOf(plain(turn.summary.render(WIDTH)), "顺手看一下")).toBe("┆");
		tracker.reported("Z");
		expect(laneOf(plain(turn.summary.render(WIDTH)), "顺手看一下")).toBe("┆");
	});
});

describe("a failing step's status reads like the design's `4 个失败  38秒`", () => {
	function failingTurn(endedAfterMs: number) {
		const turn = quietTurn(false);
		say(turn, T0, "跑测试。", [{ id: "c1", command: "npx vitest --run" }]);
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
							label: "npx vitest --run",
							status: "error",
							detail: "10 passed, 4 failed in 38s",
							startedAt: T0,
							endedAt: T0 + endedAfterMs,
						},
					],
				},
			},
			false,
		);
		const final = assistant(T0 + MINUTE, [{ type: "text", text: "四个失败。" }], "stop");
		turn.timeline.noteMessage(final, true);
		turn.state.markTurnEnded(T0 + MINUTE);
		turn.state.finishBox(T0 + MINUTE);
		turn.summary.render(WIDTH);
		turn.summary.activate(turn.summary.getFocusOrder()[0] ?? "");
		return turn;
	}

	it("puts the result and the time in one red, two spaces apart, with no mark", () => {
		const turn = failingTurn(38_000);
		const raw = turn.summary.render(WIDTH).find((line) => line.includes("npx vitest --run")) ?? "";
		const text = stripAnsi(raw);
		expect(text.endsWith("10 通过 · 4 失败  38秒    ")).toBe(true);
		expect(text).not.toContain("✗");
		expect(raw).toContain(`${theme.getFgAnsi("timelineMust")}10 通过 · 4 失败  38秒`);
	});

	it("leaves the time out when the step took less than a second", () => {
		const turn = failingTurn(400);
		const text = plain(turn.summary.render(WIDTH)).find((line) => line.includes("npx vitest --run")) ?? "";
		expect(text.endsWith("10 通过 · 4 失败    ")).toBe(true);
	});
});

describe("a row's one-line summary is looked for in the first 400 characters", () => {
	it("cuts the summary of a very long note and of a very long thought there", () => {
		const turn = quietTurn(false);
		const note = "没有句号的一大段话".repeat(2_000);
		turn.timeline.noteMessage(
			assistant(T0, [
				{ type: "thinking", thinking: note },
				{ type: "text", text: note },
				{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "r = await bash('git log')" } },
			]),
			true,
		);
		turn.state.addStep({
			toolCallId: "c1",
			toolName: "ipython",
			args: { code: "r = await bash('git log')" },
			status: "queued",
		});
		turn.state.setStepStatus("c1", "done", T0 + 1_000);
		const rows = turn.state.boxView().rows;
		const say = rows.find((row) => row.kind === "say");
		const think = rows.find((row) => row.kind === "think");
		expect(say?.text.length).toBeGreaterThan(0);
		expect(say?.text.length).toBeLessThanOrEqual(400);
		expect(think?.text.length).toBeGreaterThan(0);
		expect(think?.text.length).toBeLessThanOrEqual(400);
		// Nothing is lost: the whole words are still there to open.
		expect(say?.fullText?.length).toBe(note.length);
		const event = turn.state.boxView().events[0];
		expect(event?.full?.length).toBe(note.length);
		expect(event?.more).toBe(true);
	});
});
