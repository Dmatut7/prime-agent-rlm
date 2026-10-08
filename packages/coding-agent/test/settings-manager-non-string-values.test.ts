import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * R4-M19: a hand-edited settings.json can hold non-string values (`theme: 42`).
 * Four getters passed them straight through, and the /settings panel render
 * threw a TypeError on the number, crashing the process. They now read any
 * malformed value as unset/default, the way this file's other getters do.
 */
describe("SettingsManager non-string setting values", () => {
	let testDir = "";
	let agentDir = "";
	let projectDir = "";

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-settings-nonstr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	it("reads malformed theme/steering/followUp/transport as unset or default", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ theme: 42, steeringMode: 42, followUpMode: true, transport: 42 }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getTheme()).toBeUndefined();
		expect(manager.getSteeringMode()).toBe("one-at-a-time");
		expect(manager.getFollowUpMode()).toBe("one-at-a-time");
		expect(manager.getTransport()).toBe("auto");
	});

	it("still honours well-formed values", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ theme: "dark", steeringMode: "all", followUpMode: "all", transport: "websocket" }),
		);
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getTheme()).toBe("dark");
		expect(manager.getSteeringMode()).toBe("all");
		expect(manager.getFollowUpMode()).toBe("all");
		expect(manager.getTransport()).toBe("websocket");
	});
});
