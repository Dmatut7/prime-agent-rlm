import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * U2/SEC-2: `agentTraces.enabled` is an opt-in consent for uploading full session
 * transcripts, so a project settings file (which arrives with a cloned repository)
 * must not be able to grant it. The gate answers the three domains separately, like
 * `getTelemetryEnabled`: the project layer can only withhold consent, never supply it.
 */
describe("agentTraces opt-in gate", () => {
	let testDir = "";
	let agentDir = "";
	let projectDir = "";
	let globalPath = "";
	let projectPath = "";
	let manager: SettingsManager | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-traces-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	it("keeps agentTraces off when a cloned repo's project settings try to enable it", () => {
		// The user never opted in: no global agentTraces block, default off.
		writeFileSync(projectPath, JSON.stringify({ agentTraces: { enabled: true } }));

		manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getAgentTracesEnabled()).toBe(false);
	});

	it("positive control: an explicit user-level opt-in still enables agentTraces", () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));

		manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getAgentTracesEnabled()).toBe(true);
	});

	it("lets project settings withhold consent from an opted-in user", () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		writeFileSync(projectPath, JSON.stringify({ agentTraces: { enabled: false } }));

		manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getAgentTracesEnabled()).toBe(false);
	});

	it("keeps an in-memory opt-in working when no project file exists", () => {
		manager = SettingsManager.inMemory({ agentTraces: { enabled: true } });

		expect(manager.getAgentTracesEnabled()).toBe(true);
	});
});
