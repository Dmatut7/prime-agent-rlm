// Locations and result shapes for the kernel's persisted user namespace, which
// is revived when a session resumes. The kernel is otherwise spawned fresh on
// resume, leaving the model believing it still has access to variables/imports
// it defined earlier.
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
	/** Present when the whole restore attempt failed (corrupt payload, timeout): the saved
	 * namespace was not revived and the on-disk snapshot is preserved untouched. */
	error?: string;
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

/** Move a failed snapshot aside so a later write can replace the original path. */
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
