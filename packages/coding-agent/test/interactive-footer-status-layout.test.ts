import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	FooterComponent,
	type FooterTelemetrySnapshot,
	TOOL_ERROR_WARN_THRESHOLD,
} from "../src/modes/interactive/components/footer.js";
import {
	renderSubagentSpendCell,
	SubagentSummaryLine,
	TrayInfoLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { TopBar } from "../src/modes/interactive/components/top-bar.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * Status-area layout pins, top to bottom around the editor:
 * ① the hint line above the editor - status on the left (`深度 0`, goal,
 *    heartbeats, the context fallback only while footer.telemetry=off), the
 *    keys that work right now on the right (`Ctrl+O 过程 · Ctrl+T Thinking`),
 * ③ (right under the editor) the subagent strip: one row of blocks, here the
 *    counts block `◇ 子代理 3  运行 1 · 收口 2` and `↓ 选一个进去看`,
 * ② (last) the status line `glm-5.3-prime · max   ~/repo · main   ──●──│──  518k/1M · 49%`.
 * One fact one home: the model lives only in ②, the context figures only in ②
 * (fallback in ① while ② is off), the sub-agents only in ③, and the sub-agent
 * money on the status bar's right side (see grow-bottom-status.test.ts).
 */

const SNAPSHOT: FooterTelemetrySnapshot = {
	modelName: "bailian/glm-5.3-prime",
	thinkingLevel: "max",
	contextTokens: 518_000,
	contextWindow: 1_048_576,
	compactionThresholdTokens: 838_861,
};

const provider = { getGitBranch: () => null, getExtensionStatuses: () => new Map() } as never;

const spendFigures = { cost: 961.72, tokens: 592_000_000, parentCost: 273.44, unpriced: [], partial: false };

function statusStack(options: {
	telemetry: "off" | "on";
	counts?: { total: number; running: number; idle: number; inactive: number };
	spend?: Parameters<SubagentSummaryLine["setSubagentSpend"]>[0];
	statusLabel?: string;
	hints?: string[];
	width?: number;
}): string[] {
	const width = options.width ?? 110;
	const topBar = new TopBar({ getChatName: () => "调试会话-003" });
	const info = new TrayInfoLine(
		() => options.statusLabel ?? "深度 0",
		() => options.hints ?? ["Ctrl+O 过程", "Ctrl+T Thinking", "← 会话列表", "? 快捷键"],
		() => undefined,
	);
	const footer = new FooterComponent(provider);
	footer.setTelemetrySource(() => ({ mode: options.telemetry, snapshot: SNAPSHOT }));
	const subagents = new SubagentSummaryLine();
	if (options.counts) subagents.setSubagentCounts(options.counts);
	if (options.spend) subagents.setSubagentSpend(options.spend);
	subagents.setOpenable(true);
	return [topBar, info, subagents, footer].flatMap((component) => component.render(width).map(stripAnsi));
}

describe("U6 status area layout", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("renders the bottom stack exactly as designed: hint line, strip, status line", () => {
		const lines = statusStack({
			telemetry: "on",
			counts: { total: 3, running: 1, idle: 0, inactive: 2 },
			spend: { cost: 961.72, tokens: 592_000_000, parentCost: 273.44, unpriced: [], partial: false },
		});
		const nonEmpty = lines.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
		expect(nonEmpty).toHaveLength(4); // top bar, ①, ③ (strip), ②
		expect(nonEmpty[1]).toMatch(/^ 深度 0 +Ctrl\+O 过程 · Ctrl\+T Thinking · ← 会话列表 · \? 快捷键$/);
		expect(visibleWidth(lines[1] ?? "")).toBe(110);
		expect(nonEmpty[2]).toContain("运行 1 · 收口 2");
		expect(nonEmpty[2]).toContain("↓ 选一个进去看");
		// The money is not on the strip any more: it rides the status bar.
		expect(nonEmpty[2]).not.toContain("¥");
		expect(nonEmpty[3]).toContain("glm-5.3-prime · max");
		expect(nonEmpty[3]).toMatch(/●/);
		expect(nonEmpty[3]).toContain("518k/1M · 49%");
	});

	it("keeps one home per fact: no duplicate model name, no double context display", () => {
		const lines = statusStack({
			telemetry: "on",
			counts: { total: 3, running: 1, idle: 0, inactive: 2 },
			spend: { cost: 961.72, tokens: 592_000_000, parentCost: 273.44, unpriced: [], partial: false },
		});
		const joined = lines.join("\n");
		expect(joined.match(/glm-5\.3-prime/g)).toHaveLength(1);
		expect(joined.match(/518k\/1M/g)).toHaveLength(1);
		expect(joined.match(/49%/g)).toHaveLength(1);
		// The top bar carries neither the model, the context figures, nor money
		// (评审①: the spend cell is money's only home; /usage carries the detail).
		expect(lines[0]).not.toContain("glm");
		expect(lines[0]).not.toContain("518k");
		expect(lines[0]).not.toContain("$");
		// Money has one home too: the status bar's right side, which this stack (the
		// watermark footer) does not include.
		expect(joined).not.toContain("¥");
		// ① carries neither while the footer line is on.
		expect(lines[1]).not.toContain("518k");
		expect(lines[1]).not.toContain("glm");
	});

	it("falls back to the footer's own snapshot on ①'s right side while telemetry is off", async () => {
		const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.js");
		const fallback = (
			InteractiveMode.prototype as unknown as {
				getTrayContextFallbackLabel(this: unknown): string | undefined;
			}
		).getTrayContextFallbackLabel;
		const mode: Record<string, unknown> = {
			uiServices: { settingsManager: { getFooterTelemetry: () => "on" } },
			footerTelemetryDirty: false,
			footerTelemetryCached: { mode: "on", snapshot: SNAPSHOT },
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		expect(fallback.call(mode)).toBeUndefined();

		// Same memoized pair the footer line renders (评审②): the fallback reads
		// the cache, not a fresh query, so the two readouts share one frame.
		mode.footerTelemetryCached = { mode: "off", snapshot: SNAPSHOT };
		expect(fallback.call(mode)).toBe("518k/1M (49%)");

		mode.footerTelemetryCached = { mode: "off", snapshot: { ...SNAPSHOT, contextTokens: 530_000 } };
		expect(fallback.call(mode)).toBe("530k/1M (51%)");

		mode.footerTelemetryCached = { mode: "off", snapshot: undefined };
		expect(fallback.call(mode)).toBeUndefined();
	});

	it("hides the whole subagents line without children and skips zero-count classes", () => {
		const hidden = new SubagentSummaryLine();
		hidden.setSubagentCounts({ total: 0, running: 0, idle: 0, inactive: 0 });
		hidden.setOpenable(true);
		expect(hidden.render(110)).toEqual([]);

		const lines = statusStack({
			telemetry: "on",
			counts: { total: 1, running: 1, idle: 0, inactive: 0 },
		});
		const subagentLine = lines.find((line) => line.includes("运行")) ?? "";
		expect(subagentLine).toContain("◇ 子代理 1");
		expect(subagentLine).toContain("运行 1");
		expect(subagentLine).not.toContain("空闲");
		expect(subagentLine).not.toContain("收口");
	});

	it("degrades gracefully: footer drops the bar first then the figures; ③ truncates", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(() => ({ mode: "on", snapshot: SNAPSHOT }));
		// ` bailian/glm-5.3-prime · max` (28) + gap (2) + bar (16+2) + `518k/1M · 49% ` (14).
		expect(stripAnsi(footer.render(62).join(""))).toContain("●");
		const noBar = stripAnsi(footer.render(61).join(""));
		expect(noBar).not.toContain("●");
		expect(noBar).toContain("518k/1M · 49%");
		expect(stripAnsi(footer.render(43).join(""))).not.toContain("518k");

		const subagents = new SubagentSummaryLine();
		subagents.setSubagentCounts({ total: 3, running: 1, idle: 0, inactive: 2 });
		subagents.setOpenable(true);
		for (const width of [40, 24, 12, 6, 3, 2, 1]) {
			for (const line of subagents.render(width).map(stripAnsi)) {
				expect(line.length).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps every line within the width while the tool-error badge rides the status line", () => {
		// The badge `⚠ 工具错误×N` is CJK-heavy: 工具错误 is 8 columns but 4 code
		// units. The watermark budget used to subtract the badge's `.length` and
		// overflow the line by exactly those 4 columns (显示-1).
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(() => ({ mode: "on", snapshot: SNAPSHOT }));
		footer.setToolErrorCount(TOOL_ERROR_WARN_THRESHOLD);
		const widths = [110, 80, 62, 61, 50, 43, 30, 20, 12, 8, 5];
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			for (const line of footer.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
		expect(stripAnsi(footer.render(110).join("\n"))).toContain(`⚠ 工具错误×${TOOL_ERROR_WARN_THRESHOLD}`);
	});

	it("keeps the compaction state the only threshold: 即将压缩 at the notch", () => {
		const footer = new FooterComponent(provider);
		let snapshot: FooterTelemetrySnapshot = { ...SNAPSHOT, contextTokens: 900_000 };
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		const imminent = stripAnsi(footer.render(110).join(""));
		expect(imminent).toContain("即将压缩");
		expect(imminent).toContain("86%");

		snapshot = { ...SNAPSHOT, contextTokens: 200_000 };
		expect(stripAnsi(footer.render(110).join(""))).not.toContain("即将压缩");
	});

	it("pins the typographic discipline across the status lines", () => {
		const lines = statusStack({
			telemetry: "on",
			counts: { total: 3, running: 1, idle: 0, inactive: 2 },
			spend: { cost: 961.72, tokens: 592_000_000, parentCost: 273.44, unpriced: [], partial: false },
		}).filter((line) => line.trim().length > 0);
		const statusLines = lines.slice(1).join("\n"); // everything but the chat-name header

		// `·` separates same-kind segments; no comma mixing. The `｜` group separator
		// went with the money cell, which moved to the status bar.
		expect(statusLines).toContain(" · ");
		expect(statusLines).not.toContain("｜");
		expect(statusLines).not.toMatch(/[,，]/);
		// Half-width digits with no internal spaces in every figure.
		expect(statusLines).not.toMatch(/\d[ ]+\d/);
		expect(statusLines).not.toContain("¥");
		expect(statusLines).toContain("518k/1M");
		const cell = stripAnsi(renderSubagentSpendCell(spendFigures)[0] ?? "");
		expect(cell).toBe("子代理 ¥961.72 · 全部 ¥1235.16");
		expect(cell).not.toMatch(/\d[ ]+\d/);
		// Icon whitelist for the status lines: ● (bar level), ↓ (open hint), ◇ (the strip's block).
		// Deleted decorations must stay gone: no storm glyph, no Σ/▍/◐/○, no box.
		for (const banned of ["⚡", "⌁", "█", "Σ", "▍", "◐", "○", "╭", "╰", "subagents"]) {
			expect(statusLines).not.toContain(banned);
		}
		expect(statusLines).toContain("●");
		expect(statusLines).toContain("◇");
		expect(statusLines).toContain("↓ 选一个进去看");
		// English status words are gone; the counts read 运行/空闲/收口.
		expect(statusLines).not.toMatch(/\b(running|idle|inactive|select|open)\b/);
		expect(statusLines).toContain("运行 1");
		expect(statusLines).toContain("收口 2");
	});

	it("relocates every signal to its home line and loses none when ③ hides (评审⑤)", () => {
		// ① carries the transient override notices (Ctrl+C exit / queue hint) on
		// its left even with no status and no hints: the only content on the line.
		const overrideOnly = new TrayInfoLine(
			() => undefined,
			() => [],
			() => "再按一次 Ctrl+C 退出",
		);
		const overrideLine = stripAnsi(overrideOnly.render(110).join("\n"));
		expect(overrideLine.trim()).toBe("再按一次 Ctrl+C 退出");

		// The override wins over the status label, and the hints stay on the right.
		const overrideWithStatus = new TrayInfoLine(
			() => "深度 1",
			() => ["Esc 中断"],
			() => "再按一次 Ctrl+C 退出",
		);
		const overrideWithStatusLine = stripAnsi(overrideWithStatus.render(110).join("\n"));
		expect(overrideWithStatusLine).toContain("再按一次 Ctrl+C 退出");
		expect(overrideWithStatusLine).not.toContain("深度 1");
		expect(overrideWithStatusLine.endsWith("Esc 中断 ")).toBe(true);

		// ①'s left side carries goal/heartbeat while they run (K3 S3).
		const withGoal = new TrayInfoLine(
			() => "Pursuing goal (12m) · 2 heartbeats · 深度 0",
			() => ["Ctrl+O 过程"],
			() => undefined,
		);
		const goalLine = stripAnsi(withGoal.render(110).join("\n"));
		expect(goalLine.startsWith(" Pursuing goal (12m) · 2 heartbeats · 深度 0")).toBe(true);
		expect(goalLine.endsWith("Ctrl+O 过程 ")).toBe(true);

		// Nothing to say: the line renders nothing at all.
		expect(
			new TrayInfoLine(
				() => undefined,
				() => [],
				() => undefined,
			).render(110),
		).toEqual([]);

		// The U2 badge owns ②'s tail while telemetry is on and stands alone
		// when it is off - either way the signal survives ③ hiding.
		const badgeWithTelemetry = new FooterComponent(provider);
		badgeWithTelemetry.setTelemetrySource(() => ({ mode: "on", snapshot: SNAPSHOT }));
		badgeWithTelemetry.setToolErrorCount(4);
		expect(stripAnsi(badgeWithTelemetry.render(110).join("\n"))).toContain("⚠ 工具错误×4");

		const badgeAlone = new FooterComponent(provider);
		badgeAlone.setTelemetrySource(() => ({ mode: "off", snapshot: SNAPSHOT }));
		badgeAlone.setToolErrorCount(4);
		const alone = stripAnsi(badgeAlone.render(110).join("\n"));
		expect(alone).toContain("⚠ 工具错误×4");

		// /speed owns its own line under ② while enabled.
		badgeWithTelemetry.setSpeedEnabled(true);
		badgeWithTelemetry.setSpeedText("88 tok/s · avg 66");
		const speedLines = badgeWithTelemetry.render(110).map(stripAnsi);
		expect(speedLines).toHaveLength(2);
		expect(speedLines[1]).toBe("88 tok/s · avg 66");

		// A stall with no row of its own is a red block in ③'s one row - which is exactly when subagents exist.
		const stalled = new SubagentSummaryLine();
		stalled.setSubagentCounts({ total: 2, running: 2, idle: 0, inactive: 0 });
		stalled.setStallMarkers(["worker: stalled 214s, in-flight: ipython"]);
		const stallLines = stalled.render(110).map(stripAnsi);
		expect(stallLines).toHaveLength(1);
		expect(stallLines[0]).toContain("运行 2");
		expect(stallLines[0]).toContain("⚠ worker 卡住");
	});

	it("drops hints whole from the end when the hint line is too narrow", () => {
		const line = new TrayInfoLine(
			() => "深度 0",
			() => ["Ctrl+O 过程", "Ctrl+T Thinking", "? 快捷键"],
			() => undefined,
		);
		const full = stripAnsi(line.render(60).join(""));
		expect(full.endsWith("Ctrl+O 过程 · Ctrl+T Thinking · ? 快捷键 ")).toBe(true);
		const two = stripAnsi(line.render(42).join(""));
		expect(two.endsWith("Ctrl+O 过程 · Ctrl+T Thinking ")).toBe(true);
		expect(two).not.toContain("快捷键");
		const none = stripAnsi(line.render(10).join(""));
		expect(none.trim()).toBe("深度 0");
		for (const width of [60, 40, 34, 30, 24, 20, 16, 12, 8]) {
			const text = stripAnsi(line.render(width).join(""));
			expect(text).not.toMatch(/Ctrl\+$/);
			expect(visibleWidth(text)).toBeLessThanOrEqual(width);
		}
	});

	it("clips a wide family's counts block before anything else and never past the width", () => {
		const subagents = new SubagentSummaryLine();
		// A wide family - dynamic, long count string (the case a fixed-width
		// pin cannot catch).
		subagents.setSubagentCounts({ total: 60, running: 12, idle: 3, inactive: 45 });
		subagents.setSubagentSpend({
			cost: 961.72,
			tokens: 592_000_000,
			parentCost: 273.44,
			unpriced: [],
			partial: false,
		});
		subagents.setOpenable(true);
		for (const width of [40, 36, 32, 30, 28, 26]) {
			const rendered = subagents.render(width);
			expect(rendered).toHaveLength(1);
			const line = stripAnsi(rendered[0] ?? "");
			expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(width);
			// The block itself is the way in (clickable, selectable); the dim hint is what gives way.
			expect(line).toContain("子代理 60");
			expect(line).not.toContain("选一个进去看");
		}
		const at30 = stripAnsi(subagents.render(30)[0] ?? "");
		// The 60-strong family's counts no longer fit whole at 30 - they truncate.
		expect(at30).toContain("…");
		// With room, the hint is back at the end.
		expect(
			stripAnsi(subagents.render(110)[0] ?? "")
				.trimEnd()
				.endsWith("↓ 选一个进去看"),
		).toBe(true);
	});

	it("reads as one row with the family block and hint, and still fits 80 (F7, DS2)", () => {
		const subagents = new SubagentSummaryLine();
		subagents.setSubagentCounts({ total: 3, running: 1, idle: 0, inactive: 2 });
		subagents.setSubagentSpend({
			cost: 961.72,
			tokens: 592_000_000,
			parentCost: 273.44,
			unpriced: [],
			partial: false,
		});
		subagents.setOpenable(true);
		const rendered = subagents.render(80);
		expect(rendered).toHaveLength(1);
		const at80 = stripAnsi(rendered[0] ?? "");
		// ` ◇ 子代理 3  运行 1 · 收口 2 `: one block, the hint right-anchored, no rule, no money.
		expect(at80).toMatch(/^ {2}◇ 子代理 3 {2}运行 1 · 收口 2 /);
		expect(at80.trimEnd().endsWith("↓ 选一个进去看")).toBe(true);
		expect(at80).not.toContain("…");
		expect(at80).not.toContain("─");
		expect(at80).not.toContain("¥");
	});

	it("keeps the strip inside every width with no truncation fragments (评审④)", () => {
		const subagents = new SubagentSummaryLine();
		subagents.setSubagentCounts({ total: 3, running: 1, idle: 0, inactive: 2 });
		subagents.setSubagentSpend({
			cost: 961.72,
			tokens: 592_000_000,
			parentCost: 273.44,
			unpriced: [],
			partial: false,
		});
		subagents.setOpenable(true);
		// Every group renders at 80.
		const at80 = stripAnsi(subagents.render(80)[0] ?? "");
		expect(at80).toContain("运行 1 · 收口 2");
		expect(at80).toContain("↓ 选一个进去看");
		expect(at80).not.toContain("…");

		// Every width fits, and no width shows a half money figure: the strip
		// never shows money (the status bar's cell drops whole forms).
		for (const width of [100, 80, 72, 56, 40, 30, 12]) {
			const lines = subagents.render(width).map(stripAnsi);
			expect(lines).toHaveLength(1);
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(width);
				expect(line).not.toContain("¥");
			}
		}
	});

	it("focused ③ keeps the Enter open affordance without the ↓ hint", () => {
		const subagents = new SubagentSummaryLine();
		subagents.setSubagentCounts({ total: 3, running: 1, idle: 0, inactive: 2 });
		subagents.setOpenable(true);
		subagents.focused = true;
		const line = stripAnsi(subagents.render(110).join(""));
		expect(line).toContain("Enter 进去");
		expect(line).not.toContain("选一个进去看");
	});
});
