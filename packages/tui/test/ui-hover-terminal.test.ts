import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

const ENABLE = "\x1b[?1003h\x1b[?1006h";
const DISABLE = "\x1b[?1006l\x1b[?1003l\x1b[?1002l";

function captureStdout(run: () => void): string[] {
	const originalWrite = process.stdout.write;
	const writes: string[] = [];
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
		const chunk = args[0];
		writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
		callback?.();
		return true;
	}) as typeof process.stdout.write;
	try {
		run();
	} finally {
		process.stdout.write = originalWrite;
	}
	return writes;
}

describe("ProcessTerminal hover mouse tracking", () => {
	it("turns on any-motion reporting in SGR format, and turns 1003, 1006 and the old 1002 off again", () => {
		const terminal = new ProcessTerminal();
		const writes = captureStdout(() => {
			terminal.setMouseTracking(true);
			assert.strictEqual(terminal.mouseTrackingActive, true);
			terminal.setMouseTracking(false);
			assert.strictEqual(terminal.mouseTrackingActive, false);
		});
		assert.deepStrictEqual(writes, [ENABLE, DISABLE]);
	});

	it("writes nothing when the state does not change", () => {
		const terminal = new ProcessTerminal();
		const writes = captureStdout(() => {
			terminal.setMouseTracking(false);
			terminal.setMouseTracking(true);
			terminal.setMouseTracking(true);
			terminal.setMouseTracking(false);
			terminal.setMouseTracking(false);
		});
		assert.deepStrictEqual(writes, [ENABLE, DISABLE]);
	});

	it("stop() closes 1003 as well when tracking is still on", () => {
		const terminal = new ProcessTerminal();
		const writes = captureStdout(() => {
			terminal.setMouseTracking(true);
			terminal.stop();
		});
		assert.strictEqual(writes[0], ENABLE);
		assert.ok(writes.includes(DISABLE), "stop() writes the full disable sequence");
		assert.strictEqual(terminal.mouseTrackingActive, false);
	});
});
