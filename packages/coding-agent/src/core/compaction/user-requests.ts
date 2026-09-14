/**
 * Verbatim preservation of what the user actually said.
 *
 * The measured failure: one-off user instructions and problem reports were the
 * single largest loss in a first compaction - 9 of the 9 dropped items in the
 * curated checklist were user words, all of them visible to the summarizer, all of
 * them dropped by it. A user-reported production error ("Failed to resolve API key
 * for provider ...") and an explicit request ("赶紧多个代理审查") both evaporated, so
 * after compaction the agent no longer knew the user had ever reported them.
 *
 * User text is the cheapest thing in a transcript (4k characters in a 700k-token
 * session) and the most expensive to lose, so it is not summarized at all: it is
 * carried verbatim in its own machine block, the same way the file lists are. The
 * block is bounded like everything else, and the bound is spent oldest-first and
 * disclosed in the block attributes, so "we stopped carrying it" is never silent.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTextTokensByContent } from "./content-density.js";
import { checkMachineBlockSelfCount, findMachineBlock, renderMachineBlock } from "./machine-blocks.js";

export type UserRequestKind = "user" | "bash";

export interface UserRequestRecord {
	/** Verbatim text; clipped past USER_REQUEST_ENTRY_MAX_CHARS with the elision kept visible. */
	text: string;
	/** Compaction generation that first carried this request. */
	generation: number;
	/** Order within that generation's slice. */
	sequence: number;
	/** How often the same text was seen; retries and queued duplicates collapse here. */
	repeats: number;
	/** Length of the text before clipping, when it was clipped. */
	originalChars?: number;
	kind: UserRequestKind;
}

export interface UserRequestLedger {
	generation: number;
	records: UserRequestRecord[];
	/** Requests dropped because the block budget was exhausted, across all generations. */
	elided: number;
}

/** Token budget for the rendered block, in content-density caliber. */
export const USER_REQUESTS_TOKEN_BUDGET = 6000;

/** Per-request cap: enough for a full instruction, not enough for a pasted transcript. */
export const USER_REQUEST_ENTRY_MAX_CHARS = 1000;

/** Head/tail split of a clipped request; the middle of a long paste is what goes. */
const ENTRY_HEAD_CHARS = 700;
const ENTRY_TAIL_CHARS = 250;

/** Cap applied to the oldest requests once the block budget binds, before any is dropped. */
export const USER_REQUEST_COMPRESSED_CHARS = 160;

const BLOCK_HEADER =
	"The user's own words from the compacted transcript, preserved mechanically, oldest first, JSON-encoded so the text is byte-exact (x marks an elided middle). Not a summary: treat every unresolved instruction and reported problem here as a live obligation.";

/** Share of keepRecentTokens the verbatim block may spend when the caller derives its budget. */
export const USER_REQUESTS_BUDGET_SHARE = 0.3;
export const USER_REQUESTS_BUDGET_FLOOR = 6000;
export const USER_REQUESTS_BUDGET_CEILING = 16000;
/** Smallest useful block: header plus a couple of requests. */
export const USER_REQUESTS_BUDGET_MINIMUM = 400;

/**
 * Size the verbatim block against the context the compaction keeps.
 *
 * User text is the cheapest content in a transcript and the most expensive to lose:
 * the measured session carried 4k characters of it inside a 490k-token slice, so a
 * generous budget costs almost nothing. The floor keeps a small window from getting a
 * block too small to hold its own header, and the ceiling keeps it from outgrowing
 * the retained slice.
 */
export function userRequestsTokenBudget(keepRecentTokens: number): number {
	if (!Number.isFinite(keepRecentTokens) || keepRecentTokens <= 0) return USER_REQUESTS_BUDGET_MINIMUM;
	const share = Math.round(keepRecentTokens * USER_REQUESTS_BUDGET_SHARE);
	const floor = Math.max(
		USER_REQUESTS_BUDGET_MINIMUM,
		Math.min(USER_REQUESTS_BUDGET_FLOOR, Math.floor(keepRecentTokens / 2)),
	);
	const ceiling = Math.min(USER_REQUESTS_BUDGET_CEILING, Math.max(3 * USER_REQUESTS_BUDGET_MINIMUM, keepRecentTokens));
	return Math.max(floor, Math.min(ceiling, share));
}

export function emptyUserRequestLedger(generation: number): UserRequestLedger {
	return { generation, records: [], elided: 0 };
}

/** Clip one request to a character cap, keeping head and tail and saying what went. */
export function clipUserRequest(text: string, maxChars: number): { text: string; originalChars?: number } {
	if (text.length <= maxChars) return { text };
	if (maxChars <= 24) return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, originalChars: text.length };
	const marker = (dropped: number) => `\n[… ${dropped} characters elided …]\n`;
	// Reserve the widest marker the clip can need before choosing the head/tail split.
	const widest = marker(text.length).length;
	if (maxChars <= widest + 24) {
		return { text: `${text.slice(0, Math.max(0, maxChars - 1))}…`, originalChars: text.length };
	}
	const tail = Math.min(ENTRY_TAIL_CHARS, Math.floor((maxChars - widest) / 3));
	const head = Math.min(ENTRY_HEAD_CHARS, maxChars - widest - tail);
	const dropped = text.length - head - tail;
	if (dropped <= 0) return { text };
	return {
		text: `${text.slice(0, head)}${marker(dropped)}${text.slice(text.length - tail)}`,
		originalChars: text.length,
	};
}

function userTexts(message: AgentMessage): Array<{ text: string; kind: UserRequestKind }> {
	if (message.role === "user") {
		const content = message.content;
		if (typeof content === "string") return content.trim() ? [{ text: content, kind: "user" }] : [];
		if (!Array.isArray(content)) return [];
		const text = content
			.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map((block) => block.text)
			.join("\n");
		return text.trim() ? [{ text, kind: "user" }] : [];
	}
	if (message.role === "bashExecution" && message.command.trim()) {
		// `!command` is user-initiated; the output is not the user speaking.
		return [{ text: message.command, kind: "bash" }];
	}
	return [];
}

/** Collect the user-originated messages of one slice, in order. */
export function collectUserRequests(messages: readonly AgentMessage[], generation: number): UserRequestRecord[] {
	const records: UserRequestRecord[] = [];
	let sequence = 0;
	for (const message of messages) {
		for (const { text, kind } of userTexts(message)) {
			const clipped = clipUserRequest(text, USER_REQUEST_ENTRY_MAX_CHARS);
			const duplicate = records.find((record) => record.text === clipped.text && record.kind === kind);
			if (duplicate) {
				duplicate.repeats += 1;
				continue;
			}
			records.push({
				text: clipped.text,
				generation,
				sequence: sequence++,
				repeats: 1,
				originalChars: clipped.originalChars,
				kind,
			});
		}
	}
	return records;
}

/**
 * Append a slice's requests to the carried-forward ledger.
 *
 * Exact duplicates collapse into `repeats` instead of a second record: queued and
 * re-sent messages are common and would otherwise spend the budget saying one thing
 * twice.
 */
export function mergeUserRequests(
	previous: UserRequestLedger | undefined,
	collected: readonly UserRequestRecord[],
	generation: number,
): UserRequestLedger {
	const records = (previous?.records ?? []).map((record) => ({ ...record }));
	for (const record of collected) {
		const duplicate = records.find((existing) => existing.text === record.text && existing.kind === record.kind);
		if (duplicate) {
			duplicate.repeats += record.repeats;
			continue;
		}
		records.push({ ...record, generation });
	}
	return { generation, records, elided: previous?.elided ?? 0 };
}

/** Smallest k in [0, maxK] whose candidate fits, assuming "fits" turns true and stays true. */
function smallestFit(maxK: number, fits: (k: number) => boolean): number {
	if (maxK <= 0 || fits(0)) return 0;
	let low = 1;
	let high = maxK;
	let answer = maxK;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (fits(mid)) {
			answer = mid;
			high = mid - 1;
		} else {
			low = mid + 1;
		}
	}
	return answer;
}

/**
 * Fit the ledger to its token budget.
 *
 * Three stages, each oldest-first and each disclosed by the block's `elided`
 * attribute:
 * 1. re-clip the oldest requests to a short cap - a long paste keeps its head;
 * 2. drop the requests that were clipped, longest original first - a pasted log is
 *    the least likely thing to still be a live obligation;
 * 3. only then drop requests outright, oldest first.
 *
 * Stage 2 before stage 3 is the point: a one-line instruction ("do not push",
 * "answer in Chinese") is never clipped, so it outlives every paste in the ledger
 * and can only be evicted by a session that has nothing else left to give up.
 * Dropping is permanent and counted, so the block never implies completeness it
 * does not have.
 */
export function pruneUserRequests(
	ledger: UserRequestLedger,
	tokenBudget: number = USER_REQUESTS_TOKEN_BUDGET,
): UserRequestLedger {
	const base = ledger.records.map((record) => ({ ...record }));
	let elided = ledger.elided;
	// Measured on the rendered block, header and attributes included: a budget that
	// only accounted for the JSON lines would let the finished block overrun it.
	const tokensOf = (records: readonly UserRequestRecord[], dropped: number): number =>
		estimateTextTokensByContent(renderUserRequests({ generation: ledger.generation, records, elided: dropped }));
	if (tokensOf(base, elided) <= tokenBudget) return { generation: ledger.generation, records: base, elided };

	// Stage 1: compress the oldest first.
	const compressAt = (k: number): UserRequestRecord[] =>
		base.map((record, index) => {
			if (index >= k) return record;
			const clipped = clipUserRequest(record.text, USER_REQUEST_COMPRESSED_CHARS);
			return {
				...record,
				text: clipped.text,
				originalChars: clipped.originalChars ?? record.originalChars,
			};
		});
	const compressCount = smallestFit(base.length, (k) => tokensOf(compressAt(k), elided) <= tokenBudget);
	let records = compressAt(compressCount);
	if (tokensOf(records, elided) <= tokenBudget) return { generation: ledger.generation, records, elided };

	// Stage 2: drop clipped requests (the pastes), longest original first, oldest first on ties.
	const pasteOrder = records
		.map((record, index) => ({ index, record }))
		.filter(({ record }) => (record.originalChars ?? 0) > record.text.length)
		.sort((a, b) => {
			const byLength = (b.record.originalChars ?? 0) - (a.record.originalChars ?? 0);
			if (byLength !== 0) return byLength;
			const byGeneration = a.record.generation - b.record.generation;
			if (byGeneration !== 0) return byGeneration;
			return a.record.sequence - b.record.sequence;
		})
		.map(({ index }) => index);
	const dropPasteAt = (k: number): UserRequestRecord[] => {
		const dropped = new Set(pasteOrder.slice(0, k));
		return records.filter((_, index) => !dropped.has(index));
	};
	const pasteDrops = smallestFit(pasteOrder.length, (k) => tokensOf(dropPasteAt(k), elided + k) <= tokenBudget);
	records = dropPasteAt(pasteDrops);
	elided += pasteDrops;
	if (tokensOf(records, elided) <= tokenBudget) return { generation: ledger.generation, records, elided };

	// Stage 3: drop oldest, whatever its length.
	const dropOldestAt = (k: number): UserRequestRecord[] => records.slice(k);
	const oldestDrops = smallestFit(records.length, (k) => tokensOf(dropOldestAt(k), elided + k) <= tokenBudget);
	records = dropOldestAt(oldestDrops);
	elided += oldestDrops;
	return { generation: ledger.generation, records, elided };
}

/** Collect, merge and prune: the whole pipeline for one compaction. */
export function buildUserRequestLedger(options: {
	messages: readonly AgentMessage[];
	generation: number;
	previous?: UserRequestLedger;
	tokenBudget?: number;
}): UserRequestLedger {
	const collected = collectUserRequests(options.messages, options.generation);
	const merged = mergeUserRequests(options.previous, collected, options.generation);
	return pruneUserRequests(merged, options.tokenBudget ?? USER_REQUESTS_TOKEN_BUDGET);
}

/* -------------------------------------------------------------------------- */
/* Rendering and parsing                                                       */
/* -------------------------------------------------------------------------- */

interface WireRequest {
	g: number;
	s: number;
	k: UserRequestKind;
	r: number;
	t: string;
	x?: number;
}

function renderLine(record: UserRequestRecord): string {
	const wire: WireRequest = {
		g: record.generation,
		s: record.sequence,
		k: record.kind,
		r: record.repeats,
		t: record.text,
	};
	if (record.originalChars && record.originalChars > record.text.length) wire.x = record.originalChars;
	// `<` is JSON-escaped so a payload that quotes a block delimiter cannot end the
	// block early: the JSON parse restores it byte-exact, and a block written before
	// this rule still parses (JSON.parse accepts both spellings).
	return JSON.stringify(wire).replace(/</g, "\\u003c");
}

function renderBody(records: readonly UserRequestRecord[]): string {
	return records.map(renderLine).join("\n");
}

/** Render the block for a summary; an empty ledger renders nothing. */
export function renderUserRequests(ledger: {
	generation: number;
	records: readonly UserRequestRecord[];
	elided: number;
}): string {
	if (ledger.records.length === 0) return "";
	const attributes: Record<string, string | number> = {
		generation: ledger.generation,
		count: ledger.records.length,
	};
	if (ledger.elided > 0) attributes.elided = ledger.elided;
	return renderMachineBlock("user-requests", attributes, [BLOCK_HEADER, renderBody(ledger.records)].join("\n"));
}

/**
 * Recover a ledger from a rendered block.
 *
 * Fallback carry-forward for entries whose details were dropped. Malformed lines
 * are skipped: a corrupted block must not be able to fail a compaction.
 */
export function parseUserRequests(text: string): UserRequestLedger | undefined {
	const block = findMachineBlock(text, "user-requests");
	if (!block) return undefined;
	const generation = Number.parseInt(block.attributes.generation ?? "1", 10);
	const elided = Number.parseInt(block.attributes.elided ?? "0", 10);
	const records: UserRequestRecord[] = [];
	for (const line of block.body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let wire: WireRequest;
		try {
			wire = JSON.parse(trimmed) as WireRequest;
		} catch {
			continue;
		}
		if (!wire || typeof wire.t !== "string" || wire.t.length === 0) continue;
		records.push({
			text: wire.t,
			generation: Number.isFinite(wire.g) ? wire.g : generation,
			sequence: Number.isFinite(wire.s) ? wire.s : records.length,
			repeats: Number.isFinite(wire.r) ? Math.max(1, Math.trunc(wire.r)) : 1,
			originalChars: Number.isFinite(wire.x) ? Math.trunc(wire.x as number) : undefined,
			kind: wire.k === "bash" ? "bash" : "user",
		});
	}
	// The block states its own record count on the opening tag, and the check runs on the
	// block the anchored finder returned - after anchoring, never before. A truncated block
	// that reports nothing is the failure this parser exists to prevent, and a block whose
	// header was forged ahead of the real one cannot pass its own check first.
	checkMachineBlockSelfCount(block, "count", records.length);
	return {
		generation: Number.isFinite(generation) && generation > 0 ? generation : 1,
		records,
		elided: Number.isFinite(elided) && elided > 0 ? elided : 0,
	};
}

/** Recover a ledger from a compaction entry's details, when it carries one. */
export function userRequestLedgerFromDetails(details: unknown, generation: number): UserRequestLedger | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { userRequests?: unknown }).userRequests;
	if (!candidate || typeof candidate !== "object") return undefined;
	const typed = candidate as Partial<UserRequestLedger>;
	if (!Array.isArray(typed.records)) return undefined;
	const ledgerGeneration =
		Number.isFinite(typed.generation) && (typed.generation as number) > 0 ? (typed.generation as number) : generation;
	const records: UserRequestRecord[] = [];
	for (const record of typed.records) {
		if (!record || typeof record !== "object") continue;
		if (typeof record.text !== "string" || record.text.length === 0) continue;
		records.push({
			text: record.text,
			// A record without a stamp inherits the ledger's generation, not the one being
			// written: the two differ, and the stamp is provenance.
			generation: Number.isFinite(record.generation) ? record.generation : ledgerGeneration,
			sequence: Number.isFinite(record.sequence) ? record.sequence : records.length,
			repeats: Number.isFinite(record.repeats) ? Math.max(1, Math.trunc(record.repeats)) : 1,
			originalChars: Number.isFinite(record.originalChars) ? record.originalChars : undefined,
			kind: record.kind === "bash" ? "bash" : "user",
		});
	}
	return {
		generation:
			Number.isFinite(typed.generation) && (typed.generation as number) > 0
				? (typed.generation as number)
				: generation,
		records,
		elided: Number.isFinite(typed.elided) && (typed.elided as number) > 0 ? (typed.elided as number) : 0,
	};
}
