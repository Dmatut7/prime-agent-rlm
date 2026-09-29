import { type Component, Container, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { FooterComponent, renderStatusBar, type StatusBarState } from "../src/modes/interactive/components/footer.js";
import {
	renderSubagentSpendCell,
	type SubagentPanelRow,
	type SubagentSpendSummary,
	SubagentSummaryLine,
} from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

/**
 * The bottom of the screen, top to bottom: hint line, prompt, subagent strip,
 * status line. The status line carries the subagent spend; it drops its own
 * subagent chip while the strip shows a block per child.
 */

initTheme("dark");
setKeybindings(new KeybindingsManager());

function spend(overrides: Partial<SubagentSpendSummary> = {}): SubagentSpendSummary {
	return { cost: 4.56, tokens: 12_300_000, parentCost: 0.54, unpriced: [], partial: false, ...overrides };
}

const plain = (text: string | readonly string[]): string =>
	stripAnsi(Array.isArray(text) ? text.join("\n") : String(text));

describe("the spend cell for the status line", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("reads 子代理 ¥X · 全部 ¥Y with the money in the accent color", () => {
		const forms = renderSubagentSpendCell(spend());
		expect(forms.length).toBeGreaterThan(0);
		expect(plain(forms[0] ?? "")).toBe("子代理 ¥4.56 · 全部 ¥5.10");
		expect(forms[0]).toContain(theme.fg("accent", "¥4.56"));
	});

	it("gives nothing for no data or an all-zero total, never a ¥0.00", () => {
		expect(renderSubagentSpendCell(undefined)).toEqual([]);
		expect(renderSubagentSpendCell(spend({ cost: 0, tokens: 0, parentCost: 0 }))).toEqual([]);
	});

	it("marks a partial scan as a lower bound on every figure", () => {
		const forms = renderSubagentSpendCell(spend({ partial: true }));
		expect(plain(forms[0] ?? "")).toBe("子代理 ≈¥4.56 · 全部 ≈¥5.10");
	});

	it("shows tokens and the warning instead of ¥0.00 when nothing is priced", () => {
		const forms = renderSubagentSpendCell(
			spend({ cost: 0, tokens: 8_100_000, parentCost: 0, unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }] }),
		);
		expect(plain(forms[0] ?? "")).toBe("子代理 8.1M tok (kimi-k3 8.1M tok 未定价)");
		expect(forms[0]).toContain(theme.fg("warning", "(kimi-k3 8.1M tok 未定价)"));
		expect(plain(forms.join("\n"))).not.toContain("¥");
	});

	it("loses one thing per form, in a fixed order, and ends on the figure alone", () => {
		const forms = renderSubagentSpendCell(
			spend({
				unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }],
				overridePriced: [{ model: "qwen3.8-flash", tokens: 2_000_000 }],
			}),
		).map(plain);
		expect(forms).toEqual([
			"子代理 ¥4.56 · 全部 ¥5.10 (kimi-k3 8.1M tok 未定价) (qwen3.8-flash 2.0M tok 已改价)",
			"子代理 ¥4.56 (kimi-k3 8.1M tok 未定价) (qwen3.8-flash 2.0M tok 已改价)",
			"子代理 ¥4.56 (kimi-k3 未定价) (qwen3.8-flash 已改价)",
			"子代理 ¥4.56?",
		]);
	});

	it("has a single form when there is nothing to drop", () => {
		expect(renderSubagentSpendCell(spend({ cost: 0, tokens: 1_000, parentCost: 0 })).map(plain)).toEqual([
			"子代理 1.0k tok",
		]);
	});
});

describe("the status line's layout with a spend cell", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	const working = "⠹ 工作中 1分 · ↓ 7.1k";
	const forms = renderSubagentSpendCell(spend({ unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }] })).map(plain);
	const right = [
		...forms.map((form) => `${working} · ${form} · Esc 停止`),
		`${working} · Esc 停止`,
		working,
		"⠹ 工作中 1分",
	];
	const state: StatusBarState = {
		model: "glm-5.3-prime",
		level: "中",
		context: { percent: 33, warn: false },
		subagents: 0,
		right,
		spendForms: forms.length,
	};

	it("puts the spend after the clock and the tokens and before Esc 停止 when there is room", () => {
		const bar = plain(renderStatusBar(state, 240));
		expect(bar).toContain("↓ 7.1k · 子代理 ¥4.56 · 全部 ¥5.10");
		expect(bar.indexOf("子代理 ¥")).toBeLessThan(bar.indexOf("Esc 停止"));
	});

	it("drops the spend before the model or the run's state lose anything, whole figures only", () => {
		const widths = Array.from({ length: 22 }, (_, index) => 200 - index * 8);
		expect(widths.length).toBeGreaterThan(0);
		let gone = false;
		let droppedWhileStateIntact = false;
		for (const width of widths) {
			const bar = plain(renderStatusBar(state, width));
			expect(visibleWidth(bar), `width ${width}`).toBeLessThanOrEqual(width);
			const hasSpend = bar.includes("¥");
			if (hasSpend) {
				expect(gone, `spend came back at ${width}`).toBe(false);
				expect(bar).toMatch(/子代理 ¥4\.56/);
				expect(bar).toContain("glm-5.3-prime");
				expect(bar).toContain("工作中 1分");
			} else {
				gone = true;
				if (bar.includes("glm-5.3-prime · 思考 中") && bar.includes("↓ 7.1k · Esc 停止")) {
					droppedWhileStateIntact = true;
				}
			}
			expect(bar, `width ${width}`).not.toMatch(/¥[0-9.]*$/);
		}
		expect(gone).toBe(true);
		expect(droppedWhileStateIntact).toBe(true);
	});

	it("keeps the old ladder untouched without a spend cell", () => {
		const plainState: StatusBarState = { ...state, spendForms: 0, right: right.slice(forms.length) };
		const bar = plain(renderStatusBar(plainState, 160));
		expect(bar).toContain("↓ 7.1k · Esc 停止");
		expect(bar).not.toContain("¥");
		expect(plain(renderStatusBar(plainState, 80))).toContain("工作中 1分");
	});
});

/** An interactive mode with just what the status line reads; the rest is not touched by it. */
function statusHost(options: {
	strip: SubagentSummaryLine;
	running: number;
	working?: boolean;
	connectionLost?: boolean;
	/** A run that just ended, 20 minutes long with 286k output tokens. */
	finished?: boolean;
}) {
	const host = Object.create(InteractiveMode.prototype) as InteractiveMode & Record<string, unknown>;
	Object.assign(host, {
		getCurrentModel: () => ({ id: "glm-5.3-prime", reasoning: false }),
		connectionState: { thinkingLevel: "medium" },
		getConnectionContextUsage: () => undefined,
		footerDataProvider: { getGitBranch: () => null },
		getCurrentCwd: () => "/work/app",
		subagentSummaryLine: options.strip,
		subagentCounts: { total: options.running, running: options.running, idle: 0, inactive: 0 },
		footerToast: undefined,
		currentTurnState: undefined,
		isAgentStreaming: () => options.working ?? false,
		isAgentCompacting: () => false,
		workingStartedAt: options.working ? Date.now() - 86_000 : undefined,
		turnStartedAt: undefined,
		activityTracker: { getStatus: () => ({ tokens: 7_100 }) },
		sessionOutputTokens: undefined,
		connectionLost: options.connectionLost ?? false,
		// The turn flow is created on demand from the live store; a stand-in with no live box and no finished turn.
		liveTurnFlowStore: {
			hasLiveBox: () => false,
			lastFinished: options.finished
				? {
						timeline: { stopped: false, errorEnded: false, outputTokens: () => 286_000 },
						turnDurationMs: () => 20 * 60_000,
					}
				: undefined,
		},
	});
	const getState = Reflect.get(InteractiveMode.prototype, "getStatusBarState") as (
		this: typeof host,
	) => StatusBarState | undefined;
	const footer = new FooterComponent({ getGitBranch: () => null } as never);
	footer.setStatusBarSource(() => getState.call(host));
	return { host, footer, bar: (width: number) => plain(footer.render(width)) };
}

function stripWith(rows: readonly SubagentPanelRow[], counts = rows.length): SubagentSummaryLine {
	const strip = new SubagentSummaryLine();
	strip.setSubagentCounts({ total: counts, running: counts, idle: 0, inactive: 0 });
	strip.setSubagentRows(rows);
	strip.setOpenable(true);
	return strip;
}

const twoRows: SubagentPanelRow[] = [
	{ id: "a", name: "review", state: "running" },
	{ id: "b", name: "docs", state: "running" },
];

describe("the status line as the interactive mode drives it", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("leaves out 个子代理在跑 while the strip shows a block per child", () => {
		const { bar } = statusHost({ strip: stripWith(twoRows), running: 2, working: true });
		const text = bar(160);
		expect(text).toContain("glm-5.3-prime");
		expect(text).toContain("工作中");
		expect(text).not.toContain("个子代理在跑");
		expect(text).not.toContain("◇");
	});

	it("says nothing about the place, the branch or the session total, working or done", () => {
		const working = statusHost({ strip: stripWith(twoRows), running: 2, working: true }).bar(160);
		expect(working).toMatch(/^ glm-5\.3-prime {20,}\S 工作中 1分 · ↓ 7\.1k · Esc 停止 {2}$/u);
		const done = statusHost({ strip: stripWith(twoRows), running: 0, finished: true }).bar(160);
		expect(done).toMatch(/^ glm-5\.3-prime {20,}✓ 完成 · 20 分钟 · ↓ 286k {2}$/u);
		for (const text of [working, done]) {
			expect(visibleWidth(text)).toBe(160);
			expect(text).not.toContain("/work/app");
			expect(text).not.toContain("本会话");
		}
	});

	it("keeps it when the strip has no blocks to show (the roster counts the family but no snapshot does)", () => {
		const { bar } = statusHost({ strip: stripWith([], 2), running: 2, working: true });
		expect(bar(160)).toContain("◇ 2 个子代理在跑");
	});

	it("shows the family's spend between the run's figures and Esc 停止, and only once there is a figure", () => {
		const strip = stripWith(twoRows);
		const { bar } = statusHost({ strip, running: 2, working: true });
		expect(bar(200)).not.toContain("¥");
		strip.setSubagentSpend(spend());
		const text = bar(200);
		expect(text).toContain("↓ 7.1k · 子代理 ¥4.56 · 全部 ¥5.10 · ");
		expect(text.indexOf("子代理 ¥")).toBeLessThan(text.indexOf("Esc 停止"));
		strip.setSubagentSpend(undefined);
		expect(bar(200)).not.toContain("¥");
	});

	it("drops the spend before the model, the clock or the token count on a narrow screen", () => {
		const strip = stripWith(twoRows);
		strip.setSubagentSpend(spend({ unpriced: [{ model: "kimi-k3", tokens: 8_100_000 }] }));
		const { bar } = statusHost({ strip, running: 2, working: true });
		let spendGone = false;
		let stateIntactAfterSpend = false;
		const widths = Array.from({ length: 30 }, (_, index) => 220 - index * 6);
		expect(widths.length).toBeGreaterThan(0);
		for (const width of widths) {
			const text = bar(width);
			expect(visibleWidth(text), `width ${width}`).toBeLessThanOrEqual(width);
			if (text.includes("¥")) {
				expect(spendGone, `spend back at ${width}`).toBe(false);
				expect(text).toContain("glm-5.3-prime");
				expect(text).toContain("工作中 ");
				expect(text).toMatch(/子代理 ¥4\.56/);
			} else if (!spendGone) {
				spendGone = true;
				// The first width without the spend still has the whole run state.
				stateIntactAfterSpend = text.includes("glm-5.3-prime") && /工作中 [^ ]+ · ↓ 7\.1k/.test(text);
			}
		}
		expect(spendGone).toBe(true);
		expect(stateIntactAfterSpend).toBe(true);
	});

	it("shows the spend on an idle screen too, and not once the connection is lost", () => {
		const strip = stripWith(twoRows);
		strip.setSubagentSpend(spend());
		expect(statusHost({ strip, running: 2 }).bar(160)).toContain("子代理 ¥4.56 · 全部 ¥5.10");
		const lost = statusHost({ strip, running: 2, connectionLost: true }).bar(160);
		expect(lost).toContain("和后台的连接断了");
		expect(lost).not.toContain("¥");
	});
});

describe("the legacy watermark line", () => {
	const snapshot = {
		modelName: "glm-5.3-prime",
		thinkingLevel: "max",
		contextTokens: 518_000,
		contextWindow: 1_048_576,
		compactionThresholdTokens: 838_861,
	};

	function watermark(withSpend: boolean): FooterComponent {
		const footer = new FooterComponent({ getGitBranch: () => null } as never);
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		footer.setLocationSource(() => ({ cwd: "/work/app", branch: "main" }));
		if (withSpend) footer.setSpendSource(() => renderSubagentSpendCell(spend()));
		return footer;
	}

	it("shows the subagent spend before the context figures when it fits", () => {
		const line = plain(watermark(true).render(200));
		expect(line).toContain("子代理 ¥4.56 · 全部 ¥5.10");
		expect(line.indexOf("子代理")).toBeLessThan(line.indexOf("518k/1M"));
		expect(plain(watermark(false).render(200))).not.toContain("¥");
	});

	it("drops the spend whole before the location, the bar or the figures lose anything", () => {
		// (the ladder's first step without the spend keeps location, bar and figures)
		const footer = watermark(true);
		const widths = Array.from({ length: 30 }, (_, index) => 200 - index * 5);
		expect(widths.length).toBeGreaterThan(0);
		let gone = false;
		let figuresKept = false;
		for (const width of widths) {
			const text = plain(footer.render(width));
			expect(visibleWidth(text), `width ${width}`).toBeLessThanOrEqual(width);
			if (text.includes("¥")) {
				expect(gone, `spend back at ${width}`).toBe(false);
				expect(text).toMatch(/子代理 ¥4\.56( · 全部 ¥5\.10)?/);
				expect(text).toContain("518k/1M");
			} else if (!gone) {
				gone = true;
				figuresKept = text.includes("518k/1M · 49%") && text.includes("/work/app · main") && text.includes("●");
			}
		}
		expect(gone).toBe(true);
		expect(figuresKept).toBe(true);
	});
});

describe("the prompt area's order", () => {
	function stack() {
		const names = new Map<Component, string>();
		const named = (name: string): Container => {
			const container = new Container();
			names.set(container, name);
			return container;
		};
		const parts = {
			trayInfoLine: named("hint line"),
			editorContainer: named("prompt"),
			subagentSummaryLine: named("subagent strip"),
			footerSlot: named("status line"),
			widgetContainerBelow: named("widgets below"),
			footer: named("footer"),
			mainContainer: named("main"),
			promptDock: named("dock"),
		};
		const mode = Object.assign(Object.create(InteractiveMode.prototype), parts) as InteractiveMode;
		const read = (container: Container) => container.children.map((child) => names.get(child));
		return { mode, parts, read };
	}

	it("stacks the fullscreen dock as hint line, prompt, subagent strip, status line", () => {
		const { mode, parts } = stack();
		const dock = Reflect.get(InteractiveMode.prototype, "getPromptDockComponents") as (
			this: InteractiveMode,
		) => Component[];
		const order = dock.call(mode);
		expect(order).toHaveLength(4);
		expect(order[0]).toBe(parts.trayInfoLine);
		expect(order[1]).toBe(parts.editorContainer);
		expect(order[2]).toBe(parts.subagentSummaryLine);
		expect(order[3]).toBe(parts.footerSlot);
	});

	it("builds the main view and the fullscreen dock in that same order", () => {
		const { mode, parts, read } = stack();
		const mount = Reflect.get(InteractiveMode.prototype, "mountPromptArea") as (this: InteractiveMode) => void;
		mount.call(mode);
		expect(read(parts.mainContainer)).toEqual([
			"hint line",
			"prompt",
			"subagent strip",
			"status line",
			"widgets below",
		]);
		expect(read(parts.promptDock)).toEqual(["hint line", "prompt", "subagent strip", "status line"]);
		expect(read(parts.footerSlot)).toEqual(["footer"]);
	});
});
