import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getAgentDir, getSessionsDir } from "../config.js";
import { mapConcurrent } from "../utils/map-concurrent.js";
import { ensurePrivateDirectory } from "../utils/private-files.js";
import type { SessionInfo } from "./session-manager.js";

/**
 * Disk-backed layer under `readSessionInfo`'s in-memory cache.
 *
 * The in-memory cache is per process, so every fresh worker, catalog process,
 * or supervisor restart pays a full transcript scan for every session it lists:
 * on a real agent dir that is hundreds of finished, never-again-written
 * subagent transcripts re-parsed from scratch (measured: 2.1 s for 453 files /
 * 757 MB, versus 8 ms when the same process repeats the call). Passive RLM
 * descendants dominate that set and their transcripts are immutable once the
 * child terminates, which makes them exactly the population a durable summary
 * can serve.
 *
 * Honesty rule: an entry is only ever served when `(dev, ino, size, mtimeMs)`
 * of the transcript still equals the fingerprint captured at scan time — the
 * same triple the in-memory cache uses, plus `dev` because inode numbers are
 * only unique per volume. Content that changed is rescanned, never served.
 *
 * Cache files hold session content excerpts (`firstMessage`, `allMessagesText`),
 * so the directory is 0700 and entries are 0600, matching the transcripts.
 */

export const SESSION_ARTIFACTS_DIR_NAME = "session-artifacts";
export const SESSION_INFO_DISK_CACHE_DIR_NAME = "session-info-cache";

const CACHE_ENTRY_VERSION = 1;
/** Above this the summary is a large fraction of a small transcript; rescanning is the cheaper trade. */
const MAX_ENTRY_BYTES = 512 * 1024;
/** Prune is a whole-directory walk, so it runs at most this often per agent dir. */
const PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_CONCURRENCY = 16;
/**
 * Consecutive *permanent* write failures before this process stops trying
 * (read-only home, ENOSPC, a regular file where the directory belongs).
 */
const WRITE_FAILURE_DISABLE_THRESHOLD = 3;
/**
 * Errno values that mean "right now", not "never": descriptor exhaustion and
 * friends are a moment in a process that just multiplied its own fd pressure
 * eightfold by reading transcripts concurrently. Latching the durable layer off
 * for the rest of a long-lived daemon's life would be the wrong reading of them.
 */
const TRANSIENT_FS_ERRNOS = new Set([
	"EAGAIN",
	"EBUSY",
	"EINTR",
	"EMFILE",
	"ENFILE",
	"ENOMEM",
	"ETIMEDOUT",
	"EWOULDBLOCK",
]);
const TRANSIENT_BACKOFF_BASE_MS = 250;
const TRANSIENT_BACKOFF_MAX_MS = 30_000;
/** A temp file older than this is the debris of a crash between write and rename. */
const STALE_TEMP_FILE_AGE_MS = 60 * 60 * 1000;

export interface SessionInfoFingerprint {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

interface CachedSessionInfoWire extends Omit<SessionInfo, "created" | "modified"> {
	created: string;
	modified: string;
}

interface SessionInfoCacheFile {
	v: number;
	fingerprint: SessionInfoFingerprint;
	info: CachedSessionInfoWire;
}

export interface SessionInfoDiskCacheStats {
	reads: number;
	hits: number;
	misses: number;
	writes: number;
	skipped: number;
	writeErrors: number;
	/** Subset of writeErrors whose errno said "try again later" rather than "never". */
	transientWriteErrors: number;
	pruned: number;
	/** Entries dropped because their transcript was deleted. */
	removed: number;
}

const stats: SessionInfoDiskCacheStats = {
	reads: 0,
	hits: 0,
	misses: 0,
	writes: 0,
	skipped: 0,
	writeErrors: 0,
	transientWriteErrors: 0,
	pruned: 0,
	removed: 0,
};

let consecutiveWriteFailures = 0;
let writesDisabled = false;
let transientBackoffMs = 0;
let transientBackoffUntil = 0;
let directoryEnsured: string | undefined;
let pruneScheduled = false;
let pruneInFlight: Promise<void> | undefined;
let rootsKey: string | undefined;
let roots: string[] = [];

export function sessionInfoDiskCacheStats(): SessionInfoDiskCacheStats {
	return { ...stats };
}

/** Drop process-local cache state (counters, circuit breaker, prune latch). The files on disk stay. */
export function resetSessionInfoDiskCacheState(): void {
	stats.reads = 0;
	stats.hits = 0;
	stats.misses = 0;
	stats.writes = 0;
	stats.skipped = 0;
	stats.writeErrors = 0;
	stats.transientWriteErrors = 0;
	stats.pruned = 0;
	stats.removed = 0;
	consecutiveWriteFailures = 0;
	writesDisabled = false;
	transientBackoffMs = 0;
	transientBackoffUntil = 0;
	directoryEnsured = undefined;
	pruneScheduled = false;
	rootsKey = undefined;
	roots = [];
}

export function sessionInfoDiskCacheDir(): string {
	return join(getAgentDir(), SESSION_INFO_DISK_CACHE_DIR_NAME);
}

function sessionInfoFingerprintOf(statsLike: {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}): SessionInfoFingerprint {
	return { dev: statsLike.dev, ino: statsLike.ino, size: statsLike.size, mtimeMs: statsLike.mtimeMs };
}

/**
 * Both spellings of every root: the configured one and its realpath. Ledger
 * paths are realpath-canonical while catalog paths are the configured spelling,
 * and on a host whose temp or home directory is a symlink those differ — a
 * lexical-only check would silently disable the cache for exactly the paths the
 * ledger asks about.
 */
function withRealpath(path: string): string[] {
	try {
		return [path, resolve(realpathSync(path))];
	} catch {
		return [path];
	}
}

function cacheableRoots(): string[] {
	const sessionsDir = resolve(getSessionsDir());
	const agentDir = resolve(getAgentDir());
	const defaultSessionsDir = join(agentDir, "sessions");
	const key = `${agentDir}${sep}${sessionsDir}`;
	if (rootsKey !== key) {
		rootsKey = key;
		roots = [
			...new Set(
				[
					sessionsDir,
					resolve(dirname(sessionsDir), SESSION_ARTIFACTS_DIR_NAME),
					defaultSessionsDir,
					resolve(dirname(defaultSessionsDir), SESSION_ARTIFACTS_DIR_NAME),
				].flatMap(withRealpath),
			),
		];
	}
	return roots;
}

/**
 * Only the agent's own transcript directories are cacheable. Anything else
 * (a fixture in a temp dir, an imported transcript, a user-chosen path) keeps
 * the previous behaviour: read straight from the file, no side effect anywhere.
 */
export function isSessionInfoDiskCacheable(filePath: string): boolean {
	const resolved = resolve(filePath);
	return cacheableRoots().some((root) => resolved.startsWith(`${root}${sep}`));
}

function cacheEntryPath(filePath: string): string {
	const hash = createHash("sha256").update(resolve(filePath)).digest("hex");
	return join(sessionInfoDiskCacheDir(), `${hash}.json`);
}

function errnoOf(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function isTransientFsError(error: unknown): boolean {
	const code = errnoOf(error);
	return code !== undefined && TRANSIENT_FS_ERRNOS.has(code);
}

/**
 * `Date#toISOString` throws a RangeError on an Invalid Date, and a transcript
 * header's timestamp is exactly the kind of field that can arrive unparseable
 * (hand-edited, truncated, third-party import). The loader tolerates that and
 * returns a summary whose `created` is Invalid, so this layer has to tolerate it
 * too: an unrepresentable timestamp makes the entry uncachable, not the read
 * unreturnable.
 */
function toIsoString(value: Date): string | undefined {
	const ms = value instanceof Date ? value.getTime() : Number.NaN;
	return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function sameFingerprint(a: SessionInfoFingerprint | undefined, b: SessionInfoFingerprint): boolean {
	return (
		!!a &&
		Number.isFinite(a.mtimeMs) &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.size === b.size &&
		a.mtimeMs === b.mtimeMs
	);
}

function isPlausibleInfo(info: unknown): info is CachedSessionInfoWire {
	if (!info || typeof info !== "object") return false;
	const candidate = info as Partial<CachedSessionInfoWire>;
	return (
		typeof candidate.path === "string" &&
		typeof candidate.id === "string" &&
		typeof candidate.firstMessage === "string" &&
		typeof candidate.allMessagesText === "string" &&
		typeof candidate.messageCount === "number" &&
		typeof candidate.rlmDepth === "number" &&
		typeof candidate.created === "string" &&
		typeof candidate.modified === "string"
	);
}

/**
 * The summary a previous process left for exactly this transcript version, or
 * undefined. Every failure mode — absent file, torn JSON, unknown version, a
 * fingerprint that no longer matches — degrades to "miss", never to a throw.
 */
export async function readCachedSessionInfo(
	filePath: string,
	fingerprint: SessionInfoFingerprint,
): Promise<SessionInfo | undefined> {
	if (!isSessionInfoDiskCacheable(filePath)) return undefined;
	stats.reads++;
	let parsed: SessionInfoCacheFile;
	try {
		parsed = JSON.parse(await readFile(cacheEntryPath(filePath), "utf8")) as SessionInfoCacheFile;
	} catch {
		stats.misses++;
		return undefined;
	}
	if (
		parsed?.v !== CACHE_ENTRY_VERSION ||
		!isPlausibleInfo(parsed.info) ||
		resolve(parsed.info.path) !== resolve(filePath) ||
		!sameFingerprint(parsed.fingerprint, fingerprint)
	) {
		stats.misses++;
		return undefined;
	}
	stats.hits++;
	const info = parsed.info;
	return {
		...info,
		created: new Date(info.created),
		modified: new Date(info.modified),
	};
}

async function ensureCacheDirectory(dir: string): Promise<void> {
	if (directoryEnsured === dir) return;
	ensurePrivateDirectory(dir);
	directoryEnsured = dir;
}

/**
 * Persist one scanned summary. Awaited by the caller so a short-lived process
 * still leaves its work behind; cheap because nothing here fsyncs — a cache
 * entry lost to a crash is a miss, not corruption.
 */
export async function writeCachedSessionInfo(
	filePath: string,
	fingerprint: SessionInfoFingerprint,
	info: SessionInfo,
): Promise<void> {
	if (writesDisabled || !isSessionInfoDiskCacheable(filePath)) return;
	if (transientBackoffUntil > Date.now()) {
		// Not an error: the filesystem asked for a moment and has not had it yet.
		stats.skipped++;
		return;
	}
	let payload: string;
	try {
		const created = toIsoString(info.created);
		const modified = toIsoString(info.modified);
		if (created === undefined || modified === undefined) {
			stats.skipped++;
			return;
		}
		const wire: SessionInfoCacheFile = {
			v: CACHE_ENTRY_VERSION,
			fingerprint: sessionInfoFingerprintOf(fingerprint),
			info: { ...info, created, modified },
		};
		payload = JSON.stringify(wire);
	} catch {
		stats.skipped++;
		return;
	}
	if (payload.length > MAX_ENTRY_BYTES) {
		stats.skipped++;
		return;
	}
	const dir = sessionInfoDiskCacheDir();
	const target = cacheEntryPath(filePath);
	const temp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await ensureCacheDirectory(dir);
		await writeFile(temp, payload, { mode: 0o600, flag: "wx" });
		await rename(temp, target);
		consecutiveWriteFailures = 0;
		transientBackoffMs = 0;
		transientBackoffUntil = 0;
		stats.writes++;
	} catch (error) {
		stats.writeErrors++;
		await rm(temp, { force: true }).catch(() => undefined);
		if (isTransientFsError(error)) {
			// Back off exponentially and stay available: a descriptor spike from the
			// very concurrency this module exists to serve must not close the durable
			// layer for the remaining life of a daemon or worker process.
			stats.transientWriteErrors++;
			transientBackoffMs = Math.min(
				transientBackoffMs > 0 ? transientBackoffMs * 2 : TRANSIENT_BACKOFF_BASE_MS,
				TRANSIENT_BACKOFF_MAX_MS,
			);
			transientBackoffUntil = Date.now() + transientBackoffMs;
			return;
		}
		consecutiveWriteFailures++;
		if (consecutiveWriteFailures >= WRITE_FAILURE_DISABLE_THRESHOLD) writesDisabled = true;
	}
}

/**
 * Every cache file that could hold this transcript's summary: the lexical
 * spelling and the realpath spelling. Callers mix them (the ledger records
 * realpath-canonical paths, a directory scan yields the configured spelling),
 * and on a host whose temp or home directory is a symlink those are different
 * keys for one file. The parent-directory realpath keeps this working after the
 * transcript itself is already gone, which is the usual reason to call it.
 */
function cacheEntryCandidates(filePath: string): string[] {
	const resolved = resolve(filePath);
	const spellings = new Set<string>([resolved]);
	try {
		spellings.add(resolve(realpathSync(resolved)));
	} catch {
		try {
			spellings.add(join(realpathSync(dirname(resolved)), basename(resolved)));
		} catch {
			// Neither the file nor its parent resolves: only the lexical key can exist.
		}
	}
	return [...spellings].map((spelling) => cacheEntryPath(spelling));
}

/**
 * Drop the durable summary for a transcript that is being deleted, so a delete
 * does not leave an orphan entry for the weekly prune to find. Best-effort and
 * never throws: a cache miss here is exactly the state the prune would reach.
 */
export async function removeCachedSessionInfo(filePath: string): Promise<void> {
	if (!isSessionInfoDiskCacheable(filePath)) return;
	for (const entry of cacheEntryCandidates(filePath)) {
		try {
			await unlink(entry);
			stats.removed++;
		} catch {
			// Absent, or the directory is not writable: either way the entry can
			// never be served again once its transcript is gone.
		}
	}
}

/**
 * Garbage-collect the directory: an entry is dropped when its transcript is
 * gone or has moved on to a different version. Runs from `pruneIfDue` at most
 * once per `PRUNE_INTERVAL_MS` per agent dir, in the background, and never
 * touches an entry it cannot prove stale.
 */
export async function pruneStaleSessionInfoCacheEntries(): Promise<number> {
	const dir = sessionInfoDiskCacheDir();
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return 0;
	}
	let pruned = 0;
	await mapConcurrent(
		names.filter((name) => name.endsWith(".json")),
		PRUNE_CONCURRENCY,
		async (name) => {
			const file = join(dir, name);
			// "Unreadable" and "corrupt" are different verdicts and must not share a
			// branch: a descriptor spike or a transient I/O error says nothing about
			// the entry, so it stays and the next walk decides. Only content that
			// cannot be parsed, or a source that is gone or has moved on, is collected.
			let raw: string;
			try {
				raw = await readFile(file, "utf8");
			} catch {
				return;
			}
			let keep = false;
			try {
				const parsed = JSON.parse(raw) as SessionInfoCacheFile;
				const sourcePath = isPlausibleInfo(parsed?.info) ? parsed.info.path : undefined;
				if (sourcePath) {
					try {
						const sourceStats = await stat(sourcePath);
						keep =
							sourceStats.isFile() && sameFingerprint(parsed.fingerprint, sessionInfoFingerprintOf(sourceStats));
					} catch (error) {
						// A missing source is the proof we want; a source we could not
						// probe is not, and must not be read as one.
						keep = isTransientFsError(error);
					}
				}
			} catch {
				keep = false;
			}
			if (keep) return;
			await rm(file, { force: true }).catch(() => undefined);
			pruned++;
		},
	);
	// Debris of a crash between writeFile and rename: never served, never reused
	// (the name carries a pid and a uuid), so collect it by age. A young temp file
	// may belong to a writer in another process right now and is left alone.
	await mapConcurrent(
		names.filter((name) => name.endsWith(".tmp")),
		PRUNE_CONCURRENCY,
		async (name) => {
			const file = join(dir, name);
			try {
				const tempStats = await stat(file);
				if (Date.now() - tempStats.mtimeMs < STALE_TEMP_FILE_AGE_MS) return;
			} catch {
				return;
			}
			await rm(file, { force: true }).catch(() => undefined);
			pruned++;
		},
	);
	stats.pruned += pruned;
	return pruned;
}

async function pruneIfDue(): Promise<void> {
	const dir = sessionInfoDiskCacheDir();
	const marker = join(dir, "prune-marker");
	try {
		const markerStats = await stat(marker);
		if (Date.now() - markerStats.mtimeMs < PRUNE_INTERVAL_MS) return;
	} catch {
		// No marker (or an unreadable one): the walk is due.
	}
	await pruneStaleSessionInfoCacheEntries();
	await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 }).catch(() => undefined);
}

/** Background, once per process, after the first entry this process wrote. */
export function scheduleSessionInfoCachePrune(): void {
	if (pruneScheduled) return;
	pruneScheduled = true;
	pruneInFlight = pruneIfDue().catch(() => undefined);
}

/** Resolves once the background walk (if any) has finished. Nothing is scheduled by this. */
export async function whenSessionInfoCachePruneSettled(): Promise<void> {
	await pruneInFlight;
}
