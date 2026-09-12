import { realpathSync, statSync } from "node:fs";

/**
 * Bounds for the resource-discovery walks (skills, prompts, themes, extensions).
 *
 * Discovery follows directory symlinks because symlinked resource directories are a
 * supported layout, and an unbounded follow has two failure shapes: a link that points
 * at one of its own ancestors turns the walk into a path-length race that only ends
 * when the kernel refuses the name (rescanning every real directory on the way), and a
 * link to a large tree makes every startup walk all of it. Both are bounded here: a
 * directory whose real identity is already on the current branch is a cycle, and a
 * branch deeper than the cap is skipped. Skips are reported to the caller instead of
 * being swallowed, because a silently truncated discovery looks exactly like "the user
 * has no skills".
 */
export const MAX_DISCOVERY_DEPTH = 32;

/** Why a directory was not entered. */
export type DiscoverySkipReason = "cycle" | "depth";

/**
 * State of one depth-first walk. `keys` is the branch currently being walked (outermost
 * last), so depth needs no separate parameter and siblings may share a real directory.
 */
export interface DiscoveryWalk {
	readonly entered: Set<string>;
	readonly branch: Array<string | undefined>;
}

export function createDiscoveryWalk(): DiscoveryWalk {
	return { entered: new Set<string>(), branch: [] };
}

/**
 * Identity of a directory for cycle detection: its realpath, falling back to dev:ino
 * and then to nothing (an unresolvable path cannot be compared, so it is entered
 * untracked rather than skipped).
 */
export function discoveryDirectoryKey(dir: string): string | undefined {
	try {
		return realpathSync(dir);
	} catch {
		// Broken or unreadable link target: fall through to the inode identity.
	}
	try {
		const stats = statSync(dir);
		return `${stats.dev}:${stats.ino}`;
	} catch {
		return undefined;
	}
}

/**
 * Enter `dir` for the walk. Returns undefined when the caller may scan it, or the
 * reason it must be skipped. Every successful enter must be paired with
 * leaveDiscoveryDirectory, including on the throwing paths.
 */
export function enterDiscoveryDirectory(walk: DiscoveryWalk, dir: string): DiscoverySkipReason | undefined {
	if (walk.branch.length >= MAX_DISCOVERY_DEPTH) {
		return "depth";
	}
	const key = discoveryDirectoryKey(dir);
	if (key !== undefined && walk.entered.has(key)) {
		return "cycle";
	}
	walk.branch.push(key);
	if (key !== undefined) {
		walk.entered.add(key);
	}
	return undefined;
}

/** Leave the directory entered most recently on this branch. */
export function leaveDiscoveryDirectory(walk: DiscoveryWalk): void {
	const key = walk.branch.pop();
	if (key !== undefined) {
		walk.entered.delete(key);
	}
}
