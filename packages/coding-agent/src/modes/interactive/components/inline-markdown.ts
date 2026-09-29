import { type ThemeColor, theme } from "../theme/theme.js";

/**
 * The inline markup of a sentence the AI wrote (`code`, **bold**, [text](url)) as the timeline
 * shows it: no backticks, no asterisks, no link address. A code span protects what is inside it,
 * so a glob in backticks stays whole; an unmatched marker stays as typed.
 */

interface InlinePiece {
	text: string;
	kind: "plain" | "bold" | "code";
}

const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

function splitInline(text: string): InlinePiece[] {
	const pieces: InlinePiece[] = [];
	let plain = "";
	const flush = (): void => {
		if (plain) pieces.push({ text: plain, kind: "plain" });
		plain = "";
	};
	for (let index = 0; index < text.length; ) {
		const rest = text.slice(index);
		if (rest.startsWith("`")) {
			const end = text.indexOf("`", index + 1);
			if (end > index + 1) {
				flush();
				pieces.push({ text: text.slice(index + 1, end), kind: "code" });
				index = end + 1;
				continue;
			}
		}
		if (rest.startsWith("**")) {
			const end = text.indexOf("**", index + 2);
			const inner = end > index + 2 ? text.slice(index + 2, end) : "";
			if (inner && !/^\s|\s$/.test(inner) && !inner.includes("\n")) {
				flush();
				pieces.push({ text: inner.replace(/`/g, ""), kind: "bold" });
				index = end + 2;
				continue;
			}
		}
		const link = rest.startsWith("[") ? LINK.exec(rest) : null;
		if (link) {
			plain += link[1] ?? "";
			index += link[0].length;
			continue;
		}
		plain += text.charAt(index);
		index += 1;
	}
	flush();
	return pieces;
}

/** The words with their inline markup taken out. */
export function stripInlineMarkdown(text: string): string {
	return splitInline(text)
		.map((piece) => piece.text)
		.join("");
}

/** The words in `color`, bold where the AI made them bold, code in the soft color. */
export function styleInlineMarkdown(text: string, color: ThemeColor): string {
	return splitInline(text)
		.map((piece) => {
			if (piece.kind === "bold") return theme.bold(theme.fg(color, piece.text));
			return theme.fg(piece.kind === "code" && color === "text" ? "timelineSoft" : color, piece.text);
		})
		.join("");
}
