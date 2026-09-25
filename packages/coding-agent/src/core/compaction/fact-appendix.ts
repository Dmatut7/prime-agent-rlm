/**
 * Deterministic fact appendix for compaction summaries.
 *
 * The measured failure this closes: a first compaction kept 73.5% of the narrative
 * but only 3-20% of hard facts verbatim (SHAs 4%, numbers 3.3%, paths 2.7%), and
 * in update mode the losses compounded per generation - numbers survived 1.1
 * generations on average, one 46-generation session dropped 18 SHAs including its
 * rollback anchors in a single pass, and another restated a SHA with one extra
 * digit, which makes the git command that uses it fail. Asking the summarizer to
 * "PRESERVE exact file paths, function names, and error messages" did not help:
 * the values pass through a model that has no reason to be exact.
 *
 * So they no longer pass through a model. Facts are extracted from the messages
 * being summarized with regexes, kept in a ledger carried forward structurally
 * (session entry details, with the rendered block as fallback), and re-rendered
 * byte-identically every generation. The summarizer never sees the block (see
 * stripMachineBlocks), so it can neither drop nor alter it.
 *
 * The ledger is bounded: per-kind caps plus a token budget priced with the
 * content-density estimator. Eviction is by mention weight and recency, and the
 * block states how much was elided, so a bounded appendix is never a silent one.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTextTokensByContent } from "./content-density.js";
import { checkMachineBlockSelfCount, findMachineBlock, renderMachineBlock } from "./machine-blocks.js";

export type FactKind = "sha" | "path" | "number" | "error" | "issue" | "decision";

export const FACT_KINDS: readonly FactKind[] = ["sha", "path", "number", "error", "issue", "decision"];

export interface FactRecord {
	kind: FactKind;
	/** Verbatim value as it appeared in the transcript (case/spacing normalized only). */
	value: string;
	/**
	 * Sum of the source weights of the distinct messages that mentioned it. One
	 * message counts once per fact, so a value printed 500 times inside a single log
	 * is not 500 times more important than one the user typed once.
	 */
	weight: number;
	firstGeneration: number;
	lastGeneration: number;
	/** Surrounding verbatim snippet; kept only for kinds whose bare value is ambiguous. */
	context?: string;
}

export interface FactLedger {
	/** Compaction generation this ledger was rebuilt in; 1 for the first compaction. */
	generation: number;
	records: FactRecord[];
	/** Facts dropped by the caps or the token budget, per kind. */
	elided: Partial<Record<FactKind, number>>;
}

/**
 * Default token budget for the rendered appendix, in content-density caliber.
 *
 * The caller usually derives it from the compaction settings instead
 * (factAppendixTokenBudget); this is the value for a caller with no settings.
 */
export const FACT_APPENDIX_TOKEN_BUDGET = 4000;

/**
 * Per-kind record caps applied before the token budget is consulted.
 *
 * A cap bounds how far one kind can crowd out the others; the token budget is what
 * actually sizes the block. These are high enough that on the measured sessions the
 * budget binds first, so eviction follows significance rather than kind.
 */
export const FACT_KIND_LIMITS: Readonly<Record<FactKind, number>> = {
	sha: 240,
	path: 400,
	number: 200,
	error: 100,
	issue: 120,
	decision: 60,
};

/** Records every kind keeps before the remaining budget is ranked across kinds. */
export const FACT_KIND_MINIMUM = 4;

/**
 * Order the kinds render in: what a continuation needs first, grouped by kind.
 *
 * `decision` is listed explicitly rather than left to `indexOf` returning -1. It did
 * sort first that way, so this declares the existing behaviour instead of changing
 * it - but an unlisted kind is an accident of the comparator, and the next kind
 * somebody adds would land in the same undeclared slot.
 */
const KIND_RENDER_ORDER: readonly FactKind[] = ["decision", "error", "sha", "path", "number", "issue"];

/** Tie-break priority across kinds when two facts have the same weight: most load-bearing first. */
const KIND_PRIORITY: readonly FactKind[] = ["sha", "decision", "error", "path", "issue", "number"];

/** Boost for facts mentioned in the generation being written, so fresh anchors outrank stale ones. */
const RECENCY_BOOST = 2;

const MAX_VALUE_CHARS: Readonly<Record<FactKind, number>> = {
	sha: 64,
	path: 200,
	number: 80,
	error: 200,
	issue: 16,
	decision: 300,
};

/** Longest verbatim snippet kept alongside a number: enough to disambiguate, not a copy of the line. */
export const FACT_CONTEXT_MAX_CHARS = 120;

/** How much one fact source contributes to a mention weight. */
const SOURCE_WEIGHTS = {
	user: 3,
	assistantText: 3,
	assistantThinking: 1,
	toolCall: 2,
	toolResult: 1,
	custom: 2,
	bashCommand: 3,
	bashOutput: 1,
} as const;

const APPENDIX_HEADER =
	"Machine-extracted from the transcript by regex, no model involved: error signatures, commit SHAs, paths, threshold numbers, issue refs, and stated decisions/conclusions. n = weight of distinct messages mentioning the value, g = first-last generation carrying it, c = verbatim snippet. Authoritative: quote exactly, never restate or correct.";

/**
 * Budget derivation shares and bounds.
 *
 * The appendix replaces a slice of transcript, so its allowance is expressed against
 * that slice: 3% of what it stands in for. Because a slice can never be larger than
 * the model's window, the share is window-proportionate on its own - a 128k-window
 * session cannot produce a 490k-token slice, so it cannot produce a 15k-token
 * appendix either. The ceiling keeps it from outgrowing the context the compaction
 * retains; the floor keeps a small window from getting an appendix too small to hold
 * a single SHA plus the header that explains it.
 */
export const FACT_APPENDIX_BUDGET_KEEP_SHARE = 0.25;
export const FACT_APPENDIX_BUDGET_SLICE_SHARE = 0.03;
export const FACT_APPENDIX_BUDGET_FLOOR = 2500;
export const FACT_APPENDIX_BUDGET_CEILING = 20000;
/** Smallest useful appendix: header plus a handful of records. */
export const FACT_APPENDIX_BUDGET_MINIMUM = 400;

/**
 * Size the appendix against the compaction it belongs to.
 *
 * A fixed budget is wrong at both ends: on a 490k-token slice it retains a quarter of
 * the facts the transcript itself repeats, and on a small window it can outgrow the
 * retained context it annotates. Both inputs are in the keepRecent caliber (content
 * density): keepRecentTokens is the budget the cut was made against, and
 * summarizedTokens measures the slice that left the context the same way. The ledger
 * that spends this budget is priced in that caliber too, so budget and spend agree -
 * a chars/4 slice share would size a CJK-heavy appendix up to 2.67x below its cost.
 */
export function factAppendixTokenBudget(keepRecentTokens: number, summarizedTokens = 0): number {
	if (!Number.isFinite(keepRecentTokens) || keepRecentTokens <= 0) return FACT_APPENDIX_BUDGET_MINIMUM;
	const fromKeep = Math.round(keepRecentTokens * FACT_APPENDIX_BUDGET_KEEP_SHARE);
	const fromSlice =
		Number.isFinite(summarizedTokens) && summarizedTokens > 0
			? Math.round(summarizedTokens * FACT_APPENDIX_BUDGET_SLICE_SHARE)
			: 0;
	const floor = Math.max(
		FACT_APPENDIX_BUDGET_MINIMUM,
		Math.min(FACT_APPENDIX_BUDGET_FLOOR, Math.floor(keepRecentTokens / 2)),
	);
	const ceiling = Math.min(FACT_APPENDIX_BUDGET_CEILING, Math.max(3 * FACT_APPENDIX_BUDGET_MINIMUM, keepRecentTokens));
	return Math.max(floor, Math.min(ceiling, Math.max(fromKeep, fromSlice)));
}

export function emptyFactLedger(generation: number): FactLedger {
	return { generation, records: [], elided: {} };
}

/**
 * Deduplication key for a fact.
 *
 * Derivable from the stored value, so a ledger recovered from details and one
 * recovered from the rendered block key identically. Errors collapse across the
 * numbers embedded in them ("at position 1871" vs "at position 2000" are one
 * recurring failure, not two facts); numbers and decisions collapse across case
 * (and decisions across whitespace runs too), because both are prose that the same
 * author can retype slightly differently in a later generation.
 */
export function factKey(kind: FactKind, value: string): string {
	if (kind === "error") return value.replace(/\d+/g, "N");
	// A decision is prose, so the same statement can be re-typed with different
	// capitalisation in a later generation ("We decided" / "we decided"). Keying on
	// the raw value gave them two slots: one authoritative anchor occupying two
	// appendix lines and its mention weight split in half, which is exactly what
	// decides whether it survives pruning. Case and whitespace are not meaning here.
	if (kind === "decision") return value.toLowerCase().replace(/\s+/g, " ").trim();
	if (kind === "number") return value.toLowerCase();
	return value;
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                  */
/* -------------------------------------------------------------------------- */

const SHORT_SHA_PATTERN = /(?<![0-9a-fA-F-])([0-9a-f]{7,10})(?![0-9a-fA-F-])/g;
const GIT_CONTEXT_PATTERN =
	/\b(?:commit|commits|sha|head|revert|cherry-pick|checkout|merge|rebase|push|tag|blame|bisect|archive|reset|show|diff|rev-parse|git)\b/i;

const PATH_TRAILING_JUNK = /[.,;:!?)\]}'"`>*]+$/;
const RELATIVE_WITH_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const PATH_NOISE_SEGMENT = /(?:^|\/)(?:node_modules|\.git|\.venv|__pycache__)(?:\/|$)/;

/**
 * Numbers carrying a unit. The lookbehind keeps UUID and hex-dash runs out: in
 * "01a07767-0a8e-719d-9367" the segment "719d" reads as 719 days.
 */
const UNIT_NUMBER_PATTERN =
	/(?<![\w.-])(\d+(?:\.\d+)?) ?(milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|bytes?|characters?|chars?|tokens?|lines?|tok|ms|min|s|h|d|MB|GB|KB|TB|KiB|MiB|GiB|B|%|x|×)\b/g;
/**
 * Identifier/number pairs, including quoted JSON keys.
 *
 * The quoted form matters: a transcript is mostly tool output, and settings,
 * budgets and limits reach it as JSON (`"reserveTokens": 16384`). Matching only the
 * bare identifier form misses exactly the thresholds worth keeping.
 */
const ASSIGN_NUMBER_PATTERN = /\b([A-Za-z_][A-Za-z0-9_]{2,40})"?[ \t]{0,2}[:=][ \t]{0,2}(-?\d+(?:\.\d+)?)\b/g;
/**
 * Keyword/number pairs written as prose ("exit code 2", "line 22", "limit: 8").
 * The separator is mandatory: without it "qwen3.8-max-0902" reads as max=-0902.
 */
const KEYWORD_NUMBER_PATTERN =
	/\b(exit code|exit|status|port|lines|line|attempts|attempt|retries|retry|threshold|budget|limit|cap|maximum|minimum|max|min|reserve|keep|timeout|window|generation|gen|version|depth|count|size)(?:[ \t]*[:=#][ \t]*|[ \t]+)(-?\d+(?:\.\d+)?)\b/gi;
/** Config-shaped identifiers: SCREAMING_CASE, camelCase or snake_case. Prose words are not. */
const CONFIG_IDENTIFIER_PATTERN = /^(?:[A-Z][A-Z0-9_]{2,}|[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z0-9]+_[A-Za-z0-9_]+)$/;

/**
 * A line that reports a failure rather than mentioning one.
 *
 * The identifier prefix is optional so a bare `Error:` counts - the single most
 * common shape in agent transcripts, and the one the audit found evaporating from
 * summaries ("Error: Failed to resolve API key for provider ...").
 */
const ERROR_LINE_PATTERN =
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
const CODE_SHAPED_LINE_PATTERN =
	/(?:;\s*$|\{\s*$|=>|\bexpect\(|\bvi\.|\bdescribe\(|^\s*(?:const|let|var|function|class|interface|type|import|export|return|throw|if|for|while|switch|try|catch|elif|else|except|raise|assert|finally|lambda|yield|with|def|end|using|do|done|esac)\b|^\s*(?:[}{*]|\/\/|\/\*)|^\s*[+-]{1,2}\s|^\s*@@|\w\?\s*:|\bnew\s+[A-Z]\w*\()/;

/** Serialized tool calls and other JSON payloads: `ipython {"code":"..."}`. */
const JSON_BLOB_LINE_PATTERN = /\{"[\w$]+"\s*:/;

const ISSUE_URL_PATTERN = /(?:issues|pull|pulls)\/(\d{2,7})\b/g;
const ISSUE_HASH_PATTERN = /(?<![\w/])#(\d{3,6})\b/g;

interface RawFact {
	kind: FactKind;
	value: string;
	key: string;
	context?: string;
}

/** Half-width of the window a context snippet is cut from. */
const CONTEXT_WINDOW = 60;

/**
 * Verbatim window around a match, whitespace-collapsed, for facts whose value alone
 * is ambiguous.
 *
 * Bounded to a fixed window on purpose: finding the enclosing line's start costs
 * O(text length) per match, and one large tool result can carry thousands of numbers.
 * A long line is therefore excerpted rather than quoted in full.
 */
function clipContext(source: string, index: number): string {
	const start = Math.max(0, index - CONTEXT_WINDOW);
	const end = Math.min(source.length, index + CONTEXT_WINDOW);
	const window = source.slice(start, end);
	const offset = index - start;
	const headCut = window.lastIndexOf("\n", offset);
	const tailCut = window.indexOf("\n", offset);
	const line = window.slice(headCut + 1, tailCut === -1 ? window.length : tailCut);
	const matchOffset = offset - headCut - 1;
	const from = Math.max(0, matchOffset - 40);
	return line
		.slice(from, from + FACT_CONTEXT_MAX_CHARS)
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Whether a character code is a hex digit in either case: [0-9], [a-f] or [A-F].
 */
function isHexDigit(code: number): boolean {
	return (
		(code >= 0x30 && code <= 0x39) || // 0-9
		(code >= 0x61 && code <= 0x66) || // a-f
		(code >= 0x41 && code <= 0x46) // A-F
	);
}

function extractShas(text: string, lines: readonly string[], out: RawFact[], prose: boolean): void {
	// A FULL_SHA_PATTERN match is exactly a maximal hex-digit run of length 40 whose
	// characters are all [0-9a-f]: the lookarounds force the match to span the whole
	// run, and any A-F lengthens the run past what [0-9a-f]{40} can cover, so scanning
	// maximal runs emits the same SHAs without a match object per SHA.
	let index = 0;
	while (index < text.length) {
		if (!isHexDigit(text.charCodeAt(index))) {
			index++;
			continue;
		}
		const runStart = index;
		let uppercase = false;
		while (index < text.length) {
			const code = text.charCodeAt(index);
			if (!isHexDigit(code)) break;
			if (code >= 0x41 && code <= 0x46) uppercase = true;
			index++;
		}
		if (index - runStart === 40 && !uppercase) {
			const value = text.slice(runStart, index);
			out.push({ kind: "sha", value, key: value });
		}
	}
	for (const line of lines) {
		// An abbreviated hash in prose somebody wrote is a commit; the same token in a
		// log is usually an id fragment. Only prose gets to skip the git-context test.
		if (!prose && !GIT_CONTEXT_PATTERN.test(line)) continue;
		for (const match of line.matchAll(SHORT_SHA_PATTERN)) {
			const value = match[1];
			// Words such as "feedback" are valid hex; a real abbreviated SHA has both.
			if (!/\d/.test(value) || !/[a-f]/.test(value)) continue;
			out.push({ kind: "sha", value, key: value });
		}
	}
}

/** Whether a character can appear in a filesystem path. */
function isPathChar(code: number): boolean {
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
function extractPaths(text: string, out: RawFact[]): void {
	let index = 0;
	while (index < text.length) {
		if (!isPathChar(text.charCodeAt(index))) {
			index++;
			continue;
		}
		const runStart = index;
		let slashes = 0;
		while (index < text.length && isPathChar(text.charCodeAt(index))) {
			if (text.charCodeAt(index) === 0x2f) slashes++;
			index++;
		}
		if (slashes === 0) continue;
		let value = text.slice(runStart, index).replace(PATH_TRAILING_JUNK, "");
		while (value.endsWith("/")) value = value.slice(0, -1);
		if (value.length < 4 || value.length > MAX_VALUE_CHARS.path) continue;
		// A URL is a run with "://" in it, and a doubled slash is not a filesystem path.
		if (value.includes("//")) continue;
		if (PATH_NOISE_SEGMENT.test(value)) continue;
		const segments = value.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length < 2) continue;
		const absolute = value.startsWith("/") || value.startsWith("~/");
		const last = segments[segments.length - 1];
		if (!absolute && segments.length < 3 && !RELATIVE_WITH_EXTENSION.test(last)) continue;
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
const CLAIM_BUCKET = 256;

class ClaimedSpans {
	private readonly buckets = new Map<number, Array<[number, number]>>();

	add(from: number, to: number): void {
		for (let bucket = Math.floor(from / CLAIM_BUCKET); bucket <= Math.floor(to / CLAIM_BUCKET); bucket++) {
			const existing = this.buckets.get(bucket);
			if (existing) existing.push([from, to]);
			else this.buckets.set(bucket, [[from, to]]);
		}
	}

	overlaps(from: number, to: number): boolean {
		for (let bucket = Math.floor(from / CLAIM_BUCKET); bucket <= Math.floor(to / CLAIM_BUCKET); bucket++) {
			for (const [start, end] of this.buckets.get(bucket) ?? []) {
				if (from < end && start < to) return true;
			}
		}
		return false;
	}
}

function extractNumbers(text: string, out: RawFact[]): void {
	const taken = new ClaimedSpans();
	const overlaps = (from: number, to: number): boolean => taken.overlaps(from, to);
	const claim = (from: number, to: number): void => {
		taken.add(from, to);
	};

	for (const match of text.matchAll(ASSIGN_NUMBER_PATTERN)) {
		const identifier = match[1];
		if (!CONFIG_IDENTIFIER_PATTERN.test(identifier)) continue;
		const from = match.index ?? 0;
		const value = `${identifier}=${match[2]}`;
		claim(from, from + match[0].length);
		out.push({ kind: "number", value, key: factKey("number", value), context: clipContext(text, from) });
	}
	for (const match of text.matchAll(KEYWORD_NUMBER_PATTERN)) {
		const from = match.index ?? 0;
		if (overlaps(from, from + match[0].length)) continue;
		claim(from, from + match[0].length);
		const keyword = match[1].toLowerCase().replace(/\s+/g, " ");
		const value = `${keyword}=${match[2]}`;
		out.push({ kind: "number", value, key: factKey("number", value), context: clipContext(text, from) });
	}
	for (const match of text.matchAll(UNIT_NUMBER_PATTERN)) {
		const from = match.index ?? 0;
		if (overlaps(from, from + match[0].length)) continue;
		claim(from, from + match[0].length);
		if (Number.parseFloat(match[1]) === 0) continue; // "0ms" carries no threshold
		const value = `${match[1]}${match[2]}`;
		out.push({ kind: "number", value, key: factKey("number", value), context: clipContext(text, from) });
	}
}

/**
 * Split a blob into the lines a reader would see.
 *
 * Tool-call arguments reach the extractor as one JSON string, so their embedded
 * `\n` escapes are not line breaks; without splitting them, a whole code cell is a
 * single "line" and any `Error:` inside it looks like a reported failure.
 */
function splitReportLines(text: string): string[] {
	return text.split(/\n|\\n/);
}

function extractErrors(lines: readonly string[], out: RawFact[]): void {
	for (const rawLine of lines) {
		if (!ERROR_LINE_PATTERN.test(rawLine)) continue;
		const line = rawLine.replace(/^\s*(?:\[[^\]]{0,60}\]\s*)+/, "").trim();
		if (line.length < 10) continue;
		if (CODE_SHAPED_LINE_PATTERN.test(line)) continue;
		// A serialized tool call is data about a call, not a report of one.
		if (JSON_BLOB_LINE_PATTERN.test(line)) continue;
		const clipped = line.length > MAX_VALUE_CHARS.error ? `${line.slice(0, MAX_VALUE_CHARS.error - 1)}…` : line;
		out.push({ kind: "error", value: clipped, key: factKey("error", clipped) });
	}
}

function extractIssues(text: string, out: RawFact[]): void {
	for (const pattern of [ISSUE_URL_PATTERN, ISSUE_HASH_PATTERN]) {
		for (const match of text.matchAll(pattern)) {
			const value = `#${match[1]}`;
			out.push({ kind: "issue", value, key: value });
		}
	}
}

/** Every fact kind in one text blob, in extraction order. */
/**
 * Sentence-level markers that make an authored sentence a stated decision or a
 * conclusion rather than narration.
 *
 * Deliberately narrow. The appendix is declared authoritative ("quote exactly, never
 * restate or correct"), so one false positive injects a wrong instruction into every
 * later generation - a cost that outweighs the recall gained by loosening these to
 * bare connectives like 因为 or "because".
 */
const DECISION_MARKERS: readonly RegExp[] = [
	/结论(?:是|为|[:：])/,
	/(?:已|就|才)?(?:决定|拍板|敲定|定为|定下来)/,
	/(?:根因|根本原因|真正的原因|真正原因是)/,
	/(?:采用|选用|改用|换成|改为|改成|放弃|不采用|不选|不用了)/,
	/(?:默认(?:用|走|取|按)|一律|统一用|优先用|以后都)/,
	/(?:唯一(?:解法|办法|出路)|判据是|验收标准是)/,
	/\b(?:we (?:decided|chose|choose|settled)|the fix is|root cause is|decision:)/i,
];

/** Shortest decision sentence worth carrying; below this the value is a fragment, not a statement. */
const DECISION_MIN_CHARS = 10;

/** How much of a clipped decision stays at the front: the statement itself ("we decided X"). */
const DECISION_CLIP_HEAD_CHARS = 200;
/** How much stays at the end: the rationale a long sentence usually trails with ("...because Y"). */
const DECISION_CLIP_TAIL_CHARS = 70;

/** Sentence terminators that end a decision statement without cutting into it. */
const DECISION_SENTENCE_SPLIT = /(?<=[。！？!?；;])|\n+/;

/**
 * Clip an over-long decision sentence instead of dropping it.
 *
 * The block declares itself authoritative ("quote exactly"), so a clipped value has
 * to say in its own text that it is clipped: a reader that quotes it verbatim is
 * quoting the head and the tail of a statement, not the statement. Dropping the whole
 * sentence was the previous behaviour and was silent - records stayed 0 and `elided`
 * stayed empty, because the elided counter counts what pruning dropped from a ledger,
 * not what extraction refused. A long decision is the one carrying the most reasoning
 * ("...理由是..."), so losing it entirely to a character cap is the worst available
 * outcome. Head plus tail keeps the statement and its trailing rationale.
 */
function clipDecision(sentence: string, maxChars: number): string {
	if (sentence.length <= maxChars) return sentence;
	const marker = (dropped: number) => `[…${dropped} characters elided…]`;
	const widest = marker(sentence.length).length;
	const tail = Math.min(DECISION_CLIP_TAIL_CHARS, Math.floor((maxChars - widest) / 3));
	const head = Math.min(DECISION_CLIP_HEAD_CHARS, maxChars - widest - tail);
	if (head + tail <= 0) return sentence.slice(0, maxChars - 1) + "…";
	const dropped = sentence.length - head - tail;
	if (dropped <= 0) return sentence;
	return `${sentence.slice(0, head)}${marker(dropped)}${sentence.slice(sentence.length - tail)}`;
}

/**
 * Verbatim decision and conclusion sentences from authored prose.
 *
 * What this closes: the appendices carried hard facts and the user's own words
 * verbatim, but an agent's stated decision ("root cause is X", "we settle on Y") lived
 * only in the model-written summary - so a compaction or a model switch handed the next
 * model a paraphrase of a decision instead of the decision itself. Only authored prose
 * is scanned (see extractFacts), and the value is the sentence as written: whitespace
 * normalised, never reworded, because the block instructs every later generation to
 * quote it exactly. A sentence past the value cap is clipped head-and-tail with the
 * elision stated inside the value, not dropped - see clipDecision.
 */
function extractDecisions(text: string, out: RawFact[], enabled: boolean): void {
	if (!enabled || !text) return;
	for (const raw of text.split(DECISION_SENTENCE_SPLIT)) {
		const sentence = raw.trim().replace(/\s+/g, " ");
		if (sentence.length < DECISION_MIN_CHARS) continue;
		if (!DECISION_MARKERS.some((pattern) => pattern.test(sentence))) continue;
		// The marker is matched on the full sentence and the value is clipped
		// afterwards: a long statement whose verdict sits past the cap still counts,
		// and the clip is what the block carries. The key follows the clipped value,
		// exactly as the error extractor keys the line it clipped - two statements
		// whose head and tail agree are one anchor, so the block cannot render the
		// same line twice and split its weight across two slots.
		const clipped = clipDecision(sentence, MAX_VALUE_CHARS.decision);
		out.push({ kind: "decision", value: clipped, key: factKey("decision", clipped) });
	}
}

export function extractFactsFromText(text: string, options?: { prose?: boolean; decisions?: boolean }): RawFact[] {
	const out: RawFact[] = [];
	if (!text) return out;
	// extractShas and extractErrors walk the same line decomposition, so the lines are
	// split once here and passed to both. Each pass only reads the array and still runs
	// at its original position in the sequence, so every fact and their order in `out`
	// are unchanged; only the second full line-array allocation per text is gone.
	const lines = splitReportLines(text);
	extractShas(text, lines, out, options?.prose ?? false);
	extractPaths(text, out);
	extractNumbers(text, out);
	extractErrors(lines, out);
	extractIssues(text, out);
	extractDecisions(text, out, options?.decisions ?? false);
	return out;
}

function textBlocks(content: unknown): string[] {
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
export interface FactSource {
	text: string;
	weight: number;
}

/**
 * Weight at and above which a source counts as prose somebody wrote, rather than
 * output a program produced. Prose gets the looser abbreviated-SHA rule.
 */
const PROSE_SOURCE_WEIGHT = 3;

/**
 * The fact-bearing texts of one message, each with its source weight.
 *
 * Summary roles are skipped on purpose: their text is this module's own output
 * from an earlier generation, and re-extracting it would inflate the mention
 * weight of facts the ledger already carries.
 */
export function factSources(message: AgentMessage): FactSource[] {
	switch (message.role) {
		case "user":
			return textBlocks(message.content).map((text) => ({ text, weight: SOURCE_WEIGHTS.user }));
		case "assistant": {
			const sources: FactSource[] = [];
			const calls: string[] = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text) {
					sources.push({ text: block.text, weight: SOURCE_WEIGHTS.assistantText });
				} else if (block.type === "thinking" && block.thinking) {
					sources.push({ text: block.thinking, weight: SOURCE_WEIGHTS.assistantThinking });
				} else if (block.type === "toolCall") {
					calls.push(`${block.name} ${JSON.stringify(block.arguments)}`);
				}
			}
			if (calls.length > 0) sources.push({ text: calls.join("\n"), weight: SOURCE_WEIGHTS.toolCall });
			return sources;
		}
		case "toolResult":
			return textBlocks(message.content).map((text) => ({ text, weight: SOURCE_WEIGHTS.toolResult }));
		case "custom":
			return textBlocks(message.content).map((text) => ({ text, weight: SOURCE_WEIGHTS.custom }));
		case "bashExecution": {
			const sources: FactSource[] = [];
			if (message.command) sources.push({ text: message.command, weight: SOURCE_WEIGHTS.bashCommand });
			if (message.output) sources.push({ text: message.output, weight: SOURCE_WEIGHTS.bashOutput });
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
export function extractFacts(messages: readonly AgentMessage[]): Map<string, FactRecord> {
	const found = new Map<string, FactRecord>();
	for (const message of messages) {
		const perMessage = new Map<string, { fact: RawFact; weight: number }>();
		for (const source of factSources(message)) {
			const prose = source.weight >= PROSE_SOURCE_WEIGHT;
			// Decisions are scanned from the assistant's own prose only. User words
			// already ride verbatim in <user-requests>, so re-extracting them here would
			// double-book the same sentence into two authoritative blocks.
			const decisions = message.role === "assistant" && prose;
			for (const fact of extractFactsFromText(source.text, { prose, decisions })) {
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
	return collapseShaAliases(found);
}

/**
 * Merge an abbreviated SHA into the full one it prefixes.
 *
 * Transcripts refer to a commit both ways. Keeping both would spend two appendix
 * slots on one anchor and split the mention weight that decides whether it
 * survives pruning.
 */
function collapseShaAliases(records: Map<string, FactRecord>): Map<string, FactRecord> {
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
/* Ledger                                                                      */
/* -------------------------------------------------------------------------- */

/** Ranking key: mention weight, with facts from the current generation boosted. */
export function factScore(record: FactRecord, generation: number): number {
	return record.weight + (record.lastGeneration === generation ? RECENCY_BOOST : 0);
}

function compareRecords(a: FactRecord, b: FactRecord, generation: number): number {
	const score = factScore(b, generation) - factScore(a, generation);
	if (score !== 0) return score;
	const recency = b.lastGeneration - a.lastGeneration;
	if (recency !== 0) return recency;
	return a.value.localeCompare(b.value);
}

/** Rank across kinds: significance first, then kind priority, then recency and value. */
function compareContenders(a: FactRecord, b: FactRecord, generation: number): number {
	const score = factScore(b, generation) - factScore(a, generation);
	if (score !== 0) return score;
	const kindRank = KIND_PRIORITY.indexOf(b.kind) - KIND_PRIORITY.indexOf(a.kind);
	if (kindRank !== 0) return kindRank;
	const recency = b.lastGeneration - a.lastGeneration;
	if (recency !== 0) return recency;
	return a.value.localeCompare(b.value);
}

/** Stable render order: grouped by kind, ranked inside the kind. */
function compareRenderOrder(a: FactRecord, b: FactRecord, generation: number): number {
	const kindRank = KIND_RENDER_ORDER.indexOf(a.kind) - KIND_RENDER_ORDER.indexOf(b.kind);
	if (kindRank !== 0) return kindRank;
	return compareRecords(a, b, generation);
}

/**
 * Fold newly extracted facts into the carried-forward ledger.
 *
 * Facts never expire by age: eviction happens only in pruneFactLedger, by rank.
 * That is what makes the appendix generation-invariant - the property whose absence
 * measured as 1.1 generations of survival for numbers.
 */
export function mergeFactLedger(
	previous: FactLedger | undefined,
	extracted: ReadonlyMap<string, FactRecord>,
	generation: number,
): FactLedger {
	const merged = new Map<string, FactRecord>();
	for (const record of previous?.records ?? []) {
		merged.set(`${record.kind}:${factKey(record.kind, record.value)}`, { ...record });
	}
	for (const [key, record] of extracted) {
		const existing = merged.get(key);
		if (existing) {
			existing.weight += record.weight;
			existing.lastGeneration = generation;
			existing.context ??= record.context;
			if (record.kind === "sha" && record.value.length > existing.value.length) existing.value = record.value;
		} else {
			merged.set(key, { ...record, firstGeneration: generation, lastGeneration: generation });
		}
	}
	// A commit can be recorded abbreviated in one generation and in full in another;
	// folding them here keeps one anchor from occupying two slots in every later one.
	return { generation, records: [...collapseShaAliases(merged).values()], elided: {} };
}

function elidedCounts(
	totals: ReadonlyMap<FactKind, number>,
	kept: readonly FactRecord[],
): Partial<Record<FactKind, number>> {
	const keptPerKind = new Map<FactKind, number>();
	for (const record of kept) keptPerKind.set(record.kind, (keptPerKind.get(record.kind) ?? 0) + 1);
	const elided: Partial<Record<FactKind, number>> = {};
	for (const kind of FACT_KINDS) {
		const dropped = (totals.get(kind) ?? 0) - (keptPerKind.get(kind) ?? 0);
		if (dropped > 0) elided[kind] = dropped;
	}
	return elided;
}

/**
 * Apply the per-kind caps and the token budget.
 *
 * Three rules, in order:
 * 1. Per-kind caps bound how far one kind can crowd out the others.
 * 2. Every kind keeps a minimum representation, so a transcript full of paths
 *    cannot wipe out its SHAs or its error signatures.
 * 3. Whatever budget is left goes to the highest-ranked records across all kinds.
 *
 * The budget is measured on the rendered block - header and attributes included -
 * in content-density tokens, and met by binary search because the rendered size is
 * monotone in the number of records kept. Deterministic: the same ledger and the
 * same budget always keep the same set, which is what turns "zero decay across
 * generations" into a property of the code instead of a property of one run.
 */
export function pruneFactLedger(ledger: FactLedger, tokenBudget: number = FACT_APPENDIX_TOKEN_BUDGET): FactLedger {
	const generation = ledger.generation;
	const totals = new Map<FactKind, number>();
	const capped = new Map<FactKind, FactRecord[]>();
	for (const kind of FACT_KINDS) {
		const ranked = ledger.records
			.filter((record) => record.kind === kind)
			.sort((a, b) => compareRecords(a, b, generation));
		totals.set(kind, ranked.length);
		capped.set(kind, ranked.slice(0, FACT_KIND_LIMITS[kind]));
	}

	const protectedRecords: FactRecord[] = [];
	const contenders: FactRecord[] = [];
	for (const kind of FACT_KINDS) {
		const ranked = capped.get(kind) ?? [];
		protectedRecords.push(...ranked.slice(0, Math.min(FACT_KIND_MINIMUM, ranked.length)));
		contenders.push(...ranked.slice(FACT_KIND_MINIMUM));
	}
	contenders.sort((a, b) => compareContenders(a, b, generation));

	const ledgerFor = (records: FactRecord[]): FactLedger => ({
		generation,
		records: records.slice().sort((a, b) => compareRenderOrder(a, b, generation)),
		elided: elidedCounts(totals, records),
	});
	const tokensOf = (records: FactRecord[]): number =>
		estimateTextTokensByContent(renderFactAppendix(ledgerFor(records)));

	if (tokensOf(protectedRecords) > tokenBudget) {
		// Even the protected minimum does not fit: fall back to a plain global ranking
		// and keep the prefix that does, so the block never overruns its stated budget.
		const ranked = [...protectedRecords, ...contenders].sort((a, b) => compareContenders(a, b, generation));
		const trimmed: FactRecord[] = [];
		for (const record of ranked) {
			trimmed.push(record);
			if (tokensOf(trimmed) > tokenBudget) {
				trimmed.pop();
				break;
			}
		}
		return ledgerFor(trimmed);
	}

	let low = 0;
	let high = contenders.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (tokensOf([...protectedRecords, ...contenders.slice(0, mid)]) <= tokenBudget) low = mid;
		else high = mid - 1;
	}
	return ledgerFor([...protectedRecords, ...contenders.slice(0, low)]);
}

/** Extract, fold into the carried-forward ledger, and prune: the whole pipeline. */
export function buildFactLedger(options: {
	messages: readonly AgentMessage[];
	generation: number;
	previous?: FactLedger;
	tokenBudget?: number;
}): FactLedger {
	const extracted = extractFacts(options.messages);
	const merged = mergeFactLedger(options.previous, extracted, options.generation);
	return pruneFactLedger(merged, options.tokenBudget ?? FACT_APPENDIX_TOKEN_BUDGET);
}

/* -------------------------------------------------------------------------- */
/* Rendering and parsing                                                       */
/* -------------------------------------------------------------------------- */

interface WireFact {
	k: FactKind;
	v: string;
	n: number;
	g: string;
	c?: string;
}

function renderFactLine(record: FactRecord): string {
	const wire: WireFact = {
		k: record.kind,
		v: record.value,
		n: record.weight,
		g: `${record.firstGeneration}-${record.lastGeneration}`,
	};
	if (record.context) wire.c = record.context;
	// `<` is JSON-escaped so a payload that quotes a block delimiter cannot end the
	// block early: the JSON parse restores it byte-exact, and a block written before
	// this rule still parses (JSON.parse accepts both spellings).
	return JSON.stringify(wire).replace(/</g, "\\u003c");
}

/** Render the appendix block for a summary; an empty ledger renders nothing. */
export function renderFactAppendix(ledger: FactLedger): string {
	if (ledger.records.length === 0) return "";
	const lines: string[] = [APPENDIX_HEADER];
	for (const record of ledger.records) lines.push(renderFactLine(record));
	const elidedTotal = FACT_KINDS.reduce((sum, kind) => sum + (ledger.elided[kind] ?? 0), 0);
	const attributes: Record<string, string | number> = {
		generation: ledger.generation,
		facts: ledger.records.length,
	};
	if (elidedTotal > 0) {
		attributes.elided = elidedTotal;
		attributes.elidedDetail = FACT_KINDS.filter((kind) => (ledger.elided[kind] ?? 0) > 0)
			.map((kind) => `${kind}:${ledger.elided[kind]}`)
			.join(",");
	}
	return renderMachineBlock("fact-appendix", attributes, lines.join("\n"));
}

/**
 * Recover a ledger from a rendered appendix.
 *
 * Session entry details are the primary carry-forward; this is the fallback for
 * entries whose details were dropped or written before the appendix existed.
 * Malformed lines are skipped rather than thrown on: a corrupted block must not be
 * able to fail a compaction.
 */
export function parseFactAppendix(text: string): FactLedger | undefined {
	const block = findMachineBlock(text, "fact-appendix");
	if (!block) return undefined;
	const generation = Number.parseInt(block.attributes.generation ?? "1", 10);
	const records: FactRecord[] = [];
	for (const line of block.body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let wire: WireFact;
		try {
			wire = JSON.parse(trimmed) as WireFact;
		} catch {
			continue;
		}
		if (!wire || typeof wire.v !== "string" || wire.v.length === 0) continue;
		if (!FACT_KINDS.includes(wire.k)) continue;
		const [first, last] = String(wire.g ?? "").split("-");
		const firstGeneration = Number.parseInt(first, 10);
		const lastGeneration = Number.parseInt(last, 10);
		records.push({
			kind: wire.k,
			value: wire.v,
			weight: Number.isFinite(wire.n) ? Math.max(1, Math.trunc(wire.n)) : 1,
			firstGeneration: Number.isFinite(firstGeneration) ? firstGeneration : 1,
			lastGeneration: Number.isFinite(lastGeneration) ? lastGeneration : generation,
			context: typeof wire.c === "string" && wire.c.length > 0 ? wire.c : undefined,
		});
	}
	const elided: Partial<Record<FactKind, number>> = {};
	for (const entry of (block.attributes.elidedDetail ?? "").split(",")) {
		const separator = entry.indexOf(":");
		if (separator <= 0) continue;
		const kind = entry.slice(0, separator) as FactKind;
		if (!FACT_KINDS.includes(kind)) continue;
		const count = Number.parseInt(entry.slice(separator + 1), 10);
		if (Number.isFinite(count) && count > 0) elided[kind] = count;
	}
	// Same self-check as the user-request block, and the same ordering rule: `facts` is written
	// on the opening tag, and the comparison runs on the anchored block, so a gap between the
	// declaration and the records parsed back is damage worth reporting rather than a header
	// that can declare whatever the payload needs it to declare.
	checkMachineBlockSelfCount(block, "facts", records.length);
	return { generation: Number.isFinite(generation) && generation > 0 ? generation : 1, records, elided };
}

/** Recover a ledger from a compaction entry's details, when it carries one. */
export function factLedgerFromDetails(details: unknown, generation: number): FactLedger | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { facts?: unknown }).facts;
	if (!candidate || typeof candidate !== "object") return undefined;
	const typed = candidate as Partial<FactLedger>;
	if (!Array.isArray(typed.records)) return undefined;
	const ledgerGeneration =
		Number.isFinite(typed.generation) && (typed.generation as number) > 0 ? (typed.generation as number) : generation;
	const records: FactRecord[] = [];
	for (const record of typed.records) {
		if (!record || typeof record !== "object") continue;
		if (typeof record.value !== "string" || record.value.length === 0) continue;
		if (!FACT_KINDS.includes(record.kind)) continue;
		records.push({
			kind: record.kind,
			value: record.value,
			weight: Number.isFinite(record.weight) ? Math.max(1, Math.trunc(record.weight)) : 1,
			// A record without stamps inherits the ledger's own generation, not the one
			// being written: the two differ, and the stamp is provenance.
			firstGeneration: Number.isFinite(record.firstGeneration) ? record.firstGeneration : ledgerGeneration,
			lastGeneration: Number.isFinite(record.lastGeneration) ? record.lastGeneration : ledgerGeneration,
			context: typeof record.context === "string" && record.context.length > 0 ? record.context : undefined,
		});
	}
	return {
		generation: ledgerGeneration,
		records,
		elided: typeof typed.elided === "object" && typed.elided !== null ? typed.elided : {},
	};
}
