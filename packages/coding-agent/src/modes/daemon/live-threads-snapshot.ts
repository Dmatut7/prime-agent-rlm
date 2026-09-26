import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";

/**
 * Snapshot of the resident root sessions a daemon kept alive, mirrored to
 * `<agentDir>/live-threads.json` so the boot-time tmux restore
 * (`pa-threads-restore.sh`) can revive exactly the threads that were alive
 * before the daemon exited. The file replaces the hand-maintained
 * `threads.list` whenever it is fresh: writtenAt within 72 hours.
 *
 * Abnormal exits (SIGKILL, power loss) run no shutdown hook, so the writer is
 * called on every resident-set change instead: the last change before death is
 * already on disk. `writtenAt` stamps the moment of the write, not the moment
 * the set was last touched, so unchanged sets can skip the disk write without
 * the restore losing freshness it never had.
 */
export const LIVE_THREADS_SNAPSHOT_FILE_NAME = "live-threads.json";

export interface LiveThreadSnapshotEntry {
	/** Root session id; the restore resumes it with `prime-agent -r <id>`. */
	id: string;
	/** Working directory the session ran in; the restore opens its tmux window there. */
	cwd?: string;
	/** Session name for the tmux window; the restore falls back to `pa-<id prefix>` when missing. */
	name?: string;
}

export interface LiveThreadsSnapshot {
	writtenAt: string;
	threads: LiveThreadSnapshotEntry[];
}

/** Drop entries without an id, drop duplicate ids (first wins), and sort by id for a stable file body. */
export function normalizeLiveThreads(threads: Iterable<LiveThreadSnapshotEntry>): LiveThreadSnapshotEntry[] {
	const byId = new Map<string, LiveThreadSnapshotEntry>();
	for (const thread of threads) {
		const id = thread.id?.trim();
		if (!id || byId.has(id)) continue;
		byId.set(id, {
			id,
			...(thread.cwd !== undefined && thread.cwd !== "" ? { cwd: thread.cwd } : {}),
			...(thread.name !== undefined && thread.name !== "" ? { name: thread.name } : {}),
		});
	}
	return [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Content signature with `writtenAt` excluded, so an unchanged set costs no disk write. */
export function liveThreadsSignature(threads: Iterable<LiveThreadSnapshotEntry>): string {
	return JSON.stringify(normalizeLiveThreads(threads));
}

export function buildLiveThreadsSnapshot(
	threads: Iterable<LiveThreadSnapshotEntry>,
	writtenAt: Date,
): LiveThreadsSnapshot {
	return {
		writtenAt: writtenAt.toISOString(),
		threads: normalizeLiveThreads(threads),
	};
}

/** Parse the snapshot file; undefined (not an error) when it is missing or not a readable snapshot. */
export function readLiveThreadsSnapshot(path: string): LiveThreadsSnapshot | undefined {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<LiveThreadsSnapshot>;
		if (typeof parsed.writtenAt !== "string" || !Array.isArray(parsed.threads)) return undefined;
		return parsed as LiveThreadsSnapshot;
	} catch {
		return undefined;
	}
}

export interface LiveThreadsSnapshotWrite {
	changed: boolean;
	signature: string;
	snapshot: LiveThreadsSnapshot;
}

/**
 * Persist the snapshot when the normalized set differs from `previousSignature`
 * (the signature of the last write this process performed). The write itself is
 * atomic — temp file, fsync, rename — so a reader never sees a torn file even
 * when the writer dies mid-write. Failures propagate: the caller decides
 * whether a lost snapshot is worth logging as degraded state.
 */
export function writeLiveThreadsSnapshotIfChanged(
	path: string,
	threads: Iterable<LiveThreadSnapshotEntry>,
	previousSignature: string | undefined,
	writtenAt: Date = new Date(),
): LiveThreadsSnapshotWrite {
	const snapshot = buildLiveThreadsSnapshot(threads, writtenAt);
	const signature = JSON.stringify(snapshot.threads);
	if (signature === previousSignature) {
		return { changed: false, signature, snapshot };
	}
	writeFileAtomicSync(path, `${JSON.stringify(snapshot, null, "\t")}\n`, {
		mode: 0o600,
		fsync: true,
		fsyncDir: true,
	});
	return { changed: true, signature, snapshot };
}

/**
 * W2 roster-snapshot single-writer gate.
 *
 * `<agentDir>/live-threads.json` is a whole-machine claim about which root
 * sessions are resident, so exactly one process may write it: the supervisor
 * that owns the daemon socket. A standby (downgraded) supervisor is a client,
 * not an owner, and a supervisor whose socket lease was compromised is no
 * longer the single instance — either one writing here is how the roster
 * fragment (2 threads vs 4 real sessions) reaches the boot restore.
 *
 * Pure so the policy is testable without booting a supervisor.
 */
export function liveThreadsSnapshotWriteGate(state: {
	/** The supervisor bound its socket and has not cleaned it up. */
	ownsSocketPath: boolean;
	/** The socket lease was compromised (another holder took the path over). */
	leaseCompromised: boolean;
	/**
	 * Startup (adoption scan, ownership acquire, ready fence) finished. A
	 * booting supervisor's worker map is still filling in, so a mid-startup
	 * write records a partial roster even though it already owns the socket —
	 * D4 keeps the gate closed until startup completes.
	 */
	startupComplete: boolean;
}): {
	allowed: boolean;
	reason: "owner" | "does-not-own-socket" | "lease-compromised" | "startup-incomplete";
} {
	if (state.leaseCompromised) {
		return { allowed: false, reason: "lease-compromised" };
	}
	if (!state.ownsSocketPath) {
		return { allowed: false, reason: "does-not-own-socket" };
	}
	if (!state.startupComplete) {
		return { allowed: false, reason: "startup-incomplete" };
	}
	return { allowed: true, reason: "owner" };
}
