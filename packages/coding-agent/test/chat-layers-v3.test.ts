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
import { turnStepLabel } from "../src/modes/interactive/components/step-label.js";
import { SystemNoticeLine } from "../src/modes/interactive/components/system-notice.js";
import { formatTimelineTime } from "../src/modes/interactive/components/timeline-gutter.js";
import { timelineShowAll } from "../src/modes/interactive/components/timeline-lane.js";
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

describe("the ◆ prime header and the gutter", () => {
	it("draws a settled turn as one event line with what it did and its step count, no title and no card", () => {
		const state = new TurnActivityState(T0);
		state.modelId = "glm-5.3-prime";
		state.addStep({ toolCallId: "a", toolName: "bash", args: { command: "npm test" }, status: "queued" });
		state.setStepStatus("a", "running", T0);
		state.setStepStatus("a", "done", T0 + 4_000);
		state.markTurnEnded(T0 + 4_000);
		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		const lines = plain(summary.render(100));
		// The `◆ prime` title line and the header card (pill, clock, tokens) are gone: the summary is the event line.
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(new RegExp(`^ ${formatTimelineTime(T0)} {3}◆ {6}跑了 1 条命令 +1 步 ▸ {2}$`));
		expect(lines.join("\n")).not.toMatch(/◆ prime|✓ 完成|进行中|4秒|↓ 0/);
		// The event line is the one target and opens the step behind it.
		const regions = summary.getClickRegions().filter((region) => !region.passive);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toMatchObject({ line: 0, col: 0, width: 100 });
		regions[0]?.onClick({ line: 0, col: 0 } as never);
		const opened = plain(summary.render(100));
		expect(opened).toHaveLength(2);
		expect(opened[0]).toMatch(/1 步 ▴ {2}$/);
		expect(opened[1]).toMatch(/^ {9}│ {11}\$ {2}npm test +✓ 完成 {4}$/);
		expect(state.boxOpen).toBe(true);
	});

	it("draws the live turn as the spinner line that says what it is doing, with nothing to open yet", () => {
		const state = liveState();
		state.notePhase("waiting", T0);
		const summary = new TurnSummaryComponent(state);
		summary.setQuiet(true);
		const lines = plain(summary.render(100));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^ \d\d:\d\d {3}[⠀-⣿] {6}等待模型回应… *$/);
		expect(lines.join("\n")).not.toMatch(/◆ prime|进行中/);
		expect(summary.getClickRegions()).toHaveLength(0);
		expect(summary.getFocusOrder()).toHaveLength(0);
	});

	it("runs a quiet answer under its box as the timeline summary, its words on column 16", () => {
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
		for (const line of lines) expect(line.startsWith(" │")).toBe(false);
		expect(lines.some((line) => /^ \d\d:\d\d {3}◆ {6}总结$/.test(line.trimEnd()))).toBe(true);
		expect(lines.some((line) => line.trimEnd() === "         ┃      两个文件加起来 746 行。")).toBe(true);
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

	it("hides the background memory tidy by default; the full process shows it as one note that expands to the diff", () => {
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
		expect(component.render(100)).toEqual([]);
		timelineShowAll.set(true);
		try {
			const collapsed = plain(component.render(100)).filter((line) => line.includes("回合后整理记忆"));
			expect(collapsed).toHaveLength(1);
			expect(collapsed[0]).toMatch(/^ \d\d:\d\d {3}· {6}回合后整理记忆：改了 1 条（本会话） +展开 ▸ {2}$/);
			// The entry's title names it once opened; the summary's shorthand stays out of the row.
			expect(collapsed[0]).not.toContain("老板令");
			// A slug-like title (seen live: `eval100_0924百轮评估场_运行状态_评估后删`) reads as words.
			const slug = structuredClone(result);
			for (const edit of slug.appliedEdits) {
				edit.title = "eval100_0924百轮评估场_运行状态_评估后删";
				if (edit.after) edit.after.title = edit.title;
			}
			const slugComponent = new RefinementOutcomeMessageComponent(createRefinementOutcomeMessage(slug));
			slugComponent.setExpanded(true);
			const slugText = plain(slugComponent.render(120)).join("\n");
			expect(slugText).toContain("eval100 0924百轮评估场 运行状态 评估后删");
			expect(slugText).not.toContain("_");
			component.setExpanded(true);
			const expanded = plain(component.render(100)).join("\n");
			expect(expanded).toContain("把协调记忆改写为");
			expect(expanded).toContain("百轮评估进度");
		} finally {
			timelineShowAll.set(false);
		}
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
		expect(lines[0]?.trim()).toBe("·  ◆ Python 环境已恢复  ·");
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
