import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { collectUnknownSettingsKeys, SettingsManager } from "../src/core/settings-manager.js";
import {
	FooterComponent,
	type FooterTelemetrySnapshot,
	type FooterTelemetrySource,
} from "../src/modes/interactive/components/footer.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const provider = { getGitBranch: () => null, getExtensionStatuses: () => new Map() } as never;

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

function sourceWith(snapshot: FooterTelemetrySnapshot): () => FooterTelemetrySource {
	return () => ({ mode: "on", snapshot });
}

describe("watermark session spend segment (footer.sessionSpend)", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("renders 本次 ¥… ahead of the context figures when the snapshot carries sessionCost", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(sourceWith({ ...SNAPSHOT, sessionCost: 4.2 }));
		const line = footerLine(footer, 120);
		expect(line).toContain("本次 ¥4.20");
		expect(line).toContain("312k/1M · 31%");
		expect(line.indexOf("本次 ¥4.20")).toBeLessThan(line.indexOf("312k/1M · 31%"));
		expect(line.endsWith("本次 ¥4.20   312k/1M · 31% ")).toBe(true);
	});

	it("sits ahead of the watermark bar when the bar is up", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(sourceWith({ ...SNAPSHOT, contextTokens: 500_000, sessionCost: 4.2 }));
		const line = footerLine(footer, 120);
		expect(line).toContain("●");
		expect(line).toContain("本次 ¥4.20");
		expect(line.indexOf("本次 ¥4.20")).toBeLessThan(line.indexOf("●"));
	});

	it("stays absent without a figure, at zero, and on unusable values (no ¥0.00 noise)", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(sourceWith(SNAPSHOT));
		expect(footerLine(footer)).not.toContain("本次");
		expect(footerLine(footer)).not.toContain("¥");

		for (const bad of [0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
			footer.setTelemetrySource(sourceWith({ ...SNAPSHOT, sessionCost: bad }));
			expect(footerLine(footer)).not.toContain("本次");
			expect(footerLine(footer)).not.toContain("¥");
		}
	});

	it("follows the pull source frame by frame (评审②: no figure is cached in the footer)", () => {
		const footer = new FooterComponent(provider);
		let snapshot: FooterTelemetrySnapshot = { ...SNAPSHOT, sessionCost: 1 };
		footer.setTelemetrySource(() => ({ mode: "on", snapshot }));
		expect(footerLine(footer)).toContain("本次 ¥1.00");

		snapshot = { ...SNAPSHOT, sessionCost: 2.5 };
		expect(footerLine(footer)).toContain("本次 ¥2.50");
		expect(footerLine(footer)).not.toContain("¥1.00");

		snapshot = { ...SNAPSHOT };
		expect(footerLine(footer)).not.toContain("本次");
	});

	it("drops the spend segment first, then the location, then the figures", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(sourceWith({ ...SNAPSHOT, sessionCost: 4.2 }));
		footer.setLocationSource(() => ({ cwd: "/srv/some/long/project/path", branch: "feature/branch" }));

		const full = footerLine(footer, 120);
		expect(full).toContain("本次 ¥4.20");
		expect(full).toContain("/srv/some/long/project/path");
		expect(full).toContain("312k/1M · 31%");

		// First casualty: the opt-in segment; the location and figures survive it.
		const noSpend = footerLine(footer, 100);
		expect(noSpend).not.toContain("本次");
		expect(noSpend).toContain("/srv/some/long/project/path");
		expect(noSpend).toContain("312k/1M · 31%");

		// Then the location; the figures stay.
		const noLocation = footerLine(footer, 60);
		expect(noLocation).not.toContain("本次");
		expect(noLocation).not.toContain("/srv");
		expect(noLocation).toContain("312k/1M · 31%");

		// Last: the figures; the model never drops. No dangling separator or half figure.
		const bare = footerLine(footer, 30);
		expect(bare).not.toContain("本次");
		expect(bare).not.toContain("312k");
		expect(bare).toContain("glm-5.3");
		expect(bare.length).toBeLessThanOrEqual(30);
	});

	it("coexists with the subagent spend cell: 子代理 figures keep their slot, 本次 joins the group", () => {
		const footer = new FooterComponent(provider);
		footer.setTelemetrySource(sourceWith({ ...SNAPSHOT, sessionCost: 9.8 }));
		footer.setSpendSource(() => ["子代理 ¥4.20 · 全部 ¥14.00"]);
		const line = footerLine(footer, 120);
		expect(line).toContain("子代理 ¥4.20 · 全部 ¥14.00");
		expect(line).toContain("本次 ¥9.80");
		expect(line.indexOf("子代理")).toBeLessThan(line.indexOf("本次"));
	});
});

describe("footer.sessionSpend setting", () => {
	it("defaults to off, persists set values, and folds malformed values to off", () => {
		const dir = mkdtempSync(join(tmpdir(), "footer-session-spend-"));
		try {
			const manager = SettingsManager.create(dir, dir);
			expect(manager.getFooterSessionSpend()).toBe(false);

			manager.setFooterSessionSpend(true);
			expect(manager.getFooterSessionSpend()).toBe(true);
			return manager.flush().then(() => {
				// A fresh manager over the persisted file keeps the value.
				const reloaded = SettingsManager.create(dir, dir);
				expect(reloaded.getFooterSessionSpend()).toBe(true);

				// Explicit off persists too.
				reloaded.setFooterSessionSpend(false);
				expect(reloaded.getFooterSessionSpend()).toBe(false);

				// Malformed values never turn the segment on: an unusable object is
				// ignored (fallback off), the word "off" reads as off.
				writeFileSync(join(dir, "settings.json"), JSON.stringify({ footer: { sessionSpend: {} } }));
				expect(SettingsManager.create(dir, dir).getFooterSessionSpend()).toBe(false);
				writeFileSync(join(dir, "settings.json"), JSON.stringify({ footer: { sessionSpend: "off" } }));
				expect(SettingsManager.create(dir, dir).getFooterSessionSpend()).toBe(false);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is a registered key: the scanner accepts it and still names a typo", () => {
		expect(collectUnknownSettingsKeys({ footer: { telemetry: "on", sessionSpend: true } })).toEqual([]);
		expect(collectUnknownSettingsKeys({ footer: { sessionSpendd: true } })).toEqual(["footer.sessionSpendd"]);
	});
});

describe("the telemetry ladder is monotone (each dropped segment stays dropped)", () => {
	it("the spend cell never reappears once the width took it, and 本次 never reappears either", () => {
		const footer = new FooterComponent(provider);
		// A long session figure next to a short cell: the ladder used to drop the
		// cell for the session-only rung, then re-add the cell one column narrower.
		footer.setTelemetrySource(sourceWith({ ...SNAPSHOT, sessionCost: 1234.56 }));
		footer.setSpendSource(() => ["子代理 ¥4"]);
		let cellGone = false;
		let sessionGone = false;
		for (let width = 160; width >= 24; width -= 1) {
			const line = footerLine(footer, width);
			const hasCell = line.includes("子代理 ¥");
			const hasSession = line.includes("本次");
			if (hasCell) {
				expect(cellGone, `the spend cell came back at width ${width}`).toBe(false);
			} else {
				cellGone = true;
			}
			if (hasSession) {
				expect(sessionGone, `本次 came back at width ${width}`).toBe(false);
			} else {
				sessionGone = true;
			}
		}
		expect(cellGone).toBe(true);
		expect(sessionGone).toBe(true);
	});
});

describe("the /speed line", () => {
	it("keeps the same one-column indent in the status-bar face and the telemetry face", () => {
		const withBar = new FooterComponent(provider);
		withBar.setStatusBarSource(() => ({ model: "glm-5.3-prime", subagents: 0, right: [] }));
		withBar.setSpeedEnabled(true);
		withBar.setSpeedText("88 tok/s · avg 66");
		const barLine = stripAnsi(withBar.render(110).at(-1) ?? "");

		const withTelemetry = new FooterComponent(provider);
		withTelemetry.setTelemetrySource(sourceWith(SNAPSHOT));
		withTelemetry.setSpeedEnabled(true);
		withTelemetry.setSpeedText("88 tok/s · avg 66");
		const telemetryLine = stripAnsi(withTelemetry.render(110).at(-1) ?? "");

		expect(barLine).toBe(" 88 tok/s · avg 66");
		expect(telemetryLine).toBe(barLine);
	});
});
