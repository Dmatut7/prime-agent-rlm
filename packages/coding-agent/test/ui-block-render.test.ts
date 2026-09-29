import { type ClickRegion, setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { type ThemeBg, type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";
import {
	addActivities,
	addCommand,
	addSay,
	addStep,
	addThought,
	assistant,
	bgAsFg,
	hasBg,
	hasFg,
	lineIndexWith,
	plain,
	type QuietTurn,
	quietTurn,
	rawLineWith,
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

const WIDTH = 100;
const INNER = WIDTH - 1 - 4;

function regionsOn(turn: QuietTurn, line: number): ClickRegion[] {
	return turn.summary.getClickRegions().filter((region) => region.line === line);
}

function clickableOn(turn: QuietTurn, line: number): ClickRegion | undefined {
	return regionsOn(turn, line).find((region) => !region.passive);
}

/** A box with one step of a kind, and the line its block sits on. */
interface KindCase {
	name: string;
	needle: string;
	bg: ThemeBg;
	fg?: ThemeColor;
	build: (turn: QuietTurn) => void;
}

const KIND_CASES: KindCase[] = [
	{
		name: "a thought",
		needle: "先看日志",
		bg: "kindThinkBg",
		fg: "kindThink",
		build: (turn) => addThought(turn, "先看日志。再看代码，还有很多话要说。"),
	},
	{
		name: "a command",
		needle: "$ git status",
		bg: "kindCommandBg",
		fg: "kindCommand",
		build: (turn) => addCommand(turn, "c1", "git status"),
	},
	{
		name: "a file read",
		needle: "读取 README.md",
		bg: "kindReadBg",
		fg: "kindRead",
		build: (turn) =>
			addActivities(turn, "r1", [{ id: "a", kind: "read", label: "README.md", status: "ok", startedAt: 1 }]),
	},
	{
		name: "a general step",
		needle: "搜索 foo bar",
		bg: "kindReadBg",
		fg: "kindRead",
		build: (turn) =>
			addActivities(turn, "s1", [
				{ id: "a", kind: "search", label: "foo bar", status: "ok", startedAt: 1, detail: "3 条" },
			]),
	},
	{
		name: "a changed file",
		needle: "a.go",
		bg: "kindEditBg",
		fg: "kindEdit",
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
		fg: "kindMemory",
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
		needle: "子代理 审查员·Go",
		bg: "kindSubagentBg",
		fg: "kindSubagent",
		build: (turn) =>
			turn.timeline.upsertSubagent({ childId: "c1", name: "审查员·Go", status: "done", result: "发现 1 处问题" }),
	},
	{
		name: "a failed command",
		needle: "$ make build",
		bg: "kindErrorBg",
		fg: "kindError",
		build: (turn) => addCommand(turn, "c1", "make build", { ok: false, detail: "exit code 2" }),
	},
	{
		name: "a cell that raised",
		needle: "出错：FileNotFoundError",
		bg: "kindErrorBg",
		fg: "kindError",
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
		name: "a retry",
		needle: "模型接口超时",
		bg: "customMessageBg",
		fg: "kindRecovered",
		build: (turn) => {
			turn.timeline.startRetry({ startedAt: Date.now(), delayMs: 3_000, attempt: 1, reason: "模型接口超时" });
		},
	},
	{
		name: "a compaction",
		needle: "整理完成",
		bg: "customMessageBg",
		build: (turn) => {
			turn.timeline.startCompaction(Date.now() - 2_000, 182_000);
			turn.timeline.endCompaction(Date.now(), { before: 182_000 });
		},
	},
	{
		name: "a notice",
		needle: "做完了，没发回消息",
		bg: "customMessageBg",
		build: (turn) => {
			turn.timeline.addNotice({ tone: "muted", text: "子代理 审查员 做完了，没发回消息" }, Date.now());
		},
	},
];

describe("every step is a block in its kind's color", () => {
	it("gives each kind its own background and lays a separator row under it", () => {
		expect(KIND_CASES.length).toBeGreaterThan(0);
		for (const testCase of KIND_CASES) {
			setMotionReduced(true);
			const turn = quietTurn();
			testCase.build(turn);
			const lines = turn.summary.render(WIDTH);
			const at = lineIndexWith(lines, testCase.needle);
			expect(at, `${testCase.name} is drawn`).toBeGreaterThan(0);
			const block = lines[at] ?? "";
			expect(hasBg(block, testCase.bg), `${testCase.name} background`).toBe(true);
			if (testCase.fg) expect(hasFg(block, testCase.fg), `${testCase.name} glyph color`).toBe(true);
			const separator = lines[at + 1] ?? "";
			expect(plain([separator])[0], `${testCase.name} separator`).toBe(` │ ${"▀".repeat(INNER)} │`);
			expect(separator.includes(bgAsFg(testCase.bg)), `${testCase.name} separator color`).toBe(true);
			expect(hasBg(separator, testCase.bg), `${testCase.name} separator has no fill`).toBe(false);
		}
	});

	it("indents the block one column inside the frame and puts the result at its right edge", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addCommand(turn, "c1", "git log --stat -100", { detail: "100 次提交", output: "abc123 fix" });
		const lines = turn.summary.render(WIDTH);
		const at = lineIndexWith(lines, "$ git log --stat -100");
		expect(plain(lines)[at]).toMatch(/^ │ {2}▸ \$ git log --stat -100 +✓ 100 次提交 {2}│$/);
		const block = lines[at] ?? "";
		expect(block).toContain(theme.bold(theme.fg("kindCommand", "$")));
	});

	it("draws the caret in a bright color, not the dim one", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean" });
		const block = rawLineWith(turn.summary.render(WIDTH), "$ git status");
		expect(block).toContain(theme.fg("activityText", "▸"));
		expect(block).not.toContain(theme.fg("dim", "▸"));
	});

	it("keeps a running step's spinner in its kind's color", () => {
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
		const block = rawLineWith(turn.summary.render(WIDTH), "npm test  ");
		expect(hasFg(block, "kindCommand")).toBe(true);
		expect(hasBg(block, "kindCommandBg")).toBe(true);
	});

	it("still makes a block of a row with nothing to open, but a block that cannot be clicked", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addActivities(turn, "r1", [{ id: "a", kind: "read", label: "README.md", status: "ok", startedAt: 1 }]);
		const lines = turn.summary.render(WIDTH);
		const at = lineIndexWith(lines, "读取 README.md");
		expect(hasBg(lines[at] ?? "", "kindReadBg")).toBe(true);
		expect(plain(lines)[at]).not.toContain("▸");
		expect(clickableOn(turn, at)).toBeUndefined();
		expect(clickableOn(turn, at + 1)).toBeUndefined();
	});
});

describe("what hangs under a block", () => {
	it("shows an opened step's lines on the panel color with the kind's bar, before the separator", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addCommand(turn, "c1", "git log --stat -100", { output: "first line\nsecond line" });
		turn.timeline.ui.toggleRow("act:c1:c1-a");
		const lines = turn.summary.render(WIDTH);
		const at = lineIndexWith(lines, "$ git log --stat -100");
		const shown = plain(lines);
		expect(shown[at]).toContain("▾");
		expect(hasBg(lines[at] ?? "", "kindCommandHoverBg")).toBe(true);
		for (const [offset, expected] of ["first line", "second line"].entries()) {
			const panel = lines[at + 1 + offset] ?? "";
			expect(shown[at + 1 + offset]).toMatch(new RegExp(`^ │ ▎ {4}${expected} +│$`));
			expect(hasBg(panel, "kindPanelBg")).toBe(true);
			expect(panel).toContain(theme.fg("kindCommand", "▎"));
		}
		const separator = lines[at + 3] ?? "";
		expect(shown[at + 3]).toBe(` │ ${"▀".repeat(INNER)} │`);
		expect(separator.includes(bgAsFg("kindPanelBg"))).toBe(true);
		expect(clickableOn(turn, at)).toBeDefined();
		expect(clickableOn(turn, at + 1)).toBeUndefined();
		expect(clickableOn(turn, at + 2)).toBeUndefined();
	});

	it("makes the separator row part of the block's click area", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addCommand(turn, "c1", "git status", { output: "clean" });
		const lines = turn.summary.render(WIDTH);
		const at = lineIndexWith(lines, "$ git status");
		const head = clickableOn(turn, at);
		const gap = clickableOn(turn, at + 1);
		expect(head).toBeDefined();
		expect(gap).toBeDefined();
		gap?.onClick({ row: 0, col: 0 });
		expect(turn.timeline.ui.expanded.has("act:c1:c1-a")).toBe(true);
	});

	it("keeps the panel color behind a diff line whose own tint ends inside the line", () => {
		setMotionReduced(true);
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
		turn.summary.render(WIDTH);
		const key = turn.summary.getFocusOrder().find((entry) => entry.startsWith("file:"));
		expect(key).toBeDefined();
		turn.timeline.ui.toggleRow(key ?? "");
		const lines = turn.summary.render(WIDTH);
		const added = lines.find((line) => plain([line])[0]?.includes("new()")) ?? "";
		expect(added).toBeTruthy();
		const tint = theme.getBgAnsi("diffAddedLineBg");
		const panel = theme.getBgAnsi("kindPanelBg");
		expect(added).toContain(tint);
		// After the tinted segment the panel color is put back for the rest of the line.
		expect(added.lastIndexOf(panel)).toBeGreaterThan(added.indexOf(tint));
	});

	it("hangs a running command's latest output under its block", () => {
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
		const lines = turn.summary.render(WIDTH);
		const at = lineIndexWith(lines, "└ === RUN TestRetry");
		expect(plain(lines)[at]).toMatch(/^ │ ▎ {4}└ === RUN TestRetry +│$/);
		expect(hasBg(lines[at] ?? "", "kindPanelBg")).toBe(true);
		expect(clickableOn(turn, at)).toBeUndefined();
		expect(plain(lines)[at + 1]).toBe(` │ ${"▀".repeat(INNER)} │`);
		expect(lines[at + 1]?.includes(bgAsFg("kindPanelBg"))).toBe(true);
	});

	it("hangs the live thought's three-line window under its block", () => {
		const turn = quietTurn();
		turn.timeline.noteMessage(assistant(Date.now(), [{ type: "thinking", thinking: "先看测试为什么挂。" }]), false);
		const lines = turn.summary.render(WIDTH);
		const shown = plain(lines);
		const windowLines = shown.map((line, index) => ({ line, index })).filter(({ line }) => /^ │ ▎ {4}/.test(line));
		expect(windowLines).toHaveLength(3);
		for (const { index } of windowLines) {
			expect(hasBg(lines[index] ?? "", "kindPanelBg")).toBe(true);
			expect(clickableOn(turn, index)).toBeUndefined();
		}
		expect(windowLines.at(-1)?.line).toContain("先看测试为什么挂");
	});
});

describe("a short note is text, not a block", () => {
	it("shows a short note whole and muted, lined up with a block's text, with nothing to click", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addSay(turn, "趁等待，查一个风险点。", "s1");
		const lines = turn.summary.render(WIDTH);
		const at = lineIndexWith(lines, "趁等待，查一个风险点。");
		expect(at).toBeGreaterThan(0);
		expect(plain(lines)[at]).toMatch(/^ │ {6}趁等待，查一个风险点。 +│$/);
		expect(lines[at]).toContain(theme.fg("muted", "趁等待，查一个风险点。"));
		expect(lines[at]).not.toContain("\x1b[48;");
		expect(plain(lines)[at]).not.toContain("▸");
		expect(clickableOn(turn, at)).toBeUndefined();
		// No separator row after a note: the next line is the following block, not a row of ▀.
		expect(plain(lines)[at + 1]).not.toContain("▀");
	});

	it("wraps a note of up to three lines whole instead of cutting it", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		const words = "一二三四五六七八九十".repeat(6);
		addSay(turn, words, "s1");
		const lines = turn.summary.render(60);
		const shown = plain(lines).filter((line) => /^ │ {6}\S/.test(line));
		expect(shown.length).toBeGreaterThan(1);
		expect(shown.length).toBeLessThanOrEqual(3);
		expect(shown.map((line) => line.replace(/^ │ +| +│$/g, "")).join("")).toBe(words);
		expect(shown.some((line) => line.includes("…"))).toBe(false);
	});

	it("draws a note that needs more than three lines as a neutral block that opens to the whole text", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		const first = "先说第一句。";
		const rest = "后面还有很多很多话，".repeat(12);
		addSay(turn, first + rest, "s1");
		const closed = turn.summary.render(60);
		const at = lineIndexWith(closed, "先说第一句");
		expect(hasBg(closed[at] ?? "", "customMessageBg")).toBe(true);
		expect(plain(closed)[at]).toContain("▸");
		expect(plain(closed).join("\n")).not.toContain("后面还有很多很多话，后面还有很多很多话，后面还有很多很多话");
		const region = clickableOn(turn, at);
		expect(region).toBeDefined();
		region?.onClick({ row: 0, col: 0 });
		const opened = plain(turn.summary.render(60))
			.join("\n")
			.replace(/\s*│\s*\n\s*│\s*▎\s*/g, "");
		expect(opened).toContain(rest.slice(0, 20));
		expect(plain(turn.summary.render(60)).join("\n")).toContain("▎");
	});

	it("shows a short interjection as plain text and a long one as a block", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		turn.timeline.addSteer("先别动安卓的，只升级 Go", Date.now());
		const short = turn.summary.render(WIDTH);
		const at = lineIndexWith(short, "你插话：先别动安卓的，只升级 Go");
		expect(at).toBeGreaterThan(0);
		expect(plain(short)[at]).not.toContain("▸");
		expect(clickableOn(turn, at)).toBeUndefined();

		const longTurn = quietTurn();
		longTurn.timeline.addSteer(
			"这一条插话很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长",
			Date.now(),
		);
		const long = longTurn.summary.render(60);
		const longAt = lineIndexWith(long, "你插话：");
		expect(hasBg(long[longAt] ?? "", "customMessageBg")).toBe(true);
		expect(clickableOn(longTurn, longAt)).toBeDefined();
	});

	it("leaves a note out of the keyboard walk and keeps blocks in it", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addSay(turn, "趁等待，查一个风险点。", "s1");
		addCommand(turn, "c1", "git status", { output: "clean" });
		turn.summary.render(WIDTH);
		const order = turn.summary.getFocusOrder();
		expect(order.some((key) => key.startsWith("say:"))).toBe(false);
		expect(order).toContain("act:c1:c1-a");
	});
});
