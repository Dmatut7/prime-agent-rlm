import { spawnSync } from "node:child_process";
import { type Dirent, existsSync } from "node:fs";
import { readdir, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { recordSessionArtifactTombstone } from "./session-artifact-tombstones.js";
import {
	forgetSessionInfo,
	getSessionArtifactPath,
	readSessionHeaderId,
	resolveSessionArtifactId,
} from "./session-manager.js";

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

export interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void;
}

/**
 * Permanently remove a session's artifact directory (durable schedule state,
 * kernel snapshot, RLM scratch files, …), which lives at
 * `<dirname(sessionDir)>/session-artifacts/<id>`.
 * Only invoked on delete, never on deactivation.
 *
 * `sessionId` is the header id of the transcript being deleted. Callers that still have the file
 * should pass it: once the transcript is gone the header cannot be read, and a transcript whose
 * file name differs from its session id (an import, a rename) would otherwise be aimed at a
 * directory that never held its state - leaving the real one behind and filing the tombstone
 * under an id that belongs to somebody else.
 */
export async function deleteSessionArtifacts(sessionPath: string, sessionId?: string): Promise<void> {
	// The header id is the one the running session wrote into; a degenerate name with no header
	// (".jsonl") resolves to the artifacts root itself and is skipped.
	const artifactId = sessionId ?? resolveSessionArtifactId(sessionPath);
	if (!artifactId) return;
	// Deletion validates containment (id pattern, symlink, escape) but does not
	// enforce the private mode: a leftover directory from an older build may be
	// 0755, and a retry-heal sweep must still remove it. Symlinked or escaping
	// paths still throw and are never traversed.
	const artifactDir = getSessionArtifactPath(dirname(sessionPath), artifactId, false, false);
	// Passive descendants persist their transcripts under this directory and each
	// one may have a durable list-summary; forget them before the recursive remove
	// so deleting a root does not leave one orphan entry per child.
	await forgetSummariesUnder(artifactDir);
	// Record the tombstone before the remove: a crash after this point leaves a
	// directory that reads are still forbidden to recreate, and this is the signal
	// the cron store and the retention sweep read instead of guessing from the
	// directory's absence (round-08 S1). Best effort: a refused tombstone write must
	// not turn a completed deletion into a failure.
	recordSessionArtifactTombstone(dirname(artifactDir), artifactId, { reason: "session-deleted" });
	await rm(artifactDir, { recursive: true, force: true });
}

/**
 * Drop the cached summaries of every transcript under a directory that is about
 * to be removed. Breadth-first over real directories only: a symlinked entry is
 * neither descended into nor treated as a transcript, so cleanup can never reach
 * outside the directory the caller already decided to delete.
 */
async function forgetSummariesUnder(dir: string): Promise<void> {
	const queue = [dir];
	while (queue.length > 0) {
		const current = queue.shift()!;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(path);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				await forgetSessionInfo(path);
			}
		}
	}
}

/** Remove the session `.jsonl`, trying the `trash` CLI first, then falling back to unlink. */
async function removeSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" - ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, error };
	}
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Also permanently removes the session's artifact directory, but only
 * once the session file itself is gone — otherwise a failed delete would orphan a
 * session whose kernel snapshot has already been destroyed.
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	// Read the identity while the transcript is still here: after the unlink there is no header
	// left to ask, and the artifact directory is named by that id, not by the file name.
	const headerSessionId = readSessionHeaderId(sessionPath);
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		options.afterFileRemoved?.();
		// The transcript is gone, so no summary of it can ever be valid again.
		// Best-effort like the artifact cleanup below: a cache problem must not
		// turn a successful deletion into a failure.
		try {
			await forgetSessionInfo(sessionPath);
		} catch {
			// Keep the successful file-deletion result.
		}
		// Artifact cleanup is best-effort: a refusal (e.g. a legacy non-private
		// artifacts root) must not turn a successful session-file deletion into a
		// failure.
		try {
			await deleteSessionArtifacts(sessionPath, headerSessionId);
		} catch {
			// Keep the successful file-deletion result.
		}
	}
	return result;
}
