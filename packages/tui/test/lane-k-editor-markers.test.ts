import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

const BIG_PASTE = "line\n".repeat(20).trimEnd(); // 20 lines -> "[paste #1 +20 lines]"
const MARKER = "[paste #1 +20 lines]"; // 20 chars

function pasteWithMarker(editor: Editor): void {
	editor.handleInput(`\x1b[200~${BIG_PASTE}\x1b[201~`);
}

describe("lane K: vertical move across a wrapped paste marker (R3-M13)", () => {
	// Rendered 14 columns wide, "PPPPP[paste #1 +20 lines]QQQ…" wraps as
	// rows 0..5 / 5..19 / 19..33 / 33..47 / 47..55 and the 20-char marker at
	// cols 5..25 straddles the second and third row. A move down from the
	// marker's first row lands inside its continuation row and must skip to the
	// first row past the marker.
	it("skips the marker's continuation rows without mixing up the coordinate frames", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText(`above\n${"P".repeat(5)}`);
		pasteWithMarker(editor);
		for (let i = 0; i < 30; i++) editor.handleInput("Q");
		editor.render(15); // pin the wrap width so the marker straddles rows

		// Cursor to the marker's first row, col 5 (its start), unsnapped.
		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[A");
		editor.handleInput("\x01"); // Ctrl+A: line start
		for (let i = 0; i < 5; i++) editor.handleInput("\x1b[C");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 5 });

		// Down: the plain landing (col 19) sits inside the marker's continuation row,
		// so the move skips to the first row past the marker and lands at its col 33,
		// keeping the visual column. The old recursion passed the original source row
		// as the current one, reading the already-overwritten cursor column against
		// the wrong row's start column: the cursor landed at that row's end (col 46)
		// with a polluted sticky column.
		editor.handleInput("\x1b[B");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 33 });

		// Back up: the unpolluted column lands inside the continuation row again and
		// snaps to the marker's start so it can be edited as a unit. The polluted
		// sticky column (14) could not fit the continuation row and landed at col 32.
		editor.handleInput("\x1b[A");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 5 });

		// The marker survived both moves intact.
		assert.strictEqual(editor.getText().includes(MARKER), true);
		assert.strictEqual(editor.getExpandedText().includes(BIG_PASTE), true);
	});
});

describe("lane K: character jump never lands inside an atomic marker (R3-M14)", () => {
	it("Ctrl+] onto a char inside a paste marker snaps to its boundary; backspace keeps the paste", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.handleInput("A");
		pasteWithMarker(editor);
		editor.handleInput("B");
		assert.strictEqual(editor.getText(), `A${MARKER}B`);

		// Jump backward to "a": its only occurrence sits inside the marker ("paste").
		// Unsnapped, the cursor lands at column 3 - inside the marker - and the
		// backspace eats one marker char, leaving "[pste #1 +20 lines]", which
		// submit-time expansion no longer recognizes: the pasted text never arrives.
		editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
		editor.handleInput("a");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 1 });

		editor.handleInput("\x7f"); // backspace deletes "A", not a marker char
		assert.strictEqual(editor.getText(), `${MARKER}B`);
		assert.strictEqual(editor.getExpandedText(), `${BIG_PASTE}B`);
	});

	it("Ctrl+] landing never enters a hidden prompt prefix", () => {
		// The bash-mode editor hides the "!! " sentinel from editing; a jump landing
		// inside it lets the next typed char corrupt the sentinel itself.
		class HiddenPrefixEditor extends Editor {
			protected override getHiddenTextPrefixLength(lineIndex: number, line: string): number {
				return lineIndex === 0 && line.startsWith("!! ") ? 3 : 0;
			}
		}
		const editor = new HiddenPrefixEditor(createTestTUI(), defaultEditorTheme);
		editor.setText("!! echo hi");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 10 });

		editor.handleInput("\x1b\x1d"); // Ctrl+Alt+]
		editor.handleInput("!"); // the only "!" chars sit inside the hidden prefix
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 3 });

		editor.handleInput("X");
		assert.strictEqual(editor.getText(), "!! Xecho hi");
	});
});
