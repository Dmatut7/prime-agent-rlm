/**
 * Content-aware token density: the one caliber table for the multipliers this fork quotes.
 *
 * estimateTokens prices every character at chars/4, which is right for ASCII prose
 * and wrong for the two other things a transcript is full of: CJK text and fenced
 * code. Compaction therefore quotes more than one multiplier, and it used to quote
 * three that were not comparable - "1.4x overall and 3-4x on the CJK-heavy slices"
 * in this header, "~1.6x" at the trigger. They measured different things against
 * different bases, and the 3-4x one had no reading on disk behind it. This table
 * replaces all three: each row says what is measured, against what, and where the
 * number comes from.
 *
 * | multiplier | what the number is | source |
 * | --- | --- | --- |
 * | 1.00x | ASCII prose: the chars/4 baseline itself, so the correction is not a blanket inflation | ASCII_CHARS_PER_TOKEN below |
 * | 1.33x | fenced code, the per-class bound (4/3). A sample that also counts its fence markers reads 1.30x: this module prices the fence lines as ordinary text | CODE_CHARS_PER_TOKEN below |
 * | 2.67x | CJK, the per-class bound (4/1.5) and the largest correction this module can produce. The 1,350-character CJK pin reads 338 tokens flat against 900 dense | CJK_CHARS_PER_TOKEN below; pin in test/compaction-trigger-density.test.ts |
 * | 1.05-2.01x | real text on this machine, priced with this module: repository AGENTS.md 1.05x, whole system prompt 1.16x, harness digest 1.41x, ~/.prime/agent/AGENTS.md 2.01x | /tmp/wk2098/measure2.out (2026-09-17, 62,181 B system prompt); the two AGENTS.md rows re-read live on 2026-09-18 (1.05x / 1.99x) |
 * | 1.60x | provider-measured over one whole session: 982k prompt tokens reported by the provider against 614k chars/4 tokens estimated for the same content - the session that produced the production 400 | recorded on summarizationInflation in compaction.ts |
 * | ~~3-4x~~ | retired: "3-4x low on the CJK-heavy slices" had no reading behind it, and it is larger than the 2.67x bound this module's constants can produce. Deleted rather than restated | this header, before the cut-point relabel |
 *
 * The rows are not interchangeable. 2.67x is a per-class bound on a fully-CJK text,
 * 1.05-2.01x is what real mixed segments measure, and 1.60x is one session's
 * provider-reported aggregate. They agree on direction and disagree on scope, and
 * none of them is a correction to apply blindly: a transcript of ASCII prose is
 * priced at exactly 1.00x.
 *
 * Where each caliber applies, so the table cannot be read as "multiply anything here":
 * - This module prices the machine-generated blocks compaction appends to a summary
 *   (<read-files>/<modified-files>, <fact-appendix>, <user-requests>).
 * - estimateTokensByContent is the trigger and /usage caliber, and since the
 *   cut-point relabel it is also the caliber of the cut point, keepRecentTokens and
 *   the emergency shrink, so a nominal retained token means an estimated real token.
 * - The summarization request budget stays on the flat chars/4 caliber on purpose:
 *   summarizationInflation converts that allowance with the provider's own anchor,
 *   so pricing the same text here as well would count the correction twice.
 *
 * The blocks are sized here so a CJK-heavy verbatim user-request section cannot cost
 * three times what its character count suggests.
 */
/** Characters per token for ASCII prose: the flat baseline, and the 1.00x row of the table above. */
export const ASCII_CHARS_PER_TOKEN = 4;

/**
 * Characters per token for CJK syllabics. BPE tokenizers for Chinese/Japanese
 * spend about one token per character to one per two; 1.5 is the middle of that
 * range, and it caps this module's correction at 2.67x (see the table above). The
 * one provider-measured session landed at 1.60x overall, below the cap, so the
 * per-class constants correct in the safe direction without over-correcting.
 */
export const CJK_CHARS_PER_TOKEN = 1.5;

/**
 * Characters per token inside fenced code blocks: punctuation splits words up.
 * 1.33x against the flat baseline, the second row of the table above.
 */
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
