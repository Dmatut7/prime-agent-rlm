/**
 * Text leaving the process in a persisted message (a transcript errorMessage, a
 * structured log line) must not carry terminal control characters: an ESC the
 * renderer passes through re-enters the terminal as an escape sequence, a BEL
 * rings, a CR rewinds the row. ANSI escape sequences are removed whole first so
 * their payload bytes do not survive as visible litter; `\n` and `\t` stay
 * (they are payload shape, not control).
 */

/** CSI/OSC-with-BEL-or-ST, the shapes a CLI's progress and color output takes. */
const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g;

/** C0 (minus \n \t), DEL, and the C1 range. */
const CONTROL_CHARACTER = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function stripControlCharacters(text: string): string {
	return text.replace(ANSI_SEQUENCE, "").replace(CONTROL_CHARACTER, "");
}
