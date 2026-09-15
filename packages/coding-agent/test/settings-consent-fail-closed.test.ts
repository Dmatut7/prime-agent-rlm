import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * SEC-7: consent gates must fail closed. `reload()` keeps the last successfully
 * parsed scope when a re-read fails, so a user who revokes consent (or an
 * opt-out) but leaves malformed JSON behind kept the OLD value: the gate stayed
 * open, the automatic upload kept going, and `reloadExternalEdit` reported the
 * broken edit as "reloaded into this session". A scope that cannot be parsed is
 * a scope whose consent cannot be verified: the gate must be off.
 */
describe("consent gates fail closed on unparseable settings", () => {
	let testDir = "";
	let agentDir = "";
	let projectDir = "";
	let globalPath = "";
	let projectPath = "";
	let manager: SettingsManager | undefined;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-consent-failclosed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

	it("closes agentTraces when the global file stops parsing after the user revoked consent", async () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getAgentTracesEnabled()).toBe(true);

		// The user edits the file to revoke consent and leaves a trailing comma.
		writeFileSync(globalPath, `{"agentTraces": {"enabled": false},}`);
		await manager.reload();

		expect(manager.getAgentTracesEnabled()).toBe(false);
	});

	it("re-opens agentTraces once the file parses again with consent", async () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(globalPath, `{"agentTraces": {"enabled": false},}`);
		await manager.reload();
		expect(manager.getAgentTracesEnabled()).toBe(false);

		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		await manager.reload();

		expect(manager.getAgentTracesEnabled()).toBe(true);
	});

	it("closes agentTraces when the project scope stops parsing", async () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		writeFileSync(projectPath, JSON.stringify({ agentTraces: { enabled: true } }));
		manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getAgentTracesEnabled()).toBe(true);

		writeFileSync(projectPath, `{"agentTraces": {"enabled": false},}`);
		await manager.reload();

		expect(manager.getAgentTracesEnabled()).toBe(false);
	});

	it("closes telemetry when the global file stops parsing after the user opted out", async () => {
		// Telemetry is opt-out, so an empty global file means "on".
		writeFileSync(globalPath, JSON.stringify({}));
		manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getTelemetryEnabled()).toBe(true);

		writeFileSync(globalPath, `{"telemetry": {"enabled": false},}`);
		await manager.reload();

		expect(manager.getTelemetryEnabled()).toBe(false);
	});

	it("does not report a broken external edit as reloaded into the session", async () => {
		writeFileSync(globalPath, JSON.stringify({ agentTraces: { enabled: true } }));
		manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.watchExternalSettings({ intervalMs: 20 })).toBe(true);
		expect(manager.getAgentTracesEnabled()).toBe(true);

		writeFileSync(globalPath, `{"agentTraces": {"enabled": false},}`);

		const deadline = Date.now() + 4000;
		let warnings: Array<{ scope: string; message: string }> = [];
		while (Date.now() < deadline) {
			warnings = manager.drainWarnings("global");
			if (warnings.length > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}

		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0].message).not.toContain("reloaded into this session");
		expect(warnings[0].message).toContain("failed to parse");
		// The gate itself must not act on the old consent either.
		expect(manager.getAgentTracesEnabled()).toBe(false);
	});
});
