import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * CD-3 (round-11 config-drift): settings has no runtime schema check, so a
 * misspelled or removed key silently never takes effect. These tests pin the
 * diagnostic contract: every unknown key is reported (with its full key path),
 * the value the user wrote stays on disk, and the user's intent to switch
 * something off is explicitly called out as not having happened.
 */
describe("settings unknown-key diagnostics", () => {
	const testDir = join(process.cwd(), "test-settings-unknown-keys-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");
	const globalSettingsPath = join(agentDir, "settings.json");
	const projectSettingsPath = join(projectDir, ".prime", "agent", "settings.json");

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

	function writeGlobal(settings: unknown): void {
		writeFileSync(globalSettingsPath, JSON.stringify(settings, null, 2));
	}

	function warningsAbout(manager: SettingsManager, needle: string) {
		return manager.drainWarnings().filter((warning) => warning.message.includes(needle));
	}

	it("reports a misspelled top-level key instead of silently ignoring it", () => {
		writeGlobal({ compactio: { enabled: false } });

		const manager = SettingsManager.create(projectDir, agentDir);

		// The user asked for compaction off; the typo means it is still on.
		expect(manager.getCompactionEnabled()).toBe(true);

		const found = warningsAbout(manager, '"compactio"');
		expect(found.length).toBe(1);
		expect(found[0].scope).toBe("global");
		expect(found[0].message).toMatch(/unknown/i);
		expect(found[0].message).toContain("compactio");
	});

	it("reports a misspelled nested key with its full key path", () => {
		writeGlobal({ compaction: { enabledd: false } });

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getCompactionEnabled()).toBe(true);

		const found = warningsAbout(manager, "compaction.enabledd");
		expect(found.length).toBe(1);
		expect(found[0].message).toMatch(/unknown/i);
		expect(found[0].message).toContain("compaction.enabledd");
	});

	it("reports a key that was removed from Prime Agent", () => {
		// tools.bashTimeoutSeconds was documented but never wired, then removed.
		writeGlobal({ tools: { bashTimeoutSeconds: 5000 } });

		const manager = SettingsManager.create(projectDir, agentDir);

		const found = warningsAbout(manager, "tools.bashTimeoutSeconds");
		expect(found.length).toBe(1);
		expect(found[0].message).toMatch(/unknown/i);
	});

	it("keeps the values a user wrote even when the key is unknown", async () => {
		writeGlobal({ compactio: { enabled: false }, compaction: { enabledd: false } });

		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setTheme("dark");
		await manager.flush();

		const saved = JSON.parse(readFileSync(globalSettingsPath, "utf-8"));
		expect(saved.compactio).toEqual({ enabled: false });
		expect(saved.compaction).toEqual({ enabledd: false });
		expect(saved.theme).toBe("dark");
	});

	it("reports project-scope keys with the project scope and drains by scope", () => {
		writeGlobal({ compactio: { enabled: false } });
		writeFileSync(projectSettingsPath, JSON.stringify({ defaultModelTypo: "x" }));

		const manager = SettingsManager.create(projectDir, agentDir);

		const projectWarnings = manager.drainWarnings("project");
		expect(projectWarnings.length).toBe(1);
		expect(projectWarnings[0].message).toContain("defaultModelTypo");
		expect(projectWarnings[0].scope).toBe("project");

		const globalWarnings = manager.drainWarnings("global");
		expect(globalWarnings.length).toBe(1);
		expect(globalWarnings[0].message).toContain("compactio");

		expect(manager.drainWarnings()).toEqual([]);
	});

	it("does not warn again for the same key and scope", async () => {
		writeGlobal({ compactio: { enabled: false } });

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.drainWarnings().length).toBe(1);
		// A reload re-reads the same file; the key is already reported.
		await manager.reload();
		expect(manager.drainWarnings()).toEqual([]);
	});

	it("does not change the error channel (drainErrors stays empty)", () => {
		writeGlobal({ compactio: { enabled: false } });

		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.drainErrors()).toEqual([]);
	});

	describe("positive controls", () => {
		it("does not warn for correct keys", () => {
			writeGlobal({ compaction: { enabled: false, reserveTokens: 4096 }, theme: "dark" });

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getCompactionEnabled()).toBe(false);
			expect(manager.drainWarnings()).toEqual([]);
		});

		it("does not warn for arbitrary mcpServers names", () => {
			writeGlobal({
				mcpServers: {
					"anything-at-all": { command: "npx", args: ["-y", "some-server"] },
					"another one/with.dots": { url: "http://localhost:1234" },
				},
			});

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainWarnings()).toEqual([]);
		});

		it("does not warn for array-valued keys", () => {
			writeGlobal({
				extensions: ["/tmp/a.ts", "/tmp/b"],
				skills: ["/tmp/skills"],
				recentModels: ["provider/model"],
				packages: ["npm:pkg", { source: "git:x" }],
			});

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainWarnings()).toEqual([]);
		});

		it("does not warn for the keys the P3 merge brought in (they are real settings)", () => {
			// The whitelist's contract is "the top level is the Settings interface verbatim".
			// Six top-level keys the merged tree declares were missing from it, so a user who
			// set any of them got an "unknown key" warning for a setting that does take effect
			// (four of them are read straight out of settings by agent-session:
			// getAutonomousLimits, getProviderWaitSettings, getProviderBackupModel,
			// getSubagentDefaultModel). auxiliaryModel is the sixth; it was already consumed
			// before the merge, which is what makes this test a check on the whitelist rather
			// than on the merge. retry.provider.waitForUsage is the nested one.
			writeGlobal({
				subagentDefaultModel: "faux/child-model",
				updateChannel: "nightly",
				auxiliaryModel: "faux/aux-model",
				providerBackupModel: "faux/backup-model",
				autonomous: { maxContinuations: 3 },
				mcpCatalogSources: ["/tmp/catalog.json"],
				retry: { provider: { waitForUsage: { enabled: true, maxAttempts: 5 } } },
			});

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.drainWarnings()).toEqual([]);
			// Positive control for the reader: the getters really do see these values, so the
			// silence above is "recognized and consumed", not "ignored because unknown".
			expect(manager.getSubagentDefaultModel()).toBe("faux/child-model");
			expect(manager.getProviderBackupModel()).toBe("faux/backup-model");
			expect(manager.getUpdateChannel()).toBe("nightly");
			expect(manager.getProviderWaitSettings().maxAttempts).toBe(5);
		});

		it("does not warn for a project file without unknown keys", () => {
			writeFileSync(projectSettingsPath, JSON.stringify({ theme: "light" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainWarnings()).toEqual([]);
		});
	});
});
