// Equivalence compaction for the daemon RLM spawn ledger.
//
// The ledger is append-only and authoritative for child topology, so it grows
// without bound: past `RLM_LEDGER_MAX_*` every reader fails closed
// ("refusing to read"), which takes spawning, deletion and the session catalog
// down with it (r41 ADC-2). The ladder this module implements is "delete the
// old, refuse the new only as a last resort": replay the whole file, reduce it
// to one terminal record set per edge, and atomically publish that — a rewrite
// no reader can observe a difference in (see the equivalence assertions in
// test/rlm-ledger-compaction.test.ts).
//
// Two callers share it: the writer (`RlmSpawnLedger.appendRecord`, which
// compacts before refusing an append) and the retention sweep class
// `rlm-ledger-compaction` (which picks up over-bound files left behind by
// older binaries). Both live behind the same proper-lockfile guard shape the
// orphan process journal uses, and the guard is held only for the rewrite —
// the append hot path stays lock-free and relies on O_APPEND atomicity.
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { lockSync } from "proper-lockfile";
import { EventLog } from "./event-log.js";
import { RLM_LEDGER_MAX_BYTES, RLM_LEDGER_MAX_RECORDS } from "./rlm-ledger-bounds.js";
import { canonicalSessionPath } from "./session-lease.js";

export type RlmLedgerDeleteReason = "user" | "parent-teardown" | "revoked" | "gc";

export interface RlmLedgerMetaRecord {
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

/** Read/write bounds of one ledger file. */
export interface RlmLedgerBounds {
	maxBytes: number;
	maxRecords: number;
}

export const DEFAULT_RLM_LEDGER_BOUNDS: RlmLedgerBounds = {
	maxBytes: RLM_LEDGER_MAX_BYTES,
	maxRecords: RLM_LEDGER_MAX_RECORDS,
};

/** Lock lifetime after which a crashed compactor's guard may be stolen. */
const LEDGER_GUARD_STALE_MS = 30_000;

/**
 * The last rung of the ADC-2 ladder: the ledger holds more live topology than
 * the bounds allow, so equivalence compaction cannot make room for the next
 * record and the append is refused. Typed so callers can show the operator the
 * live-edge count, the bound and the way out instead of a bare stack.
 */
export class RlmLedgerOverBoundError extends Error {
	readonly ledgerPath: string;
	readonly liveEdges: number;
	readonly bounds: RlmLedgerBounds;
	readonly projectedBytes: number;
	readonly projectedRecords: number;

	constructor(input: {
		ledgerPath: string;
		liveEdges: number;
		bounds: RlmLedgerBounds;
		projectedBytes: number;
		projectedRecords: number;
	}) {
		super(
			`RLM ledger ${input.ledgerPath} is over its bound: ${input.liveEdges} live edge(s) already need ` +
				`${input.projectedRecords} record(s) / ${input.projectedBytes} bytes, and the limits are ` +
				`${input.bounds.maxRecords} records / ${input.bounds.maxBytes} bytes. Equivalence compaction ran and ` +
				"could not make room, so this spawn/delete is refused. Reduce the live topology (delete idle " +
				"sub-agents or their parent sessions) or raise the ledger bounds; `prime-agent retention sweep` " +
				"compacts over-bound ledgers opportunistically.",
		);
		this.name = "RlmLedgerOverBoundError";
		this.ledgerPath = input.ledgerPath;
		this.liveEdges = input.liveEdges;
		this.bounds = input.bounds;
		this.projectedBytes = input.projectedBytes;
		this.projectedRecords = input.projectedRecords;
	}
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
export function parseRlmLedgerLine(line: string, index: number): RlmLedgerRecord | RlmLedgerMetaRecord | undefined {
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

/** Edge identity: childId plus the canonical child session path. */
export function rlmLedgerEdgeKey(childId: string, child: string): string {
	return `${childId}\u0000${canonicalSessionPath(child)}`;
}

/**
 * The one authoritative replay reduction: spawn creates the edge, rename
 * rewrites its name, delete tombstones it, and a rename/delete without a
 * preceding spawn is a no-op (there is no edge to modify). Insertion order is
 * the replay order, which is what `edges()` reports.
 */
export function reduceRlmLedgerEdges(
	records: readonly (RlmLedgerRecord | RlmLedgerMetaRecord)[],
): Map<string, RlmLedgerEdge> {
	const edges = new Map<string, RlmLedgerEdge>();
	for (const record of records) {
		if (record.op === "meta") continue;
		const key = rlmLedgerEdgeKey(record.childId, record.child);
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
	return edges;
}

/**
 * The LIFE-1 death predicate, sync: a deleted edge is kept only while the
 * child's session directory still exists (`dropEdgesWithGoneChildDirsUnlocked`
 * probes exactly `dirname(canonicalSessionPath(child))` for a directory). Once
 * the directory is gone the read-side reconciliation already drops the edge,
 * so its tombstone is replay-invisible and can be retired.
 */
export function rlmLedgerChildDirExists(child: string): boolean {
	try {
		return statSync(dirname(canonicalSessionPath(child))).isDirectory();
	} catch {
		return false;
	}
}

export interface RlmLedgerCompactionOptions {
	bounds?: RlmLedgerBounds;
	/** Canonical sessions dir written into the meta line of a file that has none. */
	sessionsDir: string;
	/** Death predicate for tombstones (default: {@link rlmLedgerChildDirExists}). */
	childDirExists?: (child: string) => boolean;
	log?: (message: string) => void;
	/** Stamp for rewritten records (default: the compaction's own clock). */
	now?: () => string;
}

export interface RlmLedgerCompactionResult {
	/** False when there was no file to compact. */
	compacted: boolean;
	/** False when the rewrite was abandoned (still over bound, or the file moved). */
	published: boolean;
	beforeBytes: number;
	beforeRecords: number;
	afterBytes: number;
	afterRecords: number;
	/** Records the reduction proved replay-invisible. */
	droppedRecords: number;
	liveEdges: number;
	/** Tombstones kept because the child directory still exists. */
	keptDeletes: number;
	/** Tombstones retired because the child directory is gone. */
	droppedDeletes: number;
	/** True when the published file still exceeds a bound (not published then). */
	overBound: boolean;
	/** Reason the rewrite was abandoned, for the sweep report. */
	aborted?: "over-bound" | "moved";
}

const EMPTY_RESULT: RlmLedgerCompactionResult = {
	compacted: false,
	published: false,
	beforeBytes: 0,
	beforeRecords: 0,
	afterBytes: 0,
	afterRecords: 0,
	droppedRecords: 0,
	liveEdges: 0,
	keptDeletes: 0,
	droppedDeletes: 0,
	overBound: false,
};

/** Whether one ledger file exceeds a bound (size by stat, records by line count). */
export function rlmLedgerFileOverBound(path: string, bounds: RlmLedgerBounds = DEFAULT_RLM_LEDGER_BOUNDS): boolean {
	const projection = projectRlmLedgerFile(path, bounds);
	return projection.overBound;
}

/** Physical projection of one ledger file: bytes by stat, records by newline scan. */
export function projectRlmLedgerFile(
	path: string,
	bounds: RlmLedgerBounds = DEFAULT_RLM_LEDGER_BOUNDS,
): { exists: boolean; bytes: number; records: number; overBound: boolean } {
	let bytes = 0;
	try {
		bytes = statSync(path).size;
	} catch {
		return { exists: false, bytes: 0, records: 0, overBound: false };
	}
	if (bytes > bounds.maxBytes) {
		// Past the byte bound the exact record count cannot change the verdict,
		// and reading it would allocate exactly what the bound exists to prevent.
		return { exists: true, bytes, records: Number.MAX_SAFE_INTEGER, overBound: true };
	}
	const records = countLedgerLines(path, bytes);
	return { exists: true, bytes, records, overBound: records > bounds.maxRecords };
}

/** Newline count of a file whose size the caller already knows (chunked, no full allocation). */
function countLedgerLines(path: string, size: number): number {
	if (size <= 0) return 0;
	const CHUNK = 64 * 1024;
	let descriptor: number;
	try {
		descriptor = openSync(path, "r");
	} catch {
		return 0;
	}
	try {
		const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size));
		let lines = 0;
		let offset = 0;
		let lastByteNewline = true;
		while (offset < size) {
			const read = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
			if (read <= 0) break;
			for (let index = 0; index < read; index++) {
				if (buffer[index] === 0x0a) lines += 1;
			}
			lastByteNewline = buffer[read - 1] === 0x0a;
			offset += read;
		}
		// A final unterminated fragment is still one record to a reader (and to
		// the writer's bound), so it counts. Blank lines over-count against the
		// reader's non-blank count, which is the conservative direction.
		if (!lastByteNewline && offset > 0) lines += 1;
		return lines;
	} finally {
		closeSync(descriptor);
	}
}

/**
 * Compact one ledger file to its replay-equivalent terminal record set.
 *
 * Held under a proper-lockfile guard for the whole rewrite. The published file
 * is a temp + fsync + rename, and the rename is abandoned when the source moved
 * (size or mtime) while it was being built: a mixed-version binary appends
 * without the guard, and losing its record is exactly what the re-stat prevents.
 * No `.bak` generation is left behind — the equivalence assertions plus the
 * atomic rename are the safety net, and a stray backup is one more file shape
 * the retention classes would have to own.
 */
export function compactRlmLedgerFile(path: string, options: RlmLedgerCompactionOptions): RlmLedgerCompactionResult {
	const bounds = options.bounds ?? DEFAULT_RLM_LEDGER_BOUNDS;
	const childDirExists = options.childDirExists ?? rlmLedgerChildDirExists;
	const now = options.now ?? (() => new Date().toISOString());
	return withLedgerCompactionGuard(path, () => {
		let snapshot: { size: number; mtimeMs: number };
		try {
			const stats = statSync(path);
			snapshot = { size: stats.size, mtimeMs: stats.mtimeMs };
		} catch {
			return { ...EMPTY_RESULT };
		}
		// Unbounded on purpose: this file is beyond the reader bounds by
		// definition, and EventLog's torn-final-line tolerance has to match the
		// writer's so a crashed append is dropped rather than poisoning the rewrite.
		const reader = new EventLog(path, { log: options.log });
		const records = reader.replaySync((line, index) => parseRlmLedgerLine(line, index));
		const edges = reduceRlmLedgerEdges(records);
		const meta = records.find((record): record is RlmLedgerMetaRecord => record.op === "meta");
		const lines: string[] = [
			`${JSON.stringify({
				v: 1,
				op: "meta",
				at: meta?.at ?? now(),
				sessionsDir: meta?.sessionsDir ?? options.sessionsDir,
			} satisfies RlmLedgerMetaRecord)}\n`,
		];
		let liveEdges = 0;
		let keptDeletes = 0;
		let droppedDeletes = 0;
		for (const edge of edges.values()) {
			const spawn: RlmLedgerSpawnRecord = {
				v: 1,
				op: "spawn",
				at: now(),
				childId: edge.childId,
				parent: edge.parent,
				child: edge.child,
				depth: edge.depth,
				name: edge.name,
			};
			if (!edge.deleted) {
				liveEdges += 1;
				lines.push(`${JSON.stringify(spawn)}\n`);
				continue;
			}
			if (!childDirExists(edge.child)) {
				// The child directory is gone: the read-side reconciliation already
				// drops this edge from every live view, and the retry paths that read
				// the raw view can no longer find artifacts to sweep either.
				droppedDeletes += 1;
				continue;
			}
			keptDeletes += 1;
			lines.push(`${JSON.stringify(spawn)}\n`);
			lines.push(
				`${JSON.stringify({
					v: 1,
					op: "delete",
					at: now(),
					childId: edge.childId,
					child: edge.child,
					reason: edge.deleted,
				} satisfies RlmLedgerDeleteRecord)}\n`,
			);
		}
		const payload = lines.join("");
		const afterBytes = Buffer.byteLength(payload);
		const afterRecords = lines.length;
		const base: RlmLedgerCompactionResult = {
			...EMPTY_RESULT,
			compacted: true,
			beforeBytes: snapshot.size,
			beforeRecords: records.length,
			afterBytes,
			afterRecords,
			droppedRecords: Math.max(0, records.length - afterRecords),
			liveEdges,
			keptDeletes,
			droppedDeletes,
		};
		if (afterBytes > bounds.maxBytes || afterRecords > bounds.maxRecords) {
			// The terminal record set itself does not fit: publishing would rewrite
			// the authority file without restoring readability, so the ladder's last
			// rung (refuse the new record) is the caller's to pull.
			options.log?.(
				`RLM ledger compaction: ${path} still over bound after reduction ` +
					`(${afterRecords} records, ${afterBytes} bytes); leaving the file untouched`,
			);
			return { ...base, published: false, overBound: true, aborted: "over-bound" };
		}
		const tempPath = `${path}.compact-${process.pid}-${Date.now()}`;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeLedgerFileAtomic(tempPath, payload);
		let current: { size: number; mtimeMs: number };
		try {
			const stats = statSync(path);
			current = { size: stats.size, mtimeMs: stats.mtimeMs };
		} catch {
			current = { size: -1, mtimeMs: -1 };
		}
		if (current.size !== snapshot.size || current.mtimeMs !== snapshot.mtimeMs) {
			// Somebody appended while the rewrite was being built. Their record is
			// not in this payload, so the rewrite is abandoned rather than published.
			removeQuietly(tempPath);
			options.log?.(`RLM ledger compaction: ${path} changed during compaction; abandoned the rewrite`);
			return { ...base, published: false, aborted: "moved" };
		}
		renameSync(tempPath, path);
		fsyncDirSync(dirname(path));
		options.log?.(
			`RLM ledger compaction: ${path} ${snapshot.size} -> ${afterBytes} bytes, ` +
				`${records.length} -> ${afterRecords} records (${liveEdges} live, ${keptDeletes} tombstone(s) kept, ` +
				`${droppedDeletes} retired)`,
		);
		return { ...base, published: true };
	});
}

function writeLedgerFileAtomic(tempPath: string, payload: string): void {
	const handle = openSync(tempPath, "wx", 0o600);
	try {
		writeSync(handle, payload);
		fsyncSync(handle);
	} finally {
		closeSync(handle);
	}
}

function fsyncDirSync(dir: string): void {
	let handle: number;
	try {
		handle = openSync(dir, "r");
	} catch {
		return;
	}
	try {
		fsyncSync(handle);
	} catch {
		// Directory fsync is a durability nicety; a platform that refuses it must
		// not fail a compaction that already renamed successfully.
	} finally {
		closeSync(handle);
	}
}

function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// A leftover temp is a `.compact-*` sibling no reader scans; the next
		// compaction attempt writes a fresh name.
	}
}

/**
 * Every mutation of a ledger file holds one guard: a compaction must not
 * replace a file another compactor is rewriting. Same shape as
 * `withJournalGuard` in orphan-process-journal.ts (20 attempts, 10 ms apart,
 * stale broken by proper-lockfile). Lock failures propagate: the caller decides
 * whether they are fatal (an explicit sweep compaction logs them, an append
 * ladder refuses the record).
 */
function withLedgerCompactionGuard<T>(path: string, work: () => T): T {
	let release: (() => void) | undefined;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			release = lockSync(path, {
				realpath: false,
				lockfilePath: `${path}.guard`,
				stale: LEDGER_GUARD_STALE_MS,
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") throw error;
			if (attempt === 19) throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (!release) throw new Error(`Could not lock RLM ledger for compaction: ${path}`);
	try {
		return work();
	} finally {
		release();
	}
}

/** Ledger files of one agent dir, sorted (the sweep class's scan unit). */
export function listRlmLedgerFiles(agentDir: string, ledgerDirName = "rlm-ledger"): string[] {
	const dir = join(agentDir, ledgerDirName);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(dir, name));
}
