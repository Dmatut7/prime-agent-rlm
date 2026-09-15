// Locations, result shapes, and the write policy for the kernel's persisted user
// namespace, which is revived when a session resumes. The kernel is otherwise
// spawned fresh on resume, leaving the model believing it still has access to
// variables/imports it defined earlier.
//
// Snapshotting is best-effort and per-variable: each top-level name is pickled
// with `dill` independently, so a single unpicklable object (open file, socket,
// GPU tensor, …) is skipped and reported rather than aborting the whole snapshot.
import { readFileSync, renameSync } from "node:fs";
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

/** One top-level name a snapshot write could not save, and why the runtime dropped it. */
export interface SnapshotDroppedName {
	name: string;
	reason: string;
}

export interface RestoreResult {
	/** Names successfully revived into the kernel namespace. */
	restored: string[];
	/** Names present in the snapshot that failed to revive, with a short reason. */
	failed: { name: string; reason: string }[];
	/**
	 * Names that were live in the kernel which wrote this snapshot but never made it into the
	 * payload (an unserializable value, a value over a size cap). They are absent from the
	 * payload, so no restore can revive them and neither notice can report them through
	 * `failed`; without this field a name the model believes it saved disappears in silence.
	 * Read from the manifest written next to the payload, and absent when that manifest is
	 * unreadable or the write reported nothing dropped.
	 */
	notSaved?: SnapshotDroppedName[];
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
 * The `<ipython_state>` body written after compaction. Kept next to the result shape so the
 * wording is assertable without building a session (the restore-side precedent,
 * `restoreNoticeLines`); the session glue that renders it lives in agent-session.ts.
 *
 * FR-5: the post-compaction snapshot write is fail-open (`pruneOversizedVariables` returns
 * null on refusal or failure), so the notice must not claim persistence unconditionally: a
 * null write means the on-disk snapshot was NOT refreshed, and anything defined since the
 * last successful write will not survive a restart. The kernel is still live either way, so
 * the "still available" half stays true; only the persistence claim is conditional.
 */
export function compactionKernelStateLines(input: {
	/** The snapshot write result, or null when it was refused, failed, or the kernel died. */
	snapshot: SnapshotResult | null;
	/**
	 * Whether this kernel has a snapshot target configured at all. False for
	 * runtimes with no snapshot machine (e.g. non-persistent sessions): their
	 * null result is not a *failed* write but the absence of the mechanism, so
	 * the notice must not point at a "last successfully written snapshot" that
	 * never existed. Defaults to true so callers without the fact keep the
	 * failed-write wording.
	 */
	hasSnapshotConfig?: boolean;
	/** Namespace listing result, or null when the kernel could not be listed. */
	names: string[] | null;
}): string[] {
	const lines: string[] = [];
	if (input.snapshot === null) {
		lines.push(
			"Your Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.",
		);
		if (input.hasSnapshotConfig === false) {
			lines.push(
				"This kernel has no state snapshot target configured, so nothing in it was saved to disk: a restart starts a fresh kernel and anything defined here must be recreated.",
			);
		} else {
			lines.push(
				"The kernel's state snapshot could not be written, so these names were not saved to disk: a restart revives only the last successfully written snapshot, and anything defined since then must be recreated.",
			);
		}
	} else {
		const pruned = input.snapshot.pruned ?? [];
		lines.push(
			pruned.length > 0
				? `Your Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available. Variables above the per-variable snapshot limit were removed: ${pruned.join(", ")}.`
				: "Your Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.",
		);
		const skipped = input.snapshot.skipped;
		if (skipped && skipped.length > 0) {
			lines.push(
				`These were live but could not be saved into the snapshot, so they will not survive a restart: ${skipped
					.map((entry) => `${entry.name} (${entry.reason})`)
					.join("; ")}.`,
			);
		}
	}
	if (input.names === null) {
		lines.push("The kernel's namespace could not be listed, so which names are still defined is unknown here.");
	} else {
		lines.push(
			input.names.length > 0
				? `These names are still defined: ${input.names.join(", ")}.`
				: "You have not defined any names yet.",
		);
	}
	return lines;
}

/**
 * The model-visible receipt for a snapshot write that failed outside compaction (the
 * debounced auto-write after a cell, or the dispose flush). The compaction path has its
 * own wording (`compactionKernelStateLines`); an ordinary failure used to reach only the
 * in-memory stderr ring, so the model kept believing its namespace was persisted.
 *
 * One receipt per failure episode: a write that succeeds re-arms the notice (the
 * session-side glue de-duplicates; this function is the wording only).
 */
export function snapshotFailureNoticeLines(detail: string): string[] {
	return [
		"Your Python kernel is still running, but its state snapshot could not be written, so these names were not saved to disk.",
		`Reason: ${detail}.`,
		"A restart revives only the last successfully written snapshot: anything defined since then must be recreated. The kernel keeps retrying the write after later cells; this notice repeats only while writes keep failing.",
	];
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
	// The other half of "these came back": a name that never entered the payload cannot fail to
	// restore, so without this line the model hears nothing at all about it.
	if (result.notSaved && result.notSaved.length > 0) {
		lines.push(
			`These were live when that snapshot was written but were never saved into it, so they are gone and must be recreated: ${result.notSaved
				.map((entry) => `${entry.name} (${entry.reason})`)
				.join("; ")}.`,
		);
	}
	if (result.error) {
		lines.push(`Restore failure: ${result.error}.`);
	}
	return lines;
}

/** What the manifest next to a payload records about the write that produced it. */
export interface SnapshotManifestFacts {
	/** Top-level names the payload holds. */
	savedNames: string[];
	/** Names that were live at write time but were not saved, with the runtime's reason. */
	notSaved: SnapshotDroppedName[];
	/** Wall clock of the write, when the manifest records one; undefined otherwise. */
	writtenAtMs?: number;
	/**
	 * The Python version of the interpreter that wrote the payload (e.g. "3.11.13"),
	 * when the manifest records one. The restore request forwards it so the runtime
	 * can refuse to revive by-value functions and classes pickled under a different
	 * major.minor line (reviving them reports success, then executing them kills the
	 * kernel with SIGTRAP/SIGSEGV).
	 */
	pythonVersion?: string;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function reasonEntries(value: unknown): SnapshotDroppedName[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null) return [];
		const record = entry as Record<string, unknown>;
		if (typeof record.name !== "string") return [];
		return [{ name: record.name, reason: typeof record.reason === "string" ? record.reason : "" }];
	});
}

/**
 * Read the manifest that belongs to the payload next to it.
 *
 * Tolerant by design: a missing, torn, or foreign manifest yields `null` and the caller keeps
 * whatever it learned in-process. A name the runtime carried over verbatim from an older payload
 * (`preserved`) *is* in the payload, so it is subtracted here: the live value that failed to
 * serialize is gone, but reporting it as unsaved would contradict the restore that then revives
 * the carried-over blob and reports it through `restored`/`failed`.
 */
export function readSnapshotManifest(manifestPath: string): SnapshotManifestFacts | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const preserved = new Set(stringArray(record.preserved));
	const notSaved = reasonEntries(record.skipped).filter((entry) => !preserved.has(entry.name));
	const stamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
	const pythonVersion = typeof record.pythonVersion === "string" ? record.pythonVersion : undefined;
	return {
		savedNames: stringArray(record.savedNames),
		notSaved,
		...(Number.isFinite(stamp) ? { writtenAtMs: stamp } : {}),
		...(pythonVersion !== undefined ? { pythonVersion } : {}),
	};
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
