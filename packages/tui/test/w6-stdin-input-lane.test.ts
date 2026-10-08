import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Input } from "../src/components/input.js";
import { matchesKey, parseKey, setKittyProtocolActive } from "../src/keys.js";
import { StdinBuffer } from "../src/stdin-buffer.js";
import { visibleWidth } from "../src/utils.js";

/**
 * Regression tests for the w6 stdin lane of the 2026-10-06 display audit:
 * R5-M1 (CSI-u codepoint RangeError crash), R5-M2 (legacy meta chords vs
 * SS3/DCS/OSC/APC introducers), R5-M3 (CR in bulk runs becoming Enter),
 * M3 (meta-sends-escape double-ESC split), R6-M12 (Input paste washing).
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("R5-M1: Kitty CSI-u codepoints above U+10FFFF cannot crash the process", () => {
	let buffer: StdinBuffer;
	let emitted: string[];

	beforeEach(() => {
		buffer = new StdinBuffer({ timeout: 10 });
		emitted = [];
		buffer.on("data", (sequence) => emitted.push(sequence));
	});
	afterEach(() => buffer.destroy());

	it("survives the audit's poison sequence and still delivers the key after it", () => {
		// `\x1b[1114112u` used to set pendingKittyPrintableCodepoint = 1114112, and the
		// next emitDataSequence ran String.fromCodePoint(1114112) -> RangeError -> crash.
		buffer.process("\x1b[1114112u");
		buffer.process("a");
		assert.deepStrictEqual(emitted, ["\x1b[1114112u", "a"]);
	});

	it("rejects absurdly long codepoint parameters without throwing", () => {
		buffer.process("\x1b[99999999999999999999u");
		buffer.process("b");
		assert.deepStrictEqual(emitted, ["\x1b[99999999999999999999u", "b"]);
	});

	it("still treats the largest legal code point as a kitty printable", () => {
		// U+10FFFF is the largest legal code point: the upper bound must not reject
		// it, and the next key must survive the dedup check it arms.
		buffer.process("\x1b[1114111u");
		buffer.process("a");
		assert.deepStrictEqual(emitted, ["\x1b[1114111u", "a"]);
	});
});

describe("R5-M3: carriage returns inside bulk runs are line endings, not Enter", () => {
	let buffer: StdinBuffer;
	let emitted: string[];

	beforeEach(() => {
		buffer = new StdinBuffer({ timeout: 10 });
		emitted = [];
		buffer.on("data", (sequence) => emitted.push(sequence));
	});
	afterEach(() => buffer.destroy());

	it("folds CRLF and lone CR into LF inside a bulk run", () => {
		const text = "first line of the paste\r\nsecond line of the paste\rthird line";
		buffer.process(text);
		assert.deepStrictEqual(emitted, ["first line of the paste\nsecond line of the paste\nthird line"]);
	});

	it("keeps bulk delivery when CR folding shrinks the run below the bulk threshold", () => {
		// 33 bytes on the wire, 22 after folding: it arrived as one burst, so it is
		// still one text sequence - per-character delivery would turn the LFs into
		// Enter keys downstream.
		buffer.process("a\r\n".repeat(11));
		assert.deepStrictEqual(emitted, ["a\n".repeat(11)]);
	});

	it("keeps a carriage return in a short run as its own sequence (the Enter key)", () => {
		buffer.process("ab\r");
		assert.deepStrictEqual(emitted, ["a", "b", "\r"]);
	});

	it("keeps a bare Enter keypress as a single sequence", () => {
		buffer.process("\r");
		assert.deepStrictEqual(emitted, ["\r"]);
	});
});

describe("R5-M2: legacy meta chords do not swallow the input glued behind them", () => {
	let buffer: StdinBuffer;
	let emitted: string[];

	beforeEach(() => {
		setKittyProtocolActive(false);
		buffer = new StdinBuffer({ timeout: 10 });
		emitted = [];
		buffer.on("data", (sequence) => emitted.push(sequence));
	});
	afterEach(() => {
		buffer.destroy();
		setKittyProtocolActive(false);
	});

	it("splits an unknown SS3 final back into the alt+shift+o chord and the typed text", () => {
		// Alt+Shift+O (the expandFull default binding) sends ESC O; a byte typed
		// inside the completion window used to glue on as an unknown SS3 sequence
		// and both keys were dropped.
		buffer.process("\x1bOx");
		assert.deepStrictEqual(emitted, ["\x1bO", "x"]);
		assert.strictEqual(matchesKey(emitted[0]!, "alt+shift+o"), true);
	});

	it("keeps a real SS3 sequence whole", () => {
		buffer.process("\x1bOA");
		assert.deepStrictEqual(emitted, ["\x1bOA"]);
	});

	it("recovers text typed behind a DCS introducer chord (alt+shift+p) at the flush", async () => {
		buffer.process("\x1bPhello");
		await wait(25);
		assert.deepStrictEqual(emitted, ["\x1bP", "h", "e", "l", "l", "o"]);
		assert.strictEqual(parseKey("\x1bP"), "shift+alt+p");
	});

	it("recovers text typed behind an OSC introducer chord (alt+]) at the flush", async () => {
		buffer.process("\x1b]hello");
		await wait(25);
		assert.deepStrictEqual(emitted, ["\x1b]", "h", "e", "l", "l", "o"]);
	});

	it("recovers text typed behind an APC introducer chord (alt+shift+-) at the flush", async () => {
		buffer.process("\x1b_hello");
		await wait(25);
		assert.deepStrictEqual(emitted, ["\x1b_", "h", "e", "l", "l", "o"]);
	});

	it("passes a complete OSC answer through whole when it arrives inside the window", () => {
		const answer = "\x1b]10;rgb:ffff/ffff/ffff\x07";
		buffer.process(answer);
		assert.deepStrictEqual(emitted, [answer]);
	});

	it("passes a complete DCS answer through whole when it arrives inside the window", () => {
		const answer = "\x1bP>|prime 1.0\x1b\\";
		buffer.process(answer);
		assert.deepStrictEqual(emitted, [answer]);
	});
});

describe("M3: meta-sends-escape terminals get Alt+arrows instead of Escape+draft-clear", () => {
	let buffer: StdinBuffer;
	let emitted: string[];

	beforeEach(() => {
		setKittyProtocolActive(false);
		buffer = new StdinBuffer({ timeout: 10 });
		emitted = [];
		buffer.on("data", (sequence) => emitted.push(sequence));
	});
	afterEach(() => {
		buffer.destroy();
		setKittyProtocolActive(false);
	});

	it("merges ESC + CSI into one Alt+Up sequence instead of Escape then Up", () => {
		buffer.process("\x1b\x1b[A");
		assert.deepStrictEqual(emitted, ["\x1b\x1b[A"]);
		assert.strictEqual(matchesKey("\x1b\x1b[A", "alt+up"), true);
		assert.strictEqual(matchesKey("\x1b\x1b[A", "up"), false);
		assert.strictEqual(matchesKey("\x1b\x1b[A", "escape"), false);
		assert.strictEqual(parseKey("\x1b\x1b[A"), "alt+up");
	});

	it("merges ESC + modifier CSI (Option+Ctrl+Up reaches the ctrl+alt+up binding)", () => {
		buffer.process("\x1b\x1b[1;5A");
		assert.deepStrictEqual(emitted, ["\x1b\x1b[1;5A"]);
		assert.strictEqual(matchesKey(emitted[0]!, "ctrl+alt+up"), true);
		assert.strictEqual(parseKey(emitted[0]!), "ctrl+alt+up");
	});

	it("merges ESC + SS3 into one Alt+arrow sequence", () => {
		buffer.process("\x1b\x1bOA");
		assert.deepStrictEqual(emitted, ["\x1b\x1bOA"]);
		assert.strictEqual(matchesKey(emitted[0]!, "alt+up"), true);
		assert.strictEqual(parseKey(emitted[0]!), "alt+up");
	});

	it("merges ESC + CSI arriving torn across one completion window", async () => {
		buffer.process("\x1b");
		await wait(15);
		buffer.process("\x1b[1;5A");
		assert.deepStrictEqual(emitted, ["\x1b\x1b[1;5A"]);
	});

	it("splits a held meta-CSI that never completes back into Escape + fragment at the flush", async () => {
		buffer.process("\x1b\x1b[1;");
		await wait(25);
		assert.deepStrictEqual(emitted, ["\x1b", "\x1b[1;"]);
	});

	it("does not merge ESC + mouse report (a click behind an Escape must survive)", () => {
		buffer.process("\x1b\x1b[<0;10;5M");
		assert.deepStrictEqual(emitted, ["\x1b", "\x1b[<0;10;5M"]);
	});

	it("does not merge ESC + probe answer", () => {
		buffer.process("\x1b\x1b[?1u");
		assert.deepStrictEqual(emitted, ["\x1b", "\x1b[?1u"]);
	});

	it("does not let the merge eat a paste start that lands behind an Escape", async () => {
		const pastes: string[] = [];
		buffer.on("paste", (paste) => pastes.push(paste));
		buffer.process("\x1b\x1b[200~pasted text\x1b[201~");
		await wait(30);
		assert.deepStrictEqual(emitted, ["\x1b"]);
		assert.deepStrictEqual(pastes, ["pasted text"]);
	});

	it("keeps Escape + a meta letter chord split", () => {
		buffer.process("\x1b\x1bo");
		assert.deepStrictEqual(emitted, ["\x1b", "\x1bo"]);
	});

	it("keeps two bare Escape presses as two escape keys", async () => {
		buffer.process("\x1b\x1b");
		assert.deepStrictEqual(emitted, ["\x1b"]);
		await wait(25);
		assert.deepStrictEqual(emitted, ["\x1b", "\x1b"]);
	});
});

describe("R6-M12: Input washes pasted text before storing it", () => {
	it("strips escape sequences and control bytes out of the value and out of every render", () => {
		const input = new Input();
		input.handleInput("\x1b[200~a\x1b[31mb\x1b]52;c;cGFzdA==\x07c\x07d\x7fe\x1b[201~");
		assert.strictEqual(input.getValue(), "abcde");
		const [line] = input.render(80);
		assert.ok(line !== undefined);
		assert.ok(!line.includes("\x1b]"), "render must not re-emit an OSC from the stored value");
		assert.ok(!line.includes("\x07"), "render must not re-emit a BEL from the stored value");
	});

	it("joins pasted lines with a space instead of silently concatenating them", () => {
		const input = new Input();
		input.handleInput("\x1b[200~line1\nline2\r\nline3\rline4\x1b[201~");
		assert.strictEqual(input.getValue(), "line1 line2 line3 line4");
	});

	it("keeps expanding pasted tabs to spaces", () => {
		const input = new Input();
		input.handleInput("\x1b[200~a\tb\x1b[201~");
		assert.strictEqual(input.getValue(), "a    b");
	});

	it("renders within the given width even at width <= 2", () => {
		const input = new Input();
		input.setValue("hello");
		input.focused = true;
		const widths = [0, 1, 2, 3, 10];
		assert.ok(widths.length > 0);
		for (const width of widths) {
			for (const line of input.render(width)) {
				assert.ok(visibleWidth(line) <= width, `render(${width}) overflowed: ${JSON.stringify(line)}`);
			}
		}
	});
});
