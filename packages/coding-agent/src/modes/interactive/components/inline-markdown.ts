import { type ThemeColor, theme } from "../theme/theme.js";

/**
 * The inline markup of a sentence the AI wrote (`code`, **bold**, [text](url)) as the timeline
 * shows it: no backticks, no asterisks, no link address. A code span protects what is inside it,
 * so a glob in backticks stays whole; bold and a link's text may hold the other two; an unmatched
 * marker stays as typed. Nothing else is understood (italics, `__x__`, `~~x~~` and images stay as written).
 */

interface InlinePiece {
	text: string;
	bold: boolean;
	code: boolean;
}

/** The end of the run of `count` backticks that closes a span opened at `from`, or -1. */
function closingBackticks(text: string, from: number, count: number): number {
	for (let index = text.indexOf("`", from); index !== -1; ) {
		let end = index;
		while (text.charAt(end) === "`") end += 1;
		if (end - index === count) return index;
		index = text.indexOf("`", end);
	}
	return -1;
}

/** Where a link's address ends (the index of its closing parenthesis), parentheses inside it balanced; -1 when it never closes. */
function addressEnd(text: string, from: number): number {
	let depth = 1;
	for (let index = from; index < text.length; index++) {
		const char = text.charAt(index);
		if (/\s/.test(char)) return -1;
		if (char === "(") depth += 1;
		if (char === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/** A link at the start of `rest`: its text and how much of `rest` it takes. */
function linkAt(rest: string): { label: string; length: number } | undefined {
	const close = rest.indexOf("]");
	if (close < 2 || rest.slice(1, close).includes("\n") || rest.charAt(close + 1) !== "(") return undefined;
	const end = addressEnd(rest, close + 2);
	if (end === -1 || end === close + 2) return undefined;
	return { label: rest.slice(1, close), length: end + 1 };
}

function splitInline(text: string, bold = false): InlinePiece[] {
	const pieces: InlinePiece[] = [];
	let plain = "";
	const flush = (): void => {
		if (plain) pieces.push({ text: plain, bold, code: false });
		plain = "";
	};
	for (let index = 0; index < text.length; ) {
		const rest = text.slice(index);
		if (rest.startsWith("`")) {
			let ticks = 0;
			while (text.charAt(index + ticks) === "`") ticks += 1;
			const end = closingBackticks(text, index + ticks, ticks);
			if (end > index + ticks) {
				flush();
				pieces.push({ text: text.slice(index + ticks, end), bold, code: true });
				index = end + ticks;
				continue;
			}
			plain += "`".repeat(ticks);
			index += ticks;
			continue;
		}
		if (rest.startsWith("**")) {
			const end = text.indexOf("**", index + 2);
			const inner = end > index + 2 ? text.slice(index + 2, end) : "";
			if (inner && !/^\s|\s$/.test(inner) && !inner.includes("\n")) {
				flush();
				pieces.push(...splitInline(inner, true));
				index = end + 2;
				continue;
			}
		}
		const link = rest.startsWith("[") ? linkAt(rest) : undefined;
		if (link) {
			flush();
			pieces.push(...splitInline(link.label, bold));
			index += link.length;
			continue;
		}
		plain += text.charAt(index);
		index += 1;
	}
	flush();
	return merged(pieces);
}

/** Neighbouring pieces drawn alike are one piece. */
function merged(pieces: InlinePiece[]): InlinePiece[] {
	const out: InlinePiece[] = [];
	for (const piece of pieces) {
		const last = out.at(-1);
		if (last && last.bold === piece.bold && last.code === piece.code) last.text += piece.text;
		else out.push({ ...piece });
	}
	return out;
}

/**
 * Performance guard (tl2 FIX-D): splitInline rescans the remaining text for
 * every `[`, so a very long single line parses in O(n²). Past this many
 * characters a line is shown as plain text instead of parsed.
 */
export const INLINE_MARKDOWN_MAX_LENGTH = 4096;

/** The words with their inline markup taken out. */
export function stripInlineMarkdown(text: string): string {
	if (text.length > INLINE_MARKDOWN_MAX_LENGTH) return text;
	return splitInline(text)
		.map((piece) => piece.text)
		.join("");
}

/** The words in `color`, bold where the AI made them bold, code in the soft color. */
export function styleInlineMarkdown(text: string, color: ThemeColor): string {
	if (text.length > INLINE_MARKDOWN_MAX_LENGTH) return theme.fg(color, text);
	return splitInline(text)
		.map((piece) => {
			const painted = theme.fg(piece.code && color === "text" ? "timelineSoft" : color, piece.text);
			return piece.bold ? theme.bold(painted) : painted;
		})
		.join("");
}
