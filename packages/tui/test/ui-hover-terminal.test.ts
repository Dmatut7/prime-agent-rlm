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

describe("ProcessTerminal mouse tracking around exit", () => {
	async function withCapturedStdout<T>(run: (writes: string[]) => Promise<T> | T): Promise<T> {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		// The test runner reports through stdout while these tests await; only terminal
		// control sequences are captured, everything else goes on to the real stream.
		process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			if (typeof chunk !== "string" || !chunk.startsWith("\x1b[")) {
				return originalWrite.apply(process.stdout, args);
			}
			writes.push(chunk);
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;
		try {
			return await run(writes);
		} finally {
			process.stdout.write = originalWrite;
		}
	}

	it("drainInput closes mouse reporting first, so a moving pointer cannot keep the drain going", async () => {
		const terminal = new ProcessTerminal();
		await withCapturedStdout(async (writes) => {
			terminal.setMouseTracking(true);
			writes.length = 0;
			const drained = terminal.drainInput(100, 10);
			assert.deepStrictEqual(writes, [DISABLE], "reporting is off before the drain starts waiting");
			assert.strictEqual(terminal.mouseTrackingActive, false);
			await drained;
		});
	});

	it("does not let the running UI turn reporting back on while the drain is under way, and re-arms after stop()", async () => {
		const terminal = new ProcessTerminal();
		await withCapturedStdout(async (writes) => {
			terminal.setMouseTracking(true);
			const drained = terminal.drainInput(100, 10);
			writes.length = 0;
			terminal.setMouseTracking(true);
			assert.deepStrictEqual(writes, [], "a render's sync cannot re-enable it");
			assert.strictEqual(terminal.mouseTrackingActive, false);
			await drained;
			terminal.setMouseTracking(true);
			assert.deepStrictEqual(writes, [], "still off after the drain, until the terminal is stopped");

			terminal.stop();
			writes.length = 0;
			terminal.setMouseTracking(true);
			assert.deepStrictEqual(writes, [ENABLE], "a stopped terminal starts clean");
			terminal.setMouseTracking(false);
		});
	});

	it("drainInput without mouse tracking writes no mouse sequence", async () => {
		const terminal = new ProcessTerminal();
		await withCapturedStdout(async (writes) => {
			await terminal.drainInput(50, 10);
			assert.deepStrictEqual(writes, []);
		});
	});
});
