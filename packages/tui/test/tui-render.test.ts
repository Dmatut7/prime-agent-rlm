import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { deleteKittyImage, encodeKitty, encodeKittyPlaceholderRows } from "../src/terminal-image.js";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
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

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell.isItalic();
}

function getCellBg(terminal: VirtualTerminal, row: number, col: number): { mode: number; color: number } {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return { mode: cell.getBgColorMode(), color: cell.getBgColor() };
}

describe("TUI Kitty image cleanup", () => {
	it("deletes changed image ids before drawing moved placements", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const oldImage = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		component.lines = ["top", oldImage];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const newImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
		component.lines = [newImage, ""];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(42));
		const drawIndex = writes.indexOf(newImage);
		assert.ok(deleteIndex >= 0, "changed old image should be deleted");
		assert.ok(drawIndex >= 0, "new image should be drawn");
		assert.ok(deleteIndex < drawIndex, "old image must be deleted before the new placement is drawn");

		tui.stop();
	});

	it("redraws image lines when an earlier reserved image row changes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 88, moveCursor: false });
		component.lines = ["", image];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["covered", image];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(88));
		const drawIndex = writes.indexOf(image);
		assert.ok(deleteIndex >= 0, "image should be deleted when a reserved row changes");
		assert.ok(drawIndex >= 0, "unchanged image line should be redrawn after deleting the placement");
		assert.ok(deleteIndex < drawIndex, "old placement must be deleted before the image line is redrawn");
		assert.ok(!writes.includes("\x1b[2J"), "reserved row changes should not force a full redraw");

		tui.stop();
	});

	it("deletes previously rendered image ids during full redraws", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = [encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 77, moveCursor: false })];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["plain text"];
		tui.requestRender(true);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(77));
		const clearIndex = writes.indexOf("\x1b[2J");
		assert.ok(deleteIndex >= 0, "previous image should be deleted during full redraw");
		assert.ok(clearIndex >= 0, "full redraw should clear the screen");
		assert.ok(deleteIndex < clearIndex, "old image should be deleted before the screen is cleared");

		tui.stop();
	});

	it("deletes placeholder image ids whose rows leave the transcript", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["top", ...encodeKittyPlaceholderRows({ imageId: 42, columns: 2, rows: 2 }), "bottom"];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["plain text"];
		tui.requestRender(true);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(42));
		const clearIndex = writes.indexOf("\x1b[2J");
		assert.ok(deleteIndex >= 0, "departed placeholder image should be deleted during full redraw");
		assert.ok(clearIndex >= 0, "full redraw should clear the screen");
		assert.ok(deleteIndex < clearIndex, "placeholder image should be deleted before the screen is cleared");

		tui.stop();
	});

	it("keeps placeholder images whose rows survive a changed region", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const placeholderRows = encodeKittyPlaceholderRows({ imageId: 42, columns: 2, rows: 2 });
		component.lines = ["top", ...placeholderRows, "bottom"];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		// A line above the image changes; the image rows are unchanged and stay
		// on screen. Placeholder rows carry no transmit of their own, so deleting
		// the id would blank the image with nothing re-uploading it.
		component.lines = ["changed", ...placeholderRows, "bottom"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("changed"), "the edited line should be repainted");
		assert.ok(!writes.includes(deleteKittyImage(42)), "a placeholder image still on screen must not be deleted");

		tui.stop();
	});

	it("deletes a replaced placeholder image id without touching its successor", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["top", ...encodeKittyPlaceholderRows({ imageId: 42, columns: 2, rows: 2 }), "bottom"];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["top", ...encodeKittyPlaceholderRows({ imageId: 43, columns: 2, rows: 2 }), "bottom"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes(deleteKittyImage(42)), "replaced placeholder image should be deleted");
		assert.ok(!writes.includes(deleteKittyImage(43)), "the incoming placeholder image must not be deleted");

		tui.stop();
	});

	it("deletes bottom visible Kitty images when height shrink clamps the previous viewport", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = [
			"Line 0",
			"Line 1",
			encodeKitty("AAAA", { columns: 2, rows: 1, imageId: 303, moveCursor: false }),
		];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(40, 2);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(303));
		const clearIndex = writes.indexOf("\x1b[2J");
		assert.ok(deleteIndex >= 0, "Bottom visible image should be deleted during the height-shrink redraw");
		assert.ok(clearIndex >= 0, "Height shrink should clear the screen");
		assert.ok(deleteIndex < clearIndex, "Visible image should be deleted before the screen is cleared");

		tui.stop();
	});

	it("degrades an inline image whose block straddles the top of a full repaint", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// A 12-row image whose block starts at line 5. The repaint window covers
		// only the last 10 lines (from line 9), so the sequence line's cursor-up
		// would clamp at the top edge and misalign every row after it.
		const kitty = encodeKitty("AAAA", { columns: 4, rows: 12, imageId: 424, moveCursor: false });
		const imageLine = `\x1b[11A${kitty}\x1b[11B`;
		component.lines = [
			"text0",
			"text1",
			"text2",
			"text3",
			"text4",
			...Array<string>(11).fill(""),
			imageLine,
			"after1",
			"after2",
		];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(36, 10);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes(kitty), "a straddling image line must not be re-emitted");
		assert.ok(writes.includes("[image]"), "a placeholder is written instead");
		const viewport = await terminal.flushAndGetViewport();
		assert.strictEqual(viewport[7], "[image]");
		assert.strictEqual(viewport[8], "after1");
		assert.strictEqual(viewport[9], "after2");

		tui.stop();
	});

	it("degrades a straddling image line caught in a differential rewrite range", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// 33 lines, viewport top at 23. The image's sequence line (31) sits inside
		// the window, but its block starts at 22 - one row above it - so a diff
		// that rewrites lines 24..32 would repaint the sequence line at screen row
		// 8 with a cursor-up of 9.
		const kitty = encodeKitty("BBBB", { columns: 4, rows: 10, imageId: 425, moveCursor: false });
		const imageLine = `\x1b[9A${kitty}\x1b[9B`;
		const base = [
			...Array.from({ length: 22 }, (_, i) => `text${i}`),
			...Array<string>(9).fill(""),
			imageLine,
			"tail",
		];
		component.lines = base;
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = base.map((line, i) => (i === 24 ? "x" : i === 32 ? "tailx" : line));
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\x1b[2J"), "no full redraw for a bottom-of-screen change");
		assert.ok(!writes.includes(kitty), "a straddling image line must not be rewritten by the diff");
		assert.ok(writes.includes("[image]"), "a placeholder is written instead");
		const viewport = await terminal.flushAndGetViewport();
		assert.strictEqual(viewport[8], "[image]");
		assert.strictEqual(viewport[9], "tailx");

		tui.stop();
	});
});

describe("TUI resize handling", () => {
	it("triggers full re-render when terminal height changes", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new VirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["Line 0", "Line 1", "Line 2"];
			tui.start();
			await terminal.waitForRender();

			const initialRedraws = tui.fullRedraws;

			terminal.resize(40, 15);
			await terminal.waitForRender();

			assert.ok(tui.fullRedraws > initialRedraws, "Height change should trigger full redraw");

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Line 0"), "Content preserved after height change");

			tui.stop();
		});
	});

	it("skips full re-render on height changes in Termux", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const initialRedraws = tui.fullRedraws;
			for (const height of [15, 8, 14, 11]) {
				terminal.resize(40, height);
				await terminal.waitForRender();
			}

			assert.strictEqual(tui.fullRedraws, initialRedraws, "Height change should not trigger full redraw");
			assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Height change should not clear the screen");
			assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Height change should not clear scrollback");

			const viewport = terminal.getViewport();
			assert.ok(viewport.join("\n").includes("Line 19"), "Latest content remains visible after resize");

			tui.stop();
		});
	});

	it("triggers full re-render when terminal width changes", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		terminal.resize(60, 10);
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Width change should trigger full redraw");

		tui.stop();
	});
});

describe("TUI content shrinkage", () => {
	it("clears empty rows when content shrinks significantly", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Content shrinkage should trigger full redraw");

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "First line preserved");
		assert.ok(viewport[1]?.includes("Line 1"), "Second line preserved");
		assert.strictEqual(viewport[2]?.trim(), "", "Line 2 should be cleared");
		assert.strictEqual(viewport[3]?.trim(), "", "Line 3 should be cleared");

		tui.stop();
	});

	it("handles shrink to single line", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		component.lines = ["Only line"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Only line"), "Single line rendered");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});

	it("handles shrink to empty", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.strictEqual(viewport[0]?.trim(), "", "Line 0 should be cleared");
		assert.strictEqual(viewport[1]?.trim(), "", "Line 1 should be cleared");

		tui.stop();
	});
});

describe("TUI differential rendering", () => {
	it("tracks cursor correctly when content shrinks with unchanged remaining lines", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		component.lines = ["Line 0", "CHANGED", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[1]?.includes("CHANGED"), `Expected "CHANGED" on line 1, got: ${viewport[1]}`);

		tui.stop();
	});

	it("renders correctly when only a middle line changes (spinner case)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Header", "Working...", "Footer"];
		tui.start();
		await terminal.waitForRender();

		const spinnerFrames = ["|", "/", "-", "\\"];
		for (const frame of spinnerFrames) {
			component.lines = ["Header", `Working ${frame}`, "Footer"];
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			assert.ok(viewport[0]?.includes("Header"), `Header preserved: ${viewport[0]}`);
			assert.ok(viewport[1]?.includes(`Working ${frame}`), `Spinner updated: ${viewport[1]}`);
			assert.ok(viewport[2]?.includes("Footer"), `Footer preserved: ${viewport[2]}`);
		}

		tui.stop();
	});

	it("resets styles after each rendered line", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["\x1b[3mItalic", "Plain"];
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(getCellItalic(terminal, 1, 0), 0);
		tui.stop();
	});

	it("expands tabs before writing rendered lines to the terminal", async () => {
		const terminal = new LoggingVirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["\x1b[48;5;236m512:\t\tcode\x1b[49m"];
		tui.start();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(!writes.includes("\t"), "rendered terminal output should not contain raw tabs");
		assert.ok(writes.includes("512:      code"), "tabs should expand to the measured three-column width");
		assert.deepStrictEqual(getCellBg(terminal, 0, 4), getCellBg(terminal, 0, 0));
		assert.deepStrictEqual(getCellBg(terminal, 0, 9), getCellBg(terminal, 0, 0));

		tui.stop();
	});

	it("normalizes changed and restored lines correctly across frames", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["a\tb", "c\td"];
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "a   b");
		assert.strictEqual(terminal.getViewport()[1], "c   d");

		component.lines = ["changed"];
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "changed");

		component.lines = ["a\tb", "c\td"];
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(terminal.getViewport()[0], "a   b", "restored line must normalize again");
		assert.strictEqual(terminal.getViewport()[1], "c   d");

		tui.stop();
	});

	it("renders correctly when first line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("CHANGED"), `First line changed: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("Line 3"), `Line 3 preserved: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when last line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		component.lines = ["Line 0", "Line 1", "Line 2", "CHANGED"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("Line 1"), `Line 1 preserved: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED"), `Last line changed: ${viewport[3]}`);

		tui.stop();
	});

	it("renders correctly when multiple non-adjacent lines change", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), `Line 0 preserved: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("CHANGED 1"), `Line 1 changed: ${viewport[1]}`);
		assert.ok(viewport[2]?.includes("Line 2"), `Line 2 preserved: ${viewport[2]}`);
		assert.ok(viewport[3]?.includes("CHANGED 3"), `Line 3 changed: ${viewport[3]}`);
		assert.ok(viewport[4]?.includes("Line 4"), `Line 4 preserved: ${viewport[4]}`);

		tui.stop();
	});

	it("handles transition from content to empty and back to content", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("Line 0"), "Initial content rendered");

		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		component.lines = ["New Line 0", "New Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.includes("New Line 0"), `New content rendered: ${viewport[0]}`);
		assert.ok(viewport[1]?.includes("New Line 1"), `New content line 1: ${viewport[1]}`);

		tui.stop();
	});

	it("full re-renders when deleted lines move the viewport upward", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should trigger a full redraw");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);

		tui.stop();
	});

	it("appends after a shrink without another full redraw once the viewport is reset", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > initialRedraws, "Shrink should reset the viewport with a full redraw");
		const redrawsAfterShrink = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redrawsAfterShrink, "Append should stay on the differential path");
		assert.deepStrictEqual(terminal.getViewport(), ["Line 0", "Line 1", "Line 2", "", ""]);

		tui.stop();
	});

	it("clears stale content when maxLinesRendered was inflated by a transient component", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const chat = new TestComponent();
		const editor = new TestComponent();
		tui.addChild(chat);
		tui.addChild(editor);

		const longChat = Array.from({ length: 15 }, (_, i) => `Chat ${i}`);
		const shortChat = Array.from({ length: 12 }, (_, i) => `Chat ${i}`);
		const editorLines = ["Editor 0", "Editor 1", "Editor 2"];
		const selectorLines = Array.from({ length: 8 }, (_, i) => `Selector ${i}`);

		chat.lines = longChat;
		editor.lines = editorLines;
		tui.start();
		await terminal.waitForRender();

		editor.lines = selectorLines;
		tui.requestRender();
		await terminal.waitForRender();

		editor.lines = editorLines;
		tui.requestRender();
		await terminal.waitForRender();

		const redrawsBeforeSwitch = tui.fullRedraws;
		chat.lines = shortChat;
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(tui.fullRedraws > redrawsBeforeSwitch, "Branch switch should trigger a full redraw");

		const viewport = terminal.getViewport();
		for (let i = 0; i < 10; i++) {
			const line = viewport[i] ?? "";
			assert.ok(!line.includes("Chat 12"), `Stale "Chat 12" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 13"), `Stale "Chat 13" at viewport row ${i}`);
			assert.ok(!line.includes("Chat 14"), `Stale "Chat 14" at viewport row ${i}`);
		}

		assert.deepStrictEqual(viewport, [
			"Chat 5",
			"Chat 6",
			"Chat 7",
			"Chat 8",
			"Chat 9",
			"Chat 10",
			"Chat 11",
			"Editor 0",
			"Editor 1",
			"Editor 2",
		]);

		tui.stop();
	});
});

describe("TUI viewport-preserving render", () => {
	it("repaints in place without clearing scrollback when content above the viewport grows", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const initialRedraws = tui.fullRedraws;

		const expanded = [...component.lines];
		expanded.splice(3, 0, "Expanded A", "Expanded B", "Expanded C");
		component.lines = expanded;
		tui.requestRenderPreservingViewport();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(tui.fullRedraws > initialRedraws, "Should take the full-redraw branch");
		assert.ok(!writes.includes("\x1b[3J"), "Must not clear scrollback");
		assert.ok(!writes.includes("\x1b[2J"), "Must not clear the screen");

		const viewport = terminal.getViewport();
		assert.ok(viewport[viewport.length - 1]?.includes("Line 29"), "Latest line stays at the bottom");

		const scrollback = terminal.getScrollBuffer();
		assert.ok(
			scrollback.some((l) => l.includes("Line 0")),
			"Original scrollback content is preserved",
		);

		tui.stop();
	});

	it("preserves scrollback when a tall transcript shrinks below the viewport", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["Summary A", "Summary B", "Summary C"];
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(terminal.getWrites().includes("\x1b[2J"), "Shrinking below the viewport clears the screen");
		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Shrinking below the viewport must not clear scrollback");

		tui.stop();
	});

	it("only deletes Kitty images within the repainted viewport", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const aboveImage = encodeKitty("AAAA", { columns: 2, rows: 1, imageId: 101, moveCursor: false });
		const visibleImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 202, moveCursor: false });
		const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		lines[2] = aboveImage; // scrollback (above the 10-row viewport)
		lines[25] = visibleImage; // within the visible slice
		component.lines = lines;
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const expanded = [...component.lines];
		expanded.splice(6, 0, "Expanded A", "Expanded B", "Expanded C");
		component.lines = expanded;
		tui.requestRenderPreservingViewport();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes(deleteKittyImage(202)), "Visible-slice image is deleted before being redrawn");
		assert.ok(!writes.includes(deleteKittyImage(101)), "Image in scrollback above the viewport must not be deleted");

		tui.stop();
	});

	it("only deletes visible Kitty images during screen-clearing redraws", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const aboveImage = encodeKitty("AAAA", { columns: 2, rows: 1, imageId: 101, moveCursor: false });
		const visibleImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 202, moveCursor: false });
		const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		lines[2] = aboveImage;
		lines[25] = visibleImage;
		component.lines = lines;
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(60, 10);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("\x1b[2J"), "Width change should clear the screen before repainting");
		assert.ok(writes.includes(deleteKittyImage(202)), "Visible image is deleted before the screen repaint");
		assert.ok(!writes.includes(deleteKittyImage(101)), "Image in scrollback above the viewport must not be deleted");

		tui.stop();
	});

	it("repaints only the visible window during screen-clearing redraws", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		terminal.resize(60, 10);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("\x1b[2J"), "Width change should clear the screen before repainting");
		assert.ok(!writes.includes("Line 0"), "Screen-clearing redraw must not replay scrollback lines");
		assert.ok(!writes.includes("Line 19"), "Screen-clearing redraw must not replay lines above the viewport");
		assert.ok(writes.includes("Line 20"), "Screen-clearing redraw should repaint the top visible line");
		assert.ok(writes.includes("Line 29"), "Screen-clearing redraw should repaint the bottom visible line");

		tui.stop();
	});

	it("does not leave maxLinesRendered inflated after a preserving collapse", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		tui.setClearOnShrink(true);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		tui.requestRenderPreservingViewport();
		await terminal.waitForRender();

		const redrawsAfterCollapse = tui.fullRedraws;
		terminal.clearWrites();

		tui.requestRender();
		await terminal.waitForRender();

		assert.strictEqual(tui.fullRedraws, redrawsAfterCollapse, "No extra full redraw after the collapse settled");
		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Must not clear scrollback on the follow-up render");

		tui.stop();
	});
});

describe("TUI above-viewport changes on a tall transcript", () => {
	it("repaints in place instead of clearing scrollback when off-screen content changes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().join("\n").includes("Line 29"), "Latest line visible after initial paint");
		terminal.clearWrites();

		for (const i of [3, 7, 12]) {
			component.lines[i] = `Line ${i} (updated)`;
			tui.requestRender();
			await terminal.waitForRender();
		}

		assert.ok(!terminal.getWrites().includes("\x1b[2J"), "Off-screen changes must not clear the screen");
		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "Off-screen changes must not clear scrollback");

		const viewport = terminal.getViewport().join("\n");
		assert.ok(viewport.includes("Line 29"), "Viewport stays anchored at the latest content");
		assert.ok(viewport.includes("Line 20"), "Bottom window remains visible");
		assert.ok(!viewport.includes("Line 0 "), "Did not scroll back to the top");

		tui.stop();
	});

	it("preserves scrollback when a still-tall transcript shrinks (rebuild/compaction)", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 30 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = Array.from({ length: 15 }, (_, i) => `Rebuilt ${i}`);
		tui.requestRender();
		await terminal.waitForRender();

		assert.ok(terminal.getWrites().includes("\x1b[2J"), "A still-tall shrink clears the screen");
		assert.ok(!terminal.getWrites().includes("\x1b[3J"), "A still-tall shrink must not clear scrollback");

		tui.stop();
	});
});

describe("TUI synchronous flush", () => {
	it("paints a pending change without waiting for the scheduled render", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Before"];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		// The session-switch handoff shape: content changes and the renderer is about to
		// stop, so the deferred render would never run. Nothing is awaited between the
		// change and the assertion - the flush has to have written the frame already.
		component.lines = ["Opening worker…"];
		tui.requestRender();
		tui.flushRender();

		assert.ok(
			terminal.getWrites().includes("Opening worker…"),
			`Expected the flushed frame in the terminal writes, got: ${JSON.stringify(terminal.getWrites())}`,
		);

		await terminal.waitForRender();
		assert.ok(
			terminal.getViewport().some((line) => line.includes("Opening worker…")),
			`Expected the flushed frame on screen, got: ${terminal.getViewport().join(" | ")}`,
		);

		tui.stop();
	});

	it("leaves no scheduled render behind", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["First"];
		tui.start();
		await terminal.waitForRender();

		component.lines = ["Second"];
		tui.requestRender();
		tui.flushRender();
		assert.ok(terminal.getWrites().includes("Second"), "The flush painted the change");

		// A render left scheduled would fire ~16ms later and paint whatever the component
		// holds by then, so this change must never reach the screen on its own.
		component.lines = ["Third"];
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.ok(
			!terminal.getViewport().some((line) => line.includes("Third")),
			`A cancelled render painted anyway: ${terminal.getViewport().join(" | ")}`,
		);

		tui.stop();
	});

	it("is a no-op after stop", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Before"];
		tui.start();
		await terminal.waitForRender();
		tui.stop();
		terminal.clearWrites();

		component.lines = ["After stop"];
		tui.flushRender();

		assert.strictEqual(terminal.getWrites(), "", "A stopped renderer paints nothing");
	});
});

describe("TUI synchronized output (mode 2026)", () => {
	it("wraps frames in 2026 markers while the verdict is still pending (status-quo blind send)", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["hello"];
		tui.addChild(component);

		tui.start();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("\x1b[?2026h"), `expected a begin marker in: ${JSON.stringify(writes)}`);
		assert.ok(writes.includes("\x1b[?2026l"), `expected an end marker in: ${JSON.stringify(writes)}`);
		tui.stop();
	});

	it("keeps wrapping when the terminal answers 2026 unsupported (design blind-send fallback)", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["hello"];
		tui.addChild(component);

		tui.start();
		terminal.sendInput("\x1b[?2026;0$y");
		assert.strictEqual(terminal.probeBus?.query("sync2026").verdict, "unsupported");
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["hello", "world"];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		assert.ok(writes.includes("\x1b[?2026h"), `probe-refused 2026 must still wrap: ${JSON.stringify(writes)}`);
		tui.stop();
	});

	it("emits no 2026 markers at all under PI_TERMINAL_SYNC_2026=0", async () => {
		await withEnv({ PI_TERMINAL_SYNC_2026: "0" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			component.lines = ["hello"];
			tui.addChild(component);

			tui.start();
			await terminal.waitForRender();

			component.lines = ["hello", "world"];
			tui.requestRender();
			await terminal.waitForRender();

			assert.ok(
				!terminal.getWrites().includes("?2026"),
				`env kill switch must strip all 2026 markers: ${JSON.stringify(terminal.getWrites())}`,
			);
			tui.stop();
		});
	});
});
