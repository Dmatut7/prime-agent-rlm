import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { canonicalizePath } from "../../utils/paths.js";
import type { AgentConnectionHeartbeat, AgentConnectionSavedSessionInfo } from "../agent-connection/index.js";
import { rosterAgentIdForSummary } from "../daemon/agent-roster.js";
import { classifySessionRosterStatus, type SessionSummary } from "../daemon/daemon-session-list.js";
import { createSessionSearchText } from "./session-view-search.js";

export type AgentsViewSection = "running" | "idle" | "inactive";

export interface UnifiedSessionHeartbeat {
	activeCount: number;
	pausedCount?: number;
	nextRunAt?: string;
}

export interface UnifiedSessionRecord {
	daemon?: SessionSummary;
	saved?: AgentConnectionSavedSessionInfo;
	/** Stable UI key, chosen using canonical path, session id, then active id. */
	identity: string;
	/** Alternate keys used to restore selection while a session is persisted or reattached. */
	identityAliases: readonly string[];
	section: AgentsViewSection;
	/**
	 * Search corpus for this row. Materialized on first read by
	 * `unifiedSessionSearchableText` and memoized for the record's lifetime, because
	 * a saved row's corpus carries up to 64 KiB of message text and most catalog
	 * passes run with an empty search box. Producers that have no daemon/saved
	 * sources (synthetic rows) may set it directly; when set, it is authoritative.
	 */
	searchableText?: string;
	heartbeat?: UnifiedSessionHeartbeat;
}

export interface AgentsViewScopeKey {
	sessionId: string;
	activeSessionId?: string;
}

export interface AgentsViewScopeFrame {
	scope: AgentsViewScopeKey;
	/** Chat to revisit before returning to the parent agents view. */
	returnChat?: SessionSummary;
}

export type AgentsViewScopeAction =
	| { type: "push"; scope: AgentsViewScopeKey; returnChat?: SessionSummary }
	| { type: "back" };

export interface AgentsViewScopeResolution {
	frames: AgentsViewScopeFrame[];
	root?: UnifiedSessionRecord;
	droppedFrames: number;
}

export interface AgentsViewScopeBackResult {
	type: "scope_back";
	selection: SessionSummary;
	expandedAncestorSessionIds: string[];
	returnChat?: SessionSummary;
}

export interface UnattachableChildOpenResult {
	type: "open";
	summary: SessionSummary;
	selection: SessionSummary;
	expandedAncestorSessionIds: string[];
	hasChildren: boolean;
	statusMessage: string;
}

export type AgentsViewRowKind = "agent" | "subagent-summary" | "subagent" | "subagent-code" | "answer";

// Hard cap on spawn-code lines shown so a large program never floods the view.
const MAX_SPAWN_CODE_LINES = 10;

export interface AgentsViewRow {
	kind: AgentsViewRowKind;
	section: AgentsViewSection;
	summary: SessionSummary;
	title: string;
	subtitle: string;
	statusLabel: string;
	depth: number;
	selectable: boolean;
	runningSubagentCount: number;
	recursiveCost: number;
	/** Total descendant sessions (resident + passive) under this row. */
	descendantCount: number;
	/** Unique selection identity for this row. */
	identity: string;
	/** Identity of the agent row this row is nested under. */
	parentIdentity?: string;
	/** True when this row's subagents carry spawn code that can be revealed. */
	hasSpawnCode?: boolean;
	/** True when this subagent-summary row's list is expanded. */
	expanded?: boolean;
	/** One source line of the spawn cell, for "subagent-code" rows. */
	code?: string;
	/** Merged durable/live source data for unified rows. */
	record?: UnifiedSessionRecord;
	heartbeat?: UnifiedSessionHeartbeat;
}

export function classifyAgentsViewSession(summary: SessionSummary): AgentsViewSection {
	return summary.rosterStatus ?? classifySessionRosterStatus(summary);
}

export function classifyUnifiedSession(record: Pick<UnifiedSessionRecord, "daemon">): AgentsViewSection {
	if (!record.daemon) {
		return "inactive";
	}
	return classifyAgentsViewSession(record.daemon);
}

export function shouldShowAgentsViewSession(summary: SessionSummary, manuallyInactive = false): boolean {
	if (manuallyInactive) {
		return false;
	}
	return summary.lifecycle === "live";
}

// TODO(unify: #2055): replace with the shared user-content rule once it lands;
// session summaries only carry message counts today.
export function isEmptyAgentsViewSession(summary: SessionSummary): boolean {
	return summary.messageCount === 0;
}

export function sectionTitle(section: AgentsViewSection): string {
	switch (section) {
		case "running":
			return "Running";
		case "idle":
			return "Idle";
		case "inactive":
			return "Inactive";
		default: {
			const _exhaustive: never = section;
			return _exhaustive;
		}
	}
}

function formatAgeLabel(timestamp: string): string {
	const seconds = Math.max(0, Math.round((Date.now() - Date.parse(timestamp)) / 1000));
	if (seconds < 120) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	return minutes < 120 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/**
 * Canonicalizing a session path is a `realpathSync` syscall, and one catalog pass
 * canonicalizes the same paths several times per row: identity aliases, parent
 * keys, row keys and merged summaries all ask for the same session file. Resolved
 * paths are memoized: one cached-cold pass over the bench catalog spends about
 * 8 ms canonicalizing its 860 session paths, and later passes about 0.5 ms. Paths
 * that do not resolve are not memoized, so a file that appears later resolves then. The memo is a flat cache, not a lease: it is dropped whole
 * when it grows past the catalog-scale bound.
 */
const canonicalPathCache = new Map<string, string>();
const CANONICAL_PATH_CACHE_LIMIT = 4096;

function canonicalSessionPath(path: string): string {
	const cached = canonicalPathCache.get(path);
	if (cached !== undefined) return cached;
	let canonical: string;
	try {
		canonical = resolve(realpathSync(path));
	} catch (error) {
		// A path that is not there cannot be resolved, so canonicalizePath() would
		// only repeat the same failing syscall and pay a second thrown-error stack
		// capture for the same answer. This is the hot case for a roster listing
		// sessions whose files are gone: a failure is deliberately not memoized (the
		// file may appear later), so every pass used to pay both syscalls per row.
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return resolve(path);
		}
		return resolve(canonicalizePath(path));
	}
	if (canonicalPathCache.size >= CANONICAL_PATH_CACHE_LIMIT) canonicalPathCache.clear();
	canonicalPathCache.set(path, canonical);
	return canonical;
}

function fileIdentity(path: string): string {
	return `file:${canonicalSessionPath(path)}`;
}

/**
 * Every key a session answers to: file identity, session id, active id and agent
 * id. Both the reconcile and the roster store key dirty rows by these, so a row is
 * rebuilt when any of its identities moved.
 */
export function summaryIdentityAliases(summary: SessionSummary): string[] {
	return [
		summary.runtimeKind === "subagent" && summary.rlmChildId
			? `agent:${rosterAgentIdForSummary(summary)}`
			: undefined,
		summary.sessionFile ? fileIdentity(summary.sessionFile) : undefined,
		`session:${summary.sessionId}`,
		summary.activeSessionId ? `active:${summary.activeSessionId}` : undefined,
		`active:${summary.id}`,
	].filter((identity): identity is string => identity !== undefined);
}

function savedIdentityAliases(saved: AgentConnectionSavedSessionInfo): string[] {
	return [fileIdentity(saved.path), `session:${saved.id}`];
}

/**
 * A saved row's corpus is dominated by `allMessagesText`, a per-row transcript
 * excerpt of up to 64 KiB, and the joined corpus is a pure function of the saved
 * snapshot object the daemon catalog hands over (the catalog replaces its rows
 * instead of editing them, so the object identity is the row's revision). Joining
 * it once per saved snapshot instead of once per record per pass retains one
 * corpus per saved row -- the same order as the catalog the client already holds.
 */
const savedSearchCorpusCache = new WeakMap<AgentConnectionSavedSessionInfo, string>();

function savedSearchCorpus(saved: AgentConnectionSavedSessionInfo): string {
	const cached = savedSearchCorpusCache.get(saved);
	if (cached !== undefined) return cached;
	const corpus = createSessionSearchText([
		saved.id,
		saved.name,
		saved.firstMessage,
		saved.allMessagesText,
		saved.agentStatus?.summary,
		saved.cwd,
		saved.path,
		saved.parentSessionPath,
	]);
	savedSearchCorpusCache.set(saved, corpus);
	return corpus;
}

function daemonSearchCorpus(daemon: SessionSummary): string {
	return createSessionSearchText([
		daemon.sessionId,
		daemon.activeSessionId,
		daemon.sessionName,
		daemon.firstMessage,
		daemon.cwd,
		daemon.sessionFile,
		daemon.summary,
		// U3: an agent's last answer is searchable text for the row.
		daemon.answerPreview,
	]);
}

/**
 * Byte-identical to joining every field in row order: each fragment joins its own
 * non-empty parts with a single space, and the fragments are joined the same way.
 */
function createUnifiedSearchableText(
	daemon: SessionSummary | undefined,
	saved: AgentConnectionSavedSessionInfo | undefined,
): string {
	return createSessionSearchText([
		daemon ? daemonSearchCorpus(daemon) : undefined,
		saved ? savedSearchCorpus(saved) : undefined,
	]);
}

interface SearchableTextMemo {
	daemon?: SessionSummary;
	saved?: AgentConnectionSavedSessionInfo;
	text: string;
}

const searchableTextMemo = new WeakMap<UnifiedSessionRecord, SearchableTextMemo>();

/**
 * Search corpus for one row, materialized on first read.
 *
 * Building it eagerly for every row costs a 64 KiB join per saved row on every
 * catalog pass: on the bench catalog (520 live rows, 340 saved rows carrying
 * 17 MB of transcript text) the cached-cold reconcile drops from 19.4 ms to
 * 8.5 ms once nothing builds corpora an empty search box cannot read. A record
 * carried across passes keeps its memo, and the saved fragment is cached against
 * the saved snapshot, so an unchanged row never re-joins its excerpt.
 */
export function unifiedSessionSearchableText(record: UnifiedSessionRecord): string {
	if (record.searchableText !== undefined) return record.searchableText;
	const memo = searchableTextMemo.get(record);
	if (memo !== undefined && memo.daemon === record.daemon && memo.saved === record.saved) {
		return memo.text;
	}
	const text = createUnifiedSearchableText(record.daemon, record.saved);
	searchableTextMemo.set(record, { daemon: record.daemon, saved: record.saved, text });
	return text;
}

export interface ReconcileUnifiedSessionsOptions {
	/**
	 * Records from the previous pass. Rows the daemon did not change keep their
	 * object identity, which is what lets the view skip re-deriving their row text
	 * and search corpus (a 64 KiB join per saved row).
	 *
	 * Only valid when this pass runs over the same `savedSessions` and `heartbeats`
	 * inputs as the previous one: the reuse invariant is that the alias -> session
	 * mapping of the catalog is unchanged, and the saved catalog is what the alias
	 * map routes into.
	 */
	previous?: readonly UnifiedSessionRecord[];
	/** Session ids (any identity alias) whose daemon rows changed in this pass. */
	dirtySessionIds?: ReadonlySet<string>;
}

function heartbeatValuesEqual(a: UnifiedSessionHeartbeat | undefined, b: UnifiedSessionHeartbeat | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	return a.activeCount === b.activeCount && a.pausedCount === b.pausedCount && a.nextRunAt === b.nextRunAt;
}

/**
 * Decide, once per pass, whether unchanged rows may be carried over verbatim.
 *
 * The reuse is exact only while the catalog's alias -> session mapping is
 * unchanged: a new alias (a session that appeared, or a file/active id that just
 * showed up) or a vanished one (a row that left) can re-route saved snapshots onto
 * different rows and re-parent the subagent forest, so those passes rebuild.
 */
function buildRecordReuse(
	daemonSummaries: readonly SessionSummary[],
	aliasesBySummary: readonly (readonly string[])[],
	options: ReconcileUnifiedSessionsOptions,
) {
	const previous = options.previous;
	const dirtySessionIds = options.dirtySessionIds;
	if (previous === undefined || dirtySessionIds === undefined) return undefined;

	const previousBySessionId = new Map<string, UnifiedSessionRecord>();
	const previousByAlias = new Map<string, string>();
	const previousSessionIds = new Set<string>();
	for (const record of previous) {
		const daemon = record.daemon;
		if (daemon === undefined) continue;
		previousSessionIds.add(daemon.sessionId);
		previousBySessionId.set(daemon.sessionId, record);
		// Later rows win, exactly like the alias index the rebuild itself builds.
		for (const alias of record.identityAliases) previousByAlias.set(alias, daemon.sessionId);
	}
	const currentSessionIds = new Set<string>();
	for (let index = 0; index < daemonSummaries.length; index++) {
		const daemon = daemonSummaries[index]!;
		if (!previousSessionIds.has(daemon.sessionId)) return undefined;
		if (currentSessionIds.has(daemon.sessionId)) return undefined;
		currentSessionIds.add(daemon.sessionId);
		for (const alias of aliasesBySummary[index] ?? []) {
			if (previousByAlias.get(alias) !== daemon.sessionId) return undefined;
		}
	}
	if (currentSessionIds.size !== previousSessionIds.size) return undefined;
	return { previousBySessionId };
}

/**
 * Reconcile daemon-resident and saved catalog rows without inventing runtime
 * ancestry from persisted fork metadata. Daemon data remains authoritative;
 * saved data only enriches durable/search fields.
 */
export function reconcileUnifiedSessions(
	daemonSummaries: readonly SessionSummary[],
	savedSessions: readonly AgentConnectionSavedSessionInfo[],
	heartbeats: readonly AgentConnectionHeartbeat[] = [],
	options: ReconcileUnifiedSessionsOptions = {},
): UnifiedSessionRecord[] {
	const heartbeatByActiveId = aggregateSessionHeartbeats(daemonSummaries, heartbeats);
	// One alias derivation per row per pass: it canonicalizes the session file path,
	// and both the reuse check and the rebuild itself key rows by these aliases.
	const aliasesBySummary = daemonSummaries.map((daemon) => summaryIdentityAliases(daemon));
	const reuse = buildRecordReuse(daemonSummaries, aliasesBySummary, options);
	const dirtySessionIds = options.dirtySessionIds;
	const records: UnifiedSessionRecord[] = [];
	const recordByAlias = new Map<string, UnifiedSessionRecord>();

	for (let index = 0; index < daemonSummaries.length; index++) {
		const daemon = daemonSummaries[index]!;
		const aliases = aliasesBySummary[index]!;
		const heartbeat =
			heartbeatByActiveId.get(daemon.activeSessionId ?? daemon.id) ??
			(daemon.hasActiveHeartbeat ? { activeCount: 1 } : undefined);
		// A row the daemon did not touch keeps its record: its corpus, identity and
		// section are all derived from inputs that did not change. The aggregated
		// heartbeat is the one input another row can move (a parent's jobs), so it is
		// compared by value instead of assumed.
		const carried = reuse?.previousBySessionId.get(daemon.sessionId);
		if (
			carried !== undefined &&
			dirtySessionIds !== undefined &&
			!aliases.some((alias) => dirtySessionIds.has(alias)) &&
			heartbeatValuesEqual(carried.heartbeat, heartbeat)
		) {
			records.push(carried);
			for (const alias of aliases) recordByAlias.set(alias, carried);
			continue;
		}
		const record: UnifiedSessionRecord = {
			daemon:
				heartbeat && heartbeat.activeCount > 0 && !daemon.hasActiveHeartbeat
					? { ...daemon, hasActiveHeartbeat: true }
					: daemon,
			identity: aliases[0]!,
			identityAliases: aliases,
			section: "idle",
			...(heartbeat ? { heartbeat } : {}),
		};
		record.section = classifyUnifiedSession(record);
		records.push(record);
		for (const alias of aliases) recordByAlias.set(alias, record);
	}

	for (const saved of savedSessions) {
		const aliases = savedIdentityAliases(saved);
		const record = aliases.map((alias) => recordByAlias.get(alias)).find(Boolean);
		if (record) {
			record.saved = saved;
			record.identityAliases = [...new Set([...record.identityAliases, ...aliases])];
			for (const alias of aliases) recordByAlias.set(alias, record);
			continue;
		}
		const inactive: UnifiedSessionRecord = {
			saved,
			identity: aliases[0]!,
			identityAliases: aliases,
			section: "inactive",
		};
		records.push(inactive);
		for (const alias of aliases) recordByAlias.set(alias, inactive);
	}
	return records;
}

/** Convert a merged row to the existing live-row rendering/action shape. */
export function summaryForUnifiedRecord(record: UnifiedSessionRecord): SessionSummary {
	if (record.daemon) {
		const saved = record.saved;
		if (!saved) return record.daemon;
		return {
			...record.daemon,
			sessionName: record.daemon.sessionName ?? saved.name,
			firstMessage: record.daemon.firstMessage ?? saved.firstMessage,
			usage: record.daemon.usage ?? saved.usage,
			sessionFile: record.daemon.sessionFile ?? canonicalSessionPath(saved.path),
			parentSessionPath: record.daemon.parentSessionPath ?? saved.parentSessionPath,
			rlmDepth: record.daemon.rlmDepth ?? saved.rlmDepth,
			created: record.daemon.created ?? saved.created.toISOString(),
			modified: record.daemon.modified ?? saved.modified.toISOString(),
			lastActivityAt: record.daemon.lastActivityAt ?? saved.modified.toISOString(),
		};
	}
	const saved = record.saved;
	if (!saved) throw new Error("Unified session record has no daemon or saved source");
	return {
		id: saved.id,
		lifecycle: "archived",
		activity: "idle",
		isSessionActive: false,
		runtimeKind: saved.parentSessionPath ? "subagent" : "top-level",
		rlmDepth: saved.rlmDepth,
		sessionId: saved.id,
		sessionFile: canonicalSessionPath(saved.path),
		parentSessionPath: saved.parentSessionPath,
		sessionName: saved.name,
		cwd: saved.cwd,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: saved.messageCount,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		created: saved.created.toISOString(),
		modified: saved.modified.toISOString(),
		lastActivityAt: saved.modified.toISOString(),
		firstMessage: saved.firstMessage,
		summary: saved.agentStatus?.summary,
		taskState: saved.agentStatus?.taskState,
		usage: saved.usage,
	};
}

export function transitionAgentsViewScope(
	frames: readonly AgentsViewScopeFrame[],
	action: AgentsViewScopeAction,
): AgentsViewScopeFrame[] {
	if (action.type === "back") return frames.slice(0, -1);
	const nextFrame = { scope: action.scope, ...(action.returnChat ? { returnChat: action.returnChat } : {}) };
	if (frames.at(-1)?.scope.sessionId !== action.scope.sessionId) return [...frames, nextFrame];
	return [...frames.slice(0, -1), nextFrame];
}

export function resolveAgentsViewLeftResult(
	scopeRoot: SessionSummary | undefined,
	expandedAncestorSessionIds: string[] = [],
	returnChat?: SessionSummary,
): AgentsViewScopeBackResult | undefined {
	if (!scopeRoot) return undefined;
	return {
		type: "scope_back",
		selection: scopeRoot,
		expandedAncestorSessionIds,
		...(returnChat?.sessionId === scopeRoot.sessionId ? { returnChat: scopeRoot } : {}),
	};
}

export function shouldApplyScopeResolution(droppedFrames: number, savedCatalogReady: boolean): boolean {
	return droppedFrames === 0 || savedCatalogReady;
}

export function createUnattachableChildOpenResult(
	child: SessionSummary,
	parent: SessionSummary,
	expandedAncestorSessionIds: readonly string[],
	hasChildren: boolean,
): UnattachableChildOpenResult {
	return {
		type: "open",
		summary: parent,
		selection: child,
		expandedAncestorSessionIds: [...expandedAncestorSessionIds],
		hasChildren,
		statusMessage: "Child session is unavailable; opened its parent instead",
	};
}

export function resolveAgentsViewScopeFrames(
	records: readonly UnifiedSessionRecord[],
	frames: readonly AgentsViewScopeFrame[],
	index: UnifiedSessionIndex = buildUnifiedSessionIndex(records),
): AgentsViewScopeResolution {
	if (frames.length === 0) return { frames: [], droppedFrames: 0 };
	for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex--) {
		const frame = frames[frameIndex]!;
		const root = findScopeRecord(frame.scope, index.byKey);
		if (!root) continue;
		return {
			frames: frames.slice(0, frameIndex + 1),
			root,
			droppedFrames: frames.length - frameIndex - 1,
		};
	}
	return { frames: [], droppedFrames: frames.length };
}

/** Restrict records to the scoped root and every descendant of that root. */
export function scopeToSessionSubtree(
	records: readonly UnifiedSessionRecord[],
	scope: AgentsViewScopeKey | undefined,
	index: UnifiedSessionIndex = buildUnifiedSessionIndex(records),
): UnifiedSessionRecord[] {
	if (!scope) return [...records];
	const root = findScopeRecord(scope, index.byKey);
	if (!root) return [];
	const retained = new Set<UnifiedSessionRecord>();
	const queue = [root];
	for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
		const current = queue[queueIndex]!;
		if (retained.has(current)) continue;
		retained.add(current);
		queue.push(...(index.childrenByParent.get(current) ?? []));
	}
	return records.filter((record) => retained.has(record));
}

export function hasUnifiedSessionChildren(
	records: readonly UnifiedSessionRecord[],
	scope: AgentsViewScopeKey,
	index: UnifiedSessionIndex = buildUnifiedSessionIndex(records),
): boolean {
	const root = findScopeRecord(scope, index.byKey);
	return root !== undefined && (index.childrenByParent.get(root)?.length ?? 0) > 0;
}

export function getUnifiedSessionAncestorSessionIds(
	records: readonly UnifiedSessionRecord[],
	scope: AgentsViewScopeKey,
	index: UnifiedSessionIndex = buildUnifiedSessionIndex(records),
): string[] {
	const root = findScopeRecord(scope, index.byKey);
	if (!root) return [];
	const ancestors: string[] = [];
	const visited = new Set<UnifiedSessionRecord>([root]);
	let current = findParentRecord(root, index.byKey);
	while (current && !visited.has(current)) {
		visited.add(current);
		ancestors.unshift(summaryForUnifiedRecord(current).sessionId);
		current = findParentRecord(current, index.byKey);
	}
	return ancestors;
}

export interface FilterUnifiedSessionsOptions {
	/**
	 * Set when the active query cannot match on row text (an empty search box).
	 * Every corpus read is a 64 KiB join, so a pass that cannot use the text must
	 * not materialize it.
	 */
	skipSearchText?: boolean;
}

export function filterUnifiedSessions(
	records: readonly UnifiedSessionRecord[],
	matches: (searchableText: string) => boolean,
	options: FilterUnifiedSessionsOptions = {},
): UnifiedSessionRecord[] {
	const index = buildUnifiedSessionIndex(records);
	const retained = new Set<UnifiedSessionRecord>();
	for (const record of records) {
		if (!options.skipSearchText && !matches(unifiedSessionSearchableText(record))) continue;
		let current: UnifiedSessionRecord | undefined = record;
		while (current && !retained.has(current)) {
			retained.add(current);
			current = findParentRecord(current, index.byKey);
		}
	}
	// Keep catalog order and the original records so row ranking and sections
	// remain authoritative while ancestors provide the hierarchy for matches.
	return records.filter((record) => retained.has(record));
}

export interface UnifiedSessionIndex {
	byKey: Map<string, UnifiedSessionRecord>;
	childrenByParent: Map<UnifiedSessionRecord, UnifiedSessionRecord[]>;
}

export interface AgentsViewRecursiveRollup {
	/** Own cost plus every descendant's cost. */
	cost: number;
	/** Total descendant sessions (resident + passive) under this record. */
	descendantCount: number;
}

// Rolls costs and descendant counts over the UNFILTERED hierarchy: filters must
// never change a row's totals.
export function computeRecursiveRollups(
	records: readonly UnifiedSessionRecord[],
	index: UnifiedSessionIndex = buildUnifiedSessionIndex(records),
): ReadonlyMap<UnifiedSessionRecord, AgentsViewRecursiveRollup> {
	const order = records.filter((record) => {
		const parent = findParentRecord(record, index.byKey);
		return !parent || parent === record;
	});
	for (let position = 0; position < order.length; position++) {
		for (const child of index.childrenByParent.get(order[position]!) ?? []) {
			order.push(child);
		}
	}
	const rollups = new Map<UnifiedSessionRecord, AgentsViewRecursiveRollup>();
	for (let position = order.length - 1; position >= 0; position--) {
		const record = order[position]!;
		let cost = record.daemon?.usage?.cost ?? record.saved?.usage?.cost ?? 0;
		let descendantCount = 0;
		for (const child of index.childrenByParent.get(record) ?? []) {
			if (!isSubagentDescendantRecord(child, record)) continue;
			const childRollup = rollups.get(child);
			cost += childRollup?.cost ?? 0;
			descendantCount += 1 + (childRollup?.descendantCount ?? 0);
		}
		rollups.set(record, { cost, descendantCount });
	}
	return rollups;
}

/**
 * Rollups follow agent lineage only. A branched/forked session links to its
 * source through parentSession but keeps the source's rlmDepth: it is a
 * sibling chat, not a descendant, and its copied transcript would double-book
 * the source's totals. Spawned subagents carry runtimeKind (resident) or a
 * deeper rlmDepth (saved) and do roll up.
 */
function isSubagentDescendantRecord(child: UnifiedSessionRecord, parent: UnifiedSessionRecord): boolean {
	if (child.daemon) {
		return isSubagentSummary(child.daemon);
	}
	const childDepth = child.saved?.rlmDepth ?? 0;
	return childDepth > (parent.daemon?.rlmDepth ?? parent.saved?.rlmDepth ?? 0);
}

export function buildUnifiedSessionIndex(records: readonly UnifiedSessionRecord[]): UnifiedSessionIndex {
	const byKey = new Map<string, UnifiedSessionRecord>();
	for (const record of records) {
		for (const key of record.identityAliases) byKey.set(key, record);
	}
	const childrenByParent = new Map<UnifiedSessionRecord, UnifiedSessionRecord[]>();
	for (const record of records) {
		const parent = findParentRecord(record, byKey);
		if (!parent || parent === record) continue;
		const children = childrenByParent.get(parent) ?? [];
		children.push(record);
		childrenByParent.set(parent, children);
	}
	return { byKey, childrenByParent };
}

/**
 * Row identities flip when a session gains a sessionFile (active→persisted) or
 * is re-attached; the old identity survives as an alias. Rewrite stale entries
 * in a persisted identity set to the current record identity. Entries with no
 * alias match are kept: their record may not have streamed in yet.
 */
export function migrateAgentsViewIdentitySet(
	identities: Set<string>,
	byKey: ReadonlyMap<string, UnifiedSessionRecord>,
): void {
	for (const identity of [...identities]) {
		const record = byKey.get(identity);
		if (!record || record.identity === identity) continue;
		identities.delete(identity);
		identities.add(record.identity);
	}
}

function findScopeRecord(
	scope: AgentsViewScopeKey,
	byKey: ReadonlyMap<string, UnifiedSessionRecord>,
): UnifiedSessionRecord | undefined {
	if (scope.activeSessionId) {
		const active = byKey.get(`active:${scope.activeSessionId}`);
		if (active) return active;
	}
	return byKey.get(`session:${scope.sessionId}`);
}

function findParentRecord(
	record: UnifiedSessionRecord,
	byKey: ReadonlyMap<string, UnifiedSessionRecord>,
): UnifiedSessionRecord | undefined {
	const daemonKeys = record.daemon ? getParentKeys(record.daemon) : [];
	const savedKey = record.saved?.parentSessionPath ? fileIdentity(record.saved.parentSessionPath) : undefined;
	for (const key of savedKey ? [...daemonKeys, savedKey] : daemonKeys) {
		const parent = byKey.get(key);
		if (parent) return parent;
	}
	return undefined;
}

export function aggregateSessionHeartbeats(
	summaries: readonly SessionSummary[],
	heartbeats: readonly AgentConnectionHeartbeat[],
): ReadonlyMap<string, UnifiedSessionHeartbeat> {
	// Nothing to aggregate for a catalog with no scheduled work: the summary index
	// below canonicalizes a path per row, and most catalogs never have a job.
	const scheduled = heartbeats.filter(
		(heartbeat) => heartbeat.job.status === "active" || heartbeat.job.status === "paused",
	);
	if (scheduled.length === 0) return new Map();
	const summaryByKey = new Map<string, SessionSummary>();
	for (const summary of summaries) {
		for (const key of getSummaryKeys(summary)) summaryByKey.set(key, summary);
	}
	const activeJobIdsByOwner = new Map<string, Set<string>>();
	const pausedJobIdsByOwner = new Map<string, Set<string>>();
	const nextRunByJob = new Map<string, string>();
	const add = (byOwner: Map<string, Set<string>>, owner: string, jobId: string): void => {
		const ids = byOwner.get(owner) ?? new Set<string>();
		ids.add(jobId);
		byOwner.set(owner, ids);
	};
	for (const heartbeat of scheduled) {
		const job = heartbeat.job;
		const byOwner = job.status === "active" ? activeJobIdsByOwner : pausedJobIdsByOwner;
		if (job.status === "active" && job.nextRunAt && Number.isFinite(Date.parse(job.nextRunAt))) {
			nextRunByJob.set(job.id, job.nextRunAt);
		}
		// Passivation stales the job's active id; session id and file still find the owning row.
		let summary: SessionSummary | undefined;
		for (const key of [`active:${job.activeSessionId}`, `session:${job.sessionId}`, fileIdentity(job.sessionFile)]) {
			summary = summaryByKey.get(key);
			if (summary) break;
		}
		const visited = new Set<string>();
		if (!summary) add(byOwner, job.activeSessionId, job.id);
		while (summary) {
			const owner = summary.activeSessionId ?? summary.id;
			if (visited.has(owner)) break;
			visited.add(owner);
			add(byOwner, owner, job.id);
			summary = findParentSummary(summary, summaryByKey);
		}
	}
	const result = new Map<string, UnifiedSessionHeartbeat>();
	for (const owner of new Set([...activeJobIdsByOwner.keys(), ...pausedJobIdsByOwner.keys()])) {
		const jobIds = activeJobIdsByOwner.get(owner) ?? new Set<string>();
		const pausedCount = pausedJobIdsByOwner.get(owner)?.size ?? 0;
		const nextRunAt = [...jobIds]
			.map((jobId) => nextRunByJob.get(jobId))
			.filter((value): value is string => value !== undefined)
			.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
		result.set(owner, {
			activeCount: jobIds.size,
			...(pausedCount > 0 ? { pausedCount } : {}),
			...(nextRunAt ? { nextRunAt } : {}),
		});
	}
	return result;
}

export function formatHeartbeatBadge(heartbeat: UnifiedSessionHeartbeat | undefined, now = Date.now()): string {
	if (!heartbeat) return "";
	if (heartbeat.activeCount < 1) {
		return (heartbeat.pausedCount ?? 0) > 0 ? `♥ ${heartbeat.pausedCount}` : "";
	}
	const next = heartbeat.nextRunAt ? Date.parse(heartbeat.nextRunAt) : Number.NaN;
	const countdown = Number.isFinite(next) ? formatHeartbeatCountdown(next - now) : undefined;
	return `♥ ${heartbeat.activeCount}${countdown ? `·${countdown}` : ""}`;
}

function formatHeartbeatCountdown(durationMs: number): string {
	const seconds = Math.max(1, Math.round(Math.max(0, durationMs) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function findParentSummary(
	summary: SessionSummary,
	byKey: ReadonlyMap<string, SessionSummary>,
): SessionSummary | undefined {
	for (const key of getParentKeys(summary)) {
		const parent = byKey.get(key);
		if (parent) return parent;
	}
	return undefined;
}

function getParentKeys(summary: SessionSummary): string[] {
	return [
		summary.parentActiveSessionId ? `active:${summary.parentActiveSessionId}` : undefined,
		summary.parentSessionId ? `session:${summary.parentSessionId}` : undefined,
		summary.parentSessionPath ? fileIdentity(summary.parentSessionPath) : undefined,
	].filter((key): key is string => key !== undefined);
}

// The parent side of getParentKeys: the keys by which a session is referenced as a parent.
function parentIdentityKeys(summary: {
	activeSessionId?: string | undefined;
	sessionId?: string | undefined;
	sessionFile?: string | undefined;
}): string[] {
	return [
		summary.activeSessionId !== undefined ? `active:${summary.activeSessionId}` : undefined,
		summary.sessionId !== undefined ? `session:${summary.sessionId}` : undefined,
		summary.sessionFile !== undefined ? fileIdentity(summary.sessionFile) : undefined,
	].filter((key): key is string => key !== undefined);
}

/**
 * Every subagent summary descending from the parent session, breadth-first over the shared parent
 * linkage. Rows of any lifecycle link so live descendants stay reachable; callers decide what counts.
 */
export function collectSubagentDescendantSummaries(
	summaries: Iterable<SessionSummary>,
	parent: { activeSessionId?: string | undefined; sessionId?: string | undefined; sessionFile?: string | undefined },
): SessionSummary[] {
	const rowsByParentKey = new Map<string, SessionSummary[]>();
	for (const summary of summaries) {
		if (summary.runtimeKind !== "subagent") continue;
		for (const key of getParentKeys(summary)) {
			const siblings = rowsByParentKey.get(key) ?? [];
			siblings.push(summary);
			rowsByParentKey.set(key, siblings);
		}
	}
	const descendants: SessionSummary[] = [];
	const linked = new Set<SessionSummary>();
	const keyQueue = [...parentIdentityKeys(parent)];
	for (let index = 0; index < keyQueue.length; index++) {
		for (const row of rowsByParentKey.get(keyQueue[index]!) ?? []) {
			if (linked.has(row)) continue;
			linked.add(row);
			descendants.push(row);
			keyQueue.push(...parentIdentityKeys(row));
		}
	}
	return descendants;
}

export function getAgentsViewSummaryIdentity(summary: SessionSummary): string {
	if (summary.runtimeKind === "subagent" && summary.rlmChildId) {
		return `agent:${rosterAgentIdForSummary(summary)}`;
	}
	if (summary.sessionFile) {
		return fileIdentity(summary.sessionFile);
	}
	if (summary.activeSessionId) {
		return `active:${summary.activeSessionId}`;
	}
	return `session:${summary.sessionId}`;
}

export interface AgentsViewSelectionKey {
	sessionId: string;
	activeSessionId?: string;
}

export function getAgentsViewSelectionKey(summary: SessionSummary): AgentsViewSelectionKey {
	return { sessionId: summary.sessionId, activeSessionId: summary.activeSessionId };
}

// Matches by identity, then activeSessionId, then sessionId: a row's identity
// changes when a session is persisted or re-attached, so the latter two keys
// re-find the same session across those transitions. Returns -1 when gone.
export function resolveAgentsViewSelectionIndex(
	rows: readonly AgentsViewRow[],
	identity: string | undefined,
	key: AgentsViewSelectionKey | undefined,
): number {
	const findSelectable = (predicate: (row: AgentsViewRow) => boolean): number =>
		rows.findIndex((row) => row.selectable && predicate(row));

	if (identity !== undefined) {
		const index = findSelectable((row) => row.identity === identity);
		// Synthetic nested rows deliberately reuse their parent's session key, so
		// their exact row identity must win over the active-runtime fallback.
		if (index >= 0 && rows[index]?.kind !== "agent") {
			return index;
		}
	}
	if (key?.activeSessionId !== undefined) {
		const activeSessionId = key.activeSessionId;
		const index = findSelectable((row) => (row.summary.activeSessionId ?? row.summary.id) === activeSessionId);
		if (index >= 0) {
			return index;
		}
	}
	if (identity !== undefined) {
		const index = findSelectable((row) => row.identity === identity);
		if (index >= 0) {
			return index;
		}
	}
	if (key?.sessionId !== undefined) {
		const sessionId = key.sessionId;
		return findSelectable((row) => row.summary.sessionId === sessionId);
	}
	return -1;
}

export interface AgentsViewSelectionResolution {
	index: number;
	resolved: boolean;
}

export function resolveAgentsViewSelectionState(
	rows: readonly AgentsViewRow[],
	currentIndex: number,
	identity: string | undefined,
	key: AgentsViewSelectionKey | undefined,
): AgentsViewSelectionResolution {
	if (rows.length === 0) return { index: 0, resolved: false };
	const resolvedIndex = resolveAgentsViewSelectionIndex(rows, identity, key);
	if (resolvedIndex >= 0) return { index: resolvedIndex, resolved: true };
	const boundedIndex = Math.max(0, Math.min(currentIndex, rows.length - 1));
	if (rows[boundedIndex]?.selectable) return { index: boundedIndex, resolved: false };
	const firstSelectable = rows.findIndex((row) => row.selectable);
	return { index: firstSelectable >= 0 ? firstSelectable : 0, resolved: false };
}

interface AgentsViewRowText {
	summary: SessionSummary;
	title: string;
	subtitle: string;
}

const rowTextByRecord = new WeakMap<UnifiedSessionRecord, AgentsViewRowText>();

/**
 * Row text for one record: the merged summary, its title and its subtitle.
 *
 * All three are pure functions of the record, and a record the daemon did not
 * change is carried across rebuilds, so memoizing here means only dirty rows
 * re-derive their text -- `basename(cwd)` and the title normalizing regex used to
 * run for every row of every catalog pass. Clock-dependent text stays out of the
 * memo: `statusLabel` is recomputed per build, and the animation tick re-derives
 * its relative parts in place through `refreshAgentsViewRowTimeLabels`.
 */
function agentsViewRowText(record: UnifiedSessionRecord): AgentsViewRowText {
	const memo = rowTextByRecord.get(record);
	if (memo !== undefined) return memo;
	const summary = summaryForUnifiedRecord(record);
	const text: AgentsViewRowText = {
		summary,
		title: getAgentsViewSessionTitle(summary),
		subtitle: getSessionSubtitle(summary),
	};
	rowTextByRecord.set(record, text);
	return text;
}

export function buildAgentsViewRows(
	summariesOrRecords: readonly (SessionSummary | UnifiedSessionRecord)[],
	expandedSubagentParents: ReadonlySet<string> = new Set(),
	programShownParents: ReadonlySet<string> = new Set(),
	scope?: AgentsViewScopeKey,
	recursiveRollups?: ReadonlyMap<UnifiedSessionRecord, AgentsViewRecursiveRollup>,
	anchorSessionId?: string,
): AgentsViewRow[] {
	const inputs: { summary: SessionSummary; title: string; subtitle: string; record?: UnifiedSessionRecord }[] =
		summariesOrRecords.map((input) =>
			isUnifiedSessionRecord(input)
				? { ...agentsViewRowText(input), record: input }
				: { summary: input, title: getAgentsViewSessionTitle(input), subtitle: getSessionSubtitle(input) },
		);
	const scopeRoot = scope
		? inputs.find(
				({ summary }) =>
					summary.sessionId === scope.sessionId ||
					(scope.activeSessionId !== undefined && summary.activeSessionId === scope.activeSessionId),
			)
		: undefined;
	const scopeRootKeys = new Set(
		scopeRoot ? (scopeRoot.record?.identityAliases ?? getSummaryKeys(scopeRoot.summary)) : [],
	);
	const isDirectScopeChild = (summary: SessionSummary): boolean =>
		scopeRoot !== undefined && getParentKeys(summary).some((key) => scopeRootKeys.has(key));
	const baseRows = inputs.map(
		({ summary, title, subtitle, record }): MutableAgentsViewRow => ({
			kind: isSubagentSummary(summary) && !isDirectScopeChild(summary) ? "subagent" : "agent",
			section: record?.section ?? classifyAgentsViewSession(summary),
			summary,
			title,
			subtitle,
			statusLabel: getSessionStatusLabel(summary, record?.heartbeat) + getQuietDurationLabel(summary),
			depth: 0,
			selectable: true,
			runningSubagentCount: 0,
			recursiveCost: summary.usage?.cost ?? 0,
			descendantCount: 0,
			identity: record?.identity ?? getAgentsViewSummaryIdentity(summary),
			...(record ? { record, heartbeat: record.heartbeat } : {}),
		}),
	);
	const rowsByKey = buildRowKeyMap(baseRows);
	const childrenByParent = new Map<MutableAgentsViewRow, MutableAgentsViewRow[]>();
	const nestedRows = new Set<MutableAgentsViewRow>();

	for (const row of baseRows) {
		if (row.kind !== "subagent") {
			continue;
		}
		const parent = findParentRow(row.summary, rowsByKey);
		if (!parent || parent === row) {
			// Saved catalogs stream progressively, so a child can arrive before its
			// parent. Keep it reachable as a root until the parent record appears.
			row.kind = "agent";
			continue;
		}
		// One definition of "child" with the rollup walk: a branched/forked
		// session links to its source but is a top-level chat in its own right,
		// so it must not nest (nor count in the expander) while #sub excludes it.
		if (row.record && parent.record && !isSubagentDescendantRecord(row.record, parent.record)) {
			row.kind = "agent";
			continue;
		}
		nestedRows.add(row);
		const siblings = childrenByParent.get(parent) ?? [];
		siblings.push(row);
		childrenByParent.set(parent, siblings);
	}
	// Busy-descendant tally from the live rows: iterative over the parent forest so deep chains cannot overflow.
	const tallyOrder = baseRows.filter((row) => !nestedRows.has(row));
	for (let index = 0; index < tallyOrder.length; index++) {
		for (const child of childrenByParent.get(tallyOrder[index]!) ?? []) {
			tallyOrder.push(child);
		}
	}
	for (let index = tallyOrder.length - 1; index >= 0; index--) {
		const row = tallyOrder[index]!;
		let count = 0;
		let descendantsCost = 0;
		let descendants = 0;
		for (const child of childrenByParent.get(row) ?? []) {
			count += (child.section === "running" ? 1 : 0) + child.runningSubagentCount;
			descendantsCost += child.recursiveCost;
			descendants += 1 + child.descendantCount;
		}
		row.runningSubagentCount = count;
		const rollup = row.record ? recursiveRollups?.get(row.record) : undefined;
		row.recursiveCost = rollup?.cost ?? (row.summary.usage?.cost ?? 0) + descendantsCost;
		row.descendantCount = rollup?.descendantCount ?? descendants;
	}

	const roots = baseRows.filter((row) => !nestedRows.has(row));
	const compareRows = (a: AgentsViewRow, b: AgentsViewRow): number => compareAgentsViewRows(a, b, anchorSessionId);
	const flattened: AgentsViewRow[] = [];
	const emit = (row: MutableAgentsViewRow, depth: number): void => {
		row.depth = depth;
		flattened.push(row);
		// U3: the row's last answer, one muted preview line directly under it
		// (before its subagent list, so the row's own reply reads as its own).
		if (row.summary.answerPreview) {
			flattened.push(createAnswerRow(row, row.summary.answerPreview, depth));
		}
		const children = childrenByParent.get(row) ?? [];
		if (children.length === 0) {
			return;
		}
		const childHasSpawnCode = children.some((child) => hasSpawnCode(child.summary));
		const expanded = expandedSubagentParents.has(row.identity);
		flattened.push(createSubagentSummaryRow(row, children, depth + 1, childHasSpawnCode, expanded));
		if (!expanded) {
			return;
		}
		const showProgram = programShownParents.has(row.identity);
		const groups = groupChildrenBySpawnCode(children.sort(compareRows));
		for (const [groupIndex, group] of groups.entries()) {
			if (showProgram && group.spawnCode) {
				for (const codeRow of buildSpawnCodeRows(row, group.spawnCode, depth + 1, groupIndex)) {
					flattened.push(codeRow);
				}
			}
			for (const child of group.children) {
				child.parentIdentity = row.identity;
				emit(child, depth + 1);
			}
		}
	};
	const scopedRootRow = scopeRoot ? baseRows.find((row) => row.summary === scopeRoot.summary) : undefined;
	const visibleRoots = scopedRootRow ? roots.filter((row) => row !== scopedRootRow) : roots;
	for (const root of visibleRoots.sort(compareRows)) {
		emit(root, 0);
	}
	return flattened;
}

function isUnifiedSessionRecord(value: SessionSummary | UnifiedSessionRecord): value is UnifiedSessionRecord {
	return "identityAliases" in value;
}

type MutableAgentsViewRow = AgentsViewRow;

/**
 * U3: one muted, non-selectable preview line under its session row, mirroring the
 * spawn-code rows: it carries its parent's summary for context but is never a
 * navigation target.
 */
function createAnswerRow(parent: AgentsViewRow, preview: string, depth: number): AgentsViewRow {
	return {
		kind: "answer",
		section: parent.section,
		summary: parent.summary,
		title: preview,
		subtitle: "",
		statusLabel: "",
		depth,
		selectable: false,
		runningSubagentCount: 0,
		recursiveCost: 0,
		descendantCount: 0,
		identity: `answer:${parent.identity}`,
		parentIdentity: parent.identity,
	};
}

function createSubagentSummaryRow(
	parent: AgentsViewRow,
	children: readonly AgentsViewRow[],
	depth: number,
	hasSpawnCode: boolean,
	expanded: boolean,
): AgentsViewRow {
	const totalCount = children.length;
	const running = parent.runningSubagentCount;
	const heartbeatCount = children.filter(
		(child) => child.summary.hasActiveHeartbeat || (child.heartbeat?.activeCount ?? 0) > 0,
	).length;
	// Finished subagents stay reachable through the summary row even when
	// nothing is running anymore.
	const subagentTitle =
		running > 0
			? `${running} ${running === 1 ? "subagent" : "subagents"} running`
			: `${totalCount} ${totalCount === 1 ? "subagent" : "subagents"}`;
	const title =
		heartbeatCount > 0
			? `${subagentTitle} · ${heartbeatCount} ${heartbeatCount === 1 ? "heartbeat" : "heartbeats"} active`
			: subagentTitle;
	return {
		kind: "subagent-summary",
		section: parent.section,
		summary: parent.summary,
		title,
		subtitle: "",
		statusLabel: "",
		depth,
		selectable: true,
		runningSubagentCount: running,
		recursiveCost: 0,
		descendantCount: 0,
		identity: `subagents:${parent.identity}`,
		parentIdentity: parent.identity,
		hasSpawnCode,
		expanded,
	};
}

/**
 * Re-derive only the clock-dependent part of the rows that already exist.
 *
 * The animation tick used to call the full rebuild for this, which re-filters,
 * re-rolls-up, re-nests and re-sorts every record (measured 24-28 ms on a
 * 536-record catalog, every 250 ms) just to move "3m ago" to "4m ago". A row's
 * label is a pure function of its own summary and heartbeat, so it can be
 * recomputed in place. Synthetic rows are skipped: a subagent-summary or
 * subagent-code row carries its parent's summary but a label of its own (""),
 * and recomputing it from the parent would invent text the build never produced.
 *
 * Returns true when at least one label actually changed, which is the only case
 * that needs a render.
 */
export function refreshAgentsViewRowTimeLabels(rows: readonly AgentsViewRow[]): boolean {
	let changed = false;
	for (const row of rows) {
		if (row.kind !== "agent" && row.kind !== "subagent") continue;
		const next = getSessionStatusLabel(row.summary, row.heartbeat) + getQuietDurationLabel(row.summary);
		if (row.statusLabel === next) continue;
		row.statusLabel = next;
		changed = true;
	}
	return changed;
}

function hasSpawnCode(summary: SessionSummary): boolean {
	return typeof summary.spawnCode === "string" && summary.spawnCode.trim().length > 0;
}

interface SpawnCodeGroup {
	/** Shared spawn-cell source for this group, or undefined when unavailable. */
	spawnCode?: string;
	children: MutableAgentsViewRow[];
}

// Subagents spawned by the same Python cell share its source; group them so
// each spawn cell renders once, above the subagents it launched. Different turns
// produce different cells and therefore distinct groups. Insertion order follows
// each cell's first subagent so groups read top-to-bottom in spawn order.
function groupChildrenBySpawnCode(children: readonly MutableAgentsViewRow[]): SpawnCodeGroup[] {
	const NO_CODE_KEY = " no-spawn-code";
	const groups = new Map<string, SpawnCodeGroup>();
	for (const child of children) {
		const code = hasSpawnCode(child.summary) ? child.summary.spawnCode : undefined;
		const key = code ?? NO_CODE_KEY;
		const group = groups.get(key);
		if (group) {
			group.children.push(child);
		} else {
			groups.set(key, { spawnCode: code, children: [child] });
		}
	}
	return [...groups.values()];
}

function buildSpawnCodeRows(
	parent: AgentsViewRow,
	spawnCode: string,
	depth: number,
	groupIndex: number,
): AgentsViewRow[] {
	const makeRow = (code: string, lineIndex: string): AgentsViewRow => ({
		kind: "subagent-code",
		section: parent.section,
		summary: parent.summary,
		title: "",
		subtitle: "",
		statusLabel: "",
		depth,
		// Code rows are read-only context; selection skips over them.
		selectable: false,
		runningSubagentCount: 0,
		recursiveCost: 0,
		descendantCount: 0,
		identity: `code:${parent.identity}:${groupIndex}:${lineIndex}`,
		parentIdentity: parent.identity,
		code,
	});
	const allLines = spawnCode.replace(/\s+$/, "").split("\n");
	// Cap the body so a long program can't flood the view; note the remainder.
	const lines = allLines.slice(0, MAX_SPAWN_CODE_LINES).map((line, i) => makeRow(line, String(i)));
	const hidden = allLines.length - lines.length;
	if (hidden > 0) {
		lines.push(makeRow(`… +${hidden} more ${hidden === 1 ? "line" : "lines"}`, "more"));
	}
	// A blank panel line above and below pads the program into a clean block.
	return [makeRow("", "pad-top"), ...lines, makeRow("", "pad-bottom")];
}

function compareAgentsViewRows(a: AgentsViewRow, b: AgentsViewRow, anchorSessionId?: string): number {
	const sectionDiff = sectionRank(a.section) - sectionRank(b.section);
	if (sectionDiff !== 0) {
		return sectionDiff;
	}
	const emptyDiff = emptySessionRank(a, anchorSessionId) - emptySessionRank(b, anchorSessionId);
	if (emptyDiff !== 0) {
		return emptyDiff;
	}
	if (a.section === "inactive") {
		const heartbeatDiff =
			Number(b.summary.hasActiveHeartbeat ?? false) - Number(a.summary.hasActiveHeartbeat ?? false);
		if (heartbeatDiff !== 0) {
			return heartbeatDiff;
		}
	}
	if (a.section !== "running") {
		const busyDescendantsDiff = Number(b.runningSubagentCount > 0) - Number(a.runningSubagentCount > 0);
		if (busyDescendantsDiff !== 0) {
			return busyDescendantsDiff;
		}
		const activityDiff = getTimestamp(b.summary.lastActivityAt) - getTimestamp(a.summary.lastActivityAt);
		if (activityDiff !== 0) {
			return activityDiff;
		}
	}
	const createdDiff = getTimestamp(b.summary.created) - getTimestamp(a.summary.created);
	if (createdDiff !== 0) {
		return createdDiff;
	}
	const titleDiff = a.title.localeCompare(b.title);
	if (titleDiff !== 0) {
		return titleDiff;
	}
	return a.summary.sessionId.localeCompare(b.summary.sessionId);
}

// Message-less sessions sink to the bottom of their section, except the session
// the view was entered from: it keeps its recency slot so opening the agents
// view from a fresh chat doesn't catapult that chat to the bottom.
function emptySessionRank(row: AgentsViewRow, anchorSessionId: string | undefined): number {
	if (!isEmptyAgentsViewSession(row.summary) || row.summary.sessionId === anchorSessionId) {
		return 0;
	}
	return 1;
}

function buildRowKeyMap(rows: readonly MutableAgentsViewRow[]): Map<string, MutableAgentsViewRow> {
	const rowsByKey = new Map<string, MutableAgentsViewRow>();
	for (const row of rows) {
		for (const key of getSummaryKeys(row.summary)) {
			rowsByKey.set(key, row);
		}
	}
	return rowsByKey;
}

function getSummaryKeys(summary: SessionSummary): string[] {
	return [
		`active:${summary.activeSessionId ?? summary.id}`,
		`session:${summary.sessionId}`,
		summary.sessionFile ? fileIdentity(summary.sessionFile) : undefined,
	].filter((key): key is string => key !== undefined);
}

function findParentRow(
	summary: SessionSummary,
	rowsByKey: ReadonlyMap<string, MutableAgentsViewRow>,
): MutableAgentsViewRow | undefined {
	for (const key of getParentKeys(summary)) {
		const row = rowsByKey.get(key);
		if (row) return row;
	}
	return undefined;
}

export function isSubagentSummary(summary: SessionSummary): boolean {
	if (summary.runtimeKind) {
		return summary.runtimeKind === "subagent";
	}
	// Summaries from daemons that predate runtimeKind still carry subagent
	// linkage; never surface those as top-level agents.
	return Boolean(
		summary.rlmChildId ??
			summary.rlmParentNodeId ??
			summary.parentActiveSessionId ??
			summary.parentSessionId ??
			summary.parentSessionPath,
	);
}

function sectionRank(section: AgentsViewSection): number {
	switch (section) {
		case "running":
			return 0;
		case "idle":
			return 1;
		case "inactive":
			return 2;
		default: {
			const _exhaustive: never = section;
			return _exhaustive;
		}
	}
}

function getTimestamp(value: string | undefined): number {
	if (!value) {
		return 0;
	}
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

/**
 * Busy sessions whose last message activity is older than the stall watchdog's
 * default warn threshold are likely wedged; surface the silence so a stuck
 * "running tools"/"thinking" row does not read as healthy progress.
 */
const QUIET_SESSION_THRESHOLD_MS = 5 * 60_000;

function getQuietDurationLabel(summary: SessionSummary): string {
	// Only sessions that visibly look like they are doing work can read as
	// "stuck" when they go quiet; sessions waiting for input say so already.
	const appearsWorking =
		summary.isStreaming ||
		summary.isCompacting ||
		summary.isRunningTools === true ||
		summary.isBashRunning === true ||
		summary.hasRunningRlmChildren === true;
	if (!appearsWorking) {
		return "";
	}
	const lastActivityAt = getTimestamp(summary.lastActivityAt);
	if (lastActivityAt === 0) {
		return "";
	}
	const quietMs = Date.now() - lastActivityAt;
	if (quietMs < QUIET_SESSION_THRESHOLD_MS) {
		return "";
	}
	const minutes = Math.floor(quietMs / 60_000);
	const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
	return ` (no activity ${duration})`;
}

/**
 * U3: whether the session's current task has settled — the daemon roster fact
 * when the daemon sends it (newer daemons), otherwise the same rule derived from
 * the fields every daemon already carries: no work in flight (turn, streaming,
 * kernel-hosted work folded into `isSessionActive`) and a terminal outcome on
 * record (a completed/error verdict, or a subagent's reply to its parent;
 * needs_input is an open loop, not a conclusion). Undefined when neither side can
 * say — the column renders blank instead of guessing.
 */
export function resolveAgentsViewSettled(summary: SessionSummary): boolean | undefined {
	if (summary.settled !== undefined) return summary.settled;
	if (summary.isStreaming === true || summary.isSessionActive === true || summary.activity === "working") {
		return false;
	}
	// A terminal verdict settles the row; a non-terminal one (needs_input) is an
	// open loop the rule can name, while no verdict at all is unknown.
	if (summary.taskState === "completed" || summary.taskState === "error" || summary.repliedSinceTask === true) {
		return true;
	}
	return summary.taskState !== undefined ? false : undefined;
}

/**
 * U3: the session's wall-clock span in ms — the daemon roster fact when present,
 * otherwise recomputed locally from the timestamps every daemon already carries:
 * created → last activity, or created → now while work is in flight.
 */
export function resolveAgentsViewSessionDurationMs(
	summary: SessionSummary,
	now: number = Date.now(),
): number | undefined {
	if (summary.durationMs !== undefined) return summary.durationMs;
	const start = getTimestamp(summary.created);
	if (start === 0) return undefined;
	const busy = summary.isStreaming === true || summary.isSessionActive === true || summary.activity === "working";
	const end = busy ? now : getTimestamp(summary.lastActivityAt ?? summary.modified) || now;
	return end >= start ? end - start : undefined;
}

/** U3: the settled column's cell — settled, in flight, or unknown (blank). */
export function formatAgentsViewSettledCell(settled: boolean | undefined): string {
	if (settled === true) return "✓";
	if (settled === false) return "…";
	return "";
}

/**
 * U3: duration cell, two units at most (45s, 12m, 1h05m, 3d, 2d4h) so the column
 * stays narrow; blank when the span is unknown.
 */
export function formatAgentsViewDurationMs(durationMs: number | undefined): string {
	if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "";
	const seconds = Math.floor(durationMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest > 0 ? `${hours}h${String(rest).padStart(2, "0")}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	return rest > 0 ? `${days}d${rest}h` : `${days}d`;
}

export function getAgentsViewSessionTitle(summary: SessionSummary): string {
	const candidates = [summary.sessionName, summary.firstMessage, basename(summary.cwd), summary.sessionId, summary.id];
	for (const candidate of candidates) {
		const normalized = candidate?.replace(/\s+/g, " ").trim();
		if (normalized) {
			return normalized;
		}
	}
	return "Untitled agent";
}

function getSessionSubtitle(summary: SessionSummary): string {
	const parts = [
		summary.model ? `${summary.model.provider}/${summary.model.id}` : undefined,
		summary.cwd,
		summary.activeSessionId ?? summary.id,
	].filter((part): part is string => part !== undefined && part.length > 0);
	return parts.join("  ");
}

function getSessionStatusLabel(summary: SessionSummary, heartbeat?: UnifiedSessionHeartbeat): string {
	if (summary.statusLabel !== undefined) {
		return summary.statusLabel;
	}
	if (summary.lastHeardFromAt !== undefined) {
		return `last heard ${formatAgeLabel(summary.lastHeardFromAt)}`;
	}
	// A non-ready worker cannot report fresh runtime flags; its state is the row's story.
	if (summary.workerState !== undefined && summary.workerState !== "ready") {
		return summary.workerState;
	}
	// A stall marker outranks the busy labels: the row is silent rather than
	// progressing, and "thinking" would hide exactly the wedge the watchdog
	// reported (P1-6 roster trace).
	if (summary.stall) {
		const silentMs = summary.stall.silentMs;
		const silent =
			silentMs >= 60_000 ? `${Math.round(silentMs / 60_000)}m` : `${Math.max(1, Math.round(silentMs / 1000))}s`;
		if (summary.stall.unsettled) return `stalled ${silent}, abort did not settle`;
		// B9: silence an unspent exemption is excusing is long work, not a wedge. Neutral wording on
		// purpose - the row must not read as an alarm, and it must not hide the duration either.
		if (summary.stall.excused === true) return `long-running ${silent}`;
		return `stalled ${silent}`;
	}
	if (summary.isCompacting) {
		return "compacting";
	}
	if (summary.isStreaming) {
		return summary.isRunningTools ? "running tools" : "thinking";
	}
	// Both imply a turn in flight, so the display axis (isSessionSummaryDisplayBusy) already
	// classifies the session as Running; the label must agree with the section instead of
	// claiming the session needs input.
	if (summary.isRunningTools === true) {
		return "running tools";
	}
	if (summary.isBashRunning === true) {
		return "running bash";
	}
	if (summary.sessionActions.active) {
		return summary.sessionActions.active.label ?? summary.sessionActions.active.kind.replace("_", " ");
	}
	if (summary.sessionActions.queuedCount > 0) {
		return `${summary.sessionActions.queuedCount} queued`;
	}
	if (summary.lifecycle === "archived") {
		// An archived row that carries an error verdict says so. The row is already in the
		// Inactive section (so "archived" adds nothing) and its recap is the terminal
		// error text, which leaves the failure the recap is about as the one thing the
		// row would hide. The other verdicts keep the lifecycle label.
		return summary.taskState === "error" ? "error" : "archived";
	}
	if (summary.hasActiveHeartbeat) {
		const next = heartbeat?.nextRunAt ? Date.parse(heartbeat.nextRunAt) : Number.NaN;
		return Number.isFinite(next)
			? `heartbeat · next ${formatHeartbeatCountdown(next - Date.now())}`
			: "heartbeat active";
	}
	if (summary.runtimeKind === "subagent" && summary.repliedSinceTask) {
		return "replied";
	}
	if (summary.activity === "working") {
		return "classifying";
	}
	if (summary.taskState === "error") {
		return "error";
	}
	return summary.taskState === "completed" ? "completed" : "needs input";
}
