// Artifact tree total-byte ceiling (2026-09-14-fixes.md S2 / wave-5 文档-5).
//
// The age-window classes only reach sessions whose deletion is on record; a
// session that is never explicitly deleted keeps its artifact directory forever,
// which is how the tree measured 6 GB / 5860 files (4 GB of it kernel snapshot
// payloads) with no reclaimer in sight. This class is the backstop: while the
// tree fits under `retention.sessionArtifactsMaxBytes` it does nothing; over the
// ceiling it reclaims the coldest directories oldest-first until the tree fits.
//
// What the ceiling overrides, deliberately: the transcript reference. Every
// resumable session has one, so honouring it here would reclaim nothing. What it
// never overrides (the keep list, each a `skipped` entry with a fixed reason):
//   * a resident, leased or ledger-live session;
//   * a live kernel-snapshot reference, or reference state that cannot be read;
//   * an unreadable tree;
//   * a directory holding `scheduled-jobs.json` - pending cron work is user data;
//   * a directory holding another session's transcript that is not on record as
//     deleted and past its own window (the shared `descendantBlocker`, so a
//     sub-agent's transcript under `sub-*/` keeps its parent);
//   * anything touched within the age floor
//     (`max(sessionArtifactsCapMinAgeDays, cooldownMinutes)`).
//
// What a reclaimed session loses: the artifact directory (kernel snapshot,
// per-session harness copy, semantic edges). The transcript in `sessions/`
// stays, so the session still resumes; the directory is recreated on demand and
// the kernel restarts empty (the restore path already treats a missing snapshot
// as a fresh start). A reclaimed directory gets no tombstone - the session was
// not deleted, only its cold payload was, and a tombstone would suppress the
// on-demand recreation a resume relies on.
//
// A directory whose own bytes exceed the whole per-sweep circuit breaker can
// never be taken by any sweep; it is skipped `cap-hit` with a detail naming the
// knob to raise, and the smaller candidates behind it still go (the breaker's
// `break` would otherwise wedge the class on one oversized directory forever).
import { descendantBlocker, scanArtifactTree } from "./artifact-dirs.js";
import { type ReclaimRequest, reclaimWithinBudget, statSignature } from "./delete.js";
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
 * `undefined` means the candidate may be reclaimed under byte pressure. Unlike
 * the residue class, a transcript reference does not protect here - that is the
 * ceiling's point - and neither does the absence of deletion evidence.
 */
function capProtection(candidate: {
	path: string;
	resident: boolean;
	ledgerLive: boolean;
	snapshotStateUnknown: boolean;
	liveSnapshotReferences: number;
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
	if (candidate.liveSnapshotReferences > 0) {
		return { path: candidate.path, reason: SKIP.inUse("pid"), detail: "live kernel snapshot reference" };
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
	const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.tree.bytes, 0);
	if (totalBytes <= settings.sessionArtifactsMaxBytes) {
		// Under the ceiling there is nothing to judge; the report stays silent rather
		// than listing every live protection as a skip.
		return result;
	}

	// The age floor: a directory with a write newer than this is warm, and byte
	// pressure alone never reclaims warm bytes.
	const floorMs = Math.max(
		settings.sessionArtifactsCapMinAgeDays * MS_PER_DAY,
		settings.cooldownMinutes * MS_PER_MINUTE,
	);
	const decision = new Map<string, RetentionSkip | "reclaim">();
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
	}
	// Keep-as-a-whole fixpoint, identical to the residue class's: a kept descendant
	// (or its live transcript) keeps every ancestor of itself.
	for (let round = 0; round < candidates.length + 1; round++) {
		let changed = false;
		for (const candidate of candidates) {
			if (decision.get(candidate.path) !== "reclaim") continue;
			const blocker = descendantBlocker(candidate, candidates, decision, context);
			if (blocker) {
				decision.set(candidate.path, blocker);
				changed = true;
			}
		}
		if (!changed) break;
	}

	// Oldest-touched first, path as the tie-break so two sweeps judge identically.
	const reclaimable = candidates
		.filter((candidate) => decision.get(candidate.path) === "reclaim")
		.sort((a, b) => a.tree.newestMtimeMs - b.tree.newestMtimeMs || a.path.localeCompare(b.path));
	let projected = totalBytes;
	const requests: ReclaimRequest[] = [];
	for (const candidate of reclaimable) {
		if (projected <= settings.sessionArtifactsMaxBytes) break;
		if (candidate.tree.bytes > settings.maxDeleteBytesPerSweep) {
			result.skipped.push({
				path: candidate.path,
				reason: SKIP.capHit,
				detail: `directory holds ${candidate.tree.bytes} bytes, more than the per-sweep breaker (${settings.maxDeleteBytesPerSweep}); raise retention.maxDeleteBytesPerSweep`,
			});
			continue;
		}
		const signature = statSignature(candidate.path);
		requests.push({
			path: candidate.path,
			kind: "dir",
			bytes: candidate.tree.bytes,
			entries: Math.max(1, candidate.tree.entries),
			...(signature ? { signature } : {}),
		});
		projected -= candidate.tree.bytes;
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
 * The total-byte backstop: reclaim the coldest non-live session artifact
 * directories while the tree exceeds `retention.sessionArtifactsMaxBytes`.
 */
export const artifactTotalCapModule: RetentionClassModule = {
	id: "artifact-total-cap",
	scanAndReclaim,
};
