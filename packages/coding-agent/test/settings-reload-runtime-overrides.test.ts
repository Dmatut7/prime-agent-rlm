import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * SEC-9: `reload()` recomputed the merged view from the two files only, so one
 * external edit of settings.json silently rolled back every runtime override a
 * CLI flag or SDK caller had applied through `applyOverrides`. The merged view
 * is files-with-overrides; a reload of the files must stack the overrides back
 * on top instead of dropping them.
 */
describe("reload keeps runtime overrides in the merged view", () => {
	let testDir = "";
	let agentDir = "";
	let projectDir = "";
	let globalPath = "";
	let manager: SettingsManager | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-reload-overrides-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		globalPath = join(agentDir, "settings.json");
	});

	afterEach(() => {
		manager?.stopWatchingExternalSettings();
		manager = undefined;
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps an override applied before an external edit and reload", async () => {
		writeFileSync(globalPath, JSON.stringify({ theme: "light" }));
		manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ theme: "dark" });
		expect(manager.getTheme()).toBe("dark");

		// Somebody edits the file by hand while the session is running. A key the
		// override does not touch (retry.enabled, default true when absent) proves
		// the reloaded file content really reached the merged view.
		writeFileSync(globalPath, JSON.stringify({ theme: "light", retry: { enabled: false } }));
		await manager.reload();

		expect(manager.getRetryEnabled()).toBe(false);
		// ...and the runtime override still wins the key it owns.
		expect(manager.getTheme()).toBe("dark");
	});

	it("still reflects the files once the override stops being applied", async () => {
		writeFileSync(globalPath, JSON.stringify({ theme: "light" }));
		manager = SettingsManager.create(projectDir, agentDir);

		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		await manager.reload();

		expect(manager.getTheme()).toBe("dark");
	});
});
