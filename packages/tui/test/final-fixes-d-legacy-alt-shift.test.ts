import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type KeyId, matchesKey, parseKey, setKittyProtocolActive } from "../src/keys.js";
import { StdinBuffer } from "../src/stdin-buffer.js";

const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"];

/** What a terminal without extended keys (tmux by default) sends for Alt+Shift+letter. */
const legacyAltShift = (letter: string): string => `\x1b${letter.toUpperCase()}`;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function openStdinBuffer(): { buffer: StdinBuffer; emitted: string[] } {
	const buffer = new StdinBuffer({ timeout: 10 });
	const emitted: string[] = [];
	buffer.on("data", (sequence) => emitted.push(sequence));
	return { buffer, emitted };
}

describe("legacy ESC + uppercase letter is Alt+Shift+letter", () => {
	beforeEach(() => setKittyProtocolActive(false));
	afterEach(() => setKittyProtocolActive(false));

	it("matchesKey accepts it for every letter, in either modifier order", () => {
		assert.strictEqual(LETTERS.length, 26);
		for (const letter of LETTERS) {
			const data = legacyAltShift(letter);
			assert.strictEqual(matchesKey(data, `alt+shift+${letter}` as KeyId), true, `alt+shift+${letter}`);
			assert.strictEqual(matchesKey(data, `shift+alt+${letter}` as KeyId), true, `shift+alt+${letter}`);
		}
	});

	it("parseKey names it like the CSI-u encoding of the same chord", () => {
		// ESC B and ESC F keep their readline meaning (alt+left, alt+right), see below.
		const letters = LETTERS.filter((letter) => letter !== "b" && letter !== "f");
		assert.strictEqual(letters.length, 24);
		for (const letter of letters) {
			const csiU = parseKey(`\x1b[${letter.charCodeAt(0)};4u`);
			assert.strictEqual(csiU, `shift+alt+${letter}`, `CSI-u ${letter}`);
			assert.strictEqual(parseKey(legacyAltShift(letter)), csiU, `legacy ${letter}`);
		}
	});

	it("keeps ESC B / ESC F as alt+left / alt+right for parseKey", () => {
		assert.strictEqual(parseKey("\x1bB"), "alt+left");
		assert.strictEqual(parseKey("\x1bF"), "alt+right");
		assert.strictEqual(matchesKey("\x1bB", "alt+left"), true);
		assert.strictEqual(matchesKey("\x1bF", "alt+right"), true);
	});

	it("does not widen the other alt and shift chords", () => {
		assert.strictEqual(matchesKey("\x1bo", "alt+shift+o"), false, "lowercase is plain alt+o");
		assert.strictEqual(matchesKey("\x1bo", "alt+o"), true);
		assert.strictEqual(matchesKey("\x1bO", "alt+o"), false, "uppercase is not plain alt+o");
		assert.strictEqual(matchesKey("\x1bO", "shift+o"), false);
		assert.strictEqual(matchesKey("\x1bO", "alt+shift+p"), false, "another letter");
		assert.strictEqual(matchesKey("O", "alt+shift+o"), false, "no ESC prefix");
		assert.strictEqual(matchesKey("\x1b\x1bO", "alt+shift+o"), false, "two ESC bytes");
		assert.strictEqual(parseKey("\x1bo"), "alt+o");
	});

	it("leaves SS3 arrow, home/end and function-key sequences alone", () => {
		const ss3: Array<[string, string]> = [
			["\x1bOA", "up"],
			["\x1bOB", "down"],
			["\x1bOC", "right"],
			["\x1bOD", "left"],
			["\x1bOH", "home"],
			["\x1bOF", "end"],
			["\x1bOP", "f1"],
			["\x1bOQ", "f2"],
			["\x1bOR", "f3"],
			["\x1bOS", "f4"],
		];
		assert.ok(ss3.length > 0);
		for (const [data, name] of ss3) {
			assert.strictEqual(matchesKey(data, "alt+shift+o"), false, `${JSON.stringify(data)} must not be alt+shift+o`);
			assert.strictEqual(parseKey(data), name, JSON.stringify(data));
		}
	});

	it("is left alone while the Kitty protocol is active", () => {
		setKittyProtocolActive(true);
		assert.strictEqual(matchesKey("\x1bO", "alt+shift+o"), false);
		assert.strictEqual(parseKey("\x1bO"), undefined);
		assert.strictEqual(matchesKey("\x1b[111;4u", "alt+shift+o"), true, "the protocol's own encoding still matches");
	});
});

describe("Alt+Shift+O and Alt+Shift+P through the stdin buffer", () => {
	beforeEach(() => setKittyProtocolActive(false));
	afterEach(() => setKittyProtocolActive(false));

	it("delivers a lone ESC O after the flush timeout, and it is alt+shift+o", async () => {
		const { buffer, emitted } = openStdinBuffer();
		try {
			buffer.process("\x1bO");
			assert.deepStrictEqual(emitted, [], "held back for a moment: it could still grow into an SS3 sequence");
			await wait(60);
			assert.deepStrictEqual(emitted, ["\x1bO"]);
			assert.strictEqual(matchesKey(emitted[0]!, "alt+shift+o"), true);
			assert.strictEqual(parseKey(emitted[0]!), "shift+alt+o");
		} finally {
			buffer.destroy();
		}
	});

	it("does not turn the up arrow (ESC O A) into alt+shift+o", async () => {
		const chunkings: string[][] = [["\x1bOA"], ["\x1bO", "A"]];
		assert.ok(chunkings.length > 0);
		for (const chunks of chunkings) {
			const { buffer, emitted } = openStdinBuffer();
			try {
				for (const chunk of chunks) buffer.process(chunk);
				await wait(60);
				assert.deepStrictEqual(emitted, ["\x1bOA"], JSON.stringify(chunks));
				assert.strictEqual(matchesKey(emitted[0]!, "alt+shift+o"), false, JSON.stringify(chunks));
				assert.strictEqual(matchesKey(emitted[0]!, "up"), true, JSON.stringify(chunks));
				assert.strictEqual(parseKey(emitted[0]!), "up", JSON.stringify(chunks));
			} finally {
				buffer.destroy();
			}
		}
	});

	it("delivers ESC P (a DCS introducer to the buffer) after the flush timeout, and it is alt+shift+p", async () => {
		const { buffer, emitted } = openStdinBuffer();
		try {
			buffer.process("\x1bP");
			assert.deepStrictEqual(emitted, [], "waits for a DCS terminator until the timeout");
			await wait(60);
			assert.deepStrictEqual(emitted, ["\x1bP"]);
			assert.strictEqual(matchesKey(emitted[0]!, "alt+shift+p"), true);
			assert.strictEqual(parseKey(emitted[0]!), "shift+alt+p");
		} finally {
			buffer.destroy();
		}
	});

	it("delivers ESC X at once, and it is alt+shift+x", () => {
		const { buffer, emitted } = openStdinBuffer();
		try {
			buffer.process("\x1bX");
			assert.deepStrictEqual(emitted, ["\x1bX"]);
			assert.strictEqual(matchesKey(emitted[0]!, "alt+shift+x"), true);
		} finally {
			buffer.destroy();
		}
	});
});
