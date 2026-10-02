import assert from "node:assert";
import { describe, it } from "node:test";
import { type KeybindingDefinitions, KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.js";

// App-style actions registered by downstream packages merge into the same table.
// Augment the package specifier (as downstream packages do): augmenting the
// relative "../src/keybindings.js" path creates a split view of the interface.
declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.test.toggle": true;
		"app.test.holdable": true;
	}
}

// Kitty flag-2 sequences: CSI <codepoint>;<modifier+1>:<event><final>, event 1=press 2=repeat 3=release.
const CTRL_T_PRESS = "\x1b[116;5:1u";
const CTRL_T_REPEAT = "\x1b[116;5:2u";
const CTRL_T_RELEASE = "\x1b[116;5:3u";

const APP_DEFINITIONS: KeybindingDefinitions = {
	"app.test.toggle": { defaultKeys: "ctrl+t", description: "app-style toggle action" },
	"app.test.holdable": {
		defaultKeys: "ctrl+y",
		description: "app action that opted into key repeat",
		repeatable: true,
	},
};

describe("kitty key repeat filtering", () => {
	describe("app-style actions fire on press only", () => {
		it("matches a press but not a repeat of the same key", () => {
			const kb = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_DEFINITIONS });
			assert.equal(kb.matches(CTRL_T_PRESS, "app.test.toggle"), true);
			assert.equal(kb.matches(CTRL_T_REPEAT, "app.test.toggle"), false);
		});

		it("still matches releases; the dispatcher filters those separately", () => {
			const kb = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_DEFINITIONS });
			assert.equal(kb.matches(CTRL_T_RELEASE, "app.test.toggle"), true);
		});

		it("filters repeats of app actions registered in the tui table", () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.equal(kb.matches("\x1b[121;5:1u", "app.stall.diagnostics"), true);
			assert.equal(kb.matches("\x1b[121;5:2u", "app.stall.diagnostics"), false);
		});

		it("keeps filtering after the user rebinds the action", () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "app.stall.diagnostics": "ctrl+g" });
			assert.equal(kb.matches("\x1b[103;5:1u", "app.stall.diagnostics"), true);
			assert.equal(kb.matches("\x1b[103;5:2u", "app.stall.diagnostics"), false);
		});

		it("lets a definition opt back into repeat events", () => {
			const kb = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...APP_DEFINITIONS });
			assert.equal(kb.matches("\x1b[121;5:1u", "app.test.holdable"), true);
			assert.equal(kb.matches("\x1b[121;5:2u", "app.test.holdable"), true);
		});
	});

	describe("repeatable defaults keep hold-to-repeat", () => {
		it("viewport page keys match repeats", () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.equal(kb.matches("\x1b[5;1:2~", "tui.viewport.pageUp"), true);
			assert.equal(kb.matches("\x1b[6;1:2~", "tui.viewport.pageDown"), true);
		});

		it("viewport top/follow match repeats", () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.equal(kb.matches("\x1b[1;4:2A", "tui.viewport.top"), true);
			assert.equal(kb.matches("\x1b[1;6:2B", "tui.viewport.follow"), true);
		});

		it("editor movement and deletion match repeats", () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.equal(kb.matches("\x1b[127;1:2u", "tui.editor.deleteCharBackward"), true);
			assert.equal(kb.matches("\x1b[1;1:2C", "tui.editor.cursorRight"), true);
			assert.equal(kb.matches("\x1b[1;1:2D", "tui.editor.cursorLeft"), true);
		});

		it("select navigation matches repeats", () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.equal(kb.matches("\x1b[1;1:2A", "tui.select.up"), true);
			assert.equal(kb.matches("\x1b[1;1:2B", "tui.select.down"), true);
			assert.equal(kb.matches("\x1b[5;1:2~", "tui.select.pageUp"), true);
		});
	});

	describe("non-repeatable defaults fire once", () => {
		it("select confirm/cancel/toggle ignore repeats", () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.equal(kb.matches("\x1b[13;1:1u", "tui.select.confirm"), true);
			assert.equal(kb.matches("\x1b[13;1:2u", "tui.select.confirm"), false);
			assert.equal(kb.matches("\x1b[27;1:2u", "tui.select.cancel"), false);
			assert.equal(kb.matches("\x1b[32;1:1u", "tui.select.toggle"), true);
			assert.equal(kb.matches("\x1b[32;1:2u", "tui.select.toggle"), false);
		});

		it("the debug dump key ignores repeats", () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.equal(kb.matches("\x1b[100;6:1u", "tui.debug.dump"), true);
			assert.equal(kb.matches("\x1b[100;6:2u", "tui.debug.dump"), false);
		});
	});

	describe("legacy terminals are unaffected", () => {
		it("legacy bytes are never repeat events", () => {
			const kb = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.equal(kb.matches("\x19", "app.stall.diagnostics"), true);
			assert.equal(kb.matches("\r", "tui.select.confirm"), true);
			assert.equal(kb.matches(" ", "tui.select.toggle"), true);
		});
	});
});
