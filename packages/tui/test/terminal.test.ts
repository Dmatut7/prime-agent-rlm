import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";
import { resetCapabilitiesCache } from "../src/terminal-image.js";

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
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
			process.stdin.emit("data", "\x1b[?1u");
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
			process.stdin.emit("data", "\x1b[?1u");
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
			process.stdin.emit("data", "\x1b[?1u");
			terminal.enterAltScreen();
			terminal.leaveAltScreen();
			terminal.stop();

			// The alt screen has its own keyboard mode stack (kitty spec), so the
			// startup push covers only the main screen: re-push after ?1049h and
			// pop before ?1049l, while the alt stack is still the active one.
			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[c",
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

			assert.deepEqual(writes, ["\x1b[?2004h", "\x1b[?u\x1b[c", "\x1b[?1049h", "\x1b[?1049l", "\x1b[?2004l"]);
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
			process.stdin.emit("data", "\x1b[?1u");
			first.enterAltScreen();
			first.stop({ preserveAltScreen: true });

			const second = new ProcessTerminal();
			second.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", "\x1b[?1u");
			second.stop();

			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[c",
				"\x1b[>7u",
				"\x1b[?1049h",
				"\x1b[>7u",
				"\x1b[?2004l",
				"\x1b[<u",
				"\x1b[?2004h",
				"\x1b[?u\x1b[c",
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

	it("pushes onto the active alt screen when the kitty answer arrives after entering it", () => {
		const writes: string[] = [];
		const restore = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			terminal.enterAltScreen();
			process.stdin.emit("data", "\x1b[?1u");
			terminal.leaveAltScreen();
			terminal.stop();

			assert.deepEqual(writes, [
				"\x1b[?2004h",
				"\x1b[?u\x1b[c",
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
			process.stdin.emit("data", "\x1b[?1u");
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

			assert.deepEqual(writes.slice(0, 3), ["\x1b[?2004h", "\x1b[>7u", "\x1b[c"]);
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

			assert.deepEqual(writes.slice(0, 3), ["\x1b[?2004h", "\x1b[>4;2m", "\x1b[c"]);
			assert.ok(!writes.includes("\x1b[>7u"));
		} finally {
			restore();
		}
	});
});

function patchTerminalStdio(writes: string[]): () => void {
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
