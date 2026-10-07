import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { clampOverwideLine } from "../src/utils.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

describe("overwide line handling in inline mode", () => {
	it("clamps an overwide line, keeps rendering, and still writes the crash log", async () => {
		// The crash log lives under ~/.prime/agent - point HOME at a temp dir.
		const home = mkdtempSync(join(tmpdir(), "pi-tui-overwide-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const terminal = new VirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["first", "second"];
			tui.start();
			await terminal.waitForRender();

			// A differential render meeting a line wider than the terminal used to
			// stop the TUI and throw (taking the daemon down with it); now it clamps
			// the line like the fullscreen renderer (fullscreen.ts paint) does.
			component.lines = ["first", `${"x".repeat(41)}世界`, "third"];
			tui.requestRender();
			await terminal.waitForRender();

			const crashLog = join(home, ".prime", "agent", "pi-crash.log");
			assert.ok(existsSync(crashLog), "the crash log should still be written");
			const crashData = readFileSync(crashLog, "utf8");
			assert.ok(crashData.includes("Clamped overwide line"), crashData.slice(0, 200));
			assert.ok(crashData.includes("Terminal width: 40"), crashData.slice(0, 200));

			const clampedViewport = await terminal.flushAndGetViewport();
			assert.ok(
				clampedViewport.some((line) => line === "x".repeat(40)),
				`expected a 40-column clamped row, got ${JSON.stringify(clampedViewport)}`,
			);

			// The TUI survives: a later render still lands.
			component.lines = ["first", "after clamp"];
			tui.requestRender();
			await terminal.waitForRender();
			const viewport = await terminal.flushAndGetViewport();
			assert.ok(
				viewport.some((line) => line.includes("after clamp")),
				`rendering must continue after a clamp, got ${JSON.stringify(viewport)}`,
			);

			tui.stop();
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("overwide line handling in full render paths", () => {
	it("clamps an overwide line on the first frame (full render) and logs it", async () => {
		const home = mkdtempSync(join(tmpdir(), "pi-tui-overwide-full-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const terminal = new VirtualTerminal(40, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			component.lines = ["first", `${"x".repeat(50)}世界`, "third"];
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();

			// The first frame goes through the full render loop, which historically
			// wrote overwide lines verbatim (they wrapped and desynchronized every
			// later diff). It must clamp exactly like the diff path does.
			const viewport = await terminal.flushAndGetViewport();
			assert.ok(
				viewport.some((line) => line === "x".repeat(40)),
				`expected a 40-column clamped row on the first frame, got ${JSON.stringify(viewport)}`,
			);

			const crashLog = join(home, ".prime", "agent", "pi-crash.log");
			assert.ok(existsSync(crashLog), "the full-render clamp should also write the crash log");
			const crashData = readFileSync(crashLog, "utf8");
			assert.ok(crashData.includes("Clamped overwide line"), crashData.slice(0, 200));

			tui.stop();
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("clamps an overwide line after a resize (width-change full render)", async () => {
		// The crash log lives under ~/.prime/agent - point HOME at a temp dir or
		// this test overwrites the developer's real log with its fixture.
		const home = mkdtempSync(join(tmpdir(), "pi-tui-overwide-resize-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const terminal = new VirtualTerminal(60, 10);
			const tui = new TUI(terminal);
			const component = new TestComponent();
			component.lines = ["first", `${"x".repeat(50)}`, "third"];
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();
			await terminal.flushAndGetViewport();

			// Shrink the terminal so the previously-fitting line is now overwide and
			// the width change forces the full render path.
			terminal.resize(40, 10);
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = await terminal.flushAndGetViewport();
			assert.ok(
				viewport.some((line) => line === "x".repeat(40)),
				`expected a 40-column clamped row after resize, got ${JSON.stringify(viewport)}`,
			);

			tui.stop();
		} finally {
			if (previousHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = previousHome;
			}
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("clampOverwideLine", () => {
	it("returns a fitting line unchanged", () => {
		const line = "\x1b[41mplain\x1b[0m";
		assert.equal(clampOverwideLine(line, 80), line);
	});

	it("re-attaches the trailing reset a plain slice drops", () => {
		const line = `\x1b[41m${"x".repeat(30)}\x1b[0m`;
		const clamped = clampOverwideLine(line, 10);
		// The background must not leak into the row below: the clamp re-closes SGR
		// and any OSC8 link the slice cut off.
		assert.ok(clamped.endsWith("\x1b[0m\x1b]8;;\x07"), JSON.stringify(clamped));
		assert.ok(clamped.startsWith("\x1b[41m"), JSON.stringify(clamped));
	});

	it("closes an OSC8 link the slice cut open", () => {
		const line = `\x1b]8;;https://example.com\x07${"y".repeat(30)}\x1b]8;;\x07`;
		const clamped = clampOverwideLine(line, 10);
		// An opener carries a URL after "8;;"; the terminator is bare. Every opener
		// left by the slice must be closed by the re-attached reset.
		const opens = (clamped.match(/\x1b\]8;;(?!\x07)/g) ?? []).length;
		const closes = (clamped.match(/\x1b\]8;;\x07/g) ?? []).length;
		assert.ok(closes >= opens, `open links must be closed, got ${JSON.stringify(clamped)}`);
	});
});
