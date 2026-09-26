/**
 * Qwen and GLM models on the bailian compatible endpoint sometimes emit the reasoning
 * closing tag as ordinary content between tool calls, and it shows up as a bare
 * `</think>` line in the chat. The tag carries nothing the thinking block does not
 * already hold, so lines holding only a reasoning tag are dropped at stream end.
 *
 * A text block that carries reasoning after an opening tag is left alone: some
 * providers stream their thinking inline as `<think>...</think>`, and without the
 * tags that reasoning would read as part of the answer.
 */

/** An opening tag followed by reasoning, i.e. thinking streamed inline in the content. */
const INLINE_REASONING = /<think>\s*(?!<\/think>)\S/;

function isReasoningTagLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed === "</think>" || trimmed === "<think>";
}

/** Drop lines that hold nothing but a reasoning tag; a text left with only whitespace becomes "". */
export function stripStrayReasoningTags(text: string): string {
	if (!text.includes("think>") || INLINE_REASONING.test(text)) return text;
	const lines = text.split("\n");
	const kept = lines.filter((line) => !isReasoningTagLine(line));
	if (kept.length === lines.length) return text;
	const cleaned = kept.join("\n");
	return cleaned.trim() === "" ? "" : cleaned;
}

/**
 * Scrub text blocks in place. A block emptied this way stays in the list as "": its
 * start and delta events already went out with its content index, so removing it
 * would shift the index of every later block's end event. Empty text blocks are
 * skipped when rendering and when replaying history.
 */
export function scrubStrayReasoningTags(blocks: ReadonlyArray<{ type: string; text?: string }>): void {
	for (const block of blocks) {
		if (block.type !== "text" || typeof block.text !== "string") continue;
		block.text = stripStrayReasoningTags(block.text);
	}
}
