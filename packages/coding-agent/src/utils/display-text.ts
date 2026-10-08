import { sanitizeRenderText } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";

/**
 * The wash for the render faces that build their own lines - timeline rows, dock
 * chips, table cells, tool-call headers, recap strings - instead of handing their
 * text to `Text`, whose render is the central gate. `Text` keeps the SGR and OSC 8
 * codes a component painted with; a face that interpolates model-controlled text
 * (a subagent's name, a report, a command, a file path) into its own styled string
 * painted nothing of the kind, so no escape sequence may survive: an OSC 52 writes
 * the user's clipboard, a CSI J clears the screen, a bare BEL rings and a CR
 * rewinds the row. `sanitizeRenderText` drops every sequence but those two and
 * every control character but `\n` and `\t`; `stripAnsi` takes the two of them
 * that are left.
 */
function stripEscapesAndControls(text: string): string {
	return stripAnsi(sanitizeRenderText(text));
}

/**
 * Text for one physical row. A row that carries a newline is two physical lines
 * where the caller's line accounting expects one, so whitespace runs collapse.
 */
export function sanitizeRowText(text: string): string {
	return stripEscapesAndControls(text).replace(/\s+/g, " ").trim();
}

/**
 * Text for a face that keeps its own line breaks: escapes and control characters
 * gone, newlines kept, a tab the four spaces the diff rows already widen it to.
 */
export function sanitizeBlockText(text: string): string {
	return stripEscapesAndControls(text).replace(/\t/g, "    ");
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * First `maxGraphemes` graphemes of `text`, plus `ellipsis` when anything was cut.
 * A code-unit slice (`text.slice(0, n)`) can leave half of a surrogate pair or a
 * ZWJ sequence, which downstream encoding renders as U+FFFD litter.
 */
export function truncateGraphemes(text: string, maxGraphemes: number, ellipsis = "..."): string {
	const budget = Math.max(0, maxGraphemes);
	// Code units upper-bound graphemes, so a short-enough string needs no segmenting.
	if (text.length <= budget) return text;
	let end = 0;
	let count = 0;
	for (const { index, segment } of graphemeSegmenter.segment(text)) {
		if (count === budget) break;
		end = index + segment.length;
		count++;
	}
	if (end >= text.length) return text;
	return `${text.slice(0, end)}${ellipsis}`;
}

/**
 * `text` cut to at most `maxChars` code units, at a grapheme boundary. A plain
 * `slice(0, n)` can leave half a surrogate pair, and the terminal shows the
 * U+FFFD replacement glyph where the cut was.
 */
export function sliceGraphemes(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	if (text.length <= maxChars) return text;
	let end = 0;
	for (const { segment, index } of graphemeSegmenter.segment(text)) {
		const next = index + segment.length;
		if (next > maxChars) break;
		end = next;
	}
	return text.slice(0, end);
}
