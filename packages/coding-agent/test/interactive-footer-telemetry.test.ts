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
	contextTokens: 312_000,
	contextWindow: 1_000_000,
	compactionTriggerRatio: 0.8,
	glmStormTokens: 390_000,
};

describe("footer telemetry watermark (U1)", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("renders one persistent compact line: model, ctx usage, compaction line, storm zone", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetryMode("compact");
		footer.setTelemetry(SNAPSHOT);
		const line = footerLine(footer);
		expect(footer.render(120)).toHaveLength(1);
		expect(line).toContain("bailian/glm-5.3-prime");
		expect(line).toContain("ctx 312k/1M(31%)");
		expect(line).toContain("压缩线80%");
		expect(line).toContain("⚡风暴线390k");
	});

	it("full mode appends the proportional bar; off mode renders nothing", () => {
		const full = new FooterComponent(provider);
		full.setTelemetryMode("full");
		full.setTelemetry(SNAPSHOT);
		expect(footerLine(full)).toMatch(/\[[█·┊⌁]+\]/);

		const off = new FooterComponent(provider);
		off.setTelemetryMode("off");
		off.setTelemetry(SNAPSHOT);
		expect(off.render(120)).toEqual([]);
	});

	it("drops the storm marker below the GLM threshold and for non-glm-shaped windows", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetryMode("compact");
		footer.setTelemetry({ ...SNAPSHOT, contextWindow: 200_000 });
		expect(footerLine(footer)).not.toContain("风暴线");

		footer.setTelemetry({ ...SNAPSHOT, glmStormTokens: undefined });
		expect(footerLine(footer)).not.toContain("风暴线");
	});

	it("coexists with the /speed line: telemetry first, speed second, both truncated", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetryMode("compact");
		footer.setTelemetry({ ...SNAPSHOT, glmStormTokens: undefined });
		footer.setSpeedEnabled(true);
		footer.setSpeedText("88 tok/s · avg 66");
		const lines = footer.render(120).map(stripAnsi);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("ctx 312k/1M");
		expect(lines[1]).toBe("88 tok/s · avg 66");
		const narrow = footer.render(24).map(stripAnsi);
		expect(narrow).toHaveLength(2);
		for (const line of narrow) {
			expect(line.length).toBeLessThanOrEqual(24);
		}
	});

	it("unknown tokens render the model without a ctx segment", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetryMode("compact");
		footer.setTelemetry({ modelName: "bailian/glm-5.3-prime", contextTokens: null });
		const line = footerLine(footer);
		expect(line).toContain("glm-5.3-prime");
		expect(line).not.toContain("ctx");
	});
});

describe("top bar model pin (U1)", () => {
	beforeAll(() => initTheme("dark"));

	it("shows the model dimly next to the spend", () => {
		const bar = new TopBar({
			getChatName: () => "chat",
			getCostUsd: () => 0.42,
			getModel: () => "bailian/glm-5.3-prime",
		});
		const line = stripAnsi(bar.render(120).join("\n"));
		expect(line).toContain("chat");
		expect(line).toContain("$0.42");
		expect(line).toContain("glm-5.3-prime");
	});

	it("omits the model segment when unset", () => {
		const bar = new TopBar({ getChatName: () => "chat" });
		const line = stripAnsi(bar.render(120).join("\n"));
		expect(line).toContain("chat");
	});
});

describe("footer.telemetry setting", () => {
	it("defaults to compact, persists set values, and falls back on unknown values", async () => {
		const dir = mkdtempSync(join(tmpdir(), "footer-telemetry-"));
		try {
			const manager = SettingsManager.create(dir, dir);
			expect(manager.getFooterTelemetry()).toBe("compact");

			manager.setFooterTelemetry("full");
			expect(manager.getFooterTelemetry()).toBe("full");
			await manager.flush();

			// A fresh manager over the persisted file keeps the value.
			const reloaded = SettingsManager.create(dir, dir);
			expect(reloaded.getFooterTelemetry()).toBe("full");

			// Garbage in the file falls back to compact, never throws.
			writeFileSync(join(dir, "settings.json"), JSON.stringify({ footer: { telemetry: "loud" } }));
			const garbage = SettingsManager.create(dir, dir);
			expect(garbage.getFooterTelemetry()).toBe("compact");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("interactive-mode telemetry snapshot wiring", () => {
	beforeAll(() => initTheme("dark"));

	it("updateFooterTelemetry composes model, usage, compaction ratio, and the glm storm zone", async () => {
		const { InteractiveMode } = await import("../src/modes/interactive/interactive-mode.js");
		const footer = {
			setTelemetryMode: vi.fn(),
			setTelemetry: vi.fn(),
		};
		const settingsManager = {
			getFooterTelemetry: vi.fn(() => "compact"),
			getCompactionTriggerRatio: vi.fn(() => 0.8),
		};
		const mode = {
			footer,
			uiServices: { settingsManager },
			connectionState: {
				model: { id: "bailian/glm-5.3-prime" },
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

		expect(footer.setTelemetryMode).toHaveBeenCalledWith("compact");
		expect(footer.setTelemetry).toHaveBeenCalledWith({
			modelName: "bailian/glm-5.3-prime",
			contextTokens: 312_000,
			contextWindow: 1_000_000,
			compactionTriggerRatio: 0.8,
			glmStormTokens: 390_000,
		});

		// Non-glm models drop the storm zone marker.
		mode.connectionState = { model: { id: "bailian/deepseek-v4.1-flash" }, contextUsage: undefined };
		update.call(mode);
		expect(footer.setTelemetry).toHaveBeenLastCalledWith(
			expect.objectContaining({ modelName: "bailian/deepseek-v4.1-flash", glmStormTokens: undefined }),
		);
	});
});
