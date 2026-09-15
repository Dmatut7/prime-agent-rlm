import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * K3R2-3 (round-31 F4b): the ancestor parse warning's dedup identity was the
 * file path alone. Once that path had failed to parse, a second corruption after
 * a fix never warned again: the reload had nothing new to say about the scope,
 * so the broken ancestor was silently dropped a second time.
 */
describe("K3R2-3: a re-broken ancestor settings file warns again", () => {
	let testDir = "";
	let agentDir = "";
	let repoRoot = "";
	let subDir = "";
	let rootSettingsPath = "";
	let manager: SettingsManager | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-k3r2-ident-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		repoRoot = join(testDir, "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		subDir = join(repoRoot, "packages", "app");
		mkdirSync(subDir, { recursive: true });
		mkdirSync(join(repoRoot, ".prime", "agent"), { recursive: true });
		rootSettingsPath = join(repoRoot, ".prime", "agent", "settings.json");
	});

	afterEach(() => {
		manager?.stopWatchingExternalSettings();
		manager = undefined;
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("warns again when the ancestor breaks again after being fixed", async () => {
		writeFileSync(rootSettingsPath, "{ broken json");
		manager = SettingsManager.create(subDir, agentDir);
		const first = manager.drainWarnings("project");
		expect(first.some((warning) => warning.message.includes(rootSettingsPath))).toBe(true);

		// The file is fixed: the reload picks the ancestor back up.
		writeFileSync(rootSettingsPath, JSON.stringify({ theme: "dark" }));
		await manager.reload();
		expect(manager.getTheme()).toBe("dark");

		// Then it breaks again with new content. Before the fix the path-only
		// warning identity suppressed this warning forever: the second corruption
		// was silently dropped, and a watcher-driven reload would have reported
		// the scope as successfully reloaded.
		writeFileSync(rootSettingsPath, "{ broken differently");
		await manager.reload();
		const second = manager.drainWarnings("project");
		expect(second.some((warning) => warning.message.includes(rootSettingsPath))).toBe(true);
	});
});
