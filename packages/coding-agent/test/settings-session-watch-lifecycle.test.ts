import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { SessionManager } from "../src/core/session-manager.js";

/**
 * SEC-10: `watchExternalSettings()` was started for every session but nothing
 * ever called `stopWatchingExternalSettings()`, so a long-lived daemon kept two
 watchFile listeners per session alive forever. Disposing the session must
 * release the watcher of the settings manager the session owns.
 */
describe("session disposal stops watching settings.json", () => {
	let testDir = "";
	let agentDir = "";
	let projectDir = "";
	let globalPath = "";
	let cleanupManager: { stopWatchingExternalSettings(): void } | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-watch-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		globalPath = join(agentDir, "settings.json");
	});

	afterEach(() => {
		cleanupManager?.stopWatchingExternalSettings();
		cleanupManager = undefined;
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("stops the settings watcher when the session is disposed", async () => {
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		const services = await createAgentSessionServices({
			cwd: projectDir,
			agentDir,
			telemetryDisabled: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		cleanupManager = services.settingsManager;
		expect(services.settingsManager.isWatchingExternalSettings()).toBe(true);

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(projectDir, join(testDir, "sessions")),
			telemetryDisabled: true,
		});

		// Gate the edit on the watcher having actually reacted once, so the
		// post-dispose check below cannot pass only because the watcher never
		// finished its first poll (the same baseline race the CD-5 test guards).
		let touches = 0;
		let watcherSawATouch = false;
		const gateDeadline = Date.now() + 4000;
		while (Date.now() < gateDeadline) {
			if (services.settingsManager.drainWarnings("global").length > 0) {
				watcherSawATouch = true;
				break;
			}
			touches += 1;
			utimesSync(globalPath, new Date(), new Date(Date.now() + touches * 1000));
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(watcherSawATouch, "the settings watcher never observed a touch").toBe(true);

		session.dispose();

		expect(services.settingsManager.isWatchingExternalSettings()).toBe(false);

		// And the released watcher no longer reacts to a real edit: the default
		// watch interval is 1s, so wait past a full poll cycle.
		writeFileSync(globalPath, JSON.stringify({ theme: "light" }));
		await new Promise((resolve) => setTimeout(resolve, 2500));

		expect(services.settingsManager.drainWarnings("global")).toEqual([]);
		expect(services.settingsManager.getTheme()).toBe("dark");
	});
});
