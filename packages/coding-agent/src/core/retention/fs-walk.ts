// Bounded filesystem helpers for the retention sweep.
//
// Every judgement here is conservative in one direction: an entry that cannot be
// read, a path that resolves outside the root it was found under, or a symlink
// where a real directory was expected reports `unverifiable` and the caller keeps
// the candidate. Nothing in this module deletes.
import type { Dirent } from "node:fs";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

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
 * `realpath` containment: a candidate must still be inside `root` after
 * resolution, and must not be a symlink. Mirrors the artifact-path check in
 * session-manager.ts - a sweep deletes directories and must never traverse one.
 */
export function containedRealPath(root: string, candidate: string): string | undefined {
	try {
		const stats = lstatSync(candidate);
		if (stats.isSymbolicLink()) return undefined;
		const realRoot = realpathSync(root);
		const realCandidate = realpathSync(candidate);
		const rel = relative(realRoot, realCandidate);
		if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
		return realCandidate;
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
			}
		}
	}
	return result;
}

/** Resolve a root once, for containment checks; falls back to the lexical path. */
export function resolveRoot(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}
