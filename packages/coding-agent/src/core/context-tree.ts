import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { RlmChildAgentStatus } from "./agent-session.js";
import { calculateContextTokens, estimateContextTokens } from "./compaction/index.js";
import type { ContextUsage } from "./extensions/index.js";
import { buildSessionContext, type FileEntry, loadEntriesFromFile, type SessionEntry } from "./session-manager.js";
import { addAssistantUsage, cloneUsage, emptyUsage, subtractAssistantUsage } from "./usage.js";

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

/** A child session's newest transcript, with its size so a scan can budget it. */
interface SessionFile {
	path: string;
	size: number;
}

function findSessionFile(dir: string): SessionFile | undefined {
	let newest: { path: string; mtime: number; size: number } | undefined;
	for (const name of readdirSync(dir)) {
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
	return newest && { path: newest.path, size: newest.size };
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

/** Build one disk node. Its children are filled in by the traversal, not here. */
function readContextTreeNode(
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
 */
function scanChildrenInto(
	rootDir: string,
	rootSiblings: ContextTreeNode[],
	resolveContextWindow: ContextWindowResolver,
	state: ContextTreeScanState,
	skipIds?: ReadonlySet<string>,
): void {
	const queue: ScanFrame[] = [{ dir: rootDir, siblings: rootSiblings, level: 1, skipIds }];
	for (let index = 0; index < queue.length; index++) {
		const frame = queue[index];
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
			const node = readContextTreeNode(basename(childDir), sessionFile.path, resolveContextWindow);
			if (!node) {
				continue;
			}
			frame.siblings.push(node);
			queue.push({ dir: childDir, siblings: node.children, level: frame.level + 1 });
		}
	}
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
	scanChildrenInto(rlmSessionDir, nodes, resolveContextWindow, state, options.skipIds);
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
): ContextTreeNode | undefined {
	const sessionFile = findSessionFile(childSessionDir);
	if (!sessionFile) {
		return undefined;
	}
	const node = readContextTreeNode(basename(childSessionDir), sessionFile.path, resolveContextWindow);
	if (!node) {
		return undefined;
	}
	scanChildrenInto(childSessionDir, node.children, resolveContextWindow, state ?? createContextTreeScanState(budget));
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
): ContextTreeNode[] {
	return scanContextTreeChildrenFromDisk(rlmSessionDir, resolveContextWindow, { budget, skipIds }).nodes;
}
