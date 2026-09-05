import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { Input } from "../src/components/input.js";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.js";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const SHIFT_BACKSPACE = "\x1b[127;2u";

function createTestTUI(): TUI {
	return new TUI(new VirtualTerminal(80, 24));
}

const settingsTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: ">",
	hint: (text) => text,
};

afterEach(() => {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("configurable keybinding overrides", () => {
	it("keeps shift+backspace on deleteCharBackward by default", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.handleInput("a");
		editor.handleInput("b");
		editor.handleInput(SHIFT_BACKSPACE);
		assert.strictEqual(editor.getText(), "a");
	});

	it("lets user config replace deleteCharBackward keys", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.deleteCharBackward": "x",
			}),
		);
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.handleInput("a");
		editor.handleInput("b");
		editor.handleInput("x");
		assert.strictEqual(editor.getText(), "a");
	});

	it("lets user config replace insertSpace keys", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.editor.insertSpace": "y",
			}),
		);
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.handleInput("y");
		assert.strictEqual(editor.getText(), " ");
	});

	it("lets user config replace settings-list toggle", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.select.toggle": "t",
			}),
		);
		const changes: Array<[string, string]> = [];
		const list = new SettingsList(
			[{ id: "mode", label: "Mode", currentValue: "off", values: ["off", "on"] }],
			5,
			settingsTheme,
			(id, value) => {
				changes.push([id, value]);
			},
			() => {},
		);
		list.handleInput(" ");
		assert.deepStrictEqual(changes, []);
		list.handleInput("t");
		assert.deepStrictEqual(changes, [["mode", "on"]]);
	});

	it("lets user config replace Input submit", () => {
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.input.submit": "ctrl+s",
				"tui.input.newLine": [],
			}),
		);
		const input = new Input();
		let submitted: string | undefined;
		input.onSubmit = (value) => {
			submitted = value;
		};
		input.handleInput("h");
		input.handleInput("\r");
		assert.strictEqual(submitted, undefined);
		input.handleInput("\x13");
		assert.strictEqual(submitted, "h");
	});

	it("exposes tui.debug.dump as a configurable binding", () => {
		const defaults = new KeybindingsManager(TUI_KEYBINDINGS);
		assert.deepStrictEqual(defaults.getKeys("tui.debug.dump"), ["shift+ctrl+d"]);
		const overridden = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.debug.dump": "ctrl+alt+d",
		});
		assert.deepStrictEqual(overridden.getKeys("tui.debug.dump"), ["ctrl+alt+d"]);
		assert.strictEqual(overridden.matches("\x1b[100;6u", "tui.debug.dump"), false);
	});
});
