import { ABORT_TRUNCATION_MARKER, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { renderStatusBar } from "../src/modes/interactive/components/footer.js";
import { rowEnterStage, setMotionReduced, TURN_FOLD_MS } from "../src/modes/interactive/components/motion.js";
import { formatTimelineTime } from "../src/modes/interactive/components/timeline-gutter.js";
import { commandOutcome, type TimelineFacts } from "../src/modes/interactive/components/timeline-rows.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { BOX_FOCUS_MARKER } from "../src/modes/interactive/components/turn-box.js";
import { TurnBoxNavigator } from "../src/modes/interactive/components/turn-box-navigator.js";
import { STRIP_ALL, STRIP_EDITS, TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { formatBoxDuration, TurnTimeline } from "../src/modes/interactive/components/turn-timeline.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { setWorkingPulseTick } from "../src/modes/interactive/theme/working-icon.js";

const T0 = 1_700_000_000_000;

function usage(output: number): AssistantMessage["usage"] {
	return {
		input: 0,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	timestamp: number,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
	output = 0,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: usage(output),
		stopReason,
		timestamp,
	};
}

function host(overrides: Partial<TimelineHost> = {}): TimelineHost {
	return {
		cwd: () => "/work/app",
		viewportRows: () => 40,
		openWhileWorking: () => true,
		autoFold: () => true,
		requestRender: vi.fn(),
		...overrides,
	};
}

/** A quiet turn with its timeline, the way the interactive mode builds one. */
function quietTurn(options: { live?: boolean; host?: TimelineHost; startedAt?: number } = {}) {
	const state = new TurnActivityState(options.startedAt ?? Date.now() - 5_000);
	if (options.live !== false) state.live = true;
	state.modelId = "glm-5.3-prime";
	const summary = new TurnSummaryComponent(state);
	summary.setTimelineHost(options.host ?? host());
	summary.setQuiet(true);
	return { state, summary, timeline: state.timeline };
}

/** One tool call inside an assistant message, registered on the turn. */
function addStep(
	turn: ReturnType<typeof quietTurn>,
	id: string,
	code: string,
	status: "queued" | "running" | "done" | "error" = "done",
	timestamp = Date.now() - 4_000,
): void {
	turn.timeline.noteMessage(
		assistant(timestamp, [{ type: "toolCall", id, name: "ipython", arguments: { code } }]),
		status !== "running" && status !== "queued",
	);
	turn.state.addStep({ toolCallId: id, toolName: "ipython", args: { code }, status: "queued" });
	if (status !== "queued") turn.state.setStepStatus(id, "running", timestamp);
	if (status === "done" || status === "error") turn.state.setStepStatus(id, status, timestamp + 500);
}

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));
const text = (lines: readonly string[]) => plain(lines).join("\n");

/** Open every event that lists steps (a click on each event line), and give the lines. */
function openEvents(turn: { summary: TurnSummaryComponent }, width = 120): string[] {
	turn.summary.render(width);
	for (const key of turn.summary.getFocusOrder()) {
		if (key.startsWith("ev:") && turn.summary.enterLabel(key) === "展开") turn.summary.activate(key);
	}
	return plain(turn.summary.render(width));
}

/** Click the line that has `needle` on it. */
function click(summary: TurnSummaryComponent, needle: string, width = 120): void {
	const index = plain(summary.render(width)).findIndex((line) => line.includes(needle));
	const region = summary.getClickRegions().find((candidate) => candidate.line === index);
	expect(region, needle).toBeDefined();
	region?.onClick({ row: index, col: 0 });
}

/** The line the spinner is on: what the AI is at while the turn runs. */
const spinnerLine = (lines: readonly string[]) => lines.find((line) => /^ \d\d:\d\d {3}[⠀-⣿]/.test(line)) ?? "";

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
	setWorkingPulseTick(0);
	vi.useRealTimers();
});

describe("timeline steps from the kernel's records", () => {
	it("shows a command as a $ step: spinner and own clock while running, the result once done", () => {
		const turn = quietTurn();
		addStep(turn, "c1", "r = await bash('go test ./...')", "running");
		const startedAt = Date.now() - 3_000;
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
							label: "go test ./...",
							status: "running",
							detail: "=== RUN TestTimeoutRetry",
							startedAt,
						},
					],
				},
			},
			true,
		);
		const live = openEvents(turn);
		expect(live.some((line) => /^ {9}│ {11}[⠀-⣿] {2}go test \.\/\.\.\. +[23]秒 {4}$/.test(line))).toBe(true);
		expect(spinnerLine(live)).toContain("正在运行命令");
		expect(live.some((line) => /^ {9}╎ {11}在跑 {2}go test \.\/\.\.\. +[23]秒 {4}$/.test(line))).toBe(true);

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
							label: "go test ./...",
							status: "error",
							detail: "54 passed, 2 failed",
							startedAt,
							endedAt: startedAt + 3_200,
						},
					],
					stdout: "--- FAIL: TestTimeoutRetry (2.00s)",
				},
			},
			false,
		);
		turn.state.setStepStatus("c1", "done");
		const done = openEvents(turn);
		expect(done.some((line) => /^ {9}│ {11}\$ {2}go test \.\/\.\.\. +54 通过 · 2 失败 {2}3秒 {4}$/.test(line))).toBe(
			true,
		);
		expect(done.join("\n")).not.toContain("=== RUN");
		// The finished step opens to what the cell printed, not to the line it showed while running.
		click(turn.summary, "go test ./...");
		const opened = text(turn.summary.render(120));
		expect(opened).toContain("--- FAIL: TestTimeoutRetry (2.00s)");
		expect(opened).not.toContain("=== RUN");
	});

	it("reads consecutive file reads as one step that counts while it runs", () => {
		const turn = quietTurn();
		addStep(turn, "r1", "for p in files: print(open(p).read())", "running");
		const at = Date.now() - 2_000;
		const read = (id: string, label: string, status: "running" | "ok", offset: number) => ({
			id,
			kind: "read" as const,
			label,
			status,
			startedAt: at + offset,
		});
		turn.timeline.mergeStep(
			"r1",
			"ipython",
			{},
			{
				details: {
					activities: [
						read("1", "AGENTS.md", "ok", 0),
						read("2", "a.go", "ok", 10),
						read("3", "b.go", "running", 20),
					],
				},
			},
			true,
		);
		const live = openEvents(turn);
		expect(live.some((line) => /^ {9}│ {11}[⠀-⣿] {2}正在读取 b\.go（第 3 个）/.test(line))).toBe(true);
		expect(live[0]).toContain("读了 3 个文件");
		turn.timeline.mergeStep(
			"r1",
			"ipython",
			{},
			{
				details: {
					activities: [read("1", "AGENTS.md", "ok", 0), read("2", "a.go", "ok", 10), read("3", "b.go", "ok", 20)],
				},
			},
			false,
		);
		turn.state.setStepStatus("r1", "done");
		const done = openEvents(turn);
		const reads = done.filter((line) => line.includes("读取"));
		expect(reads).toHaveLength(1);
		expect(reads[0]?.trimEnd()).toBe("         │           ✓  读取了 3 个文件");
	});

	it("turns file and memory records into ✎ and ✦ steps with counts and clean titles", () => {
		const turn = quietTurn();
		addStep(turn, "e1", "edit(...)");
		turn.timeline.mergeStep(
			"e1",
			"ipython",
			{},
			{
				details: {
					fileChanges: [
						{
							path: "/work/app/modules/aichat/client.go",
							relPath: "modules/aichat/client.go",
							kind: "modified",
							scope: "project",
							added: 12,
							removed: 4,
							source: "edit",
							at: 1,
						},
						{
							path: "/tmp/probe.py",
							kind: "created",
							scope: "scratch",
							added: 9,
							removed: 0,
							source: "python",
							at: 2,
						},
					],
					memoryChanges: [
						{
							op: "created",
							kind: "memory",
							scope: "session",
							title: "go_http_请求要带_context_2026-09-28",
							after: "带上 context。",
							at: 3,
						},
					],
				},
			},
			false,
		);
		const lines = openEvents(turn);
		expect(lines.some((line) => /^ {9}│ {11}✎ {2}modules\/aichat\/client\.go\s+\+12 −4 {4}$/.test(line))).toBe(true);
		expect(lines.some((line) => /^ {9}│ {11}✎ {2}\/tmp\/probe\.py\s+临时 \+9 {4}$/.test(line))).toBe(true);
		const out = lines.join("\n");
		expect(out).toContain("✦  记住：go http 请求要带 context");
		expect(out).not.toContain("_2026");
	});

	it("marks a change another window or process made as 工作区, keeping the session's own rows bare", () => {
		const turn = quietTurn();
		addStep(turn, "e1", "edit(...)");
		turn.timeline.mergeStep(
			"e1",
			"ipython",
			{},
			{
				details: {
					fileChanges: [
						{
							path: "/work/app/modules/aichat/client.go",
							relPath: "modules/aichat/client.go",
							kind: "modified",
							scope: "project",
							added: 12,
							removed: 4,
							source: "edit",
							at: 1,
						},
						{
							path: "/work/app/notes.md",
							relPath: "notes.md",
							kind: "modified",
							scope: "project",
							added: 3,
							removed: 1,
							source: "shell",
							origin: "ambient",
							at: 2,
						},
					],
				},
			},
			false,
		);
		const lines = openEvents(turn);
		// The session's own row stays bare; the ambient one carries the marker the change
		// strip splits out as 「工作区另有 N 个变动」.
		expect(lines.some((line) => /^ {9}│ {11}✎ {2}modules\/aichat\/client\.go\s+\+12 −4 {4}$/.test(line))).toBe(true);
		expect(lines.some((line) => /^ {9}│ {11}✎ {2}notes\.md\s+工作区 \+3 −1 {4}$/.test(line))).toBe(true);
	});
});

describe("timeline rows without kernel records (today's data)", () => {
	it("reads a printed BashResult as the command's outcome, not its repr", () => {
		expect(commandOutcome("BashResult(exit_code=0, output='..\\n2 passed in 0.01s\\n', duration=4.0)")).toEqual({
			ok: true,
			result: "2 通过",
		});
		expect(commandOutcome("BashResult(exit_code=1, output='boom\\n', duration=0.2)")).toEqual({
			ok: false,
			result: "退出码 1",
		});
		expect(
			commandOutcome('BashResult(exit_code=1, output="it\'s\\n1 passed, 2 failed in 0.3s", duration=1.0)'),
		).toEqual({
			ok: false,
			result: "1 通过 · 2 失败",
		});
		expect(commandOutcome("done\n")).toEqual({ ok: true, result: "done" });
	});

	it("says a cell still streaming in is being written, not running", () => {
		const turn = quietTurn();
		turn.timeline.noteMessage(
			assistant(Date.now() - 1_000, [
				{ type: "toolCall", id: "w1", name: "ipython", arguments: { code: "await ed" } },
			]),
			false,
		);
		turn.state.addStep({ toolCallId: "w1", toolName: "ipython", args: { code: "await ed" }, status: "queued" });
		const lines = openEvents(turn);
		expect(spinnerLine(lines)).toContain("正在写代码…");
		expect(lines.some((line) => /^ {9}│ {11}[⠀-⣿] {2}写代码…/.test(line))).toBe(true);
		expect(lines.join("\n")).not.toContain("正在运行 Python");
	});

	it("shows a cell that raised as a red failure even when the tool reported success", () => {
		const turn = quietTurn();
		const code = "print(open('config.toml').read())";
		addStep(turn, "e1", code);
		turn.timeline.mergeStep(
			"e1",
			"ipython",
			{ code },
			{
				content: [{ type: "text", text: "FileNotFoundError: [Errno 2] No such file or directory: 'config.toml'" }],
				details: {
					status: "error",
					error: {
						ename: "FileNotFoundError",
						evalue: "[Errno 2] No such file or directory: 'config.toml'",
						traceback: [],
					},
				},
				isError: false,
			},
			false,
		);
		const lines = openEvents(turn);
		const step = lines.find((line) => line.includes("读取 config.toml")) ?? "";
		expect(step).toMatch(/^ {9}│ {11}✗ {2}读取 config\.toml 出错：FileNotFoundError.* 出错了 {4}$/);
		expect(lines.join("\n")).not.toContain("✓  读取 config.toml");
		const raw = turn.summary.render(120).find((line) => stripAnsi(line).includes("读取 config.toml")) ?? "";
		expect(raw).toContain(theme.fg("timelineMust", "✗"));
		expect(raw).toContain(theme.fg("timelineMust", "出错了"));
	});

	it("labels a cell by what it does, and never by a guess like 设置 W", () => {
		const turn = quietTurn();
		addStep(turn, "p1", "W = 12\nT = W * 3\nprint(T)");
		const out = openEvents(turn).join("\n");
		expect(out).not.toContain("设置 W");
		expect(out).toContain("✓  Python");
	});

	it("names the command a handle wait is waiting for", () => {
		const turn = quietTurn();
		addStep(turn, "w1", "r = await h", "running");
		turn.timeline.stepHandleContext.set("w1", new Map([["h", "go test ./modules/aichat/..."]]));
		const lines = openEvents(turn);
		const step = lines.find((line) => /^ {9}│ {11}[⠀-⣿] {2}/.test(line)) ?? "";
		expect(step).toContain("等待 go test ./modules/aichat/...");
		expect(lines.find((line) => line.includes("╎"))).toContain("在跑  等待 go test ./modules/aichat/...");
		expect(lines.join("\n")).not.toContain("等待命令结果");
	});

	it("builds change steps from the edit skill's diffs and from the edit tool's own diff", () => {
		const turn = quietTurn();
		addStep(turn, "d1", "edit('src/b.ts', 'a', 'b')");
		turn.timeline.mergeStep(
			"d1",
			"ipython",
			{},
			{ details: { diffs: [{ path: "/work/app/src/b.ts", oldStr: "const a = 1;\n", newStr: "const a = 2;\n" }] } },
			false,
		);
		turn.state.addStep({ toolCallId: "t2", toolName: "edit", args: { path: "src/c.ts" }, status: "done" });
		turn.timeline.noteMessage(
			assistant(Date.now() - 1_000, [{ type: "toolCall", id: "t2", name: "edit", arguments: { path: "src/c.ts" } }]),
			true,
		);
		turn.timeline.mergeStep(
			"t2",
			"edit",
			{ path: "src/c.ts" },
			{ details: { diff: "-10 old line\n+10 new line\n+11 added line" } },
			false,
		);
		const lines = openEvents(turn);
		expect(lines.some((line) => /^ {9}│ {11}✎ {2}src\/b\.ts\s+\+1 −1 {4}$/.test(line))).toBe(true);
		expect(lines.some((line) => /^ {9}│ {11}✎ {2}src\/c\.ts\s+\+2 −1 {4}$/.test(line))).toBe(true);
	});
});

describe("events on the timeline", () => {
	it("shows interjections, retries, compaction and subagents as their own lines and steps", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const turn = quietTurn({ startedAt: T0 - 10_000 });
		turn.timeline.addSteer("先别动安卓的，只升级 Go", T0 - 9_000);
		turn.timeline.startRetry({ startedAt: T0 - 500, delayMs: 3_000, attempt: 1, reason: "模型接口超时" });
		const first = openEvents(turn);
		// Your interjection is a line of its own; the retry is a step under an event.
		expect(first.find((line) => line.includes("你插话"))?.trimEnd()).toBe(
			` ${formatTimelineTime(T0 - 9_000)}   ●      你插话   先别动安卓的，只升级 Go`,
		);
		expect(first.some((line) => /^ {9}│ {11}[⠀-⣿] {2}模型接口超时，3 秒后重试/.test(line))).toBe(true);
		expect(spinnerLine(first)).toContain("模型接口超时，3 秒后重试");
		turn.timeline.endRetry("ok");
		turn.timeline.startCompaction(T0, 182_000);
		const compacting = openEvents(turn);
		expect(compacting.some((line) => line.trimEnd() === "         │           ↻  模型接口超时，已自动重试")).toBe(
			true,
		);
		expect(compacting.some((line) => /^ {9}│ {11}[⠀-⣿] {2}上下文快满了，正在整理前面的内容…/.test(line))).toBe(true);
		expect(spinnerLine(compacting)).toContain("上下文快满了，正在整理前面的内容");
		turn.timeline.endCompaction(T0 + 2_000, { before: 182_000 });
		turn.timeline.latestCompaction()!.after = 41_000;
		turn.timeline.upsertSubagent({ childId: "c1", name: "审查员·Go", status: "running", line: "在读 client.go" });
		const running = openEvents(turn);
		expect(
			running.some((line) => /^ {9}│ {11}⇣ {2}整理完成：182k → 41k tokens，重要的结论都留着 +2秒 {4}$/.test(line)),
		).toBe(true);
		// The dispatch is one line under its event, and the spinner line says who is being waited for.
		const dispatch = running.find((line) => line.includes("◇")) ?? "";
		expect(dispatch.trimEnd()).toBe("         ├      ◇  审查员·Go");
		expect(running.find((line) => line.includes("◆"))).toContain("派了 1 个子代理");
		expect(spinnerLine(running)).toContain("在等子代理 审查员·Go 交回结果");
		turn.timeline.upsertSubagent({
			childId: "c1",
			name: "审查员·Go",
			status: "done",
			result: "发现 1 处问题",
			report: "aichat 超时不重试。",
		});
		const handedBack = openEvents(turn);
		expect(handedBack.find((line) => line.includes("◇"))?.trimEnd()).toBe("         ├      ◇  审查员·Go");
		expect(spinnerLine(handedBack)).toContain("等待模型回应…");
		expect(spinnerLine(handedBack)).not.toContain("在等子代理");
	});

	it("keeps a failed step as its own red event line once the turn ended on it", () => {
		const turn = quietTurn({ live: false });
		addStep(turn, "x1", "import nope", "error");
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
		// The turn ended on the error: nothing corrected it, so the failure is a red line of its own, nothing opened.
		turn.timeline.errorEnded = true;
		turn.state.markTurnEnded(Date.now());
		const raw = turn.summary.render(120);
		const closed = plain(raw);
		expect(closed).toHaveLength(1);
		expect(closed[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}Python 出错：ModuleNotFoundError: No module named 'nope' +▸ {2}$/);
		expect(raw[0]).toContain(theme.getFgAnsi("timelineMust"));
		// The tally the header card used to say (`1 处出错`) is carried by the turn's facts now.
		expect(turn.state.boxView().facts.errorCount).toBe(1);
		const key = turn.summary.getFocusOrder()[0] ?? "";
		expect(turn.summary.enterLabel(key)).toBe("展开");
		turn.summary.activate(key);
		const opened = plain(turn.summary.render(120));
		expect(opened[0]?.trimEnd().endsWith("▴")).toBe(true);
		expect(opened).toHaveLength(2);
		expect(opened[1]).toContain("ModuleNotFoundError: No module named 'nope'");
	});
});

describe("the spinner line", () => {
	it("says what happens now, and a thought moves the line only when a sentence completes", () => {
		const turn = quietTurn();
		turn.state.notePhase("thinking");
		turn.state.currentThinking = "先看测试为什么挂。再看最近的提交";
		const line = () => spinnerLine(plain(turn.summary.render(120)));
		expect(line()).toContain("思考中 · 先看测试为什么挂");
		expect(line()).not.toContain("再看最近的提交");
		turn.state.currentThinking = "先看测试为什么挂。再看最近的提交记录";
		expect(line()).toContain("思考中 · 先看测试为什么挂");
		expect(line()).not.toContain("再看最近的提交");
		turn.state.currentThinking = "先看测试为什么挂。再看最近的提交记录。";
		expect(line()).toContain("思考中 · 再看最近的提交记录");
		expect(line()).not.toContain("先看测试为什么挂");
	});

	it("waits for the first token on a plain spinner line: the spinner turns, the words do not shimmer", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const turn = quietTurn({ startedAt: T0 - 1_000 });
		const raw = (tick: number) => {
			setWorkingPulseTick(tick);
			turn.summary.invalidate();
			return turn.summary.render(120).find((line) => /[⠀-⣿]/.test(line)) ?? "";
		};
		expect(stripAnsi(raw(0))).toContain("等待模型回应…");
		expect(stripAnsi(raw(0)).trimEnd()).toMatch(/^ \d\d:\d\d {3}⠋ {6}等待模型回应…$/);
		// The spinner is what moves.
		const glyph = (line: string) => /[⠀-⣿]/.exec(line)?.[0];
		expect(new Set([0, 3, 6].map((tick) => glyph(raw(tick)))).size).toBe(3);
		// The words are one steady color: with the spinner taken out, the line is the same at any tick.
		const words = (tick: number) => raw(tick).replace(/[⠀-⣿]/u, "");
		expect(words(3)).toBe(words(6));
		expect(words(0)).toBe(words(3));
		const colors = (line: string) => (line.match(/\x1b\[38;/g) ?? []).length;
		const moving = colors(raw(3));
		setMotionReduced(true);
		expect(words(3)).toBe(words(6));
		expect(colors(raw(3))).toBe(moving);
	});

	it("summarizes a finished turn on its event line, and a stopped turn stops drawing the spinner", () => {
		const turn = quietTurn({ live: false });
		turn.timeline.noteMessage(
			assistant(
				Date.now() - 4_000,
				[
					{ type: "thinking", thinking: "先跑测试。" },
					{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "await bash('npm test')" } },
				],
				"toolUse",
				1_200,
			),
			true,
		);
		turn.state.addStep({
			toolCallId: "c1",
			toolName: "ipython",
			args: { code: "await bash('npm test')" },
			status: "done",
		});
		turn.state.markTurnEnded(Date.now());
		const lines = plain(turn.summary.render(120));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^ \d\d:\d\d {3}◆ {6}想了 1 次 · 跑了 1 条命令 +2 步 ▸ {2}$/);
		// The clock and the tokens the header used to carry are what the status bar reads off the turn.
		expect(turn.timeline.outputTokens()).toBe(1_200);
		expect(turn.state.turnDurationMs()).toBeGreaterThan(0);

		const stopping = quietTurn();
		addStep(stopping, "s1", "await bash('sleep 100')", "running");
		expect(spinnerLine(plain(stopping.summary.render(120)))).toContain("正在运行命令");
		stopping.timeline.stopped = true;
		stopping.timeline.ui.bump();
		const stopped = plain(stopping.summary.render(120));
		expect(stopped).toHaveLength(1);
		expect(stopped.join("\n")).not.toMatch(/[⠀-⣿]|在跑|已停止/);
		const steps = openEvents(stopping);
		expect(steps.some((line) => line.trimEnd() === "         │           ■  sleep 100 · 你停下了")).toBe(true);
		expect(steps.join("\n")).not.toMatch(/[⠀-⣿]|已停止/);
	});
});

describe("the live thought", () => {
	it("shows the newest thought on one spinner line, however long it grows", () => {
		const turn = quietTurn();
		const message = assistant(Date.now(), [{ type: "thinking", thinking: "短。" }]);
		turn.timeline.noteMessage(message, false);
		const short = plain(turn.summary.render(80));
		// The event, one blank rail row, the spinner line carrying the thought, and the tip under it.
		expect(short).toHaveLength(4);
		expect(spinnerLine(short)).toMatch(/^ \d\d:\d\d {3}[⠀-⣿] {6}短 +第 1 步 {2}$/);
		expect(short[3]?.trimEnd()).toBe("         ╎           思考中…");
		const long = "这是很长的一段思考，".repeat(20);
		turn.timeline.noteMessage({ ...message, content: [{ type: "thinking", thinking: long }] }, false);
		const lines = plain(turn.summary.render(80));
		expect(lines).toHaveLength(4);
		expect(lines.join("\n")).not.toContain("▎");
		const grown = spinnerLine(lines);
		expect(grown).toContain("这是很长的一段思考");
		expect(grown).toContain("…");
		expect(visibleWidth(grown)).toBe(80);
	});
});

describe("long turns", () => {
	function busyTurn() {
		const turn = quietTurn({ host: host({ viewportRows: () => 20 }) });
		for (let index = 0; index < 20; index++) {
			addStep(turn, `s${index}`, `await bash('echo ${index}')`, "done", Date.now() - 4_000 + index);
		}
		return turn;
	}

	it("keeps all its steps behind one event, with no height cap and no scroll marker", () => {
		const turn = busyTurn();
		const closed = plain(turn.summary.render(100));
		// The event, one blank rail row and the spinner line: twenty steps take no more room.
		expect(closed).toHaveLength(3);
		expect(closed[0]).toMatch(/跑了 20 条命令 +20 步 ▸ {2}$/);
		const opened = openEvents(turn, 100);
		expect(opened).toHaveLength(7);
		expect(opened[4]).toContain("⋯  另外 17 步");
		expect(opened[4]?.trimEnd().endsWith("全部 ›")).toBe(true);
		// `全部 ›` lists every step: the turn grows taller than the 20-row screen instead of being cut or scrolled.
		click(turn.summary, "全部 ›", 100);
		const all = plain(turn.summary.render(100));
		const steps = all.filter((line) => /\$ {2}echo \d+/.test(line));
		expect(steps).toHaveLength(20);
		expect(all.length).toBeGreaterThan(20);
		expect(steps.at(-1)).toContain("echo 19");
		for (const gone of ["↑ 上面还有", "↓ 有新内容", "▀"]) expect(all.join("\n")).not.toContain(gone);
	});

	it("takes no wheel, and a step that arrives later only raises the count", () => {
		const turn = busyTurn();
		turn.summary.render(100);
		const regions = turn.summary.getClickRegions();
		expect(regions.length).toBeGreaterThan(0);
		expect(regions.every((region) => region.onWheel === undefined)).toBe(true);
		addStep(turn, "late", "await bash('echo late')", "done", Date.now() - 100);
		const lines = plain(turn.summary.render(100));
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/跑了 21 条命令 +21 步 ▸ {2}$/);
		expect(lines.join("\n")).not.toContain("↓ 有新内容");
		openEvents(turn, 100);
		click(turn.summary, "全部 ›", 100);
		const steps = plain(turn.summary.render(100)).filter((line) => /\$ {2}echo \w+/.test(line));
		expect(steps).toHaveLength(21);
		expect(steps.at(-1)).toContain("echo late");
	});
});

describe("clicks, keys and what stays open", () => {
	it("opens an event from its own line and a step from its own line; no line takes the wheel", () => {
		const turn = quietTurn({ live: false });
		turn.timeline.noteMessage(
			assistant(Date.now() - 4_000, [
				{ type: "thinking", thinking: "第一句。第二句还有更多内容。" },
				{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } },
			]),
			true,
		);
		turn.state.addStep({ toolCallId: "c1", toolName: "ipython", args: { code: "print(1)" }, status: "done" });
		turn.state.markTurnEnded(Date.now());
		// Folded, the turn is its event line alone.
		expect(plain(turn.summary.render(120))).toHaveLength(1);
		click(turn.summary, "想了 1 次");
		setMotionReduced(true);
		const open = plain(turn.summary.render(120));
		expect(open[0]?.trimEnd().endsWith("2 步 ▴")).toBe(true);
		expect(open.join("\n")).not.toContain("第二句");
		click(turn.summary, "思考了");
		const expanded = text(turn.summary.render(120));
		expect(expanded).toContain("第二句还有更多内容");
		// Survives a resize and a plain re-render.
		expect(text(turn.summary.render(80))).toContain("第二句还有更多内容");
		expect(turn.timeline.ui.expanded.size).toBe(2);
		const regions = turn.summary.getClickRegions();
		expect(regions.length).toBeGreaterThan(0);
		expect(regions.every((region) => !region.passive && region.onWheel === undefined)).toBe(true);
	});

	it("walks events and steps with the keyboard, and Enter opens what it is on", () => {
		setMotionReduced(true);
		const turn = quietTurn({ live: false });
		turn.timeline.noteMessage(
			assistant(Date.now() - 4_000, [{ type: "thinking", thinking: "第一句。还有第二句。" }]),
			true,
		);
		turn.state.markTurnEnded(Date.now());
		turn.summary.render(120);
		const folded = turn.summary.getFocusOrder();
		expect(folded).toHaveLength(1);
		expect(folded[0]).toMatch(/^ev:/);
		// `header` stands for the first target: the turn's first event.
		expect(turn.summary.enterLabel("header")).toBe("展开");
		turn.summary.activate("header");
		turn.summary.render(120);
		const order = turn.summary.getFocusOrder();
		expect(order[0]).toBe(folded[0]);
		expect(order).toHaveLength(2);
		expect(turn.summary.enterLabel("header")).toBe("收起");
		// A focused line is painted whole and marked for the viewport (the walk sets the focus, then repaints).
		const focusOn = (key: string) => {
			turn.timeline.ui.focused = true;
			turn.timeline.ui.focusKey = key;
			turn.timeline.ui.bump();
			turn.summary.invalidate();
		};
		focusOn("header");
		const onEvent = turn.summary.render(120);
		expect(onEvent[0]).toContain(BOX_FOCUS_MARKER);
		expect(onEvent[0]).toContain(theme.getBgAnsi("timelineHoverBg"));
		expect(onEvent.join("\n").split(BOX_FOCUS_MARKER)).toHaveLength(2);
		focusOn(order[1] ?? "");
		expect(turn.summary.activate(order[1] ?? "")).toBe(true);
		const focused = turn.summary.render(120).join("\n");
		expect(stripAnsi(focused)).toContain("还有第二句");
		expect(focused.split(BOX_FOCUS_MARKER)).toHaveLength(2);
	});

	it("maps the navigator keys, and any other key leaves with the key", () => {
		const calls: string[] = [];
		const navigator = new TurnBoxNavigator({
			move: (direction) => calls.push(`move ${direction}`),
			page: (direction) => calls.push(`page ${direction}`),
			activate: () => calls.push("activate"),
			exit: (pass) => calls.push(`exit ${pass ?? ""}`),
			blur: () => calls.push("blur"),
		});
		navigator.handleInput("\x1b[A");
		navigator.handleInput("\x1b[B");
		navigator.handleInput("\r");
		navigator.handleInput("x");
		navigator.handleInput("\x1b");
		expect(calls).toEqual(["move -1", "move 1", "activate", "exit x", "exit "]);
	});

	it("binds the box walk to a key every terminal can send, not only to Ctrl+J", () => {
		const keys = new KeybindingsManager();
		// Alt+J arrives as ESC j everywhere; a plain Ctrl+J is a newline ("\n") without extended keys.
		expect(keys.matches("\x1bj", "app.turn.focus")).toBe(true);
		expect(keys.getKeys("app.turn.focus")[0]).toBe("alt+j");
	});

	it("carries open rows and live-only rows over a chat rebuild", () => {
		const before = new TurnTimeline();
		const message = assistant(1_000, [{ type: "thinking", thinking: "a. b." }], "stop");
		before.noteMessage(message, true);
		before.startRetry({ startedAt: 1_500, delayMs: 1_000, attempt: 1, reason: "模型接口超时" });
		before.ui.expanded.add("think:m:1000:0");
		before.ui.userOpen = true;
		const after = new TurnTimeline();
		after.noteMessage(message, true);
		before.transferTo(after);
		expect(after.entries.map((entry) => entry.kind)).toEqual(["message", "retry"]);
		expect(after.ui.expanded.has("think:m:1000:0")).toBe(true);
		expect(after.ui.userOpen).toBe(true);
	});

	it("keeps a turn whole when a compaction summarized its first part away", () => {
		const first = assistant(1_000, [
			{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "await bash('make check')" } },
		]);
		const second = assistant(3_000, [{ type: "text", text: "读完了。" }], "stop");
		const before = quietTurn({ live: false, startedAt: 900 });
		before.timeline.noteMessage(first, true);
		before.state.addStep({ toolCallId: "c1", toolName: "ipython", args: first.content[0], status: "done" });
		before.timeline.startCompaction(2_000, 166_000);
		before.timeline.endCompaction(2_500, { before: 166_000 });
		before.timeline.noteMessage(second, true);
		// The rebuilt chat only replays what the compaction kept: the last message.
		const kept = quietTurn({ live: false, startedAt: 3_000 });
		kept.timeline.noteMessage(second, true);
		const plainCopy = new TurnTimeline();
		plainCopy.noteMessage(second, true);
		before.timeline.transferTo(plainCopy);
		expect(plainCopy.entries.map((entry) => entry.kind)).toEqual(["compact", "message"]);

		before.timeline.transferTo(kept.timeline, { keepHistory: true });
		kept.state.adoptHistory(before.state);
		expect(kept.timeline.entries.map((entry) => entry.kind)).toEqual(["message", "compact", "message"]);
		expect(kept.state.startedAt).toBe(900);
		expect(kept.state.steps.map((step) => step.toolCallId)).toEqual(["c1"]);
	});
});

describe("opening, folding and history", () => {
	it("folds every event at once at turn end, and keeps open one the user opened after that", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const turn = quietTurn({ startedAt: T0 - 5_000 });
		for (let index = 0; index < 6; index++) {
			addStep(turn, `s${index}`, `await bash('echo ${index}')`, "done", T0 - 4_000 + index);
		}
		// Nothing is open while working; the user opens the event.
		const working = plain(turn.summary.render(100)).length;
		turn.summary.toggleBox();
		const open = plain(turn.summary.render(100)).length;
		expect(open).toBeGreaterThan(working);
		expect(turn.state.boxOpen).toBe(true);
		turn.state.markTurnEnded(T0);
		turn.state.finishBox(T0);
		// No fold animation: the steps are gone on the very next frame and stay gone.
		for (const later of [0, TURN_FOLD_MS / 2, TURN_FOLD_MS + 10]) {
			vi.setSystemTime(T0 + later);
			const folded = plain(turn.summary.render(100));
			expect(folded).toHaveLength(1);
			expect(folded[0]).toMatch(/跑了 6 条命令 +6 步 ▸ {2}$/);
		}
		expect(turn.state.boxOpen).toBe(false);

		const touched = quietTurn({ startedAt: T0 - 5_000 });
		addStep(touched, "t", "await bash('echo t')", "done", T0 - 4_000);
		touched.state.markTurnEnded(T0);
		touched.state.finishBox(T0);
		vi.setSystemTime(T0 + TURN_FOLD_MS + 10);
		touched.summary.toggleBox();
		expect(touched.state.boxOpen).toBe(true);
		expect(plain(touched.summary.render(100)).length).toBeGreaterThan(1);
	});

	it("folds at once, and never highlights new rows", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addStep(turn, "s", "await bash('echo s')");
		turn.summary.render(100);
		turn.summary.toggleBox();
		turn.state.markTurnEnded(Date.now());
		turn.state.finishBox();
		expect(plain(turn.summary.render(100))).toHaveLength(1);
		expect(rowEnterStage(Date.now())).toBe("none");
		// With motion on, a row that just arrived is drawn like the rest: no highlight background anywhere.
		setMotionReduced(false);
		const live = quietTurn();
		addStep(live, "a", "await bash('echo a')");
		live.summary.toggleBox();
		live.summary.render(100);
		addStep(live, "b", "await bash('echo b')", "done", Date.now());
		expect(live.summary.render(100).join("\n")).not.toContain("\x1b[48;");
	});

	it("starts closed while working whichever way the setting says, and history turns start closed", () => {
		const settings = [true, false];
		expect(settings.length).toBeGreaterThan(0);
		for (const open of settings) {
			const live = quietTurn({ host: host({ openWhileWorking: () => open }) });
			addStep(live, "s", "await bash('echo s')", "running");
			const lines = plain(live.summary.render(100));
			expect(lines[0]?.trimEnd().endsWith("1 步 ▸"), `openWhileWorking ${open}`).toBe(true);
			expect(lines.join("\n"), `openWhileWorking ${open}`).not.toMatch(/\$ {2}echo s/);
			expect(live.state.boxOpen).toBe(false);
		}
		const history = quietTurn({ live: false });
		addStep(history, "s", "await bash('echo s')");
		history.state.markTurnEnded(Date.now());
		const lines = plain(history.summary.render(100));
		expect(lines).toHaveLength(1);
		expect(lines[0]?.trimEnd().endsWith("1 步 ▸")).toBe(true);
	});

	it("Ctrl+T opens every thinking row of the turn", () => {
		setMotionReduced(true);
		const turn = quietTurn({ live: false });
		turn.timeline.noteMessage(
			assistant(Date.now() - 1_000, [
				{ type: "thinking", thinking: "一。更多的第一段。" },
				{ type: "thinking", thinking: "二。更多的第二段。" },
			]),
			true,
		);
		turn.state.markTurnEnded(Date.now());
		// Open the events (but not their thinking steps) first: a closed event folds
		// everything into "想了 N 次" and would never show the full text
		// either way, so that state cannot prove the toggle reveals anything.
		// With the event open, a settled thinking step must show only its first
		// sentence - the rest must not already be on screen, or the toggle
		// below would prove nothing about what it reveals.
		turn.summary.toggleBox();
		const before = text(turn.summary.render(100));
		expect(before).toContain("思考了 一");
		expect(before).not.toContain("更多的第一段");
		expect(before).not.toContain("更多的第二段");
		turn.summary.toggleThinkingRows();
		const out = text(turn.summary.render(100));
		expect(out).toContain("更多的第一段");
		expect(out).toContain("更多的第二段");
	});
});

describe("layout", () => {
	it("keeps every line inside its width and lines up the CJK rows", () => {
		const turn = quietTurn();
		turn.state.notePhase("thinking");
		turn.state.currentThinking = "这个测试上个月还是好的，大概率是最近的提交弄坏的。";
		addStep(turn, "c1", "await bash('git log --stat -100 --format=%H 一个很长的中文参数说明')");
		turn.timeline.addSteer("先别动安卓的，只升级 Go。这句话很长很长很长很长很长很长很长很长很长", Date.now());
		const widths = [80, 60, 200];
		expect(widths.length).toBeGreaterThan(0);
		for (const open of [false, true]) {
			if (open) turn.summary.toggleBox();
			for (const width of widths) {
				const lines = turn.summary.render(width);
				expect(lines.length).toBeGreaterThan(0);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				const shown = plain(lines);
				// Lines with words on their right edge are as wide as the screen, and those words end two columns
				// before the edge (four for a step's result), whatever the CJK text in front of them is.
				const edged = [
					{ name: "event", line: shown.find((line) => line.includes("◆")), trailing: 2 },
					{ name: "spinner", line: spinnerLine(shown), trailing: 2 },
					...(open ? [{ name: "step", line: shown.find((line) => line.includes("git log")), trailing: 4 }] : []),
				];
				expect(edged.length).toBeGreaterThan(0);
				for (const { name, line, trailing } of edged) {
					expect(line, `${name} at ${width}`).toBeDefined();
					expect(visibleWidth(line ?? ""), `${name} at ${width}`).toBe(width);
					expect((line ?? "").length - (line ?? "").trimEnd().length, `${name} at ${width}`).toBe(trailing);
				}
			}
		}
	});
});

describe("the change strip", () => {
	function finishedTurnWithChanges() {
		setMotionReduced(true);
		const turn = quietTurn({ live: false });
		addStep(turn, "e1", "edit(...)");
		turn.timeline.mergeStep(
			"e1",
			"ipython",
			{},
			{
				details: {
					activities: [
						{
							id: "g",
							kind: "command",
							label: "git commit -m fix",
							status: "ok",
							detail: "[main abc1234] fix",
							startedAt: 1,
						},
					],
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
							diff: "--- a/a.go\n+++ b/a.go\n@@ -1,2 +1,2 @@\n-old()\n+new()\n keep()\n",
						},
						{
							path: "/tmp/x.py",
							kind: "created",
							scope: "scratch",
							added: 3,
							removed: 0,
							source: "python",
							at: 2,
						},
					],
					memoryChanges: [
						{
							op: "updated",
							kind: "memory",
							scope: "global",
							title: "规则",
							previousTitle: "旧规则",
							before: "一\n二",
							after: "一\n三",
							at: 3,
						},
					],
				},
			},
			false,
		);
		turn.state.markTurnEnded(Date.now());
		const strip = new TurnStripComponent({
			timeline: turn.timeline,
			facts: () => turn.state.boxView().facts,
			requestRender: vi.fn(),
		});
		return { turn, strip };
	}

	it("counts the project's files, keeps temp files apart, and names the commit", () => {
		const { strip } = finishedTurnWithChanges();
		const rows = plain(strip.render(120));
		expect(rows.find((row) => row.includes("✎"))).toMatch(
			/^ \d\d:\d\d {3}· {6}✎ 改了 1 个文件 \+12 −4 · 已提交 abc1234 +▸ {2}$/,
		);
		const memoryKey = strip.getFocusOrder().find((entry) => entry.startsWith("strip:item:mem:")) ?? "";
		expect(memoryKey).not.toBe("");
		expect(strip.getFocusOrder()).toEqual([STRIP_EDITS, memoryKey, STRIP_ALL]);
		strip.activate(STRIP_EDITS);
		const list = text(strip.render(120));
		expect(list).toContain("✎ a.go");
		expect(list).toContain("另有 1 个临时文件，不算项目改动");
		strip.activate("strip:item:file:/work/app/a.go");
		const diff = text(strip.render(120));
		expect(diff).toContain("− old()");
		expect(diff).toContain("+ new()");
	});

	it("shows a memory's rename and only its changed lines, after one click", () => {
		const { strip } = finishedTurnWithChanges();
		strip.render(120);
		const key = strip.getFocusOrder().find((entry) => entry.startsWith("strip:item:mem:")) ?? "";
		expect(strip.getClickRegions().length).toBeGreaterThan(0);
		strip.activate(key);
		const out = text(strip.render(120));
		expect(out).toContain("改了记忆   规则");
		expect(out).toContain("改名  旧规则 → 规则");
		expect(out).toContain("− 二");
		expect(out).toContain("+ 三");
		expect(out).not.toContain("一\n");
	});

	it("draws only the closing row for a turn that changed nothing, and nothing for one still running", () => {
		const turn = quietTurn();
		const strip = new TurnStripComponent({ timeline: turn.timeline, facts: () => undefined, requestRender: vi.fn() });
		expect(strip.render(120)).toEqual([]);

		// "No facts yet" (above) and "facts exist but nothing changed" (here) are
		// two different branches of the same guard - an all-empty fact object,
		// not just an absent one, must leave only the closing row.
		const emptyFacts: TimelineFacts = {
			thinkCount: 0,
			commandCount: 0,
			readCount: 0,
			stepCount: 0,
			subagentCount: 0,
			errorCount: 0,
			projectChanges: [],
			scratchChanges: [],
			memories: [],
			commitId: undefined,
			trackingIncomplete: false,
		};
		const emptyStrip = new TurnStripComponent({
			timeline: turn.timeline,
			facts: () => emptyFacts,
			requestRender: vi.fn(),
		});
		const rows = plain(emptyStrip.render(120));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatch(/^ {9}╵ {6}✓ 完成 +完整过程 ▸ {2}$/);

		const later = new TurnStripComponent({
			timeline: turn.timeline,
			facts: () => emptyFacts,
			requestRender: vi.fn(),
			endsRequest: () => false,
		});
		expect(later.render(120)).toEqual([]);
	});
});

describe("the status bar", () => {
	const right = [
		"⠹ 工作中 · 1分26秒 · ↓ 7.1k tokens · Esc 停止",
		"⠹ 工作中 · 1分26秒 · ↓ 7.1k · Esc 停止",
		"⠹ 工作中 · 1分26秒 · ↓ 7.1k",
		"⠹ 工作中 · 1分26秒",
	];

	it("fits the model, context, subagents and the run's state, dropping the least useful first", () => {
		const state = {
			model: "glm-5.3-prime",
			level: "中",
			context: { percent: 33, warn: false },
			subagents: 2,
			right,
		};
		const wideRaw = renderStatusBar(state, 160);
		const wide = stripAnsi(wideRaw);
		expect(wide).toContain("glm-5.3-prime · 思考 中");
		expect(wide).toContain("上下文 ━━━━━━━━ 33%");
		expect(wideRaw).toContain(`${theme.fg("timelineUser", "━━━")}${theme.fg("timelineRail", "━━━━━")}`);
		expect(wide).toContain("◇ 2 个子代理在跑");
		expect(wide).toContain("Esc 停止");
		const narrow = stripAnsi(renderStatusBar(state, 80));
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(80);
		expect(narrow).toContain("33%");
		expect(narrow).toContain("工作中 · 1分26秒");
	});

	it("keeps its layout while the clock and the token count gain digits", () => {
		const bar = (seconds: number, tokens: number) =>
			stripAnsi(
				renderStatusBar(
					{
						model: "glm-5.3-prime",
						level: "中",
						context: { percent: 5, warn: false },
						subagents: 0,
						right: [
							`⠸ 工作中 · ${seconds}秒 · ↓ ${tokens} tokens · Esc 停止`,
							`⠸ 工作中 · ${seconds}秒 · ↓ ${tokens} · Esc 停止`,
							`⠸ 工作中 · ${seconds}秒 · ↓ ${tokens}`,
							`⠸ 工作中 · ${seconds}秒`,
						],
					},
					80,
				),
			);
		const shape = (line: string) => line.replace(/\d+/g, "#").replace(/\s+/g, " ");
		expect(shape(bar(9, 20))).toBe(shape(bar(10, 20)));
		expect(shape(bar(10, 99))).toBe(shape(bar(59, 155)));
		// Colour codes carry digits too; they must not count against the room.
		const colored = stripAnsi(
			renderStatusBar(
				{
					model: "glm-5.3-prime",
					context: { percent: 5, warn: false },
					subagents: 0,
					right: ["\u001b[38;2;121;211;191m⠸\u001b[39m 工作中 · 1秒 · ↓ 24 tokens · Esc 停止", "⠸ 工作中 · 1秒"],
				},
				120,
			),
		);
		expect(colored).toContain("↓ 24 tokens · Esc 停止");
	});

	it("turns the context meter amber at 80%", () => {
		const calm = renderStatusBar({ model: "m", context: { percent: 50, warn: false }, subagents: 0, right: [] }, 80);
		const warn = renderStatusBar({ model: "m", context: { percent: 85, warn: true }, subagents: 0, right: [] }, 80);
		expect(stripAnsi(warn)).toContain("85%");
		expect(warn).not.toBe(calm.replace("50%", "85%"));
	});
});

describe("replay groups a transcript the way the live view does", () => {
	it("keeps an interjection inside the turn's timeline instead of starting a new turn", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "把依赖都升级", timestamp: 1_000 },
			assistant(1_100, [
				{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "await bash('go list -m -u all')" } },
			]),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ipython",
				content: [{ type: "text", text: "14 个可升级" }],
				isError: false,
				timestamp: 1_200,
			} satisfies ToolResultMessage,
			{ role: "user", content: "先别动安卓的", timestamp: 1_300 },
			assistant(1_400, [{ type: "text", text: "好，只升级 Go。" }], "stop"),
		];
		const components = buildConversationComponents(messages, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			cwd: "/work/app",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode: "quiet",
		});
		expect(components.filter((component) => component instanceof UserMessageComponent)).toHaveLength(1);
		const summaries = components.filter((component) => component instanceof TurnSummaryComponent);
		expect(summaries).toHaveLength(1);
		const summary = summaries[0] as TurnSummaryComponent;
		summary.setExpanded(true);
		setMotionReduced(true);
		const lines = plain(summary.render(120));
		expect(lines.find((line) => line.includes("你插话"))?.trimEnd()).toBe(
			` ${formatTimelineTime(1_300)}   ●      你插话   先别动安卓的`,
		);
		expect(lines.some((line) => /^ {9}│ {11}\$ {2}go list -m -u all +✓ 14 个可升级 {4}$/.test(line))).toBe(true);
	});

	it("clocks a replayed turn up to its last reply, not just its last step", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "读配置", timestamp: 1_000 },
			assistant(1_000, [{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "print(1)" } }]),
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "ipython",
				content: [{ type: "text", text: "1" }],
				isError: false,
				timestamp: 1_500,
			} satisfies ToolResultMessage,
			assistant(5_200, [{ type: "text", text: "按默认配置运行即可。" }], "stop"),
		];
		const components = buildConversationComponents(messages, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			cwd: "/work/app",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode: "quiet",
		});
		const summary = components.find((component) => component instanceof TurnSummaryComponent) as TurnSummaryComponent;
		// The timeline draws no header clock: the turn's clock is what the status bar reads off it.
		expect(summary.state.turnDurationMs()).toBe(4_200);
		expect(formatBoxDuration(summary.state.turnDurationMs())).toBe("4秒");
		// Two empty rows under the question, then the event.
		expect(plain(summary.render(120))[2]).toMatch(/^ \d\d:\d\d {3}◆ {6}做了 1 步 +1 步 ▸ {2}$/);
	});

	it("ends a turn the owner interrupted mid-step as stopped, and the next message starts a new turn", () => {
		// The owner's stop: the agent loop keeps the cell's partial output and marks it cut short.
		const result = (id: string, timestamp: number, status: "ok" | "aborted"): ToolResultMessage => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "ipython",
			content:
				status === "ok"
					? [{ type: "text", text: "done" }]
					: [
							{ type: "text", text: "<ipython_cell_aborted>" },
							{ type: "text", text: ABORT_TRUNCATION_MARKER },
						],
			details: { status },
			isError: status === "aborted",
			timestamp,
		});
		const messages: AgentMessage[] = [
			{ role: "user", content: "跑一下慢检查", timestamp: 1_000 },
			assistant(1_100, [
				{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "await bash('make check')" } },
			]),
			result("c1", 1_200, "ok"),
			{ role: "user", content: "顺便把 lint 也跑了", timestamp: 1_300 },
			assistant(1_400, [
				{ type: "toolCall", id: "c2", name: "ipython", arguments: { code: "await bash('make lint')" } },
			]),
			result("c2", 1_500, "aborted"),
			{ role: "user", content: "算了，先看测试", timestamp: 1_600 },
		];
		const components = buildConversationComponents(messages, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			cwd: "/work/app",
			toolOptions: {},
			getToolDefinition: () => undefined,
			processMode: "quiet",
		});
		expect(components.filter((component) => component instanceof UserMessageComponent)).toHaveLength(2);
		const summaries = components.filter((component) => component instanceof TurnSummaryComponent);
		expect(summaries).toHaveLength(1);
		const box = summaries[0] as TurnSummaryComponent;
		const lines = openEvents({ summary: box }, 120);
		// No pill says 已停止: the cut-off step reads as stopped, faint, and nothing is drawn as a failure.
		expect(lines.some((line) => line.trimEnd() === "         │           ■  make lint · 你停下了")).toBe(true);
		expect(lines.join("\n")).not.toContain("已停止");
		expect(lines.join("\n")).not.toContain("算了，先看测试");
		expect(box.render(120).join("\n")).not.toContain(theme.getFgAnsi("timelineMust"));
	});
});
