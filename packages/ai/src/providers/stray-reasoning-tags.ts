/**
 * Stray reasoning-tag scrubbing for providers whose models leak thinking
 * markup into the content stream.
 *
 * Qwen-family models with thinking enabled occasionally emit the reasoning
 * closing tag (`</think>` / `</think>`) as ordinary content between tool
 * calls; the tag then renders as a bare line in the transcript (observed
 * 2026-09-26, qwen3.8-max over the DashScope native protocol: 28 text blocks
 * consisting of nothing else). The tag carries no information the thinking
 * block does not already hold, so it is dropped at stream finalization.
 *
 * Only tag occurrences that sit alone on their line are removed: a tag
 * embedded in prose or in a quoted snippet survives, and a text block that
 * consisted of nothing but leaked tags is dropped entirely.
 */

/** A reasoning open/close tag occupying its own line (or the whole text). */
const STRAY_REASONING_TAG_LINE = /(^|\n)[ \t]*<\/?(?:think|think)>[ \t]*(?:\r?\n|$)/g;

/** Remove lone-line reasoning tags; idempotent and stable under repetition. */
export function stripStrayReasoningTags(text: string): string {
	let cleaned = text;
	for (let pass = 0; pass < 4; pass++) {
		const next = cleaned.replace(STRAY_REASONING_TAG_LINE, "$1");
		if (next === cleaned) return next;
		cleaned = next;
	}
	return cleaned;
}

/**
 * Scrub leaked reasoning tags from a finalized block list, dropping text
 * blocks that consisted of nothing else. Iterated backwards so splicing a
 * vacated block keeps the indices of the blocks still to visit valid.
 */
export function pruneStrayReasoningTags(blocks: Array<{ type: string; text?: string }>): void {
	for (let i = blocks.length - 1; i >= 0; i--) {
		const block = blocks[i];
		if (block.type !== "text" || typeof block.text !== "string") continue;
		const cleaned = stripStrayReasoningTags(block.text);
		if (cleaned === block.text) continue;
		if (cleaned.trim() === "") {
			blocks.splice(i, 1);
			continue;
		}
		block.text = cleaned;
	}
}
