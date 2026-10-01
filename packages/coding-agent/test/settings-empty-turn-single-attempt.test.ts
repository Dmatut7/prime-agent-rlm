import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * W9-B finding 1: `retry.emptyTurn.maxAttempts: 1` is documented as disabling
 * retrying, so the resolved settings must collapse the escalated slow tier too -
 * a lone maxAttempts 1 used to still run three slow-tier resends at 30s+ waits.
 */
describe("SettingsManager empty-turn single-attempt fold", () => {
	const testDir = join(process.cwd(), "test-settings-single-attempt-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("maxAttempts 1 alone collapses the slow tier in the resolved settings", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { emptyTurn: { maxAttempts: 1 } } }));

		const resolved = SettingsManager.create(projectDir, agentDir).getEmptyTurnRetrySettings();

		expect(resolved.maxAttempts).toBe(1);
		expect(resolved.escalatedAttempts).toBe(0);
	});

	it("maxAttempts above 1 leaves the slow tier to the loop defaults", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { emptyTurn: { maxAttempts: 3 } } }));

		const resolved = SettingsManager.create(projectDir, agentDir).getEmptyTurnRetrySettings();

		expect(resolved.maxAttempts).toBe(3);
		expect(resolved.escalatedAttempts).toBeUndefined();
	});

	it("an explicit slow tier survives when maxAttempts allows retries", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { emptyTurn: { maxAttempts: 2, escalatedAttempts: 5 } } }),
		);

		const resolved = SettingsManager.create(projectDir, agentDir).getEmptyTurnRetrySettings();

		expect(resolved.maxAttempts).toBe(2);
		expect(resolved.escalatedAttempts).toBe(5);
	});
});
