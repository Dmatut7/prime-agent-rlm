import stripAnsi from "strip-ansi";

/** The status pill of a box header: a glyph and one of its words, each side of it a space. */
const PILL = / (?:\S) (?:完成|出错|已停止|进行中) /;

/** Index of the box's header row (the one with the status pill) in a turn's rendered lines, or -1. */
export function headerIndex(lines: readonly string[]): number {
	return lines.findIndex((line) => PILL.test(stripAnsi(line)));
}

/** The box's header row, with its colors; "" when the lines have none. */
export function headerRaw(lines: readonly string[]): string {
	return lines[headerIndex(lines)] ?? "";
}

/** The box's header row as plain text; "" when the lines have none. */
export function headerPlain(lines: readonly string[]): string {
	return stripAnsi(headerRaw(lines)).replace(/\x1b_[^\x07]*\x07/g, "");
}
