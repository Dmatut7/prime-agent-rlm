import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * FIX-10: `changeTracking.enabled` written as the JSON string "false" is truthy,
 * so `?? true` left tracking on for the person who tried to switch it off, and the
 * session folded that truthy string into "1" for the kernel. The getter has to
 * return a real boolean whatever a hand-edited file holds.
 */
describe("changeTracking.enabled read from a hand-edited settings.json (FIX-10)", () => {
	let dir: string;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "final-fixes-c-tracking-"));
		agentDir = join(dir, "agent");
		projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function loadGlobal(settings: unknown): SettingsManager {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
		return SettingsManager.create(projectDir, agentDir);
	}

	function loadProject(settings: unknown): SettingsManager {
		writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify(settings));
		return SettingsManager.create(projectDir, agentDir);
	}

	const trackingWarnings = (manager: SettingsManager) =>
		manager.drainWarnings().filter((warning) => warning.message.includes("changeTracking"));

	const WRITTEN_VALUES: Array<{ label: string; enabled: unknown; expected: boolean }> = [
		{ label: '"false"', enabled: "false", expected: false },
		{ label: '"no"', enabled: "no", expected: false },
		{ label: '"off"', enabled: "off", expected: false },
		{ label: '"0"', enabled: "0", expected: false },
		{ label: '" False " (padded, mixed case)', enabled: " False ", expected: false },
		{ label: '"OFF"', enabled: "OFF", expected: false },
		{ label: "0", enabled: 0, expected: false },
		{ label: "1", enabled: 1, expected: true },
		{ label: '"yes"', enabled: "yes", expected: true },
		{ label: '"true"', enabled: "true", expected: true },
		{ label: "true", enabled: true, expected: true },
		{ label: "false", enabled: false, expected: false },
		{ label: "null", enabled: null, expected: true },
		{ label: "an object", enabled: { value: false }, expected: true },
	];

	it.each(WRITTEN_VALUES)("reads $label as $expected", ({ enabled, expected }) => {
		const value = loadGlobal({ changeTracking: { enabled } }).getChangeTrackingEnabled();
		expect(typeof value).toBe("boolean");
		expect(value).toBe(expected);
	});

	it("is on when the setting is absent", () => {
		for (const settings of [{}, { changeTracking: {} }]) {
			const value = loadGlobal(settings).getChangeTrackingEnabled();
			expect(typeof value).toBe("boolean");
			expect(value).toBe(true);
		}
	});

	it("honours a project file that switches it off with a string", () => {
		expect(loadProject({ changeTracking: { enabled: "off" } }).getChangeTrackingEnabled()).toBe(false);
	});

	const NOT_BOOLEAN: Array<{ label: string; enabled: unknown }> = [
		{ label: '"false"', enabled: "false" },
		{ label: '"yes"', enabled: "yes" },
		{ label: "0", enabled: 0 },
		{ label: "1", enabled: 1 },
		{ label: "null", enabled: null },
		{ label: "an object", enabled: { value: false } },
	];

	it.each(NOT_BOOLEAN)("warns once that $label is not true or false", ({ enabled }) => {
		const manager = loadGlobal({ changeTracking: { enabled } });
		const warnings = trackingWarnings(manager);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].scope).toBe("global");
		expect(warnings[0].message).toContain("changeTracking.enabled");
		expect(warnings[0].message).toContain(JSON.stringify(enabled));
		manager.getChangeTrackingEnabled();
		manager.getChangeTrackingEnabled();
		expect(trackingWarnings(manager)).toEqual([]);
	});

	it("says how a non-boolean value is read", () => {
		expect(trackingWarnings(loadGlobal({ changeTracking: { enabled: "off" } }))[0].message).toContain("reads as off");
		expect(trackingWarnings(loadGlobal({ changeTracking: { enabled: "yes" } }))[0].message).toContain("reads as on");
	});

	it("names the project scope when the odd value sits in the project file", () => {
		const warnings = trackingWarnings(loadProject({ changeTracking: { enabled: "false" } }));
		expect(warnings).toHaveLength(1);
		expect(warnings[0].scope).toBe("project");
	});

	it("stays silent for real booleans and for an absent setting", () => {
		for (const settings of [{ changeTracking: { enabled: true } }, { changeTracking: { enabled: false } }, {}]) {
			expect(trackingWarnings(loadGlobal(settings))).toEqual([]);
		}
	});

	it("warns again when a reload finds a different odd value, but not for the same one", async () => {
		const manager = loadGlobal({ changeTracking: { enabled: "false" } });
		expect(trackingWarnings(manager)).toHaveLength(1);
		await manager.reload();
		expect(trackingWarnings(manager)).toEqual([]);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ changeTracking: { enabled: "no" } }));
		await manager.reload();
		expect(trackingWarnings(manager)).toHaveLength(1);
		expect(manager.getChangeTrackingEnabled()).toBe(false);
	});
});
