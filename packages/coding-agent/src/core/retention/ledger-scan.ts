// Read-only scan of the daemon RLM ledger directory.
//
// The ledger is the authoritative child topology (`rlm-ledger` design note: a
// fork can leave the transcript header pointing at a dead ancestor path), and it
// is written before a child's file disappears. The sweep uses it as one more
// reference root, in both directions:
//   * a live edge protects a child's artifacts (the child may come back),
//   * a delete record is positive evidence that the child is gone, which is the
//     same-source signal the transcript-existence test cannot give (round-08 D-2).
//
// An unreadable ledger yields `scanned: false`, and the callers then judge with
// transcript existence alone (the conservative branch).
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface RlmLedgerChildScan {
	scanned: boolean;
	/** Child session ids (`<uuid>` from the transcript path) with a live edge. */
	liveChildIds: Set<string>;
	/** Child session ids the ledger recorded as deleted. */
	deletedChildIds: Set<string>;
	/** Ledger files read. */
	files: number;
}

/** Session id of the transcript a ledger edge points at. */
function childSessionId(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.endsWith(".jsonl")) return undefined;
	const id = basename(value).replace(/\.jsonl$/, "");
	return id.length > 0 ? id : undefined;
}

export function scanRlmLedgerDirectory(ledgerDir: string): RlmLedgerChildScan {
	const scan: RlmLedgerChildScan = { scanned: false, liveChildIds: new Set(), deletedChildIds: new Set(), files: 0 };
	let names: string[];
	try {
		names = readdirSync(ledgerDir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return scan;
	}
	const deleted = new Set<string>();
	const live = new Map<string, boolean>();
	let readAny = false;
	for (const name of names.sort()) {
		let raw: string;
		try {
			raw = readFileSync(join(ledgerDir, name), "utf8");
		} catch {
			continue;
		}
		readAny = true;
		scan.files += 1;
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let record: { op?: unknown; childId?: unknown; child?: unknown };
			try {
				record = JSON.parse(line) as { op?: unknown; childId?: unknown; child?: unknown };
			} catch {
				continue;
			}
			const id = childSessionId(record.child);
			if (!id) continue;
			if (record.op === "delete") {
				deleted.add(id);
				live.delete(id);
				continue;
			}
			if (record.op === "spawn") {
				live.set(id, true);
			}
		}
	}
	scan.scanned = readAny;
	for (const id of live.keys()) {
		if (!deleted.has(id)) scan.liveChildIds.add(id);
	}
	for (const id of deleted) scan.deletedChildIds.add(id);
	return scan;
}
