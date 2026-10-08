/**
 * ANSI escape code to HTML converter.
 *
 * Converts terminal ANSI color/style codes to HTML with inline styles.
 * Supports:
 * - Standard foreground colors (30-37) and bright variants (90-97)
 * - Standard background colors (40-47) and bright variants (100-107)
 * - 256-color palette (38;5;N and 48;5;N)
 * - RGB true color (38;2;R;G;B and 48;2;R;G;B)
 * - Text styles: bold (1), dim (2), italic (3), underline (4), inverse (7), strikethrough (9)
 * - Reset (0)
 *
 * Non-SGR sequences (OSC 8 links, erase/cursor CSI, charset designators, …)
 * carry no meaning in static HTML and are stripped rather than leaked as
 * visible garbage.
 */

const ANSI_COLORS = [
	"#000000", // 0: black
	"#800000", // 1: red
	"#008000", // 2: green
	"#808000", // 3: yellow
	"#000080", // 4: blue
	"#800080", // 5: magenta
	"#008080", // 6: cyan
	"#c0c0c0", // 7: white
	"#808080", // 8: bright black
	"#ff0000", // 9: bright red
	"#00ff00", // 10: bright green
	"#ffff00", // 11: bright yellow
	"#0000ff", // 12: bright blue
	"#ff00ff", // 13: bright magenta
	"#00ffff", // 14: bright cyan
	"#ffffff", // 15: bright white
];

/**
 * Convert 256-color index to hex.
 */
function color256ToHex(index: number): string {
	if (index < 16) {
		return ANSI_COLORS[index];
	}

	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toComponent = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		const toHex = (n: number) => toComponent(n).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

interface TextStyle {
	fg: string | null;
	bg: string | null;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
	strikethrough: boolean;
}

function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		inverse: false,
		strikethrough: false,
	};
}

function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];
	// Inverse swaps the effective colors; unresolved sides fall back to the
	// page's defaults so a bare \x1b[7m still inverts visibly.
	let fg = style.fg;
	let bg = style.bg;
	if (style.inverse) {
		const effectiveFg = fg ?? "var(--text)";
		const effectiveBg = bg ?? "var(--body-bg)";
		fg = effectiveBg;
		bg = effectiveFg;
	}
	if (fg) parts.push(`color:${fg}`);
	if (bg) parts.push(`background-color:${bg}`);
	if (style.bold) parts.push("font-weight:bold");
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	const decorations: string[] = [];
	if (style.underline) decorations.push("underline");
	if (style.strikethrough) decorations.push("line-through");
	if (decorations.length > 0) parts.push(`text-decoration:${decorations.join(" ")}`);
	return parts.join(";");
}

function hasStyle(style: TextStyle): boolean {
	return (
		style.fg !== null ||
		style.bg !== null ||
		style.bold ||
		style.dim ||
		style.italic ||
		style.underline ||
		style.inverse ||
		style.strikethrough
	);
}

/**
 * Parse ANSI SGR (Select Graphic Rendition) codes and update style.
 */
function applySgrCode(params: number[], style: TextStyle): void {
	let i = 0;
	while (i < params.length) {
		const code = params[i];

		if (code === 0) {
			style.fg = null;
			style.bg = null;
			style.bold = false;
			style.dim = false;
			style.italic = false;
			style.underline = false;
			style.inverse = false;
			style.strikethrough = false;
		} else if (code === 1) {
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 3) {
			style.italic = true;
		} else if (code === 4) {
			style.underline = true;
		} else if (code === 7) {
			style.inverse = true;
		} else if (code === 9) {
			style.strikethrough = true;
		} else if (code === 22) {
			style.bold = false;
			style.dim = false;
		} else if (code === 23) {
			style.italic = false;
		} else if (code === 24) {
			style.underline = false;
		} else if (code === 27) {
			style.inverse = false;
		} else if (code === 29) {
			style.strikethrough = false;
		} else if (code >= 30 && code <= 37) {
			style.fg = ANSI_COLORS[code - 30];
		} else if (code === 38) {
			if (params[i + 1] === 5 && params.length > i + 2) {
				style.fg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.fg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 39) {
			style.fg = null;
		} else if (code >= 40 && code <= 47) {
			style.bg = ANSI_COLORS[code - 40];
		} else if (code === 48) {
			if (params[i + 1] === 5 && params.length > i + 2) {
				style.bg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.bg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 49) {
			style.bg = null;
		} else if (code >= 90 && code <= 97) {
			style.fg = ANSI_COLORS[code - 90 + 8];
		} else if (code >= 100 && code <= 107) {
			style.bg = ANSI_COLORS[code - 100 + 8];
		}

		i++;
	}
}

const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

/**
 * Every escape sequence that is not an SGR style: OSC/DCS/SOS/PM/APC string
 * sequences (OSC 8 links, window titles, clipboard writes), CSI sequences with
 * a non-`m` final byte (erase, cursor, scroll), charset designators, and plain
 * two-byte escapes. None of them have a static-HTML meaning; left in place
 * their bytes render as visible `]8;;…` garbage.
 */
const NON_SGR_ESCAPE_REGEX =
	/\x1b[\]P_X^][^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|\x9b[0-?]*[ -/]*[@-Za-ln-~]|\x1b\[[0-?]*[ -/]*[@-Za-ln-~]|\x1b[()#%][0-9A-Za-z]|\x1b[0-?@-Z\\-_]/g;

/**
 * Convert ANSI-escaped text to HTML with inline styles.
 */
export function ansiToHtml(text: string): string {
	const cleaned = text.replace(NON_SGR_ESCAPE_REGEX, "");
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;

	ANSI_REGEX.lastIndex = 0;

	let match = ANSI_REGEX.exec(cleaned);
	while (match !== null) {
		const beforeText = cleaned.slice(lastIndex, match.index);
		if (beforeText) {
			result += escapeHtml(beforeText);
		}

		const paramStr = match[1];
		const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];

		if (inSpan) {
			result += "</span>";
			inSpan = false;
		}

		applySgrCode(params, style);

		if (hasStyle(style)) {
			result += `<span style="${styleToInlineCSS(style)}">`;
			inSpan = true;
		}

		lastIndex = match.index + match[0].length;
		match = ANSI_REGEX.exec(cleaned);
	}

	const remainingText = cleaned.slice(lastIndex);
	if (remainingText) {
		result += escapeHtml(remainingText);
	}

	if (inSpan) {
		result += "</span>";
	}

	return result;
}

/**
 * Convert array of ANSI-escaped lines to HTML.
 * Each line is wrapped in a div element.
 */
export function ansiLinesToHtml(lines: string[]): string {
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("");
}
