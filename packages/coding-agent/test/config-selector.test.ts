import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ResolvedPaths } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { ConfigSelectorComponent } from "../src/modes/interactive/components/config-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * R5-M27: the filter box of `prime-agent config` owns printable characters, but
 * a typed space also matched tui.select.toggle, silently flipping whichever
 * resource the filter had selected and writing that to disk. Space is filter
 * text now; Enter toggles (same gate as SettingsList).
 *
 * R6-M14: the toggle write is queued and its failure was only recorded, so a
 * failed write flipped the checkbox while the disk never moved and said
 * nothing. The selector now asks persistenceFailure() and shows the reason.
 */
describe("ConfigSelectorComponent", () => {
	let testDir = "";
	let agentDir = "";
	let projectDir = "";
	let skillPath = "";
	let resolvedPaths: ResolvedPaths;
	let manager: SettingsManager | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		testDir = join(tmpdir(), `pi-config-selector-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(testDir, "agent");
		projectDir = join(testDir, "project");
		mkdirSync(join(agentDir, "skills", "alpha"), { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		skillPath = join(agentDir, "skills", "alpha", "SKILL.md");
		resolvedPaths = {
			extensions: [],
			skills: [
				{
					path: skillPath,
					enabled: true,
					metadata: { source: "auto", scope: "user", origin: "top-level" },
				},
			],
			prompts: [],
			themes: [],
			diagnostics: [],
		};
	});

	afterEach(() => {
		manager?.stopWatchingExternalSettings();
		manager = undefined;
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	function createSelector(): ConfigSelectorComponent {
		manager = SettingsManager.create(projectDir, agentDir);
		return new ConfigSelectorComponent(
			resolvedPaths,
			manager,
			projectDir,
			agentDir,
			() => {},
			() => {},
			() => {},
		);
	}

	function renderText(component: ConfigSelectorComponent): string {
		return stripAnsi(component.render(100).join("\n"));
	}

	it("treats a typed space as filter text, not a silent toggle that writes to disk", async () => {
		const component = createSelector();
		const list = component.getResourceList();

		list.handleInput("a");
		list.handleInput("l");
		expect(renderText(component)).toContain("alpha");

		list.handleInput(" ");

		// The space reached the filter ("al " matches nothing) instead of toggling.
		expect(renderText(component)).toContain("No resources found");
		await manager!.flush();
		expect(manager!.getGlobalSettings().skills).toBeUndefined();
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});

	it("toggles the selected resource with Enter and persists the disable pattern", async () => {
		const component = createSelector();
		const list = component.getResourceList();

		list.handleInput("\r");

		expect(manager!.getGlobalSettings().skills).toEqual(["-skills/alpha/SKILL.md"]);
		expect(renderText(component)).toContain("[ ]");
		await manager!.flush();
		const onDisk = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(onDisk.skills).toEqual(["-skills/alpha/SKILL.md"]);
	});

	it("renders a save-failure line when the toggle write cannot reach the disk", async () => {
		// A directory where the settings file belongs: the write can never land.
		mkdirSync(join(agentDir, "settings.json"));
		const component = createSelector();
		const list = component.getResourceList();

		list.handleInput("\r");

		await vi.waitFor(() => {
			expect(renderText(component)).toContain("保存失败");
		});
		// The in-memory checkbox still flipped; the disk was never written.
		expect(manager!.getGlobalSettings().skills).toEqual(["-skills/alpha/SKILL.md"]);
	});

	it("clears the save-failure line once a later toggle persists", async () => {
		mkdirSync(join(agentDir, "settings.json"));
		const component = createSelector();
		const list = component.getResourceList();

		list.handleInput("\r");
		await vi.waitFor(() => {
			expect(renderText(component)).toContain("保存失败");
		});

		// Repair the file and toggle back: the next verdict clears the line.
		rmSync(join(agentDir, "settings.json"), { recursive: true });
		await manager!.reload();
		list.handleInput("\r");
		await vi.waitFor(() => {
			expect(renderText(component)).not.toContain("保存失败");
		});
		await manager!.flush();
		const onDisk = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(onDisk.skills).toEqual(["+skills/alpha/SKILL.md"]);
	});
});
