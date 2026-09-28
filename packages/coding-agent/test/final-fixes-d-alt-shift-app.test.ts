import type { EditorTheme, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { StdinBuffer, setKeybindings, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";

const passthrough = (text: string) => text;

const editorTheme: EditorTheme = {
	borderColor: passthrough,
	selectList: {
		selectedPrefix: passthrough,
		selectedText: passthrough,
		description: passthrough,
		scrollInfo: passthrough,
		noMatch: passthrough,
	},
};

const fakeOverlayHandle: OverlayHandle = {
	hide: vi.fn(),
	setHidden: vi.fn(),
	isHidden: () => false,
	focus: vi.fn(),
	unfocus: vi.fn(),
	isFocused: () => false,
};

const fakeTui = {
	requestRender: vi.fn(),
	showOverlay: vi.fn(() => fakeOverlayHandle),
	terminal: { rows: 24, columns: 80 },
} as unknown as TUI;

describe("Alt+Shift+letter from a terminal without extended keys (ESC + uppercase letter)", () => {
	beforeEach(() => {
		setKittyProtocolActive(false);
		setKeybindings(new KeybindingsManager());
		vi.clearAllMocks();
	});

	afterEach(() => {
		setKittyProtocolActive(false);
	});

	it("matches app.tools.expandFull (alt+shift+o) and keeps alt+o for app.tools.expandAll", () => {
		const keybindings = new KeybindingsManager();
		expect(keybindings.getKeys("app.tools.expandFull")).toEqual(["alt+shift+o"]);
		expect(keybindings.getKeys("app.tools.expandAll")).toEqual(["alt+o"]);

		expect(keybindings.matches("\x1bO", "app.tools.expandFull")).toBe(true);
		expect(keybindings.matches("\x1bO", "app.tools.expandAll")).toBe(false);
		expect(keybindings.matches("\x1bo", "app.tools.expandAll")).toBe(true);
		expect(keybindings.matches("\x1bo", "app.tools.expandFull")).toBe(false);
	});

	it("matches a user-configured alt+shift binding on the same bytes", () => {
		const keybindings = new KeybindingsManager({ "app.tools.expandFull": "alt+shift+p" });
		expect(keybindings.matches("\x1bP", "app.tools.expandFull")).toBe(true);
		expect(keybindings.matches("\x1bO", "app.tools.expandFull")).toBe(false);
	});

	it("fires the expandFull action for ESC O, not the expandAll one", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const expandFull = vi.fn();
		const expandAll = vi.fn();
		editor.onAction("app.tools.expandFull", expandFull);
		editor.onAction("app.tools.expandAll", expandAll);

		editor.handleInput("\x1bO");
		expect(expandFull).toHaveBeenCalledOnce();
		expect(expandAll).not.toHaveBeenCalled();

		editor.handleInput("\x1bo");
		expect(expandAll).toHaveBeenCalledOnce();
		expect(expandFull).toHaveBeenCalledOnce();
		expect(editor.getText()).toBe("");
	});

	it("does not fire expandFull for the SS3 up arrow", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const expandFull = vi.fn();
		editor.onAction("app.tools.expandFull", expandFull);

		editor.handleInput("\x1bOA");

		expect(expandFull).not.toHaveBeenCalled();
	});

	it("reaches app.model.cycleBackward (shift+alt+m) as ESC M", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const cycleBackward = vi.fn();
		const cycleForward = vi.fn();
		editor.onAction("app.model.cycleBackward", cycleBackward);
		editor.onAction("app.model.cycleForward", cycleForward);

		editor.handleInput("\x1bM");

		expect(cycleBackward).toHaveBeenCalledOnce();
		expect(cycleForward).not.toHaveBeenCalled();
	});

	it("fires the expandFull action for the bytes tmux sends, arriving through the stdin buffer", async () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const expandFull = vi.fn();
		editor.onAction("app.tools.expandFull", expandFull);
		const buffer = new StdinBuffer({ timeout: 10 });
		buffer.on("data", (sequence) => editor.handleInput(sequence));
		try {
			buffer.process("\x1bO");
			await vi.waitFor(() => expect(expandFull).toHaveBeenCalledOnce());
			expect(editor.getText()).toBe("");
		} finally {
			buffer.destroy();
		}
	});
});
