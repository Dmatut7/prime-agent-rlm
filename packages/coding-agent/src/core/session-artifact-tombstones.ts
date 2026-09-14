// Session artifact tombstones: the same-source signal that a session's artifact
// directory was deleted on purpose.
//
// Why this exists (round-08 S1): an artifact directory removed by a delete is
// recreated by read paths (`getSessionArtifactDir()` used to default to
// `create: true`, and the cron store's lock helper mkdirs the parent of every
// store path it touches), so the cron store's self-destruct test never fired and
// a deleted session's registration lived for the life of the process.
// Tombstones give every one of those paths the same fact to read.
//
// Scope: one JSONL file per artifact root (`<artifactRoot>/.session-tombstones.jsonl`),
// because a child session's artifact root is `<parentArtifactRoot>/session-artifacts`
// and no single global agent dir is derivable from a nested session path. The file
// name cannot be confused with a session id: the session id pattern rejects a
// leading dot.
//
// Staleness: a tombstone is *in force* only while nothing has been written into
// the directory since the deletion. A new session may legally reuse an id (red
// test R-6), and its first write into the directory lands after `deletedAt`, so
// the in-force window closes by itself. Everything here is conservative in the
// same direction as kernel/venv-in-use.ts: a tombstone that cannot be read, or a
// directory whose age cannot be established, keeps the directory.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendPrivateFile, writePrivateFileAtomicLines } from "../utils/private-files.js";
import { isValidSessionId } from "./session-id.js";

/** File name of the per-root tombstone log. Not a valid session id (leading dot). */
export const SESSION_ARTIFACT_TOMBSTONE_FILENAME = ".session-tombstones.jsonl";

// The log is append-only. An earlier version compacted it in place once it grew past
// a record count, which is a lock-free read-modify-write: two processes appending at
// the same time would lose one record, and a lost tombstone resurrects a deleted
// session's directory (adversarial review N-6). A record is ~90 bytes and one delete
// writes one, so the log stays small enough to leave alone.

const RECORD_VERSION = 1;

export interface SessionArtifactTombstone {
	sessionId: string;
	/** When the delete happened; the in-force window is "nothing written since". */
	deletedAt: string;
	reason?: string;
}

export function sessionArtifactTombstonePath(artifactRoot: string): string {
	return join(artifactRoot, SESSION_ARTIFACT_TOMBSTONE_FILENAME);
}

interface CachedTombstones {
	mtimeMs: number;
	size: number;
	records: Map<string, SessionArtifactTombstone>;
}

const cache = new Map<string, CachedTombstones>();

/** Test hook: drop the per-root parse cache (tests rewrite tombstone files by hand). */
export function resetSessionArtifactTombstoneCache(): void {
	cache.clear();
}

function parseTombstoneLine(line: string): SessionArtifactTombstone | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as { version?: unknown; sessionId?: unknown; deletedAt?: unknown; reason?: unknown };
	if (record.version !== RECORD_VERSION) return undefined;
	if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return undefined;
	if (typeof record.deletedAt !== "string" || Number.isNaN(Date.parse(record.deletedAt))) return undefined;
	return {
		sessionId: record.sessionId,
		deletedAt: record.deletedAt,
		...(typeof record.reason === "string" ? { reason: record.reason } : {}),
	};
}

/**
 * Tombstones recorded for one artifact root, newest record per session id.
 * An unreadable or malformed log yields no records: the callers that use this
 * treat "no tombstone" as "keep", so a parse failure cannot delete anything.
 */
export function readSessionArtifactTombstones(artifactRoot: string): ReadonlyMap<string, SessionArtifactTombstone> {
	const path = sessionArtifactTombstonePath(artifactRoot);
	let mtimeMs: number;
	let size: number;
	try {
		const stats = lstatSync(path);
		if (stats.isSymbolicLink() || !stats.isFile()) return new Map();
		mtimeMs = stats.mtimeMs;
		size = stats.size;
	} catch {
		cache.delete(path);
		return new Map();
	}
	const cached = cache.get(path);
	if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
		return cached.records;
	}
	const records = new Map<string, SessionArtifactTombstone>();
	try {
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const record = parseTombstoneLine(line);
			if (!record) continue;
			const existing = records.get(record.sessionId);
			if (!existing || Date.parse(record.deletedAt) >= Date.parse(existing.deletedAt)) {
				records.set(record.sessionId, record);
			}
		}
	} catch {
		return new Map();
	}
	cache.set(path, { mtimeMs, size, records });
	return records;
}

export function readSessionArtifactTombstone(
	artifactRoot: string,
	sessionId: string,
): SessionArtifactTombstone | undefined {
	return readSessionArtifactTombstones(artifactRoot).get(sessionId);
}

/**
 * Whether a tombstone still describes the directory on disk: it does exactly
 * while nothing in the directory has been written since the deletion. A
 * directory touched after `deletedAt` belongs to a session that reused the id.
 */
export function tombstoneInForce(
	tombstone: SessionArtifactTombstone | undefined,
	newestWriteMs: number | undefined,
): boolean {
	if (!tombstone) return false;
	if (newestWriteMs === undefined) return true;
	const deletedAtMs = Date.parse(tombstone.deletedAt);
	if (Number.isNaN(deletedAtMs)) return false;
	// Strict: a directory written in the same millisecond as the deletion (or on a
	// filesystem with one-second timestamps, in the same second) might be a reused
	// id whose first write raced the deletion record. "Cannot disprove reuse" keeps
	// the directory and the session's cron registration (adversarial review N-7).
	return newestWriteMs < deletedAtMs;
}

/**
 * Modification time of the directory entry itself. Cheap enough for the cron
 * store's per-registration read (a single lstat) and deliberately not recursive:
 * the sweep, which already walks the tree, passes the recursive maximum.
 */
export function artifactDirectoryWriteMs(directory: string): number | undefined {
	try {
		const stats = lstatSync(directory);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return undefined;
		return stats.mtimeMs;
	} catch {
		return undefined;
	}
}

function compactRecords(records: readonly SessionArtifactTombstone[]): string[] {
	return records.map((record) =>
		JSON.stringify({
			version: RECORD_VERSION,
			sessionId: record.sessionId,
			deletedAt: record.deletedAt,
			...(record.reason ? { reason: record.reason } : {}),
		}),
	);
}

/**
 * Record that a session's artifact directory was deleted. Best effort by
 * contract: a refusal (a legacy non-private root, a read-only agent dir) returns
 * false and the caller keeps its successful delete - a tombstone must never turn
 * a completed deletion into a failure.
 */
export function recordSessionArtifactTombstone(
	artifactRoot: string,
	sessionId: string,
	options: { now?: Date; reason?: string } = {},
): boolean {
	if (!isValidSessionId(sessionId)) return false;
	const record: SessionArtifactTombstone = {
		sessionId,
		deletedAt: (options.now ?? new Date()).toISOString(),
		...(options.reason ? { reason: options.reason } : {}),
	};
	try {
		// Only an existing root gets a tombstone. Creating one here would make "delete a
		// session that never wrote artifacts" leave a new directory behind (adversarial
		// review N-5), and a root that does not exist holds nothing to resurrect: the
		// read paths this tombstone guards would have to create the root themselves.
		if (!existsSync(artifactRoot)) return false;
		appendPrivateFile(sessionArtifactTombstonePath(artifactRoot), `${compactRecords([record])[0] ?? ""}\n`);
	} catch {
		return false;
	}
	cache.delete(sessionArtifactTombstonePath(artifactRoot));
	return true;
}

/**
 * Drop a tombstone for one id. A live session that owns the id again calls this
 * on its first write: the id is legally reusable, and the tombstone only exists
 * to stop *reads* from resurrecting a deleted session's directory.
 */
export function clearSessionArtifactTombstone(artifactRoot: string, sessionId: string): void {
	if (!isValidSessionId(sessionId)) return;
	if (!existsSync(sessionArtifactTombstonePath(artifactRoot))) return;
	try {
		// Re-read rather than reuse a cached map: the rewrite must not drop a record
		// another process appended, and this is the one path that rewrites the log.
		cache.delete(sessionArtifactTombstonePath(artifactRoot));
		const records = [...readSessionArtifactTombstones(artifactRoot).values()].filter(
			(record) => record.sessionId !== sessionId,
		);
		writePrivateFileAtomicLines(
			sessionArtifactTombstonePath(artifactRoot),
			`${compactRecords(records).join("\n")}\n`,
		);
	} catch {
		// Left in place; the next delete rewrites the log.
	}
	cache.delete(sessionArtifactTombstonePath(artifactRoot));
}
