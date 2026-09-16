import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	realpathSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { EventLog } from "../../core/event-log.js";
import { canonicalSessionPath } from "../../core/session-lease.js";
import { getSessionArtifactPathForFile, readSessionInfo, type SessionInfo } from "../../core/session-manager.js";
import { readFirstLineSync } from "../../utils/file-lines.js";
import { DEFAULT_MAP_CONCURRENCY_LIMIT, mapConcurrent } from "../../utils/map-concurrent.js";

/**
 * Daemon-owned RLM spawn ledger.
 *
 * One append-only JSONL file per sessions dir, written by daemon processes at
 * the moments they admit a spawn, perform a rename, or record a deletion.
 * Family topology (parent/child edges, depths, names) is read back from this
 * file instead of being re-derived from writer-owned session headers,
 * registries, and bodies at read time.
 *
 * Multi-writer reality: the supervisor and each session worker hold their own
 * instance over the same file. Appends are single small O_APPEND writes (well
 * under PIPE_BUF-scale sizes), whose atomicity we rely on for interleaving;
 * reads re-read the whole file per operation, so cross-process staleness is
 * bounded to in-flight appends. In-process appends are serialized on an
 * internal queue.
 */

export const RLM_LEDGER_DIR = "rlm-ledger";

/**
 * Existence probes are metadata-only, so they tolerate a deeper pipeline than a
 * transcript scan does. On a ledger with ~450 live edges a serial walk costs
 * ~90 ms of pure round trips; the same probes overlap into single digits.
 */
const LEDGER_STAT_CONCURRENCY = 32;

/** Bounded read: a ledger beyond these limits fails closed loudly. */
export const RLM_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
export const RLM_LEDGER_MAX_RECORDS = 100_000;

export type RlmLedgerDeleteReason = "user" | "parent-teardown" | "revoked" | "gc";

interface RlmLedgerMetaRecord {
	v: 1;
	op: "meta";
	at: string;
	sessionsDir: string;
}

export interface RlmLedgerSpawnRecord {
	v: 1;
	op: "spawn";
	at: string;
	childId: string;
	parent: string;
	child: string;
	depth: number;
	name: string;
}

export interface RlmLedgerRenameRecord {
	v: 1;
	op: "rename";
	at: string;
	childId: string;
	child: string;
	name: string;
}

export interface RlmLedgerDeleteRecord {
	v: 1;
	op: "delete";
	at: string;
	childId: string;
	child: string;
	reason: RlmLedgerDeleteReason;
}

export type RlmLedgerRecord = RlmLedgerSpawnRecord | RlmLedgerRenameRecord | RlmLedgerDeleteRecord;

/** A live edge after replaying the ledger (last-writer-wins per childId+child). */
export interface RlmLedgerEdge {
	childId: string;
	parent: string;
	child: string;
	depth: number;
	name: string;
	deleted?: RlmLedgerDeleteReason;
}

/** Minimal registry-entry shape the seeder consumes (matches the daemon writer). */
export interface RlmLedgerSeedRegistryEntry {
	childId: string;
	sessionName: string;
	sessionFile: string;
	rlmDepth?: number;
	status: "running" | "completed" | "deleted";
}

export interface LegacyRlmSubagentRegistryEntry extends RlmLedgerSeedRegistryEntry {
	type: "rlm_subagent";
	sessionDir: string;
	parentSessionId: string;
	parentSessionFile?: string;
	rlmMaxDepth?: number;
	rlmParentNodeId?: string;
	prompt?: string;
	spawnCode?: string;
	model?: { provider: string; modelId: string };
	createdAt: number;
	updatedAt: string;
}

export interface RlmLedgerSeedSource {
	readRegistryForSessionFile(sessionFile: string): Promise<RlmLedgerSeedRegistryEntry[]>;
}

export async function readLegacyRlmSubagentRegistry(
	path: string,
	options: { throwOnReadError?: boolean; log?: (message: string) => void } = {},
): Promise<LegacyRlmSubagentRegistryEntry[]> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			options.log?.(
				`failed to read RLM subagent registry: ${error instanceof Error ? error.message : String(error)}`,
			);
			if (options.throwOnReadError) throw error;
		}
		return [];
	}
	const latest = new Map<string, LegacyRlmSubagentRegistryEntry>();
	for (const line of contents.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as Partial<LegacyRlmSubagentRegistryEntry>;
			if (
				entry.type !== "rlm_subagent" ||
				typeof entry.childId !== "string" ||
				typeof entry.sessionName !== "string" ||
				typeof entry.sessionFile !== "string" ||
				(entry.status !== "running" && entry.status !== "completed" && entry.status !== "deleted") ||
				(entry.rlmDepth !== undefined && (!Number.isSafeInteger(entry.rlmDepth) || entry.rlmDepth < 0))
			) {
				continue;
			}
			latest.set(entry.childId, {
				...entry,
				sessionDir: typeof entry.sessionDir === "string" ? entry.sessionDir : dirname(entry.sessionFile),
				// rlmMaxDepth is optional hydration metadata the ledger seeder never
				// reads; a damaged value must not discard the child's topology edge,
				// so it is dropped instead of rejecting the whole entry.
				rlmMaxDepth:
					entry.rlmMaxDepth !== undefined && Number.isSafeInteger(entry.rlmMaxDepth) && entry.rlmMaxDepth >= 0
						? entry.rlmMaxDepth
						: undefined,
			} as LegacyRlmSubagentRegistryEntry);
		} catch (error) {
			options.log?.(
				`ignored malformed RLM subagent registry entry: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return [...latest.values()];
}

export function createRlmLedgerRegistrySeedSource(): RlmLedgerSeedSource {
	return {
		readRegistryForSessionFile: async (sessionFile) => {
			let headerId: string | undefined;
			try {
				const firstLine = readFirstLineSync(sessionFile);
				if (firstLine) {
					const header = JSON.parse(firstLine) as { id?: unknown };
					if (typeof header.id === "string") headerId = header.id;
				}
			} catch {
				return [];
			}
			if (!headerId) return [];
			return readLegacyRlmSubagentRegistry(
				join(getSessionArtifactPathForFile(sessionFile, headerId), "rlm-subagents.jsonl"),
			);
		},
	};
}

/** Canonicalize a directory: realpath when it exists, plain resolve otherwise. */
function canonicalizeDirPath(dir: string): string {
	const resolved = resolve(dir);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

export function rlmLedgerPath(agentDir: string, sessionsDir: string): string {
	const canonical = canonicalizeDirPath(sessionsDir);
	const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
	return join(agentDir, RLM_LEDGER_DIR, `${hash}.jsonl`);
}

function nowIso(): string {
	return new Date().toISOString();
}

function isDeleteReason(value: unknown): value is RlmLedgerDeleteReason {
	return value === "user" || value === "parent-teardown" || value === "revoked" || value === "gc";
}

/**
 * Parse one ledger line. Returns undefined for a well-formed v:1 record with
 * an unknown op (forward-compat: newer writers may add ops; readers skip
 * them). Any other violation throws. Version policy: v !== 1 fails loudly —
 * a future v2 must move to a new file/hash (or accept breaking old readers),
 * because silently skipping records a reader cannot understand would corrupt
 * topology.
 */
function parseLedgerLine(line: string, index: number): RlmLedgerRecord | RlmLedgerMetaRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		throw new Error(
			`Malformed RLM ledger line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const record = parsed as {
		v?: unknown;
		op?: unknown;
		at?: unknown;
		sessionsDir?: unknown;
		childId?: unknown;
		parent?: unknown;
		child?: unknown;
		depth?: unknown;
		name?: unknown;
		reason?: unknown;
	};
	if (record.v !== 1 || typeof record.at !== "string") {
		throw new Error(`Malformed RLM ledger line ${index + 1}: missing v/at`);
	}
	switch (record.op) {
		case "meta":
			if (typeof record.sessionsDir !== "string") {
				throw new Error(`Malformed RLM ledger line ${index + 1}: meta without sessionsDir`);
			}
			return record as unknown as RlmLedgerMetaRecord;
		case "spawn":
			if (
				typeof record.childId !== "string" ||
				typeof record.parent !== "string" ||
				typeof record.child !== "string" ||
				typeof record.name !== "string" ||
				typeof record.depth !== "number" ||
				!Number.isSafeInteger(record.depth) ||
				record.depth < 1
			) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid spawn record`);
			}
			return record as unknown as RlmLedgerSpawnRecord;
		case "rename":
			if (
				typeof record.childId !== "string" ||
				typeof record.child !== "string" ||
				typeof record.name !== "string"
			) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid rename record`);
			}
			return record as unknown as RlmLedgerRenameRecord;
		case "delete":
			if (typeof record.childId !== "string" || typeof record.child !== "string" || !isDeleteReason(record.reason)) {
				throw new Error(`Malformed RLM ledger line ${index + 1}: invalid delete record`);
			}
			return record as unknown as RlmLedgerDeleteRecord;
		default:
			return undefined;
	}
}

function edgeKey(childId: string, child: string): string {
	return `${childId}\u0000${canonicalSessionPath(child)}`;
}

/** Hand every replay its own edges so a caller can never write into the cache. */
function cloneLedgerEdges(edges: Map<string, RlmLedgerEdge>): Map<string, RlmLedgerEdge> {
	return new Map([...edges].map(([key, edge]) => [key, { ...edge }]));
}

interface RlmLedgerReplayCache {
	size: number;
	mtimeMs: number;
	edges: Map<string, RlmLedgerEdge>;
}

/**
 * Per-sessions-dir spawn ledger. All operations are serialized on an internal
 * queue; the first operation lazily seeds a missing ledger from the existing
 * per-parent registries (memoized; a seeding failure degrades to an empty
 * ledger and is never fail-closed).
 */
export class RlmSpawnLedger {
	private readonly path: string;
	private readonly eventLog: EventLog;
	private readonly canonicalSessionsDir: string;
	private queue: Promise<unknown> = Promise.resolve();
	private seedAttempted = false;
	private replayCache?: RlmLedgerReplayCache;

	constructor(
		agentDir: string,
		sessionsDir: string,
		private readonly seedSource?: RlmLedgerSeedSource,
		private readonly log: (message: string) => void = () => {},
	) {
		this.canonicalSessionsDir = canonicalizeDirPath(sessionsDir);
		this.path = rlmLedgerPath(agentDir, sessionsDir);
		this.eventLog = new EventLog(this.path, {
			maxBytes: RLM_LEDGER_MAX_BYTES,
			maxRecords: RLM_LEDGER_MAX_RECORDS,
			log: (message) => this.log(`RLM ledger: ${message}`),
		});
	}

	get ledgerPath(): string {
		return this.path;
	}

	appendSpawn(input: { childId: string; parent: string; child: string; depth: number; name: string }): Promise<void> {
		return this.enqueue(() => this.appendSpawnUnlocked(input));
	}

	appendRename(input: { childId: string; child: string; name: string }): Promise<void> {
		return this.enqueue(async () => {
			await this.appendRecord({
				v: 1,
				op: "rename",
				at: nowIso(),
				childId: input.childId,
				child: canonicalSessionPath(input.child),
				name: input.name,
			});
		});
	}

	/** Rename by child session path alone (offline saved-session rename knows no childId). */
	appendRenameByChildPath(child: string, name: string): Promise<void> {
		return this.enqueue(async () => {
			const target = canonicalSessionPath(child);
			for (const edge of this.replaySync().values()) {
				if (!edge.deleted && canonicalSessionPath(edge.child) === target) {
					await this.appendRecord({
						v: 1,
						op: "rename",
						at: nowIso(),
						childId: edge.childId,
						child: target,
						name,
					});
				}
			}
		});
	}

	appendDelete(input: { childId: string; child: string; reason: RlmLedgerDeleteReason }): Promise<void> {
		return this.enqueue(async () => {
			await this.appendRecord({
				v: 1,
				op: "delete",
				at: nowIso(),
				childId: input.childId,
				child: canonicalSessionPath(input.child),
				reason: input.reason,
			});
		});
	}

	/** Resolves once every operation enqueued so far has completed (durably, for appends). */
	flush(): Promise<void> {
		return this.queue.then(() => undefined);
	}

	/**
	 * Edges as the live view. Deleted edges are filtered by default, and the
	 * default view additionally reconciles against the filesystem: an edge
	 * whose child session directory is gone can never come back - the
	 * transcript, display file and every artifact under it went with the
	 * directory - so it is dropped from the live view even without a tombstone
	 * (r38 LIFE-1: 225 such edges stayed live forever after root teardowns that
	 * predate parent-teardown records). The judgement is lazy and read-side
	 * only: the durable record is unchanged, `edges(true)` still returns the
	 * edge, and cleanup retries can still tombstone it.
	 * `includeDeleted` skips the reconciliation on purpose: consumers of the
	 * raw view (tombstone targeting, cleanup retries) want every record.
	 */
	edges(includeDeleted = false): Promise<RlmLedgerEdge[]> {
		return this.enqueue(async () => {
			const edges = [...this.replaySync().values()].filter((edge) => includeDeleted || !edge.deleted);
			if (includeDeleted || edges.length === 0) return edges;
			return this.dropEdgesWithGoneChildDirsUnlocked(edges);
		});
	}

	/**
	 * The lazy half of the LIFE-1 reconciliation: one directory probe per unique
	 * child session dir, batched like liveEdgesUnlocked()'s probes. Only the
	 * child's directory is asked about, because the form a root teardown leaves
	 * is "directory removed with the artifact tree"; liveEdgesUnlocked()
	 * additionally probes the child and parent transcripts for family rows.
	 */
	private async dropEdgesWithGoneChildDirsUnlocked(edges: RlmLedgerEdge[]): Promise<RlmLedgerEdge[]> {
		const canonical = new Map<string, string>();
		const canonicalOf = (path: string): string => {
			const hit = canonical.get(path);
			if (hit !== undefined) return hit;
			const value = canonicalSessionPath(path);
			canonical.set(path, value);
			return value;
		};
		const statCache = new Map<string, Promise<boolean>>();
		const exists = (dir: string): Promise<boolean> => {
			const inflight = statCache.get(dir);
			if (inflight) return inflight;
			const probe = stat(dir)
				.then((stats) => stats.isDirectory())
				.catch(() => false);
			statCache.set(dir, probe);
			return probe;
		};
		const dirs = [...new Set(edges.map((edge) => dirname(canonicalOf(edge.child))))];
		const present = await mapConcurrent(dirs, LEDGER_STAT_CONCURRENCY, (dir) => exists(dir));
		const liveDirs = new Set(dirs.filter((_dir, index) => present[index]));
		return edges.filter((edge) => liveDirs.has(dirname(canonicalOf(edge.child))));
	}

	/**
	 * Family of every session rooted in this ledger's sessions dir: bounded
	 * readdir of *.jsonl roots as depth-0 rows plus live ledger edges, both
	 * reconciled by stat (a dead parent or child drops the edge). Depths are
	 * verified parent+1 between ledger-known depths; a contradictory edge is
	 * dropped and logged, never fails the whole family.
	 */
	family(): Promise<SessionInfo[]> {
		return this.enqueue(() => this.familyUnlocked());
	}

	/** Same-parent rows for a child session path, including the child itself. */
	siblings(sessionPath: string): Promise<SessionInfo[]> {
		return this.enqueue(async () => {
			const target = canonicalSessionPath(sessionPath);
			const family = await this.familyUnlocked();
			const edges = [...this.replaySync().values()].filter((edge) => !edge.deleted);
			const parentByChild = new Map(
				edges.map((edge) => [canonicalSessionPath(edge.child), canonicalSessionPath(edge.parent)]),
			);
			const parent = parentByChild.get(target);
			if (parent !== undefined) {
				const rows = family.filter((row) => parentByChild.get(canonicalSessionPath(row.path)) === parent);
				// The target's edge can be reconciliation-dropped (parent file
				// gone) while its own file still exists: fall back to presenting
				// the survivor alone rather than an empty set the callers would
				// read as "session not found".
				if (!rows.some((row) => canonicalSessionPath(row.path) === target)) {
					try {
						if ((await stat(target)).isFile()) {
							return [await this.sessionRow(target, 0, undefined, undefined)];
						}
					} catch {
						// fall through to the (possibly empty) sibling rows
					}
				}
				return rows;
			}
			// Roots are siblings of the other roots. A session outside both the
			// ledger and the sessions dir is presented alone (matching the
			// registry-walking reader's behavior for parentless sessions).
			const roots = family.filter((row) => row.rlmDepth === 0);
			if (roots.some((row) => canonicalSessionPath(row.path) === target)) {
				return roots;
			}
			try {
				if (!(await stat(target)).isFile()) return [];
			} catch {
				return [];
			}
			return [await this.sessionRow(target, 0, undefined, undefined)];
		});
	}

	private enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
		const next = this.queue.then(async () => {
			if (!this.seedAttempted) {
				this.seedAttempted = true;
				try {
					await this.seed();
				} catch (error) {
					this.log(`RLM ledger seeding failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return fn();
		});
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async appendSpawnUnlocked(input: {
		childId: string;
		parent: string;
		child: string;
		depth: number;
		name: string;
	}): Promise<void> {
		// Enforce the same invariants parseLedgerLine checks: never write a
		// record this reader would refuse to read back.
		if (!input.childId || !input.parent || !input.child || !Number.isSafeInteger(input.depth) || input.depth < 1) {
			throw new Error(
				`RLM ledger: invalid spawn for ${input.childId || "<missing childId>"} (depth ${input.depth})`,
			);
		}
		const childPath = canonicalSessionPath(input.child);
		// Advisory, per-process: catches double-admission mistakes inside this
		// daemon. It is NOT a global uniqueness guarantee — other processes
		// append to the same file between our read and write.
		for (const edge of this.replaySync().values()) {
			if (!edge.deleted && canonicalSessionPath(edge.child) === childPath && edge.childId !== input.childId) {
				throw new Error(`RLM ledger: duplicate child session path ${childPath} (already ${edge.childId})`);
			}
		}
		await this.appendRecord({
			v: 1,
			op: "spawn",
			at: nowIso(),
			childId: input.childId,
			parent: canonicalSessionPath(input.parent),
			child: childPath,
			depth: input.depth,
			name: input.name,
		});
	}

	/** Live edges reconciled by stat, exactly like family(): a dead parent or child drops the edge. */
	liveEdges(): Promise<RlmLedgerEdge[]> {
		return this.enqueue(() => this.liveEdgesUnlocked());
	}

	private async liveEdgesUnlocked(
		edges = [...this.replaySync().values()].filter((edge) => !edge.deleted),
	): Promise<RlmLedgerEdge[]> {
		// canonicalSessionPath() is a blocking realpath per call, and reconciliation
		// looks at the same edge path several times; canonicalize each one once.
		const canonical = new Map<string, string>();
		const canonicalOf = (path: string): string => {
			const hit = canonical.get(path);
			if (hit !== undefined) return hit;
			const value = canonicalSessionPath(path);
			canonical.set(path, value);
			return value;
		};
		// Probes are deduped in flight rather than after the fact: siblings share a
		// parent path, and a serial walk pays one event-loop round trip per edge on
		// top of the stat itself. Children are probed first so a dead child still
		// spares its parent's stat, exactly as the serial short-circuit did.
		const statCache = new Map<string, Promise<boolean>>();
		const exists = (path: string): Promise<boolean> => {
			const inflight = statCache.get(path);
			if (inflight) return inflight;
			const probe = stat(path)
				.then((stats) => stats.isFile())
				.catch(() => false);
			statCache.set(path, probe);
			return probe;
		};
		const childPaths = [...new Set(edges.map((edge) => canonicalOf(edge.child)))];
		const childAlive = await mapConcurrent(childPaths, LEDGER_STAT_CONCURRENCY, (path) => exists(path));
		const liveChildPaths = new Set(childPaths.filter((_path, index) => childAlive[index]));
		const parentPaths = [
			...new Set(
				edges.filter((edge) => liveChildPaths.has(canonicalOf(edge.child))).map((edge) => canonicalOf(edge.parent)),
			),
		];
		await mapConcurrent(parentPaths, LEDGER_STAT_CONCURRENCY, (path) => exists(path));
		const alive: RlmLedgerEdge[] = [];
		for (const edge of edges) {
			if ((await exists(canonicalOf(edge.child))) && (await exists(canonicalOf(edge.parent)))) {
				alive.push(edge);
			}
		}
		return alive;
	}

	private async familyUnlocked(): Promise<SessionInfo[]> {
		// One replay, one stat snapshot: byChild comes from the same alive set that emits child rows,
		// so a child whose dead edge was reconciled away degrades to a root row instead of vanishing.
		let alive: RlmLedgerEdge[] = await this.liveEdgesUnlocked(
			[...this.replaySync().values()].filter((candidate) => !candidate.deleted),
		);
		const byChild = new Map<string, RlmLedgerEdge>();
		for (const edge of alive) {
			byChild.set(canonicalSessionPath(edge.child), edge);
		}
		const rootPaths: string[] = [];
		let rootEntries: string[] = [];
		try {
			rootEntries = await readdir(this.canonicalSessionsDir);
		} catch {
			rootEntries = [];
		}
		for (const entry of rootEntries.filter((name) => name.endsWith(".jsonl")).sort()) {
			const path = canonicalSessionPath(join(this.canonicalSessionsDir, entry));
			// Ledger children that live directly in the sessions dir are not roots.
			if (byChild.has(path)) continue;
			rootPaths.push(path);
		}
		// Verify depth monotonicity between ledger-known depths only: a root's
		// presented depth of 0 is a display convention, not an assertion (a
		// nested daemon's roots legitimately carry env-derived depths > 0). A
		// contradictory edge is dropped and logged; one bad edge must not fail
		// the whole family.
		const depthByPath = new Map<string, number>();
		for (const edge of alive) {
			depthByPath.set(canonicalSessionPath(edge.child), edge.depth);
		}
		alive = alive.filter((edge) => {
			const parentDepth = depthByPath.get(canonicalSessionPath(edge.parent));
			if (parentDepth !== undefined && edge.depth !== parentDepth + 1) {
				this.log(
					`RLM ledger: dropped edge ${edge.childId} with contradictory depth (parent ${parentDepth}, child ${edge.depth})`,
				);
				return false;
			}
			return true;
		});
		// Row order is the contract here (roots first, then ledger order), so the
		// reads overlap but the results are assembled by index.
		const rootRows = await mapConcurrent(rootPaths, DEFAULT_MAP_CONCURRENCY_LIMIT, (rootPath) =>
			this.sessionRow(rootPath, 0, undefined, undefined),
		);
		const childRows = await mapConcurrent(alive, DEFAULT_MAP_CONCURRENCY_LIMIT, (edge) =>
			this.sessionRow(canonicalSessionPath(edge.child), edge.depth, canonicalSessionPath(edge.parent), edge.name),
		);
		return [...rootRows, ...childRows];
	}

	private async sessionRow(
		path: string,
		depth: number,
		parentPath: string | undefined,
		name: string | undefined,
	): Promise<SessionInfo> {
		// Display-grade fields are best-effort from the ordinary session-info
		// read; topology (path, depth, parent) comes EXCLUSIVELY from the
		// ledger: header-claimed parentSessionPath/rlmDepth (e.g. fork headers)
		// are stripped, never passed through. For roots the ledger carries no
		// name, so the name comes from this read — writer-owned display data,
		// not authority.
		const info = await readSessionInfo(path).catch(() => null);
		if (info) {
			const { parentSessionPath: _headerParent, rlmDepth: _headerDepth, ...display } = info;
			return {
				...display,
				rlmDepth: depth,
				...(parentPath ? { parentSessionPath: parentPath } : {}),
				...(name ? { name } : {}),
			};
		}
		return {
			path,
			id: basename(path, ".jsonl"),
			cwd: "",
			...(name ? { name } : {}),
			...(parentPath ? { parentSessionPath: parentPath } : {}),
			rlmDepth: depth,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "",
			allMessagesText: "",
		};
	}

	private async seed(): Promise<void> {
		if (!this.seedSource || existsSync(this.path)) return;
		let rootEntries: string[] = [];
		try {
			rootEntries = await readdir(this.canonicalSessionsDir);
		} catch {
			return;
		}
		// Collect the complete seed first, then publish it atomically via a
		// temp file + rename: the ledger file only exists once seeding is
		// complete, so an interrupted seed leaves nothing and the next
		// construction re-seeds from scratch. A concurrent process appending
		// before the rename creates the real file on demand and thereby
		// suppresses this seed — the same behavior as any pre-existing ledger.
		const records: RlmLedgerSpawnRecord[] = [];
		const queue: Array<{ sessionFile: string; depth: number }> = rootEntries
			.filter((name) => name.endsWith(".jsonl"))
			.sort()
			.map((name) => ({ sessionFile: join(this.canonicalSessionsDir, name), depth: 0 }));
		const visited = new Set<string>(queue.map((item) => canonicalSessionPath(item.sessionFile)));
		while (queue.length > 0) {
			const { sessionFile, depth } = queue.shift()!;
			for (const entry of await this.seedSource.readRegistryForSessionFile(sessionFile)) {
				if (entry.status === "deleted") continue;
				const childPath = canonicalSessionPath(entry.sessionFile);
				if (visited.has(childPath)) continue;
				visited.add(childPath);
				// A registry depth < 1 (legacy 0-depth entries exist in real data)
				// would be unwritable under the spawn invariants; treat it as
				// absent and derive parent depth + 1 instead of skipping the edge.
				const registryDepth = entry.rlmDepth !== undefined && entry.rlmDepth >= 1 ? entry.rlmDepth : undefined;
				const childDepth = registryDepth ?? depth + 1;
				if (!entry.childId) {
					this.log("RLM ledger: skipped seeding a registry entry without a childId");
					continue;
				}
				records.push({
					v: 1,
					op: "spawn",
					at: nowIso(),
					childId: entry.childId,
					parent: canonicalSessionPath(sessionFile),
					child: childPath,
					depth: childDepth,
					name: entry.sessionName,
				});
				queue.push({ sessionFile: entry.sessionFile, depth: childDepth });
			}
		}
		if (records.length === 0) return;
		const meta: RlmLedgerMetaRecord = { v: 1, op: "meta", at: nowIso(), sessionsDir: this.canonicalSessionsDir };
		const payload = [meta, ...records].map((record) => `${JSON.stringify(record)}\n`).join("");
		// A seed beyond the read bounds would publish a ledger every replaySync
		// refuses to read — manufacturing the exact poisoned state the bounds
		// exist to prevent. Skip seeding entirely (flat families, the documented
		// degradation mode) rather than publishing partial topology: profiles
		// this large are pathological, and a truncated tree would be more
		// confusing than a flat one. Not thrown: a hard error here would stick
		// via seedAttempted and the next append would create an empty ledger.
		if (records.length + 1 > RLM_LEDGER_MAX_RECORDS || Buffer.byteLength(payload) > RLM_LEDGER_MAX_BYTES) {
			this.log(
				`RLM ledger: seed exceeds read bounds (${records.length} records, ${Buffer.byteLength(payload)} bytes); skipping seeding`,
			);
			return;
		}
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tempPath = `${this.path}.seed-${process.pid}-${Date.now()}`;
		const handle = openSync(tempPath, "wx", 0o600);
		try {
			writeSync(handle, payload);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		try {
			this.publishSeedFile(tempPath);
		} finally {
			rmSync(tempPath, { force: true });
		}
	}

	private publishSeedFile(tempPath: string): void {
		// Atomic no-clobber publish: link() fails with EEXIST if a live append
		// created the real file meanwhile — that append wins (its data is
		// fresher than the registries) and the seed is discarded. No-clobber
		// publication is a hard requirement for seeding: post-consolidation,
		// deletes live only in the ledger, so any clobber window can lose live
		// appends and resurrect deleted edges. Filesystems that cannot provide
		// link() therefore get flat pre-ledger history (the documented
		// degradation mode) rather than a check-then-rename race.
		try {
			linkSync(tempPath, this.path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST") {
				return;
			}
			this.log(`RLM ledger: link publish unavailable (${code ?? "unknown"}); skipping seeding`);
		}
	}

	private async appendRecord(record: RlmLedgerRecord): Promise<void> {
		// A stat cannot distinguish an append that lands within the filesystem's
		// mtime granularity, and our own writes are the one case we can rule out
		// for free.
		this.replayCache = undefined;
		// appendAsync (R31-13): the torn-tail observation no longer sleeps the
		// event loop, and an append refused against a live foreign writer is
		// retried once instead of being lost.
		await this.eventLog.appendAsync([record], {
			durable: true,
			onCreate: () => [
				{ v: 1, op: "meta", at: nowIso(), sessionsDir: this.canonicalSessionsDir } satisfies RlmLedgerMetaRecord,
			],
		});
	}

	/**
	 * Replay the ledger, reusing the previous replay while the file on disk is
	 * unchanged.
	 *
	 * Every ledger question — edges, siblings, family, duplicate admission —
	 * replays from scratch, and a daemon listing sessions asks several times per
	 * request. Each replay is a synchronous whole-file read plus a JSON parse per
	 * record, on the event loop.
	 *
	 * Other processes append to this same file, so the guard is the file's own
	 * size and mtime rather than our own writes. The size stat is required for
	 * the read bound anyway, which makes the check free. Records only ever
	 * append, and a tail repair blanks the torn fragment in place, so a change
	 * moves the size (an append) or the mtime (a repair) and never neither.
	 */
	private replaySync(): Map<string, RlmLedgerEdge> {
		const edges = new Map<string, RlmLedgerEdge>();
		if (!existsSync(this.path)) {
			this.replayCache = undefined;
			return edges;
		}
		const stats = statSync(this.path);
		const size = stats.size;
		if (size > RLM_LEDGER_MAX_BYTES) {
			throw new Error(`RLM ledger ${this.path} exceeds ${RLM_LEDGER_MAX_BYTES} bytes (${size}); refusing to read`);
		}
		const cached = this.replayCache;
		if (cached && cached.size === size && cached.mtimeMs === stats.mtimeMs) {
			return cloneLedgerEdges(cached.edges);
		}
		const records = this.eventLog.replaySync((line, index) => {
			let record: RlmLedgerRecord | RlmLedgerMetaRecord | undefined;
			try {
				record = parseLedgerLine(line, index);
			} catch (error) {
				// Name the file. The ledger path is a hash of the sessions dir, so
				// "malformed line 41" on its own does not tell anybody which ledger to
				// look at — and this error is fail-closed, so the one action that would
				// restore spawning, deletion and delete_saved_session is finding that
				// file. Guessing wrong destroys another project's tombstones.
				throw new Error(
					`${error instanceof Error ? error.message : String(error)} (ledger ${this.path}, sessions dir ${this.canonicalSessionsDir})`,
				);
			}
			if (record === undefined) {
				this.log(`RLM ledger: skipped record with unknown op on line ${index + 1}`);
			}
			return record;
		});
		for (const record of records) {
			if (record.op === "meta") continue;
			const key = edgeKey(record.childId, record.child);
			switch (record.op) {
				case "spawn":
					edges.set(key, {
						childId: record.childId,
						parent: record.parent,
						child: record.child,
						depth: record.depth,
						name: record.name,
					});
					break;
				case "rename": {
					const existing = edges.get(key);
					if (existing) existing.name = record.name;
					break;
				}
				case "delete": {
					const existing = edges.get(key);
					if (existing) existing.deleted = record.reason;
					break;
				}
			}
		}
		this.replayCache = { size, mtimeMs: stats.mtimeMs, edges };
		return cloneLedgerEdges(edges);
	}
}

// The catalog scan never visits session-artifacts, where RLM children persist:
// without this merge a passivated descendant's row (and its spend) survives only
// as long as some resident roster remembers it.
export async function withPassiveRlmDescendantInfos(
	savedSessions: SessionInfo[],
	ledger: RlmSpawnLedger,
	options: { cwd?: string; onSession?: (info: SessionInfo) => void; log?: (message: string) => void } = {},
): Promise<SessionInfo[]> {
	const sessions = [...savedSessions];
	const seen = new Set(savedSessions.map((info) => canonicalSessionPath(info.path)));
	let edges: RlmLedgerEdge[];
	try {
		edges = await ledger.liveEdges();
	} catch (error) {
		// A broken ledger must not take the whole catalog down with it.
		options.log?.(`Could not merge passive RLM descendants: ${String(error)}`);
		return sessions;
	}
	// Dedupe first, then read the survivors concurrently and emit them through the
	// in-order callback: same rows, same order, same progressive streaming as the
	// serial walk, without one event-loop round trip per edge. On a real ledger
	// (450+ passive descendants, 750+ MB of transcripts) this leg dominated the
	// cost of opening the agents view.
	const candidates: Array<{ edge: RlmLedgerEdge; childPath: string }> = [];
	for (const edge of edges) {
		const childPath = canonicalSessionPath(edge.child);
		if (seen.has(childPath)) continue;
		seen.add(childPath);
		candidates.push({ edge, childPath });
	}
	await mapConcurrent(
		candidates,
		DEFAULT_MAP_CONCURRENCY_LIMIT,
		(candidate) => readSessionInfo(candidate.childPath),
		(info, index) => {
			if (!info) return;
			if (options.cwd !== undefined && (!info.cwd || resolve(info.cwd) !== resolve(options.cwd))) return;
			const edge = candidates[index]!.edge;
			// The ledger edge is the authoritative topology (family() semantics); a fork
			// can leave the transcript header pointing at a dead ancestor path.
			const merged: SessionInfo = {
				...info,
				parentSessionPath: edge.parent,
				rlmDepth: edge.depth,
			};
			sessions.push(merged);
			options.onSession?.(merged);
		},
	);
	return sessions;
}

// Shared user-delete policy: only a readable no-parent transcript is positively top-level; children and
// unknown targets tombstone via the ledger BEFORE the file delete (a tombstoned-but-undeleted file is
// the accepted orphan of a failed delete).
export async function tombstoneSavedSessionDelete(
	ledger: RlmSpawnLedger,
	sessionPath: string,
	knownSummary: { runtimeKind?: "top-level" | "subagent" } | undefined,
): Promise<{ deletedInfo: SessionInfo | undefined; ledgerEdge: RlmLedgerEdge | undefined }> {
	const deletedPath = canonicalSessionPath(sessionPath);
	const deletedInfo = (await readSessionInfo(sessionPath).catch(() => null)) ?? undefined;
	const knownChild =
		knownSummary?.runtimeKind === "subagent" ||
		deletedInfo?.parentSessionPath !== undefined ||
		(deletedInfo?.rlmDepth ?? 0) > 0;
	const positivelyTopLevel = !knownChild && (knownSummary !== undefined || deletedInfo !== undefined);
	// Raw view on purpose (`edges(true)` plus the not-deleted filter): tombstoning
	// is a write path, and the default edges() view drops edges whose child
	// directory is gone - exactly the edges a retrying deletion is supposed to
	// make durable.
	const rawEdges = async (): Promise<RlmLedgerEdge[]> => (await ledger.edges(true)).filter((edge) => !edge.deleted);
	if (positivelyTopLevel) {
		// A root teardown removes the whole artifact tree - every child transcript,
		// display file and artifact directory under it - without any child-level
		// delete path running. Mirror the child-delete precedent (display tombstone
		// plus ledger delete BEFORE the file remove, daemon-mode.ts) at the root:
		// tombstone the direct child edges before the recursive remove, or they stay
		// raw-live forever (r38 LIFE-1: 225 dead edges / 10 parents on the real
		// ledger). "parent-teardown" is the durable distinction from a user delete.
		// Best-effort by design: the root's own delete is safe without these records
		// (the children's directories die with the tree and the live view reconciles
		// the edges away read-side), so an unreadable ledger must not fail a root
		// deletion the way it fails a child deletion.
		try {
			const children = (await rawEdges()).filter((edge) => canonicalSessionPath(edge.parent) === deletedPath);
			for (const edge of children) {
				await ledger.appendDelete({ childId: edge.childId, child: edge.child, reason: "parent-teardown" });
			}
		} catch {
			// The tombstones stay unwritten; the dead edges keep healing through the
			// read-side reconciliation until a retrying delete succeeds.
		}
		return { deletedInfo, ledgerEdge: undefined };
	}
	// Tombstone every matching edge: a duplicate edge for the path (corrupt or raced appends) left
	// live would resurrect a later recreation at that path as a subagent.
	const matching = (await rawEdges()).filter((edge) => canonicalSessionPath(edge.child) === deletedPath);
	for (const edge of matching) {
		await ledger.appendDelete({ childId: edge.childId, child: sessionPath, reason: "user" });
	}
	return { deletedInfo, ledgerEdge: matching[0] };
}
