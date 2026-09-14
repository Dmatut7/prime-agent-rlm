// Artifact directory shaping.
//
// Two classes work on the same scan of the artifact tree:
//   * `artifact-empty-dirs` - directories with no file anywhere in the subtree.
//     They are the resurrection leftovers of round-08 S1 (629 already-deleted
//     sub-agent directories plus the empty roots), and they cost dirents, not
//     bytes.
//   * `artifact-residue-dirs` - directories that still hold leftovers of a
//     provably deleted session (`semantic-edges.jsonl`, `harness/`, a stale
//     `kernel-state.dill`). This is the class that reclaims round-09 ruling 3.
//
// The judgement is the multi-root one round-08 D-2 measured: a single root
// (`sessions/<id>.jsonl`) reports 963/963 live children as orphans, because a
// sub-agent's transcript lives at `<parentArtifactDir>/sub-xxxxxxxx/<uuid>.jsonl`.
// Every root the tree contains is therefore searched for transcripts (red test R-2).
//
// Nothing here deletes bytes that belong to a session that may come back:
// a resident session, a live ledger edge, a live kernel-snapshot reference, or
// any transcript anywhere keeps the directory.
import { join, resolve } from "node:path";
import { readSessionArtifactTombstones, tombstoneInForce } from "../session-artifact-tombstones.js";
import { isValidSessionId } from "../session-id.js";
import { RETENTION_TRASH_PREFIX, reclaimWithinBudget } from "./delete.js";
import { aggregateTree, listDirectory, quietLstat, type TreeAggregate } from "./fs-walk.js";
import { readKernelSnapshotGenerationState } from "./kernel-snapshot.js";
import {
	type RetentionClassContext,
	type RetentionClassModule,
	type RetentionClassResult,
	type RetentionSkip,
	SKIP,
} from "./types.js";

const KERNEL_STATE_DIR = "kernel-state";
/** Directory names inside an artifact root that are structural, never sessions. */
const STRUCTURAL_DIR_NAMES = new Set(["session-artifacts", "harness", KERNEL_STATE_DIR]);
const SEMANTIC_EDGES_FILE = "semantic-edges.jsonl";
const MAX_WALK_DEPTH = 8;

export interface ArtifactCandidate {
	path: string;
	root: string;
	sessionId: string;
	tree: TreeAggregate;
	tombstonePresent: boolean;
	tombstoneInForce: boolean;
	liveSnapshotReferences: number;
	snapshotStateUnknown: boolean;
	ledgerDeleted: boolean;
	ledgerLive: boolean;
	resident: boolean;
	transcriptRoot?: string;
}

export interface ArtifactScan {
	candidates: ArtifactCandidate[];
	trash: string[];
	roots: string[];
	transcripts: Map<string, string>;
	unreadableRoots: number;
}

/** A directory name that may be a session's artifact directory. */
function isSessionDirectoryName(name: string): boolean {
	if (name.startsWith(".") || name.startsWith("sub-")) return false;
	if (STRUCTURAL_DIR_NAMES.has(name)) return false;
	return isValidSessionId(name);
}

/**
 * Every transcript the artifact tree contains, keyed by session id, plus the
 * artifact roots it contains. One walk answers both questions: the multi-root
 * transcript set (D-2) and the set of roots whose children are candidates.
 */
export function scanArtifactTree(context: RetentionClassContext): ArtifactScan {
	const scan: ArtifactScan = {
		candidates: [],
		trash: [],
		roots: [],
		transcripts: new Map(),
		unreadableRoots: 0,
	};
	// Evidence the runner already has joins the same map before any candidate is
	// judged: a transcript in the flat session root is as good as one in the tree.
	for (const [id, root] of context.live.transcriptIds ?? []) scan.transcripts.set(id, root);
	for (const id of context.live.sessionRootIds ?? []) {
		if (!scan.transcripts.has(id)) scan.transcripts.set(id, context.roots.sessionsDir);
	}
	const start = resolve(context.roots.artifactRoot);
	const queue: { path: string; depth: number }[] = [{ path: start, depth: 0 }];
	// The root itself: its children are this agent dir's own sessions. Nested roots
	// (a child session's `<parentArtifactDir>/session-artifacts`) are found below.
	const roots: string[] = [start];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const entries = listDirectory(current.path);
		if (!entries) {
			if (current.depth === 0) scan.unreadableRoots += 1;
			continue;
		}
		for (const entry of entries) {
			const child = join(current.path, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (entry.name === "session-artifacts") {
					roots.push(child);
					// Its children are candidates; the walk below still descends into
					// them so nested roots and transcripts are found as well.
				}
				if (current.depth >= MAX_WALK_DEPTH) continue;
				queue.push({ path: child, depth: current.depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue;
			if (!entry.name.endsWith(".jsonl")) continue;
			if (entry.name === SEMANTIC_EDGES_FILE) continue;
			const id = entry.name.replace(/\.jsonl$/, "");
			if (id.length === 0) continue;
			if (!scan.transcripts.has(id)) scan.transcripts.set(id, current.path);
		}
	}
	scan.roots = [...new Set(roots)].sort();
	for (const root of scan.roots) {
		const entries = listDirectory(root);
		if (!entries) {
			scan.unreadableRoots += 1;
			continue;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(RETENTION_TRASH_PREFIX)) {
					scan.trash.push(join(root, entry.name));
					continue;
				}
				if (!isSessionDirectoryName(entry.name)) continue;
				scan.candidates.push(buildCandidate(context, root, entry.name, scan.transcripts));
				continue;
			}
			if (entry.isFile() && entry.name.startsWith(RETENTION_TRASH_PREFIX)) {
				scan.trash.push(join(root, entry.name));
			}
		}
	}
	return scan;
}

function buildCandidate(
	context: RetentionClassContext,
	root: string,
	sessionId: string,
	transcripts: Map<string, string>,
): ArtifactCandidate {
	const path = join(root, sessionId);
	const tree = aggregateTree(path, { maxDepth: MAX_WALK_DEPTH });
	const tombstones = readSessionArtifactTombstones(root);
	const tombstone = tombstones.get(sessionId);
	const snapshotState = readKernelSnapshotGenerationState(path);
	const ledgerLive = context.live.ledgerLiveChildIds?.has(sessionId) === true;
	const ledgerDeleted = context.live.ledgerDeletedChildIds?.has(sessionId) === true;
	const resident =
		context.live.residentSessionIds?.has(sessionId) === true ||
		context.live.leasedSessionIds?.has(sessionId) === true;
	return {
		path,
		root,
		sessionId,
		tree,
		tombstonePresent: tombstone !== undefined,
		tombstoneInForce: tombstoneInForce(tombstone, tree.newestMtimeMs),
		liveSnapshotReferences: snapshotState.references.length,
		snapshotStateUnknown: snapshotState.unknown,
		ledgerDeleted,
		ledgerLive,
		resident,
		...(transcripts.has(sessionId) ? { transcriptRoot: transcripts.get(sessionId)! } : {}),
	};
}

/**
 * Why a candidate is kept, in the fixed reason vocabulary. Shared by both classes
 * so "who is protected" is one list, and `undefined` means "may be reclaimed".
 */
function protectionReason(
	candidate: ArtifactCandidate,
	options: { tombstoneMatters?: boolean; requireDeletionEvidence?: boolean } = {},
): RetentionSkip | undefined {
	if (candidate.resident) {
		return { path: candidate.path, reason: SKIP.inUse("resident"), detail: "session is resident or leased" };
	}
	if (candidate.ledgerLive) {
		return { path: candidate.path, reason: SKIP.reference("ledger-live"), detail: "live ledger edge" };
	}
	if (candidate.snapshotStateUnknown) {
		return { path: candidate.path, reason: SKIP.unverifiable("kernel-snapshot-reference-state") };
	}
	if (candidate.liveSnapshotReferences > 0) {
		return { path: candidate.path, reason: SKIP.inUse("pid"), detail: "live kernel snapshot reference" };
	}
	if (candidate.tree.unreadable) {
		return { path: candidate.path, reason: SKIP.unverifiable("tree") };
	}
	if (candidate.ledgerDeleted) {
		// The ledger recorded this child's deletion. A deleted RLM child keeps its
		// transcript on purpose (the durable record), so the transcript's existence
		// does not make the child live - what remains in its artifact directory
		// (semantic edges, a kernel snapshot, a local harness copy) is residue by
		// round-09 ruling 3. Nothing live can be written here: a resident session,
		// a live lease and a live kernel reference were checked above.
		return undefined;
	}
	if (candidate.transcriptRoot !== undefined) {
		return { path: candidate.path, reason: SKIP.reference(`transcript:${candidate.transcriptRoot}`) };
	}
	if (options.requireDeletionEvidence === true) {
		// Removing bytes needs positive evidence that the session is gone: a tombstone
		// that is still in force (the deletion happened and nothing has been written
		// into the directory since) or a ledger delete record for this child. The
		// absence of a transcript is not that evidence - a session whose transcript
		// lives in another session directory has none here, and the bytes it would
		// lose (its kernel snapshot) are the ones worth protecting.
		if (candidate.tombstoneInForce || candidate.ledgerDeleted) {
			return undefined;
		}
		if (candidate.tombstonePresent) {
			// The id was reused after the delete (red test R-6).
			return { path: candidate.path, reason: SKIP.reference("tombstone-superseded") };
		}
		return { path: candidate.path, reason: SKIP.noTombstone, detail: "no deletion record for this directory" };
	}
	// The empty class removes directories that hold no file, where a reuse costs one
	// mkdir; it still needs the age window, but not the tombstone's force test.
	if (options.tombstoneMatters !== false && candidate.tombstonePresent && !candidate.tombstoneInForce) {
		return { path: candidate.path, reason: SKIP.reference("tombstone-superseded") };
	}
	return undefined;
}

function ageReason(candidate: ArtifactCandidate, now: number, days: number): RetentionSkip | undefined {
	if (days <= 0) {
		return { path: candidate.path, reason: SKIP.disabled };
	}
	const ageMs = now - candidate.tree.newestMtimeMs;
	if (ageMs < days * 24 * 60 * 60 * 1000) {
		return { path: candidate.path, reason: SKIP.young(`${days}d`) };
	}
	return undefined;
}

function result(
	id: RetentionClassResult["class"],
	scanned: number,
	_reclaims: { path: string; bytes: number; entries: number }[],
	skipped: RetentionSkip[],
	outcome: { reclaimed: number; bytes: number; skipped: RetentionSkip[]; capped: boolean },
	disabled: boolean,
): RetentionClassResult {
	return {
		class: id,
		scanned,
		reclaimed: outcome.reclaimed,
		bytes: outcome.bytes,
		skipped: [...skipped, ...outcome.skipped],
		capped: outcome.capped,
		disabled,
	};
}

/** Directories with no file anywhere in the subtree (round-08 S1 leftovers). */
export const artifactEmptyDirsModule: RetentionClassModule = {
	id: "artifact-empty-dirs",
	async scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
		const days = context.settings.emptyArtifactDirDays;
		const scan = scanArtifactTree(context);
		if (days <= 0) {
			return {
				class: "artifact-empty-dirs",
				scanned: scan.candidates.length,
				reclaimed: 0,
				bytes: 0,
				skipped: [],
				capped: false,
				disabled: true,
			};
		}
		const skipped: RetentionSkip[] = [];
		const requests = [];
		for (const candidate of scan.candidates) {
			if (candidate.tree.files > 0 || candidate.tree.symlinks > 0) {
				// Not ours: the residue class judges directories that hold content. A
				// symlink is content this class must not silently remove.
				continue;
			}
			const protection = protectionReason(candidate, { tombstoneMatters: false });
			if (protection) {
				skipped.push(protection);
				continue;
			}
			const young = ageReason(candidate, context.now, days);
			if (young) {
				skipped.push(young);
				continue;
			}
			requests.push({
				path: candidate.path,
				kind: "dir" as const,
				bytes: candidate.tree.bytes,
				entries: Math.max(1, candidate.tree.entries),
			});
		}
		// Our own crashed-delete leftovers are always reclaimable, whatever their age.
		for (const trash of scan.trash) {
			const stats = quietLstat(trash);
			requests.push({
				path: trash,
				kind: stats?.isDirectory() ? ("dir" as const) : ("file" as const),
				bytes: 0,
				entries: 1,
			});
		}
		const outcome = await reclaimWithinBudget(context, requests);
		return result(
			"artifact-empty-dirs",
			scan.candidates.length + scan.trash.length,
			requests,
			skipped,
			outcome,
			false,
		);
	},
};

/**
 * Leftovers of a session that is provably gone: no transcript in any root, no
 * live kernel reference, not resident or leased, and nothing written into the
 * directory for the residue window. A live session writes into its artifact
 * directory on every turn, so a quiet directory with no transcript anywhere is
 * residue - and if any of the evidence is missing the directory is kept.
 */
export const artifactResidueModule: RetentionClassModule = {
	id: "artifact-residue-dirs",
	async scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
		const days = context.settings.deletedSessionResidueDays;
		const scan = scanArtifactTree(context);
		if (days <= 0) {
			return {
				class: "artifact-residue-dirs",
				scanned: scan.candidates.length,
				reclaimed: 0,
				bytes: 0,
				skipped: [],
				capped: false,
				disabled: true,
			};
		}
		const skipped: RetentionSkip[] = [];
		for (const candidate of scan.candidates) {
			if (candidate.tree.files === 0 && candidate.tree.symlinks === 0) continue;
			const protection = protectionReason(candidate, { requireDeletionEvidence: true });
			if (protection) {
				skipped.push(protection);
				continue;
			}
			const young = ageReason(candidate, context.now, days);
			if (young) {
				skipped.push(young);
			}
		}
		const requests = scan.candidates
			.filter((candidate) => candidate.tree.files > 0 || candidate.tree.symlinks > 0)
			.filter((candidate) => protectionReason(candidate, { requireDeletionEvidence: true }) === undefined)
			.filter((candidate) => ageReason(candidate, context.now, days) === undefined)
			.map((candidate) => ({
				path: candidate.path,
				kind: "dir" as const,
				bytes: candidate.tree.bytes,
				entries: Math.max(1, candidate.tree.entries),
			}));
		const outcome = await reclaimWithinBudget(context, requests);
		return result("artifact-residue-dirs", scan.candidates.length, requests, skipped, outcome, false);
	},
};
