import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * SEC-8: a project-scope settings file only took effect at the exact cwd it was
 * found in, so a repository-level veto (`.prime/agent/settings.json` at the repo
 * root with agentTraces/telemetry disabled) was silently skipped whenever a
 * session started in a subdirectory. The project scope now walks the ancestors
 * like the skills loader does (`package-manager.ts` collectAncestorAgentsSkillDirs):
 * every `.prime/agent/settings.json` from cwd up to the repository root is
 * collected, merged with the closest file winning, and any explicit
 * `enabled: false` vetoes consent no matter which level wrote it.
 */
describe("project settings walk ancestors up to the repo root", () => {
	let testDir = "";
	let agentDir = "";
	let repoRoot = "";
	let globalPath = "";

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-ancestor-veto-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		repoRoot = join(testDir, "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(join(repoRoot, ".prime", "agent"), { recursive: true });
		globalPath = join(agentDir, "settings.json");
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("applies the repository-level agentTraces veto to a session in a subdirectory", () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		writeFileSync(
			join(repoRoot, ".prime", "agent", "settings.json"),
			JSON.stringify({ agentTraces: { enabled: false } }),
		);
		const deepDir = join(repoRoot, "packages", "app", "src");
		mkdirSync(deepDir, { recursive: true });

		const manager = SettingsManager.create(deepDir, agentDir);

		expect(manager.getAgentTracesEnabled()).toBe(false);
	});

	it("lets a repository-level veto win over a subdirectory that re-enables", () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		writeFileSync(
			join(repoRoot, ".prime", "agent", "settings.json"),
			JSON.stringify({ agentTraces: { enabled: false } }),
		);
		const subDir = join(repoRoot, "packages", "app");
		mkdirSync(join(subDir, ".prime", "agent"), { recursive: true });
		writeFileSync(
			join(subDir, ".prime", "agent", "settings.json"),
			JSON.stringify({ agentTraces: { enabled: true } }),
		);

		const manager = SettingsManager.create(subDir, agentDir);

		expect(manager.getAgentTracesEnabled()).toBe(false);
	});

	it("applies the repository-level telemetry opt-out to a session in a subdirectory", () => {
		writeFileSync(
			join(repoRoot, ".prime", "agent", "settings.json"),
			JSON.stringify({ telemetry: { enabled: false } }),
		);
		const subDir = join(repoRoot, "packages", "app");
		mkdirSync(subDir, { recursive: true });

		const manager = SettingsManager.create(subDir, agentDir);

		expect(manager.getTelemetryEnabled()).toBe(false);
	});

	it("keeps consent working when no ancestor vetoes it", () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		writeFileSync(join(repoRoot, ".prime", "agent", "settings.json"), JSON.stringify({}));
		const subDir = join(repoRoot, "packages", "app");
		mkdirSync(subDir, { recursive: true });

		const manager = SettingsManager.create(subDir, agentDir);

		expect(manager.getAgentTracesEnabled()).toBe(true);
	});

	it("merges non-consent project keys from ancestor settings files", () => {
		writeFileSync(join(repoRoot, ".prime", "agent", "settings.json"), JSON.stringify({ theme: "dark" }));
		const subDir = join(repoRoot, "packages", "app");
		mkdirSync(subDir, { recursive: true });

		const manager = SettingsManager.create(subDir, agentDir);

		expect(manager.getTheme()).toBe("dark");
	});

	it("closes consent when an ancestor project file fails to parse", () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		writeFileSync(join(repoRoot, ".prime", "agent", "settings.json"), `{"agentTraces": {"enabled": false},}`);
		const subDir = join(repoRoot, "packages", "app");
		mkdirSync(subDir, { recursive: true });

		const manager = SettingsManager.create(subDir, agentDir);

		expect(manager.getAgentTracesEnabled()).toBe(false);
	});

	it("stops collecting at the repository root: settings above it do not project into it", () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		// A settings directory above the repo root must not reach sessions inside it.
		mkdirSync(join(testDir, ".prime", "agent"), { recursive: true });
		writeFileSync(
			join(testDir, ".prime", "agent", "settings.json"),
			JSON.stringify({ agentTraces: { enabled: false } }),
		);
		const subDir = join(repoRoot, "packages", "app");
		mkdirSync(subDir, { recursive: true });

		const manager = SettingsManager.create(subDir, agentDir);

		expect(manager.getAgentTracesEnabled()).toBe(true);
	});
});
