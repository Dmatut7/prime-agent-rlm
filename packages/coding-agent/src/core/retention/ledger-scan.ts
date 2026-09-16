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
// transcript existence alone (the conservative branch). An OVER-BOUND ledger is
// unreadable by definition: the writer (`modes/daemon/rlm-ledger.ts`) refuses to
// replay past the same two numbers, so this scan refuses them too instead of
// reporting a topology the daemon itself could not read back (r41 ADC-2 reader
// alignment). Records of an unknown version are skipped rather than consumed: a
// v:2 delete this reader cannot validate is not positive evidence of a deletion
// (the daemon's parseLedgerLine fails loudly on it; a sweep must keep running,
// so the conservative form here is "ignore the line", never "trust it").
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { RLM_LEDGER_MAX_BYTES, RLM_LEDGER_MAX_RECORDS } from "../rlm-ledger-bounds.js";

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

/**
 * The conservative bail-out: one over-bound file makes the whole directory
 * unknown, so every caller keeps its candidates (`ledgerScanned: false`).
 */
function overBound(scan: RlmLedgerChildScan): RlmLedgerChildScan {
	scan.scanned = false;
	scan.liveChildIds.clear();
	scan.deletedChildIds.clear();
	return scan;
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
		const path = join(ledgerDir, name);
		let raw: string;
		try {
			// The byte bound is checked on the stat, before any allocation: an
			// over-bound file must not be read into memory just to be refused.
			if (statSync(path).size > RLM_LEDGER_MAX_BYTES) return overBound(scan);
			raw = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		readAny = true;
		scan.files += 1;
		let records = 0;
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			if (++records > RLM_LEDGER_MAX_RECORDS) return overBound(scan);
			let record: { v?: unknown; op?: unknown; childId?: unknown; child?: unknown };
			try {
				record = JSON.parse(line) as { v?: unknown; op?: unknown; childId?: unknown; child?: unknown };
			} catch {
				continue;
			}
			// Version gate: only v:1 records are understood (see the header).
			if (record.v !== 1) continue;
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
