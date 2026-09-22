import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { FooterComponent, type FooterTelemetrySnapshot } from "../src/modes/interactive/components/footer.js";
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

	it("renders one persistent line: model · level, watermark bar, context figures", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetryMode("on");
		footer.setTelemetry(SNAPSHOT);
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
		footer.setTelemetryMode("on");

		footer.setTelemetry({ ...SNAPSHOT, contextTokens: 850_000 });
		const imminent = footerLine(footer);
		expect(imminent).toContain("850k/1M · 85%");
		expect(imminent).toContain("压缩在即");

		footer.setTelemetry({ ...SNAPSHOT, contextTokens: 790_000 });
		const below = footerLine(footer);
		expect(below).toContain("79%");
		expect(below).not.toContain("压缩在即");
	});

	it("degrades below 80 columns: the bar goes first, then the token figures", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetryMode("on");
		footer.setTelemetry(SNAPSHOT);

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
		footer.setTelemetryMode("off");
		footer.setTelemetry(SNAPSHOT);
		expect(footer.render(120)).toEqual([]);
	});

	it("coexists with the /speed line: telemetry first, speed second, both truncated", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetryMode("on");
		footer.setTelemetry(SNAPSHOT);
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
		footer.setTelemetryMode("on");
		footer.setTelemetry({ modelName: "bailian/glm-5.3-prime", contextTokens: null });
		const line = footerLine(footer);
		expect(line.trim()).toBe("bailian/glm-5.3-prime");

		footer.setTelemetry({ modelName: "bailian/deepseek-v4.1-flash" });
		expect(footerLine(footer).trim()).toBe("bailian/deepseek-v4.1-flash");
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

describe("interactive-mode telemetry snapshot wiring", () => {
	beforeAll(() => initTheme("dark"));

	it("updateFooterTelemetry composes model, level, usage, and compaction ratio", async () => {
		const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.js");
		const footer = {
			setTelemetryMode: vi.fn(),
			setTelemetry: vi.fn(),
		};
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
			footer,
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
		const update = (InteractiveMode.prototype as unknown as { updateFooterTelemetry(this: unknown): void })
			.updateFooterTelemetry;
		update.call(mode);

		expect(footer.setTelemetryMode).toHaveBeenCalledWith("on");
		expect(footer.setTelemetry).toHaveBeenCalledWith({
			modelName: "bailian/glm-5.3-prime",
			thinkingLevel: "max",
			contextTokens: 312_000,
			contextWindow: 1_000_000,
			compactionTriggerRatio: 0.8,
		});
		// The snapshot is the single context source shared with the tray fallback.
		expect(mode.footerTelemetrySnapshot).toEqual({
			modelName: "bailian/glm-5.3-prime",
			thinkingLevel: "max",
			contextTokens: 312_000,
			contextWindow: 1_000_000,
			compactionTriggerRatio: 0.8,
		});

		// Non-glm models compose identically: no per-model markers remain.
		mode.connectionState = {
			model: { id: "bailian/deepseek-v4.1-flash", reasoning: true },
			thinkingLevel: "high",
			contextUsage: undefined,
		};
		update.call(mode);
		expect(footer.setTelemetry).toHaveBeenLastCalledWith(
			expect.objectContaining({
				modelName: "bailian/deepseek-v4.1-flash",
				thinkingLevel: "high",
				contextTokens: undefined,
			}),
		);
	});
});
