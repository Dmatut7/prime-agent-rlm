import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * review2-3: the warning for an on/off setting written as something other than true or
 * false says how that one file's value reads. It used to say "it is read as off" per
 * scope, which is wrong the moment the other scope decides: a global "false" next to a
 * project true leaves the switch on.
 */
describe("the wording of the not-true-or-false warning (review2-3)", () => {
	let dir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "review2-switch-wording-"));
		agentDir = join(dir, "agent");
		projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const writeGlobal = (settings: unknown) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	const writeProject = (settings: unknown) =>
		writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify(settings));
	const trackingWarnings = (manager: SettingsManager) =>
		manager.drainWarnings().filter((warning) => warning.message.includes("changeTracking"));

	it("describes the value in the file that holds it, in the words of the brief", () => {
		writeGlobal({ changeTracking: { enabled: "false" } });
		const warnings = trackingWarnings(SettingsManager.create(projectDir, agentDir));
		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toBe(
			'changeTracking.enabled in the global settings is "false", not true or false: that value reads as off. Write it as true or false.',
		);
	});

	it("reads an on-word as on and names the project scope for a project file", () => {
		writeProject({ changeTracking: { enabled: "yes" } });
		const warnings = trackingWarnings(SettingsManager.create(projectDir, agentDir));
		expect(warnings).toHaveLength(1);
		expect(warnings[0].scope).toBe("project");
		expect(warnings[0].message).toContain("in the project settings");
		expect(warnings[0].message).toContain("that value reads as on");
	});

	it("does not claim the value is the effective one when the other scope decides", () => {
		writeGlobal({ changeTracking: { enabled: "false" } });
		writeProject({ changeTracking: { enabled: true } });
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getChangeTrackingEnabled()).toBe(true);
		const warnings = trackingWarnings(manager);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].scope).toBe("global");
		expect(warnings[0].message).not.toContain("it is read as");
		expect(warnings[0].message).toContain("that value reads as off");
	});

	it("still warns for an empty string, which keeps reading as the default (on)", () => {
		writeGlobal({ changeTracking: { enabled: "" } });
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getChangeTrackingEnabled()).toBe(true);
		const warnings = trackingWarnings(manager);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].message).toContain('is "", not true or false');
	});
});
