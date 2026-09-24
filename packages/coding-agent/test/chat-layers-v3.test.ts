import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createRefinementOutcomeMessage, IPYTHON_STATE_RESTORED_CUSTOM_TYPE } from "../src/core/messages.js";
import type { HarnessEntry, RefinementResult } from "../src/core/refinement/refinement.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { InjectedPromptMessageComponent } from "../src/modes/interactive/components/injected-prompt-message.js";
import { RefinementOutcomeMessageComponent } from "../src/modes/interactive/components/refinement-outcome-message.js";
import {
	currentRunningAction,
	RUNNING_CARD_QUIET_MS,
	renderAssistantHeader,
	renderRunningCard,
	runningStepText,
} from "../src/modes/interactive/components/running-card.js";
import { turnStepLabel } from "../src/modes/interactive/components/step-label.js";
import { SystemNoticeLine } from "../src/modes/interactive/components/system-notice.js";
import { TurnActivityState, TurnSummaryComponent } from "../src/modes/interactive/components/turn-activity.js";
import {
	sentAtText,
	UserMessageComponent,
	userBubbleIndent,
} from "../src/modes/interactive/components/user-message.js";
import { initTheme, loadThemeFromPath } from "../src/modes/interactive/theme/theme.js";
import {
	getSpinnerTick,
	getWorkingPulseFrame,
	SPINNER_FRAMES,
	setWorkingPulseTick,
	spinnerFrame,
} from "../src/modes/interactive/theme/working-icon.js";

const T0 = 1_700_000_000_000;
const plain = (lines: string[]) => lines.map((line) => stripAnsi(line));

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

function liveState(): TurnActivityState {
	const state = new TurnActivityState(T0);
	state.live = true;
	state.modelId = "glm-5.3-prime";
	return state;
}

describe("running card: what the AI is doing right now", () => {
	it("says it is waiting for the reply before the first token", () => {
		const state = liveState();
		const action = currentRunningAction(state, T0 + 8_000);
		expect(action.text).toBe("正在等模型回复");
		expect(action.elapsedMs).toBe(8_000);
	});

	it("names thinking with the latest sentence of the trace", () => {
		const state = liveState();
		state.notePhase("thinking", T0 + 1_000);
		state.currentThinking = "测试挂了。先看测试为什么挂，再决定改哪里";
		const action = currentRunningAction(state, T0 + 13_000);
		expect(action).toMatchObject({ text: "正在想", detail: "「先看测试为什么挂，再决定改哪里」", elapsedMs: 12_000 });
	});

	it("clocks the wait for the reply from the step that just handed back (seen live)", () => {
		const state = liveState();
		state.notePhase("waiting", T0 + 5_000);
		state.addStep({ toolCallId: "a", toolName: "bash", args: { command: "sleep 330" }, status: "queued" });
		state.setStepStatus("a", "running", T0 + 6_000);
		state.setStepStatus("a", "error", T0 + 306_000);
		const action = currentRunningAction(state, T0 + 312_000);
		expect(action.text).toBe("正在等模型回复");
		expect(action.elapsedMs).toBe(6_000);
	});

	it("says it is writing the answer", () => {
		const state = liveState();
		state.notePhase("writing", T0 + 2_000);
		expect(currentRunningAction(state, T0 + 3_000).text).toBe("正在写回答…");
	});

	it("names the running command with its own clock, not the turn's", () => {
		const state = liveState();
		state.addStep({ toolCallId: "a", toolName: "bash", args: { command: "npm test" }, status: "queued" });
		state.setStepStatus("a", "running", T0 + 17_000);
		const action = currentRunningAction(state, T0 + 62_000);
		expect(action.text).toBe("正在运行 npm test");
		expect(action.elapsedMs).toBe(45_000);
	});

	it("quotes a web search and names a subagent wait", () => {
		expect(
			runningStepText({
				toolCallId: "s",
				toolName: "ipython",
				args: { code: 'r = await asyncio.to_thread(bailian_web_search.search, "今天的新闻")' },
				status: "running",
			}),
		).toBe("正在联网搜索「今天的新闻」");
		expect(
			runningStepText({
				toolCallId: "c",
				toolName: "ipython",
				args: { code: "snap = await rlm.collect(timeout_ms=90000)" },
				status: "running",
			}),
		).toBe("正在等子代理");
		// Awaiting a bash handle is a command, not a subagent (seen live).
		expect(
			runningStepText({
				toolCallId: "b",
				toolName: "ipython",
				args: { code: "h = bash('sleep 25 && ls -la /tmp/work')\nr = await h\nprint(r.output)" },
				status: "running",
			}),
		).not.toContain("子代理");
	});

	it("renders three tinted rows: action, tally, the last three steps", () => {
		const state = liveState();
		for (const [id, command] of [
			["1", "cat package.json"],
			["2", "ls src"],
			["3", "npm install"],
			["4", "npm test"],
		] as const) {
			state.addStep({ toolCallId: id, toolName: "bash", args: { command }, status: "queued" });
			state.setStepStatus(id, "running", T0 + Number(id) * 1_000);
			if (id !== "4") state.setStepStatus(id, "done", T0 + Number(id) * 1_000 + 500);
		}
		const rows = renderRunningCard(state, 100, 3, T0 + 20_000);
		const text = plain(rows);
		expect(text).toHaveLength(3);
		expect(text[0]?.trimEnd()).toBe(" ▌ ⠸ 正在运行 npm test · 16s");
		expect(text[1]).toContain("step 4 · 20s · 读取 package.json · 列目录 src · 运行 npm install");
		// The last three steps only: the first one scrolled off the row.
		expect(text[2]).toContain("✓ 列目录 src");
		expect(text[2]).toContain("⠸ 运行 npm test");
		expect(text[2]).not.toContain("package.json");
		// Every row is tinted to the full width, so the card reads as one block.
		for (const row of rows) expect(visibleWidth(row)).toBe(100);
		for (const row of rows) expect(row).toContain("\x1b[48;");
	});

	it("folds consecutive steps with the same label into one cell with a count", () => {
		const state = liveState();
		const wait = { code: "r = await h\nprint(r.output)" };
		for (const id of ["1", "2", "3"]) {
			state.addStep({ toolCallId: id, toolName: "ipython", args: wait, status: "queued" });
			state.setStepStatus(id, "running", T0 + Number(id) * 1_000);
			if (id !== "3") state.setStepStatus(id, "done", T0 + Number(id) * 1_000 + 500);
		}
		const recentRow = plain(renderRunningCard(state, 100, 3, T0 + 20_000))[2] ?? "";
		const label = turnStepLabel({ toolName: "ipython", args: wait });
		expect(recentRow).toContain(`${label} ×3`);
		expect(recentRow.split(label)).toHaveLength(2);
	});

	it("turns amber after a quiet minute and says for how long", () => {
		const state = liveState();
		state.addStep({ toolCallId: "srv", toolName: "bash", args: { command: "node server.js" }, status: "queued" });
		state.setStepStatus("srv", "running", T0);
		const quiet = plain(renderRunningCard(state, 100, 0, T0 + RUNNING_CARD_QUIET_MS + 140_000))[0] ?? "";
		expect(quiet).toContain("正在运行 node server.js");
		expect(quiet).toContain("3 分钟没有新输出");
		// Fresh output restarts the quiet clock.
		state.noteActivity(T0 + RUNNING_CARD_QUIET_MS + 139_000);
		const busy = plain(renderRunningCard(state, 100, 0, T0 + RUNNING_CARD_QUIET_MS + 140_000))[0] ?? "";
		expect(busy).not.toContain("没有新输出");
	});

	it("keeps the quiet warning on the first row at 80 columns behind a long step label", () => {
		const state = liveState();
		const command = "python scripts/benchmarks/run_every_model_against_the_whole_suite.py --rounds 100 --verbose";
		state.addStep({ toolCallId: "long", toolName: "bash", args: { command }, status: "queued" });
		state.setStepStatus("long", "running", T0);
		const first = plain(renderRunningCard(state, 80, 0, T0 + RUNNING_CARD_QUIET_MS + 140_000))[0] ?? "";
		expect(visibleWidth(first)).toBe(80);
		expect(first).toContain("3 分钟没有新输出");
		expect(first.indexOf("没有新输出")).toBeLessThan(first.indexOf("正在运行"));
	});

	it("shows a failure hidden inside a folded repeat", () => {
		const state = liveState();
		const wait = { code: "r = await h\nprint(r.output)" };
		for (const [id, status] of [
			["1", "error"],
			["2", "done"],
			["3", "done"],
		] as const) {
			state.addStep({ toolCallId: id, toolName: "ipython", args: wait, status: "queued" });
			state.setStepStatus(id, "running", T0 + Number(id) * 1_000);
			state.setStepStatus(id, status, T0 + Number(id) * 1_000 + 500);
		}
		const label = turnStepLabel({ toolName: "ipython", args: wait });
		const settled = plain(renderRunningCard(state, 100, 3, T0 + 20_000))[2] ?? "";
		expect(settled).toContain(`✗ ${label} ×3`);
		expect(settled).not.toContain("✓");

		state.addStep({ toolCallId: "4", toolName: "ipython", args: wait, status: "queued" });
		state.setStepStatus("4", "running", T0 + 30_000);
		const running = plain(renderRunningCard(state, 100, 3, T0 + 31_000))[2] ?? "";
		expect(running).toContain(`${label} ×4 ✗1`);
	});
});

describe("the ◆ prime header and the gutter", () => {
	it("shows the model and the turn's time, or a spinner and working while live", () => {
		expect(
			stripAnsi(
				renderAssistantHeader({ modelId: "glm-5.3-prime", durationMs: 79_000, live: false, tick: 0, width: 80 }),
			),
		).toBe(" ◆ prime  glm-5.3-prime · 1m19s");
		expect(
			stripAnsi(
				renderAssistantHeader({ modelId: "glm-5.3-prime", durationMs: 568_000, live: true, tick: 3, width: 80 }),
			),
		).toBe(" ◆ prime  glm-5.3-prime · ⠸ working 9m 28s");
	});

	it("puts the settled process line inside the AI block, on the gutter, in English", () => {
		const state = new TurnActivityState(T0);
		state.modelId = "glm-5.3-prime";
		state.addStep({ toolCallId: "a", toolName: "bash", args: { command: "npm test" }, status: "queued" });
		state.setStepStatus("a", "running", T0);
		state.setStepStatus("a", "done", T0 + 4_000);
		state.markTurnEnded(T0 + 4_000);
		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		const lines = plain(summary.render(100));
		expect(lines[0]).toBe(" ◆ prime  glm-5.3-prime · 4.0s");
		expect(lines[1]).toMatch(/^ │ ▸ 1 step {3}运行 npm test$/);
		// The footnote's click regions moved one row down and past the rail.
		const regions = summary.getClickRegions();
		expect(regions[0]).toMatchObject({ line: 0, col: 0 });
		expect(regions.slice(1).every((region) => region.line === 1 && region.col >= 2)).toBe(true);
	});

	it("renders the live turn as the header plus the running card", () => {
		const state = liveState();
		state.notePhase("waiting", T0);
		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		const lines = plain(summary.render(100));
		expect(lines[0]).toMatch(/^ ◆ prime {2}glm-5\.3-prime · \S working /);
		expect(lines[1]).toContain("正在等模型回复");
	});

	it("runs a quiet answer down the gutter rail", () => {
		const answer = new AssistantMessageComponent(
			{
				role: "assistant",
				content: [{ type: "text", text: "两个文件加起来 746 行。" }],
				api: "openai-completions",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: T0,
			},
			false,
			undefined,
			"Thinking",
			{ quiet: true },
		);
		const lines = plain(answer.render(80)).map((line) => line.replace(/\x1b\][^\x07]*\x07/g, ""));
		expect(lines.length).toBeGreaterThan(1);
		for (const line of lines) expect(line.startsWith(" │")).toBe(true);
		expect(lines.some((line) => line.startsWith(" │ 两个文件加起来 746 行。"))).toBe(true);
	});
});

describe("the user bubble", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("sits on the one-column margin with a you label and the send time", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 8, 24, 21, 0));
		const at = new Date(2026, 8, 24, 20, 14).getTime();
		const lines = new UserMessageComponent("你先看一下这个", undefined, () => false, at).render(120);
		const text = plain(lines).map((line) => line.replace(/\x1b\][^\x07]*\x07/g, ""));
		expect(text[0]).toMatch(/^ {1} {2}you {2}20:14 +$/);
		expect(text[1]).toMatch(/^ {1} {2}你先看一下这个 +$/);
		for (const line of lines) expect(visibleWidth(line)).toBe(120);
		// The bubble is tinted from column 1 to the right edge; only the margin column is not.
		const raw = lines[1]?.replace(/\x1b\][^\x07]*\x07/g, "") ?? "";
		expect(raw.startsWith(" \x1b[48;")).toBe(true);
	});

	it("says which day a message is from once it is not today's", () => {
		const now = new Date(2026, 8, 25, 9, 30).getTime();
		expect(sentAtText(new Date(2026, 8, 25, 0, 5).getTime(), now)).toBe("00:05");
		expect(sentAtText(new Date(2026, 8, 24, 23, 59).getTime(), now)).toBe("昨天 23:59");
		expect(sentAtText(new Date(2026, 8, 24, 0, 0).getTime(), now)).toBe("昨天 00:00");
		expect(sentAtText(new Date(2026, 8, 23, 20, 14).getTime(), now)).toBe("9月23日 20:14");
		expect(sentAtText(new Date(2025, 11, 31, 8, 3).getTime(), now)).toBe("2025年12月31日 08:03");
		expect(sentAtText(undefined, now)).toBe("");
	});

	it("moves a rendered bubble's label on when the day turns over", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 8, 24, 23, 58));
		const bubble = new UserMessageComponent(
			"晚上好",
			undefined,
			() => false,
			new Date(2026, 8, 24, 20, 14).getTime(),
		);
		const header = () => plain(bubble.render(80))[0]?.replace(/\x1b\][^\x07]*\x07/g, "") ?? "";
		expect(header()).toMatch(/you {2}20:14 +$/);
		vi.setSystemTime(new Date(2026, 8, 25, 0, 1));
		expect(header()).toMatch(/you {2}昨天 20:14 +$/);
	});

	it("keeps the same margin at every width, lined up with the AI header, and wraps inside the bubble", () => {
		for (const width of [120, 80, 40, 20]) expect(userBubbleIndent(width)).toBe(1);
		expect(userBubbleIndent(7)).toBe(0);
		const lines = plain(new UserMessageComponent("字".repeat(60), undefined, () => false).render(80));
		// 80 - 1 margin - 2×2 padding = 75 cells of text = 37 CJK characters per row.
		expect(lines.filter((line) => line.includes("字"))).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBe(80);
	});
});

describe("system notices", () => {
	it("centers one faint line", () => {
		const line = stripAnsi(new SystemNoticeLine("◆ python kernel restored").render(60)[0] ?? "");
		expect(line.trim()).toBe("·  ◆ python kernel restored  ·");
		const left = line.length - line.trimStart().length;
		expect(Math.abs(left - (60 - line.trim().length) / 2)).toBeLessThanOrEqual(1);
	});

	it("collapses a memory update to one line naming the entry, and expands to the diff", () => {
		const after: HarnessEntry = {
			id: "eval-progress",
			kind: "memory",
			title: "百轮评估进度",
			content: "停止，保留中间结论",
			path: "memories/eval.md",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "refinement",
			created_at: "2026-09-24T00:00:00.000Z",
			updated_at: "2026-09-24T00:00:00.000Z",
			version: 1,
		};
		const result: RefinementResult = {
			id: "r1",
			summary: "把协调记忆改写为『老板令停止』状态。",
			rationale: "",
			expectedOutcome: "",
			appliedEdits: [
				{
					action: "update",
					kind: "memory",
					id: after.id,
					title: after.title,
					content: after.content,
					after,
					applied: true,
				},
			],
			harnessStatePath: "/tmp/state.json",
			scope: "local",
		};
		const component = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(result));
		const collapsed = plain(component.render(100)).filter((line) => line.trim());
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("·  ✦ memory updated  百轮评估进度  ·  Ctrl+O diff  ·");
		// The entry's title names it; the summary's shorthand stays out of the line.
		expect(collapsed[0]).not.toContain("老板令");
		// A slug-like title (seen live: `eval100_0924百轮评估场_运行状态_评估后删`) reads as words.
		const slug = structuredClone(result);
		for (const edit of slug.appliedEdits) {
			edit.title = "eval100_0924百轮评估场_运行状态_评估后删";
			if (edit.after) edit.after.title = edit.title;
		}
		const slugLine = plain(new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(slug)).render(120))
			.filter((line) => line.trim())
			.join("");
		expect(slugLine).toContain("eval100 · 0924百轮评估场 · 运行状态 · 评估后删");
		expect(slugLine).not.toContain("_");
		component.setExpanded(true);
		const expanded = plain(component.render(100)).join("\n");
		expect(expanded).toContain("把协调记忆改写为");
		expect(expanded).toContain("百轮评估进度");
	});

	it("collapses the kernel-restored notice to the centered line", () => {
		const notice = new InjectedPromptMessageComponent({
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			content: "restored",
			display: true,
			details: { restored: true },
			timestamp: T0,
		} as never);
		const lines = plain(notice.render(60)).filter((line) => line.trim());
		expect(lines).toHaveLength(1);
		expect(lines[0]?.trim()).toBe("·  ◆ python kernel restored  ·");
	});
});

describe("spinner and ticker", () => {
	it("turns at ten frames a second and slows to a third when quiet", () => {
		expect(SPINNER_FRAMES).toHaveLength(10);
		expect(spinnerFrame(3)).toBe("⠸");
		expect(spinnerFrame(13)).toBe("⠸");
		expect(spinnerFrame(9, true)).toBe(spinnerFrame(3));
	});

	it("derives the slower ◇◈◆ marker frame from the same tick", () => {
		setWorkingPulseTick(10);
		expect(getSpinnerTick()).toBe(10);
		expect(getWorkingPulseFrame()).toBe(4);
		setWorkingPulseTick(0);
	});
});

describe("step labels", () => {
	it("says what a find looks for, never a bare 查找 .", () => {
		expect(turnStepLabel({ toolName: "bash", args: { command: "find . -name '*.ts' -type f" } })).toBe("查找 *.ts");
		expect(turnStepLabel({ toolName: "bash", args: { command: "find . -type f" } })).toBe("查找文件");
		expect(turnStepLabel({ toolName: "bash", args: { command: "find src -type f" } })).toBe("查找 src 里的文件");
		expect(turnStepLabel({ toolName: "bash", args: { command: "ls -la ." } })).toBe("列目录 当前目录");
		expect(turnStepLabel({ toolName: "bash", args: { command: "ls -la" } })).toBe("列目录 当前目录");
	});
});

describe("themes", () => {
	const dir = mkdtempSync(join(tmpdir(), "chat-layers-theme-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("renders the conversation layers in a theme written before they existed", () => {
		const legacy = {
			name: "legacy",
			colors: Object.fromEntries(
				[
					"accent",
					"border",
					"borderAccent",
					"borderMuted",
					"success",
					"error",
					"warning",
					"muted",
					"dim",
					"text",
					"thinkingText",
					"selectedBg",
					"userMessageBg",
					"userMessageText",
					"customMessageBg",
					"customMessageText",
					"customMessageLabel",
					"toolPendingBg",
					"toolSuccessBg",
					"toolErrorBg",
					"toolDiffAddedBg",
					"toolDiffRemovedBg",
					"toolPanelBg",
					"toolTitle",
					"toolOutput",
					"mdHeading",
					"mdLink",
					"mdLinkUrl",
					"mdCode",
					"mdCodeBlock",
					"mdCodeBlockBorder",
					"mdQuote",
					"mdQuoteBorder",
					"mdHr",
					"mdListBullet",
					"toolDiffAdded",
					"toolDiffRemoved",
					"toolDiffText",
					"toolDiffContext",
					"syntaxComment",
					"syntaxKeyword",
					"syntaxFunction",
					"syntaxVariable",
					"syntaxString",
					"syntaxNumber",
					"syntaxType",
					"syntaxOperator",
					"syntaxPunctuation",
					"thinkingOff",
					"thinkingMinimal",
					"thinkingLow",
					"thinkingMedium",
					"thinkingHigh",
					"thinkingXhigh",
					"bashMode",
				].map((key) => [key, "#808080"]),
			),
		};
		const path = join(dir, "legacy.json");
		writeFileSync(path, JSON.stringify(legacy));
		const legacyTheme = loadThemeFromPath(path, "truecolor");
		expect(() => legacyTheme.fg("assistantLabel", "x")).not.toThrow();
		expect(() => legacyTheme.bg("runCardBg", "x")).not.toThrow();
		expect(() => legacyTheme.getUserBubbleBackgroundColor()("x")).not.toThrow();
	});
});
