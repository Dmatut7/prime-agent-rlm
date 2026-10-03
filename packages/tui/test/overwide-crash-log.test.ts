import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// The differential renderer clamps lines wider than the terminal instead of
// corrupting row tracking, and records the clamp in pi-crash.log. That log must
// be written once per render and throttled across renders: a component stuck on
// an overwide line would otherwise rewrite the whole transcript every frame.

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function crashLogPath(): string {
	return path.join(os.homedir(), ".prime", "agent", "pi-crash.log");
}

function readCrashLog(): string | undefined {
	try {
		return fs.readFileSync(crashLogPath(), "utf8");
	} catch {
		return undefined;
	}
}

describe("overwide line crash log", () => {
	let fakeHome: string;
	let previousHome: string | undefined;

	function setup(lines: string[]): { terminal: VirtualTerminal; tui: TUI; chat: TestComponent } {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TUI(terminal);
		const chat = new TestComponent();
		chat.lines = lines;
		tui.addChild(chat);
		tui.start();
		return { terminal, tui, chat };
	}

	function useFakeHome(t: TestContextLike): void {
		fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "wave40-crashlog-"));
		previousHome = process.env.HOME;
		process.env.HOME = fakeHome;
		t.after(() => {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			fs.rmSync(fakeHome, { recursive: true, force: true });
		});
	}

	it("writes once per render even with several overwide lines", async (t) => {
		useFakeHome(t);
		const { terminal, tui, chat } = setup(["short"]);
		await terminal.waitForRender();
		chat.lines = ["short", "x".repeat(50), "y".repeat(60)];
		tui.requestRender();
		await terminal.waitForRender();
		const log = readCrashLog();
		assert.ok(log !== undefined, "crash log written");
		assert.ok(log.includes("Line 1 visible width: 50"), log);
		assert.ok(log.includes("Line 2 visible width: 60"), log);
		assert.strictEqual(log.match(/Clamped overwide/g)?.length, 1, "one entry per render, not per line");
		tui.stop();
	});

	it("throttles repeat writes and logs again after the throttle window", async (t) => {
		useFakeHome(t);
		const { terminal, tui, chat } = setup(["short"]);
		await terminal.waitForRender();
		t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
		try {
			chat.lines = ["short", "x".repeat(50)];
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(readCrashLog()?.includes("Line 1 visible width: 50"));

			// A new clamp inside the throttle window is still rendered, just not logged.
			chat.lines = ["short", "x".repeat(55)];
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(readCrashLog()?.includes("Line 1 visible width: 50"), "throttled: content unchanged");

			t.mock.timers.tick(1500);
			chat.lines = ["short", "x".repeat(60)];
			tui.requestRender();
			await terminal.waitForRender();
			assert.ok(readCrashLog()?.includes("Line 1 visible width: 60"), "logs again after the window");
		} finally {
			t.mock.timers.reset();
		}
		tui.stop();
	});
});

interface TestContextLike {
	after(fn: () => void): void;
}
