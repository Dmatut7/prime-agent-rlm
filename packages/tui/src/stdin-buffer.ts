/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/**
 * Length at or above which a printable run is delivered as one bulk sequence.
 * Shorter runs stay one character per sequence so typing keeps per-key events.
 */
export const BULK_TEXT_MIN_RUN = 32;

/** Upper bound on the length of a single bulk text sequence. */
export const BULK_TEXT_MAX_SEQUENCE = 64 * 1024;

/**
 * Check if a string is a complete escape sequence or needs more data
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	if (afterEsc.startsWith("[")) {
		if (afterEsc.startsWith("[M")) {
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	if (afterEsc.startsWith("O")) {
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	if (afterEsc.length === 1) {
		return "complete";
	}

	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		if (payload.startsWith("<")) {
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			if (lastChar === "M" || lastChar === "m") {
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

/**
 * Deliver text as sequences. Short runs stay one character per sequence (typing
 * must remain per-key); long runs are bulk input - a paste from a terminal
 * without bracketed paste, the tail of an oversized paste, or a pipe - and are
 * delivered as a few large sequences so the consumer inserts them in one pass
 * instead of re-copying the whole line once per character.
 *
 * Newlines belong to a long run: a multi-line paste inserted line by line makes
 * the consumer rebuild its whole text per line. A leading newline still goes out
 * on its own, so a bulk sequence never starts with one (consumers treat a
 * sequence that starts with a newline as a single newline key).
 */
function pushTextRun(sequences: string[], run: string): void {
	if (run.length < BULK_TEXT_MIN_RUN) {
		for (let i = 0; i < run.length; i++) {
			sequences.push(run[i]!);
		}
		return;
	}
	let start = 0;
	while (start < run.length && run[start] === "\n") {
		sequences.push("\n");
		start++;
	}
	for (let i = start; i < run.length; i += BULK_TEXT_MAX_SEQUENCE) {
		sequences.push(run.slice(i, i + BULK_TEXT_MAX_SEQUENCE));
	}
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		if (buffer[pos] === ESC) {
			// Two ESC bytes in a row are two Escape keys, not ctrl+alt+[.
			// Consume only the first byte so the next loop can parse ESC[A as CSI.
			// A lone second ESC stays incomplete and flushes as Escape after timeout.
			if (buffer[pos + 1] === ESC) {
				sequences.push(ESC);
				pos += 1;
				continue;
			}
			let seqEnd = pos + 1;
			let emitted = false;
			while (seqEnd <= buffer.length) {
				const candidate = buffer.slice(pos, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "incomplete") {
					seqEnd++;
					continue;
				}
				sequences.push(candidate);
				pos = seqEnd;
				emitted = true;
				break;
			}

			if (!emitted) {
				return { sequences, remainder: buffer.slice(pos) };
			}
		} else {
			// Batch printable runs: locate the next ESC in one pass and slice the
			// run once. Slicing the remainder per character made bulk input
			// (e.g. large non-bracketed pastes) quadratic.
			let runEnd = buffer.indexOf(ESC, pos + 1);
			if (runEnd === -1) {
				runEnd = buffer.length;
			}
			const run = buffer.slice(pos, runEnd);
			// Control bytes carry key semantics, so they stay one sequence each
			// (newlines are handled inside `pushTextRun`: part of text in a long
			// run, their own sequence in a short one).
			let textStart = 0;
			for (let i = 0; i < run.length; i++) {
				const code = run.charCodeAt(i);
				if (code >= 32 || code === 10) {
					continue;
				}
				if (i > textStart) {
					pushTextRun(sequences, run.slice(textStart, i));
				}
				sequences.push(run[i]!);
				textStart = i + 1;
			}
			if (textStart < run.length) {
				pushTextRun(sequences, run.slice(textStart));
			}
			pos = runEnd;
		}
	}

	return { sequences, remainder: "" };
}

export const PASTE_TIMEOUT_MS = 30_000;
export const PASTE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Idle time after the last paste byte before the paste is closed (default: 20ms).
 * The terminator is indistinguishable from an end marker inside the pasted bytes,
 * so only a quiet stream says the paste is over; everything received up to that
 * point is delivered as paste text.
 */
export const PASTE_SETTLE_MS = 20;

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for sequence completion (default: 10ms)
	 * After this time, the buffer is flushed even if incomplete
	 */
	timeout?: number;
	/**
	 * Idle time without stdin chunks to wait for `201~` after entering paste mode
	 * when no end marker has been seen at all. Missing terminator emits the buffer
	 * as one atomic paste.
	 */
	pasteTimeoutMs?: number;
	/**
	 * Maximum UTF-8 byte length of one paste part. Reaching it emits the bytes
	 * received so far as a paste event and keeps paste mode open, so the rest of
	 * the paste is still delivered as paste text instead of key input.
	 */
	pasteMaxBytes?: number;
	/**
	 * Idle time after the last paste byte before the paste is closed (default:
	 * 20ms). An end marker inside the pasted bytes looks exactly like the
	 * terminator, so the paste ends when its stream goes quiet rather than at the
	 * first marker; bytes received up to then are delivered as paste text.
	 */
	pasteSettleMs?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Proper prefixes of the paste end marker (`\x1b[201~`). A window tail matching
 * this can still grow into the marker in a later chunk, so it must be rescanned
 * on append.
 */
const PARTIAL_PASTE_MARKER_REGEX = /^\x1b(\[(2(01?)?)?)?$/;

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private pasteWatchdog: ReturnType<typeof setTimeout> | null = null;
	private pasteSettleTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private readonly pasteTimeoutMs: number;
	private readonly pasteMaxBytes: number;
	private readonly pasteSettleMs: number;
	private pasteMode: boolean = false;
	// Paste content is kept as chunks and joined once on completion. Each
	// append only scans the new chunk plus `pastePending` (a trailing partial
	// marker carried across the chunk boundary). Accumulating into one string
	// and rescanning it per chunk was quadratic: every `+=` plus indexOf/regex
	// re-flattened and re-walked the whole paste.
	private pasteChunks: string[] = [];
	private pasteBufferBytes: number = 0;
	private pastePending: string = "";
	/** An end marker was seen; the paste closes once the stream goes quiet. */
	private pasteTerminated: boolean = false;
	private pendingKittyPrintableCodepoint: number | undefined;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? 10;
		this.pasteTimeoutMs = options.pasteTimeoutMs ?? PASTE_TIMEOUT_MS;
		this.pasteMaxBytes = options.pasteMaxBytes ?? PASTE_MAX_BYTES;
		this.pasteSettleMs = options.pasteSettleMs ?? PASTE_SETTLE_MS;
	}

	public process(data: string | Buffer): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}

		if (this.pasteMode) {
			// Ctrl+C is the user's own interrupt: the terminal sends it for the key,
			// and it is the one way out of a paste whose end marker never arrives.
			// Everything else that arrives while a paste is open is a byte of that
			// paste - a bracketed paste carries no escaping, so its content cannot
			// be told apart from input the terminal means as keys.
			const interruptAt = str.indexOf("\x03");
			if (interruptAt !== -1) {
				this.discardPasteMode();
				this.emitDataSequence("\x03");
				const remaining = str.slice(interruptAt + 1);
				if (remaining.length > 0) {
					this.process(remaining);
				}
				return;
			}
		}

		this.buffer += str;

		if (this.pasteMode) {
			const chunk = this.buffer;
			this.buffer = "";
			this.appendPasteChunk(chunk);
			return;
		}

		const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
		if (startIndex !== -1) {
			if (startIndex > 0) {
				const beforePaste = this.buffer.slice(0, startIndex);
				const result = extractCompleteSequences(beforePaste);
				for (const sequence of result.sequences) {
					this.emitDataSequence(sequence);
				}
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.resetPasteState();
			const initialContent = this.buffer;
			this.buffer = "";
			this.appendPasteChunk(initialContent);
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}

		if (this.buffer.length > 0) {
			this.timeout = setTimeout(() => {
				const flushed = this.flush();

				for (const sequence of flushed) {
					this.emitDataSequence(sequence);
				}
			}, this.timeoutMs);
		}
	}

	private appendPasteChunk(chunk: string): void {
		if (chunk.length > 0) {
			this.pasteChunks.push(chunk);
			this.pasteBufferBytes += Buffer.byteLength(chunk, "utf8");
		}

		// The end marker can straddle chunk boundaries; `pastePending` is the
		// trailing partial-marker prefix carried over from the previous append, so
		// the scan window covers every position the marker could complete at.
		const window = this.pastePending.length === 0 ? chunk : this.pastePending + chunk;

		// Pasted bytes carry no escaping, so an end marker inside the content is
		// indistinguishable from the terminator: only the end of the paste's byte
		// stream says which marker was the terminator. Remember that a marker was
		// seen and let the stream go quiet before closing the paste - see
		// `settlePaste`.
		if (window.includes(BRACKETED_PASTE_END)) {
			this.pasteTerminated = true;
		}

		if (this.pasteBufferBytes > this.pasteMaxBytes) {
			// Over the part budget: emit what arrived as paste text and keep paste
			// mode open. Leaving paste mode here would send the rest of the paste
			// down the key path (one insert per character, executed escape
			// sequences) - the exact shape this file exists to prevent.
			this.flushPastePart();
			return;
		}

		this.pastePending = this.trailingPartialPasteMarker(window);

		this.armPasteCloseTimer();
	}

	/**
	 * Arm the timer that closes the paste. With a terminator in hand the paste
	 * ends when the stream goes quiet; without one, a paste whose terminator never
	 * arrives is closed after pasteTimeoutMs (each chunk proves a slow paste is
	 * still flowing).
	 */
	private armPasteCloseTimer(): void {
		if (this.pasteTerminated) {
			// The terminator is somewhere in the bytes we hold, but more of the
			// paste may still be in flight (a marker inside the content looks the
			// same). Close the paste only after the stream goes quiet, so no byte
			// that arrived while the terminal was writing can reach the key parser.
			this.armPasteSettleTimer();
			return;
		}
		this.armPasteWatchdog();
	}

	/**
	 * Emit the bytes received so far as one paste event and stay in paste mode.
	 * A trailing partial-marker prefix is kept back so a terminator split across
	 * the flush boundary is still recognized; its bytes are emitted with a later
	 * part, so no byte is emitted twice.
	 */
	private flushPastePart(): void {
		const content = this.joinPasteChunks();
		// Hold back a trailing complete terminator as well as a partial one: it may
		// be the terminator (strip it once the paste closes) or content (an earlier
		// marker stays part of the text), and `settlePaste` decides with the same
		// last-marker rule it uses for the rest of the paste.
		let keep = this.pastePending.length > 0 && this.pastePending.length <= 8 ? this.pastePending : "";
		if (content.endsWith(BRACKETED_PASTE_END)) {
			keep = BRACKETED_PASTE_END + keep;
		}
		const emit = keep.length > 0 ? content.slice(0, content.length - keep.length) : content;
		this.pasteChunks = keep.length > 0 ? [keep] : [];
		this.pasteBufferBytes = keep.length > 0 ? Buffer.byteLength(keep, "utf8") : 0;
		if (emit.length > 0) {
			this.emit("paste", emit);
		}
		this.armPasteCloseTimer();
	}

	/**
	 * Close a paste whose byte stream has gone quiet after an end marker was seen.
	 * The last complete marker is taken as the terminator (an earlier one is
	 * content the clipboard contained), and everything received - later bytes
	 * included - is emitted as paste text, so no byte of the paste can reach the
	 * key parser. Bytes that arrive after this point are fresh input.
	 */
	private settlePaste(): void {
		this.pasteSettleTimer = null;
		if (!this.pasteMode) {
			return;
		}
		const content = this.joinPasteChunks();
		const lastEnd = content.lastIndexOf(BRACKETED_PASTE_END);
		const stripped =
			lastEnd === -1 ? content : content.slice(0, lastEnd) + content.slice(lastEnd + BRACKETED_PASTE_END.length);
		if (stripped.length === 0) {
			// Nothing but the terminator: close the paste without an empty event.
			this.discardPasteMode();
			return;
		}
		this.emitPasteAndContinue(stripped, "");
	}

	private trailingPartialPasteMarker(window: string): string {
		// The scanned marker starts with ESC, so only the tail starting at the last
		// ESC can still grow into one.
		const esc = window.lastIndexOf(ESC);
		if (esc === -1) {
			return "";
		}
		const tail = window.slice(esc);
		return PARTIAL_PASTE_MARKER_REGEX.test(tail) ? tail : "";
	}

	private joinPasteChunks(): string {
		return this.pasteChunks.length === 1 ? this.pasteChunks[0]! : this.pasteChunks.join("");
	}

	private resetPasteState(): void {
		this.pasteChunks = [];
		this.pasteBufferBytes = 0;
		this.pastePending = "";
		this.pasteTerminated = false;
	}

	private finishPasteWithoutTerminator(): void {
		this.emitPasteAndContinue(this.joinPasteChunks(), "");
	}

	private emitPasteAndContinue(pastedContent: string, remaining: string): void {
		this.clearPasteTimers();
		this.pasteMode = false;
		this.resetPasteState();
		this.pendingKittyPrintableCodepoint = undefined;
		this.emit("paste", pastedContent);
		if (remaining.length > 0) {
			this.process(remaining);
		}
	}

	private discardPasteMode(): void {
		this.clearPasteTimers();
		this.pasteMode = false;
		this.resetPasteState();
		this.pendingKittyPrintableCodepoint = undefined;
	}

	private armPasteWatchdog(): void {
		this.clearPasteWatchdog();
		this.pasteWatchdog = setTimeout(() => {
			this.pasteWatchdog = null;
			if (this.pasteMode) {
				this.finishPasteWithoutTerminator();
			}
		}, this.pasteTimeoutMs);
	}

	private clearPasteWatchdog(): void {
		if (this.pasteWatchdog) {
			clearTimeout(this.pasteWatchdog);
			this.pasteWatchdog = null;
		}
	}

	private armPasteSettleTimer(): void {
		this.clearPasteSettleTimer();
		this.pasteSettleTimer = setTimeout(() => {
			this.settlePaste();
		}, this.pasteSettleMs);
	}

	private clearPasteSettleTimer(): void {
		if (this.pasteSettleTimer) {
			clearTimeout(this.pasteSettleTimer);
			this.pasteSettleTimer = null;
		}
	}

	private clearPasteTimers(): void {
		this.clearPasteWatchdog();
		this.clearPasteSettleTimer();
	}

	private emitDataSequence(sequence: string): void {
		const pending = this.pendingKittyPrintableCodepoint;
		if (pending !== undefined) {
			// A raw printable key that repeats the preceding Kitty CSI-u printable
			// event is dropped. Only a sequence that IS that one character counts:
			// a bulk run (a paste without bracketed paste, a pipe) is text, and its
			// first character must survive even when it matches the last key.
			const repeated = String.fromCodePoint(pending);
			if (sequence === repeated) {
				this.pendingKittyPrintableCodepoint = undefined;
				return;
			}
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.clearPasteTimers();
		this.buffer = "";
		this.pasteMode = false;
		this.resetPasteState();
		this.pendingKittyPrintableCodepoint = undefined;
	}

	/** Drop in-flight paste and incomplete sequences without emitting them. */
	abortPendingInput(): void {
		this.clear();
	}

	isPasteMode(): boolean {
		return this.pasteMode;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
