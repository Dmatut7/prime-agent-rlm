import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const mocks = vi.hoisted(() => ({
	spawnSync: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync: mocks.spawnSync };
});

import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.js";

const fakeTui = {
	stop: vi.fn(),
	start: vi.fn(),
	requestRender: vi.fn(),
	terminal: { rows: 24, columns: 80 },
} as unknown as TUI;

describe("ExtensionEditorComponent external editor", () => {
	const originalEditor = process.env.EDITOR;
	const originalVisual = process.env.VISUAL;

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		if (originalEditor === undefined) delete process.env.EDITOR;
		else process.env.EDITOR = originalEditor;
		if (originalVisual === undefined) delete process.env.VISUAL;
		else process.env.VISUAL = originalVisual;
		mocks.spawnSync.mockReset();
		setKeybindings(new KeybindingsManager());
	});

	function createEditor() {
		return new ExtensionEditorComponent(
			fakeTui,
			new KeybindingsManager(),
			"Title",
			"draft",
			() => {},
			() => {},
		);
	}

	it("passes a quoted editor path with spaces to spawn as one word", () => {
		delete process.env.VISUAL;
		process.env.EDITOR = '"/nonexistent dir/ed" --wait';
		mocks.spawnSync.mockReturnValue({ status: 0, error: undefined });
		const component = createEditor();

		component.handleInput("\x07"); // ctrl+g: app.editor.external

		expect(mocks.spawnSync).toHaveBeenCalledOnce();
		const [command, args] = mocks.spawnSync.mock.calls[0]!;
		// split(" ") used to launch "/nonexistent with the rest as argv.
		expect(command).toBe("/nonexistent dir/ed");
		expect(args[0]).toBe("--wait");
	});

	it("surfaces a spawn failure instead of failing silently", () => {
		delete process.env.VISUAL;
		process.env.EDITOR = "/nonexistent/ed";
		mocks.spawnSync.mockReturnValue({ status: null, error: new Error("spawn ENOENT") });
		const component = createEditor();

		component.handleInput("\x07");

		const output = stripAnsi(component.render(60).join("\n"));
		expect(output).toContain("外部编辑器没能启动");
	});
});
