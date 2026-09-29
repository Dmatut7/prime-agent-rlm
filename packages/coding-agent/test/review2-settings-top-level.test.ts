import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { createInteractiveModeUiServicesFromServices } from "../src/modes/interactive/interactive-mode-services.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * review2-5: a settings.json that is valid JSON but not an object (`[]`, `null`, a
 * number ...) used to load as if it were settings. An array slipped through the
 * migration, every setting silently went back to its default, the only warning was
 * about the unknown keys "0" and "1", and the chat line for a settings file that does
 * not load never appeared. It is now a load failure like a file that does not parse.
 */

const SHAPES: Array<{ label: string; text: string; found: string }> = [
	{ label: "an empty array", text: "[]", found: "an array" },
	{ label: "an array holding a settings object", text: '[{"theme":"dark"}]', found: "an array" },
	{ label: "null", text: "null", found: "null" },
	{ label: "a number", text: "5", found: "a number" },
	{ label: "a string", text: '"dark"', found: "a string" },
	{ label: "a boolean", text: "true", found: "a boolean" },
];

const SETTINGS_LINE = "settings.json 有错";
const messageFor = (found: string) => `settings.json must hold a JSON object, found ${found}`;

let dir: string;
let agentDir: string;
let projectDir: string;

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "review2-settings-top-level-"));
	agentDir = join(dir, "agent");
	projectDir = join(dir, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const globalSettingsPath = () => join(agentDir, "settings.json");
const projectSettingsPath = () => join(projectDir, CONFIG_DIR_NAME, "settings.json");
const load = () => SettingsManager.create(projectDir, agentDir);

describe("a settings.json whose top level is not an object (review2-5)", () => {
	it("lists the shapes under test", () => {
		expect(SHAPES.length).toBeGreaterThan(0);
	});

	it.each(SHAPES)("reports $label in the global file as a load failure", ({ text, found }) => {
		writeFileSync(globalSettingsPath(), text);
		const failures = load().getLoadErrors();
		expect(failures).toHaveLength(1);
		expect(failures[0].scope).toBe("global");
		expect(failures[0].path).toBe(globalSettingsPath());
		expect(failures[0].error.message).toBe(messageFor(found));
	});

	it.each(SHAPES)("reports $label in the project file as a load failure", ({ text, found }) => {
		writeFileSync(globalSettingsPath(), JSON.stringify({ theme: "dark" }));
		writeFileSync(projectSettingsPath(), text);
		const failures = load().getLoadErrors();
		expect(failures).toHaveLength(1);
		expect(failures[0].scope).toBe("project");
		expect(failures[0].path).toBe(projectSettingsPath());
		expect(failures[0].error.message).toBe(messageFor(found));
	});

	it.each(SHAPES)("does not warn about the unknown keys 0 and 1 for $label", ({ text }) => {
		writeFileSync(globalSettingsPath(), text);
		const manager = load();
		expect(manager.drainWarnings().filter((warning) => warning.message.includes("unknown settings key"))).toEqual([]);
	});

	it.each(SHAPES)("keeps the consent gates closed for $label, in either scope", ({ text }) => {
		writeFileSync(globalSettingsPath(), text);
		const inGlobal = load();
		expect(inGlobal.getAgentTracesEnabled()).toBe(false);
		expect(inGlobal.getTelemetryEnabled()).toBe(false);

		writeFileSync(
			globalSettingsPath(),
			JSON.stringify({ agentTraces: { enabled: true }, telemetry: { enabled: true } }),
		);
		expect(load().getAgentTracesEnabled()).toBe(true);
		writeFileSync(projectSettingsPath(), text);
		const inProject = load();
		expect(inProject.getAgentTracesEnabled()).toBe(false);
		expect(inProject.getTelemetryEnabled()).toBe(false);
	});

	it("still loads an object, an empty object and an empty file without a failure", () => {
		for (const text of ['{"theme":"dark"}', "{}", ""]) {
			writeFileSync(globalSettingsPath(), text);
			writeFileSync(projectSettingsPath(), text);
			expect(load().getLoadErrors(), JSON.stringify(text)).toEqual([]);
		}
	});

	it("drops a repository-level file that is not an object without discarding the session's own file", () => {
		const repoRoot = join(dir, "repo");
		const sessionDir = join(repoRoot, "packages", "app");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(join(repoRoot, CONFIG_DIR_NAME), { recursive: true });
		mkdirSync(join(sessionDir, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(repoRoot, CONFIG_DIR_NAME, "settings.json"), "[]");
		writeFileSync(join(sessionDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ quietStartup: true }));
		writeFileSync(globalSettingsPath(), JSON.stringify({ telemetry: { enabled: true } }));

		const manager = SettingsManager.create(sessionDir, agentDir);

		expect(manager.getLoadErrors()).toEqual([]);
		expect(manager.getQuietStartup()).toBe(true);
		expect(manager.getTelemetryEnabled()).toBe(false);
		const warnings = manager.drainWarnings();
		expect(warnings.some((warning) => warning.message.includes(messageFor("an array")))).toBe(true);
		expect(warnings.some((warning) => warning.message.includes('unknown settings key "0"'))).toBe(false);
	});

	it("fails a reload the same way when an edit turns the file into an array, and recovers when it is fixed", async () => {
		writeFileSync(globalSettingsPath(), JSON.stringify({ quietStartup: true }));
		const manager = load();
		expect(manager.getLoadErrors()).toEqual([]);

		writeFileSync(globalSettingsPath(), "[]");
		await manager.reload();
		expect(manager.getLoadErrors().map((failure) => failure.error.message)).toEqual([messageFor("an array")]);

		writeFileSync(globalSettingsPath(), JSON.stringify({ quietStartup: false }));
		await manager.reload();
		expect(manager.getLoadErrors()).toEqual([]);
		expect(manager.getQuietStartup()).toBe(false);
	});

	it("does not rewrite a file that became an array into an object with numbered keys", async () => {
		writeFileSync(globalSettingsPath(), JSON.stringify({ theme: "dark" }));
		const manager = load();

		writeFileSync(globalSettingsPath(), "[1]");
		manager.setQuietStartup(true);

		const failure = await manager.persistenceFailure("global");
		expect(failure).toContain(messageFor("an array"));
		expect(readFileSync(globalSettingsPath(), "utf-8")).toBe("[1]");
	});
});

/** The services the client builds for its own UI, then the diagnostics drain the startup path runs over them. */
async function startupServices() {
	const services = await createAgentSessionServices({
		cwd: projectDir,
		agentDir,
		noBuiltinHerdrReporter: true,
		watchSettingsFile: false,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	services.settingsManager.drainErrors();
	services.settingsManager.drainWarnings();
	return services;
}

/** `run()` on a mode that has a real chat, real services and nothing else: the startup notices land in that chat. */
async function openChat() {
	const services = await startupServices();
	const uiServices = createInteractiveModeUiServicesFromServices({
		services,
		sessionManager: SessionManager.inMemory(projectDir),
	});
	const chat = new Container();
	let leave: () => void = () => {};
	const inputDone = new Promise<void>((resolve) => {
		leave = resolve;
	});
	const fake: Record<string, unknown> = {
		options: { agentsViewOwnsStartupNotices: true },
		uiServices,
		chatContainer: chat,
		ui: { requestRender: () => {} },
		init: async () => {},
		restorePromptStashOnOpen: () => {},
		runStartupOnboarding: async () => true,
		getModelFallbackWarningAction: () => "suppress",
		maybeWarnAboutAnthropicSubscriptionAuth: () => {},
		getUserInput: () => inputDone,
		getCurrentCwd: () => projectDir,
		connectionState: { messageCount: 0 },
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	const mode = fake as unknown as InteractiveMode;
	const run = mode.run();
	leave();
	await run;
	return { text: () => stripAnsi(chat.render(400).join("\n")) };
}

describe("the chat says a settings.json that is not an object did not load (review2-5)", () => {
	it("names the global file and the reason for an array", async () => {
		writeFileSync(globalSettingsPath(), "[]");

		const { text } = await openChat();

		expect(text()).toContain(SETTINGS_LINE);
		expect(text()).toContain(globalSettingsPath());
		expect(text()).toContain(messageFor("an array"));
		expect(text()).toContain("这次都没有生效");
	});

	it("names the project file for an array that holds a settings object", async () => {
		writeFileSync(globalSettingsPath(), JSON.stringify({ theme: "dark" }));
		writeFileSync(projectSettingsPath(), '[{"theme":"dark"}]');

		const { text } = await openChat();

		expect(text()).toContain(SETTINGS_LINE);
		expect(text()).toContain(projectSettingsPath());
		expect(text()).not.toContain(globalSettingsPath());
		expect(text()).toContain(messageFor("an array"));
	});

	it("says it for null, which used to fail with a message about the in operator", async () => {
		writeFileSync(globalSettingsPath(), "null");

		const { text } = await openChat();

		expect(text()).toContain(messageFor("null"));
		expect(text()).not.toContain("'in' operator");
	});

	it("says nothing for a plain settings object", async () => {
		writeFileSync(globalSettingsPath(), JSON.stringify({ theme: "dark" }));

		const { text } = await openChat();

		expect(text()).not.toContain(SETTINGS_LINE);
	});
});
