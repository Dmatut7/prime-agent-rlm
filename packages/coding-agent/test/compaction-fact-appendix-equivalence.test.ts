/**
 * Differential equivalence pin for the fact-appendix extraction refactor.
 *
 * Copied verbatim from edcc31ff7 as the differential reference; do not edit.
 * The reference block below is lines 91-100, 102-112, 165-177, 179-453, 455-465,
 * 467-477, 479-520 and 522-595 of
 * `git show edcc31ff7:packages/coding-agent/src/core/compaction/fact-appendix.ts`
 * (constants MAX_VALUE_CHARS/FACT_CONTEXT_MAX_CHARS/SOURCE_WEIGHTS, factKey, the
 * whole extraction section, and the message-level textBlocks/factSources/
 * extractFacts/collapseShaAliases chain it feeds), with every top-level
 * identifier renamed by appending a Reference suffix and the `export` keyword
 * dropped so the copies stay inside this module. Nothing else was touched: the
 * machine-checked reverse-rename diff lives in EVIDENCE/fact-appendix/.
 *
 * What this pins: the production extraction must produce exactly the same
 * facts, in the same order (fullSha -> shortSha -> path -> number -> error ->
 * issue), as the baseline for every corpus text in both prose modes, the same
 * per-message records for every message role, and byte-identical rendered
 * appendix text through buildFactLedger/mergeFactLedger/pruneFactLedger.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildFactLedger,
	extractFacts,
	extractFactsFromText,
	type FactKind,
	type FactRecord,
	mergeFactLedger,
	pruneFactLedger,
	renderFactAppendix,
} from "../src/core/compaction/index.js";

/* -------------------------------------------------------------------------- */
/* Differential reference (verbatim baseline copy)                             */
/* -------------------------------------------------------------------------- */

const MAX_VALUE_CHARS_REFERENCE: Readonly<Record<FactKind, number>> = {
	sha: 64,
	path: 200,
	number: 80,
	error: 200,
	issue: 16,
};

/** Longest verbatim snippet kept alongside a number: enough to disambiguate, not a copy of the line. */
const FACT_CONTEXT_MAX_CHARS_REFERENCE = 120;
/** How much one fact source contributes to a mention weight. */
const SOURCE_WEIGHTS_REFERENCE = {
	user: 3,
	assistantText: 3,
	assistantThinking: 1,
	toolCall: 2,
	toolResult: 1,
	custom: 2,
	bashCommand: 3,
	bashOutput: 1,
} as const;
/**
 * Deduplication key for a fact.
 *
 * Derivable from the stored value, so a ledger recovered from details and one
 * recovered from the rendered block key identically. Errors collapse across the
 * numbers embedded in them ("at position 1871" vs "at position 2000" are one
 * recurring failure, not two facts) and numbers collapse across identifier case.
 */
function factKeyReference(kind: FactKind, value: string): string {
	if (kind === "error") return value.replace(/\d+/g, "N");
	if (kind === "number") return value.toLowerCase();
	return value;
}
/* -------------------------------------------------------------------------- */
/* Extraction                                                                  */
/* -------------------------------------------------------------------------- */

const FULL_SHA_PATTERN_REFERENCE = /(?<![0-9a-fA-F])[0-9a-f]{40}(?![0-9a-fA-F])/g;
const SHORT_SHA_PATTERN_REFERENCE = /(?<![0-9a-fA-F-])([0-9a-f]{7,10})(?![0-9a-fA-F-])/g;
const GIT_CONTEXT_PATTERN_REFERENCE =
	/\b(?:commit|commits|sha|head|revert|cherry-pick|checkout|merge|rebase|push|tag|blame|bisect|archive|reset|show|diff|rev-parse|git)\b/i;

const PATH_TRAILING_JUNK_REFERENCE = /[.,;:!?)\]}'"`>*]+$/;
const RELATIVE_WITH_EXTENSION_REFERENCE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const PATH_NOISE_SEGMENT_REFERENCE = /(?:^|\/)(?:node_modules|\.git|\.venv|__pycache__)(?:\/|$)/;

/**
 * Numbers carrying a unit. The lookbehind keeps UUID and hex-dash runs out: in
 * "01a07767-0a8e-719d-9367" the segment "719d" reads as 719 days.
 */
const UNIT_NUMBER_PATTERN_REFERENCE =
	/(?<![\w.-])(\d+(?:\.\d+)?) ?(milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|bytes?|characters?|chars?|tokens?|lines?|tok|ms|min|s|h|d|MB|GB|KB|TB|KiB|MiB|GiB|B|%|x|×)\b/g;
/**
 * Identifier/number pairs, including quoted JSON keys.
 *
 * The quoted form matters: a transcript is mostly tool output, and settings,
 * budgets and limits reach it as JSON (`"reserveTokens": 16384`). Matching only the
 * bare identifier form misses exactly the thresholds worth keeping.
 */
const ASSIGN_NUMBER_PATTERN_REFERENCE = /\b([A-Za-z_][A-Za-z0-9_]{2,40})"?[ \t]{0,2}[:=][ \t]{0,2}(-?\d+(?:\.\d+)?)\b/g;
/**
 * Keyword/number pairs written as prose ("exit code 2", "line 22", "limit: 8").
 * The separator is mandatory: without it "qwen3.8-max-0902" reads as max=-0902.
 */
const KEYWORD_NUMBER_PATTERN_REFERENCE =
	/\b(exit code|exit|status|port|lines|line|attempts|attempt|retries|retry|threshold|budget|limit|cap|maximum|minimum|max|min|reserve|keep|timeout|window|generation|gen|version|depth|count|size)(?:[ \t]*[:=#][ \t]*|[ \t]+)(-?\d+(?:\.\d+)?)\b/gi;
/** Config-shaped identifiers: SCREAMING_CASE, camelCase or snake_case. Prose words are not. */
const CONFIG_IDENTIFIER_PATTERN_REFERENCE =
	/^(?:[A-Z][A-Z0-9_]{2,}|[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+)$/;

/**
 * A line that reports a failure rather than mentioning one.
 *
 * The identifier prefix is optional so a bare `Error:` counts - the single most
 * common shape in agent transcripts, and the one the audit found evaporating from
 * summaries ("Error: Failed to resolve API key for provider ...").
 */
const ERROR_LINE_PATTERN_REFERENCE =
	/(?:\b(?:[A-Za-z_$][\w$]*)?(?:Error|Exception)\b(?: summary)?\s*:|^\s*(?:FAILED|FAIL|ERROR|Error|error|WARN|Warning|panic|fatal|Traceback)\b|\b(?:ENOENT|EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EADDRINUSE|SIGKILL|SIGSEGV)\b|\b(?:[Ff]ailed|[Uu]nable|[Rr]efusing) to\b)/;
/**
 * Lines that mention a failure without reporting one: source code, diff hunks and
 * test bodies.
 *
 * Anchored at the line start for keywords on purpose - prose reports such as
 * "Error: Refinement failed: the model did not return valid JSON" contain `return`
 * and `if` as ordinary English words, and filtering on those loses exactly the
 * user-reported errors the appendix exists to keep.
 */
const CODE_SHAPED_LINE_PATTERN_REFERENCE =
	/(?:;\s*$|\{\s*$|=>|\bexpect\(|\bvi\.|\bdescribe\(|^\s*(?:const|let|var|function|class|interface|type|import|export|return|throw|if|for|while|switch|try|catch|elif|else|except|raise|assert|finally|lambda|yield|with|def|end|using|do|done|esac)\b|^\s*(?:[}{*]|\/\/|\/\*)|^\s*[+-]{1,2}\s|^\s*@@|\w\?\s*:|\bnew\s+[A-Z]\w*\()/;

/** Serialized tool calls and other JSON payloads: `ipython {"code":"..."}`. */
const JSON_BLOB_LINE_PATTERN_REFERENCE = /\{"[\w$]+"\s*:/;

const ISSUE_URL_PATTERN_REFERENCE = /(?:issues|pull|pulls)\/(\d{2,7})\b/g;
const ISSUE_HASH_PATTERN_REFERENCE = /(?<![\w/])#(\d{3,6})\b/g;

interface RawFactReference {
	kind: FactKind;
	value: string;
	key: string;
	context?: string;
}

/** Half-width of the window a context snippet is cut from. */
const CONTEXT_WINDOW_REFERENCE = 60;

/**
 * Verbatim window around a match, whitespace-collapsed, for facts whose value alone
 * is ambiguous.
 *
 * Bounded to a fixed window on purpose: finding the enclosing line's start costs
 * O(text length) per match, and one large tool result can carry thousands of numbers.
 * A long line is therefore excerpted rather than quoted in full.
 */
function clipContextReference(source: string, index: number): string {
	const start = Math.max(0, index - CONTEXT_WINDOW_REFERENCE);
	const end = Math.min(source.length, index + CONTEXT_WINDOW_REFERENCE);
	const window = source.slice(start, end);
	const offset = index - start;
	const headCut = window.lastIndexOf("\n", offset);
	const tailCut = window.indexOf("\n", offset);
	const line = window.slice(headCut + 1, tailCut === -1 ? window.length : tailCut);
	const matchOffset = offset - headCut - 1;
	const from = Math.max(0, matchOffset - 40);
	return line
		.slice(from, from + FACT_CONTEXT_MAX_CHARS_REFERENCE)
		.replace(/\s+/g, " ")
		.trim();
}

function extractShasReference(text: string, out: RawFactReference[], prose: boolean): void {
	for (const match of text.matchAll(FULL_SHA_PATTERN_REFERENCE)) {
		const value = match[0].toLowerCase();
		out.push({ kind: "sha", value, key: value });
	}
	for (const line of splitReportLinesReference(text)) {
		// An abbreviated hash in prose somebody wrote is a commit; the same token in a
		// log is usually an id fragment. Only prose gets to skip the git-context test.
		if (!prose && !GIT_CONTEXT_PATTERN_REFERENCE.test(line)) continue;
		for (const match of line.matchAll(SHORT_SHA_PATTERN_REFERENCE)) {
			const value = match[1];
			// Words such as "feedback" are valid hex; a real abbreviated SHA has both.
			if (!/\d/.test(value) || !/[a-f]/.test(value)) continue;
			out.push({ kind: "sha", value, key: value });
		}
	}
}

/** Whether a character can appear in a filesystem path. */
function isPathCharReference(code: number): boolean {
	return (
		(code >= 0x30 && code <= 0x39) || // 0-9
		(code >= 0x41 && code <= 0x5a) || // A-Z
		(code >= 0x61 && code <= 0x7a) || // a-z
		code === 0x2f || // /
		code === 0x2e || // .
		code === 0x5f || // _
		code === 0x2b || // +
		code === 0x2d || // -
		code === 0x7e // ~
	);
}

/**
 * Extract path candidates with one linear scan over maximal runs of path characters.
 *
 * A regex shaped `segment(?:/segment)+` backtracks quadratically on a long run that
 * contains no slash, and an 800k-character tool result of repeated "x" is exactly
 * that - it hung a compaction for minutes. Scanning runs instead is O(text length)
 * on every input.
 */
function extractPathsReference(text: string, out: RawFactReference[]): void {
	let index = 0;
	while (index < text.length) {
		if (!isPathCharReference(text.charCodeAt(index))) {
			index++;
			continue;
		}
		const runStart = index;
		let slashes = 0;
		while (index < text.length && isPathCharReference(text.charCodeAt(index))) {
			if (text.charCodeAt(index) === 0x2f) slashes++;
			index++;
		}
		if (slashes === 0) continue;
		let value = text.slice(runStart, index).replace(PATH_TRAILING_JUNK_REFERENCE, "");
		while (value.endsWith("/")) value = value.slice(0, -1);
		if (value.length < 4 || value.length > MAX_VALUE_CHARS_REFERENCE.path) continue;
		// A URL is a run with "://" in it, and a doubled slash is not a filesystem path.
		if (value.includes("//")) continue;
		if (PATH_NOISE_SEGMENT_REFERENCE.test(value)) continue;
		const segments = value.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length < 2) continue;
		const absolute = value.startsWith("/") || value.startsWith("~/");
		const last = segments[segments.length - 1];
		if (!absolute && segments.length < 3 && !RELATIVE_WITH_EXTENSION_REFERENCE.test(last)) continue;
		out.push({ kind: "path", value, key: value });
	}
}

/**
 * Position buckets for the "already claimed" spans of one text.
 *
 * Three number patterns can match the same characters (`EXIT=0` is both an assignment
 * and a keyword pair), so later passes skip what an earlier one took. A flat list
 * makes that check quadratic in the number of matches, and a log full of numbers has
 * tens of thousands; bucketing by position keeps both insert and lookup O(1).
 */
const CLAIM_BUCKET_REFERENCE = 256;

class ClaimedSpansReference {
	private readonly buckets = new Map<number, Array<[number, number]>>();

	add(from: number, to: number): void {
		for (
			let bucket = Math.floor(from / CLAIM_BUCKET_REFERENCE);
			bucket <= Math.floor(to / CLAIM_BUCKET_REFERENCE);
			bucket++
		) {
			const existing = this.buckets.get(bucket);
			if (existing) existing.push([from, to]);
			else this.buckets.set(bucket, [[from, to]]);
		}
	}

	overlaps(from: number, to: number): boolean {
		for (
			let bucket = Math.floor(from / CLAIM_BUCKET_REFERENCE);
			bucket <= Math.floor(to / CLAIM_BUCKET_REFERENCE);
			bucket++
		) {
			for (const [start, end] of this.buckets.get(bucket) ?? []) {
				if (from < end && start < to) return true;
			}
		}
		return false;
	}
}

function extractNumbersReference(text: string, out: RawFactReference[]): void {
	const taken = new ClaimedSpansReference();
	const overlaps = (from: number, to: number): boolean => taken.overlaps(from, to);
	const claim = (from: number, to: number): void => {
		taken.add(from, to);
	};

	for (const match of text.matchAll(ASSIGN_NUMBER_PATTERN_REFERENCE)) {
		const identifier = match[1];
		if (!CONFIG_IDENTIFIER_PATTERN_REFERENCE.test(identifier)) continue;
		const from = match.index ?? 0;
		const value = `${identifier}=${match[2]}`;
		claim(from, from + match[0].length);
		out.push({
			kind: "number",
			value,
			key: factKeyReference("number", value),
			context: clipContextReference(text, from),
		});
	}
	for (const match of text.matchAll(KEYWORD_NUMBER_PATTERN_REFERENCE)) {
		const from = match.index ?? 0;
		if (overlaps(from, from + match[0].length)) continue;
		claim(from, from + match[0].length);
		const keyword = match[1].toLowerCase().replace(/\s+/g, " ");
		const value = `${keyword}=${match[2]}`;
		out.push({
			kind: "number",
			value,
			key: factKeyReference("number", value),
			context: clipContextReference(text, from),
		});
	}
	for (const match of text.matchAll(UNIT_NUMBER_PATTERN_REFERENCE)) {
		const from = match.index ?? 0;
		if (overlaps(from, from + match[0].length)) continue;
		claim(from, from + match[0].length);
		if (Number.parseFloat(match[1]) === 0) continue; // "0ms" carries no threshold
		const value = `${match[1]}${match[2]}`;
		out.push({
			kind: "number",
			value,
			key: factKeyReference("number", value),
			context: clipContextReference(text, from),
		});
	}
}

/**
 * Split a blob into the lines a reader would see.
 *
 * Tool-call arguments reach the extractor as one JSON string, so their embedded
 * `\n` escapes are not line breaks; without splitting them, a whole code cell is a
 * single "line" and any `Error:` inside it looks like a reported failure.
 */
function splitReportLinesReference(text: string): string[] {
	return text.split(/\n|\\n/);
}

function extractErrorsReference(text: string, out: RawFactReference[]): void {
	for (const rawLine of splitReportLinesReference(text)) {
		if (!ERROR_LINE_PATTERN_REFERENCE.test(rawLine)) continue;
		const line = rawLine.replace(/^\s*(?:\[[^\]]{0,60}\]\s*)+/, "").trim();
		if (line.length < 10) continue;
		if (CODE_SHAPED_LINE_PATTERN_REFERENCE.test(line)) continue;
		// A serialized tool call is data about a call, not a report of one.
		if (JSON_BLOB_LINE_PATTERN_REFERENCE.test(line)) continue;
		const clipped =
			line.length > MAX_VALUE_CHARS_REFERENCE.error
				? `${line.slice(0, MAX_VALUE_CHARS_REFERENCE.error - 1)}…`
				: line;
		out.push({ kind: "error", value: clipped, key: factKeyReference("error", clipped) });
	}
}

function extractIssuesReference(text: string, out: RawFactReference[]): void {
	for (const pattern of [ISSUE_URL_PATTERN_REFERENCE, ISSUE_HASH_PATTERN_REFERENCE]) {
		for (const match of text.matchAll(pattern)) {
			const value = `#${match[1]}`;
			out.push({ kind: "issue", value, key: value });
		}
	}
}

/** Every fact kind in one text blob, in extraction order. */
function extractFactsFromTextReference(text: string, options?: { prose?: boolean }): RawFactReference[] {
	const out: RawFactReference[] = [];
	if (!text) return out;
	extractShasReference(text, out, options?.prose ?? false);
	extractPathsReference(text, out);
	extractNumbersReference(text, out);
	extractErrorsReference(text, out);
	extractIssuesReference(text, out);
	return out;
}
function textBlocksReference(content: unknown): string[] {
	if (typeof content === "string") return content.length > 0 ? [content] : [];
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const typed = block as { type?: string; text?: string };
		if (typed.type === "text" && typeof typed.text === "string" && typed.text.length > 0) texts.push(typed.text);
	}
	return texts;
}
/** One fact-bearing text inside a message, with the weight of its source kind. */
interface FactSourceReference {
	text: string;
	weight: number;
}

/**
 * Weight at and above which a source counts as prose somebody wrote, rather than
 * output a program produced. Prose gets the looser abbreviated-SHA rule.
 */
const PROSE_SOURCE_WEIGHT_REFERENCE = 3;
/**
 * The fact-bearing texts of one message, each with its source weight.
 *
 * Summary roles are skipped on purpose: their text is this module's own output
 * from an earlier generation, and re-extracting it would inflate the mention
 * weight of facts the ledger already carries.
 */
function factSourcesReference(message: AgentMessage): FactSourceReference[] {
	switch (message.role) {
		case "user":
			return textBlocksReference(message.content).map((text) => ({ text, weight: SOURCE_WEIGHTS_REFERENCE.user }));
		case "assistant": {
			const sources: FactSourceReference[] = [];
			const calls: string[] = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text) {
					sources.push({ text: block.text, weight: SOURCE_WEIGHTS_REFERENCE.assistantText });
				} else if (block.type === "thinking" && block.thinking) {
					sources.push({ text: block.thinking, weight: SOURCE_WEIGHTS_REFERENCE.assistantThinking });
				} else if (block.type === "toolCall") {
					calls.push(`${block.name} ${JSON.stringify(block.arguments)}`);
				}
			}
			if (calls.length > 0) sources.push({ text: calls.join("\n"), weight: SOURCE_WEIGHTS_REFERENCE.toolCall });
			return sources;
		}
		case "toolResult":
			return textBlocksReference(message.content).map((text) => ({
				text,
				weight: SOURCE_WEIGHTS_REFERENCE.toolResult,
			}));
		case "custom":
			return textBlocksReference(message.content).map((text) => ({ text, weight: SOURCE_WEIGHTS_REFERENCE.custom }));
		case "bashExecution": {
			const sources: FactSourceReference[] = [];
			if (message.command) sources.push({ text: message.command, weight: SOURCE_WEIGHTS_REFERENCE.bashCommand });
			if (message.output) sources.push({ text: message.output, weight: SOURCE_WEIGHTS_REFERENCE.bashOutput });
			return sources;
		}
		case "branchSummary":
		case "compactionSummary":
			return [];
	}
	return [];
}
/**
 * Extract facts from a slice of messages.
 *
 * Each message contributes at most one weight per fact - the strongest source kind
 * inside it that mentions the fact - so a huge log cannot outvote the user.
 */
function extractFactsReference(messages: readonly AgentMessage[]): Map<string, FactRecord> {
	const found = new Map<string, FactRecord>();
	for (const message of messages) {
		const perMessage = new Map<string, { fact: RawFactReference; weight: number }>();
		for (const source of factSourcesReference(message)) {
			const prose = source.weight >= PROSE_SOURCE_WEIGHT_REFERENCE;
			for (const fact of extractFactsFromTextReference(source.text, { prose })) {
				const key = `${fact.kind}:${fact.key}`;
				const existing = perMessage.get(key);
				if (existing) {
					if (source.weight > existing.weight) existing.weight = source.weight;
					existing.fact.context ??= fact.context;
				} else {
					perMessage.set(key, { fact, weight: source.weight });
				}
			}
		}
		for (const [key, { fact, weight }] of perMessage) {
			const record = found.get(key);
			if (record) {
				record.weight += weight;
				record.context ??= fact.context;
				if (fact.kind === "sha" && record.value.length < fact.value.length && fact.value.startsWith(record.value)) {
					// The same commit appeared in full later; keep the fuller spelling.
					record.value = fact.value;
				}
			} else {
				found.set(key, {
					kind: fact.kind,
					value: fact.value,
					weight,
					firstGeneration: 0,
					lastGeneration: 0,
					context: fact.context,
				});
			}
		}
	}
	return collapseShaAliasesReference(found);
}

/**
 * Merge an abbreviated SHA into the full one it prefixes.
 *
 * Transcripts refer to a commit both ways. Keeping both would spend two appendix
 * slots on one anchor and split the mention weight that decides whether it
 * survives pruning.
 */
function collapseShaAliasesReference(records: Map<string, FactRecord>): Map<string, FactRecord> {
	const fullShas: FactRecord[] = [];
	for (const record of records.values()) {
		if (record.kind === "sha" && record.value.length === 40) fullShas.push(record);
	}
	if (fullShas.length === 0) return records;
	for (const [key, record] of [...records.entries()]) {
		if (record.kind !== "sha" || record.value.length === 40) continue;
		const full = fullShas.find((candidate) => candidate.value.startsWith(record.value));
		if (!full) continue;
		full.weight += record.weight;
		full.context ??= record.context;
		// The anchor was mentioned in the abbreviated record's generations too, which is
		// what decides whether it still counts as fresh when the budget binds.
		full.firstGeneration = Math.min(full.firstGeneration, record.firstGeneration);
		full.lastGeneration = Math.max(full.lastGeneration, record.lastGeneration);
		records.delete(key);
	}
	return records;
}

/* -------------------------------------------------------------------------- */
/* Corpus                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Boundary shapes for every extractor pass: hex run lengths 39/40/41, uppercase
 * and mixed-case hex, 7/10/11-length runs adjacent to "-", real newlines mixed
 * with two-character "\n" escapes, ``` and ~~~ fences (including unclosed), CJK
 * and surrogate pairs, JSON blobs, every error-line shape, code-shaped lines,
 * every number shape including negatives, issue refs including too-short ones,
 * paths/URLs/noise, a >=200k single line, separator-only strings, and five real
 * message texts taken from test/fixtures/before-compaction.jsonl.
 */
const CORPUS: readonly string[] = [
	"bare 0123456789abcdef0123456789abcdef0123456 no git word on the line",
	"git show 0123456789abcdef0123456789abcdef01234567 --stat",
	"git show 0123456789abcdef0123456789abcdef012345678 --stat",
	"g0123456789abcdef0123456789abcdef01234567 preceded by a plain letter",
	"A0123456789abcdef0123456789abcdef01234567 preceded by an uppercase hex digit",
	"0123456789abcdef0123456789abcdef012345670 followed by an extra hex digit",
	"0123456789abcdef0123456789abcdef01234567F followed by an uppercase hex digit",
	"all uppercase ABCDEF0123456789ABCDEF0123456789ABCDEF01 in a git log line",
	"mixed case 0123456789abcdef0123456789abcdef0123C567 in a git log line",
	"twice the same SHA: bda4b7d92bac88ac6da9796f4b0c4d33b7566178 and bda4b7d92bac88ac6da9796f4b0c4d33b7566178 again",
	"git commit abc1234 is the rollback anchor",
	"git checkout abc1234567 now",
	"git checkout abc12345678 is eleven",
	"git show abc1234- with trailing dash",
	"git show -abc1234 with leading dash",
	"git log deadbeef-1234567 combined run",
	"git log 1234567-deadbeef combined run",
	"git commit deadbeef has no digit",
	"git commit 1234567 has no a-f letter",
	"the value 10b6b4e55 means nothing here",
	"roll back to bda4b7d92 if it breaks",
	"short sha then escaped newline: commit abc1234\\nand git status",
	"commit abc1234\\n",
	"Error: failed to sync repo\\nError: retry limit exceeded\\ndone",
	"line one\\nline two with /tmp/a/b.md\\nline three",
	"real then escaped:\\nbreak\\nbreak again\\n",
	'{"code":"print(\\"hi\\")\\nError: real error after escaped newline"}',
	"\\n",
	"\n\n",
	"\n\\n\n",
	"",
	"```\\nError: inside backtick fence\\n```",
	"~~~\\nError: inside tilde fence\\n~~~",
	"```ts\\nconst x = 1;\\nunclosed fence",
	"~~~python\\nraise ValueError(1)\\n~~~",
	"压缩失败了：Error: 无法解析 JSON 配置文件",
	"老板说这个模块要重构，交付时间是下周五",
	"中文路径 /Users/老板/文件.md 与 emoji 🎯 还有 𝟘𝟙",
	"扩大 3x 之后内存占用 2× 左右，超时 12ms",
	'ipython {"code":"raise ValueError(1)"}',
	'{"reserveTokens": 16384, "keepRecentTokens": 20000}',
	'{"nested": {"timeout": 30}, "arr": [1, 2, 3]}',
	"Error: x",
	"FAILED",
	"FAILED: build did not complete on shard 7",
	"Traceback (most recent call last):",
	"ENOENT: no such file or directory, open '/etc/hosts'",
	"ECONNRESET during upload of 523MB payload",
	"failed to resolve host example.internal after 3 attempts",
	"[2026-09-18] Error: bracketed timestamp prefix",
	"[INFO] [09:18] WARN: double bracket prefix here",
	"panic: runtime error: invalid memory address",
	"Error summary: compaction failed for session",
	"MyTypeError: custom suffix class",
	"sigterm received but not fatal",
	"Unable to open file config.yaml today",
	"Refusing to continue with 0 bytes",
	"const x = 1;",
	"expect(a).toBe(b);",
	"+  added line with Error: not really reported",
	"-  removed line mentioning FAILED state",
	"@@ -1,3 +1,4 @@ hunk header",
	"return new Error('nope');",
	"if (x) throw new TypeError('bad')",
	"except Exception: pass",
	"exit code 2",
	"status: 500 after all retries",
	"max_attempts=3 per invocation",
	"idleMinutes: 90 and timeout=3000",
	"12ms warmup and 1.5MB payload and 0ms idle",
	"MIN=2 forced lowercase reading",
	"min=-5 negative threshold",
	"bailian/qwen3.8-max-0902 is not a number",
	"UUID 01a07767-0a8e-719d-9367-43295443473e is not a number",
	"attempts 3 and port 8080 and gen 4",
	"version 2 line 22 limit: 8",
	"issues/1234 opened by the bot",
	"pull/42 needs review",
	"fixes #12345 today",
	"#12 is too short",
	"markdown heading # 1 Introduction is not an issue",
	"C#1234 is not an issue",
	"refs like a#123 are not issues",
	"issues/12345678 too many digits",
	"/Users/a1/.prime/agent/bailian.key exists",
	"packages/coding-agent/src/core/compaction/compaction.ts changed",
	"https://github.com/PrimeIntellect-ai/prime-agent/issues/4603",
	"/repo/node_modules/x/y.js is noise",
	"~/Desktop/notes.md and ~/a/b.md",
	"a/b has no extension",
	"docs/compaction.md is a path",
	"wrote /tmp/dir0/file0.md. with a period",
	"logs live at /var/log/ with a trailing slash",
	"windows path c:\\\\Users\\\\win style",
	"relative path with tilde segment ~/only/tilde.md",
	"commit abc1234 failed to build /tmp/out/a.json with exit code 2 and issues/99",
	"git show bda4b7d92bac88ac6da9796f4b0c4d33b7566178 then short bda4b7d92 in prose-ish line, fixes #4603, limit: 8",
	"alright, read @packages/coding-agent/src/main.ts @packages/coding-agent/src/tui/tui-renderer.ts in full. i feel like this is one big mess and could be refactored to be nicer. I want you to do a deep analysis, then provide me with a plan on how to untangle this. i'm especially interested in code sharing between the different run modes (print/json, rpc, interactive). it feels like we have a lot of code duplication. for tui-renderer (which is a misnomer imo, should be interactive-mode or something, and should have rpc-mode.ts and print-mode.ts) i'm especially intersted in untangling TUI shit from agent shit if possible. but i'm not sure if that's possible nicely.",
	'import { Agent, type Attachment, ProviderTransport, type ThinkingLevel } from "@mariozechner/pi-agent-core";\nimport type { Api, AssistantMessage, KnownProvider, Model } from "@mariozechner/pi-ai";\nimport { ProcessTerminal, TUI } from "@mariozechner/pi-tui";\nimport chalk from "chalk";\nimport { spawn } from "child_process";\nimport { randomBytes } from "crypto";\nimport { createWriteStream, existsSync, readFileSync, statSync } from "fs";\nimport { homedir, tmpdir } from "os";\nimport { extname, join, resolve } from "path";\nimport stripAnsi from "strip-ansi";\nimport { getChangelogPath, getNewEntries, parseChangelog } from "./changelog.js";\nimport { calculateContextTokens, compact, shouldCompact } from "./compaction.js";\nimport {\n\tAPP_NAME,\n\tCONFIG_DIR_NAME,\n\tENV_AGENT_DIR,\n\tgetAgentDir,\n\tgetModelsPath,\n\tgetReadmePath,\n\tVERSION,\n} from "./config.js";\nimport { exportFromFile } from "./export-html.js";\nimport { type BashExecutionMessage, messageTransformer } from "./messages.js";\nimport { findModel, getApiKeyForModel, getAvailableModels } from "./model-config.js";\nimport { loadSessionFromEntries, SessionManager } from "./session-manager.js";\nimport { SettingsManager } from "./settings-manager.js";\nimport { getShellConfig } from "./shell.js";\nimport { expandSlashCommand, loadSlashCommands } from "./slash-commands.js";\nimport { initTheme } from "./theme/theme.js";\nimport { allTools, codingTools, type ToolName } from "./tools/index.js";\nimport { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.js";\nimport { ensureTool } from "./tools-manager.js";\nimport { SessionSelectorComponent } from "./tui/session-selector.js";\nimport { TuiRenderer } from "./tui/tui-renderer.js";\n\nconst defaultModelPerProvider: Record<KnownProvider, string> = {\n\tanthropic: "claude-sonnet-4-5",\n\topenai: "gpt-5.1-codex",\n\tgoogle: "gemini-2.5-pro",\n\topenrouter: "openai/gpt-5.1-codex",\n\txai: "grok-4-fast-non-reasoning",\n\tgroq: "openai/gpt-oss-120b",\n\tcerebras: "zai-glm-4.6",\n\tzai: "glm-4.6",\n};\n\ntype Mode = "text" | "json" | "rpc";\n\ninterface Args {\n\tprovider?: string;\n\tmodel?: string;\n\tapiKey?: string;\n\tsystemPrompt?: string;\n\tappendSystemPrompt?: string;\n\tthinking?: ThinkingLevel;\n\tcontinue?: boolean;\n\tresume?: boolean;\n\thelp?: boolean;\n\tmode?: Mode;\n\tnoSession?: boolean;\n\tsession?: string;\n\tmodels?: string[];\n\ttools?: ToolName[];\n\tprint?: boolean;\n\texport?: string;\n\tmessages: string[];\n\tfileArgs: string[];\n}\n\nfunction parseArgs(args: string[]): Args {\n\tconst result: Args = {\n\t\tmessages: [],\n\t\tfileArgs: [],\n\t};\n\n\tfor (let i = 0; i < args.length; i++) {\n\t\tconst arg = args[i];\n\n\t\tif (arg === ',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: verbatim fixture text whose data contains a template literal
	'\t\t\tthis.showError(`Bash command failed: ${errorMessage}`);\n\t\t}\n\n\t\tthis.bashComponent = null;\n\t\tthis.ui.requestRender();\n\t}\n\n\tprivate executeBashCommand(\n\t\tcommand: string,\n\t\tonChunk: (chunk: string) => void,\n\t): Promise<{\n\t\texitCode: number | null;\n\t\tcancelled: boolean;\n\t\ttruncationResult?: TruncationResult;\n\t\tfullOutputPath?: string;\n\t}> {\n\t\treturn new Promise((resolve, reject) => {\n\t\t\tconst { shell, args } = getShellConfig();\n\t\t\tconst child = spawn(shell, [...args, command], {\n\t\t\t\tdetached: true,\n\t\t\t\tstdio: ["ignore", "pipe", "pipe"],\n\t\t\t});\n\n\t\t\tthis.bashProcess = child;\n\n\t\t\t// Track sanitized output for truncation\n\t\t\tconst outputChunks: string[] = [];\n\t\t\tlet outputBytes = 0;\n\t\t\tconst maxOutputBytes = DEFAULT_MAX_BYTES * 2;\n\n\t\t\t// Temp file for large output\n\t\t\tlet tempFilePath: string | undefined;\n\t\t\tlet tempFileStream: WriteStream | undefined;\n\t\t\tlet totalBytes = 0;\n\n\t\t\tconst handleData = (data: Buffer) => {\n\t\t\t\ttotalBytes += data.length;\n\n\t\t\t\t// Sanitize once at the source: strip ANSI, replace binary garbage, normalize newlines\n\t\t\t\tconst text = sanitizeBinaryOutput(stripAnsi(data.toString())).replace(/\\r/g, "");\n\n\t\t\t\t// Start writing to temp file if exceeds threshold\n\t\t\t\tif (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {\n\t\t\t\t\tconst id = randomBytes(8).toString("hex");\n\t\t\t\t\ttempFilePath = join(tmpdir(), `pi-bash-${id}.log`);\n\t\t\t\t\ttempFileStream = createWriteStream(tempFilePath);\n\t\t\t\t\tfor (const chunk of outputChunks) {\n\t\t\t\t\t\ttempFileStream.write(chunk);\n\t\t\t\t\t}\n\t\t\t\t}\n\n\t\t\t\tif (tempFileStream) {\n\t\t\t\t\ttempFileStream.write(text);\n\t\t\t\t}\n\n\t\t\t\t// Keep rolling buffer of sanitized text\n\t\t\t\toutputChunks.push(text);\n\t\t\t\toutputBytes += text.length;\n\t\t\t\twhile (outputBytes > maxOutputBytes && outputChunks.length > 1) {\n\t\t\t\t\tconst removed = outputChunks.shift()!;\n\t\t\t\t\toutputBytes -= removed.length;\n\t\t\t\t}\n\n\t\t\t\t// Stream to component\n\t\t\t\tonChunk(text);\n\t\t\t};\n\n\t\t\tchild.stdout?.on("data", handleData);\n\t\t\tchild.stderr?.on("data", handleData);\n\n\n[188 more lines in file. Use offset=2190 to continue]',
	"AGENTS.md\nbiome.json\nLICENSE\nnode_modules\npackage-lock.json\npackage.json\npackages\npi-mono.code-workspace\nREADME.md\nscripts\ntsconfig.base.json\ntsconfig.json\n",
	'Good thinking. Let me expand AgentSession to be a comprehensive, TUI-agnostic abstraction that all modes can use.\n\n## Expanded AgentSession Design\n\n```typescript\n// src/core/agent-session.ts\n\nimport type { Agent, AgentEvent, AgentState, ThinkingLevel } from "@mariozechner/pi-agent-core";\nimport type { Model, Message } from "@mariozechner/pi-ai";\n\nexport interface AgentSessionConfig {\n  agent: Agent;\n  sessionManager: SessionManager;\n  settingsManager: SettingsManager;\n  scopedModels?: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>;\n}\n\nexport interface BashResult {\n  output: string;\n  exitCode: number | null;\n  cancelled: boolean;\n  truncated: boolean;\n  fullOutputPath?: string;\n}\n\nexport interface CompactionResult {\n  tokensBefore: number;\n  tokensAfter: number;\n  summary: string;\n}\n\nexport interface ModelCycleResult {\n  model: Model<any>;\n  thinkingLevel: ThinkingLevel;\n  isScoped: boolean;  // true if cycling within --models scope\n}\n\nexport interface PromptOptions {\n  expandSlashCommands?: boolean;  // default true\n  attachments?: Attachment[];\n}\n\n/**\n * Core agent session management - shared between all modes.\n * Handles agent lifecycle, persistence, model/thinking management.\n * TUI-agnostic: returns data, doesn\'t render anything.\n */\nexport class AgentSession {\n  readonly agent: Agent;\n  readonly sessionManager: SessionManager;\n  readonly settingsManager: SettingsManager;\n  \n  private scopedModels: Array<{ model: Model<any>; thinkingLevel: ThinkingLevel }>;\n  private fileCommands: FileSlashCommand[];\n  private eventListeners: Array<(event: AgentEvent) => void> = [];\n  private bashAbortController: AbortController | null = null;\n  private compactionAbortController: AbortController | null = null;\n\n  constructor(config: AgentSessionConfig);\n\n  // ─────────────────────────────────────────────────────────────\n  // State Access\n  // ─────────────────────────────────────────────────────────────\n  \n  get state(): AgentState;\n  get model(): Model<any> | null;\n  get thinkingLevel(): ThinkingLevel;\n  get isStreaming(): boolean;\n  get messages(): Message[];\n  get sessionFile(): string;\n  get sessionId(): string;\n\n  // ─────────────────────────────────────────────────────────────\n  // Event Subscription\n  // ─────────────────────────────────────────────────────────────\n  \n  /**\n   * Subscribe to agent events. Handles session persistence internally.\n   * R',
	// Long single line: a run of path characters and hex characters with no
	// separator; guards the linear scans against backtracking regressions.
	"x".repeat(200_000),
	"ab".repeat(100_000),
	`${"y".repeat(100_000)}0123456789abcdef0123456789abcdef01234567${"y".repeat(100_000)}`,
	// A git word before an escaped newline: the short SHA on the next line is
	// NOT git-gated, because "\n" splits the line.
	"git show\nabc1234 is next",
	// Dense realistic shapes at scale, with real "\n" and two-character "\n"
	// separators alternating.
	Array.from(
		{ length: 2000 },
		(_, i) => `worker ${i} exited 0 after ${i % 900}s using ${i % 500}MB at /var/log/app/${i % 97}/shard-${i}.log`,
	).join("\n"),
	Array.from({ length: 500 }, (_, i) => {
		const sha = `${(i % 16).toString(16)}${"0123456789abcdef".repeat(3).slice(0, 39)}`;
		let line: string;
		if (i % 10 === 9) line = `[2026-09-18] Error: shard ${i % 7} failed to flush after ${i % 90}s`;
		else if (i % 10 === 4) line = `git diff ${sha}..HEAD --stat`;
		else line = `commit ${sha} refs/heads/feat-${i} exit code ${i % 3}`;
		return `${line}${i % 2 === 0 ? "\n" : "\\n"}`;
	}).join(""),
];

/* -------------------------------------------------------------------------- */
/* Message corpus                                                               */
/* -------------------------------------------------------------------------- */

function usage(): Usage {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}

function userMessageBlocks(texts: readonly string[]): AgentMessage {
	return {
		role: "user",
		content: texts.map((text) => ({ type: "text", text })),
		timestamp: 0,
	} as AgentMessage;
}

function assistantMessage(text: string, thinking?: string): AgentMessage {
	const content: AssistantMessage["content"] = [];
	if (thinking) content.push({ type: "thinking", thinking } as AssistantMessage["content"][number]);
	content.push({ type: "text", text } as AssistantMessage["content"][number]);
	return {
		role: "assistant",
		content,
		usage: usage(),
		stopReason: "stop",
		timestamp: 0,
		api: "faux",
		provider: "faux",
		model: "faux-1",
	} as AssistantMessage as AgentMessage;
}

function assistantToolCall(name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc1", name, arguments: args }],
		usage: usage(),
		stopReason: "stop",
		timestamp: 0,
		api: "faux",
		provider: "faux",
		model: "faux-1",
	} as AssistantMessage as AgentMessage;
}

function assistantMixedMessage(
	text: string,
	thinking: string,
	calls: readonly { name: string; arguments: Record<string, unknown> }[],
): AgentMessage {
	const content: AssistantMessage["content"] = [
		{ type: "thinking", thinking } as AssistantMessage["content"][number],
		{ type: "text", text } as AssistantMessage["content"][number],
		...(calls.map((call) => ({
			type: "toolCall",
			id: "tc2",
			name: call.name,
			arguments: call.arguments,
		})) as AssistantMessage["content"]),
	];
	return {
		role: "assistant",
		content,
		usage: usage(),
		stopReason: "stop",
		timestamp: 0,
		api: "faux",
		provider: "faux",
		model: "faux-1",
	} as AssistantMessage as AgentMessage;
}

function toolResultMessage(text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	} as AgentMessage;
}

function toolResultBlocks(texts: readonly string[]): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: "bash",
		content: texts.map((text) => ({ type: "text", text })),
		isError: true,
		timestamp: 0,
	} as AgentMessage;
}

function customMessage(content: string): AgentMessage {
	return {
		role: "custom",
		customType: "refinement_outcome",
		content,
		display: true,
		timestamp: 0,
	} as AgentMessage;
}

function bashMessage(command: string, output: string): AgentMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 0,
	} as AgentMessage;
}

function branchSummaryMessage(summary: string): AgentMessage {
	return { role: "branchSummary", summary, fromId: "b1", timestamp: 0 } as AgentMessage;
}

function compactionSummaryMessage(summary: string): AgentMessage {
	return { role: "compactionSummary", summary, tokensBefore: 100, timestamp: 0 } as AgentMessage;
}

const MESSAGE_CORPUS: readonly AgentMessage[] = [
	userMessage("see /tmp/ma_audit/build.md, anchor bda4b7d92bac88ac6da9796f4b0c4d33b7566178, fixes #4603"),
	userMessageBlocks([
		"first block keeps reserveTokens: 16384 and limit: 8",
		"second block has Error: paste from user plus /tmp/block2/a.json",
		"",
	]),
	userMessage(""),
	assistantMessage("writing /tmp/strong-source/a.md now", "maybe check exit code 2 first"),
	assistantToolCall("ipython", { code: "if x: raise TypeError('bad')\nprint('done')" }),
	assistantMixedMessage("the shared path /tmp/shared/x.md", "weight race thinking", [
		{ name: "write", arguments: { path: "/tmp/shared/x.md" } },
		{ name: "bash", arguments: { command: "cd /tmp && ls" } },
	]),
	toolResultMessage(
		"git show bda4b7d92bac88ac6da9796f4b0c4d33b7566178 --stat\nError: shard 4 failed to flush\nFAILED",
	),
	toolResultBlocks(["block one: exit code 1", "block two: /tmp/blocks/b.txt with 12ms latency"]),
	toolResultMessage(""),
	customMessage("lesson: the daemon journal lives at /tmp/journal/a.jsonl, generation 7"),
	customMessage(""),
	bashMessage("cat /tmp/journal/b.jsonl", "Error: cat failed with exit code 2"),
	bashMessage("ls", ""),
	branchSummaryMessage("branch summary text mentioning Error: things and /tmp/branch/x.md"),
	compactionSummaryMessage("summary text mentioning git commit abc1234 which must not be re-extracted"),
	toolResultMessage("Error: failed to sync repo\nError: retry limit exceeded\ndone"),
	userMessage("压缩失败了：Error: 无法解析 JSON 配置 🎯，路径 /Users/老板/文件.md"),
];

/** Enough distinct facts of several kinds that the token budget and per-kind caps bind. */
const SQUEEZE_MESSAGES: readonly AgentMessage[] = Array.from({ length: 420 }, (_, i) =>
	userMessage(`wrote /tmp/dir${i}/file${i}.md with limit: ${i}`),
);

/* -------------------------------------------------------------------------- */
/* Differential assertions                                                     */
/* -------------------------------------------------------------------------- */

describe("fact extraction differential: text level", () => {
	it("extracts the same facts, in the same order, as the baseline reference for every corpus text in both prose modes", () => {
		expect(CORPUS.length).toBeGreaterThanOrEqual(108);
		for (const [index, text] of CORPUS.entries()) {
			for (const prose of [false, true]) {
				const actual = extractFactsFromText(text, { prose });
				const expected = extractFactsFromTextReference(text, { prose });
				expect(actual, `corpus[${index}] prose=${prose}`).toEqual(expected);
				expect(JSON.stringify(actual), `corpus[${index}] prose=${prose}`).toBe(JSON.stringify(expected));
			}
		}
	});

	it("returns no facts for the empty string", () => {
		expect(extractFactsFromText("")).toEqual([]);
		expect(extractFactsFromTextReference("")).toEqual([]);
	});
});

describe("fact extraction differential: message level", () => {
	it("produces the same records, in the same insertion order, as the reference", () => {
		expect(MESSAGE_CORPUS.length).toBeGreaterThanOrEqual(17);
		const actual = [...extractFacts(MESSAGE_CORPUS).entries()];
		const expected = [...extractFactsReference(MESSAGE_CORPUS).entries()];
		expect(actual).toEqual(expected);
	});

	it("serializes the record sequence identically, context fields included", () => {
		expect(JSON.stringify([...extractFacts(MESSAGE_CORPUS).values()])).toBe(
			JSON.stringify([...extractFactsReference(MESSAGE_CORPUS).values()]),
		);
	});

	it("keeps the summary roles out of the sources", () => {
		const summaryMessages = MESSAGE_CORPUS.filter(
			(message) => message.role === "branchSummary" || message.role === "compactionSummary",
		);
		expect(summaryMessages).toHaveLength(2);
		expect(extractFacts(summaryMessages).size).toBe(0);
		expect(extractFactsReference(summaryMessages).size).toBe(0);
	});
});

describe("fact extraction differential: ledger render", () => {
	const budgets = [900, 200, 100_000];

	it("renders byte-identical appendix text through the full pipeline for every budget", () => {
		for (const budget of budgets) {
			const actual = renderFactAppendix(
				buildFactLedger({ messages: [...MESSAGE_CORPUS, ...SQUEEZE_MESSAGES], generation: 1, tokenBudget: budget }),
			);
			const expected = renderFactAppendix(
				pruneFactLedger(
					mergeFactLedger(undefined, extractFactsReference([...MESSAGE_CORPUS, ...SQUEEZE_MESSAGES]), 1),
					budget,
				),
			);
			expect(actual.length).toBeGreaterThan(0);
			expect(actual).toBe(expected);
		}
	});

	it("reports the same elided counts when the caps and the budget bind", () => {
		const actual = buildFactLedger({
			messages: [...MESSAGE_CORPUS, ...SQUEEZE_MESSAGES],
			generation: 1,
			tokenBudget: 100_000,
		});
		const expected = pruneFactLedger(
			mergeFactLedger(undefined, extractFactsReference([...MESSAGE_CORPUS, ...SQUEEZE_MESSAGES]), 1),
			100_000,
		);
		expect(actual.records.length).toBeGreaterThan(100);
		expect(actual.elided.path).toBeGreaterThan(0);
		expect(actual.elided).toEqual(expected.elided);
		expect(actual.records).toEqual(expected.records);
	});

	it("carries forward to a second generation byte-identically", () => {
		const firstMessages = SQUEEZE_MESSAGES.slice(0, 200);
		const secondMessages = SQUEEZE_MESSAGES.slice(200);
		const firstLedger = buildFactLedger({
			messages: firstMessages,
			generation: 1,
			tokenBudget: 100_000,
		});
		const actual = renderFactAppendix(
			buildFactLedger({
				messages: [...MESSAGE_CORPUS, ...secondMessages],
				generation: 2,
				previous: firstLedger,
				tokenBudget: 900,
			}),
		);
		const expected = renderFactAppendix(
			pruneFactLedger(
				mergeFactLedger(firstLedger, extractFactsReference([...MESSAGE_CORPUS, ...secondMessages]), 2),
				900,
			),
		);
		expect(actual.length).toBeGreaterThan(0);
		expect(actual).toBe(expected);
	});

	it("renders the same bytes on a repeated run", () => {
		const first = renderFactAppendix(
			buildFactLedger({ messages: [...MESSAGE_CORPUS, ...SQUEEZE_MESSAGES], generation: 1, tokenBudget: 900 }),
		);
		const second = renderFactAppendix(
			buildFactLedger({ messages: [...MESSAGE_CORPUS, ...SQUEEZE_MESSAGES], generation: 1, tokenBudget: 900 }),
		);
		expect(first).toBe(second);
	});
});
