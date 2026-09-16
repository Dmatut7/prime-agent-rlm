import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BoundedCache } from "../../utils/bounded-cache.js";

/**
 * Per-child RLM subagent hydration/display metadata.
 *
 * One JSON file per child in the child's own session dir
 * (`session-artifacts/<parentId>/<childId>/rlm-subagent.json`). Topology
 * (parent/child edges, depths, names) lives exclusively in the daemon-owned
 * spawn ledger and is never read from this file; it carries only what
 * hydration and display need. It is written at the same moments the legacy
 * per-parent `rlm-subagents.jsonl` registry used to be written: spawn
 * admission, completion, and deletion. Writes are atomic (temp file +
 * rename); reads are tolerant.
 */
const RLM_SUBAGENT_DISPLAY_FILE = "rlm-subagent.json";

export interface RlmSubagentDisplayEntry {
	type: "rlm_subagent";
	childId: string;
	sessionName: string;
	sessionDir: string;
	sessionFile: string;
	rlmMaxDepth?: number;
	rlmParentNodeId?: string;
	prompt?: string;
	spawnCode?: string;
	model?: { provider: string; modelId: string };
	status: "running" | "completed" | "deleted";
	createdAt: number;
	updatedAt: string;
}

export function rlmSubagentDisplayPath(sessionDir: string): string {
	return join(sessionDir, RLM_SUBAGENT_DISPLAY_FILE);
}

interface RlmSubagentDisplayCacheEntry {
	size: number;
	mtimeMs: number;
	/** Head+tail content fingerprint: a colliding stat can hide a cross-process rewrite. */
	fingerprint: string;
	entry: RlmSubagentDisplayEntry | undefined;
}

// One entry per session dir the daemon has listed, keyed by the display file path.
// Every session-list walk reads one display file per ledger edge, and the daemon
// walks on high-frequency session events. Writes are atomic renames of a fully
// rewritten file, so a differing (size, mtimeMs) means changed content; a
// colliding stat is settled by the head+tail content fingerprint below, which is
// what keeps an out-of-process writer's change visible (r38 LIFE-3).
//
// The ceiling is sized from the population the cache actually serves. A listing
// pass reads one dir per RLM ledger edge across every saved session, so a cap
// below that population turns every pass into a full miss (stat + read + parse of
// a multi-kilobyte JSON file) and the cache stops paying for itself. Measured on a
// loaded dev host (2026-09-15, ~/.prime/agent): 1540 child display files,
// 9.8 MB total, mean 6.5 KB, p99 20.4 KB, max 21.9 KB - i.e. the whole historical
// population is ~10 MB. 4096 entries cover ~2.7x that; 16 MiB covers it with
// ~1.6x headroom and binds first at the measured mean (~2500 typical entries), so
// the entry ceiling only matters for a swarm of small children. Both are hard:
// retained bytes cannot exceed 16 MiB plus one entry's overhead, versus unbounded
// before. The byte estimate is the file's serialized size, which is what the stat
// revalidation already reads; V8 stores ASCII at 1 byte/char and CJK at 2 bytes per
// char against 3 UTF-8 bytes, so it tracks retained size to within a factor of ~1.5.
const DISPLAY_CACHE_MAX_ENTRIES = 4096;
const DISPLAY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
// Idle expiry, not a freshness rule: the stat still revalidates every hit. Children
// listed on consecutive passes keep refreshing and never expire; a dir deleted out
// from under the cache is never read again, so this is the only thing that reclaims it.
const DISPLAY_CACHE_IDLE_TTL_MS = 15 * 60 * 1000;

const displayCache = new BoundedCache<RlmSubagentDisplayCacheEntry>({
	maxEntries: DISPLAY_CACHE_MAX_ENTRIES,
	maxBytes: DISPLAY_CACHE_MAX_BYTES,
	// A cached miss keeps only its stat, so it costs nothing against the budget.
	estimateBytes: (value) => (value.entry === undefined ? 0 : value.size),
	idleTtlMs: DISPLAY_CACHE_IDLE_TTL_MS,
});

function isRlmSubagentDisplayEntry(value: unknown): value is RlmSubagentDisplayEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<RlmSubagentDisplayEntry>;
	return (
		entry.type === "rlm_subagent" &&
		typeof entry.childId === "string" &&
		typeof entry.sessionName === "string" &&
		typeof entry.sessionDir === "string" &&
		typeof entry.sessionFile === "string" &&
		(entry.status === "running" || entry.status === "completed" || entry.status === "deleted") &&
		(entry.rlmMaxDepth === undefined || (Number.isSafeInteger(entry.rlmMaxDepth) && entry.rlmMaxDepth >= 0)) &&
		typeof entry.createdAt === "number"
	);
}

export function writeRlmSubagentDisplayEntry(entry: RlmSubagentDisplayEntry): void {
	const path = rlmSubagentDisplayPath(entry.sessionDir);
	mkdirSync(entry.sessionDir, { recursive: true });
	const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
	const handle = openSync(tempPath, "wx", 0o600);
	try {
		try {
			writeSync(handle, `${JSON.stringify(entry)}\n`);
			fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
		renameSync(tempPath, path);
		// Two rewrites within one mtime tick can produce an identical stat, so the
		// writer must drop the cache rather than rely on stat comparison alone.
		displayCache.delete(path);
	} catch (error) {
		// A failed write, fsync, or rename must not leak the temp file.
		rmSync(tempPath, { force: true });
		throw error;
	}
}

/** Cache diagnostics: how much the module-level display cache currently holds. */
export interface RlmSubagentDisplayCacheStats {
	entries: number;
	bytes: number;
}

export function rlmSubagentDisplayCacheStats(): RlmSubagentDisplayCacheStats {
	return { entries: displayCache.size, bytes: displayCache.estimatedBytes };
}

/** Whether one session dir currently has a cached display entry. */
export function rlmSubagentDisplayCacheHas(sessionDir: string): boolean {
	return displayCache.has(rlmSubagentDisplayPath(sessionDir));
}

/** Test hook: drop every cached display entry. */
export function resetRlmSubagentDisplayCache(): void {
	displayCache.clear();
}

// The stat match no longer ends the revalidation: an out-of-process rewrite can
// land the same (size, mtimeMs) - "running" and "deleted" serialize to the same
// length, and two writes in one mtime tick are the natural case (r38 LIFE-3). The
// cache therefore also fingerprints the file's head and tail chunk. Display files
// are a single JSON line, so for the measured population (mean 6.5 KB, max
// 21.9 KB) the window covers everything a same-size rewrite can change; the
// middle of a file larger than both chunks is the accepted blind spot. The
// fingerprint is computed from bytes, not a decoded string, so the store and the
// validation paths agree.
const FINGERPRINT_CHUNK_BYTES = 4096;

function fingerprintOf(buffer: Buffer): string {
	const hash = createHash("sha256");
	hash.update(buffer.subarray(0, FINGERPRINT_CHUNK_BYTES));
	if (buffer.length > FINGERPRINT_CHUNK_BYTES) {
		hash.update(buffer.subarray(buffer.length - FINGERPRINT_CHUNK_BYTES));
	}
	return hash.digest("hex");
}

/** The file-side fingerprint: bounded head+tail reads, no full-file parse. */
async function displayFingerprint(path: string, size: number): Promise<string | undefined> {
	const handle = await open(path, "r");
	try {
		if (size <= FINGERPRINT_CHUNK_BYTES * 2) {
			const whole = Buffer.alloc(size);
			if (size > 0) await handle.read(whole, 0, size, 0);
			return fingerprintOf(whole);
		}
		const spans = Buffer.alloc(FINGERPRINT_CHUNK_BYTES * 2);
		await handle.read(spans, 0, FINGERPRINT_CHUNK_BYTES, 0);
		await handle.read(spans, FINGERPRINT_CHUNK_BYTES, FINGERPRINT_CHUNK_BYTES, size - FINGERPRINT_CHUNK_BYTES);
		return fingerprintOf(spans);
	} finally {
		await handle.close();
	}
}

export async function readRlmSubagentDisplayEntry(sessionDir: string): Promise<RlmSubagentDisplayEntry | undefined> {
	const path = rlmSubagentDisplayPath(sessionDir);
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(path);
	} catch {
		displayCache.delete(path);
		return undefined;
	}
	const cached = displayCache.get(path);
	if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
		const fingerprint = await displayFingerprint(path, stats.size).catch(() => undefined);
		// A failed probe falls through to the full read, which reports the file's
		// actual state rather than trusting a stat match it could not confirm.
		if (fingerprint !== undefined && fingerprint === cached.fingerprint) {
			return cached.entry;
		}
	}
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch {
		displayCache.delete(path);
		return undefined;
	}
	let entry: RlmSubagentDisplayEntry | undefined;
	try {
		const parsed = JSON.parse(contents) as unknown;
		entry = isRlmSubagentDisplayEntry(parsed) ? parsed : undefined;
	} catch {
		entry = undefined;
	}
	displayCache.set(path, {
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		fingerprint: fingerprintOf(Buffer.from(contents, "utf8")),
		entry,
	});
	return entry;
}
