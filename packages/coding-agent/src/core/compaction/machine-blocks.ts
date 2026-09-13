/**
 * Machine-generated blocks appended to a compaction summary.
 *
 * Compaction ends by bolting deterministic sections onto the model's narrative:
 * the file lists (formatFileOperations), the fact appendix and the verbatim
 * user-request section. They share one shape - `<tag attrs>body</tag>` - and one
 * lifecycle rule: the next compaction must be able to take them apart again, so
 * the structured part can be carried forward byte-exact while the narrative part
 * goes back to the model.
 *
 * Keeping the parse in one place is what makes "the model never rewrites a SHA"
 * enforceable rather than aspirational: stripMachineBlocks removes every block
 * before the summary is fed to the summarizer, so a corrupted restatement of a
 * machine block cannot enter the next generation even in principle.
 */

/** Every block tag compaction knows how to render, parse and strip. */
export const MACHINE_BLOCK_TAGS = ["read-files", "modified-files", "fact-appendix", "user-requests"] as const;

export type MachineBlockTag = (typeof MACHINE_BLOCK_TAGS)[number];

export interface MachineBlock {
	tag: MachineBlockTag;
	attributes: Record<string, string>;
	/** Raw text between the opening and closing tag, with the wrapping newlines removed. */
	body: string;
}

/** Render one block, including the blank line that separates it from what precedes it. */
export function renderMachineBlock(
	tag: MachineBlockTag,
	attributes: Record<string, string | number>,
	body: string,
): string {
	const renderedAttributes = Object.entries(attributes)
		.map(([key, value]) => ` ${key}="${escapeAttributeValue(String(value))}"`)
		.join("");
	if (body.length === 0) return `\n\n<${tag}${renderedAttributes}>\n</${tag}>`;
	return `\n\n<${tag}${renderedAttributes}>\n${body}\n</${tag}>`;
}

function escapeAttributeValue(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeAttributeValue(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/** Parse `key="value"` pairs out of an opening tag's attribute text. */
export function parseBlockAttributes(attributeText: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const pattern = /([\w:-]+)\s*=\s*"([^"]*)"/g;
	for (const match of attributeText.matchAll(pattern)) {
		attributes[match[1]] = unescapeAttributeValue(match[2]);
	}
	return attributes;
}

function blockPattern(tag: MachineBlockTag): RegExp {
	// Tags come from MACHINE_BLOCK_TAGS, never from input, so the interpolation is closed.
	return new RegExp(`\\n*<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>\\n*`, "g");
}

/** Every occurrence of the given tags, in document order. */
export function findMachineBlocks(text: string, tags: readonly MachineBlockTag[] = MACHINE_BLOCK_TAGS): MachineBlock[] {
	const found: Array<MachineBlock & { index: number }> = [];
	for (const tag of tags) {
		for (const match of text.matchAll(blockPattern(tag))) {
			found.push({
				index: match.index ?? 0,
				tag,
				attributes: parseBlockAttributes(match[1]),
				body: match[2].replace(/^\n/, "").replace(/\n$/, ""),
			});
		}
	}
	return found.sort((a, b) => a.index - b.index).map(({ index: _index, ...block }) => block);
}

/** First occurrence of one tag, or undefined when the text carries none. */
export function findMachineBlock(text: string, tag: MachineBlockTag): MachineBlock | undefined {
	const match = blockPattern(tag).exec(text);
	if (!match) return undefined;
	return {
		tag,
		attributes: parseBlockAttributes(match[1]),
		body: match[2].replace(/^\n/, "").replace(/\n$/, ""),
	};
}

/**
 * Remove machine blocks from a summary, leaving the model-written narrative.
 *
 * Used before feeding a previous summary back to the summarizer: the blocks are
 * regenerated deterministically every generation, so sending them costs frame
 * budget and invites the model to restate (and silently alter) values it cannot
 * improve on. Blank lines left behind are collapsed so repeated generations do
 * not grow a tail of empty lines.
 */
export function stripMachineBlocks(text: string, tags: readonly MachineBlockTag[] = MACHINE_BLOCK_TAGS): string {
	let stripped = text;
	for (const tag of tags) {
		// The pattern eats the blank lines around the block; put one paragraph break
		// back so narrative sections on either side stay separated.
		stripped = stripped.replace(blockPattern(tag), "\n\n");
	}
	return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

/** Line body of a list-style block (`<read-files>`, `<modified-files>`). */
export function parseBlockLines(body: string): string[] {
	return body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}
