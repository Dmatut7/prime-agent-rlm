// Opportunistic compaction of over-bound RLM spawn ledgers (r41 ADC-2, PR-C2).
//
// The writer compacts before it refuses an append, but a ledger can already be
// over its bounds when this binary first sees it: an older writer grew it past
// the bound and failed closed, or the compaction switch was off. Every reader
// (daemon family listing, the retention ledger scan, spawn admission) refuses
// such a file, so the sweep is the belt-and-braces rung that restores it
// without an operator.
//
// This class rewrites a file rather than deleting entries, so it spends no
// deletion budget and never touches a path outside the ledger directory. The
// reduction it invokes is the same one the writer uses
// (`core/rlm-ledger-compaction.ts`), guarded by the same lock.
import { statSync } from "node:fs";
import { join } from "node:path";
import {
	compactRlmLedgerFile,
	listRlmLedgerFiles,
	projectRlmLedgerFile,
	rlmLedgerFileOverBound,
} from "../rlm-ledger-compaction.js";
import type { RetentionClassModule, RetentionClassResult, RetentionSkip } from "./types.js";
import { SKIP } from "./types.js";

export const RLM_LEDGER_DIR_NAME = "rlm-ledger";

export function rlmLedgerDirectory(agentDir: string): string {
	return join(agentDir, RLM_LEDGER_DIR_NAME);
}

/** Byte size of one ledger file, 0 when it cannot be statted. */
export function rlmLedgerFileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

export const rlmLedgerCompactionModule: RetentionClassModule = {
	id: "rlm-ledger-compaction",
	async scanAndReclaim(context): Promise<RetentionClassResult> {
		const skipped: RetentionSkip[] = [];
		if (!context.settings.ledgerCompactionEnabled) {
			// Rollback lever: off restores the historical fail-closed state, where
			// an over-bound ledger stays unreadable until an operator intervenes.
			return {
				class: "rlm-ledger-compaction",
				scanned: 0,
				reclaimed: 0,
				bytes: 0,
				skipped: [],
				capped: false,
				disabled: true,
			};
		}
		const files = listRlmLedgerFiles(context.roots.agentDir, RLM_LEDGER_DIR_NAME);
		let overBound = 0;
		let reclaimed = 0;
		let bytes = 0;
		for (const path of files) {
			if (!rlmLedgerFileOverBound(path)) continue;
			overBound += 1;
			if (context.dryRun) {
				// A dry run predicts; rewriting the authoritative topology file is a
				// mutation, so it is reported and left alone.
				skipped.push({ path, reason: SKIP.reference("dry-run"), detail: "over bound" });
				continue;
			}
			const before = projectRlmLedgerFile(path);
			try {
				const outcome = compactRlmLedgerFile(path, {
					sessionsDir: context.roots.sessionsDir,
					log: context.log,
				});
				if (!outcome.published) {
					skipped.push({
						path,
						reason: outcome.aborted === "over-bound" ? SKIP.failed("ledger-over-bound") : SKIP.inUse("pid"),
						detail: `${outcome.liveEdges} live edge(s), ${outcome.afterRecords} record(s) after reduction`,
					});
					continue;
				}
				reclaimed += outcome.droppedRecords;
				bytes += Math.max(0, before.bytes - outcome.afterBytes);
				context.log(
					`rlm-ledger-compaction: ${path} ${before.bytes} -> ${outcome.afterBytes} bytes, dropped ${outcome.droppedRecords} record(s)`,
				);
			} catch (error) {
				skipped.push({
					path,
					reason: SKIP.failed("ledger-compaction"),
					detail: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (overBound > 0) {
			// Report-visible: "the ledger was over bound" is the fact an operator
			// needs when a family listing had degraded to flat before this sweep ran.
			context.log(`rlm-ledger-compaction: ${overBound} over-bound ledger file(s) of ${files.length}`);
		}
		return {
			class: "rlm-ledger-compaction",
			scanned: files.length,
			reclaimed,
			bytes,
			skipped,
			capped: false,
			disabled: false,
		};
	},
};
