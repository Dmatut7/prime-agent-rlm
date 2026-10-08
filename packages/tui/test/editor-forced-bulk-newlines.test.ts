import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { StdinBuffer } from "../src/stdin-buffer.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Short forced-bulk sequences (StdinBuffer emits them when a bulk run is cut
// by a control byte or shrunk below 32 chars by CR folding) must be inserted
// with their line breaks split into real editor lines, never as literal \n
// characters inside one line.
function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

describe("Editor forced-bulk short runs with newlines", () => {
	it("a short forced-bulk sequence splits its newlines into lines", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.handleInput("a\n".repeat(11));
		assert.deepStrictEqual(
			editor.getLines(),
			["a", "a", "a", "a", "a", "a", "a", "a", "a", "a", "a", ""],
			"11 line breaks must become 12 lines, not one line embedding \\n",
		);
		assert.strictEqual(editor.getText(), "a\n".repeat(11));
	});

	it("a control-byte-cut text segment keeps its trailing newline as a line break", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		// The shape StdinBuffer emits for "def f():\n\treturn 1": the \t cuts the
		// run, so "def f():\n" (9 chars) arrives as one forced-bulk sequence.
		editor.handleInput("def f():\n");
		assert.deepStrictEqual(editor.getLines(), ["def f():", ""]);
	});

	it("a single newline key still goes through the newline path, not bulk", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.handleInput("a");
		editor.handleInput("\n");
		editor.handleInput("b");
		assert.deepStrictEqual(editor.getLines(), ["a", "b"]);
	});

	it("the full stdin chain maps a CRLF-folded short run onto real lines", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const stdin = new StdinBuffer({ timeout: 10 });
		stdin.on("data", (sequence) => editor.handleInput(sequence));
		stdin.process("a\r\n".repeat(11));
		// The folded text round-trips, and no line embeds a literal newline.
		assert.strictEqual(editor.getText(), "a\n".repeat(11));
		for (const line of editor.getLines()) {
			assert.ok(!line.includes("\n"), `line embeds a literal newline: ${JSON.stringify(line)}`);
		}
	});
});
