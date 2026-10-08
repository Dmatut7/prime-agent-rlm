import { Lexer, Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens, type TokensList } from "marked";
import { latexToUnicode } from "../latex.js";
import {
	extractTableCellSelectionRegions,
	markTableCell,
	markTableEnd,
	markTableStart,
	type TableCellSelectionRegion,
} from "../selection-metadata.js";
import { getCapabilities, getCapabilitiesVersion, hyperlink, isImageLine } from "../terminal-image.js";
import type { Component } from "../tui.js";
import { applyBackgroundToLine, sanitizeRenderText, stripAnsi, visibleWidth, wrapTextWithAnsi } from "../utils.js";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

interface MathToken {
	type: "blockMath" | "inlineMath";
	raw: string;
	/** Raw LaTeX source without the delimiters. */
	text: string;
}

// Math must tokenize before marked's escape/emphasis handling, or \[ collapses
// to [ and underscores inside formulas become italics. Unterminated delimiters
// never match, so partially streamed math stays plain text until the closing
// delimiter arrives. Leading indentation is consumed because models often
// indent display math, which would otherwise lex as an indented code block.
const BLOCK_MATH_REGEX = /^[ \t]*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/;

function minIndex(a: number, b: number): number | undefined {
	if (a === -1) {
		return b === -1 ? undefined : b;
	}
	return b === -1 ? a : Math.min(a, b);
}

const blockMathExtension: TokenizerExtension = {
	name: "blockMath",
	level: "block",
	// start() runs on every paragraph continuation; scanning only the current
	// paragraph keeps it cheap, and later math is caught at its block boundary.
	start: (src: string) => {
		const paragraphEnd = src.indexOf("\n\n");
		const window = paragraphEnd === -1 ? src : src.slice(0, paragraphEnd);
		return minIndex(window.indexOf("$$"), window.indexOf("\\["));
	},
	tokenizer(src: string): Tokens.Generic | undefined {
		const first = src.charCodeAt(0);
		if (first !== 0x24 /* $ */ && first !== 0x5c /* \ */ && first !== 0x20 /* space */ && first !== 0x09 /* tab */) {
			return undefined;
		}
		const match = BLOCK_MATH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}
		const token: MathToken = { type: "blockMath", raw: match[0], text: (match[1] ?? match[2]).trim() };
		return token;
	},
};

// $...$ uses the pandoc/GitHub rules to avoid matching prose dollar amounts:
// the opening $ must be followed by a non-space, the closing $ preceded by a
// non-space and not followed by a digit ("between $5 and $10" never matches).
const INLINE_MATH_PATTERNS = [
	/^\$\$([\s\S]+?)\$\$/, // display math used mid-paragraph
	/^\\\[([\s\S]+?)\\\]/,
	/^\\\(([\s\S]+?)\\\)/,
	/^\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/,
];

const inlineMathExtension: TokenizerExtension = {
	name: "inlineMath",
	level: "inline",
	// Only "$" needs a start() hint: backslashes already terminate text runs,
	// but the text tokenizer would swallow a bare "$" without one.
	start: (src: string) => {
		const index = src.indexOf("$");
		return index === -1 ? undefined : index;
	},
	tokenizer(src: string): Tokens.Generic | undefined {
		const first = src.charCodeAt(0);
		if (first !== 0x24 /* $ */ && first !== 0x5c /* \ */) {
			return undefined;
		}
		for (const pattern of INLINE_MATH_PATTERNS) {
			const match = pattern.exec(src);
			if (match) {
				const token: MathToken = { type: "inlineMath", raw: match[0], text: match[1].trim() };
				return token;
			}
		}
		return undefined;
	},
};

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

// Registered extensions measurably slow marked's lexing even when they never
// match, so math-free text (the common case) uses a parser without them.
const mathMarkdownParser = new Marked();
mathMarkdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});
mathMarkdownParser.use({ extensions: [blockMathExtension, inlineMathExtension] });

function pickMarkdownParser(text: string): Marked {
	return text.includes("$") || text.includes("\\(") || text.includes("\\[") ? mathMarkdownParser : markdownParser;
}

/**
 * Block tokens from the last successful lex plus a verified resume offset.
 * When the next text only changes after that offset (the streaming-append
 * shape), only the tail is re-lexed and the prefix tokens are reused.
 */
/**
 * One per-block render cache entry. Slot i holds the lines rendered for
 * top-level token i; a slot hits only when the token object is identical
 * (the lex cache reuses prefix token objects across streaming frames, and
 * tail tokens are always fresh objects), and the width, following-block type
 * and capabilities version all match. Keying on the token identity instead of
 * its raw text also catches tokens whose raw is unchanged while their inline
 * text changes (marked's lazy-continuation truncation).
 */
interface BlockSlot {
	token: Token;
	width: number;
	nextType: string | undefined;
	capsVersion: number;
	lines: string[];
}

interface LexCache {
	/** CR/tab-normalized text that produced the tokens. */
	text: string;
	/** Tokens tiling [0, cut); reused verbatim while the prefix is unchanged. */
	tokens: Token[];
	/** Resume offset; 0 disables reuse. */
	cut: number;
	/** text.slice(0, cut), so the per-frame reuse check is one startsWith. */
	prefix: string;
}

/**
 * Sealed line prefix of the growing final block. While a single block (one
 * paragraph, one fence, one list) streams in, the block is never blank-line
 * terminated, so the lex cache and the per-block slots never apply and the
 * whole block would be re-rendered every frame (O(n^2) per answer). Completed
 * lines (paragraph/code) or completed items (list, see FinalListSeal) whose
 * rendering later text cannot change are sealed: rendered once, then served
 * from this cache while the per-frame validation holds. Sealing never destroys
 * the source text: width changes, invalidate(), edits and every validation
 * failure fall back to the full render path.
 */
interface FinalBlockSeal {
	blockType: "paragraph" | "code";
	/** Sealed prefix of the block token's text; always ends right after a "\n". */
	source: string;
	/** Offset in token.text where the unsealed tail begins (== source.length). */
	tailFrom: number;
	/** Fully post-processed block lines (wrap, margins, padding) for the prefix. */
	lines: string[];
	width: number;
	capsVersion: number;
	/**
	 * Wrap-level seal of the growing (newline-free) tail line: the sealed prefix
	 * of the line's rendered string. Engages only while the rendered line is
	 * plain text (no ANSI): wrapped pieces of a plain append-only string are
	 * append-stable except the last one, and pieces re-wrapped from a piece
	 * boundary are byte-identical to the full wrap (greedy fill restarts from
	 * an empty line with a clean ANSI tracker).
	 */
	wrapSealedW?: string;
	/** Padded block lines produced for wrapSealedW. */
	wrapLines?: string[];
	/**
	 * The growing line's whole rendered string as of the previous frame. The
	 * wrap seal assumes the line is append-only; inline re-typing (a math or
	 * emphasis opener gaining its closer) can rewrite the rendered tail past
	 * the sealed prefix while leaving wrapSealedW itself a prefix, so the
	 * per-frame check compares against this, not against wrapSealedW.
	 */
	wrapPrevW?: string;
	/** Latched when the growing line's rendered string contains ANSI codes. */
	wrapIneligible?: boolean;
	/**
	 * Paragraph seals only: incremental state for the per-frame validation
	 * scans. The scan* fields fold lastSealableParagraphOffset results covering
	 * offsets <= scanFrom, and the boundary* fields record the token covering
	 * the seal boundary so paragraphSealIntact is O(1). Both are trusted only
	 * while the split-lex epoch matches, which guarantees the covered region's
	 * bytes and token identities are unchanged.
	 */
	scanEpoch?: number;
	scanFrom?: number;
	scanBest?: number;
	scanBestIndex?: number;
	scanBestStart?: number;
	scanBestEnd?: number;
	scanBestToken?: Token;
	boundaryEpoch?: number;
	boundaryTailFrom?: number;
	boundaryIndex?: number;
	boundaryStart?: number;
	boundaryEnd?: number;
	boundaryToken?: Token;
}

/**
 * Sealed item prefix of the growing final list. Items [0, count) are rendered
 * once into lines; the item at count (the growing tail) is re-rendered every
 * frame. Item rendering is context-free given the item source, so the seal is
 * valid exactly while the sealed item raws stay byte-identical and bounded by
 * item starts (listSealIntact): an absorption rewrite (a partial bullet
 * collapsing into the previous item, a blank/indented block landing inside an
 * item) shifts an item raw and is caught, and a loose flip (token.loose
 * changes) re-types every item's block tokens, which also forces a re-seal.
 */
interface FinalListSeal {
	blockType: "list";
	/** Concatenated raws of the sealed items; a prefix of the list raw. */
	source: string;
	/** Number of sealed items; the item at this index is the live tail. */
	count: number;
	/** List loose flag when the seal was built. */
	loose: boolean;
	/** Fully post-processed block lines (wrap, margins, padding) for the items. */
	lines: string[];
	width: number;
	capsVersion: number;
}

// Inline constructs whose rendering appends the default style prefix after the
// construct's reset. A seal boundary immediately after one of these would make
// the sealed prefix render trim a style restore that the full render keeps.
const STYLE_PREFIX_CONSTRUCTS = new Set(["strong", "em", "codespan", "link", "del", "inlineMath"]);

/**
 * Latest offset where re-lexing the text from that point reproduces the token
 * stream a full re-lex would produce, for any text that keeps this prefix. The
 * boundary must sit at a token start (block tokens tile the text exactly) and
 * pass isStableLexBoundary. Returns 0 when no boundary qualifies or the tokens
 * do not tile the text exactly.
 */
/** A block start opening display math: optional indent, then "$$" or "\[". */
const BLOCK_MATH_OPEN_REGEX = /^[ \t]*(?:\$\$|\\\[)/;

/**
 * Whether a kept token can still be re-typed by display math once a closer
 * streams in. The math parser's BLOCK_MATH_REGEX allows any indent (the
 * extension preempts indented code) and spans blank lines (`[\s\S]+?` content),
 * so an opener lexed as plain content pairs with the first valid closer
 * anywhere after it. marked's startBlock clipping splits paragraphs at every
 * "$$"/"\[" its start() sees, and when blockMath does not (yet) match the two
 * halves merge back into one paragraph token — so in a kept paragraph/text raw
 * an opener can hide ANYWHERE, while every other token type can only be
 * re-typed by a match starting at its raw start. A token lexed AS blockMath is
 * final (its closer is in) and never suspect.
 */
function hasDanglingBlockMathOpener(token: Token, raw: string): boolean {
	if (token.type === "blockMath") {
		return false;
	}
	if (token.type === "paragraph" || token.type === "text") {
		return raw.includes("$$") || raw.includes("\\[");
	}
	return BLOCK_MATH_OPEN_REGEX.test(raw);
}

function computeLexCut(tokens: Token[], text: string): { cut: number; kept: number } {
	// First token holding an unmatched blockMath opener: cuts at or after it are
	// unstable (see hasDanglingBlockMathOpener), so boundaries past it never
	// qualify.
	let mathOpen = -1;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const raw = token?.raw;
		if (token !== undefined && typeof raw === "string" && hasDanglingBlockMathOpener(token, raw)) {
			mathOpen = i;
			break;
		}
	}
	let pos = 0;
	let cut = 0;
	let kept = 0;
	for (let i = 0; i < tokens.length; i++) {
		const raw = tokens[i]?.raw;
		if (typeof raw !== "string") {
			return { cut: 0, kept: 0 };
		}
		if (i > 0 && (mathOpen === -1 || i <= mathOpen) && isStableLexBoundary(tokens, i, text, pos)) {
			cut = pos;
			kept = i;
		}
		pos += raw.length;
	}
	if (pos !== text.length) {
		return { cut: 0, kept: 0 };
	}
	return { cut, kept };
}

/**
 * A token start is reusable only while it stays a token start as the tail
 * grows. Three conditions hold at every stable boundary:
 * - a blank line ends the kept region, so no lazy continuation and no
 *   single-newline merge (marked folds those into a trailing paragraph/text
 *   token) can reach back across it;
 * - the tail starts with non-whitespace, because indented content after a
 *   blank line continues a preceding list (or forms an indented code block),
 *   and such boundaries move while the text grows;
 * - the nearest non-space kept block is not a list/html block, because those
 *   absorb blank-line-separated content as they grow.
 * Token starts near a growing end are unstable (a partial final line can
 * re-split; lists re-absorb separated items once their line completes), so
 * boundaries that fail any check are never reused.
 */
function isStableLexBoundary(tokens: Token[], i: number, text: string, cut: number): boolean {
	if (cut < 2 || text[cut - 2] !== "\n" || text[cut - 1] !== "\n") {
		return false;
	}
	const first = text[cut];
	if (first === " " || first === "\t" || first === "\n") {
		return false;
	}
	for (let j = i - 1; j >= 0; j--) {
		const type = tokens[j].type;
		if (type === "space") {
			continue;
		}
		return type !== "list" && type !== "html";
	}
	return true;
}

function buildLexCache(normalizedText: string, tokens: TokensList): LexCache {
	if (Object.keys(tokens.links ?? {}).length > 0) {
		// Reference definitions let a later block change how an earlier one
		// renders (an appended definition can resolve an earlier reference),
		// so documents containing them always re-lex in full.
		return { text: normalizedText, tokens: [], cut: 0, prefix: "" };
	}
	const { cut, kept } = computeLexCut(tokens, normalizedText);
	if (cut === 0) {
		return { text: normalizedText, tokens: [], cut: 0, prefix: "" };
	}
	return { text: normalizedText, tokens: tokens.slice(0, kept), cut, prefix: normalizedText.slice(0, cut) };
}

/**
 * Split-lex state for a single growing final paragraph. The block-level lex
 * cache can only reuse tokens up to a blank-line boundary, so a paragraph that
 * never contains one (a long streamed answer, a growing wrapped line) is
 * re-lexed in full on every frame — the dominant per-frame cost left after
 * line sealing. While the guards documented on trySplitLex hold, only the
 * unverified tail after `cut` is lexed; the inline prefix tokens are reused.
 */
interface SplitLex {
	/** The block-cache cut this state was built against; any drift invalidates. */
	baseCut: number;
	/** Source offset where the growing paragraph starts. */
	paraFrom: number;
	/** Source offset the verified inline prefix tiles up to; the tail starts here. */
	cut: number;
	/** Inline tokens tiling [paraFrom, cut); verified span-safe (see findSafeInlineCut). */
	prefixTokens: Token[];
	/** normalizedText.slice(0, cut), for the per-frame append check. */
	prefix: string;
	/** Bootstrap generation; a re-bootstrap bumps it, dropping incremental seal state keyed on a previous generation's byte/token stability. */
	epoch: number;
	/** Last splice result built from prefixTokens; reused in place while prefixTokens is unchanged (see spliceInlineTokens). */
	spliced?: Token[];
	/** The prefixTokens array spliced was built from. */
	splicedPrefix?: Token[];
}

/**
 * Facts about the inline token stream trySplitLex produced for the current
 * frame. Inline tokens below cutRel are byte- and object-stable across frames
 * of the same epoch (the split prefix invariant), which lets the paragraph
 * seal resume its per-frame validation scans at the junction instead of
 * re-walking the verified prefix.
 */
interface SplitLexFrame {
	epoch: number;
	/** split.cut - split.paraFrom: verified prefix length in paragraph-text offsets. */
	cutRel: number;
	/** Index of the first non-verified token (the merged junction token when the splice merged). */
	junctionIndex: number;
	/** Text offset where inlineTokens[junctionIndex] starts. */
	junctionStart: number;
}

/**
 * Split-lex state for a single growing final list. The block-level lex cache
 * can only cut before the list (a boundary after a kept list is unstable), so
 * a list that streams item by item would be re-lexed in full on every frame.
 * Item starts recorded from a full lex are stable cut points: the line at the
 * cut already begins with a complete marker, so it stays an item start under
 * any append. While the guards on trySplitListLex hold, only the tail from the
 * last item boundary is lexed; the prefix item tokens are reused.
 */
interface ListSplitLex {
	/** The block-cache cut this state was built against; any drift invalidates. */
	baseCut: number;
	/** Source offset where the growing final list starts. */
	listFrom: number;
	/** Source offset of the first non-verified item start; the tail begins here. */
	cut: number;
	/** Item tokens tiling [listFrom, cut). */
	prefixItems: Tokens.ListItem[];
	ordered: boolean;
	start: number | "";
	loose: boolean;
	/** normalizedText.slice(0, cut), for the per-frame append check. */
	prefix: string;
}

/** Below this block size a full lex is cheap enough that splitting adds only overhead. */
const MIN_SPLIT_LEX_BLOCK_CHARS = 4096;

/**
 * Characters that can open an inline construct spanning the split point. A
 * matched pair lives inside a closed construct token (stable); these chars in
 * a *text* token are unmatched delimiters a later frame could still claim.
 */
const INLINE_DELIM_CHARS = new Set(["*", "_", "`", "[", "<", "$", "~", "\\"]);

/**
 * Escape tokens whose raw is a math delimiter are potential openers, not closed
 * constructs: while the formula is unterminated they lex as plain escapes (so
 * they pass the construct check in findSafeInlineCut), but a closer arriving in
 * the tail pairs with them across the cut and the spliced stream keeps the
 * escape while a full re-lex produces inlineMath. Treat them like unmatched
 * delimiters: no cut at or after them until the formula completes.
 */
const MATH_DELIMITER_ESCAPES = new Set(["\\(", "\\[", "\\)", "\\]"]);

/**
 * marked's emStrong/del tokenizers scan a masked copy of the whole inline text
 * (Lexer.inlineTokens): escape pairs become "++" and every link/codespan/html
 * span becomes a same-length "[aa...]" placeholder, so emphasis delimiters
 * inside those spans never pair. The masked spans are decided by a global
 * left-to-right scan, so later text can pair a backtick run that is unmasked
 * today, extending a mask span over earlier content and re-typing emphasis
 * there while no token crosses the affected region. Reusing earlier inline
 * tokens (line seal, split lex) is sound only while no such unmasked run
 * exists; once the run pairs, the mask is whole again and those paths
 * re-engage from the corrected tokens. The masking uses marked's own rules so
 * the check cannot drift from the tokenizer (the gfm ruleset the parsers here
 * run with; blockSkip/anyPunctuation are shared with the normal ruleset).
 */
const EMPHASIS_MASK_PUNCTUATION = Lexer.rules.inline.gfm.anyPunctuation;
const EMPHASIS_MASK_BLOCK_SKIP = Lexer.rules.inline.gfm.blockSkip;

function emphasisMask(text: string): string {
	return text
		.replace(EMPHASIS_MASK_PUNCTUATION, "++")
		.replace(
			EMPHASIS_MASK_BLOCK_SKIP,
			(match: string, _labelGroup: string | undefined, precodeGroup: string | undefined) => {
				const pre = precodeGroup === undefined ? 0 : precodeGroup.length;
				return `${match.slice(0, pre)}[${"a".repeat(match.length - pre - 2)}]`;
			},
		);
}

/** Whether the emphasis mask of `text` leaves a backtick run unpaired. */
function hasUnmaskedBacktick(text: string): boolean {
	if (!text.includes("`")) {
		return false;
	}
	return emphasisMask(text).includes("`");
}

/**
 * Whether an emphasis construct's content holds a link or tag opener that
 * later text can still claim. strong/em tokens exist only because marked's
 * emphasis mask left their delimiters visible; a "[" or "<" in their plain
 * content starts a mask span the moment the tail completes the link or tag,
 * hiding those delimiters again — the construct un-types without any token
 * crossing the point the prefix was verified at. Closed child constructs
 * (links, codespans, math) are stable shells that never expose their
 * internals, so only nested emphasis and plain text are examined.
 */
function emphasisContentHasOpenBracket(tokens: Token[] | undefined): boolean {
	if (!tokens) {
		return false;
	}
	for (const token of tokens) {
		if (token.type === "strong" || token.type === "em" || token.type === "del") {
			if (emphasisContentHasOpenBracket((token as { tokens?: Token[] }).tokens)) {
				return true;
			}
			continue;
		}
		if (token.type === "text") {
			const text = (token as { text?: unknown }).text;
			if (typeof text === "string" && (text.includes("[") || text.includes("<"))) {
				return true;
			}
			if (emphasisContentHasOpenBracket((token as { tokens?: Token[] }).tokens)) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Rightmost split offset inside the paragraph's inline token stream where a
 * splice reproduces a full re-lex exactly, or undefined when none qualifies:
 * - the cut sits inside a plain text token (type text, text === raw, no child
 *   tokens) or right at its end, with a whitespace character immediately
 *   before it. The whitespace rule keeps word-shaped constructs (autolinks,
 *   emails) from spanning the cut: they cannot contain whitespace, and probe
 *   P4 (marked 18.0.7) shows start-of-tail is flank-equivalent to a space for
 *   emphasis/codespan/link/del openers;
 * - every text token in [minRel, cut) is plain and free of INLINE_DELIM_CHARS,
 *   so no unmatched opener waits in the prefix for a closer in the tail, and
 *   every strong/em/del token is free of nested link/tag openers, so no mask
 *   span completed in the tail can un-type it (emphasisContentHasOpenBracket);
 * - minRel onward is the only region examined: [0, minRel) was verified when
 *   the cut last advanced, and the check there is inductive.
 */
function findSafeInlineCut(tokens: Token[], text: string, minRel: number): number | undefined {
	let pos = 0;
	let candidate: number | undefined;
	let prefixClean = true;
	for (const token of tokens) {
		const raw = (token as { raw?: unknown }).raw;
		if (typeof raw !== "string") {
			return undefined;
		}
		const start = pos;
		const end = pos + raw.length;
		pos = end;
		if (end <= minRel) {
			continue;
		}
		if (token.type !== "text") {
			// An unmatched math delimiter lexes as an escape token; it can still be
			// claimed by a closer in the tail, so nothing past it is a safe cut.
			if (token.type === "escape" && MATH_DELIMITER_ESCAPES.has(raw)) {
				prefixClean = false;
				// A cut exactly at the escape start makes the tail lex begin with the
				// delimiter, and marked's block-math interrupt inserts a paragraph
				// break before a mid-paragraph \[ that a tail-anchored lex never
				// reproduces (a "\n" before it suppresses the break on both sides).
				if (candidate === start && text[start - 1] !== "\n") {
					candidate = undefined;
				}
			}
			// Closed construct: append-stable unless the tail can still re-type it
			// through the emphasis mask (emphasisContentHasOpenBracket); no cut
			// inside either way.
			if (
				(token.type === "strong" || token.type === "em" || token.type === "del") &&
				emphasisContentHasOpenBracket((token as { tokens?: Token[] }).tokens)
			) {
				prefixClean = false;
			}
			// A "$$" or "\[" inside ANY prefix token (inlineMath, codespan, ...)
			// is a block-level opener the spliced single-paragraph stream hides
			// from marked's startBlock interruption; a closer in the tail would
			// re-type the block from that opener. Text tokens are already covered
			// by INLINE_DELIM_CHARS ("$" and "\").
			if (raw.includes("$$") || raw.includes("\\[")) {
				prefixClean = false;
			}
			continue;
		}
		const plain = (token as { text?: unknown }).text === raw;
		const from = Math.max(start, minRel);
		let delim = -1;
		for (let i = from - start; i < raw.length; i++) {
			if (INLINE_DELIM_CHARS.has(raw[i])) {
				delim = i;
				break;
			}
		}
		if (plain && prefixClean) {
			// j may sit at the token end only when a later token follows
			// (non-empty tail is required either way).
			const hi = Math.min(delim === -1 ? end : start + delim, text.length - 1);
			for (let j = hi; j > from; j--) {
				const before = text[j - 1];
				if (before === " " || before === "\n") {
					candidate = j;
					break;
				}
			}
		}
		if (delim !== -1) {
			prefixClean = false;
		}
	}
	return pos === text.length ? candidate : undefined;
}

/**
 * Concatenate the verified inline prefix with the freshly lexed tail tokens.
 * When both sides of the junction are text tokens they must merge into one: a
 * full lex produces a single text token across the junction, and two adjacent
 * tokens render differently from one once a default text style wraps each in
 * its own ANSI pair. `reused` is the previous frame's result, built from the
 * same prefix array (caller-verified by identity): the junction is re-merged
 * and the new tail appended in place instead of spreading the whole prefix
 * every frame. The previous frame is done with the array then, and no token
 * objects are mutated.
 */
function spliceInlineTokens(prefix: Token[], tail: Token[], reused?: Token[]): Token[] | undefined {
	const last = prefix[prefix.length - 1];
	const first = tail[0];
	let merged: Token | undefined;
	if (last?.type === "text" && first?.type === "text") {
		const lastRaw = (last as { raw?: unknown }).raw;
		const firstRaw = (first as { raw?: unknown }).raw;
		const lastText = (last as { text?: unknown }).text;
		const firstText = (first as { text?: unknown }).text;
		if (
			typeof lastRaw !== "string" ||
			typeof firstRaw !== "string" ||
			typeof lastText !== "string" ||
			typeof firstText !== "string"
		) {
			return undefined;
		}
		merged = { type: "text", raw: lastRaw + firstRaw, text: lastText + firstText } as Token;
	}
	if (reused !== undefined && prefix.length > 0) {
		// Everything below prefix.length - 1 is the unchanged shared prefix.
		reused.length = prefix.length - 1;
		if (merged) {
			reused.push(merged);
			for (let i = 1; i < tail.length; i++) {
				reused.push(tail[i]);
			}
		} else {
			reused.push(last);
			for (const token of tail) {
				reused.push(token);
			}
		}
		return reused;
	}
	if (merged) {
		return [...prefix.slice(0, -1), merged, ...tail.slice(1)];
	}
	return [...prefix, ...tail];
}

/** A setext underline absorbs the whole preceding paragraph (probe E1/E9). */
const SETEXT_LINE_REGEX = /^ {0,3}(?:=+|-+) *$/;
/**
 * A table delimiter row re-types the preceding line as a table header (probe
 * E4); alone at a tail start it lexes as plain paragraph text instead.
 */
const TABLE_DELIM_LINE_REGEX = /^ {0,3}\|?[ :|-]*-[ :|-]*$/;

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	color?: (text: string) => string;
	bgColor?: (text: string) => string;
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	codeBlockIndent?: string;
	math?: (text: string) => string;
	mathBlock?: (text: string) => string;
}

export interface MarkdownOptions {
	/** Transform source Markdown before parsing, with the exact width available for content. */
	transform?: (markdown: string, availableWidth: number) => string;
	/** Base URL for relative link targets. Directory URLs must end with a slash. */
	baseUrl?: string;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

/**
 * How a rendered list-item line relates to its parent bullet:
 * - "text": plain item content, gets the bullet and the parent indent
 * - "nested": produced by a nested list, already carries its own indent/bullet
 * - "block": block content (table, blockquote, code, …) rendered under the item
 */
type ListItemLineKind = "text" | "nested" | "block";

/**
 * Whether a fenced code token's raw contains its closing fence. marked ends a
 * fenced code token at the closing fence line, so the closer can only be the
 * raw's final line: up to 3 leading spaces, a run of the opener's fence
 * character at least as long as the opener's, and nothing but spaces after it
 * (a "```" gaining more characters stops being a closer and the fence re-opens
 * — the raw then fails this check again). Indented code has no fence opener
 * and never closes here; it keeps the streaming seal while it is the final
 * block. Checking only the final line keeps this O(line) per frame.
 */
function fenceRawClosed(raw: string): boolean {
	const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
	if (!open) {
		return false;
	}
	const fence = open[1];
	let end = raw.length;
	if (end > 0 && raw.charCodeAt(end - 1) === 10) {
		end -= 1;
	}
	const lineStart = raw.lastIndexOf("\n", end - 1);
	if (lineStart === -1) {
		return false;
	}
	const closer = /^ {0,3}(`{3,}|~{3,}) *$/.exec(raw.slice(lineStart + 1, end));
	return closer !== null && closer[1].charCodeAt(0) === fence.charCodeAt(0) && closer[1].length >= fence.length;
}

/**
 * Cap on the per-frame streaming highlight of a growing fence's unsealed tail:
 * about one screen of code. A tail beyond the cap renders plain (the wrap seal
 * still bounds its re-render) until the fence closes and is highlighted in
 * full once; the cap is what bounds the per-frame highlighter input instead of
 * re-highlighting the whole accumulated block every frame.
 */
const FENCE_STREAM_HL_MAX_LINES = 50;
const FENCE_STREAM_HL_MAX_CHARS = 4096;

function fenceTailFitsHighlight(tail: string): boolean {
	if (tail.length > FENCE_STREAM_HL_MAX_CHARS) {
		return false;
	}
	let lines = 1;
	for (let i = 0; i < tail.length; i++) {
		if (tail.charCodeAt(i) === 10) {
			lines += 1;
			if (lines > FENCE_STREAM_HL_MAX_LINES) {
				return false;
			}
		}
	}
	return true;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	/** Capabilities version the cached lines were rendered under (F2). */
	private cachedCapsVersion?: number;
	private selectionRegions: TableCellSelectionRegion[] = [];
	private tableIdentities: object[] = [];
	// Per-block render cache so streaming appends only re-render the changing
	// final block instead of the whole document. Index-aligned to the top-level
	// token stream and hit by token identity (see BlockSlot); rebuilt each
	// render so it stays bounded to the current document's blocks.
	private blockSlots: BlockSlot[] = [];
	// Line/item-level seal for the growing final block; see FinalBlockSeal and
	// FinalListSeal.
	private finalBlockSeal?: FinalBlockSeal | FinalListSeal;
	// Block-token lex cache; see LexCache. Survives setText (streaming) and
	// invalidate() (tokens do not depend on the theme), but is only reused when
	// the normalized text is unchanged up to the cached cut offset.
	private lexCache?: LexCache;
	// Inline split of the growing final paragraph; see SplitLex. Same survival
	// rules as the lex cache; every frame re-validates before reusing.
	private splitLex?: SplitLex;
	// Bootstrap generation counter for splitLex; see SplitLex.epoch.
	private splitLexEpoch = 0;
	// Set when this frame's token stream came from trySplitLex; see SplitLexFrame.
	private splitLexEngaged?: SplitLexFrame;
	// Append-only clean verdict of the split-lex backtick guard: the whole
	// normalized text of the frame where the paragraph's mask was last verified
	// clean, with its paraFrom. See splitBacktickClean.
	private splitLexMaskClean?: { paraFrom: number; source: string };
	// Append-only clean verdict of the paragraph-seal backtick guard: the
	// paragraph text of the frame last verified clean. See sealBacktickClean.
	private sealMaskClean?: string;
	// Item-level split of the growing final list; see ListSplitLex. Same
	// survival rules as the lex cache; every frame re-validates before reusing.
	private listSplitLex?: ListSplitLex;

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		// Only the whole-result cache is dropped; the per-block cache stays so a
		// streaming append re-renders just the blocks that actually changed.
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.selectionRegions = [];
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.selectionRegions = [];
		// External invalidation (e.g. theme change) affects rendered output, so
		// the per-block cache must go too.
		this.blockSlots = [];
		this.finalBlockSeal = undefined;
	}

	/**
	 * Lex `normalizedText`, reusing cached prefix tokens when the text only
	 * changed after the cached cut offset. Reuse conditions and why they yield
	 * exactly the tokens a full re-lex would produce:
	 * - the prefix [0, cut) is byte-identical (startsWith check), so a full
	 *   re-lex would match the same tokens at the same offsets;
	 * - the token before the cut is not paragraph/text (computeLexCut), so no
	 *   tail construct can merge into a reused token - merges into the empty
	 *   fresh lexer are impossible and merges into prefix tokens are excluded;
	 * - the tail is lexed with a fresh lexer over the same remaining string a
	 *   full re-lex would see at that offset, with the same (empty) links map;
	 * - any link reference definition appearing in the tail forces a full
	 *   re-lex, because it could resolve references inside reused blocks.
	 */
	private lex(normalizedText: string): TokensList {
		this.splitLexEngaged = undefined;
		const cache = this.lexCache;
		const cacheHit = cache !== undefined && cache.cut > 0 && normalizedText.startsWith(cache.prefix);
		const base = cacheHit ? cache.cut : 0;
		const baseTokens = cacheHit ? cache.tokens : [];
		const parser = pickMarkdownParser(normalizedText);
		const spliced = this.trySplitLex(normalizedText, base, baseTokens, parser);
		if (spliced) {
			return spliced;
		}
		const listSpliced = this.trySplitListLex(normalizedText, base, baseTokens, parser);
		if (listSpliced) {
			return listSpliced;
		}
		if (cacheHit) {
			const tailTokens = parser.lexer(normalizedText.slice(cache.cut));
			if (Object.keys(tailTokens.links ?? {}).length === 0) {
				const tokens = cache.tokens.concat(tailTokens) as TokensList;
				tokens.links = tailTokens.links ?? {};
				this.lexCache = buildLexCache(normalizedText, tokens);
				this.splitLex = this.bootstrapSplitLex(normalizedText, tokens);
				this.listSplitLex = this.bootstrapListSplitLex(normalizedText, tokens);
				return tokens;
			}
		}
		const tokens = parser.lexer(normalizedText);
		this.lexCache = buildLexCache(normalizedText, tokens);
		this.splitLex = this.bootstrapSplitLex(normalizedText, tokens);
		this.listSplitLex = this.bootstrapListSplitLex(normalizedText, tokens);
		return tokens;
	}

	/**
	 * Lex only the unverified tail of a single growing final paragraph, splicing
	 * the result onto the verified inline prefix. Returns undefined unless every
	 * guard holds; the caller then falls back to the ordinary (cached-prefix or
	 * full) lex, so a rejected split never changes behavior, only speed:
	 * - the block-cache context and the whole split prefix are append-stable
	 *   (baseCut equality + one startsWith);
	 * - the tail must lex to exactly one paragraph and nothing else. Any block
	 *   construct starting or completing in the tail (list, fence, html,
	 *   heading, hr, table, math block, indented code, a blank line ending the
	 *   paragraph) changes the token count or the first token's type, which is
	 *   the same re-typing a full lex would perform - falling back reproduces
	 *   it exactly;
	 * - a reference definition in the tail (links non-empty) could resolve
	 *   references in the reused prefix, so it falls back;
	 * - when the tail starts at a line start, its first line must not be a
	 *   setext underline or a table delimiter row: both reach BACK across the
	 *   cut and re-type prefix content (heading absorption, header promotion)
	 *   while the tail lexed alone keeps them as inert paragraph text;
	 * - inline spanning across the cut is excluded by construction of
	 *   split.cut (see findSafeInlineCut).
	 */
	private trySplitLex(
		normalizedText: string,
		base: number,
		baseTokens: Token[],
		parser: Marked,
	): TokensList | undefined {
		if (process.env.PI_MARKDOWN_SPLIT_LEX === "0") {
			return undefined;
		}
		const split = this.splitLex;
		if (
			!split ||
			split.baseCut !== base ||
			split.cut >= normalizedText.length ||
			!normalizedText.startsWith(split.prefix)
		) {
			return undefined;
		}
		// A backtick run the emphasis mask has not absorbed can still be paired by
		// later text, re-typing emphasis inside the verified prefix without any
		// token crossing the cut (see emphasisMask); such frames fall back to a
		// full lex, which also re-bootstraps this state from the corrected tokens.
		// The clean verdict is memoized append-only (see splitBacktickClean) so a
		// growing paragraph of paired inline code pays one scan per new backtick,
		// not a full-paragraph mask every frame.
		if (!this.splitBacktickClean(split.paraFrom, normalizedText)) {
			return undefined;
		}
		const tail = normalizedText.slice(split.cut);
		// marked's block-math interrupt inserts a paragraph break before a
		// mid-paragraph $$ or \[, and a tail lex that STARTS with the delimiter
		// never reproduces that break. The cut may predate the delimiter's arrival,
		// so re-check every frame; only a newline (or the paragraph start) before
		// the delimiter suppresses the break on both sides.
		if (
			(tail.startsWith("$$") || tail.startsWith("\\[")) &&
			split.cut > split.paraFrom &&
			normalizedText[split.cut - 1] !== "\n"
		) {
			return undefined;
		}
		if (normalizedText[split.cut - 1] === "\n") {
			const newline = tail.indexOf("\n");
			const firstLine = newline === -1 ? tail : tail.slice(0, newline);
			if (SETEXT_LINE_REGEX.test(firstLine) || TABLE_DELIM_LINE_REGEX.test(firstLine)) {
				return undefined;
			}
		}
		const tailTokens = parser.lexer(tail);
		if (tailTokens.length !== 1 || tailTokens[0]?.type !== "paragraph") {
			return undefined;
		}
		if (Object.keys(tailTokens.links ?? {}).length > 0) {
			return undefined;
		}
		const tailParagraph = tailTokens[0] as Tokens.Paragraph;
		if (!Array.isArray(tailParagraph.tokens)) {
			return undefined;
		}
		const reusable =
			split.spliced !== undefined && split.splicedPrefix === split.prefixTokens ? split.spliced : undefined;
		const inlineTokens = spliceInlineTokens(split.prefixTokens, tailParagraph.tokens, reusable);
		if (!inlineTokens) {
			return undefined;
		}
		split.spliced = inlineTokens;
		split.splicedPrefix = split.prefixTokens;
		// Record where the verified prefix ends in this frame's stream so the
		// paragraph seal can resume its scans at the junction (see SplitLexFrame).
		const cutRel = split.cut - split.paraFrom;
		const lastPrefixRaw = (split.prefixTokens[split.prefixTokens.length - 1] as { raw?: unknown }).raw;
		const junctionMerged =
			split.prefixTokens[split.prefixTokens.length - 1]?.type === "text" && tailParagraph.tokens[0]?.type === "text";
		const junctionIndex = junctionMerged ? split.prefixTokens.length - 1 : split.prefixTokens.length;
		const junctionStart =
			junctionMerged && typeof lastPrefixRaw === "string" ? cutRel - lastPrefixRaw.length : cutRel;
		if (
			junctionStart >= 0 &&
			junctionIndex <= inlineTokens.length &&
			(!junctionMerged || typeof lastPrefixRaw === "string")
		) {
			this.splitLexEngaged = { epoch: split.epoch, cutRel, junctionIndex, junctionStart };
		}
		// marked strips exactly one trailing "\n" from a paragraph's text (probe
		// P1); the prefix tiles the source exactly (induction), so the merged
		// text is the source slice with the same single strip applied.
		const text = normalizedText.slice(split.paraFrom, split.cut) + tailParagraph.text;
		const paragraph = {
			type: "paragraph",
			raw: normalizedText.slice(split.paraFrom),
			text,
			tokens: inlineTokens,
		} as Tokens.Paragraph;
		const tokens = baseTokens.concat([paragraph]) as TokensList;
		tokens.links = {};
		this.lexCache = buildLexCache(normalizedText, tokens);
		// Advance the cut through the freshly lexed tail so the next frame's tail
		// stays small. Keeping the old cut when no further safe point exists is
		// correct: the tail simply re-lexes until one appears.
		const advanceTo = findSafeInlineCut(inlineTokens, text, split.cut - split.paraFrom);
		if (advanceTo !== undefined) {
			const prefixTokens = this.sliceInlineTokens(inlineTokens, 0, advanceTo);
			if (prefixTokens) {
				const cut = split.paraFrom + advanceTo;
				this.splitLex = {
					baseCut: base,
					paraFrom: split.paraFrom,
					cut,
					prefixTokens,
					prefix: normalizedText.slice(0, cut),
					epoch: split.epoch,
				};
			}
		}
		return tokens;
	}

	/**
	 * The split-lex backtick guard with an append-only memo. hasUnmaskedBacktick
	 * walks the emphasis mask of the whole paragraph, so a growing paragraph of
	 * paired inline code would pay a full-paragraph regex scan every frame (the
	 * O(n)-per-frame shape the split lex exists to avoid). Once a paragraph's
	 * mask is verified clean, frames that only append text without any backtick
	 * keep it clean: the mask spans are decided by a left-to-right scan, and the
	 * only way an already-matched span dissolves is a backtick arriving
	 * immediately after a code-span closer (blockSkip's `(?!`)`), which requires
	 * the appended region to hold a backtick. The memo keys on the whole
	 * normalized text plus paraFrom (no per-frame paragraph slice), and the
	 * append check is the same startsWith idiom the split prefix already uses.
	 */
	private splitBacktickClean(paraFrom: number, normalizedText: string): boolean {
		const memo = process.env.PI_MARKDOWN_BACKTICK_GUARD_MEMO === "0" ? undefined : this.splitLexMaskClean;
		if (
			memo &&
			memo.paraFrom === paraFrom &&
			normalizedText.startsWith(memo.source) &&
			!normalizedText.includes("`", memo.source.length)
		) {
			memo.source = normalizedText;
			return true;
		}
		if (hasUnmaskedBacktick(normalizedText.slice(paraFrom))) {
			this.splitLexMaskClean = undefined;
			return false;
		}
		this.splitLexMaskClean = { paraFrom, source: normalizedText };
		return true;
	}

	/**
	 * The paragraph-seal backtick guard with the same append-only memo, keyed on
	 * the seal's own paragraph text (a different string from the split guard's
	 * source: marked strips one trailing newline). See splitBacktickClean for
	 * why a clean verdict survives backtick-free appends.
	 */
	private sealBacktickClean(text: string): boolean {
		const memo = process.env.PI_MARKDOWN_BACKTICK_GUARD_MEMO === "0" ? undefined : this.sealMaskClean;
		if (memo && text.startsWith(memo) && !text.includes("`", memo.length)) {
			this.sealMaskClean = text;
			return true;
		}
		if (hasUnmaskedBacktick(text)) {
			this.sealMaskClean = undefined;
			return false;
		}
		this.sealMaskClean = text;
		return true;
	}

	/**
	 * Build split-lex state from a freshly lexed stream: the final block must be
	 * a paragraph reaching the end of the text, large enough for splitting to
	 * pay, with a safe inline cut (findSafeInlineCut). Any other shape disables
	 * splitting until a qualifying paragraph streams in.
	 */
	private bootstrapSplitLex(normalizedText: string, tokens: TokensList): SplitLex | undefined {
		// Every bootstrap replaces the split state, breaking the byte/token
		// continuity incremental seal scans key on (SplitLex.epoch).
		this.splitLexEpoch += 1;
		if (Object.keys(tokens.links ?? {}).length > 0) {
			return undefined;
		}
		const last = tokens[tokens.length - 1];
		if (!last || last.type !== "paragraph") {
			return undefined;
		}
		const raw = (last as { raw?: unknown }).raw;
		const paragraph = last as Tokens.Paragraph;
		if (typeof raw !== "string" || !Array.isArray(paragraph.tokens)) {
			return undefined;
		}
		const paraFrom = normalizedText.length - raw.length;
		if (paragraph.text.length < MIN_SPLIT_LEX_BLOCK_CHARS) {
			return undefined;
		}
		// The spliced stream is baseTokens plus the single paragraph, so the
		// paragraph must start exactly at the block-cache cut; anything between
		// (an unstable list/html block before it) is not tracked by this cache.
		const baseCut = this.lexCache?.cut ?? 0;
		if (paraFrom !== baseCut) {
			return undefined;
		}
		const cutRel = findSafeInlineCut(paragraph.tokens, paragraph.text, 0);
		if (cutRel === undefined) {
			return undefined;
		}
		const prefixTokens = this.sliceInlineTokens(paragraph.tokens, 0, cutRel);
		if (!prefixTokens) {
			return undefined;
		}
		const cut = paraFrom + cutRel;
		return {
			baseCut,
			paraFrom,
			cut,
			prefixTokens,
			prefix: normalizedText.slice(0, cut),
			epoch: this.splitLexEpoch,
		};
	}

	/**
	 * Lex only the unverified tail of a single growing final list, splicing the
	 * fresh tail items onto the verified prefix items. Returns undefined unless
	 * every guard holds; the caller then falls back to the ordinary
	 * (cached-prefix or full) lex, so a rejected split never changes behavior,
	 * only speed:
	 * - the block-cache context and the whole split prefix are append-stable
	 *   (baseCut equality + one startsWith);
	 * - the tail must lex to exactly one list. A partial bullet collapsing into
	 *   the previous item ("-" gaining "x"), a marker change ("+" after "-",
	 *   "1)" after "1."), an hr-shaped line, or a blank line ending the list all
	 *   lex the tail to something else (or to a list plus a space token), which
	 *   falls back and reproduces the full re-lex exactly. The tail list's raw
	 *   is deliberately NOT compared to the tail text: marked rewrites a single
	 *   trailing space/tab at end of text to "\n" inside the raw, and that
	 *   region is re-lexed fresh on the next frame anyway;
	 * - ordered and loose must match the verified prefix: the merged token keeps
	 *   the prefix item objects, and a loose flip re-types every item's block
	 *   tokens (text -> paragraph), so a flip forces a full re-lex instead of
	 *   serving a mixed-loose stream no full lex would produce;
	 * - a reference definition in the tail (links non-empty) could resolve
	 *   references inside the reused prefix items, so it falls back.
	 */
	private trySplitListLex(
		normalizedText: string,
		base: number,
		baseTokens: Token[],
		parser: Marked,
	): TokensList | undefined {
		if (process.env.PI_MARKDOWN_SPLIT_LEX === "0") {
			return undefined;
		}
		const split = this.listSplitLex;
		if (
			!split ||
			split.baseCut !== base ||
			split.cut >= normalizedText.length ||
			!normalizedText.startsWith(split.prefix)
		) {
			return undefined;
		}
		const tail = normalizedText.slice(split.cut);
		const tailTokens = parser.lexer(tail);
		if (tailTokens.length !== 1) {
			return undefined;
		}
		const tailList = tailTokens[0];
		if (tailList?.type !== "list") {
			return undefined;
		}
		if (Object.keys(tailTokens.links ?? {}).length > 0) {
			return undefined;
		}
		const list = tailList as Tokens.List;
		if (
			list.ordered !== split.ordered ||
			list.loose !== split.loose ||
			!Array.isArray(list.items) ||
			list.items.length === 0
		) {
			return undefined;
		}
		const merged: Tokens.List = {
			type: "list",
			raw: normalizedText.slice(split.listFrom),
			ordered: split.ordered,
			start: split.start,
			loose: split.loose,
			items: [...split.prefixItems, ...list.items],
		};
		const tokens = baseTokens.concat([merged]) as TokensList;
		tokens.links = {};
		this.lexCache = buildLexCache(normalizedText, tokens);
		// Advance the cut to the merged list's last item start so the next frame's
		// tail stays one item. The induction holds because prefix items tile
		// [listFrom, cut) (bootstrap verified) and non-last tail items tile their
		// span of the tail raw (only a list's final item raw can drop a trailing
		// newline).
		const advanced = this.listLastItemStart(split.listFrom, merged.items);
		if (advanced !== undefined && advanced > split.cut) {
			this.listSplitLex = {
				baseCut: base,
				listFrom: split.listFrom,
				cut: advanced,
				prefixItems: merged.items.slice(0, merged.items.length - 1),
				ordered: split.ordered,
				start: split.start,
				loose: split.loose,
				prefix: normalizedText.slice(0, advanced),
			};
		}
		return tokens;
	}

	/**
	 * Build list split-lex state from a freshly lexed stream: the final block
	 * must be a list with at least two items (so a cut before the growing tail
	 * item exists), large enough for splitting to pay, starting exactly at the
	 * block-cache cut (same constraint as the paragraph split). The prefix item
	 * raws must tile [listFrom, cut) byte-identically - that one-time check is
	 * what every later reuse stands on. The list raw itself is not required to
	 * tile the source: marked rewrites a single trailing space/tab at end of
	 * text to "\n" inside the raw, which lives in the tail region that is
	 * re-lexed fresh every frame. Any other shape disables the list split until
	 * a qualifying list streams in.
	 */
	private bootstrapListSplitLex(normalizedText: string, tokens: TokensList): ListSplitLex | undefined {
		if (Object.keys(tokens.links ?? {}).length > 0) {
			return undefined;
		}
		const last = tokens[tokens.length - 1];
		if (!last || last.type !== "list") {
			return undefined;
		}
		const list = last as Tokens.List;
		if (typeof list.raw !== "string" || !Array.isArray(list.items) || list.items.length < 2) {
			return undefined;
		}
		if (list.raw.length < MIN_SPLIT_LEX_BLOCK_CHARS) {
			return undefined;
		}
		const baseCut = this.lexCache?.cut ?? 0;
		// The list must start exactly at the block-cache cut; listFrom derives
		// from the raw length, which a trailing-whitespace rewrite preserves.
		const listFrom = normalizedText.length - list.raw.length;
		if (listFrom !== baseCut) {
			return undefined;
		}
		const cut = this.listLastItemStart(listFrom, list.items);
		if (cut === undefined || cut >= normalizedText.length) {
			return undefined;
		}
		// Verify once that the prefix items tile [listFrom, cut) exactly before
		// any reuse is built on them.
		let tiled = "";
		for (let i = 0; i < list.items.length - 1; i++) {
			tiled += list.items[i]?.raw;
		}
		if (tiled !== normalizedText.slice(listFrom, cut)) {
			return undefined;
		}
		return {
			baseCut,
			listFrom,
			cut,
			prefixItems: list.items.slice(0, list.items.length - 1),
			ordered: list.ordered,
			start: list.start,
			loose: list.loose,
			prefix: normalizedText.slice(0, cut),
		};
	}

	/**
	 * Start offset of the list's last item: item raws tile the list raw from
	 * its start. Returns undefined when an item raw is not a string.
	 */
	private listLastItemStart(listFrom: number, items: Tokens.ListItem[]): number | undefined {
		let cut = listFrom;
		for (let i = 0; i < items.length - 1; i++) {
			const raw = items[i]?.raw;
			if (typeof raw !== "string") {
				return undefined;
			}
			cut += raw.length;
		}
		return cut;
	}

	render(width: number): string[] {
		// The whole-result cache must also die on a capability flip: the cached
		// lines were rendered under an older capabilities version, and a flip
		// (e.g. hyperlinks turning on) changes the output for the same text.
		const capsVersion = getCapabilitiesVersion();
		if (
			this.cachedLines &&
			this.cachedText === this.text &&
			this.cachedWidth === width &&
			this.cachedCapsVersion === capsVersion
		) {
			return this.cachedLines;
		}

		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		if (!text || text.trim() === "") {
			const result: string[] = [];
			this.selectionRegions = [];
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedCapsVersion = capsVersion;
			this.cachedLines = result;
			return result;
		}

		// Carriage returns are normalized here as well: the lexer replaces them
		// internally, and leaving them in would desynchronize the offset-based
		// lex cache (token raws would no longer tile the input string). Tabs expand
		// to the CommonMark width (4 columns): at 3 a tab-indented line never
		// reaches the 4-column code-block indent and renders as a plain paragraph.
		const normalizedText = text.replace(/\t/g, "    ").replace(/\r\n|\r/g, "\n");

		// Parse markdown to HTML-like tokens. Streaming appends re-lex only the
		// tail after the last merge-safe block boundary; prefix blocks are reused
		// from the lex cache instead of re-lexing the whole document every frame.
		const tokens = this.lex(normalizedText);

		// Reference-link definitions make a block's rendering depend on other
		// blocks, so per-block caching is disabled when any are present.
		const cacheable = Object.keys(tokens.links).length === 0;

		// Render, wrap, and pad per top-level block so unchanged blocks can be
		// served from the cache. The final block is never slot-cached: while
		// streaming, appended text can reinterpret it (unterminated fences,
		// growing lists); once a block is no longer last, its raw text is final.
		// The final block instead seals its completed lines or list items (see
		// FinalBlockSeal and FinalListSeal), which bounds per-frame work to the
		// unsealed tail for single-block documents. PI_MARKDOWN_LINE_SEAL=0
		// disables sealing.
		const lineSealing = process.env.PI_MARKDOWN_LINE_SEAL !== "0";
		const nextSlots: BlockSlot[] = [];
		const contentLines: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextTokenType = tokens[i + 1]?.type;
			const isFinalBlock = i === tokens.length - 1;
			const useCache = cacheable && !isFinalBlock;
			let blockLines: string[] | undefined;
			if (useCache) {
				const slot = this.blockSlots[i];
				if (
					slot &&
					slot.token === token &&
					slot.width === width &&
					slot.nextType === nextTokenType &&
					slot.capsVersion === capsVersion
				) {
					blockLines = slot.lines;
				}
			}
			if (!blockLines) {
				if (isFinalBlock && cacheable && lineSealing) {
					blockLines = this.renderFinalBlockSealed(token, width, contentWidth, capsVersion);
				} else {
					if (isFinalBlock) {
						this.finalBlockSeal = undefined;
					}
					blockLines = this.renderBlock(token, nextTokenType, width, contentWidth);
				}
			}
			if (useCache) {
				nextSlots.push({ token, width, nextType: nextTokenType, capsVersion, lines: blockLines });
			}
			contentLines.push(...blockLines);
		}
		this.blockSlots = nextSlots;

		const bgFn = this.defaultTextStyle?.bgColor;
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		const markedResult = [...emptyLines, ...contentLines, ...emptyLines];
		const { lines: result, regions } = extractTableCellSelectionRegions(markedResult, (index) => {
			this.tableIdentities[index] ??= {};
			return this.tableIdentities[index];
		});
		this.selectionRegions = regions;

		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedCapsVersion = capsVersion;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	getSelectionRegions(): ReadonlyArray<TableCellSelectionRegion> {
		return this.selectionRegions;
	}

	/** Render one top-level block: token lines, wrapping, margins, background. */
	private renderBlock(token: Token, nextTokenType: string | undefined, width: number, contentWidth: number): string[] {
		return this.renderTokenLinesToBlockLines(
			this.renderToken(token, contentWidth, nextTokenType),
			width,
			contentWidth,
		);
	}

	/** Wrap, margin, and pad already-rendered token lines into block lines. */
	private renderTokenLinesToBlockLines(tokenLines: string[], width: number, contentWidth: number): string[] {
		const blockLines: string[] = [];

		for (const line of tokenLines) {
			if (isImageLine(line)) {
				blockLines.push(line);
				continue;
			}
			for (const wrapped of wrapTextWithAnsi(line, contentWidth)) {
				blockLines.push(this.padBlockLine(wrapped, width));
			}
		}

		return blockLines;
	}

	/** Add margins, background, and right padding to one wrapped line. */
	private padBlockLine(wrapped: string, width: number): string {
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const lineWithMargins = leftMargin + wrapped + rightMargin;
		if (bgFn) {
			return applyBackgroundToLine(lineWithMargins, width, bgFn);
		}
		const visibleLen = visibleWidth(lineWithMargins);
		const paddingNeeded = Math.max(0, width - visibleLen);
		return lineWithMargins + " ".repeat(paddingNeeded);
	}

	/**
	 * Render the final block through the seal: the sealed prefix comes from the
	 * cache, only the unsealed tail is rendered. Paragraphs seal completed
	 * lines, fences seal completed code lines (with a whole-block highlighter
	 * the sealed prefix renders plain and only the capped tail is highlighted
	 * per frame — see renderFinalCodeSealed), and lists seal completed items
	 * (renderFinalListSealed). Blocks whose rendering later text can
	 * re-interpret in ways the seal validation does not cover (tables re-flow
	 * column widths per row) keep the full per-frame re-render.
	 */
	private renderFinalBlockSealed(token: Token, width: number, contentWidth: number, capsVersion: number): string[] {
		if (token.type === "paragraph") {
			const sealed = this.renderFinalParagraphSealed(token as Tokens.Paragraph, width, contentWidth, capsVersion);
			if (sealed) {
				return sealed;
			}
		} else if (
			token.type === "code" &&
			// PI_MARKDOWN_FENCE_STREAM_HL=0 opts highlighted fences out of the
			// seal, restoring the pre-seal full highlighted re-render every frame.
			(!this.theme.highlightCode || process.env.PI_MARKDOWN_FENCE_STREAM_HL !== "0")
		) {
			const sealed = this.renderFinalCodeSealed(token as Tokens.Code, width, contentWidth, capsVersion);
			if (sealed) {
				return sealed;
			}
		} else if (token.type === "list") {
			const sealed = this.renderFinalListSealed(token as Tokens.List, width, contentWidth, capsVersion);
			if (sealed) {
				return sealed;
			}
		}
		this.finalBlockSeal = undefined;
		return this.renderBlock(token, undefined, width, contentWidth);
	}

	/**
	 * Paragraph seal. A seal boundary is an offset right after a "\n" inside the
	 * paragraph text where a split render is byte-identical to the full render:
	 * - only text tokens may cross the boundary. Any construct spanning it
	 *   (cross-line emphasis, codespans, math, a br) re-styles the sealed side,
	 *   so such boundaries are never sealed and a fresh token stream showing a
	 *   construct across the seal invalidates it (this is what catches a `*`
	 *   opener sealed as plain text gaining its closer later);
	 * - the line before the boundary must not end with a construct when a
	 *   default style prefix is active, because the sealed prefix render would
	 *   trim the trailing style restore that the full render keeps mid-string;
	 * - reference-link definitions disable sealing entirely (the caller only
	 *   enters this path when tokens.links is empty), since a later definition
	 *   re-types earlier references.
	 * Block-level re-typing (setext underlines, table delimiter rows) changes
	 * the final token's type or raw prefix, which the per-frame seal validation
	 * rejects before any sealed line is served.
	 */
	private renderFinalParagraphSealed(
		token: Tokens.Paragraph,
		width: number,
		contentWidth: number,
		capsVersion: number,
	): string[] | undefined {
		const text = token.text;
		const inlineTokens = token.tokens;
		if (typeof text !== "string" || !inlineTokens) {
			return undefined;
		}
		let seal = this.finalBlockSeal;
		if (
			seal &&
			(seal.blockType !== "paragraph" ||
				seal.width !== width ||
				seal.capsVersion !== capsVersion ||
				!text.startsWith(seal.source))
		) {
			seal = undefined;
			this.finalBlockSeal = undefined;
		}
		if (!seal) {
			seal = { blockType: "paragraph", source: "", tailFrom: 0, lines: [], width, capsVersion };
			this.finalBlockSeal = seal;
		}
		// A backtick run the emphasis mask has not absorbed can still be paired by
		// later text, re-typing sealed emphasis without any token crossing the
		// seal boundary (see emphasisMask), so the seal is served only while no
		// such run exists; the seal rebuilds itself from the corrected tokens on
		// the next clean frame. A split-lex frame already ran this check on the
		// same paragraph text. The clean verdict is memoized append-only (see
		// sealBacktickClean).
		const engaged = this.splitLexEngaged;
		if (engaged === undefined && !this.sealBacktickClean(text)) {
			this.finalBlockSeal = undefined;
			return undefined;
		}
		if (seal.tailFrom > 0 && !this.paragraphSealIntact(inlineTokens, seal.tailFrom)) {
			seal = { blockType: "paragraph", source: "", tailFrom: 0, lines: [], width, capsVersion };
			this.finalBlockSeal = seal;
		}
		const target = this.lastSealableParagraphOffset(inlineTokens, text, seal);
		if (target === -1) {
			this.finalBlockSeal = undefined;
			return undefined;
		}
		if (target > seal.tailFrom) {
			const extension = this.renderInlineRegionToBlockLines(
				inlineTokens,
				seal.tailFrom,
				target - 1,
				width,
				contentWidth,
			);
			if (!extension) {
				this.finalBlockSeal = undefined;
				return undefined;
			}
			seal.lines.push(...extension);
			seal.source = text.slice(0, target);
			seal.tailFrom = target;
			// The growing line just completed into the sealed prefix; its
			// wrap-level seal belongs to the old line.
			seal.wrapSealedW = undefined;
			seal.wrapLines = undefined;
			seal.wrapPrevW = undefined;
			seal.wrapIneligible = false;
		}
		const tailTokens = this.sliceInlineTokens(inlineTokens, seal.tailFrom, text.length);
		if (!tailTokens) {
			this.finalBlockSeal = undefined;
			return undefined;
		}
		const tailText = this.renderInlineTokens(tailTokens);
		if (seal.wrapIneligible || tailText.includes("\x1b")) {
			// ANSI in the tail (an inline construct on the growing line) breaks the
			// wrap seal's plain-text precondition; render the tail whole. The latch
			// clears when the line completes into the hard seal.
			if (tailText.includes("\x1b")) {
				seal.wrapIneligible = true;
			}
			seal.wrapSealedW = undefined;
			seal.wrapLines = undefined;
			seal.wrapPrevW = undefined;
			return [...seal.lines, ...this.renderTokenLinesToBlockLines([tailText], width, contentWidth)];
		}
		// A plain tail has no ANSI state to carry across segments, so the complete
		// (but unsealable) lines render independently of the growing last line.
		const lastBreak = tailText.lastIndexOf("\n");
		const headLines =
			lastBreak === -1 ? [] : this.renderTokenLinesToBlockLines([tailText.slice(0, lastBreak)], width, contentWidth);
		const growing = lastBreak === -1 ? tailText : tailText.slice(lastBreak + 1);
		const growingLines = this.wrapSealGrowingLine(seal, growing, width, contentWidth);
		return [...seal.lines, ...headLines, ...growingLines];
	}

	/**
	 * Wrap-level seal for the growing tail line. The rendered line w must be
	 * plain text (no ANSI escapes) and append-only across frames: then a wrapped
	 * piece is a plain substring of w, greedy wrapping from a piece boundary
	 * reproduces the full wrap's suffix exactly (fresh line, clean tracker), and
	 * every piece except the last is append-stable — the last piece may still
	 * grow or re-split when a growing word crosses the width, so it is
	 * re-wrapped every frame. Append-only is verified per frame against the
	 * whole previously rendered line (wrapPrevW), because inline re-typing (a
	 * math/emphasis opener gaining its closer) can rewrite the rendered tail
	 * while leaving the sealed prefix intact. The per-piece verification (piece
	 * is a prefix of the remaining text at the walked offset, followed by the
	 * whitespace run the wrap consumed) pins the piece-boundary offsets without
	 * reimplementing the wrap; a mismatch just skips the extension.
	 */
	private wrapSealGrowingLine(seal: FinalBlockSeal, w: string, width: number, contentWidth: number): string[] {
		let sealedW = seal.wrapSealedW ?? "";
		let sealedLines = seal.wrapLines ?? [];
		const prevW = seal.wrapPrevW;
		// A sealed piece stays valid only while the line grows by pure appends.
		// Checking w against prevW (not just sealedW) catches an inline construct
		// completing mid-line: the re-typed tail no longer extends the previously
		// rendered string, so every sealed piece is stale.
		if (prevW !== undefined ? !w.startsWith(prevW) : !w.startsWith(sealedW)) {
			// The line's rendered prefix changed (e.g. a construct completed and
			// gained styling before the plain check saw it); re-seal from scratch.
			// Clear the seal fields, not just the locals: when this frame wraps to
			// a single line no new seal is written below, and a stale wrapSealedW
			// that still prefixes w would serve stale lines on the next frame.
			sealedW = "";
			sealedLines = [];
			seal.wrapSealedW = undefined;
			seal.wrapLines = undefined;
		}
		seal.wrapPrevW = w;
		const tail = w.slice(sealedW.length);
		const wrapped = wrapTextWithAnsi(tail, contentWidth);
		if (wrapped.length > 1) {
			let consumed = 0;
			let aligned = true;
			for (let i = 0; i < wrapped.length - 1; i++) {
				const piece = wrapped[i];
				if (!tail.startsWith(piece, consumed)) {
					aligned = false;
					break;
				}
				consumed += piece.length;
				while (consumed < tail.length && tail[consumed].trim() === "") {
					consumed++;
				}
			}
			if (aligned) {
				for (let i = 0; i < wrapped.length - 1; i++) {
					sealedLines.push(this.padBlockLine(wrapped[i], width));
				}
				seal.wrapSealedW = sealedW + tail.slice(0, consumed);
				seal.wrapLines = sealedLines;
			}
		}
		return [...sealedLines, this.padBlockLine(wrapped[wrapped.length - 1], width)];
	}

	/**
	 * Whether the sealed boundary still sits inside a plain text token of the
	 * fresh token stream (plus the style-prefix rule from the paragraph seal
	 * comment). The seal source prefix itself is verified by the caller.
	 * When this frame's stream came from the split lex (SplitLexFrame), the
	 * boundary facts recorded when the seal last advanced answer in O(1) while
	 * the boundary token stays inside the verified prefix (same epoch, token
	 * object identity, boundaryEnd <= cutRel); otherwise the walk resumes at
	 * the junction, or from the start when the boundary precedes it.
	 */
	private paragraphSealIntact(inlineTokens: Token[], tailFrom: number): boolean {
		const engaged = this.splitLexEngaged;
		const seal = this.finalBlockSeal;
		if (
			engaged !== undefined &&
			seal?.blockType === "paragraph" &&
			seal.boundaryEpoch === engaged.epoch &&
			seal.boundaryTailFrom === tailFrom &&
			seal.boundaryIndex !== undefined &&
			seal.boundaryStart !== undefined &&
			seal.boundaryEnd !== undefined &&
			seal.boundaryStart <= tailFrom - 1 &&
			tailFrom - 1 < seal.boundaryEnd &&
			seal.boundaryEnd <= engaged.cutRel &&
			seal.boundaryIndex < inlineTokens.length &&
			inlineTokens[seal.boundaryIndex] === seal.boundaryToken
		) {
			return true;
		}
		let pos = 0;
		let i = 0;
		if (engaged !== undefined && tailFrom - 1 >= engaged.junctionStart) {
			i = engaged.junctionIndex;
			pos = engaged.junctionStart;
		}
		for (; i < inlineTokens.length; i++) {
			const token = inlineTokens[i];
			const raw = (token as { raw?: unknown }).raw;
			if (typeof raw !== "string") {
				return false;
			}
			const start = pos;
			const end = pos + raw.length;
			if (start <= tailFrom - 1 && end > tailFrom - 1) {
				if (token.type !== "text" || (token as { text?: unknown }).text !== raw) {
					return false;
				}
				if (
					start === tailFrom - 1 &&
					i > 0 &&
					this.getDefaultStylePrefix() !== "" &&
					STYLE_PREFIX_CONSTRUCTS.has(inlineTokens[i - 1].type)
				) {
					return false;
				}
				return true;
			}
			pos = end;
		}
		return false;
	}

	/**
	 * Largest sealable offset (right after a "\n", leaving a non-empty tail) in
	 * the paragraph text, or 0 when none qualifies. Returns -1 when the inline
	 * tokens do not tile the text exactly, meaning region slicing is unsafe.
	 * While the stream comes from the split lex (SplitLexFrame), candidates up
	 * to the verified prefix end are folded into the seal across frames: the
	 * scan resumes from the token containing the last folded offset (walked
	 * back from the junction, a region bounded by one frame's cut advance), and
	 * the newline search inside that token resumes at the folded offset. The
	 * boundary facts of the winning candidate are recorded for
	 * paragraphSealIntact whenever the returned offset advances the seal.
	 */
	private lastSealableParagraphOffset(inlineTokens: Token[], text: string, seal: FinalBlockSeal): number {
		const stylePrefix = this.getDefaultStylePrefix();
		const engaged = this.splitLexEngaged;
		const resume =
			engaged !== undefined &&
			seal.scanEpoch === engaged.epoch &&
			seal.scanFrom !== undefined &&
			seal.scanBest !== undefined &&
			seal.scanFrom <= engaged.cutRel;
		let best = 0;
		let bestIndex = -1;
		let bestStart = 0;
		let bestEnd = 0;
		let bestToken: Token | undefined;
		let i = 0;
		let pos = 0;
		let rawFrom = 0;
		const foldLimit = engaged !== undefined ? engaged.cutRel : -1;
		if (engaged !== undefined) {
			if (resume) {
				best = seal.scanBest as number;
				bestIndex = seal.scanBestIndex ?? -1;
				bestStart = seal.scanBestStart ?? 0;
				bestEnd = seal.scanBestEnd ?? 0;
				bestToken = seal.scanBestToken;
				i = engaged.junctionIndex;
				pos = engaged.junctionStart;
				// The junction token can start before the folded offset; walk back
				// to the token containing scanFrom so no candidate is skipped.
				let resumeFrom = seal.scanFrom as number;
				while (i > 0 && pos > resumeFrom) {
					const prevRaw = (inlineTokens[i - 1] as { raw?: unknown }).raw;
					if (typeof prevRaw !== "string") {
						i = 0;
						pos = 0;
						resumeFrom = 0;
						break;
					}
					i -= 1;
					pos -= prevRaw.length;
				}
				rawFrom = Math.max(0, resumeFrom - pos);
			}
		} else {
			// Without the split-lex prefix invariant the folded state says
			// nothing about this stream; drop it.
			seal.scanEpoch = undefined;
		}
		const startIndex = i;
		let foldBest = -1;
		let foldIndex = -1;
		let foldStart = 0;
		let foldEnd = 0;
		let foldToken: Token | undefined;
		for (; i < inlineTokens.length; i++) {
			const token = inlineTokens[i];
			const raw = (token as { raw?: unknown }).raw;
			if (typeof raw !== "string") {
				return -1;
			}
			if (token.type === "text") {
				if ((token as { text?: unknown }).text !== raw) {
					return -1;
				}
				let idx = raw.indexOf("\n", i === startIndex ? rawFrom : 0);
				while (idx !== -1) {
					const k = pos + idx + 1;
					const trimsStylePrefix =
						idx === 0 && i > 0 && stylePrefix !== "" && STYLE_PREFIX_CONSTRUCTS.has(inlineTokens[i - 1].type);
					if (k < text.length && !trimsStylePrefix) {
						best = k;
						bestIndex = i;
						bestStart = pos;
						bestEnd = pos + raw.length;
						bestToken = token;
						if (k <= foldLimit) {
							foldBest = k;
							foldIndex = i;
							foldStart = pos;
							foldEnd = pos + raw.length;
							foldToken = token;
						}
					}
					idx = raw.indexOf("\n", idx + 1);
				}
			}
			pos += raw.length;
		}
		if (pos !== text.length) {
			return -1;
		}
		if (engaged !== undefined) {
			const base = resume ? (seal.scanBest as number) : 0;
			if (foldBest > base) {
				seal.scanBest = foldBest;
				seal.scanBestIndex = foldIndex;
				seal.scanBestStart = foldStart;
				seal.scanBestEnd = foldEnd;
				seal.scanBestToken = foldToken;
			} else if (!resume) {
				seal.scanBest = 0;
				seal.scanBestIndex = -1;
				seal.scanBestStart = 0;
				seal.scanBestEnd = 0;
				seal.scanBestToken = undefined;
			}
			seal.scanFrom = foldLimit;
			seal.scanEpoch = engaged.epoch;
		}
		if (best > seal.tailFrom && bestToken !== undefined) {
			seal.boundaryEpoch = engaged?.epoch;
			seal.boundaryTailFrom = best;
			seal.boundaryIndex = bestIndex;
			seal.boundaryStart = bestStart;
			seal.boundaryEnd = bestEnd;
			seal.boundaryToken = bestToken;
		}
		return best;
	}

	/**
	 * Slice the inline tokens covering the text region [from, to), truncating
	 * the text tokens that cross the region ends. Returns undefined when a
	 * non-text token crosses a region boundary; callers fall back to the full
	 * render.
	 */
	private sliceInlineTokens(inlineTokens: Token[], from: number, to: number): Token[] | undefined {
		const slice: Token[] = [];
		let pos = 0;
		for (const token of inlineTokens) {
			const raw = (token as { raw?: unknown }).raw;
			if (typeof raw !== "string") {
				return undefined;
			}
			const start = pos;
			const end = pos + raw.length;
			pos = end;
			if (end <= from || start >= to) {
				continue;
			}
			if (start >= from && end <= to) {
				slice.push(token);
				continue;
			}
			if (token.type !== "text" || (token as { text?: unknown }).text !== raw) {
				return undefined;
			}
			const part = raw.slice(Math.max(from, start) - start, Math.min(to, end) - start);
			slice.push({ type: "text", raw: part, text: part } as Token);
		}
		return slice;
	}

	/** Render the inline tokens covering [from, to) into block lines. */
	private renderInlineRegionToBlockLines(
		inlineTokens: Token[],
		from: number,
		to: number,
		width: number,
		contentWidth: number,
	): string[] | undefined {
		const slice = this.sliceInlineTokens(inlineTokens, from, to);
		if (!slice) {
			return undefined;
		}
		return this.renderTokenLinesToBlockLines([this.renderInlineTokens(slice)], width, contentWidth);
	}

	/**
	 * Fence/indented-code seal. Code lines render independently of each other
	 * (no inline constructs), so every hard-newline-terminated line of the block
	 * text is sealed as soon as it completes.
	 *
	 * With a whole-block highlighter (theme.highlightCode) the highlighter is
	 * context-sensitive across the full code text, so the sealed prefix cannot
	 * be highlighted incrementally: sealed lines render plain (codeBlock style)
	 * and only the unsealed tail goes through highlightCode, capped at about
	 * one screen of code (fenceTailFitsHighlight) to bound the per-frame
	 * highlight input; a tail beyond the cap renders plain as well. The whole
	 * fence is highlighted exactly once, when it closes (fenceRawClosed) — or
	 * when it stops being the final block, which the caller already full-renders
	 * through the per-block cache path. The visible drift: the streaming sealed
	 * region is temporarily plain and the fence colors all at once at closure.
	 * A fence whose stream is truncated before the closing fence never closes,
	 * so it keeps the plain seal + highlighted tail even in its final render.
	 */
	private renderFinalCodeSealed(
		token: Tokens.Code,
		width: number,
		contentWidth: number,
		capsVersion: number,
	): string[] | undefined {
		const text = token.text;
		if (typeof text !== "string") {
			return undefined;
		}
		const lang = typeof token.lang === "string" ? token.lang : undefined;
		const highlighting = this.theme.highlightCode !== undefined;
		if (highlighting && fenceRawClosed(token.raw)) {
			// Closure reflow: the caller drops the seal and full-renders the
			// block, highlighting the whole fence in one pass.
			return undefined;
		}
		let seal = this.finalBlockSeal;
		if (
			seal &&
			(seal.blockType !== "code" ||
				seal.width !== width ||
				seal.capsVersion !== capsVersion ||
				!text.startsWith(seal.source))
		) {
			seal = undefined;
			this.finalBlockSeal = undefined;
		}
		if (!seal) {
			seal = { blockType: "code", source: "", tailFrom: 0, lines: [], width, capsVersion };
			this.finalBlockSeal = seal;
		}
		// Largest offset right after a "\n" that still leaves a non-empty tail.
		let target = 0;
		let idx = text.indexOf("\n");
		while (idx !== -1) {
			if (idx + 1 < text.length) {
				target = idx + 1;
			}
			idx = text.indexOf("\n", idx + 1);
		}
		if (target > seal.tailFrom) {
			const extension = this.renderTokenLinesToBlockLines(
				this.renderCodeTextLines(text.slice(seal.tailFrom, target - 1), lang, !highlighting, contentWidth),
				width,
				contentWidth,
			);
			seal.lines.push(...extension);
			seal.source = text.slice(0, target);
			seal.tailFrom = target;
			// The growing code line just completed into the sealed prefix.
			seal.wrapSealedW = undefined;
			seal.wrapLines = undefined;
			seal.wrapPrevW = undefined;
			seal.wrapIneligible = false;
		}
		const tailText = text.slice(seal.tailFrom);
		if (highlighting && fenceTailFitsHighlight(tailText)) {
			// The capped highlighted tail is small, so it renders whole each
			// frame; the wrap seal's plain-text precondition does not hold under
			// highlighting. Resetting the wrap fields makes a later over-cap
			// tail re-seal from scratch instead of comparing against a
			// highlighted wrapPrevW.
			const tailLines = this.renderCodeTextLines(tailText, lang, true, contentWidth);
			seal.wrapSealedW = undefined;
			seal.wrapLines = undefined;
			seal.wrapPrevW = undefined;
			return [...seal.lines, ...this.renderTokenLinesToBlockLines(tailLines, width, contentWidth)];
		}
		// The tail is not always just the growing line: the hard seal only covers
		// newlines that leave a non-empty tail, so text ending with "\n" (indented
		// code keeps its trailing newline; a fence keeps trailing blank lines)
		// leaves complete lines here. Render every tail line like the unsealed
		// render does; the wrap seal covers only the last one. A fenced tail
		// beyond the streaming-highlight cap renders plain until closure.
		const tailLines = this.renderCodeTextLines(tailText, lang, !highlighting, contentWidth);
		const w = tailLines[tailLines.length - 1] ?? "";
		const tailHasAnsi = tailLines.some((line) => line.includes("\x1b"));
		if (seal.wrapIneligible || tailHasAnsi) {
			if (tailHasAnsi) {
				seal.wrapIneligible = true;
			}
			seal.wrapSealedW = undefined;
			seal.wrapLines = undefined;
			seal.wrapPrevW = undefined;
			return [...seal.lines, ...this.renderTokenLinesToBlockLines(tailLines, width, contentWidth)];
		}
		const headLines =
			tailLines.length > 1 ? this.renderTokenLinesToBlockLines(tailLines.slice(0, -1), width, contentWidth) : [];
		return [...seal.lines, ...headLines, ...this.wrapSealGrowingLine(seal, w, width, contentWidth)];
	}

	/**
	 * List seal. Every item but the last is complete: appended text lands in or
	 * after the last item, so a sealed item's source can only change through a
	 * rewrite of the tail item's bullet line (a partial bullet like "-" or "1."
	 * collapsing into a lazy continuation of the previous item) or a loose flip
	 * — both are caught by the per-frame validation (listSealIntact plus the
	 * loose check) before any sealed line is served. Item rendering is
	 * context-free given the item source (bullets derive from the absolute
	 * index, and reference definitions never reach this path: the caller only
	 * seals when tokens.links is empty), so byte-identical sealed item raws
	 * imply byte-identical sealed lines. The tail item is re-rendered every
	 * frame.
	 */
	private renderFinalListSealed(
		token: Tokens.List,
		width: number,
		contentWidth: number,
		capsVersion: number,
	): string[] | undefined {
		const items = token.items;
		if (!Array.isArray(items) || items.length === 0 || typeof token.raw !== "string") {
			return undefined;
		}
		let seal = this.finalBlockSeal;
		if (
			seal &&
			(seal.blockType !== "list" ||
				seal.width !== width ||
				seal.capsVersion !== capsVersion ||
				seal.loose !== token.loose ||
				!this.listSealIntact(token, seal))
		) {
			seal = undefined;
			this.finalBlockSeal = undefined;
		}
		if (!seal) {
			seal = { blockType: "list", source: "", count: 0, loose: token.loose, lines: [], width, capsVersion };
			this.finalBlockSeal = seal;
		}
		const target = items.length - 1;
		if (target > seal.count) {
			const extension = this.renderTokenLinesToBlockLines(
				this.renderListItems(token, 0, seal.count, target, undefined, contentWidth),
				width,
				contentWidth,
			);
			let source = seal.source;
			for (let i = seal.count; i < target; i++) {
				const raw = items[i]?.raw;
				if (typeof raw !== "string") {
					this.finalBlockSeal = undefined;
					return undefined;
				}
				source += raw;
			}
			seal.lines.push(...extension);
			seal.source = source;
			seal.count = target;
		}
		const tailLines = this.renderTokenLinesToBlockLines(
			this.renderListItems(token, 0, seal.count, items.length, undefined, contentWidth),
			width,
			contentWidth,
		);
		return [...seal.lines, ...tailLines];
	}

	/**
	 * Whether the sealed item prefix still matches the fresh list token: the
	 * list raw keeps the sealed source byte-identical (one startsWith), an
	 * unsealed tail item still exists, and the first seal.count item raws tile
	 * exactly the sealed source length. An absorption rewrite shifts an item
	 * boundary and breaks the tiling even when the raw prefix matches.
	 */
	private listSealIntact(token: Tokens.List, seal: FinalListSeal): boolean {
		if (token.items.length <= seal.count || !token.raw.startsWith(seal.source)) {
			return false;
		}
		let pos = 0;
		for (let i = 0; i < seal.count; i++) {
			const raw = token.items[i]?.raw;
			if (typeof raw !== "string") {
				return false;
			}
			pos += raw.length;
		}
		return pos === seal.source.length;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else if (headingLevel >= 5) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.italic(text));
				} else if (headingLevel === 4) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.italic(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				lines.push(headingText);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				lines.push(...this.renderCodeBlock(token, width));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "blockMath": {
				lines.push(...this.renderMathBlock(token as unknown as MathToken));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after math blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, styleContext, width);
				lines.push(...listLines);
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as any, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					// Re-apply the quote style after full resets (\x1b[0m) and after the
					// foreground-only resets (\x1b[39m) that theme.fg and the code
					// highlighter close their spans with.
					const lineWithReappliedStyle = line.replace(
						/\x1b\[(?:0|39)m/g,
						(reset) => `${reset}${quoteStylePrefix}`,
					);
					return quoteStyle(lineWithReappliedStyle);
				};

				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(sanitizeRenderText(token.raw.trim())));
				}
				break;

			case "space":
				lines.push("");
				break;

			default:
				if ("text" in token && typeof token.text === "string") {
					lines.push(sanitizeRenderText(token.text));
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		// Model text passes sanitizeRenderText at every leaf below (the same gate
		// Text.render uses): theme SGR and terminated OSC 8 links survive, every
		// other escape sequence and bare control byte is dropped before the
		// component's own styling wraps go on.
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = sanitizeRenderText(text).split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "text":
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(sanitizeRenderText(token.text)) + stylePrefix;
					break;

				case "inlineMath": {
					const mathStyle = this.theme.math ?? this.theme.code;
					const converted = latexToUnicode(sanitizeRenderText((token as unknown as MathToken).text)).replace(
						/\s*\n\s*/g,
						" ",
					);
					result += mathStyle(converted) + stylePrefix;
					break;
				}

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					// The destination is model text too: it lands in the OSC 8 parameter
					// and in the visible (href) fallback, where a raw BEL or escape would
					// break out of the sequence the component wraps around it.
					const rawHref = sanitizeRenderText(token.href);
					// A Windows drive letter is a file path, not a URL scheme.
					const target = rawHref.replace(/^([a-z]:[\\/])/i, "file:///$1");
					const href =
						!target.startsWith("#") &&
						(this.options.baseUrl || target !== rawHref) &&
						URL.canParse(target, this.options.baseUrl)
							? new URL(target, this.options.baseUrl).href
							: target;
					const linkedText = hyperlink(styledLink, href);
					if (getCapabilities().hyperlinks) {
						result += linkedText + stylePrefix;
					} else {
						// Keep the visible URL fallback while letting fullscreen hit testing open the label.
						const hrefForComparison = rawHref.startsWith("mailto:") ? rawHref.slice(7) : rawHref;
						if (token.text === rawHref || token.text === hrefForComparison) {
							result += linkedText + stylePrefix;
						} else {
							result += linkedText + this.theme.linkUrl(` (${rawHref})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				default:
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, styleContext?: InlineStyleContext, width = 80): string[] {
		return this.renderListItems(token, depth, 0, token.items.length, styleContext, width);
	}

	/**
	 * Render items [fromItem, toItem) of a list. Bullet numbers stay absolute
	 * (start + index), so a subrange renders exactly the lines the full loop
	 * would produce for those items.
	 */
	private renderListItems(
		token: Tokens.List,
		depth: number,
		fromItem: number,
		toItem: number,
		styleContext?: InlineStyleContext,
		width = 80,
	): string[] {
		const lines: string[] = [];
		const indent = "  ".repeat(depth);
		// marked types an unordered list's start as ""; it is never used then.
		const startNumber = token.start === "" ? 1 : token.start;

		for (let i = fromItem; i < toItem; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";

			const { lines: itemLines, kinds } = this.renderListItem(item.tokens || [], depth, width, styleContext);

			if (itemLines.length > 0) {
				for (const [j, line] of itemLines.entries()) {
					if (kinds[j] === "nested") {
						// A nested list line already carries its own indent and bullet.
						lines.push(line);
					} else if (j === 0 && kinds[j] !== "block") {
						lines.push(indent + this.theme.listBullet(bullet) + line);
					} else if (j === 0) {
						// Block content opening the item: keep the bullet visible on its own
						// line, then render the block indented under it.
						lines.push(indent + this.theme.listBullet(bullet.trimEnd()));
						lines.push(`${indent}  ${line}`);
					} else {
						lines.push(`${indent}  ${line}`);
					}
				}
			} else {
				lines.push(indent + this.theme.listBullet(bullet));
			}
		}

		return lines;
	}

	/**
	 * Render list item tokens, handling nested lists
	 * Returns lines WITHOUT the parent indent (renderList will add it), plus the
	 * kind of each line so the caller can tell nested-list lines (which already
	 * carry their own indent and bullet) and block content (indented without a
	 * bullet) apart from plain text.
	 */
	private renderListItem(
		tokens: Token[],
		parentDepth: number,
		width = 80,
		styleContext?: InlineStyleContext,
	): { lines: string[]; kinds: ListItemLineKind[] } {
		const lines: string[] = [];
		const kinds: ListItemLineKind[] = [];

		for (const token of tokens) {
			if (token.type === "list") {
				// Nested list - render with one additional indent level
				// These lines will have their own indent, so we just add them as-is
				const nestedLines = this.renderList(token as Tokens.List, parentDepth + 1, styleContext, width);
				for (const line of nestedLines) {
					lines.push(line);
					kinds.push("nested");
				}
			} else if (token.type === "text") {
				// Text content (may have inline tokens)
				const text =
					token.tokens && token.tokens.length > 0
						? this.renderInlineTokens(token.tokens, styleContext)
						: token.text || "";
				lines.push(text);
				kinds.push("text");
			} else if (token.type === "paragraph") {
				// Paragraph in list item
				const text = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(text);
				kinds.push("text");
			} else if (token.type === "code") {
				// Code block in list item; the caller indents every line by
				// (parentDepth + 1) levels of two columns, so pay that budget here.
				for (const line of this.renderCodeBlock(token, Math.max(1, width - (parentDepth + 1) * 2))) {
					lines.push(line);
					kinds.push("block");
				}
			} else if (token.type === "blockMath") {
				// Display math in list item
				for (const line of this.renderMathBlock(token as unknown as MathToken)) {
					lines.push(line);
					kinds.push("block");
				}
			} else {
				// Other block content (tables, blockquotes, headings, hr, …) used to
				// fall through renderInlineTokens, which only reads `token.text` —
				// table tokens carry none, so entire tables silently vanished. Render
				// them with the regular token renderer instead. The caller indents
				// every line by (parentDepth + 1) levels of two columns: pay that
				// budget up front, or a table that fits its own box tears at the
				// right edge once the prefix lands.
				const blockWidth = Math.max(1, width - (parentDepth + 1) * 2);
				const blockLines = this.renderToken(token, blockWidth, undefined, styleContext);
				while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
					blockLines.pop();
				}
				for (const line of blockLines) {
					lines.push(line);
					kinds.push("block");
				}
			}
		}

		return { lines, kinds };
	}

	private renderCodeBlock(token: Token, width?: number): string[] {
		if (!("text" in token) || typeof token.text !== "string") {
			return [];
		}
		const lang = "lang" in token && typeof token.lang === "string" ? token.lang : undefined;
		return this.renderCodeTextLines(token.text, lang, true, width);
	}

	/** Render code text to indented lines, highlighted unless highlight=false. */
	private renderCodeTextLines(
		codeText: string,
		lang: string | undefined,
		highlight: boolean = true,
		wrapWidth?: number,
	): string[] {
		const indent = this.theme.codeBlockIndent ?? "  ";
		const highlightCode = highlight ? this.theme.highlightCode : undefined;
		// The wash runs before the highlighter so a fence of raw escape bytes
		// reaches neither the terminal nor the theme's highlighter.
		const cleanText = sanitizeRenderText(codeText);
		const renderedCodeLines = highlightCode
			? highlightCode(cleanText, lang)
			: cleanText.split("\n").map((codeLine) => this.theme.codeBlock(codeLine));
		const codeLines = renderedCodeLines.length > 0 ? renderedCodeLines : [this.theme.codeBlock("")];

		if (wrapWidth === undefined) {
			return codeLines.map((codeLine) => `${indent}${codeLine}`);
		}
		// Wrap at the budget the caller handed down and re-apply the indent to the
		// continuation lines: the generic block wrap would otherwise spill them at
		// column 0, outside the code block. The wrapped pieces fit the budget, so
		// the outer wrap leaves them alone.
		const textWidth = Math.max(1, wrapWidth - visibleWidth(indent));
		const lines: string[] = [];
		for (const codeLine of codeLines) {
			for (const piece of wrapTextWithAnsi(codeLine, textWidth)) {
				lines.push(`${indent}${piece}`);
			}
		}
		return lines;
	}

	/** Render display math: converted to Unicode, indented like a code block. */
	private renderMathBlock(token: MathToken): string[] {
		const indent = this.theme.codeBlockIndent ?? "  ";
		const style = this.theme.mathBlock ?? this.theme.codeBlock;
		const mathLines = latexToUnicode(sanitizeRenderText(token.text))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		return mathLines.map((line) => indent + style(line));
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Token & { header: any[]; rows: any[][]; raw?: string },
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(sanitizeRenderText(token.raw), availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(markTableStart(`┌─${topBorderCells.join("─┬─")}─┐`));

		const headerCells = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return { lines: this.wrapCellText(text, columnWidths[i]), content: stripAnsi(text) };
		});
		const headerLineCount = Math.max(...headerCells.map((cell) => cell.lines.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCells.map((cell, colIdx) => {
				const text = cell.lines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return markTableCell(this.theme.bold(padded), 0, colIdx, lineIdx, cell.content);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCells = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return { lines: this.wrapCellText(text, columnWidths[i]), content: stripAnsi(text) };
			});
			const rowLineCount = Math.max(...rowCells.map((cell) => cell.lines.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCells.map((cell, colIdx) => {
					const text = cell.lines[lineIdx] || "";
					const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
					return markTableCell(padded, rowIndex + 1, colIdx, lineIdx, cell.content);
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(markTableEnd(`└─${bottomBorderCells.join("─┴─")}─┘`));

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
