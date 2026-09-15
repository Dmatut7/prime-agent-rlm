import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * K3P-3 (round-30 K3 review F3): SEC-9 taught `reload()` to stack
 * `runtimeOverrides` back into the merged view, but `save()` and
 * `saveProjectSettings()` still recomputed it from the two files only, so any
 * settings save silently rolled back a CLI-flag/SDK override until the next
 * reload.
 */
describe("saves keep runtime overrides in the merged view", () => {
	let testDir = "";
	let agentDir = "";
	let projectDir = "";
	let manager: SettingsManager | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-k3p3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
	});

	afterEach(async () => {
		manager?.stopWatchingExternalSettings();
		await manager?.flush().catch(() => undefined);
		manager = undefined;
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps an override across a save() triggered by an unrelated setter", () => {
		manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ defaultModel: "override-model" });
		expect(manager.getDefaultModel()).toBe("override-model");

		// An unrelated global write: saving must not roll the override back.
		manager.setDefaultProvider("some-provider");

		expect(manager.getDefaultModel()).toBe("override-model");
	});

	it("keeps an override across a saveProjectSettings() triggered by an unrelated setter", () => {
		manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ defaultModel: "override-model" });
		expect(manager.getDefaultModel()).toBe("override-model");

		// An unrelated project write: same rule as save().
		manager.setProjectSkillPaths(["./skills"]);

		expect(manager.getDefaultModel()).toBe("override-model");
	});

	it("control: the saved file itself still carries the persisted fields", async () => {
		manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ defaultModel: "override-model" });
		manager.setDefaultProvider("some-provider");
		await manager.flush();

		// The override lives in memory only; the file must say the provider.
		const onDisk = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(onDisk.defaultProvider).toBe("some-provider");
		expect(onDisk.defaultModel).toBeUndefined();
	});
});
