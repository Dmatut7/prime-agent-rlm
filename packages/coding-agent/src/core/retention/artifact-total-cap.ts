// Artifact tree total-byte ceiling (2026-09-14-fixes.md S2 / wave-5 文档-5;
// reclaim unit narrowed to the kernel snapshot payload in wave-40).
//
// The age-window classes only reach sessions whose deletion is on record; a
// session that is never explicitly deleted keeps its artifact directory forever,
// which is how the tree measured 6 GB / 5860 files (4 GB of it kernel snapshot
// payloads) with no reclaimer in sight. This class is the backstop: while the
// reclaimable payload bytes fit under `retention.sessionArtifactsMaxBytes` it
// does nothing; over the ceiling it reclaims kernel snapshot payloads
// largest-first until they fit.
//
// The reclaim unit is the in-place kernel snapshot (`kernel-state.dill`), never
// the directory. The directory holds the session's irreplaceable state - the
// local harness store (`harness/`, the continual memory the resume briefing
// tells the user survived the reopen), pasted-image payloads, semantic edges,
// scheduled cron jobs, nested `session-artifacts/` roots and `sub-*/`
// transcripts - and a sweep that took the whole directory destroyed all of it
// while the briefing still reported the memory as intact. A session whose
// snapshot is reclaimed loses only its kernel namespace: the transcript in
// `sessions/` stays, the harness store stays, and the kernel restarts empty
// (the restore path already treats a missing snapshot as a fresh start).
//
// Only bytes this class may reclaim count toward the ceiling. A kept
// candidate's bytes never push the tree over it, and neither does the
// irreplaceable payload of an eligible candidate: counting unreachable bytes
// would fire the class when no reclaim could bring the tree back under,
// destroying cold snapshots for nothing. Nested roots cannot double-count -
// every candidate contributes exactly its own `kernel-state.dill`.
//
// What the ceiling overrides, deliberately: the transcript reference. Every
// resumable session has one, so honouring it here would reclaim nothing. What
// it never overrides (the keep list, each a `skipped` entry with a fixed
// reason):
//   * a resident, leased or ledger-live session;
//   * kernel-snapshot reference state that cannot be read (the in-use reference
//     writer is gone - nothing produces `.in-use` records any more - so only the
//     unverifiable state still protects);
//   * an unreadable tree;
//   * a directory holding `scheduled-jobs.json` - pending cron work wakes the
//     session, and an empty kernel breaks the job's expectations;
//   * anything touched within the age floor
//     (`max(sessionArtifactsCapMinAgeDays, cooldownMinutes)`).
//
// A snapshot larger than the whole per-sweep circuit breaker can never be taken
// by any sweep; it is skipped `cap-hit` with a detail naming the knob to raise,
// and the smaller payloads behind it still go (the breaker's `break` would
// otherwise wedge the class on one oversized snapshot forever).
import { join } from "node:path";
import { type ArtifactCandidate, scanArtifactTree } from "./artifact-dirs.js";
import { type ReclaimRequest, reclaimWithinBudget } from "./delete.js";
import { quietLstat } from "./fs-walk.js";
import { LEGACY_KERNEL_SNAPSHOT_BASENAME } from "./kernel-snapshot.js";
import {
	type RetentionClassContext,
	type RetentionClassModule,
	type RetentionClassResult,
	type RetentionSkip,
	SKIP,
} from "./types.js";

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** The pending-work marker a cap reclaim must never take (cron-jobs.ts). */
const SCHEDULED_JOBS_FILE_NAME = "scheduled-jobs.json";

/**
 * The cap class's own keep judgement: the live protections every class shares.
 * `undefined` means the candidate's snapshot may be reclaimed under byte
 * pressure. Unlike the residue class, a transcript reference does not protect
 * here - that is the ceiling's point - and neither does the absence of
 * deletion evidence.
 */
function capProtection(candidate: {
	path: string;
	resident: boolean;
	ledgerLive: boolean;
	snapshotStateUnknown: boolean;
	tree: { unreadable: boolean; names: string[] };
}): RetentionSkip | undefined {
	if (candidate.resident) {
		return { path: candidate.path, reason: SKIP.inUse("resident"), detail: "session is resident or leased" };
	}
	if (candidate.ledgerLive) {
		return { path: candidate.path, reason: SKIP.reference("ledger-live"), detail: "live ledger edge" };
	}
	if (candidate.snapshotStateUnknown) {
		return { path: candidate.path, reason: SKIP.unverifiable("kernel-snapshot-reference-state") };
	}
	if (candidate.tree.unreadable) {
		return { path: candidate.path, reason: SKIP.unverifiable("tree") };
	}
	if (candidate.tree.names.includes(SCHEDULED_JOBS_FILE_NAME)) {
		return {
			path: candidate.path,
			reason: SKIP.reference(SCHEDULED_JOBS_FILE_NAME),
			detail: "scheduled cron jobs live in this directory",
		};
	}
	return undefined;
}

interface SnapshotPayload {
	/** `<artifactDir>/kernel-state.dill`. */
	path: string;
	bytes: number;
	/** Identity captured at judgement time; the delete refuses a rewritten file. */
	signature: string;
}

/**
 * The one payload this class may reclaim from a candidate: the in-place kernel
 * snapshot. A symlink or a non-file is not touched (never followed, never
 * unlinked), and a missing snapshot means the directory has nothing for this
 * class. Bytes and signature come from the same `lstat`, so the judgement and
 * the race check see one file.
 */
function snapshotPayloadOf(candidate: ArtifactCandidate): SnapshotPayload | undefined {
	const path = join(candidate.path, LEGACY_KERNEL_SNAPSHOT_BASENAME);
	const stats = quietLstat(path);
	if (!stats || stats.isSymbolicLink() || !stats.isFile()) return undefined;
	return { path, bytes: stats.size, signature: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}` };
}

async function scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
	const { settings } = context;
	const result: RetentionClassResult = {
		class: "artifact-total-cap",
		scanned: 0,
		reclaimed: 0,
		bytes: 0,
		skipped: [],
		capped: false,
		disabled: false,
	};
	if (!(settings.sessionArtifactsMaxBytes > 0)) {
		context.log(
			`retention artifact-total-cap: disabled (retention.sessionArtifactsMaxBytes=${settings.sessionArtifactsMaxBytes})`,
		);
		return { ...result, disabled: true };
	}

	const scan = await scanArtifactTree(context);
	const candidates = scan.candidates;
	result.scanned = candidates.length;

	// The age floor: a directory with a write newer than this is warm, and byte
	// pressure alone never reclaims warm bytes.
	const floorMs = Math.max(
		settings.sessionArtifactsCapMinAgeDays * MS_PER_DAY,
		settings.cooldownMinutes * MS_PER_MINUTE,
	);
	// Judge before counting: the ceiling compares only the bytes the class may
	// actually reclaim, so the protections decide the count itself. Every
	// candidate contributes its own snapshot payload exactly once, however many
	// nested roots sit inside its tree.
	const decision = new Map<string, RetentionSkip | "reclaim">();
	const payloads = new Map<string, SnapshotPayload>();
	for (const candidate of candidates) {
		const protection = capProtection(candidate);
		if (protection) {
			decision.set(candidate.path, protection);
			continue;
		}
		const ageMs = context.now - candidate.tree.newestMtimeMs;
		if (ageMs < floorMs) {
			decision.set(candidate.path, {
				path: candidate.path,
				reason: SKIP.young("artifact-cap-floor"),
				detail: `newest write ${Math.round(ageMs / MS_PER_MINUTE)}m ago < ${Math.round(floorMs / MS_PER_MINUTE)}m floor`,
			});
			continue;
		}
		decision.set(candidate.path, "reclaim");
		const payload = snapshotPayloadOf(candidate);
		if (payload && payload.bytes > 0) payloads.set(candidate.path, payload);
	}
	const countedBytes = candidates.reduce(
		(sum, candidate) =>
			sum + (decision.get(candidate.path) === "reclaim" ? (payloads.get(candidate.path)?.bytes ?? 0) : 0),
		0,
	);
	if (countedBytes <= settings.sessionArtifactsMaxBytes) {
		// Under the ceiling there is nothing to judge; the report stays silent rather
		// than listing every live protection as a skip.
		return result;
	}

	// Largest payload first, path as the tie-break so two sweeps judge
	// identically: the biggest snapshots move the total the most, so the ceiling
	// costs the fewest sessions their kernel state. Candidates without a
	// payload stay out: reclaiming one frees nothing against the byte ceiling
	// but still spends one per-sweep entry, starving the payloads behind it -
	// and the empty-dirs class already owns those directories by age.
	const reclaimable = candidates
		.map((candidate) => ({ candidate, payload: payloads.get(candidate.path) }))
		.filter(
			(entry): entry is { candidate: ArtifactCandidate; payload: SnapshotPayload } =>
				decision.get(entry.candidate.path) === "reclaim" && entry.payload !== undefined,
		)
		.sort((a, b) => b.payload.bytes - a.payload.bytes || a.candidate.path.localeCompare(b.candidate.path));
	let projected = countedBytes;
	const requests: ReclaimRequest[] = [];
	for (const { payload } of reclaimable) {
		if (projected <= settings.sessionArtifactsMaxBytes) break;
		if (payload.bytes > settings.maxDeleteBytesPerSweep) {
			result.skipped.push({
				path: payload.path,
				reason: SKIP.capHit,
				detail: `kernel snapshot holds ${payload.bytes} bytes, more than the per-sweep breaker (${settings.maxDeleteBytesPerSweep}); raise retention.maxDeleteBytesPerSweep`,
			});
			continue;
		}
		requests.push({
			path: payload.path,
			kind: "file",
			bytes: payload.bytes,
			entries: 1,
			signature: payload.signature,
		});
		projected -= payload.bytes;
	}
	for (const candidate of candidates) {
		const verdict = decision.get(candidate.path);
		if (verdict !== undefined && verdict !== "reclaim") result.skipped.push(verdict);
	}

	const outcome = await reclaimWithinBudget(context, requests);
	// The breaker's `break` leaves the requests behind the oversized candidate
	// unaccounted; the account is completed here so every request is either
	// reclaimed or named in a skip.
	const accounted = outcome.reclaimed + outcome.skipped.length;
	for (const request of requests.slice(accounted)) {
		result.skipped.push({ path: request.path, reason: SKIP.capHit, detail: "per-sweep cap reached" });
	}
	result.reclaimed = outcome.reclaimed;
	result.bytes = outcome.bytes;
	result.capped = outcome.capped;
	result.skipped.push(...outcome.skipped);
	return result;
}

/**
 * The total-byte backstop: reclaim the kernel snapshot payloads of cold
 * non-live sessions, largest first, while the reclaimable bytes exceed
 * `retention.sessionArtifactsMaxBytes`. Directories - and the harness stores,
 * images, edges, jobs and transcripts they hold - are never this class's to
 * take.
 */
export const artifactTotalCapModule: RetentionClassModule = {
	id: "artifact-total-cap",
	scanAndReclaim,
};
