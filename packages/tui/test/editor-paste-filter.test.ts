import assert from "node:assert";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

describe("Editor paste filtering (r33 FR-3)", () => {
	it("drops control bytes but keeps newlines from a small paste", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.handleInput(`${PASTE_START}beep\u0007boop\u0000line${PASTE_END}`);
		assert.strictEqual(editor.getText(), "beepboopline");
	});

	it("keeps newlines so a multi-line paste stays multi-line", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.handleInput(`${PASTE_START}one\ntwo\u0008\nthree${PASTE_END}`);
		assert.deepStrictEqual(editor.getText(), "one\ntwo\nthree");
	});

	it("lets the host rewrite a paste, inserted as one undo unit", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const seen: string[] = [];
		editor.transformPaste = (text) => {
			seen.push(text);
			return `${text} [image #1]`;
		};
		editor.handleInput(`${PASTE_START}/tmp/shot\u0007.png${PASTE_END}`);
		assert.deepStrictEqual(seen, ["/tmp/shot.png"]);
		assert.strictEqual(editor.getText(), "/tmp/shot.png [image #1]");
		editor.handleInput("\x1f");
		assert.strictEqual(editor.getText(), "");
	});

	it("does not freeze the editor on an 8MB paste", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const big = "a".repeat(8 * 1024 * 1024);
		const heapBefore = process.memoryUsage().heapUsed;
		const start = performance.now();
		editor.handleInput(`${PASTE_START}${big}${PASTE_END}`);
		const elapsedMs = performance.now() - start;
		const allocatedBytes = process.memoryUsage().heapUsed - heapBefore;
		assert.ok(elapsedMs <= 100, `8MB paste froze the editor for ${elapsedMs.toFixed(1)}ms (>100ms)`);
		assert.ok(
			allocatedBytes <= 64 * 1024 * 1024,
			`8MB paste transiently allocated ${(allocatedBytes / 1024 / 1024).toFixed(1)}MB (>64MB)`,
		);
	});
});
