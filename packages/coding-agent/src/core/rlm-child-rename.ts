/**
 * `rlm.rename` child selection: id-only resolution for the parent's direct
 * children.
 *
 * A rename selector names the child by its `rlm_child_id`, its active session id,
 * or its session id - never by its session *name*. Names are what the rename
 * changes, and after drift a name can collide with a sibling's, so accepting one
 * as a selector would be ambiguous exactly when the caller needs the rename most.
 * The daemon-owned sibling uniqueness and the name rules live on the rename path
 * itself; this module only turns a selector into exactly one child id.
 */

/** One direct child a rename selector may name, by stable id (never by name). */
export interface RlmRenameSelectorCandidate {
	rlm_child_id: string;
	session_id?: string | null;
	active_session_id?: string | null;
}

/**
 * Resolve a `session_id` selector to exactly one direct child id.
 *
 * Blank, unknown, and ambiguous selectors throw; a session name is never a match
 * (it cannot appear here), so the caller sees "not a name" rather than a silently
 * wrong child.
 */
export function resolveRlmRenameChildId(selector: string, candidates: readonly RlmRenameSelectorCandidate[]): string {
	const target = selector.trim();
	if (!target) {
		throw new Error("rlm.rename session_id must be a non-empty string");
	}
	const matches = new Set<string>();
	for (const candidate of candidates) {
		if (
			candidate.rlm_child_id === target ||
			candidate.session_id === target ||
			candidate.active_session_id === target
		) {
			matches.add(candidate.rlm_child_id);
		}
	}
	if (matches.size === 0) {
		throw new Error(
			"rlm.rename session_id must be the full session id or a child handle, not a session name or id suffix",
		);
	}
	if (matches.size > 1) {
		throw new Error(`rlm.rename session_id "${selector}" matches more than one direct child`);
	}
	return [...matches][0]!;
}
