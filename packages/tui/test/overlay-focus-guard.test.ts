import assert from "node:assert";
import { describe, it } from "node:test";
import type { Component, Focusable } from "../src/tui.js";
import { TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class EmptyContent implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

class RecordingComponent implements Component, Focusable {
	focused = false;
	inputs: string[] = [];

	constructor(private lines: string[]) {}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("TUI modal overlay focus guard", () => {
	it("re-asserts a capturing overlay when focus was stolen back to the editor", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new RecordingComponent(["EDITOR"]);
		const overlay = new RecordingComponent(["OVERLAY"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.start();
		try {
			// A capturing overlay takes focus when it opens...
			tui.showOverlay(overlay);
			await renderAndFlush(tui, terminal);
			assert.strictEqual(overlay.focused, true);

			// ...and a streaming repaint (or any event-driven refresh) steals it back.
			tui.setFocus(editor);
			assert.strictEqual(editor.focused, true);

			// The next key must still reach the modal overlay, not the editor:
			// this is the "model menu looks dead" regression (Enter went to the
			// prompt while the menu was open).
			terminal.sendInput("\r");
			await renderAndFlush(tui, terminal);
			assert.deepStrictEqual(overlay.inputs, ["\r"]);
			assert.deepStrictEqual(editor.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("keeps mouse clicks on the overlay's click regions after focus theft", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new RecordingComponent(["EDITOR"]);
		const overlay = new RecordingComponent(["OVERLAY"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.start();
		try {
			tui.showOverlay(overlay);
			await renderAndFlush(tui, terminal);
			tui.setFocus(editor);
			// A left-press mouse report while a capturing overlay is visible must be
			// routed through the overlay branch (frame selection / click regions),
			// which requires the overlay to hold focus at dispatch time.
			terminal.sendInput("\x1b[<0;10;5M");
			await renderAndFlush(tui, terminal);
			assert.strictEqual(overlay.focused, true);
		} finally {
			tui.stop();
		}
	});

	it("leaves non-capturing overlays out of the guard", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new RecordingComponent(["EDITOR"]);
		const autocomplete = new RecordingComponent(["AUTOCOMPLETE"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.start();
		try {
			tui.showOverlay(autocomplete, { nonCapturing: true });
			await renderAndFlush(tui, terminal);
			assert.strictEqual(editor.focused, true);
			terminal.sendInput("x");
			await renderAndFlush(tui, terminal);
			assert.deepStrictEqual(editor.inputs, ["x"]);
			assert.deepStrictEqual(autocomplete.inputs, []);
		} finally {
			tui.stop();
		}
	});

	it("does not touch focus when no overlay is visible", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new RecordingComponent(["EDITOR"]);
		tui.addChild(new EmptyContent());
		tui.setFocus(editor);
		tui.start();
		try {
			terminal.sendInput("a");
			await renderAndFlush(tui, terminal);
			assert.deepStrictEqual(editor.inputs, ["a"]);
			assert.strictEqual(editor.focused, true);
		} finally {
			tui.stop();
		}
	});
});
