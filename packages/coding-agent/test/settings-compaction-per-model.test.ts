import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * Per-model auto-compaction persistence (wave-42): the toggle writes the serving
 * model's entry under `compaction.perModel` ("provider/id", the recentModels key
 * convention); the bare `compaction.enabled` stays the default for models without
 * an entry, so settings files written before this feature behave exactly as they
 * did (zero migration).
 */
describe("compaction per-model settings", () => {
	const testDir = join(process.cwd(), "test-settings-compaction-per-model-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const settingsPath = join(agentDir, "settings.json");

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

	function readOnDisk(): Record<string, unknown> {
		return JSON.parse(readFileSync(settingsPath, "utf-8"));
	}

	it("resolves every model to the bare default when no perModel key exists (zero migration)", () => {
		writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: false } }));

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getCompactionEnabledForModel("openai/gpt-5.1")).toBe(false);
		expect(manager.getCompactionEnabledForModel("anthropic/claude-sonnet")).toBe(false);
		expect(manager.getCompactionEnabledForModel(undefined)).toBe(false);
	});

	it("writes the serving model's entry without touching the bare default", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);

		manager.setCompactionEnabledForModel("openai/gpt-5.1", false);
		await manager.flush();

		const onDisk = readOnDisk();
		const compaction = onDisk.compaction as Record<string, unknown>;
		expect(compaction.perModel).toEqual({ "openai/gpt-5.1": false });
		expect(compaction.enabled).toBeUndefined();

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getCompactionEnabledForModel("openai/gpt-5.1")).toBe(false);
		expect(reloaded.getCompactionEnabledForModel("anthropic/claude-sonnet")).toBe(true);
		expect(reloaded.getCompactionEnabled()).toBe(true);
	});

	it("lets a per-model entry override a disabled bare default", () => {
		writeFileSync(settingsPath, JSON.stringify({ compaction: { enabled: false } }));

		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setCompactionEnabledForModel("openai/gpt-5.1", true);

		expect(manager.getCompactionEnabledForModel("openai/gpt-5.1")).toBe(true);
		expect(manager.getCompactionEnabledForModel("anthropic/claude-sonnet")).toBe(false);
	});

	it("writes the bare default when no model is in service", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);

		manager.setCompactionEnabledForModel(undefined, false);
		await manager.flush();

		const onDisk = readOnDisk();
		const compaction = onDisk.compaction as Record<string, unknown>;
		expect(compaction.enabled).toBe(false);
		expect(compaction.perModel).toBeUndefined();
	});

	it("accumulates entries for several models in one map", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);

		manager.setCompactionEnabledForModel("openai/gpt-5.1", false);
		manager.setCompactionEnabledForModel("anthropic/claude-sonnet", true);
		await manager.flush();

		const compaction = readOnDisk().compaction as Record<string, unknown>;
		expect(compaction.perModel).toEqual({ "openai/gpt-5.1": false, "anthropic/claude-sonnet": true });
	});

	it("keeps the rest of the compaction block and unrelated keys when saving a per-model entry", async () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({
				compaction: { triggerRatio: 0.7, perModel: { "anthropic/claude-sonnet": true } },
				theme: "dark",
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setCompactionEnabledForModel("openai/gpt-5.1", false);
		await manager.flush();

		const onDisk = readOnDisk();
		const compaction = onDisk.compaction as Record<string, unknown>;
		expect(compaction.triggerRatio).toBe(0.7);
		expect(compaction.perModel).toEqual({ "anthropic/claude-sonnet": true, "openai/gpt-5.1": false });
		expect(onDisk.theme).toBe("dark");
	});

	it("still honours a hand-edited non-boolean entry and defers an unreadable one to the default", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({
				compaction: { enabled: true, perModel: { "openai/gpt-5.1": "false", "anthropic/claude-sonnet": null } },
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getCompactionEnabledForModel("openai/gpt-5.1")).toBe(false);
		// null says nothing usable: the entry defers to the bare default instead of forcing the switch.
		expect(manager.getCompactionEnabledForModel("anthropic/claude-sonnet")).toBe(true);
	});

	it("does not report per-model model keys as unknown settings keys", () => {
		writeFileSync(settingsPath, JSON.stringify({ compaction: { perModel: { "openai/gpt-5.1": false } } }));

		const manager = SettingsManager.create(projectDir, agentDir);

		const warnings = manager.drainWarnings();
		const unknownKeyWarnings = warnings.filter((warning) => /unknown settings key/.test(warning.message));
		expect(unknownKeyWarnings).toEqual([]);
	});
});
