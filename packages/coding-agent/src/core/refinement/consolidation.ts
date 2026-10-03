/**
 * Consolidation pass (memory-recall-design.md stage 3): the callable merge
 * pass that shrinks the compact id+title index toward its byte cap.
 * `planHarnessConsolidation` proposes merge/delete/rename operations as a
 * dry-run (it never mutates the store); `applyHarnessConsolidation` executes an
 * explicit plan through `applyRefinementProposal`, so consolidation edits ride
 * the existing validation, rollback, and refinement-history machinery. The
 * index cap never blocks this path: consolidation operations only shrink or
 * rewrite index lines, which is exactly how an over-cap store gets back under
 * the cap. Parity: `HarnessState.plan_consolidation`/`apply_consolidation` in
 * prime-agent-runtime/src/rlm/harness.py build the identical plan for the
 * identical store.
 */

import { createHash } from "node:crypto";
import {
	applyRefinementProposal,
	DEFAULT_HARNESS_INDEX_MAX_BYTES,
	flattenIndexText,
	type HarnessEntry,
	type HarnessScope,
	type HarnessState,
	harnessIndexBytes,
	harnessIndexLineBytes,
	harnessSearchQueryTerms,
	type RefinementEdit,
	type RefinementKind,
	type RefinementResult,
} from "./refinement.js";

/**
 * Default merge threshold, above the write gate's 0.40 advisory: the
 * 2026-10-03 production histogram has an empty (0.40, 0.61) band and every
 * pair at 0.55+ is a true same-rule rewrite pair, so a suggested *action* list
 * (not an advisory) takes the high-precision side of the gap.
 * Evidence: docs/fork/evidence/harness-near-duplicate-write-gate.md.
 */
export const CONSOLIDATION_MERGE_MIN_SCORE = 0.55;
/** Contained bodies shorter than this are not worth a delete suggestion. */
export const CONSOLIDATION_STALE_MIN_CONTENT_CHARS = 40;
export const CONSOLIDATION_PLAN_VERSION = 1 as const;

const REFINEMENT_KINDS: readonly RefinementKind[] = ["prompt", "memory", "skill", "subagent"];

export interface ConsolidationMergeOperation {
	action: "merge";
	kind: RefinementKind;
	/** The cluster's canonical entry: most recently updated, then longest content. */
	targetId: string;
	/** Ids absorbed into the target and then deleted, in code-point order. */
	absorbIds: string[];
	title: string;
	content: string;
	path?: string;
	reason: string;
	/** The cluster's highest pair score. */
	score: number;
}

export interface ConsolidationDeleteOperation {
	action: "delete";
	kind: RefinementKind;
	id: string;
	/** `contained:<id>` (a survivor's normalized content fully contains this
	 * one) or `stale:<n>d` (last write older than the requested age). */
	reason: string;
}

export interface ConsolidationRenameOperation {
	action: "rename";
	kind: RefinementKind;
	id: string;
	title: string;
	reason: string;
	previousTitleChars: number;
}

export type ConsolidationOperation =
	| ConsolidationMergeOperation
	| ConsolidationDeleteOperation
	| ConsolidationRenameOperation;

export interface ConsolidationPlanOptions {
	kinds: RefinementKind[];
	mergeMinScore: number;
	staleDays?: number;
	staleMinContentChars: number;
	slimTitleChars?: number;
	indexMaxBytes: number;
}

export interface ConsolidationPlan {
	version: typeof CONSOLIDATION_PLAN_VERSION;
	/** Freshness token: apply refuses a plan whose store moved since planning. */
	storeDigest: string;
	options: ConsolidationPlanOptions;
	indexBytesBefore: number;
	indexBytesAfter: number;
	fitsCap: boolean;
	operations: ConsolidationOperation[];
	stats: { merges: number; absorbedEntries: number; staleDeletes: number; renames: number };
}

export interface ConsolidationOptions {
	kinds?: readonly RefinementKind[];
	mergeMinScore?: number;
	/** Age-based staleness in days; off by default. */
	staleDays?: number;
	staleMinContentChars?: number;
	/** Title slimming budget in code points; off by default (the digest's index
	 * layer already truncates its own rendering, so slimming the stored title is
	 * an explicit choice, not a side effect of a dry-run default). `<= 0` also
	 * disables the pass. */
	slimTitleChars?: number;
	indexMaxBytes?: number;
	/** ISO-8601 clock injection for the staleness pass; tests pin it. */
	now?: string;
}

export interface ApplyConsolidationOptions {
	id?: string;
	scope?: HarnessScope;
	/** Passed through to applyRefinementProposal; consolidation edits never grow
	 * the index, so they pass the gate even on an over-cap store. */
	enforceIndexCap?: boolean;
	/** Apply even when the store moved since the plan was built. */
	allowStalePlan?: boolean;
}

/**
 * Locale-independent code-point order, identical to Python's `sorted(str)`
 * (UTF-8 byte order preserves code-point order). The consolidation passes use
 * it instead of refinement.ts's code-unit comparator so both faces produce the
 * identical plan for astral-plane ids/terms too.
 */
function compareUtf8(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function codePointLength(text: string): number {
	return Array.from(text).length;
}

/** Entries with non-string id/title/content are left untouched (the digest
 * already skips them with a diagnostic; the Python face never loads them). */
function isPlannableEntry(entry: HarnessEntry): boolean {
	return typeof entry.id === "string" && typeof entry.title === "string" && typeof entry.content === "string";
}

function consolidationRecency(entry: HarnessEntry): string {
	const updated = entry.updated_at;
	if (typeof updated === "string" && updated.length > 0) return updated;
	const created = entry.created_at;
	return typeof created === "string" ? created : "";
}

/**
 * Plan-apply freshness token: sha256 over (kind, id, version, updated_at).
 * Kinds iterate in the fixed kind order and ids in code-point order;
 * `_harness_store_digest` in harness.py computes the identical string.
 */
export function harnessStoreDigest(state: HarnessState): string {
	const lines: string[] = [];
	for (const kind of REFINEMENT_KINDS) {
		const records = state.entries[kind];
		for (const id of Object.keys(records).sort(compareUtf8)) {
			const entry = records[id];
			const updated = typeof entry.updated_at === "string" ? entry.updated_at : "";
			const version = typeof entry.version === "number" ? entry.version : 0;
			lines.push(`${kind}\0${id}\0${version}\0${updated}`);
		}
	}
	return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export interface HarnessSimilarityPair {
	idA: string;
	idB: string;
	score: number;
}

/**
 * All entry pairs at `minScore` or better, by idf-weighted cosine over
 * title+content. Batch twin of `nearDuplicateMemoryMatches`: same tokenizer,
 * same idf, same cosine. Term iteration is in code-point order so the
 * summation order — and therefore the exact float scores — is reproducible
 * across the TS and Python faces; the output sorts by (-score, idA, idB).
 */
export function harnessEntrySimilarityPairs(
	entries: readonly HarnessEntry[],
	minScore: number,
): HarnessSimilarityPair[] {
	const usable = entries.filter(isPlannableEntry).sort((a, b) => compareUtf8(a.id, b.id));
	if (usable.length < 2) return [];
	const profiles = new Map<string, Set<string>>();
	for (const entry of usable) {
		profiles.set(entry.id, new Set(harnessSearchQueryTerms(`${entry.title} ${entry.content}`)));
	}
	const documentFrequency = new Map<string, number>();
	for (const profile of profiles.values()) {
		for (const term of profile) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
	}
	const idf = new Map<string, number>();
	for (const [term, count] of documentFrequency) {
		idf.set(term, Math.log(1 + usable.length / count));
	}
	const norms = new Map<string, number>();
	for (const entry of usable) {
		let sum = 0;
		for (const term of [...(profiles.get(entry.id) ?? new Set<string>())].sort(compareUtf8)) {
			sum += (idf.get(term) ?? 1) ** 2;
		}
		norms.set(entry.id, Math.sqrt(sum));
	}
	const inverted = new Map<string, string[]>();
	for (const entry of usable) {
		for (const term of profiles.get(entry.id) ?? []) {
			const list = inverted.get(term);
			if (list) list.push(entry.id);
			else inverted.set(term, [entry.id]);
		}
	}
	const dots = new Map<string, Map<string, number>>();
	for (const term of [...inverted.keys()].sort(compareUtf8)) {
		const ids = inverted.get(term)!;
		if (ids.length < 2) continue;
		const weight = (idf.get(term) ?? 1) ** 2;
		for (let i = 0; i < ids.length; i += 1) {
			for (let j = i + 1; j < ids.length; j += 1) {
				const inner = dots.get(ids[i]) ?? new Map<string, number>();
				inner.set(ids[j], (inner.get(ids[j]) ?? 0) + weight);
				dots.set(ids[i], inner);
			}
		}
	}
	const pairs: HarnessSimilarityPair[] = [];
	for (const [idA, inner] of dots) {
		for (const [idB, dot] of inner) {
			const denominator = (norms.get(idA) ?? 0) * (norms.get(idB) ?? 0);
			if (denominator === 0) continue;
			const score = dot / denominator;
			if (score >= minScore) pairs.push({ idA, idB, score });
		}
	}
	pairs.sort((a, b) => b.score - a.score || compareUtf8(a.idA, b.idA) || compareUtf8(a.idB, b.idB));
	return pairs;
}

/** Cluster members, canonical first: most recently updated, then longest
 * content (code points), then smallest id. harness.py uses the identical key. */
function canonicalOrder(memberIds: readonly string[], byId: Map<string, HarnessEntry>): string[] {
	const ordered = [...memberIds].sort(compareUtf8);
	ordered.sort((a, b) => {
		const entryA = byId.get(a)!;
		const entryB = byId.get(b)!;
		const recency = compareUtf8(consolidationRecency(entryB), consolidationRecency(entryA));
		if (recency !== 0) return recency;
		return codePointLength(entryB.content) - codePointLength(entryA.content);
	});
	return ordered;
}

const MERGE_PIECE_DELIMITERS = new Set(["。", "！", "？", "；", "!", "?", "\n"]);
// Spans whose delimiter characters are not sentence boundaries: fenced code
// blocks (their newlines), inline code, and http(s) URLs (query `?`, `!`).
// CJK sentence punctuation is excluded from the URL tail so a `！` right after
// a link still ends the piece. Branch order matters: fenced before inline, or
// the fence's own backticks would match as inline code. harness.py's
// `_MERGE_PIECE_PROTECT` uses the identical patterns in the identical order.
const MERGE_PIECE_PROTECT = /```[\s\S]*?```|`[^`\n]*`|https?:\/\/[^\s。！？；]+/g;

/** Sentence-ish pieces for the merge appendix; URLs and code stay whole. */
function mergePieces(text: string): string[] {
	const pieces: string[] = [];
	let current = "";
	const flush = () => {
		const piece = current.trim();
		if (piece.length > 0) pieces.push(piece);
		current = "";
	};
	const feed = (segment: string) => {
		for (const char of segment) {
			if (MERGE_PIECE_DELIMITERS.has(char)) flush();
			else current += char;
		}
	};
	let cursor = 0;
	for (const match of text.matchAll(MERGE_PIECE_PROTECT)) {
		feed(text.slice(cursor, match.index));
		current += match[0];
		cursor = match.index + match[0].length;
	}
	feed(text.slice(cursor));
	flush();
	return pieces;
}

/** Canonical body plus each absorbed entry's unique sentences as a bullet
 * appendix, in recency order. Exact duplicate sentences are dropped, so a pure
 * rewrite merge keeps the canonical body verbatim. Deterministic; harness.py
 * builds the identical string. */
function mergedContent(canonical: HarnessEntry, absorbed: readonly HarnessEntry[]): string {
	const seen = new Set(mergePieces(canonical.content));
	const extras: string[] = [];
	for (const entry of absorbed) {
		for (const piece of mergePieces(entry.content)) {
			if (!seen.has(piece)) {
				seen.add(piece);
				extras.push(piece);
			}
		}
	}
	if (extras.length === 0) return canonical.content;
	return `${canonical.content}\n\n合并补充：\n${extras.map((piece) => `- ${piece}`).join("\n")}`;
}

/** Whitespace-collapsed lowercase for the containment check; toLowerCase (not
 * casefold) matches the Python face's lower(). */
function containmentText(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Code-point-capped title in the digest index line's own convention:
 * `maxChars - 3` code points plus an ellipsis, so the stored title renders
 * byte-identically to the truncated face it replaces and never grows the line
 * (120 CJK code points would outweigh 117 + "..."). */
function slimTitle(flatTitle: string, maxChars: number): string {
	const chars = Array.from(flatTitle);
	if (chars.length <= maxChars) return flatTitle;
	if (maxChars <= 3) return chars.slice(0, maxChars).join("").trimEnd();
	return `${chars
		.slice(0, maxChars - 3)
		.join("")
		.trimEnd()}...`;
}

function ageInDays(timestamp: string, nowMs: number): number | undefined {
	const ms = Date.parse(timestamp);
	return Number.isNaN(ms) ? undefined : (nowMs - ms) / 86_400_000;
}

const KIND_ORDER = new Map<string, number>(REFINEMENT_KINDS.map((kind, index) => [kind, index]));

function operationId(operation: ConsolidationOperation): string {
	return operation.action === "merge" ? operation.targetId : operation.id;
}

function compareOperations(a: ConsolidationOperation, b: ConsolidationOperation): number {
	return (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0) || compareUtf8(operationId(a), operationId(b));
}

/**
 * Propose merge/delete/rename operations that shrink the id+title index.
 * Dry-run: the store is only read. Three passes run per kind, each skipping
 * entries an earlier pass already removed:
 *
 * 1. merge: near-duplicate clusters (the write gate's tokenizer/idf/cosine in
 *    batch form) at `mergeMinScore` or better fold into their most recently
 *    updated member; the absorbed entries' unique sentences move into the
 *    canonical body as a bullet appendix. A merge target is itself never a
 *    delete candidate: the later passes read the pre-merge store, so without
 *    the shield a containment or age check would delete the entry the merge
 *    just wrote into.
 * 2. delete: stale entries — either fully contained in a surviving entry's
 *    normalized content, or older than `staleDays` (off by default).
 * 3. rename: titles longer than `slimTitleChars` code points slim to the cap
 *    (off by default).
 */
export function planHarnessConsolidation(state: HarnessState, options: ConsolidationOptions = {}): ConsolidationPlan {
	const kinds = [...(options.kinds ?? (["memory"] as const))];
	for (const kind of kinds) {
		if (!KIND_ORDER.has(kind)) {
			throw new Error(`unknown harness kind ${String(kind)}; expected one of ${REFINEMENT_KINDS.join(", ")}`);
		}
	}
	const mergeMinScore = options.mergeMinScore ?? CONSOLIDATION_MERGE_MIN_SCORE;
	if (!(mergeMinScore >= 0 && mergeMinScore <= 1)) {
		throw new Error(`mergeMinScore must be in [0, 1], got ${mergeMinScore}`);
	}
	const staleMinContentChars = options.staleMinContentChars ?? CONSOLIDATION_STALE_MIN_CONTENT_CHARS;
	const slimTitleChars = options.slimTitleChars;
	const indexMaxBytes = options.indexMaxBytes ?? DEFAULT_HARNESS_INDEX_MAX_BYTES;
	const nowMs = options.now === undefined ? Date.now() : Date.parse(options.now);
	if (Number.isNaN(nowMs)) {
		throw new Error(`now must be an ISO-8601 timestamp, got ${options.now}`);
	}

	const mergeOps: ConsolidationMergeOperation[] = [];
	const staleOps: ConsolidationDeleteOperation[] = [];
	const renameOps: ConsolidationRenameOperation[] = [];
	// Ids removed by an earlier pass (merge absorption or a stale delete) must
	// not be targeted again by a later one.
	const removed = new Map<RefinementKind, Set<string>>();
	for (const kind of REFINEMENT_KINDS) removed.set(kind, new Set());
	// Merge targets keep their entries: passes 2-3 read the pre-merge store, so
	// a containment or age check would otherwise delete the canonical right
	// after the merge wrote the absorbed content into it. A target still counts
	// as a containment *container*: its merged body only grows, so what the
	// original contains stays contained.
	const mergeTargets = new Map<RefinementKind, Set<string>>();
	for (const kind of REFINEMENT_KINDS) mergeTargets.set(kind, new Set());

	// Pass 1: near-duplicate merges.
	for (const kind of kinds) {
		const entries = Object.values(state.entries[kind]).filter(isPlannableEntry);
		if (entries.length < 2) continue;
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const pairs = harnessEntrySimilarityPairs(entries, mergeMinScore);
		if (pairs.length === 0) continue;
		const parent = new Map<string, string>();
		const find = (id: string): string => {
			let root = id;
			while (parent.get(root) !== root) root = parent.get(root)!;
			let current = id;
			while (parent.get(current) !== root) {
				const next = parent.get(current)!;
				parent.set(current, root);
				current = next;
			}
			return root;
		};
		for (const pair of pairs) {
			if (!parent.has(pair.idA)) parent.set(pair.idA, pair.idA);
			if (!parent.has(pair.idB)) parent.set(pair.idB, pair.idB);
			const rootA = find(pair.idA);
			const rootB = find(pair.idB);
			if (rootA !== rootB) parent.set(rootA, rootB);
		}
		const clusters = new Map<string, string[]>();
		for (const id of parent.keys()) {
			const root = find(id);
			const list = clusters.get(root);
			if (list) list.push(id);
			else clusters.set(root, [id]);
		}
		const clusterScores = new Map<string, number>();
		for (const pair of pairs) {
			const root = find(pair.idA);
			clusterScores.set(root, Math.max(clusterScores.get(root) ?? 0, pair.score));
		}
		for (const memberIds of clusters.values()) {
			if (memberIds.length < 2) continue;
			const ordered = canonicalOrder(memberIds, byId);
			const canonical = byId.get(ordered[0])!;
			const absorbed = ordered.slice(1).map((id) => byId.get(id)!);
			// absorbIds is sorted for a stable op list; the content union walks
			// the absorbed entries in recency order instead.
			mergeOps.push({
				action: "merge",
				kind,
				targetId: canonical.id,
				absorbIds: absorbed.map((entry) => entry.id).sort(compareUtf8),
				title: canonical.title,
				content: mergedContent(canonical, absorbed),
				...(typeof canonical.path === "string" ? { path: canonical.path } : {}),
				reason: "near-duplicate cluster",
				score: clusterScores.get(find(ordered[0])) ?? 0,
			});
			for (const entry of absorbed) removed.get(kind)!.add(entry.id);
			mergeTargets.get(kind)!.add(canonical.id);
		}
	}

	// Pass 2: stale deletes - containment first, then age.
	for (const kind of kinds) {
		const survivors = Object.keys(state.entries[kind])
			.filter((id) => !removed.get(kind)!.has(id))
			.sort(compareUtf8)
			.map((id) => state.entries[kind][id])
			.filter(isPlannableEntry);
		if (survivors.length === 0) continue;
		const marked = new Map<string, string>();
		if (staleMinContentChars > 0 && survivors.length >= 2) {
			const texts = new Map(survivors.map((entry) => [entry.id, containmentText(entry.content)]));
			const profiles = new Map(
				survivors.map((entry) => [entry.id, new Set(harnessSearchQueryTerms(`${entry.title} ${entry.content}`))]),
			);
			const documentFrequency = new Map<string, number>();
			for (const profile of profiles.values()) {
				for (const term of profile) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
			}
			const inverted = new Map<string, string[]>();
			for (const entry of survivors) {
				for (const term of profiles.get(entry.id) ?? []) {
					const list = inverted.get(term);
					if (list) list.push(entry.id);
					else inverted.set(term, [entry.id]);
				}
			}
			for (const entry of survivors) {
				if (mergeTargets.get(kind)!.has(entry.id)) continue;
				const text = texts.get(entry.id)!;
				if (codePointLength(text) < staleMinContentChars) continue;
				// Probe with the entry's rarest SHARED term: a contained entry
				// shares every content term with its container, while a
				// title-only term with df 1 would skip the check entirely.
				const shared = [...(profiles.get(entry.id) ?? [])]
					.filter((term) => (documentFrequency.get(term) ?? 0) >= 2)
					.sort(compareUtf8);
				shared.sort((a, b) => (documentFrequency.get(a) ?? 0) - (documentFrequency.get(b) ?? 0));
				const rarest = shared[0];
				if (rarest === undefined) continue;
				for (const otherId of inverted.get(rarest) ?? []) {
					if (otherId === entry.id || marked.has(otherId)) continue;
					const otherText = texts.get(otherId)!;
					if (codePointLength(otherText) > codePointLength(text) && otherText.includes(text)) {
						marked.set(entry.id, `contained:${otherId}`);
						break;
					}
				}
			}
		}
		if (options.staleDays !== undefined) {
			for (const entry of survivors) {
				if (marked.has(entry.id) || mergeTargets.get(kind)!.has(entry.id)) continue;
				const recency = consolidationRecency(entry);
				const age = recency ? ageInDays(recency, nowMs) : undefined;
				if (age !== undefined && age > options.staleDays) {
					marked.set(entry.id, `stale:${Math.floor(age)}d`);
				}
			}
		}
		for (const [id, reason] of [...marked.entries()].sort((a, b) => compareUtf8(a[0], b[0]))) {
			staleOps.push({ action: "delete", kind, id, reason });
			removed.get(kind)!.add(id);
		}
	}

	// Pass 3: title slimming renames.
	if (slimTitleChars !== undefined && slimTitleChars > 0) {
		for (const kind of kinds) {
			for (const id of Object.keys(state.entries[kind]).sort(compareUtf8)) {
				if (removed.get(kind)!.has(id)) continue;
				const entry = state.entries[kind][id];
				if (typeof entry.title !== "string") continue;
				const flat = flattenIndexText(entry.title);
				const flatChars = Array.from(flat);
				if (flatChars.length <= slimTitleChars) continue;
				const slimmed = slimTitle(flat, slimTitleChars);
				if (!slimmed || slimmed === entry.title) continue;
				renameOps.push({
					action: "rename",
					kind,
					id,
					title: slimmed,
					reason: `title over ${slimTitleChars} chars`,
					previousTitleChars: flatChars.length,
				});
			}
		}
	}

	mergeOps.sort(compareOperations);
	staleOps.sort(compareOperations);
	renameOps.sort(compareOperations);
	const operations: ConsolidationOperation[] = [...mergeOps, ...staleOps, ...renameOps];

	const before = harnessIndexBytes(state);
	let after = before;
	for (const operation of operations) {
		if (operation.action === "merge") {
			for (const absorbId of operation.absorbIds) {
				after -= harnessIndexLineBytes(state.entries[operation.kind][absorbId]);
			}
		} else if (operation.action === "delete") {
			after -= harnessIndexLineBytes(state.entries[operation.kind][operation.id]);
		} else {
			const entry = state.entries[operation.kind][operation.id];
			after += harnessIndexLineBytes({ ...entry, title: operation.title }) - harnessIndexLineBytes(entry);
		}
	}
	const fitsCap = after <= indexMaxBytes;
	return {
		version: CONSOLIDATION_PLAN_VERSION,
		storeDigest: harnessStoreDigest(state),
		options: {
			kinds,
			mergeMinScore,
			staleDays: options.staleDays,
			staleMinContentChars,
			slimTitleChars,
			indexMaxBytes,
		},
		indexBytesBefore: before,
		indexBytesAfter: after,
		fitsCap,
		operations,
		stats: {
			merges: mergeOps.length,
			absorbedEntries: mergeOps.reduce((total, operation) => total + operation.absorbIds.length, 0),
			staleDeletes: staleOps.length,
			renames: renameOps.length,
		},
	};
}

/** The one-line summary both faces record as the refinement event trigger. */
export function consolidationSummary(plan: ConsolidationPlan): string {
	const verdict = plan.fitsCap ? "fits" : "still over";
	return (
		`Consolidation pass: ${plan.stats.merges} merges, ${plan.stats.staleDeletes} stale deletes, ` +
		`${plan.stats.renames} renames; index ${plan.indexBytesBefore} -> ${plan.indexBytesAfter} bytes ` +
		`(${verdict} the ${plan.options.indexMaxBytes}-byte cap).`
	);
}

/** Mint a consolidation id in the canonical `consolidate_<timestamp>` format. */
export function generateConsolidationId(): string {
	return `consolidate_${new Date()
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 17)}`;
}

/**
 * Execute a plan from `planHarnessConsolidation`. Explicit by construction:
 * the planner never writes, and this refuses a plan whose store digest no
 * longer matches (`allowStalePlan` overrides). The plan maps to ordinary
 * refinement edits and runs through `applyRefinementProposal`, so validation,
 * before/after snapshots (rollback), and the refinement-history event all come
 * from the existing machinery. Persisting the result stays the caller's choice
 * (`persistAppliedRefinement`), exactly like a /refine apply.
 */
export function applyHarnessConsolidation(
	state: HarnessState,
	plan: ConsolidationPlan,
	options: ApplyConsolidationOptions = {},
): RefinementResult {
	if (!options.allowStalePlan && harnessStoreDigest(state) !== plan.storeDigest) {
		throw new Error(
			"consolidation plan is stale: the store changed since the plan was built; " +
				"re-run planHarnessConsolidation (or pass allowStalePlan to apply anyway)",
		);
	}
	const edits: RefinementEdit[] = [];
	for (const operation of plan.operations) {
		if (operation.action === "merge") {
			edits.push({
				action: "update",
				kind: operation.kind,
				id: operation.targetId,
				title: operation.title,
				content: operation.content,
				...(operation.path !== undefined ? { path: operation.path } : {}),
				reason: operation.reason,
			});
			for (const absorbId of operation.absorbIds) {
				edits.push({
					action: "delete",
					kind: operation.kind,
					id: absorbId,
					reason: `consolidation merge into ${operation.targetId}`,
				});
			}
		} else if (operation.action === "delete") {
			edits.push({ action: "delete", kind: operation.kind, id: operation.id, reason: operation.reason });
		} else {
			// Rename keeps the entry's content; hydrate it from the current store
			// (a vanished entry fails validation with a clear message instead of
			// being half-applied).
			const current = state.entries[operation.kind][operation.id];
			edits.push({
				action: "update",
				kind: operation.kind,
				id: operation.id,
				title: operation.title,
				content: typeof current?.content === "string" ? current.content : undefined,
				reason: operation.reason,
			});
		}
	}
	const result = applyRefinementProposal(
		state,
		{
			summary: consolidationSummary(plan),
			rationale: "consolidation plan apply",
			expectedOutcome: `index ${plan.indexBytesBefore} -> ${plan.indexBytesAfter} bytes`,
			edits,
		},
		{
			id: options.id ?? generateConsolidationId(),
			scope: options.scope,
			indexMaxBytes: plan.options.indexMaxBytes,
			enforceIndexCap: options.enforceIndexCap,
		},
	);
	if (!result.appliedEdits.some((edit) => edit.applied)) {
		// Match the kernel face: an apply that landed nothing records no event.
		state.refinements.pop();
	}
	return result;
}
