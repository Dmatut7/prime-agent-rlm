import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys.js";
import { ProbeBus } from "./probe-bus.js";
import { StdinBuffer } from "./stdin-buffer.js";
import { setDefaultTerminalColors } from "./terminal-colors.js";
import { drainKittyImageTransmits, getCapabilities, invalidateKittyImageTransmits } from "./terminal-image.js";
import { isGrapheme2027Active, setGrapheme2027Active } from "./utils.js";

const cjsRequire = createRequire(import.meta.url);

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0;\x07";

// ?1002 first: a terminal that lacks ?1003 keeps clicks, wheel and drags; one that has it takes the next mode over.
const MOUSE_TRACKING_ON = "\x1b[?1002h\x1b[?1003h\x1b[?1006h";
const MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1002l";

// Kitty keyboard protocol mode-stack operations. The pushed flags are
// 1 (disambiguate escape codes) | 2 (report event types) | 4 (report alternate
// keys); the base layout key keeps shortcuts working on non-Latin layouts.
// The stack is per-screen: the main and alternate screens each have their own,
// so entering the alt screen requires a fresh push there.
const KITTY_FLAGS_PUSH = "\x1b[>7u";
const KITTY_FLAGS_POP = "\x1b[<u";

// Which screen each outstanding kitty stack entry was pushed on. Every pop must
// target a screen that owns an entry: popping the wrong screen leaks the real
// entry (kitty mode stays enabled in the shell after exit, and Ctrl+C stops
// raising SIGINT), while pushing twice on one screen leaves an unpopped extra.
// Module-level because a preserved alt screen hands its stack state to the next
// ProcessTerminal instance.
let kittyMainScreenPushOutstanding = false;
let kittyAltScreenPushOutstanding = false;

// A preserved alternate screen is adopted by the next ProcessTerminal during in-process handoff.
let pendingAltScreenHandoff: symbol | undefined;

// Whether the terminal is physically in the alternate screen, independent of
// which ProcessTerminal instance (if any) currently owns that fact: true from
// enterAltScreen until releaseAltScreen or the exit guard writes ?1049l, and
// across a preserved handoff - including after the successor's constructor
// has consumed the token but before its start() arms the successor's guard.
// The exit guard reads this instead of only the handoff token: in that
// constructor -> start() window the token is already consumed while the alt
// screen is still live, and the predecessor's guard must still restore it.
let altScreenLiveInTerminal = false;

interface PendingInputHandoff {
	token: symbol;
	wasRaw: boolean;
	discardHandler: (data: string) => void;
}

// Keep stdin raw and drain input while a preserved fullscreen frame waits for
// the next in-process TUI. Worker-backed session attach can make this handoff
// noticeably longer; restoring cooked mode during the gap makes arrow escape
// sequences echo into the preserved frame.
let pendingInputHandoff: PendingInputHandoff | undefined;

// Input that arrived during a preserved handoff window, captured instead of
// discarded (w13 QA finding 4: a paste in the switch window used to vanish,
// and its unread tail could reach the shell). Bounded; overflow is dropped and
// flagged so a caller can tell a partial capture from a complete one.
const HANDOFF_INPUT_BUFFER_CAP = 64 * 1024;
let handoffInputBuffer: { text: string; truncated: boolean } | undefined;

/**
 * Take the input buffered during the current (or most recent) preserved
 * handoff window, clearing it. Raw keystrokes stay discarded for safety; the
 * point is that pasted text is recoverable. Returns undefined when nothing
 * was captured.
 */
export function takePendingHandoffInput(): { text: string; truncated: boolean } | undefined {
	const buffered = handoffInputBuffer;
	handoffInputBuffer = undefined;
	return buffered;
}

function resetHandoffInputBuffer(): void {
	handoffInputBuffer = undefined;
}

function appendHandoffInput(data: string): void {
	const current = handoffInputBuffer ?? { text: "", truncated: false };
	if (current.text.length >= HANDOFF_INPUT_BUFFER_CAP) {
		current.truncated = true;
	} else {
		const room = HANDOFF_INPUT_BUFFER_CAP - current.text.length;
		current.text += room >= data.length ? data : data.slice(0, room);
		if (room < data.length) current.truncated = true;
	}
	handoffInputBuffer = current;
}

// Discard whatever still sits in the kernel's tty input queue, so a crash
// during a handoff window cannot hand a half-delivered paste to the shell once
// cooked mode returns (the observed worst case: pasted lines executing in
// zsh). Only attempted with evidence input was in flight (the handoff buffer
// is non-empty) and only on a tty whose fd libuv made non-blocking, so the
// read cannot stall a healthy exit. Overridable for tests.
type KernelInputDiscarder = () => void;
let kernelInputDiscarder: KernelInputDiscarder = discardPendingKernelInput;

/**
 * Best-effort synchronous drain of the tty input queue: reads and discards
 * until the non-blocking fd reports EAGAIN or a cap is hit. Never throws into
 * the exit path.
 */
function discardPendingKernelInput(): void {
	if (!process.stdin.isTTY) return;
	const chunk = Buffer.alloc(4096);
	for (let reads = 0; reads < 64; reads += 1) {
		try {
			const read = fs.readSync(0, chunk, 0, chunk.length, null);
			if (read <= 0) return;
		} catch {
			// EAGAIN (queue empty) or a dead fd: nothing left to drain.
			return;
		}
	}
}

/** Test seam for the exit-path kernel drain (see kernelInputDiscarder). */
export function setKernelInputDiscarderForTests(discard: KernelInputDiscarder): () => void {
	kernelInputDiscarder = discard;
	return () => {
		kernelInputDiscarder = discardPendingKernelInput;
	};
}

/** Evidence-gated kernel drain: only when the handoff buffer shows input was arriving. */
function drainKernelInputAfterHandoffActivity(): void {
	if (handoffInputBuffer === undefined || handoffInputBuffer.text.length === 0) return;
	try {
		kernelInputDiscarder();
	} catch {
		// A failed drain must never break the exit restore around it.
	}
}

function consumeAltScreenHandoff(): boolean {
	if (!pendingAltScreenHandoff) {
		return false;
	}
	pendingAltScreenHandoff = undefined;
	return true;
}

function beginInputHandoff(token: symbol, wasRaw: boolean): void {
	const inheritedWasRaw = pendingInputHandoff?.wasRaw ?? wasRaw;
	if (pendingInputHandoff) {
		process.stdin.removeListener("data", pendingInputHandoff.discardHandler);
	}
	// A new handoff window starts with a fresh capture: stale buffered input
	// nobody took must not masquerade as this window's paste.
	resetHandoffInputBuffer();
	const discardHandler = (data: string) => {
		appendHandoffInput(data);
	};
	pendingInputHandoff = { token, wasRaw: inheritedWasRaw, discardHandler };
	process.stdin.on("data", discardHandler);
	process.stdin.resume();
}

function consumeInputHandoff(): boolean | undefined {
	const handoff = pendingInputHandoff;
	if (!handoff) {
		return undefined;
	}
	process.stdin.removeListener("data", handoff.discardHandler);
	pendingInputHandoff = undefined;
	// The buffered input outlives the handler: the successor's start() has
	// consumed the handoff, but the app still takes the capture right after.
	return handoff.wasRaw;
}

function cancelInputHandoff(token: symbol): void {
	const handoff = pendingInputHandoff;
	if (!handoff || handoff.token !== token) {
		return;
	}
	process.stdin.removeListener("data", handoff.discardHandler);
	pendingInputHandoff = undefined;
	// No successor will take the capture; anything still unread in the kernel
	// queue must not survive into cooked mode.
	drainKernelInputAfterHandoffActivity();
	resetHandoffInputBuffer();
	process.stdin.pause();
	if (process.stdin.setRawMode) {
		process.stdin.setRawMode(handoff.wasRaw);
	}
}

// The exit guard armed by the running ProcessTerminal (R5-M5). Module-level so
// a preserved handoff keeps exactly one guard armed: the next instance's
// start() replaces the predecessor's guard instead of stacking a second one,
// and a crash anywhere in the handoff gap - before or after the successor's
// constructor consumed the token, up to its start() - is still covered by the
// old one (see altScreenLiveInTerminal).
let armedExitGuard: (() => void) | undefined;

// Early raw mode: the interactive CLI engages raw mode as soon as it knows the
// TUI will run, long before ProcessTerminal.start() (daemon handshake, session
// load and theme setup sit between). A tty still in cooked mode ICRNL-mangles a
// queued Enter (CR -> LF), and LF is the editor's insert-newline key, so the
// keystroke visibly does nothing. Raw mode is set without resuming stdin: the
// bytes keep buffering in the kernel, untranslated, until start() reads them.
let earlyRawMode: { wasRaw: boolean } | undefined;

const restoreEarlyRawModeOnExit = (): void => {
	if (!earlyRawMode) {
		return;
	}
	const { wasRaw } = earlyRawMode;
	earlyRawMode = undefined;
	try {
		process.stdin.setRawMode?.(wasRaw);
	} catch {
		// The terminal is already gone; nothing left to restore.
	}
};

export function engageEarlyRawMode(): void {
	if (earlyRawMode) {
		return;
	}
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
		return;
	}
	const wasRaw = process.stdin.isRaw ?? false;
	if (wasRaw) {
		// Already raw: there is no cooked window to close.
		return;
	}
	earlyRawMode = { wasRaw };
	process.stdin.setRawMode(true);
	process.once("exit", restoreEarlyRawModeOnExit);
}

/** Restore the tty when the process exits before any ProcessTerminal adopted it. Exported for tests. */
export function releaseEarlyRawMode(): void {
	process.removeListener("exit", restoreEarlyRawModeOnExit);
	restoreEarlyRawModeOnExit();
}

function consumeEarlyRawMode(): boolean | undefined {
	if (!earlyRawMode) {
		return undefined;
	}
	const { wasRaw } = earlyRawMode;
	earlyRawMode = undefined;
	process.removeListener("exit", restoreEarlyRawModeOnExit);
	return wasRaw;
}

/**
 * Join StdinBuffer paste parts back into bracketed-paste input strings.
 * The byte cap splits a large paste into parts; forwarding each part as its
 * own bracketed paste makes the editor create one `[paste #N]` marker per part
 * of the same paste. Non-final parts are buffered here, the closing part
 * completes the bracket, and `reset` (a `pasteabort` event) drops a partial
 * paste instead of delivering it.
 */
export function createPastePartJoiner(): {
	/** Bracketed-paste input to forward, or null while buffering a non-final part. */
	wrap: (content: string, moreParts: boolean) => string | null;
	reset: () => void;
} {
	let pending = "";
	return {
		wrap(content: string, moreParts: boolean): string | null {
			if (moreParts) {
				pending += content;
				return null;
			}
			const full = pending + content;
			pending = "";
			return `\x1b[200~${full}\x1b[201~`;
		},
		reset(): void {
			pending = "";
		},
	};
}

/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void): void;

	// Stop the terminal and restore state
	stop(options?: TerminalStopOptions): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections. Also waits out the
	 * capability-probe window (bounded by maxMs): a settled probe bus proves the
	 * terminal owes no more probe answers, so none can arrive after stop() hands
	 * the tty to the shell, a suspended session's foreground process, or an
	 * external editor. Callers that yield the terminal (exit, suspend, $EDITOR)
	 * should drain first.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	/**
	 * Drop in-flight stdin (including unterminated bracketed paste) without
	 * emitting paste or leftover keys. Used on session switch and shutdown drain.
	 */
	abortPendingInput(): void;

	// Write output to terminal
	write(data: string): void;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	/**
	 * Startup capability probes (docs/fork/probe-bus-design.md). Undefined on
	 * terminals that do not probe (test doubles, minimal implementations).
	 */
	readonly probeBus?: ProbeBus;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Alternate screen buffer. The primary screen (and its scrollback) is left
	// untouched while the alt screen is active, so a full-screen view can be
	// shown and dismissed without disturbing the transcript history.
	enterAltScreen(): void;
	leaveAltScreen(): void;
	get altScreenActive(): boolean;

	// SGR mouse tracking (?1003 + ?1006). ?1003 reports every pointer move, not
	// only drags, so components can react to hover. Any mouse reporting already
	// takes native drag-selection from the terminal; selecting stays in-app.
	setMouseTracking(enabled: boolean): void;
	get mouseTrackingActive(): boolean;

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;
}

export interface TerminalStopOptions {
	preserveAltScreen?: boolean;
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private started = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private _grapheme2027Active = false;
	private readonly altScreenHandoffToken = Symbol("altScreenHandoff");
	private _altScreenActive = consumeAltScreenHandoff();
	private _mouseTrackingActive = false;
	// Set once the terminal is being drained for exit: reporting stays off however the UI asks.
	private mouseTrackingSuspended = false;
	// A supported 2027 verdict that arrived while the alt screen was active: the
	// mode-set is main-screen-only, so leaveAltScreen owes it a re-send (R5-M6).
	private grapheme2027PendingMainScreen = false;
	// The exit guard this instance armed (armExitGuard); the module slot may
	// already point at a successor's guard.
	private ownExitGuard?: () => void;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private _probeBus?: ProbeBus;
	private progressInterval?: ReturnType<typeof setInterval>;
	private writeLogPath = (() => {
		const env = process.env.PI_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		return env;
	})();

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get probeBus(): ProbeBus | undefined {
		return this._probeBus;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.started = true;
		this.mouseTrackingSuspended = false;
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// Save previous state and enable raw mode. An early-engaged raw mode (see
		// engageEarlyRawMode) already made the tty raw, so isRaw would answer true;
		// the mode to restore on stop is the pre-engage one, not that.
		this.wasRaw = consumeInputHandoff() ?? consumeEarlyRawMode() ?? process.stdin.isRaw ?? false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();
		// From here the tty is this process's to restore: a crash must not leave
		// raw/alt/kitty/2027/bracketed-paste/mouse behind (R5-M5).
		this.armExitGuard();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only.
		if (process.platform !== "win32") {
			process.kill(process.pid, "SIGWINCH");
		}

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Probe terminal capabilities (Kitty keyboard, DECRQM 2026/2027, OSC 10/11
		// default colors, cell size) through the probe bus; the primary-DA fence
		// judges whatever stays unanswered. See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.startProbeBus();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Probe answers are routed to the probe bus here (after StdinBuffer parsing,
	 * so an answer split across multiple stdin events is reassembled first);
	 * everything else goes to the input handler.
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({ timeout: 10 });

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			if (this._probeBus?.handleSequence(sequence)) {
				return;
			}

			if (this.inputHandler) {
				this.inputHandler(sequence);
			}
		});

		// Re-wrap paste content with bracketed paste markers for existing editor
		// handling. A paste split into parts by the byte cap is joined back into
		// one bracketed paste so the editor creates a single paste marker.
		const pasteJoiner = createPastePartJoiner();
		this.stdinBuffer.on("paste", (content, moreParts) => {
			const wrapped = pasteJoiner.wrap(content, moreParts);
			if (wrapped !== null && this.inputHandler) {
				this.inputHandler(wrapped);
			}
		});
		this.stdinBuffer.on("pasteabort", () => {
			pasteJoiner.reset();
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Probe the terminal's capabilities through a fresh ProbeBus: listeners are
	 * registered first (env overrides fire synchronously out of start()), then
	 * every query goes out in one burst with the primary-DA fence last. An
	 * unanswered capability is judged at the fence (or by the bus's fallback
	 * timer), not by per-probe wall-clock timers.
	 */
	private startProbeBus(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);

		const bus = new ProbeBus();
		this._probeBus = bus;
		bus.onChange("kittyKeyboard", (_cap, state) => {
			if (state.verdict === "supported") {
				this.enableKittyProtocol();
				return;
			}
			// Judged unsupported (DA fence) or unknown (fallback timer): enable
			// xterm modifyOtherKeys mode 2. This is needed for tmux, which can
			// forward modified enter keys as CSI-u when extended-keys is enabled,
			// but may not answer the Kitty protocol query.
			if (!this._kittyProtocolActive && !this._modifyOtherKeysActive) {
				process.stdout.write("\x1b[>4;2m");
				this._modifyOtherKeysActive = true;
			}
		});
		bus.onChange("oscColors", (_cap, state) => {
			if (state.verdict === "supported" && state.defaultColors) {
				setDefaultTerminalColors(state.defaultColors);
				this.resizeHandler?.();
			}
		});
		bus.onChange("grapheme2027", (_cap, state) => {
			if (state.verdict === "supported") {
				this.enableGrapheme2027();
			}
		});
		bus.start((data) => process.stdout.write(data), {
			queryOscColors: process.stdin.isTTY === true && process.stdout.isTTY === true,
			queryCellSize: getCapabilities().images !== null,
		});
	}

	private enableKittyProtocol(): void {
		if (this._kittyProtocolActive) {
			return;
		}
		this._kittyProtocolActive = true;
		setKittyProtocolActive(true);

		// Push onto the stack of whichever screen is active right now; the other
		// screen's stack gets its entry on the next screen switch. A leftover
		// entry from an unclean previous session (mark still set) is adopted
		// instead of double-pushed.
		if (this._altScreenActive) {
			if (!kittyAltScreenPushOutstanding) {
				kittyAltScreenPushOutstanding = true;
				process.stdout.write(KITTY_FLAGS_PUSH);
			}
		} else if (!kittyMainScreenPushOutstanding) {
			kittyMainScreenPushOutstanding = true;
			process.stdout.write(KITTY_FLAGS_PUSH);
		}
	}

	/**
	 * DECSET 2027 (grapheme cluster mode). Only a definitive "supported" verdict
	 * enables it: kitty refuses the mode outright (kitty#7799), and both of its
	 * evasion shapes - a Pv=0 answer, or silence past the DA fence - converge on
	 * not enabling (docs/fork/probe-bus-design.md §3.2). Main screen only: the
	 * mode's per-screen semantics are unverified (same caveat as the kitty
	 * keyboard stack once had), so while the alt screen is active the mode-set
	 * could land on the wrong screen. Fullscreen sessions are on the alt screen
	 * by the time the probe answer arrives, so the send is not dropped but owed
	 * to the return to the main screen (R5-M6).
	 */
	private enableGrapheme2027(): void {
		if (this._grapheme2027Active) {
			return;
		}
		if (this._altScreenActive) {
			this.grapheme2027PendingMainScreen = true;
			return;
		}
		this._grapheme2027Active = true;
		this.grapheme2027PendingMainScreen = false;
		setGrapheme2027Active(true);
		process.stdout.write("\x1b[?2027h");
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			// Dynamic require to avoid bundling koffi's 74MB of cross-platform
			// native binaries into every compiled binary. Koffi is only needed
			// on Windows for VT input support.
			const koffi = cjsRequire("koffi");
			const k32 = koffi.load("kernel32.dll");
			const GetStdHandle = k32.func("void* __stdcall GetStdHandle(int)");
			const GetConsoleMode = k32.func("bool __stdcall GetConsoleMode(void*, _Out_ uint32_t*)");
			const SetConsoleMode = k32.func("bool __stdcall SetConsoleMode(void*, uint32_t)");

			const STD_INPUT_HANDLE = -10;
			const ENABLE_VIRTUAL_TERMINAL_INPUT = 0x0200;
			const handle = GetStdHandle(STD_INPUT_HANDLE);
			const mode = new Uint32Array(1);
			GetConsoleMode(handle, mode);
			SetConsoleMode(handle, mode[0]! | ENABLE_VIRTUAL_TERMINAL_INPUT);
		} catch {
			// koffi not available — Shift+Tab won't be distinguishable from Tab
		}
	}

	abortPendingInput(): void {
		this.stdinBuffer?.clear();
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		this.abortPendingInput();
		// Like Kitty below, stop the source first: a pointer still moving would refresh
		// the idle clock until maxMs, and reports still on their way would reach the shell.
		if (this._mouseTrackingActive) {
			process.stdout.write(MOUSE_TRACKING_OFF);
			this._mouseTrackingActive = false;
		}
		this.mouseTrackingSuspended = true;
		if (this._kittyProtocolActive) {
			// Disable Kitty keyboard protocol first so any late key releases
			// do not generate new Kitty escape sequences. Pop only the entry the
			// currently active screen actually owns; the other screen's entry is
			// popped by releaseAltScreen()/stop().
			if (this.popKittyFlagsOnActiveScreen()) {
				process.stdout.write(KITTY_FLAGS_POP);
			}
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		if (this._modifyOtherKeysActive) {
			process.stdout.write("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			// Wait out the capability-probe window before the idle drain: a settled
			// bus (DA fence, fallback timer, or dispose) proves the terminal owes no
			// more probe answers, so none can arrive after stop() and leak into the
			// shell prompt, a suspended session's foreground process, or an external
			// editor. The wait shares the drain's maxMs budget, and an already-settled
			// bus resolves immediately, so a long-running session pays nothing here.
			if (this._probeBus) {
				const settleBudget = endTime - Date.now();
				if (settleBudget > 0) {
					let settleCap: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							this._probeBus.settled,
							new Promise<void>((resolve) => {
								settleCap = setTimeout(resolve, settleBudget);
							}),
						]);
					} finally {
						if (settleCap) {
							clearTimeout(settleCap);
						}
					}
				}
			}

			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.abortPendingInput();
			this.inputHandler = previousHandler;
		}
	}

	stop(options: TerminalStopOptions = {}): void {
		const wasStarted = this.started;
		this.started = false;
		// The session is ending: no new per-screen entries from here on, so a
		// releaseAltScreen() below never re-pushes the main screen mid-teardown.
		// Outstanding entries are still popped by the mark-driven section below.
		this._kittyProtocolActive = false;
		setKittyProtocolActive(false);
		this._probeBus?.dispose();
		this._probeBus = undefined;

		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}

		if (this._mouseTrackingActive) {
			process.stdout.write(MOUSE_TRACKING_OFF);
			this._mouseTrackingActive = false;
		}
		// A preserved handoff keeps the tty configured for the next in-process
		// TUI, so its guard stays armed (the next start() replaces it); every
		// other stop restores below, making the guard dead weight at exit.
		if (!(options.preserveAltScreen && wasStarted)) {
			this.disarmExitGuard();
		}
		this.mouseTrackingSuspended = false;
		// The session is ending: a 2027 verdict still owed to the main screen
		// would only be reset again a few lines below.
		this.grapheme2027PendingMainScreen = false;
		if (this._altScreenActive) {
			if (options.preserveAltScreen) {
				pendingAltScreenHandoff = this.altScreenHandoffToken;
				this._altScreenActive = false;
			} else {
				this.releaseAltScreen();
			}
		} else if (!options.preserveAltScreen) {
			this.releaseAltScreen();
		}

		// Disable bracketed paste mode
		process.stdout.write("\x1b[?2004l");

		// Reset grapheme cluster mode on the main screen. Skipped for a preserved
		// alt screen: the mode-set would land on the still-active alt screen, and
		// the main-screen mode deliberately survives the handoff (the next
		// in-process terminal re-probes anyway). The module bit is the source of
		// truth so a terminal that inherited the mode still resets it on exit.
		if (isGrapheme2027Active() && !options.preserveAltScreen) {
			process.stdout.write("\x1b[?2027l");
			this._grapheme2027Active = false;
			setGrapheme2027Active(false);
		}

		// Pop the kitty entry the currently active screen owns. This is mark-driven
		// rather than flag-driven: drainInput() may already have popped the other
		// screen and cleared the active flag, and dropping the remaining entry
		// would leave the protocol enabled in the shell (Ctrl+C arrives as a CSI-u
		// sequence instead of SIGINT).
		if (this.popKittyFlagsOnActiveScreen()) {
			process.stdout.write(KITTY_FLAGS_POP);
		}
		if (this._modifyOtherKeysActive) {
			process.stdout.write("\x1b[>4;0m");
			this._modifyOtherKeysActive = false;
		}

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		if (options.preserveAltScreen && wasStarted) {
			beginInputHandoff(this.altScreenHandoffToken, this.wasRaw);
		} else {
			// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
			// re-interpreted after raw mode is disabled. This fixes a race condition
			// where Ctrl+D could close the parent shell over SSH.
			process.stdin.pause();

			// Restore raw mode state
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(this.wasRaw);
			}
		}
	}

	write(data: string): void {
		// Kitty placeholder images upload once per screen generation (see
		// terminal-image.ts); the transmit must reach the terminal before the
		// placeholder cells that reference it, so flush it ahead of every write.
		const transmits = drainKittyImageTransmits();
		const out = transmits === "" ? data : transmits + data;
		process.stdout.write(out);
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, out, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	get columns(): number {
		// COLUMNS/LINES only apply to a real terminal: behind a pipe they are a
		// stale export from the parent shell and must not override the default.
		return process.stdout.columns || (process.stdout.isTTY ? Number(process.env.COLUMNS) : 0) || 80;
	}

	get rows(): number {
		return process.stdout.rows || (process.stdout.isTTY ? Number(process.env.LINES) : 0) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	enterAltScreen(): void {
		// The alt screen keeps its own kitty image storage; placeholder
		// transmits made on the main screen do not carry over.
		invalidateKittyImageTransmits();
		if (this._altScreenActive) return;
		altScreenLiveInTerminal = true;
		if (this.ownsPendingAltScreenHandoff()) {
			pendingAltScreenHandoff = undefined;
			this._altScreenActive = true;
			return;
		}
		this._altScreenActive = true;
		this.write("\x1b[?1049h");
		// The alt screen's keyboard mode stack is independent of the main screen's,
		// so the startup push does not reach fullscreen; re-push on the alt stack.
		if (this._kittyProtocolActive && !kittyAltScreenPushOutstanding) {
			kittyAltScreenPushOutstanding = true;
			this.write(KITTY_FLAGS_PUSH);
		}
	}

	leaveAltScreen(): void {
		this.releaseAltScreen();
	}

	private releaseAltScreen(): void {
		const ownsPendingHandoff = this.ownsPendingAltScreenHandoff();
		if (!this._altScreenActive && !ownsPendingHandoff) return;
		this._altScreenActive = false;
		altScreenLiveInTerminal = false;
		// Back on the main screen, alt-screen placeholder transmits are gone.
		invalidateKittyImageTransmits();
		if (ownsPendingHandoff) {
			pendingAltScreenHandoff = undefined;
			cancelInputHandoff(this.altScreenHandoffToken);
		}
		// Pop while the alt screen is still active; after ?1049l the pop would eat
		// the main screen stack entry pushed at startup.
		if (kittyAltScreenPushOutstanding) {
			kittyAltScreenPushOutstanding = false;
			this.write(KITTY_FLAGS_POP);
		}
		this.write("\x1b[?1049l");
		// A kitty verdict that arrived while the alt screen was active pushed only
		// the alt stack; without an entry of its own the main screen keeps the
		// protocol off and Alt-modified keys stay dead there.
		if (this._kittyProtocolActive && !kittyMainScreenPushOutstanding) {
			kittyMainScreenPushOutstanding = true;
			this.write(KITTY_FLAGS_PUSH);
		}
		// Same shape for grapheme 2027 (R5-M6): a supported verdict that arrived
		// on the alt screen was deferred, and the main screen is owed the
		// mode-set now that it is active again.
		if (this.grapheme2027PendingMainScreen) {
			this.enableGrapheme2027();
		}
	}

	/**
	 * Clear the outstanding-entry mark of whichever screen is currently active
	 * and report whether a pop is owed there. The alt screen counts as active
	 * while it is live in the terminal, including a preserved handoff.
	 */
	private popKittyFlagsOnActiveScreen(): boolean {
		if (this._altScreenActive || this.ownsPendingAltScreenHandoff()) {
			if (!kittyAltScreenPushOutstanding) return false;
			kittyAltScreenPushOutstanding = false;
			return true;
		}
		if (!kittyMainScreenPushOutstanding) return false;
		kittyMainScreenPushOutstanding = false;
		return true;
	}

	get altScreenActive(): boolean {
		return this._altScreenActive;
	}

	private ownsPendingAltScreenHandoff(): boolean {
		return pendingAltScreenHandoff === this.altScreenHandoffToken;
	}

	setMouseTracking(enabled: boolean): void {
		if (enabled && this.mouseTrackingSuspended) return;
		if (enabled === this._mouseTrackingActive) return;
		this._mouseTrackingActive = enabled;
		// ?1003 (any-event tracking) reports drags for in-app selection and, since
		// hover, plain moves too. Off also clears ?1002 in case an older run left it set.
		this.write(enabled ? MOUSE_TRACKING_ON : MOUSE_TRACKING_OFF);
	}

	// A process that dies without stop() (uncaught exception, process.exit) must
	// not leave the tty half-configured: raw mode stays on (the shell echoes
	// nothing), the alt screen keeps the scrollback hostage, a kitty stack entry
	// leaks (Ctrl+C stops raising SIGINT), and 2027/bracketed-paste/mouse keep
	// reporting into the prompt. One guard restores whatever is outstanding at
	// exit time, reading the module kitty marks and the live handoff state
	// rather than instance flags a stop() may already have cleared.
	private armExitGuard(): void {
		this.disarmExitGuard();
		// A preserved handoff's guard still belongs to the previous instance;
		// this instance owns the tty now, so replace it rather than stack.
		if (armedExitGuard) {
			process.removeListener("exit", armedExitGuard);
			armedExitGuard = undefined;
		}
		const guard = () => {
			try {
				// Pop the kitty entry while its owning screen is still active:
				// popped after ?1049l, an alt-screen entry would eat the main
				// stack's entry instead. The physical alt-screen flag covers the
				// successor's constructor -> start() window, where the handoff
				// token is consumed but the alt screen is still live.
				const altLive = this._altScreenActive || pendingAltScreenHandoff !== undefined || altScreenLiveInTerminal;
				if (altLive && kittyAltScreenPushOutstanding) {
					kittyAltScreenPushOutstanding = false;
					process.stdout.write(KITTY_FLAGS_POP);
				}
				if (altLive) {
					pendingAltScreenHandoff = undefined;
					altScreenLiveInTerminal = false;
					process.stdout.write("\x1b[?1049l");
				}
				if (kittyMainScreenPushOutstanding) {
					kittyMainScreenPushOutstanding = false;
					process.stdout.write(KITTY_FLAGS_POP);
				}
				if (this._modifyOtherKeysActive) {
					process.stdout.write("\x1b[>4;0m");
				}
				if (this._mouseTrackingActive) {
					process.stdout.write(MOUSE_TRACKING_OFF);
				}
				if (isGrapheme2027Active()) {
					process.stdout.write("\x1b[?2027l");
					setGrapheme2027Active(false);
				}
				// Bracketed paste is enabled unconditionally in start().
				process.stdout.write("\x1b[?2004l");
			} catch {
				// The terminal is already gone; nothing left to restore.
			}
			try {
				// A crash mid-handoff can leave the tail of a paste unread in the
				// kernel's input queue; restoring cooked mode would hand those
				// bytes to the shell line by line. Drain them first, gated on the
				// handoff buffer proving input was in flight.
				drainKernelInputAfterHandoffActivity();
				process.stdin.setRawMode?.(pendingInputHandoff?.wasRaw ?? this.wasRaw);
			} catch {
				// The terminal is already gone; nothing left to restore.
			}
		};
		this.ownExitGuard = guard;
		armedExitGuard = guard;
		process.on("exit", guard);
	}

	private disarmExitGuard(): void {
		// Ownership check: another instance may have replaced this guard during a
		// handoff; disarming must never strip a guard that is not this one's.
		if (this.ownExitGuard && armedExitGuard === this.ownExitGuard) {
			process.removeListener("exit", this.ownExitGuard);
			armedExitGuard = undefined;
		}
		this.ownExitGuard = undefined;
	}

	get mouseTrackingActive(): boolean {
		return this._mouseTrackingActive;
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title. A title carrying BEL or ESC
		// (a persisted session name is untrusted text) would terminate the sequence
		// early and inject escapes into the terminal; replace control characters.
		const safeTitle = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
		process.stdout.write(`\x1b]0;${safeTitle}\x07`);
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
