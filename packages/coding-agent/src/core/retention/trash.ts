// Crash leftovers from this sweep's own delete primitive.
//
// `reclaimWithinBudget` renames a candidate to `<parent>/.retention-trash-*`
// before removing it, so a process killed between the two steps leaves an inert
// entry next to the original. Nothing else resolves that name, so this class
// removes the leftovers older than the cooldown - in the two managed directories
// whose classes delete single entries (logs and the temp dir) and in the artifact
// roots (whose own class also picks them up; the overlap is harmless because the
// rename is idempotent and a missing path is skipped).
import { resolve } from "node:path";
import { RETENTION_TRASH_PREFIX, reclaimWithinBudget } from "./delete.js";
import { listDirectory, quietLstat } from "./fs-walk.js";
import type { RetentionClassContext, RetentionClassModule, RetentionClassResult, RetentionSkip } from "./types.js";
import { SKIP } from "./types.js";

export const retentionCrashLeftoversModule: RetentionClassModule = {
	id: "crash-leftovers",
	async scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
		const directories = [resolve(context.roots.logsDir), resolve(context.roots.tmpDir)];
		const skipped: RetentionSkip[] = [];
		const requests = [];
		let scanned = 0;
		for (const directory of directories) {
			const entries = listDirectory(directory);
			if (!entries) continue;
			for (const entry of entries) {
				if (!entry.name.startsWith(RETENTION_TRASH_PREFIX)) continue;
				scanned += 1;
				const path = resolve(directory, entry.name);
				const stats = quietLstat(path);
				if (!stats) continue;
				const ageMs = context.now - stats.mtimeMs;
				if (ageMs < context.settings.cooldownMinutes * 60 * 1000) {
					skipped.push({ path, reason: SKIP.young(`${context.settings.cooldownMinutes}m`) });
					continue;
				}
				requests.push({
					path,
					kind: stats.isDirectory() ? ("dir" as const) : ("file" as const),
					bytes: 0,
					entries: 1,
					signature: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`,
				});
			}
		}
		const outcome = await reclaimWithinBudget(context, requests);
		return {
			class: "crash-leftovers",
			scanned,
			reclaimed: outcome.reclaimed,
			bytes: outcome.bytes,
			skipped: [...skipped, ...outcome.skipped],
			capped: outcome.capped,
			disabled: false,
		};
	},
};
