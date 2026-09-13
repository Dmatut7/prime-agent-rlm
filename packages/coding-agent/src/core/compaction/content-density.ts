/**
 * Content-aware token density for text the compaction pipeline generates itself.
 *
 * estimateTokens prices every character at chars/4, which is right for ASCII
 * prose and wrong for the two other things a transcript is full of: CJK text
 * (roughly one token per character) and code (denser than prose). A session whose
 * user writes Chinese measured 1.4x low overall and 3-4x low on the CJK-heavy
 * slices, so a budget expressed in raw character counts silently overspends.
 *
 * The summarization request budget already corrects for this with a provider
 * anchor (see summarizationInflation in compaction.ts); this module is the
 * fallback for text that has no provider count yet - the machine-generated blocks
 * compaction appends to a summary. Those blocks are sized here, so a CJK-heavy
 * verbatim user-request section cannot cost three times what its character count
 * suggests.
 */

/** Characters per token for ASCII prose: the same caliber as estimateTokens. */
export const ASCII_CHARS_PER_TOKEN = 4;

/**
 * Characters per token for CJK syllabics. BPE tokenizers for Chinese/Japanese
 * spend about one token per character to one per two; 1.5 is the middle measured
 * on the transcripts this fork runs on.
 */
export const CJK_CHARS_PER_TOKEN = 1.5;

/** Characters per token inside fenced code blocks: punctuation splits words up. */
export const CODE_CHARS_PER_TOKEN = 3;

export interface ContentDensity {
	totalChars: number;
	cjkChars: number;
	codeChars: number;
	otherChars: number;
	/** Estimated tokens, priced per character class instead of a flat chars/4. */
	tokens: number;
	/** tokens divided by the flat chars/4 estimate; 1 means plain ASCII prose. */
	densityRatio: number;
}

function isCjkCodePoint(code: number): boolean {
	return (
		(code >= 0x3000 && code <= 0x303f) || // CJK punctuation
		(code >= 0x3040 && code <= 0x30ff) || // hiragana + katakana
		(code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
		(code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
		(code >= 0xac00 && code <= 0xd7af) || // hangul syllables
		(code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
		(code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
		(code >= 0xff00 && code <= 0xffef) // halfwidth and fullwidth forms
	);
}

/** Whether any character of the text is CJK. */
export function containsCjk(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (isCjkCodePoint(text.charCodeAt(i))) return true;
	}
	return false;
}

/**
 * Price text by character class.
 *
 * Fenced code blocks are found with a line-based scan (``` or ~~~ fences); an
 * unterminated fence runs to the end of the text, which is the safe reading for a
 * block that was cut off mid-serialization. CJK characters are always priced as
 * CJK, including inside a fence, because that is what dominates their cost.
 * Every character is counted exactly once, so the three buckets sum to
 * totalChars.
 */
export function measureContentDensity(text: string): ContentDensity {
	let cjkChars = 0;
	let codeChars = 0;
	let otherChars = 0;
	let inFence = false;
	let fenceChar = "";
	const lines = text.split("\n");
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex];
		const fence = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence && (!inFence || fence[1][0] === fenceChar)) {
			inFence = !inFence;
			fenceChar = inFence ? fence[1][0] : "";
		}
		for (let i = 0; i < line.length; i++) {
			if (isCjkCodePoint(line.charCodeAt(i))) cjkChars++;
			else if (inFence) codeChars++;
			else otherChars++;
		}
		// Price the newline that follows every line but the last.
		if (lineIndex < lines.length - 1) otherChars++;
	}
	const tokens =
		codeChars / CODE_CHARS_PER_TOKEN + cjkChars / CJK_CHARS_PER_TOKEN + otherChars / ASCII_CHARS_PER_TOKEN;
	const flat = text.length / ASCII_CHARS_PER_TOKEN;
	return {
		totalChars: text.length,
		cjkChars,
		codeChars,
		otherChars,
		tokens: Math.ceil(tokens),
		densityRatio: flat > 0 ? tokens / flat : 1,
	};
}

/** Token estimate for generated text: same shape as estimateTokens, content-priced. */
export function estimateTextTokensByContent(text: string): number {
	return measureContentDensity(text).tokens;
}
