import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { BoundedCache } from "../utils/bounded-cache.js";
import type { RlmChildAgentStatus } from "./agent-session.js";
import { calculateContextTokens, estimateContextTokens } from "./compaction/index.js";
import type { ContextUsage } from "./extensions/index.js";
import { buildSessionContext, type FileEntry, loadEntriesFromFile, type SessionEntry } from "./session-manager.js";
import { addAssistantUsage, addUsageDelta, cloneUsage, emptyUsage, subtractAssistantUsage } from "./usage.js";

/** Resolves a model's context window so disk-only nodes can report utilization. */
export type ContextWindowResolver = (provider: string, modelId: string) => number | undefined;

/**
 * One agent in the context overview: the main session or an RLM (sub-)agent.
 * `ownUsage` excludes descendants; `totalUsage` includes completed descendants, matching /usage.
 */
export interface ContextTreeNode {
	/** "root" for the session itself; sub-xxxx for an RLM child. */
	id: string;
	label: string;
	status: "active" | RlmChildAgentStatus;
	model?: { provider: string; id: string };
	ownUsage: Usage;
	totalUsage: Usage;
	contextUsage?: ContextUsage;
	children: ContextTreeNode[];
	/**
	 * What the on-disk scan left out, present only when it left something out.
	 *
	 * A `/context` roster is built from several scans (this session's persisted
	 * children plus each live child's), and every one of them is budgeted. When a
	 * budget bites, the tree is partial, and a partial tree that does not say so
	 * reads as "these are all the agents". The counts ride the node instead of a
	 * side channel so the renderer - and any client that gets the tree over the
	 * daemon wire - can say how much is missing. Absent when nothing was skipped,
	 * and absent on an older daemon's response, so a client that does not know the
	 * field renders exactly what it did before.
	 */
	scan?: ContextTreeScanDiagnostics;
}

function isAssistantEntry(entry: SessionEntry): entry is SessionEntry & {
	type: "message";
	message: AssistantMessage;
} {
	return entry.type === "message" && entry.message.role === "assistant";
}

function readUserMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function compactLabel(text: string, maxLength = 80): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/**
 * Usage totals for one agent: `totalUsage` sums the assistant usage of every
 * entry (attributed aggregates, so descendants are included), `ownUsage`
 * removes the attributions targeting those assistants.
 *
 * Callers that display spend pass the whole transcript as both arguments
 * (`computeOwnAndTotalUsage(entries, entries)`), which is the persistent basis:
 * the same fold `getOwnUsageSummary` and the on-disk catalog scan use, so a
 * session's spend reads the same in `/context`, in the session rows, and on
 * disk. That basis is deliberately cumulative across compactions AND across
 * branches: compaction and rollback shrink the model-facing context, not what
 * the session has spent, so entries dropped from the resolved context still
 * count here. Passing a narrower entry list (a branch) measures the entries
 * given, not the session, and is only for callers that want that subset.
 */
/**
 * Incremental form of {@link computeOwnAndTotalUsage} for a session that keeps appending.
 *
 * The totals are linear in the entries, so a live session can fold each new entry once
 * instead of re-walking a transcript that only grows: a busy turn republishes the roster
 * many times, and every republication used to recompute both passes over every entry the
 * session had ever written.
 *
 * An attribution that arrives before the assistant it targets is held until that assistant
 * appears, so the result matches the whole-file computation regardless of arrival order.
 */
export class OwnUsageAccumulator {
	private totalUsage: Usage = emptyUsage();
	private ownUsage: Usage = emptyUsage();
	/** Assistants whose usage the branch counted, i.e. the targets an attribution may subtract from. */
	private readonly countedAssistantIds = new Set<string>();
	/**
	 * The usage this fold has counted for each assistant. `appendChildUsageAttribution`
	 * rewrites a target assistant's `message.usage` in place to the aggregate right
	 * before appending the attribution entry, and a target the cursor already passed
	 * is not re-read: the rewrite arrives as a delta against the recorded value, so
	 * the incremental fold stays equal to the whole-file refold, which reads the
	 * rewritten usage.
	 */
	private readonly countedAssistantUsage = new Map<string, Usage>();
	/** Attributions that arrived before their target; applied when the target is counted. */
	private readonly pendingAttributions = new Map<string, Usage[]>();
	private processed = 0;
	/** The entry the cursor stopped at, so a caller that comes back with a different array is seen. */
	private lastTail: SessionEntry | undefined;

	get processedCount(): number {
		return this.processed;
	}

	/**
	 * Fold every entry past the one already consumed. Same entries in, same totals out.
	 *
	 * "Same entries" means the array only ever grows at the back. A caller that comes back with a
	 * shorter array, or with a different entry where the cursor stopped, is asking about a
	 * transcript that no longer exists: a failed append rolls its entry back and the retry pushes
	 * a new one at the same length. Rather than keep reporting the rolled-back spend, the fold
	 * restarts over the array actually present. It restarts instead of throwing because the only
	 * caller publishes session rows and /usage for the UI, and a bookkeeping reset that a session
	 * recovers from on its own must not take the roster down.
	 */
	add(entries: readonly SessionEntry[]): { ownUsage: Usage; totalUsage: Usage } {
		if (!this.foldedPrefixIsIntact(entries)) this.restart();
		for (let index = this.processed; index < entries.length; index++) {
			const entry = entries[index];
			if (!entry) continue;
			if (isAssistantEntry(entry)) {
				addAssistantUsage(this.totalUsage, entry.message.usage);
				addAssistantUsage(this.ownUsage, entry.message.usage);
				this.countedAssistantIds.add(entry.id);
				this.countedAssistantUsage.set(entry.id, cloneUsage(entry.message.usage));
				const pending = this.pendingAttributions.get(entry.id);
				if (pending !== undefined) {
					for (const usage of pending) subtractAssistantUsage(this.ownUsage, usage);
					this.pendingAttributions.delete(entry.id);
				}
				continue;
			}
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
				addAssistantUsage(this.totalUsage, entry.usage);
				addAssistantUsage(this.ownUsage, entry.usage);
				continue;
			}
			if (entry.type === "child_usage_attributed") {
				if (this.countedAssistantIds.has(entry.targetId)) {
					// The attribution rewrites the target assistant's usage in place
					// to `aggregateUsage` before this entry is appended, and a target
					// behind the cursor was folded with its pre-rewrite usage. Apply
					// the rewrite as a delta against what this fold counted, then
					// subtract the child share, so the incremental result equals the
					// whole-file refold over the rewritten transcript.
					// Transcripts predating `aggregateUsage` on the attribution entry carry
					// no rewrite either (the loader only rewrites from a present aggregate),
					// so a missing aggregate falls back to the plain child subtraction.
					const counted = this.countedAssistantUsage.get(entry.targetId);
					const aggregate = entry.aggregateUsage;
					if (counted !== undefined && aggregate !== undefined) {
						addUsageDelta(this.totalUsage, aggregate, counted);
						addUsageDelta(this.ownUsage, aggregate, counted);
						this.countedAssistantUsage.set(entry.targetId, cloneUsage(aggregate));
					}
					subtractAssistantUsage(this.ownUsage, entry.childUsage);
				} else {
					const pending = this.pendingAttributions.get(entry.targetId);
					if (pending === undefined) this.pendingAttributions.set(entry.targetId, [entry.childUsage]);
					else pending.push(entry.childUsage);
				}
			}
		}
		this.processed = entries.length;
		this.lastTail = entries.at(-1);
		return { ownUsage: cloneUsage(this.ownUsage), totalUsage: cloneUsage(this.totalUsage) };
	}

	/**
	 * Whether everything already folded is still the prefix of `entries`. Identity of the
	 * entry the cursor stopped at covers both shapes of the break: a shorter array and an entry
	 * replaced at the same length.
	 */
	private foldedPrefixIsIntact(entries: readonly SessionEntry[]): boolean {
		if (this.processed === 0) return true;
		return entries.length >= this.processed && entries[this.processed - 1] === this.lastTail;
	}

	private restart(): void {
		this.totalUsage = emptyUsage();
		this.ownUsage = emptyUsage();
		this.countedAssistantIds.clear();
		this.countedAssistantUsage.clear();
		this.pendingAttributions.clear();
		this.processed = 0;
		this.lastTail = undefined;
	}
}

export function computeOwnAndTotalUsage(
	branch: SessionEntry[],
	allEntries: SessionEntry[],
): { ownUsage: Usage; totalUsage: Usage } {
	const totalUsage = emptyUsage();
	const branchAssistantIds = new Set<string>();
	for (const entry of branch) {
		if (isAssistantEntry(entry)) {
			branchAssistantIds.add(entry.id);
			addAssistantUsage(totalUsage, entry.message.usage);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			addAssistantUsage(totalUsage, entry.usage);
		}
	}
	const ownUsage = cloneUsage(totalUsage);
	for (const entry of allEntries) {
		if (entry.type === "child_usage_attributed" && branchAssistantIds.has(entry.targetId)) {
			subtractAssistantUsage(ownUsage, entry.childUsage);
		}
	}
	return { ownUsage, totalUsage };
}

/**
 * Current context utilization from persisted entries, mirroring
 * AgentSession.getContextUsage(): unknown right after a compaction until the
 * next assistant response, otherwise the last assistant usage plus an
 * estimate for trailing messages (tool results, queued user input) that have
 * not hit the model yet.
 */
function computeContextUsageFromEntries(
	allEntries: SessionEntry[],
	branch: SessionEntry[],
	contextWindow: number | undefined,
): ContextUsage | undefined {
	if (!contextWindow || contextWindow <= 0) {
		return undefined;
	}

	let latestCompactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			latestCompactionIndex = i;
			break;
		}
	}

	if (latestCompactionIndex >= 0) {
		let hasPostCompactionUsage = false;
		for (let i = branch.length - 1; i > latestCompactionIndex; i--) {
			const entry = branch[i];
			if (!isAssistantEntry(entry)) {
				continue;
			}
			const assistant = entry.message;
			if (assistant.stopReason === "aborted" || assistant.stopReason === "error") {
				continue;
			}
			if (calculateContextTokens(assistant.usage) > 0) {
				hasPostCompactionUsage = true;
			}
			break;
		}
		if (!hasPostCompactionUsage) {
			return { tokens: null, contextWindow, percent: null };
		}
	}

	const estimate = estimateContextTokens(buildSessionContext(allEntries).messages);
	if (estimate.tokens <= 0) {
		return undefined;
	}
	return { tokens: estimate.tokens, contextWindow, percent: (estimate.tokens / contextWindow) * 100 };
}

function sessionEntriesFromFile(file: string): SessionEntry[] {
	return loadEntriesFromFile(file).filter((entry: FileEntry): entry is SessionEntry => entry.type !== "session");
}

/**
 * Entries on the current branch, root to leaf, mirroring
 * SessionManager.getBranch(): the leaf is the last appended entry and the
 * branch is its parentId chain. This is what a disk node reports for
 * model-facing quantities - the label, the model, and context utilization -
 * because those describe the branch the session would resume on, not the whole
 * file. Spend is not one of them: it is cumulative across branches, so it is
 * folded over every entry (see {@link computeOwnAndTotalUsage}).
 */
function branchEntries(entries: SessionEntry[]): SessionEntry[] {
	if (entries.length === 0) {
		return [];
	}
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = entries[entries.length - 1];
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

/**
 * Terminal status for a persisted child, inferred from how its last assistant
 * turn ended: errored and aborted runs should not render as successful.
 */
function statusFromBranch(entries: SessionEntry[]): "done" | "error" | "cancelled" {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!isAssistantEntry(entry)) {
			continue;
		}
		if (entry.message.stopReason === "error") {
			return "error";
		}
		if (entry.message.stopReason === "aborted") {
			return "cancelled";
		}
		return "done";
	}
	return "done";
}

/** A child session's newest transcript, with its stat identity so a scan can budget and reuse it. */
interface SessionFile {
	path: string;
	size: number;
	/** `mtimeMs` of the file as stat'ed by the scan; the identity half of the read cache's key. */
	mtimeMs: number;
}

function findSessionFile(dir: string): SessionFile | undefined {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		// The dir is gone (a cleaned-up child, retention, a hand-deleted tree): nothing
		// persisted here, which is not a failed scan. A tray refresh must not break
		// because one sub-agent's directory disappeared underneath it.
		return undefined;
	}
	let newest: { path: string; mtime: number; size: number } | undefined;
	for (const name of names) {
		if (!name.endsWith(".jsonl")) {
			continue;
		}
		const path = join(dir, name);
		try {
			const stats = statSync(path);
			if (!newest || stats.mtime.getTime() > newest.mtime) {
				newest = { path, mtime: stats.mtime.getTime(), size: stats.size };
			}
		} catch {
			// Skip unreadable files.
		}
	}
	return newest && { path: newest.path, size: newest.size, mtimeMs: newest.mtime };
}

/**
 * The `sub-*` dirs under an RLM session dir, **newest first**.
 *
 * The order is the budget's eviction policy: the walk consumes this list in
 * order and stops opening transcripts once a limit bites, so whichever end of
 * the listing comes last is what a truncated `/context` loses. Newest-first
 * keeps the agents that were active most recently - the ones a user is asking
 * about - and drops the oldest branches, which `skippedByBudget` then reports.
 * The previous ascending order did the opposite: on the measured 544-child
 * directory it showed the 256 *oldest* children and silently lost every recent
 * one, i.e. the budget turned into "hide the live half of the roster".
 *
 * Each dir is stat'ed once instead of once per comparison, and ties fall back
 * to the path so one listing is deterministic.
 */
function listChildSessionDirs(rlmSessionDir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(rlmSessionDir);
	} catch {
		return [];
	}
	const candidates: { path: string; mtime: number }[] = [];
	for (const name of names) {
		if (!name.startsWith("sub-")) {
			continue;
		}
		const path = join(rlmSessionDir, name);
		try {
			const stats = statSync(path);
			if (stats.isDirectory()) {
				candidates.push({ path, mtime: stats.mtime.getTime() });
			}
		} catch {
			// Unreadable or already gone: not a candidate.
		}
	}
	candidates.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return candidates.map((candidate) => candidate.path);
}

/**
 * The fingerprint `dir` should be keyed by, memoized for the duration of one scan.
 *
 * `memory` is created per {@link scanChildrenInto} call and never outlives it, so the memo
 * can only save the duplicate pass inside a single scan - never a lookup against a
 * fingerprint the tree has since moved past. Without it (a one-off probe with no memo), the
 * fingerprint is taken as it always was.
 */
function subtreeFingerprint(
	dir: string,
	remainingDepth: number,
	maxVisible: number,
	memory?: Map<string, string>,
): string {
	if (!memory) {
		return fingerprintRlmSessionDir(dir, remainingDepth, maxVisible);
	}
	const memoKey = `${dir}#${remainingDepth}#${maxVisible}`;
	const remembered = memory.get(memoKey);
	if (remembered !== undefined) {
		return remembered;
	}
	const value = fingerprintRlmSessionDir(dir, remainingDepth, maxVisible);
	memory.set(memoKey, value);
	return value;
}

/**
 * Stat-only fingerprint of the part of the `sub-*` tree under an RLM session dir that a
 * scan of it can actually reach.
 *
 * The context tree rebuilt on every UI refresh comes from reading and folding the
 * transcripts under this dir, which is expensive (a 544-child dir measured 2.2s and
 * ~1.08GB of reads) and usually redundant: between two refreshes of the same
 * session, most of that tree has not moved. The fingerprint is what makes "has not
 * moved" decidable without reading a byte of it.
 *
 * Every dir contributes two segments, because they answer two different questions:
 *
 * - **Identity**: `name:mtimeMs:size` of *every* `sub-*` candidate, in the walk's own
 *   newest-first order. Which candidates a budget lets the scan read depends on that whole
 *   order - `listChildSessionDirs` sorts by dir mtime, and creating or removing a file
 *   inside a candidate moves it - so a candidate the scan refused still has to be covered,
 *   or a promoted one would be served from a subtree that never saw it. A refused
 *   candidate also reports whether it holds a transcript at all (`@?`), because that is
 *   what `skippedByBudget` counts and a user reads that count as "N more agents not shown".
 * - **Content**: for the first `maxVisible` candidates that hold a transcript, the newest
 *   transcript's identity (whose `mtimeMs` moves on any append) and the descent below it.
 *   This is the prefix a walk can consume, and nothing else: an append inside a candidate
 *   the budget refuses cannot change the answer, so it must not throw the subtree away.
 *
 * `maxVisible` is therefore the scan's own `maxChildren`, widened by the live ids the root
 * frame skips (those cost no budget but do occupy positions). The window counts
 * *transcript-bearing* candidates rather than positions, which is what makes it a superset
 * of the read set: a dir with no readable `.jsonl` costs the walk no budget either, so a
 * run of empty dirs pushes the reads further down the listing than `maxChildren` slots.
 * Covering more than the walk reads only invalidates too often, which is the safe direction;
 * covering less would serve a subtree the scan has since outgrown.
 *
 * `remainingDepth` mirrors the scan's own `maxDepth` cutoff: bytes below a depth the
 * scan would never visit are not fingerprinted either, so a cached subtree cannot be
 * reused past a change the scan was never going to see.
 */
function fingerprintRlmSessionDir(dir: string, remainingDepth: number, maxVisible: number): string {
	const parts: string[] = [];
	// `listed` carries the names a caller already read, so one listing of a child dir serves
	// both the transcript identity and the descent into it. The two used to be separate
	// `readdir` calls, which doubled the syscall count of every fingerprint - and a fingerprint
	// is paid on every reuse check as well as on every miss. `undefined` means "not listed
	// yet, read it here", which keeps the unreadable-dir branch below exactly as it was.
	const walk = (current: string, remaining: number, visible: number, listed?: string[]): void => {
		let names: string[];
		if (listed !== undefined) {
			names = listed;
		} else {
			try {
				names = readdirSync(current);
			} catch {
				// Unreadable or gone: the scan would list nothing here either.
				parts.push(`${current}?`);
				return;
			}
		}
		const candidates: { name: string; path: string; mtimeMs: number; size: number; mtime: number }[] = [];
		for (const name of names) {
			if (!name.startsWith("sub-")) {
				continue;
			}
			const path = join(current, name);
			let stats: ReturnType<typeof statSync>;
			try {
				stats = statSync(path);
			} catch {
				continue;
			}
			if (!stats.isDirectory()) {
				continue;
			}
			candidates.push({
				name,
				path,
				mtimeMs: stats.mtimeMs,
				size: stats.size,
				// The walk sorts on the ms-truncated mtime (see listChildSessionDirs), so the
				// window has to select on the same precision or the two would disagree about
				// which candidate sits on the boundary.
				mtime: stats.mtime.getTime(),
			});
		}
		candidates.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		let readable = 0;
		for (const candidate of candidates) {
			parts.push(`${candidate.name}:${candidate.mtimeMs}:${candidate.size}`);
			let childNames: string[] | undefined;
			try {
				childNames = readdirSync(candidate.path);
			} catch {
				// An unreadable child is not listable: the walk's findSessionFile fails on it too,
				// so it contributes neither a read nor a budget skip.
				childNames = undefined;
			}
			if (readable >= visible) {
				// Outside the read prefix. The listing is still read, because whether a refused
				// dir holds a transcript is what the walk charges to `skippedByBudget`, but
				// nothing below it can reach the answer.
				if (childNames?.some((name) => name.endsWith(".jsonl"))) {
					parts.push("@?");
				}
				continue;
			}
			const transcript =
				childNames === undefined ? undefined : newestTranscriptFingerprint(candidate.path, childNames);
			if (transcript) {
				parts.push(`@${transcript}`);
				readable++;
			}
			// A dir with no readable transcript is not queued by the walk either, so its own
			// subtree cannot reach the answer: descending into it would only invalidate the
			// parent over a change nothing reads.
			if (transcript !== undefined && remaining > 1) {
				walk(candidate.path, remaining - 1, visible, childNames);
			}
		}
	};
	walk(dir, Math.max(1, remainingDepth), Math.max(0, maxVisible));
	return parts.join("|");
}

/**
 * `name:mtimeMs:size` of the newest transcript in a dir, from a listing the caller already has,
 * or undefined when there is none.
 */
function newestTranscriptFingerprint(dir: string, names: string[]): string | undefined {
	let newest: { name: string; mtimeMs: number; size: number } | undefined;
	for (const name of names) {
		if (!name.endsWith(".jsonl")) {
			continue;
		}
		try {
			const stats = statSync(join(dir, name));
			if (!newest || stats.mtimeMs > newest.mtimeMs) {
				newest = { name, mtimeMs: stats.mtimeMs, size: stats.size };
			}
		} catch {
			// Skip unreadable files, exactly as findSessionFile does.
		}
	}
	return newest && `${newest.name}:${newest.mtimeMs}:${newest.size}`;
}

/** One transcript read this scan avoided or paid for, so a caller can report the difference. */
interface CachedScanCharge {
	scannedChildren: number;
	bytesRead: number;
	bytesPlanned: number;
	skippedByBudget: number;
	truncated: boolean;
	truncatedReason: ContextTreeTruncatedReason | undefined;
	depthLimitReached: boolean;
}

interface CachedContextNode {
	node: ContextTreeNode;
	/** The window the node's `contextUsage` was computed with; a different answer invalidates the entry. */
	modelWindow: number | undefined;
	hasModel: boolean;
}

interface CachedSubtree {
	nodes: ContextTreeNode[];
	charge: CachedScanCharge;
	/**
	 * `provider/id=window` for every distinct model in the subtree. A subtree is reused
	 * only while every one of them still resolves to the same window: `contextUsage`
	 * percentages are derived from the catalog, so a model whose window moved must be
	 * re-derived rather than served with the old denominator. Usually one to three
	 * entries, so the check is a handful of registry lookups per reuse.
	 */
	modelWindows: string;
}

/**
 * What one dir's reuse policy currently knows. Keyed by the pointer key (dir + call shape),
 * not by the fingerprint: the policy has to survive the fingerprint moving, that is the only
 * thing it observes.
 */
interface BusySubtreeState {
	/** Consecutive reuse checks that found nothing usable for this dir and shape. */
	misses: number;
	/** Walk this dir without a fingerprint until this instant; 0 when it is not bypassed. */
	cooldownUntil: number;
	/** The last reuse check was bypassed, so the walk behind it has no key to be stored under. */
	bypassed: boolean;
}

/**
 * Retained bytes of one cloned disk node, measured rather than guessed: storing one
 * 256-child roster and dividing the `--expose-gc` heap delta by the node count gives
 * ~640 bytes per node (the node object, its two `Usage` objects with their nested `cost`,
 * the optional `contextUsage`, the children array, and V8's per-object slack). The
 * estimate below charges that plus the two variable-length strings it actually holds, at
 * 2 bytes per char - V8 keeps ASCII at 1 and CJK at 2, and a label is user text, so 2 is
 * the conservative side of the truth. It is an estimate for a ceiling, not an account:
 * what matters is that it grows with what is retained, so a roster of long labels cannot
 * hide under a per-entry constant.
 */
const CACHE_NODE_BYTES = 640;
/** One cache record's own overhead (key string, record object, map slot). */
const CACHE_ENTRY_BYTES = 128;
const CACHE_BYTES_PER_CHAR = 2;

function estimateNodeBytes(node: ContextTreeNode): number {
	let bytes = CACHE_NODE_BYTES + CACHE_BYTES_PER_CHAR * (node.id.length + node.label.length);
	if (node.model) {
		bytes += CACHE_BYTES_PER_CHAR * (node.model.provider.length + node.model.id.length);
	}
	for (const child of node.children) {
		bytes += estimateNodeBytes(child);
	}
	return bytes;
}

function estimateSubtreeBytes(nodes: readonly ContextTreeNode[]): number {
	let bytes = CACHE_ENTRY_BYTES;
	for (const node of nodes) {
		bytes += estimateNodeBytes(node);
	}
	return bytes;
}

/** Ceilings and policy for {@link ContextTreeDiskScanCache}; omitted fields take these. */
export interface ContextTreeDiskScanCacheOptions {
	/** Ceiling on cached keys, per level (subtrees and nodes each get this many). */
	maxEntries?: number;
	/** Ceiling on summed estimated retained bytes, per level. One value above it is not cached. */
	maxBytes?: number;
	/** Drop entries nobody touched for this long, at the next insert. 0 disables idle expiry. */
	idleTtlMs?: number;
	/** Minimum distance between idle sweeps. */
	sweepIntervalMs?: number;
	/** Consecutive misses on one dir and shape that mark it busy. 0 disables the bypass. */
	busyMissThreshold?: number;
	/** How long a busy dir is walked without a fingerprint at all. 0 disables the bypass. */
	busyCooldownMs?: number;
}

/**
 * Sizing, from the measurements that motivated each ceiling:
 *
 * - `maxEntries: 512` is the historical cap and still the right shape: one scan of a
 *   budgeted tree stores one entry per dir it read (a root plus at most `maxChildren`
 *   leaves), so the population is the roster width, not the number of refreshes.
 * - `maxBytes: 16 MiB` per level is the new hard part. The entry cap alone let 560 busy
 *   scans of a 600-child family retain 79 MB (`heapUsed` delta, `--expose-gc`): a busy
 *   family stores a fresh root entry every tick under a fingerprint that will never be
 *   looked up again, and 512 of those at ~164 KB each is the whole leak. 16 MiB holds
 *   ~100 rosters of that size, i.e. the working set with room to spare, and binds long
 *   before the entry cap does.
 * - `idleTtlMs: 15 min` matches the two other {@link BoundedCache} consumers. It is what
 *   reclaims a dir nobody reads again (a finished family, a closed tray), and it is
 *   expiry, not freshness: every hit is still revalidated by the fingerprint.
 * - `busyMissThreshold: 2` / `busyCooldownMs: 60_000`: two probes in a row that both found
 *   the tree moved means a child is appending between refreshes, and for such a dir the
 *   fingerprint is pure overhead - it can only report a miss. One miss is not enough (a
 *   child that appends once and settles must keep its hits), and the cooldown is what
 *   bounds the re-probe to one per minute per dir instead of one per tick.
 */
export const DEFAULT_CONTEXT_TREE_DISK_CACHE_LIMITS = {
	maxEntries: 512,
	maxBytes: 16 * 1024 * 1024,
	idleTtlMs: 15 * 60 * 1000,
	sweepIntervalMs: 1000,
	busyMissThreshold: 2,
	busyCooldownMs: 60_000,
} satisfies Required<ContextTreeDiskScanCacheOptions>;

/**
 * Reuse for the on-disk half of the context tree, owned by the session that reads it.
 *
 * Two levels, because they buy different things:
 *
 * - **Subtree**: the children of one dir, keyed by the dir, the call's shape (level,
 *   maxDepth, budget, live ids) and {@link fingerprintRlmSessionDir} of the part of the
 *   tree that shape can read. Unchanged fingerprint means nothing the scan would read has
 *   changed, so the walk - every `readdir`, `stat`, parse and fold under that dir - is
 *   skipped outright. The budget is charged from the figures the cached miss recorded, so
 *   a truncated scan still reports the same omission on a hit: /context must not describe
 *   less of the tree just because the answer was remembered. The dir is part of the key
 *   because the fingerprint alone is not identity: two leaf dirs at the same level with the
 *   same shape fingerprint the same empty string, and sharing one entry between them would
 *   serve one dir's children for another's.
 * - **Node**: one transcript, keyed by its own stat identity (`mtimeMs` + `size`).
 *   This is the fallback when a subtree fingerprint moved for one reason (one child
 *   appended) but 255 siblings did not: only the moved transcript is read again.
 *
 * Both levels hand back copies of the nodes they hold, and the node entries carry
 * `children: []` - the walk owns each call's child arrays - so a remembered tree can
 * never be mutated by the scan that reuses it.
 *
 * Residency is bounded four ways, all of them insert-triggered (no timer, no handle, no
 * reason for the event loop to stay alive): a key ceiling and an estimated-byte ceiling per
 * level, least-recently-used eviction under pressure, idle expiry, and - for subtrees -
 * reclamation of the entry a moved fingerprint orphans. That last one matters because a
 * fingerprint is part of the key: a busy family produces a fresh key every tick, and
 * without reclaim each of those keeps a whole roster copy alive until some ceiling evicts
 * it. A dir whose subtree keeps moving is also walked without a fingerprint at all for a
 * cooldown (see `busyMissThreshold`): for such a dir the probe cannot hit, and paying it
 * made a cached scan *slower* than no cache - measured +52% at 200 children and +116% at
 * 600, against a walk that reads nothing twice.
 */
export class ContextTreeDiskScanCache {
	/**
	 * Dirs whose subtree was reused / rebuilt, and transcripts reused / read.
	 *
	 * `subtreeHits` counts a reuse that handed back children; `subtreeEmptyHits` counts one
	 * that handed back none (a leaf frame, or a frame the budget had already emptied), which
	 * saves one `readdir` and would otherwise flood the hit figure - a 200-child family
	 * measured 12207 "hits" against 262 misses, all but 200 of them empty. `subtreeProbes`
	 * is how many fingerprints a reuse check actually paid for, `subtreeBypasses` how many
	 * reuse checks were skipped as known-busy and `subtreeStores` how many walked subtrees
	 * were handed to the cache, so together they say what the busy policy cost and saved. A
	 * bypass is also counted as a miss: nothing was reused. A store counts as one whether or
	 * not a ceiling then kept it.
	 */
	readonly stats = {
		subtreeHits: 0,
		subtreeEmptyHits: 0,
		subtreeMisses: 0,
		subtreeBypasses: 0,
		subtreeProbes: 0,
		subtreeStores: 0,
		nodeHits: 0,
		nodeMisses: 0,
	};
	private readonly subtrees: BoundedCache<CachedSubtree>;
	private readonly nodes: BoundedCache<CachedContextNode>;
	/** Pointer key -> the full key currently live for it, so a moved fingerprint reclaims the old one. */
	private readonly liveKeys: BoundedCache<string>;
	/** Pointer key -> reuse policy for that dir and shape. */
	private readonly busy: BoundedCache<BusySubtreeState>;
	private readonly busyMissThreshold: number;
	private readonly busyCooldownMs: number;

	constructor(options: ContextTreeDiskScanCacheOptions = {}) {
		const defaults = DEFAULT_CONTEXT_TREE_DISK_CACHE_LIMITS;
		const limits = {
			maxEntries: options.maxEntries ?? defaults.maxEntries,
			maxBytes: options.maxBytes ?? defaults.maxBytes,
			idleTtlMs: options.idleTtlMs ?? defaults.idleTtlMs,
			sweepIntervalMs: options.sweepIntervalMs ?? defaults.sweepIntervalMs,
			busyMissThreshold: options.busyMissThreshold ?? defaults.busyMissThreshold,
			busyCooldownMs: options.busyCooldownMs ?? defaults.busyCooldownMs,
		};
		this.busyMissThreshold = limits.busyMissThreshold;
		this.busyCooldownMs = limits.busyCooldownMs;
		this.subtrees = new BoundedCache<CachedSubtree>({
			maxEntries: limits.maxEntries,
			maxBytes: limits.maxBytes,
			estimateBytes: (value, key) => estimateSubtreeBytes(value.nodes) + CACHE_BYTES_PER_CHAR * key.length,
			idleTtlMs: limits.idleTtlMs,
			sweepIntervalMs: limits.sweepIntervalMs,
		});
		this.nodes = new BoundedCache<CachedContextNode>({
			maxEntries: limits.maxEntries,
			maxBytes: limits.maxBytes,
			estimateBytes: (value, key) =>
				estimateNodeBytes(value.node) + CACHE_ENTRY_BYTES + CACHE_BYTES_PER_CHAR * key.length,
			idleTtlMs: limits.idleTtlMs,
			sweepIntervalMs: limits.sweepIntervalMs,
		});
		// Metadata, not payload: a few hundred bytes per dir. The entry ceiling binds first;
		// the byte ceiling is the backstop that keeps a pathological key length bounded too.
		const metadata = {
			maxEntries: limits.maxEntries,
			maxBytes: 1024 * 1024,
			idleTtlMs: limits.idleTtlMs,
			sweepIntervalMs: limits.sweepIntervalMs,
		};
		this.liveKeys = new BoundedCache<string>({
			...metadata,
			estimateBytes: (value, key) => CACHE_BYTES_PER_CHAR * (value.length + key.length),
		});
		this.busy = new BoundedCache<BusySubtreeState>({
			...metadata,
			estimateBytes: (_value, key) => CACHE_ENTRY_BYTES + CACHE_BYTES_PER_CHAR * key.length,
		});
	}

	/** Subtree entries currently retained. */
	get subtreeEntries(): number {
		return this.subtrees.size;
	}

	/** Estimated retained bytes of the subtree level (see {@link estimateNodeBytes}). */
	get subtreeEstimatedBytes(): number {
		return this.subtrees.estimatedBytes;
	}

	/** Transcript node entries currently retained. */
	get nodeEntries(): number {
		return this.nodes.size;
	}

	/** Estimated retained bytes of the node level. */
	get nodeEstimatedBytes(): number {
		return this.nodes.estimatedBytes;
	}

	/**
	 * The remembered subtree for `dir`, or undefined. `key` must cover everything
	 * besides the on-disk tree that the walk's result depends on (level, budget, live
	 * ids) - the fingerprint covers the tree itself, and `maxVisible` tells it how far
	 * down the listing that budget can read. On a hit the caller's `state` is
	 * charged what the walked miss was charged.
	 *
	 * A dir that missed {@link busyMissThreshold} probes in a row is walked without a
	 * fingerprint at all until the cooldown ends (`subtreeBypasses`). The bypass never
	 * serves anything: it returns undefined, so the caller walks the disk and gets the
	 * current tree. What it must not do is store - the walk behind a bypass has no
	 * fingerprint to be keyed by, and taking one afterwards would key pre-append nodes
	 * under a post-append identity.
	 */
	takeSubtree(
		dir: string,
		remainingDepth: number,
		maxVisible: number,
		key: string,
		state: ContextTreeScanState,
		resolveContextWindow: ContextWindowResolver,
		fingerprints?: Map<string, string>,
	): CachedSubtree | undefined {
		const pointerKey = `${dir}\n${key}`;
		const known = this.busy.get(pointerKey);
		if (known !== undefined) {
			known.bypassed = false;
		}
		if (known !== undefined && known.cooldownUntil > Date.now()) {
			known.bypassed = true;
			this.stats.subtreeBypasses++;
			this.stats.subtreeMisses++;
			return undefined;
		}
		const fingerprint = subtreeFingerprint(dir, remainingDepth, maxVisible, fingerprints);
		this.stats.subtreeProbes++;
		const fullKey = `${pointerKey}\n${fingerprint}`;
		const cached = this.subtrees.get(fullKey);
		if (!cached || subtreeModelWindows(cached.nodes, resolveContextWindow) !== cached.modelWindows) {
			// A window mismatch is not a transient miss: the same key can only become usable
			// again if the catalog moves back, and the store below replaces the entry anyway.
			// Dropping it here is what keeps a resolver change from parking dead rosters.
			if (cached) {
				this.subtrees.delete(fullKey);
			}
			this.stats.subtreeMisses++;
			this.recordSubtreeMiss(pointerKey);
			return undefined;
		}
		if (cached.nodes.length === 0) {
			this.stats.subtreeEmptyHits++;
		} else {
			this.stats.subtreeHits++;
		}
		this.busy.delete(pointerKey);
		replayScanCharge(state, cached.charge);
		return { nodes: cloneContextTreeNodes(cached.nodes), charge: cached.charge, modelWindows: cached.modelWindows };
	}

	/**
	 * Remember one walked subtree, keyed exactly as it was looked up.
	 *
	 * The key is the fingerprint the lookup used when the scan passed it, not a fresh one
	 * taken after the walk: a child that appended while the walk was reading is then a
	 * fingerprint the stored nodes predate, so the next scan misses and re-walks, instead
	 * of storing the post-append identity over pre-append nodes and serving them as fresh.
	 * A bypassed lookup left no fingerprint behind, and this stores nothing.
	 */
	storeSubtree(
		dir: string,
		remainingDepth: number,
		maxVisible: number,
		key: string,
		nodes: ContextTreeNode[],
		charge: CachedScanCharge,
		resolveContextWindow: ContextWindowResolver,
		fingerprints?: Map<string, string>,
	): void {
		const pointerKey = `${dir}\n${key}`;
		if (this.busy.get(pointerKey)?.bypassed) {
			return;
		}
		const fingerprint = subtreeFingerprint(dir, remainingDepth, maxVisible, fingerprints);
		const fullKey = `${pointerKey}\n${fingerprint}`;
		// Reclaim the entry this dir's previous fingerprint is holding: one dir and shape has
		// exactly one current fingerprint, so the old key can never be looked up again, and
		// leaving it to a ceiling is what let a busy family retain 79 MB of dead rosters.
		const previous = this.liveKeys.get(pointerKey);
		if (previous !== undefined && previous !== fullKey) {
			this.subtrees.delete(previous);
		}
		this.liveKeys.set(pointerKey, fullKey);
		this.subtrees.set(fullKey, {
			nodes: cloneContextTreeNodes(nodes),
			charge,
			modelWindows: subtreeModelWindows(nodes, resolveContextWindow),
		});
		this.stats.subtreeStores++;
	}

	/** One parsed transcript node, remembered by the transcript's own stat identity. */
	nodeOf(
		id: string,
		sessionFile: SessionFile,
		resolveContextWindow: ContextWindowResolver,
		build: () => ContextTreeNode | undefined,
	): ContextTreeNode | undefined {
		const key = `${sessionFile.path}:${sessionFile.mtimeMs}:${sessionFile.size}`;
		const cached = this.nodes.get(key);
		if (cached) {
			const node = cached.node;
			// The fold is resolver-independent (usage, status, label, model), but
			// `contextUsage` is not: a model whose catalog window changed must re-derive
			// its percentages rather than serve the old ones.
			const window =
				cached.hasModel && node.model ? resolveContextWindow(node.model.provider, node.model.id) : undefined;
			if (!cached.hasModel || window === cached.modelWindow) {
				this.stats.nodeHits++;
				return { ...node, id, children: [] };
			}
		}
		this.stats.nodeMisses++;
		const node = build();
		if (node) {
			const window = node.model ? resolveContextWindow(node.model.provider, node.model.id) : undefined;
			this.nodes.set(key, {
				node: { ...node, children: [] },
				modelWindow: window,
				hasModel: node.model !== undefined,
			});
		}
		return node;
	}

	/**
	 * Count a probe that found nothing usable, and start the bypass once a dir has missed
	 * {@link busyMissThreshold} probes in a row. A hit clears the state instead (see
	 * `takeSubtree`), so a family that settles gets its hits back after one cooldown.
	 */
	private recordSubtreeMiss(pointerKey: string): void {
		const misses = (this.busy.get(pointerKey)?.misses ?? 0) + 1;
		const bypass = this.busyCooldownMs > 0 && this.busyMissThreshold > 0 && misses >= this.busyMissThreshold;
		this.busy.set(pointerKey, {
			misses,
			cooldownUntil: bypass ? Date.now() + this.busyCooldownMs : 0,
			bypassed: false,
		});
	}
}

/** `provider/id=window` for every distinct model under `nodes` (see CachedSubtree). */
function subtreeModelWindows(nodes: readonly ContextTreeNode[], resolveContextWindow: ContextWindowResolver): string {
	const windows = new Map<string, string>();
	const walk = (list: readonly ContextTreeNode[]): void => {
		for (const node of list) {
			if (node.model) {
				const key = `${node.model.provider}/${node.model.id}`;
				if (!windows.has(key))
					windows.set(key, `${key}=${resolveContextWindow(node.model.provider, node.model.id) ?? "?"}`);
			}
			walk(node.children);
		}
	};
	walk(nodes);
	return [...windows.values()].sort().join(",");
}

/** The scan accounting as it stands, so a walk's own charge can be measured as a delta. */
function scanChargeOf(state: ContextTreeScanState): CachedScanCharge {
	return {
		scannedChildren: state.scannedChildren,
		bytesRead: state.bytesRead,
		bytesPlanned: state.bytesPlanned,
		skippedByBudget: state.skippedByBudget,
		truncated: state.truncated,
		truncatedReason: state.truncatedReason,
		depthLimitReached: state.depthLimitReached,
	};
}

function subtractScanCharge(after: CachedScanCharge, before: CachedScanCharge): CachedScanCharge {
	return {
		scannedChildren: after.scannedChildren - before.scannedChildren,
		bytesRead: after.bytesRead - before.bytesRead,
		bytesPlanned: after.bytesPlanned - before.bytesPlanned,
		skippedByBudget: after.skippedByBudget - before.skippedByBudget,
		truncated: after.truncated && !before.truncated,
		truncatedReason: after.truncated && !before.truncated ? after.truncatedReason : undefined,
		depthLimitReached: after.depthLimitReached && !before.depthLimitReached,
	};
}

/** Charge a reused subtree exactly as the walk that produced it was charged. */
function replayScanCharge(state: ContextTreeScanState, charge: CachedScanCharge): void {
	state.scannedChildren += charge.scannedChildren;
	state.bytesRead += charge.bytesRead;
	state.bytesPlanned += charge.bytesPlanned;
	state.skippedByBudget += charge.skippedByBudget;
	if (charge.truncated) {
		state.truncated = true;
		state.truncatedReason ??= charge.truncatedReason;
	}
	if (charge.depthLimitReached) state.depthLimitReached = true;
}

/**
 * A copy of a walked subtree, so no caller can mutate what the cache handed out.
 *
 * The usage objects are copied too: they are the figures a caller displays, and a
 * reused answer must never inherit an edit made to the answer handed out earlier.
 */
function cloneContextTreeNodes(nodes: ContextTreeNode[]): ContextTreeNode[] {
	return nodes.map((node) => ({
		...node,
		ownUsage: cloneUsage(node.ownUsage),
		totalUsage: cloneUsage(node.totalUsage),
		contextUsage: node.contextUsage ? { ...node.contextUsage } : undefined,
		children: cloneContextTreeNodes(node.children),
	}));
}

/** Which limit stopped a disk scan from reading more session files. */
export type ContextTreeTruncatedReason = "children" | "bytes" | "depth";

/**
 * Upper bounds for one on-disk context tree scan. Omitted fields take
 * {@link DEFAULT_CONTEXT_TREE_SCAN_BUDGET}.
 */
export interface ContextTreeScanBudget {
	/** Max number of child session transcripts to read. */
	maxChildren?: number;
	/** Max total bytes of child session transcripts to read. */
	maxBytes?: number;
	/**
	 * Max nesting level to read: the children of the scanned dir are level 1,
	 * their children level 2. Deeper dirs are neither read nor listed.
	 */
	maxDepth?: number;
}

/**
 * Limits that keep a `/context` scan of the persisted RLM session dirs from
 * turning into an unbounded read of the disk. They are ceilings for pathological
 * transcripts, not a shape the UI depends on: a session that stays under all
 * three gets the same tree it always got.
 *
 * - `maxChildren: 256`: `/context` was measured on a directory holding 544
 *   finished children, which cost 2.2s and ~1.08GB of reads. Ordinary RLM
 *   fan-out is in the tens, so 256 keeps a multi-round roster whole while
 *   capping the per-node work (each child is read and folded in full). The 256
 *   kept are the 256 most recently active (see {@link listChildSessionDirs}), so
 *   what a capped scan drops is the oldest branches, never the live ones.
 * - `maxBytes: 64 MiB`: reading and folding a transcript dominates the scan and
 *   scales with file size, so bytes - not children - are what actually bounds
 *   the time. 64 MiB is roughly a thousand ordinary child sessions, and the
 *   observed 1.08GB scan is 17x over it.
 * - `maxDepth: 16`: delegation nests a few levels in practice. The cap exists to
 *   bound the walk: without it, nesting depth was limited only by the filesystem
 *   (a `sub-*` dir that points back at an ancestor kept appending path
 *   components until `PATH_MAX` made `readdirSync` fail, silently ending the
 *   scan with a duplicated chain).
 */
export const DEFAULT_CONTEXT_TREE_SCAN_BUDGET = {
	maxChildren: 256,
	maxBytes: 64 * 1024 * 1024,
	maxDepth: 16,
} satisfies Required<ContextTreeScanBudget>;

/**
 * What a scan covered. Callers use this to say how much of the tree is not on
 * screen instead of quietly showing a partial roster.
 */
export interface ContextTreeScanDiagnostics {
	/** Child session transcripts opened and folded (whether or not they yielded a node). */
	scannedChildren: number;
	/** Stat size of every transcript {@link scannedChildren} read. */
	bytesRead: number;
	/** Stat size of every candidate transcript the scan looked at, read or refused. */
	bytesPlanned: number;
	/**
	 * Candidate child sessions found at levels the scan still visited that were
	 * not read. Each refused dir stands for its own unvisited subtree, so this is
	 * a lower bound on what a full scan would have covered.
	 */
	skippedByBudget: number;
	/** A dir nested past `maxDepth` was refused. */
	depthLimitReached: boolean;
	/** The scan did not read everything it found. */
	truncated: boolean;
	/** The first limit that bit, or undefined when nothing was skipped. */
	truncatedReason: ContextTreeTruncatedReason | undefined;
}

/**
 * Running accounting of one on-disk scan: the limits in force plus what the walk
 * has read and refused so far.
 *
 * Exported so a caller that runs several scans for one report - `/context` reads
 * the persisted children of every live child as well as its own - can charge them
 * all to a single budget and publish a single set of diagnostics, instead of each
 * subtree getting a private allowance nobody adds up.
 */
export interface ContextTreeScanState {
	readonly maxChildren: number;
	readonly maxBytes: number;
	readonly maxDepth: number;
	scannedChildren: number;
	bytesRead: number;
	bytesPlanned: number;
	skippedByBudget: number;
	depthLimitReached: boolean;
	truncated: boolean;
	truncatedReason: ContextTreeTruncatedReason | undefined;
	/** A read limit was hit, so no further transcript will be opened. */
	readLimitReached: boolean;
}

function limitOr(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.max(0, Math.floor(value));
}

export function createContextTreeScanState(budget?: ContextTreeScanBudget): ContextTreeScanState {
	const defaults = DEFAULT_CONTEXT_TREE_SCAN_BUDGET;
	return {
		maxChildren: limitOr(budget?.maxChildren, defaults.maxChildren),
		maxBytes: limitOr(budget?.maxBytes, defaults.maxBytes),
		maxDepth: limitOr(budget?.maxDepth, defaults.maxDepth),
		scannedChildren: 0,
		bytesRead: 0,
		bytesPlanned: 0,
		skippedByBudget: 0,
		depthLimitReached: false,
		truncated: false,
		truncatedReason: undefined,
		readLimitReached: false,
	};
}

/** The diagnostics for a scan so far; safe to read while the walk is still running. */
export function contextTreeScanDiagnostics(state: ContextTreeScanState): ContextTreeScanDiagnostics {
	return {
		scannedChildren: state.scannedChildren,
		bytesRead: state.bytesRead,
		bytesPlanned: state.bytesPlanned,
		skippedByBudget: state.skippedByBudget,
		depthLimitReached: state.depthLimitReached,
		truncated: state.truncated,
		truncatedReason: state.truncatedReason,
	};
}

/**
 * Charge a candidate transcript against the read budget before it is opened.
 * Returns false, and reads nothing, once a limit is reached - a byte or child
 * cap stops the whole scan, so the caller never pays for a partial roster it
 * cannot finish.
 */
function reserveChildRead(state: ContextTreeScanState, size: number): boolean {
	state.bytesPlanned += size;
	if (!state.readLimitReached) {
		if (state.scannedChildren >= state.maxChildren) {
			state.readLimitReached = true;
			state.truncatedReason ??= "children";
		} else if (state.bytesRead + size > state.maxBytes) {
			state.readLimitReached = true;
			state.truncatedReason ??= "bytes";
		}
	}
	if (state.readLimitReached) {
		state.truncated = true;
		state.skippedByBudget++;
		return false;
	}
	state.scannedChildren++;
	state.bytesRead += size;
	return true;
}

/**
 * Build one disk node. Its children are filled in by the traversal, not here.
 *
 * With a `cache` the parse-and-fold is remembered by the transcript's stat identity
 * (see {@link ContextTreeDiskScanCache}), which is what keeps a rescan of a wide tree
 * from re-reading transcripts that did not move.
 */
function readContextTreeNode(
	id: string,
	sessionFile: SessionFile,
	resolveContextWindow: ContextWindowResolver,
	cache?: ContextTreeDiskScanCache,
): ContextTreeNode | undefined {
	const build = (): ContextTreeNode | undefined => readContextTreeEntry(id, sessionFile.path, resolveContextWindow);
	return cache ? cache.nodeOf(id, sessionFile, resolveContextWindow, build) : build();
}

/** The uncached build of one disk node: parse the transcript and fold its spend. */
function readContextTreeEntry(
	id: string,
	sessionFile: string,
	resolveContextWindow: ContextWindowResolver,
): ContextTreeNode | undefined {
	const allEntries = sessionEntriesFromFile(sessionFile);
	const branch = branchEntries(allEntries);
	if (branch.length === 0) {
		return undefined;
	}

	// Spend over every entry, not just the branch: a disk node must report the same
	// total the catalog scan and the session rows do, or the same session reads
	// differently in `/context` and in the roster.
	const { ownUsage, totalUsage } = computeOwnAndTotalUsage(allEntries, allEntries);

	let model: { provider: string; id: string } | undefined;
	for (const entry of branch) {
		if (entry.type === "model_change") {
			model = { provider: entry.provider, id: entry.modelId };
		}
	}

	let label = "";
	for (const entry of branch) {
		if (entry.type === "message" && entry.message.role === "user") {
			label = compactLabel(readUserMessageText(entry.message.content));
			if (label) {
				break;
			}
		}
	}

	const contextWindow = model ? resolveContextWindow(model.provider, model.id) : undefined;

	return {
		id,
		label: label || "child agent",
		status: statusFromBranch(branch),
		model,
		ownUsage,
		totalUsage,
		contextUsage: computeContextUsageFromEntries(allEntries, branch, contextWindow),
		children: [],
	};
}

/** One directory whose `sub-*` children are still to be visited. */
interface ScanFrame {
	dir: string;
	/** Where the nodes for `dir`'s children are collected. */
	siblings: ContextTreeNode[];
	/** Nesting level of the children listed from `dir`. */
	level: number;
	/** Children already represented live; set on the first frame only. */
	skipIds?: ReadonlySet<string>;
	/** The frame this dir was reached from; its subtree charge rolls up into this one. */
	parent?: ScanFrame;
	/** Everything this dir's subtree charged the scan, replayed on a cache hit. */
	total: CachedScanCharge;
}

/**
 * How far down a frame's listing the scan can read, i.e. the fingerprint's visible window.
 *
 * `maxChildren` is the reads the budget allows, and the root frame's live ids occupy
 * listing positions without costing a read, so they widen the window: a candidate behind
 * them can still be read. Overestimating only invalidates too often, which is safe; the
 * window is never narrower than the prefix the walk consumes.
 */
function frameMaxVisible(frame: ScanFrame, state: ContextTreeScanState): number {
	return state.maxChildren + (frame.skipIds?.size ?? 0);
}

/** The subtree a frame's dir covers, as the cache keys and stores it. */
function frameSubtreeKey(frame: ScanFrame, state: ContextTreeScanState): string {
	const live = frame.skipIds ? [...frame.skipIds].sort().join(",") : "";
	return `${frame.level}|${state.maxDepth}|${state.maxChildren}|${state.maxBytes}|${live}`;
}

/** Roll a finished frame's whole-subtree charge into its parent. */
function addScanCharge(target: CachedScanCharge, delta: CachedScanCharge): void {
	target.scannedChildren += delta.scannedChildren;
	target.bytesRead += delta.bytesRead;
	target.bytesPlanned += delta.bytesPlanned;
	target.skippedByBudget += delta.skippedByBudget;
	if (delta.truncated) {
		target.truncated = true;
		target.truncatedReason ??= delta.truncatedReason;
	}
	if (delta.depthLimitReached) target.depthLimitReached = true;
}

/**
 * Visit child session dirs with an explicit queue, charging every transcript
 * read against `state`.
 *
 * The walk is breadth first: a roster is read before its grandchildren, so a
 * truncated scan shows the whole top-level fan-out (the part a caller can
 * summarize as "N more agents") rather than one deep branch. Frames are queued
 * only for dirs actually read, which bounds the listing work by the read budget
 * instead of by the size of the tree on disk.
 *
 * With a `cache`, a dir whose subtree is unchanged since the last scan is not
 * walked at all: its children (and everything below them) come back from
 * {@link ContextTreeDiskScanCache} with the walk's own budget charge replayed, so
 * the reused answer and the walked one are indistinguishable to the caller -
 * including a truncated scan's `partial` report. BFS order is what makes the
 * seam safe: a dir's subtree is only ever queued from the dir's own frame, so a
 * hit can fill that subtree without disturbing the frames still to come.
 */
function scanChildrenInto(
	rootDir: string,
	rootSiblings: ContextTreeNode[],
	resolveContextWindow: ContextWindowResolver,
	state: ContextTreeScanState,
	skipIds?: ReadonlySet<string>,
	cache?: ContextTreeDiskScanCache,
): void {
	const root: ScanFrame = {
		dir: rootDir,
		siblings: rootSiblings,
		level: 1,
		skipIds,
		total: emptyScanCharge(),
	};
	// One memo for this scan only: the lookup and the store of the same miss are two
	// fingerprints of the same tree, and the tree cannot change between them without an
	// await in a synchronous walk.
	const fingerprints = new Map<string, string>();
	const queue: ScanFrame[] = [root];
	const misses: ScanFrame[] = [];
	for (let index = 0; index < queue.length; index++) {
		const frame = queue[index];
		const remainingDepth = state.maxDepth - frame.level + 1;
		const cached = cache?.takeSubtree(
			frame.dir,
			remainingDepth,
			frameMaxVisible(frame, state),
			frameSubtreeKey(frame, state),
			state,
			resolveContextWindow,
			fingerprints,
		);
		if (cached) {
			frame.total = cached.charge;
			frame.siblings.push(...cached.nodes);
			continue;
		}
		const before = scanChargeOf(state);
		if (cache) misses.push(frame);
		for (const childDir of listChildSessionDirs(frame.dir)) {
			if (frame.skipIds?.has(basename(childDir))) {
				continue;
			}
			if (frame.level > state.maxDepth) {
				state.truncated = true;
				state.truncatedReason ??= "depth";
				state.depthLimitReached = true;
				state.skippedByBudget++;
				continue;
			}
			const sessionFile = findSessionFile(childDir);
			if (!sessionFile) {
				// Nothing persisted here (or nothing readable): the old scan skipped the
				// dir too, so it is not a budget skip.
				continue;
			}
			if (!reserveChildRead(state, sessionFile.size)) {
				continue;
			}
			const node = readContextTreeNode(basename(childDir), sessionFile, resolveContextWindow, cache);
			if (!node) {
				continue;
			}
			frame.siblings.push(node);
			queue.push({
				dir: childDir,
				siblings: node.children,
				level: frame.level + 1,
				parent: frame,
				total: emptyScanCharge(),
			});
		}
		frame.total = subtractScanCharge(scanChargeOf(state), before);
		if (frame.parent) addScanCharge(frame.parent.total, frame.total);
	}
	// The subtree is complete only after every frame below it has run, which BFS
	// guarantees has happened by now: store what was walked, keyed by the same
	// fingerprint the lookup used.
	if (cache) {
		for (const frame of misses) {
			cache.storeSubtree(
				frame.dir,
				state.maxDepth - frame.level + 1,
				frameMaxVisible(frame, state),
				frameSubtreeKey(frame, state),
				frame.siblings,
				frame.total,
				resolveContextWindow,
				fingerprints,
			);
		}
	}
}

/** All-zero charge, the starting point of a frame's subtree accounting. */
function emptyScanCharge(): CachedScanCharge {
	return {
		scannedChildren: 0,
		bytesRead: 0,
		bytesPlanned: 0,
		skippedByBudget: 0,
		truncated: false,
		truncatedReason: undefined,
		depthLimitReached: false,
	};
}

/** Options for {@link scanContextTreeChildrenFromDisk}. */
export interface ContextTreeScanOptions {
	/** Read limits; omitted fields take {@link DEFAULT_CONTEXT_TREE_SCAN_BUDGET}. */
	budget?: ContextTreeScanBudget;
	/** Children already represented live, excluded from the scan. */
	skipIds?: ReadonlySet<string>;
	/**
	 * Accounting to charge this scan to, when it is part of a larger report.
	 * Omitted: the scan gets its own state and `budget` applies to it alone.
	 */
	state?: ContextTreeScanState;
	/**
	 * Remembered scans of this dir tree, so a refresh that changes nothing on disk
	 * does not re-read it. Omitted (the default for one-off callers): every scan
	 * walks, exactly as it always did.
	 */
	cache?: ContextTreeDiskScanCache;
}

export interface ContextTreeScanResult {
	nodes: ContextTreeNode[];
	diagnostics: ContextTreeScanDiagnostics;
}

/**
 * Build context nodes for the persisted RLM children under an RLM session dir,
 * descending into nested `sub-*` dirs, and report how much of the tree the scan
 * actually read.
 *
 * `loadContextTreeChildFromDisk` builds the equivalent of a single entry in the
 * returned array, including its subtree.
 */
export function scanContextTreeChildrenFromDisk(
	rlmSessionDir: string | undefined,
	resolveContextWindow: ContextWindowResolver,
	options: ContextTreeScanOptions = {},
): ContextTreeScanResult {
	const state = options.state ?? createContextTreeScanState(options.budget);
	if (!rlmSessionDir || !existsSync(rlmSessionDir)) {
		return { nodes: [], diagnostics: contextTreeScanDiagnostics(state) };
	}
	const nodes: ContextTreeNode[] = [];
	scanChildrenInto(rlmSessionDir, nodes, resolveContextWindow, state, options.skipIds, options.cache);
	return { nodes, diagnostics: contextTreeScanDiagnostics(state) };
}

/**
 * Build a context node for a completed RLM child from its persisted session
 * dir (sub-xxxx/). Children that already attributed grandchild usage carry the
 * aggregate on their assistant messages (applyChildUsageAttributions), so own
 * usage is recovered by subtracting the attribution entries. Returns undefined
 * when the dir holds no readable session.
 *
 * The requested dir is always read - it is what the caller asked for; `budget`
 * bounds the subtree below it.
 */
export function loadContextTreeChildFromDisk(
	childSessionDir: string,
	resolveContextWindow: ContextWindowResolver,
	budget?: ContextTreeScanBudget,
	state?: ContextTreeScanState,
	cache?: ContextTreeDiskScanCache,
): ContextTreeNode | undefined {
	const sessionFile = findSessionFile(childSessionDir);
	if (!sessionFile) {
		return undefined;
	}
	const scanState = state ?? createContextTreeScanState(budget);
	const node = readContextTreeNode(basename(childSessionDir), sessionFile, resolveContextWindow, cache);
	if (!node) {
		return undefined;
	}
	scanChildrenInto(childSessionDir, node.children, resolveContextWindow, scanState, undefined, cache);
	return node;
}

/**
 * Build context nodes for all persisted RLM children under an RLM session dir,
 * descending into nested sub-* dirs. `skipIds` excludes children that are
 * already represented live.
 *
 * This is {@link scanContextTreeChildrenFromDisk} without the diagnostics; pass
 * `budget` to change the read limits, or call the scan directly to report what
 * it left out.
 */
export function loadContextTreeChildrenFromDisk(
	rlmSessionDir: string | undefined,
	resolveContextWindow: ContextWindowResolver,
	skipIds?: ReadonlySet<string>,
	budget?: ContextTreeScanBudget,
	cache?: ContextTreeDiskScanCache,
): ContextTreeNode[] {
	return scanContextTreeChildrenFromDisk(rlmSessionDir, resolveContextWindow, { budget, skipIds, cache }).nodes;
}
