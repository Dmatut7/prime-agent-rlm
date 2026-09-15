import assert from "node:assert";
import { describe, it } from "node:test";
import { deleteKittyImage, encodeKitty } from "../src/terminal-image.js";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Large-transcript regressions for the render fast path: the differ reuses
// committed normalized lines for an unchanged prefix, the line-reset cache
// evicts instead of clearing, and Kitty image ids are maintained
// incrementally. These scenarios pin screen/output correctness in the
// >20k unique line regime where those paths actually engage.

class StaticLinesComponent implements Component {
	lines: string[];
	constructor(count: number, prefix: string) {
		this.lines = Array.from({ length: count }, (_, i) => `${prefix} unique line ${i} ${i * 2654435761}`);
	}
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class MutableComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

describe("TUI large transcript rendering", () => {
	it("keeps spinner ticks minimal and the viewport intact over 20k unique lines", async () => {
		const terminal = new LoggingTerminal(80, 10);
		const tui = new TUI(terminal);
		const body = new StaticLinesComponent(20050, "body");
		const spinner = new MutableComponent();
		spinner.lines = ["spin 0"];
		tui.addChild(body);
		tui.addChild(spinner);
		tui.start();
		await terminal.waitForRender();

		const writtenPerTick: number[] = [];
		for (let i = 1; i <= 12; i++) {
			terminal.clearWrites();
			spinner.lines = [`spin ${i % 10}`];
			tui.requestRender();
			await terminal.waitForRender();
			writtenPerTick.push(terminal.getWrites().length);
		}

		// A tick must repaint only the changed line, not the transcript.
		for (const bytes of writtenPerTick) {
			assert.ok(bytes < 300, `spinner tick repainted ${bytes} bytes; expected a single-line diff`);
		}
		const viewport = await terminal.flushAndGetViewport();
		assert.equal(viewport[viewport.length - 1], "spin 2");
		assert.equal(viewport[viewport.length - 2], body.lines[20049]);
		tui.stop();
	});

	it("repaints the viewport in place when content changes far above it on a tall transcript", async () => {
		const terminal = new LoggingTerminal(80, 8);
		const tui = new TUI(terminal);
		const body = new StaticLinesComponent(20050, "mid");
		const tail = new MutableComponent();
		tail.lines = ["tail before"];
		tui.addChild(body);
		tui.addChild(tail);
		tui.start();
		await terminal.waitForRender();

		terminal.clearWrites();
		// LineAggregator memoizes per child array identity, so mutations must
		// be delivered through a new array (the realistic component contract).
		body.lines = [...body.lines];
		body.lines[100] = "mid CHANGED LINE 100";
		tail.lines = ["tail after"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = await terminal.flushAndGetViewport();
		assert.equal(viewport[viewport.length - 1], "tail after");
		assert.equal(viewport[0], body.lines[20043]);
		tui.stop();
	});

	it("still expands the changed range over Kitty image lines on a large transcript", async () => {
		const terminal = new LoggingTerminal(60, 10);
		const tui = new TUI(terminal);
		const body = new StaticLinesComponent(20050, "img");
		const images = new MutableComponent();
		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		images.lines = [image];
		tui.addChild(body);
		tui.addChild(images);
		tui.start();
		await terminal.waitForRender();

		// Mutate a line a few rows above the image: the differ must extend the
		// changed range to the image row so the placement is deleted and
		// redrawn after the rows above it changed.
		terminal.clearWrites();
		body.lines = [...body.lines];
		body.lines[20046] = "img CHANGED ROW ABOVE IMAGE";
		tui.requestRender();
		await terminal.waitForRender();
		let writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(42));
		const drawIndex = writes.indexOf(image);
		assert.ok(deleteIndex >= 0, "image must be deleted when a reserved row above it changes");
		assert.ok(drawIndex >= 0, "image line must be redrawn after the row change");
		assert.ok(deleteIndex < drawIndex, "deletion must precede the redraw");

		// Swap in a different id and mutate above it again: incremental id
		// bookkeeping must keep the expansion working for the new id.
		const nextImage = encodeKitty("BBBB", { columns: 2, rows: 2, imageId: 43, moveCursor: false });
		images.lines = [nextImage];
		tui.requestRender();
		await terminal.waitForRender();
		terminal.clearWrites();
		body.lines = [...body.lines];
		body.lines[20046] = "img CHANGED AGAIN";
		tui.requestRender();
		await terminal.waitForRender();
		writes = terminal.getWrites();
		assert.ok(
			writes.indexOf(deleteKittyImage(43)) < writes.indexOf(nextImage),
			"id 43 must be deleted before its redraw",
		);
		tui.stop();
	});
});
