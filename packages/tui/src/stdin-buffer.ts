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
			for (let i = 0; i < run.length; i++) {
				sequences.push(run[i]!);
			}
			pos = runEnd;
		}
	}

	return { sequences, remainder: "" };
}

export const PASTE_TIMEOUT_MS = 30_000;
export const PASTE_MAX_BYTES = 8 * 1024 * 1024;

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for sequence completion (default: 10ms)
	 * After this time, the buffer is flushed even if incomplete
	 */
	timeout?: number;
	/**
	 * Idle time without stdin chunks to wait for `201~` after entering paste mode.
	 * Missing terminator emits the buffer as one atomic paste.
	 */
	pasteTimeoutMs?: number;
	/** Maximum UTF-8 byte length of `pasteBuffer` before aborting paste mode. */
	pasteMaxBytes?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

function isImmediatePasteEscapeAbort(data: string): boolean {
	return data === "\x1b[27u" || (data.startsWith("\x1b[27;") && data.endsWith("u"));
}

/**
 * Proper prefixes of the markers scanned inside a paste (`\x1b[201~`,
 * `\x1b[27u`, `\x1b[27;<digits>u`). A window tail matching this can still
 * grow into a marker in a later chunk, so it must be rescanned on append.
 */
const PARTIAL_PASTE_MARKER_REGEX = /^\x1b(\[(2(01?|7(;[\d:]*)?)?)?)?$/;

function findCompleteKittyEscape(buffer: string): { index: number; length: number } | null {
	const simple = "\x1b[27u";
	const simpleAt = buffer.indexOf(simple);
	if (simpleAt !== -1) {
		return { index: simpleAt, length: simple.length };
	}
	const match = buffer.match(/\x1b\[27;[\d:]+u/);
	if (match?.index === undefined) {
		return null;
	}
	return { index: match.index, length: match[0].length };
}

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private pasteWatchdog: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private readonly pasteTimeoutMs: number;
	private readonly pasteMaxBytes: number;
	private pasteMode: boolean = false;
	// Paste content is kept as chunks and joined once on completion. Each
	// append only scans the new chunk plus `pastePending` (a trailing partial
	// marker carried across the chunk boundary). Accumulating into one string
	// and rescanning it per chunk was quadratic: every `+=` plus indexOf/regex
	// re-flattened and re-walked the whole paste.
	private pasteChunks: string[] = [];
	private pasteLength: number = 0;
	private pasteBufferBytes: number = 0;
	private pastePending: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? 10;
		this.pasteTimeoutMs = options.pasteTimeoutMs ?? PASTE_TIMEOUT_MS;
		this.pasteMaxBytes = options.pasteMaxBytes ?? PASTE_MAX_BYTES;
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
			if (isImmediatePasteEscapeAbort(str)) {
				this.discardPasteMode();
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
			this.pasteLength += chunk.length;
			this.pasteBufferBytes += Buffer.byteLength(chunk, "utf8");
		}

		// Markers can straddle chunk boundaries; `pastePending` is the trailing
		// partial-marker prefix carried over from the previous append, so the
		// scan window covers every position a marker could complete at.
		const window = this.pastePending.length === 0 ? chunk : this.pastePending + chunk;
		const windowStart = this.pasteLength - window.length;

		const endIndex = window.indexOf(BRACKETED_PASTE_END);
		if (endIndex !== -1) {
			const absoluteEnd = windowStart + endIndex;
			const content = this.joinPasteChunks();
			this.emitPasteAndContinue(
				content.slice(0, absoluteEnd),
				content.slice(absoluteEnd + BRACKETED_PASTE_END.length),
			);
			return;
		}

		if (this.pasteBufferBytes > this.pasteMaxBytes) {
			this.finishPasteWithoutTerminator();
			return;
		}

		const kittyEsc = findCompleteKittyEscape(window);
		if (kittyEsc) {
			const remaining = this.joinPasteChunks().slice(windowStart + kittyEsc.index + kittyEsc.length);
			this.discardPasteMode();
			if (remaining.length > 0) {
				this.process(remaining);
			}
			return;
		}

		this.pastePending = this.trailingPartialPasteMarker(window);
		// Idle timeout: each chunk proves the paste is still flowing.
		this.armPasteWatchdog();
	}

	private trailingPartialPasteMarker(window: string): string {
		// Every scanned marker starts with ESC, so only the tail starting at the
		// last ESC can still grow into one. Longer tails can only be a partial
		// Kitty Esc (`\x1b[27;` + digits/colons); checking that run by char code
		// avoids allocating a multi-megabyte tail slice.
		const esc = window.lastIndexOf(ESC);
		if (esc === -1) {
			return "";
		}
		const tail = window.slice(esc);
		if (tail.length > 8) {
			if (!tail.startsWith("\x1b[27;")) {
				return "";
			}
			for (let i = 5; i < tail.length; i++) {
				const code = tail.charCodeAt(i);
				if (!((code >= 48 && code <= 57) || code === 58)) return "";
			}
			return tail;
		}
		return PARTIAL_PASTE_MARKER_REGEX.test(tail) ? tail : "";
	}

	private joinPasteChunks(): string {
		return this.pasteChunks.length === 1 ? this.pasteChunks[0]! : this.pasteChunks.join("");
	}

	private resetPasteState(): void {
		this.pasteChunks = [];
		this.pasteLength = 0;
		this.pasteBufferBytes = 0;
		this.pastePending = "";
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

	private clearPasteTimers(): void {
		this.clearPasteWatchdog();
	}

	private emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
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
