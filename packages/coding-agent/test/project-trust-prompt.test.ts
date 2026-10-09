import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { projectTrustPromptCopy, promptForProjectTrust } from "../src/main.js";
import { ProjectTrustSelectorComponent } from "../src/modes/interactive/components/project-trust-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * A terminal double that keeps the input callback so a test can type into a
 * running prompt TUI. Input handling is the surface under test; rendering goes
 * to an in-memory buffer.
 */
class PromptFakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	private onInput: ((data: string) => void) | undefined;
	writes: string[] = [];

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {
		this.onInput = undefined;
	}
	async drainInput(): Promise<void> {}
	abortPendingInput(): void {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	altScreenActive = false;
	enterAltScreen(): void {}
	leaveAltScreen(): void {}
	mouseTrackingActive = false;
	setMouseTracking(_enabled: boolean): void {}

	type(data: string): void {
		this.onInput?.(data);
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("project trust prompt Ctrl+C", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-trust-prompt-"));
		initTheme("dark");
		// The app keybinding table (with app.clear) must be the global one, as
		// promptForProjectTrust installs before the prompt runs.
		setKeybindings(new KeybindingsManager({}));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("routes Ctrl+C (app.clear) to the interrupt callback, not the shared cancel", () => {
		const events: string[] = [];
		const selector = new ProjectTrustSelectorComponent(
			"title",
			["a", "b"],
			() => events.push("select"),
			() => events.push("cancel"),
			{ onInterrupt: () => events.push("interrupt") },
		);

		// The Ctrl+C byte: the key the shared tui.select.cancel binding also claims.
		selector.handleInput("\x03");
		expect(events).toEqual(["interrupt"]);

		// Escape still dismisses.
		selector.handleInput("\x1b");
		expect(events).toEqual(["interrupt", "cancel"]);

		// Arrow keys still navigate without triggering anything.
		selector.handleInput("\x1b[A");
		expect(events).toEqual(["interrupt", "cancel"]);
	});

	it("exits the process cleanly when Ctrl+C arrives during the prompt", async () => {
		const terminal = new PromptFakeTerminal();
		const exits: number[] = [];
		let signalExit: () => void = () => {};
		const exitSignal = new Promise<void>((resolve) => {
			signalExit = resolve;
		});
		const settingsManager = SettingsManager.create(join(tempDir, "project"), join(tempDir, "agent"));

		const promptPromise = promptForProjectTrust(
			settingsManager,
			join(tempDir, "project"),
			join(tempDir, "project", ".prime/agent/extensions"),
			{
				terminal,
				keybindings: new KeybindingsManager({}),
				exit: (code) => {
					exits.push(code);
					signalExit();
				},
			},
		);

		await waitForRender();
		terminal.type("\x03");

		const outcome = await Promise.race([
			promptPromise.then((value) => ({ kind: "resolved" as const, value })),
			exitSignal.then(() => ({ kind: "exited" as const })),
		]);
		expect(outcome.kind).toBe("exited");
		expect(exits).toEqual([0]);
	});

	it("reinstalls the startup Ctrl+C guard when the prompt finishes", async () => {
		const terminal = new PromptFakeTerminal();
		const watcherInstalls: number[] = [];
		const settingsManager = SettingsManager.create(join(tempDir, "project"), join(tempDir, "agent"));

		const promptPromise = promptForProjectTrust(
			settingsManager,
			join(tempDir, "project"),
			join(tempDir, "project", ".prime/agent/extensions"),
			{
				terminal,
				keybindings: new KeybindingsManager({}),
				exit: () => {
					throw new Error("exit must not be reached in this scenario");
				},
				installExitWatcher: () => {
					watcherInstalls.push(watcherInstalls.length);
					return () => {};
				},
			},
		);

		await waitForRender();
		// Escape dismisses the prompt.
		terminal.type("\x1b");
		const resolution = await promptPromise;

		expect(resolution).toBeUndefined();
		expect(watcherInstalls.length).toBe(1);
	});

	it("answers through the options like the plain extension selector", async () => {
		const terminal = new PromptFakeTerminal();
		const settingsManager = SettingsManager.create(join(tempDir, "project"), join(tempDir, "agent"));

		const promptPromise = promptForProjectTrust(
			settingsManager,
			join(tempDir, "project"),
			join(tempDir, "project", ".prime/agent/extensions"),
			{
				terminal,
				keybindings: new KeybindingsManager({}),
				exit: () => {
					throw new Error("exit must not be reached in this scenario");
				},
				installExitWatcher: () => () => {},
			},
		);

		await waitForRender();
		terminal.type("\r");

		// The cursor starts on 不信任（仅本次会话）(the conservative default);
		// a bare Enter denies trust for this session. Selecting 信任 (option 0)
		// now takes two ups (or three downs) - the old reflexive Enter granting
		// remembered trust is exactly what the conservative default removes.
		await expect(promptPromise).resolves.toEqual({ trusted: false, remember: false });
	});
});

describe("project trust prompt copy", () => {
	it("speaks the product's UI language (Chinese) with the four decision options", () => {
		const copy = projectTrustPromptCopy("/repo", "/repo/.prime/agent/extensions");

		expect(copy.title).toContain("信任此项目的扩展");
		expect(copy.title).toContain("/repo");
		expect(copy.title).toContain("权限");
		expect(copy.options.map((option) => option.label)).toEqual([
			"信任",
			"信任（仅本次会话）",
			"不信任",
			"不信任（仅本次会话）",
		]);
		// The choices keep the remember/trust semantics the resolution logic keys on.
		expect(copy.options.map((option) => option.choice)).toEqual([
			{ trusted: true, remember: true },
			{ trusted: true, remember: false },
			{ trusted: false, remember: true },
			{ trusted: false, remember: false },
		]);
	});
});

describe("project trust prompt footer hint", () => {
	it("labels the dismiss key and the exit key separately", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager({}));
		const selector = new ProjectTrustSelectorComponent(
			"title",
			["a"],
			() => {},
			() => {},
			{
				onInterrupt: () => {},
			},
		);

		const rendered = stripAnsi(selector.render(80).join("\n"));

		// Escape (the shared cancel binding's non-interrupt key) dismisses.
		expect(rendered).toContain("Esc 取消");
		// The interrupt key is labeled as what it does here: exit.
		expect(rendered).toContain("Ctrl+C 退出");
		// The stale shared label that folded Ctrl+C into cancel must be gone.
		expect(rendered).not.toContain("Ctrl+C 取消");
	});
});
