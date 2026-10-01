import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { SettingsManager } from "../src/core/settings-manager.js";

/**
 * review2-4: `"false"` written in quotes used to switch changeTracking off and leave
 * every other on/off setting on, because only that one getter read a hand-edited value
 * leniently. Every on/off setting now reads a real boolean whatever the file holds.
 */

interface Switch {
	/** Dotted settings path, as the warning names it. */
	path: string;
	/** What the getter answers when the setting is absent. */
	fallback: boolean;
	read: (manager: SettingsManager) => boolean;
}

const SWITCHES: Switch[] = [
	{ path: "compaction.enabled", fallback: true, read: (m) => m.getCompactionEnabled() },
	{ path: "compaction.agentCallable", fallback: true, read: (m) => m.getCompactionAgentCallable() },
	{
		path: "compaction.priorityOverAgentMessages",
		fallback: true,
		read: (m) => m.getCompactionPriorityOverAgentMessages(),
	},
	{ path: "branchSummary.skipPrompt", fallback: false, read: (m) => m.getBranchSummarySkipPrompt() },
	{ path: "retry.enabled", fallback: true, read: (m) => m.getRetryEnabled() },
	{ path: "hideThinkingBlock", fallback: false, read: (m) => m.getHideThinkingBlock() },
	{ path: "quietStartup", fallback: false, read: (m) => m.getQuietStartup() },
	{ path: "enableSkillCommands", fallback: true, read: (m) => m.getEnableSkillCommands() },
	{ path: "enableBuiltinSkills", fallback: true, read: (m) => m.getEnableBuiltinSkills() },
	{ path: "terminal.showImages", fallback: true, read: (m) => m.getShowImages() },
	{ path: "terminal.fullscreen", fallback: true, read: (m) => m.getFullscreen() },
	{ path: "terminal.fullscreenMouse", fallback: true, read: (m) => m.getFullscreenMouse() },
	{ path: "terminal.showTerminalProgress", fallback: false, read: (m) => m.getShowTerminalProgress() },
	{ path: "terminal.clearOnShrink", fallback: false, read: (m) => m.getClearOnShrink() },
	{ path: "images.autoResize", fallback: true, read: (m) => m.getImageAutoResize() },
	{ path: "images.blockImages", fallback: false, read: (m) => m.getBlockImages() },
	{ path: "requestTiming", fallback: false, read: (m) => m.getRequestTiming() },
	{ path: "showHardwareCursor", fallback: false, read: (m) => m.getShowHardwareCursor() },
	{ path: "agentTraces.enabled", fallback: false, read: (m) => m.getAgentTracesEnabled() },
	{ path: "telemetry.enabled", fallback: true, read: (m) => m.getTelemetryEnabled() },
	{ path: "autoRefine.enabled", fallback: true, read: (m) => m.getAutoRefineSettings().enabled },
	{ path: "autoRefine.compact", fallback: true, read: (m) => m.getAutoRefineSettings().compact },
	{ path: "stallWatchdog.enabled", fallback: true, read: (m) => m.getStallWatchdogSettings().enabled },
	{
		path: "stallWatchdog.toolLivenessExemption",
		fallback: true,
		read: (m) => m.getStallWatchdogSettings().toolLivenessExemption === true,
	},
	{
		path: "stallWatchdog.treatKernelCpuProgressAsActivity",
		fallback: false,
		read: (m) => m.getStallWatchdogSettings().treatKernelCpuProgressAsActivity === true,
	},
	{
		path: "stallWatchdog.rootRecovery.enabled",
		fallback: true,
		read: (m) => m.getRootStallRecoverySettings().enabled,
	},
	{
		path: "subagents.stallRecovery.enabled",
		fallback: false,
		read: (m) => m.getSubagentStallRecoverySettings().enabled,
	},
	{
		path: "daemon.failedWorkerReapEnabled",
		fallback: true,
		read: (m) => m.getDaemonSupervisorSettings().failedWorkerReapHours !== undefined,
	},
	{ path: "selfRecovery.autoContinue", fallback: true, read: (m) => m.getSelfRecoverySettings().autoContinue },
	{ path: "selfRecovery.childReplyNudge", fallback: false, read: (m) => m.getSelfRecoverySettings().childReplyNudge },
	{
		path: "retry.emptyTurn.recovery.enabled",
		fallback: true,
		read: (m) => m.getEmptyTurnRecoverySettings().enabled,
	},
	{ path: "tools.timeout.enabled", fallback: true, read: (m) => m.getToolTimeoutSettings().enabled },
	{
		path: "retry.provider.waitForUsage.enabled",
		fallback: true,
		read: (m) => m.getProviderWaitSettings().enabled,
	},
	{
		path: "retry.provider.waitForUsage.pauseUntilReset",
		fallback: true,
		read: (m) => m.getProviderWaitSettings().pauseUntilReset,
	},
	{ path: "bundledSkills.websearch", fallback: true, read: (m) => m.getBundledWebsearchEnabled() },
	{ path: "ui.timelineOpenWhileWorking", fallback: true, read: (m) => m.getTimelineOpenWhileWorking() },
	{ path: "ui.timelineAutoFold", fallback: true, read: (m) => m.getTimelineAutoFold() },
	{ path: "ui.reduceMotion", fallback: false, read: (m) => m.getReduceMotion() },
	{ path: "retention.enabled", fallback: true, read: (m) => m.getRetentionSettings().enabled },
	{ path: "retention.dryRun", fallback: false, read: (m) => m.getRetentionSettings().dryRun },
	{ path: "retention.sweepLockEnabled", fallback: true, read: (m) => m.getRetentionSettings().sweepLockEnabled },
	{
		path: "retention.ledgerCompactionEnabled",
		fallback: true,
		read: (m) => m.getRetentionSettings().ledgerCompactionEnabled,
	},
	{ path: "changeTracking.enabled", fallback: true, read: (m) => m.getChangeTrackingEnabled() },
];

const ENV_NAMES = ["PI_FULLSCREEN", "PI_CLEAR_ON_SHRINK", "PI_HARDWARE_CURSOR", "PRIME_AGENT_RETENTION_DRYRUN"];

/** The not-true-or-false warnings that name this setting (an unknown-key warning names it too, and is not the subject here). */
function switchWarnings(manager: SettingsManager, path: string) {
	return manager
		.drainWarnings()
		.filter((warning) => warning.message.includes(path) && warning.message.includes("not true or false"));
}

function nest(path: string, value: unknown): Record<string, unknown> {
	const keys = path.split(".");
	let node: unknown = value;
	for (const key of keys.reverse()) {
		node = { [key]: node };
	}
	return node as Record<string, unknown>;
}

describe("every on/off setting reads a hand-edited value as a real boolean (review2-4)", () => {
	let dir: string;
	let agentDir: string;
	let projectDir: string;
	let savedEnv: Array<[string, string | undefined]>;

	beforeEach(() => {
		savedEnv = ENV_NAMES.map((name) => [name, process.env[name]]);
		for (const name of ENV_NAMES) delete process.env[name];
		dir = mkdtempSync(join(tmpdir(), "review2-switches-"));
		agentDir = join(dir, "agent");
		projectDir = join(dir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	});

	afterEach(() => {
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});

	function load(settings: unknown): SettingsManager {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
		return SettingsManager.create(projectDir, agentDir);
	}

	/**
	 * A global agentTraces file is read against the project scope too, but an absent
	 * project file leaves it at "no veto", so the same one-file setup works for every switch.
	 */
	const WRITTEN: Array<{ label: string; value: unknown; expected: boolean }> = [
		{ label: '"false"', value: "false", expected: false },
		{ label: '"off"', value: "off", expected: false },
		{ label: '"no"', value: "no", expected: false },
		{ label: '" False " (padded, mixed case)', value: " False ", expected: false },
		{ label: "0", value: 0, expected: false },
		{ label: '"true"', value: "true", expected: true },
		{ label: '"yes"', value: "yes", expected: true },
		{ label: "1", value: 1, expected: true },
		{ label: "true", value: true, expected: true },
		{ label: "false", value: false, expected: false },
	];

	it("covers a real list of switches, with at least the sixteen the brief names", () => {
		expect(SWITCHES.length).toBeGreaterThanOrEqual(16);
		expect(new Set(SWITCHES.map((entry) => entry.path)).size).toBe(SWITCHES.length);
		expect(WRITTEN.length).toBeGreaterThan(0);
	});

	it.each(SWITCHES)("$path: an absent setting keeps its default ($fallback)", ({ fallback, read }) => {
		for (const settings of [{}, { unrelatedKey: 1 }]) {
			const value = read(load(settings));
			expect(typeof value).toBe("boolean");
			expect(value).toBe(fallback);
		}
	});

	it.each(SWITCHES)("$path: reads false, off, no, 0 as off and true, yes, 1 as on", ({ path, read }) => {
		for (const { label, value, expected } of WRITTEN) {
			const actual = read(load(nest(path, value)));
			expect(typeof actual, `${path} = ${label}`).toBe("boolean");
			expect(actual, `${path} = ${label}`).toBe(expected);
		}
	});

	it.each(SWITCHES)("$path: null or an object reads as the default", ({ path, fallback, read }) => {
		for (const value of [null, { value: false }]) {
			expect(read(load(nest(path, value))), `${path} = ${JSON.stringify(value)}`).toBe(fallback);
		}
	});

	it.each(SWITCHES)("$path: warns once for a value that is not true or false", ({ path }) => {
		const manager = load(nest(path, "false"));
		const warnings = switchWarnings(manager, path);
		expect(warnings).toHaveLength(1);
		expect(warnings[0].scope).toBe("global");
		expect(warnings[0].message).toBe(
			`${path} in the global settings is "false", not true or false: that value reads as off. Write it as true or false.`,
		);
	});

	it.each(SWITCHES)("$path: reports each odd value once, and again for a different one", async ({ path }) => {
		const manager = load(nest(path, "false"));
		manager.drainWarnings();
		await manager.reload();
		expect(switchWarnings(manager, path)).toEqual([]);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(nest(path, "no")));
		await manager.reload();
		expect(switchWarnings(manager, path)).toHaveLength(1);
	});

	it.each(SWITCHES)("$path: stays silent for real booleans and for an absent setting", ({ path }) => {
		for (const settings of [nest(path, true), nest(path, false), {}]) {
			expect(switchWarnings(load(settings), path)).toEqual([]);
		}
	});

	it("names the project scope when the odd value sits in the project file", () => {
		writeFileSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ retry: { enabled: "off" } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getRetryEnabled()).toBe(false);
		const warnings = switchWarnings(manager, "retry.enabled");
		expect(warnings).toHaveLength(1);
		expect(warnings[0].scope).toBe("project");
	});
});

describe("the consent settings read a quoted false as false (review2-4)", () => {
	let dir: string;
	let agentDir: string;
	let repoRoot: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "review2-consent-"));
		agentDir = join(dir, "agent");
		repoRoot = join(dir, "repo");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(join(repoRoot, CONFIG_DIR_NAME), { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('does not upload session transcripts for a global agentTraces.enabled of "false"', () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentTraces: { enabled: "false" } }));
		expect(SettingsManager.create(repoRoot, agentDir).getAgentTracesEnabled()).toBe(false);
	});

	it('does not send telemetry for a global telemetry.enabled of "false"', () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ telemetry: { enabled: "false" } }));
		expect(SettingsManager.create(repoRoot, agentDir).getTelemetryEnabled()).toBe(false);
	});

	it("lets a project file withhold consent with a quoted false", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentTraces: { enabled: true } }));
		writeFileSync(
			join(repoRoot, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ agentTraces: { enabled: "false" } }),
		);
		expect(SettingsManager.create(repoRoot, agentDir).getAgentTracesEnabled()).toBe(false);
	});

	it("keeps a repository-level quoted false as a veto over a subdirectory that re-enables", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ telemetry: { enabled: true } }));
		writeFileSync(
			join(repoRoot, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ telemetry: { enabled: "false" } }),
		);
		const subDir = join(repoRoot, "packages", "app");
		mkdirSync(join(subDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(subDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ telemetry: { enabled: true } }));
		expect(SettingsManager.create(subDir, agentDir).getTelemetryEnabled()).toBe(false);
	});

	it("keeps consent given by a plain true untouched", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentTraces: { enabled: true } }));
		const manager = SettingsManager.create(repoRoot, agentDir);
		expect(manager.getAgentTracesEnabled()).toBe(true);
		expect(manager.getTelemetryEnabled()).toBe(true);
	});

	it("still fails closed when the settings file does not parse", () => {
		writeFileSync(join(agentDir, "settings.json"), '{ "agentTraces": { "enabled": true }, ');
		const manager = SettingsManager.create(repoRoot, agentDir);
		expect(manager.getAgentTracesEnabled()).toBe(false);
		expect(manager.getTelemetryEnabled()).toBe(false);
	});
});
