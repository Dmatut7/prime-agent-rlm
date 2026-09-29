import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { type KeyId, matchesKey, parseKey, setKittyProtocolActive } from "../src/keys.js";

const LETTERS = [..."abcdefghijklmnopqrstuvwxyz"];

/** What a terminal without extended keys sends for Alt+Shift+letter: ESC plus the uppercase letter. */
const legacyAltShift = (letter: string): string => `\x1b${letter.toUpperCase()}`;

describe("legacy ESC B and ESC F stay word movement", () => {
	beforeEach(() => setKittyProtocolActive(false));
	afterEach(() => setKittyProtocolActive(false));

	it("ESC B is alt+left and not alt+shift+b, ESC F is alt+right and not alt+shift+f", () => {
		assert.strictEqual(matchesKey("\x1bB", "alt+shift+b"), false);
		assert.strictEqual(matchesKey("\x1bB", "shift+alt+b"), false);
		assert.strictEqual(matchesKey("\x1bF", "alt+shift+f"), false);
		assert.strictEqual(matchesKey("\x1bF", "shift+alt+f"), false);
		assert.strictEqual(matchesKey("\x1bB", "alt+left"), true);
		assert.strictEqual(matchesKey("\x1bF", "alt+right"), true);
	});

	it("matchesKey and parseKey agree on ESC plus every uppercase letter", () => {
		assert.strictEqual(LETTERS.length, 26);
		const candidates: KeyId[] = [
			...LETTERS.map((letter) => `alt+shift+${letter}` as KeyId),
			...LETTERS.map((letter) => `shift+alt+${letter}` as KeyId),
			"alt+left",
			"alt+right",
		];
		for (const letter of LETTERS) {
			const data = legacyAltShift(letter);
			const named = letter === "b" ? "alt+left" : letter === "f" ? "alt+right" : `shift+alt+${letter}`;
			assert.strictEqual(parseKey(data), named, `parseKey ${JSON.stringify(data)}`);
			const matching = letter === "b" || letter === "f" ? [named] : [`alt+shift+${letter}`, `shift+alt+${letter}`];
			for (const candidate of candidates) {
				assert.strictEqual(
					matchesKey(data, candidate),
					matching.includes(candidate),
					`matchesKey(${JSON.stringify(data)}, ${candidate}) with parseKey = ${named}`,
				);
			}
		}
	});
});
