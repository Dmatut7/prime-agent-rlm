import assert from "node:assert";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { ClickRegion } from "../src/click-regions.js";
import { Editor } from "../src/components/editor.js";
import { StdinBuffer } from "../src/stdin-buffer.js";
import { type Component, TUI } from "../src/tui.js";
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

	const data = (report: string) => `data:${JSON.stringify(report)}`;
	const paste = (content: string) => `paste:${JSON.stringify(content)}`;

	it("hands a hover move that arrives right after the end marker to the mouse, not the paste", () => {
		buffer.process(`${START}hello world${END}`);
		mock.timers.tick(6);
		buffer.process(move(10, 5));
		mock.timers.tick(8);
		buffer.process(move(11, 5));
		assert.deepStrictEqual(events, [], "nothing is decided before the paste closes");
		mock.timers.tick(10);
		assert.deepStrictEqual(events, [paste("hello world"), data(move(10, 5)), data(move(11, 5))]);
	});

	it("does not let a moving mouse hold the paste open", () => {
		buffer.process(`${START}hello${END}`);
		for (let i = 0; i < 10; i++) {
			mock.timers.tick(8);
			buffer.process(move(10 + i, 5));
		}
		const pasteAt = events.indexOf(paste("hello"));
		assert.strictEqual(pasteAt, 0, "the paste closed on time although the mouse never stopped");
		assert.strictEqual(events.length, 11);
		assert.ok(
			events.slice(1).every((event) => event.startsWith("data:")),
			"everything else is mouse data",
		);
		assert.deepStrictEqual(events.slice(1, 3), [data(move(10, 5)), data(move(11, 5))]);
	});

	it("splits reports that share a chunk with the end marker", () => {
		buffer.process(`${START}hello${END}${move(3, 3)}${move(4, 3)}`);
		assert.deepStrictEqual(events, []);
		mock.timers.tick(25);
		assert.deepStrictEqual(events, [paste("hello"), data(move(3, 3)), data(move(4, 3))]);
	});

	it("finds the reports when the end marker itself arrives split", () => {
		buffer.process(`${START}hi\x1b[201`);
		buffer.process(`~${move(1, 1)}`);
		mock.timers.tick(25);
		assert.deepStrictEqual(events, [paste("hi"), data(move(1, 1))]);
	});

	it("reassembles a report split across chunks after the end marker", () => {
		buffer.process(`${START}hi${END}\x1b[<35;1`);
		mock.timers.tick(3);
		buffer.process("0;5M");
		mock.timers.tick(25);
		assert.deepStrictEqual(events, [paste("hi"), data(move(10, 5))]);
	});

	it("reassembles a report split at any byte, ESC and ESC [ included", () => {
		const input = `${START}hi${END}${move(10, 5)}`;
		for (let split = 1; split < input.length; split++) {
			buffer.clear();
			events.length = 0;
			buffer.process(input.slice(0, split));
			buffer.process(input.slice(split));
			mock.timers.tick(25);
			assert.deepStrictEqual(events, [paste("hi"), data(move(10, 5))], `split at ${split}`);
		}
	});

	it("splits out legacy ESC [ M reports as well", () => {
		buffer.process(`${START}hi${END}${legacyMove}`);
		mock.timers.tick(25);
		assert.deepStrictEqual(events, [paste("hi"), data(legacyMove)]);
	});

	it("keeps clicks and wheel reports out of the paste too", () => {
		const others = ["\x1b[<0;3;3M", "\x1b[<0;3;3m", "\x1b[<64;3;3M", "\x1b[<32;4;3M"];
		buffer.process(`${START}hi${END}${others.join("")}`);
		mock.timers.tick(25);
		assert.deepStrictEqual(events, [paste("hi"), ...others.map(data)]);
	});

	it("drops a report that never completes instead of pasting it", () => {
		buffer.process(`${START}hi${END}\x1b[<35;1`);
		mock.timers.tick(30);
		assert.deepStrictEqual(events, [paste("hi")]);
	});

	it("still treats other bytes after the end marker as paste text, mouse reports between them aside", () => {
		buffer.process(`${START}ab${END}cd${move(1, 1)}ef`);
		mock.timers.tick(25);
		assert.deepStrictEqual(events, [paste("abcdef"), data(move(1, 1))]);
	});

	it("leaves a mouse-looking sequence inside the paste, before the end marker, as paste text", () => {
		buffer.process(`${START}a${move(1, 1)}b${END}`);
		mock.timers.tick(25);
		assert.deepStrictEqual(events, [paste(`a${move(1, 1)}b`)]);
	});

	it("does not restart the quiet timer for chunks that are only mouse reports or the start of one", () => {
		buffer.process(`${START}hi${END}`);
		mock.timers.tick(8);
		buffer.process("\x1b");
		mock.timers.tick(8);
		buffer.process(`[<35;1;1M${move(2, 2)}\x1b[<3`);
		mock.timers.tick(5);
		assert.deepStrictEqual(events, [paste("hi"), data(move(1, 1)), data(move(2, 2))]);
	});

	describe("a clipboard that imitates an end marker and a mouse click", () => {
		const down = "\x1b[<0;3;2M";
		const up = "\x1b[<0;3;2m";

		it("keeps the forged click as paste text when the real end marker arrives in a later chunk", () => {
			buffer.process(`${START}innocent${END}${down}${up} more`);
			mock.timers.tick(2);
			buffer.process(`tail${END}`);
			mock.timers.tick(25);
			assert.deepStrictEqual(events, [paste(`innocent${END}${down}${up} moretail`)]);
		});

		it("keeps the forged click as paste text when the real end marker is in the same chunk", () => {
			buffer.process(`${START}innocent${END}${down}${up} more${END}`);
			mock.timers.tick(25);
			assert.deepStrictEqual(events, [paste(`innocent${END}${down}${up} more`)]);
		});

		it("keeps forged legacy reports as paste text too", () => {
			buffer.process(`${START}a${END}x\x1b[Mabcy`);
			mock.timers.tick(2);
			buffer.process(`z${END}`);
			mock.timers.tick(25);
			assert.deepStrictEqual(events, [paste(`a${END}x\x1b[Mabcyz`)]);
		});

		it("still lets the pointer through when it really follows the last end marker", () => {
			buffer.process(`${START}innocent${END}${down}${up} more${END}`);
			mock.timers.tick(2);
			buffer.process(move(5, 5));
			mock.timers.tick(25);
			assert.deepStrictEqual(events, [paste(`innocent${END}${down}${up} more`), data(move(5, 5))]);
		});
	});

	it("treats a move that arrives after the paste settled as ordinary mouse input", () => {
		buffer.process(`${START}hello${END}`);
		mock.timers.tick(30);
		buffer.process(move(10, 5));
		assert.deepStrictEqual(events, [`paste:${JSON.stringify("hello")}`, `data:${JSON.stringify(move(10, 5))}`]);
	});
});

describe("a paste followed by mouse movement, through the whole input chain", () => {
	const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

	it("does not turn a click forged inside a pasted text into a click on the interface", async () => {
		class Target implements Component {
			clicks = 0;
			render(): string[] {
				return ["row 0", "click me", "row 2"];
			}
			getClickRegions(): ReadonlyArray<ClickRegion> {
				return [{ line: 1, col: 0, width: 8, height: 1, onClick: () => this.clicks++ }];
			}
			invalidate(): void {}
		}
		const terminal = new VirtualTerminal(40, 4);
		const tui = new TUI(terminal);
		const target = new Target();
		const dock: Component = { render: () => ["> "], invalidate: () => {}, handleInput: () => {} };
		tui.start();
		tui.enterFullscreen({ scroll: [target], dock });
		tui.setFocus(dock);
		await terminal.waitForRender();
		const row = (await terminal.flushAndGetViewport()).findIndex((line) => line.startsWith("click me")) + 1;
		assert.ok(row > 0);

		const buffer = new StdinBuffer({ timeout: 10 });
		const pasted: string[] = [];
		buffer.on("data", (sequence) => terminal.sendInput(sequence));
		buffer.on("paste", (content) => {
			pasted.push(content);
			terminal.sendInput(`${START}${content}${END}`);
		});
		const forged = `\x1b[<0;3;${row}M\x1b[<0;3;${row}m`;
		try {
			buffer.process(`${START}innocent${END}${forged} more`);
			await wait(2);
			buffer.process(`tail${END}`);
			await wait(60);
			await terminal.waitForRender();
			assert.strictEqual(target.clicks, 0, "the pasted bytes never clicked anything");
			assert.deepStrictEqual(pasted, [`innocent${END}${forged} moretail`], "and every byte stayed paste text");
		} finally {
			tui.stop();
			buffer.destroy();
		}
	});
});
