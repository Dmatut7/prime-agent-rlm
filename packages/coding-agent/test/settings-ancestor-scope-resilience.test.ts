import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * K3P-1 / K3P-2 (round-30 K3 review F1/F2): the SEC-8 ancestor walk made one
 * broken ancestor file discard the session's own intact project scope, and
 * ancestor files were never watched, so a repository-level veto written while
 * the session was running never took effect.
 */

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return condition();
}

describe("K3P-1: one broken ancestor file does not discard the whole project scope", () => {
	let testDir = "";
	let agentDir = "";
	let repoRoot = "";
	let rootSettingsPath = "";
	let midDir = "";
	let midSettingsPath = "";
	let subDir = "";
	let ownSettingsPath = "";
	let manager: SettingsManager | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-k3p1-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		repoRoot = join(testDir, "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(join(repoRoot, ".prime", "agent"), { recursive: true });
		midDir = join(repoRoot, "packages", "app");
		mkdirSync(join(midDir, ".prime", "agent"), { recursive: true });
		subDir = join(midDir, "src");
		mkdirSync(join(subDir, ".prime", "agent"), { recursive: true });
		rootSettingsPath = join(repoRoot, ".prime", "agent", "settings.json");
		midSettingsPath = join(midDir, ".prime", "agent", "settings.json");
		ownSettingsPath = join(subDir, ".prime", "agent", "settings.json");
	});

	afterEach(() => {
		manager?.stopWatchingExternalSettings();
		manager = undefined;
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps the session's own intact project file effective when a repo-root ancestor is broken", () => {
		writeFileSync(rootSettingsPath, "{ broken json");
		writeFileSync(ownSettingsPath, JSON.stringify({ defaultModel: "own-model" }));

		manager = SettingsManager.create(subDir, agentDir);

		// Pre-fix, the whole project scope was dropped because one ancestor failed
		// to parse: the session's own file lost its model default with it.
		expect(manager.getProjectSettings().defaultModel).toBe("own-model");
	});

	it("keeps merging the ancestors that do parse when one of them is broken", () => {
		writeFileSync(rootSettingsPath, "{ broken json");
		writeFileSync(midSettingsPath, JSON.stringify({ theme: "dark" }));
		writeFileSync(ownSettingsPath, JSON.stringify({ defaultModel: "own-model" }));

		manager = SettingsManager.create(subDir, agentDir);

		expect(manager.getTheme()).toBe("dark");
		expect(manager.getProjectSettings().defaultModel).toBe("own-model");
	});

	it("fails consent closed for the broken ancestor layer only, and says so", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ telemetry: { enabled: true } }));
		writeFileSync(rootSettingsPath, "{ broken json");
		writeFileSync(ownSettingsPath, JSON.stringify({ telemetry: { enabled: true } }));

		manager = SettingsManager.create(subDir, agentDir);

		// The unparseable ancestor cannot be verified, so its consent is withheld
		// (fail-closed for that layer) - but the withheld consent is reported,
		// not silent, and it does not drag the rest of the scope down with it.
		expect(manager.getTelemetryEnabled()).toBe(false);
		expect(manager.getProjectSettings().defaultModel).toBeUndefined();
		const warnings = manager.drainWarnings("project");
		expect(warnings.some((warning) => warning.message.includes(rootSettingsPath))).toBe(true);
	});
});

describe("K3P-2: ancestor settings edits are live in a watching session", () => {
	let testDir = "";
	let agentDir = "";
	let repoRoot = "";
	let rootSettingsPath = "";
	let subDir = "";
	let manager: SettingsManager | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-k3p2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		repoRoot = join(testDir, "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(join(repoRoot, ".prime", "agent"), { recursive: true });
		subDir = join(repoRoot, "packages", "app");
		mkdirSync(subDir, { recursive: true });
		rootSettingsPath = join(repoRoot, ".prime", "agent", "settings.json");
	});

	afterEach(() => {
		manager?.stopWatchingExternalSettings();
		manager = undefined;
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("picks up an ancestor veto file written while the session is running", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentTraces: { enabled: true } }));
		manager = SettingsManager.create(subDir, agentDir);
		expect(manager.getAgentTracesEnabled()).toBe(true);

		manager.watchExternalSettings({ intervalMs: 100 });
		// Mid-session: the repository root gains a veto file that did not exist
		// when the session started.
		writeFileSync(rootSettingsPath, JSON.stringify({ agentTraces: { enabled: false } }));

		// CI runners can stretch the 100ms stat-poll loop; the window is generous
		// without weakening the proposition (the ancestor file alone must flip it).
		const applied = await waitFor(() => manager !== undefined && manager.getAgentTracesEnabled() === false, 20000);
		expect(applied).toBe(true);
		expect(manager.drainWarnings("project").length).toBeGreaterThan(0);
	}, 25000);

	it("control: a watched global edit still reloads and picks up the ancestor veto", async () => {
		const globalPath = join(agentDir, "settings.json");
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		writeFileSync(rootSettingsPath, JSON.stringify({ agentTraces: { enabled: false } }));
		manager = SettingsManager.create(subDir, agentDir);
		// The veto exists at startup but the global file says yes: gate is on.
		expect(manager.getAgentTracesEnabled()).toBe(false);

		manager.watchExternalSettings({ intervalMs: 100 });
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: false } }));

		const reloaded = await waitFor(() => {
			const warnings = manager !== undefined ? manager.drainWarnings("global") : [];
			return warnings.length > 0;
		}, 5000);
		expect(reloaded).toBe(true);
	}, 10000);
});
