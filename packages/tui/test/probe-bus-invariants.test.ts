/**
 * Probe-bus hardening invariants (docs/fork/probe-bus-design.md, wave-31).
 *
 * Two peer bugs this file pins against, both reported by other TUIs:
 *
 * - Claude Code 2.1.271/2.1.269: capability-query answers leaking into the
 *   shell prompt on exit/suspend/external-editor, or onto the screen as stray
 *   text at startup. Invariant 1: no probe-answer byte ever reaches the app's
 *   input stream, however it is interleaved with keystrokes, pastes, chunk
 *   boundaries, the DA fence, drainInput() or stop().
 * - Gemini CLI #29487: stdin left paused/misconfigured after capability
 *   detection. Invariant 2: whether detection completes (DA fence), is
 *   aborted (stop mid-window) or times out (fallback timer), stop() restores
 *   the tty: raw mode back to its previous value, stdin paused, every stdin
 *   listener detached.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";
import { resetCapabilitiesCache } from "../src/terminal-image.js";

const DA_ANSWER = "\x1b[?64;1;2;6c";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MockedStdin {
	rawModeChanges: boolean[];
	pauseCalls: number;
	resumeCalls: number;
}

/**
 * Capture stdout writes and mock the stdin tty surface (raw mode, resume,
 * pause, TTY bits) the same way terminal.test.ts does, plus raw/pause call
 * tracking for the stdin-restoration invariants. Pins terminal-detection env
 * off so the probe burst is environment-proof.
 */
function patchTerminalStdio(writes: string[]): { stdin: MockedStdin; restore: () => void } {
	const originalWrite = process.stdout.write;
	const originalIsRaw = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
	const originalSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
	const originalResume = Object.getOwnPropertyDescriptor(process.stdin, "resume");
	const originalPause = Object.getOwnPropertyDescriptor(process.stdin, "pause");
	const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
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
		"PI_TUI_WRITE_LOG",
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

	const stdin: MockedStdin = { rawModeChanges: [], pauseCalls: 0, resumeCalls: 0 };
	let isRaw = false;
	Object.defineProperty(process.stdin, "isRaw", { configurable: true, get: () => isRaw });
	Object.defineProperty(process.stdin, "setRawMode", {
		configurable: true,
		value: (enabled: boolean) => {
			isRaw = enabled;
			stdin.rawModeChanges.push(enabled);
			return process.stdin;
		},
	});
	Object.defineProperty(process.stdin, "resume", {
		configurable: true,
		value: () => {
			stdin.resumeCalls++;
			return process.stdin;
		},
	});
	Object.defineProperty(process.stdin, "pause", {
		configurable: true,
		value: () => {
			stdin.pauseCalls++;
			return process.stdin;
		},
	});
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>): boolean => {
		const chunk = args[0];
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		// The TAP reporter's output flows through process.stdout.write too, and the
		// tests below hold this patch across awaited timers, so reporter lines must
		// pass through or the test report itself is swallowed. Terminal control
		// sequences written under test never contain a newline; TAP chunks do.
		if (text.includes("\n")) {
			return Reflect.apply(originalWrite, process.stdout, args);
		}
		writes.push(text);
		const callback = args.find((arg): arg is (error?: Error | null) => void => typeof arg === "function");
		callback?.();
		return true;
	}) as typeof process.stdout.write;

	return {
		stdin,
		restore: () => {
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
		},
	};
}

function restoreProperty(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(object, key, descriptor);
	} else {
		Reflect.deleteProperty(object, key);
	}
}

/** The tty contract every stop() must leave behind, in every probe outcome. */
function assertStdinRestored(
	terminal: ProcessTerminal,
	stdin: MockedStdin,
	baselineListenerCount: number,
	writes: string[],
): void {
	assert.deepStrictEqual(stdin.rawModeChanges, [true, false], "raw mode engaged at start, restored at stop");
	assert.strictEqual(stdin.pauseCalls, 1, "stdin paused exactly once at stop");
	assert.strictEqual(process.stdin.listenerCount("data"), baselineListenerCount, "no stdin data listener left behind");
	assert.strictEqual(terminal.probeBus, undefined, "the probe bus is torn down with the terminal");

	// Answers arriving after the handoff belong to nobody: no input, no writes.
	const writesAtStop = writes.length;
	process.stdin.emit("data", `\x1b[?1u\x1b[?2027;1$y${DA_ANSWER}`);
	assert.strictEqual(writes.length, writesAtStop, "a late probe answer must not produce output after stop");
}

describe("probe-bus invariant: probe answers never enter the user-visible stream", () => {
	it("keeps every probe answer out of the input handler across interleavings", async () => {
		const writes: string[] = [];
		const { restore } = patchTerminalStdio(writes);
		// Pin OSC colors off so the 2031 refresh path stays silent and the test
		// keeps no module color state; answers are still consumed on shape.
		process.env.PI_TERMINAL_OSC_COLORS = "0";
		const inputs: string[] = [];
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				(data) => inputs.push(data),
				() => {},
			);

			// One chunk carrying a key, every probe answer shape and another key.
			process.stdin.emit(
				"data",
				"a" +
					"\x1b[?1u" + // Kitty keyboard flags
					"\x1b[?2026;2$y" + // DECRPM sync
					"\x1b[?2027;1$y" + // DECRPM grapheme
					"\x1b[?2031;2$y" + // DECRPM scheme
					"\x1b[?997;1n" + // scheme push
					"\x1b[6;18;104t" + // cell size
					"\x1b]10;rgb:ffff/ffff/ffff\x07" + // OSC 10
					"\x1b]11;rgb:0000/0000/0000\x1b\\" + // OSC 11
					DA_ANSWER + // the DA fence
					"b",
			);

			// A DECRPM and the DA fence torn across chunk boundaries, with keys.
			process.stdin.emit("data", "c\x1b[?202");
			process.stdin.emit("data", "7;1$y\x1b[?64;1;2;");
			process.stdin.emit("data", "6cd");

			// Probe answers embedded in a bracketed paste are lifted out of the
			// paste text and routed to the bus, never into the pasted content.
			process.stdin.emit("data", `\x1b[200~hello \x1b[?2031;1$y world${DA_ANSWER}!\x1b[201~`);
			await wait(60); // the paste closes once the stream goes quiet (settle 20ms)

			// Late answers past the fence are still consumed.
			process.stdin.emit("data", "\x1b[?3u\x1b[?2026;1$y");

			assert.deepStrictEqual(inputs, ["a", "b", "c", "d", "\x1b[200~hello  world!\x1b[201~"]);
			terminal.stop();
		} finally {
			restore();
		}
	});

	it("keeps stale answers from a previous session out of the next session's input", () => {
		const writes: string[] = [];
		const { restore } = patchTerminalStdio(writes);
		try {
			// The suspend shape: the first session stops inside its probe window
			// (Ctrl+Z -> ui.stop()); its outstanding answers land while the second
			// session (SIGCONT -> ui.start()) is probing again.
			const first = new ProcessTerminal();
			const firstInputs: string[] = [];
			first.start(
				(data) => firstInputs.push(data),
				() => {},
			);
			first.stop();

			// An answer with no live consumer goes nowhere.
			process.stdin.emit("data", "\x1b[?1u");
			assert.deepStrictEqual(firstInputs, []);

			const second = new ProcessTerminal();
			const secondInputs: string[] = [];
			second.start(
				(data) => secondInputs.push(data),
				() => {},
			);
			// Stale first-generation answers racing the second generation's burst:
			// the fresh bus consumes them as (late) answers, not as keystrokes.
			process.stdin.emit("data", "\x1b[?2027;2$y\x1b[?2031;4$yx");
			process.stdin.emit("data", DA_ANSWER);

			assert.deepStrictEqual(secondInputs, ["x"]);
			second.stop();
		} finally {
			restore();
		}
	});
});

describe("probe-bus invariant: stdin state is restored after capability detection", () => {
	it("restores stdin when stop aborts an in-flight probe window", () => {
		const writes: string[] = [];
		const { stdin, restore } = patchTerminalStdio(writes);
		const baselineListenerCount = process.stdin.listenerCount("data");
		try {
			const terminal = new ProcessTerminal();
			const inputs: string[] = [];
			terminal.start(
				(data) => inputs.push(data),
				() => {},
			);
			assert.ok(terminal.probeBus, "probe window open");
			terminal.stop();
			assertStdinRestored(terminal, stdin, baselineListenerCount, writes);
			assert.deepStrictEqual(inputs, []);
		} finally {
			restore();
		}
	});

	it("restores stdin after detection completes at the DA fence", async () => {
		const writes: string[] = [];
		const { stdin, restore } = patchTerminalStdio(writes);
		const baselineListenerCount = process.stdin.listenerCount("data");
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			process.stdin.emit("data", DA_ANSWER);
			await terminal.probeBus!.settled;
			terminal.stop();
			assertStdinRestored(terminal, stdin, baselineListenerCount, writes);
		} finally {
			restore();
		}
	});

	it("restores stdin after detection times out on the fallback timer", async () => {
		const writes: string[] = [];
		const { stdin, restore } = patchTerminalStdio(writes);
		const baselineListenerCount = process.stdin.listenerCount("data");
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);
			// The one real-time wait: the fallback clock is the production 1000ms,
			// and the timeout shape is exactly the Gemini #29487 regression class.
			await terminal.probeBus!.settled;
			assert.ok(
				writes.join("").includes("\x1b[>4;2m"),
				"the timeout verdict still ran the kitty -> modifyOtherKeys fallback",
			);
			terminal.stop();
			assertStdinRestored(terminal, stdin, baselineListenerCount, writes);
		} finally {
			restore();
		}
	});
});

describe("drainInput waits out the probe window", () => {
	it("holds the drain until the DA fence closes the window, then drains the tail", async () => {
		const writes: string[] = [];
		const { restore } = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);

			const order: string[] = [];
			void terminal.probeBus!.settled.then(() => order.push("settled"));
			let drained = false;
			const drain = terminal.drainInput(1000, 50).then(() => {
				drained = true;
				order.push("drained");
			});

			// Long past the idle window: with no settle wait the drain would have
			// finished at ~50ms and let the in-flight answers leak past stop().
			await wait(150);
			assert.strictEqual(drained, false, "the drain must wait out the probe window");

			process.stdin.emit("data", DA_ANSWER);
			await drain;
			assert.strictEqual(drained, true);
			assert.deepStrictEqual(order, ["settled", "drained"]);
			terminal.stop();
		} finally {
			restore();
		}
	});

	it("stays bounded by maxMs when the terminal never answers", async () => {
		const writes: string[] = [];
		const { restore } = patchTerminalStdio(writes);
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				() => {},
				() => {},
			);

			const startedAt = Date.now();
			await terminal.drainInput(200, 50);
			const elapsed = Date.now() - startedAt;
			// The settle wait consumed the budget (>= ~maxMs), and the 1000ms
			// fallback timer did NOT get to extend it (<< 1000).
			assert.ok(elapsed >= 150, `the settle wait held the drain open (${elapsed}ms)`);
			assert.ok(elapsed < 700, `the drain stayed inside its maxMs budget (${elapsed}ms)`);
			terminal.stop();
		} finally {
			restore();
		}
	});

	it("consumes answers arriving mid-drain without delivering them as input", async () => {
		const writes: string[] = [];
		const { restore } = patchTerminalStdio(writes);
		const inputs: string[] = [];
		try {
			const terminal = new ProcessTerminal();
			terminal.start(
				(data) => inputs.push(data),
				() => {},
			);

			let drained = false;
			const drain = terminal.drainInput(1000, 50).then(() => {
				drained = true;
			});
			await wait(20);
			// A late Kitty answer and a user key in the middle of the exit drain:
			// the bus still consumes the answer; the key is drained, not delivered.
			process.stdin.emit("data", "\x1b[?1uz");
			process.stdin.emit("data", DA_ANSWER);
			await drain;
			assert.strictEqual(drained, true);

			terminal.stop();
			// After the handoff nothing is anybody's input.
			process.stdin.emit("data", "q");
			await wait(20);
			assert.deepStrictEqual(inputs, []);
		} finally {
			restore();
		}
	});
});
