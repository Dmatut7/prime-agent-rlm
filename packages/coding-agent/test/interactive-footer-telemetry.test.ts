import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
	compactionTriggerRatio: 0.8,
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

	it("renders one persistent line: model · level, watermark bar, context figures", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);
		const lines = footer.render(120);
		expect(lines).toHaveLength(1);
		const line = stripAnsi(lines[0] ?? "");
		expect(line).toContain("bailian/glm-5.3-prime · max");
		expect(line).toContain("312k/1M · 31%");
		expect(line).toMatch(/─+●─*│/);
		expect(line).not.toContain("ctx");
		// 2026-09-22 老板令: the storm zone (⚡/390k/已越风暴线) is deleted
		// entirely from the status area - the compaction notch is the only
		// threshold state left.
		expect(line).not.toContain("⚡");
		expect(line).not.toContain("风暴");
		expect(line).not.toContain("390k");
		expect(line).not.toContain("压缩线");
	});

	it("marks the compaction state: reaching the notch adds 压缩在即, below it stays quiet", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);

		telemetry.set({ ...SNAPSHOT, contextTokens: 850_000 });
		const imminent = footerLine(footer);
		expect(imminent).toContain("850k/1M · 85%");
		expect(imminent).toContain("压缩在即");

		telemetry.set({ ...SNAPSHOT, contextTokens: 790_000 });
		const below = footerLine(footer);
		expect(below).toContain("79%");
		expect(below).not.toContain("压缩在即");
	});

	it("degrades below 80 columns: the bar goes first, then the token figures", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource();
		footer.setTelemetrySource(telemetry.source);

		const wide = footerLine(footer, 100);
		expect(wide).toContain("●");
		expect(wide).toContain("312k/1M · 31%");

		const narrow = footerLine(footer, 79);
		expect(narrow).not.toContain("●");
		expect(narrow).toContain("312k/1M · 31%");
		expect(narrow).toContain("bailian/glm-5.3-prime");

		const veryNarrow = footerLine(footer, 24);
		expect(veryNarrow).not.toContain("312k");
		expect(veryNarrow).toContain("glm-5.3-prime");
		expect(veryNarrow.length).toBeLessThanOrEqual(24);
	});

	it("off mode renders nothing", () => {
		const footer = new FooterComponent(provider);
		const telemetry = makeSource("off");
		footer.setTelemetrySource(telemetry.source);
		expect(footer.render(120)).toEqual([]);
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
			getCompactionTriggerRatio: vi.fn(() => 0.8),
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
				compactionTriggerRatio: 0.8,
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
