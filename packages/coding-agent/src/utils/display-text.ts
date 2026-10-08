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
