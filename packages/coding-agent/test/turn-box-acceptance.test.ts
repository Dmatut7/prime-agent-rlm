import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Component, type EditorTheme, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createCompactionOutcomeMessage, createRlmChildTerminalNoticeMessage } from "../src/core/messages.js";
import { CompactionOutcomeMessageComponent } from "../src/modes/interactive/components/compaction-outcome-message.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { getToolFileChanges } from "../src/modes/interactive/components/edit-summary.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { turnBoxFocusHints } from "../src/modes/interactive/components/turn-box-navigator.js";
import { STRIP_EDITS, TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { headerPlain } from "./grow-box-helpers.js";

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
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: usage(0),
		stopReason,
		timestamp,
	};
}

function toolResult(id: string, timestamp: number, text: string, details?: Record<string, unknown>): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "ipython",
		content: [{ type: "text", text }],
		...(details ? { details } : {}),
		isError: false,
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

function quietTurn(options: { live?: boolean; host?: TimelineHost } = {}) {
	const state = new TurnActivityState(Date.now() - 5_000);
	if (options.live !== false) state.live = true;
	state.modelId = "glm-5.3-prime";
	const summary = new TurnSummaryComponent(state);
	summary.setTimelineHost(options.host ?? host());
	summary.setQuiet(true);
	return { state, summary, timeline: state.timeline };
}

type Turn = ReturnType<typeof quietTurn>;

function addStep(
	turn: Turn,
	id: string,
	code: string,
	status: "running" | "done" | "error" = "done",
	timestamp = Date.now() - 4_000,
): void {
	turn.timeline.noteMessage(
		assistant(timestamp, [{ type: "toolCall", id, name: "ipython", arguments: { code } }]),
		status !== "running",
	);
	turn.state.addStep({ toolCallId: id, toolName: "ipython", args: { code }, status: "queued" });
	turn.state.setStepStatus(id, "running", timestamp);
	if (status !== "running") turn.state.setStepStatus(id, status, timestamp + 500);
}

function finish(turn: Turn): void {
	turn.state.markTurnEnded(Date.now());
	turn.state.finishBox(Date.now());
}

/** The finished box, opened by the owner. */
function openBox(turn: Turn): string {
	setMotionReduced(true);
	turn.summary.render(120);
	turn.summary.toggleBox();
	return text(turn.summary.render(120));
}

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));
const text = (lines: readonly string[]) => plain(lines).join("\n");
const header = (turn: Turn) => headerPlain(turn.summary.render(120));

function replay(messages: AgentMessage[]): Component[] {
	return buildConversationComponents(messages, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: "/work/app",
		toolOptions: {},
		getToolDefinition: () => undefined,
		processMode: "quiet",
	});
}

function renderAll(components: readonly Component[]): string {
	return components.map((component) => text(component.render(120))).join("\n");
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
	vi.useRealTimers();
});

describe("s3: a turn carried on by a subagent notice", () => {
	const messages: AgentMessage[] = [
		{ role: "user", content: "让审查员看一下 client.go", timestamp: 1_000 },
		assistant(1_100, [
			{
				type: "toolCall",
				id: "c1",
				name: "ipython",
				arguments: { code: "await rlm.spawn('审查员', '看 client.go')" },
			},
		]),
		toolResult("c1", 1_200, "spawned"),
		assistant(1_300, [{ type: "text", text: "已经派审查员去看了，等它回来。" }], "stop"),
		createRlmChildTerminalNoticeMessage(
			{
				kind: "completed_without_reply",
				childId: "child-1",
				sessionName: "审查员",
				lastAssistantText: "没发现问题。",
			},
			1_400,
		),
		assistant(1_500, [{ type: "text", text: "审查员看完了，没发现问题。" }], "stop"),
	];

	it("starts the next turn at the notice and leaves the earlier answer under its own turn", () => {
		setMotionReduced(true);
		const components = replay(messages);
		const summaries = components.filter((component) => component instanceof TurnSummaryComponent);
		expect(summaries).toHaveLength(2);
		const closed = renderAll(components);
		expect(closed).toContain("审查员看完了，没发现问题。");
		// The woken turn does not fold the answer the first turn ended on away.
		expect(closed).toContain("已经派审查员去看了");
	});

	it("keeps what the subagent did out of sight until 完整过程 is on, then says it in Chinese", () => {
		setMotionReduced(true);
		const components = replay(messages);
		expect(renderAll(components)).not.toContain("做完了，没发回消息");
		timelineShowAll.set(true);
		try {
			const out = renderAll(components);
			expect(out).toContain("子代理 审查员 做完了，没发回消息");
			expect(out).not.toContain("subagent status");
			expect(out).not.toContain("RLM child");
		} finally {
			timelineShowAll.set(false);
		}
	});
});

describe("s5: a quiet compaction", () => {
	it("is a row of the turn's box, not an English card", () => {
		setMotionReduced(true);
		const messages: AgentMessage[] = [
			{ role: "user", content: "把依赖都升级", timestamp: 1_000 },
			assistant(1_100, [
				{ type: "toolCall", id: "c1", name: "ipython", arguments: { code: "await bash('go list -m -u all')" } },
			]),
			toolResult("c1", 1_200, "14 个可升级"),
			createCompactionOutcomeMessage(
				"Auto-compaction skipped: conversation is too short to compact",
				{ reason: "threshold", outcome: "skipped" },
				true,
				1_250,
			),
			{ role: "compactionSummary", summary: "## 目标\n升级依赖", tokensBefore: 166_000, timestamp: 1_300 },
			assistant(1_400, [{ type: "text", text: "都升级好了。" }], "stop"),
		];
		const components = replay(messages);
		const summary = components.find((component) => component instanceof TurnSummaryComponent) as TurnSummaryComponent;
		summary.setExpanded(true);
		const box = text(summary.render(120));
		expect(box).toContain("暂不整理：对话还太短，等它长一些再整理");
		expect(box).toContain("整理完成（原来 166k tokens），重要的结论都留着");
		const out = renderAll(components);
		for (const english of ["[compaction]", "Compacted from", "Auto-compaction skipped"]) {
			expect(out).not.toContain(english);
		}
	});

	it("says a compaction before any turn in one Chinese line", () => {
		const components = replay([
			{ role: "compactionSummary", summary: "## 目标\n升级依赖", tokensBefore: 166_000, timestamp: 900 },
			{ role: "user", content: "继续", timestamp: 1_000 },
		]);
		const out = renderAll(components);
		expect(out).toContain("前面的对话整理过了");
		expect(out).toContain("原来 166k tokens");
		expect(out).not.toContain("Compacted from");
	});

	it("shows a skipped compaction outside a box as one Chinese line", () => {
		const message = createCompactionOutcomeMessage(
			"Auto-compaction skipped: conversation is too short to compact",
			{ reason: "threshold", outcome: "skipped" },
			true,
			1_000,
		);
		const out = text(new CompactionOutcomeMessageComponent(message, { quiet: true }).render(120));
		expect(out).toContain("暂不整理上下文");
		expect(out).not.toContain("Auto-compaction skipped");
	});
});

describe("s4: the owner's stop", () => {
	it("shows the step it cut short as a faint stop, not an error", () => {
		const turn = quietTurn({ live: false });
		addStep(turn, "c1", "await bash('make lint')", "error");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{
				isError: true,
				content: [{ type: "text", text: "KeyboardInterrupt" }],
				details: { status: "error", error: { ename: "KeyboardInterrupt", evalue: "", traceback: [] } },
			},
			false,
		);
		turn.timeline.stopped = true;
		finish(turn);
		const out = openBox(turn);
		expect(out).toContain("你停下了");
		expect(out).not.toContain("KeyboardInterrupt");
		expect(out).not.toContain("出错");
		expect(header(turn)).not.toContain("处出错");
	});

	it("marks a command the stop cut short as stopped by the owner", () => {
		const turn = quietTurn({ live: false });
		addStep(turn, "c1", "await bash('make lint')", "error");
		const startedAt = Date.now() - 3_000;
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{
				isError: true,
				content: [{ type: "text", text: "<ipython_cell_aborted>" }],
				details: {
					status: "aborted",
					activities: [{ id: "a", kind: "command", label: "make lint", status: "running", startedAt }],
				},
			},
			false,
		);
		turn.timeline.stopped = true;
		finish(turn);
		const out = openBox(turn);
		expect(out).toContain("make lint · 你停下了");
		expect(out).not.toContain("出错");
	});
});

describe("the result column of a command", () => {
	function commandTurn(detail: string) {
		const turn = quietTurn({ live: false });
		addStep(turn, "c1", "await bash('cat package.json')");
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
							label: "cat package.json",
							status: "ok",
							detail,
							startedAt,
							endedAt: startedAt + 100,
						},
					],
				},
			},
			false,
		);
		finish(turn);
		return turn;
	}

	it("says done instead of dumping a line of the command's data", () => {
		const out = openBox(commandTurn('{"name": "app", "version": "1.2.3", "private": true}'));
		expect(out).toMatch(/\$ cat package\.json\s+✓ 完成\s+│/);
		expect(out).not.toContain('"version"');
	});

	it("keeps a short status line as it is", () => {
		expect(openBox(commandTurn("133 total"))).toMatch(/\$ cat package\.json\s+✓ 133 total\s+│/);
	});
});

describe("a step that checked on the subagents", () => {
	it("says how many handed their work back, not how long the check took", () => {
		const turn = quietTurn({ live: false });
		addStep(turn, "c1", "print(await rlm.collect())");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{ content: [{ type: "text", text: "2 done" }], details: { durationMs: 4_200 } },
			false,
		);
		turn.timeline.upsertSubagent({ childId: "a", name: "审查员", status: "done", result: "发现 1 处问题" });
		turn.timeline.upsertSubagent({ childId: "b", name: "测试员", status: "done", result: "测试全过" });
		finish(turn);
		const out = openBox(turn);
		expect(out).toMatch(/查看子代理\s+✓ 2 个已交回\s+│/);
		expect(out).not.toContain("4.2秒");
	});
});

describe("C-3: changes the kernel could not diff", () => {
	function omittedTurn() {
		setMotionReduced(true);
		const turn = quietTurn({ live: false });
		addStep(turn, "e1", "json.dump(data, open('data/big.json', 'w'))");
		turn.timeline.mergeStep(
			"e1",
			"ipython",
			{},
			{
				details: {
					fileChanges: [
						{
							path: "/work/app/data/big.json",
							relPath: "data/big.json",
							kind: "modified",
							scope: "project",
							added: 0,
							removed: 0,
							source: "python",
							diffOmitted: "too_large",
							at: 1,
						},
					],
					changeTrackingIncomplete: "watch budget exceeded",
				},
			},
			false,
		);
		finish(turn);
		const strip = new TurnStripComponent({
			timeline: turn.timeline,
			facts: () => turn.state.boxView().facts,
			requestRender: vi.fn(),
		});
		return { turn, strip };
	}

	it("gives the reason on the row instead of +0 −0", () => {
		const { turn } = omittedTurn();
		const out = openBox(turn);
		expect(out).toMatch(/✎ data\/big\.json\s+改动太大，没有显示\s+│/);
		expect(out).not.toContain("+0");
	});

	it("never says +0 in the header or the strip, and says the tracking is incomplete", () => {
		const { turn, strip } = omittedTurn();
		const head = header(turn);
		expect(head).toContain("改了 1 个文件");
		expect(head).toContain("（有些改动没记全）");
		expect(head).not.toContain("+0");
		const line = text(strip.render(120));
		expect(line).toContain("改了 1 个文件 ▸");
		expect(line).toContain("（有些改动没记全）");
		expect(line).not.toContain("+0");
		strip.activate(STRIP_EDITS);
		const list = text(strip.render(120));
		expect(list).toContain("改动太大，没有显示");
		expect(list).not.toContain("+0");
	});
});

describe("F2: a command left running in the background", () => {
	it("says once that it went on in the background, with no clock or spinner", () => {
		const turn = quietTurn({ live: false });
		addStep(turn, "c1", "h = bash('npm run dev', background=True)");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{
				details: {
					activities: [
						{
							id: "bg",
							kind: "command",
							label: "npm run dev",
							status: "running",
							background: true,
							detail: "listening on :3000",
							startedAt: Date.now() - 60_000,
						},
					],
				},
			},
			false,
		);
		finish(turn);
		const out = openBox(turn);
		const row = out.split("\n").find((line) => line.includes("npm run dev")) ?? "";
		expect(row).toContain("npm run dev · 转到后台继续跑");
		expect(row).not.toMatch(/\d+秒|\d+分/);
		expect(row).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		expect(out).not.toContain("listening on :3000");
	});

	it("hides the stale running row once a later step of the turn reports it finished", () => {
		const turn = quietTurn({ live: false });
		const startedAt = Date.now() - 60_000;
		const activity = { id: "bg", kind: "command" as const, label: "npm run build", startedAt };
		addStep(turn, "c1", "h = bash('npm run build', background=True)", "done", Date.now() - 4_000);
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{ details: { activities: [{ ...activity, status: "running", background: true }] } },
			false,
		);
		addStep(turn, "c2", "r = await h", "done", Date.now() - 3_000);
		turn.timeline.mergeStep(
			"c2",
			"ipython",
			{},
			{
				details: {
					activities: [{ ...activity, status: "ok", detail: "built in 4s", endedAt: startedAt + 30_000 }],
				},
			},
			false,
		);
		finish(turn);
		const out = openBox(turn);
		expect(out).toMatch(/\$ npm run build\s+✓ built in 4s\s+│/);
		expect(out).not.toContain("转到后台继续跑");
		expect(out.split("\n").filter((line) => line.includes("npm run build") && !line.includes("✓"))).toEqual([]);
	});
});

describe("opened change and memory rows", () => {
	function changeTurn(memory: { before?: string; after?: string }) {
		setMotionReduced(true);
		const turn = quietTurn({ live: false });
		addStep(turn, "e1", "edit(...)");
		turn.timeline.mergeStep(
			"e1",
			"ipython",
			{},
			{
				details: {
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
					memoryChanges: [{ op: "created", kind: "memory", scope: "session", title: "规则", at: 2, ...memory }],
				},
			},
			false,
		);
		finish(turn);
		return turn;
	}

	it("F3: says how the change was made at the top of its opened diff", () => {
		const turn = changeTurn({ after: "带上 context。" });
		const strip = new TurnStripComponent({
			timeline: turn.timeline,
			facts: () => turn.state.boxView().facts,
			requestRender: vi.fn(),
		});
		strip.render(120);
		strip.activate(STRIP_EDITS);
		strip.render(120);
		strip.activate("strip:item:file:/work/app/a.go");
		const lines = plain(strip.render(120));
		const by = lines.findIndex((line) => line.includes("edit 技能改的"));
		const minus = lines.findIndex((line) => line.includes("− old()"));
		expect(by).toBeGreaterThan(-1);
		expect(minus).toBeGreaterThan(by);
	});

	it("F6: a memory row with no text shows only the facts of its step when opened, not made-up texts", () => {
		const bare = changeTurn({});
		openBox(bare);
		expect(bare.summary.activate("mem:e1:0")).toBe(true);
		const facts = text(bare.summary.render(120));
		expect(facts).toContain("结果");
		expect(facts).not.toContain("新记的");

		const withText = changeTurn({ after: "带上 context。" });
		openBox(withText);
		expect(withText.summary.activate("mem:e1:0")).toBe(true);
		expect(text(withText.summary.render(120))).toContain("带上 context。");
	});
});

describe("F8: the legacy edit totals", () => {
	const oldStr = "const a = 1;\n";
	const newStr = "const a = 2;\nconst b = 3;\n";

	it("read the kernel's change list when the cell carries one", () => {
		const changes = getToolFileChanges(
			"ipython",
			{},
			{
				isError: false,
				details: {
					diffs: [{ path: "/work/app/src/b.ts", oldStr, newStr }],
					fileChanges: [
						{
							path: "/work/app/src/c.ts",
							relPath: "src/c.ts",
							kind: "modified",
							scope: "project",
							added: 7,
							removed: 2,
						},
						{ path: "/tmp/x.py", kind: "created", scope: "scratch", added: 3, removed: 0 },
					],
				},
			},
			"/work/app",
		);
		expect(changes.map((change) => [change.path, change.added, change.removed])).toEqual([["src/c.ts", 7, 2]]);
	});

	it("count nothing when the kernel's list says nothing changed", () => {
		const changes = getToolFileChanges(
			"ipython",
			{},
			{ isError: false, details: { diffs: [{ path: "/work/app/src/b.ts", oldStr, newStr }], fileChanges: [] } },
			"/work/app",
		);
		expect(changes).toEqual([]);
	});
});

describe("M-2: a finished box redraws when what it reads changes", () => {
	it("hides the thinking text once hideThinking turns on", () => {
		setMotionReduced(true);
		let hideThinking = false;
		const turn = quietTurn({ live: false, host: host({ hideThinking: () => hideThinking }) });
		turn.timeline.noteMessage(
			assistant(Date.now() - 4_000, [{ type: "thinking", thinking: "第一句。第二句是秘密的想法。" }], "stop"),
			true,
		);
		finish(turn);
		openBox(turn);
		turn.summary.toggleThinkingRows();
		expect(text(turn.summary.render(120))).toContain("第二句是秘密的想法");
		hideThinking = true;
		expect(text(turn.summary.render(120))).not.toContain("第二句是秘密的想法");
	});

	it("shows paths relative to the new working directory after a cd", () => {
		setMotionReduced(true);
		let cwd = "/work/app";
		const turn = quietTurn({ live: false, host: host({ cwd: () => cwd }) });
		addStep(turn, "e1", "edit(...)");
		turn.timeline.mergeStep(
			"e1",
			"ipython",
			{},
			{
				details: {
					fileChanges: [
						{
							path: "/work/app/pkg/a.go",
							kind: "modified",
							scope: "project",
							added: 1,
							removed: 0,
							source: "edit",
							at: 1,
						},
					],
				},
			},
			false,
		);
		finish(turn);
		expect(openBox(turn)).toMatch(/✎ pkg\/a\.go/);
		cwd = "/work/app/pkg";
		const moved = text(turn.summary.render(120));
		expect(moved).toMatch(/✎ a\.go/);
		expect(moved).not.toContain("pkg/a.go");
	});
});

describe("M-3: a long live turn stays cheap to draw", () => {
	it("draws a 200-step box with 20 KB cells in well under a second for ten frames", () => {
		const turn = quietTurn();
		const big = "x = 1\n".repeat(3_500);
		const t0 = Date.now() - 600_000;
		for (let index = 0; index < 200; index++) {
			const code = `${big}\nprint(${index})`;
			const message = assistant(t0 + index * 1_000, [
				{ type: "thinking", thinking: `Step ${index}. Think about it.` },
				{ type: "toolCall", id: `c${index}`, name: "ipython", arguments: { code } },
			]);
			turn.timeline.noteMessage(message, true);
			const args = (message.content[1] as { arguments: Record<string, unknown> }).arguments;
			turn.state.addStep({ toolCallId: `c${index}`, toolName: "ipython", args, status: "queued" });
			turn.state.setStepStatus(`c${index}`, "running", t0 + index * 1_000);
			turn.state.setStepStatus(`c${index}`, "done", t0 + index * 1_000 + 500);
			turn.timeline.mergeStep(
				`c${index}`,
				"ipython",
				args,
				{ content: [{ type: "text", text: `${index}` }] },
				false,
			);
		}
		turn.timeline.noteMessage(assistant(t0 + 300_000, [{ type: "thinking", thinking: "Now the last one." }]), false);
		// The first frame reads every cell once.
		expect(text(turn.summary.render(120))).toContain("Now the last one");
		const start = performance.now();
		for (let frame = 0; frame < 10; frame++) turn.summary.render(120);
		// Before the memo each frame re-read all 4 MB of code (~390 ms a frame).
		expect(performance.now() - start).toBeLessThan(1_000);
	});
});

describe("keys", () => {
	const editorTheme: EditorTheme = {
		borderColor: (value) => value,
		selectList: {
			selectedPrefix: (value) => value,
			selectedText: (value) => value,
			description: (value) => value,
			scrollInfo: (value) => value,
			noMatch: (value) => value,
		},
	};
	const fakeTui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 80 } } as unknown as TUI;

	it("C-1: a handler that answers false still keeps its key from the next action", () => {
		const keys = new KeybindingsManager({
			"app.subagents.focus": "alt+a",
			"app.thinking.toggle": ["ctrl+t", "alt+a"],
		});
		const editor = new CustomEditor(fakeTui, editorTheme, keys);
		const focusSubagents = vi.fn(() => false);
		const toggleThinking = vi.fn();
		editor.onAction("app.subagents.focus", focusSubagents);
		editor.onAction("app.thinking.toggle", toggleThinking);
		editor.handleInput("\x1ba");
		expect(focusSubagents).toHaveBeenCalledOnce();
		expect(toggleThinking).not.toHaveBeenCalled();
	});

	function modeFake(children: unknown[], processMode: "quiet" | "legacy") {
		const fake = {
			toolOutputExpanded: false,
			thinkingExpanded: false,
			agentMessagesExpanded: false,
			editDiffsExpanded: false,
			customHeader: undefined,
			builtInHeader: { setExpanded: vi.fn() },
			uiServices: { settingsManager: { getProcessMode: () => processMode } },
			chatContainer: { children },
			options: {},
			editor: { getText: () => "" },
			showToast: vi.fn(),
			ui: {
				requestRender: vi.fn(),
				requestRenderPreservingViewport: vi.fn(),
				isFullscreen: vi.fn().mockReturnValue(false),
				isFullscreenReviewing: vi.fn().mockReturnValue(false),
			},
		};
		Object.setPrototypeOf(fake, InteractiveMode.prototype);
		// The key handlers are private; the fake drives them the way interactive-mode-status.test.ts does.
		return fake as any;
	}

	it("legacy: the box-walk key opens the edit diffs, since there is no box to walk", () => {
		const cell = { setExpanded: vi.fn(), setEditDiffsExpanded: vi.fn() };
		const mode = modeFake([cell], "legacy");
		mode.focusLatestTurnBox();
		expect(mode.editDiffsExpanded).toBe(true);
		expect(cell.setEditDiffsExpanded).toHaveBeenLastCalledWith(true);
	});

	it("the walk's hint says what Enter does on the focused target, and nothing before there is one", () => {
		expect(turnBoxFocusHints().join(" ")).not.toContain("Enter");
		const turn = quietTurn({ live: false });
		addStep(turn, "c1", "await bash('npm test')");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{
				details: {
					activities: [
						{ id: "a", kind: "command", label: "npm test", status: "ok", detail: "ok", startedAt: 1, endedAt: 2 },
					],
				},
			},
			false,
		);
		finish(turn);
		openBox(turn);
		const rowKey = turn.summary.getFocusOrder().find((key) => key !== "header") ?? "";
		expect(rowKey).not.toBe("");
		const mode = modeFake([turn.summary], "quiet");
		mode.boxFocus = { summary: turn.summary, navigator: {}, resumeFollow: false };
		turn.timeline.ui.focused = true;
		turn.timeline.ui.focusKey = rowKey;
		// Every block opens (one with no lines of its own opens to the facts of its step).
		expect(mode.getTrayHints().join(" ")).toContain("Enter 展开");
		turn.timeline.ui.focusKey = "header";
		expect(mode.getTrayHints().join(" ")).toContain("Enter 收起");
	});
});
