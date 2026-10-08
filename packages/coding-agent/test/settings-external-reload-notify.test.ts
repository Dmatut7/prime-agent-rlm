import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * R4-M18: a hand edit of settings.json reloaded into the running session, but
 * the "reloaded" (or "failed to parse") warning had no consumer - drainWarnings
 * was only called at startup, so the edit applied in silence and the warnings
 * piled up in the long-lived process. onExternalSettingsReload is the consumer
 * hook a UI uses to drain and show them.
 */
describe("settings external-edit reload notification", () => {
	let testDir = "";
	let agentDir = "";
	let projectDir = "";
	let globalPath = "";
	let manager: SettingsManager | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-settings-notify-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	/** Gate edits on the watcher having finished one poll (see settings-deep-merge-and-watch). */
	async function armWatcher(notifications: string[][]): Promise<number> {
		let touches = 0;
		const gateDeadline = Date.now() + 4000;
		while (notifications.length === 0 && Date.now() < gateDeadline) {
			touches += 1;
			utimesSync(globalPath, new Date(), new Date(Date.now() + touches * 1000));
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(notifications.length, "the settings watcher never observed a touch").toBeGreaterThan(0);
		return notifications.length;
	}

	it("notifies a listener after a hand edit is reloaded, and the drain empties the backlog", async () => {
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		const created = SettingsManager.create(projectDir, agentDir);
		manager = created;
		expect(created.watchExternalSettings({ intervalMs: 20 })).toBe(true);

		const notifications: string[][] = [];
		created.onExternalSettingsReload(() => {
			notifications.push(created.drainWarnings().map((warning) => warning.message));
		});

		await armWatcher(notifications);
		const seen = notifications.length;

		writeFileSync(globalPath, JSON.stringify({ theme: "light" }));
		const deadline = Date.now() + 4000;
		while (notifications.length <= seen && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		expect(notifications.length).toBe(seen + 1);
		expect(notifications[notifications.length - 1].join("\n")).toContain("changed on disk");
		// The listener drained the warnings: nothing keeps piling up in the process.
		expect(manager.drainWarnings()).toEqual([]);
		expect(manager.getTheme()).toBe("light");
	});

	it("notifies on a parse failure too, reporting the edit did not take effect", async () => {
		writeFileSync(globalPath, JSON.stringify({ theme: "dark" }));
		const created = SettingsManager.create(projectDir, agentDir);
		manager = created;
		expect(created.watchExternalSettings({ intervalMs: 20 })).toBe(true);

		const notifications: string[][] = [];
		created.onExternalSettingsReload(() => {
			notifications.push(created.drainWarnings().map((warning) => warning.message));
		});

		await armWatcher(notifications);
		const seen = notifications.length;

		writeFileSync(globalPath, "{ not json");
		const deadline = Date.now() + 4000;
		while (notifications.length <= seen && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		expect(notifications.length).toBe(seen + 1);
		expect(notifications[notifications.length - 1].join("\n")).toContain("failed to parse");
		// The broken edit did not take effect: the previous value is still loaded.
		expect(manager.getTheme()).toBe("dark");
	});
});
