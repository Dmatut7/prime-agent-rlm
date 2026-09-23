import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * TUI v4 batch 1 / T1: the `ui.processMode` switch. Quiet is the new default
 * conversation face; `legacy` is the one-key escape hatch for the U6 lane
 * users. These tests pin the getter contract (default, readback, unknown
 * values never throw), the settings-panel persistence, and the unknown-key
 * scanner accepting the new key.
 */
describe("ui.processMode", () => {
	const testDir = join(process.cwd(), "test-settings-process-mode-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const globalSettingsPath = join(agentDir, "settings.json");
	const projectSettingsPath = join(projectDir, ".prime", "agent", "settings.json");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("defaults to quiet when nothing is set", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getProcessMode()).toBe("quiet");
	});

	it("reads legacy back from the settings file", () => {
		writeFileSync(globalSettingsPath, JSON.stringify({ ui: { processMode: "legacy" } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getProcessMode()).toBe("legacy");
	});

	it("lands unknown values on the quiet default instead of throwing", () => {
		writeFileSync(globalSettingsPath, JSON.stringify({ ui: { processMode: "loud" } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getProcessMode()).toBe("quiet");
	});

	it("accepts project-scope override over the global value", () => {
		writeFileSync(globalSettingsPath, JSON.stringify({ ui: { processMode: "legacy" } }));
		writeFileSync(projectSettingsPath, JSON.stringify({ ui: { processMode: "quiet" } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getProcessMode()).toBe("quiet");
	});

	it("is a known key: the unknown-key scanner stays silent for it", () => {
		writeFileSync(globalSettingsPath, JSON.stringify({ ui: { processMode: "legacy" } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.drainWarnings().filter((warning) => warning.message.includes("processMode"))).toEqual([]);
	});

	it("persists through the setter and keeps neighbouring ui keys", async () => {
		writeFileSync(globalSettingsPath, JSON.stringify({ ui: { subagentSpendCell: { intervalMs: 30000 } } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getProcessMode()).toBe("quiet");

		manager.setProcessMode("legacy");
		await manager.flush();

		const saved = JSON.parse(readFileSync(globalSettingsPath, "utf-8"));
		expect(saved.ui.processMode).toBe("legacy");
		expect(saved.ui.subagentSpendCell).toEqual({ intervalMs: 30000 });
		expect(manager.getProcessMode()).toBe("legacy");
	});
});
