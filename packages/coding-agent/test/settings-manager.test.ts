import { ESCALATED_EMPTY_TURN_RETRY_DEFAULTS } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectUnknownSettingsKeys,
	DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS,
	DEFAULT_KERNEL_MAX_RESTARTS,
	DEFAULT_KERNEL_RESTART_WINDOW_MINUTES,
	DEFAULT_KERNEL_REVIVAL_VOUCH_MAX_AGE_SECONDS,
	DEFAULT_STALL_ABORT_AFTER_SECONDS,
	DEFAULT_STALL_WARN_AFTER_SECONDS,
	DEFAULT_TOOL_TIMEOUT_AFTER_MS,
	readAgentMessageWaitSettings,
	readKernelBootstrapSettings,
	SettingsManager,
} from "../src/core/settings-manager.js";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
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

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings when file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});
	});

	describe("onboardingShown", () => {
		it("defaults to false and persists globally", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getOnboardingShown()).toBe(false);

			manager.setOnboardingShown(true);
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.onboardingShown).toBe(true);
			expect(manager.getOnboardingShown()).toBe(true);
		});

		it("treats the legacy completion field as already shown", () => {
			const manager = SettingsManager.inMemory({ onboardingCompleted: true });

			expect(manager.getOnboardingShown()).toBe(true);
		});
	});

	describe("mermaid rendering mode", () => {
		it("survives a non-object markdown settings value when saving the mode", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ markdown: "custom" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setMermaidRenderingMode("off");
			await manager.flush();

			expect(manager.getMermaidRenderingMode()).toBe("off");
			expect(SettingsManager.create(projectDir, agentDir).getMermaidRenderingMode()).toBe("off");
		});
	});

	describe("autoRefine", () => {
		it("defaults to enabled while preserving explicit opt-out", () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getAutoRefineSettings()).toEqual({
				enabled: true,
				turnInterval: 25,
				compact: true,
				cooldownMs: 20 * 60_000,
			});

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ autoRefine: { enabled: false } }));
			const optedOut = SettingsManager.create(projectDir, agentDir);

			expect(optedOut.getAutoRefineSettings().enabled).toBe(false);
		});

		it("falls back to defaults for non-numeric turnInterval and cooldownMs", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ autoRefine: { turnInterval: "oops", cooldownMs: "nope" } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			const settings = manager.getAutoRefineSettings();
			expect(settings.turnInterval).toBe(25);
			expect(settings.cooldownMs).toBe(20 * 60_000);
			expect(Number.isFinite(settings.turnInterval)).toBe(true);
			expect(Number.isFinite(settings.cooldownMs)).toBe(true);
		});

		it("ignores non-finite numeric values that parse to Infinity", () => {
			// 1e999 is valid JSON that JSON.parse turns into Infinity.
			writeFileSync(
				join(agentDir, "settings.json"),
				`{ "autoRefine": { "turnInterval": 1e999, "cooldownMs": 1e999 } }`,
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			const settings = manager.getAutoRefineSettings();
			expect(settings.turnInterval).toBe(25);
			expect(settings.cooldownMs).toBe(20 * 60_000);
		});

		it("preserves valid numeric overrides", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ autoRefine: { turnInterval: 5, cooldownMs: 1000 } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			const settings = manager.getAutoRefineSettings();
			expect(settings.turnInterval).toBe(5);
			expect(settings.cooldownMs).toBe(1000);
		});
	});

	describe("auxiliaryModel", () => {
		it("returns a valid persisted selector", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ auxiliaryModel: "faux/aux-model" }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getAuxiliaryModel()).toBe("faux/aux-model");
		});

		it("treats malformed persisted values as unset", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ auxiliaryModel: 42 }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getAuxiliaryModel()).toBeUndefined();
		});
	});

	describe("recentModels", () => {
		it("records most-recently-used first, dedupes, and persists", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.setDefaultModelAndProvider("prov", "a");
			manager.setDefaultModelAndProvider("prov", "b");
			manager.setDefaultModelAndProvider("prov", "a");
			await manager.flush();

			expect(manager.getRecentModels()).toEqual(["prov/a", "prov/b"]);
			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.recentModels).toEqual(["prov/a", "prov/b"]);
		});

		it("caps the list at the limit", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			for (let i = 0; i < 25; i++) {
				manager.setDefaultModelAndProvider("prov", `m${i}`);
			}
			await manager.flush();

			const recent = manager.getRecentModels();
			expect(recent).toHaveLength(20);
			expect(recent[0]).toBe("prov/m24");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".prime", "agent", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors.map((e) => e.scope).sort()).toEqual(["global", "project"]);
			expect(manager.drainErrors()).toEqual([]);
		});

		it("should report a new global error when saving after the load error was drained", async () => {
			const settingsPath = join(agentDir, "settings.json");
			const invalidSettings = "{ invalid global json";
			writeFileSync(settingsPath, invalidSettings);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainErrors()).toHaveLength(1);

			manager.setRlmMaxDepth(3);
			await manager.flush();

			const errors = manager.drainErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0]?.scope).toBe("global");
			expect(errors[0]?.error.message).toContain("Global settings not saved: settings file failed to parse:");
			expect(readFileSync(settingsPath, "utf-8")).toBe(invalidSettings);
		});

		it("should report a new project error when saving after the load error was drained", async () => {
			const settingsPath = join(projectDir, ".prime", "agent", "settings.json");
			const invalidSettings = "{ invalid project json";
			writeFileSync(settingsPath, invalidSettings);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainErrors()).toHaveLength(1);

			manager.setProjectPackages(["npm:test-pkg"]);
			await manager.flush();

			const errors = manager.drainErrors();
			expect(errors).toHaveLength(1);
			expect(errors[0]?.scope).toBe("project");
			expect(errors[0]?.error.message).toContain("Project settings not saved: settings file failed to parse:");
			expect(readFileSync(settingsPath, "utf-8")).toBe(invalidSettings);
		});

		it("drains only the requested scope", () => {
			writeFileSync(join(agentDir, "settings.json"), "{ invalid global json");
			writeFileSync(join(projectDir, ".prime", "agent", "settings.json"), "{ invalid project json");
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.drainErrors("global").map((entry) => entry.scope)).toEqual(["global"]);
			expect(manager.drainErrors().map((entry) => entry.scope)).toEqual(["project"]);
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .pi folder when only reading project settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			rmSync(join(projectDir, ".prime", "agent"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(existsSync(join(projectDir, ".prime", "agent"))).toBe(false);

			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .pi folder when writing project settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			rmSync(join(projectDir, ".prime", "agent"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(existsSync(join(projectDir, ".prime", "agent"))).toBe(false);

			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			expect(existsSync(join(projectDir, ".prime", "agent"))).toBe(true);

			expect(existsSync(join(projectDir, ".prime", "agent", "settings.json"))).toBe(true);
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ sessionDir: "./sessions" }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});

	describe("mcpServers", () => {
		it("returns undefined when global settings are unset", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getGlobalMcpServers()).toBeUndefined();
		});

		it("ignores project mcpServers when returning executable servers", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					mcpServers: {
						acme: { type: "http", url: "https://global.acme/mcp", oauth: true },
						shared: { type: "http", url: "https://global.shared/mcp" },
					},
				}),
			);
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({
					mcpServers: {
						shared: { type: "http", url: "https://project.shared/mcp" },
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getGlobalMcpServers()).toEqual({
				acme: { type: "http", url: "https://global.acme/mcp", oauth: true },
				shared: { type: "http", url: "https://global.shared/mcp" },
			});
		});
	});
	describe("idle worker eviction", () => {
		it("defaults to 90 minutes and treats none as off", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getIdleEvictionMinutes()).toBe(90);

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ idleEvictionMinutes: "none" }));
			const disabled = SettingsManager.create(projectDir, agentDir);
			expect(disabled.getIdleEvictionMinutes()).toBe("off");
		});

		it("reads and writes the global daemon policy without project overrides", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ idleEvictionMinutes: 60 }));
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ idleEvictionMinutes: 30 }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getIdleEvictionMinutes()).toBe(60);

			manager.setIdleEvictionMinutes("off");
			await manager.flush();
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).idleEvictionMinutes).toBe("off");
		});
	});

	describe("telemetry privacy controls", () => {
		it("does not let project settings override a global opt-out or disclosure state", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ telemetry: { enabled: false, noticeShown: false } }),
			);
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ telemetry: { enabled: true, noticeShown: true } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTelemetryEnabled()).toBe(false);
			expect(manager.getTelemetryNoticeShown()).toBe(false);
		});

		it("allows project settings to further disable globally enabled telemetry", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ telemetry: { enabled: true } }));
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ telemetry: { enabled: false } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTelemetryEnabled()).toBe(false);
		});

		it("allows runtime overrides to further disable telemetry and control disclosure", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ telemetry: { enabled: true, noticeShown: true } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.applyOverrides({ telemetry: { enabled: false, noticeShown: false } });

			expect(manager.getTelemetryEnabled()).toBe(false);
			expect(manager.getTelemetryNoticeShown()).toBe(false);
		});

		it("does not let a runtime override re-enable a global opt-out", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ telemetry: { enabled: false } }));
			const manager = SettingsManager.create(projectDir, agentDir);

			manager.applyOverrides({ telemetry: { enabled: true } });

			expect(manager.getTelemetryEnabled()).toBe(false);
		});
	});

	describe("kernel bootstrap lock timeout", () => {
		it("defaults to five minutes when unset", () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS).toBe(300_000);
			expect(manager.getKernelBootstrapSettings()).toEqual({
				lockTimeoutMs: DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS,
			});
		});

		it("reads a configured timeout live from the merged scopes", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ kernelBootstrap: { lockTimeoutMs: 200 } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getKernelBootstrapSettings()).toEqual({ lockTimeoutMs: 200 });

			// Positive control: a project-scope value wins over the global one, so the
			// getter really re-reads the merged settings instead of a cached default.
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ kernelBootstrap: { lockTimeoutMs: 90_000 } }),
			);
			expect(SettingsManager.create(projectDir, agentDir).getKernelBootstrapSettings()).toEqual({
				lockTimeoutMs: 90_000,
			});
		});

		it("treats 0 as an explicit opt-out and floors fractional values", () => {
			const cases: [unknown, number][] = [
				[0, 0],
				[250.7, 250],
				[-1, DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS],
				[Number.NaN, DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS],
				[Number.POSITIVE_INFINITY, DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS],
				["300", DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS],
			];
			expect(cases.length).toBeGreaterThan(0);
			for (const [configured, expected] of cases) {
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ kernelBootstrap: { lockTimeoutMs: configured } }),
				);
				expect(SettingsManager.create(projectDir, agentDir).getKernelBootstrapSettings()).toEqual({
					lockTimeoutMs: expected,
				});
			}
		});

		it("reads the timeout from disk without a session settings manager", () => {
			expect(readKernelBootstrapSettings(projectDir, agentDir)).toEqual({
				lockTimeoutMs: DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS,
			});

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ kernelBootstrap: { lockTimeoutMs: 200 } }));
			expect(readKernelBootstrapSettings(projectDir, agentDir)).toEqual({ lockTimeoutMs: 200 });
		});

		it("falls back to the default when a settings scope is unreadable", () => {
			writeFileSync(join(agentDir, "settings.json"), "{not json");

			expect(readKernelBootstrapSettings(projectDir, agentDir)).toEqual({
				lockTimeoutMs: DEFAULT_KERNEL_BOOTSTRAP_LOCK_TIMEOUT_MS,
			});
		});
	});

	describe("agent message wait settings", () => {
		it("derives the four tiers from the one long tier", () => {
			expect(SettingsManager.create(projectDir, agentDir).getAgentMessageWaitSettings()).toEqual({
				passivationMs: 120_000,
				bindMs: 60_000,
				hydrateMs: 60_000,
				publicationMs: 60_000,
			});

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentMessage: { targetWaitSeconds: 10 } }));
			expect(SettingsManager.create(projectDir, agentDir).getAgentMessageWaitSettings()).toEqual({
				passivationMs: 10_000,
				bindMs: 5_000,
				hydrateMs: 5_000,
				publicationMs: 5_000,
			});
		});

		it("treats 0 as the unbounded rollback lever and ignores a non-number", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentMessage: { targetWaitSeconds: 0 } }));
			expect(SettingsManager.create(projectDir, agentDir).getAgentMessageWaitSettings()).toEqual({
				passivationMs: Number.POSITIVE_INFINITY,
				bindMs: Number.POSITIVE_INFINITY,
				hydrateMs: Number.POSITIVE_INFINITY,
				publicationMs: Number.POSITIVE_INFINITY,
			});

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentMessage: { targetWaitSeconds: "30" } }));
			expect(SettingsManager.create(projectDir, agentDir).getAgentMessageWaitSettings()).toEqual({
				passivationMs: 120_000,
				bindMs: 60_000,
				hydrateMs: 60_000,
				publicationMs: 60_000,
			});
		});

		it("never resolves a short tier below a second", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentMessage: { targetWaitSeconds: 1 } }));
			expect(SettingsManager.create(projectDir, agentDir).getAgentMessageWaitSettings()).toEqual({
				passivationMs: 1_000,
				bindMs: 1_000,
				hydrateMs: 1_000,
				publicationMs: 1_000,
			});
		});

		it("reads the tiers from disk without a session settings manager", () => {
			expect(readAgentMessageWaitSettings(projectDir, agentDir)).toEqual({
				passivationMs: 120_000,
				bindMs: 60_000,
				hydrateMs: 60_000,
				publicationMs: 60_000,
			});
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentMessage: { targetWaitSeconds: 4 } }));
			expect(readAgentMessageWaitSettings(projectDir, agentDir)).toEqual({
				passivationMs: 4_000,
				bindMs: 2_000,
				hydrateMs: 2_000,
				publicationMs: 2_000,
			});
		});
	});

	describe("kernel restart settings", () => {
		it("resolves the revival budget to its documented defaults", () => {
			expect(DEFAULT_KERNEL_MAX_RESTARTS).toBe(3);
			expect(DEFAULT_KERNEL_RESTART_WINDOW_MINUTES).toBe(60);
			expect(DEFAULT_KERNEL_REVIVAL_VOUCH_MAX_AGE_SECONDS).toBe(600);
			expect(SettingsManager.create(projectDir, agentDir).getKernelRestartSettings()).toEqual({
				maxUnexpectedRestarts: 3,
				windowMs: 60 * 60_000,
				revivalVouchMaxAgeMs: 600_000,
			});
		});

		it("reads a configured budget live from the merged scopes", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ kernelRestart: { maxUnexpectedRestarts: 5, windowMinutes: 10 } }),
			);
			expect(SettingsManager.create(projectDir, agentDir).getKernelRestartSettings()).toEqual({
				maxUnexpectedRestarts: 5,
				windowMs: 600_000,
				revivalVouchMaxAgeMs: 600_000,
			});

			// Positive control: the project scope wins, so the getter really re-reads the merged
			// settings instead of a cached default.
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ kernelRestart: { revivalVouchMaxAgeSeconds: 30 } }),
			);
			expect(SettingsManager.create(projectDir, agentDir).getKernelRestartSettings()).toEqual({
				maxUnexpectedRestarts: 5,
				windowMs: 600_000,
				revivalVouchMaxAgeMs: 30_000,
			});
		});

		it("treats 0 as the unlimited rollback lever and floors fractional values", () => {
			const cases: [unknown, number][] = [
				[0, Number.POSITIVE_INFINITY],
				[-1, Number.POSITIVE_INFINITY],
				[2.7, 2],
				[Number.NaN, DEFAULT_KERNEL_MAX_RESTARTS],
				["3", DEFAULT_KERNEL_MAX_RESTARTS],
			];
			expect(cases.length).toBeGreaterThan(0);
			for (const [configured, expected] of cases) {
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ kernelRestart: { maxUnexpectedRestarts: configured } }),
				);
				expect(SettingsManager.create(projectDir, agentDir).getKernelRestartSettings()).toEqual({
					maxUnexpectedRestarts: expected,
					windowMs: DEFAULT_KERNEL_RESTART_WINDOW_MINUTES * 60_000,
					revivalVouchMaxAgeMs: DEFAULT_KERNEL_REVIVAL_VOUCH_MAX_AGE_SECONDS * 1000,
				});
			}
		});
	});

	describe("stall watchdog settings", () => {
		it("resolves the exemption keys to their documented defaults", () => {
			expect(SettingsManager.create(projectDir, agentDir).getStallWatchdogSettings()).toEqual({
				enabled: true,
				warnAfterSeconds: DEFAULT_STALL_WARN_AFTER_SECONDS,
				abortAfterSeconds: DEFAULT_STALL_ABORT_AFTER_SECONDS,
				toolLivenessExemption: true,
				treatKernelCpuProgressAsActivity: false,
			});
		});

		it("round-trips an explicit opt-out of the tool liveness exemption", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					stallWatchdog: { toolLivenessExemption: false, treatKernelCpuProgressAsActivity: true },
				}),
			);

			const resolved = SettingsManager.create(projectDir, agentDir).getStallWatchdogSettings();
			expect(resolved.toolLivenessExemption).toBe(false);
			// Reserved key: it must survive a read/write round trip even though nothing consumes it.
			expect(resolved.treatKernelCpuProgressAsActivity).toBe(true);
		});

		it("keeps the escalation gap rule while the exemption keys ride along", () => {
			const cases: [{ warnAfterSeconds: number; abortAfterSeconds: number }, number][] = [
				[{ warnAfterSeconds: 0.2, abortAfterSeconds: 0.6 }, 0.6],
				// At or below the warn threshold: normalized to a gap instead of firing both at once.
				[{ warnAfterSeconds: 30, abortAfterSeconds: 30 }, 60],
				// 0 stays 0: warn-only watchdog.
				[{ warnAfterSeconds: 30, abortAfterSeconds: 0 }, 0],
			];
			expect(cases.length).toBeGreaterThan(0);
			for (const [configured, expectedAbort] of cases) {
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ stallWatchdog: configured }));
				const resolved = SettingsManager.create(projectDir, agentDir).getStallWatchdogSettings();
				expect(resolved.abortAfterSeconds).toBe(expectedAbort);
				expect(resolved.toolLivenessExemption).toBe(true);
			}
		});
	});

	describe("r4 recovery settings", () => {
		it("resolves the escalated slow tier defaults and clamps them below the stall warn threshold", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			const resolved = manager.getEmptyTurnRetrySettings();
			// Defaults pass through to the loop untouched: the default cap (120s) sits
			// safely below the default warn threshold (300s), so there is nothing to
			// rewrite - but the clamp field is always resolved, because the loop (not
			// the settings layer) enforces it on the base AND the cap.
			expect(resolved.escalatedAttempts).toBeUndefined();
			expect(resolved.escalatedMaxDelayMs).toBeUndefined();
			expect(resolved.escalatedMaxDelayClampMs).toBe(DEFAULT_STALL_WARN_AFTER_SECONDS * 1000 - 1_000);
			expect(ESCALATED_EMPTY_TURN_RETRY_DEFAULTS.escalatedMaxDelayMs).toBeLessThan(
				DEFAULT_STALL_WARN_AFTER_SECONDS * 1000,
			);

			// A warn threshold below the slow tier's cap clamps the cap (with one
			// second of headroom for the next attempt's time-to-first-event).
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ stallWatchdog: { warnAfterSeconds: 60 } }));
			expect(SettingsManager.create(projectDir, agentDir).getEmptyTurnRetrySettings()).toMatchObject({
				escalatedMaxDelayMs: 59_000,
				escalatedMaxDelayClampMs: 59_000,
			});

			// An explicitly raised cap is clamped the same way, and a base above the
			// clamp rides along untouched: the loop clamps both, so the base cannot
			// pierce it.
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					stallWatchdog: { warnAfterSeconds: 60 },
					retry: {
						emptyTurn: { escalatedMaxDelayMs: 400_000, escalatedBaseDelayMs: 300_000 },
					},
				}),
			);
			expect(SettingsManager.create(projectDir, agentDir).getEmptyTurnRetrySettings()).toMatchObject({
				escalatedBaseDelayMs: 300_000,
				escalatedMaxDelayMs: 59_000,
				escalatedMaxDelayClampMs: 59_000,
			});
		});

		it("retry.enabled false collapses the whole ladder, slow tier and recovery included", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					retry: {
						enabled: false,
						emptyTurn: { escalatedAttempts: 3, recovery: { enabled: true } },
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getEmptyTurnRetrySettings()).toMatchObject({ maxAttempts: 1, escalatedAttempts: 0 });
			expect(manager.getEmptyTurnRecoverySettings()).toEqual({ enabled: false, maxContinuations: 1 });
		});

		it("round-trips the reserved backup-model gear key without consuming it", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ retry: { emptyTurn: { recovery: { useBackupModel: true } } } }),
			);
			expect(collectUnknownSettingsKeys(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")))).toEqual(
				[],
			);
			// Reserved in v1: the recovery policy itself must not change.
			expect(SettingsManager.create(projectDir, agentDir).getEmptyTurnRecoverySettings()).toEqual({
				enabled: true,
				maxContinuations: 1,
			});
		});

		it("resolves the recovery continuation policy with maxContinuations floored", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getEmptyTurnRecoverySettings()).toEqual({ enabled: true, maxContinuations: 1 });

			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ retry: { emptyTurn: { recovery: { enabled: false, maxContinuations: 2.7 } } } }),
			);
			expect(SettingsManager.create(projectDir, agentDir).getEmptyTurnRecoverySettings()).toEqual({
				enabled: false,
				maxContinuations: 2,
			});
		});

		it("resolves the tool timeout defaults, clamp range, and both rollback handles", () => {
			const cases: [{ enabled?: boolean; afterMs?: number }, { enabled: boolean; afterMs: number }][] = [
				[{}, { enabled: true, afterMs: DEFAULT_TOOL_TIMEOUT_AFTER_MS }],
				[{ afterMs: 1000 }, { enabled: true, afterMs: 60_000 }],
				[{ afterMs: 9_000_000 }, { enabled: true, afterMs: 600_000 }],
				[{ enabled: false }, { enabled: false, afterMs: DEFAULT_TOOL_TIMEOUT_AFTER_MS }],
				[{ afterMs: 0 }, { enabled: true, afterMs: 0 }],
				[
					{ enabled: false, afterMs: 0 },
					{ enabled: false, afterMs: 0 },
				],
				// Blind-1, medium: non-numeric afterMs must fall back to the default,
				// not survive every `<= 0` gate as NaN and fire setTimeout(NaN) at ~1ms.
				[
					{ afterMs: "not-a-number" as unknown as number },
					{ enabled: true, afterMs: DEFAULT_TOOL_TIMEOUT_AFTER_MS },
				],
				[{ afterMs: Number.NaN }, { enabled: true, afterMs: DEFAULT_TOOL_TIMEOUT_AFTER_MS }],
				[{ afterMs: Number.POSITIVE_INFINITY }, { enabled: true, afterMs: DEFAULT_TOOL_TIMEOUT_AFTER_MS }],
			];
			expect(cases.length).toBeGreaterThan(0);
			for (const [configured, expected] of cases) {
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tools: { timeout: configured } }));
				expect(SettingsManager.create(projectDir, agentDir).getToolTimeoutSettings()).toEqual(expected);
			}
		});

		it("registers every r4 key so none reads as unknown", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					retry: {
						emptyTurn: {
							maxAttempts: 3,
							baseDelayMs: 500,
							maxDelayMs: 4000,
							maxTotalDelayMs: 8000,
							escalatedAttempts: 3,
							escalatedBaseDelayMs: 30_000,
							escalatedMaxDelayMs: 120_000,
							escalatedMaxDelayClampMs: 299_000,
							escalatedMaxTotalDelayMs: 300_000,
							recovery: { enabled: true, maxContinuations: 1, useBackupModel: false },
						},
					},
					tools: {
						timeout: { enabled: true, afterMs: 180_000, perTool: { mcp__slow: 600_000 } },
					},
				}),
			);
			expect(collectUnknownSettingsKeys(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")))).toEqual(
				[],
			);
			// The per-tool map passes through to the resolved policy unclamped: an
			// operator budgeting one long tool past the shared window is the documented
			// exemption use.
			expect(SettingsManager.create(projectDir, agentDir).getToolTimeoutSettings().perTool).toEqual({
				mcp__slow: 600_000,
			});
			// Misspelled keys stay visible instead of silently doing nothing.
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tools: { timeout: { afterMsX: 1 } } }));
			expect(collectUnknownSettingsKeys(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")))).toEqual([
				"tools.timeout.afterMsX",
			]);
		});
	});

	describe("ui.subagentSpendCell", () => {
		it("defaults to on and reads an explicit opt-out from either scope", () => {
			expect(SettingsManager.create(projectDir, agentDir).getSubagentSpendCellEnabled()).toBe(true);

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ui: { subagentSpendCell: false } }));
			expect(SettingsManager.create(projectDir, agentDir).getSubagentSpendCellEnabled()).toBe(false);

			// No consent semantics here: the closest scope wins, like every other UI key.
			writeFileSync(join(projectDir, ".prime", "agent", "settings.json"), JSON.stringify({ ui: {} }));
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ui: { subagentSpendCell: true } }));
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ ui: { subagentSpendCell: false } }),
			);
			expect(SettingsManager.create(projectDir, agentDir).getSubagentSpendCellEnabled()).toBe(false);
		});

		it("bounds the cadence, defaulting anything that is not a number", () => {
			const interval = (ui: unknown): number => {
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ui }));
				return SettingsManager.create(projectDir, agentDir).getSubagentSpendCellIntervalMs();
			};

			// Absent, boolean and object forms: the boolean is enabled, not a cadence.
			expect(interval({})).toBe(15_000);
			expect(interval({ subagentSpendCell: true })).toBe(15_000);
			expect(interval({ subagentSpendCell: {} })).toBe(15_000);
			expect(interval({ subagentSpendCell: { intervalMs: 30_000 } })).toBe(30_000);

			// Out of range clamps to the bound; an unusable value falls back, never throws.
			const cases: [unknown, number, boolean][] = [
				[1, 5_000, true],
				[5_000, 5_000, true],
				[120_000, 120_000, true],
				[999_999, 120_000, true],
				[7_000.9, 7_000, true],
				["30000", 15_000, true],
				[Number.NaN, 15_000, true],
				[Number.POSITIVE_INFINITY, 15_000, true],
			];
			for (const [configured, expected, stillEnabled] of cases) {
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ ui: { subagentSpendCell: { intervalMs: configured } } }),
				);
				const manager = SettingsManager.create(projectDir, agentDir);
				expect(manager.getSubagentSpendCellIntervalMs()).toBe(expected);
				// A cadence block is a tuning, not an opt-out.
				expect(manager.getSubagentSpendCellEnabled()).toBe(stillEnabled);
			}
			// The opt-out still reads as one, whatever the block would have said.
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ui: { subagentSpendCell: false } }));
			expect(SettingsManager.create(projectDir, agentDir).getSubagentSpendCellEnabled()).toBe(false);
		});

		it("writes a cadence to the global file and knows the nested key", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setSubagentSpendCellIntervalMs(30_000);
			await manager.flush();

			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.ui).toEqual({ subagentSpendCell: { intervalMs: 30_000 } });
			// The nested name is registered; a typo inside the block still reports.
			expect(collectUnknownSettingsKeys({ ui: { subagentSpendCell: { intervalMs: 30_000 } } })).toEqual([]);
			expect(collectUnknownSettingsKeys({ ui: { subagentSpendCell: { interval: 30_000 } } })).toEqual([
				"ui.subagentSpendCell.interval",
			]);
		});

		it("writes the opt-out to the global file and knows the key", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setSubagentSpendCellEnabled(false);
			await manager.flush();

			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.ui).toEqual({ subagentSpendCell: false });

			// The key is registered: a typo still reports as unknown, the real name does not.
			expect(collectUnknownSettingsKeys({ ui: { subagentSpendCell: false } })).toEqual([]);
			expect(collectUnknownSettingsKeys({ ui: { subagentSpendCel: false } })).toEqual(["ui.subagentSpendCel"]);
		});

		it("reads the price overrides a user configured, and reports every value it cannot use", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					ui: {
						subagentSpendCell: {
							priceOverrides: {
								"bailian/kimi-k3": { input: 3, output: "15" },
								"bailian/qwen3.8-flash": { cacheRead: -1 },
								"bailian/glm-5.3": 7,
								"no-slash-key": { input: 1 },
							},
						},
					},
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// Only what can be used is handed to the pricing point: a wrong value never
			// becomes a rate, and never takes the model's other fields down with it.
			expect(manager.getSubagentSpendCellPriceOverrides()).toEqual({ "bailian/kimi-k3": { input: 3 } });

			const warnings = manager.drainWarnings("global");
			// Four refusals, none silent, each naming the full path and what it did instead.
			expect(warnings).toHaveLength(4);
			const messages = warnings.map((warning) => warning.message).join("\n");
			expect(messages).toContain('ui.subagentSpendCell.priceOverrides["bailian/kimi-k3"].output');
			expect(messages).toContain('"15"');
			expect(messages).toContain('ui.subagentSpendCell.priceOverrides["bailian/qwen3.8-flash"].cacheRead');
			expect(messages).toContain('ui.subagentSpendCell.priceOverrides["bailian/glm-5.3"]');
			expect(messages).toContain('ui.subagentSpendCell.priceOverrides["no-slash-key"]');
			for (const message of warnings.map((warning) => warning.message)) {
				expect(message).toMatch(/not a usable price override/);
			}
			// The block itself is a known key, so a clean entry draws no key warning.
			expect(manager.drainWarnings("global")).toEqual([]);
		});

		it("does not report a usable override, and knows the block as a nested key", () => {
			const clean = { "bailian/kimi-k3": { input: 3, output: 15 } };
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ ui: { subagentSpendCell: { priceOverrides: clean } } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSubagentSpendCellPriceOverrides()).toEqual(clean);
			expect(manager.drainWarnings()).toEqual([]);

			// The block is registered, so its own name is not an unknown key - while a
			// misspelling of it still reports, like every other settings name.
			expect(collectUnknownSettingsKeys({ ui: { subagentSpendCell: { priceOverrides: clean } } })).toEqual([]);
			expect(collectUnknownSettingsKeys({ ui: { subagentSpendCell: { priceOverride: clean } } })).toEqual([
				"ui.subagentSpendCell.priceOverride",
			]);
		});

		it("merges a project correction into the global one field by field", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					ui: { subagentSpendCell: { priceOverrides: { "bailian/kimi-k3": { input: 3, output: 15 } } } },
				}),
			);
			writeFileSync(
				join(projectDir, ".prime", "agent", "settings.json"),
				JSON.stringify({ ui: { subagentSpendCell: { priceOverrides: { "bailian/kimi-k3": { input: 7 } } } } }),
			);

			// Settings merge by key at every depth, and this block is no exception: the
			// closer scope corrects the field it names and inherits the rest.
			expect(SettingsManager.create(projectDir, agentDir).getSubagentSpendCellPriceOverrides()).toEqual({
				"bailian/kimi-k3": { input: 7, output: 15 },
			});
		});

		it("keeps a hand-written correction on disk when the app saves the cadence", async () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ ui: { subagentSpendCell: { priceOverrides: { "bailian/kimi-k3": { input: 3 } } } } }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setSubagentSpendCellIntervalMs(30_000);
			await manager.flush();

			// The cadence write merges into the block instead of replacing it: a
			// correction the user wrote by hand is not collateral damage of a UI setting.
			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.ui.subagentSpendCell).toEqual({
				priceOverrides: { "bailian/kimi-k3": { input: 3 } },
				intervalMs: 30_000,
			});
			expect(manager.getSubagentSpendCellPriceOverrides()).toEqual({ "bailian/kimi-k3": { input: 3 } });
		});

		it("reports a correction that changed value again, instead of counting it as a repeat", async () => {
			const write = (input: unknown): void => {
				writeFileSync(
					join(agentDir, "settings.json"),
					JSON.stringify({ ui: { subagentSpendCell: { priceOverrides: { "bailian/kimi-k3": { input } } } } }),
				);
			};

			write("3");
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.drainWarnings("global")).toHaveLength(1);

			// The same unusable value is the same problem: it does not warn twice.
			await manager.reload();
			expect(manager.drainWarnings("global")).toHaveLength(0);

			// A different one is a new problem, and it is reported.
			write(-1);
			await manager.reload();
			expect(manager.drainWarnings("global")).toHaveLength(1);
		});
	});

	// Park bounds are clamped like the other wait bounds: one week per park at most,
	// and non-finite park settings fall back to the defaults.
	describe("provider park bounds", () => {
		it("clamps park bounds and falls back to defaults on invalid values", () => {
			const wait = SettingsManager.inMemory({
				retry: { provider: { waitForUsage: { maxPauseMs: 365 * 86_400_000, maxParks: 99 } } },
			}).getProviderWaitSettings();
			expect([wait.pauseUntilReset, wait.maxPauseMs, wait.maxParks]).toEqual([true, 7 * 86_400_000, 99]);
			const invalid = SettingsManager.inMemory({
				retry: { provider: { waitForUsage: { maxPauseMs: Number.NaN, maxParks: -1 } } },
			}).getProviderWaitSettings();
			expect([invalid.maxPauseMs, invalid.maxParks]).toEqual([86_400_000, 0]);
		});
	});
});
