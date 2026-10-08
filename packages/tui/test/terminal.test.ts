import assert from "node:assert";
import { describe, it } from "node:test";
import { engageEarlyRawMode, ProcessTerminal, releaseEarlyRawMode } from "../src/terminal.js";
import { clearDefaultTerminalColors, getDefaultTerminalColors } from "../src/terminal-colors.js";
import {
	allocatePlaceholderImageId,
	drainKittyImageTransmits,
	getKittyImageTransmitsVersion,
	invalidateKittyImageTransmits,
	renderKittyPlaceholderImage,
	resetCapabilitiesCache,
} from "../src/terminal-image.js";
import { isGrapheme2027Active } from "../src/utils.js";

describe("ProcessTerminal dimensions", () => {
	const withMockedDimensions = (isTTY: boolean, fn: () => void): void => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "isTTY", { value: isTTY, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";
			fn();
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousIsTTYDescriptor) {
				Object.defineProperty(process.stdout, "isTTY", previousIsTTYDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	};

	it("falls back to COLUMNS and LINES before default dimensions on a TTY", () => {
		withMockedDimensions(true, () => {
			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		});
	});

	it("ignores COLUMNS and LINES when stdout is not a TTY", () => {
		// A stale exported COLUMNS must not override the default size behind a pipe.
		withMockedDimensions(false, () => {
			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 80);
			assert.equal(terminal.rows, 24);
		});
	});
});

describe("ProcessTerminal alternate screen handoff", () => {
	it("keeps raw input active and discards keys until the next fullscreen TUI starts", () => {
		const originalWrite = process.stdout.write;
		const originalIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
		const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
		const originalResume = Object.getOwnPropertyDescriptor(process.stdin, "resume");
		const originalPause = Object.getOwnPropertyDescriptor(process.stdin, "pause");
		let isRaw = false;
		const rawModeChanges: boolean[] = [];
		const firstInputs: string[] = [];
		const secondInputs: string[] = [];

		Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => isRaw });
		Object.defineProperty(process.stdin, "setRawMode", {
			configurable: true,
			value: (enabled: boolean) => {
				isRaw = enabled;
				rawModeChanges.push(enabled);
				return process.stdin;
			},
		});
		Object.defineProperty(process.stdin, "resume", { configurable: true, value: () => process.stdin });
		Object.defineProperty(process.stdin, "pause", { configurable: true, value: () => process.stdin });
		process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		try {
			const first = new ProcessTerminal();
			first.start(
				(data) => firstInputs.push(data),
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			assert.equal(isRaw, true);
			process.stdin.emit("data", "\x1b[B");
			assert.deepEqual(firstInputs, []);

			const second = new ProcessTerminal();
			second.start(
				(data) => secondInputs.push(data),
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			process.stdin.emit("data", "x");

			assert.equal(isRaw, true);
			assert.deepEqual(secondInputs, ["x"]);
			second.stop();
			assert.equal(isRaw, false);
			assert.deepEqual(rawModeChanges, [true, true, false]);
		} finally {
			process.stdout.write = originalWrite;
			restoreProperty(process.stdin, "isRaw", originalIsRaw);
			restoreProperty(process.stdin, "setRawMode", originalSetRawMode);
			restoreProperty(process.stdin, "resume", originalResume);
			restoreProperty(process.stdin, "pause", originalPause);
		}
	});

	describe("early raw mode", () => {
		function mockStdinRaw(initialRaw: boolean) {
			const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
			const originalIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
			const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
			const originalResume = Object.getOwnPropertyDescriptor(process.stdin, "resume");
			const originalPause = Object.getOwnPropertyDescriptor(process.stdin, "pause");
			let isRaw = initialRaw;
			let resumeCalls = 0;
			const rawModeChanges: boolean[] = [];
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, get: () => true });
			Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => isRaw });
			Object.defineProperty(process.stdin, "setRawMode", {
				configurable: true,
				value: (enabled: boolean) => {
					isRaw = enabled;
					rawModeChanges.push(enabled);
					return process.stdin;
				},
			});
			Object.defineProperty(process.stdin, "resume", {
				configurable: true,
				value: () => {
					resumeCalls++;
					return process.stdin;
				},
			});
			Object.defineProperty(process.stdin, "pause", { configurable: true, value: () => process.stdin });
			return {
				get isRaw() {
					return isRaw;
				},
				get resumeCalls() {
					return resumeCalls;
				},
				rawModeChanges,
				restore() {
					restoreProperty(process.stdin, "isTTY", originalIsTTY);
					restoreProperty(process.stdin, "isRaw", originalIsRaw);
					restoreProperty(process.stdin, "setRawMode", originalSetRawMode);
					restoreProperty(process.stdin, "resume", originalResume);
					restoreProperty(process.stdin, "pause", originalPause);
				},
			};
		}

		it("engages raw without reading, and the first terminal still restores cooked on stop", () => {
			const stdin = mockStdinRaw(false);
			const originalWrite = process.stdout.write;
			process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
				const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
				callback?.();
				return true;
			}) as typeof process.stdout.write;
			try {
				engageEarlyRawMode();
				assert.equal(stdin.isRaw, true);
				// Input must keep buffering in the kernel until start() reads it.
				assert.equal(stdin.resumeCalls, 0);

				const terminal = new ProcessTerminal();
				terminal.start(
					() => {},
					() => {},
				);
				terminal.stop();
				// The pre-engage mode was cooked: stop() must not leave the tty raw.
				assert.equal(stdin.isRaw, false);
				assert.deepEqual(stdin.rawModeChanges, [true, true, false]);
			} finally {
				releaseEarlyRawMode();
				process.stdout.write = originalWrite;
				stdin.restore();
			}
		});

		it("restores the original mode when the process exits before any terminal starts", () => {
			const stdin = mockStdinRaw(false);
			try {
				engageEarlyRawMode();
				assert.equal(stdin.isRaw, true);
				releaseEarlyRawMode();
				assert.equal(stdin.isRaw, false);
				assert.deepEqual(stdin.rawModeChanges, [true, false]);
			} finally {
				releaseEarlyRawMode();
				stdin.restore();
			}
		});

		it("is a no-op when stdin is already raw", () => {
			const stdin = mockStdinRaw(true);
			try {
				engageEarlyRawMode();
				assert.deepEqual(stdin.rawModeChanges, []);
				releaseEarlyRawMode();
				assert.deepEqual(stdin.rawModeChanges, []);
			} finally {
				releaseEarlyRawMode();
				stdin.restore();
			}
		});
	});

	it("does not inherit an active alternate screen before it is preserved", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, false);
			second.stop();

			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 0);
			first.leaveAltScreen();
			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 1);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});

	it("inherits a preserved alternate screen into the next terminal instance", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, true);
			second.stop();
			assert.equal(second.altScreenActive, false);

			const third = new ProcessTerminal();
			assert.equal(third.altScreenActive, false);
			assert.ok(writes.includes("\x1b[?1049h"));
			assert.ok(writes.includes("\x1b[?1049l"));
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});

	it("lets the preserving terminal cancel a handoff before it is consumed", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });
			assert.equal(first.altScreenActive, false);

			first.leaveAltScreen();
			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 1);

			const second = new ProcessTerminal();
			assert.equal(second.altScreenActive, false);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});

	it("only hands a preserved alternate screen to one terminal instance", () => {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		const patchedWrite = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;

		process.stdout.write = patchedWrite;
		try {
			const first = new ProcessTerminal();
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			const third = new ProcessTerminal();
			assert.equal(second.altScreenActive, true);
			assert.equal(third.altScreenActive, false);

			second.stop();
			assert.equal(writes.filter((write) => write === "\x1b[?1049l").length, 1);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			process.stdout.write = originalWrite;
		}
	});
});

describe("ProcessTerminal kitty keyboard mode stack", () => {
	it("pushes kitty flags onto the alternate screen stack and pops them before leaving", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			terminal.enterAltScreen();
			terminal.leaveAltScreen();
			terminal.stop();

			// The alt screen has its own keyboard mode stack (kitty spec), so the
			// startup push covers only the main screen: re-push after ?1049h and
			// pop before ?1049l, while the alt stack is still the active one.
			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
				"\x1b[>7u",
				"\x1b[?1049h",
				"\x1b[>7u",
				"\x1b[<u",
				"\x1b[?1049l",
				"\x1b[?2004l",
				"\x1b[<u",
			]);
		} finally {
			restore();
		}
	});

	it("emits no kitty sequences around the alternate screen when kitty protocol is inactive", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			terminal.enterAltScreen();
			terminal.leaveAltScreen();
			terminal.stop();

			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
				"\x1b[?1049h",
				"\x1b[?1049l",
				"\x1b[?2004l",
			]);
		} finally {
			restore();
		}
	});

	it("keeps both screen stacks balanced across a preserved-alt-screen handoff", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const first = new ProcessTerminal();
			first.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			second.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			second.stop();

			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
				"\x1b[>7u",
				"\x1b[?1049h",
				"\x1b[>7u",
				"\x1b[?2004l",
				"\x1b[<u",
				"\x1b[?2004h",
				"\x1b[?u\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
				"\x1b[>7u",
				"\x1b[<u",
				"\x1b[?1049l",
				"\x1b[?2004l",
				"\x1b[<u",
			]);
		} finally {
			restore();
		}
	});

	it("re-pushes onto the main screen when the kitty answer arrived on the alt screen", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			terminal.enterAltScreen();
			process.stdin.emit("data", "\x1b[?0u");
			terminal.leaveAltScreen();
			terminal.stop();

			// The verdict landed on the alt screen, so only the alt stack had an
			// entry; leaving must pop it there and re-push on the main screen, or
			// Alt-modified keys stay dead after the fullscreen toggle.
			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
				"\x1b[?1049h",
				"\x1b[>7u",
				"\x1b[<u",
				"\x1b[?1049l",
				"\x1b[>7u",
				"\x1b[?2004l",
				"\x1b[<u",
			]);
		} finally {
			restore();
		}
	});

	it("pops the main-screen kitty entry on stop after a drain on the alt screen", async () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes, true);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			terminal.enterAltScreen();
			await terminal.drainInput(50, 10);
			terminal.stop();

			// The drain pops the alt screen's entry to silence late key releases;
			// the main screen's startup entry must still be popped by stop(), or
			// the mode stays enabled in the shell and Ctrl+C no longer raises SIGINT.
			// The awaited drain lets the runner's own stdout frames through the
			// passthrough patch, so only the escape-sequence writes are ours.
			const escapeWrites = writes.filter((write) => write.startsWith("\x1b["));
			assert.deepEqual(escapeWrites, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
				"\x1b[>7u",
				"\x1b[?1049h",
				"\x1b[>7u",
				"\x1b[<u",
				"\x1b[?1049l",
				"\x1b[?2004l",
				"\x1b[<u",
			]);
		} finally {
			restore();
		}
	});

	it("keeps both screen stacks balanced across repeated alt-screen cycles", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			terminal.enterAltScreen();
			terminal.leaveAltScreen();
			terminal.enterAltScreen();
			terminal.leaveAltScreen();
			terminal.stop();

			// The main screen keeps its startup entry across cycles (no re-push);
			// each alt-screen visit gets its own push/pop pair.
			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
				"\x1b[>7u",
				"\x1b[?1049h",
				"\x1b[>7u",
				"\x1b[<u",
				"\x1b[?1049l",
				"\x1b[?1049h",
				"\x1b[>7u",
				"\x1b[<u",
				"\x1b[?1049l",
				"\x1b[?2004l",
				"\x1b[<u",
			]);
		} finally {
			restore();
		}
	});
});

describe("ProcessTerminal probe bus wiring", () => {
	it("enables kitty on an answer ahead of the DA fence, never touching modifyOtherKeys", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			process.stdin.emit("data", "\x1b[?64;1;2;6c");
			terminal.stop();

			assert.ok(writes.includes("\x1b[>7u"));
			assert.ok(!writes.includes("\x1b[>4;2m"));
		} finally {
			restore();
		}
	});

	it("falls back to modifyOtherKeys when the DA fence arrives without a kitty answer", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?64;1;2;6c");
			terminal.stop();

			assert.ok(writes.includes("\x1b[>4;2m"));
			assert.ok(!writes.includes("\x1b[>7u"));
		} finally {
			restore();
		}
	});

	it("PI_TERMINAL_KITTY_KEYBOARD=1 pushes kitty flags without probing", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		process.env.PI_TERMINAL_KITTY_KEYBOARD = "1";
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			terminal.stop();

			assert.deepEqual(writes.slice(0, 3), [
				"\x1b[?2004h",
				"\x1b[>7u",
				"\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
			]);
			assert.ok(!writes.includes("\x1b[>4;2m"));
		} finally {
			restore();
		}
	});

	it("PI_TERMINAL_KITTY_KEYBOARD=0 skips the kitty query and enables modifyOtherKeys", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		process.env.PI_TERMINAL_KITTY_KEYBOARD = "0";
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			terminal.stop();

			assert.deepEqual(writes.slice(0, 3), [
				"\x1b[?2004h",
				"\x1b[>4;2m",
				"\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
			]);
			assert.ok(!writes.includes("\x1b[>7u"));
		} finally {
			restore();
		}
	});
});

describe("ProcessTerminal grapheme 2027 mode", () => {
	it("enables DECSET 2027 on a supported DECRPM answer and resets it on stop", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?2027;1$y");
			assert.equal(isGrapheme2027Active(), true);
			process.stdin.emit("data", "\x1b[?64;1;2;6c");
			terminal.stop();

			assert.equal(isGrapheme2027Active(), false);
			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[c",
				"\x1b[?2027h",
				"\x1b[>4;2m",
				"\x1b[?2004l",
				"\x1b[?2027l",
				"\x1b[>4;0m",
			]);
		} finally {
			restore();
		}
	});

	it("never enables 2027 when the DA fence lands first (kitty-shaped silence)", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?64;1;2;6c");
			terminal.stop();

			assert.ok(!writes.includes("\x1b[?2027h"));
			assert.ok(!writes.includes("\x1b[?2027l"));
			assert.equal(isGrapheme2027Active(), false);
		} finally {
			restore();
		}
	});

	it("never enables 2027 on a Pv=0 refusal (kitty-shaped answer)", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?2027;0$y");
			process.stdin.emit("data", "\x1b[?64;1;2;6c");
			terminal.stop();

			assert.ok(!writes.includes("\x1b[?2027h"));
			assert.ok(!writes.includes("\x1b[?2027l"));
		} finally {
			restore();
		}
	});

	it("PI_TERMINAL_GRAPHEME_2027=1 enables 2027 during start without probing", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		process.env.PI_TERMINAL_GRAPHEME_2027 = "1";
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			terminal.stop();

			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?2027h",
				"\x1b[?u\x1b[?2026$p\x1b[?2031$p\x1b[c",
				"\x1b[?2004l",
				"\x1b[?2027l",
			]);
		} finally {
			restore();
		}
	});

	it("PI_TERMINAL_GRAPHEME_2027=0 skips the query and stays off even when the terminal answers", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		process.env.PI_TERMINAL_GRAPHEME_2027 = "0";
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?2027;1$y");
			terminal.stop();

			assert.deepEqual(writes, ["\x1b[?2004h", "\x1b[?u\x1b[?2026$p\x1b[?2031$p\x1b[c", "\x1b[?2004l"]);
		} finally {
			restore();
		}
	});

	it("does not enable 2027 while the alt screen is active (per-screen semantics unverified)", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const first = new ProcessTerminal();
			first.start(
				() => {},
				() => {},
			);
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			second.start(
				() => {},
				() => {},
			);
			assert.equal(second.altScreenActive, true);
			process.stdin.emit("data", "\x1b[?2027;1$y");
			second.stop();

			assert.ok(!writes.includes("\x1b[?2027h"), "no mode-set may land on the wrong screen");
			assert.equal(isGrapheme2027Active(), false);
		} finally {
			const cleanup = new ProcessTerminal();
			if (cleanup.altScreenActive) {
				cleanup.stop();
			}
			restore();
		}
	});
});

describe("ProcessTerminal crash exit guard (R5-M5)", () => {
	// Fault injection for the crash paths (R2-H1/R4-M19/R5-M1): the process dies
	// without stop(), so the exit event fires with the tty still configured. The
	// guard is the process's "exit" listener armed by start(); tests locate it by
	// diffing the public listener list, never by probing the instance.
	function armedExitGuard(baseline: ReadonlySet<unknown>): () => void {
		const guard = process.listeners("exit").find((listener) => !baseline.has(listener));
		assert.ok(guard, "start() arms the exit guard");
		return guard as () => void;
	}

	function recordRawMode(): boolean[] {
		const rawCalls: boolean[] = [];
		Object.defineProperty(process.stdin, "setRawMode", {
			configurable: true,
			value: (enabled: boolean) => {
				rawCalls.push(enabled);
				return process.stdin;
			},
		});
		return rawCalls;
	}

	it("restores raw/alt/kitty/2027/bracketed-paste/mouse when the process exits without stop()", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		const rawCalls = recordRawMode();
		// Every path out stops the terminal: a failed assertion must not leak a
		// live probe bus (its listeners would keep consuming later tests' input).
		let terminal: ProcessTerminal | undefined;
		try {
			terminal = new ProcessTerminal();
			const baseline: ReadonlySet<unknown> = new Set(process.listeners("exit"));
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u"); // kitty supported -> pushed on the main screen
			process.stdin.emit("data", "\x1b[?2027;1$y"); // 2027 supported (main screen)
			terminal.enterAltScreen(); // kitty pushed on the alt stack too
			terminal.setMouseTracking(true);

			const guard = armedExitGuard(baseline);
			writes.length = 0;
			guard(); // the process dies without stop()

			assert.deepEqual(writes, [
				"\x1b[<u", // the alt-screen kitty entry, popped while its screen is still live
				"\x1b[?1049l", // the alt screen released
				"\x1b[<u", // the main-screen kitty entry
				"\x1b[?1006l\x1b[?1003l\x1b[?1002l", // mouse reporting off
				"\x1b[?2027l", // grapheme mode reset
				"\x1b[?2004l", // bracketed paste off
			]);
			assert.deepEqual(rawCalls, [true, false], "raw mode engaged at start, restored by the guard");
			assert.equal(isGrapheme2027Active(), false);
		} finally {
			terminal?.stop();
			restore();
		}
	});

	it("a clean stop() disarms the guard so exit after stop restores nothing twice", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		let terminal: ProcessTerminal | undefined;
		try {
			const baseline = process.listenerCount("exit");
			terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			assert.equal(process.listenerCount("exit"), baseline + 1, "start() arms one guard");
			terminal.stop();
			assert.equal(process.listenerCount("exit"), baseline, "stop() leaves no guard behind");
		} finally {
			terminal?.stop();
			restore();
		}
	});

	it("keeps the guard armed through a preserved handoff, and the next start() replaces it", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		recordRawMode();
		let first: ProcessTerminal | undefined;
		let second: ProcessTerminal | undefined;
		try {
			const baseline = process.listenerCount("exit");
			first = new ProcessTerminal();
			first.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });
			assert.equal(process.listenerCount("exit"), baseline + 1, "a crash in the handoff gap is still covered");

			// The successor adopts the tty: its start() replaces the guard, never stacks.
			second = new ProcessTerminal();
			second.start(
				() => {},
				() => {},
			);
			assert.equal(process.listenerCount("exit"), baseline + 1, "one guard, not two");
			process.stdin.emit("data", "\x1b[?0u");
			second.stop();
			assert.equal(process.listenerCount("exit"), baseline);
		} finally {
			second?.stop();
			first?.stop();
			restore();
		}
	});

	it("a crash in the handoff gap restores the alt screen and the pre-session raw state", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		const rawCalls = recordRawMode();
		let first: ProcessTerminal | undefined;
		try {
			const baseline: ReadonlySet<unknown> = new Set(process.listeners("exit"));
			first = new ProcessTerminal();
			first.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?0u");
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const guard = armedExitGuard(baseline);
			writes.length = 0;
			guard(); // the process dies while the next TUI has not started yet

			assert.deepEqual(writes, [
				// stop(preserveAltScreen) already popped the alt stack's entry; the
				// main screen's entry is what the crash would have leaked.
				"\x1b[?1049l", // the preserved alt screen released
				"\x1b[<u", // the main-screen kitty entry
				"\x1b[?2004l", // bracketed paste off
			]);
			assert.equal(rawCalls[rawCalls.length - 1], false, "raw mode restored from the handoff record");
		} finally {
			// The fired guard stays armed; a fresh start/stop replaces and disarms it.
			const cleanup = new ProcessTerminal();
			cleanup.start(
				() => {},
				() => {},
			);
			cleanup.stop();
			first?.stop();
			restore();
		}
	});
});

describe("ProcessTerminal grapheme 2027 deferred mode-set (R5-M6)", () => {
	it("sends the deferred 2027 mode-set when leaving the alt screen", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		let terminal: ProcessTerminal | undefined;
		try {
			terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			terminal.enterAltScreen();
			// The probe answer lands while the alt screen is active (the fullscreen default).
			process.stdin.emit("data", "\x1b[?2027;1$y");
			assert.ok(!writes.includes("\x1b[?2027h"), "no mode-set may land on the wrong screen");
			assert.equal(isGrapheme2027Active(), false);

			terminal.leaveAltScreen();
			assert.ok(writes.includes("\x1b[?2027h"), "the main screen is owed the mode-set");
			assert.equal(isGrapheme2027Active(), true);

			terminal.stop();
			assert.ok(writes.includes("\x1b[?2027l"), "stop still resets the mode");
			assert.equal(isGrapheme2027Active(), false);
		} finally {
			terminal?.stop();
			restore();
		}
	});
});

describe("ProcessTerminal mode 2031 color-scheme pushes", () => {
	it("enables 2031 on a supported DECRPM answer and resets it on stop", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?2031;2$y");
			assert.ok(writes.includes("\x1b[?2031h"));
			terminal.stop();
			assert.ok(writes.includes("\x1b[?2031l"));
		} finally {
			restore();
		}
	});

	it("routes a 997 push into an OSC re-query, refreshes the default colors and triggers a redraw", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		let resizes = 0;
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {
					resizes++;
				},
			);
			process.stdin.emit("data", "\x1b[?2031;1$y");
			process.stdin.emit("data", "\x1b[?997;2n");
			assert.ok(writes.join("").includes("\x1b]10;?\x1b\\\x1b]11;?\x1b\\"));

			process.stdin.emit("data", "\x1b]10;rgb:ffff/ffff/ffff\x07");
			// A half-answered refresh does not redraw yet.
			assert.equal(resizes, 0);
			process.stdin.emit("data", "\x1b]11;rgb:eeee/eeee/eeee\x1b\\");
			assert.deepEqual(getDefaultTerminalColors(), {
				foreground: { r: 255, g: 255, b: 255 },
				background: { r: 238, g: 238, b: 238 },
			});
			assert.equal(resizes, 1);
			terminal.stop();
		} finally {
			clearDefaultTerminalColors();
			restore();
		}
	});

	it("ignores pushes when PI_TERMINAL_SCHEME_2031=0", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		process.env.PI_TERMINAL_SCHEME_2031 = "0";
		let resizes = 0;
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {
					resizes++;
				},
			);
			process.stdin.emit("data", "\x1b[?997;1n");
			process.stdin.emit("data", "\x1b]10;rgb:ffff/ffff/ffff\x07");
			process.stdin.emit("data", "\x1b]11;rgb:eeee/eeee/eeee\x1b\\");
			assert.ok(!writes.join("").includes("\x1b[?2031h"));
			assert.ok(!writes.join("").includes("\x1b]10;?"));
			assert.equal(getDefaultTerminalColors(), undefined);
			assert.equal(resizes, 0);
			terminal.stop();
		} finally {
			restore();
		}
	});
});

function patchTerminalStdio(writes: string[], passthrough = false): () => void {
	const originalWrite = process.stdout.write;
	const originalIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
	const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
	const originalResume = Object.getOwnPropertyDescriptor(process.stdin, "resume");
	const originalPause = Object.getOwnPropertyDescriptor(process.stdin, "pause");
	const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	// The probe bus's burst depends on image-capability detection and PI_TERMINAL_*
	// overrides; pin both off so the asserted write sequence is environment-proof.
	const probedEnvVars = [
		"TMUX",
		"TERM",
		"TERM_PROGRAM",
		"COLORTERM",
		"KITTY_WINDOW_ID",
		"WEZTERM_PANE",
		"ITERM_SESSION_ID",
		"GHOSTTY_RESOURCES_DIR",
		"PI_ENABLE_GHOSTTY_IMAGES",
		"PI_TERMINAL_KITTY_KEYBOARD",
		"PI_TERMINAL_SYNC_2026",
		"PI_TERMINAL_GRAPHEME_2027",
		"PI_TERMINAL_SCHEME_2031",
		"PI_TERMINAL_OSC_COLORS",
		"PI_TERMINAL_CELL_SIZE",
	];
	const savedEnv = new Map<string, string | undefined>();
	for (const name of probedEnvVars) {
		savedEnv.set(name, process.env[name]);
		delete process.env[name];
	}
	resetCapabilitiesCache();

	Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => false });
	Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: () => process.stdin });
	Object.defineProperty(process.stdin, "resume", { configurable: true, value: () => process.stdin });
	Object.defineProperty(process.stdin, "pause", { configurable: true, value: () => process.stdin });
	// The default-color probe only runs on TTYs; pinning it off keeps the write sequence deterministic.
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
		const chunk = args[0];
		writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
		callback?.();
		if (passthrough) {
			// Async tests must not swallow: while the test awaits, the runner's own
			// stdout frames would land in `writes` and never reach the parent.
			return originalWrite.apply(process.stdout, args);
		}
		return true;
	}) as typeof process.stdout.write;

	return () => {
		process.stdout.write = originalWrite;
		restoreProperty(process.stdin, "isRaw", originalIsRaw);
		restoreProperty(process.stdin, "setRawMode", originalSetRawMode);
		restoreProperty(process.stdin, "resume", originalResume);
		restoreProperty(process.stdin, "pause", originalPause);
		restoreProperty(process.stdin, "isTTY", originalStdinIsTTY);
		restoreProperty(process.stdout, "isTTY", originalStdoutIsTTY);
		for (const [name, value] of savedEnv) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		resetCapabilitiesCache();
	};
}

function restoreProperty(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(object, key, descriptor);
	} else {
		Reflect.deleteProperty(object, key);
	}
}

describe("ProcessTerminal kitty placeholder transmits", () => {
	function captureStdout(): { writes: string[]; restore: () => void } {
		const originalWrite = process.stdout.write;
		const writes: string[] = [];
		process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
			const chunk = args[0];
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
			callback?.();
			return true;
		}) as typeof process.stdout.write;
		return {
			writes,
			restore: () => {
				process.stdout.write = originalWrite;
			},
		};
	}

	it("flushes queued placeholder transmits ahead of the payload, once per image", () => {
		const { writes, restore } = captureStdout();
		invalidateKittyImageTransmits();
		drainKittyImageTransmits();
		try {
			const imageId = allocatePlaceholderImageId();
			renderKittyPlaceholderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 4, imageId });

			const terminal = new ProcessTerminal();
			terminal.write("PAYLOAD");
			assert.strictEqual(writes.length, 1);
			const transmitIndex = writes[0]!.indexOf(`\x1b_Ga=T,U=1,`);
			const payloadIndex = writes[0]!.indexOf("PAYLOAD");
			assert.ok(transmitIndex !== -1, "transmit sequence written");
			assert.ok(transmitIndex < payloadIndex, "transmit precedes the frame payload");
			assert.ok(writes[0]!.includes(`,i=${imageId},`));

			terminal.write("MORE");
			assert.strictEqual(writes[1], "MORE");
		} finally {
			restore();
			invalidateKittyImageTransmits();
			drainKittyImageTransmits();
		}
	});

	it("invalidates placeholder transmits on both alt-screen transitions", () => {
		const { restore } = captureStdout();
		invalidateKittyImageTransmits();
		drainKittyImageTransmits();
		try {
			const terminal = new ProcessTerminal();
			const before = getKittyImageTransmitsVersion();
			terminal.enterAltScreen();
			const afterEnter = getKittyImageTransmitsVersion();
			assert.ok(afterEnter > before, "entering the alt screen invalidates");
			terminal.leaveAltScreen();
			assert.ok(getKittyImageTransmitsVersion() > afterEnter, "leaving the alt screen invalidates");
		} finally {
			restore();
			invalidateKittyImageTransmits();
			drainKittyImageTransmits();
		}
	});
});

describe("ProcessTerminal title", () => {
	it("strips control characters so a name cannot terminate the OSC sequence early", () => {
		const writes: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		const spyWrite = ((chunk: string | Uint8Array): boolean => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdout.write = spyWrite;
		try {
			const terminal = new ProcessTerminal();
			// A model-controlled session name carrying BEL (OSC terminator) and ESC
			// would splice an OSC 52 clipboard write into the byte stream.
			terminal.setTitle("worker\x07\x1b]52;c;cGFzdGU=\x07 evil");
		} finally {
			process.stdout.write = originalWrite;
		}
		const payload = writes.join("");
		assert.ok(payload.startsWith("\x1b]0;"), payload);
		assert.ok(payload.endsWith("\x07"), payload);
		// The only BEL is the terminator we appended; no injected escapes survive.
		assert.equal((payload.match(/\x07/g) ?? []).length, 1, payload);
		assert.ok(!payload.includes("\x1b]52;"), payload);
		assert.ok(!payload.includes("\x1b["), payload);
	});
});
