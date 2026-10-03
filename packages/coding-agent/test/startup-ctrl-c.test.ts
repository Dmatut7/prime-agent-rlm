import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installStartupCtrlCExit } from "../src/main.js";

class FakeStdin extends EventEmitter {
	isTTY = true;
	pauseCalls = 0;
	unshifted: Buffer[] = [];

	pause(): this {
		this.pauseCalls++;
		return this;
	}

	unshift(chunk: Buffer): number {
		this.unshifted.push(chunk);
		return 0;
	}
}

describe("installStartupCtrlCExit", () => {
	it("exits with 130 when Ctrl+C arrives before the TUI starts", () => {
		const stdin = new FakeStdin();
		const exits: number[] = [];
		installStartupCtrlCExit({ stdin, exit: (code) => exits.push(code) });

		stdin.emit("data", Buffer.from([0x03]));

		expect(exits).toEqual([130]);
	});

	it("hands buffered bytes back on release so the TUI still sees early keystrokes", () => {
		const stdin = new FakeStdin();
		const exits: number[] = [];
		const release = installStartupCtrlCExit({ stdin, exit: (code) => exits.push(code) });

		stdin.emit("data", Buffer.from("a"));
		stdin.emit("data", Buffer.from("bc"));
		release();

		expect(exits).toEqual([]);
		expect(stdin.pauseCalls).toBe(1);
		expect(stdin.unshifted).toEqual([Buffer.from("abc")]);

		// After release the watcher is detached: Ctrl+C belongs to the TUI again.
		stdin.emit("data", Buffer.from([0x03]));
		expect(exits).toEqual([]);
	});

	it("release is idempotent", () => {
		const stdin = new FakeStdin();
		const release = installStartupCtrlCExit({ stdin, exit: () => {} });

		release();
		release();

		expect(stdin.pauseCalls).toBe(1);
		expect(stdin.unshifted).toEqual([]);
	});

	it("does not attach to a non-TTY stdin", () => {
		const stdin = new FakeStdin();
		stdin.isTTY = false;
		const exits: number[] = [];
		const release = installStartupCtrlCExit({ stdin, exit: (code) => exits.push(code) });

		expect(stdin.listenerCount("data")).toBe(0);
		stdin.emit("data", Buffer.from([0x03]));
		expect(exits).toEqual([]);
		release();
		expect(stdin.pauseCalls).toBe(0);
	});
});
