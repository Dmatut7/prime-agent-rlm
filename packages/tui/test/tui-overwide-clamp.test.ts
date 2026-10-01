import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
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
