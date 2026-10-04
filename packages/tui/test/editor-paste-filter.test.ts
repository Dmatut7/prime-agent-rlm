import assert from "node:assert";
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
		const big = "a".repeat(8 * 1024 * 1024);
		const payload = `${PASTE_START}${big}${PASTE_END}`;

		{
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const heapBefore = process.memoryUsage().heapUsed;
			editor.handleInput(payload);
			const allocatedBytes = process.memoryUsage().heapUsed - heapBefore;
			assert.ok(
				allocatedBytes <= 64 * 1024 * 1024,
				`8MB paste transiently allocated ${(allocatedBytes / 1024 / 1024).toFixed(1)}MB (>64MB)`,
			);
		}

		// Process CPU, best of three fresh editors. A wall-clock threshold flakes
		// on an oversubscribed CI runner: the scheduler freezes the test process
		// without the paste path doing anything wrong (measured ~14ms idle vs
		// ~25ms under 4 busy loops on a 10-core host; preemption inflates wall
		// arbitrarily). 250ms of CPU keeps ~10x of load headroom while any
		// per-character regression — the freeze this guards — burns seconds to
		// minutes on 8MB.
		let bestCpuMs = Number.POSITIVE_INFINITY;
		for (let i = 0; i < 3; i++) {
			const editor = new Editor(createTestTUI(), defaultEditorTheme);
			const started = process.cpuUsage();
			editor.handleInput(payload);
			const spent = process.cpuUsage(started);
			bestCpuMs = Math.min(bestCpuMs, (spent.user + spent.system) / 1000);
		}
		assert.ok(bestCpuMs <= 250, `8MB paste froze the editor for ${bestCpuMs.toFixed(1)}ms CPU (>250ms)`);
	});
});
