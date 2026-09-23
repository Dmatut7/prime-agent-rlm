import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	FooterComponent,
	type FooterTelemetrySnapshot,
	type FooterTelemetrySource,
} from "../src/modes/interactive/components/footer.js";
import { TopBar } from "../src/modes/interactive/components/top-bar.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const provider = { getGitBranch: () => null } as never;

function footerLine(component: FooterComponent, width = 120): string {
	return stripAnsi(component.render(width).join("\n"));
}

const SNAPSHOT: FooterTelemetrySnapshot = {
	modelName: "bailian/glm-5.3-prime",
	thinkingLevel: "max",
	contextTokens: 312_000,
	contextWindow: 1_000_000,
	compactionThresholdTokens: 800_000,
};

describe("footer telemetry watermark (U6)", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	/** 评审②: a mutable pull source - the pair re-reads on every render. */
	function makeSource(mode: "off" | "on" = "on") {
		let snapshot: FooterTelemetrySnapshot | undefined = SNAPSHOT;
		let reads = 0;
		const source = (): FooterTelemetrySource => {
			reads += 1;
			return { mode, snapshot };
		};
		return {
			source,
			get reads() {
				return reads;
			},
			set(next: FooterTelemetrySnapshot | undefined) {
				snapshot = next;
			},
		};
	}

	it("renders one persistent line: model · level left, context figures right-aligned", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);
		const lines = footer.render(120);
		expect(lines).toHaveLength(1);
		const line = stripAnsi(lines[0] ?? "");
		expect(line.startsWith(" bailian/glm-5.3-prime · max")).toBe(true);
		expect(line.endsWith("312k/1M · 31% ")).toBe(true);
		expect(line).toHaveLength(120);
		// Below half the compaction threshold the bar stays hidden.
		expect(line).not.toContain("●");
		expect(line).not.toContain("│");
		expect(line).not.toContain("ctx");
		expect(line).not.toContain("⚡");
		expect(line).not.toContain("风暴");
		expect(line).not.toContain("390k");
	});

	it("shows the watermark bar before the figures from half the compaction threshold", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);
		telemetry.set({ ...SNAPSHOT, contextTokens: 399_000 });
		expect(footerLine(footer)).not.toContain("●");
		telemetry.set({ ...SNAPSHOT, contextTokens: 400_000 });
		const line = footerLine(footer);
		expect(line).toMatch(/─*●─*│─* {2}400k\/1M · 40% $/);
	});

	it("shows the cwd and branch between the model and the figures", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);
		footer.setLocationSource(() => ({ cwd: join(homedir(), "work", "repo"), branch: "main" }));
		const line = footerLine(footer);
		expect(line).toContain("bailian/glm-5.3-prime · max   ~/work/repo · main");
		expect(line.endsWith("312k/1M · 31% ")).toBe(true);

		footer.setLocationSource(() => ({ cwd: "/srv/app", branch: null }));
		expect(footerLine(footer)).toContain("max   /srv/app ");
		expect(footerLine(footer)).not.toContain("/srv/app ·");
	});

	it("marks the compaction state: reaching the notch adds 即将压缩, below it stays quiet", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);

		telemetry.set({ ...SNAPSHOT, contextTokens: 850_000 });
		const imminent = footerLine(footer);
		expect(imminent).toContain("850k/1M · 85%");
		expect(imminent).toContain("即将压缩");

		telemetry.set({ ...SNAPSHOT, contextTokens: 790_000 });
		const below = footerLine(footer);
		expect(below).toContain("79%");
		expect(below).not.toContain("即将压缩");
	});

	it("degrades narrow widths: the location goes first, then the bar, then the figures", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);
		footer.setLocationSource(() => ({ cwd: "/srv/some/long/project/path", branch: "feature/branch" }));
		telemetry.set({ ...SNAPSHOT, contextTokens: 500_000 });

		const wide = footerLine(footer, 120);
		expect(wide).toContain("/srv/some/long/project/path");
		expect(wide).toContain("●");
		expect(wide).toContain("500k/1M · 50%");

		const noLocation = footerLine(footer, 70);
		expect(noLocation).not.toContain("/srv");
		expect(noLocation).toContain("●");
		expect(noLocation).toContain("500k/1M · 50%");

		const noBar = footerLine(footer, 50);
		expect(noBar).not.toContain("●");
		expect(noBar).toContain("500k/1M · 50%");
		expect(noBar).toContain("bailian/glm-5.3-prime");

		const veryNarrow = footerLine(footer, 24);
		expect(veryNarrow).not.toContain("500k");
		expect(veryNarrow).toContain("glm-5.3");
		expect(veryNarrow.length).toBeLessThanOrEqual(24);
	});

	it("off mode renders nothing", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource("off");
		footer.setTelemetrySource(telemetry.source);
		expect(footer.render(120)).toEqual([]);
	});

	it("never lets the error badge truncate the watermark into a fake number (F1, DS2)", () => {
		// The badge shares the line, so the watermark's ladder runs against the
		// width the badge leaves - whole segments drop, never half figures.
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(() => ({
			mode: "on",
			snapshot: {
				modelName: "anthropic/claude-3-7-sonnet-20250219",
				thinkingLevel: "max",
				contextTokens: 518_000,
				contextWindow: 1_048_576,
				compactionThresholdTokens: 800_000,
			},
		}));
		footer.setToolErrorCount(3);
		for (const width of [80, 82, 84]) {
			const line = stripAnsi(footer.render(width).join("\n"));
			// The badge present, the figures whole-or-absent: no lone "5", no
			// "518k/1M · 5", no dangling separator.
			expect(line).toContain("⚠ 工具错误×3");
			expect(line).not.toMatch(/\d[ ·]*⚠/);
			if (line.includes("518k/1M")) {
				expect(line).toContain("518k/1M · 49%");
			} else {
				expect(line).not.toContain("518k");
				expect(line).not.toMatch(/\b\d+\b(?!\.\d)/);
			}
			expect(line.length).toBeLessThanOrEqual(width);
		}
	});

	it("coexists with the /speed line: telemetry first, speed second, both truncated", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);
		footer.setSpeedEnabled(true);
		footer.setSpeedText("88 tok/s · avg 66");
		const lines = footer.render(120).map(stripAnsi);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("312k/1M");
		expect(lines[1]).toBe("88 tok/s · avg 66");
		const narrow = footer.render(24).map(stripAnsi);
		expect(narrow).toHaveLength(2);
		for (const line of narrow) {
			expect(line.length).toBeLessThanOrEqual(24);
		}
	});

	it("unknown tokens render the model without figures; no level renders the bare model", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);

		telemetry.set({ modelName: "bailian/glm-5.3-prime", contextTokens: null });
		const line = footerLine(footer);
		expect(line.trim()).toBe("bailian/glm-5.3-prime");

		telemetry.set({ modelName: "bailian/deepseek-v4.1-flash" });
		expect(footerLine(footer).trim()).toBe("bailian/deepseek-v4.1-flash");
	});

	it("reads the real compaction threshold: ratio-driven, reserve-capped, off when disabled (评审③)", () => {
		const footer = new FooterComponent(provider);
		let snapshot: FooterTelemetrySnapshot = {
			...SNAPSHOT,
			compactionThresholdTokens: 600_000,
			contextTokens: 620_000,
		};
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		// A 0.6-configured threshold lights 即将压缩 at 62%, not only at 80%.
		const ratioSix = footerLine(footer);
		expect(ratioSix).toContain("即将压缩");
		expect(ratioSix).toContain("620k/1M · 62%");

		// Below that same threshold: quiet.
		snapshot = { ...SNAPSHOT, compactionThresholdTokens: 600_000, contextTokens: 560_000 };
		expect(footerLine(footer)).not.toContain("即将压缩");

		snapshot = { ...SNAPSHOT, compactionThresholdTokens: 0, contextTokens: 950_000 };
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		// Threshold compaction off: no notch, no tail - even at 95%.
		const off = footerLine(footer, 100);
		expect(off).not.toContain("即将压缩");
		expect(off).not.toContain("│");
		expect(off).toContain("950k/1M");
	});

	it("recomputes the memo after a settings reload and after usage lands (P2-D)", async () => {
		const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.js");
		const settingsManager = {
			getFooterTelemetry: vi.fn(() => "on"),
			getCompactionEnabled: vi.fn(() => true),
			getHideThinkingBlock: vi.fn(() => false),
			getShowHardwareCursor: vi.fn(() => true),
			getClearOnShrink: vi.fn(() => false),
			getEditorPaddingX: vi.fn(() => 1),
			getAutocompleteMaxVisible: vi.fn(() => 5),
			getCompactionSettings: vi.fn(() => ({
				enabled: true,
				reserveTokens: 0,
				keepRecentTokens: 0,
				triggerRatio: 0.8,
			})),
		};
		const mode: Record<string, unknown> = {
			uiServices: { settingsManager, getInitialCwd: vi.fn(() => "/tmp") },
			connectionState: {
				model: { id: "bailian/glm-5.3-prime", reasoning: true },
				thinkingLevel: "max",
				contextUsage: { tokens: 518_000, contextWindow: 1_048_576, percent: 49 },
			},
			activityTracker: { getStatus: () => ({ tokens: 0 }) },
			isAgentStreaming: () => false,
			contextUsageTokenBaseline: 0,
			footer: { invalidate: vi.fn(), setAutoCompactEnabled: vi.fn() },
			hideThinkingBlock: false,
			footerDataProvider: { setCwd: vi.fn() },
			ui: {
				setShowHardwareCursor: vi.fn(),
				setClearOnShrink: vi.fn(),
			},
			defaultEditor: { setPaddingX: vi.fn(), setAutocompleteMaxVisible: vi.fn() },
		};
		// `editor` defaults to `defaultEditor`: the rebind branch stays skipped.
		mode.editor = mode.defaultEditor;
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const source = (
			InteractiveMode.prototype as unknown as {
				getFooterTelemetrySource(this: unknown): FooterTelemetrySource;
			}
		).getFooterTelemetrySource;
		const invalidate = (
			InteractiveMode.prototype as unknown as {
				invalidateFooterTelemetry(this: unknown): void;
			}
		).invalidateFooterTelemetry;
		const applyRuntimeSettings = (
			InteractiveMode.prototype as unknown as {
				applyRuntimeSettings(this: unknown): void;
			}
		).applyRuntimeSettings;

		const first = source.call(mode);
		// A settings reload drops the memo: the next read recomputes (P2-D①).
		applyRuntimeSettings.call(mode);
		const second = source.call(mode);
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
		expect(mode.footerTelemetryDirty).toBe(false);

		// A usage refresh drops it again after the fresh stats patch (P2-D②):
		// the leading invalidation alone would leave the in-flight frame's memo.
		invalidate.call(mode);
		expect(mode.footerTelemetryDirty).toBe(true);
	});

	it("renders the level at the bar-end notch and ellipsizes the model (P1-A edge, P1-C)", () => {
		const footer = new FooterComponent(provider);
		// A 0.95 threshold puts the notch on the last cell; from ~93% the level
		// also rounds there. The level renders IN the notch cell (warning once
		// imminent) instead of vanishing off the bar.
		let snapshot: FooterTelemetrySnapshot = {
			...SNAPSHOT,
			contextTokens: 940_000,
			compactionThresholdTokens: 950_000,
		};
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		const below = footerLine(footer, 100);
		expect(below).toContain("940k/1M · 94%");
		expect(below).not.toContain("即将压缩");

		snapshot = { ...SNAPSHOT, contextTokens: 960_000, compactionThresholdTokens: 950_000 };
		const imminent = footerLine(footer, 100);
		expect(imminent).toContain("即将压缩");
		// The level marker survives at the fused cell (plain-text ● present).
		expect(imminent).toContain("●");

		// P1-C: the model-name truncation carries an ellipsis, never a hard cut.
		const long = new FooterComponent(provider);
		long.setTelemetrySource(() => ({
			mode: "on",
			snapshot: { ...SNAPSHOT, modelName: "anthropic/claude-3-7-sonnet-20250219" },
		}));
		expect(footerLine(long, 40)).toContain("…");
	});

	it("drops the bar before the figures; the warning never stands alone (F8, DS2)", () => {
		const footer = new FooterComponent(provider);
		// A 43-character model name at the 80-column floor: the full form
		// overflows, and the ladder keeps the figures (numbers) while dropping
		// the bar - never bar-without-numbers.
		footer.setTelemetrySource(() => ({
			mode: "on",
			snapshot: {
				modelName: "anthropic/claude-3-7-sonnet-20250219-x-max-ffn",
				thinkingLevel: "max",
				contextTokens: 850_000,
				contextWindow: 1_048_576,
				compactionThresholdTokens: 800_000,
			},
		}));
		const line = footerLine(footer, 84);
		expect(line).toContain("850k/1M · 81%");
		expect(line).toContain("即将压缩");
		expect(line).not.toContain("●");
		expect(line).not.toContain("│");

		// Narrower still: the model alone - no 即将压缩 and no figures at all
		// (the model id's digits are not usage numbers).
		const bare = footerLine(footer, 30);
		expect(bare).not.toContain("即将压缩");
		expect(bare).not.toContain("%");
		expect(bare).not.toContain("/1M");
	});

	it("never renders a 1000k figure next to a 1M window (F6, DS2)", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(() => ({ mode: "on", snapshot: { ...SNAPSHOT, contextTokens: 999_600 } }));
		const line = footerLine(footer, 100);
		expect(line).toContain("1M/1M · 100%");
		expect(line).not.toContain("1000k");
		// 999,400 still reads as k - the promotion is only the half-k edge.
		footer.setTelemetrySource(() => ({ mode: "on", snapshot: { ...SNAPSHOT, contextTokens: 999_400 } }));
		expect(footerLine(footer, 100)).toContain("999k/1M");
	});

	it("keeps the notch visible through the whole collision band around the threshold (F3, DS2)", () => {
		const footer = new FooterComponent(provider);
		let snapshot: FooterTelemetrySnapshot = { ...SNAPSHOT, contextTokens: 800_000 };
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		// Around the threshold (78%-84% with a 0.8 ratio) the level rounds onto
		// the notch's cell; the notch keeps its cell and the level takes the
		// next - the crossing stays readable instead of the ● eating the │.
		for (const tokens of [795_000, 800_000, 805_000, 810_000, 840_000]) {
			snapshot = { ...SNAPSHOT, contextTokens: tokens };
			const line = footerLine(footer, 100);
			expect(line).toContain("│");
			if (tokens >= 800_000) {
				expect(line).toContain("即将压缩");
			} else {
				expect(line).not.toContain("即将压缩");
			}
		}
	});

	it("pulls the source once per render (评审②: one frame, one value)", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);
		footer.render(120);
		expect(telemetry.reads).toBe(1);
		footer.render(120);
		expect(telemetry.reads).toBe(2);
	});
});

describe("top bar (U6: model pin removed)", () => {
	beforeAll(() => initTheme("dark"));

	it("centers the chat name with no model and no spend segment", () => {
		const bar = new TopBar({
			getChatName: () => "chat",
		});
		const line = stripAnsi(bar.render(120).join("\n"));
		expect(line).toContain("chat");
		expect(line).not.toContain("$");
		expect(line).not.toContain("¥");
		expect(line).not.toContain("glm");
	});
});

describe("footer.telemetry setting", () => {
	it("defaults to on, persists set values, and folds legacy/garbage values", async () => {
		const dir = mkdtempSync(join(tmpdir(), "footer-telemetry-"));
		try {
			const manager = SettingsManager.create(dir, dir);
			expect(manager.getFooterTelemetry()).toBe("on");

			manager.setFooterTelemetry("off");
			expect(manager.getFooterTelemetry()).toBe("off");
			await manager.flush();

			// A fresh manager over the persisted file keeps the value.
			const reloaded = SettingsManager.create(dir, dir);
			expect(reloaded.getFooterTelemetry()).toBe("off");

			// Legacy compact/full merge to "on"; garbage falls back to "on", never throws.
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ footer: { telemetry: "compact" } }));
			expect(SettingsManager.create(dir, dir).getFooterTelemetry()).toBe("on");
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ footer: { telemetry: "full" } }));
			expect(SettingsManager.create(dir, dir).getFooterTelemetry()).toBe("on");
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ footer: { telemetry: "loud" } }));
			expect(SettingsManager.create(dir, dir).getFooterTelemetry()).toBe("on");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("interactive-mode telemetry source wiring (评审②)", () => {
	beforeAll(() => initTheme("dark"));

	it("getFooterTelemetrySource memoizes one pair and recomputes only after invalidation", async () => {
		const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.js");
		const settingsManager = {
			getFooterTelemetry: vi.fn(() => "on"),
			getCompactionSettings: vi.fn(() => ({
				enabled: true,
				reserveTokens: 0,
				keepRecentTokens: 0,
				triggerRatio: 0.8,
			})),
		};
		type FakeConnectionState = {
			model: { id: string; reasoning?: boolean };
			thinkingLevel?: string;
			contextUsage?: { tokens: number; contextWindow: number; percent: number };
		};
		const mode: Record<string, unknown> & { connectionState: FakeConnectionState } = {
			uiServices: { settingsManager },
			connectionState: {
				model: { id: "bailian/glm-5.3-prime", reasoning: true },
				thinkingLevel: "max",
				contextUsage: { tokens: 312_000, contextWindow: 1_000_000, percent: 31 },
			},
			activityTracker: { getStatus: () => ({ tokens: 0 }) },
			isAgentStreaming: () => false,
			contextUsageTokenBaseline: 0,
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const source = (
			InteractiveMode.prototype as unknown as {
				getFooterTelemetrySource(this: unknown): FooterTelemetrySource;
			}
		).getFooterTelemetrySource;
		const invalidate = (
			InteractiveMode.prototype as unknown as {
				invalidateFooterTelemetry(this: unknown): void;
			}
		).invalidateFooterTelemetry;

		const first = source.call(mode);
		expect(first).toEqual({
			mode: "on",
			snapshot: {
				modelName: "bailian/glm-5.3-prime",
				thinkingLevel: "max",
				contextTokens: 312_000,
				contextWindow: 1_000_000,
				compactionThresholdTokens: 800_000,
			},
		});
		// Memoized: every reader this frame gets the same object identity.
		expect(source.call(mode)).toBe(first);
		expect(settingsManager.getFooterTelemetry).toHaveBeenCalledTimes(1);

		// Invalidate + changed state -> one recomputation for the next frame.
		invalidate.call(mode);
		mode.connectionState = {
			model: { id: "bailian/deepseek-v4.1-flash", reasoning: true },
			thinkingLevel: "high",
			contextUsage: undefined,
		};
		const second = source.call(mode);
		expect(second).not.toBe(first);
		expect(second.snapshot).toEqual(
			expect.objectContaining({
				modelName: "bailian/deepseek-v4.1-flash",
				thinkingLevel: "high",
				contextTokens: undefined,
			}),
		);
		expect(settingsManager.getFooterTelemetry).toHaveBeenCalledTimes(2);
	});

	it("the tray fallback renders the same memoized pair the footer line renders", async () => {
		const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.js");
		const settingsManager = {
			getFooterTelemetry: vi.fn(() => "off"),
			getCompactionTriggerRatio: vi.fn(() => 0.8),
		};
		const mode: Record<string, unknown> = {
			uiServices: { settingsManager },
			connectionState: {
				model: { id: "bailian/glm-5.3-prime", reasoning: true },
				thinkingLevel: "max",
				contextUsage: { tokens: 518_000, contextWindow: 1_048_576, percent: 49 },
			},
			activityTracker: { getStatus: () => ({ tokens: 0 }) },
			isAgentStreaming: () => false,
			contextUsageTokenBaseline: 0,
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const fallback = (
			InteractiveMode.prototype as unknown as {
				getTrayContextFallbackLabel(this: unknown): string | undefined;
			}
		).getTrayContextFallbackLabel;

		// Same figures the footer line would render (one frame, one value):
		// 518k/1M and the same percent, parenthesized per the ① spec.
		expect(fallback.call(mode)).toBe("518k/1M (49%)");
	});
});
