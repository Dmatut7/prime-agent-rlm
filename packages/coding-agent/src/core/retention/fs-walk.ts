// Bounded filesystem helpers for the retention sweep.
//
// Every judgement here is conservative in one direction: an entry that cannot be
// read, a path that resolves outside the root it was found under, or a symlink
// where a real directory was expected reports `unverifiable` and the caller keeps
// the candidate. Nothing in this module deletes.
import type { Dirent } from "node:fs";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The one sidecar name that is not a session transcript. */
const SEMANTIC_EDGES_FILE = "semantic-edges.jsonl";

export interface TreeAggregate {
	/** Regular-file bytes in the subtree, symlinks not followed. */
	bytes: number;
	/** Regular files in the subtree. */
	files: number;
	/** Entries (files + directories) in the subtree. */
	entries: number;
	/** Newest mtime seen anywhere in the subtree (the directory itself included). */
	newestMtimeMs: number;
	/** True when a readdir/lstat failed: the caller must keep the candidate. */
	unreadable: boolean;
	/** Names seen in the subtree, for shape checks (e.g. `*.sock` while in use). */
	names: string[];
	/**
	 * Symlinks in the subtree. They are never followed and never removed, but they
	 * are content: a directory that holds one is not empty.
	 */
	symlinks: number;
	/**
	 * Session ids of the transcripts in the subtree (`<id>.jsonl`, excluding the
	 * sidecar files a session directory also holds). A candidate that contains
	 * another session's transcript must not be removed recursively: the transcript
	 * belongs to a session whose liveness the candidate's own id says nothing about.
	 */
	transcriptIds: Set<string>;
	/**
	 * The same transcripts with the path each one was found at. Collected from the
	 * `lstat` the walk already performs, so a caller that has to judge one
	 * transcript's own age window (a nested `<sub-*>/<id>.jsonl`) does not need a
	 * second traversal to find it.
	 */
	transcripts: { id: string; path: string }[];
}

/** Stat a path without following a final symlink; undefined when absent or unreadable. */
export function quietLstat(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

export function isRealDirectory(path: string): boolean {
	const stats = quietLstat(path);
	return stats !== undefined && stats.isDirectory() && !stats.isSymbolicLink();
}

/** Direct children of a directory, or undefined when it cannot be listed. */
export function listDirectory(path: string): Dirent[] | undefined {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch {
		return undefined;
	}
}

/**
 * Aggregate one subtree. `maxDepth` bounds the walk (a scan must not follow a
 * pathological layout forever); a walk that hits the bound reports `unreadable`
 * so the caller keeps the candidate instead of judging a partial tree.
 */
export function aggregateTree(root: string, options: { maxDepth?: number; maxEntries?: number } = {}): TreeAggregate {
	const maxDepth = options.maxDepth ?? 6;
	const maxEntries = options.maxEntries ?? 200_000;
	const result: TreeAggregate = {
		bytes: 0,
		files: 0,
		entries: 0,
		newestMtimeMs: 0,
		unreadable: false,
		names: [],
		symlinks: 0,
		transcriptIds: new Set<string>(),
		transcripts: [],
	};
	const rootStats = quietLstat(root);
	if (!rootStats) {
		result.unreadable = true;
		return result;
	}
	result.newestMtimeMs = rootStats.mtimeMs;
	const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const entries = listDirectory(current.path);
		if (!entries) {
			result.unreadable = true;
			continue;
		}
		for (const entry of entries) {
			const child = join(current.path, entry.name);
			result.entries += 1;
			result.names.push(entry.name);
			if (result.entries > maxEntries) {
				result.unreadable = true;
				return result;
			}
			if (entry.isSymbolicLink()) {
				// Never followed; counted as content but not traversed.
				result.symlinks += 1;
				continue;
			}
			if (entry.isDirectory()) {
				if (current.depth >= maxDepth) {
					result.unreadable = true;
					continue;
				}
				const childStats = quietLstat(child);
				if (childStats) result.newestMtimeMs = Math.max(result.newestMtimeMs, childStats.mtimeMs);
				queue.push({ path: child, depth: current.depth + 1 });
				continue;
			}
			if (entry.isFile()) {
				const childStats = quietLstat(child);
				if (!childStats) {
					result.unreadable = true;
					continue;
				}
				result.files += 1;
				result.bytes += childStats.size;
				result.newestMtimeMs = Math.max(result.newestMtimeMs, childStats.mtimeMs);
				if (entry.name.endsWith(".jsonl") && entry.name !== SEMANTIC_EDGES_FILE && !entry.name.startsWith(".")) {
					const id = entry.name.slice(0, -".jsonl".length);
					result.transcriptIds.add(id);
					result.transcripts.push({ id, path: child });
				}
			}
		}
	}
	return result;
}
