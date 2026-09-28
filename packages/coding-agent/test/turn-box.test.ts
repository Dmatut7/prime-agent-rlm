import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { type ClickRegion, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { renderStatusBar } from "../src/modes/interactive/components/footer.js";
import { rowEnterStage, setMotionReduced, TURN_FOLD_MS } from "../src/modes/interactive/components/motion.js";
import { commandOutcome } from "../src/modes/interactive/components/timeline-rows.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { BOX_MAX_WIDTH, boxBodyRows } from "../src/modes/interactive/components/turn-box.js";
import { TurnBoxNavigator } from "../src/modes/interactive/components/turn-box-navigator.js";
import { STRIP_EDITS, STRIP_MEMORIES, TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { TurnTimeline } from "../src/modes/interactive/components/turn-timeline.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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

/** A quiet turn with its box, the way the interactive mode builds one. */
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

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

describe("timeline rows from the kernel's records", () => {
	it("shows a command as a $ row: spinner, own clock and latest output while running, the result once done", () => {
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
		const live = text(turn.summary.render(120));
		expect(live).toContain("go test ./...");
		expect(live).toContain("└ === RUN TestTimeoutRetry");
		expect(live).toMatch(/go test \.\/\.\.\.\s+[23]秒 │/);
		expect(live).toContain("正在运行 go test ./...");

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
		const done = text(turn.summary.render(120));
		expect(done).toMatch(/\$ go test \.\/\.\.\.\s+✗ 54 通过 · 2 失败 │/);
		expect(done).not.toContain("└ === RUN");
	});

	it("reads consecutive file reads as one row that counts while it runs", () => {
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
		expect(text(turn.summary.render(120))).toContain("正在读取 b.go（第 3 个）");
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
		const done = text(turn.summary.render(120));
		expect(done).toContain("✓ 读取了 3 个文件");
		expect(done.match(/读取/g)).toHaveLength(1);
	});

	it("turns file and memory records into ✎ and ✦ rows with counts and clean titles", () => {
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
		const out = text(turn.summary.render(120));
		expect(out).toMatch(/✎ modules\/aichat\/client\.go\s+\+12 −4 │/);
		expect(out).toMatch(/✎ \/tmp\/probe\.py\s+临时 \+9 │/);
		expect(out).toContain("✦ 记住：go · http · 请求要带 · context");
		expect(out).not.toContain("_2026");
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
		const out = text(turn.summary.render(120));
		expect(out).toContain("正在写代码…");
		expect(out).not.toContain("正在运行 Python");
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
		const out = text(turn.summary.render(120));
		expect(out).toContain("✗ 读取 config.toml 出错：FileNotFoundError");
		expect(out).not.toContain("✓ 读取 config.toml");
	});

	it("labels a cell by what it does, and never by a guess like 设置 W", () => {
		const turn = quietTurn();
		addStep(turn, "p1", "W = 12\nT = W * 3\nprint(T)");
		const out = text(turn.summary.render(120));
		expect(out).not.toContain("设置 W");
		expect(out).toContain("Python");
	});

	it("names the command a handle wait is waiting for", () => {
		const turn = quietTurn();
		addStep(turn, "w1", "r = await h", "running");
		turn.timeline.stepHandleContext.set("w1", new Map([["h", "go test ./modules/aichat/..."]]));
		const out = text(turn.summary.render(120));
		expect(out).toContain("等待 go test ./modules/aichat/...");
		expect(out).not.toContain("等待命令结果");
	});

	it("builds change rows from the edit skill's diffs and from the edit tool's own diff", () => {
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
		const out = text(turn.summary.render(120));
		expect(out).toMatch(/✎ src\/b\.ts\s+\+1 −1 │/);
		expect(out).toMatch(/✎ src\/c\.ts\s+\+2 −1 │/);
	});
});

describe("events inside the box", () => {
	it("shows interjections, retries, compaction and subagents as their own rows", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const turn = quietTurn({ startedAt: T0 - 10_000 });
		turn.timeline.addSteer("先别动安卓的，只升级 Go", T0 - 9_000);
		turn.timeline.startRetry({ startedAt: T0 - 500, delayMs: 3_000, attempt: 1, reason: "模型接口超时" });
		expect(text(turn.summary.render(120))).toContain("↻ 模型接口超时，3 秒后重试");
		expect(text(turn.summary.render(120))).toContain("› 你插话：先别动安卓的，只升级 Go");
		turn.timeline.endRetry("ok");
		turn.timeline.startCompaction(T0, 182_000);
		const compacting = text(turn.summary.render(120));
		expect(compacting).toContain("↻ 模型接口超时，已自动重试");
		expect(compacting).toContain("上下文快满了，正在整理前面的内容…");
		turn.timeline.endCompaction(T0 + 2_000, { before: 182_000 });
		turn.timeline.latestCompaction()!.after = 41_000;
		turn.timeline.upsertSubagent({ childId: "c1", name: "审查员·Go", status: "running", line: "在读 client.go" });
		const running = text(turn.summary.render(120));
		expect(running).toContain("⇣ 整理完成：182k → 41k tokens，重要的结论都留着");
		expect(running).toContain("子代理 审查员·Go");
		expect(running).toContain("└ 在读 client.go");
		turn.timeline.upsertSubagent({
			childId: "c1",
			name: "审查员·Go",
			status: "done",
			result: "发现 1 处问题",
			report: "aichat 超时不重试。",
		});
		expect(text(turn.summary.render(120))).toMatch(/◇ 子代理 审查员·Go\s+✓ 发现 1 处问题 │/);
	});

	it("keeps a failed step as a red row after the box folds", () => {
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
		turn.state.markTurnEnded(Date.now());
		const closed = text(turn.summary.render(120));
		expect(closed).toContain("▸ ✓");
		expect(closed).toContain("ModuleNotFoundError: No module named 'nope'");
		expect(closed).toContain("1 处出错");
	});
});

describe("the box header", () => {
	it("says what happens now, and a thought moves the header only when a sentence completes", () => {
		const turn = quietTurn();
		turn.state.notePhase("thinking");
		turn.state.currentThinking = "先看测试为什么挂。再看最近的提交";
		const header = () => plain(turn.summary.render(120))[2] ?? "";
		expect(header()).toContain("思考中 · 先看测试为什么挂");
		turn.state.currentThinking = "先看测试为什么挂。再看最近的提交记录";
		expect(header()).toContain("思考中 · 先看测试为什么挂");
		turn.state.currentThinking = "先看测试为什么挂。再看最近的提交记录。";
		expect(header()).toContain("思考中 · 再看最近的提交记录");
	});

	it("shimmers while waiting for the first token, and reduced motion shows it plain", () => {
		const turn = quietTurn();
		const header = () => turn.summary.render(120)[2] ?? "";
		expect(stripAnsi(header())).toContain("等待模型回应…");
		const shimmering = (header().match(/\x1b\[38;/g) ?? []).length;
		setMotionReduced(true);
		turn.summary.invalidate();
		const calm = (header().match(/\x1b\[38;/g) ?? []).length;
		expect(shimmering).toBeGreaterThan(calm);
	});

	it("summarizes a finished turn, and says a stopped one stopped", () => {
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
		const header = plain(turn.summary.render(120))[2] ?? "";
		expect(header).toMatch(/▸ ✓ 想了 1 次 · 跑了 1 条命令\s+\d+秒 · ↓ 1\.2k │/);
		turn.timeline.stopped = true;
		turn.timeline.ui.bump();
		expect(plain(turn.summary.render(120))[2]).toContain("■ 已停止 · 做到第 1 步，做好的都留着");
	});
});

describe("the thinking window", () => {
	it("is always three lines under the live thought, newest text at the bottom", () => {
		const turn = quietTurn();
		const message = assistant(Date.now(), [{ type: "thinking", thinking: "短。" }]);
		turn.timeline.noteMessage(message, false);
		const windowLines = () => plain(turn.summary.render(80)).filter((line) => /^ │ {5}│ /.test(line));
		expect(windowLines()).toHaveLength(3);
		const long = "这是很长的一段思考，".repeat(20);
		turn.timeline.noteMessage({ ...message, content: [{ type: "thinking", thinking: long }] }, false);
		const lines = windowLines();
		expect(lines).toHaveLength(3);
		expect(lines.at(-1)).toContain("这是很长的一段思考");
	});
});

describe("scrolling inside the box", () => {
	function busyTurn() {
		const turn = quietTurn({ host: host({ viewportRows: () => 20 }) });
		for (let index = 0; index < 20; index++) {
			addStep(turn, `s${index}`, `await bash('echo ${index}')`, "done", Date.now() - 4_000 + index);
		}
		return turn;
	}

	it("keeps the body at its height cap and follows the newest row", () => {
		const turn = busyTurn();
		const lines = plain(turn.summary.render(100));
		const body = lines.filter((line) => line.startsWith(" │ ") && line !== lines[2]);
		expect(body).toHaveLength(boxBodyRows(20));
		expect(body.at(-1)).toContain("echo 19");
		expect(lines[3]).toContain("↑ 上面还有");
	});

	it("scrolls with the wheel over the body and, scrolled up, says new rows arrived", () => {
		const turn = busyTurn();
		turn.summary.render(100);
		const wheel = turn.summary.getClickRegions().find((region) => region.onWheel && region.line > 4);
		expect(wheel?.onWheel?.(-1)).toBe(true);
		turn.summary.render(100);
		addStep(turn, "late", "await bash('echo late')", "done", Date.now() - 100);
		const lines = plain(turn.summary.render(100));
		expect(lines.at(-1)).toContain("↓ 有新内容");
		const marker = turn.summary.getClickRegions().find((region) => region.line === lines.length - 1);
		marker?.onClick({ row: 0, col: 0 });
		expect(plain(turn.summary.render(100)).at(-1)).not.toContain("↓ 有新内容");
	});
});

describe("clicks, keys and what stays open", () => {
	function regionAt(summary: TurnSummaryComponent, line: number): ClickRegion | undefined {
		return summary.getClickRegions().find((region) => region.line === line && !region.passive);
	}

	it("toggles the whole box from its header and one row from its own line; plain rows only take the wheel", () => {
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
		expect(plain(turn.summary.render(120))).toHaveLength(4);
		regionAt(turn.summary, 2)?.onClick({ row: 0, col: 0 });
		setMotionReduced(true);
		const open = plain(turn.summary.render(120));
		expect(open[2]).toContain("▾ ✓");
		const thinkLine = open.findIndex((line) => line.includes("思考了"));
		regionAt(turn.summary, thinkLine)?.onClick({ row: 0, col: 0 });
		const expanded = text(turn.summary.render(120));
		expect(expanded).toContain("第二句还有更多内容");
		// Survives a resize and a plain re-render.
		expect(text(turn.summary.render(80))).toContain("第二句还有更多内容");
		expect(turn.timeline.ui.expanded.size).toBe(1);
		const passive = turn.summary.getClickRegions().filter((region) => region.passive);
		expect(passive.length).toBeGreaterThan(0);
		expect(passive.every((region) => region.onWheel !== undefined)).toBe(true);
	});

	it("walks header, rows and strip with the keyboard, and Enter opens what it is on", () => {
		setMotionReduced(true);
		const turn = quietTurn({ live: false });
		turn.timeline.noteMessage(
			assistant(Date.now() - 4_000, [{ type: "thinking", thinking: "第一句。还有第二句。" }]),
			true,
		);
		turn.state.markTurnEnded(Date.now());
		turn.summary.render(120);
		expect(turn.summary.getFocusOrder()).toEqual(["header"]);
		turn.summary.activate("header");
		turn.summary.render(120);
		const order = turn.summary.getFocusOrder();
		expect(order[0]).toBe("header");
		expect(order).toHaveLength(2);
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = order[1];
		expect(turn.summary.activate(order[1] ?? "")).toBe(true);
		const focused = turn.summary.render(120).join("\n");
		expect(stripAnsi(focused)).toContain("还有第二句");
		expect(focused).toContain("\x1b_pi:box-focus\x07");
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
	it("folds the body row by row at turn end unless the user touched the box", () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		const turn = quietTurn({ startedAt: T0 - 5_000 });
		for (let index = 0; index < 6; index++) {
			addStep(turn, `s${index}`, `await bash('echo ${index}')`, "done", T0 - 4_000 + index);
		}
		const open = plain(turn.summary.render(100)).length;
		turn.state.markTurnEnded(T0);
		turn.state.finishBox(T0);
		vi.setSystemTime(T0 + TURN_FOLD_MS / 2);
		const folding = plain(turn.summary.render(100)).length;
		expect(folding).toBeLessThan(open);
		expect(folding).toBeGreaterThan(4);
		vi.setSystemTime(T0 + TURN_FOLD_MS + 10);
		expect(plain(turn.summary.render(100))).toHaveLength(4);

		const touched = quietTurn({ startedAt: T0 - 5_000 });
		addStep(touched, "t", "await bash('echo t')", "done", T0 - 4_000);
		touched.summary.toggleBox();
		touched.summary.toggleBox();
		touched.state.markTurnEnded(T0);
		touched.state.finishBox(T0);
		expect(plain(touched.summary.render(100)).length).toBeGreaterThan(4);
	});

	it("folds at once with reduced motion, and never highlights new rows", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addStep(turn, "s", "await bash('echo s')");
		turn.summary.render(100);
		turn.state.markTurnEnded(Date.now());
		turn.state.finishBox();
		expect(plain(turn.summary.render(100))).toHaveLength(4);
		expect(rowEnterStage(Date.now())).toBe("none");
	});

	it("starts closed while working when the setting says so, and history boxes start closed", () => {
		const closedLive = quietTurn({ host: host({ openWhileWorking: () => false }) });
		addStep(closedLive, "s", "await bash('echo s')", "running");
		expect(plain(closedLive.summary.render(100))).toHaveLength(4);
		const history = quietTurn({ live: false });
		addStep(history, "s", "await bash('echo s')");
		history.state.markTurnEnded(Date.now());
		expect(plain(history.summary.render(100))).toHaveLength(4);
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
		turn.summary.render(100);
		turn.summary.toggleThinkingRows();
		const out = text(turn.summary.render(100));
		expect(out).toContain("更多的第一段");
		expect(out).toContain("更多的第二段");
	});
});

describe("layout", () => {
	it("keeps every line inside 80 columns and lines up the CJK rows", () => {
		const turn = quietTurn();
		turn.state.notePhase("thinking");
		turn.state.currentThinking = "这个测试上个月还是好的，大概率是最近的提交弄坏的。";
		addStep(turn, "c1", "await bash('git log --stat -100 --format=%H 一个很长的中文参数说明')");
		turn.timeline.addSteer("先别动安卓的，只升级 Go。这句话很长很长很长很长很长很长很长很长很长", Date.now());
		for (const width of [80, 60, 200]) {
			const lines = turn.summary.render(width);
			const outer = Math.max(24, Math.min(width - 1, BOX_MAX_WIDTH));
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			for (const line of lines.slice(1)) expect(visibleWidth(line)).toBe(outer + 1);
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
		const line = text(strip.render(120));
		expect(line).toBe(" ✎ 改了 1 个文件 +12 −4 ▸  ·  ✦ 记住了 1 条 ▸  ·  已提交 abc1234");
		expect(strip.getFocusOrder()).toEqual([STRIP_EDITS, STRIP_MEMORIES]);
		strip.activate(STRIP_EDITS);
		const list = text(strip.render(120));
		expect(list).toContain("▸ ✎ a.go");
		expect(list).toContain("另有 1 个临时文件，不算项目改动");
		strip.activate("strip:item:file:/work/app/a.go");
		const diff = text(strip.render(120));
		expect(diff).toContain("− old()");
		expect(diff).toContain("+ new()");
	});

	it("shows a memory's rename and only its changed lines", () => {
		const { strip } = finishedTurnWithChanges();
		strip.render(120);
		strip.activate(STRIP_MEMORIES);
		strip.render(120);
		const key = strip.getFocusOrder().find((entry) => entry.startsWith("strip:item:")) ?? "";
		strip.activate(key);
		const out = text(strip.render(120));
		expect(out).toContain("全局 · 改名");
		expect(out).toContain("改名  旧规则 → 规则");
		expect(out).toContain("− 二");
		expect(out).toContain("+ 三");
		expect(out).not.toContain("一\n");
	});

	it("renders nothing for a turn that changed nothing, or one still running", () => {
		const turn = quietTurn();
		const strip = new TurnStripComponent({ timeline: turn.timeline, facts: () => undefined, requestRender: vi.fn() });
		expect(strip.render(120)).toEqual([]);
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
			location: "~/work/app · main",
			subagents: 2,
			right,
		};
		const wide = stripAnsi(renderStatusBar(state, 160));
		expect(wide).toContain("glm-5.3-prime · 思考 中");
		expect(wide).toContain("上下文 ━━━───── 33%");
		expect(wide).toContain("◇ 2 个子代理在跑");
		expect(wide).toContain("~/work/app · main");
		expect(wide).toContain("Esc 停止");
		const narrow = stripAnsi(renderStatusBar(state, 80));
		expect(visibleWidth(narrow)).toBeLessThanOrEqual(80);
		expect(narrow).toContain("33%");
		expect(narrow).toContain("工作中 · 1分26秒");
		expect(narrow).not.toContain("~/work/app");
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
	it("keeps an interjection inside the turn's box instead of starting a new turn", () => {
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
		const out = text(summary.render(120));
		expect(out).toContain("› 你插话：先别动安卓的");
		expect(out).toContain("go list -m -u all");
	});

	it("clocks a replayed box up to its last reply, not just its last step", () => {
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
		expect(text(summary.render(120))).toMatch(/4秒 · ↓/);
	});

	it("ends a turn the owner interrupted mid-step as stopped, and the next message starts a new turn", () => {
		const result = (id: string, timestamp: number, status: "ok" | "aborted"): ToolResultMessage => ({
			role: "toolResult",
			toolCallId: id,
			toolName: "ipython",
			content: [{ type: "text", text: status === "ok" ? "done" : "<ipython_cell_aborted>" }],
			details: { status },
			isError: false,
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
		const out = text((summaries[0] as TurnSummaryComponent).render(120));
		expect(out).toContain("■ 已停止");
		expect(out).not.toContain("算了，先看测试");
	});
});
