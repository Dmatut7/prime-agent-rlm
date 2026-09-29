import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRefinementOutcomeMessage } from "../src/core/messages.js";
import type { HarnessEntry, RefinementResult } from "../src/core/refinement/refinement.js";
import type { ChangeEntry } from "../src/modes/interactive/components/feed-data.js";
import {
	FooterComponent,
	type FooterTelemetrySnapshot,
	renderStatusBar,
} from "../src/modes/interactive/components/footer.js";
import { setMotionReduced } from "../src/modes/interactive/components/motion.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
import type { TimelineFacts } from "../src/modes/interactive/components/timeline-rows.js";
import {
	type TimelineHost,
	TurnActivityState,
	TurnSummaryComponent,
} from "../src/modes/interactive/components/turn-activity.js";
import { STRIP_ALL, STRIP_EDITS, TurnStripComponent } from "../src/modes/interactive/components/turn-strip.js";
import { TurnTimeline } from "../src/modes/interactive/components/turn-timeline.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

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

function assistant(timestamp: number, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "glm-5.3-prime",
		usage: usage(0),
		stopReason: "toolUse",
		timestamp,
	};
}

function host(overrides: Partial<TimelineHost> = {}): TimelineHost {
	return {
		cwd: () => "/work/app",
		viewportRows: () => 40,
		openWhileWorking: () => true,
		autoFold: () => false,
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

function addStep(
	turn: ReturnType<typeof quietTurn>,
	id: string,
	code: string,
	status: "running" | "done" = "done",
	timestamp = Date.now() - 4_000,
): void {
	turn.timeline.noteMessage(
		assistant(timestamp, [{ type: "toolCall", id, name: "ipython", arguments: { code } }]),
		status !== "running",
	);
	turn.state.addStep({ toolCallId: id, toolName: "ipython", args: { code }, status: "queued" });
	turn.state.setStepStatus(id, "running", timestamp);
	if (status === "done") turn.state.setStepStatus(id, "done", timestamp + 500);
}

const plain = (lines: readonly string[]) => lines.map((line) => stripAnsi(line).replace(/\x1b_[^\x07]*\x07/g, ""));
const text = (lines: readonly string[]) => plain(lines).join("\n");

/** Open every event that lists steps (a click on each event line), and give the lines. */
function openEvents(turn: ReturnType<typeof quietTurn>, width = 100): string[] {
	turn.summary.render(width);
	for (const key of turn.summary.getFocusOrder()) {
		if (key.startsWith("ev:") && turn.summary.enterLabel(key) === "展开") turn.summary.activate(key);
	}
	return plain(turn.summary.render(width));
}

/** The character a click at `col` lands on. */
function charAtColumn(line: string, col: number): string {
	let at = 0;
	for (const char of line) {
		if (at === col) return char;
		at += visibleWidth(char);
		if (at > col) return "";
	}
	return "";
}

const WIDTHS = Array.from({ length: 30 }, (_, index) => index + 1);

function change(overrides: Partial<ChangeEntry> = {}): ChangeEntry {
	return {
		key: "/work/app/src/中文组件/审查.ts",
		path: "src/中文组件/审查.ts",
		kind: "modified",
		scope: "project",
		added: 1234,
		removed: 567,
		rows: [],
		truncated: false,
		binary: false,
		firstAt: 1,
		...overrides,
	};
}

function facts(overrides: Partial<TimelineFacts> = {}): TimelineFacts {
	return {
		thinkCount: 0,
		commandCount: 0,
		readCount: 0,
		stepCount: 1,
		subagentCount: 0,
		errorCount: 0,
		projectChanges: [change()],
		scratchChanges: [],
		memories: [
			{
				key: "m1",
				change: {
					op: "created",
					kind: "memory",
					scope: "global",
					title: "一条很长的中文记忆标题",
					after: "x",
					at: 1,
				},
			},
		],
		trackingIncomplete: false,
		...overrides,
	};
}

function strip(data: TimelineFacts, open?: "edits" | "memories") {
	const timeline = new TurnTimeline();
	if (open === "edits") timeline.ui.stripOpen = "edits";
	if (open === "memories") for (const memory of data.memories) timeline.ui.stripExpanded.add(memory.key);
	return new TurnStripComponent({ timeline, facts: () => data, requestRender: vi.fn() });
}

function refinementResult(): RefinementResult {
	const after: HarnessEntry = {
		id: "long-guidance",
		kind: "prompt",
		title: "一条很长很长的记忆标题，用来撑满窄屏",
		content: "第一行内容\n第二行内容",
		path: "prompts/long-guidance.md",
		scope: "local",
		reference: {},
		arguments: {},
		metadata: {},
		source: "refinement",
		created_at: "2026-08-18T00:00:00.000Z",
		updated_at: "2026-08-18T00:00:00.000Z",
		version: 1,
	};
	return {
		id: "refine-long",
		summary: "整理器留下的说明，也很长很长很长很长",
		rationale: "r",
		expectedOutcome: "o",
		appliedEdits: [
			{
				action: "create",
				kind: "prompt",
				id: after.id,
				title: after.title,
				content: after.content,
				path: after.path,
				after,
				applied: true,
			},
		],
		harnessStatePath: "/tmp/harness/state.json",
		scope: "local",
	};
}

beforeAll(() => {
	initTheme("prime");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	setMotionReduced(false);
	timelineShowAll.set(false);
});

describe("narrow terminals", () => {
	it("never renders a timeline, strip or refinement line wider than the width it is given", () => {
		setMotionReduced(true);
		timelineShowAll.set(true);
		const turn = quietTurn({ host: host({ viewportRows: () => 10 }) });
		const base = Date.now() - 4_000;
		for (let index = 0; index < 8; index++) {
			addStep(turn, `c${index}`, `await bash('make step${index}')`, "done", base + index);
		}
		addStep(turn, "live", "await bash('go test ./...')", "running", base + 8);
		const edits = strip(facts(), "edits");
		const memories = strip(facts({ commitId: "abc1234", trackingIncomplete: true }), "memories");
		const refinement = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(refinementResult()));
		refinement.setExpanded(true);
		expect(WIDTHS.length).toBeGreaterThan(0);
		for (const width of WIDTHS) {
			const rendered = {
				box: turn.summary.render(width),
				edits: edits.render(width),
				memories: memories.render(width),
				refinement: refinement.render(width),
			};
			for (const [name, lines] of Object.entries(rendered)) {
				expect(lines.length, `${name} at ${width}`).toBeGreaterThan(0);
				const widest = Math.max(...lines.map((line) => visibleWidth(line)));
				expect(widest, `${name} at ${width}`).toBeLessThanOrEqual(width);
			}
		}
		// Opened, the step lines fit too.
		turn.summary.toggleBox();
		for (const width of WIDTHS) {
			const lines = turn.summary.render(width);
			expect(lines.length, `opened at ${width}`).toBeGreaterThan(0);
			expect(Math.max(...lines.map((line) => visibleWidth(line))), `opened at ${width}`).toBeLessThanOrEqual(width);
		}
		turn.summary.toggleBox();
		// The lines still span the screen once there is room for them: the count ends two columns from the right edge.
		const roomy = plain(turn.summary.render(30));
		expect(visibleWidth(roomy[0] ?? "")).toBe(30);
		expect(roomy[0]?.endsWith("9 步 ▸  ")).toBe(true);
		const spinner = roomy.find((line) => line.includes("第 9 步")) ?? "";
		expect(visibleWidth(spinner)).toBe(30);
		expect(spinner.endsWith("第 9 步  ")).toBe(true);
		expect(roomy.join("\n")).not.toContain("╭");
	});
});

describe("the change strip on a narrow screen", () => {
	it("drops whole wordings instead of cutting a number, and keeps click areas on screen", () => {
		const big = facts({ projectChanges: [change({ added: 999999, removed: 888888 })] });
		for (const width of [24, 26, 28, 30, 40]) {
			for (const data of [big, facts()]) {
				const component = strip(data);
				const rows = plain(component.render(width));
				const top = rows[1] ?? "";
				const numbers = [...top.matchAll(/[+−](\d+)/g)].map((match) => Number(match[1]));
				const known = [999999, 888888, 1234, 567];
				for (const value of numbers) expect(known, `${top} at ${width}`).toContain(value);
				const regions = component.getClickRegions();
				expect(regions.length).toBeGreaterThan(0);
				for (const region of regions) {
					expect(region.col + region.width, `${top} at ${width}`).toBeLessThanOrEqual(width);
					expect(rows[region.line], `row ${region.line} at ${width}`).toBeDefined();
				}
				expect(component.getFocusOrder()).toEqual([STRIP_EDITS, "strip:item:m1", STRIP_ALL]);
			}
		}
		// With room, the file row keeps its full wording.
		expect(plain(strip(facts()).render(80))[1]).toMatch(/^ {9}· {6}✎ 改了 1 个文件 \+1234 −567 +▸ {2}$/);
	});

	it("shortens a listed path from the left, keeping the file name, before it shows counts", () => {
		for (const width of [40, 44, 50, 60]) {
			for (const data of [facts({ projectChanges: [change({ added: 999999, removed: 888888 })] }), facts()]) {
				const row = plain(strip(data, "edits").render(width))[2] ?? "";
				expect(row, `row at ${width}`).toContain("审查.ts");
				expect(row).not.toMatch(/✎ …\s/);
			}
		}
		expect(plain(strip(facts(), "edits").render(50))[2]).toContain("…/审查.ts");
		expect(plain(strip(facts(), "edits").render(50))[2]).toContain("+1234 −567");
		expect(plain(strip(facts(), "edits").render(100))[2]).toContain("src/中文组件/审查.ts");
	});
});

describe("the kernel's step records", () => {
	const command = (id: string, label: string, extra: Record<string, unknown>) => ({
		id,
		kind: "command",
		label,
		startedAt: Date.now() - 3_000,
		...extra,
	});

	it("lists only the steps the final result kept, and says how many earlier ones it left out", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addStep(turn, "c1", "for f in files: await bash(f)", "running");
		const live = ["alpha", "bravo", "charlie"].map((name) => command(name, `echo ${name}`, { status: "ok" }));
		turn.timeline.mergeStep("c1", "ipython", {}, { details: { activities: live } }, true);
		expect(openEvents(turn).join("\n")).toContain("$  echo alpha");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{ details: { activities: live.slice(1), activitiesDropped: 1 } },
			false,
		);
		turn.state.setStepStatus("c1", "done", Date.now());
		const lines = openEvents(turn);
		const out = lines.join("\n");
		expect(out).not.toContain("echo alpha");
		expect(out).toContain("$  echo bravo");
		const note = lines.find((line) => line.includes("更早的")) ?? "";
		expect(note.trimEnd()).toBe("         │           …  更早的 1 步没列出");
	});

	it("shows a command left running as gone to the background, and its later outcome as one settled row", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addStep(turn, "c1", "h = bash('npm run build')");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{
				details: {
					activities: [
						command("b", "npm run build", { status: "running", background: true, detail: "转到后台继续跑" }),
					],
				},
			},
			false,
		);
		const before = openEvents(turn).join("\n");
		expect(before).toContain("$  npm run build · 转到后台继续跑");
		expect(before).not.toMatch(/npm run build.*✓/);

		addStep(turn, "c2", "print(h.wait())");
		turn.timeline.mergeStep(
			"c2",
			"ipython",
			{},
			{
				details: {
					activities: [command("b", "npm run build", { status: "ok", background: true, detail: "built in 4s" })],
				},
			},
			false,
		);
		const after = openEvents(turn);
		const rows = after.filter((line) => line.includes("npm run build"));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("$  npm run build · 后台跑完了");
		expect(rows[0]).toContain("✓ built in 4s");
		expect(after.join("\n")).not.toContain("转到后台继续跑");
		expect(after.join("\n")).not.toContain("✓ 完成");
	});

	it("says a background command that failed with its exit code, also when it started in an earlier turn", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addStep(turn, "c2", "print(h.wait())");
		turn.timeline.mergeStep(
			"c2",
			"ipython",
			{},
			{
				details: {
					activities: [command("b", "npm run build", { status: "error", background: true, detail: "exit 2" })],
				},
			},
			false,
		);
		const row = openEvents(turn).find((line) => line.includes("npm run build")) ?? "";
		expect(row).toContain("$  npm run build · 后台出错了");
		expect(row).toContain("退出码 2");
		expect(row).not.toContain("✗ 退出码 2");
	});

	it("keys the background row off the kernel's flag while the cell is still being reported", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addStep(turn, "c1", "h = bash('npm run dev')", "running");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{ details: { activities: [command("d", "npm run dev", { status: "running", background: true })] } },
			true,
		);
		expect(openEvents(turn).join("\n")).toContain("$  npm run dev · 转到后台继续跑");
	});

	it("shows a commit's short id in the command's result column", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addStep(turn, "c1", "await bash('git commit -am fix')");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{
				details: {
					activities: [
						command("g", "git commit -am fix", {
							status: "ok",
							detail: "1 file changed",
							commit: "a1b2c3d4e5f6",
						}),
					],
				},
			},
			false,
		);
		const row = openEvents(turn).find((line) => line.includes("git commit")) ?? "";
		expect(row).toMatch(/\$ {2}git commit -am fix\s+✓ 提交 a1b2c3d {4}$/);
		expect(visibleWidth(row)).toBe(100);
	});

	it("says a secret-looking diff or memory was not kept, with the line counts still shown", () => {
		setMotionReduced(true);
		const turn = quietTurn();
		addStep(turn, "c1", "write('.env')");
		turn.timeline.mergeStep(
			"c1",
			"ipython",
			{},
			{
				details: {
					fileChanges: [
						{
							path: "/work/app/.env",
							relPath: ".env",
							kind: "modified",
							scope: "project",
							added: 3,
							removed: 1,
							diffOmitted: "sensitive",
							source: "python",
							at: 1,
						},
					],
					memoryChanges: [
						{
							op: "updated",
							kind: "memory",
							scope: "session",
							title: "部署口令",
							textOmitted: "sensitive",
							at: 2,
						},
					],
				},
			},
			false,
		);
		const summary = turn.summary;
		const fileRow = openEvents(turn).find((line) => line.includes(".env")) ?? "";
		expect(fileRow).toContain("+3 −1");
		const toggle = (needle: string) => {
			const rows = plain(summary.render(100));
			const index = rows.findIndex((line) => line.includes(needle));
			const region = summary.getClickRegions().find((candidate) => candidate.line === index);
			expect(region, needle).toBeDefined();
			region?.onClick({ row: index, col: 2 });
		};
		toggle(".env");
		toggle("部署口令");
		const opened = text(summary.render(100));
		expect(opened.match(/内容没存：看起来是密钥/g)).toHaveLength(2);
	});
});

describe("the context meter after a compaction", () => {
	it("says the context was just tidied instead of dropping the meter", () => {
		const bar = stripAnsi(
			renderStatusBar({ model: "glm-5.3-prime", context: { warn: false }, subagents: 0, right: [] }, 80),
		);
		expect(bar).toContain("上下文 刚整理过");

		const footer = new FooterComponent({ getGitBranch: () => null } as never);
		let snapshot: FooterTelemetrySnapshot = {
			modelName: "glm-5.3-prime",
			contextTokens: null,
			contextWindow: 200_000,
		};
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		expect(stripAnsi(footer.render(80).join("\n"))).toContain("上下文 刚整理过");
		snapshot = { ...snapshot, contextTokens: 50_000 };
		const measured = stripAnsi(footer.render(80).join("\n"));
		expect(measured).toContain("25%");
		expect(measured).not.toContain("刚整理过");
	});
});
