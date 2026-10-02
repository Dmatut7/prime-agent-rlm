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
 * End offset of the next bulk slice. Two boundaries are not allowed to fall where
 * the length cap says they do, because the slice a boundary creates has to be
 * text a consumer can insert:
 *
 * - A slice that *starts* with a newline is read as the newline key (or dropped
 *   outright: a consumer that treats a leading control byte as a key remnant
 *   discards the whole sequence). The cut steps over the newline instead, so the
 *   newline ends the current slice rather than leading the next one.
 * - A cut inside a surrogate pair hands the consumer two lone surrogates, and the
 *   character is mangled on the way in. The cut moves back one unit so the pair
 *   travels whole in the following slice.
 */
function bulkSliceEnd(run: string, start: number): number {
	let end = Math.min(run.length, start + BULK_TEXT_MAX_SEQUENCE);
	if (end >= run.length) {
		return run.length;
	}
	while (end < run.length && run[end] === "\n") {
		end++;
	}
	if (end < run.length) {
		const code = run.charCodeAt(end);
		if (code >= 0xdc00 && code <= 0xdfff) {
			end--;
		}
	}
	return end;
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
 * sequence that starts with a newline as a single newline key), and every slice
 * boundary is chosen so that no slice it creates breaks that rule - see
 * `bulkSliceEnd`.
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
	while (start < run.length) {
		const end = bulkSliceEnd(run, start);
		sequences.push(run.slice(start, end));
		start = end;
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
 *
 * Nothing else inside the paste can end it: a control sequence in the bytes is
 * paste text like any other byte, and only the quiet stream, the watchdog, Ctrl+C
 * or an explicit abort closes paste mode.
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
 * this can still grow into the terminator in a later chunk, so it must be
 * rescanned on append.
 */
const PARTIAL_PASTE_MARKER_REGEX = /^\x1b(\[(2(0(1)?)?)?)?$/;

/** A complete mouse report: SGR (`ESC [ < b ; x ; y M|m`) or legacy (`ESC [ M` and three bytes). */
const MOUSE_REPORT_REGEX = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/g;

/** The start of a mouse report that has not fully arrived, down to a bare `ESC`. */
const MOUSE_REPORT_PREFIX_REGEX = /^\x1b(\[(<[\d;]*|M[\s\S]{0,2})?)?$/;

/** Such a start once it can be told from the start of the end marker (`ESC [ <` or `ESC [ M` seen). */
const PARTIAL_MOUSE_REPORT_REGEX = /^\x1b\[(<[\d;]*|M[\s\S]{0,2})$/;

/**
 * Terminal query answers that can land inside an open paste on a slow link: the
 * Kitty keyboard flags answer (`CSI ? flags u`), the cell-size answer
 * (`CSI 6 ; h ; w t`), the OSC 10/11 default-color answers, DECRPM mode answers
 * (`CSI ? Ps ; Pv $ y`), the primary-DA fence answer (`CSI ? ... c`) and
 * mode-2031 scheme pushes (`CSI ? 997 ; 1|2 n`, which can arrive whenever the
 * appearance flips, not only inside the startup window). They are responses to
 * this process's own probes, never paste text, so they are lifted out of the
 * paste stream and delivered as data sequences to their regular consumers.
 *
 * The DA branch must keep its `?` prefix: a bare `\x1b[c` is the shift+right
 * key (keys.ts), never a probe answer.
 */
const TERMINAL_RESPONSE_REGEX =
	/\x1b\[\?\d+u|\x1b\[\?\d+(?:;\d+)*\$y|\x1b\[\?[\d;]*c|\x1b\[\?997;[12]n|\x1b\[6;\d+;\d+t|\x1b\]1[01];[^\x07\x1b]+(?:\x07|\x1b\\)/g;

/** A tail that can still grow into a complete terminal response with the next chunk. */
const TERMINAL_RESPONSE_PREFIX_REGEX =
	/^\x1b(?:\[(?:\?\d*(?:;\d*)*\$?|6(?:;\d*(?:;\d*)?)?)?|\](?:1[01]?(?:;[^\x07\x1b]*)?(?:\x1b)?)?)?$/;

/** Responses are short (the longest is an OSC color answer); only a bounded tail is rescanned. */
const TERMINAL_RESPONSE_MAX_TAIL = 64;

function trailingTerminalResponsePrefix(text: string): string {
	const tail = text.slice(-TERMINAL_RESPONSE_MAX_TAIL);
	for (let i = 0; i < tail.length; i++) {
		if (tail.charCodeAt(i) !== 0x1b) continue;
		const candidate = tail.slice(i);
		if (TERMINAL_RESPONSE_PREFIX_REGEX.test(candidate)) return candidate;
	}
	return "";
}

/**
 * Lift complete terminal responses out of a paste chunk. A trailing partial
 * response travels as `hold` instead of paste text, so one split across chunks
 * is reassembled against the next chunk instead of leaking half into the paste.
 */
function extractTerminalResponses(chunk: string): { text: string; responses: string[]; hold: string } {
	const responses: string[] = [];
	const text = chunk.replace(TERMINAL_RESPONSE_REGEX, (match) => {
		responses.push(match);
		return "";
	});
	return { text, responses, hold: trailingTerminalResponsePrefix(text) };
}

/**
 * Whether `data` is a proper prefix of a bracketed-paste marker longer than a
 * bare ESC - a marker torn across packets. Bare ESC is excluded: it is the
 * Escape key far more often than the start of a paste, and its completion
 * window must not double.
 */
function isPartialPasteMarkerPrefix(data: string): boolean {
	return (
		data.length >= 2 &&
		data.length < BRACKETED_PASTE_START.length &&
		(BRACKETED_PASTE_START.startsWith(data) || BRACKETED_PASTE_END.startsWith(data))
	);
}

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
	/** Start of a mouse report at the end of what arrived behind the last end marker. */
	private pasteMouseHold: string = "";
	/** Tail of the last paste chunk that can still grow into a terminal response. */
	private pasteResponseHold: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;
	/** The completion-window flush already waited out one extra window for a torn paste marker. */
	private sequenceTimeoutExtended: boolean = false;

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
		this.sequenceTimeoutExtended = false;

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
			// Ctrl+C is the user's own interrupt, and the one deliberate exception to
			// the rule that every byte arriving while a paste is open is paste text:
			// it is the only way out of a paste whose end marker never arrives. The
			// bytes already buffered are dropped rather than emitted - the user asked
			// to abandon the paste, not to insert whatever a stuck stream delivered.
			// The rest of the chunk that carried the interrupt is fresh input (a
			// bounded reopening of the key path, bytes after the 0x03 only); that is
			// the price of the escape hatch, and everything that arrived before the
			// interrupt still stays out of the key parser.
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
			this.appendPasteInput(chunk);
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
				// A sequence the paste start cut short (e.g. a bare ESC still inside
				// its completion window) is real input: emit it with the same
				// semantics as a timeout flush instead of dropping it.
				if (result.remainder.length > 0) {
					this.emitDataSequence(result.remainder);
				}
			}

			this.pendingKittyPrintableCodepoint = undefined;
			this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
			this.pasteMode = true;
			this.resetPasteState();
			const initialContent = this.buffer;
			this.buffer = "";
			this.appendPasteInput(initialContent);
			return;
		}

		const result = extractCompleteSequences(this.buffer);
		this.buffer = result.remainder;

		for (const sequence of result.sequences) {
			this.emitDataSequence(sequence);
		}

		if (this.buffer.length > 0) {
			this.timeout = setTimeout(() => {
				this.onSequenceTimeout();
			}, this.timeoutMs);
		}
	}

	/**
	 * Flush the buffered sequence after its completion window. A buffer that is
	 * a proper prefix of a bracketed-paste marker gets one extra window first: a
	 * paste start torn across packets ("\x1b[20" + "0~…") would otherwise flush
	 * the fragment as a key and let the rest of the paste reach the key parser,
	 * where its escape sequences execute as editing commands.
	 */
	private onSequenceTimeout(): void {
		if (!this.sequenceTimeoutExtended && isPartialPasteMarkerPrefix(this.buffer)) {
			this.sequenceTimeoutExtended = true;
			this.timeout = setTimeout(() => {
				this.onSequenceTimeout();
			}, this.timeoutMs);
			return;
		}
		this.sequenceTimeoutExtended = false;
		const flushed = this.flush();

		for (const sequence of flushed) {
			this.emitDataSequence(sequence);
		}
	}

	/**
	 * Route a chunk that arrived while paste mode is on into the paste. Terminal
	 * query answers (Kitty flags, cell size, OSC 10/11 colors) are lifted out and
	 * delivered as data sequences - they answer this process's own probes and are
	 * not paste text. A tail that can still grow into one is held for the next
	 * chunk; whatever never completes is returned to the paste verbatim when the
	 * paste closes.
	 */
	private appendPasteInput(chunk: string): void {
		const combined = this.pasteResponseHold + chunk;
		const { text, responses, hold } = extractTerminalResponses(combined);
		this.pasteResponseHold = hold;
		for (const response of responses) {
			this.emitDataSequence(response);
		}
		// The hold is a suffix of `text`; it travels with the next chunk instead
		// of entering the paste twice.
		this.appendPasteChunk(hold.length > 0 ? text.slice(0, text.length - hold.length) : text);
	}

	/**
	 * Append bytes to the paste. Every byte that arrives while paste mode is on
	 * belongs to the paste text: content bytes and protocol bytes are
	 * indistinguishable, so a control sequence inside a paste cannot be allowed to
	 * leave paste mode (that would both drop the buffered content and hand the rest
	 * of the paste to the key parser, where `\r` is Enter). The only thing that
	 * closes a paste is its byte stream going quiet after the terminator, the idle
	 * watchdog, or the caller aborting it. Ctrl+C never reaches this method: an
	 * interrupt is not a byte of the paste, and `process` handles it before the
	 * chunk is appended.
	 */
	private appendPasteChunk(chunk: string): void {
		if (chunk.length > 0) {
			this.pasteChunks.push(chunk);
			this.pasteBufferBytes += Buffer.byteLength(chunk, "utf8");
		}

		// The terminator can straddle chunk boundaries; `pastePending` is the
		// trailing partial-marker prefix carried over from the previous append, so
		// the scan window covers every position it could complete at.
		const window = this.pastePending.length === 0 ? chunk : this.pastePending + chunk;

		// Pasted bytes carry no escaping, so an end marker inside the content is
		// indistinguishable from the terminator: only the end of the paste's byte
		// stream says which marker was the terminator. Remember that a marker was
		// seen and let the stream go quiet before closing the paste - see
		// `settlePaste`.
		const lastEnd = window.lastIndexOf(BRACKETED_PASTE_END);
		if (lastEnd !== -1) {
			this.pasteTerminated = true;
		}
		const pointerOnly = this.pasteTerminated && this.holdsOnlyMouseReports(chunk, lastEnd);

		if (this.pasteBufferBytes > this.pasteMaxBytes) {
			// Over the part budget: emit what arrived as paste text and keep paste
			// mode open. Leaving paste mode here would send the rest of the paste
			// down the key path (one insert per character, executed escape
			// sequences) - the exact shape this file exists to prevent.
			this.flushPastePart();
			return;
		}

		this.pastePending = this.trailingPartialPasteMarker(window);

		// A moving mouse must not keep a settled paste open: bytes that are only mouse
		// reports (or the start of one) behind the last end marker say nothing about
		// whether the paste is still flowing.
		if (!pointerOnly) {
			this.armPasteCloseTimer();
		}
	}

	/**
	 * Whether this chunk added nothing behind the last end marker except mouse reports
	 * and, at its end, the start of one. Nothing is split off here: which marker is the
	 * terminator is only known once the paste closes, and a report ahead of it is paste
	 * text (a clipboard can hold a marker and a forged click) - see `settlePaste`.
	 */
	private holdsOnlyMouseReports(chunk: string, lastEnd: number): boolean {
		// A marker inside this chunk moves the boundary: only bytes behind it count.
		const boundary =
			lastEnd === -1 ? 0 : Math.max(0, lastEnd + BRACKETED_PASTE_END.length - this.pastePending.length);
		const behind = (boundary === 0 ? this.pasteMouseHold : "") + chunk.slice(boundary);
		const rest = behind.replace(MOUSE_REPORT_REGEX, "");
		const escAt = rest.lastIndexOf(ESC);
		const held = escAt !== -1 && MOUSE_REPORT_PREFIX_REGEX.test(rest.slice(escAt)) ? rest.slice(escAt) : "";
		this.pasteMouseHold = held;
		return boundary === 0 && rest.length === held.length;
	}

	/**
	 * What follows the last end marker of a closed paste: complete mouse reports are
	 * split out, a report cut off at the end is dropped, everything else is text.
	 */
	private splitMouseReports(behind: string): { text: string; reports: string[] } {
		const reports: string[] = [];
		let text = "";
		let consumed = 0;
		for (const match of behind.matchAll(MOUSE_REPORT_REGEX)) {
			text += behind.slice(consumed, match.index);
			reports.push(match[0]);
			consumed = match.index + match[0].length;
		}
		let rest = behind.slice(consumed);
		const escAt = rest.lastIndexOf(ESC);
		if (escAt !== -1 && PARTIAL_MOUSE_REPORT_REGEX.test(rest.slice(escAt))) {
			rest = rest.slice(0, escAt);
		}
		return { text: text + rest, reports };
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
	 * content the clipboard contained), and everything received before it is paste
	 * text, so no byte of the paste can reach the key parser. What arrived behind the
	 * terminator is not the clipboard's: the mouse reports in it go out as input after
	 * the paste, the rest stays paste text. Bytes that arrive after this point are
	 * fresh input.
	 */
	private settlePaste(): void {
		this.pasteSettleTimer = null;
		if (!this.pasteMode) {
			return;
		}
		// A held partial response never completed once the stream is quiet: it is
		// paste text after all, returned verbatim.
		const content = this.joinPasteChunks() + this.pasteResponseHold;
		const lastEnd = content.lastIndexOf(BRACKETED_PASTE_END);
		let text = lastEnd === -1 ? content : content.slice(0, lastEnd);
		let reports: string[] = [];
		if (lastEnd !== -1) {
			const behind = this.splitMouseReports(content.slice(lastEnd + BRACKETED_PASTE_END.length));
			text += behind.text;
			reports = behind.reports;
		}
		if (text.length === 0) {
			// Nothing but the terminator: close the paste without an empty event.
			this.discardPasteMode();
		} else {
			this.emitPasteAndContinue(text);
		}
		for (const report of reports) {
			this.emitDataSequence(report);
		}
	}

	private trailingPartialPasteMarker(window: string): string {
		// The terminator starts with ESC, so only the tail starting at the last ESC
		// can still grow into one; anything else after it is already content.
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
		this.pasteMouseHold = "";
		this.pasteResponseHold = "";
	}

	private finishPasteWithoutTerminator(): void {
		this.emitPasteAndContinue(this.joinPasteChunks() + this.pasteResponseHold);
	}

	/**
	 * Close paste mode with the bytes received so far as paste text. Nothing is
	 * handed to the key parser here - not even a leftover tail - because no byte
	 * that arrived while the paste was open may become a key.
	 */
	private emitPasteAndContinue(pastedContent: string): void {
		this.clearPasteTimers();
		this.pasteMode = false;
		this.resetPasteState();
		this.pendingKittyPrintableCodepoint = undefined;
		this.emit("paste", pastedContent);
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
