import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Editor } from "../src/components/editor.js";
import { StdinBuffer } from "../src/stdin-buffer.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const START = "\x1b[200~";
const END = "\x1b[201~";
const move = (x: number, y: number) => `\x1b[<35;${x};${y}M`;
const legacyMove = "\x1b[MC#!";

describe("mouse reports next to a bracketed paste", () => {
	let buffer: StdinBuffer;
	let events: string[];

	beforeEach(() => {
		mock.timers.enable({ apis: ["setTimeout"] });
		buffer = new StdinBuffer({ timeout: 10 });
		events = [];
		buffer.on("data", (sequence) => events.push(`data:${JSON.stringify(sequence)}`));
		buffer.on("paste", (content) => events.push(`paste:${JSON.stringify(content)}`));
	});

	afterEach(() => {
		buffer.destroy();
		mock.timers.reset();
	});

	it("hands a hover move that arrives right after the end marker to the mouse, not the paste", () => {
		buffer.process(`${START}hello world${END}`);
		mock.timers.tick(6);
		buffer.process(move(10, 5));
		mock.timers.tick(8);
		buffer.process(move(11, 5));
		mock.timers.tick(10);
		assert.deepStrictEqual(events, [
			`data:${JSON.stringify(move(10, 5))}`,
			`data:${JSON.stringify(move(11, 5))}`,
			`paste:${JSON.stringify("hello world")}`,
		]);
	});

	it("does not let a moving mouse hold the paste open", () => {
		buffer.process(`${START}hello${END}`);
		for (let i = 0; i < 10; i++) {
			mock.timers.tick(8);
			buffer.process(move(10 + i, 5));
		}
		const pasteAt = events.indexOf(`paste:${JSON.stringify("hello")}`);
		assert.ok(pasteAt !== -1, "the paste closed although the mouse never stopped");
		assert.ok(pasteAt < events.length - 1, "moves kept arriving after it closed");
		assert.ok(
			events.every((event, index) => index === pasteAt || event.startsWith("data:")),
			"everything else is mouse data",
		);
		assert.strictEqual(events.filter((event) => event.startsWith("data:")).length, 10);
	});

	it("splits reports that share a chunk with the end marker", () => {
		buffer.process(`${START}hello${END}${move(3, 3)}${move(4, 3)}`);
		assert.deepStrictEqual(events, [`data:${JSON.stringify(move(3, 3))}`, `data:${JSON.stringify(move(4, 3))}`]);
		mock.timers.tick(25);
		assert.deepStrictEqual(events.slice(2), [`paste:${JSON.stringify("hello")}`]);
	});

	it("finds the reports when the end marker itself arrives split", () => {
		buffer.process(`${START}hi\x1b[201`);
		buffer.process(`~${move(1, 1)}`);
		assert.deepStrictEqual(events, [`data:${JSON.stringify(move(1, 1))}`]);
		mock.timers.tick(25);
		assert.deepStrictEqual(events.slice(1), [`paste:${JSON.stringify("hi")}`]);
	});

	it("reassembles a report split across chunks after the end marker", () => {
		buffer.process(`${START}hi${END}\x1b[<35;1`);
		mock.timers.tick(3);
		assert.deepStrictEqual(events, []);
		buffer.process("0;5M");
		assert.deepStrictEqual(events, [`data:${JSON.stringify(move(10, 5))}`]);
		mock.timers.tick(25);
		assert.deepStrictEqual(events.slice(1), [`paste:${JSON.stringify("hi")}`]);
	});

	it("splits out legacy ESC [ M reports as well", () => {
		buffer.process(`${START}hi${END}${legacyMove}`);
		assert.deepStrictEqual(events, [`data:${JSON.stringify(legacyMove)}`]);
		mock.timers.tick(25);
		assert.deepStrictEqual(events.slice(1), [`paste:${JSON.stringify("hi")}`]);
	});

	it("keeps clicks and wheel reports out of the paste too", () => {
		const others = ["\x1b[<0;3;3M", "\x1b[<0;3;3m", "\x1b[<64;3;3M", "\x1b[<32;4;3M"];
		buffer.process(`${START}hi${END}${others.join("")}`);
		assert.deepStrictEqual(
			events,
			others.map((report) => `data:${JSON.stringify(report)}`),
		);
		mock.timers.tick(25);
		assert.strictEqual(events.at(-1), `paste:${JSON.stringify("hi")}`);
	});

	it("drops a report that never completes instead of pasting it", () => {
		buffer.process(`${START}hi${END}\x1b[<35;1`);
		mock.timers.tick(30);
		assert.deepStrictEqual(events, [`paste:${JSON.stringify("hi")}`]);
	});

	it("still treats other bytes after the end marker as paste text, mouse reports between them aside", () => {
		buffer.process(`${START}ab${END}cd${move(1, 1)}ef`);
		mock.timers.tick(25);
		assert.deepStrictEqual(events, [`data:${JSON.stringify(move(1, 1))}`, `paste:${JSON.stringify("abcdef")}`]);
	});

	it("leaves a mouse-looking sequence inside the paste, before the end marker, as paste text", () => {
		buffer.process(`${START}a${move(1, 1)}b${END}`);
		mock.timers.tick(25);
		assert.deepStrictEqual(events, [`paste:${JSON.stringify(`a${move(1, 1)}b`)}`]);
	});

	it("treats a move that arrives after the paste settled as ordinary mouse input", () => {
		buffer.process(`${START}hello${END}`);
		mock.timers.tick(30);
		buffer.process(move(10, 5));
		assert.deepStrictEqual(events, [`paste:${JSON.stringify("hello")}`, `data:${JSON.stringify(move(10, 5))}`]);
	});
});

describe("a paste followed by mouse movement, through the whole input chain", () => {
	it("puts exactly the pasted text into the editor", async () => {
		const terminal = new VirtualTerminal(60, 12);
		const tui = new TUI(terminal);
		const editor = new Editor(tui, defaultEditorTheme);
		tui.start();
		tui.enterFullscreen({ scroll: [], dock: editor });
		tui.setFocus(editor);
		await terminal.waitForRender();

		const buffer = new StdinBuffer({ timeout: 10 });
		buffer.on("data", (sequence) => terminal.sendInput(sequence));
		buffer.on("paste", (content) => terminal.sendInput(`${START}${content}${END}`));
		const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		try {
			buffer.process(`${START}hello world${END}`);
			await wait(6);
			buffer.process(move(10, 5));
			await wait(8);
			buffer.process(move(11, 5));
			await wait(80);
			await terminal.waitForRender();
			assert.strictEqual(editor.getText(), "hello world");
		} finally {
			tui.stop();
			buffer.destroy();
		}
	});
});
