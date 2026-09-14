// Child transcripts: `sub-xxxxxxxx/<uuid>.jsonl` under an artifact root.
//
// OFF BY DEFAULT (round-09 ruling 1: "sub-agent dill/transcripts are not reclaimed
// by age"). The bytes are real (round-08 D-2 measured 1,977 MiB of child
// transcripts on this machine) but they sit on live references, and the source
// deliberately keeps a deleted RLM child's transcript: daemon-mode.ts records the
// transcript plus a display tombstone as the durable record of that child. Age is
// therefore the owner's call, and `retention.childTranscriptDays = 0` ships the
// answer "no".
//
// When it is switched on, three judgements must all pass before a transcript goes:
// the ledger has no live edge for that child, no resident or leased session holds
// it, and every file in the transcript's directory is older than the window (a
// writer that is mid-flush keeps its file).
import { join, resolve } from "node:path";
import { reclaimWithinBudget } from "./delete.js";
import { aggregateTree, listDirectory, quietLstat } from "./fs-walk.js";
import {
	type RetentionClassContext,
	type RetentionClassModule,
	type RetentionClassResult,
	type RetentionSkip,
	SKIP,
} from "./types.js";

const SUB_SESSION_DIR_PREFIX = "sub-";
const MAX_WALK_DEPTH = 8;

/** Every `sub-*` session directory under the artifact tree, bounded. */
function findChildSessionDirs(artifactRoot: string): string[] {
	const found: string[] = [];
	const queue: { path: string; depth: number }[] = [{ path: artifactRoot, depth: 0 }];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const entries = listDirectory(current.path);
		if (!entries) continue;
		for (const entry of entries) {
			if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
			const child = join(current.path, entry.name);
			if (entry.name.startsWith(SUB_SESSION_DIR_PREFIX)) {
				found.push(child);
				continue;
			}
			if (current.depth >= MAX_WALK_DEPTH) continue;
			queue.push({ path: child, depth: current.depth + 1 });
		}
	}
	return found.sort();
}

export const childTranscriptsModule: RetentionClassModule = {
	id: "child-transcripts",
	async scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
		const days = context.settings.childTranscriptDays;
		const dirs = findChildSessionDirs(resolve(context.roots.artifactRoot));
		if (days <= 0) {
			return {
				class: "child-transcripts",
				scanned: 0,
				reclaimed: 0,
				bytes: 0,
				skipped: [],
				capped: false,
				disabled: true,
			};
		}
		const skipped: RetentionSkip[] = [];
		const requests = [];
		let scanned = 0;
		for (const dir of dirs) {
			const entries = listDirectory(dir);
			if (!entries) {
				skipped.push({ path: dir, reason: SKIP.unverifiable("readdir") });
				continue;
			}
			const tree = aggregateTree(dir, { maxDepth: 2 });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
				const path = join(dir, entry.name);
				scanned += 1;
				const sessionId = entry.name.replace(/\.jsonl$/, "");
				if (context.live.ledgerLiveChildIds?.has(sessionId)) {
					skipped.push({ path, reason: SKIP.reference("ledger-live") });
					continue;
				}
				if (context.live.residentSessionIds?.has(sessionId) || context.live.leasedSessionIds?.has(sessionId)) {
					skipped.push({ path, reason: SKIP.inUse("resident") });
					continue;
				}
				const stats = quietLstat(path);
				if (!stats) {
					skipped.push({ path, reason: SKIP.unverifiable("gone") });
					continue;
				}
				// A sibling writer in the same directory (a child flush) keeps the file.
				if (tree.unreadable) {
					skipped.push({ path, reason: SKIP.unverifiable("tree") });
					continue;
				}
				const ageMs = context.now - Math.max(stats.mtimeMs, tree.newestMtimeMs);
				if (ageMs < days * 24 * 60 * 60 * 1000) {
					skipped.push({ path, reason: SKIP.young(`${days}d`) });
					continue;
				}
				requests.push({
					path,
					kind: "file" as const,
					bytes: stats.size,
					entries: 1,
					signature: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`,
				});
			}
		}
		const outcome = await reclaimWithinBudget(context, requests);
		return {
			class: "child-transcripts",
			scanned,
			reclaimed: outcome.reclaimed,
			bytes: outcome.bytes,
			skipped: [...skipped, ...outcome.skipped],
			capped: outcome.capped,
			disabled: false,
		};
	},
};
