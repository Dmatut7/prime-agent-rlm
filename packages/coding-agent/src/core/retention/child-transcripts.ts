// Child transcripts: `sub-xxxxxxxx/<uuid>.jsonl` under an artifact root.
//
// Reclaims a deleted child's transcript after the age window (default 30 days,
// r38 LIFE-2): a deleted RLM child's durable record is the display tombstone plus
// the ledger delete record, not the transcript bytes, so once the window passes
// the bytes are residue. The round-09 ruling 1 concern - "the bytes ride live
// sub-agent references" - is enforced rather than assumed: three judgements must
// all pass before a transcript goes, the ledger scan positively reports no live
// edge for that child (an unreadable ledger proves nothing and keeps everything),
// no resident or leased session holds it, and every file in the transcript's
// directory is older than the window (a writer that is mid-flush keeps its file).
import type { Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { reclaimWithinBudget } from "./delete.js";
import {
	aggregateTree,
	listDirectory,
	quietLstat,
	RETENTION_WALK_YIELD_EVERY,
	type TreeAggregate,
	yieldToEventLoop,
} from "./fs-walk.js";
import {
	type RetentionClassContext,
	type RetentionClassModule,
	type RetentionClassResult,
	type RetentionSkip,
	SKIP,
} from "./types.js";

const SUB_SESSION_DIR_PREFIX = "sub-";
const MAX_WALK_DEPTH = 8;
/**
 * How deep the sibling tree of one transcript is aggregated. Both call sites of
 * the age judgement below pass this same bound, so "how old is this transcript"
 * cannot answer two different ways depending on who asked.
 */
const CHILD_TRANSCRIPT_TREE_MAX_DEPTH = 2;

/** Every `sub-*` session directory under the artifact tree, bounded. */
async function findChildSessionDirs(artifactRoot: string): Promise<string[]> {
	const found: string[] = [];
	const queue: { path: string; depth: number }[] = [{ path: artifactRoot, depth: 0 }];
	let sinceYield = 0;
	while (queue.length > 0) {
		const current = queue.shift()!;
		// Slice the walk (perfB②): the sweep is a timer tick on the daemon's event
		// loop, so a large artifact tree must not be one synchronous block.
		if (++sinceYield >= RETENTION_WALK_YIELD_EVERY) {
			sinceYield = 0;
			await yieldToEventLoop();
		}
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

/** The one judgement of a child transcript's age window. */
export type ChildTranscriptAgeVerdict =
	| { status: "unverifiable"; code: "gone" | "tree" }
	| { status: "young"; ageMs: number; stats: Stats }
	| { status: "expired"; ageMs: number; stats: Stats };

/**
 * The single authority for "may this `<sub-*>/<child>.jsonl` transcript go?".
 *
 * Two callers ask the same question: this class, which reclaims the transcript
 * itself, and `artifact-dirs`'s descendant blocker, which has to decide whether a
 * directory holding the transcript may be removed as a whole. The window is the
 * same in both - `childTranscriptDays` - and so is the age: measured from the
 * newer of the transcript's own `mtime` and the newest write anywhere in the
 * directory that holds it, because a sibling writer mid-flush keeps its file.
 *
 * `unverifiable` is the conservative answer: a transcript that cannot be stat'ed
 * (`gone`) or a sibling tree that could not be walked (`tree`) proves nothing
 * about age, and both callers keep what they were about to remove.
 */
export function judgeChildTranscriptAge(options: {
	transcriptPath: string;
	now: number;
	days: number;
	/** Pre-aggregated sibling directory; a caller that already walked it passes it. */
	tree?: TreeAggregate;
}): ChildTranscriptAgeVerdict {
	const tree =
		options.tree ?? aggregateTree(dirname(options.transcriptPath), { maxDepth: CHILD_TRANSCRIPT_TREE_MAX_DEPTH });
	const stats = quietLstat(options.transcriptPath);
	if (!stats) return { status: "unverifiable", code: "gone" };
	if (tree.unreadable) return { status: "unverifiable", code: "tree" };
	const ageMs = options.now - Math.max(stats.mtimeMs, tree.newestMtimeMs);
	if (ageMs < options.days * 24 * 60 * 60 * 1000) return { status: "young", ageMs, stats };
	return { status: "expired", ageMs, stats };
}

export const childTranscriptsModule: RetentionClassModule = {
	id: "child-transcripts",
	async scanAndReclaim(context: RetentionClassContext): Promise<RetentionClassResult> {
		const days = context.settings.childTranscriptDays;
		const dirs = await findChildSessionDirs(resolve(context.roots.artifactRoot));
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
			const tree = aggregateTree(dir, { maxDepth: CHILD_TRANSCRIPT_TREE_MAX_DEPTH });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
				const path = join(dir, entry.name);
				scanned += 1;
				const sessionId = entry.name.replace(/\.jsonl$/, "");
				// The ledger is the only positive record of a passive child's liveness.
				// A scan that failed proves nothing about live edges, and with a window
				// shipped by default "unknown" must not read as "no live edge", or an
				// unreadable ledger would age out live children's transcripts.
				if (context.live.ledgerScanned !== true) {
					skipped.push({ path, reason: SKIP.unverifiable("ledger-scan") });
					continue;
				}
				if (context.live.ledgerLiveChildIds?.has(sessionId)) {
					skipped.push({ path, reason: SKIP.reference("ledger-live") });
					continue;
				}
				if (context.live.residentSessionIds?.has(sessionId) || context.live.leasedSessionIds?.has(sessionId)) {
					skipped.push({ path, reason: SKIP.inUse("resident") });
					continue;
				}
				// The age window has one authority (see `judgeChildTranscriptAge`), shared
				// with the directory blocker in `artifact-dirs`; a sibling writer in the
				// same directory (a child flush) keeps the file.
				const verdict = judgeChildTranscriptAge({ transcriptPath: path, now: context.now, days, tree });
				if (verdict.status === "unverifiable") {
					skipped.push({ path, reason: SKIP.unverifiable(verdict.code) });
					continue;
				}
				if (verdict.status === "young") {
					skipped.push({ path, reason: SKIP.young(`${days}d`) });
					continue;
				}
				const stats = verdict.stats;
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
