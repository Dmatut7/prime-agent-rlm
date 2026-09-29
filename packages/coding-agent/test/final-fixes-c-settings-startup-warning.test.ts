import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { SettingsManager } from "../src/core/settings-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { createInteractiveModeUiServicesFromServices } from "../src/modes/interactive/interactive-mode-services.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * FIX-11: a settings.json that does not parse used to start the app in silence. The
 * startup diagnostics did name it, but they go to stderr before the TUI takes the
 * screen, so the person saw a normal chat with every setting quietly back on its
 * default. The chat now says so, the way it already does for a broken models.json.
 */

const BROKEN_JSON = '{ "theme": "dark", ';
const parseMessage = (() => {
	try {
		JSON.parse(BROKEN_JSON);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("the broken fixture parses");
})();

const SETTINGS_LINE = "settings.json 有错";

let dir: string;
let agentDir: string;
let projectDir: string;

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "final-fixes-c-settings-startup-"));
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
async function openChat(settingsManagerOf: () => Promise<Awaited<ReturnType<typeof startupServices>>>) {
	const services = await settingsManagerOf();
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
	return {
		services,
		text: () => stripAnsi(chat.render(400).join("\n")),
	};
}

describe("a settings.json that does not parse, at startup (FIX-11)", () => {
	it("shows up in the chat, naming the file and what went wrong", async () => {
		writeFileSync(globalSettingsPath(), BROKEN_JSON);

		const { text } = await openChat(startupServices);

		expect(text()).toContain(SETTINGS_LINE);
		expect(text()).toContain(globalSettingsPath());
		expect(text()).toContain(parseMessage);
		expect(text()).toContain("这次都没有生效");
	});

	it("is one line for the one broken file", async () => {
		writeFileSync(globalSettingsPath(), BROKEN_JSON);

		const { text } = await openChat(startupServices);

		expect(
			text()
				.split("\n")
				.filter((line) => line.includes(SETTINGS_LINE)),
		).toHaveLength(1);
	});

	it("names the project file when that is the broken one", async () => {
		writeFileSync(globalSettingsPath(), JSON.stringify({ theme: "dark" }));
		writeFileSync(projectSettingsPath(), BROKEN_JSON);

		const { text } = await openChat(startupServices);

		expect(text()).toContain(SETTINGS_LINE);
		expect(text()).toContain(projectSettingsPath());
		expect(text()).not.toContain(globalSettingsPath());
	});

	it("says it for both files when both are broken", async () => {
		writeFileSync(globalSettingsPath(), BROKEN_JSON);
		writeFileSync(projectSettingsPath(), BROKEN_JSON);

		const { text } = await openChat(startupServices);

		const lines = text()
			.split("\n")
			.filter((line) => line.includes(SETTINGS_LINE));
		expect(lines).toHaveLength(2);
		expect(lines.some((line) => line.includes(globalSettingsPath()))).toBe(true);
		expect(lines.some((line) => line.includes(projectSettingsPath()))).toBe(true);
	});

	it("says nothing when the settings parse", async () => {
		writeFileSync(globalSettingsPath(), JSON.stringify({ theme: "dark" }));
		writeFileSync(projectSettingsPath(), JSON.stringify({}));

		const { text } = await openChat(startupServices);

		expect(text()).not.toContain(SETTINGS_LINE);
	});

	it("says nothing when there is no settings.json at all", async () => {
		const { text } = await openChat(startupServices);

		expect(text()).not.toContain(SETTINGS_LINE);
	});

	it("stops saying it once the file has been fixed and reloaded", async () => {
		writeFileSync(globalSettingsPath(), BROKEN_JSON);
		let manager: SettingsManager | undefined;
		const services = () =>
			startupServices().then((built) => {
				manager = built.settingsManager;
				return built;
			});
		const first = await openChat(services);
		expect(first.text()).toContain(SETTINGS_LINE);

		writeFileSync(globalSettingsPath(), JSON.stringify({ theme: "dark" }));
		await manager?.reload();
		const second = await openChat(() => Promise.resolve(first.services));

		expect(second.text()).not.toContain(SETTINGS_LINE);
	});
});

describe("the settings manager keeps why a file did not load (FIX-11)", () => {
	it("keeps the load failure after the startup diagnostics drain took the error", async () => {
		writeFileSync(globalSettingsPath(), BROKEN_JSON);
		const { settingsManager } = await startupServices();

		expect(settingsManager.drainErrors()).toEqual([]);
		const failures = settingsManager.getLoadErrors();

		expect(failures).toHaveLength(1);
		expect(failures[0].scope).toBe("global");
		expect(failures[0].path).toBe(globalSettingsPath());
		expect(failures[0].error.message).toBe(parseMessage);
	});

	it("keeps consent withdrawn for the scope that did not parse, as before", async () => {
		writeFileSync(globalSettingsPath(), JSON.stringify({ telemetry: { enabled: true } }));
		writeFileSync(projectSettingsPath(), BROKEN_JSON);
		const { settingsManager } = await startupServices();

		expect(settingsManager.getLoadErrors().map((failure) => failure.scope)).toEqual(["project"]);
		expect(settingsManager.getTelemetryEnabled()).toBe(false);
	});
});
