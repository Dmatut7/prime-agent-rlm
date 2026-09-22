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
	compactionTriggerRatio: 0.8,
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
	footer.setTelemetryMode(options.telemetry);
	footer.setTelemetry(SNAPSHOT);
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
			footerTelemetrySnapshot: SNAPSHOT,
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		expect(fallback.call(mode)).toBeUndefined();

		mode.uiServices = { settingsManager: { getFooterTelemetry: () => "off" } };
		// Same figures the footer line renders: 518k/1M and the same percent,
		// parenthesized per the ① spec.
		expect(fallback.call(mode)).toBe("518k/1M (49%)");

		// A stale-less single source: the label tracks the snapshot, not a fresh query.
		mode.footerTelemetrySnapshot = { ...SNAPSHOT, contextTokens: 530_000 };
		expect(fallback.call(mode)).toBe("530k/1M (51%)");

		mode.footerTelemetrySnapshot = undefined;
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
		footer.setTelemetryMode("on");
		footer.setTelemetry(SNAPSHOT);
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
		footer.setTelemetryMode("on");
		footer.setTelemetry({ ...SNAPSHOT, contextTokens: 900_000 });
		const imminent = stripAnsi(footer.render(110).join(""));
		expect(imminent).toContain("压缩在即");
		expect(imminent).toContain("86%");

		footer.setTelemetry({ ...SNAPSHOT, contextTokens: 200_000 });
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
