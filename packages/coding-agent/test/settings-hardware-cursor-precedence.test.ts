import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * CD-6 (round-11 config-drift): docs/terminal-setup.md promises that
 * `PI_HARDWARE_CURSOR=1` is how you turn the hardware cursor on, but the file
 * value used to win, so a settings file that once wrote `false` made the
 * documented switch permanently dead. The contract pinned here: an explicitly
 * set env var wins over the file, an unset env var leaves the file in charge,
 * and a conflict between the two is visible.
 */
describe("PI_HARDWARE_CURSOR precedence", () => {
	const testDir = join(process.cwd(), "test-settings-hardware-cursor-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const globalSettingsPath = join(agentDir, "settings.json");
	const originalEnv = process.env.PI_HARDWARE_CURSOR;

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		delete process.env.PI_HARDWARE_CURSOR;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PI_HARDWARE_CURSOR;
		} else {
			process.env.PI_HARDWARE_CURSOR = originalEnv;
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	function writeGlobalCursor(value: boolean): void {
		writeFileSync(globalSettingsPath, JSON.stringify({ showHardwareCursor: value }, null, 2));
	}

	it("lets an explicit PI_HARDWARE_CURSOR=1 win over a file that says false", () => {
		writeGlobalCursor(false);
		process.env.PI_HARDWARE_CURSOR = "1";

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getShowHardwareCursor()).toBe(true);
	});

	it("warns about the env/file conflict and names both values", () => {
		writeGlobalCursor(false);
		process.env.PI_HARDWARE_CURSOR = "1";

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getShowHardwareCursor()).toBe(true);

		const conflicts = manager.drainWarnings().filter((warning) => warning.message.includes("PI_HARDWARE_CURSOR"));
		expect(conflicts.length).toBe(1);
		expect(conflicts[0].message).toContain("true");
		expect(conflicts[0].message).toContain("false");
	});

	it("reports the conflict once even when the setting is read many times", () => {
		writeGlobalCursor(false);
		process.env.PI_HARDWARE_CURSOR = "1";

		const manager = SettingsManager.create(projectDir, agentDir);
		manager.getShowHardwareCursor();
		manager.getShowHardwareCursor();
		manager.getShowHardwareCursor();

		expect(manager.drainWarnings().filter((warning) => warning.message.includes("PI_HARDWARE_CURSOR")).length).toBe(
			1,
		);
		expect(manager.drainWarnings()).toEqual([]);
	});

	it("keeps the file in charge when the env var is unset", () => {
		writeGlobalCursor(false);
		const offManager = SettingsManager.create(projectDir, agentDir);
		expect(offManager.getShowHardwareCursor()).toBe(false);

		writeGlobalCursor(true);
		const onManager = SettingsManager.create(projectDir, agentDir);
		expect(onManager.getShowHardwareCursor()).toBe(true);
	});

	it("defaults to off when neither the env var nor the file sets it", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getShowHardwareCursor()).toBe(false);
	});

	it("reads 1/true/yes as on and 0/false/no as off", () => {
		writeGlobalCursor(true);
		for (const value of ["1", "true", "TRUE", "yes"]) {
			process.env.PI_HARDWARE_CURSOR = value;
			expect(SettingsManager.create(projectDir, agentDir).getShowHardwareCursor()).toBe(true);
		}
		for (const value of ["0", "false", "no"]) {
			process.env.PI_HARDWARE_CURSOR = value;
			expect(SettingsManager.create(projectDir, agentDir).getShowHardwareCursor()).toBe(false);
		}
	});

	it("ignores an unrecognized env value and falls back to the file", () => {
		writeGlobalCursor(true);
		process.env.PI_HARDWARE_CURSOR = "maybe";

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getShowHardwareCursor()).toBe(true);
		expect(manager.drainWarnings()).toEqual([]);
	});

	it("does not warn when the env var and the file agree", () => {
		writeGlobalCursor(false);
		process.env.PI_HARDWARE_CURSOR = "0";

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getShowHardwareCursor()).toBe(false);
		expect(manager.drainWarnings()).toEqual([]);
	});
});
