// Locations, result shapes, and the write policy for the kernel's persisted user
// namespace, which is revived when a session resumes. The kernel is otherwise
// spawned fresh on resume, leaving the model believing it still has access to
// variables/imports it defined earlier.
//
// Snapshotting is best-effort and per-variable: each top-level name is pickled
// with `dill` independently, so a single unpicklable object (open file, socket,
// GPU tensor, …) is skipped and reported rather than aborting the whole snapshot.
import { renameSync } from "node:fs";
import { join } from "node:path";

/** Default ceiling on a snapshot payload. Over-cap variables are skipped + reported. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
/** Default ceiling for one serialized variable. */
export const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024;

/** Base filename for the kernel snapshot within a session's artifact directory. */
const KERNEL_STATE_BASENAME = "kernel-state";

export interface SnapshotResult {
	/** Top-level names successfully serialized into the payload. */
	saved: string[];
	/** Names that could not be serialized, with a short reason. */
	skipped: { name: string; reason: string }[];
	/** Oversized live variables removed by an explicit compaction snapshot. */
	pruned?: string[];
	/** Names the runtime carried over verbatim from the previous payload because they could
	 * not be revived into this kernel. What the runtime reported, not what was asked for. */
	preserved?: string[];
	/** Payload size on disk, in bytes. */
	bytes: number;
	path: string;
}

export interface RestoreResult {
	/** Names successfully revived into the kernel namespace. */
	restored: string[];
	/** Names present in the snapshot that failed to revive, with a short reason. */
	failed: { name: string; reason: string }[];
	path: string;
	/** Present when the whole restore attempt failed (corrupt payload, timeout, a teardown that
	 * interrupted the load): the saved namespace was not revived. A payload the runtime could not
	 * load is isolated aside on disk (`<path>.corrupt-<stamp>`) so a rebuilt namespace can persist
	 * again; a load that never finished leaves the payload where it is, for the next kernel. */
	error?: string;
	/**
	 * What the next snapshot does with the names that failed to revive, so a notice to the
	 * model can be honest about persistence: `preserve-names` carries their saved blobs over
	 * verbatim, `write-blocked` keeps writes paused because this runtime cannot preserve
	 * them. Absent when every name revived.
	 */
	snapshotPolicy?: SnapshotPolicyAfterPartialRestore;
}

export type SnapshotPolicyAfterPartialRestore = "preserve-names" | "write-blocked";

/** Why a snapshot write is refused. Every value is reported to the session log. */
export type SnapshotWriteBlockReason =
	| "no-snapshot-config"
	| "restore-pending"
	| "restore-write-blocked"
	| "unrestored-names-without-preserve";

export interface SnapshotWritePolicyInput {
	/** This kernel has a snapshot target configured at all. */
	hasSnapshotConfig: boolean;
	/** The saved namespace has not been revived into this kernel yet. */
	pendingRestore: boolean;
	/** A whole-payload load did not finish and the payload is still on disk: it could not be
	 * isolated, or a teardown interrupted the load. */
	restoreWriteBlocked: boolean;
	/** Names the last restore could not revive; empty after a fully successful restore. */
	unrestoredNames: readonly string[];
	/** The running runtime announced the snapshot `preserve_names` capability. */
	preserveNamesSupported: boolean;
}

export type SnapshotWritePolicy =
	| { write: false; reason: SnapshotWriteBlockReason }
	| { write: true; preserveNames: string[] };

/**
 * Whether a snapshot may be written now, and which names it must carry over from the
 * previous payload.
 *
 * A partial restore used to ban every later write for the rest of the session, which froze
 * the on-disk state at the version holding the unloadable blobs. Writes are now refused only
 * where a write could lose data: before the saved namespace was revived at all, after a
 * whole-payload load failed without isolation, and — for a runtime that cannot preserve
 * names — while unrestored names exist, because such a runtime would drop their blobs
 * instead of carrying them over.
 */
export function snapshotWritePolicy(input: SnapshotWritePolicyInput): SnapshotWritePolicy {
	if (!input.hasSnapshotConfig) return { write: false, reason: "no-snapshot-config" };
	if (input.pendingRestore) return { write: false, reason: "restore-pending" };
	if (input.restoreWriteBlocked) return { write: false, reason: "restore-write-blocked" };
	if (input.unrestoredNames.length > 0 && !input.preserveNamesSupported) {
		return { write: false, reason: "unrestored-names-without-preserve" };
	}
	return { write: true, preserveNames: [...input.unrestoredNames] };
}

/**
 * The `<ipython_state_restored>` body for one restore result. Kept next to the result shape
 * so the wording is assertable without building a session; the session glue that renders it
 * lives in agent-session.ts.
 */
export function restoreNoticeLines(result: RestoreResult): string[] {
	const lines: string[] = [];
	if (result.restored.length > 0) {
		lines.push(
			`Your Python kernel state was revived from your previous session. These names are available again: ${result.restored.join(", ")}.`,
		);
	} else {
		lines.push(
			"Your previous Python kernel state could not be revived; the kernel is starting fresh, so re-create any variables, imports, or loaded data you need.",
		);
	}
	if (result.failed.length > 0) {
		lines.push(
			`These could not be restored and must be recreated if needed: ${result.failed.map((failure) => failure.name).join(", ")}.`,
		);
		lines.push(
			result.snapshotPolicy === "preserve-names"
				? "Their saved values stay on disk unchanged and later snapshots carry them over as they are, so a future session can still revive them; in this session they are gone until you rebuild them."
				: "Snapshot writes stay paused for this session so a namespace missing those names does not overwrite the state on disk; writing resumes after a restore that revives every saved name.",
		);
	}
	if (result.error) {
		lines.push(`Restore failure: ${result.error}.`);
	}
	return lines;
}

/** Absolute path to the dill payload within a session's artifact directory. */
export function snapshotPathIn(artifactDir: string): string {
	return join(artifactDir, `${KERNEL_STATE_BASENAME}.dill`);
}

/** Absolute path to the JSON manifest within a session's artifact directory. */
export function manifestPathIn(artifactDir: string): string {
	return join(artifactDir, `${KERNEL_STATE_BASENAME}.json`);
}

function renameIfExists(from: string, to: string): string | null {
	try {
		renameSync(from, to);
		return to;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

/**
 * Move a failed snapshot aside so a later write can replace the original path. Only for a payload
 * the runtime actually failed to load: a load that never finished (a timeout, a host teardown) is
 * no verdict on the payload, and renaming it away would destroy good state.
 */
export function isolateCorruptSnapshot(
	path: string,
	manifestPath?: string,
): { isolatedPath: string | null; isolatedManifestPath: string | null } {
	const stamp = Date.now();
	return {
		isolatedPath: renameIfExists(path, `${path}.corrupt-${stamp}`),
		isolatedManifestPath: manifestPath ? renameIfExists(manifestPath, `${manifestPath}.corrupt-${stamp}`) : null,
	};
}
