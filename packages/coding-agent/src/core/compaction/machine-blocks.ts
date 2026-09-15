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
 *
 * Where a block is found is a security property, not a formatting detail. The
 * renderer is the only code that writes the document's tail, so a machine block is
 * anchored there: its closing tag has to be the document's last line, its opening tag
 * has to be a whole line of strict shape, and the last matching opener wins - among
 * the openers that start a paragraph, which is where the renderer puts one.
 * Any other predicate can be forged from text that reaches the document through
 * some other channel - a tool `path` argument, a narrative that merely names the
 * tags (the summarization prompt itself contains them), a hook-authored summary -
 * and a forged block header ahead of the real one wins the non-greedy match.
 *
 * Anchoring decides what to *trust*, not what to *lose*. The renderer stops being the
 * last writer the moment a note, a footer, an import or a hand edit lands after the
 * blocks, and refusing to read the block outright threw away a ledger that was still in
 * the document. The read path therefore recovers such a block from its last strict opener
 * and its last line-owning closer, and warns: the anchored read stays authoritative, the
 * recovered one is a best effort with a name.
 */

import { getLogger } from "@earendil-works/pi-ai";

const blockLog = getLogger("coding-agent.compaction");

/**
 * Every block tag compaction knows how to render, parse and strip.
 *
 * The `ipython_state` pair joins the family as strip-only members (MVS-3): the
 * kernel roster notices are machine-authored custom messages, and when the
 * summarizer restates one into the summary narrative the next generation must
 * not feed that stale roster back - the fresh notice is appended after every
 * compaction, so an old generation has no reuse value. Nothing renders them;
 * they are recognized so stripping and the delimiter-shape checks cover them.
 */
export const MACHINE_BLOCK_TAGS = [
	"read-files",
	"modified-files",
	"fact-appendix",
	"user-requests",
	"ipython_state",
	"ipython_state_restored",
] as const;

export type MachineBlockTag = (typeof MACHINE_BLOCK_TAGS)[number];

/**
 * What a machine-block delimiter looks like anywhere inside foreign text.
 *
 * Every payload that reaches a block body is checked against this: a body that
 * matches can end its own block, or forge another one, on the next parse.
 */
const BLOCK_DELIMITER_SHAPE =
	/<\/?(?:read-files|modified-files|fact-appendix|user-requests|ipython_state_restored|ipython_state)\b/;

/** Whether text carries anything that would read back as a machine-block delimiter. */
export function readsAsBlockDelimiter(text: string): boolean {
	return BLOCK_DELIMITER_SHAPE.test(text);
}

export interface MachineBlock {
	tag: MachineBlockTag;
	attributes: Record<string, string>;
	/** Raw text between the opening and closing tag, with the wrapping newlines removed. */
	body: string;
}

/** A block located in the document's tail region. */
interface AnchoredBlock extends MachineBlock {
	/** Index of the opening tag's `<`. */
	index: number;
	/** Index just past the closing tag. */
	end: number;
}

/** Strict opening tag for one name: line start, exact name, only `k="v"` attributes, then `>`. */
function openingTagPattern(tag: MachineBlockTag): RegExp {
	// `^`/`$` need `m`; the attribute shape is strict so `<user-requests-evil>` and
	// `<user-requests /evil>` are not openings at all.
	return new RegExp(`^<${tag}((?:[ \\t]+[\\w:-]+="[^"]*")*)[ \\t]*>$`, "gm");
}

/** The closing tag of one name covering a whole line. */
function closingTagLiteral(tag: MachineBlockTag): string {
	return `</${tag}>`;
}

/** Render one block, including the blank line that separates it from what precedes it. */
export function renderMachineBlock(
	tag: MachineBlockTag,
	attributes: Record<string, string | number>,
	body: string,
): string {
	assertBodyIsInert(tag, body);
	const renderedAttributes = Object.entries(attributes)
		.map(([key, value]) => ` ${key}="${escapeAttributeValue(String(value))}"`)
		.join("");
	if (body.length === 0) return `\n\n<${tag}${renderedAttributes}>\n</${tag}>`;
	return `\n\n<${tag}${renderedAttributes}>\n${body}\n</${tag}>`;
}

/**
 * Refuse to render a body that would read back as a delimiter.
 *
 * This is an alarm, not a second escape: every producer owns its own encoding
 * (the JSON lines escape `<`, the file lists drop what they cannot carry), and this
 * turns "a producer forgot" from a silent seam into a logged failure. It cannot
 * throw - a compaction must never fail because a transcript held odd text.
 */
function assertBodyIsInert(tag: MachineBlockTag, body: string): void {
	const match = BLOCK_DELIMITER_SHAPE.exec(body);
	if (!match) return;
	blockLog.warn("a machine block body reads as a block delimiter; the producer must escape or drop it", {
		tag,
		shape: match[0],
		bodyLength: body.length,
	});
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

/** The closing tag that ends this text, when one does, and where it starts. */
function closingTagAtEnd(text: string): { tag: MachineBlockTag; start: number } | undefined {
	for (const tag of MACHINE_BLOCK_TAGS) {
		const literal = closingTagLiteral(tag);
		const start = text.length - literal.length;
		if (start < 0 || text.slice(start) !== literal) continue;
		// The closer has to own its line: a payload's `x</user-requests>` is not it.
		if (start > 0 && text[start - 1] !== "\n") continue;
		return { tag, start };
	}
	return undefined;
}

/**
 * The opening tag a block body belongs to, before `limit`, attributes included.
 *
 * Of the strict openers before the anchored closer, the last one wins - a look-alike
 * written ahead of the real block is not a competing block. But an opener can also sit
 * *inside* a body (a file path is a plain line, and a `path` argument can be anything),
 * and that one is nearer the closer than the real opener it is nested in. The
 * renderer's output separates a block from what precedes it with a blank line, so the
 * candidates that follow that shape are preferred: an opener introduced by a paragraph
 * break is where a block starts, an opener glued to the line above it is inside one.
 * The last strict opener is the fallback for text that predates the shape (a hand-edited
 * or legacy summary), so compatibility does not depend on the blank line.
 */
function lastOpeningTag(
	text: string,
	limit: number,
	tag: MachineBlockTag,
): { attributes: Record<string, string>; start: number; end: number } | undefined {
	const pattern = openingTagPattern(tag);
	let found: { attributes: Record<string, string>; start: number; end: number } | undefined;
	let foundAtParagraphStart: { attributes: Record<string, string>; start: number; end: number } | undefined;
	for (const match of text.slice(0, limit).matchAll(pattern)) {
		const start = match.index ?? 0;
		const candidate = { attributes: parseBlockAttributes(match[1] ?? ""), start, end: start + match[0].length };
		found = candidate;
		if (isParagraphStart(text, start)) foundAtParagraphStart = candidate;
	}
	return foundAtParagraphStart ?? found;
}

/** Whether the line starting at `start` is separated from what precedes it by a blank line. */
function isParagraphStart(text: string, start: number): boolean {
	if (start === 0) return true;
	if (text[start - 1] !== "\n") return false;
	let cursor = start - 1;
	while (cursor > 0 && (text[cursor - 1] === " " || text[cursor - 1] === "\t")) cursor--;
	return cursor > 0 && text[cursor - 1] === "\n";
}

/**
 * Read the contiguous run of machine blocks that ends the document.
 *
 * Peeled from the end, one block at a time: the closing tag has to be the last line
 * of what is left, the opener has to be the last strict opening tag before it (so a
 * payload that forges a whole block inside an earlier block's body is part of that
 * body, never a block of its own), the body may contain delimiters - the last closer
 * is the block's own - and the opener is the one that starts a paragraph wherever one
 * candidate does.
 *
 * The peel always runs over every known tag, whichever ones the caller asks for:
 * "the tail region" is a property of the document, not of the query. Peeling only the
 * requested tags would stop at the last block of another tag and report no block for
 * a document whose `fact-appendix` sits before its `user-requests`.
 */
function scanTailBlocks(text: string, tags: readonly MachineBlockTag[]): AnchoredBlock[] {
	const blocks: AnchoredBlock[] = [];
	let cursor = trailingWhitespaceStart(text, text.length);
	while (cursor > 0) {
		const head = text.slice(0, cursor);
		const close = closingTagAtEnd(head);
		if (!close) break;
		const open = lastOpeningTag(head, close.start, close.tag);
		if (!open) break;
		if (tags.includes(close.tag)) {
			blocks.unshift({
				tag: close.tag,
				attributes: open.attributes,
				body: head.slice(open.end, close.start).replace(/^\n/, "").replace(/\n$/, ""),
				index: open.start,
				end: cursor,
			});
		}
		cursor = trailingWhitespaceStart(text, open.start);
	}
	return blocks;
}

function trailingWhitespaceStart(text: string, from: number): number {
	let cursor = from;
	while (cursor > 0 && /\s/.test(text[cursor - 1] ?? "")) cursor--;
	return cursor;
}

/** Index of the last `</tag>` that owns a line of its own, or undefined when there is none. */
function lastClosingTagLine(text: string, tag: MachineBlockTag): number | undefined {
	const literal = closingTagLiteral(tag);
	let from = text.length;
	for (;;) {
		const start = text.lastIndexOf(literal, from);
		if (start < 0) return undefined;
		let lineEnd = start + literal.length;
		while (text[lineEnd] === " " || text[lineEnd] === "\t") lineEnd++;
		const ownsLine = (start === 0 || text[start - 1] === "\n") && (lineEnd === text.length || text[lineEnd] === "\n");
		if (ownsLine) return start;
		from = start - 1;
	}
}

/**
 * Read the blocks the tail scan refuses, because something wrote after them.
 *
 * The anchored rule says "the renderer wrote the tail", and that is true only while the
 * renderer is the last writer. A footer, a note appended by a later writer, a summary
 * imported from another build or hand-edited all put text after the last block, and the
 * tail scan then reads nothing at all - the ledger is still in the document, one paragraph
 * away from the end.
 *
 * The predicate here is the anchored one minus exactly one clause: the closer no longer has
 * to be the document's last line, it only has to own a line of its own. Everything that
 * makes the anchored read trustworthy survives: the opener is still a whole line of strict
 * shape, and the *last* closer and the *last* opener before it win, so a look-alike written
 * ahead of the real block (in prose, in a tool `path`, in another block's body) still loses
 * to the real block. What the dropped clause bought was the guarantee that nothing follows
 * the block, and that guarantee is gone - so every read through this path warns, and the
 * caller can tell a recovered block from the renderer's own bytes.
 */
function scanUnanchoredBlocks(text: string, tags: readonly MachineBlockTag[]): AnchoredBlock[] {
	const blocks: AnchoredBlock[] = [];
	for (const tag of tags) {
		const closer = lastClosingTagLine(text, tag);
		if (closer === undefined) continue;
		const opener = lastOpeningTag(text, closer, tag);
		if (!opener) continue;
		blocks.push({
			tag,
			attributes: opener.attributes,
			body: text.slice(opener.end, closer).replace(/^\n/, "").replace(/\n$/, ""),
			index: opener.start,
			end: closer + closingTagLiteral(tag).length,
		});
	}
	return blocks.sort((left, right) => left.index - right.index);
}

/** Say that a ledger was read from a block the anchoring rule refused. */
function warnUnanchoredRead(text: string, blocks: AnchoredBlock[]): void {
	const last = blocks[blocks.length - 1];
	blockLog.warn(
		"machine blocks are not anchored at the end of the document; read back from their last match instead",
		{
			tags: blocks.map((block) => block.tag),
			blockStart: last?.index,
			trailingChars: text.length - (last?.end ?? text.length),
		},
	);
}

function toMachineBlock(block: AnchoredBlock): MachineBlock {
	return { tag: block.tag, attributes: block.attributes, body: block.body };
}

/**
 * Every machine block of the document's tail region, in document order.
 *
 * A requested tag the anchored scan could not see is read from its last match instead
 * (`scanUnanchoredBlocks`), because a block that is one paragraph away from the end is a
 * block the next generation still needs. The anchored blocks stay authoritative, and a
 * recovered block is announced.
 */
export function findMachineBlocks(text: string, tags: readonly MachineBlockTag[] = MACHINE_BLOCK_TAGS): MachineBlock[] {
	const anchored = scanTailBlocks(text, tags);
	const anchoredTags = new Set(anchored.map((block) => block.tag));
	const missing = tags.filter((tag) => !anchoredTags.has(tag));
	const recovered = missing.length > 0 ? scanUnanchoredBlocks(text, missing) : [];
	if (recovered.length > 0) warnUnanchoredRead(text, recovered);
	return [...anchored, ...recovered].sort((left, right) => left.index - right.index).map(toMachineBlock);
}

/** The document's last block of one tag, or undefined when the text carries none. */
export function findMachineBlock(text: string, tag: MachineBlockTag): MachineBlock | undefined {
	const anchored = scanTailBlocks(text, [tag]);
	const last = anchored[anchored.length - 1];
	if (last) return toMachineBlock(last);
	const recovered = scanUnanchoredBlocks(text, [tag]);
	const fallback = recovered[recovered.length - 1];
	if (!fallback) return undefined;
	warnUnanchoredRead(text, [fallback]);
	return toMachineBlock(fallback);
}

/**
 * Compare a block's declared record count with the records parsed back out of it.
 *
 * This runs on an already-anchored block - it takes a `MachineBlock`, which only the
 * tail scanner produces - and that ordering is the whole point: a forged header used
 * to be able to declare `count="1"` next to its own single injected record and be
 * self-consistently wrong, because the block it was checked against was the forged
 * one. Anchoring first means the attributes can only have been written by the
 * renderer, so a mismatch is damage rather than a lie.
 *
 * Anchoring runs once, before this check: a parse function that validated the text
 * it was about to search (the pre-F1-E shape) would be validating a different block
 * than the one it returns.
 */
export function checkMachineBlockSelfCount(
	block: MachineBlock,
	attribute: "count" | "facts",
	parsedRecords: number,
): void {
	const declared = Number.parseInt(block.attributes[attribute] ?? "", 10);
	if (!Number.isFinite(declared) || declared === parsedRecords) return;
	blockLog.warn(`<${block.tag}> block is damaged: its declared record count does not match the records parsed back`, {
		declared: block.attributes[attribute],
		parsedRecords,
	});
}

/**
 * Remove machine blocks from a summary, leaving the model-written narrative.
 *
 * Used before feeding a previous summary back to the summarizer: the blocks are
 * regenerated deterministically every generation, so sending them costs frame
 * budget and invites the model to restate (and silently alter) values it cannot
 * improve on. Blank lines left behind are collapsed so repeated generations do
 * not grow a tail of empty lines.
 *
 * Two passes, in this order:
 * 1. the anchored tail comes off whole (authoritative: the renderer only writes the
 *    tail), so a forged block inside a real block's body leaves with it;
 * 2. what is left is swept for blocks the anchoring rule cannot reach - a shape an
 *    older build or a hand-edited summary wrote, kept here so a legacy look-alike
 *    does not reach the summarizer either. The sweep is deliberately the looser of
 *    the two: it is not a source of truth for any ledger, it only decides what leaves
 *    the document, and the tail pass has already taken everything the renderer wrote.
 *    It still refuses a body that contains another opening tag of the same name: a
 *    narrative that merely names a block would otherwise pair that opener with the
 *    real block's closer and take the narrative in between with it.
 */
export function stripMachineBlocks(text: string, tags: readonly MachineBlockTag[] = MACHINE_BLOCK_TAGS): string {
	const tail = scanTailBlocks(text, tags);
	let stripped = tail.length > 0 ? text.slice(0, tail[0].index) : text;
	const swept: MachineBlockTag[] = [];
	for (const tag of tags) {
		const pattern = sweepPattern(tag);
		const after = stripped.replace(pattern, "\n\n");
		if (after !== stripped) swept.push(tag);
		stripped = after;
	}
	if (swept.length > 0) {
		// The sweep is the loose pass and never a source of truth, so a hit means the
		// anchoring rule did not own this block: the document's tail was written by
		// something other than the renderer, or by an older build. That is exactly the
		// document the read path now recovers a ledger from, so it must not slip through
		// quietly - a recovered ledger is worth having, and worth knowing about.
		blockLog.warn(
			"machine blocks were swept rather than anchored; the document's tail was not written by the renderer",
			{
				tags: swept,
				anchoredTags: tail.map((block) => block.tag),
			},
		);
	}
	return stripped.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * A block the anchoring rule cannot see, but that the document still carries.
 *
 * The opener has to be a line of strict shape, the closer does not have to open a
 * line of its own, and the body may not contain another opener of the same name.
 */
function sweepPattern(tag: MachineBlockTag): RegExp {
	return new RegExp(
		`\\n*^<${tag}((?:[ \\t]+[\\w:-]+="[^"]*")*)[ \\t]*>((?:(?!^<${tag}(?:[ \\t]|>))[\\s\\S])*?)</${tag}>\\n*`,
		"gm",
	);
}

/** Line body of a list-style block (`<read-files>`, `<modified-files>`). */
export function parseBlockLines(body: string): string[] {
	return body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}
