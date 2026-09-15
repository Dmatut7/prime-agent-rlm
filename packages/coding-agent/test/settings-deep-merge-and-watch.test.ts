import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * CD-4: nested settings blocks merge recursively (the doc comment always said so;
 * the merge stopped after one level, so a project file that set
 * `retry.provider.maxRetries` silently dropped every global `retry.provider` key
 * it did not mention).
 *
 * CD-5: editing `settings.json` directly must reach a running session instead of
 * being ignored until restart.
 */
describe("settings deep merge and external edits", () => {
	let testDir = "";
	let agentDir = "";
	let projectDir = "";
	let globalPath = "";
	let projectPath = "";
	let manager: SettingsManager | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-settings-deep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		globalPath = join(agentDir, "settings.json");
		projectPath = join(projectDir, ".prime", "agent", "settings.json");
	});

	afterEach(() => {
		manager?.stopWatchingExternalSettings();
		manager = undefined;
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps the global keys a nested project override does not mention", () => {
		writeFileSync(
			globalPath,
			JSON.stringify({
				retry: {
					enabled: true,
					provider: { timeoutMs: 5000, maxRetries: 2, streamStallTimeoutMs: 7000 },
				},
			}),
		);
		writeFileSync(projectPath, JSON.stringify({ retry: { provider: { maxRetries: 5 } } }));

		manager = SettingsManager.create(projectDir, agentDir);

		// The project value wins where it speaks...
		expect(manager.getProviderRetrySettings().maxRetries).toBe(5);
		// ...and the deeper global keys it never mentioned survive. Before the deep
		// merge these were silently dropped (undefined / the 60000 default).
		expect(manager.getProviderRetrySettings().timeoutMs).toBe(5000);
		expect(manager.getProviderRetrySettings().streamStallTimeoutMs).toBe(7000);
	});

	it("merges three levels deep without mutating either input scope", () => {
		writeFileSync(
			globalPath,
			JSON.stringify({
				retry: { provider: { timeoutMs: 5000, maxRetryDelayMs: 100 }, enabled: true },
			}),
		);
		manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ retry: { provider: { maxRetries: 9 } } });

		expect(manager.getProviderRetrySettings()).toMatchObject({
			timeoutMs: 5000,
			maxRetryDelayMs: 100,
			maxRetries: 9,
		});
		// The overrides layer is separate state: merging must not have written the
		// override keys back into the global scope.
		expect(manager.getGlobalSettings().retry?.provider?.maxRetries).toBeUndefined();
	});

	it("picks up a direct edit of settings.json in a running session", async () => {
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getTheme()).toBe("dark");

		expect(manager.watchExternalSettings({ intervalMs: 20 })).toBe(true);

		// Somebody edits the file by hand while the session is running.
		writeFileSync(globalPath, JSON.stringify({ theme: "light" }));

		const deadline = Date.now() + 4000;
		while (manager.getTheme() !== "light" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		expect(manager.getTheme()).toBe("light");
		const warnings = manager.drainWarnings("global");
		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toContain("changed on disk");
	});

	it("does not report its own writes as external edits", async () => {
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.watchExternalSettings({ intervalMs: 20 })).toBe(true);

		manager.setTheme("light");
		await manager.flush();
		// Let several poll intervals pass: the watcher must not mistake the write it
		// just made for somebody else's edit, or every save would nag the user.
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(manager.getTheme()).toBe("light");
		expect(manager.drainWarnings()).toEqual([]);
	});
});
