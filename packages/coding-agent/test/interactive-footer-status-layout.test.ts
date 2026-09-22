import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { FooterComponent, type FooterTelemetrySnapshot } from "../src/modes/interactive/components/footer.js";
import { SubagentSummaryLine, TrayInfoLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { TopBar } from "../src/modes/interactive/components/top-bar.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * U6 status-area layout pins: the three lines under the editor are
 * ① `← agents/resume · 深度 0` (pure navigation, context fallback only while
 *    footer.telemetry=off, reading the footer's own snapshot),
 * ② the footer watermark `glm-5.3-prime · max    ──────●───────│──    518k/1M · 49%`,
 * ③ `  运行 1 · 空闲 0 · 收口 2    子代理 ¥961.72 · 592M tok ｜ 全部 ¥1235.16    ↓ 选择`.
 * One fact one home: the model lives only in ②, the context figures only in ②
 * (fallback in ① while ② is off), the sub-agents only in ③.
 */

const SNAPSHOT: FooterTelemetrySnapshot = {
	modelName: "bailian/glm-5.3-prime",
	thinkingLevel: "max",
	contextTokens: 518_000,
	contextWindow: 1_048_576,
	compactionThresholdTokens: 838_861,
};

const provider = { getGitBranch: () => null } as never;

function statusStack(options: {
	telemetry: "off" | "on";
	counts?: { total: number; running: number; idle: number; inactive: number };
	spend?: Parameters<SubagentSummaryLine["setSubagentSpend"]>[0];
	locationLabel?: string;
	contextLabel?: string;
	width?: number;
}): string[] {
	const width = options.width ?? 110;
	const topBar = new TopBar({ getChatName: () => "调试会话-003" });
	const info = new TrayInfoLine(
		() => options.locationLabel ?? "← agents/resume · 深度 0",
		() => options.contextLabel,
		() => undefined,
	);
	const footer = new FooterComponent(provider);
	footer.setTelemetrySource(() => ({ mode: options.telemetry, snapshot: SNAPSHOT }));
	const subagents = new SubagentSummaryLine();
	if (options.counts) subagents.setSubagentCounts(options.counts);
	if (options.spend) subagents.setSubagentSpend(options.spend);
	subagents.setOpenable(true);
	return [topBar, info, footer, subagents].flatMap((component) => component.render(width).map(stripAnsi));
}

describe("U6 status area layout", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("renders the three-line bottom stack exactly as designed", () => {
		const lines = statusStack({
			telemetry: "on",
			counts: { total: 3, running: 1, idle: 0, inactive: 2 },
			spend: { cost: 961.72, tokens: 592_000_000, parentCost: 273.44, unpriced: [], partial: false },
		});
		const nonEmpty = lines.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
		expect(nonEmpty).toHaveLength(4); // top bar, ①, ②, ③
		expect(nonEmpty[1]).toBe("← agents/resume · 深度 0");
		expect(nonEmpty[2]).toContain("glm-5.3-prime · max");
		expect(nonEmpty[2]).toMatch(/●/);
		expect(nonEmpty[2]).toContain("518k/1M · 49%");
		expect(nonEmpty[3]).toContain("运行 1 · 收口 2");
		expect(nonEmpty[3]).toContain("子代理 ¥961.72 · 592M tok ｜ 全部 ¥1235.16");
		expect(nonEmpty[3]).toContain("↓ 选择");
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
		expect(joined.match(/¥/g)).toHaveLength(2); // the ③ line's two figures only
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
		expect(subagentLine).toContain("运行 1");
		expect(subagentLine).not.toContain("空闲");
		expect(subagentLine).not.toContain("收口");
	});

	it("degrades gracefully: footer drops the bar first then the figures; ③ truncates", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(() => ({ mode: "on", snapshot: SNAPSHOT }));
		expect(stripAnsi(footer.render(80).join(""))).toContain("●");
		const below80 = stripAnsi(footer.render(79).join(""));
		expect(below80).not.toContain("●");
		expect(below80).toContain("518k/1M · 49%");

		const subagents = new SubagentSummaryLine();
		subagents.setSubagentCounts({ total: 3, running: 1, idle: 0, inactive: 2 });
		subagents.setOpenable(true);
		for (const width of [40, 24, 12, 6, 3, 2, 1]) {
			for (const line of subagents.render(width).map(stripAnsi)) {
				expect(line.length).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps the compaction state the only threshold: 压缩在仅 at the notch", () => {
		const footer = new FooterComponent(provider);
		let snapshot: FooterTelemetrySnapshot = { ...SNAPSHOT, contextTokens: 900_000 };
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		const imminent = stripAnsi(footer.render(110).join(""));
		expect(imminent).toContain("压缩在即");
		expect(imminent).toContain("86%");

		snapshot = { ...SNAPSHOT, contextTokens: 200_000 };
		expect(stripAnsi(footer.render(110).join(""))).not.toContain("压缩在即");
	});

	it("pins the typographic discipline across the status lines", () => {
		const lines = statusStack({
			telemetry: "on",
			counts: { total: 3, running: 1, idle: 0, inactive: 2 },
			spend: { cost: 961.72, tokens: 592_000_000, parentCost: 273.44, unpriced: [], partial: false },
		}).filter((line) => line.trim().length > 0);
		const statusLines = lines.slice(1).join("\n"); // everything but the chat-name header

		// `·` separates same-kind segments, `｜` separates groups; no comma mixing.
		expect(statusLines).toContain(" · ");
		expect(statusLines).toContain("｜");
		expect(statusLines).not.toMatch(/[,，]/);
		// Half-width digits with no internal spaces in every figure.
		expect(statusLines).not.toMatch(/\d[ ]+\d/);
		expect(statusLines).toContain("¥961.72");
		expect(statusLines).toContain("¥1235.16");
		expect(statusLines).toContain("518k/1M");
		// Icon whitelist for the status lines: ● (bar level), ↓ (open hint).
		// Deleted decorations must stay gone: no storm glyph, no Σ/▍/◐/○, no box.
		for (const banned of ["⚡", "⌁", "█", "Σ", "▍", "◐", "○", "╭", "╰", "subagents"]) {
			expect(statusLines).not.toContain(banned);
		}
		expect(statusLines).toContain("●");
		expect(statusLines).toContain("↓ 选择");
		// English status words are gone; the counts read 运行/空闲/收口.
		expect(statusLines).not.toMatch(/\b(running|idle|inactive|select|open)\b/);
		expect(statusLines).toContain("运行 1");
		expect(statusLines).toContain("收口 2");
	});

	it("relocates every signal to its home line and loses none when ③ hides (评审⑤)", () => {
		// ① carries the transient override notices (Ctrl+C exit / queue hint) on
		// its left even with no navigation, no goal, and no context fallback:
		// the only content on the line.
		const overrideOnly = new TrayInfoLine(
			() => undefined,
			() => undefined,
			() => "Press Ctrl+C again to exit",
		);
		const overrideLine = stripAnsi(overrideOnly.render(110).join("\n"));
		expect(overrideLine).toContain("Press Ctrl+C again to exit");

		// ①'s right side carries goal/heartbeat while they run (K3 S3).
		const withGoal = new TrayInfoLine(
			() => "← agents/resume · 深度 0",
			() => "Pursuing goal (12m) · 2 heartbeats",
			() => undefined,
		);
		const goalLine = stripAnsi(withGoal.render(110).join("\n"));
		expect(goalLine).toContain("← agents/resume · 深度 0");
		expect(goalLine).toContain("Pursuing goal (12m) · 2 heartbeats");

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

		// Stall markers ride under ③ - which is exactly when subagents exist.
		const stalled = new SubagentSummaryLine();
		stalled.setSubagentCounts({ total: 2, running: 2, idle: 0, inactive: 0 });
		stalled.setStallMarkers(["stalled 214s, in-flight: ipython"]);
		const stallLines = stalled.render(110).map(stripAnsi);
		expect(stallLines[0]).toContain("运行 2");
		expect(stallLines[1]).toContain("⚠ stalled 214s");
	});

	it("states the two-key division in one global hint line at the chat tail", async () => {
		const { ExpandKeysHintLine } = await import("../src/modes/interactive/components/expand-keys-hint.js");
		let hasContent = false;
		const line = new ExpandKeysHintLine(() => hasContent);
		expect(line.render(100)).toEqual([]);

		hasContent = true;
		const rendered = stripAnsi(line.render(100).join("\n"));
		// `Ctrl+T 思考 · Ctrl+O 过程 · Ctrl+P 消息` — one dim line, the only
		// place the key division is stated.
		expect(rendered).toContain("Ctrl+T 思考 · Ctrl+O 过程 · Ctrl+P 消息");
		expect(rendered).not.toContain("展开");
		// It never grows beyond one line.
		expect(line.render(100)).toHaveLength(1);

		// F4 (DS2): the hint degrades by whole segments - no mid-key fragments.
		const twoSegments = stripAnsi(line.render(30).join("\n"));
		expect(twoSegments).toBe(" Ctrl+T 思考 · Ctrl+O 过程");
		const oneSegment = stripAnsi(line.render(20).join("\n"));
		expect(oneSegment).toBe(" Ctrl+T 思考");
		// Below one full segment: nothing - no half keys.
		expect(line.render(10)).toEqual([]);
		for (const width of [40, 34, 30, 24, 20, 16, 12, 8]) {
			const text = stripAnsi(line.render(width).join("\n"));
			expect(text).not.toMatch(/Ctrl\+$/);
		}
	});

	it("protects the ↓ 选择 entry: figures truncate before the hint does (F5, DS2)", () => {
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
			const line = stripAnsi(subagents.render(width)[0] ?? "");
			expect(line.length).toBeLessThanOrEqual(width);
			// The entry survives at every width; the counts/spend truncate.
			expect(line).toContain("↓ 选择");
		}
		const at30 = stripAnsi(subagents.render(30)[0] ?? "");
		// The 60-strong family's counts no longer fit whole at 30 - they
		// truncate, and the entry still ends the line's content.
		expect(at30).toContain("…");
		expect(at30.trimEnd().endsWith("↓ 选择")).toBe(true);
	});

	it("matches the watermark line's four-space group rhythm and still fits 80 (F7, DS2)", () => {
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
		const at80 = stripAnsi(subagents.render(80)[0] ?? "");
		// The same GROUP_GAP rhythm as ②: four spaces between the counts and
		// the spend cell (the hint stays right-anchored, padding flexes).
		expect(at80).toContain("收口 2    子代理");
		expect(at80).toContain("全部 ¥1235.16");
		expect(at80).toContain("↓ 选择");
		expect(at80).not.toContain("…");
	});

	it("keeps the full ③ line inside 80 columns with no truncation fragments (评审④)", () => {
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
		// The DS-measured 82-column overflow is gone: every group renders at 80.
		const at80 = stripAnsi(subagents.render(80)[0] ?? "");
		expect(at80).toContain("运行 1 · 收口 2");
		expect(at80).toContain("子代理 ¥961.72 · 592M tok ｜ 全部 ¥1235.16");
		expect(at80).toContain("↓ 选择");
		expect(at80).not.toContain("…");

		// The degradation ladder is the ③ line's primary constraint (评审④):
		// every width fits, and money drops whole rungs - never a half figure.
		for (const width of [100, 80, 72, 56, 40, 30, 12]) {
			const lines = subagents.render(width).map(stripAnsi);
			for (const line of lines) {
				expect(line.length).toBeLessThanOrEqual(width);
				expect(line).not.toMatch(/¥[0-9]*…/);
			}
		}
		// At a width where the cell no longer fits, it is dropped whole.
		const tight = stripAnsi(subagents.render(30)[0] ?? "");
		expect(tight).not.toContain("¥9");
	});

	it("focused ③ keeps the Enter/→ open affordance without the ↓ hint", () => {
		const subagents = new SubagentSummaryLine();
		subagents.setSubagentCounts({ total: 3, running: 1, idle: 0, inactive: 2 });
		subagents.setOpenable(true);
		subagents.focused = true;
		const line = stripAnsi(subagents.render(110).join(""));
		expect(line).toContain("打开");
		expect(line).not.toContain("选择");
	});
});
