import type { EditorTheme, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor, DECLINE_KEY } from "../src/modes/interactive/components/custom-editor.js";

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

// Ctrl+J as a Kitty CSI-u sequence: app.turn.focus and app.edits.expand both default to it.
const CTRL_J = "\x1b[106;5u";

function newEditor(): CustomEditor {
	return new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
}

describe("action handlers on a shared key", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.clearAllMocks();
	});

	it("consumes the key for every result except DECLINE_KEY, false included", () => {
		const consumingResults: unknown[] = [false, true, undefined, null, 0, ""];
		expect(consumingResults.length).toBeGreaterThan(0);
		for (const result of consumingResults) {
			const editor = newEditor();
			const first = vi.fn(() => result);
			const second = vi.fn();
			editor.onAction("app.turn.focus", first);
			editor.onAction("app.edits.expand", second);

			editor.handleInput(CTRL_J);

			expect(first, `result ${JSON.stringify(result) ?? String(result)}`).toHaveBeenCalledOnce();
			expect(second, `result ${JSON.stringify(result) ?? String(result)}`).not.toHaveBeenCalled();
		}
	});

	it("hands the key to the next action only for DECLINE_KEY", () => {
		const editor = newEditor();
		const first = vi.fn(() => DECLINE_KEY);
		const second = vi.fn();
		editor.onAction("app.turn.focus", first);
		editor.onAction("app.edits.expand", second);

		editor.handleInput(CTRL_J);

		expect(first).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledOnce();
	});

	it("gives the key to the action registered first, not the one defined first", () => {
		const editor = newEditor();
		const toggleEditDiffs = vi.fn();
		const focusTurn = vi.fn();
		// app.turn.focus is defined before app.edits.expand; registration order decides.
		editor.onAction("app.edits.expand", toggleEditDiffs);
		editor.onAction("app.turn.focus", focusTurn);

		editor.handleInput(CTRL_J);

		expect(toggleEditDiffs).toHaveBeenCalledOnce();
		expect(focusTurn).not.toHaveBeenCalled();
	});
});
