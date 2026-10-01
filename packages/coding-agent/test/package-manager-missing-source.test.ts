import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * Regression tests for the settings `packages` consent gap: a cloned repository's
 * `.prime/settings.json` used to trigger an unattended `npm install` / `git clone`
 * (postinstall scripts, extension code) on session start, and an npm spec shaped
 * like a flag (`--registry=...`) could redirect that install. Project-scope
 * packages now skip when no `onMissing` callback can ask, and flag-shaped specs
 * are rejected at the parser.
 */
describe("DefaultPackageManager missing-source consent", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let previousOfflineEnv: string | undefined;
	let previousTmpDir: string | undefined;

	beforeEach(() => {
		previousOfflineEnv = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;
		tempDir = join(tmpdir(), `pm-consent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		previousTmpDir = process.env.TMPDIR;
		process.env.TMPDIR = tempDir;
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
		});
	});

	afterEach(() => {
		if (previousTmpDir === undefined) {
			delete process.env.TMPDIR;
		} else {
			process.env.TMPDIR = previousTmpDir;
		}
		if (previousOfflineEnv === undefined) {
			delete process.env.PI_OFFLINE;
		} else {
			process.env.PI_OFFLINE = previousOfflineEnv;
		}
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("skips a missing project-scope npm package when no onMissing can ask", async () => {
		settingsManager.setProjectPackages(["npm:definitely-not-installed-pkg"]);

		const result = await packageManager.resolve();

		// Skipped with a surfaced reason, not installed: no npm child process ran
		// (a real install of a bogus package would fail or take seconds), the
		// install path does not exist, and the diagnostic points at the fix.
		expect(packageManager.getInstalledPath("npm:definitely-not-installed-pkg", "project")).toBeUndefined();
		const warning = result.diagnostics.find((d) => d.message.includes("definitely-not-installed-pkg"));
		expect(warning?.type).toBe("warning");
		expect(warning?.message).toContain("skipped");
	});

	it("skips a missing project-scope git package when no onMissing can ask", async () => {
		settingsManager.setProjectPackages(["https://github.com/some-org/not-installed-repo"]);

		const result = await packageManager.resolve();

		expect(
			packageManager.getInstalledPath("https://github.com/some-org/not-installed-repo", "project"),
		).toBeUndefined();
		const warning = result.diagnostics.find((d) => d.message.includes("not-installed-repo"));
		expect(warning?.type).toBe("warning");
		expect(warning?.message).toContain("skipped");
	});

	it("consults onMissing for a missing project package when a caller can ask", async () => {
		settingsManager.setProjectPackages(["npm:definitely-not-installed-pkg"]);
		const onMissing = vi.fn(async () => "skip" as const);

		const result = await packageManager.resolve(onMissing);

		expect(onMissing).toHaveBeenCalledWith("npm:definitely-not-installed-pkg");
		expect(result.diagnostics.some((d) => d.message.includes("was skipped"))).toBe(false);
	});

	it("propagates an onMissing error decision", async () => {
		settingsManager.setProjectPackages(["npm:definitely-not-installed-pkg"]);

		await expect(packageManager.resolve(async () => "error")).rejects.toThrow(
			"Missing source: npm:definitely-not-installed-pkg",
		);
	});

	it("rejects a flag-shaped npm spec from project settings instead of feeding it to npm", async () => {
		settingsManager.setProjectPackages(["npm:--registry=https://evil.example"]);

		// Resolution itself must not fail: the poisoned entry is reported and dropped.
		const result = await packageManager.resolve();

		const warning = result.diagnostics.find((d) => d.message.includes("--registry"));
		expect(warning?.type).toBe("warning");
		expect(warning?.message).toContain("Invalid npm package spec");
	});

	it("rejects a flag-shaped npm spec from user settings before any install runs", async () => {
		// User scope keeps auto-install, so this spec reaching the installer would run
		// real npm; the parser rejection upstream means resolution returns at once with
		// a diagnostic and no child process.
		settingsManager.setPackages(["npm:--registry=https://evil.example"]);

		const result = await packageManager.resolve();

		const warning = result.diagnostics.find((d) => d.message.includes("--registry"));
		expect(warning?.type).toBe("warning");
		expect(warning?.message).toContain("Invalid npm package spec");
	});

	it("reports a flag-shaped npm spec on the explicit install path", async () => {
		await expect(packageManager.install("npm:--registry=https://evil.example")).rejects.toThrow(
			"Invalid npm package spec",
		);
	});
});

describe("DefaultResourceLoader onMissingPackage wiring", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-consent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("passes onMissingPackage through to package resolution on reload", async () => {
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setProjectPackages(["npm:definitely-not-installed-pkg"]);
		const onMissingPackage = vi.fn(async () => "skip" as const);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			bundledSkillsDir: null,
			onMissingPackage,
		});

		await loader.reload();

		expect(onMissingPackage).toHaveBeenCalledWith("npm:definitely-not-installed-pkg");
	});

	it("surfaces the skip diagnostic for a missing project package when nobody can ask", async () => {
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setProjectPackages(["npm:definitely-not-installed-pkg"]);
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, bundledSkillsDir: null });

		await loader.reload();

		const { diagnostics } = loader.getSkills();
		expect(diagnostics.some((d) => d.message.includes("definitely-not-installed-pkg") && d.type === "warning")).toBe(
			true,
		);
	});
});
