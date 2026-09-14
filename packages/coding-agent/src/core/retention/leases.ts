// Stale session leases: owner pid plus process start identity, never age alone.
//
// `classifyLeaseDirectory` (session-lease.ts) is the single decision point, so the
// sweep can only reclaim a lease the acquirer would also refuse to keep. This
// class adds the path shape (a `<hash>.lock` directory under `session-leases/`)
// and the deletion primitive.
import { join, resolve } from "node:path";
import { classifyLeaseDirectory } from "../session-lease.js";
import { reclaimWithinBudget } from "./delete.js";
import { listDirectory, quietLstat } from "./fs-walk.js";
import {
	type RetentionClassContext,
	type RetentionClassModule,
	type RetentionClassResult,
	type RetentionSkip,
	SKIP,
} from "./types.js";

/** Lease directories are `<session-leases>/<sha256>.lock`. */
const LEASE_DIRECTORY_NAME = /^[0-9a-f]{64}\.lock$/;

export const staleLeasesModule: RetentionClassModule = {
	id: "stale-leases",
	async scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
		const hours = context.settings.staleLeaseHours;
		const leasesRoot = resolve(context.roots.leasesRoot);
		const entries = listDirectory(leasesRoot) ?? [];
		const candidates = entries.filter((entry) => entry.isDirectory() && LEASE_DIRECTORY_NAME.test(entry.name));
		if (hours <= 0) {
			return {
				class: "stale-leases",
				scanned: candidates.length,
				reclaimed: 0,
				bytes: 0,
				skipped: [],
				capped: false,
				disabled: true,
			};
		}
		const skipped: RetentionSkip[] = [];
		const requests = [];
		for (const entry of candidates) {
			const path = join(leasesRoot, entry.name);
			const classification = classifyLeaseDirectory(path, {
				activeLeaseDirectories: context.live.activeLeaseDirectories,
			});
			if (classification.verdict === "held-in-process" || classification.verdict === "live") {
				skipped.push({
					path,
					reason: SKIP.inUse(classification.verdict === "live" ? "pid" : "lease"),
					...(classification.detail ? { detail: classification.detail } : {}),
				});
				continue;
			}
			if (classification.verdict === "unverifiable") {
				skipped.push({
					path,
					reason: SKIP.unverifiable("lease-owner"),
					...(classification.detail ? { detail: classification.detail } : {}),
				});
				continue;
			}
			const ownerStats = quietLstat(join(path, "owner.json")) ?? quietLstat(path);
			const ageMs = ownerStats ? context.now - ownerStats.mtimeMs : Number.POSITIVE_INFINITY;
			if (ageMs < hours * 60 * 60 * 1000) {
				skipped.push({ path, reason: SKIP.young(`${hours}h`), detail: "recently touched" });
				continue;
			}
			const tree = quietLstat(path);
			requests.push({
				path,
				kind: "dir" as const,
				bytes: 0,
				entries: 1,
				...(tree ? { signature: `${tree.dev}:${tree.ino}:${tree.size}:${tree.mtimeMs}` } : {}),
			});
		}
		const outcome = await reclaimWithinBudget(context, requests);
		return {
			class: "stale-leases",
			scanned: candidates.length,
			reclaimed: outcome.reclaimed,
			bytes: outcome.bytes,
			skipped: [...skipped, ...outcome.skipped],
			capped: outcome.capped,
			disabled: false,
		};
	},
};
